/**
 * 方位記号（真北マーク）の読み取り。
 *
 * 図面に出てくる真北の描き方:
 *  1. 角度の文字 … ARCHITREND は記号の脇に「-9.7399度」のように真北の角度そのものを書く
 *  2. 円＋内接する細長い三角形 … 頂点が北（HL の方位記号）
 *  3. 円＋星形＋中心を通る長い線 … 矢羽（短い線）か「真北」の文字がある側が北（ARCHITREND）
 *  4. 「真北」「N」の文字＋長い線 … 文字に近い端が北。端に矢じり（短い斜め線）や横棒が付く
 *  5. 文字だけ … 文字の近くの図形の重心から文字へ向かう向き（最後の手段）
 *
 * 角度は「上＝0°、時計回り＋（東へ傾く＝＋）」。
 */
import type { Vec2 } from '../core/types';
import type { Arc, Seg } from './walls';
import type { MmText } from './assemble';

export interface NorthCandidate {
  deg: number;
  score: number;
  how: 'angleText' | 'triangle' | 'axis' | 'labelArrow' | 'labelCircle' | 'centroid';
  at: Vec2;
}

interface PageLike {
  segs: Seg[];
  arcs: Arc[];
  texts: MmText[];
  fills: { polygon: Vec2[] }[];
}

const LABEL = /^(真北|N|Ｎ|北|NORTH)$/i;
const ANGLE_TEXT = /^([-−+＋]?\d+(?:\.\d+)?)\s*(度|°)$/;

const norm = (d: number) => {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return Math.round(x) || 0;
};
/** ベクトル（図面座標・y 下向き）→ 真北の角度 */
const degOf = (dx: number, dy: number) => norm((Math.atan2(dx, -dy) * 180) / Math.PI);
const len = (s: Seg) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const bez = (a: Arc, t: number): Vec2 => {
  const u = 1 - t;
  return {
    x: u * u * u * a.p0.x + 3 * u * u * t * a.p1.x + 3 * u * t * t * a.p2.x + t * t * t * a.p3.x,
    y: u * u * u * a.p0.y + 3 * u * u * t * a.p1.y + 3 * u * t * t * a.p2.y + t * t * t * a.p3.y,
  };
};
function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  return { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
}

export interface Circle {
  c: Vec2;
  r: number;
  /** 円周を覆う割合（0..1） */
  cover: number;
  arcs: number;
}

interface Frag {
  c: Vec2;
  r: number;
  pts: Vec2[];
}

const key3 = (q: Vec2) => `${Math.round(q.x / 3)},${Math.round(q.y / 3)}`;

/** 短い線分の連なり（折れ線）をたどって、円に乗る断片を集める */
export function polylineFrags(segs: Seg[], minR: number, maxR: number): Frag[] {
  const cand = segs.filter((s) => {
    const l = len(s);
    return l >= 3 && l <= 320;
  });
  const at = new Map<string, number[]>();
  cand.forEach((s, i) => {
    for (const q of [s.a, s.b]) {
      const k = key3(q);
      if (!at.has(k)) at.set(k, []);
      at.get(k)!.push(i);
    }
  });
  const near = (q: Vec2) => {
    const out: number[] = [];
    const kx = Math.round(q.x / 3);
    const ky = Math.round(q.y / 3);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of at.get(`${kx + dx},${ky + dy}`) ?? []) out.push(i);
    return out;
  };
  const turn = (a: Vec2, b: Vec2, c: Vec2) => {
    let d = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };
  const used = new Uint8Array(cand.length);
  const out: Frag[] = [];
  for (let i0 = 0; i0 < cand.length; i0++) {
    if (used[i0]) continue;
    used[i0] = 1;
    let pts: Vec2[] = [cand[i0].a, cand[i0].b];
    for (const dir of [1, -1]) {
      if (dir === -1) pts = pts.reverse();
      for (let guard = 0; guard < 2000; guard++) {
        const end = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        let t0 = 0;
        let n0 = 0;
        for (let k = Math.max(1, pts.length - 9); k + 1 < pts.length; k++) t0 += turn(pts[k - 1], pts[k], pts[k + 1]), n0++;
        const avg = n0 ? t0 / n0 : 0;
        let best = -1;
        let bestNxt: Vec2 | null = null;
        let bestDev = Infinity;
        for (const j of near(end)) {
          if (used[j]) continue;
          const sj = cand[j];
          const dA = dist(sj.a, end);
          const dB = dist(sj.b, end);
          if (Math.min(dA, dB) > 4) continue;
          const nxt = dA < dB ? sj.b : sj.a;
          const t = turn(prev, end, nxt);
          if (Math.abs(t) > (30 * Math.PI) / 180) continue;
          // 曲がる向きが逆なら別の図形（座標の丸めで 0° の区間が混ざるのは許す）
          if (n0 >= 2 && Math.abs(avg) > (3 * Math.PI) / 180 && Math.abs(t) > (10 * Math.PI) / 180 && Math.sign(t) !== Math.sign(avg)) continue;
          const dev = Math.abs(t - avg);
          if (dev < bestDev) bestDev = dev, best = j, bestNxt = nxt;
        }
        if (best < 0 || !bestNxt) break;
        used[best] = 1;
        pts.push(bestNxt);
      }
    }
    if (pts.length < 6) continue;
    const c = circumcenter(pts[0], pts[Math.floor(pts.length / 3)], pts[Math.floor((pts.length * 2) / 3)]);
    if (!c) continue;
    const r = dist(c, pts[0]);
    if (r < minR || r > maxR) continue;
    if (pts.some((q) => Math.abs(dist(q, c) - r) > r * 0.06)) continue;
    out.push({ c, r, pts });
  }
  return out;
}

/** 円弧（ベジェ）と折れ線の断片をまとめて、ほぼ一周している円を探す */
export function findCircles(arcs: Arc[], segs: Seg[] = [], minR = 200, maxR = 4000): Circle[] {
  const frags: Frag[] = [];
  for (const a of arcs) {
    if (a.poly) continue; // 折れ線から復元した円弧は、元の折れ線から直接拾う
    const m = bez(a, 0.5);
    const c = circumcenter(a.p0, m, a.p3);
    if (!c) continue;
    const r = dist(c, a.p0);
    if (r < minR || r > maxR) continue;
    if (Math.abs(dist(c, bez(a, 0.25)) - r) > r * 0.06 || Math.abs(dist(c, bez(a, 0.75)) - r) > r * 0.06) continue;
    const pts: Vec2[] = [];
    for (let t = 0; t <= 1.0001; t += 0.1) pts.push(bez(a, t));
    frags.push({ c, r, pts });
  }
  frags.push(...polylineFrags(segs, minR, maxR));
  const cell = 150;
  const grid = new Map<string, number[]>();
  frags.forEach((f, i) => {
    const k = `${Math.floor(f.c.x / cell)},${Math.floor(f.c.y / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  });
  const used = new Uint8Array(frags.length);
  const out: Circle[] = [];
  for (let i = 0; i < frags.length; i++) {
    if (used[i]) continue;
    const f0 = frags[i];
    const tol = Math.max(40, f0.r * 0.08);
    const group: Frag[] = [];
    const gx = Math.floor(f0.c.x / cell);
    const gy = Math.floor(f0.c.y / cell);
    const reach = Math.ceil(tol / cell);
    for (let dx = -reach; dx <= reach; dx++)
      for (let dy = -reach; dy <= reach; dy++)
        for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (used[j]) continue;
          const o = frags[j];
          if (dist(o.c, f0.c) <= tol && Math.abs(o.r - f0.r) <= tol) group.push(o), (used[j] = 1);
        }
    if (!group.length) continue;
    const c = { x: group.reduce((s, g) => s + g.c.x, 0) / group.length, y: group.reduce((s, g) => s + g.c.y, 0) / group.length };
    const r = group.reduce((s, g) => s + g.r, 0) / group.length;
    const sectors = new Set<number>();
    for (const g of group) for (const q of g.pts) sectors.add(Math.floor(((Math.atan2(q.y - c.y, q.x - c.x) + Math.PI) / (2 * Math.PI)) * 24) % 24);
    const cover = sectors.size / 24;
    if (cover < 0.75) continue;
    out.push({ c, r, cover, arcs: group.length });
  }
  return out;
}

/** 同じ向きで端がつながる線分をひとつの長い線にまとめる（分割して描かれた矢印の軸など） */
export function mergeCollinear(segs: Seg[]): Seg[] {
  const at = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const q of [s.a, s.b]) {
      const k = key3(q);
      if (!at.has(k)) at.set(k, []);
      at.get(k)!.push(i);
    }
  });
  const near = (q: Vec2) => {
    const out: number[] = [];
    const kx = Math.round(q.x / 3);
    const ky = Math.round(q.y / 3);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of at.get(`${kx + dx},${ky + dy}`) ?? []) out.push(i);
    return out;
  };
  const used = new Uint8Array(segs.length);
  const out: Seg[] = [];
  for (let i0 = 0; i0 < segs.length; i0++) {
    if (used[i0]) continue;
    used[i0] = 1;
    let a = segs[i0].a;
    let b = segs[i0].b;
    let merged = false;
    for (const dir of [1, -1]) {
      for (let guard = 0; guard < 200; guard++) {
        const end = dir === 1 ? b : a;
        const other = dir === 1 ? a : b;
        const l0 = dist(a, b);
        const ux = (end.x - other.x) / l0;
        const uy = (end.y - other.y) / l0;
        let found = -1;
        let nxt: Vec2 | null = null;
        for (const j of near(end)) {
          if (used[j]) continue;
          const sj = segs[j];
          const dA = dist(sj.a, end);
          const dB = dist(sj.b, end);
          if (Math.min(dA, dB) > 5) continue;
          const q = dA < dB ? sj.b : sj.a;
          const lj = dist(q, end);
          if (lj < 3) continue;
          const cos = ((q.x - end.x) * ux + (q.y - end.y) * uy) / lj;
          if (cos < 0.9962) continue; // 5° 以内で同じ向きに続く（手描き風の折れ線も拾う）
          found = j;
          nxt = q;
          break;
        }
        if (found < 0 || !nxt) break;
        used[found] = 1;
        merged = true;
        if (dir === 1) b = nxt;
        else a = nxt;
      }
    }
    out.push(merged ? { ...segs[i0], a, b } : segs[i0]);
  }
  return out;
}

/** 線分の端 E に付く矢じり（短い斜め線）の本数。axis は線の向き（E へ向かう単位ベクトル） */
function featherCount(segs: Seg[], E: Vec2, axis: Vec2, L: number, self: Seg): number {
  let n = 0;
  for (const s of segs) {
    if (s === self) continue;
    const sl = len(s);
    if (sl < L * 0.05 || sl > L * 0.45) continue;
    const dA = dist(s.a, E);
    const dB = dist(s.b, E);
    const near = Math.min(dA, dB);
    if (near > Math.max(60, L * 0.08)) continue;
    // 端 E から離れる向きの単位ベクトル
    const far = dA < dB ? s.b : s.a;
    const vx = (far.x - E.x) / sl;
    const vy = (far.y - E.y) / sl;
    // 矢じりは軸の逆向きへ 15°〜75° 開く
    const cos = -(vx * axis.x + vy * axis.y);
    if (cos > 0.26 && cos < 0.97) n++;
  }
  return n;
}

/** 端 E の近くにある塗りつぶしの矢じり（3〜5 頂点の小さな多角形） */
function solidHeadNear(fills: { polygon: Vec2[] }[], E: Vec2, L: number): boolean {
  for (const f of fills) {
    if (f.polygon.length < 3 || f.polygon.length > 6) continue;
    if (!f.polygon.some((q) => dist(q, E) < Math.max(80, L * 0.08))) continue;
    const xs = f.polygon.map((q) => q.x);
    const ys = f.polygon.map((q) => q.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    if (Math.max(w, h) < L * 0.5 && Math.max(w, h) > L * 0.04) return true;
  }
  return false;
}

/** 1 ページ分の方位記号候補 */
export function northCandidates(p: PageLike, trace?: string[]): NorthCandidate[] {
  const out: NorthCandidate[] = [];
  const segs = p.segs.filter((s) => !s.dashed);
  const lines = mergeCollinear(segs);
  const labels = p.texts.filter((t) => LABEL.test(t.str.trim()));
  const labelWeight = (t: MmText) => (/真北|NORTH/i.test(t.str) ? 6 : 4);
  const angleTexts = p.texts
    .map((t) => ({ t, m: ANGLE_TEXT.exec(t.str.trim().replace(/[−＋]/g, (c) => (c === '−' ? '-' : '+'))) }))
    .filter((o): o is { t: MmText; m: RegExpExecArray } => !!o.m)
    .map((o) => ({ t: o.t, deg: norm(parseFloat(o.m[1])), signed: /^[-+]/.test(o.m[1]) }));
  // 同心円が 3 本以上あるのは植栽・丸テーブルなどの記号（方位記号は 1〜2 本）
  const all = findCircles(p.arcs, segs);
  const circles = all.filter((c) => all.filter((o) => dist(o.c, c.c) < Math.max(40, c.r * 0.08)).length <= 2);
  for (const c of circles) trace?.push(`circle c=(${c.c.x.toFixed(0)},${c.c.y.toFixed(0)}) r=${c.r.toFixed(0)} cover=${c.cover.toFixed(2)} n=${c.arcs}`);
  /** 端 E に、矢じり以外の長い線がつながっているか（壁・外形線・家具の一部なら方位記号ではない） */
  const joinedAt = (E: Vec2, L: Seg, l: number) => {
    const ux = (L.b.x - L.a.x) / l;
    const uy = (L.b.y - L.a.y) / l;
    return segs.some((s) => {
      if (s === L) return false;
      const sl = len(s);
      if (sl < Math.max(300, l * 0.25)) return false;
      if (dist(s.a, E) > 30 && dist(s.b, E) > 30) return false;
      const cos = Math.abs(((s.b.x - s.a.x) * ux + (s.b.y - s.a.y) * uy) / sl);
      return cos < 0.999; // 同じ向きの続き（分割された軸）は除く
    });
  };

  /** 中心 c の周り（rIn〜rOut の環）にある線の端点の数。方位記号は単独で置かれるので少ない */
  const clutter = (c: Vec2, rIn: number, rOut: number, exclude: Set<Seg>) => {
    let n = 0;
    for (const s of segs) {
      if (exclude.has(s)) continue;
      for (const q of [s.a, s.b]) {
        const d = dist(q, c);
        if (d >= rIn && d <= rOut) n++;
      }
    }
    return n;
  };
  // 2〜3. 円を使う記号
  for (const c of circles) {
    const onRing = (q: Vec2) => Math.abs(dist(q, c.c) - c.r) < c.r * 0.12;
    const nearLabel = labels.filter((l) => dist(l, c.c) < Math.max(2.5 * c.r, 1500) + c.r);
    // 2. 内接する二等辺三角形（頂点＝北）
    const chords = lines.filter((s) => onRing(s.a) && onRing(s.b) && len(s) > c.r * 0.5);
    let tri: NorthCandidate | null = null;
    for (let i = 0; i < chords.length && !tri; i++)
      for (let j = i + 1; j < chords.length && !tri; j++) {
        const A = chords[i];
        const B = chords[j];
        const pairs: [Vec2, Vec2, Vec2][] = [];
        for (const pa of [A.a, A.b]) for (const pb of [B.a, B.b]) if (dist(pa, pb) < c.r * 0.06) pairs.push([pa, pa === A.a ? A.b : A.a, pb === B.a ? B.b : B.a]);
        for (const [apex, fa, fb] of pairs) {
          const la = dist(apex, fa);
          const lb = dist(apex, fb);
          if (Math.abs(la - lb) > Math.max(la, lb) * 0.12) continue;
          const base = dist(fa, fb);
          if (base > Math.min(la, lb) * 0.8 || base < c.r * 0.15) continue;
          const mid = { x: (fa.x + fb.x) / 2, y: (fa.y + fb.y) / 2 };
          // 方位記号は円と三角形だけ。中に他の線があれば便器・洗面などの器具
          if (clutter(c.c, 0, c.r * 0.9, new Set([A, B])) > 2) continue;
          tri = { deg: degOf(apex.x - mid.x, apex.y - mid.y), score: 12 + (nearLabel.length ? 3 : 0), how: 'triangle', at: c.c };
        }
      }
    if (tri) {
      out.push(tri);
      continue;
    }
    // 3. 中心を通る長い線（矢羽・矢じり・文字のある側が北）。線の両端は自由（壁や家具の一部ではない）
    let bestAxis: NorthCandidate | null = null;
    for (const L of lines) {
      const l = len(L);
      if (l < c.r * 1.5 || l > c.r * 8) continue;
      const ux = (L.b.x - L.a.x) / l;
      const uy = (L.b.y - L.a.y) / l;
      const d = Math.abs((c.c.x - L.a.x) * uy - (c.c.y - L.a.y) * ux);
      if (d > c.r * 0.15) continue;
      const t = (c.c.x - L.a.x) * ux + (c.c.y - L.a.y) * uy;
      if (t < -c.r * 0.2 || t > l + c.r * 0.2) continue;
      if (joinedAt(L.a, L, l) || joinedAt(L.b, L, l)) continue;
      // 円のまわり（1.3r〜2.5r）に他の線の端が多ければ家具・器具
      trace?.push(`axis? c=(${c.c.x.toFixed(0)},${c.c.y.toFixed(0)}) r=${c.r.toFixed(0)} L=${l.toFixed(0)}`);
      const ends: [Vec2, Vec2][] = [
        [L.a, { x: -ux, y: -uy }],
        [L.b, { x: ux, y: uy }],
      ];
      const sc = ends.map(([E, ax]) => {
        if (dist(E, c.c) < c.r * 1.2) return -1; // 円の中（すぐ外）で終わる端は北ではない
        let s = 0;
        const feathers = Math.min(2, featherCount(segs, E, ax, l, L));
        s += feathers * 2;
        let evidence = feathers > 0;
        if (solidHeadNear(p.fills, E, l)) s += 3;
        for (const lb of nearLabel)
          if (dist(lb, E) < Math.max(c.r * 2.5, lb.size * 5) && dist(lb, E) < dist(lb, E === L.a ? L.b : L.a)) s += labelWeight(lb), (evidence = true);
        for (const a of angleTexts) if (dist(a.t, E) < Math.max(c.r * 3, a.t.size * 8)) s += 2, (evidence = true);
        // 塗りの矢じりだけでは器具の記号と区別がつかない。矢羽か文字が要る
        return evidence ? s : 0;
      });
      if (Math.max(...sc) <= 0 || sc[0] === sc[1]) continue;
      const k = sc[0] > sc[1] ? 0 : 1;
      const E = ends[k][0];
      const cand: NorthCandidate = { deg: degOf(E.x - c.c.x, E.y - c.c.y), score: 8 + sc[k], how: 'axis', at: c.c };
      if (!bestAxis || cand.score > bestAxis.score) bestAxis = cand;
    }
    if (bestAxis) {
      out.push(bestAxis);
      continue;
    }
    // 円のそばに文字だけ
    for (const lb of nearLabel) if (dist(lb, c.c) > c.r * 0.8) out.push({ deg: degOf(lb.x - c.c.x, lb.y - c.c.y), score: 4, how: 'labelCircle', at: c.c });
  }

  // 4. 「真北」の文字＋長い線（文字に近い端が北）
  for (const lb of labels) {
    const R = Math.max(lb.size * 4, 800);
    let best: NorthCandidate | null = null;
    for (const L of lines) {
      const l = len(L);
      if (l < 600 || l > 20000) continue;
      const dA = dist(L.a, lb);
      const dB = dist(L.b, lb);
      if (Math.min(dA, dB) > R) continue;
      if (Math.abs(dA - dB) < l * 0.5) continue; // 文字が線の中ほどにある（寸法線など）
      const E = dA < dB ? L.a : L.b;
      const F = dA < dB ? L.b : L.a;
      const ax = { x: (E.x - F.x) / l, y: (E.y - F.y) / l };
      const feathers = Math.min(2, featherCount(segs, E, ax, l, L));
      const solid = solidHeadNear(p.fills, E, l);
      // 矢じりの無い長い線は壁や寸法線のことが多い。「真北」の文字がほぼ端にあるときだけ低い点で拾う
      let score = feathers * 3 + (solid ? 4 : 0);
      if (score === 0) {
        if (Math.min(dA, dB) > lb.size * 2.5 || labelWeight(lb) < 6) continue;
        score = 1;
      }
      // 線の端に別の長い線がつながっていれば壁・外形線（方位記号は単独）
      if (joinedAt(F, L, l) || joinedAt(E, L, l)) score -= 3;
      if (score <= 0) continue;
      trace?.push(`labelArrow? lb=(${lb.x.toFixed(0)},${lb.y.toFixed(0)}) L=${l.toFixed(0)} feathers=${feathers}`);
      const cand: NorthCandidate = { deg: degOf(ax.x, ax.y), score: 3 + score + (labelWeight(lb) - 4), how: 'labelArrow', at: { x: lb.x, y: lb.y } };
      if (!best || cand.score > best.score) best = cand;
    }
    if (best) out.push(best);
  }

  // 1. 角度の文字（「真北」の文字か円が近くにあるもの）。符号は図形の向きと合わせる（「-」が別の文字や線で描かれて落ちることがある）
  for (const a of angleTexts) {
    const geo = out.filter((o) => o.how !== 'labelCircle' && dist(o.at, a.t) < Math.max(4000, a.t.size * 15) && Math.abs(Math.abs(o.deg) - Math.abs(a.deg)) <= 4);
    const near = geo.length > 0 || labels.some((l) => dist(l, a.t) < Math.max(3000, a.t.size * 12)) || circles.some((c) => dist(c.c, a.t) < Math.max(3000, c.r * 4));
    if (!near) continue;
    let deg = a.deg;
    const g = geo[0];
    if (g && g.deg !== 0 && (!a.signed || Math.sign(g.deg) !== Math.sign(deg))) deg = Math.sign(g.deg) * Math.abs(deg);
    out.push({ deg: norm(deg), score: 20, how: 'angleText', at: { x: a.t.x, y: a.t.y } });
  }

  // 5. 文字の近くの図形の重心 → 文字（最後の手段）
  if (!out.length)
    for (const lb of labels) {
      const R = lb.size * 5;
      const pts: Vec2[] = [];
      for (const s of segs) for (const q of [s.a, s.b]) if (dist(q, lb) < R) pts.push(q);
      for (const a of p.arcs) for (const q of [a.p0, a.p3]) if (dist(q, lb) < R) pts.push(q);
      for (const f of p.fills) for (const q of f.polygon) if (dist(q, lb) < R) pts.push(q);
      if (pts.length < 3) continue;
      const cx = pts.reduce((s0, q) => s0 + q.x, 0) / pts.length;
      const cy = pts.reduce((s0, q) => s0 + q.y, 0) / pts.length;
      if (Math.hypot(lb.x - cx, lb.y - cy) < lb.size * 0.5) continue;
      out.push({ deg: degOf(lb.x - cx, lb.y - cy), score: 1, how: 'centroid', at: { x: lb.x, y: lb.y } });
    }
  return out.sort((a, b) => b.score - a.score);
}

/** 複数ページから真北を決める（いちばん確かな候補） */
export function pickNorth(pages: PageLike[]): NorthCandidate | null {
  let best: NorthCandidate | null = null;
  for (const p of pages) {
    const c = northCandidates(p)[0];
    if (c && (!best || c.score > best.score)) best = c;
  }
  return best;
}
