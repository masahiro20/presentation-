// 階段の中を通る壁の整理: 踊り場をふさぐ中壁・段を横切る壁を切る。階段下のトイレ・収納の壁は残す
import { describe, expect, it } from 'vitest';
import { clearStairWalls, cutWallSegment } from '../src/parser/stairWalls';
import type { Floor, Opening, Room, Stair, Vec2, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (name: string, type: Room['type'], poly: Vec2[], extra: Partial<Room> = {}): Room => ({ id: name, name, type, polygon: poly, labelPos: { x: (poly[0].x + poly[2].x) / 2, y: (poly[0].y + poly[2].y) / 2 }, area: ((poly[2].x - poly[0].x) * (poly[2].y - poly[0].y)) / 1e6, ...extra });
const wall = (id: string, ax: number, ay: number, bx: number, by: number, exterior = false): Wall => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 106, exterior });
/** 折り返し階段（幅 1820 × 奥行 2730、昇り口は南 = 下）。踊り場は北（上）の 910 */
const uStair: Stair = { id: 's', minX: 0, minY: 0, maxX: 1820, maxY: 2730, goesUp: false, kind: 'u', entry: 's', steps: 14 };
const floor = (walls: Wall[], rooms: Room[], openings: Opening[] = [], stairs: Stair[] = [uStair]): Floor =>
  ({ level: 2, elevation: 3400, height: 2900, ceilingHeight: 2400, walls, openings, rooms, stairs, outline: [rect(-3000, -3000, 6000, 6000)] }) as Floor;

describe('階段の中を通る壁', () => {
  it('折り返し階段の中壁が踊り場まで通っていたら、踊り場の分（奥の 910）だけ切る（舟橋様邸 2 階）', () => {
    const mid = wall('W1', 910, 0, 910, 2730);
    const f = floor([mid, wall('N', 0, 0, 1820, 0, true)], [room('吹抜', 'void', rect(0, 0, 910, 2730)), room('階段', 'stairs', rect(910, 0, 1820, 2730))]);
    const rep = clearStairWalls(f);
    expect(rep).toEqual({ landings: 1, crossings: 0 });
    const w = f.walls.find((q) => q.id === 'W1' || Math.abs(q.a.x - 910) < 1)!;
    // 残るのは踊り場の先（y 910〜2730）
    expect(Math.min(w.a.y, w.b.y)).toBe(910);
    expect(Math.max(w.a.y, w.b.y)).toBe(2730);
  });

  it('廊下と一続きに読めた階段（「ホール・階段」）と種類の無い「吹抜」の間の中壁も切る（大崎様邸 2 階）', () => {
    const f = floor([wall('W1', 910, 0, 910, 2795)], [room('ホール・階段', 'hall', rect(0, 0, 910, 4000)), room('吹抜', 'other', rect(910, 0, 1820, 2730))]);
    expect(clearStairWalls(f).landings).toBe(1);
  });

  it('階段下の収納・トイレを囲む壁（片側が別の部屋）は残す（伊藤様邸 1 階）', () => {
    const f = floor([wall('W1', 910, 845, 910, 2795)], [room('物入', 'storage', rect(0, 845, 910, 2730)), room('ホール', 'hall', rect(910, 0, 1820, 2730))]);
    expect(clearStairWalls(f)).toEqual({ landings: 0, crossings: 0 });
    expect(f.walls).toHaveLength(1);
  });

  it('直階段の段を横切る壁は、階段の範囲の中の分を切る。開き戸の付いた壁・外壁は触らない', () => {
    const straight: Stair = { id: 's', minX: 0, minY: 0, maxX: 910, maxY: 2730, goesUp: true, kind: 'straight', entry: 's', steps: 14 };
    const cross = wall('W1', -500, 1400, 1500, 1400);
    const f = floor([cross], [room('階段', 'stairs', rect(0, 0, 910, 2730))], [], [straight]);
    expect(clearStairWalls(f)).toEqual({ landings: 0, crossings: 1 });
    // 階段の外の部分（左 -500〜60、右 850〜1500）が残る
    expect(f.walls.map((w) => [Math.min(w.a.x, w.b.x), Math.max(w.a.x, w.b.x)]).sort((p, q) => p[0] - q[0])).toEqual([
      [-500, 60],
      [850, 1500],
    ]);
    const door: Opening = { id: 'd', wallId: 'W2', kind: 'door', t0: 600, t1: 1300, sill: 0, height: 2000 };
    const g = floor([wall('W2', -500, 1400, 1500, 1400)], [room('階段', 'stairs', rect(0, 0, 910, 2730))], [door], [straight]);
    expect(clearStairWalls(g)).toEqual({ landings: 0, crossings: 0 });
    const h = floor([wall('W3', -500, 1400, 1500, 1400, true)], [room('階段', 'stairs', rect(0, 0, 910, 2730))], [], [straight]);
    expect(clearStairWalls(h)).toEqual({ landings: 0, crossings: 0 });
  });

  it('壁の区間を切ると、後ろの壁の開口は新しい壁に付け替わる', () => {
    const w = wall('F2-W1', 0, 0, 6000, 0);
    const o1: Opening = { id: 'a', wallId: 'F2-W1', kind: 'sliding', t0: 300, t1: 1100, sill: 0, height: 2000 };
    const o2: Opening = { id: 'b', wallId: 'F2-W1', kind: 'sliding', t0: 4500, t1: 5300, sill: 0, height: 2000 };
    const o3: Opening = { id: 'c', wallId: 'F2-W1', kind: 'open', t0: 2200, t1: 2800, sill: 0, height: 2000 };
    const f = floor([w], [], [o1, o2, o3], []);
    expect(cutWallSegment(f, w, 2000, 3000)).toBe(true);
    expect(f.walls).toHaveLength(2);
    expect(f.openings.map((o) => o.id).sort()).toEqual(['a', 'b']);
    const second = f.walls[1];
    expect(o2.wallId).toBe(second.id);
    expect(o2.t0).toBe(1500);
    expect(second.a.x).toBe(3000);
    expect(o1.wallId).toBe('F2-W1');
  });
});
