/**
 * 点群の座標 → 敷地の東・北 (m)（周辺建物の ring と同じ: 周辺建物を取得したときのピンが原点、真北が +n）。
 *
 * - 航空レーザ（LAS など）: 平面直角座標系。系の番号は EPSG・WKT から、無ければ敷地がファイルの範囲に入る系を探す。
 *   座標の北（X 軸）と真北のずれ（子午線収差角）も直す。
 * - iPhone の LiDAR スキャン（PLY など）: 座標は端末の任意の原点・向き。上向きの軸を決め、利用者が入れた
 *   ずらし（東・北 m）と回転（度）で敷地に置く。既定はスキャンの原点 = ピン。
 */
import { detectZone, gridConvergenceDeg, toPlaneRect, zoneFromEpsg, zoneFromWkt } from './planeRect';
import type { CloudHeader, RawCloud } from './read';

export type Placement =
  | { kind: 'plane'; zone: number; swapped: boolean; datum: 'JGD2011' | 'JGD2000' | 'Tokyo' | '不明'; convergenceDeg: number; zoneFrom: 'epsg' | 'wkt' | 'guess' }
  | { kind: 'local'; up: 'z' | 'y'; offsetE: number; offsetN: number; rotDeg: number };

export interface LocalPlacement {
  up?: 'z' | 'y';
  offsetE?: number;
  offsetN?: number;
  rotDeg?: number;
}

/** 敷地のまわりの点（東・北・高さ。高さはファイルの値のまま = 標高など） */
export interface SiteCloud {
  count: number;
  e: Float32Array;
  n: Float32Array;
  z: Float32Array;
  cls: Uint8Array | null;
  rgb: Uint8Array | null;
  placement: Placement;
  /** 読んだファイルの形式・点数 */
  header: CloudHeader;
}

/** 経度・緯度の範囲として妥当か（地理座標のままの点群） */
function looksGeographic(b: CloudHeader['bounds']): boolean {
  return b.minX >= 120 && b.maxX <= 155 && b.minY >= 20 && b.maxY <= 46;
}

/** 範囲が数十 km 以上の大きな数（投影座標）か、原点付近の小さな数（スキャンのローカル座標）か */
export function looksProjected(b: CloudHeader['bounds']): boolean {
  const big = Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY));
  return big > 2000;
}

/** 上向きの軸の見当: 範囲がいちばん狭い軸（家と道を撮ったスキャンは高さが最も小さい）。y と z の比較だけ */
export function guessUpAxis(b: CloudHeader['bounds']): 'z' | 'y' {
  const dy = b.maxY - b.minY;
  const dz = b.maxZ - b.minZ;
  return dy < dz * 0.8 ? 'y' : 'z';
}

/**
 * ヘッダから置き方を決める。local を渡すとローカル（スキャン）として置く。
 * 地理座標（経度・緯度のまま）の点群は扱わない（平面直角座標に直して書き出してもらう）。
 */
export function planPlacement(h: CloudHeader, site: { lat: number; lon: number }, local?: LocalPlacement | null): Placement {
  if (local || !looksProjected(h.bounds)) {
    if (looksGeographic(h.bounds)) throw new Error('点群の座標が経度・緯度のままです。平面直角座標系（JGD2011）に変換したファイルを使ってください');
    return { kind: 'local', up: local?.up ?? guessUpAxis(h.bounds), offsetE: local?.offsetE ?? 0, offsetN: local?.offsetN ?? 0, rotDeg: local?.rotDeg ?? 0 };
  }
  const fromCode = (h.epsg ? zoneFromEpsg(h.epsg) : null) ?? (h.wkt ? zoneFromWkt(h.wkt) : null);
  const g = detectZone(site.lat, site.lon, h.bounds, fromCode?.zone);
  if (!g) throw new Error('点群の座標系が分かりません');
  if (g.distance > 3000) {
    const where = fromCode ? `第 ${fromCode.zone} 系` : '平面直角座標系のどの系';
    throw new Error(`点群の範囲が敷地から離れています（${where}で ${(g.distance / 1000).toFixed(1)} km）。敷地を含む区画のファイルか、建設地の座標を確かめてください`);
  }
  return {
    kind: 'plane',
    zone: g.zone,
    swapped: g.swapped,
    datum: fromCode?.datum ?? '不明',
    convergenceDeg: gridConvergenceDeg(site.lat, site.lon, g.zone),
    zoneFrom: h.epsg && fromCode ? 'epsg' : h.wkt && fromCode ? 'wkt' : 'guess',
  };
}

/** ファイルの座標 (x, y, z) → 東・北・高さ の変換 */
export function placementTransform(p: Placement, site: { lat: number; lon: number }): (x: number, y: number, z: number) => { e: number; n: number; h: number } {
  if (p.kind === 'plane') {
    const s = toPlaneRect(site.lat, site.lon, p.zone);
    const g = (p.convergenceDeg * Math.PI) / 180;
    const cg = Math.cos(g);
    const sg = Math.sin(g);
    return (x, y, z) => {
      // ファイル → 座標の東・北（ふつう x = 東）
      const ge = (p.swapped ? y : x) - s.Y;
      const gn = (p.swapped ? x : y) - s.X;
      // 座標の北 → 真北（真北は座標上で東へ γ 回った向き）
      return { e: ge * cg - gn * sg, n: ge * sg + gn * cg, h: z };
    };
  }
  const r = (p.rotDeg * Math.PI) / 180;
  const cr = Math.cos(r);
  const sr = Math.sin(r);
  return (x, y, z) => {
    // y 上向き（右手系: x 右・y 上・z 手前）なら 北 = −z
    const e0 = x;
    const n0 = p.up === 'y' ? -z : y;
    const h = p.up === 'y' ? y : z;
    // 時計回りに rotDeg（真北に対するスキャンの北の向き）
    return { e: e0 * cr + n0 * sr + p.offsetE, n: -e0 * sr + n0 * cr + p.offsetN, h };
  };
}

/** 読む前の絞り込み: 敷地から radius (m) の四角に入る点だけ（ファイルの座標で判定） */
export function siteFilter(p: Placement, site: { lat: number; lon: number }, radius: number): (x: number, y: number) => boolean {
  if (p.kind === 'local') return () => true;
  const s = toPlaneRect(site.lat, site.lon, p.zone);
  const r = radius * 1.05;
  const cx = p.swapped ? s.X : s.Y;
  const cy = p.swapped ? s.Y : s.X;
  return (x, y) => Math.abs(x - cx) <= r && Math.abs(y - cy) <= r;
}

/** 読んだ点を東・北に直し、radius の円の外を落とす */
export function toSiteCloud(raw: RawCloud, p: Placement, site: { lat: number; lon: number }, radius: number): SiteCloud {
  const tf = placementTransform(p, site);
  const e = new Float32Array(raw.count);
  const n = new Float32Array(raw.count);
  const z = new Float32Array(raw.count);
  const cls = raw.cls ? new Uint8Array(raw.count) : null;
  const rgb = raw.rgb ? new Uint8Array(raw.count * 3) : null;
  let k = 0;
  const r2 = radius * radius;
  for (let i = 0; i < raw.count; i++) {
    const q = tf(raw.x[i], raw.y[i], raw.z[i]);
    if (q.e * q.e + q.n * q.n > r2) continue;
    e[k] = q.e;
    n[k] = q.n;
    z[k] = q.h;
    if (cls) cls[k] = raw.cls![i];
    if (rgb) for (let c = 0; c < 3; c++) rgb[k * 3 + c] = raw.rgb![i * 3 + c];
    k++;
  }
  return { count: k, e: e.slice(0, k), n: n.slice(0, k), z: z.slice(0, k), cls: cls ? cls.slice(0, k) : null, rgb: rgb ? rgb.slice(0, k * 3) : null, placement: p, header: raw.header };
}
