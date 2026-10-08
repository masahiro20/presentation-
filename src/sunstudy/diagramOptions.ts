/**
 * 日影図の描き方の選択（日照シミュレーションの「📐 日影図」）: 規制値のプリセットと「北海道」のチェックから時間帯を決める。
 * DOM を使わない（vitest で読み込める）
 */
import { SHADOW_REGION_HOURS, SHADOW_REGULATION_PRESETS, shadowRegulationPreset } from '../sun/shadowRegulation';
import type { ShadowRegulationPreset } from '../sun/shadowRegulation';

/**
 * 日影図の時間帯（真太陽時）: 規制値のプリセットがあればその地域（北海道は 9〜15 時）、無ければ「北海道」のチェックに従う
 */
export function diagramHours(preset: ShadowRegulationPreset | null | undefined, hokkaido: boolean): [number, number] {
  const region = preset ? preset.region : hokkaido ? 'hokkaido' : 'general';
  return [...SHADOW_REGION_HOURS[region]] as [number, number];
}

/** 「北海道」のチェックを切り替えたときのプリセット: 同じ号の別の地域に移す（なしはなしのまま） */
export function presetForRegion(id: string, hokkaido: boolean): string {
  const p = shadowRegulationPreset(id);
  if (!p) return '';
  const region = hokkaido ? 'hokkaido' : 'general';
  if (p.region === region) return p.id;
  return SHADOW_REGULATION_PRESETS.find((q) => q.region === region && q.grade === p.grade)?.id ?? '';
}
