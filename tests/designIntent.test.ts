import { describe, it, expect } from 'vitest';
import { readDesignIntents } from '../src/core/designIntent';
import type { BuildingModel, Floor, Opening, Room, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
let n = 0;
const room = (name: string, type: Room['type'], poly: { x: number; y: number }[]): Room => {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { id: `R${++n}`, name, type, polygon: poly, area: ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / 1e6, labelPos: poly[0] };
};
/** 縦壁 x に戸（y0〜y1 の中央 800mm） */
const doorV = (id: string, x: number, y0: number, y1: number): { wall: Wall; op: Opening } => ({
  wall: { id, a: { x, y: y0 }, b: { x, y: y1 }, thickness: 120, exterior: false },
  op: { id: `${id}-d`, wallId: id, kind: 'door', t0: (y1 - y0) / 2 - 400, t1: (y1 - y0) / 2 + 400, sill: 0, height: 2000 },
});
const doorH = (id: string, y: number, x0: number, x1: number): { wall: Wall; op: Opening } => ({
  wall: { id, a: { x: x0, y }, b: { x: x1, y }, thickness: 120, exterior: false },
  op: { id: `${id}-d`, wallId: id, kind: 'door', t0: (x1 - x0) / 2 - 400, t1: (x1 - x0) / 2 + 400, sill: 0, height: 2000 },
});

/**
 * 1 階:  x 0..3640 玄関 | 3640..5460 ホール | 5460..12740 ＬＤＫ   （y 0..4550）
 *        x 0..1820 土間収納（y 4550..6370）| 1820..3640 洗面脱衣室 | 3640..5460 ＵＢ | 5460..7280 パントリー（y 4550..6370）
 *        トイレ 7280..8190（y 4550..6370）
 */
function house(): BuildingModel {
  n = 0;
  const ent = room('玄関', 'entrance', rect(0, 0, 3640, 4550));
  const hall = room('ホール', 'hall', rect(3640, 0, 5460, 4550));
  const ldk = room('ＬＤＫ', 'ldk', rect(5460, 0, 12740, 4550));
  const sic = room('土間収納', 'storage', rect(0, 4550, 1820, 6370));
  const wash = room('洗面脱衣室', 'washroom', rect(1820, 4550, 3640, 6370));
  const bath = room('ＵＢ', 'bath', rect(3640, 4550, 5460, 6370));
  const pantry = room('パントリー', 'storage', rect(5460, 4550, 7280, 6370));
  const toilet = room('トイレ', 'toilet', rect(7280, 4550, 8190, 6370));
  const d1 = doorV('W1', 3640, 0, 4550); // 玄関-ホール
  const d2 = doorV('W2', 5460, 0, 4550); // ホール-LDK
  const d3 = doorH('W3', 4550, 1820, 3640); // ホール? いや玄関-洗面… 玄関(0..3640) の下に洗面(1820..3640): 玄関-洗面
  const d4 = doorH('W4', 4550, 5460, 7280); // LDK-パントリー
  const d5 = doorH('W5', 4550, 0, 1820); // 玄関-土間収納
  const d6 = doorV('W6', 3640, 4550, 6370); // 洗面-UB
  const f1: Floor = { level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, walls: [d1, d2, d3, d4, d5, d6].map((d) => d.wall), openings: [d1, d2, d3, d4, d5, d6].map((d) => d.op), rooms: [ent, hall, ldk, sic, wash, bath, pantry, toilet], stairs: [], outline: [] };
  return { name: 't', floors: [f1], northAngleDeg: 0, module: 910 } as unknown as BuildingModel;
}

describe('間取りの読み解き（設計意図）', () => {
  it('パントリー・帰宅動線・土間収納・水まわりの集中・玄関とLDKの関係を読む', () => {
    const its = readDesignIntents(house());
    const ids = its.map((i) => i.id);
    expect(ids.some((i) => i.startsWith('pantry-'))).toBe(true);
    const pantry = its.find((i) => i.id.startsWith('pantry-'))!;
    expect(pantry.title).toMatch(/買い物動線/);
    expect(ids).toContain('home-wash');
    expect(ids).toContain('sic');
    expect(ids).toContain('wet-1');
    expect(its.find((i) => i.id === 'wet-1')!.title).toMatch(/背中合わせ|一か所/);
    expect(its.find((i) => i.id === 'ent-ldk')!.title).toMatch(/ホール/);
    // お客様向けの文はどれも空でない
    for (const i of its) expect(i.customer.length).toBeGreaterThan(5);
  });

  it('パントリーがキッチンに接していなければ買い物動線は出ない', () => {
    const m = house();
    const f = m.floors[0];
    // パントリーを遠くへ
    const p = f.rooms.find((r) => r.name === 'パントリー')!;
    p.polygon = rect(20000, 20000, 21820, 21820);
    f.openings = f.openings.filter((o) => o.wallId !== 'W4');
    const its = readDesignIntents(m);
    expect(its.some((i) => i.id.startsWith('pantry-'))).toBe(false);
  });
});
