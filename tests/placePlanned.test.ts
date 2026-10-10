/**
 * 建設地のステップの「想定の家」の純粋な補助関数（src/sunstudy/steps/placeStep.ts）のテスト:
 *  - 置く向き（plannedRotationFor）: 敷地の輪郭の主な向きにそろえ、棟は東西寄り。輪郭が無ければ計画の建物と平行、無ければ東西
 *  - 外周の辺か（isOuterEdge）: 凹んだ所の辺には隣の区画を並べない
 *  - 隣の区画に想定の家（neighborLotPlan）: 区画は敷地と同じ形で辺の向こう（重ならない）、家は区画の内側で離れ・建ぺい率を守り、
 *    前面 = クリックした辺に平行で遠い側の辺（区画の辺 i）から 2 m、ほかの辺から 1 m
 *  - 屋根の線（plannedRoofLines）
 */
import { describe, expect, it } from 'vitest';
import { isOuterEdge, neighborLotPlan, plannedRoofLines, plannedRotationFor } from '../src/sunstudy/steps/placeStep';
import { houseFromPreset, plannedFootprint, type EN } from '../src/sun/plannedHouse';
import { distPointSegment, pointInPolygon, polygonArea } from '../src/sun/align';

const rot = (p: EN, deg: number): EN => {
  const r = (deg * Math.PI) / 180;
  return { e: p.e * Math.cos(r) + p.n * Math.sin(r), n: -p.e * Math.sin(r) + p.n * Math.cos(r) };
};
/** 幅 w（東西）× 奥行 d（南北）の長方形を中心 (ce, cn) に、反時計回り。deg だけ時計回りに回す */
const rectLot = (w: number, d: number, deg = 0, ce = 0, cn = 0): EN[] =>
  [
    { e: -w / 2, n: -d / 2 },
    { e: w / 2, n: -d / 2 },
    { e: w / 2, n: d / 2 },
    { e: -w / 2, n: d / 2 },
  ].map((p) => {
    const q = rot(p, deg);
    return { e: q.e + ce, n: q.n + cn };
  });

describe('plannedRotationFor: 想定の家を置く向き', () => {
  it('南北・東西にそろった敷地 → 棟は東西（90°）', () => {
    expect(plannedRotationFor(rectLot(12, 18))).toBeCloseTo(90, 6);
    expect(plannedRotationFor(rectLot(18, 12))).toBeCloseTo(90, 6);
  });
  it('20° 回った敷地 → 110°（棟は敷地の辺に平行で東西寄り）', () => {
    const r = plannedRotationFor(rectLot(12, 18, 20));
    expect(r).toBeCloseTo(110, 4);
  });
  it('60° 回った敷地 → 60°', () => {
    expect(plannedRotationFor(rectLot(12, 18, 60))).toBeCloseTo(60, 4);
  });
  it('輪郭が無ければ計画の建物と平行（headingDeg + 90）、建物も無ければ 90', () => {
    expect(plannedRotationFor(null, 15)).toBeCloseTo(105, 9);
    expect(plannedRotationFor(null, 300)).toBeCloseTo(30, 9);
    expect(plannedRotationFor(null)).toBe(90);
    expect(plannedRotationFor([], null)).toBe(90);
  });
});

describe('isOuterEdge: 外周の辺か', () => {
  const L: EN[] = [
    { e: 0, n: 0 },
    { e: 20, n: 0 },
    { e: 20, n: 10 },
    { e: 10, n: 10 },
    { e: 10, n: 20 },
    { e: 0, n: 20 },
  ];
  it('長方形はどの辺も外周', () => {
    const r = rectLot(12, 18);
    for (let i = 0; i < 4; i++) expect(isOuterEdge(r, i)).toBe(true);
  });
  it('L 字の凹んだ所の辺（2→3, 3→4）は外周でない', () => {
    expect(isOuterEdge(L, 0)).toBe(true);
    expect(isOuterEdge(L, 1)).toBe(true);
    expect(isOuterEdge(L, 2)).toBe(false);
    expect(isOuterEdge(L, 3)).toBe(false);
    expect(isOuterEdge(L, 4)).toBe(true);
    expect(isOuterEdge(L, 5)).toBe(true);
  });
  it('範囲外・壊れた入力は false', () => {
    expect(isOuterEdge(L, 6)).toBe(false);
    expect(isOuterEdge(L, -1)).toBe(false);
    expect(isOuterEdge([{ e: 0, n: 0 }, { e: 1, n: 0 }], 0)).toBe(false);
  });
});

describe('neighborLotPlan: 隣の区画に想定の家', () => {
  const insideAll = (pts: EN[], poly: EN[]) => pts.every((p) => pointInPolygon(p, poly));
  const minDistTo = (pts: EN[], a: EN, b: EN) => Math.min(...pts.map((p) => distPointSegment(p, a, b)));

  for (const deg of [0, 30, -15]) {
    it(`長方形 12 × 18（${deg}° 回転）の各辺: 区画は同じ形で重ならず、家は区画の内側・離れ・建ぺい率を守る`, () => {
      const site = rectLot(12, 18, deg, 3, -2);
      for (let i = 0; i < 4; i++) {
        const r = neighborLotPlan(site, i, 'gable2');
        expect(typeof r).toBe('object');
        if (typeof r !== 'object') continue;
        const { lot, house, frontEdgeIndex } = r;
        expect(frontEdgeIndex).toBe(i);
        // 同じ形・同じ面積
        expect(Math.abs(Math.abs(polygonArea(lot)) - Math.abs(polygonArea(site)))).toBeLessThan(1e-6);
        // 区画は敷地と重ならない（区画の中心は敷地の外、敷地の中心は区画の外）
        const cL = lot.reduce((s, p) => ({ e: s.e + p.e / 4, n: s.n + p.n / 4 }), { e: 0, n: 0 });
        const cS = site.reduce((s, p) => ({ e: s.e + p.e / 4, n: s.n + p.n / 4 }), { e: 0, n: 0 });
        expect(pointInPolygon(cL, site)).toBe(false);
        expect(pointInPolygon(cS, lot)).toBe(false);
        // 区画の向かいの辺（i+2）がクリックした辺 i にぴったり重なる（長方形）
        const a = site[i];
        const b = site[(i + 1) % 4];
        const la = lot[(i + 2) % 4];
        const lb = lot[(i + 3) % 4];
        expect(Math.hypot(la.e - b.e, la.n - b.n)).toBeLessThan(1e-6);
        expect(Math.hypot(lb.e - a.e, lb.n - a.n)).toBeLessThan(1e-6);
        // 家の足元は区画の内側、前面（区画の辺 i）から 2 m 以上、ほかの辺から 1 m 以上
        const fp = plannedFootprint(house);
        expect(insideAll(fp, lot)).toBe(true);
        for (let k = 0; k < 4; k++) {
          const d = minDistTo(fp, lot[k], lot[(k + 1) % 4]);
          expect(d).toBeGreaterThanOrEqual((k === i ? 2 : 1) - 1e-3);
        }
        // 建ぺい率 50% 以内、2 階建て・切妻の高さ
        expect(house.width * house.depth).toBeLessThanOrEqual(0.5 * Math.abs(polygonArea(lot)) + 1e-6);
        expect(house.roof).toBe('gable');
        expect(house.ridgeHeight).toBe(8.5);
      }
    });
  }

  it('凹んだ所の辺は concave、小さすぎる区画は small、壊れた入力は invalid', () => {
    const L: EN[] = [
      { e: 0, n: 0 },
      { e: 20, n: 0 },
      { e: 20, n: 10 },
      { e: 10, n: 10 },
      { e: 10, n: 20 },
      { e: 0, n: 20 },
    ];
    expect(neighborLotPlan(L, 2)).toBe('concave');
    expect(typeof neighborLotPlan(L, 0)).toBe('object');
    expect(neighborLotPlan(rectLot(4, 4), 0)).toBe('small');
    expect(neighborLotPlan(rectLot(12, 18), 7)).toBe('invalid');
    expect(neighborLotPlan([{ e: 0, n: 0 }, { e: 1, n: 1 }, { e: 2, n: 2 }], 0)).toBe('invalid');
  });

  it('アパート（16 × 9）は建ぺい率で縮めて入れる', () => {
    const r = neighborLotPlan(rectLot(12, 18), 1, 'apartment2');
    expect(typeof r).toBe('object');
    if (typeof r !== 'object') return;
    expect(r.house.width * r.house.depth).toBeLessThanOrEqual(0.5 * 12 * 18 + 1e-6);
    expect(r.house.roof).toBe('flat');
  });
});

describe('plannedRoofLines: 地図に描く屋根の線', () => {
  it('切妻は棟 1 本（幅いっぱい・中心を通る）', () => {
    const h = houseFromPreset('gable2', 5, 7, 90);
    const l = plannedRoofLines(h);
    expect(l).toHaveLength(1);
    const [a, b] = l[0];
    expect(Math.hypot(b.e - a.e, b.n - a.n)).toBeCloseTo(h.width, 9);
    expect((a.e + b.e) / 2).toBeCloseTo(5, 9);
    expect((a.n + b.n) / 2).toBeCloseTo(7, 9);
  });
  it('寄棟は棟 + 隅棟 4 本（棟の長さ = 幅 − 奥行）', () => {
    const h = houseFromPreset('hip2', 0, 0, 0);
    const l = plannedRoofLines(h);
    expect(l).toHaveLength(5);
    const [a, b] = l[0];
    expect(Math.hypot(b.e - a.e, b.n - a.n)).toBeCloseTo(h.width - h.depth, 9);
  });
  it('片流れ・陸屋根は線なし', () => {
    expect(plannedRoofLines(houseFromPreset('shed2', 0, 0, 0))).toEqual([]);
    expect(plannedRoofLines(houseFromPreset('flat3', 0, 0, 0))).toEqual([]);
  });
});
