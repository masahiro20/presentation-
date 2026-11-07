// 重ならない矩形の集まりの輪郭（屋根伏せ図の線）と、多角形の中の点
import { describe, expect, it } from 'vitest';
import { rectsOutline } from '../src/core/rects';
import { interiorPoint, pointInPolygon, polygonArea } from '../src/core/geometry';
import type { Vec2 } from '../src/core/types';

describe('rectsOutline', () => {
  it('1 つの矩形はその 4 隅', () => {
    const loops = rectsOutline([{ minX: 0, minY: 0, maxX: 4000, maxY: 3000 }]);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
    expect(Math.abs(polygonArea(loops[0]))).toBe(12e6);
  });
  it('L 字（2 つの矩形）: 共有する辺が消えて 6 角形になる', () => {
    const loops = rectsOutline([
      { minX: 0, minY: 0, maxX: 4000, maxY: 2000 },
      { minX: 0, minY: 2000, maxX: 2000, maxY: 5000 },
    ]);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(6);
    expect(Math.abs(polygonArea(loops[0]))).toBe(8e6 + 6e6);
    // 共有する辺の途中の点（2000,2000 は角として残る、3000,2000 は辺の上なので残らない）
    expect(loops[0].some((p) => p.x === 2000 && p.y === 2000)).toBe(true);
    expect(loops[0].some((p) => p.x === 3000 && p.y === 2000)).toBe(false);
  });
  it('行ごとに分けた矩形（格子由来）でも 1 つの輪郭にまとまる', () => {
    // 3 行の矩形で作った凸でない形（真ん中の行だけ右に長い）
    const loops = rectsOutline([
      { minX: 0, minY: 0, maxX: 3000, maxY: 1000 },
      { minX: 0, minY: 1000, maxX: 5000, maxY: 2000 },
      { minX: 0, minY: 2000, maxX: 3000, maxY: 3000 },
    ]);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(8);
    expect(Math.abs(polygonArea(loops[0]))).toBe(3e6 + 5e6 + 3e6);
  });
  it('穴のある形（ロの字）は外周と穴の 2 本', () => {
    const loops = rectsOutline([
      { minX: 0, minY: 0, maxX: 6000, maxY: 1000 },
      { minX: 0, minY: 1000, maxX: 1000, maxY: 4000 },
      { minX: 5000, minY: 1000, maxX: 6000, maxY: 4000 },
      { minX: 0, minY: 4000, maxX: 6000, maxY: 5000 },
    ]);
    expect(loops).toHaveLength(2);
    const areas = loops.map((l) => Math.abs(polygonArea(l))).sort((a, b) => a - b);
    expect(areas).toEqual([12e6, 30e6]);
  });
  it('離れた 2 つの矩形は 2 本', () => {
    const loops = rectsOutline([
      { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
      { minX: 3000, minY: 0, maxX: 4000, maxY: 1000 },
    ]);
    expect(loops).toHaveLength(2);
  });
});

describe('interiorPoint', () => {
  it('凸な形は重心', () => {
    const sq: Vec2[] = [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 2000 }, { x: 0, y: 2000 }];
    expect(interiorPoint(sq)).toEqual({ x: 1000, y: 1000 });
  });
  it('L 字・コの字など重心が外に出る形でも中に入る点を返す', () => {
    const L: Vec2[] = [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 1000 }, { x: 1000, y: 1000 }, { x: 1000, y: 4000 }, { x: 0, y: 4000 }];
    const p = interiorPoint(L);
    expect(pointInPolygon(p, L)).toBe(true);
    const U: Vec2[] = [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 }, { x: 5000, y: 3000 }, { x: 5000, y: 1000 }, { x: 1000, y: 1000 }, { x: 1000, y: 3000 }, { x: 0, y: 3000 }];
    const q = interiorPoint(U);
    expect(pointInPolygon(q, U)).toBe(true);
  });
});
