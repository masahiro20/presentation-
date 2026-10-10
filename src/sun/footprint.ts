/**
 * 足元リング（東・北 m）の幾何の共有: 中心・符号付き面積・重複点の除去・bbox・重なり判定のサンプル点・被覆率・
 * 「主の建物と重なる副の建物を捨てる」統合（PLATEAU と国土地理院の建物）。
 *
 * 日照ツール（src/sunstudy/neighbors.ts。既存の呼び出しはそこから再 export）とプレゼン側（src/sun/context.ts）の両方から使う。
 * 凸包は src/sun/align.ts の convexHull を使う（ここには置かない）。DOM・three は使わない。
 */
import { pointInPolygon } from '../core/geometry';
import type { EN } from './align';

export type { EN };

/** リングの中心（頂点の平均） */
export function ringCenter(ring: EN[]): EN {
  if (!ring.length) return { e: 0, n: 0 };
  let e = 0;
  let n = 0;
  for (const p of ring) {
    e += p.e;
    n += p.n;
  }
  return { e: e / ring.length, n: n / ring.length };
}

/** 符号付き面積（e/n 座標、反時計回りが正） */
export function ringArea(ring: EN[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.e * b.n - b.e * a.n;
  }
  return s / 2;
}

/** 閉じる重複点と 0.05 m 未満で続く点を取り除く */
export function cleanRing(ring: EN[], minStep = 0.05): EN[] {
  const out: EN[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.e - last.e, p.n - last.n) < minStep) continue;
    out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0].e - out[out.length - 1].e, out[0].n - out[out.length - 1].n) < minStep) out.pop();
  return out;
}

const toXY = (p: EN) => ({ x: p.e, y: p.n });

/** 点がリングの内側か（境界は半開。src/core/geometry.ts の pointInPolygon） */
export function pointInRing(p: EN, ring: EN[]): boolean {
  return pointInPolygon(toXY(p), ring.map(toXY));
}

export interface BBoxEN {
  minE: number;
  maxE: number;
  minN: number;
  maxN: number;
}

export function bboxOf(ring: EN[]): BBoxEN {
  const b = { minE: Infinity, maxE: -Infinity, minN: Infinity, maxN: -Infinity };
  for (const p of ring) {
    if (p.e < b.minE) b.minE = p.e;
    if (p.e > b.maxE) b.maxE = p.e;
    if (p.n < b.minN) b.minN = p.n;
    if (p.n > b.maxN) b.maxN = p.n;
  }
  return b;
}

/** 建物の重なり判定に使うサンプル点: 頂点 + 中心 + 内部の格子点 */
export function samplePoints(ring: EN[], grid = 4): EN[] {
  const pts: EN[] = [...ring, ringCenter(ring)];
  const b = bboxOf(ring);
  for (let i = 0; i < grid; i++)
    for (let j = 0; j < grid; j++) {
      const p = { e: b.minE + ((i + 0.5) / grid) * (b.maxE - b.minE), n: b.minN + ((j + 0.5) / grid) * (b.maxN - b.minN) };
      if (pointInRing(p, ring)) pts.push(p);
    }
  return pts;
}

/** ring のサンプル点のうち、polys のどれかの内側に入る割合 (0..1) */
export function coverageRatio(ring: EN[], polys: { ring: EN[]; bbox: BBoxEN }[]): number {
  const pts = samplePoints(ring);
  if (!pts.length) return 0;
  let inside = 0;
  for (const p of pts) {
    for (const poly of polys) {
      const bb = poly.bbox;
      if (p.e < bb.minE || p.e > bb.maxE || p.n < bb.minN || p.n > bb.maxN) continue;
      if (pointInRing(p, poly.ring)) {
        inside++;
        break;
      }
    }
  }
  return inside / pts.length;
}

/**
 * 主の建物（primary。PLATEAU の実足元）と被覆率 maxOverlap 以上で重なる副の建物（secondary。国土地理院）を捨て、
 * 主に無い建物（新しい建物・LOD0 のみの建物）だけを返す。主が空なら副をそのまま返す
 */
export function fillGapsWith<T extends { ring: EN[] }>(primary: { ring: EN[] }[], secondary: T[], maxOverlap = 0.3): T[] {
  if (!primary.length) return secondary;
  const polys = primary.map((p) => ({ ring: p.ring, bbox: bboxOf(p.ring) }));
  return secondary.filter((g) => coverageRatio(g.ring, polys) < maxOverlap);
}
