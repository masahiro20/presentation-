// 玄関の区画を土間とホールに分ける（図面 → 部屋。第 42 巡 ⑫。市岡様邸: 玄関 5.8 帖が全部土間になっていた）
import { describe, expect, it } from 'vitest';
import { buildFloor, detectPlans, splitStairRooms, type MmText, type PageMm } from '../src/parser/assemble';
import type { Seg } from '../src/parser/walls';
import type { Floor, Vec2 } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const fillSegs = (poly: Vec2[]): Seg[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length], width: 0, dashed: false, source: 'fill' as const, color: '#808080' }));
const stroke = (x0: number, y0: number, x1: number, y1: number): Seg => ({ a: P(x0, y0), b: P(x1, y1), width: 0.2, dashed: false, source: 'stroke' });
const text = (str: string, x: number, y: number, size = 300): MmText => ({ str, x, y, size, angle: 0 });
const T = 106;
const O = 5000;
const wallPoly = (x0: number, y0: number, x1: number, y1: number): Vec2[] =>
  x0 === x1 ? rect(O + x0 - T / 2, O + Math.min(y0, y1) - T / 2, O + x0 + T / 2, O + Math.max(y0, y1) + T / 2) : rect(O + Math.min(x0, x1) - T / 2, O + y0 - T / 2, O + Math.max(x0, x1) + T / 2, O + y0 + T / 2);

/**
 * 1 階: 左に玄関（0〜2,730 × 0〜3,640）。上半分（y < 1,820）がタイルの土間、y=1,820 に框の線、下半分は線の無い床。
 * 「ホール」の室名は無い。右は LDK
 */
function page(hallName = false): PageMm {
  const walls = [
    wallPoly(0, 0, 7280, 0), wallPoly(0, 5460, 7280, 5460), wallPoly(0, 0, 0, 5460), wallPoly(7280, 0, 7280, 5460),
    wallPoly(2730, 0, 2730, 5460), // 玄関・洋室と LDK の間
    wallPoly(0, 3640, 2730, 3640), // 玄関の下（洋室との間）
  ];
  const segs: Seg[] = [...walls.flatMap(fillSegs)];
  // タイルの目地（300 角）と框の線
  for (let x = 353; x < 2677; x += 300) segs.push(stroke(O + x, O + 53, O + x, O + 1820));
  for (let y = 353; y < 1820; y += 300) segs.push(stroke(O + 53, O + y, O + 2677, O + y));
  segs.push(stroke(O + 53, O + 1820, O + 2677, O + 1820));
  segs.push(stroke(0, 0, 500, 0), stroke(29000, 20500, 29700, 20500), stroke(29700, 20000, 29700, 21000));
  const texts = [
    text('玄関', O + 1400, O + 950),
    ...(hallName ? [text('ホール', O + 1400, O + 2700)] : []),
    text('洋室', O + 1365, O + 4500),
    text('ＬＤＫ', O + 5000, O + 2500),
    text('（15.0帖）', O + 5000, O + 2900, 250),
    text('1 階', O + 3000, O + 6500, 398),
    text('平 面 図', O + 4450, O + 6500, 398),
  ];
  return { pageIndex: 0, segs, arcs: [], texts, fills: [], masks: [], colorFills: walls.map((poly) => ({ poly, color: '#808080' })) };
}

const read = (pg: PageMm): Floor => {
  const plans = detectPlans([pg], []);
  expect(plans.length).toBe(1);
  const f = buildFloor(plans[0], 1, 0, []);
  splitStairRooms(f);
  return f;
};
const maxY = (r: { polygon: Vec2[] }) => Math.max(...r.polygon.map((p) => p.y)) - O;
const minY = (r: { polygon: Vec2[] }) => Math.min(...r.polygon.map((p) => p.y)) - O;

describe('玄関の区画: 土間と、上がり框の先の床', () => {
  it('タイルの目地のある側を玄関（土間）、線の無い側を「ホール」（推定）に分ける', () => {
    const f = read(page());
    const ent = f.rooms.find((r) => r.type === 'entrance')!;
    const hall = f.rooms.find((r) => r.type === 'hall')!;
    expect(ent).toBeTruthy();
    expect(hall).toBeTruthy();
    expect(hall.name).toBe('ホール');
    expect(hall.inferred).toBe(true);
    // 境は框の線（y ≒ 1,820）。玄関は上、ホールは下
    expect(maxY(ent)).toBeLessThan(1900);
    expect(minY(hall)).toBeGreaterThan(1750);
    expect(ent.area).toBeGreaterThan(4.4);
    expect(ent.area).toBeLessThan(5.3);
    expect(hall.area).toBeGreaterThan(4.4);
    expect(hall.area).toBeLessThan(5.3);
    // 収納・階段にはしない
    expect(f.rooms.filter((r) => r.type === 'storage' || r.type === 'stairs')).toHaveLength(0);
  });

  it('床の側に「ホール」の文字があれば、その名前（推定ではない）', () => {
    const f = read(page(true));
    const hall = f.rooms.find((r) => r.type === 'hall')!;
    expect(hall.name).toBe('ホール');
    expect(hall.inferred).toBeFalsy();
    expect(f.rooms.find((r) => r.type === 'entrance')!.name).toBe('玄関');
  });

  it('切り替えを切ると、今までどおり 1 つの玄関', () => {
    const g = globalThis as { __NO_DOMA_SPLIT?: boolean };
    g.__NO_DOMA_SPLIT = true;
    try {
      const f = read(page());
      const ent = f.rooms.find((r) => r.type === 'entrance')!;
      expect(ent.area).toBeGreaterThan(9);
      expect(f.rooms.some((r) => r.type === 'hall')).toBe(false);
    } finally {
      delete g.__NO_DOMA_SPLIT;
    }
  });
});
