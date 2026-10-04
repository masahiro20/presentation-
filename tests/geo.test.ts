/**
 * 住所検索（src/sun/geo.ts）の純粋な補助関数のテスト。ネットワークは使わない。
 * 精度判定（precisionOf）、緯度経度・Google マップ URL の読み取り（parsePoint）、
 * 末尾の番号の抽出（tailNumbers）、漢数字（kanjiToNum）
 */
import { describe, expect, it } from 'vitest';
import { kanjiToNum, parsePoint, precisionOf, tailNumbers, PRECISION_LABEL, osmTitle } from '../src/sun/geo';

describe('precisionOf: 住所文字列からどこまで特定できたかを判定', () => {
  const cases: [string, ReturnType<typeof precisionOf>][] = [
    ['愛知県名古屋市守山区瀬古東三丁目１２２番地', 'ban'],
    ['東京都世田谷区奥沢三丁目', 'chome'],
    ['愛知県小牧市小牧', 'town'],
    ['愛知県小牧市小牧四丁目213番5号', 'go'],
    ['愛知県小牧市小牧4-213-5', 'ban'],
  ];
  for (const [title, want] of cases) {
    it(`${title} → ${want}`, () => {
      expect(precisionOf(title)).toBe(want);
    });
  }
  it('全角数字（NFKC 正規化前）でも同じ判定になる', () => {
    expect(precisionOf('愛知県小牧市小牧４−２１３')).toBe('ban');
    expect(precisionOf('愛知県小牧市小牧四丁目２１３番５号')).toBe('go');
  });
  it('すべての精度にラベルがある', () => {
    for (const p of ['point', 'go', 'ban', 'chome', 'town'] as const) expect(PRECISION_LABEL[p]).toBeTruthy();
  });
});

describe('parsePoint: 緯度経度や Google マップ URL の直接指定', () => {
  it('"35.288, 136.924" → 座標（precision: point）', () => {
    const r = parsePoint('35.288, 136.924');
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(35.288, 6);
    expect(r!.lon).toBeCloseTo(136.924, 6);
    expect(r!.precision).toBe('point');
  });
  it('Google マップの URL（@lat,lon,zoom）から座標を読む', () => {
    const r = parsePoint('https://www.google.com/maps/@35.21058,136.93831,17z');
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(35.21058, 6);
    expect(r!.lon).toBeCloseTo(136.93831, 6);
    expect(r!.precision).toBe('point');
  });
  it('住所文字列は座標として解釈しない', () => {
    expect(parsePoint('東京都千代田区')).toBeNull();
  });
  it('日本の範囲外（91.0, 10.0）は null', () => {
    expect(parsePoint('91.0, 10.0')).toBeNull();
    // 小数 3 桁以上でも範囲外なら null
    expect(parsePoint('45.000, 10.000')).toBeNull();
  });
});

describe('tailNumbers: 入力末尾の丁目・番地・号の番号', () => {
  const cases: [string, number[]][] = [
    ['小牧4-213', [4, 213]],
    ['小牧4丁目213番地1号', [4, 213, 1]],
    ['瀬古東三丁目122番地', [122]],
    ['奥沢', []],
  ];
  for (const [q, want] of cases) {
    it(`${q || '(空)'} → [${want.join(', ')}]`, () => {
      expect(tailNumbers(q)).toEqual(want);
    });
  }
});

describe('kanjiToNum: 丁目に使われる範囲の漢数字', () => {
  const cases: [string, number][] = [
    ['三', 3],
    ['十', 10],
    ['十二', 12],
    ['二十', 20],
    ['4', 4],
  ];
  for (const [k, want] of cases) {
    it(`${k} → ${want}`, () => {
      expect(kanjiToNum(k)).toBe(want);
    });
  }
});

describe('osmTitle', () => {
  it('日本式の 1 行にし、次の部分の先頭と重複する町名は 1 回だけにする', () => {
    expect(osmTitle('奥沢三丁目, 奥沢, 世田谷区, 東京都, 158-0083, 日本')).toBe('東京都世田谷区奥沢三丁目');
    expect(osmTitle('瀬古東三丁目, 守山区, 名古屋市, 愛知県, 463-0090, 日本')).toBe('愛知県名古屋市守山区瀬古東三丁目');
    expect(osmTitle('122, 瀬古東三丁目, 守山区, 名古屋市, 愛知県, 日本')).toBe('愛知県名古屋市守山区瀬古東三丁目');
  });
});
