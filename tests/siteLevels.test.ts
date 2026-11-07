// 敷地の高低差（SiteLevels）: 外構の 3D（道路・擁壁・階段・隣家の足元）、資金計画の概算、標高データからの推定
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildLandscape } from '../src/scene/landscape';
import { exteriorById } from '../src/styles/presets';
import type { BuildingMeta } from '../src/scene/building';
import type { MeshBuilder } from '../src/scene/meshBuilder';
import { levelsFromSamples, levelsSummary, planSideCompass, retainingQuantities, sideOfOutward, stepCount } from '../src/core/siteLevels';
import { annexRows } from '../src/estimate/funding';
import { levelsFromGrid } from '../src/app/siteLevelsDem';
import type { BuildingModel, Floor, SiteLevels, Vec2 } from '../src/core/types';
import type { HeightGrid } from '../src/sunstudy/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const floor = (level: number, elevation: number, outline: Vec2[][]): Floor => ({ level, elevation, height: 2900, ceilingHeight: 2400, walls: [], openings: [], rooms: [], stairs: [], outline });
/** 10 × 8 m の 2 階建て。道路は図面の下（南）側 */
const model = (levels?: SiteLevels): BuildingModel => ({
  name: 't',
  floors: [floor(1, 500, [rect(0, 0, 10000, 8000)]), floor(2, 3400, [rect(0, 0, 10000, 8000)])],
  northAngleDeg: 0,
  site: { roads: [{ side: 'bottom', source: 'manual', widthMm: 4000 }], bounds: {} },
  ...(levels ? { siteLevels: levels } : {}),
  report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} },
});
const meta = (): BuildingMeta => ({
  bbox: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 6.5, 8)),
  rooms: [],
  entrance: { pos: new THREE.Vector3(5, 0, 8), outward: new THREE.Vector3(0, 0, 1), width: 0.9, level: 1, openingId: 'e' },
  wallTop: [2.9],
  doorLeaves: [],
  doors: [],
  outlines: [],
  topY: 6.5,
  sashes: [],
});
const style = exteriorById('hl-jolypat-grey');
const yRange = (mb: MeshBuilder, key: string): { min: number; max: number } | null => {
  const g = mb.build(() => new THREE.MeshBasicMaterial());
  const m = g.children.find((c) => c.name === key) as THREE.Mesh | undefined;
  if (!m) return null;
  const bb = m.geometry.boundingBox!;
  return { min: bb.min.y, max: bb.max.y };
};
const land = (levels?: SiteLevels) => {
  const m = model(levels);
  return buildLandscape(meta(), style, m.site, undefined, m.siteLevels);
};

describe('siteLevels の計算', () => {
  it('辺の向きと方位、階段の段数', () => {
    expect(sideOfOutward(0, 1)).toBe('bottom');
    expect(sideOfOutward(-1, 0.2)).toBe('left');
    expect(planSideCompass('top', 0)).toBe('上（北）');
    // 真北が図面の上から時計回りに 90°（北が図面の右）
    expect(planSideCompass('right', 90)).toBe('右（北）');
    expect(planSideCompass('bottom', 90)).toBe('下（東）');
    expect(stepCount(800)).toEqual({ n: 5, riserMm: 160, treadMm: 300, runMm: 1500 });
    expect(stepCount(0).n).toBe(0);
    expect(stepCount(-1500)).toMatchObject({ n: 9, treadMm: 280 });
  });
  it('説明の文', () => {
    const lines = levelsSummary({ roadMm: -800, neighborMm: { top: 500 }, parkingAtRoad: true }, 0);
    expect(lines[0]).toContain('道路が敷地より 80 cm 低い');
    expect(lines[0]).toContain('階段 5 段');
    expect(lines[0]).toContain('駐車場は道路の高さ');
    expect(lines[1]).toBe('上（北）の隣地が 50 cm 高い');
  });
  it('標高の標本から高低差（誤差より小さい差は 0、5 cm 刻み）', () => {
    const lv = levelsFromSamples({ gl: [10, 10.1, 10.0], road: [9.2, 9.25, 9.18], neighbors: { top: [10.5, 10.52], left: [10.1, 10.08] } }, { resolutionM: 5, sourceLabel: 'DEM5A', roadSide: 'bottom' });
    expect(lv?.roadMm).toBe(-800);
    expect(lv?.neighborMm).toEqual({ top: 500 });
    expect(lv?.source).toBe('dem');
    // 1m メッシュなら 15 cm まで拾う
    const fine = levelsFromSamples({ gl: [10], road: [9.8], neighbors: {} }, { resolutionM: 1, sourceLabel: 'DEM1A' });
    expect(fine?.roadMm).toBe(-200);
  });
  it('擁壁・階段の数量と資金計画の行（敷地の方が高い辺だけ擁壁）', () => {
    const m = model({ roadMm: -800, neighborMm: { top: 500, left: -300 } });
    const q = retainingQuantities(m)!;
    // 敷地は建物 10 × 8 m に余白（道路側 6 m・ほか 1.6 m）= 13.2 × 15.6 m。道路側（下）13.2 m × 0.8、左 15.6 m × 0.3。上は隣地の方が高いので自分の擁壁ではない
    expect(q.walls.map((w) => `${w.side}:${w.lengthM}x${w.heightM}`)).toEqual(['bottom:13.2x0.8', 'left:15.6x0.3']);
    expect(q.wallAreaM2).toBeCloseTo(15.2, 1);
    expect(q.steps).toBe(5);
    const rows = annexRows(m);
    expect(rows.find((r) => r.id === 'annexRetain')?.amount).toBe(910000);
    expect(rows.find((r) => r.id === 'annexSteps')?.amount).toBe(100000);
    expect(annexRows(model())).toEqual([]);
  });
});

describe('外構の 3D（buildLandscape）', () => {
  it('高低差なし: 擁壁は無く、道路は GL', () => {
    const r = land();
    expect(r.walls.isEmpty()).toBe(true);
    expect(yRange(r.mb, 'l.road')!.min).toBeCloseTo(0.005, 3);
  });
  it('道路が 80 cm 低い: 路面・縁石が下がり、境界に擁壁、玄関に階段 5 段', () => {
    const r = land({ roadMm: -800 });
    expect(yRange(r.mb, 'l.road')!.min).toBeCloseTo(-0.795, 3);
    expect(yRange(r.mb, 'l.curb')!.max).toBeCloseTo(-0.68, 3);
    const wall = yRange(r.walls, 'l.retain')!;
    expect(wall.min).toBeCloseTo(-0.82, 3);
    expect(wall.max).toBeCloseTo(0.05, 3);
    const steps = yRange(r.walls, 'l.approach')!;
    expect(steps.max).toBeCloseTo(0, 3);
    expect(steps.min).toBeCloseTo(-0.82, 3);
    // 階段は 5 段 = 直方体 5 つ（1 つ 6 面 × 2 三角形 × 3 頂点 = 36 頂点）
    expect(r.walls.mark().get('l.approach')).toBe(5 * 36 * 3);
    // 道路の中心は路面の高さ
    expect(r.site.roadCenter.y).toBeCloseTo(-0.8, 3);
  });
  it('駐車場を道路の高さに: 舗装が下がり、擁壁が増える', () => {
    const a = land({ roadMm: -800 });
    const b = land({ roadMm: -800, parkingAtRoad: true });
    expect(yRange(b.mb, 'l.driveway')!.min).toBeCloseTo(-0.788, 3);
    expect(yRange(a.mb, 'l.driveway')!.min).toBeCloseTo(0.012, 3);
    expect(b.walls.mark().get('l.retain')!).toBeGreaterThan(a.walls.mark().get('l.retain')!);
  });
  it('石積み・法面・スロープ', () => {
    expect(land({ roadMm: -800, retaining: 'stone' }).walls.mark().has('l.stone')).toBe(true);
    const slope = land({ roadMm: -800, retaining: 'slope' });
    expect(slope.walls.mark().has('l.retain')).toBe(false);
    expect(slope.walls.mark().has('l.approach')).toBe(true);
    const ramp = land({ roadMm: -800, approach: 'ramp' });
    // スロープは 1 枚の斜面（四角形 = 6 頂点）＋ 両脇の壁
    expect(ramp.walls.mark().get('l.approach')).toBe(6 * 3);
  });
  it('道路が高い（敷地が低い）: 道路側の壁は GL から路面まで、階段は下る', () => {
    const r = land({ roadMm: 600 });
    const wall = yRange(r.walls, 'l.retain')!;
    expect(wall.min).toBeCloseTo(-0.02, 3);
    expect(wall.max).toBeCloseTo(0.65, 3);
    expect(yRange(r.walls, 'l.approach')!.max).toBeCloseTo(0.6 - 0.15, 2);
  });
  it('隣地が高い・低い: 隣家はその高さに立ち、境界に擁壁、フェンスはその上', () => {
    const r = land({ neighborMm: { top: 500, left: -400 } });
    // 隣家の辺は箱の中心で見る（敷地は x −1.6〜11.6、z −1.6〜14）
    const center = (t: (typeof r.town)[number]) => ({ x: (t.box.min.x + t.box.max.x) / 2, z: (t.box.min.z + t.box.max.z) / 2 });
    const top = r.town.filter((t) => center(t).z < -1.6 && center(t).x > -1.6 && center(t).x < 11.6);
    expect(top.length).toBeGreaterThan(0);
    for (const t of top) expect(t.box.min.y).toBeCloseTo(0.5, 3);
    const left = r.town.filter((t) => center(t).x < -1.6 && center(t).z > -1.6 && center(t).z < 14);
    expect(left.length).toBeGreaterThan(0);
    for (const t of left) expect(t.box.min.y).toBeCloseTo(-0.4, 3);
    const right = r.town.filter((t) => center(t).x > 11.6 && center(t).z > -1.6 && center(t).z < 14);
    for (const t of right) expect(t.box.min.y).toBeCloseTo(0, 3);
    const wall = yRange(r.walls, 'l.retain')!;
    expect(wall.min).toBeCloseTo(-0.42, 3);
    expect(wall.max).toBeCloseTo(0.55, 3);
    // 高い隣地側のフェンス（ブロック）は擁壁の上（y = 0.5 から）
    const block = yRange(r.mb, 'l.block')!;
    expect(block.max).toBeGreaterThan(0.5 + 0.4 - 0.01);
  });
});

describe('標高の格子から高低差を推定（levelsFromGrid）', () => {
  it('南（道路側）が 80 cm 低く、北の隣地が 50 cm 高い地形', () => {
    const nx = 80;
    const ny = 80;
    const values = new Float32Array(nx * ny);
    for (let r = 0; r < ny; r++)
      for (let c = 0; c < nx; c++) {
        const n = 40 - (r + 0.5);
        values[r * nx + c] = 10 + (n < -9 ? -0.8 : n > 9 ? 0.5 : 0);
      }
    const grid: HeightGrid = { west: -40, east: 40, south: -40, north: 40, nx, ny, values, source: 'dem1a', resolution: 1 };
    // 図面座標 mm → 東・北: 建物の中心 (5, 4) m が原点、図面の下が南
    const toEN = (x: number, y: number) => ({ e: x / 1000 - 5, n: -(y / 1000 - 4) });
    const lv = levelsFromGrid(model(), grid, toEN)!;
    expect(lv.roadMm).toBe(-800);
    expect(lv.neighborMm).toEqual({ top: 500 });
    expect(lv.note).toContain('DEM1A');
  });
});
