/**
 * 外部の正確な建物（設計の 3DS など）を PDF の間取りに合わせるための純粋な計算（DOM・状態に依存しない。テスト対象）。
 *
 * 座標系: 間取りプレゼンのワールドは PLAN 座標（X = 図面の右, Z = 図面の下, Y = 上, m）。
 *   「局所 EN」は a = x, b = −z（align.ts の規約: e = x, n = −z）。PDF 外形は bbox 中心 c を原点にして e = x − c.x, n = −(z − c.z)。
 *   PlacedModel は pivot.rotation.y = −headingDeg なので、pivot ローカル EN → 親 EN は applyFit({rotDeg: headingDeg, te: offsetE, tn: offsetN})。
 *   親（c に置いたラッパー）の中で pivot.position = (dx, baseY, dz) ⇔ offsetE = dx, offsetN = −dz。
 *
 * 外形: 焼き込んだ三角形は元の頂点しか持たない（壁の箱 0..6 m は壁の高さ帯に頂点が無い）ので、
 *   「高さ帯の頂点の凸包」ではなく、三角形を水平面 y = yCut で切った線分（＝水平断面）を使う。
 *   sectionOutline はその凸包、sectionPolygon は断面を格子に描いて外側から塗りつぶした「外周の多角形」（凹みも残る。
 *   PDF に無いポーチ・下屋があっても主屋の壁の辺が残るので、外形どうしの合わせが凸包より正確）。
 */
import * as THREE from 'three';
import {
  applyFit,
  closestPointOnPolygon,
  convexHull,
  densify,
  fitPolygonToPolygon,
  fitRectToRect,
  invertFit,
  minAreaRect,
  normDeg,
  normDeg180,
  polygonPerimeter,
  solveRigid,
  type EN,
  type RigidFit,
} from '../sun/align';
import { DEFAULT_PLACEMENT, type ImportedModel, type ModelPlacement } from '../sunstudy/types';
import { marchingSegments, segmentsToPolylines } from '../sun/analysis';

/** 自動合わせの記録 */
export interface ExternalFitRecord {
  /** 最小外接矩形どうしの寸法差 |Δw| + |Δd| (m) */
  mismatchM: number;
  /** 矩形の幅・奥行きを入れ替えて合わせた（90° 回転） */
  swapped: boolean;
  /** 実行時刻 (ISO) */
  at: string;
  /** 外形どうしの残差 RMS (m)。PDF に無いポーチ・下屋などがあると大きくなる */
  score: number;
  /** 3DS を左右反転して合わせたときの残差 (m)。score より明らかに小さければ鏡像のデータ */
  mirrorScore: number;
  /** PDF 外形の最小外接矩形（幅 × 奥行き, m） */
  pdfW: number;
  pdfD: number;
  /** 3DS 外形の最小外接矩形（PDF の向きに合わせて幅 × 奥行き, m） */
  extW: number;
  extD: number;
  /** 自動合わせが選んだ回転（「自動配置に戻す」で優先する） */
  planRotDeg?: number;
}

/** 設計の 3D データで置き換えた正確な建物（state.external） */
export interface ExternalBuilding {
  model: ImportedModel;
  /** 単位・上方向・鏡像・非表示オブジェクトなど。headingDeg/offsetE/offsetN/baseY は controller が planRotDeg/dx/dz/floor から毎回決める */
  placement: ModelPlacement;
  /** PLAN 座標での回転（上から見て時計回り, deg）。↻ = +90 */
  planRotDeg: number;
  /** PDF の bbox 中心からモデル中心までの PLAN 座標のずれ (m): x, z */
  dx: number;
  dz: number;
  /** 3DS が PDF の建物に代わって影を落とす（PDF の建物は隠す） */
  replaces: boolean;
  /** 3DS の最下点から 1 階の床までの高さ (m)。PDF の 1 階床高に合わせて上下する（省略時は PDF の 1 階床高 = 最下点を GL に置く） */
  floor1M?: number;
  /** 自動合わせの後に手で動かした */
  manual?: boolean;
  fit?: ExternalFitRecord;
}

// ---------------------------------------------------------------- 外形（水平断面）

export interface SectionOptions {
  yMin: number;
  yMax: number;
  /** 切断する高さ。省略時は yMin・(yMin+yMax)/2・yMax（有限のものだけ） */
  cuts?: number[];
  toEN?: (x: number, y: number, z: number) => EN;
}

const defaultToEN = (x: number, _y: number, z: number): EN => ({ e: x, n: -z });

/**
 * 三角形の配列（9 floats / 三角形）の水平断面の外形（凸包、EN）。
 *  - 各切断高さ yCut で、(a.y − yCut)(b.y − yCut) < 0 の辺の交点を加える
 *  - yMin ≤ y ≤ yMax の頂点も加える
 * 点が 3 つ未満なら、全頂点の凸包にフォールバックする（それも無ければ []）
 */
export function sectionOutline(positions: ArrayLike<number>, opts: SectionOptions): EN[] {
  const toEN = opts.toEN ?? defaultToEN;
  const cuts = (opts.cuts ?? [opts.yMin, (opts.yMin + opts.yMax) / 2, opts.yMax]).filter((c) => Number.isFinite(c));
  const pts: EN[] = [];
  const n = positions.length - (positions.length % 9);
  for (let i = 0; i < n; i += 9) {
    for (let k = 0; k < 3; k++) {
      const ax = positions[i + k * 3];
      const ay = positions[i + k * 3 + 1];
      const az = positions[i + k * 3 + 2];
      if (ay >= opts.yMin && ay <= opts.yMax) pts.push(toEN(ax, ay, az));
      const j = (k + 1) % 3;
      const bx = positions[i + j * 3];
      const by = positions[i + j * 3 + 1];
      const bz = positions[i + j * 3 + 2];
      for (const yc of cuts) {
        const fa = ay - yc;
        const fb = by - yc;
        if (!(fa * fb < 0)) continue;
        const t = fa / (fa - fb);
        pts.push(toEN(ax + (bx - ax) * t, yc, az + (bz - az) * t));
      }
    }
  }
  const hull = pts.length >= 3 ? convexHull(pts) : [];
  if (hull.length >= 3) return hull;
  const all: EN[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) all.push(toEN(positions[i], positions[i + 1], positions[i + 2]));
  return all.length >= 3 ? convexHull(all) : [];
}

/** 断面の線分（EN）と帯の中の頂点 */
function sectionSegments(positions: ArrayLike<number>, opts: SectionOptions): { segs: [EN, EN][]; pts: EN[] } {
  const toEN = opts.toEN ?? defaultToEN;
  const cuts = (opts.cuts ?? [opts.yMin, (opts.yMin + opts.yMax) / 2, opts.yMax]).filter((c) => Number.isFinite(c));
  const segs: [EN, EN][] = [];
  const pts: EN[] = [];
  const n = positions.length - (positions.length % 9);
  // 切断面が無い（帯が無限 = 全高）ときは、三角形の辺を真上から投影した線分を使う（軒先まで含む足跡）
  const projectEdges = cuts.length === 0;
  for (let i = 0; i < n; i += 9) {
    for (let k = 0; k < 3; k++) {
      const y = positions[i + k * 3 + 1];
      if (y >= opts.yMin && y <= opts.yMax) pts.push(toEN(positions[i + k * 3], y, positions[i + k * 3 + 2]));
    }
    if (projectEdges) {
      for (let k = 0; k < 3; k++) {
        const j = (k + 1) % 3;
        const ay = positions[i + k * 3 + 1];
        const by = positions[i + j * 3 + 1];
        if (!(ay >= opts.yMin && ay <= opts.yMax && by >= opts.yMin && by <= opts.yMax)) continue;
        segs.push([toEN(positions[i + k * 3], ay, positions[i + k * 3 + 2]), toEN(positions[i + j * 3], by, positions[i + j * 3 + 2])]);
      }
      continue;
    }
    for (const yc of cuts) {
      const hit: EN[] = [];
      for (let k = 0; k < 3; k++) {
        const j = (k + 1) % 3;
        const ay = positions[i + k * 3 + 1];
        const by = positions[i + j * 3 + 1];
        const fa = ay - yc;
        const fb = by - yc;
        if (fa === 0) hit.push(toEN(positions[i + k * 3], yc, positions[i + k * 3 + 2]));
        if (!(fa * fb < 0)) continue;
        const t = fa / (fa - fb);
        hit.push(toEN(positions[i + k * 3] + (positions[i + j * 3] - positions[i + k * 3]) * t, yc, positions[i + k * 3 + 2] + (positions[i + j * 3 + 2] - positions[i + k * 3 + 2]) * t));
      }
      if (hit.length >= 2) segs.push([hit[0], hit[hit.length - 1]]);
    }
  }
  return { segs, pts };
}

/** 閉じた多角形から、隣の辺に乗っている（距離 < tol）頂点を取り除く */
export function simplifyPolygon(poly: EN[], tol: number): EN[] {
  const out = poly.slice();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length && out.length > 3; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const d = distToSegment(b, a, c);
      if (d < tol) {
        out.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return out;
}

function distToSegment(p: EN, a: EN, b: EN): number {
  const de = b.e - a.e;
  const dn = b.n - a.n;
  const l2 = de * de + dn * dn;
  if (!(l2 > 0)) return Math.hypot(p.e - a.e, p.n - a.n);
  const t = Math.max(0, Math.min(1, ((p.e - a.e) * de + (p.n - a.n) * dn) / l2));
  return Math.hypot(a.e + de * t - p.e, a.n + dn * t - p.n);
}

/**
 * 三角形の配列の水平断面の「外周の多角形」（EN、反時計回り）。
 *  1. 断面の線分と帯の中の頂点を cell (m) の格子に描く
 *  2. 格子の外側から塗りつぶし、届かない所（壁の中・部屋の中）を「内側」とする
 *  3. 内側の境界を marching squares で辿り、最も大きい閉じた輪を取る
 *  4. 直線上の点を省き、角を近くの断面点（1.5 cell 以内）に寄せて正確な角にする
 * 断面が無い・輪が取れないときは sectionOutline（凸包）にフォールバック
 */
export function sectionPolygon(positions: ArrayLike<number>, opts: SectionOptions & { cell?: number }): EN[] {
  const cell = opts.cell ?? 0.1;
  const { segs, pts } = sectionSegments(positions, opts);
  const all: EN[] = pts.slice();
  for (const s of segs) all.push(s[0], s[1]);
  if (all.length < 3) return sectionOutline(positions, opts);
  let minE = Infinity;
  let minN = Infinity;
  let maxE = -Infinity;
  let maxN = -Infinity;
  for (const p of all) {
    if (!Number.isFinite(p.e) || !Number.isFinite(p.n)) continue;
    if (p.e < minE) minE = p.e;
    if (p.n < minN) minN = p.n;
    if (p.e > maxE) maxE = p.e;
    if (p.n > maxN) maxN = p.n;
  }
  if (!(maxE > minE) || !(maxN > minN)) return sectionOutline(positions, opts);
  const e0 = minE - 2 * cell;
  const n0 = minN - 2 * cell;
  const nx = Math.ceil((maxE - e0) / cell) + 3;
  const ny = Math.ceil((maxN - n0) / cell) + 3;
  if (nx * ny > 4_000_000) return sectionOutline(positions, opts);
  const occ = new Uint8Array(nx * ny);
  const mark = (p: EN) => {
    const i = Math.floor((p.e - e0) / cell);
    const j = Math.floor((p.n - n0) / cell);
    if (i >= 0 && j >= 0 && i < nx && j < ny) occ[j * nx + i] = 1;
  };
  for (const p of pts) mark(p);
  for (const [a, b] of segs) {
    const L = Math.hypot(b.e - a.e, b.n - a.n);
    const k = Math.max(1, Math.ceil(L / (cell / 2)));
    for (let t = 0; t <= k; t++) mark({ e: a.e + ((b.e - a.e) * t) / k, n: a.n + ((b.n - a.n) * t) / k });
  }
  // 外側から塗りつぶし
  const outside = new Uint8Array(nx * ny);
  const stack: number[] = [];
  const push = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return;
    const k = j * nx + i;
    if (outside[k] || occ[k]) return;
    outside[k] = 1;
    stack.push(k);
  };
  for (let i = 0; i < nx; i++) {
    push(i, 0);
    push(i, ny - 1);
  }
  for (let j = 0; j < ny; j++) {
    push(0, j);
    push(nx - 1, j);
  }
  while (stack.length) {
    const k = stack.pop()!;
    const i = k % nx;
    const j = (k - i) / nx;
    push(i - 1, j);
    push(i + 1, j);
    push(i, j - 1);
    push(i, j + 1);
  }
  const inside = new Float32Array(nx * ny);
  for (let k = 0; k < inside.length; k++) inside[k] = outside[k] ? 0 : 1;
  const loops = segmentsToPolylines(marchingSegments(inside, nx, ny, 0.5)).filter((l) => l.closed && l.points.length >= 3);
  if (!loops.length) return sectionOutline(positions, opts);
  const toEN = (p: { x: number; y: number }): EN => ({ e: e0 + (p.x + 0.5) * cell, n: n0 + (p.y + 0.5) * cell });
  let best: EN[] = [];
  let bestArea = 0;
  for (const l of loops) {
    const poly = l.points.map(toEN);
    const a = Math.abs(areaOf(poly));
    if (a > bestArea) {
      bestArea = a;
      best = poly;
    }
  }
  if (best.length < 3) return sectionOutline(positions, opts);
  if (areaOf(best) < 0) best.reverse();
  let poly = simplifyPolygon(best, cell * 0.75);
  // 角を近くの断面点へ（格子の半セル分の外側へのずれを戻す）
  poly = poly.map((v) => {
    let q = v;
    let bd = cell * 1.5;
    for (const p of all) {
      const d = Math.hypot(p.e - v.e, p.n - v.n);
      if (d < bd) {
        bd = d;
        q = p;
      }
    }
    return q;
  });
  poly = simplifyPolygon(poly, cell * 0.25);
  // 角の吸着で潰れた（面積がほぼ 0）なら凸包へ
  if (poly.length < 3 || Math.abs(areaOf(poly)) < cell * cell) return sectionOutline(positions, opts);
  return poly;
}

function areaOf(poly: EN[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.e * q.n - q.e * p.n;
  }
  return s / 2;
}

/** 壁の高さ帯: 底から 0.3 m 〜 min(2.0, 0.6 × 高さ) */
export function wallBand(height: number): { yMin: number; yMax: number } {
  const yMax = Math.min(2.0, 0.6 * height);
  return { yMin: 0.3, yMax: yMax > 0.3 ? yMax : Infinity };
}

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _v = new THREE.Vector3();

/**
 * pivot 以下の表示中メッシュの三角形を pivot ローカル座標で 1 本の配列にする（9 floats / 三角形）。
 * メッシュの頂点に pivot.matrixWorld⁻¹ · mesh.matrixWorld を掛ける
 */
export function pivotLocalTriangles(pivot: THREE.Object3D, filter?: (m: THREE.Mesh) => boolean): Float32Array {
  pivot.updateMatrixWorld(true);
  _inv.copy(pivot.matrixWorld).invert();
  const meshes: THREE.Mesh[] = [];
  let total = 0;
  pivot.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    if (filter && !filter(m)) return;
    const pos = m.geometry.getAttribute('position');
    if (!pos) return;
    const tri = Math.floor((m.geometry.index ? m.geometry.index.count : pos.count) / 3);
    if (!tri) return;
    meshes.push(m);
    total += tri;
  });
  const out = new Float32Array(total * 9);
  let w = 0;
  for (const m of meshes) {
    _m.multiplyMatrices(_inv, m.matrixWorld);
    const pos = m.geometry.getAttribute('position');
    const idx = m.geometry.index;
    const n = Math.floor((idx ? idx.count : pos.count) / 3) * 3;
    for (let i = 0; i < n; i++) {
      _v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(_m);
      out[w++] = _v.x;
      out[w++] = _v.y;
      out[w++] = _v.z;
    }
  }
  return out;
}

/** pivot ローカルの高さ帯 band の外周の多角形（EN: a = x, b = −z、凹みも残る）。band 省略時は壁の高さ帯 */
export function outlineOfPivot(pivot: THREE.Object3D, band?: { yMin: number; yMax: number }, filter?: (m: THREE.Mesh) => boolean): EN[] {
  const tris = pivotLocalTriangles(pivot, filter);
  let b = band;
  if (!b) {
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = 1; i < tris.length; i += 3) {
      if (tris[i] < yMin) yMin = tris[i];
      if (tris[i] > yMax) yMax = tris[i];
    }
    const h = Number.isFinite(yMax - yMin) ? yMax - yMin : 0;
    const wb = wallBand(h);
    b = { yMin: yMin + wb.yMin, yMax: Number.isFinite(wb.yMax) ? yMin + wb.yMax : Infinity };
  }
  return sectionPolygon(tris, b);
}

// ---------------------------------------------------------------- PDF 外形

/** PDF の各階外形（ワールド XZ）から、1 階（無ければ最下階）の全頂点を bbox 中心 c 基準の EN にする */
export function planOutlineEN(outlines: { level: number; polys: { x: number; y: number }[][] }[], c: { x: number; z: number }): EN[] {
  if (!outlines.length) return [];
  const level1 = outlines.filter((o) => o.level === 1);
  const pick = level1.length ? level1 : [outlines.reduce((a, o) => (o.level < a.level ? o : a), outlines[0])];
  const pts: EN[] = [];
  for (const o of pick) for (const poly of o.polys) for (const p of poly) pts.push({ e: p.x - c.x, n: -(p.y - c.z) });
  return pts;
}

/** PDF の 1 階（無ければ最下階）の外形のうち最も大きい多角形を、bbox 中心 c 基準の EN（反時計回り）にする */
export function planOutlinePolygon(outlines: { level: number; polys: { x: number; y: number }[][] }[], c: { x: number; z: number }): EN[] {
  if (!outlines.length) return [];
  const level1 = outlines.filter((o) => o.level === 1);
  const pick = level1.length ? level1 : [outlines.reduce((a, o) => (o.level < a.level ? o : a), outlines[0])];
  let best: EN[] = [];
  let bestArea = 0;
  for (const o of pick)
    for (const poly of o.polys) {
      const en = poly.map((p) => ({ e: p.x - c.x, n: -(p.y - c.z) }));
      const a = Math.abs(areaOf(en));
      if (a > bestArea) {
        bestArea = a;
        best = en;
      }
    }
  if (best.length >= 3 && areaOf(best) < 0) best.reverse();
  return best;
}

/** EN（a = x, b = −z, 原点 c）→ PLAN ワールド XZ */
export function enToPlan(p: EN, c: { x: number; z: number }): { x: number; z: number } {
  return { x: c.x + p.e, z: c.z - p.n };
}

// ---------------------------------------------------------------- 間取りへの自動合わせ

export interface PlanFit {
  planRotDeg: number;
  dx: number;
  dz: number;
  mismatchM: number;
  swapped: boolean;
  score: number;
  /** 左右反転した 3DS を合わせたときの残差 (m) */
  mirrorScore: number;
  pdfW: number;
  pdfD: number;
  extW: number;
  extD: number;
}

/** 近い候補（残差の差 < 0.02 m）は同点とみなし、今の回転に近い方を選ぶ */
const TIE_M = 0.02;
/** 外れ値を除く ICP で残す対応点の割合（PDF に無いポーチ・下屋・外階段などを無視する） */
const TRIM_KEEP = 0.75;

/** 鏡像の 3DS と判定する条件: 反転して合わせた残差が、そのままの残差の 0.7 倍未満で、そのままの残差が 0.3 m を超える */
export function suggestsMirror(score: number, mirrorScore: number): boolean {
  return score > 0.3 && mirrorScore < 0.7 * score;
}

/** 単位違いを疑う条件: 寸法差が 0.6 m を超え、かつどちらかの寸法が 25% 以上違う（ポーチ分の 1〜2 m の差では疑わない） */
export function suggestsUnitError(f: { mismatchM: number; pdfW: number; pdfD: number; extW: number; extD: number }): boolean {
  if (!(f.mismatchM > 0.6)) return false;
  const r1 = f.extW / Math.max(1e-6, f.pdfW);
  const r2 = f.extD / Math.max(1e-6, f.pdfD);
  const off = (r: number) => r < 0.8 || r > 1.25;
  return off(r1) || off(r2) || f.mismatchM > 4;
}

/**
 * 外れ値を除く ICP の仕上げ: src の境界点 → dst の最近点、dst の境界点 → src の最近点（逆変換で戻して探す）の対応を取り、
 * 距離の大きい方 (1 − keep) を捨てて solveRigid（倍率なし）。PDF に無いポーチなどの出っ張りに引っ張られないようにする
 */
export function refineTrimmed(src: EN[], dst: EN[], fit: RigidFit, stepM: number, keep = TRIM_KEEP, maxIter = 8): RigidFit {
  const srcPts = densify(src, stepM);
  const dstPts = densify(dst, stepM);
  let f = fit;
  for (let it = 0; it < maxIter; it++) {
    const pairs: { a: EN; b: EN; d: number }[] = [];
    for (const p of srcPts) {
      const q = closestPointOnPolygon(applyFit(f, p), dst);
      pairs.push({ a: p, b: q.point, d: q.dist });
    }
    const inv = invertFit(f);
    for (const q of dstPts) {
      const a = closestPointOnPolygon(applyFit(inv, q), src);
      pairs.push({ a: a.point, b: q, d: a.dist });
    }
    pairs.sort((x, y) => x.d - y.d);
    const kept = pairs.slice(0, Math.max(2, Math.ceil(pairs.length * keep)));
    const next = solveRigid(
      kept.map((k) => k.a),
      kept.map((k) => k.b),
      { allowScale: false },
    );
    const change = Math.hypot(next.te - f.te, next.tn - f.tn) + Math.abs(normDeg180(next.rotDeg - f.rotDeg)) * 0.1;
    f = next;
    if (change < 1e-4) break;
  }
  return f;
}

/** 外形どうしの両方向の最近点残差 RMS (m) */
export function outlineScore(src: EN[], dst: EN[], fit: RigidFit, stepM?: number): number {
  const step = stepM ?? Math.max(polygonPerimeter(dst) / 200, 1e-4);
  const a = densify(src, step);
  const b = densify(dst, step);
  const inv = invertFit(fit);
  let s = 0;
  for (const p of a) s += closestPointOnPolygon(applyFit(fit, p), dst).dist ** 2;
  for (const q of b) s += closestPointOnPolygon(applyFit(inv, q), src).dist ** 2;
  return Math.sqrt(s / (a.length + b.length));
}

/**
 * 3DS の壁の外形 src（pivot ローカル EN）を PDF の外形 dst（bbox 中心基準の EN）に重ねる。
 * 1. 最小外接矩形どうし（fitRectToRect）で Δ と寸法差 mismatchM を得る（単位違いの検出用）
 * 2. 凸包どうしの ICP（fitPolygonToPolygon、倍率なし）を Δ, Δ±90, Δ+180 と preferRotDeg から始めて残差 score を得る
 * 3. 180° 対称な外形では Δ と Δ+180 が同点になるので、残差の差 < 0.02 m の候補は preferRotDeg（今の回転）に近い方を選ぶ
 * 4. 外れ値を除く ICP で仕上げる（PDF に無いポーチ・下屋があっても主屋の壁が PDF の外形に乗る）
 * 5. 左右反転した src でも同じことをして mirrorScore を得る（鏡像のデータの検出用）
 * 戻り値の dx/dz は PLAN 座標（dz = −tn）
 */
export function fitExternalToPlan(src: EN[], dst: EN[], preferRotDeg = 0): PlanFit {
  const direct = fitOnce(src, dst, preferRotDeg);
  const mirrored = fitOnce(
    src.map((p) => ({ e: -p.e, n: p.n })),
    dst,
    preferRotDeg,
  );
  return { ...direct, mirrorScore: mirrored.score };
}

function fitOnce(srcIn: EN[], dstIn: EN[], preferRotDeg: number): Omit<PlanFit, 'mirrorScore'> {
  const srcHull = convexHull(srcIn);
  const dstHull = convexHull(dstIn);
  if (srcHull.length < 3) throw new Error('3DS の外形が取れません（点が 3 つ未満か一直線上）');
  if (dstHull.length < 3) throw new Error('PDF の外形が取れません（点が 3 つ未満か一直線上）');
  // 多角形として渡されたもの（外周）はそのまま使う。点の集まり（面積 0・自己交差など）なら凸包
  const src = Math.abs(areaOf(srcIn)) > 1e-6 && srcIn.length >= 3 ? (areaOf(srcIn) < 0 ? srcIn.slice().reverse() : srcIn) : srcHull;
  const dst = Math.abs(areaOf(dstIn)) > 1e-6 && dstIn.length >= 3 ? (areaOf(dstIn) < 0 ? dstIn.slice().reverse() : dstIn) : dstHull;
  const rs = minAreaRect(srcHull)!;
  const rd = minAreaRect(dstHull)!;
  const rect = fitRectToRect(srcHull, dstHull);
  const prefer = normDeg180(preferRotDeg);
  const initial = [prefer, rect.rotDeg, rect.rotDeg + 90, rect.rotDeg + 180, rect.rotDeg + 270].map(normDeg180);
  const best = fitPolygonToPolygon(src, dst, { allowScale: false, initialRotDeg: initial });
  const stepM = Math.max(polygonPerimeter(dst) / 200, 1e-4);
  // 同点候補: best を 90° ずつ回し、重心を合わせただけの変換の残差を測る
  const cS = centroidOf(src);
  const cD = centroidOf(dst);
  const cands: { fit: RigidFit; score: number }[] = [{ fit: best, score: best.score }];
  for (let k = 1; k < 4; k++) {
    const f: RigidFit = { rotDeg: normDeg180(best.rotDeg + 90 * k), te: 0, tn: 0, scale: 1, scaleRatio: 1, rmsM: 0 };
    const m = applyFit(f, cS);
    f.te = cD.e - m.e;
    f.tn = cD.n - m.n;
    cands.push({ fit: f, score: outlineScore(src, dst, f, stepM) });
  }
  const min = Math.min(...cands.map((c) => c.score));
  const tied = cands.filter((c) => c.score <= min + TIE_M);
  tied.sort((a, b) => Math.abs(normDeg180(a.fit.rotDeg - prefer)) - Math.abs(normDeg180(b.fit.rotDeg - prefer)));
  // 仕上げ: 出っ張り（ポーチなど）を外れ値として除いた合わせ。残差 score は全体で測る（形の違いの指標）
  const refined = refineTrimmed(src, dst, tied[0].fit, stepM);
  const chosen = { fit: refined, score: outlineScore(src, dst, refined, stepM) };
  const planRotDeg = normDeg180(chosen.fit.rotDeg);
  // 矩形の軸が入れ替わるか: 回した src の上軸と dst の上軸の差（軸は向きを持たないので mod 180）が 90° 付近
  const axisDiff = normDeg(rs.angleDeg + planRotDeg - rd.angleDeg) % 180;
  const swapped = Math.abs(axisDiff - 90) < 45;
  const extW = swapped ? rs.d : rs.w;
  const extD = swapped ? rs.w : rs.d;
  return {
    planRotDeg,
    dx: chosen.fit.te,
    dz: -chosen.fit.tn,
    mismatchM: Math.abs(extW - rd.w) + Math.abs(extD - rd.d),
    swapped,
    score: chosen.score,
    pdfW: rd.w,
    pdfD: rd.d,
    extW,
    extD,
  };
}

function centroidOf(poly: EN[]): EN {
  let a = 0;
  let ce = 0;
  let cn = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const f = p.e * q.n - q.e * p.n;
    a += f;
    ce += (p.e + q.e) * f;
    cn += (p.n + q.n) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const k = poly.length || 1;
    return { e: poly.reduce((s, p) => s + p.e, 0) / k, n: poly.reduce((s, p) => s + p.n, 0) / k };
  }
  return { e: ce / (3 * a), n: cn / (3 * a) };
}

/** 寸法の表記 '9.1×7.3 m' */
export function sizeText(w: number, d: number): string {
  return `${w.toFixed(1)}×${d.toFixed(1)} m`;
}

// ---------------------------------------------------------------- 読み込み直後の配置

/** 読み込んだモデルの既定の配置: 推定した単位・上方向、建物以外と判定したオブジェクトは非表示 */
export function seedPlacement(m: ImportedModel): ModelPlacement {
  return { ...DEFAULT_PLACEMENT, unit: m.guessedUnit, upAxis: m.guessedUp, hiddenObjects: m.objects.filter((o) => o.autoHidden).map((o) => o.name) };
}

/** 角を外形の頂点に吸着（radius 以内に頂点があればそれ、無ければ null） */
export function snapToOutlineVertex(p: EN, hull: EN[], radius: number): EN | null {
  let best: EN | null = null;
  let bd = radius;
  for (const q of hull) {
    const d = Math.hypot(q.e - p.e, q.n - p.n);
    if (d <= bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}

// ---------------------------------------------------------------- 2 点合わせ（建物の角 → 航空写真の同じ角）

/** SunContext.fromWorld と同じ: ワールド XZ → 建物中心 c からの東・北 (m)。M(a) = [[cos a, sin a], [sin a, −cos a]]（鏡映） */
export function fromWorldEN(p: { x: number; z: number }, c: { x: number; z: number }, northAngleDeg: number): EN {
  const a = (northAngleDeg * Math.PI) / 180;
  const dx = p.x - c.x;
  const dz = p.z - c.z;
  return { e: dx * Math.cos(a) + dz * Math.sin(a), n: dx * Math.sin(a) - dz * Math.cos(a) };
}

/**
 * 2 点合わせの結果 fit（p_i = fromWorld_a(P_i) → q_i = fromWorld_a(Q_i)、q = Rot(r)·p + t、Rot = applyFit の時計回り回転）を
 * 建物の方位 northAngleDeg と住所の基準点のずれ（site.offsetE/N）に反映する。
 *
 * 導出: 建物はワールドに固定で、世界（真北・航空写真）の方を回す。
 *   fromWorld_a(P) = M(a)·d（d = P − c、M は鏡映で M⁻¹ = M）。M(a−r)·M(a) = [[cos r, sin r], [−sin r, cos r]] = Rot(r)（applyFit の回転）
 *   なので a' = a − r とすると fromWorld_a'(P_i) = Rot(r)·p_i = q_i − t。
 *   P_i の地理位置' = anchor' + fromWorld_a'(P_i) = anchor' + q_i − t を、航空写真の点の地理位置 anchor + q_i に一致させるには
 *   anchor' = anchor + t、すなわち offsetE += te, offsetN += tn。
 *   （符号の検証: applyFit(r)(fromWorld_a(P)) == fromWorld_{a−r}(P) をテストで確認）
 * 方位は (−180, 180] に正規化する（方位スライダーの範囲）
 */
export function applyTwoPointToSite(site: { offsetE: number; offsetN: number }, northAngleDeg: number, fit: RigidFit): { northAngleDeg: number; offsetE: number; offsetN: number } {
  return { northAngleDeg: normDeg180(northAngleDeg - fit.rotDeg), offsetE: site.offsetE + fit.te, offsetN: site.offsetN + fit.tn };
}
