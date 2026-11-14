// 積算ブック（xlsx）の読み取りと、自動拾いとの突き合わせ（scripts/audit/sekisan.ts）
// 御社の積算と同じ並び（「面」シート: B 列のラベル・P 列の値、「見積もり書」: B 列の「1.仮設工事」・AK 列の金額）の小さな xlsx をその場で作って読む
import { describe, expect, it } from 'vitest';
import { compareSekisan, excelDate, formatCompare, readSekisanWorkbook, readXlsxBuffer } from '../scripts/audit/sekisan';
import type { BuildingModel, Floor, Room, Vec2 } from '../src/core/types';

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** 圧縮なし（stored）の zip */
function zipStored(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const cd: Buffer[] = [];
  let off = 0;
  let count = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(off, 42);
    parts.push(lh, n, data);
    cd.push(ch, n);
    off += lh.length + n.length + data.length;
    count++;
  }
  const cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

const serial = (y: number, m: number, d: number) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
const strings = ['お客様名', '山田 太郎様', '施工面積', '延床面積', '１階床面積', '２階床面積', '外部ポーチ・テラス面積', '内部ポーチ・テラス面積', '建築面積', '外壁面積', '吹き抜け', '1.仮設工事', '2.基礎工事', '小計', '税額', '金額(税込)', '屋根面積'];
const s = (ref: string, text: string) => `<c r="${ref}" t="s"><v>${strings.indexOf(text)}</v></c>`;
const n = (ref: string, v: number, f?: string) => `<c r="${ref}">${f ? `<f>${f}</f>` : ''}<v>${v}</v></c>`;
const sheetXml = (rows: Record<number, string>) => `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${Object.entries(rows)
  .map(([r, cells]) => `<row r="${r}">${cells}</row>`)
  .join('')}</sheetData></worksheet>`;
const men = sheetXml({
  2: s('B2', 'お客様名') + s('F2', '山田 太郎様') + n('X2', serial(2026, 11, 6)),
  5: s('B5', '施工面積') + n('F5', 49.03) + n('L5', 162.09),
  6: s('B6', '延床面積') + n('F6', 34.78) + n('L6', 115),
  8: s('B8', '１階床面積') + n('P8', 83.12),
  9: s('B9', '２階床面積') + n('P9', 31.88),
  11: s('B11', '外部ポーチ・テラス面積') + n('P11', 19.04),
  12: s('B12', '内部ポーチ・テラス面積') + n('P12', 6.21),
  13: s('B13', '施工面積') + n('P13', 47.09, '43.47+3.62') + n('U13', 14.24),
  15: s('B15', '建築面積') + n('P15', 136.53),
  16: s('B16', '外壁面積') + n('P16', 344.19, '76.36+77.94+67.93+64.56+57.4'),
  19: s('B19', '屋根面積') + n('P19', 142.63),
  20: s('B20', '吹き抜け') + n('P20', 0) + n('U20', 0),
});
const est = sheetXml({
  39: s('B39', '金額(税込)') + n('H39', 57960513.6) + n('AF39', 49.03),
  43: s('B43', '1.仮設工事') + n('AK43', 2060580) + n('BC43', 1446379.5),
  44: s('B44', '2.基礎工事') + n('AK44', 6240780) + n('BC44', 4368960),
  61: s('B61', '小計') + n('AK61', 52691376),
  62: s('B62', '税額') + n('AK62', 5269137.6),
});
const xlsx = zipStored({
  'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="見積もり書 (2)" sheetId="1" r:id="rId1"/><sheet name="面" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
  'xl/sharedStrings.xml': `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((t) => `<si><t>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></si>`).join('')}</sst>`,
  'xl/worksheets/sheet1.xml': est,
  'xl/worksheets/sheet2.xml': men,
});

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (id: string, name: string, type: Room['type'], poly: Vec2[]): Room => ({ id, name, type, polygon: poly, labelPos: poly[0], area: ((poly[1].x - poly[0].x) * (poly[2].y - poly[1].y)) / 1e6 });
const floor = (level: number, outline: Vec2[], rooms: Room[]): Floor => ({ level, elevation: 500 + (level - 1) * 2900, height: 2900, ceilingHeight: 2400, outline: [outline], rooms, walls: [], openings: [], stairs: [] });
const model: BuildingModel = {
  name: 'test',
  floors: [floor(1, rect(0, 0, 10000, 8000), [room('l', 'LDK', 'ldk', rect(0, 0, 10000, 8000))]), floor(2, rect(0, 0, 10000, 4000), [room('b', '寝室', 'bedroom', rect(0, 0, 10000, 4000))])],
  northAngleDeg: 0,
  report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} },
};

describe('積算ブックの読み取り', () => {
  it('xlsx（zip + XML）からシートのセルを読む', () => {
    const wb = readXlsxBuffer(xlsx);
    expect(Object.keys(wb.sheets)).toEqual(['見積もり書 (2)', '面']);
    expect(wb.sheets['面'].B8).toBe('１階床面積');
    expect(wb.sheets['面'].P8).toBe(83.12);
    expect(wb.sheets['面'].P13).toBe(47.09); // 式はキャッシュされた値
    expect(wb.sheets['見積もり書 (2)'].AK43).toBe(2060580);
  });
  it('「面」の数量と「見積もり書」の工事種別を拾う', () => {
    const sk = readSekisanWorkbook(readXlsxBuffer(xlsx), '/x/yoshida.xlsx');
    expect(sk.file).toBe('yoshida.xlsx');
    expect(sk.customer).toBe('山田 太郎様');
    expect(sk.submitted).toBe('2026-11-06');
    expect(excelDate(serial(2026, 10, 3))).toBe('2026-10-03');
    expect(sk.constTsubo).toBe(49.03);
    expect(sk.constM2).toBe(162.09);
    expect(sk.totalTsubo).toBe(34.78);
    expect(sk.totalM2).toBe(115);
    expect(sk.areas).toMatchObject({ floor1: 83.12, floor2: 31.88, porchOut: 19.04, porchIn: 6.21, extraArea: 47.09, buildArea: 136.53, extWall: 344.19, roofArea: 142.63, voidArea: 0 });
    expect(sk.cats).toEqual([
      { no: 1, name: '仮設工事', amount: 2060580, cost: 1446379.5 },
      { no: 2, name: '基礎工事', amount: 6240780, cost: 4368960 },
    ]);
    expect(sk.subtotal).toBe(52691376);
    expect(sk.tax).toBeCloseTo(5269137.6, 1);
    expect(sk.totalTaxIn).toBeCloseTo(57960513.6, 1);
  });
  it('自動拾いと並べて差を出す（積算に無い項目は差なし）', () => {
    const sk = readSekisanWorkbook(readXlsxBuffer(xlsx), 'y.xlsx');
    const r = compareSekisan(model, sk, { grade: 'P', eavesMm: 100, pitch: 0.5, roofType: 'shed' });
    const f1 = r.areas.find((x) => x.label === '1階床面積')!;
    expect(f1.sekisan).toBe(83.12);
    expect(f1.auto).toBeCloseTo(80, 1);
    expect(f1.diff).toBeCloseTo(-3.12, 2);
    expect(f1.pct).toBeCloseTo(-3.8, 1);
    expect(r.areas.find((x) => x.label === '基礎外周')!.sekisan).toBeUndefined();
    expect(r.cats.find((x) => /^1\./.test(x.label))!.sekisan).toBe(2060580);
    expect(r.cats.find((x) => /^3\./.test(x.label))!.sekisan).toBeUndefined();
    const text = formatCompare(r);
    expect(text).toMatch(/山田 太郎様 提出 2026-11-06/);
    expect(text).toMatch(/1階床面積 ㎡\s+83\.12\s+80\s+-3\.12\s+-3\.8%/);
  });
});
