// 最上階の階段は「降りる階段」: 上の階が無いのに UP と読んだ階段を直す。注記の文は室名にしない
import { describe, expect, it } from 'vitest';
import { cleanRoomName, finishTopFloorStairs } from '../src/parser/assemble';
import type { Floor, Stair } from '../src/core/types';

const st = (goesUp: boolean, entry: Stair['entry'] = 's'): Stair => ({ id: 'S', minX: 0, minY: 0, maxX: 1820, maxY: 2730, kind: 'u', entry, goesUp });
const floor = (level: number, stairs: Stair[]): Floor => ({ level, elevation: 500 + (level - 1) * 2900, height: 2900, ceilingHeight: 2400, walls: [], openings: [], rooms: [], stairs, outline: [] }) as unknown as Floor;

describe('最上階の階段', () => {
  it('2 階建ての 2 階の階段は DN になる（1 階はそのまま）', () => {
    const floors = [floor(1, [st(true)]), floor(2, [st(true)])];
    finishTopFloorStairs(floors);
    expect(floors[0].stairs[0].goesUp).toBe(true);
    expect(floors[1].stairs[0].goesUp).toBe(false);
  });

  it('3 階建ての 2 階（上の階がある）は UP のまま', () => {
    const floors = [floor(1, [st(true)]), floor(2, [st(true)]), floor(3, [st(true)])];
    finishTopFloorStairs(floors);
    expect(floors.map((f) => f.stairs[0].goesUp)).toEqual([true, true, false]);
  });

  it('下の階の階段と重ならない「昇る階段」（ロフトへの固定階段）は最上階でもそのまま', () => {
    const loft: Stair = { ...st(true), minX: 5000, maxX: 5900, minY: 0, maxY: 2730, kind: 'straight' };
    const floors = [floor(1, [st(true)]), floor(2, [st(true), loft])];
    finishTopFloorStairs(floors);
    expect(floors[1].stairs[0].goesUp).toBe(false);
    expect(floors[1].stairs[1].goesUp).toBe(true);
  });

  it('平屋（1 階だけ）は触らない', () => {
    const floors = [floor(1, [st(true)])];
    finishTopFloorStairs(floors);
    expect(floors[0].stairs[0].goesUp).toBe(true);
  });
});

describe('注記の文は室名にしない', () => {
  it('引き出し線の注記（「階段下１ｍくらいの収納」）は室名ではない（洋室が 2 つに割れていた: 田中様）', () => {
    expect(cleanRoomName('階段下１ｍくらいの収納')).toBeNull();
    expect(cleanRoomName('階段の近くにロッカーを')).toBeNull();
  });
  it('ふつうの室名はそのまま', () => {
    expect(cleanRoomName('階段下収納')).toBe('階段下収納');
    expect(cleanRoomName('洋室')).toBe('洋室');
    expect(cleanRoomName('ＬＤＫ（土間）')).toBe('ＬＤＫ');
    expect(cleanRoomName('pantry兼物入')).toBe('pantry兼物入');
  });
});
