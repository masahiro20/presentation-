import { describe, it, expect } from 'vitest';
import { reconcileTatami, sharedEdges, connectionAcross } from '../src/parser/tatamiCheck';
import type { Opening, Room, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (id: string, name: string, type: Room['type'], poly: { x: number; y: number }[], labeled?: number, extra: Partial<Room> = {}): Room => {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { id, name, type, polygon: poly, area: ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / 1e6, labelPos: poly[0], labeledTatami: labeled, ...extra };
};

describe('帖数との照合（池本様邸のＬＤＫ）', () => {
  // リビング側 ＬＤＫ（24.7 帖と書いてある）5.0×4.96 ＝ 24.8㎡ ＝ 15.3 帖、キッチン側 3.19×6.37 ＝ 20.3㎡ ＝ 12.5 帖に pantry①（2.6 帖）の名前
  const ldk = room('a', 'ＬＤＫ', 'ldk', rect(8190, 8190, 13200, 13150), 24.7);
  const kitchen = room('b', 'pantry①', 'storage', rect(5000, 8190, 8190, 14560), 2.6);
  const wall: Wall = { id: 'W', a: { x: 8190, y: 8190 }, b: { x: 8190, y: 14560 }, thickness: 130, exterior: false };
  const sliding: Opening = { id: 'o', wallId: 'W', kind: 'sliding', t0: 2500, t1: 4300, sill: 0, height: 2000 };

  it('共有する辺と、そこの壁・開口が分かる', () => {
    const e = sharedEdges(ldk.polygon, kitchen.polygon);
    expect(e).toHaveLength(1);
    expect(e[0].len).toBe(13150 - 8190);
    expect(connectionAcross(e[0], [wall], [])).toEqual({ wall: true, openingLen: 0 });
    expect(connectionAcross(e[0], [wall], [sliding]).openingLen).toBe(1800);
    expect(connectionAcross(e[0], [], []).wall).toBe(false);
  });

  it('開口でつながる隣の区画を足すと帖数に合う → 同じ部屋の名前にする', () => {
    const rooms = [structuredClone(ldk), structuredClone(kitchen)];
    const r = reconcileTatami(rooms, [wall], [sliding], 1);
    expect(r.renamed).toEqual([{ roomId: 'b', from: 'pantry①', to: 'ＬＤＫ（pantry①側）' }]);
    expect(rooms[1].type).toBe('ldk');
    expect(rooms[1].labeledTatami).toBeUndefined();
    expect(r.warnings[0]).toMatch(/pantry① と読んだ区画/);
  });

  it('開口の無い壁で仕切られていれば足さない（注記だけ）', () => {
    const rooms = [structuredClone(ldk), structuredClone(kitchen)];
    const r = reconcileTatami(rooms, [wall], [], 1);
    expect(r.renamed).toHaveLength(0);
    expect(rooms[1].name).toBe('pantry①');
    expect(r.warnings[0]).toMatch(/24\.7 帖ですが/);
  });

  it('水まわり・階段は足さない。帖数が合っている部屋は触らない', () => {
    const bath = room('c', 'ＵＢ', 'bath', rect(5000, 8190, 8190, 14560));
    const rooms = [structuredClone(ldk), bath];
    const r = reconcileTatami(rooms, [], [], 1);
    expect(r.renamed).toHaveLength(0);
    const ok = room('d', '洋室', 'bedroom', rect(0, 0, 3640, 2730), 6);
    const r2 = reconcileTatami([ok, room('e', '室', 'other', rect(3640, 0, 5460, 2730))], [], [], 2);
    expect(r2.renamed).toHaveLength(0);
    expect(r2.warnings).toHaveLength(0);
  });
});

describe('天井高の注記', () => {
  it('「天井高2.6m」「CH=3500」はその文字のある部屋だけ。既定の 2400 と同じなら付けない', async () => {
    const { applyCeilingNotes } = await import('../src/parser/tatamiCheck');
    const a = room('a', 'トレーニングルーム', 'other', rect(0, 0, 5000, 4550));
    const b = room('b', '多目的室', 'living', rect(5000, 0, 8200, 4550));
    const g = room('g', '車庫', 'garage', rect(0, 5000, 7000, 11000));
    const res = applyCeilingNotes([a, b, g], [
      { str: '天井高２．６ｍ', x: 1000, y: 1000 },
      { str: 'CH=3500', x: 6000, y: 1000 },
      { str: 'シャッター開けてCH2400', x: 1000, y: 6000 },
    ]);
    expect(res).toEqual([{ roomId: 'a', ch: 2600 }, { roomId: 'b', ch: 3500 }]);
    expect(a.ceilingHeight).toBe(2600);
    expect(g.ceilingHeight).toBeUndefined();
  });
});

describe('分かれた LDK の役割', () => {
  it('キッチンの記号がある区画がキッチン側（ldk）、無い区画がリビング側（living）', async () => {
    const { assignLdkRoles } = await import('../src/parser/tatamiCheck');
    const a = room('a', 'ＬＤＫ', 'ldk', rect(8190, 8190, 13200, 13150));
    const b = room('b', 'ＬＤＫ（pantry①側）', 'ldk', rect(5000, 8190, 8190, 14560));
    const msgs = assignLdkRoles([a, b], [{ roomId: 'b', from: 'pantry①', to: 'ＬＤＫ（pantry①側）' }], [{ kind: 'kitchen', roomId: 'b' }]);
    expect(b.name).toBe('ＬＤＫ（キッチン側）');
    expect(b.type).toBe('ldk');
    expect(a.name).toBe('ＬＤＫ（リビング側）');
    expect(a.type).toBe('living');
    expect(msgs).toHaveLength(1);
  });
});
