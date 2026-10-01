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
