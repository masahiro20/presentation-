import { describe, it, expect } from 'vitest';
import { woodCheck } from '../src/parser/woodCheck';
import { floorPlanSvg } from '../src/drawings/plan';
import { parseSample } from './pdfNode';

describe('木造の常識チェック', () => {
  it('サンプル図面で位置（marks）つきの指摘が出て、平面図に赤表示できる', async () => {
    const model = await parseSample('sample_house_A3.pdf');
    const issues = woodCheck(model);
    expect(issues.length).toBeGreaterThan(0);
    // 2 階建てなので直下率の項目があり、乗っていない区間があれば線の位置を持つ
    const shita = issues.find((i) => i.id === 'shita-2');
    expect(shita).toBeTruthy();
    // 梁のスパンの指摘は部屋の内側の矩形を持つ
    const span = issues.find((i) => i.id.startsWith('span-'));
    expect(span?.marks?.[0].rects?.length).toBe(1);
    expect(span?.marks?.[0].label).toMatch(/スパン/);
    // 平面図に赤のラベルを重ねられる
    const f = model.floors[0];
    const marks = (span?.marks ?? []).filter((m) => m.level === f.level);
    const svg = floorPlanSvg(model, f, { marks });
    expect(svg).toContain('#d7263d');
    expect(svg).toContain('スパン');
    // marks を渡さなければ赤は出ない（資料・図面出力には載せない）
    expect(floorPlanSvg(model, f)).not.toContain('#d7263d');
  }, 60000);

  it('読み取りミスの疑い（つながらない短い壁）には「消す」の直し方が付く', async () => {
    const model = await parseSample('sample_house_A3.pdf');
    const f = model.floors[0];
    // わざと独立した短い壁を足す
    f.walls.push({ id: 'stub-test', a: { x: 100, y: 100 }, b: { x: 400, y: 100 }, thickness: 130, exterior: false } as (typeof f.walls)[number]);
    const issues = woodCheck(model);
    const stub = issues.find((i) => i.id === 'stub-1');
    expect(stub?.severity).toBe('warn');
    expect(stub?.fix?.label).toBe('消す');
    expect(stub?.marks?.[0].lines?.length).toBe(1);
    stub!.fix!.apply(model);
    expect(f.walls.some((w) => w.id === 'stub-test')).toBe(false);
  }, 60000);
});
