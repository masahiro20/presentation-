// 庇（model.canopies）と、辺ごとの軒の出（RoofPatch.eavesBy）が 3D に反映される
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildBuilding } from '../src/scene/building';
import { buildRoofs } from '../src/scene/roof';
import { exteriorById } from '../src/styles/presets';
import type { BuildingModel, Floor, Vec2, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const wall = (id: string, a: Vec2, b: Vec2, outsideSign: 1 | -1): Wall => ({ id, a, b, thickness: 150, exterior: true, outsideSign });
/** 1 階 8m × 6m。南の壁 's' は a=(8000,6000) → b=(0,6000)、外は +y 側 */
function model(): BuildingModel {
  const o = rect(0, 0, 8000, 6000);
  const f: Floor = {
    level: 1,
    elevation: 500,
    height: 2900,
    ceilingHeight: 2400,
    outline: [o],
    rooms: [{ id: 'r', name: 'LDK', type: 'ldk', polygon: o, labelPos: { x: 4000, y: 3000 }, area: 48 }],
    stairs: [],
    openings: [],
    // 外向き: 壁の向き u に対して n = (−uy, ux) の側が +1。この外形（時計回り）では 4 辺とも外は −n
    walls: [wall('n', o[0], o[1], -1), wall('e', o[1], o[2], -1), wall('s', o[2], o[3], -1), wall('w', o[3], o[0], -1)],
  };
  return { name: 't', floors: [f], northAngleDeg: 0, report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} } };
}
const style = exteriorById('hl-jolypat-grey');

function canopyBounds(m: BuildingModel) {
  const { mb } = buildBuilding(m, { exterior: style });
  const g = mb.build(() => new THREE.MeshBasicMaterial());
  const mesh = (g.children as THREE.Mesh[]).find((x) => x.name === 'ext.canopy');
  if (!mesh) return null;
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!;
}

describe('庇', () => {
  it('壁の外面から指定の出で、床からの高さに付く', () => {
    const m = model();
    // 南の壁（y=6000）の始点 a=(8000,6000) から 2,000〜3,500 に、FL+2,200・出 900
    m.canopies = [{ id: 'c1', level: 1, wallId: 's', t0: 2000, t1: 3500, bottomMm: 2200, depth: 900 }];
    const b = canopyBounds(m)!;
    expect(b).not.toBeNull();
    // 壁の外面（y = 6.075）から外へ 0.9m
    expect(b.min.z).toBeGreaterThan(6.0);
    expect(b.max.z).toBeCloseTo(6.075 - 0.02 + 0.9, 1);
    // 壁に沿って x = 8 − 3.5 … 8 − 2
    expect(b.min.x).toBeCloseTo(4.5, 1);
    expect(b.max.x).toBeCloseTo(6.0, 1);
    // 下端 FL+2.2（= 0.5 + 2.2）、先端は 0.5 寸で下がる
    expect(b.max.y).toBeCloseTo(0.5 + 2.2 + 0.12, 1);
    expect(b.min.y).toBeLessThan(0.5 + 2.2);
  });
  it('無ければ庇の面は作らない（玄関の自動の庇も無い）', () => {
    expect(canopyBounds(model())).toBeNull();
  });
});

describe('辺ごとの軒の出', () => {
  it('南だけ軒を深くすると、屋根の南端だけ外へ伸びる', () => {
    const m = model();
    const base = buildRoofs(m, style, 'gable', 4);
    const g0 = base.mb.build(() => new THREE.MeshBasicMaterial());
    const r0 = (g0.children as THREE.Mesh[]).find((x) => x.name === 'ext.roof')!;
    r0.geometry.computeBoundingBox();
    m.roofPatches = [{ id: 'p', level: 1, at: { x: 4000, y: 3000 }, kind: 'gable', ridge: 'x', eavesBy: { s: 1500 } }];
    const deep = buildRoofs(m, style, 'gable', 4);
    const g1 = deep.mb.build(() => new THREE.MeshBasicMaterial());
    const r1 = (g1.children as THREE.Mesh[]).find((x) => x.name === 'ext.roof')!;
    r1.geometry.computeBoundingBox();
    expect(r1.geometry.boundingBox!.max.z - r0.geometry.boundingBox!.max.z).toBeGreaterThan(0.9);
    expect(Math.abs(r1.geometry.boundingBox!.min.z - r0.geometry.boundingBox!.min.z)).toBeLessThan(0.05);
  });
});
