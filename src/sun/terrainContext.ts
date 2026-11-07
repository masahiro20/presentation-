/**
 * 日照の周辺環境の地形（国土地理院 標高タイル）: 純粋な計算（DOM・THREE を使わない。テストで固定する）
 *  - 敷地のまわりを設計 GL（y = 0）に平らにならし、外へなだらかにつなぐ格子（flattenGrid）
 *  - 遠方（通常の半径の外）の建物のうち、高台にあって敷地から見上げる角度が大きい建物だけ残す判定（farNeighborRelevant）
 *  - 地形の統計（最高・最低・最も高く見える方向）と、右パネル・資料の注記の文
 *
 * 高さの約束: ワールド y = 0 は計画建物の設計 GL（敷地の中の標高 = groundElev）。地形の高さは標高 − groundElev
 */
import { sampleHeight } from '../sunstudy/terrain';
import type { HeightGrid } from '../sunstudy/types';
import type { EN } from './align';

/** 地形（標高の格子）を取る半径 (m)。南の丘・高台の学校など、敷地に影を落とし得る範囲 */
export const TERRAIN_RADIUS_M = 320;
/** 地形を出すときの航空写真の半径 (m)（地形の面に貼る。地形の端まで写真があるように少し広く） */
export const TERRAIN_AERIAL_RADIUS_M = 330;
/** 敷地の縁から、地形の本当の高さにつなぐまでの幅 (m) */
export const TERRAIN_FLAT_BLEND_M = 8;
/** まわりの高低差がこれ未満なら「目立つ高低差なし」（注記の文） */
export const TERRAIN_RELIEF_MIN_M = 3;
/** まわりの高い所がこれ以上なら、周辺建物を遠く（FAR_NEIGHBOR_RADIUS_M）まで取り、高台の建物を残す */
export const TERRAIN_FAR_RELIEF_M = 6;
/** 高台の建物を探す半径 (m)（地形の半径と同じ範囲） */
export const FAR_NEIGHBOR_RADIUS_M = 320;
/** 通常の半径の外の建物を残す条件: 敷地から屋根の最高点を見上げる角度 (度) がこれ以上（冬の朝夕の太陽高度に相当） */
export const FAR_NEIGHBOR_MIN_DEG = 4;
/** 敷地の高低差の設定（道路・隣地）が地形より優先される範囲 (m)（敷地の縁からの距離） */
export const SITE_LEVELS_PRIORITY_M = 30;
/** 統計で「見上げる角度」を測る観測者の目の高さ (m)・近すぎる画素は除く距離 (m) */
export const TERRAIN_EYE_M = 1.5;
export const TERRAIN_STATS_MIN_DIST_M = 15;

/** 地形の統計（右パネルの表示・注記・遠方の建物を取るかの判断） */
export interface TerrainStats {
  /** 敷地（設計 GL）の標高 T.P. (m) */
  groundElev: number;
  /** 半径内の最低・最高標高 T.P. (m) と、敷地からの差 (m) */
  min: number;
  max: number;
  relMin: number;
  relMax: number;
  /** 敷地から最も高く見上げる地形: 角度 (度)・方位 (度、真北から時計回り)・距離 (m)。無ければ 0 */
  maxAngleDeg: number;
  maxAngleAz: number;
  maxAngleDist: number;
  /** 最も高い所の方位 (度)・距離 (m) */
  maxAz: number;
  maxDist: number;
  /** 出典 ('dem5a' など) と解像度 (m) */
  source: string;
  resolution: number;
  /** 統計を取った半径 (m) */
  radiusM: number;
}

/** 点 p から凸多角形 poly の外側への距離 (m)。内側なら 0。頂点の並びはどちら向きでもよい */
export function distanceOutsideConvex(p: EN, poly: EN[]): number {
  if (poly.length < 3) return 0;
  // 向き（符号付き面積）で内外の判定の向きを決める
  let area = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) area += (poly[j].e - poly[0].e) * (poly[i].n - poly[0].n) - (poly[i].e - poly[0].e) * (poly[j].n - poly[0].n);
  const ccw = area > 0;
  let inside = true;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const ex = b.e - a.e;
    const en = b.n - a.n;
    const cross = ex * (p.n - a.n) - en * (p.e - a.e);
    if (ccw ? cross < 0 : cross > 0) inside = false;
    // 線分までの距離
    const len2 = ex * ex + en * en;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.e - a.e) * ex + (p.n - a.n) * en) / len2)) : 0;
    const d = Math.hypot(p.e - (a.e + ex * t), p.n - (a.n + en * t));
    if (d < best) best = d;
  }
  return inside ? 0 : best;
}

/** 多角形（e/n）の中と縁の標高の中央値（設計 GL の標高 = 建物が建つ地面の高さ）。有効値が無ければ 0 */
export function groundElevOfRing(g: HeightGrid, ring: EN[]): number {
  if (ring.length < 3) {
    const h = sampleHeight(g, 0, 0);
    return h === h ? h : 0;
  }
  const vals: number[] = [];
  const take = (e: number, n: number) => {
    const h = sampleHeight(g, e, n);
    if (h === h) vals.push(h);
  };
  let ce = 0;
  let cn = 0;
  for (const p of ring) {
    ce += p.e / ring.length;
    cn += p.n / ring.length;
  }
  take(ce, cn);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    take(a.e, a.n);
    take((a.e + b.e) / 2, (a.n + b.n) / 2);
    take((a.e + ce) / 2, (a.n + cn) / 2);
  }
  if (!vals.length) return 0;
  vals.sort((x, y) => x - y);
  const m = vals.length >> 1;
  return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
}

/**
 * 敷地のまわりを平らにならした格子（新しい配列。元の格子は変えない）。
 * flatRing の中は groundElev、縁から blendM の幅で本当の標高へなだらか（smoothstep）につなぐ。無効値（NaN）はそのまま
 */
export function flattenGrid(g: HeightGrid, flatRing: EN[], groundElev: number, blendM = TERRAIN_FLAT_BLEND_M): HeightGrid {
  const values = new Float32Array(g.values);
  const out: HeightGrid = { ...g, values };
  if (flatRing.length < 3 || !(g.nx >= 1 && g.ny >= 1)) return out;
  const ge = Number.isFinite(groundElev) ? groundElev : 0;
  const dx = (g.east - g.west) / g.nx;
  const dy = (g.north - g.south) / g.ny;
  const blend = Math.max(0.01, blendM);
  // 平らにする範囲の外接枡（この外は触らない）
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const p of flatRing) {
    if (p.e < minE) minE = p.e;
    if (p.e > maxE) maxE = p.e;
    if (p.n < minN) minN = p.n;
    if (p.n > maxN) maxN = p.n;
  }
  const c0 = Math.max(0, Math.floor((minE - blend - g.west) / dx));
  const c1 = Math.min(g.nx - 1, Math.ceil((maxE + blend - g.west) / dx));
  const r0 = Math.max(0, Math.floor((g.north - (maxN + blend)) / dy));
  const r1 = Math.min(g.ny - 1, Math.ceil((g.north - (minN - blend)) / dy));
  for (let r = r0; r <= r1; r++) {
    const n = g.north - (r + 0.5) * dy;
    for (let c = c0; c <= c1; c++) {
      const k = r * g.nx + c;
      const h = values[k];
      if (h !== h) continue;
      const e = g.west + (c + 0.5) * dx;
      const d = distanceOutsideConvex({ e, n }, flatRing);
      if (d >= blend) continue;
      const t = d / blend;
      const s = t * t * (3 - 2 * t);
      values[k] = ge + (h - ge) * s;
    }
  }
  return out;
}

/**
 * 格子をピンのまわり ±radiusM に切り出す（タイル単位で取った格子は半径より大きく、航空写真の外まで広がる）。
 * skirtDrop > 0 なら、いちばん外の 1 画素を（その画素の値 − skirtDrop）にして裾を作る（地形の端が宙に浮いて見えないように）。
 * 新しい配列を返し、元の格子は変えない。半径が格子より大きければ切らない
 */
export function cropGrid(g: HeightGrid, radiusM: number, skirtDrop = 0): HeightGrid {
  const { nx, ny } = g;
  if (!(nx >= 2 && ny >= 2) || g.values.length < nx * ny) return { ...g, values: new Float32Array(g.values) };
  const dx = (g.east - g.west) / nx;
  const dy = (g.north - g.south) / ny;
  const r = Math.abs(radiusM);
  const c0 = Math.max(0, Math.floor((-r - g.west) / dx));
  const c1 = Math.min(nx - 1, Math.ceil((r - g.west) / dx) - 1);
  const r0 = Math.max(0, Math.floor((g.north - r) / dy));
  const r1 = Math.min(ny - 1, Math.ceil((g.north + r) / dy) - 1);
  const cols = Math.max(2, c1 - c0 + 1);
  const rows = Math.max(2, r1 - r0 + 1);
  const values = new Float32Array(cols * rows);
  for (let rr = 0; rr < rows; rr++) {
    const src = (r0 + rr) * nx + c0;
    values.set(g.values.subarray(src, src + cols), rr * cols);
  }
  if (skirtDrop > 0) {
    const drop = (k: number) => {
      const v = values[k];
      if (v === v) values[k] = v - skirtDrop;
    };
    for (let c = 0; c < cols; c++) {
      drop(c);
      drop((rows - 1) * cols + c);
    }
    for (let rr = 1; rr < rows - 1; rr++) {
      drop(rr * cols);
      drop(rr * cols + cols - 1);
    }
  }
  return { ...g, west: g.west + c0 * dx, east: g.west + (c1 + 1) * dx, north: g.north - r0 * dy, south: g.north - (r1 + 1) * dy, nx: cols, ny: rows, values };
}

/** 多角形を重心から外へ m だけ広げる（長方形・凸に近い輪郭向け） */
export function grownRing(ring: EN[], m: number): EN[] {
  if (!ring.length) return ring;
  let ce = 0;
  let cn = 0;
  for (const p of ring) {
    ce += p.e / ring.length;
    cn += p.n / ring.length;
  }
  return ring.map((p) => {
    const dx = p.e - ce;
    const dy = p.n - cn;
    const d = Math.hypot(dx, dy) || 1;
    return { e: p.e + (dx / d) * m * Math.SQRT2, n: p.n + (dy / d) * m * Math.SQRT2 };
  });
}

/** 格子の統計: 半径 radiusM 内の最低・最高と、敷地（目の高さ TERRAIN_EYE_M）から最も高く見上げる方向 */
export function terrainStatsOf(g: HeightGrid, groundElev: number, radiusM = TERRAIN_RADIUS_M): TerrainStats {
  const ge = Number.isFinite(groundElev) ? groundElev : 0;
  const out: TerrainStats = { groundElev: ge, min: ge, max: ge, relMin: 0, relMax: 0, maxAngleDeg: 0, maxAngleAz: 0, maxAngleDist: 0, maxAz: 0, maxDist: 0, source: g.source, resolution: g.resolution, radiusM };
  if (!(g.nx >= 1 && g.ny >= 1) || g.values.length < g.nx * g.ny) return out;
  const dx = (g.east - g.west) / g.nx;
  const dy = (g.north - g.south) / g.ny;
  const r2 = radiusM * radiusM;
  const minD2 = TERRAIN_STATS_MIN_DIST_M * TERRAIN_STATS_MIN_DIST_M;
  const eye = ge + TERRAIN_EYE_M;
  const DEG = 180 / Math.PI;
  let min = Infinity;
  let max = -Infinity;
  let maxAz = 0;
  let maxDist = 0;
  let bestTan = 0;
  let bestAz = 0;
  let bestDist = 0;
  for (let r = 0; r < g.ny; r++) {
    const n = g.north - (r + 0.5) * dy;
    const base = r * g.nx;
    for (let c = 0; c < g.nx; c++) {
      const h = g.values[base + c];
      if (h !== h) continue;
      const e = g.west + (c + 0.5) * dx;
      const d2 = e * e + n * n;
      if (d2 > r2) continue;
      if (h < min) min = h;
      if (h > max) {
        max = h;
        maxAz = (Math.atan2(e, n) * DEG + 360) % 360;
        maxDist = Math.sqrt(d2);
      }
      if (d2 < minD2) continue;
      const dist = Math.sqrt(d2);
      const tan = (h - eye) / dist;
      if (tan > bestTan) {
        bestTan = tan;
        bestAz = (Math.atan2(e, n) * DEG + 360) % 360;
        bestDist = dist;
      }
    }
  }
  if (min === Infinity) return out;
  // 「最も高い所」は台地のように同じ高さが広がることがあるので、最高から 0.5 m 以内の画素のうち敷地に最も近い所の方位・距離にする
  let nearD2 = Infinity;
  for (let r = 0; r < g.ny; r++) {
    const n = g.north - (r + 0.5) * dy;
    const base = r * g.nx;
    for (let c = 0; c < g.nx; c++) {
      const h = g.values[base + c];
      if (h !== h || h < max - 0.5) continue;
      const e = g.west + (c + 0.5) * dx;
      const d2 = e * e + n * n;
      if (d2 > r2 || d2 >= nearD2) continue;
      nearD2 = d2;
      maxAz = (Math.atan2(e, n) * DEG + 360) % 360;
      maxDist = Math.sqrt(d2);
    }
  }
  out.min = min;
  out.max = max;
  out.relMin = min - ge;
  out.relMax = max - ge;
  out.maxAz = maxAz;
  out.maxDist = maxDist;
  if (bestTan > 0) {
    out.maxAngleDeg = Math.atan(bestTan) * DEG;
    out.maxAngleAz = bestAz;
    out.maxAngleDist = bestDist;
  }
  return out;
}

/** まわりに目立つ高低差があるか（注記の文・地形の表示の既定） */
export function hasRelief(s: Pick<TerrainStats, 'relMin' | 'relMax'> | null | undefined): boolean {
  return !!s && (s.relMax >= TERRAIN_RELIEF_MIN_M || s.relMin <= -TERRAIN_RELIEF_MIN_M);
}

/** 周辺建物を遠く（FAR_NEIGHBOR_RADIUS_M）まで取るか: 敷地より TERRAIN_FAR_RELIEF_M 以上高い所がある（高台の建物が影を落とし得る） */
export function wantsFarNeighbors(s: Pick<TerrainStats, 'relMax'> | null | undefined): boolean {
  return !!s && s.relMax >= TERRAIN_FAR_RELIEF_M;
}

/**
 * 通常の半径（nearRadius）の外の建物を残すか: 高台にあって、敷地から屋根の最高点（足元の高さ baseRel + 建物の高さ）を
 * 見上げる角度が minDeg 以上。平地の普通の家（7 m・200 m 先 ≈ 2°）は落ち、丘の上の学校（+30 m・12 m・200 m ≈ 12°）は残る
 */
export function farNeighborRelevant(distM: number, baseRelM: number, heightM: number, nearRadius = 110, minDeg = FAR_NEIGHBOR_MIN_DEG): boolean {
  if (distM <= nearRadius) return true;
  const top = Math.max(0, baseRelM) + Math.max(0, heightM);
  return Math.atan2(top, distM) >= (minDeg * Math.PI) / 180;
}

const DIRS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
export function dirName(azDeg: number): string {
  return DIRS[Math.round((((azDeg % 360) + 360) % 360) / 45) % 8];
}

/** 出典の短い名前（'国土地理院 DEM5A（5m メッシュ）' など） */
export function demShortLabel(source: string, resolution?: number): string {
  const up = source.toUpperCase();
  if (source === 'flat') return '標高データなし';
  const res = resolution && Number.isFinite(resolution) ? `${resolution < 2 ? 1 : resolution < 7 ? 5 : 10}m メッシュ` : '';
  return `国土地理院 ${up}${res ? `（${res}）` : ''}`;
}

const signed = (v: number, digits = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;

/** 右パネルの地形の状態（1〜2 文） */
export function terrainStatusText(s: TerrainStats): string {
  const src = demShortLabel(s.source, s.resolution);
  const elev = `敷地の標高 T.P. ${s.groundElev.toFixed(1)} m`;
  if (!hasRelief(s)) return `地形: ${src}。${elev}。まわり ${s.radiusM} m に目立つ高低差はありません（±${TERRAIN_RELIEF_MIN_M} m 以内）`;
  const high = s.relMax >= TERRAIN_RELIEF_MIN_M ? `${dirName(s.maxAz)} ${Math.round(s.maxDist)} m に ${signed(s.relMax)} m の高台` : '';
  const low = s.relMin <= -TERRAIN_RELIEF_MIN_M ? `${signed(s.relMin)} m の低地` : '';
  const angle = s.maxAngleDeg >= 1 ? `。敷地から見上げる角度は最大 ${s.maxAngleDeg.toFixed(1)}°（${dirName(s.maxAngleAz)} ${Math.round(s.maxAngleDist)} m）` : '';
  return `地形: ${src}。${elev}、${[high, low].filter(Boolean).join('・')}${angle}`;
}

/** 折りたたみの見出しの短い印（'高台 +30.5 m' など）。目立つ高低差が無ければ '' */
export function terrainMetaText(s: TerrainStats | null | undefined): string {
  if (!s || !hasRelief(s)) return '';
  return s.relMax >= TERRAIN_RELIEF_MIN_M ? `高台 ${signed(s.relMax)} m` : `低地 ${signed(s.relMin)} m`;
}

/**
 * 資料・解析結果の注記の行。included = 地形を影・解析に入れたか（読み込んで表示している）。
 * 読み込んでいなければ null（行を出さない。従来どおり）
 */
export function terrainDisclosureLine(s: TerrainStats | null | undefined, included: boolean): string | null {
  if (!s) return null;
  const src = demShortLabel(s.source, s.resolution);
  if (!included) return `地形（${src}）は影・解析に入れていません（平らな地面として計算）`;
  if (!hasRelief(s)) return `地形: ${src}。敷地のまわり ${s.radiusM} m に目立つ高低差はありません（±${TERRAIN_RELIEF_MIN_M} m 以内。平らな地面として計算）`;
  const angle = s.maxAngleDeg >= 1 ? `、見上げる角度 最大 ${s.maxAngleDeg.toFixed(1)}°` : '';
  return `地形: ${src}の起伏を影・解析に含めています（敷地のまわり ${s.radiusM} m。${dirName(s.maxAz)} ${Math.round(s.maxDist)} m に ${signed(s.relMax)} m${angle}）`;
}

/** 高台の建物を取り込んだときの注記 */
export function farNeighborsNote(n: number, nearRadius: number, farRadius: number): string {
  return `高台の建物 ${n} 棟（敷地から ${nearRadius}〜${farRadius} m。地形の上にあり、敷地から屋根を見上げる角度が ${FAR_NEIGHBOR_MIN_DEG}° 以上）も取り込みました。`;
}

/** 太陽が遠くの山の陰か（方位ごとの地平線の仰角 elevDeg と比べる。地平線が無ければ false） */
export function sunBehindHorizon(horizon: { elevDeg: ArrayLike<number> } | null | undefined, azDeg: number, elevDeg: number): boolean {
  if (!horizon || elevDeg <= 0) return false;
  const a = ((azDeg % 360) + 360) % 360;
  const i0 = Math.floor(a) % 360;
  const i1 = (i0 + 1) % 360;
  const t = a - Math.floor(a);
  const h = horizon.elevDeg[i0] * (1 - t) + horizon.elevDeg[i1] * t;
  return elevDeg <= h;
}
