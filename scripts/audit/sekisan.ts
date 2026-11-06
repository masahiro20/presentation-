// 御社の積算ブック（xlsx）を読んで、見積の自動拾い（takeoff／computeEstimate）と並べて比べる（scripts/audit/sekisan-compare.ts から使う）。
// xlsx は依存を増やさず zip（stored／deflate）と XML を直接読む。シート「面」の数量と「見積もり書」の工事種別ごとの金額だけを拾う。
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import type { BuildingModel } from '../../src/core/types';
import { takeoff, type Areas, type TakeoffOptions } from '../../src/estimate/areas';
import { computeEstimate, newChoice } from '../../src/estimate/calc';
import { CATEGORIES } from '../../src/estimate/catalog';

// ---------- xlsx を読む ----------
export function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip ではない');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const ln = buf.readUInt16LE(lho + 26);
    const le = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + ln + le;
    const data = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nlen + elen + clen;
  }
  return out;
}
const unesc = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&');
const textOf = (xml: string) => unesc([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

export type Cell = string | number;
export interface Workbook {
  sheets: Record<string, Record<string, Cell>>;
}
export function readXlsxBuffer(buf: Buffer): Workbook {
  const z = unzip(buf);
  const get = (n: string) => z.get(n)?.toString('utf8') ?? '';
  const sst = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const rels = new Map<string, string>();
  for (const m of get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : 'xl/' + target);
  }
  const sheets: Workbook['sheets'] = {};
  for (const m of get('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = unesc(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? '');
    const rid = /\br:id="([^"]+)"/.exec(m[1])?.[1];
    const file = rid ? rels.get(rid) : undefined;
    if (!file) continue;
    const cells: Record<string, Cell> = {};
    for (const c of get(file).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+\d+)"/.exec(c[1])?.[1];
      if (!ref || c[2] == null) continue;
      const t = /\bt="(\w+)"/.exec(c[1])?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[2])?.[1];
      if (t === 's') cells[ref] = sst[+(v ?? 0)] ?? '';
      else if (t === 'inlineStr') cells[ref] = textOf(c[2]);
      else if (t === 'str' || t === 'e') cells[ref] = unesc(v ?? '');
      else if (t === 'b') cells[ref] = v === '1' ? 1 : 0;
      else if (v != null && v !== '') cells[ref] = Number(v);
    }
    sheets[name] = cells;
  }
  return { sheets };
}
export const readXlsx = (file: string): Workbook => readXlsxBuffer(readFileSync(file));

// ---------- 積算ブックの読み取り ----------
export interface Sekisan {
  file: string;
  customer: string;
  submitted?: string;
  /** 施工面積・延床（坪・㎡） */
  constTsubo?: number;
  constM2?: number;
  totalTsubo?: number;
  totalM2?: number;
  /** 「面」シートの数量（見積の Areas のキーで） */
  areas: Partial<Record<keyof Areas, number>>;
  /** 「面」シートの生の行（ラベル → 値） */
  rows: { label: string; value: number }[];
  /** 工事種別ごとの金額（税抜）と原価 */
  cats: { no: number; name: string; amount: number; cost?: number }[];
  subtotal?: number;
  tax?: number;
  totalTaxIn?: number;
}
/** 「面」シートのラベル → Areas のキー */
const AREA_LABELS: [RegExp, keyof Areas][] = [
  [/^[1１]階床面積/, 'floor1'],
  [/^[2２]階床面積/, 'floor2'],
  [/^[3３]階床面積/, 'floor3'],
  [/^外部ポーチ/, 'porchOut'],
  [/^内部ポーチ/, 'porchIn'],
  [/^バルコニー面積/, 'balconyArea'],
  [/^建築面積/, 'buildArea'],
  [/^外壁面積/, 'extWall'],
  [/^基礎外周/, 'foundPerim'],
  [/^軒天面積/, 'soffitArea'],
  [/^屋根面積/, 'roofArea'],
  [/^吹き?抜け?/, 'voidArea'],
  [/^軒先/, 'eaveLen'],
  [/^建物角/, 'corners'],
  [/^断熱面積/, 'insulArea'],
  [/^高天井/, 'highCeil'],
  [/^勾配天井/, 'slopeCeil'],
  [/^ロフト/, 'loftArea'],
  [/^敷地外周/, 'siteEdge'],
  [/^建具個数/, 'doors'],
  [/^フローリング面積/, 'flooringArea'],
  [/^フロアタイル面積/, 'floorTileArea'],
];
const colLetters = (ref: string) => /^[A-Z]+/.exec(ref)![0];
const rowNo = (ref: string) => +/\d+$/.exec(ref)![0];
const colIndex = (col: string) => [...col].reduce((s, ch) => s * 26 + (ch.charCodeAt(0) - 64), 0);
/** 行の中で、fromCol より右（toCol まで）にある最初の数値 */
function firstNumberRight(cells: Record<string, Cell>, row: number, fromCol: string, toCol = 'Z'): number | undefined {
  const from = colIndex(fromCol);
  const to = colIndex(toCol);
  const found = Object.entries(cells)
    .filter(([ref, v]) => rowNo(ref) === row && typeof v === 'number' && colIndex(colLetters(ref)) > from && colIndex(colLetters(ref)) <= to)
    .sort((a, b) => colIndex(colLetters(a[0])) - colIndex(colLetters(b[0])));
  return found.length ? (found[0][1] as number) : undefined;
}
export const excelDate = (serial: number) => new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);

export function readSekisanWorkbook(wb: Workbook, file = ''): Sekisan {
  const names = Object.keys(wb.sheets);
  const menName = names.find((n) => n === '面') ?? names.find((n) => /^面/.test(n));
  if (!menName) throw new Error(`「面」シートが無い: ${names.join(', ')}`);
  const men = wb.sheets[menName];
  const out: Sekisan = { file: path.basename(file), customer: '', areas: {}, rows: [], cats: [] };
  const labelsAt = Object.entries(men)
    .filter(([ref, v]) => colLetters(ref) === 'B' && typeof v === 'string' && v.trim())
    .map(([ref, v]) => ({ row: rowNo(ref), label: (v as string).replace(/\s+/g, ' ').trim() }))
    .sort((a, b) => a.row - b.row);
  for (const { row, label } of labelsAt) {
    if (/^お客様名/.test(label)) {
      const nm = Object.entries(men).find(([ref, v]) => rowNo(ref) === row && colLetters(ref) !== 'B' && typeof v === 'string' && /様/.test(v));
      if (nm) out.customer = (nm[1] as string).trim();
      const dt = Object.entries(men).find(([ref, v]) => rowNo(ref) === row && colIndex(colLetters(ref)) >= colIndex('W') && typeof v === 'number' && v > 40000);
      if (dt) out.submitted = excelDate(dt[1] as number);
      continue;
    }
    if (/^施工面積/.test(label) && row <= 7) {
      out.constTsubo = firstNumberRight(men, row, 'B', 'K');
      out.constM2 = firstNumberRight(men, row, 'K', 'N');
      continue;
    }
    if (/^延床面積/.test(label) && row <= 7) {
      out.totalTsubo = firstNumberRight(men, row, 'B', 'K');
      out.totalM2 = firstNumberRight(men, row, 'K', 'N');
      continue;
    }
    const value = firstNumberRight(men, row, 'N', 'S');
    if (value == null) continue;
    out.rows.push({ label, value });
    if (/^施工面積/.test(label)) {
      out.areas.extraArea = value; // 延床に足す分（ポーチ・ガレージ・下屋など）
      continue;
    }
    const hit = AREA_LABELS.find(([re]) => re.test(label));
    if (hit) out.areas[hit[1]] = value;
  }
  // 見積もり書: 「1.仮設工事」のような行が並ぶシート
  const estName = names.find((n) => Object.values(wb.sheets[n]).some((v) => typeof v === 'string' && /^\s*1\.\s*仮設/.test(v)));
  if (estName) {
    const sh = wb.sheets[estName];
    const rows = Object.entries(sh)
      .filter(([ref, v]) => colLetters(ref) === 'B' && typeof v === 'string')
      .map(([ref, v]) => ({ row: rowNo(ref), text: (v as string).trim() }))
      .sort((a, b) => a.row - b.row);
    for (const { row, text } of rows) {
      const m = /^(\d{1,2})\.\s*(.+)$/.exec(text);
      if (m) {
        const amount = firstNumberRight(sh, row, 'B', 'AR');
        const cost = firstNumberRight(sh, row, 'AZ', 'BC');
        if (amount != null) out.cats.push({ no: +m[1], name: m[2].trim(), amount, cost });
        continue;
      }
      if (/^小計/.test(text)) out.subtotal = firstNumberRight(sh, row, 'B', 'AR');
      else if (/^税額/.test(text)) out.tax = firstNumberRight(sh, row, 'B', 'AR');
      else if (/^金額\s*\(税込\)|^金額（税込）/.test(text)) out.totalTaxIn = firstNumberRight(sh, row, 'B', 'R');
    }
  }
  return out;
}
export const readSekisan = (file: string): Sekisan => readSekisanWorkbook(readXlsx(file), file);

// ---------- 比べる ----------
const AREA_ROWS: { key: keyof Areas; label: string; unit: string }[] = [
  { key: 'floor1', label: '1階床面積', unit: '㎡' },
  { key: 'floor2', label: '2階床面積', unit: '㎡' },
  { key: 'floor3', label: '3階床面積', unit: '㎡' },
  { key: 'porchOut', label: '外部ポーチ・テラス', unit: '㎡' },
  { key: 'porchIn', label: '内部ポーチ・テラス', unit: '㎡' },
  { key: 'extraArea', label: '施工面積の追加分', unit: '㎡' },
  { key: 'balconyArea', label: 'バルコニー', unit: '㎡' },
  { key: 'voidArea', label: '吹き抜け', unit: '㎡' },
  { key: 'buildArea', label: '建築面積', unit: '㎡' },
  { key: 'extWall', label: '外壁面積', unit: '㎡' },
  { key: 'foundPerim', label: '基礎外周', unit: 'm' },
  { key: 'soffitArea', label: '軒天面積', unit: '㎡' },
  { key: 'roofArea', label: '屋根面積', unit: '㎡' },
  { key: 'eaveLen', label: '軒先', unit: 'm' },
  { key: 'corners', label: '建物角', unit: 'ヵ所' },
  { key: 'insulArea', label: '断熱面積（天井＆外部床）', unit: '㎡' },
  { key: 'highCeil', label: '高天井（H2500 からの差）', unit: '㎥' },
  { key: 'slopeCeil', label: '勾配天井', unit: '㎡' },
  { key: 'siteEdge', label: '敷地外周', unit: 'm' },
  { key: 'doors', label: '建具個数', unit: '箇所' },
  { key: 'flooringArea', label: 'フローリング', unit: '㎡' },
  { key: 'floorTileArea', label: 'フロアタイル', unit: '㎡' },
];

export interface CompareRow {
  label: string;
  unit: string;
  sekisan?: number;
  auto: number;
  diff?: number;
  pct?: number;
}
export interface CompareResult {
  model: string;
  sekisan: Sekisan;
  opts: TakeoffOptions;
  areas: CompareRow[];
  cats: CompareRow[];
  totals: CompareRow[];
}
export function compareSekisan(model: BuildingModel, sk: Sekisan, opts: TakeoffOptions): CompareResult {
  const areas = takeoff(model, opts);
  const est = computeEstimate(areas, newChoice(opts.grade, areas));
  const row = (label: string, unit: string, sekisan: number | undefined, auto: number): CompareRow => {
    const r: CompareRow = { label, unit, sekisan, auto };
    if (sekisan != null) {
      r.diff = Math.round((auto - sekisan) * 100) / 100;
      r.pct = sekisan ? Math.round(((auto - sekisan) / sekisan) * 1000) / 10 : undefined;
    }
    return r;
  };
  const areaRows = AREA_ROWS.map((a) => row(a.label, a.unit, sk.areas[a.key], areas[a.key] as number));
  const catRows = CATEGORIES.map((c) => {
    const s = sk.cats.find((x) => x.no === c.no);
    const mine = est.categories.find((x) => x.def.id === c.id);
    return row(`${c.no}.${c.name}`, '円', s?.amount, mine?.amount ?? 0);
  });
  const totals = [
    row('延床面積', '㎡', sk.totalM2, areas.totalArea),
    row('延床', '坪', sk.totalTsubo, areas.totalTsubo),
    row('施工面積', '㎡', sk.constM2, areas.constArea),
    row('施工面積', '坪', sk.constTsubo, areas.constTsubo),
    row('小計（税抜）', '円', sk.subtotal, est.subtotal),
    row('税込', '円', sk.totalTaxIn, est.total),
  ];
  return { model: model.name, sekisan: sk, opts, areas: areaRows, cats: catRows, totals };
}

const fmt = (v: number | undefined, unit: string) => (v == null ? '—' : unit === '円' ? Math.round(v).toLocaleString('ja-JP') : (Math.round(v * 100) / 100).toLocaleString('ja-JP', { maximumFractionDigits: 2 }));
const pad = (s: string, n: number, right = false) => {
  // 全角は 2 幅として揃える
  const w = [...s].reduce((t, ch) => t + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
  const sp = ' '.repeat(Math.max(0, n - w));
  return right ? sp + s : s + sp;
};
export function formatCompare(r: CompareResult): string {
  const lines: string[] = [];
  lines.push(`=== ${r.model} ⇔ ${r.sekisan.file}（${r.sekisan.customer}${r.sekisan.submitted ? ' 提出 ' + r.sekisan.submitted : ''}）`);
  lines.push(`    拾いの条件: 屋根 ${r.opts.roofType} ／ 軒の出 ${r.opts.eavesMm} ／ 勾配 ${r.opts.pitch} 寸 ／ グレード ${r.opts.grade} ／ アクセント ${r.opts.solido ?? 'none'}`);
  const head = `${pad('項目', 28)}${pad('積算', 14, true)}${pad('自動', 14, true)}${pad('差', 12, true)}${pad('差%', 8, true)}`;
  const body = (rows: CompareRow[]) => {
    for (const x of rows) {
      const flag = x.pct != null && Math.abs(x.pct) >= 10 && Math.abs(x.diff ?? 0) >= (x.unit === '円' ? 100000 : 1) ? ' ◆' : '';
      lines.push(`${pad(x.label + ' ' + x.unit, 28)}${pad(fmt(x.sekisan, x.unit), 14, true)}${pad(fmt(x.auto, x.unit), 14, true)}${pad(x.diff == null ? '' : fmt(x.diff, x.unit), 12, true)}${pad(x.pct == null ? '' : x.pct.toFixed(1) + '%', 8, true)}${flag}`);
    }
  };
  lines.push('--- 面（数量）');
  lines.push(head);
  body(r.areas);
  lines.push('--- 工事種別（税抜）');
  lines.push(head);
  body(r.cats);
  lines.push('--- 合計');
  body(r.totals);
  return lines.join('\n');
}
