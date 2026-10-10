/**
 * NeighborMesh の保存形（src/sun/plateau/meshCodec.ts）: quantize → dequantize の往復誤差 ≤ 0.5 cm、roofTriangles 保持、
 * 範囲外は throw、壊れた保存データは throw、サイズの見積り。
 */
import { describe, expect, it } from 'vitest';
import { dequantizeMesh, quantizeMesh, quantizedBytes } from '../src/sun/plateau/meshCodec';
import type { NeighborMesh, QuantizedMesh } from '../src/sun/plateau/types';

/** 12 三角形の箱（屋根 2・底 2・壁 8）に小数を混ぜたもの */
function box(w = 7.123, d = 5.456, h = 6.789): NeighborMesh {
  const x0 = -w / 2;
  const x1 = w / 2;
  const z0 = -d / 2;
  const z1 = d / 2;
  const quad = (a: number[], b: number[], c: number[], e: number[]) => [...a, ...b, ...c, ...a, ...c, ...e];
  const tris = [
    // 屋根（上向き）
    ...quad([x0, h, z1], [x1, h, z1], [x1, h, z0], [x0, h, z0]),
    // 底（下向き）
    ...quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]),
    // 壁
    ...quad([x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1]),
    ...quad([x1, 0, z1], [x1, 0, z0], [x1, h, z0], [x1, h, z1]),
    ...quad([x1, 0, z0], [x0, 0, z0], [x0, h, z0], [x1, h, z0]),
    ...quad([x0, 0, z0], [x0, 0, z1], [x0, h, z1], [x0, h, z0]),
  ];
  return { tris: new Float32Array(tris), roofTriangles: 2 };
}

describe('quantizeMesh / dequantizeMesh', () => {
  it('往復の誤差 ≤ 0.005 m、roofTriangles と三角形数を保つ。v 1・q 100', () => {
    const m = box();
    const q = quantizeMesh(m);
    expect(q.v).toBe(1);
    expect(q.q).toBe(100);
    expect(q.roofTriangles).toBe(2);
    const back = dequantizeMesh(q);
    expect(back.roofTriangles).toBe(2);
    expect(back.tris.length).toBe(m.tris.length);
    let maxErr = 0;
    for (let i = 0; i < m.tris.length; i++) maxErr = Math.max(maxErr, Math.abs(back.tris[i] - m.tris[i]));
    expect(maxErr).toBeLessThanOrEqual(0.005);
    // 12 三角形 = 216 B → base64 288 文字
    expect(q.posB64).toHaveLength(288);
  });

  it('負の座標・大きめの座標（±300 m）・ゼロも往復する。同じ入力は同じ文字列', () => {
    const tris = new Float32Array([-300.004, 0, 299.996, 0.004, -0.006, 123.455, 1e-5, 2.5, -2.5]);
    const q = quantizeMesh({ tris, roofTriangles: 1 });
    expect(q.posB64).toBe(quantizeMesh({ tris: new Float32Array(tris), roofTriangles: 1 }).posB64);
    const back = dequantizeMesh(q);
    for (let i = 0; i < tris.length; i++) expect(Math.abs(back.tris[i] - tris[i])).toBeLessThanOrEqual(0.005);
    expect(back.tris[0]).toBe(-300);
    expect(back.tris[2]).toBe(300);
  });

  it('|座標| > 327.67 m の頂点があれば throw、tris の長さが 9 の倍数でなければ throw', () => {
    expect(() => quantizeMesh({ tris: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 400]), roofTriangles: 0 })).toThrow(/327/);
    expect(() => quantizeMesh({ tris: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, -327.68]), roofTriangles: 0 })).toThrow(/327/);
    expect(() => quantizeMesh({ tris: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, NaN]), roofTriangles: 0 })).toThrow();
    expect(() => quantizeMesh({ tris: new Float32Array(8), roofTriangles: 0 })).toThrow(/9 の倍数/);
  });

  it('roofTriangles は 0..三角形数 に収める（負・超過・小数）', () => {
    const m = box();
    expect(quantizeMesh({ ...m, roofTriangles: 99 }).roofTriangles).toBe(12);
    expect(quantizeMesh({ ...m, roofTriangles: -1 }).roofTriangles).toBe(0);
    expect(quantizeMesh({ ...m, roofTriangles: 2.7 }).roofTriangles).toBe(2);
    expect(dequantizeMesh({ ...quantizeMesh(m), roofTriangles: 50 }).roofTriangles).toBe(12);
    expect(dequantizeMesh({ ...quantizeMesh(m), roofTriangles: NaN }).roofTriangles).toBe(0);
  });

  it('空のメッシュも往復する', () => {
    const q = quantizeMesh({ tris: new Float32Array(0), roofTriangles: 0 });
    expect(q.posB64).toBe('');
    const back = dequantizeMesh(q);
    expect(back.tris.length).toBe(0);
    expect(back.roofTriangles).toBe(0);
  });

  it('壊れた保存データ（形・base64・長さ）は throw', () => {
    const ok = quantizeMesh(box());
    expect(() => dequantizeMesh({ ...ok, v: 2 } as unknown as QuantizedMesh)).toThrow(/形/);
    expect(() => dequantizeMesh({ ...ok, q: 10 } as unknown as QuantizedMesh)).toThrow(/形/);
    expect(() => dequantizeMesh({ ...ok, posB64: 123 } as unknown as QuantizedMesh)).toThrow(/形/);
    expect(() => dequantizeMesh(null as unknown as QuantizedMesh)).toThrow();
    expect(() => dequantizeMesh({ ...ok, posB64: '***' })).toThrow(/base64/);
    // 18 B の倍数でない（1 三角形 = 9 × Int16）
    expect(() => dequantizeMesh({ ...ok, posB64: btoa('abcd') })).toThrow(/倍数/);
  });
});

describe('quantizedBytes', () => {
  it('JSON にしたときのバイト数（全部 ASCII）。12 三角形で 330 B 前後', () => {
    const q = quantizeMesh(box());
    const n = quantizedBytes(q);
    expect(n).toBe(new TextEncoder().encode(JSON.stringify(q)).length);
    expect(n).toBeGreaterThan(288);
    expect(n).toBeLessThan(360);
    // 20 三角形（世田谷の平均）なら ≈ 480 + 40 B
    const t20: NeighborMesh = { tris: new Float32Array(20 * 9).fill(1.5), roofTriangles: 4 };
    expect(quantizedBytes(quantizeMesh(t20))).toBeLessThan(560);
  });
});
