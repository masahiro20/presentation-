/**
 * b3dm 内の glb を GLTFLoader + Draco で復号し、タイル 1 枚の頂点・index・batchId・RTC center にする。
 *
 * new GLTFLoader().setDRACOLoader(draco).register(() => ({ name: 'CESIUM_RTC' }))（「Unknown extension」の警告抑止）→ parseAsync(glb, '')。
 * register すると userData.gltfExtensions から CESIUM_RTC は消えるが parser.json には残るので、center は
 * gltf.parser.json.extensions?.CESIUM_RTC?.center から読む（無ければ Error）。
 * 全 Mesh を走査し matrixWorld を頂点に適用して連結（実データは単位行列・1 mesh・1 primitive）。
 * _batchid は getX(i) で Uint32Array に（ブラウザの DRACOLoader は 1 成分 Uint8 を InterleavedBufferAttribute にするが getX は両対応）、無ければ全頂点 0。
 * index が無ければ 0..n−1 を生成。頂点は glTF の y-up・RTC 相対のまま（ECEF への回転 gltfToEcefAxes と測地変換は buildings.ts）。
 * 仕様: scratchpad/plateau-spec.md §2.5（W4 が実装）
 */
import * as THREE from 'three';
import type { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { DecodedTile, DracoDecoderLike } from './types';

/** parser.json のうち読む部分 */
interface GltfJsonWithRtc {
  extensions?: { CESIUM_RTC?: { center?: unknown } };
}

/** CESIUM_RTC の center を検証して返す（3 要素の有限数） */
function readRtcCenter(json: unknown): [number, number, number] {
  const center = (json as GltfJsonWithRtc | null | undefined)?.extensions?.CESIUM_RTC?.center;
  if (!Array.isArray(center) || center.length !== 3 || !center.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error('PLATEAU タイルに CESIUM_RTC の center がありません');
  }
  return [center[0], center[1], center[2]];
}

/** 1 つの Mesh の頂点・index・batchId（matrixWorld 適用済み） */
interface MeshPart {
  positions: Float32Array;
  index: Uint32Array;
  batchId: Uint32Array;
}

function readMesh(mesh: THREE.Mesh): MeshPart | null {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  if (!pos || pos.count === 0) return null;
  const n = pos.count;
  const positions = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  const m = mesh.matrixWorld;
  const identity = isIdentity(m);
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    if (!identity) v.applyMatrix4(m);
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
  }
  const bid = geo.getAttribute('_batchid');
  const batchId = new Uint32Array(n);
  if (bid) for (let i = 0; i < n; i++) batchId[i] = bid.getX(i);
  let index: Uint32Array;
  if (geo.index) {
    const src = geo.index;
    index = new Uint32Array(src.count);
    for (let i = 0; i < src.count; i++) index[i] = src.getX(i);
  } else {
    index = new Uint32Array(n);
    for (let i = 0; i < n; i++) index[i] = i;
  }
  return { positions, index, batchId };
}

function isIdentity(m: THREE.Matrix4): boolean {
  const e = m.elements;
  for (let i = 0; i < 16; i++) {
    const want = i % 5 === 0 ? 1 : 0;
    if (e[i] !== want) return false;
  }
  return true;
}

/** glb（b3dm から切り出した独立の ArrayBuffer）を復号してタイル 1 枚の DecodedTile にする */
export async function decodeTileGlb(glb: ArrayBuffer, draco: DracoDecoderLike): Promise<DecodedTile> {
  const loader = new GLTFLoader();
  // DracoDecoderLike は DRACOLoader の decodeDracoFile/preload だけを持つ（Node 用の注入デコーダも同じ形）
  loader.setDRACOLoader(draco as unknown as DRACOLoader);
  loader.register(() => ({ name: 'CESIUM_RTC' }));
  const gltf = await loader.parseAsync(glb, '');
  const rtcCenter = readRtcCenter(gltf.parser.json);

  gltf.scene.updateMatrixWorld(true);
  const parts: MeshPart[] = [];
  gltf.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      const part = readMesh(o as THREE.Mesh);
      if (part) parts.push(part);
    }
  });
  if (parts.length === 0) throw new Error('PLATEAU タイルの glb に Mesh がありません');

  // 単一 mesh（実データ）はコピーせずそのまま。複数なら頂点を連結し index を頂点のずれ分だけ足す
  if (parts.length === 1) return { ...parts[0], rtcCenter };
  const nVerts = parts.reduce((s, p) => s + p.positions.length / 3, 0);
  const nIndex = parts.reduce((s, p) => s + p.index.length, 0);
  const positions = new Float32Array(nVerts * 3);
  const batchId = new Uint32Array(nVerts);
  const index = new Uint32Array(nIndex);
  let vOff = 0;
  let iOff = 0;
  for (const p of parts) {
    positions.set(p.positions, vOff * 3);
    batchId.set(p.batchId, vOff);
    for (let i = 0; i < p.index.length; i++) index[iOff + i] = p.index[i] + vOff;
    vOff += p.positions.length / 3;
    iOff += p.index.length;
  }
  // 復号済みの BufferGeometry は使い終わり（GPU には上げていないので dispose は不要だが参照を残さない）
  return { positions, index, batchId, rtcCenter };
}
