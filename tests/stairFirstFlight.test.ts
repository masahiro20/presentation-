// 昇り始めの段が、玄関・ホールの区画に入るのを直す（第 42 巡 ⑫。大崎様邸 1 階）
// 折り返し階段の昇り始めの段は玄関に開いていて壁が無い。段の間の中壁で区画が切れると、昇り口の側の半分は「玄関」の一部になり、
// 「階段」は奥の半分だけになっていた（玄関 3.1 帖の半分が段。土間のタイルが段の下に敷かれる）
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
 * 1 階: 上の真ん中に折り返し階段（3,640〜5,460 × 0〜1,820。中壁 x=4,550）、その右が玄関（5,460〜7,280）。
 * 階段の左半分（奥の段）は壁で囲まれ「階段」の文字がある。右半分（昇り始めの段）は玄関に開いている（x=5,460 に壁なし）。
 * 下は LDK。階段・玄関と LDK の間は y=1,820 の壁で、右半分の前（4,650〜5,400）が昇り口の開口
 */
function page(mark: boolean): PageMm {
  const walls = [
    wallPoly(0, 0, 7280, 0), wallPoly(0, 5460, 7280, 5460), wallPoly(0, 0, 0, 5460), wallPoly(7280, 0, 7280, 5460),
    wallPoly(3640, 0, 3640, 1820), // 階段の左の壁
    wallPoly(4550, 0, 4550, 1820), // 中壁
    wallPoly(0, 1820, 4650, 1820), // 洋室・階段（左半分）の下の壁
    wallPoly(5400, 1820, 7280, 1820), // 玄関の下の壁
  ];
  const segs: Seg[] = [...walls.flatMap(fillSegs)];
  // 段の線（左右 2 列・6 段）
  for (let i = 0; i < 6; i++) {
    const y = O + 300 + i * 230;
    segs.push(stroke(O + 3693, y, O + 4497, y), stroke(O + 4603, y, O + 5460, y));
  }
  // 用紙の隅の線（図がページ全体を占めると図面枠として除かれる）
  segs.push(stroke(0, 0, 500, 0), stroke(29000, 20500, 29700, 20500), stroke(29700, 20000, 29700, 21000));
  const texts = [
    text('洋室', O + 1800, O + 900),
    text('階段', O + 4095, O + 1000, 200),
    text('玄関', O + 6400, O + 900),
    text('ＬＤＫ', O + 3600, O + 3700),
    text('（16.0帖）', O + 3600, O + 4100, 250),
    ...(mark ? [text('UP', O + 5005, O + 2050, 200)] : []),
    text('1 階', O + 3000, O + 6500, 398),
    text('平 面 図', O + 4450, O + 6500, 398),
  ];
  return { pageIndex: 0, segs, arcs: [], texts, fills: [], masks: [], colorFills: walls.map((poly) => ({ poly, color: '#808080' })) };
}

/**
 * 1 階: 同じ位置の折り返し階段だが、四方が壁で、左半分に「物入」の文字（階段下の物入）。中壁は細い線で、左右の半分は 1 つの区画。
 * 昇り口は右半分の下（4,650〜5,400 の開口）で、その前に UP の文字（舟橋様邸 1 階）
 */
function pageStorage(): PageMm {
  const walls = [
    wallPoly(0, 0, 7280, 0), wallPoly(0, 5460, 7280, 5460), wallPoly(0, 0, 0, 5460), wallPoly(7280, 0, 7280, 5460),
    wallPoly(3640, 0, 3640, 1820), // 階段の左の壁
    wallPoly(5460, 0, 5460, 1820), // 階段の右の壁（玄関との間）
    wallPoly(0, 1820, 4650, 1820),
    wallPoly(5400, 1820, 7280, 1820),
  ];
  const segs: Seg[] = [...walls.flatMap(fillSegs)];
  for (let i = 0; i < 6; i++) {
    const y = O + 300 + i * 230;
    segs.push(stroke(O + 3693, y, O + 4497, y), stroke(O + 4603, y, O + 5407, y));
  }
  segs.push(stroke(0, 0, 500, 0), stroke(29000, 20500, 29700, 20500), stroke(29700, 20000, 29700, 21000));
  const texts = [
    text('洋室', O + 1800, O + 900),
    text('物入', O + 4095, O + 1650, 200),
    text('玄関', O + 6400, O + 900),
    text('ＬＤＫ', O + 3600, O + 3700),
    text('（16.0帖）', O + 3600, O + 4100, 250),
    text('UP', O + 5005, O + 2050, 200),
    text('1 階', O + 3000, O + 6500, 398),
    text('平 面 図', O + 4450, O + 6500, 398),
  ];
  return { pageIndex: 0, segs, arcs: [], texts, fills: [], masks: [], colorFills: walls.map((poly) => ({ poly, color: '#808080' })) };
}

/**
 * 2 階: 同じ位置の折り返し階段。四方が壁の階段室で、真ん中に「吹抜」の文字（階段室の吹抜。×印は無い）。降り口は左半分の下で、その前に DN
 * （舟橋様邸 2 階: 階段の区画が「吹抜」になり、2 階へ階段でつながらなかった）
 */
function pageUpper(): PageMm {
  const walls = [
    wallPoly(0, 0, 7280, 0), wallPoly(0, 5460, 7280, 5460), wallPoly(0, 0, 0, 5460), wallPoly(7280, 0, 7280, 5460),
    wallPoly(3640, 0, 3640, 1820),
    wallPoly(5460, 0, 5460, 1820),
    wallPoly(0, 1820, 3700, 1820),
    wallPoly(4450, 1820, 7280, 1820),
  ];
  const segs: Seg[] = [...walls.flatMap(fillSegs)];
  for (let i = 0; i < 6; i++) {
    const y = O + 300 + i * 230;
    segs.push(stroke(O + 3693, y, O + 4497, y), stroke(O + 4603, y, O + 5407, y));
  }
  segs.push(stroke(0, 0, 500, 0), stroke(29000, 20500, 29700, 20500), stroke(29700, 20000, 29700, 21000));
  const texts = [
    text('洋室', O + 1800, O + 900),
    text('吹抜', O + 4550, O + 1000, 200),
    text('洋室', O + 6400, O + 900),
    text('ホール', O + 3600, O + 3700),
    text('DN', O + 4095, O + 2050, 200),
    text('2 階', O + 3000, O + 6500, 398),
    text('平 面 図', O + 4450, O + 6500, 398),
  ];
  return { pageIndex: 0, segs, arcs: [], texts, fills: [], masks: [], colorFills: walls.map((poly) => ({ poly, color: '#808080' })) };
}

/**
 * 1 階: 左上の隅に直階段（幅 w × 0〜2,730）。段は上の 1.6m、その下が踏み込みで、右のホールへ開いている（x=w の壁の 1,850〜2,600 が開口）。
 * この区画に室名は無く、下は洋室。昇り口の脇（ホール側）に UP の文字。
 * 室名の無い区画は隣の部屋から推定する: 幅 1,365 なら寝室の隣なので WIC（市岡様邸 1 階は CL）、幅 910 なら細長いので「通路」
 */
function pageNameless(w: number, mark: boolean): PageMm {
  const walls = [
    wallPoly(0, 0, 7280, 0), wallPoly(0, 5460, 7280, 5460), wallPoly(0, 0, 0, 5460), wallPoly(7280, 0, 7280, 5460),
    wallPoly(w, 0, w, 1850), // 段の横の壁
    wallPoly(w, 2600, w, 2730), // 昇り口の開口（1,850〜2,600）の下の袖壁
    wallPoly(0, 2730, 3640, 2730), // 洋室の上の壁
    wallPoly(3640, 0, 3640, 5460), // LDK との間の壁
  ];
  const segs: Seg[] = [...walls.flatMap(fillSegs)];
  // 段の線（8 段）
  for (let i = 0; i < 8; i++) segs.push(stroke(O + 53, O + 150 + i * 230, O + w - 53, O + 150 + i * 230));
  segs.push(stroke(0, 0, 500, 0), stroke(29000, 20500, 29700, 20500), stroke(29700, 20000, 29700, 21000));
  const texts = [
    text('ホール', O + 2500, O + 1200),
    text('洋室', O + 1800, O + 4000),
    text('（6.0帖）', O + 1800, O + 4400, 250),
    text('ＬＤＫ', O + 5400, O + 2500),
    text('（12.0帖）', O + 5400, O + 2900, 250),
    ...(mark ? [text('UP', O + w + 90, O + 2300, 200)] : []),
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
const bbox = (poly: Vec2[]) => ({ minX: Math.min(...poly.map((p) => p.x)) - O, maxX: Math.max(...poly.map((p) => p.x)) - O, minY: Math.min(...poly.map((p) => p.y)) - O, maxY: Math.max(...poly.map((p) => p.y)) - O });

describe('昇り始めの段は「階段」の区画', () => {
  it('UP の文字が正面にある半分（玄関に開いた昇り始めの段）を、玄関から階段へ移す', () => {
    const f = read(page(true));
    const st = f.stairs[0];
    expect(st?.kind).toBe('u');
    expect(st.entry).toBe('s');
    const stairs = f.rooms.filter((r) => r.type === 'stairs');
    expect(stairs).toHaveLength(1);
    const sb = bbox(stairs[0].polygon);
    // 階段は範囲いっぱい（3,640〜5,460）
    expect(sb.minX).toBeLessThan(3700);
    expect(sb.maxX).toBeGreaterThan(5350);
    expect(stairs[0].area).toBeGreaterThan(2.9);
    // 玄関は 5,460 から右だけ
    const ent = f.rooms.find((r) => r.type === 'entrance')!;
    expect(bbox(ent.polygon).minX).toBeGreaterThan(5350);
    expect(ent.area).toBeLessThan(3.6);
  });

  it('UP の文字が無い階段は触らない（昇り口の側が分からない）', () => {
    const f = read(page(false));
    const ent = f.rooms.find((r) => r.type === 'entrance')!;
    expect(bbox(ent.polygon).minX).toBeLessThan(4700);
  });

  it('切り替えを切ると、今までどおり玄関に段が入る', () => {
    const g = globalThis as { __NO_STAIR_FLIGHT?: boolean };
    g.__NO_STAIR_FLIGHT = true;
    try {
      const f = read(page(true));
      const ent = f.rooms.find((r) => r.type === 'entrance')!;
      expect(bbox(ent.polygon).minX).toBeLessThan(4700);
      expect(ent.area).toBeGreaterThan(4.5);
    } finally {
      delete g.__NO_STAIR_FLIGHT;
    }
  });

  it('階段の範囲いっぱいの区画が「物入」（階段下の物入）: UP の文字のある半分を階段、物入の文字のある半分を物入に分ける', () => {
    const f = read(pageStorage());
    const st = f.stairs[0];
    expect(st?.kind).toBe('u');
    const stairs = f.rooms.filter((r) => r.type === 'stairs');
    expect(stairs).toHaveLength(1);
    const sb = bbox(stairs[0].polygon);
    expect(sb.minX).toBeGreaterThan(4450);
    expect(sb.maxX).toBeGreaterThan(5350);
    const store = f.rooms.find((r) => r.name === '物入')!;
    expect(store.type).toBe('storage');
    expect(bbox(store.polygon).maxX).toBeLessThan(4650);
    // 半分ずつ（1,820 × 910 ≒ 1.66 ㎡）
    expect(stairs[0].area).toBeGreaterThan(1.3);
    expect(stairs[0].area).toBeLessThan(2.0);
    expect(store.area).toBeGreaterThan(1.3);
    expect(store.area).toBeLessThan(2.0);
  });

  it('名前の無い区画（隣の部屋から WIC・CL・通路と推定したもの）に昇り口があれば、その区画は「階段」', () => {
    for (const w of [1365, 910]) {
      const at = (f: Floor) => f.rooms.find((r) => bbox(r.polygon).maxX < w + 100 && bbox(r.polygon).maxY < 2800)!;
      const f = read(pageNameless(w, true));
      const st = f.stairs[0];
      expect(st?.kind).toBe('straight');
      expect(st.entry).toBe('s');
      expect(at(f).type).toBe('stairs');
      expect(at(f).name).toBe('階段');
      // 切り替えを切ると、今までどおり隣の部屋から推定した名前（収納・通路）
      const g = globalThis as { __NO_STAIR_FLIGHT?: boolean };
      g.__NO_STAIR_FLIGHT = true;
      try {
        const f2 = read(pageNameless(w, true));
        expect(at(f2).type).toBe(w > 1000 ? 'closet' : 'hall');
        expect(at(f2).inferred).toBe(true);
      } finally {
        delete g.__NO_STAIR_FLIGHT;
      }
    }
  });

  it('2 階の階段室の「吹抜」の文字: 区画が階段の範囲と同じなら「階段」（×印のある本物の吹抜・階段より広い吹抜はそのまま）', () => {
    const plans = detectPlans([pageUpper()], []);
    const f = buildFloor(plans[0], 2, 0, []);
    splitStairRooms(f);
    expect(f.stairs).toHaveLength(1);
    const at = f.rooms.find((r) => bbox(r.polygon).minX > 3500 && bbox(r.polygon).maxX < 5600 && bbox(r.polygon).maxY < 1900)!;
    expect(at.type).toBe('stairs');
    expect(at.name).toBe('階段');
    const g = globalThis as { __NO_STAIR_FLIGHT?: boolean };
    g.__NO_STAIR_FLIGHT = true;
    try {
      const f2 = buildFloor(detectPlans([pageUpper()], [])[0], 2, 0, []);
      splitStairRooms(f2);
      const at2 = f2.rooms.find((r) => bbox(r.polygon).minX > 3500 && bbox(r.polygon).maxX < 5600 && bbox(r.polygon).maxY < 1900)!;
      expect(at2.type).toBe('void');
    } finally {
      delete g.__NO_STAIR_FLIGHT;
    }
  });
});
