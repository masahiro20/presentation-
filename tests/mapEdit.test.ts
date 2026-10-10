/**
 * 建設地の地図（src/sunstudy/map.ts）の精密な敷地の描画に使う純粋な関数のテスト:
 *  - 18 より先の拡大: タイルは各レイヤーの配信上限（18）で取り、表示のズームの m/px・スケールバーは小さくなり続ける
 *  - 辺の長さ（edgeLengthsM）と、辺の長さを数値で変えたとき（withEdgeLength）は終点だけが辺の向きに動く
 *  - 寸法で区画を作る（rectangleLot）: 間口 × 奥行・向きの長方形の面積・辺の長さ・方位・中心
 *  - 輪郭の平行移動（translatePolygon）、方位（bearingDeg）
 *  - Shift のスナップ（snapToPrevEdge / snapVertex）: 直前の辺に直角・平行、頂点のドラッグで長方形の角に寄る
 */
import { describe, expect, it } from 'vitest';
import {
  MAP_LAYER_MAX_ZOOM,
  MAX_ZOOM,
  TILE_MAX_ZOOM,
  bearingDeg,
  distanceM,
  edgeLengthsM,
  formatLength,
  metersPerPixel,
  niceScaleBar,
  polygonAreaM2,
  polygonCentroid,
  rectangleLot,
  snapToPrevEdge,
  snapVertex,
  tileZoomFor,
  translatePolygon,
  withEdgeLength,
} from '../src/sunstudy/map';
import { frameFromLocal, frameToLocal } from '../src/sunstudy/types';

const O = { lat: 35.21058, lon: 136.93831 };
const at = (e: number, n: number) => frameFromLocal(O, e, n);
const rect = (w: number, d: number) => [at(0, 0), at(w, 0), at(w, d), at(0, d)];

describe('18 より先の拡大（引き伸ばし）', () => {
  it('最大ズームは 22、タイルは各レイヤーの配信上限 18 まで', () => {
    expect(MAX_ZOOM).toBe(22);
    expect(TILE_MAX_ZOOM).toBe(18);
    for (const l of ['std', 'pale', 'photo'] as const) {
      expect(MAP_LAYER_MAX_ZOOM[l]).toBe(18);
      expect(tileZoomFor(l, 16.7)).toBe(16);
      expect(tileZoomFor(l, 18)).toBe(18);
      expect(tileZoomFor(l, 18.4)).toBe(18);
      expect(tileZoomFor(l, 21.99)).toBe(18);
      expect(tileZoomFor(l, 22)).toBe(18);
      expect(tileZoomFor(l, 99)).toBe(18);
      expect(tileZoomFor(l, 2)).toBe(5);
    }
  });
  it('m/px とスケールバーは表示のズームで小さくなり続ける（z22 で 1 px ≒ 3 cm）', () => {
    const m18 = metersPerPixel(O.lat, 18);
    const m22 = metersPerPixel(O.lat, 22);
    expect(m18 / m22).toBeCloseTo(16, 9);
    expect(m22).toBeLessThan(0.04);
    const s18 = niceScaleBar(m18, 120);
    const s22 = niceScaleBar(m22, 120);
    expect(s22.meters).toBeLessThan(s18.meters);
    expect(s22.px).toBeLessThanOrEqual(120);
    expect(s22.px).toBeGreaterThan(40);
    expect(s22.label).toBe(`${s22.meters}m`);
    // さらに細かい（1 m 未満の）目盛りも選べる
    expect(niceScaleBar(0.004, 120).meters).toBe(0.2);
    expect(niceScaleBar(0.004, 120).label).toBe('0.2m');
  });
});

describe('辺の長さ', () => {
  it('閉じた長方形 12.5 × 18: 辺は 4 本で 12.50 / 18.00 / 12.50 / 18.00 m（1 mm 以内）', () => {
    const lens = edgeLengthsM(rect(12.5, 18));
    expect(lens).toHaveLength(4);
    [12.5, 18, 12.5, 18].forEach((v, i) => expect(Math.abs(lens[i] - v)).toBeLessThan(1e-3));
    expect(formatLength(lens[0])).toBe('12.50m');
  });
  it('閉じていない（描いている途中）は n − 1 本、2 点未満は空', () => {
    expect(edgeLengthsM(rect(10, 5), false)).toHaveLength(3);
    expect(edgeLengthsM([at(0, 0)])).toEqual([]);
    expect(edgeLengthsM([at(0, 0), at(3, 4)], true)).toHaveLength(1);
    expect(edgeLengthsM([at(0, 0), at(3, 4)], true)[0]).toBeCloseTo(5, 6);
  });
  it('辺 i の長さを変えると終点だけが辺の向きに沿って動く（ほかの頂点はそのまま・1 cm 以内）', () => {
    const p = [at(0, 0), at(10, 1), at(9, 12), at(-1, 10)];
    const q = withEdgeLength(p, 1, 15.25)!;
    expect(q).not.toBeNull();
    expect(Math.abs(distanceM(q[1], q[2]) - 15.25)).toBeLessThan(0.01);
    // 向きは同じ
    const d0 = frameToLocal(p[1], p[2]);
    const d1 = frameToLocal(q[1], q[2]);
    expect(Math.abs(Math.atan2(d0.e, d0.n) - Math.atan2(d1.e, d1.n))).toBeLessThan(1e-9);
    for (const k of [0, 1, 3]) expect(q[k]).toEqual(p[k]);
    expect(q[2]).not.toEqual(p[2]);
    // 元の配列は変えない
    expect(p[2]).toEqual(at(9, 12));
  });
  it('最後の辺は最初の頂点を動かす', () => {
    const p = rect(10, 20);
    const q = withEdgeLength(p, 3, 25)!;
    expect(Math.abs(distanceM(q[3], q[0]) - 25)).toBeLessThan(0.01);
    expect(q[1]).toEqual(p[1]);
    expect(q[2]).toEqual(p[2]);
    expect(q[3]).toEqual(p[3]);
  });
  it('不正な値は null', () => {
    const p = rect(10, 20);
    expect(withEdgeLength(p, 0, 0)).toBeNull();
    expect(withEdgeLength(p, 0, -3)).toBeNull();
    expect(withEdgeLength(p, 0, NaN)).toBeNull();
    expect(withEdgeLength(p, 4, 3)).toBeNull();
    expect(withEdgeLength(p, 1.5, 3)).toBeNull();
    expect(withEdgeLength([at(0, 0), at(0, 0), at(1, 1)], 0, 3)).toBeNull();
  });
});

describe('寸法で区画を作る（rectangleLot）', () => {
  it('間口 12.5 × 奥行 18・向き 30°: 面積 225㎡、辺 1 は方位 30°、中心は指定の点', () => {
    const lot = rectangleLot(O, 12.5, 18, 30);
    expect(lot).toHaveLength(4);
    expect(Math.abs(polygonAreaM2(lot) - 225)).toBeLessThan(0.05);
    const lens = edgeLengthsM(lot);
    [12.5, 18, 12.5, 18].forEach((v, i) => expect(Math.abs(lens[i] - v)).toBeLessThan(2e-3));
    expect(bearingDeg(lot[0], lot[1])).toBeCloseTo(30, 3);
    // 角は直角
    const a = frameToLocal(lot[1], lot[0]);
    const b = frameToLocal(lot[1], lot[2]);
    expect(Math.abs(a.e * b.e + a.n * b.n) / (Math.hypot(a.e, a.n) * Math.hypot(b.e, b.n))).toBeLessThan(1e-6);
    const c = polygonCentroid(lot)!;
    expect(distanceM(c, O)).toBeLessThan(1e-3);
  });
  it('向き 90°（東西の間口）は辺 1 が東向き', () => {
    const lot = rectangleLot(O, 10, 15, 90);
    expect(bearingDeg(lot[0], lot[1])).toBeCloseTo(90, 3);
    expect(Math.abs(polygonAreaM2(lot) - 150)).toBeLessThan(0.05);
  });
});

describe('輪郭の平行移動・方位', () => {
  it('translatePolygon: 形を保ったまま東 3 m・北 −2 m', () => {
    const p = [at(0, 0), at(10, 1), at(9, 12)];
    const q = translatePolygon(p, 3, -2);
    for (let i = 0; i < p.length; i++) {
      const d = frameToLocal(p[0], q[i]);
      const d0 = frameToLocal(p[0], p[i]);
      expect(d.e - d0.e).toBeCloseTo(3, 6);
      expect(d.n - d0.n).toBeCloseTo(-2, 6);
    }
    expect(edgeLengthsM(q).map((v) => v.toFixed(4))).toEqual(edgeLengthsM(p).map((v) => v.toFixed(4)));
    expect(translatePolygon([], 1, 1)).toEqual([]);
  });
  it('bearingDeg: 北 0・東 90・南 180・西 270', () => {
    expect(bearingDeg(O, at(0, 10))).toBeCloseTo(0, 6);
    expect(bearingDeg(O, at(10, 0))).toBeCloseTo(90, 6);
    expect(bearingDeg(O, at(0, -10))).toBeCloseTo(180, 6);
    expect(bearingDeg(O, at(-10, 0))).toBeCloseTo(270, 6);
  });
});

describe('Shift のスナップ（画面座標）', () => {
  it('直前の辺に平行（延長）か直角のうち近い方', () => {
    // 直前の辺は右向き (0,0) → (100,0)
    const prev = { x: 0, y: 0 };
    const from = { x: 100, y: 0 };
    expect(snapToPrevEdge(prev, from, { x: 160, y: 12 })).toEqual({ x: 160, y: 0 });
    const q = snapToPrevEdge(prev, from, { x: 108, y: 70 });
    expect(q.x).toBeCloseTo(100, 9);
    expect(q.y).toBeCloseTo(70, 9);
    // 斜めの辺にも
    const r = snapToPrevEdge({ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 30 - 40 + 1, y: 40 + 30 });
    const dot = (r.x - 30) * 30 + (r.y - 40) * 40;
    expect(Math.abs(dot)).toBeLessThan(1e-9);
  });
  it('直前の辺が無ければ東西・南北にそろえる', () => {
    expect(snapToPrevEdge(null, { x: 10, y: 10 }, { x: 60, y: 14 })).toEqual({ x: 60, y: 10 });
    expect(snapToPrevEdge(null, { x: 10, y: 10 }, { x: 13, y: -50 })).toEqual({ x: 10, y: -50 });
  });
  it('頂点のドラッグ: 両隣の辺が直角になる点（長方形の角）がカーソルの近くならそこへ', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 104, y: 47 }, // ずれた角
      { x: 0, y: 50 },
    ];
    const q = snapVertex(pts, 2, true, { x: 104, y: 47 });
    expect(q.x).toBeCloseTo(100, 9);
    expect(q.y).toBeCloseTo(50, 9);
  });
  it('角から遠ければ近い方の直線に下ろす', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ];
    // 頂点 2 を右へ大きく（下の辺 1→2 を直角に保つ直線 x = 100 か、3→2 を延長する直線 y = 50 の近い方）
    const q = snapVertex(pts, 2, true, { x: 180, y: 53 });
    expect(q.y).toBeCloseTo(50, 9);
    expect(q.x).toBeCloseTo(180, 9);
  });
  it('そろえる辺が無ければカーソルのまま（描き始めの 2 点）', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 50, y: 10 },
    ];
    expect(snapVertex(pts, 1, false, { x: 55, y: 12 })).toEqual({ x: 55, y: 12 });
  });
});
