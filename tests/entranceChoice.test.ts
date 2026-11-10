// 玄関ドアは 1 つ: 1 階の外壁の開き戸がいくつも読めたとき、玄関らしい 1 つだけを玄関ドアにし、残りは勝手口・門扉にする
import { describe, expect, it } from 'vitest';
import { chooseEntrance, exteriorDoorRole } from '../src/parser/entranceChoice';
import type { Opening, Room, Vec2, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (id: string, name: string, type: Room['type'], x0: number, y0: number, x1: number, y1: number): Room => ({ id, name, type, polygon: rect(x0, y0, x1, y1), labelPos: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, area: ((x1 - x0) * (y1 - y0)) / 1e6 });
const wall = (id: string, a: Vec2, b: Vec2, outsideSign: 1 | -1 = 1): Wall => ({ id, a, b, thickness: 160, exterior: true, outsideSign });
const ent = (id: string, wallId: string, t0: number, w: number): Opening => ({ id, wallId, kind: 'entrance', t0, t1: t0 + w, sill: 0, height: 2200, hingeAtStart: true, confidence: 0.95 });

/**
 * 家（0..8000 × 0..6000）: 玄関（左上）・LDK（下）・ガレージ（右上）。北の外壁 n に玄関ドアとガレージの通用口、
 * 西の外壁 w に LDK の勝手口、家の外の塀 f に門扉
 */
function house() {
  const rooms = [room('e', '玄関', 'entrance', 0, 0, 2000, 2000), room('g', 'ガレージ', 'garage', 4000, 0, 8000, 3000), room('l', 'ＬＤＫ', 'ldk', 0, 3000, 8000, 6000)];
  const walls = [
    wall('n', { x: 0, y: 0 }, { x: 8000, y: 0 }, -1),
    wall('w', { x: 0, y: 6000 }, { x: 0, y: 0 }, -1),
    wall('f', { x: 9000, y: -3000 }, { x: 12000, y: -3000 }),
  ];
  const openings = [ent('gd', 'n', 5000, 740), ent('kd', 'w', 1500, 840), ent('ed', 'n', 600, 880), ent('gate', 'f', 1000, 600)];
  return { walls, openings, rooms, outline: [rect(0, 0, 8000, 6000)] };
}

describe('玄関ドアを 1 つに絞る', () => {
  it('玄関に入る戸だけが玄関ドア。ガレージ・LDK の戸は勝手口、塀の戸は開口になる（酒井様邸: 玄関ドアが 3 か所）', () => {
    const f = house();
    const res = chooseEntrance(f);
    const by = Object.fromEntries(f.openings.map((o) => [o.id, o]));
    expect(by.ed.kind).toBe('entrance');
    expect(by.ed.service).toBeUndefined();
    expect(by.gd).toMatchObject({ kind: 'door', service: true, height: 2000 });
    expect(by.kd).toMatchObject({ kind: 'door', service: true });
    expect(by.gate.kind).toBe('open');
    expect(res).toEqual({ service: 2, gate: 1 });
    // 勝手口は外開き（壁の外向きの側）
    expect(by.gd.swingSide).toBe(-1);
  });

  it('ガレージの通用口しか読めていないときは、それを玄関ドアにしない（玄関ドアは後の補いで置く）', () => {
    const f = house();
    f.openings = f.openings.filter((o) => o.id === 'gd');
    chooseEntrance(f);
    expect(f.openings[0]).toMatchObject({ kind: 'door', service: true });
  });

  it('玄関の室名が無くても、ホール・LDK に入る戸は玄関ドアの候補', () => {
    const f = house();
    f.rooms = f.rooms.filter((r) => r.id !== 'e');
    f.openings = f.openings.filter((o) => o.id === 'kd' || o.id === 'gd');
    chooseEntrance(f);
    expect(f.openings.find((o) => o.id === 'kd')!.kind).toBe('entrance');
    expect(f.openings.find((o) => o.id === 'gd')!.service).toBe(true);
  });

  it('外側がポーチの戸は玄関らしさが上がる', () => {
    const f = house();
    f.rooms.push(room('p', 'ポーチ', 'porch', 0, -1500, 2000, 0));
    const w = f.walls[0];
    const withPorch = exteriorDoorRole(f, w, f.openings.find((o) => o.id === 'ed')!);
    f.rooms.pop();
    const without = exteriorDoorRole(f, w, f.openings.find((o) => o.id === 'ed')!);
    expect(withPorch.role).toBe('entrance');
    expect(withPorch.score).toBeGreaterThan(without.score);
  });
});
