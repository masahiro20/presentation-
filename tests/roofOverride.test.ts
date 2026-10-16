// 利用者が直した屋根（NeighborOverride.roof）: 適用・保存の検査・setNeighborRoof・effectiveNeighbors
import { beforeEach, describe, expect, it } from 'vitest';
import { applyUserRoof, sanitizeUserRoof } from '../src/sunstudy/roofOverride';
import { initialRoofSpec } from '../src/app/roofEditor';
import { effectiveNeighbors, setNeighborRoof, study } from '../src/sunstudy/state';
import { sanitizeNeighborOverrides } from '../src/sunstudy/project';
import type { EN, Neighbor } from '../src/sunstudy/types';

const FRAME = { lat: 35.6, lon: 139.67, address: 'テスト', groundElev: 10 };
const rect = (e0: number, n0: number, w: number, d: number): EN[] => [{ e: e0, n: n0 }, { e: e0 + w, n: n0 }, { e: e0 + w, n: n0 + d }, { e: e0, n: n0 + d }];
const plateauNb = (id = 'plateau:b1'): Neighbor => ({
  id,
  ring: rect(10, 5, 10, 7),
  height: 6.8,
  source: 'plateau',
  heightKind: 'measured',
  mesh: { tris: new Float32Array(9), roofTriangles: 0 },
  plateau: { gmlId: 'b1', lod: 1, datasetLod: 2, year: 2025, muniCd: '13112', pref: '東京都', city: '世田谷区', ward: null, anchor: { lat: FRAME.lat, lon: FRAME.lon }, zmin: 30, zmax: 36.8, measuredHeight: 7.8, storeys: 2, usage: '住宅', footprint: 'bottom' },
});

beforeEach(() => {
  study.frame = { ...FRAME };
  study.neighbors = [plateauNb()];
  study.neighborOverrides = {};
});

describe('applyUserRoof', () => {
  it('仕様どおりの mesh・高さ（= 最高点）・属性（user・zmax）にする。足元の輪郭は変えない。同じ入力は同じオブジェクト', () => {
    const n = plateauNb();
    const spec = { kind: 'gable' as const, eave: 5.6, ridge: 7.9, boxHeight: 6.8, storeys: 2, floorH: 2.8 };
    const a = applyUserRoof(n, spec, FRAME);
    expect(a.height).toBe(7.9);
    expect(a.heightKind).toBe('manual');
    expect(a.plateau?.roofEstimate).toMatchObject({ kind: 'gable', eave: 5.6, ridge: 7.9, user: true });
    expect(a.plateau?.zmax).toBeCloseTo(37.9, 6);
    expect(a.ring).toBe(n.ring);
    expect(a.mesh!.tris.length).toBeGreaterThan(9);
    expect(applyUserRoof(n, spec, FRAME)).toBe(a);
  });
  it('陸屋根（パラペット）は最高点 = 屋上面 + パラペット', () => {
    const a = applyUserRoof(plateauNb(), { kind: 'flat', eave: 9, ridge: 9.8, boxHeight: 9 }, FRAME);
    expect(a.height).toBeCloseTo(9.8, 6);
    expect(a.plateau?.roofEstimate?.parapet).toBeCloseTo(0.8, 6);
  });
  it('plateau 属性・mesh が無い建物、ピンが無いときは何もしない', () => {
    const plain: Neighbor = { id: 'g', ring: rect(0, 0, 5, 5), height: 7, source: 'gsi', heightKind: 'estimated' };
    expect(applyUserRoof(plain, { kind: 'hip', eave: 5, ridge: 7, boxHeight: 6 }, FRAME)).toBe(plain);
    expect(applyUserRoof(plateauNb(), { kind: 'hip', eave: 5, ridge: 7, boxHeight: 6 }, null).height).toBe(6.8);
  });
});

describe('setNeighborRoof / effectiveNeighbors', () => {
  it('上書きに屋根を書き（高さの上書きは消す）、effectiveNeighbors が仕様の建物を返す。null で推定に戻る', () => {
    study.neighborOverrides['plateau:b1'] = { height: 9 };
    expect(setNeighborRoof('plateau:b1', { kind: 'shed', eave: 5, ridge: 7, boxHeight: 6, highSide: 'S' })).toBe(true);
    expect(study.neighborOverrides['plateau:b1'].height).toBeUndefined();
    const e = effectiveNeighbors()[0];
    expect(e.height).toBe(7);
    expect(e.plateau?.roofEstimate).toMatchObject({ kind: 'shed', highSide: 'S', user: true });
    expect(setNeighborRoof('plateau:b1', null)).toBe(true);
    expect(study.neighborOverrides['plateau:b1']).toBeUndefined();
    expect(effectiveNeighbors()[0].height).toBe(6.8);
  });
  it('PLATEAU でない建物には書けない', () => {
    study.neighbors = [{ id: 'g', ring: rect(0, 0, 5, 5), height: 7, source: 'gsi', heightKind: 'estimated' }];
    expect(setNeighborRoof('g', { kind: 'hip', eave: 5, ridge: 7, boxHeight: 6 })).toBe(false);
  });
});

describe('保存データの検査', () => {
  it('壊れた屋根は捨て、正しい屋根は整えて残す', () => {
    expect(sanitizeUserRoof({ kind: 'dome', eave: 5, ridge: 7 })).toBeNull();
    expect(sanitizeUserRoof({ kind: 'hip', eave: -1, ridge: 7 })).toBeNull();
    expect(sanitizeUserRoof({ kind: 'gable', eave: 6, ridge: 5, ridgeDir: 'short', storeys: 2, highSide: 'X' })).toMatchObject({ kind: 'gable', eave: 6, ridge: 6, ridgeDir: 'short', storeys: 2, user: true });
    expect(sanitizeNeighborOverrides({ a: { roof: { kind: 'flat', eave: 9, ridge: 9.8 } }, b: { roof: 'x' } })).toEqual({ a: { roof: expect.objectContaining({ kind: 'flat', parapet: 0.8, user: true }) } });
  });
});

describe('initialRoofSpec', () => {
  it('推定の屋根があればそれ、無ければ箱（陸屋根・屋上 = 箱の高さ・階高 = 箱の高さ ÷ 階数）', () => {
    const n = plateauNb();
    expect(initialRoofSpec(n)).toMatchObject({ kind: 'flat', eave: 6.8, storeys: 2, floorH: 3.4 });
    const withEst = applyUserRoof(n, { kind: 'hip', eave: 5.6, ridge: 7.8, boxHeight: 6.8 }, FRAME);
    expect(initialRoofSpec(withEst)).toMatchObject({ kind: 'hip', eave: 5.6 });
  });
});
