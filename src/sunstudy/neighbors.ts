/**
 * 周辺建物: PLATEAU（実測の高さ）→ 国土地理院（種類から推定）→ OSM の順に取得・統合し、地形に接地した押し出しメッシュを作る
 *
 * PLATEAU LOD2 MVT: https://indigo-lab.github.io/plateau-lod2-mvt/{z}/{x}/{y}.pbf （z=16、layer 'bldg'、属性 z = 建物高さ measuredHeight [m]。範囲外は 404）
 * 国土地理院: 既存 fetchGsiBuildings（src/sun/geo.ts）。OSM: 既存 fetchOsmBuildings。
 *
 * ★ スタブ: 実装は担当エージェントが行う。シグネチャは変えないこと。
 */
import * as THREE from 'three';
import type { AerialImage, Neighbor, NeighborSource } from './types';

export interface FetchNeighborsResult {
  list: Neighbor[];
  sourcesUsed: NeighborSource[];
  /** 利用者向けの注記（例: 「この地域は PLATEAU の対象外のため、高さは建物の種類から推定しています」） */
  notes: string[];
}

/**
 * ピン位置から半径 radiusM の建物を取得。PLATEAU で取れた範囲は PLATEAU を使い、
 * PLATEAU に無い建物（重ならないもの）だけ国土地理院で補う。両方失敗なら OSM。すべて失敗なら throw。
 * id は出典とリング座標から決定的に作る（再取得しても同じ建物が同じ id になるように。上書き設定の保持のため）。
 */
export async function fetchNeighbors(_lat: number, _lon: number, _radiusM: number, _opts: { signal?: AbortSignal; onProgress?: (msg: string) => void; sources?: NeighborSource[] } = {}): Promise<FetchNeighborsResult> {
  throw new Error('not implemented');
}

/** 多角形（e/n）のいずれかと重なる建物を除く（敷地内の既存建物・建て替え前の家など） */
export function excludeOverlapping(_list: Neighbor[], _polygons: { e: number; n: number }[][]): Neighbor[] {
  throw new Error('not implemented');
}

/** 手動の隣家（方位 deg・距離 m・幅・奥行・高さ） */
export function makeManualNeighbor(_dirDeg: number, _distance: number, _width: number, _depth: number, _height: number): Neighbor {
  throw new Error('not implemented');
}

/**
 * 押し出しメッシュを作る。足元は groundY(e, n)（ワールド y。地形の最低点）、上面は 足元 + height。
 * 屋上に航空写真を貼る（aerial があれば）。壁は明るいグレー、手動は薄い茶。
 * 各 Mesh の userData: { neighborId, neighbor: true }。castShadow / receiveShadow。
 */
export function buildNeighborMeshes(_list: Neighbor[], _opts: { groundY: (e: number, n: number) => number; aerial?: AerialImage | null }): THREE.Group {
  throw new Error('not implemented');
}

/** リングの中心（e/n） */
export function ringCenter(_ring: { e: number; n: number }[]): { e: number; n: number } {
  throw new Error('not implemented');
}
