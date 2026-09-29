/**
 * 外構・敷地の自動生成
 * 玄関の向きを「道路側」とし、駐車スペース・アプローチ・植栽・フェンスを配置する。
 */
import * as THREE from 'three';
import { MeshBuilder, V } from './meshBuilder';
import type { BuildingMeta } from './building';
import type { ExteriorStyle } from '../styles/presets';
import { mulberry32 } from '../styles/noise';

export interface SiteInfo {
  /** 敷地の範囲（ワールド） */
  min: THREE.Vector2;
  max: THREE.Vector2;
  /** 道路側の向き（外向き単位ベクトル） */
  roadDir: THREE.Vector3;
  /** 道路の中心線上の点 */
  roadCenter: THREE.Vector3;
  parking: { center: THREE.Vector3; along: THREE.Vector3 } | null;
}

export function buildLandscape(meta: BuildingMeta, style: ExteriorStyle): { mb: MeshBuilder; site: SiteInfo; trees: MeshBuilder } {
  const mb = new MeshBuilder();
  const trees = new MeshBuilder();
  const b = meta.bbox;
  const ent = meta.entrance;
  // 道路方向: 玄関の外向き（軸に丸める）
  let road = ent ? ent.outward.clone() : V(0, 0, 1);
  if (Math.abs(road.x) > Math.abs(road.z)) road = V(Math.sign(road.x), 0, 0);
  else road = V(0, 0, Math.sign(road.z) || 1);
  const front = 6.0; // 道路側の余白（駐車場）
  const side = 1.6;
  const back = 2.2;
  const min = new THREE.Vector2(b.min.x - side, b.min.z - side);
  const max = new THREE.Vector2(b.max.x + side, b.max.z + side);
  if (road.x > 0) max.x = b.max.x + front;
  if (road.x < 0) min.x = b.min.x - front;
  if (road.z > 0) max.y = b.max.z + front;
  if (road.z < 0) min.y = b.min.z - front;
  // 裏側
  if (road.x > 0) min.x = b.min.x - back;
  if (road.x < 0) max.x = b.max.x + back;
  if (road.z > 0) min.y = b.min.z - back;
  if (road.z < 0) max.y = b.max.z + back;

  // 敷地（芝・砂利など）: 少し高くして周囲の地面と区別
  const gy = 0.0;
  mb.quad('l.ground', V(min.x, gy, min.y), V(min.x, gy, max.y), V(max.x, gy, max.y), V(max.x, gy, min.y), V(1, 0, 0), V(0, 0, 1));
  // 周辺の地面（広く）
  const R = 120;
  const cx = (min.x + max.x) / 2;
  const cz = (min.y + max.y) / 2;
  mb.quad('l.far', V(cx - R, -0.02, cz - R), V(cx - R, -0.02, cz + R), V(cx + R, -0.02, cz + R), V(cx + R, -0.02, cz - R), V(1, 0, 0), V(0, 0, 1));

  // 道路（幅 6m）
  const roadW = 6;
  let roadCenter: THREE.Vector3;
  if (road.x !== 0) {
    const x0 = road.x > 0 ? max.x + 0.2 : min.x - 0.2 - roadW;
    mb.quad('l.road', V(x0, 0.005, cz - 60), V(x0, 0.005, cz + 60), V(x0 + roadW, 0.005, cz + 60), V(x0 + roadW, 0.005, cz - 60), V(1, 0, 0), V(0, 0, 1));
    roadCenter = V(x0 + roadW / 2, 0, cz);
    // 縁石
    mb.aabb('l.curb', V(road.x > 0 ? max.x : min.x - 0.2, 0, cz - 60), V(road.x > 0 ? max.x + 0.2 : min.x, 0.12, cz + 60));
  } else {
    const z0 = road.z > 0 ? max.y + 0.2 : min.y - 0.2 - roadW;
    mb.quad('l.road', V(cx - 60, 0.005, z0), V(cx - 60, 0.005, z0 + roadW), V(cx + 60, 0.005, z0 + roadW), V(cx + 60, 0.005, z0), V(1, 0, 0), V(0, 0, 1));
    roadCenter = V(cx, 0, z0 + roadW / 2);
    mb.aabb('l.curb', V(cx - 60, 0, road.z > 0 ? max.y : min.y - 0.2), V(cx + 60, 0.12, road.z > 0 ? max.y + 0.2 : min.y));
  }

  // 駐車スペース（道路側の余白。玄関アプローチの横）
  const along = road.x !== 0 ? V(0, 0, 1) : V(1, 0, 0);
  const frontEdge = road.x > 0 ? b.max.x : road.x < 0 ? b.min.x : road.z > 0 ? b.max.z : b.min.z;
  const siteEdge = road.x > 0 ? max.x : road.x < 0 ? min.x : road.z > 0 ? max.y : min.y;
  const entAlong = ent ? ent.pos.dot(along) : (road.x !== 0 ? cz : cx);
  const alongMin = road.x !== 0 ? min.y : min.x;
  const alongMax = road.x !== 0 ? max.y : max.x;
  // 玄関から遠い側に駐車場
  const parkW = 5.4;
  const room1 = entAlong - alongMin;
  const room2 = alongMax - entAlong;
  const parkSign = room1 > room2 ? -1 : 1;
  const parkCenterAlong = parkSign < 0 ? Math.max(alongMin + parkW / 2 + 0.3, entAlong - 1.4 - parkW / 2) : Math.min(alongMax - parkW / 2 - 0.3, entAlong + 1.4 + parkW / 2);
  const depthA = Math.min(frontEdge, siteEdge) + 0.3;
  const depthB = Math.max(frontEdge, siteEdge);
  const toWorld = (a: number, d: number, y: number) => (road.x !== 0 ? V(d, y, a) : V(a, y, d));
  const rect = (key: string, a0: number, a1: number, d0: number, d1: number, y: number) => {
    const p = [toWorld(a0, d0, y), toWorld(a1, d0, y), toWorld(a1, d1, y), toWorld(a0, d1, y)];
    const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
    if (n.y < 0) mb.quad(key, p[0], p[3], p[2], p[1], V(1, 0, 0), V(0, 0, 1));
    else mb.quad(key, p[0], p[1], p[2], p[3], V(1, 0, 0), V(0, 0, 1));
  };
  rect('l.driveway', parkCenterAlong - parkW / 2, parkCenterAlong + parkW / 2, depthA - 0.3, depthB, 0.012);
  const parking = { center: toWorld(parkCenterAlong, (depthA + depthB) / 2, 0), along };

  // アプローチ（玄関ポーチから道路まで）
  if (ent) {
    rect('l.approach', entAlong - 0.65, entAlong + 0.65, depthA + 1.2, depthB, 0.018);
  }

  // フェンス・生垣（道路側以外の3辺）
  const rnd = mulberry32(42);
  const fenceType = style.landscape.fence;
  const edges: [THREE.Vector3, THREE.Vector3][] = [
    [V(min.x, 0, min.y), V(max.x, 0, min.y)],
    [V(max.x, 0, min.y), V(max.x, 0, max.y)],
    [V(max.x, 0, max.y), V(min.x, 0, max.y)],
    [V(min.x, 0, max.y), V(min.x, 0, min.y)],
  ];
  for (const [a, c] of edges) {
    const mid = a.clone().add(c).multiplyScalar(0.5);
    const out = mid.clone().sub(V(cx, 0, cz));
    const isRoadSide = out.normalize().dot(road) > 0.9;
    if (isRoadSide) continue;
    const dir = c.clone().sub(a);
    const L = dir.length();
    dir.normalize();
    if (fenceType === 'block' || fenceType === 'wood') {
      mb.box('l.block', mid.clone(), dir, L, 0.4, 0.12);
      if (fenceType === 'wood') {
        const n = Math.floor(L / 0.12);
        for (let i = 0; i < n; i += 1) {
          if (i % 2) continue;
          const p = a.clone().addScaledVector(dir, (i + 0.5) * 0.12).setY(0.4);
          mb.box('l.fenceWood', p, dir, 0.09, 0.8, 0.02);
        }
        mb.box('l.fenceWood', mid.clone().setY(1.15), dir, L, 0.04, 0.05);
      }
    } else if (fenceType === 'hedge') {
      const n = Math.max(1, Math.floor(L / 0.9));
      for (let i = 0; i < n; i++) {
        const p = a.clone().addScaledVector(dir, (i + 0.5) * (L / n));
        trees.sphere('l.leafDark', p.setY(0.6), 0.55 + rnd() * 0.1, 9, 1.1);
      }
    }
  }

  // 植栽: シンボルツリー（アプローチ脇）と庭木
  const addTree = (p: THREE.Vector3, h: number, kind: 'natural' | 'japanese' | 'modern') => {
    const trunkH = h * 0.45;
    trees.cylinder('l.trunk', p.clone().setY(0), 0.06 * (h / 4), trunkH, 8);
    const leafKey = kind === 'japanese' ? 'l.leafDark' : kind === 'modern' ? 'l.leafLight' : 'l.leaf';
    const n = kind === 'modern' ? 5 : 8;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const r = rnd() * h * 0.18;
      const y = trunkH + rnd() * h * 0.45;
      const s = h * (0.13 + rnd() * 0.09);
      trees.sphere(leafKey, V(p.x + Math.cos(a) * r, y, p.z + Math.sin(a) * r), s, 8, 0.85);
    }
    trees.sphere(leafKey, V(p.x, trunkH + h * 0.35, p.z), h * 0.2, 9, 0.9);
  };
  const shrub = (p: THREE.Vector3, s: number) => trees.sphere('l.leafDark', p.setY(s * 0.6), s, 8, 0.7);
  const kind = style.landscape.trees;
  if (ent) {
    const tp = toWorld(entAlong + 1.6 * -parkSign, depthB - 1.0, 0);
    addTree(tp, 4.2, kind);
    shrub(toWorld(entAlong + 1.0 * -parkSign, depthB - 0.5, 0), 0.35);
    shrub(toWorld(entAlong + 2.2 * -parkSign, depthB - 0.6, 0), 0.4);
  }
  // 裏庭・側面
  const backCenter = road.clone().multiplyScalar(-1);
  const bpos = V(cx, 0, cz).addScaledVector(backCenter, (road.x !== 0 ? max.x - min.x : max.y - min.y) / 2 - 0.9);
  addTree(bpos.clone().addScaledVector(along, (alongMax - alongMin) * 0.35), 3.6, kind);
  addTree(bpos.clone().addScaledVector(along, -(alongMax - alongMin) * 0.38), 3.0, kind);
  for (let i = 0; i < 5; i++) shrub(bpos.clone().addScaledVector(along, (rnd() - 0.5) * (alongMax - alongMin) * 0.8), 0.3 + rnd() * 0.2);

  return {
    mb,
    trees,
    site: { min, max, roadDir: road, roadCenter, parking },
  };
}
