// 庭を囲む白い塗り壁の塀と、敷地の際の塀の既定（2026-11-15。御社スタッフの Twinmotion の外観パースから）:
//  - 居間の大きな窓の前の庭に、目隠しの白い塗り壁の塀（高さ 1.9m。1 枚の壁）を立てる。立てる場所は庭の形で変える:
//      平らな面の前の開けた庭・広い敷地 → 芝の先（窓から約 5m。大崎様邸: 居間の窓の外が白い塀）
//      建物の棟に挟まれた庭（中庭・入隅）→ 庭の途中には立てず、敷地の際だけ（吉田様邸の中庭: スタッフのパースは
//        7〜8m 引いて撮っても塀が無い。途中に立てると庭が狭くなり、外観の庭側のカットも塀の手前からしか撮れない）
//      芝の先の残りが少ない敷地 → 敷地の際（塀の裏に半端な空きを残さない）
//  - 既定の外観（ジョリパット グレー）は、隣地との境に木の塀を立てない
//  - 木の塀・生垣を選んだテイストでは、敷地の際に白い塀を重ねない
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildBuilding } from '../src/scene/building';
import { buildLandscape, planExteriorOf } from '../src/scene/landscape';
import { exteriorById } from '../src/styles/presets';
import type { BuildingModel, Floor, Opening, Room, Vec2, Wall } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const report = { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text' as const, wallThicknesses: [], warnings: [], timingsMs: {} };
const wallsOf = (O: Vec2[]): Wall[] => O.map((a, i) => ({ id: `w${i}`, a, b: O[(i + 1) % O.length], thickness: 150, exterior: true, outsideSign: 1 as const }));

/**
 * 開けた庭: 8m × 6m の平屋。全体が LDK で、南（図面の下）の壁に幅 2.5m の掃き出し窓。道路は北（図面の上）。
 * @param south 南の敷地境界の位置（mm。建物の南の壁は 6000）
 */
function boxModel(south: number): BuildingModel {
  const O = [P(0, 0), P(8000, 0), P(8000, 6000), P(0, 6000)];
  const openings: Opening[] = [
    // 南の面（w2: (8000,6000) → (0,6000)）
    { id: 'w1', wallId: 'w2', kind: 'window', t0: 3000, t1: 5500, sill: 0, height: 2000 },
    { id: 'e1', wallId: 'w0', kind: 'entrance', t0: 1000, t1: 1900, sill: 0, height: 2300 },
  ];
  const rooms: Room[] = [{ id: 'r1', name: 'LDK', type: 'ldk', polygon: O, labelPos: P(4000, 3000), area: 48 }];
  const f1: Floor = { level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, outline: [O], rooms, stairs: [], openings, walls: wallsOf(O) };
  return { name: 't', floors: [f1], northAngleDeg: 0, site: { roads: [{ side: 'top', source: 'manual', widthMm: 4000 }], bounds: { top: -5000, bottom: south, left: -3000, right: 11000 } }, report };
}

/**
 * 棟に挟まれた庭: L 字の平屋。母屋（10 × 7 m）の東に、別の棟（6 × 8 m）が南へ 5m 張り出す。
 * 母屋の南の面（張り出した棟のすぐ西）に掃き出し窓。道路は北。
 * @param south 南の敷地境界の位置（mm。母屋の南の壁は 7000）
 */
function nookModel(south: number): BuildingModel {
  const O = [P(0, 0), P(10000, 0), P(10000, 4000), P(16000, 4000), P(16000, 12000), P(10000, 12000), P(10000, 7000), P(0, 7000)];
  const openings: Opening[] = [
    { id: 'e1', wallId: 'w0', kind: 'entrance', t0: 1000, t1: 1900, sill: 0, height: 2300 },
    // 南の面（w6: (10000,7000) → (0,7000)）。張り出した棟から 1〜3.5m
    { id: 's1', wallId: 'w6', kind: 'window', t0: 1000, t1: 3500, sill: 0, height: 2200 },
  ];
  const rooms: Room[] = [
    { id: 'r1', name: 'LDK', type: 'ldk', polygon: [P(0, 0), P(10000, 0), P(10000, 7000), P(0, 7000)], labelPos: P(5000, 3500), area: 70 },
    { id: 'r2', name: '洋室', type: 'bedroom', polygon: [P(10000, 4000), P(16000, 4000), P(16000, 12000), P(10000, 12000)], labelPos: P(13000, 8000), area: 48 },
  ];
  const f1: Floor = { level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, outline: [O], rooms, stairs: [], openings, walls: wallsOf(O) };
  return { name: 't', floors: [f1], northAngleDeg: 0, site: { roads: [{ side: 'top', source: 'manual', widthMm: 4000 }], bounds: { top: -5000, bottom: south, left: -3000, right: 19000 } }, report };
}

const land = (m: BuildingModel, fence?: 'wood' | 'hedge') => {
  const base = exteriorById('hl-jolypat-grey');
  const style = fence ? { ...base, landscape: { ...base.landscape, fence } } : base;
  const { meta } = buildBuilding(m, { exterior: style });
  return buildLandscape(meta, style, m.site, planExteriorOf(m), m.siteLevels);
};
/** 白い塀（天端 1.93m）の区間。窓に平行な 1 枚（両端を折り返すと、外から見て白い箱が庭に置いてあるように見えるので、折り返さない） */
const whiteWalls = (r: ReturnType<typeof land>) => {
  const all = r.site.fences!.filter((f) => Math.abs(f.top - 1.93) < 0.01);
  return { all, main: all.filter((f) => Math.abs(f.a.z - f.b.z) < 0.01) };
};
/** 芝のいちばん奥（南）の位置 */
function lawnFarEdge(r: ReturnType<typeof land>): number {
  const g = r.mb.build(() => new THREE.MeshBasicMaterial());
  let z = -Infinity;
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.matKey !== 'l.lawn') return;
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) z = Math.max(z, pos.getZ(i));
  });
  return z;
}

describe('開けた庭（平らな面の前）の白い塀', () => {
  it('奥行 6m の庭: 芝の先の残りが少ないので、塀は敷地の際（0.2m 手前）。芝は際の 0.4m 手前まで', () => {
    const r = land(boxModel(12000));
    const w = whiteWalls(r);
    expect(w.all.length).toBe(1);
    expect(w.main.length).toBe(1);
    expect(w.main[0].a.z).toBeCloseTo(11.8, 1);
    // 窓の幅 2.5m + 両側 1.6m ずつ以上
    expect(Math.abs(w.main[0].a.x - w.main[0].b.x)).toBeGreaterThan(2.5 + 3);
    expect(lawnFarEdge(r)).toBeCloseTo(11.6, 1);
  });

  it('奥行 10m の庭（広い敷地）: 塀は芝の先（窓から約 5m）。芝はデッキの先 3.2m まで', () => {
    const r = land(boxModel(16000));
    const w = whiteWalls(r);
    expect(w.all.length).toBe(1);
    expect(w.main.length).toBe(1);
    // 窓の面 6.0 + デッキ 1.8 + 芝 3.2 + 0.25
    expect(w.main[0].a.z).toBeCloseTo(11.25, 1);
    expect(lawnFarEdge(r)).toBeCloseTo(11.0, 1);
  });

  it('木の塀・生垣を選んだテイスト: 敷地の際には白い塀を重ねない。広い敷地の芝の先の塀は立てる', () => {
    const wood = land(boxModel(12000), 'wood');
    expect(whiteWalls(wood).all.length).toBe(0);
    expect(wood.site.fences!.length).toBeGreaterThan(0);
    for (const f of wood.site.fences!) expect(f.top).toBeCloseTo(1.74, 2);
    expect(land(boxModel(12000), 'hedge').site.fences!.length).toBe(0);
    expect(whiteWalls(land(boxModel(16000), 'wood')).main.length).toBe(1);
  });
});

describe('建物の棟に挟まれた庭（中庭・入隅）の白い塀', () => {
  it('奥行 9m: 庭の途中（窓から 5m）には立てず、敷地の際に立てる', () => {
    const w = whiteWalls(land(nookModel(16000)));
    expect(w.all.length).toBe(1);
    expect(w.main.length).toBe(1);
    expect(w.main[0].a.z).toBeCloseTo(15.8, 1);
  });

  it('際まで 12m を超える: 立てない（棟そのものが庭を囲っている）', () => {
    expect(whiteWalls(land(nookModel(7000 + 12500))).all.length).toBe(0);
  });
});

describe('既定の外観は、隣地との境に塀を立てない', () => {
  it('ジョリパット グレー（既定）: 庭の白い塀のほかに、敷地の際の塀は無い', () => {
    expect(land(nookModel(7000 + 12500)).site.fences!.length).toBe(0);
    const r = land(boxModel(16000));
    expect(r.site.fences!.length).toBe(whiteWalls(r).all.length);
  });
});
