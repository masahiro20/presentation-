// 内観の質 ②（2026-11-14）:
//  - ダウンライトが近くの壁に落とす光（スカラップ）の面を、器具から 0.3〜1.15 m の壁にだけ出す（窓・戸の所・遠い壁には出さない）
//  - 見えている器具のまとまりの位置（meta.downlights）を、夕景・夜の下向きの光に使う
//  - 丸い角の吹抜は、床・天井を帯の近似ではなく形どおりに抜く（縁がギザギザにならない）
//  - 壁の中の柱（短い壁）は 3D では外し、建具の無い開口の端に掛かる柱は壁を延ばして面を揃える
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildBuilding } from '../src/scene/building';
import { exteriorById } from '../src/styles/presets';
import type { BuildingModel, Floor, Opening, Room, Vec2, Wall } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const wall = (id: string, a: Vec2, b: Vec2, extra: Partial<Wall> = {}): Wall => ({ id, a, b, thickness: 150, exterior: true, outsideSign: 1 as const, ...extra });
const room = (id: string, type: Room['type'], polygon: Vec2[], extra: Partial<Room> = {}): Room => ({ id, name: type, type, polygon, labelPos: polygon[0], area: 20, ...extra });
const report = { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text' as const, wallThicknesses: [], warnings: [], timingsMs: {} };
const style = exteriorById('hl-jolypat-grey');

/** 素材ごとの頂点 */
function vertsOf(m: BuildingModel): { pts: Record<string, THREE.Vector3[]>; meta: ReturnType<typeof buildBuilding>['meta'] } {
  const { mb, meta } = buildBuilding(m, { exterior: style });
  const g = mb.build(() => new THREE.MeshBasicMaterial());
  const pts: Record<string, THREE.Vector3[]> = {};
  for (const mesh of g.children as THREE.Mesh[]) {
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) (pts[mesh.name] ??= []).push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  return { pts, meta };
}

/** 平屋の LDK（幅 w × 奥行 d mm）。openings は南の壁（y = d）に付く */
const oneRoom = (w: number, d: number, openings: Opening[] = [], extraWalls: Wall[] = []): BuildingModel => {
  const O = [P(0, 0), P(w, 0), P(w, d), P(0, d)];
  const f: Floor = {
    level: 1,
    elevation: 500,
    height: 2900,
    ceilingHeight: 2400,
    outline: [O],
    rooms: [room('r1', 'ldk', O)],
    stairs: [],
    openings,
    walls: [wall('n', O[0], O[1]), wall('e', O[1], O[2]), wall('s', O[3], O[2]), wall('w', O[3], O[0]), ...extraWalls],
  };
  return { name: 't', floors: [f], northAngleDeg: 0, report };
};

describe('ダウンライトが壁に落とす光（スカラップ）', () => {
  it('幅 6m × 奥行 5m の LDK: 器具は長い壁から 0.9m の 2 列。その壁の面に光の面が出て、天井のすぐ下から始まる', () => {
    const { pts, meta } = vertsOf(oneRoom(6000, 5000));
    const s = pts['f.coveGlowScallop'] ?? [];
    expect(s.length).toBeGreaterThan(0);
    // 光の面は壁の室内側の面（芯から厚みの半分 + 4mm）に貼る: 北の壁 z = 0.079、南の壁 z = 4.921、東西の壁 x = 0.079 / 5.921
    const onFace = (v: THREE.Vector3) => [0.079, 4.921].some((z) => Math.abs(v.z - z) < 0.002) || [0.079, 5.921].some((x) => Math.abs(v.x - x) < 0.002);
    expect(s.every(onFace)).toBe(true);
    // 上端は天井（0.5 + 2.4）のすぐ下、下端は床より上
    expect(Math.max(...s.map((v) => v.y))).toBeCloseTo(2.9 - 0.012, 3);
    expect(Math.min(...s.map((v) => v.y))).toBeGreaterThan(0.5);
    // 器具のまとまり（3 灯一列）の位置を、夜の下向きの光に渡す
    expect(meta.downlights.length).toBe(4);
    expect(meta.downlights.every((d) => d.lamps === 3 && d.roomId === 'r1' && Math.abs(d.pos.y - 2.9) < 1e-6)).toBe(true);
  });

  it('窓のある所には出さない: 南の壁いっぱいの窓があると、南の壁には光の面が無い', () => {
    const win = { id: 'o1', wallId: 's', kind: 'window', t0: 200, t1: 5800, sill: 0, height: 2200 } as Opening;
    const { pts } = vertsOf(oneRoom(6000, 5000, [win]));
    const s = pts['f.coveGlowScallop'] ?? [];
    expect(s.length).toBeGreaterThan(0);
    expect(s.some((v) => Math.abs(v.z - 4.921) < 0.002)).toBe(false);
    expect(s.some((v) => Math.abs(v.z - 0.079) < 0.002)).toBe(true);
  });

  it('器具から遠い壁（1.15m 超）には出さない: 奥行 3.6m の部屋（器具は中央の 1 列）は、長い壁に光の面が無い', () => {
    const { pts } = vertsOf(oneRoom(6000, 3600));
    const s = pts['f.coveGlowScallop'] ?? [];
    expect(s.some((v) => Math.abs(v.z - 0.079) < 0.002 || Math.abs(v.z - 3.521) < 0.002)).toBe(false);
  });
});

describe('丸い角の吹抜の縁（形どおりに抜く）', () => {
  /** 8m × 6m の 2 階建て。2 階の東側が吹抜で、ホールとの境は半径 2m の丸い角 */
  const curved = (): BuildingModel => {
    const O = [P(0, 0), P(8000, 0), P(8000, 6000), P(0, 6000)];
    const arc: Vec2[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * (Math.PI / 2);
      arc.push(P(4000 + 2000 * (1 - Math.cos(a)), 2000 * Math.sin(a) + 0));
    }
    // 境の線: (4000, 0) から丸く曲がって (6000, 2000)、そこから東の壁へ
    const edge = [...arc, P(8000, 2000)];
    const hall = [O[0], ...edge, O[2], O[3]];
    const vd = [...edge.slice().reverse(), P(4000, 0), O[1]].filter((p, i, a) => i === 0 || p.x !== a[i - 1].x || p.y !== a[i - 1].y);
    const ws = (lv: number) => [wall(`n${lv}`, O[0], O[1]), wall(`e${lv}`, O[1], O[2]), wall(`s${lv}`, O[3], O[2]), wall(`w${lv}`, O[3], O[0])];
    const f1: Floor = { level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, outline: [O], rooms: [room('r1', 'ldk', O)], stairs: [], openings: [], walls: ws(1) };
    const f2: Floor = { level: 2, elevation: 3400, height: 2900, ceilingHeight: 2400, outline: [O], rooms: [room('h2', 'hall', hall), room('v2', 'void', vd)], stairs: [], openings: [], walls: ws(2) };
    return { name: 't', floors: [f1, f2], northAngleDeg: 0, report };
  };

  it('1 階の天井の切り口が、丸い縁の上に載る（40mm の帯の段々にならない）', () => {
    const { pts } = vertsOf(curved());
    // 1 階の LDK の天井（y = 2.9）の頂点のうち、丸い角の近くにあるもの
    const ceil = (pts['int.ceilingMain'] ?? []).filter((v) => Math.abs(v.y - 2.9) < 1e-6);
    expect(ceil.length).toBeGreaterThan(0);
    // 円の中心 (6, 0)・半径 2 m。弧の範囲（x 4〜6、z 0〜2）で、吹抜の側（円の外・x > 4）に天井がはみ出していない
    const R = 2;
    const cos = Math.cos(Math.PI / 24); // 12 分割の弦は、円より最大で R(1 − cos) 内側
    let worst = 0;
    let onArc = 0;
    for (const v of ceil) {
      if (v.x < 4 - 1e-6 || v.x > 6 + 1e-6 || v.z > 2 + 1e-6) continue;
      const d = Math.hypot(v.x - 6, v.z - 0);
      // 天井は円の外側（ホールの下）。円の内側（吹抜の下）へ入り込む量
      worst = Math.max(worst, R * cos - d);
      if (Math.abs(d - R) < 0.002) onArc++;
    }
    expect(worst).toBeLessThan(0.002);
    // 弧の頂点（12 分割 = 13 点）に、天井の頂点が載っている
    expect(onArc).toBeGreaterThanOrEqual(13);
  });
});

describe('壁の中の柱（短い壁）', () => {
  it('建具の無い開口の端に掛かる柱: 柱型を作らず、壁を柱の先まで延ばす（壁の面が段にならない）', () => {
    // LDK を南北に分ける間仕切り（y = 2500）。開口 2000〜3000 の端（2945）に柱の記号
    const part = wall('p', P(0, 2500), P(6000, 2500), { thickness: 130, exterior: false, outsideSign: undefined });
    const post = wall('post', P(2945, 2449), P(2945, 2551), { thickness: 130, exterior: false, outsideSign: undefined });
    const open = { id: 'o1', wallId: 'p', kind: 'open', t0: 2000, t1: 3000, sill: 0, height: 2000 } as Opening;
    const { pts } = vertsOf(oneRoom(6000, 5000, [open], [part, post]));
    const wallPts = pts['int.wall'] ?? [];
    // 柱の面（z = 2.449 / 2.551。壁の面 2.435 / 2.565 より 14mm 内側）に頂点が無い
    expect(wallPts.some((v) => Math.abs(v.z - 2.449) < 0.001 || Math.abs(v.z - 2.551) < 0.001)).toBe(false);
    // 開口の端は柱の手前（x = 2.88）: 壁の面の頂点がそこにある
    expect(wallPts.some((v) => Math.abs(v.x - 2.88) < 0.002 && Math.abs(v.z - 2.435) < 0.002)).toBe(true);
  });
});
