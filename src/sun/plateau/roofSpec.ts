/**
 * 屋根の仕様（RoofSpec）と、足元の輪郭から屋根つきの三角形（NeighborMesh）を作る関数。three 非依存の純関数。
 *
 * 寄棟・切妻・片流れは足元の最小外接長方形（roofEstimate.ts の minAreaRect）にかぶせる。陸屋根は足元の輪郭どおりの箱で、
 * 屋上のまわりに立ち上がり（パラペット）を付けられる。座標は x = 東, y = 上（足元 0）, z = −北。巻きは外向き。屋根の三角形が先頭に並ぶ。
 */
import { sortRoofFirst } from './buildings';
import type { EN, NeighborMesh } from './types';

export type RoofKind = 'hip' | 'gable' | 'shed' | 'flat';
export const ROOF_KINDS: readonly RoofKind[] = ['hip', 'gable', 'shed', 'flat'];
export const ROOF_KIND_LABEL: Readonly<Record<RoofKind, string>> = { hip: '寄棟', gable: '切妻', shed: '片流れ', flat: '陸屋根' };
/** 片流れの高い側（方位） */
export type HighSide = 'N' | 'E' | 'S' | 'W';
export const HIGH_SIDES: readonly HighSide[] = ['N', 'E', 'S', 'W'];
export const HIGH_SIDE_LABEL: Readonly<Record<HighSide, string>> = { N: '北', E: '東', S: '南', W: '西' };
const HIGH_VEC: Readonly<Record<HighSide, EN>> = { N: { e: 0, n: 1 }, E: { e: 1, n: 0 }, S: { e: 0, n: -1 }, W: { e: -1, n: 0 } };

/** 屋根の仕様。eave = 壁の上端（陸屋根は屋上面）、ridge = いちばん高い所（陸屋根はパラペットの天端）[m、足元から] */
export interface RoofSpec {
  kind: RoofKind;
  eave: number;
  ridge: number;
  /** 元の箱の高さ（点群の中央値 = 元の zmax − zmin） */
  boxHeight: number;
  /** 切妻の棟の向き（既定 'long' = 長手）。寄棟は常に長手 */
  ridgeDir?: 'long' | 'short';
  /** 片流れの高い側（既定 北） */
  highSide?: HighSide;
  /** 階数・階高（軒高 = 階数 × 階高。目安の表示と入力用。無くてもよい） */
  storeys?: number;
  floorH?: number;
  /** 陸屋根のパラペットの高さ [m]（屋上面から。ridge − eave と同じ） */
  parapet?: number;
  /** 利用者が直した（推定ではなく手入力） */
  user?: boolean;
}

export interface RectLike {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  long: number;
  short: number;
}

type P3 = [number, number, number];
const P = (e: number, n: number, y: number): P3 => [e, y, -n];

class Tris {
  out: number[] = [];
  /** 外向き（dot(normal, outward) > 0）になるよう巻きを合わせて追加 */
  add(a: P3, b: P3, c: P3, outward: (centroid: P3) => P3): void {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (Math.hypot(n[0], n[1], n[2]) < 1e-9) return;
    const g: P3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const o = outward(g);
    const flip = n[0] * o[0] + n[1] * o[1] + n[2] * o[2] < 0;
    this.out.push(...a, ...(flip ? c : b), ...(flip ? b : c));
  }
  mesh(): NeighborMesh {
    return sortRoofFirst(Float32Array.from(this.out), 0.5);
  }
}

/** 凸な立体（長方形の壁・屋根）用: 内側の点から外へ */
const fromInside = (inside: P3) => (g: P3): P3 => [g[0] - inside[0], g[1] - inside[1], g[2] - inside[2]];

function axes(rect: RectLike, ridgeAlongLong: boolean) {
  const ux = ridgeAlongLong ? rect.ux : -rect.uy;
  const uy = ridgeAlongLong ? rect.uy : rect.ux;
  const lr = ridgeAlongLong ? rect.long : rect.short;
  const lc = ridgeAlongLong ? rect.short : rect.long;
  return { ux, uy, vx: -uy, vy: ux, lr, lc };
}

/** 寄棟（棟は長手。正方形に近ければ角錐） */
export function hipMesh(rect: RectLike, eave: number, ridge: number): NeighborMesh {
  const { ux, uy, vx, vy, lr, lc } = axes(rect, true);
  const hl = lr / 2;
  const hs = lc / 2;
  const c = (su: number, sv: number, y: number): P3 => P(rect.cx + su * hl * ux + sv * hs * vx, rect.cy + su * hl * uy + sv * hs * vy, y);
  const A = c(-1, -1, eave);
  const B = c(1, -1, eave);
  const C = c(1, 1, eave);
  const D = c(-1, 1, eave);
  const A0 = c(-1, -1, 0);
  const B0 = c(1, -1, 0);
  const C0 = c(1, 1, 0);
  const D0 = c(-1, 1, 0);
  const half = Math.max(0, (lr - lc) / 2);
  const rp = (s: number): P3 => P(rect.cx + s * half * ux, rect.cy + s * half * uy, ridge);
  const R1 = rp(-1);
  const R2 = rp(1);
  const t = new Tris();
  const out = fromInside(P(rect.cx, rect.cy, eave / 2));
  const quad = (a: P3, b: P3, cc: P3, d: P3) => {
    t.add(a, b, cc, out);
    t.add(a, cc, d, out);
  };
  quad(A0, B0, B, A);
  quad(B0, C0, C, B);
  quad(C0, D0, D, C);
  quad(D0, A0, A, D);
  quad(A, B, R2, R1);
  quad(C, D, R1, R2);
  t.add(B, C, R2, out);
  t.add(D, A, R1, out);
  return t.mesh();
}

/** 切妻（棟は ridgeDir の向き。妻壁は棟まで） */
export function gableMesh(rect: RectLike, eave: number, ridge: number, ridgeDir: 'long' | 'short' = 'long'): NeighborMesh {
  const { ux, uy, vx, vy, lr, lc } = axes(rect, ridgeDir === 'long');
  const hl = lr / 2;
  const hs = lc / 2;
  const c = (su: number, sv: number, y: number): P3 => P(rect.cx + su * hl * ux + sv * hs * vx, rect.cy + su * hl * uy + sv * hs * vy, y);
  const A = c(-1, -1, eave);
  const B = c(1, -1, eave);
  const C = c(1, 1, eave);
  const D = c(-1, 1, eave);
  const A0 = c(-1, -1, 0);
  const B0 = c(1, -1, 0);
  const C0 = c(1, 1, 0);
  const D0 = c(-1, 1, 0);
  const R1 = c(-1, 0, ridge);
  const R2 = c(1, 0, ridge);
  const t = new Tris();
  const out = fromInside(P(rect.cx, rect.cy, eave / 2));
  const quad = (a: P3, b: P3, cc: P3, d: P3) => {
    t.add(a, b, cc, out);
    t.add(a, cc, d, out);
  };
  quad(A0, B0, B, A);
  quad(B0, C0, C, B);
  quad(C0, D0, D, C);
  quad(D0, A0, A, D);
  quad(A, B, R2, R1);
  quad(C, D, R1, R2);
  t.add(B, C, R2, out);
  t.add(D, A, R1, out);
  return t.mesh();
}

/** 片流れ（高い側 highSide に向かって eave → ridge。長方形の各隅の高さは方位方向の位置で決める） */
export function shedMesh(rect: RectLike, eave: number, ridge: number, highSide: HighSide = 'N'): NeighborMesh {
  const hl = rect.long / 2;
  const hs = rect.short / 2;
  const vx = -rect.uy;
  const vy = rect.ux;
  const corners = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([su, sv]) => ({ e: rect.cx + su * hl * rect.ux + sv * hs * vx, n: rect.cy + su * hl * rect.uy + sv * hs * vy }));
  const d = HIGH_VEC[highSide];
  const proj = corners.map((p) => p.e * d.e + p.n * d.n);
  const lo = Math.min(...proj);
  const hi = Math.max(...proj);
  const top = corners.map((p, i) => (hi - lo < 1e-9 ? eave : eave + ((ridge - eave) * (proj[i] - lo)) / (hi - lo)));
  const t = new Tris();
  const out = fromInside(P(rect.cx, rect.cy, ridge / 2));
  const T = corners.map((p, i) => P(p.e, p.n, top[i]));
  const B0 = corners.map((p) => P(p.e, p.n, 0));
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    t.add(B0[i], B0[j], T[j], out);
    t.add(B0[i], T[j], T[i], out);
  }
  t.add(T[0], T[1], T[2], out);
  t.add(T[0], T[2], T[3], out);
  return t.mesh();
}

// ---------------------------------------------------------------------------
// 陸屋根（足元の輪郭どおりの箱 + パラペット）
// ---------------------------------------------------------------------------

function signedArea(ring: EN[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.e * b.n - b.e * a.n;
  }
  return s / 2;
}

/** 単純多角形の耳切り（反時計回りに直して三角形の頂点の添字を返す）。穴は扱わない */
export function earClip(ring: EN[]): [number, number, number][] {
  const n = ring.length;
  if (n < 3) return [];
  const idx = Array.from({ length: n }, (_, i) => i);
  if (signedArea(ring) < 0) idx.reverse();
  const cross = (o: EN, a: EN, b: EN) => (a.e - o.e) * (b.n - o.n) - (a.n - o.n) * (b.e - o.e);
  const inTri = (p: EN, a: EN, b: EN, c: EN) => cross(a, b, p) >= -1e-9 && cross(b, c, p) >= -1e-9 && cross(c, a, p) >= -1e-9;
  const out: [number, number, number][] = [];
  let guard = n * n + 10;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length];
      const i1 = idx[k];
      const i2 = idx[(k + 1) % idx.length];
      const a = ring[i0];
      const b = ring[i1];
      const c = ring[i2];
      if (cross(a, b, c) <= 1e-9) continue;
      let ear = true;
      for (const j of idx) if (j !== i0 && j !== i1 && j !== i2 && inTri(ring[j], a, b, c)) ear = false;
      if (!ear) continue;
      out.push([i0, i1, i2]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/** 陸屋根: 足元の輪郭の壁 + 屋上面（roofY）+ まわりのパラペット（高さ rim。0 なら無し） */
export function flatMesh(ring: EN[], roofY: number, rim = 0): NeighborMesh {
  const t = new Tris();
  const up = (): P3 => [0, 1, 0];
  const ccw = signedArea(ring) >= 0;
  const r = ccw ? ring : [...ring].reverse();
  const m = r.length;
  for (let i = 0; i < m; i++) {
    const a = r[i];
    const b = r[(i + 1) % m];
    const de = b.e - a.e;
    const dn = b.n - a.n;
    // 反時計回りの輪郭では、辺の進行方向の右が外（東・北で (dn, −de)）→ x = e, z = −n で (dn, de)
    const out = (): P3 => [dn, 0, de];
    t.add(P(a.e, a.n, 0), P(b.e, b.n, 0), P(b.e, b.n, roofY), out);
    t.add(P(a.e, a.n, 0), P(b.e, b.n, roofY), P(a.e, a.n, roofY), out);
    if (rim > 0.05) {
      const y1 = roofY + rim;
      t.add(P(a.e, a.n, roofY), P(b.e, b.n, roofY), P(b.e, b.n, y1), out);
      t.add(P(a.e, a.n, roofY), P(b.e, b.n, y1), P(a.e, a.n, y1), out);
      const inn = (): P3 => [-dn, 0, -de];
      t.add(P(a.e, a.n, roofY), P(b.e, b.n, roofY), P(b.e, b.n, y1), inn);
      t.add(P(a.e, a.n, roofY), P(b.e, b.n, y1), P(a.e, a.n, y1), inn);
    }
  }
  for (const [i, j, k] of earClip(r)) t.add(P(r[i].e, r[i].n, roofY), P(r[j].e, r[j].n, roofY), P(r[k].e, r[k].n, roofY), up);
  return t.mesh();
}

/** 仕様どおりの屋根つきの建物（足元の輪郭 ring は anchor 基準の東・北 [m]。rect は ring の最小外接長方形） */
export function meshFromSpec(ring: EN[], rect: RectLike | null, spec: RoofSpec): NeighborMesh | null {
  if (spec.kind === 'flat') return flatMesh(ring, spec.eave, spec.parapet ?? Math.max(0, spec.ridge - spec.eave));
  if (!rect) return null;
  if (spec.kind === 'gable') return gableMesh(rect, spec.eave, spec.ridge, spec.ridgeDir ?? 'long');
  if (spec.kind === 'shed') return shedMesh(rect, spec.eave, spec.ridge, spec.highSide ?? 'N');
  return hipMesh(rect, spec.eave, spec.ridge);
}
