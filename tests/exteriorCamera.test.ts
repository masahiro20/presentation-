// 外観のカットのカメラ: 塀の向こうから撮らない。
//  - 敷地の際・庭を囲む塀（高さ 1.7m）の外に、目の高さのカメラが出ると、塀しか写らない
//    （林様邸: 庭側のカットで 1 階と庭が塀に隠れていた。大崎様邸: 北の塀の 1m 外で、画面いっぱいが塀）
//  - 向きを少し振る・塀の内側まで寄る（寄ったぶん画角を広げる）・それでも隠れるなら、塀越しに少し高い所から
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { exteriorShots, viewBlocked } from '../src/scene/shots';
import { buildLandscape, type SiteFence, type SiteInfo } from '../src/scene/landscape';
import { exteriorById } from '../src/styles/presets';
import type { BuildingMeta } from '../src/scene/building';

const V = (x: number, z: number, y = 0) => new THREE.Vector3(x, y, z);
/** 10 × 8 m・高さ 6.5 m の建物。道路は +z（図面の下）側 */
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
  downlights: [],
});
const roof = { maxY: 6.5, eaveY: 6 };
/** 敷地（x0〜x1・z0〜z1）。道路側（z1）は開けて、奥と両脇（建物の正面より奥）に高さ 1.74m の塀 */
const site = (x0: number, z0: number, x1: number, z1: number, fenced = true): SiteInfo => {
  const fences: SiteFence[] = fenced
    ? [
        { a: V(x0, z0), b: V(x1, z0), top: 1.74 },
        { a: V(x0, z0), b: V(x0, 7.5), top: 1.74 },
        { a: V(x1, z0), b: V(x1, 7.5), top: 1.74 },
      ]
    : [];
  return { min: new THREE.Vector2(x0, z0), max: new THREE.Vector2(x1, z1), roadDir: V(0, 1), roadCenter: V((x0 + x1) / 2, z1 + 3), parking: null, fences };
};
const shot = (s: SiteInfo, id: string) => exteriorShots(meta(), s, roof).find((x) => x.id === id)!;

describe('視線が塀・手前の木に遮られる割合（viewBlocked）', () => {
  const box = meta().bbox;
  const back: SiteFence[] = [{ a: V(-20, -6), b: V(30, -6), top: 1.74 }];

  it('目の高さ 1.5m では、間にある 1.74m の塀は必ず遮る。塀の内側からは遮らない', () => {
    expect(viewBlocked(V(5, -12, 1.5), box, back)).toBe(1);
    expect(viewBlocked(V(5, -5, 1.5), box, back)).toBe(0);
  });

  it('高い所からは、カメラに近い塀は越えて見える。建物のすぐ前の塀は足もとを隠す', () => {
    // カメラ（z = -20・高さ 4.8）から建物の北面（z = 0）へ。塀は z = -6（視線の 7 割の所）→ 視線の高さ 1.44m で塀の下
    expect(viewBlocked(V(5, -20, 4.8), box, back)).toBe(1);
    // 塀がカメラの近く（z = -17: 視線の 15% の所。視線の高さ 4.08m）なら越える
    expect(viewBlocked(V(5, -20, 4.8), box, [{ a: V(-20, -17), b: V(30, -17), top: 1.74 }])).toBe(0);
  });

  it('カメラのすぐ前の木は 7 割の重みで数える。建物のそばの木（視線の奥半分）は数えない', () => {
    const near = viewBlocked(V(5, -20, 1.5), box, [], [{ x: 5, z: -17, r: 1.2 }]);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(0.71);
    expect(viewBlocked(V(5, -20, 1.5), box, [], [{ x: 5, z: -2, r: 1.2 }])).toBe(0);
  });
});

describe('外観のカットは、塀の向こうから撮らない', () => {
  it('塀が無ければ、目の高さ 1.5m・画角 38° のまま', () => {
    const s = site(-20, -14, 30, 14, false);
    for (const id of ['ext-front', 'ext-front2', 'ext-garden']) {
      const v = shot(s, id).view;
      expect(v.pos.y).toBeCloseTo(1.5, 5);
      expect(v.fov).toBe(38);
    }
  });

  it('広い敷地: 庭側のカットは、奥の塀の内側まで寄って目の高さで撮る（寄ったぶん画角を広げる）', () => {
    const open = shot(site(-20, -10, 30, 14, false), 'ext-garden').view;
    const s = site(-20, -10, 30, 14);
    const v = shot(s, 'ext-garden').view;
    // 塀が無いときのカメラは奥の塀（z = -10）の外
    expect(open.pos.z).toBeLessThan(-10);
    expect(viewBlocked(open.pos, meta().bbox, s.fences!)).toBeGreaterThan(0.5);
    // 塀があるとき: 塀の内側・目の高さ・足もとまで見える
    expect(v.pos.z).toBeGreaterThan(-10);
    expect(v.pos.y).toBeCloseTo(1.5, 5);
    expect(viewBlocked(v.pos, meta().bbox, s.fences!)).toBe(0);
    expect(v.fov).toBeGreaterThanOrEqual(38);
    expect(v.fov).toBeLessThanOrEqual(62);
  });

  it('狭い敷地（塀まで 4m）: 目の高さでは引けないので、塀越しに少し高い所から（足もとは塀に隠れても、目の高さよりは見える）', () => {
    const s = site(-4, -4, 14, 14);
    const open = shot(site(-4, -4, 14, 14, false), 'ext-garden').view;
    const v = shot(s, 'ext-garden').view;
    expect(viewBlocked(open.pos, meta().bbox, s.fences!)).toBe(1);
    expect(v.pos.y).toBeGreaterThan(1.5);
    expect(v.pos.y).toBeLessThanOrEqual(4.8);
    expect(viewBlocked(v.pos, meta().bbox, s.fences!)).toBeLessThan(0.75);
    // 高い所からでも、画角は標準のまま（建物全体が収まる距離）
    expect(v.fov).toBe(38);
  });

  it('道路側のカットは、道路（塀の無い側）から目の高さのまま', () => {
    for (const s of [site(-20, -10, 30, 14), site(-4, -4, 14, 14)]) {
      const v = shot(s, 'ext-front').view;
      expect(v.pos.y).toBeCloseTo(1.5, 5);
      expect(v.pos.z).toBeGreaterThan(8);
      expect(viewBlocked(v.pos, meta().bbox, s.fences!)).toBeLessThan(0.3);
    }
  });
});

describe('外構は、目の高さより高い塀を敷地の情報に残す', () => {
  it('木の縦格子の塀（基壇 0.5 + 格子 1.2）: 区間ごとに天端 1.74m。庭木の位置も渡す', () => {
    const r = buildLandscape(meta(), exteriorById('hl-jolypat-grey'), { roads: [{ side: 'bottom', source: 'manual', widthMm: 4000 }], bounds: {} });
    expect(r.site.fences!.length).toBeGreaterThan(0);
    for (const f of r.site.fences!) expect(f.top).toBeCloseTo(1.74, 2);
    expect(r.site.trees).toBe(r.plan.trees);
  });
});
