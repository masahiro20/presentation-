#!/usr/bin/env node
/**
 * サンプルの住宅 3DS（public/samples/sample_house.3ds）を生成する、最小の 3DS バイナリライター
 *
 * 使い方:
 *   node scripts/make-sample-3ds.mjs                      → public/samples/sample_house.3ds
 *   node scripts/make-sample-3ds.mjs --scale 0.5 --out X  → MASTER_SCALE = 0.5 の変種をテスト用に X へ書く
 *   node scripts/make-sample-3ds.mjs --site --out X       → 敷地の板（オブジェクト名 'site'）を加えた変種を X へ書く
 *     （--site も --scale ≠ 1 も、既定の出力 public/samples/sample_house.3ds は上書きしない）
 *
 * 書くチャンク（lib3ds / TDSLoader が読む範囲）:
 *   0x4D4D M3DMAGIC
 *     0x0002 M3D_VERSION (uint32 3)
 *     0x3D3D MDATA
 *       0x3D3E MESH_VERSION (uint32 3)
 *       0x0100 MASTER_SCALE (float32)
 *       0xAFFF MAT_ENTRY × n: 0xA000 MAT_NAME (cstr), 0xA020 MAT_DIFFUSE → 0x0011 COLOR_24 (RGB 3 バイト)
 *       0x4000 NAMED_OBJECT × n: 名前 (cstr) + 0x4100 N_TRI_OBJECT
 *         0x4110 POINT_ARRAY (uint16 n, n × 3 float32)
 *         0x4160 MESH_MATRIX (12 float32、単位行列)
 *         0x4120 FACE_ARRAY (uint16 n, n × (a b c flags) uint16) + 0x4130 MSH_MAT_GROUP (全面をひとつの材質に)
 *
 * 形: ミリメートル・Z-up。平面の中心が原点、底面 z = 0。
 *   wall     主屋 9100 (x) × 7280 (y)、軒高 6000
 *   roof     切妻（棟は x 方向、棟高 8200）。妻側（±x）に 600 のけらば（はね出し）
 *   porch    ポーチ 2000 × 1500 × 2400（+y = 北側）
 *   window_1 / window_2  南面（−y）の浅い窓の箱（面から 10 mm 出て 120 mm 入る）
 *   site（--site のときだけ） 敷地の薄い板 x −5000..9000、y −7000..5000、z −10..0。材質 site '#c8c0a8'
 *   材質: wall '#f0ece4'（wall・porch）、roof '#5a5e66'（roof・窓）
 *   三角形はすべて外向きで反時計回り（右手系で法線が外を向く）。
 *
 * MASTER_SCALE について: TDSLoader は MASTER_SCALE を group.scale に入れるので、
 * `--scale S` では頂点座標を 1/S 倍して書く（S × 座標 = 実寸）。読み込み結果（焼き込み後）は S = 1 と同じになる。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// バイト列
// ---------------------------------------------------------------------------

const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
const f32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v);
  return b;
};
/** NULL 終端の ASCII 文字列 */
const cstr = (s) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(1)]);
/** チャンク = id (uint16) + 全長 (uint32、ヘッダー 6 バイトを含む) + 中身 */
const chunk = (id, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u16(id), u32(6 + body.length), body]);
};
const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`色の形式が不正です: ${hex}`);
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
/** 面フラグ: AB・BC・CA の辺をすべて可視 */
const FACE_FLAGS = 0x0007;

// ---------------------------------------------------------------------------
// 形（頂点と三角形。外向き・反時計回り）
// ---------------------------------------------------------------------------

/** 四角形 a,b,c,d（外から見て反時計回り）→ 三角形 2 つ */
const quad = (a, b, c, d) => [
  [a, b, c],
  [a, c, d],
];

/** 軸に平行な箱 */
export function box(x0, x1, y0, y1, z0, z1) {
  const verts = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const faces = [
    ...quad(0, 3, 2, 1), // 底 (−z)
    ...quad(4, 5, 6, 7), // 天 (+z)
    ...quad(0, 1, 5, 4), // 南 (−y)
    ...quad(2, 3, 7, 6), // 北 (+y)
    ...quad(3, 0, 4, 7), // 西 (−x)
    ...quad(1, 2, 6, 5), // 東 (+x)
  ];
  return { verts, faces };
}

/**
 * 切妻屋根（三角形の断面を x 方向に押し出した閉じた立体）
 * 棟は y = 0・z = ridgeZ、軒は y = ±halfY・z = eaveZ、x は x0..x1
 */
export function gableRoof(x0, x1, halfY, eaveZ, ridgeZ) {
  const verts = [
    [x0, -halfY, eaveZ], // 0 西・南軒
    [x0, 0, ridgeZ], // 1 西・棟
    [x0, halfY, eaveZ], // 2 西・北軒
    [x1, -halfY, eaveZ], // 3 東・南軒
    [x1, 0, ridgeZ], // 4 東・棟
    [x1, halfY, eaveZ], // 5 東・北軒
  ];
  const faces = [
    ...quad(0, 3, 4, 1), // 南の屋根面（法線 −y, +z）
    ...quad(2, 1, 4, 5), // 北の屋根面（法線 +y, +z）
    [0, 1, 2], // 西の妻（−x）
    [3, 5, 4], // 東の妻（+x）
    ...quad(0, 2, 5, 3), // 軒裏（−z）
  ];
  return { verts, faces };
}

/** サンプル住宅の寸法 (mm) */
export const HOUSE = {
  wallX: 9100,
  wallY: 7280,
  eaves: 6000,
  ridge: 8200,
  overhang: 600,
  porch: { w: 2000, d: 1500, h: 2400 },
  window: { w: 1650, sill: 900, head: 2000, proud: 10, depth: 120 },
  materials: { wall: '#f0ece4', roof: '#5a5e66' },
};

/** 敷地の板（--site）: 住宅の周りに非対称に広がる 14 × 12 m の薄い板。名前 'site' で読み込み時に自動で非表示になる */
export const SITE = { x0: -5000, x1: 9000, y0: -7000, y1: 5000, z0: -10, z1: 0, material: '#c8c0a8' };

/** 敷地の板のオブジェクト（houseObjects() の後ろに足す） */
export function siteObject(s = SITE) {
  return { name: 'site', material: 'site', geometry: box(s.x0, s.x1, s.y0, s.y1, s.z0, s.z1) };
}

/** オブジェクト一覧 [{ name, material, geometry }] */
export function houseObjects(h = HOUSE) {
  const hx = h.wallX / 2;
  const hy = h.wallY / 2;
  const w = h.window;
  const px = h.porch.w / 2;
  return [
    { name: 'wall', material: 'wall', geometry: box(-hx, hx, -hy, hy, 0, h.eaves) },
    { name: 'roof', material: 'roof', geometry: gableRoof(-hx - h.overhang, hx + h.overhang, hy, h.eaves, h.ridge) },
    { name: 'porch', material: 'wall', geometry: box(-px, px, hy, hy + h.porch.d, 0, h.porch.h) },
    { name: 'window_1', material: 'roof', geometry: box(-3500, -3500 + w.w, -hy - w.proud, -hy + w.depth, w.sill, w.head) },
    { name: 'window_2', material: 'roof', geometry: box(3500 - w.w, 3500, -hy - w.proud, -hy + w.depth, w.sill, w.head) },
  ];
}

// ---------------------------------------------------------------------------
// 3DS の組み立て
// ---------------------------------------------------------------------------

function materialChunk(name, hex) {
  return chunk(0xafff, chunk(0xa000, cstr(name)), chunk(0xa020, chunk(0x0011, Buffer.from(hexToRgb(hex)))));
}

function namedObjectChunk(name, geometry, materialName, scale) {
  const { verts, faces } = geometry;
  if (verts.length > 65535 || faces.length > 65535) throw new Error(`${name}: 3DS の上限（65535）を超えています`);
  const points = chunk(0x4110, u16(verts.length), ...verts.flatMap((v) => v.map((c) => f32(c / scale))));
  const matrix = chunk(0x4160, ...IDENTITY.map(f32));
  const matGroup = chunk(0x4130, cstr(materialName), u16(faces.length), ...faces.map((_, i) => u16(i)));
  const faceArray = chunk(0x4120, u16(faces.length), ...faces.flatMap(([a, b, c]) => [u16(a), u16(b), u16(c), u16(FACE_FLAGS)]), matGroup);
  return chunk(0x4000, cstr(name), chunk(0x4100, points, matrix, faceArray));
}

/**
 * 3DS ファイルのバイト列を作る
 * @param {{ scale?: number, site?: boolean, objects?: ReturnType<typeof houseObjects>, materials?: Record<string, string> }} opts
 * @returns {Buffer}
 */
export function buildSampleHouse3ds(opts = {}) {
  const scale = opts.scale ?? 1;
  if (!(Number.isFinite(scale) && scale > 0)) throw new Error(`--scale は正の数で指定してください: ${scale}`);
  // --site: 材質とオブジェクトを後ろに足すだけなので、既定の出力（site 無し）のバイト列は変わらない
  const materials = opts.materials ?? (opts.site ? { ...HOUSE.materials, site: SITE.material } : HOUSE.materials);
  const objects = opts.objects ?? (opts.site ? [...houseObjects(), siteObject()] : houseObjects());
  for (const o of objects) if (!(o.material in materials)) throw new Error(`${o.name}: 材質 ${o.material} が定義されていません`);
  return chunk(
    0x4d4d,
    chunk(0x0002, u32(3)),
    chunk(
      0x3d3d,
      chunk(0x3d3e, u32(3)),
      chunk(0x0100, f32(scale)),
      ...Object.entries(materials).map(([name, hex]) => materialChunk(name, hex)),
      ...objects.map((o) => namedObjectChunk(o.name, o.geometry, o.material, scale)),
    ),
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { scale: 1, out: null, site: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scale') out.scale = Number(argv[++i]);
    else if (a.startsWith('--scale=')) out.scale = Number(a.slice(8));
    else if (a === '--out') out.out = argv[++i];
    else if (a.startsWith('--out=')) out.out = a.slice(6);
    else if (a === '--site') out.site = true;
    else throw new Error(`不明な引数: ${a}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const defaultOut = path.join(root, 'public', 'samples', 'sample_house.3ds');
  if ((args.scale !== 1 || args.site) && !args.out) {
    console.error('--scale が 1 以外、または --site のときは --out で出力先を指定してください（public/ のサンプルを上書きしません）');
    process.exit(1);
  }
  const outPath = path.resolve(args.out ?? defaultOut);
  if (args.site && path.resolve(outPath) === path.resolve(defaultOut)) {
    console.error('--site の出力先に public/samples/sample_house.3ds は指定できません');
    process.exit(1);
  }
  const buf = buildSampleHouse3ds({ scale: args.scale, site: args.site });
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, buf);
  const objects = args.site ? [...houseObjects(), siteObject()] : houseObjects();
  const tris = objects.reduce((s, o) => s + o.geometry.faces.length, 0);
  console.log(`${path.relative(process.cwd(), outPath)}: ${buf.length} bytes, ${objects.length} objects (${objects.map((o) => o.name).join(', ')}), ${tris} triangles, MASTER_SCALE ${args.scale}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
