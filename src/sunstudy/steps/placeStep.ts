/**
 * ステップ 1「場所」: 住所検索／地図クリックでピン、敷地の輪郭、周辺環境の読み込み
 * ★ スタブ: 実装は担当エージェントが行う。
 */
import type { StudyStep } from '../shell';

export const placeStep: StudyStep = {
  id: 'place',
  label: '場所',
  enabled: () => true,
  uses3d: false,
  mount() {
    throw new Error('not implemented');
  },
};
