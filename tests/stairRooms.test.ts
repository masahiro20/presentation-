// 階段の区画を分ける: LDK・ホール・パントリーと一続きに読めた階段を、升目のラベルの上で別の区画にする
import { describe, expect, it } from 'vitest';
import { carveStairRegion } from '../src/parser/stairRooms';
import { Grid, WALL } from '../src/parser/raster';

const RES = 20;
/** 壁（太さ 120）で囲んだ升目を作る。walls = [ax, ay, bx, by][] */
const makeGrid = (w: number, h: number, walls: [number, number, number, number][]) => {
  const g = Grid.around(0, 0, w, h, RES, 400);
  for (const [ax, ay, bx, by] of walls) g.fillThickSegment({ x: ax, y: ay }, { x: bx, y: by }, 120, WALL);
  g.floodOutside();
  return g;
};
const m2 = (cells: number) => (cells * RES * RES) / 1e6;
const labelAt = (g: Grid, labels: Int32Array, x: number, y: number) => {
  const [cx, cy] = g.cellOf({ x, y });
  return labels[cy * g.w + cx];
};

describe('階段の区画を分ける', () => {
  it('LDK の隅のリビング階段（三方が壁のくぼみ）を別の区画にする。残りは 1 つのまま', () => {
    // 外周 8,000 × 6,000。上辺の中ほどに 2,730 × 1,820 の階段のくぼみ（左右に壁、下は開いている）
    const g = makeGrid(8000, 6000, [
      [0, 0, 8000, 0],
      [8000, 0, 8000, 6000],
      [8000, 6000, 0, 6000],
      [0, 6000, 0, 0],
      [2000, 0, 2000, 1820],
      [4730, 0, 4730, 1820],
    ]);
    const { labels, sizes } = g.labelComponents();
    const l = labelAt(g, labels, 4000, 4000);
    expect(labelAt(g, labels, 3000, 900)).toBe(l); // くぼみも LDK と同じ区画
    const before = sizes[l];
    const box = { minX: 2060, minY: 60, maxX: 4670, maxY: 1820 };
    const res = carveStairRegion(g, labels, sizes, l, box, { namedPoints: [{ x: 4000, y: 4000 }], mainPoint: { x: 4000, y: 4000 } })!;
    expect(res).not.toBeNull();
    expect(res.extraLabels).toHaveLength(0);
    expect(labelAt(g, labels, 3000, 900)).toBe(res.stairLabel);
    expect(labelAt(g, labels, 4000, 4000)).toBe(l);
    // 階段 2,610 × 1,760 ≒ 4.6 ㎡。足すと元の広さ
    expect(m2(sizes[res.stairLabel])).toBeCloseTo(4.59, 1);
    expect(sizes[l] + sizes[res.stairLabel]).toBe(before);
  });

  it('壁から壁まで渡る階段で区画が 2 つに分かれる: 名前のある側は別の区画、名前の無い小さな側は階段に含める', () => {
    // 幅 1,820 の細長い区画（縦 6,000）。真ん中に階段、上は 900 の踏み込み（名前なし）、下はパントリー
    const g = makeGrid(1820, 6000, [
      [0, 0, 1820, 0],
      [1820, 0, 1820, 6000],
      [1820, 6000, 0, 6000],
      [0, 6000, 0, 0],
    ]);
    const { labels, sizes } = g.labelComponents();
    const l = labelAt(g, labels, 900, 3000);
    const box = { minX: 60, minY: 1000, maxX: 1760, maxY: 3700 };
    const pantry = { x: 900, y: 5000 };
    const res = carveStairRegion(g, labels, sizes, l, box, { namedPoints: [pantry], mainPoint: null })!;
    expect(res).not.toBeNull();
    // パントリーが主な残り（元のラベル）。上の踏み込み（1,700 × 940 ≒ 1.6 ㎡）は階段に入る
    expect(labelAt(g, labels, pantry.x, pantry.y)).toBe(l);
    expect(labelAt(g, labels, 900, 500)).toBe(res.stairLabel);
    expect(res.extraLabels).toHaveLength(0);
    expect(m2(res.joinedCells)).toBeGreaterThan(1.3);
    expect(m2(sizes[l])).toBeCloseTo(1.7 * 2.24, 0);
  });

  it('階段の向こう側にも名前のある部屋があれば、それぞれ別の区画として残す', () => {
    const g = makeGrid(1820, 9000, [
      [0, 0, 1820, 0],
      [1820, 0, 1820, 9000],
      [1820, 9000, 0, 9000],
      [0, 9000, 0, 0],
    ]);
    const { labels, sizes } = g.labelComponents();
    const l = labelAt(g, labels, 900, 3000);
    const box = { minX: 60, minY: 3200, maxX: 1760, maxY: 5900 };
    const hall = { x: 900, y: 1500 };
    const pantry = { x: 900, y: 7500 };
    const res = carveStairRegion(g, labels, sizes, l, box, { namedPoints: [hall, pantry], mainPoint: hall })!;
    expect(res.extraLabels).toHaveLength(1);
    expect(labelAt(g, labels, hall.x, hall.y)).toBe(l);
    expect(labelAt(g, labels, pantry.x, pantry.y)).toBe(res.extraLabels[0]);
    expect(labelAt(g, labels, 900, 4500)).toBe(res.stairLabel);
    expect(res.joinedCells).toBe(0);
  });

  it('階段の範囲の大半が別の区画・壁にある、または残りが狭いときは分けない', () => {
    const g = makeGrid(4000, 3000, [
      [0, 0, 4000, 0],
      [4000, 0, 4000, 3000],
      [4000, 3000, 0, 3000],
      [0, 3000, 0, 0],
      [2000, 0, 2000, 3000],
    ]);
    const { labels, sizes } = g.labelComponents();
    const left = labelAt(g, labels, 1000, 1500);
    const snap = Int32Array.from(labels);
    // 範囲の 7 割が右の部屋にある
    expect(carveStairRegion(g, labels, sizes, left, { minX: 1500, minY: 500, maxX: 3300, maxY: 2500 }, { namedPoints: [{ x: 500, y: 500 }] })).toBeNull();
    // 範囲が部屋のほぼ全部（残り 1.5 ㎡ 未満）
    expect(carveStairRegion(g, labels, sizes, left, { minX: 60, minY: 60, maxX: 1940, maxY: 2400 }, { namedPoints: [{ x: 1000, y: 2700 }] })).toBeNull();
    expect(Array.from(labels)).toEqual(Array.from(snap));
  });
});

// ---- 部屋を作り直すとき（方眼で壁を直した後）にも、階段は LDK から分かれたまま ----
import { rebuildFloor } from '../src/parser/assemble';
import type { Floor, Stair, Wall } from '../src/core/types';

describe('作り直し: LDK と一続きの階段は「階段」の部屋になる', () => {
  const wall = (id: string, ax: number, ay: number, bx: number, by: number, exterior: boolean): Wall => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 120, exterior });
  // 外周 8,190 × 6,370。上辺の中ほどに 2,730 × 1,820 のくぼみ（左右は内壁、下は LDK に開いている）
  const walls: Wall[] = [
    wall('W1', 0, 0, 8190, 0, true),
    wall('W2', 8190, 0, 8190, 6370, true),
    wall('W3', 8190, 6370, 0, 6370, true),
    wall('W4', 0, 6370, 0, 0, true),
    wall('W5', 1820, 0, 1820, 1820, false),
    wall('W6', 4550, 0, 4550, 1820, false),
  ];
  const stair: Stair = { id: 'F1-S1', minX: 1820, minY: 0, maxX: 4550, maxY: 1820, kind: 'u', entry: 's', goesUp: true };
  const base = (stairs: Stair[]): Floor => ({ level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, walls: walls.map((w) => ({ ...w, a: { ...w.a }, b: { ...w.b } })), openings: [], rooms: [], stairs, outline: [] });
  const labels = [{ name: 'ＬＤＫ', x: 4000, y: 4000 }];

  it('階段が無ければ 1 部屋（くぼみも LDK）', () => {
    const f = rebuildFloor(base([]), labels, 0);
    expect(f.rooms.map((r) => r.name)).toEqual(['ＬＤＫ']);
    expect(f.rooms[0].area).toBeCloseTo(8.19 * 6.37, 0);
  });

  it('階段があれば LDK と階段に分かれ、面積の合計は変わらない', () => {
    const f = rebuildFloor(base([stair]), labels, 0);
    const ldk = f.rooms.find((r) => r.name === 'ＬＤＫ')!;
    const st = f.rooms.find((r) => r.type === 'stairs')!;
    expect(f.rooms).toHaveLength(2);
    expect(st.name).toBe('階段');
    expect(st.stairDir).toBe('up');
    // 階段は壁芯で 2,730 × 1,820 ≒ 4.97 ㎡（3.07 帖）。開いた辺は階段の範囲の線まで
    expect(st.area).toBeCloseTo(2.73 * 1.82, 0);
    expect(ldk.area).toBeCloseTo(8.19 * 6.37 - 2.73 * 1.82, 0);
    expect(ldk.area + st.area).toBeCloseTo(8.19 * 6.37, 0);
    // 名前の位置はそれぞれの部屋の中
    expect(st.labelPos.y).toBeLessThan(1820);
    expect(ldk.labelPos).toEqual({ x: 4000, y: 4000 });
  });
});

// ---- 上下階で階段の範囲をそろえたとき、降り口が壁を向かない ----
import { reconcileStairs, stairSideOpen } from '../src/parser/assemble';

describe('上の階の階段を下の階の範囲に合わせたときの降り口', () => {
  const wall = (id: string, ax: number, ay: number, bx: number, by: number): Wall => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 120, exterior: false });
  const floor = (level: number, stairs: Stair[], walls: Wall[]): Floor => ({ level, elevation: 0, height: 2900, ceilingHeight: 2400, walls, openings: [], rooms: [], stairs, outline: [] });
  // 下の階: 西の端に北から入り、左（東）へ曲がって 4,550 の列を昇るかね折れ階段
  const lower = (): Stair => ({ id: 'F1-S1', minX: 0, minY: 0, maxX: 4550, maxY: 910, kind: 'l', turn: 'left', entry: 'n', goesUp: true });
  // 上の階: 段の線が読めたのは中ほどの 2,275 だけ（東向きの降り口）
  const upper = (): Stair => ({ id: 'F2-S1', minX: 910, minY: 0, maxX: 3185, maxY: 910, kind: 'straight', entry: 'e', goesUp: false });

  it('上の端（東）が壁なら、東の端の踊り場へ北から入って西へ曲がる', () => {
    // 上の階の壁: 東・南の壁と、北の手すり壁（東の端 910 だけ開いている）
    const walls = [wall('E', 4550, -500, 4550, 1500), wall('S', -500, 910, 5000, 910), wall('N', 0, 0, 3640, 0)];
    const f1 = floor(1, [lower()], []);
    const f2 = floor(2, [upper()], walls);
    reconcileStairs([f1, f2]);
    const st = f2.stairs[0];
    expect([st.minX, st.minY, st.maxX, st.maxY]).toEqual([0, 0, 4550, 910]);
    expect(st.kind).toBe('l');
    expect(st.entry).toBe('n');
    expect(st.turn).toBe('right');
    expect(stairSideOpen(f2, st, 'n', 0.9)).toBe(true);
    expect(stairSideOpen(f2, st, 'e')).toBe(false);
  });

  it('上の端（東）が開いていれば、まっすぐ東から降りる（形は変えない）', () => {
    const walls = [wall('S', -500, 910, 5000, 910), wall('N', 0, 0, 4550, 0)];
    const f1 = floor(1, [lower()], []);
    const f2 = floor(2, [upper()], walls);
    reconcileStairs([f1, f2]);
    const st = f2.stairs[0];
    expect(st.maxX).toBe(4550);
    expect(st.entry).toBe('e');
    expect(st.kind).toBe('straight');
  });
});

// ---- 室名の無い通路: 戸が 3 つ以上集まる区画はホール ----
import type { Opening } from '../src/core/types';

describe('室名の無い区画の推定: 戸で 3 つ以上の部屋とつながるものはホール', () => {
  const wall = (id: string, ax: number, ay: number, bx: number, by: number, exterior: boolean): Wall => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 120, exterior });
  const door = (id: string, wallId: string, t0: number): Opening => ({ id, wallId, kind: 'door', t0, t1: t0 + 780, sill: 0, height: 2000 });
  // 3 × 3 間の家。真ん中の列の中段（2,730 × 3,640 = 6.1 帖）は室名なし。左右と上の部屋から戸で入る
  const walls: Wall[] = [
    wall('W1', 0, 0, 8190, 0, true),
    wall('W2', 8190, 0, 8190, 7280, true),
    wall('W3', 8190, 7280, 0, 7280, true),
    wall('W4', 0, 7280, 0, 0, true),
    wall('V1', 2730, 0, 2730, 7280, false),
    wall('V2', 5460, 0, 5460, 7280, false),
    wall('H1', 2730, 1820, 5460, 1820, false),
    wall('H2', 2730, 5460, 5460, 5460, false),
  ];
  const labels = [
    { name: '洋室', x: 1365, y: 3640 },
    { name: '主寝室', x: 6825, y: 3640 },
    { name: '洗面', x: 4095, y: 910 },
    { name: '納戸', x: 4095, y: 6370 },
  ];
  const base = (openings: Opening[]): Floor => ({ level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, walls: walls.map((w) => ({ ...w, a: { ...w.a }, b: { ...w.b } })), openings, rooms: [], stairs: [], outline: [] });
  const middle = (f: Floor) => f.rooms.find((r) => r.labelPos.x > 2730 && r.labelPos.x < 5460 && r.labelPos.y > 1820 && r.labelPos.y < 5460)!;

  it('左右と上の 3 部屋から戸でつながる → ホール（推定）', () => {
    const f = rebuildFloor(base([door('O1', 'V1', 3000), door('O2', 'V2', 3000), door('O3', 'H1', 900)]), labels, 0);
    const m = middle(f);
    expect(m.name).toBe('ホール');
    expect(m.type).toBe('hall');
    expect(m.inferred).toBe(true);
  });

  it('戸が 2 つだけなら決めない（室のまま）', () => {
    const f = rebuildFloor(base([door('O1', 'V1', 3000), door('O2', 'V2', 3000)]), labels, 0);
    expect(middle(f).type).not.toBe('hall');
  });
});
