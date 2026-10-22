import { describe, it, expect } from 'vitest';
import { stairEntryFromArrow } from '../src/parser/stairs';
import type { Seg } from '../src/parser/walls';

const seg = (x0: number, y0: number, x1: number, y1: number): Seg => ({ a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, width: 1, dashed: false, source: 'stroke' });
const r = { minX: 0, minY: 0, maxX: 1820, maxY: 3640 };

describe('階段の昇り口を図面の矢印・UP/DN の文字から読む', () => {
  it('UP の文字が階段の下（南）の端にあれば南が昇り口', () => {
    expect(stairEntryFromArrow(r, [], [{ x: 900, y: 3700 }])).toBe('s');
    expect(stairEntryFromArrow(r, [], [{ x: -200, y: 1800 }])).toBe('w');
    // 遠い文字は使わない
    expect(stairEntryFromArrow(r, [], [{ x: 900, y: 5000 }])).toBeNull();
  });

  it('文字が無ければ、軸の端の矢じりを先端として反対の端を昇り口にする', () => {
    // 軸は南から北へ、先端（矢じり）は北
    const segs = [seg(900, 3400, 900, 300), seg(900, 300, 750, 520), seg(900, 300, 1050, 520)];
    expect(stairEntryFromArrow(r, segs, [])).toBe('s');
    // 折り返し: 軸がつながっていれば最初の軸の端（西）
    const segs2 = [seg(300, 3400, 300, 1000), seg(300, 1000, 1500, 1000), seg(1500, 1000, 1500, 300), seg(1500, 300, 1350, 520), seg(1500, 300, 1650, 520)];
    expect(stairEntryFromArrow(r, segs2, [])).toBe('s');
    // 線が無ければ null
    expect(stairEntryFromArrow(r, [], [])).toBeNull();
  });
});
