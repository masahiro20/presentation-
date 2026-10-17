/**
 * 第 3 ラウンドのレビュー指摘の回帰テスト:
 *  - 敷地の板 + 低い縁の帯（エプロン）は天面を外周にする（段差・土手は従来どおり null）
 *  - 単位違いのときの向き合わせは、正方形に近い板でも今の向きを保つ（0° に飛ばない）
 */
import { describe, expect, it } from 'vitest';
import { PLATE_TOP_FRACTION, fitToSite, plateOutline } from '../src/sunstudy/alignment';
import { PlacedModel, importModelFile } from '../src/sunstudy/importModel';
import { DEFAULT_PLACEMENT } from '../src/sunstudy/types';
import { polygonArea } from '../src/sun/align';

/** 軸に平行な直方体（x0..x1, y0..y1, z0..z1）を三角形の頂点列（9 値/三角形）にする */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number[] {
  const v = (x: number, y: number, z: number) => [x, y, z];
  const q = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
  return [
    ...q(v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1)), // top
    ...q(v(x0, y0, z0), v(x0, y0, z1), v(x1, y0, z1), v(x1, y0, z0)), // bottom
    ...q(v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0)),
    ...q(v(x1, y0, z0), v(x1, y0, z1), v(x1, y1, z1), v(x1, y1, z0)),
    ...q(v(x1, y0, z1), v(x0, y0, z1), v(x0, y1, z1), v(x1, y1, z1)),
    ...q(v(x0, y0, z1), v(x0, y0, z0), v(x0, y1, z0), v(x0, y1, z1)),
  ];
}

describe('plateOutline: 敷地の板 + エプロン', () => {
  it('天面が足跡の 70 % 以上なら、低い帯が外にあっても天面を外周にする', () => {
    // 12 × 10 の板（天面 y = 0）と、南側に 12 × 4 の低い帯（y = −0.15）: 天面 120 / 足跡 168 = 71 %
    const pos = [...box(-6, 6, -0.3, 0, -5, 5), ...box(-6, 6, -0.45, -0.15, 5, 9)];
    const out = plateOutline(pos);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(4);
    expect(Math.abs(polygonArea(out!))).toBeCloseTo(120, 6);
    expect(120 / 168).toBeGreaterThanOrEqual(PLATE_TOP_FRACTION);
  });
  it('段差のある敷地（上段が 70 % 未満）は従来どおり null', () => {
    // 上段 12 × 6（y = 0.5）、下段 12 × 4（y = 0）: 72 / 120 = 60 %
    const pos = [...box(-6, 6, 0.2, 0.5, -5, 1), ...box(-6, 6, -0.3, 0, 1, 5)];
    expect(plateOutline(pos)).toBeNull();
  });
});

describe('fitToSite: 単位違いのときの向き合わせ', () => {
  const obj = (plateMm: number) => `
o house
v -4550 0 -3640
v 4550 0 -3640
v 4550 0 3640
v -4550 0 3640
v -4550 6000 -3640
v 4550 6000 -3640
v 4550 6000 3640
v -4550 6000 3640
f 1 2 3 4
f 8 7 6 5
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 4 8 5 1
o lot
v ${-plateMm / 2} -10 ${-plateMm / 2}
v ${plateMm / 2} -10 ${-plateMm / 2}
v ${plateMm / 2} -10 ${plateMm / 2}
v ${-plateMm / 2} -10 ${plateMm / 2}
v ${-plateMm / 2} 0 ${-plateMm / 2}
v ${plateMm / 2} 0 ${-plateMm / 2}
v ${plateMm / 2} 0 ${plateMm / 2}
v ${-plateMm / 2} 0 ${plateMm / 2}
f 9 10 11 12
f 16 15 14 13
f 9 13 14 10
f 10 14 15 11
f 11 15 16 12
f 12 16 13 9
`;
  async function placedWithUnit(unit: 'mm' | 'm') {
    const model = await importModelFile({ name: 'house_lot.obj', data: new TextEncoder().encode(obj(15000)).buffer as ArrayBuffer });
    const hidden = model.objects.filter((o) => o.autoHidden).map((o) => o.name);
    expect(hidden).toContain('lot');
    return new PlacedModel(model, { ...DEFAULT_PLACEMENT, unit, upAxis: 'y', hiddenObjects: hidden });
  }
  const square = (s: number) => [{ e: 0, n: 0 }, { e: s, n: 0 }, { e: s, n: s }, { e: 0, n: s }];
  it('正方形の板が 1000 倍（単位違い）でも、今の向き（90°／−90°）を保つ（0° に飛ばない）', async () => {
    const placed = await placedWithUnit('m'); // 15000 m の板 → 周長の比 0.001 → unitSuspect
    const r90 = fitToSite(placed, square(15), 90);
    expect(r90).not.toBeNull();
    expect(r90!.unitSuspect).toBe(true);
    expect(r90!.headingDeg).toBeCloseTo(90, 6);
    const rm90 = fitToSite(placed, square(15), -90);
    expect(rm90!.headingDeg).toBeCloseTo(-90, 6);
    const r0 = fitToSite(placed, square(15), 0);
    expect(r0!.headingDeg).toBeCloseTo(0, 6);
  });
  it('単位が正しければ ICP で合い、unitSuspect は立たない', async () => {
    const placed = await placedWithUnit('mm');
    const r = fitToSite(placed, square(15), 0);
    expect(r).not.toBeNull();
    expect(r!.unitSuspect).toBe(false);
    expect(r!.rmsM).toBeLessThan(0.05);
  });
});
