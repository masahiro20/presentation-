/**
 * 立面図のページの「外部仕上表」を読む（屋根・破風・外壁・軒天・樋・玄関ドア・外部建具…の欄ごとの材料と色）。
 *
 * 御社の立面図（ARCHITREND）は上の帯に外部仕上表があり、欄の名前（「屋 根」「外壁」「③」…）の右に、材料・品番・色が数行で書かれている。
 * 欄の名前を見つけ、同じ列の次の欄の名前までの行の帯と、右隣の列の手前までを 1 つの欄として、中の文字をつなぐ。
 * 読んだ欄はコーディネート（coordinate/fromFinishTable）で屋根・外壁・サッシ・玄関ドアの商品と品番メモに当てる。
 */
import type { PageVectors, RawText } from './pdfExtract';

export interface FinishRow {
  /** 欄の名前（「屋根」「外壁③」「玄関ドア」） */
  part: string;
  /** 欄の中の文字をつないだもの（「カラーガルバリウム鋼板 t0.35 立平葺 色：コゲチャ」） */
  text: string;
  /** 「色：〇〇」の色の名前（あれば） */
  color?: string;
  pageIndex: number;
}

const norm = (s: string) =>
  s
    .replace(/[\s　]+/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** 欄の名前 */
const PART = /^(屋根|破風(・?鼻隠し?)?|鼻隠し?|外壁(下地)?[①-⑨]?|軒天|軒裏|軒樋|縦樋|竪樋|雨樋|玄関ドア|外建具|外部建具|サッシ|バルコニー|ポーチ|基礎|基礎巾木|土台水切|笠木|庇|シャッター|断熱材|通気金物|その他)$/;
const CIRCLED = /^[①-⑨]$/;

export function readExteriorFinishTable(pages: PageVectors[]): FinishRow[] {
  for (const page of pages) {
    const texts = page.texts.filter((t) => Math.abs(t.angle) < 0.1);
    // 外部仕上表の見出し（「外部仕上表」、または 1 文字ずつ縦に並んだ「外」「部」「仕」「上」「表」）
    const hasTitle = texts.some((t) => /外部仕上(げ)?表/.test(norm(t.str))) || ['外', '部', '仕', '上', '表'].every((c) => texts.some((t) => norm(t.str) === c));
    if (!hasTitle) continue;
    // 欄の名前（ページの上 40% の中）。「外壁」のすぐ下の「③」はつなぐ
    const labels: { t: RawText; part: string }[] = [];
    for (const t of texts) {
      if (t.cy > page.height * 0.4) continue;
      const s = norm(t.str);
      if (!PART.test(s)) continue;
      const num = texts.find((u) => CIRCLED.test(norm(u.str)) && Math.abs(u.cx - t.cx) < t.size * 1.5 && u.cy > t.cy && u.cy - t.cy < t.size * 2);
      labels.push({ t, part: num && /^外壁/.test(s) && !/[①-⑨]$/.test(s) ? s + norm(num.str) : s });
    }
    if (labels.length < 3) continue;
    // 列（欄の名前の x がそろうもの）
    const cols: { x: number; items: typeof labels }[] = [];
    for (const l of [...labels].sort((a, b) => a.t.cx - b.t.cx)) {
      const c = cols.find((k) => Math.abs(k.x - l.t.cx) < 25);
      if (c) c.items.push(l);
      else cols.push({ x: l.t.cx, items: [l] });
    }
    cols.sort((a, b) => a.x - b.x);
    const used = new Set<RawText>([...labels.map((l) => l.t)]);
    for (const t of texts) if (CIRCLED.test(norm(t.str)) || /^[外部仕上表]$/.test(norm(t.str))) used.add(t);
    const rows: FinishRow[] = [];
    cols.forEach((col, ci) => {
      const items = [...col.items].sort((a, b) => a.t.cy - b.t.cy);
      const xMax = ci + 1 < cols.length ? cols[ci + 1].x - cols[ci + 1].items[0].t.width / 2 - 2 : page.width;
      items.forEach((l, i) => {
        const prevY = i > 0 ? (items[i - 1].t.cy + l.t.cy) / 2 : l.t.cy - 30;
        const nextY = i + 1 < items.length ? (l.t.cy + items[i + 1].t.cy) / 2 : l.t.cy + 30;
        const x0 = l.t.cx + l.t.width / 2;
        const inCell = texts.filter((t) => !used.has(t) && t.cx > x0 && t.cx < xMax && t.cy > prevY && t.cy <= nextY);
        if (!inCell.length) return;
        // 行（y）ごとに左から
        inCell.sort((a, b) => (Math.abs(a.cy - b.cy) < 2 ? a.cx - b.cx : a.cy - b.cy));
        const text = inCell
          .map((t) => t.str.trim())
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        // 「色：外 シャイングレー」の「外」は外側の色の意味。「色：外観色合わせ」はそのまま。「〇〇〇〇」「□□」は未定
        const m = text.match(/色[:：]\s*(?:外\s+|外(?=[ァ-ヶ]))?([^\s（(、,]+)/);
        const color = m && !/[〇○□]/.test(m[1]) ? m[1] : undefined;
        rows.push({ part: l.part, text, ...(color ? { color } : {}), pageIndex: page.pageIndex });
      });
    });
    if (rows.length) return rows;
  }
  return [];
}
