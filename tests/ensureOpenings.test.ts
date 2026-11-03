// 戸が読めなかった図面を常識で補う（吉田様邸 1101 時点プランの正解データから）
import { describe, it, expect } from 'vitest';
import type { Opening, Room, Wall } from '../src/core/types';
import { ensureOpenings } from '../src/parser/ensureOpenings';

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
let n = 0;
const wall = (x0: number, y0: number, x1: number, y1: number, exterior = false): Wall => ({ id: `W${++n}`, a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, thickness: exterior ? 160 : 120, exterior });
const room = (name: string, type: Room['type'], poly: { x: number; y: number }[], extra: Partial<Room> = {}): Room => ({ id: name, name, type, polygon: poly, area: 10, labelPos: { x: (poly[0].x + poly[2].x) / 2, y: (poly[0].y + poly[2].y) / 2 }, ...extra });

describe('ensureOpenings', () => {
  it('戸の無い洋室・トイレには廊下との壁に戸を置き、トイレの戸は廊下側へ開く', () => {
    // 廊下 (0..910, 0..3640) | 洋室 (910..3640, 0..1820) / トイレ (910..1820, 1820..3640)
    const walls = [wall(0, 0, 3640, 0, true), wall(0, 3640, 3640, 3640, true), wall(0, 0, 0, 3640, true), wall(3640, 0, 3640, 3640, true), wall(910, 0, 910, 3640), wall(910, 1820, 3640, 1820)];
    const rooms = [room('廊下', 'hall', rect(0, 0, 910, 3640)), room('洋室', 'bedroom', rect(910, 0, 3640, 1820)), room('トイレ', 'toilet', rect(910, 1820, 1820, 3640))];
    const openings: Opening[] = [];
    const notes = ensureOpenings(walls, openings, rooms, 2);
    expect(openings.filter((o) => o.kind === 'door')).toHaveLength(2);
    const bed = openings.find((o) => o.t0 < 1820 && o.wallId === walls[4].id)!;
    const wc = openings.find((o) => o.t0 >= 1820 && o.wallId === walls[4].id)!;
    expect(bed).toBeTruthy();
    expect(wc).toBeTruthy();
    expect(wc.t1 - wc.t0).toBe(650);
    // 壁 x=910 の +n 側（n = (-uy, ux) = (-1, 0)）は廊下。トイレの戸は廊下へ、洋室の戸は洋室へ
    expect(wc.swingSide).toBe(1);
    expect(bed.swingSide).toBe(-1);
    expect(notes.join(' ')).toMatch(/洋室.*廊下との壁に戸/);
    expect(notes.join(' ')).toMatch(/トイレ/);
  });

  it('戸がある部屋・壁なしでつながる部屋には足さない', () => {
    const walls = [wall(0, 0, 1820, 0, true), wall(0, 1820, 1820, 1820, true), wall(0, 0, 0, 1820, true), wall(1820, 0, 1820, 1820, true), wall(910, 0, 910, 1820)];
    const rooms = [room('ホール', 'hall', rect(0, 0, 910, 1820)), room('洋室', 'bedroom', rect(910, 0, 1820, 1820))];
    const openings: Opening[] = [{ id: 'd', wallId: walls[4].id, kind: 'door', t0: 500, t1: 1280, sill: 0, height: 2000 }];
    expect(ensureOpenings(walls, openings, rooms, 2)).toHaveLength(0);
    expect(openings).toHaveLength(1);
  });

  it('ビルトインガレージの外に面した長い辺にシャッター、玄関との間に戸、玄関に外戸', () => {
    // 玄関 (0..2730, 0..1820) の東に ガレージ (2730..9100, 0..6370)。玄関の北辺が外（道路側）
    const walls = [wall(0, 0, 9100, 0, true), wall(0, 0, 0, 1820, true), wall(0, 1820, 2730, 1820, true), wall(2730, 0, 2730, 6370), wall(2730, 6370, 9100, 6370, true), wall(9100, 0, 9100, 6370, true)];
    const rooms = [room('玄関', 'entrance', rect(0, 0, 2730, 1820)), room('車庫', 'garage', rect(2730, 0, 9100, 6370), { garageKind: 'builtin' })];
    const openings: Opening[] = [];
    const notes = ensureOpenings(walls, openings, rooms, 1);
    const sh = openings.filter((o) => o.kind === 'shutter');
    expect(sh.length).toBeGreaterThan(0);
    // 最も長い外周の辺（北 6,370 か南 6,370 か東 6,370）に置かれる
    expect(['W1', 'W5', 'W6'].some((id) => sh[0].wallId.startsWith(id))).toBe(true);
    const ent = openings.find((o) => o.kind === 'entrance')!;
    expect(ent).toBeTruthy();
    const door = openings.find((o) => o.kind === 'door' && o.wallId === walls[3].id);
    expect(door).toBeTruthy();
    expect(notes.some((t) => /シャッター/.test(t))).toBe(true);
    expect(notes.some((t) => /玄関ドア/.test(t))).toBe(true);
  });
});
