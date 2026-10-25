import { describe, it, expect } from 'vitest';
import { measure3d, applyMeasured, glassPanels } from '../src/parser/heightsFrom3d';
import type { BuildingModel, Floor } from '../src/core/types';

const W = 9.1;
const D = 6.37;
/** 四角形（ワールド m）を三角形 2 つに。上向きの面は反時計回り（上から見て）で渡す */
function quad(out: number[], p: [number, number, number][]) {
  const [a, b, c, d] = p;
  out.push(...a, ...b, ...c, ...a, ...c, ...d);
}
function floorFor(level: number, elevation: number): Floor {
  return {
    level,
    elevation,
    height: 2900,
    ceilingHeight: 2400,
    walls: [{ id: `w${level}`, a: { x: 0, y: 0 }, b: { x: 9100, y: 0 }, thickness: 120, exterior: true }],
    openings: [{ id: `o${level}`, wallId: `w${level}`, kind: 'window', t0: 2000, t1: 3690, sill: 900, height: 1100 }],
    rooms: [{ id: `r${level}`, name: '洋室', type: 'living' as never, polygon: [{ x: 0, y: 0 }, { x: 9100, y: 0 }, { x: 9100, y: 6370 }, { x: 0, y: 6370 }], area: 58, labelPos: { x: 4550, y: 3185 } }],
    stairs: [],
    outline: [[{ x: 0, y: 0 }, { x: 9100, y: 0 }, { x: 9100, y: 6370 }, { x: 0, y: 6370 }]],
  } as Floor;
}
const model = { name: 't', northAngleDeg: 0, floors: [floorFor(1, 500), floorFor(2, 3400)], report: {} } as unknown as BuildingModel;

function house(roof: 'gable' | 'twoSheds') {
  const solid: number[] = [];
  // 基礎の下端（GL）
  quad(solid, [[0, 0, 0], [W, 0, 0], [W, 0.02, 0], [0, 0.02, 0]]);
  // 床（上向き）: 1 階 0.6、2 階 3.5
  for (const y of [0.6, 3.5]) quad(solid, [[0, y, D], [W, y, D], [W, y, 0], [0, y, 0]]);
  if (roof === 'gable') {
    // 4 寸の切妻: 棟は z = D/2、高さ 6.4 + 0.4 × D/2
    const top = 6.4 + 0.4 * (D / 2);
    quad(solid, [[0, 6.4, D], [W, 6.4, D], [W, top, D / 2], [0, top, D / 2]]);
    quad(solid, [[0, top, D / 2], [W, top, D / 2], [W, 6.4, 0], [0, 6.4, 0]]);
  } else {
    // 高さの違う 0.5 寸の片流れが 2 枚、反対向き
    quad(solid, [[0, 6.4, D / 2], [W / 2, 6.4, D / 2], [W / 2, 6.4 + 0.05 * (D / 2), 0], [0, 6.4 + 0.05 * (D / 2), 0]]);
    quad(solid, [[W / 2, 5.6, D / 2], [W, 5.6, D / 2], [W, 5.6 + 0.05 * (D / 2), D], [W / 2, 5.6 + 0.05 * (D / 2), D]].map(([x, y, z]) => [x, y, z]) as [number, number, number][]);
  }
  // 窓ガラス: 1 階の南面 x 2.06〜3.63、床から 0.95〜2.0
  const glass: number[] = [];
  quad(glass, [[2.06, 0.6 + 0.95, 0], [3.63, 0.6 + 0.95, 0], [3.63, 0.6 + 2.0, 0], [2.06, 0.6 + 2.0, 0]]);
  return { solid: new Float32Array(solid), glass: new Float32Array(glass) };
}

describe('heights from 3D', () => {
  it('measures floors, ground, gable roof and a window', () => {
    const { solid, glass } = house('gable');
    const m = measure3d(model, solid, glass, [0.5, 3.4]);
    expect(m.floorY[0]).toBeCloseTo(0.6, 2);
    expect(m.floorY[1]).toBeCloseTo(3.5, 2);
    expect(m.groundY).toBeCloseTo(0, 2);
    expect(m.roof).toMatchObject({ type: 'gable', pitch: 4 });
    const ch = applyMeasured(model, m, [0.5, 3.4]);
    const [f1, f2] = ch.model.floors;
    expect(f1.elevation).toBe(600);
    expect(f2.elevation - f1.elevation).toBe(2900);
    expect(ch.windowsMatched).toBe(1);
    expect(f1.openings[0].sill).toBe(910);
    expect(f1.openings[0].height).toBe(1130);
    // 元のモデルは変えない
    expect(model.floors[0].elevation).toBe(500);
  });
  it('two opposite low sheds at different heights are not a gable', () => {
    const { solid, glass } = house('twoSheds');
    expect(measure3d(model, solid, glass, [0.5, 3.4]).roof?.type).toBe('shed');
  });
  it('merges the panes of one sash into one panel', () => {
    const g: number[] = [];
    quad(g, [[0, 1, 0], [0.8, 1, 0], [0.8, 2, 0], [0, 2, 0]]);
    quad(g, [[0.86, 1, 0.03], [1.66, 1, 0.03], [1.66, 2, 0.03], [0.86, 2, 0.03]]);
    quad(g, [[4, 1, 0], [4.6, 1, 0], [4.6, 2, 0], [4, 2, 0]]);
    const p = glassPanels(new Float32Array(g));
    expect(p).toHaveLength(2);
    expect(p.find((x) => x.cx < 2)!.width).toBeCloseTo(1.66, 2);
  });
});
