/**
 * 階段を「物」として動かす・回す（3D の「階段」の道具。ARCHITREND ZERO の操作感: 階段をクリック → ドラッグで移動、90° 回す）。
 *
 * - 上下の階の同じ位置にある階段（1 階の UP と 2 階の DN）は 1 つの階段なので、一緒に動かす・回す
 * - 回す: 外形を中心で 90° 回し（幅と奥行が入れ替わる）、昇り口の辺も同じだけ回す。曲がる向き（昇る人から見て左右）は変わらない
 * - 動かす・回した後は、方眼の格子（通り芯の位相）に角をそろえる
 */
import type { BuildingModel, Floor, Stair, Wall } from './types';

export interface StairRef {
  f: Floor;
  st: Stair;
}

/** 同じ階段の上下の片割れ（UP の上の階の DN、DN の下の階の UP。角が 300 mm 以内） */
export function linkedStairs(model: Pick<BuildingModel, 'floors'>, level: number, st: Stair): StairRef[] {
  const other = model.floors.find((f) => f.level === (st.goesUp ? level + 1 : level - 1));
  if (!other) return [];
  return other.stairs.filter((s) => s.id !== st.id && s.goesUp !== st.goesUp && Math.abs(s.minX - st.minX) < 300 && Math.abs(s.minY - st.minY) < 300).map((s) => ({ f: other, st: s }));
}

/** 点（図面座標 mm）を含む階段（外形 ± tol）。いちばん小さいもの */
export function stairAtPoint(f: Pick<Floor, 'stairs'>, p: { x: number; y: number }, tol = 60): Stair | null {
  const hits = f.stairs.filter((s) => p.x >= s.minX - tol && p.x <= s.maxX + tol && p.y >= s.minY - tol && p.y <= s.maxY + tol);
  hits.sort((a, b) => (a.maxX - a.minX) * (a.maxY - a.minY) - (b.maxX - b.minX) * (b.maxY - b.minY));
  return hits[0] ?? null;
}

const ORDER: Stair['entry'][] = ['n', 'e', 's', 'w'];

/** 昇り口の辺を 90° 回す（dir = 1 で図面の時計回り: 北 → 東 → 南 → 西） */
export function rotateEntry(entry: Stair['entry'], dir: 1 | -1): Stair['entry'] {
  return ORDER[(ORDER.indexOf(entry) + (dir === 1 ? 1 : 3)) % 4];
}

/** 格子（位相 phase・間隔 step）のいちばん近い線 */
export function snapToGrid(v: number, phase: number, step: number): number {
  return phase + Math.round((v - phase) / step) * step;
}

export interface StairGrid {
  step: number;
  phaseX: number;
  phaseY: number;
}

/**
 * 外形を中心で 90° 回す。幅と奥行が入れ替わり、昇り口の辺も回る。grid があれば左上の角を格子にそろえる
 * （中心で回すと、幅と奥行の差の半分だけ角が格子から外れるため）
 */
export function rotateStair(st: Stair, dir: 1 | -1, grid?: StairGrid | null) {
  const cx = (st.minX + st.maxX) / 2;
  const cy = (st.minY + st.maxY) / 2;
  const w = st.maxX - st.minX;
  const d = st.maxY - st.minY;
  let minX = cx - d / 2;
  let minY = cy - w / 2;
  if (grid) {
    minX = snapToGrid(minX, grid.phaseX, grid.step);
    minY = snapToGrid(minY, grid.phaseY, grid.step);
  }
  st.minX = Math.round(minX);
  st.minY = Math.round(minY);
  st.maxX = st.minX + d;
  st.maxY = st.minY + w;
  st.entry = rotateEntry(st.entry, dir);
}

/** 動かした後の左上の角（格子にそろえる。grid が無ければ 10 mm 単位） */
export function movedCorner(o: { minX: number; minY: number }, dx: number, dy: number, grid?: StairGrid | null): { minX: number; minY: number } {
  const x = o.minX + dx;
  const y = o.minY + dy;
  if (!grid) return { minX: Math.round(x / 10) * 10, minY: Math.round(y / 10) * 10 };
  return { minX: snapToGrid(x, grid.phaseX, grid.step), minY: snapToGrid(y, grid.phaseY, grid.step) };
}

/** 階段を左上の角が (minX, minY) になるよう動かす（大きさはそのまま） */
export function placeStair(st: Stair, minX: number, minY: number) {
  const w = st.maxX - st.minX;
  const d = st.maxY - st.minY;
  st.minX = minX;
  st.minY = minY;
  st.maxX = minX + w;
  st.maxY = minY + d;
}

/**
 * 階の外形（外周の壁芯の範囲）からはみ出した階段を中へ寄せる（回した直後: 外壁沿いの長い直階段を中心で回すと外へ出るため）。
 * 寄せた量 {dx, dy} を返す（はみ出していなければ 0）
 */
export function keepInsideFloor(f: Pick<Floor, 'walls' | 'outline'>, st: Stair): { dx: number; dy: number } {
  const pts = f.outline.flat().length ? f.outline.flat() : f.walls.filter((w) => w.exterior).flatMap((w) => [w.a, w.b]);
  if (pts.length < 3) return { dx: 0, dy: 0 };
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const w = st.maxX - st.minX;
  const d = st.maxY - st.minY;
  let dx = 0;
  let dy = 0;
  if (w <= maxX - minX) dx = st.minX < minX ? minX - st.minX : st.maxX > maxX ? maxX - st.maxX : 0;
  if (d <= maxY - minY) dy = st.minY < minY ? minY - st.minY : st.maxY > maxY ? maxY - st.maxY : 0;
  if (dx || dy) placeStair(st, st.minX + dx, st.minY + dy);
  return { dx, dy };
}

/** 線分が長方形（内側に margin だけ縮めたもの）の中を通るか */
function segmentCrossesRect(a: { x: number; y: number }, b: { x: number; y: number }, r: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  if (r.maxX <= r.minX || r.maxY <= r.minY) return false;
  // Liang–Barsky
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-9) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, a.x - r.minX) && clip(dx, r.maxX - a.x) && clip(-dy, a.y - r.minY) && clip(dy, r.maxY - a.y) && t1 - t0 > 1e-6;
}

/** 階段の中を通る壁（外形の縁に沿う壁は除く: 内側に margin 縮めた範囲で判定） */
export function wallsThroughStair(f: Pick<Floor, 'walls'>, st: Stair, margin = 120): Wall[] {
  const r = { minX: st.minX + margin, minY: st.minY + margin, maxX: st.maxX - margin, maxY: st.maxY - margin };
  return f.walls.filter((w) => segmentCrossesRect(w.a, w.b, r));
}
