import { describe, expect, it } from 'vitest';
import { senseFurniture } from '../src/parser/furnitureSense';
import type { FurnitureItem, Room } from '../src/core/types';

const room = (id: string, name: string, type: Room['type']): Room => ({ id, name, type, polygon: [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 5000 }, { x: 0, y: 5000 }], area: 25e6 } as Room);
const item = (id: string, kind: FurnitureItem['kind'], roomId: string, x = 0, y = 0, extra: Partial<FurnitureItem> = {}): FurnitureItem => ({ id, kind, x, y, rot: 0, roomId, ...extra });

describe('家具の常識', () => {
  it('LDK の食卓は 1 つ（キッチンに近い方を残す）', () => {
    const rooms = [room('r1', 'LDK', 'ldk')];
    const items = [item('k', 'kitchen', 'r1', 4000, 500), item('d1', 'dining', 'r1', 500, 4500, { w: 1.8 }), item('d2', 'dining', 'r1', 3500, 1500, { w: 1.5 })];
    const r = senseFurniture(items, rooms);
    expect(r.items.filter((i) => i.kind === 'dining').map((i) => i.id)).toEqual(['d2']);
    expect(r.removed.length).toBe(1);
  });
  it('ソファ・テレビ・キッチンも 1 つ、ベッドは平行で隣り合う 2 台まで', () => {
    const rooms = [room('r1', 'LDK', 'ldk'), room('r2', '寝室', 'bedroom')];
    const items = [
      item('s1', 'sofa', 'r1', 0, 0, { w: 2.4 }),
      item('s2', 'sofa', 'r1', 3000, 0, { w: 1.6 }),
      item('b1', 'bed', 'r2', 1000, 1000, { w: 1.0, rot: 90 }),
      item('b2', 'bed', 'r2', 2300, 1000, { w: 1.0, rot: 90 }),
      item('b3', 'bed', 'r2', 4500, 4500, { w: 1.4, rot: 0 }),
    ];
    const r = senseFurniture(items, rooms);
    // 広い LDK の近くに置いた 2 台（3 人掛け＋2 人掛け）はセットとして残す。離れていれば大きい 1 台
    expect(r.items.filter((i) => i.kind === 'sofa').map((i) => i.id)).toEqual(['s1', 's2']);
    const far = senseFurniture(items.map((i) => (i.id === 's2' ? { ...i, x: 9000 } : i)), rooms);
    expect(far.items.filter((i) => i.kind === 'sofa').map((i) => i.id)).toEqual(['s1']);
    // 一番大きい b3 を残し、平行で近いものが無いので 1 台
    expect(r.items.filter((i) => i.kind === 'bed').map((i) => i.id)).toEqual(['b3']);
    const twin = senseFurniture(items.filter((i) => i.id !== 'b3'), rooms);
    expect(twin.items.filter((i) => i.kind === 'bed').length).toBe(2);
  });
  it('その部屋には無いもの（玄関の便器・トイレのソファ）は落とす', () => {
    const rooms = [room('e', '玄関', 'entrance'), room('t', 'トイレ', 'toilet')];
    const items = [item('x1', 'toilet', 'e'), item('x2', 'shoeCabinet', 'e'), item('x3', 'sofa', 't'), item('x4', 'toilet', 't')];
    const r = senseFurniture(items, rooms);
    expect(r.items.map((i) => i.id)).toEqual(['x2', 'x4']);
    expect(r.removed.join(' ')).toContain('玄関の便器');
  });
  it('部屋の無い家具はそのまま', () => {
    const items = [item('a', 'dining', ''), item('b', 'dining', '')];
    expect(senseFurniture(items, []).items.length).toBe(1);
  });
});
