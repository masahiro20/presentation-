/**
 * コーディネートの選択肢の一覧（docs/FINISHES.md）をカタログから作る。カタログを変えたら作り直す:
 *   npx tsx scripts/finishes-doc.ts
 */
import { writeFileSync } from 'node:fs';
import { FINISH_CATEGORIES } from '../src/coordinate/catalog';
import { ROUNDS, EQUIPMENT_CATS } from '../src/coordinate/decisions';
import { MOODS } from '../src/coordinate/moods';

const cat = (id: string) => FINISH_CATEGORIES.find((c) => c.id === id)!;
const esc = (s: string | undefined) => (s ?? '').replace(/\|/g, '／');
const lines: string[] = [
  '# コーディネートの選択肢（一覧）',
  '',
  'ツールの「コーディネート」に入っている商品の一覧です（`src/coordinate/catalog.ts` から `npx tsx scripts/finishes-doc.ts` で作成）。',
  '「御社の採用例」は、過去のお客様の床仕様書・内部仕上表・立面図で実際に使った所です（お客様名は載せていません）。',
  '色名・品番がメーカーの資料で確かめられない商品は「※品番は品番メモに」として、打ち合わせで正確な品番を入れます。',
  '',
];
for (const r of [...ROUNDS, { no: 0, title: '設備の仕様（色のコーディネートではなく確認だけ）', cats: EQUIPMENT_CATS }]) {
  lines.push(`## ${r.no ? `${'①②③'[r.no - 1]} ` : ''}${r.title}`, '');
  for (const id of r.cats) {
    const c = cat(id);
    lines.push(`### ${c.label}（${c.products.length}）`, '', '| メーカー | 商品 | 品番・仕様 | 色 | 御社の採用例・メモ |', '|---|---|---|---|---|');
    for (const p of c.products) lines.push(`| ${esc(p.maker)} | ${esc(p.name)} | ${esc(p.code)} | ${esc(p.color)} | ${esc([p.used, p.note].filter(Boolean).join('。'))} |`);
    lines.push('');
  }
}
lines.push('## 雰囲気（ムード）', '', '| 雰囲気 | 組み合わせ | 合うお客様 |', '|---|---|---|');
for (const m of MOODS) lines.push(`| ${m.name} | ${esc(m.catch)} | ${esc(m.fits)} |`);
lines.push('');
writeFileSync(new URL('../docs/FINISHES.md', import.meta.url), lines.join('\n'));
console.log('docs/FINISHES.md', lines.length, 'lines');
