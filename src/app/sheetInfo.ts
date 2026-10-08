import { state } from './state';
import { todayStr, type SheetInfo } from '../drawings/sheet';

/** 図枠の表題欄に入れる情報（工事名・設計者はプロジェクト設定から） */
export function sheetInfo(drawing: string, no?: string): SheetInfo {
  const name = (state.name || '').trim();
  const project = /工事|計画|プロジェクト/.test(name) ? name : name ? `${name} 新築工事` : '新築工事';
  return { project, drawing, date: todayStr(), designer: (state.company || '').trim(), no };
}
