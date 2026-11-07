import { describe, expect, it } from 'vitest';
import { SUMMARY_PAGES, applyOverviewMemo, parseOverviewExtra, selectedPageIds } from '../src/core/deckOverview';

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
