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
import { mergeIntervals, subtractIntervals, intervalsLength, pointInPolygon } from '../core/geometry';

export interface Seg {
  a: Vec2;
  b: Vec2;
  width: number;
  dashed: boolean;
  source: 'stroke' | 'fill';
  /** 塗りの輪郭（source = 'fill'）のときの塗りの色 */
  color?: string;
}

export interface Arc {
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
  /** 線幅（分かる場合） */
  width?: number;
  /** 短い直線の連なり（折れ線）から復元した円弧 */
  poly?: boolean;
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
  /** 引込み戸（片引き戸）: 戸袋（開けた戸が収まる壁）が t1 側なら +1、t0 側なら -1 */
  pocketSide?: 1 | -1;
  confidence: number;
  /**
   * 窓・引戸の記号の開口: 開口の区間の中（壁の両面より内側）を通る平行線の位置の数。
   * 0 = 建具の線が無い（白抜きだけ = 建具なしの開口）、1 = 芯に 1 本（FIX）、2 = 引違い、3 以上 = 格子の入った建具など
   */
  inner?: number;
  /**
   * 窓・引戸の記号の開口: 開口の端（どちらか）に、壁の色の塗りが接している = 塗りの壁に開けた開口。
   * 塗りの無い壁（白い「アート壁」など）の横の線を窓と読んだものは false
   */
  filledEnd?: boolean;
}

/** 引込み戸の戸袋（白抜きの溝・戸の隠れ線の点線で分かる、開口ではなく壁のままにする区間） */
interface Pocket {
  g: number;
  o: number;
  t0: number;
  t1: number;
  /** 戸の通る溝が壁芯のどちら側か（法線 n の符号。0 = 芯上） */
  sSign: number;
}

/**
 * 白抜き（マスク）の多角形を壁の軸に沿って区切り、区間ごとに「壁厚のうち白く抜けている割合」を返す。
 * ARCHITREND の引込み戸（片引き戸）は、壁の塗りの上に「開口部は全幅・戸袋は半幅（戸の通る溝）」の
 * L 字／T 字の白抜きを重ねて描くので、全幅の区間が開口、半幅の区間が戸袋（壁のまま）になる。
 * 吉田様邸: トイレの戸（開口 840 + 戸袋 800）が 1,626 の引違い戸として読まれ、洗面の戸も戸袋ごと 1,528 になっていた
 */
function maskSpans(poly: Vec2[], grp: AngleGroup, o: number, d: number): { t0: number; t1: number; cover: number; sSign: number }[] {
  const ts = poly.map((q) => q.x * grp.u.x + q.y * grp.u.y);
  const ss = poly.map((q) => q.x * grp.n.x + q.y * grp.n.y - o);
  // 壁の帯から大きくはみ出す白抜き（部屋の塗り・表の枠）は対象外
  if (Math.min(...ss) < -d / 2 - 30 || Math.max(...ss) > d / 2 + 30) return [];
  const brk = [...new Set(ts.map((t) => Math.round(t)))].sort((a, b) => a - b);
  const out: { t0: number; t1: number; cover: number; sSign: number }[] = [];
  const N = 9;
  const cls = (c: number) => (c >= 0.75 ? 2 : c >= 0.25 ? 1 : 0);
  for (let i = 0; i + 1 < brk.length; i++) {
    const ta = brk[i];
    const tb = brk[i + 1];
    if (tb - ta < 8) continue;
    const tm = (ta + tb) / 2;
    let inside = 0;
    let sSum = 0;
    for (let k = 0; k < N; k++) {
      const s = -d / 2 + (d * (k + 0.5)) / N;
      const P = { x: grp.u.x * tm + grp.n.x * (o + s), y: grp.u.y * tm + grp.n.y * (o + s) };
      if (pointInPolygon(P, poly)) {
        inside++;
        sSum += s;
      }
    }
    const cover = inside / N;
    const sSign = inside ? Math.sign(Math.round(sSum / inside)) : 0;
    const last = out[out.length - 1];
    if (last && last.t1 >= ta - 1 && cls(last.cover) === cls(cover) && last.sSign === sSign) {
      last.t1 = tb;
      last.cover = Math.max(last.cover, cover);
    } else out.push({ t0: ta, t1: tb, cover, sSign });
  }
  return out;
}

/**
 * 同じ位置に並ぶ短い線の列（点線を短い線分で描いたもの）。壁の帯の中にあれば、引込み戸の「開けたときの戸の位置」の隠れ線＝戸袋。
 * 3 本以上、1 本 90mm 以下、間隔 90mm 以下の並びを 1 つの区間にまとめる
 */
function dashTrains(ls: Line[]): { o: number; t0: number; t1: number }[] {
  const out: { o: number; t0: number; t1: number }[] = [];
  const short = ls.filter((l) => !l.fill && l.t1 - l.t0 <= 90).sort((a, b) => a.o - b.o || a.t0 - b.t0);
  let i = 0;
  while (i < short.length) {
    let j = i;
    const chain = [short[i]];
    while (j + 1 < short.length && Math.abs(short[j + 1].o - short[i].o) < 1.5 && short[j + 1].t0 - chain[chain.length - 1].t1 <= 90) {
      j++;
      if (short[j].t0 >= chain[chain.length - 1].t1 - 2) chain.push(short[j]);
    }
    if (chain.length >= 3) out.push({ o: short[i].o, t0: chain[0].t0, t1: chain[chain.length - 1].t1 });
    i = j + 1;
  }
  return out;
}

export interface WallDetection {
  groups: AngleGroup[];
  pieces: WallPiece[];
  openings: DetectedOpening[];
  thicknessPeaks: number[];
  heavyThreshold: number | null;
  /** 太線のうち壁の両面として使われた長さの割合（線の太さで壁を選ぶのが妥当かの指標） */
  heavyPairedFrac: number;
  /**
   * 開口を白抜きで描く図面（壁の塗りの上に白い長方形を重ねて窓・戸を描く）。
   * 壁の塗りが続いていて白抜きの無い所に、窓・戸は無い（窓の無い部屋は、読み落としではなく図面どおり）
   */
  maskStyle?: boolean;
  /** maskStyle の図面で、壁の上の白抜きなのに開口として読めなかった所（白抜きの中心）。この近くでは「窓・戸は無い」と言い切れない */
  maskMissed?: Vec2[];
}

export interface WallDetectOptions {
  minThickness: number;
  maxThickness: number;
  minSegment: number;
  /** 線の太さを使わない（詳細図など、壁の面が細線で描かれた図面） */
  ignoreWidth: boolean;
  /**
   * 平面詳細図モード: 壁が「何本もの細い平行線の帯」（壁面・下地・仕上の線が 100〜200mm の幅に並ぶ）で描かれ、
   * 柱は塗りの正方形になっている図面。帯を壁片として拾う
   */
  bands: boolean;
  /**
   * 壁ではないと分かっている塗りの色（部屋の色・階段の段の色・造作の色）。その輪郭は壁面の候補にしない
   * （窓・引戸の記号の「間の線」としては使う）。壁を灰色の塗りで描く図面で、壁の両側に階段の色の帯が並ぶと、
   * 本物の壁の線の組が「帯に挟まれた入れ子」として捨てられていた（有元様邸 2 階）
   */
  softFillColors?: Set<string>;
}

const DEFAULTS: WallDetectOptions = { minThickness: 45, maxThickness: 420, minSegment: 40, ignoreWidth: false, bands: false };

/**
 * 平面詳細図の壁: 同じ向きの細線が 35mm 以内の間隔で 3 本以上並び、全体の幅が 80〜220mm の帯。
 * 帯の中心を壁芯、幅を壁厚にして、2 本以上の線が重なる区間を壁片にする
 */
function bandPieces(lines: Line[][]): WallPiece[] {
  const out: WallPiece[] = [];
  lines.forEach((all, g) => {
    const ls = all.filter((l) => !l.fill && l.t1 - l.t0 >= 150).sort((a, b) => a.o - b.o);
    const parent = ls.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < ls.length; i++) {
      for (let j = i + 1; j < ls.length && ls[j].o - ls[i].o <= 35; j++) {
        if (Math.min(ls[i].t1, ls[j].t1) - Math.max(ls[i].t0, ls[j].t0) >= 150) {
          const a = find(i);
          const b = find(j);
          if (a !== b) parent[a] = b;
        }
      }
    }
    const groups = new Map<number, Line[]>();
    ls.forEach((l, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(l);
    });
    for (const band of groups.values()) {
      if (band.length < 2) continue;
      const oMin = Math.min(...band.map((l) => l.o));
      const oMax = Math.max(...band.map((l) => l.o));
      const d = oMax - oMin;
      if (d < 80 || d > 220) continue;
      // 2 本だけの帯は 60cm 以上の長さがあるものだけ（サッシ・棚の線を壁にしない）
      const span = Math.max(...band.map((l) => l.t1)) - Math.min(...band.map((l) => l.t0));
      if (band.length === 2 && span < 600) continue;
      // 2 本以上の線が重なる区間
      const ev: [number, number][] = [];
      for (const l of band) ev.push([l.t0, 1], [l.t1, -1]);
      ev.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      let depth = 0;
      let start = 0;
      for (const [t, dd] of ev) {
        const before = depth;
        depth += dd;
        if (before < 2 && depth >= 2) start = t;
        else if (before >= 2 && depth < 2 && t - start >= 100) out.push({ g, o: (oMin + oMax) / 2, d, t0: start, t1: t });
      }
    }
  });
  return out;
}

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
    if (smooth[i] <= 0 || smooth[i] < total * minFrac || used[i]) continue;
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

/**
 * 同じ壁の同じ所に二重に読めた窓の候補のうち、落とすもの。同じ向き（g）で芯のずれが 60mm 以内の候補どうしだけを見る。
 * ① 範囲がほぼ同じ（重なりが長い方の 9 割以上）: 同じ開口を、壁の帯のとなりの軸でも読んだもの（端部の infill の窓が、となりの軸の窓と
 *    同じ所に出る など）。確信度の低い方（同じなら後に読めた方）を落とす。
 * ② 片引戸の戸袋: 壁の間の線で確かめた開口（確信度 0.85 以上）と片方の端がそろい、そこから戸 1 枚分（0.7〜1.4 倍）だけ長い、
 *    確信度の低い候補は「開口＋戸袋（壁が半分の厚さになる所）」を半分ずれた軸で読んだもの。長い方を落とす。
 * 広い開口の中の小さい候補（どちらが本物か決められない）や、戸と窓の重なり（別の処理が決める）は触らない
 */
export function duplicateWindowCandidates(openings: DetectedOpening[]): Set<DetectedOpening> {
  const drop = new Set<DetectedOpening>();
  for (let i = 0; i < openings.length; i++)
    for (let j = i + 1; j < openings.length; j++) {
      const a = openings[i];
      const b = openings[j];
      if (drop.has(a) || drop.has(b) || a.kind !== 'window' || b.kind !== 'window' || a.g !== b.g || Math.abs(a.o - b.o) > 60) continue;
      const ov = Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0);
      const wa = a.t1 - a.t0;
      const wb = b.t1 - b.t0;
      if (ov >= Math.max(wa, wb) * 0.9) {
        drop.add(b.confidence > a.confidence ? a : b);
        continue;
      }
      const [short, long] = wa <= wb ? [a, b] : [b, a];
      const ws = Math.min(wa, wb);
      const extra = Math.max(wa, wb) - ws;
      const sameEnd = Math.abs(short.t0 - long.t0) <= 60 || Math.abs(short.t1 - long.t1) <= 60;
      if (ov >= ws * 0.9 && sameEnd && short.confidence >= 0.85 && long.confidence < short.confidence && extra >= ws * 0.7 && extra <= ws * 1.4) drop.add(long);
    }
  return drop;
}

export function detectWalls(allSegs: Seg[], arcs: Arc[], opts: Partial<WallDetectOptions> = {}, masks: Vec2[][] = []): WallDetection {
  const O = { ...DEFAULTS, ...opts };
  const segs = allSegs.filter((s) => !s.dashed && segLen(s) >= O.minSegment);
  const heavyT = O.ignoreWidth ? null : heavyWidthThreshold(segs);
  // 曲線の壁（玄関の角のR など）は弦の直線壁に置き換えて拾う
  const curved = curvedWallChords(arcs, segs, heavyT, O);
  const chords = curved.segs;
  segs.push(...chords);
  // 曲線壁に使った円弧はドア記号の候補から外す
  arcs = arcs.filter((a) => !curved.used.has(a));
  const groups = findAngleGroups(segs);
  for (const g of findAngleGroups(chords, 0)) {
    if (groups.every((q) => angleDiff(q.theta, g.theta) > (0.8 * Math.PI) / 180)) groups.push(g);
  }
  // 壁が塗りつぶしで描かれている場合、塗りの輪郭の角度からも壁の向きを拾う（斜めの壁は全体の線に占める割合が小さい）
  const fillSegs = segs.filter((s) => s.source === 'fill');
  if (fillSegs.length > 40) {
    for (const g of findAngleGroups(fillSegs, 0.006)) {
      if (groups.every((q) => angleDiff(q.theta, g.theta) > (0.8 * Math.PI) / 180)) groups.push(g);
    }
  }

  // グループごとの線
  const groupLines: Line[][] = groups.map(() => []);
  /** 塗りの輪郭の線を、塗りの色ごとに（軸の向きごと）。壁の色の塗りだけを見分けるため */
  const fillByColor: Map<string, Line[]>[] = groups.map(() => new Map<string, Line[]>());
  for (const s of segs) {
    const gi = assignGroup(s, groups, (1.2 * Math.PI) / 180);
    if (gi < 0) continue;
    const g = groups[gi];
    const ta = s.a.x * g.u.x + s.a.y * g.u.y;
    const tb = s.b.x * g.u.x + s.b.y * g.u.y;
    const o = ((s.a.x + s.b.x) / 2) * g.n.x + ((s.a.y + s.b.y) / 2) * g.n.y;
    // 壁ではない色の塗りの輪郭は、壁面の候補にも「壁の塗りが続いている所」にも数えない
    const soft = s.source === 'fill' && !!s.color && !!O.softFillColors?.has(s.color);
    const isFill = s.source === 'fill' && !soft;
    const heavy = !soft && (isFill || heavyT == null || s.width >= heavyT);
    groupLines[gi].push({ o, t0: Math.min(ta, tb), t1: Math.max(ta, tb), heavy, eligible: heavy, width: s.width, fill: isFill });
    if (isFill && s.color) {
      const m = fillByColor[gi];
      (m.get(s.color) ?? m.set(s.color, []).get(s.color)!).push({ o, t0: Math.min(ta, tb), t1: Math.max(ta, tb), heavy, eligible: heavy, width: s.width, fill: true });
    }
  }
  // 塗りの輪郭だけの線（壁の塗りが続いている所を知るため。mergeCollinear は配列を並べ替えるので写しで）
  const fillLines = groupLines.map((ls) => mergeCollinear(ls.filter((l) => l.fill).map((l) => ({ ...l }))));
  /** 軸 g の位置 o（±6mm）で、区間 [t0,t1] のうち壁の塗りの輪郭が通っている長さ */
  const fillCover = (g: number, o: number, t0: number, t1: number) =>
    intervalsLength(
      mergeIntervals(
        fillLines[g]
          .filter((l) => Math.abs(l.o - o) <= 6)
          .map((l) => [Math.max(t0, l.t0), Math.min(t1, l.t1)] as [number, number])
          .filter(([a, b]) => b > a),
        20,
      ),
    );
  // 壁の色の塗り: 壁厚の間隔（60〜300mm）で向かい合う 40cm 以上の辺の長さが最も長い色（同じくらい長い色があればそれも）。
  // 階段の段・手すり壁の色の塗りは、輪郭が壁の面に重なっていても「壁の塗り」ではない
  // （段の色の帯が向かい合う長さは、多い図面で壁の 65%: 有元様邸。割合の低い線引きでは分けられない）
  const wallFillLines: Line[][] = groups.map(() => []);
  {
    const merged = fillByColor.map((m) => new Map([...m].map(([c, ls]) => [c, mergeCollinear(ls)] as const)));
    const pairLen = new Map<string, number>();
    for (const m of merged)
      for (const [c, ls] of m) {
        const fl = ls.filter((l) => l.t1 - l.t0 >= 400);
        let sum = 0;
        for (let i = 0; i < fl.length; i++)
          for (let j = i + 1; j < fl.length; j++) {
            const d = fl[j].o - fl[i].o;
            if (d > 300) break;
            if (d < 60) continue;
            sum += Math.max(0, Math.min(fl[i].t1, fl[j].t1) - Math.max(fl[i].t0, fl[j].t0));
          }
        pairLen.set(c, (pairLen.get(c) ?? 0) + sum);
      }
    const top = Math.max(0, ...pairLen.values());
    if (top > 0) merged.forEach((m, g) => { for (const [c, ls] of m) if ((pairLen.get(c) ?? 0) >= top * 0.8) wallFillLines[g].push(...ls); });
  }
  /** 軸 g の位置 o（±6mm）で、区間 [t0,t1] のうち「壁の色の塗り」の輪郭が通っている長さ */
  const wallFillCover = (g: number, o: number, t0: number, t1: number) =>
    intervalsLength(
      mergeIntervals(
        wallFillLines[g]
          .filter((l) => Math.abs(l.o - o) <= 6)
          .map((l) => [Math.max(t0, l.t0), Math.min(t1, l.t1)] as [number, number])
          .filter(([a, b]) => b > a),
        20,
      ),
    );
  const lines = groupLines.map(mergeCollinear);
  // 点線を短い線分で描いたもの（引込み戸の隠れ線など）の並び
  const trains = lines.map(dashTrains);
  const pockets: Pocket[] = [];

  // 壁が塗りつぶしで描かれている図面では、塗りの輪郭だけを壁候補にする（家具・サッシ等の線を除外できる）
  {
    let fillPairLen = 0;
    lines.forEach((ls) => {
      // 柱の塗り（105〜120mm の正方形）は壁の塗りではないので、40cm 以上の辺だけを見る
      const fl = ls.filter((l) => l.fill && l.t1 - l.t0 >= 400);
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
    const bracket = new Map<string, [number, number, number][]>();
    // 仮の主要壁厚（長さ加重の最頻値）: 二重壁の判定に使う
    let domT = 0;
    {
      const h = new Map<number, number>();
      for (const q of pairs) {
        const b = Math.round(q.d / 5) * 5;
        h.set(b, (h.get(b) ?? 0) + (q.t1 - q.t0));
      }
      let best = 0;
      for (const [b, v] of h) if (v > best) { best = v; domT = b; }
    }
    {
      // デバッグ: __WALLDBG_O = [min, max] の範囲にある線とペアを出力
      const rng = (globalThis as any).__WALLDBG_O as [number, number] | undefined;
      if (rng) {
        for (let g = 0; g < lines.length; g++) for (const l of lines[g]) if (Math.abs(l.o) >= rng[0] && Math.abs(l.o) <= rng[1]) console.log('LINE', g, JSON.stringify({ o: Math.round(l.o), t0: Math.round(l.t0), t1: Math.round(l.t1), heavy: l.heavy, eligible: l.eligible, width: l.width }));
        for (const q of pairs) { const qo = (lines[q.g][q.i].o + lines[q.g][q.j].o) / 2; if (Math.abs(qo) >= rng[0] && Math.abs(qo) <= rng[1]) console.log('PAIR', q.g, JSON.stringify({ o: Math.round(qo), d: Math.round(q.d), t0: Math.round(q.t0), t1: Math.round(q.t1), i: q.i, j: q.j })); }
      }
    }
    for (let qi = 0; qi < pairs.length; qi++) {
      const q = pairs[qi];
      if (q.d > 260) continue;
      // 二重壁（外壁の内側にもう 1 枚の壁）: 間の線が 1 本だけで、両側がそれぞれ壁厚になる太線なら、サッシ線ではなく壁面
      {
        const ls = lines[q.g];
        const inner = [];
        for (let k = q.i + 1; k < q.j; k++) {
          const C = ls[k];
          if (C.o <= ls[q.i].o + 3 || C.o >= ls[q.j].o - 3) continue;
          if (Math.min(C.t1, q.t1) - Math.max(C.t0, q.t0) > (q.t1 - q.t0) * 0.3) inner.push(k);
        }
        if (inner.length === 1 && q.t1 - q.t0 >= 600) {
          const C = ls[inner[0]];
          const ov = Math.min(C.t1, q.t1) - Math.max(C.t0, q.t0);
          // 引違い戸の 3 本線や棚の線（間隔が狭い・短い）は対象外: 両側の間隔が壁厚相当で、長さもある場合だけ
          // 両側の間隔がどちらも主要な壁厚（±12%）であること（収納のパイプ・棚の線は間隔が壁厚と違う）
          const nearT = (d: number) => d >= Math.max(O.minThickness, 75) && (domT <= 0 || Math.abs(d - domT) <= Math.max(12, domT * 0.12));
          if (C.heavy && ov > (q.t1 - q.t0) * 0.5 && C.t1 - C.t0 >= 600 && nearT(C.o - ls[q.i].o) && nearT(ls[q.j].o - C.o)) {
            if ((globalThis as any).__WALLDBG_O) console.log('DOUBLE', q.g, JSON.stringify({ o0: Math.round(ls[q.i].o), oc: Math.round(C.o), o1: Math.round(ls[q.j].o), t0: Math.round(q.t0), t1: Math.round(q.t1), ct0: Math.round(C.t0), ct1: Math.round(C.t1), cw: C.width }));
            continue;
          }
        }
      }
      for (let k = q.i + 1; k < q.j; k++) {
        const key = `${q.g}:${k}`;
        if (!bracket.has(key)) bracket.set(key, []);
        bracket.get(key)!.push([q.t0, q.t1, qi]);
      }
    }
    const keep = pairs.filter((p) => {
      const ls = lines[p.g];
      const nearDom = domT > 0 && Math.abs(p.d - domT) <= Math.max(10, domT * 0.1);
      const lenOf = (k: number) => ls[k].t1 - ls[k].t0;
      const ivs = [...(bracket.get(`${p.g}:${p.i}`) ?? []), ...(bracket.get(`${p.g}:${p.j}`) ?? [])].filter(([, , qi]) => {
        if (!nearDom) return true;
        // 主要な壁厚のペアは、壁面を共有して相手の線が壁面より短い組（壁面と、接する階段の塗り・家具の輪郭）では入れ子にしない
        const q = pairs[qi];
        if (q.i === p.i) return lenOf(q.j) >= 0.6 * lenOf(p.j);
        if (q.j === p.j) return lenOf(q.i) >= 0.6 * lenOf(p.i);
        // ずれて重なる 2 枚の壁（収納の奥の壁と階段室の壁を 12cm ずらして並べた厚い壁など）: どちらも主要な壁厚で、
        // 面の線が互い違いに並ぶ（A の面・B の面・A の面・B の面）。互いに「相手の 2 本の間にある線との組」になって
        // 両方とも捨てられ、厚い壁が丸ごと読めていなかった（市岡様邸 3 階: 階段の突き当たりの壁 31cm。洋室とホールがつながる）
        if (!(globalThis as { __NO_OFFSET_DOUBLE_WALL?: boolean }).__NO_OFFSET_DOUBLE_WALL) {
          const qDom = Math.abs(q.d - domT) <= Math.max(10, domT * 0.1);
          const interleaved = (q.i < p.i && p.i < q.j && q.j < p.j) || (p.i < q.i && q.i < p.j && p.j < q.j);
          if (qDom && interleaved && Math.abs(ls[q.i].o - ls[p.i].o) >= 50 && Math.min(p.t1, q.t1) - Math.max(p.t0, q.t0) >= 600) return false;
        }
        return true;
      });
      const iv = mergeIntervals(ivs.map(([a, b]) => [a, b] as [number, number]));
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
  const infillLines: [number, number][] = [];
  const claimedPlus = new Map<string, [number, number][]>();
  const claimedMinus = new Map<string, [number, number][]>();
  const accepted = pairs.filter((p) => matchesPeak(p.d)).sort((a, b) => a.d - b.d);
  // 引込み戸の戸袋: 帯の中に「戸の隠れ線の点線」か「白抜きの半幅の溝」がある区間は、開口（infill）ではなく壁のまま
  const pocketsFor = (g: number, A: Line, B: Line, center: number, d: number, t0: number, t1: number): [number, number][] => {
    const out: [number, number][] = [];
    // 白抜きが全幅で抜けている区間（開口そのもの）
    const fulls: [number, number][] = [];
    for (const poly of masks) {
      const spans = maskSpans(poly, groups[g], center, d);
      if (!spans.length) continue;
      const maxCover = Math.max(...spans.map((s) => s.cover));
      const fullThr = Math.max(0.5, Math.min(0.75, maxCover));
      for (const sp of spans) {
        if (sp.t1 <= t0 || sp.t0 >= t1) continue;
        if (sp.cover >= fullThr) {
          fulls.push([sp.t0, sp.t1]);
          continue;
        }
        if (sp.cover < 0.25 || sp.t1 - sp.t0 < 150) continue;
        out.push([sp.t0, sp.t1]);
        pockets.push({ g, o: center, t0: sp.t0, t1: sp.t1, sSign: sp.sSign });
      }
    }
    for (const tr of trains[g]) {
      if (tr.o <= A.o + 3 || tr.o >= B.o - 3 || tr.t1 <= t0 || tr.t0 >= t1) continue;
      // 白抜きが全幅で抜けている所の点線は、開口の中で開けた戸が重なる位置（片引き窓の FIX の前など）であって戸袋ではない
      const inOpen = intervalsLength(fulls.map(([a, b]) => [Math.max(a, tr.t0), Math.min(b, tr.t1)] as [number, number]).filter(([a, b]) => b > a));
      if (inOpen > (tr.t1 - tr.t0) * 0.5) continue;
      // 戸袋の裏付け: 戸の通る溝の線（壁芯から壁厚の 0.15〜0.45 倍の所に、点線の区間の 6 割以上に沿う線）があること
      // （点線だけで戸袋とみなすと、折れ戸・破線の多い図面で開口が壁に変わった: 伊藤様邸の収納の前）
      const slot = lines[g].some((l) => {
        if (l.fill) return false;
        const off = Math.abs(l.o - center);
        if (off < d * 0.15 || off > d * 0.45) return false;
        return Math.min(l.t1, tr.t1) - Math.max(l.t0, tr.t0) >= (tr.t1 - tr.t0) * 0.6;
      });
      if (!slot) continue;
      out.push([tr.t0, tr.t1]);
      pockets.push({ g, o: center, t0: tr.t0, t1: tr.t1, sSign: Math.sign(Math.round(tr.o - center)) });
    }
    return mergeIntervals(out);
  };
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
        const pk = pocketsFor(p.g, A, B, center, p.d, e[0], e[1]);
        for (const bm of mergeIntervals(rel.map((C) => [C.t0, C.t1] as [number, number]), 30)) {
          const s0 = Math.max(e[0], bm[0]);
          const t = Math.min(e[1], bm[1]);
          if (t - s0 < 250) continue;
          // 区間の中の線が 1 本だけで、壁の塗り（グレーの塗り）が両面とも続いている所は、窓・引戸ではなく壁の芯線
          // （田中様 1 階: 芯線だけの 2.9m の壁が引戸になっていた）。
          // 塗りだけでは決めない: 塗りの上にサッシを描く図面（池本様邸）では、窓の所も塗りが続いている
          const here = new Set(rel.filter((C) => Math.min(C.t1, t) - Math.max(C.t0, s0) >= 150).map((C) => Math.round(C.o)));
          const fc = (oo: number) => fillCover(p.g, oo, s0, t);
          if (here.size < 2 && fc(A.o) >= (t - s0) * 0.8 && fc(B.o) >= (t - s0) * 0.8) continue;
          for (const part of subtractIntervals([s0, t], pk)) if (part[1] - part[0] >= 250) inf.push(part);
        }
      }
      for (const [s0, t] of inf) {
        infills.push({ g: p.g, o: center, d: p.d, t0: s0, t1: t, lines: rel.length });
        infillLines.push([p.i, p.j]);
      }
      for (const part of subtractIntervals(e, inf)) {
        if (part[1] - part[0] >= 40) {
          pieces.push({ g: p.g, o: center, d: p.d, t0: part[0], t1: part[1] });
          pieceLines.push([p.i, p.j]);
        }
      }
    }
  }
  // 壁の塗りの上に白抜きで開口を描く図面（ARCHITREND のカラー・グレーの平面図）では、窓も戸も必ず白抜きになっている。
  // 壁の塗りが両面とも続いていて白抜きの無い区間にある平行線は、窓・引戸の記号ではなく壁の中を通る線
  // （土間のタイルの見切り・壁芯の線・壁付けの造作の縁）なので、壁に戻す。開口は白抜きの幅どおりになる。
  // 林様邸 1 階: 玄関と土間収納の間の柱と壁 52cm が「引戸」、土間収納の外壁 1.8m が「窓」に。
  // 吉田様邸 1 階: LDK と玄関の間の壁 1.1m が「引戸」に。坂井様邸・伊藤様邸: 窓の無い外壁に 6m・2.8m の「窓」。
  // 窓の幅も、隣の壁の中の線まで延びて 2,180・2,780・5,010 などになっていた（白抜きは 1,690・2,600＋1,235）
  let maskStyle = false;
  if (masks.length && infills.length && !(globalThis as { __NO_FILLWALL?: boolean }).__NO_FILLWALL) {
    const filled = (f: Infill, a: number, b: number) =>
      wallFillCover(f.g, f.o - f.d / 2, a, b) >= (b - a) * 0.8 && wallFillCover(f.g, f.o + f.d / 2, a, b) >= (b - a) * 0.8;
    // 白抜きが壁厚の全幅で抜けている区間
    const fullOf = (f: Infill): [number, number][] =>
      mergeIntervals(
        masks.flatMap((poly) => {
          const spans = maskSpans(poly, groups[f.g], f.o, f.d);
          if (!spans.length) return [];
          const fullThr = Math.max(0.5, Math.min(0.75, Math.max(...spans.map((sp) => sp.cover))));
          return spans
            .filter((sp) => sp.cover >= fullThr && sp.t1 > f.t0 && sp.t0 < f.t1)
            .map((sp) => [Math.max(f.t0, sp.t0), Math.min(f.t1, sp.t1)] as [number, number]);
        }),
      );
    const fulls = infills.map(fullOf);
    // この図面が「塗り＋白抜き」の描き方か: 塗りの壁の中の infill の半分以上（3 か所以上）が白抜きになっている
    const onFill = infills.map((f, k) => (filled(f, f.t0, f.t1) ? k : -1)).filter((k) => k >= 0);
    const masked = onFill.filter((k) => intervalsLength(fulls[k]) >= (infills[k].t1 - infills[k].t0) * 0.5);
    if (masked.length >= 3 && masked.length >= onFill.length * 0.5) {
      maskStyle = true;
      const keepInf: Infill[] = [];
      const keepLines: [number, number][] = [];
      infills.forEach((f, k) => {
        const back = subtractIntervals([f.t0, f.t1], fulls[k]).filter(([a, b]) => b - a >= 40 && filled(f, a, b));
        if (!back.length) {
          keepInf.push(f);
          keepLines.push(infillLines[k]);
          return;
        }
        for (const [a, b] of back) {
          pieces.push({ g: f.g, o: f.o, d: f.d, t0: a, t1: b });
          pieceLines.push(infillLines[k]);
        }
        for (const [a, b] of subtractIntervals([f.t0, f.t1], back)) {
          if (b - a < 250) {
            // 残りが短い（25cm 未満）ときは開口の候補にしない
            if (b - a >= 40) {
              pieces.push({ g: f.g, o: f.o, d: f.d, t0: a, t1: b });
              pieceLines.push(infillLines[k]);
            }
            continue;
          }
          keepInf.push({ ...f, t0: a, t1: b });
          keepLines.push(infillLines[k]);
        }
      });
      infills.length = 0;
      infills.push(...keepInf);
      infillLines.length = 0;
      infillLines.push(...keepLines);
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

  // 平面詳細図モード: 細線の帯を壁片に加える（同じ所にある通常の壁片と重なっても mergeAxes でまとまる）
  if (O.bands) {
    for (const b of bandPieces(lines)) {
      pieces.push(b);
      pieceLines.push([-1, -1]);
    }
  }
  // 壁芯線の中に常に線がある図面（芯線表記）では infill を無効化
  const pieceLen = pieces.reduce((s, p) => s + (p.t1 - p.t0), 0);
  const infillLen = infills.reduce((s, p) => s + (p.t1 - p.t0), 0);
  const useInfill = infillLen < (pieceLen + infillLen) * 0.4;
  if ((globalThis as any).__WALLDBG) {
    console.log('INFILL', Math.round(infillLen), 'PIECES', Math.round(pieceLen), 'useInfill', useInfill, 'pockets', pockets.length);
    for (const pk of pockets) console.log('POCKET', pk.g, Math.round(pk.o), Math.round(pk.t0), Math.round(pk.t1), 'sSign', pk.sSign);
  }
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
  if ((globalThis as any).__WALLDBG) for (const dr of doors) console.log('DOOR', dr.g, Math.round(dr.o), Math.round(dr.t0), Math.round(dr.t1), 'curvedUsed', curved.used.size, 'arcsLeft', arcs.length);
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
  // 壁の塗りの上に白い長方形を重ねてガラス部分を表す描き方。壁から除き、窓とする。
  // 白抜きが壁厚の全幅に及ぶ区間だけを開口にし、半幅の区間（引込み戸の戸袋の溝）は壁のまま（戸袋として覚える）
  for (const poly of masks) {
    for (const ax of axes) {
      const grp = groups[ax.g];
      const spans = maskSpans(poly, grp, ax.o, ax.d);
      if (!spans.length) continue;
      const maxCover = Math.max(...spans.map((s) => s.cover));
      const fullThr = Math.max(0.5, Math.min(0.75, maxCover));
      if ((globalThis as any).__WALLDBG) console.log('MASK', Math.round(ax.o), 'd', Math.round(ax.d), spans.map((s) => `${Math.round(s.t0)}-${Math.round(s.t1)} c${s.cover.toFixed(2)}`).join(' '), 'pieces', ax.pieces.map((p) => `${Math.round(p.t0)}-${Math.round(p.t1)}`).join(' '), 'ops', ax.openings.map((p) => `${Math.round(p.t0)}-${Math.round(p.t1)}`).join(' '));
      for (const sp of spans) {
        const { t0, t1 } = sp;
        if (sp.cover < fullThr) {
          if (sp.cover >= 0.25 && t1 - t0 >= 150) pockets.push({ g: ax.g, o: ax.o, t0, t1, sSign: sp.sSign });
          continue;
        }
        if (t1 - t0 < 250 || t1 - t0 > 4600) continue;
        // 開き戸の横の FIX（袖のガラス）: 白抜きが戸の開口に少し（15cm まで）掛かっているだけなら、掛かった分を除いた残りを見る
        // （池本様邸 1 階の猫部屋: 戸の横の FIX 781mm の白抜きが戸の開口に 5cm 重なり、まるごと捨てられて壁になっていた）
        const over = ax.openings.filter((o) => o.t0 < t1 && o.t1 > t0);
        const rest = over.length && over.every((o) => Math.min(o.t1, t1) - Math.max(o.t0, t0) <= 150) ? subtractIntervals([t0, t1], over.map((o) => [o.t0, o.t1] as [number, number])).filter(([a, b]) => b - a >= 250) : over.length ? [] : [[t0, t1] as [number, number]];
        for (const [a, b] of rest) {
          if (!ax.pieces.some((p) => p.t0 < a + 10 && p.t1 > b - 10)) continue;
          ax.pieces = ax.pieces.flatMap((p) =>
            subtractIntervals([p.t0, p.t1], [[a, b]])
              .filter(([x, y]) => y - x >= 20)
              .map(([x, y]) => ({ ...p, t0: x, t1: y })),
          );
          const op: DetectedOpening = { g: ax.g, o: ax.o, d: ax.d, t0: a, t1: b, kind: 'window', confidence: 0.75 };
          ax.openings.push(op);
          openings.push(op);
        }
      }
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
      // 両側が柱の塗り（壁厚の正方形）だけで、2m を超えて離れている隙間は開口ではない。窓と窓の間の柱と直交する壁の柱が
      // 並ぶと、その間が「隙間＝引戸」に分類されて部屋を横切る壁が生まれていた（吉田様邸 2 階の洋室 5.3 帖がベッドの所で 2 つに割れた）
      const isPost = (q: { t0: number; t1: number; op: boolean }) => !q.op && q.t1 - q.t0 <= ax.d * 1.3;
      const op = classifyGap(ax.g, ax.o, ax.d, gs, ge, groups[ax.g], lines[ax.g], infills, isPost(occ[k]) && isPost(occ[k + 1]));
      if ((globalThis as any).__WALLDBG) console.log('GAP', Math.round(ax.o), Math.round(gs), Math.round(ge), op.kind, 'opEnds', occ[k].op, occ[k + 1].op, 'joined', endJoined(ax, gs), endJoined(ax, ge));
      // 住宅の窓は最大でも 4.5m 程度。それより広い隙間は別の図（隣の階の図面・屋根の斜線など）
      if (op.kind === 'window' && gap > 4600) continue;
      if (op.kind === 'open') {
        // 壁の途中の開口（両端が自由端）の場合のみ開口とみなす。廊下の通り抜けは開口にしない
        if (occ[k].op || occ[k + 1].op) continue;
        // 両端が別の壁に接する隙間は廊下の通り抜け。片端だけ接する隙間は、扉の幅までなら出入口とみなす
        // （壁の端と直交壁の交点の間の 800mm 程度の切れ目を無視すると、外壁に穴が開いたまま 3D になる）
        const jA = endJoined(ax, gs);
        const jB = endJoined(ax, ge);
        if (jA && jB) continue;
        if ((jA || jB) && gap > 1100) continue;
        if (gap > 2800) continue;
      }
      ax.openings.push(op);
      openings.push(op);
    }
    // 壁の端と直交する壁の間の隙間（吹抜のガラス壁・玄関横の大きな窓など）: 窓の描き方（サッシの平行線）なら窓。
    // 壁片同士の隙間ではないため上の分類に掛からず、壁が途切れて見えていた
    if (occ.length) {
      const grp = groups[ax.g];
      for (const side of [-1, 1] as const) {
        const tEnd = side < 0 ? occ[0].t0 : occ[occ.length - 1].t1;
        let tCross: number | null = null;
        for (const b of axes) {
          if (b.g === ax.g) continue;
          const gb = groups[b.g];
          const dot = grp.u.x * gb.n.x + grp.u.y * gb.n.y;
          if (Math.abs(dot) < 0.7) continue;
          // この軸の線が b の軸と交わる位置 t と、b の軸上での位置 tb
          const t = (b.o - ax.o * (grp.n.x * gb.n.x + grp.n.y * gb.n.y)) / dot;
          const gapHere = (t - tEnd) * side;
          if (gapHere < 250 || gapHere > 4600) continue;
          const P = { x: grp.u.x * t + grp.n.x * ax.o, y: grp.u.y * t + grp.n.y * ax.o };
          const tb = P.x * gb.u.x + P.y * gb.u.y;
          if (!b.pieces.some((p) => tb > p.t0 - b.d / 2 - 40 && tb < p.t1 + b.d / 2 + 40)) continue;
          if (tCross === null || Math.abs(t - tEnd) < Math.abs(tCross - tEnd)) tCross = t;
        }
        if (tCross === null) continue;
        const gs = side < 0 ? tCross : tEnd;
        const ge = side < 0 ? tEnd : tCross;
        if (ax.openings.some((o) => o.t0 < ge && o.t1 > gs)) continue;
        const op = classifyGap(ax.g, ax.o, ax.d, gs, ge, grp, lines[ax.g], infills);
        if (op.kind !== 'window' || op.confidence < 0.7) continue;
        ax.openings.push(op);
        openings.push(op);
      }
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
  // 同じ壁の同じ所に重なった窓の候補は 1 つにする（田中様邸 3 階: 東の窓が二重になっていた）
  if (!(globalThis as { __NO_OPENING_DEDUPE?: boolean }).__NO_OPENING_DEDUPE) {
    const drop = duplicateWindowCandidates(openings);
    if (drop.size) {
      for (const ax of axes) ax.openings = ax.openings.filter((o) => !drop.has(o));
      for (let i = openings.length - 1; i >= 0; i--) if (drop.has(openings[i])) openings.splice(i, 1);
    }
  }
  // 引込み戸: 開口のすぐ隣に戸袋（白抜きの溝・隠れ線の点線）が戸の幅の半分以上あれば、引き込む側と戸の面を付ける
  for (const op of openings) {
    if (op.kind !== 'window') continue;
    const w = op.t1 - op.t0;
    const pk = pockets.find(
      (q) => q.g === op.g && Math.abs(q.o - op.o) <= 20 && q.t1 - q.t0 >= w * 0.4 && (Math.abs(q.t0 - op.t1) <= 60 || Math.abs(q.t1 - op.t0) <= 60),
    );
    if (!pk) continue;
    op.pocketSide = Math.abs(pk.t0 - op.t1) <= 60 ? 1 : -1;
    if (pk.sSign && op.swingSign == null) op.swingSign = pk.sSign > 0 ? 1 : -1;
  }
  // 開口の中を通る線（建具の線）の位置の数
  for (const op of openings) {
    if (op.kind !== 'window') continue;
    const w = op.t1 - op.t0;
    const offs = new Set<number>();
    for (const l of lines[op.g]) {
      const off = l.o - op.o;
      if (Math.abs(off) > op.d / 2 - 8) continue;
      if (Math.min(l.t1, op.t1) - Math.max(l.t0, op.t0) < Math.min(200, w * 0.3)) continue;
      offs.add(Math.round(off / 4));
    }
    op.inner = offs.size;
    // 開口の端から 15cm の区間に、壁の色の塗りの輪郭が（どちらかの面で）半分以上通っているか
    const touch = (a: number, b: number) => [-1, 1].some((sd) => wallFillCover(op.g, op.o + (sd * op.d) / 2, a, b) >= (b - a) * 0.5);
    op.filledEnd = touch(op.t0 - 150, op.t0) || touch(op.t1, op.t1 + 150);
  }
  let heavyLen = 0;
  for (const ls of lines) for (const l of ls) if (l.heavy && !l.fill) heavyLen += l.t1 - l.t0;
  const pairedLen = finalPieces.reduce((s0, q) => s0 + 2 * (q.t1 - q.t0), 0);
  const heavyPairedFrac = heavyT == null || heavyLen <= 0 ? 1 : Math.min(1, pairedLen / heavyLen);
  // 壁の上の白抜き（全幅で 25cm 以上）のうち、開口として読めなかった所
  const maskMissed: Vec2[] = [];
  if (maskStyle) {
    for (const poly of masks) {
      for (const ax of axes) {
        if (!ax.pieces.length && !ax.openings.length) continue;
        const spans = maskSpans(poly, groups[ax.g], ax.o, ax.d);
        if (!spans.length) continue;
        const fullThr = Math.max(0.5, Math.min(0.75, Math.max(...spans.map((sp) => sp.cover))));
        // 軸の壁・開口の並びの外（図面の別の所の白抜き）は数えない
        const a0 = Math.min(...ax.pieces.map((p) => p.t0), ...ax.openings.map((o) => o.t0));
        const a1 = Math.max(...ax.pieces.map((p) => p.t1), ...ax.openings.map((o) => o.t1));
        for (const sp of spans) {
          if (sp.cover < fullThr || sp.t1 - sp.t0 < 250) continue;
          if (sp.t1 < a0 - 50 || sp.t0 > a1 + 50) continue;
          // 開き戸は自分の軸を持つことがあるので、同じ向きで帯が重なる開口をすべて見る
          const near = openings.filter((o) => o.g === ax.g && Math.abs(o.o - ax.o) <= ax.d / 2 + o.d / 2 + 20);
          const got = intervalsLength(mergeIntervals(near.map((o) => [Math.max(sp.t0, o.t0), Math.min(sp.t1, o.t1)] as [number, number]).filter(([a, b]) => b > a)));
          if (got >= (sp.t1 - sp.t0) * 0.5) continue;
          const grp = groups[ax.g];
          const tm = (sp.t0 + sp.t1) / 2;
          maskMissed.push({ x: grp.u.x * tm + grp.n.x * ax.o, y: grp.u.y * tm + grp.n.y * ax.o });
        }
      }
    }
  }
  return { groups, pieces: finalPieces, openings, thicknessPeaks: peaks, heavyThreshold: heavyT, heavyPairedFrac, ...(maskStyle ? { maskStyle, maskMissed } : {}) };
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

/**
 * 円弧を短い直線の連なりで書き出す CAD（ARCHITREND など）向けに、折れ線から円弧を復元する。
 * 端点でつながる短い線を、同じ向きに少しずつ曲がる限りたどり、1 つの円に乗っていれば
 * 90°以下ずつのベジェ円弧にして返す（開き戸の軌跡の検出に使う）。
 */
export function polylineArcs(segs: Seg[], minR = 300, maxR = 1600): Arc[] {
  const cand = segs.filter((s) => !s.dashed && segLen(s) >= 3 && segLen(s) <= 260);
  const key = (p: Vec2) => `${Math.round(p.x / 3)},${Math.round(p.y / 3)}`;
  const at = new Map<string, number[]>();
  cand.forEach((s, i) => {
    for (const p of [s.a, s.b]) {
      const k = key(p);
      if (!at.has(k)) at.set(k, []);
      at.get(k)!.push(i);
    }
  });
  const near = (p: Vec2) => {
    const out = new Set<number>();
    const kx = Math.round(p.x / 3);
    const ky = Math.round(p.y / 3);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of at.get(`${kx + dx},${ky + dy}`) ?? []) out.add(i);
    return [...out].filter((i) => Math.min(Math.hypot(cand[i].a.x - p.x, cand[i].a.y - p.y), Math.hypot(cand[i].b.x - p.x, cand[i].b.y - p.y)) < 4);
  };
  const used = new Uint8Array(cand.length);
  const out: Arc[] = [];
  const turn = (a: Vec2, b: Vec2, c: Vec2) => {
    const a1 = Math.atan2(b.y - a.y, b.x - a.x);
    let d = Math.atan2(c.y - b.y, c.x - b.x) - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };
  for (let i0 = 0; i0 < cand.length; i0++) {
    if (used[i0]) continue;
    used[i0] = 1;
    const pts: Vec2[] = [cand[i0].a, cand[i0].b];
    const w = cand[i0].width;
    // 両方向へ伸ばす
    for (const dir of [1, -1]) {
      if (dir === -1) pts.reverse();
      for (;;) {
        const end = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        // 交わる線がある頂点でも、いちばん滑らかにつながる線をたどる
        // 座標の丸めで 1 区間ごとの曲がりは揺れるので、直近 3 区間の合計で曲がる向きを見る
        let t0 = 0;
        for (let k = Math.max(1, pts.length - 4); k + 1 < pts.length; k++) t0 += turn(pts[k - 1], pts[k], pts[k + 1]);
        let best = -1;
        let bestNxt: Vec2 | null = null;
        let bestT = Infinity;
        for (const j of near(end)) {
          if (used[j]) continue;
          const s = cand[j];
          const nxt = Math.hypot(s.a.x - end.x, s.a.y - end.y) < 4 ? s.b : s.a;
          const t = turn(prev, end, nxt);
          if (Math.abs(t) > (25 * Math.PI) / 180) continue;
          if (Math.abs(t0) > (6 * Math.PI) / 180 && Math.sign(t0) !== Math.sign(t + t0)) continue;
          const dev = Math.abs(t - t0 / 3);
          if (dev < bestT) {
            bestT = dev;
            best = j;
            bestNxt = nxt;
          }
        }
        if (best < 0 || !bestNxt) break;
        used[best] = 1;
        pts.push(bestNxt);
      }
    }
    if (pts.length < 5) continue;
    // 円に乗る区間を探す（端に直線などが混ざっていれば少しずつ削る）
    let circ: { c: Vec2; r: number } | null = null;
    trim: for (let cut = 0; cut <= Math.floor(pts.length * 0.3); cut++)
      for (let lo = 0; lo <= cut; lo++) {
        const sub = pts.slice(lo, pts.length - (cut - lo));
        if (sub.length < 5) break trim;
        const c = circleOf(sub[0], sub[Math.floor(sub.length / 2)], sub[sub.length - 1]);
        if (!c || c.r < minR || c.r > maxR) continue;
        if (sub.some((p) => Math.abs(Math.hypot(p.x - c.c.x, p.y - c.c.y) - c.r) > Math.max(6, c.r * 0.03))) continue;
        circ = c;
        pts.splice(0, pts.length, ...sub);
        break trim;
      }
    if (!circ) continue;
    let sweep = 0;
    for (let k = 1; k + 1 < pts.length; k++) sweep += turn(pts[k - 1], pts[k], pts[k + 1]);
    // 折れ線の頂点での曲がりの合計は (n-1)/n 分しか数えないので、両端の半分ずつを足す
    sweep *= (pts.length - 1) / Math.max(1, pts.length - 2);
    if (Math.abs(sweep) < (20 * Math.PI) / 180) continue;
    const a0 = Math.atan2(pts[0].y - circ.c.y, pts[0].x - circ.c.x);
    const n = Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-6);
    const step = sweep / n;
    const P = (a: number) => ({ x: circ.c.x + Math.cos(a) * circ.r, y: circ.c.y + Math.sin(a) * circ.r });
    const kk = (4 / 3) * Math.tan(Math.abs(step) / 4) * circ.r;
    for (let k = 0; k < n; k++) {
      const s0 = a0 + step * k;
      const s1 = s0 + step;
      const sg = Math.sign(step);
      const p0 = P(s0);
      const p3 = P(s1);
      out.push({
        p0,
        p1: { x: p0.x - Math.sin(s0) * kk * sg, y: p0.y + Math.cos(s0) * kk * sg },
        p2: { x: p3.x + Math.sin(s1) * kk * sg, y: p3.y - Math.cos(s1) * kk * sg },
        p3,
        width: w,
        poly: true,
      });
    }
  }
  return out;
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
/**
 * 同心に近い 2 本の円弧（壁の内側線と外側線）を、弦に沿った直線壁 2 本（平行線ペア）に置き換える。
 * 円弧の壁は角度グループ・平行線ペアの検出に乗らないため、ここで直線化して壁検出に渡す。
 */
export function curvedWallChords(arcs: Arc[], segs: Seg[], heavyT: number | null, O: WallDetectOptions): { segs: Seg[]; used: Set<Arc> } {
  // 壁線（太線）の端点。曲線壁は直線壁の続きとして描かれるので、円弧の両端に壁線の端が無ければ家具・設備の円弧とみなす
  const wallEnds: Vec2[] = [];
  for (const s of segs) {
    if (segLen(s) < 60) continue;
    if (heavyT != null && s.source === 'stroke' && s.width < heavyT) continue;
    wallEnds.push(s.a, s.b);
  }
  const touchesWall = (p: Vec2) => wallEnds.some((e) => Math.hypot(e.x - p.x, e.y - p.y) < 120);
  interface A {
    c: Vec2;
    r: number;
    e0: Vec2;
    e1: Vec2;
    width: number | undefined;
    used: boolean;
    arcs: Arc[];
  }
  const parts: A[] = [];
  for (const a of arcs) {
    if (a.poly) continue;
    const circ = circleOf(a.p0, bez(a, 0.5), a.p3);
    if (!circ || circ.r < 300 || circ.r > 8000) continue;
    const q = bez(a, 0.25);
    if (Math.abs(Math.hypot(q.x - circ.c.x, q.y - circ.c.y) - circ.r) > circ.r * 0.03) continue;
    // 同一円の連続ベジェをつなぐ（端点が一致するもの）
    const m = parts.find(
      (p) =>
        Math.hypot(p.c.x - circ.c.x, p.c.y - circ.c.y) < 10 &&
        Math.abs(p.r - circ.r) < 10 &&
        [p.e0, p.e1].some((e) => [a.p0, a.p3].some((f) => Math.hypot(e.x - f.x, e.y - f.y) < 5)),
    );
    if (m) {
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
      m.arcs.push(a);
    } else parts.push({ c: circ.c, r: circ.r, e0: a.p0, e1: a.p3, width: a.width, used: false, arcs: [a] });
  }
  const used = new Set<Arc>();
  const spanOf = (p: A) => {
    const a0 = Math.atan2(p.e0.y - p.c.y, p.e0.x - p.c.x);
    const a1 = Math.atan2(p.e1.y - p.c.y, p.e1.x - p.c.x);
    let d = Math.abs(a1 - a0);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  };
  const out: Seg[] = [];
  for (let i = 0; i < parts.length; i++) {
    const P = parts[i];
    if (P.used) continue;
    const sp = spanOf(P);
    // 30°〜150°の円弧のみ（半円・全円は家具・設備）
    if (sp < Math.PI / 6 || sp > Math.PI * (150 / 180)) continue;
    if (!touchesWall(P.e0) || !touchesWall(P.e1)) continue;
    for (let j = i + 1; j < parts.length; j++) {
      const Q = parts[j];
      if (Q.used) continue;
      const sq = spanOf(Q);
      if (sq < Math.PI / 6 || sq > Math.PI * (150 / 180)) continue;
      if (!touchesWall(Q.e0) || !touchesWall(Q.e1)) continue;
      if (Math.hypot(P.c.x - Q.c.x, P.c.y - Q.c.y) > O.maxThickness) continue;
      if (Math.abs(P.r - Q.r) > O.maxThickness) continue;
      // 端点同士を対応づけ、その距離が壁厚になる
      const d00 = Math.hypot(P.e0.x - Q.e0.x, P.e0.y - Q.e0.y);
      const d11 = Math.hypot(P.e1.x - Q.e1.x, P.e1.y - Q.e1.y);
      const d01 = Math.hypot(P.e0.x - Q.e1.x, P.e0.y - Q.e1.y);
      const d10 = Math.hypot(P.e1.x - Q.e0.x, P.e1.y - Q.e0.y);
      const straight = d00 + d11 <= d01 + d10;
      const tA = straight ? d00 : d01;
      const tB = straight ? d11 : d10;
      const t = (tA + tB) / 2;
      if (Math.min(tA, tB) < O.minThickness * 0.8 || Math.max(tA, tB) > O.maxThickness) continue;
      if (Math.abs(tA - tB) > t * 0.5) continue;
      // 線幅が分かる図面では、太線（壁線）であること
      if (heavyT != null && P.width != null && Q.width != null && Math.max(P.width, Q.width) < heavyT) continue;
      const Qe0 = straight ? Q.e0 : Q.e1;
      const Qe1 = straight ? Q.e1 : Q.e0;
      // 中心線の弦
      const m0 = { x: (P.e0.x + Qe0.x) / 2, y: (P.e0.y + Qe0.y) / 2 };
      const m1 = { x: (P.e1.x + Qe1.x) / 2, y: (P.e1.y + Qe1.y) / 2 };
      const L = Math.hypot(m1.x - m0.x, m1.y - m0.y);
      if (L < 300) continue;
      const nx = -(m1.y - m0.y) / L;
      const ny = (m1.x - m0.x) / L;
      const w = Math.max(1, heavyT ?? 1, P.width ?? 0, Q.width ?? 0);
      for (const sgn of [-1, 1]) {
        out.push({
          a: { x: m0.x + nx * sgn * (t / 2), y: m0.y + ny * sgn * (t / 2) },
          b: { x: m1.x + nx * sgn * (t / 2), y: m1.y + ny * sgn * (t / 2) },
          width: w,
          dashed: false,
          source: 'stroke',
        });
      }
      P.used = Q.used = true;
      for (const a of [...P.arcs, ...Q.arcs]) used.add(a);
      if ((globalThis as any).__WALLDBG) console.log('CHORD', Math.round(m0.x), Math.round(m0.y), '->', Math.round(m1.x), Math.round(m1.y), 't', Math.round(t), 'r', Math.round(P.r), Math.round(Q.r), 'span', Math.round((sp * 180) / Math.PI), Math.round((sq * 180) / Math.PI), 'w', P.width, Q.width, 'heavyT', heavyT);
      break;
    }
  }
  return { segs: out, used };
}

export function detectDoorSymbols(arcs: Arc[], segs: Seg[], groups: AngleGroup[]): DoorSym[] {
  // 連続するベジェを同一円弧にまとめる
  interface A {
    c: Vec2;
    r: number;
    e0: Vec2;
    e1: Vec2;
    poly: boolean;
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
    } else parts.push({ c: circ.c, r: circ.r, e0: a.p0, e1: a.p3, poly: !!a.poly });
  }
  // 折れ線から復元した円弧のうち、同心でわずかに半径の違う相手があるもの（R の壁の内外の線）は扉ではない
  const wallArc = (p: (typeof parts)[number]) =>
    p.poly && parts.some((q) => q !== p && Math.hypot(q.c.x - p.c.x, q.c.y - p.c.y) < 150 && Math.abs(q.r - p.r) > 40 && Math.abs(q.r - p.r) < 300);
  const out: DoorSym[] = [];
  for (const p of parts) {
    const v0 = { x: p.e0.x - p.c.x, y: p.e0.y - p.c.y };
    const v1 = { x: p.e1.x - p.c.x, y: p.e1.y - p.c.y };
    const cosang = (v0.x * v1.x + v0.y * v1.y) / (Math.hypot(v0.x, v0.y) * Math.hypot(v1.x, v1.y));
    if (Math.abs(cosang) > 0.26) continue; // 約90度
    // 扉の線（吊元→戸先）がある端点を T とする
    // 折れ線から復元した円弧は端が数度手前で終わることがあり（83° など）、戸の板は厚み 30〜40 の長方形で描かれる。
    // 端点どうしの距離だけで見ると 60mm を超えて「板なし」になる（田中様の玄関ドア・勝手口）ので、
    // 「吊元から出て、長さが半径とほぼ同じで、弧の端の方向（±12°）を向く線」も板とみなす
    const eAng = (e: Vec2) => Math.atan2(e.y - p.c.y, e.x - p.c.x);
    const leafLike = (near: Vec2, far: Vec2, e: Vec2) => {
      if (Math.hypot(near.x - p.c.x, near.y - p.c.y) >= 45) return false;
      const d = Math.hypot(far.x - p.c.x, far.y - p.c.y);
      if (Math.abs(d - p.r) > Math.max(60, p.r * 0.08)) return false;
      let da = Math.abs(Math.atan2(far.y - p.c.y, far.x - p.c.x) - eAng(e));
      if (da > Math.PI) da = 2 * Math.PI - da;
      return da < ((p.poly ? 12 : 5) * Math.PI) / 180;
    };
    /** 弧の端 e の側にある戸の板の、戸先側の端点（無ければ null） */
    const leafEnd = (e: Vec2): Vec2 | null => {
      for (const s of segs) {
        if ((Math.hypot(s.a.x - p.c.x, s.a.y - p.c.y) < 40 && Math.hypot(s.b.x - e.x, s.b.y - e.y) < 60) || leafLike(s.a, s.b, e)) return s.b;
        if ((Math.hypot(s.b.x - p.c.x, s.b.y - p.c.y) < 40 && Math.hypot(s.a.x - e.x, s.a.y - e.y) < 60) || leafLike(s.b, s.a, e)) return s.a;
      }
      return null;
    };
    if (wallArc(p)) continue;
    const le0 = leafEnd(p.e0);
    const le1 = leafEnd(p.e1);
    const l0 = !!le0;
    const l1 = !!le1;
    // 折れ線の円弧は家具・設備の曲線も多いので、扉の線（吊元→戸先）があるものだけ
    if (p.poly && !l0 && !l1) continue;
    const candidates: [Vec2, Vec2][] = l0 && !l1 ? [[p.e1, p.e0]] : l1 && !l0 ? [[p.e0, p.e1]] : [[p.e0, p.e1], [p.e1, p.e0]];
    for (const [S0, T] of candidates) {
      // 板（吊元→戸先 T）が分かっているときは、閉じた位置 S は板に直角の向き。
      // 折れ線の弧は端が手前で終わる（83° など）ので、弧の端そのものを使うと壁の向きから 7° ずれて落ちていた
      let S = S0;
      const tip = l0 !== l1 ? (T === p.e0 ? le0 : le1) : null;
      if (tip) {
        const tl = Math.hypot(tip.x - p.c.x, tip.y - p.c.y) || 1;
        const vx = (tip.x - p.c.x) / tl;
        const vy = (tip.y - p.c.y) / tl;
        const sg = -vy * (S0.x - p.c.x) + vx * (S0.y - p.c.y) >= 0 ? 1 : -1;
        S = { x: p.c.x - vy * sg * p.r, y: p.c.y + vx * sg * p.r };
      }
      const dir = Math.atan2(S.y - p.c.y, S.x - p.c.x);
      let th = dir < 0 ? dir + Math.PI : dir;
      if (th >= Math.PI) th -= Math.PI;
      const gi = groups.findIndex((g) => {
        let d = Math.abs(g.theta - th) % Math.PI;
        if (d > Math.PI / 2) d = Math.PI - d;
        // 折れ線から復元した円弧は端点が数 mm ずれるので少し甘く
        return d < ((p.poly ? 6 : 3) * Math.PI) / 180;
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
  /** 隙間の両端の壁片が、どちらも柱の塗り（壁厚ほどの正方形）だけか */
  betweenPosts = false,
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
  // 帯の中の線が「サッシ・引戸」に見えるか: どれか 1 つの位置の線が開口の大半を覆う（枠・敷居の線は端から端まで通る）か、
  // 位置の違う線どうしが重なっている（引違いの障子は召し合わせで重なる）こと。
  // 位置の違う線が、重ならずに入れ替わりで並ぶだけなら窓ではない: 階段の側桁の線 → 踊り場の縁の線、のように、
  // 別々の物の縁がたまたま帯の中に並んだもの（林様邸 2 階: 階段室の東西の壁の柱と柱の間 3.5m が「窓の壁」になり、
  // 階段の曲がり角を天井までの壁が横切っていた）
  // 見るのは、両端が柱だけ（壁の塗りが無い）で 2m を超える隙間だけ: 壁と壁の間の窓は今までどおり
  const sashLike = (): boolean => {
    if (!betweenPosts || gap <= 2000 || (globalThis as { __NO_GAP_SASH_CHECK?: boolean }).__NO_GAP_SASH_CHECK) return true;
    const sorted = [...inBand].sort((a, b) => a.o - b.o);
    const groupsByOff: [number, number][][] = [];
    let lastO = -Infinity;
    for (const l of sorted) {
      if (l.o - lastO > 8) groupsByOff.push([]);
      lastO = l.o;
      groupsByOff[groupsByOff.length - 1].push([Math.max(gs, l.t0), Math.min(ge, l.t1)]);
    }
    const covs = groupsByOff.map((iv) => mergeIntervals(iv, 40));
    if (covs.some((c) => intervalsLength(c) >= gap * 0.6)) return true;
    for (let i = 0; i < covs.length; i++)
      for (let j = i + 1; j < covs.length; j++)
        for (const [a0, a1] of covs[i]) for (const [b0, b1] of covs[j]) if (Math.min(a1, b1) - Math.max(a0, b0) >= 40) return true;
    return false;
  };
  // 帯の中の平行線だけが根拠のものは確信度 0.7（柱と柱の間に家具の縁が入っただけのこともある → assemble の「弱い壁」で部屋と照合）
  if (infCover > gap * 0.5 || (bandCover > gap * 0.6 && offs.length >= 2 && spread >= 10 && sashLike())) {
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
  // 片方の面の線＋帯の中の線で窓とする組: 壁の面すれすれを通る 1 本の線は「面の線」と「帯の中の線」の両方に数えられる。
  // その 1 本が、等間隔に並ぶ平行線の列（階段の段の線）の 1 本なら、窓の線ではない
  // （市岡様邸 4 階: 両側の壁の中の柱と柱の間を階段の段の線が通っていて、階段の途中に「壁＋引戸」ができ、階段が 2 つに切れていた）。
  // 列になっていない 1 本（造作の棚の前の線など）は今までどおり（服部様邸 1 階のペット室: 棚の所を分けると図面の 4.4 帖に合う）
  const faceAndBand = (side: 1 | -1): boolean => {
    if ((globalThis as { __NO_GAP_TWO_LINES?: boolean }).__NO_GAP_TWO_LINES) return true;
    const near = lines.filter((l) => Math.abs((l.o - o) * side - d / 2) <= Math.max(25, d * 0.3) && Math.min(l.t1, ge) - Math.max(l.t0, gs) > 0);
    const all = [...near, ...inBand];
    if (!all.length || new Set(all.map((l) => Math.round(l.o / 10))).size >= 2) return true;
    const L = all[0];
    // 両隣の同じ長さの線までの間隔（150〜330mm = 階段の踏面）
    const sibling = (dir: 1 | -1): number | null => {
      let best: number | null = null;
      for (const l of lines) {
        const dd = (l.o - L.o) * dir;
        if (dd < 150 || dd > 330) continue;
        if (Math.min(l.t1, ge) - Math.max(l.t0, gs) < gap * 0.8 || l.t0 < gs - 150 || l.t1 > ge + 150) continue;
        if (best == null || dd < best) best = dd;
      }
      return best;
    };
    const p1 = sibling(1);
    const p2 = sibling(-1);
    return !(p1 != null && p2 != null && Math.abs(p1 - p2) <= 15);
  };
  if ((f1 > gap * 0.7 && f2 > gap * 0.7) || (((f1 > gap * 0.7 && faceAndBand(1)) || (f2 > gap * 0.7 && faceAndBand(-1))) && bandCover > gap * 0.6)) {
    return { g, o, d, t0: gs, t1: ge, kind: 'window', confidence: 0.65 };
  }
  return { g, o, d, t0: gs, t1: ge, kind: 'open', confidence: 0.5 };
}
