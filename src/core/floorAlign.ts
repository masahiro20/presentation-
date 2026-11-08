/**
 * 上下階の重ね位置（位置合わせ）。
 * 図面の読み取りは 2 階以上を「壁の重なり＋階段の重なり（＋面積表の建築面積）」で 1 階に重ねる（parser/assemble の alignOffset）。
 * 910 の格子に乗った家は半間ずれた位置も同じくらい良く見えるので、人が確かめて直せるようにする（方眼の「上下階」の道具）。
 * ここは画面に依らない計算だけ（テスト用に分けている）。座標は図面座標 mm（x 右・y 下）。
 */
import type { Floor, RoofPatch, Stair, Vec2 } from './types';
import { distPointSegment, insideLoops } from './geometry';

const mv = (p: Vec2, d: Vec2): Vec2 => ({ x: p.x + d.x, y: p.y + d.y });

/** 位置（x, y）を持つものをまとめて動かす */
export function translateXY<T extends { x: number; y: number }>(items: T[] | undefined, d: Vec2): void {
  if (!items) return;
  for (const it of items) {
    it.x += d.x;
    it.y += d.y;
  }
}

/** 階の形をそのまま d だけ平行移動する（壁・部屋・階段・外形・柱・図面の記号・メモ）。窓・戸は壁の始点からの距離で持つので変わらない */
export function translateFloor(f: Floor, d: Vec2): void {
  for (const w of f.walls) {
    w.a = mv(w.a, d);
    w.b = mv(w.b, d);
  }
  for (const r of f.rooms) {
    r.polygon = r.polygon.map((p) => mv(p, d));
    r.labelPos = mv(r.labelPos, d);
  }
  for (const s of f.stairs) {
    s.minX += d.x;
    s.maxX += d.x;
    s.minY += d.y;
    s.maxY += d.y;
  }
  f.outline = f.outline.map((loop) => loop.map((p) => mv(p, d)));
  translateXY(f.posts, d);
  translateXY(f.planItems, d);
  translateXY(f.notes, d);
  if (f.symbolCandidates)
    for (const c of f.symbolCandidates) {
      c.cx += d.x;
      c.cy += d.y;
    }
  if (f.exterior) {
    translateXY(f.exterior.cars, d);
    translateXY(f.exterior.trees, d);
  }
}

/** その階の屋根の手直し（塊の点・四角・描いた範囲）も階と一緒に動かす */
export function translateRoofPatches(patches: RoofPatch[] | undefined, level: number, d: Vec2): void {
  if (!patches) return;
  for (const rp of patches) {
    if (rp.level !== level) continue;
    rp.at = mv(rp.at, d);
    if (rp.rect) rp.rect = { minX: rp.rect.minX + d.x, maxX: rp.rect.maxX + d.x, minY: rp.rect.minY + d.y, maxY: rp.rect.maxY + d.y };
    if (rp.loop) rp.loop = rp.loop.map((p) => mv(p, d));
  }
}

const center = (s: Stair): Vec2 => ({ x: (s.minX + s.maxX) / 2, y: (s.minY + s.maxY) / 2 });
const area = (s: Stair) => Math.max(0, s.maxX - s.minX) * Math.max(0, s.maxY - s.minY);
/** 矩形の重なり ÷ 合わせた範囲（同じ大きさの階段が同じ位置にあるときだけ 1 に近づく） */
export function stairIoU(a: Stair, b: Stair): number {
  const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const iy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  const inter = ix * iy;
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

export interface StairMatch {
  lower: Stair;
  upper: Stair;
  /** 上の階の階段が下の階の階段より右（+x）・下（+y）へずれている量 (mm) */
  dx: number;
  dy: number;
  /** 今の重なり（0〜1） */
  iou: number;
}

/**
 * 下の階の昇り階段と上の階の階段のうち、同じ階段と見てよい組（中心が近く、重なりが良い）。
 * 上の階に昇り（UP）と降り（DN）の両方がある 3 階建ての 2 階では降り口（goesUp=false）を優先する
 */
export function matchStairs(lower: Floor, upper: Floor): StairMatch | null {
  const los = lower.stairs.filter((s) => s.goesUp).length ? lower.stairs.filter((s) => s.goesUp) : lower.stairs;
  const ups = upper.stairs.filter((s) => !s.goesUp).length ? upper.stairs.filter((s) => !s.goesUp) : upper.stairs;
  let best: StairMatch | null = null;
  let bestKey = -Infinity;
  for (const a of los)
    for (const b of ups) {
      const ca = center(a);
      const cb = center(b);
      const dx = cb.x - ca.x;
      const dy = cb.y - ca.y;
      const dist = Math.hypot(dx, dy);
      // 4 m 以上離れた階段は別の階段
      if (dist > 4000) continue;
      const iou = stairIoU(a, b);
      // 重なりが良いほど・中心が近いほど良い
      const key = iou * 10 - dist / 1000;
      if (key > bestKey) {
        bestKey = key;
        best = { lower: a, upper: b, dx: Math.round(dx), dy: Math.round(dy), iou };
      }
    }
  return best;
}

/** 階段で合わせるときに上の階を動かす量（階段の中心を下の階の階段に重ねる）。合わせる組が無ければ null */
export function stairAlignOffset(lower: Floor, upper: Floor): Vec2 | null {
  const m = matchStairs(lower, upper);
  return m ? { x: -m.dx || 0, y: -m.dy || 0 } : null;
}

/** 上の階の外形のうち、下の階の外形の外に出ている面積（㎡。step mm の格子で数える概算） */
export function overhangArea(lower: Floor, upper: Floor, step = 100): number {
  if (!upper.outline.length || !lower.outline.length) return 0;
  const pts = upper.outline.flat();
  if (!pts.length) return 0;
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  let n = 0;
  for (let y = minY + step / 2; y < maxY; y += step)
    for (let x = minX + step / 2; x < maxX; x += step) {
      const p = { x, y };
      if (insideLoops(p, upper.outline) && !insideLoops(p, lower.outline)) n++;
    }
  return (n * step * step) / 1e6;
}

/** 外形の面積（㎡。穴は引く） */
export function outlineAreaM2(f: Floor): number {
  if (!f.outline.length) return 0;
  const pts = f.outline.flat();
  if (!pts.length) return 0;
  const step = 100;
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  let n = 0;
  for (let y = minY + step / 2; y < maxY; y += step) for (let x = minX + step / 2; x < maxX; x += step) if (insideLoops({ x, y }, f.outline)) n++;
  return (n * step * step) / 1e6;
}

/** 上の階の壁を点にして（300 mm おき）、下の階の壁に乗っている割合（0〜1。外壁の点は 2 倍に数える） */
export function wallFitRatio(lower: Floor, upper: Floor, d: Vec2 = { x: 0, y: 0 }, tol = 60): number {
  let total = 0;
  let hit = 0;
  for (const w of upper.walls) {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (L < 100) continue;
    const n = Math.max(2, Math.round(L / 300));
    const wt = w.exterior ? 2 : 1;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = { x: w.a.x + (w.b.x - w.a.x) * t + d.x, y: w.a.y + (w.b.y - w.a.y) * t + d.y };
      total += wt;
      for (const q of lower.walls)
        if (distPointSegment(p, q.a, q.b) <= tol) {
          hit += wt;
          break;
        }
    }
  }
  return total ? hit / total : 0;
}

export interface WallAlignResult {
  /** 上の階を動かす量 */
  d: Vec2;
  /** 動かす前・後に下の階の壁に乗る割合 */
  before: number;
  after: number;
}

/**
 * 壁の重なりで合わせる: ±range を grid 刻みで総当たりし、最良の周りを grid/5 刻みで詰める。
 * 同点なら動かさない方（小さい移動）を選ぶ
 */
export function wallAlignOffset(lower: Floor, upper: Floor, grid = 455, range = 1820): WallAlignResult {
  const before = wallFitRatio(lower, upper);
  const better = (a: { d: Vec2; r: number }, b: { d: Vec2; r: number }) => a.r > b.r + 1e-9 || (Math.abs(a.r - b.r) <= 1e-9 && Math.hypot(a.d.x, a.d.y) < Math.hypot(b.d.x, b.d.y));
  let best = { d: { x: 0, y: 0 }, r: before };
  for (let dx = -range; dx <= range; dx += grid)
    for (let dy = -range; dy <= range; dy += grid) {
      if (!dx && !dy) continue;
      const c = { d: { x: dx, y: dy }, r: wallFitRatio(lower, upper, { x: dx, y: dy }) };
      if (better(c, best)) best = c;
    }
  const fine = Math.max(10, Math.round(grid / 5));
  const base = { ...best.d };
  for (let dx = -grid; dx <= grid; dx += fine)
    for (let dy = -grid; dy <= grid; dy += fine) {
      const c = { d: { x: base.x + dx, y: base.y + dy }, r: wallFitRatio(lower, upper, { x: base.x + dx, y: base.y + dy }) };
      if (better(c, best)) best = c;
    }
  return { d: best.d, before, after: best.r };
}

export interface FloorAlignReport {
  stair: StairMatch | null;
  /** 上の階が下の階の外形からはみ出す面積（㎡）と、上の階の外形の面積 */
  overhangM2: number;
  upperM2: number;
  /** 上の階の壁が下の階の壁に乗っている割合 */
  wallFit: number;
}

/** 上下階のずれの診断（方眼の「上下階」の道具・読み取り結果の注記に） */
export function floorAlignReport(lower: Floor, upper: Floor): FloorAlignReport {
  return { stair: matchStairs(lower, upper), overhangM2: overhangArea(lower, upper), upperM2: outlineAreaM2(upper), wallFit: wallFitRatio(lower, upper) };
}

/** ずれの言い方（図面の上で右・左・下・上） */
export function offsetText(d: Vec2): string {
  const parts: string[] = [];
  if (Math.round(d.x)) parts.push(`${d.x > 0 ? '右' : '左'} ${Math.abs(Math.round(d.x)).toLocaleString()} mm`);
  if (Math.round(d.y)) parts.push(`${d.y > 0 ? '下' : '上'} ${Math.abs(Math.round(d.y)).toLocaleString()} mm`);
  return parts.length ? parts.join('・') : 'ずれなし';
}
