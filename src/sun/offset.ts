/**
 * 2D の多角形の補助（日影図の敷地境界・5m/10m ライン）。three.js に依存しない。
 *
 *  - offsetRegion / offsetPolygon: 多角形から水平距離 d の線 {p : dist(p, 多角形) = d}（日影規制の 5m・10m ライン）。
 *    凸の角は半径 d の円弧（OFFSET_ARC_STEP_DEG 以下の刻み）、凹の角は隣り合う辺のオフセットの交点、
 *    狭い切り込み（幅 < 2d）で向かい合うオフセットがぶつかる所は交点で切ってつなぐ。
 *    方法: 「生のオフセット曲線」（各辺を d 平行移動した線分 + 凸の頂点の円弧 + 凹の頂点を通るつなぎ）を自己交差で切り分け、
 *    多角形からの距離がちょうど d の部分だけを残してつなぎ直す。単純でない多角形や、つなぎ直しに失敗したときは
 *    距離場の等値線（marchingSquares + 頂点を距離 d へ射影）に退避する。
 *  - distanceToPolygon / isSimplePolygon / rectPolygon / signedArea / bboxOf / pointInRegion
 */
import { pointInPolygon } from '../core/geometry';

export interface Pt2 {
  x: number;
  y: number;
}

/** 5m/10m ラインの凸の角の円弧の最大刻み（度） */
export const OFFSET_ARC_STEP_DEG = 3;

export function signedArea(poly: Pt2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function bboxOf(poly: Pt2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** 矩形 [min, (max.x,min.y), max, (min.x,max.y)] */
export function rectPolygon(minX: number, minY: number, maxX: number, maxY: number): Pt2[] {
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

function segmentsIntersect(a: Pt2, b: Pt2, c: Pt2, d: Pt2): boolean {
  const cross = (o: Pt2, p: Pt2, q: Pt2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 単純多角形か（隣り合わない辺が交差しない） */
export function isSimplePolygon(poly: Pt2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  return true;
}

/** 点から多角形の辺（閉じた折れ線）への最短距離と最近点 */
function closestOnBoundary(p: Pt2, poly: Pt2[]): { x: number; y: number; dist: number } {
  let best = Infinity;
  let bx = p.x;
  let by = p.y;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const qx = a.x + dx * t;
    const qy = a.y + dy * t;
    const dd = Math.hypot(qx - p.x, qy - p.y);
    if (dd < best) {
      best = dd;
      bx = qx;
      by = qy;
    }
  }
  return { x: bx, y: by, dist: best };
}

/** 点から多角形への距離（内部なら 0） */
export function distanceToPolygon(p: Pt2, poly: Pt2[]): number {
  if (poly.length >= 3 && pointInPolygon(p, poly)) return 0;
  const best = closestOnBoundary(p, poly).dist;
  return Number.isFinite(best) ? best : 0;
}

/** 輪郭の組（外周 + 穴）の内側か（偶奇規則） */
export function pointInRegion(p: Pt2, loops: Pt2[][]): boolean {
  let n = 0;
  for (const l of loops) if (l.length >= 3 && pointInPolygon(p, l)) n++;
  return n % 2 === 1;
}

/** 重複点・閉じ点・一直線上の点を除く */
function cleanRing(polyIn: Pt2[], tol: number): Pt2[] {
  const poly: Pt2[] = [];
  for (const p of polyIn) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const q = poly[poly.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > tol) poly.push({ x: p.x, y: p.y });
  }
  while (poly.length > 1 && Math.hypot(poly[0].x - poly[poly.length - 1].x, poly[0].y - poly[poly.length - 1].y) <= tol) poly.pop();
  // 一直線上の点（前後の辺と同じ向き）を除く。折り返し（180°）は残す
  let changed = true;
  while (changed && poly.length > 3) {
    changed = false;
    for (let i = 0; i < poly.length && poly.length > 3; i++) {
      const a = poly[(i - 1 + poly.length) % poly.length];
      const b = poly[i];
      const c = poly[(i + 1) % poly.length];
      const ux = b.x - a.x;
      const uy = b.y - a.y;
      const vx = c.x - b.x;
      const vy = c.y - b.y;
      const cr = ux * vy - uy * vx;
      const dt = ux * vx + uy * vy;
      if (Math.abs(cr) <= 1e-12 * Math.hypot(ux, uy) * Math.hypot(vx, vy) && dt > 0) {
        poly.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return poly;
}

/** 輪郭の後処理: 近すぎる点と一直線上の点を除く（円弧の刻みは残る） */
function simplifyLoop(loop: Pt2[], tol: number): Pt2[] {
  const out: Pt2[] = [];
  for (const p of loop) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > tol) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= tol) out.pop();
  for (let i = 0; i < out.length && out.length > 3; i++) {
    const a = out[(i - 1 + out.length) % out.length];
    const b = out[i];
    const c = out[(i + 1) % out.length];
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const vx = c.x - b.x;
    const vy = c.y - b.y;
    if (Math.abs(ux * vy - uy * vx) <= 1e-10 * Math.hypot(ux, uy) * Math.hypot(vx, vy) && ux * vx + uy * vy > 0) {
      out.splice(i, 1);
      i = Math.max(-1, i - 2);
    }
  }
  return out;
}

/** 頂点を多角形からの距離がちょうど d の位置へ寄せる（最近点から外向きに d） */
function projectToLevel(p: Pt2, poly: Pt2[], d: number): Pt2 {
  const c = closestOnBoundary(p, poly);
  if (!(c.dist > 1e-12)) return p;
  const k = d / c.dist;
  return { x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k };
}

const KIND_EDGE = 0;
const KIND_ARC = 1;
const KIND_CONN = 2;

/**
 * 生のオフセット曲線を自己交差で切り分けて、距離がちょうど d の部分をつなぐ（単純多角形・面積 > 0 の向き）。
 * 失敗したら null
 */
function offsetExact(poly: Pt2[], d: number, step: number, scale: number): Pt2[][] | null {
  const n = poly.length;
  const tolLen = 1e-9 * scale;
  // ---- 生のオフセット曲線（閉じた折れ線）。kinds[j] / centers[j]: 点 j から始まる線分の種類と円弧の中心
  const pts: Pt2[] = [];
  const kinds: number[] = [];
  const centers: (Pt2 | null)[] = [];
  const push = (x: number, y: number, kind: number, c: Pt2 | null = null) => {
    const q = pts[pts.length - 1];
    if (q && Math.hypot(x - q.x, y - q.y) <= tolLen) {
      kinds[kinds.length - 1] = kind;
      centers[centers.length - 1] = c;
      return;
    }
    pts.push({ x, y });
    kinds.push(kind);
    centers.push(c);
  };
  const normal = (i: number) => {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    // 面積が正（反時計回り）の多角形の外向き法線は進行方向の右
    return { x: dy / l, y: -dx / l, dx, dy };
  };
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const e = normal(i);
    const f = normal((i + 1) % n);
    push(a.x + d * e.x, a.y + d * e.y, KIND_EDGE);
    const cr = e.dx * f.dy - e.dy * f.dx;
    const dt = e.dx * f.dx + e.dy * f.dy;
    // 折り返し（180°。線分の端など）は凸の半円にする（-0 で -180° と判定しないように）
    const theta = Math.abs(cr) <= 1e-12 * Math.hypot(e.dx, e.dy) * Math.hypot(f.dx, f.dy) && dt < 0 ? Math.PI : Math.atan2(cr, dt);
    if (theta > 1e-12) {
      // 凸の頂点: 半径 d の円弧（反時計回りに n_i → n_{i+1}）
      push(b.x + d * e.x, b.y + d * e.y, KIND_ARC, b);
      const k = Math.max(1, Math.ceil(theta / step - 1e-9));
      const a0 = Math.atan2(e.y, e.x);
      for (let s = 1; s < k; s++) {
        const ang = a0 + (theta * s) / k;
        push(b.x + d * Math.cos(ang), b.y + d * Math.sin(ang), KIND_ARC, b);
      }
    } else if (theta < -1e-12) {
      // 凹の頂点: 頂点を通ってつなぐ（このつなぎと、交点の先のオフセットは後で捨てる）
      push(b.x + d * e.x, b.y + d * e.y, KIND_CONN);
      push(b.x, b.y, KIND_CONN);
    } else {
      push(b.x + d * e.x, b.y + d * e.y, KIND_EDGE);
    }
  }
  while (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= tolLen) {
    pts.pop();
    kinds.pop();
    centers.pop();
  }
  const m = pts.length;
  if (m < 3) return null;

  // ---- 交点（すべての組。隣り合う線分は端点を共有するので除く）
  const nodeX: number[] = pts.map((p) => p.x);
  const nodeY: number[] = pts.map((p) => p.y);
  const parent: number[] = pts.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const addNode = (x: number, y: number) => {
    nodeX.push(x);
    nodeY.push(y);
    parent.push(parent.length);
    return parent.length - 1;
  };
  const splits: { t: number; node: number }[][] = pts.map(() => []);
  const segLen: number[] = [];
  const minX: number[] = [];
  const maxX: number[] = [];
  const minY: number[] = [];
  const maxY: number[] = [];
  for (let j = 0; j < m; j++) {
    const p = pts[j];
    const q = pts[(j + 1) % m];
    segLen.push(Math.hypot(q.x - p.x, q.y - p.y));
    minX.push(Math.min(p.x, q.x) - tolLen);
    maxX.push(Math.max(p.x, q.x) + tolLen);
    minY.push(Math.min(p.y, q.y) - tolLen);
    maxY.push(Math.max(p.y, q.y) + tolLen);
  }
  for (let j = 0; j < m; j++) {
    const p = pts[j];
    const p2 = pts[(j + 1) % m];
    const rx = p2.x - p.x;
    const ry = p2.y - p.y;
    for (let k = j + 2; k < m; k++) {
      if (j === 0 && k === m - 1) continue;
      if (maxX[j] < minX[k] || maxX[k] < minX[j] || maxY[j] < minY[k] || maxY[k] < minY[j]) continue;
      const q = pts[k];
      const q2 = pts[(k + 1) % m];
      const sx = q2.x - q.x;
      const sy = q2.y - q.y;
      const den = rx * sy - ry * sx;
      if (Math.abs(den) <= 1e-14 * segLen[j] * segLen[k]) continue; // 平行（重なりは扱わない）
      const wx = q.x - p.x;
      const wy = q.y - p.y;
      let t = (wx * sy - wy * sx) / den;
      let u = (wx * ry - wy * rx) / den;
      const et = tolLen / (segLen[j] || 1);
      const eu = tolLen / (segLen[k] || 1);
      if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) continue;
      t = Math.max(0, Math.min(1, t));
      u = Math.max(0, Math.min(1, u));
      const nj = t * segLen[j] <= tolLen ? j : (1 - t) * segLen[j] <= tolLen ? (j + 1) % m : -1;
      const nk = u * segLen[k] <= tolLen ? k : (1 - u) * segLen[k] <= tolLen ? (k + 1) % m : -1;
      if (nj >= 0 && nk >= 0) union(nj, nk);
      else if (nj >= 0) splits[k].push({ t: u, node: nj });
      else if (nk >= 0) splits[j].push({ t, node: nk });
      else {
        const x = addNode(p.x + rx * t, p.y + ry * t);
        splits[j].push({ t, node: x });
        splits[k].push({ t: u, node: x });
      }
    }
  }

  // ---- 線分を交点で切り分ける（近すぎる切れ目は同じ節点にまとめる）
  const lists: { t: number; node: number }[][] = [];
  for (let j = 0; j < m; j++) {
    const l = [{ t: 0, node: j }, ...splits[j].sort((a, b) => a.t - b.t), { t: 1, node: (j + 1) % m }];
    const merged: { t: number; node: number }[] = [l[0]];
    for (let i = 1; i < l.length; i++) {
      const prev = merged[merged.length - 1];
      if ((l[i].t - prev.t) * segLen[j] <= tolLen * 4) {
        union(prev.node, l[i].node);
        if (i === l.length - 1) merged[merged.length - 1] = l[i];
      } else merged.push(l[i]);
    }
    lists.push(merged);
  }

  // ---- 残す部分: 中点（円弧は真の円の上へ寄せる）の多角形からの距離が d（他の辺・頂点の d 以内に入っていない）
  interface Piece {
    a: number;
    b: number;
  }
  const kept: Piece[] = [];
  const keepTol = 1e-7 * scale;
  for (let j = 0; j < m; j++) {
    if (kinds[j] === KIND_CONN) continue;
    const p = pts[j];
    const p2 = pts[(j + 1) % m];
    const l = lists[j];
    for (let i = 0; i + 1 < l.length; i++) {
      const A = find(l[i].node);
      const B = find(l[i + 1].node);
      if (A === B) continue;
      const tm = (l[i].t + l[i + 1].t) / 2;
      let mx = p.x + (p2.x - p.x) * tm;
      let my = p.y + (p2.y - p.y) * tm;
      const c = centers[j];
      if (kinds[j] === KIND_ARC && c) {
        const r = Math.hypot(mx - c.x, my - c.y) || 1;
        mx = c.x + ((mx - c.x) * d) / r;
        my = c.y + ((my - c.y) * d) / r;
      }
      if (distanceToPolygon({ x: mx, y: my }, poly) >= d - keepTol) kept.push({ a: A, b: B });
    }
  }
  if (!kept.length) return null;

  // ---- つなぐ（左側に領域を見て進む。分かれ道は最も左へ曲がる方）
  const out = new Map<number, number[]>();
  kept.forEach((pc, i) => {
    const l = out.get(pc.a);
    if (l) l.push(i);
    else out.set(pc.a, [i]);
  });
  const used = new Uint8Array(kept.length);
  const loops: Pt2[][] = [];
  for (let s = 0; s < kept.length; s++) {
    if (used[s]) continue;
    const ids: number[] = [];
    let cur = s;
    let guard = 0;
    for (;;) {
      used[cur] = 1;
      ids.push(kept[cur].a);
      const node = kept[cur].b;
      const ux = nodeX[node] - nodeX[kept[cur].a];
      const uy = nodeY[node] - nodeY[kept[cur].a];
      const cands = (out.get(node) ?? []).filter((i) => !used[i] || i === s);
      if (!cands.length) return null;
      let best = -1;
      let bestAng = -Infinity;
      for (const i of cands) {
        const wx = nodeX[kept[i].b] - nodeX[node];
        const wy = nodeY[kept[i].b] - nodeY[node];
        const ang = Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy);
        if (ang > bestAng) {
          bestAng = ang;
          best = i;
        }
      }
      if (best === s) break;
      cur = best;
      if (++guard > kept.length + 1) return null;
    }
    loops.push(ids.map((id) => ({ x: nodeX[id], y: nodeY[id] })));
  }
  return loops;
}

/**
 * 距離場の等値線（退避用）: 格子の各点で d − 距離 を求め、マーチングスクエアで 0 の線を取り、頂点を距離 d へ寄せる。
 * 単純でない多角形（偶奇規則の内側）にも使える
 */
function offsetGrid(poly: Pt2[], d: number): Pt2[][] {
  const bb = bboxOf(poly);
  const pad = d * 1.1 + 1e-3;
  const W = bb.maxX - bb.minX + 2 * pad;
  const H = bb.maxY - bb.minY + 2 * pad;
  const h = Math.max(W, H, 1e-3) / 400;
  const nx = Math.ceil(W / h) + 1;
  const ny = Math.ceil(H / h) + 1;
  const x0 = bb.minX - pad;
  const y0 = bb.minY - pad;
  const values = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) values[j * nx + i] = d - distanceToPolygon({ x: x0 + i * h, y: y0 + j * h }, poly);
  const lines = segmentsToPolylines(marchingSegments(values, nx, ny, 0), 1e-7);
  const loops: Pt2[][] = [];
  for (const pl of lines) {
    if (!pl.closed || pl.points.length < 3) continue;
    const pts = pl.points.map((q) => projectToLevel({ x: x0 + q.x * h, y: y0 + q.y * h }, poly, d));
    loops.push(simplifyLoop(pts, 1e-6));
  }
  return loops;
}

/**
 * 多角形から水平距離 d の線（{p : dist(p, 多角形) = d}）で囲まれた領域の輪郭。[外周, ...穴]。
 * 外周は面積が正の向き（x 右・y 上の数学座標で反時計回り）、穴は負の向き。
 * 凸の角は半径 d の円弧（opts.arcStepDeg（既定 3°）以下の刻み、点は円の上）、凹の角・狭い切り込みは交点でつなぐ。
 * 穴は、口の幅が 2d より狭い大きな凹み（コの字の中庭など）の奥にだけできる。
 * 点が 1 つなら円、一直線上の点だけなら両端を丸めた帯。d ≤ 0 なら元の多角形
 */
export function offsetRegion(polyIn: Pt2[], d: number, opts: { arcStepDeg?: number } = {}): Pt2[][] {
  const bb0 = bboxOf(polyIn.length ? polyIn : [{ x: 0, y: 0 }]);
  const scale = Math.max(1, Math.abs(d), bb0.maxX - bb0.minX, bb0.maxY - bb0.minY);
  const step = (Math.max(0.1, Math.min(30, opts.arcStepDeg ?? OFFSET_ARC_STEP_DEG)) * Math.PI) / 180;
  let poly = cleanRing(polyIn, 1e-9 * scale);
  if (!(d > 0)) return poly.length >= 3 ? [poly] : [];
  if (!poly.length) return [];
  // 一直線上の点だけ（点・線分）か: 最も離れた 2 点を結ぶ直線からすべての点が離れていない
  let a = poly[0];
  let b = poly[0];
  let best = 0;
  for (const p of poly)
    for (const q of poly) {
      const dd = Math.hypot(p.x - q.x, p.y - q.y);
      if (dd > best) {
        best = dd;
        a = p;
        b = q;
      }
    }
  const offLine = best > 0 ? Math.max(...poly.map((p) => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / best)) : 0;
  const area = poly.length >= 3 ? signedArea(poly) : 0;
  if (poly.length < 3 || offLine <= 1e-9 * scale) {
    // 点・線分・一直線上の点: 最も離れた 2 点の線分の両端を丸めた帯（点 1 つなら円）
    if (best <= 1e-9 * scale) {
      const k = Math.ceil((2 * Math.PI) / step - 1e-9);
      return [Array.from({ length: k }, (_, i) => ({ x: a.x + d * Math.cos((2 * Math.PI * i) / k), y: a.y + d * Math.sin((2 * Math.PI * i) / k) }))];
    }
    poly = [a, b];
    const loops = offsetExact(poly, d, step, scale);
    return loops && loops.length === 1 ? loops.map((l) => simplifyLoop(l, 1e-9 * scale)) : offsetGrid(poly, d);
  }
  if (area < 0) poly = poly.slice().reverse();
  // 面積 0 でも一直線でない（8 の字など）は単純でない多角形として距離場で求める
  const simple = Math.abs(area) > 1e-12 * scale * scale && isSimplePolygon(poly);
  let loops = simple ? offsetExact(poly, d, step, scale) : null;
  if (loops) {
    loops = loops.map((l) => simplifyLoop(l.map((p) => projectToLevel(p, poly, d)), 1e-9 * scale)).filter((l) => l.length >= 3 && Math.abs(signedArea(l)) > 1e-9 * scale * scale);
    // 外周（面積が正）が 1 つ、穴は負の向き。外周は元の多角形より大きい
    const pos = loops.filter((l) => signedArea(l) > 0);
    if (pos.length !== 1 || signedArea(pos[0]) < Math.abs(area)) loops = null;
    else loops = [pos[0], ...loops.filter((l) => signedArea(l) < 0)];
  }
  if (!loops) {
    const g = offsetGrid(poly, d).filter((l) => l.length >= 3);
    if (!g.length) return [rectPolygon(bb0.minX - d, bb0.minY - d, bb0.maxX + d, bb0.maxY + d)];
    // 向きを揃える: 最大の輪郭を外周（正）、他は穴（負）
    g.sort((p, q) => Math.abs(signedArea(q)) - Math.abs(signedArea(p)));
    loops = g.map((l, i) => ((i === 0) === signedArea(l) > 0 ? l : l.slice().reverse()));
  }
  return loops;
}

/**
 * 多角形を外側へ水平距離 d だけ広げた線（日影規制の 5m/10m ライン）の外周。
 * offsetRegion の外周を、入力と同じ向きで返す（矩形なら各辺を d 広げ、四隅を半径 d の円弧で丸めた形）。
 * 穴（口の狭い大きな凹みの奥）も要るときは offsetRegion を使う
 */
export function offsetPolygon(polyIn: Pt2[], d: number): Pt2[] {
  if (!polyIn.length) return rectPolygon(-d, -d, d, d);
  const loops = offsetRegion(polyIn, d);
  const outer = loops[0] ?? [];
  return signedArea(polyIn) < 0 ? outer.slice().reverse() : outer;
}

// ---------------------------------------------------------------------------
// 等値線（analysis.ts から使う。ここに置くのは offsetGrid が使うため）
// ---------------------------------------------------------------------------

export type Segment = [number, number, number, number];

/**
 * 交点の位置を細かく求める関数（marchingSegments の refine）。
 * 格子点 (i0, j0) と (i1, j1)（隣り合う 2 点）の間で値が level を横切る位置を、線形補間の値 t (0..1) を初期値に返す
 */
export type EdgeRefine = (i0: number, j0: number, i1: number, j1: number, t: number) => number;

/**
 * マーチングスクエア（格子座標の線分。i, j は格子点の番号: 値 values[j * nx + i] の位置が (i, j)）。
 * 辺上の交点は線形補間（refine があればその関数で求め直す: 0/1 の値の格子で交点を正確に置くため）
 */
export function marchingSegments(values: ArrayLike<number>, nx: number, nz: number, level: number, refine?: EdgeRefine): Segment[] {
  const segs: Segment[] = [];
  const v = (i: number, j: number) => values[j * nx + i];
  const interp = (a: number, b: number) => (level - a) / (b - a || 1e-9);
  const cross = (i0: number, j0: number, i1: number, j1: number, a: number, b: number) => {
    const t = interp(a, b);
    return refine ? Math.max(0, Math.min(1, refine(i0, j0, i1, j1, t))) : t;
  };
  for (let j = 0; j + 1 < nz; j++)
    for (let i = 0; i + 1 < nx; i++) {
      const a = v(i, j);
      const b = v(i + 1, j);
      const c = v(i + 1, j + 1);
      const d = v(i, j + 1);
      const idx = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const top = (): [number, number] => [i + cross(i, j, i + 1, j, a, b), j];
      const right = (): [number, number] => [i + 1, j + cross(i + 1, j, i + 1, j + 1, b, c)];
      const bottom = (): [number, number] => [i + cross(i, j + 1, i + 1, j + 1, d, c), j + 1];
      const left = (): [number, number] => [i, j + cross(i, j, i, j + 1, a, d)];
      const add = (p: [number, number], q: [number, number]) => segs.push([p[0], p[1], q[0], q[1]]);
      switch (idx) {
        case 1:
        case 14:
          add(left(), top());
          break;
        case 2:
        case 13:
          add(top(), right());
          break;
        case 3:
        case 12:
          add(left(), right());
          break;
        case 4:
        case 11:
          add(right(), bottom());
          break;
        case 6:
        case 9:
          add(top(), bottom());
          break;
        case 7:
        case 8:
          add(left(), bottom());
          break;
        case 5:
          add(left(), top());
          add(right(), bottom());
          break;
        case 10:
          add(top(), right());
          add(left(), bottom());
          break;
      }
    }
  return segs;
}

export interface Polyline {
  points: { x: number; y: number }[];
  closed: boolean;
}

/** 線分の端点をつないで折れ線にする（端点は eps で丸めて一致を判定） */
export function segmentsToPolylines(segs: Segment[], eps = 1e-6): Polyline[] {
  const key = (x: number, y: number) => `${Math.round(x / eps)},${Math.round(y / eps)}`;
  const used = new Uint8Array(segs.length);
  const byPoint = new Map<string, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    for (const k of [key(s[0], s[1]), key(s[2], s[3])]) {
      const l = byPoint.get(k);
      if (l) l.push(i);
      else byPoint.set(k, [i]);
    }
  }
  const takeFrom = (k: string, exclude: number): number => {
    const l = byPoint.get(k);
    if (!l) return -1;
    for (const i of l) if (!used[i] && i !== exclude) return i;
    return -1;
  };
  const out: Polyline[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const s = segs[i];
    const pts: { x: number; y: number }[] = [
      { x: s[0], y: s[1] },
      { x: s[2], y: s[3] },
    ];
    // 前方へ伸ばす
    const extend = (forward: boolean) => {
      for (;;) {
        const end = forward ? pts[pts.length - 1] : pts[0];
        const k = key(end.x, end.y);
        const j = takeFrom(k, -1);
        if (j < 0) return;
        used[j] = 1;
        const t = segs[j];
        const sameStart = key(t[0], t[1]) === k;
        const next = sameStart ? { x: t[2], y: t[3] } : { x: t[0], y: t[1] };
        if (forward) pts.push(next);
        else pts.unshift(next);
      }
    };
    extend(true);
    extend(false);
    const closed = pts.length > 2 && key(pts[0].x, pts[0].y) === key(pts[pts.length - 1].x, pts[pts.length - 1].y);
    if (closed) pts.pop();
    out.push({ points: pts, closed });
  }
  return out;
}
