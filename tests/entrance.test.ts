// 玄関ドアの見つけ方: 玄関ドアとして読めなくても、玄関に面した外向きの戸・ポーチの戸・ガレージから入る玄関を玄関の戸として扱う
import { describe, expect, it } from 'vitest';
import { entranceDoorOf, hasEntranceDoor } from '../src/core/entrance';
import { ensureOpenings } from '../src/parser/ensureOpenings';
import type { BuildingModel, Floor, Opening, Room, Vec2, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (id: string, name: string, type: Room['type'], poly: Vec2[], extra: Partial<Room> = {}): Room => {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { id, name, type, polygon: poly, labelPos: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }, area: ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / 1e6, ...extra };
};
const wall = (id: string, a: Vec2, b: Vec2, exterior: boolean): Wall => ({ id, a, b, thickness: exterior ? 150 : 90, exterior, ...(exterior ? { outsideSign: 1 as const } : {}) });
const op = (id: string, wallId: string, kind: Opening['kind'], t0: number, w: number): Opening => ({ id, wallId, kind, t0, t1: t0 + w, sill: 0, height: 2000, hingeAtStart: true, swingSide: 1, confidence: 0.9 });

/** 玄関（0..2000 × 4000..6000）が南の外壁 s に面している 1 階。ホールが北隣 */
function floor(doorKind: Opening['kind'] | null, garage = false): Floor {
  const ent = room('e', '玄関', 'entrance', rect(0, 4000, 2000, 6000));
  const hall = room('h', 'ホール', 'hall', rect(0, 2000, 2000, 4000));
  const rooms = [ent, hall];
  const walls: Wall[] = [wall('s', { x: 0, y: 6000 }, { x: 2000, y: 6000 }, true), wall('w', { x: 0, y: 6000 }, { x: 0, y: 2000 }, true), wall('e', { x: 2000, y: 2000 }, { x: 2000, y: 6000 }, true), wall('n', { x: 0, y: 2000 }, { x: 2000, y: 2000 }, true), wall('i', { x: 0, y: 4000 }, { x: 2000, y: 4000 }, false)];
  const openings: Opening[] = [op('hd', 'i', 'door', 600, 780)];
  if (doorKind) openings.push(op('sd', 's', doorKind, 500, doorKind === 'sliding' ? 1600 : 900));
  if (garage) {
    rooms.push(room('g', 'ガレージ', 'garage', rect(2000, 2000, 6000, 6000), { garageKind: 'builtin' }));
    openings.push(op('gd', 'e', 'door', 2500, 780));
  }
  return { level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, outline: [rect(0, 2000, garage ? 6000 : 2000, 6000)], rooms, walls, openings, stairs: [] };
}
const model = (f: Floor): BuildingModel => ({ name: 't', floors: [f], northAngleDeg: 0, report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} } });

describe('entranceDoorOf', () => {
  it('玄関ドアがあればそれ', () => {
    const f = floor('entrance');
    expect(entranceDoorOf(f)).toMatchObject({ via: 'entrance', op: { id: 'sd' } });
  });
  it('玄関に面した外向きの引戸（引戸の玄関）を玄関の戸として扱う', () => {
    const f = floor('sliding');
    expect(entranceDoorOf(f)).toMatchObject({ via: 'outside', op: { id: 'sd' } });
    expect(hasEntranceDoor(model(f))).toBe(true);
  });
  it('ガレージから入る玄関: ガレージとの間の戸を出入口と見る', () => {
    const f = floor(null, true);
    expect(entranceDoorOf(f)).toMatchObject({ via: 'garage', op: { id: 'gd' } });
  });
  it('玄関に外向きの戸が無ければ無し（ホールとの戸は数えない）', () => {
    expect(entranceDoorOf(floor(null))).toBeNull();
  });
});

describe('ensureOpenings と玄関', () => {
  it('外に面した開き戸は玄関ドアにする', () => {
    const f = floor('door');
    ensureOpenings(f.walls, f.openings, f.rooms, 1);
    expect(f.openings.find((o) => o.id === 'sd')!.kind).toBe('entrance');
    expect(f.openings.filter((o) => o.kind === 'entrance')).toHaveLength(1);
  });
  it('引戸の玄関はそのまま、玄関ドアを足さない', () => {
    const f = floor('sliding');
    ensureOpenings(f.walls, f.openings, f.rooms, 1);
    expect(f.openings.find((o) => o.id === 'sd')!.kind).toBe('sliding');
    expect(f.openings.some((o) => o.kind === 'entrance')).toBe(false);
  });
  it('ガレージから入る玄関には玄関ドアを足さない', () => {
    const f = floor(null, true);
    ensureOpenings(f.walls, f.openings, f.rooms, 1);
    expect(f.openings.some((o) => o.kind === 'entrance')).toBe(false);
  });
  it('外に面した区間に幅 700 以上の窓しか無い玄関は、その窓を玄関ドアにする（袖付きドアの記号を窓と読んだもの）', () => {
    const f = floor(null);
    f.openings.push({ id: 'win', wallId: 's', kind: 'window', t0: 400, t1: 1600, sill: 900, height: 1100, hingeAtStart: true, swingSide: 1, confidence: 0.9, windowStyle: 'koshi' });
    ensureOpenings(f.walls, f.openings, f.rooms, 1);
    const w = f.openings.find((o) => o.id === 'win')!;
    expect(w.kind).toBe('entrance');
    expect(w.sill).toBe(0);
    expect(w.height).toBeGreaterThanOrEqual(2200);
    expect(f.openings.filter((o) => o.kind === 'entrance')).toHaveLength(1);
  });
  it('戸が何も無ければ外に面した壁に玄関ドアを置く', () => {
    const f = floor(null);
    ensureOpenings(f.walls, f.openings, f.rooms, 1);
    expect(f.openings.some((o) => o.kind === 'entrance')).toBe(true);
  });
});
