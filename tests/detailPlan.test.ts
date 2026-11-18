// ご契約後の実施図（平面詳細図 1/50）: 壁は線で描き、造作（靴箱・カウンター）だけを灰色の塗りで描く。通り芯・寸法の線の対が図面枠から建物まで伸びる。
// 岡﨑様邸の 16 ページの実施図で、階が 1 つも読めなかった 2 つの原因を固定する:
// ① 灰色の塗りが十数本あるだけで「壁は塗りで描かれた図面」と判断し、線の壁を候補から外していた
// ② 通り芯の線の対が枠と建物をつなぎ、建物ごと「図面枠」として捨てていた
import { describe, expect, it } from 'vitest';
import { detectPlans, type MmText, type PageMm } from '../src/parser/assemble';
import { detectWalls, type Seg } from '../src/parser/walls';
import type { Vec2 } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const stroke = (x0: number, y0: number, x1: number, y1: number, width = 0.48): Seg => ({ a: P(x0, y0), b: P(x1, y1), width, dashed: false, source: 'stroke' });
const fillSegs = (poly: Vec2[], color: string): Seg[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length], width: 0, dashed: false, source: 'fill' as const, color }));
const text = (str: string, x: number, y: number, size = 300): MmText => ({ str, x, y, size, angle: 0 });
/** 壁芯 (x0,y0)-(x1,y1)・厚み 120 の壁を、太い 2 本の線で描く */
const wall2 = (x0: number, y0: number, x1: number, y1: number): Seg[] =>
  x0 === x1 ? [stroke(x0 - 60, y0, x0 - 60, y1), stroke(x0 + 60, y0, x0 + 60, y1)] : [stroke(x0, y0 - 60, x1, y0 - 60), stroke(x0, y0 + 60, x1, y0 + 60)];

/** 8 × 6 m の建物（真ん中に間仕切り 1 本）。原点 (ox, oy) */
const house = (ox: number, oy: number): Seg[] => [
  ...wall2(ox, oy, ox + 8000, oy),
  ...wall2(ox, oy + 6000, ox + 8000, oy + 6000),
  ...wall2(ox, oy, ox, oy + 6000),
  ...wall2(ox + 8000, oy, ox + 8000, oy + 6000),
  ...wall2(ox + 4000, oy, ox + 4000, oy + 6000),
];
/** 造作の灰色の塗り（幅 200 × 長さ 1500 の帯）を n 本 */
const joinery = (ox: number, oy: number, n: number): Seg[] => Array.from({ length: n }, (_, i) => fillSegs(rect(ox + 500, oy + 500 + i * 600, ox + 2000, oy + 700 + i * 600), '#cbc9c9')).flat();

describe('平面詳細図（実施図）の読み取り', () => {
  it('造作の塗りが数本あるだけの図面は「塗りの壁」と判断しない（線の壁を読む）', () => {
    const segs = [...house(5000, 5000), ...joinery(5000, 5000, 6)];
    const det = detectWalls(segs, []);
    const long = det.pieces.filter((p) => p.t1 - p.t0 >= 3000);
    // 外周 4 本＋間仕切り 1 本（分かれていても 5 本以上）。塗りの帯（厚み 200）だけが壁になっていないこと
    expect(long.length).toBeGreaterThanOrEqual(5);
    expect(long.some((p) => Math.abs(p.d - 120) <= 10)).toBe(true);
  });

  it('通り芯の線の対が図面枠と建物をつないでいても、建物を図面枠として捨てない', () => {
    // 図面枠（二重線）: 0〜20000 × 0〜14000。建物は (6000, 4000)。枠の左辺から建物の左の壁まで、通り芯の線の対が伸びる
    const frame = [...wall2(0, 0, 20000, 0), ...wall2(0, 14000, 20000, 14000), ...wall2(0, 0, 0, 14000), ...wall2(20000, 0, 20000, 14000)];
    const grid = wall2(0, 7000, 6000, 7000); // 壁と同じ間隔の 2 本の線なので「壁」として読まれ、枠の左辺と建物の左の壁をつなぐ
    const page: PageMm = { pageIndex: 0, segs: [...frame, ...house(6000, 4000), ...grid], arcs: [], texts: [text('洋室', 8000, 7000), text('寝室', 12000, 7000)], fills: [], masks: [], colorFills: [] };
    const plans = detectPlans([page], []);
    expect(plans.length).toBe(1);
    const b = plans[0].bbox;
    expect(b.maxX - b.minX).toBeLessThan(9000); // 建物だけ（枠の 20 m ではない）
    expect(b.maxY - b.minY).toBeLessThan(7000);
  });
});
