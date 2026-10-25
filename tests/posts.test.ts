import { describe, it, expect } from 'vitest';
import { overhangPoints, suggestOverhangPosts, postInWall, postSpan, hasPostNear } from '../src/core/posts';
import { woodCheck } from '../src/parser/woodCheck';
import type { BuildingModel, Floor, Vec2, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const wallsOf = (loop: Vec2[], lv: number): Wall[] => loop.map((a, i) => ({ id: `F${lv}-W${i}`, a, b: loop[(i + 1) % loop.length], thickness: 120, exterior: true }));
const floor = (level: number, loop: Vec2[], elevation: number): Floor => ({ level, elevation, height: 2900, ceilingHeight: 2400, walls: wallsOf(loop, level), openings: [], rooms: [], stairs: [], outline: [loop] });

// 1 階 7280×5460、2 階は南（図面の下 = +y）へ 1820 張り出す
const f1 = floor(1, rect(0, 0, 7280, 5460), 500);
const f2 = floor(2, rect(0, 0, 7280, 7280), 3400);
const model = { name: 't', northAngleDeg: 0, floors: [f1, f2] } as unknown as BuildingModel;

describe('柱（張り出しの足元・通し柱）', () => {
  it('2 階の張り出しの角と、長い辺の途中を見つける', () => {
    const pts = overhangPoints(f1, f2);
    const corners = pts.filter((o) => o.corner);
    expect(corners.map((o) => o.p)).toEqual(expect.arrayContaining([{ x: 7280, y: 7280 }, { x: 0, y: 7280 }]));
    expect(corners.every((o) => Math.abs(o.depth - 1820) < 1)).toBe(true);
    // 7,280 の辺は 1.5 間（2,730）ごとに途中にも
    expect(pts.filter((o) => !o.corner).length).toBe(2);
    // 張り出していない階どうしでは無し
    expect(overhangPoints(f1, floor(2, rect(0, 0, 7280, 5460), 3400))).toEqual([]);
  });

  it('提案は 1 階に置く独立柱。置いた後は提案が消える', () => {
    const sug = suggestOverhangPosts(f1, f2);
    expect(sug.length).toBe(4);
    expect(sug.every((p) => p.kind === 'free' && p.auto && p.size === 105)).toBe(true);
    const f1b = { ...f1, posts: sug };
    expect(suggestOverhangPosts(f1b, f2)).toEqual([]);
    expect(hasPostNear(f1b.posts, { x: 7200, y: 7300 })).toBe(true);
  });

  it('柱の高さ: 管柱・独立柱は上の階の床まで、通し柱は最上階の上まで。壁の中の柱の判定', () => {
    expect(postSpan(model, f1, { id: 'a', x: 0, y: 7280, size: 105, kind: 'free' })).toEqual({ y0: 500, y1: 3400 });
    expect(postSpan(model, f1, { id: 'b', x: 0, y: 0, size: 120, kind: 'toshi' })).toEqual({ y0: 500, y1: 6300 });
    expect(postSpan(model, f2, { id: 'c', x: 0, y: 0, size: 105, kind: 'kuda' })).toEqual({ y0: 3400, y1: 6300 });
    expect(postInWall({ id: 'd', x: 3640, y: 30, size: 105, kind: 'kuda' }, f1.walls)).toBe(true);
    expect(postInWall({ id: 'e', x: 3640, y: 7280, size: 105, kind: 'free' }, f1.walls)).toBe(false);
  });

  it('木造チェック: 張り出しの足元に柱が無いと警告、置けば消える', () => {
    const iss = woodCheck(model).filter((i) => i.id === 'overhang-post-2');
    expect(iss.length).toBe(1);
    expect(iss[0].severity).toBe('warn');
    expect(iss[0].level).toBe(1);
    const withPosts = { ...model, floors: [{ ...f1, posts: suggestOverhangPosts(f1, f2) }, f2] } as BuildingModel;
    expect(woodCheck(withPosts).some((i) => i.id === 'overhang-post-2')).toBe(false);
  });
});
