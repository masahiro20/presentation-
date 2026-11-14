// 3D の作り（大崎様邸の内観の静止画との突き合わせから）:
//  - 木の見切りのテイスト（白い塗り壁 × オーク）: 窓の室内側に木の額縁、室内窓は木の枠、腰壁の天端に木の笠木
//  - 昇り口の短い列は木の箱（踏板の下を床まで木で詰める）。塊の側面は木目を横に通す別のキー
//  - 吹抜が上の階の外周に接する所は、下の階の天井から上の階の床までを塗り壁でふさぐ（屋根裏を見せない）
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildBuilding, type BuildOptions } from '../src/scene/building';
import { exteriorById, interiorById, DEFAULT_DESIGN } from '../src/styles/presets';
import { stairStringerOf, woodTrimOf } from '../src/coordinate/catalog';
import type { BuildingModel, Floor, Opening, Room, Stair, Vec2, Wall } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const wall = (id: string, a: Vec2, b: Vec2, exterior = true, o: Partial<Wall> = {}): Wall => ({ id, a, b, thickness: exterior ? 160 : 130, exterior, ...(exterior ? { outsideSign: 1 as const } : {}), ...o });
const room = (id: string, type: Room['type'], polygon: Vec2[], o: Partial<Room> = {}): Room => ({ id, name: type, type, polygon, labelPos: P((polygon[0].x + polygon[2].x) / 2, (polygon[0].y + polygon[2].y) / 2), area: 20, ...o });
const rect = (x0: number, y0: number, x1: number, y1: number) => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const box = (lv: number, x0: number, y0: number, x1: number, y1: number): Wall[] => {
  const c = rect(x0, y0, x1, y1);
  return [wall(`n${lv}`, c[0], c[1]), wall(`e${lv}`, c[1], c[2]), wall(`s${lv}`, c[2], c[3]), wall(`w${lv}`, c[3], c[0])];
};
const report = { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text' as const, wallThicknesses: [], warnings: [], timingsMs: {} };

/**
 * 1 階 10m × 6m（LDK 0〜7m、畳コーナー 7〜10m は床 +400）。2 階は西の 7m だけ（東 3m は下屋）。
 * 2 階の東 3m（4〜7m）は吹抜 = 吹抜の東の縁が 2 階の外周（その下の 1 階は壁の無い LDK と畳の境）。
 * LDK の南に大きな窓、LDK と畳の間に室内窓、LDK の中に腰壁、折り返し階段（先の列が 910 伸びる）
 */
function model(): BuildingModel {
  const openings: Opening[] = [
    { id: 'w1', wallId: 's1', kind: 'window', t0: 4000, t1: 6400, sill: 0, height: 2200, sash: 'fix' },
    { id: 'iw', wallId: 'k1', kind: 'window', t0: 500, t1: 2300, sill: 400, height: 1700, interior: true },
  ];
  const stair: Stair = { id: 'st', minX: 200, minY: 200, maxX: 2020, maxY: 2020, kind: 'u', entry: 's', turn: 'right', goesUp: true, overrun: 910 } as Stair;
  const f1: Floor = {
    level: 1,
    elevation: 500,
    height: 2900,
    ceilingHeight: 2400,
    outline: [rect(0, 0, 10000, 6000)],
    rooms: [room('ldk', 'ldk', rect(0, 0, 7000, 6000)), room('tatami', 'japanese', rect(7000, 0, 10000, 6000), { floorOffset: 400 })],
    stairs: [stair],
    openings,
    walls: [...box(1, 0, 0, 10000, 6000), wall('k1', P(7000, 3000), P(7000, 6000), false), wall('half', P(3000, 2500), P(3000, 4500), false, { topMm: 1100 })],
  };
  const f2: Floor = {
    level: 2,
    elevation: 3400,
    height: 2900,
    ceilingHeight: 2400,
    outline: [rect(0, 0, 7000, 6000)],
    rooms: [room('hall', 'hall', rect(0, 0, 4000, 6000)), room('void', 'void', rect(4000, 0, 7000, 6000))],
    stairs: [{ ...stair, id: 'st2', goesUp: false }],
    openings: [],
    walls: box(2, 0, 0, 7000, 6000),
  };
  return { name: 't', floors: [f1, f2], northAngleDeg: 0, report };
}

function points(opts: Partial<BuildOptions> = {}): Record<string, THREE.Vector3[]> {
  const { mb } = buildBuilding(model(), { exterior: exteriorById('hl-jolypat-grey'), ...opts });
  const g = mb.build(() => new THREE.MeshBasicMaterial());
  const pts: Record<string, THREE.Vector3[]> = {};
  for (const mesh of g.children as THREE.Mesh[]) {
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) (pts[mesh.name] ??= []).push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  return pts;
}

describe('木の見切り（窓の額縁・室内窓の枠・腰壁の笠木）', () => {
  it('テイストの決まり: 白い塗り壁 × オークだけ。既定（グレーの塗り壁）は塗り回しのまま', () => {
    expect(woodTrimOf({ ...DEFAULT_DESIGN, interiorId: 'hl-standard' })).toBe(true);
    expect(woodTrimOf(DEFAULT_DESIGN)).toBe(false);
    expect(interiorById('hl-standard').vocab?.woodTrim).toBe(true);
  });

  it('指定が無ければ木の見切りは作らない', () => {
    expect(points()['int.woodTrim']).toBeUndefined();
  });

  it('外の窓の室内側に額縁（床からの窓は下枠なし）、室内窓は壁の厚みの木の枠、腰壁に笠木', () => {
    const t = points({ woodTrim: true })['int.woodTrim'];
    expect(t?.length).toBeGreaterThan(0);
    // 南の窓（x 4.0〜6.4・壁は z = 6.0）の額縁: 室内側の面（z ≒ 5.92）より内側に 6mm 出て、床（0.5）から窓の上まで
    // （標準仕様はサッシの上端を天井にそろえるので、窓の上 = 天井 2.9）
    const south = t.filter((v) => v.z > 5.8 && v.x > 3.9 && v.x < 6.5);
    expect(Math.min(...south.map((v) => v.z))).toBeCloseTo(6 - 0.08 - 0.006, 2);
    expect(Math.min(...south.map((v) => v.y))).toBeCloseTo(0.5, 2);
    expect(Math.max(...south.map((v) => v.y))).toBeCloseTo(2.9, 2);
    // 床からの窓: 下枠（床に寝た板）は無い = 窓の幅いっぱいの板は上の 1 本だけ（y が 2.8 より上）
    const wide = south.filter((v) => v.x > 4.5 && v.x < 5.9);
    expect(wide.every((v) => v.y > 2.8)).toBe(true);
    // 室内窓（x = 7.0 の壁・z 3.5〜5.3・腰 0.4 + 0.5）: 壁の厚み（130）＋ 12 の木の枠
    const inner = t.filter((v) => Math.abs(v.x - 7) < 0.1 && v.z > 3.4 && v.z < 5.4 && v.y < 2.7);
    expect(inner.length).toBeGreaterThan(0);
    expect(Math.max(...inner.map((v) => v.x)) - Math.min(...inner.map((v) => v.x))).toBeCloseTo(0.142, 2);
    // 腰壁（x = 3.0・天端 1.1）の笠木: 天端の上に厚 24、両側に 10 出る
    const cap = t.filter((v) => Math.abs(v.x - 3) < 0.1 && v.z > 2.4 && v.z < 4.6);
    expect(Math.min(...cap.map((v) => v.y))).toBeCloseTo(0.5 + 1.1, 2);
    expect(Math.max(...cap.map((v) => v.y))).toBeCloseTo(0.5 + 1.1 + 0.024, 2);
    expect(Math.max(...cap.map((v) => v.x)) - Math.min(...cap.map((v) => v.x))).toBeCloseTo(0.15, 2);
  });
});

describe('昇り口の木の箱と、稲妻ささら', () => {
  it('テイストの決まり: 白い塗り壁 × オークは稲妻ささら、既定は両側のささら桁', () => {
    expect(stairStringerOf({ ...DEFAULT_DESIGN, interiorId: 'hl-standard' })).toBe('zigzag');
    expect(stairStringerOf(DEFAULT_DESIGN)).toBe('side');
  });

  it('鉄骨階段の最初の短い列は、踏板の下を床まで木で詰める（側面は木目を横に通す別のキー）', () => {
    const pts = points({ stairBuild: 'steel', stairStringer: 'zigzag' });
    const mass = pts['int.stairsMass'];
    expect(mass?.length).toBeGreaterThan(0);
    // 塊は床（0.5）から立ち上がり、最初の列（2〜6 段）と踊り場の高さまで
    expect(Math.min(...mass.map((v) => v.y))).toBeCloseTo(0.5, 2);
    const top = Math.max(...mass.map((v) => v.y));
    expect(top).toBeGreaterThan(0.5 + 0.3);
    expect(top).toBeLessThan(0.5 + 1.8);
    // 踏板は今までどおりのキー
    expect(pts['int.stairs']?.length).toBeGreaterThan(0);
  });

  it('箱階段・片持ち・力桁の階段は、木の箱にしない', () => {
    expect(points({ stairBuild: 'box' })['int.stairsMass']).toBeUndefined();
    expect(points({ stairBuild: 'cantilever' })['int.stairsMass']).toBeUndefined();
    expect(points({ stairBuild: 'steel', stairStringer: 'center' })['int.stairsMass']).toBeUndefined();
  });
});

describe('吹抜が上の階の外周に接する所（天井の懐）', () => {
  it('下の階の天井（2.9）から上の階の床（3.4）までを、吹抜の側から塗り壁でふさぐ', () => {
    const wallPts = points()['int.wall'] ?? [];
    // 2 階の外周の東の辺（x = 7.0）のすぐ内側（4mm）に、y 2.9〜3.4 の面がある
    const band = wallPts.filter((v) => Math.abs(v.x - (7 - 0.004)) < 0.002 && v.y > 2.85 && v.y < 3.45);
    expect(band.length).toBeGreaterThan(0);
    expect(Math.min(...band.map((v) => v.y))).toBeCloseTo(2.9, 2);
    expect(Math.max(...band.map((v) => v.y))).toBeCloseTo(3.4, 2);
    // 吹抜でない所（ホール x 0〜4 の西の辺 x = 0）には張らない
    expect(wallPts.filter((v) => Math.abs(v.x - 0.004) < 0.002 && v.y > 2.95 && v.y < 3.35).length).toBe(0);
  });
});
