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
  /** 応答が返らない（無応答）を再現する。signal の中止では reject する（本物の fetch と同じ） */
  hang: { gsi: false, osm: false },
  plateau: null as PlateauFetchResult | null,
  calls: [] as { lat: number; lon: number; radius: number }[],
  /** fetchPlateauBuildings の呼び出し n 番目（0 始まり）が返るまでの遅延 ms（同時実行の順序を作る） */
  delays: [] as number[],
}));
/** 中止で reject する「返らない」Promise */
const never = <T,>(signal?: AbortSignal) =>
  new Promise<T>((_, reject) => {
    if (signal?.aborted) reject(signal.reason ?? new Error('中止'));
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('中止')), { once: true });
  });
vi.mock('../src/sun/geo', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/sun/geo')>();
  const make = (src: 'gsi' | 'osm') => async (lat: number, lon: number, _radius?: number, opts?: { signal?: AbortSignal }): Promise<NeighborBuilding[]> => {
    if (fake.hang[src]) return never<NeighborBuilding[]>(opts?.signal);
    if (src === 'gsi' ? fake.gsiFail : fake.osmFail) throw new Error(`${src} に接続できません`);
    return fake[src].map((f) => ({ ring: f.ll.map((p) => mod.toLocal(p.lat, p.lon, lat, lon)), height: f.height, source: src }));
  };
  return { ...mod, fetchGsiBuildings: vi.fn(make('gsi')), fetchOsmBuildings: vi.fn(make('osm')) };
});
vi.mock('../src/sun/plateau/fetch', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/sun/plateau/fetch')>();
  const fetchPlateauBuildings = vi.fn(async (lat: number, lon: number, radius: number, opts?: { signal?: AbortSignal; onProgress?: (p: PlateauProgress) => void }): Promise<PlateauFetchResult> => {
    const i = fake.calls.length;
    fake.calls.push({ lat, lon, radius });
    if (opts?.signal?.aborted) throw opts.signal.reason ?? new Error('中止');
    const delay = fake.delays[i] ?? 0;
    if (delay > 0) {
      // 遅延中の中止も本物と同じく signal.reason で reject
      await Promise.race([new Promise((r) => setTimeout(r, delay)), never(opts?.signal)]);
    }
    opts?.onProgress?.({ stage: 'tiles', message: '建物タイル 1/2（1.0 MB）', done: 1, total: 2, bytes: 1e6, totalBytes: null, ratio: 0.5 });
    if (!fake.plateau) throw new Error('fake.plateau が未設定');
    return fake.plateau;
  });
  return { ...mod, fetchPlateauBuildings };
});

import { NEIGHBOR_FILL_TIMEOUT_MS, NEIGHBOR_RADIUS_M, NOTE_PLATEAU_ERROR, NOTE_PLATEAU_MISSING, SunContext, countPlateauShapes, isAbortError, neighborKey, plateauCoveredNotes, plateauProgressText, plateauRegionAddedNote, plateauToNeighborBuilding, ringCentroid, roofShapeCount, supersededError, waitWithLimit } from '../src/sun/context';
import { buildOccluder } from '../src/sun/analysis';
import { LOD1_BOX_NOTE, collectDisclosure, disclosureLines, excludedTableRows, heightKindOf, heightKindSuffix, isPlateauBox, plateauShapeCounts, sourceLines } from '../src/app/sunDisclosure';
import { NEIGHBORS_HINT, NEIGHBOR_SOURCE_BUTTON, NO_NEIGHBORS_MSG, neighborSourceLine, neighborsLoadedToast, reloadSurroundings, type SurroundingsDeps } from '../src/app/steps/sunStep';
import { fetchPlateauBuildings } from '../src/sun/plateau/fetch';
import { fetchGsiBuildings, fetchOsmBuildings } from '../src/sun/geo';
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
  fake.delays = [];
  fake.gsiFail = false;
  fake.osmFail = false;
  fake.hang = { gsi: false, osm: false };
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
  it('市区町村コードの改編の救済（regionAdded）の注記: データセット名で示し、使えなかった市区は市区町村コードで示す', () => {
    const r = covered();
    // 浜松市 2024: 逆ジオコーダは 22138、索引は旧 22131〜22137。region で足した市区のデータセット名を出し、missingMuniCds は空なので未整備の行は出ない
    const hamamatsu: PlateauDatasetInfo = { ...DATASET, muniCd: '22131', pref: '静岡県', city: '浜松市', ward: '中区', year: 2023, lod: 1, label: '静岡県浜松市中区・2023年度・LOD1' };
    expect(plateauCoveredNotes({ ...r, datasets: [hamamatsu], missingMuniCds: [], regionAdded: ['22131'] }, 0)).toEqual(['市区町村コードの改編のため、位置の重なる PLATEAU（静岡県浜松市中区・2023年度・LOD1）で補いました。']);
    // 足した市区の tileset が取れずに datasets から落ちたときは名前が分からないので市区町村コードで示す。区境で足したデータセットは「／」でつなぐ
    expect(plateauRegionAddedNote([hamamatsu], ['22131', '22132'])).toBe('市区町村コードの改編のため、位置の重なる PLATEAU（静岡県浜松市中区・2023年度・LOD1／市区町村コード 22132）で補いました。');
    // regionAdded が無い（旧い結果・空）なら行は出ない
    expect(plateauCoveredNotes({ ...r, regionAdded: [] }, 0)).toEqual([]);
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
    expect(r.plateau).toEqual({ datasets: [DATASET], lodCounts: { '1': 1, '2': 1 }, status: 'covered', shapes: { box: 1, roof: 1, unknown: 0 } });
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
    expect(r.plateau).toEqual({ datasets: [], lodCounts: {}, status: 'none', shapes: { box: 0, roof: 0, unknown: 0 } });
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

describe('SunContext.loadNeighbors: 同時実行（微調整の連打）は後に始めた方が勝つ', () => {
  it('先に始めた（古いピン）取得が後から終わっても、一覧・neighborsOrigin・lastLoad は後に始めた方（今のピン）。古い方は AbortError で抜ける', async () => {
    // 1 回目（ピン原点）は 60 ms、2 回目（北へ 2 m）は 5 ms で終わる = 古い方が後に終わる
    fake.delays = [60, 5];
    const site = { ...SITE };
    const sc = new SunContext(fakeViewer(), site);
    const p1 = sc.loadNeighbors('plateau');
    sc.state.site = { ...site, offsetN: 2 };
    const p2 = sc.loadNeighbors('plateau');
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    expect(r1.status).toBe('rejected');
    expect(isAbortError((r1 as PromiseRejectedResult).reason)).toBe(true);
    expect((r1 as PromiseRejectedResult).reason.message).toBe('新しい取得で置き換えました');
    expect(r2.status).toBe('fulfilled');
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].lat).toBeCloseTo(PIN.lat + 2 / mLat, 9);
    // ring は今のピン（北へ 2 m）基準: A の重心 n = −15 − 2 = −17
    const a = sc.state.neighbors.find((b) => b.plateau?.gmlId === 'bldg_A')!;
    expect(ringCentroid(a.ring).n).toBeCloseTo(-17, 2);
    const origin = (sc as unknown as { neighborsOrigin: LL }).neighborsOrigin;
    expect(origin.lat).toBeCloseTo(PIN.lat + 2 / mLat, 12);
    expect(sc.lastLoad).toBe((r2 as PromiseFulfilledResult<unknown>).value);
    expect(sc.lastSource).toBe('plateau');
    // 一覧は 1 回分だけ（古い結果が混ざらない）
    expect(sc.state.neighbors.filter((b) => b.source !== 'manual')).toHaveLength(3);
  });

  it('後の取得が失敗しても、古い取得の結果で一覧を上書きしない（一覧は前の状態のまま）', async () => {
    const site = { ...SITE };
    const sc = new SunContext(fakeViewer(), site);
    await sc.loadNeighbors('gsi');
    const before = sc.state.neighbors;
    fake.delays = [40, 0];
    const p1 = sc.loadNeighbors('plateau');
    // 2 回目はすべて失敗
    fake.plateau = { status: 'error', stage: 'tileset', message: 'x' };
    fake.gsiFail = true;
    fake.osmFail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const p2 = sc.loadNeighbors('plateau');
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    warn.mockRestore();
    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');
    expect(sc.state.neighbors).toBe(before);
  });

  it('isAbortError / supersededError: 進捗モーダルの中止（DOMException AbortError）と置き換えを区別できる', () => {
    expect(isAbortError(supersededError())).toBe(true);
    expect(supersededError().name).toBe('AbortError');
    const ac = new AbortController();
    ac.abort();
    expect(isAbortError(ac.signal.reason)).toBe(true);
    expect(isAbortError(new Error('やめた'))).toBe(false);
    expect(isAbortError('x')).toBe(false);
  });
});

describe('SunContext.loadNeighbors: 国土地理院の補完・退路の待ちに上限と中止', () => {
  it('PLATEAU が covered で国土地理院が無応答でも、上限（fillTimeoutMs）で打ち切って PLATEAU だけで返す。既定の上限は 10 s', async () => {
    fake.hang.gsi = true;
    const sc = new SunContext(fakeViewer(), { ...SITE });
    const t0 = Date.now();
    const r = await sc.loadNeighbors('plateau', { fillTimeoutMs: 30 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.used).toEqual(['plateau']);
    expect(r.count).toBe(2);
    expect(r.notes).toEqual([]);
    expect(NEIGHBOR_FILL_TIMEOUT_MS).toBe(10_000);
  });

  it('国土地理院の補完を待っている間の中止は signal.reason を投げ、一覧を変えない。fetchGsiBuildings / fetchOsmBuildings に signal を渡す', async () => {
    const sc = new SunContext(fakeViewer(), { ...SITE });
    await sc.loadNeighbors('gsi');
    const before = sc.state.neighbors;
    vi.mocked(fetchGsiBuildings).mockClear();
    fake.hang.gsi = true;
    const ac = new AbortController();
    const p = sc.loadNeighbors('plateau', { signal: ac.signal });
    // PLATEAU（即応）は終わり、国土地理院の補完を待っている
    await new Promise((r) => setTimeout(r, 20));
    ac.abort(new Error('やめた'));
    await expect(p).rejects.toThrow('やめた');
    expect(sc.state.neighbors).toBe(before);
    expect(fetchGsiBuildings).toHaveBeenCalledWith(PIN.lat, PIN.lon, 110, { signal: ac.signal });
    // 退路（PLATEAU 未整備 → 国土地理院が空 → OSM）でも signal が下層まで届く
    fake.hang.gsi = false;
    fake.gsi = [];
    fake.plateau = { status: 'none', reason: 'outside', muniCds: ['11201'] };
    const ac2 = new AbortController();
    const sc2 = new SunContext(fakeViewer(), { ...SITE });
    await sc2.loadNeighbors('plateau', { signal: ac2.signal });
    expect(fetchOsmBuildings).toHaveBeenLastCalledWith(PIN.lat, PIN.lon, 110, { signal: ac2.signal });
  });

  it('退路（国土地理院 → OSM）も同じ上限: 国土地理院が無応答なら OSM へ。両方無応答なら時間切れの失敗', async () => {
    fake.plateau = { status: 'none', reason: 'outside', muniCds: ['11201'] };
    fake.hang.gsi = true;
    let sc = new SunContext(fakeViewer(), { ...SITE });
    const r = await sc.loadNeighbors('plateau', { fillTimeoutMs: 30 });
    expect(r.used).toEqual(['osm']);
    expect(r.notes).toEqual([NOTE_PLATEAU_MISSING]);
    fake.hang.osm = true;
    sc = new SunContext(fakeViewer(), { ...SITE });
    await expect(sc.loadNeighbors('gsi', { fillTimeoutMs: 30 })).rejects.toThrow(/応答がありません（時間切れ）/);
    expect(sc.state.neighbors).toEqual([]);
  });

  it('waitWithLimit: 値・時間切れ・中止・失敗', async () => {
    expect(await waitWithLimit(Promise.resolve(1), 50, undefined, () => 0)).toBe(1);
    expect(await waitWithLimit(new Promise<number>(() => {}), 10, undefined, () => 0)).toBe(0);
    await expect(
      waitWithLimit(new Promise<number>(() => {}), 10, undefined, () => {
        throw new Error('時間切れ');
      }),
    ).rejects.toThrow('時間切れ');
    await expect(waitWithLimit(Promise.reject(new Error('落ちた')), 50, undefined, () => 0)).rejects.toThrow('落ちた');
    const ac = new AbortController();
    const p = waitWithLimit(new Promise<number>(() => {}), 1000, ac.signal, () => 0);
    ac.abort(new Error('やめた'));
    await expect(p).rejects.toThrow('やめた');
    const done = new AbortController();
    done.abort(new Error('先に中止'));
    await expect(waitWithLimit(Promise.resolve(1), 50, done.signal, () => 0)).rejects.toThrow('先に中止');
  });
});

describe('sunStep.reloadSurroundings: 建設地を変えた後の読み直しは周辺建物の取得を 1 回だけ', () => {
  const deps = (aerialLoaded: boolean, hasAuto: boolean) => {
    const log: string[] = [];
    const d: SurroundingsDeps = {
      aerialLoaded: () => aerialLoaded,
      hasAutoNeighbors: () => hasAuto,
      lastSource: () => 'plateau',
      rebuild: () => log.push('rebuild'),
      loadAerial: async () => {
        log.push('aerial');
        aerialLoaded = true;
      },
      loadNeighbors: async (src) => {
        log.push(`neighbors:${src}`);
        hasAuto = true;
      },
    };
    return { d, log };
  };
  it("'newSite'（住所検索・座標の指定）: 周辺建物が既にあっても取得は 1 回（航空写真は無ければ読み込み、あれば取り直し）", async () => {
    let t = deps(true, true);
    await reloadSurroundings(t.d, 'newSite');
    expect(t.log).toEqual(['rebuild', 'aerial', 'neighbors:plateau']);
    t = deps(false, false);
    await reloadSurroundings(t.d, 'newSite');
    expect(t.log).toEqual(['rebuild', 'aerial', 'neighbors:plateau']);
  });
  it("'adjust'（微調整・敷地をクリック・2 点合わせ）: 自動取得の周辺建物があるときだけ取り直し、航空写真は読み込み済みのときだけ", async () => {
    let t = deps(true, true);
    await reloadSurroundings(t.d, 'adjust');
    expect(t.log).toEqual(['rebuild', 'aerial', 'neighbors:plateau']);
    t = deps(false, false);
    await reloadSurroundings(t.d, 'adjust');
    expect(t.log).toEqual(['rebuild']);
    t = deps(true, false);
    await reloadSurroundings(t.d, 'adjust');
    expect(t.log).toEqual(['rebuild', 'aerial']);
  });
  it('最後に選んだ取得元で取り直す', async () => {
    const t = deps(false, true);
    t.d.lastSource = () => 'gsi';
    await reloadSurroundings(t.d, 'adjust');
    expect(t.log).toEqual(['rebuild', 'neighbors:gsi']);
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

describe('取得後のトーストの内訳は一覧に残った建物で数える（取得全棟の lodCounts ではない）', () => {
  it('敷地に重なる LOD2 の 1 棟が除外されたとき、トーストの「屋根形状あり」の数 = 出典行の数（lodCounts の 2 棟ではなく 1 棟）', async () => {
    // C = 屋根形状（LOD2）6×6×8、足元の中心がピン（敷地の中。建て替え前の既存建物）→ inSite で除外される
    const boxC = plateauBox({ gmlId: 'bldg_C', anchor: ll(0, 0), w: 6, d: 6, h: 8, zmin: 40, attrs: { ...dsAttrs(), lod: 2 } });
    fake.plateau = { ...covered(), buildings: [boxA(), boxB(), boxC], lodCounts: { '1': 1, '2': 2 } };
    const sc = new SunContext(fakeViewer(), { ...SITE });
    const r = await sc.loadNeighbors('plateau');
    // 一覧: A（箱形）・B（屋根形状）・国土地理院 1 棟。C は敷地に重なるので無い
    expect(sc.state.neighbors.map((b) => b.id)).toEqual(['plateau:bldg_A', 'plateau:bldg_B', 'gsi-1']);
    expect(r.count).toBe(3);
    // lodCounts は取得全棟（C を含む）、shapes は残った建物
    expect(r.plateau?.lodCounts).toEqual({ '1': 1, '2': 2 });
    expect(roofShapeCount(r.plateau!.lodCounts)).toBe(2);
    expect(r.plateau?.shapes).toEqual({ box: 1, roof: 1, unknown: 0 });
    // トーストは出典行（sunDisclosure.plateauShapeCounts で数える）と同じ 1 棟
    const toastText = neighborsLoadedToast(r);
    expect(toastText).toBe('周辺の建物を 3 棟取得しました（PLATEAU 2025年度・世田谷区・屋根形状あり 1 棟・国土地理院で補完）');
    const d = collectDisclosure(sc);
    expect(d.sources?.[0]).toBe('周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）2 棟（箱形 1 棟・屋根形状あり 1 棟）・国土地理院（推定）1 棟');
    const roofInToast = Number(/屋根形状あり (\d+) 棟/.exec(toastText)![1]);
    const roofInSource = Number(/屋根形状あり (\d+) 棟/.exec(d.sources![0])![1]);
    expect(roofInToast).toBe(roofInSource);
    expect(roofInToast).toBe(1);
  });

  it('countPlateauShapes は sunDisclosure.plateauShapeCounts と同じ規則（建物の _lod、無ければデータセットの LOD。属性無しは unknown。PLATEAU 以外は数えない）', () => {
    const list: Pick<NeighborBuilding, 'source' | 'plateau'>[] = [
      { source: 'plateau', plateau: { ...boxA().attrs, lod: 1, datasetLod: 2 } },
      { source: 'plateau', plateau: { ...boxB().attrs, lod: 2, datasetLod: 1 } },
      { source: 'plateau', plateau: { ...boxA().attrs, lod: null, datasetLod: 1 } },
      { source: 'plateau', plateau: { ...boxA().attrs, lod: null, datasetLod: 2 } },
      { source: 'plateau', plateau: undefined },
      { source: 'gsi', plateau: undefined },
    ];
    const expected = { box: 2, roof: 2, unknown: 1 };
    expect(countPlateauShapes(list)).toEqual(expected);
    expect(plateauShapeCounts(list)).toEqual(expected);
    expect(countPlateauShapes([])).toEqual({ box: 0, roof: 0, unknown: 0 });
  });
});

describe('開示・文言', () => {
  it('collectDisclosure.sources: 出典の行（PLATEAU のデータセット・国土地理院（推定））と共通の開示文。rooms/heatmap/deck/diagram の注記に出る', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('plateau');
    let d = collectDisclosure(sc);
    expect(d.included).toBe(3);
    // データセットは LOD2 でも A は _lod=1 の箱形 → 出典行に建物単位の内訳、開示文に LOD1 の但し書き（23 区 2025 年版は住宅がほぼ全棟 _lod=1）
    expect(d.sources).toEqual([
      '周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）2 棟（箱形 1 棟・屋根形状あり 1 棟）・国土地理院（推定）1 棟',
      `周辺建物の形状・高さ: 国土交通省 PLATEAU 3D都市モデル（世田谷区・2025年度・LOD2）。${LOD1_BOX_NOTE}年度以降の新築・解体は反映されていない場合があります。`,
    ]);
    for (const t of ['rooms', 'heatmap', 'deck', 'diagram'] as const) {
      const lines = disclosureLines(d, t);
      expect(lines[1]).toBe(d.sources![0]);
      expect(lines[2]).toBe(d.sources![1]);
      expect(lines[3]).toBe('計算から除外した周辺建物 なし');
    }
    // 除外した建物は出典の行に数えない（内訳も残った建物で数える）。箱形の A を除くと屋根形状の B だけ → 但し書きは消える
    sc.setHidden(['plateau:bldg_A'], true, { mode: 'exclude', reason: 'demolish' });
    d = collectDisclosure(sc);
    expect(d.sources).toEqual([
      '周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）1 棟（箱形 0 棟・屋根形状あり 1 棟）・国土地理院（推定）1 棟',
      '周辺建物の形状・高さ: 国土交通省 PLATEAU 3D都市モデル（世田谷区・2025年度・LOD2）。年度以降の新築・解体は反映されていない場合があります。',
    ]);
    // LOD1 のデータセット（建物の _lod 無し）でも但し書き
    const lod1 = sourceLines([{ source: 'plateau', heightKind: 'measured', plateau: { ...boxA().attrs, lod: null, datasetLod: 1 } }]);
    expect(lod1).toEqual([
      '周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD1）1 棟（箱形 1 棟・屋根形状あり 0 棟）',
      `周辺建物の形状・高さ: 国土交通省 PLATEAU 3D都市モデル（世田谷区・2025年度・LOD1）。${LOD1_BOX_NOTE}年度以降の新築・解体は反映されていない場合があります。`,
    ]);
    // 23 区 2025 年版の形: データセット LOD2・全棟 _lod=1 → 但し書きあり、内訳は箱形だけ
    const tokyo = sourceLines([
      { source: 'plateau', plateau: boxA().attrs },
      { source: 'plateau', plateau: { ...boxB().attrs, lod: 1 } },
    ]);
    expect(tokyo[0]).toBe('周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）2 棟（箱形 2 棟・屋根形状あり 0 棟）');
    expect(tokyo[1]).toContain(LOD1_BOX_NOTE);
    // 属性の無い旧データ（形が分からない）は安全側で但し書きを出し、内訳は添えない
    const legacy = sourceLines([{ source: 'plateau', heightKind: 'measured' }]);
    expect(legacy[0]).toBe('周辺建物の出典: PLATEAU（国土交通省）1 棟');
    expect(legacy[1]).toContain(LOD1_BOX_NOTE);
    expect(isPlateauBox({ lod: 1, datasetLod: 2 })).toBe(true);
    expect(isPlateauBox({ lod: 2, datasetLod: 1 })).toBe(false);
    expect(isPlateauBox({ lod: null, datasetLod: 1 })).toBe(true);
    expect(isPlateauBox({ lod: null, datasetLod: 2 })).toBe(false);
    expect(plateauShapeCounts([{ source: 'plateau', plateau: boxA().attrs }, { source: 'plateau', plateau: boxB().attrs }, { source: 'plateau' }, { source: 'gsi' }])).toEqual({ box: 1, roof: 1, unknown: 1 });
    // 区境で 2 データセット・手入力の隣家・想定の家は出典に数えない
    const two = sourceLines([
      { source: 'plateau', plateau: boxA().attrs },
      { source: 'plateau', plateau: { ...boxB().attrs, muniCd: '13111', city: '大田区', year: 2023, datasetLod: 1 } },
      { source: 'manual' },
      { source: 'manual', planned: { id: 'p' } as never },
      { source: 'osm', heightKind: 'measured' },
    ]);
    expect(two[0]).toBe('周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2／大田区・2023年度・LOD1）2 棟（箱形 1 棟・屋根形状あり 1 棟）・OpenStreetMap 1 棟・手入力 1 棟');
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
    expect(neighborsLoadedToast({ count: 4, used: ['gsi'], notes: [NOTE_PLATEAU_MISSING], plateau: { datasets: [], lodCounts: {}, status: 'none', shapes: { box: 0, roof: 0, unknown: 0 } } })).toBe('この地域は PLATEAU 未整備のため国土地理院の建物（高さは推定）を使いました（4 棟）');
    expect(neighborsLoadedToast({ count: 4, used: ['osm'], notes: [NOTE_PLATEAU_ERROR], plateau: { datasets: [], lodCounts: {}, status: 'error', shapes: { box: 0, roof: 0, unknown: 0 } } })).toBe('PLATEAU のデータを取得できなかったため（通信エラー）OpenStreetMap の建物を使いました（4 棟）');
    expect(neighborsLoadedToast({ count: 4, used: ['gsi'], notes: [] })).toBe('周辺の建物を 4 棟取得しました（国土地理院の建物（高さは推定））');
    // 内訳は一覧に残った建物（shapes）で数える: 取得全棟の lodCounts が屋根形状 5 棟でも、残ったのが 1 棟ならトーストは 1 棟
    expect(neighborsLoadedToast({ ...r, used: ['plateau'], count: 2, plateau: { ...r.plateau!, lodCounts: { '1': 1, '2': 5 } } })).toBe('周辺の建物を 2 棟取得しました（PLATEAU 2025年度・世田谷区・屋根形状あり 1 棟）');
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
