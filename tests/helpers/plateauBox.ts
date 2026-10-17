/**
 * テスト用: PLATEAU の建物（PlateauBuilding）を手作りの箱で作る。anchor 基準・右手系（x=東, y=上, z=−北）、y=0 = 足元。
 * 三角形は 12（屋根 2 を先頭に、底面 2、壁 8）。法線は外向き（屋根 +y・底面 −y・壁は各面の外）。
 * plateauNeighborAt はそれをピン基準の Neighbor（src/sunstudy/plateauNeighbors.ts の plateauToNeighbor）にしたもの。
 */
import type { EN, LatLon, NeighborMesh, PlateauAttrs, PlateauBuilding } from '../../src/sun/plateau';
import { plateauToNeighbor } from '../../src/sunstudy/plateauNeighbors';
import { frameFromLocal } from '../../src/sunstudy/types';
import type { Neighbor } from '../../src/sunstudy/types';

/** 幅 w（東西）・奥行 d（南北）・高さ h の箱（anchor = 足元の中心） */
export function boxMesh(w: number, d: number, h: number): NeighborMesh {
  const x0 = -w / 2;
  const x1 = w / 2;
  const z0 = -d / 2;
  const z1 = d / 2;
  const t: number[][] = [
    // 屋根（+y）
    [x0, h, z0, x0, h, z1, x1, h, z1],
    [x0, h, z0, x1, h, z1, x1, h, z0],
    // 底面（−y）
    [x0, 0, z0, x1, 0, z1, x0, 0, z1],
    [x0, 0, z0, x1, 0, z0, x1, 0, z1],
    // 南（+z）
    [x0, 0, z1, x1, 0, z1, x1, h, z1],
    [x0, 0, z1, x1, h, z1, x0, h, z1],
    // 北（−z）
    [x1, 0, z0, x0, 0, z0, x0, h, z0],
    [x1, 0, z0, x0, h, z0, x1, h, z0],
    // 東（+x）
    [x1, 0, z1, x1, 0, z0, x1, h, z0],
    [x1, 0, z1, x1, h, z0, x1, h, z1],
    // 西（−x）
    [x0, 0, z0, x0, 0, z1, x0, h, z1],
    [x0, 0, z0, x0, h, z1, x0, h, z0],
  ];
  return { tris: Float32Array.from(t.flat()), roofTriangles: 2 };
}

/** 箱の足元（anchor 基準の東・北。反時計回り） */
export function boxRing(w: number, d: number): EN[] {
  return [
    { e: -w / 2, n: -d / 2 },
    { e: w / 2, n: -d / 2 },
    { e: w / 2, n: d / 2 },
    { e: -w / 2, n: d / 2 },
  ];
}

export interface PlateauBoxOptions {
  gmlId?: string;
  anchor: LatLon;
  w?: number;
  d?: number;
  h?: number;
  /** 足元の正標高 T.P. [m]（zmax = zmin + h） */
  zmin?: number;
  attrs?: Partial<PlateauAttrs>;
  holes?: EN[][];
}

export function plateauBox(o: PlateauBoxOptions): PlateauBuilding {
  const w = o.w ?? 10;
  const d = o.d ?? 10;
  const h = o.h ?? 7;
  const zmin = o.zmin ?? 57.2;
  const gmlId = o.gmlId ?? 'bldg_test';
  const attrs: PlateauAttrs = {
    gmlId,
    lod: 1,
    datasetLod: 1,
    year: 2022,
    muniCd: '23113',
    pref: '愛知県',
    city: '名古屋市',
    ward: '守山区',
    anchor: { ...o.anchor },
    zmin,
    zmax: zmin + h,
    footprint: 'bottom',
    ...o.attrs,
  };
  return { gmlId, batchId: 0, attrs, ring: boxRing(w, d), holes: o.holes ?? [], height: h, mesh: boxMesh(w, d, h) };
}

/** ピンから東 e・北 n (m) に足元の中心（anchor）がある箱の建物を、ピン基準の Neighbor にして返す */
export function plateauNeighborAt(pin: LatLon, e: number, n: number, o: Omit<PlateauBoxOptions, 'anchor'> = {}): Neighbor {
  return plateauToNeighbor(plateauBox({ ...o, anchor: frameFromLocal(pin, e, n) }), pin);
}
