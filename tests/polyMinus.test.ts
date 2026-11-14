import { describe, it, expect } from 'vitest';
import { polygonMinusPolygons } from '../src/core/polyMinus';
import type { Vec2 } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const area = (poly: Vec2[]) => Math.abs(poly.reduce((s, p, i) => s + p.x * poly[(i + 1) % poly.length].y - poly[(i + 1) % poly.length].x * p.y, 0)) / 2;
const total = (pieces: Vec2[][]) => pieces.reduce((s, p) => s + area(p), 0);
const SQ = [P(0, 0), P(4000, 0), P(4000, 3000), P(0, 3000)];

describe('polygonMinusPolygons（多角形から穴を形どおりに引く）', () => {
  it('穴が無ければ、元の形の面積のまま', () => {
    expect(total(polygonMinusPolygons(SQ, []))).toBeCloseTo(12e6, 0);
  });

  it('四角い穴: 面積が穴のぶんだけ減る', () => {
    const hole = [P(1000, 1000), P(2000, 1000), P(2000, 2000), P(1000, 2000)];
    expect(total(polygonMinusPolygons(SQ, [hole]))).toBeCloseTo(11e6, 0);
  });

  it('斜めの辺のある穴（三角形）: 縁は帯の近似ではなく、斜めの辺そのもの', () => {
    const tri = [P(1000, 500), P(3000, 500), P(1000, 2500)];
    const pieces = polygonMinusPolygons(SQ, [tri]);
    expect(total(pieces)).toBeCloseTo(12e6 - 2e6, 0);
    // 斜めの辺 (3000, 500)–(1000, 2500) の上に、その辺に沿った台形の辺がある（x + y = 3500）
    const onSlant = pieces.some((pc) => pc.some((p, i) => {
      const q = pc[(i + 1) % pc.length];
      return Math.abs(p.x + p.y - 3500) < 1e-6 && Math.abs(q.x + q.y - 3500) < 1e-6 && Math.abs(p.y - q.y) > 100;
    }));
    expect(onSlant).toBe(true);
  });

  it('丸い穴（24 角形）: 面積が合い、どの台形も穴の中に入らない', () => {
    const c = P(2000, 1500);
    const R = 900;
    const circle = Array.from({ length: 24 }, (_, i) => P(c.x + R * Math.cos((i / 24) * Math.PI * 2), c.y + R * Math.sin((i / 24) * Math.PI * 2)));
    const pieces = polygonMinusPolygons(SQ, [circle]);
    expect(total(pieces)).toBeCloseTo(12e6 - area(circle), 0);
    for (const pc of pieces) {
      const m = pc.reduce((s, p) => ({ x: s.x + p.x / pc.length, y: s.y + p.y / pc.length }), P(0, 0));
      expect(Math.hypot(m.x - c.x, m.y - c.y)).toBeGreaterThan(R * Math.cos(Math.PI / 24) - 1);
    }
  });

  it('はみ出した穴・重なった穴でも、残る面積は正しい', () => {
    const out = [P(3000, -500), P(5000, -500), P(5000, 1000), P(3000, 1000)]; // 右上の角をはみ出して欠く（1000 × 1000）
    const a = [P(500, 1500), P(1500, 1500), P(1500, 2500), P(500, 2500)];
    const b = [P(1000, 2000), P(2000, 2000), P(2000, 2800), P(1000, 2800)]; // a と 500 × 500 重なる
    const pieces = polygonMinusPolygons(SQ, [out, a, b]);
    expect(total(pieces)).toBeCloseTo(12e6 - 1e6 - (1e6 + 0.8e6 - 0.25e6), 0);
  });

  it('L 字の元の形（へこんだ角）でも分けられる', () => {
    const L = [P(0, 0), P(4000, 0), P(4000, 1500), P(2000, 1500), P(2000, 3000), P(0, 3000)];
    const hole = [P(500, 500), P(1500, 500), P(1000, 1200)];
    expect(total(polygonMinusPolygons(L, [hole]))).toBeCloseTo(9e6 - 0.35e6, 0);
  });
});
