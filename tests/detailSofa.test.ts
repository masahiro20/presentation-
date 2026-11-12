// 背のクッションを丸く描いた、まっすぐのソファの記号（第 42 巡 ⑭。大崎様邸 1 階・堀様邸（福井）1 階）
// 線が数百本あって今までの決まり（200 本まで）から外れ、背のクッションの列だけが「壁沿いの薄い台 = テレビ台」に読まれていた
import { describe, expect, it } from 'vitest';
import { detectSymbols, symbolsToItems } from '../src/parser/symbols';
import { readContextItems } from '../src/parser/context';
import type { Seg } from '../src/parser/walls';
import type { FurnitureItem, Room, Vec2, Wall } from '../src/core/types';

const seg = (a: Vec2, b: Vec2, width = 0.12): Seg => ({ a, b, width, dashed: false, source: 'stroke' });
const rectSegs = (x0: number, y0: number, x1: number, y1: number): Seg[] => [seg({ x: x0, y: y0 }, { x: x1, y: y0 }), seg({ x: x1, y: y0 }, { x: x1, y: y1 }), seg({ x: x1, y: y1 }, { x: x0, y: y1 }), seg({ x: x0, y: y1 }, { x: x0, y: y0 })];
/** 丸い背のクッション: 座面の辺（x = xs、y = ya〜yb）から dir の側へふくらむ半楕円を、短い線 n 本で（両端は座面の角につながる） */
const blob = (xs: number, ya: number, yb: number, depth: number, dir: 1 | -1, n = 70): Seg[] => {
  const out: Seg[] = [];
  const cy = (ya + yb) / 2;
  const ry = (yb - ya) / 2;
  const pt = (i: number): Vec2 => {
    const t = -Math.PI / 2 + (i / n) * Math.PI;
    return { x: xs + dir * depth * Math.cos(t), y: cy + ry * Math.sin(t) };
  };
  for (let i = 0; i < n; i++) out.push(seg(pt(i), pt(i + 1)));
  return out;
};
/**
 * 3 人掛けのソファ（800 × 1,900、縦置き）。背のクッション（丸）3 つと座面（四角）3 つ
 * @param backWest 背が西（x の小さい側）なら true
 */
function sofa(x0: number, y0: number, backWest = true): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < 3; i++) {
    const ya = y0 + (1900 / 3) * i;
    const yb = y0 + (1900 / 3) * (i + 1);
    if (backWest) {
      out.push(...blob(x0 + 350, ya, yb, 350, -1));
      out.push(...rectSegs(x0 + 350, ya, x0 + 800, yb));
    } else {
      out.push(...blob(x0 + 450, ya, yb, 350, 1));
      out.push(...rectSegs(x0, ya, x0 + 450, yb));
    }
  }
  return out;
}
const rectPts = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const ldk: Room = { id: 'R1', name: 'ＬＤＫ', type: 'ldk', polygon: rectPts(0, 0, 8000, 6000), area: 48, labelPos: { x: 5000, y: 3000 } };
const wallsOf = (): Wall[] => [
  { id: 'W1', a: { x: 0, y: 0 }, b: { x: 8000, y: 0 }, thickness: 105, exterior: true },
  { id: 'W2', a: { x: 8000, y: 0 }, b: { x: 8000, y: 6000 }, thickness: 105, exterior: true },
  { id: 'W3', a: { x: 8000, y: 6000 }, b: { x: 0, y: 6000 }, thickness: 105, exterior: true },
  { id: 'W4', a: { x: 0, y: 6000 }, b: { x: 0, y: 0 }, thickness: 105, exterior: true },
];

describe('背のクッションを丸く描いたソファの記号', () => {
  it('まっすぐのソファとして読み、丸いクッションの側を背にする（壁の近さではなく記号で決める）', () => {
    // 部屋の真ん中に置いたソファ（どの壁からも遠い）。背は西
    const syms = detectSymbols(sofa(3000, 2000, true));
    const s = syms.find((q) => q.kind === 'sofa');
    expect(s).toBeTruthy();
    expect(Math.max(s!.w, s!.h)).toBeGreaterThan(1850);
    expect(Math.min(s!.w, s!.h)).toBeLessThan(850);
    expect(s!.back!.x).toBe(-1);
    expect(Math.abs(s!.back!.y)).toBeLessThan(1e-6);
    const { items } = symbolsToItems(syms, [ldk], wallsOf(), [rectPts(0, 0, 8000, 6000)], 1);
    const it = items.find((q) => q.kind === 'sofa')!;
    expect(it).toBeTruthy();
    // 座る向き（inward）は東: rot 270（along = (0,-1)、inward = (1,0)）。置く基準は背の辺
    expect(it.rot).toBe(270);
    expect(Math.abs(it.x - 3000)).toBeLessThan(30);
    expect(Math.abs(it.y - 2950)).toBeLessThan(30);
    expect(it.w).toBeCloseTo(1.9, 1);
  });

  it('背が東なら、座る向きは西', () => {
    const syms = detectSymbols(sofa(3000, 2000, false));
    const s = syms.find((q) => q.kind === 'sofa')!;
    expect(s.back!.x).toBe(1);
    const { items } = symbolsToItems(syms, [ldk], wallsOf(), [rectPts(0, 0, 8000, 6000)], 1);
    expect(items.find((q) => q.kind === 'sofa')!.rot).toBe(90);
  });

  it('端から端まで通る直線がある（カウンター・台）なら、この決まりではソファにしない', () => {
    const segs = [...sofa(3000, 2000, true), seg({ x: 3800, y: 2000 }, { x: 3800, y: 3900 })];
    expect(detectSymbols(segs).some((q) => q.kind === 'sofa' && q.back)).toBe(false);
  });

  it('切り替えを切ると、今までどおり読めない', () => {
    const g = globalThis as { __NO_DETAIL_SOFA?: boolean };
    g.__NO_DETAIL_SOFA = true;
    try {
      expect(detectSymbols(sofa(3000, 2000, true)).some((q) => q.kind === 'sofa')).toBe(false);
    } finally {
      delete g.__NO_DETAIL_SOFA;
    }
  });
});

describe('形で読めたソファの中の長方形は、ソファの部品', () => {
  // 西の壁沿いのソファ（背のクッションの列が、壁沿いの薄い長方形 360 × 1,900 に見える）
  const thin = rectSegs(60, 2000, 420, 3900);
  const prior: FurnitureItem[] = [{ id: 'S1', kind: 'sofa', x: 60, y: 2950, rot: 270, roomId: 'R1', w: 1.9 }];

  it('ソファが読めていなければ、壁沿いの薄い長方形はテレビ台に読める（今までどおり）', () => {
    const res = readContextItems(thin, [], [ldk], wallsOf(), 1);
    expect(res.items.some((q) => q.kind === 'tv')).toBe(true);
  });

  it('ソファが読めていれば、その中の薄い長方形はテレビ台にしない', () => {
    const res = readContextItems(thin, [], [ldk], wallsOf(), 1, undefined, prior);
    expect(res.items.some((q) => q.kind === 'tv')).toBe(false);
  });

  it('ソファから離れた壁沿いの薄い長方形は、テレビ台のまま', () => {
    const far = rectSegs(7580, 2000, 7940, 3900);
    const res = readContextItems(far, [], [ldk], wallsOf(), 1, undefined, prior);
    expect(res.items.some((q) => q.kind === 'tv')).toBe(true);
  });
});
