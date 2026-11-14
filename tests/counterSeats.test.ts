// カウンター席の読み取り（parser/symbols.ts symbolsToItems）:
//  椅子が壁に向かって 1 列に並んでいたら、食卓ではなく「壁付けの造作カウンター＋椅子」として読む
//  （御社のご提案: 窓に沿った造作のスタディカウンターに椅子 4 脚／書斎の造作デスクに椅子 2 脚）
import { describe, expect, it } from 'vitest';
import { symbolsToItems, type PlanSymbol } from '../src/parser/symbols';
import { windowsOverCounters } from '../src/parser/assemble';
import type { Floor, FurnitureItem, Opening, Room, Vec2, Wall } from '../src/core/types';

const rectPts = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const chair = (x: number, y: number): PlanSymbol => ({ kind: 'chair', x, y, w: 480, h: 500, n: 60 });
const wall = (id: string, a: Vec2, b: Vec2): Wall => ({ id, a, b, thickness: 120 }) as Wall;
/** 6 × 4 m の部屋を囲む 4 枚の壁（芯は部屋の縁から 60 外） */
const boxWalls = (x0: number, y0: number, x1: number, y1: number): Wall[] => [
  wall('n', { x: x0 - 60, y: y0 - 60 }, { x: x1 + 60, y: y0 - 60 }),
  wall('s', { x: x0 - 60, y: y1 + 60 }, { x: x1 + 60, y: y1 + 60 }),
  wall('w', { x: x0 - 60, y: y0 - 60 }, { x: x0 - 60, y: y1 + 60 }),
  wall('e', { x: x1 + 60, y: y0 - 60 }, { x: x1 + 60, y: y1 + 60 }),
];
const room = (type: Room['type'], name: string): Room => ({ id: 'R1', name, type, polygon: rectPts(0, 0, 6000, 4000), area: 24, labelPos: { x: 3000, y: 3000 } });

describe('カウンター席（椅子が壁に向かって 1 列）', () => {
  it('北の壁から 800 の所に椅子 4 脚が 700 間隔 → 壁付けの造作カウンター＋椅子 4 脚（ホールでも読む）', () => {
    const chairs = [1500, 2200, 2900, 3600].map((x) => chair(x, 800));
    const { items } = symbolsToItems(chairs, [room('hall', 'ホール')], boxWalls(0, 0, 6000, 4000), [rectPts(-200, -200, 6200, 4200)], 1);
    expect(items.filter((it) => it.kind === 'dining').length).toBe(0);
    const c = items.find((it) => it.kind === 'builtin');
    expect(c).toBeTruthy();
    expect(c!.variant).toBe('counter');
    expect(c!.seats).toBe(4);
    // 壁の面（y ≒ 0）に付き、列の中央（x = 2,550）。幅は両端の椅子の間隔 2,100 ＋ 700
    expect(Math.abs(c!.y)).toBeLessThan(60);
    expect(c!.x).toBeCloseTo(2550, -1);
    expect(c!.w).toBeCloseTo(2.8, 1);
    expect(c!.d).toBeGreaterThanOrEqual(0.45);
    expect(c!.d).toBeLessThanOrEqual(0.65);
    // 並びは東西、部屋側は南（rot 0 = 東向きに並び手前が南）
    expect(c!.rot % 360).toBe(0);
  });

  it('書斎の机に椅子 2 脚（壁から 750）→ 造作カウンター＋椅子 2 脚', () => {
    const chairs = [chair(2000, 3250), chair(2750, 3250)];
    const { items } = symbolsToItems(chairs, [room('study', '書斎')], boxWalls(0, 0, 6000, 4000), [rectPts(-200, -200, 6200, 4200)], 1);
    const c = items.find((it) => it.kind === 'builtin');
    expect(c?.variant).toBe('counter');
    expect(c?.seats).toBe(2);
    // 南の壁（y ≒ 4,000）に付く
    expect(Math.abs(c!.y - 4000)).toBeLessThan(60);
  });

  it('部屋の中ほどの食卓（両側に椅子）は、今までどおり食卓', () => {
    const chairs = [chair(2400, 1650), chair(3100, 1650), chair(2400, 2700), chair(3100, 2700)];
    const { items } = symbolsToItems(chairs, [room('ldk', 'ＬＤＫ')], boxWalls(0, 0, 6000, 4000), [rectPts(-200, -200, 6200, 4200)], 1);
    expect(items.some((it) => it.kind === 'dining')).toBe(true);
    expect(items.some((it) => it.kind === 'builtin')).toBe(false);
  });

  it('壁際でも、向かい合う 2 脚（1,200 離れている）は カウンター席にしない', () => {
    const chairs = [chair(2000, 800), chair(3200, 800)];
    const { items } = symbolsToItems(chairs, [room('ldk', 'ＬＤＫ')], boxWalls(0, 0, 6000, 4000), [rectPts(-200, -200, 6200, 4200)], 1);
    expect(items.some((it) => it.kind === 'builtin')).toBe(false);
  });

  it('書斎の幅いっぱいの造作デスク: 椅子 2 脚が 1.1m あけて並び、両脇の壁が近い → 壁から壁までのカウンター。LDK では 1.1m あいた 2 脚は読まない', () => {
    // 幅 2.6m × 奥行 1.3m の書斎（北が外壁）。椅子は北の壁から 680
    const walls = boxWalls(0, 0, 2600, 1300);
    const study: Room = { id: 'R1', name: '書斎', type: 'study', polygon: rectPts(0, 0, 2600, 1300), area: 3.4, labelPos: { x: 1300, y: 900 } };
    // 建物の外形は、北の壁が外壁（その向こうは外）、南は室内（廊下）が続く
    const outline = [rectPts(-200, -60, 2800, 4000)];
    const chairs = [chair(730, 680), chair(1870, 680)];
    const { items } = symbolsToItems(chairs, [study], walls, outline, 1);
    const c = items.find((it) => it.kind === 'builtin');
    expect(c?.variant).toBe('counter');
    expect(c?.seats).toBe(2);
    // 両側（北 680・南 620）に壁があるが、外壁の側（北）に付く。幅は壁から壁まで（約 2.6m）、中心は部屋の中央
    expect(Math.abs(c!.y)).toBeLessThan(60);
    expect(c!.w).toBeGreaterThan(2.4);
    expect(c!.w).toBeLessThanOrEqual(2.62);
    expect(c!.x).toBeCloseTo(1300, -2);
    // 同じ並びでも LDK では読まない（壁際の小さなテーブルに向かい合う 2 脚）
    const ldk: Room = { ...study, name: 'ＬＤＫ', type: 'ldk' };
    expect(symbolsToItems(chairs, [ldk], walls, outline, 1).items.some((it) => it.kind === 'builtin')).toBe(false);
  });

  it('壁から遠い 1 列（キッチンのカウンターの前のスツールなど。壁まで 1.5 m）は カウンター席にしない', () => {
    const chairs = [1500, 2200, 2900].map((x) => chair(x, 1500));
    const { items } = symbolsToItems(chairs, [room('ldk', 'ＬＤＫ')], boxWalls(0, 0, 6000, 4000), [rectPts(-200, -200, 6200, 4200)], 1);
    expect(items.some((it) => it.kind === 'builtin')).toBe(false);
  });
});

describe('カウンター席の前の窓', () => {
  // 北の壁（y = 0）に幅 2.6m のカウンター（椅子 3 脚）。同じ壁に窓 2 つ（カウンターの前・離れた所）、東の壁に窓 1 つ
  const north = wall('n', { x: 0, y: 0 }, { x: 8000, y: 0 });
  const east = wall('e', { x: 8000, y: 0 }, { x: 8000, y: 4000 });
  const win = (id: string, wallId: string, t0: number, t1: number, o: Partial<Opening> = {}): Opening => ({ id, wallId, kind: 'window', t0, t1, sill: 1800, height: 500, windowStyle: 'high', ...o });
  const counter: FurnitureItem = { id: 'c', kind: 'builtin', variant: 'counter', x: 2500, y: 60, rot: 0, w: 2.6, d: 0.45, seats: 3 };
  const floorOf = (openings: Opening[], items: FurnitureItem[] = [counter]): Floor => ({ level: 1, elevation: 0, height: 2900, walls: [north, east], openings, rooms: [], stairs: [], outline: [], planItems: items }) as unknown as Floor;

  it('カウンターの付く壁の窓は、天端のすぐ上からの横長の窓（腰高 780・高さ 900）。仕様でそろえ直さない印が付く', () => {
    const front = win('w1', 'n', 1400, 3600);
    const away = win('w2', 'n', 5500, 7200);
    const side = win('w3', 'e', 500, 2000);
    windowsOverCounters([floorOf([front, away, side])]);
    expect(front.sill).toBe(780);
    expect(front.height).toBe(900);
    expect(front.windowStyle).toBe('koshi');
    expect(front.heightFrom).toBe('joinery');
    // カウンターから離れた窓・別の壁の窓はそのまま
    expect(away.sill).toBe(1800);
    expect(side.sill).toBe(1800);
  });

  it('立面図で高さが分かっている窓・室内窓・椅子の無いカウンターは変えない', () => {
    const known = win('w1', 'n', 1400, 3600, { heightFrom: 'elevation' });
    const inner = win('w2', 'n', 1400, 3600, { interior: true });
    windowsOverCounters([floorOf([known, inner])]);
    expect(known.sill).toBe(1800);
    expect(inner.sill).toBe(1800);
    const plain = win('w3', 'n', 1400, 3600);
    windowsOverCounters([floorOf([plain], [{ ...counter, seats: undefined }])]);
    expect(plain.sill).toBe(1800);
  });
});
