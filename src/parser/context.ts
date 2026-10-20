/**
 * 図面の家具・設備を「文脈」で読む。
 *
 * 御社（ARCHITREND）の平面図は、キッチン・ベッド・ソファ・テレビ台・食卓を単純な長方形で描くことが多く、
 * 線の本数や細部の形では種類が決まらない。そこで、部屋の種類・大きさ・壁からの位置・隣の物との関係で判断する:
 *   LDK の壁沿いの 1,800〜3,400 × 550〜700 はカップボード（背面収納）、その前に平行に置かれた 650〜1,100 奥行はキッチン（対面）、
 *   壁沿いに長い 800〜1,100 奥行はソファ、ソファの正面の壁際の薄い長方形はテレビ台、ソファや食卓を囲む大きな細線の長方形はラグ、
 *   寝室の 850〜1,800 × 1,850〜2,200 はベッド（枕の小さな長方形がある側が頭）、洗面室の壁沿い 700〜1,300 × 450〜650 は洗面台、
 *   浴室の 1,300〜1,800 × 650〜850 は浴槽、便所の 600〜850 × 350〜520 は便器、玄関の壁沿い 300〜450 奥行は靴箱。
 * 記号辞書（symbolDict）に同じ形の答えがあればそれを優先する（修正画面で直した結果を図面ごとに覚える）。
 */
import type { FurnitureItem, FurnitureKind, Room, RoomType, Vec2, Wall } from '../core/types';
import { distPointSegment, pointInPolygon, polygonArea } from '../core/geometry';
import type { Seg, Arc } from './walls';
import { lookupSymbol, signatureOf, type SymbolSignature } from './symbolDict';

/** 図面上の軸平行の長方形（線 4 本で閉じたもの）とその中身 */
export interface PlanRect {
  id: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 中に入っている線の数（自身の辺は除く） */
  inner: number;
  /** 中に入っている小さな長方形の数 */
  innerRects: number;
  /** 中に入っている円弧の数（シンク・コンロ・丸テーブル） */
  arcs: number;
  /** 辺の線幅の平均（細線 = ラグ・吹抜などの輪郭、太線 = 家具） */
  width: number;
  dashed: boolean;
  /** L 字の折れ線の外形（L 型ソファ） */
  lshape?: boolean;
}

const EPS = 25;

/** 軸平行の線 4 本で閉じた長方形を拾う */
export function findRectangles(segs: Seg[], minSize = 280, maxSize = 9500): PlanRect[] {
  const hs: { y: number; x0: number; x1: number; w: number; dashed: boolean }[] = [];
  const vs: { x: number; y0: number; y1: number; w: number; dashed: boolean }[] = [];
  for (const s of segs) {
    const dx = Math.abs(s.b.x - s.a.x);
    const dy = Math.abs(s.b.y - s.a.y);
    if (dy < 3 && dx >= minSize && dx <= maxSize) hs.push({ y: (s.a.y + s.b.y) / 2, x0: Math.min(s.a.x, s.b.x), x1: Math.max(s.a.x, s.b.x), w: s.width, dashed: s.dashed });
    else if (dx < 3 && dy >= minSize && dy <= maxSize) vs.push({ x: (s.a.x + s.b.x) / 2, y0: Math.min(s.a.y, s.b.y), y1: Math.max(s.a.y, s.b.y), w: s.width, dashed: s.dashed });
  }
  // 縦線を x で引けるように
  vs.sort((a, b) => a.x - b.x);
  const vxs = vs.map((v) => v.x);
  const lower = (x: number) => {
    let lo = 0;
    let hi = vxs.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (vxs[m] < x) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const vertAt = (x: number, y0: number, y1: number) => {
    for (let i = lower(x - EPS); i < vs.length && vs[i].x <= x + EPS; i++) {
      const v = vs[i];
      if (Math.abs(v.y0 - y0) <= EPS && Math.abs(v.y1 - y1) <= EPS) return v;
    }
    return null;
  };
  const out: PlanRect[] = [];
  const seen = new Set<string>();
  hs.sort((a, b) => a.y - b.y);
  for (let i = 0; i < hs.length; i++) {
    const top = hs[i];
    for (let j = i + 1; j < hs.length; j++) {
      const bot = hs[j];
      const h = bot.y - top.y;
      if (h > maxSize) break;
      if (h < minSize) continue;
      if (Math.abs(bot.x0 - top.x0) > EPS || Math.abs(bot.x1 - top.x1) > EPS) continue;
      const l = vertAt(top.x0, top.y, bot.y);
      const r = vertAt(top.x1, top.y, bot.y);
      if (!l || !r) continue;
      const key = `${Math.round(top.x0 / 10)},${Math.round(top.y / 10)},${Math.round(top.x1 / 10)},${Math.round(bot.y / 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: out.length, minX: top.x0, minY: top.y, maxX: top.x1, maxY: bot.y, inner: 0, innerRects: 0, arcs: 0, width: (top.w + bot.w + l.w + r.w) / 4, dashed: top.dashed && bot.dashed });
    }
  }
  return out;
}

/** 長方形の中身（線・小さな長方形・円弧）を数える */
export function fillRectContents(rects: PlanRect[], segs: Seg[], arcs: Arc[]) {
  const inside = (r: PlanRect, p: Vec2, m = -EPS) => p.x > r.minX - m && p.x < r.maxX + m && p.y > r.minY - m && p.y < r.maxY + m;
  for (const r of rects) {
    let n = 0;
    for (const s of segs) {
      if (!inside(r, s.a) || !inside(r, s.b)) continue;
      // 自身の辺（外形の上の線）は除く
      const onEdge = (p: Vec2) => Math.abs(p.x - r.minX) < EPS || Math.abs(p.x - r.maxX) < EPS || Math.abs(p.y - r.minY) < EPS || Math.abs(p.y - r.maxY) < EPS;
      if (onEdge(s.a) && onEdge(s.b)) continue;
      n++;
    }
    r.inner = n;
    r.innerRects = rects.filter((o) => o !== r && o.minX >= r.minX - EPS && o.maxX <= r.maxX + EPS && o.minY >= r.minY - EPS && o.maxY <= r.maxY + EPS && (o.maxX - o.minX) * (o.maxY - o.minY) < (r.maxX - r.minX) * (r.maxY - r.minY) * 0.8).length;
    r.arcs = arcs.filter((a) => inside(r, a.p0) && inside(r, a.p3)).length;
  }
}

/** 丸テーブル・丸いシンクなど、円弧が輪になっているもの（中心と半径） */
export function findCircles(arcs: Arc[], rMin = 250, rMax = 900): { x: number; y: number; r: number }[] {
  const out: { x: number; y: number; r: number }[] = [];
  const used = new Set<number>();
  for (let i = 0; i < arcs.length; i++) {
    if (used.has(i)) continue;
    const a = arcs[i];
    // 弧の中点から中心を推定（p0, p3 と制御点の中間で近似）
    const mid = { x: (a.p1.x + a.p2.x) / 2, y: (a.p1.y + a.p2.y) / 2 };
    const chord = { x: (a.p0.x + a.p3.x) / 2, y: (a.p0.y + a.p3.y) / 2 };
    const r0 = Math.hypot(a.p0.x - chord.x, a.p0.y - chord.y);
    const sag = Math.hypot(mid.x - chord.x, mid.y - chord.y) * 0.75;
    if (sag < 10 || r0 < 10) continue;
    const R = (r0 * r0 + sag * sag) / (2 * sag);
    if (R < rMin || R > rMax) continue;
    const dir = { x: (mid.x - chord.x) / (sag / 0.75 || 1), y: (mid.y - chord.y) / (sag / 0.75 || 1) };
    const c = { x: chord.x + dir.x * (sag - R) / 1, y: chord.y + dir.y * (sag - R) / 1 };
    // 同じ中心・半径の弧を集めて 3 つ以上なら円
    const group = [i];
    for (let j = i + 1; j < arcs.length; j++) {
      if (used.has(j)) continue;
      const b = arcs[j];
      const d0 = Math.abs(Math.hypot(b.p0.x - c.x, b.p0.y - c.y) - R);
      const d3 = Math.abs(Math.hypot(b.p3.x - c.x, b.p3.y - c.y) - R);
      if (d0 < R * 0.12 && d3 < R * 0.12) group.push(j);
    }
    if (group.length >= 3) {
      group.forEach((k) => used.add(k));
      out.push({ x: c.x, y: c.y, r: R });
    }
  }
  return out;
}

/**
 * L 字の閉じた折れ線（軸平行の線 6 本）: L 型ソファ・L 型キッチン。外形の矩形と「L」の印を返す
 */
export function findLShapes(segs: Seg[], minSize = 1200, maxSize = 4200): PlanRect[] {
  const ax = segs.filter((s) => {
    const dx = Math.abs(s.b.x - s.a.x);
    const dy = Math.abs(s.b.y - s.a.y);
    return (dx < 3 || dy < 3) && Math.max(dx, dy) >= 250 && Math.max(dx, dy) <= maxSize;
  });
  const key = (p: Vec2) => `${Math.round(p.x / 20)},${Math.round(p.y / 20)}`;
  const byEnd = new Map<string, number[]>();
  ax.forEach((s, i) => {
    for (const p of [s.a, s.b]) {
      const k = key(p);
      const l = byEnd.get(k) ?? [];
      l.push(i);
      byEnd.set(k, l);
    }
  });
  const out: PlanRect[] = [];
  const seen = new Set<string>();
  const near = (p: Vec2, q: Vec2) => Math.abs(p.x - q.x) <= EPS && Math.abs(p.y - q.y) <= EPS;
  for (let i = 0; i < ax.length; i++) {
    // i から始めて端点をたどり、6 本で始点に戻るループを探す
    const walk = (cur: number, from: Vec2, path: number[]): number[] | null => {
      if (path.length === 6) return near(from, ax[path[0]].a) ? path : null;
      const cands = byEnd.get(key(from)) ?? [];
      for (const j of cands) {
        if (path.includes(j)) continue;
        const sj = ax[j];
        const next = near(sj.a, from) ? sj.b : near(sj.b, from) ? sj.a : null;
        if (!next) continue;
        const r = walk(j, next, [...path, j]);
        if (r) return r;
      }
      return null;
    };
    const loop = walk(i, ax[i].b, [i]);
    if (!loop) continue;
    const pts = loop.flatMap((j) => [ax[j].a, ax[j].b]);
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    if (maxX - minX < minSize || maxY - minY < minSize) continue;
    const k = `${Math.round(minX / 10)},${Math.round(minY / 10)},${Math.round(maxX / 10)},${Math.round(maxY / 10)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ id: -1, minX, minY, maxX, maxY, inner: 0, innerRects: 0, arcs: 0, width: ax[i].width, dashed: false, lshape: true });
  }
  return out;
}

/**
 * 短い線がつながって閉じた「輪」（丸い記号: コンロの輪・シンクの排水口・丸い椅子・便器など）。
 * CAD の PDF は円を短い折れ線で描くことが多く、円弧として取れないので線の連なりから拾う
 */
export function findLoops(segs: Seg[], minSize = 120, maxSize = 700, maxSeg = 400): { minX: number; minY: number; maxX: number; maxY: number; n: number }[] {
  const sh = segs.filter((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) <= maxSeg);
  const key = (p: Vec2) => `${Math.round(p.x / 8)},${Math.round(p.y / 8)}`;
  const byEnd = new Map<string, number[]>();
  sh.forEach((s, i) => {
    for (const p of [s.a, s.b]) {
      const k = key(p);
      const l = byEnd.get(k) ?? [];
      l.push(i);
      byEnd.set(k, l);
    }
  });
  const seen = new Uint8Array(sh.length);
  const out: { minX: number; minY: number; maxX: number; maxY: number; n: number }[] = [];
  for (let i = 0; i < sh.length; i++) {
    if (seen[i]) continue;
    // 連結成分を集める
    const comp: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      comp.push(j);
      for (const p of [sh[j].a, sh[j].b]) for (const k of byEnd.get(key(p)) ?? []) if (!seen[k]) { seen[k] = 1; stack.push(k); }
    }
    if (comp.length < 6 || comp.length > 400) continue;
    const pts = comp.flatMap((j) => [sh[j].a, sh[j].b]);
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const w = maxX - minX;
    const h = maxY - minY;
    if (Math.max(w, h) < minSize || Math.max(w, h) > maxSize || Math.min(w, h) < Math.max(w, h) * 0.45) continue;
    // 閉じているか: 端点のうち 1 本にしかつながらない点が少ない
    let open = 0;
    for (const j of comp) for (const p of [sh[j].a, sh[j].b]) if ((byEnd.get(key(p)) ?? []).length < 2) open++;
    if (open > 2) continue;
    out.push({ minX, minY, maxX, maxY, n: comp.length });
  }
  return out;
}

interface Cand {
  rect: PlanRect;
  room: Room;
  cx: number;
  cy: number;
  w: number;
  h: number;
  L: number;
  S: number;
  /** 長手が x 方向か */
  longX: boolean;
  /** 各辺が部屋の壁（輪郭）に接しているか（120mm 以内） */
  touch: { top: boolean; bottom: boolean; left: boolean; right: boolean };
  kind?: FurnitureKind;
  note?: string;
}

const DEG = 180 / Math.PI;

export interface ContextResult {
  items: FurnitureItem[];
  /** 判定に使った長方形（修正画面での学習用） */
  candidates: { id: number; cx: number; cy: number; w: number; h: number; inner: number; arcs?: number; roomId: string; kind?: FurnitureKind }[];
  trace: string[];
}

/**
 * 部屋ごとに長方形を文脈で分類して家具にする。
 * walls は壁の芯（向き・距離の判定に使う）、outline は建物外形。
 */
export function readContextItems(segs: Seg[], arcs: Arc[], rooms: Room[], walls: Wall[], level: number, dict?: SymbolSignature[], prior: FurnitureItem[] = []): ContextResult {
  const items: FurnitureItem[] = [];
  const trace: string[] = [];
  const candidates: ContextResult['candidates'] = [];
  let seq = 0;
  const id = () => `pc${level}_${++seq}`;
  const rects = findRectangles(segs);
  fillRectContents(rects, segs, arcs);
  for (const l of findLShapes(segs)) {
    // 同じ外形の長方形が無いときだけ（ソファの外形と重なる矩形が別にあれば矩形の方を使う）
    if (rects.some((r) => Math.abs(r.minX - l.minX) < EPS && Math.abs(r.maxX - l.maxX) < EPS && Math.abs(r.minY - l.minY) < EPS && Math.abs(r.maxY - l.maxY) < EPS)) continue;
    l.id = rects.length;
    rects.push(l);
  }
  const circles = findCircles(arcs);
  // 丸い記号（コンロの輪・排水口・丸椅子など）
  const rings = findLoops(segs, 120, 700);
  const ringsIn = (r: PlanRect, grow = 0) => rings.filter((g) => (g.minX + g.maxX) / 2 > r.minX - grow && (g.minX + g.maxX) / 2 < r.maxX + grow && (g.minY + g.maxY) / 2 > r.minY - grow && (g.minY + g.maxY) / 2 < r.maxY + grow);
  const roomBBox = (r: Room) => {
    const xs = r.polygon.map((p) => p.x);
    const ys = r.polygon.map((p) => p.y);
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  };
  /** 点から部屋の輪郭（壁芯）までの距離 */
  const edgeDist = (room: Room, p: Vec2) => {
    let d = Infinity;
    const poly = room.polygon;
    for (let i = 0; i < poly.length; i++) d = Math.min(d, distPointSegment(p, poly[i], poly[(i + 1) % poly.length]));
    return d;
  };
  const wallHalf = (walls.length ? walls.reduce((a, w) => a + w.thickness, 0) / walls.length : 130) / 2;
  const TOUCH = wallHalf + 120;

  // 部屋ごとの候補
  const byRoom = new Map<Room, Cand[]>();
  for (const room of rooms) {
    if (['void', 'stairs', 'garage'].includes(room.type)) continue;
    const bb = roomBBox(room);
    const roomArea = Math.abs(polygonArea(room.polygon));
    const cands: Cand[] = [];
    for (const r of rects) {
      const cx = (r.minX + r.maxX) / 2;
      const cy = (r.minY + r.maxY) / 2;
      if (!pointInPolygon({ x: cx, y: cy }, room.polygon)) continue;
      const w = r.maxX - r.minX;
      const h = r.maxY - r.minY;
      // 部屋そのもの・部屋の大半を占める枠は除く
      if (w * h > roomArea * 0.75) continue;
      if (r.minX < bb.minX - TOUCH || r.maxX > bb.maxX + TOUCH || r.minY < bb.minY - TOUCH || r.maxY > bb.maxY + TOUCH) continue;
      // 四隅が部屋の中（壁の厚み分の余裕）
      const corners = [
        { x: r.minX + 30, y: r.minY + 30 },
        { x: r.maxX - 30, y: r.minY + 30 },
        { x: r.minX + 30, y: r.maxY - 30 },
        { x: r.maxX - 30, y: r.maxY - 30 },
      ];
      if (corners.filter((c) => pointInPolygon(c, room.polygon)).length < 3) continue;
      const touch = {
        top: edgeDist(room, { x: cx, y: r.minY }) <= TOUCH,
        bottom: edgeDist(room, { x: cx, y: r.maxY }) <= TOUCH,
        left: edgeDist(room, { x: r.minX, y: cy }) <= TOUCH,
        right: edgeDist(room, { x: r.maxX, y: cy }) <= TOUCH,
      };
      cands.push({ rect: r, room, cx, cy, w, h, L: Math.max(w, h), S: Math.min(w, h), longX: w >= h, touch });
    }
    // 同じ奥行の長方形が長手方向に隣り合う（シンク側とコンロ側を分けて描いたカウンター）→ 1 つにまとめる
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const a = cands[i];
        const b = cands[j];
        if (a.longX !== b.longX || Math.abs(a.S - b.S) > 40 || a.S < 450 || a.S > 1200) continue;
        const aligned = a.longX ? Math.abs(a.rect.minY - b.rect.minY) <= 40 && Math.abs(a.rect.maxY - b.rect.maxY) <= 40 : Math.abs(a.rect.minX - b.rect.minX) <= 40 && Math.abs(a.rect.maxX - b.rect.maxX) <= 40;
        if (!aligned) continue;
        const gap = a.longX ? Math.max(a.rect.minX - b.rect.maxX, b.rect.minX - a.rect.maxX) : Math.max(a.rect.minY - b.rect.maxY, b.rect.minY - a.rect.maxY);
        if (gap > 40 || gap < -40) continue;
        const r: PlanRect = { id: a.rect.id, minX: Math.min(a.rect.minX, b.rect.minX), minY: Math.min(a.rect.minY, b.rect.minY), maxX: Math.max(a.rect.maxX, b.rect.maxX), maxY: Math.max(a.rect.maxY, b.rect.maxY), inner: a.rect.inner + b.rect.inner + 1, innerRects: a.rect.innerRects + b.rect.innerRects, arcs: a.rect.arcs + b.rect.arcs, width: a.rect.width, dashed: false };
        const w = r.maxX - r.minX;
        const h = r.maxY - r.minY;
        const cx = (r.minX + r.maxX) / 2;
        const cy = (r.minY + r.maxY) / 2;
        const merged: Cand = { rect: r, room, cx, cy, w, h, L: Math.max(w, h), S: Math.min(w, h), longX: w >= h, touch: { top: a.touch.top || b.touch.top, bottom: a.touch.bottom || b.touch.bottom, left: a.touch.left || b.touch.left, right: a.touch.right || b.touch.right }, note: '2 つを結合' };
        // 端の接触は結合後の端で見直す
        merged.touch = {
          top: edgeDist(room, { x: cx, y: r.minY }) <= TOUCH,
          bottom: edgeDist(room, { x: cx, y: r.maxY }) <= TOUCH,
          left: edgeDist(room, { x: r.minX, y: cy }) <= TOUCH,
          right: edgeDist(room, { x: r.maxX, y: cy }) <= TOUCH,
        };
        cands.splice(j, 1);
        cands.splice(i, 1, merged);
        j = i;
      }
    }
    byRoom.set(room, cands);
  }

  const within = (v: number, lo: number, hi: number) => v >= lo && v <= hi;
  /** 長手の辺が壁に接している（壁沿いに置かれた家具） */
  const longAgainstWall = (c: Cand) => (c.longX ? c.touch.top || c.touch.bottom : c.touch.left || c.touch.right);
  /** 短手の端が壁に接している（ペニンシュラのように壁から突き出す） */
  const endAgainstWall = (c: Cand) => (c.longX ? c.touch.left || c.touch.right : c.touch.top || c.touch.bottom);
  const anyWall = (c: Cand) => c.touch.top || c.touch.bottom || c.touch.left || c.touch.right;
  /** 2 つの長方形が平行に並ぶ（長手が同じ向き、長手方向の重なりが半分以上）ときの、間の隙間（mm） */
  const parallelGap = (a: Cand, b: Cand): number | null => {
    if (a.longX !== b.longX) return null;
    if (a.longX) {
      const overlap = Math.min(a.rect.maxX, b.rect.maxX) - Math.max(a.rect.minX, b.rect.minX);
      if (overlap < Math.min(a.w, b.w) * 0.5) return null;
      return Math.max(a.rect.minY - b.rect.maxY, b.rect.minY - a.rect.maxY);
    }
    const overlap = Math.min(a.rect.maxY, b.rect.maxY) - Math.max(a.rect.minY, b.rect.minY);
    if (overlap < Math.min(a.h, b.h) * 0.5) return null;
    return Math.max(a.rect.minX - b.rect.maxX, b.rect.minX - a.rect.maxX);
  };
  const contains = (a: Cand, b: Cand) => b.rect.minX >= a.rect.minX - EPS && b.rect.maxX <= a.rect.maxX + EPS && b.rect.minY >= a.rect.minY - EPS && b.rect.maxY <= a.rect.maxY + EPS;

  // ---- 向き・位置を FurnitureItem に変換 ----
  const roomOf = (c: Cand) => c.room;
  /** 長方形の「壁側」の向き: 接している辺（複数なら部屋の中心から遠い方）。接していなければ部屋の中心から遠い辺 */
  const wallSideOf = (c: Cand, alongLong: boolean): { along: Vec2; inward: Vec2; back: number } => {
    const bb = roomBBox(c.room);
    const rcx = (bb.minX + bb.maxX) / 2;
    const rcy = (bb.minY + bb.maxY) / 2;
    // 候補の向き（inward = 壁から部屋へ）
    const opts: { inward: Vec2; touch: boolean; far: number }[] = [
      { inward: { x: 0, y: 1 }, touch: c.touch.top, far: rcy - c.cy },
      { inward: { x: 0, y: -1 }, touch: c.touch.bottom, far: c.cy - rcy },
      { inward: { x: 1, y: 0 }, touch: c.touch.left, far: rcx - c.cx },
      { inward: { x: -1, y: 0 }, touch: c.touch.right, far: c.cx - rcx },
    ].filter((o) => (alongLong ? (c.longX ? o.inward.y !== 0 : o.inward.x !== 0) : c.longX ? o.inward.x !== 0 : o.inward.y !== 0));
    opts.sort((a, b) => Number(b.touch) - Number(a.touch) || b.far - a.far);
    const inward = opts[0].inward;
    // along は inward を −90° 回した向き（inward = along を +90° 回した向き、という決まり）
    const along = { x: inward.y, y: -inward.x };
    const back = alongLong ? c.S / 2 : c.L / 2;
    return { along, inward, back };
  };
  /** 判定した長方形と大きく重なる他の候補（結合前の断片・内側の飾り線）は使わない */
  const consume = (c: Cand) => {
    const cands = byRoom.get(c.room) ?? [];
    for (const o of cands) {
      if (o === c || o.kind) continue;
      const ix = Math.max(0, Math.min(o.rect.maxX, c.rect.maxX) - Math.max(o.rect.minX, c.rect.minX));
      const iy = Math.max(0, Math.min(o.rect.maxY, c.rect.maxY) - Math.max(o.rect.minY, c.rect.minY));
      if (ix * iy >= o.w * o.h * 0.6) o.kind = 'consumed' as FurnitureKind;
    }
  };
  const push = (c: Cand, kind: FurnitureKind, extra: Partial<FurnitureItem> = {}, alongLong = true) => {
    consume(c);
    const { along, inward, back } = wallSideOf(c, alongLong);
    const origin = { x: c.cx - inward.x * back, y: c.cy - inward.y * back };
    let rot = Math.atan2(along.y, along.x) * DEG;
    rot = Math.round(((rot % 360) + 360) % 360);
    const it: FurnitureItem = { id: id(), kind, x: Math.round(origin.x), y: Math.round(origin.y), rot, roomId: roomOf(c).id, ...extra };
    items.push(it);
    c.kind = kind;
    trace?.push(`${kind} ${Math.round(c.w)}x${Math.round(c.h)} @${Math.round(c.cx)},${Math.round(c.cy)} in ${c.room.name} (${c.note ?? ''})`);
    return it;
  };

  for (const [room, cands] of byRoom) {
    const t = room.type;
    const used = new Set<Cand>();
    // 記号辞書（修正画面で覚えた答え）: 同じ形（部屋の種類・大きさ・中身）に答えがあれば規則より優先
    const applyDict = (c: Cand, hit: FurnitureKind, note: string) => {
      c.note = note;
      used.add(c);
      if (hit === 'kitchen') pushKitchen(c, cands, used);
      else if (hit === 'bed') pushBed(c);
      else if (hit === 'rug') push(c, 'rug', { w: +(c.L / 1000).toFixed(2), d: +(c.S / 1000).toFixed(2) });
      else push(c, hit, { w: +(c.L / 1000).toFixed(2) });
    };
    for (const c of cands) {
      const hit = dict ? lookupSymbol(dict, signatureOf(t, c.w, c.h, c.rect.inner), 'user') : null;
      if (hit) applyDict(c, hit, '辞書');
    }
    const free = () => cands.filter((c) => !used.has(c) && !c.kind);
    const livingLike = t === 'ldk' || t === 'living' || t === 'dining' || t === 'kitchen' || t === 'japanese' || (t === 'other' && Math.abs(polygonArea(room.polygon)) >= 8e6);
    if (livingLike) {
      // --- キッチン: 奥行 550〜1,100・長さ 1,600〜3,400 のカウンター ---
      // 長い壁一面の収納カウンター（8m 超）やシンク＋コンロ＋作業台を一直線に並べた長いアイランド（5〜6m）もある
      const counters = free().filter((c) => within(c.S, 550, 1100) && within(c.L, 1600, 9000) && c.rect.innerRects <= 8);
      // 壁沿いの浅いカウンター（550〜700）と、その前に平行な深いカウンター（650〜1,100）の組 → 対面キッチン
      let kitchenDone = false;
      if (t !== 'japanese' && t !== 'other') {
        for (const back of counters.filter((c) => longAgainstWall(c) && c.S <= 760)) {
          const front = counters.find((c) => c !== back && !longAgainstWall(c) && c.S >= 600 && (parallelGap(back, c) ?? -1) >= 600 && (parallelGap(back, c) ?? 9e9) <= 1600);
          if (!front) continue;
          // どちらにシンク・コンロの丸い記号があるか、手前に椅子が並ぶか、で型を決める
          const frontRings = ringsIn(front.rect).length;
          const backRings = ringsIn(back.rect).length;
          // シンクは丸い排水口の輪か、線の多い長方形（水栓・槽の線）で描かれる
          const frontSink = frontRings >= 1 || front.rect.inner >= 8;
          const frontChairs = dinnerChairs(front, cands).length + ringsIn(front.rect, 700).filter((g) => Math.max(g.maxX - g.minX, g.maxY - g.minY) >= 300 && !(((g.minX + g.maxX) / 2 > front.rect.minX && (g.minX + g.maxX) / 2 < front.rect.maxX && (g.minY + g.maxY) / 2 > front.rect.minY && (g.minY + g.maxY) / 2 < front.rect.maxY))).length;
          used.add(back);
          used.add(front);
          if (frontChairs >= 2 && frontRings === 0) {
            // 壁付けキッチン ＋ その前の食卓
            back.note = `壁付け（手前は食卓・椅子 ${frontChairs}）`;
            pushKitchen(back, cands, used);
            front.note = `椅子 ${frontChairs}`;
            push(front, 'dining', { w: +(Math.min(front.L, 2600) / 1000).toFixed(2) });
          } else if (backRings >= 1 && !frontSink) {
            // 壁付けキッチン ＋ 手前のカウンター（食卓）
            back.note = `壁付け（丸い記号 ${backRings}）`;
            pushKitchen(back, cands, used);
            if (front.S >= 750) {
              front.note = 'キッチン前のカウンター';
              push(front, 'dining', { w: +(Math.min(front.L, 2600) / 1000).toFixed(2) });
            }
          } else {
            const two = backRings >= 1 && frontSink;
            back.note = two ? 'Ⅱ型の壁側（コンロ）' : 'カップボード（対面の背面）';
            front.note = two ? 'Ⅱ型のシンク側' : endAgainstWall(front) ? 'ペニンシュラ' : 'アイランド';
            pushKitchen(front, cands, used, back, two);
          }
          kitchenDone = true;
          break;
        }
        if (!kitchenDone) {
          // 壁から突き出す深いカウンター（ペニンシュラ）か、壁沿いのカウンター 1 本（壁付け I 型）
          const pen = counters.find((c) => !longAgainstWall(c) && endAgainstWall(c) && c.S >= 650 && (ringsIn(c.rect).length > 0 || c.rect.innerRects > 0 || t === 'kitchen' || t === 'ldk'));
          const wallK = counters.find((c) => longAgainstWall(c) && (ringsIn(c.rect).length > 0 || c.rect.inner >= 6 || c.rect.innerRects > 0 || t === 'kitchen'));
          if (pen) {
            pen.note = 'ペニンシュラ';
            used.add(pen);
            pushKitchen(pen, cands, used);
            kitchenDone = true;
          } else if (wallK) {
            wallK.note = '壁付け I 型';
            used.add(wallK);
            pushKitchen(wallK, cands, used);
            kitchenDone = true;
          }
        }
      }
      const sofasL: Cand[] = [];
      // --- ラグ: 大きな細線の長方形で、中に他の家具が入る ---
      for (const c of free()) {
        if (!(within(c.S, 1300, 3200) && within(c.L, 1800, 4200))) continue;
        const inside = free().filter((o) => o !== c && contains(c, o) && o.L >= 600);
        if (inside.length >= 1 && !anyWall(c)) {
          c.note = `中に ${inside.length}`;
          used.add(c);
          push(c, 'rug', { w: +(c.L / 1000).toFixed(2), d: +(c.S / 1000).toFixed(2) });
        }
      }
      // --- L 字の折れ線（L 型ソファ）: 外形 1,600〜3,600 ---
      for (const c of free()) {
        if (!c.rect.lshape || !within(c.L, 1600, 3800) || !within(c.S, 1200, 3600)) continue;
        c.note = 'L 字の折れ線';
        used.add(c);
        push(c, 'sofa', { w: +(c.L / 1000).toFixed(2) });
        sofasL.push(c);
      }
      // --- ソファ: 奥行 750〜1,100・長さ 1,500〜3,400。壁沿い、または L 字（2 本が角を共有） ---
      const sofaish = free().filter((c) => within(c.S, 700, 1150) && within(c.L, 1400, 3400) && !(within(c.S, 700, 1000) && within(c.L, 1200, 2400) && c.rect.innerRects === 0 && !longAgainstWall(c) && dinnerChairs(c, cands).length >= 2));
      const sofas: Cand[] = [...sofasL];
      for (const c of sofaish) {
        if (used.has(c)) continue;
        const leg = sofaish.find((o) => o !== c && !used.has(o) && o.longX !== c.longX && Math.abs(Math.min(Math.abs(o.rect.minX - c.rect.minX), Math.abs(o.rect.maxX - c.rect.maxX))) < EPS * 2 && Math.abs(Math.min(Math.abs(o.rect.minY - c.rect.minY), Math.abs(o.rect.maxY - c.rect.maxY))) < EPS * 2);
        if (leg) {
          // L 型: 長い方を本体に
          const main = c.L >= leg.L ? c : leg;
          main.note = 'L 型ソファ';
          used.add(c);
          used.add(leg);
          push(main, 'sofa', { w: +(main.L / 1000).toFixed(2) });
          sofas.push(main);
        } else if (longAgainstWall(c) || c.rect.innerRects >= 2 || tvFacing(c, cands)) {
          c.note = longAgainstWall(c) ? '壁沿い' : 'テレビ向き';
          used.add(c);
          push(c, 'sofa', { w: +(c.L / 1000).toFixed(2) });
          sofas.push(c);
        }
      }
      // --- テレビ台: 薄い長方形（奥行 300〜550・長さ 1,000〜2,400）が壁沿い。ソファが向いていれば確実 ---
      for (const c of free()) {
        if (!(within(c.S, 300, 560) && within(c.L, 1000, 2400) && longAgainstWall(c))) continue;
        const facing = sofas.some((s) => s.longX === c.longX && (parallelGap(s, c) ?? 9e9) <= 4500);
        if (facing || (t === 'living' || t === 'ldk') && free().filter((o) => within(o.S, 300, 560) && within(o.L, 1000, 2400) && longAgainstWall(o)).length === 1) {
          c.note = facing ? 'ソファの正面' : '壁沿いの薄い台';
          used.add(c);
          push(c, 'tv', { w: +(c.L / 1000).toFixed(2) });
        }
      }
      // --- 食卓: 奥行 700〜1,100・長さ 1,200〜2,400。椅子（350〜600 角）が周りにある。丸テーブルは円 ---
      for (const c of free()) {
        if (!(within(c.S, 700, 1100) && within(c.L, 1200, 2600))) continue;
        const chairs = dinnerChairs(c, cands);
        // 椅子を丸い線で描く図面: テーブルの周り（辺から 700mm 以内）の円弧の数
        const chairArcs = arcs.filter((a) => a.p0.x > c.rect.minX - 700 && a.p0.x < c.rect.maxX + 700 && a.p0.y > c.rect.minY - 700 && a.p0.y < c.rect.maxY + 700).length + ringsIn(c.rect, 700).filter((g) => Math.max(g.maxX - g.minX, g.maxY - g.minY) >= 300 && !((g.minX + g.maxX) / 2 > c.rect.minX && (g.minX + g.maxX) / 2 < c.rect.maxX && (g.minY + g.maxY) / 2 > c.rect.minY && (g.minY + g.maxY) / 2 < c.rect.maxY)).length * 4;
        if (chairs.length >= 2 || chairArcs >= 4 || (t === 'dining' && !longAgainstWall(c)) || (!longAgainstWall(c) && c.rect.innerRects === 0 && !anyWall(c) && t !== 'japanese')) {
          c.note = `椅子 ${chairs.length}・弧 ${chairArcs}`;
          used.add(c);
          chairs.forEach((ch) => used.add(ch));
          push(c, t === 'japanese' ? 'lowTable' : 'dining', { w: +(c.L / 1000).toFixed(2) });
        }
      }
      for (const ci of circles) {
        if (!pointInPolygon({ x: ci.x, y: ci.y }, room.polygon) || t === 'japanese') continue;
        if (items.some((it) => it.roomId === room.id && it.kind === 'dining')) continue;
        if (ci.r < 450 || ci.r > 800) continue;
        const bb = roomBBox(room);
        const fake: Cand = { rect: { id: -1, minX: ci.x - ci.r, maxX: ci.x + ci.r, minY: ci.y - ci.r, maxY: ci.y + ci.r, inner: 0, innerRects: 0, arcs: 0, width: 0, dashed: false }, room, cx: ci.x, cy: ci.y, w: ci.r * 2, h: ci.r * 2, L: ci.r * 2, S: ci.r * 2, longX: bb.maxX - bb.minX >= bb.maxY - bb.minY, touch: { top: false, bottom: false, left: false, right: false }, note: '丸テーブル' };
        push(fake, 'dining', { w: +((ci.r * 2) / 1000).toFixed(2) });
      }
      // --- 机・お化粧スペース: 壁沿いの 1,100〜1,700 × 550〜900 のカウンターに椅子が 1 脚 ---
      for (const c of free()) {
        if (!(within(c.S, 550, 900) && within(c.L, 1100, 1700) && longAgainstWall(c))) continue;
        const chairs = dinnerChairs(c, cands).length + ringsIn(c.rect, 600).filter((g) => Math.max(g.maxX - g.minX, g.maxY - g.minY) >= 300 && !((g.minX + g.maxX) / 2 > c.rect.minX && (g.minX + g.maxX) / 2 < c.rect.maxX && (g.minY + g.maxY) / 2 > c.rect.minY && (g.minY + g.maxY) / 2 < c.rect.maxY)).length;
        if (chairs === 1) {
          c.note = '壁沿いのカウンターに椅子 1 脚';
          used.add(c);
          push(c, 'desk', { w: +(c.L / 1000).toFixed(2) });
        }
      }
      // --- 丸いローテーブル: ソファのそばの直径 600〜1,100 の輪 ---
      for (const g of findLoops(segs, 600, 1100, 400)) {
        const gc = { x: (g.minX + g.maxX) / 2, y: (g.minY + g.maxY) / 2 };
        if (!pointInPolygon(gc, room.polygon)) continue;
        const nearSofa = sofas.some((sf) => Math.hypot(sf.cx - gc.x, sf.cy - gc.y) < 2600) || prior.some((p) => p.kind === 'sofa' && p.roomId === room.id && Math.hypot(p.x - gc.x, p.y - gc.y) < 2600);
        if (!nearSofa || items.some((it) => it.roomId === room.id && it.kind === 'coffeeTable')) continue;
        const dia = Math.max(g.maxX - g.minX, g.maxY - g.minY);
        const bb = roomBBox(room);
        const fake: Cand = { rect: { id: -1, minX: g.minX, maxX: g.maxX, minY: g.minY, maxY: g.maxY, inner: 0, innerRects: 0, arcs: 0, width: 0, dashed: false }, room, cx: gc.x, cy: gc.y, w: dia, h: dia, L: dia, S: dia, longX: bb.maxX - bb.minX >= bb.maxY - bb.minY, touch: { top: false, bottom: false, left: false, right: false }, note: '丸テーブル（ソファのそば）' };
        push(fake, 'coffeeTable', { w: +(dia / 1000).toFixed(2) });
      }
      // --- ローテーブル: ソファの前の 400〜700 × 700〜1,300、または L 型ソファの内側の 700〜1,100 角 ---
      for (const c of free()) {
        const squareish = within(c.S, 700, 1100) && within(c.L, 700, 1200);
        if (!(within(c.S, 380, 720) && within(c.L, 700, 1400)) && !squareish) continue;
        // 中に線の多い四角（階段・植栽の鉢・設備）はテーブルではない
        if (c.rect.inner > 2) continue;
        const near = sofas.find((s) => Math.hypot(s.cx - c.cx, s.cy - c.cy) < (s.rect.lshape ? 2600 : 2200) && (s.rect.lshape || (parallelGap(s, c) ?? -1) >= 200));
        // 形の決め打ちで読めたソファ（曲線の多い詳細な記号）の近くでも
        const nearPrior = !near && prior.some((p) => p.kind === 'sofa' && p.roomId === room.id && Math.hypot(p.x - c.cx, p.y - c.cy) < 2600);
        if (near || nearPrior) {
          c.note = 'ソファの前';
          used.add(c);
          push(c, 'coffeeTable', { w: +(c.L / 1000).toFixed(2) });
        }
      }
    }
    if (t === 'bedroom' || t === 'kids' || t === 'study' || t === 'japanese' || t === 'other') {
      for (const c of free()) {
        if (within(c.S, 850, 1900) && within(c.L, 1850, 2250) && (t !== 'other' || c.rect.innerRects >= 1)) {
          c.note = c.rect.innerRects ? `枕 ${c.rect.innerRects}` : 'ベッド';
          used.add(c);
          pushBed(c);
        }
      }
      for (const c of free()) {
        if (within(c.S, 450, 800) && within(c.L, 900, 1800) && longAgainstWall(c) && (t === 'study' || t === 'kids' || t === 'bedroom')) {
          c.note = '壁沿いの机';
          used.add(c);
          push(c, 'desk', { w: +(c.L / 1000).toFixed(2) });
        }
      }
    }
    if (t === 'washroom') {
      for (const c of free()) {
        if (within(c.S, 420, 700) && within(c.L, 700, 1700) && longAgainstWall(c)) {
          c.note = '壁沿いの洗面台';
          used.add(c);
          push(c, 'washstand', { w: +(c.L / 1000).toFixed(2) });
        } else if (within(c.S, 520, 720) && within(c.L, 520, 760) && anyWall(c)) {
          c.note = '洗濯機';
          used.add(c);
          push(c, 'washer');
        }
      }
    }
    if (t === 'bath') {
      for (const c of free()) {
        if (within(c.S, 620, 900) && within(c.L, 1250, 1850)) {
          c.note = '浴槽';
          used.add(c);
          push(c, 'bath', { len: +(c.L / 1000).toFixed(2) });
          break;
        }
      }
    }
    if (t === 'toilet' || t === 'washroom') {
      for (const c of free()) {
        if (within(c.S, 340, 540) && within(c.L, 580, 900) && (t === 'toilet' || c.rect.arcs > 0)) {
          c.note = '便器';
          used.add(c);
          push(c, 'toilet', {}, false);
          break;
        }
      }
    }
    if (t === 'entrance') {
      for (const c of free()) {
        if (within(c.S, 280, 480) && within(c.L, 700, 2400) && longAgainstWall(c)) {
          c.note = '壁沿いの靴箱';
          used.add(c);
          push(c, 'shoeCabinet', { w: +(c.L / 1000).toFixed(2) });
        }
      }
    }
    if (t === 'hall' || t === 'toilet') {
      // ホールの手洗い・洗面（ボウルの線が入った壁沿いの小さなカウンター）
      for (const c of free()) {
        if (within(c.S, 380, 650) && within(c.L, 600, 1300) && longAgainstWall(c) && (c.rect.inner >= 3 || c.rect.arcs >= 1)) {
          c.note = '手洗い';
          used.add(c);
          push(c, 'washstand', { w: +(c.L / 1000).toFixed(2) });
        }
      }
    }
    // 規則で決まらなかった候補は、一括学習・初期辞書（御社の過去プランで同じ形がいつも同じ答えだったもの）で埋める
    if (dict) {
      for (const c of free()) {
        const hit = lookupSymbol(dict, signatureOf(t, c.w, c.h, c.rect.inner), 'fallback');
        if (hit) applyDict(c, hit, '辞書（過去の図面）');
      }
    }
    for (const c of cands) candidates.push({ id: c.rect.id, cx: Math.round(c.cx), cy: Math.round(c.cy), w: Math.round(c.w), h: Math.round(c.h), inner: c.rect.inner, arcs: ringsIn(c.rect).length, roomId: room.id, kind: (c.kind as string) === 'consumed' ? undefined : c.kind });
  }
  return { items, candidates, trace };

  /** 食卓の周りの椅子（350〜600 角の小さな長方形が、テーブルの辺から 350mm 以内） */
  function dinnerChairs(table: Cand, cands: Cand[]): Cand[] {
    return cands.filter((o) => o !== table && within(o.S, 300, 620) && within(o.L, 300, 700) && o.rect.minX > table.rect.minX - 700 && o.rect.maxX < table.rect.maxX + 700 && o.rect.minY > table.rect.minY - 700 && o.rect.maxY < table.rect.maxY + 700 && !contains(table, o));
  }
  /** ソファ候補の正面（平行・1.5〜4.5m）に薄い長方形（テレビ台）があるか */
  function tvFacing(sofa: Cand, cands: Cand[]): boolean {
    return cands.some((o) => o !== sofa && within(o.S, 300, 560) && within(o.L, 1000, 2400) && o.longX === sofa.longX && (parallelGap(sofa, o) ?? 9e9) <= 4500 && longAgainstWall(o));
  }
  /** ベッド: 頭側は枕（中の小さな長方形）のある端、無ければ壁に接する端 */
  function pushBed(c: Cand) {
    const long = c.longX ? { x: 1, y: 0 } : { x: 0, y: 1 };
    let head: Vec2 | null = null;
    const pillows = rects.filter((o) => o !== c.rect && o.minX >= c.rect.minX - EPS && o.maxX <= c.rect.maxX + EPS && o.minY >= c.rect.minY - EPS && o.maxY <= c.rect.maxY + EPS && Math.max(o.maxX - o.minX, o.maxY - o.minY) < c.L * 0.6);
    if (pillows.length) {
      const p = pillows[0];
      const pc = { x: (p.minX + p.maxX) / 2, y: (p.minY + p.maxY) / 2 };
      const s = (pc.x - c.cx) * long.x + (pc.y - c.cy) * long.y;
      head = s >= 0 ? long : { x: -long.x, y: -long.y };
    } else {
      const endA = c.longX ? c.touch.left : c.touch.top;
      const endB = c.longX ? c.touch.right : c.touch.bottom;
      if (endA && !endB) head = { x: -long.x, y: -long.y };
      else if (endB && !endA) head = long;
      else {
        const bb = roomBBox(c.room);
        const rc = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
        const s = (rc.x - c.cx) * long.x + (rc.y - c.cy) * long.y;
        head = s >= 0 ? { x: -long.x, y: -long.y } : long;
      }
    }
    const inward = { x: -head.x, y: -head.y };
    const along = { x: inward.y, y: -inward.x };
    const origin = { x: c.cx - inward.x * (c.L / 2), y: c.cy - inward.y * (c.L / 2) };
    const rot = Math.round((((Math.atan2(along.y, along.x) * DEG) % 360) + 360) % 360);
    items.push({ id: id(), kind: 'bed', x: Math.round(origin.x), y: Math.round(origin.y), rot, roomId: c.room.id, w: +(c.S / 1000).toFixed(2) });
    c.kind = 'bed';
    consume(c);
    trace.push(`bed ${Math.round(c.w)}x${Math.round(c.h)} @${Math.round(c.cx)},${Math.round(c.cy)} in ${c.room.name} (${c.note ?? ''})`);
  }
  /**
   * キッチン: カウンターの長手が並び方向。壁付けは壁側が背、対面は背面収納（back）か壁から離れた側がダイニング側。
   * コンロは円弧（コンロの輪）のある側、無ければ壁から遠い側
   */
  function pushKitchen(c: Cand, cands: Cand[], used: Set<Cand>, back?: Cand, twoType = false) {
    const along0 = c.longX ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const bb = roomBBox(c.room);
    const rc = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
    const pn = { x: -along0.y, y: along0.x };
    let inward: Vec2;
    let type: FurnitureItem['kitchenType'];
    let d: number | undefined;
    let origin: Vec2;
    const burnersOnBack = twoType;
    if (longAgainstWall(c) && !back) {
      // 壁付け I 型: 壁に接している長手の辺が背
      const side = (c.longX ? (c.touch.top ? 1 : -1) : c.touch.left ? 1 : -1);
      inward = { x: pn.x * side, y: pn.y * side };
      type = 'wall';
      origin = { x: c.cx - inward.x * (c.S / 2), y: c.cy - inward.y * (c.S / 2) };
    } else {
      // 対面: 背面収納（または壁）のある側が背、反対がダイニング側
      const toBack = back ? { x: back.cx - c.cx, y: back.cy - c.cy } : { x: c.cx - rc.x, y: c.cy - rc.y };
      const s = toBack.x * pn.x + toBack.y * pn.y;
      const backDir = s >= 0 ? pn : { x: -pn.x, y: -pn.y };
      inward = { x: -backDir.x, y: -backDir.y };
      type = burnersOnBack ? 'two' : endAgainstWall(c) ? 'peninsula' : 'island';
      // 背の壁の内側の面（カウンター中心から背側へ、壁に当たるまで）
      let dist = 1500;
      for (let tt = 400; tt <= 3200; tt += 50) {
        const p = { x: c.cx + backDir.x * tt, y: c.cy + backDir.y * tt };
        if (walls.some((w) => distPointSegment(p, w.a, w.b) < wallHalf + 20)) {
          dist = tt - wallHalf;
          break;
        }
      }
      d = +(dist / 1000).toFixed(2);
      origin = { x: c.cx + backDir.x * dist, y: c.cy + backDir.y * dist };
    }
    // along は inward を −90° 回した向き
    let along = { x: inward.y, y: -inward.x };
    // コンロ側: 丸い記号（コンロの輪）が集まっている側。Ⅱ型は壁側のカウンターの輪で見る。無ければ壁沿いで空きの多い側
    const ringSrc = twoType && back ? back : c;
    let stoveSign = 0;
    for (const g of ringsIn(ringSrc.rect)) {
      if (Math.max(g.maxX - g.minX, g.maxY - g.minY) > 320) continue;
      stoveSign += Math.sign(((g.minX + g.maxX) / 2 - ringSrc.cx) * along.x + ((g.minY + g.maxY) / 2 - ringSrc.cy) * along.y);
    }
    if (stoveSign === 0) {
      const endPlus = { x: c.cx + along.x * (c.L / 2 + 600), y: c.cy + along.y * (c.L / 2 + 600) };
      const endMinus = { x: c.cx - along.x * (c.L / 2 + 600), y: c.cy - along.y * (c.L / 2 + 600) };
      stoveSign = edgeDist(c.room, endPlus) >= edgeDist(c.room, endMinus) ? 1 : -1;
    }
    const stoveSide: 'left' | 'right' = stoveSign > 0 ? 'right' : 'left';
    const rot = Math.round((((Math.atan2(along.y, along.x) * DEG) % 360) + 360) % 360);
    const len = +Math.min(3.4, Math.max(2.3, (c.L + 500) / 1000)).toFixed(2);
    items.push({ id: id(), kind: 'kitchen', x: Math.round(origin.x), y: Math.round(origin.y), rot, roomId: c.room.id, len, kitchenType: type, stoveSide, fridge: 'none', d });
    c.kind = 'kitchen';
    consume(c);
    if (back) {
      back.kind = 'cupboard';
      consume(back);
    }
    trace.push(`kitchen(${type}) ${Math.round(c.w)}x${Math.round(c.h)} @${Math.round(c.cx)},${Math.round(c.cy)} in ${c.room.name} (${c.note ?? ''}) stove=${stoveSide}`);
    void cands;
    void used;
    void along;
  }
}
