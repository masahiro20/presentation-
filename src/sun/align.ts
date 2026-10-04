/**
 * 2D 位置合わせソルバ（共有）: 間取りプレゼン側・日照シミュレーション側の両方から使う純粋な計算。
 * DOM・THREE・他モジュールに依存しない（単独で import できるように core/geometry.ts も使わない）。
 * 座標は EN（e: 東 +, n: 北 +。単位は原則 m。allowScale のときだけ src 側が mm 等でもよい）。
 *
 * 回転の規約: rotDeg は地図上の「時計回り」の回転（方位角・コンパスの規約）。
 *   applyFit(f, p) = { e: s·(p.e·cos r + p.n·sin r) + te, n: s·(−p.e·sin r + p.n·cos r) + tn }   (r = rotDeg·π/180)
 *   図面の上方向 (0, 1) は方位 rotDeg に写る。
 *   PlacedModel の配置（pivot ローカル EN: a = x, b = −z、pivot.rotation.y = −headingDeg）とまったく同じ連鎖で、
 *   headingDeg = rotDeg, offsetE = te, offsetN = tn（scale = 1）。
 * 多角形の向き: (e, n) 平面で反時計回り（符号付き面積が正）を基本とする。
 */

export interface EN {
  e: number;
  n: number;
}

export interface RigidFit {
  /** 地図上の時計回りの回転 (deg)。図面の上 (0, 1) が方位 rotDeg に写る */
  rotDeg: number;
  /** 平行移動 (m): 東方向 */
  te: number;
  /** 平行移動 (m): 北方向 */
  tn: number;
  /** 適用する倍率（allowScale でないときは 1） */
  scale: number;
  /** 計測された倍率 |q| / |p|。allowScale でなくても常に計測値を入れる（mm 図面の検出などに使う） */
  scaleRatio: number;
  /** 合わせた後の残差の RMS (m) */
  rmsM: number;
}

export interface FitScaleOptions {
  /** 倍率も推定する（false のとき scale = 1 で、計測値は scaleRatio にだけ入れる） */
  allowScale?: boolean;
}

export interface FitPolygonOptions extends FitScaleOptions {
  /** 境界を点列にするときの間隔 (m)。省略時は dst の周長 / 200（最小 0.1 mm） */
  stepM?: number;
  /** ICP の最大反復回数（省略時 30） */
  maxIter?: number;
  /** 追加で試す初期回転 (deg)。先頭の値は、同点のときにどの候補を優先するかの基準にもなる */
  initialRotDeg?: number[];
}

const DEG = Math.PI / 180;
/** 2 点が「一致している」とみなす距離 */
const EPS_LEN = 1e-6;

// ---------------------------------------------------------------- ベクトルの小道具（非公開）

const sub = (a: EN, b: EN): EN => ({ e: a.e - b.e, n: a.n - b.n });
const dist = (a: EN, b: EN) => Math.hypot(a.e - b.e, a.n - b.n);
const lerp = (a: EN, b: EN, t: number): EN => ({ e: a.e + (b.e - a.e) * t, n: a.n + (b.n - a.n) * t });
/** (e, n) 平面での外積 (a × b)。正なら b は a の左（反時計回り）側 */
const cross = (a: EN, b: EN) => a.e * b.n - a.n * b.e;
/** 回転だけ（平行移動・倍率なし）を点に適用 */
const rotate = (p: EN, rotDeg: number): EN => {
  const r = rotDeg * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { e: p.e * c + p.n * s, n: -p.e * s + p.n * c };
};
const mean = (pts: EN[]): EN => {
  let e = 0;
  let n = 0;
  for (const p of pts) {
    e += p.e;
    n += p.n;
  }
  const k = pts.length || 1;
  return { e: e / k, n: n / k };
};
/** 対応点 p[i] → q[i] に fit を適用したときの残差の RMS */
const rmsOf = (p: EN[], q: EN[], fit: RigidFit): number => {
  if (p.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const r = applyFit(fit, p[i]);
    s += (r.e - q[i].e) ** 2 + (r.n - q[i].n) ** 2;
  }
  return Math.sqrt(s / p.length);
};
/** 点群の広がり（外接矩形の対角）: 許容誤差のスケールに使う */
const extentOf = (pts: EN[]): number => {
  let minE = Infinity;
  let minN = Infinity;
  let maxE = -Infinity;
  let maxN = -Infinity;
  for (const p of pts) {
    if (p.e < minE) minE = p.e;
    if (p.n < minN) minN = p.n;
    if (p.e > maxE) maxE = p.e;
    if (p.n > maxN) maxN = p.n;
  }
  return pts.length ? Math.hypot(maxE - minE, maxN - minN) : 0;
};

// ---------------------------------------------------------------- 角度

/** 角度を [0, 360) に正規化（−0 は 0 にする） */
export function normDeg(d: number): number {
  const x = ((d % 360) + 360) % 360;
  return x === 0 ? 0 : x;
}

/** 角度を (−180, 180] に正規化 */
export function normDeg180(d: number): number {
  const x = normDeg(d);
  return x > 180 ? x - 360 : x;
}

/** ベクトルの方位 (deg): 北 (0, 1) が 0、東 (1, 0) が 90。[0, 360)。零ベクトルは 0 */
export function bearingDeg(d: EN): number {
  if (!(Math.hypot(d.e, d.n) > 1e-12)) return 0;
  return normDeg(Math.atan2(d.e, d.n) / DEG);
}

// ---------------------------------------------------------------- 変換の適用・合成

/** 位置合わせ結果を点に適用する（倍率 → 時計回り回転 → 平行移動） */
export function applyFit(f: RigidFit, p: EN): EN {
  const r = f.rotDeg * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { e: f.scale * (p.e * c + p.n * s) + f.te, n: f.scale * (-p.e * s + p.n * c) + f.tn };
}

/** 逆変換: applyFit(invertFit(f), applyFit(f, p)) = p。rmsM は dst 側の単位に換算（/ scale） */
export function invertFit(f: RigidFit): RigidFit {
  if (!(Math.abs(f.scale) > 0)) throw new Error('invertFit: scale が 0 の変換は逆変換できません');
  const inv: RigidFit = {
    rotDeg: normDeg180(-f.rotDeg),
    te: 0,
    tn: 0,
    scale: 1 / f.scale,
    scaleRatio: 1 / f.scaleRatio,
    rmsM: f.rmsM / Math.abs(f.scale),
  };
  const t = applyFit(inv, { e: -f.te, n: -f.tn });
  inv.te = t.e;
  inv.tn = t.n;
  return inv;
}

/** 合成: composeFit(outer, inner)(p) = outer(inner(p))。rmsM は両者の残差の二乗和平方根（目安） */
export function composeFit(outer: RigidFit, inner: RigidFit): RigidFit {
  const t = applyFit(outer, { e: inner.te, n: inner.tn });
  return {
    rotDeg: normDeg180(outer.rotDeg + inner.rotDeg),
    te: t.e,
    tn: t.n,
    scale: outer.scale * inner.scale,
    scaleRatio: outer.scaleRatio * inner.scaleRatio,
    rmsM: Math.hypot(outer.rmsM, Math.abs(outer.scale) * inner.rmsM),
  };
}

// ---------------------------------------------------------------- 対応点からの解

/**
 * 2 点対応 p[i] → q[i] からの解。回転は 2 本の弦の方位差、平行移動は中点どうしが一致するように（残差を対称に）決める。
 * 倍率は allowScale のときだけ適用（scaleRatio には常に計測値 |q2−q1| / |p2−p1| を入れる）。
 * どちらかの 2 点が一致（< 1e−6）していれば例外。
 */
export function solveTwoPoint(p: [EN, EN], q: [EN, EN], opts: FitScaleOptions = {}): RigidFit {
  const dp = sub(p[1], p[0]);
  const dq = sub(q[1], q[0]);
  const lp = Math.hypot(dp.e, dp.n);
  const lq = Math.hypot(dq.e, dq.n);
  if (!(lp >= EPS_LEN)) throw new Error('solveTwoPoint: 元の 2 点が一致しています（距離 < 1e-6）');
  if (!(lq >= EPS_LEN)) throw new Error('solveTwoPoint: 目標の 2 点が一致しています（距離 < 1e-6）');
  const rotDeg = normDeg180(bearingDeg(dq) - bearingDeg(dp));
  const scaleRatio = lq / lp;
  const scale = opts.allowScale ? scaleRatio : 1;
  const fit: RigidFit = { rotDeg, te: 0, tn: 0, scale, scaleRatio, rmsM: 0 };
  const mp = applyFit(fit, lerp(p[0], p[1], 0.5));
  const mq = lerp(q[0], q[1], 0.5);
  fit.te = mq.e - mp.e;
  fit.tn = mq.n - mp.n;
  fit.rmsM = rmsOf(p, q, fit);
  return fit;
}

/**
 * N ≥ 2 組の対応点 p[i] → q[i] の最小二乗解（2D Procrustes / Umeyama の閉形式）。
 * 重心を引いた後の 2×2 相互共分散の和から、回転角 = atan2(Σ(a.n·b.e − a.e·b.n), Σ(a·b))（時計回り）、
 * 倍率 = |(Σ a·b, Σ a×b)| / Σ|a|²。倍率は allowScale のときだけ適用し、計測値は scaleRatio に入れる。
 */
export function solveRigid(p: EN[], q: EN[], opts: FitScaleOptions = {}): RigidFit {
  if (p.length !== q.length) throw new Error(`solveRigid: 対応点の数が違います (${p.length} vs ${q.length})`);
  if (p.length < 2) throw new Error(`solveRigid: 対応点は 2 組以上必要です (${p.length})`);
  const cp = mean(p);
  const cq = mean(q);
  let sDot = 0;
  let sCrs = 0;
  let sPP = 0;
  for (let i = 0; i < p.length; i++) {
    const a = sub(p[i], cp);
    const b = sub(q[i], cq);
    sDot += a.e * b.e + a.n * b.n;
    // 時計回りの角度にするので、反時計回りの外積 (a × b) の符号を反転
    sCrs += a.n * b.e - a.e * b.n;
    sPP += a.e * a.e + a.n * a.n;
  }
  if (!(sPP > 0)) throw new Error('solveRigid: 元の点がすべて一致しています');
  const h = Math.hypot(sDot, sCrs);
  const rotDeg = h > 0 ? normDeg180(Math.atan2(sCrs, sDot) / DEG) : 0;
  const scaleRatio = h / sPP;
  const scale = opts.allowScale ? scaleRatio : 1;
  const fit: RigidFit = { rotDeg, te: 0, tn: 0, scale, scaleRatio, rmsM: 0 };
  const m = applyFit(fit, cp);
  fit.te = cq.e - m.e;
  fit.tn = cq.n - m.n;
  fit.rmsM = rmsOf(p, q, fit);
  return fit;
}

// ---------------------------------------------------------------- 多角形

/**
 * 凸包（Andrew の monotone chain）。(e, n) 平面で反時計回り、一直線上の点は除く。
 * 異なる点が 3 つ未満、またはすべて一直線上なら []。
 */
export function convexHull(pts: EN[]): EN[] {
  const sorted = pts
    .filter((p) => Number.isFinite(p.e) && Number.isFinite(p.n))
    .sort((a, b) => a.e - b.e || a.n - b.n);
  const uniq: EN[] = [];
  for (const p of sorted) {
    const last = uniq[uniq.length - 1];
    if (!last || Math.abs(last.e - p.e) > 1e-9 || Math.abs(last.n - p.n) > 1e-9) uniq.push(p);
  }
  if (uniq.length < 3) return [];
  // 一直線上とみなす外積の許容値（広がりに対して相対）
  const eps = 1e-12 * extentOf(uniq) ** 2;
  const turn = (o: EN, a: EN, b: EN) => cross(sub(a, o), sub(b, o));
  const lower: EN[] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= eps) lower.pop();
    lower.push(p);
  }
  const upper: EN[] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= eps) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return hull.length < 3 ? [] : hull;
}

/** 符号付き面積（反時計回りで正） */
export function polygonArea(poly: EN[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.e * q.n - q.e * p.n;
  }
  return s / 2;
}

/** 面積重心。面積が 0（一直線上など）のときは頂点の平均 */
export function centroid(poly: EN[]): EN {
  if (poly.length === 0) throw new Error('centroid: 空の多角形');
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
  if (Math.abs(a) < 1e-12 * Math.max(1, extentOf(poly) ** 2)) return mean(poly);
  return { e: ce / (3 * a), n: cn / (3 * a) };
}

/** 閉じた境界の周長 */
export function polygonPerimeter(poly: EN[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) s += dist(poly[i], poly[(i + 1) % poly.length]);
  return s;
}

/** 点が多角形の内側か（交差数判定。境界上は不定） */
export function pointInPolygon(p: EN, poly: EN[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.n > p.n !== b.n > p.n && p.e < ((b.e - a.e) * (p.n - a.n)) / (b.n - a.n) + a.e) inside = !inside;
  }
  return inside;
}

/** 線分 ab 上で p に最も近い点 */
function closestOnSegment(p: EN, a: EN, b: EN): EN {
  const ab = sub(b, a);
  const l2 = ab.e * ab.e + ab.n * ab.n;
  if (!(l2 > 0)) return a;
  const t = Math.max(0, Math.min(1, ((p.e - a.e) * ab.e + (p.n - a.n) * ab.n) / l2));
  return lerp(a, b, t);
}

/** 点と線分の距離 */
export function distPointSegment(p: EN, a: EN, b: EN): number {
  return dist(p, closestOnSegment(p, a, b));
}

/** 多角形の境界上で p に最も近い点とその距離 */
export function closestPointOnPolygon(p: EN, poly: EN[]): { point: EN; dist: number } {
  if (poly.length === 0) throw new Error('closestPointOnPolygon: 空の多角形');
  let best: EN = poly[0];
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const c = closestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    const d = dist(p, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return { point: best, dist: bestD };
}

export interface MinAreaRect {
  center: EN;
  /** 矩形の「上」軸（奥行き d の軸）の方位 (deg)、[0, 90) に正規化 */
  angleDeg: number;
  /** 上軸に直交する方向の幅 */
  w: number;
  /** 上軸方向の奥行き */
  d: number;
  /** 4 隅（反時計回り） */
  corners: EN[];
}

/**
 * 最小面積の外接矩形（凸包の各辺の向きで試す rotating calipers）。
 * angleDeg は矩形の局所「上」軸の方位を [0, 90) に正規化したもので、d はその軸方向の長さ、w は直交方向の長さ。
 * 一直線上や 3 点未満なら null。
 */
export function minAreaRect(pts: EN[]): MinAreaRect | null {
  const hull = convexHull(pts);
  if (hull.length < 3) return null;
  let best: { area: number; u: EN; v: EN; minU: number; maxU: number; minV: number; maxV: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const d = sub(hull[(i + 1) % hull.length], hull[i]);
    const L = Math.hypot(d.e, d.n);
    if (!(L > 0)) continue;
    const u: EN = { e: d.e / L, n: d.n / L };
    const v: EN = { e: -u.n, n: u.e }; // u を反時計回りに 90°（(u, v) は右手系）
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const h of hull) {
      const pu = h.e * u.e + h.n * u.n;
      const pv = h.e * v.e + h.n * v.n;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, u, v, minU, maxU, minV, maxV };
  }
  if (!best) return null;
  const { u, v, minU, maxU, minV, maxV } = best;
  const toEN = (pu: number, pv: number): EN => ({ e: pu * u.e + pv * v.e, n: pu * u.n + pv * v.n });
  const center = toEN((minU + maxU) / 2, (minV + maxV) / 2);
  const corners = [toEN(minU, minV), toEN(maxU, minV), toEN(maxU, maxV), toEN(minU, maxV)];
  const extU = maxU - minU;
  const extV = maxV - minV;
  // 軸は向きを持たないので mod 180。[0, 90) に入る方の軸を「上」とし、その方向の長さを d にする
  let a = normDeg(bearingDeg(u)) % 180;
  let w: number;
  let d: number;
  if (a < 90) {
    d = extU;
    w = extV;
  } else {
    a -= 90;
    d = extV;
    w = extU;
  }
  if (a > 90 - 1e-9) a = 0;
  return { center, angleDeg: a, w, d, corners };
}

/**
 * 辺の長さで重み付けした平均の向き (deg) を 90° の周期で求める（4θ の平均の向きを 1/4 にする）。[0, 90)。
 * 直交する壁の多い建物の外形の「向き」に使う。向きが定まらないときは 0
 */
export function dominantAngleDeg(poly: EN[]): number {
  let c = 0;
  let s = 0;
  let total = 0;
  for (let i = 0; i < poly.length; i++) {
    const d = sub(poly[(i + 1) % poly.length], poly[i]);
    const L = Math.hypot(d.e, d.n);
    if (!(L > 0)) continue;
    const th = 4 * Math.atan2(d.e, d.n);
    c += L * Math.cos(th);
    s += L * Math.sin(th);
    total += L;
  }
  if (!(Math.hypot(c, s) > 1e-9 * total)) return 0;
  let a = Math.atan2(s, c) / 4 / DEG; // (−45, 45]
  a = ((a % 90) + 90) % 90;
  if (a > 90 - 1e-9) a = 0;
  return a;
}

/** 閉じた境界に沿って、間隔が stepM 以下になるように点を置く（各頂点を含む） */
export function densify(poly: EN[], stepM: number): EN[] {
  if (!(stepM > 0) || !Number.isFinite(stepM)) throw new Error(`densify: stepM は正の有限値 (${stepM})`);
  const out: EN[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const k = Math.max(1, Math.ceil(dist(a, b) / stepM));
    for (let j = 0; j < k; j++) out.push(lerp(a, b, j / k));
  }
  return out;
}

// ---------------------------------------------------------------- 外形どうしの位置合わせ

/**
 * 外形 src を外形 dst に重ねる剛体（または相似）変換を ICP で求める。
 * 初期回転の候補: dominantAngle(dst) − dominantAngle(src) + k·90 (k = 0..3) と initialRotDeg。
 * 各候補について面積重心を合わせてから、
 *   src の境界点 → dst 境界上の最近点、dst の境界点 → src 境界上の最近点（逆変換で src 側へ戻して探す）
 * の両方向の対応を solveRigid に渡して繰り返す（片方向だと倍率推定時に一部の辺へ縮む）。
 * 変化（src の境界点の移動の最大値）が 1 mm 未満になるか maxIter で止める。
 * score = rmsM。最小の候補を返し、同点なら initialRotDeg[0]（無ければ 0°）に近い回転を優先する。
 * 点が 3 つ未満、または周長 0 の外形は例外。
 */
export function fitPolygonToPolygon(src: EN[], dst: EN[], opts: FitPolygonOptions = {}): RigidFit & { score: number } {
  if (src.length < 3) throw new Error(`fitPolygonToPolygon: src の点が 3 つ未満です (${src.length})`);
  if (dst.length < 3) throw new Error(`fitPolygonToPolygon: dst の点が 3 つ未満です (${dst.length})`);
  const perSrc = polygonPerimeter(src);
  const perDst = polygonPerimeter(dst);
  if (!(perSrc > 0) || !(perDst > 0)) throw new Error('fitPolygonToPolygon: 周長が 0 の外形です');
  const allowScale = !!opts.allowScale;
  const maxIter = Math.max(1, opts.maxIter ?? 30);
  const stepM = opts.stepM ?? Math.max(perDst / 200, 1e-4);
  if (!(stepM > 0)) throw new Error(`fitPolygonToPolygon: stepM は正の値 (${stepM})`);

  // 初期倍率: 面積比の平方根（面積が 0 なら周長比）。倍率を推定しないときは 1
  let s0 = 1;
  if (allowScale) {
    const aS = Math.abs(polygonArea(src));
    const aD = Math.abs(polygonArea(dst));
    s0 = aS > 0 && aD > 0 ? Math.sqrt(aD / aS) : perDst / perSrc;
  }
  const cS = centroid(src);
  const cD = centroid(dst);
  // src 側は（mm など別単位でも）dst と同じ密度になるように間隔を倍率で割る
  const srcPts = densify(src, stepM / s0);
  const dstPts = densify(dst, stepM);

  const delta = dominantAngleDeg(dst) - dominantAngleDeg(src);
  const cands: number[] = [];
  for (let k = 0; k < 4; k++) cands.push(normDeg180(delta + 90 * k));
  for (const r of opts.initialRotDeg ?? []) if (Number.isFinite(r)) cands.push(normDeg180(r));
  const prefer = (opts.initialRotDeg ?? []).find((r) => Number.isFinite(r)) ?? 0;

  type Scored = RigidFit & { score: number };
  const better = (a: Scored, b: Scored) => {
    const tie = Math.abs(a.score - b.score) <= 1e-6 + 1e-3 * Math.min(a.score, b.score);
    if (tie) return Math.abs(normDeg180(a.rotDeg - prefer)) < Math.abs(normDeg180(b.rotDeg - prefer)) - 1e-9;
    return a.score < b.score;
  };

  let best: Scored | null = null;
  for (const r0 of cands) {
    let fit: RigidFit = { rotDeg: r0, te: 0, tn: 0, scale: s0, scaleRatio: s0, rmsM: NaN };
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
      const next = solveRigid(a, b, { allowScale });
      const cur = srcPts.map((p) => applyFit(next, p));
      let change = 0;
      for (let i = 0; i < cur.length; i++) change = Math.max(change, dist(cur[i], prev[i]));
      prev = cur;
      fit = next;
      if (change < 1e-3) break;
    }
    const cand: Scored = { ...fit, score: fit.rmsM };
    if (!best || better(cand, best)) best = cand;
  }
  return best!;
}

/**
 * 頂点配列（xyz の三つ組）のうち y が [yMin, yMax] にあるものの凸包（EN）。
 * toEN の既定は (x, _, z) → { e: x, n: −z }（PlacedModel の pivot ローカルと同じ）。該当頂点が 3 つ未満なら []
 */
export function sliceOutline(
  positions: ArrayLike<number>,
  opts: { yMin: number; yMax: number; toEN?: (x: number, y: number, z: number) => EN },
): EN[] {
  const toEN = opts.toEN ?? ((x: number, _y: number, z: number): EN => ({ e: x, n: -z }));
  const pts: EN[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const y = positions[i + 1];
    if (y >= opts.yMin && y <= opts.yMax) pts.push(toEN(positions[i], y, positions[i + 2]));
  }
  if (pts.length < 3) return [];
  return convexHull(pts);
}

/**
 * 向きだけを合わせる（「3DS を PDF の外形に合わせる」用）: 両方の最小外接矩形をとり、
 * Δ = dst.angle − src.angle に対して rotDeg ∈ {Δ, Δ+90, Δ+180, Δ+270} を試す。
 * 90° の候補は w と d が入れ替わる。|Δw| + |Δd| が最小の候補を選び、同点なら |normDeg180(rotDeg)| が小さい方。
 * 平行移動 = dst.center − rotate(src.center)。mismatchM は選んだ候補の |Δw| + |Δd|
 */
export function fitRectToRect(src: EN[], dst: EN[]): { rotDeg: number; te: number; tn: number; mismatchM: number; swapped: boolean } {
  const rs = minAreaRect(src);
  const rd = minAreaRect(dst);
  if (!rs) throw new Error('fitRectToRect: src の外形から矩形を作れません（一直線上か 3 点未満）');
  if (!rd) throw new Error('fitRectToRect: dst の外形から矩形を作れません（一直線上か 3 点未満）');
  const delta = rd.angleDeg - rs.angleDeg;
  let best: { rotDeg: number; mismatch: number; swapped: boolean } | null = null;
  for (let k = 0; k < 4; k++) {
    const rotDeg = normDeg180(delta + 90 * k);
    const swapped = k % 2 === 1;
    const mismatch = swapped ? Math.abs(rs.d - rd.w) + Math.abs(rs.w - rd.d) : Math.abs(rs.w - rd.w) + Math.abs(rs.d - rd.d);
    if (!best || mismatch < best.mismatch - 1e-9 || (Math.abs(mismatch - best.mismatch) <= 1e-9 && Math.abs(rotDeg) < Math.abs(best.rotDeg) - 1e-9))
      best = { rotDeg, mismatch, swapped };
  }
  const c = rotate(rs.center, best!.rotDeg);
  return { rotDeg: best!.rotDeg, te: rd.center.e - c.e, tn: rd.center.n - c.n, mismatchM: best!.mismatch, swapped: best!.swapped };
}
