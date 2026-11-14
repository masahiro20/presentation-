/**
 * 窓の記号の読み分け（平面図）。
 *
 * ARCHITREND の平面図は、窓の開き方を記号で描き分ける:
 *  - 窓の両端から外へ伸びる 2 本の斜めの線が 1 点で交わる三角 = すべり出し窓（横すべり出し・縦すべり出し。人は出入りしない）
 *  - 三角が無く、ガラスの線が開口の端から端まで通る = FIX（はめ殺し）
 *  - ガラスの線が開口の中ほどで切れて、位置の違う線と重なる = 引違い
 *
 * 高さは平面図に書かれないが、設計の意図は記号に出る（御社のご提案パースと図面の突き合わせ: 大崎様邸）:
 *  すべり出しは高い位置の横長の窓（スリット）、居間・畳コーナーの FIX は床に近い高さからの大きな窓（庭を見る窓）。
 */
import type { Vec2 } from '../core/types';

export type SashMark = 'awning' | 'fix' | 'slide';

/** 線分（図面の座標 mm）。塗りの輪郭（source = 'fill'）と破線は、記号の線として数えない */
export interface MarkSeg {
  a: Vec2;
  b: Vec2;
  dashed?: boolean;
  source?: string;
}

export interface SashMarkResult {
  mark: SashMark;
  /** 三角の頂点のある側（壁の法線の向き +1 / −1）。すべり出しのときだけ */
  side?: 1 | -1;
}

/**
 * 壁の上の開口（壁の始点 a から、向き u に t0〜t1）のそばの線から、窓の記号を読む。
 * @param n 壁の法線（単位ベクトル）
 * @param wallD 壁の厚み (mm)
 */
export function readSashMark(segs: MarkSeg[], a: Vec2, u: Vec2, n: Vec2, t0: number, t1: number, wallD: number): SashMarkResult | null {
  const w = t1 - t0;
  if (w < 300) return null;
  const half = wallD / 2;
  const reach = Math.max(1300, w * 0.9);
  // 三角の辺: 壁の面のそば（開口の端）から外へ伸びる斜めの線。頂点の位置ごとに、どちらの端から来たかを覚える
  const apexes: { s: number; c: number; from: 0 | 1 }[] = [];
  // ガラスの線: 壁の帯の中の、壁に平行な線
  const band: { s0: number; s1: number; c: number }[] = [];
  for (const g of segs) {
    if (g.dashed || g.source === 'fill') continue;
    const ax = g.a.x - a.x;
    const ay = g.a.y - a.y;
    const bx = g.b.x - a.x;
    const by = g.b.y - a.y;
    const sa = ax * u.x + ay * u.y;
    const sb = bx * u.x + by * u.y;
    if (Math.max(sa, sb) < t0 - 150 || Math.min(sa, sb) > t1 + 150) continue;
    const ca = ax * n.x + ay * n.y;
    const cb = bx * n.x + by * n.y;
    if (Math.min(Math.abs(ca), Math.abs(cb)) > half + reach) continue;
    const ds = Math.abs(sb - sa);
    const dc = Math.abs(cb - ca);
    if (dc <= 6 && ds >= 120 && Math.abs(ca) <= half + 12) {
      band.push({ s0: Math.min(sa, sb), s1: Math.max(sa, sb), c: (ca + cb) / 2 });
      continue;
    }
    if (ds < 120 || dc < 90) continue;
    // 壁の側の端（root）と、外の側の端（apex）
    const [rs, rc, ps, pc] = Math.abs(ca) <= Math.abs(cb) ? [sa, ca, sb, cb] : [sb, cb, sa, ca];
    if (Math.abs(rc) > half + 70) continue;
    if (Math.abs(pc) < half + 90 || Math.abs(pc) > half + reach) continue;
    const from: 0 | 1 | null = Math.abs(rs - t0) <= 130 ? 0 : Math.abs(rs - t1) <= 130 ? 1 : null;
    if (from == null) continue;
    if (ps < t0 - 60 || ps > t1 + 60) continue;
    apexes.push({ s: ps, c: pc, from });
  }
  for (const p of apexes) {
    if (p.from !== 0) continue;
    const q = apexes.find((o) => o.from === 1 && Math.abs(o.s - p.s) <= 60 && Math.abs(o.c - p.c) <= 60);
    if (q) return { mark: 'awning', side: p.c > 0 ? 1 : -1 };
  }
  // ガラスの線の並び
  const inOpen = band.filter((l) => Math.min(l.s1, t1) - Math.max(l.s0, t0) >= Math.min(200, w * 0.25));
  if (!inOpen.length) return null;
  const lo = t0 + w * 0.22;
  const hi = t1 - w * 0.22;
  // 開口の中ほどで切れる線（引違いの障子・召し合わせ）
  const broken = inOpen.filter((l) => (l.s0 > lo && l.s0 < hi) || (l.s1 > lo && l.s1 < hi));
  if (broken.length >= 2) {
    // 位置（壁の厚みの向き）の違う 2 本が、中ほどで重なるか、入れ替わる
    const offs = new Set(broken.map((l) => Math.round(l.c / 8)));
    if (offs.size >= 2) return { mark: 'slide' };
  }
  const full = inOpen.filter((l) => Math.min(l.s1, t1) - Math.max(l.s0, t0) >= w * 0.85);
  if (full.length >= 1 && !broken.length) return { mark: 'fix' };
  return null;
}
