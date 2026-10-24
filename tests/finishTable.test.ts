import { describe, it, expect } from 'vitest';
import { exteriorFinishRows, exteriorFinishTableSvg } from '../src/drawings/finishTable';
import { DEFAULT_DESIGN } from '../src/styles/presets';
import { composeSheet, warekiOf, SHEET_TOP_W } from '../src/drawings/sheet';

describe('外部仕上表（御社の立面図の帯）', () => {
  it('標準のテイストで 5 組 × 4 行、外壁はジョリパットで色が入る', () => {
    const groups = exteriorFinishRows(DEFAULT_DESIGN);
    expect(groups.length).toBe(5);
    for (const g of groups) expect(g.length).toBe(4);
    const wall = groups[1].find((r) => r.label.startsWith('外壁①'))!;
    expect(wall.cell.a).toContain('ジョリパット');
    expect(wall.cell.ar).toMatch(/^色：./);
    expect(groups[0][0].label).toBe('屋根');
    expect(groups[0][0].cell.a).toContain('ガルバリウム');
  });

  it('コーディネートで選んだ商品（色・品番メモ）が表に出る', () => {
    const d = { ...DEFAULT_DESIGN, finishes: { extWall: 'ext.gl.black', accent: 'acc.solido.grey', entDoor: 'door.venato.walnut' }, finishNotes: { extWall: 'SGL-123 特注色' } };
    const groups = exteriorFinishRows(d);
    const wall = groups[1][2];
    expect(wall.cell.a).toContain('ガルバリウム');
    expect(wall.cell.ar).toBe('色：ブラック');
    expect(wall.cell.b).toBe('SGL-123 特注色');
    const acc = groups[1][3];
    expect(acc.cell.a).toContain('通気パネル');
    expect(acc.cell.b).toContain('SOLIDO');
    const door = groups[3][0];
    expect(door.cell.br).toContain('ショコラウォールナット');
  });

  it('帯の SVG は図枠の上に入り、縮尺が変わっても紙の上で同じ大きさ（縮尺に合わせて拡大）', () => {
    const top = exteriorFinishTableSvg(DEFAULT_DESIGN, 0, 0, SHEET_TOP_W);
    expect(top.svg).toContain('外');
    expect(top.h).toBeGreaterThan(2000);
    const info = { project: 'テスト様邸 新築工事', drawing: '立面図', date: '2026.10.22', designer: '' };
    // 小さな図 4 枚 → 1/100 に収まり、帯は等倍
    const small = composeSheet(Array.from({ length: 4 }, () => ({ inner: '<rect width="10" height="10"/>', vb: { x: 0, y: 0, w: 12000, h: 9000 } })), info, { top });
    expect(small).toContain('scale(1.0000)');
    expect(small).toContain('>1/100<');
    // 大きな図 → 1/150 になり、帯は 1.5 倍
    const big = composeSheet(Array.from({ length: 4 }, () => ({ inner: '<rect width="10" height="10"/>', vb: { x: 0, y: 0, w: 20000, h: 14000 } })), info, { top });
    expect(big).toContain('scale(1.5000)');
    expect(big).toContain('>1/150<');
    expect(warekiOf('2026.10.22')).toBe('R8.10.22');
  });
});
