/**
 * 地形（terrain.ts）の純粋関数のテスト。ネットワーク・DOM を使わない。
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
  DEM_MAX_TILES,
  DEM_TILE,
  buildTerrainMesh,
  countNaN,
  coveringRange,
  createMosaic,
  decodeDemPixel,
  demTileRange,
  demTileUrl,
  DEM_SOURCES,
  fillFromCoarser,
  fillUncovered,
  flatGrid,
  flatHorizon,
  gridStats,
  horizonElevation,
  horizonFromGrid,
  minHeightInRing,
  mosaicToGrid,
  sampleHeight,
  terrainGridSize,
  tileCount,
  writeTile,
  type DemMosaic,
  type HorizonProfile,
} from '../src/sunstudy/terrain';
import type { HeightGrid } from '../src/sunstudy/types';

/** 画素中心で f(e, n) を評価した格子（行 0 = 北） */
function gridFrom(west: number, east: number, south: number, north: number, nx: number, ny: number, f: (e: number, n: number) => number, source = 'test'): HeightGrid {
  const values = new Float32Array(nx * ny);
  const dx = (east - west) / nx;
  const dy = (north - south) / ny;
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) values[r * nx + c] = f(west + (c + 0.5) * dx, north - (r + 0.5) * dy);
  return { west, east, south, north, nx, ny, values, source, resolution: dx };
}

/** 4×4、west −2 … east 2（画素中心 −1.5, −0.5, 0.5, 1.5）、値 = 10 + 2e + 3n（線形なのでバイリニアが正確に再現する） */
const lin = (e: number, n: number) => 10 + 2 * e + 3 * n;
const grid4 = () => gridFrom(-2, 2, -2, 2, 4, 4, lin);

/** 1 枚の DEM タイルを 1 色で塗った RGBA 画素列 */
function solidTile(r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  const px = new Uint8ClampedArray(DEM_TILE * DEM_TILE * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  }
  return px;
}

// ---------------------------------------------------------------------------

describe('decodeDemPixel', () => {
  it('x = R·65536 + G·256 + B を 0.01 m 単位で読む', () => {
    expect(decodeDemPixel(0, 0, 100)).toBeCloseTo(1.0, 9);
    expect(decodeDemPixel(0, 1, 0)).toBeCloseTo(2.56, 9);
    expect(decodeDemPixel(0, 0, 0)).toBe(0);
    expect(decodeDemPixel(1, 0, 0)).toBeCloseTo(655.36, 9); // 富士山より高いが符号は正
  });
  it('(128,0,0) は無効値 → NaN', () => {
    expect(decodeDemPixel(128, 0, 0)).toBeNaN();
    expect(decodeDemPixel(128, 0, 1)).not.toBeNaN();
  });
  it('x ≥ 2^23 は負の標高（2 の補数）: (255,255,103) → −1.53 m', () => {
    expect(decodeDemPixel(255, 255, 103)).toBeCloseTo(-1.53, 9);
    expect(decodeDemPixel(255, 255, 255)).toBeCloseTo(-0.01, 9);
    expect(decodeDemPixel(128, 0, 1)).toBeCloseTo(-83886.07, 2);
  });
  it('alpha ≠ 255 は NaN', () => {
    expect(decodeDemPixel(0, 0, 100, 0)).toBeNaN();
    expect(decodeDemPixel(0, 0, 100, 254)).toBeNaN();
    expect(decodeDemPixel(0, 0, 100, 255)).toBeCloseTo(1, 9);
  });
});

// ---------------------------------------------------------------------------

describe('sampleHeight（バイリニア・NaN 代替・縁の丸め）', () => {
  it('線形な格子を正確に再現する（画素中心とその間）', () => {
    const g = grid4();
    expect(sampleHeight(g, 0, 0)).toBeCloseTo(10, 5);
    expect(sampleHeight(g, 0.5, -1.5)).toBeCloseTo(lin(0.5, -1.5), 5);
    expect(sampleHeight(g, -1.5, 1.5)).toBeCloseTo(lin(-1.5, 1.5), 5);
    expect(sampleHeight(g, 0.25, -0.75)).toBeCloseTo(lin(0.25, -0.75), 5);
    expect(sampleHeight(g, 1.1, 0.3)).toBeCloseTo(lin(1.1, 0.3), 5);
  });
  it('行 0 = 北: 北端の値は n が大きい側', () => {
    const g = grid4();
    expect(g.values[0]).toBeCloseTo(lin(-1.5, 1.5), 5); // 北西
    expect(g.values[15]).toBeCloseTo(lin(1.5, -1.5), 5); // 南東
    expect(sampleHeight(g, -1.5, 1.5)).toBeGreaterThan(sampleHeight(g, -1.5, -1.5));
  });
  it('範囲外は最も近い縁（画素中心）の値に丸める', () => {
    const g = grid4();
    expect(sampleHeight(g, 100, 100)).toBeCloseTo(lin(1.5, 1.5), 5);
    expect(sampleHeight(g, -100, -100)).toBeCloseTo(lin(-1.5, -1.5), 5);
    expect(sampleHeight(g, 100, 0)).toBeCloseTo(lin(1.5, 0), 5);
    expect(sampleHeight(g, 0, -100)).toBeCloseTo(lin(0, -1.5), 5);
    expect(sampleHeight(g, -1.9, 0)).toBeCloseTo(lin(-1.5, 0), 5); // 縁の画素の外側半分も縁の値
  });
  it('NaN の隅は残りの有効な隅だけで補間する', () => {
    const g = grid4();
    g.values[0] = NaN; // 北西の隅 (−1.5, 1.5)
    // 隅から離れたところは影響なし
    expect(sampleHeight(g, 0.5, -0.5)).toBeCloseTo(lin(0.5, -0.5), 5);
    // 欠けた隅を含む 4 画素の中央: 残り 3 隅の平均
    const v = sampleHeight(g, -1, 1);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeCloseTo((lin(-0.5, 1.5) + lin(-1.5, 0.5) + lin(-0.5, 0.5)) / 3, 5);
    // ちょうど NaN の画素上: 近傍の有効値（隣の値の範囲内）
    const on = sampleHeight(g, -1.5, 1.5);
    expect(Number.isFinite(on)).toBe(true);
    expect(on).toBeGreaterThanOrEqual(Math.min(lin(-0.5, 1.5), lin(-1.5, 0.5), lin(-0.5, 0.5)) - 1e-5);
    expect(on).toBeLessThanOrEqual(Math.max(lin(-0.5, 1.5), lin(-1.5, 0.5), lin(-0.5, 0.5)) + 1e-5);
  });
  it('周囲が全部 NaN なら離れた有効値をリング状に探す。全部 NaN なら NaN', () => {
    const g = grid4();
    g.values.fill(NaN);
    g.values[15] = 42; // 南東の隅だけ有効
    expect(sampleHeight(g, -1.5, 1.5)).toBe(42);
    expect(sampleHeight(g, 0, 0)).toBe(42);
    g.values[15] = NaN;
    expect(sampleHeight(g, 0, 0)).toBeNaN();
  });
  it('不正な格子（画素が足りない・0 列）は NaN', () => {
    const g = grid4();
    expect(sampleHeight({ ...g, values: new Float32Array(3) }, 0, 0)).toBeNaN();
    expect(sampleHeight({ ...g, nx: 0 }, 0, 0)).toBeNaN();
  });
  it('1 画素の格子・幅 0 の範囲でも落ちない', () => {
    const g: HeightGrid = { west: 0, east: 0, south: 0, north: 0, nx: 1, ny: 1, values: new Float32Array([7]), source: 'x', resolution: 1 };
    expect(sampleHeight(g, 5, -5)).toBe(7);
  });
});

// ---------------------------------------------------------------------------

describe('flatGrid / gridStats / minHeightInRing', () => {
  it('flatGrid: 2×2 の一定値。半径が不正なら 1 m', () => {
    const g = flatGrid(100, 25);
    expect(g).toMatchObject({ west: -100, east: 100, south: -100, north: 100, nx: 2, ny: 2, source: 'flat', resolution: 100 });
    expect([...g.values]).toEqual([25, 25, 25, 25]);
    expect(sampleHeight(g, 37, -81)).toBe(25);
    expect(sampleHeight(g, 1000, 1000)).toBe(25);
    expect(flatGrid(NaN).west).toBe(-1);
    expect(flatGrid(-50).east).toBe(50);
    expect([...flatGrid(10, NaN).values]).toEqual([0, 0, 0, 0]);
  });
  it('gridStats: ピン ±radius に画素中心が入る範囲の最低・最高と、地盤高との差', () => {
    const g = grid4();
    const s1 = gridStats(g, 10, 1); // 中心 ±0.5 の 4 画素
    expect(s1.min).toBeCloseTo(lin(-0.5, -0.5), 5);
    expect(s1.max).toBeCloseTo(lin(0.5, 0.5), 5);
    expect(s1.relMin).toBeCloseTo(lin(-0.5, -0.5) - 10, 5);
    expect(s1.relMax).toBeCloseTo(lin(0.5, 0.5) - 10, 5);
    const sAll = gridStats(g, 0, 100);
    expect(sAll.min).toBeCloseTo(lin(-1.5, -1.5), 5);
    expect(sAll.max).toBeCloseTo(lin(1.5, 1.5), 5);
    // 半径が小さすぎて画素が入らないときはピンに最も近い画素
    const s0 = gridStats(g, 0, 0.1);
    expect(Number.isFinite(s0.min)).toBe(true);
    expect(s0.min).toBeLessThanOrEqual(s0.max);
    // NaN は無視。全部 NaN なら地盤高
    g.values[5] = NaN;
    expect(Number.isFinite(gridStats(g, 10, 1).min)).toBe(true);
    g.values.fill(NaN);
    expect(gridStats(g, 12.5, 100)).toEqual({ min: 12.5, max: 12.5, relMin: 0, relMax: 0 });
  });
  it('minHeightInRing: 頂点・重心・中点のうち最低。空なら 0、有効値が無ければ 0', () => {
    const g = grid4();
    const ring = [
      { e: 0, n: 0 },
      { e: 1, n: 0 },
      { e: 1, n: 1 },
      { e: 0, n: 1 },
    ];
    expect(minHeightInRing(g, ring)).toBeCloseTo(lin(0, 0), 5);
    const shifted = ring.map((p) => ({ e: p.e - 1, n: p.n - 1 }));
    expect(minHeightInRing(g, shifted)).toBeCloseTo(lin(-1, -1), 5);
    expect(minHeightInRing(g, [])).toBe(0);
    g.values.fill(NaN);
    expect(minHeightInRing(g, ring)).toBe(0);
    // 平地なら一定値
    expect(minHeightInRing(flatGrid(50, 3.5), ring)).toBe(3.5);
  });
});

// ---------------------------------------------------------------------------

describe('タイルの範囲とモザイク', () => {
  it('tileCount / coveringRange', () => {
    expect(tileCount({ z: 15, x0: 4, y0: 6, x1: 5, y1: 7 })).toBe(4);
    expect(coveringRange({ z: 15, x0: 4, y0: 6, x1: 5, y1: 7 }, 14)).toEqual({ z: 14, x0: 2, y0: 3, x1: 2, y1: 3 });
    expect(coveringRange({ z: 15, x0: 4, y0: 6, x1: 5, y1: 7 }, 13)).toEqual({ z: 13, x0: 1, y0: 1, x1: 1, y1: 1 });
    expect(coveringRange({ z: 17, x0: 100, y0: 200, x1: 103, y1: 201 }, 15)).toEqual({ z: 15, x0: 25, y0: 50, x1: 25, y1: 50 });
    expect(coveringRange({ z: 17, x0: 100, y0: 200, x1: 104, y1: 201 }, 15)).toEqual({ z: 15, x0: 25, y0: 50, x1: 26, y1: 50 });
  });
  it('demTileRange: ピンを含み、タイル数は上限以下。半径が大きいほど広い（上限で縮む）', () => {
    const lat = 35.681236;
    const lon = 139.767125;
    const r = demTileRange(lat, lon, 300, 15);
    expect(r.z).toBe(15);
    expect(r.x1).toBeGreaterThanOrEqual(r.x0);
    expect(r.y1).toBeGreaterThanOrEqual(r.y0);
    expect(tileCount(r)).toBeLessThanOrEqual(DEM_MAX_TILES);
    // 中心タイルが範囲に入る（z=15 の東京駅付近: x ≈ 29104, y ≈ 12903）
    const n = 2 ** 15;
    const cx = Math.floor(((lon + 180) / 360) * n);
    const lr = (lat * Math.PI) / 180;
    const cy = Math.floor(((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n);
    expect(cx).toBeGreaterThanOrEqual(r.x0);
    expect(cx).toBeLessThanOrEqual(r.x1);
    expect(cy).toBeGreaterThanOrEqual(r.y0);
    expect(cy).toBeLessThanOrEqual(r.y1);
    const big = demTileRange(lat, lon, 50_000, 17);
    expect(tileCount(big)).toBeLessThanOrEqual(DEM_MAX_TILES);
    expect(tileCount(big)).toBeGreaterThan(tileCount(demTileRange(lat, lon, 10, 17)));
    expect(demTileUrl(DEM_SOURCES[0], 1, 2)).toBe('https://cyberjapandata.gsi.go.jp/xyz/dem1a_png/17/1/2.png');
  });
  it('createMosaic / writeTile: デコードして行 0 = 北に並べる。無効値・alpha ≠ 255 は NaN、tileOk・covered を記録', () => {
    const m = createMosaic({ z: 14, x0: 10, y0: 20, x1: 11, y1: 20 });
    expect(m.nx).toBe(512);
    expect(m.ny).toBe(256);
    expect(m.totalTiles).toBe(2);
    expect(countNaN(m.values)).toBe(512 * 256);
    const px = solidTile(0, 19, 136); // 5000 → 50.00 m
    px[0] = 128;
    px[1] = 0;
    px[2] = 0; // 画素 0: 無効値
    px[7] = 0; // 画素 1: alpha 0
    writeTile(m, 11, 20, px);
    expect(m.tileOk[1]).toBe(1);
    expect(m.tileOk[0]).toBe(0);
    // 右のタイル: 列 256..511
    expect(m.values[256]).toBeNaN();
    expect(m.values[257]).toBeNaN();
    expect(m.values[258]).toBeCloseTo(50, 4);
    expect(m.values[255 * 512 + 511]).toBeCloseTo(50, 4);
    expect(m.values[0]).toBeNaN(); // 左のタイルは未取得
    expect(m.covered[256]).toBe(1);
    expect(m.covered[0]).toBe(0);
    expect(countNaN(m.values)).toBe(256 * 256 + 2);
    expect(() => writeTile(m, 12, 20, px)).toThrow(/範囲外/);
  });
  it('fillFromCoarser: 粗いモザイクを再標本化して NaN だけを埋め、covered を記録する', () => {
    const fine = createMosaic({ z: 15, x0: 0, y0: 0, x1: 0, y1: 0 });
    const coarse = createMosaic(coveringRange(fine, 14));
    expect(coarse).toMatchObject({ z: 14, x0: 0, y0: 0, x1: 0, y1: 0 });
    // 粗い側: 列 c の値 = c × 0.01 m（東へ向かう勾配）
    for (let r = 0; r < coarse.ny; r++) for (let c = 0; c < coarse.nx; c++) coarse.values[r * coarse.nx + c] = c * 0.01;
    coarse.tileOk[0] = 1;
    // 細かい側の一部はすでに値がある → そのまま
    fine.values[5] = 123;
    const remaining = fillFromCoarser(fine, coarse);
    expect(remaining).toBe(0);
    expect(fine.values[5]).toBe(123);
    // 細かいタイル (0,0) は粗いタイルの北西 1/4: 細かい列 c → 粗い画素座標 c/2 − 0.25
    expect(fine.values[0]).toBeCloseTo(0, 5); // −0.25 → 縁に丸めて 0
    expect(fine.values[1]).toBeCloseTo(0.25 * 0.01, 5);
    expect(fine.values[100]).toBeCloseTo(49.75 * 0.01, 5);
    expect(fine.values[255]).toBeCloseTo(127.25 * 0.01, 5);
    // 行方向には一定
    expect(fine.values[200 * 256 + 100]).toBeCloseTo(49.75 * 0.01, 5);
    // covered は粗い側から埋めた画素に付く（もとから値があった画素 5 はそのまま）
    expect(fine.covered[5]).toBe(0);
    expect(fine.covered.filter((v) => v === 1).length).toBe(fine.covered.length - 1);
  });
  it('fillFromCoarser: 粗い側も NaN なら残る。タイルが無ければ covered は付かない', () => {
    const fine = createMosaic({ z: 15, x0: 2, y0: 2, x1: 3, y1: 3 }); // 粗い (1,1) の 1 タイルに対応
    const coarse = createMosaic(coveringRange(fine, 14));
    expect(coarse).toMatchObject({ x0: 1, y0: 1, x1: 1, y1: 1 });
    coarse.values.fill(7);
    // 粗い側の北半分（行 0..127）を NaN に
    for (let k = 0; k < 128 * 256; k++) coarse.values[k] = NaN;
    // タイルは取得できたことにしない（tileOk = 0）
    const remaining = fillFromCoarser(fine, coarse);
    // 細かい側の北半分（行 0..255）が NaN のまま（境界付近の 1 行はバイリニアで埋まりうる）
    expect(remaining).toBeGreaterThan(250 * 512);
    expect(remaining).toBeLessThan(258 * 512);
    expect(fine.values[511 * 512]).toBe(7);
    expect(fine.values[0]).toBeNaN();
    expect(fine.covered.some((v) => v === 1)).toBe(false);
  });
  it('fillUncovered: どのソースにもタイルが無かった画素だけを埋める', () => {
    const m = createMosaic({ z: 14, x0: 0, y0: 0, x1: 0, y1: 0 });
    m.values[0] = 5;
    m.covered[1] = 1; // タイルはあったが無効値 → 残る
    m.covered[2] = 1;
    m.values[2] = 9;
    const remaining = fillUncovered(m, 0);
    expect(remaining).toBe(1);
    expect(m.values[0]).toBe(5);
    expect(m.values[1]).toBeNaN();
    expect(m.values[2]).toBe(9);
    expect(m.values[3]).toBe(0);
    expect(countNaN(m.values)).toBe(1);
    expect(fillUncovered(m, -1)).toBe(1);
    const m2 = createMosaic({ z: 14, x0: 0, y0: 0, x1: 0, y1: 0 });
    expect(fillUncovered(m2, 3)).toBe(0);
    expect(m2.values[12345]).toBe(3);
  });
  it('mosaicToGrid: 範囲は north > south、east > west、ピンを含み、行 0 = 北。values は共有', () => {
    const lat = 35.681236;
    const lon = 139.767125;
    // 東京駅を含む z=14 のタイル
    const n = 2 ** 14;
    const tx = Math.floor(((lon + 180) / 360) * n);
    const lr = (lat * Math.PI) / 180;
    const ty = Math.floor(((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n);
    const m: DemMosaic = createMosaic({ z: 14, x0: tx, y0: ty, x1: tx, y1: ty });
    for (let c = 0; c < m.nx; c++) m.values[c] = 100; // 行 0 = 北 → 100 m
    for (let k = m.nx; k < m.values.length; k++) m.values[k] = 0;
    const g = mosaicToGrid(m, lat, lon, 'dem10b');
    expect(g.source).toBe('dem10b');
    expect(g.nx).toBe(256);
    expect(g.ny).toBe(256);
    expect(g.values).toBe(m.values);
    expect(g.north).toBeGreaterThan(g.south);
    expect(g.east).toBeGreaterThan(g.west);
    expect(g.west).toBeLessThan(0);
    expect(g.east).toBeGreaterThan(0);
    expect(g.south).toBeLessThan(0);
    expect(g.north).toBeGreaterThan(0);
    // z=14・北緯 35.7°: 1 タイル ≈ 2 km、1 画素 ≈ 7.8 m
    expect(g.east - g.west).toBeGreaterThan(1500);
    expect(g.east - g.west).toBeLessThan(2500);
    expect(g.resolution).toBeGreaterThan(5);
    expect(g.resolution).toBeLessThan(12);
    expect(g.resolution).toBeCloseTo((g.east - g.west) / g.nx, 0);
    // 北端のサンプルは行 0 の値（100）、南端は 0
    expect(sampleHeight(g, 0, g.north - 0.1)).toBeCloseTo(100, 3);
    expect(sampleHeight(g, 0, g.south + 0.1)).toBeCloseTo(0, 3);
  });
});

// ---------------------------------------------------------------------------

describe('buildTerrainMesh', () => {
  /** 64×64、±100 m、北へ上がる斜面: h = 50 + 0.1 n */
  const slope = () => gridFrom(-100, 100, -100, 100, 64, 64, (_e, n) => 50 + 0.1 * n, 'dem5a');

  it('terrainGridSize: 頂点数が上限以下になる間引き', () => {
    expect(terrainGridSize(64, 64, 1000)).toEqual({ cols: 23, rows: 23, stride: 3 });
    expect(terrainGridSize(64, 64, 100_000)).toEqual({ cols: 65, rows: 65, stride: 1 });
    const t = terrainGridSize(2048, 2048, 160_000);
    expect(t.cols * t.rows).toBeLessThanOrEqual(160_000);
    expect(t.cols).toBeGreaterThan(300);
    expect(terrainGridSize(1, 1, 1).cols * terrainGridSize(1, 1, 1).rows).toBe(4);
  });

  it('頂点数 ≤ maxVertices、ピン付近の頂点の y = 標高 − groundElev、北の行が最も負の z', () => {
    const g = slope();
    const ge = 47;
    const mesh = buildTerrainMesh(g, ge, { maxVertices: 1000 });
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    expect(pos.count).toBeLessThanOrEqual(1000);
    expect(pos.count).toBe(23 * 23);
    expect(geo.index!.count).toBe(22 * 22 * 6);
    // ピンに最も近い頂点
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const d = Math.hypot(pos.getX(i), pos.getZ(i));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    expect(bestD).toBeLessThan(1e-6);
    const expected = sampleHeight(g, pos.getX(best), -pos.getZ(best)) - ge;
    expect(pos.getY(best)).toBeCloseTo(expected, 4);
    expect(pos.getY(best)).toBeCloseTo(3, 4); // 50 − 47
    // 各頂点が格子のサンプルと一致する
    for (let i = 0; i < pos.count; i += 37) expect(pos.getY(i)).toBeCloseTo(sampleHeight(g, pos.getX(i), -pos.getZ(i)) - ge, 4);
    // 行 0 = 北 = z が最も小さい（−north）。北ほど高い
    let minZ = Infinity;
    for (let i = 0; i < pos.count; i++) minZ = Math.min(minZ, pos.getZ(i));
    expect(minZ).toBeCloseTo(-100, 6);
    for (let i = 0; i < 23; i++) expect(pos.getZ(i)).toBeCloseTo(-100, 6);
    expect(pos.getY(0)).toBeGreaterThan(pos.getY(pos.count - 1));
    expect(pos.getY(0)).toBeCloseTo(50 + 0.1 * (100 - 100 / 64) - ge, 3); // 北端の画素中心 n = 98.4375
    // 列 0 = 西
    expect(pos.getX(0)).toBeCloseTo(-100, 6);
    expect(pos.getX(22)).toBeCloseTo(100, 6);
  });

  it('法線・BVH・bounding sphere・影の設定・userData', () => {
    const g = slope();
    const mesh = buildTerrainMesh(g, 50, { maxVertices: 2000 });
    const geo = mesh.geometry;
    const nrm = geo.getAttribute('normal');
    expect(nrm).toBeDefined();
    expect(nrm.count).toBe(geo.getAttribute('position').count);
    // 上向き（y > 0）で、北へ上がる斜面なので法線は南（+z）へ少し傾く
    let sumZ = 0;
    for (let i = 0; i < nrm.count; i++) {
      expect(nrm.getY(i)).toBeGreaterThan(0.9);
      expect(Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i))).toBeCloseTo(1, 4);
      sumZ += nrm.getZ(i);
    }
    expect(sumZ / nrm.count).toBeGreaterThan(0.05);
    expect(geo.boundsTree).toBeInstanceOf(MeshBVH);
    expect(geo.boundingSphere).not.toBeNull();
    expect(geo.boundingSphere!.radius).toBeGreaterThan(100);
    expect(geo.boundingBox).not.toBeNull();
    expect(geo.boundingBox!.min.x).toBeCloseTo(-100, 6);
    expect(geo.boundingBox!.max.z).toBeCloseTo(100, 6);
    expect(mesh.name).toBe('terrain');
    expect(mesh.receiveShadow).toBe(true);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.userData.terrain).toBe(true);
    expect(mesh.userData.source).toBe('dem5a');
    expect((mesh.material as THREE.MeshStandardMaterial).map).toBeNull();
    // レイキャスト（BVH 経由）で地面に当たる
    const ray = new THREE.Raycaster(new THREE.Vector3(10, 100, -20), new THREE.Vector3(0, -1, 0));
    const hits = ray.intersectObject(mesh);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].point.y).toBeCloseTo(sampleHeight(g, 10, 20) - 50, 1);
  });

  it('平地の格子・NaN を含む格子でも作れる（NaN は 0）', () => {
    const flat = buildTerrainMesh(flatGrid(200, 30), 30, { maxVertices: 100 });
    const p = flat.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) expect(p.getY(i)).toBe(0);
    const g = slope();
    g.values.fill(NaN);
    const m = buildTerrainMesh(g, 0, { maxVertices: 100 });
    const q = m.geometry.getAttribute('position');
    for (let i = 0; i < q.count; i++) expect(q.getY(i)).toBe(0);
    expect(q.count).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------

describe('地平線（horizonFromGrid / horizonElevation）', () => {
  /** ±2010 m、201×201（20 m 画素、画素中心が e = 0・n = 1000 に乗る）。平地 0 m に丘を置く */
  const hillGrid = (hillH: number, hillE = 0, hillN = 1000, base = 0) =>
    gridFrom(-2010, 2010, -2010, 2010, 201, 201, (e, n) => (Math.abs(e - hillE) < 1 && Math.abs(n - hillN) < 1 ? hillH : base), 'dem10b');

  it('1 km 北の 100 m の丘 → elevDeg[0] ≈ atan((100 − 2) / 1000)、南（180°）は 0', () => {
    const p = horizonFromGrid(hillGrid(100), 0);
    const expected = (Math.atan(98 / 1000) * 180) / Math.PI;
    expect(p.elevDeg.length).toBe(360);
    expect(p.elevDeg[0]).toBeCloseTo(expected, 2);
    expect(p.elevDeg[180]).toBe(0);
    expect(p.elevDeg[90]).toBe(0);
    expect(p.elevDeg[1]).toBe(0);
    expect(p.elevDeg[359]).toBe(0);
    expect(p.source).toBe('dem10b');
    expect(p.radiusKm).toBeCloseTo(2.01, 6);
    // 負の仰角（平地より目が高い）は 0 に丸める
    for (let i = 1; i < 360; i++) expect(p.elevDeg[i]).toBe(0);
  });
  it('敷地の標高・観測者の高さを引く。東の丘は 90°、南西は 225° のビン', () => {
    const p = horizonFromGrid(hillGrid(100, 1000, 0, 0), 50);
    expect(p.elevDeg[90]).toBeCloseTo((Math.atan(48 / 1000) * 180) / Math.PI, 2);
    expect(p.elevDeg[0]).toBe(0);
    const sw = horizonFromGrid(hillGrid(300, -1000, -1000, 0), 0, 150, 0);
    const d = Math.hypot(1000, 1000);
    expect(sw.elevDeg[225]).toBeCloseTo((Math.atan(300 / d) * 180) / Math.PI, 2);
    expect(sw.elevDeg[45]).toBe(0);
  });
  it('minDist より近い地形は無視する', () => {
    const near = horizonFromGrid(hillGrid(100, 0, 100), 0); // 100 m 北（既定の 150 m 未満）
    expect(near.elevDeg[0]).toBe(0);
    const near2 = horizonFromGrid(hillGrid(100, 0, 100), 0, 50);
    expect(near2.elevDeg[0]).toBeCloseTo((Math.atan(98 / 100) * 180) / Math.PI, 2);
  });
  it('NaN の画素は無視し、丘が複数なら最大を取る', () => {
    const g = hillGrid(100);
    g.values[50 * 201 + 100] = NaN; // 丘を無効値に
    expect(horizonFromGrid(g, 0).elevDeg[0]).toBe(0);
    const g2 = hillGrid(100);
    g2.values[75 * 201 + 100] = 80; // n = 500 m に 80 m（より急）
    const p = horizonFromGrid(g2, 0);
    expect(p.elevDeg[0]).toBeCloseTo((Math.atan(78 / 500) * 180) / Math.PI, 2);
  });
  it('flatHorizon: すべて 0、source none', () => {
    const f = flatHorizon();
    expect(f.elevDeg.length).toBe(360);
    expect(f.elevDeg.every((v) => v === 0)).toBe(true);
    expect(f.source).toBe('none');
    expect(f.radiusKm).toBe(10);
    expect(flatHorizon(5, 'dem10b')).toMatchObject({ radiusKm: 5, source: 'dem10b' });
  });
  it('horizonElevation: 隣のビンと線形補間、360° で巡回、負の方位も可', () => {
    const p: HorizonProfile = { elevDeg: new Float32Array(360), source: 'test', radiusKm: 10 };
    p.elevDeg[10] = 2;
    p.elevDeg[11] = 4;
    p.elevDeg[359] = 6;
    p.elevDeg[0] = 0;
    expect(horizonElevation(p, 10)).toBe(2);
    expect(horizonElevation(p, 10.5)).toBeCloseTo(3, 6);
    expect(horizonElevation(p, 10.25)).toBeCloseTo(2.5, 6);
    expect(horizonElevation(p, 11)).toBe(4);
    expect(horizonElevation(p, 359.5)).toBeCloseTo(3, 6);
    expect(horizonElevation(p, -0.5)).toBeCloseTo(3, 6);
    expect(horizonElevation(p, 370.5)).toBeCloseTo(3, 6);
    expect(horizonElevation(p, 360)).toBe(0);
    expect(horizonElevation(p, 180)).toBe(0);
  });
});
