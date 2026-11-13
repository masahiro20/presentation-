// 想定の街並み（パースの背景。scene/town.ts）:
//  - 敷地の両隣・裏・道路の向かいに区画が並ぶ。敷地そのものと道路には重ならない
//  - 区画ごとに家（屋根・窓のある形）が立ち、隠す判定用の範囲（区画・家）が付く
//  - 高低差のある敷地では、隣の区画はその地盤の高さに立ち、横の道・裏の道は作らない
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildTown, type TownFrame } from '../src/scene/town';

const frame = (o: Partial<TownFrame> = {}): TownFrame => ({
  // a = x、q = 道路境界（z = 0）から奥（−z）へ
  toWorld: (a, q, y) => new THREE.Vector3(a, y, -q),
  a0: 0,
  a1: 13,
  depth: 16,
  roadW: 6,
  roadY: 0,
  curb: 0.2,
  levelLeft: 0,
  levelRight: 0,
  levelBack: 0,
  ...o,
});

describe('想定の街並み', () => {
  const town = buildTown(frame());
  const center = (b: THREE.Box3) => b.getCenter(new THREE.Vector3());

  it('両隣・裏・向かいに区画が並び、同じ種からは毎回同じ街並みになる', () => {
    expect(town.lots.length).toBeGreaterThan(30);
    const again = buildTown(frame());
    expect(again.lots.length).toBe(town.lots.length);
    expect(center(again.lots[5].box).x).toBeCloseTo(center(town.lots[5].box).x, 6);
    const cs = town.lots.map((l) => center(l.box));
    // 同じ並びの左隣・右隣（敷地の奥行の中）
    expect(cs.some((c) => c.x < 0 && c.x > -14 && c.z < 0 && c.z > -16)).toBe(true);
    expect(cs.some((c) => c.x > 13 && c.x < 27 && c.z < 0 && c.z > -16)).toBe(true);
    // 裏（z < −16）と、道路の向かい（z > 6.4）
    expect(cs.some((c) => c.z < -16 && c.x > 0 && c.x < 13)).toBe(true);
    expect(cs.some((c) => c.z > 6.4)).toBe(true);
  });

  it('区画は敷地・表の道路に重ならない', () => {
    const site = new THREE.Box3(new THREE.Vector3(0.05, -1, -15.95), new THREE.Vector3(12.95, 20, -0.05));
    const road = new THREE.Box3(new THREE.Vector3(-200, -1, 0.05), new THREE.Vector3(200, 20, 6.15));
    for (const l of town.lots) {
      expect(l.box.intersectsBox(site)).toBe(false);
      expect(l.box.intersectsBox(road)).toBe(false);
    }
  });

  it('家は区画の中に立ち、壁・屋根・窓がある', () => {
    const withHouse = town.lots.filter((l) => l.solid);
    expect(withHouse.length).toBeGreaterThan(town.lots.length * 0.8);
    for (const l of withHouse) {
      const grown = l.box.clone().expandByScalar(0.7);
      expect(grown.containsBox(l.solid!)).toBe(true);
      const keys = [...l.mb.mark().keys()];
      expect(keys.some((k) => k.startsWith('l.nbWall'))).toBe(true);
      expect(keys.some((k) => k.startsWith('l.nbRoof'))).toBe(true);
      // 高さ: 平屋 3 m 以上、2 階建てでも 10 m 以下
      const h = l.solid!.max.y - l.solid!.min.y;
      expect(h).toBeGreaterThan(3);
      expect(h).toBeLessThan(10.5);
    }
    expect(withHouse.some((l) => l.mb.mark().has('l.nbGlass'))).toBe(true);
  });

  it('平らな敷地では裏の道・横の道がある。高低差があれば作らず、隣の区画はその高さに立つ', () => {
    expect(town.roads.mark().has('l.road')).toBe(true);
    const hilly = buildTown(frame({ levelLeft: -0.4, levelBack: 0.5 }));
    expect(hilly.roads.mark().has('l.road')).toBe(false);
    const cs = hilly.lots.map((l) => ({ c: center(l.box), y: l.box.min.y }));
    const left = cs.filter((o) => o.c.x < 0 && o.c.z < 0 && o.c.z > -16);
    expect(left.length).toBeGreaterThan(0);
    for (const o of left) expect(o.y).toBeCloseTo(-0.4, 6);
    const back = cs.filter((o) => o.c.z < -16 && o.c.z > -34);
    expect(back.length).toBeGreaterThan(0);
    for (const o of back) expect(o.y).toBeCloseTo(0.5, 6);
  });

  it('角地: 敷地の横が道路なら、その側は隣家を並べず、敷地のすぐ外に道路を敷く', () => {
    // 右（a の大きい側）に幅 5 m の道路。道路の帯は a = 13 〜 18.2（縁石の分を含む）
    const corner = buildTown(frame({ roadRight: 5 }));
    const band = new THREE.Box3(new THREE.Vector3(13.05, -1, -200), new THREE.Vector3(18.15, 20, 200));
    for (const l of corner.lots) expect(l.box.intersectsBox(band)).toBe(false);
    // 道路の向こう（a > 18.2）には並びが続く。左は今までどおり、すぐ隣に区画
    const cs = corner.lots.map((l) => center(l.box));
    expect(cs.some((c) => c.x > 18.2 && c.x < 34 && c.z < 0 && c.z > -16)).toBe(true);
    expect(cs.some((c) => c.x < 0 && c.x > -14 && c.z < 0 && c.z > -16)).toBe(true);
    // 路面がその帯にある（敷地の奥行の中ほどで確かめる）
    const g = corner.roads.build(() => new THREE.MeshBasicMaterial());
    const road = g.children.find((c) => c.name === 'l.road') as THREE.Mesh;
    const pos = road.geometry.getAttribute('position');
    let covered = false;
    for (let i = 0; i < pos.count; i += 3) {
      const xs = [pos.getX(i), pos.getX(i + 1), pos.getX(i + 2)];
      const zs = [pos.getZ(i), pos.getZ(i + 1), pos.getZ(i + 2)];
      if (Math.min(...xs) < 13.01 + 1e-6 && Math.max(...xs) > 18.19 && Math.min(...zs) < -8 && Math.max(...zs) > -8 && Math.min(...xs) > 12.9) covered = true;
    }
    expect(covered).toBe(true);
    // 高低差のある敷地・軽い表示でも、図面にある道路は敷く
    expect(buildTown(frame({ roadRight: 5, levelLeft: -0.4 })).roads.mark().has('l.road')).toBe(true);
    expect(buildTown(frame({ roadLeft: 4, light: true })).roads.mark().has('l.road')).toBe(true);
  });

  it('裏も道路の敷地: 裏の並びは、その道路の向こうに立つ', () => {
    const through = buildTown(frame({ roadBack: 4 }));
    // 道路の帯は q = 16 〜 20.2（z = −16 〜 −20.2）
    const band = new THREE.Box3(new THREE.Vector3(-200, -1, -20.15), new THREE.Vector3(200, 20, -16.05));
    for (const l of through.lots) expect(l.box.intersectsBox(band)).toBe(false);
    expect(through.lots.some((l) => center(l.box).z < -20.4 && center(l.box).x > 0 && center(l.box).x < 13)).toBe(true);
  });

  it('軽い表示では並びを減らし、木を省く', () => {
    const light = buildTown(frame({ light: true }));
    expect(light.lots.length).toBeLessThan(town.lots.length * 0.6);
    expect(light.lots.every((l) => !l.mb.mark().has('l.trunk'))).toBe(true);
  });
});
