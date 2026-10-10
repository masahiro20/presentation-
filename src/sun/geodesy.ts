/**
 * 測地の純関数: ECEF ↔ 測地（WGS84）、glTF 軸 → ECEF 軸、度矩形の交差・距離。
 *
 * 水平の局所化は既存 toLocal / frameToLocal（等距円筒近似）に揃える。ENU 回転は使わない
 * （航空写真・DEM・敷地・GSI 建物と同じ近似。300 m で cm 級）。
 * 度矩形の m ↔ 度は metersPerDegree（src/sun/geo.ts）で、degBoxAround / degBoxDistanceM も同じ換算を使う。
 * 仕様: scratchpad/plateau-spec.md §2.2
 */
import { metersPerDegree } from './geo';
import type { GeoBox, TileRegion } from './plateau/types';

export const WGS84 = { a: 6378137, f: 1 / 298.257223563, e2: 0.00669437999014 } as const;

/** 度・度・楕円体高 m */
export interface Geodetic {
  lat: number;
  lon: number;
  h: number;
}

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
/** 短半径 b = a(1 − f) */
const WGS84_B = WGS84.a * (1 - WGS84.f);

/**
 * ECEF (m) → 測地（WGS84）。緯度を反復 8 回で収束させる（地表付近は 3 回で 1e-9 rad に収束する。往復 < 1e-6 m）。
 * 3D Tiles の CESIUM_RTC.center や、center + 頂点 の絶対座標を緯度経度・楕円体高にする。
 */
export function ecefToGeodetic(x: number, y: number, z: number): Geodetic {
  const { a, e2 } = WGS84;
  const p = Math.hypot(x, y);
  const lon = p === 0 ? 0 : Math.atan2(y, x) * DEG;
  // 極の真上（p ≈ 0）は cos(lat) で割れないので別扱い
  if (p < 1e-9) return { lat: z >= 0 ? 90 : -90, lon, h: Math.abs(z) - WGS84_B };
  let lat = Math.atan2(z, p * (1 - e2));
  let h = 0;
  for (let i = 0; i < 8; i++) {
    const s = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * s * s);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(z, p * (1 - (e2 * N) / (N + h)));
  }
  return { lat: lat * DEG, lon, h };
}

/** 測地（度・度・楕円体高 m）→ ECEF (m) */
export function geodeticToEcef(lat: number, lon: number, h: number): [number, number, number] {
  const { a, e2 } = WGS84;
  const la = lat * RAD;
  const lo = lon * RAD;
  const s = Math.sin(la);
  const c = Math.cos(la);
  const N = a / Math.sqrt(1 - e2 * s * s);
  return [(N + h) * c * Math.cos(lo), (N + h) * c * Math.sin(lo), (N * (1 - e2) + h) * s];
}

/** glTF (x, y, z)（y-up）→ ECEF の軸 = (x, −z, y)（実測: batchTable の _xmin.._ymax と 0.000 m で一致） */
export function gltfToEcefAxes(x: number, y: number, z: number): [number, number, number] {
  return [x, -z, y];
}

/** 3D Tiles の region（ラジアン [west, south, east, north, minH, maxH]）→ 度の矩形 */
export function regionToDegBox(r: TileRegion | readonly number[]): GeoBox {
  if (Array.isArray(r)) {
    const a = r as readonly number[];
    if (a.length < 4 || a.slice(0, 4).some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error(`region の形が不正です: ${JSON.stringify(r)}`);
    }
    return { west: a[0] * DEG, south: a[1] * DEG, east: a[2] * DEG, north: a[3] * DEG };
  }
  const t = r as TileRegion;
  return { west: t.west * DEG, south: t.south * DEG, east: t.east * DEG, north: t.north * DEG };
}

/** 中心から半径 radiusM の度矩形（metersPerDegree（src/sun/geo.ts）で m → 度。toLocal と同じ換算） */
export function degBoxAround(lat: number, lon: number, radiusM: number): GeoBox {
  const { mLat, mLon } = metersPerDegree(lat);
  const dLat = radiusM / mLat;
  const dLon = radiusM / mLon;
  return { west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat };
}

/** 度矩形どうしの交差（辺で接する場合も交差とみなす） */
export function degBoxIntersects(a: GeoBox, b: GeoBox): boolean {
  return a.west <= b.east && b.west <= a.east && a.south <= b.north && b.south <= a.north;
}

/**
 * 点 → 度矩形の最短距離 [m]（等距円筒。内側（辺上を含む）なら 0）。
 * 度 → m の換算は点の緯度の metersPerDegree（toLocal / frameToLocal と同じ近似）
 */
export function degBoxDistanceM(lat: number, lon: number, box: GeoBox): number {
  const { mLat, mLon } = metersPerDegree(lat);
  const dE = Math.max(box.west - lon, 0, lon - box.east) * mLon;
  const dN = Math.max(box.south - lat, 0, lat - box.north) * mLat;
  return Math.hypot(dE, dN);
}
