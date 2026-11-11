import { describe, expect, it } from 'vitest';
import { classifyRoomName, isSpecialRoomName, parseAreaLabel } from '../src/parser/labels';

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
    ['玄関ホール', 'hall'],
    ['ホール', 'hall'],
    ['小上がり', 'japanese'],
    ['畳スペース', 'japanese'],
    ['ヌック', 'study'],
    ['ワークスペース', 'study'],
    ['バルコニー', 'balcony'],
    ['インナーガレージ', 'garage'],
    ['吹抜', 'void'],
    // 第 42 巡 ⑧: 室名は読めているのに「用途が分からない」になっていた名前
    ['仕事部屋', 'study'],
    ['事務室', 'study'],
    ['勉強コーナー', 'study'],
    ['ロッカー', 'closet'],
    ['茶室', 'japanese'],
    // 第 42 巡 ⑨: 趣味の部屋（池本様邸 2 階の「漫画部屋」）
    ['漫画部屋', 'study'],
    ['ゲームコーナー', 'study'],
    ['図書コーナー', 'study'],
  ];
  for (const [s, t] of cases) it(`${s} → ${t}`, () => expect(classifyRoomName(s)).toBe(t));
  it('用途は分かるが種類を当てはめない部屋（ペット室・ジム・音楽室・EV）は、名前で見分ける', () => {
    for (const n of ['ペット室', 'キャットウォーク・猫部屋', 'ジム', '歌部屋', '音楽室', '防音室', 'サウナ', 'EV', 'ＥＶ', 'エレベーター']) {
      expect(isSpecialRoomName(n), n).toBe(true);
      expect(classifyRoomName(n), n).toBeNull();
    }
    for (const n of ['室', '部屋', 'ニッチ', '洋室', 'LEVEL']) expect(isSpecialRoomName(n), n).toBe(false);
  });
  it('庭などは室名にしない', () => {
    expect(classifyRoomName('GARDEN')).toBeNull();
    expect(classifyRoomName('N')).toBeNull();
  });
  it('帖数', () => {
    expect(parseAreaLabel('LDK20.5帖')?.tatami).toBe(20.5);
    expect(parseAreaLabel('6J')?.tatami).toBe(6);
  });
});
