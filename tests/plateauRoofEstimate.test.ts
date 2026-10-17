// 推定の屋根（LOD1 の箱形の建物に屋根の形・軒・棟を推定してかぶせる。roofEstimate.ts / roofSpec.ts）
import { describe, expect, it } from 'vitest';
import type { EN, PlateauAttrs, PlateauBuilding } from '../src/sun/plateau/types';
import { ROOF_ESTIMATE, estimateEave, minAreaRect, normalizeSpec, planRoof, specMesh, specTop, usageClass, withEstimatedRoof } from '../src/sun/plateau/roofEstimate';
import { earClip, flatMesh, gableMesh, hipMesh, shedMesh } from '../src/sun/plateau/roofSpec';

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

const triCount = (m: { tris: Float32Array }) => m.tris.length / 9;
function stats(m: { tris: Float32Array; roofTriangles: number }) {
  let minY = Infinity;
  let maxY = -Infinity;
  let upArea = 0;
  let wallArea = 0;
  for (let t = 0; t < triCount(m); t++) {
    const v = (k: number) => [m.tris[t * 9 + k * 3], m.tris[t * 9 + k * 3 + 1], m.tris[t * 9 + k * 3 + 2]];
    const [a, b, c] = [v(0), v(1), v(2)];
    for (const q of [a, b, c]) {
      minY = Math.min(minY, q[1]);
      maxY = Math.max(maxY, q[1]);
    }
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const L = Math.hypot(n[0], n[1], n[2]);
    if (n[1] > 0) upArea += (L / 2) * (n[1] / L);
    else if (Math.abs(n[1]) / L < 0.3) wallArea += L / 2;
  }
  return { minY, maxY, upArea, wallArea };
}

describe('minAreaRect / estimateEave / usageClass', () => {
  it('回した長方形の長手と寸法', () => {
    const r = minAreaRect(rectRing(3, -2, 12, 6, 30))!;
    expect(r.long).toBeCloseTo(12, 6);
    expect(r.short).toBeCloseTo(6, 6);
    expect(r.cx).toBeCloseTo(3, 6);
  });
  it('軒: 中央値から逆算（中央値は軒と棟の下から 0.41）。階数があれば 階数 × 2.8 m との平均', () => {
    expect(estimateEave(6.8, 7.8, undefined)).toBeCloseTo((6.8 - 0.41 * 7.8) / 0.59, 6);
    expect(estimateEave(6.8, 7.8, 2)).toBeCloseTo(((6.8 - 0.41 * 7.8) / 0.59 + 5.6) / 2, 6);
  });
  it('用途の分類', () => {
    expect(usageClass('住宅')).toBe('house');
    expect(usageClass('店舗等併用住宅')).toBe('house');
    expect(usageClass('共同住宅')).toBe('apartment');
    expect(usageClass('事務所')).toBe('other');
    expect(usageClass(undefined)).toBe('unknown');
  });
});

describe('planRoof（屋根の形の判定）', () => {
  it('住宅: 寄棟。棟 = 実測の最高高さ、軒は中央値の逆算と階数の平均。階数・階高が入る', () => {
    const p = planRoof(building())!;
    expect(p.roof.kind).toBe('hip');
    expect(p.roof.ridge).toBe(7.8);
    expect(p.roof.eave).toBeCloseTo(estimateEave(6.8, 7.8, 2), 1);
    expect(p.roof.storeys).toBe(2);
    expect(p.roof.floorH).toBeCloseTo(p.roof.eave / 2, 1);
    expect(p.roof.boxHeight).toBe(6.8);
  });
  it('勾配が急すぎる住宅は片流れ（高い側は北）。立ち上がりは 8 寸以内', () => {
    const p = planRoof(building({ zmax: 35.0, measuredHeight: 8.6, storeys: undefined }))!;
    expect(p.roof.kind).toBe('shed');
    expect(p.roof.highSide).toBe('N');
    expect(p.roof.ridge - p.roof.eave).toBeLessThanOrEqual(ROOF_ESTIMATE.maxPitch * 7 + 0.01);
  });
  it('共同住宅: 3 階以上・200 m² 超は陸屋根（パラペット = 棟 − 中央値）、2 階以下の小さなものは切妻', () => {
    const big = planRoof(building({ usage: '共同住宅', storeys: 4, zmax: 42.2, measuredHeight: 13.0 }, rectRing(0, 0, 20, 12)))!;
    expect(big.roof.kind).toBe('flat');
    expect(big.roof.eave).toBe(12.2);
    expect(big.roof.parapet).toBe(0.8);
    expect(big.roof.ridge).toBe(13);
    const small = planRoof(building({ usage: '共同住宅', storeys: 2 }))!;
    expect(small.roof.kind).toBe('gable');
  });
  it('住宅以外（店舗・事務所）は陸屋根にパラペット。棟との差が 0.4 m 未満・1.5 m 超なら屋根を付けない（箱のまま）', () => {
    expect(planRoof(building({ usage: '事務所', storeys: 3, zmax: 40, measuredHeight: 10.8 }, rectRing(0, 0, 14, 10)))!.roof).toMatchObject({ kind: 'flat', parapet: 0.8 });
    expect(planRoof(building({ usage: '事務所', measuredHeight: 6.9 }))).toBeNull();
    expect(planRoof(building({ usage: '事務所', measuredHeight: 9.5 }))).toBeNull();
  });
  it('付けない: 陸屋根の住宅（差 < 0.4）・LOD2・中高層の住宅・長方形でない・穴あり・実測の最高高さが無い', () => {
    expect(planRoof(building({ measuredHeight: 7.0 }))).toBeNull();
    expect(planRoof(building({ lod: 2 }))).toBeNull();
    const L: EN[] = [{ e: 0, n: 0 }, { e: 10, n: 0 }, { e: 10, n: 3 }, { e: 4, n: 3 }, { e: 4, n: 9 }, { e: 0, n: 9 }];
    expect(planRoof(building({}, L))).toBeNull();
    const withHole = building();
    withHole.holes = [rectRing(0, 0, 2, 2)];
    expect(planRoof(withHole)).toBeNull();
    expect(planRoof(building({ measuredHeight: undefined }))).toBeNull();
    // 4 階建ての住宅は傾いた屋根にしない（箱に近い陸屋根: パラペットの差が範囲外なら null）
    expect(planRoof(building({ storeys: 4, measuredHeight: 14, zmax: 41 }))).toBeNull();
  });
  it('用途が無くても 2 階以下・200 m² 以下なら住宅とみなす', () => {
    expect(planRoof(building({ usage: undefined }))).not.toBeNull();
    // 3 階以上で用途が分からなければ住宅とはみなさず、陸屋根（パラペット）か箱のまま
    expect(planRoof(building({ usage: undefined, storeys: 3 }))!.roof.kind).toBe('flat');
  });
});

describe('屋根つきの三角形', () => {
  const rect = minAreaRect(rectRing(0, 0, 10, 7))!;
  it('寄棟: 壁 8 + 屋根 6、足元 0・最高 = 棟。屋根の上向きの面積 = 足元の面積', () => {
    const m = hipMesh(rect, 5.8, 7.8);
    expect(triCount(m)).toBe(14);
    expect(m.roofTriangles).toBe(6);
    const s = stats(m);
    expect(s.minY).toBe(0);
    expect(s.maxY).toBeCloseTo(7.8, 5);
    expect(s.upArea).toBeCloseTo(70, 3);
  });
  it('正方形に近い寄棟は角錐（屋根の三角形 4）', () => {
    expect(hipMesh(minAreaRect(rectRing(0, 0, 6, 6))!, 5, 7).roofTriangles).toBe(4);
  });
  it('切妻: 棟は長手（既定）または短手。妻壁は棟まで立ち上がる（壁の面積が寄棟より大きい）', () => {
    const g = gableMesh(rect, 5.8, 7.8);
    const g2 = gableMesh(rect, 5.8, 7.8, 'short');
    expect(g.roofTriangles).toBe(4);
    expect(stats(g).maxY).toBeCloseTo(7.8, 5);
    expect(stats(g).upArea).toBeCloseTo(70, 3);
    expect(stats(g).wallArea).toBeGreaterThan(stats(hipMesh(rect, 5.8, 7.8)).wallArea);
    // 棟の向きが違えば最高点の位置（棟の方向）が違う: 長手の棟の端の z 幅は短手の棟より小さい
    const spanZ = (m: { tris: Float32Array }) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < m.tris.length; i += 3) {
        if (Math.abs(m.tris[i + 1] - 7.8) < 1e-5) {
          lo = Math.min(lo, m.tris[i]);
          hi = Math.max(hi, m.tris[i]);
        }
      }
      return hi - lo;
    };
    expect(spanZ(g)).toBeGreaterThan(spanZ(g2));
  });
  it('片流れ: 高い側の壁だけ棟の高さ、低い側は軒の高さ。上向きの面積 = 足元の面積', () => {
    const north = shedMesh(minAreaRect(rectRing(0, 0, 10, 7))!, 5, 7, 'N');
    const s = stats(north);
    expect(s.maxY).toBeCloseTo(7, 5);
    expect(s.upArea).toBeCloseTo(70, 0);
    // 北側（z が負）の頂点は 7 m、南側（z が正）の頂点の屋根は 5 m
    let hiNorth = 0;
    let loSouth = 0;
    for (let i = 0; i < north.tris.length; i += 3) {
      const [, y, z] = [north.tris[i], north.tris[i + 1], north.tris[i + 2]];
      if (y > 4.9) {
        if (z < -3) hiNorth = Math.max(hiNorth, y);
        if (z > 3) loSouth = Math.max(loSouth, y);
      }
    }
    expect(hiNorth).toBeCloseTo(7, 5);
    expect(loSouth).toBeCloseTo(5, 5);
  });
  it('陸屋根: 足元の輪郭どおり（L 字でも屋上の面積 = 輪郭の面積）。パラペットは屋上面から rim の高さ', () => {
    const L: EN[] = [{ e: 0, n: 0 }, { e: 10, n: 0 }, { e: 10, n: 3 }, { e: 4, n: 3 }, { e: 4, n: 9 }, { e: 0, n: 9 }];
    const area = 10 * 3 + 4 * 6;
    expect(earClip(L)).toHaveLength(L.length - 2);
    const m = flatMesh(L, 9, 0.8);
    const s = stats(m);
    expect(s.minY).toBe(0);
    expect(s.maxY).toBeCloseTo(9.8, 5);
    expect(s.upArea).toBeCloseTo(area, 3);
    expect(stats(flatMesh(L, 9, 0)).maxY).toBeCloseTo(9, 5);
  });
  it('時計回りの輪郭でも同じ（向きは外向き）', () => {
    const cw = [...rectRing(0, 0, 8, 6)].reverse();
    expect(stats(flatMesh(cw, 6, 0)).upArea).toBeCloseTo(48, 3);
  });
});

describe('withEstimatedRoof / normalizeSpec / specMesh', () => {
  it('mesh・height・zmax・roofEstimate が入り、輪郭は変わらない。付けない建物は同じオブジェクト', () => {
    const b = building();
    const e = withEstimatedRoof(b);
    expect(e).not.toBe(b);
    expect(e.height).toBe(7.8);
    expect(e.attrs.zmax).toBeCloseTo(37.8, 6);
    expect(e.attrs.roofEstimate?.kind).toBe('hip');
    expect(e.ring).toBe(b.ring);
    expect(b.attrs.roofEstimate).toBeUndefined();
    const flat = building({ measuredHeight: 7 });
    expect(withEstimatedRoof(flat)).toBe(flat);
  });
  it('陸屋根（パラペット）の建物の最高点は棟（= 屋上面 + パラペット）', () => {
    const e = withEstimatedRoof(building({ usage: '事務所', storeys: 3, zmax: 40, measuredHeight: 10.8 }, rectRing(0, 0, 14, 10)));
    expect(e.height).toBeCloseTo(10.8, 5);
    expect(e.attrs.roofEstimate).toMatchObject({ kind: 'flat', eave: 10, parapet: 0.8 });
    expect(stats(e.mesh).maxY).toBeCloseTo(10.8, 5);
  });
  it('normalizeSpec: 軒 ≤ 棟、陸屋根は parapet = 棟 − 軒、形ごとに不要な項目を消す', () => {
    expect(normalizeSpec({ kind: 'hip', eave: 6, ridge: 5, boxHeight: 5 })).toMatchObject({ eave: 6, ridge: 6 });
    const f = normalizeSpec({ kind: 'flat', eave: 9, ridge: 9.8, boxHeight: 9, ridgeDir: 'short', highSide: 'S' });
    expect(f).toMatchObject({ parapet: 0.8 });
    expect(f.ridgeDir).toBeUndefined();
    expect(f.highSide).toBeUndefined();
    expect(normalizeSpec({ kind: 'shed', eave: 5, ridge: 7, boxHeight: 6 }).highSide).toBe('N');
    expect(specTop({ kind: 'flat', eave: 9, ridge: 9.8, parapet: 0.8 })).toBeCloseTo(9.8, 6);
  });
  it('specMesh: 傾いた屋根は長方形でなくても外接長方形にかぶせる。陸屋根は輪郭どおり', () => {
    expect(specMesh(rectRing(0, 0, 10, 7), { kind: 'gable', eave: 5, ridge: 7, boxHeight: 6 })!.roofTriangles).toBe(4);
    expect(specMesh(rectRing(0, 0, 10, 7), { kind: 'flat', eave: 6, ridge: 6.5, boxHeight: 6 })!.roofTriangles).toBeGreaterThan(0);
  });
});
