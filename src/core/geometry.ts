import type { Vec2 } from './types';

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
export const len = (a: Vec2) => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const norm = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
/** 左法線 (x→右, y→下 の座標系では「進行方向の右手」に見える点に注意) */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

export function polygonArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

export function polygonCentroid(poly: Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    a += f;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const s = poly.reduce((acc, p) => add(acc, p), v(0, 0));
    return scale(s, 1 / Math.max(1, poly.length));
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bboxOf(points: Iterable<Vec2>): BBox {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of points) {
    if (p.x < b.minX) b.minX = p.x;
    if (p.y < b.minY) b.minY = p.y;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.y > b.maxY) b.maxY = p.y;
  }
  return b;
}

export function bboxUnion(a: BBox, b: BBox): BBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function bboxGap(a: BBox, b: BBox): number {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  return Math.hypot(dx, dy);
}

/** 点と線分の距離 */
export function distPointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, lerp(a, b, t));
}

/** Douglas-Peucker による閉多角形の簡略化 */
export function simplifyClosed(poly: Vec2[], tol: number): Vec2[] {
  if (poly.length <= 4) return poly;
  // 最も離れた2点で分割
  let i0 = 0;
  let i1 = 0;
  let best = -1;
  for (let i = 0; i < poly.length; i++) {
    const d = dist(poly[0], poly[i]);
    if (d > best) {
      best = d;
      i1 = i;
    }
  }
  const part1 = poly.slice(i0, i1 + 1);
  const part2 = poly.slice(i1).concat([poly[0]]);
  const s1 = simplifyOpen(part1, tol);
  const s2 = simplifyOpen(part2, tol);
  const out = s1.slice(0, -1).concat(s2.slice(0, -1));
  return removeCollinear(out, tol * 0.5);
}

export function simplifyOpen(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let md = -1;
    let mi = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distPointSegment(pts[i], pts[s], pts[e]);
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    if (md > tol && mi > 0) {
      keep[mi] = 1;
      stack.push([s, mi], [mi, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function removeCollinear(poly: Vec2[], tol: number): Vec2[] {
  let out = poly.slice();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      if (distPointSegment(b, a, c) < tol || dist(a, b) < tol) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** 2直線 (p + t*r), (q + u*s) の交点パラメータ */
export function lineIntersect(p: Vec2, r: Vec2, q: Vec2, s: Vec2): { t: number; u: number } | null {
  const rxs = cross(r, s);
  if (Math.abs(rxs) < 1e-9) return null;
  const qp = sub(q, p);
  return { t: cross(qp, s) / rxs, u: cross(qp, r) / rxs };
}

export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
export const deg2rad = (d: number) => (d * Math.PI) / 180;
export const rad2deg = (r: number) => (r * 180) / Math.PI;

/** 区間の和集合 */
export function mergeIntervals(iv: [number, number][], gap = 0): [number, number][] {
  const s = iv.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1] + gap) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

/** 区間 a から区間集合 b を差し引く */
export function subtractIntervals(a: [number, number], b: [number, number][]): [number, number][] {
  let parts: [number, number][] = [[a[0], a[1]]];
  for (const [s, e] of b) {
    const next: [number, number][] = [];
    for (const [ps, pe] of parts) {
      if (e <= ps || s >= pe) next.push([ps, pe]);
      else {
        if (s > ps) next.push([ps, s]);
        if (e < pe) next.push([e, pe]);
      }
    }
    parts = next;
  }
  return parts;
}

export function intervalsLength(iv: [number, number][]): number {
  return iv.reduce((s, [a, b]) => s + Math.max(0, b - a), 0);
}
