/**
 * 寸法の表示（CAD・ウォークインホームの「選ぶと寸法が出る」）に使う純粋な計算。
 * 家具の足元から部屋の壁までの距離、窓・戸の両端から壁の端（隣の窓・戸）までの距離。座標は図面座標 mm
 */
import type { Opening, Vec2 } from './types';

/** 点 p から向き dir（単位ベクトル）に進んで多角形の辺に最初に当たるまでの距離（mm）。当たらなければ null */
export function rayToPolygon(p: Vec2, dir: Vec2, poly: Vec2[]): number | null {
  let best: number | null = null;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = dir.x * ey - dir.y * ex;
    if (Math.abs(denom) < 1e-9) continue;
    const apx = a.x - p.x;
    const apy = a.y - p.y;
    const t = (apx * ey - apy * ex) / denom;
    const u = (apx * dir.y - apy * dir.x) / denom;
    if (t > 1e-6 && u >= -1e-6 && u <= 1 + 1e-6 && (best == null || t < best)) best = t;
  }
  return best;
}

/** 家具の足元の寸法（m）: 幅 w・奥行 d・背面の位置 v0（中心から部屋側へ） */
export interface FootDims {
  w: number;
  d: number;
  v0: number;
}

/** 家具から部屋の壁までの距離（mm。壁芯の多角形までの距離から壁の半分の厚さを引いた、仕上げ面までの概算）。当たらなければ null */
export interface FurnitureGaps {
  /** 背面（壁ぎわ側）の壁まで */
  back: number | null;
  /** 正面（部屋側）の壁まで */
  front: number | null;
  /** 向かって左（家具の −u 側）の壁まで */
  sideA: number | null;
  /** 向かって右（家具の +u 側）の壁まで */
  sideB: number | null;
}

/** 家具のローカル座標（u = 幅方向、v = 奥行方向で部屋側が +）→ 図面座標 mm */
export function furnitureLocalToPlan(pos: { x: number; y: number; rot: number }, u: number, v: number): Vec2 {
  const r = (pos.rot * Math.PI) / 180;
  return { x: pos.x + (u * Math.cos(r) - v * Math.sin(r)) * 1000, y: pos.y + (u * Math.sin(r) + v * Math.cos(r)) * 1000 };
}

export function furnitureGaps(pos: { x: number; y: number; rot: number }, dims: FootDims, room: Vec2[], wallHalf = 60): FurnitureGaps {
  const r = (pos.rot * Math.PI) / 180;
  const uDir = { x: Math.cos(r), y: Math.sin(r) };
  const vDir = { x: -Math.sin(r), y: Math.cos(r) };
  const neg = (a: Vec2): Vec2 => ({ x: -a.x, y: -a.y });
  const gap = (from: Vec2, dir: Vec2): number | null => {
    const t = rayToPolygon(from, dir, room);
    return t == null ? null : Math.max(0, Math.round(t - wallHalf));
  };
  const { w, d, v0 } = dims;
  return {
    back: gap(furnitureLocalToPlan(pos, 0, v0), neg(vDir)),
    front: gap(furnitureLocalToPlan(pos, 0, v0 + d), vDir),
    sideA: gap(furnitureLocalToPlan(pos, -w / 2, v0 + d / 2), neg(uDir)),
    sideB: gap(furnitureLocalToPlan(pos, w / 2, v0 + d / 2), uDir),
  };
}

/** 窓・戸の両側の空き: 壁の始点側は手前の窓・戸の端（無ければ壁の端 0）まで、終点側は次の窓・戸（無ければ壁の端 L）まで */
export function openingGaps(op: Pick<Opening, 'id' | 'wallId' | 't0' | 't1'>, wallLen: number, others: Pick<Opening, 'id' | 'wallId' | 't0' | 't1'>[]): { lo: number; hi: number; left: number; right: number } {
  let lo = 0;
  let hi = wallLen;
  for (const o of others) {
    if (o.wallId !== op.wallId || o.id === op.id) continue;
    if (o.t1 <= op.t0 + 1) lo = Math.max(lo, o.t1);
    else if (o.t0 >= op.t1 - 1) hi = Math.min(hi, o.t0);
  }
  return { lo, hi, left: Math.max(0, Math.round(op.t0 - lo)), right: Math.max(0, Math.round(hi - op.t1)) };
}

/** mm の表示（3 桁区切り） */
export const mmText = (v: number) => Math.round(v).toLocaleString();
