/**
 * 部屋の用途の選択肢（修正画面・読み取り結果の表で使う）。
 * ガレージは建て方（ビルトイン／後付け／離れ）まで選べるように「garage:attached」のような値にする。
 */
import { ROOM_TYPE_LABEL, type GarageKind, type RoomType } from './types';

export interface UseOption {
  value: string;
  label: string;
}

const T = (t: RoomType, label = ROOM_TYPE_LABEL[t]): UseOption => ({ value: t, label });

export const USE_GROUPS: { label: string; options: UseOption[] }[] = [
  { label: '居室', options: [T('ldk'), T('living'), T('dining'), T('kitchen'), T('japanese'), T('bedroom'), T('kids'), T('study'), T('other', '居室（その他）')] },
  { label: '水まわり', options: [T('bath'), T('washroom'), T('toilet')] },
  { label: '玄関・通路', options: [T('entrance', '玄関（土間）'), T('hall'), T('stairs'), T('porch')] },
  { label: '収納', options: [T('closet'), T('storage')] },
  { label: '吹抜・バルコニー・中庭', options: [T('void'), T('balcony', 'バルコニー・中庭')] },
  {
    label: 'ガレージ',
    options: [
      { value: 'garage:builtin', label: 'ビルトインガレージ（家の中）' },
      { value: 'garage:attached', label: '後付けガレージ（家に接して建てる・GAW など）' },
      { value: 'garage:detached', label: '離れのガレージ（家から離して建てる）' },
    ],
  },
  { label: '外構', options: [T('carport'), T('parking'), T('deck'), T('terrace', 'テラス（タイル・土間）'), T('shed', '物置・サイクルポート')] },
];

/** 部屋の今の用途を選択肢の値に */
export function useValueOf(r: { type: RoomType; garageKind?: GarageKind }): string {
  return r.type === 'garage' ? `garage:${r.garageKind ?? 'builtin'}` : r.type;
}

/** 選択肢の値を部屋（または修正画面のラベル）に反映 */
export function applyUseValue(r: { type?: RoomType; garageKind?: GarageKind }, value: string) {
  const [t, kind] = value.split(':') as [RoomType, GarageKind | undefined];
  r.type = t;
  if (t === 'garage') r.garageKind = kind ?? 'builtin';
  else delete r.garageKind;
}

/** 用途の表示名（ガレージは建て方つき） */
export function useLabelOf(r: { type: RoomType; garageKind?: GarageKind }): string {
  const v = useValueOf(r);
  for (const g of USE_GROUPS) for (const o of g.options) if (o.value === v) return o.label;
  return ROOM_TYPE_LABEL[r.type];
}
