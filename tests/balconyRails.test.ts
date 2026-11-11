import { describe, expect, it } from 'vitest';
import { dropBrokenLines, findBalconyRails } from '../src/parser/balconyRails';
import { assembleModel, buildFloor, detectPlans, type MmText, type PageMm } from '../src/parser/assemble';
import type { Seg } from '../src/parser/walls';
import type { Vec2 } from '../src/core/types';
import { pointInPolygon } from '../src/core/geometry';

const P = (x: number, y: number): Vec2 => ({ x, y });
const W = (x0: number, y0: number, x1: number, y1: number, d = 106) => ({ a: P(x0, y0), b: P(x1, y1), d });
const Ln = (x0: number, y0: number, x1: number, y1: number) => ({ a: P(x0, y0), b: P(x1, y1) });
const len = (r: { a: Vec2; b: Vec2 }) => Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y);

/**
 * 本体 5460 角（原点が左上）＋ 西の袖 [-2730..0]×[2730..5460]。
 * 本体の西の壁と袖の北の壁にはさまれた三角 (-2730,2730)-(0,0)-(0,2730) がバルコニー
 */
const houseWalls = [
  W(0, 0, 5460, 0),
  W(5460, 0, 5460, 5460),
  W(-2730, 5460, 5460, 5460),
  W(0, 0, 0, 2730),
  W(-2730, 2730, 0, 2730),
  W(-2730, 2730, -2730, 5460),
];
const bbox = { minX: -2730, minY: 0, maxX: 5460, maxY: 5460 };
/** 斜めの手すり: 角から角へ、外へ 0・50・100mm の三重線 */
const diagRail = () => {
  const n = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 }; // 外向き（左上）
  return [0, 50, 100].map((o) => Ln(-2730 + n.x * o, 2730 + n.y * o, 0 + n.x * o, 0 + n.y * o));
};

describe('手すりが細い線だけのバルコニー（findBalconyRails）', () => {
  it('斜めの手すり（三重線）の三角のバルコニー: 手すり壁 1 本を、線の芯に、壁から壁まで（田中様邸 2 階）', () => {
    const found = findBalconyRails({ bbox, labels: [P(-800, 1900)], walls: houseWalls, wallPolys: [], closers: [], lines: diagRail() });
    expect(found.length).toBe(1);
    const f = found[0];
    expect(f.rails.length).toBe(1);
    const r = f.rails[0];
    // 45°
    expect(Math.abs(Math.abs(r.b.x - r.a.x) - Math.abs(r.b.y - r.a.y))).toBeLessThan(5);
    // 厚みは三重線の幅、芯は 50mm 外
    expect(r.d).toBe(100);
    const off = Math.abs(((r.a.x + 2730) * 1 + (r.a.y - 2730) * 1) / Math.SQRT2);
    expect(off).toBeGreaterThan(40);
    expect(off).toBeLessThan(60);
    // 両端は壁（y=2730 の壁・x=0 の壁）の芯を越えて外面まで（壁の端で出会う角を塞ぐ）
    const ends = [r.a, r.b].sort((p, q) => p.x - q.x);
    expect(ends[0].y).toBeGreaterThan(2730);
    expect(ends[0].y).toBeLessThan(2730 + 60);
    expect(ends[1].x).toBeGreaterThan(0);
    expect(ends[1].x).toBeLessThan(60);
    expect(len(r)).toBeGreaterThan(3800);
    // 囲みの広さは三角形（3.7㎡）に近い
    expect(f.area).toBeGreaterThan(3.2);
    expect(f.area).toBeLessThan(4.0);
  });

  it('手すりを横切って中で止まる引き出し線があっても、手すりは 1 本のまま', () => {
    const lines = [...diagRail(), Ln(-2600, 300, -900, 1700)];
    const found = findBalconyRails({ bbox, labels: [P(-800, 1900)], walls: houseWalls, wallPolys: [], closers: [], lines });
    expect(found.length).toBe(1);
    expect(found[0].rails.length).toBe(1);
  });

  it('破線（短い実線の列）は手すりにしない。室名が囲まれていなければ何も足さない', () => {
    // 斜めの線を 300mm の線＋100mm のすき間の列にする
    const dashes: { a: Vec2; b: Vec2 }[] = [];
    const L = 2730 * Math.SQRT2;
    for (let t = 0; t + 300 <= L; t += 400) dashes.push(Ln(-2730 + (t / Math.SQRT2), 2730 - t / Math.SQRT2, -2730 + (t + 300) / Math.SQRT2, 2730 - (t + 300) / Math.SQRT2));
    expect(findBalconyRails({ bbox, labels: [P(-800, 1900)], walls: houseWalls, wallPolys: [], closers: [], lines: dashes })).toEqual([]);
    // 線が無い
    expect(findBalconyRails({ bbox, labels: [P(-800, 1900)], walls: houseWalls, wallPolys: [], closers: [], lines: [Ln(-5000, -900, -4000, -900)] })).toEqual([]);
  });

  it('室名が部屋の中（屋外でない）なら何もしない', () => {
    expect(findBalconyRails({ bbox, labels: [P(2700, 2700)], walls: houseWalls, wallPolys: [], closers: [], lines: diagRail() })).toEqual([]);
  });

  /**
   * ルーフバルコニー: 塔屋 [0..1820]×[3640..7280]、バルコニー [0..3640]×[0..3640]。
   * 西 (x=0) と南の一部 (y=3640, x 1820..3640) は壁、北と東は二重線（190mm）の手すり
   */
  const roofWalls = [
    W(0, 3640, 1820, 3640),
    W(1820, 3640, 1820, 7280),
    W(0, 7280, 1820, 7280),
    W(0, 0, 0, 7280),
    W(1820, 3640, 3640, 3640),
  ];
  const roofBox = { minX: 0, minY: 0, maxX: 3640, maxY: 7280 };
  const roofRails = [Ln(0, 0, 3640, 0), Ln(0, -190, 3830, -190), Ln(3640, 0, 3640, 3640), Ln(3830, -190, 3830, 3640)];

  it('ルーフバルコニー: 二重線の手すり 2 辺を壁にして、角で交わらせる（市岡様邸 4 階）', () => {
    const found = findBalconyRails({ bbox: roofBox, labels: [P(1800, 1800)], walls: roofWalls, wallPolys: [], closers: [], lines: roofRails });
    expect(found.length).toBe(1);
    const rails = found[0].rails;
    expect(rails.length).toBe(2);
    const top = rails.find((r) => Math.abs(r.a.y - r.b.y) < 1)!;
    const right = rails.find((r) => Math.abs(r.a.x - r.b.x) < 1)!;
    expect(top).toBeTruthy();
    expect(right).toBeTruthy();
    expect(top.d).toBe(190);
    expect(Math.round(top.a.y)).toBe(-95);
    expect(Math.round(right.a.x)).toBe(3735);
    // 角 (3735, -95) で出会い、たがいに相手の外面（厚みの半分 = 95mm 先）まで伸びて角を塞ぐ
    expect(Math.round(Math.max(top.a.x, top.b.x))).toBe(3830);
    expect(Math.round(Math.min(right.a.y, right.b.y))).toBe(-190);
    // 西の端は壁 x=0 の外面まで（壁の端で出会う角）、南の端は壁 y=3640 の外面まで
    expect(Math.round(Math.min(top.a.x, top.b.x))).toBe(-53);
    expect(Math.round(Math.max(right.a.y, right.b.y))).toBe(3693);
    expect(found[0].area).toBeGreaterThan(12.5);
  });

  it('バルコニーの中の設備の箱（室外機）の線は手すりにしない', () => {
    const box = [Ln(2800, 100, 3600, 100), Ln(3600, 100, 3600, 700), Ln(3600, 700, 2800, 700), Ln(2800, 700, 2800, 100)];
    const found = findBalconyRails({ bbox: roofBox, labels: [P(1800, 1800)], walls: roofWalls, wallPolys: [], closers: [], lines: [...roofRails, ...box] });
    expect(found.length).toBe(1);
    expect(found[0].rails.length).toBe(2);
  });

  it('壁の面の線・サッシの線（壁に沿う線）は手すりにしない', () => {
    // 西の壁の外面の線と、南の壁の面の線
    const faces = [Ln(55, 0, 55, 3640), Ln(1820, 3585, 3640, 3585)];
    const found = findBalconyRails({ bbox: roofBox, labels: [P(1800, 1800)], walls: roofWalls, wallPolys: [], closers: [], lines: [...roofRails, ...faces] });
    expect(found.length).toBe(1);
    expect(found[0].rails.length).toBe(2);
  });
});

describe('破線の見分け（dropBrokenLines）', () => {
  it('同じ直線上にすき間をあけて 3 本以上並ぶ線は除く', () => {
    const dashes = [0, 400, 800, 1200, 1600].map((x) => Ln(x, 100, x + 300, 100));
    const solid = [Ln(0, 500, 2000, 500), Ln(2000, 500, 4000, 500)];
    const once = [Ln(0, 900, 1000, 900), Ln(1200, 900, 2000, 900)];
    const out = dropBrokenLines([...dashes, ...solid, ...once]);
    expect(out.length).toBe(4);
    expect(out.every((l) => l.a.y !== 100)).toBe(true);
  });
  it('斜めの破線も除く', () => {
    const d = [0, 1, 2, 3].map((k) => Ln(k * 400, k * 400, k * 400 + 280, k * 400 + 280));
    expect(dropBrokenLines(d).length).toBe(0);
  });
});

// ---- 図面から（detectPlans → buildFloor） ----
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const fillSegs = (poly: Vec2[]): Seg[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length], width: 0, dashed: false, source: 'fill' as const }));
const stroke = (x0: number, y0: number, x1: number, y1: number): Seg => ({ a: P(x0, y0), b: P(x1, y1), width: 0.2, dashed: false, source: 'stroke' });
const text = (str: string, x: number, y: number, size = 300): MmText => ({ str, x, y, size, angle: 0 });
const T = 106;
function wallPoly(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return x0 === x1 ? rect(x0 - T / 2, Math.min(y0, y1) - T / 2, x0 + T / 2, Math.max(y0, y1) + T / 2) : rect(Math.min(x0, x1) - T / 2, y0 - T / 2, Math.max(x0, x1) + T / 2, y0 + T / 2);
}

/** 2 階の図: 本体 5460 角＋西の袖。三角のバルコニーの手すりは細い三重線 */
function balconyPage(withRail = true): PageMm {
  const O = 8000;
  const walls = houseWalls.map((w) => wallPoly(O + w.a.x, O + w.a.y, O + w.b.x, O + w.b.y));
  const rails = withRail ? diagRail().map((l) => stroke(O + l.a.x, O + l.a.y, O + l.b.x, O + l.b.y)) : [];
  const segs = [...walls.flatMap(fillSegs), ...rails, stroke(0, 0, 500, 0), stroke(29000, 20500, 29700, 20500), stroke(29700, 20000, 29700, 21000)];
  const texts = [
    text('ＬＤＫ', O + 2700, O + 2500),
    text('（18.0帖）', O + 2700, O + 2900, 250),
    text('洋室', O - 1300, O + 4000),
    text('バルコニー', O - 800, O + 1900, 250),
    text('2 階', O + 1500, O + 6500, 398),
    text('平 面 図', O + 2950, O + 6500, 398),
  ];
  return { pageIndex: 0, segs, arcs: [], texts, fills: [], masks: [], colorFills: walls.map((poly) => ({ poly, color: '#808080' })) };
}

describe('手すりが細い線だけのバルコニーを部屋として読む（buildFloor）', () => {
  it('2 階の図で、屋外にある「バルコニー」の室名から三角のバルコニーができ、斜めの手すり壁が付く', () => {
    const plans = detectPlans([balconyPage()], []);
    expect(plans.length).toBe(1);
    const f = buildFloor(plans[0], 2, 0, []);
    const bal = f.rooms.find((r) => r.type === 'balcony');
    expect(bal).toBeTruthy();
    expect(bal!.name).toBe('バルコニー');
    expect(bal!.area).toBeGreaterThan(3.3);
    expect(bal!.area).toBeLessThan(4.4);
    const O = 8000;
    expect(pointInPolygon(P(O - 800, O + 1900), bal!.polygon)).toBe(true);
    // 斜めの壁（手すり）
    const diag = f.walls.filter((w) => Math.abs(Math.abs(w.b.x - w.a.x) - Math.abs(w.b.y - w.a.y)) < 60 && Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) > 3000);
    expect(diag.length).toBe(1);
    expect(diag[0].exterior).toBe(true);
    // LDK はそのまま
    expect(f.rooms.some((r) => r.type === 'ldk')).toBe(true);
  });

  it('手すりの線が無ければ、バルコニーは作らない（屋外のまま）', () => {
    const plans = detectPlans([balconyPage(false)], []);
    const f = buildFloor(plans[0], 2, 0, []);
    expect(f.rooms.some((r) => r.type === 'balcony')).toBe(false);
  });

  it('1 階の図では補わない（1 階のテラス・デッキは外構として読む）', () => {
    const plans = detectPlans([balconyPage()], []);
    const f = buildFloor(plans[0], 1, 0, []);
    expect(f.rooms.some((r) => r.type === 'balcony' && r.area > 3)).toBe(false);
  });
});

describe('斜めの手すり壁は、格子へ寄せた壁の角を追う（assembleModel）', () => {
  it('三角のバルコニー: 斜めの壁は角から角へ、外形に半間未満の段が残らない', () => {
    const m = assembleModel([balconyPage()], 'テスト', []);
    const f = m.floors[m.floors.length - 1];
    const bal = f.rooms.find((r) => r.type === 'balcony');
    expect(bal).toBeTruthy();
    // 2,730 角の直角三角形 = 3.73 ㎡
    expect(bal!.area).toBeGreaterThan(3.65);
    expect(bal!.area).toBeLessThan(3.8);
    const diag = f.walls.filter((w) => Math.abs(w.b.x - w.a.x) > 500 && Math.abs(w.b.y - w.a.y) > 500);
    expect(diag.length).toBe(1);
    const d = diag[0];
    // 45°
    expect(Math.abs(Math.abs(d.b.x - d.a.x) - Math.abs(d.b.y - d.a.y))).toBeLessThan(5);
    // バルコニーの輪郭の斜めの辺の両端（＝壁の角）が、斜めの壁の芯の上にある
    const L = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y);
    const offLine = (p: Vec2) => Math.abs((p.x - d.a.x) * (d.b.y - d.a.y) - (p.y - d.a.y) * (d.b.x - d.a.x)) / L;
    const onLine = bal!.polygon.filter((p) => offLine(p) < 8);
    expect(onLine.length).toBe(2);
    expect(Math.abs(Math.abs(onLine[0].x - onLine[1].x) - 2730)).toBeLessThan(5);
    expect(Math.abs(Math.abs(onLine[0].y - onLine[1].y) - 2730)).toBeLessThan(5);
    // 外形は 5 角形（本体＋袖 − 三角）で、辺は縦・横・45° だけ
    expect(f.outline.length).toBe(1);
    expect(f.outline[0].length).toBe(5);
    for (let i = 0; i < 5; i++) {
      const a = f.outline[0][i];
      const b = f.outline[0][(i + 1) % 5];
      const ax = Math.abs(b.x - a.x);
      const ay = Math.abs(b.y - a.y);
      expect(ax < 1 || ay < 1 || Math.abs(ax - ay) < 5).toBe(true);
    }
    // 外形の辺に 30〜440mm の短い段が無い
    for (const poly of f.outline)
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        expect(L < 30 || L >= 440).toBe(true);
      }
  });
});
