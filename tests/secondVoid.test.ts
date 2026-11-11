// ×印の吹抜があるとき、もう 1 つの「吹抜」（階段の上の小さな吹抜・2 つ目の×印）を床にしない（大崎様邸 2 階）
import { describe, expect, it } from 'vitest';
import { buildFloor, detectPlans, type MmText, type PageMm } from '../src/parser/assemble';
import type { Seg } from '../src/parser/walls';
import type { Vec2 } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const fillSegs = (poly: Vec2[]): Seg[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length], width: 0, dashed: false, source: 'fill' as const }));
const stroke = (x0: number, y0: number, x1: number, y1: number): Seg => ({ a: P(x0, y0), b: P(x1, y1), width: 0.2, dashed: false, source: 'stroke' });
const text = (str: string, x: number, y: number, size = 300): MmText => ({ str, x, y, size, angle: 0 });
const T = 106;
const O = 5000;
const wallPoly = (x0: number, y0: number, x1: number, y1: number): Vec2[] =>
  x0 === x1 ? rect(O + x0 - T / 2, O + Math.min(y0, y1) - T / 2, O + x0 + T / 2, O + Math.max(y0, y1) + T / 2) : rect(O + Math.min(x0, x1) - T / 2, O + y0 - T / 2, O + Math.max(x0, x1) + T / 2, O + y0 + T / 2);

/**
 * 2 階: 洋室（左）｜×印の吹抜 2,730 角（中央上）｜小さな吹抜 1,820×1,365（右上。×印なし・文字あり）｜ホール（残り）
 * second = 'small'（文字だけの小さな吹抜）／'cross'（2 つ目も×印）／'none'
 */
function page(second: 'small' | 'cross' | 'none', opts: { firstLabel?: boolean } = {}): PageMm {
  const walls = [
    wallPoly(0, 0, 7280, 0), wallPoly(0, 5460, 7280, 5460), wallPoly(0, 0, 0, 5460), wallPoly(7280, 0, 7280, 5460),
    wallPoly(2730, 0, 2730, 5460),
    wallPoly(5460, 0, 5460, 2730), wallPoly(2730, 2730, 5460, 2730),
    ...(second !== 'none' ? [wallPoly(5460, 1365, 7280, 1365)] : []),
  ];
  const segs: Seg[] = [
    ...walls.flatMap(fillSegs),
    // 1 つ目の吹抜の×印
    stroke(O + 2783, O + 53, O + 5407, O + 2677), stroke(O + 5407, O + 53, O + 2783, O + 2677),
    ...(second === 'cross' ? [stroke(O + 5513, O + 53, O + 7227, O + 1312), stroke(O + 7227, O + 53, O + 5513, O + 1312)] : []),
    // 用紙の隅の線（図がページ全体を占めると図面枠として除かれる）
    stroke(0, 0, 500, 0), stroke(29000, 20500, 29700, 20500), stroke(29700, 20000, 29700, 21000),
  ];
  const texts = [
    text('洋室', O + 1365, O + 2500),
    text('（9.0帖）', O + 1365, O + 2900, 250),
    ...(opts.firstLabel === false ? [] : [text('吹抜', O + 4095, O + 1000)]),
    ...(second !== 'none' ? [text('吹抜', O + 6370, O + 700)] : []),
    text('ホール', O + 5000, O + 4200),
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

describe('2 つ目の吹抜', () => {
  it('×印の吹抜に文字があれば、別の区画の「吹抜」も吹抜のまま（床にしない）', () => {
    const f = read(page('small'));
    const voids = f.rooms.filter((r) => r.type === 'void');
    // 2,730 角（7.45 ㎡）と 1,820 × 1,365（2.48 ㎡）。内法で少し小さく出る
    expect(voids.map((r) => Math.round(r.area * 10) / 10).sort()).toEqual([2.4, 7.3]);
    expect(f.rooms.some((r) => r.name === '吹抜' && r.type !== 'void')).toBe(false);
    expect(f.rooms.find((r) => r.type === 'hall')).toBeTruthy();
  });

  it('×印の吹抜が 2 つあれば、両方とも吹抜（2 つ目が 1 つ目を取り消さない）', () => {
    const f = read(page('cross'));
    expect(f.rooms.filter((r) => r.type === 'void').length).toBe(2);
    expect(f.rooms.some((r) => r.name === '吹抜' && r.type !== 'void')).toBe(false);
  });

  it('吹抜が 1 つだけの図面は今までどおり', () => {
    const f = read(page('none'));
    const voids = f.rooms.filter((r) => r.type === 'void');
    expect(voids.length).toBe(1);
    expect(voids[0].area).toBeGreaterThan(6.5);
    expect(f.rooms.find((r) => r.type === 'hall')).toBeTruthy();
    expect(f.rooms.find((r) => r.type === 'bedroom')).toBeTruthy();
  });
});
