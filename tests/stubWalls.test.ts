import { describe, it, expect } from 'vitest';
import { absorbStubWalls } from '../src/core/stubWalls';
import type { Floor, Opening, Wall } from '../src/core/types';

const W = (id: string, ax: number, ay: number, bx: number, by: number, thickness = 130, extra: Partial<Wall> = {}): Wall => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness, exterior: false, ...extra });
const O = (id: string, wallId: string, t0: number, t1: number, kind: Opening['kind'] = 'open'): Opening => ({ id, wallId, kind, t0, t1, sill: 0, height: 2000 }) as Opening;
const floor = (walls: Wall[], openings: Opening[] = []): Floor => ({ level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, walls, openings, rooms: [], stairs: [], outline: [] }) as unknown as Floor;

describe('absorbStubWalls（壁の中の柱を短い壁として読んだものの後始末）', () => {
  it('壁の中に隠れる柱は外す', () => {
    const f = floor([W('long', 0, 0, 5000, 0), W('post', 2000, -51, 2000, 51)]);
    expect(absorbStubWalls(f).walls.map((w) => w.id)).toEqual(['long']);
  });

  it('建具の無い開口の端に掛かる柱: 柱のぶんだけ開口を詰めて、柱は外す（壁の面と揃う）', () => {
    // 開口 2000〜3000。柱は 2945 を中心に厚 130（2880〜3010）→ 開口の終わりを 2880 に
    const f = floor([W('long', 0, 0, 5000, 0), W('post', 2945, -51, 2945, 51)], [O('o1', 'long', 2000, 3000)]);
    const g = absorbStubWalls(f);
    expect(g.walls.map((w) => w.id)).toEqual(['long']);
    expect(g.openings[0]).toMatchObject({ t0: 2000, t1: 2880 });
    // 始まりの側も同じ
    const h = absorbStubWalls(floor([W('long', 0, 0, 5000, 0), W('post', 2050, -51, 2050, 51)], [O('o1', 'long', 2000, 3000)]));
    expect(h.openings[0]).toMatchObject({ t0: 2115, t1: 3000 });
  });

  it('窓・戸の付いた開口に掛かる柱は触らない（建具の幅を変えない）', () => {
    const f = floor([W('long', 0, 0, 5000, 0), W('post', 2945, -51, 2945, 51)], [O('o1', 'long', 2000, 3000, 'door')]);
    expect(absorbStubWalls(f)).toBe(f);
  });

  it('開口の真ん中に立つ柱・詰めると狭くなりすぎる開口は触らない', () => {
    const mid = floor([W('long', 0, 0, 5000, 0), W('post', 2500, -51, 2500, 51)], [O('o1', 'long', 2000, 3000)]);
    expect(absorbStubWalls(mid)).toBe(mid);
    const narrow = floor([W('long', 0, 0, 5000, 0), W('post', 2645, -51, 2645, 51)], [O('o1', 'long', 2000, 2700)]);
    expect(absorbStubWalls(narrow)).toBe(narrow);
  });

  it('壁の外へはみ出す短い壁（袖壁・壁の端の先）・腰壁・開口のある短い壁は残す', () => {
    const wing = floor([W('long', 0, 0, 5000, 0), W('wing', 2000, 0, 2000, 180)]);
    expect(absorbStubWalls(wing)).toBe(wing);
    const end = floor([W('long', 0, 0, 5000, 0), W('post', 4990, -51, 4990, 51)]);
    expect(absorbStubWalls(end)).toBe(end);
    const low = floor([W('long', 0, 0, 5000, 0), W('post', 2000, -51, 2000, 51, 130, { topMm: 1100 })]);
    expect(absorbStubWalls(low)).toBe(low);
    // 腰壁の中の柱（腰壁から天井まで立つ）も残す
    const inLow = floor([W('long', 0, 0, 5000, 0, 130, { topMm: 1100 }), W('post', 2000, -51, 2000, 51)]);
    expect(absorbStubWalls(inLow)).toBe(inLow);
  });

  it('長い壁に平行な短い壁（壁の中の切れ端）も、中に収まっていれば外す', () => {
    const f = floor([W('long', 0, 0, 5000, 0), W('bit', 1000, 5, 1150, 5, 110)]);
    expect(absorbStubWalls(f).walls.map((w) => w.id)).toEqual(['long']);
  });
});
