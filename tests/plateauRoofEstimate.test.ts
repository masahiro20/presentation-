// 推定の屋根（LOD1 の箱形の低層住宅に寄棟をかぶせる。roofEstimate.ts）
import { describe, expect, it } from 'vitest';
import type { EN, PlateauAttrs, PlateauBuilding } from '../src/sun/plateau/types';
import { ROOF_ESTIMATE, hipRoofMesh, minAreaRect, planRoof, withEstimatedRoof } from '../src/sun/plateau/roofEstimate';

const rectRing = (cx: number, cy: number, w: number, d: number, rotDeg = 0): EN[] => {
  const r = (rotDeg * Math.PI) / 180;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
    const x = (a * w) / 2;
    const y = (b * d) / 2;
    return { e: cx + x * Math.cos(r) - y * Math.sin(r), n: cy + x * Math.sin(r) + y * Math.cos(r) };
  });
};

function building(over: Partial<PlateauAttrs> = {}, ring: EN[] = rectRing(0, 0, 10, 7)): PlateauBuilding {
  const attrs: PlateauAttrs = { gmlId: 'bldg_x', lod: 1, datasetLod: 2, year: 2025, muniCd: '13112', pref: '東京都', city: '世田谷区', ward: null, anchor: { lat: 35.6, lon: 139.6 }, zmin: 30, zmax: 36.8, measuredHeight: 7.8, storeys: 2, usage: '住宅', footprint: 'bottom', ...over };
  return { gmlId: attrs.gmlId, batchId: 0, attrs, ring, holes: [], height: attrs.zmax - attrs.zmin, mesh: { tris: new Float32Array(9), roofTriangles: 0 } };
}

describe('minAreaRect', () => {
  it('回した長方形の長手と寸法を返す', () => {
    const r = minAreaRect(rectRing(3, -2, 12, 6, 30))!;
    expect(r.long).toBeCloseTo(12, 6);
    expect(r.short).toBeCloseTo(6, 6);
    expect(r.cx).toBeCloseTo(3, 6);
    expect(r.cy).toBeCloseTo(-2, 6);
    expect(Math.abs(r.ux * Math.cos((30 * Math.PI) / 180) + r.uy * Math.sin((30 * Math.PI) / 180))).toBeCloseTo(1, 6);
  });
});

describe('planRoof（付ける建物の判定と軒・棟）', () => {
  it('棟 = 実測の最高高さ、軒 = 2 × 中央値 − 棟（中央値 6.8・最高 7.8 → 軒 5.8）', () => {
    const p = planRoof(building())!;
    expect(p.roof).toEqual({ kind: 'hip', eave: 5.8, ridge: 7.8, boxHeight: 6.8 });
  });
  it('勾配が 8 寸を超えるなら軒を上げて抑える（短辺 7 m・棟 − 中央値 3 m → 立ち上がり ≤ 0.8 × 3.5 = 2.8 m）', () => {
    const p = planRoof(building({ zmax: 36.4, measuredHeight: 9.4 }))!; // med 6.4・ridge 9.4 → 立ち上がり 6 → 抑える
    expect(p.roof.ridge - p.roof.eave).toBeCloseTo(ROOF_ESTIMATE.maxPitch * 3.5, 2);
  });
  it('付けない: 陸屋根（最高 − 中央値 < 0.4）・LOD2・非住宅・中高層・階数多・長方形でない・穴あり', () => {
    expect(planRoof(building({ measuredHeight: 7.0 }))).toBeNull();
    expect(planRoof(building({ lod: 2 }))).toBeNull();
    expect(planRoof(building({ usage: '工場' }))).toBeNull();
    expect(planRoof(building({ measuredHeight: 13, zmax: 42 }))).toBeNull();
    expect(planRoof(building({ storeys: 4 }))).toBeNull();
    const L: EN[] = [{ e: 0, n: 0 }, { e: 10, n: 0 }, { e: 10, n: 3 }, { e: 4, n: 3 }, { e: 4, n: 9 }, { e: 0, n: 9 }];
    expect(planRoof(building({}, L))).toBeNull();
    const withHole = building();
    withHole.holes = [rectRing(0, 0, 2, 2)];
    expect(planRoof(withHole)).toBeNull();
    expect(planRoof(building({ measuredHeight: undefined }))).toBeNull();
  });
  it('用途が無くても 2 階以下・200 m² 以下なら付ける', () => {
    expect(planRoof(building({ usage: undefined }))).not.toBeNull();
    expect(planRoof(building({ usage: undefined, storeys: 3 }))).toBeNull();
  });
});

describe('hipRoofMesh / withEstimatedRoof', () => {
  const tris = (m: { tris: Float32Array }) => m.tris.length / 9;
  it('寄棟: 壁 8 + 屋根 6 三角形（棟あり）、屋根が先頭、足元 y = 0・最高 = 棟、全三角形が外向き', () => {
    const m = hipRoofMesh(minAreaRect(rectRing(0, 0, 10, 7))!, 5.8, 7.8);
    expect(tris(m)).toBe(14);
    expect(m.roofTriangles).toBe(6);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < m.tris.length; i += 3) {
      minY = Math.min(minY, m.tris[i]);
      maxY = Math.max(maxY, m.tris[i]);
    }
    expect(minY).toBe(0);
    expect(maxY).toBeCloseTo(7.8, 5);
    for (let t = 0; t < tris(m); t++) {
      const v = (k: number) => [m.tris[t * 9 + k * 3], m.tris[t * 9 + k * 3 + 1], m.tris[t * 9 + k * 3 + 2]];
      const [a, b, c] = [v(0), v(1), v(2)];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const g = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3 - 2.9, (a[2] + b[2] + c[2]) / 3];
      expect(n[0] * g[0] + n[1] * g[1] + n[2] * g[2]).toBeGreaterThan(0);
    }
  });
  it('屋根の三角形（先頭 roofTriangles 個）は上向き、残りは壁', () => {
    const m = hipRoofMesh(minAreaRect(rectRing(0, 0, 10, 7))!, 5.8, 7.8);
    expect(m.roofTriangles).toBe(6);
    for (let t = 0; t < tris(m); t++) {
      const v = (k: number) => [m.tris[t * 9 + k * 3], m.tris[t * 9 + k * 3 + 1], m.tris[t * 9 + k * 3 + 2]];
      const [a, b, c] = [v(0), v(1), v(2)];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const ny = (u[2] * w[0] - u[0] * w[2]) / (Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) || 1);
      if (t < m.roofTriangles) expect(ny).toBeGreaterThan(0.5);
      else expect(ny).toBeLessThan(0.5);
    }
  });
  it('正方形なら棟が 0 長の角錐（屋根の三角形 4）', () => {
    const m = hipRoofMesh(minAreaRect(rectRing(0, 0, 6, 6))!, 5, 7);
    expect(m.roofTriangles).toBe(4);
  });
  it('withEstimatedRoof: mesh・height・zmax・roofEstimate が入り、輪郭は変わらない。付けない建物は同じオブジェクト', () => {
    const b = building();
    const e = withEstimatedRoof(b);
    expect(e).not.toBe(b);
    expect(e.height).toBe(7.8);
    expect(e.attrs.zmax).toBeCloseTo(37.8, 6);
    expect(e.attrs.roofEstimate).toEqual({ kind: 'hip', eave: 5.8, ridge: 7.8, boxHeight: 6.8 });
    expect(e.ring).toBe(b.ring);
    expect(b.attrs.roofEstimate).toBeUndefined();
    const flat = building({ measuredHeight: 7 });
    expect(withEstimatedRoof(flat)).toBe(flat);
  });
});
