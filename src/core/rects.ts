/**
 * 直交多角形 ⇔ 矩形の変換
 */
import type { Vec2 } from './types';
import { pointInPolygon, polygonArea } from './geometry';

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const rectW = (r: Rect) => r.maxX - r.minX;
export const rectH = (r: Rect) => r.maxY - r.minY;
export const rectArea = (r: Rect) => rectW(r) * rectH(r);
export const rectCenter = (r: Rect): Vec2 => ({ x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 });

export function isRectilinear(poly: Vec2[], tol = 1): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (Math.abs(a.x - b.x) > tol && Math.abs(a.y - b.y) > tol) return false;
  }
  return true;
}

function uniqSorted(vals: number[], tol: number): number[] {
  const s = vals.slice().sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
}

/** 座標圧縮したセルの内外判定 */
export function cellGrid(polys: Vec2[][], tol: number) {
  const xs = uniqSorted(polys.flat().map((p) => p.x), tol);
  const ys = uniqSorted(polys.flat().map((p) => p.y), tol);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const inside = new Uint8Array(Math.max(0, nx * ny));
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = { x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 };
      // 偶奇規則（穴に対応）
      let k = 0;
      for (const p of polys) if (pointInPolygon(c, p)) k++;
      inside[j * nx + i] = k % 2;
    }
  return { xs, ys, nx, ny, inside };
}

/** 互いに重ならない矩形へ分解（床・天井用） */
export function polygonToRects(polys: Vec2[][], tol = 5): Rect[] {
  const { xs, ys, nx, ny, inside } = cellGrid(polys, tol);
  const used = new Uint8Array(inside.length);
  const out: Rect[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!inside[k] || used[k]) continue;
      // 横に伸ばす
      let i2 = i;
      while (i2 + 1 < nx && inside[j * nx + i2 + 1] && !used[j * nx + i2 + 1]) i2++;
      // 縦に伸ばす
      let j2 = j;
      outer: while (j2 + 1 < ny) {
        for (let ii = i; ii <= i2; ii++) if (!inside[(j2 + 1) * nx + ii] || used[(j2 + 1) * nx + ii]) break outer;
        j2++;
      }
      for (let jj = j; jj <= j2; jj++) for (let ii = i; ii <= i2; ii++) used[jj * nx + ii] = 1;
      out.push({ minX: xs[i], maxX: xs[i2 + 1], minY: ys[j], maxY: ys[j2 + 1] });
    }
  return out;
}

/**
 * 極大矩形による被覆（重なりあり）。屋根の分割に使う（L字は2つの矩形が重なる）
 */
export function maximalRectCover(polys: Vec2[][], tol = 5, minSize = 0): Rect[] {
  const { xs, ys, inside } = cellGrid(polys, tol);
  return maximalRectCoverMask(xs, ys, inside, minSize);
}

/** 座標圧縮済みのマスクに対する極大矩形被覆 */
export function maximalRectCoverMask(xs: number[], ys: number[], inside: Uint8Array, minSize = 0): Rect[] {
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const covered = new Uint8Array(inside.length);
  const out: Rect[] = [];
  const cellsIn = (i0: number, j0: number, i1: number, j1: number) => {
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (!inside[j * nx + i]) return false;
    return true;
  };
  // 面積の大きい候補から採用
  const cands: { i0: number; j0: number; i1: number; j1: number; area: number }[] = [];
  for (let j0 = 0; j0 < ny; j0++)
    for (let i0 = 0; i0 < nx; i0++) {
      if (!inside[j0 * nx + i0]) continue;
      for (let j1 = j0; j1 < ny; j1++) {
        if (!inside[j1 * nx + i0]) break;
        for (let i1 = i0; i1 < nx; i1++) {
          if (!cellsIn(i0, j0, i1, j1)) break;
          // 極大性: 4方向に広げられない
          const canL = i0 > 0 && cellsIn(i0 - 1, j0, i0 - 1, j1);
          const canR = i1 + 1 < nx && cellsIn(i1 + 1, j0, i1 + 1, j1);
          const canU = j0 > 0 && cellsIn(i0, j0 - 1, i1, j0 - 1);
          const canD = j1 + 1 < ny && cellsIn(i0, j1 + 1, i1, j1 + 1);
          if (canL || canR || canU || canD) continue;
          const area = (xs[i1 + 1] - xs[i0]) * (ys[j1 + 1] - ys[j0]);
          cands.push({ i0, j0, i1, j1, area });
        }
      }
    }
  cands.sort((a, b) => b.area - a.area);
  for (const c of cands) {
    let adds = false;
    for (let j = c.j0; j <= c.j1 && !adds; j++) for (let i = c.i0; i <= c.i1; i++) if (!covered[j * nx + i]) adds = true;
    if (!adds) continue;
    const r = { minX: xs[c.i0], maxX: xs[c.i1 + 1], minY: ys[c.j0], maxY: ys[c.j1 + 1] };
    if (Math.min(rectW(r), rectH(r)) < minSize && out.length) {
      // 細すぎる矩形は近い矩形に吸収させずそのまま（最低1つは採用）
    }
    out.push(r);
    for (let j = c.j0; j <= c.j1; j++) for (let i = c.i0; i <= c.i1; i++) covered[j * nx + i] = 1;
  }
  return out;
}

/** 矩形 a から b を引いた残り（最大4つ） */
export function rectMinus(a: Rect, b: Rect): Rect[] {
  const ix0 = Math.max(a.minX, b.minX);
  const ix1 = Math.min(a.maxX, b.maxX);
  const iy0 = Math.max(a.minY, b.minY);
  const iy1 = Math.min(a.maxY, b.maxY);
  if (ix0 >= ix1 || iy0 >= iy1) return [a];
  const out: Rect[] = [];
  if (a.minY < iy0) out.push({ minX: a.minX, maxX: a.maxX, minY: a.minY, maxY: iy0 });
  if (iy1 < a.maxY) out.push({ minX: a.minX, maxX: a.maxX, minY: iy1, maxY: a.maxY });
  if (a.minX < ix0) out.push({ minX: a.minX, maxX: ix0, minY: iy0, maxY: iy1 });
  if (ix1 < a.maxX) out.push({ minX: ix1, maxX: a.maxX, minY: iy0, maxY: iy1 });
  return out.filter((r) => rectW(r) > 1 && rectH(r) > 1);
}

export function rectsMinus(rs: Rect[], holes: Rect[]): Rect[] {
  let cur = rs;
  for (const h of holes) cur = cur.flatMap((r) => rectMinus(r, h));
  return cur;
}

export function rectIntersects(a: Rect, b: Rect, tol = 0): boolean {
  return a.minX < b.maxX - tol && b.minX < a.maxX - tol && a.minY < b.maxY - tol && b.minY < a.maxY - tol;
}

/** 多角形内の最大の軸平行矩形（家具配置用、座標圧縮で近似） */
export function largestInnerRect(poly: Vec2[], tol = 5): Rect | null {
  const rects = maximalRectCover([poly], tol);
  if (!rects.length) return null;
  return rects.sort((a, b) => rectArea(b) - rectArea(a))[0];
}

export function polyFromRect(r: Rect): Vec2[] {
  return [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ];
}

/** 反時計回り（y 下向き座標で見た目の時計回り）に揃える */
export function ensureOrientation(poly: Vec2[], positive: boolean): Vec2[] {
  const a = polygonArea(poly);
  return (a > 0) === positive ? poly : poly.slice().reverse();
}

/** 多角形のオフセット（マイタ結合、外向き正） */
export function offsetPolygon(poly: Vec2[], d: number): Vec2[] {
  const n = poly.length;
  const sign = polygonArea(poly) > 0 ? 1 : -1; // y下向きで面積正 = 見た目時計回り
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n];
    const p1 = poly[i];
    const p2 = poly[(i + 1) % n];
    const e1 = norm(p1.x - p0.x, p1.y - p0.y);
    const e2 = norm(p2.x - p1.x, p2.y - p1.y);
    // 外向き法線（面積正の多角形では左手側 (e.y, -e.x) が外）
    const n1 = { x: e1.y * sign, y: -e1.x * sign };
    const n2 = { x: e2.y * sign, y: -e2.x * sign };
    const bis = norm(n1.x + n2.x, n1.y + n2.y);
    const cos = bis.x * n1.x + bis.y * n1.y;
    const k = d / Math.max(0.3, cos);
    out.push({ x: p1.x + bis.x * k, y: p1.y + bis.y * k });
  }
  return out;
}

function norm(x: number, y: number) {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}
