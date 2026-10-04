/**
 * 3D データの読み込み（3DS を主、OBJ / STL / GLB / FBX も可）・単位の推定・正規化・配置
 *
 * 正規化: 単位 → m に拡大縮小、上方向を Y に（Z-up は rotateX(-π/2): (x,y,z)→(x,z,-y)）、
 *         水平の中心を原点に、底面を y=0 に。鏡像なら x を反転。
 * 配置:   pivot.position = (offsetE, baseY, -offsetN)、pivot.rotation.y = -headingDeg(rad)
 *         （headingDeg: モデル平面の上 (変換後 -Z) が向く方位、真北から時計回り）
 *
 * 読み込みの方針（どんなデータでも落ちない・固まらない・網羅する）:
 *  - テクスチャは読まない。参照先の画像が無いことがほとんどで、404 やネットワーク待ちの原因になる。
 *    ローダーには専用の LoadingManager を渡し、すべての URL を 1×1 の白 PNG（data URL）に差し替える。
 *    3DS はさらに TDSLoader.readMap を差し替えて、テクスチャのチャンクを読み飛ばす（Node でも動く）。
 *  - 読み込んだ Object3D は、各メッシュのワールド行列を頂点に焼き込み（bake）、
 *    非インデックス・フラット法線・位置のみの BufferGeometry にそろえる（raw グループ、変換は単位行列）。
 *    こうすることで、マテリアルグループの不備（3DS で面がどのグループにも属さない → 描かれない）や
 *    特異な行列、不正なインデックス、NaN 頂点があっても「面はすべて描かれ、解析（BVH）にも乗る」。
 *  - 元のマテリアルは色・不透明度だけ userData に残し（origColor / origOpacity）、表示時に
 *    MeshStandardMaterial（白モデル／元の色）に差し替える。ガラスらしいもの（半透明・名前）は影を落とさない。
 */
import * as THREE from 'three';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import type { ImportedModel, LengthUnit, ModelFormat, ModelObjectInfo, ModelPlacement, UpAxis } from './types';
import { UNIT_METERS } from './types';

export const ACCEPT_EXT = ['3ds', 'obj', 'stl', 'glb', 'gltf', 'fbx'];

/** 1×1 の白 PNG。テクスチャの参照先をすべてここに向ける（何も取得しない） */
const WHITE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';

/** ガラスと見なす名前（メッシュ名・マテリアル名） */
const GLASS_RE = /glass|ガラス|window|窓/i;
/** 建物以外（地面・敷地・ダミー・カメラ・ライト）と見なすオブジェクト名 */
const NON_BUILDING_RE = /ground|site|terrain|plane|dummy|camera|light|地盤|敷地|地面/i;
/** 名前の無いオブジェクトのまとめ名 */
const UNNAMED = '(名前なし)';

/** 白モデルの色 */
const WHITE_COLOR = '#f2f0ea';
/** 白モデルのガラスの色（少し青みの灰色・半透明） */
const WHITE_GLASS_COLOR = '#dfe6ea';

/** 焼き込んだメッシュの userData */
export interface BakedMeshData {
  /** 元のマテリアルの色（複数なら最初の黒でない色。無ければ白） */
  origColor: THREE.Color;
  /** 元の不透明度（0..1） */
  origOpacity: number;
  /** ガラスらしい（半透明・名前）。影を落とさない */
  glass: boolean;
  /** 解析（日影）から除く印。glass と同じ */
  noShadow: boolean;
  /** 元のマテリアル名（参考） */
  materialName: string;
}

/** ファイル名から形式を判定（対応外は null）。.gltf は 'glb' として扱う */
export function detectFormat(name: string): ModelFormat | null {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === '3ds') return '3ds';
  if (ext === 'obj') return 'obj';
  if (ext === 'stl') return 'stl';
  if (ext === 'glb' || ext === 'gltf') return 'glb';
  if (ext === 'fbx') return 'fbx';
  return null;
}

/** 3DS の先頭識別子（M3DMAGIC 0x4D4D、リトルエンディアン）か */
export function is3dsBuffer(data: ArrayBuffer): boolean {
  if (data.byteLength < 6) return false;
  return new DataView(data).getUint16(0, true) === 0x4d4d;
}

/**
 * ファイルを読み込む。テクスチャは読まない（参照先が無いことが多い）。
 * 読み込み後に、面の無いオブジェクトを除き、法線が無ければ計算し、三角形数と bbox を数える。
 * 単位は guessUnit、上方向は guessUpAxis で推定（3DS の既定は Z-up）。
 */
export async function importModelFile(file: { name: string; data: ArrayBuffer }): Promise<ImportedModel> {
  const format = detectFormat(file.name);
  if (!format) throw new Error(`対応していない形式です（${ACCEPT_EXT.map((e) => '.' + e).join(' / ')}）: ${file.name}`);
  if (!(file.data instanceof ArrayBuffer) || file.data.byteLength === 0) throw new Error('ファイルが空です');
  if (format === '3ds' && !is3dsBuffer(file.data)) throw new Error('3DS 形式のファイルではないようです（先頭の識別子が 4D4D ではありません）');

  const notes: string[] = [];
  let root: THREE.Object3D;
  try {
    root = await parseModel(format, file.name, file.data, notes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${format.toUpperCase()} の読み込みに失敗しました: ${msg}`);
  }

  const { raw, dropped } = bakeObject(root, format);
  if (dropped > 0) notes.push(`不正な三角形（NaN・範囲外のインデックス）を ${dropped} 個除きました`);
  if (raw.children.length === 0) throw new Error('面（三角形）を持つオブジェクトが見つかりませんでした');

  // オブジェクト一覧と bbox。上方向の推定 → 地面の板などの自動除外 → 建物だけの bbox → 上方向を再確認
  const boxAll = boxOfMeshes(raw.children as THREE.Mesh[]);
  let up = guessUpAxis(format, boxAll);
  let objects = describeObjects(raw, up);
  let rawBox = boxOfObjects(raw, objects);
  const up2 = guessUpAxis(format, rawBox);
  if (up2 !== up) {
    up = up2;
    objects = describeObjects(raw, up);
    rawBox = boxOfObjects(raw, objects);
  }
  const triangles = objects.reduce((s, o) => s + o.triangles, 0);
  const hidden = objects.filter((o) => o.autoHidden);
  if (hidden.length) notes.push(`建物以外と判定して除外: ${hidden.map((o) => o.name).join(', ')}（オブジェクト一覧で戻せます）`);
  const glassCount = raw.children.filter((m) => (m.userData as BakedMeshData).glass).length;
  if (glassCount) notes.push(`ガラスと判定したオブジェクト（影を落とさない）: ${glassCount} 個`);

  return {
    name: file.name,
    format,
    data: file.data,
    raw,
    rawBox,
    triangles,
    objects,
    guessedUnit: guessUnit(rawBox, up),
    guessedUp: up,
    notes,
  };
}

// ---------------------------------------------------------------------------
// 形式ごとの読み込み（テクスチャ無し）
// ---------------------------------------------------------------------------

/** すべての URL（または画像らしい URL）を白 PNG に向ける LoadingManager */
function quietManager(all: boolean): THREE.LoadingManager {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (all) return WHITE_PNG;
    // GLB/FBX: 画像だけ差し替える（.gltf の外部 .bin などはそのまま）
    if (/^blob:/.test(url) || /\.(png|jpe?g|webp|gif|bmp|tga|tiff?|dds|ktx2?|psd|exr|hdr)(\?.*)?$/i.test(url)) return WHITE_PNG;
    return url;
  });
  return manager;
}

async function parseModel(format: ModelFormat, name: string, data: ArrayBuffer, notes: string[]): Promise<THREE.Object3D> {
  switch (format) {
    case '3ds': {
      const prepared = prepare3ds(data, notes);
      const loader = new TDSLoader(quietManager(true));
      // テクスチャのチャンク（MAT_TEXMAP 等）は読まない。親チャンクの読み進めはチャンク長で行われるので、
      // 中身を読まなくても次のチャンクに正しく進む（Chunk.readChunk が position += next.size する）
      (loader as unknown as { readMap: () => null }).readMap = () => null;
      return loader.parse(prepared, '');
    }
    case 'obj': {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      const text = new TextDecoder('utf-8').decode(new Uint8Array(data));
      // .mtl は読まない（色は MTL が無ければ白）
      return new OBJLoader(quietManager(true)).parse(text);
    }
    case 'stl': {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
      const geo = new STLLoader(quietManager(true)).parse(data);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
      mesh.name = name.replace(/\.[^.]+$/, '');
      return mesh;
    }
    case 'glb': {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader(quietManager(false));
      if (!/^glTF/.test(new TextDecoder().decode(new Uint8Array(data, 0, Math.min(4, data.byteLength))))) {
        // .gltf（JSON）。外部ファイル（.bin）を参照していると読めない
        const json = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(data)));
        const ext = (json.buffers ?? []).some((b: { uri?: string }) => typeof b.uri === 'string' && !/^data:/.test(b.uri));
        if (ext) throw new Error('外部の .bin を参照する .gltf は読み込めません。.glb（1 ファイル）で保存してください');
      }
      const gltf = await loader.parseAsync(data, '');
      notes.push('GLB のテクスチャは使いません（色のみ）');
      return gltf.scene;
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
      const root = new FBXLoader(quietManager(false)).parse(data, '');
      notes.push('FBX のテクスチャ・アニメーションは使いません');
      return root;
    }
  }
}

// ---------------------------------------------------------------------------
// 3DS の前処理（TDSLoader が固まる・形が壊れるデータへの備え）
// ---------------------------------------------------------------------------

const C3DS = {
  MAIN: 0x4d4d,
  MLIB: 0x3daa,
  CMAGIC: 0xc23d,
  MDATA: 0x3d3d,
  NAMED_OBJECT: 0x4000,
  N_TRI_OBJECT: 0x4100,
  FACE_ARRAY: 0x4120,
  MESH_MATRIX: 0x4160,
  MAT_ENTRY: 0xafff,
  MAT_TEXMAP: 0xa200,
  MAT_SPECMAP: 0xa204,
  MAT_OPACMAP: 0xa210,
  MAT_BUMPMAP: 0xa230,
} as const;

/**
 * 3DS のチャンク構造を TDSLoader と同じ順路で歩き、
 *  - 長さ 0 のチャンク（TDSLoader の readChunk が無限ループになる）→ エラー
 *  - ファイル末尾を超えるチャンク → 読める範囲だけ（注意を残す）
 *  - 特異な MESH_MATRIX（全部 0 など。TDSLoader は逆行列を掛けるので頂点がすべて 0 になる）→ 単位行列に書き換える
 * 書き換えるため、複製したバッファを返す。
 */
export function prepare3ds(src: ArrayBuffer, notes: string[]): ArrayBuffer {
  const buf = src.slice(0);
  const dv = new DataView(buf);
  let singular = 0;
  let textures = 0;
  let truncated = false;

  const skipString = (pos: number, end: number): number => {
    while (pos < end && dv.getUint8(pos) !== 0) pos++;
    return Math.min(pos + 1, end);
  };

  const walk = (start: number, end: number, depth: number) => {
    let pos = start;
    while (pos + 6 <= end) {
      const id = dv.getUint16(pos, true);
      const size = dv.getUint32(pos + 2, true);
      if (size < 6) throw new Error('3DS ファイルの構造が壊れています（長さ 0 のチャンク）');
      let cend = pos + size;
      if (cend > end) {
        truncated = true;
        if (depth > 0) break;
        cend = end; // 先頭チャンクの長さがファイルより大きい（切れたファイル）: 読める範囲だけ
      }
      const body = pos + 6;
      switch (id) {
        case C3DS.MAIN:
        case C3DS.MLIB:
        case C3DS.CMAGIC:
        case C3DS.MDATA:
        case C3DS.N_TRI_OBJECT:
        case C3DS.MAT_ENTRY:
          walk(body, cend, depth + 1);
          break;
        case C3DS.NAMED_OBJECT:
          walk(skipString(body, cend), cend, depth + 1);
          break;
        case C3DS.FACE_ARRAY: {
          if (body + 2 <= cend) {
            const faces = dv.getUint16(body, true);
            walk(body + 2 + faces * 8, cend, depth + 1);
          }
          break;
        }
        case C3DS.MESH_MATRIX: {
          if (body + 48 <= cend) {
            const v: number[] = [];
            for (let i = 0; i < 12; i++) v.push(dv.getFloat32(body + i * 4, true));
            const det = v[0] * (v[4] * v[8] - v[5] * v[7]) - v[1] * (v[3] * v[8] - v[5] * v[6]) + v[2] * (v[3] * v[7] - v[4] * v[6]);
            const n0 = Math.hypot(v[0], v[1], v[2]);
            const n1 = Math.hypot(v[3], v[4], v[5]);
            const n2 = Math.hypot(v[6], v[7], v[8]);
            if (!Number.isFinite(det) || Math.abs(det) <= 1e-10 * Math.max(n0 * n1 * n2, 1e-30)) {
              const ident = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
              for (let i = 0; i < 12; i++) dv.setFloat32(body + i * 4, ident[i], true);
              singular++;
            }
          }
          break;
        }
        case C3DS.MAT_TEXMAP:
        case C3DS.MAT_SPECMAP:
        case C3DS.MAT_OPACMAP:
        case C3DS.MAT_BUMPMAP:
          textures++;
          break;
      }
      pos = cend;
    }
  };
  walk(0, buf.byteLength, 0);

  if (textures) notes.push(`3DS のテクスチャ（${textures} 枚）は読み込みません（色のみ）`);
  if (singular) notes.push(`特異な変換行列（MESH_MATRIX）を ${singular} 個補正しました`);
  if (truncated) notes.push('ファイル末尾が切れているため、読める範囲だけ読み込みました');
  return buf;
}

// ---------------------------------------------------------------------------
// 焼き込み（bake）: ワールド行列 → 頂点、非インデックス、フラット法線、位置のみ
// ---------------------------------------------------------------------------

const TEXTURE_KEYS = ['map', 'alphaMap', 'bumpMap', 'specularMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'lightMap', 'displacementMap', 'envMap'] as const;

/** マテリアル（配列も可）から色・不透明度・ガラス判定を取り出し、テクスチャを捨てる */
function materialInfo(material: THREE.Material | THREE.Material[], meshName: string, format: ModelFormat | null): BakedMeshData {
  const mats = (Array.isArray(material) ? material : [material]).filter((m): m is THREE.Material => !!m);
  let color: THREE.Color | null = null;
  let opacity = 1;
  for (const m of mats) {
    const c = (m as THREE.MeshStandardMaterial).color;
    if (!color && c && c.isColor && c.r + c.g + c.b > 0.02) {
      color = c.clone();
      // 3DS / OBJ(MTL) の 8bit 色は sRGB。ローダーはそのまま作業色空間（リニア）に入れるので変換する
      if (format === '3ds' || format === 'obj') color.convertSRGBToLinear();
    }
    if (typeof m.opacity === 'number' && (m.transparent || m.opacity < 1)) opacity = Math.min(opacity, m.opacity);
    const tr = (m as THREE.MeshPhysicalMaterial).transmission;
    if (typeof tr === 'number' && tr > 0.5) opacity = Math.min(opacity, 0.3);
    for (const k of TEXTURE_KEYS) {
      const t = (m as unknown as Record<string, THREE.Texture | null>)[k];
      if (t && (t as THREE.Texture).isTexture) {
        t.dispose();
        (m as unknown as Record<string, THREE.Texture | null>)[k] = null;
      }
    }
  }
  const glassLike = (m: THREE.Material) => m.opacity < 0.5 || ((m as THREE.MeshPhysicalMaterial).transmission ?? 0) > 0.5 || GLASS_RE.test(m.name);
  const glass = GLASS_RE.test(meshName) || (mats.length > 0 && mats.every(glassLike));
  return {
    origColor: color ?? new THREE.Color(1, 1, 1),
    origOpacity: Math.max(0, Math.min(1, opacity)),
    glass,
    noShadow: glass,
    materialName: mats.map((m) => m.name).filter(Boolean).join(', '),
  };
}

/**
 * メッシュの三角形をワールド座標に変換して、位置だけの非インデックス配列にする。
 * 不正なインデックス・非有限の座標を含む三角形は除く。flip なら頂点 1,2 を入れ替えて面の向きを反転する。
 * 戻り値: [位置配列, 除いた三角形数]
 */
function bakeTriangles(geo: THREE.BufferGeometry, M: THREE.Matrix4, flip: boolean): [Float32Array, number] {
  const pos = geo.getAttribute('position');
  if (!pos || pos.itemSize < 3 || pos.count < 3) return [new Float32Array(0), 0];
  const idx = geo.index;
  const n = pos.count;
  const triCount = idx ? Math.floor(idx.count / 3) : Math.floor(n / 3);
  const out = new Float32Array(triCount * 9);
  const v = new THREE.Vector3();
  let w = 0;
  let bad = 0;
  for (let t = 0; t < triCount; t++) {
    let a: number, b: number, c: number;
    if (idx) {
      a = idx.getX(t * 3);
      b = idx.getX(t * 3 + 1);
      c = idx.getX(t * 3 + 2);
    } else {
      a = t * 3;
      b = a + 1;
      c = a + 2;
    }
    if (flip) {
      const tmp = b;
      b = c;
      c = tmp;
    }
    if (!(a >= 0 && a < n && b >= 0 && b < n && c >= 0 && c < n)) {
      bad++;
      continue;
    }
    const base = w;
    let ok = true;
    for (const i of [a, b, c]) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
        ok = false;
        break;
      }
      v.applyMatrix4(M);
      out[w++] = v.x;
      out[w++] = v.y;
      out[w++] = v.z;
    }
    if (!ok) {
      w = base;
      bad++;
    }
  }
  return [w === out.length ? out : out.slice(0, w), bad];
}

/**
 * 読み込んだ Object3D の全メッシュを焼き込み、平らな raw グループ（各メッシュは単位変換）にする。
 * メッシュ名（オブジェクト名）と元の色・不透明度・ガラス判定を userData（BakedMeshData）に残す。
 * 線・点・面の無いジオメトリは除く。ワールド行列の行列式が 0 なら単位行列扱い、負なら面の向きを直す。
 * 元のジオメトリ・マテリアルは破棄する（root は使えなくなる）。
 */
export function bakeObject(root: THREE.Object3D, format: ModelFormat | null = null): { raw: THREE.Group; dropped: number } {
  root.updateMatrixWorld(true);
  const raw = new THREE.Group();
  raw.name = 'raw';
  let dropped = 0;
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) meshes.push(m);
  });
  let unnamed = 0;
  for (const mesh of meshes) {
    let M = mesh.matrixWorld;
    let det = M.determinant();
    if (!Number.isFinite(det) || det === 0) {
      M = new THREE.Matrix4();
      det = 1;
    }
    const [positions, bad] = bakeTriangles(mesh.geometry, M, det < 0);
    dropped += bad;
    const name = mesh.name || mesh.parent?.name || '';
    if (!name) unnamed++;
    const info = materialInfo(mesh.material, name, format);
    // 元のジオメトリ・マテリアルは不要（ローダーの出力は捨てる）
    mesh.geometry.dispose();
    for (const mt of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mt?.dispose();
    if (positions.length < 9) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals(); // 非インデックスなのでフラット法線
    geo.computeBoundingBox();
    const baked = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: WHITE_COLOR }));
    baked.name = name || UNNAMED;
    baked.userData = info;
    raw.add(baked);
  }
  void unnamed;
  raw.updateMatrixWorld(true);
  return { raw, dropped };
}

function boxOfMeshes(meshes: THREE.Mesh[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const m of meshes) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox!);
  }
  return box;
}

/** 名前ごとにまとめたオブジェクト一覧。地面の板など建物以外を自動判定する */
export function describeObjects(raw: THREE.Object3D, up: UpAxis): ModelObjectInfo[] {
  const acc = new Map<string, { box: THREE.Box3; triangles: number }>();
  for (const o of raw.children) {
    const m = o as THREE.Mesh;
    if (!m.isMesh) continue;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const tri = Math.floor(m.geometry.getAttribute('position').count / 3);
    const e = acc.get(m.name);
    if (e) {
      e.box.union(m.geometry.boundingBox!);
      e.triangles += tri;
    } else acc.set(m.name, { box: m.geometry.boundingBox!.clone(), triangles: tri });
  }
  const [h0, h1, upIdx] = up === 'z' ? [0, 1, 2] : [0, 2, 1];
  const entries = [...acc.entries()].map(([name, e]) => {
    const s = e.box.getSize(new THREE.Vector3()).toArray() as [number, number, number];
    const footprint = s[h0] * s[h1];
    const extent = Math.max(s[h0], s[h1]);
    const height = s[upIdx];
    return { name, e, s, footprint, extent, height };
  });
  // 足跡の中央値（下側）。これの 4 倍より大きく、かつ薄い板なら地面・敷地と見なす
  const sorted = entries.map((x) => x.footprint).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  return entries.map(({ name, e, s, footprint, extent, height }) => {
    let reason: string | undefined;
    if (NON_BUILDING_RE.test(name)) reason = '名前から地面・敷地・ダミーなどと判定';
    else if (footprint > 4 * median && height < 0.02 * extent) reason = '大きく薄い板（地面・敷地）と判定';
    const info: ModelObjectInfo = { name, triangles: e.triangles, size: s, autoHidden: !!reason };
    if (reason) info.reason = reason;
    return info;
  });
}

/** autoHidden でないオブジェクトの bbox（すべて autoHidden なら全体） */
function boxOfObjects(raw: THREE.Object3D, objects: ModelObjectInfo[]): THREE.Box3 {
  const hidden = new Set(objects.filter((o) => o.autoHidden).map((o) => o.name));
  const meshes = raw.children.filter((o) => (o as THREE.Mesh).isMesh) as THREE.Mesh[];
  const kept = meshes.filter((m) => !hidden.has(m.name));
  return boxOfMeshes(kept.length ? kept : meshes);
}

// ---------------------------------------------------------------------------
// 単位・上方向の推定
// ---------------------------------------------------------------------------

/**
 * 寸法から単位を推定: 水平の長辺 L（元の単位）が
 *   L > 1500 → 'mm'、150 < L ≤ 1500 → 'cm'、L ≤ 150 → 'm'
 * （住宅の長辺 5〜30 m を想定。インチ・フィートは自動では選ばない）
 */
export function guessUnit(rawBox: THREE.Box3, upAxis: UpAxis): LengthUnit {
  if (rawBox.isEmpty()) return 'mm';
  const s = rawBox.getSize(new THREE.Vector3());
  const L = upAxis === 'z' ? Math.max(s.x, s.y) : Math.max(s.x, s.z);
  if (L > 1500) return 'mm';
  if (L > 150) return 'cm';
  return 'm';
}

/**
 * 上方向の推定: 形式の既定（3DS/OBJ/STL は 'z'、GLB/FBX は 'y'）を使う。
 * ただし bbox が強く矛盾するとき（既定の上軸の長さが 3 軸で最大で、もう一方の候補軸が最小、かつ比が 1.5 倍超）は、
 * 「建物は高さより幅が大きいことが多い」として最も薄い候補軸を上にする。
 * （住宅を想定した簡単な規則。塔のような建物では UI で切り替える）
 */
export function guessUpAxis(format: ModelFormat, rawBox: THREE.Box3): UpAxis {
  const def: UpAxis = format === 'glb' || format === 'fbx' ? 'y' : 'z';
  if (rawBox.isEmpty()) return def;
  const s = rawBox.getSize(new THREE.Vector3());
  const other: UpAxis = def === 'z' ? 'y' : 'z';
  const sDef = def === 'z' ? s.z : s.y;
  const sOther = other === 'z' ? s.z : s.y;
  const largest = sDef >= s.x && sDef >= sOther;
  const smallest = sOther <= s.x && sOther <= sDef;
  if (largest && smallest && sOther > 0 && sDef > 1.5 * sOther) return other;
  return def;
}

/** 1 モデル単位の長さ (m) */
export function unitScale(p: Pick<ModelPlacement, 'unit' | 'customScale'>): number {
  if (p.unit === 'custom') return Number.isFinite(p.customScale) && p.customScale > 0 ? p.customScale : 1;
  return UNIT_METERS[p.unit] ?? 1;
}

// ---------------------------------------------------------------------------
// 表示用マテリアル
// ---------------------------------------------------------------------------

/** 焼き込んだメッシュの userData から表示用マテリアルを作る */
function makeMaterial(ud: Partial<BakedMeshData>, mode: 'white' | 'original'): THREE.MeshStandardMaterial {
  const glass = !!ud.glass;
  const original = mode === 'original' && ud.origColor instanceof THREE.Color;
  const color = original ? ud.origColor!.clone() : new THREE.Color(glass ? WHITE_GLASS_COLOR : WHITE_COLOR);
  const m = new THREE.MeshStandardMaterial({ color, roughness: glass ? 0.25 : 0.9, metalness: 0, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide });
  m.name = `${mode}${glass ? '-glass' : ''}`;
  if (glass) {
    m.transparent = true;
    m.opacity = original ? 0.35 : 0.45;
    m.depthWrite = false;
  } else if (original && typeof ud.origOpacity === 'number' && ud.origOpacity < 1) {
    m.transparent = true;
    m.opacity = Math.max(0.1, ud.origOpacity);
  }
  return m;
}

/** 白モデル／元の色の切替（全メッシュの material を差し替える。古い material は破棄） */
export function applyAppearance(root: THREE.Object3D, mode: 'white' | 'original'): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const old = m.material;
    m.material = makeMaterial(m.userData as Partial<BakedMeshData>, mode);
    for (const mt of Array.isArray(old) ? old : [old]) mt?.dispose();
    const glass = !!(m.userData as Partial<BakedMeshData>).glass;
    m.castShadow = !glass;
    m.receiveShadow = true;
  });
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 配置済みの建物。pivot をシーンの building グループに入れる */
export class PlacedModel {
  readonly pivot = new THREE.Group();
  /** 正規化したモデル（pivot の子） */
  object: THREE.Group | null = null;
  /** 正規化後の大きさ (m): x=幅(東西・回転前), y=高さ, z=奥行(南北・回転前) */
  size = new THREE.Vector3();
  /** 正規化後の bbox（pivot のローカル: 水平中心 0、底面 y=0） */
  localBox = new THREE.Box3();

  constructor(
    public model: ImportedModel,
    public placement: ModelPlacement,
  ) {
    this.pivot.name = 'building';
    this.rebuild();
    this.applyTransform();
  }

  /** 単位・上方向・鏡像・表示が変わったとき: raw から作り直す（元のマテリアル色は保持） */
  rebuild(): void {
    this.clearObject();
    const p = this.placement;
    const hidden = new Set(p.hiddenObjects ?? []);
    const object = new THREE.Group();
    object.name = 'model';
    const inner = new THREE.Group();
    inner.name = 'inner';
    for (const o of this.model.raw.children) {
      const src = o as THREE.Mesh;
      if (!src.isMesh || hidden.has(src.name)) continue;
      // ジオメトリは共有（model のもの）。マテリアルは applyAppearance で作る
      const m = new THREE.Mesh(src.geometry, src.material);
      m.name = src.name;
      m.userData = { ...src.userData };
      inner.add(m);
    }
    applyAppearance(inner, p.appearance);
    const s = unitScale(p);
    // 鏡像は x を反転（DoubleSide なので面の向きは問題にならない）
    inner.scale.set(p.mirror ? -s : s, s, s);
    // Z-up → Y-up: (x,y,z) → (x,z,-y)
    inner.rotation.set(p.upAxis === 'z' ? -Math.PI / 2 : 0, 0, 0);
    object.add(inner);
    object.updateMatrixWorld(true);
    // 水平の中心を原点に、底面を y=0 に
    const box = new THREE.Box3().setFromObject(inner, true);
    if (box.isEmpty()) box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
    const c = box.getCenter(new THREE.Vector3());
    object.position.set(-c.x, -box.min.y, -c.z);
    object.updateMatrixWorld(true);
    this.localBox.copy(box).translate(object.position);
    this.localBox.getSize(this.size);
    this.object = object;
    this.pivot.add(object);
  }

  /** 向き・位置・高さだけが変わったとき */
  applyTransform(): void {
    const p = this.placement;
    this.pivot.position.set(p.offsetE, p.baseY, -p.offsetN);
    this.pivot.rotation.set(0, (-p.headingDeg * Math.PI) / 180, 0);
    this.pivot.updateMatrixWorld(true);
  }

  /** 寸法 (m): w=東西（回転前）, d=南北（回転前）, h=高さ */
  dimensions(): { w: number; d: number; h: number } {
    return { w: this.size.x, d: this.size.z, h: this.size.y };
  }

  /** 足跡（ワールド XZ の四隅。回転・位置を適用済み）。南西→南東→北東→北西（上から見て反時計回り） */
  footprintWorld(): THREE.Vector2[] {
    this.pivot.updateMatrixWorld(true);
    const b = this.localBox;
    const corners = [
      [b.min.x, b.max.z],
      [b.max.x, b.max.z],
      [b.max.x, b.min.z],
      [b.min.x, b.min.z],
    ];
    return corners.map(([x, z]) => {
      const v = new THREE.Vector3(x, 0, z).applyMatrix4(this.pivot.matrixWorld);
      return new THREE.Vector2(v.x, v.z);
    });
  }

  /** 足跡（ピンからの東・北 m） */
  footprintEN(): { e: number; n: number }[] {
    return this.footprintWorld().map((v) => ({ e: v.x, n: -v.y }));
  }

  /** ワールド bbox（配置後） */
  worldBox(): THREE.Box3 {
    this.pivot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.pivot, true);
    if (box.isEmpty()) box.setFromCenterAndSize(this.pivot.getWorldPosition(new THREE.Vector3()), new THREE.Vector3());
    return box;
  }

  private clearObject() {
    if (!this.object) return;
    this.pivot.remove(this.object);
    // 作ったマテリアルだけ破棄（ジオメトリは model.raw のもの）
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mt of Array.isArray(m.material) ? m.material : [m.material]) mt?.dispose();
    });
    this.object = null;
  }

  dispose(): void {
    this.clearObject();
    this.pivot.removeFromParent();
  }
}

// ---------------------------------------------------------------------------
// サンプル
// ---------------------------------------------------------------------------

/** base64 テキスト → ArrayBuffer */
export function base64ToArrayBuffer(text: string): ArrayBuffer {
  const bin = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * 同梱のサンプル（public/samples）を読み込む。
 * バイナリを配信しない公開先では `url + '.txt'`（base64 の写し。vite.config.ts が build 時に作る）から読む。
 */
export async function loadSampleModel(path: string): Promise<ImportedModel> {
  const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
  const url = new URL(path, base).toString();
  const name = decodeURIComponent(path.split(/[?#]/)[0].split('/').pop() || path);
  const format = detectFormat(name);
  let data: ArrayBuffer | null = null;
  try {
    const res = await fetch(url);
    const ct = res.headers.get('content-type') || '';
    if (res.ok && !/text\/html|text\/plain|application\/json/i.test(ct)) {
      const buf = await res.arrayBuffer();
      // 中身も確認（3DS は先頭 4D4D）。HTML のエラーページなどが返る公開先への備え
      if (buf.byteLength > 0 && (format !== '3ds' || is3dsBuffer(buf))) data = buf;
    }
  } catch {
    data = null;
  }
  if (!data) {
    const res = await fetch(url + '.txt');
    if (!res.ok) throw new Error(`サンプルを取得できませんでした（${res.status}）: ${path}`);
    data = base64ToArrayBuffer(await res.text());
  }
  return importModelFile({ name, data });
}
