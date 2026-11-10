// 読み取りの点数: 帖数・面積表・上下階・戸と窓・壁・階と部屋名を 100 点にし、失った点の大きい順に「まず直す」を出す
import { describe, expect, it } from 'vitest';
import { readingScore } from '../src/parser/readingScore';
import type { BuildingModel, Floor, Opening, Room, Vec2, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
let seq = 0;
const room = (name: string, type: Room['type'], poly: Vec2[], extra: Partial<Room> = {}): Room => {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const area = ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / 1e6;
  return { id: `r${seq++}`, name, type, polygon: poly, labelPos: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }, area, ...extra };
};
const wall = (id: string, a: Vec2, b: Vec2, exterior: boolean): Wall => ({ id, a, b, thickness: exterior ? 150 : 90, exterior, ...(exterior ? { outsideSign: 1 as const } : {}) });
const op = (id: string, wallId: string, kind: Opening['kind'], t0: number, w: number): Opening => ({ id, wallId, kind, t0, t1: t0 + w, sill: kind === 'window' ? 900 : 0, height: kind === 'window' ? 1100 : 2000, hingeAtStart: true, swingSide: 1, confidence: 1 });

/** 1 階 LDK（8m × 4m = 19.8 帖）＋洋室（4m × 3.6m = 8.9 帖）、2 階 洋室 2 室。窓・戸・玄関・階段あり */
function model(): BuildingModel {
  const o1 = rect(0, 0, 8000, 7600);
  const ldk = room('LDK', 'ldk', rect(0, 0, 8000, 4000), { labeledTatami: 19.8 });
  const b1 = room('洋室', 'bedroom', rect(0, 4000, 4000, 7600), { labeledTatami: 8.9 });
  const hall = room('ホール', 'hall', rect(4000, 5800, 6000, 7600));
  const ent = room('玄関', 'entrance', rect(6000, 4000, 8000, 7600));
  const stairs = room('階段', 'stairs', rect(4000, 4000, 6000, 5800));
  const walls1: Wall[] = [wall('n', o1[0], o1[1], true), wall('e', o1[1], o1[2], true), wall('s', o1[2], o1[3], true), wall('w', o1[3], o1[0], true), wall('i1', { x: 0, y: 4000 }, { x: 8000, y: 4000 }, false), wall('i2', { x: 4000, y: 4000 }, { x: 4000, y: 7600 }, false), wall('i3', { x: 6000, y: 4000 }, { x: 6000, y: 7600 }, false)];
  const ops1: Opening[] = [op('w1', 's', 'window', 1000, 1690), op('w2', 'n', 'window', 2000, 1690), op('d1', 'i1', 'sliding', 4500, 1600), op('d2', 'i1', 'door', 1000, 780), op('d3', 'i2', 'door', 2000, 780), op('d4', 'i3', 'door', 2000, 780), op('e1', 's', 'entrance', 6500, 900)];
  const f1: Floor = { level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, outline: [o1], rooms: [ldk, b1, hall, ent, stairs], walls: walls1, openings: ops1, stairs: [{ id: 'st1', minX: 4000, minY: 4000, maxX: 6000, maxY: 5800, goesUp: true, kind: 'straight', entry: 's', steps: 14 }] };
  const o2 = rect(0, 0, 8000, 4000);
  const a2 = room('洋室1', 'bedroom', rect(0, 0, 4000, 4000), { labeledTatami: 9.9 });
  const b2 = room('洋室2', 'bedroom', rect(4000, 0, 8000, 4000), { labeledTatami: 9.9 });
  const walls2: Wall[] = [wall('n2', o2[0], o2[1], true), wall('e2', o2[1], o2[2], true), wall('s2', o2[2], o2[3], true), wall('w2', o2[3], o2[0], true), wall('i21', { x: 4000, y: 0 }, { x: 4000, y: 4000 }, false)];
  const ops2: Opening[] = [op('w21', 's2', 'window', 1000, 1690), op('w22', 's2', 'window', 5000, 1690), op('d21', 'i21', 'door', 1000, 780), op('d22', 'n2', 'open', 3000, 1600)];
  const f2: Floor = { level: 2, elevation: 3400, height: 2900, ceilingHeight: 2400, outline: [o2], rooms: [a2, b2], walls: walls2, openings: ops2, stairs: [{ id: 'st2', minX: 4000, minY: 4000, maxX: 6000, maxY: 5800, goesUp: false, kind: 'straight', entry: 's', steps: 14 }] };
  return { name: 't', floors: [f1, f2], northAngleDeg: 0, report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {}, areaTable: { 1: 60.8, 2: 32.0 } } };
}

describe('readingScore', () => {
  it('下の階のビルトインガレージは、上の階が載る広さに数える（1 階が車庫＋玄関の家で「2 階の方が広い」と減点しない）', () => {
    const m = model();
    // 1 階の LDK（32 ㎡）を車庫に変える → 床面積は 60.8 → 28.8 ㎡、2 階は 32 ㎡
    m.floors[0].rooms[0] = { ...m.floors[0].rooms[0], name: '車庫', type: 'garage', labeledTatami: undefined };
    delete m.report.areaTable;
    const rs = readingScore(m);
    expect(rs.parts.find((p) => p.id === 'floors')!.note).not.toMatch(/より広い/);
  });
  it('読めたのが 2 階だけなら平屋扱いにしない（1 階が読めていない）', () => {
    const m = model();
    m.floors = [{ ...m.floors[0], level: 2 }];
    delete m.report.areaTable;
    const rs = readingScore(m);
    const fl = rs.parts.find((p) => p.id === 'floors')!;
    expect(fl.got).toBe(0);
    expect(fl.note).toMatch(/1階が読めていません/);
    expect(rs.fixes.some((f) => /1階の平面図が読めていません/.test(f.title))).toBe(true);
  });
  it('最上階が塔屋（階段と踊り場だけ）でも「部屋がほとんど読めていない」にしない', () => {
    const m = model();
    const ph: Floor = { level: 3, elevation: 6300, height: 2600, ceilingHeight: 2300, outline: [rect(4000, 4000, 6000, 7600)], rooms: [room('階段', 'stairs', rect(4000, 4000, 6000, 5800)), room('通路', 'hall', rect(4000, 5800, 6000, 7600))], walls: [], openings: [], stairs: [{ id: 'st3', minX: 4000, minY: 4000, maxX: 6000, maxY: 5800, goesUp: false, kind: 'straight', entry: 's', steps: 14 }] };
    m.floors.push(ph);
    const rs = readingScore(m);
    // 2 階（洋室 2 室だけ）は元から「少ない」と出る。塔屋の 3 階は数えない
    expect(rs.parts.find((p) => p.id === 'rooms')!.note).not.toMatch(/3階/);
  });
  it('帖数・面積表・上下階・戸と窓が揃った間取りは高得点で、まず直す所は少ない', () => {
    const rs = readingScore(model());
    expect(rs.score).toBeGreaterThanOrEqual(85);
    expect(rs.parts.map((p) => p.id)).toEqual(['tatami', 'areaTable', 'floors', 'openings', 'walls', 'rooms']);
    expect(rs.parts.reduce((s, p) => s + p.max, 0)).toBe(100);
    expect(rs.parts.find((p) => p.id === 'tatami')!.got).toBe(25);
    expect(rs.parts.find((p) => p.id === 'areaTable')!.got).toBe(15);
    expect(rs.parts.find((p) => p.id === 'floors')!.got).toBe(15);
    expect(rs.grade).toBe('good');
  });
  it('帖数が図面とずれた部屋は点を失い、まず直す所に出る', () => {
    const m = model();
    m.floors[0].rooms[1].labeledTatami = 6.0; // 読み取りは 8.9 帖
    const rs = readingScore(m);
    const t = rs.parts.find((p) => p.id === 'tatami')!;
    expect(t.got).toBeCloseTo(18.8, 1);
    expect(t.note).toMatch(/洋室 6.0→8.9帖/);
    expect(rs.fixes[0].title).toMatch(/洋室: 図面は 6.0 帖、読み取りは 8.9 帖（広い）/);
  });
  it('面積表と階の面積が食い違えば点を失う（3% まで満点・8% まで半分）', () => {
    const m = model();
    m.report.areaTable = { 1: 60.8, 2: 36.0 }; // 2 階 32.0 に対して 11% の差
    const rs = readingScore(m);
    expect(rs.parts.find((p) => p.id === 'areaTable')!.got).toBe(7.5);
    expect(rs.fixes.some((f) => /2階の床面積/.test(f.title))).toBe(true);
    m.report.areaTable = { 1: 60.8, 2: 33.5 }; // 4.5% の差
    expect(readingScore(m).parts.find((p) => p.id === 'areaTable')!.got).toBe(11.3);
    delete m.report.areaTable;
    expect(readingScore(m).parts.find((p) => p.id === 'areaTable')!.got).toBe(10);
  });
  it('上の階が下の階より広い・1 階に上り階段が無いと上下階の点を失う', () => {
    const m = model();
    m.floors[0].stairs = [];
    let rs = readingScore(m);
    expect(rs.parts.find((p) => p.id === 'floors')!.got).toBe(8);
    expect(rs.fixes[0].title).toMatch(/上り階段/);
    m.floors[1].rooms.push(room('バルコニー', 'bedroom', rect(0, 4000, 8000, 9000)));
    rs = readingScore(m);
    expect(rs.parts.find((p) => p.id === 'floors')!.got).toBe(0);
  });
  it('玄関ドアが無い・出入口の無い部屋があると戸・窓の点を失う', () => {
    const m = model();
    m.floors[0].openings = m.floors[0].openings.filter((o) => o.kind !== 'entrance' && o.id !== 'd2');
    const rs = readingScore(m);
    const o = rs.parts.find((p) => p.id === 'openings')!;
    expect(o.got).toBeLessThan(17);
    expect(o.note).toMatch(/玄関ドアが無い/);
    expect(rs.fixes.some((f) => /玄関ドア/.test(f.title))).toBe(true);
  });
  it('面積表でも上の階が広い家（ガレージの上に LDK）は上下階の点を失わない', () => {
    const m = model();
    m.floors[1].rooms.push(room('LDK', 'ldk', rect(0, 4000, 8000, 9000)));
    m.report.areaTable = { 1: 60.8, 2: 72.0 };
    const rs = readingScore(m);
    expect(rs.parts.find((p) => p.id === 'floors')!.got).toBe(15);
  });
  it('ほとんど読めていない間取りは低い点になり、まず直すの先頭で読み直しをすすめる', () => {
    const m = model();
    m.floors = [{ ...m.floors[0], rooms: m.floors[0].rooms.slice(0, 2) }];
    const rs = readingScore(m);
    expect(rs.score).toBeLessThan(30);
    expect(rs.grade).toBe('poor');
    expect(rs.fixes[0].title).toMatch(/ほとんど読めていません/);
    m.floors = [];
    expect(readingScore(m).score).toBeLessThanOrEqual(5);
  });
  it('点数は 0〜100 に収まり、まず直す所は失った点の大きい順', () => {
    const m = model();
    m.floors[0].stairs = [];
    m.floors[0].rooms[0].labeledTatami = 10;
    const rs = readingScore(m);
    expect(rs.score).toBeGreaterThanOrEqual(0);
    expect(rs.score).toBeLessThanOrEqual(100);
    for (let i = 1; i < rs.fixes.length; i++) expect(rs.fixes[i - 1].lost).toBeGreaterThanOrEqual(rs.fixes[i].lost);
  });
});
