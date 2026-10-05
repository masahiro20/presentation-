/**
 * 3D データ（PlacedModel）を実在の場所へ正確に合わせる糊: 外形の切り出し、2 点合わせ、敷地の輪郭へのフィット、
 * 向きだけの合わせ、ピンが動いたときの再計算、配置の説明文。純粋な計算は src/sun/align.ts。
 *
 * 座標の規約:
 *   pivot ローカル EN: a = x, b = −z（m。水平中心 0・底面 y = 0。単位・上方向・反転を適用済み）
 *   ワールド EN（ピンからの東・北 m）: e = offsetE + a·cos h + b·sin h,  n = offsetN − a·sin h + b·cos h  (h = headingDeg)
 *   これは align.ts の applyFit({ rotDeg: headingDeg, te: offsetE, tn: offsetN, scale: 1 }, { e: a, n: b }) と同じ。
 *
 * このモジュールは importModel.ts から（sectionOutline / localToEN を）使われるので、importModel.ts を実行時に import しない
 * （PlacedModel は型としてだけ使う）。
 */
import {
  applyFit,
  centroid,
  closestPointOnPolygon,
  convexHull,
  densifyBudget,
  dominantAngleDeg,
  fitPolygonToPolygon,
  fitRectToRect,
  invertFit,
  minAreaRect,
  normDeg180,
  pointInPolygon,
  polygonArea,
  polygonPerimeter,
  solveRigid,
  solveTwoPoint,
} from '../sun/align';
import type { RigidFit } from '../sun/align';
import type { PlacedModel } from './importModel';
import { UNIT_METERS, frameFromLocal, frameToLocal } from './types';
import type { AlignmentPair, EN, GeoFrame, LatLon, MeasurePoint, ModelPlacement, PlacementAlignment } from './types';

/** 計測した寸法の比がこれ以上 1 からずれていたら単位を疑う */
export const SCALE_WARN = 0.03;
/** 敷地の輪郭へのフィットで「同点」とみなす残差の差 (m)。180° 対称な敷地では今の向きに近い候補を採る */
const FIT_TIE_M = 0.02;
/**
 * 敷地の輪郭へのフィットで ICP を行う、3DS の敷地と描いた輪郭の周長の比の範囲。
 * これを外れる（2 倍以上違う）ときは単位違いがほぼ確実なので、ICP（収束しない上に点が増えて重い）はせず
 * 最小外接矩形の向きと中心だけ合わせ、単位の確認を促す
 */
export const SITE_SCALE_RANGE = { min: 0.5, max: 2 } as const;
/** 描いた輪郭の凸包の面積がこれ以上（比）大きければ「凹みのある敷地」とみなす */
const CONCAVE_AREA_RATIO = 1.05;

const r2 = (v: number) => Math.round(v * 100) / 100;
const fmtM = (v: number | undefined) => (Number.isFinite(v) ? (v as number).toFixed(2) : '—');

/** 1 モデル単位の長さ (m)。importModel.unitScale と同じ計算（循環 import を避けるためここでも持つ） */
export function unitScaleOf(p: Pick<ModelPlacement, 'unit' | 'customScale'>): number {
  if (p.unit === 'custom') return Number.isFinite(p.customScale) && p.customScale > 0 ? p.customScale : 1;
  return UNIT_METERS[p.unit] ?? 1;
}

// ---------------------------------------------------------------------------
// pivot ローカル EN ⇄ ワールド EN
// ---------------------------------------------------------------------------

/** 配置（方位・位置）を align.ts の変換として表す（倍率 1） */
export function placementFit(p: Pick<ModelPlacement, 'headingDeg' | 'offsetE' | 'offsetN'>): RigidFit {
  return { rotDeg: p.headingDeg, te: p.offsetE, tn: p.offsetN, scale: 1, scaleRatio: 1, rmsM: 0 };
}

/** pivot ローカル EN → ワールド EN（ピンからの東・北 m） */
export function localToEN(p: Pick<ModelPlacement, 'headingDeg' | 'offsetE' | 'offsetN'>, a: EN): EN {
  return applyFit(placementFit(p), a);
}

/** ワールド EN → pivot ローカル EN */
export function enToLocal(p: Pick<ModelPlacement, 'headingDeg' | 'offsetE' | 'offsetN'>, q: EN): EN {
  return applyFit(invertFit(placementFit(p)), q);
}

// ---------------------------------------------------------------------------
// 外形: 三角形の集まりを水平面で切る
// ---------------------------------------------------------------------------

/**
 * 三角形の集まり（xyz を 9 個ずつ並べた配列）の、高さ帯 [yMin, yMax] での外形（凸包、EN）。
 * 焼き込んだ形は三角形の頂点しか持たない（床から軒までの壁の四角形には途中の頂点が無い）ので、
 * 帯の中の頂点だけでなく、yMin・(yMin+yMax)/2・yMax の 3 つの水平面と各辺の交点も加える（窓台・まぐさだけに偏らない）。
 * 帯に 3 点未満しか無ければ、全頂点の凸包に戻る。toEN の既定は (x, _, z) → { e: x, n: −z }（pivot ローカルと同じ）。
 */
export function sectionOutline(positions: ArrayLike<number>, opts: { yMin: number; yMax: number; toEN?: (x: number, y: number, z: number) => EN }): EN[] {
  const toEN = opts.toEN ?? ((x: number, _y: number, z: number): EN => ({ e: x, n: -z }));
  const { yMin, yMax } = opts;
  const cuts: number[] = [];
  for (const c of [yMin, (yMin + yMax) / 2, yMax]) if (Number.isFinite(c) && !cuts.some((d) => Math.abs(d - c) < 1e-9)) cuts.push(c);
  const pts: EN[] = [];
  const n = positions.length;
  const triEnd = Math.floor(n / 9) * 9;
  for (let i = 0; i < triEnd; i += 9) {
    for (let k = 0; k < 3; k++) {
      const a = i + 3 * k;
      const ya = positions[a + 1];
      if (ya >= yMin && ya <= yMax) pts.push(toEN(positions[a], ya, positions[a + 2]));
      const b = i + 3 * ((k + 1) % 3);
      const yb = positions[b + 1];
      for (const c of cuts) {
        if (!((ya - c) * (yb - c) < 0)) continue;
        const t = (c - ya) / (yb - ya);
        pts.push(toEN(positions[a] + (positions[b] - positions[a]) * t, c, positions[a + 2] + (positions[b + 2] - positions[a + 2]) * t));
      }
    }
  }
  // 三角形になっていない余りの頂点（念のため）
  for (let i = triEnd; i + 2 < n; i += 3) {
    const y = positions[i + 1];
    if (y >= yMin && y <= yMax) pts.push(toEN(positions[i], y, positions[i + 2]));
  }
  const hull = convexHull(pts);
  if (hull.length >= 3) return hull;
  const all: EN[] = [];
  for (let i = 0; i + 2 < n; i += 3) all.push(toEN(positions[i], positions[i + 1], positions[i + 2]));
  return convexHull(all);
}

// ---------------------------------------------------------------------------
// 外形: 水平な板（敷地オブジェクト）の外周（凹みも残す）
// ---------------------------------------------------------------------------

const cross2 = (a: EN, b: EN) => a.e * b.n - a.n * b.e;

/** 一直線上（または重なる）の頂点を除く。tol は線からの距離 (m) */
function dropCollinear(poly: EN[], tol: number): EN[] {
  let out = poly.slice();
  for (let pass = 0; pass < poly.length; pass++) {
    let changed = false;
    const next: EN[] = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const ab = { e: b.e - a.e, n: b.n - a.n };
      const ac = { e: c.e - a.e, n: c.n - a.n };
      const lac = Math.hypot(ac.e, ac.n);
      const dup = Math.hypot(ab.e, ab.n) <= tol;
      const collinear = lac > tol && Math.abs(cross2(ab, ac)) / lac <= tol;
      if (dup || collinear) {
        changed = true;
        // 1 回に 1 点だけ除く（隣どうしを同時に除くと形が崩れる）
        next.push(...out.slice(i + 1));
        break;
      }
      next.push(b);
    }
    out = next;
    if (!changed || out.length < 3) break;
  }
  return out;
}

/**
 * 水平な板（3DS の敷地オブジェクトなど）の外周（凹みも残す）。
 * 三角形の集まり（xyz を 9 個ずつ）のうち水平な三角形（3 頂点の y が同じ）を高さごとにまとめ、面積が最大の層（天面。
 * 同点なら高い方）を採り、その層で 1 つの三角形だけが使う辺（境界辺）をつないで多角形にする。一直線上の点は除き、反時計回りで返す。
 * 境界辺が 1 周につながらない（T 字の接合・2 枚の板の重なり・接する 2 つの輪）、別の輪が外周の外にある（穴ではない）、
 * 外周が全頂点の凸包より大きい、天面が板の足跡の半分に届かない（傾いた地面など）、天面の外に他の層・傾いた面の頂点がある
 * （段差のある敷地・土手の付いた板: 天面だけでは敷地全体を表さない）ときは null（呼び出し側で凸包に戻す）。
 * toEN の既定は (x, _, z) → { e: x, n: −z }（pivot ローカルと同じ）
 */
export function plateOutline(positions: ArrayLike<number>, opts: { toEN?: (x: number, y: number, z: number) => EN } = {}): EN[] | null {
  const toEN = opts.toEN ?? ((x: number, _y: number, z: number): EN => ({ e: x, n: -z }));
  const n = positions.length;
  const triCount = Math.floor(n / 9);
  if (triCount < 1) return null;
  // 許容値: 座標の大きさに対して相対（Float32 の丸め）。最低 0.1 mm
  let maxAbs = 0;
  for (let i = 0; i < triCount * 9; i++) {
    const v = Math.abs(positions[i]);
    if (Number.isFinite(v) && v > maxAbs) maxAbs = v;
  }
  const tol = Math.max(1e-4, 2e-6 * maxAbs);

  // 水平な三角形を高さ順に
  type Tri = { y: number; p: [EN, EN, EN]; area: number };
  const horiz: Tri[] = [];
  const allPts: EN[] = [];
  /** 水平でない三角形の頂点（天面の外にはみ出していないかを後で確かめる） */
  const sloped: EN[] = [];
  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const ys = [positions[i + 1], positions[i + 4], positions[i + 7]];
    const p: [EN, EN, EN] = [toEN(positions[i], ys[0], positions[i + 2]), toEN(positions[i + 3], ys[1], positions[i + 5]), toEN(positions[i + 6], ys[2], positions[i + 8])];
    if (!ys.every(Number.isFinite) || !p.every((q) => Number.isFinite(q.e) && Number.isFinite(q.n))) continue;
    allPts.push(...p);
    if (Math.max(...ys) - Math.min(...ys) > tol) {
      sloped.push(...p);
      continue;
    }
    const area = Math.abs(cross2({ e: p[1].e - p[0].e, n: p[1].n - p[0].n }, { e: p[2].e - p[0].e, n: p[2].n - p[0].n })) / 2;
    horiz.push({ y: (ys[0] + ys[1] + ys[2]) / 3, p, area });
  }
  if (horiz.length < 1) return null;
  horiz.sort((a, b) => a.y - b.y);
  // 高さごとの層（隣との差が tol 以内なら同じ層）→ 面積が最大の層（同点なら高い方）
  let best: Tri[] | null = null;
  let bestArea = -1;
  let cur: Tri[] = [];
  const flush = () => {
    if (!cur.length) return;
    const a = cur.reduce((s, t) => s + t.area, 0);
    if (a >= bestArea * (1 - 1e-9)) {
      best = cur;
      bestArea = a;
    }
    cur = [];
  };
  for (const t of horiz) {
    if (cur.length && t.y - cur[cur.length - 1].y > tol) flush();
    cur.push(t);
  }
  flush();
  if (!best) return null;
  const level: Tri[] = best;
  // 天面は板の足跡（全頂点の凸包）の大半を占めていること（傾いた地面に小さな水平面があるだけ、を除く）
  const hull = convexHull(allPts);
  const hullArea = hull.length >= 3 ? Math.abs(polygonArea(hull)) : 0;
  if (!(hullArea > 0) || bestArea < 0.5 * hullArea) return null;

  // 頂点の溶接（tol 以内は同じ頂点）: 格子に入れて近傍 3×3 を調べる
  const cell = tol * 2;
  const grid = new Map<string, number[]>();
  const verts: EN[] = [];
  const weld = (q: EN): number => {
    const cx = Math.floor(q.e / cell);
    const cy = Math.floor(q.n / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const ids = grid.get(`${cx + dx},${cy + dy}`);
        if (!ids) continue;
        for (const id of ids) if (Math.hypot(verts[id].e - q.e, verts[id].n - q.n) <= tol) return id;
      }
    const id = verts.length;
    verts.push({ e: q.e, n: q.n });
    const k = `${cx},${cy}`;
    const list = grid.get(k);
    if (list) list.push(id);
    else grid.set(k, [id]);
    return id;
  };
  // 辺の使用回数（1 回だけの辺が境界）
  const edges = new Map<string, { a: number; b: number; count: number }>();
  for (const t of level) {
    const ids = t.p.map(weld);
    for (let k = 0; k < 3; k++) {
      const a = ids[k];
      const b = ids[(k + 1) % 3];
      if (a === b) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      const e = edges.get(key);
      if (e) e.count++;
      else edges.set(key, { a, b, count: 1 });
    }
  }
  const adj = new Map<number, number[]>();
  let boundary = 0;
  for (const e of edges.values()) {
    if (e.count !== 1) continue;
    boundary++;
    (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push(e.b);
    (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push(e.a);
  }
  if (boundary < 3) return null;
  // 境界の各頂点はちょうど 2 本の境界辺を持つ（そうでなければ輪がつながらない）
  for (const list of adj.values()) if (list.length !== 2) return null;
  // 輪をたどる
  const seen = new Set<number>();
  const loops: EN[][] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop: EN[] = [];
    let prev = -1;
    let v = start;
    for (let guard = 0; guard <= adj.size; guard++) {
      seen.add(v);
      loop.push(verts[v]);
      const [x, y] = adj.get(v)!;
      const next = x !== prev ? x : y;
      prev = v;
      v = next;
      if (v === start) break;
    }
    if (v !== start) return null;
    loops.push(loop);
  }
  loops.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  let outer = dropCollinear(loops[0], tol);
  if (outer.length < 3) return null;
  const outerArea = polygonArea(outer);
  // 外周は凸包の中（面積で判定）
  if (Math.abs(outerArea) > hullArea * (1 + 1e-6) + tol) return null;
  // 他の輪は穴（外周の内側）であること。外にあれば別の板（接する 2 枚の板など）なので外周とは言えない
  const outside = (q: EN) => !pointInPolygon(q, outer) && closestPointOnPolygon(q, outer).dist > tol;
  for (const loop of loops.slice(1)) for (const q of loop) if (outside(q)) return null;
  // 天面の外に他の層・傾いた面の頂点があってはならない（段差のある敷地・土手の付いた板は天面だけでは敷地全体を表さない。
  // 薄い箱の側面・底面の頂点は外周の真下にあるので通る）。外周の bbox の外なら多角形の判定をせずに確定
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const q of outer) {
    if (q.e < minE) minE = q.e;
    if (q.e > maxE) maxE = q.e;
    if (q.n < minN) minN = q.n;
    if (q.n > maxN) maxN = q.n;
  }
  const beyond = (q: EN) => q.e < minE - tol || q.e > maxE + tol || q.n < minN - tol || q.n > maxN + tol || outside(q);
  for (const q of sloped) if (beyond(q)) return null;
  const levelSet = new Set<Tri>(level);
  for (const t of horiz) if (!levelSet.has(t)) for (const q of t.p) if (beyond(q)) return null;
  if (outerArea < 0) outer = outer.reverse();
  return outer;
}

// ---------------------------------------------------------------------------
// 2 点合わせ
// ---------------------------------------------------------------------------

export interface PlacementSolution {
  headingDeg: number;
  offsetE: number;
  offsetN: number;
  /** 残差の RMS (m) */
  rmsM: number;
  /** 計測した寸法の比（航空写真上の距離 / モデル上の距離） */
  scaleRatio: number;
}

/**
 * 対応点（pivot ローカル EN → 緯度経度）から方位・位置を解く。倍率は変えない（比は scaleRatio で報告）。
 * scaleK は local を今の単位に換算する係数（unitScale(今) / unitScale(採ったとき)）。
 * 2 組なら solveTwoPoint、3 組以上なら最小二乗（solveRigid）。
 */
export function solvePairs(frame: LatLon, pairs: AlignmentPair[], scaleK = 1): PlacementSolution {
  if (pairs.length < 2) throw new Error('2 点合わせには 2 組以上の対応点が必要です');
  const p = pairs.map((q) => ({ e: q.local.e * scaleK, n: q.local.n * scaleK }));
  const q = pairs.map((x) => frameToLocal(frame, x.target));
  const fit = pairs.length === 2 ? solveTwoPoint([p[0], p[1]], [q[0], q[1]], { allowScale: false }) : solveRigid(p, q, { allowScale: false });
  return { headingDeg: fit.rotDeg, offsetE: fit.te, offsetN: fit.tn, rmsM: fit.rmsM, scaleRatio: fit.scaleRatio ?? 1 };
}

/**
 * 2 点合わせ: 建物の角（pivot ローカル EN）と、航空写真で指したその角の実際の位置（緯度経度）から方位・位置を決める。
 * placed は今の配置（単位）の確認用で、local は既に pivot ローカル（m）なので計算には要らない
 */
export function twoPointPlacement(placed: PlacedModel | null, frame: LatLon, pairs: AlignmentPair[]): PlacementSolution {
  void placed;
  return solvePairs(frame, pairs, 1);
}

// ---------------------------------------------------------------------------
// 敷地の輪郭に合わせる
// ---------------------------------------------------------------------------

const dist = (a: EN, b: EN) => Math.hypot(a.e - b.e, a.n - b.n);

/**
 * 初期回転 rot0 からの剛体 ICP（fitPolygonToPolygon の 1 候補分と同じ手順）。指定した向きの候補の残差を知るために使う。
 * 境界点は外形ごとに ≈ 200（最大 MAX_ICP_POINTS）。src の間隔は周長比で決めるので、単位違いの src でも点が爆発しない
 */
function icpRigid(src: EN[], dst: EN[], rot0: number, maxIter = 30): RigidFit & { score: number } {
  const perS = polygonPerimeter(src);
  const perD = polygonPerimeter(dst);
  const stepM = Math.max(perD / 200, 1e-4);
  const srcPts = densifyBudget(src, perD > 0 ? (stepM * perS) / perD : stepM);
  const dstPts = densifyBudget(dst, stepM);
  const cS = centroid(src);
  const cD = centroid(dst);
  let fit: RigidFit = { rotDeg: rot0, te: 0, tn: 0, scale: 1, scaleRatio: 1, rmsM: NaN };
  const m = applyFit(fit, cS);
  fit.te = cD.e - m.e;
  fit.tn = cD.n - m.n;
  let prev = srcPts.map((p) => applyFit(fit, p));
  for (let it = 0; it < maxIter; it++) {
    const a: EN[] = [];
    const b: EN[] = [];
    for (const p of srcPts) {
      a.push(p);
      b.push(closestPointOnPolygon(applyFit(fit, p), dst).point);
    }
    const inv = invertFit(fit);
    for (const q of dstPts) {
      a.push(closestPointOnPolygon(applyFit(inv, q), src).point);
      b.push(q);
    }
    const next = solveRigid(a, b, { allowScale: false });
    const cur = srcPts.map((p) => applyFit(next, p));
    let change = 0;
    for (let i = 0; i < cur.length; i++) change = Math.max(change, dist(cur[i], prev[i]));
    prev = cur;
    fit = next;
    if (change < 1e-3) break;
  }
  return { ...fit, score: fit.rmsM };
}

/** 凸包の面積に対して凹みの分だけ面積が小さい（CONCAVE_AREA_RATIO 以上）か */
function isConcave(poly: EN[]): boolean {
  const hull = convexHull(poly);
  if (hull.length < 3) return false;
  const a = Math.abs(polygonArea(poly));
  return a > 0 && Math.abs(polygonArea(hull)) > a * CONCAVE_AREA_RATIO;
}

export interface SiteFitResult {
  headingDeg: number;
  offsetE: number;
  offsetN: number;
  /** 残差の RMS (m)。unitSuspect のときは NaN（重ねていない） */
  rmsM: number;
  /** 大きさの比（地図で描いた輪郭の周長 / 3DS の敷地の周長）。SITE_SCALE_RANGE を外れると unitSuspect */
  scaleRatio: number;
  /** 大きさが 2 倍以上違う: 単位が違う可能性が高い。ICP はせず、最小外接矩形の向きだけ合わせた（位置は今のまま） */
  unitSuspect: boolean;
  /**
   * 描いた輪郭には凹みがあるのに、3DS の敷地オブジェクトは外周が取れない形（接する 2 枚の板・傾いた地面など）で
   * 凸包でしか外形が取れなかった（PlacedModel.siteOutlineIsHull）。凹みの分だけ残差が大きめに出る
   */
  convexOnly: boolean;
  /**
   * 3DS の敷地オブジェクトの外周は取れていて凸なのに、描いた輪郭には凹みがある（convexOnly とは排他）。
   * 3DS の敷地と描いた輪郭の形が違うか、描いた輪郭が隣地を含んでいる。残差が大きめに出る
   */
  shapeDiffers: boolean;
}

/**
 * 3DS の敷地（site）オブジェクトの外形を、地図で描いた敷地の輪郭（ワールド EN）に重ねる方位・位置。
 * 候補は辺の主方向の差 + k·90° と今の向き（preferHeadingDeg）。矩形の敷地では Δ と Δ+180 が同点になるので、
 * 残差の差が 2 cm 以内なら今の向きに最も近い候補を採る。
 * 周長の比が SITE_SCALE_RANGE を外れる（単位違い）ときは ICP をせず、最小外接矩形の向きだけ合わせ（位置は今のまま。
 * 1000 倍の建物を中心合わせで数 km 先へ飛ばさない）unitSuspect を立てる。矩形どうしの比較は 3DS の敷地を周長の比で
 * 描いた輪郭の大きさに揃えてから行う（揃えないと幅・奥行の差が同点になり、向きが 90° ずれる）。矩形は 180° 対称なので
 * Δ と Δ+180 のうち今の向きに近い方を採る。敷地オブジェクトが無い・どちらかの外形から矩形が作れない（一直線上）なら null
 */
export function fitToSite(placed: PlacedModel, sitePolygonEN: EN[], preferHeadingDeg = placed.placement.headingDeg): SiteFitResult | null {
  const src = placed.siteOutlineLocal();
  if (!src || src.length < 3 || sitePolygonEN.length < 3) return null;
  const perS = polygonPerimeter(src);
  const perD = polygonPerimeter(sitePolygonEN);
  if (!(perS > 0) || !(perD > 0)) return null;
  const scaleRatio = perD / perS;
  const dstConcave = isConcave(sitePolygonEN);
  const convexOnly = placed.siteOutlineIsHull() && dstConcave;
  const shapeDiffers = !convexOnly && dstConcave && !isConcave(src);
  // 今の向きの表し方（例: −10°）に連続な値で返す
  const continuous = (rotDeg: number) => preferHeadingDeg + normDeg180(rotDeg - preferHeadingDeg);
  const closeness = (r: number) => Math.abs(normDeg180(r - preferHeadingDeg));
  if (scaleRatio < SITE_SCALE_RANGE.min || scaleRatio > SITE_SCALE_RANGE.max) {
    const scaled = src.map((p) => ({ e: p.e * scaleRatio, n: p.n * scaleRatio }));
    if (!minAreaRect(scaled) || !minAreaRect(sitePolygonEN)) return null;
    const r = fitRectToRect(scaled, sitePolygonEN);
    const rot = closeness(r.rotDeg + 180) < closeness(r.rotDeg) - 1e-9 ? r.rotDeg + 180 : r.rotDeg;
    return { headingDeg: continuous(rot), offsetE: placed.placement.offsetE, offsetN: placed.placement.offsetN, rmsM: NaN, scaleRatio, unitSuspect: true, convexOnly, shapeDiffers };
  }
  const best = fitPolygonToPolygon(src, sitePolygonEN, { allowScale: false, initialRotDeg: [preferHeadingDeg] });
  let chosen: RigidFit & { score: number } = best;
  for (let k = 1; k < 4; k++) {
    const r = normDeg180(best.rotDeg + 90 * k);
    if (closeness(r) >= closeness(chosen.rotDeg) - 1e-9) continue;
    const cand = icpRigid(src, sitePolygonEN, r);
    if (cand.score <= best.score + FIT_TIE_M) chosen = cand;
  }
  return { headingDeg: continuous(chosen.rotDeg), offsetE: chosen.te, offsetN: chosen.tn, rmsM: chosen.rmsM, scaleRatio, unitSuspect: false, convexOnly, shapeDiffers };
}

/**
 * 向きだけを敷地の辺に合わせる（位置は変えない）: Δ = 敷地の辺の主方向 − 建物（壁の高さ帯の外形）の辺の主方向 に対し
 * {Δ + k·90} のうち今の向きに最も近いものを返す。外形が取れなければ今の向きのまま
 */
export function orientToSite(placed: PlacedModel, sitePolygonEN: EN[], currentHeadingDeg: number): number {
  const outline = placed.outlineLocal();
  if (outline.length < 3 || sitePolygonEN.length < 3) return currentHeadingDeg;
  const delta = dominantAngleDeg(sitePolygonEN) - dominantAngleDeg(outline);
  let best = currentHeadingDeg;
  let bestD = Infinity;
  for (let k = 0; k < 4; k++) {
    const d = normDeg180(delta + 90 * k - currentHeadingDeg);
    if (Math.abs(d) < bestD - 1e-9) {
      bestD = Math.abs(d);
      best = currentHeadingDeg + d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 記録の維持
// ---------------------------------------------------------------------------

/** 2 点合わせの対応点が今の上方向・反転で使えるか（単位は換算できるので問わない） */
export function alignmentContextOk(p: ModelPlacement): boolean {
  const al = p.alignment;
  if (!al || al.kind !== 'twoPoint') return true;
  if (al.mirror != null && al.mirror !== p.mirror) return false;
  if (al.upAxis != null && al.upAxis !== p.upAxis) return false;
  return true;
}

/** 建物の基準点（pivot）の緯度経度 */
export function pivotLatLonOf(frame: LatLon, p: Pick<ModelPlacement, 'offsetE' | 'offsetN'>): LatLon {
  return frameFromLocal(frame, p.offsetE, p.offsetN);
}

/**
 * ピンが動いた・単位が変わったときに、記録した位置合わせから方位・位置を決め直す（placement を書き換える）。
 *  - 2 点合わせ: 対応点の緯度経度から解き直す（単位が変わっていれば local を換算）→ 'twoPoint'
 *  - それ以外で pivot の緯度経度があれば、その位置に戻す（建物を地球上の同じ所に保つ）→ 'pivot'
 *  - 何も記録が無ければ何もしない → null
 * placed は無くてもよい（建設地のステップには 3D が無い）。local は pivot ローカルで保存してあるので計算には要らない
 */
export function reapplyAlignment(frame: LatLon, placement: ModelPlacement, placed: PlacedModel | null): 'twoPoint' | 'pivot' | null {
  void placed;
  const al = placement.alignment;
  if (!al) return null;
  if (al.kind === 'twoPoint' && al.pairs && al.pairs.length >= 2 && alignmentContextOk(placement)) {
    const k = unitScaleOf(placement) / (al.unitScaleM && al.unitScaleM > 0 ? al.unitScaleM : unitScaleOf(placement));
    try {
      const s = solvePairs(frame, al.pairs, k);
      placement.headingDeg = r2(s.headingDeg);
      placement.offsetE = r2(s.offsetE);
      placement.offsetN = r2(s.offsetN);
      al.rmsM = s.rmsM;
      al.scaleRatio = s.scaleRatio;
      al.pivotLatLon = pivotLatLonOf(frame, placement);
      return 'twoPoint';
    } catch {
      /* 対応点が一致しているなど: pivot の緯度経度で続ける */
    }
  }
  if (al.pivotLatLon) {
    const q = frameToLocal(frame, al.pivotLatLon);
    placement.offsetE = r2(q.e);
    placement.offsetN = r2(q.n);
    return 'pivot';
  }
  return null;
}

/**
 * 形・寸法（単位・上方向・反転・表示オブジェクト）が変わった後、「敷地の輪郭に合わせた」「向きだけ合わせた」記録を
 * 今の形でやり直す（placement を書き換える。pivot の緯度経度は呼び出し側が notePivot で更新する）。
 * 敷地の輪郭が無い・敷地オブジェクトの外形が取れなくなった（表示に戻した）などでやり直せないときは、
 * 種類を外して pivot の緯度経度だけ残す（古い残差を表示し続けない）。
 * 戻り値: 'refit'（やり直した）／'dropped'（記録を外した）／null（対象外: 2 点合わせ・手で置いた配置）
 */
export function refitSiteAlignment(placed: PlacedModel, placement: ModelPlacement, sitePolygonEN: EN[] | null): 'refit' | 'dropped' | null {
  const al = placement.alignment;
  if (!al || (al.kind !== 'siteFit' && al.kind !== 'orient')) return null;
  const now = new Date().toISOString();
  if (sitePolygonEN && sitePolygonEN.length >= 3) {
    if (al.kind === 'siteFit') {
      const r = fitToSite(placed, sitePolygonEN, placement.headingDeg);
      if (r) {
        placement.headingDeg = r2(r.headingDeg);
        placement.offsetE = r2(r.offsetE);
        placement.offsetN = r2(r.offsetN);
        al.rmsM = r.rmsM;
        al.scaleRatio = r.scaleRatio;
        al.at = now;
        return 'refit';
      }
    } else {
      placement.headingDeg = r2(orientToSite(placed, sitePolygonEN, placement.headingDeg));
      al.at = now;
      return 'refit';
    }
  }
  placement.alignment = { at: now, pivotLatLon: al.pivotLatLon };
  return 'dropped';
}

export interface PinMoveResult {
  /**
   * 建物がどう追従したか: 'twoPoint'／'pivot' = 記録から地球上の同じ所に保った、'reset' = 遠すぎたのでピンの位置に戻して記録を外した、
   * 'pin' = 記録が無いのでピンに付いて動いた（相対位置そのまま）、'none' = 建物が無い
   */
  kind: 'twoPoint' | 'pivot' | 'reset' | 'pin' | 'none';
  /** 建物（と測定点）がピン基準の座標でどれだけ動いたか (m)。dY は GL（ピン位置の地盤高）の基準が変わった分 */
  dE: number;
  dN: number;
  dY: number;
}

/**
 * ピンが prev → next に動いたときの建物と測定点の追従（placement・points を書き換える）。
 *  - 位置合わせの記録（2 点合わせの対応点／pivot の緯度経度）があれば、建物を地球上の同じ所に保つ（reapplyAlignment）。
 *    新しいピンから maxOffsetM より遠くなるときは（建設地そのものが変わった）ピンの位置に戻し、記録を外す → 'reset'
 *  - 記録が無い（読み込んだだけで動かしていない）建物はピンに付いて動く（ピンの位置 = 建物を置く場所）→ 'pin'。
 *    種類の無い記録（pivot の緯度経度だけ）でも配置が既定（ピンの位置・図面の上 = 真北。describeAlignment の「自動配置」）なら同じ:
 *    以前の版が単位・表示の変更でも記録を作っていた保存データや「ピンの位置に戻す」の後も、ピンに付いて動く（記録の緯度経度は新しいピンに揃える）
 *  - 地球上の同じ所に保つときは底面の高さも T.P. を保つ: GL（ピン位置の地盤高）が変わった分だけ baseY を補正する（両方の地盤高が分かるとき）
 *  - 測定点（ワールド座標 = ピン基準）は建物と同じだけ動かす（建物に置いた点が壁から離れない。向きの微小な変化は無視する）。
 *    建物が無ければ周辺環境と同じく地球上の同じ所に保つ
 * placed は要らない（建設地のステップには 3D が無い）。呼び出し側で currentPlaced()?.applyTransform() して pivot を同期すること
 */
export function followPinMove(prev: GeoFrame | null, next: GeoFrame, placement: ModelPlacement | null, points: MeasurePoint[], maxOffsetM = Infinity): PinMoveResult {
  const d = prev ? frameToLocal(prev, next) : { e: 0, n: 0 };
  const g0 = prev?.groundElev;
  const g1 = next.groundElev;
  const dG = g0 != null && g1 != null && Number.isFinite(g0) && Number.isFinite(g1) ? g1 - g0 : 0;
  let kind: PinMoveResult['kind'] = 'none';
  let dE = -d.e;
  let dN = -d.n;
  let dY = -dG;
  if (placement) {
    const e0 = placement.offsetE;
    const n0 = placement.offsetN;
    const y0 = placement.baseY;
    const al = placement.alignment;
    const untouched = !!al && !al.kind && e0 === 0 && n0 === 0 && placement.headingDeg === 0;
    const k = untouched ? null : reapplyAlignment(next, placement, null);
    if (k) {
      kind = k;
      if (Math.hypot(placement.offsetE, placement.offsetN) > maxOffsetM) {
        placement.offsetE = 0;
        placement.offsetN = 0;
        placement.alignment = undefined;
        kind = 'reset';
      } else if (dG) placement.baseY = r2(y0 - dG);
    } else {
      kind = 'pin';
      if (al?.pivotLatLon) al.pivotLatLon = pivotLatLonOf(next, placement);
    }
    dE = placement.offsetE - e0;
    dN = placement.offsetN - n0;
    dY = placement.baseY - y0;
  }
  if (dE || dN || dY) for (const pt of points) pt.pos = [pt.pos[0] + dE, pt.pos[1] + dY, pt.pos[2] - dN];
  return { kind, dE, dN, dY };
}

// ---------------------------------------------------------------------------
// 説明文
// ---------------------------------------------------------------------------

/** 記録された大きさの比から単位（縮尺）を疑うか: 2 点合わせは SCALE_WARN、敷地の輪郭は SITE_SCALE_RANGE */
export function scaleSuspect(al: PlacementAlignment | undefined): boolean {
  const k = al?.scaleRatio;
  if (!al?.kind || k == null || !Number.isFinite(k)) return false;
  if (al.kind === 'twoPoint') return Math.abs(k - 1) > SCALE_WARN;
  if (al.kind === 'siteFit') return k < SITE_SCALE_RANGE.min || k > SITE_SCALE_RANGE.max;
  return false;
}

/** 3DS の敷地と描いた輪郭の大きさの違いの言い方（k = 描いた輪郭 / 3DS） */
export function siteScaleText(k: number): string {
  const ratio = 1 / k; // 3DS の敷地 / 描いた輪郭
  const f = (v: number) => (v >= 10 ? Math.round(v).toLocaleString('ja-JP') : v.toFixed(2));
  return ratio >= 1 ? `3DS の敷地は描いた輪郭の約 ${f(ratio)} 倍の大きさです` : `3DS の敷地は描いた輪郭の約 1/${f(1 / ratio)} の大きさです`;
}

const siteFitNote = (al: PlacementAlignment) => (scaleSuspect(al) ? `${siteScaleText(al.scaleRatio as number)}。単位を確認してください` : '');

/** 状態の 1 行説明（サイドパネルの hint 用） */
export function describeAlignment(p: ModelPlacement): string {
  const al = p.alignment;
  if (!al?.kind) {
    return p.offsetE === 0 && p.offsetN === 0 && p.headingDeg === 0 ? '自動配置です（ピンの位置に、図面の上を真北に向けて置いています）' : '手で置いた配置です';
  }
  switch (al.kind) {
    case 'twoPoint': {
      const k = al.scaleRatio ?? 1;
      const off = Math.abs(k - 1) > SCALE_WARN;
      return `2 点合わせ: 残差 ${fmtM(al.rmsM)} m／寸法の比 ${k.toFixed(3)}（${off ? `寸法が約 ${(Math.abs(k - 1) * 100).toFixed(1)} % ずれています。単位を確認してください` : '単位は正しいようです'}）`;
    }
    case 'siteFit':
      return scaleSuspect(al) ? `敷地の向きだけ合わせました（${siteFitNote(al)}。単位を直すと輪郭ごと合わせ直します）` : `敷地の輪郭に合わせました（残差 ${fmtM(al.rmsM)} m）`;
    case 'orient':
      return '建物の向きだけ敷地の辺に合わせました（位置は手で決めます）';
  }
}

/** 確認ダイアログ用の短い表記 */
export function alignmentLabel(p: ModelPlacement): string {
  const al = p.alignment;
  switch (al?.kind) {
    case 'twoPoint':
      return `2 点合わせ（残差 ${fmtM(al.rmsM)} m／寸法の比 ${(al.scaleRatio ?? 1).toFixed(3)}）`;
    case 'siteFit':
      return scaleSuspect(al) ? `敷地の向きだけ合わせた（${siteFitNote(al)}）` : `敷地の輪郭に合わせた（残差 ${fmtM(al.rmsM)} m）`;
    case 'orient':
      return '向きのみ敷地の辺に合わせた（位置は手動）';
    default:
      return p.offsetE === 0 && p.offsetN === 0 && p.headingDeg === 0 ? '自動配置（ピンの位置・図面の上 = 真北）' : '手動（航空写真に合わせてドラッグ・数値入力）';
  }
}
