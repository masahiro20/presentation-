/**
 * NeighborMesh の保存形（Int16 cm × 9 × 三角形数 を base64）との相互変換。
 * 実測の見積り: LOD1 箱 12 三角形 → 216 B → base64 288 B、世田谷平均 20 三角形 → 480 B。
 *
 * バイト列はリトルエンディアンの Int16（DataView で書く。プラットフォームの並びに依らず同じ文字列になる）。
 * base64 は btoa / atob（ブラウザ・Node 16 以降の両方にある）。壊れた保存データは Error（呼び出し側は mesh 無し = 押し出しで描く）。
 * 仕様: scratchpad/plateau-spec.md §2.10（W7 が実装）
 */
import type { NeighborMesh, QuantizedMesh } from './types';

/** 1 m = 100（cm） */
const Q = 100;
/** Int16 の範囲 → ±327.67 m */
const LIMIT = 32767;
/** 1 三角形 = 9 値 × 2 B */
const BYTES_PER_TRIANGLE = 18;

function toBase64(u8: Uint8Array): string {
  let s = '';
  // String.fromCharCode の引数上限を避けて分割
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

/** Int16 cm。|座標| > 327 m の頂点があれば throw（anchor は建物内なので起きない） */
export function quantizeMesh(m: NeighborMesh): QuantizedMesh {
  const n = m.tris.length;
  if (n % 9 !== 0) throw new Error(`NeighborMesh の tris の長さが 9 の倍数ではありません（${n}）`);
  const bytes = new Uint8Array(n * 2);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) {
    const v = Math.round(m.tris[i] * Q);
    if (!Number.isFinite(v) || Math.abs(v) > LIMIT) throw new Error(`座標が Int16 cm の範囲（±327.67 m）を超えています: ${m.tris[i]} m`);
    dv.setInt16(i * 2, v, true);
  }
  const triangles = n / 9;
  return { v: 1, q: Q, posB64: toBase64(bytes), roofTriangles: Math.max(0, Math.min(triangles, Math.floor(m.roofTriangles))) };
}

/** 誤差 ≤ 0.5 cm。形が違う・base64 が壊れている・長さが 18 B の倍数でないときは Error */
export function dequantizeMesh(q: QuantizedMesh): NeighborMesh {
  if (!q || q.v !== 1 || q.q !== Q || typeof q.posB64 !== 'string') throw new Error('meshQ の形が不正です');
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(q.posB64);
  } catch (e) {
    throw new Error(`meshQ の base64 を読めません（${e instanceof Error ? e.message : String(e)}）`);
  }
  if (bytes.length % BYTES_PER_TRIANGLE !== 0) throw new Error(`meshQ の長さが三角形の倍数ではありません（${bytes.length} B）`);
  const n = bytes.length / 2;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tris = new Float32Array(n);
  for (let i = 0; i < n; i++) tris[i] = dv.getInt16(i * 2, true) / Q;
  const triangles = n / 9;
  const roof = Number.isFinite(q.roofTriangles) ? Math.floor(q.roofTriangles) : 0;
  return { tris, roofTriangles: Math.max(0, Math.min(triangles, roof)) };
}

/** 保存サイズの見積り（バイト）= JSON にしたときの長さ（全部 ASCII なので文字数 = バイト数） */
export function quantizedBytes(q: QuantizedMesh): number {
  return JSON.stringify(q).length;
}
