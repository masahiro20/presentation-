/**
 * 日影規制の規制時間のプリセット（データ）: 建築基準法 第 56 条の 2・別表第 4 (に)欄。
 * 日影図に「5〜10m の規制 X 時間」「10m 超の規制 Y 時間」の等時間日影線を強調して描くためのもの。
 * 実際の規制（対象区域・号・測定面の高さ）は条例で決まるので、ここは選択肢の一覧だけ。適否（OK/NG）の判定はしない。
 */

/** 等時間日影線の規制時間 (h) */
export interface ShadowRegulation {
  /** 敷地境界から 5m を超え 10m 以内の範囲の規制時間 (h) */
  limitNear: number;
  /** 敷地境界から 10m を超える範囲の規制時間 (h) */
  limitFar: number;
  /** 凡例に出す名前（例 '一般（二）'）。省略可 */
  label?: string;
}

/** 'general' = 北海道以外（真太陽時 8〜16 時）、'hokkaido' = 北海道（真太陽時 9〜15 時） */
export type ShadowRegion = 'general' | 'hokkaido';

export interface ShadowRegulationPreset extends ShadowRegulation {
  id: string;
  region: ShadowRegion;
  /** 別表第 4 (に)欄の号: 1 = (一), 2 = (二), 3 = (三) */
  grade: 1 | 2 | 3;
  /** 短い名前（例 '一般（二）'）。日影図の凡例に出る */
  label: string;
  /** 選択肢に出す説明（例 '一般（二） 5〜10m 4時間／10m 超 2.5時間'） */
  title: string;
  /** 日影を測る時間帯（真太陽時, h） */
  hours: [number, number];
}

/** 日影を測る時間帯（真太陽時, h）: 北海道以外は 8〜16 時、北海道は 9〜15 時 */
export const SHADOW_REGION_HOURS: Readonly<Record<ShadowRegion, [number, number]>> = { general: [8, 16], hokkaido: [9, 15] };

const GRADE = ['', '（一）', '（二）', '（三）'] as const;

function preset(region: ShadowRegion, grade: 1 | 2 | 3, limitNear: number, limitFar: number): ShadowRegulationPreset {
  const name = region === 'hokkaido' ? '北海道' : '一般';
  return {
    id: `${region}-${grade}`,
    region,
    grade,
    limitNear,
    limitFar,
    label: `${name}${GRADE[grade]}`,
    title: `${name}${GRADE[grade]} 5〜10m ${limitNear}時間／10m 超 ${limitFar}時間`,
    hours: [...SHADOW_REGION_HOURS[region]] as [number, number],
  };
}

/** 別表第 4 (に)欄の規制時間（5〜10m ／ 10m 超） */
export const SHADOW_REGULATION_PRESETS: readonly ShadowRegulationPreset[] = [
  preset('general', 1, 3, 2),
  preset('general', 2, 4, 2.5),
  preset('general', 3, 5, 3),
  preset('hokkaido', 1, 2, 1.5),
  preset('hokkaido', 2, 3, 2),
  preset('hokkaido', 3, 4, 2.5),
];

export function shadowRegulationPreset(id: string): ShadowRegulationPreset | undefined {
  return SHADOW_REGULATION_PRESETS.find((p) => p.id === id);
}

/** 等時間日影線の既定の時間 (h) */
export const DEFAULT_SHADOW_LEVELS: readonly number[] = [2, 3, 4, 5];

/** 規制の 6 種類すべてを描くときの時間 (h) */
export const ALL_REGULATION_LEVELS: readonly number[] = [1.5, 2, 2.5, 3, 4, 5];
