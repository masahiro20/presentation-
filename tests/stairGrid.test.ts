// 階段の候補: 玄関のタイル目地（格子）は階段にしない。3 本だけの列は、隣に同じ間隔の列があれば折り返しのもう 1 列
import { describe, expect, it } from 'vitest';
import { detectStairs, isTileGrid, stairSideOf, stairMarkDist, STAIR_MARK_RANGE } from '../src/parser/stairs';
import type { Seg } from '../src/parser/walls';

const seg = (x0: number, y0: number, x1: number, y1: number): Seg => ({ a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, width: 0.18, dashed: false, source: 'stroke' });
const within = { minX: -1000, minY: -1000, maxX: 20000, maxY: 20000 };
/** 横線の段（x0..x1、y を pitch 間隔で n 本） */
const treads = (x0: number, x1: number, y0: number, pitch: number, n: number): Seg[] => Array.from({ length: n }, (_, i) => seg(x0, y0 + pitch * i, x1, y0 + pitch * i));

describe('タイル目地と階段の見分け', () => {
  // 玄関の 300 角タイル: 横線 4 本（幅 1,220）と縦線（300 間隔。「玄関」の文字の所で途切れる）
  const tileH = treads(5088, 6308, 165, 300, 4);
  const tileV = [
    seg(5429, 53, 5429, 493),
    seg(5429, 872, 5429, 1312),
    seg(5730, 53, 5730, 1312),
    seg(6030, 53, 6030, 1312),
  ];
  // 折り返し階段: 右の列 5 本、左の列は 3 本（上は切断線で途切れる）。中央に中壁、昇る向きの矢印の軸が 1 本
  const right = treads(4403, 4968, 910, 227.5, 5);
  const left = treads(3493, 4058, 910, 227.5, 3);
  const axis = [seg(4684, 910, 4684, 1820)];

  it('段に直交する線が段の幅を等間隔に割っていれば格子（文字で途切れた線は長さを足して数える）', () => {
    const box = { minX: 5088, maxX: 6308, minY: 165, maxY: 1065, orient: 'h' as const, pitch: 300 };
    expect(isTileGrid(box, [...tileH, ...tileV])).toBe(true);
    // 階段の列: 中を通る直交の線は矢印の軸 1 本だけ → 格子ではない
    expect(isTileGrid({ minX: 4403, maxX: 4968, minY: 910, maxY: 1820, orient: 'h', pitch: 227.5 }, [...right, ...axis])).toBe(false);
  });

  it('段が中央でつながった折り返し階段: 左右の列の歩行線は格子ではなく、列が 2 つと読む（サンプル図面）', () => {
    // 段 217 間隔・幅 1,700（左右 850 ずつ、中央 12460 で接する）。中央線と、各列の中央に歩行線
    const halves = Array.from({ length: 6 }, (_, i) => [seg(11610, 4060 + 216.7 * i, 12460, 4060 + 216.7 * i), seg(12460, 4060 + 216.7 * i, 13310, 4060 + 216.7 * i)]).flat();
    const lines = [seg(12460, 4060, 12460, 5360), seg(12035, 4260, 12035, 5460), seg(12885, 4260, 12885, 5460)];
    const c = detectStairs([...halves, seg(11610, 5360, 13310, 5360), ...lines], within);
    expect(c).toHaveLength(1);
    expect(c[0].walk).toBe('columns');
  });

  it('幅の広い直階段: 中央の歩行線で分かれた段の線は 1 本にまとめ、歩行線は中央（池本様邸）', () => {
    const halves = Array.from({ length: 6 }, (_, i) => [seg(9330 + 240 * i, 6370, 9330 + 240 * i, 7280), seg(9330 + 240 * i, 7280, 9330 + 240 * i, 8190)]).flat();
    const c = detectStairs([...halves, seg(9200, 7280, 10700, 7280)], within);
    expect(c).toHaveLength(1);
    expect(c[0].flights).toBe(1);
    expect(c[0].walk).toBe('center');
    expect(Math.round(c[0].treadLen ?? 0)).toBe(1820);
  });

  it('玄関のタイルが階段の隣にあっても、階段の範囲は段の列だけ（舟橋様邸 1 階）', () => {
    const c = detectStairs([...tileH, ...tileV, ...right, ...left, ...axis], within);
    expect(c).toHaveLength(1);
    expect(c[0].minX).toBe(3493);
    expect(c[0].maxX).toBe(4968);
    expect(c[0].flights).toBe(2);
    expect(c[0].mixed).toBeUndefined();
  });

  it('3 本だけの並びは単独では階段にしない', () => {
    expect(detectStairs(left, within)).toHaveLength(0);
  });

  it('向きの違う列が混ざる階段（かね折れ・回り）は mixed', () => {
    const vert = Array.from({ length: 5 }, (_, i) => seg(5200 + 227.5 * i, 300, 5200 + 227.5 * i, 900));
    const c = detectStairs([...right, ...vert], within);
    expect(c).toHaveLength(1);
    expect(c[0].mixed).toBe(true);
  });

  it('手すり 1 本を挟んで並ぶ 2 つの折り返し階段は、別々の階段（有元様邸 2 階）', () => {
    // 縦の段（228 間隔）。上の階段は 2 列（y -1767..-962 と -858..-52）、下の階段も 2 列（52..858 と 962..1768）
    const col = (x0: number, n: number, y0: number, y1: number) => Array.from({ length: n }, (_, i) => seg(x0 + 228 * i, y0, x0 + 228 * i, y1));
    const upper = [...col(5185, 7, 3233, 4038), ...col(5185, 7, 4142, 4948)];
    const lower = [...col(5185, 5, 5052, 5858), ...col(5185, 5, 5962, 6768)];
    // 2 つの階段にまたがる、間隔の違う横線（286 間隔）
    const bridge = Array.from({ length: 4 }, (_, i) => seg(5185, 4262 + 286 * i, 6883, 4262 + 286 * i));
    const c = detectStairs([...upper, ...lower, ...bridge], within);
    const stairs = c.filter((q) => q.treadOrient === 'v');
    expect(stairs).toHaveLength(2);
    expect(stairs.every((q) => q.flights === 2)).toBe(true);
  });

  it('UP・DN の文字は階段の矩形から 900mm までを見る', () => {
    const r = { minX: 0, minY: 0, maxX: 1820, maxY: 1820 };
    expect(STAIR_MARK_RANGE).toBe(900);
    expect(stairMarkDist(r, { x: 900, y: 900 })).toBe(0);
    expect(stairMarkDist(r, { x: -549, y: 900 })).toBe(549);
    expect(stairSideOf(r, { x: -549, y: 900 })).toBe('w');
    expect(stairSideOf(r, { x: 900, y: 2200 })).toBe('s');
  });
});
