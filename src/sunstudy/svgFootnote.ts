/**
 * SVG（日影図）の下に脚注を足す（周辺建物の扱いの開示。disclosure.ts から使う）。
 * 依存なし（analysis.ts からも読み込める）
 */
function escXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

/** 文字の幅（全角 = 1、半角 = 0.55） */
const charUnits = (ch: string) => (ch.charCodeAt(0) <= 0xff ? 0.55 : 1);

/** 1 行が maxUnits（全角の文字数）に収まるように折り返す（・、／）の後ろ・空白で切る。切れ目が無ければ文字で切る） */
export function wrapFootnote(line: string, maxUnits: number): string[] {
  const out: string[] = [];
  let buf = '';
  let units = 0;
  for (const ch of line) {
    const u = charUnits(ch);
    // ch を足すとはみ出す: 今の行を（なるべく区切りの後ろで）切ってから足す
    if (buf && units + u > maxUnits) {
      let cut = -1;
      for (let i = buf.length - 1; i > buf.length * 0.3; i--) {
        if ('・、／）) '.includes(buf[i])) {
          cut = i + 1;
          break;
        }
      }
      if (cut < 0) cut = buf.length;
      out.push(buf.slice(0, cut).trimEnd());
      buf = buf.slice(cut).trimStart();
      units = [...buf].reduce((a, c) => a + charUnits(c), 0);
    }
    buf += ch;
    units += u;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * SVG の下に脚注を足す（viewBox の高さを伸ばし、白い帯と区切り線・文を描く）。文字の大きさは図の幅の 1/95
 * （日影図の凡例とほぼ同じ）。脚注は <g data-role="disclosure"> にまとめ、各行は data-line に元の行番号を持つ。
 * viewBox が無い・読めない SVG はそのまま返す
 */
export function appendSvgFootnote(svg: string, lines: string[]): string {
  const ls = lines.filter((t) => t.trim());
  if (!ls.length) return svg;
  const m = /<svg\b[^>]*?\bviewBox="([^"]+)"/.exec(svg);
  if (!m) return svg;
  const vb = m[1].trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || !vb.every(Number.isFinite) || !(vb[2] > 0) || !(vb[3] > 0)) return svg;
  const [x, y, w, h] = vb;
  const fs = w / 95;
  const lh = fs * 1.55;
  const maxUnits = Math.max(20, Math.floor((w - 2 * fs * 1.2) / fs) - 1);
  const rows: { text: string; line: number }[] = [];
  ls.forEach((t, i) => wrapFootnote(t, maxUnits).forEach((text) => rows.push({ text, line: i })));
  const pad = fs * 0.9;
  const add = pad * 2 + lh * rows.length;
  const top = y + h;
  const n = (v: number) => (Math.round(v * 10) / 10).toString();
  let g = `<g data-role="disclosure"><rect x="${n(x)}" y="${n(top)}" width="${n(w)}" height="${n(add)}" fill="#fff"/>`;
  g += `<line x1="${n(x + fs * 1.2)}" y1="${n(top + pad * 0.4)}" x2="${n(x + w - fs * 1.2)}" y2="${n(top + pad * 0.4)}" stroke="#bbb" stroke-width="${n(fs * 0.06)}"/>`;
  rows.forEach((r, i) => {
    g += `<text data-line="${r.line}" x="${n(x + fs * 1.2)}" y="${n(top + pad + lh * i + fs)}" font-size="${n(fs)}" fill="#333">${escXml(r.text)}</text>`;
  });
  g += '</g>';
  const vbNew = `${n(x)} ${n(y)} ${n(w)} ${n(h + add)}`;
  const head = svg.slice(0, m.index) + m[0].replace(m[1], vbNew);
  const rest = svg.slice(m.index + m[0].length);
  const close = rest.lastIndexOf('</svg>');
  if (close < 0) return svg;
  return head + rest.slice(0, close) + g + rest.slice(close);
}
