import { describe, expect, it } from 'vitest';
import { estimateGsiHeight, HEIGHT_ESTIMATE, ringArea } from '../src/sun/heightEstimate';

describe('実測の無い建物の高さの推定（名古屋市 6 区 2,607 棟の実測との突き合わせから）', () => {
  it('普通建物: 母屋の大きさ（40 ㎡以上）は 6.8 m、30 ㎡未満の小さな建物は平屋の高さ', () => {
    expect(estimateGsiHeight(1, 85)).toBe(6.8);
    expect(estimateGsiHeight(1, 40)).toBe(6.8);
    expect(estimateGsiHeight(1, 35)).toBe(5.5);
    expect(estimateGsiHeight(1, 18)).toBe(3.5);
  });
  it('堅ろう建物: 150 ㎡未満は 10 m、それ以上は 12.5 m。高層は 30 m', () => {
    expect(estimateGsiHeight(2, 90)).toBe(10);
    expect(estimateGsiHeight(2, 400)).toBe(12.5);
    expect(estimateGsiHeight(3, 400)).toBe(HEIGHT_ESTIMATE.highrise);
  });
  it('足元の面積は、輪郭の向き（時計回り・反時計回り）によらない', () => {
    const r = [{ e: 0, n: 0 }, { e: 10, n: 0 }, { e: 10, n: 8 }, { e: 0, n: 8 }];
    expect(ringArea(r)).toBe(80);
    expect(ringArea([...r].reverse())).toBe(80);
  });
});

import { basisOf, basisSummary } from '../src/sun/keyNeighbors';

describe('高さの出どころの 4 区分', () => {
  const plateau = { lod: 2, datasetLod: 2 } as never;
  it('PLATEAU は実測、OSM の階数つきは「階数の情報あり」、種別からは推定、手で直した・確定は現地確認済み', () => {
    expect(basisOf({ source: 'plateau', heightKind: 'measured', plateau })).toBe('measured');
    expect(basisOf({ source: 'osm', heightKind: 'measured' })).toBe('levels');
    expect(basisOf({ source: 'gsi', heightKind: 'estimated' })).toBe('estimated');
    expect(basisOf({ source: 'gsi', heightKind: 'manual' })).toBe('verified');
    expect(basisOf({ source: 'gsi', heightKind: 'estimated', confirmed: true })).toBe('verified');
  });
  it('内訳の一文: 0 棟の区分は書かない', () => {
    const list = [{ source: 'plateau', heightKind: 'measured' as const, plateau }, { source: 'plateau', heightKind: 'measured' as const, plateau }, { source: 'gsi', heightKind: 'estimated' as const }, { source: 'gsi', heightKind: 'estimated' as const }, { source: 'gsi', heightKind: 'estimated' as const }];
    expect(basisSummary(list)).toBe('影を落とす建物 5 棟のうち、実測 2 棟・推定 3 棟');
    expect(basisSummary([])).toBe('');
  });
});
