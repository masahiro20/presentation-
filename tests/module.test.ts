import { describe, expect, it } from 'vitest';
import { chooseModule, fitModule, snapCoord, snapRect, woodWallThickness, moduleAcceptable } from '../src/parser/module';
import { parseSample } from './pdfNode';

/** 格子に乗った壁（縦横）を作る。noise で読み取りのずれを模す */
function gridWalls(grid: number, phase: number, noise = 0) {
  const walls: { a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
  let k = 0;
  const jitter = () => (noise ? ((k++ % 7) - 3) * (noise / 3) : 0);
  for (let i = 0; i <= 8; i += 2) {
    const x = phase + i * grid + jitter();
    walls.push({ a: { x, y: 0 }, b: { x, y: 7280 } });
  }
  for (let j = 0; j <= 16; j += 4) {
    const y = phase + j * grid + jitter();
    walls.push({ a: { x: 0, y }, b: { x: 3640, y } });
  }
  return walls;
}

describe('木造モジュール', () => {
  it('snapCoord は位相つきの格子へ丸める', () => {
    expect(snapCoord(920, 0, 455)).toBe(910);
    expect(snapCoord(1350, 0, 455)).toBe(1365);
    expect(snapCoord(1350, 100, 455)).toBe(1465);
    expect(snapCoord(-30, 0, 455)).toBe(0);
  });

  it('尺モジュールの図面は 910 と判定し、位相を復元する', () => {
    const m = fitModule(gridWalls(455, 120, 60), 910);
    expect(m.size).toBe(910);
    expect(m.walls).toBe(10);
    expect(m.onGrid).toBeGreaterThan(0.95);
    expect(Math.abs(m.phaseX - 120)).toBeLessThan(25);
    expect(Math.abs(m.phaseY - 120)).toBeLessThan(25);
    expect(moduleAcceptable(m)).toBe(true);
    expect(chooseModule(gridWalls(455, 120, 60), 'auto')?.size).toBe(910);
  });

  it('メーターモジュールの図面は 1000 と判定する', () => {
    const c = chooseModule(gridWalls(500, 0, 40), 'auto');
    expect(c?.size).toBe(1000);
    expect(c?.grid).toBe(500);
  });

  it('格子に乗らない壁（自由な寸法）は寄せない', () => {
    const walls = [0, 613, 1377, 2290, 2902, 3815, 4411].map((x) => ({ a: { x, y: 0 }, b: { x, y: 6000 } }));
    walls.push(...[0, 777, 1690, 2401, 3333].map((y) => ({ a: { x: 0, y }, b: { x: 5000, y } })));
    expect(chooseModule(walls, 'auto')).toBeNull();
    // 手で指定すればその格子を返す（乗っていない壁はそのまま）
    expect(chooseModule(walls, 'shaku')?.size).toBe(910);
    expect(chooseModule(walls, 'none')).toBeNull();
  });

  it('snapRect は辺を格子へ寄せ、小さくなりすぎるときは触らない', () => {
    const m = { grid: 455, phaseX: 0, phaseY: 0 };
    expect(snapRect({ minX: 905, maxX: 1830, minY: 20, maxY: 1810 }, m, 200, 700)).toEqual({ minX: 910, maxX: 1820, minY: 0, maxY: 1820 });
    // 幅 300 の矩形は両辺が同じ線へ寄ってしまうので動かさない
    expect(snapRect({ minX: 300, maxX: 600, minY: 0, maxY: 1820 }, m, 200, 700)).toEqual({ minX: 300, maxX: 600, minY: 0, maxY: 1820 });
  });

  it('壁厚は在来木造の標準（外壁 160・内壁 130・薄壁 75）にそろえる', () => {
    expect(woodWallThickness({ thickness: 150, exterior: true })).toBe(160);
    expect(woodWallThickness({ thickness: 120, exterior: false })).toBe(130);
    expect(woodWallThickness({ thickness: 60, exterior: false })).toBe(75);
  });

  it('サンプル図面: 壁芯が 455 格子に乗り、外形は 455 の倍数、壁厚は 130／160 になる', async () => {
    const m = await parseSample('sample_house_A3.pdf');
    expect(m.module?.size).toBe(910);
    expect(m.module?.snapped).toBe(true);
    expect(m.module?.fit).toBeGreaterThan(0.9);
    expect(m.report.wallThicknesses).toEqual([130, 160]);
    const f1 = m.floors[0];
    const onGrid = (v: number, phase: number) => Math.abs(snapCoord(v, phase, 455) - v) < 1;
    // 縦横の壁の芯
    let axis = 0;
    let total = 0;
    for (const w of f1.walls) {
      const horiz = Math.abs(w.a.y - w.b.y) < 1;
      const vert = Math.abs(w.a.x - w.b.x) < 1;
      if (!horiz && !vert) continue;
      total++;
      if (horiz ? onGrid(w.a.y, m.module!.phaseY) : onGrid(w.a.x, m.module!.phaseX)) axis++;
    }
    expect(axis / total).toBeGreaterThan(0.9);
    // 外形の寸法
    const o = f1.outline[0];
    const xs = o.map((p) => p.x);
    const ys = o.map((p) => p.y);
    expect((Math.max(...xs) - Math.min(...xs)) % 455).toBeCloseTo(0, 0);
    expect((Math.max(...ys) - Math.min(...ys)) % 455).toBeCloseTo(0, 0);
    // 開口は壁の範囲に収まる
    for (const op of f1.openings) {
      const w = f1.walls.find((q) => q.id === op.wallId)!;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      expect(op.t0).toBeGreaterThanOrEqual(0);
      expect(op.t1).toBeLessThanOrEqual(L + 0.5);
      expect(op.t1 - op.t0).toBeGreaterThan(100);
    }
  });
});
