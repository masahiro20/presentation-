// 図面のメモが書かれている場所に、造作を置く位置を決める（core/memoPlace.ts）
import { describe, expect, it } from 'vitest';
import { fitAlongWall, placeForMemo, relatedItem, sizeFromMemo, viewpointFor } from '../src/core/memoPlace';
import type { Floor, FurnitureItem, Opening, Room, Wall } from '../src/core/types';

const wall = (id: string, ax: number, ay: number, bx: number, by: number, extra: Partial<Wall> = {}): Wall => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 120, ...extra }) as Wall;
const room = (id: string, x0: number, y0: number, x1: number, y1: number, type = 'bedroom'): Room =>
  ({ id, name: id, type, polygon: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], area: ((x1 - x0) * (y1 - y0)) / 1e6, labelPos: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } }) as unknown as Room;
const floor = (walls: Wall[], rooms: Room[], openings: Partial<Opening>[] = []): Floor => ({ level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, walls, openings: openings.map((o, i) => ({ id: `O${i}`, kind: 'window', sill: 900, height: 1100, ...o })), rooms, stairs: [], outline: [] }) as unknown as Floor;

// 4 m × 3 m の部屋（左）と、その右隣の部屋。間の壁 W2 は 2 部屋で共有
const W = [wall('W1', 0, 0, 4000, 0), wall('W2', 4000, 0, 4000, 3000), wall('W3', 4000, 3000, 0, 3000), wall('W4', 0, 3000, 0, 0), wall('W5', 4000, 0, 7000, 0), wall('W6', 7000, 0, 7000, 3000), wall('W7', 7000, 3000, 4000, 3000)];
const R = [room('A', 0, 0, 4000, 3000), room('B', 4000, 0, 7000, 3000)];

describe('メモの文から寸法を読む', () => {
  it('W・D・幅・奥行', () => {
    expect(sizeFromMemo('机W2500~D500ほど')).toEqual({ w: 2.5, d: 0.5 });
    expect(sizeFromMemo('可動棚D450*5段:クロス色合わせ')).toEqual({ d: 0.45 });
    expect(sizeFromMemo('カウンター 幅1,800 奥行450')).toEqual({ w: 1.8, d: 0.45 });
    expect(sizeFromMemo('アートなど飾る飾り棚')).toEqual({});
    // ありえない寸法は読まない
    expect(sizeFromMemo('W90 D9000')).toEqual({});
  });
});

describe('メモの場所の壁ぎわ', () => {
  it('メモにいちばん近い壁の、部屋の側に置く（向きは部屋の内側）', () => {
    const p = placeForMemo(floor(W, R), { x: 2000, y: 400 }, 2.0)!;
    expect(p).toMatchObject({ roomId: 'A', wallId: 'W1', w: 2 });
    expect(p.x).toBe(2000);
    expect(p.y).toBe(65); // 壁の芯から 厚み/2 + 5 だけ部屋の側
    // inward = (-sin r, cos r) が +y（部屋の内側）
    const r = (p.rot * Math.PI) / 180;
    expect(-Math.sin(r)).toBeCloseTo(0, 5);
    expect(Math.cos(r)).toBeCloseTo(1, 5);
  });

  it('共有の壁は、メモがある部屋の側に置く', () => {
    const a = placeForMemo(floor(W, R), { x: 3700, y: 1500 }, 1.6)!;
    expect(a).toMatchObject({ roomId: 'A', wallId: 'W2' });
    expect(a.x).toBeLessThan(4000);
    const b = placeForMemo(floor(W, R), { x: 4300, y: 1500 }, 1.6)!;
    expect(b).toMatchObject({ roomId: 'B', wallId: 'W2' });
    expect(b.x).toBeGreaterThan(4000);
  });

  it('壁の端からはみ出さないように寄せる。窓・戸には掛けない', () => {
    // 端に近いメモ: 幅 2 m が壁（4 m）に収まるよう、中心を 1,060 以上に寄せる
    const p = placeForMemo(floor(W, R), { x: 300, y: 200 }, 2.0)!;
    expect(p.wallId).toBe('W1');
    expect(p.x).toBeGreaterThanOrEqual(1060);
    // 壁の真ん中に窓（1,200〜2,800）: 残りは左右 1.1 m ずつ → 幅 2 m の机は入らないので、別の壁へ
    const withWin = floor(W, R, [{ wallId: 'W1', t0: 1200, t1: 2800 }]);
    const q = placeForMemo(withWin, { x: 2000, y: 400 }, 2.0)!;
    expect(q.wallId).not.toBe('W1');
    // 幅 1 m の棚なら、窓の脇に入る
    const s = placeForMemo(withWin, { x: 2000, y: 400 }, 1.0)!;
    expect(s.wallId).toBe('W1');
    expect(s.x + 500).toBeLessThanOrEqual(1200 - 59);
  });

  it('壁が短いときは、入る幅に縮める（半分も入らなければ置かない）', () => {
    const small = floor([wall('S1', 0, 0, 1500, 0), wall('S2', 1500, 0, 1500, 1500), wall('S3', 1500, 1500, 0, 1500), wall('S4', 0, 1500, 0, 0)], [room('S', 0, 0, 1500, 1500)]);
    const p = placeForMemo(small, { x: 750, y: 300 }, 2.0)!;
    expect(p.w).toBeCloseTo(1.38, 2);
    expect(placeForMemo(small, { x: 750, y: 300 }, 4.0)).toBeNull();
  });

  it('部屋の外（余白）に書かれたメモ・腰壁の上には置かない', () => {
    expect(placeForMemo(floor(W, R), { x: -800, y: 1500 }, 1.6)).toBeNull();
    const low = floor([wall('W1', 0, 0, 4000, 0, { topMm: 1100 }), ...W.slice(1)], R);
    expect(placeForMemo(low, { x: 2000, y: 300 }, 2.0)!.wallId).not.toBe('W1');
  });
});

describe('メモのそばに、同じ役目の家具がすでに読めているとき', () => {
  const dims = (it: FurnitureItem) => ({ w: it.w ?? 1.2, d: it.d ?? 0.6 });
  // 南の壁（y = 3000）沿いの机（北向き: rot 180）と、北の壁沿いの本棚
  const desk: FurnitureItem = { id: 'D1', kind: 'desk', x: 2000, y: 2935, rot: 180, roomId: 'A' };
  const shelf: FurnitureItem = { id: 'B1', kind: 'bookshelf', x: 1000, y: 65, rot: 0, roomId: 'A' };
  const tv: FurnitureItem = { id: 'T1', kind: 'tv', x: 5500, y: 65, rot: 0, roomId: 'B', w: 1.8 };

  it('机のメモは机を、テレビのメモはテレビ台を、棚のメモは本棚を指す', () => {
    expect(relatedItem([desk, shelf, tv], { x: 2600, y: 2300 }, 'A', 'counter', dims)?.id).toBe('D1');
    expect(relatedItem([desk, shelf, tv], { x: 1200, y: 700 }, 'A', 'openShelf', dims)?.id).toBe('B1');
    expect(relatedItem([desk, shelf, tv], { x: 5400, y: 900 }, 'B', 'floatTv', dims)?.id).toBe('T1');
  });

  it('別の役目の家具・遠い家具・別の部屋の家具は指さない', () => {
    // 机のメモのそばに本棚しか無い
    expect(relatedItem([shelf], { x: 1200, y: 700 }, 'A', 'counter', dims)).toBeNull();
    // 机から 1.7 m より遠い
    expect(relatedItem([desk], { x: 200, y: 300 }, 'A', 'counter', dims)).toBeNull();
    // 壁の向こうの部屋の机
    expect(relatedItem([{ ...desk, roomId: 'B' }], { x: 2600, y: 2300 }, 'A', 'counter', dims)).toBeNull();
  });

  it('幅を広げるとき、部屋からはみ出さないように、壁に沿ってずらす・入らなければ縮める', () => {
    const A = R[0]; // 4 m × 3 m
    // 真ん中の机を 2.5 m に: そのまま入る
    expect(fitAlongWall(A, desk, 2.5)).toEqual({ x: 2000, y: 2935, w: 2.5 });
    // 端に寄った机（x = 700）を 2.5 m に: 入るように、部屋の中へずらす
    const near = fitAlongWall(A, { ...desk, x: 700 }, 2.5);
    expect(near.w).toBe(2.5);
    expect(near.x).toBeGreaterThanOrEqual(1250);
    expect(near.x).toBeLessThanOrEqual(1350);
    // 部屋（4 m）より広い 5 m は、入る幅に縮めて真ん中へ
    const wide = fitAlongWall(A, desk, 5);
    expect(wide.w).toBeLessThan(4);
    expect(wide.w).toBeGreaterThan(3.7);
    expect(Math.abs(wide.x - 2000)).toBeLessThan(60);
  });
});

describe('壁ぎわの家具が見える立ち位置', () => {
  it('家具の正面に、幅が収まる距離まで下がる（部屋の中）', () => {
    const A = R[0]; // 4 m × 3 m。南の壁沿いの机（北向き）
    const vp = viewpointFor(floor(W, R), A, { x: 2000, y: 2935, rot: 180 }, 2.0);
    expect(vp.x).toBe(2000);
    // 幅 2 m → 2.6 m 下がりたいが、北の壁（y = 0）の手前（背中 250 mm）まで
    expect(vp.back).toBeGreaterThanOrEqual(1.8);
    expect(vp.y).toBeGreaterThanOrEqual(250);
    expect(vp.y).toBeLessThan(2935 - 1700);
  });

  it('家具との間に袖壁が入る所には立たない', () => {
    // 机の正面 1.2 m に、ほぼ部屋いっぱいの袖壁（x 300〜4,000・y 1,700）: 向こう側からは机が見えない
    const walls = [...W, wall('S', 300, 1700, 4000, 1700)];
    const vp = viewpointFor(floor(walls, R), R[0], { x: 2000, y: 2935, rot: 180 }, 2.0);
    // 袖壁の手前（南側）に立つ
    expect(vp.y).toBeGreaterThan(1700);
    expect(vp.back).toBeLessThan(1.3);
    // 右半分だけの袖壁（x 2,050〜4,000）なら、机の全体が見える所（袖壁の無い西側から斜めに）まで下がる
    const half = viewpointFor(floor([...W, wall('S', 2050, 1700, 4000, 1700)], R), R[0], { x: 2000, y: 2935, rot: 180 }, 2.0);
    expect(half.back).toBeGreaterThan(1.8);
    expect(half.x).toBeLessThan(2000);
    // 背の高い家具（本棚）の後ろ・すぐそばにも立たない: 机の正面 1.5 m に本棚（幅 0.9・奥行 0.3）
    const shelfBox = [{ x: 1550, y: 1300 }, { x: 2450, y: 1300 }, { x: 2450, y: 1600 }, { x: 1550, y: 1600 }];
    const vs = viewpointFor(floor(W, R), R[0], { x: 2000, y: 2935, rot: 180 }, 2.0, [shelfBox]);
    // 本棚の真後ろ（机が隠れる所）・本棚のすぐそばではない
    expect(vs.x > 1200 && vs.x < 2800 && vs.y < 1950).toBe(false);
    // 腰壁（高さ 1.1 m）なら、越えて見える
    const low = [...W, wall('S', 300, 1700, 4000, 1700, { topMm: 1100 })];
    expect(viewpointFor(floor(low, R), R[0], { x: 2000, y: 2935, rot: 180 }, 2.0).back).toBeGreaterThanOrEqual(1.8);
  });
});
