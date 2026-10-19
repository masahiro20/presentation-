/**
 * 木造のモジュール（尺 910 / メーター 1000）
 *
 * 在来木造の平面図は、柱の芯（= 壁芯）が半間 455mm（メーターモジュールなら 500mm）の格子に乗る。
 * 読み取った壁芯の位置からその格子の位相と適合度を求め、格子に乗っている図面は壁芯・部屋・外形を格子へ寄せる。
 * 1/100 の図面でも線の太さ・読み取りの丸めで数十 mm はずれるので、寄せた後は寸法が 910 の倍数（3,640・2,730…）にそろう。
 */
import type { Floor, ModuleInfo, Vec2 } from '../core/types';

export type ModuleMode = 'auto' | 'shaku' | 'meter' | 'none';

export interface AxisWall {
  a: Vec2;
  b: Vec2;
}

/** 壁芯を格子に寄せる許容ずれ（これ以上ずれた壁は格子に乗っていないとみなしてそのまま） */
export function snapTolerance(grid: number): number {
  return Math.min(110, grid * 0.25);
}
/** 壁の端（他の壁の芯 ± 柱半分の位置で止まっている）を寄せる許容ずれ */
export function endTolerance(grid: number): number {
  return Math.min(200, grid * 0.44);
}

export function snapCoord(v: number, phase: number, grid: number): number {
  return phase + Math.round((v - phase) / grid) * grid;
}

/** 位置の集まり（重み付き）から格子の位相と適合度を求める */
function fitAxis(items: { v: number; w: number }[], grid: number): { phase: number; fit: number; onGrid: number; weight: number } {
  let S = 0;
  let C = 0;
  let W = 0;
  for (const it of items) {
    const a = (2 * Math.PI * it.v) / grid;
    S += it.w * Math.sin(a);
    C += it.w * Math.cos(a);
    W += it.w;
  }
  if (W <= 0) return { phase: 0, fit: 0, onGrid: 0, weight: 0 };
  let phase = (Math.atan2(S, C) * grid) / (2 * Math.PI);
  phase = ((phase % grid) + grid) % grid;
  const tol = snapTolerance(grid);
  let on = 0;
  for (const it of items) if (Math.abs(snapCoord(it.v, phase, grid) - it.v) <= tol) on += it.w;
  return { phase, fit: Math.hypot(S, C) / W, onGrid: on / W, weight: W };
}

export interface ModuleFit {
  size: 910 | 1000;
  grid: number;
  phaseX: number;
  phaseY: number;
  /** 格子に乗っている壁の長さの割合（縦横の壁の合計） */
  onGrid: number;
  /** 位相のそろい具合 0..1 */
  fit: number;
  /** 判定に使った壁の本数 */
  walls: number;
}

const AXIS_EPS = 0.02;

/** 縦横の壁の芯の位置から、モジュール（半間 455 / 500 の格子）の位相と適合度を求める */
export function fitModule(walls: AxisWall[], size: 910 | 1000): ModuleFit {
  const grid = size / 2;
  const xs: { v: number; w: number }[] = [];
  const ys: { v: number; w: number }[] = [];
  let n = 0;
  for (const w of walls) {
    const dx = w.b.x - w.a.x;
    const dy = w.b.y - w.a.y;
    const L = Math.hypot(dx, dy);
    if (L < 300) continue;
    if (Math.abs(dy) < L * AXIS_EPS) {
      ys.push({ v: (w.a.y + w.b.y) / 2, w: L });
      n++;
    } else if (Math.abs(dx) < L * AXIS_EPS) {
      xs.push({ v: (w.a.x + w.b.x) / 2, w: L });
      n++;
    }
  }
  const fx = fitAxis(xs, grid);
  const fy = fitAxis(ys, grid);
  const W = fx.weight + fy.weight;
  return {
    size,
    grid,
    phaseX: fx.phase,
    phaseY: fy.phase,
    onGrid: W ? (fx.onGrid * fx.weight + fy.onGrid * fy.weight) / W : 0,
    fit: W ? (fx.fit * fx.weight + fy.fit * fy.weight) / W : 0,
    walls: n,
  };
}

/** 格子へ寄せてよいと判断する基準 */
export function moduleAcceptable(m: ModuleFit): boolean {
  return m.walls >= 6 && m.onGrid >= 0.7 && m.fit >= 0.55;
}

/**
 * モジュールの判定。auto は尺・メーターのうち適合の良い方（どちらも乗っていなければ null）、
 * shaku / meter はその格子を使う（乗っていない壁はそのまま）、none は寄せない
 */
export function chooseModule(walls: AxisWall[], mode: ModuleMode): ModuleFit | null {
  if (mode === 'none') return null;
  if (mode === 'shaku') return fitModule(walls, 910);
  if (mode === 'meter') return fitModule(walls, 1000);
  const s = fitModule(walls, 910);
  const m = fitModule(walls, 1000);
  const okS = moduleAcceptable(s);
  const okM = moduleAcceptable(m);
  if (!okS && !okM) return null;
  if (okS && !okM) return s;
  if (okM && !okS) return m;
  // どちらも乗る（半間 455 と 500 の公倍数は 4,550 なので、ふつうは片方だけ乗る）: 適合の高い方
  return s.onGrid + s.fit * 0.5 >= m.onGrid + m.fit * 0.5 ? s : m;
}

export function moduleInfoOf(m: ModuleFit, source: 'auto' | 'manual', snapped: boolean): ModuleInfo {
  return { size: m.size, grid: m.grid, phaseX: m.phaseX, phaseY: m.phaseY, fit: Math.round(m.onGrid * 1000) / 1000, snapped, source };
}

/** 位相を平行移動（原点を移した後に呼ぶ） */
export function translateModule(mi: ModuleInfo, dx: number, dy: number) {
  mi.phaseX = (((mi.phaseX + dx) % mi.grid) + mi.grid) % mi.grid;
  mi.phaseY = (((mi.phaseY + dy) % mi.grid) + mi.grid) % mi.grid;
}

/** 軸平行の矩形（吹抜の×印・階段など）の辺を格子へ寄せる。寄せて小さくなりすぎる（minSize 未満）ときはそのまま */
export function snapRect<T extends { minX: number; minY: number; maxX: number; maxY: number }>(r: T, m: { grid: number; phaseX: number; phaseY: number }, tol: number, minSize: number): T {
  const sx0 = snapCoord(r.minX, m.phaseX, m.grid);
  const sx1 = snapCoord(r.maxX, m.phaseX, m.grid);
  const sy0 = snapCoord(r.minY, m.phaseY, m.grid);
  const sy1 = snapCoord(r.maxY, m.phaseY, m.grid);
  if (Math.abs(sx0 - r.minX) <= tol && Math.abs(sx1 - r.maxX) <= tol && sx1 - sx0 >= minSize) {
    r.minX = sx0;
    r.maxX = sx1;
  }
  if (Math.abs(sy0 - r.minY) <= tol && Math.abs(sy1 - r.maxY) <= tol && sy1 - sy0 >= minSize) {
    r.minY = sy0;
    r.maxY = sy1;
  }
  return r;
}

/** 階段の矩形を格子へ寄せる（階段は柱間に納まる） */
export function snapStairs(f: Floor, m: ModuleInfo) {
  const tol = endTolerance(m.grid);
  for (const s of f.stairs) snapRect(s, m, tol, 700);
}

/** 在来木造の標準の壁厚（柱 105 角）: 外壁 = 柱 + 外装下地・通気層 + 石膏ボード、内壁 = 柱 + 石膏ボード両面 */
export const WOOD_WALL = { exterior: 160, interior: 130, thin: 75 } as const;

/** 木造として壁厚を標準化する（図面の線の太さの違いで階ごとに壁厚が変わらないように） */
export function woodWallThickness(w: { thickness: number; exterior: boolean }): number {
  if (w.exterior) return WOOD_WALL.exterior;
  return w.thickness < 95 ? WOOD_WALL.thin : WOOD_WALL.interior;
}
