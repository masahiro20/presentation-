// 3D 間取り図の構図（海外の 3D フロアプランの見せ方）: 階ごとに 1 枚、真上に近い角度・狭い画角で、壁の向きにそろえて見る
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { exteriorShots } from '../src/scene/shots';
import type { SiteInfo } from '../src/scene/landscape';
import type { BuildingMeta } from '../src/scene/building';

const V = (x: number, z: number, y = 0) => new THREE.Vector3(x, y, z);
const square = (x0: number, z0: number, x1: number, z1: number) => [[new THREE.Vector2(x0, z0), new THREE.Vector2(x1, z0), new THREE.Vector2(x1, z1), new THREE.Vector2(x0, z1)]];
const meta = (): BuildingMeta =>
  ({
    bbox: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 6.5, 8)),
    rooms: [],
    entrance: { pos: new THREE.Vector3(5, 0, 8), outward: new THREE.Vector3(0, 0, 1), width: 0.9, level: 1, openingId: 'e' },
    wallTop: [2.9, 5.8],
    doorLeaves: [],
    doors: [],
    outlines: [
      { level: 1, y: 0.5, polys: square(0, 0, 10, 8) },
      { level: 2, y: 3.4, polys: square(0, 0, 10, 6) },
    ],
    topY: 6.5,
    sashes: [],
    downlights: [],
  }) as unknown as BuildingMeta;
const site: SiteInfo = { min: new THREE.Vector2(-3, -3), max: new THREE.Vector2(13, 12), roadDir: V(0, 1), roadCenter: V(5, 15), parking: null, fences: [] };

describe('3D 間取り図の構図', () => {
  const shots = exteriorShots(meta(), site, { maxY: 6.5, eaveY: 6 }).filter((s) => s.plan);
  it('階ごとに 1 枚（輪切りの階を指定し、周りを消す印が付く）', () => {
    expect(shots.map((s) => s.cutaway)).toEqual([1, 2]);
    expect(shots.every((s) => s.kind === 'cutaway' && s.title.includes('3D間取り図'))).toBe(true);
  });
  it('真上に近い角度（55° 以上）・狭い画角（30° 以下）で、遠近の歪みが少ない', () => {
    for (const s of shots) {
      const d = s.view.pos.clone().sub(s.view.target);
      const elev = (Math.atan2(d.y, Math.hypot(d.x, d.z)) * 180) / Math.PI;
      expect(elev).toBeGreaterThan(55);
      expect(s.view.fov).toBeLessThanOrEqual(30);
    }
  });
  it('壁の向き（x・z の軸）にそろえて、道路側から見る', () => {
    for (const s of shots) {
      const d = s.view.pos.clone().sub(s.view.target).setY(0).normalize();
      expect(Math.abs(d.x)).toBeLessThan(1e-6);
      expect(d.z).toBeGreaterThan(0.99);
    }
  });
});
