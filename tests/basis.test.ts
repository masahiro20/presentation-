import { describe, it, expect } from 'vitest';
import { takeoff, floorCategory, gableTriangleArea } from '../src/estimate/areas';
import { areaBasis, wallBasis, roofBasis, interiorBasis, compassAxes, wallDirOf, basisTotalsMatch } from '../src/estimate/basis';
import { basisSheets, basisSheetFor } from '../src/drawings/basis';
import type { BuildingModel, Floor, Room } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (id: string, name: string, type: Room['type'], poly: { x: number; y: number }[], extra: Partial<Room> = {}): Room =>
  ({ id, name, type, polygon: poly, area: Math.abs(poly.reduce((s, p, i) => s + p.x * poly[(i + 1) % poly.length].y - poly[(i + 1) % poly.length].x * p.y, 0)) / 2e6, ...extra }) as Room;
const floor = (level: number, outline: { x: number; y: number }[][], rooms: Room[]): Floor =>
  ({ level, height: 2900, ceilingHeight: 2400, elevation: 500 + (level - 1) * 2900, outline, rooms, walls: [], openings: [], stairs: [] }) as unknown as Floor;

// 1 階 10m × 6m（西 4m はビルトインガレージ）、2 階 6m × 6m は東側（ガレージの上は屋根）＋ 南へ 1m 張り出し
const f1 = floor(1, [rect(0, 0, 10000, 6000)], [room('g', 'ガレージ', 'garage', rect(0, 0, 4000, 6000)), room('l', 'ＬＤＫ', 'ldk', rect(4000, 0, 10000, 6000))]);
const f2 = floor(2, [rect(4000, 0, 10000, 7000)], [room('v', '吹抜', 'void', rect(4000, 0, 7000, 3000)), room('b', '寝室', 'bedroom', rect(7000, 0, 10000, 7000)), room('t', 'トイレ', 'toilet', rect(4000, 3000, 7000, 7000))]);
const model = { floors: [f1, f2], northAngleDeg: 0 } as unknown as BuildingModel;
const shed = { grade: 'P' as const, eavesMm: 450, pitch: 2, roofType: 'shed' as const };
const gable = { grade: 'P' as const, eavesMm: 450, pitch: 4, roofType: 'gable' as const };

describe('数量の根拠: 拾いと同じ数字に分解できる', () => {
  it('床面積: 階ごとの外形 − 引く区画 が takeoff と一致し、引いた区画と張り出しが分かる', () => {
    const a = takeoff(model, shed);
    const ab = areaBasis(model, shed);
    expect(ab.floors[0].floorArea).toBeCloseTo(a.floor1, 2);
    expect(ab.floors[1].floorArea).toBeCloseTo(a.floor2, 2);
    expect(ab.floors[0].excluded.map((e) => e.kind)).toEqual(['garage']);
    expect(ab.floors[1].excluded.map((e) => e.kind)).toEqual(['void']);
    // 2 階の南 1m × 6m が 1 階の外（施工面積の追加分 = ガレージ 24 ＋ 張り出し 6）
    expect(ab.floors[1].overhang).toBeCloseTo(6, 0);
    expect(ab.pilotis).toBeCloseTo(6, 0);
    expect(a.extraArea).toBeCloseTo(24 + 6, 0);
  });

  it('外壁: 方位ごとの帯の合計 = 外壁面積、ガレージの帯 = 外壁 − 壁の断熱', () => {
    const a = takeoff(model, shed);
    const wb = wallBasis(model, shed);
    expect(wb.total).toBeCloseTo(a.extWall, 1);
    expect(wb.garageWall).toBeCloseTo(a.extWall - a.insulWall, 1);
    expect(basisTotalsMatch(model, shed)).toBe(true);
    // 4 方位がそろい、南面には 1 階の基礎・外壁・2 階の外壁・パラペットがある
    const south = wb.byDir.south.rows.map((r) => `${r.kind}${r.level}`);
    expect(south).toContain('found1');
    expect(south).toContain('wall1');
    expect(south).toContain('wall2');
    expect(south.some((k) => k.startsWith('parapet'))).toBe(true);
    // 北向きの辺（y が小さい側、外向き法線 (0,−1)）は北面
    expect(wallDirOf({ x: 0, y: -1 }, compassAxes(0))).toBe('north');
    expect(wallDirOf({ x: 1, y: 0 }, compassAxes(0))).toBe('east');
    // 真北が 90° 回っていれば方位も回る
    expect(wallDirOf({ x: 0, y: -1 }, compassAxes(90))).toBe('west');
  });

  it('切妻: 妻壁の三角は 2 面（短辺側の 2 方位に 1 つずつ）', () => {
    const a = takeoff(model, gable);
    const b = takeoff(model, { ...gable, roofType: 'hip' });
    const tri = gableTriangleArea(f2, 4);
    expect(tri).toBeCloseTo((6 / 2) * ((6 / 2) * 0.4), 3); // 短辺 6m: 3 × 1.2
    expect(a.extWall - b.extWall).toBeCloseTo(2 * tri, 1);
    const wb = wallBasis(model, gable);
    const gables = wb.pieces.filter((p) => p.kind === 'gable');
    expect(gables).toHaveLength(2);
    // 2 階は 6m × 7m（短辺が x 方向）→ 三角は南北の面
    expect(gables.map((g) => g.dir).sort()).toEqual(['north', 'south']);
    expect(wb.total).toBeCloseTo(a.extWall, 1);
  });

  it('屋根: （平面 ＋ 軒の出）× 勾配 = 屋根面積、軒天・断熱の内訳が合う', () => {
    const a = takeoff(model, shed);
    const rb = roofBasis(model, shed);
    expect(rb.roofArea).toBeCloseTo(a.roofArea, 2);
    expect((rb.union + rb.eaveArea) * rb.slope).toBeCloseTo(a.roofArea, 0);
    expect(rb.soffitArea).toBeCloseTo(rb.eaveArea + rb.overhang, 0);
    // ガレージ 4m × 6m のうち、2 階が載っていない所 = 全部（2 階は x ≥ 4000）
    expect(rb.garageCeil).toBeCloseTo(24, 0);
    expect(rb.insulArea).toBeCloseTo(rb.union - rb.garageCeil + rb.overhang, 0);
    expect(rb.eaveRuns.length).toBeGreaterThan(4);
  });

  it('内部: 床仕上げの区分が takeoff の面積と一致し、床の仕上げを変えた部屋はそれに従う', () => {
    const a = takeoff(model, shed);
    const ib = interiorBasis(model, shed);
    expect(ib.byCat.flooring).toBeCloseTo(a.flooringArea, 2);
    expect(ib.byCat.tile).toBeCloseTo(a.floorTileArea, 2);
    expect(ib.byCat.garage).toBeCloseTo(24, 2);
    // LDK を畳コーナー扱い（floorFinish: 'tatami'）にすると畳の枚数に入り、フローリングから抜ける
    const l = f1.rooms.find((r) => r.id === 'l')!;
    expect(floorCategory(l)).toBe('flooring');
    expect(floorCategory({ ...l, floorFinish: 'tatami' } as Room)).toBe('tatami');
    const m2 = { ...model, floors: [{ ...f1, rooms: [f1.rooms[0], { ...l, floorFinish: 'tatami' }] }, f2] } as unknown as BuildingModel;
    const a2 = takeoff(m2, shed);
    expect(a2.flooringArea).toBeCloseTo(a.flooringArea - 36, 1);
    expect(a2.tatami1).toBe(Math.round(36 / 1.62));
    // 土間に変えた部屋は内部ポーチ（土間コン）に
    const m3 = { ...model, floors: [{ ...f1, rooms: [f1.rooms[0], { ...l, floorFinish: 'doma' }] }, f2] } as unknown as BuildingModel;
    expect(takeoff(m3, shed).porchIn).toBeCloseTo(a.porchIn + 36, 1);
  });

  it('シートは 4 枚でき、色塗り・表・凡例が入る', () => {
    const info = { project: 'テスト邸 新築工事', drawing: '数量の根拠', date: '2026.11.05', designer: '' };
    const sheets = basisSheets(model, shed, info, { overrides: { extWall: 999 }, notes: ['造作洗面 1 台'] });
    expect(sheets.map((s) => s.id)).toEqual(['area', 'wall', 'roof', 'interior']);
    for (const s of sheets) expect(s.svg.startsWith('<svg')).toBe(true);
    expect(sheets[0].svg).toContain('床面積・施工面積（見積の拾い）');
    expect(sheets[0].svg).toContain('ビルトインガレージ');
    expect(sheets[1].svg).toContain('→ 上書き 999');
    expect(sheets[1].svg).toContain('南面 外壁の拾い');
    expect(sheets[2].svg).toContain('屋根伏せ');
    expect(sheets[3].svg).toContain('造作洗面 1 台');
    expect(basisSheetFor('roofArea')).toBe('roof');
    expect(basisSheetFor('extWall')).toBe('wall');
    expect(basisSheetFor('floor1')).toBe('area');
    expect(basisSheetFor('doors')).toBe('interior');
  });
});
