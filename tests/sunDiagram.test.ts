// 太陽の通り道の図（sun/sunDiagram.ts）: 時刻の札を出す時刻と、重なった札の間引き
import { describe, expect, it } from 'vitest';
import { declutter, labelHours, SEASON_COLORS, type LabelBox } from '../src/sun/sunDiagram';

const box = (x: number, y: number, priority: number, depth = 10, w = 40, h = 16): LabelBox => ({ x0: x, y0: y, x1: x + w, y1: y + h, priority, depth });

describe('時刻の札', () => {
  it('冬至は偶数時、春秋分・夏至は 3 時間ごと。12 時は季節の札があるので出さない', () => {
    // 名古屋あたりの日の出・日の入（冬至 6:57〜16:44、夏至 4:38〜19:10、春分 5:56〜18:04）
    expect(labelHours('winter', 6.95, 16.73)).toEqual([8, 10, 14, 16]);
    expect(labelHours('summer', 4.63, 19.17)).toEqual([6, 9, 15, 18]);
    expect(labelHours('spring', 5.93, 18.07)).toEqual([6, 9, 15, 18]);
  });
  it('季節の色は 3 つとも違う', () => {
    expect(new Set(Object.values(SEASON_COLORS)).size).toBe(3);
  });
});

describe('重なった札の間引き', () => {
  it('重ならなければ全部出す', () => {
    expect(declutter([box(0, 0, 50), box(100, 0, 50), box(0, 100, 50)])).toEqual([true, true, true]);
  });
  it('重なったら大事な方（方位 > 季節 > 時刻）を残す', () => {
    const hour = box(10, 5, 50);
    const season = box(0, 0, 86, 10, 120, 22);
    const north = box(100, 0, 100, 10, 24, 24);
    // 季節の札と時刻が重なる → 季節を残す
    expect(declutter([hour, season])).toEqual([false, true]);
    // 北の札と季節の札が重なる → 北を残す。季節が消えたので、季節とだけ重なっていた時刻は出せる
    expect(declutter([hour, season, north])).toEqual([true, false, true]);
  });
  it('同じ大事さなら手前（カメラに近い方）を残す', () => {
    expect(declutter([box(0, 0, 50, 30), box(10, 4, 50, 12)])).toEqual([false, true]);
  });
  it('画面の外・カメラの後ろ（null）は出さない。すき間 3px 以内も重なりとみなす', () => {
    expect(declutter([null, box(0, 0, 50)])).toEqual([false, true]);
    expect(declutter([box(0, 0, 60), box(42, 0, 50)])).toEqual([true, false]);
    expect(declutter([box(0, 0, 60), box(44, 0, 50)])).toEqual([true, true]);
  });
});
