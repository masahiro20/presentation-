import { describe, expect, it } from 'vitest';
import type { Floor, Stair, Wall } from '../src/core/types';
import { floorAlignReport, matchStairs, offsetText, overhangArea, stairAlignOffset, translateFloor, translateRoofPatches, wallAlignOffset, wallFitRatio } from '../src/core/floorAlign';

/** 長方形の外周壁＋間仕切りの階を作る（x0,y0 〜 x1,y1。間仕切りは x = xs の縦壁） */
function box(level: number, x0: number, y0: number, x1: number, y1: number, parts: number[] = [], stairs: Stair[] = []): Floor {
  const mk = (id: string, ax: number, ay: number, bx: number, by: number, exterior = true): Wall => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 120, exterior });
  const walls = [mk(`F${level}-n`, x0, y0, x1, y0), mk(`F${level}-e`, x1, y0, x1, y1), mk(`F${level}-s`, x1, y1, x0, y1), mk(`F${level}-w`, x0, y1, x0, y0), ...parts.map((xs, i) => mk(`F${level}-p${i}`, xs, y0, xs, y1, false))];
  const poly = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  return {
    level,
    elevation: (level - 1) * 3000,
    height: 3000,
    ceilingHeight: 2400,
    walls,
    openings: [],
    rooms: [{ id: `R${level}`, name: '室', type: 'other', polygon: poly, area: ((x1 - x0) * (y1 - y0)) / 1e6, labelPos: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } }],
    stairs,
    outline: [poly],
    posts: [{ id: 'p1', x: x0 + 455, y: y0 + 455, size: 120, kind: 'kuda' }],
  };
}
const st = (id: string, x: number, y: number, goesUp: boolean): Stair => ({ id, minX: x, minY: y, maxX: x + 1820, maxY: y + 1820, kind: 'straight', entry: 's', goesUp });

describe('上下階の位置合わせ（floorAlign）', () => {
  it('translateFloor は壁・部屋・階段・外形・柱をそろって動かす（窓・戸は壁からの距離なのでそのまま）', () => {
    const f = box(2, 0, 0, 7280, 7280, [3640], [st('s', 910, 910, false)]);
    f.openings.push({ id: 'o', wallId: 'F2-n', kind: 'window', t0: 1000, t1: 1690, sill: 900, height: 1100 });
    translateFloor(f, { x: 455, y: -910 });
    expect(f.walls[0].a).toEqual({ x: 455, y: -910 });
    expect(f.rooms[0].polygon[2]).toEqual({ x: 7735, y: 6370 });
    expect(f.rooms[0].labelPos).toEqual({ x: 4095, y: 2730 });
    expect([f.stairs[0].minX, f.stairs[0].minY, f.stairs[0].maxX, f.stairs[0].maxY]).toEqual([1365, 0, 3185, 1820]);
    expect(f.outline[0][0]).toEqual({ x: 455, y: -910 });
    expect(f.posts![0]).toMatchObject({ x: 910, y: -455 });
    expect(f.openings[0]).toMatchObject({ t0: 1000, t1: 1690 });
  });

  it('translateRoofPatches はその階の手直しだけ動かす', () => {
    const patches = [
      { id: 'a', level: 2, at: { x: 100, y: 100 }, rect: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 } },
      { id: 'b', level: 1, at: { x: 100, y: 100 }, loop: [{ x: 0, y: 0 }] },
    ];
    translateRoofPatches(patches, 2, { x: 10, y: 20 });
    expect(patches[0].at).toEqual({ x: 110, y: 120 });
    expect(patches[0].rect).toEqual({ minX: 10, minY: 20, maxX: 1010, maxY: 1020 });
    expect(patches[1].at).toEqual({ x: 100, y: 100 });
  });

  it('階段で合わせる: 1 階の UP と 2 階の DN の中心のずれを返す（別の階段ほど遠い組は選ばない）', () => {
    const f1 = box(1, 0, 0, 9100, 9100, [], [st('s1', 910, 910, true), st('s9', 6000, 6000, true)]);
    const f2 = box(2, 455, 0, 9555, 9100, [], [st('s2', 1365, 910, false)]);
    const m = matchStairs(f1, f2)!;
    expect(m.lower.id).toBe('s1');
    expect(m.upper.id).toBe('s2');
    expect([m.dx, m.dy]).toEqual([455, 0]);
    expect(stairAlignOffset(f1, f2)).toEqual({ x: -455, y: 0 });
    expect(offsetText({ x: 455, y: 0 })).toBe('右 455 mm');
    expect(offsetText({ x: -455, y: -910 })).toBe('左 455 mm・上 910 mm');
  });

  it('はみ出し面積: 455 ずれた 9.1 m 角の 2 階は 455 × 9,100 ≒ 4.1 ㎡ はみ出す', () => {
    const f1 = box(1, 0, 0, 9100, 9100);
    const f2 = box(2, 455, 0, 9555, 9100);
    const a = overhangArea(f1, f2);
    expect(a).toBeGreaterThan(3.6);
    expect(a).toBeLessThan(4.6);
    expect(overhangArea(f1, box(2, 0, 0, 9100, 9100))).toBe(0);
  });

  it('壁で合わせる: 半間ずれた 2 階を元の位置に戻す移動を見つける', () => {
    const f1 = box(1, 0, 0, 9100, 7280, [2730, 5460]);
    const f2 = box(2, 455, 910, 9555, 8190, [3185, 5915]);
    expect(wallFitRatio(f1, f2)).toBeLessThan(0.5);
    const r = wallAlignOffset(f1, f2);
    expect(r.d).toEqual({ x: -455, y: -910 });
    expect(r.after).toBeGreaterThan(0.95);
    expect(r.after).toBeGreaterThan(r.before);
  });

  it('診断のまとめ: 階段・はみ出し・壁の乗り', () => {
    const f1 = box(1, 0, 0, 9100, 9100, [], [st('s1', 910, 910, true)]);
    const f2 = box(2, 0, 0, 9100, 9100, [], [st('s2', 910, 910, false)]);
    const rep = floorAlignReport(f1, f2);
    expect(rep.stair!.iou).toBeCloseTo(1, 5);
    expect(rep.overhangM2).toBe(0);
    expect(rep.wallFit).toBeCloseTo(1, 5);
    expect(rep.upperM2).toBeGreaterThan(80);
  });
});
