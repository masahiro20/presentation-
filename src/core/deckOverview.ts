/**
 * 提案資料の「出すページ」と「建築概要」の上書き（右のメモ）。
 * 画面に依らない純粋な処理（テスト用に分けている）
 */

/** 概要版（会社紹介と概要の提出・記録用）に入れるページの id */
export const SUMMARY_PAGES = ['cover', 'philosophy', 'approach', 'overview', 'close'] as const;

export interface DeckSelection {
  pages?: 'all' | 'summary' | 'custom';
  custom?: string[];
}

/** 出すページの id の集合。null = すべて */
export function selectedPageIds(sel: DeckSelection | undefined, allIds: string[]): Set<string> | null {
  const mode = sel?.pages ?? 'all';
  if (mode === 'all') return null;
  if (mode === 'summary') return new Set(SUMMARY_PAGES);
  const custom = (sel?.custom ?? []).filter((id) => allIds.includes(id));
  // 何も選んでいなければ全部（空の資料を出さない）
  return custom.length ? new Set(custom) : null;
}

/** 建築概要の自動の行を作る材料（画面の状態から拾ったもの） */
export interface OverviewInput {
  /** 書類に載せる敷地所在地（documentAddress）。無ければ null → 「—」（右のメモの欄に住所を入れてもらう） */
  address: string | null;
  /** 建築面積 ㎡（1 階の区画。吹抜・バルコニーを除く） */
  buildArea: number;
  /** 階ごとの床面積 ㎡（1 階から順。吹抜・バルコニー・ポーチ・ガレージ・外構を除く） */
  floorAreas: number[];
  /** 構造（既定: ＳＥ構法） */
  structure?: string;
  /** 主要用途（既定: 住宅） */
  use?: string;
}

const TSUBO_M2 = 3.30579;
const m2 = (a: number) => `${a.toFixed(2)} ㎡`;
const m2Tsubo = (a: number) => `${a.toFixed(2)} ㎡（約 ${(a / TSUBO_M2).toFixed(1)} 坪）`;

/**
 * 建築概要の自動の行。敷地所在地 → 面積（建築・延床・2 階建て以上は階ごと）→ 構造・規模・主要用途の順。
 * LDK の帖数・外観・内観のテイストは載せない（2026-11-08 御社の指示: 概要の項目としては要らない）。
 * 用途地域・工期・設計者などは右のメモ（足す行）で足す
 */
export function buildOverviewRows(i: OverviewInput): [string, string][] {
  const floors = i.floorAreas;
  const total = floors.reduce((s, a) => s + a, 0);
  const rows: [string, string][] = [
    ['敷地所在地', i.address ?? '—'],
    ['建築面積', m2Tsubo(i.buildArea)],
    ['延床面積', m2Tsubo(total)],
  ];
  if (floors.length >= 2) floors.forEach((a, k) => rows.push([`${k + 1}階床面積`, m2(a)]));
  rows.push(['構造', i.structure ?? 'ＳＥ構法'], ['規模', `${Math.max(1, floors.length)}階建て`], ['主要用途', i.use ?? '住宅']);
  return rows;
}

/** 「項目：値」の行を読む（全角・半角のコロン、タブ区切りも可）。項目の無い行は飛ばす */
export function parseOverviewExtra(text: string | undefined): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^：:\t]+?)\s*[：:\t]\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    if (!key) continue;
    out.push([key, m[2].trim()]);
  }
  return out;
}

/** 行を消す印（上書きの値がこれなら行を出さない） */
const REMOVE = /^(×|✕|✖|－|-|—|削除|消す|なし)$/;

/**
 * 自動で作った建築概要の行に、右のメモの上書きと追加の行を当てる。
 * - overrides[項目] が空でなければ値を差し替える。「×」などなら行を消す
 * - extra の「項目：値」は、同じ項目があれば差し替え、無ければ末尾に足す（同じく「×」で消せる）
 */
export function applyOverviewMemo(rows: [string, string][], overrides: Record<string, string> | undefined, extra: string | undefined): [string, string][] {
  const out: [string, string][] = [];
  const key = (s: string) => s.normalize('NFKC').replace(/\s+/g, '');
  const ov = new Map<string, string>();
  for (const [k, v] of Object.entries(overrides ?? {})) if (v != null && v.trim()) ov.set(key(k), v.trim());
  for (const [k, v] of parseOverviewExtra(extra)) ov.set(key(k), v);
  const seen = new Set<string>();
  for (const [k, v] of rows) {
    const o = ov.get(key(k));
    seen.add(key(k));
    if (o == null) out.push([k, v]);
    else if (!REMOVE.test(o)) out.push([k, o]);
  }
  for (const [k, v] of parseOverviewExtra(extra)) {
    if (seen.has(key(k))) continue;
    seen.add(key(k));
    if (!REMOVE.test(v)) out.push([k, v]);
  }
  return out;
}
