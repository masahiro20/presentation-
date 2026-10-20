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

  it('通れない幅・狭い戸・重なった壁を見つける', async () => {
    const model = await parseSample('sample_house_A3.pdf');
    const f = model.floors[0];
    // 幅 455 のホールを足す（柱芯 455 → 内法 325 は通れない）
    f.rooms.push({ id: 'hall-test', name: '廊下', type: 'hall', polygon: [{ x: 20000, y: 0 }, { x: 20455, y: 0 }, { x: 20455, y: 3640 }, { x: 20000, y: 3640 }], area: 1.66, labelPos: { x: 20227, y: 1820 } });
    // 幅 500 の戸
    const wall = f.walls.find((w) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) > 2000)!;
    f.openings.push({ id: 'door-test', wallId: wall.id, kind: 'door', t0: 300, t1: 800, sill: 0, height: 2000 });
    // 同じ場所に重なった壁（壁と直角の向きに 100mm ずらして平行）
    const L = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y);
    const nx = (-(wall.b.y - wall.a.y) / L) * 100;
    const ny = ((wall.b.x - wall.a.x) / L) * 100;
    f.walls.push({ id: 'dup-test', a: { x: wall.a.x + nx, y: wall.a.y + ny }, b: { x: wall.b.x + nx, y: wall.b.y + ny }, thickness: 130, exterior: false } as (typeof f.walls)[number]);
    const issues = woodCheck(model);
    const narrow = issues.find((i) => i.id === 'narrow-1-hall-test');
    expect(narrow?.severity).toBe('warn');
    expect(narrow?.title).toContain('通れません');
    expect(narrow?.marks?.[0].lines?.length).toBe(1);
    const door = issues.find((i) => i.id === 'door-1');
    expect(door?.severity).toBe('warn');
    expect(door?.detail).toContain('500');
    const dup = issues.find((i) => i.id === 'dup-1');
    expect(dup?.severity).toBe('warn');
    expect(dup?.fix?.label).toBe('片方を消す');
    dup!.fix!.apply(model);
    expect(f.walls.some((w) => w.id === 'dup-test')).toBe(false);
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
