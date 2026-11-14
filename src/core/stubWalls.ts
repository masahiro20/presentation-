/**
 * 壁の中の柱（図面の □ の記号）を、短い壁として読んだもの（長さ 10cm ほど）の後始末。3D の組み立ての前に使う。
 *
 * ARCHITREND の平面図は、壁の中に柱を四角で描く。読み取りはこれを「長さ 105・厚 130 の壁」として拾う（図面 1 枚に数十本）。
 * ほとんどは長い壁の中に隠れるが、建具の無い開口（LDK と玄関ホールの間など）の端に掛かった柱は、壁より 1.4cm 引っ込んだ
 * 細い柱型として開口の中に立ち、壁との段にざらついた影の帯が出ていた。実際の柱は壁の仕上げにくるまれて、壁の面と揃う。
 *  - 開口の端に掛かる柱: 柱のぶんだけ開口を詰めて（＝壁を柱の先まで延ばして）、柱の壁は外す
 *  - 壁の中に隠れる柱: 外す（見えない箱を作らない）
 * 窓・戸の付いた開口は触らない（建具の幅が変わるため）。柱が壁の外へはみ出す場合も触らない
 */
import type { Floor, Opening, Wall } from './types';

/** これより短い壁を「柱の記号」とみなす（mm） */
const STUB_MAX = 220;
/** 詰めたあとの開口の幅の下限（mm）。これより狭くなるなら触らない */
const OPEN_MIN = 600;

interface Hit {
  /** 柱が入っている長い壁 */
  host: Wall;
  /** 長い壁に沿った柱の範囲（host.a からの距離 mm） */
  t0: number;
  t1: number;
}

/** 短い壁 s が、長い壁の厚みの中に収まっているなら、その壁と範囲 */
function hostOf(s: Wall, walls: Wall[]): Hit | null {
  const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  for (const w of walls) {
    if (w === s || w.arc) continue;
    const wl = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (wl < 600) continue;
    const ux = (w.b.x - w.a.x) / wl;
    const uy = (w.b.y - w.a.y) / wl;
    const along = (p: { x: number; y: number }) => (p.x - w.a.x) * ux + (p.y - w.a.y) * uy;
    const off = (p: { x: number; y: number }) => -(p.x - w.a.x) * uy + (p.y - w.a.y) * ux;
    const ta = along(s.a);
    const tb = along(s.b);
    const da = off(s.a);
    const db = off(s.b);
    // 柱の向き: 長い壁に直交（長さが壁の厚みの向き）か、平行か
    const perp = Math.abs(tb - ta) < L * 0.3;
    // 壁の厚みの向きの広がりと、壁に沿った広がり
    const [n0, n1] = perp ? [Math.min(da, db), Math.max(da, db)] : [Math.min(da, db) - s.thickness / 2, Math.max(da, db) + s.thickness / 2];
    const [t0, t1] = perp ? [Math.min(ta, tb) - s.thickness / 2, Math.max(ta, tb) + s.thickness / 2] : [Math.min(ta, tb), Math.max(ta, tb)];
    if (n0 < -w.thickness / 2 - 5 || n1 > w.thickness / 2 + 5) continue;
    if (t0 < -5 || t1 > wl + 5) continue;
    return { host: w, t0, t1 };
  }
  return null;
}

/** 壁の中の柱（短い壁）を外し、開口の端に掛かる柱のぶんは開口を詰める。変える所が無ければ同じ Floor を返す */
export function absorbStubWalls(f: Floor): Floor {
  const withOpening = new Set(f.openings.map((o) => o.wallId));
  const drop = new Set<string>();
  const trim = new Map<string, { t0: number; t1: number }>();
  const cur = (o: Opening) => trim.get(o.id) ?? { t0: o.t0, t1: o.t1 };
  for (const s of f.walls) {
    if (s.arc || s.topMm != null || withOpening.has(s.id)) continue;
    if (Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) >= STUB_MAX) continue;
    const hit = hostOf(s, f.walls);
    // 腰壁・袖壁（高さの指定がある壁）の中の柱は残す: 腰壁から天井まで立つ柱は、実際にある納まり
    if (!hit || hit.host.topMm != null) continue;
    const over = f.openings.filter((o) => o.wallId === hit.host.id && cur(o).t0 < hit.t1 - 1 && cur(o).t1 > hit.t0 + 1);
    if (!over.length) {
      drop.add(s.id);
      continue;
    }
    if (over.length > 1 || over[0].kind !== 'open') continue;
    const o = over[0];
    const c = cur(o);
    // 柱が掛かっている側の端を、柱の先まで詰める（開口の真ん中に立つ柱は触らない）
    const fromStart = hit.t0 <= c.t0 + 1;
    const fromEnd = hit.t1 >= c.t1 - 1;
    if (fromStart === fromEnd) continue;
    const next = fromStart ? { t0: hit.t1, t1: c.t1 } : { t0: c.t0, t1: hit.t0 };
    if (next.t1 - next.t0 < OPEN_MIN) continue;
    trim.set(o.id, next);
    drop.add(s.id);
  }
  if (!drop.size) return f;
  return {
    ...f,
    walls: f.walls.filter((w) => !drop.has(w.id)),
    openings: f.openings.map((o) => (trim.has(o.id) ? { ...o, ...trim.get(o.id)! } : o)),
  };
}
