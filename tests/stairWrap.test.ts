// コの字階段（3 方回り）と回り段（core/stairs.ts の段割り、parser/stairs.ts の見分け）
//  御社の図面のコの字階段: 1.5 間 × 1 間の階段室を、幅 910 の列が 左 4 段 → 角（斜めの線 = 回り段 2 段）→ 奥 4 段 → 角 → 右 4 段と回る（計 16 段）
import { describe, expect, it } from 'vitest';
import { cornerStepsOf, effectiveStepCount, stairDrawing, stairLayout, stairTreadDepth, wrapFlights } from '../src/core/stairs';
import { cornerSquares, wrapShape, type StairRunBox } from '../src/parser/stairs';
import { roomsUnderStairs, treesInStairWells } from '../src/parser/assemble';
import type { Seg } from '../src/parser/walls';
import type { Floor, FurnitureItem, Room, Stair, Vec2 } from '../src/core/types';

const seg = (a: Vec2, b: Vec2): Seg => ({ a, b, width: 0.12, dashed: false, source: 'stroke' });
/** 2,730 × 1,820 の階段室。昇り口は南（下）の左、右回り */
const wrap = (o: Partial<Stair> = {}): Stair => ({ id: 's', minX: 0, minY: 0, maxX: 2730, maxY: 1820, kind: 'uOpen', entry: 's', turn: 'right', goesUp: true, treadPitch: 227.5, midRun: 906, cornerSteps: 2, ...o });
const polyArea = (p: Vec2[]) => Math.abs(p.reduce((a, q, i) => a + q.x * p[(i + 1) % p.length].y - p[(i + 1) % p.length].x * q.y, 0)) / 2;

describe('コの字階段（3 方回り）の段割り', () => {
  it('列の幅は（階段の幅 − 奥の列）÷ 2。脇の列 910・奥の列 910', () => {
    const w = wrapFlights(wrap())!;
    expect(w.fw).toBeCloseTo(910, -1);
    expect(w.len1).toBeCloseTo(910, -1);
    expect(w.len2).toBeCloseTo(910, -1);
    // 奥の列の長さが分からなければ列の幅 910
    expect(wrapFlights(wrap({ midRun: undefined }))!.fw).toBe(910);
    // 幅が足りない（奥の列を 400 取れない）コの字は 3 方回りにしない
    expect(wrapFlights(wrap({ maxX: 2100, midRun: undefined }))).toBeNull();
    // 折り返し・直階段・かね折れは対象外
    expect(wrapFlights(wrap({ kind: 'u' }))).toBeNull();
  });

  it('図面の段の間隔から 16 段: 左 4 → 回り段 2 → 奥 4 → 回り段 2 → 右 4', () => {
    const s = wrap();
    const n = effectiveStepCount(2900, s);
    expect(n).toBe(16);
    const lay = stairLayout(s, n);
    expect(lay.n).toBe(16);
    expect(lay.pieces.map((p) => p.kind[0]).join('')).toBe('ttttwwttttwwtttt');
    expect(lay.pieces.map((p) => p.i)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    // 最初の段は左（西）の列の手前（南）、北へ昇る。幅 910
    const first = lay.pieces[0];
    expect(first.minX).toBeCloseTo(0, 0);
    expect(first.maxX).toBeCloseTo(910, -1);
    expect(first.maxY).toBeCloseTo(1820, 0);
    expect(first.dir).toEqual({ x: 0, y: -1 });
    // 奥の列は東へ、最後の列は右（東）の列を南へ降りてくる向きに昇る。最後の段は手前（南）の端
    expect(lay.pieces[7].dir).toEqual({ x: 1, y: 0 });
    const last = lay.pieces[15];
    expect(last.dir).toEqual({ x: 0, y: 1 });
    expect(last.minX).toBeCloseTo(1820, -1);
    expect(last.maxY).toBeCloseTo(1820, 0);
    // 踏面は図面どおり 227.5
    expect(stairTreadDepth(s, n)).toBeCloseTo(227.5, 0);
    // 中央は吹抜（左の列と右の列の間、奥の列の手前）
    expect(lay.well).toBeTruthy();
    expect(lay.well!.minX).toBeCloseTo(910, -1);
    expect(lay.well!.maxX).toBeCloseTo(1820, -1);
    expect(lay.well!.minY).toBeCloseTo(910, -1);
    expect(lay.well!.maxY).toBeCloseTo(1820, 0);
    expect(lay.wall).toBeUndefined();
  });

  it('回り段は角の升を軸（吹抜側の角）から割った三角形。重ならず、角の升をちょうど埋める', () => {
    const lay = stairLayout(wrap(), 16);
    const winders = lay.pieces.filter((p) => p.kind === 'winder');
    expect(winders.length).toBe(4);
    // 左上の角の 2 枚: 軸は (910, 910)。面積の合計 = 升 910 × 910
    const a = winders.slice(0, 2);
    for (const w of a) {
      expect(w.poly![0].x).toBeCloseTo(910, -1);
      expect(w.poly![0].y).toBeCloseTo(910, -1);
      expect(w.maxX).toBeLessThanOrEqual(911);
      expect(w.maxY).toBeLessThanOrEqual(911);
    }
    expect(polyArea(a[0].poly!) + polyArea(a[1].poly!)).toBeCloseTo(910 * 910, -4);
    // 全部の段の面積 = 階段室 − 吹抜
    const total = lay.pieces.reduce((sum, p) => sum + (p.poly ? polyArea(p.poly) : (p.maxX - p.minX) * (p.maxY - p.minY)), 0);
    expect(total).toBeCloseTo(2730 * 1820 - 910 * 910, -4);
  });

  it('角の割り方: 踊り場（1 段）なら 14 段、3 段回りなら 18 段', () => {
    const land = wrap({ cornerSteps: undefined });
    expect(cornerStepsOf(land)).toBe(1);
    expect(effectiveStepCount(2900, land)).toBe(14);
    expect(stairLayout(land, 14).pieces.map((p) => p.kind[0]).join('')).toBe('ttttlttttltttt');
    const three = wrap({ cornerSteps: 3 });
    expect(effectiveStepCount(2900, three)).toBe(18);
    const lay = stairLayout(three, 18);
    expect(lay.pieces.filter((p) => p.kind === 'winder').length).toBe(6);
    // 3 段回りの真ん中の段は四角形（軸・2 本の放射の線・壁の角）
    expect(lay.pieces[5].poly!.length).toBe(4);
  });

  it('左回り（最初の列が右）でも同じ形の左右反転', () => {
    const lay = stairLayout(wrap({ turn: 'left' }), 16);
    expect(lay.pieces[0].minX).toBeCloseTo(1820, -1);
    expect(lay.pieces[7].dir).toEqual({ x: -1, y: 0 });
    expect(lay.pieces[15].maxX).toBeCloseTo(910, -1);
  });

  it('脇の列を取れない奥行（壁沿いの長い列の両端の角で直角に出入り）: 角 → 列 → 角。吹抜は無い', () => {
    // 4,550 × 910。昇り口は北、最初の角は西の端
    const s: Stair = { id: 's', minX: 0, minY: 0, maxX: 4550, maxY: 910, kind: 'uOpen', entry: 'n', turn: 'left', goesUp: true, treadPitch: 227.4, midRun: 2728, cornerSteps: 2 };
    const w = wrapFlights(s)!;
    expect(w.len1).toBe(0);
    expect(w.fw).toBeCloseTo(910, -1);
    const n = effectiveStepCount(2900, s);
    expect(n).toBe(16);
    const lay = stairLayout(s, n);
    expect(lay.pieces.map((p) => p.kind[0]).join('')).toBe('wwttttttttttttww');
    expect(lay.well).toBeUndefined();
    // 最初の回り段は西の端の升、上がる縁は北の辺（昇り口の側）
    const first = lay.pieces[0];
    expect(first.maxX).toBeLessThanOrEqual(911);
    expect(first.poly![0].y).toBeCloseTo(0, 0);
    expect(first.poly![1].y).toBeCloseTo(0, 0);
    // 列は東へ
    expect(lay.pieces[2].dir).toEqual({ x: 1, y: 0 });
  });

  it('平面図: 回り段の放射の線が段鼻の線として出る', () => {
    const dr = stairDrawing(wrap(), 2900, { cut: false });
    // 斜めの線（軸 (910,910) → 壁の角 (0,0)）
    const diag = dr.risers.filter((r) => Math.abs(Math.abs(r.b.x - r.a.x) - Math.abs(r.b.y - r.a.y)) < 5 && Math.abs(r.b.x - r.a.x) > 800);
    expect(diag.length).toBe(2);
    expect(dr.label.text).toBe('UP 16');
  });

  it('平面図: 歩行線は列の中心線をたどり、回り段の角は 1/4 円で回る（段の重心を結んでふくらませない）', () => {
    const dr = stairDrawing(wrap(), 2900, { cut: false });
    // 昇り口は左（西）の列の最初の段の中央。角は 2 つとも円弧
    expect(dr.start.x).toBeCloseTo(455, -1);
    expect(dr.walkPath.match(/A/g)?.length).toBe(2);
    // 線の上の点はどれも、列の中心線（x = 455・y = 455・x = 2,275）から外へ出ない
    const nums = dr.walkPath.replace(/A[\d.]+ [\d.]+ 0 0 [01]/g, 'L').match(/-?\d+ -?\d+/g)!.map((t) => t.split(' ').map(Number));
    for (const [x, y] of nums) {
      expect(x).toBeGreaterThanOrEqual(454);
      expect(x).toBeLessThanOrEqual(2276);
      expect(y).toBeGreaterThanOrEqual(454);
    }
    // 矢じりは右（東）の列の中心線の上で、南を向く
    expect(dr.arrow[0].x).toBeCloseTo(2275, -1);
    expect(dr.arrow[0].y).toBeGreaterThan(1500);
  });

  it('平面図: 回り段で始まり回り段で終わる階段は、角の升に入る縁の中央に○、出る縁の手前に矢じり', () => {
    const s: Stair = { id: 's', minX: 0, minY: 0, maxX: 4550, maxY: 910, kind: 'uOpen', entry: 'n', turn: 'left', goesUp: true, treadPitch: 227.4, midRun: 2728, cornerSteps: 2 };
    const dr = stairDrawing(s, 2900, { cut: false });
    // ○ は西の升の北の辺の中央、矢じりは東の升の北の辺の手前で北を向く
    expect(dr.start.x).toBeCloseTo(455, -1);
    expect(dr.start.y).toBeCloseTo(0, 0);
    expect(dr.arrow[0].x).toBeCloseTo(4095, -1);
    expect(dr.arrow[0].y).toBeCloseTo(20, 0);
    expect(dr.arrow[1].y).toBeGreaterThan(dr.arrow[0].y);
    expect(dr.walkPath.match(/A/g)?.length).toBe(2);
    // UP と段数は升の中（壁の外へ出ない）
    expect(dr.label.x).toBeGreaterThan(100);
    expect(dr.label.x).toBeLessThan(810);
    expect(dr.label.y).toBeGreaterThan(100);
  });
});

describe('昇り口の広い段（ひな壇）', () => {
  // 御社の図面: 最初の列の 4 段が、床からの厚い板の台。段ごとの台が「手前の縁から奥の壁まで」の入れ子の四角で描かれる
  it('幅いっぱい: どの台も階段室の幅いっぱい・手前の縁から奥の壁まで。段数・歩行線は変わらない', () => {
    const s = wrap({ wideSteps: 4 });
    const lay = stairLayout(s, 16);
    expect(lay.pieces.length).toBe(16);
    expect(lay.plinths?.length).toBe(4);
    lay.plinths!.forEach((pl, k) => {
      expect(pl.i).toBe(k + 1);
      // 幅いっぱい（0〜2,730）、手前の縁は南から 227.5 ずつ奥へ、奥は北の壁（y = 0）まで
      expect(pl.top.minX).toBeCloseTo(0, 0);
      expect(pl.top.maxX).toBeCloseTo(2730, 0);
      expect(pl.top.maxY).toBeCloseTo(1820 - 227.5 * k, 0);
      expect(pl.top.minY).toBeCloseTo(0, 0);
      // 板の下の箱は、手前の縁だけ段鼻の出 20 ぶん引っ込む
      expect(pl.base.maxY).toBeCloseTo(pl.top.maxY - 20, 0);
      expect(pl.base.minX).toBeCloseTo(0, 0);
      expect(pl.base.maxX).toBeCloseTo(2730, 0);
    });
    // 最初の 4 段が台。段そのものの範囲は最初の列の幅のまま
    expect(lay.pieces.slice(0, 4).every((p) => !!p.wide)).toBe(true);
    expect(lay.pieces.slice(4).some((p) => !!p.wide)).toBe(false);
    expect(lay.pieces[0].maxX).toBeCloseTo(910, -1);
    // 平面図: 台の手前の縁が、幅いっぱいの線で 4 本（y = 1820・1592.5・1365・1137.5）
    const dr = stairDrawing(s, 2900, { cut: false });
    const fullLines = dr.risers.filter((r) => Math.abs(r.a.y - r.b.y) < 1 && Math.abs(r.b.x - r.a.x) > 2700);
    expect(fullLines.map((r) => Math.round(r.a.y)).sort((a, b) => b - a)).toEqual([1820, 1593, 1365, 1138]);
    expect(dr.label.text).toBe('UP 16');
  });

  it('角から 2 方向: 1 段目は幅いっぱい、2 段目から上は最初の列の壁から「列の幅＋残りの段数 × 踏面」まで。奥の帯はいちばん上の台の高さ', () => {
    const s = wrap({ wideSteps: 4, wideShape: 'corner' });
    const lay = stairLayout(s, 16);
    expect(lay.plinths?.length).toBe(5);
    const ext = lay.plinths!.slice(0, 4).map((pl) => Math.round(pl.top.maxX - pl.top.minX));
    expect(ext[0]).toBe(2730);
    expect(ext[1]).toBeCloseTo(910 + 455, -1);
    expect(ext[2]).toBeCloseTo(910 + 227.5, -1);
    expect(ext[3]).toBeCloseTo(910, -1);
    // どの台も西の壁（最初の列の側）から
    for (const pl of lay.plinths!.slice(0, 4)) expect(pl.top.minX).toBeCloseTo(0, 0);
    // 脇の空いている縁も、段鼻の出ぶん箱が引っ込む
    expect(lay.plinths![1].base.maxX).toBeCloseTo(lay.plinths![1].top.maxX - 20, 0);
    // 奥の帯（幅いっぱい × 奥行 910）は 4 段目の高さ
    const band = lay.plinths![4];
    expect(band.i).toBe(4);
    expect(band.top.maxX - band.top.minX).toBeCloseTo(2730, 0);
    expect(band.top.maxY).toBeCloseTo(910, -1);
    // 平面図: 手前の縁の線の長さが 2,730・1,365・1,137.5・910、空いている脇の縁（縦の線）が 3 本
    const dr = stairDrawing(s, 2900, { cut: false });
    const horiz = dr.risers.filter((r) => Math.abs(r.a.y - r.b.y) < 1 && r.a.y > 1100).map((r) => Math.round(Math.abs(r.b.x - r.a.x))).sort((a, b) => b - a);
    expect(horiz[0]).toBe(2730);
    expect(horiz).toContain(1365);
    const sides = dr.risers.filter((r) => Math.abs(r.a.x - r.b.x) < 1 && Math.min(r.a.x, r.b.x) > 900 && Math.max(r.a.y, r.b.y) > 1100);
    expect(sides.length).toBe(3);
  });

  it('段数は最初の列の段数まで。脇の列の無い形・コの字以外には付かない', () => {
    expect(stairLayout(wrap({ wideSteps: 9 }), 16).plinths?.length).toBe(4);
    expect(stairLayout(wrap({ wideSteps: 2 }), 16).plinths?.length).toBe(2);
    // 2 段だけひな壇: 3・4 段目はふつうの段（平面図には、3 段目に上がる線が列の幅で入る）
    const lay = stairLayout(wrap({ wideSteps: 2 }), 16);
    expect(lay.pieces[2].wide).toBeUndefined();
    const dr = stairDrawing(wrap({ wideSteps: 2 }), 2900, { cut: false });
    expect(dr.risers.some((r) => Math.abs(r.a.y - 1365) < 1 && Math.abs(r.b.y - 1365) < 1 && Math.abs(Math.abs(r.b.x - r.a.x) - 910) < 10)).toBe(true);
    expect(stairLayout(wrap({ wideSteps: 0 }), 16).plinths).toBeUndefined();
    expect(stairLayout(wrap({ kind: 'u', wideSteps: 3 }), 14).plinths).toBeUndefined();
    const flat: Stair = { id: 's', minX: 0, minY: 0, maxX: 4550, maxY: 910, kind: 'uOpen', entry: 'n', turn: 'left', goesUp: true, treadPitch: 227.4, midRun: 2728, cornerSteps: 2, wideSteps: 3 };
    expect(stairLayout(flat, 16).plinths).toBeUndefined();
  });
});

describe('図面からコの字階段を見分ける（wrapShape）', () => {
  // 1 階の図: 左の列（横線 5 本）と奥の列（縦線 5 本）。範囲は壁まで広げた 2,605 × 1,769
  const r = { minX: 5325, minY: 1922, maxX: 7930, maxY: 3691 };
  const left: StairRunBox = { minX: 5324, minY: 2731, maxX: 6128, maxY: 3641, orient: 'h', n: 5 };
  const top: StairRunBox = { minX: 6183, minY: 1872, maxX: 7089, maxY: 2676, orient: 'v', n: 5 };

  it('奥の辺に沿う列の両端に角の升が残り、端に脇の列がある → コの字。脇の列の見えている端・奥の列の長さ', () => {
    const ws = wrapShape([left, top], r, []);
    expect(ws).toBeTruthy();
    expect(ws!.back).toBe('n');
    expect(ws!.sideEnd).toBe('lo');
    expect(ws!.flat).toBe(false);
    expect(ws!.mid).toBe(906);
    expect(ws!.cornerSteps).toBe(1);
  });

  it('角の升の中の斜めの線 1 方向 → 回り段 2 段、2 方向 → 3 段回り', () => {
    const d1 = [seg({ x: 5330, y: 1930 }, { x: 6180, y: 2780 })];
    expect(wrapShape([left, top], r, d1)!.cornerSteps).toBe(2);
    const d2 = [seg({ x: 5330, y: 1930 }, { x: 6180, y: 2420 }), seg({ x: 5330, y: 1930 }, { x: 5820, y: 2780 })];
    expect(wrapShape([left, top], r, d2)!.cornerSteps).toBe(3);
  });

  it('かね折れ（奥の列が端の壁まで続く）・直階段・折り返しはコの字にしない', () => {
    // 奥の列が東の壁まで: 東の端に角の升が無い
    const longTop: StairRunBox = { ...top, maxX: 7880 };
    expect(wrapShape([left, longTop], r, [])).toBeNull();
    // 直階段（列が範囲いっぱい）
    expect(wrapShape([{ minX: 0, minY: 0, maxX: 800, maxY: 3000, orient: 'h', n: 13 }], { minX: 0, minY: 0, maxX: 800, maxY: 3000 }, [])).toBeNull();
    // 折り返し（同じ向きの 2 列）
    const a: StairRunBox = { minX: 0, minY: 0, maxX: 800, maxY: 1800, orient: 'h', n: 8 };
    const b: StairRunBox = { minX: 900, minY: 0, maxX: 1700, maxY: 1800, orient: 'h', n: 8 };
    expect(wrapShape([a, b], { minX: 0, minY: 0, maxX: 1700, maxY: 2600 }, [])).toBeNull();
    // 脇の列の無いコの字の形だけでは決めない（奥行があるのに脇の列が見えない）
    expect(wrapShape([top], r, [])).toBeNull();
  });

  it('ひな壇: 脇の列の帯を幅いっぱいに横切る線が段の間隔で 3 本 → 幅いっぱいの 4 段（昇り口の縁の線は数えない）', () => {
    const lines = [3413, 3184, 2960].map((y) => seg({ x: 5273, y }, { x: 7999, y }));
    const ws = wrapShape([left, top], r, lines)!;
    expect(ws.wide.lo).toEqual({ n: 4, shape: 'full' });
    expect(ws.wide.hi).toEqual({ n: 4, shape: 'full' });
    // 昇り口の縁（y = 3,641）の線だけでは、ひな壇にしない
    expect(wrapShape([left, top], r, [seg({ x: 5273, y: 3641 }, { x: 7999, y: 3641 })])!.wide.lo.n).toBe(0);
    // ふつうの段の線（列の幅）だけなら、ひな壇は無い
    const plain = [3413, 3184, 2960].map((y) => seg({ x: 5324, y }, { x: 6128, y }));
    expect(wrapShape([left, top], r, plain)!.wide.lo.n).toBe(0);
  });

  it('ひな壇: 西の壁からの線が、奥へ 1 段ぶんずつ短くなる（1,363 → 1,135 → 910）→ 角から 2 方向に下りる 4 段。東の壁の側には無い', () => {
    const lines = [seg({ x: 5273, y: 3411 }, { x: 6636, y: 3411 }), seg({ x: 5273, y: 3182 }, { x: 6407, y: 3182 }), seg({ x: 5273, y: 2958 }, { x: 6183, y: 2958 })];
    const ws = wrapShape([left, top], r, lines)!;
    expect(ws.wide.lo).toEqual({ n: 4, shape: 'corner' });
    expect(ws.wide.hi.n).toBe(0);
  });

  it('ひな壇の台の縁が混ざって列の範囲が膨らんだら、段の線の本来の幅（core）で列の幅を見る', () => {
    // 奥の列の縦線 5 本のうち 3 本が、台の脇の縁として手前へ長く伸びている（範囲は y = 1,819〜3,411 に膨らむ）
    const fat: StairRunBox = { minX: 6183, minY: 1819, maxX: 7089, maxY: 3411, orient: 'v', n: 5, core: [1819, 2729] };
    const fatLeft: StairRunBox = { minX: 5273, minY: 2729, maxX: 6636, maxY: 3639, orient: 'h', n: 5, core: [5323, 6009] };
    const r2 = { minX: 5273, minY: 1871, maxX: 7940, maxY: 3680 };
    const ws = wrapShape([fatLeft, fat], r2, []);
    expect(ws).toBeTruthy();
    expect(ws!.back).toBe('n');
    expect(ws!.sideEnd).toBe('lo');
    // core が無ければ（範囲のままなら）列の幅 1,592 と見て、コの字にならない
    expect(wrapShape([{ ...fatLeft, core: undefined }, { ...fat, core: undefined }], r2, [])).toBeNull();
    // 範囲が列の幅として納まっている列は、core が短くても範囲で見る（切断線・手すりで短く描かれた段の線が多い図）
    const run: StairRunBox = { minX: 9608, minY: 5567, maxX: 12336, maxY: 6371, orient: 'v', n: 13, core: [5685, 6251] };
    expect(wrapShape([run], { minX: 8860, minY: 5560, maxX: 13200, maxY: 6380 }, [])?.flat).toBe(true);
  });

  it('奥行が列の幅だけの形（列の両端に升）は、脇の列なしのコの字の候補（出入り口の側は文字で決める）', () => {
    const run: StairRunBox = { minX: 9608, minY: 5567, maxX: 12336, maxY: 6371, orient: 'v', n: 13 };
    const ws = wrapShape([run], { minX: 8860, minY: 5560, maxX: 13200, maxY: 6380 }, []);
    expect(ws).toBeTruthy();
    expect(ws!.flat).toBe(true);
    expect(ws!.sideEnd).toBeNull();
    expect(ws!.mid).toBe(2728);
  });
});

describe('脇の列が短い 3 方回り（角の升の回り段の線から見分ける）', () => {
  // 御社の図面（林様邸）: 2 間 × 0.75 間に、左 2 段 → 回り段 → 奥 8 段 → 回り段 → 右 2 段。脇の列は線が 2 本で、列にならない
  const P = { minX: 1000, minY: 0, maxX: 2820, maxY: 700 };

  it('奥の列の両端の升: 斜めの線があれば回り段。升の先の段の線と側桁の線から、昇り口の縁までの長さ', () => {
    const segs = [
      seg({ x: 2900, y: 640 }, { x: 3500, y: 40 }), // 右の升の斜めの線
      seg({ x: 140, y: 910 }, { x: 745, y: 910 }), // 左の脇の列の段の線
      seg({ x: 140, y: 1138 }, { x: 745, y: 1138 }),
      seg({ x: 500, y: 1138 }, { x: 500, y: 1310 }), // 側桁が最後の段の線の先へ伸びる
    ];
    const sq = cornerSquares(P, true, 860, 860, segs);
    expect(sq.diag).toBe(true);
    expect(sq.side).toBe('s');
    expect(sq.sideLen).toBe(610);
    // 斜めの線が無ければ回り段とは見ない（踊り場の升・ただの空き）
    expect(cornerSquares(P, true, 860, 860, segs.slice(1)).diag).toBe(false);
    // 段の線が無ければ、脇の列の長さは 0（奥行が列の幅だけの形）
    expect(cornerSquares(P, true, 860, 860, segs.slice(0, 1))).toEqual({ diag: true, side: null, sideLen: 0 });
  });

  it('脇の列が列として読めなくても、角の升に斜めの線があればコの字（最初の列の側は文字で決めるので null）', () => {
    const r = { minX: 5325, minY: 1922, maxX: 7930, maxY: 3691 };
    const top: StairRunBox = { minX: 6183, minY: 1872, maxX: 7089, maxY: 2676, orient: 'v', n: 5 };
    expect(wrapShape([top], r, [])).toBeNull();
    const ws = wrapShape([top], r, [seg({ x: 5330, y: 1930 }, { x: 6180, y: 2780 })]);
    expect(ws).toBeTruthy();
    expect(ws!.sideEnd).toBeNull();
    expect(ws!.cornerSteps).toBe(2);
  });

  it('吹抜の側の二重線が壁の厚み（60〜140）なら腰壁、細い二重線（手すり）は腰壁にしない', () => {
    const r = { minX: 5325, minY: 1922, maxX: 7930, maxY: 3691 };
    const left: StairRunBox = { minX: 5324, minY: 2731, maxX: 6128, maxY: 3641, orient: 'h', n: 5 };
    const top: StairRunBox = { minX: 6183, minY: 1872, maxX: 7089, maxY: 2676, orient: 'v', n: 5 };
    const line = (y: number) => seg({ x: 6183, y }, { x: 7089, y });
    expect(wrapShape([left, top], r, [line(2700), line(2800)])!.guardWall).toBe(true);
    expect(wrapShape([left, top], r, [line(2700), line(2712)])!.guardWall).toBe(false);
    expect(wrapShape([left, top], r, [])!.guardWall).toBe(false);
  });
});

describe('階段の吹抜の木・階段の中の小さな区画', () => {
  const room = (type: Room['type'], x0: number, y0: number, x1: number, y1: number, area: number): Room => ({ id: `R-${type}`, name: type, type, polygon: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], area, labelPos: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } });
  const floorOf = (stair: Stair, items: FurnitureItem[], rooms: Room[] = []): Floor => ({ level: 1, elevation: 0, height: 2900, walls: [], openings: [], rooms, stairs: [stair], outline: [], planItems: items }) as unknown as Floor;
  const tree = (o: Partial<FurnitureItem> = {}): FurnitureItem => ({ id: 'p1', kind: 'plant', x: 1365, y: 1900, rot: 0, w: 1.15, ...o });

  it('吹抜に掛かる大きな植物の記号は、吹抜の中の地植えの木（幹は縁から 250 内側・高さは上の階の腰まで）', () => {
    const f = floorOf(wrap(), [tree()], [room('ldk', -3000, -3000, 6000, 6000, 80)]);
    treesInStairWells([f]);
    const it = f.planItems![0];
    // 吹抜は x 910〜1820・y 910〜1820
    expect(it.x).toBeGreaterThanOrEqual(1160);
    expect(it.x).toBeLessThanOrEqual(1570);
    expect(it.y).toBe(1570);
    expect(it.h).toBeCloseTo(3.8, 1);
    expect(it.roomId).toBe('R-ldk');
  });

  it('小さな鉢植え・吹抜から離れた木・ひな壇のある階段は、そのまま', () => {
    const small = floorOf(wrap(), [tree({ w: 0.84 })]);
    treesInStairWells([small]);
    expect(small.planItems![0].h).toBeUndefined();
    const far = floorOf(wrap(), [tree({ y: 2600 })]);
    treesInStairWells([far]);
    expect(far.planItems![0].y).toBe(2600);
    const stage = floorOf(wrap({ wideSteps: 4 }), [tree()]);
    treesInStairWells([stage]);
    expect(stage.planItems![0].h).toBeUndefined();
  });

  it('階段の範囲に入る小さな区画（奥の列の下の「階段ヌック」など）は階段の一部。大きな部屋・範囲の外の部屋は変えない', () => {
    const under = room('study', 910, 0, 1820, 780, 2.3);
    const big = room('ldk', -3000, -3000, 6000, 6000, 80);
    const beside = room('closet', 2730, 0, 3640, 900, 1.3);
    const f = floorOf(wrap(), [], [under, big, beside]);
    roomsUnderStairs([f]);
    expect(under.type).toBe('stairs');
    expect(big.type).toBe('ldk');
    expect(beside.type).toBe('closet');
  });
});
