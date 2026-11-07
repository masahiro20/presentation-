// 屋根の塊ごとの手直し（RoofPatch）: 塊の一覧・点からの選択・掛け方の反映
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildRoofs, roofMassAt, roofMasses } from '../src/scene/roof';
import type { MeshBuilder } from '../src/scene/meshBuilder';
import { exteriorById } from '../src/styles/presets';
import type { BuildingModel, Floor, Vec2 } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const floor = (level: number, elevation: number, outline: Vec2[][]): Floor => ({ level, elevation, height: 2900, ceilingHeight: 2400, walls: [], openings: [], rooms: [], stairs: [], outline });
/** 1 階は 12m × 8m、2 階は西側 7m × 8m だけ（東 5m は下屋） */
const model = (): BuildingModel => ({
  name: 't',
  floors: [floor(1, 500, [rect(0, 0, 12000, 8000)]), floor(2, 3400, [rect(0, 0, 7000, 8000)])],
  northAngleDeg: 0,
  report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} },
});
const style = exteriorById('hl-jolypat-grey');
/** 屋根の面（ext.roof）が図面座標 (xMm, yMm) の真上を覆っているか（三角形の平面への投影で判定） */
const roofCovers = (mb: MeshBuilder, xMm: number, yMm: number): boolean => {
  const g = mb.build(() => new THREE.MeshBasicMaterial());
  const mesh = g.children.find((c) => c.name === 'ext.roof') as THREE.Mesh | undefined;
  if (!mesh) return false;
  const pos = mesh.geometry.getAttribute('position');
  const px = xMm / 1000;
  const pz = yMm / 1000;
  for (let i = 0; i + 2 < pos.count; i += 3) {
    const [ax, az, bx, bz, cx, cz] = [pos.getX(i), pos.getZ(i), pos.getX(i + 1), pos.getZ(i + 1), pos.getX(i + 2), pos.getZ(i + 2)];
    const s = (bx - ax) * (pz - az) - (bz - az) * (px - ax);
    const t = (cx - bx) * (pz - bz) - (cz - bz) * (px - bx);
    const u = (ax - cx) * (pz - cz) - (az - cz) * (px - cx);
    if ((s >= -1e-6 && t >= -1e-6 && u >= -1e-6) || (s <= 1e-6 && t <= 1e-6 && u <= 1e-6)) return true;
  }
  return false;
};

describe('roofMasses / roofMassAt', () => {
  it('最上階の塊と下屋の塊に分かれ、下屋は上の階に接する辺が分かる', () => {
    const ms = roofMasses(model(), style, 'gable');
    expect(ms.map((m) => `${m.level}:${m.kind}:${m.isTop}`).sort()).toEqual(['1:shed:false', '2:gable:true']);
    const lower = ms.find((m) => m.level === 1)!;
    expect(lower.attached).toEqual(['w']);
    expect(lower.high).toBe('w');
    expect(lower.bbox).toEqual({ minX: 7000, minY: 0, maxX: 12000, maxY: 8000 });
  });
  it('点から塊を選ぶ（上の階を優先。軒の出のぶん外でも当たる）', () => {
    const ms = roofMasses(model(), style, 'gable');
    expect(roofMassAt(ms, { x: 2000, y: 2000 })?.level).toBe(2);
    expect(roofMassAt(ms, { x: 9000, y: 4000 })?.level).toBe(1);
    expect(roofMassAt(ms, { x: 12400, y: 4000 }, 700)?.level).toBe(1);
    expect(roofMassAt(ms, { x: 20000, y: 4000 }, 700)).toBeNull();
  });
});

describe('RoofPatch', () => {
  it('塊の中の点で手直しが当たり、掛け方・向きが変わる', () => {
    const m = model();
    m.roofPatches = [
      { id: 'a', level: 1, at: { x: 9000, y: 4000 }, kind: 'gable', ridge: 'z', pitch: 4 },
      { id: 'b', level: 2, at: { x: 3000, y: 3000 }, kind: 'shed', high: 's' },
    ];
    const ms = roofMasses(m, style, 'gable');
    const lower = ms.find((x) => x.level === 1)!;
    const top = ms.find((x) => x.level === 2)!;
    expect(lower.kind).toBe('gable');
    expect(lower.patch?.id).toBe('a');
    expect(top.kind).toBe('shed');
    expect(top.high).toBe('s');
    // 塊の外の点の手直しは当たらない
    m.roofPatches = [{ id: 'c', level: 1, at: { x: 3000, y: 3000 }, kind: 'flat' }];
    expect(roofMasses(m, style, 'gable').find((x) => x.level === 1)!.kind).toBe('shed');
  });
  it('3D の屋根に反映される: 最上階を陸屋根にすると最高高さがパラペットの天端になる', () => {
    const m = model();
    const gable = buildRoofs(m, style, 'gable', 4);
    m.roofPatches = [{ id: 'a', level: 2, at: { x: 3000, y: 3000 }, kind: 'flat', parapet: 900 }];
    const flat = buildRoofs(m, style, 'gable', 4);
    const H2 = (3400 + 2750) / 1000;
    expect(flat.info.maxY).toBeCloseTo(H2 + 0.9, 3);
    expect(gable.info.maxY).toBeGreaterThan(flat.info.maxY);
    // 下屋を切妻・勾配 4 寸にしても作れる（上の階に接する辺は軒を出さない）
    m.roofPatches = [{ id: 'b', level: 1, at: { x: 9000, y: 4000 }, kind: 'gable', pitch: 4, eaves: 0 }];
    expect(() => buildRoofs(m, style, 'gable', 4)).not.toThrow();
    m.roofPatches = [{ id: 'c', level: 1, at: { x: 9000, y: 4000 }, kind: 'hip', ridge: 'x' }];
    expect(() => buildRoofs(m, style, 'shed', 0.5)).not.toThrow();
  });
});

describe('手で描いた屋根（RoofPatch.loop）と屋根なしの範囲（omit）', () => {
  /** L 字（下屋の上に、東西 4m × 南北 6m から南西の 2 × 3 を欠いた形） */
  const L: Vec2[] = [
    { x: 8000, y: 1000 },
    { x: 12000, y: 1000 },
    { x: 12000, y: 7000 },
    { x: 10000, y: 7000 },
    { x: 10000, y: 4000 },
    { x: 8000, y: 4000 },
  ];
  it('多角形の屋根が塊になり、at が範囲の外（L 字の重心）でも塊の中の点が目印になる', () => {
    const m = model();
    m.roofPatches = [{ id: 'L', level: 1, at: { x: 9200, y: 5200 }, loop: L, kind: 'gable', pitch: 4 }];
    const ms = roofMasses(m, style, 'shed');
    const manual = ms.filter((x) => x.manual);
    expect(manual.length).toBeGreaterThanOrEqual(1);
    expect(manual[0].kind).toBe('gable');
    expect(manual[0].bbox).toEqual({ minX: 8000, minY: 1000, maxX: 12000, maxY: 7000 });
    // 目印の点は塊の四角形の中（at 9200,5200 は欠いた所なので使わない）
    const c = manual[0].center;
    expect(manual[0].rects.some((r) => c.x >= r.minX && c.x <= r.maxX && c.y >= r.minY && c.y <= r.maxY)).toBe(true);
    // 点から選べる（欠いた所では当たらず、下屋の塊が当たる）
    expect(roofMassAt(ms, { x: 11000, y: 5000 }, 0)?.manual).toBe(true);
    expect(roofMassAt(ms, { x: 9000, y: 6000 }, 0)?.manual).toBeUndefined();
    expect(() => buildRoofs(m, style, 'shed')).not.toThrow();
  });
  it('手で描いた範囲は自動の塊から除かれる（二重に掛からない）', () => {
    const m = model();
    const base = roofMasses(m, style, 'shed').find((x) => x.level === 1 && !x.manual)!;
    const baseArea = base.rects.reduce((s, r) => s + (r.maxX - r.minX) * (r.maxY - r.minY), 0);
    m.roofPatches = [{ id: 'L', level: 1, at: { x: 11000, y: 5000 }, loop: L }];
    const auto = roofMasses(m, style, 'shed').filter((x) => x.level === 1 && !x.manual);
    const autoArea = auto.reduce((s, ms) => s + ms.rects.reduce((t, r) => t + (r.maxX - r.minX) * (r.maxY - r.minY), 0), 0);
    // 下屋 5 × 8 = 40 ㎡ から L 字 18 ㎡ を除く
    expect(baseArea).toBeCloseTo(40e6, -3);
    expect(autoArea).toBeCloseTo(22e6, -3);
    // 自動の塊の手直しとしては拾われない（at が下屋の中でも）
    expect(auto.every((x) => !x.patch)).toBe(true);
  });
  it('屋根なしの範囲: 塊の一覧には omit として入り、3D には描かれず、自動の屋根からも除かれる', () => {
    const m = model();
    const full = buildRoofs(m, style, 'shed');
    m.roofPatches = [{ id: 'O', level: 1, at: { x: 11000, y: 5000 }, loop: L, omit: true }];
    const ms = roofMasses(m, style, 'shed');
    const om = ms.find((x) => x.omit)!;
    expect(om).toBeDefined();
    expect(om.manual).toBe(true);
    expect(roofMassAt(ms, { x: 11000, y: 5000 }, 0)?.omit).toBe(true);
    const cut = buildRoofs(m, style, 'shed');
    expect(cut.mb.isEmpty()).toBe(false);
    // 屋根なしの範囲の中（11, 5）には屋根の面が無く、範囲の外（欠いた所 9, 6）には残る
    expect(roofCovers(full.mb, 11000, 5000)).toBe(true);
    expect(roofCovers(cut.mb, 11000, 5000)).toBe(false);
    expect(roofCovers(cut.mb, 9000, 6000)).toBe(true);
  });
});

describe('足した屋根（RoofPatch.rect）', () => {
  it('塊の一覧に「足した屋根」として入り、自動の塊の手直しとは混ざらない', () => {
    const m = model();
    // 1 階の東の庭（外形の外）に 3 × 4 m の屋根を足す。自動の塊の中（下屋の上）にも 1 つ
    m.roofPatches = [
      { id: 'A', level: 1, at: { x: 14500, y: 2000 }, rect: { minX: 13000, minY: 0, maxX: 16000, maxY: 4000 } },
      { id: 'B', level: 1, at: { x: 9000, y: 6000 }, rect: { minX: 8000, minY: 5000, maxX: 10000, maxY: 7000 }, kind: 'gable', pitch: 4 },
    ];
    const ms = roofMasses(m, style, 'shed');
    const manual = ms.filter((x) => x.manual);
    expect(manual).toHaveLength(2);
    expect(manual.find((x) => x.patch?.id === 'A')!.kind).toBe('shed'); // 既定は緩い片流れ
    expect(manual.find((x) => x.patch?.id === 'B')!.kind).toBe('gable');
    // 下屋の塊は手直し無しのまま（B は塊の手直しとして拾われない）
    expect(ms.find((x) => !x.manual && x.level === 1)!.patch).toBeUndefined();
    // 点から選ぶ: 庭の屋根はそこだけ、下屋の上の足した屋根は自動の塊より優先
    expect(roofMassAt(ms, { x: 14500, y: 2000 })?.patch?.id).toBe('A');
    expect(roofMassAt(ms, { x: 9000, y: 6000 })?.patch?.id).toBe('B');
    expect(roofMassAt(ms, { x: 11000, y: 2000 })?.manual).toBeUndefined();
  });
  it('足した屋根が描かれる（外形の外にも屋根ができ、高さの指定が効く）', () => {
    const m = model();
    const base = buildRoofs(m, style, 'shed').info;
    m.roofPatches = [{ id: 'A', level: 1, at: { x: 14500, y: 2000 }, rect: { minX: 13000, minY: 0, maxX: 16000, maxY: 4000 }, kind: 'gable', pitch: 4 }];
    const withRoof = buildRoofs(m, style, 'shed');
    expect(withRoof.mb.isEmpty()).toBe(false);
    // 切妻 4 寸・短辺 3 m → 棟は軒より 0.6 m 高い。1 階の壁の天端より上になる
    expect(withRoof.info.maxY).toBeGreaterThanOrEqual(base.maxY - 0.01);
    m.roofPatches[0].topMm = 2200;
    m.roofPatches[0].kind = 'flat';
    const low = buildRoofs(m, style, 'shed');
    expect(low.mb.isEmpty()).toBe(false);
    expect(low.info.maxY).toBeGreaterThanOrEqual(base.maxY - 0.01);
  });
});
