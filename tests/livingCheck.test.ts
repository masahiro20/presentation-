import { describe, expect, it } from 'vitest';
import { livingCheck } from '../src/parser/livingCheck';
import type { BuildingModel, Floor, Opening, Room, RoomType, Stair, Vec2, Wall } from '../src/core/types';

// 小さな 1 階: 玄関（左下）・ホール（右下）・洋室（上）。壁芯の多角形で部屋を作り、壁は辺に置く
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (id: string, name: string, type: RoomType, poly: Vec2[]): Room => {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const area = ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / 1e6;
  return { id, name, type, polygon: poly, area, labelPos: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 } };
};
const wall = (id: string, a: Vec2, b: Vec2, exterior = false): Wall => ({ id, a, b, thickness: 120, exterior });
const op = (id: string, wallId: string, kind: Opening['kind'], t0: number, t1: number, height = 2000): Opening => ({ id, wallId, kind, t0, t1, sill: kind === 'window' ? 900 : 0, height });

function floor(rooms: Room[], walls: Wall[], openings: Opening[], stairs: Stair[] = []): Floor {
  return { level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, walls, openings, rooms, stairs, outline: [rect(0, 0, 3640, 5460)] };
}
const model = (f: Floor): BuildingModel => ({ name: 't', floors: [f], northAngleDeg: 0 }) as unknown as BuildingModel;

// 共通の壁: 外周と、玄関｜ホールの間・下 2 室と洋室の間
const walls = [
  wall('S', { x: 0, y: 5460 }, { x: 3640, y: 5460 }, true),
  wall('N', { x: 0, y: 0 }, { x: 3640, y: 0 }, true),
  wall('W', { x: 0, y: 0 }, { x: 0, y: 5460 }, true),
  wall('E', { x: 3640, y: 0 }, { x: 3640, y: 5460 }, true),
  wall('M', { x: 0, y: 3640 }, { x: 3640, y: 3640 }), // 洋室｜玄関・ホール
  wall('V', { x: 1820, y: 3640 }, { x: 1820, y: 5460 }), // 玄関｜ホール
];
const entrance = room('e', '玄関', 'entrance', rect(0, 3640, 1820, 5460));
const hall = room('h', 'ホール', 'hall', rect(1820, 3640, 3640, 5460));
const bed = room('b', '洋室', 'bedroom', rect(0, 0, 3640, 3640));
const entDoor = op('ent', 'S', 'entrance', 400, 1300);
const hallDoor = op('eh', 'V', 'door', 500, 1300); // 玄関→ホール
const bedDoor = op('hb', 'M', 'door', 2300, 3100); // ホール→洋室（上下の壁 M の右寄り）
const bedWin = op('bw', 'N', 'window', 600, 2290, 1100); // 洋室の北の腰窓 1,690×1,100

describe('住まいの成立チェック', () => {
  it('玄関 → ホール → 洋室 と戸でつながる間取りは、動線の指摘が無い', () => {
    const issues = livingCheck(model(floor([entrance, hall, bed], walls, [entDoor, hallDoor, bedDoor, bedWin])));
    expect(issues.filter((i) => i.id.startsWith('live-reach'))).toHaveLength(0);
    expect(issues.filter((i) => i.id.startsWith('live-stair'))).toHaveLength(0);
  });

  it('洋室の戸が WIC にしか開いていなければ「玄関から行けない」（WIC も一緒に）', () => {
    const wic = room('w', 'WIC', 'closet', rect(0, 0, 1820, 1820));
    const bed2 = room('b', '洋室', 'bedroom', [{ x: 1820, y: 0 }, { x: 3640, y: 0 }, { x: 3640, y: 3640 }, { x: 0, y: 3640 }, { x: 0, y: 1820 }, { x: 1820, y: 1820 }]);
    const ws = [...walls, wall('W1', { x: 1820, y: 0 }, { x: 1820, y: 1820 }), wall('W2', { x: 0, y: 1820 }, { x: 1820, y: 1820 })];
    const issues = livingCheck(model(floor([entrance, hall, bed2, wic], ws, [entDoor, hallDoor, op('bw2', 'W1', 'door', 500, 1300), bedWin])));
    const reach = issues.filter((i) => i.id.startsWith('live-reach'));
    expect(reach).toHaveLength(1);
    expect(reach[0].title).toContain('洋室');
    expect(reach[0].title).toContain('WIC');
    expect(reach[0].severity).toBe('warn');
  });

  it('階段の昇り口が収納に向いていれば指摘し、ホールに向いていれば何も言わない', () => {
    const st = room('s', '階段', 'stairs', rect(1820, 1820, 2730, 3640));
    const clo = room('c', '物入', 'closet', rect(2730, 1820, 3640, 3640));
    const bed3 = room('b', '洋室', 'bedroom', [{ x: 0, y: 0 }, { x: 3640, y: 0 }, { x: 3640, y: 1820 }, { x: 1820, y: 1820 }, { x: 1820, y: 3640 }, { x: 0, y: 3640 }]);
    const ws = [...walls, wall('X', { x: 2730, y: 1820 }, { x: 2730, y: 3640 }), wall('Y', { x: 1820, y: 1820 }, { x: 3640, y: 1820 }), wall('Z', { x: 1820, y: 1820 }, { x: 1820, y: 3640 })];
    const stairOf = (entry: Stair['entry']): Stair => ({ id: 'F1-S1', minX: 1820, minY: 1820, maxX: 2730, maxY: 3640, kind: 'straight', entry, goesUp: true });
    const ops = [entDoor, hallDoor, op('hb2', 'M', 'door', 300, 1100), op('hs', 'M', 'open', 1900, 2650), bedWin];
    const bad = livingCheck(model(floor([entrance, hall, bed3, st, clo], ws, ops, [stairOf('e')])));
    // 収納との間に壁があれば「壁」、無ければ「物入」と言う。どちらも向きの読み違いの指摘
    expect(bad.some((i) => i.id.startsWith('live-stair') && /壁|物入/.test(i.title))).toBe(true);
    const good = livingCheck(model(floor([entrance, hall, bed3, st, clo], ws, ops, [stairOf('s')])));
    expect(good.filter((i) => i.id.startsWith('live-stair'))).toHaveLength(0);
  });

  it('折り返し階段の口は辺の半分だけ: 残りの半分が手すり壁でふさがっていても「壁に向いている」と言わない', () => {
    // 階段（左上 1,820 角・昇り口は下の辺）。下の辺の左 1,000 は手すり壁、右 820 がホールに開いている
    const st = room('s', '階段', 'stairs', rect(0, 0, 1820, 1820));
    const hall2 = room('h2', 'ホール', 'hall', [{ x: 1820, y: 0 }, { x: 3640, y: 0 }, { x: 3640, y: 3640 }, { x: 0, y: 3640 }, { x: 0, y: 1820 }, { x: 1820, y: 1820 }]);
    const stair: Stair = { id: 'F1-S1', minX: 0, minY: 0, maxX: 1820, maxY: 1820, kind: 'u', entry: 's', goesUp: true };
    const ops = [entDoor, hallDoor, bedDoor];
    const run = (extra: Wall[], more: Opening[] = []) => livingCheck(model(floor([entrance, hall, hall2, st], [...walls, wall('Z', { x: 1820, y: 0 }, { x: 1820, y: 1820 }), ...extra], [...ops, ...more], [stair]))).filter((i) => i.id.startsWith('live-stair'));
    // 手すり壁が辺の真ん中を越えていても、右に 50cm 以上の口がある
    expect(run([wall('Y', { x: 0, y: 1820 }, { x: 1000, y: 1820 })])).toHaveLength(0);
    // 辺が全部壁なら指摘する
    const closed = run([wall('Y', { x: 0, y: 1820 }, { x: 1820, y: 1820 })]);
    expect(closed).toHaveLength(1);
    expect(closed[0].title).toContain('壁');
    // 全部壁でも、右寄りに開口があれば通れる（真ん中から 30cm より離れた開口）
    expect(run([wall('Y', { x: 0, y: 1820 }, { x: 1820, y: 1820 })], [op('so', 'Y', 'open', 1250, 1800)])).toHaveLength(0);
    // 開口が 40cm しか無ければ、人は通れない
    expect(run([wall('Y', { x: 0, y: 1820 }, { x: 1820, y: 1820 })], [op('so', 'Y', 'open', 1350, 1750)])).toHaveLength(1);
  });

  it('階段の区画が 1 階で「物入」（階段下の物入）、2 階で「吹抜」と読めていても、2 階へ階段でつながる', () => {
    const o = rect(0, 0, 3640, 5460);
    const stair = (goesUp: boolean): Stair => ({ id: goesUp ? 'F1-S1' : 'F2-S1', minX: 0, minY: 0, maxX: 1820, maxY: 1820, kind: 'u', entry: 's', goesUp });
    const top = [{ x: 1820, y: 0 }, { x: 3640, y: 0 }, { x: 3640, y: 3640 }, { x: 0, y: 3640 }, { x: 0, y: 1820 }, { x: 1820, y: 1820 }];
    const f1: Floor = {
      level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, outline: [o],
      rooms: [entrance, hall, room('h2', 'ホール', 'hall', top), room('s', '物入', 'storage', rect(0, 0, 1820, 1820))],
      walls: [...walls, wall('Z', { x: 1820, y: 0 }, { x: 1820, y: 1820 }), wall('Y', { x: 0, y: 1820 }, { x: 1000, y: 1820 })],
      openings: [entDoor, hallDoor, bedDoor],
      stairs: [stair(true)],
    };
    const f2: Floor = {
      level: 2, elevation: 3400, height: 2900, ceilingHeight: 2400, outline: [o],
      rooms: [room('v', '吹抜', 'void', rect(0, 0, 1820, 1820)), room('h3', 'ホール', 'hall', top), room('b2', '洋室', 'bedroom', rect(0, 3640, 3640, 5460))],
      walls: [...walls.filter((w) => w.id !== 'V'), wall('Z', { x: 1820, y: 0 }, { x: 1820, y: 1820 }), wall('Y', { x: 0, y: 1820 }, { x: 1000, y: 1820 })],
      openings: [op('d2', 'M', 'door', 2300, 3100)],
      stairs: [stair(false)],
    };
    const issues = livingCheck({ name: 't', floors: [f1, f2], northAngleDeg: 0 } as unknown as BuildingModel);
    expect(issues.filter((i) => i.id.startsWith('live-reach'))).toHaveLength(0);
    // 2 階にホールも階段も無く、吹抜しか無ければつながらない
    const f2b: Floor = { ...f2, rooms: [room('v', '吹抜', 'void', rect(0, 0, 1820, 1820)), room('b3', '洋室', 'bedroom', top), room('b2', '洋室', 'bedroom', rect(0, 3640, 3640, 5460))] };
    expect(livingCheck({ name: 't', floors: [f1, f2b], northAngleDeg: 0 } as unknown as BuildingModel).some((i) => i.id === 'live-reach-2')).toBe(true);
  });

  it('部屋と部屋の間の壁の窓は「室内窓か読み違い」、小さな窓だけの居室は採光不足', () => {
    const issues = livingCheck(model(floor([entrance, hall, bed], walls, [entDoor, hallDoor, bedDoor, op('iw', 'M', 'window', 300, 1200, 700), op('sw', 'N', 'window', 600, 1200, 700)])));
    expect(issues.some((i) => i.id === 'live-winin-1' && i.title.includes('1 か所'))).toBe(true);
    const light = issues.find((i) => i.id === 'live-light-1-b');
    expect(light?.title).toContain('1/7');
  });

  it('トイレの戸が LDK に直接開く・個室の戸が外に開くのは「情報」として出す', () => {
    const ldk = room('l', 'ＬＤＫ', 'ldk', rect(0, 0, 3640, 3640));
    const wc = room('t', 'トイレ', 'toilet', rect(1820, 3640, 3640, 5460));
    const issues = livingCheck(model(floor([entrance, wc, ldk], walls, [entDoor, op('lt', 'M', 'door', 2300, 3100), op('el', 'M', 'door', 300, 1100), op('out', 'N', 'door', 500, 1300)])));
    expect(issues.some((i) => i.id.startsWith('live-wc') && i.title.includes('ＬＤＫ'))).toBe(true);
    expect(issues.every((i) => !i.id.startsWith('live-wc') || i.severity === 'info')).toBe(true);
  });
});
