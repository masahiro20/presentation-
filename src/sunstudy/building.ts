/**
 * 配置済みの建物（PlacedModel）を 1 つ保持し、各ステップから同じインスタンスを使う
 */
import * as THREE from 'three';
import { PlacedModel } from './importModel';
import type { StudyScene } from './scene';
import { study } from './state';
import type { ImportedModel } from './types';

let placed: PlacedModel | null = null;

/** 現在の配置済み建物（無ければ null） */
export function currentPlaced(): PlacedModel | null {
  return placed;
}

/**
 * state の model / placement から配置済み建物を用意し、シーンの building グループに入れる。
 * model が差し替わっていれば作り直す。model が無ければ消して null。
 */
export function ensurePlaced(scene: StudyScene): PlacedModel | null {
  const m = study.model;
  if (!m) {
    if (placed) disposeModelGeometry(placed.model);
    disposePlaced(scene);
    return null;
  }
  if (placed && placed.model !== m) {
    // 差し替え: 古いデータのジオメトリ（GPU のバッファ）も解放する
    disposeModelGeometry(placed.model);
    disposePlaced(scene);
  }
  if (!placed) {
    placed = new PlacedModel(m, study.placement);
    scene.groups.building.add(placed.pivot);
  } else {
    placed.placement = study.placement;
    if (!placed.pivot.parent) scene.groups.building.add(placed.pivot);
  }
  return placed;
}

/** 読み込んだデータの焼き込み済みジオメトリを解放する（データを差し替えたとき） */
export function disposeModelGeometry(model: ImportedModel) {
  for (const o of model.raw.children) (o as THREE.Mesh).geometry?.dispose?.();
}

/** 配置済み建物を捨てる（プロジェクト読込などで model / placement が丸ごと差し替わるとき）。次の ensurePlaced で作り直される */
export function resetPlaced(): void {
  if (!placed) return;
  disposeModelGeometry(placed.model);
  placed.dispose();
  placed = null;
}

export function disposePlaced(scene: StudyScene) {
  if (!placed) return;
  scene.groups.building.remove(placed.pivot);
  placed.dispose();
  placed = null;
}

/** 建物の中心（ワールド、y は底面）。建物が無ければ原点 */
export function buildingCenter(): THREE.Vector3 {
  if (!placed) return new THREE.Vector3(0, 0, 0);
  const b = placed.worldBox();
  const c = b.getCenter(new THREE.Vector3());
  c.y = b.min.y;
  return c;
}

/** 建物の水平の大きさ（長辺, m）。無ければ 10 */
export function buildingExtent(): number {
  if (!placed) return 10;
  const s = placed.worldBox().getSize(new THREE.Vector3());
  return Math.max(s.x, s.z, 1);
}

/** 建物の足跡（ピンからの東・北 m）。無ければ null */
export function buildingFootprintEN(): { e: number; n: number }[] | null {
  return placed ? placed.footprintEN() : null;
}
