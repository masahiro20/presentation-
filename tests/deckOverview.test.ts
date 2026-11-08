import { describe, expect, it } from 'vitest';
import { SUMMARY_PAGES, applyOverviewMemo, buildOverviewRows, parseOverviewExtra, selectedPageIds } from '../src/core/deckOverview';
import { DEFAULT_SITE, coordAddress, documentAddress, siteAddressFromInput } from '../src/sun/geo';

describe('建築概要の自動の行', () => {
  it('2 階建て: 所在地 → 建築・延床（坪付き）→ 階ごとの床面積 → 構造・規模・用途。LDK・外観・内観は載せない', () => {
    const rows = buildOverviewRows({ address: '岐阜県可児市坂戸1234-5', buildArea: 65.4, floorAreas: [62.1, 55.2] });
    expect(rows.map(([k]) => k)).toEqual(['敷地所在地', '建築面積', '延床面積', '1階床面積', '2階床面積', '構造', '規模', '主要用途']);
    expect(rows.map(([k]) => k)).not.toContain('外観');
    expect(rows.map(([k]) => k)).not.toContain('内観');
    expect(rows.find(([k]) => k === '敷地所在地')![1]).toBe('岐阜県可児市坂戸1234-5');
    expect(rows.find(([k]) => k === '建築面積')![1]).toBe('65.40 ㎡（約 19.8 坪）');
    expect(rows.find(([k]) => k === '延床面積')![1]).toBe('117.30 ㎡（約 35.5 坪）');
    expect(rows.find(([k]) => k === '2階床面積')![1]).toBe('55.20 ㎡');
    expect(rows.find(([k]) => k === '規模')![1]).toBe('2階建て');
    expect(rows.find(([k]) => k === '構造')![1]).toBe('ＳＥ構法');
  });
  it('平屋: 階ごとの行は無く 6 行。住所が無ければ「—」', () => {
    const rows = buildOverviewRows({ address: null, buildArea: 90, floorAreas: [88] });
    expect(rows.map(([k]) => k)).toEqual(['敷地所在地', '建築面積', '延床面積', '構造', '規模', '主要用途']);
    expect(rows[0][1]).toBe('—');
    expect(rows.find(([k]) => k === '規模')![1]).toBe('1階建て');
  });
});

describe('敷地所在地は住所を入れる欄', () => {
  it('座標で決めた地点の「緯度／経度 付近」と既定の（仮）は書類に出さない（null）', () => {
    expect(documentAddress(coordAddress(35.41618, 137.03985))).toBeNull();
    expect(documentAddress('緯度 35.41618／経度 137.03985')).toBeNull();
    expect(documentAddress(DEFAULT_SITE.address)).toBeNull();
    expect(documentAddress('')).toBeNull();
    expect(documentAddress(undefined)).toBeNull();
    expect(documentAddress(' 岐阜県可児市坂戸1234-5 ')).toBe('岐阜県可児市坂戸1234-5');
  });
  it('住所欄を空にしたら、座標の地点は座標の住所、既定地は（仮）の住所に戻す（位置は保つ）', () => {
    const site = { lat: 35.41618, lon: 137.03985, address: '岐阜県可児市坂戸1234-5', offsetE: 0, offsetN: 0 };
    expect(siteAddressFromInput(site, '岐阜県可児市坂戸1234-6')).toBe('岐阜県可児市坂戸1234-6');
    expect(siteAddressFromInput(site, '  ')).toBe(coordAddress(35.41618, 137.03985));
    expect(siteAddressFromInput({ ...DEFAULT_SITE }, '')).toBe(DEFAULT_SITE.address);
  });
});

describe('資料の出すページ', () => {
  const all = ['cover', 'philosophy', 'approach', 'overview', 'finish', 'photo-ext-0', 'plan-1', 'close'];
  it('すべて（既定）は null', () => {
    expect(selectedPageIds(undefined, all)).toBeNull();
    expect(selectedPageIds({ pages: 'all' }, all)).toBeNull();
  });
  it('概要版は表紙・理念・アプローチ・建築概要・締めの 5 ページ', () => {
    const s = selectedPageIds({ pages: 'summary' }, all)!;
    expect([...s]).toEqual([...SUMMARY_PAGES]);
    expect(all.filter((id) => s.has(id))).toEqual(['cover', 'philosophy', 'approach', 'overview', 'close']);
  });
  it('選ぶ: 今あるページだけを数え、何も無ければすべて', () => {
    expect([...selectedPageIds({ pages: 'custom', custom: ['cover', 'plan-1', 'gone'] }, all)!]).toEqual(['cover', 'plan-1']);
    expect(selectedPageIds({ pages: 'custom', custom: ['gone'] }, all)).toBeNull();
    expect(selectedPageIds({ pages: 'custom' }, all)).toBeNull();
  });
});

describe('建築概要のメモ', () => {
  const rows: [string, string][] = [
    ['敷地所在地', '—'],
    ['建築面積', '70.00 ㎡'],
    ['延床面積', '120.00 ㎡（約 36.3 坪）'],
    ['構造', 'ＳＥ構法'],
    ['規模', '2階建て'],
  ];
  it('「項目：値」の行を読む（全角・半角のコロン）', () => {
    expect(parseOverviewExtra('工期：2026年4月〜9月\n用途地域: 第一種低層住居専用地域\n\nメモだけの行\n')).toEqual([
      ['工期', '2026年4月〜9月'],
      ['用途地域', '第一種低層住居専用地域'],
    ]);
  });
  it('項目ごとの上書き: 空は自動のまま、値は差し替え、× で消す', () => {
    const out = applyOverviewMemo(rows, { 敷地所在地: '岡崎市〇〇町 1-2', 構造: '', 規模: '×' }, undefined);
    expect(out).toEqual([
      ['敷地所在地', '岡崎市〇〇町 1-2'],
      ['建築面積', '70.00 ㎡'],
      ['延床面積', '120.00 ㎡（約 36.3 坪）'],
      ['構造', 'ＳＥ構法'],
    ]);
  });
  it('追加の行は末尾に足し、同じ項目なら差し替える（全角・半角の揺れも同じ項目）', () => {
    const out = applyOverviewMemo(rows, undefined, '工期：2026年4月〜9月\n延床面積: 118.50 ㎡\n建築 面積：×');
    expect(out.map(([k]) => k)).toEqual(['敷地所在地', '延床面積', '構造', '規模', '工期']);
    expect(out.find(([k]) => k === '延床面積')![1]).toBe('118.50 ㎡');
    expect(out.at(-1)).toEqual(['工期', '2026年4月〜9月']);
  });
  it('メモが無ければそのまま', () => {
    expect(applyOverviewMemo(rows, {}, '')).toEqual(rows);
  });
});
