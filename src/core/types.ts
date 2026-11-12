/**
 * 建物モデル（間取り解析の結果）
 *
 * 座標系: 平面図の見た目どおり x→右, y→下 (mm)。
 * 図面の上方向 (-y) が「図面上の北」。真北とのずれは BuildingModel.northAngleDeg で表す。
 */

export interface Vec2 {
  x: number;
  y: number;
}

export type RoomType =
  | 'ldk'
  | 'living'
  | 'dining'
  | 'kitchen'
  | 'japanese'
  | 'bedroom'
  | 'kids'
  | 'study'
  | 'bath'
  | 'washroom'
  | 'toilet'
  | 'entrance'
  | 'hall'
  | 'stairs'
  | 'closet'
  | 'storage'
  | 'balcony'
  | 'porch'
  | 'garage'
  // 外構（家の外の区画。延床面積に入らない）
  | 'carport'
  | 'parking'
  | 'deck'
  | 'terrace'
  | 'shed'
  | 'void'
  | 'other';

/** ガレージの建て方: ビルトイン（家の中）／後付け（家に接して別に建てる。GAW など）／離れ（家から離れて建つ） */
export type GarageKind = 'builtin' | 'attached' | 'detached';

/** shutter = ガレージのシャッター（壁いっぱいの開口。閉じたスラット付きのパネルで描く） */
export type OpeningKind = 'window' | 'door' | 'sliding' | 'entrance' | 'open' | 'shutter';

/** 窓の種類（高さ・腰高の決定に使う） */
export type WindowStyle = 'hakidashi' | 'koshi' | 'small' | 'high' | 'slit' | 'none';

export interface Wall {
  id: string;
  a: Vec2;
  b: Vec2;
  thickness: number;
  exterior: boolean;
  /** 外部側の法線の向き (a→b に対して左=+1 / 右=-1)。外壁のみ意味を持つ */
  outsideSign?: 1 | -1;
  /** 端部が他の壁と接続しているか（3D生成時の端面省略に使う） */
  joinedA?: boolean;
  joinedB?: boolean;
  /** この壁だけの仕上げ: true = アクセント（外壁ならテイストのアクセント材、内壁ならアクセントクロス）、false = 通常に戻す。省略時はテイストの決まり */
  accent?: boolean;
  /**
   * 壁の天端の高さ（その階の床からの mm）の指定。袖壁（2,400 など）・腰壁（1,100）・パラペット（軒より高く立ち上げる）。
   * 無ければ自動（天井まで／外壁は軒まで／バルコニーの縁は手すり壁 1.1m）
   */
  topMm?: number;
}

/** 部屋ごとの床仕上げの上書き（省略時は部屋の種類から: 水まわりはタイル、和室は畳、玄関・ガレージは土間） */
export type FloorFinish = 'wood' | 'tile' | 'tatami' | 'doma';
export const FLOOR_FINISH_LABEL: Record<FloorFinish, string> = { wood: 'フローリング', tile: 'タイル', tatami: '畳', doma: '土間（モルタル・タイル）' };

export interface Opening {
  id: string;
  wallId: string;
  kind: OpeningKind;
  /** 壁の a 点からの距離 (mm) */
  t0: number;
  t1: number;
  /** 床からの腰高 (mm) */
  sill: number;
  /** 開口高さ (mm) */
  height: number;
  windowStyle?: WindowStyle;
  /** 開き戸のヒンジが t0 側か */
  hingeAtStart?: boolean;
  /** 開き戸の開く側 (壁の法線 +1/-1) */
  swingSide?: 1 | -1;
  /** 解析の確信度 0..1 */
  confidence?: number;
  /**
   * 勝手口・ガレージの通用口（玄関ではない、外へ出る開き戸）。kind は 'door'。
   * 3D では庇・ポーチを付けず、外開きの勝手口ドア（上半分ガラス）と踏み段だけにする
   */
  service?: boolean;
  /**
   * 腰高・高さの出どころ: 立面図の窓の線から読んだ／設計の 3D データで測った。
   * 図面どおりの高さなので、仕様の「サッシ上端＝天井」でそろえ直さない
   */
  heightFrom?: 'elevation' | '3d';
  /**
   * 室内窓（部屋と部屋の間の壁のガラス: FIX・引違い。図面で通り口の印が無い窓の記号）。kind は 'window'。
   * 仕様の「サッシ上端＝天井」でそろえ直さず、カーテン・水切りも付けない。採光の窓にも数えない
   */
  interior?: boolean;
}

export interface Room {
  id: string;
  name: string;
  type: RoomType;
  /** 壁芯ベースの外形 (時計回り/反時計回りは問わない) */
  polygon: Vec2[];
  /** 面積 (㎡) */
  area: number;
  labelPos: Vec2;
  /** 図面に書かれていた帖数 */
  labeledTatami?: number;
  /** 階段の昇り方向などの補助情報 */
  stairDir?: 'up' | 'down';
  /** 室名が図面に無く、隣の部屋から推定した名前 */
  inferred?: boolean;
  /** ガレージの建て方（type が garage のとき。省略時は外形との位置から判定: 家の中ならビルトイン） */
  garageKind?: GarageKind;
  /** この部屋だけの天井高 (mm)。無ければ階の天井高（LDK と水まわりだけ 3,500 などの部分的な高天井） */
  ceilingHeight?: number;
  /** この部屋だけの床仕上げ（3D で床をクリックして変える）。無ければ部屋の種類から */
  floorFinish?: FloorFinish;
  /** 床の FL からの段差 (mm)。小上がり +300〜400、ダウンリビング −300〜400、中二階 +1,400 など。無ければ 0（玄関の土間は isDomaRoom で −180） */
  floorOffset?: number;
  /** 吹抜（type 'void'）の落下防止の種類。無ければテイスト（仕様）の既定 */
  voidGuard?: VoidGuard;
}

/** 吹抜の落下防止: 腰壁／腰壁＋ガラス／スチール手すり／アイアン手すり／ガラス手すり／天井までの壁 */
export type VoidGuard = 'half' | 'halfGlass' | 'steel' | 'iron' | 'glass' | 'wall';
export const VOID_GUARDS: readonly VoidGuard[] = ['half', 'halfGlass', 'steel', 'iron', 'glass', 'wall'];
export const VOID_GUARD_LABEL: Record<VoidGuard, string> = { half: '腰壁', halfGlass: '腰壁＋ガラス', steel: 'スチール手すり（縦桟）', iron: 'アイアン手すり（細い丸棒）', glass: 'ガラス手すり', wall: '壁（天井まで）' };
/** 床の段差のプリセット（FL からの mm） */
export const FLOOR_OFFSET_PRESETS: { label: string; v: number }[] = [
  { label: '段差なし', v: 0 },
  { label: '小上がり +300', v: 300 },
  { label: '小上がり +400', v: 400 },
  { label: 'ダウンリビング −300', v: -300 },
  { label: 'ダウンリビング −400', v: -400 },
  { label: '中二階 +1,400', v: 1400 },
];
/** 室名から分かる床の段差（小上がり → +400、ダウンリビング・ダウンフロア → −400）。分からなければ undefined */
export function floorOffsetByName(name: string): number | undefined {
  const n = (name ?? '').normalize('NFKC');
  if (/小上がり|小上り|小上|段上がり/.test(n)) return 400;
  if (/ダウンリビング|ダウンフロア|ピットリビング|ダウンダイニング/.test(n)) return -400;
  return undefined;
}

export interface Stair {
  id: string;
  /** 軸平行矩形 */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 'straight' = 直階段, 'u' = 折り返し階段（中央は腰壁）, 'uOpen' = コの字階段（中央が吹抜で、奥の踊り場で回る）, 'l' = かね折れ階段 */
  kind: 'straight' | 'u' | 'uOpen' | 'l';
  /** 折り返し・かね折れで曲がる向き（昇る人から見て）。省略時: 折り返しは左、かね折れは右 */
  turn?: 'left' | 'right';
  /** 昇り口のある辺（n = 図面の上側 = minY） */
  entry: 'n' | 's' | 'e' | 'w';
  /** 上階へ昇る階段か（上階側に記載された DN 階段は false） */
  goesUp: boolean;
  /** 図面に書かれた段数（「14段」など）。省略時は階高から推定 */
  steps?: number;
  /** かね折れ階段の 1 列の幅（mm）。図面で列の幅が読めたとき（半間 = 910 など）。省略時は 1,000 まで */
  flightWidth?: number;
}

export interface Floor {
  level: number; // 1 = 1階
  /** 地盤面(GL)からの床高さ (mm) */
  elevation: number;
  /** 階高 (mm) */
  height: number;
  /** 天井高 (mm) */
  ceilingHeight: number;
  walls: Wall[];
  openings: Opening[];
  rooms: Room[];
  stairs: Stair[];
  /** 建物外形（外壁芯） */
  outline: Vec2[][];
  /** 図面の記号から読み取った家具・設備（図面どおりの位置・向き。自動配置より優先） */
  planItems?: FurnitureItem[];
  /** 家具の判定に使った図面の長方形（修正画面で直した答えを記号辞書に覚えるため） */
  symbolCandidates?: { id: number; cx: number; cy: number; w: number; h: number; inner: number; arcs?: number; roomId: string; kind?: FurnitureKind }[];
  /** 図面の記号から読み取った外構（車・植栽。図面座標 mm） */
  exterior?: { cars: { x: number; y: number; rot: number }[]; trees: { x: number; y: number; r: number }[] };
  /** 図面に書かれた設計士のメモ（吹き出しの説明文） */
  notes?: { text: string; x: number; y: number; roomId?: string }[];
  /**
   * 柱（修正画面で置いた柱）。その階の床から上の階の床（最上階は軒）まで立つ。
   * 2 階の張り出し（オーバーハング）の足元の柱は 1 階に置く。通し柱は 1 階に置き、2 階の上まで通る
   */
  posts?: Post[];
}

/** 柱の種類: 管柱（その階だけ）・通し柱（1 階から 2 階の上まで）・独立柱（壁から離れて立つ柱。張り出しの足元・ポーチ・吹抜など） */
export type PostKind = 'kuda' | 'toshi' | 'free';

export interface Post {
  id: string;
  /** 柱の芯（図面座標 mm） */
  x: number;
  y: number;
  /** 柱の太さ（角柱の一辺・丸柱の径 mm。105 / 120 / 150 など） */
  size: number;
  kind: PostKind;
  /** 丸柱 */
  round?: boolean;
  /** 自動の提案（2 階の張り出しの角など）で置いた柱 */
  auto?: boolean;
}

export const POST_KIND_LABEL: Record<PostKind, string> = { kuda: '管柱', toshi: '通し柱', free: '独立柱' };

export interface ParseReport {
  pages: number;
  scaleDenominator: number | null;
  mmPerPt: number;
  scaleSource: 'dimension' | 'text' | 'area' | 'module' | 'default' | 'manual' | 'elevation';
  wallThicknesses: number[];
  warnings: string[];
  timingsMs: Record<string, number>;
  /** 方位記号が読み取れたか（false = 図面の上を北とみなした） */
  northDetected?: boolean;
  /** 図面の面積表（階 → ㎡。build = 建築面積、total = 延床面積）。読み取りの点数で階の広さ・上下階の重なりの検算に使う */
  areaTable?: Record<number, number> & { build?: number; total?: number };
  /** PDF の各ページの中身（kind: plan・elevation・section・site・area など。parser/pageMap の PageKind）と、読み取りに使ったこと */
  pageMap?: { page: number; kind: string; title: string; used?: string }[];
  /** 立面図のページの外部仕上表（欄の名前・中の文言・色）。読み込み時にコーディネートの初期値にする */
  finishTable?: { part: string; text: string; color?: string }[];
  /** 立面図で直した上下階の重ね位置（mm。図面の右・下が +） */
  floorShifts?: { level: number; dx: number; dy: number }[];
  /** 立面図の窓の線から窓の高さを当てた結果（当てた面・確かめた窓・腰高と高さを直した窓・足した窓・面の外壁の窓） */
  elevationWindows?: { views: number; facades: string[]; matched: number; changed: number; added: number; total: number };
  /** 立面図の屋根の線から読めた掛け方（屋根の塊の数と、人に見せる要約） */
  elevationRoof?: { masses: number; summary: string };
  /**
   * 開口を白抜きで描く図面（壁の塗りの上に白い長方形を重ねて窓・戸を描く）から読み、白抜きがすべて開口として読めた階。
   * その階では、窓の無い部屋は読み落としではなく「図面に窓が描かれていない」
   */
  openingsByMask?: number[];
}

/** 図面上の辺（図面の上 = top） */
export type PlanSide = 'top' | 'right' | 'bottom' | 'left';

export interface RoadInfo {
  side: PlanSide;
  /** 道路幅員 (mm) */
  widthMm?: number;
  /** 読み取った文字 */
  label?: string;
  /** どこから決めたか（inferred = 隣地境界線の無い側・駐車場のある側から推定） */
  source: 'text' | 'compass' | 'manual' | 'inferred';
}

export interface SiteEdge {
  a: Vec2;
  b: Vec2;
  kind: 'road' | 'neighbor';
}

/** 道路・隣地との段差の処理 */
export type RetainingKind = 'rc' | 'stone' | 'slope';
export const RETAINING_LABEL: Record<RetainingKind, string> = { rc: 'RC 擁壁', stone: '石積み（間知ブロック）', slope: '法面（芝）' };
/** 玄関アプローチの段差の処理 */
export type ApproachKind = 'steps' | 'ramp';
export const APPROACH_LABEL: Record<ApproachKind, string> = { steps: '階段', ramp: 'スロープ' };
/**
 * 敷地の高低差（設計 GL ＝ 0 とした mm。＋ は敷地より高い、− は低い）。
 * パース（道路・隣家の地盤の高さ、擁壁、玄関の階段、道路レベルの駐車場）と日照（周辺建物の足元）に反映する
 */
export interface SiteLevels {
  /** 前面道路の路面（−800 = 道路が 80 cm 低い＝敷地が高い） */
  roadMm?: number;
  /** 隣地の地盤（図面の上・右・下・左の辺ごと。無い辺は敷地と同じ） */
  neighborMm?: Partial<Record<PlanSide, number>>;
  /** 段差の処理。省略 = RC 擁壁 */
  retaining?: RetainingKind;
  /** 玄関アプローチ。省略 = 階段 */
  approach?: ApproachKind;
  /** 駐車スペースを道路の高さに下げる（敷地が道路より高いとき。車は道路からそのまま入れる） */
  parkingAtRoad?: boolean;
  /** 出典: 手入力／国土地理院の標高タイルからの推定 */
  source?: 'manual' | 'dem';
  /** 出典のメモ（推定に使ったデータ・精度） */
  note?: string;
}

export interface SiteData {
  roads: RoadInfo[];
  /** 図面の「道路境界線」「隣地境界線」の文字が付いた線（斜めの境界も含む） */
  edges?: SiteEdge[];
  /** 敷地の形（境界線がつながって閉じた場合） */
  polygon?: Vec2[];
  /** 敷地境界線の位置（図面座標 mm。分かった辺のみ） */
  bounds: Partial<Record<PlanSide, number>>;
  /** 敷地面積（図面の表記） */
  areaM2?: number;
  /** 図面の敷地線を使わなかった理由（建物に比べて広すぎた等）。作り直す・直すと消える */
  warning?: string;
}

/** 家具・設備の種類 */
export type FurnitureKind =
  | 'kitchen'
  | 'dining'
  | 'sofa'
  | 'coffeeTable'
  | 'tv'
  | 'rug'
  | 'plant'
  | 'chair'
  | 'bed'
  | 'nightstand'
  | 'desk'
  | 'cabinet'
  | 'bookshelf'
  | 'lowTable'
  | 'bath'
  | 'mirror'
  | 'washstand'
  | 'washer'
  | 'toilet'
  | 'shoeCabinet'
  | 'fridge'
  | 'cupboard'
  /** ハンガーパイプ（WIC・ファミリークローゼットの壁沿い） */
  | 'hanger'
  /** 造作家具（本棚・カウンター・テレビボードなど。形は variant） */
  | 'builtin';

/** 造作家具の形 */
export type BuiltinVariant = 'wallShelf' | 'shelfDesk' | 'floatTv' | 'openShelf' | 'bench' | 'counter' | 'tallStorage' | 'lowShelf';

/** 家具の木の色味（3D で選んだ物の「素材」。標準はテイストの色） */
export type WoodTone = 'natural' | 'light' | 'dark';
export const WOOD_TONES: [WoodTone, string][] = [
  ['natural', '標準（テイストの色）'],
  ['light', '明るい（ナラ・メープル）'],
  ['dark', '濃い（ウォールナット）'],
];
/** 張地の色（ソファ・椅子・ベッド）。[値, 名前, 布 1 の色, 布 2 の色] */
export type FabricColor = 'preset' | 'gray' | 'beige' | 'navy' | 'green' | 'terracotta' | 'white';
export const FABRIC_COLORS: [FabricColor, string, string, string][] = [
  ['preset', '標準（テイストの色）', '', ''],
  ['gray', 'グレー', '#8f949a', '#6c7076'],
  ['beige', 'ベージュ', '#d9cdb8', '#b9ad98'],
  ['navy', 'ネイビー', '#3f4b63', '#2e3749'],
  ['green', 'グリーン', '#6f7d66', '#55614e'],
  ['terracotta', 'テラコッタ', '#b3684a', '#94523a'],
  ['white', 'オフホワイト', '#ece9e2', '#cfcac0'],
];

/** 置いた家具 1 つ（平面座標 mm。rot は壁に沿う向きの角度（度）: 0 = 東向きに並び手前が南） */
export interface FurnitureItem {
  id: string;
  kind: FurnitureKind;
  x: number;
  y: number;
  rot: number;
  /** 幅 (m)（ソファ・ベッド・ラグ・テレビ台など） */
  w?: number;
  /** 奥行 (m)（ラグ）。キッチンでは背面の壁からアイランド中心までの距離 */
  d?: number;
  /** 長さ (m)（キッチン・浴槽） */
  len?: number;
  roomId?: string;
  /** キッチンの型: 対面ペニンシュラ（既定）／アイランド／壁付け I 型／Ⅱ型（壁にコンロ、対面にシンク）／L 型（壁にシンク、袖にコンロ） */
  kitchenType?: 'peninsula' | 'island' | 'wall' | 'two' | 'l';
  /** 造作家具の形（kind が builtin のとき） */
  variant?: BuiltinVariant;
  /** 高さ (m)（造作家具。省略時は形ごとの既定・天井まで） */
  h?: number;
  /** コンロの位置（部屋側からキッチンを見て左／右。既定: 右） */
  stoveSide?: 'left' | 'right';
  /** 冷蔵庫の位置（背面収納の端。既定: 右） */
  fridge?: 'left' | 'right' | 'none';
  /** レンジフード（既定: あり） */
  hood?: boolean;
  /** 形: I 型（既定）か L 型（ソファのカウチ、カップボードの袖） */
  shape?: 'i' | 'l';
  /** L 型の袖が付く側（部屋側から見て。既定: 右） */
  legSide?: 'left' | 'right';
  /** L 型の袖の長さ (m)（ソファ: カウチの奥行 1.6、カップボード: 袖の長さ 1.8） */
  leg?: number;
  /** 洗面台の作り: ユニット（既定）か造作（カウンター＋ボウル＋オープン棚＋大きな鏡） */
  washStyle?: 'unit' | 'custom';
  /** 木の色味（省略 = テイストの色） */
  woodTone?: WoodTone;
  /** 張地の色（省略 = テイストの色） */
  fabricColor?: FabricColor;
}

/** 木造のモジュール（壁芯を合わせる基準の格子） */
export interface ModuleInfo {
  /** 910 = 尺モジュール（半間 455 格子）, 1000 = メーターモジュール（500 格子） */
  size: 910 | 1000;
  /** 壁芯を合わせる格子の間隔 (mm) */
  grid: number;
  /** 格子の位相（図面座標 mm。x = phaseX + n·grid の線に壁芯が乗る） */
  phaseX: number;
  phaseY: number;
  /** 適合度 0..1（格子に乗っている壁の長さの割合） */
  fit: number;
  /** 壁芯・部屋・外形を格子へ寄せたか */
  snapped: boolean;
  source: 'auto' | 'manual';
}

/** 外構に置く物の種類 */
export type ExteriorKind = 'tree' | 'shrub' | 'car' | 'fence' | 'bbq' | 'bench' | 'bicycle' | 'shed' | 'post' | 'planter' | 'light';

/** 外構に手で置いた物 1 つ（平面座標 mm。rot は向き（度）: 0 = 東向き。フェンスは (x, y) から rot の向きへ len m） */
export interface ExteriorItem {
  id: string;
  kind: ExteriorKind;
  x: number;
  y: number;
  rot: number;
  /** 高さ (m)（木・フェンス・物置） */
  h?: number;
  /** 長さ (m)（フェンス）／幅 (m)（物置・ベンチ） */
  len?: number;
}

/** 屋根の掛け方 */
export type RoofKind = 'gable' | 'hip' | 'shed' | 'flat';
export const ROOF_KIND_LABEL: Record<RoofKind, string> = { gable: '切妻', hip: '寄棟', shed: '片流れ', flat: '陸屋根' };
/** 片流れの高い側（図面の上 n・下 s・右 e・左 w） */
export type RoofHigh = 'n' | 's' | 'e' | 'w';
/**
 * 屋根の塊（上の階が載らない範囲のつながった所）ごとの手直し。at はその塊の中の点（図面座標 mm）。
 * 省略した項目は全体の設定（パースの「細かく調整」とテイスト）のまま
 */
export interface RoofPatch {
  id: string;
  level: number;
  at: Vec2;
  kind?: RoofKind;
  /** 片流れの高い側 */
  high?: RoofHigh;
  /** 切妻・寄棟の棟の向き（x = 図面の横に棟、z = 縦に棟）。省略 = 長い辺に沿う */
  ridge?: 'x' | 'z';
  /** 勾配（寸） */
  pitch?: number;
  /** 軒の出 (mm) */
  eaves?: number;
  /** 辺ごとの軒の出 (mm)。屋根を片側だけ伸ばす（北・東・南・西は図面の上・右・下・左）。無い辺は eaves */
  eavesBy?: Partial<Record<RoofHigh, number>>;
  /** 陸屋根のパラペットの高さ (mm)。省略 550 */
  parapet?: number;
  /**
   * 手で足した屋根: 外形から自動で分けた塊ではなく、この四角形（図面座標 mm）に掛ける（屋根の抜け・ポーチ・カーポート・物置など）。
   * at はその中心。kind を省くと緩い片流れ（全体が陸屋根なら陸屋根）
   */
  rect?: { minX: number; minY: number; maxX: number; maxY: number };
  /** 手で描いた屋根の範囲（多角形。図面座標 mm）。方眼の「屋根」の道具で点を打って描く。rect より優先 */
  loop?: Vec2[];
  /** true = この範囲には屋根を掛けない（自動の屋根から除く。余分な下屋を消すときに） */
  omit?: boolean;
  /** 足した屋根の軒の高さ（その階の床からの mm）。省略 = その階の壁の天端 */
  topMm?: number;
  /** 立面図の屋根の線から読んで入れた掛け方（手で直すと外れる。立面図を読み直すと入れ直す） */
  source?: 'elevation';
}

/**
 * 庇（壁に取り付く薄い屋根。窓・勝手口・掃き出し窓の上や、玄関ポーチの延長）。
 * 壁の始点からの位置 t0〜t1 (mm) に、床からの高さ bottomMm で、壁の外側へ depth (mm) 出す
 */
export interface Canopy {
  id: string;
  level: number;
  wallId: string;
  t0: number;
  t1: number;
  /** 床から庇の下端までの高さ (mm) */
  bottomMm: number;
  /** 壁の外面からの出 (mm) */
  depth: number;
  /** 厚み (mm)。省略 120 */
  thickness?: number;
  /** 勾配（寸）。省略 0.5（先端がわずかに下がる） */
  pitch?: number;
}

export interface BuildingModel {
  name: string;
  floors: Floor[];
  /** 屋根の塊ごとの手直し（3D の「屋根」の道具で）。無い塊はおまかせ */
  roofPatches?: RoofPatch[];
  /** 手で足した庇（3D の「窓・戸」の道具で） */
  canopies?: Canopy[];
  /** 敷地の高低差（道路・隣地との差、擁壁・階段・道路レベルの駐車場）。無ければ平ら */
  siteLevels?: SiteLevels;
  /** 木造のモジュール（尺 910／メーター 1000）。読み取った壁芯を格子へ寄せた結果 */
  module?: ModuleInfo;
  /** 手で置き直した家具（階ごと）。無い階は自動配置 */
  furniture?: { level: number; items: FurnitureItem[] }[];
  /** 外構に手で置いた物（植栽・フェンス・車・BBQ など）。自動の外構に足して描く */
  exteriorItems?: ExteriorItem[];
  /** 真北の方向: 図面の上方向から時計回りの角度 (度) */
  northAngleDeg: number;
  /** 接道・敷地（読み取れた場合） */
  site?: SiteData;
  /** 高さの出どころ（立面図の寸法・設計の 3D データ）。無ければ標準値の推定 */
  heights?: { source: 'elevation' | '3d'; floor1?: number; storyHeights?: number[]; maxHeight?: number; maxEave?: number; roofPitch?: number };
  report: ParseReport;
}

export const ROOM_TYPE_LABEL: Record<RoomType, string> = {
  ldk: 'LDK',
  living: 'リビング',
  dining: 'ダイニング',
  kitchen: 'キッチン',
  japanese: '和室',
  bedroom: '寝室',
  kids: '子ども室',
  study: '書斎',
  bath: '浴室',
  washroom: '洗面室',
  toilet: 'トイレ',
  entrance: '玄関',
  hall: 'ホール',
  stairs: '階段',
  closet: 'クローゼット',
  storage: '収納',
  balcony: 'バルコニー',
  porch: 'ポーチ',
  garage: 'ガレージ',
  carport: 'カーポート',
  parking: '駐車場',
  deck: 'ウッドデッキ',
  terrace: 'テラス',
  shed: '物置',
  void: '吹抜',
  other: '居室',
};

/** 家の外の区画（バルコニー・ポーチ・中庭・ガレージ・外構）。延床面積に入らない */
export const OUTDOOR_TYPES: readonly RoomType[] = ['balcony', 'porch', 'garage', 'carport', 'parking', 'deck', 'terrace', 'shed'];
/** 外構（敷地の上に作るもの。屋根・壁は家と別） */
export const EXTERIOR_WORKS: readonly RoomType[] = ['carport', 'parking', 'deck', 'terrace', 'shed'];

/** 延床面積に入らない区画か（吹抜・バルコニー・ポーチ・ガレージ・外構） */
export function excludedFromFloorArea(t: RoomType): boolean {
  return t === 'void' || OUTDOOR_TYPES.includes(t);
}

/** 外構の区画か（カーポート・駐車場・デッキ・テラス・物置） */
export function isExteriorWorks(t: RoomType): boolean {
  return EXTERIOR_WORKS.includes(t);
}

/** 家とは別に建つガレージ（後付け・離れ）か */
export function isSeparateGarage(r: { type: RoomType; garageKind?: GarageKind }): boolean {
  return r.type === 'garage' && (r.garageKind === 'attached' || r.garageKind === 'detached');
}

/** 玄関の土間は家の床（FL）より下がる（上がり框の段差）。mm */
export const DOMA_DROP_MM = 180;
/** 土間の部屋（玄関、土間収納、「土間」の名の付く区画）。床は FL − 180 で、家の床との境に上がり框が付く */
/** 部屋の床の FL からの段差 (mm): 指定があればそれ、無ければ玄関・土間収納の土間は −180、ほかは 0 */
export function roomFloorOffsetMm(r: { type: RoomType; name?: string; floorOffset?: number } | null | undefined): number {
  if (!r) return 0;
  if (r.floorOffset != null && r.floorOffset !== 0) return r.floorOffset;
  return isDomaRoom(r) ? -DOMA_DROP_MM : 0;
}

export function isDomaRoom(r: { type: RoomType; name?: string } | null | undefined): boolean {
  if (!r) return false;
  if (r.type === 'entrance') return true;
  return (r.type === 'storage' || r.type === 'other' || r.type === 'hall') && /土間|ＳＩＣ|SIC|シューズクローク|シューズクローゼット/.test(r.name ?? '');
}

/** 居室（人が長く過ごす部屋）か */
export function isHabitable(t: RoomType): boolean {
  return ['ldk', 'living', 'dining', 'kitchen', 'japanese', 'bedroom', 'kids', 'study'].includes(t);
}
