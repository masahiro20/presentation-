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
  densify,
  dominantAngleDeg,
  fitPolygonToPolygon,
  invertFit,
  normDeg180,
  polygonPerimeter,
  solveRigid,
  solveTwoPoint,
} from '../sun/align';
import type { RigidFit } from '../sun/align';
import type { PlacedModel } from './importModel';
import { UNIT_METERS, frameFromLocal, frameToLocal } from './types';
import type { AlignmentPair, EN, LatLon, ModelPlacement, PlacementAlignment } from './types';

/** 計測した寸法の比がこれ以上 1 からずれていたら単位を疑う */
export const SCALE_WARN = 0.03;
/** 敷地の輪郭へのフィットで「同点」とみなす残差の差 (m)。180° 対称な敷地では今の向きに近い候補を採る */
const FIT_TIE_M = 0.02;

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

/** 初期回転 rot0 からの剛体 ICP（fitPolygonToPolygon の 1 候補分と同じ手順）。指定した向きの候補の残差を知るために使う */
function icpRigid(src: EN[], dst: EN[], rot0: number, maxIter = 30): RigidFit & { score: number } {
  const stepM = Math.max(polygonPerimeter(dst) / 200, 1e-4);
  const srcPts = densify(src, stepM);
  const dstPts = densify(dst, stepM);
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

/**
 * 3DS の敷地（site）オブジェクトの外形を、地図で描いた敷地の輪郭（ワールド EN）に重ねる方位・位置。
 * 候補は辺の主方向の差 + k·90° と今の向き（preferHeadingDeg）。矩形の敷地では Δ と Δ+180 が同点になるので、
 * 残差の差が 2 cm 以内なら今の向きに最も近い候補を採る。敷地オブジェクトが無ければ null
 */
export function fitToSite(placed: PlacedModel, sitePolygonEN: EN[], preferHeadingDeg = placed.placement.headingDeg): { headingDeg: number; offsetE: number; offsetN: number; rmsM: number } | null {
  const src = placed.siteOutlineLocal();
  if (!src || src.length < 3 || sitePolygonEN.length < 3) return null;
  const best = fitPolygonToPolygon(src, sitePolygonEN, { allowScale: false, initialRotDeg: [preferHeadingDeg] });
  const closeness = (r: number) => Math.abs(normDeg180(r - preferHeadingDeg));
  let chosen: RigidFit & { score: number } = best;
  for (let k = 1; k < 4; k++) {
    const r = normDeg180(best.rotDeg + 90 * k);
    if (closeness(r) >= closeness(chosen.rotDeg) - 1e-9) continue;
    const cand = icpRigid(src, sitePolygonEN, r);
    if (cand.score <= best.score + FIT_TIE_M) chosen = cand;
  }
  // 今の向きの表し方（例: −10°）に連続な値で返す
  const headingDeg = preferHeadingDeg + normDeg180(chosen.rotDeg - preferHeadingDeg);
  return { headingDeg, offsetE: chosen.te, offsetN: chosen.tn, rmsM: chosen.rmsM };
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

// ---------------------------------------------------------------------------
// 説明文
// ---------------------------------------------------------------------------

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
      return `敷地の輪郭に合わせました（残差 ${fmtM(al.rmsM)} m）`;
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
      return `敷地の輪郭に合わせた（残差 ${fmtM(al.rmsM)} m）`;
    case 'orient':
      return '向きのみ敷地の辺に合わせた（位置は手動）';
    default:
      return p.offsetE === 0 && p.offsetN === 0 && p.headingDeg === 0 ? '自動配置（ピンの位置・図面の上 = 真北）' : '手動（航空写真に合わせてドラッグ・数値入力）';
  }
}
