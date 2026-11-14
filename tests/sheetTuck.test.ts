// 図面シートの並べ方: 横に並べて入らないとき、最後の図を右上の表の下に入れて 1/100 を保つ（drawings/sheet.ts）
import { describe, expect, it } from 'vitest';
import { composeSheet, sheetScale } from '../src/drawings/sheet';
import { exteriorQuantityRows, exteriorQuantityStripSvg } from '../src/drawings/quantities';
import { SHEET_TOP_W } from '../src/drawings/sheet';
import type { BuildingModel, Floor, Room } from '../src/core/types';

const info = { project: 'テスト様邸 新築計画', drawing: '平面図（1階・2階）', date: '2026.11.14', designer: '' };
const panel = (w: number, h: number, id: string) => ({ inner: `<rect id="${id}" width="${w}" height="${h}"/>`, vb: { x: 0, y: 0, w, h } });
// 面積表（幅 8.4 m・高さ 3.1 m 相当）
const table = { svg: '<rect id="tbl" width="8400" height="3100"/>', w: 8400, h: 3100 };

describe('最後の図を表の下に入れる並べ方', () => {
  // 敷地ごと描いた 1 階（27.5 m × 25 m）と 2 階（8.6 m × 12.6 m）: 横に並べると 1/100 に入らない
  const big = panel(27500, 25000, 'p1');
  const small = panel(8600, 12600, 'p2');

  it('横に並べると 1/150、2 階を表の下に入れると 1/100', () => {
    expect(sheetScale([big, small], { right: table, gap: 600, tuck: false })).toBe(150);
    expect(sheetScale([big, small], { right: table, gap: 600 })).toBe(100);
  });

  it('2 階は表の下・右の列の中、1 階はその左。図どうしも表とも重ならない', () => {
    const svg = composeSheet([big, small], info, { right: table, gap: 600 });
    expect(svg).toContain('>1/100<');
    const pos = (id: string) => {
      const m = svg.match(new RegExp(`<g transform="translate\\((-?\\d+) (-?\\d+)\\)">(?:<rect[^>]*pointer-events[^>]*/>)?<rect id="${id}"`));
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    };
    const p1 = pos('p1')!;
    const p2 = pos('p2')!;
    const tb = pos('tbl')!;
    expect(p1 && p2 && tb).toBeTruthy();
    // 2 階は表より下で、1 階の右
    expect(p2.y).toBeGreaterThanOrEqual(tb.y + table.h + 600);
    expect(p2.x).toBeGreaterThanOrEqual(p1.x + big.vb.w);
    // 紙（42,000 × 29,700）の中に収まる
    expect(p2.x + small.vb.w).toBeLessThanOrEqual(42000 - 800);
    expect(p2.y + small.vb.h).toBeLessThanOrEqual(29700 - 800 - 2000);
    expect(p1.x).toBeGreaterThanOrEqual(800);
  });

  it('横に並べて入るときは、今までどおり横に並べる（2 階は表の下に行かない）', () => {
    const a = panel(12000, 11000, 'p1');
    const b = panel(9000, 10000, 'p2');
    const svg = composeSheet([a, b], info, { right: table, gap: 600 });
    const same = composeSheet([a, b], info, { right: table, gap: 600, tuck: false });
    expect(svg).toBe(same);
  });

  it('縦に積む指定・図が 1 枚のときは使わない', () => {
    expect(sheetScale([big, small], { right: table, gap: 600, stack: 'col' })).toBe(sheetScale([big, small], { right: table, gap: 600, stack: 'col', tuck: false }));
    expect(sheetScale([big], { right: table, gap: 600 })).toBe(sheetScale([big], { right: table, gap: 600, tuck: false }));
  });
});

describe('外部数量の帯（立面図シートの外部仕上表の下）', () => {
  const rect = (x0: number, y0: number, x1: number, y1: number) => [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  const room = (id: string, name: string, type: Room['type'], poly: { x: number; y: number }[]): Room => ({ id, name, type, polygon: poly, area: 60 }) as Room;
  const floor = (level: number, outline: { x: number; y: number }[][], rooms: Room[]): Floor =>
    ({ level, height: 2900, ceilingHeight: 2400, elevation: 500 + (level - 1) * 2900, outline, rooms, walls: [], openings: [], stairs: [] }) as unknown as Floor;
  const model = { floors: [floor(1, [rect(0, 0, 10000, 6000)], [room('l', 'ＬＤＫ', 'ldk', rect(0, 0, 10000, 6000))])], northAngleDeg: 0 } as unknown as BuildingModel;
  const opts = { grade: 'P' as const, eavesMm: 100, pitch: 0.5, roofType: 'shed' as const };

  it('外壁面積・屋根面積・施工面積が入り、紙の幅いっぱいの 1 段に収まる', () => {
    const rows = exteriorQuantityRows(model, opts);
    expect(rows.map((r) => r[0])).toEqual(expect.arrayContaining(['外壁面積', '屋根面積', '軒天面積', '基礎外周', '建築面積', '施工面積']));
    const strip = exteriorQuantityStripSvg(model, opts, 0, 0, SHEET_TOP_W);
    expect(strip.w).toBe(SHEET_TOP_W);
    expect(strip.h).toBeLessThan(900);
    for (const r of rows) {
      expect(strip.svg).toContain(`>${r[0]}<`);
      expect(strip.svg).toContain(`>${r[1]}<`);
    }
    expect(strip.svg).toContain('外部数量');
  });
});

describe('段ごとの枚数をそろえる並べ方（立面図 4 面）', () => {
  const top = { svg: '<rect id="top" width="40400" height="4300"/>', w: 40400, h: 4300 };
  // 3 階建ての立面図 4 面（幅 18.5 m × 高さ 10.5 m）: 1/100 では 2 段が紙の高さに入らず、1/150 では 3 枚まで横に並ぶ
  const elevs = ['s', 'e', 'n', 'w'].map((id) => panel(18500, 10500, id));
  const rowsOf = (svg: string) => {
    const ys = ['s', 'e', 'n', 'w'].map((id) => Number(svg.match(new RegExp(`<g transform="translate\\((-?\\d+) (-?\\d+)\\)"><rect id="${id}"`))![2]));
    return [...new Set(ys)].map((y) => ys.filter((v) => v === y).length);
  };
  it('そろえないと 3 枚＋1 枚、そろえると 2 枚＋2 枚（縮尺は同じ）', () => {
    const plain = composeSheet(elevs, info, { top, gap: 1200 });
    const even = composeSheet(elevs, info, { top, gap: 1200, balance: true });
    expect(plain).toContain('>1/150<');
    expect(even).toContain('>1/150<');
    expect(rowsOf(plain)).toEqual([3, 1]);
    expect(rowsOf(even)).toEqual([2, 2]);
  });
  it('1 段に入るとき・もともと 2 枚ずつのときは変わらない', () => {
    const small = ['s', 'e', 'n', 'w'].map((id) => panel(9000, 7000, id));
    expect(composeSheet(small, info, { top, gap: 1200, balance: true })).toBe(composeSheet(small, info, { top, gap: 1200 }));
    const mid = ['s', 'e', 'n', 'w'].map((id) => panel(17500, 8500, id));
    expect(rowsOf(composeSheet(mid, info, { top, gap: 1200, balance: true }))).toEqual([2, 2]);
    expect(composeSheet(mid, info, { top, gap: 1200, balance: true })).toBe(composeSheet(mid, info, { top, gap: 1200 }));
  });
});
