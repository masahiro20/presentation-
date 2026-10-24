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

export type OpeningKind = 'window' | 'door' | 'sliding' | 'entrance' | 'open';

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
}

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
}

export interface Stair {
  id: string;
  /** 軸平行矩形 */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 'straight' = 直階段, 'u' = 折り返し階段, 'l' = かね折れ階段 */
  kind: 'straight' | 'u' | 'l';
  /** 折り返し・かね折れで曲がる向き（昇る人から見て）。省略時: 折り返しは左、かね折れは右 */
  turn?: 'left' | 'right';
  /** 昇り口のある辺（n = 図面の上側 = minY） */
  entry: 'n' | 's' | 'e' | 'w';
  /** 上階へ昇る階段か（上階側に記載された DN 階段は false） */
  goesUp: boolean;
  /** 図面に書かれた段数（「14段」など）。省略時は階高から推定 */
  steps?: number;
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
}

export interface ParseReport {
  pages: number;
  scaleDenominator: number | null;
  mmPerPt: number;
  scaleSource: 'dimension' | 'text' | 'area' | 'module' | 'default' | 'manual';
  wallThicknesses: number[];
  warnings: string[];
  timingsMs: Record<string, number>;
  /** 方位記号が読み取れたか（false = 図面の上を北とみなした） */
  northDetected?: boolean;
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
  /** 造作家具（本棚・カウンター・テレビボードなど。形は variant） */
  | 'builtin';

/** 造作家具の形 */
export type BuiltinVariant = 'wallShelf' | 'shelfDesk' | 'floatTv' | 'openShelf' | 'bench' | 'counter' | 'tallStorage' | 'lowShelf';

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

export interface BuildingModel {
  name: string;
  floors: Floor[];
  /** 木造のモジュール（尺 910／メーター 1000）。読み取った壁芯を格子へ寄せた結果 */
  module?: ModuleInfo;
  /** 手で置き直した家具（階ごと）。無い階は自動配置 */
  furniture?: { level: number; items: FurnitureItem[] }[];
  /** 真北の方向: 図面の上方向から時計回りの角度 (度) */
  northAngleDeg: number;
  /** 接道・敷地（読み取れた場合） */
  site?: SiteData;
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

/** 居室（人が長く過ごす部屋）か */
export function isHabitable(t: RoomType): boolean {
  return ['ldk', 'living', 'dining', 'kitchen', 'japanese', 'bedroom', 'kids', 'study'].includes(t);
}
