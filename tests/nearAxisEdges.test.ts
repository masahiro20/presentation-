/**
 * 部屋の輪郭に残る「ほぼ縦・ほぼ横の斜めの辺」を格子へ寄せる（第 42 巡 ⑪）。
 * 升目でなぞった輪郭を間引くと、1 升（20mm）の段が 1 本の斜めの辺になる。壁の無い境界（LDK とホールの間など）では、
 * 隣の部屋の辺と 5〜7cm ずれたまま残り、隣り合う部屋だと分からなくなる（大崎様邸 1 階: 玄関から LDK へ行けない、と出ていた）。
 */
import { describe, expect, it } from 'vitest';
import { snapFloorWalls } from '../src/parser/assemble';
import { livingCheck } from '../src/parser/livingCheck';
import type { ModuleFit } from '../src/parser/module';
import type { BuildingModel, Floor, Room, RoomType, Vec2, Wall } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const room = (id: string, name: string, type: RoomType, polygon: Vec2[]): Room => ({ id, name, type, polygon, area: 1, labelPos: P(0, 0) });
const wall = (id: string, a: Vec2, b: Vec2, exterior = false): Wall => ({ id, a, b, thickness: exterior ? 160 : 130, exterior });
const fit: ModuleFit = { size: 910, grid: 455, phaseX: 0, phaseY: 0, onGrid: 1, fit: 1, walls: 10 };

/**
 * 玄関（左上）・ホール（右上）・LDK（下）。玄関｜ホールの間は壁なし（上がり框）、ホール｜LDK の間は戸。
 * ホールの左の辺は、輪郭の間引きで 3,569 → 3,589 の斜めになっている（玄関の右の辺は 3,640。ずれは 71・51mm）
 */
function plan(): Floor {
  const o = rect(0, 0, 7280, 7280);
  return {
    level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, outline: [o],
    rooms: [
      room('e', '玄関', 'entrance', rect(0, 0, 3640, 2730)),
      room('h', 'ホール', 'hall', [P(3569, 0), P(7280, 0), P(7280, 2730), P(3589, 2730)]),
      room('l', 'ＬＤＫ', 'ldk', [P(0, 2690), P(3640, 2730), P(7280, 2730), P(7280, 7280), P(0, 7280)]),
    ],
    walls: [
      wall('N', P(0, 0), P(7280, 0), true), wall('E', P(7280, 0), P(7280, 7280), true), wall('S', P(7280, 7280), P(0, 7280), true), wall('W', P(0, 7280), P(0, 0), true),
      wall('M', P(0, 2730), P(7280, 2730)),
    ],
    openings: [
      { id: 'ent', wallId: 'N', kind: 'entrance', t0: 1300, t1: 2200, sill: 0, height: 2300 },
      { id: 'd', wallId: 'M', kind: 'door', t0: 5000, t1: 5780, sill: 0, height: 2000 },
    ],
    stairs: [],
  } as Floor;
}
const model = (f: Floor): BuildingModel => ({ name: 't', floors: [f], northAngleDeg: 0 }) as unknown as BuildingModel;
const reach = (f: Floor) => livingCheck(model(f)).filter((i) => i.id.startsWith('live-reach'));

describe('ほぼ縦・ほぼ横の辺を格子へ寄せる', () => {
  it('寄せる前は辺が 7cm ずれている。ずれた辺を同じ辺と見ない読み方では、玄関とホールが隣り合うと分からず、ホール・LDK に行けない', () => {
    const g = globalThis as { __NO_GAP_EDGES?: boolean };
    g.__NO_GAP_EDGES = true;
    try {
      expect(reach(plan())).toHaveLength(1);
    } finally {
      delete g.__NO_GAP_EDGES;
    }
    // 動線の読み方（14cm までのずれは同じ辺）でも救えるが、輪郭そのものを直しておく（面積・図面の表示もそろう）
    expect(reach(plan())).toHaveLength(0);
  });

  it('寄せると斜めの辺が格子の線に乗り、玄関 → ホール → LDK とつながる', () => {
    const f = plan();
    snapFloorWalls(f, fit);
    const hall = f.rooms.find((r) => r.id === 'h')!;
    expect(hall.polygon.map((p) => `${p.x},${p.y}`).sort()).toEqual(['3640,0', '3640,2730', '7280,0', '7280,2730']);
    // LDK の上の辺（2,690 → 2,730 の斜め）も壁の芯 2,730 に乗り、一直線上の点は消える
    const ldk = f.rooms.find((r) => r.id === 'l')!;
    expect(ldk.polygon.map((p) => `${p.x},${p.y}`).sort()).toEqual(['0,2730', '0,7280', '7280,2730', '7280,7280']);
    expect(ldk.area).toBeCloseTo((7280 * 4550) / 1e6, 2);
    expect(reach(f)).toHaveLength(0);
  });

  it('本物の斜めの壁に沿った辺は動かさない（傾きが 45mm を超える辺）', () => {
    const f = plan();
    f.rooms[1].polygon = [P(3440, 0), P(7280, 0), P(7280, 2730), P(3640, 2730)];
    snapFloorWalls(f, fit);
    const xs = f.rooms[1].polygon.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[0]).toBe(3440);
  });

  it('切り替えを切ると、今までどおり斜めのまま', () => {
    const g = globalThis as { __NO_NEAR_AXIS?: boolean };
    g.__NO_NEAR_AXIS = true;
    try {
      const f = plan();
      snapFloorWalls(f, fit);
      expect(f.rooms.find((r) => r.id === 'h')!.polygon.some((p) => p.x === 3569 || p.x === 3589)).toBe(true);
    } finally {
      delete g.__NO_NEAR_AXIS;
    }
  });
});
