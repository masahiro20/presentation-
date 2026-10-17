/**
 * b3dm（Batched 3D Model）の読み取り（DOM・three 非依存）: ヘッダ・featureTable・batchTable（JSON 列／バイナリ参照列）・glb の切り出し。
 *
 * b3dm の並び（3D Tiles 1.0）: 28 B ヘッダ → featureTable JSON → featureTable バイナリ → batchTable JSON → batchTable バイナリ → glb
 *   ヘッダ: magic 'b3dm'(4) version(u32) byteLength(u32) ftJsonLen(u32) ftBinLen(u32) btJsonLen(u32) btBinLen(u32)、すべてリトルエンディアン
 *   PLATEAU の葉タイル（実測）: featureTable は { BATCH_LENGTH: n } だけ、batchTable JSON が全体の 7 割（'attributes' 列が半分）、
 *   gml_id・市区名・用途などは JSON の配列列、_x/_y/_xmin.._zmax・bldg:measuredHeight は DOUBLE、_lod・branchID は BYTE のバイナリ参照列。
 *
 * numbers() は配列列と { byteOffset, componentType, type: 'SCALAR' } のバイナリ参照列
 * （DOUBLE/FLOAT/BYTE/UNSIGNED_BYTE/SHORT/UNSIGNED_SHORT/INT/UNSIGNED_INT）の両対応。
 * 'attributes' 列（1 棟 2.6〜4.5 KB の JSON オブジェクト）は読み捨て（numbers/strings は null。raw でしか読まない）。
 * 仕様: scratchpad/plateau-spec.md §2.3（W2 が実装）
 */

export interface BatchTable {
  keys: string[];
  batchLength: number;
  /** 数値列。配列列（数値・数値文字列・null → NaN）とバイナリ参照列の両対応。無い列・オブジェクト列は null */
  numbers(name: string): Float64Array | null;
  /** 文字列列。配列列だけ（数値・真偽値は文字列に、null・オブジェクトは null）。無い列・バイナリ参照列は null */
  strings(name: string): (string | null)[] | null;
  /** 列をそのまま（バイナリ参照列は数値の配列に）。'attributes' 列はこれでしか読めない */
  raw(name: string): unknown[] | null;
}

export interface B3dm {
  version: number;
  byteLength: number;
  batchLength: number;
  featureTable: Record<string, unknown>;
  batchTable: BatchTable;
  /** buf.slice で独立させた glb */
  glb: ArrayBuffer;
  sizes: { ftJson: number; ftBin: number; btJson: number; btBin: number; glb: number };
}

/** ヘッダの長さ（3D Tiles 1.0 の b3dm。旧形式の 20/24 B ヘッダは扱わない） */
const HEADER_BYTES = 28;
const MAGIC = 'b3dm';

/** バイナリ参照列の componentType → 1 要素のバイト数と読み出し */
const COMPONENT: Record<string, { size: number; read: (dv: DataView, off: number) => number }> = {
  BYTE: { size: 1, read: (dv, o) => dv.getInt8(o) },
  UNSIGNED_BYTE: { size: 1, read: (dv, o) => dv.getUint8(o) },
  SHORT: { size: 2, read: (dv, o) => dv.getInt16(o, true) },
  UNSIGNED_SHORT: { size: 2, read: (dv, o) => dv.getUint16(o, true) },
  INT: { size: 4, read: (dv, o) => dv.getInt32(o, true) },
  UNSIGNED_INT: { size: 4, read: (dv, o) => dv.getUint32(o, true) },
  FLOAT: { size: 4, read: (dv, o) => dv.getFloat32(o, true) },
  DOUBLE: { size: 8, read: (dv, o) => dv.getFloat64(o, true) },
};

const fail = (why: string): never => {
  throw new Error(`b3dm ではありません: ${why}`);
};

/** ヘッダだけ読む（サイズの見積り・進捗用）。magic・version・ヘッダ長は検証するが、本体の長さ整合は parseB3dm で見る */
export function peekB3dmHeader(buf: ArrayBuffer): { byteLength: number; ftJson: number; ftBin: number; btJson: number; btBin: number } {
  if (buf.byteLength < HEADER_BYTES) fail(`ヘッダに満たない長さです（${buf.byteLength} B）`);
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== MAGIC) fail(`magic が '${magic.replace(/[^\x20-\x7e]/g, '?')}' です`);
  const version = dv.getUint32(4, true);
  if (version !== 1) fail(`version ${version} には対応していません`);
  return {
    byteLength: dv.getUint32(8, true),
    ftJson: dv.getUint32(12, true),
    ftBin: dv.getUint32(16, true),
    btJson: dv.getUint32(20, true),
    btBin: dv.getUint32(24, true),
  };
}

/** magic 'b3dm'・version 1・長さ整合を検証。失敗は Error('b3dm ではありません: …') */
export function parseB3dm(buf: ArrayBuffer): B3dm {
  const h = peekB3dmHeader(buf);
  if (h.byteLength > buf.byteLength) fail(`ヘッダの byteLength ${h.byteLength} に対してバッファが ${buf.byteLength} B しかありません`);
  if (h.byteLength < HEADER_BYTES) fail(`ヘッダの byteLength ${h.byteLength} がヘッダより短いです`);
  const ftJsonStart = HEADER_BYTES;
  const ftBinStart = ftJsonStart + h.ftJson;
  const btJsonStart = ftBinStart + h.ftBin;
  const btBinStart = btJsonStart + h.btJson;
  const glbStart = btBinStart + h.btBin;
  if (glbStart > h.byteLength) fail(`各表の長さの合計 ${glbStart} B が byteLength ${h.byteLength} を超えています`);
  const glbLen = h.byteLength - glbStart;
  if (glbLen < 12) fail(`glb がありません（${glbLen} B）`);
  const u8 = new Uint8Array(buf);
  if (String.fromCharCode(u8[glbStart], u8[glbStart + 1], u8[glbStart + 2], u8[glbStart + 3]) !== 'glTF') fail('glb の magic が glTF ではありません');

  const featureTable = parseJsonSection(u8, ftJsonStart, h.ftJson, 'featureTable');
  const batchLength = readBatchLength(featureTable, buf, ftBinStart, h.ftBin);
  const btJson = parseJsonSection(u8, btJsonStart, h.btJson, 'batchTable');
  const btBin = new DataView(buf, btBinStart, h.btBin);
  const batchTable = makeBatchTable(btJson, btBin, batchLength);

  return {
    version: 1,
    byteLength: h.byteLength,
    batchLength,
    featureTable,
    batchTable,
    glb: buf.slice(glbStart, h.byteLength),
    sizes: { ftJson: h.ftJson, ftBin: h.ftBin, btJson: h.btJson, btBin: h.btBin, glb: glbLen },
  };
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

/** JSON 区画（末尾は空白でパディングされている）をオブジェクトに。長さ 0 は {} */
function parseJsonSection(u8: Uint8Array, start: number, len: number, label: string): Record<string, unknown> {
  if (len === 0) return {};
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder().decode(u8.subarray(start, start + len)));
  } catch (e) {
    fail(`${label} の JSON を読めません（${e instanceof Error ? e.message : String(e)}）`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${label} がオブジェクトではありません`);
  return v as Record<string, unknown>;
}

/** BATCH_LENGTH は数値が普通。{ byteOffset } の参照（UNSIGNED_INT）も一応読む。無ければ 0 */
function readBatchLength(ft: Record<string, unknown>, buf: ArrayBuffer, binStart: number, binLen: number): number {
  const v = ft.BATCH_LENGTH;
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : fail(`BATCH_LENGTH が不正です（${v}）`);
  if (typeof v === 'object' && typeof (v as { byteOffset?: unknown }).byteOffset === 'number') {
    const off = (v as { byteOffset: number }).byteOffset;
    if (off + 4 > binLen) fail('BATCH_LENGTH の参照が featureTable バイナリの外です');
    return new DataView(buf, binStart, binLen).getUint32(off, true);
  }
  return fail('BATCH_LENGTH の形が不明です');
}

interface BinaryRef {
  byteOffset: number;
  componentType: string;
  type?: string;
}

const isBinaryRef = (v: unknown): v is BinaryRef =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as BinaryRef).byteOffset === 'number' && typeof (v as BinaryRef).componentType === 'string';

function makeBatchTable(json: Record<string, unknown>, bin: DataView, batchLength: number): BatchTable {
  const keys = Object.keys(json);
  // 同じ列を何度も復号しないよう、数値列は一度作ったら持ち回る（_x.._zmax は W5 が全部読む）
  const numCache = new Map<string, Float64Array | null>();

  const readBinary = (name: string, ref: BinaryRef): Float64Array => {
    if ((ref.type ?? 'SCALAR') !== 'SCALAR') fail(`列 '${name}' の type ${ref.type} には対応していません（SCALAR のみ）`);
    const c = COMPONENT[ref.componentType];
    if (!c) fail(`列 '${name}' の componentType ${ref.componentType} には対応していません`);
    const end = ref.byteOffset + c.size * batchLength;
    if (ref.byteOffset < 0 || end > bin.byteLength) fail(`列 '${name}' の参照（${ref.byteOffset}〜${end} B）が batchTable バイナリ（${bin.byteLength} B）の外です`);
    const out = new Float64Array(batchLength);
    for (let i = 0; i < batchLength; i++) out[i] = c.read(bin, ref.byteOffset + i * c.size);
    return out;
  };

  /** 配列列が「オブジェクトの列」（attributes など）なら true: 数値・文字列としては読まない */
  const isObjectColumn = (arr: unknown[]) => {
    let seen = false;
    for (const v of arr) {
      if (v == null) continue;
      if (typeof v !== 'object') return false;
      seen = true;
    }
    return seen;
  };

  const numbers = (name: string): Float64Array | null => {
    if (numCache.has(name)) return numCache.get(name)!;
    const col = json[name];
    let out: Float64Array | null = null;
    if (isBinaryRef(col)) out = readBinary(name, col);
    else if (Array.isArray(col) && !isObjectColumn(col)) {
      out = new Float64Array(col.length);
      for (let i = 0; i < col.length; i++) {
        const v = col[i];
        // 数値文字列（surveyYear "2021" など）は数に、null・空文字・それ以外は NaN
        out[i] = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      }
    }
    numCache.set(name, out);
    return out;
  };

  const strings = (name: string): (string | null)[] | null => {
    const col = json[name];
    if (!Array.isArray(col) || isObjectColumn(col)) return null;
    return col.map((v) => (v == null ? null : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null));
  };

  const raw = (name: string): unknown[] | null => {
    const col = json[name];
    if (Array.isArray(col)) return col;
    if (isBinaryRef(col)) return Array.from(numbers(name) ?? []);
    return null;
  };

  return { keys, batchLength, numbers, strings, raw };
}
