import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { streetProgram } from '../src/video/paths';
import type { BuildingMeta } from '../src/scene/building';
import type { SiteInfo } from '../src/scene/landscape';

const meta = { bbox: new THREE.Box3(new THREE.Vector3(-5, 0, -4), new THREE.Vector3(5, 6.5, 4)), topY: 6.5 } as unknown as BuildingMeta;
const site: SiteInfo = { min: new THREE.Vector2(-8, -7), max: new THREE.Vector2(8, 9), roadDir: new THREE.Vector3(0, 0, 1), roadCenter: new THREE.Vector3(0, 0, 12), parking: null };

describe('街並みの下絵のカメラ', () => {
  const p = streetProgram(meta, site, 16);
  it('前半は目線の高さで道路（家側）を歩き、家の前で止まる', () => {
    const s0 = p.sample(0);
    expect(s0.pos.y).toBeCloseTo(1.55, 2);
    expect(s0.pos.z).toBeCloseTo(12.8, 1); // 道路の向こう側の車線（中心線より 0.8m 先）
    const s1 = p.sample(16 * 0.45 - 0.01);
    expect(s1.pos.y).toBeCloseTo(1.55, 2);
    expect(Math.abs(s1.pos.x)).toBeLessThan(4);
    // 歩く向き（道に沿って。roadDir=(0,0,1) なら along=(-1,0,0) で x は減る）は単調で、22m 先から歩き始める
    expect(s0.pos.x).toBeCloseTo(22, 1);
    let prev = s0.pos.x;
    for (let t = 0.5; t < 7; t += 0.5) {
      const x = p.sample(t).pos.x;
      expect(x).toBeLessThanOrEqual(prev + 1e-6);
      prev = x;
    }
  });
  it('後半は上がりながら引いて街を見下ろし、カメラはつながっている（カット無し）', () => {
    const a = p.sample(16 * 0.45 - 0.001);
    const b = p.sample(16 * 0.45 + 0.001);
    expect(a.pos.distanceTo(b.pos)).toBeLessThan(0.1);
    // 回り込む前に先に上がる: 後半の 15% で 2 階建ての屋根（約 8m）より高い
    expect(p.sample(16 * (0.45 + 0.55 * 0.15)).pos.y).toBeGreaterThan(8);
    const end = p.sample(16);
    expect(end.pos.y).toBeGreaterThan(20);
    expect(Math.hypot(end.pos.x, end.pos.z)).toBeGreaterThan(20);
    expect(end.target.y).toBeLessThan(2);
    expect(end.fade).toBe(0);
    for (let t = 0; t <= 16; t += 0.25) expect(p.sample(t).fade).toBe(0);
  });
});
