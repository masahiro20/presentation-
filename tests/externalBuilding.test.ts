/**
 * 外部の正確な建物（3DS）を間取りに合わせる計算（src/app/externalFit.ts）のテスト。Node 上で DOM 無しに動くこと。
 *  - 水平断面の外形（sectionOutline / outlineOfPivot）: 焼き込んだサンプル住宅で壁 9.1 × (7.28 + ポーチ 1.5) m、全高なら軒先 10.3 m
 *  - 間取りへの自動合わせ（fitExternalToPlan）: 0°・90°（幅と奥行きの入れ替え）・中心のずれ・鏡像（残差で検出）
 *  - 読み込み直後の配置（seedPlacement）: 'ground' の板を除いた worldBox。すべてが建物以外と判定されたら何も隠さない
 *  - 2 点合わせの符号（applyTwoPointToSite）: applyFit(r)(fromWorld_a(P)) == fromWorld_{a−r}(P)、角の地理位置が航空写真の点に一致
 *  - 片側に寄ったポーチ（主屋の東の壁と面一）でも主屋の回転が 0.5° 未満。単位違いの判定の帯（1/2・2 倍）。周長の比で ICP を省く
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { importModelFile, PlacedModel } from '../src/sunstudy/importModel';
import { DEFAULT_PLACEMENT, type ImportedModel } from '../src/sunstudy/types';
import { applyFit, convexHull, fitPolygonToPolygon, minAreaRect, normDeg180, polygonArea, solveTwoPoint, type EN } from '../src/sun/align';
import { allObjectsAutoHidden, applyTwoPointToSite, fitExternalToPlan, fromWorldEN, outlineOfPivot, planOutlineEN, planOutlinePolygon, sectionOutline, sectionPolygon, seedPlacement, simplifyPolygon, snapToOutlineVertex, suggestsMirror, suggestsUnitError, wallBand } from '../src/app/externalFit';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE = path.join(ROOT, 'public', 'samples', 'sample_house.3ds');

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** 矩形 + 東端に寄せた翼（L 字）。e: 幅 w、n: 奥行き d、翼は北側（+n）に幅 pw・奥行き pd、中心から pe ずらす（pe + pw/2 = w/2 で東の壁と面一） */
function houseL(w = 9.1, d = 7.28, pw = 4.0, pd = 3.0, pe = 2.55): EN[] {
  const hw = w / 2;
  const hd = d / 2;
  return [
    { e: -hw, n: -hd },
    { e: hw, n: -hd },
    { e: hw, n: hd },
    { e: pe + pw / 2, n: hd },
    { e: pe + pw / 2, n: hd + pd },
    { e: pe - pw / 2, n: hd + pd },
    { e: pe - pw / 2, n: hd },
    { e: -hw, n: hd },
  ];
}
const rotEN = (pts: EN[], rotDeg: number, te = 0, tn = 0) => pts.map((p) => applyFit({ rotDeg, te, tn, scale: 1, scaleRatio: 1, rmsM: 0 }, p));
const mirrorEN = (pts: EN[]) => pts.map((p) => ({ e: -p.e, n: p.n }));
/** EN（c 基準）→ PDF の外形（ワールド XZ: x = c.x + e, z = c.z − n） */
const toPlanOutline = (pts: EN[], c: { x: number; z: number }) => [{ level: 1, polys: [pts.map((p) => new THREE.Vector2(c.x + p.e, c.z - p.n))] }];

// ---------------------------------------------------------------------------

describe('水平断面の外形（sectionOutline）', () => {
  it('壁の箱（高さ帯に頂点が無い）でも、辺を切った交点から足跡が取れる', () => {
    // 1 × 1 × 6 の箱を 12 三角形で（頂点は y = 0 と y = 6 だけ）
    const v = (x: number, y: number, z: number) => [x, y, z];
    const tri = (a: number[], b: number[], c: number[]) => [...a, ...b, ...c];
    const B = [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)];
    const T = B.map(([x, , z]) => v(x, 6, z));
    const pos: number[] = [];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      pos.push(...tri(B[i], B[j], T[j]), ...tri(B[i], T[j], T[i]));
    }
    pos.push(...tri(B[0], B[1], B[2]), ...tri(B[0], B[2], B[3]), ...tri(T[0], T[2], T[1]), ...tri(T[0], T[3], T[2]));
    const hull = sectionOutline(pos, { yMin: 0.3, yMax: 2.0 });
    const r = minAreaRect(hull)!;
    expect(hull.length).toBe(4);
    expect(r.w).toBeCloseTo(1, 6);
    expect(r.d).toBeCloseTo(1, 6);
  });

  it('帯の中に何も無いときは全頂点の凸包にフォールバックする', () => {
    const pos = [0, 10, 0, 2, 10, 0, 2, 10, 2, 0, 10, 0, 2, 10, 2, 0, 10, 2];
    const hull = sectionOutline(pos, { yMin: 0.3, yMax: 2.0 });
    expect(hull.length).toBe(4);
    expect(minAreaRect(hull)!.w).toBeCloseTo(2, 9);
  });

  it('sectionPolygon: 2 つの箱（主屋 + ポーチ）の断面は凹みのある 6 角形。角は正確、面積は和', () => {
    const pos: number[] = [];
    const boxTris = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number) => {
      const v = (x: number, y: number, z: number) => [x, y, z];
      const B = [v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)];
      const T = B.map(([x, , z]) => v(x, y1, z));
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        pos.push(...B[i], ...B[j], ...T[j], ...B[i], ...T[j], ...T[i]);
      }
      pos.push(...B[0], ...B[1], ...B[2], ...B[0], ...B[2], ...B[3], ...T[0], ...T[2], ...T[1], ...T[0], ...T[3], ...T[2]);
    };
    // 主屋 9.1 × 7.28（z は −n）、ポーチ 2.0 × 1.5 を北側（−z）中央に
    boxTris(-4.55, 4.55, -3.64, 3.64, 0, 6);
    boxTris(-1.0, 1.0, -3.64 - 1.5, -3.64, 0, 2.4);
    const poly = sectionPolygon(pos, { yMin: 0.3, yMax: 2.0 });
    expect(poly.length).toBe(8);
    expect(Math.abs(polygonArea(poly) - (9.1 * 7.28 + 2.0 * 1.5))).toBeLessThan(0.05);
    const r = minAreaRect(poly)!;
    expect(Math.abs(r.w - 9.1)).toBeLessThan(0.01);
    expect(Math.abs(r.d - (7.28 + 1.5))).toBeLessThan(0.01);
    // 凸包だと斜めの辺で面積が増える
    expect(Math.abs(polygonArea(sectionOutline(pos, { yMin: 0.3, yMax: 2.0 })))).toBeGreaterThan(9.1 * 7.28 + 2.0 * 1.5 + 3);
  });

  it('simplifyPolygon: 直線上の点を省く', () => {
    const sq: EN[] = [
      { e: 0, n: 0 },
      { e: 0.5, n: 0.001 },
      { e: 1, n: 0 },
      { e: 1, n: 1 },
      { e: 0, n: 1 },
    ];
    expect(simplifyPolygon(sq, 0.01).length).toBe(4);
  });

  it('wallBand: 底 + 0.3 〜 min(2.0, 0.6×高さ)', () => {
    expect(wallBand(8.2)).toEqual({ yMin: 0.3, yMax: 2.0 });
    expect(wallBand(2.5)).toEqual({ yMin: 0.3, yMax: 1.5 });
    expect(wallBand(0.4).yMax).toBe(Infinity);
  });
});

describe('サンプル住宅（焼き込んだ 3DS）の外形', () => {
  let model: ImportedModel;
  let placed: PlacedModel;
  beforeAll(async () => {
    model = await importModelFile({ name: 'sample_house.3ds', data: toArrayBuffer(readFileSync(SAMPLE)) });
    placed = new PlacedModel(model, seedPlacement(model));
  });

  it('壁の高さ帯: 幅 9.1 m（窓の箱は 1 cm 出る）、奥行き 7.28 + ポーチ 1.5 m。軒先（10.3 m）は含まない。凹みのある外周', () => {
    const poly = outlineOfPivot(placed.pivot);
    const r = minAreaRect(poly)!;
    expect(Math.abs(r.w - 9.1)).toBeLessThan(0.05);
    expect(Math.abs(r.d - (7.28 + 1.5))).toBeLessThan(0.05);
    // 外周は主屋 + ポーチ（+ 窓の箱の出っ張り 1 cm）の面積
    expect(Math.abs(polygonArea(poly) - (9.1 * 7.28 + 2.0 * 1.5))).toBeLessThan(0.3);
  });

  it('サンプル住宅の壁の外周 → PDF の矩形 9.1 × 7.28（ポーチ無し）: 主屋がぴったり乗り、ポーチは北へはみ出す', () => {
    const poly = outlineOfPivot(placed.pivot);
    const c = { x: 4.55, z: 3.64 };
    const rect = [new THREE.Vector2(0, 0), new THREE.Vector2(9.1, 0), new THREE.Vector2(9.1, 7.28), new THREE.Vector2(0, 7.28)];
    const dst = planOutlinePolygon([{ level: 1, polys: [rect] }], c);
    const f = fitExternalToPlan(poly, dst, 0);
    // PlacedModel は rawBox（主屋 + ポーチ）の中心を原点にするので、主屋の中心は南へ 0.745 m（ポーチ 1.5/2 − 窓 0.01/2）ずれている。
    // 主屋を PDF の矩形に乗せるには 3DS を北（図面の上 = dz 負）へその分動かす
    expect(Math.abs(f.planRotDeg)).toBeLessThan(0.3);
    expect(Math.abs(f.dx)).toBeLessThan(0.05);
    expect(Math.abs(f.dz + 0.745)).toBeLessThan(0.05);
    expect(suggestsUnitError(f)).toBe(false);
    expect(suggestsMirror(f.score, f.mirrorScore)).toBe(false);
    // 凸包どうしの ICP（旧）だと中間で妥協して 0.3 m 以上ずれる
    const hullOnly = fitPolygonToPolygon(convexHull(poly), convexHull(dst), { allowScale: false, initialRotDeg: [0] });
    expect(Math.abs(hullOnly.tn - 0.745)).toBeGreaterThan(0.1);
  });

  it('全高: 軒先を含む 10.3 m', () => {
    const hull = outlineOfPivot(placed.pivot, { yMin: -Infinity, yMax: Infinity });
    const r = minAreaRect(hull)!;
    expect(Math.abs(r.w - 10.3)).toBeLessThan(0.05);
    expect(Math.abs(r.d - (7.28 + 1.5))).toBeLessThan(0.05);
  });

  it('軒先の高さの断面は屋根の外形（10.3 m）、窓の高さの断面は壁（9.1 m）', () => {
    const eave = outlineOfPivot(placed.pivot, { yMin: 6.0 - 0.3, yMax: 6.0 + 0.3 });
    expect(Math.abs(minAreaRect(eave)!.w - 10.3)).toBeLessThan(0.05);
    const win = outlineOfPivot(placed.pivot, { yMin: 1.5 - 0.3, yMax: 1.5 + 0.3 });
    expect(Math.abs(minAreaRect(win)!.w - 9.1)).toBeLessThan(0.05);
  });
});

describe('間取りへの自動合わせ（fitExternalToPlan）', () => {
  const src = houseL();
  const c = { x: 4.55, z: 3.64 };

  it('同じ形・同じ向き → 回転 0、ずれ 0、残差 ≈ 0。寸法は 9.1 × 10.28（翼込み）', () => {
    const dst = planOutlineEN(toPlanOutline(houseL(), c), c);
    const f = fitExternalToPlan(src, dst, 0);
    expect(Math.abs(normDeg180(f.planRotDeg))).toBeLessThan(0.5);
    expect(Math.abs(f.dx)).toBeLessThan(0.02);
    expect(Math.abs(f.dz)).toBeLessThan(0.02);
    expect(f.score).toBeLessThan(0.02);
    expect(f.swapped).toBe(false);
    expect(f.mismatchM).toBeLessThan(0.02);
    expect(f.pdfW).toBeCloseTo(9.1, 6);
    expect(f.pdfD).toBeCloseTo(7.28 + 3.0, 6);
  });

  it('PDF 側が 90° 回っている → 回転 ±90、幅と奥行きの入れ替え（swapped）', () => {
    const dst = planOutlineEN(toPlanOutline(rotEN(houseL(), 90), c), c);
    const f = fitExternalToPlan(src, dst, 0);
    expect(Math.abs(Math.abs(normDeg180(f.planRotDeg)) - 90)).toBeLessThan(0.5);
    expect(f.swapped).toBe(true);
    expect(f.score).toBeLessThan(0.02);
    expect(f.mismatchM).toBeLessThan(0.02);
    // 3DS の寸法は PDF の向きで報告する（PDF と一致）
    expect(Math.abs(f.extW - f.pdfW)).toBeLessThan(0.02);
    expect(Math.abs(f.extD - f.pdfD)).toBeLessThan(0.02);
  });

  it('中心がずれている → dx / dz（PLAN: 右 +, 下 +）に出る', () => {
    // PDF 側を東へ 1.2 m・北へ 0.8 m（= 図面の上へ）ずらす
    const dst = planOutlineEN(toPlanOutline(rotEN(houseL(), 0, 1.2, 0.8), c), c);
    const f = fitExternalToPlan(src, dst, 0);
    expect(Math.abs(f.planRotDeg)).toBeLessThan(0.5);
    expect(f.dx).toBeCloseTo(1.2, 2);
    expect(f.dz).toBeCloseTo(-0.8, 2);
  });

  it('回転 + ずれを同時に。37° は「幅と奥行きの入れ替え」ではない', () => {
    const dst = planOutlineEN(toPlanOutline(rotEN(houseL(), 37, -2, 1.5), c), c);
    const f = fitExternalToPlan(src, dst, 0);
    expect(Math.abs(normDeg180(f.planRotDeg - 37))).toBeLessThan(0.5);
    expect(f.dx).toBeCloseTo(-2, 1);
    expect(f.dz).toBeCloseTo(-1.5, 1);
    expect(f.score).toBeLessThan(0.05);
    expect(f.swapped).toBe(false);
  });

  it('swapped は 3DS を 90° 回したときだけ: 頂点の順（最小外接矩形の w/d の付き方）が違っても、同じ向きなら false で寸法は PDF の向き', () => {
    const dst = planOutlineEN(toPlanOutline(houseL(), c), c);
    for (const start of [0, 1, 2, 3, 5]) {
      const rolled = [...src.slice(start), ...src.slice(0, start)];
      const f = fitExternalToPlan(rolled, dst, 0);
      expect(Math.abs(f.planRotDeg)).toBeLessThan(0.5);
      expect(f.swapped).toBe(false);
      expect(f.extW).toBeCloseTo(9.1, 3);
      expect(f.extD).toBeCloseTo(7.28 + 3.0, 3);
    }
    // 90° 回した PDF は swapped、寸法はやはり PDF の向きで一致
    const f90 = fitExternalToPlan(src, planOutlineEN(toPlanOutline(rotEN(houseL(), -90), c), c), 0);
    expect(f90.swapped).toBe(true);
    expect(f90.extW).toBeCloseTo(f90.pdfW, 3);
    expect(f90.extD).toBeCloseTo(f90.pdfD, 3);
  });

  it('鏡像の 3DS → 外形の残差が大きい（> 0.3 m）が、反転すると ≈ 0 になるので検出できる。正しい向きは ≈ 0 で反転の提案は出ない', () => {
    const dst = planOutlineEN(toPlanOutline(houseL(), c), c);
    const good = fitExternalToPlan(src, dst, 0);
    const bad = fitExternalToPlan(mirrorEN(src), dst, 0);
    expect(good.score).toBeLessThan(0.02);
    expect(good.mirrorScore).toBeGreaterThan(0.3);
    expect(suggestsMirror(good.score, good.mirrorScore)).toBe(false);
    expect(bad.score).toBeGreaterThan(0.3);
    expect(bad.mirrorScore).toBeLessThan(0.02);
    expect(suggestsMirror(bad.score, bad.mirrorScore)).toBe(true);
  });

  it('PDF に無いポーチ（左右対称）がある 3DS → 主屋の壁が PDF の矩形に乗る（外れ値を除く仕上げ）。鏡像・単位の提案は出ない', () => {
    // サンプル住宅の壁の外形: 9.1 × 7.28 の矩形 + 北側中央にポーチ 2.0 × 1.5
    const house = houseL(9.1, 7.28, 2.0, 1.5, 0);
    const rect: EN[] = [
      { e: -4.55, n: -3.64 },
      { e: 4.55, n: -3.64 },
      { e: 4.55, n: 3.64 },
      { e: -4.55, n: 3.64 },
    ];
    const dst = planOutlineEN(toPlanOutline(rect, c), c);
    const f = fitExternalToPlan(house, dst, 0);
    expect(Math.abs(f.planRotDeg)).toBeLessThan(0.5);
    expect(Math.abs(f.dx)).toBeLessThan(0.05);
    expect(Math.abs(f.dz)).toBeLessThan(0.05);
    // 寸法差はポーチの分（1.5 m）だが単位違いとは判定しない。残差は出っ張りの分だけ残る
    expect(f.mismatchM).toBeCloseTo(1.5, 1);
    expect(suggestsUnitError(f)).toBe(false);
    expect(suggestsMirror(f.score, f.mirrorScore)).toBe(false);
  });

  it('180° 対称な矩形は同点: 今の回転（preferRotDeg）に近い候補を選ぶ', () => {
    const rect: EN[] = [
      { e: -4.55, n: -3.64 },
      { e: 4.55, n: -3.64 },
      { e: 4.55, n: 3.64 },
      { e: -4.55, n: 3.64 },
    ];
    const dst = planOutlineEN(toPlanOutline(rect, c), c);
    expect(Math.abs(fitExternalToPlan(rect, dst, 0).planRotDeg)).toBeLessThan(0.5);
    expect(Math.abs(normDeg180(fitExternalToPlan(rect, dst, 175).planRotDeg - 180))).toBeLessThan(0.5);
    expect(Math.abs(normDeg180(fitExternalToPlan(rect, dst, -170).planRotDeg - 180))).toBeLessThan(0.5);
  });

  it('単位違い（mm のまま = 1000 倍）→ 寸法差 mismatchM が大きい', () => {
    const dst = planOutlineEN(toPlanOutline(houseL(), c), c);
    const f = fitExternalToPlan(
      src.map((p) => ({ e: p.e * 2, n: p.n * 2 })),
      dst,
      0,
    );
    expect(f.mismatchM).toBeGreaterThan(0.6);
    expect(f.extW).toBeCloseTo(18.2, 6);
    expect(suggestsUnitError(f)).toBe(true);
  });

  it('planOutlineEN: 1 階が無ければ最下階、e = x − c.x, n = −(z − c.z)', () => {
    const pts = planOutlineEN([{ level: 2, polys: [[new THREE.Vector2(10, 20)]] }, { level: 3, polys: [[new THREE.Vector2(0, 0)]] }], { x: 4, z: 5 });
    expect(pts).toEqual([{ e: 6, n: -15 }]);
    expect(planOutlineEN([], { x: 0, z: 0 })).toEqual([]);
  });

  it('snapToOutlineVertex: 半径内の最も近い頂点、無ければ null', () => {
    const hull = houseL();
    expect(snapToOutlineVertex({ e: 4.4, n: -3.5 }, hull, 0.6)).toEqual({ e: 4.55, n: -3.64 });
    expect(snapToOutlineVertex({ e: 0, n: 0 }, hull, 0.6)).toBeNull();
  });
});

describe('読み込み直後の配置（seedPlacement）', () => {
  /** Z-up・m 単位の OBJ: 9 × 7 × 6 の家と、名前 ground の 40 × 40 の板（底に敷く） */
  function objWithGround(): ArrayBuffer {
    const lines: string[] = [];
    let base = 0;
    const box = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
      lines.push(`o ${name}`);
      const vs = [
        [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
        [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
      ];
      for (const v of vs) lines.push(`v ${v.join(' ')}`);
      const q = (a: number, b: number, c: number, d: number) => lines.push(`f ${base + a} ${base + b} ${base + c} ${base + d}`);
      q(1, 4, 3, 2);
      q(5, 6, 7, 8);
      q(1, 2, 6, 5);
      q(3, 4, 8, 7);
      q(4, 1, 5, 8);
      q(2, 3, 7, 6);
      base += 8;
    };
    box('house', -4.5, 4.5, -3.5, 3.5, 0, 6);
    box('ground', -20, 20, -20, 20, -0.05, 0);
    return new TextEncoder().encode(lines.join('\n') + '\n').buffer as ArrayBuffer;
  }

  it("'ground' の板は非表示に種付けされ、worldBox は家だけ（9 × 7 × 6 m）", async () => {
    const m = await importModelFile({ name: 'house.obj', data: objWithGround() });
    expect(m.guessedUnit).toBe('m');
    expect(m.objects.find((o) => o.name === 'ground')?.autoHidden).toBe(true);
    const pl = seedPlacement(m);
    expect(pl.hiddenObjects).toEqual(['ground']);
    expect(pl.unit).toBe('m');
    const placed = new PlacedModel(m, pl);
    const b = placed.worldBox();
    const s = b.getSize(new THREE.Vector3());
    expect(s.x).toBeCloseTo(9, 3);
    expect(s.z).toBeCloseTo(7, 3);
    expect(s.y).toBeCloseTo(6, 3);
    // 既定の配置（hiddenObjects: []）だと板が入って 40 m になる
    const naive = new PlacedModel(m, { ...DEFAULT_PLACEMENT, unit: 'm', upAxis: 'z' });
    expect(naive.worldBox().getSize(new THREE.Vector3()).x).toBeCloseTo(40, 3);
  });
});

// ---------------------------------------------------------------------------
// 片側に寄ったポーチ・単位違いの判定
// ---------------------------------------------------------------------------

describe('片側に寄ったポーチ（主屋の東の壁と面一）と単位違いの判定', () => {
  const c = { x: 4.55, z: 3.64 };
  const rect: EN[] = [
    { e: -4.55, n: -3.64 },
    { e: 4.55, n: -3.64 },
    { e: 4.55, n: 3.64 },
    { e: -4.55, n: 3.64 },
  ];
  const dst = planOutlineEN(toPlanOutline(rect, c), c);

  it('東の壁と面一のポーチ（2.0×1.5 〜 3.64×2.73）でも主屋の回転 < 0.5°、ずれ < 5 cm（割合固定の切り捨てだと 0.9〜3° 回っていた）', () => {
    for (const [pw, pd] of [
      [2.0, 1.5],
      [2.73, 1.82],
      [3.64, 1.82],
      [3.64, 2.73],
    ]) {
      for (const pe of [4.55 - pw / 2, -(4.55 - pw / 2)]) {
        const f = fitExternalToPlan(houseL(9.1, 7.28, pw, pd, pe), dst, 0);
        expect(Math.abs(f.planRotDeg), `pw ${pw} pd ${pd} pe ${pe}: rot ${f.planRotDeg}`).toBeLessThan(0.5);
        expect(Math.abs(f.dx), `pw ${pw} pd ${pd} pe ${pe}: dx ${f.dx}`).toBeLessThan(0.05);
        expect(Math.abs(f.dz), `pw ${pw} pd ${pd} pe ${pe}: dz ${f.dz}`).toBeLessThan(0.05);
        expect(f.unitSuspect).toBe(false);
        expect(suggestsUnitError(f)).toBe(false);
        expect(f.mismatchM).toBeCloseTo(pd, 1);
      }
    }
  });

  it('面一のポーチ + PDF 側の回転とずれ → 回転 37°・ずれも主屋で合う', () => {
    const d2 = planOutlineEN(toPlanOutline(rotEN(rect, 37, -2, 1.5), c), c);
    const f = fitExternalToPlan(houseL(9.1, 7.28, 3.64, 2.73, 4.55 - 1.82), d2, 0);
    expect(Math.abs(normDeg180(f.planRotDeg - 37))).toBeLessThan(0.5);
    expect(f.dx).toBeCloseTo(-2, 1);
    expect(f.dz).toBeCloseTo(-1.5, 1);
  });

  it('下屋が 2.0 m 深い（extD/pdfD = 1.27）だけでは単位違いと言わない。1000 倍なら言う（周長の比で ICP を省き、矩形で合わせる）', () => {
    const porch = houseL(9.1, 7.28, 2.0, 2.0, 0);
    const f = fitExternalToPlan(porch, dst, 0);
    expect(f.extD).toBeCloseTo(9.28, 6);
    expect(f.mismatchM).toBeCloseTo(2.0, 6);
    expect(f.unitSuspect).toBe(false);
    expect(suggestsUnitError(f)).toBe(false);
    const t0 = Date.now();
    const big = fitExternalToPlan(porch.map((p) => ({ e: p.e * 1000, n: p.n * 1000 })), dst, 0);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(big.unitSuspect).toBe(true);
    expect(suggestsUnitError(big)).toBe(true);
    expect(big.extW).toBeCloseTo(9100, 3);
    // 矩形どうしの姿勢: 軸は合っている
    expect(Math.abs(big.planRotDeg)).toBeLessThan(0.5);
    // mirrorScore も同じ経路（巨大な点数にならない）
    expect(Number.isFinite(big.mirrorScore)).toBe(true);
  });

  it('suggestsUnitError の帯: 片方の寸法が 1/2〜2 倍の中なら疑わない、外れたら疑う、両方 20% 以上違えば疑う（×2 の mm→cm 違い）', () => {
    const base = { pdfW: 9.1, pdfD: 7.28 };
    expect(suggestsUnitError({ ...base, extW: 9.1, extD: 9.28, mismatchM: 2.0 })).toBe(false); // 2.0 m の下屋
    expect(suggestsUnitError({ ...base, extW: 9.1, extD: 10.01, mismatchM: 2.73 })).toBe(false); // 2.73 m の下屋
    expect(suggestsUnitError({ ...base, extW: 9.1, extD: 7.28, mismatchM: 0 })).toBe(false);
    expect(suggestsUnitError({ ...base, extW: 9.1 * 3.28, extD: 7.28 * 3.28, mismatchM: 37 })).toBe(true); // ft のまま
    expect(suggestsUnitError({ ...base, extW: 9.1 / 10, extD: 7.28 / 10, mismatchM: 14.7 })).toBe(true); // cm → ×0.1
    expect(suggestsUnitError({ ...base, extW: 18.2, extD: 14.56, mismatchM: 16.4 })).toBe(true); // ×2（両方 20% 以上）
    expect(suggestsUnitError({ ...base, extW: 9.1, extD: 7.28 * 2.2, mismatchM: 8.7 })).toBe(true); // 片方だけでも 2 倍超
    expect(suggestsUnitError({ ...base, extW: 9.1, extD: 7.28, mismatchM: 0, unitSuspect: true })).toBe(true);
  });
});

describe('2 点合わせの符号（applyTwoPointToSite）', () => {
  const c = { x: 4.55, z: 3.64 };

  it('applyFit(r)(fromWorld_a(P)) == fromWorld_{a−r}(P)：方位は a − r に回す', () => {
    const P = { x: 12.3, z: -7.1 };
    for (const [a, r] of [
      [0, 10],
      [30, -25],
      [-120, 70],
      [170, 40],
    ]) {
      const p = fromWorldEN(P, c, a);
      const got = applyFit({ rotDeg: r, te: 0, tn: 0, scale: 1, scaleRatio: 1, rmsM: 0 }, p);
      const want = fromWorldEN(P, c, a - r);
      expect(Math.abs(got.e - want.e)).toBeLessThan(1e-9);
      expect(Math.abs(got.n - want.n)).toBeLessThan(1e-9);
    }
  });

  it('適用後、建物の角 P_i の地理位置（anchor + fromWorld）は、航空写真の点 Q_i の元の地理位置に一致する', () => {
    for (const [a, trueRot, te, tn] of [
      [20, 7, 3.2, -1.5],
      [-95, -33, -12, 8],
      [175, 12, 0.5, 0.2],
    ]) {
      const site = { offsetE: 5, offsetN: -3 };
      const P1 = { x: c.x - 4.55, z: c.z - 3.64 };
      const P2 = { x: c.x + 4.55, z: c.z + 3.64 };
      // 航空写真上の「本当の角」: 建物の角を地図上で trueRot 回し te/tn ずらした所
      const truth = { rotDeg: trueRot, te, tn, scale: 1, scaleRatio: 1, rmsM: 0 };
      const q1 = applyFit(truth, fromWorldEN(P1, c, a));
      const q2 = applyFit(truth, fromWorldEN(P2, c, a));
      const fit = solveTwoPoint([fromWorldEN(P1, c, a), fromWorldEN(P2, c, a)], [q1, q2], { allowScale: false });
      expect(Math.abs(normDeg180(fit.rotDeg - trueRot))).toBeLessThan(1e-9);
      const after = applyTwoPointToSite(site, a, fit);
      for (const [P, q] of [
        [P1, q1],
        [P2, q2],
      ] as const) {
        const geoAfter = fromWorldEN(P, c, after.northAngleDeg);
        const gE = after.offsetE + geoAfter.e;
        const gN = after.offsetN + geoAfter.n;
        expect(Math.abs(gE - (site.offsetE + q.e))).toBeLessThan(1e-9);
        expect(Math.abs(gN - (site.offsetN + q.n))).toBeLessThan(1e-9);
      }
      expect(after.northAngleDeg).toBeGreaterThan(-180);
      expect(after.northAngleDeg).toBeLessThanOrEqual(180);
    }
  });
});
