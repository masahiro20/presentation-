// 壁の天端の指定（Wall.topMm）: 袖壁 2,400・パラペット（軒＋300）が 3D の壁の高さに反映される
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildBuilding, wallTopOf } from '../src/scene/building';
import { exteriorById } from '../src/styles/presets';
import type { BuildingModel, Floor, Vec2, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const wall = (id: string, a: Vec2, b: Vec2, exterior: boolean, extra: Partial<Wall> = {}): Wall => ({ id, a, b, thickness: exterior ? 150 : 90, exterior, ...(exterior ? { outsideSign: 1 as const } : {}), ...extra });
/** 1 階だけ 8m × 6m。外壁 4 本と、南の外（庭）に独立した袖壁 1 本 */
const model = (topMm?: number, fenceTopMm?: number): BuildingModel => {
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
    walls: [
      wall('n', o[0], o[1], true, { outsideSign: -1, ...(topMm != null ? { topMm } : {}) }),
      wall('e', o[1], o[2], true),
      wall('s', o[2], o[3], true),
      wall('w', o[3], o[0], true),
      wall('fence', { x: 1000, y: 8000 }, { x: 4000, y: 8000 }, false, fenceTopMm != null ? { topMm: fenceTopMm } : {}),
    ],
  };
  return { name: 't', floors: [f], northAngleDeg: 0, report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} } };
};
const style = exteriorById('hl-jolypat-grey');

/** 外壁の頂点のうち、北の壁（y ≒ 0）の最高点と、庭の袖壁（y ≒ 8m）の最高点 (m) */
function tops(m: BuildingModel): { north: number; fence: number } {
  const { mb } = buildBuilding(m, { exterior: style });
  const g = mb.build(() => new THREE.MeshBasicMaterial());
  let north = -Infinity;
  let fence = -Infinity;
  for (const mesh of g.children as THREE.Mesh[]) {
    if (!/^(ext\.|int\.)(wall|accent)/.test(mesh.name)) continue;
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      const y = pos.getY(i);
      if (Math.abs(z) < 0.2) north = Math.max(north, y);
      if (Math.abs(z - 8) < 0.2) fence = Math.max(fence, y);
    }
  }
  return { north, fence };
}

describe('Wall.topMm（壁の天端）', () => {
  it('指定しなければ外壁は軒まで、庭の壁も自動の高さ', () => {
    const m = model();
    const t = tops(m);
    const eave = (500 + wallTopOf(m, m.floors[0]) - 500) / 1000;
    expect(t.north).toBeCloseTo(eave, 2);
    expect(t.fence).toBeGreaterThan(1);
  });
  it('パラペット: 軒＋300 を指定すると北の外壁だけ 300 高くなる', () => {
    const m0 = model();
    const eaveMm = Math.round(wallTopOf(m0, m0.floors[0]) - 500);
    const t = tops(model(eaveMm + 300));
    expect(t.north).toBeCloseTo((500 + eaveMm + 300) / 1000, 2);
  });
  it('袖壁: 庭の壁の天端を床から 2,400 にすると、その高さで止まる', () => {
    const t = tops(model(undefined, 2400));
    expect(t.fence).toBeCloseTo((500 + 2400) / 1000, 2);
    // 300 未満は 300 に
    expect(tops(model(undefined, 100)).fence).toBeCloseTo((500 + 300) / 1000, 2);
  });
});
