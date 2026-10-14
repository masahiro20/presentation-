/**
 * 推定の屋根（PLATEAU の LOD1 = 箱形の住宅に、寄棟の屋根を推定してかぶせる）。three 非依存の純関数。
 *
 * 住宅地の PLATEAU は建物ごとに 2 つの高さを持つ: 形状の高さ zmax − zmin（点群の中央値。LOD1 の箱の天端）と、実測の最高高さ
 * bldg:measuredHeight（棟）。切妻・寄棟の屋根の高さの中央値は軒と棟のほぼ中間なので、
 *   棟 = 実測の最高高さ、軒 = 2 × 中央値 − 棟
 * と置ける（世田谷区 2025 年版: 棟 − 中央値 の中央値は +0.9 m → 軒と棟の差 1.8 m = 奥行 9 m の 4 寸勾配）。
 * 足元の輪郭がほぼ長方形（最小外接長方形との面積比 ≥ 0.9）の低層の住宅だけに付け、長手に棟の通る寄棟にする
 * （切妻より影が少なめに出る側の仮定にならないよう、棟の高さは実測の最高高さをそのまま使う）。それ以外は箱のまま。
 * 形はあくまで推定: attrs.roofEstimate に印を付け、開示文・注記に「推定の屋根」と出す。
 */
import type { EN, NeighborMesh, PlateauBuilding } from './types';
import { sortRoofFirst } from './buildings';

export const ROOF_ESTIMATE = {
  /** 棟と箱の天端（中央値）の差がこれ未満なら屋根が無い（陸屋根）とみなす [m] */
  minRise: 0.4,
  /** 軒の高さの下限 [m] */
  minEave: 2.2,
  /** 勾配の上限（立ち上がり ÷ 水平距離。0.8 = 8 寸） */
  maxPitch: 0.8,
  /** 最小外接長方形の短辺・長辺の範囲 [m] */
  minShort: 3,
  maxShort: 15,
  minLong: 4,
  maxLong: 30,
  /** 足元の面積 ÷ 最小外接長方形の面積 の下限 */
  minFill: 0.9,
  /** 棟の高さの上限 [m]（これより高い建物は陸屋根の中高層とみなす） */
  maxRidge: 12,
  /** 階数の上限 */
  maxStoreys: 3,
} as const;

export interface EstimatedRoof {
  kind: 'hip';
  /** 軒の高さ（足元から）[m] */
  eave: number;
  /** 棟の高さ（足元から。実測の最高高さ）[m] */
  ridge: number;
  /** 元の箱の高さ（点群の中央値 = zmax − zmin）[m] */
  boxHeight: number;
}

interface Rect {
  cx: number;
  cy: number;
  /** 長手方向の単位ベクトル（EN） */
  ux: number;
  uy: number;
  long: number;
  short: number;
}

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

/** 屋根を付ける建物か、付けるときの軒・棟。付けない（陸屋根・中高層・非住宅・形が長方形でない…）なら null */
export function planRoof(b: PlateauBuilding): { roof: EstimatedRoof; rect: Rect } | null {
  const a = b.attrs;
  const lod = a.lod ?? a.datasetLod;
  if (lod >= 2 || b.holes.length > 0) return null;
  const ridge = a.measuredHeight;
  const med = a.zmax - a.zmin;
  if (ridge == null || !Number.isFinite(ridge) || !(med > 0)) return null;
  if (ridge > ROOF_ESTIMATE.maxRidge || ridge - med < ROOF_ESTIMATE.minRise) return null;
  if (a.storeys != null && a.storeys > ROOF_ESTIMATE.maxStoreys) return null;
  const area = polygonArea(b.ring);
  if (a.usage ? !/住宅/.test(a.usage) : !((a.storeys ?? 2) <= 2 && area <= 200)) return null;
  const rect = minAreaRect(b.ring);
  if (!rect) return null;
  const R = ROOF_ESTIMATE;
  if (rect.short < R.minShort || rect.short > R.maxShort || rect.long < R.minLong || rect.long > R.maxLong) return null;
  if (area / (rect.long * rect.short) < R.minFill) return null;
  let eave = 2 * med - ridge;
  let rise = ridge - eave;
  const maxRise = R.maxPitch * (rect.short / 2);
  if (rise > maxRise) rise = maxRise;
  eave = ridge - rise;
  if (eave < R.minEave) {
    eave = Math.min(R.minEave, ridge - R.minRise);
    rise = ridge - eave;
  }
  if (!(eave > 0) || rise < R.minRise * 0.99) return null;
  return { roof: { kind: 'hip', eave: round2(eave), ridge: round2(ridge), boxHeight: round2(med) }, rect };
}

/** 寄棟（壁 + 屋根）の三角形（x = 東, y = 上, z = −北。足元 y = 0）。外向きの巻きにそろえ、屋根を先頭に並べる */
export function hipRoofMesh(rect: Rect, eave: number, ridge: number): NeighborMesh {
  const { cx, cy, ux, uy, long, short } = rect;
  const vx = -uy;
  const vy = ux;
  const hl = long / 2;
  const hs = short / 2;
  const corner = (su: number, sv: number, y: number): [number, number, number] => {
    const e = cx + su * hl * ux + sv * hs * vx;
    const n = cy + su * hl * uy + sv * hs * vy;
    return [e, y, -n];
  };
  const A = corner(-1, -1, eave);
  const B = corner(1, -1, eave);
  const C = corner(1, 1, eave);
  const D = corner(-1, 1, eave);
  const A0 = corner(-1, -1, 0);
  const B0 = corner(1, -1, 0);
  const C0 = corner(1, 1, 0);
  const D0 = corner(-1, 1, 0);
  const half = Math.max(0, (long - short) / 2);
  const rp = (s: number): [number, number, number] => [cx + s * half * ux, ridge, -(cy + s * half * uy)];
  const R1 = rp(-1);
  const R2 = rp(1);
  const inside: [number, number, number] = [cx, eave / 2, -cy];
  const out: number[] = [];
  const tri = (p: [number, number, number], q: [number, number, number], r: [number, number, number]) => {
    const ax = q[0] - p[0];
    const ay = q[1] - p[1];
    const az = q[2] - p[2];
    const bx = r[0] - p[0];
    const by = r[1] - p[1];
    const bz = r[2] - p[2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-9) return;
    const gx = (p[0] + q[0] + r[0]) / 3 - inside[0];
    const gy = (p[1] + q[1] + r[1]) / 3 - inside[1];
    const gz = (p[2] + q[2] + r[2]) / 3 - inside[2];
    const flip = nx * gx + ny * gy + nz * gz < 0;
    out.push(...p, ...(flip ? r : q), ...(flip ? q : r));
  };
  const quad = (p: [number, number, number], q: [number, number, number], r: [number, number, number], s: [number, number, number]) => {
    tri(p, q, r);
    tri(p, r, s);
  };
  quad(A0, B0, B, A);
  quad(B0, C0, C, B);
  quad(C0, D0, D, C);
  quad(D0, A0, A, D);
  // 屋根: 長手の 2 面（台形）と妻側の 2 面（三角形）。正方形に近く棟が 0 長なら角錐
  quad(A, B, R2, R1);
  quad(C, D, R1, R2);
  tri(B, C, R2);
  tri(D, A, R1);
  return sortRoofFirst(Float32Array.from(out), 0.5);
}

/**
 * LOD1 の住宅に推定の屋根をかぶせた建物を返す（付けない建物は同じオブジェクトのまま）。
 * mesh を壁 + 寄棟に置き換え、height = 棟の高さ、attrs.zmax = zmin + 棟の高さ（形状の高さ zmax − zmin が描画の縦伸縮の基準なので、
 * 形状の上端に合わせる）、attrs.roofEstimate に軒・棟・元の箱の高さ。足元の輪郭 ring/holes は変えない
 */
export function withEstimatedRoof(b: PlateauBuilding): PlateauBuilding {
  const plan = planRoof(b);
  if (!plan) return b;
  const { roof, rect } = plan;
  return {
    ...b,
    height: roof.ridge,
    mesh: hipRoofMesh(rect, roof.eave, roof.ridge),
    attrs: { ...b.attrs, zmax: b.attrs.zmin + roof.ridge, roofEstimate: roof },
  };
}
