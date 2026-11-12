/**
 * 図面の「記号」を読む: 家具・設備・車・植栽
 *
 * CAD（ARCHITREND など）の平面図は、家具や設備を細い線のまとまり（部品）で描く。
 * 端点がつながる線をひとまとめにし、大きさ・線の数・形（丸み・直線）・置かれた部屋から種類を判定する。
 *   車 4.8×2.2m / 食卓椅子 0.5×0.55（曲線が多い） / ベッド 1.0〜1.7×2.0 / 便器 0.4×0.7 / 浴槽 1.4×0.7
 *   洗面ボウル 0.7×0.4（D 形） / キッチンのシンク 0.5×0.6 ＋ コンロの輪（0.29×0.06 の弧） / 植栽（ぎざぎざの丸）
 * 認識した家具は自動配置より優先して、図面どおりの位置・向きに置く。
 */
import { OUTDOOR_TYPES, type FurnitureItem, type FurnitureKind, type Room, type RoomType, type Vec2, type Wall } from '../core/types';
import { distPointSegment, pointInPolygon } from '../core/geometry';
import type { Seg } from './walls';
import type { MmText } from './assemble';

export type SymbolKind = 'car' | 'chair' | 'chairBack' | 'sofaModule' | 'sofa' | 'bed' | 'toilet' | 'bath' | 'sink' | 'counter' | 'plant' | 'xbox';

export interface PlanSymbol {
  kind: SymbolKind;
  /** 中心 (mm) */
  x: number;
  y: number;
  /** 外形 (mm)。rot があるときは、その角度だけ回した向きでの外形 */
  w: number;
  h: number;
  /** 線の数 */
  n: number;
  /** いちばん長い直線（洗面の平らな側・ベッドの頭側の判定に使う） */
  flat?: { a: Vec2; b: Vec2 };
  /** 判定の参考値（でこぼこ・短い線の割合・最長の直線 mm） */
  bump?: number;
  shortFrac?: number;
  longLen?: number;
  /** 軸から回して置かれた記号の角度（rad、-45°〜45°）。45° の LDK の食卓・キッチンなど */
  rot?: number;
  /** L 字の記号（L 型ソファ）: 空いている角（記号を軸に戻した向きで、x: 幅方向の ±1、y: 高さ方向の ±1） */
  lEmpty?: { x: 1 | -1; y: 1 | -1 };
  /** ソファの背の側（記号の中心から見た向きの単位ベクトル）。背のクッションを丸く描く記号で、丸い線の集まっている側 */
  back?: Vec2;
}

/** 線のまとまりの主方向（長さ加重・90° 周期）。-45°〜45° の rad */
function dominantAngle(segs: Seg[]): number {
  let sx = 0;
  let sy = 0;
  for (const s of segs) {
    const dx = s.b.x - s.a.x;
    const dy = s.b.y - s.a.y;
    const L = Math.hypot(dx, dy);
    if (L < 20) continue;
    const a = Math.atan2(dy, dx) * 4;
    sx += L * Math.cos(a);
    sy += L * Math.sin(a);
  }
  return Math.atan2(sy, sx) / 4;
}

function rotPt(p: Vec2, c: Vec2, ang: number): Vec2 {
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs };
}

function bboxCluster(segs: Seg[]): Cluster {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segs)
    for (const q of [s.a, s.b]) {
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
    }
  return { segs, minX, minY, maxX, maxY };
}

/**
 * L 字の記号か: 外接の箱の四隅（1/4 の大きさの升）のうち、ちょうど 1 つに線が無い（L 型ソファの空いた角）。
 * 長方形の外形は四隅すべてを線が通る。空いている角を返す
 */
function lShapeOf(c: Cluster): { x: 1 | -1; y: 1 | -1 } | null {
  const w = c.maxX - c.minX;
  const h = c.maxY - c.minY;
  const corner = [0, 0, 0, 0];
  let total = 0;
  for (const s of c.segs) {
    const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    total += L;
    const mx = (s.a.x + s.b.x) / 2;
    const my = (s.a.y + s.b.y) / 2;
    const ix = mx < c.minX + w / 4 ? 0 : mx > c.maxX - w / 4 ? 1 : -1;
    const iy = my < c.minY + h / 4 ? 0 : my > c.maxY - h / 4 ? 1 : -1;
    if (ix < 0 || iy < 0) continue;
    corner[ix + iy * 2] += L;
  }
  if (total <= 0) return null;
  const empty = corner.map((v, i) => ({ v, i })).filter((o) => o.v < total * 0.015);
  if (empty.length !== 1) return null;
  if (corner.filter((v) => v >= total * 0.05).length !== 3) return null;
  const i = empty[0].i;
  return { x: i % 2 === 0 ? -1 : 1, y: i < 2 ? -1 : 1 };
}

interface Cluster {
  segs: Seg[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 端点のつながる細い線をまとめる */
export function clusterSegments(segs: Seg[], maxLen = 2500, minN = 12): Cluster[] {
  const hatch = hatchSegments(segs);
  const use = segs.filter((s) => s.source !== 'fill' && !s.dashed && !hatch.has(s) && Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) < maxLen);
  // 端点が 4mm 以内なら同じまとまり。升目のハッシュは隣の升目も見る（升目の境目をまたぐ 1mm の隙間で、
  // 丸い角の折れ線とまっすぐな辺が別のまとまりになり、L 型ソファの外形が途中で切れていた）
  const CELL = 4;
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  const parent = use.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const at = new Map<string, { i: number; q: Vec2 }[]>();
  use.forEach((s, i) => {
    for (const q of [s.a, s.b]) {
      const cx = Math.round(q.x / CELL);
      const cy = Math.round(q.y / CELL);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          for (const e of at.get(key(cx + dx, cy + dy)) ?? []) {
            if (Math.abs(e.q.x - q.x) > CELL || Math.abs(e.q.y - q.y) > CELL) continue;
            const ri = find(i);
            const rj = find(e.i);
            if (ri !== rj) parent[ri] = rj;
          }
        }
      const k = key(cx, cy);
      if (!at.has(k)) at.set(k, []);
      at.get(k)!.push({ i, q });
    }
  });
  const groups = new Map<number, Seg[]>();
  use.forEach((s, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(s);
  });
  const out: Cluster[] = [];
  for (const g of groups.values()) {
    if (g.length < minN) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of g) {
      for (const q of [s.a, s.b]) {
        if (q.x < minX) minX = q.x;
        if (q.x > maxX) maxX = q.x;
        if (q.y < minY) minY = q.y;
        if (q.y > maxY) maxY = q.y;
      }
    }
    out.push({ segs: g, minX, minY, maxX, maxY });
  }
  return out;
}

const within = (v: number, lo: number, hi: number) => v >= lo && v <= hi;

/**
 * 車の記号が端点を共有しない何枚かの部品（ボディ・ボンネット・キャビン・後部）で描かれている図面:
 * 大きめの部品（長さ 2.5m 以上）を種に、重なる部品をまとめて車の大きさになれば 1 つの記号にする
 */
function assembleCars(clusters: Cluster[]): Cluster[] {
  const L = (c: Cluster) => Math.max(c.maxX - c.minX, c.maxY - c.minY);
  const S = (c: Cluster) => Math.min(c.maxX - c.minX, c.maxY - c.minY);
  // 丸みのある閉じた記号（椅子・ソファ）は車の部品ではない。
  // L 型ソファ（線 126 本）が車の種になって周りの食卓の椅子 3 脚を吸い込み、車の大きさに合わず全部捨てられていた
  const closed = (c: Cluster) => {
    const n = c.segs.length;
    const short = c.segs.filter((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) < 60).length / n;
    return (n >= 55 && short > 0.55 && L(c) <= 760) || (n >= 100 && short > 0.75);
  };
  const seeds = clusters.filter((c) => within(L(c), 2500, 5600) && within(S(c), 500, 2400) && c.segs.length >= 20 && !closed(c));
  if (!seeds.length) return clusters;
  const used = new Set<Cluster>();
  const out: Cluster[] = [];
  for (const seed of seeds) {
    if (used.has(seed)) continue;
    let cur: Cluster = { ...seed, segs: [...seed.segs] };
    const members = new Set<Cluster>([seed]);
    let grew = true;
    while (grew) {
      grew = false;
      // 種の長手方向に ±1.3m、短手方向に ±15cm 広げた箱に掛かる部品を集める（ボンネット・後部は重ならず前後に並ぶ）
      const longX = cur.maxX - cur.minX >= cur.maxY - cur.minY;
      const ex = longX ? 1300 : 150;
      const ey = longX ? 150 : 1300;
      for (const c of clusters) {
        if (members.has(c) || used.has(c) || closed(c)) continue;
        if (L(c) > 5600 || (S(c) < 150 && c.segs.length < 20)) continue;
        const ix = Math.min(cur.maxX + ex, c.maxX) - Math.max(cur.minX - ex, c.minX);
        const iy = Math.min(cur.maxY + ey, c.maxY) - Math.max(cur.minY - ey, c.minY);
        if (ix <= 0 || iy <= 0) continue;
        // 車の幅からはみ出す部品（隣の駐車枠の線など）は除く
        if (longX ? c.minY < cur.minY - ey || c.maxY > cur.maxY + ey : c.minX < cur.minX - ex || c.maxX > cur.maxX + ex) continue;
        const nx0 = Math.min(cur.minX, c.minX);
        const ny0 = Math.min(cur.minY, c.minY);
        const nx1 = Math.max(cur.maxX, c.maxX);
        const ny1 = Math.max(cur.maxY, c.maxY);
        if (Math.max(nx1 - nx0, ny1 - ny0) > 5600 || Math.min(nx1 - nx0, ny1 - ny0) > 2400) continue;
        cur = { segs: [...cur.segs, ...c.segs], minX: nx0, minY: ny0, maxX: nx1, maxY: ny1 };
        members.add(c);
        grew = true;
      }
    }
    if (members.size >= 2 && within(L(cur), 4300, 5600) && within(S(cur), 1600, 2400) && cur.segs.length >= 50) {
      for (const m of members) used.add(m);
      out.push(cur);
    }
  }
  if (!out.length) return clusters;
  return [...clusters.filter((c) => !used.has(c)), ...out];
}

/**
 * 点線で描いた丸（植栽）: 15mm 以下の点が 60mm 以内で連なり、中心からの距離がそろう輪（半径 0.25〜1.3m）。
 * 点どうしは端点がつながらないので clusterSegments では拾えない（吉田大仁様邸: 植栽 7 本のうち 1 本しか読めていなかった）
 */
export function dottedRings(segs: Seg[]): PlanSymbol[] {
  const len = (s: Seg) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  // 点 = 30mm 以下の短い線（1 つの点が小さな円・ひし形（数本の線）で描かれていることもある）
  const tiny = segs.filter((s) => s.source !== 'fill' && len(s) <= 30);
  if (tiny.length < 40) return [];
  /** 近いもの同士をまとめる（升目ハッシュ） */
  const group = (pts: Vec2[], tol: number): number[][] => {
    const parent = pts.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const cells = new Map<string, number[]>();
    const key = (p: Vec2) => `${Math.floor(p.x / tol)},${Math.floor(p.y / tol)}`;
    pts.forEach((p, i) => {
      const k = key(p);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k)!.push(i);
    });
    pts.forEach((p, i) => {
      const cx = Math.floor(p.x / tol);
      const cy = Math.floor(p.y / tol);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const j of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (j <= i || Math.hypot(pts[j].x - p.x, pts[j].y - p.y) > tol) continue;
            const ri = find(i);
            const rj = find(j);
            if (ri !== rj) parent[ri] = rj;
          }
    });
    const groups = new Map<number, number[]>();
    pts.forEach((_, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(i);
    });
    return [...groups.values()];
  };
  // 1. 短い線を 8mm 以内でまとめて「点」に（1 点 = 60mm 以下）
  const mids = tiny.map((s) => ({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }));
  const dots: Vec2[] = [];
  for (const g of group(mids, 8)) {
    const xs = g.map((i) => mids[i].x);
    const ys = g.map((i) => mids[i].y);
    if (Math.max(...xs) - Math.min(...xs) > 60 || Math.max(...ys) - Math.min(...ys) > 60) continue;
    dots.push({ x: xs.reduce((a, v) => a + v, 0) / g.length, y: ys.reduce((a, v) => a + v, 0) / g.length });
  }
  if (dots.length < 20) return [];
  const out: PlanSymbol[] = [];
  const taken = (p: Vec2) => out.some((s) => Math.hypot(s.x - p.x, s.y - p.y) < s.w / 2);
  /** 中心 c・半径 r の輪として、点が 16 個以上あり角度の抜けが 100° 以下か */
  const ringAt = (c: Vec2, members: number[], r: number) => {
    const angs = members.map((i) => Math.atan2(dots[i].y - c.y, dots[i].x - c.x)).sort((a, b) => a - b);
    if (angs.length < 16) return false;
    let gap = angs[0] + 2 * Math.PI - angs[angs.length - 1];
    for (let i = 1; i < angs.length; i++) gap = Math.max(gap, angs[i] - angs[i - 1]);
    return gap <= (100 * Math.PI) / 180 && r >= 250 && r <= 1300;
  };
  // 2. 中心の印（2〜8 個の点の固まり）から: 周りの点の距離が 1 つの半径にそろえば、その輪が植栽
  //    （隣り合う植栽の輪が触れていても、中心ごとに見るので分けられる）
  const centers = group(dots, 60).filter((g) => g.length >= 2 && g.length <= 8);
  for (const g of centers) {
    const c = { x: g.reduce((a, i) => a + dots[i].x, 0) / g.length, y: g.reduce((a, i) => a + dots[i].y, 0) / g.length };
    if (taken(c)) continue;
    const near = dots.map((p, i) => ({ i, r: Math.hypot(p.x - c.x, p.y - c.y) })).filter((o) => o.r > 150 && o.r <= 1400 && !g.includes(o.i));
    if (near.length < 16) continue;
    const bins = new Map<number, number[]>();
    for (const o of near) {
      const b = Math.round(o.r / 40);
      if (!bins.has(b)) bins.set(b, []);
      bins.get(b)!.push(o.i);
    }
    let best: { r: number; members: number[] } | null = null;
    for (const [b] of bins) {
      const members = [...(bins.get(b - 1) ?? []), ...(bins.get(b) ?? []), ...(bins.get(b + 1) ?? [])];
      if (!best || members.length > best.members.length) best = { r: b * 40, members };
    }
    if (!best || !ringAt(c, best.members, best.r)) continue;
    const r = best.members.reduce((a, i) => a + Math.hypot(dots[i].x - c.x, dots[i].y - c.y), 0) / best.members.length;
    out.push({ kind: 'plant', x: c.x, y: c.y, w: r * 2, h: r * 2, n: best.members.length, bump: 0.3, shortFrac: 1, longLen: 0 });
  }
  // 3. 中心の印の無い輪: 点を 140mm 以内でつないだ固まりが 1 つの輪になっていれば植栽
  for (const g of group(dots, 140)) {
    if (g.length < 20) continue;
    const cx = g.reduce((a, i) => a + dots[i].x, 0) / g.length;
    const cy = g.reduce((a, i) => a + dots[i].y, 0) / g.length;
    if (taken({ x: cx, y: cy })) continue;
    const rs = g.map((i) => Math.hypot(dots[i].x - cx, dots[i].y - cy)).sort((a, b) => a - b);
    const med = rs[Math.floor(rs.length / 2)];
    if (med < 250 || med > 1300) continue;
    // 輪: 8 割以上の点が中央値の ±12% に入る（四角や線は入らない。中心の数点は外れてよい）
    const onRing = rs.filter((r) => Math.abs(r - med) <= med * 0.12).length / rs.length;
    if (onRing < 0.8) continue;
    out.push({ kind: 'plant', x: cx, y: cy, w: med * 2, h: med * 2, n: g.length, bump: 0.3, shortFrac: 1, longLen: 0 });
  }
  return out;
}

/** 線のまとまりを記号として分類する（部屋の情報は使わず形だけで） */
export function detectSymbols(segs: Seg[]): PlanSymbol[] {
  const noDetailSofa = !!(globalThis as { __NO_DETAIL_SOFA?: boolean }).__NO_DETAIL_SOFA;
  // 線 3 本のまとまりも拾う（×印の小さな正方形の部品は、辺の 1 本がハッチ扱いで抜けて 3 本になることがある）
  const clusters = assembleCars(clusterSegments(segs, 3400, 3));
  const out: PlanSymbol[] = [];
  /** ×印の小さな正方形（洗濯機を 2×2 の部品で描いたもの） */
  const xparts: Cluster[] = [];
  for (const c0 of clusters) {
    // 45° などに回して置かれた記号（斜めの LDK の食卓・椅子・キッチン）は、軸に合わせて回してから形を見る
    // （外接の箱が √2 倍に膨らんで、どの形にも当てはまらなかった）
    let c = c0;
    let rot = 0;
    const pivot = { x: (c0.minX + c0.maxX) / 2, y: (c0.minY + c0.maxY) / 2 };
    {
      const dom = dominantAngle(c0.segs);
      if (Math.abs(dom) > (12 * Math.PI) / 180) {
        c = bboxCluster(c0.segs.map((s) => ({ ...s, a: rotPt(s.a, pivot, -dom), b: rotPt(s.b, pivot, -dom) })));
        rot = dom;
      }
    }
    const w = c.maxX - c.minX;
    const h = c.maxY - c.minY;
    const L = Math.max(w, h);
    const S = Math.min(w, h);
    if (L < 40 || L > 6000) continue;
    const n = c.segs.length;
    /** 回した向きでの中心を元の向きへ戻す */
    const centerOf = () => rotPt({ x: (c.minX + c.maxX) / 2, y: (c.minY + c.maxY) / 2 }, pivot, rot);
    const extra = rot ? { rot } : {};
    if (n < 12) {
      // ×印の入った正方形（0.55〜0.85m）: 洗濯機（脱衣室）・冷蔵庫（LDK のキッチン脇）。対角線は中央で 2 本に分かれていることもある。
      // 線が少ないまとまりは主方向が対角線に引かれて回ってしまうことがあるので、回した向きと元の向きの両方で見る
      const dims = (cl: Cluster) => ({ w: cl.maxX - cl.minX, h: cl.maxY - cl.minY });
      const diagOf = (cl: Cluster, minFrac: number) =>
        cl.segs
          .filter((s) => {
            const dx = Math.abs(s.b.x - s.a.x);
            const dy = Math.abs(s.b.y - s.a.y);
            const { w: cw, h: ch } = dims(cl);
            return Math.hypot(dx, dy) >= Math.hypot(cw, ch) * minFrac && Math.abs(dx - dy) < Math.max(dx, dy) * 0.25;
          })
          .reduce((a, s) => a + Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y), 0);
      let done = false;
      for (const cl of rot ? [c, c0] : [c]) {
        const { w: cw, h: ch } = dims(cl);
        const cL = Math.max(cw, ch);
        const cS = Math.min(cw, ch);
        if (n >= 6 && n <= 12 && within(cL, 500, 850) && cS / cL >= 0.85 && diagOf(cl, 0.35) >= Math.hypot(cw, ch) * 1.4) {
          const ctr = cl === c ? centerOf() : { x: (c0.minX + c0.maxX) / 2, y: (c0.minY + c0.maxY) / 2 };
          out.push({ kind: 'xbox', x: ctr.x, y: ctr.y, w: cw, h: ch, n, ...(cl === c ? extra : {}) });
          done = true;
          break;
        }
        // ×印を 4 つの小さな正方形（各 1 本の対角線）で描いた洗濯機: 小さな部品を覚えておき、後で 2×2 にまとめる
        if (n >= 3 && n <= 8 && within(cL, 250, 450) && cS / cL >= 0.85 && diagOf(cl, 0.8) > 0) {
          xparts.push(cl === c ? c : c0);
          done = true;
          break;
        }
      }
      if (done) continue;
      // 線の少ないまとまり: キッチンのカウンター（2.0〜3.4m × 0.6〜1.05m の長方形）だけを見る
      if (n > 24 || !within(L, 1800, 3400) || !within(S, 550, 1050)) continue;
      let onBorder = 0;
      let total = 0;
      for (const s of c.segs) {
        const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
        total += len;
        const horiz = Math.abs(s.b.y - s.a.y) < 5;
        const vert = Math.abs(s.b.x - s.a.x) < 5;
        if (horiz && (Math.abs(s.a.y - c.minY) < 20 || Math.abs(s.a.y - c.maxY) < 20)) onBorder += len;
        else if (vert && (Math.abs(s.a.x - c.minX) < 20 || Math.abs(s.a.x - c.maxX) < 20)) onBorder += len;
      }
      if (total > 0 && onBorder / total >= 0.9 && onBorder >= (w + h) * 2 * 0.9) {
        const ctr = centerOf();
        out.push({ kind: 'counter', x: ctr.x, y: ctr.y, w, h, n, ...extra });
      }
      continue;
    }
    const lens = c.segs.map((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y));
    const shortFrac = lens.filter((l) => l < 60).length / n;
    const longestIdx = lens.indexOf(Math.max(...lens));
    const longest = c0.segs[longestIdx];
    const longLen = Math.max(...lens);
    const longCount = lens.filter((l) => l >= L * 0.72).length;
    const cx = (c.minX + c.maxX) / 2;
    const cy = (c.minY + c.maxY) / 2;
    // 輪郭の「でこぼこ」: 中心からの距離のばらつき（円・丸い角の四角は小さく、植栽のぎざぎざは大きい）
    const rs = c.segs.map((s) => Math.hypot(s.a.x - cx, s.a.y - cy));
    const rMean = rs.reduce((a, r) => a + r, 0) / rs.length;
    const bump = Math.sqrt(rs.reduce((a, r) => a + (r - rMean) ** 2, 0) / rs.length) / (rMean || 1);
    const ctr = centerOf();
    const base = { x: ctr.x, y: ctr.y, w, h, n, flat: { a: longest.a, b: longest.b }, ...extra };
    // L 字（L 型ソファ: 外形 1.6〜4.6 × 1.2〜3.6m で四隅の 1 つが空いている）
    const lEmpty = within(L, 1600, 4600) && within(S, 1200, 3600) && n >= 20 ? lShapeOf(c) : null;
    let kind: SymbolKind | null = null;
    // 確かめ用の記録: 家具ほどの大きさの線のまとまりの形（長さ・幅・線の数・短い線の割合・でこぼこ）
    if (L >= 600) (globalThis as { __symRaw?: string[] }).__symRaw?.push(`${Math.round(L)}x${Math.round(S)} n=${n} short=${shortFrac.toFixed(2)} bump=${bump.toFixed(3)} long=${Math.round(longLen)} @${Math.round(cx)},${Math.round(cy)}`);
    // 車: 普通車 4.3〜5.3m。線の多い詳しい記号なら軽自動車・コンパクト（3.3m〜）も
    if ((within(L, 4300, 5300) || (within(L, 3300, 4300) && n >= 150)) && within(S, 1450, 2350) && n >= 50) kind = 'car';
    else if (within(L, 270, 310) && within(S, 40, 70) && n >= 14 && shortFrac > 0.8) kind = 'chairBack';
    else if (within(L, 400, 720) && within(S, 330, 720) && n >= 55 && shortFrac > 0.55 && bump > 0.08) kind = 'chair';
    else if (lEmpty && shortFrac > 0.5) {
      out.push({ kind: 'sofa', ...base, lEmpty, bump: +bump.toFixed(3), shortFrac: +shortFrac.toFixed(2), longLen: Math.round(longLen) });
      continue;
    } else if (within(L, 1900, 2150) && (within(S, 940, 1120) || within(S, 1350, 1800)) && n >= 16 && longLen >= L * 0.3) kind = 'bed';
    else if (within(L, 1300, 1750) && within(S, 640, 860) && n >= 16 && n <= 60 && longLen >= L * 0.5) kind = 'bath';
    else if (within(L, 580, 740) && within(S, 350, 430) && n >= 16 && longLen >= S * 0.8) kind = 'toilet';
    else if (within(L, 540, 740) && within(S, 440, 560) && n >= 12 && n <= 60 && shortFrac > 0.3) kind = 'sink';
    else if (within(L, 1800, 4600) && within(S, 720, 2300) && n >= 40 && n <= 200 && shortFrac > 0.6 && within(bump, 0.1, 0.3)) kind = 'sofa';
    // 細かく描いたまっすぐのソファ（1.7〜3.2m × 0.7〜1.1m。背のクッションを丸く、座面を四角く描くので、短い線が数百本）。
    // 大崎様邸・堀様邸（福井）の 3 人掛け: 線が多すぎて上の決まり（200 本まで）から外れ、背のクッションの列だけが
    // 「壁沿いの薄い台 = テレビ台」に読まれていた。端から端まで通る直線があるもの（カウンター・台）は違う
    else if (!noDetailSofa && within(L, 1700, 3200) && within(S, 700, 1100) && S / L < 0.6 && n >= 150 && shortFrac > 0.85 && longLen < L * 0.6) {
      // 背の側: 丸い線（短い線）の重心が、幅の方向で寄っている側
      const longX = w >= h;
      const short = c.segs.filter((sg) => Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y) < 60);
      const mean = short.reduce((a, sg) => a + (longX ? (sg.a.y + sg.b.y) / 2 - cy : (sg.a.x + sg.b.x) / 2 - cx), 0) / (short.length || 1);
      const back0 = Math.abs(mean) > S * 0.04 ? (longX ? { x: 0, y: Math.sign(mean) } : { x: Math.sign(mean), y: 0 }) : null;
      const back = back0 ? rotPt(back0, { x: 0, y: 0 }, rot) : undefined;
      out.push({ kind: 'sofa', ...base, ...(back ? { back } : {}), bump: +bump.toFixed(3), shortFrac: +shortFrac.toFixed(2), longLen: Math.round(longLen) });
      continue;
    }
    else if (n >= 80 && within(L, 300, 2800) && S / L >= 0.7 && shortFrac > 0.7 && within(bump, 0.03, 0.5)) kind = 'plant';
    if (!kind) continue;
    void longCount;
    out.push({ kind, ...base, bump: +bump.toFixed(3), shortFrac: +shortFrac.toFixed(2), longLen: Math.round(longLen) } as PlanSymbol);
  }
  // 椅子: 背もたれの弧（0.29×0.06）がすぐそば／背まで含んだ密な記号／同じ大きさのものが少し離れて並ぶ（食卓の周り）。
  // 同じ大きさのものがぴったり隣り合う（隙間 12cm 以下）ならソファのモジュール
  const backs = out.filter((s) => s.kind === 'chairBack');
  const seats = out.filter((s) => s.kind === 'chair');
  for (const s of seats) {
    const back = backs.find((b) => Math.hypot(b.x - s.x, b.y - s.y) < 280);
    if (back) {
      s.flat = { a: { x: s.x, y: s.y }, b: { x: back.x, y: back.y } };
      continue;
    }
    if (s.n >= 200) continue;
    const size = Math.max(s.w, s.h);
    const same = seats.filter((o) => o !== s && Math.abs(Math.max(o.w, o.h) - size) < 40 && Math.abs(Math.min(o.w, o.h) - Math.min(s.w, s.h)) < 40);
    const adjacent = same.some((o) => Math.hypot(o.x - s.x, o.y - s.y) < size + 120);
    const grouped = same.some((o) => Math.hypot(o.x - s.x, o.y - s.y) < 1500);
    if (adjacent) s.kind = 'sofaModule';
    else if (!grouped) s.kind = s.n >= 130 ? 'plant' : 'chairBack';
  }
  // 「植物」に回したものは、ぎざぎざ（でこぼこ）が無ければ捨てる
  for (const s of out) if (s.kind === 'plant' && (s.bump ?? 0) < 0.03) s.kind = 'chairBack';
  // ×印の小さな正方形を 2×2 にまとめて洗濯機・冷蔵庫の記号に（部品どうしの隙間 100mm 以内、全体 0.6〜0.9m 角）
  {
    const usedPart = new Set<Cluster>();
    for (const p of xparts) {
      if (usedPart.has(p)) continue;
      const group = [p];
      usedPart.add(p);
      for (let i = 0; i < group.length; i++) {
        for (const q of xparts) {
          if (usedPart.has(q)) continue;
          const gx = Math.max(group[i].minX - q.maxX, q.minX - group[i].maxX);
          const gy = Math.max(group[i].minY - q.maxY, q.minY - group[i].maxY);
          if (gx <= 100 && gy <= 100) {
            usedPart.add(q);
            group.push(q);
          }
        }
      }
      if (group.length < 3) continue;
      const minX = Math.min(...group.map((g) => g.minX));
      const maxX = Math.max(...group.map((g) => g.maxX));
      const minY = Math.min(...group.map((g) => g.minY));
      const maxY = Math.max(...group.map((g) => g.maxY));
      const gw = maxX - minX;
      const gh = maxY - minY;
      if (!within(Math.max(gw, gh), 600, 900) || Math.min(gw, gh) / Math.max(gw, gh) < 0.85) continue;
      out.push({ kind: 'xbox', x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: gw, h: gh, n: group.reduce((a, g) => a + g.segs.length, 0) });
    }
  }
  // 点線の丸（植栽）。実線で読めた植栽と重なるものは除く
  for (const ring of dottedRings(segs)) {
    if (out.some((s) => s.kind === 'plant' && Math.hypot(s.x - ring.x, s.y - ring.y) < Math.max(s.w, ring.w) / 2)) continue;
    out.push(ring);
  }
  // 車の外形の中にある部品（タイヤなど）は捨てる
  const cars = out.filter((s) => s.kind === 'car');
  return out.filter((s) => s.kind === 'car' || !cars.some((car) => Math.abs(s.x - car.x) < car.w / 2 && Math.abs(s.y - car.y) < car.h / 2));
}

/**
 * 等間隔に並ぶ平行線（床のタイル割・デッキ・階段の段・ハッチ）。
 * CAD のハッチは車や家具の輪郭で切られて端点を共有するので、記号のまとまりに使うと図面全体が 1 つにつながってしまう。
 * 同じ向きの線が同じピッチ（80〜1,200mm）で 5 本以上並ぶものをハッチとみなす。
 */
export function hatchSegments(segs: Seg[]): Set<Seg> {
  const out = new Set<Seg>();
  for (const axis of ['h', 'v'] as const) {
    const byO = new Map<number, { s: Seg; t0: number; t1: number }[]>();
    for (const s of segs) {
      if (s.source === 'fill') continue;
      const dx = Math.abs(s.b.x - s.a.x);
      const dy = Math.abs(s.b.y - s.a.y);
      const ok = axis === 'h' ? dy < 2 && dx >= 250 : dx < 2 && dy >= 250;
      if (!ok) continue;
      const o = Math.round((axis === 'h' ? s.a.y : s.a.x) / 2) * 2;
      const t0 = axis === 'h' ? Math.min(s.a.x, s.b.x) : Math.min(s.a.y, s.b.y);
      const t1 = axis === 'h' ? Math.max(s.a.x, s.b.x) : Math.max(s.a.y, s.b.y);
      if (!byO.has(o)) byO.set(o, []);
      byO.get(o)!.push({ s, t0, t1 });
    }
    const os = [...byO.keys()].sort((a, b) => a - b);
    const has = new Set(os);
    const marked = new Set<number>();
    for (let i = 0; i < os.length; i++) {
      if (marked.has(os[i])) continue;
      for (let j = i + 1; j < Math.min(os.length, i + 5); j++) {
        const p = os[j] - os[i];
        if (p < 80) continue;
        if (p > 1200) break;
        const members: number[] = [];
        for (let k = -10; k <= 10; k++) {
          const o = os[i] + k * p;
          // ±3mm のずれは同じ並び
          const m = has.has(o) ? o : has.has(o + 2) ? o + 2 : has.has(o - 2) ? o - 2 : null;
          if (m != null) members.push(m);
        }
        if (members.length < 5) continue;
        // 並びの範囲（軸方向）が重なる線だけ。隣の線（前後のピッチ）と軸方向に重なるものに限る
        // （同じ位置にあるだけの離れた線（冷蔵庫の記号の十字・洗濯機の×印）までハッチにされ、記号のまとまりから抜けていた）
        members.sort((a, b) => a - b);
        const overlaps = (e: { t0: number; t1: number }, m: number) => (byO.get(m) ?? []).some((f) => Math.min(e.t1, f.t1) - Math.max(e.t0, f.t0) >= Math.min(e.t1 - e.t0, f.t1 - f.t0) * 0.5);
        for (let k = 0; k < members.length; k++) {
          const m = members[k];
          marked.add(m);
          for (const e of byO.get(m)!) {
            if ((k > 0 && overlaps(e, members[k - 1])) || (k + 1 < members.length && overlaps(e, members[k + 1]))) out.add(e.s);
          }
        }
        break;
      }
    }
  }
  return out;
}

/** 破線で描かれた輪郭（短い線の連なり）のまとまり */
export interface DashOutline {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 線分の数 */
  n: number;
}

/**
 * 破線の家具・車の輪郭を拾う。
 * CAD の出力では破線が「短い線分の列」になっていて（setDash ではない）、端点がつながらないので clusterSegments では拾えない。
 * 近い端点（70mm 以内）で向きの近い短い線をつなぎ（直線・ゆるい曲線）、角で直交する線どうしをつないで長方形にし、
 * 大きい輪郭の中の小さなまとまり（車の窓・ソファの座面の線）はその輪郭に含める。
 */
export function dashedOutlines(segs: Seg[], gap = 70, maxLen = 120): DashOutline[] {
  const len = (s: Seg) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  // 破線の 1 本は 120mm 以下。丸い角（実線の短い折れ線）もつなぐために 250mm までの短い線を対象にする
  const frags = segs.filter((s) => s.source !== 'fill' && !s.dashed && len(s) >= 2 && len(s) <= Math.max(maxLen, 250));
  if (frags.length < 12) return [];
  const n = frags.length;
  const parent = frags.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const unite = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const ang = frags.map((s) => Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x));
  const angDiff = (a: number, b: number) => {
    let d = Math.abs(a - b) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return d;
  };
  const cell = gap;
  const hash = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  frags.forEach((s, i) => {
    for (const q of [s.a, s.b]) {
      const k = key(q.x, q.y);
      if (!hash.has(k)) hash.set(k, []);
      hash.get(k)!.push(i);
    }
  });
  const linkAll = new Int32Array(n);
  const linkGap = new Int32Array(n);
  /** 端点ごとに、つながった相手があるか（a: bit0, b: bit1） */
  const linkedEnd = new Uint8Array(n);
  const MAXA = (40 * Math.PI) / 180;
  frags.forEach((s, i) => {
    [s.a, s.b].forEach((q, ei) => {
      const cx = Math.floor(q.x / cell);
      const cy = Math.floor(q.y / cell);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          for (const j of hash.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (j === i) continue;
            const t = frags[j];
            const da = Math.hypot(t.a.x - q.x, t.a.y - q.y);
            const db = Math.hypot(t.b.x - q.x, t.b.y - q.y);
            const d = Math.min(da, db);
            if (d > gap || angDiff(ang[i], ang[j]) > MAXA) continue;
            linkedEnd[i] |= ei === 0 ? 1 : 2;
            linkedEnd[j] |= da <= db ? 1 : 2;
            if (j < i) continue;
            unite(i, j);
            linkAll[i]++;
            linkAll[j]++;
            if (d > 6) {
              linkGap[i]++;
              linkGap[j]++;
            }
          }
        }
    });
  });
  interface Chain {
    ids: number[];
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    thin: boolean;
    ends: Vec2[];
    links: number;
    gaps: number;
    /** 隙間の無い折れ線（丸い角などの実線の断片）。破線の鎖にくっつくときだけ使う */
    solid: boolean;
  }
  const byRoot = new Map<number, number[]>();
  frags.forEach((_, i) => {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r)!.push(i);
  });
  const chains: Chain[] = [];
  for (const ids of byRoot.values()) {
    if (ids.length < 6) continue;
    let links = 0;
    let gaps = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const i of ids) {
      links += linkAll[i];
      gaps += linkGap[i];
      for (const q of [frags[i].a, frags[i].b]) {
        if (q.x < minX) minX = q.x;
        if (q.x > maxX) maxX = q.x;
        if (q.y < minY) minY = q.y;
        if (q.y > maxY) maxY = q.y;
      }
    }
    // 破線らしさ: つなぎ目に隙間があるものが 3 割以上（実線の折れ線・円は隙間が無い → 破線の鎖にくっつくときだけ使う）
    // （丸い角の破線は 1 本の破線が 2〜3 本の小さな線になるので、隙間の割合は 1 割あれば破線）
    const solid = links === 0 || gaps / links < 0.1;
    const w = maxX - minX;
    const h = maxY - minY;
    if (solid && Math.max(w, h) > 2500) continue;
    const thin = Math.min(w, h) < 40;
    const ends: Vec2[] = [];
    if (!thin) {
      // つながっていない端点（鎖の端）
      for (const i of ids) {
        if (!(linkedEnd[i] & 1)) ends.push(frags[i].a);
        if (!(linkedEnd[i] & 2)) ends.push(frags[i].b);
        if (ends.length >= 16) break;
      }
    } else {
      const horiz = w >= h;
      let lo: Vec2 | null = null;
      let hi: Vec2 | null = null;
      for (const i of ids)
        for (const q of [frags[i].a, frags[i].b]) {
          const v = horiz ? q.x : q.y;
          if (!lo || v < (horiz ? lo.x : lo.y)) lo = q;
          if (!hi || v > (horiz ? hi.x : hi.y)) hi = q;
        }
      if (lo && hi) ends.push(lo, hi);
    }
    chains.push({ ids, minX, minY, maxX, maxY, thin, ends, links, gaps, solid });
  }
  (globalThis as { __dashChains?: unknown[] }).__dashChains?.push(
    ...chains.map((c) => {
      const right = c.ids.map((i) => frags[i]).sort((p, q) => Math.max(q.a.x, q.b.x) - Math.max(p.a.x, p.b.x)).slice(0, 2).map((f) => `(${Math.round(f.a.x)},${Math.round(f.a.y)})-(${Math.round(f.b.x)},${Math.round(f.b.y)})`);
      const left = c.ids.map((i) => frags[i]).sort((p, q) => Math.min(p.a.x, p.b.x) - Math.min(q.a.x, q.b.x)).slice(0, 2).map((f) => `(${Math.round(f.a.x)},${Math.round(f.a.y)})-(${Math.round(f.b.x)},${Math.round(f.b.y)})`);
      return { n: c.ids.length, x: Math.round((c.minX + c.maxX) / 2), y: Math.round((c.minY + c.maxY) / 2), w: Math.round(c.maxX - c.minX), h: Math.round(c.maxY - c.minY), thin: c.thin, solid: c.solid, ends: c.ends.length, gapFrac: +(c.gaps / (c.links || 1)).toFixed(2), right, left };
    }),
  );
  if (!chains.some((c) => !c.solid)) return [];
  // 鎖どうしをまとめる: 角で直交する細い鎖（長方形の辺）、重なる輪郭、輪郭の中の小さなまとまり
  const cp = chains.map((_, i) => i);
  const cfind = (i: number): number => (cp[i] === i ? i : (cp[i] = cfind(cp[i])));
  const cunite = (a: number, b: number) => {
    const ra = cfind(a);
    const rb = cfind(b);
    if (ra !== rb) cp[ra] = rb;
  };
  const Lof = (c: Chain) => Math.max(c.maxX - c.minX, c.maxY - c.minY);
  const CORNER = gap * 1.5;
  const area = (c: Chain) => Math.max(1, c.maxX - c.minX) * Math.max(1, c.maxY - c.minY);
  for (let i = 0; i < chains.length; i++) {
    const a = chains[i];
    for (let j = i + 1; j < chains.length; j++) {
      const b = chains[j];
      if (a.solid && b.solid) continue;
      if (Lof(a) > 5600 || Lof(b) > 5600) continue;
      const m = 20;
      const inter = a.minX <= b.maxX + 80 && a.maxX >= b.minX - 80 && a.minY <= b.maxY + 80 && a.maxY >= b.minY - 80;
      // 端どうしが近い（長方形の角・破線の胴体と丸い角）
      const touch = a.ends.some((p) => b.ends.some((q) => Math.hypot(p.x - q.x, p.y - q.y) <= CORNER));
      if (a.thin && b.thin) {
        const horizA = a.maxX - a.minX >= a.maxY - a.minY;
        const horizB = b.maxX - b.minX >= b.maxY - b.minY;
        if (horizA !== horizB && touch) cunite(i, j);
        continue;
      }
      if (touch) {
        cunite(i, j);
        continue;
      }
      if (!inter) continue;
      // 輪郭（細くない鎖）: 片方がもう片方の中（車の窓・ソファの座面）、または大きく重なる（途中で切れた胴体）
      const ix = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const iy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      const overlap = ix > 0 && iy > 0 ? (ix * iy) / Math.min(area(a), area(b)) : 0;
      if (!a.thin && !b.thin) {
        if (overlap >= 0.5) cunite(i, j);
        else {
          // 車の輪郭がタイヤの位置で段になって切れている: 隣り合う大きな鎖の合計が車の大きさならつなぐ
          const ux = Math.max(a.maxX, b.maxX) - Math.min(a.minX, b.minX);
          const uy = Math.max(a.maxY, b.maxY) - Math.min(a.minY, b.minY);
          const uL = Math.max(ux, uy);
          const uS = Math.min(ux, uy);
          const sa = Math.min(a.maxX - a.minX, a.maxY - a.minY);
          const sb = Math.min(b.maxX - b.minX, b.maxY - b.minY);
          if (within(uL, 4300, 5600) && within(uS, 1600, 2400) && Math.min(sa, sb) >= 900) cunite(i, j);
        }
      } else {
        const small = a.thin ? a : b;
        const big = a.thin ? b : a;
        if (small.minX >= big.minX - m && small.maxX <= big.maxX + m && small.minY >= big.minY - m && small.maxY <= big.maxY + m) cunite(i, j);
      }
    }
  }
  const groups = new Map<number, Chain[]>();
  chains.forEach((c, i) => {
    const r = cfind(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(c);
  });
  const out: DashOutline[] = [];
  for (const g of groups.values()) {
    if (g.every((c) => c.solid)) continue;
    const minX = Math.min(...g.map((c) => c.minX));
    const minY = Math.min(...g.map((c) => c.minY));
    const maxX = Math.max(...g.map((c) => c.maxX));
    const maxY = Math.max(...g.map((c) => c.maxY));
    const w = maxX - minX;
    const h = maxY - minY;
    // 細い線だけ（破線の 1 本線・吹抜の枠の辺）は輪郭ではない
    if (Math.min(w, h) < 200 || Math.max(w, h) < 400) continue;
    // 長方形の辺の集まりなら、4 辺（上下左右）がそろっていること
    if (g.every((c) => c.thin)) {
      const horiz = g.filter((c) => c.maxX - c.minX >= c.maxY - c.minY);
      const vert = g.filter((c) => c.maxX - c.minX < c.maxY - c.minY);
      const top = horiz.some((c) => Math.abs(c.minY - minY) < 30);
      const bottom = horiz.some((c) => Math.abs(c.maxY - maxY) < 30);
      const left = vert.some((c) => Math.abs(c.minX - minX) < 30);
      const right = vert.some((c) => Math.abs(c.maxX - maxX) < 30);
      if (!(top && bottom && left && right)) continue;
    }
    out.push({ minX, minY, maxX, maxY, n: g.reduce((a, c) => a + c.ids.length, 0) });
  }
  return out;
}

/** 破線の輪郭のうち車の大きさのもの（4.3〜5.6 × 1.6〜2.4m）を車の記号にする。実線で読めた記号と重なるものは除く */
export function dashedCarSymbols(outlines: DashOutline[], existing: PlanSymbol[]): PlanSymbol[] {
  const out: PlanSymbol[] = [];
  for (const o of outlines) {
    const w = o.maxX - o.minX;
    const h = o.maxY - o.minY;
    const L = Math.max(w, h);
    const S = Math.min(w, h);
    if (!within(L, 4300, 5600) || !within(S, 1600, 2400)) continue;
    const x = (o.minX + o.maxX) / 2;
    const y = (o.minY + o.maxY) / 2;
    if (existing.some((e) => Math.abs(e.x - x) < Math.max(e.w, e.h) / 2 + 200 && Math.abs(e.y - y) < Math.max(e.w, e.h) / 2 + 200 && (e.kind === 'car' || e.kind === 'sofa'))) continue;
    const flat = w >= h ? { a: { x: o.minX, y }, b: { x: o.maxX, y } } : { a: { x, y: o.minY }, b: { x, y: o.maxY } };
    out.push({ kind: 'car', x, y, w, h, n: o.n, flat, shortFrac: 1, bump: 0, longLen: 0 });
  }
  return out;
}

export interface ExteriorSymbols {
  /** 車（中心・向きの角度）。rot: 図面の +x 方向から時計回り（度） */
  cars: { x: number; y: number; rot: number }[];
  /** 植栽（中心・半径 mm） */
  trees: { x: number; y: number; r: number }[];
}

const DEG = 180 / Math.PI;

/**
 * 記号 → 家具（図面どおりの位置と向き）と外構。
 * 家具の基準点は「壁側の辺の中央」（FurnitureItem の決まり）なので、記号の中心から奥行き分だけ戻して求める。
 */
export function symbolsToItems(symbols: PlanSymbol[], rooms: Room[], walls: Wall[], outline: Vec2[][], level: number, trace?: string[]): { items: FurnitureItem[]; exterior: ExteriorSymbols } {
  const items: FurnitureItem[] = [];
  const exterior: ExteriorSymbols = { cars: [], trees: [] };
  let seq = 0;
  const id = () => `ps${level}_${++seq}`;
  const roomAt = (p: Vec2) => rooms.find((r) => pointInPolygon(p, r.polygon));
  const inside = (p: Vec2) => outline.some((l) => pointInPolygon(p, l));
  const wallDist = (p: Vec2) => (walls.length ? Math.min(...walls.map((w) => distPointSegment(p, w.a, w.b))) : Infinity);
  const unit = (x: number, y: number) => {
    const l = Math.hypot(x, y) || 1;
    return { x: x / l, y: y / l };
  };
  /** 単位ベクトル n の向きで、中心から dist 離れた点が壁に近い方（n か -n）を選ぶ */
  const towardWall = (c: Vec2, n: Vec2, dist: number): Vec2 => {
    const p1 = { x: c.x + n.x * dist, y: c.y + n.y * dist };
    const p2 = { x: c.x - n.x * dist, y: c.y - n.y * dist };
    return wallDist(p1) <= wallDist(p2) ? n : { x: -n.x, y: -n.y };
  };
  /** 並び方向 along と部屋側 inward から rot（度）。along = (cos r, sin r), inward = (-sin r, cos r) */
  const rotOf = (along: Vec2, inward: Vec2) => {
    let r = Math.atan2(along.y, along.x) * DEG;
    // inward が along を +90° 回した向きになるように（違えば along を反転）
    const cross = along.x * inward.y - along.y * inward.x;
    if (cross < 0) r += 180;
    return Math.round(((r % 360) + 360) % 360);
  };
  /** その種類の家具があり得る部屋か（車庫の車の部品・玄関の靴箱などの誤認を避ける） */
  const ALLOWED: Partial<Record<FurnitureKind, RoomType[]>> = {
    toilet: ['toilet', 'washroom', 'other'],
    bath: ['bath', 'washroom', 'other'],
    washstand: ['washroom', 'toilet', 'bath', 'hall', 'other', 'entrance'],
    bed: ['bedroom', 'kids', 'japanese', 'study', 'other'],
    sofa: ['ldk', 'living', 'dining', 'japanese', 'bedroom', 'study', 'other'],
    dining: ['ldk', 'living', 'dining', 'kitchen', 'japanese', 'study', 'other'],
    kitchen: ['ldk', 'kitchen', 'dining', 'living', 'japanese', 'study', 'storage', 'other'],
    washer: ['washroom', 'toilet', 'hall', 'other'],
    fridge: ['ldk', 'kitchen', 'dining', 'living', 'storage', 'other'],
  };
  const push = (kind: FurnitureKind, c: Vec2, along: Vec2, inward: Vec2, back: number, extra: Partial<FurnitureItem> = {}, roomPoint?: Vec2) => {
    const room = roomAt(roomPoint ?? c);
    if (!room) {
      trace?.push(`drop ${kind}@${Math.round(c.x)},${Math.round(c.y)}: no room`);
      return null;
    }
    const ok = ALLOWED[kind];
    if (ok && !ok.includes(room.type)) {
      trace?.push(`drop ${kind}@${Math.round(c.x)},${Math.round(c.y)}: room ${room.name}/${room.type}`);
      return null;
    }
    const origin = { x: c.x - inward.x * back, y: c.y - inward.y * back };
    const it: FurnitureItem = { id: id(), kind, x: Math.round(origin.x), y: Math.round(origin.y), rot: rotOf(along, inward), roomId: room.id, ...extra };
    items.push(it);
    return it;
  };
  const perp = (v: Vec2) => ({ x: -v.y, y: v.x });
  const rotV = (v: Vec2, a: number) => (a ? { x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) } : v);
  /** 長手の向き（回して置かれた記号はその角度で） */
  const axisLong = (s: PlanSymbol) => rotV(s.w >= s.h ? { x: 1, y: 0 } : { x: 0, y: 1 }, s.rot ?? 0);
  /** 軸に近い向きは軸にそろえる（斜めはそのまま） */
  const snapAxis = (v: Vec2) => (Math.abs(v.x) > 0.94 ? { x: Math.sign(v.x), y: 0 } : Math.abs(v.y) > 0.94 ? { x: 0, y: Math.sign(v.y) } : v);

  // 車・植栽（建物の外）。部屋の中にある「車の大きさの丸い形」は L 型ソファ
  for (const s of symbols) {
    if (s.kind === 'car') {
      const a = axisLong(s);
      const room = roomAt({ x: s.x, y: s.y });
      // 室名の無い区画（メモの文字しか無い区画）に車が置いてあれば、その区画はガレージ
      // 隣の部屋から名前を推定しただけの区画（中庭・ポーチと推定されたものも）に車があれば、それもガレージ
      if (level === 1 && room && (room.type === 'other' || room.type === 'porch' || (room.inferred && room.type === 'balcony')) && !(!room.inferred && /ポーチ|PORCH/i.test(room.name))) {
        if (room.inferred) room.name = '室';
        room.name = room.type === 'other' && room.name !== '室' ? `ガレージ（${room.name}）` : 'ガレージ';
        room.type = 'garage';
        room.inferred = true;
      }
      if (!inside({ x: s.x, y: s.y }) || room?.type === 'garage') {
        if (level === 1) exterior.cars.push({ x: Math.round(s.x), y: Math.round(s.y), rot: Math.round(Math.atan2(a.y, a.x) * DEG) });
      } else if (room && Math.max(s.w, s.h) <= 4600) s.kind = 'sofa';
    } else if (s.kind === 'plant') {
      const c = { x: s.x, y: s.y };
      const r = Math.round(Math.max(s.w, s.h) / 2);
      if (!inside(c)) {
        if (level === 1) exterior.trees.push({ x: Math.round(c.x), y: Math.round(c.y), r });
      } else {
        const room = roomAt(c);
        // 室内の観葉植物は居室・ホールだけ（水まわり・収納の丸い記号（洗濯機の槽・丸い手洗い）を植物にしない）
        const NO_PLANT: RoomType[] = ['washroom', 'bath', 'toilet', 'closet', 'storage', 'kitchen', 'garage', 'stairs', 'void'];
        if (room && r <= 700 && !NO_PLANT.includes(room.type)) items.push({ id: id(), kind: 'plant', x: Math.round(c.x), y: Math.round(c.y), rot: 0, roomId: room.id, w: +Math.min(1.3, Math.max(0.5, r / 350)).toFixed(2) });
      }
    }
  }

  // 食卓: 椅子の集まり（互いに 1.4m 以内）→ 中心に食卓、並び方向は椅子の広がる方向
  const chairs = symbols.filter((s) => s.kind === 'chair');
  const usedChair = new Set<PlanSymbol>();
  for (const ch of chairs) {
    if (usedChair.has(ch)) continue;
    const group: PlanSymbol[] = [ch];
    usedChair.add(ch);
    for (let i = 0; i < group.length; i++) for (const o of chairs) if (!usedChair.has(o) && Math.hypot(o.x - group[i].x, o.y - group[i].y) < 1400) { usedChair.add(o); group.push(o); }
    if (group.length < 2) continue;
    const cx = group.reduce((a, g) => a + g.x, 0) / group.length;
    const cy = group.reduce((a, g) => a + g.y, 0) / group.length;
    // 椅子 2 脚だけなら、食卓として扱うのは LDK・ダイニングに限る（書斎の机の椅子などを食卓にしない）
    if (group.length < 3 && !['ldk', 'dining', 'kitchen', 'living'].includes(roomAt({ x: cx, y: cy })?.type ?? 'other')) continue;
    // 椅子に囲まれた長方形（テーブル）があれば、その中心と向き・長さを使う
    const table = symbols.find((s) => s.kind === 'counter' && Math.abs(s.x - cx) < 700 && Math.abs(s.y - cy) < 700 && Math.min(s.w, s.h) < 1100);
    if (table) {
      const a = axisLong(table);
      push('dining', { x: table.x, y: table.y }, a, perp(a), 0, { w: +Math.min(2.6, Math.max(1.4, Math.max(table.w, table.h) / 1000)).toFixed(2) });
      usedChair.add(table); // 使用済み（キッチンのカウンターとして使わない）
      continue;
    }
    // 主軸（広がりの大きい方向）
    let sxx = 0, syy = 0, sxy = 0;
    for (const g of group) { sxx += (g.x - cx) ** 2; syy += (g.y - cy) ** 2; sxy += (g.x - cx) * (g.y - cy); }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let along = unit(Math.cos(th), Math.sin(th));
    // 椅子が 2 列（テーブルの両側）なら、列の方向が並び方向: 列と直交する方向の広がりが小さい。
    // 軸に近ければ軸にそろえ、斜めに置かれた食卓（45° の LDK）はその向きのまま
    along = snapAxis(along);
    const perSide = Math.max(2, Math.ceil(group.length / 2));
    push('dining', { x: cx, y: cy }, along, perp(along), 0, { w: +Math.min(2.4, Math.max(1.5, perSide * 0.65 + 0.3)).toFixed(2) });
  }

  // ソファ: モジュールの並び
  const mods = symbols.filter((s) => s.kind === 'sofaModule');
  const usedMod = new Set<PlanSymbol>();
  for (const m of mods) {
    if (usedMod.has(m)) continue;
    const group: PlanSymbol[] = [m];
    usedMod.add(m);
    for (let i = 0; i < group.length; i++) for (const o of mods) if (!usedMod.has(o) && Math.hypot(o.x - group[i].x, o.y - group[i].y) < 760) { usedMod.add(o); group.push(o); }
    if (group.length < 2) continue;
    const xs = group.map((g) => g.x), ys = group.map((g) => g.y);
    const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
    const along = spanX >= spanY ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const c = { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 };
    const back = towardWall(c, perp(along), 450);
    const inward = { x: -back.x, y: -back.y };
    const w = Math.max(spanX, spanY) + 600;
    push('sofa', c, along, inward, 450, { w: +Math.min(3.6, Math.max(1.6, w / 1000)).toFixed(2) });
  }
  for (const s of symbols) {
    const c = { x: s.x, y: s.y };
    switch (s.kind) {
      case 'sofa': {
        if (roomAt(c)?.type === 'garage' || !inside(c)) {
          trace?.push(`skip sofa@${Math.round(c.x)},${Math.round(c.y)} ${Math.round(s.w)}x${Math.round(s.h)}: outside`);
          break;
        }
        const along = axisLong(s);
        if (s.lEmpty) {
          // L 型: 空いている角の側が部屋側。背は反対側、カウチは長手で空いている角と反対の端
          const longX = s.w >= s.h;
          const eLong = longX ? s.lEmpty.x : s.lEmpty.y;
          const eAcross = longX ? s.lEmpty.y : s.lEmpty.x;
          const acrossW = rotV(longX ? { x: 0, y: 1 } : { x: 1, y: 0 }, s.rot ?? 0);
          const inward = { x: acrossW.x * eAcross, y: acrossW.y * eAcross };
          const chaise = { x: -along.x * eLong, y: -along.y * eLong };
          const cross = along.x * inward.y - along.y * inward.x;
          const alongN = cross < 0 ? { x: -along.x, y: -along.y } : along;
          const legSide: 'left' | 'right' = chaise.x * alongN.x + chaise.y * alongN.y > 0 ? 'right' : 'left';
          const S = Math.min(s.w, s.h);
          push('sofa', c, along, inward, S / 2, { w: +Math.min(3.6, Math.max(1.6, Math.max(s.w, s.h) / 1000)).toFixed(2), shape: 'l', legSide, leg: +Math.min(2.2, Math.max(1.2, S / 1000)).toFixed(2) });
          break;
        }
        // 背の側: 記号から読めていればそれ（丸いクッションの側）。無ければ壁に近い側
        const back = s.back ?? towardWall(c, perp(along), 450);
        push('sofa', c, along, { x: -back.x, y: -back.y }, s.back ? Math.min(s.w, s.h) / 2 : 450, { w: +Math.min(3.6, Math.max(1.6, Math.max(s.w, s.h) / 1000)).toFixed(2) });
        break;
      }
      case 'xbox': {
        // ×印の正方形: 脱衣室なら洗濯機、LDK・キッチンなら冷蔵庫。壁にいちばん近い辺を背にする
        const room = roomAt(c);
        if (!room) break;
        const kind: FurnitureKind | null = room.type === 'washroom' || room.type === 'toilet' || room.type === 'hall' ? 'washer' : ['ldk', 'kitchen', 'dining', 'living', 'storage', 'other'].includes(room.type) ? 'fridge' : null;
        if (!kind) break;
        const S = Math.min(s.w, s.h);
        const ax = rotV({ x: 1, y: 0 }, s.rot ?? 0);
        const dirs = [ax, { x: -ax.x, y: -ax.y }, perp(ax), { x: -perp(ax).x, y: -perp(ax).y }];
        const backDir = dirs.map((d) => ({ d, dist: wallDist({ x: c.x + d.x * (S / 2 + 60), y: c.y + d.y * (S / 2 + 60) }) })).sort((a, b) => a.dist - b.dist)[0].d;
        const inward = { x: -backDir.x, y: -backDir.y };
        push(kind, c, { x: inward.y, y: -inward.x }, inward, S / 2, { w: +(S / 1000).toFixed(2) });
        break;
      }
      case 'bed': {
        const long = axisLong(s);
        const head = towardWall(c, long, 1000);
        const inward = { x: -head.x, y: -head.y };
        push('bed', c, perp(inward), inward, 1000, { w: +(Math.min(s.w, s.h) / 1000).toFixed(2) });
        break;
      }
      case 'toilet': {
        const long = axisLong(s);
        // D 形（タンク側が平らな辺）ならその向き、そうでなければ壁に近い側がタンク
        let tank = towardWall(c, long, 350);
        const f = s.flat;
        if (f && Math.hypot(f.b.x - f.a.x, f.b.y - f.a.y) >= Math.min(s.w, s.h) * 0.8) {
          const mid = { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 };
          const d = unit(mid.x - c.x, mid.y - c.y);
          if (Math.abs(d.x * long.x + d.y * long.y) > 0.7) tank = d;
        }
        const inward = { x: -tank.x, y: -tank.y };
        push('toilet', c, perp(inward), inward, 375);
        break;
      }
      case 'bath': {
        const along = axisLong(s);
        const wallSide = towardWall(c, perp(along), 400);
        push('bath', c, along, { x: -wallSide.x, y: -wallSide.y }, 400, { len: +(Math.max(s.w, s.h) / 1000).toFixed(2) });
        break;
      }
    }
  }

  // キッチン: シンクを手がかりに。シンクのすぐ後ろに壁があれば壁付け（前に平行なアイランドのカウンターがあれば対面型）、
  // 壁から離れたカウンターの上にあればアイランド型
  const counters = symbols.filter((s) => s.kind === 'counter' && !usedChair.has(s));
  const usedCounter = new Set<PlanSymbol>();
  const KITCHEN_NG: RoomType[] = ['toilet', 'bath', 'washroom', 'void', 'stairs', 'closet', 'entrance', 'hall', ...OUTDOOR_TYPES];
  for (const sink of symbols.filter((s) => s.kind === 'sink')) {
    const c = { x: sink.x, y: sink.y };
    const room = roomAt(c);
    if (!room || KITCHEN_NG.includes(room.type)) continue;
    // 同じキッチンの 2 つ目のシンク（ダブルシンクなど）
    if (items.some((it) => it.kind === 'kitchen' && Math.hypot(it.x - c.x, it.y - c.y) < 2600)) continue;
    const onCounter = counters.find((k) => !usedCounter.has(k) && Math.abs(sink.x - k.x) <= k.w / 2 + 80 && Math.abs(sink.y - k.y) <= k.h / 2 + 80);
    // 近い壁（シンク中心から 0.7m 以内なら壁付けのカウンター）。前にアイランドのある壁を優先し、無ければいちばん近い壁
    const nearWalls = walls
      .map((w) => ({ w, d: distPointSegment(c, w.a, w.b) }))
      .filter((o) => o.d <= 700)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    trace?.push(`sink@${Math.round(c.x)},${Math.round(c.y)} room=${room.name} walls=${nearWalls.map((o) => Math.round(o.d)).join('/')} onCounter=${onCounter ? `${Math.round(onCounter.w)}x${Math.round(onCounter.h)}` : 'no'}`);
    const plans = nearWalls.map((near) => {
      const w = near.w;
      // 壁に沿う向き（斜めの壁ならそのまま）
      const along = snapAxis(unit(w.b.x - w.a.x, w.b.y - w.a.y));
      const pn = perp(along);
      const side = (c.x - w.a.x) * pn.x + (c.y - w.a.y) * pn.y;
      let inward = side >= 0 ? pn : { x: -pn.x, y: -pn.y };
      // 壁の内側の面の上にシンクの足元を取る
      const t = (c.x - w.a.x) * along.x + (c.y - w.a.y) * along.y;
      const foot = { x: w.a.x + along.x * t + inward.x * (w.thickness / 2), y: w.a.y + along.y * t + inward.y * (w.thickness / 2) };
      // 前に平行なアイランド（奥行 0.75〜1.1m・長さ 1.6m 以上）があれば対面型
      const island = counters.find((k) => {
        if (usedCounter.has(k) || k === onCounter) return false;
        const depth = Math.min(k.w, k.h);
        const length = Math.max(k.w, k.h);
        if (depth < 750 || depth > 1150 || length < 1600) return false;
        const alongK = axisLong(k);
        if (Math.abs(alongK.x * along.x + alongK.y * along.y) < 0.9) return false;
        const dv = (k.x - foot.x) * inward.x + (k.y - foot.y) * inward.y;
        const du = (k.x - foot.x) * along.x + (k.y - foot.y) * along.y;
        return dv > 900 && dv < 2500 && Math.abs(du) < length / 2 + 400;
      });
      return { w, along, inward, foot, island };
    });
    const chosen = plans.find((p) => p.island) ?? plans[0];
    if (chosen) {
      let { along } = chosen;
      const { inward, foot, island } = chosen;
      // 並びの向き: コンロはシンクから見て壁沿いに空きの多い側
      const free = (sg: number) => wallDist({ x: foot.x + along.x * sg * 1300 + inward.x * 300, y: foot.y + along.y * sg * 1300 + inward.y * 300 });
      const stoveSign = free(1) >= free(-1) ? 1 : -1;
      const cross = along.x * inward.y - along.y * inward.x;
      // rot の決まりでは inward = along を +90° 回した向き。逆なら along を反転して、コンロ側の符号も合わせる
      let sg = stoveSign;
      if (cross < 0) {
        along = { x: -along.x, y: -along.y };
        sg = -sg;
      }
      const stoveSide: 'left' | 'right' = sg > 0 ? 'right' : 'left';
      if (island) {
        usedCounter.add(island);
        if (onCounter) usedCounter.add(onCounter);
        const length = Math.max(island.w, island.h);
        const len = +Math.min(3.4, Math.max(2.2, (length + 400) / 1000)).toFixed(2);
        const du = (island.x - foot.x) * along.x + (island.y - foot.y) * along.y;
        const dv = (island.x - foot.x) * inward.x + (island.y - foot.y) * inward.y;
        const origin = { x: foot.x + along.x * du, y: foot.y + along.y * du };
        push('kitchen', origin, along, inward, 0, { len, kitchenType: 'peninsula', stoveSide, fridge: 'none', d: +(dv / 1000).toFixed(2) }, c);
      } else {
        if (onCounter) usedCounter.add(onCounter);
        const length = onCounter ? Math.max(onCounter.w, onCounter.h) : 2150;
        const len = +Math.min(3.4, Math.max(2.2, (length + 400) / 1000)).toFixed(2);
        // シンクが図面の位置に来るように中心をずらす（シンクは中心から コンロと反対側に cw/2-0.6）
        const cw = Math.min(len - 0.3, 3.0);
        const du = onCounter ? (onCounter.x - foot.x) * along.x + (onCounter.y - foot.y) * along.y : sg * (cw / 2 - 0.6) * 1000;
        const origin = { x: foot.x + along.x * du, y: foot.y + along.y * du };
        const it = push('kitchen', origin, along, inward, 0, { len, kitchenType: 'wall', stoveSide, fridge: 'none' }, c);
        trace?.push(`kitchen wall → ${it ? 'ok' : 'rejected'} origin=${Math.round(origin.x)},${Math.round(origin.y)}`);
      }
      continue;
    }
    if (!onCounter) continue;
    // アイランド: カウンターの長手が並び方向。部屋側はラベルのある側
    usedCounter.add(onCounter);
    const ct = onCounter;
    let along = axisLong(ct);
    const pn = perp(along);
    const rc = room.labelPos;
    const side = (rc.x - ct.x) * pn.x + (rc.y - ct.y) * pn.y;
    const inward = side >= 0 ? pn : { x: -pn.x, y: -pn.y };
    const cross = along.x * inward.y - along.y * inward.x;
    if (cross < 0) along = { x: -along.x, y: -along.y };
    const su = (sink.x - ct.x) * along.x + (sink.y - ct.y) * along.y;
    const stoveSide: 'left' | 'right' = su > 0 ? 'left' : 'right';
    const len = +Math.min(3.4, Math.max(2.2, (Math.max(ct.w, ct.h) + 400) / 1000)).toFixed(2);
    let back = 1520;
    let found = false;
    for (let t = 1000; t <= 2600; t += 50) {
      if (wallDist({ x: ct.x - inward.x * t, y: ct.y - inward.y * t }) < 110) {
        back = t;
        found = true;
        break;
      }
    }
    push('kitchen', { x: ct.x, y: ct.y }, along, inward, back, { len, kitchenType: found ? 'peninsula' : 'island', stoveSide, fridge: 'none', d: +(back / 1000).toFixed(2) }, c);
  }
  return { items, exterior };
}

/** 図面の設計士のメモ（吹き出しの説明文: 「東から光を取り込みます」「R壁を使ったニッチ」など） */
export interface PlanNote {
  text: string;
  x: number;
  y: number;
  roomId?: string;
}

const NOTE_NG = /境界線|帖|㎡|m2|面積|平面図|立面図|断面図|四捨五入|図面|工事|様邸|様 邸|事務所|縮尺|S\s*[:：]|TEL|FAX|更新日|管理者|設計者|担当者|建築士|丸め|配線|ﾘﾓｽﾃ|リモコン|要床補強|№|No\.|^\s*[A-Z]{1,3}\s*$/i;

/**
 * 室名より小さい文字で書かれた「文（ひらがなを含む）」をメモとして拾い、行が続くものはつなぐ。
 * roomLabelSize は室名の文字の大きさ（mm）。
 */
export function detectNotes(texts: MmText[], roomLabelSize: number, rooms: Room[]): PlanNote[] {
  const hira = /[ぁ-ゟ]/;
  const cands = texts
    .filter((t) => t.str.trim().length >= 4 && hira.test(t.str) && !NOTE_NG.test(t.str) && t.size <= roomLabelSize * 0.92 && Math.abs(((t.angle % 360) + 360) % 360) < 2)
    .map((t) => ({ ...t, str: t.str.trim().normalize('NFKC') }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const used = new Set<number>();
  const notes: PlanNote[] = [];
  for (let i = 0; i < cands.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const lines = [cands[i]];
    // 次の行: 同じ大きさで、すぐ下（行間 ≤ 1.7 文字）、横位置が近い
    let last = cands[i];
    for (let j = i + 1; j < cands.length; j++) {
      if (used.has(j)) continue;
      const t = cands[j];
      if (Math.abs(t.size - last.size) > last.size * 0.15) continue;
      const dy = t.y - last.y;
      if (dy < last.size * 0.6 || dy > last.size * 1.7) continue;
      if (Math.abs(t.x - last.x) > last.size * Math.max(4, last.str.length * 0.6)) continue;
      used.add(j);
      lines.push(t);
      last = t;
    }
    const text = lines.map((l) => l.str).join('');
    if (text.length < 5) continue;
    // 位置: 1 行目の中心（吹き出しの文字の中心）
    const x = lines.reduce((a, l) => a + l.x, 0) / lines.length;
    const y = lines.reduce((a, l) => a + l.y, 0) / lines.length;
    const room = rooms.find((r) => pointInPolygon({ x, y }, r.polygon));
    notes.push({ text, x: Math.round(x), y: Math.round(y), roomId: room?.id });
  }
  return notes;
}
