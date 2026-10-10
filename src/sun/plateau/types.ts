/**
 * PLATEAU 3D Tiles（国土交通省 3D都市モデル）連携の共有の型（three 非依存）。
 *
 * 座標の約束:
 *  - 建物の局所座標は右手系 x=東, y=上, z=−北 [m]。原点 = その建物の anchor（経緯度）、y=0 = その建物の足元（_zmin）。
 *  - ring / holes は anchor 基準の東・北 (m)。ピン（日照ツール）や建物中心（プレゼン）基準への平行移動は呼び出し側が足す。
 *  - 高さは正標高 T.P. [m]（_zmin/_zmax）。頂点は楕円体高なので、葉タイル内で一定の「ジオイド値」を引いて足元 0 にする。
 *
 * 仕様: scratchpad/plateau-spec.md §2.1（W0 で凍結。変えるときは全担当に周知する）
 */

/** 東・北 (m)（src/sun/align.ts の EN と同じ形） */
export interface EN {
  e: number;
  n: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * 建物 1 棟の非インデックス三角形（9 float / 三角形）。x=東, y=上, z=−北 [m]。原点 = anchor（経緯度）、y=0 = その建物の足元（_zmin）。
 * 先頭 roofTriangles 個が屋根（幾何法線の y ≥ 0.5）、残りが壁・底面。法線・index・uv は持たない（頂点共有なし: 実測 1.00）
 */
export interface NeighborMesh {
  tris: Float32Array;
  roofTriangles: number;
}

/** 足元輪郭の求め方: 底面三角形の境界辺（bottom）／底面が無い・島があるので全頂点の凸包に退避（hull） */
export type FootprintKind = 'bottom' | 'hull';

/** PLATEAU の建物属性（保存される。クリック情報・開示・上書きの引き継ぎに使う） */
export interface PlateauAttrs {
  gmlId: string;
  /** batchTable の _lod（無ければ null） */
  lod: 1 | 2 | 3 | 4 | null;
  /** データセットの LOD（カタログ） */
  datasetLod: number;
  year: number;
  muniCd: string;
  pref: string;
  city: string;
  ward: string | null;
  /** _x/_y（無ければ _xmin.._ymax の中心、それも無ければ底面輪郭の重心） */
  anchor: LatLon;
  /** 正標高 T.P. [m] */
  zmin: number;
  zmax: number;
  measuredHeight?: number;
  storeys?: number;
  storeysBelow?: number;
  usage?: string;
  name?: string;
  address?: string;
  buildingId?: string;
  lod1HeightType?: string;
  surveyYear?: number;
  footprint: FootprintKind;
  warnings?: ('noBottom' | 'baseMismatch' | 'islands')[];
}

/**
 * 分割済みの建物 1 棟。ring/holes は anchor 基準 [m]（ピン基準への平行移動は呼び出し側）。
 * height = zmax − zmin（小数 1 桁に丸めない。丸めは Neighbor 化で）
 */
export interface PlateauBuilding {
  gmlId: string;
  batchId: number;
  attrs: PlateauAttrs;
  ring: EN[];
  holes: EN[][];
  height: number;
  mesh: NeighborMesh;
}

/** 使ったデータセット（市区ごとに 1 件。出典行の再現のため保存する） */
export interface PlateauDatasetInfo {
  muniCd: string;
  pref: string;
  city: string;
  ward: string | null;
  year: number;
  lod: number;
  tex: boolean;
  tilesetUrl: string;
  /** 「東京都世田谷区・2025年度・LOD2」 */
  label: string;
}

/** 度の矩形 */
export interface GeoBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** 3D Tiles の boundingVolume.region（ラジアン・m） */
export interface TileRegion {
  west: number;
  south: number;
  east: number;
  north: number;
  minH: number;
  maxH: number;
}

/** 復号した葉タイル 1 枚（建物に分ける前） */
export interface DecodedTile {
  /** glTF y-up, RTC 相対, node 行列適用済み */
  positions: Float32Array;
  index: Uint32Array;
  /** 頂点ごと */
  batchId: Uint32Array;
  rtcCenter: [number, number, number];
}

/** three の DRACOLoader と同じ形（Node のテストでは tests/helpers/nodeDraco.ts が同じ形を作る） */
export interface DracoDecoderLike {
  preload(): unknown;
  decodeDracoFile(
    buffer: ArrayBuffer,
    onLoad: (geometry: import('three').BufferGeometry) => void,
    attributeIDs: Record<string, number>,
    attributeTypes: Record<string, string>,
    vertexColorSpace?: unknown,
    onError?: (e: unknown) => void,
  ): unknown;
}

/** 保存形のメッシュ（Int16 cm × 3 × 3 × 三角形数 を base64） */
export interface QuantizedMesh {
  v: 1;
  q: 100;
  posB64: string;
  roofTriangles: number;
}

export type PlateauStage = 'geocode' | 'index' | 'tileset' | 'tiles' | 'decode' | 'merge';

export interface PlateauProgress {
  stage: PlateauStage;
  message: string;
  done: number;
  total: number;
  bytes: number;
  totalBytes: number | null;
  ratio: number;
}
