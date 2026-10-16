/**
 * 推定の屋根（PLATEAU の LOD1 = 箱形の建物に、屋根の形・軒・棟を推定してかぶせる）。three 非依存の純関数。
 *
 * 住宅地の PLATEAU は建物ごとに 2 つの高さを持つ: 形状の高さ zmax − zmin（点群の中央値。LOD1 の箱の天端）と、実測の最高高さ
 * bldg:measuredHeight（棟）。屋根の形の判定と軒の高さは次の方針（屋根の実形状入りの建物 377 棟との突き合わせ: 棟は実測の最高高さと
 * 実際の棟が中央値の差 0.01 m で一致、中央値は軒と棟のあいだの下から 0.41 の位置、住宅の階高は軒高 ÷ 階数 で 2.7〜2.9 m）:
 *   棟 = 実測の最高高さ。軒 = 中央値から逆算（(中央値 − 0.41 × 棟) ÷ 0.59）し、階数が分かれば階数 × 2.8 m と平均する
 *   形: 住宅 = 寄棟（勾配が急すぎれば片流れ）。共同住宅・店舗・事務所などの中高層 = 陸屋根（屋上のまわりにパラペット）。
 *       木造アパートに多い 2 階以下の小さな共同住宅 = 切妻。棟が中央値と同じ高さ（差 0.4 m 未満）なら屋根なし（箱のまま）
 * 形は推定なので attrs.roofEstimate に印を付け、開示文に「推定の屋根」と出す。利用者は建物ごとに形・向き・軒高・棟高・階数・階高を直せる。
 */
import type { EN, NeighborMesh, PlateauAttrs, PlateauBuilding } from './types';
import { flatMesh, gableMesh, hipMesh, meshFromSpec, shedMesh, type RectLike, type RoofSpec } from './roofSpec';

export { hipMesh as hipRoofMesh };
export type { RoofSpec };

export const ROOF_ESTIMATE = {
  /** 棟と箱の天端（中央値）の差がこれ未満なら屋根が無い（陸屋根）とみなす [m] */
  minRise: 0.4,
  /** 軒の高さの下限 [m] */
  minEave: 2.2,
  /** 勾配の上限（立ち上がり ÷ 水平距離。0.8 = 8 寸） */
  maxPitch: 0.8,
  /** 寄棟・切妻が急すぎて片流れとみなす勾配（立ち上がり ÷ 奥行の半分）*/
  shedPitch: 0.65,
  /** 最小外接長方形の短辺・長辺の範囲 [m] */
  minShort: 3,
  maxShort: 15,
  minLong: 4,
  maxLong: 30,
  /** 足元の面積 ÷ 最小外接長方形の面積 の下限 */
  minFill: 0.9,
  /** 傾いた屋根を付ける棟の高さの上限 [m]（これより高い建物は陸屋根の中高層とみなす） */
  maxRidge: 12,
  /** 階数の上限 */
  maxStoreys: 3,
  /** 中央値が軒と棟のあいだのどこにあるか（下から。実測 0.41。片流れは 0.5） */
  medianPos: 0.41,
  /** 階高の目安 [m]（住宅の軒高 ÷ 階数の中央値 2.7〜2.9） */
  floorH: 2.8,
  /** 共同住宅を陸屋根とみなす階数・足元面積 */
  flatApartmentStoreys: 3,
  flatApartmentArea: 200,
  /** パラペット（棟 − 中央値）として立ち上げる高さの範囲 [m] */
  parapetMin: 0.4,
  parapetMax: 1.5,
} as const;

export type EstimatedRoof = NonNullable<PlateauAttrs['roofEstimate']>;

export interface Rect extends RectLike {}

const round2 = (v: number) => Math.round(v * 100) / 100;

function polygonArea(ring: EN[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.e * b.n - b.e * a.n;
  }
  return Math.abs(s) / 2;
}

function convexHull(points: EN[]): EN[] {
  const p = [...points].sort((a, b) => a.e - b.e || a.n - b.n);
  if (p.length < 3) return p;
  const cross = (o: EN, a: EN, b: EN) => (a.e - o.e) * (b.n - o.n) - (a.n - o.n) * (b.e - o.e);
  const lower: EN[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: EN[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** 最小面積の外接長方形（凸包の各辺の向きで試す）。長手を u にそろえる */
export function minAreaRect(ring: EN[]): Rect | null {
  const hull = convexHull(ring);
  if (hull.length < 3) return null;
  let best: (Rect & { area: number }) | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b.e - a.e, b.n - a.n);
    if (len < 1e-6) continue;
    const ux = (b.e - a.e) / len;
    const uy = (b.n - a.n) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const q of hull) {
      const u = q.e * ux + q.n * uy;
      const v = -q.e * uy + q.n * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const du = maxU - minU;
    const dv = maxV - minV;
    const area = du * dv;
    if (best && area >= best.area) continue;
    const mu = (minU + maxU) / 2;
    const mv = (minV + maxV) / 2;
    const cx = mu * ux - mv * uy;
    const cy = mu * uy + mv * ux;
    best = du >= dv ? { area, cx, cy, ux, uy, long: du, short: dv } : { area, cx, cy, ux: -uy, uy: ux, long: dv, short: du };
  }
  return best;
}

export type UsageClass = 'house' | 'apartment' | 'other' | 'unknown';
export function usageClass(usage: string | undefined): UsageClass {
  if (!usage) return 'unknown';
  if (/共同住宅/.test(usage)) return 'apartment';
  if (/住宅/.test(usage)) return 'house';
  return 'other';
}

/** 軒の高さの推定: 中央値からの逆算（f = 中央値の位置）と、階数があれば 階数 × 階高 との平均 */
export function estimateEave(med: number, ridge: number, storeys: number | undefined, pos: number = ROOF_ESTIMATE.medianPos): number {
  const byMedian = (med - pos * ridge) / (1 - pos);
  const prior = storeys && storeys > 0 ? storeys * ROOF_ESTIMATE.floorH : null;
  return prior == null ? byMedian : (byMedian + prior) / 2;
}

/** 屋根の仕様の既定値（推定）と、傾いた屋根のとき使う最小外接長方形。屋根を付けない建物は null */
export function planRoof(b: PlateauBuilding): { roof: EstimatedRoof; rect: Rect | null } | null {
  const a = b.attrs;
  const lod = a.lod ?? a.datasetLod;
  if (lod >= 2 || b.holes.length > 0) return null;
  const ridge = a.measuredHeight;
  const med = a.zmax - a.zmin;
  if (ridge == null || !Number.isFinite(ridge) || !(med > 0)) return null;
  const R = ROOF_ESTIMATE;
  const gap = ridge - med;
  const area = polygonArea(b.ring);
  const uc = usageClass(a.usage);
  const storeys = a.storeys != null && a.storeys > 0 ? a.storeys : undefined;
  const rect = minAreaRect(b.ring);
  const rectOk = !!rect && rect.short >= R.minShort && rect.short <= R.maxShort && rect.long >= R.minLong && rect.long <= R.maxLong && area / (rect.long * rect.short) >= R.minFill;

  // 陸屋根にする建物: 共同住宅（3 階以上・大きい）、住宅・共同住宅以外の建物。屋上のまわりにパラペット（棟 − 中央値）を立ち上げる
  const flatApartment = uc === 'apartment' && ((storeys ?? 3) >= R.flatApartmentStoreys || area > R.flatApartmentArea);
  const tall = ridge > R.maxRidge || (storeys != null && storeys > R.maxStoreys);
  const houseLike = uc === 'house' || (uc === 'apartment' && !flatApartment) || (uc === 'unknown' && (storeys ?? 2) <= 2 && area <= 200);
  if (!houseLike || tall) {
    if (gap < R.parapetMin || gap > R.parapetMax) return null;
    return { roof: { kind: 'flat', eave: round2(med), ridge: round2(med + gap), boxHeight: round2(med), parapet: round2(gap), ...(storeys ? { storeys } : {}) }, rect: null };
  }
  if (gap < R.minRise || !rectOk || !rect) return null;

  // 傾いた屋根: 寄棟（急すぎれば片流れ）。共同住宅（小さい木造アパート）は切妻
  let eave = estimateEave(med, ridge, storeys);
  let rise = ridge - eave;
  const run = rect.short / 2;
  let kind: EstimatedRoof['kind'] = uc === 'apartment' ? 'gable' : 'hip';
  if (rise / run > R.shedPitch && kind !== 'gable') {
    kind = 'shed';
    eave = estimateEave(med, ridge, storeys, 0.5);
    rise = ridge - eave;
  }
  const maxRise = R.maxPitch * (kind === 'shed' ? rect.short : run);
  if (rise > maxRise) {
    rise = maxRise;
    eave = ridge - rise;
  }
  if (eave < R.minEave) {
    eave = Math.min(R.minEave, ridge - R.minRise);
    rise = ridge - eave;
  }
  if (!(eave > 0) || rise < R.minRise * 0.99) return null;
  const roof: EstimatedRoof = { kind, eave: round2(eave), ridge: round2(ridge), boxHeight: round2(med), ...(storeys ? { storeys, floorH: round2(eave / storeys) } : {}) };
  if (kind === 'shed') roof.highSide = 'N';
  return { roof, rect };
}

/** 仕様の最高点（陸屋根はパラペットの天端）[m] */
export const specTop = (s: Pick<RoofSpec, 'kind' | 'eave' | 'ridge' | 'parapet'>) => (s.kind === 'flat' ? s.eave + (s.parapet ?? Math.max(0, s.ridge - s.eave)) : s.ridge);

/** 仕様を整える（高さの下限・上限、軒 ≤ 棟、陸屋根は ridge = eave + parapet、階数・階高があれば軒 = 階数 × 階高 で上書きしない） */
export function normalizeSpec(s: RoofSpec): RoofSpec {
  const eave = Math.min(300, Math.max(0.5, Number.isFinite(s.eave) ? s.eave : 3));
  let ridge = Math.min(300, Math.max(eave, Number.isFinite(s.ridge) ? s.ridge : eave));
  const out: RoofSpec = { ...s, eave: round2(eave), ridge: round2(ridge), boxHeight: s.boxHeight };
  if (s.kind === 'flat') {
    out.parapet = round2(Math.max(0, ridge - eave));
    delete out.ridgeDir;
    delete out.highSide;
  } else {
    delete out.parapet;
    if (s.kind !== 'gable') delete out.ridgeDir;
    if (s.kind !== 'shed') delete out.highSide;
    else out.highSide = s.highSide ?? 'N';
  }
  return out;
}

/** 仕様どおりに屋根をかぶせた mesh（ring は anchor 基準の東・北）。作れなければ null */
export function specMesh(ring: EN[], spec: RoofSpec): NeighborMesh | null {
  return meshFromSpec(ring, minAreaRect(ring), spec);
}

/**
 * LOD1 の建物に推定の屋根をかぶせた建物を返す（付けない建物は同じオブジェクトのまま）。
 * mesh を壁 + 屋根に置き換え、height = 最高点、attrs.zmax = zmin + 最高点、attrs.roofEstimate に仕様。足元の輪郭 ring/holes は変えない
 */
const estimated = new WeakMap<PlateauBuilding, PlateauBuilding>();

export function withEstimatedRoof(b: PlateauBuilding): PlateauBuilding {
  const hit = estimated.get(b);
  if (hit) return hit;
  const out = estimate(b);
  estimated.set(b, out);
  return out;
}

function estimate(b: PlateauBuilding): PlateauBuilding {
  const plan = planRoof(b);
  if (!plan) return b;
  const mesh = meshFromSpec(b.ring, plan.rect, plan.roof);
  if (!mesh) return b;
  const top = specTop(plan.roof);
  return { ...b, height: top, mesh, attrs: { ...b.attrs, zmax: b.attrs.zmin + top, roofEstimate: plan.roof } };
}

export { flatMesh, gableMesh, hipMesh, shedMesh };
