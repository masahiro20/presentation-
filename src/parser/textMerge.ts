/**
 * CAD の PDF では文字が1文字ずつ（または数文字ずつ）配置されていることが多い。
 * 同じ行に並ぶ断片・縦書きで積まれた1文字を、1つの語にまとめる。
 */
import type { RawText } from './pdfExtract';

const CJK = /^[぀-ヿ㐀-鿿ｦ-ﾟ々ー・（）()]$/;

function sameDir(a: RawText, b: RawText) {
  let d = Math.abs(a.angle - b.angle) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d < 0.09;
}

/** 横方向（文字の進行方向）の連結 */
function mergeRuns(texts: RawText[]): RawText[] {
  const items = texts.map((t) => ({ ...t }));
  const used = new Uint8Array(items.length);
  const out: RawText[] = [];
  // 進行方向の座標でソート
  const proj = (t: RawText) => t.cx * Math.cos(t.angle) + t.cy * Math.sin(t.angle);
  const order = items.map((_, i) => i).sort((i, j) => proj(items[i]) - proj(items[j]));
  for (const i of order) {
    if (used[i]) continue;
    used[i] = 1;
    let cur = items[i];
    for (;;) {
      const ux = Math.cos(cur.angle);
      const uy = Math.sin(cur.angle);
      const endX = cur.cx + (ux * cur.width) / 2;
      const endY = cur.cy + (uy * cur.width) / 2;
      let best = -1;
      let bestGap = Infinity;
      for (const j of order) {
        if (used[j]) continue;
        const t = items[j];
        if (!sameDir(cur, t)) continue;
        const r = t.size / cur.size;
        if (r < 0.8 || r > 1.25) continue;
        const sx = t.cx - (ux * t.width) / 2;
        const sy = t.cy - (uy * t.width) / 2;
        // 進行方向の隙間と、行のずれ
        const gap = (sx - endX) * ux + (sy - endY) * uy;
        const off = Math.abs(-(t.cy - cur.cy) * ux + (t.cx - cur.cx) * uy);
        if (off > cur.size * 0.3) continue;
        if (gap < -cur.size * 0.3 || gap > cur.size * 0.45) continue;
        if (gap < bestGap) {
          bestGap = gap;
          best = j;
        }
      }
      if (best < 0) break;
      used[best] = 1;
      const t = items[best];
      const sx = cur.cx - (ux * cur.width) / 2;
      const sy = cur.cy - (uy * cur.width) / 2;
      const ex = t.cx + (ux * t.width) / 2;
      const ey = t.cy + (uy * t.width) / 2;
      const width = (ex - sx) * ux + (ey - sy) * uy;
      cur = { str: cur.str + (bestGap > cur.size * 0.25 && /[A-Za-z0-9]$/.test(cur.str) && /^[A-Za-z0-9]/.test(t.str) ? ' ' : '') + t.str, cx: (sx + ex) / 2, cy: (sy + ey) / 2, size: Math.max(cur.size, t.size), width, angle: cur.angle };
    }
    out.push(cur);
  }
  return out;
}

/** 縦書き（1文字ずつ上から下へ積まれた日本語）の連結 */
function mergeVertical(texts: RawText[]): RawText[] {
  const single = (t: RawText) => [...t.str].length === 1 && CJK.test(t.str) && Math.abs(t.angle) < 0.09;
  const items = texts.slice();
  const used = new Uint8Array(items.length);
  const out: RawText[] = [];
  const order = items.map((_, i) => i).sort((i, j) => items[i].cy - items[j].cy);
  for (const i of order) {
    if (used[i]) continue;
    used[i] = 1;
    const t0 = items[i];
    if (!single(t0)) {
      out.push(t0);
      continue;
    }
    const col = [t0];
    let last = t0;
    for (;;) {
      let best = -1;
      let bestDy = Infinity;
      for (const j of order) {
        if (used[j]) continue;
        const t = items[j];
        if (!single(t)) continue;
        const r = t.size / last.size;
        if (r < 0.8 || r > 1.25) continue;
        if (Math.abs(t.cx - last.cx) > last.size * 0.3) continue;
        const dy = t.cy - last.cy;
        if (dy < last.size * 0.7 || dy > last.size * 1.5) continue;
        if (dy < bestDy) {
          bestDy = dy;
          best = j;
        }
      }
      if (best < 0) break;
      used[best] = 1;
      last = items[best];
      col.push(last);
    }
    if (col.length === 1) {
      out.push(t0);
      continue;
    }
    const top = col[0].cy - col[0].size / 2;
    const bot = last.cy + last.size / 2;
    // 縦書きの語は「上から下」を1語として扱う（向きは縦）
    out.push({ str: col.map((c) => c.str).join(''), cx: col.reduce((s, c) => s + c.cx, 0) / col.length, cy: (top + bot) / 2, size: col[0].size, width: bot - top, angle: Math.PI / 2 });
  }
  return out;
}

export function mergeTextFragments(texts: RawText[]): RawText[] {
  if (texts.length < 2 || texts.length > 20000) return texts;
  return mergeVertical(mergeRuns(texts));
}
