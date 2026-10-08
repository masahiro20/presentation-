/**
 * 図面シート: A3 の図枠と表題欄（工事名・図面名・縮尺・日付・設計者・図面番号）、表の描画
 * 単位は図面の mm（1/100 なら A3 = 42,000 × 29,700）
 */
export interface SheetInfo {
  /** 工事名（〇〇様邸 新築工事） */
  project: string;
  /** 図面名 */
  drawing: string;
  /** 日付 */
  date: string;
  /** 設計者・会社 */
  designer: string;
  /** 図面番号 */
  no?: string;
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
export function composeSheet(panels: Panel[], info: SheetInfo, opts: { right?: { svg: string; w: number; h: number }; defs?: string; gap?: number } = {}): string {
  const margin = 1200;
  const titleH = 2600;
  const gap = opts.gap ?? 1600;
  const rgap = opts.right ? 1000 : 0;
  const rightW = opts.right?.w ?? 0;
  const scales = [100, 150, 200, 250, 300, 400, 500];
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
    const availW = 420 * d - margin * 2 - (opts.right ? rightW + rgap : 0);
    const availH = 297 * d - margin * 2 - titleH;
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
  const sw = Math.max(16, denom * 0.18); // 線の太さ（紙の上で一定）
  const fs = denom * 1.9; // 表題の文字（紙の上で約 1.9mm）
  // 内容の配置: 図枠の中で中央寄せ（右の表がある時はその左の領域で）
  const areaW = W - margin * 2 - (opts.right ? rightW + rgap : 0);
  const areaH = H - margin * 2 - titleH;
  const ox = margin + Math.max(0, (areaW - lay.w) / 2);
  const oy = margin + Math.max(0, (areaH - lay.h) / 2);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`;
  s += opts.defs ?? '';
  s += `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`;
  // 図枠（二重線）
  s += `<rect x="${margin * 0.5}" y="${margin * 0.5}" width="${W - margin}" height="${H - margin}" fill="none" stroke="#111" stroke-width="${sw * 2}"/>`;
  s += `<rect x="${margin * 0.5 + sw * 6}" y="${margin * 0.5 + sw * 6}" width="${W - margin - sw * 12}" height="${H - margin - sw * 12}" fill="none" stroke="#111" stroke-width="${sw * 0.6}"/>`;
  for (const pl of lay.placed) s += `<g transform="translate(${ox + pl.x - pl.p.vb.x} ${oy + pl.y - pl.p.vb.y})">${pl.p.inner}</g>`;
  if (opts.right) s += `<g transform="translate(${W - margin - rightW} ${margin})">${opts.right.svg}</g>`;
  // 表題欄（下端いっぱい）
  const bx = margin * 0.5 + sw * 6;
  const by = H - margin * 0.5 - sw * 6 - titleH;
  const bw = W - margin - sw * 12;
  s += `<rect x="${bx}" y="${by}" width="${bw}" height="${titleH}" fill="#fff" stroke="#111" stroke-width="${sw * 1.2}"/>`;
  const cells: { label: string; value: string; w: number; big?: boolean }[] = [
    { label: '工事名', value: info.project, w: 0.3, big: true },
    { label: '図面名', value: info.drawing, w: 0.24, big: true },
    { label: '縮尺', value: `S = 1/${denom}（A3）`, w: 0.12 },
    { label: '日付', value: info.date, w: 0.12 },
    { label: '設計', value: info.designer, w: 0.15 },
    { label: 'No.', value: info.no ?? '', w: 0.07 },
  ];
  let x = bx;
  for (const c of cells) {
    const cw = bw * c.w;
    s += `<line x1="${x}" y1="${by}" x2="${x}" y2="${by + titleH}" stroke="#111" stroke-width="${sw * 0.8}"/>`;
    s += `<text x="${x + fs * 0.6}" y="${by + fs * 1.3}" font-size="${fs * 0.75}" fill="#666" letter-spacing="${fs * 0.08}">${esc(c.label)}</text>`;
    s += `<text x="${x + fs * 0.6}" y="${by + titleH - fs * 0.75}" font-size="${c.big ? fs * 1.25 : fs}" font-weight="${c.big ? 600 : 400}" fill="#111">${esc(c.value)}</text>`;
    x += cw;
  }
  s += `</svg>`;
  return s;
}

/** 今日の日付（YYYY.MM.DD） */
export function todayStr(d = new Date()) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}
