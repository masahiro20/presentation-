// 立面図から窓の高さ・上下階の重ね位置・平面図の縮尺を読む（parser/elevationWindows）
import { describe, expect, it } from 'vitest';
import { applyElevationWindows, axisForFacing, findElevationTitles, findRects, floorShiftsFromElevation, planScaleFromElevation, readElevationViews, styleFor, windowUnits, type ElevationView } from '../src/parser/elevationWindows';
import type { PageVectors, RawSegment, RawText } from '../src/parser/pdfExtract';
import type { Floor, Opening, Vec2, Wall } from '../src/core/types';

const seg = (ax: number, ay: number, bx: number, by: number, width = 0.36, color = '#000000'): RawSegment => ({ a: { x: ax, y: ay }, b: { x: bx, y: by }, width, dashed: false, source: 'stroke', color });
const box = (x0: number, y0: number, x1: number, y1: number, width = 0.36): RawSegment[] => [seg(x0, y0, x1, y0, width), seg(x1, y0, x1, y1, width), seg(x1, y1, x0, y1, width), seg(x0, y1, x0, y0, width)];
const txt = (str: string, cx: number, cy: number, size = 11.3, width = 25): RawText => ({ str, cx, cy, size, width, angle: 0 });

describe('立面図の見出し', () => {
  it('「南 側」「立 面 図」に分かれた文字・1 つの文字・英語の見出しを読む', () => {
    const t = findElevationTitles([txt('南 側', 332, 372), txt('立 面 図', 376, 372, 11.3, 40), txt('北側立面図', 330, 662), txt('EAST ELEVATION', 900, 372), txt('立面図', 167, 804, 10, 30)]);
    expect(t.map((x) => x.facing).sort()).toEqual(['E', 'N', 'S']);
  });
});

describe('窓の四角', () => {
  it('閉じた四角を拾い、隣り合う窓と方立てをまたぐ四角は作らない', () => {
    const segs = [...box(0, 0, 20, 10), ...box(20, 0, 22, 10), ...box(22, 0, 42, 10)];
    const r = findRects(segs, 1);
    expect(r.some((b) => Math.abs(b.x0) < 0.1 && Math.abs(b.x1 - 42) < 0.1)).toBe(false);
    expect(r.some((b) => Math.abs(b.x0) < 0.1 && Math.abs(b.x1 - 20) < 0.1)).toBe(true);
  });
  it('外壁の目地（四角の外まで伸びる線）が交わってできた四角は窓にしない', () => {
    // 窓の下端の線と基礎の線（左右へ伸びる）の間に立つ目地の線 2 本
    const segs = [seg(10, 40, 10, 60), seg(20, 40, 20, 60), seg(0, 40, 30, 40), seg(0, 60, 30, 60)];
    expect(findRects(segs, 1).length).toBeGreaterThan(0);
    expect(findRects(segs, 1, 2).length).toBe(0);
  });
  it('枠の内側の線は枠の一部・枠の無い障子はまとめる・同じ四角の並び（屋根の飾り）は除く', () => {
    const mm = 35;
    const framed = windowUnits([{ x0: 0, y0: 0, x1: 30, y1: 20 }, { x0: 1, y0: 1, x1: 29, y1: 19 }], mm);
    expect(framed.length).toBe(1);
    expect(framed[0].x1 - framed[0].x0).toBe(30);
    const panes = windowUnits([{ x0: 0, y0: 0, x1: 15, y1: 60 }, { x0: 15.5, y0: 0, x1: 30, y1: 60 }], mm);
    expect(panes.length).toBe(1);
    expect(panes[0].panes).toBe(2);
    const row = Array.from({ length: 6 }, (_, i) => ({ x0: i * 10.5, y0: 0, x1: i * 10.5 + 10, y1: 10 }));
    expect(windowUnits(row, mm).length).toBe(0);
  });
});

/** 箱の家（0..9100 × 0..7280、外壁の厚さ 160）。窓は x の範囲で指定（南・北の外壁） */
function boxFloor(level: number, elevation: number, wins: { side: 'S' | 'N'; x0: number; x1: number; sill?: number; height?: number }[]): Floor {
  const P = (x: number, y: number): Vec2 => ({ x, y });
  const walls: Wall[] = [
    { id: `${level}t`, a: P(0, 0), b: P(9100, 0), thickness: 160, exterior: true, outsideSign: -1 },
    { id: `${level}r`, a: P(9100, 0), b: P(9100, 7280), thickness: 160, exterior: true, outsideSign: -1 },
    { id: `${level}b`, a: P(9100, 7280), b: P(0, 7280), thickness: 160, exterior: true, outsideSign: -1 },
    { id: `${level}l`, a: P(0, 7280), b: P(0, 0), thickness: 160, exterior: true, outsideSign: -1 },
  ];
  const openings: Opening[] = wins.map((w, i) =>
    w.side === 'S'
      ? { id: `${level}w${i}`, wallId: `${level}b`, kind: 'window', t0: 9100 - w.x1, t1: 9100 - w.x0, sill: w.sill ?? 900, height: w.height ?? 1100, windowStyle: 'koshi' }
      : { id: `${level}w${i}`, wallId: `${level}t`, kind: 'window', t0: w.x0, t1: w.x1, sill: w.sill ?? 900, height: w.height ?? 1100, windowStyle: 'koshi' },
  );
  return { level, elevation, height: 2900, ceilingHeight: 2400, walls, openings, rooms: [], stairs: [], outline: [[P(0, 0), P(9100, 0), P(9100, 7280), P(0, 7280)]] };
}

/** 立面図の 1 面（外形の左端 = 平面図の外面）。南面は x がそのまま、北面は左右が逆 */
function view(facing: 'S' | 'N', wins: { x0: number; x1: number; z0: number; z1: number }[], width = 9260): ElevationView {
  const u = (x: number) => (facing === 'S' ? x + 80 : 9180 - x);
  return {
    facing,
    pageIndex: 0,
    mmPerPt: 35.28,
    width,
    scaleFromLabels: true,
    glY: 0,
    bx0: 0,
    bx1: 0,
    windows: wins.map((w) => ({ u0: Math.min(u(w.x0), u(w.x1)), u1: Math.max(u(w.x0), u(w.x1)), z0: w.z0, z1: w.z1, panes: 1 })),
  };
}

describe('平面図の窓に当てる', () => {
  it('同じ面・同じ位置の窓に、立面図の腰高・高さを当てる（仕様でそろえ直さない印付き）', () => {
    const f1 = boxFloor(1, 500, [{ side: 'S', x0: 2000, x1: 3690 }]);
    const r = applyElevationWindows([f1], [view('S', [{ x0: 2000, x1: 3690, z0: 1700, z1: 2700 }])], 0);
    expect(r.matched).toBe(1);
    expect(r.changed).toBe(1);
    const op = f1.openings[0];
    expect(op.sill).toBe(1200);
    expect(op.height).toBe(1000);
    expect(op.heightFrom).toBe('elevation');
  });
  it('窓の形の名前を高さに合わせる（床から 2m 超は掃き出し・天井際の横長は高窓・浴室の小窓はそのまま）', () => {
    expect(styleFor('koshi', 0, 2200, 1690)).toBe('hakidashi');
    expect(styleFor('koshi', 2380, 350, 1190)).toBe('high');
    expect(styleFor('small', 1400, 600, 600)).toBe('small');
    expect(styleFor('hakidashi', 900, 1100, 1690)).toBe('koshi');
  });
  it('真北のずれ: 南の面は図面の下、真北が 90° なら南の面は図面の左', () => {
    expect(axisForFacing('S', 0)).toBe(0);
    expect(axisForFacing('N', 0)).toBe(1);
    expect(axisForFacing('S', 90)).toBe(3);
  });
});

describe('上下階の重ね位置', () => {
  it('南・北の 2 面で 2 階の窓だけが同じだけずれていれば、2 階の直す量を返す（半間の格子にそろえる）', () => {
    // 正しい 2 階の窓: 南 x 3000–4690・北 x 6000–7690。平面図の 2 階は 900 左へずれて読まれている
    const f1 = boxFloor(1, 500, [{ side: 'S', x0: 2000, x1: 3690 }, { side: 'N', x0: 5000, x1: 6690 }]);
    const f2 = boxFloor(2, 3400, [{ side: 'S', x0: 2100, x1: 3790 }, { side: 'N', x0: 5100, x1: 6790 }]);
    const S = view('S', [{ x0: 2000, x1: 3690, z0: 1400, z1: 2500 }, { x0: 3000, x1: 4690, z0: 4300, z1: 5400 }]);
    const N = view('N', [{ x0: 5000, x1: 6690, z0: 1400, z1: 2500 }, { x0: 6000, x1: 7690, z0: 4300, z1: 5400 }]);
    const sh = floorShiftsFromElevation([f1, f2], [S, N], 0, 455);
    expect(sh).toHaveLength(1);
    expect(sh[0].level).toBe(2);
    expect(sh[0].dx).toBe(910);
    expect(sh[0].dy).toBe(0);
  });
  it('ずれていなければ何も返さない', () => {
    const f1 = boxFloor(1, 500, [{ side: 'S', x0: 2000, x1: 3690 }, { side: 'N', x0: 5000, x1: 6690 }]);
    const f2 = boxFloor(2, 3400, [{ side: 'S', x0: 3000, x1: 4690 }, { side: 'N', x0: 6000, x1: 7690 }]);
    const S = view('S', [{ x0: 2000, x1: 3690, z0: 1400, z1: 2500 }, { x0: 3000, x1: 4690, z0: 4300, z1: 5400 }]);
    const N = view('N', [{ x0: 5000, x1: 6690, z0: 1400, z1: 2500 }, { x0: 6000, x1: 7690, z0: 4300, z1: 5400 }]);
    expect(floorShiftsFromElevation([f1, f2], [S, N], 0, 455)).toEqual([]);
  });
});

describe('平面図の縮尺の確かめ', () => {
  it('3 面以上で立面図の幅が平面図の 1.2 倍にそろえば 1.2 を返す。立面図の縮尺が FL から分からない面は使わない', () => {
    const f1 = boxFloor(1, 500, []);
    const v = (facing: 'S' | 'N' | 'E' | 'W', w: number, fromLabels = true): ElevationView => ({ ...view('S', []), facing, width: w, scaleFromLabels: fromLabels });
    const r = planScaleFromElevation([f1], [v('S', 9260 * 1.2), v('N', 9260 * 1.2), v('E', 7440 * 1.2), v('W', 7440 * 1.2)], 0);
    expect(r).not.toBeNull();
    expect(r!.k).toBeCloseTo(1.2, 2);
    expect(planScaleFromElevation([f1], [v('S', 9260 * 1.2, false), v('N', 9260 * 1.2, false), v('E', 7440 * 1.2, false)], 0)).toBeNull();
    // ばらつきが大きい（平面図の読み違いで形が違う）ときは返さない
    expect(planScaleFromElevation([f1], [v('S', 9260 * 1.0), v('N', 9260 * 1.3), v('E', 7440 * 1.5)], 0)).toBeNull();
  });
});

describe('立面図の GL（地盤面の線）', () => {
  /**
   * 1 段に 2 面（左 = 南面、右 = 東面）。GL の線は y=331、基礎の天端は 470mm 上（y=317.7）で、壁の縦線は基礎の天端から立つ。
   * 「GL」の文字は左の図にしか無い（段の端にだけ寸法と一緒に書く図面: 吉田大仁様邸・意匠図一式）
   */
  const page = (): PageVectors => {
    const mmPt = 35.28;
    const base = 331 - 470 / mmPt;
    const one = (x0: number, x1: number): RawSegment[] => [
      seg(x0 - 40, 331, x1 + 40, 331), // GL
      seg(x0, base, x1, base), // 基礎の天端
      seg(x0, base, x0, 150), seg(x1, base, x1, 150), seg((x0 + x1) / 2, base, (x0 + x1) / 2, 150), // 壁（基礎の天端から立つ）
      seg(x0, 150, x1, 150), // 軒
      ...box(x0 + 60, 230, x0 + 100, 260), ...box(x0 + 61, 231, x0 + 99, 259), // 窓（枠＋障子）
      ...Array.from({ length: 8 }, (_, i) => seg(x0 + 5, 160 + i * 4, x0 + 30, 160 + i * 4, 0.12)), // 目地
    ];
    return {
      pageIndex: 0,
      width: 1191,
      height: 842,
      segments: [...one(150, 560), ...one(700, 1100)],
      curves: [],
      fills: [],
      texts: [txt('南側立面図', 355, 372, 11.3, 60), txt('東側立面図', 900, 372, 11.3, 60), txt('GL', 97, 328, 6, 10)],
    };
  };
  const win = (v: ElevationView) => v.windows[0];

  it('「GL」の文字が無い図は、同じ段の図の GL と同じ高さの線を GL にする（基礎の天端と取り違えない）', () => {
    const views = readElevationViews([page()], 35.28, null);
    expect(views.map((v) => v.facing).sort()).toEqual(['E', 'S']);
    const s = views.find((v) => v.facing === 'S')!;
    const e = views.find((v) => v.facing === 'E')!;
    expect(s.glY).toBeCloseTo(331, 1);
    expect(e.glY).toBeCloseTo(331, 1);
    // 窓の下端は GL から (331 − 260) × 35.28 ≒ 2,505mm。両方の面で同じ
    expect(win(s).z0).toBeGreaterThan(2450);
    expect(win(s).z0).toBeLessThan(2560);
    expect(Math.abs(win(e).z0 - win(s).z0)).toBeLessThan(15);
  });

  it('切り替えを切ると、文字の無い図は壁の立つ線（基礎の天端）を GL にして、窓が 470mm 低く読める', () => {
    const g = globalThis as { __NO_ELEV_ROW_GL?: boolean };
    g.__NO_ELEV_ROW_GL = true;
    try {
      const views = readElevationViews([page()], 35.28, null);
      const s = views.find((v) => v.facing === 'S')!;
      const e = views.find((v) => v.facing === 'E')!;
      expect(s.glY).toBeCloseTo(331, 1);
      expect(e.glY).toBeLessThan(320);
      expect(win(s).z0 - win(e).z0).toBeGreaterThan(400);
    } finally {
      delete g.__NO_ELEV_ROW_GL;
    }
  });
});

describe('立面図の図と図の境', () => {
  /**
   * 1 段に、幅の広い南面（x 150..660 = 18.0m）と狭い東面（x 720..1000 = 9.9m）。見出しは 355 と 900 にあり、
   * その中間（627.5）は南面の中（右端の壁 660 より左）。図と図の間の空き（670..710）で切れば、どちらの外形も正しく読める
   */
  const page = (): PageVectors => {
    const one = (x0: number, x1: number): RawSegment[] => [
      seg(x0 - 10, 331, x1 - 60, 331), seg(x1 - 60, 331, x1 + 10, 331), // GL（壁の所で切れた 2 本）
      seg(x0, 331, x0, 150), seg(x1, 331, x1, 150), seg((x0 + x1) / 2, 331, (x0 + x1) / 2, 150), // 壁
      seg(x0, 150, x1, 150), // 軒
      ...box(x0 + 60, 230, x0 + 100, 260), ...box(x0 + 61, 231, x0 + 99, 259), // 窓（枠＋障子）
      ...Array.from({ length: 8 }, (_, i) => seg(x0 + 5, 160 + i * 4, x0 + 30, 160 + i * 4, 0.12)), // 目地
    ];
    return {
      pageIndex: 0,
      width: 1191,
      height: 842,
      segments: [...one(150, 660), ...one(720, 1000)],
      curves: [],
      fills: [],
      texts: [txt('南側立面図', 355, 372, 11.3, 60), txt('東側立面図', 900, 372, 11.3, 60), txt('GL', 97, 328, 6, 10)],
    };
  };
  const widths = () => {
    const views = readElevationViews([page()], 35.28, null);
    return { s: views.find((v) => v.facing === 'S')?.width ?? 0, e: views.find((v) => v.facing === 'E')?.width ?? 0 };
  };

  it('幅の違う図が並んでも、図と図の間の空きで切る（広い方の図の端を隣の図に入れない）', () => {
    const w = widths();
    expect(Math.abs(w.s - 510 * 35.28)).toBeLessThan(40);
    expect(Math.abs(w.e - 280 * 35.28)).toBeLessThan(40);
  });

  it('切り替えを切ると、見出しの中間で切って南面の右端の壁が東面に入る（東面が 2.1m 広く・南面が半分に読める）', () => {
    const g = globalThis as { __NO_ELEV_GAP_SPLIT?: boolean };
    g.__NO_ELEV_GAP_SPLIT = true;
    try {
      const w = widths();
      expect(w.e).toBeGreaterThan(280 * 35.28 + 1800);
      expect(w.s).toBeLessThan(510 * 35.28 - 1800);
    } finally {
      delete g.__NO_ELEV_GAP_SPLIT;
    }
  });
});
