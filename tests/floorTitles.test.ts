import { describe, expect, it } from 'vitest';
import { assignFloorTitles, type MmText, type PageMm, type PlanData } from '../src/parser/assemble';

// 「N階 平面図 S:1/100」の見出しは ARCHITREND の書き出しで「1 階」「平 面 図」「S : 1 / 1 0 0」の 3 つに分かれる
function title(floor: number, x: number, y: number, size = 398): MmText[] {
  return [
    { str: `${floor} 階`, x, y, size, angle: 0 },
    { str: '平 面 図', x: x + 1450, y, size, angle: 0 },
    { str: 'S : 1 / 1 0 0', x: x + 3450, y, size, angle: 0 },
  ];
}

function plan(minX: number, minY: number, w: number, h: number): PlanData {
  const bbox = { minX, minY, maxX: minX + w, maxY: minY + h };
  return { pageIndex: 0, bbox, floorHint: null, walls: [], texts: [], segs: [], arcs: [], siteTexts: [], siteSegs: [], wallPolys: [], sashPolys: [], roomFills: [] };
}

function page(texts: MmText[]): PageMm {
  return { pageIndex: 0, segs: [], arcs: [], texts, fills: [], masks: [], colorFills: [] };
}

describe('階の見出しの割り当て（図面名は図の下）', () => {
  it('右に 3 階・2 階が上下に並ぶ図面: 3 階の見出しは下の 2 階の図のほうが近いが、図の「上」なので 3 階の図に付く（田中様邸）', () => {
    const p3 = plan(23965, 4060, 13763, 5563); // 右上
    const p1 = plan(3954, 11151, 13754, 5567); // 左
    const p2 = plan(23956, 15701, 13771, 5563); // 右下
    const texts = [...title(3, 28668, 12849), ...title(1, 9353, 23440), ...title(2, 28653, 25371)];
    assignFloorTitles([p3, p1, p2], [page(texts)]);
    expect([p1.floorHint, p2.floorHint, p3.floorHint]).toEqual([1, 2, 3]);
  });

  it('小さな 2 階の図の 6.6 m 下（面積表を挟んで）にある見出しも拾う（吉田様邸 1st-2）', () => {
    const p2 = plan(30886, 7802, 5567, 5567);
    const p1 = plan(3828, 5986, 17152, 13526);
    const texts = [...title(2, 33894, 19990), ...title(1, 13875, 24541)];
    assignFloorTitles([p2, p1], [page(texts)]);
    expect(p1.floorHint).toBe(1);
    expect(p2.floorHint).toBe(2);
  });

  it('図面名欄の「1階 平面図,2階 平面図」は見出しにしない', () => {
    const p1 = plan(9374, 11900, 10065, 9205);
    const p2 = plan(26798, 11891, 6930, 6938);
    const texts = [
      ...title(2, 30949, 24297),
      ...title(1, 10698, 25194),
      { str: '1 階', x: 3834, y: 28165, size: 349, angle: 0 },
      { str: '平 面 図 , 2 階', x: 5647, y: 28165, size: 349, angle: 0 },
      { str: '平 面 図', x: 8000, y: 28165, size: 349, angle: 0 },
    ];
    assignFloorTitles([p1, p2], [page(texts)]);
    expect(p1.floorHint).toBe(1);
    expect(p2.floorHint).toBe(2);
  });
});
