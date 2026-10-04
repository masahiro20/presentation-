/**
 * 印刷用レポート（A4 横・新しいウィンドウ・印刷ダイアログ）
 *  表紙（案件名・お客様・住所・緯度経度・作成日・会社）、建設地（地図画像・敷地・地盤高・データ出典）、
 *  季節×時刻の比較画像、地面の日照時間マップ、建物の面の日照時間、測定点の表（季節別の日照時間と時間帯）、日影図、前提・注意事項
 *
 * 画像は dataURL を埋め込むので、1 ファイルで保存・共有できる。空の項目は省く。
 * ここで作る「前提の一行」（assumptionItems）は 3D 画面のチップにも使う。
 */
import { download } from '../app/dom';
import { formatHM, keyDates } from '../sun/solar';
import { currentPlaced } from './building';
import { study, visibleNeighbors } from './state';
import { DEM_LABEL } from './terrain';
import { NEIGHBOR_SOURCE_LABEL, frameToLocal } from './types';
import type { MeasurePoint, Neighbor, NeighborSource } from './types';

// ---------------------------------------------------------------------------
// 前提（チップ・レポートで共通）
// ---------------------------------------------------------------------------

export type AssumptionKey = 'unit' | 'dims' | 'heading' | 'gl' | 'neighbors' | 'terrain' | 'time';

export interface AssumptionItem {
  key: AssumptionKey;
  text: string;
  /** 注意が必要（推定の高さを含む など） */
  warn?: boolean;
}

/** 符号付きの数値（GL ±x.xx 用） */
export function fmtSigned(v: number, digits = 2): string {
  const a = Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v;
  return `${a >= 0 ? '+' : '−'}${Math.abs(a).toFixed(digits)}`;
}

/** 標高データの短い表記（チップ用） */
export function demShort(source: string | undefined | null): string {
  switch (source) {
    case 'dem1a':
      return 'DEM1A（1m）';
    case 'dem5a':
      return 'DEM5A（5m）';
    case 'dem5b':
      return 'DEM5B（5m）';
    case 'dem5c':
      return 'DEM5C（5m）';
    case 'dem10b':
      return 'DEM10B（10m）';
    case 'flat':
      return '平地（標高なし）';
    default:
      return '未取得';
  }
}

/** 表示中の周辺建物を高さの根拠で数える */
export function neighborCounts(list: Neighbor[] = visibleNeighbors()): { total: number; measured: number; estimated: number; manual: number } {
  let measured = 0;
  let estimated = 0;
  let manual = 0;
  for (const n of list) {
    if (n.heightKind === 'measured') measured++;
    else if (n.heightKind === 'estimated') estimated++;
    else manual++;
  }
  return { total: list.length, measured, estimated, manual };
}

/** 前提の項目（単位・寸法・方位・GL・周辺建物・地形・時刻） */
export function assumptionItems(): AssumptionItem[] {
  const items: AssumptionItem[] = [];
  const p = study.placement;
  if (study.model) {
    items.push({ key: 'unit', text: `単位 ${p.unit === 'custom' ? `×${p.customScale}` : p.unit}` });
    const placed = currentPlaced();
    if (placed) {
      const d = placed.dimensions();
      items.push({ key: 'dims', text: `寸法 ${d.w.toFixed(1)}×${d.d.toFixed(1)}×${d.h.toFixed(1)} m` });
    }
    const heading = (((p.headingDeg % 360) + 360) % 360).toFixed(0);
    items.push({ key: 'heading', text: `方位 北から${heading}°` });
    items.push({ key: 'gl', text: `GL ${fmtSigned(p.baseY)} m` });
  } else {
    items.push({ key: 'dims', text: '建物なし（土地のみ）' });
  }
  const c = neighborCounts();
  items.push({
    key: 'neighbors',
    text: `周辺建物 ${c.total}棟（実測 ${c.measured}・推定 ${c.estimated}${c.estimated ? '⚠' : ''}${c.manual ? `・手入力 ${c.manual}` : ''}）`,
    warn: c.estimated > 0,
  });
  items.push({ key: 'terrain', text: `地形 ${demShort(study.grid?.source)}` });
  items.push({ key: 'time', text: '時刻 JST' });
  return items;
}

/** 前提の一行 */
export function assumptionLine(): string {
  return assumptionItems()
    .map((i) => i.text)
    .join('　／　');
}

/** 敷地面積 (m²)。局所平面での靴ひも公式。輪郭が無ければ null */
export function siteAreaM2(): number | null {
  const poly = study.sitePolygon;
  if (poly.length < 3) return null;
  const origin = study.frame ?? poly[0];
  const pts = poly.map((q) => frameToLocal(origin, q));
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.e * b.n - b.e * a.n;
  }
  return Math.abs(s) / 2;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

/** 作成日（JST） */
function todayJST(): string {
  try {
    return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
  } catch {
    const d = new Date(Date.now() + 9 * 3600000);
    return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  }
}

const KIND_TAG: Record<Neighbor['heightKind'], { cls: string; label: string }> = {
  measured: { cls: 'measured', label: '実測の高さ' },
  estimated: { cls: 'estimated', label: '高さは推定' },
  manual: { cls: 'manual', label: '手入力' },
};

/** 出典ごとの高さの根拠タグ（その出典の建物に推定が 1 つでもあれば「推定」） */
function sourceKind(src: NeighborSource, list: Neighbor[]): Neighbor['heightKind'] {
  if (src === 'manual') return 'manual';
  const own = list.filter((n) => n.source === src);
  if (!own.length) return src === 'plateau' ? 'measured' : 'estimated';
  return own.some((n) => n.heightKind === 'estimated') ? 'estimated' : 'measured';
}

function dl(rows: [string, string][]): string {
  return `<dl class="kv">${rows
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join('')}</dl>`;
}

function pointCell(pt: MeasurePoint, dateId: string, month: number, day: number): string {
  const r = pt.results?.find((x) => x.dateId === dateId) ?? pt.results?.find((x) => x.month === month && x.day === day);
  if (!r) return '<td class="muted">—</td>';
  const spans = r.spans.length ? r.spans.map(([a, b]) => `${formatHM(a)}〜${formatHM(b)}`).join('<br>') : '日は当たりません';
  return `<td><b>${r.hours.toFixed(1)}時間</b><br><span class="spans">${spans}</span></td>`;
}

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic","Meiryo","Noto Sans JP",sans-serif;color:#222;background:#eceae6;font-size:11pt;line-height:1.6}
@page{size:A4 landscape;margin:10mm}
.page{background:#fff;width:277mm;min-height:190mm;margin:8mm auto;padding:12mm 14mm;page-break-after:always;break-after:page;position:relative}
.page:last-child{page-break-after:auto;break-after:auto}
h1{font-size:26pt;margin:0 0 6mm;letter-spacing:.02em}
h2{font-size:16pt;margin:0 0 5mm;padding-bottom:2mm;border-bottom:2px solid #c9792f}
h3{font-size:12pt;margin:5mm 0 2mm}
.cover{display:flex;flex-direction:column;justify-content:center}
.cover .sub{color:#666;font-size:12pt;margin-bottom:10mm}
.cover .brand{position:absolute;top:12mm;right:14mm;color:#c9792f;font-weight:700}
.kv{display:grid;grid-template-columns:auto 1fr;gap:1.5mm 6mm;margin:0 0 4mm}
.kv dt{color:#777;white-space:nowrap}
.kv dd{margin:0}
.assume{font-size:9.5pt;color:#555;background:#f6f3ee;border-radius:3mm;padding:2mm 4mm;margin:3mm 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:5mm}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4mm}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:4mm}
figure{margin:0}
figure img{width:100%;display:block;border-radius:2mm;border:1px solid #ddd}
figcaption{font-size:9pt;color:#555;margin-top:1mm}
.map{max-height:120mm;object-fit:contain}
table{border-collapse:collapse;width:100%;font-size:9.5pt}
th,td{border:1px solid #ccc;padding:1.5mm 2.5mm;vertical-align:top;text-align:left}
th{background:#f3efe8;font-weight:600}
td.muted{color:#999}
.spans{color:#555;font-size:8.5pt}
.tag{display:inline-block;font-size:8pt;padding:0 1.5mm;border-radius:1mm;background:#e8e6e1;color:#444;margin-left:1.5mm;vertical-align:1px}
.tag.measured{background:#dcefe2;color:#24633a}
.tag.estimated{background:#fbe9d0;color:#8a5a14}
.tag.manual{background:#e3e9f4;color:#2f4f6b}
.note{font-size:9.5pt;color:#555}
.warnbox{background:#fff6e8;border:1px solid #f1d4a6;color:#8a5a14;border-radius:2mm;padding:2mm 4mm;font-size:9.5pt;margin:3mm 0}
.diagram svg{width:100%;height:auto;max-height:150mm;display:block}
ul{margin:1mm 0 3mm;padding-left:6mm}
li{margin:.5mm 0}
.toolbar{position:fixed;top:8px;right:12px;display:flex;gap:6px;z-index:9}
.toolbar button{font:inherit;font-size:10pt;padding:6px 12px;border-radius:6px;border:1px solid #999;background:#fff;cursor:pointer}
.toolbar button.primary{background:#c9792f;border-color:#c9792f;color:#fff}
.foot{position:absolute;left:14mm;right:14mm;bottom:6mm;font-size:8pt;color:#888;display:flex;justify-content:space-between}
@media print{body{background:#fff}.page{margin:0;width:auto;min-height:auto;box-shadow:none;padding:0}.toolbar{display:none}}
`;

/** レポートの HTML 文字列を作る（画像は dataURL を埋め込む） */
export function buildReportHtml(): string {
  const f = study.frame;
  const res = study.results;
  const pages: string[] = [];
  const assume = assumptionLine();
  const foot = (n: number) => `<div class="foot"><span>${esc(study.name)}　日照検討レポート</span><span>${n}</span></div>`;

  // 1) 表紙
  const coverRows: [string, string][] = [
    ['お客様', esc(study.customer)],
    ['住所', esc(f?.address ?? '—')],
    ['緯度・経度', f ? `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}` : '—'],
    ['作成日', esc(todayJST())],
    ['会社', esc(study.company)],
  ];
  pages.push(
    `<section class="page cover"><div class="brand">☀ 日照シミュレーション</div><h1>${esc(study.name)}</h1><div class="sub">日照検討レポート（3D データを実在の場所に置いて計算）</div>${dl(coverRows)}<div class="assume">前提: ${esc(assume)}</div></section>`,
  );

  // 2) 建設地
  if (f) {
    const ge = f.groundElev;
    const demSrc = study.grid?.source;
    const area = siteAreaM2();
    const list = visibleNeighbors();
    const srcs: NeighborSource[] = [...study.neighborSources];
    if (list.some((n) => n.source === 'manual') && !srcs.includes('manual')) srcs.push('manual');
    const srcHtml = srcs.length
      ? `<ul>${srcs
          .map((s) => {
            const k = KIND_TAG[sourceKind(s, list)];
            return `<li>${esc(NEIGHBOR_SOURCE_LABEL[s])}<span class="tag ${k.cls}">${k.label}</span></li>`;
          })
          .join('')}</ul>`
      : '<p class="note">周辺建物は取得していません。</p>';
    const notes = study.neighborNotes.length ? `<div class="warnbox">${study.neighborNotes.map((n) => esc(n)).join('<br>')}</div>` : '';
    const c = neighborCounts(list);
    const rows: [string, string][] = [
      ['住所', esc(f.address)],
      ['緯度・経度', `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`],
      ['地盤高', ge != null ? `T.P. ${ge.toFixed(1)} m（${esc(DEM_LABEL[demSrc ?? 'flat'] ?? demSrc ?? '')}）` : '未取得'],
      ['敷地面積', area != null ? `約 ${area.toFixed(1)} m²（約 ${(area / 3.305785).toFixed(1)} 坪）` : ''],
      ['周辺建物', `${c.total}棟（実測の高さ ${c.measured}・推定 ${c.estimated}・手入力 ${c.manual}）`],
    ];
    const left = `${dl(rows)}<h3>周辺建物の出典</h3>${srcHtml}${notes}${
      study.horizon ? `<p class="note">周囲の山・丘による日照の遮りを考慮しています（半径約 ${study.horizon.radiusKm} km の地形）。</p>` : ''
    }`;
    const right = res.mapUrl ? `<figure><img class="map" src="${res.mapUrl}" alt="地図"><figcaption>建設地（赤い線は敷地の輪郭）</figcaption></figure>` : '';
    pages.push(`<section class="page"><h2>建設地</h2><div class="grid2"><div>${left}</div><div>${right}</div></div>${foot(pages.length + 1)}</section>`);
  }

  // 3) 季節×時刻の比較
  if (res.images.length) {
    const figs = res.images.map((im) => `<figure><img src="${im.url}" alt="${esc(im.label)}"><figcaption>${esc(im.label)}（JST）</figcaption></figure>`).join('');
    const cls = res.images.length <= 4 ? 'grid2' : res.images.length <= 6 ? 'grid3' : 'grid4';
    pages.push(`<section class="page"><h2>季節×時刻の日当たり比較</h2><div class="${cls}">${figs}</div><div class="assume">${esc(assume)}</div>${foot(pages.length + 1)}</section>`);
  }

  // 4) 日照時間マップ
  if (res.heatmapUrl || res.facadeUrl) {
    const figs: string[] = [];
    if (res.heatmapUrl) figs.push(`<figure><img src="${res.heatmapUrl}" alt="地面の日照時間マップ"><figcaption>地面の日照時間マップ${res.heatmapLabel ? `：${esc(res.heatmapLabel)}` : ''}（青=短い → 赤=長い）</figcaption></figure>`);
    if (res.facadeUrl) figs.push(`<figure><img src="${res.facadeUrl}" alt="建物の面の日照時間"><figcaption>建物の面の日照時間${res.facadeLabel ? `：${esc(res.facadeLabel)}` : ''}（青=短い → 赤=長い）</figcaption></figure>`);
    pages.push(
      `<section class="page"><h2>日照時間マップ</h2><div class="${figs.length > 1 ? 'grid2' : ''}">${figs.join('')}</div><p class="note">直射日光が当たる時間の合計。地形・周辺建物・自建物の影を計算しています。${esc(assume)}</p>${foot(pages.length + 1)}</section>`,
    );
  }

  // 5) 測定点
  const analyzed = study.points.filter((p) => p.results && p.results.length);
  if (analyzed.length) {
    // 見出しの日付は、実際に解析した日付（二十四節気の年ごとの日）に合わせる
    const allRes = analyzed.flatMap((p) => p.results ?? []);
    const dates = keyDates(study.ui.year).map((d) => {
      const r = allRes.find((x) => x.dateId === d.id);
      return r ? { ...d, month: r.month, day: r.day } : d;
    });
    const head = `<tr><th>#</th><th>名前</th><th>位置（東・北・高さ m）</th>${dates.map((d) => `<th>${d.label}（${d.month}/${d.day}）</th>`).join('')}</tr>`;
    const body = study.points
      .map((p, i) => {
        const [x, y, z] = p.pos;
        return `<tr><td>${i + 1}</td><td>${esc(p.label)}</td><td class="note">E ${x.toFixed(1)}・N ${(-z).toFixed(1)}・H ${y.toFixed(1)}</td>${dates.map((d) => pointCell(p, d.id, d.month, d.day)).join('')}</tr>`;
      })
      .join('');
    pages.push(
      `<section class="page"><h2>測定点の日照時間（季節別）</h2><table>${head}${body}</table><p class="note">窓の中心などに置いた点に直射日光が当たる時間の合計と、その時間帯（JST）。時間は 1 分刻みで判定したおよその値です。</p>${foot(pages.length + 1)}</section>`,
    );
  }

  // 6) 日影図
  if (res.diagramSvg) {
    const refLabel = res.diagramRef === 'outline' ? '建物の輪郭から最大' : '敷地境界から最大';
    const summary = res.diagramSummary?.length ? `<ul>${res.diagramSummary.map((s) => `<li>${s.hour}時間日影: ${refLabel} 約${s.maxDist.toFixed(1)} m</li>`).join('')}</ul>` : '';
    pages.push(
      `<section class="page"><h2>日影図（冬至日・真太陽時）</h2><div class="grid2" style="grid-template-columns:2fr 1fr"><div class="diagram">${res.diagramSvg}</div><div>${summary}<div class="warnbox">本図は検討用であり、法規上の日影規制の判定・申請図ではありません。</div></div></div>${foot(pages.length + 1)}</section>`,
    );
  }

  // 7) 前提・注意
  const items = [
    '太陽の位置は NOAA（米国海洋大気庁）の太陽位置計算式で求めています（誤差 ±0.01° 程度）。',
    '時刻はすべて日本標準時（JST, UTC+9）です。日影図のみ建築基準法に合わせて真太陽時（その場所で太陽が真南に来る時刻を 12 時とする時刻系）で表しています。',
    '方位は真北（地図の上）を基準にしています。磁北とは数度ずれます。',
    !study.grid?.source || study.grid.source === 'flat'
      ? '地形の標高データは取得していない（または取得できなかった）ため、地形は平地（建設地のピン位置の地盤高で水平）として計算しています。周囲の高低差による影は含みません。'
      : `地形の高さは${DEM_LABEL[study.grid.source] ?? `国土地理院の標高タイル（${study.grid.source}）`}を用いています。地盤高は建設地のピン位置の値を GL±0 としています。`,
    `周辺建物は ${study.neighborSources.length ? study.neighborSources.map((s) => NEIGHBOR_SOURCE_LABEL[s]).join('、') : '自動取得していません'}。「推定」と表示した建物の高さは建物の種類などから推定した値で、実際の高さと異なることがあります。隣家の高さが分かる場合は手入力で修正してください。`,
    '建物の寸法・方位・位置・GL は上記「前提」の値を用いています。3D データの単位の設定が違うと縮尺が変わります。',
    '樹木・塀・電柱など、データに無いものの影は含みません。窓ガラスの反射や空の明るさ（天空光）は含まず、直射日光のみを計算しています。',
    '本資料は検討用であり、法規上の日影規制の判定・申請図ではありません。',
  ];
  pages.push(`<section class="page"><h2>前提・注意</h2><ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul><div class="assume">${esc(assume)}</div>${foot(pages.length + 1)}</section>`);

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(study.name)}　日照検討レポート</title><style>${CSS}</style></head><body><div class="toolbar"><button class="primary" onclick="window.print()">印刷／PDF に保存</button></div>${pages.join('')}</body></html>`;
}

/** 新しいウィンドウで開いて印刷ダイアログを出す（ポップアップが開けなければ HTML をダウンロード） */
export function openReport(): void {
  const html = buildReportHtml();
  let w: Window | null = null;
  try {
    w = window.open('', '_blank');
  } catch {
    w = null;
  }
  if (!w) {
    downloadReport();
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => {
    try {
      w!.print();
    } catch {
      /* 印刷ダイアログが出せない環境ではそのまま表示 */
    }
  }, 500);
}

/** HTML をファイルとして保存 */
export function downloadReport(): void {
  const blob = new Blob([buildReportHtml()], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  download(url, `${study.name}_日照検討レポート.html`);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
