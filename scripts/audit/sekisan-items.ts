// 御社の積算ブックの明細（項目ごとの行）と、自動見積の行を、工事種別ごとに並べる。
//   npx tsx scripts/audit/sekisan-items.ts <モデル.model.json> <積算.xlsx> [--grade=P|S] [--own-qty] [--cats=7,9,10]
// 既定では、数量（床面積・外壁・屋根…）は「積算ブックの面シートの値」を自動見積に入れる。
// 図面の読み取りの誤差を切り離して、単価と項目の決め方の違いだけを見るため。--own-qty で図面からの拾いに切り替える。
// 図面・積算・出力はリポジトリに入れない（作業用フォルダに置く）。
import { readFileSync } from 'node:fs';
import type { BuildingModel } from '../../src/core/types';
import { takeoff, type Areas, type TakeoffOptions } from '../../src/estimate/areas';
import { computeEstimate, newChoice } from '../../src/estimate/calc';
import type { Grade } from '../../src/estimate/catalog';
import { DEFAULT_DESIGN, exteriorById } from '../../src/styles/presets';
import { readSekisan, readXlsx, type Cell } from './sekisan';

export interface SekisanItem {
  cat: number;
  name: string;
  spec: string;
  amount: number;
  price?: number;
  qty?: number;
  unit?: string;
}

const col = (ref: string) => /^[A-Z]+/.exec(ref)![0];
const rowNo = (ref: string) => +/\d+$/.exec(ref)![0];
const clean = (v: Cell | undefined) => String(v ?? '').replace(/[ｦ-ﾟァ-ヶー]{4,}$/u, '').replace(/\s+/g, ' ').trim();

/** 明細シート（B 列「N.工事名」で種別が変わり、C 名称・D 仕様・E 金額・F 単価・G 数量・H 単位）から、金額のある行を拾う */
export function readSekisanItems(file: string): SekisanItem[] {
  const wb = readXlsx(file) as unknown as { sheets?: Record<string, Record<string, Cell>> } & Record<string, Record<string, Cell>>;
  const sheets = wb.sheets ?? wb;
  const out: SekisanItem[] = [];
  for (const [name, cells] of Object.entries(sheets)) {
    if (/見積もり書|^面$/.test(name)) continue;
    const rows = new Map<number, Record<string, Cell>>();
    for (const [ref, v] of Object.entries(cells)) (rows.get(rowNo(ref)) ?? rows.set(rowNo(ref), {}).get(rowNo(ref))!)[col(ref)] = v;
    let cat = 0;
    let last = '';
    for (const r of [...rows.keys()].sort((a, b) => a - b)) {
      const c = rows.get(r)!;
      const head = /^\s*(\d{1,2})\s*[.．]/.exec(String(c.B ?? ''));
      if (head) {
        cat = +head[1];
        last = '';
        continue;
      }
      if (!cat) continue;
      if (c.C != null && String(c.C).trim()) last = clean(c.C);
      if (/小計/.test(String(c.C ?? ''))) continue;
      const amount = typeof c.E === 'number' ? c.E : 0;
      if (!amount) continue;
      out.push({ cat, name: last, spec: clean(c.D), amount, price: typeof c.F === 'number' ? c.F : undefined, qty: typeof c.G === 'number' ? c.G : undefined, unit: clean(c.H) || undefined });
    }
  }
  return out;
}

const main = () => {
  const args = process.argv.slice(2);
  const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
  const [modelFile, xlsx] = args.filter((a) => !a.startsWith('--'));
  if (!modelFile || !xlsx) {
    console.log('usage: npx tsx scripts/audit/sekisan-items.ts <model.json> <sekisan.xlsx> [--grade=P] [--own-qty] [--cats=7,9]');
    process.exit(1);
  }
  const ext = exteriorById(DEFAULT_DESIGN.exteriorId);
  const opts: TakeoffOptions = { grade: (flags.grade as Grade) ?? 'P', eavesMm: ext.roof.eaves, pitch: ext.roof.pitch, roofType: ext.roof.type, solido: ext.accent ? ext.accentRule : 'none' };
  const model: BuildingModel = JSON.parse(readFileSync(modelFile, 'utf8'));
  const sk = readSekisan(xlsx);
  const own = takeoff(model, opts);
  // 積算の面シートの数量を重ねる（延床・施工面積などの合計は、重ねた値から計算し直す）
  const areas: Areas = 'own-qty' in flags ? own : ({ ...own, ...sk.areas } as Areas);
  if (!('own-qty' in flags)) {
    areas.totalArea = areas.floor1 + areas.floor2 + areas.floor3;
    areas.totalTsubo = areas.totalArea / 3.30579;
    if (sk.constM2) areas.constArea = sk.constM2;
    if (sk.constTsubo) areas.constTsubo = sk.constTsubo;
  }
  const est = computeEstimate(areas, newChoice(opts.grade, areas));
  const items = readSekisanItems(xlsx);
  const only = flags.cats ? String(flags.cats).split(',').map(Number) : null;
  const yen = (v: number) => Math.round(v).toLocaleString('ja-JP').padStart(11);
  console.log(`=== ${model.name} ⇔ ${sk.file}（提出 ${sk.submitted ?? '—'}）　数量: ${'own-qty' in flags ? '図面からの拾い' : '積算の面シート'}／グレード ${opts.grade}`);
  for (const c of est.categories) {
    const no = c.def.no;
    if (only && !only.includes(no)) continue;
    const theirs = items.filter((i) => i.cat === no);
    const tSum = theirs.reduce((s, i) => s + i.amount, 0);
    console.log(`\n--- ${no}.${c.def.name}　積算 ${yen(tSum).trim()} 円 ／ 自動 ${yen(c.amount).trim()} 円（差 ${yen(c.amount - tSum).trim()}）`);
    console.log('  [積算]');
    for (const i of theirs) console.log(`  ${yen(i.amount)}  ${i.name}｜${i.spec.slice(0, 34)}  ${i.price != null ? `@${Math.round(i.price).toLocaleString('ja-JP')}` : ''} × ${i.qty ?? ''} ${i.unit ?? ''}`);
    console.log('  [自動]');
    for (const l of c.lines.filter((x) => x.selected && x.amount)) console.log(`  ${yen(l.amount)}  ${l.spec}｜${l.desc.slice(0, 34)}  @${Math.round(l.unitPrice).toLocaleString('ja-JP')} × ${Math.round(l.qty * 100) / 100} ${l.unit}`);
  }
};
if (process.argv[1]?.endsWith('sekisan-items.ts')) main();
