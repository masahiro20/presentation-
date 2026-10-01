/**
 * 画像（ラスタ）からの壁の検出
 *
 * 手描き風に描かれた図面（Illustrator の手描きブラシ等）は線が揺れていて「完全に平行な2本線」として
 * 拾えない。スキャンした図面も同様。そこで壁の線を画像に描き、2本の線の間を埋めて「帯」にしてから、
 * 主な向きごとに回転した格子の上で、一定の太さで長く続く帯を壁として取り出す。
 * 結果は線分から検出した場合と同じ WallDetection の形で返すので、以降の処理（部屋の分割・開口・3D）は共通。
 */
import type { Vec2 } from '../core/types';
import type { AngleGroup, DetectedOpening, Seg, WallDetection, WallPiece } from './walls';
import { dilateMask, erodeMask } from './raster';

export interface BinaryImage {
  /** 1 = 線（黒） */
  data: Uint8Array;
  w: number;
  h: number;
  /** 1画素の大きさ (mm) と原点 (mm) */
  res: number;
  ox: number;
  oy: number;
}

export interface RasterWallOptions {
  /** 壁の2本の線の間を埋めるための閉じ処理の半径（画素） */
  closeRadius: number;
  /** 壁の太さの範囲 (mm) */
  minThickness: number;
  maxThickness: number;
  /** 壁とみなす最小の長さ (mm) */
  minLength: number;
}

const DEFAULTS: RasterWallOptions = { closeRadius: 4, minThickness: 60, maxThickness: 330, minLength: 450 };

/** 線分を画像に描く（太さ width mm） */
export function rasterizeSegments(segs: Seg[], bbox: { minX: number; minY: number; maxX: number; maxY: number }, res: number, margin = 600): BinaryImage {
  const ox = bbox.minX - margin;
  const oy = bbox.minY - margin;
  const w = Math.ceil((bbox.maxX - bbox.minX + margin * 2) / res);
  const h = Math.ceil((bbox.maxY - bbox.minY + margin * 2) / res);
  const data = new Uint8Array(w * h);
  for (const s of segs) {
    const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    const n = Math.max(1, Math.ceil(L / (res * 0.5)));
    const r = Math.max(0, Math.floor((s.width || 0) / 2 / res));
    for (let k = 0; k <= n; k++) {
      const x = Math.floor((s.a.x + ((s.b.x - s.a.x) * k) / n - ox) / res);
      const y = Math.floor((s.a.y + ((s.b.y - s.a.y) * k) / n - oy) / res);
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) data[yy * w + xx] = 1;
        }
    }
  }
  return { data, w, h, res, ox, oy };
}

/** 線分の向きの主な角度（長さで重み付け、0〜180度） */
export function dominantAngles(segs: Seg[], minFrac = 0.06): number[] {
  const bins = new Float64Array(360); // 0.5度刻み
  for (const s of segs) {
    const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    if (L < 100) continue;
    let a = (Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x) * 180) / Math.PI;
    a = ((a % 180) + 180) % 180;
    bins[Math.floor(a * 2) % 360] += L;
  }
  // 揺れのある線のため ±2度でならす
  const sm = new Float64Array(360);
  for (let i = 0; i < 360; i++) for (let d = -4; d <= 4; d++) sm[i] += bins[(i + d + 360) % 360] * (1 - Math.abs(d) / 5);
  const max = Math.max(...sm);
  const peaks: number[] = [];
  for (let i = 0; i < 360; i++) {
    const v = sm[i];
    if (v < max * minFrac) continue;
    let isPeak = true;
    for (let d = -8; d <= 8 && isPeak; d++) if (d && sm[(i + d + 360) % 360] > v) isPeak = false;
    if (isPeak && peaks.every((p) => Math.min(Math.abs(p - i / 2), 180 - Math.abs(p - i / 2)) > 4)) peaks.push(i / 2 + 0.25);
  }
  return peaks;
}

/** 画像から壁を検出する */
export function detectWallsRaster(img: BinaryImage, anglesDeg: number[], opts: Partial<RasterWallOptions> = {}): WallDetection {
  const O = { ...DEFAULTS, ...opts };
  const { w, h, res } = img;
  // 2本線の間を埋める（閉じ処理）
  const closed = erodeMask(dilateMask(img.data, w, h, O.closeRadius), w, h, O.closeRadius);
  const groups: AngleGroup[] = anglesDeg.map((deg) => {
    const th = (deg * Math.PI) / 180;
    return { theta: th, u: { x: Math.cos(th), y: Math.sin(th) }, n: { x: -Math.sin(th), y: Math.cos(th) } } as AngleGroup;
  });
  const pieces: WallPiece[] = [];
  const openings: DetectedOpening[] = [];
  const corners: Vec2[] = [
    { x: img.ox, y: img.oy },
    { x: img.ox + w * res, y: img.oy },
    { x: img.ox, y: img.oy + h * res },
    { x: img.ox + w * res, y: img.oy + h * res },
  ];
  const minRun = Math.ceil(O.minLength / res);
  groups.forEach((g, gi) => {
    // 回転した格子（t: 壁の向き, o: 法線方向）
    const ts = corners.map((p) => p.x * g.u.x + p.y * g.u.y);
    const os = corners.map((p) => p.x * g.n.x + p.y * g.n.y);
    const t0 = Math.min(...ts);
    const o0 = Math.min(...os);
    const W = Math.ceil((Math.max(...ts) - t0) / res);
    const H = Math.ceil((Math.max(...os) - o0) / res);
    const sample = (ti: number, oi: number) => {
      const t = t0 + (ti + 0.5) * res;
      const o = o0 + (oi + 0.5) * res;
      const x = Math.floor((g.u.x * t + g.n.x * o - img.ox) / res);
      const y = Math.floor((g.u.y * t + g.n.y * o - img.oy) / res);
      return x >= 0 && y >= 0 && x < w && y < h ? closed[y * w + x] : 0;
    };
    // 各行の長い連続（1画素の切れは揺れとしてつなぐ）
    type Run = { a: number; b: number };
    const rows: Run[][] = [];
    for (let oi = 0; oi < H; oi++) {
      const runs: Run[] = [];
      let start = -1;
      let gap = 0;
      for (let ti = 0; ti <= W; ti++) {
        const v = ti < W ? sample(ti, oi) : 0;
        if (v) {
          if (start < 0) start = ti;
          gap = 0;
        } else if (start >= 0) {
          gap++;
          if (gap > 1 || ti === W) {
            const end = ti - gap;
            if (end - start + 1 >= minRun) runs.push({ a: start, b: end });
            start = -1;
            gap = 0;
          }
        }
      }
      rows.push(runs);
    }
    // 隣り合う行の重なる連続をつないで帯にする
    interface Band {
      first: number;
      rows: Run[][];
      last: Run[];
    }
    const done: Band[] = [];
    let active: Band[] = [];
    for (let oi = 0; oi < H; oi++) {
      const next: Band[] = [];
      const used = new Set<Band>();
      for (const r of rows[oi]) {
        const b = active.find((bd) => !used.has(bd) && bd.last.some((q) => Math.min(q.b, r.b) - Math.max(q.a, r.a) >= 0.5 * Math.min(q.b - q.a, r.b - r.a)));
        if (b) {
          used.add(b);
          b.rows.push([r]);
          b.last = [r];
          next.push(b);
        } else {
          const nb: Band = { first: oi, rows: [[r]], last: [r] };
          next.push(nb);
        }
      }
      for (const b of active) if (!next.includes(b)) done.push(b);
      active = next;
    }
    done.push(...active);
    const minRows = Math.max(2, Math.round(O.minThickness / res));
    const maxRows = Math.round(O.maxThickness / res);
    for (const b of done) {
      const n = b.rows.length;
      if (n < minRows || n > maxRows) continue;
      // 半分以上の行が覆う区間を壁とする（直交する壁との取り合いで1行だけ伸びた所を除く）
      const lo = Math.min(...b.rows.map((rs) => rs[0].a));
      const hi = Math.max(...b.rows.map((rs) => rs[0].b));
      const cover = new Int32Array(hi - lo + 2);
      for (const rs of b.rows) for (const r of rs) for (let t = r.a; t <= r.b; t++) cover[t - lo]++;
      let s = -1;
      for (let t = lo; t <= hi + 1; t++) {
        const ok = t <= hi && cover[t - lo] * 2 >= n;
        if (ok && s < 0) s = t;
        if (!ok && s >= 0) {
          if (t - s >= minRun) pieces.push({ g: gi, o: o0 + (b.first + n / 2) * res, d: n * res, t0: t0 + s * res, t1: t0 + t * res });
          s = -1;
        }
      }
    }
  });
  // 同じ軸上の壁片の間（2.6m 以下）は開口（窓・出入口）
  const byAxis = new Map<string, WallPiece[]>();
  for (const p of pieces) {
    const k = `${p.g}:${Math.round(p.o / 60)}`;
    if (!byAxis.has(k)) byAxis.set(k, []);
    byAxis.get(k)!.push(p);
  }
  for (const ps of byAxis.values()) {
    ps.sort((a, b) => a.t0 - b.t0);
    for (let i = 1; i < ps.length; i++) {
      const gap = ps[i].t0 - ps[i - 1].t1;
      if (gap > 150 && gap <= 2600 && Math.abs(ps[i].o - ps[i - 1].o) < 60)
        openings.push({ g: ps[i].g, o: (ps[i].o + ps[i - 1].o) / 2, d: (ps[i].d + ps[i - 1].d) / 2, t0: ps[i - 1].t1, t1: ps[i].t0, kind: 'open', confidence: 0.4 });
    }
  }
  const peaks = [...new Set(pieces.map((p) => Math.round(p.d / 10) * 10))];
  return { groups, pieces, openings, thicknessPeaks: peaks, heavyThreshold: null, heavyPairedFrac: 1 };
}

/**
 * スキャン画像（グレー）から太い線（壁）だけの2値画像を作る。
 * 2値化してから k 画素の収縮→膨張（オープニング）で、寸法線・家具・文字・手書きなどの細い線を消す。
 */
export function thickStrokeMask(gray: Uint8Array | Uint8ClampedArray, w: number, h: number, k: number, threshold?: number, closeFirst = 0): Uint8Array {
  // しきい値: 指定が無ければ大津法
  let th = threshold;
  if (th == null) {
    const hist = new Float64Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0;
    let wB = 0;
    let best = 0;
    th = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) {
        best = between;
        th = t;
      }
    }
    // 薄い鉛筆の書き込みは壁ではないので、しきい値は暗めに抑える
    th = Math.min(th, 150);
  }
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) bin[i] = gray[i] < th ? 1 : 0;
  // 2本の細線＋網点で描いた壁は、先に線の間を埋めてから細い線を消す
  const src = closeFirst > 0 ? erodeMask(dilateMask(bin, w, h, closeFirst), w, h, closeFirst) : bin;
  return dilateMask(erodeMask(src, w, h, k), w, h, k);
}

/** 2値画像の主な線の向き（度）。投影の鋭さで評価（縮小した点で粗く→細かく） */
export function dominantAnglesFromMask(mask: Uint8Array, w: number, h: number, maxPeaks = 3): number[] {
  const pts: { x: number; y: number }[] = [];
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 400000)));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (mask[y * w + x]) pts.push({ x, y });
  if (pts.length < 50) return [];
  const score = (deg: number) => {
    const th = (deg * Math.PI) / 180;
    const nx = -Math.sin(th);
    const ny = Math.cos(th);
    const bins = new Map<number, number>();
    for (const p of pts) {
      const k = Math.round((p.x * nx + p.y * ny) / (step * 1.5));
      bins.set(k, (bins.get(k) ?? 0) + 1);
    }
    let s = 0;
    for (const v of bins.values()) s += v * v;
    return s;
  };
  const coarse: { d: number; s: number }[] = [];
  for (let d = 0; d < 180; d += 1) coarse.push({ d, s: score(d) });
  const base = coarse.reduce((a, c) => a + c.s, 0) / coarse.length;
  const peaks: number[] = [];
  const sorted = coarse.slice().sort((a, b) => b.s - a.s);
  for (const c of sorted) {
    if (peaks.length >= maxPeaks) break;
    if (c.s < base * 1.6 || c.s < sorted[0].s * 0.35) break;
    if (peaks.some((p) => Math.min(Math.abs(p - c.d), 180 - Math.abs(p - c.d)) < 5)) continue;
    // ±1度を 0.1度刻みで詰める
    let bd = c.d;
    let bs = c.s;
    for (let d = c.d - 1; d <= c.d + 1; d += 0.1) {
      const s = score(d);
      if (s > bs) {
        bs = s;
        bd = d;
      }
    }
    peaks.push(((bd % 180) + 180) % 180);
  }
  return peaks;
}

/**
 * 壁の芯の間隔が 910mm（半間 455mm）の倍数にそろう性質から、縮尺の補正係数を推定する。
 * 文字の読めないスキャン図面で、仮の縮尺 (1/100) に掛ける値を返す（1 = 補正なし）。
 */
export function moduleScaleFactor(det: WallDetection, lo = 0.65, hi = 1.5): { factor: number; confidence: number } {
  const ds: { d: number; w: number }[] = [];
  const byG = new Map<number, WallPiece[]>();
  for (const p of det.pieces) {
    if (!byG.has(p.g)) byG.set(p.g, []);
    byG.get(p.g)!.push(p);
  }
  for (const ps of byG.values()) {
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const d = Math.abs(ps[i].o - ps[j].o);
        if (d < 400 || d > 12000) continue;
        ds.push({ d, w: Math.min(ps[i].t1 - ps[i].t0, ps[j].t1 - ps[j].t0) });
      }
  }
  if (ds.length < 10) return { factor: 1, confidence: 0 };
  const fit = (f: number) => ds.reduce((s, q) => s + q.w * Math.cos((2 * Math.PI * q.d * f) / 455), 0) / ds.reduce((s, q) => s + q.w, 0);
  let best = 1;
  let bs = -Infinity;
  for (let f = lo; f <= hi; f += 0.0025) {
    const s = fit(f);
    if (s > bs) {
      bs = s;
      best = f;
    }
  }
  return { factor: best, confidence: bs };
}

/**
 * 向きを自動で求めて壁を検出する。主な向き（縦横）の壁を取り除いた残りから、斜めの壁など別の向きも探す
 */
export function detectWallsRasterAuto(img: BinaryImage, opts: Partial<RasterWallOptions> = {}): WallDetection | null {
  const ang = dominantAnglesFromMask(img.data, img.w, img.h);
  if (!ang.length) return null;
  const det = detectWallsRaster(img, ang, opts);
  // 検出済みの壁の画素を消した残り
  const rest = img.data.slice();
  const clearPiece = (g: AngleGroup, q: WallPiece, pad: number) => {
    const L = q.t1 - q.t0;
    const n = Math.ceil(L / (img.res * 0.5));
    const hw = q.d / 2 + pad;
    const m = Math.ceil(hw / (img.res * 0.5));
    for (let i = 0; i <= n; i++) {
      const t = q.t0 + (L * i) / n;
      for (let j = -m; j <= m; j++) {
        const o = q.o + (hw * j) / m;
        const x = Math.floor((g.u.x * t + g.n.x * o - img.ox) / img.res);
        const y = Math.floor((g.u.y * t + g.n.y * o - img.oy) / img.res);
        if (x >= 0 && y >= 0 && x < img.w && y < img.h) rest[y * img.w + x] = 0;
      }
    }
  };
  for (const q of det.pieces) clearPiece(det.groups[q.g], q, img.res * 2);
  const ang2 = dominantAnglesFromMask(rest, img.w, img.h, 2).filter((a) => ang.every((b) => Math.min(Math.abs(a - b), 180 - Math.abs(a - b)) > 5));
  if (ang2.length) {
    const det2 = detectWallsRaster({ ...img, data: rest }, ang2, opts);
    const off = det.groups.length;
    det.groups.push(...det2.groups);
    det.pieces.push(...det2.pieces.map((q) => ({ ...q, g: q.g + off })));
    det.openings.push(...det2.openings.map((q) => ({ ...q, g: q.g + off })));
  }
  return det;
}
