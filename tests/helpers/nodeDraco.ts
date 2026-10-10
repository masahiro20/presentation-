/**
 * テスト用: Node で動く Draco デコーダ（three の DRACOLoader と同じ形 DracoDecoderLike）。
 *
 * node_modules/three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js を
 * new Function('require', '__dirname', '__filename', src + '\nreturn DracoDecoderModule;') で評価し { wasmBinary, onModuleLoaded } で初期化する。
 *   - wrapper は `typeof process.versions.node` で Node と判定し `require('fs')` を呼ぶので、createRequire の本物の require を渡す（undefined だと落ちる）。
 *   - wasm は wasmBinary で渡すので wrapper 側のファイル読み込みは走らない（__dirname/__filename は念のため）。
 * decodeDracoFile は DRACOLoader の Worker 内 decodeGeometry と同じ手順で attributeIDs（glTF の unique ID）/attributeTypes（'Float32Array' 等の型名）に従って
 * BufferAttribute を作る。ブラウザの DRACOLoader は 1 成分 Uint8 を 4 B 境界の InterleavedBufferAttribute にするが、ここでは普通の BufferAttribute
 * （_BATCHID: UNSIGNED_BYTE → Uint8Array、UNSIGNED_SHORT → Uint16Array）。読む側（glb.ts）は getX(i) で両方を同じに扱う。
 * GLTFLoader.parseAsync と組み合わせて 35 ms で動作確認済み。依存は増やさない（draco3dgltf は使わない）。
 * 仕様: scratchpad/plateau-spec.md §2.13（W4 が実装）
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as THREE from 'three';
import type { DracoDecoderLike } from '../../src/sun/plateau/types';

/** attributeTypes の型名 → TypedArray コンストラクタ（Worker では self[name] で解く。Node では globalThis にある） */
type TypedArrayCtor = Float32ArrayConstructor | Int8ArrayConstructor | Int16ArrayConstructor | Int32ArrayConstructor | Uint8ArrayConstructor | Uint16ArrayConstructor | Uint32ArrayConstructor;
const TYPED_ARRAYS: Record<string, TypedArrayCtor> = { Float32Array, Int8Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array };

/** Emscripten の Draco モジュールのうち使う部分（wrapper は型定義を持たないので最小限を書く） */
interface DracoModule {
  Decoder: new () => DracoDecoder;
  Mesh: new () => DracoGeometry;
  PointCloud: new () => DracoGeometry;
  TRIANGULAR_MESH: number;
  POINT_CLOUD: number;
  DT_FLOAT32: number;
  DT_INT8: number;
  DT_INT16: number;
  DT_INT32: number;
  DT_UINT8: number;
  DT_UINT16: number;
  DT_UINT32: number;
  HEAPF32: Float32Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  destroy(obj: object): void;
}
interface DracoGeometry {
  ptr: number;
  num_points(): number;
  num_faces(): number;
}
interface DracoAttribute {
  num_components(): number;
}
interface DracoStatus {
  ok(): boolean;
  error_msg(): string;
}
interface DracoDecoder {
  GetEncodedGeometryType(array: Int8Array): number;
  DecodeArrayToMesh(array: Int8Array, byteLength: number, out: DracoGeometry): DracoStatus;
  DecodeArrayToPointCloud(array: Int8Array, byteLength: number, out: DracoGeometry): DracoStatus;
  GetAttributeByUniqueId(geom: DracoGeometry, id: number): DracoAttribute;
  GetAttributeDataArrayForAllPoints(geom: DracoGeometry, attr: DracoAttribute, dataType: number, byteLength: number, ptr: number): boolean;
  GetTrianglesUInt32Array(geom: DracoGeometry, byteLength: number, ptr: number): boolean;
}
type DracoDecoderModuleFn = (config: { wasmBinary: Uint8Array; onModuleLoaded: (m: DracoModule) => void }) => unknown;

/** wasm モジュールはプロセスで 1 回だけ初期化する（22 ms/9300 頂点の復号に対し初期化は数 ms だが、テストファイルごとに作り直す必要はない） */
let modulePending: Promise<DracoModule> | null = null;

function loadDracoModule(): Promise<DracoModule> {
  if (modulePending) return modulePending;
  modulePending = new Promise<DracoModule>((resolve, reject) => {
    try {
      const require = createRequire(import.meta.url);
      const wrapperPath = require.resolve('three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js');
      const wasmPath = path.join(path.dirname(wrapperPath), 'draco_decoder.wasm');
      const src = readFileSync(wrapperPath, 'utf8');
      const factory = new Function('require', '__dirname', '__filename', src + '\nreturn DracoDecoderModule;')(
        require,
        path.dirname(wrapperPath),
        wrapperPath,
      ) as DracoDecoderModuleFn;
      factory({ wasmBinary: readFileSync(wasmPath), onModuleLoaded: resolve });
    } catch (e) {
      reject(e);
    }
  });
  return modulePending;
}

function dracoDataType(draco: DracoModule, ctor: TypedArrayCtor): number {
  switch (ctor) {
    case Float32Array:
      return draco.DT_FLOAT32;
    case Int8Array:
      return draco.DT_INT8;
    case Int16Array:
      return draco.DT_INT16;
    case Int32Array:
      return draco.DT_INT32;
    case Uint8Array:
      return draco.DT_UINT8;
    case Uint16Array:
      return draco.DT_UINT16;
    default:
      return draco.DT_UINT32;
  }
}

/** DRACOLoader の Worker 内 decodeGeometry と同じ手順（unique ID 指定・インデックスは UInt32） */
function decodeGeometry(draco: DracoModule, buffer: ArrayBuffer, attributeIDs: Record<string, number>, attributeTypes: Record<string, string>): THREE.BufferGeometry {
  const decoder = new draco.Decoder();
  const array = new Int8Array(buffer);
  let dracoGeometry: DracoGeometry | null = null;
  try {
    const geometryType = decoder.GetEncodedGeometryType(array);
    let status: DracoStatus;
    if (geometryType === draco.TRIANGULAR_MESH) {
      dracoGeometry = new draco.Mesh();
      status = decoder.DecodeArrayToMesh(array, array.byteLength, dracoGeometry);
    } else if (geometryType === draco.POINT_CLOUD) {
      dracoGeometry = new draco.PointCloud();
      status = decoder.DecodeArrayToPointCloud(array, array.byteLength, dracoGeometry);
    } else {
      throw new Error('nodeDraco: Draco の幾何タイプが不明です');
    }
    if (!status.ok() || dracoGeometry.ptr === 0) throw new Error(`nodeDraco: Draco の復号に失敗: ${status.error_msg()}`);

    const geometry = new THREE.BufferGeometry();
    const count = dracoGeometry.num_points();
    for (const name of Object.keys(attributeIDs)) {
      const ctor = TYPED_ARRAYS[attributeTypes[name]] ?? Float32Array;
      const attribute = decoder.GetAttributeByUniqueId(dracoGeometry, attributeIDs[name]);
      const itemSize = attribute.num_components();
      const byteLength = count * itemSize * ctor.BYTES_PER_ELEMENT;
      const ptr = draco._malloc(byteLength);
      try {
        decoder.GetAttributeDataArrayForAllPoints(dracoGeometry, attribute, dracoDataType(draco, ctor), byteLength, ptr);
        // wasm のヒープから複製してから解放する（ヒープは成長で差し替わるので参照を残さない）
        const values = new ctor(draco.HEAPF32.buffer as ArrayBuffer, ptr, count * itemSize).slice();
        geometry.setAttribute(name, new THREE.BufferAttribute(values, itemSize));
      } finally {
        draco._free(ptr);
      }
    }
    if (geometryType === draco.TRIANGULAR_MESH) {
      const numIndices = dracoGeometry.num_faces() * 3;
      const ptr = draco._malloc(numIndices * 4);
      try {
        decoder.GetTrianglesUInt32Array(dracoGeometry, numIndices * 4, ptr);
        geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(draco.HEAPF32.buffer as ArrayBuffer, ptr, numIndices).slice(), 1));
      } finally {
        draco._free(ptr);
      }
    }
    return geometry;
  } finally {
    if (dracoGeometry) draco.destroy(dracoGeometry);
    draco.destroy(decoder);
  }
}

/** Node で動く DracoDecoderLike を作る（GLTFLoader.setDRACOLoader に渡せる。decodeTileGlb(glb, await nodeDracoDecoder()) で使う） */
export async function nodeDracoDecoder(): Promise<DracoDecoderLike> {
  const draco = await loadDracoModule();
  const ready = Promise.resolve();
  return {
    /** 初期化は済んでいる（ensureDracoReady が await できるよう解決済みの Promise を返す） */
    preload: () => ready,
    decodeDracoFile(buffer: ArrayBuffer, onLoad: (geometry: THREE.BufferGeometry) => void, attributeIDs: Record<string, number>, attributeTypes: Record<string, string>, _vertexColorSpace?: unknown, onError?: (e: unknown) => void) {
      // DRACOLoader と同じく非同期に返す（呼び出し側が Promise 化しているので、同期に onLoad を呼んでも構わないが揃える）
      return ready
        .then(() => decodeGeometry(draco, buffer, attributeIDs, attributeTypes))
        .then(onLoad, (e: unknown) => {
          if (onError) onError(e);
          else throw e;
        });
    },
  };
}
