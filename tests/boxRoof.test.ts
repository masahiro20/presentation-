import { describe, expect, it } from 'vitest';
import { estimateBoxRoof, roofKindFromOsm } from '../src/sunstudy/boxRoof';
import { specMesh, specTop } from '../src/sun/plateau';

const rect = (w: number, d: number) => [
  { e: 0, n: 0 },
  { e: w, n: 0 },
  { e: w, n: d },
  { e: 0, n: d },
];

describe('箱形の周辺建物の推定の屋根（国土地理院・OSM）', () => {
  it('住宅らしい足元（8×10 m・推定 7 m）は寄棟。推定の高さは平均的な高さとみなし、軒はその少し下・棟はその上', () => {
    const r = estimateBoxRoof(rect(8, 10), 7, { heightKind: 'estimated' });
    expect(r?.kind).toBe('hip');
    expect(r!.eave).toBeLessThan(7);
    expect(r!.ridge).toBeGreaterThan(7);
    // 立ち上がり = 短辺の半分 4 m × 0.4 = 1.6 m
    expect(r!.ridge - r!.eave).toBeCloseTo(1.6, 1);
    expect(specTop(r!)).toBe(r!.ridge);
    expect(specMesh(rect(8, 10), r!)?.roofTriangles).toBeGreaterThan(0);
  });
  it('実測の高さ（OSM の height）は棟とみなす', () => {
    const r = estimateBoxRoof(rect(8, 10), 8.2, { heightKind: 'measured' });
    expect(r?.ridge).toBe(8.2);
    expect(r!.eave).toBeCloseTo(8.2 - 1.6, 1);
  });
  it('OSM の roof:shape と building:levels に従う', () => {
    const g = estimateBoxRoof(rect(8, 10), 7, { heightKind: 'estimated', roofShape: 'gabled', levels: 2 });
    expect(g?.kind).toBe('gable');
    expect(g?.storeys).toBe(2);
    expect(roofKindFromOsm('skillion')).toBe('shed');
    expect(roofKindFromOsm('flat')).toBe('flat');
    expect(roofKindFromOsm('onion')).toBeNull();
  });
  it('集合住宅・高い建物・大きい足元は陸屋根（パラペット）。無壁舎・車庫・小さすぎる足元は屋根なし', () => {
    expect(estimateBoxRoof(rect(20, 30), 12, { heightKind: 'estimated', buildingType: 'apartments', levels: 4 })?.kind).toBe('flat');
    expect(estimateBoxRoof(rect(8, 10), 30, { heightKind: 'estimated' })?.kind).toBe('flat');
    expect(estimateBoxRoof(rect(8, 10), 7, { heightKind: 'estimated', label: 'カーポート等（無壁舎）' })).toBeNull();
    expect(estimateBoxRoof(rect(8, 10), 7, { heightKind: 'estimated', buildingType: 'garage' })).toBeNull();
    expect(estimateBoxRoof(rect(2, 2), 3, { heightKind: 'estimated' })).toBeNull();
  });
});
