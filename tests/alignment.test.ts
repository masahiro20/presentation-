/**
 * 正確な位置合わせ（src/sunstudy/alignment.ts・PlacedModel の外形）のテスト。Node 上で DOM 無しに動く。
 * サンプル住宅の --site 変種（scripts/make-sample-3ds.mjs --site）を一時ディレクトリに生成して読み、
 *   外形（壁の高さ帯の断面 vs 全高さ）、敷地オブジェクトの外形（凹みも残す外周）、2 点合わせ、敷地の輪郭へのフィット
 *   （旗竿地・単位違い）、向き合わせ、ピンが動いたときの再計算（建物・測定点の追従）、形が変わった後のやり直し、
 *   位置合わせの記録とプロジェクトの往復（壊れた保存データ）
 * を確かめる。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mesh } from 'three';
import { applyFit, convexHull, dominantAngleDeg, fitPolygonToPolygon, minAreaRect, normDeg, normDeg180, polygonArea } from '../src/sun/align';
import type { RigidFit } from '../src/sun/align';
import {
  alignmentContextOk,
  alignmentLabel,
  describeAlignment,
  enToLocal,
  fitToSite,
  followPinMove,
  localToEN,
  orientToSite,
  pivotLatLonOf,
  plateOutline,
  reapplyAlignment,
  refitSiteAlignment,
  scaleSuspect,
  sectionOutline,
  solvePairs,
  twoPointPlacement,
} from '../src/sunstudy/alignment';
import { importModelFile, isSiteObjectName, PlacedModel, unitScale } from '../src/sunstudy/importModel';
import { applyProject, sanitizePlacement, serializeProject } from '../src/sunstudy/project';
import { study } from '../src/sunstudy/state';
import { DEFAULT_PLACEMENT, frameFromLocal, frameToLocal } from '../src/sunstudy/types';
import type { AlignmentPair, EN, GeoFrame, ImportedModel, MeasurePoint, ModelPlacement } from '../src/sunstudy/types';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'make-sample-3ds.mjs');
const SAMPLE = path.join(ROOT, 'public', 'samples', 'sample_house.3ds');

const FRAME: GeoFrame = { lat: 35.6, lon: 139.6, address: 'テスト', groundElev: 0 };

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** --site 変種を一時ディレクトリに生成して読む */
function generateSite(): ArrayBuffer {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sample-3ds-site-'));
  const out = path.join(dir, 'sample_site.3ds');
  execFileSync(process.execPath, [SCRIPT, '--site', '--out', out], { stdio: 'pipe' });
  return toArrayBuffer(readFileSync(out));
}

/** modelStep.applyImported と同じ: 自動で非表示と判定したオブジェクトを hiddenObjects に */
function placeLikeApp(model: ImportedModel, over: Partial<ModelPlacement> = {}): PlacedModel {
  return new PlacedModel(model, { ...DEFAULT_PLACEMENT, unit: model.guessedUnit, upAxis: model.guessedUp, hiddenObjects: model.objects.filter((o) => o.autoHidden).map((o) => o.name), ...over });
}

const extent = (pts: EN[]) => ({ w: Math.max(...pts.map((p) => p.e)) - Math.min(...pts.map((p) => p.e)), d: Math.max(...pts.map((p) => p.n)) - Math.min(...pts.map((p) => p.n)) });
const fitOf = (rotDeg: number, te: number, tn: number): RigidFit => ({ rotDeg, te, tn, scale: 1, scaleRatio: 1, rmsM: 0 });
const mod90 = (a: number) => ((a % 90) + 90) % 90;
/** 90° の周期での角度差の絶対値 */
const diff90 = (a: number, b: number) => {
  const d = mod90(a - b);
  return Math.min(d, 90 - d);
};
/** 軸に平行な箱の三角形（9 個ずつ）を positions 配列に足す。x, y(上), z */
function pushBox(out: number[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
  const v = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y0, z1],
    [x0, y0, z1],
    [x0, y1, z0],
    [x1, y1, z0],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const quads = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  for (const [a, b, c, d] of quads) for (const tri of [[a, b, c], [a, c, d]]) for (const i of tri) out.push(...v[i]);
}
/** 方位 angleDeg（上軸）、中心 c、幅 w・奥行 d の矩形（反時計回り） */
function rectAt(c: EN, angleDeg: number, w: number, d: number): EN[] {
  const up = { e: Math.sin(angleDeg * (Math.PI / 180)), n: Math.cos(angleDeg * (Math.PI / 180)) };
  const right = { e: up.n, n: -up.e };
  const at = (a: number, b: number): EN => ({ e: c.e + right.e * a + up.e * b, n: c.n + right.n * a + up.n * b });
  return [at(-w / 2, -d / 2), at(w / 2, -d / 2), at(w / 2, d / 2), at(-w / 2, d / 2)];
}
/** pivot ローカル EN → xyz（x = e, y = 高さ, z = −n） */
const xyz = (p: EN, y: number) => [p.e, y, -p.n];
/**
 * 多角形 poly を天面 y = yTop、厚さ t の板にして三角形（9 個ずつ）を足す。
 * 天面・底面は頂点 0 からの扇形（凹多角形では面の外にはみ出す三角形もできるが、辺の使用回数は正しい）、側面は四角形 2 枚
 */
function pushPlate(out: number[], poly: EN[], yTop = 0, t = 0.01) {
  const n = poly.length;
  for (let i = 1; i + 1 < n; i++) {
    out.push(...xyz(poly[0], yTop), ...xyz(poly[i], yTop), ...xyz(poly[i + 1], yTop));
    out.push(...xyz(poly[0], yTop - t), ...xyz(poly[i + 1], yTop - t), ...xyz(poly[i], yTop - t));
  }
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    out.push(...xyz(a, yTop - t), ...xyz(b, yTop - t), ...xyz(b, yTop));
    out.push(...xyz(a, yTop - t), ...xyz(b, yTop), ...xyz(a, yTop));
  }
}
/** 2 つの多角形が同じ頂点集合か（順序・開始点は問わない。tol 以内） */
function sameCorners(a: EN[], b: EN[], tol: number): boolean {
  return a.length === b.length && a.every((p) => b.some((q) => Math.hypot(p.e - q.e, p.n - q.n) <= tol));
}
/** 旗竿地: 12 × 10 の主部 + 幅 2.5・長さ 8 の竿（南側）。面積 140、凸包は 178 */
const FLAG: EN[] = [
  { e: 0, n: 0 },
  { e: 4, n: 0 },
  { e: 4, n: -8 },
  { e: 6.5, n: -8 },
  { e: 6.5, n: 0 },
  { e: 12, n: 0 },
  { e: 12, n: 10 },
  { e: 0, n: 10 },
];
/** L 字: 12 × 4 の横棒と 5 × 10 の縦棒。面積 78 */
const L_LOT: EN[] = [
  { e: 0, n: 0 },
  { e: 12, n: 0 },
  { e: 12, n: 4 },
  { e: 5, n: 4 },
  { e: 5, n: 10 },
  { e: 0, n: 10 },
];

// ---------------------------------------------------------------------------

describe('sectionOutline: 三角形の集まりの水平断面', () => {
  // 8 × 6 の壁の箱（y 0..6、途中に頂点が無い）と、0.6 m はね出した屋根の板（y 6..6.3）
  const pos: number[] = [];
  pushBox(pos, -4, 4, 0, 6, -3, 3);
  pushBox(pos, -4.6, 4.6, 6, 6.3, -3.6, 3.6);

  it('壁の高さ帯 [0.3, 2] には頂点が無いが、辺との交点から 8 × 6 の外形が出る（屋根は含めない）', () => {
    const out = sectionOutline(pos, { yMin: 0.3, yMax: 2 });
    expect(out.length).toBeGreaterThanOrEqual(4);
    expect(polygonArea(out)).toBeCloseTo(48, 6);
    expect(extent(out).w).toBeCloseTo(8, 6);
    expect(extent(out).d).toBeCloseTo(6, 6);
  });
  it('全高さなら屋根を含む 9.2 × 7.2、帯の外（y 10..12）なら全頂点の凸包に戻る', () => {
    const all = sectionOutline(new Float32Array(pos), { yMin: 0, yMax: Infinity });
    expect(polygonArea(all)).toBeCloseTo(9.2 * 7.2, 4);
    const fb = sectionOutline(pos, { yMin: 10, yMax: 12 });
    expect(polygonArea(fb)).toBeCloseTo(9.2 * 7.2, 4);
  });
  it('窓台・まぐさだけの帯でも、壁の辺との交点が入るので外形は壁の大きさ', () => {
    const p2 = [...pos];
    pushBox(p2, -2, -1, 0.9, 2.0, -3.01, -2.9); // 窓の箱（壁の中、少し手前へ）
    const out = sectionOutline(p2, { yMin: 0.9, yMax: 2.0 });
    expect(extent(out).w).toBeCloseTo(8, 6);
    expect(extent(out).d).toBeCloseTo(6.01, 6);
  });
  it('既定の toEN は n = −z、toEN を差し替えられる', () => {
    const out = sectionOutline(pos, { yMin: 0.3, yMax: 2 });
    expect(out.some((p) => Math.abs(p.e - 4) < 1e-6 && Math.abs(p.n + 3) < 1e-6)).toBe(true);
    const sw = sectionOutline(pos, { yMin: 0.3, yMax: 2, toEN: (x, _y, z) => ({ e: z, n: x }) });
    expect(extent(sw).w).toBeCloseTo(6, 6);
  });
});

describe('plateOutline: 水平な板の外周（凹みも残す）', () => {
  it('旗竿地の板（天面・底面・側面）から 8 頂点の外周を反時計回りで取り出す（面積 140。凸包なら 178）', () => {
    const pos: number[] = [];
    pushPlate(pos, FLAG, 0, 0.01);
    const out = plateOutline(new Float32Array(pos));
    expect(out).not.toBeNull();
    expect(out!.length).toBe(8);
    expect(polygonArea(out!)).toBeCloseTo(140, 6);
    expect(sameCorners(out!, FLAG, 1e-6)).toBe(true);
    expect(Math.abs(polygonArea(convexHull(FLAG)))).toBeCloseTo(178, 6);
  });
  it('L 字の板（6 頂点・面積 78）。時計回りに書いた多角形でも反時計回りで返る', () => {
    const pos: number[] = [];
    pushPlate(pos, [...L_LOT].reverse(), 1.5, 0.2);
    const out = plateOutline(pos);
    expect(out!.length).toBe(6);
    expect(polygonArea(out!)).toBeCloseTo(78, 6);
    expect(sameCorners(out!, L_LOT, 1e-6)).toBe(true);
  });
  it('辺の途中の頂点（一直線上）は除く。板が 1 枚の面だけ（厚さ 0）でも取れる', () => {
    const withMid: EN[] = [FLAG[0], { e: 2, n: 0 }, ...FLAG.slice(1, 6), { e: 12, n: 5 }, ...FLAG.slice(6)];
    const pos: number[] = [];
    for (let i = 1; i + 1 < withMid.length; i++) pos.push(...xyz(withMid[0], 0.3), ...xyz(withMid[i], 0.3), ...xyz(withMid[i + 1], 0.3));
    const out = plateOutline(pos);
    expect(out!.length).toBe(8);
    expect(sameCorners(out!, FLAG, 1e-6)).toBe(true);
  });
  it('接する 2 枚の板（T 字の接合: 境界辺が 2 つの輪になり、片方が外周の外）は null（呼び出し側で凸包に戻す）', () => {
    const pos: number[] = [];
    pushPlate(pos, rectAt({ e: 6, n: 5 }, 0, 12, 10), 0, 0.01);
    pushPlate(pos, rectAt({ e: 5.25, n: -4 }, 0, 2.5, 8), 0, 0.01);
    expect(plateOutline(pos)).toBeNull();
  });
  it('傾いた板（水平な三角形が無い）・小さな水平面しか無い斜面は null、空なら null', () => {
    const tilted: number[] = [];
    for (let i = 1; i + 1 < FLAG.length; i++) tilted.push(...xyz(FLAG[0], FLAG[0].e * 0.1), ...xyz(FLAG[i], FLAG[i].e * 0.1), ...xyz(FLAG[i + 1], FLAG[i + 1].e * 0.1));
    expect(plateOutline(tilted)).toBeNull();
    // 斜面の中の 1 × 1 の水平なパッチだけ → 板の足跡の半分に届かないので null
    const patch = [...tilted];
    pushPlate(patch, rectAt({ e: 6, n: 5 }, 0, 1, 1), 0.3, 0.01);
    expect(plateOutline(patch)).toBeNull();
    expect(plateOutline([])).toBeNull();
  });
  it('天面の外に傾いた土手・別の段がある板は null（天面だけでは敷地全体を表さない）。足跡の中のスロープ・薄い箱の側面は通る', () => {
    // 平らなパッド 12 × 10（天面 y = 0、面積 120）+ 南へ 1 m 下がる土手 12 × 6（n −5 → −11）。
    // 天面 120 ≥ 足跡 192 の半分なので 50 % の判定は通る → 土手の頂点が天面の外にあることで null
    const pos: number[] = [];
    pushPlate(pos, rectAt({ e: 0, n: 0 }, 0, 12, 10), 0, 0.01);
    pos.push(...xyz({ e: -6, n: -5 }, 0), ...xyz({ e: 6, n: -5 }, 0), ...xyz({ e: 6, n: -11 }, -1));
    pos.push(...xyz({ e: -6, n: -5 }, 0), ...xyz({ e: 6, n: -11 }, -1), ...xyz({ e: -6, n: -11 }, -1));
    expect(plateOutline(pos)).toBeNull();
    // 段差のある敷地（上段 12 × 6 at 0.5 m、下段 12 × 4 at 0）: 面積最大の層は上段だが、下段の頂点がその外 → null
    const terrace: number[] = [];
    pushPlate(terrace, rectAt({ e: 0, n: 2 }, 0, 12, 6), 0.5, 0.01);
    pushPlate(terrace, rectAt({ e: 0, n: -3 }, 0, 12, 4), 0, 0.01);
    expect(plateOutline(terrace)).toBeNull();
    // 足跡の中のスロープ（竿の中へ 0.5 m 下がる）は天面の外周の内側なので旗竿地の外周のまま
    const ramp: number[] = [];
    pushPlate(ramp, FLAG, 0, 0.01);
    ramp.push(...xyz({ e: 4.5, n: -1 }, 0), ...xyz({ e: 6, n: -1 }, 0), ...xyz({ e: 6, n: -6 }, -0.5));
    ramp.push(...xyz({ e: 4.5, n: -1 }, 0), ...xyz({ e: 6, n: -6 }, -0.5), ...xyz({ e: 4.5, n: -6 }, -0.5));
    const out = plateOutline(ramp);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(8);
    expect(sameCorners(out!, FLAG, 1e-6)).toBe(true);
  });
});

describe('align.ts の向きの規約（方位: 北 0°、東 90°、時計回り）', () => {
  const P: EN[] = [
    { e: 0, n: 0 },
    { e: 9.1, n: 0 },
    { e: 8.2, n: 6.5 },
    { e: 1.3, n: 7.28 },
  ];
  it('dominantAngleDeg(rotate(P, r)) ≡ dominantAngleDeg(P) + r (mod 90)', () => {
    const base = dominantAngleDeg(P);
    for (const r of [13, 47, 95, 200, -37]) {
      const rot = P.map((p) => applyFit(fitOf(r, 3, -2), p));
      expect(diff90(dominantAngleDeg(rot), base + r)).toBeLessThan(1e-6);
    }
  });
  it('minAreaRect の angleDeg は上軸の方位（mod 90）、90° をまたぐと w と d が入れ替わる', () => {
    const rect = rectAt({ e: 2, n: 1 }, 20, 6, 10); // 上軸 20°、幅 6、奥行 10
    const r0 = minAreaRect(rect)!;
    expect(r0.angleDeg).toBeCloseTo(20, 6);
    expect(r0.w).toBeCloseTo(6, 6);
    expect(r0.d).toBeCloseTo(10, 6);
    const r1 = minAreaRect(rect.map((p) => applyFit(fitOf(30, 0, 0), p)))!;
    expect(r1.angleDeg).toBeCloseTo(50, 6);
    expect(r1.w).toBeCloseTo(6, 6);
    expect(r1.d).toBeCloseTo(10, 6);
    // 20 + 80 = 100 → 10°、上軸が入れ替わるので w = 10, d = 6
    const r2 = minAreaRect(rect.map((p) => applyFit(fitOf(80, 0, 0), p)))!;
    expect(r2.angleDeg).toBeCloseTo(10, 6);
    expect(r2.w).toBeCloseTo(10, 6);
    expect(r2.d).toBeCloseTo(6, 6);
  });
  it('localToEN は applyFit(headingDeg, offsetE, offsetN) と同じで、enToLocal が逆変換', () => {
    const p = { headingDeg: 23, offsetE: 8.2, offsetN: -3.1 };
    const q = localToEN(p, { e: 4.55, n: 3.64 });
    const r = applyFit(fitOf(23, 8.2, -3.1), { e: 4.55, n: 3.64 });
    expect(q.e).toBeCloseTo(r.e, 9);
    expect(q.n).toBeCloseTo(r.n, 9);
    const back = enToLocal(p, q);
    expect(back.e).toBeCloseTo(4.55, 9);
    expect(back.n).toBeCloseTo(3.64, 9);
    // 図面の上 (0, 1) は方位 headingDeg へ（時計回り）
    const up = localToEN({ headingDeg: 90, offsetE: 0, offsetN: 0 }, { e: 0, n: 1 });
    expect(up.e).toBeCloseTo(1, 9);
    expect(up.n).toBeCloseTo(0, 9);
  });
});

describe('isSiteObjectName と自動非表示', () => {
  it('site / lot / parcel / land / 敷地 は敷地、Site_wall・Landing・landscape_fence は建物', () => {
    for (const n of ['site', 'Site', 'SITE_01', 'lot', 'parcel01', 'land', '敷地', '敷地境界']) expect(isSiteObjectName(n), n).toBe(true);
    for (const n of ['Site_wall', 'Landing', 'landscape_fence', 'wall', 'roof', 'parcelwall', 'lots']) expect(isSiteObjectName(n), n).toBe(false);
  });
  it('OBJ の lot / land の板は読み込み時に自動で非表示になる（既存の ground と同じ）', async () => {
    const objBox = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, off: number) => {
      const v = [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y1, z0],
        [x0, y1, z0],
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ];
      const q = [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [2, 3, 7, 6],
        [3, 0, 4, 7],
        [1, 2, 6, 5],
      ];
      return [`o ${name}`, ...v.map((p) => `v ${p.join(' ')}`), ...q.map((f) => `f ${f.map((i) => i + 1 + off).join(' ')}`)].join('\n');
    };
    const text = objBox('house', 0, 9100, 0, 7280, 0, 6000, 0) + '\n' + objBox('lot', -3000, 12000, -3000, 10000, -10, 0, 8) + '\n' + objBox('Landing', 0, 1000, 7280, 8280, 0, 300, 16) + '\n';
    const m = await importModelFile({ name: 'lot.obj', data: new TextEncoder().encode(text).buffer as ArrayBuffer });
    expect(m.objects.find((o) => o.name === 'lot')!.autoHidden).toBe(true);
    expect(m.objects.find((o) => o.name === 'Landing')!.autoHidden).toBe(false);
    expect(m.objects.find((o) => o.name === 'house')!.autoHidden).toBe(false);
    const p = placeLikeApp(m);
    expect(p.siteOutlineLocal()).not.toBeNull();
    expect(extent(p.siteOutlineLocal()!).w).toBeCloseTo(15, 6);
    p.dispose();
  });
});

describe('凹みのある敷地（旗竿地）の輪郭へのフィット', () => {
  let model: ImportedModel;
  let placed: PlacedModel;
  beforeAll(async () => {
    // mm・Z-up の OBJ: 家の箱と、1 枚の多角形の面（8 頂点）で描いた旗竿地 'lot'（読み込み時に自動で非表示になる）
    const house = ['o house', 'v 1500 1500 0', 'v 10600 1500 0', 'v 10600 8780 0', 'v 1500 8780 0', 'v 1500 1500 6000', 'v 10600 1500 6000', 'v 10600 8780 6000', 'v 1500 8780 6000', 'f 1 4 3 2', 'f 5 6 7 8', 'f 1 2 6 5', 'f 3 4 8 7', 'f 4 1 5 8', 'f 2 3 7 6'];
    const lot = ['o lot', ...FLAG.map((p) => `v ${p.e * 1000} ${p.n * 1000} 0`), `f ${FLAG.map((_, i) => i + 9).join(' ')}`];
    model = await importModelFile({ name: 'flag_lot.obj', data: new TextEncoder().encode([...house, ...lot, ''].join('\n')).buffer as ArrayBuffer });
    placed = placeLikeApp(model);
  });

  it('siteOutlineLocal は 8 頂点の凹んだ外周（面積 140 ㎡、12 × 18 m）で凸包ではない', () => {
    expect(model.objects.find((o) => o.name === 'lot')!.autoHidden).toBe(true);
    const s = placed.siteOutlineLocal();
    expect(s).not.toBeNull();
    expect(s!.length).toBe(8);
    expect(polygonArea(s!)).toBeCloseTo(140, 3);
    expect(extent(s!).w).toBeCloseTo(12, 3);
    expect(extent(s!).d).toBeCloseTo(18, 3);
    expect(placed.siteOutlineIsHull()).toBe(false);
  });

  it('fitToSite: 旗竿地を方位 17°・位置 (12.3, −4.5) で置いた輪郭から配置を復元（残差 ≈ 0、0.3° / 5 cm 以内）。凸包で合わせると残差 > 0.3 m', () => {
    const truth = { headingDeg: 17, offsetE: 12.3, offsetN: -4.5 };
    const plate = placed.siteOutlineLocal()!;
    const site = plate.map((c) => localToEN(truth, c));
    const r = fitToSite(placed, site, 0)!;
    expect(r.unitSuspect).toBe(false);
    expect(r.convexOnly).toBe(false);
    expect(Math.abs(normDeg180(r.headingDeg - 17))).toBeLessThan(0.3);
    expect(Math.abs(r.offsetE - 12.3)).toBeLessThan(0.05);
    expect(Math.abs(r.offsetN - -4.5)).toBeLessThan(0.05);
    expect(r.rmsM).toBeLessThan(0.02);
    expect(Math.abs(r.scaleRatio - 1)).toBeLessThan(1e-6);
    // 旗竿地は 180° 対称ではないので、今の向きが 190° でも 17°（の表し方 197 ではなく 17 + 360k）に戻る
    const r2 = fitToSite(placed, site, 190)!;
    expect(Math.abs(normDeg180(r2.headingDeg - 17))).toBeLessThan(0.3);
    expect(r2.rmsM).toBeLessThan(0.02);
    // 以前のように凸包を合わせると、竿の分だけ偏って残差が残る
    const hullFit = fitPolygonToPolygon(convexHull(plate), site, { allowScale: false, initialRotDeg: [0] });
    expect(hullFit.rmsM).toBeGreaterThan(0.3);
  });

  it('単位違い（m と解釈して 1000 倍）: ICP をせず向きだけ合わせる（unitSuspect、scaleRatio ≈ 0.001、位置は今のまま、残差は NaN）', () => {
    const truth = { headingDeg: 17, offsetE: 12.3, offsetN: -4.5 };
    const site = placed.siteOutlineLocal()!.map((c) => localToEN(truth, c));
    const big = placeLikeApp(model, { unit: 'm', offsetE: 1.5, offsetN: -2 });
    const t0 = performance.now();
    const r = fitToSite(big, site, 0)!;
    const ms = performance.now() - t0;
    expect(r.unitSuspect).toBe(true);
    expect(r.scaleRatio).toBeCloseTo(0.001, 6);
    expect(Number.isNaN(r.rmsM)).toBe(true);
    expect(r.offsetE).toBe(1.5);
    expect(r.offsetN).toBe(-2);
    // 向きは 90° の周期ではなく（180° 対称な矩形どうしなので）180° の周期で正しい
    expect(diff90(r.headingDeg, 17)).toBeLessThan(0.5);
    expect(Math.abs(normDeg180(r.headingDeg - 17))).toBeLessThan(0.5);
    expect(ms).toBeLessThan(3000);
    const al = { kind: 'siteFit' as const, rmsM: r.rmsM, scaleRatio: r.scaleRatio, at: '' };
    expect(scaleSuspect(al)).toBe(true);
    expect(describeAlignment({ ...DEFAULT_PLACEMENT, alignment: al })).toMatch(/向きだけ.*1,000 倍.*単位/);
    expect(alignmentLabel({ ...DEFAULT_PLACEMENT, alignment: al })).toMatch(/向きだけ/);
    // 1.5 倍程度（描いた輪郭が少し大きい）なら ICP で合わせ、単位は疑わない
    const near = fitToSite(placed, site.map((q) => ({ e: q.e * 1.3, n: q.n * 1.3 })), 0)!;
    expect(near.unitSuspect).toBe(false);
    expect(scaleSuspect({ kind: 'siteFit', rmsM: near.rmsM, scaleRatio: near.scaleRatio, at: '' })).toBe(false);
    big.dispose();
  });

  it('単位違いの向き合わせは 3DS の敷地を周長の比で揃えてから矩形を比べる: 方位 60° の輪郭で 60°（−30° ではなく）。Δ と Δ+180 は今の向きに近い方', () => {
    const big = placeLikeApp(model, { unit: 'm' });
    // 揃えずに矩形を比べると、幅・奥行とも 3DS の方が大きいので 4 候補が同点になり |向き| が最小の −30° に倒れていた
    for (const truthHeading of [60, 75, 89, -70]) {
      const site = placed.siteOutlineLocal()!.map((c) => localToEN({ headingDeg: truthHeading, offsetE: 12.3, offsetN: -4.5 }, c));
      const r = fitToSite(big, site, 0)!;
      expect(r.unitSuspect).toBe(true);
      expect(Math.abs(normDeg180(r.headingDeg - truthHeading))).toBeLessThan(0.5);
    }
    // 矩形は 180° 対称: 今の向きが 190° なら 17 ではなく 197（190 に連続な表し方）
    const site17 = placed.siteOutlineLocal()!.map((c) => localToEN({ headingDeg: 17, offsetE: 12.3, offsetN: -4.5 }, c));
    const r190 = fitToSite(big, site17, 190)!;
    expect(r190.unitSuspect).toBe(true);
    expect(Math.abs(r190.headingDeg - 197)).toBeLessThan(0.5);
    // 単位を直す（寸法もこの比で合わせる）と ICP で輪郭ごと合わせ、同じ向きに収まる
    const fixed = placeLikeApp(model, { unit: 'custom', customScale: unitScale(big.placement) * r190.scaleRatio });
    const rf = fitToSite(fixed, site17, r190.headingDeg)!;
    expect(rf.unitSuspect).toBe(false);
    expect(Math.abs(normDeg180(rf.headingDeg - 17))).toBeLessThan(0.3);
    expect(rf.rmsM).toBeLessThan(0.05);
    fixed.dispose();
    big.dispose();
  });

  it('一直線上の輪郭（A → B → A を A で閉じた面積 0）では例外を投げず null（単位違いの分岐でも）', () => {
    const degenerate: EN[] = [
      { e: 0, n: 0 },
      { e: 10, n: 0 },
      { e: 0, n: 0 },
    ];
    const big = placeLikeApp(model, { unit: 'm' });
    expect(() => fitToSite(big, degenerate, 0)).not.toThrow();
    expect(fitToSite(big, degenerate, 0)).toBeNull();
    // 周長の比 20 / 60 = 0.33 でも単位違いの分岐（mm の建物でも矩形が作れないので null）
    expect(() => fitToSite(placed, degenerate, 0)).not.toThrow();
    expect(fitToSite(placed, degenerate, 0)).toBeNull();
    // 面積 0 でも周長 0 の輪郭（同じ点だけ）も null
    expect(fitToSite(placed, [degenerate[0], degenerate[0], degenerate[0]], 0)).toBeNull();
    big.dispose();
  });

  it('convexOnly は 3DS の敷地が凸包でしか取れなかったとき（接する 2 枚の板）だけ。板の外周が取れていれば shapeDiffers', async () => {
    // 'lot' が接する 2 枚の板（主部 12 × 10 と竿 2.5 × 8 を別の面で描いた T 字の接合）: 外周が取れず凸包に戻る
    const main = rectAt({ e: 6, n: 5 }, 0, 12, 10);
    const pole = rectAt({ e: 5.25, n: -4 }, 0, 2.5, 8);
    const house = ['o house', 'v 1500 1500 0', 'v 10600 1500 0', 'v 10600 8780 0', 'v 1500 8780 0', 'v 1500 1500 6000', 'v 10600 1500 6000', 'v 10600 8780 6000', 'v 1500 8780 6000', 'f 1 4 3 2', 'f 5 6 7 8', 'f 1 2 6 5', 'f 3 4 8 7', 'f 4 1 5 8', 'f 2 3 7 6'];
    const lot = ['o lot', ...[...main, ...pole].map((p) => `v ${p.e * 1000} ${p.n * 1000} 0`), 'f 9 10 11 12', 'f 13 14 15 16'];
    const tModel = await importModelFile({ name: 'two_plates.obj', data: new TextEncoder().encode([...house, ...lot, ''].join('\n')).buffer as ArrayBuffer });
    const two = placeLikeApp(tModel);
    expect(two.siteOutlineIsHull()).toBe(true);
    expect(two.siteOutlineLocal()!.length).toBe(6);
    const truth = { headingDeg: 17, offsetE: 12.3, offsetN: -4.5 };
    const siteFlag = FLAG.map((c) => localToEN(truth, c));
    const rHull = fitToSite(two, siteFlag, 0)!;
    expect(rHull.unitSuspect).toBe(false);
    expect(rHull.convexOnly).toBe(true);
    expect(rHull.shapeDiffers).toBe(false);
    two.dispose();
    // 旗竿地の板（外周が取れる・凹）に凹んだ輪郭: どちらも立たない
    const rFlag = fitToSite(placed, siteFlag, 0)!;
    expect(rFlag.convexOnly).toBe(false);
    expect(rFlag.shapeDiffers).toBe(false);
    // 旗竿地の板に凸（矩形）の輪郭: 描いた輪郭に凹みが無いのでどちらも立たない
    const rRect = fitToSite(placed, rectAt({ e: 6, n: 1 }, 17, 12, 18), 0)!;
    expect(rRect.convexOnly).toBe(false);
    expect(rRect.shapeDiffers).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('サンプル住宅（--site 変種）の外形と位置合わせ', () => {
  let model: ImportedModel;
  let placed: PlacedModel;
  beforeAll(async () => {
    model = await importModelFile({ name: 'sample_site.3ds', data: generateSite() });
    placed = placeLikeApp(model);
  });

  it('site は自動で非表示になり、足跡（矩形）は 10.3 × 8.78 のまま（板を含まない）', () => {
    const site = model.objects.find((o) => o.name === 'site')!;
    expect(site.autoHidden).toBe(true);
    expect(placed.placement.hiddenObjects).toEqual(['site']);
    expect(placed.dimensions().w).toBeCloseTo(10.3, 2);
    expect(Math.abs(placed.dimensions().d - 8.79)).toBeLessThanOrEqual(0.02);
    const fp = placed.footprintEN();
    expect(extent(fp).w).toBeCloseTo(10.3, 2);
  });

  it('(i) outlineLocal（壁の高さ帯）は幅 9.1 ± 0.05（軒先を含まない）、奥行 7.28 + ポーチ 1.5 ± 0.05、全高さなら 10.3', () => {
    const wall = placed.outlineLocal();
    expect(wall.length).toBeGreaterThanOrEqual(4);
    expect(Math.abs(extent(wall).w - 9.1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(extent(wall).d - (7.28 + 1.5))).toBeLessThanOrEqual(0.05);
    // ポーチ（モデルの北側 = +n）を含む: 北端は壁の北端 + 1.5 m
    const maxN = Math.max(...wall.map((p) => p.n));
    const minN = Math.min(...wall.map((p) => p.n));
    expect(maxN - minN).toBeGreaterThan(8.7);
    expect(wall.some((p) => Math.abs(p.n - maxN) < 1e-6 && Math.abs(p.e) <= 1.0 + 1e-6)).toBe(true); // ポーチの角（幅 2 m）
    const eaves = placed.outlineLocal({ yMin: 0, yMax: Infinity });
    expect(Math.abs(extent(eaves).w - 10.3)).toBeLessThanOrEqual(0.02);
    // 反時計回り
    expect(polygonArea(wall)).toBeGreaterThan(0);
    // キャッシュ: 同じ結果の配列が返る
    expect(placed.outlineLocal()).toBe(wall);
  });

  it('(ii) siteOutlineLocal は板の 4 隅: e = x/1000、n = (y − 745)/1000（rawBox の中心 y = 745 mm）', () => {
    const s = placed.siteOutlineLocal();
    expect(s).not.toBeNull();
    expect(s!.length).toBe(4);
    const es = s!.map((p) => p.e).sort((a, b) => a - b);
    const ns = s!.map((p) => p.n).sort((a, b) => a - b);
    expect(es[0]).toBeCloseTo(-5, 4);
    expect(es[3]).toBeCloseTo(9, 4);
    expect(ns[0]).toBeCloseTo((-7000 - 745) / 1000, 4);
    expect(ns[3]).toBeCloseTo((5000 - 745) / 1000, 4);
    // 表示している（hiddenObjects から外した）敷地は建物の一部なので対象にしない
    const shown = new PlacedModel(model, { ...DEFAULT_PLACEMENT, hiddenObjects: [] });
    expect(shown.siteOutlineLocal()).toBeNull();
    expect(shown.dimensions().w).toBeCloseTo(9 + 5.15, 2); // 板（x −5..9）と軒先（±5.15）を合わせた幅
    shown.dispose();
  });

  it('outlineEN は方位・位置を適用し、heading 90 でポーチ（北側）が東を向く', () => {
    const p = placeLikeApp(model, { headingDeg: 90, offsetE: 5, offsetN: -2 });
    const o = p.outlineEN();
    const maxE = Math.max(...o.map((q) => q.e));
    // ポーチの北端 n = 4.395 → 東 e = 5 + 4.395
    expect(maxE).toBeCloseTo(5 + (5140 - 745) / 1000, 3);
    expect(extent(o).w).toBeCloseTo(extent(placed.outlineLocal()).d, 6);
    p.dispose();
  });

  it('(iii) twoPointPlacement: 2 つの角から方位 23°・位置 (8.2, −3.1) を復元（|Δ方位| < 0.05°、位置 2 cm 以内）', () => {
    const truth = { headingDeg: 23, offsetE: 8.2, offsetN: -3.1 };
    const hull = placed.outlineLocal();
    const corners = [hull[0], hull[Math.floor(hull.length / 2)]];
    const pairs: AlignmentPair[] = corners.map((c) => {
      const en = localToEN(truth, c);
      return { local: c, target: frameFromLocal(FRAME, en.e, en.n) };
    });
    const s = twoPointPlacement(placed, FRAME, pairs);
    expect(Math.abs(normDeg180(s.headingDeg - 23))).toBeLessThan(0.05);
    expect(Math.abs(s.offsetE - 8.2)).toBeLessThan(0.02);
    expect(Math.abs(s.offsetN - -3.1)).toBeLessThan(0.02);
    expect(s.rmsM).toBeLessThan(0.02);
    expect(Math.abs(s.scaleRatio - 1)).toBeLessThan(0.002);
    // 3 組以上なら最小二乗
    const three = [...pairs, { local: hull[1], target: (() => { const en = localToEN(truth, hull[1]); return frameFromLocal(FRAME, en.e, en.n); })() }];
    const s3 = solvePairs(FRAME, three);
    expect(Math.abs(normDeg180(s3.headingDeg - 23))).toBeLessThan(0.05);
    // 対応点が 1 組ならエラー
    expect(() => solvePairs(FRAME, [pairs[0]])).toThrow();
  });

  it('(iv) fitToSite: 板を方位 17°・位置 (12.3, −4.5) で置いた輪郭から配置を復元（0.3° / 5 cm 以内）', () => {
    const truth = { headingDeg: 17, offsetE: 12.3, offsetN: -4.5 };
    const site = placed.siteOutlineLocal()!.map((c) => localToEN(truth, c));
    const r = fitToSite(placed, site, 0);
    expect(r).not.toBeNull();
    expect(Math.abs(normDeg180(r!.headingDeg - 17))).toBeLessThan(0.3);
    expect(Math.abs(r!.offsetE - 12.3)).toBeLessThan(0.05);
    expect(Math.abs(r!.offsetN - -4.5)).toBeLessThan(0.05);
    expect(r!.rmsM).toBeLessThan(0.05);
  });

  it('(iv-c) 板の外周が取れていて凸なのに、描いた輪郭が L 字（凹）: convexOnly ではなく shapeDiffers（凸包で合わせた、とは言わない）', () => {
    expect(placed.siteOutlineIsHull()).toBe(false);
    const truth = { headingDeg: 17, offsetE: 12.3, offsetN: -4.5 };
    const plate = placed.siteOutlineLocal()!;
    const e0 = Math.min(...plate.map((p) => p.e));
    const e1 = Math.max(...plate.map((p) => p.e));
    const n0 = Math.min(...plate.map((p) => p.n));
    const n1 = Math.max(...plate.map((p) => p.n));
    // 北東の角を 6 × 5 m 欠いた L 字（面積は板の約 8 割。凸包との比 > 1.05 で「凹みのある敷地」）
    const lShape: EN[] = [
      { e: e0, n: n0 },
      { e: e1, n: n0 },
      { e: e1, n: n1 - 5 },
      { e: e1 - 6, n: n1 - 5 },
      { e: e1 - 6, n: n1 },
      { e: e0, n: n1 },
    ];
    const r = fitToSite(placed, lShape.map((c) => localToEN(truth, c)), 0)!;
    expect(r.unitSuspect).toBe(false);
    expect(r.convexOnly).toBe(false);
    expect(r.shapeDiffers).toBe(true);
    // 矩形の輪郭ならどちらも立たない
    const rRect = fitToSite(placed, plate.map((c) => localToEN(truth, c)), 0)!;
    expect(rRect.convexOnly).toBe(false);
    expect(rRect.shapeDiffers).toBe(false);
  });

  it('siteOutlineIsHull は siteOutlineLocal と同じキャッシュを使う（表示の更新のたびに敷地の頂点を読み直さない）。rebuild で更新', () => {
    const p = placeLikeApp(model);
    const siteMesh = model.raw.children.find((o) => o.name === 'site') as Mesh;
    const geom = siteMesh.geometry;
    const orig = geom.getAttribute.bind(geom);
    let reads = 0;
    geom.getAttribute = ((name: string) => {
      if (name === 'position') reads++;
      return orig(name);
    }) as typeof geom.getAttribute;
    try {
      expect(p.siteOutlineIsHull()).toBe(false);
      const n0 = reads;
      expect(n0).toBeGreaterThan(0);
      for (let i = 0; i < 50; i++) {
        p.siteOutlineIsHull();
        p.siteOutlineLocal();
      }
      expect(reads).toBe(n0);
      // 敷地を表示に戻す → 外形が無いので false（rebuild でキャッシュが捨てられる）
      p.placement.hiddenObjects = [];
      p.rebuild();
      expect(p.siteOutlineLocal()).toBeNull();
      expect(p.siteOutlineIsHull()).toBe(false);
    } finally {
      geom.getAttribute = orig;
      p.dispose();
    }
  });

  it('(iv-b) 矩形の敷地は 180° 対称なので、今の向き（190°）に近い候補 197° を採る', () => {
    const truth = { headingDeg: 17, offsetE: 12.3, offsetN: -4.5 };
    const site = placed.siteOutlineLocal()!.map((c) => localToEN(truth, c));
    const r = fitToSite(placed, site, 190);
    expect(Math.abs(normDeg180(r!.headingDeg - 197))).toBeLessThan(0.3);
    expect(r!.rmsM).toBeLessThan(0.05);
    // 向きの表し方は今の向きに連続（190 の近く）
    expect(Math.abs(r!.headingDeg - 197)).toBeLessThan(0.3);
    // 敷地オブジェクトが無ければ null
    const noSite = new PlacedModel(model, { ...DEFAULT_PLACEMENT, hiddenObjects: [] });
    expect(fitToSite(noSite, site, 0)).toBeNull();
    noSite.dispose();
  });

  it('(v) orientToSite: 敷地の辺の向き 30° に対し {30, 120, 210, 300} のうち今の向きに最も近いもの', () => {
    const site = rectAt({ e: 3, n: 4 }, 30, 14, 12);
    expect(orientToSite(placed, site, 0)).toBeCloseTo(30, 6);
    expect(orientToSite(placed, site, 100)).toBeCloseTo(120, 6);
    expect(orientToSite(placed, site, -50)).toBeCloseTo(-60, 6);
    expect(orientToSite(placed, site, 190)).toBeCloseTo(210, 6);
    // 敷地が 3 点未満なら今の向きのまま
    expect(orientToSite(placed, site.slice(0, 2), 12)).toBe(12);
  });

  it('(vi) reapplyAlignment: ピンが 30 m 動いても 2 点合わせの建物は同じ緯度経度に留まる', () => {
    const truth = { headingDeg: 23, offsetE: 8.2, offsetN: -3.1 };
    const hull = placed.outlineLocal();
    const corners = [hull[0], hull[Math.floor(hull.length / 2)]];
    const pairs: AlignmentPair[] = corners.map((c) => {
      const en = localToEN(truth, c);
      return { local: c, target: frameFromLocal(FRAME, en.e, en.n) };
    });
    const pl: ModelPlacement = { ...DEFAULT_PLACEMENT, ...truth, hiddenObjects: ['site'], alignment: { kind: 'twoPoint', pairs, unitScaleM: 0.001, mirror: false, upAxis: 'z', at: '' } };
    const frame2 = frameFromLocal(FRAME, 20, 22.4); // 北東へ約 30 m
    expect(reapplyAlignment(frame2, pl, null)).toBe('twoPoint');
    for (const pr of pairs) {
      const en = localToEN(pl, pr.local);
      const got = frameFromLocal(frame2, en.e, en.n);
      const d = frameToLocal(got, pr.target);
      expect(Math.hypot(d.e, d.n)).toBeLessThan(0.02);
    }
    // pivot の緯度経度も記録される
    const piv = frameToLocal(frame2, pl.alignment!.pivotLatLon!);
    expect(piv.e).toBeCloseTo(pl.offsetE, 6);
    expect(piv.n).toBeCloseTo(pl.offsetN, 6);
    expect(Math.abs(normDeg180(pl.headingDeg - 23))).toBeLessThan(0.05);
  });

  it('単位が変わると対応点を換算して解き直し、寸法の比に表れる。反転・上方向が変わると対応点は使えず pivot の位置に戻す', () => {
    const truth = { headingDeg: 23, offsetE: 8.2, offsetN: -3.1 };
    const hull = placed.outlineLocal();
    const corners = [hull[0], hull[Math.floor(hull.length / 2)]];
    const pairs: AlignmentPair[] = corners.map((c) => {
      const en = localToEN(truth, c);
      return { local: c, target: frameFromLocal(FRAME, en.e, en.n) };
    });
    const pl: ModelPlacement = { ...DEFAULT_PLACEMENT, ...truth, unit: 'custom', customScale: 0.00102, hiddenObjects: ['site'], alignment: { kind: 'twoPoint', pairs, unitScaleM: 0.001, mirror: false, upAxis: 'z', at: '' } };
    expect(unitScale(pl)).toBeCloseTo(0.00102, 9);
    expect(reapplyAlignment(FRAME, pl, null)).toBe('twoPoint');
    // 角は 2 % 大きく広がるので、航空写真上の距離 / モデル上の距離 = 1 / 1.02
    expect(pl.alignment!.scaleRatio).toBeCloseTo(1 / 1.02, 3);
    expect(Math.abs(normDeg180(pl.headingDeg - 23))).toBeLessThan(0.05);
    // 反転: 対応点は使えない → pivot の緯度経度で位置だけ戻す
    const pivot = frameFromLocal(FRAME, 1.5, -2.5);
    const mir: ModelPlacement = { ...DEFAULT_PLACEMENT, ...truth, mirror: true, hiddenObjects: ['site'], alignment: { kind: 'twoPoint', pairs, unitScaleM: 0.001, mirror: false, upAxis: 'z', pivotLatLon: pivot, at: '' } };
    expect(alignmentContextOk(mir)).toBe(false);
    expect(reapplyAlignment(FRAME, mir, null)).toBe('pivot');
    expect(mir.offsetE).toBeCloseTo(1.5, 2);
    expect(mir.offsetN).toBeCloseTo(-2.5, 2);
    expect(mir.headingDeg).toBe(23);
    // 記録が無ければ何もしない
    const none: ModelPlacement = { ...DEFAULT_PLACEMENT, offsetE: 3 };
    expect(reapplyAlignment(FRAME, none, null)).toBeNull();
    expect(none.offsetE).toBe(3);
  });

  it('(vii) refitSiteAlignment: 反転・単位を変えると敷地の輪郭に合わせ直し、敷地を表示に戻すと記録を外す', () => {
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const truth = { headingDeg: 17, offsetE: 12.3, offsetN: -4.5 };
    const site = placed.siteOutlineLocal()!.map((c) => localToEN(truth, c));
    const pl: ModelPlacement = { ...DEFAULT_PLACEMENT, hiddenObjects: ['site'] };
    const p = new PlacedModel(model, pl);
    const r0 = fitToSite(p, site, 0)!;
    pl.headingDeg = r2(r0.headingDeg);
    pl.offsetE = r2(r0.offsetE);
    pl.offsetN = r2(r0.offsetN);
    pl.alignment = { kind: 'siteFit', rmsM: r0.rmsM, scaleRatio: r0.scaleRatio, at: '' };
    // 反転: 板は家の周りに非対称（x −5..9 m）なので、合わせ直すと位置が約 4 m 変わり、残差は小さいまま
    pl.mirror = true;
    p.rebuild();
    expect(refitSiteAlignment(p, pl, site)).toBe('refit');
    expect(pl.alignment!.kind).toBe('siteFit');
    expect(pl.alignment!.rmsM).toBeLessThan(0.05);
    expect(Math.hypot(pl.offsetE - r0.offsetE, pl.offsetN - r0.offsetN)).toBeGreaterThan(0.5);
    const after = p.siteOutlineLocal()!.map((c) => localToEN(pl, c));
    expect(sameCorners(after, site, 0.05)).toBe(true);
    // 単位違い（m にすると 1000 倍）: 向きだけ合わせ、単位を疑う
    pl.mirror = false;
    pl.unit = 'm';
    p.rebuild();
    expect(refitSiteAlignment(p, pl, site)).toBe('refit');
    expect(scaleSuspect(pl.alignment)).toBe(true);
    expect(describeAlignment(pl)).toMatch(/向きだけ/);
    // 敷地を表示に戻す: 外形が取れないので記録を外す（pivot の緯度経度は残す）
    pl.unit = 'mm';
    pl.hiddenObjects = [];
    pl.alignment!.pivotLatLon = { lat: 35.6, lon: 139.6 };
    p.rebuild();
    expect(refitSiteAlignment(p, pl, site)).toBe('dropped');
    expect(pl.alignment?.kind).toBeUndefined();
    expect(pl.alignment?.pivotLatLon).toEqual({ lat: 35.6, lon: 139.6 });
    p.dispose();
    // 向きだけ: 合わせ直す。敷地の輪郭が無ければ記録を外す
    const pl2: ModelPlacement = { ...DEFAULT_PLACEMENT, hiddenObjects: ['site'], headingDeg: 5, alignment: { kind: 'orient', at: '' } };
    const p2 = new PlacedModel(model, pl2);
    expect(refitSiteAlignment(p2, pl2, rectAt({ e: 3, n: 4 }, 30, 14, 12))).toBe('refit');
    expect(pl2.headingDeg).toBeCloseTo(30, 6);
    expect(refitSiteAlignment(p2, pl2, null)).toBe('dropped');
    expect(pl2.alignment?.kind).toBeUndefined();
    // 2 点合わせ・手で置いた配置は対象外
    expect(refitSiteAlignment(p2, { ...DEFAULT_PLACEMENT, alignment: { kind: 'twoPoint', at: '' } }, site)).toBeNull();
    expect(refitSiteAlignment(p2, { ...DEFAULT_PLACEMENT }, site)).toBeNull();
    p2.dispose();
  });

  it('describeAlignment / alignmentLabel は状態を言葉にする', () => {
    expect(describeAlignment({ ...DEFAULT_PLACEMENT })).toMatch(/自動配置/);
    expect(describeAlignment({ ...DEFAULT_PLACEMENT, offsetE: 1 })).toBe('手で置いた配置です');
    expect(describeAlignment({ ...DEFAULT_PLACEMENT, alignment: { kind: 'twoPoint', rmsM: 0.08, scaleRatio: 1.002, at: '' } })).toBe('2 点合わせ: 残差 0.08 m／寸法の比 1.002（単位は正しいようです）');
    expect(describeAlignment({ ...DEFAULT_PLACEMENT, alignment: { kind: 'twoPoint', rmsM: 0.3, scaleRatio: 1.05, at: '' } })).toMatch(/5\.0 % ずれています/);
    expect(describeAlignment({ ...DEFAULT_PLACEMENT, alignment: { kind: 'siteFit', rmsM: 0.12, at: '' } })).toBe('敷地の輪郭に合わせました（残差 0.12 m）');
    expect(describeAlignment({ ...DEFAULT_PLACEMENT, alignment: { kind: 'orient', at: '' } })).toMatch(/向きだけ/);
    expect(alignmentLabel({ ...DEFAULT_PLACEMENT, alignment: { kind: 'twoPoint', rmsM: 0.08, scaleRatio: 1, at: '' } })).toMatch(/^2 点合わせ/);
    expect(alignmentLabel({ ...DEFAULT_PLACEMENT, offsetN: 2 })).toMatch(/^手動/);
  });
});

// ---------------------------------------------------------------------------

describe('followPinMove: ピンが動いたときの建物と測定点の追従', () => {
  const prev: GeoFrame = { ...FRAME, groundElev: 10 };
  /** 北東へ約 30 m（東 20、北 22.4）、地盤高 +2.5 */
  const next: GeoFrame = { ...frameFromLocal(FRAME, 20, 22.4), address: '', groundElev: 12.5 };
  const points = (): MeasurePoint[] => [{ id: 'a', label: '窓', pos: [4, 1.5, -2], normal: [0, 0, -1] }];

  it('記録が無い（読み込んだだけの）建物はピンに付いて動く: 配置・測定点はそのまま', () => {
    const pl: ModelPlacement = { ...DEFAULT_PLACEMENT, offsetE: 3, offsetN: -2, baseY: 0.3 };
    const pts = points();
    const r = followPinMove(prev, next, pl, pts);
    expect(r.kind).toBe('pin');
    expect([r.dE, r.dN, r.dY]).toEqual([0, 0, 0]);
    expect([pl.offsetE, pl.offsetN, pl.baseY]).toEqual([3, -2, 0.3]);
    expect(pts[0].pos).toEqual([4, 1.5, -2]);
  });

  it('種類の無い記録（pivot の緯度経度だけ）でも配置が既定（ピンの位置・真北）なら読み込んだだけと同じ: ピンに付いて動き、記録の緯度経度は新しいピンに揃う', () => {
    // 以前の版は単位・表示だけの変更でも記録を作っていた（保存データに残る）。「ピンの位置に戻す」の後も同じ形
    const pl: ModelPlacement = { ...DEFAULT_PLACEMENT, baseY: 0.3, alignment: { at: '', pivotLatLon: pivotLatLonOf(prev, { offsetE: 0, offsetN: 0 }) } };
    const pts = points();
    const r = followPinMove(prev, next, pl, pts, 300);
    expect(r.kind).toBe('pin');
    expect([r.dE, r.dN, r.dY]).toEqual([0, 0, 0]);
    expect([pl.offsetE, pl.offsetN, pl.headingDeg, pl.baseY]).toEqual([0, 0, 0, 0.3]);
    expect(pts[0].pos).toEqual([4, 1.5, -2]);
    expect(pl.alignment?.pivotLatLon).toEqual(pivotLatLonOf(next, pl));
    expect(describeAlignment(pl)).toMatch(/自動配置/);
    // 向きだけ変えてある（R で 90°）なら手で置いた配置: 地球上の同じ所に留まる
    const turned: ModelPlacement = { ...DEFAULT_PLACEMENT, headingDeg: 90, alignment: { at: '', pivotLatLon: pivotLatLonOf(prev, { offsetE: 0, offsetN: 0 }) } };
    expect(followPinMove(prev, next, turned, [], 300).kind).toBe('pivot');
    expect(turned.offsetE).toBeCloseTo(-20, 2);
    expect(turned.offsetN).toBeCloseTo(-22.4, 2);
    expect(describeAlignment(turned)).toBe('手で置いた配置です');
    // 種類のある記録（敷地の輪郭に合わせた）は配置が既定でも留まる
    const fit: ModelPlacement = { ...DEFAULT_PLACEMENT, alignment: { kind: 'siteFit', at: '', rmsM: 0.01, pivotLatLon: pivotLatLonOf(prev, { offsetE: 0, offsetN: 0 }) } };
    expect(followPinMove(prev, next, fit, [], 300).kind).toBe('pivot');
    expect(fit.offsetE).toBeCloseTo(-20, 2);
  });

  it('pivot の緯度経度がある（手で置いた）建物は地球上の同じ所に留まり、測定点も同じだけ動く。底面は T.P. を保つ', () => {
    const pl: ModelPlacement = { ...DEFAULT_PLACEMENT, offsetE: 3, offsetN: -2, baseY: 0.3, alignment: { at: '', pivotLatLon: pivotLatLonOf(prev, { offsetE: 3, offsetN: -2 }) } };
    const pts = points();
    const r = followPinMove(prev, next, pl, pts, 300);
    expect(r.kind).toBe('pivot');
    expect(pl.offsetE).toBeCloseTo(3 - 20, 2);
    expect(pl.offsetN).toBeCloseTo(-2 - 22.4, 2);
    expect(pl.baseY).toBeCloseTo(0.3 - 2.5, 6);
    expect(r.dE).toBeCloseTo(-20, 2);
    expect(r.dN).toBeCloseTo(-22.4, 2);
    expect(r.dY).toBeCloseTo(-2.5, 6);
    // 測定点（ワールド: x = e, z = −n）は建物と同じだけ
    expect(pts[0].pos[0]).toBeCloseTo(4 - 20, 2);
    expect(pts[0].pos[1]).toBeCloseTo(1.5 - 2.5, 6);
    expect(pts[0].pos[2]).toBeCloseTo(-2 + 22.4, 2);
    // 地盤高が片方でも分からなければ高さは触らない
    const pl2: ModelPlacement = { ...DEFAULT_PLACEMENT, baseY: 0.3, alignment: { at: '', pivotLatLon: pivotLatLonOf(prev, { offsetE: 0, offsetN: 0 }) } };
    followPinMove({ ...prev, groundElev: null }, next, pl2, []);
    expect(pl2.baseY).toBe(0.3);
  });

  it('2 点合わせの記録は対応点から解き直す（twoPoint）', () => {
    const truth = { headingDeg: 23, offsetE: 8.2, offsetN: -3.1 };
    const locals: EN[] = [
      { e: -4.55, n: -3.64 },
      { e: 4.55, n: 3.64 },
    ];
    const pairs: AlignmentPair[] = locals.map((c) => {
      const en = localToEN(truth, c);
      return { local: c, target: frameFromLocal(prev, en.e, en.n) };
    });
    const pl: ModelPlacement = { ...DEFAULT_PLACEMENT, ...truth, alignment: { kind: 'twoPoint', pairs, unitScaleM: 0.001, mirror: false, upAxis: 'z', at: '' } };
    const r = followPinMove(prev, next, pl, [], 300);
    expect(r.kind).toBe('twoPoint');
    expect(pl.offsetE).toBeCloseTo(8.2 - 20, 1);
    expect(pl.offsetN).toBeCloseTo(-3.1 - 22.4, 1);
  });

  it('新しいピンから周辺環境の半径より遠くなると、ピンの位置に戻して記録を外す（reset）。測定点は建物と一緒に戻る', () => {
    const far: GeoFrame = { ...frameFromLocal(FRAME, 400, 0), address: '', groundElev: null };
    const pl: ModelPlacement = { ...DEFAULT_PLACEMENT, offsetE: 3, offsetN: -2, baseY: 0.3, alignment: { at: '', pivotLatLon: pivotLatLonOf(prev, { offsetE: 3, offsetN: -2 }) } };
    const pts = points();
    const r = followPinMove(prev, far, pl, pts, 300);
    expect(r.kind).toBe('reset');
    expect([pl.offsetE, pl.offsetN, pl.baseY]).toEqual([0, 0, 0.3]);
    expect(pl.alignment).toBeUndefined();
    expect(pts[0].pos).toEqual([4 - 3, 1.5, -2 - 2]);
  });

  it('建物が無ければ測定点は周辺環境と同じく地球上の同じ所に留まる', () => {
    const pts = points();
    const r = followPinMove(prev, next, null, pts);
    expect(r.kind).toBe('none');
    expect(pts[0].pos[0]).toBeCloseTo(4 - 20, 2);
    expect(pts[0].pos[1]).toBeCloseTo(1.5 - 2.5, 6);
    expect(pts[0].pos[2]).toBeCloseTo(-2 + 22.4, 2);
    // 最初のピン（prev 無し）: 手で置いた記録があればその位置へ、無ければ何もしない
    const pl: ModelPlacement = { ...DEFAULT_PLACEMENT, offsetE: 1, alignment: { at: '', pivotLatLon: pivotLatLonOf(next, { offsetE: 5, offsetN: 6 }) } };
    expect(followPinMove(null, next, pl, []).kind).toBe('pivot');
    expect(pl.offsetE).toBeCloseTo(5, 2);
    expect(followPinMove(null, next, { ...DEFAULT_PLACEMENT }, []).kind).toBe('pin');
  });
});

// ---------------------------------------------------------------------------

describe('プロジェクトの往復', () => {
  it('applyProject(serializeProject()) で測定点の結果と位置合わせの記録が残る', async () => {
    const model = await importModelFile({ name: 'sample_house.3ds', data: toArrayBuffer(readFileSync(SAMPLE)) });
    study.frame = { ...FRAME };
    study.model = model;
    study.sitePolygon = [];
    study.placement = { ...DEFAULT_PLACEMENT, headingDeg: 23, offsetE: 8.2, offsetN: -3.1, alignment: { kind: 'twoPoint', pairs: [{ local: { e: 1, n: 2 }, target: { lat: 35.6001, lon: 139.6001 } }, { local: { e: -3, n: 4 }, target: { lat: 35.6002, lon: 139.5999 } }], unitScaleM: 0.001, mirror: false, upAxis: 'z', rmsM: 0.08, scaleRatio: 1.002, pivotLatLon: { lat: 35.60005, lon: 139.60009 }, at: '2026-10-04T00:00:00.000Z' } };
    study.points = [{ id: 'pt-1', label: '窓', pos: [1, 1.5, -2], normal: [0, 0, -1], results: [{ dateId: 'winter', dateLabel: '冬至', month: 12, day: 22, hours: 3.5, first: 9, last: 12.5, spans: [[9, 12.5]] }] }];
    const json = serializeProject();
    expect(json.placement.alignment?.kind).toBe('twoPoint');
    expect(json.points[0].results?.[0].hours).toBe(3.5);
    // 別の状態に変えてから戻す
    study.points = [];
    study.placement = { ...DEFAULT_PLACEMENT };
    await applyProject(JSON.parse(JSON.stringify(json)));
    expect(study.points).toHaveLength(1);
    expect(study.points[0].results?.[0].hours).toBe(3.5);
    expect(study.points[0].results?.[0].spans).toEqual([[9, 12.5]]);
    expect(study.placement.alignment?.kind).toBe('twoPoint');
    expect(study.placement.alignment?.pairs).toHaveLength(2);
    expect(study.placement.alignment?.pivotLatLon?.lat).toBeCloseTo(35.60005, 9);
    expect(study.placement.alignment?.unitScaleM).toBe(0.001);
    expect(study.placement.headingDeg).toBe(23);
    // 古い保存データ（alignment 無し）も読める
    const legacy = JSON.parse(JSON.stringify(json));
    delete legacy.placement.alignment;
    legacy.points = [];
    await applyProject(legacy);
    expect(study.placement.alignment).toBeUndefined();
    expect(study.placement.offsetE).toBe(8.2);
    // 壊れた alignment は捨てる
    const broken = JSON.parse(JSON.stringify(json));
    broken.placement.alignment = { kind: 'bogus', pairs: 'x', pivotLatLon: { lat: 'a' } };
    await applyProject(broken);
    expect(study.placement.alignment?.kind).toBeUndefined();
    expect(study.placement.alignment?.pairs).toBeUndefined();
    expect(normDeg(study.placement.headingDeg)).toBe(23);
  });

  it('sanitizePlacement: 文字列・NaN・未知の単位や列挙は既定値に（pivot の行列が NaN になって建物が消えない）', async () => {
    const bad = sanitizePlacement({ unit: 'furlong', customScale: -1, upAxis: 'x', headingDeg: 'abc', offsetE: NaN, offsetN: '3', baseY: Infinity, appearance: 'pink', mirror: 'yes', hiddenObjects: ['a', 1, null] } as unknown as Partial<ModelPlacement>);
    expect(bad).toEqual({ ...DEFAULT_PLACEMENT, hiddenObjects: ['a'] });
    expect(bad.alignment).toBeUndefined();
    // 正しい値はそのまま
    const ok = sanitizePlacement({ unit: 'custom', customScale: 0.3, upAxis: 'y', headingDeg: -12.5, offsetE: 1.25, offsetN: -3, baseY: 0.4, appearance: 'original', mirror: true, hiddenObjects: ['site'] });
    expect(ok).toEqual({ unit: 'custom', customScale: 0.3, upAxis: 'y', headingDeg: -12.5, offsetE: 1.25, offsetN: -3, baseY: 0.4, appearance: 'original', mirror: true, hiddenObjects: ['site'] });
    expect(sanitizePlacement(undefined)).toEqual(DEFAULT_PLACEMENT);
    expect(sanitizePlacement(null)).toEqual(DEFAULT_PLACEMENT);
    expect(sanitizePlacement('x' as unknown as Partial<ModelPlacement>)).toEqual(DEFAULT_PLACEMENT);
    // プロジェクト JSON 経由でも同じ
    study.frame = { ...FRAME };
    const json = serializeProject();
    const broken = JSON.parse(JSON.stringify(json));
    broken.placement = { unit: 'm', headingDeg: '90', offsetE: { e: 1 }, baseY: null, mirror: 1 };
    await applyProject(broken);
    expect(study.placement.unit).toBe('m');
    expect(study.placement.headingDeg).toBe(0);
    expect(study.placement.offsetE).toBe(0);
    expect(study.placement.baseY).toBe(0);
    expect(study.placement.mirror).toBe(false);
    expect(study.placement.hiddenObjects).toEqual([]);
  });
});
