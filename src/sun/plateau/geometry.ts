/**
 * NeighborMesh → three の BufferGeometry（position/normal(/uv)、groups: 0 = 屋根, 1 = 壁。局所座標のまま、配置は呼び出し側）。
 *
 * y' = y × heightScale; if (y ≤ 0.05) y' −= sinkBottom（壁の下端だけ伸ばす。屋根は動かない）。
 * 法線は computeVertexNormals()（非インデックスなので面法線）。roofUV があれば全頂点に平面投影 UV（勾配屋根にも貼れる。
 * 既存の押し出し（src/sunstudy/neighbors.ts）と同じ (e − west)/(east − west), (n − south)/(north − south)）。
 * グループは常に 2 つ（屋根が 0 枚でも count 0 で入れる）。new THREE.Mesh(geo, [roofMat, wallMat]) で塗り分ける（既存のマテリアル配列契約）。
 * 仕様: scratchpad/plateau-spec.md §2.10（W7 が実装）
 */
import * as THREE from 'three';
import type { EN, NeighborMesh } from './types';

/** 航空写真の範囲（局所 m）と、局所座標 → 東・北 の写像（anchor 基準 → ピン基準など） */
export interface RoofUVSpec {
  west: number;
  east: number;
  south: number;
  north: number;
  toEN: (xLocal: number, zLocal: number) => EN;
}

export interface PlateauGeometryOptions {
  /** 既定 1 */
  heightScale?: number;
  /** 既定 0: y ≤ 0.05 の頂点をこの分下げる */
  sinkBottom?: number;
  roofUV?: RoofUVSpec | null;
}

/** 「足元」とみなす y の上限 [m]（この高さ以下の頂点を sinkBottom で下げる）。Float32 の丸め（0.05 → 0.0500000007）を吸う余裕を足す */
const BOTTOM_Y = 0.05 + 1e-6;

export function buildPlateauGeometry(mesh: NeighborMesh, opts?: PlateauGeometryOptions): THREE.BufferGeometry {
  const heightScale = opts?.heightScale ?? 1;
  const sink = opts?.sinkBottom ?? 0;
  const roofUV = opts?.roofUV ?? null;
  const src = mesh.tris;
  const nVerts = Math.floor(src.length / 9) * 3;
  const pos = new Float32Array(nVerts * 3);
  for (let i = 0; i < nVerts; i++) {
    const x = src[i * 3];
    const y = src[i * 3 + 1];
    const z = src[i * 3 + 2];
    pos[i * 3] = x;
    pos[i * 3 + 1] = y * heightScale - (y <= BOTTOM_Y ? sink : 0);
    pos[i * 3 + 2] = z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const roofVerts = Math.max(0, Math.min(nVerts, Math.floor(mesh.roofTriangles) * 3));
  geo.addGroup(0, roofVerts, 0);
  geo.addGroup(roofVerts, nVerts - roofVerts, 1);
  geo.computeVertexNormals();
  if (roofUV) {
    const uv = new Float32Array(nVerts * 2);
    const dE = roofUV.east - roofUV.west;
    const dN = roofUV.north - roofUV.south;
    for (let i = 0; i < nVerts; i++) {
      const en = roofUV.toEN(src[i * 3], src[i * 3 + 2]);
      uv[i * 2] = dE > 0 ? (en.e - roofUV.west) / dE : 0;
      uv[i * 2 + 1] = dN > 0 ? (en.n - roofUV.south) / dN : 0;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  return geo;
}
