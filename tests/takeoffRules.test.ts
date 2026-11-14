// 見積の拾いの規則（吉田様邸の積算S との照合で直したもの）:
// ガレージの土間は外部ポーチに入れない・ガレージとポーチの天井は軒天・パラペットは最上階の外周だけ・下屋の塊にも軒樋・S 仕様の床はフロアタイル・S の設備の既定
import { describe, expect, it } from 'vitest';
import { takeoff } from '../src/estimate/areas';
import { newChoice } from '../src/estimate/calc';
import type { BuildingModel, Floor, Room, Vec2 } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
let seq = 0;
const room = (name: string, type: Room['type'], poly: Vec2[], extra: Partial<Room> = {}): Room => {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { id: `r${seq++}`, name, type, polygon: poly, labelPos: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }, area: ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / 1e6, ...extra };
};
const floor = (level: number, outline: Vec2[][], rooms: Room[], height = 2900, ceilingHeight = 2400): Floor => ({ level, elevation: 500 + (level - 1) * 2900, height, ceilingHeight, outline, rooms, walls: [], openings: [], stairs: [] });

/** 1 階: 母屋 10 × 8 m（LDK・玄関）＋ 離れたビルトインガレージ 6 × 7 m（別の屋根の塊）。2 階: 5 × 6 m が母屋の上に載る */
function model(): BuildingModel {
  const main = rect(0, 0, 10000, 8000);
  const garage = rect(12000, 2000, 18000, 9000);
  const f1 = floor(1, [main, garage], [room('ＬＤＫ', 'ldk', rect(0, 0, 10000, 6000)), room('玄関', 'entrance', rect(0, 6000, 2000, 8000)), room('洗面', 'washroom', rect(2000, 6000, 10000, 8000)), room('車庫', 'garage', garage, { garageKind: 'builtin' })], 3200, 2700);
  const f2 = floor(2, [rect(2000, 1000, 7000, 7000)], [room('洋室', 'bedroom', rect(2000, 1000, 7000, 7000))], 2800);
  return { name: 't', floors: [f1, f2], northAngleDeg: 0, report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} } };
}
const opts = { grade: 'P' as const, eavesMm: 100, pitch: 0.5, roofType: 'shed' as const };

describe('見積の拾い（吉田様邸の積算と合わせた規則）', () => {
  it('ガレージは施工面積に入り、外部ポーチには入らない。ガレージの天井は軒天に入り断熱には入らない', () => {
    const a = takeoff(model(), opts);
    expect(a.garageArea).toBeCloseTo(42, 1);
    expect(a.extraArea).toBeCloseTo(42, 1);
    expect(a.porchOut).toBeCloseTo(2.48, 2); // ポーチの区画が無いので御社の標準
    expect(a.soffitArea).toBeGreaterThanOrEqual(42); // ガレージの天井 42 ㎡ ＋ 軒の出の裏
    expect(a.insulArea).toBeCloseTo(80, 0); // 母屋の天井だけ（ガレージは断熱しない）
  });
  it('パラペットは最上階の外周だけ（下屋の縁には付けない）', () => {
    const a = takeoff(model(), opts);
    // 1 階 外周 (36 + 26) × (3.2 + 0.5) ＋ 2 階 外周 22 × 2.8 ＋ パラペット 22 × 0.9
    expect(a.extWall).toBeCloseTo(62 * 3.7 + 22 * 2.8 + 22 * 0.9, 0);
  });
  it('片流れの軒先: 最上階の短辺に、上の階がほとんど載らない下屋の塊（ガレージ・母屋）の短辺を足す', () => {
    const a = takeoff(model(), opts);
    // 2 階 5 m ＋ 軒 0.2 ＋ 母屋 8 m（2 階は 30/80 しか載らない）＋ ガレージ 6 m
    expect(a.eaveLen).toBeCloseTo(5.2 + 8 + 6, 1);
  });
  it('高天井: 階の天井高（階高 3,200 → 2,700）が 2,500 を超える分 × 床面積', () => {
    const a = takeoff(model(), opts);
    // 1 階 80 ㎡ × 0.2 m（ガレージは除く）
    expect(a.highCeil).toBeCloseTo(16, 1);
  });
  it('S 仕様: 既定の床はフロアタイル（木の床に変えた部屋は挽板のまま）、太陽光なし・エコジョーズ・空調なし', () => {
    const m = model();
    const p = takeoff(m, opts);
    expect(p.flooringArea).toBeCloseTo(60 + 30, 1);
    expect(p.floorTileArea).toBeCloseTo(16, 1);
    const s = takeoff(m, { ...opts, grade: 'S' });
    expect(s.flooringArea).toBe(0);
    expect(s.floorTileArea).toBeCloseTo(16 + 90, 1);
    m.floors[0].rooms[0].floorFinish = 'wood';
    const s2 = takeoff(m, { ...opts, grade: 'S' });
    expect(s2.flooringArea).toBeCloseTo(60, 1);
    const g = newChoice('S').groups;
    expect(g.pv).toBe('eq.pvNone');
    expect(g.water).toBe('eq.ecojozu');
    expect(g.ac).toBe('eq.acNone');
    const gp = newChoice('P').groups;
    expect(gp.pv).toBe('eq.pv43');
    expect(gp.water).toBe('eq.ecocute360');
    expect(gp.ac).toBe('eq.acFloor');
  });
});
