import { describe, expect, it } from 'vitest';
import { classifyRoomName, parseAreaLabel } from '../src/parser/labels';

describe('室名の判定', () => {
  const cases: [string, string][] = [
    ['LDK', 'ldk'],
    ['ＬＤＫ 20.5帖', 'ldk'],
    ['LD', 'ldk'],
    ['洋室(1)', 'bedroom'],
    ['主寝室', 'bedroom'],
    ['子供室', 'kids'],
    ['WIC', 'closet'],
    ['W.I.C', 'closet'],
    ['FCL', 'closet'],
    ['ファミリークローゼット', 'closet'],
    ['SIC', 'storage'],
    ['シューズクローク', 'storage'],
    ['土間収納', 'storage'],
    ['パントリー', 'storage'],
    ['ランドリールーム', 'washroom'],
    ['洗面脱衣室', 'washroom'],
    ['UT', 'washroom'],
    ['UB', 'bath'],
    ['浴室', 'bath'],
    ['WC', 'toilet'],
    ['トイレ', 'toilet'],
    ['玄関ホール', 'entrance'],
    ['ホール', 'hall'],
    ['小上がり', 'japanese'],
    ['畳スペース', 'japanese'],
    ['ヌック', 'study'],
    ['ワークスペース', 'study'],
    ['バルコニー', 'balcony'],
    ['インナーガレージ', 'garage'],
    ['吹抜', 'void'],
  ];
  for (const [s, t] of cases) it(`${s} → ${t}`, () => expect(classifyRoomName(s)).toBe(t));
  it('庭などは室名にしない', () => {
    expect(classifyRoomName('GARDEN')).toBeNull();
    expect(classifyRoomName('N')).toBeNull();
  });
  it('帖数', () => {
    expect(parseAreaLabel('LDK20.5帖')?.tatami).toBe(20.5);
    expect(parseAreaLabel('6J')?.tatami).toBe(6);
  });
});
