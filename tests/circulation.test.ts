import { describe, it, expect } from 'vitest';
import { dailyRoutes, overlayRoutes, roomGraph } from '../src/core/circulation';
import { parseSample } from './pdfNode';
import type { BuildingModel, Floor, Room, RoomType, Vec2, Wall } from '../src/core/types';

describe('暮らしの動線', () => {
  it('サンプルの間取りで朝・帰宅の動線が取れ、長さと歩数が出る', async () => {
    const model = await parseSample('sample_house_A3.pdf');
    const g = roomGraph(model);
    expect(g.nodes.size).toBeGreaterThan(5);
    const routes = dailyRoutes(model);
    const ids = routes.map((r) => r.id);
    expect(ids).toContain('morning');
    expect(ids).toContain('home');
    for (const r of routes) {
      expect(r.meters).toBeGreaterThan(0);
      expect(r.steps).toBeGreaterThan(0);
      expect(r.legs.length).toBeGreaterThan(0);
      expect(r.via.length).toBeGreaterThanOrEqual(2);
    }
    const svg = overlayRoutes('<svg viewBox="0 0 10 10"></svg>', 1, routes);
    expect(svg).toContain('class="routes"');
  });
});

describe('部屋のつながり（壁の無い境界）', () => {
  const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const room = (id: string, name: string, type: RoomType, polygon: Vec2[]): Room => ({ id, name, type, polygon, area: 1, labelPos: polygon[0] }) as Room;
  const wall = (id: string, a: Vec2, b: Vec2): Wall => ({ id, a, b, thickness: 120, exterior: false });
  const model = (rooms: Room[], walls: Wall[]): BuildingModel =>
    ({ name: 't', northAngleDeg: 0, floors: [{ level: 1, elevation: 0, height: 2900, ceilingHeight: 2400, walls, openings: [], rooms, stairs: [], outline: [] } as unknown as Floor] }) as unknown as BuildingModel;
  const linked = (m: BuildingModel) => (roomGraph(m).edges.get('1:st') ?? []).some((e) => e.to === '1:en');

  // 階段の昇り口（0〜1,060）と玄関ホール（940〜）: 手すり・框の細い線で区切られ、輪郭が線の幅 12cm だけ重なっている（市岡様邸 1 階）
  const stairs = room('st', '階段', 'stairs', rect(0, 6640, 1060, 8560));
  const entrance = room('en', '玄関', 'entrance', rect(940, 4740, 3800, 8560));

  it('向かい合う辺が 12cm ずれていても（輪郭が細い線の幅だけ重なる）、間に壁が無ければ行き来できる', () => {
    expect(linked(model([stairs, entrance], []))).toBe(true);
  });

  it('ずれた 2 本の辺の間に壁があれば、行き来できない', () => {
    expect(linked(model([stairs, entrance], [wall('w', { x: 1000, y: 6640 }, { x: 1000, y: 8560 })]))).toBe(false);
    // どちらかの辺の上の壁でも同じ
    expect(linked(model([stairs, entrance], [wall('w', { x: 1060, y: 6640 }, { x: 1060, y: 8560 })]))).toBe(false);
    expect(linked(model([stairs, entrance], [wall('w', { x: 940, y: 6640 }, { x: 940, y: 8560 })]))).toBe(false);
  });

  it('幅の広い建具なしの開口が 2 つの部屋にまたがるとき、両方と結ぶ（真ん中の部屋を通り抜ける経路にしない）', () => {
    // 玄関（右）に、階段の昇り口（左上）とホール（左下）が並んで面している。間は壁 1 本で、全体が建具なしの開口（舟橋様邸 1 階）
    const ent = room('en', '玄関', 'entrance', rect(5124, 0, 6944, 2730));
    const st = room('st', '階段', 'stairs', rect(3304, 0, 5124, 1820));
    const hall = room('h', 'ホール', 'hall', rect(3304, 1820, 5124, 2730));
    const w = wall('w', { x: 5124, y: 0 }, { x: 5124, y: 2730 });
    const m = ({ name: 't', northAngleDeg: 0, floors: [{ level: 1, elevation: 0, height: 2900, ceilingHeight: 2400, walls: [w], openings: [{ id: 'o', wallId: 'w', kind: 'open', t0: 60, t1: 2700, sill: 0, height: 2000 }], rooms: [ent, st, hall], stairs: [], outline: [] }] }) as unknown as BuildingModel;
    const to = (g: ReturnType<typeof roomGraph>) => (g.edges.get('1:en') ?? []).map((e) => e.to).sort();
    expect(to(roomGraph(m))).toEqual(['1:h', '1:st']);
    // ホールとの境の真ん中（y = 2,260 あたり）で結ぶ
    const eh = (roomGraph(m).edges.get('1:en') ?? []).find((e) => e.to === '1:h')!;
    expect(eh.at.y).toBeGreaterThan(1900);
    expect(eh.at.y).toBeLessThan(2650);
    const g = globalThis as { __NO_WIDE_OPEN_LINKS?: boolean };
    g.__NO_WIDE_OPEN_LINKS = true;
    try {
      expect(to(roomGraph(m))).toEqual(['1:st']);
    } finally {
      delete g.__NO_WIDE_OPEN_LINKS;
    }
    // 戸（開き戸・引戸）は真ん中の両側だけ
    const m2 = JSON.parse(JSON.stringify(m)) as BuildingModel;
    m2.floors[0].openings[0].kind = 'sliding';
    expect(to(roomGraph(m2))).toEqual(['1:st']);
  });

  it('15cm を超えて離れた辺は、隣り合う部屋としない。切り替えを切ると 6cm まで', () => {
    const far = room('en', '玄関', 'entrance', rect(1220, 4740, 3800, 8560));
    expect(linked(model([stairs, far], []))).toBe(false);
    const g = globalThis as { __NO_GAP_EDGES?: boolean };
    g.__NO_GAP_EDGES = true;
    try {
      expect(linked(model([stairs, entrance], []))).toBe(false);
    } finally {
      delete g.__NO_GAP_EDGES;
    }
  });
});
