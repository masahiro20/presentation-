/**
 * 立面図のページ（ARCHITREND の立面図など）に書かれた高さの寸法を読む。
 *
 * 平面図には高さが無いので、床の高さ・階高・屋根勾配はこれまで標準値の推定だった。立面図が同じ PDF に入っていれば
 *   「1階ＦＬ」「2階ＦＬ」… のラベルと、その間にある「2,580（階高）」、1 階ＦＬの GL 側にある「633」（GL から 1 階床）、
 *   「9,302（最高高さ）」「8,570（最高軒高）」、勾配「10」と「0.5」の組
 * から、各階の床の高さ・階高・最高高さ・屋根勾配を読む。ページが 90° 回して描かれていても、ラベルの並ぶ向きで判断する。
 */
import type { RawText } from './pdfExtract';

export interface ElevationHeights {
  /** GL から 1 階床 (mm) */
  floor1?: number;
  /** 各階の階高 (mm)。[0] = 1 階 */
  storyHeights: number[];
  maxHeight?: number;
  maxEave?: number;
  /** 屋根勾配（寸） */
  roofPitch?: number;
}

const num = (s: string) => Number(s.replace(/[,，]/g, ''));
const z2h = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/ＦＬ/g, 'FL').replace(/（/g, '(').replace(/）/g, ')');

interface Pt {
  x: number;
  y: number;
}

/** ページの文字から立面図の高さを読む。立面図のページが無ければ null */
export function readElevationHeights(pages: { texts: RawText[] }[]): ElevationHeights | null {
  for (const page of pages) {
    const texts = page.texts.map((t) => ({ ...t, s: z2h(t.str).replace(/\s+/g, '') }));
    if (!texts.some((t) => /立面図/.test(t.s))) continue;
    // 「N階FL」ラベル: 立面図は 4 面あるので、1 階 FL ラベルごとに 1 つの図として読み、一番多く読めた図を使う
    const fl = (n: number) => texts.filter((t) => new RegExp(`^${n}階FL$`).test(t.s));
    const stories = texts.filter((t) => /^[\d,]{3,6}\(階高\)$/.test(t.s)).map((t) => ({ v: num(t.s.replace(/\(階高\)/, '')), p: { x: t.cx, y: t.cy } }));
    let best: ElevationHeights | null = null;
    for (const f1 of fl(1)) {
      // 同じ図の 2 階 FL（一番近いもの）で「上」の向きを決める
      const f2 = fl(2).sort((a, b) => dist(a, f1) - dist(b, f1))[0];
      if (!f2 || dist(f1, f2) > 400) continue;
      const o: Pt = { x: f1.cx, y: f1.cy };
      const dx = f2.cx - f1.cx;
      const dy = f2.cy - f1.cy;
      const L = Math.hypot(dx, dy);
      const u = { x: dx / L, y: dy / L };
      // 上の階の FL ラベルの位置（1 階 FL からの距離 / 1 階分の長さ）
      const levels: number[] = [0, 1];
      for (let n = 3; n <= 4; n++) {
        const fn = fl(n).map((t) => proj(t, o, u, L)).filter((q) => Math.abs(q.off) < 0.6 && q.t > levels[levels.length - 1]).sort((a, b) => a.t - b.t)[0];
        if (fn) levels.push(fn.t);
      }
      // 階高の文字: 同じ線の上（横ずれ小）にあって、i 階 FL と i+1 階 FL の間（最上階はその上）
      const along = stories.map((s) => ({ ...s, q: proj(s.p, o, u, L) })).filter((s) => Math.abs(s.q.off) < 0.6 && s.q.t > -0.2 && s.q.t < levels[levels.length - 1] + 1.6);
      const hs: number[] = [];
      for (let i = 0; i < levels.length; i++) {
        const lo = levels[i];
        const hi = levels[i + 1] ?? lo + 1.4;
        const c = along.filter((s) => s.q.t > lo - 0.15 && s.q.t < hi + 0.05).sort((a, b) => Math.abs(a.q.t - (lo + hi) / 2) - Math.abs(b.q.t - (lo + hi) / 2))[0];
        if (!c || c.v < 2000 || c.v > 4500) break;
        hs.push(c.v);
      }
      // GL から 1 階床: 1 階 FL ラベルのすぐそば（上の階と反対側か横）の 300〜1200 の数字
      const near = texts
        .filter((t) => /^\d{3,4}$/.test(t.s) && num(t.s) >= 300 && num(t.s) <= 1200)
        .map((t) => ({ v: num(t.s), q: proj({ x: t.cx, y: t.cy }, o, u, L) }))
        .filter((t) => t.q.t > -0.6 && t.q.t < 0.25 && Math.abs(t.q.off) < 0.6)
        .sort((a, b) => Math.hypot(a.q.t, a.q.off) - Math.hypot(b.q.t, b.q.off))[0];
      const r: ElevationHeights = { storyHeights: hs, floor1: near?.v };
      if (!best || hs.length > best.storyHeights.length) best = r;
    }
    if (!best) best = { storyHeights: [] };
    const tagged = (re: RegExp) => {
      const t = texts.find((x) => re.test(x.s));
      return t ? num(t.s.replace(re, '$1')) : undefined;
    };
    best.maxHeight = tagged(/^([\d,]{3,6})\(最高高さ\)$/);
    best.maxEave = tagged(/^([\d,]{3,6})\(最高軒高\)$/);
    // 勾配: 「10」の近くの小さい数（0.1 は陸屋根・バルコニーの水勾配なので除く）
    const tens = texts.filter((t) => t.s === '10');
    const votes = new Map<number, number>();
    for (const t of texts) {
      if (!/^\d+(\.\d+)?$/.test(t.s) || t.s === '10') continue;
      const v = Number(t.s);
      if (v < 0.3 || v > 12) continue;
      if (!tens.some((x) => dist(x, t) < Math.max(25, t.size * 4))) continue;
      votes.set(v, (votes.get(v) ?? 0) + 1);
    }
    const pitch = [...votes.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
    if (pitch != null) best.roofPitch = pitch;
    if (best.storyHeights.length || best.floor1 || best.maxHeight || best.roofPitch != null) return best;
  }
  return null;
}

function dist(a: { cx: number; cy: number }, b: { cx: number; cy: number }) {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy);
}

/** 1 階 FL から 2 階 FL を 1 とした座標（t）と、線からの横ずれ（off、同じ単位） */
function proj(p: Pt | { cx: number; cy: number }, o: Pt, u: Pt, L: number): { t: number; off: number } {
  const x = 'cx' in p ? p.cx : p.x;
  const y = 'cy' in p ? p.cy : p.y;
  const vx = x - o.x;
  const vy = y - o.y;
  return { t: (vx * u.x + vy * u.y) / L, off: (vx * -u.y + vy * u.x) / L };
}
