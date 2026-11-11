// 壁を塗りで描き、開口を白抜きで描く図面（ARCHITREND のカラー・グレーの平面図）:
// 壁の塗りが続いていて白抜きの無い所にある平行線は、窓・引戸ではなく壁の中を通る線（土間のタイルの見切り・壁芯の線）。
// 林様邸 1 階: 玄関と土間収納の間の柱と壁 52cm が「引戸」、土間収納の外壁 1.8m が「窓」。
// 吉田大仁様邸 1 階: LDK と玄関の間の壁 1.1m が「引戸」。坂井様邸・伊藤様邸: 外壁に 6m・2.8m の「窓」
import { afterEach, describe, expect, it } from 'vitest';
import { buildFloor, detectPlans, type MmText, type PageMm } from '../src/parser/assemble';
import { detectWalls, type Seg } from '../src/parser/walls';
import type { Vec2 } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const fillSegs = (poly: Vec2[], color: string): Seg[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length], width: 0, dashed: false, source: 'fill' as const, color }));
const stroke = (x0: number, y0: number, x1: number, y1: number, width = 0.18): Seg => ({ a: P(x0, y0), b: P(x1, y1), width, dashed: false, source: 'stroke' });
const text = (str: string, x: number, y: number, size = 300): MmText => ({ str, x, y, size, angle: 0 });

const GRAY = '#808080';
const BEIGE = '#eedbbb';
const T = 106;
const H = T / 2;
const O = 5000;
const g = globalThis as { __NO_FILLWALL?: boolean };
afterEach(() => {
  delete g.__NO_FILLWALL;
});

/** 壁の塗り（壁芯 (x0,y0)-(x1,y1)、厚み T の灰色の長方形） */
const wallPoly = (x0: number, y0: number, x1: number, y1: number): Vec2[] =>
  x0 === x1 ? rect(O + x0 - H, O + Math.min(y0, y1) - H, O + x0 + H, O + Math.max(y0, y1) + H) : rect(O + Math.min(x0, x1) - H, O + y0 - H, O + Math.max(x0, x1) + H, O + y0 + H);
/** 横の壁（壁芯 y）の x0〜x1 の開口: 白抜きと、引違いの 2 本の線 */
const hOpening = (y: number, x0: number, x1: number): { mask: Vec2[]; segs: Seg[] } => {
  const m = (x0 + x1) / 2;
  return {
    mask: rect(O + x0, O + y - H, O + x1, O + y + H),
    segs: [stroke(O + x0, O + y - 15, O + m + 40, O + y - 15, 0.36), stroke(O + m - 40, O + y + 15, O + x1, O + y + 15, 0.36)],
  };
};
const vOpening = (x: number, y0: number, y1: number): { mask: Vec2[]; segs: Seg[] } => {
  const m = (y0 + y1) / 2;
  return {
    mask: rect(O + x - H, O + y0, O + x + H, O + y1),
    segs: [stroke(O + x - 15, O + y0, O + x - 15, O + m + 40, 0.36), stroke(O + x + 15, O + m - 40, O + x + 15, O + y1, 0.36)],
  };
};

/**
 * 7,280 × 5,460 の家。壁は灰色の塗り。窓 4 か所と室内の戸 1 か所は、塗りの上に白抜き＋引違いの線。
 * 真ん中の壁（y = 2,730）には、白抜きの無い所に「土間のタイルの見切り」（上の面から 21mm 内側）と壁芯の線が通る。
 * 右の外壁（x = 7,280）にも、位置の違う 2 本の線が白抜きなしで通る
 */
function drawing(): { segs: Seg[]; masks: Vec2[][]; walls: Vec2[][] } {
  const walls = [
    wallPoly(0, 0, 7280, 0), wallPoly(0, 5460, 7280, 5460), wallPoly(0, 0, 0, 5460), wallPoly(7280, 0, 7280, 5460), wallPoly(0, 2730, 7280, 2730),
    // 開口の無い間仕切り（壁の中の線が多すぎると「芯線表記の図面」とみなされて別の経路になるので、実際の図面の割合に合わせる）
    wallPoly(1820, 0, 1820, 2730), wallPoly(3640, 2730, 3640, 5460), wallPoly(5460, 0, 5460, 2730), wallPoly(0, 4095, 3640, 4095),
  ];
  const ops = [hOpening(0, 910, 2600), hOpening(0, 3640, 5330), hOpening(5460, 910, 3510), vOpening(0, 910, 2145), hOpening(2730, 4550, 5370)];
  const segs: Seg[] = [
    ...walls.flatMap((p) => fillSegs(p, GRAY)),
    ...ops.flatMap((o) => o.segs),
    // 真ん中の壁: タイルの見切り（x = 1,820〜4,550）と、戸の先の壁芯の線（x = 5,370〜7,280）
    stroke(O + 1820, O + 2730 - 32, O + 4550, O + 2730 - 32, 0.12),
    stroke(O + 5370, O + 2730, O + 7280, O + 2730, 0.12),
    // 右の外壁: 内側から 23mm の線（y = 910〜2,000）と壁芯の線（y = 1,900〜3,000）
    stroke(O + 7280 - 30, O + 910, O + 7280 - 30, O + 2000, 0.12),
    stroke(O + 7280, O + 1900, O + 7280, O + 3000, 0.12),
  ];
  return { segs, masks: ops.map((o) => o.mask), walls };
}

/** 横の壁（壁芯 y）の上の開口（区間の長さの合計）と壁片（同） */
const onH = (det: ReturnType<typeof detectWalls>, y: number) => {
  const isH = (gi: number) => Math.abs(det.groups[gi].u.x) > 0.9;
  const ops = det.openings.filter((o) => isH(o.g) && Math.abs(Math.abs(o.o) - (O + y)) < 20);
  const pcs = det.pieces.filter((p) => isH(p.g) && Math.abs(Math.abs(p.o) - (O + y)) < 20);
  return { ops, opLen: ops.reduce((s, o) => s + (o.t1 - o.t0), 0), pieceLen: pcs.reduce((s, p) => s + (p.t1 - p.t0), 0) };
};
const onV = (det: ReturnType<typeof detectWalls>, x: number) => {
  const isV = (gi: number) => Math.abs(det.groups[gi].u.y) > 0.9;
  const ops = det.openings.filter((o) => isV(o.g) && Math.abs(Math.abs(o.o) - (O + x)) < 20);
  return { ops, opLen: ops.reduce((s, o) => s + (o.t1 - o.t0), 0) };
};

describe('壁の塗りが続いていて白抜きの無い所の平行線', () => {
  it('窓・引戸にしない（白抜きの所だけが開口）', () => {
    const d = drawing();
    const det = detectWalls(d.segs, [], {}, d.masks);
    // 真ん中の壁: 開口は白抜きの戸（820mm）だけ。残りは壁
    const mid = onH(det, 2730);
    expect(mid.ops).toHaveLength(1);
    expect(Math.round(mid.ops[0].t1 - mid.ops[0].t0)).toBe(820);
    expect(mid.pieceLen).toBeGreaterThan(7280 - 820 - 50);
    // 右の外壁: 開口なし
    expect(onV(det, 7280).ops).toHaveLength(0);
    // 白抜きの窓は、白抜きの幅どおり
    const top = onH(det, 0);
    expect(top.ops.map((o) => Math.round(o.t1 - o.t0)).sort()).toEqual([1690, 1690]);
    expect(Math.round(onH(det, 5460).opLen)).toBe(2600);
    expect(Math.round(onV(det, 0).opLen)).toBe(1235);
  });

  it('この判定を切ると、見切りの線・壁芯の線の所が開口になる（直す前の読み違い）', () => {
    const d = drawing();
    g.__NO_FILLWALL = true;
    const det = detectWalls(d.segs, [], {}, d.masks);
    expect(onH(det, 2730).opLen).toBeGreaterThan(2500);
    expect(onV(det, 7280).opLen).toBeGreaterThan(1500);
  });

  it('白抜きを使わない図面（開口を塗りの切れ目で描く）では働かない', () => {
    // 白抜きなし。壁の塗りの上に引違いの線だけの「窓」が 2 か所（塗りの上にサッシを描く図面）
    const walls = [wallPoly(0, 0, 7280, 0), wallPoly(0, 5460, 7280, 5460), wallPoly(0, 0, 0, 5460), wallPoly(7280, 0, 7280, 5460)];
    const segs: Seg[] = [...walls.flatMap((p) => fillSegs(p, GRAY)), ...hOpening(0, 910, 2600).segs, ...hOpening(5460, 910, 3510).segs];
    const a = detectWalls(segs, [], {}, []);
    g.__NO_FILLWALL = true;
    const b = detectWalls(segs, [], {}, []);
    expect(onH(a, 0).opLen).toBeGreaterThan(1500);
    expect(Math.round(onH(a, 0).opLen)).toBe(Math.round(onH(b, 0).opLen));
    expect(Math.round(onH(a, 5460).opLen)).toBe(Math.round(onH(b, 5460).opLen));
  });

  it('階段の色の塗り（手すり壁の帯）は「壁の塗り」に数えない: 帯の中の線の扱いは変えない', () => {
    // 林様邸 2 階: 階段の中の手すり壁（階段の色の 119mm の帯）が壁になり、階段が途中で切れた
    const d = drawing();
    const band = rect(O + 5000, O + 3300, O + 5119, O + 4300);
    const segs: Seg[] = [...d.segs, ...fillSegs(band, BEIGE), stroke(O + 5040, O + 3300, O + 5040, O + 3900, 0.36), stroke(O + 5080, O + 3700, O + 5080, O + 4300, 0.36)];
    const a = detectWalls(segs, [], {}, d.masks);
    g.__NO_FILLWALL = true;
    const b = detectWalls(segs, [], {}, d.masks);
    const pieceLenAt = (det: ReturnType<typeof detectWalls>) =>
      det.pieces.filter((p) => Math.abs(det.groups[p.g].u.y) > 0.9 && Math.abs(Math.abs(p.o) - (O + 5060)) < 30).reduce((s, p) => s + (p.t1 - p.t0), 0);
    // 帯の中の線の区間は、切っても切らなくても壁片にならない（開口の候補のまま）
    expect(Math.round(pieceLenAt(b))).toBe(0);
    expect(Math.round(pieceLenAt(a))).toBe(0);
  });
});

describe('印を使う図面で、印が無く細い線だけが根拠の「引戸」', () => {
  const seg = (ax: number, ay: number, bx: number, by: number): Seg => ({ a: P(ax, ay), b: P(bx, by), width: 0.36, dashed: false, source: 'stroke' });
  const circle = (cx: number, cy: number, r = 12.5, n = 20): Seg[] => {
    const out: Seg[] = [];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      out.push(seg(cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1)));
    }
    return out;
  };
  /** 通り口の印（縦・横）: 両端に丸の付いた 404mm の線 */
  const vMark = (x: number, y: number): Seg[] => [seg(O + x, O + y - 202, O + x, O + y + 202), ...circle(O + x, O + y - 202 - 29.5), ...circle(O + x, O + y + 202 + 29.5)];
  const hMark = (x: number, y: number): Seg[] => [seg(O + x - 202, O + y, O + x + 202, O + y), ...circle(O + x - 202 - 29.5, O + y), ...circle(O + x + 202 + 29.5, O + y)];

  /**
   * 左に洋室、右に LDK。その間に土間収納（幅 1,820）。土間収納の両側の壁の柱（y = 1,365）の間に、
   * タイルの目地（柱の芯から 10mm）と棚の線が通る（池本様邸 1 階の土間収納: 「通路」と「土間収納」の間に 1.7m の引戸ができていた）。
   * 柱より上の区画は奥行 1.26m（奥行 80cm 以下の細い帯は、別の規則で隣の部屋に戻る）
   */
  function page(): PageMm {
    const walls = [
      wallPoly(0, 0, 9100, 0), wallPoly(0, 5460, 9100, 5460), wallPoly(0, 0, 0, 5460), wallPoly(9100, 0, 9100, 5460),
      wallPoly(3640, 0, 3640, 5460), wallPoly(5460, 0, 5460, 5460),
      // 柱（壁厚の正方形）
      rect(O + 3640 - H, O + 1365 - H, O + 3640 + H, O + 1365 + H), rect(O + 5460 - H, O + 1365 - H, O + 5460 + H, O + 1365 + H),
    ];
    // 印のある建具 4 か所（白抜き＋引違いの線＋通り口の印）: 洋室｜土間収納、土間収納｜LDK の戸と、洋室・LDK の掃き出し窓
    const doors = [vOpening(3640, 3000, 3820), vOpening(5460, 3000, 3820), hOpening(5460, 1000, 2690), hOpening(5460, 6400, 8090)];
    const segs: Seg[] = [
      ...walls.flatMap((p) => fillSegs(p, GRAY)),
      ...doors.flatMap((o) => o.segs),
      ...hMark(3640, 3410), ...hMark(5460, 3410), ...vMark(1845, 5460), ...vMark(7245, 5460),
      // 柱と柱の間: タイルの目地と棚の線
      stroke(O + 3640 + H, O + 1355, O + 5460 - H, O + 1355, 0.12),
      stroke(O + 5100, O + 1366, O + 5460 - H, O + 1366, 0.18),
      // 用紙の隅の線（図がページ全体を占めると図面枠として除かれる）
      stroke(0, 0, 500, 0), stroke(29000, 20500, 29700, 20500), stroke(29700, 20000, 29700, 21000),
    ];
    const texts = [
      text('洋室', O + 1820, O + 2500),
      text('（12.0帖）', O + 1820, O + 2900, 250),
      text('土間収納', O + 4550, O + 3200, 250),
      text('ＬＤＫ', O + 7280, O + 2500),
      text('（12.0帖）', O + 7280, O + 2900, 250),
      text('1 階', O + 3000, O + 6500, 398),
      text('平 面 図', O + 4450, O + 6500, 398),
    ];
    return { pageIndex: 0, segs, arcs: [], texts, fills: [], masks: doors.map((o) => o.mask), colorFills: walls.map((poly) => ({ poly, color: GRAY })) };
  }

  it('室名の無い区画との間でも、戸ではなく建具なしの開口にする', () => {
    const plans = detectPlans([page()], []);
    expect(plans.length).toBe(1);
    const f = buildFloor(plans[0], 1, 0, []);
    // 柱と柱の間（y = 1,365、x = 3,640〜5,460）の開口（buildFloor の座標は図面のまま = O だけずれている）
    const hits = f.openings.filter((o) => {
      const w = f.walls.find((q) => q.id === o.wallId)!;
      const horizontal = Math.abs(w.a.y - w.b.y) < 1;
      return horizontal && Math.abs(w.a.y - (O + 1365)) < 120 && Math.min(w.a.x, w.b.x) > O + 3400 && Math.max(w.a.x, w.b.x) < O + 5700;
    });
    expect(hits.some((o) => o.kind === 'sliding' || o.kind === 'door')).toBe(false);
    expect(hits.some((o) => o.kind === 'open')).toBe(true);
    // 印のある室内の戸 2 か所は引戸のまま
    expect(f.openings.filter((o) => o.kind === 'sliding').length).toBe(2);
  });
});
