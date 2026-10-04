/**
 * 周辺環境の読み込みと 3D への反映（地形・航空写真・周辺建物）
 *
 * loadEnvironment(): ピン位置を中心に DEM・航空写真・周辺建物を並行取得して state に入れる
 * rebuildEnvironment(): state からシーンの terrain / neighbors / site グループを作り直す
 */
import * as THREE from 'three';
import { fetchAerial } from '../sun/geo';
import { buildNeighborMeshes, excludeOverlapping, fetchNeighbors } from './neighbors';
import type { StudyScene } from './scene';
import { clearGroup } from './scene';
import { emit, study, visibleNeighbors } from './state';
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
      report.errors.push(`周辺建物を取得できませんでした: ${e.message}`);
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
  const f = study.frame;
  if (!f || study.sitePolygon.length < 3) return null;
  return study.sitePolygon.map((p) => {
    const { e, n } = frameToLocal(f, p);
    return new THREE.Vector2(e, -n);
  });
}

/** 敷地ポリゴン（ピンからの東・北 m）。無ければ null */
export function sitePolygonEN(): { e: number; n: number }[] | null {
  const f = study.frame;
  if (!f || study.sitePolygon.length < 3) return null;
  return study.sitePolygon.map((p) => frameToLocal(f, p));
}

/** 敷地内（または建物の足跡に重なる）の自動取得建物を除いた一覧 */
export function neighborsForScene(footprintEN: { e: number; n: number }[] | null): Neighbor[] {
  const polys: { e: number; n: number }[][] = [];
  const site = sitePolygonEN();
  if (site) polys.push(site);
  if (footprintEN && footprintEN.length >= 3) polys.push(footprintEN);
  const list = visibleNeighbors();
  if (!polys.length) return list;
  const auto = excludeOverlapping(
    list.filter((n) => n.source !== 'manual'),
    polys,
  );
  return [...list.filter((n) => n.source === 'manual'), ...auto];
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
  const meshes = buildNeighborMeshes(list, { groundY: (e, n) => groundY(e, n) - 0.3, aerial: study.aerial });
  meshes.visible = study.show.neighbors;
  scene.groups.neighbors.add(meshes);
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
