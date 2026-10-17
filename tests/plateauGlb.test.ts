/**
 * PLATEAU 葉タイルの glb 復号（glb.ts）と Draco デコーダの差し替え・準備（draco.ts）。
 * Node では tests/helpers/nodeDraco.ts（three の draco_wasm_wrapper.js を評価）を注入して実タイル fixture を復号する。
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseB3dm } from '../src/sun/plateau/b3dm';
import { ensureDracoReady, getDracoDecoder, setDracoDecoderFactory } from '../src/sun/plateau/draco';
import { decodeTileGlb } from '../src/sun/plateau/glb';
import type { DracoDecoderLike } from '../src/sun/plateau/types';
import { nodeDracoDecoder } from './helpers/nodeDraco';

/** fixture を独立した ArrayBuffer として読む（Buffer はプールを共有するので slice する） */
const fixture = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`./fixtures/plateau/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

/** glb の JSON チャンク（accessor の componentType を見るため） */
const glbJson = (glb: ArrayBuffer): { accessors: { componentType: number }[]; meshes: { primitives: { attributes: Record<string, number> }[] }[] } => {
  const dv = new DataView(glb);
  const len = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, len)));
};

const distinct = (a: Uint32Array) => Array.from(new Set(a)).sort((x, y) => x - y);

/** 幾何法線が下向きの三角形を数える（接地面。LOD1 の箱なら 2 枚 × 棟数） */
const countDownFacing = (positions: Float32Array, index: Uint32Array) => {
  let down = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < index.length; i += 3) {
    a.fromArray(positions, index[i] * 3);
    b.fromArray(positions, index[i + 1] * 3);
    c.fromArray(positions, index[i + 2] * 3);
    b.sub(a);
    c.sub(a);
    if (b.cross(c).normalize().y < -0.7) down++;
  }
  return down;
};

let draco: DracoDecoderLike;
beforeAll(async () => {
  draco = await nodeDracoDecoder();
});

describe('decodeTileGlb（nodeDraco で実タイルを復号）', () => {
  it('23113 data0（守山区 LOD1・6 棟）: 頂点 312・index 312・batchId 0..5・CESIUM_RTC の center・警告 0 件', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const b3dm = parseB3dm(fixture('23113_lod1_data0.b3dm'));
      const t0 = performance.now();
      const tile = await decodeTileGlb(b3dm.glb, draco);
      const ms = performance.now() - t0;
      expect(tile.positions).toBeInstanceOf(Float32Array);
      expect(tile.positions.length).toBe(312 * 3);
      expect(tile.index).toBeInstanceOf(Uint32Array);
      expect(tile.index.length).toBe(312);
      expect(tile.batchId).toBeInstanceOf(Uint32Array);
      expect(tile.batchId.length).toBe(312);
      expect(distinct(tile.batchId)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(b3dm.batchLength).toBe(6);
      expect(tile.rtcCenter[0]).toBeCloseTo(-3816770.27, 2);
      expect(tile.rtcCenter[1]).toBeCloseTo(3552627.62, 2);
      expect(tile.rtcCenter[2]).toBeCloseTo(3661195.42, 2);
      // 頂点は RTC 相対（タイル内なので数百 m 以内）、index は頂点数の範囲内
      for (let i = 0; i < tile.positions.length; i++) expect(Math.abs(tile.positions[i])).toBeLessThan(2000);
      for (let i = 0; i < tile.index.length; i++) expect(tile.index[i]).toBeLessThan(312);
      // 頂点共有ゼロ（faces×3/verts = 1.00、§0 実測）: 104 三角形 × 3 = 312 頂点。底面（下向き）は 1 棟 2 枚以上
      expect(tile.index.length / 3).toBe(tile.positions.length / 9);
      expect(new Set(tile.index).size).toBe(312);
      const down = countDownFacing(tile.positions, tile.index);
      expect(down).toBeGreaterThanOrEqual(12);
      expect(down).toBeLessThan(tile.index.length / 6);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(ms).toBeLessThan(5000);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('23102 data1 / data55（東区の内部ノード）も復号でき、_BATCHID は UNSIGNED_BYTE', async () => {
    for (const [name, batches] of [
      ['23102_lod2nt_data1.b3dm', 18],
      ['23102_lod2nt_data55.b3dm', 20],
    ] as const) {
      const b3dm = parseB3dm(fixture(name));
      const json = glbJson(b3dm.glb);
      const prim = json.meshes[0].primitives[0];
      expect(json.accessors[prim.attributes._BATCHID].componentType).toBe(5121); // UNSIGNED_BYTE
      const tile = await decodeTileGlb(b3dm.glb, draco);
      expect(b3dm.batchLength).toBe(batches);
      expect(tile.positions.length / 3).toBeGreaterThan(batches * 8);
      expect(tile.batchId.length).toBe(tile.positions.length / 3);
      expect(tile.index.length % 3).toBe(0);
      const ids = distinct(tile.batchId);
      expect(ids[0]).toBe(0);
      expect(ids[ids.length - 1]).toBe(batches - 1);
      expect(ids.length).toBe(batches);
      expect(tile.rtcCenter.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it('_batchid が Uint16Array や InterleavedBufferAttribute でも Uint32Array に平坦化される', async () => {
    const b3dm = parseB3dm(fixture('23113_lod1_data0.b3dm'));
    const base = await decodeTileGlb(b3dm.glb, draco);
    // 復号結果の _batchid を別の型に差し替えて返すデコーダで包む
    const wrap = (convert: (bid: THREE.BufferAttribute) => THREE.BufferAttribute | THREE.InterleavedBufferAttribute): DracoDecoderLike => ({
      preload: () => draco.preload(),
      decodeDracoFile: (buffer, onLoad, ids, types, cs, onError) =>
        draco.decodeDracoFile(
          buffer,
          (geo) => {
            const bid = geo.getAttribute('_batchid') as THREE.BufferAttribute;
            geo.setAttribute('_batchid', convert(bid));
            onLoad(geo);
          },
          ids,
          types,
          cs,
          onError,
        ),
    });
    const asUint16 = wrap((bid) => new THREE.BufferAttribute(Uint16Array.from(bid.array as Uint8Array), 1));
    const t16 = await decodeTileGlb(b3dm.glb, asUint16);
    expect(t16.batchId).toBeInstanceOf(Uint32Array);
    expect(Array.from(t16.batchId)).toEqual(Array.from(base.batchId));
    // ブラウザの DRACOLoader と同じ 4 B 境界の Interleaved（stride 4・offset 0）
    const asInterleaved = wrap((bid) => {
      const src = bid.array as Uint8Array;
      const buf = new Uint8Array(src.length * 4);
      for (let i = 0; i < src.length; i++) buf[i * 4] = src[i];
      return new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(buf, 4), 1, 0);
    });
    const tI = await decodeTileGlb(b3dm.glb, asInterleaved);
    expect(Array.from(tI.batchId)).toEqual(Array.from(base.batchId));
  });

  it('CESIUM_RTC の center が無い glb は Error', async () => {
    const b3dm = parseB3dm(fixture('23113_lod1_data0.b3dm'));
    // JSON チャンクの "CESIUM_RTC" を同じ長さの別名に書き換える（長さが変わらないのでヘッダはそのまま）
    const bytes = new Uint8Array(b3dm.glb.slice(0));
    const text = new TextDecoder().decode(bytes);
    const marker = '"CESIUM_RTC":{"center"';
    const at = text.indexOf(marker);
    expect(at).toBeGreaterThan(0);
    bytes.set(new TextEncoder().encode('"CESIUM_XXX":{"center"'), at);
    await expect(decodeTileGlb(bytes.buffer, draco)).rejects.toThrow(/CESIUM_RTC/);
  });

  it('複数 Mesh（node 行列あり）は matrixWorld を適用して連結し index をずらす。_batchid 無しは全頂点 0・index 無しは 0..n−1', async () => {
    // 2 つの Mesh を持つ小さな glb を GLTFExporter 無しで手組みする（Draco 無し・index 無し・_BATCHID 無し）。
    // 実タイルで属性を外す模擬はできない（glTF 側に bufferView 無しの accessor が残り GLTFLoader が 0 で埋める）ので手組みで見る
    const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const bin = new Uint8Array(tri.buffer.slice(0));
    const json = {
      asset: { version: '2.0' },
      extensionsUsed: ['CESIUM_RTC'],
      extensions: { CESIUM_RTC: { center: [1, 2, 3] } },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ mesh: 0 }, { mesh: 0, translation: [10, 0, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }],
      buffers: [{ byteLength: bin.byteLength }],
    };
    let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    while (jsonBytes.length % 4) jsonBytes = new Uint8Array([...jsonBytes, 0x20]);
    const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
    const glb = new Uint8Array(total);
    const dv = new DataView(glb.buffer);
    dv.setUint32(0, 0x46546c67, true); // 'glTF'
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBytes.length, true);
    dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
    glb.set(jsonBytes, 20);
    dv.setUint32(20 + jsonBytes.length, bin.length, true);
    dv.setUint32(24 + jsonBytes.length, 0x004e4942, true); // 'BIN\0'
    glb.set(bin, 28 + jsonBytes.length);
    const tile = await decodeTileGlb(glb.buffer, draco);
    expect(tile.rtcCenter).toEqual([1, 2, 3]);
    expect(tile.positions.length).toBe(6 * 3);
    expect(Array.from(tile.positions.slice(0, 9))).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(tile.positions.slice(9))).toEqual([10, 0, 0, 11, 0, 0, 10, 1, 0]);
    expect(Array.from(tile.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Array.from(tile.batchId)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('draco.ts（デコーダの差し替え・準備）', () => {
  afterEach(() => setDracoDecoderFactory(null));

  it('setDracoDecoderFactory で注入したデコーダが返り（モジュール単位 1 個）、null で既定の DRACOLoader に戻る', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const mine = await nodeDracoDecoder();
      const factory = vi.fn(() => mine);
      setDracoDecoderFactory(factory);
      expect(getDracoDecoder()).toBe(mine);
      expect(getDracoDecoder()).toBe(mine);
      expect(factory).toHaveBeenCalledTimes(1);
      await expect(ensureDracoReady()).resolves.toBeUndefined();
      // 既定に戻す: three の DRACOLoader（Node ではデコーダのファイルを取れないので preload は失敗するが、未処理の拒否にはならない）
      setDracoDecoderFactory(null);
      const d = getDracoDecoder();
      expect(d).toBeInstanceOf(DRACOLoader);
      expect(getDracoDecoder()).toBe(d);
      expect(d).not.toBe(mine);
      await expect(ensureDracoReady()).rejects.toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('ensureDracoReady: wasm の preload が失敗したら setDecoderConfig({ type: "js" }) で作り直してもう一度（js で成功）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const made: { config: unknown; preloads: number }[] = [];
      const factory = vi.fn((): DracoDecoderLike => {
        const rec = { config: null as unknown, preloads: 0 };
        made.push(rec);
        const d = {
          setDecoderConfig(c: unknown) {
            rec.config = c;
            return d;
          },
          preload() {
            rec.preloads++;
            return rec.config === null ? Promise.reject(new Error('wasm を取得できません')) : Promise.resolve();
          },
          decodeDracoFile: () => undefined,
        };
        return d;
      });
      setDracoDecoderFactory(factory);
      await expect(ensureDracoReady()).resolves.toBeUndefined();
      expect(factory).toHaveBeenCalledTimes(2);
      expect(made[0].config).toBeNull();
      expect(made[1].config).toEqual({ type: 'js' });
      expect(made[1].preloads).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalledTimes(1);
      // 以後の getDracoDecoder は js 版を返し、ensureDracoReady は作り直さない
      const d = getDracoDecoder();
      await ensureDracoReady();
      expect(getDracoDecoder()).toBe(d);
      expect(factory).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('ensureDracoReady: js でも失敗したら reject し、次の呼び出しでもう一度やり直せる', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let fail = true;
      const factory = vi.fn(
        (): DracoDecoderLike =>
          ({
            setDecoderConfig: () => undefined,
            preload: () => (fail ? Promise.reject(new Error('だめ')) : Promise.resolve()),
            decodeDracoFile: () => undefined,
          }) as DracoDecoderLike,
      );
      setDracoDecoderFactory(factory);
      await expect(ensureDracoReady()).rejects.toThrow('だめ');
      expect(factory).toHaveBeenCalledTimes(2);
      fail = false;
      // 失敗は記憶しない（通信状況が変われば次回は通る）。失敗したデコーダは捨て、wasm からやり直す
      await expect(ensureDracoReady()).resolves.toBeUndefined();
      expect(factory).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });
});
