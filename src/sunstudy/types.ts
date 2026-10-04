/**
 * 日照シミュレーション（3D データ読み込み版）の共有の型と座標系
 *
 * ワールド座標系: X = 東, Z = 南（-Z = 北）, Y = 上 [m]
 *   原点 = 地図で指定したピン位置、Y = 0 = ピン位置の地盤高（DEM）
 *   太陽方向は src/sun/solar.ts の sunDirectionWorld(az, elev, 0) で得る（northAngleDeg = 0）
 */
import * as THREE from 'three';
import { metersPerDegree } from '../sun/geo';
import type { AerialImage } from '../sun/geo';

export type { AerialImage };

export interface LatLon {
  lat: number;
  lon: number;
}

/** 地理座標の基準（ピン位置） */
export interface GeoFrame extends LatLon {
  address: string;
  /** ピン位置の地盤高（T.P. m）。DEM 取得前は null */
  groundElev: number | null;
}

/** 緯度経度 → 基準点からの東・北 (m) */
export function frameToLocal(f: LatLon, p: LatLon): { e: number; n: number } {
  const { mLat, mLon } = metersPerDegree(f.lat);
  return { e: (p.lon - f.lon) * mLon, n: (p.lat - f.lat) * mLat };
}

/** 基準点からの東・北 (m) → 緯度経度 */
export function frameFromLocal(f: LatLon, e: number, n: number): LatLon {
  const { mLat, mLon } = metersPerDegree(f.lat);
  return { lat: f.lat + n / mLat, lon: f.lon + e / mLon };
}

/** 東・北 (m) → ワールド (x = e, z = -n) */
export function enToWorld(e: number, n: number, y = 0): THREE.Vector3 {
  return new THREE.Vector3(e, y, -n);
}

/** ワールド → 東・北 (m) */
export function worldToEN(p: { x: number; z: number }): { e: number; n: number } {
  return { e: p.x, n: -p.z };
}

/** 方位角（真北から時計回り, 度）→ 水平の単位ベクトル（ワールド） */
export function bearingToWorld(deg: number): THREE.Vector3 {
  const a = (deg * Math.PI) / 180;
  return new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
}

/** 水平ベクトル（ワールド）→ 方位角（真北から時計回り, 度 0..360） */
export function worldToBearing(v: { x: number; z: number }): number {
  return ((Math.atan2(v.x, -v.z) * 180) / Math.PI + 360) % 360;
}

export const DIR_NAMES = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
export function bearingName(deg: number): string {
  return DIR_NAMES[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

// ---------------------------------------------------------------------------
// 地形
// ---------------------------------------------------------------------------

/** 標高の格子（ピン位置を基準にした東・北 m の範囲、行 0 = 北） */
export interface HeightGrid {
  west: number;
  east: number;
  south: number;
  north: number;
  nx: number;
  ny: number;
  /** 標高 T.P. [m]。無効値は NaN。index = row * nx + col、row 0 = 北端 */
  values: Float32Array;
  /** 出典 'dem1a' | 'dem5a' | 'dem5b' | 'dem5c' | 'dem10b' | 'flat' */
  source: string;
  /** 解像度の目安 (m) */
  resolution: number;
}

// ---------------------------------------------------------------------------
// 建物（読み込んだ 3D データ）
// ---------------------------------------------------------------------------

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'custom';
export type UpAxis = 'z' | 'y';
export type ModelFormat = '3ds' | 'obj' | 'stl' | 'glb' | 'fbx';

export const UNIT_METERS: Record<Exclude<LengthUnit, 'custom'>, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 };
export const UNIT_LABEL: Record<LengthUnit, string> = { mm: 'ミリメートル (mm)', cm: 'センチメートル (cm)', m: 'メートル (m)', in: 'インチ (in)', ft: 'フィート (ft)', custom: '任意の倍率' };

/** 東・北 (m) の 2D 座標（src/sun/align.ts の EN と同じ形） */
export interface EN {
  e: number;
  n: number;
}

/** 位置合わせの種類: 2 点合わせ／敷地の輪郭に合わせた／向きだけ敷地の辺に合わせた。無ければ手で置いた配置 */
export type AlignmentKind = 'twoPoint' | 'siteFit' | 'orient';

/** 2 点合わせの対応: 建物の角（pivot ローカル EN, m）と、その角の実際の位置（緯度経度） */
export interface AlignmentPair {
  local: EN;
  target: LatLon;
}

/**
 * どう位置合わせしたか（配置と一緒に保存する）。
 * pairs の local は「採ったときの単位・上方向・反転」での pivot ローカル座標なので、
 * unitScaleM / mirror / upAxis を一緒に残し、単位が変わったら unitScale(今) / unitScaleM で換算する
 * （反転・上方向が変わったら対応点は使えないので位置合わせをやり直す）。
 * pivotLatLon は建物の基準点（pivot）の緯度経度。ピンが動いても建物を地球上の同じ所に保つために使う。
 */
export interface PlacementAlignment {
  kind?: AlignmentKind;
  pairs?: AlignmentPair[];
  /** pairs を採ったときの 1 モデル単位の長さ (m) */
  unitScaleM?: number;
  mirror?: boolean;
  upAxis?: UpAxis;
  /** 残差の RMS (m) */
  rmsM?: number;
  /**
   * 計測した大きさの比。2 点合わせ: 航空写真上の距離 / モデル上の距離（1 から 3 % 以上ずれていれば単位を疑う）。
   * 敷地の輪郭に合わせた: 描いた輪郭の周長 / 3DS の敷地の周長（0.5〜2 を外れると単位違いとみなし、向きと中心だけ合わせる）
   */
  scaleRatio?: number;
  pivotLatLon?: LatLon;
  /** ISO 日時 */
  at: string;
}

export interface ModelPlacement {
  unit: LengthUnit;
  /** unit === 'custom' のとき、1 モデル単位 = customScale m */
  customScale: number;
  /** 元データの上方向。3DS（3ds Max）は Z-up が既定 */
  upAxis: UpAxis;
  /** モデル平面の「上」（Z-up なら +Y、変換後は -Z）が向く方位。真北から時計回り (度) */
  headingDeg: number;
  /** モデル底面の中心を、ピンから東・北へずらす量 (m) */
  offsetE: number;
  offsetN: number;
  /** 底面の高さ（ピン位置の地盤高 GL = 0 からの m） */
  baseY: number;
  /** 表示: 白モデル / 元データの色 */
  appearance: 'white' | 'original';
  /** 左右反転（鏡像で保存されたデータ向け） */
  mirror: boolean;
  /** 表示・解析から除くオブジェクト名（地面の板・敷地・ダミーなど。読み込み時に自動判定し、UI で変更できる） */
  hiddenObjects: string[];
  /** 位置合わせの記録（任意。無ければ手で置いた配置）。古い保存データには無い */
  alignment?: PlacementAlignment;
}

export const DEFAULT_PLACEMENT: ModelPlacement = { unit: 'mm', customScale: 1, upAxis: 'z', headingDeg: 0, offsetE: 0, offsetN: 0, baseY: 0, appearance: 'white', mirror: false, hiddenObjects: [] };

/** 読み込んだデータ内のオブジェクト（単位推定・中心合わせから地面の板などを除くため） */
export interface ModelObjectInfo {
  name: string;
  triangles: number;
  /** 元の単位での大きさ（元の軸のまま: x, y, z） */
  size: [number, number, number];
  /** 建物以外（地面・敷地・ダミーなど）と自動判定した */
  autoHidden: boolean;
  reason?: string;
}

export interface ImportedModel {
  name: string;
  format: ModelFormat;
  /** 元データ（プロジェクト保存用） */
  data: ArrayBuffer;
  /** 読み込んだままの Object3D（単位・上軸は未変換。TDSLoader の MASTER_SCALE は group.scale に入っている） */
  raw: THREE.Object3D;
  /** raw のワールド bbox（元の単位。autoHidden のオブジェクトを除く） */
  rawBox: THREE.Box3;
  triangles: number;
  /** オブジェクトの一覧（名前ごと） */
  objects: ModelObjectInfo[];
  /** 寸法から推定した単位 */
  guessedUnit: LengthUnit;
  /** 推定した上方向 */
  guessedUp: UpAxis;
  /** 読み込み時の注意（テクスチャ無し等） */
  notes: string[];
}

// ---------------------------------------------------------------------------
// 周辺建物
// ---------------------------------------------------------------------------

export type NeighborSource = 'plateau' | 'gsi' | 'osm' | 'manual';

export interface Neighbor {
  id: string;
  /** 外周リング（ピンからの東・北 m） */
  ring: { e: number; n: number }[];
  /** 地上からの高さ (m) */
  height: number;
  source: NeighborSource;
  /** 高さの根拠: 実測（PLATEAU・OSM の height）/ 推定（建物種類・階数）/ 手入力 */
  heightKind: 'measured' | 'estimated' | 'manual';
  label?: string;
  /** 足元の地盤高（T.P. m）。地形から決める */
  baseElev?: number;
  hidden?: boolean;
}

export const NEIGHBOR_SOURCE_LABEL: Record<NeighborSource, string> = {
  plateau: 'PLATEAU（国土交通省 3D都市モデル・実測の高さ）',
  gsi: '国土地理院 地図データ（建物の種類から高さを推定）',
  osm: 'OpenStreetMap',
  manual: '手動で追加',
};

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** 測定点（窓の中心など。クリックで置く） */
export interface MeasurePoint {
  id: string;
  label: string;
  /** ワールド座標 */
  pos: [number, number, number];
  /** 面の法線（外向き）。地面なら上向き */
  normal: [number, number, number];
  /** 季節ごとの結果（解析後） */
  results?: MeasureResult[];
}

export interface MeasureResult {
  dateId: string;
  dateLabel: string;
  month: number;
  day: number;
  /** 直射日光が当たる時間の合計 (h) */
  hours: number;
  first: number | null;
  last: number | null;
  /** 日が当たる時間帯（連続区間） */
  spans: [number, number][];
}

/** 日付の指定（解析用） */
export interface StudyDate {
  id: string;
  label: string;
  year: number;
  month: number;
  day: number;
}

// ---------------------------------------------------------------------------
// プロジェクト保存
// ---------------------------------------------------------------------------

export interface ProjectJson {
  version: 1;
  app: 'sunstudy';
  savedAt: string;
  name: string;
  customer: string;
  company: string;
  frame: GeoFrame | null;
  sitePolygon: LatLon[];
  placement: ModelPlacement;
  /** 3D データ（base64）。大きすぎる場合は省略され、再読み込みを促す */
  model: { name: string; format: ModelFormat; base64: string } | null;
  manualNeighbors: Neighbor[];
  /** 自動取得した建物への上書き（高さ修正・非表示） */
  neighborOverrides: Record<string, { height?: number; hidden?: boolean }>;
  points: MeasurePoint[];
  /** 取得済みの周辺環境（オフラインでも開けるように同梱。省略可） */
  env?: ProjectEnv;
}

/** プロジェクトに同梱する周辺環境 */
export interface ProjectEnv {
  fetchedAt: string;
  /** 標高格子。values は cm 単位の Int16（無効値は -32768）を base64 にしたもの */
  grid: { west: number; east: number; south: number; north: number; nx: number; ny: number; source: string; resolution: number; valuesB64: string } | null;
  /** 航空写真（JPEG dataURL、長辺 2048px 以下）と範囲 */
  aerial: { dataUrl: string; west: number; east: number; south: number; north: number; attribution: string } | null;
  /** 自動取得した周辺建物 */
  neighbors: Neighbor[];
  neighborSources: NeighborSource[];
  neighborNotes: string[];
  /** 遠方の地形による地平線（方位 1° ごとの高度角） */
  horizon?: { elevDeg: number[]; source: string; radiusKm: number } | null;
}
