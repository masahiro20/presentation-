import { describe, it, expect } from 'vitest';
import { takeoff } from '../src/estimate/areas';
import { newChoice, computeEstimate } from '../src/estimate/calc';
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

// 御社の拾い方（堀様邸・有元様邸の見積の「面」シート）に合わせた規則
describe('積算の数量: 御社の「面」シートの拾い方', () => {
  // 1 階: 10m × 6m から 4m × 3m の中庭（外形の切り欠き）を除いた形。2 階: 1 階より西へ 1m 張り出した 8m × 6m
  const f1 = floor(1, [[{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 }, { x: 10000, y: 3000 }, { x: 10000, y: 6000 }, { x: 0, y: 6000 }]], [
    room('c', '中庭', 'balcony', rect(6000, 0, 10000, 3000)),
    room('l', 'ＬＤＫ', 'ldk', rect(0, 0, 6000, 6000)),
    room('w', '洗面・トイレ', 'washroom', rect(6000, 3000, 10000, 6000)),
  ]);
  const f2 = floor(2, [rect(-1000, 0, 7000, 6000)], [room('v', '吹抜', 'void', rect(0, 0, 3000, 3000)), room('b', '寝室', 'bedroom', rect(3000, 0, 7000, 6000)), room('t', 'トイレ', 'toilet', rect(-1000, 0, 0, 2000))]);
  const model = { floors: [f1, f2] } as unknown as BuildingModel;
  const a = takeoff(model, { grade: 'P', eavesMm: 0, pitch: 0.5, roofType: 'shed' });

  it('外形の外にある中庭は床面積から引かない（引くのは外形の内側の吹抜だけ）', () => {
    expect(a.floor1).toBeCloseTo(48, 1);
    expect(a.floor2).toBeCloseTo(48 - 9, 1);
    expect(a.balconyArea).toBe(0); // 1 階の中庭はバルコニーではない
  });
  it('上の階の下の屋外（張り出し）を施工面積の追加分に、建築面積・屋根は外形を重ねた面積で拾う', () => {
    // 西へ 1m × 6m ＋ 中庭の上に 1m × 3m かかる分
    expect(a.extraArea).toBeCloseTo(9, 0);
    expect(a.buildArea).toBeCloseTo(57, 0);
    expect(a.roofArea).toBeCloseTo(57, 0);
    expect(a.insulArea).toBeCloseTo(66, 0); // 屋根の下の天井 57 ＋ 張り出しの床下 9
  });
  it('洗面と一緒のトイレも数え、片流れの換気棟は 10m', () => {
    expect(a.toilets).toBe(2);
    expect(a.ridgeLen).toBe(10);
  });
  it('サッシは延床 28 坪で 1 式（0.5 式刻み）', () => {
    const r = computeEstimate({ ...a, totalTsubo: 42.08 }, newChoice('P'));
    const tw = r.categories.flatMap((c) => c.lines).find((l) => l.id === 'sash.tw')!;
    expect(tw.qty).toBe(1.5);
  });
  it('図面がアイランドキッチンなら見積の既定もアイランド', () => {
    expect(newChoice('P', { kitchenType: 'island' }).groups.kitchen).toBe('eq.kitchenHlIsland');
    expect(newChoice('P', { kitchenType: 'wall' }).groups.kitchen).toBe('eq.kitchenHlWall');
    expect(newChoice('P').groups.kitchen).toBe('eq.kitchenHl');
  });
});

// ガレージの拾い方（御社の見積の約束）: ビルトインガレージは床面積に入れず施工面積に。土間は外部ポーチと同じ扱い。
// 外壁・屋根は建物と同じに拾う。ガレージには断熱を入れない（上が屋根なら天井の断熱から、外壁の断熱からガレージの壁を引く）
describe('積算の数量: ビルトインガレージ', () => {
  // 1 階 10m × 6m: 西の 5m × 6m がガレージ。2 階 5m × 6m は東半分（ガレージの上は屋根）
  const f1 = floor(1, [rect(0, 0, 10000, 6000)], [room('g', 'ガレージ', 'garage', rect(0, 0, 5000, 6000)), room('l', 'ＬＤＫ', 'ldk', rect(5000, 0, 10000, 6000))]);
  const f2 = floor(2, [rect(5000, 0, 10000, 6000)], [room('b', '寝室', 'bedroom', rect(5000, 0, 10000, 6000))]);
  const a = takeoff({ floors: [f1, f2] } as unknown as BuildingModel, { grade: 'P', eavesMm: 0, pitch: 0.5, roofType: 'shed' });

  it('床面積に入れず、施工面積（追加分）と外部ポーチ（土間）に入れる', () => {
    expect(a.garageArea).toBeCloseTo(30, 1);
    expect(a.floor1).toBeCloseTo(30, 1);
    expect(a.extraArea).toBeCloseTo(30, 0);
    expect(a.constArea).toBeCloseTo(30 + 30 + 30, 0);
    expect(a.porchOut).toBeCloseTo(30, 1);
  });
  it('外壁・屋根・建築面積は建物と同じに拾う（ガレージを外形から外さない）', () => {
    expect(a.buildArea).toBeCloseTo(60, 0);
    expect(a.roofArea).toBeCloseTo(60, 0);
    // 1 階 32m × (2.9 + 0.5) ＋ 2 階 22m × 2.9 ＋ パラペット
    expect(a.extWall).toBeGreaterThan(32 * 3.4 + 22 * 2.9);
  });
  it('断熱: ガレージの上の屋根は天井の断熱に入れず、ガレージの外壁は壁の断熱に入れない', () => {
    expect(a.insulArea).toBeCloseTo(30, 0); // 屋根の下の天井 60 − ガレージの上 30
    // ガレージの外壁 (5 + 6 + 5) m × 3.4 = 54.4㎡ を引く
    expect(a.extWall - a.insulWall).toBeCloseTo(54.4, 0);
  });
  it('ガレージの上に 2 階が載るときは、その天井は断熱に入る（外部床ではなく上の階の床）', () => {
    const f2b = floor(2, [rect(0, 0, 10000, 6000)], [room('b', '寝室', 'bedroom', rect(0, 0, 10000, 6000))]);
    const b = takeoff({ floors: [f1, f2b] } as unknown as BuildingModel, { grade: 'P', eavesMm: 0, pitch: 0.5, roofType: 'shed' });
    expect(b.insulArea).toBeCloseTo(60, 0);
  });
});
