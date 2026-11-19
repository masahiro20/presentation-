/**
 * 資料・体験リンクをお客様に出す前の確認: 重大な警告と、外観・見積に効く未確認の推定を一覧で見せる。
 * 出力は止めない（社内確認用・打合せ用など、担当者が用途に応じて判断する）。何も無ければ確認の窓は出さない。
 */
import type { BuildingModel } from '../core/types';
import { exportChecklist } from '../core/readiness';
import { h, modal } from './dom';

export function confirmBeforeExport(model: BuildingModel | null | undefined, what: string, proceed: () => void): void {
  const items = model ? exportChecklist(model) : [];
  if (!items.length) {
    proceed();
    return;
  }
  const body = h(
    'div',
    { class: 'export-check' },
    h('p', null, `${what}の前に、まだ確認されていない重要な項目が ${items.length} 件あります。お客様に出す資料に使うときは、内容を確かめてから出してください。`),
    h('ul', { class: 'ready-list' }, ...items.map((it) => h('li', null, h('b', null, it.title), h('div', { class: 'ready-how' }, it.detail)))),
    h('p', { class: 'hint' }, '読み込み結果の「未確定の情報」で「確認した」を押した項目は、次からこの一覧に出ません。'),
  );
  modal(`${what}の前の確認`, body, [{ label: '戻って確認する' }, { label: '内容を理解して出力する', primary: true, onClick: proceed }]);
}
