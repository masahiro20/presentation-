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

export function rectPoly(r: { minX: number; minY: number; maxX: number; maxY: number }): Vec2[] {
  return [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ];
}
