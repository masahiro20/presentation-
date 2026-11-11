// 玄関の区画を、土間（タイル）と上がり框の先の床（ホール）に分ける（第 42 巡 ⑫。市岡様邸・堀様邸・伊藤様邸・舟橋様邸）
import { describe, expect, it } from 'vitest';
import { splitEntranceFloor } from '../src/parser/entranceFloor';
import type { RoomType, Vec2 } from '../src/core/types';

const RES = 20;
const W = 160; // 3,200mm
const H = 220; // 4,400mm
const grid = { w: W, h: H, res: RES, cellOf: (p: Vec2): [number, number] => [Math.floor(p.x / RES), Math.floor(p.y / RES)] };
const seg = (x0: number, y0: number, x1: number, y1: number) => ({ a: { x: x0, y: y0 }, b: { x: x1, y: y1 } });
const name = (type: RoomType | null, x: number, y: number) => ({ x, y, type });

/** 区画（ラベル 1）: x 200..2,930、y 200..3,840（2,730 × 3,640）。まわりは 0（壁・外） */
const region = (): Int32Array => {
  const labels = new Int32Array(W * H);
  for (let j = 10; j < 192; j++) for (let i = 10; i < 147; i++) labels[j * W + i] = 1;
  return labels;
};
/** 上半分（y 200..2,020）のタイルの目地（300 角）と、y=2,020 の框の線 */
const tiles = (yEnd = 2020) => {
  const out: ReturnType<typeof seg>[] = [];
  for (let x = 500; x < 2930; x += 300) out.push(seg(x, 200, x, yEnd));
  for (let y = 500; y < yEnd; y += 300) out.push(seg(200, y, 2930, y));
  out.push(seg(200, yEnd, 2930, yEnd));
  return out;
};
const m2 = (cells: number[] | null) => ((cells?.length ?? 0) * RES * RES) / 1e6;
const ys = (cells: number[]) => cells.map((k) => ((k / W) | 0) * RES);

describe('玄関の土間と、框の先の床', () => {
  it('タイルの目地のある側が土間、線の無い広い側が床（ホール）。境は框の線', () => {
    const cells = splitEntranceFloor(grid, region(), 1, tiles(), [name('entrance', 1500, 1100)])!;
    expect(cells).not.toBeNull();
    // 床は y 2,020 より下（2,730 × 1,820 ≒ 4.97㎡。框の線の升は土間の側）
    expect(m2(cells)).toBeGreaterThan(4.7);
    expect(m2(cells)).toBeLessThan(5.0);
    expect(Math.min(...ys(cells))).toBeGreaterThanOrEqual(2020);
  });

  it('床の中の戸の軌跡・家具・引出線で切れた隅も、床に含める（輪郭に切れ込みを作らない）', () => {
    const extra = [
      seg(1000, 2800, 1700, 2800), seg(1700, 2800, 1700, 3200), seg(1700, 3200, 1000, 3200), seg(1000, 3200, 1000, 2800), // ベンチ
      seg(2930, 3000, 2200, 3840), // 戸の軌跡の代わりの斜めの線（隅を切る）
    ];
    const cells = splitEntranceFloor(grid, region(), 1, [...tiles(), ...extra], [name('entrance', 1500, 1100)])!;
    expect(m2(cells)).toBeGreaterThan(4.7);
    expect(Math.min(...ys(cells))).toBeGreaterThanOrEqual(2020);
  });

  it('「玄関」の文字が線の無い広い側にある（目地の描かれていない土間）なら分けない', () => {
    expect(splitEntranceFloor(grid, region(), 1, tiles(), [name('entrance', 1500, 3000)])).toBeNull();
  });

  it('タイルの目地が無い（框の線だけ）なら、どちらが土間か決められないので分けない', () => {
    expect(splitEntranceFloor(grid, region(), 1, [seg(200, 2020, 2930, 2020)], [name('entrance', 1500, 1100)])).toBeNull();
  });

  it('床の側に「ホール」の文字があれば、目地が少なくても分ける（堀様邸: 玄関・ホールが 1 つの区画）', () => {
    // 目地は縦 2 本・横 1 本だけ（小さい範囲 6 個のうち文字のある所を含む）
    const few = [seg(1100, 200, 1100, 2020), seg(2000, 200, 2000, 2020), seg(200, 1100, 2930, 1100), seg(200, 2020, 2930, 2020)];
    const cells = splitEntranceFloor(grid, region(), 1, few, [name('entrance', 650, 650), name('hall', 1500, 3000)]);
    expect(m2(cells)).toBeGreaterThan(4.7);
  });

  it('玄関・ホール以外の室名が入った区画（壁の読めなかった大きな区画）は触らない', () => {
    expect(splitEntranceFloor(grid, region(), 1, tiles(), [name('entrance', 1500, 1100), name('ldk', 1500, 3000)])).toBeNull();
  });

  it('床が 1㎡ に満たない・土間の残りが 1㎡ に満たないときは分けない', () => {
    // 框が下の端から 300 の所: 床は 2,730 × 300 ≒ 0.8㎡
    expect(splitEntranceFloor(grid, region(), 1, tiles(3540), [name('entrance', 1500, 1100)])).toBeNull();
  });
});
