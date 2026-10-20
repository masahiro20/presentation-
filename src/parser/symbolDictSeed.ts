/**
 * 記号辞書の初期値。御社の過去プラン 23 図面を読み取り、同じ形（部屋の種類×大きさ×中の線の段階）が
 * 2 回以上同じ家具になり、別の答えが一度も無かったものだけを入れてある（scripts/tmp/dict-seed.mjs で生成）。
 * 修正画面で覚えた答え（利用者の辞書）が常に優先され、この初期値は規則で決まらなかった候補にだけ使う。
 */
import type { SymbolSignature } from './symbolDict';

export const SYMBOL_DICT_SEED: Omit<SymbolSignature, 'source'>[] = [
  { room: 'bedroom', L: 2000, S: 1150, innerClass: 0, kind: 'bed', n: 3 },
  { room: 'bedroom', L: 2000, S: 1350, innerClass: 0, kind: 'bed', n: 3 },
  { room: 'bedroom', L: 2000, S: 950, innerClass: 0, kind: 'bed', n: 2 },
  { room: 'bedroom', L: 2050, S: 1050, innerClass: 1, kind: 'bed', n: 2 },
  { room: 'bedroom', L: 2050, S: 1350, innerClass: 0, kind: 'bed', n: 4 },
  { room: 'bedroom', L: 2150, S: 850, innerClass: 0, kind: 'bed', n: 5 },
  { room: 'hall', L: 800, S: 500, innerClass: 2, kind: 'washstand', n: 2 },
  { room: 'hall', L: 850, S: 400, innerClass: 3, kind: 'washstand', n: 2 },
  { room: 'ldk', L: 900, S: 900, innerClass: 0, kind: 'coffeeTable', n: 2 },
  { room: 'ldk', L: 1700, S: 650, innerClass: 3, kind: 'cupboard', n: 2 },
  { room: 'ldk', L: 2700, S: 650, innerClass: 3, kind: 'cupboard', n: 2 },
  { room: 'ldk', L: 8650, S: 700, innerClass: 3, kind: 'cupboard', n: 2 },
  { room: 'ldk', L: 1400, S: 700, innerClass: 2, kind: 'dining', n: 2 },
  { room: 'ldk', L: 1800, S: 750, innerClass: 0, kind: 'dining', n: 2 },
  { room: 'ldk', L: 2750, S: 900, innerClass: 3, kind: 'kitchen', n: 3 },
  { room: 'ldk', L: 5900, S: 900, innerClass: 1, kind: 'kitchen', n: 2 },
  { room: 'ldk', L: 1800, S: 750, innerClass: 1, kind: 'sofa', n: 2 },
  { room: 'washroom', L: 600, S: 550, innerClass: 1, kind: 'washer', n: 2 },
  { room: 'washroom', L: 650, S: 600, innerClass: 3, kind: 'washer', n: 2 },
  { room: 'washroom', L: 900, S: 550, innerClass: 3, kind: 'washstand', n: 7 },
  { room: 'washroom', L: 1200, S: 550, innerClass: 3, kind: 'washstand', n: 3 },
  { room: 'washroom', L: 1650, S: 600, innerClass: 3, kind: 'washstand', n: 3 },
];
