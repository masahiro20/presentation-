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
    finishes: { extWall: 'ext.sto.grey', accent: 'acc.none', roof: 'roof.gl.black', soffit: 'soffit.same', sash: 'sash.tw.black', entDoor: 'door.venato.black', entFloor: 'ent.denver', floor: 'floor.channel.oak', wall: 'wall.cloth.greige', accentWall: 'aw.porters', ceiling: 'ceil.cloth', door: 'door.kamiya.cube', baseboard: 'bb.kamiya.white', stair: 'stair.steel', kitchen: 'kitchen.hl.line.greystone', cupboard: 'cup.line.same', pendant: 'pend.ph5', light: 'light.2700', wetFloor: 'wet.denver', washWall: 'ww.danto.mov' },
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
    finishes: { extWall: 'ext.jp.dark', accent: 'acc.solido.black', roof: 'roof.gl.black', soffit: 'soffit.black', sash: 'sash.tw.black', entDoor: 'door.venato.walnut', entFloor: 'ent.nagoya.9840', floor: 'floor.tile.black', wall: 'wall.cloth.grey', accentWall: 'aw.cloth.charcoal', ceiling: 'ceil.cloth', door: 'door.kamiya.black', baseboard: 'bb.kamiya.black', stair: 'stair.steel', kitchen: 'kitchen.hl.line.mortablack', cupboard: 'cup.line.same', pendant: 'pend.dome', light: 'light.2700', wetFloor: 'wet.sangetsu.is2071', washWall: 'ww.mirror' },
    swatch: ['#5d5c59', '#3f3d3a', '#2a2a2c', '#6a5345'],
    twists: ['寝室だけ床をスモークのオークにして足触りを変える', 'ペンダントは黒いドーム 1 灯、ダウンライトは最小限にして間接照明を主役に', 'サウナ・浴室を黒いタイルでそろえると「ホテルの個室」になる'],
  },
  {
    id: 'grey-wood-ceiling',
    name: 'グレー壁と木の天井',
    catch: '中間グレーの塗り壁 × オークの床 × 杉羽目板の天井 × 黒いドーム',
    why: '壁をグレーにすると白い壁より木が映える。天井に木を張り、照明は黒いトラックスポットと黒いドームのペンダントで「アトリエ」のような LDK に。キッチンはダークグレー扉にステンレス天板で道具らしく。',
    fits: '料理や音楽など趣味を楽しむ方、天井の高い LDK や勾配天井のプラン。',
    refs: '御社サイトの事例（木の天井の家）、Instagram「#木天井 #グレーの壁」、Pinterest「wood ceiling grey walls kitchen」',
    exteriorId: 'hl-jolypat-grey',
    interiorId: 'hl-grey-oak',
    finishes: { extWall: 'ext.jp.mid', accent: 'acc.solido.black', roof: 'roof.gl.black', soffit: 'soffit.cedar', sash: 'sash.tw.black', entDoor: 'door.venato.black', entFloor: 'ent.mortar', floor: 'floor.channel.oak', wall: 'wall.cloth.grey', accentWall: 'aw.none', ceiling: 'ceil.sugi', door: 'door.kamiya.cube', baseboard: 'bb.kamiya.grey', stair: 'stair.steel', kitchen: 'kitchen.hl.line.darkgrey', cupboard: 'cup.custom.oak', pendant: 'pend.dome', light: 'light.2700', wetFloor: 'wet.sangetsu.is2071', washWall: 'ww.cloth' },
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
    finishes: { extWall: 'ext.jp.white', accent: 'acc.wood', roof: 'roof.gl.silver', soffit: 'soffit.cedar', sash: 'sash.tw.black', entDoor: 'door.venato.oak', entFloor: 'ent.hirata.qtz', floor: 'floor.ioc.oak', wall: 'wall.cloth.white', accentWall: 'aw.none', ceiling: 'ceil.cloth', door: 'door.panasonic.veritis', baseboard: 'bb.kamiya.white', stair: 'stair.steel', kitchen: 'kitchen.hl.line.white', cupboard: 'cup.custom.oak', pendant: 'pend.ph5', light: 'light.3000', wetFloor: 'wet.sangetsu.cf', washWall: 'ww.cloth' },
    swatch: ['#e8e6e0', '#9c7b58', '#c9a46a', '#f2f0ea'],
    twists: ['サッシを黒にすると白い家が締まる（白サッシは柔らかい印象）', '洗面はタイルを白い 300 角にして清潔感を出す', '照明の色温度は 3000K（2700K より少し白く、木が黄色くなりすぎない）'],
  },
  {
    id: 'wa-modern',
    name: '和モダン',
    catch: 'そとん壁 × 杉の軒天 × 玄関引き戸 × 塗装の壁',
    why: '外はそとん壁の粗い肌理に杉板の軒天で軒の深い佇まい、玄関は引き戸。中はスモークのオークの床にライムストーン色の塗装壁、建具は壁と同色のフルハイトで線を消す。キッチンはダークベージュで木と石の間の色に。',
    fits: '和室・土間・縁側のあるプラン、ご両親と同居、庭を眺める暮らし。',
    refs: 'Instagram「#和モダン住宅 #平屋暮らし」、Pinterest「japanese modern house interior stone wood」',
    exteriorId: 'lux-shikkui-oya',
    interiorId: 'lux-washi-hinoki',
    finishes: { extWall: 'ext.soton', accent: 'acc.wood', roof: 'roof.gl.black', soffit: 'soffit.cedar', sash: 'sash.tw.black', entDoor: 'door.concord.black', entFloor: 'ent.mortar', floor: 'floor.iemon.smoke', wall: 'wall.porters.stone', accentWall: 'aw.none', ceiling: 'ceil.cloth', door: 'door.kamiya.cube', baseboard: 'bb.kamiya.grey', stair: 'stair.steel', kitchen: 'kitchen.hl.line.darkbeige', cupboard: 'cup.custom.oak', pendant: 'pend.dome', light: 'light.2700', wetFloor: 'wet.sangetsu.is2032', washWall: 'ww.danto.mov' },
    swatch: ['#cfcdc7', '#9c7b58', '#7a6a58', '#d9d3c6'],
    twists: ['和室の床は畳表の目を細かいものにし、壁は同じ塗装壁で続ける', '玄関土間はベージュグレーの 300 角タイルで「石畳」に', '照明は低く、ペンダントは和紙ではなく黒いドームで現代的に'],
  },
  {
    id: 'industrial',
    name: 'インダストリアル',
    catch: '黒ガルバ × 杉板 × 石の床 × モールテックスの壁 × 黒皮鉄',
    why: '外は黒いガルバリウムに杉板をアクセント、中はデンバーストンの床にモールテックスの壁、ステンレスのキッチン、黒皮鉄の階段。木はテーブルとカップボードだけにして「工場の二階」のようなラフさを出す。',
    fits: 'ガレージ・趣味室のあるプラン、バイク・自転車・道具が多い方。',
    refs: 'Instagram「#インダストリアルインテリア #ガレージハウス」、Pinterest「industrial house black galvalume」',
    exteriorId: 'hl-galva-black',
    interiorId: 'hl-dark-mortar',
    finishes: { extWall: 'ext.gl.black', accent: 'acc.wood', roof: 'roof.gl.black', soffit: 'soffit.black', sash: 'sash.tw.black', entDoor: 'door.venato.black', entFloor: 'ent.mortar', floor: 'floor.denver', wall: 'wall.cloth.grey', accentWall: 'aw.mortex.grey', ceiling: 'ceil.cloth', door: 'door.kamiya.black', baseboard: 'bb.soken.alumi', stair: 'stair.steel', kitchen: 'kitchen.cleanup.centro', cupboard: 'cup.custom.oak', pendant: 'pend.dome', light: 'light.3000', wetFloor: 'wet.sangetsu.is2071', washWall: 'ww.mirror' },
    swatch: ['#2b2c2e', '#6a5345', '#8d8b87', '#3a3a3a'],
    twists: ['LDK の一面だけコンクリート打放し調にすると写真の主役ができる', '照明はトラックスポットと裸電球のペンダント', '建具は黒のフルハイトで壁と分ける'],
  },
  {
    id: 'mortex-cafe',
    name: 'モールテックスのカフェ',
    catch: 'オフホワイトの Sto × モールテックスの床 × オーク × 造作キッチン',
    why: '外はオフホワイトの Sto で柔らかく、中はモールテックスの床にオークの造作キッチン・造作洗面で「カフェの厨房」の温度感。壁はオフホワイト、建具は壁と同色で消す。',
    fits: '料理・お菓子作り・来客の多い方、キッチンを中心にした LDK。',
    refs: 'Instagram「#モールテックス #造作キッチン」、Pinterest「mortex kitchen oak cafe style home」',
    exteriorId: 'hl-sto-lightgrey',
    interiorId: 'lux-mortex-oak',
    finishes: { extWall: 'ext.sto.white', accent: 'acc.none', roof: 'roof.gl.silver', soffit: 'soffit.same', sash: 'sash.tw.black', entDoor: 'door.venato.oak', entFloor: 'ent.mortar', floor: 'floor.mortex', wall: 'wall.lilycolor', accentWall: 'aw.none', ceiling: 'ceil.cloth', door: 'door.kamiya.cube', baseboard: 'bb.soken.alumi', stair: 'stair.steel', kitchen: 'kitchen.custom.oak', cupboard: 'cup.custom.oak', pendant: 'pend.globes', light: 'light.2700', wetFloor: 'wet.sangetsu.is2033', washWall: 'ww.danto.mov', vanity: 'vanity.custom1200' },
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
    finishes: { extWall: 'ext.jp.light', accent: 'acc.solido.grey', roof: 'roof.gl.black', soffit: 'soffit.same', sash: 'sash.tw.black', entDoor: 'door.venato.walnut', entFloor: 'ent.denver', floor: 'floor.iemon.mocha', wall: 'wall.cloth.grey', accentWall: 'aw.cloth.greige', ceiling: 'ceil.cloth', door: 'door.kamiya.cube', baseboard: 'bb.kamiya.white', stair: 'stair.steel', kitchen: 'kitchen.hl.line.walnut', cupboard: 'cup.line.same', pendant: 'pend.ph5', light: 'light.2700', wetFloor: 'wet.denver', washWall: 'ww.cloth' },
    swatch: ['#b3aea4', '#5a3f2e', '#cfcdc7', '#c9b9a3'],
    twists: ['テレビ壁をウォールナットの羽目板にして木を面で見せる', '寝室の壁をグレージュのクロスにして眠りの色に', 'ダイニングは丸いウォールナットのテーブルと Y チェア（ウォールナット）'],
  },
  {
    id: 'soft-beige',
    name: 'やわらかいベージュ',
    catch: 'ベージュの塗り壁 × 白いサッシ × ラテ色のオーク × 丸いガラスの照明',
    why: 'グレーではなくベージュでまとめると、同じミニマルでも冷たさが消えて「くつろぐ家」になる。外はサンドベージュのジョリパットに白いサッシ、中はラテ色のジャイロオークにペールベージュの壁、テレビ壁だけポーターズペイントで手仕事の陰影。キッチンはモルタライトで床と同じ温度に。',
    fits: '小さなお子さまのいるご家族、韓国インテリア・ベージュインテリアがお好きな方。曲線（アーチの開口・丸いテーブル）と相性がよい。',
    refs: 'Instagram「#ベージュインテリア #韓国インテリア」、Pinterest「beige minimal home arch」',
    exteriorId: 'hl-jolypat-beige',
    interiorId: 'hl-pale-beige',
    finishes: { extWall: 'ext.jp.beige', accent: 'acc.none', roof: 'roof.gl.silver', soffit: 'soffit.same', sash: 'sash.tw.white', entDoor: 'door.venato.oak', entFloor: 'ent.hirata.qtz', floor: 'floor.iemon.latte', wall: 'wall.cloth.beige', accentWall: 'aw.porters', ceiling: 'ceil.cloth', door: 'door.kamiya.cube', baseboard: 'bb.kamiya.white', stair: 'stair.steel', kitchen: 'kitchen.hl.line.mortalight', cupboard: 'cup.line.same', pendant: 'pend.globes', light: 'light.2700', wetFloor: 'wet.sangetsu.is2033', washWall: 'ww.cloth' },
    swatch: ['#cbbfab', '#f0f0ee', '#bfa17d', '#e6ddd0'],
    twists: ['リビングの入口をアーチの開口にすると、写真の主役ができる', 'ソファは丸みのあるアイボリーのブークレ', '照明は 2700K、間接照明を多めにして影をやわらかく'],
  },
  {
    id: 'japandi',
    name: 'ジャパンディ（和と北欧）',
    catch: '白い塗り壁 × 杉の天井 × ホワイトオーク無垢 × 造作のオーク',
    why: '和の「素材をそのまま見せる」と北欧の「明るく軽い」の間。白い壁に杉羽目板の天井、床はプレイリーホームズのホワイトオーク無垢（オイル仕上げ）で足ざわりから木。キッチンはアッシュ、カップボードはオークの造作で、木の色を 2 種類までに抑える。',
    fits: '素材感を大切にしたい方、庭や植栽と一緒に暮らしたい方。平屋・勾配天井のプランで特に映える。',
    refs: 'Instagram「#ジャパンディ #japandi」、Pinterest「japandi living room wood ceiling」',
    exteriorId: 'hl-white-plaster',
    interiorId: 'nordic-white',
    finishes: { extWall: 'ext.jp.white', accent: 'acc.wood', roof: 'roof.gl.black', soffit: 'soffit.cedar', sash: 'sash.tw.black', entDoor: 'door.venato.oak', entFloor: 'ent.mortar', floor: 'floor.prairie.whiteoak', wall: 'wall.cloth.white', accentWall: 'aw.none', ceiling: 'ceil.sugi', door: 'door.kamiya.cube', baseboard: 'bb.kamiya.white', stair: 'stair.wood', kitchen: 'kitchen.hl.line.ash', cupboard: 'cup.custom.oak', pendant: 'pend.ph5', light: 'light.3000', wetFloor: 'wet.sangetsu.is2032', washWall: 'ww.cloth' },
    swatch: ['#e8e6e0', '#b08d66', '#d0b48c', '#2a2a2a'],
    twists: ['リビングに畳コーナー（縁なし）を一段上げて作る', '照明は低めの位置に、ペンダントは和紙ではなく PH 5 で現代的に', '建具の取っ手は黒の細いものにして線を一本足す'],
  },
  {
    id: 'terracotta',
    name: 'テラコッタと白い塗り壁',
    catch: '白い塗り壁 × テラコッタ色の壁 × 明るいオーク × 造作キッチン',
    why: '白とグレーの家が並ぶ中で、ひとつだけ「色」で記憶に残る家。外は白い塗り壁に木のドア、中はラテ色のオークにテラコッタ色のアクセント壁、キッチンはオークの造作。テラコッタは日差しで色が変わるので、南・西の光が入る壁に。',
    fits: '旅行・料理が好きな方、南欧・地中海の雰囲気がお好きな方。中庭・テラスに開く LDK。',
    refs: 'Instagram「#テラコッタ #南欧インテリア」、Pinterest「terracotta accent wall white plaster interior」',
    exteriorId: 'hl-white-plaster',
    interiorId: 'hl-pale-beige',
    finishes: { extWall: 'ext.jp.white', accent: 'acc.none', roof: 'roof.gl.silver', soffit: 'soffit.same', sash: 'sash.tw.black', entDoor: 'door.venato.oak', entFloor: 'ent.sanwa.dust', floor: 'floor.iemon.latte', wall: 'wall.cloth.white', accentWall: 'aw.cloth.terracotta', ceiling: 'ceil.cloth', door: 'door.kamiya.cube', baseboard: 'bb.kamiya.white', stair: 'stair.steel', kitchen: 'kitchen.custom.oak', cupboard: 'cup.custom.oak', pendant: 'pend.globes', light: 'light.2700', wetFloor: 'wet.sangetsu.is2033', washWall: 'ww.danto.mov' },
    swatch: ['#e8e6e0', '#b07a5c', '#bfa17d', '#c3a06f'],
    twists: ['キッチンの壁を手仕事の白いタイルにする', '植物は大きなオリーブを 1 本', 'テラコッタ色は 1 面だけ。2 面にすると重くなる'],
  },
  {
    id: 'gallery-white',
    name: '白いギャラリー',
    catch: 'オフホワイトの Sto × 石目の床 × 白いキッチン × アルミの巾木',
    why: '家具とアートが主役になる「白い箱」。外はオフホワイトの Sto を一色で、中はワイドモルタルの明るい石目の床に白い壁・白いキッチン。巾木はアルミの細い見切りにして線を消し、照明は 3500K の白めでギャラリーの空気に。',
    fits: '絵・写真・器を飾りたい方、家具にこだわりのある方。天井の高い LDK・吹抜。',
    refs: 'Instagram「#ギャラリーのような家 #ミニマリスト」、Pinterest「white gallery house minimal interior」',
    exteriorId: 'hl-sto-lightgrey',
    interiorId: 'hl-standard',
    finishes: { extWall: 'ext.sto.white', accent: 'acc.none', roof: 'roof.gl.black', soffit: 'soffit.same', sash: 'sash.tw.black', entDoor: 'door.venato.grey', entFloor: 'ent.hirata.qtz', floor: 'floor.sangetsu.widemortar', wall: 'wall.cloth.white', accentWall: 'aw.none', ceiling: 'ceil.cloth', door: 'door.kamiya.cube', baseboard: 'bb.soken.alumi', stair: 'stair.steel', kitchen: 'kitchen.hl.line.white', cupboard: 'cup.line.same', pendant: 'pend.ph5', light: 'light.3500', wetFloor: 'wet.sangetsu.is2071', washWall: 'ww.mirror' },
    swatch: ['#ebe9e3', '#a7a49e', '#f1f0ec', '#c4c6c8'],
    twists: ['壁にピクチャーレールを仕込み、アートを掛け替えられるように', 'ダウンライトの代わりにスポットで壁を照らす', '床を濃くしたいときはデンバーストンに変えるとホテル寄りに'],
  },
  {
    id: 'midcentury',
    name: 'ミッドセンチュリー（緑とウォールナット）',
    catch: 'くすみグリーンの壁 × モカ色の床 × ウォールナットのキッチン × 黒いドーム',
    why: '1950〜60 年代の北欧・アメリカの家具が似合う、色のある大人の LDK。床はモカ色のジャイロオーク、テレビ壁をくすみグリーンにして、キッチンはウォールナット。照明は黒いドームを低めに。木・緑・黒の 3 色で、ヴィンテージの家具を足しても散らからない。',
    fits: 'ヴィンテージの家具・レコード・本が好きな方。書斎・趣味室のあるプラン。',
    refs: 'Instagram「#ミッドセンチュリー #ヴィンテージインテリア」、Pinterest「mid century modern green wall walnut」',
    exteriorId: 'hl-jolypat-greige',
    interiorId: 'lux-shikkui-walnut',
    finishes: { extWall: 'ext.jp.light', accent: 'acc.wood', roof: 'roof.gl.black', soffit: 'soffit.cedar', sash: 'sash.tw.black', entDoor: 'door.venato.black', entFloor: 'ent.denver', floor: 'floor.iemon.mocha', wall: 'wall.cloth.white', accentWall: 'aw.cloth.green', ceiling: 'ceil.cloth', door: 'door.kamiya.cube', baseboard: 'bb.kamiya.white', stair: 'stair.steel', kitchen: 'kitchen.hl.line.walnut', cupboard: 'cup.line.same', pendant: 'pend.dome', light: 'light.2700', wetFloor: 'wet.sangetsu.is2032', washWall: 'ww.cloth' },
    swatch: ['#7f8a76', '#8c7152', '#6e4b36', '#2a2a2a'],
    twists: ['ダイニングチェアはイームズのシェルチェアを色違いで', '照明はダクトレールにして家具の配置を変えやすく', '緑の壁の前に背の高い本棚を造作する'],
  },
  {
    id: 'resort-stone',
    name: '石と杉のリゾート',
    catch: '石の床 × 杉の天井 × SOLIDO の室内壁 × ダークベージュのキッチン',
    why: '旅館やリゾートホテルのように、石と木で「低く・暗く・落ち着く」LDK。床はデンバーストンの 600 角、天井は杉羽目板、テレビ壁は SOLIDO の灰で素材感を出す。キッチンはダークベージュで石と木の間の色に。照明は 2700K で間接照明を主役に。',
    fits: '中庭・坪庭のあるプラン、夜の時間を大切にする方、サウナ・露天風呂のような浴室を望む方。',
    refs: 'Instagram「#リゾートのような家 #中庭のある家」、Pinterest「resort style house stone wood ceiling」',
    exteriorId: 'lux-shikkui-oya',
    interiorId: 'hl-greige-hotel',
    finishes: { extWall: 'ext.jp.light', accent: 'acc.wood', roof: 'roof.gl.black', soffit: 'soffit.cedar', sash: 'sash.tw.black', entDoor: 'door.venato.black', entFloor: 'ent.denver', floor: 'floor.denver', wall: 'wall.cloth.greige', accentWall: 'aw.solido', ceiling: 'ceil.sugi', door: 'door.kamiya.cube', baseboard: 'bb.kamiya.grey', stair: 'stair.steel', kitchen: 'kitchen.hl.line.darkbeige', cupboard: 'cup.line.same', pendant: 'pend.dome', light: 'light.2700', wetFloor: 'wet.denver', washWall: 'ww.danto.mov' },
    swatch: ['#8c8a85', '#b08d66', '#8d8b86', '#a89f99'],
    twists: ['LDK と中庭の床を同じ石でつなぐと、外までが部屋に見える', 'ソファは低いもの、照明は床から 1m 以下に', '浴室を黒いタイルにしてホテルの個室のように'],
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
