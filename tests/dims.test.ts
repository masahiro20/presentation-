import { describe, expect, it } from 'vitest';
import { furnitureGaps, furnitureLocalToPlan, openingGaps, rayToPolygon } from '../src/core/dims';

const room = [
  { x: 0, y: 0 },
  { x: 4550, y: 0 },
  { x: 4550, y: 3640 },
  { x: 0, y: 3640 },
];

describe('寸法の計算（dims）', () => {
  it('rayToPolygon: 点から向きに進んで最初に当たる辺までの距離', () => {
    expect(rayToPolygon({ x: 1000, y: 1000 }, { x: 1, y: 0 }, room)).toBeCloseTo(3550, 6);
    expect(rayToPolygon({ x: 1000, y: 1000 }, { x: 0, y: -1 }, room)).toBeCloseTo(1000, 6);
    expect(rayToPolygon({ x: 1000, y: 1000 }, { x: 0, y: 1 }, room)).toBeCloseTo(2640, 6);
    // 多角形の外から外向きは当たらない
    expect(rayToPolygon({ x: -100, y: 1000 }, { x: -1, y: 0 }, room)).toBeNull();
  });

  it('壁ぎわのソファ（北の壁に背、rot 0 = 部屋側が +y）: 背面は壁に付き、正面・左右は部屋の壁まで', () => {
    // 幅 2.1 奥行 0.9、中心は北の壁の芯から 65 mm（壁厚 120 の半分 + 5）
    const pos = { x: 2275, y: 65, rot: 0 };
    const dims = { w: 2.1, d: 0.9, v0: 0 };
    expect(furnitureLocalToPlan(pos, 0, 0)).toEqual({ x: 2275, y: 65 });
    const g = furnitureGaps(pos, dims, room, 60);
    expect(g.back).toBe(5);
    expect(g.front).toBe(3640 - 65 - 900 - 60);
    expect(g.sideA).toBe(2275 - 1050 - 60);
    expect(g.sideB).toBe(4550 - 2275 - 1050 - 60);
  });

  it('回した家具（西の壁に背 = rot −90、部屋側が +x）でも向きに沿って測る', () => {
    const pos = { x: 65, y: 1500, rot: -90 };
    const dims = { w: 1.8, d: 0.6, v0: 0 };
    const g = furnitureGaps(pos, dims, room, 60);
    expect(g.back).toBe(5);
    expect(g.front).toBe(4550 - 65 - 600 - 60);
    // rot −90: u = (0, −1)（図面の上向き）。−u 側は図面の下（y = 3,640 の壁）、+u 側は図面の上（y = 0 の壁）
    expect(g.sideA).toBe(3640 - 1500 - 900 - 60);
    expect(g.sideB).toBe(1500 - 900 - 60);
  });

  it('窓・戸の両側の空き: 隣の窓・戸か壁の端まで', () => {
    const op = { id: 'a', wallId: 'w', t0: 1000, t1: 1690 };
    const g0 = openingGaps(op, 5460, []);
    expect(g0).toEqual({ lo: 0, hi: 5460, left: 1000, right: 3770 });
    const g1 = openingGaps(op, 5460, [{ id: 'b', wallId: 'w', t0: 2500, t1: 3300 }, { id: 'c', wallId: 'w', t0: 100, t1: 600 }, { id: 'x', wallId: 'other', t0: 1200, t1: 1300 }]);
    expect(g1).toEqual({ lo: 600, hi: 2500, left: 400, right: 810 });
  });
});
