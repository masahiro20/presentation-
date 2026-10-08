/**
 * 周辺環境の読み込みと 3D への反映（地形・航空写真・周辺建物）
 *
 * loadEnvironment(): ピン位置を中心に DEM・航空写真・周辺建物を並行取得して state に入れる
 * rebuildEnvironment(): state からシーンの terrain / neighbors / site グループを作り直す
 *
 * 周辺建物の隠し方（state.ts）:
 *  - 隠していない建物: groups.neighbors に描く（影を落とす・受ける、解析の遮蔽物）
 *  - 表示だけ隠した建物（hideMode 'view'）: groups.neighbors に影だけのメッシュ（色も深度も書かない・castShadow）を入れる。
 *    画面には描かないが、実時間の影と解析（groups.neighbors を表示に関わらず焼き込む）には残る
 *  - 計算から除外した建物（hideMode 'exclude'）: 何も作らない（選んで隠すモードの半透明の表示は groups.select で、影・解析の外）
 */
import * as THREE from 'three';
import { polygonArea } from '../sun/align';
import { fetchAerial } from '../sun/geo';
import { buildNeighborMeshes, excludeOverlapping, fetchNeighbors } from './neighbors';
import type { StudyScene } from './scene';
import { clearGroup } from './scene';
import { analysisNeighbors, emit, hiddenNeighbors, study, viewOnlyNeighbors, visibleNeighbors } from './state';
import { buildTerrainMesh, fetchHeightGrid, fetchHorizonProfile, flatGrid, minHeightInRing, sampleHeight } from './terrain';
import { enToWorld, frameToLocal } from './types';
import type { Neighbor } from './types';

/** 地形・航空写真・周辺建物の取得半径 (m) */
export const TERRAIN_RADIUS = 320;
export const AERIAL_RADIUS = 320;
export const NEIGHBOR_RADIUS = 300;

export interface LoadReport {
  terrain: string;
  aerial: string;
  neighbors: string;
  errors: string[];
}

/** ピン位置の周辺環境をすべて取得する（失敗した項目は平地・写真なし・建物なしで続行） */
export async function loadEnvironment(opts: { onProgress?: (msg: string, ratio: number) => void; signal?: AbortSignal } = {}): Promise<LoadReport> {
  const f = study.frame;
  if (!f) throw new Error('建設地が指定されていません');
  // 中止されたときに元に戻すための控え
  const prev = { grid: study.grid, aerial: study.aerial, horizon: study.horizon, neighbors: study.neighbors, sources: study.neighborSources, notes: study.neighborNotes, attribution: study.env.attribution, loaded: study.env.loaded, groundElev: f.groundElev };
  const aborted = () => !!opts.signal?.aborted;
  study.env.loading = true;
  study.env.error = null;
  emit('env');
  const report: LoadReport = { terrain: '', aerial: '', neighbors: '', errors: [] };
  let done = 0;
  const tick = (msg: string) => opts.onProgress?.(msg, Math.min(0.95, done / 3));
  tick('地形・航空写真・周辺建物を取得しています…');
  const tTerrain = fetchHeightGrid(f.lat, f.lon, TERRAIN_RADIUS, { signal: opts.signal, onProgress: (m) => tick(m) })
    .then((g) => {
      study.grid = g;
      report.terrain = g.source;
    })
    .catch((e: Error) => {
      if (aborted()) return;
      study.grid = flatGrid(TERRAIN_RADIUS, 0);
      report.terrain = 'flat';
      report.errors.push(`標高データを取得できませんでした（平地として扱います）: ${e.message}`);
    })
    .finally(() => {
      done++;
      tick('地形を読み込みました');
    });
  const tAerial = fetchAerial(f.lat, f.lon, AERIAL_RADIUS, 18, 'photo')
    .then((img) => {
      study.aerial = img;
      study.env.attribution = img.attribution;
      report.aerial = 'ok';
    })
    .catch((e: Error) => {
      if (aborted()) return;
      study.aerial = null;
      report.aerial = 'none';
      report.errors.push(`航空写真を取得できませんでした: ${e.message}`);
    })
    .finally(() => {
      done++;
      tick('航空写真を読み込みました');
    });
  const tNeighbors = fetchNeighbors(f.lat, f.lon, NEIGHBOR_RADIUS, { signal: opts.signal, onProgress: (m) => tick(m) })
    .then((r) => {
      const manual = study.neighbors.filter((n) => n.source === 'manual');
      study.neighbors = [...manual, ...r.list];
      study.neighborSources = r.sourcesUsed;
      study.neighborNotes = r.notes;
      report.neighbors = `${r.list.length}`;
    })
    .catch((e: Error) => {
      if (aborted()) return;
      study.neighbors = study.neighbors.filter((n) => n.source === 'manual');
      study.neighborSources = [];
      study.neighborNotes = [];
      report.neighbors = 'none';
      report.errors.push(e.message.startsWith('周辺建物を取得できませんでした') ? e.message : `周辺建物を取得できませんでした: ${e.message}`);
    })
    .finally(() => {
      done++;
      tick('周辺建物を読み込みました');
    });
  await Promise.all([tTerrain, tAerial, tNeighbors]);
  if (aborted()) {
    // 中止: 読み込み前の状態に戻す（途中まで入った値を使わない）
    study.grid = prev.grid;
    study.aerial = prev.aerial;
    study.horizon = prev.horizon;
    study.neighbors = prev.neighbors;
    study.neighborSources = prev.sources;
    study.neighborNotes = prev.notes;
    study.env.attribution = prev.attribution;
    study.env.loaded = prev.loaded;
    study.env.loading = false;
    f.groundElev = prev.groundElev;
    emit('env');
    throw new DOMException('周辺環境の読み込みを中止しました', 'AbortError');
  }
  // ピン位置の地盤高
  const g = study.grid!;
  const h0 = sampleHeight(g, 0, 0);
  f.groundElev = Number.isFinite(h0) ? h0 : 0;
  // 遠方の山・丘による地平線（粗い DEM、半径 10km）。失敗しても平らな地平線で続行
  tick('周囲の山・丘による地平線を計算しています…');
  try {
    const hz = await fetchHorizonProfile(f.lat, f.lon, f.groundElev, { signal: opts.signal });
    study.horizon = hz.source === 'none' ? null : hz;
  } catch {
    study.horizon = null;
  }
  study.env.loading = false;
  study.env.loaded = true;
  study.env.error = report.errors.length ? report.errors.join('\n') : null;
  emit('env');
  emit('frame');
  return report;
}

/** 地形の高さ（ワールド y）。地形が無ければ 0 */
export function groundY(e: number, n: number): number {
  const g = study.grid;
  const f = study.frame;
  if (!g || !f) return 0;
  const h = sampleHeight(g, e, n);
  return Number.isFinite(h) ? h - (f.groundElev ?? 0) : 0;
}

/** ワールド XZ での地形の高さ */
export function groundYWorld(x: number, z: number): number {
  return groundY(x, -z);
}

/** 敷地ポリゴン（ワールド XZ）。無ければ null */
export function sitePolygonWorld(): THREE.Vector2[] | null {
  return sitePolygonLocal()?.map((p) => new THREE.Vector2(p.e, -p.n)) ?? null;
}

/** 敷地ポリゴン（ピンからの東・北 m）。無い・面積 0（保存データが壊れているなど。輪郭に合わせる計算で矩形が作れない）なら null */
export function sitePolygonEN(): { e: number; n: number }[] | null {
  return sitePolygonLocal();
}

/** EN と world の両方の元。面積 0 の輪郭は「無い」扱いにして、日影図の敷地境界・輪郭への合わせ・地図の表示で食い違わないようにする */
function sitePolygonLocal(): { e: number; n: number }[] | null {
  const f = study.frame;
  if (!f || study.sitePolygon.length < 3) return null;
  const pts = study.sitePolygon.map((p) => frameToLocal(f, p));
  return Math.abs(polygonArea(pts)) > 0 ? pts : null;
}

/** 敷地内（または建物の足跡に重なる）の自動取得建物を list から除く（手動の隣家はそのまま） */
function excludeOnSite(list: Neighbor[], footprintEN: { e: number; n: number }[] | null): Neighbor[] {
  const polys: { e: number; n: number }[][] = [];
  const site = sitePolygonEN();
  if (site) polys.push(site);
  if (footprintEN && footprintEN.length >= 3) polys.push(footprintEN);
  if (!polys.length) return list;
  const auto = excludeOverlapping(
    list.filter((n) => n.source !== 'manual'),
    polys,
  );
  return [...list.filter((n) => n.source === 'manual'), ...auto];
}

/** 敷地内（または建物の足跡に重なる）の自動取得建物と、隠した建物（隠し方を問わない）を除いた一覧（3D に描く。影・解析にはこれと表示だけ隠した建物が入る） */
export function neighborsForScene(footprintEN: { e: number; n: number }[] | null): Neighbor[] {
  return excludeOnSite(visibleNeighbors(), footprintEN);
}

/** 表示だけ隠した建物のうち、敷地内で自動的に外れないもの（描かないが影だけのメッシュにして、実時間の影・解析に残す） */
export function viewOnlyNeighborsForScene(footprintEN: { e: number; n: number }[] | null): Neighbor[] {
  return excludeOnSite(viewOnlyNeighbors(), footprintEN);
}

/** 影・解析に入る周辺建物（描く建物 + 表示だけ隠した建物。敷地内で自動的に外れる建物・計算から除外した建物は入らない） */
export function analysisNeighborsForScene(footprintEN: { e: number; n: number }[] | null): Neighbor[] {
  return excludeOnSite(analysisNeighbors(), footprintEN);
}

/** 隠した建物（隠し方を問わない）のうち、表示していれば 3D に出るもの（敷地内で自動的に外れる建物は除く）。半透明の表示に使う */
export function hiddenNeighborsForScene(footprintEN: { e: number; n: number }[] | null): Neighbor[] {
  return excludeOnSite(hiddenNeighbors(), footprintEN);
}

/** 敷地の輪郭・建物の足跡に重なるため自動で外している（計算から除外してはいない）自動取得の建物の数。表示だけ隠した建物も数える */
export function siteExcludedCount(footprintEN: { e: number; n: number }[] | null): number {
  const list = analysisNeighbors();
  return list.length - excludeOnSite(list, footprintEN).length;
}

/** 周辺建物の足元の高さ（ワールド y）。rebuildEnvironment と半透明の表示で同じものを使う */
const neighborGroundY = (e: number, n: number) => groundY(e, n) - 0.3;

/**
 * 隠した建物の半透明の表示（選んで隠すモードの間だけ groups.select に入れる）。
 * 既定は不透明度 25 %・深度を書かない。影を落とさない／受けない。userData: { neighborId, ghost: true, noShadow: true, overlay: true }
 * （noShadow は bakeWorldTriangles、overlay は studyMeshFilter で除かれるので、どの解析の BVH にも入らない）。
 * 表示だけ隠した建物（hideMode 'view'）は userData.viewOnly = true で、viewMaterial があればそれを使う（計算から除外した建物と色を分ける）。
 * material を渡すと全メッシュで共有し（userData.sharedMaterial = true。clearGroup で解放しない）、無ければ新しく作る
 */
export function buildNeighborGhosts(list: Neighbor[], opts: { material?: THREE.Material; viewMaterial?: THREE.Material } = {}): THREE.Group {
  const viewIds = new Set(list.filter((n) => n.hidden && n.hideMode === 'view').map((n) => n.id));
  const group = buildNeighborMeshes(
    list.map((n) => ({ ...n, hidden: false })),
    { groundY: neighborGroundY, aerial: null },
  );
  group.name = 'neighbor-ghosts';
  const shared = !!opts.material;
  const mat = opts.material ?? ghostMaterial();
  const viewMat = opts.viewMaterial ?? mat;
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const id = m.userData.neighborId as string;
    const viewOnly = viewIds.has(id);
    // buildNeighborMeshes の屋根・壁のマテリアルは使わない（描画しないので GPU には載っていない）
    m.material = viewOnly ? viewMat : mat;
    m.castShadow = false;
    m.receiveShadow = false;
    m.renderOrder = 3;
    m.userData = { neighborId: id, ghost: true, noShadow: true, overlay: true, ...(viewOnly ? { viewOnly: true } : {}), ...(shared ? { sharedMaterial: true } : {}) };
  });
  return group;
}

/** 表示だけ隠した建物の影だけのマテリアル: 色も深度も書かない（画面には何も描かない）。影のマップには three が深度のマテリアルで描く */
export function shadowOnlyMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, toneMapped: false });
  m.name = 'neighbor-shadow-only';
  return m;
}

/**
 * 表示だけ隠した建物の影だけのメッシュ（groups.neighbors に入れる）: castShadow = true（実時間の影のマップに描かれる）、
 * receiveShadow = false、マテリアルは colorWrite = false・depthWrite = false（画面には描かない）、クリックでは選べない（raycast なし）。
 * userData: { neighbor: true, neighborId, shadowOnly: true, viewHidden: true, matKey: 'neighbor' } — noShadow / overlay は付けないので、
 * 解析の遮蔽物（buildStudyOccluder の groups.neighbors。表示を無視して焼き込む）にそのまま入る
 */
export function buildNeighborShadowCasters(list: Neighbor[], opts: { groundY?: (e: number, n: number) => number; material?: THREE.Material } = {}): THREE.Group {
  const group = buildNeighborMeshes(
    list.map((n) => ({ ...n, hidden: false })),
    { groundY: opts.groundY ?? neighborGroundY, aerial: null },
  );
  group.name = 'neighbor-shadow-only';
  const mat = opts.material ?? shadowOnlyMaterial();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const id = m.userData.neighborId as string;
    m.material = mat;
    m.castShadow = true;
    m.receiveShadow = false;
    m.raycast = () => {};
    m.userData = { neighbor: true, neighborId: id, heightKind: m.userData.heightKind, matKey: 'neighbor', shadowOnly: true, viewHidden: true };
  });
  return group;
}

/** 隠した建物の半透明のマテリアル（明るい灰色・不透明度 25 %・深度を書かない） */
export function ghostMaterial(color = '#c9d1da', opacity = 0.25): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false });
}

/** state からシーンの地形・周辺建物・敷地を作り直す */
export function rebuildEnvironment(scene: StudyScene, footprintEN: { e: number; n: number }[] | null) {
  const f = study.frame;
  clearGroup(scene.groups.terrain);
  clearGroup(scene.groups.neighbors);
  clearGroup(scene.groups.site);
  // 解析用に残している地形の BVH も捨てる（古い地形を参照し続けない）
  void import('./analysis').then((m) => m.clearStudyOccluderCache()).catch(() => {});
  if (!f) return;
  const g = study.grid ?? flatGrid(TERRAIN_RADIUS, 0);
  const ge = f.groundElev ?? 0;
  const terrain = buildTerrainMesh(g, ge, { aerial: study.show.aerial ? study.aerial : null });
  terrain.visible = study.show.terrain || study.show.aerial;
  scene.groups.terrain.add(terrain);
  const list = neighborsForScene(footprintEN);
  for (const n of list) n.baseElev = minHeightInRing(g, n.ring);
  const meshes = buildNeighborMeshes(list, { groundY: neighborGroundY, aerial: study.aerial });
  meshes.visible = study.show.neighbors;
  scene.groups.neighbors.add(meshes);
  // 表示だけ隠した建物: 描かずに影だけ落とす（解析の遮蔽物にも groups.neighbors から入る）
  const viewOnly = viewOnlyNeighborsForScene(footprintEN);
  if (viewOnly.length) {
    for (const n of viewOnly) n.baseElev = minHeightInRing(g, n.ring);
    const casters = buildNeighborShadowCasters(viewOnly);
    casters.visible = study.show.neighbors;
    scene.groups.neighbors.add(casters);
  }
  // 敷地の輪郭（地面に沿った線）とピン
  const site = sitePolygonEN();
  if (site) {
    const pts: THREE.Vector3[] = [];
    const n = site.length;
    for (let i = 0; i < n; i++) {
      const a = site[i % n];
      const b = site[(i + 1) % n];
      const seg = Math.max(1, Math.ceil(Math.hypot(b.e - a.e, b.n - a.n) / 2));
      for (let k = 0; k < seg; k++) {
        const t = k / seg;
        const e = a.e + (b.e - a.e) * t;
        const nn = a.n + (b.n - a.n) * t;
        pts.push(enToWorld(e, nn, groundY(e, nn) + 0.08));
      }
    }
    pts.push(pts[0].clone());
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: '#ff5a36', dashSize: 1, gapSize: 0.5, toneMapped: false, depthTest: false }));
    line.computeLineDistances();
    line.renderOrder = 5;
    scene.groups.site.add(line);
  }
  scene.groups.site.visible = study.show.site;
  scene.invalidate();
}
