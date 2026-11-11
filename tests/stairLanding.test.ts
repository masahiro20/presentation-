// 折り返し階段の降り口の前の踊り場を、階段の範囲に入れない（大崎様邸 2 階）
// 踊り場が階段と同じ区画（壁と開口で囲まれた階段室）に読めると、階段が踊り場いっぱいまで伸び、降り口が外壁側になっていた
import { describe, expect, it } from 'vitest';
import { buildFloor, detectPlans, type MmText, type PageMm } from '../src/parser/assemble';
import type { Seg } from '../src/parser/walls';
import type { Vec2 } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const fillSegs = (poly: Vec2[]): Seg[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length], width: 0, dashed: false, source: 'fill' as const, color: '#808080' }));
const stroke = (x0: number, y0: number, x1: number, y1: number): Seg => ({ a: P(x0, y0), b: P(x1, y1), width: 0.2, dashed: false, source: 'stroke' });
const text = (str: string, x: number, y: number, size = 300): MmText => ({ str, x, y, size, angle: 0 });
const T = 106;
const O = 5000;
const wallPoly = (x0: number, y0: number, x1: number, y1: number): Vec2[] =>
  x0 === x1 ? rect(O + x0 - T / 2, O + Math.min(y0, y1) - T / 2, O + x0 + T / 2, O + Math.max(y0, y1) + T / 2) : rect(O + Math.min(x0, x1) - T / 2, O + y0 - T / 2, O + Math.max(x0, x1) + T / 2, O + y0 + T / 2);

/**
 * 2 階: 右上に折り返し階段（1,820 × 1,820）と、その前の踊り場（1,820 × 910）。
 * 階段室は北・東が外壁、南が壁、西は階段の壁（0〜1,820）と踊り場の口（1,820〜2,730。角に柱の塗りがあり、口は「開口」として読まれる）
 */
function page(mark: boolean): PageMm {
  const walls = [
    wallPoly(0, 0, 7280, 0), wallPoly(0, 5460, 7280, 5460), wallPoly(0, 0, 0, 5460), wallPoly(7280, 0, 7280, 5460),
    wallPoly(3640, 0, 3640, 5460), // 洋室とホールの間
    wallPoly(5460, 0, 5460, 1820), // 階段の西の壁
    wallPoly(5513, 2730, 7280, 2730), // 踊り場の南の壁
    rect(O + 5407, O + 2677, O + 5513, O + 2783), // 角の柱
  ];
  const segs: Seg[] = [...walls.flatMap(fillSegs)];
  // 段の線（左右 2 列・6 段）と中壁の線
  for (let i = 0; i < 6; i++) {
    const y = O + 400 + i * 230;
    segs.push(stroke(O + 5513, y, O + 6340, y), stroke(O + 6400, y, O + 7227, y));
  }
  segs.push(stroke(O + 6340, O + 400, O + 6340, O + 1820), stroke(O + 6400, O + 400, O + 6400, O + 1820));
  // 用紙の隅の線（図がページ全体を占めると図面枠として除かれる）
  segs.push(stroke(0, 0, 500, 0), stroke(29000, 20500, 29700, 20500), stroke(29700, 20000, 29700, 21000));
  const texts = [
    text('洋室', O + 1800, O + 2500),
    text('（12.0帖）', O + 1800, O + 2900, 250),
    text('ホール', O + 4500, O + 4600),
    text('階段', O + 6800, O + 1000),
    ...(mark ? [text('DN', O + 5915, O + 1980, 200)] : []),
    text('2 階', O + 3000, O + 6500, 398),
    text('平 面 図', O + 4450, O + 6500, 398),
  ];
  return { pageIndex: 0, segs, arcs: [], texts, fills: [], masks: [], colorFills: walls.map((poly) => ({ poly, color: '#808080' })) };
}

const read = (pg: PageMm) => {
  const plans = detectPlans([pg], []);
  expect(plans.length).toBe(1);
  return buildFloor(plans[0], 2, 0, []);
};

describe('折り返し階段の前の踊り場', () => {
  it('DN の文字が階段の真正面にある踊り場へは、階段の範囲を広げない', () => {
    const f = read(page(true));
    expect(f.stairs.length).toBe(1);
    const st = f.stairs[0];
    expect(st.kind).toBe('u');
    // 階段は 1,820 まで（踊り場の 2,730 までは伸ばさない）
    expect(st.maxY - O).toBeLessThan(2000);
    expect(st.maxY - st.minY).toBeGreaterThan(1300);
    expect(st.entry).toBe('s');
  });
  it('文字が無ければ、階段と読めた小さな区画いっぱいまでを階段にする（回り段の欠けを補う今までの動き）', () => {
    const st = read(page(false)).stairs[0];
    expect(st.maxY - O).toBeGreaterThan(2500);
  });
});
