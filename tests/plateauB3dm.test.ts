import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseB3dm, peekB3dmHeader } from '../src/sun/plateau/b3dm';

/** fixture を独立した ArrayBuffer として読む（Buffer はプールを共有するので slice する） */
const fixture = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`./fixtures/plateau/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const ascii = (buf: ArrayBuffer, start: number, len: number) => String.fromCharCode(...new Uint8Array(buf, start, len));

/** テスト用に小さな b3dm を組み立てる（各表は 8 B 境界まで空白／0 で詰める。3D Tiles 1.0 の規則） */
function makeB3dm(opts: { featureTable?: unknown; batchTable?: unknown; batchBin?: Uint8Array; glb?: Uint8Array; byteLength?: number }): ArrayBuffer {
  const enc = new TextEncoder();
  const pad8 = (n: number, from: number) => (8 - ((from + n) % 8)) % 8;
  const ftJson = enc.encode(JSON.stringify(opts.featureTable ?? { BATCH_LENGTH: 0 }));
  const ftPad = pad8(ftJson.length, 28);
  const btJsonRaw = enc.encode(JSON.stringify(opts.batchTable ?? {}));
  const btPad = pad8(btJsonRaw.length, 0);
  const btBin = opts.batchBin ?? new Uint8Array(0);
  const glb = opts.glb ?? enc.encode('glTF' + '\0'.repeat(8));
  const ftLen = ftJson.length + ftPad;
  const btLen = btJsonRaw.length + btPad;
  const total = 28 + ftLen + btLen + btBin.length + glb.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(enc.encode('b3dm'), 0);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, opts.byteLength ?? total, true);
  dv.setUint32(12, ftLen, true);
  dv.setUint32(16, 0, true);
  dv.setUint32(20, btLen, true);
  dv.setUint32(24, btBin.length, true);
  let p = 28;
  out.set(ftJson, p);
  out.fill(0x20, p + ftJson.length, p + ftLen);
  p += ftLen;
  out.set(btJsonRaw, p);
  out.fill(0x20, p + btJsonRaw.length, p + btLen);
  p += btLen;
  out.set(btBin, p);
  p += btBin.length;
  out.set(glb, p);
  return out.buffer;
}

describe('parseB3dm: 守山区 LOD1 の葉タイル（23113 data0）', () => {
  const buf = fixture('23113_lod1_data0.b3dm');
  const t = parseB3dm(buf);

  it('ヘッダ: version 1・byteLength がファイルと一致・各表の長さが足し合うと byteLength', () => {
    expect(t.version).toBe(1);
    expect(t.byteLength).toBe(buf.byteLength);
    expect(t.batchLength).toBe(6);
    expect(t.featureTable).toEqual({ BATCH_LENGTH: 6 });
    const s = t.sizes;
    expect(28 + s.ftJson + s.ftBin + s.btJson + s.btBin + s.glb).toBe(t.byteLength);
    expect(s.ftBin).toBe(0);
    expect(s.btJson).toBeGreaterThan(s.glb); // batchTable JSON が glb より大きい（実測: 21.6 KB vs 8.8 KB）
    expect(peekB3dmHeader(buf)).toEqual({ byteLength: t.byteLength, ftJson: s.ftJson, ftBin: s.ftBin, btJson: s.btJson, btBin: s.btBin });
  });

  it('glb は独立した ArrayBuffer で magic が glTF（元のバッファを書き換えても変わらない）', () => {
    expect(t.glb).not.toBe(buf);
    expect(t.glb.byteLength).toBe(t.sizes.glb);
    expect(ascii(t.glb, 0, 4)).toBe('glTF');
    // glb ヘッダの length（8〜12 B）は glb 自身の長さ
    expect(new DataView(t.glb).getUint32(8, true)).toBe(t.glb.byteLength);
    const first = new Uint8Array(t.glb)[0];
    new Uint8Array(buf)[t.byteLength - t.sizes.glb] = 0;
    expect(new Uint8Array(t.glb)[0]).toBe(first);
    new Uint8Array(buf)[t.byteLength - t.sizes.glb] = first;
  });

  it('配列列: gml_id が bldg_ で始まる 6 件、null の列は null のまま、数値の配列列も読める', () => {
    const bt = t.batchTable;
    expect(bt.batchLength).toBe(6);
    expect(bt.keys).toEqual(expect.arrayContaining(['gml_id', 'attributes', '_zmin', '_x', '_lod', 'bldg:measuredHeight']));
    const ids = bt.strings('gml_id')!;
    expect(ids).toHaveLength(6);
    for (const id of ids) expect(id).toMatch(/^bldg_[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(6);
    expect(bt.strings('city_name')!.every((v) => v === '愛知県名古屋市守山区')).toBe(true);
    expect(bt.strings('bldg:address')!.every((v) => v === null)).toBe(true);
    // 数値の配列列（階数。null の棟は NaN）と、数値文字列の配列列（調査年）
    const storeys = Array.from(bt.numbers('bldg:storeysAboveGround')!);
    expect(storeys).toEqual([1, 1, NaN, 1, 1, 1]);
    expect(bt.strings('bldg:storeysAboveGround')).toEqual(['1', '1', null, '1', '1', '1']);
    expect(Array.from(bt.numbers('uro:BuildingDetailAttribute_uro:surveyYear')!)).toEqual([2021, 2021, 2021, 2021, 2021, 2021]);
    // 文字列の列を numbers で読むと NaN、数値の列を strings で読むと文字列
    expect(Array.from(bt.numbers('city_name')!).every(Number.isNaN)).toBe(true);
  });

  it('バイナリ参照列: DOUBLE の _zmin/_x と BYTE の _lod が 6 要素で妥当な値', () => {
    const bt = t.batchTable;
    const zmin = bt.numbers('_zmin')!;
    const zmax = bt.numbers('_zmax')!;
    expect(zmin).toBeInstanceOf(Float64Array);
    expect(zmin).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(zmin[i]).toBeGreaterThan(0);
      expect(zmin[i]).toBeLessThan(200);
      expect(zmax[i]).toBeGreaterThan(zmin[i]);
    }
    const x = bt.numbers('_x')!;
    const y = bt.numbers('_y')!;
    const xmin = bt.numbers('_xmin')!;
    const xmax = bt.numbers('_xmax')!;
    for (let i = 0; i < 6; i++) {
      expect(x[i]).toBeGreaterThan(136.9);
      expect(x[i]).toBeLessThan(137.1);
      expect(y[i]).toBeGreaterThan(35.1);
      expect(y[i]).toBeLessThan(35.3);
      expect(xmin[i]).toBeLessThanOrEqual(x[i]);
      expect(xmax[i]).toBeGreaterThanOrEqual(x[i]);
    }
    expect(Array.from(bt.numbers('_lod')!)).toEqual([1, 1, 1, 1, 1, 1]);
    const mh = bt.numbers('bldg:measuredHeight')!;
    expect(mh).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(mh[i]).toBeGreaterThan(1);
      expect(mh[i]).toBeLessThan(100);
    }
    // バイナリ参照列は strings では読めない。raw は数値の配列
    expect(bt.strings('_zmin')).toBeNull();
    expect(bt.raw('_lod')).toEqual([1, 1, 1, 1, 1, 1]);
    // 同じ列を 2 度読んでも同じ内容
    expect(bt.numbers('_zmin')).toEqual(zmin);
  });

  it("'attributes' 列は raw でしか読めない（numbers/strings は null）、無い列は null", () => {
    const bt = t.batchTable;
    expect(bt.numbers('attributes')).toBeNull();
    expect(bt.strings('attributes')).toBeNull();
    const raw = bt.raw('attributes')!;
    expect(raw).toHaveLength(6);
    expect((raw[0] as Record<string, unknown>)['gml:id']).toBe(bt.strings('gml_id')![0]);
    expect(bt.numbers('存在しない列')).toBeNull();
    expect(bt.strings('存在しない列')).toBeNull();
    expect(bt.raw('存在しない列')).toBeNull();
  });
});

describe('parseB3dm: 東区 LOD2 の内部ノード（23102 data1・data55）', () => {
  it('data1（深さ 2）: 18 棟、全棟 _lod 1、gml_id が一意', () => {
    const t = parseB3dm(fixture('23102_lod2nt_data1.b3dm'));
    expect(t.batchLength).toBe(18);
    expect(t.batchTable.strings('gml_id')).toHaveLength(18);
    expect(new Set(t.batchTable.strings('gml_id')).size).toBe(18);
    expect(Array.from(t.batchTable.numbers('_lod')!).every((v) => v === 1)).toBe(true);
    expect(ascii(t.glb, 0, 4)).toBe('glTF');
  });
  it('data55（root）: 20 棟、_lod 2 が 5 棟、city_name が東区', () => {
    const t = parseB3dm(fixture('23102_lod2nt_data55.b3dm'));
    expect(t.batchLength).toBe(20);
    const lod = Array.from(t.batchTable.numbers('_lod')!);
    expect(lod.filter((v) => v === 2)).toHaveLength(5);
    expect(lod.filter((v) => v === 1)).toHaveLength(15);
    expect(t.batchTable.strings('city_name')![0]).toBe('愛知県名古屋市東区');
    expect(t.batchTable.numbers('_zmin')).toHaveLength(20);
  });
});

describe('parseB3dm: 手作りの b3dm で各 componentType と境界', () => {
  const n = 3;
  const bin = new Uint8Array(64);
  const dv = new DataView(bin.buffer);
  // UNSIGNED_SHORT ×3 @0、SHORT ×3 @8、FLOAT ×3 @16、INT ×3 @32、UNSIGNED_INT ×3 @48、UNSIGNED_BYTE ×3 @60
  dv.setUint16(0, 65535, true);
  dv.setUint16(2, 7, true);
  dv.setUint16(4, 300, true);
  dv.setInt16(8, -5, true);
  dv.setInt16(10, 0, true);
  dv.setInt16(12, 32767, true);
  dv.setFloat32(16, 1.5, true);
  dv.setFloat32(20, -2.25, true);
  dv.setFloat32(24, 1e10, true);
  dv.setInt32(32, -123456, true);
  dv.setInt32(36, 1, true);
  dv.setInt32(40, 2, true);
  dv.setUint32(48, 4000000000, true);
  dv.setUint32(52, 0, true);
  dv.setUint32(56, 9, true);
  bin[60] = 200;
  bin[61] = 0;
  bin[62] = 255;
  const bt = {
    us: { byteOffset: 0, componentType: 'UNSIGNED_SHORT', type: 'SCALAR' },
    s: { byteOffset: 8, componentType: 'SHORT', type: 'SCALAR' },
    f: { byteOffset: 16, componentType: 'FLOAT', type: 'SCALAR' },
    i: { byteOffset: 32, componentType: 'INT', type: 'SCALAR' },
    ui: { byteOffset: 48, componentType: 'UNSIGNED_INT', type: 'SCALAR' },
    ub: { byteOffset: 60, componentType: 'UNSIGNED_BYTE', type: 'SCALAR' },
    over: { byteOffset: 62, componentType: 'UNSIGNED_SHORT', type: 'SCALAR' },
    vec: { byteOffset: 0, componentType: 'FLOAT', type: 'VEC3' },
    unknown: { byteOffset: 0, componentType: 'HALF', type: 'SCALAR' },
    mixed: [1, '2', null, true],
    objs: [{ a: 1 }, null, { b: 2 }],
  };
  const t = parseB3dm(makeB3dm({ featureTable: { BATCH_LENGTH: n }, batchTable: bt, batchBin: bin }));

  it('UNSIGNED_SHORT / SHORT / FLOAT / INT / UNSIGNED_INT / UNSIGNED_BYTE を読める', () => {
    const b = t.batchTable;
    expect(t.batchLength).toBe(3);
    expect(Array.from(b.numbers('us')!)).toEqual([65535, 7, 300]);
    expect(Array.from(b.numbers('s')!)).toEqual([-5, 0, 32767]);
    expect(Array.from(b.numbers('f')!)).toEqual([1.5, -2.25, Math.fround(1e10)]);
    expect(Array.from(b.numbers('i')!)).toEqual([-123456, 1, 2]);
    expect(Array.from(b.numbers('ui')!)).toEqual([4000000000, 0, 9]);
    expect(Array.from(b.numbers('ub')!)).toEqual([200, 0, 255]);
  });

  it('配列列の混在（数値・数値文字列・null・真偽値）と、オブジェクトの列', () => {
    const b = t.batchTable;
    const m = Array.from(b.numbers('mixed')!);
    expect(m[0]).toBe(1);
    expect(m[1]).toBe(2);
    expect(Number.isNaN(m[2])).toBe(true);
    expect(Number.isNaN(m[3])).toBe(true);
    expect(b.strings('mixed')).toEqual(['1', '2', null, 'true']);
    expect(b.numbers('objs')).toBeNull();
    expect(b.strings('objs')).toBeNull();
    expect(b.raw('objs')).toEqual(bt.objs);
  });

  it('バイナリの外を指す参照・SCALAR 以外・未知の componentType は日本語の Error', () => {
    const b = t.batchTable;
    expect(() => b.numbers('over')).toThrow(/b3dm ではありません: 列 'over' の参照/);
    expect(() => b.numbers('vec')).toThrow(/VEC3/);
    expect(() => b.numbers('unknown')).toThrow(/HALF/);
  });

  it('featureTable が空（BATCH_LENGTH 無し）なら batchLength 0、batchTable 無しでも読める', () => {
    const e = parseB3dm(makeB3dm({ featureTable: {}, batchTable: {} }));
    expect(e.batchLength).toBe(0);
    expect(e.batchTable.keys).toEqual([]);
    expect(e.batchTable.numbers('x')).toBeNull();
    expect(ascii(e.glb, 0, 4)).toBe('glTF');
  });
});

describe('parseB3dm / peekB3dmHeader: 壊れた入力', () => {
  it('magic が違う（glb をそのまま渡した）', () => {
    const glb = new TextEncoder().encode('glTF' + '\0'.repeat(40)).buffer;
    expect(() => parseB3dm(glb)).toThrow(/^b3dm ではありません: magic が 'glTF'/);
    expect(() => peekB3dmHeader(glb)).toThrow(/b3dm ではありません/);
  });
  it('短いバッファ（ヘッダ未満・0 B）', () => {
    expect(() => parseB3dm(new ArrayBuffer(10))).toThrow(/b3dm ではありません: ヘッダに満たない/);
    expect(() => peekB3dmHeader(new ArrayBuffer(0))).toThrow(/b3dm ではありません/);
  });
  it('version が 1 以外', () => {
    const buf = makeB3dm({});
    new DataView(buf).setUint32(4, 2, true);
    expect(() => parseB3dm(buf)).toThrow(/version 2/);
  });
  it('byteLength がバッファより大きい・各表の合計が byteLength を超える・途中で切れたファイル', () => {
    expect(() => parseB3dm(makeB3dm({ byteLength: 10_000 }))).toThrow(/byteLength 10000/);
    const buf = makeB3dm({ batchTable: { a: [1, 2] } });
    new DataView(buf).setUint32(20, 100_000, true); // btJson の長さを壊す
    expect(() => parseB3dm(buf)).toThrow(/長さの合計/);
    const whole = fixture('23113_lod1_data0.b3dm');
    expect(() => parseB3dm(whole.slice(0, 20_000))).toThrow(/b3dm ではありません/);
  });
  it('glb が無い・glb の magic が違う', () => {
    expect(() => parseB3dm(makeB3dm({ glb: new Uint8Array(0) }))).toThrow(/glb がありません/);
    expect(() => parseB3dm(makeB3dm({ glb: new TextEncoder().encode('JSON' + '\0'.repeat(8)) }))).toThrow(/glTF ではありません/);
  });
  it('featureTable / batchTable の JSON が壊れている', () => {
    const buf = makeB3dm({ featureTable: { BATCH_LENGTH: 1 }, batchTable: { a: [1] } });
    const u8 = new Uint8Array(buf);
    u8[28] = 0x5b; // featureTable の '{' を '[' に
    expect(() => parseB3dm(buf)).toThrow(/featureTable/);
  });
});
