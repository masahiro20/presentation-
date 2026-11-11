// 室内窓（部屋と部屋の間のガラス）と建具なしの開口:
// 印（通り口の印）を使い、開口を白抜きで描く図面では、印の無い白抜きの開口は人が通る建具ではない。
//  - 中に建具の線が 1〜2 本（FIX の芯の線・引違い）→ 室内窓
//  - 中に線が無い → 建具なしの開口
// 池本様邸 1 階の LDK と猫部屋の間のガラス・戸の両脇の FIX、2 階のホールと仕事部屋の間の引違いの窓、
// 大崎様邸のホールと畳コーナーの間が「引戸」に、林様邸の玄関と LDK の間（式台の所）も「引戸」になっていた
import { describe, expect, it } from 'vitest';
import { buildFloor, detectPlans, type MmText, type PageMm } from '../src/parser/assemble';
import { detectWalls, type Seg } from '../src/parser/walls';
import { applyOpeningKind, isSlidingWindow, openingLabel, openingSummary, setInteriorWindow } from '../src/core/openings';
import { suggestOptions } from '../src/estimate/suggest';
import { takeoff } from '../src/estimate/areas';
import { newChoice } from '../src/estimate/calc';
import { effectiveOpening, specById } from '../src/styles/spec';
import { woodCheck } from '../src/parser/woodCheck';
import { livingCheck } from '../src/parser/livingCheck';
import type { BuildingModel, Opening, Vec2 } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const GRAY = '#808080';
const T = 106;
const H = T / 2;
const O = 5000;
const fillSegs = (poly: Vec2[]): Seg[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length], width: 0, dashed: false, source: 'fill' as const, color: GRAY }));
const stroke = (x0: number, y0: number, x1: number, y1: number, width = 0.36): Seg => ({ a: P(O + x0, O + y0), b: P(O + x1, O + y1), width, dashed: false, source: 'stroke' });
const text = (str: string, x: number, y: number, size = 300): MmText => ({ str, x: O + x, y: O + y, size, angle: 0 });
const wallPoly = (x0: number, y0: number, x1: number, y1: number): Vec2[] =>
  x0 === x1 ? rect(O + x0 - H, O + Math.min(y0, y1) - H, O + x0 + H, O + Math.max(y0, y1) + H) : rect(O + Math.min(x0, x1) - H, O + y0 - H, O + Math.max(x0, x1) + H, O + y0 + H);
const circle = (cx: number, cy: number, r = 12.5, n = 20): Seg[] => {
  const out: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    out.push(stroke(cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1)));
  }
  return out;
};
/** 通り口の印（両端に丸の付いた 404mm の線）。縦の壁を横切る横向き・横の壁を横切る縦向き */
const hMark = (x: number, y: number): Seg[] => [stroke(x - 202, y, x + 202, y), ...circle(x - 202 - 29.5, y), ...circle(x + 202 + 29.5, y)];
const vMark = (x: number, y: number): Seg[] => [stroke(x, y - 202, x, y + 202), ...circle(x, y - 202 - 29.5), ...circle(x, y + 202 + 29.5)];
/** 縦の壁（壁芯 x）の y0〜y1 の白抜き */
const vMask = (x: number, y0: number, y1: number): Vec2[] => rect(O + x - H, O + y0, O + x + H, O + y1);
const hMask = (y: number, x0: number, x1: number): Vec2[] => rect(O + x0, O + y - H, O + x1, O + y + H);
/** 引違いの 2 本の線（縦の壁・横の壁） */
const vSliding = (x: number, y0: number, y1: number): Seg[] => [stroke(x - 15, y0, x - 15, (y0 + y1) / 2 + 40), stroke(x + 15, (y0 + y1) / 2 - 40, x + 15, y1)];
const hSliding = (y: number, x0: number, x1: number): Seg[] => [stroke(x0, y - 15, (x0 + x1) / 2 + 40, y - 15), stroke((x0 + x1) / 2 - 40, y + 15, x1, y + 15)];
/** FIX: 芯に 1 本 */
const vFix = (x: number, y0: number, y1: number): Seg[] => [stroke(x, y0, x, y1, 0.42)];

/**
 * 9,100 × 5,460。左上に物入、左下に洋室、真ん中にホール、右に LDK。
 *  洋室｜ホール・ホール｜LDK に印のある引戸、物入｜ホールに印の無い引違いの戸（収納の戸）、
 *  ホール｜LDK に印の無い FIX（芯の 1 本線）と、印も線も無い白抜きだけの開口。外壁に印のある掃き出し窓 2 つ
 */
function page(): PageMm {
  const walls = [
    wallPoly(0, 0, 9100, 0), wallPoly(0, 5460, 9100, 5460), wallPoly(0, 0, 0, 5460), wallPoly(9100, 0, 9100, 5460),
    wallPoly(3640, 0, 3640, 5460), wallPoly(5460, 0, 5460, 5460), wallPoly(0, 1365, 3640, 1365),
  ];
  const masks = [
    vMask(3640, 3000, 3820), vMask(5460, 3000, 3820), // 印のある引戸
    vMask(3640, 250, 1070), // 物入の戸（印なし）
    vMask(5460, 1000, 2690), // FIX（印なし）
    vMask(5460, 4200, 5000), // 白抜きだけ（印なし）
    hMask(5460, 1000, 2690), hMask(5460, 6400, 8090), // 掃き出し窓（印あり）
  ];
  const segs: Seg[] = [
    ...walls.flatMap(fillSegs),
    ...vSliding(3640, 3000, 3820), ...hMark(3640, 3410),
    ...vSliding(5460, 3000, 3820), ...hMark(5460, 3410),
    ...vSliding(3640, 250, 1070),
    ...vFix(5460, 1000, 2690),
    ...hSliding(5460, 1000, 2690), ...vMark(1845, 5460),
    ...hSliding(5460, 6400, 8090), ...vMark(7245, 5460),
    // 用紙の隅の線（図がページ全体を占めると図面枠として除かれる）
    { a: P(0, 0), b: P(500, 0), width: 0.2, dashed: false, source: 'stroke' },
    { a: P(29000, 20500), b: P(29700, 20500), width: 0.2, dashed: false, source: 'stroke' },
    { a: P(29700, 20000), b: P(29700, 21000), width: 0.2, dashed: false, source: 'stroke' },
  ];
  const texts = [
    text('物入', 1820, 700, 250),
    text('洋室', 1820, 3200),
    text('（9.0帖）', 1820, 3600, 250),
    text('ホール', 4550, 2000, 250),
    text('ＬＤＫ', 7280, 2500),
    text('（12.0帖）', 7280, 2900, 250),
    text('1 階', 3000, 6500, 398),
    text('平 面 図', 4450, 6500, 398),
  ];
  return { pageIndex: 0, segs, arcs: [], texts, fills: [], masks, colorFills: walls.map((poly) => ({ poly, color: GRAY })) };
}

/** 縦の壁（壁芯 x）の開口を、上からの順に */
const onWall = (f: ReturnType<typeof buildFloor>, x: number): Opening[] =>
  f.openings
    .filter((o) => {
      const w = f.walls.find((q) => q.id === o.wallId)!;
      return Math.abs(w.a.x - w.b.x) < 1 && Math.abs(w.a.x - (O + x)) < 80;
    })
    .map((o) => {
      const w = f.walls.find((q) => q.id === o.wallId)!;
      const y = Math.min(w.a.y, w.b.y) + (w.a.y <= w.b.y ? (o.t0 + o.t1) / 2 : Math.abs(w.b.y - w.a.y) - (o.t0 + o.t1) / 2);
      return { o, y };
    })
    .sort((a, b) => a.y - b.y)
    .map((q) => q.o);

describe('開口の中を通る線の数（壁の検出）', () => {
  it('白抜きだけ = 0、FIX = 1、引違い = 2。塗りの壁に開けた開口は端に壁の塗りが接している', () => {
    const pg = page();
    const det = detectWalls(pg.segs, [], {}, pg.masks);
    const at = (x: number, y: number) => det.openings.find((o) => Math.abs(det.groups[o.g].u.y) > 0.9 && Math.abs(Math.abs(o.o) - (O + x)) < 20 && o.t0 < O + y && o.t1 > O + y)!;
    expect(at(5460, 1800).inner).toBe(1);
    expect(at(5460, 4600).inner).toBe(0);
    expect(at(5460, 3400).inner).toBe(2);
    expect(at(5460, 1800).filledEnd).toBe(true);
    expect(det.maskStyle).toBe(true);
    expect(det.maskMissed).toEqual([]);
  });
});

describe('印の無い白抜きの開口（室内）', () => {
  const read = () => {
    const plans = detectPlans([page()], []);
    expect(plans.length).toBe(1);
    expect(plans[0].maskDrawn).toBe(true);
    return buildFloor(plans[0], 1, 0, []);
  };

  it('FIX の線がある開口は室内窓、線の無い開口は建具なし、印のある開口は引戸', () => {
    const f = read();
    const ops = onWall(f, 5460);
    expect(ops.map((o) => o.kind)).toEqual(['window', 'sliding', 'open']);
    const win = ops[0];
    expect(win.interior).toBe(true);
    expect(Math.round(win.t1 - win.t0)).toBe(1690);
    expect(win.sill).toBe(900);
    expect(win.height).toBe(1100);
    expect(ops[1].interior).toBeUndefined();
  });

  it('収納の前の開口は、印が無くても戸のまま（折れ戸の印は段の塗りに隠れることがある）', () => {
    const f = read();
    const ops = onWall(f, 3640);
    expect(ops.map((o) => o.kind)).toEqual(['sliding', 'sliding']);
  });

  it('切り替えを切ると、今までどおり引戸', () => {
    const g = globalThis as { __NO_INTERIOR_WINDOWS?: boolean };
    g.__NO_INTERIOR_WINDOWS = true;
    try {
      expect(onWall(read(), 5460).map((o) => o.kind)).toEqual(['sliding', 'sliding', 'sliding']);
    } finally {
      delete g.__NO_INTERIOR_WINDOWS;
    }
  });
});

describe('室内窓の扱い', () => {
  const win = (extra: Partial<Opening> = {}): Opening => ({ id: 'o1', wallId: 'w1', kind: 'window', t0: 1000, t1: 2690, sill: 900, height: 1100, windowStyle: 'koshi', ...extra });

  it('仕様の「サッシ上端＝天井」でそろえ直さない（外の窓はそろえる）', () => {
    const spec = { ...specById(undefined), windows: { ...specById(undefined).windows, headAtCeiling: true } };
    expect(effectiveOpening(win({ interior: true }), 2400, spec)).toEqual({ sill: 900, height: 1100 });
    expect(effectiveOpening(win(), 2400, spec)).toEqual({ sill: 900, height: 1500 });
  });

  it('種類を戸に変えたら室内窓の印は外れる。一覧では「室内窓」と出る', () => {
    const o = win({ interior: true });
    expect(openingSummary(o)).toMatch(/室内窓/);
    applyOpeningKind(o, 'sliding', 2400);
    expect(o.interior).toBeUndefined();
    expect(o.sill).toBe(0);
  });

  it('手で切り替えられる: 室内窓にすると FIX（引違いにしない）・名前は「室内窓」、外すと普通の窓に戻る', () => {
    const o = win({ heightFrom: 'elevation' });
    expect(isSlidingWindow(o)).toBe(true);
    setInteriorWindow(o, true);
    expect(o.interior).toBe(true);
    // 立面図から決めた高さの印は外す（室内窓は立面図に出ない）
    expect(o.heightFrom).toBeUndefined();
    expect(isSlidingWindow(o)).toBe(false);
    expect(openingLabel(o)).toBe('室内窓');
    setInteriorWindow(o, false);
    expect(o.interior).toBeUndefined();
    expect(openingLabel(o)).toBe('窓');
    // 戸には付かない
    const d: Opening = { id: 'd', wallId: 'w1', kind: 'sliding', t0: 0, t1: 1640, sill: 0, height: 2000 };
    setInteriorWindow(d, true);
    expect(d.interior).toBeUndefined();
  });

  it('見積: 室内窓は室内建具の数に入れず、「別途」の注意として出す', () => {
    const o = rect(0, 0, 7280, 3640);
    const model = {
      floors: [
        {
          level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, outline: [o],
          rooms: [{ id: 'r1', name: 'ＬＤＫ', type: 'ldk', polygon: rect(0, 0, 3640, 3640), area: 13.2 }, { id: 'r2', name: 'ホール', type: 'hall', polygon: rect(3640, 0, 7280, 3640), area: 13.2 }],
          walls: [{ id: 'w1', a: P(3640, 0), b: P(3640, 3640), thickness: 90, exterior: false }],
          openings: [win({ interior: true })],
          stairs: [],
        },
      ],
    } as unknown as BuildingModel;
    const areas = takeoff(model, { grade: 'P', eavesMm: 0, pitch: 0.5, roofType: 'flat' });
    const sg = suggestOptions(model, areas, newChoice('P')).find((x) => /^室内窓/.test(x.label));
    expect(sg?.label).toBe('室内窓 1 か所');
    expect(sg?.separate).toBe(true);
    expect(sg?.applied).toBe(false);
    expect(sg?.reason).toMatch(/W1,690/);
    // 室内窓が無ければ出ない
    model.floors[0].openings = [win()];
    expect(suggestOptions(model, areas, newChoice('P')).some((x) => /^室内窓/.test(x.label))).toBe(false);
  });

  it('採光の窓には数えず、「部屋と部屋の間の壁に窓」とも言わない', () => {
    // 洋室（左）とホール（右）の間の壁に室内窓だけがある（外壁に窓なし）
    const room = (id: string, name: string, type: 'bedroom' | 'hall', x0: number, x1: number) => ({ id, name, type, polygon: rect(x0, 0, x1, 3640), labelPos: P((x0 + x1) / 2, 1820), area: ((x1 - x0) * 3640) / 1e6 });
    const ext = (id: string, a: Vec2, b: Vec2) => ({ id, a, b, thickness: 150, exterior: true, outsideSign: 1 as const });
    const o = rect(0, 0, 7280, 3640);
    const model = {
      name: 't',
      northAngleDeg: 0,
      floors: [
        {
          level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, outline: [o],
          rooms: [room('r1', '洋室', 'bedroom', 0, 3640), room('r2', 'ホール', 'hall', 3640, 7280)],
          walls: [ext('n', o[0], o[1]), ext('e', o[1], o[2]), ext('s', o[2], o[3]), ext('w', o[3], o[0]), { id: 'w1', a: P(3640, 0), b: P(3640, 3640), thickness: 90, exterior: false }],
          openings: [win({ interior: true })],
          stairs: [],
        },
      ],
      report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} },
    } as unknown as BuildingModel;
    // 室内窓だけの洋室は「窓の無い居室」のまま
    expect(woodCheck(model).some((i) => /^nowin-1-r1/.test(i.id))).toBe(true);
    expect(livingCheck(model).some((i) => /^live-winin-/.test(i.id))).toBe(false);
    // 印の無い（手で置いた）窓なら、部屋と部屋の間の窓として知らせる
    model.floors[0].openings = [win()];
    expect(livingCheck(model).some((i) => /^live-winin-/.test(i.id))).toBe(true);
  });
});
