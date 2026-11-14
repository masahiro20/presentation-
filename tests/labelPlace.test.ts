// 平面図の文字の置き場所（drawings/labelPlace.ts）と、長い室名の 2 行分け（drawings/plan.ts）
import { describe, expect, it } from 'vitest';
import { boxAt, boxInside, overlapArea, placeLabel, type LabelBox } from '../src/drawings/labelPlace';
import { splitRoomName } from '../src/drawings/plan';

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
// 室名「主寝室 (7帖)」ほどの箱（幅 1,000・高さ 600）
const REL: LabelBox = { x0: -500, x1: 500, y0: -300, y1: 300 };
const ROOM = rect(0, 0, 3640, 3640);

describe('文字の箱', () => {
  it('重なりの面積・部屋に収まるか', () => {
    expect(overlapArea({ x0: 0, y0: 0, x1: 100, y1: 100 }, { x0: 50, y0: 50, x1: 200, y1: 200 })).toBe(2500);
    expect(overlapArea({ x0: 0, y0: 0, x1: 100, y1: 100 }, { x0: 100, y0: 0, x1: 200, y1: 100 })).toBe(0);
    expect(boxInside(boxAt({ x: 1820, y: 1820 }, REL), ROOM)).toBe(true);
    expect(boxInside(boxAt({ x: 300, y: 1820 }, REL), ROOM)).toBe(false);
    // L 字の部屋: 欠けた角に掛かる箱は「収まっていない」
    const L = [{ x: 0, y: 0 }, { x: 3640, y: 0 }, { x: 3640, y: 1820 }, { x: 1820, y: 1820 }, { x: 1820, y: 3640 }, { x: 0, y: 3640 }];
    expect(boxInside(boxAt({ x: 2000, y: 2000 }, REL), L)).toBe(false);
    expect(boxInside(boxAt({ x: 910, y: 2700 }, REL), L)).toBe(true);
  });
});

describe('室名の置き場所', () => {
  it('家具にも文字にも重ならず、部屋に収まっていれば動かさない', () => {
    const at = { x: 1820, y: 1820 };
    expect(placeLabel({ at, rel: REL, within: ROOM, obstacles: [{ x0: 0, y0: 0, x1: 900, y1: 900 }], taken: [] })).toEqual(at);
  });

  it('ベッドの上に載る室名は、部屋の中の空いた所へ動く（重なりが無くなる）', () => {
    // 部屋の上半分にベッド。室名は図面ではベッドの真ん中に書かれていた
    const bed: LabelBox = { x0: 800, y0: 200, x1: 2800, y1: 2200 };
    const at = { x: 1800, y: 1200 };
    const moved = placeLabel({ at, rel: REL, within: ROOM, obstacles: [bed], taken: [] });
    expect(moved).not.toEqual(at);
    expect(overlapArea(boxAt(moved, REL), bed)).toBe(0);
    expect(boxInside(boxAt(moved, REL), ROOM)).toBe(true);
    // 遠くへ飛ばさない（ベッドのすぐ下か横）
    expect(Math.hypot(moved.x - at.x, moved.y - at.y)).toBeLessThan(1700);
  });

  it('少しだけ掛かっている程度では動かさない', () => {
    // 箱の端が家具に 50mm 掛かるだけ: 減点が 6 割未満になる位置でも、ほぼ同じ場所なら…ではなく、動かす距離の減点と比べて決まる
    const desk: LabelBox = { x0: 2270, y0: 1500, x1: 2600, y1: 1540 };
    const at = { x: 1820, y: 1820 };
    const b = boxAt(at, REL);
    expect(overlapArea(b, desk)).toBeGreaterThan(0);
    const moved = placeLabel({ at, rel: REL, within: ROOM, obstacles: [desk], taken: [] });
    // 動いたとしても文字の高さの半分以内
    expect(Math.hypot(moved.x - at.x, moved.y - at.y)).toBeLessThanOrEqual(300);
  });

  it('先に置いた文字とは重ねない（「上部吹抜」が室名の上に載らない）', () => {
    const taken = [boxAt({ x: 1820, y: 1820 }, REL)];
    const voidRel: LabelBox = { x0: -420, x1: 420, y0: -130, y1: 110 };
    const at = { x: 1820, y: 1880 };
    const moved = placeLabel({ at, rel: voidRel, within: ROOM, obstacles: [], taken });
    expect(overlapArea(boxAt(moved, voidRel), taken[0])).toBe(0);
  });

  it('壁に掛かっている室名は、近くに収まる所があれば部屋の中へ戻す。遠くにしか無ければ動かさない', () => {
    // 図面の位置が左の壁ぎわ（箱の左が部屋の外）
    const at = { x: 300, y: 1820 };
    const moved = placeLabel({ at, rel: REL, within: ROOM, obstacles: [], taken: [] });
    expect(boxInside(boxAt(moved, REL), ROOM)).toBe(true);
    expect(moved.y).toBe(1820);
    expect(moved.x - at.x).toBeLessThanOrEqual(260);
    // 部屋より大きい文字（半間の物入）は動かさない
    const closet = rect(0, 0, 455, 1820);
    expect(placeLabel({ at: { x: 227, y: 910 }, rel: REL, within: closet, obstacles: [], taken: [] })).toEqual({ x: 227, y: 910 });
    // 収まる所が 1.3 m より遠い（細い廊下の先の広い所）なら、その場のまま
    const corridor = [{ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 5000 }, { x: 3000, y: 5000 }, { x: 3000, y: 7000 }, { x: 0, y: 7000 }];
    expect(placeLabel({ at: { x: 450, y: 1000 }, rel: REL, within: corridor, obstacles: [], taken: [] })).toEqual({ x: 450, y: 1000 });
  });
});

describe('長い室名を 2 行に分ける位置', () => {
  it('字の種類の変わり目で、真ん中に近い所', () => {
    expect(splitRoomName('脱衣ランドリー')).toEqual(['脱衣', 'ランドリー']);
    expect(splitRoomName('pantry兼物入')).toEqual(['pantry', '兼物入']);
    expect(splitRoomName('洗面脱衣室・ランドリー')).toEqual(['洗面脱衣室', 'ランドリー']);
    expect(splitRoomName('キャットウォーク・猫部屋')).toEqual(['キャットウォーク', '猫部屋']);
  });
  it('字の種類が変わらない名前・短い名前は分けない', () => {
    expect(splitRoomName('ファミリークローゼット')).toBeNull();
    expect(splitRoomName('LDK')).toBeNull();
    expect(splitRoomName('主寝室')).toBeNull();
  });
});
