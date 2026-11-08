import { describe, expect, it } from 'vitest';
import { detectWalls, type Seg } from '../src/parser/walls';
import type { Vec2 } from '../src/core/types';

/** 塗りの長方形（壁）の 4 辺を fill の線分にする */
function fillRect(x0: number, y0: number, x1: number, y1: number): Seg[] {
  const P = (x: number, y: number): Vec2 => ({ x, y });
  const mk = (a: Vec2, b: Vec2): Seg => ({ a, b, width: 0, dashed: false, source: 'fill' });
  return [mk(P(x0, y0), P(x1, y0)), mk(P(x1, y0), P(x1, y1)), mk(P(x1, y1), P(x0, y1)), mk(P(x0, y1), P(x0, y0))];
}
const stroke = (x0: number, y0: number, x1: number, y1: number, width = 0.36): Seg => ({ a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, width, dashed: false, source: 'stroke' });

/**
 * ARCHITREND 風の家: 外周 4 壁（塗り 106）＋ 間仕切り壁（x=2000、y 0〜3000）。
 * 間仕切りに引込み戸: 開口 y 1000〜1840、戸袋 y 1840〜2640（戸は +y 側＝奥へ引き込む）
 */
function house(): Seg[] {
  const T = 106;
  const segs: Seg[] = [
    ...fillRect(0, 0, 4000, T), // 北
    ...fillRect(0, 3000 - T, 4000, 3000), // 南
    ...fillRect(0, 0, T, 3000), // 西
    ...fillRect(4000 - T, 0, 4000, 3000), // 東
    ...fillRect(2000 - T / 2, 0, 2000 + T / 2, 3000), // 間仕切り（塗りは開口の下にも続く）
  ];
  return segs;
}

describe('引込み戸（戸袋付き片引き戸）の読み取り', () => {
  it('白抜き（開口は全幅・戸袋は半幅の L 字）から、開口だけを建具にして戸袋は壁のまま残す', () => {
    const segs = house();
    const cx = 2000;
    // 戸の線（開口の中は実線、戸袋の中は点線＝短い線の列）。戸の通る溝は +x 側の半分
    segs.push(stroke(cx + 26, 1000, cx + 26, 1840));
    for (let y = 1860; y < 2640; y += 100) segs.push(stroke(cx + 26, y, cx + 26, y + 50));
    // L 字の白抜き: 開口 y 1000〜1840 は全幅、戸袋 y 1840〜2640 は x 2000〜2053 の半幅
    const mask: Vec2[] = [
      { x: cx - 53, y: 1000 },
      { x: cx + 53, y: 1000 },
      { x: cx + 53, y: 2640 },
      { x: cx, y: 2640 },
      { x: cx, y: 1840 },
      { x: cx - 53, y: 1840 },
    ];
    const det = detectWalls(segs, [], {}, [mask]);
    // 間仕切りの軸（縦）の開口
    const ops = det.openings.filter((o) => Math.abs(Math.abs(o.o) - cx) < 20);
    expect(ops.length).toBe(1);
    const op = ops[0];
    const grp = det.groups[op.g];
    const ys = [op.t0, op.t1].map((t) => grp.u.y * t).sort((a, b) => a - b);
    expect(ys[0]).toBeGreaterThan(900);
    expect(ys[1]).toBeLessThan(1950);
    expect(op.t1 - op.t0).toBeGreaterThan(700);
    expect(op.t1 - op.t0).toBeLessThan(950);
    // 戸袋は +y 側（u の向きで言い直す）
    expect(op.pocketSide).toBe(grp.u.y > 0 ? 1 : -1);
    // 戸袋の区間（y 1900〜2600）は壁片として残る
    const pieces = det.pieces.filter((p) => p.g === op.g && Math.abs(Math.abs(p.o) - cx) < 20);
    const covers = (y: number) => pieces.some((p) => Math.min(grp.u.y * p.t0, grp.u.y * p.t1) <= y && Math.max(grp.u.y * p.t0, grp.u.y * p.t1) >= y);
    expect(covers(2000)).toBe(true);
    expect(covers(2500)).toBe(true);
    expect(covers(1400)).toBe(false);
  });

  it('白抜きが無くても、点線の戸と戸袋の溝の線があれば戸袋を壁のまま残す', () => {
    const segs = house();
    const cx = 2000;
    // 戸の線（開口は実線・戸袋は点線）は壁芯、戸袋の溝の線は芯から ±25
    segs.push(stroke(cx, 1000, cx, 1840));
    for (let y = 1860; y < 2640; y += 100) segs.push(stroke(cx, y, cx, y + 50));
    segs.push(stroke(cx - 25, 1840, cx - 25, 2640, 0.48));
    segs.push(stroke(cx + 25, 1840, cx + 25, 2640, 0.48));
    const det = detectWalls(segs, [], {}, []);
    const ops = det.openings.filter((o) => Math.abs(Math.abs(o.o) - cx) < 20);
    expect(ops.length).toBe(1);
    const op = ops[0];
    expect(op.t1 - op.t0).toBeGreaterThan(700);
    expect(op.t1 - op.t0).toBeLessThan(950);
    const grp = det.groups[op.g];
    expect(op.pocketSide).toBe(grp.u.y > 0 ? 1 : -1);
  });

  it('全幅の白抜きの中の点線（片引き窓の FIX の前に重なる戸）は戸袋ではなく、開口は 1 つのまま', () => {
    const segs = house();
    const cx = 2000;
    // 開口 y 600〜3000-106 全幅の白抜き。戸（実線 600〜1400）と、その先に点線（1420〜2200）、FIX の線
    segs.push(stroke(cx - 20, 600, cx - 20, 1400));
    for (let y = 1420; y < 2200; y += 100) segs.push(stroke(cx - 20, y, cx - 20, y + 50));
    segs.push(stroke(cx + 20, 1380, cx + 20, 2800));
    const mask: Vec2[] = [
      { x: cx - 53, y: 600 },
      { x: cx + 53, y: 600 },
      { x: cx + 53, y: 2800 },
      { x: cx - 53, y: 2800 },
    ];
    const det = detectWalls(segs, [], {}, [mask]);
    const ops = det.openings.filter((o) => Math.abs(Math.abs(o.o) - cx) < 20);
    expect(ops.length).toBe(1);
    expect(ops[0].t1 - ops[0].t0).toBeGreaterThan(2000);
    expect(ops[0].pocketSide).toBeUndefined();
  });
});
