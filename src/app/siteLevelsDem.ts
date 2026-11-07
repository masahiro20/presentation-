/**
 * 国土地理院の標高タイルから敷地の高低差を推定する（日照のステップで建設地が決まっているとき）。
 * 建物の足元（1 階の外形の中）を設計 GL の基準にし、前面道路（境界の 3 m 外）と隣地（境界の 6 m 外）の標高との差を取る
 */
import * as THREE from 'three';
import type { BuildingModel, PlanSide, SiteLevels, Vec2 } from '../core/types';
import { pointInPolygon } from '../core/geometry';
import { PLAN_SIDES, levelsFromSamples, roadSideOf, siteExtentsMm, type LevelSamples } from '../core/siteLevels';
import { DEM_LABEL, fetchHeightGrid, sampleHeight } from '../sunstudy/terrain';
import type { HeightGrid } from '../sunstudy/types';

/** 標本を取る点（図面座標 mm）: 建物の中・道路・辺ごとの隣地 */
export function levelSamplePoints(model: BuildingModel): { gl: Vec2[]; road: Vec2[]; neighbors: Partial<Record<PlanSide, Vec2[]>>; roadSide: PlanSide | null } | null {
  const roadSide = roadSideOf(model);
  const ext = siteExtentsMm(model, roadSide);
  if (!ext) return null;
  const f1 = model.floors.slice().sort((a, b) => a.level - b.level)[0];
  const loops = f1?.outline.filter((l) => l.length >= 3) ?? [];
  const gl: Vec2[] = [];
  if (loops.length) {
    const pts = loops.flat();
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const step = Math.max(1500, Math.min(maxX - minX, maxY - minY) / 4);
    for (let y = minY + step / 2; y < maxY; y += step) for (let x = minX + step / 2; x < maxX; x += step) if (loops.some((l) => pointInPolygon({ x, y }, l))) gl.push({ x, y });
    if (!gl.length) gl.push({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
  } else gl.push({ x: (ext.minX + ext.maxX) / 2, y: (ext.minY + ext.maxY) / 2 });
  /** 辺の外側 d mm に、辺に沿って 5 点 */
  const outside = (side: PlanSide, d: number): Vec2[] => {
    const out: Vec2[] = [];
    for (let i = 1; i <= 5; i++) {
      const t = i / 6;
      if (side === 'top') out.push({ x: ext.minX + (ext.maxX - ext.minX) * t, y: ext.minY - d });
      else if (side === 'bottom') out.push({ x: ext.minX + (ext.maxX - ext.minX) * t, y: ext.maxY + d });
      else if (side === 'left') out.push({ x: ext.minX - d, y: ext.minY + (ext.maxY - ext.minY) * t });
      else out.push({ x: ext.maxX + d, y: ext.minY + (ext.maxY - ext.minY) * t });
    }
    return out;
  };
  const neighbors: Partial<Record<PlanSide, Vec2[]>> = {};
  for (const s of PLAN_SIDES) if (s !== roadSide) neighbors[s] = outside(s, 6000);
  return { gl, road: roadSide ? outside(roadSide, 3000) : [], neighbors, roadSide };
}

/** 標高の格子から標本を引き、高低差にする（純粋な計算。テストで使う） */
export function levelsFromGrid(model: BuildingModel, grid: HeightGrid, toEN: (x: number, y: number) => { e: number; n: number }): SiteLevels | null {
  const pts = levelSamplePoints(model);
  if (!pts) return null;
  const take = (list: Vec2[]) =>
    list.map((p) => {
      const en = toEN(p.x, p.y);
      return sampleHeight(grid, en.e, en.n);
    });
  const samples: LevelSamples = { gl: take(pts.gl), road: take(pts.road), neighbors: {} };
  for (const s of PLAN_SIDES) if (pts.neighbors[s]) samples.neighbors[s] = take(pts.neighbors[s]!);
  return levelsFromSamples(samples, { resolutionM: grid.resolution, sourceLabel: DEM_LABEL[grid.source] ?? '国土地理院 標高タイル', roadSide: pts.roadSide ?? undefined });
}

/**
 * 標高タイルを取得して高低差を推定する。fromWorld はワールド座標（m）→ ピンからの東・北（m）（日照の SunContext.fromWorld）。
 * 図面座標 mm → ワールドは x/1000, z = y/1000
 */
export async function estimateSiteLevelsFromDem(model: BuildingModel, fromWorld: (p: THREE.Vector3) => { e: number; n: number }, pin: { lat: number; lon: number }, opts: { onProgress?: (msg: string) => void; signal?: AbortSignal } = {}): Promise<SiteLevels | null> {
  const grid = await fetchHeightGrid(pin.lat, pin.lon, 80, { signal: opts.signal, onProgress: opts.onProgress });
  return levelsFromGrid(model, grid, (x, y) => fromWorld(new THREE.Vector3(x / 1000, 0, y / 1000)));
}
