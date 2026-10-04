/**
 * ステップ 3「日照シミュレーション」: 時刻・日付、太陽の通り道、周辺環境、解析（日照時間マップ・面の日照・測定点・日影図）、撮影・動画・レポート
 * ★ スタブ: 実装は担当エージェントが行う。
 */
import type { StudyStep } from '../shell';
import { study } from '../state';

export const simStep: StudyStep = {
  id: 'sim',
  label: '日照シミュレーション',
  enabled: () => !!study.frame && !!study.model,
  disabledHint: '「場所」と「建物」を設定すると使えます',
  uses3d: true,
  mount() {
    throw new Error('not implemented');
  },
};
