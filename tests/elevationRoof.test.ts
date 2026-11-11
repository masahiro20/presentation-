// 立面図の屋根の線から、屋根の塊ごとの掛け方を読む（parser/elevationWindows roofLinesOf・parser/elevationRoof）
import { afterEach, describe, expect, it } from 'vitest';
import { roofLinesOf, type ElevationView, type RoofLine } from '../src/parser/elevationWindows';
import { applyRoofHints, describeRoofHints, roofHintsFromElevation } from '../src/parser/elevationRoof';
import { roofMasses } from '../src/scene/roof';
import { EXTERIOR_STYLES } from '../src/styles/presets';
import type { RawSegment } from '../src/parser/pdfExtract';
import type { BuildingModel, Floor, Opening, RoofPatch, Vec2, Wall } from '../src/core/types';

// 立面図の 1 面: 1pt = 35.28mm（1/100）、GL の線は y = 500pt、外形の左端は x = 100pt
const MM = 35.28;
const GL = 500;
const BX0 = 100;
/** mm（外形の左端から u、GL から z）で線を引く */
const line = (u0: number, z0: number, u1: number, z1: number, o: Partial<RawSegment> = {}): RawSegment => ({ a: { x: BX0 + u0 / MM, y: GL - z0 / MM }, b: { x: BX0 + u1 / MM, y: GL - z1 / MM }, width: 0.36, dashed: false, source: 'stroke', color: '#000000', ...o });
const read = (segs: RawSegment[], width = 9260) => roofLinesOf(segs, GL, BX0, BX0 + width / MM, MM);

describe('立面図の屋根の線を拾う', () => {
  it('屋根の厚みの 3 本線は、いちばん上の 1 本にまとめる', () => {
    const r = read([line(0, 6000, 9260, 6460), line(0, 5950, 9260, 6410), line(20, 5800, 9240, 6260)]);
    expect(r.length).toBe(1);
    expect(r[0].z0).toBeGreaterThan(5990);
    expect(r[0].u1 - r[0].u0).toBeGreaterThan(9200);
  });
  it('同じ直線の上で切れた線はつなぐ', () => {
    const r = read([line(0, 6000, 3000, 6150), line(3050, 6152.5, 9260, 6463)]);
    expect(r.length).toBe(1);
    expect(r[0].u0).toBe(0);
    expect(r[0].u1).toBe(9260);
  });
  it('少しずつ横にずれた平行線の束（屋根面の目地）は除く', () => {
    const hatch = Array.from({ length: 8 }, (_, i) => line(1000 + i * 233, 3000 + i * 0.1, 4000 + i * 233, 3212 + i * 0.1));
    expect(read(hatch).length).toBe(0);
    // 目地のそばに屋根の端の線があれば、それは残る
    const r = read([...hatch, line(0, 6000, 9260, 6460)]);
    expect(r.length).toBe(1);
    expect(r[0].z0).toBe(6000);
  });
  it('水平に近い線・急な線・短い線・低い線・破線は拾わない', () => {
    expect(read([line(0, 6000, 9260, 6050)]).length).toBe(0); // 0.05 寸
    expect(read([line(0, 3000, 4000, 7000)]).length).toBe(0); // 10 寸
    expect(read([line(0, 6000, 700, 6200)]).length).toBe(0);
    expect(read([line(0, 800, 5000, 1300)]).length).toBe(0);
    expect(read([line(0, 6000, 9260, 6460, { dashed: true })]).length).toBe(0);
  });
});

const P = (x: number, y: number): Vec2 => ({ x, y });
/** 四角い階（x0..x1 × y0..y1、外壁の厚さ 160）。南の外壁に窓 1 つ */
function rectFloor(level: number, elevation: number, x0: number, y0: number, x1: number, y1: number, win?: { x0: number; x1: number }): Floor {
  const walls: Wall[] = [
    { id: `${level}t`, a: P(x0, y0), b: P(x1, y0), thickness: 160, exterior: true, outsideSign: -1 },
    { id: `${level}r`, a: P(x1, y0), b: P(x1, y1), thickness: 160, exterior: true, outsideSign: -1 },
    { id: `${level}b`, a: P(x1, y1), b: P(x0, y1), thickness: 160, exterior: true, outsideSign: -1 },
    { id: `${level}l`, a: P(x0, y1), b: P(x0, y0), thickness: 160, exterior: true, outsideSign: -1 },
  ];
  const openings: Opening[] = win ? [{ id: `${level}w`, wallId: `${level}b`, kind: 'window', t0: x1 - win.x1, t1: x1 - win.x0, sill: 900, height: 1100, windowStyle: 'koshi' }] : [];
  return { level, elevation, height: 2900, ceilingHeight: 2400, walls, openings, rooms: [], stairs: [], outline: [[P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)]] };
}

/**
 * 立面図の 1 面。南面は x がそのまま（左が西）、北面は左右が逆、東面は左が南（y の大きい側）、西面は左が北。
 * 窓は南面だけ（平面図の南の窓と合わせて、面の向きを確かめる）
 */
function view(facing: 'S' | 'N' | 'E' | 'W', roofLines: RoofLine[], o: { width?: number; win?: { x0: number; x1: number } } = {}): ElevationView {
  const width = o.width ?? (facing === 'S' || facing === 'N' ? 9260 : 7440);
  return {
    facing,
    pageIndex: 0,
    mmPerPt: MM,
    width,
    scaleFromLabels: true,
    glY: 0,
    bx0: 0,
    bx1: 0,
    windows: o.win ? [{ u0: o.win.x0 + 80, u1: o.win.x1 + 80, z0: 1400, z1: 2500, panes: 1 }] : [],
    roofLines,
  };
}
const WIN = { x0: 2000, x1: 3690 };
/** 総二階の箱（0..9100 × 0..7280）。1 階床 GL+500、2 階床 GL+3,400、2 階の壁の天端 GL+6,300 */
const box2 = (): Floor[] => [rectFloor(1, 500, 0, 0, 9100, 7280, WIN), rectFloor(2, 3400, 0, 0, 9100, 7280)];
const south = (lines: RoofLine[]) => view('S', lines, { win: WIN });
const g = globalThis as { __NO_ELEV_ROOF?: boolean };
afterEach(() => {
  delete g.__NO_ELEV_ROOF;
});

describe('立面図の屋根の線から掛け方を読む', () => {
  it('片流れ: 南面で右（東）へ上がる 1 本の線 → 東が高い片流れ。北面の同じ線（左右が逆）とも合う', () => {
    const s = south([{ u0: -300, z0: 6300, u1: 9560, z1: 7286 }]);
    const n = view('N', [{ u0: -300, z0: 7286, u1: 9560, z1: 6300 }]);
    const h = roofHintsFromElevation(box2(), [s, n], 0);
    expect(h.length).toBe(1);
    expect(h[0]).toMatchObject({ level: 2, isTop: true, kind: 'shed', high: 'e', pitch: 1 });
    expect(h[0].facings.sort()).toEqual(['N', 'S']);
    expect(describeRoofHints(h, 0)).toContain('2階の屋根 片流れ（東が高い・1 寸');
  });
  it('片流れ: 窓の組が無い東面でも、外形の幅が平面図と合えば使う（右 = 北へ上がる → 北が高い）', () => {
    const e = view('E', [{ u0: -200, z0: 6300, u1: 7640, z1: 6692 }]);
    const h = roofHintsFromElevation(box2(), [south([]), e], 0);
    expect(h.length).toBe(1);
    expect(h[0]).toMatchObject({ kind: 'shed', high: 'n', pitch: 0.5 });
  });
  it('面どうしで高い側が食い違う塊は決めない', () => {
    const s = south([{ u0: -300, z0: 6300, u1: 9560, z1: 7286 }]);
    const n = view('N', [{ u0: -300, z0: 6300, u1: 9560, z1: 7286 }]);
    expect(roofHintsFromElevation(box2(), [s, n], 0).length).toBe(0);
  });
  it('塊の端から端まで届かない線（一部だけに掛かる屋根）・高さの合わない線は使わない', () => {
    expect(roofHintsFromElevation(box2(), [south([{ u0: -300, z0: 6300, u1: 5000, z1: 6830 }])], 0).length).toBe(0);
    expect(roofHintsFromElevation(box2(), [south([{ u0: -300, z0: 8300, u1: 9560, z1: 9286 }])], 0).length).toBe(0);
  });
  it('切妻: 両端から上がって真ん中で出会う 2 本 → 棟は見ている向き（南面なら図面の上下）', () => {
    const s = south([
      { u0: -300, z0: 6300, u1: 4630, z1: 8272 },
      { u0: 4630, z0: 8272, u1: 9560, z1: 6300 },
    ]);
    const h = roofHintsFromElevation(box2(), [s], 0);
    expect(h.length).toBe(1);
    expect(h[0]).toMatchObject({ kind: 'gable', ridge: 'z', pitch: 4 });
  });
  it('寄棟: 両端から上がって水平な棟でつながる台形', () => {
    const s = south([
      { u0: -300, z0: 6300, u1: 3340, z1: 7756 },
      { u0: 5920, z0: 7756, u1: 9560, z1: 6300 },
    ]);
    const h = roofHintsFromElevation(box2(), [s], 0);
    expect(h.length).toBe(1);
    expect(h[0]).toMatchObject({ kind: 'hip', pitch: 4 });
    expect(h[0].ridge).toBeUndefined();
  });
  it('下屋: 上の階の壁から外へ下がる線 → 上の階の側が高い片流れ（最上階の屋根とは別の塊）', () => {
    // 2 階は西側 0..5460 だけ。1 階の東側 5460..9100 が下屋
    const floors = [rectFloor(1, 500, 0, 0, 9100, 7280, WIN), rectFloor(2, 3400, 0, 0, 5460, 7280)];
    const s = south([
      { u0: -300, z0: 6300, u1: 5840, z1: 6607 }, // 2 階: 東へ上がる 0.5 寸
      { u0: 5540, z0: 3802, u1: 9560, z1: 3400 }, // 下屋: 東へ下がる 1 寸
    ]);
    const h = roofHintsFromElevation(floors, [s], 0);
    expect(h.length).toBe(2);
    expect(h.find((x) => x.level === 2)).toMatchObject({ kind: 'shed', high: 'e', pitch: 0.5, isTop: true });
    expect(h.find((x) => x.level === 1)).toMatchObject({ kind: 'shed', high: 'w', pitch: 1, isTop: false });
  });
  it('幅の狭い塊（塔屋 0.9m）にも当たる。許容は幅に合わせて狭める（1.2m 外まで伸びた線は別の物）', () => {
    // 3 階は西の端の塔屋（0..940 × 2000..6000）だけ。塔屋の壁の天端 GL+9,200
    const floors = [rectFloor(1, 500, 0, 0, 9100, 7280, WIN), rectFloor(2, 3400, 0, 0, 9100, 7280), rectFloor(3, 6300, 0, 2000, 940, 6000)];
    const near = roofHintsFromElevation(floors, [south([{ u0: -280, z0: 9000, u1: 1160, z1: 9432 }])], 0);
    expect(near.find((x) => x.level === 3)).toMatchObject({ kind: 'shed', high: 'e', pitch: 3, isTop: true });
    const far = roofHintsFromElevation(floors, [south([{ u0: -280, z0: 9000, u1: 2300, z1: 9774 }])], 0);
    expect(far.find((x) => x.level === 3)).toBeUndefined();
  });
  it('階の高さが立面図から読めていないとき（標準値の推定）は、高さの照合を 1.4m まで緩める', () => {
    // 屋根の線の低い側の端が、推定した壁の天端（6,300）より 1.1m 低い
    const s = south([{ u0: -300, z0: 5200, u1: 9560, z1: 6186 }]);
    expect(roofHintsFromElevation(box2(), [s], 0, true).length).toBe(0);
    const h = roofHintsFromElevation(box2(), [s], 0, false);
    expect(h.length).toBe(1);
    expect(h[0]).toMatchObject({ level: 2, kind: 'shed', high: 'e', pitch: 1 });
  });
  it('窓で向きを確かめられた面が無ければ読まない・切り替えで止められる', () => {
    const noWin = view('S', [{ u0: -300, z0: 6300, u1: 9560, z1: 7286 }]);
    expect(roofHintsFromElevation(box2(), [noWin], 0).length).toBe(0);
    g.__NO_ELEV_ROOF = true;
    expect(roofHintsFromElevation(box2(), [south([{ u0: -300, z0: 6300, u1: 9560, z1: 7286 }])], 0).length).toBe(0);
  });
});

describe('読めた掛け方を屋根に入れる', () => {
  const model = (floors: Floor[], roofPatches?: RoofPatch[]): BuildingModel => ({ name: 't', floors, northAngleDeg: 0, ...(roofPatches ? { roofPatches } : {}) }) as unknown as BuildingModel;
  const hints = () => roofHintsFromElevation(box2(), [south([{ u0: -300, z0: 6300, u1: 9560, z1: 7286 }])], 0);
  it('塊ごとの手直し（立面図から）として入り、3D の屋根の塊がその掛け方になる', () => {
    const m = model(box2());
    expect(applyRoofHints(m, hints())).toBe(1);
    expect(m.roofPatches).toHaveLength(1);
    expect(m.roofPatches![0]).toMatchObject({ level: 2, kind: 'shed', high: 'e', pitch: 1, source: 'elevation' });
    const top = roofMasses(m, EXTERIOR_STYLES[0], 'gable').find((x) => x.isTop)!;
    expect(top.kind).toBe('shed');
    expect(top.high).toBe('e');
  });
  it('入れ直しても増えない。手で直した塊は上書きしない', () => {
    const m = model(box2());
    applyRoofHints(m, hints());
    applyRoofHints(m, hints());
    expect(m.roofPatches).toHaveLength(1);
    const manual: RoofPatch = { id: 'R2-x', level: 2, at: { x: 4000, y: 3000 }, kind: 'hip' };
    const m2 = model(box2(), [manual]);
    expect(applyRoofHints(m2, hints())).toBe(0);
    expect(m2.roofPatches).toEqual([manual]);
  });
  it('読めた塊が無くなれば、前に立面図から入れた分は消える', () => {
    const m = model(box2());
    applyRoofHints(m, hints());
    applyRoofHints(m, []);
    expect(m.roofPatches).toBeUndefined();
  });
});
