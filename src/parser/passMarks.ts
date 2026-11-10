/**
 * 通り口の印（建具の印）
 *
 * ARCHITREND の提案図（プラン図）では、人が通る建具 — 開き戸・引戸・折れ戸・玄関ドア・掃き出し窓（テラス窓）・勝手口 — に
 * 「両端に小さな丸の付いた短い線」が、壁を直角に横切って描かれる（線は 400〜900 mm、丸は直径 25 mm ほど）。
 * 通れない所 — 腰窓・高窓・FIX、それに棚・ハンガーパイプ・浴槽の縁・上がり框・手すりのような「壁に見える細い線」— には付かない。
 *
 * この印を読むと、線だけでは区別できないものが分かる:
 *  - 壁の切れ目に細い線が通っているだけの「引戸」（実は棚・パイプ・框）は、印が無ければ建具ではない
 *  - 外壁の窓に印があれば、床まである出入りできる窓（掃き出し・テラスドア）
 *
 * コーパス 13 件で、開き戸の 98%・玄関ドアの 100% に印があり、印の無い「引戸」52 か所の大半が家具・設備の線だった（2026-11 調べ）。
 */
import type { Vec2 } from '../core/types';
import type { Arc, Seg } from './walls';

export interface PassMark {
  a: Vec2;
  b: Vec2;
  len: number;
}

/** 印の線の長さ（mm） */
const MIN_LEN = 200;
const MAX_LEN = 950;

/**
 * 図面の線から通り口の印を探す。
 * 丸は細かい折れ線（1 辺 2〜13 mm）か小さな曲線で描かれている。線の端の少し先（丸の半径ぶん＋すき間）に、
 * 線の延長上を中心とする直径 14〜46 mm の輪があるものを印とする
 */
export function detectPassMarks(segs: Seg[], arcs: Arc[] = []): PassMark[] {
  const cell = 40;
  const hash = new Map<number, Vec2[]>();
  const key = (cx: number, cy: number) => cx * 100003 + cy;
  const put = (m: Vec2) => {
    const k = key(Math.floor(m.x / cell), Math.floor(m.y / cell));
    const list = hash.get(k);
    if (list) list.push(m);
    else hash.set(k, [m]);
  };
  let tinyCount = 0;
  for (const s of segs) {
    if (s.source !== 'stroke') continue;
    if (Math.abs(s.b.x - s.a.x) > 16 || Math.abs(s.b.y - s.a.y) > 16) continue;
    put({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 });
    tinyCount++;
  }
  // 丸がベジェ曲線で残っている図面: 小さな曲線は途中の点を足す
  for (const a of arcs) {
    if (Math.hypot(a.p3.x - a.p0.x, a.p3.y - a.p0.y) > 40) continue;
    for (const t of [0.15, 0.5, 0.85]) {
      const mt = 1 - t;
      put({
        x: mt ** 3 * a.p0.x + 3 * mt * mt * t * a.p1.x + 3 * mt * t * t * a.p2.x + t ** 3 * a.p3.x,
        y: mt ** 3 * a.p0.y + 3 * mt * mt * t * a.p1.y + 3 * mt * t * t * a.p2.y + t ** 3 * a.p3.y,
      });
      tinyCount++;
    }
  }
  if (tinyCount < 16) return [];
  /** 線の端 p から外向き u の先に丸があるか */
  const circleAt = (p: Vec2, u: Vec2): boolean => {
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    let n = 0;
    let alMin = Infinity;
    let alMax = -Infinity;
    let peMin = Infinity;
    let peMax = -Infinity;
    const pts: { al: number; pe: number }[] = [];
    for (let dx = -2; dx <= 2; dx++)
      for (let dy = -2; dy <= 2; dy++)
        for (const m of hash.get(key(cx + dx, cy + dy)) ?? []) {
          const al = (m.x - p.x) * u.x + (m.y - p.y) * u.y;
          const pe = -(m.x - p.x) * u.y + (m.y - p.y) * u.x;
          if (al < 1 || al > 70 || Math.abs(pe) > 24) continue;
          n++;
          pts.push({ al, pe });
          alMin = Math.min(alMin, al);
          alMax = Math.max(alMax, al);
          peMin = Math.min(peMin, pe);
          peMax = Math.max(peMax, pe);
        }
    if (n < 8) return false;
    const w = alMax - alMin;
    const h = peMax - peMin;
    // 丸の外形: ほぼ正方形で、線の延長上に中心がある
    if (w < 14 || w > 46 || h < 14 || h > 46 || Math.abs(w - h) > 10) return false;
    if (Math.abs((peMin + peMax) / 2) > 7) return false;
    // 線の端から丸までのすき間は丸の直径より小さい
    if (alMin > Math.max(30, w)) return false;
    // 輪になっている（中心から見て 8 方位のうち 6 方位以上に点がある）
    const c = { al: (alMin + alMax) / 2, pe: (peMin + peMax) / 2 };
    const oct = new Set<number>();
    for (const q of pts) oct.add(Math.floor(((Math.atan2(q.pe - c.pe, q.al - c.al) + Math.PI) / (2 * Math.PI)) * 8) % 8);
    return oct.size >= 6;
  };
  const out: PassMark[] = [];
  for (const s of segs) {
    if (s.source !== 'stroke' || s.dashed) continue;
    const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    if (len < MIN_LEN || len > MAX_LEN) continue;
    const u = { x: (s.b.x - s.a.x) / len, y: (s.b.y - s.a.y) / len };
    if (circleAt(s.a, { x: -u.x, y: -u.y }) && circleAt(s.b, u)) out.push({ a: s.a, b: s.b, len });
  }
  // 同じ線が二重に描かれている図面: 重なるものは 1 つにする
  const uniq: PassMark[] = [];
  for (const k of out) {
    if (uniq.some((q) => (Math.hypot(q.a.x - k.a.x, q.a.y - k.a.y) < 15 && Math.hypot(q.b.x - k.b.x, q.b.y - k.b.y) < 15) || (Math.hypot(q.a.x - k.b.x, q.a.y - k.b.y) < 15 && Math.hypot(q.b.x - k.a.x, q.b.y - k.a.y) < 15))) continue;
    uniq.push(k);
  }
  return uniq;
}

/**
 * 壁の上の区間 [t0, t1]（壁の始点 a から b へ向かう距離）を横切る印の数。
 * 印は壁にほぼ直角で、両端が壁芯の反対側にあり（片側だけに描かれた印も壁から 120 mm 以内なら可）、壁に沿った位置が区間に入る
 */
export function marksCrossing(marks: PassMark[], a: Vec2, b: Vec2, t0: number, t1: number, tol = 120): number {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  if (L <= 0) return 0;
  const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  const n = { x: -u.y, y: u.x };
  let count = 0;
  for (const k of marks) {
    const mu = { x: (k.b.x - k.a.x) / k.len, y: (k.b.y - k.a.y) / k.len };
    if (Math.abs(mu.x * u.x + mu.y * u.y) > 0.35) continue;
    const da = (k.a.x - a.x) * n.x + (k.a.y - a.y) * n.y;
    const db = (k.b.x - a.x) * n.x + (k.b.y - a.y) * n.y;
    if (da * db > 0 && Math.min(Math.abs(da), Math.abs(db)) > 120) continue;
    if (Math.max(Math.abs(da), Math.abs(db)) > 900) continue;
    const t = ((k.a.x + k.b.x) / 2 - a.x) * u.x + ((k.a.y + k.b.y) / 2 - a.y) * u.y;
    if (t < t0 - tol || t > t1 + tol) continue;
    count++;
  }
  return count;
}
