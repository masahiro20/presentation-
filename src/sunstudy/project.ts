/**
 * プロジェクトの保存／読込（JSON。3D データを base64 で同梱）と、設定の自動保存（localStorage）
 *
 * ★ スタブ: 実装は担当エージェントが行う。シグネチャは変えないこと。
 */
import type { ProjectJson } from './types';

/** 現在の状態を JSON に（3D データは 40MB までなら同梱） */
export function serializeProject(): ProjectJson {
  throw new Error('not implemented');
}

/** JSON を状態に反映（3D データの復元を含む）。イベント 'frame' 'site' 'model' 'placement' 'neighbors' 'points' 'project' を発火 */
export async function applyProject(_p: ProjectJson): Promise<void> {
  throw new Error('not implemented');
}

/** ファイルに保存（ダウンロード） */
export function downloadProject(): void {
  throw new Error('not implemented');
}

/** ファイルから読込 */
export async function loadProjectFile(_file: File): Promise<void> {
  throw new Error('not implemented');
}

/** URL から読込（?project=...） */
export async function loadProjectFromUrl(_url: string): Promise<void> {
  throw new Error('not implemented');
}

/** 直近の場所・設定を localStorage に残す／戻す（3D データは含まない） */
export function saveRecent(): void {
  throw new Error('not implemented');
}
export function restoreRecent(): boolean {
  throw new Error('not implemented');
}
