/**
 * 測地の純関数（src/sun/geodesy.ts）のテスト。ネットワーク・fixture は使わない。
 * ECEF ↔ 測地の往復精度、glTF 軸 → ECEF 軸、PLATEAU 葉タイルの CESIUM_RTC.center の緯度経度、度矩形の交差・距離
 */
import { describe, expect, it } from 'vitest';
import { WGS84, ecefToGeodetic, geodeticToEcef, gltfToEcefAxes, regionToDegBox, degBoxAround, degBoxIntersects, degBoxDistanceM } from '../src/sun/geodesy';
import { metersPerDegree, toLocal } from '../src/sun/geo';

/** 往復の検算に使う 4 地点（丸の内・名古屋・札幌・那覇） */
const POINTS: [string, number, number][] = [
  ['丸の内', 35.681236, 139.767125],
  ['名古屋', 35.19197, 136.95355],
  ['札幌', 43.06417, 141.34694],
  ['那覇', 26.2124, 127.6809],
];

describe('geodeticToEcef ↔ ecefToGeodetic の往復', () => {
  for (const [name, lat, lon] of POINTS) {
    for (const h of [-100, 0, 63.1, 500, 3000]) {
      it(`${name} h=${h} m: 往復 < 1e-6 m`, () => {
        const [x, y, z] = geodeticToEcef(lat, lon, h);
        const g = ecefToGeodetic(x, y, z);
        const { mLat, mLon } = metersPerDegree(lat);
        expect(Math.abs(g.lat - lat) * mLat).toBeLessThan(1e-6);
        expect(Math.abs(g.lon - lon) * mLon).toBeLessThan(1e-6);
        expect(Math.abs(g.h - h)).toBeLessThan(1e-6);
        // ECEF 側でも往復
        const [x2, y2, z2] = geodeticToEcef(g.lat, g.lon, g.h);
        expect(Math.hypot(x2 - x, y2 - y, z2 - z)).toBeLessThan(1e-6);
      });
    }
  }
  it('赤道・本初子午線の地表 → (a, 0, 0)、北極 → (0, 0, b)', () => {
    const b = WGS84.a * (1 - WGS84.f);
    expect(geodeticToEcef(0, 0, 0)).toEqual([WGS84.a, 0, 0]);
    const [px, py, pz] = geodeticToEcef(90, 0, 0);
    expect(Math.hypot(px, py)).toBeLessThan(1e-6);
    expect(pz).toBeCloseTo(b, 6);
    // 極の真上も壊れない（p ≈ 0 の別扱い）
    const pole = ecefToGeodetic(0, 0, b + 10);
    expect(pole.lat).toBe(90);
    expect(pole.h).toBeCloseTo(10, 6);
    expect(ecefToGeodetic(0, 0, -(b + 10)).lat).toBe(-90);
  });
  it('高さを上げると ECEF の原点距離が同じだけ増える', () => {
    const [x0, y0, z0] = geodeticToEcef(35.2, 136.9, 0);
    const [x1, y1, z1] = geodeticToEcef(35.2, 136.9, 100);
    expect(Math.hypot(x1 - x0, y1 - y0, z1 - z0)).toBeCloseTo(100, 6);
  });
  it('WGS84 の定数: e2 = f(2 − f)', () => {
    expect(WGS84.e2).toBeCloseTo(WGS84.f * (2 - WGS84.f), 12);
  });
});

describe('PLATEAU 葉タイルの CESIUM_RTC.center', () => {
  // 名古屋市東区 LOD2（テクスチャ無し）data0.b3dm の glb JSON extensions.CESIUM_RTC.center（実ファイルから読み取った値）
  const NAGOYA_DATA0_CENTER: [number, number, number] = [-3813487.667500267, 3561919.449808726, 3655328.9361097673];
  it('名古屋 data0 の center → 35.19197, 136.95355, 楕円体高 63.1 m', () => {
    const g = ecefToGeodetic(...NAGOYA_DATA0_CENTER);
    expect(g.lat).toBeCloseTo(35.19197, 5);
    expect(g.lon).toBeCloseTo(136.95355, 5);
    expect(Math.abs(g.h - 63.1)).toBeLessThan(0.1);
    // 逆変換で center に戻る
    const back = geodeticToEcef(g.lat, g.lon, g.h);
    expect(Math.hypot(back[0] - NAGOYA_DATA0_CENTER[0], back[1] - NAGOYA_DATA0_CENTER[1], back[2] - NAGOYA_DATA0_CENTER[2])).toBeLessThan(1e-6);
  });
  it('center + gltfToEcefAxes(東へ 100 m 相当) は経度だけが増える（glTF x = 東）', () => {
    const c = ecefToGeodetic(...NAGOYA_DATA0_CENTER);
    // 名古屋付近の ECEF 東方向の単位ベクトル (−sinλ, cosλ, 0) に沿って 100 m
    const lo = (c.lon * Math.PI) / 180;
    const east: [number, number, number] = [-Math.sin(lo) * 100, Math.cos(lo) * 100, 0];
    // ECEF の東方向は glTF では (x, y, z) = (ex, ez, −ey)
    const [ax, ay, az] = gltfToEcefAxes(east[0], east[2], -east[1]);
    const g = ecefToGeodetic(NAGOYA_DATA0_CENTER[0] + ax, NAGOYA_DATA0_CENTER[1] + ay, NAGOYA_DATA0_CENTER[2] + az);
    const d = toLocal(g.lat, g.lon, c.lat, c.lon);
    expect(d.e).toBeCloseTo(100, 1);
    expect(Math.abs(d.n)).toBeLessThan(0.05);
  });
});

describe('gltfToEcefAxes: glTF y-up → ECEF は (x, −z, y)', () => {
  it('(1, 2, 3) → [1, −3, 2]', () => {
    expect(gltfToEcefAxes(1, 2, 3)).toEqual([1, -3, 2]);
  });
  it('長さを変えない（回転のみ）', () => {
    const v = gltfToEcefAxes(0.3, -4.5, 12);
    expect(Math.hypot(...v)).toBeCloseTo(Math.hypot(0.3, -4.5, 12), 12);
  });
});

describe('度矩形', () => {
  const RAD = Math.PI / 180;
  it('regionToDegBox: 配列（ラジアン 6 要素）と TileRegion の両方を度にする', () => {
    const arr = [136.9 * RAD, 35.1 * RAD, 137.0 * RAD, 35.2 * RAD, 0, 100];
    const b = regionToDegBox(arr);
    expect(b.west).toBeCloseTo(136.9, 9);
    expect(b.south).toBeCloseTo(35.1, 9);
    expect(b.east).toBeCloseTo(137.0, 9);
    expect(b.north).toBeCloseTo(35.2, 9);
    const b2 = regionToDegBox({ west: arr[0], south: arr[1], east: arr[2], north: arr[3], minH: 0, maxH: 100 });
    expect(b2).toEqual(b);
  });
  it('regionToDegBox: 短い配列・数値でない要素は日本語のエラー', () => {
    expect(() => regionToDegBox([1, 2, 3])).toThrow(/region の形が不正/);
    expect(() => regionToDegBox([1, 2, Number.NaN, 4, 0, 0])).toThrow(/region の形が不正/);
  });
  it('degBoxAround: metersPerDegree で m → 度（四隅を toLocal で戻すと ±radius）', () => {
    const lat = 35.6019;
    const lon = 139.6736;
    const r = 300;
    const b = degBoxAround(lat, lon, r);
    const { mLat, mLon } = metersPerDegree(lat);
    expect((b.east - b.west) * mLon).toBeCloseTo(2 * r, 6);
    expect((b.north - b.south) * mLat).toBeCloseTo(2 * r, 6);
    const ne = toLocal(b.north, b.east, lat, lon);
    expect(ne.e).toBeCloseTo(r, 6);
    expect(ne.n).toBeCloseTo(r, 6);
    const sw = toLocal(b.south, b.west, lat, lon);
    expect(sw.e).toBeCloseTo(-r, 6);
    expect(sw.n).toBeCloseTo(-r, 6);
    // 中心は矩形の中
    expect(degBoxDistanceM(lat, lon, b)).toBe(0);
  });
  it('degBoxIntersects: 重なる・接する → true、離れている → false', () => {
    const a = { west: 136.9, south: 35.1, east: 137.0, north: 35.2 };
    expect(degBoxIntersects(a, { west: 136.95, south: 35.15, east: 137.1, north: 35.3 })).toBe(true);
    expect(degBoxIntersects(a, { west: 136.92, south: 35.12, east: 136.93, north: 35.13 })).toBe(true); // 内包
    expect(degBoxIntersects(a, { west: 137.0, south: 35.2, east: 137.1, north: 35.3 })).toBe(true); // 角で接する
    expect(degBoxIntersects(a, { west: 137.01, south: 35.1, east: 137.1, north: 35.2 })).toBe(false); // 東にずれ
    expect(degBoxIntersects(a, { west: 136.9, south: 35.21, east: 137.0, north: 35.3 })).toBe(false); // 北にずれ
    // 対称
    const c = { west: 136.0, south: 34.0, east: 136.5, north: 34.5 };
    expect(degBoxIntersects(a, c)).toBe(degBoxIntersects(c, a));
  });
  it('degBoxDistanceM: 内側（辺上を含む）は 0、外側は正で toLocal の距離と一致', () => {
    const lat = 35.19;
    const lon = 136.95;
    const box = degBoxAround(lat, lon, 200);
    expect(degBoxDistanceM(lat, lon, box)).toBe(0);
    expect(degBoxDistanceM(box.north, box.east, box)).toBe(0);
    expect(degBoxDistanceM(box.south, lon, box)).toBe(0);
    const { mLat, mLon } = metersPerDegree(lat);
    // 東に 200 + 150 m → 矩形の東辺から 150 m
    expect(degBoxDistanceM(lat, lon + 350 / mLon, box)).toBeCloseTo(150, 3);
    // 北に 200 + 80 m
    expect(degBoxDistanceM(lat + 280 / mLat, lon, box)).toBeCloseTo(80, 3);
    // 南西の角の外（斜め）: 角からのユークリッド距離
    const pLat = box.south - 30 / mLat;
    const pLon = box.west - 40 / mLon;
    expect(degBoxDistanceM(pLat, pLon, box)).toBeCloseTo(50, 2);
    // 外側は必ず正
    expect(degBoxDistanceM(lat, box.east + 1e-6, box)).toBeGreaterThan(0);
  });
  it('degBoxDistanceM: 矩形までの距離 ≤ 半径 の判定（建物の _xmin.._ymax 矩形の keep 判定に使う）', () => {
    const pin = { lat: 35.6019, lon: 139.6736 };
    const { mLat, mLon } = metersPerDegree(pin.lat);
    // 足元矩形の西辺が半径 300 m の少し内側に掛かる建物（中心は 305 m 先）
    const bldg = { west: pin.lon + 295 / mLon, east: pin.lon + 315 / mLon, south: pin.lat - 5 / mLat, north: pin.lat + 5 / mLat };
    expect(degBoxDistanceM(pin.lat, pin.lon, bldg)).toBeLessThanOrEqual(300);
    // 完全に外
    const far = { west: pin.lon + 301 / mLon, east: pin.lon + 320 / mLon, south: pin.lat - 5 / mLat, north: pin.lat + 5 / mLat };
    expect(degBoxDistanceM(pin.lat, pin.lon, far)).toBeGreaterThan(300);
  });
});
