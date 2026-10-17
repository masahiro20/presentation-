// 要確認の建物: 冬至の日影で敷地にかかる建物の抽出・順位、高さの確からしさ、「実測で確定」の保存と開示
import { beforeEach, describe, expect, it } from 'vitest';
import { ACCURACY_LABEL, accuracyOf, rankShadowCasters, shadowHull, winterSamples } from '../src/sunstudy/keyNeighbors';
import { setNeighborConfirmed, study, effectiveNeighbors } from '../src/sunstudy/state';
import { sanitizeNeighborOverrides } from '../src/sunstudy/project';
import type { EN, Neighbor } from '../src/sunstudy/types';

const rect = (e0: number, n0: number, w: number, d: number): EN[] => [{ e: e0, n: n0 }, { e: e0 + w, n: n0 }, { e: e0 + w, n: n0 + d }, { e: e0, n: n0 + d }];
const nb = (id: string, ring: EN[], height: number, over: Partial<Neighbor> = {}): Neighbor => ({ id, ring, height, source: 'plateau', heightKind: 'measured', ...over });
const LAT = 35.6;
const LON = 139.67;
const SITE = rect(-5, -5, 10, 10);

describe('winterSamples / shadowHull', () => {
  it('冬至の 8〜16 時は 16 以内のサンプル。高度の低い朝夕を含み南中は最も高い', () => {
    const s = winterSamples(LAT, LON, 2026);
    expect(s.length).toBeGreaterThan(10);
    expect(Math.max(...s.map((x) => x.elevation))).toBeLessThan(35);
  });
  it('影は太陽の反対側にのびる（南中 = 真南の太陽 → 影は北へ）', () => {
    const h = shadowHull(rect(0, 0, 4, 4), 9, 180, 30);
    const maxN = Math.max(...h.map((p) => p.n));
    expect(maxN).toBeCloseTo(4 + 9 / Math.tan(Math.PI / 6), 1);
  });
});

describe('rankShadowCasters', () => {
  it('敷地の南の高い建物は影がかかり、北の建物はかからない。時間の長い順', () => {
    const south = nb('s', rect(-4, -20, 8, 8), 9); // 南 12〜20 m
    const north = nb('n', rect(-4, 15, 8, 8), 9);
    const far = nb('f', rect(-4, -200, 8, 8), 6);
    const r = rankShadowCasters([north, south, far], SITE, LAT, LON, 2026);
    expect(r.map((x) => x.n.id)).toEqual(['s']);
    expect(r[0].hours).toBeGreaterThan(0);
  });
  it('敷地に近く長く影がかかる建物が先。想定の家・計算から除外した建物は対象外', () => {
    const a = nb('a', rect(-4, -26, 8, 8), 9);
    const b = nb('b', rect(-4, -20, 8, 8), 9);
    const planned = nb('p', rect(-4, -14, 8, 8), 12, { planned: { id: 'p' } as never });
    const hidden = nb('h', rect(-4, -14, 8, 8), 12, { hidden: true, hideMode: 'exclude' });
    const r = rankShadowCasters([a, b, planned, hidden], SITE, LAT, LON, 2026);
    expect(r.map((x) => x.n.id)).toEqual(['b', 'a']);
    expect(r[0].hours).toBeGreaterThan(r[1].hours);
  });
  it('敷地の輪郭が無ければ空', () => {
    expect(rankShadowCasters([nb('a', rect(0, -10, 5, 5), 8)], null, LAT, LON, 2026)).toEqual([]);
  });
});

describe('accuracyOf', () => {
  const plateau = (lod: 1 | 2, roofEstimate?: boolean) => ({ source: 'plateau' as const, heightKind: 'measured' as const, plateau: { lod, datasetLod: 2, roofEstimate: roofEstimate ? { kind: 'hip' as const, eave: 5, ridge: 7, boxHeight: 6 } : undefined } as never });
  it('確定 > 手入力 > 種類からの推定 > 推定の屋根 > 箱形 > 実測', () => {
    expect(accuracyOf({ ...plateau(1), confirmed: true })).toBe('confirmed');
    expect(accuracyOf({ source: 'plateau', heightKind: 'manual' })).toBe('manual');
    expect(accuracyOf({ source: 'gsi', heightKind: 'estimated' })).toBe('estimated');
    expect(accuracyOf(plateau(1, true))).toBe('est-roof');
    expect(accuracyOf(plateau(1))).toBe('box');
    expect(accuracyOf(plateau(2))).toBe('measured');
    expect(Object.keys(ACCURACY_LABEL)).toHaveLength(6);
  });
});

describe('実測で確定（setNeighborConfirmed）', () => {
  beforeEach(() => {
    study.neighbors = [nb('plateau:x', rect(0, 0, 5, 5), 8), nb('manual-1', rect(10, 0, 5, 5), 7, { source: 'manual', heightKind: 'manual' })];
    study.neighborOverrides = {};
  });
  it('自動取得は上書き、手動の隣家は本体に印が付き、effectiveNeighbors に出る。外すと消える', () => {
    expect(setNeighborConfirmed('plateau:x', true)).toBe(true);
    expect(study.neighborOverrides['plateau:x']).toEqual({ confirmed: true });
    expect(setNeighborConfirmed('manual-1', true)).toBe(true);
    expect(effectiveNeighbors().map((n) => !!n.confirmed)).toEqual([true, true]);
    setNeighborConfirmed('plateau:x', false);
    expect(study.neighborOverrides['plateau:x']).toBeUndefined();
    expect(setNeighborConfirmed('nope', true)).toBe(false);
  });
  it('保存データの検査: confirmed は true のときだけ残る', () => {
    expect(sanitizeNeighborOverrides({ a: { height: 8, confirmed: true }, b: { confirmed: 'yes' }, c: { confirmed: false, height: 5 } })).toEqual({ a: { height: 8, confirmed: true }, c: { height: 5 } });
  });
});
