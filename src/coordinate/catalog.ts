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
}

export interface FinishCategory {
  id: string;
  label: string;
  part: '外部' | '内部' | '設備';
  /** テイスト（プリセット）から決まる既定（product id）。無ければ先頭 */
  defaultFor?: (d: DesignOptions) => string;
  products: Product[];
}

const paint = (color: string, roughness = 0.55): MatSpec => ({ pattern: 'paint', color, roughness });

export const FINISH_CATEGORIES: FinishCategory[] = [
  {
    id: 'extWall',
    label: '外壁',
    part: '外部',
    defaultFor: (d) => (/galva|gl/.test(d.exteriorId) ? 'ext.gl.black' : 'ext.jp.mid'),
    products: [
      { id: 'ext.jp.white', maker: 'アイカ工業', name: 'ジョリパット', code: 'JP-100 ゆず肌', color: 'ホワイト', swatch: ['#e8e6e0'], apply: (s) => { s.ext.wall = { ...s.ext.wall, pattern: 'stucco', color: '#e8e6e0', color2: '#e2e0da' }; }, estimate: { group: 'extwall', line: 'ext.jolypat' } },
      { id: 'ext.jp.light', maker: 'アイカ工業', name: 'ジョリパット', code: 'JP-100 ゆず肌', color: 'ライトグレー', swatch: ['#cfcdc7'], apply: (s) => { s.ext.wall = { ...s.ext.wall, pattern: 'stucco', color: '#cfcdc7', color2: '#c8c6c0' }; }, estimate: { group: 'extwall', line: 'ext.jolypat' } },
      { id: 'ext.jp.mid', maker: 'アイカ工業', name: 'ジョリパット', code: 'JP-100 ゆず肌', color: '中間グレー', swatch: ['#9a9893'], apply: (s) => { s.ext.wall = { ...s.ext.wall, pattern: 'stucco', color: '#9a9893', color2: '#93918c' }; }, estimate: { group: 'extwall', line: 'ext.jolypat' } },
      { id: 'ext.jp.dark', maker: 'アイカ工業', name: 'ジョリパット', code: 'JP-100 ゆず肌', color: 'ダークグレー', swatch: ['#5d5c59'], apply: (s) => { s.ext.wall = { ...s.ext.wall, pattern: 'stucco', color: '#5d5c59', color2: '#575653' }; }, estimate: { group: 'extwall', line: 'ext.jolypat' } },
      { id: 'ext.sto.white', maker: 'Sto', name: 'StoColor Lotusan（塗り壁）', code: 'Sto 塗り壁 シリコン', color: 'オフホワイト', swatch: ['#ebe9e3'], apply: (s) => { s.ext.wall = { ...s.ext.wall, pattern: 'stucco', color: '#ebe9e3', color2: '#e5e3dd', normalStrength: 0.25 }; }, estimate: { group: 'extwall', line: 'ext.sto' } },
      { id: 'ext.sto.grey', maker: 'Sto', name: 'StoColor Lotusan（塗り壁）', code: 'Sto 塗り壁 シリコン', color: 'グレージュ', swatch: ['#b3aea4'], apply: (s) => { s.ext.wall = { ...s.ext.wall, pattern: 'stucco', color: '#b3aea4', color2: '#aca79d', normalStrength: 0.25 }; }, estimate: { group: 'extwall', line: 'ext.sto' } },
      { id: 'ext.gl.black', maker: 'アイジー工業', name: 'ガルバリウム鋼板 Kスパン', code: 'SGL ガルスパン', color: 'ブラック', swatch: ['#2b2c2e'], apply: (s) => { s.ext.wall = { pattern: 'standingSeam', color: '#2b2c2e', roughness: 0.5, metalness: 0.4 }; }, estimate: { group: 'extwall', line: 'ext.gl' } },
      { id: 'ext.gl.silver', maker: 'アイジー工業', name: 'ガルバリウム鋼板 Kスパン', code: 'SGL ガルスパン', color: '銀黒', swatch: ['#6b6d70'], apply: (s) => { s.ext.wall = { pattern: 'standingSeam', color: '#6b6d70', roughness: 0.45, metalness: 0.5 }; }, estimate: { group: 'extwall', line: 'ext.gl' } },
    ],
  },
  {
    id: 'accent',
    label: 'アクセント外壁',
    part: '外部',
    defaultFor: (d) => (exteriorById(d.exteriorId).accent ? 'acc.solido.black' : 'acc.none'),
    products: [
      { id: 'acc.none', maker: '—', name: 'アクセントなし', code: '', swatch: ['#dddbd5'], apply: (s) => { s.ext.accent = undefined; s.ext.accentRule = 'none'; }, note: 'SOLIDO の行が 0 になります' },
      { id: 'acc.solido.black', maker: 'ケイミュー', name: 'SOLIDO typeF LAP', code: 'SOLIDO LAP', color: '鉄黒', swatch: ['#3f3d3a'], apply: (s) => { s.ext.accent = { pattern: 'solido', color: '#3f3d3a', roughness: 0.92, normalStrength: 0.6 }; if (s.ext.accentRule === 'none') s.ext.accentRule = 'entrance'; } },
      { id: 'acc.solido.grey', maker: 'ケイミュー', name: 'SOLIDO typeF LAP', code: 'SOLIDO LAP', color: '灰', swatch: ['#8d8b86'], apply: (s) => { s.ext.accent = { pattern: 'solido', color: '#8d8b86', roughness: 0.92, normalStrength: 0.6 }; if (s.ext.accentRule === 'none') s.ext.accentRule = 'entrance'; } },
      { id: 'acc.solido.rust', maker: 'ケイミュー', name: 'SOLIDO typeF LAP', code: 'SOLIDO LAP', color: '錆茶', swatch: ['#6a5345'], apply: (s) => { s.ext.accent = { pattern: 'solido', color: '#6a5345', roughness: 0.92, normalStrength: 0.6 }; if (s.ext.accentRule === 'none') s.ext.accentRule = 'entrance'; } },
      { id: 'acc.wood', maker: 'チャネルオリジナル', name: 'ウイルウォール（木板）', code: 'レッドシダー', color: 'ナチュラル', swatch: ['#9c7b58'], apply: (s) => { s.ext.accent = { pattern: 'wood', color: '#9c7b58', color2: '#86683f', roughness: 0.8 }; if (s.ext.accentRule === 'none') s.ext.accentRule = 'entrance'; } },
    ],
  },
  {
    id: 'roof',
    label: '屋根',
    part: '外部',
    products: [
      { id: 'roof.gl.black', maker: '日鉄鋼板', name: 'ガルバリウム鋼板 立平葺き', code: 'ニスクカラー GL0.35', color: 'ブラック', swatch: ['#2a2b2d'], apply: (s) => { s.ext.roof.material = { pattern: 'standingSeam', color: '#2a2b2d', roughness: 0.5, metalness: 0.4 }; s.ext.roof.fascia = '#1f1f1f'; } },
      { id: 'roof.gl.silver', maker: '日鉄鋼板', name: 'ガルバリウム鋼板 立平葺き', code: 'ニスクカラー GL0.35', color: 'シルバー', swatch: ['#9a9c9e'], apply: (s) => { s.ext.roof.material = { pattern: 'standingSeam', color: '#9a9c9e', roughness: 0.4, metalness: 0.6 }; } },
    ],
  },
  {
    id: 'soffit',
    label: '軒天（軒の裏）',
    part: '外部',
    products: [
      { id: 'soffit.same', maker: '—', name: '外壁と同色の塗り壁', code: '', color: '外壁同色', swatch: ['#9a9893'], apply: (s) => { s.ext.roof.soffit = { pattern: 'paint', color: s.ext.wall.color, roughness: 0.95 }; }, note: '軒の裏まで外壁と同じ色で回し、箱の輪郭を強調します' },
      { id: 'soffit.white', maker: 'ケイミュー', name: '軒天ボード（無塗装板 塗装）', code: '軒天 12mm', color: 'ホワイト', swatch: ['#efeeea'], apply: (s) => { s.ext.roof.soffit = { pattern: 'paint', color: '#efeeea', roughness: 0.9 }; } },
      { id: 'soffit.black', maker: 'ケイミュー', name: '軒天ボード（無塗装板 塗装）', code: '軒天 12mm', color: 'ブラック', swatch: ['#2c2c2d'], apply: (s) => { s.ext.roof.soffit = { pattern: 'paint', color: '#2c2c2d', roughness: 0.85 }; } },
      { id: 'soffit.cedar', maker: 'チャネルオリジナル', name: 'レッドシダー 軒天羽目板', code: 'ウイルウォール 軒天', color: 'ナチュラル', swatch: ['#a88762'], apply: (s) => { s.ext.roof.soffit = { pattern: 'woodSiding', color: '#a88762', color2: '#8f6f4c', roughness: 0.75, size: 0.1 }; } },
      { id: 'soffit.oak', maker: 'ニチハ', name: '軒天 木目調ボード', code: 'センターサイディング 軒天', color: 'ライトオーク', swatch: ['#c2a37a'], apply: (s) => { s.ext.roof.soffit = { pattern: 'woodSiding', color: '#c2a37a', color2: '#ad8f66', roughness: 0.7, size: 0.1 }; } },
    ],
  },
  {
    id: 'sash',
    label: 'サッシ',
    part: '外部',
    products: [
      { id: 'sash.tw.black', maker: 'LIXIL', name: 'TW（高性能樹脂複合）', code: 'TW トリプルガラス', color: 'ブラック', swatch: ['#1f1f1f'], apply: (s) => { s.ext.frame = { color: '#1f1f1f', metalness: 0.3 }; }, estimate: { group: 'sash', line: 'sash.tw' } },
      { id: 'sash.tw.silver', maker: 'LIXIL', name: 'TW（高性能樹脂複合）', code: 'TW トリプルガラス', color: 'ナチュラルシルバー', swatch: ['#b9bcbf'], apply: (s) => { s.ext.frame = { color: '#b9bcbf', metalness: 0.6 }; }, estimate: { group: 'sash', line: 'sash.tw' } },
      { id: 'sash.tw.white', maker: 'LIXIL', name: 'TW（高性能樹脂複合）', code: 'TW トリプルガラス', color: 'ホワイト', swatch: ['#f0f0ee'], apply: (s) => { s.ext.frame = { color: '#f0f0ee', metalness: 0.2 }; }, estimate: { group: 'sash', line: 'sash.tw' } },
      { id: 'sash.thermos.black', maker: 'LIXIL', name: 'サーモスⅡ-H', code: 'サーモス2H ペアガラス', color: 'ブラック', swatch: ['#1f1f1f'], apply: (s) => { s.ext.frame = { color: '#1f1f1f', metalness: 0.3 }; }, estimate: { group: 'sash', line: 'sash.thermos' }, note: 'S シリーズ標準' },
      { id: 'sash.thermos.silver', maker: 'LIXIL', name: 'サーモスⅡ-H', code: 'サーモス2H ペアガラス', color: 'ナチュラルシルバー', swatch: ['#b9bcbf'], apply: (s) => { s.ext.frame = { color: '#b9bcbf', metalness: 0.6 }; }, estimate: { group: 'sash', line: 'sash.thermos' } },
    ],
  },
  {
    id: 'entDoor',
    label: '玄関ドア',
    part: '外部',
    products: [
      { id: 'door.venato.black', maker: 'YKK AP', name: 'ヴェナート D30 片開き', code: 'D30 ストレートハンドル', color: 'ブラック', swatch: ['#2a2a2a'], apply: (s) => { s.ext.entranceDoor = paint('#2a2a2a', 0.5); }, estimate: { group: 'entDoor', line: 'sash.doorVenato' } },
      { id: 'door.venato.walnut', maker: 'YKK AP', name: 'ヴェナート D30 片開き', code: 'D30 ストレートハンドル', color: 'ショコラウォールナット', swatch: ['#5a3d2b'], apply: (s) => { s.ext.entranceDoor = { pattern: 'wood', color: '#5a3d2b', color2: '#4a3223', roughness: 0.55 }; }, estimate: { group: 'entDoor', line: 'sash.doorVenato' } },
      { id: 'door.venato.oak', maker: 'YKK AP', name: 'ヴェナート D30 片開き', code: 'D30 ストレートハンドル', color: 'キャラメルチーク', swatch: ['#a2764d'], apply: (s) => { s.ext.entranceDoor = { pattern: 'wood', color: '#a2764d', color2: '#8c6340', roughness: 0.55 }; }, estimate: { group: 'entDoor', line: 'sash.doorVenato' } },
      { id: 'door.concord.black', maker: 'YKK AP', name: 'コンコード 玄関引き戸', code: 'コンコード S30', color: 'ブラック', swatch: ['#2a2a2a'], apply: (s) => { s.ext.entranceDoor = paint('#2a2a2a', 0.5); }, estimate: { group: 'entDoor', line: 'sash.doorConcord' } },
    ],
  },
  {
    id: 'floor',
    label: '床材',
    part: '内部',
    defaultFor: (d) => (/slate|tile/.test(d.interiorId) ? 'floor.tile.black' : 'floor.channel.oak'),
    products: [
      { id: 'floor.channel.oak', maker: 'チャネルオリジナル', name: 'オーク 挽板フローリング', code: '挽板 t15 W150', color: 'ナチュラル（自然塗装）', swatch: ['#c9a97c'], apply: (s) => { s.int.floor = { pattern: 'woodFloor', color: '#c9a97c', color2: '#b8976c', roughness: 0.55, size: 0.15 }; }, estimate: { group: 'floor', line: 'ib.floorChannel' } },
      { id: 'floor.iemon.clear', maker: 'イエモン', name: 'ジャイロオーク 挽板', code: '挽板 t15 W158', color: 'クリア', swatch: ['#cdb089'], apply: (s) => { s.int.floor = { pattern: 'woodFloor', color: '#cdb089', color2: '#bd9e77', roughness: 0.5, size: 0.158 }; }, estimate: { group: 'floor', line: 'ib.floorIemonClear' } },
      { id: 'floor.iemon.smoke', maker: 'イエモン', name: 'ジャイロオーク 挽板', code: '挽板 t15 W158', color: 'スモーク', swatch: ['#a88f6c'], apply: (s) => { s.int.floor = { pattern: 'woodFloor', color: '#a88f6c', color2: '#98805f', roughness: 0.5, size: 0.158 }; }, estimate: { group: 'floor', line: 'ib.floorIemonClear' } },
      { id: 'floor.iemon.mocha', maker: 'イエモン', name: 'ジャイロオーク 挽板', code: '挽板 t15 W158', color: 'モカ', swatch: ['#8c7152'], apply: (s) => { s.int.floor = { pattern: 'woodFloor', color: '#8c7152', color2: '#7c6347', roughness: 0.5, size: 0.158 }; }, estimate: { group: 'floor', line: 'ib.floorIemonMocha' } },
      { id: 'floor.ioc.oak', maker: 'IOC', name: 'オーク 無垢フローリング', code: '無垢 t15 W120', color: 'ナチュラル', swatch: ['#d2b58d'], apply: (s) => { s.int.floor = { pattern: 'woodFloor', color: '#d2b58d', color2: '#c2a47c', roughness: 0.6, size: 0.12 }; }, estimate: { group: 'floor', line: 'ib.floorIoc' }, note: '無垢。床塗装の行（任意）も' },
      { id: 'floor.tile.black', maker: 'サンワカンパニー', name: '磁器質タイル 600角', code: 'セメント調 600×600', color: 'チャコール', swatch: ['#3b3a38'], apply: (s) => { s.int.floor = { pattern: 'tileFloor', color: '#3b3a38', roughness: 0.4, size: 0.6, size2: 0.6, tile: 1.2 }; }, estimate: { group: 'floor', line: 'ib.floorChannel' }, note: 'LDK タイル床は「室内タイル床」の数量で別途' },
    ],
  },
  {
    id: 'wall',
    label: '内壁',
    part: '内部',
    products: [
      { id: 'wall.cloth.white', maker: 'サンゲツ', name: 'ビニールクロス AA級', code: 'SP シリーズ', color: 'ホワイト（石目）', swatch: ['#efede8'], apply: (s) => { s.int.wall = { pattern: 'plaster', color: '#efede8', color2: '#e8e5df', roughness: 0.95, normalStrength: 0.18 }; }, estimate: { group: 'cloth', line: 'it.clothAA' } },
      { id: 'wall.cloth.grey', maker: 'サンゲツ', name: 'ビニールクロス AA級', code: 'SP シリーズ', color: 'ライトグレー', swatch: ['#dcdad5'], apply: (s) => { s.int.wall = { pattern: 'plaster', color: '#dcdad5', color2: '#d5d3ce', roughness: 0.95, normalStrength: 0.18 }; }, estimate: { group: 'cloth', line: 'it.clothAA' } },
      { id: 'wall.porters.stone', maker: 'PORTER’S PAINTS', name: 'ポーターズペイント', code: 'ストーンペイント', color: 'ライムストーン', swatch: ['#d9d4c8'], apply: (s) => { s.int.wall = { pattern: 'plaster', color: '#d9d4c8', color2: '#d1ccbf', roughness: 0.97, normalStrength: 0.35 }; }, note: '「室内塗り壁」の面積を入れると見積に反映' },
    ],
  },
  {
    id: 'door',
    label: '建具',
    part: '内部',
    products: [
      { id: 'door.kamiya.cube', maker: '神谷コーポレーション', name: 'フルハイトドア キューブ', code: 'CUBE 天井高 2,400', color: '壁と同色（クロス巻き）', swatch: ['#efede8'], apply: (s) => { s.int.door = { pattern: 'paint', color: s.int.wall.color, roughness: 0.6 }; }, estimate: { group: 'door', line: 'ib.doorKamiya' } },
      { id: 'door.kamiya.black', maker: '神谷コーポレーション', name: 'フルハイトドア キューブ', code: 'CUBE 天井高 2,400', color: 'ブラック', swatch: ['#2a2a2a'], apply: (s) => { s.int.door = paint('#2a2a2a', 0.5); }, estimate: { group: 'door', line: 'ib.doorKamiya' } },
      { id: 'door.lixil.lasissa', maker: 'LIXIL', name: 'ラシッサ D', code: 'ラシッサD パレット', color: 'クリエモカ', swatch: ['#b89572'], apply: (s) => { s.int.door = { pattern: 'wood', color: '#b89572', color2: '#a2805d', roughness: 0.55 }; }, estimate: { group: 'door', line: 'ib.doorLixil' }, note: 'S シリーズ向け' },
    ],
  },
  {
    id: 'stair',
    label: '階段',
    part: '内部',
    products: [
      { id: 'stair.steel', maker: '造作（鉄工）', name: 'スチール階段', code: 'St 鉄骨 ＋ 木踏板 ＋ St 手摺', color: '黒皮鉄・オーク', swatch: ['#2a2a2a', '#c9a97c'], estimate: { group: 'stair', line: 'ib.stairSt' } },
    ],
  },
  {
    id: 'kitchen',
    label: 'キッチン',
    part: '設備',
    products: [
      { id: 'kitchen.hl.line.stone', maker: 'ホームランディック', name: 'LINE キッチン ペニンシュラ', code: 'HL オリジナル W2550', color: 'セラミック天板 グレー × 扉 グレージュ', swatch: ['#8e8c88', '#c9c3b8'], apply: (s) => { s.int.furniture.counter = { pattern: 'stone', color: '#8e8c88', color2: '#84827e', roughness: 0.35, size: 3.2 }; s.int.furniture.cabinet = paint('#c9c3b8', 0.5); }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' } },
      { id: 'kitchen.hl.line.white', maker: 'ホームランディック', name: 'LINE キッチン ペニンシュラ', code: 'HL オリジナル W2550', color: 'セラミック天板 ホワイト × 扉 ホワイト', swatch: ['#dcdad5', '#e6e4df'], apply: (s) => { s.int.furniture.counter = { pattern: 'stone', color: '#dcdad5', color2: '#d0cec8', roughness: 0.35, size: 3.2 }; s.int.furniture.cabinet = paint('#e6e4df', 0.5); }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' } },
      { id: 'kitchen.hl.line.black', maker: 'ホームランディック', name: 'LINE キッチン ペニンシュラ', code: 'HL オリジナル W2550', color: 'セラミック天板 ブラック × 扉 ブラック', swatch: ['#2c2c2c', '#303030'], apply: (s) => { s.int.furniture.counter = { pattern: 'stone', color: '#2c2c2c', color2: '#262626', roughness: 0.35, size: 3.2 }; s.int.furniture.cabinet = paint('#303030', 0.5); }, estimate: { group: 'kitchen', line: 'eq.kitchenHl' } },
      { id: 'kitchen.custom.oak', maker: '造作（家具工事）', name: '造作キッチン', code: 'オーク突板 ＋ ステンレスバイブレーション天板', color: 'オーク × ステンレス', swatch: ['#b9bbbd', '#c3a06f'], apply: (s) => { s.int.furniture.counter = { pattern: 'paint', color: '#b9bbbd', roughness: 0.35, metalness: 0.9 }; s.int.furniture.cabinet = { pattern: 'wood', color: '#c3a06f', color2: '#ae8b5d', roughness: 0.5 }; }, estimate: { group: 'kitchen', line: 'eq.kitchenCustom' } },
    ],
  },
  {
    id: 'bath',
    label: '浴室',
    part: '設備',
    products: [
      { id: 'bath.toto.sazana1616', maker: 'TOTO', name: 'サザナ 1616', code: 'HT シリーズ Tタイプ', color: 'ほっカラリ床 × アクセントパネル', swatch: ['#e9e7e2', '#8e8c88'], estimate: { group: 'bath', line: 'eq.bath1616' } },
      { id: 'bath.toto.sazana1620', maker: 'TOTO', name: 'サザナ 1620', code: 'HT シリーズ Tタイプ', color: 'ほっカラリ床 × アクセントパネル', swatch: ['#e9e7e2', '#8e8c88'], estimate: { group: 'bath', line: 'eq.bath1620' } },
    ],
  },
  {
    id: 'vanity',
    label: '洗面',
    part: '設備',
    products: [
      { id: 'vanity.custom1200', maker: '造作', name: '造作洗面 W1200', code: 'メラミンカウンター ＋ 実験用シンク', color: 'ホワイト', swatch: ['#e6e4df'], estimate: { group: 'vanity', line: 'cu.vanity1200' } },
      { id: 'vanity.custom750', maker: '造作', name: '造作洗面 W750', code: 'メラミンカウンター ＋ 実験用シンク', color: 'ホワイト', swatch: ['#e6e4df'], estimate: { group: 'vanity', line: 'cu.vanity750' } },
    ],
  },
  {
    id: 'toilet',
    label: 'トイレ',
    part: '設備',
    products: [{ id: 'toilet.toto', maker: 'TOTO', name: '1階 NJ1 ／ 2階 ZJ1', code: 'NJ1・ZJ1', color: 'ホワイト', swatch: ['#f4f3f0'] }],
  },
  {
    id: 'water',
    label: '給湯',
    part: '設備',
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
    products: [
      { id: 'vent.lufro', maker: '日本住環境', name: 'ルフロ400（ダクト式第三種）', code: 'LUFRO 400', swatch: ['#dcdcdc'], estimate: { group: 'vent', line: 'eq.vent3lufro' } },
      { id: 'vent.wall', maker: 'パナソニック', name: '壁式 第三種換気', code: 'パイプファン', swatch: ['#dcdcdc'], estimate: { group: 'vent', line: 'eq.vent3wall' } },
      { id: 'vent.lossnay', maker: '三菱電機', name: 'ロスナイ（ダクト式第一種）', code: 'VL-', swatch: ['#dcdcdc'], estimate: { group: 'vent', line: 'eq.vent1lossnay' } },
      { id: 'vent.sumika', maker: 'マーベックス', name: '澄家（第一種 全熱交換）', code: 'sumika', swatch: ['#dcdcdc'], estimate: { group: 'vent', line: 'eq.vent1sumika' } },
    ],
  },
  {
    id: 'ac',
    label: '空調',
    part: '設備',
    products: [
      { id: 'ac.floor', maker: 'ダイキン／三菱', name: '床下エアコン', code: '壁掛け 1 台を床下へ', swatch: ['#dcdcdc'], estimate: { group: 'ac', line: 'eq.acFloor' } },
      { id: 'ac.daikin', maker: 'ダイキン', name: 'アメニティエアコン（ビルトイン）', code: 'ハウジングエアコン', swatch: ['#dcdcdc'], estimate: { group: 'ac', line: 'eq.acDaikin' } },
    ],
  },
  {
    id: 'pv',
    label: '太陽光',
    part: '設備',
    products: [
      { id: 'pv.qcells', maker: 'Qセルズ', name: '太陽光 4.3kW', code: 'Q.TRON パワコン込', swatch: ['#1c2a3a'], estimate: { group: 'pv', line: 'eq.pv43' } },
      { id: 'pv.none', maker: '—', name: '太陽光なし', code: '', swatch: ['#dddbd5'], estimate: { group: 'pv', line: 'eq.pvNone' } },
    ],
  },
  {
    id: 'light',
    label: '照明',
    part: '設備',
    products: [
      { id: 'light.3000', maker: 'DAIKO／パナソニック', name: 'ダウンライト・間接照明 一式', code: '電球色 3000K', color: '3000K', swatch: ['#ffd9a8'], apply: (s) => { s.int.lightKelvin = 3000; } },
      { id: 'light.2700', maker: 'DAIKO／パナソニック', name: 'ダウンライト・間接照明 一式', code: '電球色 2700K', color: '2700K', swatch: ['#ffc98a'], apply: (s) => { s.int.lightKelvin = 2700; } },
      { id: 'light.3500', maker: 'DAIKO／パナソニック', name: 'ダウンライト・間接照明 一式', code: '温白色 3500K', color: '3500K', swatch: ['#ffe7c4'], apply: (s) => { s.int.lightKelvin = 3500; } },
    ],
  },
];

export function productById(id: string): Product | undefined {
  for (const c of FINISH_CATEGORIES) for (const p of c.products) if (p.id === id) return p;
  return undefined;
}

/** 今の選択（無ければテイストからの既定） */
export function selectedProduct(cat: FinishCategory, d: DesignOptions): Product {
  const id = d.finishes?.[cat.id] ?? cat.defaultFor?.(d) ?? cat.products[0].id;
  return cat.products.find((p) => p.id === id) ?? cat.products[0];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** テイストにコーディネートの選択を重ねた外観・内観 */
export function stylesFor(d: DesignOptions): { ext: ExteriorStyle; int: InteriorStyle } {
  const s = { ext: clone(exteriorById(d.exteriorId)), int: clone(interiorById(d.interiorId)) };
  if (!d.finishes) return s;
  for (const cat of FINISH_CATEGORIES) {
    const id = d.finishes[cat.id];
    if (!id) continue;
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
    const id = d.finishes?.[cat.id];
    if (!id) continue;
    const p = cat.products.find((x) => x.id === id);
    if (p?.estimate) g[p.estimate.group] = p.estimate.line;
  }
  return g;
}
