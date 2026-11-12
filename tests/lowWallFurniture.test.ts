// 腰壁・手すり壁（天端 1.5m 未満の壁）には、壁掛けのテレビ・背の高い家具を付けない（第 42 巡 ⑭）
// 大崎様邸 1 階: 書斎コーナーの腰壁を 1,100 に読むと、テレビが壁の上にはみ出して宙に浮いて見えた
import { describe, it, expect } from 'vitest';
import { furnitureItems } from '../src/scene/furniture';
import type { BuildingModel, Opening, Room, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (id: string, name: string, type: Room['type'], poly: { x: number; y: number }[]): Room =>
  ({ id, name, type, polygon: poly, labelPos: { x: (poly[0].x + poly[2].x) / 2, y: (poly[0].y + poly[2].y) / 2 }, area: Math.abs((poly[2].x - poly[0].x) * (poly[2].y - poly[0].y)) / 1e6 }) as Room;
const wall = (id: string, a: { x: number; y: number }, b: { x: number; y: number }, extra: Partial<Wall> = {}): Wall => ({ id, a, b, thickness: 120, exterior: true, outsideSign: 1, ...extra }) as Wall;
/**
 * 西から 書斎コーナー（1.8m）｜LDK（9.1m）｜洗面室（1.8m）。キッチンは水まわり（東）の側に付くので、居間は西の端。
 * 書斎コーナーと LDK の間の壁（x = 1,820）を、天井まで／腰壁にして比べる
 */
const model = (topMm?: number, openings: Opening[] = []): BuildingModel =>
  ({
    floors: [
      {
        level: 1,
        height: 2900,
        ceilingHeight: 2400,
        elevation: 600,
        outline: [rect(0, 0, 12740, 5460)],
        rooms: [room('s', 'スタディコーナー', 'study', rect(0, 0, 1820, 5460)), room('l', 'ＬＤＫ', 'ldk', rect(1820, 0, 10920, 5460)), room('w', '洗面室', 'washroom', rect(10920, 0, 12740, 5460))],
        walls: [
          wall('w1', { x: 0, y: 0 }, { x: 12740, y: 0 }),
          wall('w2', { x: 12740, y: 0 }, { x: 12740, y: 5460 }),
          wall('w3', { x: 12740, y: 5460 }, { x: 0, y: 5460 }),
          wall('w4', { x: 0, y: 5460 }, { x: 0, y: 0 }),
          wall('w5', { x: 1820, y: 0 }, { x: 1820, y: 5460 }, { exterior: false, outsideSign: undefined, ...(topMm ? { topMm } : {}) }),
          wall('w6', { x: 10920, y: 0 }, { x: 10920, y: 5460 }, { exterior: false, outsideSign: undefined }),
        ],
        openings,
        stairs: [],
      },
    ],
    northAngleDeg: 0,
  }) as unknown as BuildingModel;
const itemsOf = (m: BuildingModel) => [...(furnitureItems(m).get(1) ?? [])];
const nearWestWall = (x: number) => Math.abs(x - 1820) < 400;

describe('腰壁には壁掛けのテレビを付けない', () => {
  it('天井までの壁なら、居間の端の壁（書斎コーナーとの間）にテレビが付く', () => {
    const tv = itemsOf(model()).find((x) => x.kind === 'tv')!;
    expect(tv).toBeTruthy();
    expect(nearWestWall(tv.x)).toBe(true);
  });

  it('その壁が腰壁（1,100）なら、テレビはほかの壁へ移り、ソファはテレビの方を向く', () => {
    const items = itemsOf(model(1100));
    const tv = items.find((x) => x.kind === 'tv')!;
    const sofa = items.find((x) => x.kind === 'sofa')!;
    expect(tv).toBeTruthy();
    expect(sofa).toBeTruthy();
    expect(nearWestWall(tv.x)).toBe(false);
    // 北か南の壁（窓の無い長い壁）
    expect(tv.y < 300 || tv.y > 5160).toBe(true);
    expect(Math.abs(sofa.x - tv.x)).toBeLessThan(300);
  });

  it('北の壁に窓があれば、南の壁へ', () => {
    const win = { id: 'o1', wallId: 'w1', kind: 'window', t0: 2500, t1: 9500, sill: 0, height: 2000, windowStyle: 'hakidashi' } as unknown as Opening;
    const tv = itemsOf(model(1100, [win])).find((x) => x.kind === 'tv')!;
    expect(tv).toBeTruthy();
    expect(nearWestWall(tv.x)).toBe(false);
    expect(tv.y).toBeGreaterThan(5160);
  });

  it('袖壁（2,400）のように背の高い壁は、今までどおりテレビを付けられる', () => {
    const tv = itemsOf(model(2400)).find((x) => x.kind === 'tv')!;
    expect(nearWestWall(tv.x)).toBe(true);
  });
});
