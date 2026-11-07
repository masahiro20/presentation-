import { describe, expect, it } from 'vitest';
import { removeFloor, renumberFloors } from '../src/core/floors';
import type { BuildingModel, Floor } from '../src/core/types';

const floor = (level: number, elevation: number, height = 2900): Floor =>
  ({ level, elevation, height, ceilingHeight: 2400, walls: [], openings: [], rooms: [], stairs: [], outline: [] }) as unknown as Floor;

const model = (): BuildingModel =>
  ({
    name: 't',
    floors: [floor(1, 500, 3200), floor(2, 3700, 2800), floor(4, 6500), floor(6, 9400)],
    roofPatches: [{ id: 'r4', level: 4 }, { id: 'r6', level: 6 }, { id: 'r2', level: 2 }] as unknown as BuildingModel['roofPatches'],
    furniture: [{ level: 2, items: [] }, { level: 4, items: [] }],
    northAngleDeg: 0,
    heights: { source: 'elevation', storyHeights: [3200, 2800, 2900, 2900] },
    report: { pages: 2, scaleDenominator: 100, mmPerPt: 1, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {}, areaTable: { 1: 84.46, 2: 32.29, 4: 10, 6: 12 } },
  }) as unknown as BuildingModel;

describe('階を消す・番号を詰める', () => {
  it('4 階を消すと 6 階が 5 階になり、屋根・家具・面積表も付いてくる', () => {
    const m = model();
    expect(removeFloor(m, 4)).toBe(true);
    expect(m.floors.map((f) => f.level)).toEqual([1, 2, 5]);
    expect(m.roofPatches!.map((p) => `${p.id}:${p.level}`).sort()).toEqual(['r2:2', 'r6:5']);
    expect(m.furniture!.map((f) => f.level)).toEqual([2]);
    expect(m.heights!.storyHeights).toEqual([3200, 2800, 2900]);
    expect(m.report.areaTable).toEqual({ 1: 84.46, 2: 32.29, 5: 12 });
    // 床の高さは下の階から積み直す
    expect(m.floors.find((f) => f.level === 5)!.elevation).toBe(3700 + 2800);
  });

  it('無い階は false', () => {
    const m = model();
    expect(removeFloor(m, 3)).toBe(false);
    expect(m.floors.length).toBe(4);
  });

  it('番号を 1 から詰める', () => {
    const m = model();
    removeFloor(m, 4);
    expect(renumberFloors(m)).toBe(true);
    expect(m.floors.map((f) => f.level)).toEqual([1, 2, 3]);
    expect(m.roofPatches!.find((p) => p.id === 'r6')!.level).toBe(3);
    expect(renumberFloors(m)).toBe(false);
  });

  it('1 階を消すと 2 階が 1 階になる', () => {
    const m = model();
    removeFloor(m, 1);
    expect(m.floors.map((f) => f.level)).toEqual([1, 3, 5]);
    expect(m.floors[0].elevation).toBe(3700);
  });
});
