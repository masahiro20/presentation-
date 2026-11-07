/**
 * 日照の地形（src/sun/terrainContext.ts）の純粋な計算と、解析の時刻表への地平線の反映。ネットワーク・DOM を使わない。
 *  - 敷地のまわりを平らにならす格子（中は設計 GL、縁からなだらかに本当の標高へ）
 *  - 高台の遠方の建物だけ残す判定（平地の遠い家は落ちる）
 *  - 統計（最高・見上げる角度）と文言、資料の注記
 *  - sunSamplesForDay: 地平線より低い太陽（山の陰）を除く
 */
import { describe, it, expect } from 'vitest';
import type { HeightGrid } from '../src/sunstudy/types';
import { flatHorizon } from '../src/sunstudy/terrain';
import {
  FAR_NEIGHBOR_MIN_DEG,
  TERRAIN_FLAT_BLEND_M,
  cropGrid,
  distanceOutsideConvex,
  farNeighborRelevant,
  farNeighborsNote,
  flattenGrid,
  groundElevOfRing,
  grownRing,
  hasRelief,
  sunBehindHorizon,
  terrainDisclosureLine,
  terrainMetaText,
  terrainStatsOf,
  terrainStatusText,
  wantsFarNeighbors,
} from '../src/sun/terrainContext';
import { sunSamplesForDay } from '../src/sun/analysis';

/** 画素中心で f(e, n) を評価した格子（行 0 = 北） */
function gridFrom(half: number, nx: number, f: (e: number, n: number) => number, source = 'dem5a'): HeightGrid {
  const values = new Float32Array(nx * nx);
  const d = (2 * half) / nx;
  for (let r = 0; r < nx; r++) for (let c = 0; c < nx; c++) values[r * nx + c] = f(-half + (c + 0.5) * d, half - (r + 0.5) * d);
  return { west: -half, east: half, south: -half, north: half, nx, ny: nx, values, source, resolution: d };
}

/** 可児の地点を模した地形: 標高 112 m の平地、南へ 60 m から上り 150 m 先で +30 m の台地（北は少し低い） */
const kani = (e: number, n: number) => {
  const base = 112 + (n > 0 ? -0.01 * n : 0);
  if (n >= -60) return base;
  const t = Math.min(1, (-n - 60) / 90);
  return base + 30 * t * t * (3 - 2 * t);
};
const SITE = [
  { e: -8, n: -6 },
  { e: 8, n: -6 },
  { e: 8, n: 6 },
  { e: -8, n: 6 },
];

describe('distanceOutsideConvex / grownRing', () => {
  it('中は 0、外は辺・頂点までの距離（どちら向きの頂点の並びでも）', () => {
    expect(distanceOutsideConvex({ e: 0, n: 0 }, SITE)).toBe(0);
    expect(distanceOutsideConvex({ e: 7.9, n: -5.9 }, SITE)).toBe(0);
    expect(distanceOutsideConvex({ e: 0, n: -10 }, SITE)).toBeCloseTo(4, 6);
    expect(distanceOutsideConvex({ e: 12, n: 0 }, SITE)).toBeCloseTo(4, 6);
    expect(distanceOutsideConvex({ e: 11, n: 10 }, SITE)).toBeCloseTo(5, 6);
    expect(distanceOutsideConvex({ e: 11, n: 10 }, [...SITE].reverse())).toBeCloseTo(5, 6);
  });
  it('grownRing は重心から外へ広げる', () => {
    const g = grownRing(SITE, 1.5);
    expect(g[0].e).toBeLessThan(-8);
    expect(g[0].n).toBeLessThan(-6);
    expect(g[2].e).toBeGreaterThan(8);
  });
});

describe('flattenGrid / groundElevOfRing', () => {
  const g = gridFrom(320, 128, kani);
  it('設計 GL の標高は敷地の中の中央値。敷地の中は平ら、縁から TERRAIN_FLAT_BLEND_M で本当の標高へ。元の格子は変えない', () => {
    const ge = groundElevOfRing(g, SITE);
    expect(ge).toBeCloseTo(112, 0);
    const flat = flattenGrid(g, SITE, ge);
    expect(flat.values).not.toBe(g.values);
    const at = (grid: HeightGrid, e: number, n: number) => {
      const d = (grid.east - grid.west) / grid.nx;
      const c = Math.floor((e - grid.west) / d);
      const r = Math.floor((grid.north - n) / d);
      return grid.values[r * grid.nx + c];
    };
    // 中: ちょうど ge
    expect(at(flat, 0, 0)).toBeCloseTo(ge, 5);
    // 遠く（南 150 m）: 元のまま
    expect(at(flat, 0, -150)).toBeCloseTo(at(g, 0, -150), 5);
    expect(at(g, 0, -150)).toBeGreaterThan(ge + 25);
    // 元の格子は書き換えていない
    expect(at(g, 0, 0)).toBeCloseTo(kani(0, 0), 1);
    // つなぎ目: 縁から blend の外は元の値、中間は ge と元の値の間（北側はわずかに低い斜面）
    const far = -6 - TERRAIN_FLAT_BLEND_M - 3;
    expect(at(flat, 0, far)).toBeCloseTo(at(g, 0, far), 5);
  });
  it('なだらか: 縁から外へ向かって単調に本当の標高へ寄る（南の上り）', () => {
    const steep = gridFrom(100, 200, (_e, n) => (n < -10 ? 100 + (-n - 10) * 0.5 : 100));
    const ring = [
      { e: -5, n: -5 },
      { e: 5, n: -5 },
      { e: 5, n: 5 },
      { e: -5, n: 5 },
    ];
    const flat = flattenGrid(steep, ring, 100, 8);
    const d = (steep.east - steep.west) / steep.nx;
    const col = Math.floor((0 - steep.west) / d);
    const rowOf = (n: number) => Math.floor((steep.north - n) / d);
    let prev = -Infinity;
    for (let n = -5.5; n > -20; n -= d) {
      const v = flat.values[rowOf(n) * steep.nx + col];
      expect(v).toBeGreaterThanOrEqual(prev - 1e-4);
      prev = v;
    }
    // 縁 + 8 m より外は元の値
    expect(flat.values[rowOf(-14) * steep.nx + col]).toBeCloseTo(steep.values[rowOf(-14) * steep.nx + col], 5);
  });
});

describe('cropGrid', () => {
  it('±radius に切り出し、範囲・画素数が合う。裾は外周の 1 画素だけ下げる。元の格子は変えない', () => {
    const g = gridFrom(500, 100, (e, n) => 50 + e * 0.01 + n * 0.02);
    const c = cropGrid(g, 330, 25);
    expect(c.west).toBeLessThanOrEqual(-330);
    expect(c.east).toBeGreaterThanOrEqual(330);
    expect(c.west).toBeGreaterThan(-345);
    expect(c.east).toBeLessThan(345);
    expect(c.nx).toBe(Math.round((c.east - c.west) / 10));
    expect(c.ny).toBe(Math.round((c.north - c.south) / 10));
    expect(c.values.length).toBe(c.nx * c.ny);
    // 中の値は元の格子と同じ（同じ地点）
    const d = 10;
    const col = Math.floor((0 - c.west) / d);
    const row = Math.floor((c.north - 0) / d);
    const e0 = c.west + (col + 0.5) * d;
    const n0 = c.north - (row + 0.5) * d;
    expect(c.values[row * c.nx + col]).toBeCloseTo(50 + e0 * 0.01 + n0 * 0.02, 4);
    // 外周は 25 m 低い
    expect(c.values[0]).toBeCloseTo(50 + (c.west + 5) * 0.01 + (c.north - 5) * 0.02 - 25, 4);
    // 右端（東の縁）も 25 m 低く、その内側の画素はそのまま
    expect(c.values[c.nx + c.nx - 1]).toBeCloseTo(50 + (c.east - 5) * 0.01 + (c.north - 15) * 0.02 - 25, 4);
    expect(c.values[c.nx + c.nx - 2]).toBeCloseTo(50 + (c.east - 15) * 0.01 + (c.north - 15) * 0.02, 4);
    // 元は変えない
    expect(g.values[0]).toBeCloseTo(50 + -495 * 0.01 + 495 * 0.02, 4);
    // 半径が格子より大きければ切らない（写しだけ）
    const same = cropGrid(g, 1000);
    expect(same.nx).toBe(100);
    expect(same.values).not.toBe(g.values);
  });
});

describe('terrainStatsOf / 文言', () => {
  const g = gridFrom(320, 128, kani);
  const ge = groundElevOfRing(g, SITE);
  const s = terrainStatsOf(g, ge, 320);
  it('最高は南の台地（+30 m）、見上げる角度は 10° 前後で南', () => {
    expect(s.groundElev).toBeCloseTo(112, 0);
    expect(s.relMax).toBeGreaterThan(28);
    expect(s.relMax).toBeLessThan(31);
    expect(s.relMin).toBeLessThan(0);
    expect(s.relMin).toBeGreaterThan(-4);
    expect(Math.abs(s.maxAz - 180)).toBeLessThanOrEqual(45);
    expect(s.maxAngleDeg).toBeGreaterThan(8);
    expect(s.maxAngleDeg).toBeLessThan(14);
    expect(Math.abs(s.maxAngleAz - 180)).toBeLessThanOrEqual(30);
    expect(hasRelief(s)).toBe(true);
    expect(wantsFarNeighbors(s)).toBe(true);
    expect(terrainMetaText(s)).toMatch(/^高台 \+(29|30)\.\d m$/);
    const text = terrainStatusText(s);
    expect(text).toContain('国土地理院 DEM5A（5m メッシュ）');
    expect(text).toContain('敷地の標高 T.P. 112.0 m');
    expect(text).toMatch(/南\S* \d+ m に \+(29|30)\.\d m の高台/);
    expect(text).toMatch(/見上げる角度は最大 \d+\.\d°/);
    expect(terrainDisclosureLine(s, true)).toMatch(/^地形: 国土地理院 DEM5A（5m メッシュ）の起伏を影・解析に含めています（敷地のまわり 320 m。南\S* \d+ m に \+(29|30)\.\d m、見上げる角度 最大 \d+\.\d°）$/);
    expect(terrainDisclosureLine(s, false)).toBe('地形（国土地理院 DEM5A（5m メッシュ））は影・解析に入れていません（平らな地面として計算）');
    expect(terrainDisclosureLine(null, true)).toBeNull();
  });
  it('平地: 目立つ高低差なし（遠くまで取らない・注記は平らな地面）', () => {
    const flatG = gridFrom(320, 64, (e) => 20 + e * 0.002);
    const st = terrainStatsOf(flatG, 20, 320);
    expect(hasRelief(st)).toBe(false);
    expect(wantsFarNeighbors(st)).toBe(false);
    expect(terrainMetaText(st)).toBe('');
    expect(terrainStatusText(st)).toContain('目立つ高低差はありません');
    expect(terrainDisclosureLine(st, true)).toContain('平らな地面として計算');
  });
});

describe('farNeighborRelevant: 高台の建物だけ残す', () => {
  it('通常の半径の中は常に残す。外は見上げる角度が 4° 以上のとき', () => {
    expect(farNeighborRelevant(50, 0, 7)).toBe(true);
    // 平地の普通の家（7 m）200 m 先: 2° → 落ちる
    expect(farNeighborRelevant(200, 0, 7)).toBe(false);
    // 丘の上の学校（+30 m の台地・高さ 12 m）200 m 先: 11.9° → 残る
    expect(farNeighborRelevant(200, 30, 12)).toBe(true);
    // 境目: tan(4°) ≈ 0.0699。150 m 先で 10.5 m → 4.0°
    expect(farNeighborRelevant(150, 3.5, 7)).toBe(true);
    expect(farNeighborRelevant(150, 2.5, 7)).toBe(false);
    // 低地の建物（足元がマイナス）は高さだけで判定
    expect(farNeighborRelevant(150, -10, 7)).toBe(false);
    expect(FAR_NEIGHBOR_MIN_DEG).toBe(4);
    expect(farNeighborsNote(3, 110, 320)).toBe('高台の建物 3 棟（敷地から 110〜320 m。地形の上にあり、敷地から屋根を見上げる角度が 4° 以上）も取り込みました。');
  });
});

describe('遠方の地平線（山の陰）', () => {
  const day = { year: 2025, month: 12, day: 22, lat: 35.416, lon: 137.04, northAngleDeg: 0 };
  it('sunBehindHorizon: その方位の仰角以下なら陰。地平線が無ければ false', () => {
    const hz = flatHorizon(10, 'dem10b');
    hz.elevDeg.fill(0);
    for (let a = 150; a < 210; a++) hz.elevDeg[a] = 12;
    expect(sunBehindHorizon(hz, 180, 10)).toBe(true);
    expect(sunBehindHorizon(hz, 180, 13)).toBe(false);
    expect(sunBehindHorizon(hz, 90, 5)).toBe(false);
    expect(sunBehindHorizon(null, 180, 5)).toBe(false);
    expect(sunBehindHorizon(hz, 180, 0)).toBe(false);
  });
  it('sunSamplesForDay: 南の地平線が 20° なら冬至の昼前後だけ残る（朝夕は山の陰）。地平線なしなら日の出から日の入まで', () => {
    const all = sunSamplesForDay(day, { stepMin: 30, minElev: 0.5, centered: false });
    const hz = flatHorizon(10, 'dem10b');
    for (let a = 120; a <= 240; a++) hz.elevDeg[a] = 20;
    const cut = sunSamplesForDay(day, { stepMin: 30, minElev: 0.5, centered: false, horizon: hz });
    expect(all.length).toBeGreaterThan(cut.length);
    expect(cut.length).toBeGreaterThan(0);
    for (const s of cut) expect(s.elev).toBeGreaterThan(20);
    // 残った時刻はすべて元の時刻表にある
    const hs = new Set(all.map((s) => s.h));
    for (const s of cut) expect(hs.has(s.h)).toBe(true);
    // 平らな地平線（全部 0）は何も除かない
    expect(sunSamplesForDay(day, { stepMin: 30, minElev: 0.5, centered: false, horizon: flatHorizon() }).length).toBe(all.length);
  });
});
