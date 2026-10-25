import { describe, it, expect } from 'vitest';
import { repairEnvelope } from '../src/parser/envelope';
import { autoOverhangPosts } from '../src/core/posts';
import type { Floor, Room, Vec2, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (id: string, name: string, type: Room['type'], polygon: Vec2[]): Room => ({ id, name, type, polygon, area: 10, labelPos: polygon[0] });
const wall = (id: string, a: Vec2, b: Vec2, exterior = true): Wall => ({ id, a, b, thickness: exterior ? 160 : 130, exterior, joinedA: true, joinedB: true });
const floor = (walls: Wall[], rooms: Room[], outline: Vec2[]): Floor => ({ level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, walls, openings: [], rooms, stairs: [], outline: [outline] });

describe('外皮の後処理', () => {
  it('外形の辺に壁が無い LDK の面は外壁と掃き出し窓で補う', () => {
    const o = rect(0, 0, 9100, 7280);
    // 南面（y=7280）だけ壁が無い
    const f = floor([wall('W1', o[0], o[1]), wall('W2', o[1], o[2]), wall('W4', o[3], o[0])], [room('R1', 'ＬＤＫ', 'ldk', o)], o);
    const r = repairEnvelope(f);
    expect(r.added).toBe(1);
    expect(r.glazed).toBe(1);
    const add = f.walls.find((w) => !['W1', 'W2', 'W4'].includes(w.id))!;
    expect(add.exterior).toBe(true);
    expect(Math.abs(add.a.y - 7280) + Math.abs(add.b.y - 7280)).toBeLessThan(2);
    expect(Math.hypot(add.b.x - add.a.x, add.b.y - add.a.y)).toBeGreaterThan(8500);
    const win = f.openings.find((x) => x.wallId === add.id)!;
    expect(win.kind).toBe('window');
    expect(win.sill).toBe(0);
    // 外側の法線: 南（+y）が外
    const L = Math.hypot(add.b.x - add.a.x, add.b.y - add.a.y);
    const n = { x: (-(add.b.y - add.a.y) / L) * add.outsideSign!, y: ((add.b.x - add.a.x) / L) * add.outsideSign! };
    expect(n.y).toBeGreaterThan(0.9);
  });

  it('車庫の開いた面には壁を足さない', () => {
    const o = rect(0, 0, 5460, 5460);
    const f = floor([wall('W1', o[0], o[1]), wall('W2', o[1], o[2]), wall('W4', o[3], o[0])], [room('R1', '車庫', 'garage', o)], o);
    expect(repairEnvelope(f).added).toBe(0);
  });

  it('長い内壁の一部が外周に面するときは、その区間を外壁として切り出す', () => {
    // L 字の家: 右上が欠けた形。x=4550 の内壁が y=0..7280 に通り、y=0..2730 の区間は外に面する
    const o: Vec2[] = [
      { x: 0, y: 0 },
      { x: 4550, y: 0 },
      { x: 4550, y: 2730 },
      { x: 9100, y: 2730 },
      { x: 9100, y: 7280 },
      { x: 0, y: 7280 },
    ];
    const walls = [
      wall('W1', o[0], o[1]),
      wall('W3', o[2], o[3]),
      wall('W4', o[3], o[4]),
      wall('W5', o[4], o[5]),
      wall('W6', o[5], o[0]),
      wall('W7', { x: 4550, y: 0 }, { x: 4550, y: 7280 }, false),
    ];
    const f = floor(walls, [room('R1', '洋室', 'bedroom', rect(0, 0, 4550, 7280)), room('R2', 'ＬＤＫ', 'ldk', rect(4550, 2730, 9100, 7280))], o);
    f.openings.push({ id: 'O1', wallId: 'W7', kind: 'door', t0: 4000, t1: 4800, sill: 0, height: 2000 });
    const r = repairEnvelope(f);
    expect(r.split).toBe(1);
    const parts = f.walls.filter((w) => Math.abs(w.a.x - 4550) < 1 && Math.abs(w.b.x - 4550) < 1);
    expect(parts.length).toBe(2);
    const ext = parts.find((w) => w.exterior)!;
    expect(Math.max(ext.a.y, ext.b.y)).toBeGreaterThan(2500);
    expect(Math.max(ext.a.y, ext.b.y)).toBeLessThan(2900);
    // 戸は内側の区間に付け替わり、位置（a からの距離）も合わせる
    const door = f.openings[0];
    const host = f.walls.find((w) => w.id === door.wallId)!;
    expect(host.exterior).toBe(false);
    expect(host.a.y + door.t0).toBeCloseTo(4000, -1);
  });
});

describe('読み込み時の張り出しの柱', () => {
  const mk = (level: number, loop: Vec2[]): Floor => ({ level, elevation: level === 1 ? 500 : 3400, height: 2900, ceilingHeight: 2400, walls: loop.map((a, i) => wall(`F${level}-W${i}`, a, loop[(i + 1) % loop.length])), openings: [], rooms: [], stairs: [], outline: [loop] });
  it('1 間を超える張り出しの角と長い辺の途中には柱を立て、半間〜1 間は立てない', () => {
    const lo = mk(1, rect(0, 0, 7280, 5460));
    // 角 2 本＋7,280 の辺の途中（1.5 間ごと）に 2 本
    expect(autoOverhangPosts(lo, mk(2, rect(0, 0, 7280, 7280))).length).toBe(4);
    expect(autoOverhangPosts(lo, mk(2, rect(0, 0, 7280, 6370)))).toEqual([]);
  });
});
