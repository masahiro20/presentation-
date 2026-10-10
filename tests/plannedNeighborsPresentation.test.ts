// プレゼン側（SunContext）: 想定の家の追加・変更・削除・含める／含めない、遮蔽物（屋根・軒の出）、隠し方、取り直し・すべて消すでの扱い、注記
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { metersPerDegree, type NeighborBuilding, type SiteLocation } from '../src/sun/geo';

const fake = vi.hoisted(() => ({ gsi: [] as { ll: { lat: number; lon: number }[]; height: number }[] }));
vi.mock('../src/sun/geo', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/sun/geo')>();
  const make = async (lat: number, lon: number): Promise<NeighborBuilding[]> => fake.gsi.map((f) => ({ ring: f.ll.map((p) => mod.toLocal(p.lat, p.lon, lat, lon)), height: f.height, source: 'gsi' as const }));
  return { ...mod, fetchGsiBuildings: vi.fn(make), fetchOsmBuildings: vi.fn(make) };
});

import { SunContext } from '../src/sun/context';
import { buildOccluder, isShaded } from '../src/sun/analysis';
import { PLANNED_COLORS, PLANNED_EAVE_OVERHANG, buildPlannedHouseGeometry, houseFromPreset, plannedFootprint } from '../src/sun/plannedHouse';
import { NO_NEIGHBORS_DISCLOSURE, collectDisclosure, disclosureLines, excludedTableRows, plannedLine } from '../src/app/sunDisclosure';
import type { Viewer } from '../src/scene/viewer';

const PIN = { lat: 35.6045, lon: 139.6689 };
const { mLat, mLon } = metersPerDegree(PIN.lat);
const ll = (e: number, n: number) => ({ lat: PIN.lat + n / mLat, lon: PIN.lon + e / mLon });
const rectLL = (e0: number, n0: number, w: number, d: number) => [ll(e0, n0), ll(e0 + w, n0), ll(e0 + w, n0 + d), ll(e0, n0 + d)];
const SITE: SiteLocation = { lat: PIN.lat, lon: PIN.lon, address: '世田谷区奥沢', offsetE: 0, offsetN: 0 };
fake.gsi = [
  { ll: rectLL(-30, -25, 14, 11), height: 6.8 },
  { ll: rectLL(30, 20, 9, 8), height: 6.8 },
];

function fakeViewer(): Viewer {
  const g = () => new THREE.Group();
  const groups = { building: g(), roof: g(), furniture: g(), landscape: g(), lights: g(), external: g(), context: g(), overlay: g() };
  const scene = new THREE.Scene();
  for (const x of Object.values(groups)) scene.add(x);
  const camera = new THREE.PerspectiveCamera(45, 1.6, 0.1, 2000);
  camera.position.set(0, 150, 0.01);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return {
    state: {
      meta: { bbox: new THREE.Box3(new THREE.Vector3(-5, 0, -4), new THREE.Vector3(5, 7, 4)), outlines: [], rooms: [] },
      model: { northAngleDeg: 0 },
      site: { min: { x: -8, y: -7 }, max: { x: 8, y: 7 } },
    },
    groups,
    userData: {},
    camera,
    invalidate() {},
  } as unknown as Viewer;
}
const meshes = (sc: SunContext) => sc.neighborGroup.children as THREE.Mesh[];
const plannedMesh = (sc: SunContext, key: string) => meshes(sc).find((m) => m.userData.neighborKey === key);
const up = new THREE.Vector3(0, 1, 0);

describe('SunContext: 想定の家', () => {
  it('addPlanned: キー（manual:planned-N）で足し、屋根付きの形・色・userData.neighbor（遮蔽物）', () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    let changes = 0;
    sc.onNeighborsChange = () => changes++;
    const key = sc.addPlanned(houseFromPreset('gable2', 0, -14, 90));
    expect(key).toMatch(/^manual:planned-\d+$/);
    expect(changes).toBe(1);
    const [b] = sc.plannedList();
    expect(b.source).toBe('manual');
    expect(b.label).toBe('想定の家');
    expect(b.height).toBe(8.5);
    expect(b.ring).toEqual(plannedFootprint(b.planned));
    expect(sc.keyOf(b)).toBe(key);
    expect(b.planned.id).toBe(b.id);
    const m = plannedMesh(sc, key)!;
    expect(m.userData).toMatchObject({ neighbor: true, planned: true, neighborKey: key, neighborId: b.id });
    expect(m.castShadow).toBe(true);
    const mats = m.material as THREE.MeshStandardMaterial[];
    expect(mats.map((x) => '#' + x.color.getHexString())).toEqual([PLANNED_COLORS.roof, PLANNED_COLORS.wall]);
    expect(mats.every((x) => !x.transparent && x.opacity === 1)).toBe(true);
    expect(m.userData.baseMaterial).toBe(m.material);
    // 遮蔽物の三角形 = 想定の家のジオメトリの三角形（屋根の三角形を含む）
    const geo = buildPlannedHouseGeometry(b.planned, { toWorld: (e, n, y) => sc.toWorld(e, n, y), baseY: 0 });
    expect(buildOccluder(v).triangles).toBe(geo.getAttribute('position').count / 3);
    expect(geo.groups[0].count).toBeGreaterThan(0);
    // 南の軒の出の真下は影、軒の外は日なた（ワールドの南は +z。建物の中心 = 原点）
    const zEdge = 14 + 7.3 / 2;
    expect(isShaded(buildOccluder(v), new THREE.Vector3(0, 1, zEdge + PLANNED_EAVE_OVERHANG / 2), up)).toBe(true);
    expect(isShaded(buildOccluder(v), new THREE.Vector3(0, 1, zEdge + PLANNED_EAVE_OVERHANG + 0.1), up)).toBe(false);
    // 選んだ建物の色（作り直さずにマテリアルだけ替える）も効く
    sc.setHighlight([key]);
    expect((plannedMesh(sc, key)!.material as THREE.Material[]).length).toBe(2);
    sc.setHighlight([]);
    expect(plannedMesh(sc, key)!.material).toBe(mats);
  });

  it('updatePlanned / removePlanned: キーでも id でも。高さを直した記録は外す。無ければ false', () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    const key = sc.addPlanned(houseFromPreset('gable2', 0, -14, 90));
    const id = sc.plannedList()[0].id!;
    sc.setHeight(key, 12);
    expect(sc.plannedList()[0].planned.ridgeHeight).toBeCloseTo(12, 9);
    expect(sc.updatePlanned(id, { roof: 'flat', eaveHeight: 9.5, label: '3 階建ての想定' })).toBe(true);
    const b = sc.plannedList()[0];
    expect(b.planned).toMatchObject({ roof: 'flat', eaveHeight: 9.5, ridgeHeight: 9.5, label: '3 階建ての想定' });
    expect(b.height).toBe(9.5);
    expect(b.label).toBe('3 階建ての想定');
    expect(sc.edits.heights.has(key)).toBe(false);
    expect(sc.heightOf(b)).toBe(9.5);
    expect(sc.updatePlanned(key, { roof: 'flat' })).toBe(false);
    expect(sc.updatePlanned('manual:nope', { width: 3 })).toBe(false);
    sc.setHidden([key], true, { mode: 'exclude', reason: 'other' });
    expect(sc.removePlanned(key)).toBe(true);
    expect(sc.removePlanned(key)).toBe(false);
    expect(sc.edits.hidden.has(key)).toBe(false);
    expect(sc.edits.hideInfo.has(key)).toBe(false);
    expect(sc.plannedList()).toEqual([]);
    expect(meshes(sc)).toEqual([]);
    sc.addPlanned(houseFromPreset('box', 0, 20, 0));
    sc.addPlanned(houseFromPreset('box', 0, -20, 0));
    expect(sc.clearPlanned()).toBe(2);
    expect(sc.clearPlanned()).toBe(0);
  });

  it('隠し方: 表示だけ隠すと影だけのメッシュ（同じ形）で遮蔽物に残り、計算から除外で外れる。薄い表示も屋根付き', () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    const key = sc.addPlanned(houseFromPreset('hip2', 0, -14, 90));
    const tri = buildOccluder(v).triangles;
    sc.setHidden([key], true, { mode: 'view', reason: 'other' });
    expect(buildOccluder(v).triangles).toBe(tri);
    expect(plannedMesh(sc, key)!.userData.shadowOnly).toBe(true);
    expect(sc.hiddenList('view')).toHaveLength(1);
    sc.setHideMode([key], 'exclude');
    expect(buildOccluder(v).triangles).toBe(0);
    sc.setGhosts(true);
    const ghost = (sc.ghostGroup.children as THREE.Mesh[])[0];
    ghost.geometry.computeBoundingBox();
    expect(ghost.geometry.boundingBox!.max.y).toBeCloseTo(8, 4);
    expect(ghost.userData.neighbor).toBeUndefined();
  });

  it('setPlannedEnabled(false): 実体・影だけのメッシュ・薄い表示のどれも作らない（隠す記録はそのまま）。一覧・選択の対象からも外す', () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    const a = sc.addPlanned(houseFromPreset('gable2', 0, -14, 90));
    const b = sc.addPlanned(houseFromPreset('gable2', 0, 14, 90));
    sc.setHidden([b], true, { mode: 'view', reason: 'other' });
    sc.setGhosts(true);
    expect(sc.plannedEnabled).toBe(true);
    expect(sc.setPlannedEnabled(false)).toBe(true);
    expect(sc.setPlannedEnabled(false)).toBe(false);
    expect(meshes(sc)).toEqual([]);
    expect(sc.ghostGroup.children).toEqual([]);
    expect(buildOccluder(v).triangles).toBe(0);
    expect(sc.hiddenList()).toEqual([]);
    expect(sc.hideRecord(b)).toEqual({ mode: 'view', reason: 'other' });
    expect(sc.selectableCentroids()).toEqual([]);
    expect(sc.plannedList()).toHaveLength(2);
    expect(sc.setPlannedEnabled(true)).toBe(true);
    expect(plannedMesh(sc, a)!.userData.planned).toBe(true);
    expect(plannedMesh(sc, b)!.userData.shadowOnly).toBe(true);
    expect(sc.selectableCentroids().map((x) => x.key).sort()).toEqual([a, b].sort());
  });

  it('取り直し（loadNeighbors）・建設地の微調整の後も残る（キーも同じ）。すべて消すは既定で想定の家を残す', async () => {
    const v = fakeViewer();
    const site = { ...SITE };
    const sc = new SunContext(v, site);
    await sc.loadNeighbors('gsi');
    const key = sc.addPlanned(houseFromPreset('gable2', 0, -14, 90));
    sc.setHidden([key], true, { mode: 'view', reason: 'other', note: '視点' });
    sc.state.site = { ...site, offsetN: 2 };
    await sc.loadNeighbors('gsi');
    expect(sc.state.neighbors.filter((x) => x.source === 'gsi')).toHaveLength(2);
    expect(sc.plannedList().map((x) => sc.keyOf(x))).toEqual([key]);
    expect(sc.hideRecord(key)).toEqual({ mode: 'view', reason: 'other', note: '視点' });
    const auto = sc.keyOf(sc.state.neighbors.find((x) => x.source === 'gsi')!);
    sc.setHidden([auto], true, { mode: 'exclude', reason: 'demolish' });
    sc.clearNeighbors();
    expect(sc.state.neighbors.map((x) => sc.keyOf(x))).toEqual([key]);
    expect(sc.hideRecord(key)).toEqual({ mode: 'view', reason: 'other', note: '視点' });
    expect(sc.hideRecord(auto)).toBeNull();
    sc.clearNeighbors({ includePlanned: true });
    expect(sc.state.neighbors).toEqual([]);
    expect(sc.edits.hideInfo.size).toBe(0);
  });

  it('注記: 想定の家の行（含めている／いない）。計算から除外した想定の家は表に「想定の家（未建築）」', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('gsi');
    const a = sc.addPlanned(houseFromPreset('gable2', 0, -14, 90));
    const b = sc.addPlanned({ ...houseFromPreset('hiraya', 0, 16, 90), label: '北の区画' });
    let d = collectDisclosure(sc);
    expect(d.included).toBe(4);
    expect(d.planned).toEqual({ count: 2, enabled: true });
    for (const t of ['rooms', 'heatmap', 'deck', 'diagram'] as const) expect(disclosureLines(d, t)).toContain('想定で置いた建物 2 棟（未建築・仮の形状。影・解析に含む）');
    sc.setHidden([b], true, { mode: 'exclude', reason: 'other' });
    d = collectDisclosure(sc);
    expect(d.planned).toEqual({ count: 1, enabled: true });
    expect(d.excluded).toHaveLength(1);
    expect(d.excluded[0].planned).toBe(true);
    const [row] = excludedTableRows(d);
    expect(row.source).toBe('想定の家（未建築・北の区画）');
    expect(row.height).toBe('5.0 m（想定）');
    sc.setPlannedEnabled(false);
    d = collectDisclosure(sc);
    expect(d.included).toBe(2);
    expect(d.excluded).toEqual([]);
    expect(d.planned).toEqual({ count: 1, enabled: false });
    expect(disclosureLines(d, 'rooms')).toEqual(['※部屋の日当たりは周辺建物 2 棟の影を含めて計算しています', '計算から除外した周辺建物 なし', '想定で置いた建物 1 棟（未建築・仮の形状。今は含めていません）']);
    // 周辺建物を読み込まず、想定の家だけ（含めていない）
    sc.clearNeighbors();
    d = collectDisclosure(sc);
    expect(disclosureLines(d, 'heatmap')).toEqual(['※日照時間マップは周辺建物を読み込まずに計算しています（計画建物の影のみ）', '想定で置いた建物 1 棟（未建築・仮の形状。今は含めていません）']);
    // 想定の家が無ければ行を出さない（古い写し・読み込んでいないときも同じ）
    expect(plannedLine(NO_NEIGHBORS_DISCLOSURE)).toBeNull();
    expect(disclosureLines(NO_NEIGHBORS_DISCLOSURE, 'rooms')).toEqual(['※部屋の日当たりは周辺建物を読み込まずに計算しています（計画建物の影のみ）']);
    void a;
  });
});
