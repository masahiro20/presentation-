/**
 * 階段（踏面の平行線の繰り返し）の検出
 */
import type { Vec2 } from '../core/types';
import type { Seg } from './walls';

export interface StairCandidate {
  /** 軸平行な矩形 */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  treadCount: number;
  /** 踏面線の向き（踏面線が水平 → 'h'） */
  treadOrient: 'h' | 'v';
  flights: number;
}

interface Tread {
  o: number;
  t0: number;
  t1: number;
  orient: 'h' | 'v';
}

export function detectStairs(segs: Seg[], within: { minX: number; minY: number; maxX: number; maxY: number }): StairCandidate[] {
  const treads: Tread[] = [];
  for (const s of segs) {
    if (s.dashed) continue;
    const dx = s.b.x - s.a.x;
    const dy = s.b.y - s.a.y;
    const L = Math.hypot(dx, dy);
    if (L < 450 || L > 1600) continue;
    const mx = (s.a.x + s.b.x) / 2;
    const my = (s.a.y + s.b.y) / 2;
    if (mx < within.minX || mx > within.maxX || my < within.minY || my > within.maxY) continue;
    if (Math.abs(dy) < L * 0.01) treads.push({ o: my, t0: Math.min(s.a.x, s.b.x), t1: Math.max(s.a.x, s.b.x), orient: 'h' });
    else if (Math.abs(dx) < L * 0.01) treads.push({ o: mx, t0: Math.min(s.a.y, s.b.y), t1: Math.max(s.a.y, s.b.y), orient: 'v' });
  }
  // 同じ区間を持つ線の等間隔の並びを探す
  const runs: { orient: 'h' | 'v'; items: Tread[] }[] = [];
  for (const orient of ['h', 'v'] as const) {
    const ts = treads.filter((t) => t.orient === orient).sort((a, b) => a.o - b.o);
    const used = new Set<Tread>();
    for (const t of ts) {
      if (used.has(t)) continue;
      const chain = [t];
      let last = t;
      for (const c of ts) {
        if (c.o <= last.o + 1) continue;
        const sp = c.o - last.o;
        if (sp > 330) break;
        if (sp < 150) continue;
        const ov = Math.min(c.t1, last.t1) - Math.max(c.t0, last.t0);
        if (ov < Math.min(c.t1 - c.t0, last.t1 - last.t0) * 0.8) continue;
        // 等間隔性
        if (chain.length >= 2) {
          const prevSp = chain[chain.length - 1].o - chain[chain.length - 2].o;
          if (Math.abs(sp - prevSp) > 25) continue;
        }
        chain.push(c);
        last = c;
      }
      if (chain.length >= 4) {
        chain.forEach((c) => used.add(c));
        runs.push({ orient, items: chain });
      }
    }
  }
  // 近接する並びを1つの階段にまとめる
  const boxes = runs.map((r) => {
    const os = r.items.map((i) => i.o);
    const t0 = Math.min(...r.items.map((i) => i.t0));
    const t1 = Math.max(...r.items.map((i) => i.t1));
    return r.orient === 'h'
      ? { minX: t0, maxX: t1, minY: Math.min(...os), maxY: Math.max(...os), n: r.items.length, orient: r.orient }
      : { minX: Math.min(...os), maxX: Math.max(...os), minY: t0, maxY: t1, n: r.items.length, orient: r.orient };
  });
  const out: StairCandidate[] = [];
  const used = new Set<number>();
  boxes.forEach((b, i) => {
    if (used.has(i)) return;
    const merged = { ...b, flights: 1 };
    used.add(i);
    boxes.forEach((c, j) => {
      if (used.has(j)) return;
      const gapX = Math.max(0, c.minX - merged.maxX, merged.minX - c.maxX);
      const gapY = Math.max(0, c.minY - merged.maxY, merged.minY - c.maxY);
      if (gapX < 350 && gapY < 350) {
        merged.minX = Math.min(merged.minX, c.minX);
        merged.minY = Math.min(merged.minY, c.minY);
        merged.maxX = Math.max(merged.maxX, c.maxX);
        merged.maxY = Math.max(merged.maxY, c.maxY);
        merged.n += c.n;
        merged.flights++;
        used.add(j);
      }
    });
    out.push({
      minX: merged.minX,
      minY: merged.minY,
      maxX: merged.maxX,
      maxY: merged.maxY,
      treadCount: merged.n,
      treadOrient: merged.orient,
      flights: merged.flights,
    });
  });
  return out;
}

type Side = 'n' | 's' | 'e' | 'w';

/**
 * 昇り口を図面の矢印（UP／DN の矢印線）から読む。御社の図面（ARCHITREND）は昇り口に UP（上階は DN）の文字を置き、
 * 階段の中を矢印の線が昇る向きに走り、矢じり（短い 2 本の線）が先端につく。
 * 矢印の始点には小さな丸が付き、その横に UP／DN の文字が置かれる（丸は細かすぎて線として残らないので文字を使う）。
 *  1. UP／DN の文字が階段のそばにあれば、文字にいちばん近い辺
 *  2. 文字が無ければ、階段の中の長い線（矢印の軸）の端の矢じりを探し、軸をたどった反対の端
 *     （ジグザグの切断線も短い斜め線なので、文字が無いときだけ使う）
 * 読めなければ null（壁の少ない辺にフォールバック）
 */
export function stairEntryFromArrow(r: { minX: number; minY: number; maxX: number; maxY: number }, segs: Seg[], marks: Vec2[]): Side | null {
  const pad = 160;
  const inside = (p: Vec2) => p.x >= r.minX - pad && p.x <= r.maxX + pad && p.y >= r.minY - pad && p.y <= r.maxY + pad;
  const W = r.maxX - r.minX;
  const H = r.maxY - r.minY;
  const sideOf = (p: Vec2): Side => {
    const d: [Side, number][] = [
      ['n', p.y - r.minY],
      ['s', r.maxY - p.y],
      ['w', p.x - r.minX],
      ['e', r.maxX - p.x],
    ];
    return d.sort((a, b) => a[1] - b[1])[0][0];
  };
  const L = (q: { a: Vec2; b: Vec2 }) => Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y);
  const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) <= 45;
  const inner = segs.filter((q) => !q.dashed && inside(q.a) && inside(q.b));
  // 軸: 階段の短辺の 6 割以上の長さの線（踏面線は短く多数、軸は少数）
  // 軸: 階段の短辺の 35% 以上（折り返しの最後の軸は短い）。踏面線も入るが、端に矢じりが無ければ使われない
  const axes = inner.filter((q) => L(q) >= Math.max(450, Math.min(W, H) * 0.35));
  // 矢じり: 長さ 60〜420、軸の端に接し、軸と 15〜75° をなす線
  const heads = inner.filter((q) => L(q) >= 60 && L(q) <= 420);
  const headAt = (ax: Seg, end: Vec2): number => {
    const dx = (ax.b.x - ax.a.x) / (L(ax) || 1);
    const dy = (ax.b.y - ax.a.y) / (L(ax) || 1);
    let n = 0;
    for (const h of heads) {
      if (h === ax) continue;
      const touch = near(h.a, end) ? h.b : near(h.b, end) ? h.a : null;
      if (!touch) continue;
      const hl = Math.hypot(touch.x - end.x, touch.y - end.y) || 1;
      const c = Math.abs(((touch.x - end.x) * dx + (touch.y - end.y) * dy) / hl);
      if (c >= 0.25 && c <= 0.97) n++;
    }
    return n;
  };
  // 文字（UP／DN）の位置
  const m = marks
    .map((t) => ({ t, d: Math.hypot(Math.max(0, r.minX - t.x, t.x - r.maxX), Math.max(0, r.minY - t.y, t.y - r.maxY)) }))
    .filter((q) => q.d <= 500)
    .sort((a, b) => a.d - b.d)[0];
  if (m) return sideOf(m.t);
  let best: { tail: Vec2; n: number } | null = null;
  for (const ax of axes) {
    for (const [end, other] of [
      [ax.a, ax.b],
      [ax.b, ax.a],
    ] as [Vec2, Vec2][]) {
      const n = headAt(ax, end);
      if (!n) continue;
      // 折り返し・かね折れ: 軸がつながっていれば、その先の端まで戻る（昇り口は最初の軸の端）
      let tail = other;
      const used = new Set<Seg>([ax]);
      for (let hop = 0; hop < 4; hop++) {
        const next = axes.find((q) => !used.has(q) && (near(q.a, tail) || near(q.b, tail)));
        if (!next) break;
        used.add(next);
        tail = near(next.a, tail) ? next.b : next.a;
      }
      if (!best || n > best.n) best = { tail, n };
    }
  }
  return best ? sideOf(best.tail) : null;
}

export function rectPoly(r: { minX: number; minY: number; maxX: number; maxY: number }): Vec2[] {
  return [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ];
}
