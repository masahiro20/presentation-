/**
 * 社内の積算シート（260911 積算P／S）の価格表。
 * 考え方はシートと同じ: 売価単価 = ROUNDDOWN(原価単価 ÷ 粗利係数, 丸め)、金額 = ROUNDDOWN(売価単価 × 数量, -1)。
 * 数量は「面」シートの入力（面積・長さ・個数）から式で決まる。P／S で既定の選択が違う行（構法・サッシ・断熱など）は group でまとめ、
 * 同じ group の中から 1 行を選ぶ。価格を改定するときはこの表を直す。
 */
import type { Areas } from './areas';

export type Grade = 'P' | 'S';
export type Unit = '式' | '㎡' | 'm' | '坪' | '箇所' | '人工' | '日' | '枚' | '組' | '㎥' | 'km';

export interface LineDef {
  id: string;
  /** 仕様（シートの C 列） */
  spec: string;
  /** 内容（シートの D 列。メーカー・品番を含む） */
  desc: string;
  unit: Unit;
  /** 原価単価（円） */
  cost: number;
  /** 粗利係数（原価 ÷ この値 = 売価）。設備は 0.8 */
  margin?: number;
  /** 売価単価の丸め桁（ROUNDDOWN の桁。-1 = 十円、-2 = 百円） */
  round?: -1 | -2 | 0;
  /** 売価単価を固定する行（設計費など） */
  fixedPrice?: number;
  /** 数量の式。無ければ 1（式）。文字列は Areas のキーか簡単な式 */
  qty?: (a: Areas) => number;
  /** 数量の説明（画面に出す） */
  qtyNote?: string;
  /** 二者択一・多者択一のまとまり（同じ group から 1 つだけ選ぶ） */
  group?: string;
  /** 既定で選ぶグレード（group の中で）。group の無い行は既定でこの grade のときに数量が入る */
  on?: Grade[] | 'both' | 'none';
  /** 数量が 0 でも行を残す（任意追加） */
  optional?: boolean;
}

export interface CategoryDef {
  id: string;
  no: number;
  name: string;
  lines: LineDef[];
}

const T = 0.3025; // ㎡ → 坪

export const CATEGORIES: CategoryDef[] = [
  {
    id: 'temp',
    no: 1,
    name: '仮設工事',
    lines: [
      { id: 'temp.set', spec: '仮設工事', desc: '仮設工事一式', unit: '式', cost: 176000, on: 'both' },
      { id: 'temp.fence', spec: '仮囲い工事', desc: '仮囲い（グリーンネット・パネル・単管）組立て共 ※敷地境界計上', unit: 'm', cost: 1100, qty: (a) => a.siteEdge, qtyNote: '敷地外周', on: 'both' },
      { id: 'temp.scaffold', spec: '外部足場', desc: '外部足場組立・解体', unit: '㎡', cost: 550, qty: (a) => a.extWall + a.insulArea, qtyNote: '外壁面積＋断熱面積', on: 'both' },
      { id: 'temp.mesh', spec: '外部足場', desc: 'メッシュシート', unit: '㎡', cost: 150, qty: (a) => a.extWall, qtyNote: '外壁面積', on: 'both' },
      { id: 'temp.inner', spec: '内部足場', desc: '吹抜け足場 ※4.5帖毎に一式', unit: '式', cost: 65000, qty: (a) => a.voidArea / 7.29, qtyNote: '吹抜面積 ÷ 7.29', on: 'both' },
      { id: 'temp.waste', spec: '残材処理費', desc: '残材処理費', unit: '㎡', cost: 1650, qty: (a) => a.constArea, qtyNote: '施工面積', on: 'both' },
      { id: 'temp.crane', spec: '上棟クレーン', desc: '上棟用クレーン一式', unit: '日', cost: 55000, on: 'both' },
      { id: 'temp.parking', spec: '工事車両駐車場', desc: '工事車両駐車場確保費用 ※状況により判断 18ヵ月/台分', unit: '式', cost: 80000, on: 'both' },
      { id: 'temp.guard', spec: 'ガードマン費用', desc: 'ガードマン費用', unit: '人工', cost: 20000, qty: () => 10, on: 'both' },
    ],
  },
  {
    id: 'found',
    no: 2,
    name: '基礎工事',
    lines: [
      { id: 'found.hw1', spec: '基礎工事一式', desc: '基礎立ち上がり W150㎜ 金物工法 シングル配筋', unit: '㎡', cost: 28000, round: -2, qty: (a) => a.buildArea, qtyNote: '建築面積', group: 'found', on: ['S'] },
      { id: 'found.se1', spec: '基礎工事一式', desc: '基礎立ち上がり W170㎜ SE工法 シングル配筋', unit: '㎡', cost: 30000, round: -2, qty: (a) => a.buildArea, qtyNote: '建築面積', group: 'found', on: 'none' },
      { id: 'found.hw2', spec: '基礎工事一式', desc: '基礎立ち上がり W150㎜ 金物工法 ダブル配筋', unit: '㎡', cost: 33000, round: -2, qty: (a) => a.buildArea, qtyNote: '建築面積', group: 'found', on: 'none' },
      { id: 'found.se', spec: '基礎工事一式', desc: '基礎立ち上がり W170㎜ SE構法', unit: '㎡', cost: 34000, round: -2, qty: (a) => a.buildArea, qtyNote: '建築面積', group: 'found', on: ['P'] },
      { id: 'found.soil', spec: '残土処分', desc: '残土処分 ※計画・敷地条件により変更となる場合があります', unit: '㎡', cost: 4000, qty: (a) => a.buildArea, qtyNote: '建築面積', on: 'both' },
      { id: 'found.deep1', spec: '深基礎', desc: '基礎立ち上がり H-100', unit: 'm', cost: 3500, round: -2, qty: (a) => a.deepFound100, qtyNote: '入力', optional: true, on: 'both' },
      { id: 'found.deep2', spec: '深基礎', desc: '基礎立ち上がり H-200', unit: 'm', cost: 7000, round: -2, qty: (a) => a.deepFound200, qtyNote: '入力', optional: true, on: 'both' },
      { id: 'found.deep3', spec: '深基礎', desc: '基礎立ち上がり H-300', unit: 'm', cost: 10500, round: -2, qty: (a) => a.deepFound300, qtyNote: '入力', optional: true, on: 'both' },
      { id: 'found.deep4', spec: '深基礎', desc: '基礎立ち上がり H-400', unit: 'm', cost: 14000, round: -2, qty: (a) => a.deepFound400, qtyNote: '入力', optional: true, on: 'both' },
    ],
  },
  {
    id: 'wood',
    no: 3,
    name: '木工事',
    lines: [
      { id: 'wood.precutHw', spec: 'プレカット・構造材・金物', desc: 'プレカット構造材 金物工法 ※下地材等込', unit: '㎡', cost: 29000, round: -2, qty: (a) => a.constArea, qtyNote: '施工面積', group: 'precut', on: ['S'] },
      { id: 'wood.precutSe', spec: 'プレカット・構造材・金物', desc: 'プレカット構造材 SE工法 ※下地材等込', unit: '㎡', cost: 46000, round: -2, qty: (a) => a.constArea, qtyNote: '施工面積', group: 'precut', on: ['P'] },
      { id: 'wood.carpHw', spec: '大工工事', desc: '大工工事 手間代 ※交通諸経費込み', unit: '坪', cost: 45000, round: -2, qty: (a) => a.totalTsubo, qtyNote: '延床坪', group: 'carp', on: ['S'] },
      { id: 'wood.carpSe', spec: '大工工事', desc: '大工工事 手間代 SE構法', unit: '坪', cost: 50000, round: -2, qty: (a) => a.totalTsubo, qtyNote: '延床坪', group: 'carp', on: ['P'] },
      { id: 'wood.carpExtra', spec: '大工工事', desc: '大工工事 手間代 施工面積', unit: '坪', cost: 20000, round: -2, qty: (a) => a.extraArea * T, qtyNote: '施工面積（追加分）坪', on: 'both' },
      { id: 'wood.airtight', spec: '大工工事', desc: '気密施工 手間代', unit: '人工', cost: 20000, round: -2, qty: () => 10, on: 'both' },
      { id: 'wood.gwLabor', spec: '大工工事', desc: '断熱材（グラスウール） 手間代 ※10坪一人工', unit: '人工', cost: 20000, round: -2, qty: (a) => Math.ceil(a.totalTsubo / 10), qtyNote: '延床坪 ÷ 10', group: 'insulLabor', on: ['S'] },
      { id: 'wood.soffitPb', spec: '大工工事', desc: '外部天井PB貼り上げ', unit: '人工', cost: 20000, round: -2, qty: (a) => a.soffitArea / 8, qtyNote: '軒天面積 ÷ 8', on: 'both' },
      { id: 'wood.slopeCeil', spec: '大工工事', desc: '勾配天井施工費', unit: '㎡', cost: 5000, round: -2, qty: (a) => a.slopeCeil, qtyNote: '勾配天井面積', optional: true, on: 'both' },
      { id: 'wood.evoltz', spec: '大工工事', desc: 'エボルツ施工費', unit: '人工', cost: 20000, round: -2, qty: (a) => (a.evoltz ? 2 : 0), qtyNote: '制振ダンパー採用時', optional: true, on: 'both' },
      { id: 'wood.soffitWood', spec: '大工工事', desc: '木板軒天 大工梁手間', unit: '人工', cost: 20000, round: -2, qty: (a) => (a.soffitWood ? 2 : 0), qtyNote: '木板軒天採用時', optional: true, on: 'both' },
    ],
  },
  {
    id: 'roof',
    no: 4,
    name: '屋根・樋工事・板金',
    lines: [
      { id: 'roof.gl', spec: 'ガルバリウム鋼板葺き', desc: 'ガルバリウム鋼板 カラーGL0.35', unit: '㎡', cost: 4400, qty: (a) => a.roofArea, qtyNote: '屋根面積', on: 'both' },
      { id: 'roof.under', spec: 'ガルバリウム鋼板葺き', desc: '下地 改質アスルーフィング', unit: '㎡', cost: 1000, qty: (a) => a.roofArea, qtyNote: '屋根面積', group: 'roofing', on: 'both' },
      { id: 'roof.underKmew', spec: 'ガルバリウム鋼板葺き', desc: 'KMEW イーグルガード 保証なし', unit: '㎡', cost: 1500, qty: (a) => a.roofArea, qtyNote: '屋根面積', group: 'roofing', on: 'none' },
      { id: 'roof.underLiner', spec: 'ガルバリウム鋼板葺き', desc: '田島 ライナールーフィング 保証なし', unit: '㎡', cost: 1300, qty: (a) => a.roofArea, qtyNote: '屋根面積', group: 'roofing', on: 'none' },
      { id: 'roof.underMaster', spec: 'ガルバリウム鋼板葺き', desc: '田島 マスタールーフィング 30年保証', unit: '㎡', cost: 3800, qty: (a) => a.roofArea, qtyNote: '屋根面積', group: 'roofing', on: 'none' },
      { id: 'roof.verge', spec: 'ガルバリウム鋼板葺き', desc: '水上けらば包み（下地・唐草共）', unit: 'm', cost: 1700, qty: (a) => a.eaveLen, qtyNote: '軒先長さ', on: 'both' },
      { id: 'roof.ridgeVent', spec: '換気棟', desc: '換気棟 ※棟長さ計上', unit: 'm', cost: 8000, qty: (a) => a.ridgeLen, qtyNote: '棟長さ', on: 'both' },
      { id: 'roof.gutterPana', spec: '軒樋', desc: '〈Panasonic〉KAKU 材工', unit: 'm', cost: 3800, qty: (a) => a.eaveLen, qtyNote: '軒先長さ', group: 'gutter', on: 'both' },
      { id: 'roof.gutterTanita', spec: '軒樋', desc: '〈タニタハウジング〉ハコH6号 or 半丸105', unit: 'm', cost: 5500, qty: (a) => a.eaveLen, qtyNote: '軒先長さ', group: 'gutter', on: 'none' },
      { id: 'roof.down1', spec: '竪樋', desc: '〈Panasonic〉竪樋丸60 材工 1階 3.5m', unit: '箇所', cost: 8000, qty: (a) => a.downspouts1, qtyNote: '1階 竪樋本数', group: 'down1', on: 'both' },
      { id: 'roof.down2', spec: '竪樋', desc: '〈Panasonic〉竪樋丸60 材工 2階 6.5m', unit: '箇所', cost: 14500, qty: (a) => a.downspouts2, qtyNote: '2階 竪樋本数', group: 'down2', on: 'both' },
      { id: 'roof.downT1', spec: '竪樋', desc: '〈タニタハウジング〉タニタ丸60 1階 3.5m', unit: '箇所', cost: 14000, qty: (a) => a.downspouts1, qtyNote: '1階 竪樋本数', group: 'down1', on: 'none' },
      { id: 'roof.downT2', spec: '竪樋', desc: '〈タニタハウジング〉タニタ丸60 2階 6.5m', unit: '箇所', cost: 27000, qty: (a) => a.downspouts2, qtyNote: '2階 竪樋本数', group: 'down2', on: 'none' },
      { id: 'roof.downK1', spec: '竪樋', desc: '〈タニタハウジング〉角たてとい76×46 1階 3.5m', unit: '箇所', cost: 18500, qty: (a) => a.downspouts1, qtyNote: '1階 竪樋本数', group: 'down1', on: 'none' },
      { id: 'roof.downK2', spec: '竪樋', desc: '〈タニタハウジング〉角たてとい76×46 2階 6.5m', unit: '箇所', cost: 35000, qty: (a) => a.downspouts2, qtyNote: '2階 竪樋本数', group: 'down2', on: 'none' },
      { id: 'roof.balc', spec: 'バルコニー防水工事', desc: 'バルコニー床 防水工事', unit: '㎡', cost: 7000, qty: (a) => a.balconyArea, qtyNote: 'バルコニー面積', on: 'both' },
      { id: 'roof.balcMin', spec: 'バルコニー防水工事', desc: 'バルコニー床 防水工事 ※最低価格', unit: '式', cost: 60000, qty: (a) => (a.balconyArea > 0 && a.balconyArea * 10000 < 85710 ? 1 : 0), qtyNote: '小さいバルコニーのとき', optional: true, on: 'both' },
      { id: 'roof.flash', spec: '土台水切り', desc: '板金水切り', unit: 'm', cost: 1100, round: -2, qty: (a) => a.foundPerim, qtyNote: '基礎外周', group: 'flash', on: 'both' },
      { id: 'roof.flashWm', spec: '土台水切り', desc: '鋼板製 WM防鼠付シャープ水切り', unit: 'm', cost: 2200, round: -2, qty: (a) => a.foundPerim, qtyNote: '基礎外周', group: 'flash', on: 'none' },
    ],
  },
  {
    id: 'sash',
    no: 5,
    name: '金属建具工事',
    lines: [
      { id: 'sash.thermos', spec: 'LIXIL', desc: '【LIXIL】サーモス2H ※概算', unit: '式', cost: 800000, round: -2, group: 'sash', on: ['S'] },
      { id: 'sash.tw', spec: 'LIXIL', desc: '【LIXIL】TW ※概算', unit: '式', cost: 950000, round: -2, group: 'sash', on: ['P'] },
      { id: 'sash.thermosFire', spec: 'LIXIL', desc: '【LIXIL】サーモス2H 防火 ※概算', unit: '式', cost: 1200000, round: -2, group: 'sash', on: 'none' },
      { id: 'sash.twFire', spec: 'LIXIL', desc: '【LIXIL】TW 防火 ※概算', unit: '式', cost: 1400000, round: -2, group: 'sash', on: 'none' },
      { id: 'sash.doorVenato', spec: 'YKK', desc: '玄関開き戸 ヴェナートD30 ストレートハンドル', unit: '式', cost: 120000, round: -2, group: 'entDoor', on: 'both' },
      { id: 'sash.doorVenatoFire', spec: 'YKK', desc: '玄関開き戸 ヴェナートD30 ストレートハンドル ※防火', unit: '式', cost: 240000, round: -2, group: 'entDoor', on: 'none' },
      { id: 'sash.doorConcord', spec: 'YKK', desc: '玄関引き戸 コンコード', unit: '式', cost: 280000, round: -2, group: 'entDoor', on: 'none' },
      { id: 'sash.doorConcordFire', spec: 'YKK', desc: '玄関引き戸 コンコード ※防火', unit: '式', cost: 370000, round: -2, group: 'entDoor', on: 'none' },
      { id: 'sash.pocketKey', spec: 'YKK', desc: 'ポケットキー追加 ※電源直結', unit: '式', cost: 110000, round: -2, qty: (a) => (a.pocketKey ? 1 : 0), optional: true, on: 'both' },
    ],
  },
  {
    id: 'extwall',
    no: 6,
    name: '外壁工事',
    lines: [
      { id: 'ext.jolypat', spec: '外壁サイディング＋塗り壁', desc: 'ジョリパット塗装＋サイディング15㎜', unit: '㎡', cost: 11500, qty: (a) => a.extWall - a.solidoArea, qtyNote: '外壁面積 − SOLIDO 部分', group: 'extwall', on: 'both' },
      { id: 'ext.sto', spec: '外壁サイディング＋塗り壁', desc: 'Sto 塗装＋サイディング15㎜', unit: '㎡', cost: 11500, qty: (a) => a.extWall - a.solidoArea, qtyNote: '外壁面積 − SOLIDO 部分', group: 'extwall', on: 'none' },
      { id: 'ext.gl', spec: 'ガルバリウム鋼板', desc: 'ガルバリウム鋼板 Kスパン＋プラスターボード×2', unit: '㎡', cost: 10500, qty: (a) => a.extWall - a.solidoArea, qtyNote: '外壁面積 − SOLIDO 部分', group: 'extwall', on: 'none' },
      { id: 'ext.solido', spec: 'SOLIDO', desc: '〈ケイミュー〉SOLIDO LAP', unit: '㎡', cost: 14500, qty: (a) => a.solidoArea, qtyNote: 'SOLIDO 面積', optional: true, on: 'both' },
      { id: 'ext.tyvek', spec: '下地', desc: '透湿防水シート〈デュポン〉タイベックシルバー（遮熱付き）貼り', unit: '㎡', cost: 300, qty: (a) => a.extWall, qtyNote: '外壁面積', on: 'both' },
      { id: 'ext.corner', spec: '出隅', desc: '同質出隅材 サイディング', unit: '箇所', cost: 12000, qty: (a) => a.corners - a.solidoCorners, qtyNote: '建物角 − SOLIDO 部分', on: 'both' },
      { id: 'ext.cornerSolidoA', spec: '出隅', desc: '同質出隅材 SOLIDO アングル', unit: '箇所', cost: 7000, qty: (a) => a.solidoCorners, optional: true, on: 'both' },
      { id: 'ext.cornerSolidoB', spec: '出隅', desc: '同質出隅材 SOLIDO 突き付け', unit: '箇所', cost: 17500, qty: () => 0, optional: true, on: 'both' },
      { id: 'ext.caulk', spec: 'コーキング', desc: '外部コーキング', unit: '式', cost: 62000, on: 'both' },
      { id: 'ext.soffitFire', spec: '軒天ボード', desc: '軒天ボード二重張り ※準防火', unit: '㎡', cost: 4500, round: -2, qty: (a) => (a.fireZone ? a.soffitArea : 0), qtyNote: '準防火地域のとき 軒天面積', group: 'soffit', on: 'none' },
      { id: 'ext.soffit', spec: '軒天ボード', desc: '軒天ボード張り', unit: '㎡', cost: 2250, round: -2, qty: (a) => a.soffitArea, qtyNote: '軒天面積', group: 'soffit', on: 'both' },
      { id: 'ext.soffitVent', spec: '軒天見切り材', desc: '軒天換気見切り〈Joto〉FV-016P L=1,820', unit: '式', cost: 40000, round: -2, on: 'both' },
      { id: 'ext.soffitWood', spec: '軒天木板', desc: '〈チャネルオリジナル〉軒天羽目板 杉＋自然塗装', unit: '㎡', cost: 8500, round: -2, qty: (a) => (a.soffitWood ? a.soffitArea : 0), optional: true, on: 'both' },
      { id: 'ext.neoma', spec: '外壁付加断熱', desc: 'ネオマフォーム t25', unit: '㎡', cost: 4500, round: -2, qty: (a) => (a.addInsul ? a.extWall : 0), optional: true, on: 'both' },
    ],
  },
  {
    id: 'inmat',
    no: 7,
    name: '内部建材工事',
    lines: [
      { id: 'in.floorIns', spec: '床断熱材（大引間）', desc: 'スタイロフォームⅢ種 805×805 90㎜', unit: '㎡', cost: 4000, qty: (a) => a.floor1, qtyNote: '1階床面積', group: 'floorIns', on: ['S'] },
      { id: 'in.foundIns', spec: '基礎断熱', desc: 'スタイロフォームⅢ種 805×805 90㎜', unit: '㎡', cost: 5000, qty: (a) => a.floor1, qtyNote: '1階床面積', group: 'floorIns', on: ['P'] },
      { id: 'in.roofGw', spec: '屋根断熱材', desc: 'グラスウール16K t200', unit: '㎡', cost: 3000, qty: (a) => a.insulArea, qtyNote: '断熱面積', group: 'roofIns', on: ['S'] },
      { id: 'in.roofCf', spec: '屋根断熱材', desc: 'セルロースファイバー t200 ※シート施工込', unit: '㎡', cost: 3500, qty: (a) => a.insulArea, qtyNote: '断熱面積', group: 'roofIns', on: ['P'] },
      { id: 'in.wallGw105', spec: '壁断熱', desc: 'グラスウール16K t105', unit: '㎡', cost: 1000, qty: (a) => a.extWall, qtyNote: '外壁面積', group: 'wallIns', on: ['S'] },
      { id: 'in.wallGw120', spec: '壁断熱', desc: 'グラスウール16K t120', unit: '㎡', cost: 1500, qty: (a) => a.extWall, qtyNote: '外壁面積', group: 'wallIns', on: 'none' },
      { id: 'in.wallCf105', spec: '壁断熱', desc: 'セルロースファイバー t105', unit: '㎡', cost: 2800, qty: (a) => a.extWall, qtyNote: '外壁面積', group: 'wallIns', on: 'none' },
      { id: 'in.wallCf120', spec: '壁断熱', desc: 'セルロースファイバー t120 ※シート施工込', unit: '㎡', cost: 3500, qty: (a) => a.extWall, qtyNote: '外壁面積', group: 'wallIns', on: ['P'] },
      { id: 'in.sound', spec: '室内防音材', desc: 'セルロースファイバー t120 ※シート施工込', unit: '㎡', cost: 5000, qty: (a) => a.soundArea, optional: true, on: 'both' },
    ],
  },
  {
    id: 'plaster',
    no: 8,
    name: '塗り・左官工事・タイル',
    lines: [
      { id: 'pl.paint', spec: '内部 塗装', desc: '内部棚等 塗装工事一式 ※造作家具塗装は別途', unit: '坪', cost: 4500, qty: (a) => a.totalTsubo, qtyNote: '延床坪', on: 'both' },
      { id: 'pl.seal', spec: '室内シーリング', desc: 'キッチン・洗面 他', unit: '式', cost: 40000, on: 'both' },
      { id: 'pl.foundSkirt', spec: '基礎外周巾木', desc: '立ち上がりモルタル刷毛引き仕上げ', unit: '㎡', cost: 1500, qty: (a) => a.buildArea, qtyNote: '建築面積', on: 'both' },
      { id: 'pl.boilerBase', spec: '給湯器台', desc: '給湯器下土間', unit: '式', cost: 33000, round: -2, on: 'both' },
      { id: 'pl.porchTile', spec: '土間・ポーチタイル貼り', desc: 'ポーチ（磁器質タイル 600×600程度）＋外部ポーチ', unit: '㎡', cost: 23000, round: -2, qty: (a) => a.porchIn, qtyNote: '内部ポーチ・テラス面積', on: 'both' },
      { id: 'pl.porchBase', spec: '土間・ポーチタイル貼り', desc: 'ポーチ下地', unit: '㎡', cost: 15000, round: -2, qty: (a) => a.porchOut, qtyNote: '外部ポーチ・テラス面積', on: 'both' },
      { id: 'pl.doma', spec: '土間仕上げ', desc: '土間モルタル金鏝＆刷毛引き仕上げ', unit: '㎡', cost: 1400, round: -2, qty: (a) => a.porchOut, qtyNote: '外部ポーチ・テラス面積', on: 'both' },
      { id: 'pl.oil', spec: '無垢床塗装', desc: '無垢床現場塗り 自然クリア塗装', unit: '㎡', cost: 2200, round: -2, qty: (a) => (a.solidFloor ? a.flooringArea : 0), optional: true, on: 'both' },
      { id: 'pl.floorTile', spec: '室内タイル床', desc: '磁器質タイル張り 600×600 ※LDK ホール', unit: '㎡', cost: 20000, round: -2, qty: (a) => a.innerTileArea, optional: true, on: 'both' },
      { id: 'pl.wallSolido', spec: '室内壁タイル', desc: 'SOLIDO張り 600×600 ※リビング・キッチン', unit: '㎡', cost: 12000, round: -2, qty: (a) => a.innerSolidoArea, optional: true, on: 'both' },
      { id: 'pl.doorPaint', spec: '建具塗装', desc: '神谷建具塗装', unit: '箇所', cost: 13000, round: -2, qty: (a) => (a.doorPaint ? a.doors : 0), optional: true, on: 'both' },
      { id: 'pl.porters', spec: '室内塗り壁', desc: 'ポーターズペイント＋塗り壁用クロス ストーン', unit: '㎡', cost: 8000, round: -2, qty: (a) => a.paintWallArea, optional: true, on: 'both' },
      { id: 'pl.balcTile', spec: 'バルコニータイル', desc: 'バルコニータイル＋床上げ', unit: '㎡', cost: 35000, round: -2, qty: (a) => (a.balconyTile ? a.balconyArea : 0), optional: true, on: 'both' },
    ],
  },
  {
    id: 'inbuild',
    no: 9,
    name: '内装建材工事',
    lines: [
      { id: 'ib.kamachi', spec: '玄関 上り框', desc: '【イエモン】木製上がり框 L=2,000', unit: '式', cost: 25000, on: 'both' },
      { id: 'ib.floorIemonClear', spec: '床材', desc: '【イエモン】挽板 t15 w158 ジャイロオーク クリア・スモーク', unit: '㎡', cost: 6800, round: -2, qty: (a) => a.flooringArea, qtyNote: 'フローリング面積', group: 'floor', on: 'none' },
      { id: 'ib.floorIemonMocha', spec: '床材', desc: '【イエモン】挽板 t15 w158 ジャイロオーク モカ', unit: '㎡', cost: 7000, round: -2, qty: (a) => a.flooringArea, qtyNote: 'フローリング面積', group: 'floor', on: 'none' },
      { id: 'ib.floorChannel', spec: '床材', desc: '【チャネルオリジナル】挽板 t15 オーク W150', unit: '㎡', cost: 7000, round: -2, qty: (a) => a.flooringArea, qtyNote: 'フローリング面積', group: 'floor', on: 'both' },
      { id: 'ib.floorIoc', spec: '床材', desc: '【IOC】無垢床', unit: '㎡', cost: 18000, round: -2, qty: (a) => a.flooringArea, qtyNote: 'フローリング面積', group: 'floor', on: 'none' },
      { id: 'ib.doorKamiya', spec: '建具', desc: '【神谷コーポレーション】キューブ', unit: '箇所', cost: 70000, round: -2, qty: (a) => a.doors, qtyNote: '建具個数', group: 'door', on: 'both' },
      { id: 'ib.doorLixil', spec: '建具', desc: '【LIXIL】ラシッサ', unit: '箇所', cost: 28000, round: -2, qty: (a) => a.doors, qtyNote: '建具個数', group: 'door', on: 'none' },
      { id: 'ib.sill', spec: '窓枠', desc: '【イエモン】木製下台 or クロス巻込み', unit: '坪', cost: 1700, round: -2, qty: (a) => a.totalTsubo, qtyNote: '延床坪', on: 'both' },
      { id: 'ib.skirting', spec: '巾木', desc: '【神谷コーポレーション】スリム巾木', unit: '坪', cost: 1100, round: -2, qty: (a) => a.totalTsubo, qtyNote: '延床坪', on: 'both' },
      { id: 'ib.highCeil', spec: '高天井', desc: '高天井変更費 ※H2500以上', unit: '㎥', cost: 40000, round: -2, qty: (a) => a.highCeil, optional: true, on: 'both' },
      { id: 'ib.stairSt', spec: '階段', desc: 'St鉄骨階段 St手摺 木踏板', unit: '式', cost: 850000, round: -2, qty: (a) => a.stairs, qtyNote: '階段数', group: 'stair', on: 'both' },
      { id: 'ib.handrail', spec: '手摺', desc: 'St手摺', unit: 'm', cost: 35000, round: -2, qty: (a) => a.handrailLen, optional: true, on: 'both' },
      { id: 'ib.shelves', spec: '棚工事一式', desc: '【WOODONE】室内棚工事一式 ※概算 仕様打合せにて詳細決定', unit: '式', cost: 300000, round: -2, on: 'both' },
      { id: 'ib.floorHatch', spec: '床下点検口', desc: '高断熱型床下点検口', unit: '式', cost: 32000, round: -2, on: 'both' },
      { id: 'ib.ceilHatch', spec: '天井点検口', desc: 'アルミ天井点検口 450サイズ', unit: '式', cost: 17000, round: -2, on: 'both' },
      { id: 'ib.evoltz', spec: '制振ダンパー', desc: 'evoltz B5 6本', unit: '式', cost: 380000, round: -2, qty: (a) => (a.evoltz ? 1 : 0), optional: true, on: 'both' },
      { id: 'ib.woodCeil', spec: '木板天井', desc: '〈チャネルオリジナル〉軒天羽目板 杉＋自然塗装', unit: '㎡', cost: 8500, round: -2, qty: (a) => a.woodCeilArea, optional: true, on: 'both' },
    ],
  },
  {
    id: 'custom',
    no: 10,
    name: '造作工事',
    lines: [
      { id: 'cu.vanity1200', spec: '造作洗面', desc: '造作洗面 W1200 ※概算', unit: '式', cost: 330000, group: 'vanity', on: 'both' },
      { id: 'cu.vanity750', spec: '造作洗面', desc: '造作洗面 W750 ※概算', unit: '式', cost: 220000, group: 'vanity', on: 'none' },
      { id: 'cu.cupboard', spec: '造作カップボード', desc: '造作カップボード W1820 ※概算', unit: '式', cost: 385000, round: -2, on: 'both' },
    ],
  },
  {
    id: 'interior',
    no: 11,
    name: '内装工事',
    lines: [
      { id: 'it.clothAA', spec: 'ビニールクロス', desc: '天井・壁 ビニールクロス貼り（AA級・普及品）・耐震パテ', unit: '坪', cost: 29000, qty: (a) => a.constTsubo + a.voidArea * T, qtyNote: '施工坪＋吹抜坪', group: 'cloth', on: ['P'] },
      { id: 'it.clothA', spec: 'ビニールクロス', desc: '天井・壁 ビニールクロス貼り（A級・普及品）', unit: '坪', cost: 26000, qty: (a) => a.totalTsubo + a.voidArea * T, qtyNote: '延床坪＋吹抜坪', group: 'cloth', on: ['S'] },
      { id: 'it.floorTile', spec: 'フロアタイル', desc: '床フロアタイル貼り', unit: '㎡', cost: 8000, qty: (a) => a.floorTileArea, qtyNote: 'フロアタイル面積', on: 'both' },
      { id: 'it.floorTileWc', spec: 'フロアタイル', desc: '床フロアタイル貼り トイレ', unit: '式', cost: 20000, qty: (a) => a.toilets, qtyNote: 'トイレ数', on: 'both' },
      { id: 'it.doorCloth', spec: '建具クロス張り', desc: '神谷コーポレーション 建具クロス張り', unit: '箇所', cost: 5000, qty: (a) => a.doorCloth, optional: true, on: 'both' },
      { id: 'it.tatami1', spec: '畳（縁無し 1帖）', desc: 'スタイロ畳', unit: '枚', cost: 20000, qty: (a) => a.tatami1, qtyNote: '和室の帖数', optional: true, on: 'both' },
      { id: 'it.tatamiHalf', spec: '畳（縁無し 半帖）', desc: 'スタイロ畳', unit: '枚', cost: 15000, qty: (a) => a.tatamiHalf, optional: true, on: 'both' },
    ],
  },
  {
    id: 'equip',
    no: 12,
    name: '設備工事',
    lines: [
      { id: 'eq.bath1616', spec: 'ユニットバス', desc: '【TOTO】サザナ 1616', unit: '式', cost: 420000, margin: 0.8, group: 'bath', on: 'both' },
      { id: 'eq.bath1620', spec: 'ユニットバス', desc: '【TOTO】サザナ 1620 ※概算', unit: '式', cost: 800000, margin: 0.8, group: 'bath', on: 'none' },
      { id: 'eq.wc1', spec: '1階トイレ', desc: '【TOTO】NJ1', unit: '式', cost: 120000, margin: 0.8, qty: (a) => Math.min(1, a.toilets), on: 'both' },
      { id: 'eq.handwash', spec: '1階トイレ', desc: '手洗いカウンター＋水栓', unit: '式', cost: 75000, margin: 0.8, qty: (a) => (a.handwash ? 1 : 0), optional: true, on: 'both' },
      { id: 'eq.wc2', spec: '2階トイレ', desc: '【TOTO】ZJ1', unit: '式', cost: 70000, margin: 0.8, qty: (a) => Math.max(0, a.toilets - 1), qtyNote: 'トイレ数 − 1', on: 'both' },
      { id: 'eq.kitchenHl', spec: 'システムキッチン', desc: '【HLオリジナル】LINEキッチン ペニンシュラ型', unit: '式', cost: 1000000, margin: 0.8, group: 'kitchen', on: 'both' },
      { id: 'eq.kitchenCustom', spec: 'システムキッチン', desc: '造作キッチン', unit: '式', cost: 3500000, margin: 0.8, group: 'kitchen', on: 'none' },
      { id: 'eq.vent3wall', spec: '換気設備', desc: '第三種 壁式 換気', unit: '式', cost: 85000, group: 'vent', on: ['S'] },
      { id: 'eq.vent3dsdd', spec: '換気設備', desc: '第三種換気 ダクト式 DSDD ※防蟻をセントリコンに変更', unit: '式', cost: 1200000, group: 'vent', on: 'none' },
      { id: 'eq.vent3lufro', spec: '換気設備', desc: '第三種換気 ダクト式 ルフロ', unit: '式', cost: 300000, group: 'vent', on: ['P'] },
      { id: 'eq.vent1lossnay', spec: '換気設備', desc: '第一種換気 ダクト式 ロスナイ', unit: '式', cost: 600000, group: 'vent', on: 'none' },
      { id: 'eq.vent1sumika', spec: '換気設備', desc: '第一種換気 ダクト式 澄家', unit: '式', cost: 1400000, group: 'vent', on: 'none' },
      { id: 'eq.acFloor', spec: '空調', desc: '床下エアコン ※ガラリ・エアコン設置工事 基礎断熱は別途', unit: '式', cost: 420000, group: 'ac', on: 'both' },
      { id: 'eq.acDaikin', spec: '空調', desc: 'ダイキン アメニティ エアコン', unit: '式', cost: 1300000, group: 'ac', on: 'none' },
      { id: 'eq.acc', spec: '設備アクセサリー', desc: '中部レプ一式', unit: '式', cost: 25000, on: 'both' },
      { id: 'eq.kanta', spec: '衣類乾燥機', desc: '幹太くん引き込み工事のみ', unit: '式', cost: 40000, qty: (a) => (a.kanta ? 1 : 0), optional: true, on: 'both' },
      { id: 'eq.slop', spec: '衣類乾燥機', desc: 'スロップシンク＆単水栓', unit: '式', cost: 80000, qty: (a) => (a.slopSink ? 1 : 0), optional: true, on: 'both' },
      { id: 'eq.ecojozu', spec: '給湯器', desc: 'エコジョーズ', unit: '式', cost: 250000, group: 'water', on: 'none' },
      { id: 'eq.ecocute360', spec: '給湯器', desc: 'エコキュート 360L', unit: '式', cost: 380000, group: 'water', on: 'both' },
      { id: 'eq.ecocute460', spec: '給湯器', desc: 'エコキュート 460L', unit: '式', cost: 400000, group: 'water', on: 'none' },
      { id: 'eq.ecoone', spec: '給湯器', desc: 'エコワン 70L ※ウルトラファインバブル付き', unit: '式', cost: 650000, group: 'water', on: 'none' },
      { id: 'eq.pv43', spec: '太陽光', desc: '【キューセルズ】4.3kw パワコン込', unit: '式', cost: 1100000, group: 'pv', on: 'both' },
      { id: 'eq.pvNone', spec: '太陽光', desc: '太陽光なし', unit: '式', cost: 0, group: 'pv', on: 'none' },
    ],
  },
  {
    id: 'elec',
    no: 13,
    name: '電気工事',
    lines: [
      { id: 'el.main', spec: '電気工事', desc: '引込み幹線・仮設ポール工事・他電気工事費', unit: '式', cost: 496650, on: 'both' },
      { id: 'el.ecocute', spec: '電気工事', desc: 'エコキュート接続工事', unit: '式', cost: 40000, qty: (a) => (a.waterHeater === 'ecocute' ? 1 : 0), qtyNote: 'エコキュートのとき', on: 'both' },
      { id: 'el.light', spec: '電灯コンセント設備工事', desc: '電灯配線工事', unit: '箇所', cost: 1700, qty: (a) => Math.round(40 * a.scale), qtyNote: '延床 30 坪で 40', on: 'both' },
      { id: 'el.switch', spec: '電灯コンセント設備工事', desc: 'スイッチ配線工事', unit: '箇所', cost: 3000, qty: (a) => Math.round(30 * a.scale), qtyNote: '延床 30 坪で 30', on: 'both' },
      { id: 'el.switch3', spec: '電灯コンセント設備工事', desc: '3路スイッチ配線工事', unit: '箇所', cost: 7500, qty: (a) => Math.round(5 * a.scale), qtyNote: '延床 30 坪で 5', on: 'both' },
      { id: 'el.outlet', spec: '電灯コンセント設備工事', desc: 'コンセント配線工事', unit: '箇所', cost: 3000, qty: (a) => Math.round(25 * a.scale), qtyNote: '延床 30 坪で 25', on: 'both' },
      { id: 'el.outletE', spec: '電灯コンセント設備工事', desc: 'E付専用コンセント工事', unit: '箇所', cost: 10000, qty: (a) => Math.round(8 * a.scale), qtyNote: '延床 30 坪で 8', on: 'both' },
      { id: 'el.ac', spec: '電灯コンセント設備工事', desc: '100W or 200W エアコン用コンセント工事＆スリーブ工事', unit: '箇所', cost: 13000, qty: (a) => Math.round(5 * a.scale), qtyNote: '延床 30 坪で 5', on: 'both' },
      { id: 'el.outletWp', spec: '電灯コンセント設備工事', desc: 'アース付防水コンセント配線工事', unit: '箇所', cost: 7500, qty: (a) => Math.round(5 * a.scale), qtyNote: '延床 30 坪で 5', on: 'both' },
      { id: 'el.soStyle', spec: '電灯コンセント設備工事', desc: 'So スタイル スイッチ or コンセント設置', unit: '箇所', cost: 1550, qty: (a) => a.soStyle, optional: true, on: 'both' },
      { id: 'el.furnOutlet', spec: '電灯コンセント設備工事', desc: '家具用コンセント工事 ※神保コンセント', unit: '箇所', cost: 3300, qty: (a) => Math.round(10 * a.scale), qtyNote: '延床 30 坪で 10', on: 'both' },
      { id: 'el.kitchenOutlet', spec: '電灯コンセント設備工事', desc: 'キッチン家具コンセント埋め込み工事', unit: '箇所', cost: 8000, qty: () => 0, optional: true, on: 'both' },
      { id: 'el.jb', spec: '電灯コンセント設備工事', desc: 'JB取付工事', unit: '箇所', cost: 2500, qty: () => 0, optional: true, on: 'both' },
      { id: 'el.ev', spec: '電灯コンセント設備工事', desc: 'EVコンセント工事', unit: '箇所', cost: 18000, qty: (a) => (a.evOutlet ? 1 : 0), optional: true, on: 'both' },
      { id: 'el.autoSw', spec: '電灯コンセント設備工事', desc: 'かってにスイッチ設置', unit: '箇所', cost: 9000, qty: () => 0, optional: true, on: 'both' },
      { id: 'el.ventDuct', spec: '換気扇設備工事', desc: '換気扇ダクト工事＆ベントキャップ', unit: '箇所', cost: 13500, qty: (a) => a.fanDucts, qtyNote: 'P: 3 ／ S: 6', on: 'both' },
      { id: 'el.pipeFan', spec: '換気扇設備工事', desc: '壁・天井換気扇 パイプファン', unit: '箇所', cost: 14000, qty: (a) => a.pipeFans, qtyNote: 'P: 3 ／ S: 5', on: 'both' },
      { id: 'el.intercom', spec: '弱電設備工事', desc: 'インターホン工事', unit: '箇所', cost: 45000, on: 'both' },
      { id: 'el.tv', spec: '弱電設備工事', desc: 'テレビ配線工事', unit: '箇所', cost: 7000, on: 'both' },
      { id: 'el.tel', spec: '弱電設備工事', desc: '電話工事', unit: '箇所', cost: 7000, on: 'both' },
      { id: 'el.lan', spec: '弱電設備工事', desc: 'LAN工事', unit: '箇所', cost: 13500, qty: () => 2, on: 'both' },
      { id: 'el.conduit', spec: '弱電設備工事', desc: '空配管', unit: '箇所', cost: 5000, on: 'both' },
      { id: 'el.fixtures', spec: '照明器具', desc: '照明器具 ※概算', unit: '箇所', cost: 400000, margin: 0.8, on: 'both' },
    ],
  },
  {
    id: 'plumb',
    no: 14,
    name: '給排水工事',
    lines: [
      { id: 'pb.outWater', spec: '屋外給水設備工事', desc: '配管工事費', unit: '式', cost: 55000, on: 'both' },
      { id: 'pb.tap', spec: '屋外給水設備工事', desc: '外部立水栓 or 散水栓', unit: '式', cost: 20000, on: 'both' },
      { id: 'pb.outDrain', spec: '屋外排水設備工事', desc: '配管工事費', unit: '式', cost: 145000, on: 'both' },
      { id: 'pb.sewerPit', spec: '屋外排水設備工事', desc: '汚水桝', unit: '箇所', cost: 11000, qty: () => 10, on: 'both' },
      { id: 'pb.rainPit', spec: '屋外排水設備工事', desc: '雨水桝', unit: '箇所', cost: 14000, qty: () => 10, on: 'both' },
      { id: 'pb.septic', spec: '浄化槽', desc: '5人槽 ※130㎡未満', unit: '式', cost: 650000, qty: (a) => (a.septic ? 1 : 0), optional: true, on: 'both' },
      { id: 'pb.inner', spec: '屋内給排水設備工事', desc: '屋内給排水工事', unit: '式', cost: 480000, on: 'both' },
      { id: 'pb.no2f', spec: '屋内給排水設備工事', desc: '二階水回り無し', unit: '式', cost: -70000, qty: (a) => (a.wet2f === 'none' ? 1 : 0), qtyNote: '2階に水回りが無いとき', on: 'both' },
      { id: 'pb.ldk2f', spec: '屋内給排水設備工事', desc: '二階リビング水回り給排水工事', unit: '式', cost: 165000, qty: (a) => (a.wet2f === 'ldk' ? 1 : 0), qtyNote: '2階リビングのとき', on: 'both' },
      { id: 'pb.sleeve', spec: '土間スリーブ工事', desc: '基礎貫通スリーブ', unit: '式', cost: 80000, on: 'both' },
      { id: 'pb.wcSet', spec: '土間スリーブ工事', desc: 'トイレ設置＆接続', unit: '箇所', cost: 17000, qty: (a) => a.toilets, qtyNote: 'トイレ数', on: 'both' },
      { id: 'pb.handwashSet', spec: '土間スリーブ工事', desc: '手洗い設置＆接続', unit: '式', cost: 20000, qty: (a) => (a.handwash ? 1 : 0), optional: true, on: 'both' },
      { id: 'pb.vanitySet', spec: '土間スリーブ工事', desc: '洗面化粧台設置＆接続', unit: '式', cost: 66000, on: 'both' },
      { id: 'pb.washerSet', spec: '土間スリーブ工事', desc: '洗濯水栓・洗濯トラップ設置＆接続', unit: '組', cost: 9000, on: 'both' },
      { id: 'pb.kitchenSet', spec: '土間スリーブ工事', desc: 'キッチン接続', unit: '式', cost: 35000, on: 'both' },
      { id: 'pb.bathSet', spec: '土間スリーブ工事', desc: 'ユニットバス接続', unit: '式', cost: 9000, on: 'both' },
      { id: 'pb.slopSet', spec: '土間スリーブ工事', desc: 'スロップシンク接続', unit: '式', cost: 17000, qty: (a) => (a.slopSink ? 1 : 0), optional: true, on: 'both' },
      { id: 'pb.mixer', spec: '土間スリーブ工事', desc: '混合栓変更', unit: '箇所', cost: 25000, qty: () => 0, optional: true, on: 'both' },
      { id: 'pb.gas', spec: 'ガス工事', desc: 'ガス配管工事', unit: '式', cost: 170000, qty: (a) => (a.waterHeater === 'ecocute' ? 0 : 1), qtyNote: 'ガス給湯のとき', on: 'both' },
    ],
  },
  {
    id: 'misc',
    no: 15,
    name: '雑工事',
    lines: [
      { id: 'mi.clean', spec: '美装工事', desc: '美装工事（お引渡し掃除）', unit: '㎡', cost: 550, round: -1, qty: (a) => a.totalArea, qtyNote: '延床面積', on: 'both' },
      { id: 'mi.termite', spec: '防蟻処置', desc: '防蟻処置 ※DSDD の場合除く', unit: '㎡', cost: 500, qty: (a) => a.buildArea, qtyNote: '建築面積', on: 'both' },
      { id: 'mi.airtest', spec: '気密測定', desc: '気密測定一式', unit: '式', cost: 60000, on: 'both' },
      { id: 'mi.travel', spec: '交通費', desc: '交通費 ※支店から15km以上計上', unit: 'km', cost: 10000, round: -2, qty: (a) => a.travelKm, optional: true, on: 'both' },
    ],
  },
  {
    id: 'design',
    no: 16,
    name: '諸経費',
    lines: [
      { id: 'de.design', spec: '設計費用', desc: '設計監理費用', unit: '式', cost: 300000, fixedPrice: 1000000, on: 'both' },
      { id: 'de.struct', spec: '許容応力度計算', desc: '許容応力度計算', unit: '式', cost: 300000, round: -2, qty: (a) => (a.structCalc ? 1 : 0), optional: true, on: 'both' },
      { id: 'de.longlife', spec: '長期優良住宅', desc: '長期優良住宅申請代行費', unit: '式', cost: 300000, fixedPrice: 380000, on: 'both' },
      { id: 'de.inspect', spec: '第三者機関目視録', desc: '第三者機関による目視録', unit: '式', cost: 150000, margin: 0.75, round: -2, on: 'both' },
    ],
  },
];

/** 雑工事・諸経費は金額を 1 円単位（シートの ROUNDDOWN(…,0)）、それ以外は十円単位 */
export const AMOUNT_ROUND: Record<string, number> = { misc: 0, design: 0 };

export function lineById(id: string): LineDef | undefined {
  for (const c of CATEGORIES) for (const l of c.lines) if (l.id === id) return l;
  return undefined;
}
