// 階の床面積: 階段室の吹抜（下の階の階段の真上の小さな吹抜）は床に数える、大きな吹抜は数えない
import { describe, expect, it } from 'vitest';
import { floorAreaOf, isStairwellVoid } from '../src/core/floorArea';
import { takeoff } from '../src/estimate/areas';
import type { BuildingModel, Floor, Room, Vec2 } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
let seq = 0;
const room = (name: string, type: Room['type'], poly: Vec2[]): Room => {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { id: `r${seq++}`, name, type, polygon: poly, labelPos: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }, area: ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / 1e6 };
};
const floor = (level: number, outline: Vec2[], rooms: Room[], stairs: Floor['stairs'] = []): Floor => ({ level, elevation: 500 + (level - 1) * 2900, height: 2900, ceilingHeight: 2400, outline: [outline], rooms, walls: [], openings: [], stairs });

/** 1 階 8 × 6 m（LDK・階段 1.82 × 4.55）、2 階 同じ外形（洋室・階段の上の吹抜 8.28 ㎡・大きな吹抜 3 × 4 m） */
function model(): BuildingModel {
  const o = rect(0, 0, 8000, 6000);
  const f1 = floor(1, o, [room('LDK', 'ldk', rect(0, 0, 6180, 6000)), room('階段', 'stairs', rect(6180, 0, 8000, 4550)), room('物入', 'storage', rect(6180, 4550, 8000, 6000))], [{ id: 's1', minX: 6180, minY: 0, maxX: 8000, maxY: 4550, goesUp: true, kind: 'straight', entry: 's', steps: 14 }]);
  const f2 = floor(2, o, [room('洋室', 'bedroom', rect(0, 0, 3000, 6000)), room('吹抜', 'void', rect(3000, 0, 6000, 4000)), room('ホール', 'hall', rect(3000, 4000, 8000, 6000)), room('吹抜', 'void', rect(6180, 0, 8000, 4550)), room('物入', 'storage', rect(6000, 4550, 6180, 6000))]);
  return { name: 't', floors: [f1, f2], northAngleDeg: 0, report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} } };
}

describe('floorAreaOf / isStairwellVoid', () => {
  it('下の階の階段の真上の小さな吹抜は階段室として床に数え、大きな吹抜は数えない', () => {
    const m = model();
    const [f1, f2] = m.floors;
    const voids = f2.rooms.filter((r) => r.type === 'void');
    expect(isStairwellVoid(voids[1], f1)).toBe(true); // 階段の上 8.28 ㎡
    expect(isStairwellVoid(voids[0], f1)).toBe(false); // LDK の上の 12 ㎡
    expect(isStairwellVoid(voids[1], undefined)).toBe(false);
    // 2 階: 洋室 18 + ホール 10 + 階段室 8.28 + 物入 0.26 = 36.54（大きな吹抜 12 は入れない）
    expect(floorAreaOf(f2, m.floors)).toBeCloseTo(36.54, 1);
    expect(floorAreaOf(f1, m.floors)).toBeCloseTo(48, 1);
  });
  it('階段の記号（Stair）だけでも階段室と分かる', () => {
    const m = model();
    m.floors[0].rooms = m.floors[0].rooms.filter((r) => r.type !== 'stairs');
    expect(isStairwellVoid(m.floors[1].rooms.filter((r) => r.type === 'void')[1], m.floors[0])).toBe(true);
  });
  it('見積の拾い: 階段室の吹抜は床面積に入り、吹抜の面積（内部足場）には入らない', () => {
    const a = takeoff(model(), { grade: 'P', eavesMm: 100, pitch: 0.5, roofType: 'shed' });
    expect(a.floor2).toBeCloseTo(48 - 12, 1);
    expect(a.voidArea).toBeCloseTo(12, 1);
    // 施工面積 = 延床（48 + 36）＋ 吹抜 12（ポーチの区画が無いので追加分は 0）
    expect(a.constArea).toBeCloseTo(48 + 36 + 12, 1);
  });
});
