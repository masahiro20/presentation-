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
  /** スキャン図面: 太い実線だけの画像（data と同じ大きさ。窓の細い 2 本線は data では帯になり、こちらでは消えている） */
  solid?: Uint8Array;
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
  openings.push(...gapOpenings(pieces));
  const peaks = [...new Set(pieces.map((p) => Math.round(p.d / 10) * 10))];
  return { groups, pieces, openings, thicknessPeaks: peaks, heavyThreshold: null, heavyPairedFrac: 1 };
}

/** 同じ軸上の壁片の間（2.6m 以下）は開口（窓・出入口） */
function gapOpenings(pieces: WallPiece[]): DetectedOpening[] {
  const openings: DetectedOpening[] = [];
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
  return openings;
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

/**
 * 2値画像の主な線の向き（度）。投影の鋭さで評価（縮小した点で粗く→細かく）
 * @param exclude すでに拾った向き。その ±5° は候補から外し、残りの向きの中で山を探す
 *   （縦横の壁を消した残りから斜めの棟を探すとき。消し残った図面の枠線などの長い縦横の線が
 *    いちばん強い山になり、斜めの棟の山が「いちばん強い山の 35% 未満」として捨てられていた = 寺川様邸の 30° 振れた LDK の棟）
 */
export function dominantAnglesFromMask(mask: Uint8Array, w: number, h: number, maxPeaks = 3, exclude: number[] = []): number[] {
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
  const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 180 - Math.abs(a - b));
  const coarse: { d: number; s: number }[] = [];
  for (let d = 0; d < 180; d += 1) if (exclude.every((e) => apart(e, d) > 5)) coarse.push({ d, s: score(d) });
  if (!coarse.length) return [];
  // 基準: ふつうは全部の向きの平均。向きを外して探すときは中央値（外した向きのすそ野に引っぱられない）
  const base = exclude.length ? coarse.map((c) => c.s).sort((a, b) => a - b)[coarse.length >> 1] : coarse.reduce((a, c) => a + c.s, 0) / coarse.length;
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
 * 縦横の壁を消した残りの画像から、斜めに振れた棟の壁の向き（度）を探す。
 *
 * 評価は「その向きに、切れずに長く続く画素の総量」。残りの画像には文字・樹木・家具の点がたくさん残るが、
 * どの向きにも長くは続かないので数に入らない（点の並びの鋭さで見る dominantAnglesFromMask は、この点に埋もれて
 * 30° 振れた棟を見つけられなかった = 寺川様邸の LDK の棟。山の高さが平らな所の 1.4 倍しか無い）。
 * 半分の解像度で 1° 刻みに粗く探し、山の ±1.5° を、その向きに長く続く画素だけの並びの鋭さで 0.1° まで詰める。
 *
 * @param exclude すでに拾った向き（±5° は探さない）
 * @param res 1 画素の大きさ (mm)
 * @returns 強い順に最大 2 つ（直交する組）。斜めの壁が合わせて約 8m に満たないときは空
 */
export function obliqueAnglesFromMask(mask: Uint8Array, w: number, h: number, exclude: number[], res: number): number[] {
  // 半分の解像度（2×2 のどれかが黒なら黒）
  const W = w >> 1;
  const H = h >> 1;
  if (W < 40 || H < 40) return [];
  const half = new Uint8Array(W * H);
  let any = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = 2 * y * w + 2 * x;
      if (mask[i] | mask[i + 1] | mask[i + w] | mask[i + w + 1]) {
        half[y * W + x] = 1;
        any++;
      }
    }
  if (any < 200) return [];
  const r2 = res * 2;
  // 「長く続く」= 1.2m 以上（戸袋・家具・文字の列より長い）
  const minRun = Math.max(12, Math.round(1200 / r2));
  const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 180 - Math.abs(a - b));
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.ceil(Math.hypot(W, H) / 2);
  /** その向きに minRun 以上続く画素を数える。each を渡すと、その画素ごとに呼ぶ（半分の解像度の座標） */
  const runScore = (deg: number, each?: (x: number, y: number) => void): number => {
    const th = (deg * Math.PI) / 180;
    const ux = Math.cos(th);
    const uy = Math.sin(th);
    let total = 0;
    for (let o = -R; o <= R; o++) {
      // 行の始点（中心から法線方向に o、向きに -R）
      let x = cx - uy * o - ux * R;
      let y = cy + ux * o - uy * R;
      let run = 0;
      let gap = 0;
      for (let t = -R; t <= R + 1; t++, x += ux, y += uy) {
        const xi = x | 0;
        const yi = y | 0;
        const v = t <= R && x >= 0 && y >= 0 && xi < W && yi < H ? half[yi * W + xi] : 0;
        if (v) {
          run += 1 + gap;
          gap = 0;
        } else if (run) {
          if (++gap > 1 || t > R) {
            if (run >= minRun) {
              total += run;
              if (each) for (let k = 0; k < run; k++) each(x - ux * (gap + k), y - uy * (gap + k));
            }
            run = 0;
            gap = 0;
          }
        }
      }
    }
    return total;
  };
  // すでに拾った向き（縦横）に長く続く線は、太さによらず先に消す。壁として拾われなかった図面の枠線・太い縁取りが残っていると、
  // 太い線は少し傾けても長く続くので、「ほぼ縦（85°・95°）」が斜めの棟として拾われる
  for (const e of exclude) {
    const hit: number[] = [];
    runScore(e, (x, y) => hit.push((y | 0) * W + (x | 0)));
    for (const i of hit) {
      const x = i % W;
      const y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H) half[(y + dy) * W + x + dx] = 0;
    }
  }
  const coarse: { d: number; s: number }[] = [];
  for (let d = 0; d < 180; d++) if (exclude.every((e) => apart(e, d) > 5)) coarse.push({ d, s: runScore(d) });
  if (!coarse.length) return [];
  const sorted = coarse.slice().sort((a, b) => b.s - a.s);
  const median = coarse.map((c) => c.s).sort((a, b) => a - b)[coarse.length >> 1];
  // 壁 1 本は太さのぶん数行に写る。厚 120mm の壁が合わせて 8m ぶん
  const need = (8000 / r2) * Math.max(2, 120 / r2);
  /** 山の近くを、その向きに長く続く画素だけの並びの鋭さで詰める */
  const refine = (d0: number): number => {
    const pts: { x: number; y: number }[] = [];
    let n = 0;
    runScore(d0, (x, y) => {
      if (n++ % 2 === 0) pts.push({ x, y });
    });
    if (pts.length < 30) return d0;
    let bd = d0;
    let bs = -1;
    for (let d = d0 - 1.5; d <= d0 + 1.5001; d += 0.1) {
      const th = (d * Math.PI) / 180;
      const nx = -Math.sin(th);
      const ny = Math.cos(th);
      const bins = new Map<number, number>();
      for (const p of pts) {
        const k = Math.round(p.x * nx + p.y * ny);
        bins.set(k, (bins.get(k) ?? 0) + 1);
      }
      let sc = 0;
      for (const v of bins.values()) sc += v * v;
      if (sc > bs) {
        bs = sc;
        bd = d;
      }
    }
    return ((bd % 180) + 180) % 180;
  };
  const strong = (c: { s: number }) => c.s >= need && c.s >= median * 3 + need * 0.5;
  if (!strong(sorted[0])) return [];
  const a1 = refine(sorted[0].d);
  const out = [a1];
  // 棟は四角いので、2 つ目はまず直交する向き（±2° の中でいちばん強い所）。
  // 太い線は少し傾けても長く続くので、1 つ目の山のすそ（±10° ほど）は別の向きとして数えない
  const perp = coarse.filter((c) => apart(c.d, a1 + 90) <= 2).sort((a, b) => b.s - a.s)[0];
  if (perp && perp.s >= need * 0.4) out.push(refine(perp.d));
  else {
    const c2 = sorted.find((c) => apart(c.d, a1) >= 15 && strong(c));
    if (c2) out.push(refine(c2.d));
  }
  return out;
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
 * 太い実線で壁を描いたスキャン図面: 壁の帯のうち、実線の無い区間（細い 2 本線だけ = 窓・ガラス戸・引戸）を開口にする。
 *
 * 壁の帯は「細い線の間を埋めた画像」から拾うので、窓の 2 本線も壁と同じ帯になり、窓の無い家に読めていた
 * （寺川様邸: LDK のデッキ側の全面のガラス戸が、切れ目のない壁になっていた）。
 * 太い実線だけを残した画像（img.solid）と突き合わせ、帯の中で実線が途切れる 35cm 以上の区間を開口として切り出す。
 * 壁を細い 2 本線で描く図面（実線の画像に壁がほとんど残らない）では何もしない。
 */
export function splitPiecesBySolid(det: WallDetection, img: BinaryImage): void {
  const solid = img.solid;
  if (!solid || !det.pieces.length || (globalThis as { __NO_SCAN_SOLID?: boolean }).__NO_SCAN_SOLID) return;
  const step = img.res * 0.5;
  type Run = { t0: number; t1: number; solid: boolean };
  const runsOf = (q: WallPiece): Run[] => {
    const g = det.groups[q.g];
    const n = Math.max(1, Math.round((q.t1 - q.t0) / step));
    const m = Math.max(1, Math.ceil(q.d / 2 / step));
    const flags: boolean[] = [];
    for (let i = 0; i <= n; i++) {
      const t = q.t0 + ((q.t1 - q.t0) * i) / n;
      let hit = 0;
      for (let j = -m; j <= m; j++) {
        const o = q.o + j * step;
        const x = Math.floor((g.u.x * t + g.n.x * o - img.ox) / img.res);
        const y = Math.floor((g.u.y * t + g.n.y * o - img.oy) / img.res);
        if (x >= 0 && y >= 0 && x < img.w && y < img.h && solid[y * img.w + x]) hit++;
      }
      flags.push(hit >= (2 * m + 1) * 0.35);
    }
    const runs: Run[] = [];
    let s = 0;
    for (let i = 1; i <= flags.length; i++) {
      if (i === flags.length || flags[i] !== flags[s]) {
        runs.push({ t0: q.t0 + ((q.t1 - q.t0) * s) / (n + 1), t1: q.t0 + ((q.t1 - q.t0) * i) / (n + 1), solid: flags[s] });
        s = i;
      }
    }
    // 短い途切れ（線のかすれ）は壁、窓の中の短い実線（方立）は窓にならす
    const merge = (isSolid: boolean, maxLen: number) => {
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i];
        if (r.solid !== isSolid || r.t1 - r.t0 >= maxLen) continue;
        // 両側（端なら片側）が反対の種類のときだけ
        if (i > 0 && i < runs.length - 1) r.solid = !isSolid;
      }
      for (let i = runs.length - 1; i > 0; i--)
        if (runs[i].solid === runs[i - 1].solid) {
          runs[i - 1].t1 = runs[i].t1;
          runs.splice(i, 1);
        }
    };
    merge(false, 350);
    merge(true, 220);
    return runs;
  };
  const all = det.pieces.map((q) => ({ q, runs: runsOf(q) }));
  const total = all.reduce((a, r) => a + (r.q.t1 - r.q.t0), 0);
  const solidLen = all.reduce((a, r) => a + r.runs.filter((x) => x.solid).reduce((b, x) => b + (x.t1 - x.t0), 0), 0);
  (globalThis as { __scanTrace?: string[] }).__scanTrace?.push(`壁の帯 ${Math.round(total)}mm のうち実線 ${Math.round(solidLen)}mm`);
  // 壁を細い 2 本線で描く図面: 実線の画像に壁が残らない（残るのは柱の黒塗りくらい）ので、帯のままにする。
  // 帯の合計には図面の枠・表の罫線・文字も入るので、割合は低めに見る（寺川様邸: 帯 320m のうち実線 131m）
  if (solidLen < 20000 || solidLen < total * 0.25) return;
  const pieces: WallPiece[] = [];
  const drawn: DetectedOpening[] = [];
  for (const { q, runs } of all) {
    // 帯のほとんどが実線でない（全面が細い線）: 壁の帯としては残さず、両隣の壁の間の開口にもしない（造作・デッキの縁など）
    if (!runs.some((r) => r.solid)) continue;
    runs.forEach((r, i) => {
      if (r.solid) pieces.push({ ...q, t0: r.t0, t1: r.t1 });
      // 開口は、両側に実線の壁がある区間だけ（帯の端の細い線は、壁の続きではなく描き込み）
      else if (i > 0 && i < runs.length - 1 && r.t1 - r.t0 <= 9000) drawn.push({ g: q.g, o: q.o, d: q.d, t0: r.t0, t1: r.t1, kind: 'open', confidence: 0.5 });
    });
  }
  const gaps = gapOpenings(pieces).filter((o) => !drawn.some((e) => e.g === o.g && Math.abs(e.o - o.o) < 60 && Math.min(e.t1, o.t1) - Math.max(e.t0, o.t0) > 0.5 * Math.min(e.t1 - e.t0, o.t1 - o.t0)));
  det.pieces = pieces;
  det.openings = [...drawn, ...gaps];
}

/**
 * 向きを自動で求めて壁を検出する。主な向き（縦横）の壁を取り除いた残りから、斜めの壁など別の向きも探す
 */
export function detectWallsRasterAuto(img: BinaryImage, opts: Partial<RasterWallOptions> = {}): WallDetection | null {
  const found = dominantAnglesFromMask(img.data, img.w, img.h);
  if (!found.length) return null;
  // 主な向きは、いちばん強い向きとその直交（建物の縦横）。ほかの向き（振れた棟）は、下で「その向きに長く続く線」から探す。
  // 点の並びの鋭さで拾った 3 つ目の向きは、角度が 1° ほどずれ、角の塊や文字も短い壁として拾う
  const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 180 - Math.abs(a - b));
  const ang = [found[0], found.find((a) => Math.abs(apart(a, found[0]) - 90) < 3) ?? (found[0] + 90) % 180];
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
  const ang2 = (globalThis as { __NO_SCAN_OBLIQUE?: boolean }).__NO_SCAN_OBLIQUE ? [] : obliqueAnglesFromMask(rest, img.w, img.h, ang, img.res);
  if (ang2.length) {
    // 斜めの壁は、元の画像から拾う。縦横の壁を消した残りから拾うと、斜めの壁の角・交点の塊が「短い縦横の壁」として
    // 先に消されていて、斜めの壁が角の手前で途切れる（棟が閉じない）。縦横の壁は、斜めに見ると壁の厚みぶんしか続かないので
    // 斜めの帯としては拾われない。
    // 斜めの向きでは、文字や記号の塊も短い帯に見える（室名の太い字が 45cm の「壁」になる）。斜めの壁は 0.9m 以上だけ拾う
    const det2 = detectWallsRaster(img, ang2, { ...opts, minLength: Math.max(opts.minLength ?? 0, 900) });
    // 斜めの壁の帯の中に収まる短い縦横の壁片（角・交点の塊）は捨てる
    const inOblique = (x: number, y: number) =>
      det2.pieces.some((q) => {
        const gq = det2.groups[q.g];
        const t = x * gq.u.x + y * gq.u.y;
        const o = x * gq.n.x + y * gq.n.y;
        return t >= q.t0 - img.res * 2 && t <= q.t1 + img.res * 2 && Math.abs(o - q.o) <= q.d / 2 + img.res * 1.5;
      });
    const keep = det.pieces.filter((q) => {
      const L = q.t1 - q.t0;
      if (L > 1500) return true;
      const gq = det.groups[q.g];
      let hit = 0;
      const n = Math.max(4, Math.round(L / img.res));
      for (let i = 0; i <= n; i++) {
        const t = q.t0 + (L * i) / n;
        if (inOblique(gq.u.x * t + gq.n.x * q.o, gq.u.y * t + gq.n.y * q.o)) hit++;
      }
      return hit < (n + 1) * 0.7;
    });
    const off = det.groups.length;
    det.groups.push(...det2.groups);
    det.pieces = [...keep, ...det2.pieces.map((q) => ({ ...q, g: q.g + off }))];
    det.openings = gapOpenings(det.pieces);
  }
  splitPiecesBySolid(det, img);
  return det;
}
