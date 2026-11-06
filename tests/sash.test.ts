// 窓の標準の幅（半間の割）と、割に合わない窓のチェック・修正
import { describe, expect, it } from 'vitest';
import { isStandardSashWidth, nearestSashWidth, sashWidthLabel, standardSashWidths } from '../src/core/sash';
import { woodCheck } from '../src/parser/woodCheck';
import type { BuildingModel, Opening } from '../src/core/types';

describe('標準のサッシ幅', () => {
  it('柱芯の割から 130 引いた値と、メーカー標準の寸法', () => {
    const list = standardSashWidths();
    for (const w of [405, 640, 730, 780, 1235, 1690, 2600, 3510, 4420]) expect(list).toContain(w);
    expect(isStandardSashWidth(779)).toBe(true);
    expect(isStandardSashWidth(1236)).toBe(true);
    expect(isStandardSashWidth(2532)).toBe(true);
    expect(isStandardSashWidth(2170)).toBe(true); // 2,145（柱芯 2,275）
    expect(isStandardSashWidth(300)).toBe(true); // スリット
    expect(isStandardSashWidth(1086)).toBe(false);
    expect(isStandardSashWidth(2811)).toBe(false);
    expect(nearestSashWidth(1086)).toBe(1235);
    expect(nearestSashWidth(2811)).toBe(2600);
    expect(sashWidthLabel(1235)).toBe('1,235（柱芯 1,365）');
    expect(sashWidthLabel(405)).toBe('405（半間）');
  });
});

describe('woodCheck: 窓の割付', () => {
  const model = (): BuildingModel => {
    const wall = { id: 'w1', a: { x: 0, y: 0 }, b: { x: 9100, y: 0 }, thickness: 120, exterior: true, outsideSign: 1 as const };
    const win = (id: string, t0: number, width: number): Opening => ({ id, wallId: 'w1', kind: 'window', t0, t1: t0 + width, sill: 900, height: 1100 });
    return {
      name: 't',
      floors: [{ level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, walls: [wall], openings: [win('a', 500, 1086), win('b', 3000, 1690), win('c', 6000, 2811)], rooms: [], stairs: [], outline: [] }],
      northAngleDeg: 0,
      report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} },
    };
  };
  it('割に合わない窓を挙げ、標準の幅に直せる（中心はそのまま）', () => {
    const m = model();
    const issue = woodCheck(m).find((i) => i.id === 'sash-1');
    expect(issue).toBeTruthy();
    expect(issue!.title).toContain('2 か所');
    expect(issue!.detail).toContain('W1,086 → 1,235');
    issue!.fix!.apply(m);
    const ops = m.floors[0].openings;
    expect(ops[0].t1 - ops[0].t0).toBe(1235);
    expect((ops[0].t0 + ops[0].t1) / 2).toBeCloseTo(500 + 1086 / 2, 6);
    expect(ops[1].t1 - ops[1].t0).toBe(1690);
    expect(ops[2].t1 - ops[2].t0).toBe(2600);
    expect(woodCheck(m).find((i) => i.id === 'sash-1')).toBeUndefined();
  });
});
