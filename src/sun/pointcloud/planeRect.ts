/**
 * 平面直角座標系（国土交通省告示の 19 系。JGD2011 / JGD2000）。航空レーザ測量の点群（LAS）は、ほぼすべてこの座標で配られる。
 *
 * - 緯度・経度 → 平面直角座標（X = 北向き, Y = 東向き [m]）。ガウス・クリューゲル投影の河瀬の式（国土地理院の計算式。GRS80、縮尺係数 0.9999）。
 * - EPSG 番号・WKT から系の番号を読む。番号が分からないファイルは、敷地がファイルの範囲に入る系を探す（detectZone）。
 * - 点群の座標は GIS の慣例で x = 東（告示の Y）, y = 北（告示の X）。逆に入ったファイルもあるので、両方の並びを試す。
 */

/** 各系の原点（緯度・経度、度） */
export const PLANE_RECT_ORIGINS: readonly (readonly [number, number])[] = [
  [33, 129.5],
  [33, 131],
  [36, 132 + 10 / 60],
  [33, 133.5],
  [36, 134 + 20 / 60],
  [36, 136],
  [36, 137 + 10 / 60],
  [36, 138.5],
  [36, 139 + 50 / 60],
  [40, 140 + 50 / 60],
  [44, 140.25],
  [44, 142.25],
  [44, 144.25],
  [26, 142],
  [26, 127.5],
  [26, 124],
  [26, 131],
  [20, 136],
  [26, 154],
];

const GRS80 = { a: 6378137, f: 1 / 298.257222101 };
const M0 = 0.9999;

const n = GRS80.f / (2 - GRS80.f);
const A = (GRS80.a / (1 + n)) * (1 + (n * n) / 4 + (n ** 4) / 64);
const ALPHA = [n / 2 - (2 * n * n) / 3 + (5 * n ** 3) / 16 + (41 * n ** 4) / 180, (13 * n * n) / 48 - (3 * n ** 3) / 5 + (557 * n ** 4) / 1440, (61 * n ** 3) / 240 - (103 * n ** 4) / 140, (49561 * n ** 4) / 161280];
const K = (2 * Math.sqrt(n)) / (1 + n);

function rawXY(latDeg: number, lonDeg: number, lon0Deg: number): { x: number; y: number } {
  const phi = (latDeg * Math.PI) / 180;
  const dl = ((lonDeg - lon0Deg) * Math.PI) / 180;
  const s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - K * Math.atanh(K * s));
  const tb = Math.sqrt(1 + t * t);
  const xi = Math.atan2(t, Math.cos(dl));
  const eta = Math.atanh(Math.sin(dl) / tb);
  let x = xi;
  let y = eta;
  for (let j = 1; j <= 4; j++) {
    x += ALPHA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    y += ALPHA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  return { x: M0 * A * x, y: M0 * A * y };
}

/** 緯度・経度 → zone 系の平面直角座標（X = 北, Y = 東 [m]） */
export function toPlaneRect(lat: number, lon: number, zone: number): { X: number; Y: number } {
  const o = PLANE_RECT_ORIGINS[zone - 1];
  if (!o) throw new Error(`平面直角座標系の番号が範囲外です: ${zone}`);
  const p = rawXY(lat, lon, o[1]);
  const p0 = rawXY(o[0], o[1], o[1]);
  return { X: p.x - p0.x, Y: p.y };
}

/** 真北に対する座標の北（X 軸）の向きの差（子午線収差角、度。東へ回っていれば正） */
export function gridConvergenceDeg(lat: number, lon: number, zone: number): number {
  const a = toPlaneRect(lat, lon, zone);
  const b = toPlaneRect(lat + 0.001, lon, zone);
  // 真北へ進んだときの座標上の向き: 東成分 / 北成分
  return (Math.atan2(b.Y - a.Y, b.X - a.X) * 180) / Math.PI;
}

/** EPSG 番号 → 系の番号（JGD2011: 6669〜6687、JGD2000: 2443〜2461、旧日本測地系: 30161〜30179） */
export function zoneFromEpsg(epsg: number): { zone: number; datum: 'JGD2011' | 'JGD2000' | 'Tokyo' } | null {
  if (epsg >= 6669 && epsg <= 6687) return { zone: epsg - 6668, datum: 'JGD2011' };
  if (epsg >= 2443 && epsg <= 2461) return { zone: epsg - 2442, datum: 'JGD2000' };
  if (epsg >= 30161 && epsg <= 30179) return { zone: epsg - 30160, datum: 'Tokyo' };
  return null;
}

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15, XVI: 16, XVII: 17, XVIII: 18, XIX: 19 };

/** WKT（LAS の OGC WKT VLR・.prj）から系の番号 */
export function zoneFromWkt(wkt: string): { zone: number; datum: 'JGD2011' | 'JGD2000' | 'Tokyo' } | null {
  // PROJCS の AUTHORITY は最後に出る（GEOGCS・単位の AUTHORITY が先に並ぶ）
  const codes = [...wkt.matchAll(/(?:AUTHORITY|ID)\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi)].map((m) => +m[1]);
  for (const c of codes.reverse()) {
    const z = zoneFromEpsg(c);
    if (z) return z;
  }
  const datum = /JGD\s*_?2011|JGD2011/i.test(wkt) ? 'JGD2011' : /JGD\s*_?2000/i.test(wkt) ? 'JGD2000' : /Tokyo/i.test(wkt) ? 'Tokyo' : 'JGD2011';
  const m = wkt.match(/Plane[ _]Rectangular[ _]CS[ _]+([IVX]+)\b/i) ?? wkt.match(/(?:zone|系)\s*_?([IVX]+|\d{1,2})\b/i);
  if (m) {
    const z = /^\d+$/.test(m[1]) ? +m[1] : ROMAN[m[1].toUpperCase()];
    if (z >= 1 && z <= 19) return { zone: z, datum };
  }
  return null;
}

export interface ZoneGuess {
  zone: number;
  /** true: ファイルの x = 北（告示の X）, y = 東。false（ふつう）: x = 東, y = 北 */
  swapped: boolean;
  /** 敷地からファイルの範囲までの距離 (m)。0 = 範囲の中 */
  distance: number;
}

/**
 * 敷地（緯度・経度）がファイルの範囲（x・y の最小最大）に入る系と並びを探す。
 * 候補が複数なら、範囲の中心に近いもの → 系の原点の経度が近いもの（その地域で使う系）の順に選ぶ。
 */
export function detectZone(lat: number, lon: number, bounds: { minX: number; maxX: number; minY: number; maxY: number }, preferZone?: number): ZoneGuess | null {
  const zones = preferZone ? [preferZone] : PLANE_RECT_ORIGINS.map((_, i) => i + 1);
  const cands: (ZoneGuess & { center: number; lonGap: number })[] = [];
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  for (const zone of zones) {
    const p = toPlaneRect(lat, lon, zone);
    for (const swapped of [false, true]) {
      const fx = swapped ? p.X : p.Y;
      const fy = swapped ? p.Y : p.X;
      const dx = Math.max(0, bounds.minX - fx, fx - bounds.maxX);
      const dy = Math.max(0, bounds.minY - fy, fy - bounds.maxY);
      cands.push({ zone, swapped, distance: Math.hypot(dx, dy), center: Math.hypot(fx - cx, fy - cy), lonGap: Math.abs(PLANE_RECT_ORIGINS[zone - 1][1] - lon) });
    }
  }
  cands.sort((a, b) => a.distance - b.distance || a.lonGap - b.lonGap || a.center - b.center);
  const best = cands[0];
  if (!best) return null;
  return { zone: best.zone, swapped: best.swapped, distance: best.distance };
}
