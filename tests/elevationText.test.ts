import { describe, it, expect } from 'vitest';
import { readElevationHeights } from '../src/parser/elevationText';
import type { RawText } from '../src/parser/pdfExtract';

const t = (str: string, cx: number, cy: number, size = 4): RawText => ({ str, cx, cy, size, width: str.length * size, angle: 0 }) as RawText;

describe('elevation heights', () => {
  it('reads FL labels, story heights, GL to 1FL, max height and roof pitch (page drawn rotated 90°)', () => {
    // ARCHITREND の立面図を 90° 回したページ: 1 階 FL → 2 階 FL → 3 階 FL が x の減る向きに並ぶ
    const texts = [
      t('南側 立面図', 380, 370),
      t('1階ＦＬ', 331, 122), t('2,580（階高）', 277, 110), t('633', 340, 110),
      t('2階ＦＬ', 258, 122), t('2,700（階高）', 202, 110),
      t('3階ＦＬ', 181, 122), t('2,657（階高）', 126, 110),
      t('9,302（最高高さ）', 90, 60), t('8,570（最高軒高）', 95, 70),
      t('10', 75, 354), t('0.5', 79, 365),
      // 別の階の平面図にある数字は拾わない
      t('910', 600, 500),
    ];
    const r = readElevationHeights([{ texts }]);
    expect(r).toEqual({ storyHeights: [2580, 2700, 2657], floor1: 633, maxHeight: 9302, maxEave: 8570, roofPitch: 0.5 });
  });
  it('ignores pages without an elevation', () => {
    expect(readElevationHeights([{ texts: [t('LDK', 10, 10), t('2,580（階高）', 20, 20)] }])).toBeNull();
  });
});
