/**
 * 立面図から窓の高さ（腰高・高さ）を読み、平面図の窓に当てる。
 *
 * 平面図には窓の高さが無いので、腰高・高さはこれまで部屋と幅からの推定（腰窓 900 など）だった。
 * 立面図（東西南北の 4 面）が同じ PDF か別ファイルにあれば:
 *   1. 「南 側」「立 面 図」の見出しで 4 面を切り分ける（見出しは図の下）
 *   2. 地盤面（GL）の長い横線と、GL から立ち上がる壁の外形の左右の端を見つける
 *   3. 窓を拾う: 枠の二重線（外枠の内側に障子・ガラスの線）、引違いの障子が並ぶ四角。
 *      外壁の面（窓を大きく囲む線）・屋根の端の飾りの並び（同じ四角が 5 つ以上続く）は除く
 *   4. 平面図の同じ面を向く外壁の窓と、横の位置（建物の端からの距離）を合わせて対応させ、
 *      GL からの高さ − その階の床の高さ = 腰高、上端 − 下端 = 高さ を当てる
 *   5. 立面図にあって平面図に無い窓（読み落とし）は、向きと位置が確かに合っている面だけ外壁に足す
 *
 * 見る向き: 南側立面図は北を向いて南の面を見るので、左が西・右が東（平面図と同じ左右）。北側は左右が逆。
 * 東側は左が南・右が北、西側は左が北・右が南。図面上の北（上）と真北がずれていても、いちばん近い面に当てる。
 */
import type { PageVectors, RawSegment, RawText } from './pdfExtract';
import type { Floor, Opening, Vec2, WindowStyle } from '../core/types';
import type { ElevationHeights } from './elevationText';

export type Facing = 'S' | 'N' | 'E' | 'W';
export const FACING_JA: Record<Facing, string> = { S: '南', N: '北', E: '東', W: '西' };

/** 立面図の窓 1 つ（引違いの障子・連窓はまとめて 1 つ） */
export interface ElevWindow {
  /** 外形の左端からの距離 (mm)。立面図を見た向きで左 → 右 */
  u0: number;
  u1: number;
  /** GL からの高さ (mm) */
  z0: number;
  z1: number;
  /** まとめた四角（障子・ガラス）の数 */
  panes: number;
}

export interface ElevationView {
  facing: Facing;
  pageIndex: number;
  mmPerPt: number;
  /** 外形の幅 (mm) */
  width: number;
  windows: ElevWindow[];
  /** 縮尺を立面図の「1階FL」「2階FL」の間隔と階高の数字から求めた（平面図の縮尺を借りていない） */
  scaleFromLabels: boolean;
  /** 確かめ用（ページの pt）: GL の線の y、外形の左右 */
  glY: number;
  bx0: number;
  bx1: number;
}

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const z2h = (s: string) =>
  s
    .replace(/[\s　]+/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

const DIR: Record<string, Facing> = { 南: 'S', 北: 'N', 東: 'E', 西: 'W', SOUTH: 'S', NORTH: 'N', EAST: 'E', WEST: 'W' };

export interface ElevationTitle {
  facing: Facing;
  cx: number;
  cy: number;
  size: number;
}

/** 「南 側」「立 面 図」（分かれた文字）・「南側立面図」・「SOUTH ELEVATION」の見出し */
export function findElevationTitles(texts: RawText[]): ElevationTitle[] {
  const out: ElevationTitle[] = [];
  for (const t of texts) {
    if (Math.abs(t.angle) > 0.1) continue;
    const s = z2h(t.str);
    let m = s.match(/^(東|西|南|北)(側|面)?立面図?/);
    if (m) {
      out.push({ facing: DIR[m[1]], cx: t.cx, cy: t.cy, size: t.size });
      continue;
    }
    m = s.toUpperCase().match(/^(SOUTH|NORTH|EAST|WEST)(SIDE)?ELEVATION/);
    if (m) {
      out.push({ facing: DIR[m[1]], cx: t.cx, cy: t.cy, size: t.size });
      continue;
    }
    m = s.match(/^(東|西|南|北)(側|面)?$/);
    if (!m) continue;
    const right = t.cx + t.width / 2;
    const r = texts.find((u) => u !== t && /^立面図?$/.test(z2h(u.str).replace(/S:?1\/\d+$/i, '')) && Math.abs(u.cy - t.cy) < t.size * 0.6 && u.cx > t.cx && u.cx - u.width / 2 - right < t.size * 3);
    if (r) out.push({ facing: DIR[m[1]], cx: (t.cx - t.width / 2 + r.cx + r.width / 2) / 2, cy: t.cy, size: t.size });
  }
  // 同じ向きが重なったら大きい文字を残す（図面リストの小さい文字など）
  const best = new Map<Facing, ElevationTitle>();
  for (const t of out) {
    const b = best.get(t.facing);
    if (!b || t.size > b.size) best.set(t.facing, t);
  }
  return [...best.values()];
}

/** 見出しごとの図の範囲: 同じ段の隣の見出しとの中間まで、上の段の見出しの下から自分の見出しの上まで */
function regionsOf(titles: ElevationTitle[], page: { width: number; height: number }): Map<ElevationTitle, Box> {
  const rows: ElevationTitle[][] = [];
  for (const t of [...titles].sort((a, b) => a.cy - b.cy)) {
    const row = rows.find((r) => Math.abs(r[0].cy - t.cy) < 60);
    if (row) row.push(t);
    else rows.push([t]);
  }
  const out = new Map<ElevationTitle, Box>();
  rows.forEach((row, ri) => {
    row.sort((a, b) => a.cx - b.cx);
    const above = ri > 0 ? Math.max(...rows[ri - 1].map((t) => t.cy + t.size)) : 0;
    row.forEach((t, i) => {
      const x0 = i > 0 ? (row[i - 1].cx + t.cx) / 2 : 0;
      const x1 = i + 1 < row.length ? (t.cx + row[i + 1].cx) / 2 : page.width;
      out.set(t, { x0, x1, y0: above, y1: t.cy - t.size * 0.7 });
    });
  });
  return out;
}

const isH = (s: RawSegment) => Math.abs(s.a.y - s.b.y) < 0.25 && Math.abs(s.a.x - s.b.x) > 0.5;
const isV = (s: RawSegment) => Math.abs(s.a.x - s.b.x) < 0.25 && Math.abs(s.a.y - s.b.y) > 0.5;
/** 寸法線などの薄い色（灰色）の線 */
const isGray = (c: string) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (!m) return false;
  const v = [m[1], m[2], m[3]].map((x) => parseInt(x, 16));
  return Math.min(...v) >= 0x70 && Math.max(...v) - Math.min(...v) < 0x30;
};

/** 同じ y に並ぶ横線をまとめた「線」（GL の線が壁で切れていても 1 本に） */
function longHorizontals(segs: RawSegment[], box: Box): { y: number; x0: number; x1: number; len: number }[] {
  const hs = segs
    .filter((s) => isH(s) && !s.dashed)
    .map((s) => ({ y: (s.a.y + s.b.y) / 2, x0: Math.min(s.a.x, s.b.x), x1: Math.max(s.a.x, s.b.x) }))
    .filter((s) => s.x1 > box.x0 && s.x0 < box.x1 && s.y > box.y0 && s.y < box.y1)
    .sort((a, b) => a.y - b.y);
  const out: { y: number; x0: number; x1: number; len: number }[] = [];
  for (const s of hs) {
    const g = out.find((o) => Math.abs(o.y - s.y) < 0.35);
    if (g) {
      g.x0 = Math.min(g.x0, s.x0);
      g.x1 = Math.max(g.x1, s.x1);
      g.len += s.x1 - s.x0;
    } else out.push({ y: s.y, x0: s.x0, x1: s.x1, len: s.x1 - s.x0 });
  }
  return out;
}

/**
 * 区間 [a0,a1] を横線（または縦線）の集まりがどれだけ覆うか (0..1)。
 * 両端（角）が覆われていなければ 0（隣の窓の辺を借りた「窓 2 つにまたがる四角」を作らない）
 */
function coverage(spans: { lo: number; hi: number }[], a0: number, a1: number): number {
  const L = a1 - a0;
  if (L <= 0) return 0;
  const end = Math.min(0.8, L * 0.1);
  if (!spans.some((s) => s.lo <= a0 + 0.3 && s.hi >= a0 + end) || !spans.some((s) => s.hi >= a1 - 0.3 && s.lo <= a1 - end)) return 0;
  const parts = spans
    .map((s) => [Math.max(a0, s.lo), Math.min(a1, s.hi)] as const)
    .filter(([lo, hi]) => hi > lo)
    .sort((p, q) => p[0] - q[0]);
  let cov = 0;
  let cur = a0;
  for (const [lo, hi] of parts) {
    if (hi <= cur) continue;
    cov += hi - Math.max(lo, cur);
    cur = hi;
  }
  return cov / L;
}

/** 1 本の線で区間 [a0,a1] をどれだけ覆うか（CAD の四角は閉じた折れ線なので、辺は 1 本の線） */
function single(spans: { lo: number; hi: number }[], a0: number, a1: number): number {
  let best = 0;
  for (const s of spans) best = Math.max(best, Math.min(a1, s.hi) - Math.max(a0, s.lo));
  return best / Math.max(1e-6, a1 - a0);
}

/**
 * 区画の中の四角（向かい合う横線の組＋両端の縦線、または向かい合う縦線の組＋上下の横線）。
 * 4 辺とも 1 本の線でほぼ覆われているものだけ（隣り合う窓・方立ての辺をつないだ「またがる四角」を作らない）
 */
export function findRects(segs: RawSegment[], minSide: number, ext = Infinity): Box[] {
  const H = segs.filter((s) => isH(s) && !s.dashed).map((s) => ({ y: (s.a.y + s.b.y) / 2, lo: Math.min(s.a.x, s.b.x), hi: Math.max(s.a.x, s.b.x) }));
  const V = segs.filter((s) => isV(s) && !s.dashed).map((s) => ({ x: (s.a.x + s.b.x) / 2, lo: Math.min(s.a.y, s.b.y), hi: Math.max(s.a.y, s.b.y) }));
  const tol = 0.6;
  const hAt = (y: number) => H.filter((h) => Math.abs(h.y - y) < tol);
  const vAt = (x: number) => V.filter((v) => Math.abs(v.x - x) < tol);
  const out: Box[] = [];
  /** 辺を覆ういちばん長い線が、角の先まで伸びているか（外壁の目地・壁の線が交わってできた四角は窓ではない） */
  const over = (spans: { lo: number; hi: number }[], a0: number, a1: number) => {
    let best: { lo: number; hi: number } | null = null;
    let bc = 0;
    for (const sp of spans) {
      const c = Math.min(a1, sp.hi) - Math.max(a0, sp.lo);
      if (c > bc) {
        bc = c;
        best = sp;
      }
    }
    return !!best && (a0 - best.lo > ext || best.hi - a1 > ext);
  };
  const crossing = (b: Box) => [over(vAt(b.x0), b.y0, b.y1), over(vAt(b.x1), b.y0, b.y1), over(hAt(b.y0), b.x0, b.x1), over(hAt(b.y1), b.x0, b.x1)].filter(Boolean).length >= 2;
  const push = (b: Box) => {
    if (crossing(b)) return;
    if (b.x1 - b.x0 < minSide || b.y1 - b.y0 < minSide) return;
    if (out.some((o) => Math.abs(o.x0 - b.x0) < 0.4 && Math.abs(o.x1 - b.x1) < 0.4 && Math.abs(o.y0 - b.y0) < 0.4 && Math.abs(o.y1 - b.y1) < 0.4)) return;
    out.push(b);
  };
  const Hs = H.filter((h) => h.hi - h.lo >= minSide);
  for (let i = 0; i < Hs.length; i++)
    for (let j = 0; j < Hs.length; j++) {
      const a = Hs[i];
      const b = Hs[j];
      if (b.y <= a.y + minSide * 0.5) continue;
      if (Math.abs(a.lo - b.lo) > tol || Math.abs(a.hi - b.hi) > tol) continue;
      const x0 = (a.lo + b.lo) / 2;
      const x1 = (a.hi + b.hi) / 2;
      if (coverage(vAt(x0), a.y, b.y) < 0.96 || coverage(vAt(x1), a.y, b.y) < 0.96) continue;
      if (single(vAt(x0), a.y, b.y) < 0.93 || single(vAt(x1), a.y, b.y) < 0.93) continue;
      push({ x0, x1, y0: a.y, y1: b.y });
    }
  const Vs = V.filter((v) => v.hi - v.lo >= minSide);
  for (let i = 0; i < Vs.length; i++)
    for (let j = 0; j < Vs.length; j++) {
      const a = Vs[i];
      const b = Vs[j];
      if (b.x <= a.x + minSide * 0.5) continue;
      if (Math.abs(a.lo - b.lo) > tol || Math.abs(a.hi - b.hi) > tol) continue;
      const y0 = (a.lo + b.lo) / 2;
      const y1 = (a.hi + b.hi) / 2;
      if (coverage(hAt(y0), a.x, b.x) < 0.96 || coverage(hAt(y1), a.x, b.x) < 0.96) continue;
      if (single(hAt(y0), a.x, b.x) < 0.93 || single(hAt(y1), a.x, b.x) < 0.93) continue;
      push({ x0: a.x, x1: b.x, y0, y1 });
    }
  return out;
}

/** 四角の集まりから窓（外枠）を選ぶ。mm = 1pt あたりの mm */
export function windowUnits(rects: Box[], mm: number): (Box & { panes: number })[] {
  // 同じ大きさの四角が 5 つ以上ほぼ隙間なく並ぶもの（屋根の端の飾り・外壁の目地・シャッターのスラット）は窓ではない
  const key = (b: Box) => `${Math.round((b.x1 - b.x0) * 2)}:${Math.round((b.y1 - b.y0) * 2)}`;
  const groups = new Map<string, Box[]>();
  for (const r of rects) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  const pattern = new Set<Box>();
  for (const g of groups.values()) {
    if (g.length < 5) continue;
    const row = [...g].sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0);
    let run: Box[] = [row[0]];
    const flush = () => {
      if (run.length >= 5) for (const r of run) pattern.add(r);
    };
    for (let i = 1; i < row.length; i++) {
      const p = run[run.length - 1];
      const q = row[i];
      const gap = Math.max(q.x0 - p.x1, q.y0 - p.y1);
      if (gap * mm < 150 && (Math.abs(q.y0 - p.y0) < 0.6 || Math.abs(q.x0 - p.x0) < 0.6)) run.push(q);
      else {
        flush();
        run = [q];
      }
    }
    flush();
  }
  let list = rects.filter((r) => !pattern.has(r)).map((r) => ({ ...r, panes: 1, framed: false }));
  const dbg = (globalThis as { __ELEV_DBG?: unknown[] }).__ELEV_DBG;
  if (dbg) dbg.push({ rects: list.map((r) => ({ ...r })) });
  const inside = (a: Box, b: Box) => b.x0 >= a.x0 - 0.3 && b.x1 <= a.x1 + 0.3 && b.y0 >= a.y0 - 0.3 && b.y1 <= a.y1 + 0.3;
  const maxMargin = (a: Box, b: Box) => Math.max(b.x0 - a.x0, a.x1 - b.x1, b.y0 - a.y0, a.y1 - b.y1) * mm;
  const area = (b: Box) => (b.x1 - b.x0) * (b.y1 - b.y0);
  // 枠の内側の線（障子・ガラス）: 外枠から 220mm 以内に収まる四角は外枠の一部
  list.sort((a, b) => area(b) - area(a));
  const inner = new Set<object>();
  for (const a of list) {
    if (inner.has(a)) continue;
    for (const b of list) {
      if (b === a || inner.has(b) || !inside(a, b) || area(b) >= area(a)) continue;
      if (maxMargin(a, b) <= 220) {
        inner.add(b);
        a.framed = true;
      }
    }
  }
  list = list.filter((r) => !inner.has(r));
  // 外壁の面・凹みの輪郭: 中に窓を余白 220mm 超で抱える四角は窓ではない
  list = list.filter((a) => !list.some((b) => b !== a && inside(a, b) && area(b) < area(a) && maxMargin(a, b) > 220));
  // 引違いの障子・欄間: 上下（左右）がそろって隙間 160mm 以内で並ぶ、枠の無い四角（障子・ガラスだけの線）はまとめる。
  // 枠の二重線がある四角はそれだけで 1 つの窓（方立てを挟んで並ぶ連窓は別々の窓）
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.framed || b.framed) continue;
        const side = Math.abs(a.y0 - b.y0) * mm <= 80 && Math.abs(a.y1 - b.y1) * mm <= 80 && Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1) <= 160 / mm;
        const stack = Math.abs(a.x0 - b.x0) * mm <= 80 && Math.abs(a.x1 - b.x1) * mm <= 80 && Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1) <= 160 / mm;
        if (!side && !stack) continue;
        list[i] = { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1), panes: a.panes + b.panes, framed: a.framed || b.framed };
        list.splice(j, 1);
        merged = true;
        break outer;
      }
  }
  return list.map(({ framed: _f, ...r }) => r);
}

/**
 * 立面図のページから 4 面の図を読む。
 * @param mmHint 平面図から求めた 1pt あたりの mm（立面図に「N階FL」が無いときの縮尺）
 */
export function readElevationViews(pages: PageVectors[], mmHint: number, heights?: ElevationHeights | null): ElevationView[] {
  const out: ElevationView[] = [];
  for (const page of pages) {
    const titles = findElevationTitles(page.texts);
    if (titles.length < 2) continue;
    // 縮尺: 「1階FL」と「2階FL」の間隔 = 1 階の階高（同じページの立面図は同じ縮尺）
    let mm = mmHint;
    let fromLabels = false;
    const h1 = heights?.storyHeights?.[0];
    if (h1) {
      const fl = (n: number) => page.texts.filter((t) => new RegExp(`^${n}階FL$`).test(z2h(t.str).replace(/ＦＬ/g, 'FL')));
      const ks: number[] = [];
      // 1 階 FL ごとに、すぐ上（同じ列）の 2 階 FL と組む（下の段の 1 階 FL と上の段の 2 階 FL を組まない）
      for (const a of fl(1)) {
        const b = fl(2)
          .filter((b) => Math.abs(a.cx - b.cx) < 30 && a.cy - b.cy > 20)
          .sort((p, q) => q.cy - p.cy)[0];
        if (b) ks.push(h1 / (a.cy - b.cy));
      }
      ks.sort((a, b) => a - b);
      const k = ks[Math.floor(ks.length / 2)];
      // 立面図の縮尺は平面図と違うことがある（平面図 1/50・立面図 1/100、平面図だけ縮小印刷など）ので、FL の間隔から求めた方を使う
      if (k && k > 8 && k < 150 && ks.every((x) => Math.abs(x / k - 1) < 0.05)) {
        mm = k;
        fromLabels = true;
      }
    }
    if (!mm) continue;
    const regions = regionsOf(titles, page);
    const got: { title: ElevationTitle; box: Box; v: NonNullable<ReturnType<typeof readView>> }[] = [];
    for (const [title, box] of regions) {
      const v = readView(page, title, box, mm, heights);
      if (v) got.push({ title, box, v });
    }
    // 同じ段に並ぶ図は、同じ GL の線の上に描かれる。「GL」の文字は段の端の図にしか無いので、文字の無い図は
    // 壁の縦線がいちばん多く立つ横線（= 基礎の天端。GL より 40〜50cm 高い）を GL と取り違える。
    // 同じ段の、文字で GL を決めた図と同じ高さに横線があれば、それを GL にする（吉田大仁様邸: 東面・西面の窓の高さが 470mm 低かった）
    if (!(globalThis as { __NO_ELEV_ROW_GL?: boolean }).__NO_ELEV_ROW_GL)
      for (const g of got) {
        if (g.v.glInfo.byText) continue;
        const ys = got.filter((o) => o !== g && Math.abs(o.title.cy - g.title.cy) < 60 && o.v.glInfo.byText).map((o) => o.v.glY);
        if (!ys.length || Math.max(...ys) - Math.min(...ys) > 1.2) continue;
        const anchor = ys[0];
        if (Math.abs(anchor - g.v.glY) <= 1.2 || Math.abs(anchor - g.v.glY) * mm > 1500) continue;
        if (!g.v.glInfo.cands.some((y) => Math.abs(y - anchor) <= 1.2)) continue;
        const v2 = readView(page, g.title, g.box, mm, heights, anchor);
        if (v2) g.v = v2;
      }
    for (const g of got) {
      const { glInfo: _gi, ...v } = g.v;
      out.push({ ...v, scaleFromLabels: fromLabels });
    }
  }
  return out;
}

const dbg2 = () => (globalThis as { __ELEV_DBG?: unknown[] }).__ELEV_DBG;

/**
 * 1 面を読む。glHint = GL の線の高さの手掛かり（ページの pt。同じ段の図の GL）。その高さに横線があれば GL に使う。
 * glInfo は GL の決め方（byText = この図の「GL」の文字で決めた）と、GL の候補の横線の高さ
 */
function readView(page: PageVectors, title: ElevationTitle, box: Box, mm: number, heights?: ElevationHeights | null, glHint?: number): (Omit<ElevationView, 'scaleFromLabels'> & { glInfo: { byText: boolean; cands: number[] } }) | null {
  const segs = page.segments.filter((s) => {
    const cx = (s.a.x + s.b.x) / 2;
    const cy = (s.a.y + s.b.y) / 2;
    return cx > box.x0 && cx < box.x1 && cy > box.y0 && cy < box.y1;
  });
  if (segs.length < 20) return null;
  // GL: 見出しのすぐ上（3m 以内）の、区画の幅の 1/4 以上ある横線のうち、いちばん長いもの。「GL」の文字があればその高さのもの
  const near = (box.y1 - box.y0) * 0.6;
  const cands = longHorizontals(segs, { ...box, y0: Math.max(box.y0, box.y1 - Math.min(near, 3200 / mm)) }).filter((h) => h.x1 - h.x0 >= (box.x1 - box.x0) * 0.25);
  if (!cands.length) return null;
  // 「GL」の文字は線の上か横に書く（線の 3pt 上〜15pt 下までの横線のうち文字に近いもの）。文字が無ければ、壁の縦線がいちばん多く立つ横線
  const glText = page.texts.find((t) => /^(設計)?GL$/.test(z2h(t.str).replace(/ＧＬ/g, 'GL')) && t.cx > box.x0 && t.cx < box.x1 && t.cy > box.y0 && t.cy < box.y1);
  const byText = glText ? cands.filter((h) => h.y >= glText.cy - 3 && h.y <= glText.cy + 15).sort((a, b) => Math.abs(a.y - glText.cy) - Math.abs(b.y - glText.cy)) : [];
  const standing = (h: { y: number; x0: number; x1: number }) =>
    segs.filter((sg) => isV(sg) && !isGray(sg.color) && Math.abs(Math.max(sg.a.y, sg.b.y) - h.y) < 1.5 && sg.a.x > h.x0 - 1 && sg.a.x < h.x1 + 1 && Math.abs(sg.a.y - sg.b.y) * mm > 800).length;
  const hinted = glHint != null ? cands.filter((h) => Math.abs(h.y - glHint) <= 1.2).sort((a, b) => Math.abs(a.y - glHint) - Math.abs(b.y - glHint))[0] : undefined;
  const gl = hinted ?? byText[0] ?? [...cands].sort((a, b) => standing(b) - standing(a) || b.x1 - b.x0 - (a.x1 - a.x0))[0];
  const glY = gl.y;
  // 建物の左右を探す範囲: GL の線と、その上 1.5m までの長い横線（基礎・土台の線。地面の線が斜め・途切れでも建物の幅を覆う）
  const spanLines = cands.filter((h) => h.y <= glY + 3 && h.y >= glY - 1500 / mm);
  const sx0 = Math.min(gl.x0, ...spanLines.map((h) => h.x0));
  const sx1 = Math.max(gl.x1, ...spanLines.map((h) => h.x1));
  dbg2()?.push({ facing: title.facing, box, gl, cands: cands.slice(0, 40), glText: glText ? { y: glText.cy, x: glText.cx } : null });
  // 外形の左右: GL から 1.2m 以内で立ち上がる 1m 以上の縦線（寸法線・灰色の線・GL の外の線は除く）
  const vs = segs
    .filter((s) => isV(s) && !s.dashed && !isGray(s.color))
    .map((s) => ({ x: (s.a.x + s.b.x) / 2, lo: Math.min(s.a.y, s.b.y), hi: Math.max(s.a.y, s.b.y), w: s.width }))
    .filter((s) => s.x > sx0 - 0.5 && s.x < sx1 + 0.5 && s.hi <= glY + 0.8 && s.hi >= glY - 1200 / mm && (s.hi - s.lo) * mm >= 1000);
  if (vs.length < 2) return null;
  const ws = vs.map((s) => s.w).sort((a, b) => a - b);
  const wHi = ws[Math.floor(ws.length * 0.9)];
  const walls = vs.filter((s) => s.w >= wHi * 0.7 - 1e-6);
  let bx0 = Math.min(...walls.map((s) => s.x));
  let bx1 = Math.max(...walls.map((s) => s.x));
  // 寸法線の列（文字の数字のそば）を外形に入れない: 外形の端の縦線の近くに寸法の数字（縦書き）があれば、その線は寸法線
  const isDim = (x: number) => page.texts.some((t) => Math.abs(Math.abs(t.angle) - Math.PI / 2) < 0.2 && /^[\d,，.]+/.test(z2h(t.str)) && Math.abs(t.cx - x) < Math.max(5, t.size * 1.3) && t.cy > box.y0 && t.cy < glY);
  const keep = walls.filter((s) => !isDim(s.x));
  if (keep.length >= 2) {
    bx0 = Math.min(...keep.map((s) => s.x));
    bx1 = Math.max(...keep.map((s) => s.x));
  }
  if ((bx1 - bx0) * mm < 2500) return null;
  // 窓の候補: 外形の中、GL より上、最高高さより下
  const zTop = (heights?.maxHeight ?? 12000) + 300;
  const inBuilding = segs.filter((s) => {
    const xs = [s.a.x, s.b.x];
    const ys = [s.a.y, s.b.y];
    return Math.min(...xs) >= bx0 - 0.5 && Math.max(...xs) <= bx1 + 0.5 && Math.max(...ys) <= glY + 0.5 && (glY - Math.min(...ys)) * mm <= zTop;
  });
  // 外壁の目地（縦張りの板金・サイディングの線）は細い灰色で描かれることが多い。灰色の線が少数派なら四角の辺に使わない（窓の枠は黒い線）
  const grayShare = inBuilding.filter((sg) => isGray(sg.color)).length / Math.max(1, inBuilding.length);
  const frameLines = grayShare < 0.5 ? inBuilding.filter((sg) => !isGray(sg.color)) : inBuilding;
  const rects = findRects(frameLines, 150 / mm, 100 / mm).filter((r) => {
    const w = (r.x1 - r.x0) * mm;
    const hgt = (r.y1 - r.y0) * mm;
    return w >= 200 && hgt >= 150 && w <= 7000 && hgt <= 3200 && (glY - r.y1) * mm >= -50;
  });
  // 窓は 1 階の床より上（床 − 400 まで）、いちばん高い軒より下。車庫のシャッター・土間の戸・基礎の帯・屋根の端の飾りを除く
  const fl1 = heights?.floor1 ?? 500;
  const eave = heights?.maxEave ?? (heights?.maxHeight ? heights.maxHeight - 300 : 12000);
  const units = windowUnits(rects, mm).filter((u) => {
    const w = (u.x1 - u.x0) * mm;
    const hgt = (u.y1 - u.y0) * mm;
    const z0 = (glY - u.y1) * mm;
    const z1 = (glY - u.y0) * mm;
    if (z0 < fl1 - 400 || z1 > eave + 100) return false;
    // シャッター・ガラリ: 幅いっぱいの横線が 6 本以上
    const slats = inBuilding.filter((sg) => isH(sg) && (sg.a.y + sg.b.y) / 2 > u.y0 + 0.5 && (sg.a.y + sg.b.y) / 2 < u.y1 - 0.5 && Math.min(sg.a.x, sg.b.x) <= u.x0 + (u.x1 - u.x0) * 0.1 && Math.max(sg.a.x, sg.b.x) >= u.x1 - (u.x1 - u.x0) * 0.1).length;
    if (slats >= 6) return false;
    // 外形とほぼ同じ幅の四角（バルコニーの手すり壁・基礎）は除く
    if (w > (bx1 - bx0) * mm * 0.85) return false;
    return w >= 250 && hgt >= 280 && w <= 6000 && hgt <= 3000;
  });
  if (dbg2()) dbg2()!.push({ facing: title.facing, glY, bx0, bx1, mm, units: windowUnits(rects, mm) });
  return {
    facing: title.facing,
    pageIndex: page.pageIndex,
    mmPerPt: mm,
    width: Math.round((bx1 - bx0) * mm),
    glY,
    bx0,
    bx1,
    windows: units
      .map((u) => ({ u0: Math.round((u.x0 - bx0) * mm), u1: Math.round((u.x1 - bx0) * mm), z0: Math.round((glY - u.y1) * mm), z1: Math.round((glY - u.y0) * mm), panes: u.panes }))
      .sort((a, b) => a.u0 - b.u0 || a.z0 - b.z0),
    glInfo: { byText: !hinted && byText.length > 0, cands: cands.map((h) => h.y) },
  };
}

// ---------------------------------------------------------------------------
// 平面図の窓に当てる

interface FacadeWin {
  fi: number;
  floor: Floor;
  op: Opening;
  s0: number;
  s1: number;
}

/** 面の外向きの法線（平面図の座標: x 右・y 下）と、その面を外から見たときの右手の向き */
const AXES: { n: Vec2; r: Vec2 }[] = [
  { n: { x: 0, y: 1 }, r: { x: 1, y: 0 } }, // 下の面（図面上の南）: 右手は東
  { n: { x: 0, y: -1 }, r: { x: -1, y: 0 } }, // 上の面（北）: 右手は西
  { n: { x: 1, y: 0 }, r: { x: 0, y: -1 } }, // 右の面（東）: 右手は北
  { n: { x: -1, y: 0 }, r: { x: 0, y: 1 } }, // 左の面（西）: 右手は南
];

/** 真の向き（東西南北）の面に当たる平面図の面（真北が図面の上から時計回りに northDeg） */
export function axisForFacing(facing: Facing, northDeg: number): number {
  const th = (northDeg * Math.PI) / 180;
  const north = { x: Math.sin(th), y: -Math.cos(th) };
  const east = { x: Math.cos(th), y: Math.sin(th) };
  const d = facing === 'N' ? north : facing === 'S' ? { x: -north.x, y: -north.y } : facing === 'E' ? east : { x: -east.x, y: -east.y };
  let best = 0;
  let bestDot = -2;
  AXES.forEach((a, i) => {
    const dot = a.n.x * d.x + a.n.y * d.y;
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  });
  return best;
}

const dot = (p: Vec2, q: Vec2) => p.x * q.x + p.y * q.y;

function wallNormal(w: Floor['walls'][number]): Vec2 | null {
  if (!w.exterior || w.outsideSign == null) return null;
  const dx = w.b.x - w.a.x;
  const dy = w.b.y - w.a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1) return null;
  return { x: (-dy / L) * w.outsideSign, y: (dx / L) * w.outsideSign };
}

/** 面の左右の端（外壁の外面の、右手方向の最小・最大） */
function facadeExtent(floors: Floor[], r: Vec2): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of floors)
    for (const w of f.walls) {
      if (!w.exterior) continue;
      for (const p of [w.a, w.b]) {
        const s = dot(p, r);
        lo = Math.min(lo, s - w.thickness / 2);
        hi = Math.max(hi, s + w.thickness / 2);
      }
    }
  return [lo, hi];
}

function facadeWindows(floors: Floor[], axis: number, kinds: Opening['kind'][]): FacadeWin[] {
  const { n, r } = AXES[axis];
  const out: FacadeWin[] = [];
  floors.forEach((f, fi) => {
    for (const w of f.walls) {
      const wn = wallNormal(w);
      if (!wn || dot(wn, n) < 0.95) continue;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      const at = (t: number) => dot({ x: w.a.x + ((w.b.x - w.a.x) * t) / L, y: w.a.y + ((w.b.y - w.a.y) * t) / L }, r);
      for (const op of f.openings) {
        if (op.wallId !== w.id || !kinds.includes(op.kind)) continue;
        const a = at(op.t0);
        const b = at(op.t1);
        out.push({ fi, floor: f, op, s0: Math.min(a, b), s1: Math.max(a, b) });
      }
    }
  });
  return out;
}

const iou = (a0: number, a1: number, b0: number, b1: number) => {
  const inter = Math.min(a1, b1) - Math.max(a0, b0);
  if (inter <= 0) return 0;
  return inter / (Math.max(a1, b1) - Math.min(a0, b0));
};

/** 立面図の窓の下端が、どの階の床の上か（床 − 400 より上で一番高い階） */
function floorOf(floors: Floor[], z0: number): number {
  let fi = -1;
  floors.forEach((f, i) => {
    if (z0 >= f.elevation - 400) fi = i;
  });
  return fi;
}

/** 立面図の窓（引違いの障子が別々の四角でも、平面図の 1 つの窓に入るものはまとめる）と平面図の窓の対応 */
interface Pair {
  pw: FacadeWin;
  wins: ElevWindow[];
  /** まとめた立面図の窓の高さ（GL から） */
  z0: number;
  z1: number;
  iou: number;
}

interface Fit {
  axis: number;
  off: number;
  score: number;
  pairs: Pair[];
  widthRatio: number;
}

/** 平面図の窓 1 つに当たる立面図の窓: 自分の幅の半分以上が平面図の窓に入る窓をまとめる（無ければいちばん重なる 1 つ） */
function matchOne(pw: FacadeWin, wins: { w: ElevWindow; fi: number }[], base: number): Pair | null {
  const same = wins.filter((x) => x.fi === pw.fi);
  const inside = same.filter(({ w }) => Math.min(pw.s1, base + w.u1) - Math.max(pw.s0, base + w.u0) >= (w.u1 - w.u0) * 0.5);
  let group = inside.map((x) => x.w);
  if (!group.length) {
    let bi = 0;
    let bw: ElevWindow | null = null;
    for (const { w } of same) {
      const q = iou(pw.s0, pw.s1, base + w.u0, base + w.u1);
      if (q > bi) {
        bi = q;
        bw = w;
      }
    }
    if (!bw) return null;
    group = [bw];
  }
  // 高さのそろわない窓（同じ幅の中の地窓と高窓など）は除く: いちばん大きい窓から、高さが重なるか上下に接する（隙間 120mm 以内）窓だけを足していく
  const main = group.reduce((a, b) => ((b.u1 - b.u0) * (b.z1 - b.z0) > (a.u1 - a.u0) * (a.z1 - a.z0) ? b : a));
  const keep = [main];
  let z0 = main.z0;
  let z1 = main.z1;
  for (let grew = true; grew; ) {
    grew = false;
    for (const w of group) {
      if (keep.includes(w)) continue;
      const overlapZ = Math.min(w.z1, z1) - Math.max(w.z0, z0);
      const sameRow = overlapZ > Math.min(w.z1 - w.z0, z1 - z0) * 0.5;
      const stacked = overlapZ > -120 && Math.min(w.u1, main.u1) - Math.max(w.u0, main.u0) >= Math.min(w.u1 - w.u0, main.u1 - main.u0) * 0.8;
      if (!sameRow && !stacked) continue;
      keep.push(w);
      z0 = Math.min(z0, w.z0);
      z1 = Math.max(z1, w.z1);
      grew = true;
    }
  }
  group = keep;
  const u0 = Math.min(...group.map((w) => w.u0));
  const u1 = Math.max(...group.map((w) => w.u1));
  const q = iou(pw.s0, pw.s1, base + u0, base + u1);
  if (q < 0.35) return null;
  return { pw, wins: group, z0: Math.min(...group.map((w) => w.z0)), z1: Math.max(...group.map((w) => w.z1)), iou: q };
}

/**
 * 面の当て方: 平面図の外形の端 + off に立面図の外形の左端を置いたとき、窓の重なりがいちばん大きい off。
 * onlyFloor を渡すとその階の窓だけで当てる（上下階の重ね位置の確かめ用）
 */
function fitView(floors: Floor[], v: ElevationView, axis: number, onlyFloor?: number, range = 1200): Fit {
  const { r } = AXES[axis];
  const [lo, hi] = facadeExtent(floors, r);
  const pws = facadeWindows(floors, axis, ['window']).filter((p) => onlyFloor == null || p.fi === onlyFloor);
  const wins = v.windows.map((w) => ({ w, fi: floorOf(floors, w.z0) })).filter((x) => x.fi >= 0 && (onlyFloor == null || x.fi === onlyFloor));
  const widthRatio = v.width / Math.max(1, hi - lo);
  let best: Fit = { axis, off: 0, score: -1, pairs: [], widthRatio };
  for (let off = -range; off <= range; off += 15) {
    let score = -Math.abs(off) * 1e-4;
    const pairs: Pair[] = [];
    for (const pw of pws) {
      const m = matchOne(pw, wins, lo + off);
      if (!m) continue;
      score += m.iou;
      pairs.push(m);
    }
    if (score > best.score) best = { axis, off, score, pairs, widthRatio };
  }
  // 幅が大きく違う面は当てない
  if (widthRatio < 0.7 || widthRatio > 1.4) best.score *= 0.3;
  return best;
}

/**
 * 各面を平面図のどの面に当てるか。見出しの向き（真北のずれを考えた面）を使う。
 * 方位記号の読み違いで全体が 90°・180° 回っているときだけ、4 面まとめて回した当て方に乗り換える（1 面だけ別の面に乗り換えない）
 */
function chooseAxes(floors: Floor[], views: ElevationView[], northDeg: number): { axes: Map<ElevationView, Fit>; rotated: number } {
  const cand = [0, 1, 2, 3].map((k) => {
    const axes = new Map<ElevationView, Fit>();
    let total = 0;
    let pairs = 0;
    const used = new Set<number>();
    for (const v of views) {
      if (!v.windows.length) continue;
      const axis = axisForFacing(v.facing, northDeg + k * 90);
      if (used.has(axis)) continue;
      used.add(axis);
      const fit = fitView(floors, v, axis);
      if (fit.score <= 0 || !fit.pairs.length) continue;
      axes.set(v, fit);
      total += fit.score;
      pairs += fit.pairs.length;
    }
    return { k, axes, total, pairs };
  });
  const base = cand[0];
  const best = [...cand].sort((a, b) => b.total - a.total)[0];
  const pick = best !== base && best.pairs >= 3 && best.total > Math.max(1, base.total * 2) ? best : base;
  return { axes: pick.axes, rotated: pick.k * 90 };
}

export interface FloorShift {
  level: number;
  dx: number;
  dy: number;
  /** 根拠の面（「南面: 1 階 3・2 階 2 か所」） */
  evidence: string[];
}

/**
 * 立面図の窓の並びで、上下階の重ね位置を確かめる。
 * 平面図は 2 階を壁と階段の重なりで 1 階に重ねるが、910 の格子に乗った家は半間・1 間ずれた位置も同じくらい良く見える（吉田様 1st: 2 階が 1 間ずれ）。
 * 立面図は 1 枚の絵の中で 1 階と 2 階の窓の位置関係が正しいので、面ごとに 1 階の窓・2 階の窓を別々に当てて、当て位置の差 = 平面図の 2 階のずれ。
 * 向かい合う 2 面（南と北・東と西）で同じずれが出たときだけ（片面なら両方の階で 2 か所以上ぴったり合うときだけ）直す。
 * @param grid 半間（455）などの格子。近ければ格子の倍数にそろえる
 */
export function floorShiftsFromElevation(floorsIn: Floor[], views: ElevationView[], northDeg: number, grid?: number): FloorShift[] {
  const floors = [...floorsIn].sort((a, b) => a.level - b.level);
  if (floors.length < 2) return [];
  type Est = { fi: number; v: number; strong: boolean; note: string };
  const ex: Est[] = [];
  const ey: Est[] = [];
  const { axes } = chooseAxes(floors, views, northDeg);
  for (const [v, fit] of axes) {
    const per = floors.map((_, fi) => fitView(floors, v, fit.axis, fi, 2500));
    const good = (f: Fit) => f.pairs.length >= 1 && f.pairs.reduce((s, p) => s + p.iou, 0) / f.pairs.length >= 0.7 && (f.pairs.length >= 2 || f.pairs[0].iou >= 0.85);
    if (!good(per[0])) continue;
    const { r } = AXES[fit.axis];
    for (let fi = 1; fi < floors.length; fi++) {
      if (!good(per[fi])) continue;
      const delta = per[fi].off - per[0].off;
      const strong = per[0].pairs.length >= 2 && per[fi].pairs.length >= 2;
      const note = `${FACING_JA[v.facing]}面（1 階 ${per[0].pairs.length}・${floors[fi].level} 階 ${per[fi].pairs.length} か所）`;
      // 平面図のその階は、正しい位置から r の向きへ delta ずれている → 直す量は −delta
      if (r.x) ex.push({ fi, v: -delta * r.x, strong, note });
      else ey.push({ fi, v: -delta * r.y, strong, note });
    }
  }
  const combine = (list: Est[], fi: number): { v: number; notes: string[] } | null => {
    const l = list.filter((e) => e.fi === fi);
    if (!l.length) return null;
    const vs = l.map((e) => e.v);
    if (l.length >= 2) {
      if (Math.max(...vs) - Math.min(...vs) > 250) return null;
      return { v: vs.reduce((a, b) => a + b, 0) / vs.length, notes: l.map((e) => e.note) };
    }
    return l[0].strong ? { v: vs[0], notes: [l[0].note] } : null;
  };
  const snap = (x: number) => {
    if (Math.abs(x) < 250) return 0;
    if (grid) {
      const k = Math.round(x / grid) * grid;
      if (Math.abs(k - x) <= 120) return k;
    }
    return Math.round(x / 10) * 10;
  };
  const out: FloorShift[] = [];
  for (let fi = 1; fi < floors.length; fi++) {
    const cx = combine(ex, fi);
    const cy = combine(ey, fi);
    const dx = cx ? snap(cx.v) : 0;
    const dy = cy ? snap(cy.v) : 0;
    if (!dx && !dy) continue;
    if (Math.abs(dx) > 2500 || Math.abs(dy) > 2500) continue;
    out.push({ level: floors[fi].level, dx, dy, evidence: [...(dx ? cx!.notes : []), ...(dy ? cy!.notes : [])] });
  }
  return out;
}

/**
 * 立面図の建物の幅と平面図の外形の幅の比（平面図の縮尺の確かめ）。
 * 立面図の縮尺が「1階FL」「2階FL」の間隔から分かっていて、3 面以上で比がそろうときだけ返す（ばらつき 7% 以内）。
 * 田添様邸の意匠図: 平面図を 1/50 と読んでいたが、立面図の幅は 4 面とも平面図の 1.18 倍 → 本当は 1/60（帖数も 2/8 → 5/7 室で合う）
 */
export function planScaleFromElevation(floors: Floor[], views: ElevationView[], northDeg: number): { k: number; spread: number; n: number } | null {
  const vs = views.filter((v) => v.scaleFromLabels && v.width > 2500);
  if (vs.length < 3) return null;
  const [x0, x1] = facadeExtent(floors, { x: 1, y: 0 });
  const [y0, y1] = facadeExtent(floors, { x: 0, y: 1 });
  const ex = x1 - x0;
  const ey = y1 - y0;
  if (!(ex > 1000 && ey > 1000)) return null;
  let best: { k: number; spread: number; n: number } | null = null;
  for (const rot of [0, 90]) {
    const rs = vs.map((v) => v.width / (AXES[axisForFacing(v.facing, northDeg + rot)].r.x ? ex : ey));
    const spread = Math.max(...rs) - Math.min(...rs);
    const k = rs.reduce((a, b) => a + b, 0) / rs.length;
    if (!best || spread < best.spread) best = { k, spread, n: rs.length };
  }
  return best && best.spread <= 0.07 ? best : null;
}

export interface ElevationWindowResult {
  /** 立面図で高さを確かめた窓 */
  matched: number;
  /** そのうち腰高・高さを直した窓 */
  changed: number;
  /** 平面図の外壁の窓の数（立面図の面に当たったもの） */
  total: number;
  /** 立面図から足した窓 */
  added: number;
  /** 並びの合った面で、立面図に相手の無い平面図の窓（読み違いの疑い） */
  unmatched: { level: number; facing: Facing; id: string; width: number }[];
  /** 当てた面（「南面 4 か所」など） */
  facades: string[];
  notes: string[];
}

/**
 * 窓の形の名前を、腰高・高さに合わせ直す。浴室・トイレの小窓（曇りガラス）と縦スリットはそのまま。
 * 3D では「高窓」は横すべり出し 1 枚、「腰窓」は幅 75cm までなら縦すべり出し 1 枚・それより広いと FIX ＋縦すべり出し
 */
export function styleFor(prev: WindowStyle | undefined, sill: number, height: number, width: number): WindowStyle {
  if (prev === 'small' && sill >= 900) return prev;
  if (prev === 'slit' && width <= 500) return prev;
  if (sill <= 150 && height >= 1700) return width <= 500 ? 'slit' : 'hakidashi';
  // 横長で低い窓（地窓・天井際の横長窓）
  if (height <= 600 || (sill >= 1300 && width >= height * 1.5)) return 'high';
  return 'koshi';
}

/**
 * 立面図の窓の高さを平面図の窓に当てる（floors を書き換える）。
 * 面ごとに、見出しの向き（真北のずれを考えた面）で当て、窓の並びが合わなければ他の面も試す。
 * 上下階の重ね位置がずれていても窓の高さは当たるよう、階ごとに当て位置を求め直す。
 */
export function applyElevationWindows(floorsIn: Floor[], views: ElevationView[], northDeg: number): ElevationWindowResult {
  const floors = [...floorsIn].sort((a, b) => a.level - b.level);
  const res: ElevationWindowResult = { matched: 0, changed: 0, total: 0, added: 0, unmatched: [], facades: [], notes: [] };
  const log = (globalThis as { __ELEV_LOG?: boolean }).__ELEV_LOG ? (globalThis as { console: Console }).console : null;
  const { axes, rotated } = chooseAxes(floors, views, northDeg);
  if (rotated) res.notes.push(`立面図の東西南北と方位記号の向きが ${rotated}° 違うため、窓の並びが合う向きで当てました（方位をご確認ください）`);
  for (const [v, fit] of axes) {
    if (log) log.info(`fit ${v.facing} axis${fit.axis} off ${fit.off} score ${fit.score.toFixed(2)} pairs ${fit.pairs.length} width ${fit.widthRatio.toFixed(2)}`);
    // 階ごとに当て位置を求め直す（全体の当て位置の ±600 の中で）
    const pairs: Pair[] = [];
    const offs: number[] = [];
    floors.forEach((_, fi) => {
      const pf = fitView(floors, v, fit.axis, fi, 2500);
      const usePf = pf.pairs.length && pf.score > 0;
      const chosen = usePf ? pf : { ...fit, pairs: fit.pairs.filter((p) => p.pw.fi === fi) };
      offs.push(chosen.off);
      pairs.push(...chosen.pairs);
    });
    if (log) {
      const { r } = AXES[fit.axis];
      const [lo] = facadeExtent(floors, r);
      log.info('  offs per floor:', offs.join(' '));
      log.info('  plan:', facadeWindows(floors, fit.axis, ['window', 'door', 'sliding', 'entrance', 'shutter', 'open']).map((p) => `${p.floor.level}F:${p.op.kind[0]}${Math.round(p.s0 - lo)}-${Math.round(p.s1 - lo)}`).join(' '));
      log.info('  elev:', v.windows.map((w) => `${floorOf(floors, w.z0) + 1}F:${w.u0}-${w.u1}`).join(' '));
    }
    let changed = 0;
    let matchedHere = 0;
    for (const pr of pairs) {
      const f = pr.pw.floor;
      const sill = Math.max(0, Math.round((pr.z0 - f.elevation) / 10) * 10);
      const height = Math.round((pr.z1 - pr.z0) / 10) * 10;
      if (height < 150 || sill > 2600 || sill + height > f.height + 300) continue;
      matchedHere++;
      const op = pr.pw.op;
      const width = op.t1 - op.t0;
      if (Math.abs(op.sill - sill) >= 30 || Math.abs(op.height - height) >= 30) {
        op.sill = sill;
        op.height = height;
        op.windowStyle = styleFor(op.windowStyle, sill, height, width);
        changed++;
      }
      op.heightFrom = 'elevation';
    }
    res.matched += matchedHere;
    res.changed += changed;
    res.total += facadeWindows(floors, fit.axis, ['window']).length;
    // 読み落とした窓: 並びが確かに合っている面（その階で 2 か所以上・平均の重なり 0.6 以上）だけ
    let added = 0;
    floors.forEach((_, fi) => {
      const pf = pairs.filter((p) => p.pw.fi === fi);
      if (pf.length < 2 || pf.reduce((s, p) => s + p.iou, 0) / pf.length < 0.6) return;
      added += addMissing(floors, v, fit.axis, offs[fi], fi, new Set(pf.flatMap((p) => p.wins)));
    });
    res.added += added;
    res.facades.push(`${FACING_JA[v.facing]}面 ${matchedHere} か所${added ? `＋${added}` : ''}`);
    // 立面図に見当たらない平面図の窓: 並びが確かに合っている面・階（2 か所以上・平均の重なり 0.6 以上）で、相手の無い窓
    // = 図面の読み違い（壁の線・庇の線を窓と読んだ）の疑い。消さずに知らせる
    const pairedOps = new Set(pairs.map((p) => p.pw.op));
    floors.forEach((f, fi) => {
      const pf = pairs.filter((p) => p.pw.fi === fi);
      if (pf.length < 2 || pf.reduce((s0, p) => s0 + p.iou, 0) / pf.length < 0.6) return;
      for (const pw of facadeWindows(floors, fit.axis, ['window'])) {
        if (pw.fi !== fi || pairedOps.has(pw.op) || pw.op.heightFrom === 'elevation') continue;
        res.unmatched.push({ level: f.level, facing: v.facing, id: pw.op.id, width: Math.round(pw.op.t1 - pw.op.t0) });
      }
    });
  }
  if (res.unmatched.length) res.notes.push(`立面図に見当たらない窓 ${res.unmatched.length} か所（${res.unmatched.slice(0, 4).map((u) => `${u.level}階 ${FACING_JA[u.facing]}面 幅${u.width}`).join('・')}${res.unmatched.length > 4 ? '…' : ''}）。図面の読み違いの疑いがあります。方眼で確かめてください`);
  if (res.matched) res.notes.push(`立面図から窓の高さを読みました: ${res.matched} か所（うち腰高・高さを直した窓 ${res.changed}）・${res.facades.join('／')}`);
  if (res.added) res.notes.push(`平面図で読めなかった窓 ${res.added} か所を立面図から足しました（方眼で確認してください）`);
  return res;
}

/** 立面図にあって平面図に無い窓を、その面のその階の外壁に足す */
function addMissing(floors: Floor[], v: ElevationView, axis: number, off: number, onlyFi: number, matched: Set<ElevWindow>): number {
  const { n, r } = AXES[axis];
  const [lo] = facadeExtent(floors, r);
  const all = facadeWindows(floors, axis, ['window', 'door', 'sliding', 'entrance', 'open', 'shutter']);
  let added = 0;
  for (const win of v.windows) {
    if (matched.has(win)) continue;
    const fi = floorOf(floors, win.z0);
    if (fi !== onlyFi) continue;
    const f = floors[fi];
    const s0 = lo + off + win.u0;
    const s1 = lo + off + win.u1;
    if (s1 - s0 < 300 || s1 - s0 > 3600) continue;
    // その階の同じ面のどの開口とも重ならない（3 割未満）
    if (all.some((pw) => pw.fi === fi && Math.min(pw.s1, s1) - Math.max(pw.s0, s0) > (s1 - s0) * 0.3)) continue;
    const sill = Math.max(0, Math.round((win.z0 - f.elevation) / 10) * 10);
    const height = Math.round((win.z1 - win.z0) / 10) * 10;
    if (height < 200 || sill > 2400 || sill + height > f.height + 200) continue;
    // 窓を受ける外壁: その面を向き、窓の幅をまるごと含む外壁のうち、いちばん外側
    let best: { w: Floor['walls'][number]; t0: number; t1: number; depth: number } | null = null;
    for (const w of f.walls) {
      const wn = wallNormal(w);
      if (!wn || dot(wn, n) < 0.95) continue;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      const sa = dot(w.a, r);
      const sb = dot(w.b, r);
      const sign = sb >= sa ? 1 : -1;
      if (Math.min(sa, sb) > s0 + 50 || Math.max(sa, sb) < s1 - 50) continue;
      const t0 = sign > 0 ? s0 - sa : sa - s1;
      const t1 = t0 + (s1 - s0);
      if (t0 < 0 || t1 > L) continue;
      const depth = dot(w.a, n);
      if (!best || depth > best.depth) best = { w, t0: Math.round(t0), t1: Math.round(t1), depth };
    }
    if (!best) continue;
    const width = best.t1 - best.t0;
    if (f.openings.some((o) => o.wallId === best!.w.id && o.t0 < best!.t1 + 50 && o.t1 > best!.t0 - 50)) continue;
    f.openings.push({
      id: `oel-${f.level}-${f.openings.length + 1}`,
      wallId: best.w.id,
      kind: 'window',
      t0: best.t0,
      t1: best.t1,
      sill,
      height,
      windowStyle: styleFor(undefined, sill, height, width),
      confidence: 0.75,
      heightFrom: 'elevation',
    });
    added++;
  }
  return added;
}
