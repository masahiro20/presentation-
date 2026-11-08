/**
 * 契約前チェック（社内用。アイデア台帳 S10）: 見積・資金計画に「抜け」が無いかを項目ごとに確かめる。
 * 外構・地盤・申請・照明・カーテン・エアコン・登記・火災保険・水道引込・予備費と、仕様の希望（太陽光・長期優良・浄化槽・準防火）に対する費用の有無。
 * 画面に依らない純粋な判定（テスト用に分けている）。資料・見積書には出さない
 */
import type { FundRow, FundingInput } from './funding';

export interface PrecheckLine {
  desc: string;
  spec: string;
  selected: boolean;
  amount: number;
}

export type PrecheckStatus = 'ok' | 'warn' | 'na';

export interface PrecheckItem {
  id: string;
  label: string;
  status: PrecheckStatus;
  /** 見つかった金額（円）。無ければ 0 */
  amount: number;
  /** どこで見つけたか／抜けているときの直し方 */
  note: string;
}

const sumRows = (rows: FundRow[], re: RegExp) => rows.filter((r) => re.test(r.label)).reduce((s, r) => s + (r.amount || 0), 0);
const sumLines = (lines: PrecheckLine[], re: RegExp) => lines.filter((l) => l.selected && (re.test(l.desc) || re.test(l.spec))).reduce((s, l) => s + (l.amount || 0), 0);
const hasLine = (lines: PrecheckLine[], re: RegExp) => lines.some((l) => l.selected && (re.test(l.desc) || re.test(l.spec)));

/**
 * 項目ごとに判定する。na は「対象外（お客様手配・不要）」にした項目（id → true）
 */
export function contractPrecheck(lines: PrecheckLine[], f: FundingInput, na: Record<string, boolean> = {}): PrecheckItem[] {
  const out: PrecheckItem[] = [];
  const push = (id: string, label: string, found: number | boolean, okNote: string, warnNote: string) => {
    const amount = typeof found === 'number' ? found : 0;
    const ok = typeof found === 'number' ? found > 0 : found;
    out.push({ id, label, status: na[id] ? 'na' : ok ? 'ok' : 'warn', amount, note: ok ? okNote : warnNote });
  };
  // 資金計画の行（⑤その他・②付帯・③追加変更・⑥ローン諸経費）
  push('exterior', '外構工事', sumRows(f.other, /外構|造成/), '資金計画 ⑤その他工事費', '資金計画 ⑤に外構工事の概算が入っていません（目安 150〜300 万円。別途工事ならお客様に伝える）');
  push('ground', '地盤改良', sumRows(f.other, /地盤/), '資金計画 ⑤その他工事費', '地盤改良の予算が 0 円です。地盤調査の結果が出るまでは予算組み（御社の標準 100 万円）を');
  push('water', '水道引込・市納金', sumRows(f.other, /水道|市納金/), '資金計画 ⑤その他工事費', '水道引き込み・市納金が 0 円です。前面道路の本管と既存の引き込みを確認');
  push('reserve', '予備費', sumRows(f.changes, /予備費/), '資金計画 ③追加変更工事', '予備費が 0 円です（御社の標準 50 万円）');
  push('permit', '確認申請', sumRows(f.loanFees, /確認申請/), '資金計画 ⑥ローン諸経費', '確認申請の印紙代・手数料が 0 円です');
  push('registration', '建物の登記', sumRows(f.loanFees, /登記/), '資金計画 ⑥ローン諸経費', '登記費用が 0 円です（建物の表題・保存登記）');
  push('insurance', '火災保険', sumRows(f.loanFees, /火災保険/), '資金計画 ⑥ローン諸経費', '火災保険料が 0 円です（ローンの条件になることが多い）');
  // 見積の行（選択中の行だけ）
  push('lighting', '照明器具', sumLines(lines, /照明/), '見積の電気工事', '照明器具の行が見積にありません（施主支給なら「対象外」に）');
  push('curtain', 'カーテン・ブラインド', sumLines(lines, /カーテン|ブラインド|ロールスクリーン|シェード/), '見積の内装工事', 'カーテン・ブラインドの費用がありません（別途・お客様手配なら「対象外」に）');
  push('ac', 'エアコン', hasLine(lines, /エアコン|空調/) && !hasLine(lines, /空調なし|エアコンは別途/), '見積の設備工事', 'エアコンが「なし（別途）」です。台数・取付費をどこで見るかお客様と確認');
  // 仕様の希望と費用の対応
  if (f.site.pv === '希望する') push('pv', '太陽光（希望あり）', hasLine(lines, /太陽光|kw|kW/) && !hasLine(lines, /太陽光なし/), '見積の設備工事', '太陽光を希望なのに見積は「太陽光なし」です');
  if (f.site.longLife === '希望する') push('longlife', '長期優良住宅（希望あり）', sumRows(f.attached, /長期優良/) + sumLines(lines, /長期優良/), '資金計画 ②付帯工事・見積の諸経費', '長期優良住宅を希望なのに申請費が 0 円です');
  if (f.site.sewer === '浄化槽') push('septic', '浄化槽（排水: 浄化槽）', sumRows(f.attached, /浄化槽/) + sumLines(lines, /浄化槽|人槽/), '資金計画 ②付帯工事・見積の給排水工事', '排水が浄化槽なのに浄化槽の費用が 0 円です');
  if (f.site.fireZone) push('fire', '準防火地域（該当）', sumRows(f.attached, /準防火/), '資金計画 ②付帯工事', '準防火地域なのに割増が 0 円です（施工床面積 × 33,000 円）');
  return out;
}

/** 件数のまとめ（折りたたみの見出し用） */
export function precheckSummary(items: PrecheckItem[]): { warn: number; ok: number; na: number; text: string } {
  const warn = items.filter((i) => i.status === 'warn').length;
  const ok = items.filter((i) => i.status === 'ok').length;
  const na = items.filter((i) => i.status === 'na').length;
  return { warn, ok, na, text: warn ? `⚠ ${warn} 件の抜け` : `抜けなし（${ok} 件 ✓${na ? `・対象外 ${na}` : ''}）` };
}
