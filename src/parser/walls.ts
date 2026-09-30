/**
 * 壁の検出
 *
 * 平面図の壁は「一定間隔(壁厚)で平行に並ぶ2本の線」または「塗りつぶし多角形の対辺」として描かれる。
 * 1. 線分を角度でグループ化し、各線を (法線方向オフセット, 軸方向区間) で表現
 * 2. 近接する平行線ペアの間隔ヒストグラムから「壁厚」のピークを求める
 * 3. ピークに合致するペアを壁片とし、間に別の平行線がある部分は窓・引戸の記号とみなす
 * 4. 同一軸上の壁片を結合し、残った隙間を開口部候補とする
 * 5. 壁端部を直交壁へ延長して接合
 */
import type { Vec2 } from '../core/types';
import { mergeIntervals, subtractIntervals, intervalsLength } from '../core/geometry';

export interface Seg {
  a: Vec2;
  b: Vec2;
  width: number;
  dashed: boolean;
  source: 'stroke' | 'fill';
}

export interface Arc {
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
}

/** 角度グループ内での線（オフセット・区間表現） */
interface Line {
  o: number;
  t0: number;
  t1: number;
  heavy: boolean;
  eligible: boolean;
  width: number;
  fill: boolean;
}

export interface AngleGroup {
  theta: number;
  u: Vec2;
  n: Vec2;
}

export interface WallPiece {
  g: number; // angle group index
  o: number; // centerline offset
  d: number; // thickness
  t0: number;
  t1: number;
}

export interface Infill {
  g: number;
  o: number;
  d: number;
  t0: number;
  t1: number;
  lines: number;
}

export interface DetectedOpening {
  g: number;
  o: number;
  d: number;
  t0: number;
  t1: number;
  kind: 'window' | 'sliding' | 'door' | 'open';
  /** 開き戸: ヒンジ側 (t0 側なら true) */
  hingeAtStart?: boolean;
  /** 開き戸: 開く方向 (法線 n の符号) */
  swingSign?: 1 | -1;
  confidence: number;
}

export interface WallDetection {
  groups: AngleGroup[];
  pieces: WallPiece[];
  openings: DetectedOpening[];
  thicknessPeaks: number[];
  heavyThreshold: number | null;
}

export interface WallDetectOptions {
  minThickness: number;
  maxThickness: number;
  minSegment: number;
}

const DEFAULTS: WallDetectOptions = { minThickness: 45, maxThickness: 420, minSegment: 40 };

function angleOf(s: Seg): number {
  let th = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
  if (th < 0) th += Math.PI;
  if (th >= Math.PI) th -= Math.PI;
  return th;
}

function segLen(s: Seg) {
  return Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
}

/** 線幅の2クラス分割（重み付き大津法） */
export function heavyWidthThreshold(segs: Seg[]): number | null {
  const strokes = segs.filter((s) => s.source === 'stroke' && s.width > 0);
  if (strokes.length < 10) return null;
  const byW = new Map<number, number>();
  for (const s of strokes) {
    const w = Math.round(s.width * 1000) / 1000;
    byW.set(w, (byW.get(w) ?? 0) + segLen(s));
  }
  const ws = [...byW.entries()].sort((a, b) => a[0] - b[0]);
  if (ws.length < 2) return null;
  const total = ws.reduce((s, [, l]) => s + l, 0);
  let best = -1;
  let bestT: number | null = null;
  for (let i = 1; i < ws.length; i++) {
    const lo = ws.slice(0, i);
    const hi = ws.slice(i);
    const wl = lo.reduce((s, [, l]) => s + l, 0);
    const wh = total - wl;
    if (wl / total < 0.05 || wh / total < 0.08) continue;
    const ml = lo.reduce((s, [w, l]) => s + w * l, 0) / wl;
    const mh = hi.reduce((s, [w, l]) => s + w * l, 0) / wh;
    if (mh / ml < 1.6) continue;
    const between = wl * wh * (mh - ml) * (mh - ml);
    if (between > best) {
      best = between;
      bestT = (ws[i - 1][0] + ws[i][0]) / 2;
    }
  }
  return bestT;
}

export function findAngleGroups(segs: Seg[], minFrac = 0.02): AngleGroup[] {
  const bins = new Float64Array(360); // 0.5度刻み
  let total = 0;
  for (const s of segs) {
    const L = segLen(s);
    const b = Math.floor((angleOf(s) / Math.PI) * 360) % 360;
    bins[b] += L;
    total += L;
  }
  const smooth = new Float64Array(360);
  for (let i = 0; i < 360; i++) {
    smooth[i] = bins[(i + 359) % 360] + bins[i] + bins[(i + 1) % 360];
  }
  const groups: AngleGroup[] = [];
  const used = new Uint8Array(360);
  const order = [...smooth.keys()].sort((a, b) => smooth[b] - smooth[a]);
  for (const i of order) {
    if (smooth[i] < total * minFrac || used[i]) continue;
    // 周辺を使用済みに
    for (let k = -4; k <= 4; k++) used[(i + k + 360) % 360] = 1;
    // 重心角度
    let sw = 0;
    let sa = 0;
    for (let k = -2; k <= 2; k++) {
      const j = (i + k + 360) % 360;
      let a = (j + 0.5) / 2; // 度
      if (i + k < 0) a -= 180;
      if (i + k >= 360) a += 180;
      sw += bins[j];
      sa += bins[j] * a;
    }
    let deg = sa / sw;
    // 0/90 度付近は正確に合わせる（CAD 図面は通常軸平行）
    for (const snap of [0, 90, 180]) if (Math.abs(deg - snap) < 0.6) deg = snap % 180;
    if (deg < 0) deg += 180;
    const th = (deg * Math.PI) / 180;
    groups.push({ theta: th, u: { x: Math.cos(th), y: Math.sin(th) }, n: { x: -Math.sin(th), y: Math.cos(th) } });
  }
  return groups;
}

function angleDiff(a: number, b: number) {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

function assignGroup(s: Seg, groups: AngleGroup[], tolRad: number): number {
  const th = angleOf(s);
  let best = -1;
  let bd = tolRad;
  groups.forEach((g, i) => {
    const d = angleDiff(th, g.theta);
    if (d <= bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

/** 同一直線上で重なる線を統合 */
function mergeCollinear(lines: Line[]): Line[] {
  lines.sort((a, b) => a.o - b.o || a.t0 - b.t0);
  const out: Line[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    const cluster: Line[] = [];
    while (j < lines.length && lines[j].o - lines[i].o < 1.5) cluster.push(lines[j++]);
    const o = cluster.reduce((s, l) => s + l.o * (l.t1 - l.t0), 0) / Math.max(1e-9, cluster.reduce((s, l) => s + (l.t1 - l.t0), 0));
    cluster.sort((a, b) => a.t0 - b.t0);
    let cur: Line | null = null;
    for (const l of cluster) {
      if (cur && l.t0 <= cur.t1 + 2) {
        cur.t1 = Math.max(cur.t1, l.t1);
        cur.heavy ||= l.heavy;
        cur.eligible ||= l.eligible;
        cur.fill ||= l.fill;
        cur.width = Math.max(cur.width, l.width);
      } else {
        if (cur) out.push(cur);
        cur = { ...l, o };
      }
    }
    if (cur) out.push(cur);
    i = j;
  }
  return out;
}

function thicknessPeaks(hist: Float64Array, binSize: number, minT: number): number[] {
  const n = hist.length;
  const sm = new Float64Array(n);
  const k = [1, 2, 3, 2, 1];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -2; j <= 2; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < n) s += hist[idx] * k[j + 2];
    }
    sm[i] = s;
  }
  let max = 0;
  for (const x of sm) max = Math.max(max, x);
  const peaks: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (sm[i] >= sm[i - 1] && sm[i] > sm[i + 1] && sm[i] >= max * 0.2) {
      // 局所重心
      let sw = 0;
      let sx = 0;
      for (let j = -2; j <= 2; j++) {
        const idx = i + j;
        if (idx >= 0 && idx < n) {
          sw += hist[idx];
          sx += hist[idx] * (minT + (idx + 0.5) * binSize);
        }
      }
      peaks.push(sw > 0 ? sx / sw : minT + (i + 0.5) * binSize);
    }
  }
  // 近接ピークの統合
  peaks.sort((a, b) => a - b);
  const merged: number[] = [];
  for (const p of peaks) {
    if (merged.length && p - merged[merged.length - 1] < 18) continue;
    merged.push(p);
  }
  return merged;
}

export function detectWalls(allSegs: Seg[], arcs: Arc[], opts: Partial<WallDetectOptions> = {}, masks: Vec2[][] = []): WallDetection {
  const O = { ...DEFAULTS, ...opts };
  const segs = allSegs.filter((s) => !s.dashed && segLen(s) >= O.minSegment);
  const heavyT = heavyWidthThreshold(segs);
  const groups = findAngleGroups(segs);
  // 壁が塗りつぶしで描かれている場合、塗りの輪郭の角度からも壁の向きを拾う（斜めの壁は全体の線に占める割合が小さい）
  const fillSegs = segs.filter((s) => s.source === 'fill');
  if (fillSegs.length > 40) {
    for (const g of findAngleGroups(fillSegs, 0.006)) {
      if (groups.every((q) => angleDiff(q.theta, g.theta) > (0.8 * Math.PI) / 180)) groups.push(g);
    }
  }

  // グループごとの線
  const groupLines: Line[][] = groups.map(() => []);
  for (const s of segs) {
    const gi = assignGroup(s, groups, (1.2 * Math.PI) / 180);
    if (gi < 0) continue;
    const g = groups[gi];
    const ta = s.a.x * g.u.x + s.a.y * g.u.y;
    const tb = s.b.x * g.u.x + s.b.y * g.u.y;
    const o = ((s.a.x + s.b.x) / 2) * g.n.x + ((s.a.y + s.b.y) / 2) * g.n.y;
    const heavy = s.source === 'fill' || heavyT == null || s.width >= heavyT;
    groupLines[gi].push({ o, t0: Math.min(ta, tb), t1: Math.max(ta, tb), heavy, eligible: heavy, width: s.width, fill: s.source === 'fill' });
  }
  const lines = groupLines.map(mergeCollinear);

  // 壁が塗りつぶしで描かれている図面では、塗りの輪郭だけを壁候補にする（家具・サッシ等の線を除外できる）
  {
    let fillPairLen = 0;
    lines.forEach((ls) => {
      const fl = ls.filter((l) => l.fill);
      for (let i = 0; i < fl.length; i++)
        for (let j = i + 1; j < fl.length; j++) {
          const d = fl[j].o - fl[i].o;
          if (d > 300) break;
          if (d < 60) continue;
          fillPairLen += Math.max(0, Math.min(fl[i].t1, fl[j].t1) - Math.max(fl[i].t0, fl[j].t0));
        }
    });
    if (fillPairLen > 8000) for (const ls of lines) for (const l of ls) l.eligible = l.fill;
  }

  // ---- ペア候補とヒストグラム ----
  interface Pair {
    g: number;
    i: number;
    j: number;
    d: number;
    t0: number;
    t1: number;
  }
  const pairs: Pair[] = [];
  const binSize = 5;
  const hist = new Float64Array(Math.ceil((O.maxThickness - O.minThickness) / binSize));
  lines.forEach((ls, g) => {
    // ls は o でソート済み
    for (let i = 0; i < ls.length; i++) {
      const A = ls[i];
      if (!A.eligible) continue;
      for (let j = i + 1; j < ls.length; j++) {
        const B = ls[j];
        const d = B.o - A.o;
        if (d > O.maxThickness) break;
        if (d < O.minThickness || !B.eligible) continue;
        const t0 = Math.max(A.t0, B.t0);
        const t1 = Math.min(A.t1, B.t1);
        if (t1 - t0 < 60) continue;
        pairs.push({ g, i, j, d, t0, t1 });
      }
    }
  });
  // 入れ子のペアを除外: 壁の2本の線の間にあるサッシ線などとの組は壁ではない
  {
    const bracket = new Map<string, [number, number][]>();
    for (const q of pairs) {
      if (q.d > 260) continue;
      for (let k = q.i + 1; k < q.j; k++) {
        const key = `${q.g}:${k}`;
        if (!bracket.has(key)) bracket.set(key, []);
        bracket.get(key)!.push([q.t0, q.t1]);
      }
    }
    const keep = pairs.filter((p) => {
      const iv = mergeIntervals([...(bracket.get(`${p.g}:${p.i}`) ?? []), ...(bracket.get(`${p.g}:${p.j}`) ?? [])]);
      if (!iv.length) return true;
      const covered = intervalsLength(iv.map(([a, b]) => [Math.max(a, p.t0), Math.min(b, p.t1)] as [number, number]).filter(([a, b]) => b > a));
      return covered < (p.t1 - p.t0) * 0.5;
    });
    pairs.length = 0;
    pairs.push(...keep);
  }
  // 最近接ペアのみでヒストグラムを作る（同じ線の遠いペアはノイズになりやすい）
  {
    const claimedPlus = new Map<string, [number, number][]>();
    const claimedMinus = new Map<string, [number, number][]>();
    const sorted = pairs.slice().sort((a, b) => a.d - b.d);
    for (const p of sorted) {
      const kp = `${p.g}:${p.i}`;
      const km = `${p.g}:${p.j}`;
      const cp = claimedPlus.get(kp) ?? [];
      const cm = claimedMinus.get(km) ?? [];
      const eff = subtractIntervals([p.t0, p.t1], mergeIntervals([...cp, ...cm]));
      const L = intervalsLength(eff);
      if (L <= 0) continue;
      const bin = Math.floor((p.d - O.minThickness) / binSize);
      if (bin >= 0 && bin < hist.length) hist[bin] += L;
      claimedPlus.set(kp, [...cp, ...eff]);
      claimedMinus.set(km, [...cm, ...eff]);
    }
  }
  const peaks = thicknessPeaks(hist, binSize, O.minThickness);
  const matchesPeak = (d: number) => peaks.some((p) => Math.abs(d - p) <= Math.max(12, p * 0.1));

  // ---- 壁片の確定（近い相手を優先） ----
  const pieces: WallPiece[] = [];
  const pieceLines: [number, number][] = [];
  const infills: Infill[] = [];
  const claimedPlus = new Map<string, [number, number][]>();
  const claimedMinus = new Map<string, [number, number][]>();
  const accepted = pairs.filter((p) => matchesPeak(p.d)).sort((a, b) => a.d - b.d);
  for (const p of accepted) {
    const kp = `${p.g}:${p.i}`;
    const km = `${p.g}:${p.j}`;
    const cp = claimedPlus.get(kp) ?? [];
    const cm = claimedMinus.get(km) ?? [];
    const eff = subtractIntervals([p.t0, p.t1], mergeIntervals([...cp, ...cm]));
    if (!eff.length) continue;
    claimedPlus.set(kp, [...cp, ...eff]);
    claimedMinus.set(km, [...cm, ...eff]);
    const ls = lines[p.g];
    const A = ls[p.i];
    const B = ls[p.j];
    const center = (A.o + B.o) / 2;
    // 間にある平行線（窓・引戸の記号）。扉の軌跡など1本だけの線は除外し、2本以上の異なる位置の線を要求
    const betweenLines: Line[] = [];
    for (let k = p.i + 1; k < p.j; k++) {
      const C = ls[k];
      if (C.o <= A.o + 3 || C.o >= B.o - 3) continue;
      betweenLines.push(C);
    }
    for (const e of eff) {
      if (e[1] - e[0] < 40) continue;
      const inf: [number, number][] = [];
      const rel = betweenLines.filter((C) => Math.min(C.t1, e[1]) - Math.max(C.t0, e[0]) >= 150);
      const offs = new Set(rel.map((C) => Math.round(C.o)));
      if (offs.size >= 2) {
        for (const bm of mergeIntervals(rel.map((C) => [C.t0, C.t1] as [number, number]), 30)) {
          const s0 = Math.max(e[0], bm[0]);
          const t = Math.min(e[1], bm[1]);
          if (t - s0 >= 250) inf.push([s0, t]);
        }
      }
      for (const [s0, t] of inf) infills.push({ g: p.g, o: center, d: p.d, t0: s0, t1: t, lines: rel.length });
      for (const part of subtractIntervals(e, inf)) {
        if (part[1] - part[0] >= 40) {
          pieces.push({ g: p.g, o: center, d: p.d, t0: part[0], t1: part[1] });
          pieceLines.push([p.i, p.j]);
        }
      }
    }
  }
  // 階段の踏面のような「はしご状」の繰り返し（線を両側で共有する4組以上の並び）を除外
  {
    const drop = new Set<number>();
    const ov = (a: WallPiece, b: WallPiece) => Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0) > 0.5 * Math.min(a.t1 - a.t0, b.t1 - b.t0);
    const nextOf = (k: number) =>
      pieces.findIndex((q, qi) => qi !== k && q.g === pieces[k].g && pieceLines[qi][0] === pieceLines[k][1] && ov(q, pieces[k]));
    const hasPrev = (k: number) =>
      pieces.some((q, qi) => qi !== k && q.g === pieces[k].g && pieceLines[qi][1] === pieceLines[k][0] && ov(q, pieces[k]));
    for (let k = 0; k < pieces.length; k++) {
      if (hasPrev(k)) continue;
      const chain = [k];
      let cur = k;
      for (let guard = 0; guard < 50; guard++) {
        const n = nextOf(cur);
        if (n < 0 || chain.includes(n)) break;
        chain.push(n);
        cur = n;
      }
      if (chain.length >= 4) chain.forEach((c) => drop.add(c));
    }
    if (drop.size) {
      const kept = pieces.filter((_, k) => !drop.has(k));
      pieces.length = 0;
      pieces.push(...kept);
    }
  }

  // 壁芯線の中に常に線がある図面（芯線表記）では infill を無効化
  const pieceLen = pieces.reduce((s, p) => s + (p.t1 - p.t0), 0);
  const infillLen = infills.reduce((s, p) => s + (p.t1 - p.t0), 0);
  const useInfill = infillLen < (pieceLen + infillLen) * 0.4;
  if (!useInfill) {
    for (const f of infills) pieces.push({ g: f.g, o: f.o, d: f.d, t0: f.t0, t1: f.t1 });
    infills.length = 0;
  }

  // ---- 同一軸の壁片を統合 ----
  const maxPeak = peaks.length ? Math.max(...peaks) : 150;
  const minPeak = peaks.length ? Math.min(...peaks) : 120;
  const joinGap = Math.min(maxPeak + 80, 330);
  const axes = mergeAxes(pieces, joinGap);

  // ---- 開き戸（円弧記号）を先に確定 ----
  const openings: DetectedOpening[] = [];
  const doors = detectDoorSymbols(arcs, allSegs, groups);
  for (const dr of doors) {
    const span = (a: Axis) => {
      const all = [...a.pieces.map((p) => [p.t0, p.t1]), ...a.openings.map((p) => [p.t0, p.t1])];
      return all.some(([t0, t1]) => dr.t0 < t1 + 600 && dr.t1 > t0 - 600);
    };
    let ax = axes.find((a) => a.g === dr.g && Math.abs(a.o - dr.o) <= a.d / 2 + 15 && span(a));
    if (!ax) {
      ax = { g: dr.g, o: dr.o, d: minPeak, pieces: [], openings: [] };
      axes.push(ax);
    }
    const op: DetectedOpening = { ...dr, o: ax.o, d: ax.d };
    // 既存の壁片と重なる部分は削る（ドア位置の線が壁として拾われた場合）
    ax.pieces = ax.pieces.flatMap((p) =>
      subtractIntervals([p.t0, p.t1], [[op.t0 + 5, op.t1 - 5]])
        .filter(([a, b]) => b - a >= 40)
        .map(([a, b]) => ({ ...p, t0: a, t1: b })),
    );
    ax.openings.push(op);
    openings.push(op);
  }

  // ---- 白い塗りで抜かれた部分（窓）----
  // 壁の塗りの上に白い長方形を重ねてガラス部分を表す描き方。壁から除き、窓とする
  for (const poly of masks) {
    for (const ax of axes) {
      const grp = groups[ax.g];
      const ts = poly.map((q) => q.x * grp.u.x + q.y * grp.u.y);
      const os = poly.map((q) => q.x * grp.n.x + q.y * grp.n.y);
      const t0 = Math.min(...ts);
      const t1 = Math.max(...ts);
      const o0 = Math.min(...os);
      const o1 = Math.max(...os);
      // 壁の帯を厚み方向におおむね覆い、帯からはみ出さない細長い長方形
      if (o1 - o0 < ax.d * 0.5 || o0 < ax.o - ax.d / 2 - 30 || o1 > ax.o + ax.d / 2 + 30) continue;
      if (t1 - t0 < 250 || t1 - t0 > 4600) continue;
      if (!ax.pieces.some((p) => p.t0 < t0 + 10 && p.t1 > t1 - 10)) continue;
      if (ax.openings.some((o) => o.t0 < t1 && o.t1 > t0)) continue;
      ax.pieces = ax.pieces.flatMap((p) =>
        subtractIntervals([p.t0, p.t1], [[t0, t1]])
          .filter(([a, b]) => b - a >= 20)
          .map(([a, b]) => ({ ...p, t0: a, t1: b })),
      );
      const op: DetectedOpening = { g: ax.g, o: ax.o, d: ax.d, t0, t1, kind: 'window', confidence: 0.75 };
      ax.openings.push(op);
      openings.push(op);
    }
  }

  // 端部が他の壁に接しているか
  const endJoined = (ax: Axis, t: number) => {
    const grp = groups[ax.g];
    const P = { x: grp.u.x * t + grp.n.x * ax.o, y: grp.u.y * t + grp.n.y * ax.o };
    for (const b of axes) {
      if (b.g === ax.g) continue;
      const gb = groups[b.g];
      const off = P.x * gb.n.x + P.y * gb.n.y - b.o;
      if (Math.abs(off) > b.d / 2 + ax.d / 2 + 40) continue;
      const tb = P.x * gb.u.x + P.y * gb.u.y;
      const tol = ax.d / 2 + 40;
      if ([...b.pieces, ...b.openings].some((p) => tb > p.t0 - tol && tb < p.t1 + tol)) return true;
    }
    return false;
  };

  // ---- 壁片間の隙間の分類 ----
  for (const ax of axes) {
    const occ = [...ax.pieces.map((p) => ({ t0: p.t0, t1: p.t1, op: false })), ...ax.openings.map((p) => ({ t0: p.t0, t1: p.t1, op: true }))].sort(
      (a, b) => a.t0 - b.t0,
    );
    for (let k = 0; k + 1 < occ.length; k++) {
      const gs = occ[k].t1;
      const ge = occ[k + 1].t0;
      const gap = ge - gs;
      if (gap < 250 || gap > 6000) continue;
      const op = classifyGap(ax.g, ax.o, ax.d, gs, ge, groups[ax.g], lines[ax.g], infills);
      // 住宅の窓は最大でも 4.5m 程度。それより広い隙間は別の図（隣の階の図面・屋根の斜線など）
      if (op.kind === 'window' && gap > 4600) continue;
      if (op.kind === 'open') {
        // 壁の途中の開口（両端が自由端）の場合のみ開口とみなす。廊下の通り抜けは開口にしない
        if (occ[k].op || occ[k + 1].op) continue;
        if (endJoined(ax, gs) || endJoined(ax, ge)) continue;
        if (gap > 2800) continue;
      }
      ax.openings.push(op);
      openings.push(op);
    }
    // 端部の infill（角窓など）
    for (const f of infills) {
      if (f.g !== ax.g || Math.abs(f.o - ax.o) > 20) continue;
      if (ax.openings.some((o) => f.t0 < o.t1 && f.t1 > o.t0)) continue;
      if (ax.pieces.some((p) => f.t0 >= p.t0 - 5 && f.t1 <= p.t1 + 5)) continue;
      const op: DetectedOpening = { g: ax.g, o: ax.o, d: ax.d, t0: f.t0, t1: f.t1, kind: 'window', confidence: 0.6 };
      ax.openings.push(op);
      openings.push(op);
    }
  }

  const finalPieces: WallPiece[] = [];
  for (const ax of axes) for (const p of ax.pieces) finalPieces.push({ ...p, o: ax.o, d: ax.d });
  for (const op of openings) {
    const ax = axes.find((a) => a.openings.includes(op));
    if (ax) {
      op.o = ax.o;
      op.d = ax.d;
    }
  }
  return { groups, pieces: finalPieces, openings, thicknessPeaks: peaks, heavyThreshold: heavyT };
}

/** 円弧の外接円（中心・半径） */
function circleOf(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { c: { x: ux, y: uy }, r: Math.hypot(a.x - ux, a.y - uy) };
}

function bez(a: Arc, t: number): Vec2 {
  const u = 1 - t;
  return {
    x: u * u * u * a.p0.x + 3 * u * u * t * a.p1.x + 3 * u * t * t * a.p2.x + t * t * t * a.p3.x,
    y: u * u * u * a.p0.y + 3 * u * u * t * a.p1.y + 3 * u * t * t * a.p2.y + t * t * t * a.p3.y,
  };
}

interface DoorSym {
  g: number;
  o: number;
  d: number;
  t0: number;
  t1: number;
  kind: 'door';
  hingeAtStart: boolean;
  swingSign: 1 | -1;
  confidence: number;
}

/**
 * 開き戸記号の検出: 円弧（中心=吊元、半径=扉幅、約90度）
 * 開口 = 吊元 → 戸先側の円弧端点 (壁上の点)
 */
export function detectDoorSymbols(arcs: Arc[], segs: Seg[], groups: AngleGroup[]): DoorSym[] {
  // 連続するベジェを同一円弧にまとめる
  interface A {
    c: Vec2;
    r: number;
    e0: Vec2;
    e1: Vec2;
  }
  const parts: A[] = [];
  for (const a of arcs) {
    const circ = circleOf(a.p0, bez(a, 0.5), a.p3);
    if (!circ || circ.r < 400 || circ.r > 1400) continue;
    // 円弧であることの確認
    const q = bez(a, 0.25);
    if (Math.abs(Math.hypot(q.x - circ.c.x, q.y - circ.c.y) - circ.r) > circ.r * 0.03) continue;
    const m = parts.find((p) => Math.hypot(p.c.x - circ.c.x, p.c.y - circ.c.y) < 25 && Math.abs(p.r - circ.r) < 25);
    if (m) {
      // 端点をつなげる
      const pts = [m.e0, m.e1, a.p0, a.p3];
      let best = [m.e0, m.e1];
      let bd = -1;
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++) {
          const dd = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
          if (dd > bd) {
            bd = dd;
            best = [pts[i], pts[j]];
          }
        }
      m.e0 = best[0];
      m.e1 = best[1];
    } else parts.push({ c: circ.c, r: circ.r, e0: a.p0, e1: a.p3 });
  }
  const out: DoorSym[] = [];
  for (const p of parts) {
    const v0 = { x: p.e0.x - p.c.x, y: p.e0.y - p.c.y };
    const v1 = { x: p.e1.x - p.c.x, y: p.e1.y - p.c.y };
    const cosang = (v0.x * v1.x + v0.y * v1.y) / (Math.hypot(v0.x, v0.y) * Math.hypot(v1.x, v1.y));
    if (Math.abs(cosang) > 0.26) continue; // 約90度
    // 扉の線（吊元→戸先）がある端点を T とする
    const hasLeaf = (e: Vec2) =>
      segs.some(
        (s) =>
          (Math.hypot(s.a.x - p.c.x, s.a.y - p.c.y) < 40 && Math.hypot(s.b.x - e.x, s.b.y - e.y) < 60) ||
          (Math.hypot(s.b.x - p.c.x, s.b.y - p.c.y) < 40 && Math.hypot(s.a.x - e.x, s.a.y - e.y) < 60),
      );
    const l0 = hasLeaf(p.e0);
    const l1 = hasLeaf(p.e1);
    const candidates: [Vec2, Vec2][] = l0 && !l1 ? [[p.e1, p.e0]] : l1 && !l0 ? [[p.e0, p.e1]] : [[p.e0, p.e1], [p.e1, p.e0]];
    for (const [S, T] of candidates) {
      const dir = Math.atan2(S.y - p.c.y, S.x - p.c.x);
      let th = dir < 0 ? dir + Math.PI : dir;
      if (th >= Math.PI) th -= Math.PI;
      const gi = groups.findIndex((g) => {
        let d = Math.abs(g.theta - th) % Math.PI;
        if (d > Math.PI / 2) d = Math.PI - d;
        return d < (3 * Math.PI) / 180;
      });
      if (gi < 0) continue;
      const g = groups[gi];
      const tc = p.c.x * g.u.x + p.c.y * g.u.y;
      const ts = S.x * g.u.x + S.y * g.u.y;
      const o = p.c.x * g.n.x + p.c.y * g.n.y;
      const sw = (T.x - p.c.x) * g.n.x + (T.y - p.c.y) * g.n.y;
      out.push({
        g: gi,
        o,
        d: 0,
        t0: Math.min(tc, ts),
        t1: Math.max(tc, ts),
        kind: 'door',
        hingeAtStart: tc < ts,
        swingSign: sw > 0 ? 1 : -1,
        confidence: l0 !== l1 ? 0.95 : 0.75,
      });
      break;
    }
  }
  // 両開き（隣接する同軸の扉）を1つに
  out.sort((a, b) => a.g - b.g || a.o - b.o || a.t0 - b.t0);
  const merged: DoorSym[] = [];
  for (const d of out) {
    const last = merged[merged.length - 1];
    if (last && last.g === d.g && Math.abs(last.o - d.o) < 30 && d.t0 - last.t1 < 60 && d.t0 >= last.t0) {
      last.t1 = Math.max(last.t1, d.t1);
      continue;
    }
    merged.push({ ...d });
  }
  return merged;
}

interface Axis {
  g: number;
  o: number;
  d: number;
  pieces: WallPiece[];
  openings: DetectedOpening[];
}

function mergeAxes(pieces: WallPiece[], joinGap: number): Axis[] {
  const byG = new Map<number, WallPiece[]>();
  for (const p of pieces) {
    if (!byG.has(p.g)) byG.set(p.g, []);
    byG.get(p.g)!.push(p);
  }
  const axes: Axis[] = [];
  for (const [g, ps] of byG) {
    ps.sort((a, b) => a.o - b.o);
    // オフセットでクラスタリング
    const clusters: WallPiece[][] = [];
    for (const p of ps) {
      const c = clusters.find((cl) => Math.abs(cl[0].o - p.o) < 15 && Math.abs(cl[0].d - p.d) < 25);
      if (c) c.push(p);
      else clusters.push([p]);
    }
    for (const cl of clusters) {
      const wsum = cl.reduce((s, p) => s + (p.t1 - p.t0), 0);
      const o = cl.reduce((s, p) => s + p.o * (p.t1 - p.t0), 0) / wsum;
      const d = cl.reduce((s, p) => s + p.d * (p.t1 - p.t0), 0) / wsum;
      const iv = mergeIntervals(
        cl.map((p) => [p.t0, p.t1] as [number, number]),
        joinGap,
      );
      // 同じ軸でも大きく離れたもの（別の図）は別軸として扱う必要はない（区間で表現）
      axes.push({ g, o, d, pieces: iv.map(([t0, t1]) => ({ g, o, d, t0, t1 })), openings: [] });
    }
  }
  return axes;
}

function classifyGap(
  g: number,
  o: number,
  d: number,
  gs: number,
  ge: number,
  _grp: AngleGroup,
  lines: Line[],
  infills: Infill[],
): DetectedOpening {
  const gap = ge - gs;
  // infill（壁の間の平行線）による判定
  const inf = infills.filter((f) => f.g === g && Math.abs(f.o - o) < 20 && f.t0 < ge && f.t1 > gs);
  const infCover = intervalsLength(mergeIntervals(inf.map((f) => [Math.max(gs, f.t0), Math.min(ge, f.t1)] as [number, number])));
  // 帯の中の平行線（サッシ・引戸）: 2本以上の異なる位置の線が開口の大部分を覆う
  const inBand = lines.filter(
    (l) =>
      Math.abs(l.o - o) <= d / 2 + 4 &&
      Math.min(l.t1, ge) - Math.max(l.t0, gs) >= Math.min(150, gap * 0.3) &&
      // サッシ・引戸の線は開口内に収まる（壁面の線のように開口外へ長く伸びない）
      l.t0 > gs - 150 &&
      l.t1 < ge + 150,
  );
  const bandIv = mergeIntervals(inBand.map((l) => [Math.max(gs, l.t0), Math.min(ge, l.t1)] as [number, number]), 40);
  const bandCover = intervalsLength(bandIv);
  const offs = [...new Set(inBand.map((l) => Math.round(l.o - o)))];
  const spread = offs.length ? Math.max(...offs) - Math.min(...offs) : 0;
  if (infCover > gap * 0.5 || (bandCover > gap * 0.6 && offs.length >= 2 && spread >= 10)) {
    return { g, o, d, t0: gs, t1: ge, kind: 'window', confidence: infCover > gap * 0.5 ? 0.85 : 0.7 };
  }
  // 壁の面の線が開口を横切って続いている（ARCHITREND 等: 塗りの壁の切れ目＋外面・内面の線＝窓）
  const faceCover = (side: 1 | -1) =>
    intervalsLength(
      mergeIntervals(
        lines
          .filter((l) => Math.abs((l.o - o) * side - d / 2) <= Math.max(25, d * 0.3))
          .map((l) => [Math.max(gs, l.t0), Math.min(ge, l.t1)] as [number, number])
          .filter(([a, b]) => b > a),
        30,
      ),
    );
  const f1 = faceCover(1);
  const f2 = faceCover(-1);
  if ((f1 > gap * 0.7 && f2 > gap * 0.7) || ((f1 > gap * 0.7 || f2 > gap * 0.7) && bandCover > gap * 0.6)) {
    return { g, o, d, t0: gs, t1: ge, kind: 'window', confidence: 0.65 };
  }
  return { g, o, d, t0: gs, t1: ge, kind: 'open', confidence: 0.5 };
}
