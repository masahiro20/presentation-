import { describe, it, expect } from 'vitest';
import { splitAtBalcony } from '../src/scene/building';
import type { Floor, Opening, Room, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (id: string, name: string, type: Room['type'], poly: { x: number; y: number }[]): Room => ({ id, name, type, polygon: poly, area: 0 }) as Room;
// 有元様邸 3 階の南の外壁: 西 2,730 がバルコニー、東 1,820 がパントリー（室内）。外は +y 側
const wall: Wall = { id: 'w', a: { x: 0, y: 8645 }, b: { x: 4550, y: 8645 }, thickness: 160, exterior: true, outsideSign: 1 } as Wall;
const floor = (rooms: Room[], walls: Wall[] = [wall]): Floor => ({ level: 3, elevation: 6300, height: 2900, ceilingHeight: 2400, outline: [rect(0, 6370, 4550, 8645)], rooms, walls, openings: [], stairs: [] }) as unknown as Floor;

describe('バルコニーと室内にまたがる外壁の分割', () => {
  it('バルコニーの区間は手すり壁、室内の区間は外壁になるように 2 本に分ける', () => {
    const f = floor([room('b', 'バルコニー', 'balcony', rect(0, 6370, 2730, 8645)), room('p', 'pantry', 'storage', rect(2730, 6825, 4550, 8645))]);
    const parts = splitAtBalcony(f, wall, []);
    expect(parts).toHaveLength(2);
    expect(parts[0].w.a.x).toBe(0);
    expect(parts[0].w.b.x).toBeCloseTo(2730, -2);
    expect(parts[1].w.a.x).toBeCloseTo(2730, -2);
    expect(parts[1].w.b.x).toBe(4550);
    expect(parts[0].w.joinedB).toBe(true);
    expect(parts[1].w.joinedA).toBe(true);
  });
  it('全長がバルコニー、または全長が室内なら分けない', () => {
    const all = floor([room('b', 'バルコニー', 'balcony', rect(0, 6370, 4550, 8645))]);
    expect(splitAtBalcony(all, wall, [])).toHaveLength(1);
    const none = floor([room('p', 'pantry', 'storage', rect(0, 6370, 4550, 8645))]);
    expect(splitAtBalcony(none, wall, [])).toHaveLength(1);
  });
  it('境に窓がかかるときは窓の端で切り、窓はその区間に残る', () => {
    const f = floor([room('b', 'バルコニー', 'balcony', rect(0, 6370, 2730, 8645)), room('p', 'pantry', 'storage', rect(2730, 6825, 4550, 8645))]);
    const win: Opening = { id: 'o1', wallId: 'w', kind: 'window', t0: 2500, t1: 3300, sill: 900, height: 1100 } as Opening;
    const parts = splitAtBalcony(f, wall, [win]);
    expect(parts).toHaveLength(2);
    const cut = parts[0].w.b.x;
    expect(cut === 2500 || cut === 3300).toBe(true);
    const holder = parts.find((p) => p.ops.length === 1)!;
    expect(holder.ops[0].t1 - holder.ops[0].t0).toBe(800);
  });
});
