/**
 * NeighborMesh → BufferGeometry（src/sun/plateau/geometry.ts）: groups 2（屋根・壁）、heightScale は上端だけ伸ばし下端は不変、
 * sinkBottom は足元（y ≤ 0.05）の頂点だけ下げる、法線は面法線、roofUV は航空写真の範囲で 0..1。
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildPlateauGeometry } from '../src/sun/plateau/geometry';
import type { NeighborMesh } from '../src/sun/plateau/types';

/** 切妻の家: 足元 10 × 8（x −5..5、z −4..4）、軒 6 m、棟 8 m。屋根 4 枚（勾配 2/4 → 法線 y 0.89）+ 妻壁 2 + 底 2 + 壁 8 */
function gableHouse(): NeighborMesh {
  const x0 = -5;
  const x1 = 5;
  const z0 = -4;
  const z1 = 4;
  const e = 6;
  const r = 8;
  const quad = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
  const roof = [
    // 南側（+z）の屋根面: 軒 (z1, e) → 棟 (0, r)。上向き
    ...quad([x0, e, z1], [x1, e, z1], [x1, r, 0], [x0, r, 0]),
    // 北側（−z）
    ...quad([x1, e, z0], [x0, e, z0], [x0, r, 0], [x1, r, 0]),
  ];
  const walls = [
    // 妻壁（三角形）
    x1, 0, z1, x1, 0, z0, x1, r, 0,
    x1, 0, z1, x1, r, 0, x1, e, z1,
    x1, e, z0, x1, 0, z0, x1, r, 0,
    x0, 0, z0, x0, 0, z1, x0, r, 0,
    // 長手の壁
    ...quad([x0, 0, z1], [x1, 0, z1], [x1, e, z1], [x0, e, z1]),
    ...quad([x1, 0, z0], [x0, 0, z0], [x0, e, z0], [x1, e, z0]),
    // 底（下向き）
    ...quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]),
  ];
  return { tris: new Float32Array([...roof, ...walls]), roofTriangles: roof.length / 9 };
}

const bbox = (geo: THREE.BufferGeometry) => {
  geo.computeBoundingBox();
  return geo.boundingBox!;
};

describe('buildPlateauGeometry', () => {
  it('position/normal を持ち、groups は 2（0 = 屋根 = roofTriangles × 3、1 = 残り）。index 無し', () => {
    const m = gableHouse();
    const geo = buildPlateauGeometry(m);
    expect(geo.index).toBeNull();
    const pos = geo.getAttribute('position');
    expect(pos.count).toBe(m.tris.length / 3);
    expect(geo.getAttribute('normal').count).toBe(pos.count);
    expect(geo.getAttribute('uv')).toBeUndefined();
    expect(geo.groups).toHaveLength(2);
    expect(geo.groups[0]).toMatchObject({ start: 0, count: m.roofTriangles * 3, materialIndex: 0 });
    expect(geo.groups[1]).toMatchObject({ start: m.roofTriangles * 3, count: pos.count - m.roofTriangles * 3, materialIndex: 1 });
    // 屋根グループの法線は上向き（勾配 2/4: y = 4/√20 ≈ 0.894）
    const nor = geo.getAttribute('normal');
    for (let i = 0; i < m.roofTriangles * 3; i++) expect(nor.getY(i)).toBeCloseTo(0.894, 2);
    // 底面の法線は下向き
    const n = pos.count;
    expect(nor.getY(n - 1)).toBeCloseTo(-1, 5);
    const b = bbox(geo);
    expect(b.min.y).toBeCloseTo(0, 6);
    expect(b.max.y).toBeCloseTo(8, 6);
    expect(b.min.x).toBeCloseTo(-5, 6);
    expect(b.max.z).toBeCloseTo(4, 6);
  });

  it('heightScale 2: bbox の上端が 2 倍（8 → 16）、下端は不変。軒も 2 倍（6 → 12）', () => {
    const m = gableHouse();
    const geo = buildPlateauGeometry(m, { heightScale: 2 });
    const b = bbox(geo);
    expect(b.min.y).toBeCloseTo(0, 6);
    expect(b.max.y).toBeCloseTo(16, 6);
    const pos = geo.getAttribute('position');
    const ys = new Set<number>();
    for (let i = 0; i < pos.count; i++) ys.add(Math.round(pos.getY(i) * 1000) / 1000);
    expect([...ys].sort((a, b2) => a - b2)).toEqual([0, 12, 16]);
    // 水平は変えない
    expect(b.min.x).toBeCloseTo(-5, 6);
    expect(b.max.x).toBeCloseTo(5, 6);
  });

  it('sinkBottom 0.3: 足元（y ≤ 0.05）の頂点だけ −0.3、屋根・軒は動かない。heightScale と併用できる', () => {
    const m = gableHouse();
    const geo = buildPlateauGeometry(m, { sinkBottom: 0.3 });
    const b = bbox(geo);
    expect(b.min.y).toBeCloseTo(-0.3, 6);
    expect(b.max.y).toBeCloseTo(8, 6);
    const pos = geo.getAttribute('position');
    const ys = new Set<number>();
    for (let i = 0; i < pos.count; i++) ys.add(Math.round(pos.getY(i) * 1000) / 1000);
    expect([...ys].sort((a, b2) => a - b2)).toEqual([-0.3, 6, 8]);
    const both = bbox(buildPlateauGeometry(m, { sinkBottom: 0.3, heightScale: 1.5 }));
    expect(both.min.y).toBeCloseTo(-0.3, 6);
    expect(both.max.y).toBeCloseTo(12, 6);
    // 0.05 ちょうどは足元、0.06 は足元ではない
    const low = buildPlateauGeometry({ tris: new Float32Array([0, 0.05, 0, 1, 0.06, 0, 0, 1, -1]), roofTriangles: 0 }, { sinkBottom: 0.3 });
    const lp = low.getAttribute('position');
    expect(lp.getY(0)).toBeCloseTo(-0.25, 6);
    expect(lp.getY(1)).toBeCloseTo(0.06, 6);
  });

  it('roofUV: 全頂点に航空写真の範囲で平面投影した uv（0..1）。toEN で anchor 基準 → ピン基準に写す', () => {
    const m = gableHouse();
    // 建物は anchor 基準。航空写真はピン基準で e −50..50・n −50..50、anchor はピンから東 20・北 10
    const off = { e: 20, n: 10 };
    const geo = buildPlateauGeometry(m, { roofUV: { west: -50, east: 50, south: -50, north: 50, toEN: (x, z) => ({ e: x + off.e, n: -z + off.n }) } });
    const uv = geo.getAttribute('uv');
    const pos = geo.getAttribute('position');
    expect(uv.count).toBe(pos.count);
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      // 既存の押し出し（neighbors.ts）と同じ式: u = (e − west)/(east − west), v = (n − south)/(north − south)
      expect(u).toBeCloseTo((pos.getX(i) + off.e + 50) / 100, 6);
      expect(v).toBeCloseTo((-pos.getZ(i) + off.n + 50) / 100, 6);
    }
    // 建物の東端（x=5 → e=25）は u 0.75、北端（z=−4 → n=14）は v 0.64
    let maxU = 0;
    let maxV = 0;
    for (let i = 0; i < uv.count; i++) {
      maxU = Math.max(maxU, uv.getX(i));
      maxV = Math.max(maxV, uv.getY(i));
    }
    expect(maxU).toBeCloseTo(0.75, 6);
    expect(maxV).toBeCloseTo(0.64, 6);
    // null なら uv 無し
    expect(buildPlateauGeometry(m, { roofUV: null }).getAttribute('uv')).toBeUndefined();
  });

  it('roofTriangles が 0・全部でも groups は 2（count 0 のグループを含む）。入力の tris は変更しない', () => {
    const m = gableHouse();
    const before = Array.from(m.tris);
    const g0 = buildPlateauGeometry({ ...m, roofTriangles: 0 }, { heightScale: 3, sinkBottom: 1 });
    expect(g0.groups).toHaveLength(2);
    expect(g0.groups[0].count).toBe(0);
    expect(g0.groups[1].count).toBe(m.tris.length / 3);
    const gAll = buildPlateauGeometry({ ...m, roofTriangles: 1000 });
    expect(gAll.groups[0].count).toBe(m.tris.length / 3);
    expect(gAll.groups[1].count).toBe(0);
    expect(Array.from(m.tris)).toEqual(before);
    // Mesh にマテリアル配列で載せられる（既存の [屋根, 壁] 契約）
    const mesh = new THREE.Mesh(buildPlateauGeometry(m), [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]);
    expect(Array.isArray(mesh.material)).toBe(true);
  });
});
