// 図面のメモを、家具の記号の読み取りの手がかりにする（伊藤様邸 1 階の LDK から）
//  - 「TV 周り作りこむ」のそばの、壁沿いの奥行 750 の台はテレビ台（ソファではない）
//  - そのテレビ台のそばの、壁から離れた長方形がソファ（テレビ台の側を向く）
//  - 壁沿いのカウンターの前に、食卓と島（シンク）が並ぶとき、キッチンの相手は島
import { describe, expect, it } from 'vitest';
import { memoHintKind, readContextItems } from '../src/parser/context';
import type { Seg } from '../src/parser/walls';
import type { Room, Vec2, Wall } from '../src/core/types';

const seg = (a: Vec2, b: Vec2, width = 0.12): Seg => ({ a, b, width, dashed: false, source: 'stroke' });
const rectSegs = (x0: number, y0: number, x1: number, y1: number): Seg[] => [seg({ x: x0, y: y0 }, { x: x1, y: y0 }), seg({ x: x1, y: y0 }, { x: x1, y: y1 }), seg({ x: x1, y: y1 }, { x: x0, y: y1 }), seg({ x: x0, y: y1 }, { x: x0, y: y0 })];
const rectPts = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const ldk: Room = { id: 'R1', name: 'ＬＤＫ', type: 'ldk', polygon: rectPts(0, 0, 9000, 6000), area: 54, labelPos: { x: 4500, y: 3000 } };
const walls: Wall[] = [
  { id: 'W1', a: { x: 0, y: 0 }, b: { x: 9000, y: 0 }, thickness: 105, exterior: true },
  { id: 'W2', a: { x: 9000, y: 0 }, b: { x: 9000, y: 6000 }, thickness: 105, exterior: true },
  { id: 'W3', a: { x: 9000, y: 6000 }, b: { x: 0, y: 6000 }, thickness: 105, exterior: true },
  { id: 'W4', a: { x: 0, y: 6000 }, b: { x: 0, y: 0 }, thickness: 105, exterior: true },
];
// 北の壁沿いの造作のテレビ台（1,800 × 750）と、その東に、壁から離して縦に置いたソファ（750 × 1,800）
const tvBoard = rectSegs(2000, 55, 3800, 805);
const sofa = rectSegs(4400, 800, 5150, 2600);

describe('メモの言葉から、そばの家具の種類を読む', () => {
  it('テレビ・TV', () => {
    expect(memoHintKind('TV周り作りこむ')).toBe('tv');
    expect(memoHintKind('壁掛けテレビ')).toBe('tv');
    expect(memoHintKind('ＴＶボード造作')).toBe('tv');
    expect(memoHintKind('背面収納として活用')).toBeNull();
  });
});

describe('メモのそばの壁沿いの台はテレビ台、そのそばの長方形がソファ', () => {
  it('メモが無いと、奥行 750 の壁沿いの台はソファに読まれ、本物のソファは読めない（今までどおり）', () => {
    const res = readContextItems([...tvBoard, ...sofa], [], [ldk], walls, 1);
    expect(res.items.filter((q) => q.kind === 'sofa').map((q) => q.y)).toEqual([55]);
    expect(res.items.some((q) => q.kind === 'tv')).toBe(false);
  });

  it('メモ「TV 周り作りこむ」がそばにあれば、台はテレビ台、離して置いた長方形がソファ', () => {
    const res = readContextItems([...tvBoard, ...sofa], [], [ldk], walls, 1, undefined, [], [], [{ x: 2700, y: 1100, kind: 'tv' }]);
    const tv = res.items.find((q) => q.kind === 'tv')!;
    expect(tv).toMatchObject({ x: 2900, y: 55, w: 1.8 });
    const sf = res.items.filter((q) => q.kind === 'sofa');
    expect(sf.length).toBe(1);
    expect(sf[0].w).toBe(1.8);
    // ソファは縦置き（長手が南北）。向き（inward = (-sin r, cos r)）は、テレビ台のある西側
    const r = (sf[0].rot * Math.PI) / 180;
    expect(-Math.sin(r)).toBeCloseTo(-1, 5);
    // 背は東の辺
    expect(sf[0].x).toBe(5150);
  });

  it('メモから遠い台（1.5 m より先）・別の部屋のメモは使わない', () => {
    const far = readContextItems([...tvBoard, ...sofa], [], [ldk], walls, 1, undefined, [], [], [{ x: 7500, y: 4500, kind: 'tv' }]);
    expect(far.items.some((q) => q.kind === 'tv')).toBe(false);
    const out = readContextItems([...tvBoard, ...sofa], [], [ldk], walls, 1, undefined, [], [], [{ x: -500, y: 400, kind: 'tv' }]);
    expect(out.items.some((q) => q.kind === 'tv')).toBe(false);
  });
});

describe('壁沿いのカウンターの前に、食卓と島が並ぶキッチン', () => {
  // 東の壁沿いのカウンター（650 × 4,500。コンロ側）。その 1 m 手前に、北から 食卓（850 × 1,800・椅子 4）と 島（900 × 1,850・シンクの線）
  const back = rectSegs(8295, 60, 8945, 4560);
  const table = rectSegs(6450, 100, 7300, 1900);
  const chairs = [rectSegs(5900, 300, 6400, 800), rectSegs(5900, 1100, 6400, 1600), rectSegs(7350, 300, 7850, 800), rectSegs(7350, 1100, 7850, 1600)].flat();
  const island = rectSegs(6400, 2700, 7300, 4550);
  // シンク（槽の四角と、水栓・水切りの線）
  const sink = [...rectSegs(6500, 3300, 6950, 4050), ...rectSegs(6560, 3360, 6890, 3990), seg({ x: 6500, y: 3200 }, { x: 6950, y: 3200 }), seg({ x: 6725, y: 3200 }, { x: 6725, y: 3300 })];

  it('島がキッチン（対面の手前）、食卓は食卓のまま', () => {
    const res = readContextItems([...back, ...table, ...chairs, ...island, ...sink], [], [ldk], walls, 1);
    const k = res.items.filter((q) => q.kind === 'kitchen');
    expect(k.length).toBe(1);
    // キッチンの基準は島の側（壁付け I 型にしない）
    expect(k[0].kitchenType).not.toBe('wall');
    expect(Math.abs(k[0].y - 3625)).toBeLessThan(1000);
    const d = res.items.filter((q) => q.kind === 'dining');
    expect(d.length).toBe(1);
    expect(Math.abs(d[0].y - 1000)).toBeLessThan(600);
  });

  it('手前の台が食卓だけなら、今までどおり「壁付け＋手前の食卓」', () => {
    const res = readContextItems([...back, ...table, ...chairs], [], [ldk], walls, 1);
    expect(res.items.find((q) => q.kind === 'kitchen')?.kitchenType).toBe('wall');
    expect(res.items.filter((q) => q.kind === 'dining').length).toBe(1);
  });
});
