/**
 * コーディネート: メーカー・品番つきの仕上げ・設備のカタログ。
 * 選ぶと (1) 3D の材質（外観・内観のテイストに上書き）と (2) 見積の該当行（group の選択）が同時に変わる。
 * 社内の積算シートに載っている商品を中心に、ホームランディックの標準仕様（塗り壁の箱・黒サッシ・オーク床・白壁・鉄骨階段）でそろえている。
 */
import { exteriorById, interiorById, type DesignOptions, type ExteriorStyle, type InteriorStyle } from '../styles/presets';
import type { MatSpec } from '../styles/textures';

export interface Product {
  id: string;
  maker: string;
  name: string;
  /** 品番・シリーズ */
  code: string;
  /** 色・柄の名前 */
  color?: string;
  /** カードの色見本 */
  swatch: string[];
  /** 3D への反映 */
  apply?: (s: { ext: ExteriorStyle; int: InteriorStyle }) => void;
  /** 見積の行（group の選択）。無ければ見積は変わらない */
  estimate?: { group: string; line: string };
  /** 概算の差額など、ひとこと */
  note?: string;
  /** 御社の過去の仕様で使った例（「こういうのも選ばれている」の根拠。お客様名は書かない） */
  used?: string;
}

export interface FinishCategory {
  id: string;
  label: string;
  part: '外部' | '内部' | '設備';
  /**
   * 設備（太陽光・給湯・換気・空調・トイレ）: 色や柄で選ぶものではないので、コーディネートの順番・決定ボードには出さず、
   * 「設備の仕様」で確認するだけ（見積には反映する）
   */
  equipment?: boolean;
  /** テイスト（プリセット）から決まる既定（product id）。無ければ先頭 */
  defaultFor?: (d: DesignOptions) => string;
  products: Product[];
}

const paint = (color: string, roughness = 0.55): MatSpec => ({ pattern: 'paint', color, roughness });
/** セラミック天板（目地の無い大判。わずかな石目） */
const ceramic = (color: string, color2: string): MatSpec => ({ pattern: 'marble', color, color2, roughness: 0.3, size: 3.2, size2: 3.2 });
/** LINE KITCHEN のモルタル調メラミン（モルタライト・モルタブラック・グレーストーン）: ざらつきのある塗り調 */
const mortar = (color: string, color2: string): MatSpec => ({ pattern: 'plaster', color, color2, roughness: 0.55, normalStrength: 0.12 });
/** ステンレス バイブレーション天板 */
const stainless = (): MatSpec => ({ pattern: 'paint', color: '#b9bbbd', roughness: 0.32, metalness: 0.9 });
/** 挽板・無垢のフローリング */
const wood = (color: string, color2: string, size: number, roughness = 0.5): MatSpec => ({ pattern: 'woodFloor', color, color2, roughness, size });
/** 大判の床タイル・フロアタイル（a × b m、目地の濃さは tile） */
const tile = (color: string, a: number, b = a, color2?: string, roughness = 0.45): MatSpec => ({ pattern: 'tileFloor', color, color2: color2 ?? color, roughness, size: a, size2: b, tile: Math.max(a, b) * 2 });
/** モールテックス（目地の無い薄塗りのモルタル）: 床・壁・カウンター */
const mortex = (color: string, color2: string): MatSpec => ({ pattern: 'plaster', color, color2, roughness: 0.62, normalStrength: 0.16 });
/** 杉の羽目板（チャネルオリジナル 杉羽目板 自然塗装） */
const sugi = (): MatSpec => ({ pattern: 'woodSiding', color: '#b08d66', color2: '#977550', roughness: 0.78, size: 0.105 });

/** 外壁の塗り壁（ジョリパット・Sto・そとん壁）: 色と肌理の粗さ */
const plaster = (color: string, color2: string, coarse = 0.3) => (s: { ext: ExteriorStyle }) => {
  s.ext.wall = { ...s.ext.wall, pattern: 'stucco', color, color2, roughness: 0.97, normalStrength: coarse };
};
const solido = (color: string) => (s: { ext: ExteriorStyle }) => {
  s.ext.accent = { pattern: 'solido', color, roughness: 0.92, normalStrength: 0.6 };
  if (s.ext.accentRule === 'none') s.ext.accentRule = 'entrance';
};

/**
 * 部位の並びと商品。表記は御社の図面（立面図・内部仕上表・床仕様書・建具表）の書き方に合わせている:
 *   塗り壁材 ジョリパット ミーティア仕上げ／塗り壁材 Sto ミーティア仕上げ／【ケイミュー】SOLIDO typeM LAP（灰・鉄黒）／
 *   【チャネルオリジナル】杉羽目板 自然塗装／【LIXIL】TW 樹脂アルミ複合サッシ 3+16+3 Low-E クリア／【YKK】ヴェナート D30 D2 仕様／
 *   【イエモン】ジャイロオーク W158 塗装：クリア／【サンゲツ】IS-2071 ワイドモルタル・IS-2033 モルテストーン／
 *   【神谷コーポレーション】フルハイトドア／【TOTO】サザナ HT シリーズ S タイプ など
 * 色名・品番がメーカーの資料で確かめられないものは書かず、「品番メモ」に正確な品番を入れてもらう。
 */
export const FINISH_CATEGORIES: FinishCategory[] = [
  // ================= 外まわり =================
  {
    id: 'extWall',
    label: '外壁',
    part: '外部',
    defaultFor: (d) => (/galva|gl/.test(d.exteriorId) ? 'ext.gl.black' : /sto/.test(d.exteriorId) ? 'ext.sto.white' : /soton/.test(d.exteriorId) ? 'ext.soton' : 'ext.jp.mid'),
    products: [
      { id: 'ext.jp.white', maker: 'アイカ工業', name: '塗り壁材 ジョリパット', code: 'ミーティア仕上げ', color: 'ホワイト', swatch: ['#e8e6e0'], apply: plaster('#e8e6e0', '#e2e0da'), estimate: { group: 'extwall', line: 'ext.jolypat' }, note: '色番号はジョリパットの色見本で（例: N-25 合わせ）', used: '外壁（N-25 合わせ など）' },
      { id: 'ext.jp.light', maker: 'アイカ工業', name: '塗り壁材 ジョリパット', code: 'ミーティア仕上げ', color: 'ライトグレー', swatch: ['#cfcdc7'], apply: plaster('#cfcdc7', '#c8c6c0'), estimate: { group: 'extwall', line: 'ext.jolypat' } },
      { id: 'ext.jp.mid', maker: 'アイカ工業', name: '塗り壁材 ジョリパット', code: 'ミーティア仕上げ', color: '中間グレー', swatch: ['#9a9893'], apply: plaster('#9a9893', '#93918c'), estimate: { group: 'extwall', line: 'ext.jolypat' } },
      { id: 'ext.jp.dark', maker: 'アイカ工業', name: '塗り壁材 ジョリパット', code: 'ミーティア仕上げ', color: 'ダークグレー', swatch: ['#5d5c59'], apply: plaster('#5d5c59', '#575653'), estimate: { group: 'extwall', line: 'ext.jolypat' } },
      { id: 'ext.jp.beige', maker: 'アイカ工業', name: '塗り壁材 ジョリパット', code: 'ミーティア仕上げ', color: 'サンドベージュ', swatch: ['#cbbfab'], apply: plaster('#cbbfab', '#c3b7a3'), estimate: { group: 'extwall', line: 'ext.jolypat' } },
      { id: 'ext.sto.white', maker: 'Sto', name: '塗り壁材 Sto', code: 'ミーティア仕上げ', color: 'オフホワイト', swatch: ['#ebe9e3'], apply: plaster('#ebe9e3', '#e5e3dd', 0.25), estimate: { group: 'extwall', line: 'ext.sto' }, note: '色番号は Sto の色見本で（例: T4005 合わせ）', used: '外壁・軒裏（ケイカル板＋Sto）' },
      { id: 'ext.sto.light', maker: 'Sto', name: '塗り壁材 Sto', code: 'ミーティア仕上げ', color: 'ライトグレー', swatch: ['#c9c8c3'], apply: plaster('#c9c8c3', '#c2c1bc', 0.25), estimate: { group: 'extwall', line: 'ext.sto' } },
      { id: 'ext.sto.grey', maker: 'Sto', name: '塗り壁材 Sto', code: 'ミーティア仕上げ', color: 'グレージュ', swatch: ['#b3aea4'], apply: plaster('#b3aea4', '#aca79d', 0.25), estimate: { group: 'extwall', line: 'ext.sto' } },
      { id: 'ext.soton', maker: '高千穂', name: '塗り壁材 そとん壁W', code: '掻き落とし仕上げ', color: 'グレー系', swatch: ['#a8a59e'], apply: plaster('#a8a59e', '#9f9c95', 0.55), estimate: { group: 'extwall', line: 'ext.jolypat' }, note: '粗い肌理で陰影が出ます。見積はジョリパットと同じ単価で仮置き' },
      { id: 'ext.gl.black', maker: '—', name: 'ガルバリウム鋼板 Kスパン（縦張り）', code: 'GL 鋼板 ＋ PB×2', color: 'ブラック', swatch: ['#2b2c2e'], apply: (s) => { s.ext.wall = { pattern: 'standingSeam', color: '#2b2c2e', roughness: 0.5, metalness: 0.4 }; }, estimate: { group: 'extwall', line: 'ext.gl' } },
      { id: 'ext.gl.silver', maker: '—', name: 'ガルバリウム鋼板 Kスパン（縦張り）', code: 'GL 鋼板 ＋ PB×2', color: 'シルバー', swatch: ['#6b6d70'], apply: (s) => { s.ext.wall = { pattern: 'standingSeam', color: '#6b6d70', roughness: 0.45, metalness: 0.5 }; }, estimate: { group: 'extwall', line: 'ext.gl' } },
    ],
  },
  {
    id: 'accent',
    label: 'アクセント外壁',
    part: '外部',
    defaultFor: (d) => (exteriorById(d.exteriorId).accent ? 'acc.solido.black' : 'acc.none'),
    products: [
      { id: 'acc.none', maker: '—', name: 'アクセントなし（外壁一色）', code: '', swatch: ['#dddbd5'], apply: (s) => { s.ext.accent = undefined; s.ext.accentRule = 'none'; }, note: 'SOLIDO の行が 0 になります' },
      { id: 'acc.solido.black', maker: 'ケイミュー', name: 'SOLIDO typeM LAP', code: '窯業系 通気パネル工法 防火 PC030BE-4146(1)', color: '鉄黒', swatch: ['#3f3d3a'], apply: solido('#3f3d3a'), used: '外壁の一部（窯業系平形ストレート 通気パネル工法）' },
      { id: 'acc.solido.grey', maker: 'ケイミュー', name: 'SOLIDO typeM LAP', code: '窯業系 通気パネル工法 防火 PC030BE-4146(1)', color: '灰', swatch: ['#8d8b86'], apply: solido('#8d8b86'), used: 'リビングの壁にも' },
      { id: 'acc.wood', maker: 'チャネルオリジナル', name: '杉羽目板', code: '木板 杉板', color: '自然塗装', used: '軒裏・外壁の一部', swatch: ['#a5845f'], apply: (s) => { s.ext.accent = { pattern: 'wood', color: '#a5845f', color2: '#8d6d4a', roughness: 0.8 }; if (s.ext.accentRule === 'none') s.ext.accentRule = 'entrance'; } },
    ],
  },
  {
    id: 'roof',
    label: '屋根',
    part: '外部',
    products: [
      { id: 'roof.gl.black', maker: '—', name: 'カラーガルバリウム鋼板 立平葺', code: 't0.35 防火 NM-8697', color: 'ブラック', swatch: ['#2a2b2d'], apply: (s) => { s.ext.roof.material = { pattern: 'standingSeam', color: '#2a2b2d', roughness: 0.5, metalness: 0.4 }; s.ext.roof.fascia = '#1f1f1f'; } },
      { id: 'roof.gl.silver', maker: '—', name: 'カラーガルバリウム鋼板 立平葺', code: 't0.35 防火 NM-8697', color: 'シルバー', swatch: ['#9a9c9e'], apply: (s) => { s.ext.roof.material = { pattern: 'standingSeam', color: '#9a9c9e', roughness: 0.4, metalness: 0.6 }; } },
    ],
  },
  {
    id: 'soffit',
    label: '軒天（軒の裏）',
    part: '外部',
    products: [
      { id: 'soffit.same', maker: '—', name: 'ケイ酸カルシウム板 t10 ＋ 外壁と同じ塗り壁', code: '防火 QF030RS-0134', color: '外壁同色', swatch: ['#9a9893'], apply: (s) => { s.ext.roof.soffit = { pattern: 'paint', color: s.ext.wall.color, roughness: 0.95 }; }, note: '軒の裏まで外壁と同じ色で回し、箱の輪郭を強調します' },
      { id: 'soffit.white', maker: '—', name: 'ケイ酸カルシウム板 t10（塗装軒天ボード）', code: '防火 QF030RS-0134', color: 'ホワイト', swatch: ['#efeeea'], apply: (s) => { s.ext.roof.soffit = { pattern: 'paint', color: '#efeeea', roughness: 0.9 }; } },
      { id: 'soffit.black', maker: '—', name: 'ケイ酸カルシウム板 t10（塗装軒天ボード）', code: '防火 QF030RS-0134', color: 'ブラック', swatch: ['#2c2c2d'], apply: (s) => { s.ext.roof.soffit = { pattern: 'paint', color: '#2c2c2d', roughness: 0.85 }; } },
      { id: 'soffit.cedar', maker: 'チャネルオリジナル', name: '杉羽目板（軒天）', code: '木板 杉板', color: '自然塗装', swatch: ['#a88762'], apply: (s) => { s.ext.roof.soffit = { pattern: 'woodSiding', color: '#a88762', color2: '#8f6f4c', roughness: 0.75, size: 0.1 }; }, note: '準防火地域では軒裏の防火仕様を確認' },
    ],
  },
  {
    id: 'sash',
    label: 'サッシ',
    part: '外部',
    products: [
      { id: 'sash.tw.black', maker: 'LIXIL', name: 'TW（樹脂アルミ複合サッシ）', code: '3+16+3 Low-E クリア ＋ 網戸', color: '外ブラック・内ブラック', swatch: ['#1f1f1f'], apply: (s) => { s.ext.frame = { color: '#1f1f1f', metalness: 0.3 }; }, estimate: { group: 'sash', line: 'sash.tw' } },
      { id: 'sash.tw.silver', maker: 'LIXIL', name: 'TW（樹脂アルミ複合サッシ）', code: '3+16+3 Low-E クリア ＋ 網戸', color: 'ナチュラルシルバー', swatch: ['#b9bcbf'], apply: (s) => { s.ext.frame = { color: '#b9bcbf', metalness: 0.6 }; }, estimate: { group: 'sash', line: 'sash.tw' } },
      { id: 'sash.tw.white', maker: 'LIXIL', name: 'TW（樹脂アルミ複合サッシ）', code: '3+16+3 Low-E クリア ＋ 網戸', color: 'ホワイト', swatch: ['#f0f0ee'], apply: (s) => { s.ext.frame = { color: '#f0f0ee', metalness: 0.2 }; }, estimate: { group: 'sash', line: 'sash.tw' } },
      { id: 'sash.thermos.black', maker: 'LIXIL', name: 'サーモスⅡ-H', code: 'Low-E 複層ガラス', color: 'ブラック', swatch: ['#1f1f1f'], apply: (s) => { s.ext.frame = { color: '#1f1f1f', metalness: 0.3 }; }, estimate: { group: 'sash', line: 'sash.thermos' }, note: 'S シリーズ標準' },
      { id: 'sash.thermos.silver', maker: 'LIXIL', name: 'サーモスⅡ-H', code: 'Low-E 複層ガラス', color: 'ナチュラルシルバー', swatch: ['#b9bcbf'], apply: (s) => { s.ext.frame = { color: '#b9bcbf', metalness: 0.6 }; }, estimate: { group: 'sash', line: 'sash.thermos' } },
    ],
  },
  {
    id: 'entDoor',
    label: '玄関ドア',
    part: '外部',
    products: [
      { id: 'door.venato.black', maker: 'YKK AP', name: 'ヴェナート D30 片開き', code: 'D2 仕様（断熱）ストレートハンドル', color: 'ブラック', swatch: ['#2a2a2a'], apply: (s) => { s.ext.entranceDoor = paint('#2a2a2a', 0.5); }, estimate: { group: 'entDoor', line: 'sash.doorVenato' } },
      { id: 'door.venato.grey', maker: 'YKK AP', name: 'ヴェナート D30 片開き', code: 'D2 仕様（断熱）ストレートハンドル', color: 'ディープグレイ', swatch: ['#4a4c4f'], apply: (s) => { s.ext.entranceDoor = paint('#4a4c4f', 0.5); }, estimate: { group: 'entDoor', line: 'sash.doorVenato' } },
      { id: 'door.venato.walnut', maker: 'YKK AP', name: 'ヴェナート D30 片開き', code: 'D2 仕様（断熱）ストレートハンドル', color: '木目（濃）', swatch: ['#5a3d2b'], apply: (s) => { s.ext.entranceDoor = { pattern: 'wood', color: '#5a3d2b', color2: '#4a3223', roughness: 0.55 }; }, estimate: { group: 'entDoor', line: 'sash.doorVenato' }, note: '木目の色名はヴェナートの色見本で' },
      { id: 'door.venato.oak', maker: 'YKK AP', name: 'ヴェナート D30 片開き', code: 'D2 仕様（断熱）ストレートハンドル', color: '木目（明）', swatch: ['#a2764d'], apply: (s) => { s.ext.entranceDoor = { pattern: 'wood', color: '#a2764d', color2: '#8c6340', roughness: 0.55 }; }, estimate: { group: 'entDoor', line: 'sash.doorVenato' }, note: '木目の色名はヴェナートの色見本で' },
      { id: 'door.concord.black', maker: 'YKK AP', name: 'コンコード 玄関引き戸', code: 'コンコード S30', color: 'ブラック', swatch: ['#2a2a2a'], apply: (s) => { s.ext.entranceDoor = paint('#2a2a2a', 0.5); }, estimate: { group: 'entDoor', line: 'sash.doorConcord' } },
    ],
  },
  {
    id: 'entFloor',
    label: '玄関土間・ポーチ',
    part: '内部',
    products: [
      { id: 'ent.denver', maker: '名古屋モザイク工業', name: 'デンバーストン', code: 'PST-X3640 600角 t10', swatch: ['#8c8a85'], apply: (s) => { s.int.entranceFloor = tile('#8c8a85', 0.6, 0.6, '#85837e', 0.55); }, used: '玄関・LDK・中庭（ポーチは 20 厚 PST-X3240G）' },
      { id: 'ent.nagoya.9840', maker: '名古屋モザイク工業', name: '磁器質タイル', code: 'PST-X9840G', swatch: ['#6f6d69'], apply: (s) => { s.int.entranceFloor = tile('#6f6d69', 0.6, 0.6, '#6a6864', 0.55); }, used: '玄関・ポーチ', note: '色はサンプルで確認' },
      { id: 'ent.hirata.qtz', maker: '平田タイル', name: '磁器質タイル', code: 'QTZ-6060D-9T 598×598×9', color: 'ストーンホワイト', swatch: ['#d7d4cd'], apply: (s) => { s.int.entranceFloor = tile('#d7d4cd', 0.6, 0.6, '#d0cdc6', 0.5); }, used: '玄関土間（目地：ダークグレー）' },
      { id: 'ent.sanwa.dust', maker: 'サンワカンパニー', name: 'ダスト601', code: 'TL76511 601×601×9', color: 'パール', swatch: ['#c9c6bf'], apply: (s) => { s.int.entranceFloor = tile('#c9c6bf', 0.6, 0.6, '#c2bfb8', 0.5); }, used: '土間・ポーチ（目地揃え・目地カラーはタイル合わせ）' },
      { id: 'ent.mortar', maker: '—', name: 'モルタル金ごて仕上げ', code: '土間', swatch: ['#8f8d88'], apply: (s) => { s.int.entranceFloor = { pattern: 'concrete', color: '#8f8d88', roughness: 0.75 }; }, used: '玄関土間・ポーチ' },
    ],
  },
  // ================= LDK の床・壁・天井・建具・キッチン・照明 =================
  {
    id: 'floor',
    label: '床材（LDK・居室）',
    part: '内部',
    defaultFor: (d) => (/slate|tile/.test(d.interiorId) ? 'floor.tile.black' : 'floor.channel.oak'),
    products: [
      { id: 'floor.channel.oak', maker: 'チャネルオリジナル', name: 'オーク 挽板フローリング', code: '挽板 t15 W150', color: 'ナチュラル（自然塗装）', swatch: ['#c9a97c'], apply: (s) => { s.int.floor = wood('#c9a97c', '#b8976c', 0.15, 0.55); }, estimate: { group: 'floor', line: 'ib.floorChannel' } },
      { id: 'floor.iemon.clear', maker: 'イエモン', name: 'ジャイロオーク W158（複合フローリング・挽板）', code: 'GY-C158-IE-05 15×158×乱尺', color: '塗装：クリア', swatch: ['#cdb089'], apply: (s) => { s.int.floor = wood('#cdb089', '#bd9e77', 0.158); }, estimate: { group: 'floor', line: 'ib.floorIemonClear' }, used: '1・2 階フローリングの定番（上框・笠木も同じイエモンで）' },
      { id: 'floor.iemon.latte', maker: 'イエモン', name: 'ジャイロオーク W158（複合フローリング・挽板）', code: '15×158×乱尺', color: '塗装：ラテ', swatch: ['#bfa17d'], apply: (s) => { s.int.floor = wood('#bfa17d', '#ae906c', 0.158); }, estimate: { group: 'floor', line: 'ib.floorIemonClear' }, used: '1 階ベース（建具巾木はストーンホワイト）' },
      { id: 'floor.iemon.smoke', maker: 'イエモン', name: 'ジャイロオーク W158（複合フローリング・挽板）', code: '15×158×乱尺', color: '塗装：スモーク', swatch: ['#a88f6c'], apply: (s) => { s.int.floor = wood('#a88f6c', '#98805f', 0.158); }, estimate: { group: 'floor', line: 'ib.floorIemonClear' } },
      { id: 'floor.iemon.mocha', maker: 'イエモン', name: 'ジャイロオーク W158（複合フローリング・挽板）', code: '15×158×乱尺', color: '塗装：モカ', swatch: ['#8c7152'], apply: (s) => { s.int.floor = wood('#8c7152', '#7c6347', 0.158); }, estimate: { group: 'floor', line: 'ib.floorIemonMocha' } },
      { id: 'floor.prairie.whiteoak', maker: 'プレイリーホームズ', name: 'ナチュラルフローリング ホワイトオーク', code: 'PHFL1278 15×150', color: 'クランプオイル（クリア）', swatch: ['#d0b48c'], apply: (s) => { s.int.floor = wood('#d0b48c', '#bfa27a', 0.15, 0.6); }, estimate: { group: 'floor', line: 'ib.floorIoc' }, used: '1 階ベース', note: '見積は無垢床の単価で仮置き' },
      { id: 'floor.prairie.nara', maker: 'プレイリーホームズ', name: 'ナラ 120 キャラクター', code: 'PHFL1407 W120', color: 'キャラクターグレード（節あり）', swatch: ['#bf9d72'], apply: (s) => { s.int.floor = wood('#bf9d72', '#a9875d', 0.12, 0.62); }, estimate: { group: 'floor', line: 'ib.floorIoc' }, used: '1・2 階フローリング', note: '見積は無垢床の単価で仮置き' },
      { id: 'floor.ioc.oak', maker: 'IOC', name: 'オーク 無垢フローリング', code: '無垢 t15 W120', color: 'ナチュラル', swatch: ['#d2b58d'], apply: (s) => { s.int.floor = wood('#d2b58d', '#c2a47c', 0.12, 0.6); }, estimate: { group: 'floor', line: 'ib.floorIoc' }, note: '無垢。床塗装の行（任意）も' },
      { id: 'floor.sangetsu.widemortar', maker: 'サンゲツ', name: 'フロアタイル ワイドモルタル', code: 'IS-2071 t2.5', color: 'モルタル調グレー', swatch: ['#a7a49e'], apply: (s) => { s.int.floor = tile('#a7a49e', 0.914, 0.914, '#a09d97', 0.55); }, estimate: { group: 'floor', line: 'ib.floorChannel' }, used: '玄関ホール・ホール・FC・DK（塩化ビニルタイル）', note: 'フロアタイルは単価が下がるので「任意の項目」で調整' },
      { id: 'floor.sangetsu.mortestone', maker: 'サンゲツ', name: 'フロアタイル モルテストーン', code: 'IS-2033-A 609.6×609.6 t2.5', swatch: ['#b9b5ad'], apply: (s) => { s.int.floor = tile('#b9b5ad', 0.6096, 0.6096, '#b2aea6', 0.52); }, estimate: { group: 'floor', line: 'ib.floorChannel' }, used: 'FC・脱衣室・DK・トイレ' },
      { id: 'floor.denver', maker: '名古屋モザイク工業', name: 'デンバーストン（磁器質タイル）', code: 'PST-X3640 600角 t10', swatch: ['#8c8a85'], apply: (s) => { s.int.floor = tile('#8c8a85', 0.6, 0.6, '#85837e', 0.42); }, estimate: { group: 'floor', line: 'ib.floorChannel' }, used: 'LDK・玄関（床暖房と相性がよい）', note: 'LDK タイル床は「室内タイル床」の数量で別途' },
      { id: 'floor.hirata.qtz', maker: '平田タイル', name: '磁器質タイル', code: 'QTZ-6060D-9T 598×598×9', color: 'ストーンホワイト', swatch: ['#d7d4cd'], apply: (s) => { s.int.floor = tile('#d7d4cd', 0.6, 0.6, '#d0cdc6', 0.4); }, estimate: { group: 'floor', line: 'ib.floorChannel' }, note: 'LDK タイル床は「室内タイル床」の数量で別途' },
      { id: 'floor.tile.black', maker: 'サンワカンパニー', name: '磁器質タイル 600角', code: 'セメント調 600×600 ※品番は品番メモに', color: 'チャコール', swatch: ['#3b3a38'], apply: (s) => { s.int.floor = tile('#3b3a38', 0.6, 0.6, '#3b3a38', 0.4); }, estimate: { group: 'floor', line: 'ib.floorChannel' }, note: 'LDK タイル床は「室内タイル床」の数量で別途' },
      { id: 'floor.mortex', maker: 'Beal International', name: 'モールテックス（床）', code: '薄塗りモルタル', color: 'セージライト', swatch: ['#b7b5a8'], apply: (s) => { s.int.floor = mortex('#b7b5a8', '#aeac9f'); }, estimate: { group: 'floor', line: 'ib.floorChannel' }, used: 'ホール・土間・玄関框（巾木もモールテックス）', note: '左官工事。「任意の項目」で数量を入れてください' },
    ],
  },
  {
    id: 'wall',
    label: '内壁（ベース）',
    part: '内部',
    products: [
      { id: 'wall.cloth.white', maker: 'サンゲツ', name: 'ビニールクロス（量産・AA 級）', code: 'SP シリーズ ※品番は品番メモに（例: SP-2564）', color: 'ホワイト', swatch: ['#efede8'], apply: (s) => { s.int.wall = { pattern: 'plaster', color: '#efede8', color2: '#e8e5df', roughness: 0.95, normalStrength: 0.18 }; }, estimate: { group: 'cloth', line: 'it.clothAA' }, used: '特記なきベースのクロス（天井・壁）' },
      { id: 'wall.cloth.grey', maker: 'サンゲツ', name: 'ビニールクロス（量産・AA 級）', code: 'SP シリーズ ※品番は品番メモに', color: 'ライトグレー', swatch: ['#dcdad5'], apply: (s) => { s.int.wall = { pattern: 'plaster', color: '#dcdad5', color2: '#d5d3ce', roughness: 0.95, normalStrength: 0.18 }; }, estimate: { group: 'cloth', line: 'it.clothAA' } },
      { id: 'wall.cloth.greige', maker: 'サンゲツ', name: 'ビニールクロス（量産・AA 級）', code: 'SP シリーズ ※品番は品番メモに', color: 'グレージュ', swatch: ['#cfc8bd'], apply: (s) => { s.int.wall = { pattern: 'plaster', color: '#cfc8bd', color2: '#c8c1b6', roughness: 0.95, normalStrength: 0.18 }; }, estimate: { group: 'cloth', line: 'it.clothAA' } },
      { id: 'wall.cloth.beige', maker: 'サンゲツ', name: 'ビニールクロス（量産・AA 級）', code: 'SP シリーズ ※品番は品番メモに', color: 'ペールベージュ', swatch: ['#e6ddd0'], apply: (s) => { s.int.wall = { pattern: 'plaster', color: '#e6ddd0', color2: '#ded5c8', roughness: 0.95, normalStrength: 0.18 }; }, estimate: { group: 'cloth', line: 'it.clothAA' } },
      { id: 'wall.lilycolor', maker: 'リリカラ', name: 'ビニールクロス', code: 'LV シリーズ ※品番は品番メモに', color: 'オフホワイト', swatch: ['#ece9e3'], apply: (s) => { s.int.wall = { pattern: 'plaster', color: '#ece9e3', color2: '#e5e2dc', roughness: 0.95, normalStrength: 0.18 }; }, estimate: { group: 'cloth', line: 'it.clothAA' } },
      { id: 'wall.sincol', maker: 'シンコール', name: 'ビニールクロス', code: 'BB シリーズ ※品番は品番メモに', color: 'ホワイト', swatch: ['#f0eeea'], apply: (s) => { s.int.wall = { pattern: 'plaster', color: '#f0eeea', color2: '#e9e7e2', roughness: 0.95, normalStrength: 0.18 }; }, estimate: { group: 'cloth', line: 'it.clothAA' } },
      { id: 'wall.porters.stone', maker: 'ポーターズペイント', name: '塗装仕上げ（塗り壁用クロスの上）', code: 'ストーン ※色番号は品番メモに', color: 'ライムストーン系', swatch: ['#d9d4c8'], apply: (s) => { s.int.wall = { pattern: 'plaster', color: '#d9d4c8', color2: '#d1ccbf', roughness: 0.97, normalStrength: 0.35 }; }, note: '「室内塗り壁」の面積を入れると見積に反映' },
    ],
  },
  {
    id: 'accentWall',
    label: 'アクセント壁（LDK のテレビ壁など）',
    part: '内部',
    products: [
      { id: 'aw.none', maker: '—', name: 'アクセントなし（ベースと同じ）', code: '', swatch: ['#efede8'], apply: (s) => { s.int.accentWall = undefined; } },
      { id: 'aw.cloth.greige', maker: 'サンゲツ', name: 'アクセントクロス', code: 'FE・RE シリーズ ※品番は品番メモに', color: 'グレージュ', swatch: ['#b9b0a3'], apply: (s) => { s.int.accentWall = { pattern: 'plaster', color: '#b9b0a3', color2: '#b2a99c', roughness: 0.95, normalStrength: 0.2 }; }, used: 'LDK・寝室の一面（FE-76519 など）' },
      { id: 'aw.cloth.charcoal', maker: 'サンゲツ', name: 'アクセントクロス', code: 'FE・RE シリーズ ※品番は品番メモに', color: 'チャコール', swatch: ['#55534f'], apply: (s) => { s.int.accentWall = { pattern: 'plaster', color: '#55534f', color2: '#4f4d49', roughness: 0.95, normalStrength: 0.2 }; } },
      { id: 'aw.cloth.green', maker: 'サンゲツ', name: 'アクセントクロス', code: 'FE・RE シリーズ ※品番は品番メモに', color: 'くすみグリーン', swatch: ['#7f8a76'], apply: (s) => { s.int.accentWall = { pattern: 'plaster', color: '#7f8a76', color2: '#78836f', roughness: 0.95, normalStrength: 0.2 }; } },
      { id: 'aw.cloth.terracotta', maker: 'サンゲツ', name: 'アクセントクロス', code: 'FE・RE シリーズ ※品番は品番メモに', color: 'テラコッタ', swatch: ['#b07a5c'], apply: (s) => { s.int.accentWall = { pattern: 'plaster', color: '#b07a5c', color2: '#a87254', roughness: 0.95, normalStrength: 0.2 }; } },
      { id: 'aw.mortex.grey', maker: 'Beal International', name: 'モールテックス（壁）', code: '薄塗りモルタル', color: 'グレー', swatch: ['#9d9b95'], apply: (s) => { s.int.accentWall = mortex('#9d9b95', '#95938d'); }, note: '「室内塗り壁」の面積を入れると見積に反映' },
      { id: 'aw.porters', maker: 'ポーターズペイント', name: '塗装仕上げ（塗り壁用クロスの上）', code: 'ストーン ※色番号は品番メモに', color: 'ライムストーン系', swatch: ['#cfc8b8'], apply: (s) => { s.int.accentWall = { pattern: 'plaster', color: '#cfc8b8', color2: '#c7c0b0', roughness: 0.97, normalStrength: 0.38 }; }, note: '「室内塗り壁」の面積を入れると見積に反映' },
      { id: 'aw.solido', maker: 'ケイミュー', name: 'SOLIDO（室内壁）', code: '600×600 張り', color: '灰', swatch: ['#8d8b86'], apply: (s) => { s.int.accentWall = { pattern: 'solido', color: '#8d8b86', roughness: 0.92, normalStrength: 0.55 }; }, note: '「室内 SOLIDO 壁」の面積を入れると見積に反映' },
      { id: 'aw.sugi', maker: 'チャネルオリジナル', name: '杉羽目板（壁）', code: '木板 杉板', color: '自然塗装', swatch: ['#b08d66'], apply: (s) => { s.int.accentWall = sugi(); } },
    ],
  },
  {
    id: 'ceiling',
    label: '天井',
    part: '内部',
    products: [
      { id: 'ceil.cloth', maker: 'サンゲツ', name: 'ビニールクロス（壁と同じ）', code: 'SP シリーズ', color: 'ホワイト', swatch: ['#f1efeb'], apply: (s) => { s.int.ceiling = { pattern: 'plaster', color: '#f1efeb', color2: '#ebe9e4', roughness: 0.96, normalStrength: 0.12 }; } },
      { id: 'ceil.sugi', maker: 'チャネルオリジナル', name: '杉羽目板（天井）', code: '木板 杉板', color: '自然塗装', swatch: ['#b08d66'], apply: (s) => { s.int.ceiling = sugi(); }, note: 'LDK・吹抜の天井に。勾配天井と相性がよい' },
      { id: 'ceil.dark', maker: 'サンゲツ', name: 'ビニールクロス', code: '※品番は品番メモに', color: 'チャコール', swatch: ['#4d4c49'], apply: (s) => { s.int.ceiling = { pattern: 'plaster', color: '#4d4c49', color2: '#484744', roughness: 0.95, normalStrength: 0.12 }; }, note: '天井を暗くすると落ち着いた「こもり感」が出ます（天井高 2,400 以上で）' },
    ],
  },
  {
    id: 'door',
    label: '建具（室内ドア）',
    part: '内部',
    products: [
      { id: 'door.kamiya.cube', maker: '神谷コーポレーション', name: 'フルハイトドア F/S 片開', code: 'W07/H25（天井まで）ノブ YH クローム', color: 'クロス巻き（壁と同色）', swatch: ['#efede8'], apply: (s) => { s.int.door = { pattern: 'paint', color: s.int.wall.color, roughness: 0.6 }; }, estimate: { group: 'door', line: 'ib.doorKamiya' }, used: '個室・トイレ・収納の基本' },
      { id: 'door.kamiya.black', maker: '神谷コーポレーション', name: 'フルハイトドア F/S 片開', code: 'W07/H25（天井まで）', color: 'サタンブラック', swatch: ['#2a2a2a'], apply: (s) => { s.int.door = paint('#2a2a2a', 0.5); }, estimate: { group: 'door', line: 'ib.doorKamiya' }, used: 'LDK の入口・アクセントに' },
      { id: 'door.kamiya.glass', maker: '神谷コーポレーション', name: 'フルハイトドア CUBE アウトセット片引', code: 'W16/H25 CG-9', color: '透明ガラス・サタンブラック枠', swatch: ['#2a2a2a', '#cfd8dc'], apply: (s) => { s.int.door = paint('#2a2a2a', 0.45); }, estimate: { group: 'door', line: 'ib.doorKamiya' }, used: 'リビング入口（光と視線を通す）' },
      { id: 'door.custom.oak', maker: '造作（家具工事）', name: '造作建具', code: 'オーク集成材', color: 'クリア塗装', swatch: ['#c3a06f'], apply: (s) => { s.int.door = { pattern: 'wood', color: '#c3a06f', color2: '#ae8b5d', roughness: 0.55 }; }, estimate: { group: 'door', line: 'ib.doorKamiya' }, used: '猫用開口・プッシュラッチなど特注の扉' },
      { id: 'door.lixil.lasissa', maker: 'LIXIL', name: 'ラシッサ D', code: 'ラシッサD パレット', color: '木目（明）', swatch: ['#b89572'], apply: (s) => { s.int.door = { pattern: 'wood', color: '#b89572', color2: '#a2805d', roughness: 0.55 }; }, estimate: { group: 'door', line: 'ib.doorLixil' }, note: 'S シリーズ向け。色名はラシッサの色見本で' },
      { id: 'door.panasonic.veritis', maker: 'パナソニック', name: 'ベリティス', code: 'ハイドア（H2400）', color: 'ホワイトオーク柄', swatch: ['#d8c6a8'], apply: (s) => { s.int.door = { pattern: 'wood', color: '#d8c6a8', color2: '#c8b394', roughness: 0.55 }; }, estimate: { group: 'door', line: 'ib.doorLixil' }, note: 'S シリーズ向け' },
    ],
  },
  {
    id: 'baseboard',
    label: '巾木・見切り',
    part: '内部',
    products: [
      { id: 'bb.kamiya.white', maker: '神谷コーポレーション', name: '巾木', code: 't7×H30', color: 'ストーンホワイト', swatch: ['#ece9e2'], used: '基本（壁に溶ける細い巾木）' },
      { id: 'bb.kamiya.black', maker: '神谷コーポレーション', name: '巾木', code: 't7×H30', color: 'ブラック', swatch: ['#2a2a2a'], used: '濃い床・黒い建具と合わせて' },
      { id: 'bb.kamiya.grey', maker: '神谷コーポレーション', name: '巾木', code: 't7×H30', color: 'フラットグレー', swatch: ['#9a9893'] },
      { id: 'bb.soken.alumi', maker: '創建', name: 'アルミ巾木', code: 'アルミ平角 3×10', color: 'アルマイトシルバー', swatch: ['#c4c6c8'], used: '玄関ホール・LDK（モールテックス・タイルの床に）' },
    ],
  },
  {
    id: 'stair',
    label: '階段',
    part: '内部',
    products: [
      { id: 'stair.steel', maker: '造作（鉄工）', name: 'スチール階段', code: 'St 鉄骨 ＋ 木踏板 ＋ St 手摺', color: '黒皮鉄・オーク', swatch: ['#2a2a2a', '#c9a97c'], estimate: { group: 'stair', line: 'ib.stairSt' } },
      { id: 'stair.wood', maker: '造作', name: '木製スケルトン階段', code: '側板 黒塗りつぶし塗装 ＋ 木踏板', color: 'ブラック・オーク', swatch: ['#2a2a2a', '#c9a97c'], estimate: { group: 'stair', line: 'ib.stairSt' }, note: '見積は鉄骨階段の行で仮置き' },
    ],
  },
  {
    id: 'kitchen',
    label: 'キッチン',
    part: '内部',
    // 既定: 白壁・明るい床の内観はモルタライト、スレート床・グレー壁・木天井の内観はモルタブラック（御社の仕上げパースのキッチンは暗い色が多い）
    defaultFor: (d) => (/slate|grey|cedar|dark/.test(d.interiorId) ? 'kitchen.hl.line.mortablack' : 'kitchen.hl.line.mortalight'),
    products: [
      // LINE KITCHEN（ホームランディック標準）: カタログの GROUP1 メラミン化粧板・ステンレス、GROUP2 木目。天板はステンレス バイブレーション or 扉同色
      { id: 'kitchen.hl.line.mortalight', maker: 'ホームランディック', name: 'LINE KITCHEN ペニンシュラ', code: 'W2590 H850 カウンタースタイル', color: 'モルタライト（天板・扉同色）', swatch: ['#b3a995', '#b3a995'], apply: (s) => { s.int.furniture.counter = mortar('#b3a995', '#a89e8a'); s.int.furniture.cabinet = mortar('#b3a995', '#a89e8a'); }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' }, used: '天板・扉：モルタライト（定番）' },
      { id: 'kitchen.hl.line.mortablack', maker: 'ホームランディック', name: 'LINE KITCHEN ペニンシュラ', code: 'W2590 H850 カウンタースタイル', color: 'モルタブラック（天板・扉同色）', swatch: ['#3a3a36', '#3a3a36'], apply: (s) => { s.int.furniture.counter = mortar('#3a3a36', '#33332f'); s.int.furniture.cabinet = mortar('#3a3a36', '#33332f'); }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' } },
      { id: 'kitchen.hl.line.darkgrey', maker: 'ホームランディック', name: 'LINE KITCHEN ペニンシュラ', code: 'W2590 H850 カウンタースタイル', color: 'ダークグレー × ステンレス バイブレーション天板', swatch: ['#b9bbbd', '#2f3a40'], apply: (s) => { s.int.furniture.counter = stainless(); s.int.furniture.cabinet = paint('#2f3a40', 0.5); }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' } },
      { id: 'kitchen.hl.line.greystone', maker: 'ホームランディック', name: 'LINE KITCHEN ペニンシュラ', code: 'W2590 H850 カウンタースタイル', color: 'グレーストーン（天板・扉同色）', swatch: ['#5e6165', '#5e6165'], apply: (s) => { s.int.furniture.counter = mortar('#5e6165', '#55585c'); s.int.furniture.cabinet = mortar('#5e6165', '#55585c'); }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' } },
      { id: 'kitchen.hl.line.white', maker: 'ホームランディック', name: 'LINE KITCHEN ペニンシュラ', code: 'W2590 H850 カウンタースタイル', color: 'ナチュラルホワイト × ステンレス バイブレーション天板', swatch: ['#b9bbbd', '#f1f0ec'], apply: (s) => { s.int.furniture.counter = stainless(); s.int.furniture.cabinet = paint('#f1f0ec', 0.45); }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' } },
      { id: 'kitchen.hl.line.darkbeige', maker: 'ホームランディック', name: 'LINE KITCHEN ペニンシュラ', code: 'W2590 H850 カウンタースタイル', color: 'ダークベージュ（天板・扉同色）', swatch: ['#a89f99', '#a89f99'], apply: (s) => { s.int.furniture.counter = paint('#a89f99', 0.4); s.int.furniture.cabinet = paint('#a89f99', 0.5); }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' } },
      { id: 'kitchen.hl.line.walnut', maker: 'ホームランディック', name: 'LINE KITCHEN ペニンシュラ', code: 'W2590 H850 カウンタースタイル', color: 'ウォールナット（GROUP2）× ステンレス バイブレーション天板', swatch: ['#b9bbbd', '#6e4b36'], apply: (s) => { s.int.furniture.counter = stainless(); s.int.furniture.cabinet = { pattern: 'wood', color: '#6e4b36', color2: '#5a3c2b', roughness: 0.5 }; }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' } },
      { id: 'kitchen.hl.line.ash', maker: 'ホームランディック', name: 'LINE KITCHEN ペニンシュラ', code: 'W2590 H850 カウンタースタイル', color: 'アッシュ（GROUP2）× ステンレス バイブレーション天板', swatch: ['#b9bbbd', '#cfb58d'], apply: (s) => { s.int.furniture.counter = stainless(); s.int.furniture.cabinet = { pattern: 'wood', color: '#cfb58d', color2: '#bca27a', roughness: 0.5 }; }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' } },
      { id: 'kitchen.lixil.richelle', maker: 'LIXIL', name: 'リシェルSI ペニンシュラ I 型', code: 'W2585 セラミックトップ', color: 'セラミック グレー系 × 扉 木目（濃）', swatch: ['#7d7b78', '#6e5542'], apply: (s) => { s.int.furniture.counter = ceramic('#7d7b78', '#747270'); s.int.furniture.cabinet = { pattern: 'wood', color: '#6e5542', color2: '#5c4535', roughness: 0.5 }; }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' }, note: 'LINE キッチンと同等の金額として見積に載せます。色名はショールームで' },
      { id: 'kitchen.panasonic.lclass', maker: 'パナソニック', name: 'L クラス フラット対面', code: 'W2600 有機ガラス系ワークトップ', color: 'ホワイト × 扉 ライトグレー', swatch: ['#ecebe8', '#c6c5c1'], apply: (s) => { s.int.furniture.counter = { pattern: 'paint', color: '#ecebe8', roughness: 0.22 }; s.int.furniture.cabinet = paint('#c6c5c1', 0.45); }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' }, note: 'LINE キッチンと同等の金額として見積に載せます' },
      { id: 'kitchen.cleanup.centro', maker: 'クリナップ', name: 'セントロ ペニンシュラ', code: 'W2550 ステンレスワークトップ', color: 'ステンレス × 扉 チャコール', swatch: ['#b9bbbd', '#3a3b3d'], apply: (s) => { s.int.furniture.counter = { pattern: 'paint', color: '#b9bbbd', roughness: 0.35, metalness: 0.9 }; s.int.furniture.cabinet = paint('#3a3b3d', 0.5); }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' }, note: 'LINE キッチンと同等の金額として見積に載せます' },
      { id: 'kitchen.graftekt', maker: 'グラフテクト', name: 'メルクリオ ペニンシュラ', code: 'W2600 ラミネート天板', color: 'グレー系 × 扉 同色', swatch: ['#9a9893', '#9a9893'], apply: (s) => { s.int.furniture.counter = { pattern: 'plaster', color: '#9a9893', color2: '#92908b', roughness: 0.45, normalStrength: 0.15 }; s.int.furniture.cabinet = paint('#9a9893', 0.5); }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' }, note: 'LINE キッチンと同等の金額として見積に載せます。色名はショールームで' },
      { id: 'kitchen.custom.oak', maker: '造作（家具工事）', name: '造作キッチン', code: 'オーク突板 ＋ ステンレスバイブレーション天板', color: 'オーク × ステンレス', swatch: ['#b9bbbd', '#c3a06f'], apply: (s) => { s.int.furniture.counter = { pattern: 'paint', color: '#b9bbbd', roughness: 0.35, metalness: 0.9 }; s.int.furniture.cabinet = { pattern: 'wood', color: '#c3a06f', color2: '#ae8b5d', roughness: 0.5 }; }, estimate: { group: 'kitchen', line: 'eq.kitchenCustom' } },
      { id: 'kitchen.custom.mortex', maker: '造作（家具工事）', name: '造作キッチン', code: 'モールテックス仕上げ ＋ ステンレス天板', color: 'モールテックス グレー', swatch: ['#b9bbbd', '#a3a19b'], apply: (s) => { s.int.furniture.counter = stainless(); s.int.furniture.cabinet = mortex('#a3a19b', '#9b9993'); }, estimate: { group: 'kitchen', line: 'eq.kitchenCustom' } },
    ],
  },
  {
    id: 'cupboard',
    label: 'カップボード（背面収納）',
    part: '内部',
    products: [
      { id: 'cup.line.same', maker: 'ホームランディック', name: 'LINE KITCHEN カップボード ミックスタイプ', code: 'W2440〜2740 D450 H850 ＋ 吊戸 ＋ トール', color: 'キッチン扉と同色', swatch: ['#b3a995'], apply: (s) => { s.int.furniture.cabinet = { ...s.int.furniture.cabinet }; }, note: '扉はキッチンと同じ面材。取っ手なし' },
      { id: 'cup.custom.oak', maker: '造作（家具工事）', name: '造作カップボード', code: 'オーク突板 ＋ 石目カウンター', color: 'オーク', swatch: ['#c3a06f'], apply: (s) => { s.int.furniture.cabinet = { pattern: 'wood', color: '#c3a06f', color2: '#ae8b5d', roughness: 0.5 }; } },
      { id: 'cup.custom.white', maker: '造作（家具工事）', name: '造作カップボード', code: 'メラミン ホワイト ＋ 石目カウンター', color: 'ホワイト', swatch: ['#ecebe8'], apply: (s) => { s.int.furniture.cabinet = paint('#ecebe8', 0.5); } },
      { id: 'cup.lixil.richelle', maker: 'LIXIL', name: 'リシェルSI カップボード', code: 'W2700 トール＋カウンター', color: 'キッチン同色', swatch: ['#6e5542'], apply: (s) => { s.int.furniture.cabinet = { ...s.int.furniture.cabinet }; } },
    ],
  },
  {
    id: 'pendant',
    label: 'ダイニングの照明',
    part: '内部',
    products: [
      { id: 'pend.ph5', maker: 'Louis Poulsen', name: 'PH 5', code: 'ペンダント', color: 'ホワイト', swatch: ['#f2f0ea'], apply: (s) => { s.int.vocab = { ...(s.int.vocab ?? {}), pendant: 'ph5' }; }, note: '施主支給・照明計画の器具で。白い多層シェードで手元に柔らかい光' },
      { id: 'pend.dome', maker: '—', name: 'ドーム型ペンダント（大）', code: '照明計画の器具 ※品番は品番メモに', color: 'ブラック', swatch: ['#2a2a2a'], apply: (s) => { s.int.vocab = { ...(s.int.vocab ?? {}), pendant: 'dome' }; } },
      { id: 'pend.globes', maker: '—', name: 'ガラスの小さな球 2〜3 灯', code: '照明計画の器具 ※品番は品番メモに', color: '乳白ガラス', swatch: ['#efece4'], apply: (s) => { s.int.vocab = { ...(s.int.vocab ?? {}), pendant: 'globes' }; } },
    ],
  },
  {
    id: 'light',
    label: '照明の色（色温度）',
    part: '内部',
    products: [
      { id: 'light.3000', maker: 'DAIKO／パナソニック', name: 'ダウンライト・間接照明 一式', code: '電球色 3000K', color: '3000K', swatch: ['#ffd9a8'], apply: (s) => { s.int.lightKelvin = 3000; } },
      { id: 'light.2700', maker: 'DAIKO／パナソニック', name: 'ダウンライト・間接照明 一式', code: '電球色 2700K', color: '2700K', swatch: ['#ffc98a'], apply: (s) => { s.int.lightKelvin = 2700; } },
      { id: 'light.3500', maker: 'DAIKO／パナソニック', name: 'ダウンライト・間接照明 一式', code: '温白色 3500K', color: '3500K', swatch: ['#ffe7c4'], apply: (s) => { s.int.lightKelvin = 3500; } },
    ],
  },
  // ================= 水まわり =================
  {
    id: 'wetFloor',
    label: '水まわり・トイレの床',
    part: '内部',
    products: [
      { id: 'wet.sangetsu.is2033', maker: 'サンゲツ', name: 'フロアタイル モルテストーン', code: 'IS-2033-A 609.6×609.6 t2.5', swatch: ['#b9b5ad'], apply: (s) => { s.int.wetFloor = tile('#b9b5ad', 0.6096, 0.6096, '#b2aea6', 0.5); }, used: 'FC・脱衣室・トイレの定番' },
      { id: 'wet.sangetsu.is2032', maker: 'サンゲツ', name: 'フロアタイル モルテストーン', code: 'IS-2032 304.8×609.6 t2.5（馬目地）', swatch: ['#a9a59d'], apply: (s) => { s.int.wetFloor = tile('#a9a59d', 0.3048, 0.6096, '#a29e96', 0.5); }, used: 'トイレ（馬目地）・ランドリー（デザイン貼り）' },
      { id: 'wet.sangetsu.is2071', maker: 'サンゲツ', name: 'フロアタイル ワイドモルタル', code: 'IS-2071 t2.5', swatch: ['#a7a49e'], apply: (s) => { s.int.wetFloor = tile('#a7a49e', 0.914, 0.914, '#a09d97', 0.52); }, used: '脱衣ランドリー・トイレ' },
      { id: 'wet.denver', maker: '名古屋モザイク工業', name: 'デンバーストン（磁器質タイル）', code: 'PST-X3640 600角 t10', swatch: ['#8c8a85'], apply: (s) => { s.int.wetFloor = tile('#8c8a85', 0.6, 0.6, '#85837e', 0.45); }, note: 'LDK と同じタイルで続けると広く見えます' },
      { id: 'wet.sangetsu.cf', maker: 'サンゲツ', name: 'クッションフロア（石目）', code: 'H-FLOOR ※品番は品番メモに', color: 'ホワイトマーブル', swatch: ['#dcd9d3'], apply: (s) => { s.int.wetFloor = { pattern: 'marble', color: '#dcd9d3', color2: '#cfccc6', roughness: 0.35, size: 0.6, size2: 0.6 }; } },
    ],
  },
  {
    id: 'washWall',
    label: '洗面の壁',
    part: '内部',
    products: [
      { id: 'ww.cloth', maker: 'サンゲツ', name: 'ビニールクロス（ベースと同じ）', code: '', color: 'ホワイト', swatch: ['#efede8'] },
      { id: 'ww.danto.mov', maker: 'ダントータイル', name: '磁器質タイル', code: 'MOV-102 300×600', swatch: ['#c9c5bd'], used: '洗面・脱衣ランドリーの壁（タイル張り）', note: '色はサンプルで確認' },
      { id: 'ww.mirror', maker: '—', name: '一面鏡（接着張り）＋ 上下の間接照明', code: 'ブラックミラーも可', swatch: ['#9aa3a8'], used: '洗面ホール（ブラックミラー張り）' },
    ],
  },
  {
    id: 'vanity',
    label: '洗面台',
    part: '内部',
    products: [
      { id: 'vanity.custom1200', maker: '造作', name: '造作洗面 W1200', code: 'メラミンカウンター ＋ 実験用シンク', color: 'ホワイト', swatch: ['#e6e4df'], estimate: { group: 'vanity', line: 'cu.vanity1200' } },
      { id: 'vanity.custom750', maker: '造作', name: '造作洗面 W750', code: 'メラミンカウンター ＋ 実験用シンク', color: 'ホワイト', swatch: ['#e6e4df'], estimate: { group: 'vanity', line: 'cu.vanity750' } },
      { id: 'vanity.aica', maker: 'アイカ工業', name: 'スマートサニタリー（スタイリッシュカウンター）', code: 'オンボウルタイプ メラミン', swatch: ['#e9e7e2'], estimate: { group: 'vanity', line: 'cu.vanity1200' }, used: '1 階洗面', note: '見積は造作洗面 W1200 の行で仮置き' },
    ],
  },
  {
    id: 'bath',
    label: '浴室',
    part: '内部',
    products: [
      { id: 'bath.toto.sazana1616', maker: 'TOTO', name: 'サザナ 1616', code: 'HT シリーズ S タイプ', color: 'ほっカラリ床 × アクセントパネル', swatch: ['#e9e7e2', '#8e8c88'], estimate: { group: 'bath', line: 'eq.bath1616' }, note: '壁パネルの色はショールームで' },
      { id: 'bath.toto.sazana1620', maker: 'TOTO', name: 'サザナ 1620', code: 'HT シリーズ S タイプ', color: 'ほっカラリ床 × アクセントパネル', swatch: ['#e9e7e2', '#8e8c88'], estimate: { group: 'bath', line: 'eq.bath1620' }, note: '壁パネルの色はショールームで' },
    ],
  },
  // ================= 設備（コーディネートではなく仕様の確認） =================
  {
    id: 'toilet',
    label: 'トイレ',
    part: '設備',
    equipment: true,
    products: [{ id: 'toilet.toto', maker: 'TOTO', name: '1 階 NJ1 ／ 2 階 ZJ1', code: 'NJ1・ZJ1（ZJ2 も可）', color: 'ホワイト', swatch: ['#f4f3f0'] }],
  },
  {
    id: 'water',
    label: '給湯',
    part: '設備',
    equipment: true,
    products: [
      { id: 'water.ecocute360', maker: '三菱電機', name: 'エコキュート 360L', code: 'SRT-S376', swatch: ['#dcdcdc'], estimate: { group: 'water', line: 'eq.ecocute360' } },
      { id: 'water.ecocute460', maker: '三菱電機', name: 'エコキュート 460L', code: 'SRT-S466', swatch: ['#dcdcdc'], estimate: { group: 'water', line: 'eq.ecocute460' } },
      { id: 'water.ecoone', maker: 'リンナイ', name: 'エコワン 70L', code: 'ECO ONE ハイブリッド', swatch: ['#dcdcdc'], estimate: { group: 'water', line: 'eq.ecoone' }, note: 'ガス配管の行が入ります' },
      { id: 'water.ecojozu', maker: 'リンナイ', name: 'エコジョーズ', code: 'RUF-E', swatch: ['#dcdcdc'], estimate: { group: 'water', line: 'eq.ecojozu' } },
    ],
  },
  {
    id: 'vent',
    label: '換気',
    part: '設備',
    equipment: true,
    products: [
      { id: 'vent.lufro', maker: '日本住環境', name: 'ルフロ 400（ダクト式第三種）', code: 'LUFRO 400', swatch: ['#dcdcdc'], estimate: { group: 'vent', line: 'eq.vent3lufro' } },
      { id: 'vent.wall', maker: 'パナソニック', name: '壁式 第三種換気', code: 'パイプファン', swatch: ['#dcdcdc'], estimate: { group: 'vent', line: 'eq.vent3wall' } },
      { id: 'vent.lossnay', maker: '三菱電機', name: 'ロスナイ（ダクト式第一種）', code: 'VL-', swatch: ['#dcdcdc'], estimate: { group: 'vent', line: 'eq.vent1lossnay' } },
      { id: 'vent.sumika', maker: 'マーベックス', name: '澄家（第一種 全熱交換）', code: 'sumika', swatch: ['#dcdcdc'], estimate: { group: 'vent', line: 'eq.vent1sumika' } },
    ],
  },
  {
    id: 'ac',
    label: '空調',
    part: '設備',
    equipment: true,
    products: [
      { id: 'ac.floor', maker: 'ダイキン／三菱', name: '床下エアコン', code: '壁掛け 1 台を床下へ', swatch: ['#dcdcdc'], estimate: { group: 'ac', line: 'eq.acFloor' } },
      { id: 'ac.daikin', maker: 'ダイキン', name: 'アメニティエアコン（ビルトイン）', code: 'ハウジングエアコン', swatch: ['#dcdcdc'], estimate: { group: 'ac', line: 'eq.acDaikin' } },
    ],
  },
  {
    id: 'pv',
    label: '太陽光',
    part: '設備',
    equipment: true,
    products: [
      { id: 'pv.qcells', maker: 'Q セルズ', name: '太陽光 4.3kW', code: 'Q.TRON パワコン込', swatch: ['#1c2a3a'], estimate: { group: 'pv', line: 'eq.pv43' } },
      { id: 'pv.none', maker: '—', name: '太陽光なし', code: '', swatch: ['#dddbd5'], estimate: { group: 'pv', line: 'eq.pvNone' } },
    ],
  },
];

/** 以前の商品 id（保存したプロジェクト・体験リンク）→ 今の id */
const LEGACY_IDS: Record<string, string> = {
  'acc.solido.rust': 'acc.solido.black',
  'soffit.oak': 'soffit.cedar',
  'floor.nagoya.600': 'floor.denver',
  'floor.sangetsu.ft.stone': 'floor.sangetsu.mortestone',
  'floor.sangetsu.ft.wood': 'floor.iemon.smoke',
  'wet.nagoya.600.grey': 'wet.denver',
  'wet.nagoya.600.charcoal': 'wet.denver',
  'wet.nagoya.300': 'wet.sangetsu.is2032',
  'wet.sangetsu.ft': 'wet.sangetsu.is2033',
  'cup.lixil': 'cup.lixil.richelle',
};
export const resolveProductId = (id: string): string => LEGACY_IDS[id] ?? id;

/** メーカー（の検索結果）のカタログページ: 商品名と品番でメーカーのサイトを探す */
const MAKER_SITE: Record<string, string> = {
  アイカ工業: 'aica.co.jp',
  ケイミュー: 'kmew.co.jp',
  LIXIL: 'lixil.co.jp',
  'YKK AP': 'ykkap.co.jp',
  サンゲツ: 'sangetsu.co.jp',
  TOTO: 'toto.co.jp',
  パナソニック: 'panasonic.jp',
  クリナップ: 'cleanup.jp',
  リリカラ: 'lilycolor.co.jp',
  三菱電機: 'mitsubishielectric.co.jp',
  リンナイ: 'rinnai.co.jp',
  ダイキン: 'daikin.co.jp',
};
export function catalogUrl(p: Product): string | undefined {
  if (p.maker === '—' || /^造作/.test(p.maker) || p.maker === 'ホームランディック') return undefined;
  const code = p.code.replace(/※.*$/, '').trim();
  const q = [p.maker, p.name.replace(/（.*?）/g, ''), /[A-Z]{2,}-?\d/.test(code) ? code.split(' ')[0] : ''].filter(Boolean).join(' ');
  const site = MAKER_SITE[p.maker];
  return `https://www.google.com/search?q=${encodeURIComponent(site ? `site:${site} ${q}` : q)}`;
}

export function productById(id: string): Product | undefined {
  id = resolveProductId(id);
  for (const c of FINISH_CATEGORIES) for (const p of c.products) if (p.id === id) return p;
  return undefined;
}

/** 今の選択（無ければテイストからの既定） */
export function selectedProduct(cat: FinishCategory, d: DesignOptions): Product {
  const id = resolveProductId(d.finishes?.[cat.id] ?? cat.defaultFor?.(d) ?? cat.products[0].id);
  return cat.products.find((p) => p.id === id) ?? cat.products[0];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** テイストにコーディネートの選択を重ねた外観・内観 */
export function stylesFor(d: DesignOptions): { ext: ExteriorStyle; int: InteriorStyle } {
  const s = { ext: clone(exteriorById(d.exteriorId)), int: clone(interiorById(d.interiorId)) };
  for (const cat of FINISH_CATEGORIES) {
    // キッチン・カップボードは選んでいなくても既定の商品（LINE KITCHEN）を 3D に反映する（仕上げ表と 3D を一致させる）。他の部位はテイストの素材のまま
    const raw = d.finishes?.[cat.id] ?? (cat.id === 'kitchen' || cat.id === 'cupboard' ? selectedProduct(cat, d).id : undefined);
    if (!raw) continue;
    const id = resolveProductId(raw);
    cat.products.find((p) => p.id === id)?.apply?.(s);
  }
  return s;
}
export const exteriorFor = (d: DesignOptions) => stylesFor(d).ext;
export const interiorFor = (d: DesignOptions) => stylesFor(d).int;

/** 選んだ商品に対応する見積の行（group → line） */
export function estimateGroupsFor(d: DesignOptions): Record<string, string> {
  const g: Record<string, string> = {};
  for (const cat of FINISH_CATEGORIES) {
    const raw = d.finishes?.[cat.id];
    if (!raw) continue;
    const id = resolveProductId(raw);
    const p = cat.products.find((x) => x.id === id);
    if (p?.estimate) g[p.estimate.group] = p.estimate.line;
  }
  return g;
}
