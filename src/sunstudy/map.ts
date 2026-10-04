/**
 * 場所を選ぶ 2D 地図（Canvas のスリッピーマップ。国土地理院タイル）
 *  - タイル: std（標準地図）/ pale（淡色地図）/ seamlessphoto（航空写真, z<=18）
 *  - ドラッグでパン、ホイール・ボタンでズーム（z 5..18）、クリックでピン、ピンのドラッグ
 *  - 敷地の輪郭を描くモード（クリックで頂点追加、最初の頂点か「完了」で閉じる、頂点のドラッグ、右クリック/Backspace で最後の頂点を消す）
 *  - 建物の足跡（e/n）・周辺建物の輪郭・解析半径の円・スケールバー・方位（北が上）・出典の表示
 *
 * ★ スタブ: 実装は担当エージェントが行う。シグネチャは変えないこと。
 */
import type { LatLon } from './types';

export type MapLayer = 'std' | 'pale' | 'photo';

export const MAP_LAYER_LABEL: Record<MapLayer, string> = { std: '標準地図', pale: '淡色地図', photo: '航空写真' };

export interface MapPickerOptions {
  initial: LatLon;
  zoom?: number;
  layer?: MapLayer;
  /** ピンが置かれた・動いた */
  onPin?: (p: LatLon) => void;
  /** 敷地ポリゴンが変わった（頂点追加・移動・削除・クリア） */
  onPolygonChange?: (poly: LatLon[], closed: boolean) => void;
  /** 表示範囲が変わった（ズーム・中心） */
  onView?: (center: LatLon, zoom: number) => void;
}

export class MapPicker {
  readonly canvas!: HTMLCanvasElement;

  constructor(_container: HTMLElement, _opts: MapPickerOptions) {
    throw new Error('not implemented');
  }

  get layer(): MapLayer {
    throw new Error('not implemented');
  }
  setLayer(_l: MapLayer): void {
    throw new Error('not implemented');
  }

  get zoom(): number {
    throw new Error('not implemented');
  }
  get center(): LatLon {
    throw new Error('not implemented');
  }
  setCenter(_p: LatLon, _zoom?: number): void {
    throw new Error('not implemented');
  }
  zoomBy(_delta: number): void {
    throw new Error('not implemented');
  }

  get pin(): LatLon | null {
    throw new Error('not implemented');
  }
  /** ピンを置く（center=true なら地図も移動） */
  setPin(_p: LatLon, _center = true): void {
    throw new Error('not implemented');
  }

  /** 敷地の輪郭を描くモード */
  get polygonMode(): boolean {
    throw new Error('not implemented');
  }
  setPolygonMode(_on: boolean): void {
    throw new Error('not implemented');
  }
  get polygon(): LatLon[] {
    throw new Error('not implemented');
  }
  setPolygon(_poly: LatLon[]): void {
    throw new Error('not implemented');
  }
  clearPolygon(): void {
    throw new Error('not implemented');
  }
  /** 描いている輪郭を閉じる（3 点以上） */
  finishPolygon(): void {
    throw new Error('not implemented');
  }

  /** 建物の足跡（ピンからの東・北 m の多角形）を表示。null で消す */
  setFootprint(_fp: { e: number; n: number }[] | null): void {
    throw new Error('not implemented');
  }
  /** 周辺建物の輪郭（ピンからの東・北 m）を薄く表示 */
  setNeighborRings(_rings: { e: number; n: number }[][] | null): void {
    throw new Error('not implemented');
  }
  /** 解析範囲の円（半径 m）。null で消す */
  setRadiusRing(_m: number | null): void {
    throw new Error('not implemented');
  }

  /** 出典の文字列（現在のレイヤー） */
  get attribution(): string {
    throw new Error('not implemented');
  }

  resize(): void {
    throw new Error('not implemented');
  }
  /** 現在の表示を画像に（レポート用） */
  snapshot(): string {
    throw new Error('not implemented');
  }
  dispose(): void {
    throw new Error('not implemented');
  }
}

/** 緯度でのメートル／画素（Web メルカトル, タイル 256px） */
export function metersPerPixel(_lat: number, _zoom: number): number {
  throw new Error('not implemented');
}

/** 多角形（緯度経度）の面積 (㎡)。局所平面で計算 */
export function polygonAreaM2(_poly: LatLon[]): number {
  throw new Error('not implemented');
}
