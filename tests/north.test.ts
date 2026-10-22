import { describe, expect, it } from 'vitest';
import { northCandidates, findCircles, mergeCollinear } from '../src/parser/north';
import type { Seg, Arc } from '../src/parser/walls';

const seg = (ax: number, ay: number, bx: number, by: number): Seg => ({ a: { x: ax, y: ay }, b: { x: bx, y: by }, width: 0.2, dashed: false, source: 'stroke' } as Seg);
/** 円をベジェ 4 本で */
function circleArcs(cx: number, cy: number, r: number): Arc[] {
  const k = 0.5523 * r;
  const P = (x: number, y: number) => ({ x: cx + x, y: cy + y });
  return [
    { p0: P(r, 0), p1: P(r, k), p2: P(k, r), p3: P(0, r) },
    { p0: P(0, r), p1: P(-k, r), p2: P(-r, k), p3: P(-r, 0) },
    { p0: P(-r, 0), p1: P(-r, -k), p2: P(-k, -r), p3: P(0, -r) },
    { p0: P(0, -r), p1: P(k, -r), p2: P(r, -k), p3: P(r, 0) },
  ];
}
/** 円を短い線分の折れ線で */
function circlePoly(cx: number, cy: number, r: number, n = 120): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    out.push(seg(Math.round(cx + r * Math.cos(a0)), Math.round(cy + r * Math.sin(a0)), Math.round(cx + r * Math.cos(a1)), Math.round(cy + r * Math.sin(a1))));
  }
  return out;
}
const text = (str: string, x: number, y: number, size = 270) => ({ str, x, y, size, angle: 0 });

describe('方位記号の読み取り', () => {
  it('円＋内接する細い三角形（頂点が北）', () => {
    // 頂点を少し西（-10°）へ
    const cx = 5000;
    const cy = 5000;
    const r = 1000;
    const apexA = (-10 * Math.PI) / 180;
    const apex = { x: cx + r * Math.sin(apexA), y: cy - r * Math.cos(apexA) };
    const baseA = apexA + Math.PI;
    const fa = { x: cx + r * Math.sin(baseA - 0.4), y: cy - r * Math.cos(baseA - 0.4) };
    const fb = { x: cx + r * Math.sin(baseA + 0.4), y: cy - r * Math.cos(baseA + 0.4) };
    const segs = [...circlePoly(cx, cy, r), seg(apex.x, apex.y, fa.x, fa.y), seg(apex.x, apex.y, fb.x, fb.y), seg(fa.x, fa.y, fb.x, fb.y)];
    const c = northCandidates({ segs, arcs: [], texts: [], fills: [] });
    expect(c[0]?.how).toBe('triangle');
    expect(Math.abs(c[0].deg - -10)).toBeLessThanOrEqual(2);
  });

  it('「真北」の文字＋矢じり付きの長い線（文字に近い端が北）', () => {
    // 線は (5000,9000)→(5200,6000)（少し東へ傾く ≈ +4°）、矢じりは上端
    const segs = [seg(5000, 9000, 5200, 6000), seg(5200, 6000, 4950, 6450), seg(5200, 6000, 5450, 6480), seg(3800, 8000, 6400, 8000)];
    const c = northCandidates({ segs, arcs: [], texts: [text('真北', 5200, 5700)], fills: [] });
    expect(c[0]?.how).toBe('labelArrow');
    expect(Math.abs(c[0].deg - 4)).toBeLessThanOrEqual(1);
  });

  it('分割された矢印の軸もつないで読む', () => {
    const segs = [seg(5000, 9000, 5066, 8000), seg(5066, 8000, 5133, 7000), seg(5133, 7000, 5200, 6000), seg(5200, 6000, 4950, 6450)];
    const c = northCandidates({ segs, arcs: [], texts: [text('真北', 5200, 5700)], fills: [] });
    expect(c[0]?.how).toBe('labelArrow');
    expect(Math.abs(c[0].deg - 4)).toBeLessThanOrEqual(1);
    expect(mergeCollinear(segs).some((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) > 2900)).toBe(true);
  });

  it('角度の文字（ARCHITREND「-9.7399度」）を最優先、符号は図形に合わせる', () => {
    const cx = 5000;
    const cy = 8000;
    const arcs = [...circleArcs(cx, cy, 300), ...circleArcs(cx, cy, 560)];
    // 中心を通る長い線（北端は上、西へ 10°）
    const top = { x: cx - 1600 * Math.sin((10 * Math.PI) / 180), y: cy - 1600 * Math.cos((10 * Math.PI) / 180) };
    const bot = { x: cx + 1600 * Math.sin((10 * Math.PI) / 180), y: cy + 1600 * Math.cos((10 * Math.PI) / 180) };
    const segs = [seg(bot.x, bot.y, top.x, top.y), seg(top.x, top.y, top.x - 200, top.y + 420)];
    // 符号の落ちた「9.7399度」でも、図形が西向きなら -10
    const c = northCandidates({ segs, arcs, texts: [text('真北', top.x, top.y - 300, 135), text('9.7399度', cx + 400, cy - 900, 124)], fills: [] });
    expect(c[0]?.how).toBe('angleText');
    expect(c[0].deg).toBe(-10);
  });

  it('同心円が多い記号（植栽・丸テーブル）は方位記号にしない', () => {
    const cx = 5000;
    const cy = 5000;
    const arcs = [300, 400, 500, 600, 700].flatMap((r) => circleArcs(cx, cy, r));
    const segs = [seg(cx, cy + 1500, cx, cy - 1500), seg(cx, cy - 1500, cx - 150, cy - 1200), seg(cx, cy - 1500, cx + 150, cy - 1200)];
    const c = northCandidates({ segs, arcs, texts: [], fills: [] });
    expect(c.length).toBe(0);
  });

  it('findCircles: ベジェ 4 本の円と折れ線の円', () => {
    const a = findCircles(circleArcs(1000, 1000, 500), []);
    expect(a.length).toBe(1);
    expect(Math.abs(a[0].r - 500)).toBeLessThan(10);
    const b = findCircles([], circlePoly(3000, 3000, 800));
    expect(b.length).toBe(1);
    expect(Math.abs(b[0].r - 800)).toBeLessThan(10);
    expect(b[0].cover).toBeGreaterThan(0.9);
  });
});
