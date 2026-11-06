// 屋根の塊ごとの手直し（RoofPatch）: 塊の一覧・点からの選択・掛け方の反映
import { describe, expect, it } from 'vitest';
import { buildRoofs, roofMassAt, roofMasses } from '../src/scene/roof';
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
