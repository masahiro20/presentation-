import { describe, expect, it } from 'vitest';
import { parseSample } from './pdfNode';
import { compassToSide, parseRoadWidth } from '../src/parser/site';

describe('sample_house_site.pdf（1文字ずつの文字・縦書き・縮小印刷・敷地と道路）', async () => {
  const model = await parseSample('sample_house_site.pdf');

  it('「S=1/100」表記でも帖数から実際の縮尺 1/150 を求める', () => {
    expect(model.report.scaleSource).toBe('area');
    expect(model.report.scaleDenominator).toBe(150);
  });

  it('外形寸法が正しい', () => {
    const f2 = model.floors[1];
    const pts = f2.outline.flat();
    const w = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
    expect(Math.abs(w - 9100)).toBeLessThan(80);
  });

  it('1文字ずつの室名・縦書きの室名を読む', () => {
    const names = model.floors.flatMap((f) => f.rooms.map((r) => r.name));
    for (const n of ['LDK', '和室', '浴室', '洗面室', 'トイレ', '主寝室', '洋室1', '洋室2', '書斎', 'WIC', '納戸']) expect(names).toContain(n);
    expect(model.floors[1].rooms.some((r) => r.type === 'hall' && r.name === 'ホール')).toBe(true);
  });

  it('道路は図面の右（東）・幅員6m', () => {
    expect(model.site?.roads).toHaveLength(1);
    expect(model.site!.roads[0].side).toBe('right');
    expect(model.site!.roads[0].widthMm).toBe(6000);
  });

  it('敷地境界線と敷地面積', () => {
    const b = model.site!.bounds;
    // 1階外壁芯の左上が原点。道路境界は建物の右 5.5m、その他は 2.4m / 2.6m
    expect(Math.abs(b.right! - (9100 + 5500))).toBeLessThan(150);
    expect(Math.abs(b.left! + 2400)).toBeLessThan(150);
    expect(Math.abs(b.top! + 2400)).toBeLessThan(150);
    expect(Math.abs(b.bottom! - (7280 + 2600))).toBeLessThan(150);
    expect(model.site!.areaM2).toBeCloseTo(165.3);
  });
});

describe('接道の表記', () => {
  it('幅員', () => {
    expect(parseRoadWidth('幅員4.0m')).toBe(4000);
    expect(parseRoadWidth('W=6000')).toBe(6000);
    expect(parseRoadWidth('4m道路')).toBe(4000);
    expect(parseRoadWidth('道路')).toBeNull();
  });
  it('方位 → 図面の辺（方位記号の回転も考慮）', () => {
    expect(compassToSide('南', 0)).toBe('bottom');
    expect(compassToSide('東', 0)).toBe('right');
    expect(compassToSide('北', 90)).toBe('right');
  });
});
