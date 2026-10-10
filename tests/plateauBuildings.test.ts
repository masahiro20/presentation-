/**
 * 復号したタイルを建物に分ける（src/sun/plateau/buildings.ts）のテスト。
 *  - 実 fixture 23113 data0（守山区 LOD1 葉・6 棟）: batchTable の _xmin.._ymax・_zmin/_zmax との照合、底面輪郭の面積一致、屋根先頭ソート、ジオイド中央値
 *  - 23102 data1（深さ 2 の内部ノード・底面なし）: 全棟 'hull' + noBottom。data55（root の簡略形状）: baseMismatch・LOD2 5 棟
 *  - 手作りの形（中庭付き・離れた 2 棟・小さすぎる・keep）: 穴・島・tooSmall・kept・gml_id 無しの gmlId
 * Node では tests/helpers/nodeDraco.ts で実タイルを復号する。
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { ringArea } from '../src/sun/footprint';
import { metersPerDegree, toLocal } from '../src/sun/geo';
import { geodeticToEcef } from '../src/sun/geodesy';
import { parseB3dm, type B3dm, type BatchTable } from '../src/sun/plateau/b3dm';
import { compareWithRecord, footprintFromBottomFaces, readBuildingRecords, sortRoofFirst, splitBuildings, type SplitResult } from '../src/sun/plateau/buildings';
import { decodeTileGlb } from '../src/sun/plateau/glb';
import type { DecodedTile, DracoDecoderLike, EN, PlateauAttrs, PlateauBuilding } from '../src/sun/plateau/types';
import { nodeDracoDecoder } from './helpers/nodeDraco';

/** fixture を独立した ArrayBuffer として読む（Buffer はプールを共有するので slice する） */
const fixture = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`./fixtures/plateau/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

type Meta = Pick<PlateauAttrs, 'muniCd' | 'pref' | 'city' | 'ward' | 'year' | 'datasetLod'>;
const META_23113: Meta = { muniCd: '23113', pref: '愛知県', city: '名古屋市', ward: '守山区', year: 2022, datasetLod: 1 };
const META_23102: Meta = { muniCd: '23102', pref: '愛知県', city: '名古屋市', ward: '東区', year: 2022, datasetLod: 2 };

/** 三角形 t の幾何法線（正規化）の y（右手系 x=東, y=上, z=−北） */
function normalY(tris: Float32Array, t: number): number {
  const o = t * 9;
  const a = new THREE.Vector3(tris[o], tris[o + 1], tris[o + 2]);
  const b = new THREE.Vector3(tris[o + 3], tris[o + 4], tris[o + 5]).sub(a);
  const c = new THREE.Vector3(tris[o + 6], tris[o + 7], tris[o + 8]).sub(a);
  const n = b.cross(c);
  return n.lengthSq() > 0 ? n.normalize().y : 0;
}

/** 底面三角形（法線 y < −0.7・最低点 + 0.5 m 以内）の平面図面積の合計 [m²] */
function bottomPlanArea(tris: Float32Array): number {
  let minY = Infinity;
  for (let i = 1; i < tris.length; i += 3) minY = Math.min(minY, tris[i]);
  let area = 0;
  for (let t = 0; t < tris.length / 9; t++) {
    const o = t * 9;
    if (tris[o + 1] > minY + 0.5 || tris[o + 4] > minY + 0.5 || tris[o + 7] > minY + 0.5) continue;
    if (normalY(tris, t) >= -0.7) continue;
    const ux = tris[o + 3] - tris[o];
    const uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o];
    const vz = tris[o + 8] - tris[o + 2];
    area += Math.abs(ux * vz - uz * vx) / 2;
  }
  return area;
}

const footprintArea = (b: PlateauBuilding) => ringArea(b.ring) - b.holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0);

let draco: DracoDecoderLike;
const decoded = new Map<string, { b3dm: B3dm; tile: DecodedTile }>();
const load = async (name: string) => {
  const hit = decoded.get(name);
  if (hit) return hit;
  const b3dm = parseB3dm(fixture(name));
  const tile = await decodeTileGlb(b3dm.glb, draco);
  const v = { b3dm, tile };
  decoded.set(name, v);
  return v;
};

beforeAll(async () => {
  draco = await nodeDracoDecoder();
});

// ---------------------------------------------------------------------------
// 実 fixture
// ---------------------------------------------------------------------------

describe('readBuildingRecords（23113 data0）', () => {
  it('6 件。gml_id・_x/_y・_xmin.._zmax・_lod・measuredHeight・階数・用途・建物 ID・surveyYear を読む。null は null', () => {
    const { batchTable } = parseB3dm(fixture('23113_lod1_data0.b3dm'));
    const recs = readBuildingRecords(batchTable);
    expect(recs).toHaveLength(6);
    expect(recs.map((r) => r.batchId)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const r of recs) {
      expect(r.gmlId).toMatch(/^bldg_/);
      expect(r.lod).toBe(1);
      expect(r.x).toBeGreaterThan(137);
      expect(r.y).toBeGreaterThan(35);
      expect(r.xmin!).toBeLessThanOrEqual(r.x!);
      expect(r.xmax!).toBeGreaterThanOrEqual(r.x!);
      expect(r.ymin!).toBeLessThanOrEqual(r.y!);
      expect(r.ymax!).toBeGreaterThanOrEqual(r.y!);
      expect(r.zmax!).toBeGreaterThan(r.zmin!);
      expect(r.measuredHeight).toBeGreaterThan(0);
      expect(r.buildingId).toMatch(/^23100-bldg-/);
      expect(r.lod1HeightType).toBe('点群から取得_中央値');
      expect(r.surveyYear).toBe(2021);
      expect(r.address).toBeNull();
      expect(r.name).toBeNull();
      expect(r.storeysBelow).toBeNull();
    }
    // bldg:storeysAboveGround は [1,1,null,1,1,1]、bldg:usage の '不明'（3 棟目）は null にする
    expect(recs.map((r) => r.storeys)).toEqual([1, 1, null, 1, 1, 1]);
    expect(recs[2].usage).toBeNull();
    expect(recs[0].usage).toBe('文教厚生施設');
  });
});

describe('splitBuildings（23113 data0: 守山区 LOD1 の葉・6 棟）', () => {
  let res: SplitResult;
  let tile: DecodedTile;
  let b3dm: B3dm;
  beforeAll(async () => {
    ({ b3dm, tile } = await load('23113_lod1_data0.b3dm'));
    res = splitBuildings(tile, b3dm, META_23113);
  });

  it('6 棟すべて分割され、skipped は無い', () => {
    expect(res.buildings).toHaveLength(6);
    expect(res.skipped).toEqual([]);
    expect(res.buildings.map((b) => b.batchId).sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('compareWithRecord: extentErr < 0.01 m、zminErr/zmaxErr < 0.05 m、height = zmax − zmin ±0.01', () => {
    const recs = readBuildingRecords(b3dm.batchTable);
    for (const b of res.buildings) {
      const r = recs[b.batchId];
      const d = compareWithRecord(b, r);
      expect(d.extentErrM).toBeLessThan(0.01);
      expect(d.zminErrM).toBeLessThan(0.05);
      expect(d.zmaxErrM).toBeLessThan(0.05);
      expect(Math.abs(b.height - (r.zmax! - r.zmin!))).toBeLessThan(0.01);
      expect(b.attrs.zmin).toBe(r.zmin);
      expect(b.attrs.zmax).toBe(r.zmax);
      expect(b.gmlId).toBe(r.gmlId);
      expect(b.attrs.anchor).toEqual({ lat: r.y, lon: r.x });
    }
  });

  it('ring は閉じた反時計回りで、面積 = 底面三角形の面積 ±0.1 %、kind bottom 6/6・穴なし', () => {
    for (const b of res.buildings) {
      expect(b.ring.length).toBeGreaterThanOrEqual(3);
      // 末尾に先頭の重複を持たない（閉じるのは暗黙）
      const first = b.ring[0];
      const last = b.ring[b.ring.length - 1];
      expect(Math.hypot(first.e - last.e, first.n - last.n)).toBeGreaterThan(0.05);
      expect(ringArea(b.ring)).toBeGreaterThan(1);
      expect(b.attrs.footprint).toBe('bottom');
      expect(b.holes).toEqual([]);
      expect(b.attrs.warnings).toBeUndefined();
      const bottom = bottomPlanArea(b.mesh.tris);
      expect(bottom).toBeGreaterThan(1);
      expect(Math.abs(footprintArea(b) - bottom) / bottom).toBeLessThan(0.001);
    }
  });

  it('ring の頂点は _xmin.._ymax の矩形の内側（1 cm の余裕）', () => {
    const recs = readBuildingRecords(b3dm.batchTable);
    for (const b of res.buildings) {
      const r = recs[b.batchId];
      const { mLat, mLon } = metersPerDegree(b.attrs.anchor.lat);
      for (const p of b.ring) {
        const lon = b.attrs.anchor.lon + p.e / mLon;
        const lat = b.attrs.anchor.lat + p.n / mLat;
        expect(lon).toBeGreaterThanOrEqual(r.xmin! - 0.01 / mLon);
        expect(lon).toBeLessThanOrEqual(r.xmax! + 0.01 / mLon);
        expect(lat).toBeGreaterThanOrEqual(r.ymin! - 0.01 / mLat);
        expect(lat).toBeLessThanOrEqual(r.ymax! + 0.01 / mLat);
      }
    }
  });

  it('先頭 roofTriangles 個の法線 y ≥ 0.5、残りは < 0.5。足元 y=0、最高点 = height', () => {
    for (const b of res.buildings) {
      const { tris, roofTriangles } = b.mesh;
      const n = tris.length / 9;
      expect(roofTriangles).toBeGreaterThan(0);
      expect(roofTriangles).toBeLessThan(n);
      for (let t = 0; t < n; t++) {
        const ny = normalY(tris, t);
        if (t < roofTriangles) expect(ny).toBeGreaterThanOrEqual(0.5);
        else expect(ny).toBeLessThan(0.5);
      }
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 1; i < tris.length; i += 3) {
        minY = Math.min(minY, tris[i]);
        maxY = Math.max(maxY, tris[i]);
      }
      expect(minY).toBeCloseTo(0, 5);
      expect(maxY).toBeCloseTo(b.height, 1);
    }
  });

  it('三角形は batch をまたがず（タイルの三角形数の合計と一致）、頂点は共有しない（9 float / 三角形）', () => {
    const perBatch = new Map<number, number>();
    for (let t = 0; t < tile.index.length / 3; t++) {
      const b = tile.batchId[tile.index[t * 3]];
      expect(tile.batchId[tile.index[t * 3 + 1]]).toBe(b);
      expect(tile.batchId[tile.index[t * 3 + 2]]).toBe(b);
      perBatch.set(b, (perBatch.get(b) ?? 0) + 1);
    }
    let total = 0;
    for (const b of res.buildings) {
      expect(b.mesh.tris.length % 9).toBe(0);
      expect(b.mesh.tris.length / 9).toBe(perBatch.get(b.batchId));
      total += b.mesh.tris.length / 9;
    }
    expect(total).toBe(tile.index.length / 3);
  });

  it('ジオイド値（最低楕円体高 − _zmin）の中央値は 38.95 ± 0.05 m', () => {
    expect(res.geoidMedian).toBeCloseTo(38.95, 1);
    expect(Math.abs(res.geoidMedian - 38.95)).toBeLessThan(0.05);
  });

  it('属性: データセット由来（市区・年度・LOD）と記録由来（measuredHeight・階数・用途・建物 ID）', () => {
    const b = res.buildings.find((x) => x.batchId === 0)!;
    expect(b.attrs.muniCd).toBe('23113');
    expect(b.attrs.pref).toBe('愛知県');
    expect(b.attrs.city).toBe('名古屋市');
    expect(b.attrs.ward).toBe('守山区');
    expect(b.attrs.year).toBe(2022);
    expect(b.attrs.datasetLod).toBe(1);
    expect(b.attrs.lod).toBe(1);
    expect(b.attrs.measuredHeight).toBeCloseTo(17.2, 5);
    expect(b.attrs.storeys).toBe(1);
    expect(b.attrs.usage).toBe('文教厚生施設');
    expect(b.attrs.buildingId).toBe('23100-bldg-6298');
    expect(b.attrs.lod1HeightType).toBe('点群から取得_中央値');
    expect(b.attrs.surveyYear).toBe(2021);
    // 無い属性はキーごと無い（JSON に undefined を出さない）
    expect('address' in b.attrs).toBe(false);
    expect('name' in b.attrs).toBe(false);
    const noUsage = res.buildings.find((x) => x.batchId === 2)!;
    expect('usage' in noUsage.attrs).toBe(false);
    expect('storeys' in noUsage.attrs).toBe(false);
  });

  it('keep が false の batch は buildings に入らず skipped（kept）になり、分割も走らない', () => {
    const r2 = splitBuildings(tile, b3dm, META_23113, { keep: (r) => r.batchId % 2 === 0 });
    expect(r2.buildings.map((b) => b.batchId).sort()).toEqual([0, 2, 4]);
    expect(r2.skipped.filter((s) => s.reason === 'kept').map((s) => s.batchId).sort()).toEqual([1, 3, 5]);
    // 中央値は keep した棟だけで取る（葉タイルなので値は同じ）
    expect(Math.abs(r2.geoidMedian - res.geoidMedian)).toBeLessThan(0.05);
  });
});

describe('splitBuildings（内部ノードの content: 23102 data1・data55）', () => {
  it('data1（深さ 2・18 棟・底面なし）: 全棟 kind hull + warnings noBottom、ジオイド 38.30 で一定', async () => {
    const { b3dm, tile } = await load('23102_lod2nt_data1.b3dm');
    const res = splitBuildings(tile, b3dm, META_23102);
    expect(res.buildings.length + res.skipped.length).toBe(18);
    expect(res.buildings.length).toBeGreaterThanOrEqual(17);
    for (const b of res.buildings) {
      expect(b.attrs.footprint).toBe('hull');
      expect(b.attrs.warnings).toContain('noBottom');
      expect(b.attrs.warnings).not.toContain('baseMismatch');
      expect(ringArea(b.ring)).toBeGreaterThan(1);
      expect(b.attrs.datasetLod).toBe(2);
    }
    expect(Math.abs(res.geoidMedian - 38.3)).toBeLessThan(0.1);
  });

  it('data55（root・20 棟・簡略形状）: baseMismatch が付く棟があり、_lod 2 が 5 棟', async () => {
    const { b3dm, tile } = await load('23102_lod2nt_data55.b3dm');
    const recs = readBuildingRecords(b3dm.batchTable);
    expect(recs.filter((r) => r.lod === 2)).toHaveLength(5);
    const res = splitBuildings(tile, b3dm, META_23102);
    expect(res.buildings.length).toBeGreaterThan(10);
    const mismatched = res.buildings.filter((b) => b.attrs.warnings?.includes('baseMismatch'));
    expect(mismatched.length).toBeGreaterThan(0);
    // 中央値付近の棟には付かない（全部に付くわけではない）
    expect(mismatched.length).toBeLessThan(res.buildings.length);
    expect(res.buildings.filter((b) => b.attrs.lod === 2)).toHaveLength(5);
    // 底面が無いので全棟 hull
    for (const b of res.buildings) expect(b.attrs.footprint).toBe('hull');
  });
});

// ---------------------------------------------------------------------------
// 手作りの形
// ---------------------------------------------------------------------------

/** (e, n) の多角形（外周は反時計回り・穴は時計回り）から、上面（上向き）・底面（下向き）・壁の非インデックス三角形を作る（局所 x=e, y, z=−n） */
function prismTris(outer: EN[], holes: EN[][], h: number, base = 0): number[] {
  const contour = outer.map((p) => new THREE.Vector2(p.e, p.n));
  const holePaths = holes.map((hole) => hole.map((p) => new THREE.Vector2(p.e, p.n)));
  const all = [...contour, ...holePaths.flat()];
  const faces = THREE.ShapeUtils.triangulateShape(contour, holePaths);
  const out: number[] = [];
  const push = (p: THREE.Vector2, y: number) => out.push(p.x, y, -p.y);
  for (const [i, j, k] of faces) {
    const a = all[i];
    const b = all[j];
    const c = all[k];
    // (e, n) で反時計回りなら上向き。上面はそのまま、底面は巻きを逆に
    const ccw = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0;
    const [p, q, r] = ccw ? [a, b, c] : [a, c, b];
    push(p, base + h);
    push(q, base + h);
    push(r, base + h);
    push(p, base);
    push(r, base);
    push(q, base);
  }
  for (const ring of [outer, ...holes]) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      out.push(p.e, base, -p.n, q.e, base, -q.n, q.e, base + h, -q.n);
      out.push(p.e, base, -p.n, q.e, base + h, -q.n, p.e, base + h, -p.n);
    }
  }
  return out;
}

/** 列（配列）だけの BatchTable（splitBuildings に渡す手作りの b3dm 用） */
function fakeBatchTable(cols: Record<string, (number | string | null)[]>, batchLength: number): BatchTable {
  return {
    keys: Object.keys(cols),
    batchLength,
    numbers: (name) => {
      const c = cols[name];
      if (!c) return null;
      const out = new Float64Array(c.length);
      c.forEach((v, i) => (out[i] = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN));
      return out;
    },
    strings: (name) => (cols[name] ? cols[name].map((v) => (v == null ? null : String(v))) : null),
    raw: (name) => cols[name] ?? null,
  };
}

function fakeB3dm(cols: Record<string, (number | string | null)[]>, batchLength: number): B3dm {
  return { version: 1, byteLength: 0, batchLength, featureTable: { BATCH_LENGTH: batchLength }, batchTable: fakeBatchTable(cols, batchLength), glb: new ArrayBuffer(0), sizes: { ftJson: 0, ftBin: 0, btJson: 0, btBin: 0, glb: 0 } };
}

const ANCHOR = { lat: 35.6019, lon: 139.6736 };
/** タイル全体に共通のジオイド値（楕円体高 − 正標高） */
const GEOID = 38;

/**
 * 「anchor 基準の局所三角形（x=東, y=上, z=−北。y は足元 zmin からの高さ）」で与えた棟を、実データと同じ形の DecodedTile
 * （RTC 相対・glTF y-up）にする。tris は batch ごと
 */
function tileFromLocal(batches: { tris: number[]; zmin: number; geoid?: number }[], center = ANCHOR): DecodedTile {
  const C = geodeticToEcef(center.lat, center.lon, 0);
  const { mLat, mLon } = metersPerDegree(center.lat);
  const pos: number[] = [];
  const bid: number[] = [];
  batches.forEach((b, batchId) => {
    for (let i = 0; i < b.tris.length; i += 3) {
      const lon = center.lon + b.tris[i] / mLon;
      const lat = center.lat - b.tris[i + 2] / mLat;
      const h = b.zmin + (b.geoid ?? GEOID) + b.tris[i + 1];
      const [X, Y, Z] = geodeticToEcef(lat, lon, h);
      // ECEF = center + (x, −z, y) の逆: glTF (x, y, z) = (dX, dZ, −dY)
      pos.push(X - C[0], Z - C[2], -(Y - C[1]));
      bid.push(batchId);
    }
  });
  const n = pos.length / 3;
  return { positions: new Float32Array(pos), index: Uint32Array.from({ length: n }, (_, i) => i), batchId: Uint32Array.from(bid), rtcCenter: [C[0], C[1], C[2]] };
}

const square = (cx: number, cn: number, half: number): EN[] => [
  { e: cx - half, n: cn - half },
  { e: cx + half, n: cn - half },
  { e: cx + half, n: cn + half },
  { e: cx - half, n: cn + half },
];

describe('footprintFromBottomFaces・sortRoofFirst（手作りの形）', () => {
  // 外周 8 点（角を落とした 10 × 10）と中庭 2 × 2
  const outer8: EN[] = [
    { e: -5, n: -3 },
    { e: -3, n: -5 },
    { e: 3, n: -5 },
    { e: 5, n: -3 },
    { e: 5, n: 3 },
    { e: 3, n: 5 },
    { e: -3, n: 5 },
    { e: -5, n: 3 },
  ];
  const hole4: EN[] = [...square(0, 0, 1)].reverse();

  it('中庭付きの箱: 外周 8 点・穴 1（時計回り・4 点）・kind bottom・面積 = 底面の合計', () => {
    const tris = new Float32Array(prismTris(outer8, [hole4], 7));
    const fp = footprintFromBottomFaces(tris)!;
    expect(fp).not.toBeNull();
    expect(fp.kind).toBe('bottom');
    expect(fp.islands).toBe(0);
    expect(fp.outer).toHaveLength(8);
    expect(ringArea(fp.outer)).toBeCloseTo(100 - 8, 6);
    expect(fp.holes).toHaveLength(1);
    expect(fp.holes[0]).toHaveLength(4);
    expect(ringArea(fp.holes[0])).toBeCloseTo(-4, 6);
    expect(ringArea(fp.outer) + ringArea(fp.holes[0])).toBeCloseTo(bottomPlanArea(tris), 6);
  });

  it('離れた 2 棟分の底面（同じ batch）: kind hull・islands 1、外周は全底面頂点の凸包', () => {
    const tris = new Float32Array([...prismTris(square(-10, 0, 3), [], 6), ...prismTris(square(10, 0, 2), [], 4)]);
    const fp = footprintFromBottomFaces(tris)!;
    expect(fp.kind).toBe('hull');
    expect(fp.islands).toBe(1);
    expect(fp.holes).toEqual([]);
    // 凸包は両方の箱を含む（e −13..12、n −3..3）
    const es = fp.outer.map((p) => p.e);
    const ns = fp.outer.map((p) => p.n);
    expect(Math.min(...es)).toBeCloseTo(-13, 6);
    expect(Math.max(...es)).toBeCloseTo(12, 6);
    expect(Math.min(...ns)).toBeCloseTo(-3, 6);
    expect(Math.max(...ns)).toBeCloseTo(3, 6);
    expect(ringArea(fp.outer)).toBeGreaterThan(36 + 16);
  });

  it('底面が無い（上面と壁だけ）: 全頂点の凸包・kind hull・islands 0', () => {
    const full = prismTris(square(0, 0, 4), [], 5);
    // 底面（下向き）を取り除く: 各三角形の法線で判定
    const kept: number[] = [];
    const f = new Float32Array(full);
    for (let t = 0; t < f.length / 9; t++) if (normalY(f, t) >= -0.7) kept.push(...full.slice(t * 9, t * 9 + 9));
    const fp = footprintFromBottomFaces(new Float32Array(kept))!;
    expect(fp.kind).toBe('hull');
    expect(fp.islands).toBe(0);
    expect(ringArea(fp.outer)).toBeCloseTo(64, 6);
  });

  it('外周 < 1 m²（0.5 × 0.5 の箱）・三角形なしは null', () => {
    expect(footprintFromBottomFaces(new Float32Array(prismTris(square(0, 0, 0.25), [], 3)))).toBeNull();
    expect(footprintFromBottomFaces(new Float32Array(0))).toBeNull();
  });

  it('底面の判定は最低点 + bottomTolM 以内（1 m 上の下向き面は底面に入らない）', () => {
    const tris = new Float32Array([...prismTris(square(0, 0, 4), [], 5), ...prismTris(square(0, 0, 2), [], 3, 1)]);
    const fp = footprintFromBottomFaces(tris)!;
    expect(fp.kind).toBe('bottom');
    expect(ringArea(fp.outer)).toBeCloseTo(64, 6);
    // 許容を 2 m にすると 1 m 上の底面も入り、内側の辺は打ち消されずに「穴」の閉路になるのではなく重なるので外周は変わらない
    const fp2 = footprintFromBottomFaces(tris, { bottomTolM: 2 })!;
    expect(ringArea(fp2.outer)).toBeCloseTo(64, 6);
  });

  it('sortRoofFirst: 屋根（法線 y ≥ roofUpMin）が先頭に、枚数は roofTriangles。順序以外は変えない', () => {
    const tris = new Float32Array(prismTris(outer8, [hole4], 7));
    const m = sortRoofFirst(tris, 0.5);
    expect(m.tris.length).toBe(tris.length);
    // 上面の三角形数 = 底面の三角形数 = triangulateShape の数（8 点 + 穴 4 点 → 12 枚）
    expect(m.roofTriangles).toBe(12);
    for (let t = 0; t < m.tris.length / 9; t++) {
      const ny = normalY(m.tris, t);
      if (t < m.roofTriangles) expect(ny).toBeGreaterThanOrEqual(0.5);
      else expect(ny).toBeLessThan(0.5);
    }
    // 元の三角形の集合は保たれる（9 値ずつの文字列で比較）
    const key = (a: Float32Array, t: number) => Array.from(a.subarray(t * 9, t * 9 + 9)).map((v) => v.toFixed(3)).join(',');
    const before = new Set(Array.from({ length: tris.length / 9 }, (_, t) => key(tris, t)));
    for (let t = 0; t < m.tris.length / 9; t++) expect(before.has(key(m.tris, t))).toBe(true);
    // 片流れ（勾配 30° = 法線 y 0.87）は屋根、45° 超（法線 y 0.5 未満）は壁側
    const slope = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10 * Math.tan(Math.PI / 6), -10]);
    expect(sortRoofFirst(slope, 0.5).roofTriangles).toBe(1);
    const steep = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10 * Math.tan(Math.PI / 3), -10]);
    expect(sortRoofFirst(steep, 0.5).roofTriangles).toBe(0);
  });
});

describe('splitBuildings（手作りのタイル）', () => {
  it('中庭付きの箱 + 離れた 2 棟 + 小さすぎる箱: holes 1／islands／tooSmall、gml_id 無しは tileUrl#batchId', () => {
    const outer8: EN[] = square(0, 0, 5);
    const hole: EN[] = [...square(0, 0, 1)].reverse();
    const tile = tileFromLocal([
      { tris: prismTris(outer8, [hole], 7), zmin: 20 },
      { tris: [...prismTris(square(40, 0, 3), [], 6), ...prismTris(square(60, 0, 2), [], 4)], zmin: 21 },
      { tris: prismTris(square(-40, 0, 0.3), [], 3), zmin: 20 },
    ]);
    const b3dm = fakeB3dm(
      {
        gml_id: ['bldg_a', null, 'bldg_c'],
        _zmin: [20, 21, 20],
        _zmax: [27, 27, 23],
        _lod: [2, 1, 1],
        'bldg:measuredHeight': [7.5, null, 3],
        'bldg:usage': ['住宅', '不明', null],
      },
      3,
    );
    const res = splitBuildings(tile, b3dm, META_23113, { tileUrl: 'https://example.test/t/data9.b3dm' });
    expect(res.buildings).toHaveLength(2);
    expect(res.skipped).toEqual([{ batchId: 2, reason: 'tooSmall' }]);

    const a = res.buildings.find((b) => b.batchId === 0)!;
    expect(a.gmlId).toBe('bldg_a');
    expect(a.attrs.footprint).toBe('bottom');
    expect(a.holes).toHaveLength(1);
    expect(ringArea(a.ring)).toBeCloseTo(100, 3);
    expect(ringArea(a.holes[0])).toBeCloseTo(-4, 3);
    expect(a.height).toBe(7);
    expect(a.attrs.lod).toBe(2);
    expect(a.attrs.usage).toBe('住宅');
    expect(a.attrs.measuredHeight).toBe(7.5);
    expect(a.attrs.warnings).toBeUndefined();
    // _x/_y も矩形も無いので anchor は底面輪郭の重心 → 外周の重心は (0, 0)
    const c = a.ring.reduce((s, p) => ({ e: s.e + p.e / a.ring.length, n: s.n + p.n / a.ring.length }), { e: 0, n: 0 });
    expect(c.e).toBeCloseTo(0, 3);
    expect(c.n).toBeCloseTo(0, 3);
    expect(a.attrs.anchor.lat).toBeCloseTo(ANCHOR.lat, 6);
    expect(a.attrs.anchor.lon).toBeCloseTo(ANCHOR.lon, 6);
    // 局所座標の最低点は 0、屋根は 7
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < a.mesh.tris.length; i += 3) {
      minY = Math.min(minY, a.mesh.tris[i]);
      maxY = Math.max(maxY, a.mesh.tris[i]);
    }
    expect(minY).toBeCloseTo(0, 3);
    expect(maxY).toBeCloseTo(7, 3);

    const b = res.buildings.find((x) => x.batchId === 1)!;
    expect(b.gmlId).toBe('https://example.test/t/data9.b3dm#1');
    expect(b.attrs.footprint).toBe('hull');
    expect(b.attrs.warnings).toEqual(['islands']);
    expect(b.holes).toEqual([]);
    expect('usage' in b.attrs).toBe(false);
    // anchor は凸包（全底面頂点）の重心付近: 2 棟の間（e 37..62 の範囲内）
    const off = toLocal(b.attrs.anchor.lat, b.attrs.anchor.lon, ANCHOR.lat, ANCHOR.lon);
    expect(off.e).toBeGreaterThan(37);
    expect(off.e).toBeLessThan(62);
    expect(Math.abs(off.n)).toBeLessThan(0.01);
    // ジオイドは全棟 38 → 中央値 38、baseMismatch なし
    expect(res.geoidMedian).toBeCloseTo(GEOID, 2);
  });

  it('_x/_y があれば anchor はそれ（局所座標はそこからの差）。_xmin.._ymax だけならその中心', () => {
    const { mLat, mLon } = metersPerDegree(ANCHOR.lat);
    const tile = tileFromLocal([
      { tris: prismTris(square(10, 20, 4), [], 5), zmin: 10 },
      { tris: prismTris(square(-10, -20, 4), [], 5), zmin: 10 },
    ]);
    const b3dm = fakeB3dm(
      {
        gml_id: ['x', 'y'],
        _x: [ANCHOR.lon + 10 / mLon, null],
        _y: [ANCHOR.lat + 20 / mLat, null],
        _xmin: [null, ANCHOR.lon + -14 / mLon],
        _xmax: [null, ANCHOR.lon + -6 / mLon],
        _ymin: [null, ANCHOR.lat + -24 / mLat],
        _ymax: [null, ANCHOR.lat + -16 / mLat],
        _zmin: [10, 10],
        _zmax: [15, 15],
      },
      2,
    );
    const res = splitBuildings(tile, b3dm, META_23113);
    expect(res.buildings).toHaveLength(2);
    for (const b of res.buildings) {
      const off = toLocal(b.attrs.anchor.lat, b.attrs.anchor.lon, ANCHOR.lat, ANCHOR.lon);
      expect(off.e).toBeCloseTo(b.batchId === 0 ? 10 : -10, 3);
      expect(off.n).toBeCloseTo(b.batchId === 0 ? 20 : -20, 3);
      // 箱は anchor を中心にした ±4 m
      for (const p of b.ring) {
        expect(Math.abs(p.e)).toBeCloseTo(4, 2);
        expect(Math.abs(p.n)).toBeCloseTo(4, 2);
      }
      const d = compareWithRecord(b, readBuildingRecords(b3dm.batchTable)[b.batchId]);
      if (b.batchId === 1) expect(d.extentErrM).toBeLessThan(0.01);
      else expect(Number.isNaN(d.extentErrM)).toBe(true);
      expect(d.zmaxErrM).toBeLessThan(0.01);
    }
  });

  it('ジオイドが中央値から 0.5 m 超ずれる棟に baseMismatch。_zmin が無い棟は中央値で正標高にする', () => {
    const tile = tileFromLocal([
      { tris: prismTris(square(0, 0, 3), [], 5), zmin: 10 },
      { tris: prismTris(square(20, 0, 3), [], 5), zmin: 10 },
      { tris: prismTris(square(40, 0, 3), [], 5), zmin: 10, geoid: GEOID + 3 },
      { tris: prismTris(square(60, 0, 3), [], 5), zmin: 12 },
    ]);
    const b3dm = fakeB3dm({ gml_id: ['a', 'b', 'c', 'd'], _zmin: [10, 10, 10, null], _zmax: [15, 15, 15, null] }, 4);
    const res = splitBuildings(tile, b3dm, META_23113);
    expect(res.buildings).toHaveLength(4);
    expect(res.geoidMedian).toBeCloseTo(GEOID, 2);
    const warn = (id: number) => res.buildings.find((b) => b.batchId === id)!.attrs.warnings;
    expect(warn(0)).toBeUndefined();
    expect(warn(1)).toBeUndefined();
    expect(warn(2)).toEqual(['baseMismatch']);
    const d = res.buildings.find((b) => b.batchId === 3)!;
    expect(d.attrs.zmin).toBeCloseTo(12, 2);
    expect(d.attrs.zmax).toBeCloseTo(17, 2);
    expect(d.height).toBeCloseTo(5, 2);
    // 許容を広げれば付かない
    expect(splitBuildings(tile, b3dm, META_23113, { geoidMismatchM: 5 }).buildings.find((b) => b.batchId === 2)!.attrs.warnings).toBeUndefined();
  });

  it('三角形の無い batch は skipped（noTriangles）。keep は記録を見て判定できる', () => {
    const tile = tileFromLocal([{ tris: prismTris(square(0, 0, 3), [], 5), zmin: 10 }]);
    const b3dm = fakeB3dm({ gml_id: ['a', 'b'], _zmin: [10, 10], _zmax: [15, 15], 'bldg:usage': ['住宅', '店舗'] }, 2);
    const res = splitBuildings(tile, b3dm, META_23113);
    expect(res.buildings.map((b) => b.gmlId)).toEqual(['a']);
    expect(res.skipped).toEqual([{ batchId: 1, reason: 'noTriangles' }]);
    const res2 = splitBuildings(tile, b3dm, META_23113, { keep: (r) => r.usage !== '住宅' });
    expect(res2.buildings).toEqual([]);
    expect(res2.skipped).toEqual(expect.arrayContaining([{ batchId: 0, reason: 'kept' }]));
    expect(Number.isNaN(res2.geoidMedian)).toBe(true);
  });
});
