// 3D の質の底上げ（2026-11-13。参考にした内観ウォークスルーの水準へ）:
//  - 部屋の映り込み: 標準・物理マテリアルのシェーダーに、部屋の箱で位置を合わせた反射を足す（roomProbe.ts）
//  - 窓からの光: 外壁の窓を「光の入口」として並べる（interiorLights.ts の windowPortals）
//  - 内観の日差し: 部屋の窓から斜めに差し込む向きを選ぶ。太陽が通らない北向きの窓からは差し込ませない（shots.ts）
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { patchRoomProbe, roomProbeUniforms } from '../src/scene/roomProbe';
import { windowPortals } from '../src/scene/interiorLights';
import { buildBuilding } from '../src/scene/building';
import { interiorShots, type RayFn } from '../src/scene/shots';
import { exteriorById } from '../src/styles/presets';
import { resolveSpec } from '../src/styles/spec';
import type { BuildingModel, Floor, Opening, Room, Vec2, Wall } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const O = [P(0, 0), P(8000, 0), P(8000, 6000), P(0, 6000)];
const wall = (id: string, a: Vec2, b: Vec2, exterior = true): Wall => ({ id, a, b, thickness: exterior ? 150 : 120, exterior, ...(exterior ? { outsideSign: 1 as const } : {}) });
const room = (id: string, type: Room['type'], polygon: Vec2[], labelPos: Vec2): Room => ({ id, name: type, type, polygon, labelPos, area: 20 });

/**
 * 8m × 6m の平屋。西 5m が LDK、東 3m が洋室（間に壁と、ガラスの室内窓）。
 * LDK の南の壁（y = 6000）に掃き出し窓（x = 1000〜3500）。図面の上（-y）が北
 */
function model(northAngleDeg = 0): BuildingModel {
  const mid = wall('m1', P(5000, 0), P(5000, 6000), false);
  const openings: Opening[] = [
    { id: 'w1', wallId: 's1', kind: 'window', t0: 4500, t1: 7000, sill: 0, height: 2000 },
    { id: 'iw', wallId: 'm1', kind: 'window', t0: 1000, t1: 2000, sill: 900, height: 900, interior: true },
    { id: 'd1', wallId: 'm1', kind: 'door', t0: 3000, t1: 3800, sill: 0, height: 2000 },
  ];
  const f1: Floor = {
    level: 1,
    elevation: 500,
    height: 2900,
    ceilingHeight: 2400,
    outline: [O],
    rooms: [room('r1', 'ldk', [P(0, 0), P(5000, 0), P(5000, 6000), P(0, 6000)], P(2500, 3000)), room('r2', 'bedroom', [P(5000, 0), P(8000, 0), P(8000, 6000), P(5000, 6000)], P(6500, 3000))],
    stairs: [],
    openings,
    walls: [wall('n1', O[0], O[1]), wall('e1', O[1], O[2]), wall('s1', O[2], O[3]), wall('w1', O[3], O[0]), mid],
  };
  return { name: 't', floors: [f1], northAngleDeg, report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} } };
}

describe('部屋の映り込み（シェーダーへの差し込み）', () => {
  const compile = (m: THREE.Material) => {
    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
    m.onBeforeCompile(shader as never, null as never);
    return shader;
  };

  it('標準マテリアル: 頂点にワールド座標、反射の関数に部屋の箱の補正が入り、値は全素材で共有する', () => {
    const m = patchRoomProbe(new THREE.MeshStandardMaterial());
    expect(m.defines).toHaveProperty('ROOM_PROBE');
    const sh = compile(m);
    expect(sh.vertexShader).toContain('vRoomProbeWP = ( modelMatrix * roomProbeW ).xyz;');
    expect(sh.fragmentShader).toContain('roomProbeRadiance( envMapColor.rgb * envMapIntensity, reflectVec, roughness )');
    // もとの「環境マップだけを返す」行は、映り込みを使わないとき（#else）にだけ残る
    expect(sh.fragmentShader.match(/return envMapColor\.rgb \* envMapIntensity;/g)?.length).toBeGreaterThanOrEqual(1);
    expect(sh.uniforms.roomProbeMap).toBe(roomProbeUniforms.roomProbeMap);
    expect(sh.uniforms.roomProbePos).toBe(roomProbeUniforms.roomProbePos);
  });

  it('物理マテリアル（床の艶・ガラス）も同じ。何度呼んでも 1 回だけ', () => {
    const m = new THREE.MeshPhysicalMaterial({ clearcoat: 0.3 });
    patchRoomProbe(m);
    const first = m.onBeforeCompile;
    patchRoomProbe(m);
    expect(m.onBeforeCompile).toBe(first);
    expect(compile(m).fragmentShader).toContain('uniform sampler2D roomProbeMap;');
    expect(m.customProgramCacheKey()).toContain('roomProbe');
  });

  it('もとからある onBeforeCompile は残す（先に呼ぶ）', () => {
    const m = new THREE.MeshStandardMaterial();
    let called = 0;
    m.onBeforeCompile = () => {
      called++;
    };
    patchRoomProbe(m);
    compile(m);
    expect(called).toBe(1);
  });

  it('光を計算しない素材（加算の光の面など）には何もしない', () => {
    const m = new THREE.MeshBasicMaterial();
    const before = m.onBeforeCompile;
    patchRoomProbe(m);
    expect(m.onBeforeCompile).toBe(before);
    expect(m.userData.roomProbe).toBeUndefined();
  });
});

describe('窓からの光の入口（面の光を置く窓）', () => {
  it('外壁の窓だけ。位置は室内側のガラス面、向きは部屋の内側、大きさは窓の大きさ', () => {
    const list = windowPortals(model(), resolveSpec('minimal-lines', undefined));
    expect(list).toHaveLength(1);
    const p = list[0];
    expect(p.level).toBe(1);
    // 南の壁（z = 6m、厚さ 150）の室内側
    expect(p.pos.x).toBeCloseTo(2.25, 2);
    expect(p.pos.z).toBeGreaterThan(5.85);
    expect(p.pos.z).toBeLessThan(5.95);
    expect(p.normal.z).toBeCloseTo(-1, 5);
    expect(p.width).toBeCloseTo(2.44, 2);
    expect(p.height).toBeGreaterThan(1.8);
  });
});

describe('内観の日差しの向き', () => {
  const shotsOf = (north: number) => {
    const m = model(north);
    const { meta } = buildBuilding(m, { exterior: exteriorById('hl-jolypat-grey'), spec: resolveSpec('minimal-lines', undefined) });
    // 部屋の箱の中だけを見通せる簡単なレイ（壁で止まる）
    const ray: RayFn = (o, d, far) => {
      let t = far;
      const lim = (p: number, v: number, lo: number, hi: number) => {
        if (Math.abs(v) < 1e-9) return;
        const k = v > 0 ? (hi - p) / v : (lo - p) / v;
        if (k > 0) t = Math.min(t, k);
      };
      lim(o.x, d.x, 0, o.x < 5 ? 5 : 8);
      lim(o.z, d.z, 0, 6);
      return t;
    };
    return interiorShots(m, meta, new Map(), 16 / 9, ray);
  };

  it('南の窓のある LDK: 日は南（+z）から、斜めに差し込む。高さは 30〜45°', () => {
    const l = shotsOf(0).find((s) => s.id === 'int-r1');
    expect(l).toBeDefined();
    const sun = l!.sunDir;
    expect(sun).not.toBeNull();
    expect(sun!.z).toBeGreaterThan(0.25);
    const elev = (Math.asin(sun!.y) * 180) / Math.PI;
    expect(elev).toBeGreaterThan(30);
    expect(elev).toBeLessThan(45);
  });

  it('同じ窓が北向きの敷地（図面の下が北）: 直射は差し込ませない', () => {
    const l = shotsOf(180).find((s) => s.id === 'int-r1');
    expect(l).toBeDefined();
    expect(l!.sunDir).toBeNull();
  });

  it('外の窓の無い部屋（室内窓だけ）: 日差しの向きは決めない', () => {
    const b = shotsOf(0).find((s) => s.id === 'int-r2');
    if (b) expect(b.sunDir).toBeNull();
  });
});
