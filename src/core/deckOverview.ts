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
