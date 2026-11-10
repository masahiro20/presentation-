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

describe('adds windows missing from the plan', () => {
  it('adds a glass panel on an exterior wall that has no opening there', () => {
    const { solid } = house('gable');
    const g: number[] = [];
    // 図面の窓（x 2.06〜3.63）とは別の位置 x 6.0〜7.2 に、床から 0.3〜2.3 のガラス
    quad(g, [[2.06, 1.55, 0], [3.63, 1.55, 0], [3.63, 2.6, 0], [2.06, 2.6, 0]]);
    quad(g, [[6.0, 0.9, 0], [7.2, 0.9, 0], [7.2, 2.9, 0], [6.0, 2.9, 0]]);
    const m = measure3d(model, solid, new Float32Array(g), [0.5, 3.4]);
    const ch = applyMeasured(model, m, [0.5, 3.4]);
    expect(ch.windowsAdded).toBe(1);
    const add = ch.model.floors[0].openings.find((o) => o.id.startsWith('o3d-'))!;
    expect(add.t0).toBeCloseTo(5960, -1);
    expect(add.t1).toBeCloseTo(7240, -1);
    expect(add.sill).toBe(260);
    expect(add.height).toBe(2080);
  });
});

describe('3D のガラスで平面図の読み取りを確かめて直す', () => {
  /** 南面（y=0 の壁、x 方向）に窓を並べた階。windows は [t0, t1]（mm） */
  function floorWith(level: number, elevation: number, windows: [number, number][], shiftX = 0): Floor {
    return {
      level,
      elevation,
      height: 2900,
      ceilingHeight: 2400,
      walls: [{ id: `w${level}`, a: { x: shiftX, y: 0 }, b: { x: 9100 + shiftX, y: 0 }, thickness: 120, exterior: true }],
      openings: windows.map(([t0, t1], k) => ({ id: `o${level}-${k}`, wallId: `w${level}`, kind: 'window' as const, t0, t1, sill: 900, height: 1100, confidence: 0.7 })),
      rooms: [{ id: `r${level}`, name: '洋室', type: 'bedroom', polygon: [{ x: shiftX, y: 0 }, { x: 9100 + shiftX, y: 0 }, { x: 9100 + shiftX, y: 6370 }, { x: shiftX, y: 6370 }], area: 58, labelPos: { x: 4550 + shiftX, y: 3185 } }],
      stairs: [],
      outline: [[{ x: shiftX, y: 0 }, { x: 9100 + shiftX, y: 0 }, { x: 9100 + shiftX, y: 6370 }, { x: shiftX, y: 6370 }]],
    } as unknown as Floor;
  }
  /** ガラス（x0〜x1 m、床 floorY から sill〜top m）を南面 z=0 に置く */
  const pane = (g: number[], x0: number, x1: number, floorY: number, sill = 0.95, top = 2.0) => quad(g, [[x0, floorY + sill, 0], [x1, floorY + sill, 0], [x1, floorY + top, 0], [x0, floorY + top, 0]]);

  it('幅・位置のずれた窓を 3D のガラスに合わせる（高さだけでなく）', () => {
    const m2 = { name: 't', northAngleDeg: 0, floors: [floorWith(1, 500, [[2000, 3690]]), floorWith(2, 3400, [])], report: {} } as unknown as BuildingModel;
    const { solid } = house('gable');
    const g: number[] = [];
    // 図面の窓は 2000〜3690。3D のガラスは 2.24〜4.76（幅 2.52 m、中心が 0.65 m ずれている → 中心は 0.35 m 以内でないと合わせない）
    pane(g, 2.24, 3.86, 0.6);
    const ch = applyMeasured(m2, measure3d(m2, solid, new Float32Array(g), [0.5, 3.4]), [0.5, 3.4]);
    const o = ch.model.floors[0].openings[0];
    expect(ch.windowsResized).toBe(1);
    expect(o.t0).toBe(2200);
    expect(o.t1).toBe(3900);
  });

  it('大半の窓が合っているとき、ガラスの無い外壁の窓を知らせる', () => {
    const wins: [number, number][] = [[500, 1300], [2000, 2800], [3500, 4300], [5000, 5800], [7000, 7800]];
    const m2 = { name: 't', northAngleDeg: 0, floors: [floorWith(1, 500, wins), floorWith(2, 3400, [])], report: {} } as unknown as BuildingModel;
    const { solid } = house('gable');
    const g: number[] = [];
    // 5 つのうち 4 つにだけガラスがある（7000〜7800 の所は壁）
    for (const [t0, t1] of wins.slice(0, 4)) pane(g, t0 / 1000 + 0.04, t1 / 1000 - 0.04, 0.6);
    const ch = applyMeasured(m2, measure3d(m2, solid, new Float32Array(g), [0.5, 3.4]), [0.5, 3.4]);
    expect(ch.windowsMatched).toBe(4);
    expect(ch.windowsUnmatched).toEqual([{ level: 1, id: 'o1-4', width: 800 }]);
    expect(ch.notes.some((n) => /ガラスが見当たらない窓 1 か所/.test(n))).toBe(true);
  });

  it('上の階の窓の並びが半間ずれていれば、3D のガラスに合わせて階ごと動かす', () => {
    const wins: [number, number][] = [[500, 1300], [2500, 3300], [5000, 5800], [7000, 7800]];
    // 平面図の 2 階は右へ 910 ずれて重ねてある（壁ごと +910）
    const m2 = { name: 't', northAngleDeg: 0, floors: [floorWith(1, 500, [[2000, 3690]]), floorWith(2, 3400, wins, 910)], report: {} } as unknown as BuildingModel;
    const { solid } = house('gable');
    const g: number[] = [];
    pane(g, 2.06, 3.63, 0.6);
    // 3D の 2 階のガラスは正しい位置（ずれなし）
    for (const [t0, t1] of wins) pane(g, t0 / 1000 + 0.04, t1 / 1000 - 0.04, 3.5);
    const ch = applyMeasured(m2, measure3d(m2, solid, new Float32Array(g), [0.5, 3.4]), [0.5, 3.4]);
    expect(ch.floorShifts).toEqual([{ level: 2, dx: -910, dy: 0 }]);
    const f2 = ch.model.floors[1];
    expect(f2.walls[0].a.x).toBe(0);
    expect(f2.outline[0][0].x).toBe(0);
    expect(ch.windowsMatched).toBe(5);
    // 元のモデルは変えない
    expect(m2.floors[1].walls[0].a.x).toBe(910);
  });

  it('ずれていない上の階は動かさない', () => {
    const wins: [number, number][] = [[500, 1300], [2500, 3300], [5000, 5800], [7000, 7800]];
    const m2 = { name: 't', northAngleDeg: 0, floors: [floorWith(1, 500, [[2000, 3690]]), floorWith(2, 3400, wins)], report: {} } as unknown as BuildingModel;
    const { solid } = house('gable');
    const g: number[] = [];
    pane(g, 2.06, 3.63, 0.6);
    for (const [t0, t1] of wins) pane(g, t0 / 1000 + 0.04, t1 / 1000 - 0.04, 3.5);
    const ch = applyMeasured(m2, measure3d(m2, solid, new Float32Array(g), [0.5, 3.4]), [0.5, 3.4]);
    expect(ch.floorShifts).toEqual([]);
  });
});
