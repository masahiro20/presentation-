import { describe, expect, it } from 'vitest';
import { assembleModel, detectPlans, fillWidth, wallFillColors, type MmText, type PageMm } from '../src/parser/assemble';
import type { Seg } from '../src/parser/walls';
import type { Vec2 } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const fillSegs = (poly: Vec2[]): Seg[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length], width: 0, dashed: false, source: 'fill' as const }));
const stroke = (x0: number, y0: number, x1: number, y1: number): Seg => ({ a: P(x0, y0), b: P(x1, y1), width: 0.2, dashed: false, source: 'stroke' });
const text = (str: string, x: number, y: number, size = 300): MmText => ({ str, x, y, size, angle: 0 });

const T = 106;
/** 壁芯 (x0,y0)-(x1,y1) の壁の塗り（厚み 106） */
function wallPoly(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return x0 === x1
    ? rect(x0 - T / 2, Math.min(y0, y1) - T / 2, x0 + T / 2, Math.max(y0, y1) + T / 2)
    : rect(Math.min(x0, x1) - T / 2, y0 - T / 2, Math.max(x0, x1) + T / 2, y0 + T / 2);
}

const GRAY = '#808080';
const PINK = '#f5e1e1';

describe('壁の塗りの色の見分け（部屋の塗りを壁にしない）', () => {
  // 壁芯（検出した壁）: 4 本の壁で囲んだ 3640×455 の帯を 4 つの物入に割る
  const walls = [
    { a: P(0, 0), b: P(3640, 0), d: T },
    { a: P(0, 455), b: P(3640, 455), d: T },
    ...[0, 910, 1820, 2730, 3640].map((x) => ({ a: P(x, 0), b: P(x, 455), d: T })),
  ];
  const wallFills = walls.map((w) => ({ poly: wallPoly(w.a.x, w.a.y, w.b.x, w.b.y), color: GRAY }));
  // 収納の塗り: 奥行 455 の物入 4 つ＋ 2275 角のパントリー（頂点はすべて壁の上）
  const closetFills = [0, 910, 1820, 2730].map((x) => ({ poly: rect(x, 0, x + 910, 455), color: PINK }));

  it('塗りの太さ: 壁の塗りは厚みそのまま、半間の物入は 300mm 前後になる', () => {
    expect(fillWidth(wallPoly(0, 0, 3640, 0))).toBeGreaterThan(95);
    expect(fillWidth(wallPoly(0, 0, 3640, 0))).toBeLessThan(110);
    expect(Math.round(fillWidth(rect(0, 0, 910, 455)))).toBe(303);
    expect(Math.round(fillWidth(rect(0, 0, 2275, 2275)))).toBe(1138);
  });

  it('奥行 455mm の収納を塗った色は、頂点がすべて壁の上にあっても壁の色にしない（田中様邸）', () => {
    const colors = wallFillColors([...wallFills, ...closetFills, { poly: rect(0, 455, 2275, 2730), color: PINK }], walls);
    expect(colors.has(GRAY)).toBe(true);
    expect(colors.has(PINK)).toBe(false);
  });

  it('室名の入った塗りが 1 つでもある色は壁の色にしない（細い塗りが多くても）', () => {
    // 腰壁と同じ色で塗った畳コーナー: 細い帯 6 本＋部屋の塗り 1 つ
    const strips = [0, 1, 2, 3, 4, 5].map((i) => ({ poly: wallPoly(i * 600, 0, i * 600 + 500, 0), color: '#c5a885' }));
    const room = { poly: rect(0, 0, 2730, 2730), color: '#c5a885' };
    const stripWalls = [{ a: P(0, 0), b: P(3640, 0), d: T }, { a: P(0, 0), b: P(0, 2730), d: T }, { a: P(2730, 0), b: P(2730, 2730), d: T }, { a: P(0, 2730), b: P(2730, 2730), d: T }];
    expect(wallFillColors([...strips, room], stripWalls).has('#c5a885')).toBe(true);
    expect(wallFillColors([...strips, room], stripWalls, [P(1300, 1300)]).has('#c5a885')).toBe(false);
  });

  it('柱の塗り（285 角）だけの色は壁の色のまま', () => {
    const cols = [0, 910, 1820, 2730, 3640].map((x) => ({ poly: rect(x - 142, -142, x + 142, 142), color: '#ff7100' }));
    const big = [{ a: P(0, 0), b: P(3640, 0), d: 284 }];
    expect(wallFillColors(cols, big).has('#ff7100')).toBe(true);
  });
});

/**
 * カラー平面図（ARCHITREND 風）: 壁は灰色の塗り、収納は桃色の塗り。
 * 9100×5460 の家に、パントリー 2275 角・半間の物入 3 つ・名前の無い半間の箱・LDK・洋室
 */
function colorPlanPage(): PageMm {
  const O = 5000;
  const W = (x0: number, y0: number, x1: number, y1: number) => wallPoly(O + x0, O + y0, O + x1, O + y1);
  const F = (x0: number, y0: number, x1: number, y1: number) => rect(O + x0, O + y0, O + x1, O + y1);
  const walls = [
    W(0, 0, 9100, 0), W(0, 5460, 9100, 5460), W(0, 0, 0, 5460), W(9100, 0, 9100, 5460),
    // パントリー（左上）
    W(2275, 0, 2275, 2275), W(0, 2275, 2275, 2275),
    // 上の壁沿いの物入 3 つ
    W(2275, 455, 5005, 455), W(3185, 0, 3185, 455), W(4095, 0, 4095, 455), W(5005, 0, 5005, 455),
    // LDK と洋室の間
    W(6370, 0, 6370, 5460),
    // 洋室の隅の、名前の無い半間の箱
    W(8190, 5005, 9100, 5005), W(8190, 5005, 8190, 5460),
  ];
  const colorFills = [
    ...walls.map((poly) => ({ poly, color: GRAY })),
    { poly: F(0, 0, 2275, 2275), color: PINK },
    { poly: F(2275, 0, 3185, 455), color: PINK },
    { poly: F(3185, 0, 4095, 455), color: PINK },
    { poly: F(4095, 0, 5005, 455), color: PINK },
    { poly: F(8190, 5005, 9100, 5460), color: PINK },
  ];
  // 用紙の隅の線（図がページ全体を占めると図面枠として除かれる）
  const segs = [...walls.flatMap(fillSegs), stroke(0, 0, 500, 0), stroke(29000, 20500, 29700, 20500), stroke(29700, 20000, 29700, 21000)];
  const texts = [
    text('パントリー', O + 1100, O + 1100),
    text('物入', O + 2730, O + 230, 200),
    text('物入', O + 3640, O + 230, 200),
    text('物入', O + 4550, O + 230, 200),
    text('ＬＤＫ', O + 3500, O + 3500),
    text('（14.0帖）', O + 3500, O + 3900, 250),
    text('洋室', O + 7700, O + 3000),
    text('（8.0帖）', O + 7700, O + 3400, 250),
    text('1 階', O + 3000, O + 6500, 398),
    text('平 面 図', O + 4450, O + 6500, 398),
  ];
  return { pageIndex: 0, segs, arcs: [], texts, fills: [], masks: [], colorFills };
}

describe('収納を色で塗った平面図の読み取り', () => {
  it('収納の塗りは壁として塗らず、室名の入った塗りは部屋の区切りに使う', () => {
    const plans = detectPlans([colorPlanPage()], []);
    expect(plans.length).toBe(1);
    // 壁の塗りは灰色の 13 枚だけ（桃色の 5 枚は入らない）
    expect(plans[0].wallPolys.length).toBe(13);
    // 室名の入った桃色の塗り（0.6㎡ 以上）= パントリー
    expect(plans[0].roomFills.length).toBe(1);
  });

  it('パントリーと半間の物入が部屋になる（壁として塗りつぶされない）', () => {
    const warnings: string[] = [];
    const m = assembleModel([colorPlanPage()], 'テスト', warnings);
    const rooms = m.floors[0].rooms;
    const pantry = rooms.find((r) => r.name === 'パントリー');
    expect(pantry).toBeTruthy();
    expect(pantry!.type).toBe('storage');
    expect(pantry!.area).toBeGreaterThan(4.9);
    expect(pantry!.area).toBeLessThan(5.4);
    // 半間の物入（910×455。内法は 0.26㎡ ほど）も、名前があれば部屋にする
    const closets = rooms.filter((r) => r.name === '物入');
    expect(closets.length).toBe(3);
    for (const c of closets) {
      expect(c.area).toBeGreaterThan(0.35);
      expect(c.area).toBeLessThan(0.48);
    }
    // 名前の無い半間の箱は部屋にしない（壁のすき間・線の重なりと見分けがつかない）
    expect(rooms.length).toBe(6);
    expect(rooms.find((r) => r.type === 'ldk')).toBeTruthy();
    expect(rooms.find((r) => r.type === 'bedroom')).toBeTruthy();
  });
});
