// 通り口の印（両端に小さな丸の付いた短い線）: 人が通る建具に付く。棚・パイプ・框の線には付かない
import { describe, expect, it } from 'vitest';
import { detectPassMarks, marksCrossing } from '../src/parser/passMarks';
import { cutWallSpans } from '../src/parser/assemble';
import type { Arc, Seg } from '../src/parser/walls';

const seg = (ax: number, ay: number, bx: number, by: number, dashed = false): Seg => ({ a: { x: ax, y: ay }, b: { x: bx, y: by }, width: 0.36, dashed, source: 'stroke' });
/** 半径 r の丸を n 角形の細かい線分で描く */
const circle = (cx: number, cy: number, r = 12.5, n = 20, from = 0, to = n): Seg[] => {
  const out: Seg[] = [];
  for (let i = from; i < to; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    out.push(seg(cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1)));
  }
  return out;
};
/** 印: (x0,y)-(x1,y) の線と、両端から 17 mm 離れた直径 25 mm の丸（ARCHITREND の実物と同じ寸法） */
const hMark = (x0: number, x1: number, y: number): Seg[] => [seg(x0, y, x1, y), ...circle(x0 - 29.5, y), ...circle(x1 + 29.5, y)];
const vMark = (x: number, y0: number, y1: number): Seg[] => [seg(x, y0, x, y1), ...circle(x, y0 - 29.5), ...circle(x, y1 + 29.5)];

describe('通り口の印の検出', () => {
  it('両端に丸の付いた 404 mm の線を印として拾う（横・縦）', () => {
    const marks = detectPassMarks([...hMark(1000, 1404, 500), ...vMark(3000, 800, 1204)]);
    expect(marks).toHaveLength(2);
    expect(Math.round(marks[0].len)).toBe(404);
  });

  it('丸の無いただの線、片方だけ丸の線、破線は印ではない', () => {
    const plain = seg(1000, 500, 1404, 500);
    const oneEnd = [seg(1000, 900, 1404, 900), ...circle(1000 - 29.5, 900)];
    const dashed = [seg(1000, 1300, 1404, 1300, true), ...circle(1000 - 29.5, 1300), ...circle(1404 + 29.5, 1300)];
    // 丸が十分ある図面（小さな線分が 16 本以上）でも拾わない
    expect(detectPassMarks([plain, ...oneEnd, ...dashed])).toHaveLength(0);
  });

  it('丸の一部が曲線（ベジェ）で残っている図面でも拾う', () => {
    // 左の丸の 1/4 が曲線になっている（大崎様邸の図面の描き方）
    const left = circle(1000 - 29.5, 500, 12.5, 20, 5, 20);
    const c = { x: 1000 - 29.5, y: 500 };
    const arc: Arc = { p0: { x: c.x + 12.5, y: c.y }, p1: { x: c.x + 12.5, y: c.y + 7 }, p2: { x: c.x + 7, y: c.y + 12.5 }, p3: { x: c.x, y: c.y + 12.5 } };
    const marks = detectPassMarks([seg(1000, 500, 1404, 500), ...left, ...circle(1404 + 29.5, 500)], [arc]);
    expect(marks).toHaveLength(1);
  });

  it('長すぎる線（両端に丸の付いた 2,958 mm の金物の線）や、線の延長上から外れた丸は印ではない', () => {
    const bar = [seg(1000, 500, 3958, 500), ...circle(1000 - 29.5, 500), ...circle(3958 + 29.5, 500)];
    const off = [seg(1000, 900, 1404, 900), ...circle(1000 - 29.5, 925), ...circle(1404 + 29.5, 925)];
    expect(detectPassMarks([...bar, ...off])).toHaveLength(0);
  });

  it('同じ印が二重に描かれていても 1 つ', () => {
    expect(detectPassMarks([...hMark(1000, 1404, 500), ...hMark(1000, 1404, 500)])).toHaveLength(1);
  });
});

describe('印が開口を横切るか', () => {
  const marks = detectPassMarks([...vMark(2000, 800, 1204), ...hMark(5000, 5404, 3000)]);
  it('壁（y=1000 の横の壁）の 1600〜2400 の区間を、x=2000 の縦の印が横切る', () => {
    expect(marksCrossing(marks, { x: 0, y: 1000 }, { x: 4000, y: 1000 }, 1600, 2400)).toBe(1);
    // 区間が離れていれば横切らない
    expect(marksCrossing(marks, { x: 0, y: 1000 }, { x: 4000, y: 1000 }, 2600, 3400)).toBe(0);
  });
  it('壁に平行な印、壁から離れた印は数えない', () => {
    // x=2000 の縦の印は、縦の壁（x=2000）には平行
    expect(marksCrossing(marks, { x: 2000, y: 0 }, { x: 2000, y: 4000 }, 600, 1400)).toBe(0);
    // y=3000 の横の印は、x=6500 の縦の壁からは 1 m 以上離れている
    expect(marksCrossing(marks, { x: 6500, y: 0 }, { x: 6500, y: 4000 }, 2600, 3400)).toBe(0);
    // x=5200 の縦の壁なら横切る
    expect(marksCrossing(marks, { x: 5200, y: 0 }, { x: 5200, y: 4000 }, 2600, 3400)).toBe(1);
  });
});

describe('壁の区間の切り取り', () => {
  type W = Parameters<typeof cutWallSpans>[0][number];
  const hWall = (x0: number, x1: number, y: number, openings: { t0: number; t1: number; kind: 'window' | 'open' | 'door' }[] = []): W =>
    ({ a: { x: x0, y }, b: { x: x1, y }, u: { x: 1, y: 0 }, n: { x: 0, y: 1 }, d: 106, t0: x0, t1: x1, o: y, g: 0, openings: openings.map((o) => ({ ...o, confidence: 0.7 })), joinedA: true, joinedB: true }) as unknown as W;

  it('真ん中の区間を切ると 2 本の壁になり、切った区間の開口は消え、残りの開口は残る', () => {
    const w = hWall(0, 6000, 1000, [
      { t0: 300, t1: 1100, kind: 'door' },
      { t0: 2000, t1: 4000, kind: 'window' },
    ]);
    const walls = [w];
    cutWallSpans(walls, w, [[2000, 4000]]);
    expect(walls).toHaveLength(2);
    expect(walls[0].a.x).toBe(0);
    expect(walls[0].b.x).toBe(2000);
    expect(walls[0].joinedA).toBe(true);
    expect(walls[0].joinedB).toBe(false);
    expect(walls[0].openings).toHaveLength(1);
    expect(walls[1].a.x).toBe(4000);
    expect(walls[1].b.x).toBe(6000);
    expect(walls[1].joinedA).toBe(false);
    expect(walls[1].joinedB).toBe(true);
    expect(walls[1].openings).toHaveLength(0);
    // 元の壁は書き換えない
    expect(w.b.x).toBe(6000);
  });

  it('柱 1 本ぶんにも満たない端（80 mm 未満）は残さない。全部が区間なら壁ごと消える', () => {
    const w = hWall(0, 4500, 1000, [{ t0: 53, t1: 4447, kind: 'window' }]);
    const walls = [w];
    cutWallSpans(walls, w, [[53, 4447]]);
    expect(walls).toHaveLength(0);
  });

  it('2 つの区間をまとめて切る', () => {
    const w = hWall(0, 9000, 1000, [
      { t0: 1000, t1: 3000, kind: 'window' },
      { t0: 5000, t1: 7000, kind: 'window' },
    ]);
    const walls = [w];
    cutWallSpans(walls, w, [
      [5000, 7000],
      [1000, 3000],
    ]);
    expect(walls.map((q) => [q.a.x, q.b.x])).toEqual([
      [0, 1000],
      [3000, 5000],
      [7000, 9000],
    ]);
  });
});

describe('壁の角の結び直しで開口の位置を保つ', () => {
  // 右から左へ引かれた壁（斜めの壁に多い）でも、開口は壁の始点からの距離のまま = 図面の同じ場所に残る
  const worldCenter = (w: { a: { x: number; y: number }; b: { x: number; y: number } }, o: { t0: number; t1: number }) => {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const t = (o.t0 + o.t1) / 2;
    return { x: w.a.x + ((w.b.x - w.a.x) * t) / L, y: w.a.y + ((w.b.y - w.a.y) * t) / L };
  };
  it('斜めの壁（右上 → 左下）の始点寄りの窓が、反対の端へ押しやられない（吉田様邸 1st のテラス窓）', async () => {
    const { rejoinFloorWalls } = await import('../src/parser/assemble');
    const k = Math.SQRT1_2;
    // 斜めの壁: 右上 (5000, 1000) から左下へ 3600。始点の先（右上）に横の壁があり、角を結ぶと始点が少し伸びる
    const diag = { id: 'W1', a: { x: 5000, y: 1000 }, b: { x: 5000 - 3600 * k, y: 1000 + 3600 * k }, thickness: 120, exterior: true, joinedA: false, joinedB: false };
    const top = { id: 'W2', a: { x: 5000, y: 960 }, b: { x: 9000, y: 960 }, thickness: 120, exterior: true, joinedA: false, joinedB: false };
    const win = { id: 'W1-O1', wallId: 'W1', kind: 'window' as const, t0: 200, t1: 1800, sill: 0, height: 2000 };
    const f = { level: 1, walls: [diag, top], openings: [win], rooms: [], stairs: [], outline: [], height: 2800, elevation: 500 } as never;
    const before = worldCenter(diag, win);
    rejoinFloorWalls(f);
    const after = worldCenter(diag, win);
    expect(win.t1 - win.t0).toBeCloseTo(1600, 0);
    // 窓は図面の同じ場所（±80 mm。以前は壁の反対の端まで 1.8 m 動いていた）
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(80);
  });
});
