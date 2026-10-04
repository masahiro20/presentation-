/**
 * 日照解析（3D データ読み込み版）
 *  - 地面の日照時間マップ、建物の面の日照時間、測定点の日照時間（季節別）、日影図
 *  - 影を落とす物体: 地形・周辺建物・読み込んだ建物（BVH レイキャスト）
 *  - 太陽方向は sunDirectionWorld(az, elev, 0)
 *
 * 汎用のコア（格子の日照時間・日影図の描画・BVH 作成）は src/sun/analysis.ts に置き、ここから呼ぶ。
 *
 * ★ スタブ: 実装は担当エージェントが行う。シグネチャは変えないこと。
 */
import * as THREE from 'three';
import type { Occluder, GridResult, ShadowDiagram } from '../sun/analysis';
import type { StudyScene } from './scene';
import type { MeasurePoint, MeasureResult, StudyDate } from './types';

export interface OccluderOpts {
  terrain: boolean;
  neighbors: boolean;
  building: boolean;
}

/** 日付（ローカル）と場所 */
export interface StudyDay {
  year: number;
  month: number;
  day: number;
  lat: number;
  lon: number;
}

/** 解析用の日付（冬至・春分・夏至・秋分） */
export function studyDates(_year: number): StudyDate[] {
  throw new Error('not implemented');
}

/** シーン内の影を落とす物体から BVH を作る */
export function buildStudyOccluder(_scene: StudyScene, _opts: OccluderOpts): Occluder {
  throw new Error('not implemented');
}

/**
 * 地面（地形面の 5cm 上）の日照時間マップ。範囲は建物中心 ± half (m)、cell (m) 間隔。
 * 地形の高さは groundY(x, z) で与える（地形メッシュへの真下レイキャストでも、HeightGrid でもよい）。
 */
export async function groundSunHoursStudy(
  _scene: StudyScene,
  _day: StudyDay,
  _opts: { center: THREE.Vector3; half?: number; cell?: number; stepMin?: number; groundY: (x: number, z: number) => number; onProgress?: (r: number) => void; signal?: AbortSignal },
): Promise<GridResult> {
  throw new Error('not implemented');
}

/**
 * 日照時間マップの面（地形に沿わせるため、各頂点を groundY に持ち上げた格子メッシュ）。
 * mask(x,z)=false の場所は透明（建物の足跡など）。既存 heatColor の配色。userData.maxHours。
 */
export function groundHeatmapMesh(_g: GridResult, _maxHours: number, _groundY: (x: number, z: number) => number, _mask?: (x: number, z: number) => boolean): THREE.Mesh {
  throw new Error('not implemented');
}

/**
 * 建物の面の日照時間。読み込んだ建物の各三角形をサンプル（面積に応じて 1〜N 点、おおむね 0.4m 間隔）し、
 * 日の出〜日の入を stepMin ごとに太陽方向へレイキャスト（自建物・周辺建物・地形で遮蔽）。
 * 結果は頂点色（面ごとの平均時間、heatColor）を付けた非インデックス geometry の Mesh（MeshBasicMaterial, vertexColors, polygonOffset）。
 * 戻り値の userData: { maxHours（昼の長さ）, facade: true }
 */
export async function facadeSunHours(_scene: StudyScene, _day: StudyDay, _opts: { stepMin?: number; onProgress?: (r: number) => void; signal?: AbortSignal }): Promise<THREE.Mesh> {
  throw new Error('not implemented');
}

/**
 * 測定点の日照時間（複数の日付）。点を法線方向に 2cm 浮かせ、stepMin ごとに判定。
 * spans は連続して日が当たる時間帯（h）。
 */
export async function measurePointHours(_scene: StudyScene, _pt: MeasurePoint, _dates: StudyDate[], _loc: { lat: number; lon: number }, _opts: { stepMin?: number; signal?: AbortSignal } = {}): Promise<MeasureResult[]> {
  throw new Error('not implemented');
}

/**
 * 日影図（冬至日・真太陽時 8〜16 時・測定面 GL+planeHeight）。
 * 建物の内外は読み込んだ建物への真下レイキャストで判定。周辺建物を含めるかは includeNeighbors。
 * 敷地境界: sitePolygon（ワールド XZ）があればその多角形、無ければ建物の足跡 + 2m の矩形。5m/10m ラインは境界からのオフセット。
 * 既存 src/sun/analysis.ts の日影図コアに委譲（SVG の体裁は既存と同じ）。
 */
export async function shadowDiagramStudy(
  _scene: StudyScene,
  _p: { lat: number; lon: number; year: number; planeHeight: number; includeNeighbors: boolean; includeTerrain: boolean; center: THREE.Vector3; half?: number; sitePolygon: THREE.Vector2[] | null; onProgress?: (r: number) => void; signal?: AbortSignal },
): Promise<ShadowDiagram> {
  throw new Error('not implemented');
}

/** 測定点のマーカー（球 + ラベル）。userData.pointId */
export function measureMarker(_pt: MeasurePoint, _index: number): THREE.Object3D {
  throw new Error('not implemented');
}
