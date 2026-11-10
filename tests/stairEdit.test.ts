// 3D の「階段」の道具: 上下の階の同じ階段・回す・動かす・壁との重なり（core/stairEdit）
import { describe, expect, it } from 'vitest';
import { linkedStairs, movedCorner, placeStair, rotateEntry, rotateStair, stairAtPoint, wallsThroughStair } from '../src/core/stairEdit';
import type { Floor, Stair } from '../src/core/types';

const stair = (id: string, minX: number, minY: number, w: number, d: number, extra: Partial<Stair> = {}): Stair => ({ id, minX, minY, maxX: minX + w, maxY: minY + d, kind: 'straight', entry: 's', goesUp: true, ...extra });
const floor = (level: number, stairs: Stair[]): Floor => ({ level, elevation: (level - 1) * 2900, height: 2900, ceilingHeight: 2400, walls: [], openings: [], rooms: [], stairs, outline: [] });

describe('階段を物として動かす・回す', () => {
  it('1 階の UP と 2 階の同じ位置の DN は 1 つの階段（片割れを見つける）。位置が違えば別の階段', () => {
    const up = stair('s1', 1000, 2000, 910, 2730);
    const dn = stair('s2', 1050, 1980, 910, 2730, { goesUp: false });
    const far = stair('s3', 5000, 2000, 910, 2730, { goesUp: false });
    const m = { floors: [floor(1, [up]), floor(2, [dn, far])] };
    expect(linkedStairs(m, 1, up).map((r) => r.st.id)).toEqual(['s2']);
    expect(linkedStairs(m, 2, dn).map((r) => r.st.id)).toEqual(['s1']);
    expect(linkedStairs(m, 2, far)).toEqual([]);
  });

  it('回す: 外形が中心で 90° 回り（幅と奥行が入れ替わる）、昇り口の辺も回る。格子があれば角をそろえる', () => {
    expect(rotateEntry('n', 1)).toBe('e');
    expect(rotateEntry('w', 1)).toBe('n');
    expect(rotateEntry('n', -1)).toBe('w');
    const s = stair('s', 0, 0, 910, 2730, { entry: 's', kind: 'l', turn: 'left' });
    rotateStair(s, 1);
    expect(s.maxX - s.minX).toBe(2730);
    expect(s.maxY - s.minY).toBe(910);
    expect((s.minX + s.maxX) / 2).toBe(455);
    expect(s.entry).toBe('w');
    expect(s.turn).toBe('left');
    // 格子（位相 0・455）: 中心で回すと角が 455 + ... からずれるので、いちばん近い格子へ
    const g = stair('g', 0, 0, 910, 1820, { entry: 'n' });
    rotateStair(g, -1, { step: 455, phaseX: 0, phaseY: 0 });
    expect(Math.abs(g.minX % 455)).toBe(0);
    expect(Math.abs(g.minY % 455)).toBe(0);
    expect(g.entry).toBe('w');
  });

  it('動かす: 格子の位相にそろえる・格子なしは 10 mm 単位。大きさは変わらない', () => {
    expect(movedCorner({ minX: 100, minY: 100 }, 430, 0, { step: 455, phaseX: 100, phaseY: 100 })).toEqual({ minX: 555, minY: 100 });
    expect(movedCorner({ minX: 100, minY: 100 }, 433, -7, null)).toEqual({ minX: 530, minY: 90 });
    const s = stair('s', 0, 0, 910, 2730);
    placeStair(s, 1365, 455);
    expect([s.minX, s.minY, s.maxX, s.maxY]).toEqual([1365, 455, 2275, 3185]);
  });

  it('点から階段を選ぶ・中を通る壁（縁に沿う壁は除く）', () => {
    const s = stair('s', 1000, 1000, 910, 2730);
    const f = floor(1, [s]);
    expect(stairAtPoint(f, { x: 1400, y: 2000 })?.id).toBe('s');
    expect(stairAtPoint(f, { x: 3000, y: 2000 })).toBeNull();
    f.walls = [
      { id: 'edge', a: { x: 1000, y: 0 }, b: { x: 1000, y: 5000 }, thickness: 120, exterior: false },
      { id: 'through', a: { x: 0, y: 2000 }, b: { x: 3000, y: 2000 }, thickness: 120, exterior: false },
    ];
    expect(wallsThroughStair(f, s).map((w) => w.id)).toEqual(['through']);
  });
});
