import { describe, expect, it } from 'vitest';
import { dedupeStairs } from '../src/parser/assemble';
import type { Stair } from '../src/core/types';

const st = (id: string, minX: number, minY: number, maxX: number, maxY: number, kind: Stair['kind'] = 'u'): Stair => ({ id, minX, minY, maxX, maxY, kind, entry: 's', goesUp: true });

describe('重なった階段の整理', () => {
  it('コの字階段の中にできた小さな「階段」は消え、番号が振り直される（吉田大仁様邸 1st-2）', () => {
    const stairs = [st('F1-S1', 5199, 1820, 7474, 3640), st('F1-S2', 6564, 2275, 7929, 3640)];
    dedupeStairs(stairs, 1);
    expect(stairs.map((s) => s.id)).toEqual(['F1-S1']);
    expect(stairs[0].maxX).toBe(7474);
  });

  it('隣り合うだけで重ならない 2 つの階段はそのまま', () => {
    const stairs = [st('F1-S1', 6370, 3398, 8190, 4999), st('F1-S2', 8190, 5460, 11830, 6370)];
    dedupeStairs(stairs, 1);
    expect(stairs).toHaveLength(2);
  });

  it('小さいほうの半分未満しか重ならなければ両方残す', () => {
    const stairs = [st('F2-S1', 0, 0, 2275, 1820), st('F2-S2', 1820, 1365, 3185, 2730)];
    dedupeStairs(stairs, 2);
    expect(stairs.map((s) => s.id)).toEqual(['F2-S1', 'F2-S2']);
  });
});
