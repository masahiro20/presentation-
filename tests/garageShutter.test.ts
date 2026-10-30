import { describe, it, expect } from 'vitest';
import { ensureGarageShutters } from '../src/parser/garageShutter';
import type { Opening, Room, Wall } from '../src/core/types';

const wall = (id: string, ax: number, ay: number, bx: number, by: number): Wall => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 120, exterior: true });
const room = (id: string, type: Room['type'], poly: [number, number][], garageKind?: Room['garageKind']): Room => ({ id, name: type, type, polygon: poly.map(([x, y]) => ({ x, y })), area: 20, labelPos: { x: poly[0][0] + 500, y: poly[0][1] + 500 }, garageKind });

describe('ビルトインガレージのシャッター', () => {
  it('壁の無い辺に外壁とシャッターの開口を足す（他の部屋に接する辺・短い辺は足さない）', () => {
    // ガレージ 5,000 × 6,000。北・東・西に壁、南（道路側）に壁が無い
    const g = room('G', 'garage', [[0, 0], [5000, 0], [5000, 6000], [0, 6000]], 'builtin');
    const walls = [wall('W1', 0, 0, 5000, 0), wall('W2', 5000, 0, 5000, 6000), wall('W3', 0, 0, 0, 6000)];
    const openings: Opening[] = [];
    const n = ensureGarageShutters(walls, openings, [g], 1);
    expect(n).toBe(1);
    expect(walls).toHaveLength(4);
    const w = walls[3];
    expect(w.exterior).toBe(true);
    expect(Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)).toBe(5000);
    expect(openings).toHaveLength(1);
    expect(openings[0].kind).toBe('shutter');
    expect(openings[0].wallId).toBe(w.id);
    expect(openings[0].t1 - openings[0].t0).toBe(5000 - 160);
    // もう一度呼んでも増えない
    expect(ensureGarageShutters(walls, openings, [g], 1)).toBe(0);
  });

  it('壁の無い辺の向こうに部屋があれば（つながった空間）足さない。離れのガレージは対象外', () => {
    const g = room('G', 'garage', [[0, 0], [5000, 0], [5000, 6000], [0, 6000]], 'builtin');
    const hall = room('H', 'hall', [[0, 6000], [5000, 6000], [5000, 8000], [0, 8000]]);
    const walls = [wall('W1', 0, 0, 5000, 0), wall('W2', 5000, 0, 5000, 6000), wall('W3', 0, 0, 0, 6000)];
    const openings: Opening[] = [];
    expect(ensureGarageShutters(walls, openings, [g, hall], 1)).toBe(0);
    const det = room('D', 'garage', [[0, 0], [5000, 0], [5000, 6000], [0, 6000]], 'detached');
    expect(ensureGarageShutters([...walls], [], [det], 1)).toBe(0);
  });
});
