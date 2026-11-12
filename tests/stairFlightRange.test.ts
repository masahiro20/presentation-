// 階段まわりの読み違い（第 42 巡 ⑯。市岡様邸の 4 階建て: 同じ位置に積み重なる直階段）
//  - 直階段を、上がり切った先の踊り場（その階の床）まで含めて読まない
//  - 両側の壁の中の柱（四角）が向かい合う所を、段の線が 1 本通るだけで「壁＋引戸」にしない
//  - ずれて重なる 2 枚の壁（階段の突き当たりの厚い壁）を読む
//  - 上下階の重ね位置: 長さの違う階段は、昇り始めの端をそろえる
//  - UP・DN の文字だけで「階段」になった広い区画は、階段とホールに分ける
import { afterEach, describe, expect, it } from 'vitest';
import { alignOffset, buildFloor, detectPlans, splitStairRooms, type MmText, type PageMm } from '../src/parser/assemble';
import { detectWalls, type Seg } from '../src/parser/walls';
import type { Floor, Vec2 } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const BLACK = '#000000';
const T = 190;
const H = T / 2;
const O = 5000;
const fillSegs = (poly: Vec2[], color = BLACK): Seg[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length], width: 0, dashed: false, source: 'fill' as const, color }));
const stroke = (x0: number, y0: number, x1: number, y1: number, width = 0.36): Seg => ({ a: P(O + x0, O + y0), b: P(O + x1, O + y1), width, dashed: false, source: 'stroke' });
const text = (str: string, x: number, y: number, size = 300): MmText => ({ str, x: O + x, y: O + y, size, angle: 0 });
/** 壁（壁芯 (x0,y0)-(x1,y1)・厚み 190）の黒い塗り */
const wallPoly = (x0: number, y0: number, x1: number, y1: number): Vec2[] =>
  x0 === x1 ? rect(O + x0 - H, O + Math.min(y0, y1) - H, O + x0 + H, O + Math.max(y0, y1) + H) : rect(O + Math.min(x0, x1) - H, O + y0 - H, O + Math.max(x0, x1) + H, O + y0 + H);
/** 壁の両面の太い線（縦の壁は y の区間 [a,b] ごと、横の壁は x の区間ごと） */
const faces = (x0: number, y0: number, x1: number, y1: number, spans?: [number, number][]): Seg[] =>
  x0 === x1
    ? (spans ?? [[Math.min(y0, y1) - H, Math.max(y0, y1) + H]]).flatMap(([a, b]) => [stroke(x0 - H, a, x0 - H, b, 0.6), stroke(x0 + H, a, x0 + H, b, 0.6)])
    : (spans ?? [[Math.min(x0, x1) - H, Math.max(x0, x1) + H]]).flatMap(([a, b]) => [stroke(a, y0 - H, b, y0 - H, 0.6), stroke(a, y0 + H, b, y0 + H, 0.6)]);
const wall = (x0: number, y0: number, x1: number, y1: number, spans?: [number, number][]): Seg[] => [...fillSegs(wallPoly(x0, y0, x1, y1)), ...faces(x0, y0, x1, y1, spans)];
/** 壁の中の柱（壁厚の正方形。塗りと輪郭の太い線） */
const column = (cx: number, y0: number): Seg[] => {
  const r = rect(O + cx - H, O + y0, O + cx + H, O + y0 + T);
  return [...fillSegs(r), ...r.map((a, i) => ({ a, b: r[(i + 1) % 4], width: 0.6, dashed: false, source: 'stroke' as const }))];
};
/** 段の線（階段の幅いっぱい・間隔 237.5） */
const treads = (y0: number, n: number, x0 = 95, x1 = 855): Seg[] => Array.from({ length: n }, (_, k) => stroke(x0, y0 + 237.5 * k, x1, y0 + 237.5 * k));

const g = globalThis as { __NO_GAP_TWO_LINES?: boolean; __NO_OFFSET_DOUBLE_WALL?: boolean; __NO_STRAIGHT_LANDING?: boolean; __NO_STAIR_HALL_SPLIT?: boolean; __NO_ALIGN_STAIR_FOOT?: boolean };
afterEach(() => {
  delete g.__NO_GAP_TWO_LINES;
  delete g.__NO_OFFSET_DOUBLE_WALL;
  delete g.__NO_STRAIGHT_LANDING;
  delete g.__NO_STAIR_HALL_SPLIT;
  delete g.__NO_ALIGN_STAIR_FOOT;
});

/** 横の軸（壁芯 y）の上の開口と壁片 */
const onH = (det: ReturnType<typeof detectWalls>, y: number, tol = 30) => {
  const isH = (gi: number) => Math.abs(det.groups[gi].u.x) > 0.9;
  return {
    ops: det.openings.filter((o) => isH(o.g) && Math.abs(Math.abs(o.o) - (O + y)) < tol),
    pieceLen: det.pieces.filter((p) => isH(p.g) && Math.abs(Math.abs(p.o) - (O + y)) < tol).reduce((s, p) => s + (p.t1 - p.t0), 0),
  };
};

/**
 * 細長い家（3,800 × 9,000）の西の端に階段室（幅 760）。階段室の両側の壁の中、同じ高さ（y 5,000〜5,190）に柱が向かい合い、
 * その間を階段の段の線が通る（柱の面から 13mm の所に 1 本）
 */
function towerSegs(opts: { doubleWall?: boolean; oneLine?: boolean } = {}): Seg[] {
  const colSpans: [number, number][] = [[-H, 5000], [5190, 9000 + H]];
  const innerSpans: [number, number][] = [[2000 - H, 5000], [5190, 9000 + H]];
  return [
    ...wall(0, 0, 3800, 0),
    ...wall(0, 9000, 3800, 9000),
    ...wall(3800, 0, 3800, 9000),
    ...wall(0, 0, 0, 9000, colSpans),
    ...wall(950, 2000, 950, 9000, innerSpans),
    ...wall(950, 2000, 3800, 2000),
    ...column(0, 5000),
    ...column(950, 5000),
    // 段の線の列（柱の面から 13mm の所を通る 1 本を含む 13 本）。oneLine: その 1 本だけ（造作の棚の前の線など、列になっていない線）
    ...(opts.oneLine ? treads(5013, 1) : treads(5013 - 237.5 * 6, 13)),
    ...(opts.doubleWall
      ? [
          // 突き当たりの厚い壁: 厚み 190 の壁を 2 枚、119mm ずらして重ねる（面の線は 2,405・2,524・2,595・2,714）
          ...fillSegs(rect(O + 95, O + 2405, O + 855, O + 2595)),
          ...fillSegs(rect(O + 95, O + 2524, O + 855, O + 2714)),
          stroke(95, 2405, 855, 2405, 0.6),
          stroke(95, 2595, 855, 2595, 0.6),
          stroke(95, 2524, 855, 2524, 0.6),
          stroke(95, 2714, 855, 2714, 0.6),
        ]
      : []),
  ];
}

describe('壁の中の柱と柱の間を、段の線が 1 本通るだけの所', () => {
  it('窓・引戸のある壁にしない（階段が途中で 2 つに切れない）', () => {
    const det = detectWalls(towerSegs(), [], {}, []);
    expect(onH(det, 5095, 100).ops).toHaveLength(0);
  });

  it('列になっていない 1 本の線（造作の棚の前の線など）は、今までどおり区切りとして読む', () => {
    const det = detectWalls(towerSegs({ oneLine: true }), [], {}, []);
    const ops = onH(det, 5095, 100).ops;
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('window');
  });

  it('この判定を切ると、柱と柱の間が「窓」になる（直す前の読み違い）', () => {
    g.__NO_GAP_TWO_LINES = true;
    const det = detectWalls(towerSegs(), [], {}, []);
    const ops = onH(det, 5095, 100).ops;
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('window');
    expect(Math.round(ops[0].t1 - ops[0].t0)).toBe(760);
  });
});

describe('ずれて重なる 2 枚の壁（階段の突き当たりの厚い壁）', () => {
  it('2 枚とも壁として読む', () => {
    const det = detectWalls(towerSegs({ doubleWall: true }), [], {}, []);
    expect(onH(det, 2500, 20).pieceLen).toBeGreaterThan(700);
    expect(onH(det, 2619, 20).pieceLen).toBeGreaterThan(700);
  });

  it('この判定を切ると、互いに「相手の 2 本の線の間の線」になって、どちらも読めない（直す前）', () => {
    g.__NO_OFFSET_DOUBLE_WALL = true;
    const det = detectWalls(towerSegs({ doubleWall: true }), [], {}, []);
    expect(onH(det, 2500, 20).pieceLen).toBe(0);
    expect(onH(det, 2619, 20).pieceLen).toBe(0);
  });
});

describe('上下階の重ね位置: 長さの違う階段は、昇り始めの端をそろえる', () => {
  type Plan = Parameters<typeof alignOffset>[0];
  const hWall = (y: number, x0: number, x1: number) => ({ a: P(x0, y), b: P(x1, y), u: P(1, 0), n: P(0, 1), d: T, t0: x0, t1: x1, o: y, g: 0, openings: [], joinedA: false, joinedB: false });
  const plan = (walls: ReturnType<typeof hWall>[], segs: Seg[], texts: MmText[], bbox: { minX: number; minY: number; maxX: number; maxY: number }): Plan => ({ walls, segs, texts, bbox, arcs: [] }) as unknown as Plan;
  const line = (y: number): Seg => ({ a: P(190, y), b: P(948, y), width: 0.36, dashed: false, source: 'stroke' });
  /** 下の階: 段の線 9 本（5,795〜7,696。切断線まで）。壁は階段の突き当たり（4,745）と南（8,547） */
  const lower = (upY: number) =>
    plan(
      [hWall(4745, -100, 1991), hWall(8547, -100, 1991)],
      Array.from({ length: 9 }, (_, k) => line(5795 + 237.6 * k)),
      [{ str: 'UP', x: 1282, y: upY, size: 250, angle: 0 }],
      { minX: -100, minY: 0, maxX: 3900, maxY: 11400 },
    );
  /** 上の階（塔屋だけ）: 段の線 11 本（5,321〜7,696。上がり切りまで）。壁は北（4,271）と南（8,547）。
   *  北の壁を下の階の 4,745 に合わせても（474 南へ）、南の壁を 8,547 に合わせても、壁の重なりと階段の重なりは同じ */
  const upper = () =>
    plan(
      [hWall(4271, -100, 1039), hWall(8547, -100, 1039)],
      Array.from({ length: 11 }, (_, k) => line(5321 + 237.5 * k)),
      [],
      { minX: -100, minY: 900, maxX: 3900, maxY: 8700 },
    );

  it('UP の文字のある端（南）がそろう位置を取る', () => {
    expect(alignOffset(lower(8174), upper())).toEqual({ x: 0, y: 0 });
  });

  it('昇り始めが反対の端（北）なら、北の端がそろう位置', () => {
    const d = alignOffset(lower(5300), upper());
    expect(d.x).toBe(0);
    expect(Math.abs(d.y - 474)).toBeLessThanOrEqual(2);
  });
});

/**
 * 塔屋の階段室（幅 760 × 4,086）: 段の線は 5,221〜7,596 の 11 本。その北（4,366〜5,221）は屋上へ出る戸の前の踊り場で、DN の文字がある。
 * @param hall 階段室の東に、室名の無いホール（幅 760）を付ける（階段の東の壁は 5,598〜7,689 だけ。上と下でつながる）
 */
function stairPage(hall: boolean): PageMm {
  const segs: Seg[] = [
    ...wall(0, 0, 3800, 0),
    ...wall(0, 9000, 3800, 9000),
    ...wall(3800, 0, 3800, 9000),
    ...wall(0, 0, 0, 9000),
    ...wall(0, 4271, hall ? 1900 : 950, 4271),
    ...wall(0, 8547, hall ? 1900 : 950, 8547),
    ...(hall ? [...wall(950, 5598, 950, 7689), ...wall(1900, 4271, 1900, 8547)] : wall(950, 4271, 950, 8547)),
    ...(hall ? treads(5695, 9) : treads(5221, 11)),
    stroke(475, hall ? 5695 : 5221, 475, 8070),
  ];
  // 図面の枠（用紙の端）
  segs.push({ a: P(0, 0), b: P(500, 0), width: 0.2, dashed: false, source: 'stroke' }, { a: P(29000, 20500), b: P(29700, 20500), width: 0.2, dashed: false, source: 'stroke' }, { a: P(29700, 20000), b: P(29700, 21000), width: 0.2, dashed: false, source: 'stroke' });
  const texts = [
    ...(hall ? [text('UP', 1282, 8174, 250), text('DN', 1282, 5325, 250)] : [text('DN', 467, 4988, 250)]),
    text('洋室', 2700, 2000),
    text('（10.0帖）', 2700, 2400, 250),
    text('2 階', 1500, 9800, 398),
    text('平 面 図', 2950, 9800, 398),
  ];
  return { pageIndex: 0, segs, arcs: [], texts, fills: [], masks: [], colorFills: [] };
}
const read = (pg: PageMm): Floor => {
  const plans = detectPlans([pg], []);
  expect(plans.length).toBe(1);
  const f = buildFloor(plans[0], 2, 0, []);
  splitStairRooms(f);
  return f;
};

describe('直階段の上がり切った先の踊り場（DN の文字があり、段の線の無い帯）', () => {
  it('階段の範囲に含めない（上の端は、いちばん上の段の線）', () => {
    const f = read(stairPage(false));
    expect(f.stairs).toHaveLength(1);
    const st = f.stairs[0];
    expect(st.kind).toBe('straight');
    expect(Math.abs(st.minY - (O + 5221))).toBeLessThanOrEqual(30);
    // 踊り場は「階段」の部屋の床として残る
    const room = f.rooms.find((r) => r.type === 'stairs')!;
    expect(room).toBeTruthy();
    expect(Math.min(...room.polygon.map((q) => q.y))).toBeLessThan(O + 4500);
  });

  it('この判定を切ると、踊り場の奥の壁まで階段になる（直す前: 下の階の階段まで踊り場の奥行ぶん伸びた）', () => {
    g.__NO_STRAIGHT_LANDING = true;
    const f = read(stairPage(false));
    expect(f.stairs[0].minY).toBeLessThan(O + 4500);
  });
});

describe('UP・DN の文字だけで「階段」になった、階段よりずっと広い区画', () => {
  it('階段と、その前のホールに分ける', () => {
    const f = read(stairPage(true));
    const stairs = f.rooms.filter((r) => r.type === 'stairs');
    const halls = f.rooms.filter((r) => r.type === 'hall');
    expect(stairs).toHaveLength(1);
    expect(halls).toHaveLength(1);
    expect(halls[0].inferred).toBe(true);
    // 階段は段の範囲（0.76 × 1.9m = 1.4㎡ 前後）、ホールは残り
    expect(stairs[0].area).toBeLessThan(2.6);
    expect(halls[0].area).toBeGreaterThan(3.3);
  });

  it('この判定を切ると、ホールごと「階段」1 室（直す前）', () => {
    g.__NO_STAIR_HALL_SPLIT = true;
    const f = read(stairPage(true));
    expect(f.rooms.filter((r) => r.type === 'hall')).toHaveLength(0);
    const st = f.rooms.find((r) => r.type === 'stairs')!;
    expect(st.area).toBeGreaterThan(5);
  });
});
