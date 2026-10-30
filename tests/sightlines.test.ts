import { describe, it, expect } from 'vitest';
import { sightlineCheck, type NeighborWorld } from '../src/core/sightlines';
import { parseSample } from './pdfNode';

/** 家の外形（1 階）の端から dist m 外側に、その辺に沿った隣家の壁を置く */
function neighborOutside(model: Awaited<ReturnType<typeof parseSample>>, side: 'minX' | 'maxX', dist: number, height: number): NeighborWorld {
  const f = model.floors[0];
  const pts = f.outline.flat();
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = (side === 'minX' ? Math.min(...xs) - dist * 1000 : Math.max(...xs) + dist * 1000) * 0.001;
  const w = side === 'minX' ? -8 : 8;
  const z0 = Math.min(...ys) * 0.001;
  const z1 = Math.max(...ys) * 0.001;
  return { ring: [{ x, z: z0 }, { x: x + w, z: z0 }, { x: x + w, z: z1 }, { x, z: z1 }], height, label: 'テスト隣家' };
}

describe('隣家からの視線', () => {
  it('隣家が無ければ何も挙げない', async () => {
    const model = await parseSample('sample_house_A3.pdf');
    expect(sightlineCheck(model, [])).toEqual([]);
  });

  it('外形のすぐ外に 2 階建ての隣家を置くと、その側の窓が「近い」として挙がり、遠い隣家は低い扱いになる', async () => {
    const model = await parseSample('sample_house_A3.pdf');
    const near = neighborOutside(model, 'maxX', 2, 7);
    const issues = sightlineCheck(model, [near]);
    expect(issues.length).toBeGreaterThan(0);
    // 近い壁 → high、どれも 10m 以内
    expect(issues[0].risk).toBe('high');
    for (const i of issues) {
      expect(i.dist).toBeLessThanOrEqual(10);
      expect(i.advice.length).toBeGreaterThan(5);
      expect(i.neighborLabel).toBe('テスト隣家');
      expect(['北', '北東', '東', '南東', '南', '南西', '西', '北西']).toContain(i.facing);
    }
    // 1 階の窓を 7m の隣家は見下ろせる（窓の中心 + 2.2m より高い）
    expect(issues.some((i) => i.level === 1 && i.fromAbove)).toBe(true);
    // 9m 離すと low だけになる
    const far = neighborOutside(model, 'maxX', 9, 7);
    const farIssues = sightlineCheck(model, [far]);
    expect(farIssues.every((i) => i.risk === 'low')).toBe(true);
    // 平屋のカーポート（高さ 2.5m）は 2 階の窓を覗けない
    const low = neighborOutside(model, 'maxX', 2, 2.5);
    expect(sightlineCheck(model, [low]).every((i) => i.level === 1)).toBe(true);
  });

  it('反対側の隣家は、その側の窓しか挙げない（正面 ±65° の壁だけ）', async () => {
    const model = await parseSample('sample_house_A3.pdf');
    const left = neighborOutside(model, 'minX', 3, 7);
    const issues = sightlineCheck(model, [left]);
    expect(issues.length).toBeGreaterThan(0);
    const minX = Math.min(...model.floors[0].outline.flat().map((p) => p.x));
    for (const i of issues) expect(i.plan.x - minX).toBeLessThan(1500);
  });
});
