// 日照ツール: PLATEAU の実形状と属性の保存／復元（toSavedNeighbor / fromSavedNeighbor / sanitizePlateauAttrs、env.plateau、プロジェクト JSON の往復）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuantizedMesh } from '../src/sun/plateau';
import { buildNeighborMeshes } from '../src/sunstudy/neighbors';
import { applyProject, fromSavedNeighbor, sanitizePlateauAttrs, serializeProject, toSavedNeighbor } from '../src/sunstudy/project';
import { hiddenNeighbors, setNeighborsHidden, study, visibleNeighbors } from '../src/sunstudy/state';
import type { Neighbor, ProjectJson, SavedNeighbor } from '../src/sunstudy/types';
import { boxMesh, plateauNeighborAt } from './helpers/plateauBox';

const PIN = { lat: 35.6, lon: 139.6 };
const FRAME = { ...PIN, address: 'テスト', groundElev: 10 };
const square = (e0: number, n0: number, size: number) => [
  { e: e0, n: n0 },
  { e: e0 + size, n: n0 },
  { e: e0 + size, n: n0 + size },
  { e: e0, n: n0 + size },
];
const gsi = (id: string, ring: { e: number; n: number }[]): Neighbor => ({ id, ring, height: 7, source: 'gsi', heightKind: 'estimated' });
const PLATEAU_ENV = { datasets: [{ muniCd: '23113', pref: '愛知県', city: '名古屋市', ward: '守山区', year: 2022, lod: 1, tex: true, tilesetUrl: 'https://x/23113/tileset.json', label: '愛知県名古屋市守山区・2022年度・LOD1' }], indexGenerated: '2026-10-10' };

function resetStudy() {
  study.frame = { ...FRAME };
  study.sitePolygon = [];
  study.model = null;
  study.points = [];
  study.grid = null;
  study.aerial = null;
  study.horizon = null;
  study.neighborOverrides = {};
  study.plannedEnabled = true;
  study.results = { images: [] };
  study.env = { loaded: true, loading: false, error: null, attribution: '', plateau: { datasets: PLATEAU_ENV.datasets.map((d) => ({ ...d })), indexGenerated: PLATEAU_ENV.indexGenerated } };
  study.neighborSources = ['plateau', 'gsi'];
  study.neighborNotes = ['PLATEAU（国土交通省 3D都市モデル・愛知県名古屋市守山区・2022年度・LOD1）の実測の高さ・形状を使用（1 棟を取得。箱形。天端は点群の中央値）。'];
  study.neighbors = [
    plateauNeighborAt(PIN, 20, 0, { gmlId: 'bldg_a', w: 10, d: 8, h: 6.66, zmin: 57.2, holes: [square(-1, -1, 1)], attrs: { usage: '住宅', measuredHeight: 7.6, storeys: 2, warnings: ['islands'] } }),
    gsi('gsi:1', square(-30, 0, 8)),
    { id: 'manual1', ring: square(0, -25, 6), height: 6, source: 'manual', heightKind: 'manual', label: '隣家' },
  ];
}

const closeTris = (a: Float32Array, b: Float32Array, tol = 0.005) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(tol);
};

describe('toSavedNeighbor / fromSavedNeighbor', () => {
  beforeEach(resetStudy);
  afterEach(() => vi.restoreAllMocks());

  it('mesh → meshQ（Int16 cm・base64）、ring/holes/plateau は写し。戻すと ±0.5 cm・roofTriangles が残る。JSON に TypedArray が出ない', () => {
    const n = study.neighbors[0];
    const s = toSavedNeighbor(n);
    expect('mesh' in s).toBe(false);
    expect(s.meshQ).toMatchObject({ v: 1, q: 100, roofTriangles: 2 });
    expect(typeof s.meshQ!.posB64).toBe('string');
    expect(s.ring).toEqual(n.ring);
    expect(s.ring).not.toBe(n.ring);
    expect(s.holes).toEqual(n.holes);
    expect(s.holes![0]).not.toBe(n.holes![0]);
    expect(s.plateau).toEqual(n.plateau);
    expect(s.plateau).not.toBe(n.plateau);
    expect(s.plateau!.warnings).not.toBe(n.plateau!.warnings);
    const text = JSON.stringify(s);
    expect(text).not.toContain('[object');
    expect(text).not.toContain('"0":');
    // 1 棟の保存サイズの目安（箱 12 三角形 + ring + 属性）: 2 KB 未満
    expect(text.length).toBeLessThan(2000);
    const back = fromSavedNeighbor(JSON.parse(text) as SavedNeighbor);
    expect('meshQ' in back).toBe(false);
    expect(back.mesh).toBeDefined();
    expect(back.mesh!.roofTriangles).toBe(2);
    closeTris(back.mesh!.tris, n.mesh!.tris);
    expect(back.plateau).toEqual(n.plateau);
    expect(back.id).toBe(n.id);
  });

  it('mesh の無い建物はそのまま、meshQ が無い・壊れている保存データは mesh 無しで開ける（警告だけ）。量子化できない巨大な建物は meshQ 無し', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = toSavedNeighbor(study.neighbors[1]);
    expect('meshQ' in g).toBe(false);
    expect(fromSavedNeighbor(g)).toEqual(study.neighbors[1]);
    const broken = fromSavedNeighbor({ ...toSavedNeighbor(study.neighbors[0]), meshQ: { v: 1, q: 100, posB64: '@@@', roofTriangles: 2 } });
    expect(broken.mesh).toBeUndefined();
    expect(broken.plateau).toBeDefined();
    const wrongShape = fromSavedNeighbor({ ...toSavedNeighbor(study.neighbors[0]), meshQ: { v: 2 } as unknown as QuantizedMesh });
    expect(wrongShape.mesh).toBeUndefined();
    // 400 m の頂点（Int16 cm の範囲外）: quantizeMesh は ±327.67 m に丸めて警告する（throw しても meshQ 無しで続く）
    const huge: Neighbor = { ...study.neighbors[0], mesh: boxMesh(800, 10, 7) };
    const sh = toSavedNeighbor(huge);
    expect(sh.plateau).toBeDefined();
    if (sh.meshQ) {
      const back = fromSavedNeighbor(sh);
      expect(Math.max(...back.mesh!.tris)).toBeLessThanOrEqual(327.68);
    }
    expect(warn).toHaveBeenCalled();
  });
});

describe('sanitizePlateauAttrs', () => {
  beforeEach(resetStudy);

  it('正しい属性はそのまま（任意の項目は型が合うものだけ）。lod・footprint・warnings の知らない値は整える', () => {
    const n = study.neighbors[0];
    const out = sanitizePlateauAttrs(n);
    expect(out.plateau).toEqual(n.plateau);
    expect(out.mesh).toEqual(n.mesh);
    expect(out.mesh!.tris).toBe(n.mesh!.tris);
    const odd = sanitizePlateauAttrs({ ...n, plateau: { ...n.plateau!, lod: 9 as never, footprint: 'rect' as never, warnings: ['islands', 'bogus'] as never, measuredHeight: 'x' as never, usage: '' } });
    expect(odd.plateau!.lod).toBeNull();
    expect(odd.plateau!.footprint).toBe('hull');
    expect(odd.plateau!.warnings).toEqual(['islands']);
    expect('measuredHeight' in odd.plateau!).toBe(false);
    expect('usage' in odd.plateau!).toBe(false);
    expect(odd.plateau!.datasetLod).toBe(1);
    // plateau も mesh も無ければ同じオブジェクト
    const g = study.neighbors[1];
    expect(sanitizePlateauAttrs(g)).toBe(g);
  });

  it('gmlId・anchor・zmin/zmax が不正なら plateau と mesh を外す。mesh が壊れていれば mesh だけ外す。plateau 無しの mesh は外す', () => {
    const n = study.neighbors[0];
    for (const bad of [{ gmlId: '' }, { anchor: { lat: 'x' } }, { anchor: undefined }, { zmin: NaN }, { zmax: 50 }, { zmax: n.plateau!.zmin }]) {
      const out = sanitizePlateauAttrs({ ...n, plateau: { ...n.plateau!, ...(bad as object) } as never });
      expect('plateau' in out).toBe(false);
      expect('mesh' in out).toBe(false);
      expect(out.ring).toEqual(n.ring);
    }
    expect('plateau' in sanitizePlateauAttrs({ ...n, plateau: 'yes' as never })).toBe(false);
    const badMesh = sanitizePlateauAttrs({ ...n, mesh: { tris: [1, 2, 3], roofTriangles: 1 } as never });
    expect('mesh' in badMesh).toBe(false);
    expect(badMesh.plateau).toEqual(n.plateau);
    const notMultiple = sanitizePlateauAttrs({ ...n, mesh: { tris: new Float32Array(10), roofTriangles: 1 } });
    expect('mesh' in notMultiple).toBe(false);
    const roofClamp = sanitizePlateauAttrs({ ...n, mesh: { tris: n.mesh!.tris, roofTriangles: 99 } });
    expect(roofClamp.mesh!.roofTriangles).toBe(12);
    const { plateau: _p, ...noAttrs } = n;
    void _p;
    expect('mesh' in sanitizePlateauAttrs(noAttrs)).toBe(false);
  });
});

describe('プロジェクト JSON の往復（PLATEAU の実形状・属性・出典・隠す／高さの上書き）', () => {
  beforeEach(resetStudy);

  it('serializeProject → applyProject: meshQ が mesh に戻り（±0.5 cm）、hidden/override/plateau 属性と env.plateau が残る', async () => {
    const n = study.neighbors[0];
    setNeighborsHidden([n.id], true, { mode: 'view', reason: 'other', note: '視点の手前' });
    study.neighborOverrides['gsi:1'] = { height: 9 };
    const text = JSON.stringify(serializeProject());
    expect(text).not.toContain('[object');
    const json = JSON.parse(text) as ProjectJson;
    const saved = json.env!.neighbors.find((s) => s.id === n.id)!;
    expect(saved.meshQ).toMatchObject({ v: 1, q: 100, roofTriangles: 2 });
    expect('mesh' in saved).toBe(false);
    expect(saved.plateau).toEqual(n.plateau);
    expect(json.env!.plateau).toEqual(PLATEAU_ENV);
    expect(json.env!.neighborSources).toEqual(['plateau', 'gsi']);
    expect(json.neighborOverrides[n.id]).toEqual({ hidden: true, hideMode: 'view', hideReason: 'other', hideNote: '視点の手前' });
    // 別の状態にしてから開く
    study.neighbors = [];
    study.neighborOverrides = {};
    study.env = { loaded: false, loading: false, error: null, attribution: '' };
    await applyProject(json);
    const back = study.neighbors.find((x) => x.id === n.id)!;
    expect(back.mesh).toBeDefined();
    expect(back.mesh!.tris).toBeInstanceOf(Float32Array);
    closeTris(back.mesh!.tris, n.mesh!.tris);
    expect(back.mesh!.roofTriangles).toBe(2);
    expect(back.plateau).toEqual(n.plateau);
    expect(back.holes).toEqual(n.holes);
    expect(back.source).toBe('plateau');
    expect(hiddenNeighbors().map((x) => x.id)).toEqual([n.id]);
    expect(hiddenNeighbors()[0].hideMode).toBe('view');
    expect(hiddenNeighbors()[0].hideNote).toBe('視点の手前');
    expect(study.neighborOverrides['gsi:1']).toEqual({ height: 9 });
    expect(visibleNeighbors().find((x) => x.id === 'gsi:1')!.height).toBe(9);
    expect(study.env.plateau).toEqual(PLATEAU_ENV);
    expect(study.neighborSources).toEqual(['plateau', 'gsi']);
    expect(study.neighborNotes[0]).toMatch(/^PLATEAU（国土交通省 3D都市モデル・愛知県名古屋市守山区・2022年度・LOD1）/);
    // 復元した mesh で描ける（12 三角形）
    const g = buildNeighborMeshes([{ ...back, hidden: false }], { groundY: () => 0, pin: PIN });
    expect(g.children[0].userData.neighborId).toBe(n.id);
    expect((g.children[0] as import('three').Mesh).geometry.getAttribute('position').count).toBe(36);
  });

  it('古い保存データ（meshQ 無し）・壊れた属性・壊れた meshQ・壊れた env.plateau でも開け、押し出しで描ける', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const json = JSON.parse(JSON.stringify(serializeProject())) as ProjectJson;
    const [a] = json.env!.neighbors;
    json.env!.neighbors = [
      { ...a, id: 'plateau:noMesh', meshQ: undefined },
      { ...a, id: 'plateau:badAttrs', plateau: { gmlId: 'x' } as never },
      { ...a, id: 'plateau:badMesh', meshQ: { v: 1, q: 100, posB64: '!!', roofTriangles: 2 } },
      { ...a, id: 'plateau:ok' },
    ];
    (json.env as unknown as { plateau: unknown }).plateau = { datasets: [{ muniCd: '23113' }], indexGenerated: 5 };
    study.neighbors = [];
    await applyProject(json);
    const byId = new Map(study.neighbors.map((n) => [n.id, n]));
    expect(byId.get('plateau:noMesh')!.mesh).toBeUndefined();
    expect(byId.get('plateau:noMesh')!.plateau).toEqual(a.plateau);
    expect(byId.get('plateau:badAttrs')!.plateau).toBeUndefined();
    expect(byId.get('plateau:badAttrs')!.mesh).toBeUndefined();
    expect(byId.get('plateau:badMesh')!.mesh).toBeUndefined();
    expect(byId.get('plateau:badMesh')!.plateau).toEqual(a.plateau);
    expect(byId.get('plateau:ok')!.mesh).toBeDefined();
    expect(study.env.plateau).toBeUndefined();
    expect(study.env.loaded).toBe(true);
    // 押し出しで描ける
    const g = buildNeighborMeshes(study.neighbors.filter((n) => n.source !== 'manual'), { groundY: () => 0, pin: PIN });
    expect(g.children).toHaveLength(4);
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('env.plateau: label の無いデータセットは捨て、1 件も無ければ無し。indexGenerated が文字列でなければ空', async () => {
    const json = JSON.parse(JSON.stringify(serializeProject())) as ProjectJson;
    (json.env as unknown as { plateau: unknown }).plateau = { datasets: [{ muniCd: '13112', label: '東京都世田谷区・2025年度・LOD2', lod: 2, year: 2025 }, { label: 'x' }], indexGenerated: 1 };
    await applyProject(json);
    expect(study.env.plateau).toEqual({ datasets: [{ muniCd: '13112', pref: '', city: '', ward: null, year: 2025, lod: 2, tex: false, tilesetUrl: '', label: '東京都世田谷区・2025年度・LOD2' }], indexGenerated: '' });
    // env 無し → plateau 無し
    delete json.env;
    await applyProject(json);
    expect(study.env.plateau).toBeUndefined();
  });
});
