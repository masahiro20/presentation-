/**
 * 点群ファイルを読む: LAS（1.0〜1.4、点の形式 0〜10）・LAZ（laz-perf で展開）・PLY（ascii / binary）・XYZ（テキスト: x y z [分類]）。
 *
 * 航空レーザの LAS は 1 ファイル数百万〜数千万点あるので、読みながら敷地の周り（filter で判定）だけを残し、上限を超えたら間引く。
 * 返す座標はファイルのまま（倍精度）。敷地の東・北への変換は place.ts。
 */

export interface CloudHeader {
  format: 'las' | 'laz' | 'ply' | 'xyz';
  /** ファイルに書かれた点の数 */
  total: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  /** 座標系の手がかり（LAS の GeoKey / WKT） */
  epsg?: number;
  wkt?: string;
}

export interface RawCloud {
  header: CloudHeader;
  count: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  /** LAS の分類（2 = 地面, 3〜5 = 植生, 6 = 建物, 9 = 水面）。分類されていないファイルは null */
  cls: Uint8Array | null;
  /** 0〜255 の RGB（3 個ずつ）。無ければ null */
  rgb: Uint8Array | null;
}

export interface ReadOptions {
  /** ヘッダを見て、残す点の判定（ファイルの座標）を返す。null なら全部残す */
  filter?: (h: CloudHeader) => ((x: number, y: number) => boolean) | null;
  /** 残す点の上限（超えたら半分に間引いて読み続ける） */
  maxPoints?: number;
  /** 進み具合（0〜1） */
  onProgress?: (ratio: number) => void;
}

const DEFAULT_MAX = 2_500_000;

/** 読みながら貯める入れ物（上限を超えたら 1 点おきに間引き、以後は間隔を倍にして受ける） */
class Collector {
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  cls: Uint8Array;
  /** 色はいったん 16 bit で持ち、最後に 8 bit へ（LAS は 0〜65535 が決まりだが 0〜255 のまま入ったファイルもある） */
  rgb: Uint16Array | null;
  n = 0;
  private stride = 1;
  private tick = 0;
  private anyCls = false;

  constructor(
    private cap: number,
    hasRgb: boolean,
  ) {
    const init = Math.min(cap, 1 << 16);
    this.x = new Float64Array(init);
    this.y = new Float64Array(init);
    this.z = new Float64Array(init);
    this.cls = new Uint8Array(init);
    this.rgb = hasRgb ? new Uint16Array(init * 3) : null;
  }

  private resize(size: number) {
    const f = (a: Float64Array) => {
      const b = new Float64Array(size);
      b.set(a.subarray(0, Math.min(a.length, size)));
      return b;
    };
    this.x = f(this.x);
    this.y = f(this.y);
    this.z = f(this.z);
    const c = new Uint8Array(size);
    c.set(this.cls.subarray(0, Math.min(this.cls.length, size)));
    this.cls = c;
    if (this.rgb) {
      const r = new Uint16Array(size * 3);
      r.set(this.rgb.subarray(0, Math.min(this.rgb.length, size * 3)));
      this.rgb = r;
    }
  }

  private halve() {
    let j = 0;
    for (let i = 0; i < this.n; i += 2, j++) {
      this.x[j] = this.x[i];
      this.y[j] = this.y[i];
      this.z[j] = this.z[i];
      this.cls[j] = this.cls[i];
      if (this.rgb) for (let k = 0; k < 3; k++) this.rgb[j * 3 + k] = this.rgb[i * 3 + k];
    }
    this.n = j;
    this.stride *= 2;
  }

  push(x: number, y: number, z: number, c: number, r = 0, g = 0, b = 0) {
    if (this.stride > 1 && this.tick++ % this.stride !== 0) return;
    if (this.n >= this.x.length) {
      if (this.x.length < this.cap) this.resize(Math.min(this.cap, this.x.length * 2));
      else this.halve();
    }
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.cls[i] = c;
    if (c > 1) this.anyCls = true;
    if (this.rgb) {
      this.rgb[i * 3] = r;
      this.rgb[i * 3 + 1] = g;
      this.rgb[i * 3 + 2] = b;
    }
  }

  done(header: CloudHeader): RawCloud {
    const n = this.n;
    return {
      header,
      count: n,
      x: this.x.slice(0, n),
      y: this.y.slice(0, n),
      z: this.z.slice(0, n),
      cls: this.anyCls ? this.cls.slice(0, n) : null,
      rgb: this.rgb ? to8bit(this.rgb.subarray(0, n * 3)) : null,
    };
  }
}

function to8bit(src: Uint16Array): Uint8Array {
  let max = 0;
  for (let i = 0; i < src.length; i++) if (src[i] > max) max = src[i];
  const shift = max > 255 ? 8 : 0;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Math.min(255, src[i] >> shift);
  return out;
}

/** 先頭のバイトと拡張子から形式を決めて読む */
export async function readPointCloud(buf: ArrayBuffer, name: string, opts: ReadOptions = {}): Promise<RawCloud> {
  const head = new Uint8Array(buf, 0, Math.min(16, buf.byteLength));
  const magic = String.fromCharCode(...head.subarray(0, 4));
  if (magic === 'LASF') {
    const compressed = (new DataView(buf).getUint8(104) & 0x80) !== 0 || /\.laz$/i.test(name);
    return compressed ? readLaz(buf, opts) : readLas(buf, opts);
  }
  if (String.fromCharCode(...head.subarray(0, 3)) === 'ply') return readPly(buf, opts);
  if (/\.(xyz|txt|csv|pts)$/i.test(name)) return readXyz(buf, opts);
  throw new Error('点群の形式が分かりません（LAS・LAZ・PLY・XYZ/CSV に対応しています）');
}

// ---------------------------------------------------------------------------
// LAS / LAZ
// ---------------------------------------------------------------------------

export interface LasLayout {
  header: CloudHeader;
  pointOffset: number;
  format: number;
  recLen: number;
  count: number;
  scale: [number, number, number];
  offset: [number, number, number];
  /** 点の中の分類のバイト位置とマスク（形式 0〜5 は下位 5 bit、6〜10 は 1 バイト） */
  clsAt: number;
  clsMask: number;
  /** 点の中の色の位置（無ければ −1） */
  rgbAt: number;
}

function cstr(u8: Uint8Array): string {
  const end = u8.indexOf(0);
  return new TextDecoder('latin1').decode(end >= 0 ? u8.subarray(0, end) : u8).trim();
}

/** LAS のヘッダと VLR（座標系）を読む */
export function lasLayout(buf: ArrayBuffer): LasLayout {
  const dv = new DataView(buf);
  const minor = dv.getUint8(25);
  const headerSize = dv.getUint16(94, true);
  const pointOffset = dv.getUint32(96, true);
  const nVlr = dv.getUint32(100, true);
  const format = dv.getUint8(104) & 0x3f;
  const recLen = dv.getUint16(105, true);
  let count = dv.getUint32(107, true);
  if (minor >= 4 && headerSize >= 255) {
    const big = Number(dv.getBigUint64(247, true));
    if (big > 0) count = big;
  }
  const scale: [number, number, number] = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)];
  const offset: [number, number, number] = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)];
  const bounds = { maxX: dv.getFloat64(179, true), minX: dv.getFloat64(187, true), maxY: dv.getFloat64(195, true), minY: dv.getFloat64(203, true), maxZ: dv.getFloat64(211, true), minZ: dv.getFloat64(219, true) };
  // VLR の座標系: GeoKeyDirectory（34735）の ProjectedCSTypeGeoKey（3072）か、OGC WKT（2112）
  let epsg: number | undefined;
  let wkt: string | undefined;
  let p = headerSize;
  for (let i = 0; i < nVlr && p + 54 <= Math.min(buf.byteLength, pointOffset); i++) {
    const userId = cstr(new Uint8Array(buf, p + 2, 16));
    const recordId = dv.getUint16(p + 18, true);
    const len = dv.getUint16(p + 20, true);
    const body = p + 54;
    if (userId === 'LASF_Projection' && body + len <= buf.byteLength) {
      if (recordId === 34735 && len >= 8) {
        const nKeys = dv.getUint16(body + 6, true);
        for (let k = 0; k < nKeys; k++) {
          const at = body + 8 + k * 8;
          if (at + 8 > body + len) break;
          const keyId = dv.getUint16(at, true);
          const loc = dv.getUint16(at + 2, true);
          const val = dv.getUint16(at + 6, true);
          if (keyId === 3072 && loc === 0 && val > 0 && val < 32767) epsg = val;
        }
      } else if (recordId === 2112) wkt = cstr(new Uint8Array(buf, body, len));
    }
    p = body + len;
  }
  const ext = format >= 6;
  const rgbAt = ({ 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 } as Record<number, number>)[format] ?? -1;
  return {
    header: { format: 'las', total: count, bounds, epsg, wkt },
    pointOffset,
    format,
    recLen,
    count,
    scale,
    offset,
    clsAt: ext ? 16 : 15,
    clsMask: ext ? 0xff : 0x1f,
    rgbAt,
  };
}

/** 1 点分のバイト列（dv の at から）を読んで入れ物へ */
function lasPoints(L: LasLayout, opts: ReadOptions, each: (visit: (dv: DataView, at: number) => void) => void): RawCloud {
  const keep = opts.filter?.(L.header) ?? null;
  const out = new Collector(opts.maxPoints ?? DEFAULT_MAX, L.rgbAt >= 0);
  const [sx, sy, sz] = L.scale;
  const [ox, oy, oz] = L.offset;
  const hasRgb = L.rgbAt >= 0;
  each((dv, at) => {
    const x = dv.getInt32(at, true) * sx + ox;
    const y = dv.getInt32(at + 4, true) * sy + oy;
    if (keep && !keep(x, y)) return;
    const z = dv.getInt32(at + 8, true) * sz + oz;
    const c = dv.getUint8(at + L.clsAt) & L.clsMask;
    if (hasRgb) out.push(x, y, z, c, dv.getUint16(at + L.rgbAt, true), dv.getUint16(at + L.rgbAt + 2, true), dv.getUint16(at + L.rgbAt + 4, true));
    else out.push(x, y, z, c);
  });
  return out.done(L.header);
}

export function readLas(buf: ArrayBuffer, opts: ReadOptions = {}): RawCloud {
  const L = lasLayout(buf);
  const fit = Math.floor((buf.byteLength - L.pointOffset) / L.recLen);
  const count = Math.min(L.count, fit);
  const dv = new DataView(buf);
  return lasPoints(L, opts, (visit) => {
    const step = Math.max(1, Math.floor(count / 20));
    for (let i = 0; i < count; i++) {
      visit(dv, L.pointOffset + i * L.recLen);
      if (opts.onProgress && i % step === 0) opts.onProgress(i / count);
    }
  });
}

/** LAZ（LASzip 圧縮）: laz-perf（WASM）で 1 点ずつ展開する。初回だけ WASM を読み込む */
export async function readLaz(buf: ArrayBuffer, opts: ReadOptions = {}): Promise<RawCloud> {
  const L = lasLayout(buf);
  L.header.format = 'laz';
  const mod = await loadLazPerf();
  const filePtr = mod._malloc(buf.byteLength);
  const laszip = new mod.LASZip();
  let pointPtr = 0;
  try {
    mod.HEAPU8.set(new Uint8Array(buf), filePtr);
    laszip.open(filePtr, buf.byteLength);
    const count = Math.min(L.count, laszip.getCount());
    const recLen = laszip.getPointLength();
    pointPtr = mod._malloc(recLen);
    return lasPoints({ ...L, recLen }, opts, (visit) => {
      const step = Math.max(1, Math.floor(count / 20));
      for (let i = 0; i < count; i++) {
        laszip.getPoint(pointPtr);
        // HEAPU8 はメモリが伸びると作り直されるので、毎回 buffer から取る
        visit(new DataView(mod.HEAPU8.buffer, pointPtr, recLen), 0);
        if (opts.onProgress && i % step === 0) opts.onProgress(i / count);
      }
    });
  } finally {
    laszip.delete();
    if (pointPtr) mod._free(pointPtr);
    mod._free(filePtr);
  }
}

interface LazPerfModule {
  _malloc(n: number): number;
  _free(p: number): void;
  HEAPU8: Uint8Array;
  LASZip: new () => { open(p: number, n: number): void; getPoint(p: number): void; getCount(): number; getPointLength(): number; delete(): void };
}

let lazPerf: Promise<LazPerfModule> | null = null;
function loadLazPerf(): Promise<LazPerfModule> {
  lazPerf ??= (async () => {
    const m = (await import('laz-perf')) as unknown as { createLazPerf: (o?: object) => Promise<LazPerfModule> };
    if (typeof window === 'undefined') return m.createLazPerf();
    const wasm = (await import('laz-perf/lib/web/laz-perf.wasm?url')) as { default: string };
    return m.createLazPerf({ locateFile: () => wasm.default });
  })();
  return lazPerf;
}

// ---------------------------------------------------------------------------
// PLY（iPhone の LiDAR スキャンの書き出し: Polycam・Scaniverse・3d Scanner App など）
// ---------------------------------------------------------------------------

const PLY_TYPES: Record<string, [number, (dv: DataView, at: number, le: boolean) => number]> = {
  char: [1, (d, a) => d.getInt8(a)],
  int8: [1, (d, a) => d.getInt8(a)],
  uchar: [1, (d, a) => d.getUint8(a)],
  uint8: [1, (d, a) => d.getUint8(a)],
  short: [2, (d, a, le) => d.getInt16(a, le)],
  int16: [2, (d, a, le) => d.getInt16(a, le)],
  ushort: [2, (d, a, le) => d.getUint16(a, le)],
  uint16: [2, (d, a, le) => d.getUint16(a, le)],
  int: [4, (d, a, le) => d.getInt32(a, le)],
  int32: [4, (d, a, le) => d.getInt32(a, le)],
  uint: [4, (d, a, le) => d.getUint32(a, le)],
  uint32: [4, (d, a, le) => d.getUint32(a, le)],
  float: [4, (d, a, le) => d.getFloat32(a, le)],
  float32: [4, (d, a, le) => d.getFloat32(a, le)],
  double: [8, (d, a, le) => d.getFloat64(a, le)],
  float64: [8, (d, a, le) => d.getFloat64(a, le)],
};

export function readPly(buf: ArrayBuffer, opts: ReadOptions = {}): RawCloud {
  const u8 = new Uint8Array(buf);
  // ヘッダは "end_header\n" まで
  const probe = new TextDecoder('latin1').decode(u8.subarray(0, Math.min(u8.length, 64 * 1024)));
  const endAt = probe.indexOf('end_header');
  if (endAt < 0) throw new Error('PLY のヘッダが読めません');
  const bodyStart = probe.indexOf('\n', endAt) + 1;
  const lines = probe.slice(0, endAt).split(/\r?\n/);
  const fmt = (lines.find((l) => l.startsWith('format')) ?? '').split(/\s+/)[1] ?? 'ascii';
  // 最初の element（vertex）の property だけ使う。前に別の element があるファイルは扱わない
  let count = 0;
  const props: { name: string; type: string }[] = [];
  let inVertex = false;
  for (const l of lines) {
    const t = l.trim().split(/\s+/);
    if (t[0] === 'element') {
      inVertex = t[1] === 'vertex';
      if (inVertex) count = +t[2];
      else if (props.length) break;
    } else if (t[0] === 'property' && inVertex) {
      if (t[1] === 'list') throw new Error('PLY の頂点に list の属性があり読めません');
      props.push({ type: t[1], name: t[2] });
    }
  }
  const idx = (n: string) => props.findIndex((p) => p.name === n);
  const ix = idx('x');
  const iy = idx('y');
  const iz = idx('z');
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('PLY に x・y・z がありません');
  const ir = [idx('red'), idx('r'), idx('diffuse_red')].find((i) => i >= 0) ?? -1;
  const ig = [idx('green'), idx('g'), idx('diffuse_green')].find((i) => i >= 0) ?? -1;
  const ib = [idx('blue'), idx('b'), idx('diffuse_blue')].find((i) => i >= 0) ?? -1;
  const ic = [idx('classification'), idx('class'), idx('scalar_classification')].find((i) => i >= 0) ?? -1;
  const hasRgb = ir >= 0 && ig >= 0 && ib >= 0;
  const vals = new Float64Array(props.length);
  const each = (visit: () => void) => {
    if (fmt === 'ascii') {
      const text = new TextDecoder().decode(u8.subarray(bodyStart));
      let pos = 0;
      for (let i = 0; i < count && pos < text.length; i++) {
        let nl = text.indexOf('\n', pos);
        if (nl < 0) nl = text.length;
        const t = text.slice(pos, nl).trim().split(/\s+/);
        pos = nl + 1;
        if (t.length < props.length) continue;
        for (let k = 0; k < props.length; k++) vals[k] = +t[k];
        visit();
      }
    } else {
      const le = fmt === 'binary_little_endian';
      const dv = new DataView(buf);
      const sizes = props.map((p) => PLY_TYPES[p.type]);
      if (sizes.some((s) => !s)) throw new Error('PLY の型が読めません');
      const stride = sizes.reduce((s, t) => s + t[0], 0);
      let at = bodyStart;
      for (let i = 0; i < count && at + stride <= buf.byteLength; i++) {
        let o = at;
        for (let k = 0; k < props.length; k++) {
          vals[k] = sizes[k][1](dv, o, le);
          o += sizes[k][0];
        }
        at += stride;
        visit();
      }
    }
  };
  // 1 周目で範囲を測り（filter の判定に使う）、2 周目で集める
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  each(() => {
    const x = vals[ix];
    const y = vals[iy];
    const z = vals[iz];
    if (x < bounds.minX) bounds.minX = x;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (y > bounds.maxY) bounds.maxY = y;
    if (z < bounds.minZ) bounds.minZ = z;
    if (z > bounds.maxZ) bounds.maxZ = z;
  });
  const header: CloudHeader = { format: 'ply', total: count, bounds };
  const keep = opts.filter?.(header) ?? null;
  const out = new Collector(opts.maxPoints ?? DEFAULT_MAX, hasRgb);
  // 色が 0〜1 の小数で入ったファイル（float の red）もある
  const colorScale = hasRgb && /float|double/.test(props[ir].type) ? 255 : 1;
  each(() => {
    const x = vals[ix];
    const y = vals[iy];
    if (keep && !keep(x, y)) return;
    out.push(x, y, vals[iz], ic >= 0 ? vals[ic] : 0, hasRgb ? vals[ir] * colorScale : 0, hasRgb ? vals[ig] * colorScale : 0, hasRgb ? vals[ib] * colorScale : 0);
  });
  return out.done(header);
}

// ---------------------------------------------------------------------------
// XYZ / CSV（x y z [分類] または x y z r g b）
// ---------------------------------------------------------------------------

export function readXyz(buf: ArrayBuffer, opts: ReadOptions = {}): RawCloud {
  const text = new TextDecoder().decode(new Uint8Array(buf));
  const rows: number[][] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^[#/%a-zA-Z"]/.test(t)) continue;
    const v = t.split(/[\s,;]+/).map(Number);
    if (v.length >= 3 && v.slice(0, 3).every(Number.isFinite)) rows.push(v);
  }
  if (!rows.length) throw new Error('XYZ の数字の行がありません（x y z の順に 1 行 1 点）');
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const [x, y, z] of rows) {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y);
    bounds.minZ = Math.min(bounds.minZ, z);
    bounds.maxZ = Math.max(bounds.maxZ, z);
  }
  const header: CloudHeader = { format: 'xyz', total: rows.length, bounds };
  const keep = opts.filter?.(header) ?? null;
  const cols = rows[0].length;
  const hasRgb = cols >= 6;
  const out = new Collector(opts.maxPoints ?? DEFAULT_MAX, hasRgb);
  for (const v of rows) {
    if (keep && !keep(v[0], v[1])) continue;
    if (hasRgb) out.push(v[0], v[1], v[2], 0, v[3], v[4], v[5]);
    else out.push(v[0], v[1], v[2], cols === 4 ? v[3] : 0);
  }
  return out.done(header);
}
