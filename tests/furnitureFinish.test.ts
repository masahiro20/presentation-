import { describe, it, expect } from 'vitest';
import { finishKeyMap, furnitureItems } from '../src/scene/furniture';
import type { BuildingModel, Floor, Room } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (id: string, name: string, type: Room['type'], poly: { x: number; y: number }[]): Room =>
  ({ id, name, type, polygon: poly, area: Math.abs(poly.reduce((s, p, i) => s + p.x * poly[(i + 1) % poly.length].y - poly[(i + 1) % poly.length].x * p.y, 0)) / 2e6 }) as Room;
const wall = (id: string, a: { x: number; y: number }, b: { x: number; y: number }) => ({ id, a, b, thickness: 120, exterior: true, outsideSign: 1 });
const floor = (level: number, outline: { x: number; y: number }[][], rooms: Room[]): Floor =>
  ({ level, height: 2900, ceilingHeight: 2400, elevation: 600, outline, rooms, walls: [wall('w1', { x: 0, y: 0 }, { x: 7280, y: 0 }), wall('w2', { x: 7280, y: 0 }, { x: 7280, y: 5460 }), wall('w3', { x: 7280, y: 5460 }, { x: 0, y: 5460 }), wall('w4', { x: 0, y: 5460 }, { x: 0, y: 0 })], openings: [], stairs: [] }) as unknown as Floor;

describe('3D の直感操作: 家具の素材と id', () => {
  it('木の色味・張地の色は材料キーの差し替え表になる（標準なら無し）', () => {
    expect(finishKeyMap({})).toBeNull();
    expect(finishKeyMap({ woodTone: 'natural', fabricColor: 'preset' })).toBeNull();
    expect(finishKeyMap({ woodTone: 'dark' })).toEqual({ 'f.wood': 'f.wood@dark' });
    expect(finishKeyMap({ fabricColor: 'navy' })).toEqual({ 'f.fabric': 'f.fabric@navy', 'f.fabric2': 'f.fabric2@navy' });
  });

  it('自動配置の家具の id は作るたびに同じ（選んだ家具を次の描画でも見つけられる）', () => {
    const f1 = floor(1, [rect(0, 0, 7280, 5460)], [room('l', 'ＬＤＫ', 'ldk', rect(0, 0, 7280, 5460))]);
    const model = { floors: [f1], northAngleDeg: 0 } as unknown as BuildingModel;
    const a = [...(furnitureItems(model).get(1) ?? [])].map((x) => `${x.kind}:${x.id}`);
    const b = [...(furnitureItems(model).get(1) ?? [])].map((x) => `${x.kind}:${x.id}`);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
    expect(new Set(a).size).toBe(a.length);
  });
});
