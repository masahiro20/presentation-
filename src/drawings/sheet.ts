/**
 * 図面シート: A3 の図枠と表題欄（工事名・図面名・縮尺・日付・設計者・図面番号）、表の描画
 * 単位は図面の mm（1/100 なら A3 = 42,000 × 29,700）
 */
export interface SheetInfo {
  /** 工事名（〇〇様邸 新築工事） */
  project: string;
  /** 図面名 */
  drawing: string;
  /** 日付（YYYY.MM.DD。表題欄では和暦 R8.09.13 にする） */
  date: string;
  /** 設計者（人名。空なら表題欄の設計者欄は空欄） */
  designer: string;
  /** 図面番号 */
  no?: string;
  /** 事務所ロゴ（dataURL） */
  logo?: string;
  /** 事務所名（ロゴの右。「ホームランディック 一級建築士事務所」のように 2 行にするときは全角スペース区切り） */
  company?: string;
  /** 資格（一級建築士第〇〇号）と氏名 */
  license?: string;
  /** 担当者 */
  staff?: string;
}

/** YYYY.MM.DD → 和暦の短い表記（R8.09.13）。令和以外・読めない日付はそのまま */
export function warekiOf(date: string): string {
  const m = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/.exec(date);
  if (!m) return date;
  const y = +m[1];
  const mm = m[2].padStart(2, '0');
  const dd = m[3].padStart(2, '0');
  if (y >= 2019) return `R${y - 2018}.${mm}.${dd}`;
  if (y >= 1989) return `H${y - 1988}.${mm}.${dd}`;
  return date;
}

/**
 * 図面名の枠（御社の図面の「1階 平面図 S:1/100」）。中央 cx、上端 y。
 * 文字は字間を空け、枠は細い線。縮尺の数字に {{SCALE}} を入れると図枠に入れるときに実際の縮尺に置き換わる
 */
export function boxedTitle(cx: number, y: number, text: string, fs = 300): string {
  const w = textWidth(text, fs) + fs * 1.6;
  const h = fs * 1.7;
  return `<rect x="${(cx - w / 2).toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" fill="#fff" stroke="#111" stroke-width="${Math.max(10, fs * 0.05).toFixed(0)}"/><text x="${cx.toFixed(0)}" y="${(y + h * 0.72).toFixed(0)}" font-size="${fs}" text-anchor="middle" fill="#111" letter-spacing="${(fs * 0.22).toFixed(0)}">${esc(text)}</text>`;
}

/** 文字幅の目安（字間込み。全角 = 1 文字分、半角 = 0.6） */
function textWidth(t: string, fs: number): number {
  let w = 0;
  for (const ch of t) w += /[\x20-\x7e｡-ﾟ]/.test(ch) ? 0.6 : 1;
  return w * fs * 1.22;
}

export interface Vb {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FONT = `'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif`;

export function esc(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

/** 表（タイトル行＋見出し＋行）。戻り値は svg と高さ */
export function svgTable(x: number, y: number, title: string, cols: { label: string; w: number; align?: 'left' | 'right' | 'center' }[], rows: string[][], opts: { fontSize?: number; rowH?: number } = {}): { svg: string; h: number; w: number } {
  const fs = opts.fontSize ?? 170;
  const rh = opts.rowH ?? 300;
  const W = cols.reduce((s, c) => s + c.w, 0);
  let s = '';
  let cy = y;
  if (title) {
    s += `<text x="${x}" y="${cy + fs}" font-size="${fs * 1.15}" font-weight="600" fill="#222">${esc(title)}</text>`;
    cy += fs * 1.6;
  }
  const cell = (cx: number, cw: number, txt: string, align: 'left' | 'right' | 'center', bold = false) => {
    const ax = align === 'right' ? cx + cw - 60 : align === 'center' ? cx + cw / 2 : cx + 60;
    return `<text x="${ax}" y="${cy + rh * 0.68}" font-size="${fs}" ${bold ? 'font-weight="600"' : ''} text-anchor="${align === 'right' ? 'end' : align === 'center' ? 'middle' : 'start'}" fill="#222">${esc(txt)}</text>`;
  };
  // 見出し
  s += `<rect x="${x}" y="${cy}" width="${W}" height="${rh}" fill="#efede8" stroke="#333" stroke-width="10"/>`;
  let cx = x;
  for (const c of cols) {
    s += cell(cx, c.w, c.label, 'center', true);
    cx += c.w;
  }
  cy += rh;
  for (const r of rows) {
    s += `<rect x="${x}" y="${cy}" width="${W}" height="${rh}" fill="#fff" stroke="#333" stroke-width="10"/>`;
    cx = x;
    cols.forEach((c, i) => {
      s += cell(cx, c.w, r[i] ?? '', c.align ?? 'left');
      cx += c.w;
    });
    cy += rh;
  }
  // 縦罫線
  cx = x;
  for (const c of cols.slice(0, -1)) {
    cx += c.w;
    s += `<line x1="${cx}" y1="${y + (title ? fs * 1.6 : 0)}" x2="${cx}" y2="${cy}" stroke="#333" stroke-width="10"/>`;
  }
  return { svg: s, h: cy - y, w: W };
}

export interface Panel {
  inner: string;
  vb: Vb;
}

/** 1 枚の内容を A3 の図枠に入れる（composeSheet の 1 パネル版） */
export function wrapSheet(inner: string, vb: Vb, info: SheetInfo, opts: { right?: { svg: string; w: number; h: number }; defs?: string } = {}): string {
  return composeSheet([{ inner, vb }], info, opts);
}

/**
 * 複数の図（パネル）を A3 の図枠に流し込む（左上から右へ並べ、収まらなければ次の段）。
 * 1/100 → 1/150 → 1/200 … の順で、全体が収まる縮尺を選ぶ。右側に表などを置く場合は right に渡す。
 */
/** 御社の図枠: 余白は狭め（8mm）、表題欄は 20mm。1/100 で A3 に敷地ごと載せるための寸法（紙の mm） */
export const SHEET_MARGIN_MM = 8;
export const SHEET_TITLE_MM = 20;
/** 図枠の上に入れる帯（外部仕上表など）の幅（1/100 の図面 mm = 紙の幅から余白を引いたもの） */
export const SHEET_TOP_W = 420 * 100 - 2 * SHEET_MARGIN_MM * 100;

export function composeSheet(panels: Panel[], info: SheetInfo, opts: { right?: { svg: string; w: number; h: number }; top?: { svg: string; w: number; h: number }; defs?: string; gap?: number } = {}): string {
  // 余白・表題欄・上の帯は紙の上で一定（余白 10mm、表題欄 22mm）。1/100 の図面 mm で書き、縮尺に合わせて伸ばす
  const MARGIN = SHEET_MARGIN_MM;
  const TITLE_H = SHEET_TITLE_MM;
  const gap = opts.gap ?? 1600;
  const rgap = opts.right ? 1000 : 0;
  const rightW = opts.right?.w ?? 0;
  const scales = [100, 150, 200, 250, 300, 400, 500];
  // 上の帯（外部仕上表など）は 1/100 の幅で作ってあり、縮尺に合わせて k 倍（紙の上で同じ大きさ）
  const topH = (d: number) => (opts.top ? (opts.top.h * d) / 100 + gap * 0.6 : 0);
  type Placed = { p: Panel; x: number; y: number };
  const layout = (availW: number): { placed: Placed[]; w: number; h: number } => {
    const placed: Placed[] = [];
    let x = 0;
    let y = 0;
    let rowH = 0;
    let maxW = 0;
    for (const p of panels) {
      if (x > 0 && x + p.vb.w > availW) {
        y += rowH + gap;
        x = 0;
        rowH = 0;
      }
      placed.push({ p, x, y });
      x += p.vb.w + gap;
      rowH = Math.max(rowH, p.vb.h);
      maxW = Math.max(maxW, x - gap);
    }
    return { placed, w: maxW, h: y + rowH };
  };
  let denom = scales[scales.length - 1];
  let lay = layout(Infinity);
  for (const d of scales) {
    const margin = MARGIN * d;
    const titleH = TITLE_H * d;
    const availW = 420 * d - margin * 2 - (opts.right ? rightW + rgap : 0);
    const availH = 297 * d - margin * 2 - titleH - topH(d);
    const L = layout(availW);
    if (L.w <= availW && L.h <= availH && (opts.right?.h ?? 0) <= availH) {
      denom = d;
      lay = L;
      break;
    }
    lay = L;
  }
  const W = 420 * denom;
  const H = 297 * denom;
  const margin = MARGIN * denom;
  const titleH = TITLE_H * denom;
  const sw = Math.max(16, denom * 0.18); // 線の太さ（紙の上で一定）
  const fs = denom * 2.4; // 表題の文字（紙の上で約 2.4mm）
  // 内容の配置: 図枠の中で中央寄せ（右の表がある時はその左の領域で、上の帯がある時はその下で）
  // 御社の図面: 図と右の表（面積表・建築概要）をひとまとまりとして紙の中央に置く（図だけを左の領域の中央に置くと左に寄って小さく見える）
  const groupW = lay.w + (opts.right ? rightW + rgap : 0);
  const areaW = W - margin * 2;
  const areaH = H - margin * 2 - titleH - topH(denom);
  const ox = margin + Math.max(0, (areaW - groupW) / 2);
  const oy = margin + topH(denom) + Math.max(0, (areaH - lay.h) / 2);
  // 右の表は図の右隣、縦は図の中央に合わせる（紙からはみ出さない範囲で）
  const rx = Math.min(W - margin - rightW, ox + lay.w + rgap);
  const ry = Math.max(margin + topH(denom), Math.min(H - margin - titleH - (opts.right?.h ?? 0), oy + (lay.h - (opts.right?.h ?? 0)) / 2));
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`;
  s += opts.defs ?? '';
  s += `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`;
  // 図枠（二重線）
  s += `<rect x="${margin * 0.5}" y="${margin * 0.5}" width="${W - margin}" height="${H - margin}" fill="none" stroke="#111" stroke-width="${sw * 2}"/>`;
  s += `<rect x="${margin * 0.5 + sw * 6}" y="${margin * 0.5 + sw * 6}" width="${W - margin - sw * 12}" height="${H - margin - sw * 12}" fill="none" stroke="#111" stroke-width="${sw * 0.6}"/>`;
  for (const pl of lay.placed) s += `<g transform="translate(${ox + pl.x - pl.p.vb.x} ${oy + pl.y - pl.p.vb.y})">${pl.p.inner.replace(/\{\{SCALE\}\}/g, String(denom))}</g>`;
  if (opts.right) s += `<g transform="translate(${rx.toFixed(0)} ${ry.toFixed(0)})">${opts.right.svg}</g>`;
  if (opts.top) {
    const k = (W - margin * 2) / opts.top.w;
    s += `<g transform="translate(${margin} ${margin}) scale(${k.toFixed(4)})">${opts.top.svg}</g>`;
  }
  // 表題欄（下端いっぱい）
  const bx = margin * 0.5 + sw * 6;
  const by = H - margin * 0.5 - sw * 6 - titleH;
  const bw = W - margin - sw * 12;
  s += `<rect x="${bx}" y="${by}" width="${bw}" height="${titleH}" fill="#fff" stroke="#111" stroke-width="${sw * 1.2}"/>`;
  // 御社の表題欄: 工事名／図面名 ｜ 縮尺／日付 ｜ 図面更新日 ｜ 設計者 ｜ 担当者 ｜ ロゴ＋事務所名＋資格・氏名 ｜ 図面NO
  const col = [0.235, 0.06, 0.29, 0.045, 0.045, 0.265, 0.06];
  const xs = [bx];
  for (const c of col) xs.push(xs[xs.length - 1] + bw * c);
  const midY = by + titleH / 2;
  const lab = (x: number, y: number, t: string) => `<text x="${(x + fs * 0.35).toFixed(0)}" y="${(y + fs * 0.95).toFixed(0)}" font-size="${(fs * 0.62).toFixed(0)}" fill="#111">${esc(t)}</text>`;
  const vline = (x: number) => `<line x1="${x.toFixed(0)}" y1="${by}" x2="${x.toFixed(0)}" y2="${by + titleH}" stroke="#111" stroke-width="${sw * 0.8}"/>`;
  const hline = (x0: number, x1: number, y: number, dash = false) => `<line x1="${x0.toFixed(0)}" y1="${y.toFixed(0)}" x2="${x1.toFixed(0)}" y2="${y.toFixed(0)}" stroke="#111" stroke-width="${sw * 0.6}"${dash ? ' stroke-dasharray="40 40"' : ''}/>`;
  for (const x of xs.slice(1, -1)) s += vline(x);
  // 工事名（上）／図面名（下）: 字間を空けた見出し文字
  s += hline(xs[0], xs[1], midY);
  s += lab(xs[0], by, '工事名') + lab(xs[0], midY, '図面名');
  s += `<text x="${((xs[0] + xs[1]) / 2).toFixed(0)}" y="${(by + titleH * 0.36).toFixed(0)}" font-size="${(fs * 1.25).toFixed(0)}" text-anchor="middle" fill="#111" letter-spacing="${(fs * 0.3).toFixed(0)}">${esc(info.project)}</text>`;
  s += `<text x="${((xs[0] + xs[1]) / 2).toFixed(0)}" y="${(by + titleH * 0.86).toFixed(0)}" font-size="${(fs * 1.15).toFixed(0)}" text-anchor="middle" fill="#111" letter-spacing="${(fs * 0.3).toFixed(0)}">${esc(info.drawing)}</text>`;
  // 縮尺（上）／日付（下）
  s += hline(xs[1], xs[2], midY);
  s += lab(xs[1], by, '縮尺') + lab(xs[1], midY, '日付');
  s += `<text x="${((xs[1] + xs[2]) / 2).toFixed(0)}" y="${(by + titleH * 0.4).toFixed(0)}" font-size="${(fs * 1.05).toFixed(0)}" text-anchor="middle" fill="#111">1/${denom}</text>`;
  s += `<text x="${((xs[1] + xs[2]) / 2).toFixed(0)}" y="${(by + titleH * 0.9).toFixed(0)}" font-size="${(fs * 1.0).toFixed(0)}" text-anchor="middle" fill="#111">${esc(warekiOf(info.date))}</text>`;
  // 図面更新日（点線の記入欄）
  s += lab(xs[2], by, '図面更新日');
  for (let k = 1; k <= 4; k++) s += hline(xs[2] + fs * 0.3, xs[3] - fs * 0.3, by + (titleH * k) / 5, true);
  // 設計者・担当者
  s += lab(xs[3], by, '設計者') + lab(xs[4], by, '担当者');
  if (info.designer) s += `<text x="${((xs[3] + xs[4]) / 2).toFixed(0)}" y="${(by + titleH * 0.7).toFixed(0)}" font-size="${(fs * 0.9).toFixed(0)}" text-anchor="middle" fill="#111">${esc(info.designer)}</text>`;
  if (info.staff) s += `<text x="${((xs[4] + xs[5]) / 2).toFixed(0)}" y="${(by + titleH * 0.7).toFixed(0)}" font-size="${(fs * 0.9).toFixed(0)}" text-anchor="middle" fill="#111">${esc(info.staff)}</text>`;
  // 事務所: ロゴ、事務所名（2 行）、資格・氏名
  {
    const x0 = xs[5];
    const cw = xs[6] - xs[5];
    const logoW = info.logo ? titleH * 0.72 : 0;
    if (info.logo) s += `<image href="${info.logo}" x="${(x0 + fs * 0.8).toFixed(0)}" y="${(by + titleH * 0.14).toFixed(0)}" width="${logoW.toFixed(0)}" height="${(titleH * 0.72).toFixed(0)}" preserveAspectRatio="xMidYMid meet"/>`;
    const name = (info.company ?? info.designer ?? '').trim();
    const [l1, l2] = name.includes('　') ? name.split('　', 2) : name.includes(' ') ? name.split(' ', 2) : /一級建築士事務所$/.test(name) ? [name.replace(/一級建築士事務所$/, ''), '一級建築士事務所'] : [name, ''];
    const nx = x0 + fs * 0.8 + logoW + fs * 0.8;
    if (l1) s += `<text x="${nx.toFixed(0)}" y="${(by + titleH * 0.44).toFixed(0)}" font-size="${(fs * 1.45).toFixed(0)}" fill="#111" letter-spacing="${(fs * 0.12).toFixed(0)}">${esc(l1)}</text>`;
    if (l2) s += `<text x="${nx.toFixed(0)}" y="${(by + titleH * 0.84).toFixed(0)}" font-size="${(fs * 1.2).toFixed(0)}" fill="#111" letter-spacing="${(fs * 0.42).toFixed(0)}">${esc(l2)}</text>`;
    if (info.license) {
      const parts = info.license.split(/[　 ]+/).filter(Boolean);
      const lx = x0 + cw - fs * 0.8;
      s += `<text x="${lx.toFixed(0)}" y="${(by + titleH * 0.42).toFixed(0)}" font-size="${(fs * 0.85).toFixed(0)}" text-anchor="end" fill="#111">${esc(parts[0] ?? '')}</text>`;
      if (parts.length > 1) s += `<text x="${(lx - fs * 0.6).toFixed(0)}" y="${(by + titleH * 0.84).toFixed(0)}" font-size="${(fs * 1.05).toFixed(0)}" text-anchor="end" fill="#111" letter-spacing="${(fs * 0.35).toFixed(0)}">${esc(parts.slice(1).join('　'))}</text>`;
    }
  }
  // 図面NO
  s += lab(xs[6], by, '図面NO');
  if (info.no) s += `<text x="${((xs[6] + xs[7]) / 2).toFixed(0)}" y="${(by + titleH * 0.74).toFixed(0)}" font-size="${(fs * 1.5).toFixed(0)}" text-anchor="middle" fill="#111">${esc(info.no)}</text>`;
  s += `</svg>`;
  return s;
}

/** 今日の日付（YYYY.MM.DD） */
export function todayStr(d = new Date()) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}
