/**
 * 3D データの読み込み（3DS を主、OBJ / STL / GLB / FBX も可）・単位の推定・正規化・配置
 *
 * 正規化: 単位 → m に拡大縮小、上方向を Y に（Z-up は rotateX(-π/2): (x,y,z)→(x,z,-y)）、
 *         水平の中心を原点に、底面を y=0 に。鏡像なら x を反転。
 * 配置:   pivot.position = (offsetE, baseY, -offsetN)、pivot.rotation.y = -headingDeg(rad)
 *         （headingDeg: モデル平面の上 (変換後 -Z) が向く方位、真北から時計回り）
 *
 * ★ スタブ: 実装は担当エージェントが行う。シグネチャは変えないこと。
 */
import * as THREE from 'three';
import type { ImportedModel, LengthUnit, ModelFormat, ModelPlacement, UpAxis } from './types';

export const ACCEPT_EXT = ['3ds', 'obj', 'stl', 'glb', 'gltf', 'fbx'];

/** ファイル名から形式を判定（対応外は null） */
export function detectFormat(_name: string): ModelFormat | null {
  throw new Error('not implemented');
}

/**
 * ファイルを読み込む。テクスチャは読まない（参照先が無いことが多い）。
 * 読み込み後に、面の無いオブジェクトを除き、法線が無ければ計算し、三角形数と bbox を数える。
 * 単位は guessUnit、上方向は guessUpAxis で推定（3DS の既定は Z-up）。
 */
export async function importModelFile(_file: { name: string; data: ArrayBuffer }): Promise<ImportedModel> {
  throw new Error('not implemented');
}

/**
 * 寸法から単位を推定: 水平の長辺 L（元の単位）が
 *   L > 1500 → 'mm'、150 < L ≤ 1500 → 'cm'、L ≤ 150 → 'm'
 * （住宅の長辺 5〜30 m を想定。インチ・フィートは自動では選ばない）
 */
export function guessUnit(_rawBox: THREE.Box3, _upAxis: UpAxis): LengthUnit {
  throw new Error('not implemented');
}

/** 上方向の推定: 3DS/OBJ(3ds Max 系) は 'z'、GLB/FBX は 'y'。bbox の最も薄い軸が Z なら 'z' を優先 */
export function guessUpAxis(_format: ModelFormat, _rawBox: THREE.Box3): UpAxis {
  throw new Error('not implemented');
}

/** 1 モデル単位の長さ (m) */
export function unitScale(_p: Pick<ModelPlacement, 'unit' | 'customScale'>): number {
  throw new Error('not implemented');
}

/** 配置済みの建物。pivot をシーンの building グループに入れる */
export class PlacedModel {
  readonly pivot = new THREE.Group();
  /** 正規化したモデル（pivot の子） */
  object: THREE.Group | null = null;
  /** 正規化後の大きさ (m): x=幅(東西・回転前), y=高さ, z=奥行(南北・回転前) */
  size = new THREE.Vector3();

  constructor(
    public model: ImportedModel,
    public placement: ModelPlacement,
  ) {
    throw new Error('not implemented');
  }

  /** 単位・上方向・鏡像・表示が変わったとき: raw から作り直す（元のマテリアル色は保持） */
  rebuild(): void {
    throw new Error('not implemented');
  }

  /** 向き・位置・高さだけが変わったとき */
  applyTransform(): void {
    throw new Error('not implemented');
  }

  /** 寸法 (m): w=東西（回転前）, d=南北（回転前）, h=高さ */
  dimensions(): { w: number; d: number; h: number } {
    throw new Error('not implemented');
  }

  /** 足跡（ワールド XZ の四隅。回転・位置を適用済み） */
  footprintWorld(): THREE.Vector2[] {
    throw new Error('not implemented');
  }

  /** 足跡（ピンからの東・北 m） */
  footprintEN(): { e: number; n: number }[] {
    throw new Error('not implemented');
  }

  /** ワールド bbox（配置後） */
  worldBox(): THREE.Box3 {
    throw new Error('not implemented');
  }

  dispose(): void {
    throw new Error('not implemented');
  }
}

/** 白モデル／元の色の切替（全メッシュの material を差し替える） */
export function applyAppearance(_root: THREE.Object3D, _mode: 'white' | 'original'): void {
  throw new Error('not implemented');
}
