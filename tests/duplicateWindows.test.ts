// 同じ壁の同じ所に二重に読めた窓の候補を 1 つにする（第 42 巡 ⑪。田中様邸 3 階: 東の窓、大崎様邸 1 階: トイレの引戸）
import { describe, expect, it } from 'vitest';
import { duplicateWindowCandidates, type DetectedOpening } from '../src/parser/walls';

const op = (kind: DetectedOpening['kind'], o: number, t0: number, t1: number, confidence: number, g = 0): DetectedOpening => ({ g, o, d: 130, t0, t1, kind, confidence });

describe('重なった窓の候補', () => {
  it('同じ位置の窓 2 つは、確信度の低い方を落とす（順番によらない）', () => {
    const a = op('window', 8645, 2426, 4077, 0.85);
    const b = op('window', 8645, 2426, 4077, 0.6);
    expect([...duplicateWindowCandidates([a, b])]).toEqual([b]);
    expect([...duplicateWindowCandidates([b, a])]).toEqual([b]);
  });

  it('確信度が同じなら、後に読めた方を落とす。芯が少しずれた軸（60mm まで）も同じ壁', () => {
    const a = op('window', 8645, 1000, 2690, 0.75);
    const b = op('window', 8690, 1100, 2690, 0.75);
    expect([...duplicateWindowCandidates([a, b])]).toEqual([b]);
  });

  it('片引戸の戸袋: 確かな開口と端がそろい、戸 1 枚分だけ長い候補（開口＋戸袋を半分ずれた軸で読んだもの）は長い方を落とす', () => {
    // 大崎様邸 1 階のトイレ: 825 の引戸と、戸袋まで含めた 1,770 の「引戸」が二重になっていた
    const door = op('window', -9035, 16552, 17378, 0.85, 1);
    const withPocket = op('window', -8982, 16527, 18295, 0.7, 1);
    expect([...duplicateWindowCandidates([door, withPocket])]).toEqual([withPocket]);
    expect([...duplicateWindowCandidates([withPocket, door])]).toEqual([withPocket]);
  });

  it('広い開口の中の小さい候補は、どちらが本物か決められないので落とさない', () => {
    // 長いサッシの線（端部の infill）の途中にある短い切れ目
    const gap = op('window', -27136, 18407, 18719, 0.85, 1);
    const sash = op('window', -27134, 18421, 21911, 0.6, 1);
    expect(duplicateWindowCandidates([gap, sash]).size).toBe(0);
    // 壁の切れ目の中に並ぶ 2 つの窓
    const wide = op('window', 12328, 17464, 20177, 0.7);
    expect(duplicateWindowCandidates([wide, op('window', 12338, 17729, 18261, 0.6), op('window', 12338, 19186, 19849, 0.6)]).size).toBe(0);
    // 端がそろっていても、長さが戸 1 枚分でなければ戸袋とは見ない
    expect(duplicateWindowCandidates([op('window', 0, 0, 826, 0.85), op('window', 50, 0, 3200, 0.7)]).size).toBe(0);
  });

  it('少ししか重ならない窓・向きや壁が違う窓・戸と窓の組は落とさない', () => {
    const a = op('window', 0, 0, 1690, 0.85);
    expect(duplicateWindowCandidates([a, op('window', 0, 1500, 3190, 0.6)]).size).toBe(0);
    expect(duplicateWindowCandidates([a, op('window', 910, 0, 1690, 0.6)]).size).toBe(0);
    expect(duplicateWindowCandidates([a, op('window', 0, 0, 1690, 0.6, 1)]).size).toBe(0);
    expect(duplicateWindowCandidates([a, op('door', 0, 0, 1690, 0.95)]).size).toBe(0);
  });
});
