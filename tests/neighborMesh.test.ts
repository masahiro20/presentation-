// 日照ツール: PLATEAU の実形状（Neighbor.mesh）の描画（buildNeighborMeshes の mesh 分岐。仕様 §5 の接地・sinkBottom・heightScale・航空写真・far）と、
// environment 経由（描く建物・影だけのメッシュ・半透明の表示）の配置の一致、ピン移動後の ring と mesh のずれの一致
import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { bakeWorldTriangles } from '../src/sun/analysis';
import { buildStudyOccluder, clearStudyOccluderCache, disposeStudyOccluder } from '../src/sunstudy/analysis';
import { buildNeighborGhosts, buildNeighborShadowCasters, rebuildEnvironment } from '../src/sunstudy/environment';
import { buildNeighborMeshes, plateauBaseY } from '../src/sunstudy/neighbors';
import type { StudyScene } from '../src/sunstudy/scene';
import { setNeighborsHidden, study } from '../src/sunstudy/state';
import { frameFromLocal } from '../src/sunstudy/types';
import type { AerialImage, HeightGrid, Neighbor } from '../src/sunstudy/types';
import { plateauNeighborAt } from './helpers/plateauBox';

const PIN = { lat: 35.6, lon: 139.6 };
const FRAME = { ...PIN, address: 'テスト', groundElev: 50 };

const bboxOf = (m: THREE.Mesh) => {
  m.geometry.computeBoundingBox();
  return m.geometry.boundingBox!;
};
const meshesOf = (root: THREE.Object3D) => {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
};
const studyMeshFilter = (m: THREE.Mesh) => !m.userData.noShadow && !m.userData.overlay;
const tri = (root: THREE.Object3D) => bakeWorldTriangles([{ root, kind: 'neighbor' }], studyMeshFilter, { ignoreVisibility: true }).triangles;

/** DEM があるつもりの格子（値は使わない。範囲と source だけ） */
const dem = (half: number): HeightGrid => ({ west: -half, east: half, south: -half, north: half, nx: 2, ny: 2, values: new Float32Array([0, 0, 0, 0]), source: 'dem5a', resolution: 5 });
/** 航空写真（Node なので canvas は形だけ） */
const aerial = (): AerialImage => ({ canvas: { width: 256, height: 256 } as unknown as HTMLCanvasElement, west: -50, east: 50, south: -50, north: 50, attribution: 'test' });

function fakeScene(): StudyScene {
  const g = () => new THREE.Group();
  const groups = { terrain: g(), neighbors: g(), building: g(), site: g(), sunpath: g(), overlay: g(), markers: g(), align: g(), select: g() };
  return { groups, invalidate: () => {} } as unknown as StudyScene;
}

describe('buildNeighborMeshes の mesh 分岐（PLATEAU の実形状）', () => {
  // 手作りの箱 10×10×7、anchor（足元の中心）はピンから東 20 m。ring はピン基準で e 15..25・n −5..5
  const box = () => plateauNeighborAt(PIN, 20, 0, { gmlId: 'bldg_box', w: 10, d: 10, h: 7, zmin: 57.2, attrs: { usage: '住宅' } });

  it('groundY = 1 で描くと bbox x 15..25・z −5..5・y 1.0..8.3（足元 = 最低点 + 0.3、壁は 0.3 沈める）。material 2・groups 2・userData 4 キー', () => {
    const g = buildNeighborMeshes([box()], { groundY: () => 1, pin: PIN });
    expect(g.children).toHaveLength(1);
    const m = g.children[0] as THREE.Mesh;
    const bb = bboxOf(m);
    expect(bb.min.x).toBeCloseTo(15, 4);
    expect(bb.max.x).toBeCloseTo(25, 4);
    expect(bb.min.z).toBeCloseTo(-5, 4);
    expect(bb.max.z).toBeCloseTo(5, 4);
    expect(bb.min.y).toBeCloseTo(1.0, 4);
    expect(bb.max.y).toBeCloseTo(8.3, 4);
    expect(Array.isArray(m.material)).toBe(true);
    expect((m.material as THREE.Material[]).length).toBe(2);
    expect(m.geometry.groups).toHaveLength(2);
    expect(m.geometry.groups[0]).toMatchObject({ start: 0, count: 6, materialIndex: 0 });
    expect(m.geometry.groups[1]).toMatchObject({ start: 6, count: 30, materialIndex: 1 });
    expect(m.geometry.getAttribute('position').count).toBe(36);
    expect(m.userData).toEqual({ neighbor: true, neighborId: 'plateau:bldg_box', heightKind: 'measured', matKey: 'neighbor' });
    expect(m.castShadow).toBe(true);
    expect(m.receiveShadow).toBe(true);
    expect(m.name).toBe('住宅');
    // 屋根の法線は上向き
    const nor = m.geometry.getAttribute('normal');
    expect(nor.getY(0)).toBeCloseTo(1, 5);
  });

  it('高さを 14 に上書き（heightScale 2）→ 上端 15.3、下端は不変。pin が無ければ (0,0) 基準', () => {
    const tall: Neighbor = { ...box(), height: 14, heightKind: 'manual' };
    const bb = bboxOf(buildNeighborMeshes([tall], { groundY: () => 1, pin: PIN }).children[0] as THREE.Mesh);
    expect(bb.max.y).toBeCloseTo(15.3, 4);
    expect(bb.min.y).toBeCloseTo(1.0, 4);
    expect(bb.min.x).toBeCloseTo(15, 4);
    const noPin = bboxOf(buildNeighborMeshes([box()], { groundY: () => 0 }).children[0] as THREE.Mesh);
    expect(noPin.min.x).toBeCloseTo(-5, 4);
    expect(noPin.max.x).toBeCloseTo(5, 4);
  });

  it('航空写真: 屋根に平面投影の UV（ピン基準で写真の範囲に正規化）、far の建物は写真なし', () => {
    const a = aerial();
    const near = buildNeighborMeshes([box()], { groundY: () => 0, pin: PIN, aerial: a }).children[0] as THREE.Mesh;
    const [roof, wall] = near.material as THREE.MeshStandardMaterial[];
    expect(roof.map).not.toBeNull();
    expect(wall.map).toBeNull();
    const uv = near.geometry.getAttribute('uv');
    const pos = near.geometry.getAttribute('position');
    expect(uv).toBeDefined();
    // 屋根の頂点 (x, z) → e = x, n = −z（ピン基準）→ (e − west)/(east − west)
    for (let i = 0; i < 6; i++) {
      expect(uv.getX(i)).toBeCloseTo((pos.getX(i) + 50) / 100, 5);
      expect(uv.getY(i)).toBeCloseTo((-pos.getZ(i) + 50) / 100, 5);
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(1);
    }
    const far = buildNeighborMeshes([{ ...box(), far: true } as Neighbor], { groundY: () => 0, pin: PIN, aerial: a }).children[0] as THREE.Mesh;
    expect((far.material as THREE.MeshStandardMaterial[])[0].map).toBeNull();
    expect(far.geometry.getAttribute('uv')).toBeUndefined();
  });

  it('hidden の建物は作らない。mesh の無い PLATEAU の建物（古い保存データ）は ring の押し出しで描く', () => {
    const hidden: Neighbor = { ...box(), hidden: true };
    expect(buildNeighborMeshes([hidden], { groundY: () => 0, pin: PIN }).children).toHaveLength(0);
    const { mesh: _m, ...noMesh } = box();
    void _m;
    const g = buildNeighborMeshes([noMesh], { groundY: () => 1, pin: PIN });
    expect(g.children).toHaveLength(1);
    const m = g.children[0] as THREE.Mesh;
    expect(m.geometry).toBeInstanceOf(THREE.ExtrudeGeometry);
    const bb = bboxOf(m);
    expect(bb.min.x).toBeCloseTo(15, 4);
    expect(bb.min.y).toBeCloseTo(1, 4);
    expect(bb.max.y).toBeCloseTo(8.3, 4);
  });

  it('接地: DEM の格子内は groundY の最低点 + 0.3、格子の外は zmin − groundElev、DEM 無し／平地は groundY（平地では 0）', () => {
    const inside = box();
    const outside = plateauNeighborAt(PIN, 200, 0, { gmlId: 'bldg_far', h: 7, zmin: 57.2 });
    const groundY = (e: number) => (e > 100 ? 1 : 1); // 格子の外でも 1 を返すが使われない
    const grid = dem(100);
    // 格子内
    expect(plateauBaseY(inside as Neighbor & { plateau: NonNullable<Neighbor['plateau']> }, { groundY, grid, groundElev: 50 })).toBeCloseTo(1.3, 6);
    // 格子の外: zmin − groundElev = 7.2
    expect(plateauBaseY(outside as Neighbor & { plateau: NonNullable<Neighbor['plateau']> }, { groundY, grid, groundElev: 50 })).toBeCloseTo(7.2, 6);
    const g = buildNeighborMeshes([inside, outside], { groundY, pin: PIN, grid, groundElev: 50 });
    const [mi, mo] = g.children as THREE.Mesh[];
    expect(bboxOf(mi).min.y).toBeCloseTo(1.0, 4);
    expect(bboxOf(mi).max.y).toBeCloseTo(8.3, 4);
    expect(bboxOf(mo).min.y).toBeCloseTo(6.9, 4);
    expect(bboxOf(mo).max.y).toBeCloseTo(14.2, 4);
    expect(bboxOf(mo).min.x).toBeCloseTo(195, 3);
    // DEM 無し（grid null）・平地（source 'flat'）: 環境が渡す groundY（0 − 0.3）→ baseY 0。格子の外の規則は使わない
    const flat: HeightGrid = { ...dem(10), source: 'flat' };
    for (const gr of [null, flat]) {
      const m = buildNeighborMeshes([outside], { groundY: () => -0.3, pin: PIN, grid: gr, groundElev: 50 }).children[0] as THREE.Mesh;
      expect(bboxOf(m).min.y).toBeCloseTo(-0.3, 4);
      expect(bboxOf(m).max.y).toBeCloseTo(7, 4);
    }
    // 傾斜: ring の頂点の最低点
    const slope = buildNeighborMeshes([inside], { groundY: (e) => (e > 20 ? 3 : 2), pin: PIN, grid, groundElev: 50 }).children[0] as THREE.Mesh;
    expect(bboxOf(slope).min.y).toBeCloseTo(2.0, 4);
    expect(bboxOf(slope).max.y).toBeCloseTo(9.3, 4);
  });

  it('ピンを 10 m 動かした後（ring は環境側がずらす）: ring と mesh の bbox が同じ量ずれる', () => {
    const a = box();
    const pinB = frameFromLocal(PIN, 10, 0);
    // relocateEnvironment と同じ: ring だけずらし、mesh（anchor 基準）は触らない
    const b: Neighbor = { ...a, ring: a.ring.map((q) => ({ e: q.e - 10, n: q.n })) };
    const ma = buildNeighborMeshes([a], { groundY: () => 0, pin: PIN }).children[0] as THREE.Mesh;
    const mb = buildNeighborMeshes([b], { groundY: () => 0, pin: pinB }).children[0] as THREE.Mesh;
    expect(bboxOf(mb).min.x - bboxOf(ma).min.x).toBeCloseTo(-10, 3);
    expect(bboxOf(mb).min.z).toBeCloseTo(bboxOf(ma).min.z, 3);
    expect(Math.min(...b.ring.map((q) => q.e))).toBeCloseTo(bboxOf(mb).min.x, 3);
    expect(b.mesh).toBe(a.mesh);
  });
});

describe('environment 経由の配置（描く建物・影だけのメッシュ・半透明の表示）', () => {
  beforeEach(() => {
    study.frame = { ...FRAME };
    study.sitePolygon = [];
    study.model = null;
    study.points = [];
    study.grid = null;
    study.aerial = null;
    study.horizon = null;
    study.neighborOverrides = {};
    study.results = { images: [] };
    study.env = { loaded: true, loading: false, error: null, attribution: '' };
    study.neighbors = [plateauNeighborAt(PIN, 20, 0, { gmlId: 'bldg_box', h: 7 }), { id: 'gsi1', ring: [{ e: -30, n: 0 }, { e: -22, n: 0 }, { e: -22, n: 8 }, { e: -30, n: 8 }], height: 7, source: 'gsi', heightKind: 'estimated' }];
    clearStudyOccluderCache();
  });

  it('buildNeighborShadowCasters は描く建物と同じ位置・三角形数、buildNeighborGhosts は焼き込む三角形 0', () => {
    const list = study.neighbors;
    const normal = buildNeighborMeshes(list, { groundY: () => -0.3, pin: PIN, grid: null, groundElev: 50 });
    const casters = buildNeighborShadowCasters(list);
    expect(tri(casters)).toBe(tri(normal));
    expect(tri(casters)).toBeGreaterThan(0);
    const nm = meshesOf(normal).find((m) => m.userData.neighborId === 'plateau:bldg_box')!;
    const cm = meshesOf(casters).find((m) => m.userData.neighborId === 'plateau:bldg_box')!;
    expect(bboxOf(cm).min.toArray()).toEqual(bboxOf(nm).min.toArray());
    expect(bboxOf(cm).max.toArray()).toEqual(bboxOf(nm).max.toArray());
    expect(bboxOf(cm).min.y).toBeCloseTo(-0.3, 4);
    expect(bboxOf(cm).max.y).toBeCloseTo(7, 4);
    expect(cm.userData.shadowOnly).toBe(true);
    const ghosts = buildNeighborGhosts(list.map((n) => ({ ...n, hidden: true })));
    expect(meshesOf(ghosts).map((m) => m.userData.neighborId).sort()).toEqual(['gsi1', 'plateau:bldg_box']);
    expect(tri(ghosts)).toBe(0);
    expect(bakeWorldTriangles([{ root: ghosts, kind: 'neighbor' }]).triangles).toBe(0);
  });

  it('rebuildEnvironment: mesh 建物が描かれ、遮蔽物の三角形数は mesh 12 + 押し出し。表示だけ隠すと影だけのメッシュで同数', () => {
    const scene = fakeScene();
    rebuildEnvironment(scene, null);
    const drawn = meshesOf(scene.groups.neighbors);
    expect(drawn.map((m) => m.userData.neighborId).sort()).toEqual(['gsi1', 'plateau:bldg_box']);
    const pm = drawn.find((m) => m.userData.neighborId === 'plateau:bldg_box')!;
    expect(pm.geometry.getAttribute('position').count).toBe(36);
    expect(bboxOf(pm).min.x).toBeCloseTo(15, 3);
    // 平地（DEM 無し）: 足元 0、壁は −0.3
    expect(bboxOf(pm).min.y).toBeCloseTo(-0.3, 3);
    expect(bboxOf(pm).max.y).toBeCloseTo(7, 3);
    expect(study.neighbors[0].baseElev).toBe(0);
    let occ = buildStudyOccluder(scene, { neighbors: true, building: false, terrain: false });
    const all = occ.triangles;
    const extrude = tri(buildNeighborMeshes([study.neighbors[1]], { groundY: () => -0.3 }));
    expect(all).toBe(12 + extrude);
    disposeStudyOccluder(occ);
    setNeighborsHidden(['plateau:bldg_box'], true, { mode: 'view', reason: 'other' });
    rebuildEnvironment(scene, null);
    const shadowOnly = meshesOf(scene.groups.neighbors).filter((m) => m.userData.shadowOnly);
    expect(shadowOnly.map((m) => m.userData.neighborId)).toEqual(['plateau:bldg_box']);
    occ = buildStudyOccluder(scene, { neighbors: true, building: false, terrain: false });
    expect(occ.triangles).toBe(all);
    disposeStudyOccluder(occ);
    // 計算から除外: 入らない
    setNeighborsHidden(['plateau:bldg_box'], true, { mode: 'exclude', reason: 'demolish' });
    rebuildEnvironment(scene, null);
    occ = buildStudyOccluder(scene, { neighbors: true, building: false, terrain: false });
    expect(occ.triangles).toBe(extrude);
    disposeStudyOccluder(occ);
    clearStudyOccluderCache();
  });

  it('DEM があるとき: 格子内は地形の最低点、格子の外（far）は zmin − groundElev', () => {
    // 100 m 角の DEM（高さ 52 m 一定）。ピンの地盤高 50 → groundY = 2
    const g = dem(100);
    g.values.fill(52);
    study.grid = g;
    study.frame!.groundElev = 50;
    study.neighbors = [plateauNeighborAt(PIN, 20, 0, { gmlId: 'bldg_in', h: 7, zmin: 57.2 }), { ...plateauNeighborAt(PIN, 200, 0, { gmlId: 'bldg_out', h: 7, zmin: 57.2 }), far: true } as Neighbor];
    const scene = fakeScene();
    rebuildEnvironment(scene, null);
    const byId = new Map(meshesOf(scene.groups.neighbors).map((m) => [m.userData.neighborId as string, m]));
    // 格子内: groundY = 52 − 50 = 2 → 環境は 0.3 下げて渡す → 最低点 1.7 + 0.3 = 2.0。壁は −0.3 → 1.7、屋根 9.0
    expect(bboxOf(byId.get('plateau:bldg_in')!).min.y).toBeCloseTo(1.7, 3);
    expect(bboxOf(byId.get('plateau:bldg_in')!).max.y).toBeCloseTo(9.0, 3);
    // 格子の外: 57.2 − 50 = 7.2 → 壁 6.9、屋根 14.2
    expect(bboxOf(byId.get('plateau:bldg_out')!).min.y).toBeCloseTo(6.9, 3);
    expect(bboxOf(byId.get('plateau:bldg_out')!).max.y).toBeCloseTo(14.2, 3);
    clearStudyOccluderCache();
  });
});
