/**
 * 多角形から、別の多角形（穴）を形どおりに引く。
 *
 * 丸い角・斜めの辺のある吹抜は、これまで 40mm ごとの横の帯（長方形）で近似して床・天井を抜いていた。
 * 下から見上げると、吹抜の縁（天井の切り口・床の小口）がのこぎりの歯のようにギザギザに見える。
 * ここでは、両方の多角形の頂点と辺の交点の高さで横の帯に分け、帯の中を台形に切る（帯の中では辺が交わらないので、
 * 左右の辺を結んだ台形がそのまま答えになる）。曲線の縁は、元の折れ線のとおりになめらかにつながる。
 */
import type { Vec2 } from './types';

interface Edge {
  a: Vec2;
  b: Vec2;
  /** −1 = 元の多角形、0 以上 = 穴の番号 */
  owner: number;
}

/** 辺の、高さ y での x */
const xAt = (e: Edge, y: number) => e.a.x + ((e.b.x - e.a.x) * (y - e.a.y)) / (e.b.y - e.a.y);

/** 線分 p1–p2 と p3–p4 が内側で交わる点の y（交わらなければ null） */
function crossY(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): number | null {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return p1.y + (p2.y - p1.y) * t;
}

/**
 * poly から holes を引いた残りを、台形（3〜4 頂点の凸多角形）の集まりで返す。
 * 穴は重なっていても、poly の外へはみ出していてもよい。eps = これより細い帯・台形は捨てる（mm）
 */
export function polygonMinusPolygons(poly: Vec2[], holes: Vec2[][], eps = 0.5): Vec2[][] {
  if (poly.length < 3) return [];
  const edges: Edge[] = [];
  const add = (pts: Vec2[], owner: number) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (Math.abs(a.y - b.y) < 1e-9) continue; // 水平の辺は帯を横切らない
      edges.push({ a, b, owner });
    }
  };
  add(poly, -1);
  holes.forEach((h, k) => {
    if (h.length >= 3) add(h, k);
  });
  const y0 = Math.min(...poly.map((p) => p.y));
  const y1 = Math.max(...poly.map((p) => p.y));
  const levels: number[] = [y0, y1];
  for (const p of poly) levels.push(p.y);
  for (const h of holes) for (const p of h) if (p.y > y0 && p.y < y1) levels.push(p.y);
  // 持ち主の違う辺どうしの交点（帯の中で辺の順が入れ替わらないように）
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      if (edges[i].owner === edges[j].owner) continue;
      const y = crossY(edges[i].a, edges[i].b, edges[j].a, edges[j].b);
      if (y != null && y > y0 && y < y1) levels.push(y);
    }
  levels.sort((p, q) => p - q);
  const out: Vec2[][] = [];
  let prev = levels[0];
  for (const lv of levels) {
    if (lv - prev < eps) continue;
    const b0 = prev;
    const b1 = lv;
    prev = lv;
    const ym = (b0 + b1) / 2;
    const cross = edges.filter((e) => e.a.y > ym !== e.b.y > ym).map((e) => ({ e, x: xAt(e, ym) }));
    cross.sort((p, q) => p.x - q.x);
    let inside = false;
    const inHole = new Set<number>();
    for (let k = 0; k + 1 < cross.length; k++) {
      const c = cross[k];
      if (c.e.owner < 0) inside = !inside;
      else if (inHole.has(c.e.owner)) inHole.delete(c.e.owner);
      else inHole.add(c.e.owner);
      if (!inside || inHole.size) continue;
      const L = c.e;
      const R = cross[k + 1].e;
      const xl0 = xAt(L, b0);
      const xr0 = xAt(R, b0);
      const xl1 = xAt(L, b1);
      const xr1 = xAt(R, b1);
      if (xr0 - xl0 < eps && xr1 - xl1 < eps) continue;
      const piece: Vec2[] = [{ x: xl0, y: b0 }];
      if (xr0 - xl0 >= 1e-6) piece.push({ x: xr0, y: b0 });
      piece.push({ x: xr1, y: b1 });
      if (xr1 - xl1 >= 1e-6) piece.push({ x: xl1, y: b1 });
      if (piece.length >= 3) out.push(piece);
    }
  }
  return out;
}
