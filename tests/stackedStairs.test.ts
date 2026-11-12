// 3 階建ての途中の階で、下から上がってくる階段と上へ昇る階段が横に並ぶ形（第 42 巡 ⑮。田中様邸 2 階）
// その階の図には両方の段が並んで描かれ、1 つの折り返し階段に読めていた
import { describe, expect, it } from 'vitest';
import { bendStackedStairs, reconcileStairs, splitStackedStairs } from '../src/parser/assemble';
import { stairFootprint } from '../src/core/stairs';
import type { Floor, Stair, Vec2 } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const stair = (id: string, x0: number, y0: number, x1: number, y1: number, kind: Stair['kind'], entry: Stair['entry'], goesUp: boolean): Stair => ({ id, minX: x0, minY: y0, maxX: x1, maxY: y1, kind, entry, goesUp });
const floor = (level: number, stairs: Stair[], outline = rect(0, 0, 9100, 7280)): Floor =>
  ({ level, elevation: 500 + (level - 1) * 2900, height: 2900, ceilingHeight: 2400, walls: [], openings: [], rooms: [], stairs, outline: [outline] }) as unknown as Floor;

/**
 * 田中様邸の形: 1 階は北の列を西から東へ（図面では 4,095 まで）、2 階は北・南の 2 列に段が並び、3 階は南の列だけ（東が降り口）
 */
const tanaka = () => [
  floor(1, [stair('F1-S1', 2730, 0, 4095, 910, 'straight', 'w', true)]),
  floor(2, [stair('F2-S1', 1820, 0, 5005, 2275, 'u', 'w', true)]),
  floor(3, [stair('F3-S1', 1820, 1365, 5005, 2275, 'straight', 'e', false)], rect(1820, 1365, 9100, 7280)),
];

describe('横に並ぶ「下からの階段」と「上へ昇る階段」', () => {
  it('2 階の折り返しを、3 階の階段と同じ列の直階段に直す（昇り口は 3 階の降り口の反対の端）', () => {
    const floors = tanaka();
    const warnings: string[] = [];
    splitStackedStairs(floors, warnings, () => undefined);
    const s2 = floors[1].stairs[0];
    expect(s2.kind).toBe('straight');
    expect([s2.minX, s2.minY, s2.maxX, s2.maxY]).toEqual([1820, 1365, 5005, 2275]);
    expect(s2.entry).toBe('w');
    expect(s2.goesUp).toBe(true);
    expect(warnings.some((w) => /横に並ぶ/.test(w))).toBe(true);
    // 1 階の階段は直階段のまま、上がり切る端だけ 2 階の階段室の端まで伸びる
    const s1 = floors[0].stairs[0];
    expect(s1.kind).toBe('straight');
    expect([s1.minX, s1.minY, s1.maxX, s1.maxY]).toEqual([2730, 0, 5005, 910]);
  });

  it('2 階の図の DN の文字が、上がり切る端の横（南の列の外）にあれば、1 階の階段は角で曲がるかね折れ', () => {
    const floors = tanaka();
    splitStackedStairs(floors, [], () => ({ up: 'w', downPos: { x: 4547, y: 2356 } }));
    // 部屋を分けるまでは直階段のまま（範囲を広げると、ホールの床まで階段の区画に取り込んでしまう）
    expect(floors[0].stairs[0].kind).toBe('straight');
    bendStackedStairs(floors);
    const s1 = floors[0].stairs[0];
    expect(s1.kind).toBe('l');
    expect(s1.entry).toBe('w');
    // 東へ上がって南（昇る人の右）へ曲がる
    expect(s1.turn).toBe('right');
    expect([s1.minX, s1.minY, s1.maxX, s1.maxY]).toEqual([2730, 0, 5005, 2275]);
    // 列の幅は図面どおりの半間（1,000 で作ると、段の端が隣の壁からはみ出す）
    expect(s1.flightWidth).toBe(910);
  });

  it('かね折れにした 1 階の階段が 2 階の床にあける穴は、北の列（幅 910）と東の端の列（幅 910）の L 字', () => {
    const floors = tanaka();
    splitStackedStairs(floors, [], () => ({ up: 'w', downPos: { x: 4547, y: 2356 } }));
    bendStackedStairs(floors);
    const fp = stairFootprint(floors[0].stairs[0]);
    expect(fp).toHaveLength(2);
    expect(fp).toContainEqual({ minX: 2730, minY: 0, maxX: 5005, maxY: 910 });
    expect(fp).toContainEqual({ minX: 4095, minY: 0, maxX: 5005, maxY: 2275 });
  });

  it('分けた後は、上下階の「同じ階段」の範囲合わせで、また 1 つにまとめない', () => {
    const floors = tanaka();
    splitStackedStairs(floors, [], () => ({ up: 'w', downPos: { x: 4547, y: 2356 } }));
    reconcileStairs(floors);
    bendStackedStairs(floors);
    reconcileStairs(floors);
    const s2 = floors[1].stairs[0];
    expect(s2.kind).toBe('straight');
    expect([s2.minX, s2.minY, s2.maxX, s2.maxY]).toEqual([1820, 1365, 5005, 2275]);
    expect(floors[0].stairs[0].kind).toBe('l');
    expect(floors[2].stairs[0].entry).toBe('e');
  });

  it('縦向き（列が左右に分かれる）でも同じ。曲がる向きは昇る人から見た左右', () => {
    // 1 階は西の列を北から南へ、3 階は東の列（南が降り口）。DN は南の端の東の外
    const floors = [
      floor(1, [stair('F1-S1', 0, 2730, 910, 4095, 'straight', 'n', true)]),
      floor(2, [stair('F2-S1', 0, 1820, 2275, 5005, 'u', 'n', true)]),
      floor(3, [stair('F3-S1', 1365, 1820, 2275, 5005, 'straight', 's', false)]),
    ];
    splitStackedStairs(floors, [], () => ({ up: 'n', downPos: { x: 2356, y: 4547 } }));
    bendStackedStairs(floors);
    const s2 = floors[1].stairs[0];
    expect(s2.kind).toBe('straight');
    expect(s2.entry).toBe('n');
    expect([s2.minX, s2.maxX]).toEqual([1365, 2275]);
    const s1 = floors[0].stairs[0];
    expect(s1.kind).toBe('l');
    // 南へ下って東へ曲がる = 昇る人の左
    expect(s1.turn).toBe('left');
    expect([s1.minX, s1.minY, s1.maxX, s1.maxY]).toEqual([0, 2730, 2275, 5005]);
  });

  it('重ねた折り返し階段（1 階も同じ範囲の折り返し）は、そのまま', () => {
    const floors = tanaka();
    floors[0].stairs[0] = stair('F1-S1', 1820, 0, 5005, 2275, 'u', 'w', true);
    splitStackedStairs(floors, [], () => undefined);
    expect(floors[1].stairs[0].kind).toBe('u');
  });

  it('3 階の階段が短い（列の 6 割に満たない）・同じ列の上にある・最上階では、決めない', () => {
    const short = tanaka();
    short[2].stairs[0] = stair('F3-S1', 1820, 1365, 2730, 2275, 'straight', 'e', false);
    splitStackedStairs(short, [], () => undefined);
    expect(short[1].stairs[0].kind).toBe('u');
    // 1 階の階段と 3 階の階段が同じ列（積み重ねた直階段）
    const same = tanaka();
    same[2].stairs[0] = stair('F3-S1', 1820, 0, 5005, 910, 'straight', 'e', false);
    splitStackedStairs(same, [], () => undefined);
    expect(same[1].stairs[0].kind).toBe('u');
    // 2 階建て（途中の階が無い）
    const two = tanaka().slice(0, 2);
    splitStackedStairs(two, [], () => undefined);
    expect(two[1].stairs[0].kind).toBe('u');
  });

  it('UP の文字の側が、3 階の降り口から決まる昇り口と食い違うなら決めない', () => {
    const floors = tanaka();
    splitStackedStairs(floors, [], () => ({ up: 'e' }));
    expect(floors[1].stairs[0].kind).toBe('u');
  });

  it('切り替えを切ると、今までどおり', () => {
    const g = globalThis as { __NO_STACKED_STAIRS?: boolean };
    g.__NO_STACKED_STAIRS = true;
    try {
      const floors = tanaka();
      splitStackedStairs(floors, [], () => undefined);
      expect(floors[1].stairs[0].kind).toBe('u');
    } finally {
      delete g.__NO_STACKED_STAIRS;
    }
  });
});
