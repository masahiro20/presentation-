/**
 * 点群から周辺建物の実測の高さ・屋根を求める（three 非依存の純関数）。
 *
 * 1. 地面: 2m の格子ごとに、地面に分類された点（LAS の分類 2）の最低点。分類が無い点群は格子の最低点から
 *    「オープニング」（周り 12m の最小 → 最大）で屋根・樹木を取り除く。点の無い格子（建物の下など）は周りから埋める。
 * 2. 建物: 足元（ring）の中の点の地面からの高さに、屋根の形（陸屋根・切妻 2 向き・寄棟・片流れ 4 向き）を最小二乗で当てはめ、
 *    いちばん合う形の 軒高・最高高さ を RoofSpec にする（屋根の形は足元の最小外接長方形にかぶせる。roofSpec.ts と同じ）。
 *    煙突・アンテナ・かぶさった枝は、外れ値として 2 回まで除いて当て直す。
 * 3. 樹木: 建物の足元の外で、地面から 2.5m 以上の点（分類があれば植生 3〜5）を 2m の格子でまとめ、つながった塊を 1 本の木にする。
 */
import { minAreaRect, type RoofSpec } from '../plateau';
import type { EN } from '../plateau/types';
import type { HighSide, RoofKind } from '../plateau';
import type { SiteCloud } from './place';

// ---------------------------------------------------------------------------
// 地面
// ---------------------------------------------------------------------------

export interface GroundGrid {
  cell: number;
  minE: number;
  minN: number;
  w: number;
  h: number;
  z: Float32Array;
  /** 分類（地面 = 2）を使ったか */
  classified: boolean;
}

const GROUND_CELL = 2;
/** オープニングの半径 (m)。これより幅の広い建物は屋根が地面に残る（分類のある点群では使わない） */
const OPENING_RADIUS = 12;

const IGNORE = new Set([7, 18]); // 7 = 低いノイズ, 18 = 高いノイズ

export function buildGround(c: SiteCloud): GroundGrid {
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (let i = 0; i < c.count; i++) {
    if (c.e[i] < minE) minE = c.e[i];
    if (c.e[i] > maxE) maxE = c.e[i];
    if (c.n[i] < minN) minN = c.n[i];
    if (c.n[i] > maxN) maxN = c.n[i];
  }
  const cell = GROUND_CELL;
  const w = Math.max(1, Math.ceil((maxE - minE) / cell) + 1);
  const h = Math.max(1, Math.ceil((maxN - minN) / cell) + 1);
  const z = new Float32Array(w * h).fill(Infinity);
  let nGround = 0;
  if (c.cls) for (let i = 0; i < c.count; i++) if (c.cls[i] === 2) nGround++;
  const classified = nGround > c.count * 0.05;
  for (let i = 0; i < c.count; i++) {
    if (c.cls && (IGNORE.has(c.cls[i]) || (classified && c.cls[i] !== 2))) continue;
    const gx = Math.floor((c.e[i] - minE) / cell);
    const gy = Math.floor((c.n[i] - minN) / cell);
    const k = gy * w + gx;
    if (c.z[i] < z[k]) z[k] = c.z[i];
  }
  let grid: Float32Array = z;
  if (!classified) {
    const r = Math.round(OPENING_RADIUS / cell);
    grid = morph(morph(grid, w, h, r, 'min'), w, h, r, 'max');
  }
  fillHoles(grid, w, h);
  return { cell, minE, minN, w, h, z: grid, classified };
}

/** 縦横に分けた最小・最大フィルタ（Infinity = 点なし は無視） */
function morph(src: Float32Array, w: number, h: number, r: number, op: 'min' | 'max'): Float32Array {
  const better = op === 'min' ? (a: number, b: number) => a < b : (a: number, b: number) => a > b;
  const pass = (a: Float32Array, horiz: boolean) => {
    const out = new Float32Array(a.length).fill(Infinity);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let d = -r; d <= r; d++) {
          const xx = horiz ? x + d : x;
          const yy = horiz ? y : y + d;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const v = a[yy * w + xx];
          if (v === Infinity) continue;
          if (best === Infinity || better(v, best)) best = v;
        }
        // 最大側は点の無い格子を埋めない（オープニングで地面を広げすぎない）
        out[y * w + x] = op === 'max' && a[y * w + x] === Infinity && src[y * w + x] === Infinity ? Infinity : best;
      }
    return out;
  };
  return pass(pass(src, true), false);
}

/** 点の無い格子を、周りの値の平均で外へ向かって埋める */
function fillHoles(z: Float32Array, w: number, h: number) {
  let empty = 0;
  for (let i = 0; i < z.length; i++) if (z[i] === Infinity) empty++;
  if (empty === z.length) {
    z.fill(0);
    return;
  }
  for (let iter = 0; empty > 0 && iter < 400; iter++) {
    const next = z.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (z[k] !== Infinity) continue;
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const v = z[yy * w + xx];
            if (v !== Infinity) {
              s += v;
              n++;
            }
          }
        if (n) {
          next[k] = s / n;
          empty--;
        }
      }
    z.set(next);
  }
}

/** 地面の高さ（双一次補間） */
export function groundAt(g: GroundGrid, e: number, n: number): number {
  const fx = Math.min(g.w - 1, Math.max(0, (e - g.minE) / g.cell - 0.5));
  const fy = Math.min(g.h - 1, Math.max(0, (n - g.minN) / g.cell - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(g.w - 1, x0 + 1);
  const y1 = Math.min(g.h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v = (x: number, y: number) => g.z[y * g.w + x];
  return (v(x0, y0) * (1 - tx) + v(x1, y0) * tx) * (1 - ty) + (v(x0, y1) * (1 - tx) + v(x1, y1) * tx) * ty;
}

// ---------------------------------------------------------------------------
// 点の索引（1m 格子のバケツ）
// ---------------------------------------------------------------------------

export class PointIndex {
  readonly cell = 1;
  private start: Int32Array;
  private items: Int32Array;
  private minE: number;
  private minN: number;
  private w: number;
  private h: number;
  constructor(private c: SiteCloud) {
    let minE = Infinity;
    let maxE = -Infinity;
    let minN = Infinity;
    let maxN = -Infinity;
    for (let i = 0; i < c.count; i++) {
      minE = Math.min(minE, c.e[i]);
      maxE = Math.max(maxE, c.e[i]);
      minN = Math.min(minN, c.n[i]);
      maxN = Math.max(maxN, c.n[i]);
    }
    if (!c.count) minE = maxE = minN = maxN = 0;
    this.minE = minE;
    this.minN = minN;
    this.w = Math.ceil(maxE - minE) + 1;
    this.h = Math.ceil(maxN - minN) + 1;
    const counts = new Int32Array(this.w * this.h + 1);
    const key = new Int32Array(c.count);
    for (let i = 0; i < c.count; i++) {
      const k = Math.floor(c.n[i] - minN) * this.w + Math.floor(c.e[i] - minE);
      key[i] = k;
      counts[k + 1]++;
    }
    for (let k = 1; k < counts.length; k++) counts[k] += counts[k - 1];
    this.start = counts;
    this.items = new Int32Array(c.count);
    const fill = counts.slice();
    for (let i = 0; i < c.count; i++) this.items[fill[key[i]]++] = i;
  }
  /** 範囲 [e0,e1]×[n0,n1] に入る格子の点を順に */
  forEachIn(e0: number, e1: number, n0: number, n1: number, fn: (i: number) => void) {
    const x0 = Math.max(0, Math.floor(e0 - this.minE));
    const x1 = Math.min(this.w - 1, Math.floor(e1 - this.minE));
    const y0 = Math.max(0, Math.floor(n0 - this.minN));
    const y1 = Math.min(this.h - 1, Math.floor(n1 - this.minN));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const k = y * this.w + x;
        for (let j = this.start[k]; j < this.start[k + 1]; j++) fn(this.items[j]);
      }
  }
}

export function pointInRing(e: number, n: number, ring: EN[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.n > n !== b.n > n && e < ((b.e - a.e) * (n - a.n)) / (b.n - a.n) + a.e) inside = !inside;
  }
  return inside;
}

function ringArea(ring: EN[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.e * b.n - b.e * a.n;
  }
  return Math.abs(s) / 2;
}

// ---------------------------------------------------------------------------
// 屋根の当てはめ
// ---------------------------------------------------------------------------

export interface RoofFit {
  spec: RoofSpec;
  /** 使った点の数・足元 1㎡ あたりの点の数 */
  points: number;
  density: number;
  /** 当てはめの誤差 (m) */
  rmse: number;
  /** 足元の地面の高さ（ファイルの高さ） */
  base: number;
}

export type FitSkip = { skip: 'few' | 'low' | 'sparse'; points: number };

interface Candidate {
  kind: RoofKind;
  ridgeDir?: 'long' | 'short';
  highSide?: HighSide;
  /** 0 = 棟（最も高い）〜 1 = 軒 */
  f: (u: number, v: number, e: number, n: number) => number;
  penalty: number;
}

const HIGH_VEC: Record<HighSide, EN> = { N: { e: 0, n: 1 }, E: { e: 1, n: 0 }, S: { e: 0, n: -1 }, W: { e: -1, n: 0 } };

/** 1 棟の点（足元の中、地面からの高さ h）に屋根の形を当てはめる */
export function fitRoof(ring: EN[], pts: { e: number; n: number; h: number }[], boxHeight: number): RoofFit | FitSkip {
  const area = Math.max(1, ringArea(ring));
  if (pts.length < 8) return { skip: 'few', points: pts.length };
  const rect = minAreaRect(ring);
  if (!rect) return { skip: 'few', points: pts.length };
  const hl = rect.long / 2;
  const hs = rect.short / 2;
  const vx = -rect.uy;
  const vy = rect.ux;
  const local = pts.map((p) => {
    const de = p.e - rect.cx;
    const dn = p.n - rect.cy;
    return { u: de * rect.ux + dn * rect.uy, v: de * vx + dn * vy, e: p.e, n: p.n, h: p.h };
  });
  const half = Math.max(0, hl - hs);
  const corners = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([su, sv]) => ({ e: rect.cx + su * hl * rect.ux + sv * hs * vx, n: rect.cy + su * hl * rect.uy + sv * hs * vy }));
  const cands: Candidate[] = [
    { kind: 'flat', f: () => 0, penalty: 0 },
    { kind: 'gable', ridgeDir: 'long', f: (_u, v) => Math.min(1, Math.abs(v) / hs), penalty: 0.06 },
    { kind: 'gable', ridgeDir: 'short', f: (u) => Math.min(1, Math.abs(u) / hl), penalty: 0.08 },
    { kind: 'hip', f: (u, v) => Math.min(1, Math.max(Math.abs(v) / hs, (Math.abs(u) - half) / hs)), penalty: 0.07 },
    ...(['N', 'E', 'S', 'W'] as HighSide[]).map((side): Candidate => {
      const d = HIGH_VEC[side];
      const proj = corners.map((c) => c.e * d.e + c.n * d.n);
      const lo = Math.min(...proj);
      const hi = Math.max(...proj);
      return { kind: 'shed', highSide: side, f: (_u, _v, e, n) => (hi - lo < 1e-6 ? 0 : Math.min(1, Math.max(0, (hi - (e * d.e + n * d.n)) / (hi - lo)))), penalty: 0.1 };
    }),
  ];
  let best: { c: Candidate; a: number; b: number; rmse: number; score: number; n: number } | null = null;
  for (const c of cands) {
    const fs = local.map((p) => c.f(p.u, p.v, p.e, p.n));
    let use = local.map(() => true);
    let a = 0;
    let b = 0;
    let rmse = Infinity;
    for (let iter = 0; iter < 3; iter++) {
      let n = 0;
      let sf = 0;
      let sz = 0;
      let sff = 0;
      let sfz = 0;
      for (let i = 0; i < local.length; i++) {
        if (!use[i]) continue;
        n++;
        sf += fs[i];
        sz += local[i].h;
        sff += fs[i] * fs[i];
        sfz += fs[i] * local[i].h;
      }
      if (n < 6) break;
      const varF = sff / n - (sf / n) ** 2;
      // z = a − b·f（b ≥ 0: 棟が高い）
      b = varF > 1e-6 ? Math.max(0, -(sfz / n - (sf / n) * (sz / n)) / varF) : 0;
      a = sz / n + (b * sf) / n;
      // 陸屋根は中央値（縁の立ち上がり・塔屋に引っ張られない）
      if (c.kind === 'flat') {
        const hs2 = local.filter((_, i) => use[i]).map((p) => p.h).sort((x, y) => x - y);
        a = hs2[Math.floor(hs2.length / 2)];
        b = 0;
      }
      let se = 0;
      for (let i = 0; i < local.length; i++) if (use[i]) se += (local[i].h - (a - b * fs[i])) ** 2;
      rmse = Math.sqrt(se / n);
      // 外れ値（煙突・アンテナ・枝・壁ぎわの低い点）を除いて当て直す
      const lim = Math.max(0.6, 2.5 * rmse);
      use = local.map((p, i) => Math.abs(p.h - (a - b * fs[i])) <= lim);
    }
    const nUse = use.filter(Boolean).length;
    // 外れ値として捨てた点が多い形は合っていない
    const outFrac = 1 - nUse / local.length;
    const score = rmse + c.penalty + outFrac * 1.5;
    if (Number.isFinite(rmse) && (!best || score < best.score)) best = { c, a, b, rmse, score, n: nUse };
  }
  if (!best) return { skip: 'few', points: pts.length };
  let { a, b } = best;
  let c = best.c;
  // 勾配の無い屋根・急すぎる屋根（10 寸超）は陸屋根に
  const run = c.kind === 'gable' && c.ridgeDir === 'short' ? hl : c.kind === 'shed' ? rect.short : hs;
  if (c.kind !== 'flat' && (b < 0.35 || b / Math.max(0.5, run) > 1.0)) {
    c = cands[0];
    const hsAll = local.map((p) => p.h).sort((x, y) => x - y);
    a = hsAll[Math.floor(hsAll.length / 2)];
    b = 0;
  }
  const hsSorted = local.map((p) => p.h).sort((x, y) => x - y);
  const p95 = hsSorted[Math.floor(hsSorted.length * 0.95)];
  let eave = a - b;
  let ridge = a;
  let parapet: number | undefined;
  if (c.kind === 'flat') {
    eave = a;
    // 屋上の縁の立ち上がり（パラペット）: 上位 5% が屋上面より 0.5m 以上高ければ
    parapet = p95 - eave > 0.5 && p95 - eave < 2 ? Math.round((p95 - eave) * 10) / 10 : 0;
    ridge = eave + parapet;
  }
  if (ridge < 2) return { skip: 'low', points: pts.length };
  const density = pts.length / area;
  if (density < 0.25) return { skip: 'sparse', points: pts.length };
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const spec: RoofSpec = { kind: c.kind, eave: r2(Math.max(1.5, eave)), ridge: r2(ridge), boxHeight, lidar: true };
  if (c.ridgeDir) spec.ridgeDir = c.ridgeDir;
  if (c.highSide) spec.highSide = c.highSide;
  if (parapet !== undefined) spec.parapet = parapet;
  return { spec, points: best.n, density, rmse: r2(best.rmse), base: 0 };
}

/** 1 棟分の点を集める: 足元の中・ノイズと地面を除く・地面から 1m 以上。分類に建物（6）があれば建物の点だけ */
export function buildingPoints(c: SiteCloud, idx: PointIndex, ground: GroundGrid, ring: EN[]): { pts: { e: number; n: number; h: number }[]; base: number } {
  let e0 = Infinity;
  let e1 = -Infinity;
  let n0 = Infinity;
  let n1 = -Infinity;
  for (const p of ring) {
    e0 = Math.min(e0, p.e);
    e1 = Math.max(e1, p.e);
    n0 = Math.min(n0, p.n);
    n1 = Math.max(n1, p.n);
  }
  // 足元の地面: 輪郭の頂点と重心の地面の高さの中央値（傾斜地でも足元の平均に近い）
  const samples = ring.map((p) => groundAt(ground, p.e, p.n));
  samples.push(groundAt(ground, (e0 + e1) / 2, (n0 + n1) / 2));
  samples.sort((x, y) => x - y);
  const base = samples[Math.floor(samples.length / 2)];
  const all: { e: number; n: number; h: number; c: number }[] = [];
  idx.forEachIn(e0, e1, n0, n1, (i) => {
    const cl = c.cls ? c.cls[i] : 0;
    if (cl === 2 || IGNORE.has(cl) || cl === 9) return;
    const e = c.e[i];
    const n = c.n[i];
    if (!pointInRing(e, n, ring)) return;
    const h = c.z[i] - base;
    if (h < 1) return;
    all.push({ e, n, h, c: cl });
  });
  const bld = all.filter((p) => p.c === 6);
  const pts = bld.length >= Math.max(8, all.length * 0.3) ? bld : all.filter((p) => p.c < 3 || p.c > 5 || !c.cls);
  return { pts: pts.length >= 8 ? pts : all, base };
}

export interface CloudBuilding {
  key: string;
  ring: EN[];
  height: number;
}

export interface CloudFitResult {
  fits: Map<string, RoofFit>;
  skipped: Map<string, FitSkip>;
  trees: CloudTree[];
  ground: GroundGrid;
}

/** 周辺建物に当てはめる。mask = 木を探さない足元（当てはめない建物も含めた全棟）、exclude = 計画地 */
export function fitBuildings(c: SiteCloud, buildings: CloudBuilding[], mask: CloudBuilding[] = buildings, exclude: EN[] | null = null): CloudFitResult {
  const ground = buildGround(c);
  const idx = new PointIndex(c);
  const fits = new Map<string, RoofFit>();
  const skipped = new Map<string, FitSkip>();
  for (const b of buildings) {
    if (b.ring.length < 3) continue;
    const { pts, base } = buildingPoints(c, idx, ground, b.ring);
    const r = fitRoof(b.ring, pts, b.height);
    if ('skip' in r) skipped.set(b.key, r);
    else fits.set(b.key, { ...r, base });
  }
  // 計画地（建て替える敷地）の中の木は数えない
  const trees = findTrees(c, idx, ground, exclude && exclude.length >= 3 ? [...mask, { key: '__site', ring: exclude, height: 0 }] : mask);
  return { fits, skipped, trees, ground };
}

// ---------------------------------------------------------------------------
// 樹木
// ---------------------------------------------------------------------------

export interface CloudTree {
  e: number;
  n: number;
  /** 樹冠の半径・樹高・枝下の高さ (m、地面から) */
  radius: number;
  height: number;
  crownBase: number;
}

const TREE_CELL = 2;
const TREE_MIN_H = 2.5;

export function findTrees(c: SiteCloud, idx: PointIndex, ground: GroundGrid, buildings: CloudBuilding[]): CloudTree[] {
  void idx;
  const g = ground;
  const w = Math.ceil((g.w * g.cell) / TREE_CELL) + 1;
  const h = Math.ceil((g.h * g.cell) / TREE_CELL) + 1;
  const top = new Float32Array(w * h);
  const low = new Float32Array(w * h).fill(Infinity);
  const cnt = new Int32Array(w * h);
  // 植生に分類された点群（高い木 = 5・中くらい = 4 がある）なら植生の点だけ。地面と「その他」しかない点群（東京都の区部など）は、
  // 建物の足元の外で、格子の中の高低差が大きい（枝葉は上下に散らばる・屋根は平ら）所を木とみる
  let nVeg = 0;
  let nAbove = 0;
  if (c.cls)
    for (let i = 0; i < c.count; i++) {
      const cl = c.cls[i];
      if (cl === 4 || cl === 5) nVeg++;
      if (cl !== 2) nAbove++;
    }
  const vegClass = nVeg > nAbove * 0.01 && nVeg > 50;
  // 建物の足元（と 1 格子 = 2m の余白: 軒・樋）の中の点は木にしない
  const inBld = new Uint8Array(w * h);
  for (const b of buildings) {
    let e0 = Infinity;
    let e1 = -Infinity;
    let n0 = Infinity;
    let n1 = -Infinity;
    for (const p of b.ring) {
      e0 = Math.min(e0, p.e);
      e1 = Math.max(e1, p.e);
      n0 = Math.min(n0, p.n);
      n1 = Math.max(n1, p.n);
    }
    for (let y = Math.max(0, Math.floor((n0 - g.minN) / TREE_CELL)); y <= Math.min(h - 1, Math.floor((n1 - g.minN) / TREE_CELL)); y++)
      for (let x = Math.max(0, Math.floor((e0 - g.minE) / TREE_CELL)); x <= Math.min(w - 1, Math.floor((e1 - g.minE) / TREE_CELL)); x++) {
        const ce = g.minE + (x + 0.5) * TREE_CELL;
        const cn = g.minN + (y + 0.5) * TREE_CELL;
        if (!pointInRing(ce, cn, b.ring)) continue;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h) inBld[yy * w + xx] = 1;
          }
      }
  }
  const veg = new Uint8Array(w * h);
  for (let i = 0; i < c.count; i++) {
    const cl = c.cls ? c.cls[i] : 0;
    if (vegClass ? cl < 3 || cl > 5 : cl === 2 || cl === 6 || IGNORE.has(cl) || cl === 9) continue;
    const hh = c.z[i] - groundAt(g, c.e[i], c.n[i]);
    if (hh < 0.5 || hh > 40) continue;
    const x = Math.floor((c.e[i] - g.minE) / TREE_CELL);
    const y = Math.floor((c.n[i] - g.minN) / TREE_CELL);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const k = y * w + x;
    if (inBld[k]) continue;
    if (cl >= 3 && cl <= 5) veg[k] = 1;
    if (hh < TREE_MIN_H && !(cl >= 3 && cl <= 5)) continue;
    cnt[k]++;
    if (hh > top[k]) top[k] = hh;
    if (hh < low[k]) low[k] = hh;
  }
  const isTree = (k: number) => cnt[k] >= 3 && top[k] >= TREE_MIN_H && (vegClass || veg[k] === 1 || top[k] - low[k] >= 2);
  // つながった塊（8 近傍）
  const seen = new Uint8Array(w * h);
  const trees: CloudTree[] = [];
  for (let k0 = 0; k0 < w * h; k0++) {
    if (seen[k0] || !isTree(k0)) continue;
    const stack = [k0];
    seen[k0] = 1;
    const cells: number[] = [];
    while (stack.length) {
      const k = stack.pop()!;
      cells.push(k);
      const x = k % w;
      const y = (k - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const kk = yy * w + xx;
          if (!seen[kk] && isTree(kk)) {
            seen[kk] = 1;
            stack.push(kk);
          }
        }
    }
    if (cells.length < 2 && !vegClass) continue;
    // 大きな塊（並木・林）は 3 格子（6m）ごとに分けて木を並べる
    const groups = new Map<string, number[]>();
    for (const k of cells) {
      const x = k % w;
      const y = (k - x) / w;
      const id = `${Math.floor(x / 3)},${Math.floor(y / 3)}`;
      (groups.get(id) ?? groups.set(id, []).get(id)!).push(k);
    }
    for (const g2 of groups.values()) {
      let se = 0;
      let sn = 0;
      let ht = 0;
      let base = Infinity;
      for (const k of g2) {
        const x = k % w;
        const y = (k - x) / w;
        se += g.minE + (x + 0.5) * TREE_CELL;
        sn += g.minN + (y + 0.5) * TREE_CELL;
        ht = Math.max(ht, top[k]);
        base = Math.min(base, low[k]);
      }
      const radius = Math.max(1.2, Math.min(6, Math.sqrt((g2.length * TREE_CELL * TREE_CELL) / Math.PI)));
      trees.push({ e: se / g2.length, n: sn / g2.length, radius: Math.round(radius * 10) / 10, height: Math.round(ht * 10) / 10, crownBase: Math.round(Math.min(ht * 0.6, Math.max(1.2, base)) * 10) / 10 });
    }
  }
  return trees;
}
