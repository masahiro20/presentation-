// 吹抜の縁で壁を分けるとき、境をまたぐ開口を落とさない（第 42 巡 ⑭。大崎様邸 2 階: ホールから階段の降り口）
import { describe, it, expect } from 'vitest';
import { splitAtVoid } from '../src/scene/building';
import type { Floor, Opening, Room, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (id: string, name: string, type: Room['type'], poly: { x: number; y: number }[]): Room => ({ id, name, type, polygon: poly, area: 0, labelPos: { x: (poly[0].x + poly[2].x) / 2, y: (poly[0].y + poly[2].y) / 2 } }) as Room;
// 2 階: 西にホール（幅 910）、東は上が階段（降り口は 4,095〜5,005）、下が吹抜（5,005〜8,645）。
// ホールの東の壁 1 本（x = 5,460、y 4,095〜8,645）: 上の 910 が階段の降り口（建具なしの開口）、下が吹抜の縁
const wall: Wall = { id: 'w', a: { x: 5460, y: 4095 }, b: { x: 5460, y: 8645 }, thickness: 105, exterior: false } as Wall;
const floor = (): Floor =>
  ({
    level: 2,
    elevation: 3400,
    height: 2900,
    ceilingHeight: 2400,
    outline: [rect(4550, 1365, 7280, 8645)],
    rooms: [room('h', 'ホール', 'hall', rect(4550, 3185, 5460, 8645)), room('s', '階段', 'stairs', rect(5460, 1365, 7280, 5005)), room('v', '吹抜', 'void', rect(5460, 5005, 7280, 8645))],
    walls: [wall],
    openings: [],
    stairs: [],
  }) as unknown as Floor;
const open = (t0: number, t1: number): Opening => ({ id: 'o1', wallId: 'w', kind: 'open', t0, t1, sill: 0, height: 2000 }) as Opening;

describe('吹抜の縁で壁を分ける', () => {
  it('吹抜の縁（ホールと吹抜の境）と、その手前の区間に分かれる', () => {
    const parts = splitAtVoid(floor(), wall, []);
    expect(parts).toHaveLength(2);
    expect(parts[0].w.b.y).toBeCloseTo(5005, -2);
    expect(parts[1].w.a.y).toBeCloseTo(5005, -2);
    expect(parts[1].w.b.y).toBe(8645);
  });

  it('境を少しまたぐ開口（階段の降り口 962mm、吹抜の縁は 910mm から）は、手前の区間に残る', () => {
    const parts = splitAtVoid(floor(), wall, [open(1, 962)]);
    expect(parts).toHaveLength(2);
    // 手前（階段の降り口）の区間に開口が残り、区間の端で止まる
    expect(parts[0].ops).toHaveLength(1);
    const len0 = parts[0].w.b.y - parts[0].w.a.y;
    expect(parts[0].ops[0].t0).toBeLessThan(10);
    expect(parts[0].ops[0].t1).toBeLessThanOrEqual(len0 + 1e-6);
    expect(parts[0].ops[0].t1 - parts[0].ops[0].t0).toBeGreaterThan(850);
    // 吹抜の縁の区間には開口を付けない
    expect(parts[1].ops).toHaveLength(0);
  });

  it('区間にすっぽり入る開口は、今までどおりその区間に入る（位置は区間の始まりから測る）', () => {
    const parts = splitAtVoid(floor(), wall, [open(100, 800)]);
    expect(parts[0].ops).toHaveLength(1);
    expect(parts[0].ops[0].t0).toBe(100);
    expect(parts[0].ops[0].t1).toBe(800);
  });

  it('1 階・吹抜の無い階は分けない', () => {
    const f1 = { ...floor(), level: 1 } as Floor;
    expect(splitAtVoid(f1, wall, [open(1, 962)])).toHaveLength(1);
    const noVoid = { ...floor(), rooms: floor().rooms.filter((r) => r.type !== 'void') } as Floor;
    expect(splitAtVoid(noVoid, wall, [open(1, 962)])).toHaveLength(1);
  });
});
