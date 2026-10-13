/**
 * 間取りプレゼン（SunContext）の PLATEAU 統合（仕様 §2.12・§4・§5・§8・§9）:
 *  - loadNeighbors('plateau'): PLATEAU の実形状の建物 + 国土地理院で補完（重なる建物は捨て、離れた建物だけ足す）。キーは plateau:<gml_id>、半径 110 m、進捗の文
 *  - 未整備（none）・通信エラー（error）は国土地理院 → OSM の従来順に落ち、notes に理由。'gsi' を選べば PLATEAU を呼ばない
 *  - mesh 建物は遮蔽物（buildOccluder）に入り、表示だけ隠すと影だけのメッシュが残り、計算から除外で外れる。高さを直すと足元を固定して伸びる
 *  - 真北を回しても ring の重心（toWorld）と mesh の bbox 中心が一致する（局所座標 → ワールドの行列）
 *  - 国土地理院で隠した・高さを直した記録が、外形の照合（reapplyEdits）で PLATEAU の同じ建物に引き継がれる
 *  - 開示: collectDisclosure.sources の行、表の高さの括弧（PLATEAU なし・国土地理院（推定）・手入力）、案内の文言
 * 取得（src/sun/plateau/fetch）はモックし、国土地理院・OSM は既存テストと同じ vi.mock('../src/sun/geo') の契約で差し替える
 */
import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { metersPerDegree, toLocal, type NeighborBuilding, type SiteLocation } from '../src/sun/geo';
import type { PlateauDatasetInfo, PlateauFetchResult, PlateauProgress } from '../src/sun/plateau';

type LL = { lat: number; lon: number };
const fake = vi.hoisted(() => ({
  gsi: [] as { ll: { lat: number; lon: number }[]; height: number }[],
  osm: [] as { ll: { lat: number; lon: number }[]; height: number }[],
  gsiFail: false,
  osmFail: false,
  plateau: null as PlateauFetchResult | null,
  calls: [] as { lat: number; lon: number; radius: number }[],
}));
vi.mock('../src/sun/geo', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/sun/geo')>();
  const make = (src: 'gsi' | 'osm') => async (lat: number, lon: number): Promise<NeighborBuilding[]> => {
    if (src === 'gsi' ? fake.gsiFail : fake.osmFail) throw new Error(`${src} に接続できません`);
    return fake[src].map((f) => ({ ring: f.ll.map((p) => mod.toLocal(p.lat, p.lon, lat, lon)), height: f.height, source: src }));
  };
  return { ...mod, fetchGsiBuildings: vi.fn(make('gsi')), fetchOsmBuildings: vi.fn(make('osm')) };
});
vi.mock('../src/sun/plateau/fetch', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/sun/plateau/fetch')>();
  const fetchPlateauBuildings = vi.fn(async (lat: number, lon: number, radius: number, opts?: { signal?: AbortSignal; onProgress?: (p: PlateauProgress) => void }): Promise<PlateauFetchResult> => {
    fake.calls.push({ lat, lon, radius });
    if (opts?.signal?.aborted) throw opts.signal.reason ?? new Error('中止');
    opts?.onProgress?.({ stage: 'tiles', message: '建物タイル 1/2（1.0 MB）', done: 1, total: 2, bytes: 1e6, totalBytes: null, ratio: 0.5 });
    if (!fake.plateau) throw new Error('fake.plateau が未設定');
    return fake.plateau;
  });
  return { ...mod, fetchPlateauBuildings };
});

import { NEIGHBOR_RADIUS_M, NOTE_PLATEAU_ERROR, NOTE_PLATEAU_MISSING, SunContext, neighborKey, plateauCoveredNotes, plateauProgressText, plateauToNeighborBuilding, ringCentroid, roofShapeCount } from '../src/sun/context';
import { buildOccluder } from '../src/sun/analysis';
import { collectDisclosure, disclosureLines, excludedTableRows, heightKindOf, heightKindSuffix, sourceLines } from '../src/app/sunDisclosure';
import { NEIGHBORS_HINT, NEIGHBOR_SOURCE_BUTTON, NO_NEIGHBORS_MSG, neighborSourceLine, neighborsLoadedToast } from '../src/app/steps/sunStep';
import { fetchPlateauBuildings } from '../src/sun/plateau/fetch';
import { plateauBox } from './helpers/plateauBox';
import type { Viewer } from '../src/scene/viewer';

const PIN: LL = { lat: 35.6045, lon: 139.6689 };
const { mLat, mLon } = metersPerDegree(PIN.lat);
/** PIN から東 e・北 n (m) の緯度・経度 */
const ll = (e: number, n: number): LL => ({ lat: PIN.lat + n / mLat, lon: PIN.lon + e / mLon });
const rectLL = (e0: number, n0: number, w: number, d: number) => [ll(e0, n0), ll(e0 + w, n0), ll(e0 + w, n0 + d), ll(e0, n0 + d)];
const SITE: SiteLocation = { lat: PIN.lat, lon: PIN.lon, address: '世田谷区奥沢', offsetE: 0, offsetN: 0 };
const DATASET: PlateauDatasetInfo = { muniCd: '13112', pref: '東京都', city: '世田谷区', ward: null, year: 2025, lod: 2, tex: false, tilesetUrl: 'https://example.invalid/tileset.json', label: '東京都世田谷区・2025年度・LOD2' };

/** PLATEAU の 2 棟: A = 箱形（LOD1）10×8×7、足元の中心がピンから東 20・北 −15。B = 屋根形状（LOD2）12×10×9、西 25・北 20。用途・実測の最高高さ付き */
const boxA = () => plateauBox({ gmlId: 'bldg_A', anchor: ll(20, -15), w: 10, d: 8, h: 7, zmin: 40, attrs: { ...dsAttrs(), lod: 1 } });
const boxB = () => plateauBox({ gmlId: 'bldg_B', anchor: ll(-25, 20), w: 12, d: 10, h: 9, zmin: 41.5, attrs: { ...dsAttrs(), lod: 2, usage: '共同住宅', measuredHeight: 9.8, storeys: 3 } });
const dsAttrs = () => ({ datasetLod: 2, year: 2025, muniCd: '13112', pref: '東京都', city: '世田谷区', ward: null });
type Covered = Extract<PlateauFetchResult, { status: 'covered' }>;
const covered = (): Covered => ({
  status: 'covered',
  buildings: [boxA(), boxB()],
  datasets: [DATASET],
  tiles: [{ url: 'https://example.invalid/data0.b3dm', bytes: 1e6, buildings: 2, ms: 10 }],
  failedTiles: 0,
  truncated: false,
  lodCounts: { '1': 1, '2': 1 },
  missingMuniCds: [],
});

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
const meshOf = (sc: SunContext, key: string) => meshes(sc).find((m) => m.userData.neighborKey === key && !m.userData.shadowOnly)!;
const bboxOf = (m: THREE.Mesh) => {
  m.geometry.computeBoundingBox();
  return m.geometry.boundingBox!;
};

beforeEach(() => {
  fake.plateau = covered();
  fake.calls = [];
  fake.gsiFail = false;
  fake.osmFail = false;
  // 国土地理院: A と同じ足元（PLATEAU にあるので補完されない）・離れた建物（補完される）・敷地の中（取り込まない）
  fake.gsi = [
    { ll: rectLL(15, -19, 10, 8), height: 6.8 },
    { ll: rectLL(-34, -34, 8, 8), height: 6.8 },
    { ll: rectLL(-2, -2, 4, 4), height: 6.8 },
  ];
  fake.osm = [{ ll: rectLL(30, 30, 9, 8), height: 9.4 }];
  vi.mocked(fetchPlateauBuildings).mockClear();
});

describe('plateauToNeighborBuilding: anchor 基準 → ピン基準', () => {
  it('id plateau:<gml_id>・source plateau・heightKind measured・height は小数 1 桁・ring/holes を平行移動（元の配列は書き換えない）・mesh は共有・label = 用途', () => {
    const b = boxB();
    b.holes = [
      [
        { e: -1, n: -1 },
        { e: -1, n: 1 },
        { e: 1, n: 1 },
        { e: 1, n: -1 },
      ],
    ];
    (b as { height: number }).height = 9.04;
    const nb = plateauToNeighborBuilding(b, PIN);
    expect(nb.id).toBe('plateau:bldg_B');
    expect(nb.source).toBe('plateau');
    expect(nb.heightKind).toBe('measured');
    expect(nb.height).toBe(9);
    expect(nb.label).toBe('共同住宅');
    expect(nb.mesh).toBe(b.mesh);
    expect(nb.plateau).toEqual(b.attrs);
    expect(nb.plateau).not.toBe(b.attrs);
    const c = ringCentroid(nb.ring);
    expect(c.e).toBeCloseTo(-25, 2);
    expect(c.n).toBeCloseTo(20, 2);
    expect(ringCentroid(nb.holes![0]).e).toBeCloseTo(-25, 2);
    expect(ringCentroid(b.ring)).toEqual({ e: 0, n: 0 });
    // ピンを動かすと ring も動くが、キー（gml_id）は変わらない
    const moved = plateauToNeighborBuilding(b, ll(3, -4));
    expect(ringCentroid(moved.ring).e).toBeCloseTo(-28, 2);
    expect(neighborKey(moved, ll(3, -4))).toBe(neighborKey(nb, PIN));
    expect(neighborKey(nb, PIN)).toBe('plateau:bldg_B');
  });
  it('進捗の文・注記・屋根形状の棟数', () => {
    expect(plateauProgressText({ message: '建物タイル 3/6（8.1 MB）' })).toBe('周辺建物（PLATEAU）: 建物タイル 3/6（8.1 MB）');
    expect(plateauProgressText({ message: '周辺建物を統合しています…' })).toBe('周辺建物を統合しています…');
    const r = covered();
    expect(plateauCoveredNotes(r, 0)).toEqual([]);
    expect(plateauCoveredNotes({ ...r, failedTiles: 2, truncated: true, missingMuniCds: ['13111'] }, 3)).toEqual([
      '国土地理院の地図から 3 棟を補いました（高さは建物の種類から推定）。',
      'PLATEAU の建物タイル 3 枚のうち 2 枚を取得できなかったため、建物が欠けている可能性があります。',
      '遠方の建物の一部は取得していません（データ量の上限）。',
      '隣接する市区（市区町村コード 13111）は PLATEAU が未整備のため、その範囲は国土地理院の推定で補いました。',
    ]);
    expect(roofShapeCount({ '1': 5, '2': 2, '3': 1 })).toBe(3);
    expect(NEIGHBOR_RADIUS_M).toBe(110);
  });
});

describe('SunContext.loadNeighbors: PLATEAU → 国土地理院で補完 → OSM', () => {
  it('既定は PLATEAU（半径 110 m）。実形状 2 棟 + 離れた国土地理院 1 棟（重なる建物は補完しない・敷地の中は除く）。キーは plateau:<gml_id>', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    const progress: [string, number][] = [];
    const r = await sc.loadNeighbors(undefined, { onProgress: (m, ratio) => progress.push([m, ratio]) });
    expect(fake.calls).toEqual([{ lat: PIN.lat, lon: PIN.lon, radius: 110 }]);
    expect(r.count).toBe(3);
    expect(r.used).toEqual(['plateau', 'gsi']);
    expect(r.notes).toEqual(['国土地理院の地図から 1 棟を補いました（高さは建物の種類から推定）。']);
    expect(r.plateau).toEqual({ datasets: [DATASET], lodCounts: { '1': 1, '2': 1 }, status: 'covered' });
    expect(sc.lastSource).toBe('plateau');
    expect(sc.lastLoad).toBe(r);
    expect(progress).toContainEqual(['周辺建物（PLATEAU）: 建物タイル 1/2（1.0 MB）', 0.5]);
    const list = sc.state.neighbors;
    expect(list.map((b) => b.source)).toEqual(['plateau', 'plateau', 'gsi']);
    expect(list.map((b) => sc.keyOf(b))).toEqual(['plateau:bldg_A', 'plateau:bldg_B', expect.stringMatching(/^gsi:/)]);
    expect(list.map((b) => b.id)).toEqual(['plateau:bldg_A', 'plateau:bldg_B', 'gsi-1']);
    // ring はピン基準（anchor の分だけ平行移動）、mesh と属性を持つ
    const a = list[0];
    expect(ringCentroid(a.ring).e).toBeCloseTo(20, 2);
    expect(ringCentroid(a.ring).n).toBeCloseTo(-15, 2);
    expect(a.mesh?.tris.length).toBe(12 * 9);
    expect(a.plateau?.gmlId).toBe('bldg_A');
    expect(a.heightKind).toBe('measured');
    expect(a.height).toBe(7);
    expect(list[1].label).toBe('共同住宅');
    expect(list[2].heightKind).toBeUndefined();
    expect(heightKindOf(list[2])).toBe('estimated');
    // 国土地理院の補完は PLATEAU に無い建物だけ（A と同じ足元の建物は捨てられた）
    expect(ringCentroid(list[2].ring).e).toBeCloseTo(-30, 2);
  });

  it('国土地理院が落ちていても PLATEAU だけで続ける（補完なし）', async () => {
    fake.gsiFail = true;
    const sc = new SunContext(fakeViewer(), { ...SITE });
    const r = await sc.loadNeighbors('plateau');
    expect(r.count).toBe(2);
    expect(r.used).toEqual(['plateau']);
    expect(r.notes).toEqual([]);
  });

  it('未整備（none）→ 国土地理院（注記「未整備」）。国土地理院が空なら OSM。通信エラー（error）は注記「通信エラー」', async () => {
    fake.plateau = { status: 'none', reason: 'outside', muniCds: ['11201'] };
    let sc = new SunContext(fakeViewer(), { ...SITE });
    let r = await sc.loadNeighbors('plateau');
    expect(r.count).toBe(2);
    expect(r.used).toEqual(['gsi']);
    expect(r.notes).toEqual([NOTE_PLATEAU_MISSING]);
    expect(r.notes[0]).toMatch(/PLATEAU.*未整備/);
    expect(r.plateau).toEqual({ datasets: [], lodCounts: {}, status: 'none' });
    expect(sc.state.neighbors.every((b) => b.source === 'gsi' && !b.mesh)).toBe(true);
    // PLATEAU 未整備のまま国土地理院も空 → OSM（従来順）
    fake.gsi = [];
    sc = new SunContext(fakeViewer(), { ...SITE });
    r = await sc.loadNeighbors('plateau');
    expect(r.used).toEqual(['osm']);
    expect(sc.state.neighbors.map((b) => b.source)).toEqual(['osm']);
    // 通信エラー
    fake.plateau = { status: 'error', stage: 'tileset', message: 'tileset.json を取得できません' };
    fake.gsi = [{ ll: rectLL(15, -19, 10, 8), height: 6.8 }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sc = new SunContext(fakeViewer(), { ...SITE });
    r = await sc.loadNeighbors('plateau');
    warn.mockRestore();
    expect(r.used).toEqual(['gsi']);
    expect(r.notes).toEqual([NOTE_PLATEAU_ERROR]);
    expect(r.notes[0]).toMatch(/通信エラー/);
    expect(r.plateau?.status).toBe('error');
    // すべて失敗 → 例外（既存の契約）
    fake.gsiFail = true;
    fake.osmFail = true;
    sc = new SunContext(fakeViewer(), { ...SITE });
    await expect(sc.loadNeighbors('plateau')).rejects.toThrow(/接続できません/);
  });

  it("'gsi' / 'osm' を選ぶと PLATEAU を呼ばない（従来どおり）。lastSource は選んだ取得元", async () => {
    const sc = new SunContext(fakeViewer(), { ...SITE });
    const r = await sc.loadNeighbors('gsi');
    expect(fetchPlateauBuildings).not.toHaveBeenCalled();
    expect(r).toEqual({ count: 2, used: ['gsi'], notes: [] });
    expect(sc.lastSource).toBe('gsi');
    const r2 = await sc.loadNeighbors('osm');
    expect(r2.used).toEqual(['osm']);
    expect(sc.lastSource).toBe('osm');
    expect(fetchPlateauBuildings).not.toHaveBeenCalled();
  });

  it('中止（signal）は理由を投げ、一覧を変えない', async () => {
    const sc = new SunContext(fakeViewer(), { ...SITE });
    await sc.loadNeighbors('gsi');
    const ac = new AbortController();
    ac.abort(new Error('やめた'));
    await expect(sc.loadNeighbors('plateau', { signal: ac.signal })).rejects.toThrow('やめた');
    expect(sc.state.neighbors.every((b) => b.source === 'gsi')).toBe(true);
  });

  it('建設地の微調整（ピンを 2 m 北へ）で取り直しても同じキー。ring はずれ、mesh は anchor 基準のまま', async () => {
    const site = { ...SITE };
    const sc = new SunContext(fakeViewer(), site);
    await sc.loadNeighbors('plateau');
    const a0 = sc.state.neighbors[0];
    const mesh0 = a0.mesh;
    sc.state.site = { ...site, offsetN: 2 };
    await sc.loadNeighbors('plateau');
    const a1 = sc.state.neighbors[0];
    expect(sc.keyOf(a1)).toBe('plateau:bldg_A');
    expect(ringCentroid(a1.ring).n).toBeCloseTo(-17, 2);
    expect(a1.mesh).toBe(mesh0);
    expect(fake.calls[1].lat).toBeCloseTo(PIN.lat + 2 / mLat, 9);
  });
});

describe('SunContext.buildNeighbors: 実形状の配置・遮蔽物・隠し方・高さ', () => {
  it('mesh 建物は遮蔽物（userData.neighbor）に入る: 三角形 12・material 2・groups 2。真北 0° なら bbox x 15..25・z 11..19・y 0..7', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('plateau');
    expect(meshes(sc).filter((m) => m.userData.neighbor)).toHaveLength(3);
    const m = meshOf(sc, 'plateau:bldg_A');
    expect(m.geometry.getAttribute('position').count).toBe(36);
    expect((m.material as THREE.Material[]).length).toBe(2);
    expect(m.geometry.groups).toHaveLength(2);
    expect(m.geometry.groups[0]).toMatchObject({ start: 0, count: 6, materialIndex: 0 });
    expect(m.userData).toMatchObject({ neighbor: true, neighborKey: 'plateau:bldg_A', neighborId: 'plateau:bldg_A' });
    expect(m.castShadow).toBe(true);
    const bb = bboxOf(m);
    expect(bb.min.x).toBeCloseTo(15, 3);
    expect(bb.max.x).toBeCloseTo(25, 3);
    expect(bb.min.z).toBeCloseTo(11, 3);
    expect(bb.max.z).toBeCloseTo(19, 3);
    expect(bb.min.y).toBeCloseTo(0, 5);
    expect(bb.max.y).toBeCloseTo(7, 5);
    // 屋根（グループ 0）の法線は上向き、壁の法線は水平
    const nor = m.geometry.getAttribute('normal');
    expect(nor.getY(0)).toBeCloseTo(1, 5);
    expect(Math.abs(nor.getY(12))).toBeLessThan(1e-5);
    // 遮蔽物: 全体 − A を除外した分 = 12 三角形
    const all = buildOccluder(v).triangles;
    sc.setHidden(['plateau:bldg_A'], true, { mode: 'exclude', reason: 'demolish' });
    expect(all - buildOccluder(v).triangles).toBe(12);
    expect(meshes(sc).some((x) => x.userData.neighborKey === 'plateau:bldg_A')).toBe(false);
    // 表示だけ隠す: 影だけのメッシュ（同じ形）で遮蔽物に残る。薄い表示は輪郭の線付き
    sc.setHideMode(['plateau:bldg_A'], 'view');
    expect(buildOccluder(v).triangles).toBe(all);
    const shadow = meshes(sc).find((x) => x.userData.neighborKey === 'plateau:bldg_A')!;
    expect(shadow.userData.shadowOnly).toBe(true);
    expect(shadow.geometry.getAttribute('position').count).toBe(36);
    sc.setGhosts(true);
    const ghost = (sc.ghostGroup.children as THREE.Mesh[]).find((x) => x.userData.neighborKey === 'plateau:bldg_A')!;
    expect(ghost.userData.neighbor).toBeUndefined();
    expect(ghost.children.some((c) => (c as THREE.LineSegments).isLineSegments)).toBe(true);
    expect(bboxOf(ghost).max.y).toBeCloseTo(7, 5);
    sc.setGhosts(false);
    sc.setHidden(['plateau:bldg_A'], false);
    expect(buildOccluder(v).triangles).toBe(all);
  });

  it('高さを直すと足元を固定して縦に伸びる（heightScale）。元に戻せる。足元の面積は変わらない', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('plateau');
    const key = 'plateau:bldg_A';
    sc.setHeight(key, 14);
    let bb = bboxOf(meshOf(sc, key));
    expect(bb.max.y).toBeCloseTo(14, 5);
    expect(bb.min.y).toBeCloseTo(0, 5);
    expect(bb.min.x).toBeCloseTo(15, 3);
    expect(sc.heightOf(sc.state.neighbors[0])).toBe(14);
    expect(sc.state.neighbors[0].height).toBe(7);
    sc.setHeight(key, null);
    bb = bboxOf(meshOf(sc, key));
    expect(bb.max.y).toBeCloseTo(7, 5);
  });

  it('真北を 30° 回しても、ring の重心（toWorld）と mesh の bbox 中心が ±0.1 m で一致する', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('plateau');
    for (const deg of [30, -75, 180]) {
      (v.state!.model as { northAngleDeg: number }).northAngleDeg = deg;
      sc.buildNeighbors();
      for (const b of sc.state.neighbors.filter((x) => x.mesh)) {
        const c = ringCentroid(b.ring);
        const w = sc.toWorld(c.e, c.n, 0);
        const bb = bboxOf(meshOf(sc, sc.keyOf(b)));
        const mc = bb.getCenter(new THREE.Vector3());
        expect(Math.hypot(mc.x - w.x, mc.z - w.z)).toBeLessThan(0.1);
        // 建物の幅（x 方向の広がり）は回転で変わる = 本当に回っている
        if (deg === 30) expect(bb.max.x - bb.min.x).toBeGreaterThan(10.5);
      }
    }
    // 回した状態で pickNeighbor（真上からのクリック）も当たる
    const b = sc.state.neighbors[1];
    const c = ringCentroid(b.ring);
    const p = sc.toWorld(c.e, c.n, sc.heightOf(b)).project(v.camera);
    expect(sc.pickNeighbor(new THREE.Vector2(p.x, p.y))).toEqual({ key: 'plateau:bldg_B', hidden: false });
  });

  it('航空写真があれば屋根に写真の UV（0..1 の範囲）', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('plateau');
    // loadAerial は DOM（canvas）が要るので、写真の範囲だけ入れる
    (sc as unknown as { aerialInfo: unknown }).aerialInfo = { west: -220, east: 220, south: -220, north: 220, tex: new THREE.Texture() };
    sc.buildNeighbors();
    const m = meshOf(sc, 'plateau:bldg_A');
    const uv = m.geometry.getAttribute('uv');
    expect(uv).toBeTruthy();
    // 屋根の頂点（東 15..25・北 −19..−11）→ u = (e + 220) / 440 ≈ 0.534〜0.557、v ≈ 0.457〜0.475
    for (let i = 0; i < 6; i++) {
      expect(uv.getX(i)).toBeGreaterThan(0.53);
      expect(uv.getX(i)).toBeLessThan(0.56);
      expect(uv.getY(i)).toBeGreaterThan(0.45);
      expect(uv.getY(i)).toBeLessThan(0.48);
    }
  });
});

describe('国土地理院で隠した・直した記録は、外形の照合で PLATEAU の同じ建物に引き継がれる', () => {
  it('国土地理院で A と同じ足元の建物を隠し高さを直す → PLATEAU に切り替えると plateau:bldg_A が隠れたまま・高さも残る。B には移らない', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('gsi');
    const g = sc.state.neighbors.find((b) => Math.abs(ringCentroid(b.ring).e - 20) < 0.5)!;
    const kg = sc.keyOf(g);
    expect(kg).toMatch(/^gsi:/);
    sc.setHidden([kg], true, { mode: 'view', reason: 'other', note: '視点を遮る' });
    sc.setHeight(kg, 11.5);
    const r = await sc.loadNeighbors('plateau');
    expect(r.used).toEqual(['plateau', 'gsi']);
    const a = sc.state.neighbors.find((b) => sc.keyOf(b) === 'plateau:bldg_A')!;
    expect(a.hidden).toBe(true);
    expect(sc.hideRecord('plateau:bldg_A')).toEqual({ mode: 'view', reason: 'other', note: '視点を遮る' });
    expect(sc.heightOf(a)).toBe(11.5);
    expect(sc.hiddenList().map((b) => sc.keyOf(b))).toEqual(['plateau:bldg_A']);
    expect(sc.edits.hidden.has(kg)).toBe(false);
    expect(sc.state.neighbors.find((b) => sc.keyOf(b) === 'plateau:bldg_B')!.hidden).toBeFalsy();
    // 影だけのメッシュ（表示だけ隠す）は実形状
    const shadow = meshes(sc).find((m) => m.userData.neighborKey === 'plateau:bldg_A')!;
    expect(shadow.userData.shadowOnly).toBe(true);
    expect(bboxOf(shadow).max.y).toBeCloseTo(11.5, 5);
    // PLATEAU → PLATEAU の取り直し（ピン移動）でも gml_id で残る
    sc.state.site = { ...SITE, offsetE: 3 };
    await sc.loadNeighbors('plateau');
    expect(sc.hiddenList().map((b) => sc.keyOf(b))).toEqual(['plateau:bldg_A']);
    expect(sc.restoreAll()).toBe(1);
    sc.clearNeighbors();
    expect(sc.state.neighbors).toEqual([]);
    expect(sc.edits.heights.size).toBe(0);
  });
});

describe('開示・文言', () => {
  it('collectDisclosure.sources: 出典の行（PLATEAU のデータセット・国土地理院（推定））と共通の開示文。rooms/heatmap/deck/diagram の注記に出る', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('plateau');
    let d = collectDisclosure(sc);
    expect(d.included).toBe(3);
    expect(d.sources).toEqual([
      '周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）2 棟・国土地理院（推定）1 棟',
      '周辺建物の形状・高さ: 国土交通省 PLATEAU 3D都市モデル（世田谷区・2025年度・LOD2）。年度以降の新築・解体は反映されていない場合があります。',
    ]);
    for (const t of ['rooms', 'heatmap', 'deck', 'diagram'] as const) {
      const lines = disclosureLines(d, t);
      expect(lines[1]).toBe(d.sources![0]);
      expect(lines[2]).toBe(d.sources![1]);
      expect(lines[3]).toBe('計算から除外した周辺建物 なし');
    }
    // 除外した建物は出典の行に数えない。LOD1 のデータセットなら箱形の但し書き
    sc.setHidden(['plateau:bldg_A'], true, { mode: 'exclude', reason: 'demolish' });
    d = collectDisclosure(sc);
    expect(d.sources![0]).toBe('周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）1 棟・国土地理院（推定）1 棟');
    const lod1 = sourceLines([{ source: 'plateau', heightKind: 'measured', plateau: { ...boxA().attrs, datasetLod: 1 } }]);
    expect(lod1).toEqual([
      '周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD1）1 棟',
      '周辺建物の形状・高さ: 国土交通省 PLATEAU 3D都市モデル（世田谷区・2025年度・LOD1）。LOD1 の建物は箱形で天端は点群の中央値（最高高さは建物クリックで確認・適用できます）。年度以降の新築・解体は反映されていない場合があります。',
    ]);
    // 区境で 2 データセット・手入力の隣家・想定の家は出典に数えない
    const two = sourceLines([
      { source: 'plateau', plateau: boxA().attrs },
      { source: 'plateau', plateau: { ...boxB().attrs, muniCd: '13111', city: '大田区', year: 2023, datasetLod: 1 } },
      { source: 'manual' },
      { source: 'manual', planned: { id: 'p' } as never },
      { source: 'osm', heightKind: 'measured' },
    ]);
    expect(two[0]).toBe('周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2／大田区・2023年度・LOD1）2 棟・OpenStreetMap 1 棟・手入力 1 棟');
    expect(sourceLines([])).toEqual([]);
    expect(collectDisclosure(null).sources).toBeUndefined();
  });

  it('表の高さの括弧: PLATEAU は無し、国土地理院は（推定）、手入力の隣家は（手入力）、直した高さは（手入力）', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('plateau');
    sc.addManualNeighbor(180, 30, 8, 8, 7);
    const keys = sc.state.neighbors.map((b) => sc.keyOf(b));
    sc.setHidden(keys, true, { mode: 'exclude', reason: 'other', note: '試験' });
    const d = collectDisclosure(sc);
    expect(d.included).toBe(0);
    expect(d.sources).toBeUndefined();
    expect(d.excluded.map((e) => e.heightKind)).toEqual(['measured', 'measured', 'estimated', 'manual']);
    const rows = excludedTableRows(d);
    expect(rows.map((r) => r.height)).toEqual(['7.0 m', '9.0 m', '6.8 m（推定）', '7.0 m（手入力）']);
    expect(rows[0].source).toBe('PLATEAU（国土交通省）');
    expect(rows[1].source).toBe('PLATEAU（国土交通省）（共同住宅）');
    expect(rows[2].source).toBe('国土地理院');
    // 古い写し（heightKind 無し）は出典から判断
    expect(excludedTableRows({ excluded: [{ ...d.excluded[2], heightKind: undefined }] })[0].height).toBe('6.8 m（推定）');
    expect(excludedTableRows({ excluded: [{ ...d.excluded[0], heightKind: undefined }] })[0].height).toBe('7.0 m');
    expect(heightKindSuffix('measured')).toBe('');
    expect(heightKindSuffix('estimated')).toBe('（推定）');
    expect(heightKindSuffix('manual')).toBe('（手入力）');
  });

  it('案内: 取得後のトースト・建物の案内の出典の行・ボタン・説明', async () => {
    const sc = new SunContext(fakeViewer(), { ...SITE });
    const r = await sc.loadNeighbors('plateau');
    expect(neighborsLoadedToast(r)).toBe('周辺の建物を 3 棟取得しました（PLATEAU 2025年度・世田谷区・屋根形状あり 1 棟・国土地理院で補完）');
    expect(neighborsLoadedToast({ ...r, used: ['plateau'], count: 2 }, 1)).toBe('周辺の建物を 2 棟取得しました（PLATEAU 2025年度・世田谷区・屋根形状あり 1 棟）（隠した 1 棟は隠したままです）');
    expect(neighborsLoadedToast({ count: 4, used: ['gsi'], notes: [NOTE_PLATEAU_MISSING], plateau: { datasets: [], lodCounts: {}, status: 'none' } })).toBe('この地域は PLATEAU 未整備のため国土地理院の建物（高さは推定）を使いました（4 棟）');
    expect(neighborsLoadedToast({ count: 4, used: ['osm'], notes: [NOTE_PLATEAU_ERROR], plateau: { datasets: [], lodCounts: {}, status: 'error' } })).toBe('PLATEAU のデータを取得できなかったため（通信エラー）OpenStreetMap の建物を使いました（4 棟）');
    expect(neighborsLoadedToast({ count: 4, used: ['gsi'], notes: [] })).toBe('周辺の建物を 4 棟取得しました（国土地理院の建物（高さは推定））');
    const [a, b, g] = sc.state.neighbors;
    expect(neighborSourceLine(a)).toBe('出典: PLATEAU（国土交通省）（2025年度・LOD1）');
    expect(neighborSourceLine(b)).toBe('出典: PLATEAU（国土交通省）（2025年度・LOD2） 実測の最高高さ 9.8 m');
    expect(neighborSourceLine(g)).toBe('出典: 国土地理院（高さは建物の種類からの推定）');
    expect(neighborSourceLine({ source: 'osm' })).toBe('出典: OpenStreetMap');
    expect(neighborSourceLine({ source: 'manual' })).toBe('出典: 手動で追加');
    expect(NEIGHBOR_SOURCE_BUTTON.plateau).toBe('🏘 周辺建物（PLATEAU）');
    expect(NO_NEIGHBORS_MSG).toContain('🏘 周辺建物（PLATEAU）');
    expect(NEIGHBORS_HINT).toContain('地盤の高低差は表現しません');
    expect(NEIGHBORS_HINT).toMatch(/LOD1 は箱形、LOD2 は屋根形状/);
    expect(NEIGHBORS_HINT).toMatch(/普通建物 約7m/);
  });
});
