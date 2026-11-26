// 設計士の判定用: 元の図面（PDF の該当範囲）と、ツールが読み取って起こした平面図を左右に並べ、階ごとに 1 ページの PDF にする
// WORK=<作業用フォルダ> npx tsx scripts/audit/reviewSheets.ts <out.pdf> <pdf...>
// お客様の図面なので、出力は作業用の場所に置く（リポジトリに入れない）
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, globSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSample } from '../../tests/pdfNode';
import { floorPlanSvg } from '../../src/drawings/plan';
import { chromium } from 'playwright-core';

const [out, ...files] = process.argv.slice(2);
const g = globalThis as any;
const DPI = 150;
const work = mkdtempSync(path.join(process.env.WORK ?? tmpdir(), 'rev-'));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pages: string[] = [];
const summary: string[] = [];
let no = 0;

for (const file of files) {
  const id = path.basename(file, '.pdf');
  no++;
  g.__DBG_PLANS = true;
  g.__DBG_PAGES = [];
  g.__DBG_PLANOF = [];
  const log = console.log;
  console.log = () => {};
  let m: any;
  try {
    m = await parseSample(file);
  } catch (e) {
    console.log = log;
    console.log('ERR', id, (e as Error).message);
    continue;
  }
  console.log = log;
  const mmPerPt: number = m.report?.mmPerPt;
  const code = `No.${String(no).padStart(2, '0')}（${id}）`;
  summary.push(`${code}: ${m.floors.length} 階`);
  for (const f of m.floors) {
    const po = (g.__DBG_PLANOF ?? []).find((x: any) => x.level === f.level);
    const pts = f.walls.flatMap((w: any) => [w.a, w.b]);
    if (!pts.length || !po || !mmPerPt) continue;
    const M = 1500;
    const x0 = Math.min(...pts.map((p: any) => p.x)) - M;
    const y0 = Math.min(...pts.map((p: any) => p.y)) - M;
    const x1 = Math.max(...pts.map((p: any) => p.x)) + M;
    const y1 = Math.max(...pts.map((p: any) => p.y)) + M;
    // モデルの座標 → ページの座標（mm）→ pt → 画素
    const toPx = (v: number, s: number) => Math.round(((v - s) / mmPerPt) * (DPI / 72));
    const X = toPx(x0, po.shift.x);
    const Y = toPx(y0, po.shift.y);
    const W = toPx(x1, po.shift.x) - X;
    const H = toPx(y1, po.shift.y) - Y;
    const base = path.join(work, `${id}_${f.level}`);
    execFileSync('pdftoppm', ['-png', '-r', String(DPI), '-f', String(po.pageIndex + 1), '-l', String(po.pageIndex + 1), '-x', String(Math.max(0, X)), '-y', String(Math.max(0, Y)), '-W', String(W), '-H', String(H), '-singlefile', file, base]);
    const png = readFileSync(`${base}.png`).toString('base64');
    const svg = floorPlanSvg(m, f, { showLandscape: false, showRoad: false, showFurniture: false, showDims: true });
    const rooms = f.rooms.filter((r: any) => r.type !== 'void');
    const win = f.openings.filter((o: any) => o.kind === 'window').length;
    const door = f.openings.filter((o: any) => o.kind !== 'window').length;
    const est = f.openings.filter((o: any) => o.estimated).length;
    const items = ['壁の位置・厚み・抜け', '部屋の名前・形・帖数', '窓（位置・幅・種類）', '戸（位置・幅・開き方／引戸）', '階段（形・昇り口・段数）', '柱・造作・その他'];
    pages.push(`
<section class="pg">
  <header><b>${esc(code)}</b>　${f.level} 階　<span class="stat">読み取り: 部屋 ${rooms.length}・窓 ${win}・戸 ${door}${est ? `（うち常識で補った ${est}）` : ''}・階段 ${f.stairs.length}</span><span class="date">判定者：＿＿＿＿＿　日付：＿＿＿＿</span></header>
  <div class="pair">
    <figure><figcaption>元の図面（PDF）</figcaption><img src="data:image/png;base64,${png}"/></figure>
    <figure><figcaption>ツールの読み取り（起こした平面図）</figcaption><div class="svg">${svg}</div></figure>
  </div>
  <table><thead><tr><th>項目</th><th>○ 合っている</th><th>△ 一部違う</th><th>× 違う</th><th>違う所（例: LDK 南の窓が無い／洗面の戸が引戸）</th></tr></thead>
  <tbody>${items.map((t) => `<tr><td>${t}</td><td></td><td></td><td></td><td></td></tr>`).join('')}</tbody></table>
</section>`);
    console.log(id, f.level, 'F ok', W, 'x', H);
  }
}

const cover = `
<section class="pg cover">
  <h1>平面図の読み取り 判定シート</h1>
  <p>左が元の図面（PDF）、右が Home Landick Studio が読み取って起こした平面図です。各階の下の表に ○・△・× と違う所を書いてください。</p>
  <ul>${summary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
  <p class="note">見るポイント: 壁が抜けていないか・余計な壁が無いか／部屋の名前と帖数／窓と戸の位置・幅・種類（引戸か開き戸か）／階段の形と昇り口。<br>
  右の図の「常識で補った」建具は、元の図面で読めなかった所をツールが補ったものです。<br>社内資料（お客様の図面を含みます）。持ち出し・共有はしないでください。</p>
</section>`;

const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
@page { size: A3 landscape; margin: 10mm; }
body { font-family: 'Noto Sans JP', 'Hiragino Sans', sans-serif; margin: 0; color: #222; }
.pg { page-break-after: always; height: 277mm; display: flex; flex-direction: column; gap: 4mm; }
header { font-size: 13pt; display: flex; gap: 6mm; align-items: baseline; border-bottom: 1px solid #999; padding-bottom: 2mm; }
header .stat { font-size: 10pt; color: #555; } header .date { margin-left: auto; font-size: 10pt; }
.pair { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; min-height: 0; }
figure { margin: 0; display: flex; flex-direction: column; min-height: 0; border: 1px solid #ccc; }
figcaption { font-size: 10pt; background: #f2f2f2; padding: 1.5mm 3mm; }
figure img, .svg { flex: 1; min-height: 0; width: 100%; object-fit: contain; }
.svg { display: flex; } .svg svg { width: 100%; height: 100%; }
table { border-collapse: collapse; font-size: 9.5pt; width: 100%; }
th, td { border: 1px solid #999; padding: 1.6mm 2mm; } th { background: #f2f2f2; font-weight: 500; }
td:nth-child(2), td:nth-child(3), td:nth-child(4) { width: 18mm; } td:first-child { width: 58mm; }
.cover h1 { font-size: 22pt; margin: 20mm 0 6mm; } .cover p, .cover li { font-size: 12pt; line-height: 1.8; } .cover .note { color: #555; font-size: 11pt; }
</style></head><body>${cover}${pages.join('')}</body></html>`;

writeFileSync(path.join(work, 'sheet.html'), html);
const chromePath = globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome').sort().pop();
const browser = await chromium.launch({ executablePath: chromePath });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.pdf({ path: out, format: 'A3', landscape: true, printBackground: true });
await page.screenshot({ path: out.replace(/\.pdf$/, '_p1.png'), fullPage: false });
await browser.close();
console.log('pages', pages.length, '→', out, '(work:', work, ')');
