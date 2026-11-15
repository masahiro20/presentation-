// 斜めに振れた棟の屋根の升目（寺川様邸: 28.5° 振れた LDK の棟）
//  - 45° ではない長い斜めの辺は、辺に沿って升目を細かく切る（頂点だけで切ると大きな升目 2〜3 個になり、
//    「9 点のうち 3 点以上が中」の決まりで棟の角が丸ごと屋根なしになる）
//  - 辺の外 70cm までの升目にも屋根を掛ける（3D では辺から軒の出だけ外の線で切り落とすので、軒先がまっすぐになる）
//  - 45° の辺（隅切り・吉田様邸の LDK）と縦横だけの外形は、今までどおり頂点だけで升目を切る
import { describe, expect, it } from 'vitest';
import { cellIndex, gridOfLoops } from '../src/core/roofGrid';
import { insideLoops } from '../src/core/geometry';
import type { Vec2 } from '../src/core/types';

/** 中心 (cx, cy)・幅 w・奥行 h・角度 deg の四角形 */
function rotRect(cx: number, cy: number, w: number, h: number, deg: number): Vec2[] {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([u, v]) => ({ x: Math.round(cx + u * c - v * s), y: Math.round(cy + u * s + v * c) }));
}
const roofedAt = (g: ReturnType<typeof gridOfLoops>, p: Vec2): boolean => {
  const i = cellIndex(g.xs, p.x);
  const j = cellIndex(g.zs, p.y);
  return i >= 0 && j >= 0 && g.mask[j * g.nx + i] === 1;
};

describe('斜めに振れた棟の屋根の升目', () => {
  const poly = rotRect(10000, 8000, 9000, 7000, 28.5);

  it('棟の中はどこも屋根の升目に入る（角の三角が屋根なしにならない）', () => {
    const g = gridOfLoops([poly], []);
    let inside = 0;
    let missed = 0;
    for (let x = 3000; x <= 17000; x += 130)
      for (let y = 1000; y <= 15000; y += 130) {
        if (!insideLoops({ x, y }, [poly])) continue;
        inside++;
        if (!roofedAt(g, { x, y })) missed++;
      }
    expect(inside).toBeGreaterThan(3000);
    expect(missed).toBe(0);
  });

  it('辺の外 50cm までも屋根の升目に入り、1.5m より外には掛からない', () => {
    const g = gridOfLoops([poly], []);
    for (let i = 0; i < 4; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % 4];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      let nx = -(b.y - a.y) / L;
      let ny = (b.x - a.x) / L;
      if (insideLoops({ x: (a.x + b.x) / 2 + nx * 100, y: (a.y + b.y) / 2 + ny * 100 }, [poly])) [nx, ny] = [-nx, -ny];
      for (const f of [0.15, 0.3, 0.5, 0.7, 0.85]) {
        const m = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
        expect(roofedAt(g, { x: m.x + nx * 500, y: m.y + ny * 500 })).toBe(true);
        expect(roofedAt(g, { x: m.x + nx * 1500, y: m.y + ny * 1500 })).toBe(false);
      }
    }
  });

  it('辺に沿う升目は半間ほど（頂点だけの 3 × 3 より細かい）', () => {
    const g = gridOfLoops([poly], []);
    expect(g.nx).toBeGreaterThan(15);
    expect(g.nz).toBeGreaterThan(15);
  });

  it('45° の棟・縦横の棟は、今までどおり頂点だけで升目を切る', () => {
    const diamond = rotRect(10000, 8000, 8000, 8000, 45);
    const gd = gridOfLoops([diamond], []);
    expect(gd.nx).toBe(2);
    expect(gd.nz).toBe(2);
    const box = rotRect(10000, 8000, 9000, 7000, 0);
    const gb = gridOfLoops([box], []);
    expect(gb.nx).toBe(1);
    expect(gb.nz).toBe(1);
    expect(gb.mask[0]).toBe(1);
  });
});
