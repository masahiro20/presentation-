/**
 * 雰囲気（ムード）からのコーディネート提案。
 * 「標準仕様」以外も含め、この雰囲気ならこの素材の組み合わせ、という知識をまとめたもの。
 * 御社（ホームランディック）の施工事例と、Instagram・Pinterest で人気の住宅写真の傾向から整理した。
 * 1 つ選ぶと外観・内観のテイストと、コーディネート（メーカー・品番）の選択をまとめて入れ替える。
 */
import type { DesignOptions } from '../styles/presets';

export interface Mood {
  id: string;
  name: string;
  catch: string;
  /** なぜこの組み合わせか（お客様に話せる言葉で） */
  why: string;
  /** 合う間取り・お客様像 */
  fits: string;
  /** 御社事例・SNS で探すときの言葉 */
  refs: string;
  /** 外観・内観のテイスト（プリセット id） */
  exteriorId: string;
  interiorId: string;
  /** コーディネート（カテゴリ id → 商品 id）。無いカテゴリはテイストの既定 */
  finishes: Record<string, string>;
  /** カードの色見本 */
  swatch: string[];
  /** 「ひとひねり」: この雰囲気で効く変化球 */
  twists: string[];
}

export const MOODS: Mood[] = [
  {
    id: 'greige-hotel',
    name: 'グレージュのホテルライク',
    catch: '塗り壁の箱 × 黒サッシ × オーク × 大判タイル',
    why: '外はグレージュの塗り壁に黒い細いサッシで「静かな箱」にし、中はオークの床に白〜グレージュの壁、玄関と水まわりだけグレーの 600 角タイル。色数を 3 つ（グレージュ・黒・木）に絞るので、家具を足しても散らからない。御社の事例で最も多い組み合わせ。',
    fits: '30〜40 代のご夫婦、スッキリ片付いた LDK を望む方。平屋・2 階建てどちらも。',
    refs: '御社サイトの事例（グレーの塗り壁の家）、Instagram「#ホテルライクな家 #グレージュインテリア」、Pinterest「greige modern house japan」',
    exteriorId: 'hl-greige-cube',
    interiorId: 'hl-greige-hotel',
    finishes: { extWall: 'ext.sto.grey', accent: 'acc.none', roof: 'roof.gl.black', soffit: 'soffit.same', sash: 'sash.tw.black', entDoor: 'door.venato.black', floor: 'floor.channel.oak', wetFloor: 'wet.nagoya.600.grey', wall: 'wall.cloth.greige', door: 'door.kamiya.cube', stair: 'stair.steel', kitchen: 'kitchen.hl.line.greystone', cupboard: 'cup.line.same', light: 'light.2700' },
    swatch: ['#b3aea4', '#2b2b2b', '#b08a5c', '#8d8b87'],
    twists: ['LDK の床を 600 角タイルにするとホテルの色が濃くなる（床暖房と相性がよい）', 'テレビ壁だけポーターズペイントのライムストーンで塗ると写真映えする', 'ダイニングは PH 5 の白、ソファはグレーの布でそろえる'],
  },
  {
    id: 'dark-stone',
    name: 'ダークグレーの石とウォールナット',
    catch: 'チャコールの外壁 × SOLIDO × 黒いタイル × 木の温かみ',
    why: '外観はダークグレーの塗り壁に SOLIDO の鉄黒を玄関まわりだけ。中は黒いタイルの床にモルタブラックのキッチン、壁はライトグレーで重くなりすぎないよう抜く。木はウォールナットの建具と家具だけに絞り、「暗いのに温かい」を作る。',
    fits: '夜の時間を大切にする方、照明の陰影で魅せたい LDK。中庭・坪庭と組むと黒い壁に緑が映える。',
    refs: '御社サイトの事例（黒いキッチンの家・ドッグランの家）、Instagram「#ダークトーンインテリア #黒いキッチン」、Pinterest「dark modern interior walnut」',
    exteriorId: 'hl-charcoal-plaster',
    interiorId: 'hl-dark-stone',
    finishes: { extWall: 'ext.jp.dark', accent: 'acc.solido.black', roof: 'roof.gl.black', soffit: 'soffit.black', sash: 'sash.tw.black', entDoor: 'door.venato.walnut', floor: 'floor.tile.black', wetFloor: 'wet.nagoya.600.charcoal', wall: 'wall.cloth.grey', door: 'door.kamiya.black', stair: 'stair.steel', kitchen: 'kitchen.hl.line.mortablack', cupboard: 'cup.line.same', light: 'light.2700' },
    swatch: ['#5d5c59', '#3f3d3a', '#2a2a2c', '#6a5345'],
    twists: ['寝室だけ床をスモークのオークにして足触りを変える', 'ペンダントは黒いドーム 1 灯、ダウンライトは最小限にして間接照明を主役に', 'サウナ・浴室を黒いタイルでそろえると「ホテルの個室」になる'],
  },
  {
    id: 'grey-wood-ceiling',
    name: 'グレー壁と木の天井',
    catch: '中間グレーの塗り壁 × オークの床 × 杉板の天井 × トラックスポット',
    why: '壁をグレーにすると白い壁より木が映える。天井に木を張り、照明は黒いトラックスポットと黒いドームのペンダントで「アトリエ」のような LDK に。キッチンはダークグレー扉にステンレス天板で道具らしく。',
    fits: '料理や音楽など趣味を楽しむ方、天井の高い LDK や勾配天井のプラン。',
    refs: '御社サイトの事例（木の天井の家）、Instagram「#木天井 #グレーの壁」、Pinterest「wood ceiling grey walls kitchen」',
    exteriorId: 'hl-jolypat-grey',
    interiorId: 'hl-grey-oak',
    finishes: { extWall: 'ext.jp.mid', accent: 'acc.solido.black', roof: 'roof.gl.black', soffit: 'soffit.cedar', sash: 'sash.tw.black', entDoor: 'door.venato.black', floor: 'floor.channel.oak', wetFloor: 'wet.nagoya.600.grey', wall: 'wall.cloth.grey', door: 'door.kamiya.cube', stair: 'stair.steel', kitchen: 'kitchen.hl.line.darkgrey', cupboard: 'cup.custom.oak', light: 'light.2700' },
    swatch: ['#9a9893', '#c9a272', '#b08a5c', '#242424'],
    twists: ['軒天も同じ杉板にすると外と中の天井がつながって見える', 'カップボードはオークの造作にして木の量を増やす', 'ダイニングテーブルは一枚板、椅子は Y チェアで木をそろえる'],
  },
  {
    id: 'white-natural',
    name: '白とナチュラルオーク',
    catch: '白い塗り壁 × 木のアクセント × 明るいオーク × 北欧の家具',
    why: '白い塗り壁の箱に玄関まわりだけレッドシダーを張り、中は明るいオークの無垢床に白い壁・白い天井。色を白と木だけにして、北欧の家具（Y チェア・PH 5・布のソファ）が主役になる。朝の光が一番きれいに回る組み合わせ。',
    fits: '小さなお子さまのいるご家族、明るく広く見せたい LDK、南向きの大きな窓。',
    refs: 'Instagram「#北欧インテリア #ナチュラルモダン」、Pinterest「scandinavian japanese house white oak」',
    exteriorId: 'hl-white-plaster',
    interiorId: 'natural-oak',
    finishes: { extWall: 'ext.jp.white', accent: 'acc.wood', roof: 'roof.gl.silver', soffit: 'soffit.cedar', sash: 'sash.tw.black', entDoor: 'door.venato.oak', floor: 'floor.ioc.oak', wetFloor: 'wet.sangetsu.cf', wall: 'wall.cloth.white', door: 'door.panasonic.veritis', stair: 'stair.steel', kitchen: 'kitchen.hl.line.white', cupboard: 'cup.custom.oak', light: 'light.3000' },
    swatch: ['#e8e6e0', '#9c7b58', '#c9a46a', '#f2f0ea'],
    twists: ['サッシを黒にすると白い家が締まる（白サッシは柔らかい印象）', '洗面はタイルを白い 300 角にして清潔感を出す', '照明の色温度は 3000K（2700K より少し白く、木が黄色くなりすぎない）'],
  },
  {
    id: 'wa-modern',
    name: '和モダン',
    catch: '左官の壁 × 杉の軒天 × 墨色の建具 × 石のような床',
    why: '外は明るいグレーの左官に杉板の軒天で軒の深い佇まい、玄関は引き戸。中はスモークのオークの床にライムストーン色の塗装壁、建具は壁と同色のフルハイトで線を消す。キッチンはダークベージュで木と石の間の色に。',
    fits: '和室・土間・縁側のあるプラン、ご両親と同居、庭を眺める暮らし。',
    refs: 'Instagram「#和モダン住宅 #平屋暮らし」、Pinterest「japanese modern house interior stone wood」',
    exteriorId: 'lux-shikkui-oya',
    interiorId: 'lux-washi-hinoki',
    finishes: { extWall: 'ext.jp.light', accent: 'acc.wood', roof: 'roof.gl.black', soffit: 'soffit.cedar', sash: 'sash.tw.black', entDoor: 'door.concord.black', floor: 'floor.iemon.smoke', wetFloor: 'wet.nagoya.300', wall: 'wall.porters.stone', door: 'door.kamiya.cube', stair: 'stair.steel', kitchen: 'kitchen.hl.line.darkbeige', cupboard: 'cup.custom.oak', light: 'light.2700' },
    swatch: ['#cfcdc7', '#9c7b58', '#7a6a58', '#d9d3c6'],
    twists: ['和室の床は畳表の目を細かいものにし、壁は同じ塗装壁で続ける', '玄関土間はベージュグレーの 300 角タイルで「石畳」に', '照明は低く、ペンダントは和紙ではなく黒いドームで現代的に'],
  },
  {
    id: 'industrial',
    name: 'インダストリアル',
    catch: '黒ガルバ × 錆色の SOLIDO × モルタル調の床 × 黒皮鉄',
    why: '外は黒いガルバリウムに SOLIDO の錆茶をアクセント、中はグレーの大判タイルの床にステンレスのキッチン、黒皮鉄の階段。木はテーブルとカップボードだけにして「工場の二階」のようなラフさを出す。',
    fits: 'ガレージ・趣味室のあるプラン、バイク・自転車・道具が多い方。',
    refs: 'Instagram「#インダストリアルインテリア #ガレージハウス」、Pinterest「industrial house black galvalume」',
    exteriorId: 'hl-galva-black',
    interiorId: 'hl-dark-mortar',
    finishes: { extWall: 'ext.gl.black', accent: 'acc.solido.rust', roof: 'roof.gl.black', soffit: 'soffit.black', sash: 'sash.tw.black', entDoor: 'door.venato.black', floor: 'floor.nagoya.600', wetFloor: 'wet.nagoya.600.charcoal', wall: 'wall.cloth.grey', door: 'door.kamiya.black', stair: 'stair.steel', kitchen: 'kitchen.cleanup.centro', cupboard: 'cup.custom.oak', light: 'light.3000' },
    swatch: ['#2b2c2e', '#6a5345', '#8d8b87', '#3a3a3a'],
    twists: ['LDK の一面だけコンクリート打放し調にすると写真の主役ができる', '照明はトラックスポットと裸電球のペンダント', '建具は黒のフルハイトで壁と分ける'],
  },
  {
    id: 'mortex-cafe',
    name: 'モールテックスのカフェ',
    catch: 'オフホワイトの塗り壁 × モルタル調の床 × オーク × 造作キッチン',
    why: '外はオフホワイトの塗り壁で柔らかく、中はモルタル調の床にオークの造作キッチン・造作洗面で「カフェの厨房」の温度感。壁はオフホワイト、建具は壁と同色で消す。',
    fits: '料理・お菓子作り・来客の多い方、キッチンを中心にした LDK。',
    refs: 'Instagram「#モールテックス #造作キッチン」、Pinterest「mortex kitchen oak cafe style home」',
    exteriorId: 'hl-sto-lightgrey',
    interiorId: 'lux-mortex-oak',
    finishes: { extWall: 'ext.sto.white', accent: 'acc.none', roof: 'roof.gl.silver', soffit: 'soffit.oak', sash: 'sash.tw.black', entDoor: 'door.venato.oak', floor: 'floor.sangetsu.ft.stone', wetFloor: 'wet.sangetsu.ft', wall: 'wall.lilycolor', door: 'door.kamiya.cube', stair: 'stair.steel', kitchen: 'kitchen.custom.oak', cupboard: 'cup.custom.oak', vanity: 'vanity.custom1200', light: 'light.2700' },
    swatch: ['#ebe9e3', '#b0aaa0', '#b08a5c', '#c8c2b8'],
    twists: ['キッチンの壁は小さな白いタイルにして手仕事感を', 'ペンダントは小さなガラスの球を 3 灯', 'ソファは革の低いものにするとカフェから「家」に戻る'],
  },
  {
    id: 'walnut-greige',
    name: 'グレージュとウォールナット',
    catch: 'グレージュの塗り壁 × 濃い木 × ライトグレー × ベージュの布',
    why: 'グレージュの外壁に、中はモカ色のオーク床とウォールナットのキッチン扉。壁はライトグレーで、布はベージュ。木を濃くすると大人っぽく落ち着き、グレージュと喧嘩しない。',
    fits: '落ち着いた色の家具を既にお持ちの方、書斎・寝室を大切にする方。',
    refs: 'Instagram「#ウォールナットインテリア #グレージュ」、Pinterest「walnut kitchen greige walls」',
    exteriorId: 'hl-jolypat-greige',
    interiorId: 'hl-greige-walnut',
    finishes: { extWall: 'ext.jp.light', accent: 'acc.solido.grey', roof: 'roof.gl.black', soffit: 'soffit.same', sash: 'sash.tw.black', entDoor: 'door.venato.walnut', floor: 'floor.iemon.mocha', wetFloor: 'wet.nagoya.600.grey', wall: 'wall.cloth.grey', door: 'door.lixil.lasissa', stair: 'stair.steel', kitchen: 'kitchen.hl.line.walnut', cupboard: 'cup.line.same', light: 'light.2700' },
    swatch: ['#b3aea4', '#5a3f2e', '#cfcdc7', '#c9b9a3'],
    twists: ['テレビ壁をウォールナットの羽目板にして木を面で見せる', '寝室の壁をグレージュのクロスにして眠りの色に', 'ダイニングは丸いウォールナットのテーブルと Y チェア（ウォールナット）'],
  },
];

export function moodById(id: string): Mood | undefined {
  return MOODS.find((m) => m.id === id);
}

/** この design に一番近い雰囲気（テイストの組み合わせが一致するもの）。無ければ undefined */
export function moodOf(d: DesignOptions): Mood | undefined {
  return MOODS.find((m) => m.exteriorId === d.exteriorId && m.interiorId === d.interiorId);
}

/** 雰囲気を design に適用した値（テイスト＋コーディネート）。元の屋根などの細かい調整は残す */
export function applyMood(d: DesignOptions, m: Mood): DesignOptions {
  return { ...d, exteriorId: m.exteriorId, interiorId: m.interiorId, finishes: { ...m.finishes }, roofOverride: undefined, roofPitch: undefined, wallColorOverride: undefined, eaves: undefined };
}
