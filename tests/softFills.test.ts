// 壁を色の塗りで描く図面: 壁ではない色（部屋・階段の段・造作）の塗りの輪郭を壁面の候補から外して読み直す。
// 有元様邸 2 階: 壁の両側に階段の色の帯（70・51 mm）が並び、本物の壁の線の組が「帯に挟まれた入れ子」として捨てられて、
// 寝室と階段ホールの間の壁 4.6 m と、2 つの階段の間の壁・引込み戸が消えていた
import { describe, expect, it } from 'vitest';
import { cleanPolygon, detectPlans, softFillColors, wallStripCoverage, type MmText, type PageMm } from '../src/parser/assemble';
import { detectWalls, type Seg } from '../src/parser/walls';
import type { Vec2 } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const fillSegs = (poly: Vec2[], color: string): Seg[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length], width: 0, dashed: false, source: 'fill' as const, color }));
const stroke = (x0: number, y0: number, x1: number, y1: number): Seg => ({ a: P(x0, y0), b: P(x1, y1), width: 0.2, dashed: false, source: 'stroke' });
const text = (str: string, x: number, y: number, size = 300): MmText => ({ str, x, y, size, angle: 0 });

const GRAY = '#808080';
const BEIGE = '#eedbbb';
const CREAM = '#fdf4e3';
const T = 106;
const O = 5000;

/**
 * 7,280 × 5,460 の家。真ん中の壁（y = 2,730）の両側に、階段の色の帯（70・51 mm）と段の塗りが 4,550 mm 並ぶ。
 * 壁は灰色の塗り、部屋は淡い色の塗り
 */
function fills(): { poly: Vec2[]; color: string }[] {
  const wall = (x0: number, y0: number, x1: number, y1: number) => ({ poly: x0 === x1 ? rect(O + x0 - T / 2, O + y0 - T / 2, O + x0 + T / 2, O + y1 + T / 2) : rect(O + x0 - T / 2, O + y0 - T / 2, O + x1 + T / 2, O + y0 + T / 2), color: GRAY });
  const f = (x0: number, y0: number, x1: number, y1: number, color: string) => ({ poly: rect(O + x0, O + y0, O + x1, O + y1), color });
  const H = T / 2;
  return [
    wall(0, 0, 7280, 0), wall(0, 5460, 7280, 5460), wall(0, 0, 0, 5460), wall(7280, 0, 7280, 5460),
    wall(0, 2730, 7280, 2730), // 階段に挟まれた壁
    wall(1820, 0, 1820, 2730), wall(1820, 2730, 1820, 5460), wall(6370, 0, 6370, 2730),
    // 上の階段: 段の塗り（910 × 800 が 5 枚）と、壁沿いの帯 51・70 mm
    ...[0, 1, 2, 3, 4].map((k) => f(1820 + k * 910, 2730 - H - 921, 2730 + k * 910, 2730 - H - 121, BEIGE)),
    f(1820, 2730 - H - 121, 6370, 2730 - H - 70, BEIGE),
    f(1820, 2730 - H - 70, 6370, 2730 - H, BEIGE),
    // 下の階段
    f(1820, 2730 + H, 6370, 2730 + H + 70, BEIGE),
    f(1820, 2730 + H + 70, 6370, 2730 + H + 121, BEIGE),
    ...[0, 1, 2, 3, 4].map((k) => f(1820 + k * 910, 2730 + H + 121, 2730 + k * 910, 2730 + H + 921, BEIGE)),
    // 部屋の色
    f(0, 0, 1820, 2730, CREAM),
    f(0, 2730, 1820, 5460, CREAM),
  ];
}
const segsOf = (fs: { poly: Vec2[]; color: string }[]): Seg[] => fs.flatMap((x) => fillSegs(x.poly, x.color));
/** 軸 y（±20）の横向きの壁片が通っている x の範囲の長さ */
const pieceLenAt = (det: ReturnType<typeof detectWalls>, y: number) =>
  det.pieces
    .filter((p) => Math.abs(det.groups[p.g].u.x) > 0.9 && Math.abs(Math.abs(p.o) - y) < 20 && p.d > 90 && p.d < 125)
    .reduce((s, p) => s + (p.t1 - p.t0), 0);

describe('壁ではない塗りの色', () => {
  it('段・部屋の色（面積の大半が太い塗り）は壁ではない色。壁の色・細い帯だけの色は入れない', () => {
    const fs = [...fills(), { poly: rect(0, 0, 60, 2000), color: '#333333' }, { poly: rect(100, 0, 160, 2000), color: '#333333' }];
    const soft = softFillColors(fs, new Set([GRAY]));
    expect(soft.has(BEIGE)).toBe(true);
    expect(soft.has(CREAM)).toBe(true);
    expect(soft.has(GRAY)).toBe(false);
    // 細い帯ばかりの色（腰壁・手すり壁かもしれない）は外さない
    expect(soft.has('#333333')).toBe(false);
  });

  it('描かれた壁（壁の色の細い塗り）の縁の点のうち、検出した壁が説明している数を数える', () => {
    const fs = fills();
    const all = wallStripCoverage(fs, new Set([GRAY]), [{ a: P(O, O + 2730), b: P(O + 7280, O + 2730), d: T }]);
    // 8 枚の壁 × 長い辺 2 本 × 3 点
    expect(all.n).toBe(48);
    // y = 2,730 の壁だけを渡したので、その壁の 6 点＋直交する壁の端の近くの点だけ
    expect(all.on).toBeGreaterThanOrEqual(6);
    expect(all.on).toBeLessThan(20);
    expect(wallStripCoverage(fs, new Set([GRAY]), []).on).toBe(0);
  });
});

describe('階段の色の帯に挟まれた壁', () => {
  it('そのままでは壁の線の組が「入れ子」として捨てられ、壁ではない色を外すと壁として読める', () => {
    const segs = segsOf(fills());
    const y = O + 2730;
    const plain = detectWalls(segs, [], {}, []);
    expect(pieceLenAt(plain, y)).toBeLessThan(1000);
    const soft = detectWalls(segs, [], { softFillColors: new Set([BEIGE, CREAM]) }, []);
    expect(pieceLenAt(soft, y)).toBeGreaterThan(7000);
    // 帯（70・51 mm）は壁にならない
    expect(soft.pieces.some((p) => p.d < 80 && p.t1 - p.t0 > 3000)).toBe(false);
  });

  it('図面として読むと、取りこぼした壁を読み直しで拾う（1 回目の読みで足りている図面は変えない）', () => {
    const fs = fills();
    const page: PageMm = {
      pageIndex: 0,
      // 用紙の隅の線（図がページ全体を占めると図面枠として除かれる）
      segs: [...segsOf(fs), stroke(0, 0, 500, 0), stroke(29000, 20500, 29700, 20500), stroke(29700, 20000, 29700, 21000)],
      arcs: [],
      texts: [text('洋室', O + 900, O + 1300), text('（3.0帖）', O + 900, O + 1700, 250), text('納戸', O + 900, O + 4000), text('ホール', O + 4000, O + 4600), text('2 階', O + 3000, O + 6500, 398), text('平 面 図', O + 4450, O + 6500, 398)],
      fills: [],
      masks: [],
      colorFills: fs,
    };
    const g = globalThis as { __NO_SOFT_FILLS?: boolean };
    const long = (ws: { a: Vec2; b: Vec2 }[]) => ws.filter((w) => Math.abs(w.a.y - (O + 2730)) < 30 && Math.abs(w.b.y - (O + 2730)) < 30).reduce((s, w) => s + Math.abs(w.b.x - w.a.x), 0);
    g.__NO_SOFT_FILLS = true;
    try {
      const before = detectPlans([page], []);
      expect(before.length).toBe(1);
      expect(long(before[0].walls)).toBeLessThan(3000);
    } finally {
      delete g.__NO_SOFT_FILLS;
    }
    const plans = detectPlans([page], []);
    expect(plans.length).toBe(1);
    expect(long(plans[0].walls)).toBeGreaterThan(7000);
  });
});

describe('格子へ寄せた後の輪郭の掃除', () => {
  it('行って戻るだけのとげ（面積 0）を除く', () => {
    const poly = [P(3185, 0), P(3185, 1820), P(5005, 1820), P(4827, 1820), P(5005, 1820), P(5005, 0), P(4827, 0), P(5005, 0)];
    expect(cleanPolygon(poly, poly)).toEqual([P(3185, 0), P(3185, 1820), P(5005, 1820), P(5005, 0)]);
  });
  it('とげの無い輪郭はそのまま（一直線上の頂点だけ除く）', () => {
    const poly = [P(0, 0), P(1000, 0), P(2000, 0), P(2000, 1000), P(0, 1000)];
    expect(cleanPolygon(poly, poly)).toEqual([P(0, 0), P(2000, 0), P(2000, 1000), P(0, 1000)]);
  });
});
