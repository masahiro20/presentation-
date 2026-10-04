/**
 * 正確な位置合わせ（src/sunstudy/alignment.ts・PlacedModel の外形）のテスト。Node 上で DOM 無しに動く。
 * サンプル住宅の --site 変種（scripts/make-sample-3ds.mjs --site）を一時ディレクトリに生成して読み、
 *   外形（壁の高さ帯の断面 vs 全高さ）、敷地オブジェクトの外形、2 点合わせ、敷地の輪郭へのフィット、向き合わせ、
 *   ピンが動いたときの再計算、位置合わせの記録とプロジェクトの往復
 * を確かめる。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFit, dominantAngleDeg, minAreaRect, normDeg, normDeg180, polygonArea } from '../src/sun/align';
import type { RigidFit } from '../src/sun/align';
import { alignmentContextOk, alignmentLabel, describeAlignment, enToLocal, fitToSite, localToEN, orientToSite, reapplyAlignment, sectionOutline, solvePairs, twoPointPlacement } from '../src/sunstudy/alignment';
import { importModelFile, isSiteObjectName, PlacedModel, unitScale } from '../src/sunstudy/importModel';
import { applyProject, serializeProject } from '../src/sunstudy/project';
import { study } from '../src/sunstudy/state';
import { DEFAULT_PLACEMENT, frameFromLocal, frameToLocal } from '../src/sunstudy/types';
import type { AlignmentPair, EN, GeoFrame, ImportedModel, ModelPlacement } from '../src/sunstudy/types';

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
});
