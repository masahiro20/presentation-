import { describe, it, expect } from 'vitest';
import { toPlaneRect, zoneFromEpsg, zoneFromWkt, detectZone, gridConvergenceDeg } from '../src/sun/pointcloud/planeRect';
import { readPointCloud } from '../src/sun/pointcloud/read';
import { planPlacement, siteFilter, toSiteCloud, type SiteCloud } from '../src/sun/pointcloud/place';
import { fitBuildings, fitRoof } from '../src/sun/pointcloud/fit';
import { toLocal } from '../src/sun/geo';
import type { EN } from '../src/sun/plateau/types';

const SITE = { lat: 35.6385, lon: 139.6575 };

/** 高さの関数 roof(e, n) の建物 + 地面（標高 base）の点を、0.5m 間隔で作る */
function scene(base: number, houses: { ring: EN[]; roof: (e: number, n: number) => number }[], trees: { e: number; n: number; r: number; h: number }[] = [], R = 40) {
  const pts: { e: number; n: number; z: number; c: number }[] = [];
  const inRing = (e: number, n: number, ring: EN[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.n > n !== b.n > n && e < ((b.e - a.e) * (n - a.n)) / (b.n - a.n) + a.e) inside = !inside;
    }
    return inside;
  };
  for (let e = -R; e <= R; e += 0.5)
    for (let n = -R; n <= R; n += 0.5) {
      const hse = houses.find((hh) => inRing(e, n, hh.ring));
      const tr = trees.find((t) => Math.hypot(e - t.e, n - t.n) < t.r);
      if (hse) pts.push({ e, n, z: base + hse.roof(e, n), c: 6 });
      else if (tr) {
        // 樹冠の上面と、枝葉の中に届いた返り（木は上下に散らばる）
        pts.push({ e, n, z: base + tr.h * (1 - 0.3 * (Math.hypot(e - tr.e, n - tr.n) / tr.r) ** 2), c: 5 });
        pts.push({ e, n, z: base + tr.h * 0.55, c: 5 });
      }
      else pts.push({ e, n, z: base + 0.02 * ((e * 7 + n * 13) % 3), c: 2 });
    }
  return pts;
}

function cloudOf(pts: { e: number; n: number; z: number; c: number }[], classified = true): SiteCloud {
  return {
    count: pts.length,
    e: Float32Array.from(pts.map((p) => p.e)),
    n: Float32Array.from(pts.map((p) => p.n)),
    z: Float32Array.from(pts.map((p) => p.z)),
    cls: classified ? Uint8Array.from(pts.map((p) => p.c)) : null,
    rgb: null,
    placement: { kind: 'local', up: 'z', offsetE: 0, offsetN: 0, rotDeg: 0 },
    header: { format: 'las', total: pts.length, bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 } },
  };
}

const rect = (e0: number, n0: number, e1: number, n1: number): EN[] => [
  { e: e0, n: n0 },
  { e: e1, n: n0 },
  { e: e1, n: n1 },
  { e: e0, n: n1 },
];

/** LAS 1.2・形式 3（色つき）・EPSG を GeoKey に入れて書く */
function writeLas(xyz: { x: number; y: number; z: number; c: number }[], epsg: number | null): ArrayBuffer {
  const headerSize = 227;
  const vlrBody = epsg ? 8 + 8 * 1 : 0;
  const vlrLen = epsg ? 54 + vlrBody : 0;
  const recLen = 34;
  const offsetToPoints = headerSize + vlrLen;
  const buf = new ArrayBuffer(offsetToPoints + xyz.length * recLen);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set([76, 65, 83, 70], 0);
  dv.setUint8(24, 1);
  dv.setUint8(25, 2);
  dv.setUint16(94, headerSize, true);
  dv.setUint32(96, offsetToPoints, true);
  dv.setUint32(100, epsg ? 1 : 0, true);
  dv.setUint8(104, 3);
  dv.setUint16(105, recLen, true);
  dv.setUint32(107, xyz.length, true);
  const minX = Math.min(...xyz.map((p) => p.x));
  const minY = Math.min(...xyz.map((p) => p.y));
  const scale = 0.001;
  for (const [i, v] of [scale, scale, scale].entries()) dv.setFloat64(131 + i * 8, v, true);
  dv.setFloat64(155, Math.floor(minX), true);
  dv.setFloat64(163, Math.floor(minY), true);
  dv.setFloat64(171, 0, true);
  dv.setFloat64(179, Math.max(...xyz.map((p) => p.x)), true);
  dv.setFloat64(187, minX, true);
  dv.setFloat64(195, Math.max(...xyz.map((p) => p.y)), true);
  dv.setFloat64(203, minY, true);
  dv.setFloat64(211, Math.max(...xyz.map((p) => p.z)), true);
  dv.setFloat64(219, Math.min(...xyz.map((p) => p.z)), true);
  if (epsg) {
    const p = headerSize;
    u8.set(new TextEncoder().encode('LASF_Projection'), p + 2);
    dv.setUint16(p + 18, 34735, true);
    dv.setUint16(p + 20, vlrBody, true);
    const b = p + 54;
    dv.setUint16(b, 1, true);
    dv.setUint16(b + 2, 1, true);
    dv.setUint16(b + 4, 0, true);
    dv.setUint16(b + 6, 1, true);
    dv.setUint16(b + 8, 3072, true);
    dv.setUint16(b + 10, 0, true);
    dv.setUint16(b + 12, 1, true);
    dv.setUint16(b + 14, epsg, true);
  }
  xyz.forEach((p, i) => {
    const at = offsetToPoints + i * recLen;
    dv.setInt32(at, Math.round((p.x - Math.floor(minX)) / scale), true);
    dv.setInt32(at + 4, Math.round((p.y - Math.floor(minY)) / scale), true);
    dv.setInt32(at + 8, Math.round(p.z / scale), true);
    dv.setUint8(at + 15, p.c);
    dv.setUint16(at + 28, 40000, true);
    dv.setUint16(at + 30, 30000, true);
    dv.setUint16(at + 32, 20000, true);
  });
  return buf;
}

describe('平面直角座標系', () => {
  it('原点は 0、近くの 2 点の差は局所の東・北と合う', () => {
    const o = toPlaneRect(36, 139 + 50 / 60, 9);
    expect(Math.abs(o.X)).toBeLessThan(1e-6);
    expect(Math.abs(o.Y)).toBeLessThan(1e-6);
    const a = toPlaneRect(SITE.lat, SITE.lon, 9);
    const lat2 = SITE.lat + 0.003;
    const lon2 = SITE.lon + 0.004;
    const b = toPlaneRect(lat2, lon2, 9);
    const loc = toLocal(lat2, lon2, SITE.lat, SITE.lon);
    const g = (gridConvergenceDeg(SITE.lat, SITE.lon, 9) * Math.PI) / 180;
    const ge = b.Y - a.Y;
    const gn = b.X - a.X;
    const e = ge * Math.cos(g) - gn * Math.sin(g);
    const n = ge * Math.sin(g) + gn * Math.cos(g);
    expect(Math.hypot(e - loc.e, n - loc.n)).toBeLessThan(0.5);
    // 世田谷（第 9 系の原点より西）: X は負（原点 36° より南）、Y も負
    expect(a.X).toBeLessThan(-30000);
    expect(a.Y).toBeLessThan(-10000);
  });

  it('EPSG・WKT から系を読む、無ければ範囲から探す', () => {
    expect(zoneFromEpsg(6677)).toEqual({ zone: 9, datum: 'JGD2011' });
    expect(zoneFromEpsg(2450)?.zone).toBe(8);
    expect(zoneFromWkt('PROJCS["JGD2011 / Japan Plane Rectangular CS IX",GEOGCS["JGD2011",AUTHORITY["EPSG","6668"]],AUTHORITY["EPSG","6677"]]')).toEqual({ zone: 9, datum: 'JGD2011' });
    expect(zoneFromWkt('PROJCS["JGD2000_Japan_Zone_7",GEOGCS["GCS_JGD_2000"]]')?.zone).toBe(7);
    expect(zoneFromWkt('PROJCS["Japan Plane Rectangular CS VIII"]')?.zone).toBe(8);
    const s = toPlaneRect(SITE.lat, SITE.lon, 9);
    const g = detectZone(SITE.lat, SITE.lon, { minX: s.Y - 500, maxX: s.Y + 500, minY: s.X - 400, maxY: s.X + 400 });
    expect(g).toMatchObject({ zone: 9, swapped: false, distance: 0 });
  });
});

describe('点群ファイルの読み込み', () => {
  it('LAS（EPSG 入り）を敷地の東・北に置き、建物の屋根を当てはめる', async () => {
    const ring = rect(-4, 10, 6, 17); // 東西 10m × 南北 7m、棟は東西（長手）
    const pts = scene(35, [{ ring, roof: (_e, n) => 6 + 2.5 * (1 - Math.abs(n - 13.5) / 3.5) }]);
    const s = toPlaneRect(SITE.lat, SITE.lon, 9);
    // 局所の東・北 → 平面直角（収差は小さいので無視して置く。読み戻しで 0.1m 以内に戻ること）
    const xyz = pts.map((p) => ({ x: s.Y + p.e, y: s.X + p.n, z: p.z, c: p.c }));
    const buf = writeLas(xyz, 6677);
    const raw = await readPointCloud(buf, 'a.las', {
      filter: (h) => {
        const pl = planPlacement(h, SITE);
        return siteFilter(pl, SITE, 30);
      },
    });
    expect(raw.header.epsg).toBe(6677);
    expect(raw.rgb?.[0]).toBe(40000 >> 8);
    const pl = planPlacement(raw.header, SITE);
    expect(pl).toMatchObject({ kind: 'plane', zone: 9, zoneFrom: 'epsg' });
    const c = toSiteCloud(raw, pl, SITE, 30);
    expect(c.count).toBeGreaterThan(1000);
    const res = fitBuildings(c, [{ key: 'a', ring, height: 7 }]);
    const f = res.fits.get('a');
    expect(f?.spec.kind).toBe('gable');
    expect(f?.spec.ridgeDir).toBe('long');
    expect(f!.spec.eave).toBeGreaterThan(5.7);
    expect(f!.spec.eave).toBeLessThan(6.3);
    expect(f!.spec.ridge).toBeGreaterThan(8.2);
    expect(f!.spec.ridge).toBeLessThan(8.8);
    expect(f!.base).toBeCloseTo(35, 0);
  });

  it('PLY（iPhone のスキャン: y が上）を読む', async () => {
    const lines = ['ply', 'format ascii 1.0', 'element vertex 4', 'property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue', 'end_header', '1 0 -2 255 0 0', '2 3 -2 0 255 0', '0 0 0 0 0 255', '5 1 -9 10 10 10'];
    const raw = await readPointCloud(new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer, 'scan.ply');
    expect(raw.count).toBe(4);
    expect(Array.from(raw.rgb!.slice(0, 3))).toEqual([255, 0, 0]);
    const pl = planPlacement(raw.header, SITE, { up: 'y', offsetE: 10, offsetN: 0, rotDeg: 90 });
    const c = toSiteCloud(raw, pl, SITE, 100);
    // (x=1, z=-2) → 北 2 → 90° 回す（スキャンの北 = 真東）→ 東 2 + ずらし 10 = 12、北 −1
    expect(c.e[0]).toBeCloseTo(12, 5);
    expect(c.n[0]).toBeCloseTo(-1, 5);
    expect(c.z[1]).toBeCloseTo(3, 5);
  });

  it('PLY（binary）と XYZ', async () => {
    const head = new TextEncoder().encode(['ply', 'format binary_little_endian 1.0', 'element vertex 2', 'property double x', 'property double y', 'property double z', 'end_header', ''].join('\n'));
    const body = new Float64Array([1, 2, 3, 4, 5, 6]);
    const buf = new Uint8Array(head.length + body.byteLength);
    buf.set(head);
    buf.set(new Uint8Array(body.buffer), head.length);
    const raw = await readPointCloud(buf.buffer, 'b.ply');
    expect(Array.from(raw.z)).toEqual([3, 6]);
    const xyz = await readPointCloud(new TextEncoder().encode('# x y z c\n1,2,3,6\n4 5 6 2\n').buffer as ArrayBuffer, 'c.xyz');
    expect(xyz.count).toBe(2);
    expect(Array.from(xyz.cls!)).toEqual([6, 2]);
  });

  it('経度・緯度のままの点群は断る／範囲が離れていれば断る', () => {
    expect(() => planPlacement({ format: 'xyz', total: 1, bounds: { minX: 139.6, maxX: 139.7, minY: 35.6, maxY: 35.7, minZ: 0, maxZ: 1 } }, SITE)).toThrow(/経度・緯度/);
    const s = toPlaneRect(SITE.lat, SITE.lon, 9);
    expect(() => planPlacement({ format: 'las', total: 1, epsg: 6677, bounds: { minX: s.Y + 20000, maxX: s.Y + 21000, minY: s.X, maxY: s.X + 1000, minZ: 0, maxZ: 1 } }, SITE)).toThrow(/離れています/);
  });
});

describe('屋根の形の当てはめ', () => {
  it('寄棟・片流れ・陸屋根（パラペット）・分類の無い点群', () => {
    const hipRing = rect(-20, -20, -8, -12); // 東西 12 × 南北 8
    const hip = (e: number, n: number) => 5.5 + 2 * (1 - Math.min(1, Math.max(Math.abs(n + 16) / 4, (Math.abs(e + 14) - 2) / 4)));
    const shedRing = rect(10, -20, 18, -12);
    const shed = (_e: number, n: number) => 5 + 1.6 * ((n + 20) / 8); // 北が高い
    const flatRing = rect(10, 10, 22, 22);
    const flat = (e: number, n: number) => (e < 10.6 || e > 21.4 || n < 10.6 || n > 21.4 ? 10.1 : 9.0); // 屋上 9m、縁に 1.1m の立ち上がり
    const pts = scene(12, [
      { ring: hipRing, roof: hip },
      { ring: shedRing, roof: shed },
      { ring: flatRing, roof: flat },
    ], [{ e: -25, n: 15, r: 3, h: 8 }]);
    const bl = [
      { key: 'hip', ring: hipRing, height: 7 },
      { key: 'shed', ring: shedRing, height: 7 },
      { key: 'flat', ring: flatRing, height: 9 },
    ];
    for (const classified of [true, false]) {
      const res = fitBuildings(cloudOf(pts, classified), bl);
      const hipF = res.fits.get('hip')!.spec;
      expect(hipF.kind).toBe('hip');
      expect(hipF.eave).toBeCloseTo(5.5, 0);
      expect(hipF.ridge).toBeCloseTo(7.5, 0);
      const shedF = res.fits.get('shed')!.spec;
      expect(shedF.kind).toBe('shed');
      expect(shedF.highSide).toBe('N');
      expect(shedF.ridge).toBeCloseTo(6.6, 0);
      const flatF = res.fits.get("flat")!.spec;
      expect(flatF.kind).toBe('flat');
      expect(flatF.eave).toBeCloseTo(9, 0);
      expect(flatF.parapet).toBeGreaterThan(0.8);
      // 木: 1 本、高さ 8m 前後
      const near = res.trees.filter((t) => Math.hypot(t.e + 25, t.n - 15) < 4);
      expect(near.length).toBeGreaterThanOrEqual(1);
      expect(Math.max(...near.map((t) => t.height))).toBeGreaterThan(7);
      expect(res.trees.filter((t) => Math.hypot(t.e + 25, t.n - 15) >= 6).length).toBe(0);
    }
  });

  it('点が少ない・低い（解体済み）建物は当てはめない', () => {
    const ring = rect(0, 0, 8, 8);
    expect(fitRoof(ring, [{ e: 1, n: 1, h: 5 }], 6)).toMatchObject({ skip: 'few' });
    const low = Array.from({ length: 100 }, (_, i) => ({ e: (i % 10) * 0.8, n: Math.floor(i / 10) * 0.8, h: 1.2 }));
    expect(fitRoof(ring, low, 6)).toMatchObject({ skip: 'low' });
  });
});
