// 坪単価は基準の面積（施工面積・延床面積）で数字が変わるので、両方を持つ（estimate/calc.ts）
import { describe, expect, it } from 'vitest';
import { computeEstimate, newChoice } from '../src/estimate/calc';
import { takeoff } from '../src/estimate/areas';
import type { BuildingModel, Floor, Room } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (id: string, name: string, type: Room['type'], poly: { x: number; y: number }[]): Room =>
  ({ id, name, type, polygon: poly, area: Math.abs(poly.reduce((s, p, i) => s + p.x * poly[(i + 1) % poly.length].y - poly[(i + 1) % poly.length].x * p.y, 0)) / 2e6 }) as Room;
const floor = (level: number, outline: { x: number; y: number }[][], rooms: Room[]): Floor =>
  ({ level, height: 2900, ceilingHeight: 2400, elevation: 500 + (level - 1) * 2900, outline, rooms, walls: [], openings: [], stairs: [] }) as unknown as Floor;
// 1 階 10m × 6m（西 4m はビルトインガレージ = 床面積に入れず施工面積に入る）、2 階 6m × 6m
const model = {
  floors: [
    floor(1, [rect(0, 0, 10000, 6000)], [room('g', 'ガレージ', 'garage', rect(0, 0, 4000, 6000)), room('l', 'ＬＤＫ', 'ldk', rect(4000, 0, 10000, 6000))]),
    floor(2, [rect(4000, 0, 10000, 6000)], [room('b', '寝室', 'bedroom', rect(4000, 0, 10000, 6000))]),
  ],
  northAngleDeg: 0,
} as unknown as BuildingModel;

describe('坪単価の 2 つの基準', () => {
  const areas = takeoff(model, { grade: 'P', eavesMm: 100, pitch: 0.5, roofType: 'shed' });
  const est = computeEstimate(areas, newChoice('P', areas));

  it('延床あたり = 税抜 ÷ 延床坪、施工面積あたり = 税抜 ÷ 施工坪（資金計画書の「施工面積 × 坪単価」と同じ）', () => {
    expect(areas.constTsubo).toBeGreaterThan(areas.totalTsubo);
    expect(est.perTsubo).toBeCloseTo(est.subtotal / areas.totalTsubo, 6);
    expect(est.perTsuboConst).toBeCloseTo(est.subtotal / areas.constTsubo, 6);
    // 施工面積の方が広いので、施工面積あたりの坪単価の方が小さい
    expect(est.perTsuboConst).toBeLessThan(est.perTsubo);
    // 施工面積 × 施工面積あたりの坪単価 = 税抜の金額（2 つの書類で数字が合う）
    expect(est.perTsuboConst * areas.constTsubo).toBeCloseTo(est.subtotal, 3);
  });
});
