/**
 * ステップ 2「建物」: 3D データの読み込み、単位・上方向・寸法の確認、方位・位置・高さの調整
 * ★ スタブ: 実装は担当エージェントが行う。
 */
import type { StudyStep } from '../shell';
import { study } from '../state';

export const modelStep: StudyStep = {
  id: 'model',
  label: '建物',
  enabled: () => !!study.frame,
  disabledHint: '先に「場所」で建設地を指定してください',
  uses3d: true,
  mount() {
    throw new Error('not implemented');
  },
};
