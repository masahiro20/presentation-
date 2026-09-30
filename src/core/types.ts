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
  | 'void'
  | 'other';

export type OpeningKind = 'window' | 'door' | 'sliding' | 'entrance' | 'open';

/** 窓の種類（高さ・腰高の決定に使う） */
export type WindowStyle = 'hakidashi' | 'koshi' | 'small' | 'high' | 'none';

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
}

export interface Stair {
  id: string;
  /** 軸平行矩形 */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 'straight' = 直階段, 'u' = 折り返し階段 */
  kind: 'straight' | 'u';
  /** 昇り口のある辺 */
  entry: 'n' | 's' | 'e' | 'w';
  /** 上階へ昇る階段か（上階側に記載された DN 階段は false） */
  goesUp: boolean;
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
}

export interface ParseReport {
  pages: number;
  scaleDenominator: number | null;
  mmPerPt: number;
  scaleSource: 'dimension' | 'text' | 'area' | 'default' | 'manual';
  wallThicknesses: number[];
  warnings: string[];
  timingsMs: Record<string, number>;
}

/** 図面上の辺（図面の上 = top） */
export type PlanSide = 'top' | 'right' | 'bottom' | 'left';

export interface RoadInfo {
  side: PlanSide;
  /** 道路幅員 (mm) */
  widthMm?: number;
  /** 読み取った文字 */
  label?: string;
  /** どこから決めたか */
  source: 'text' | 'compass' | 'manual';
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

export interface BuildingModel {
  name: string;
  floors: Floor[];
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
  void: '吹抜',
  other: '居室',
};

/** 居室（人が長く過ごす部屋）か */
export function isHabitable(t: RoomType): boolean {
  return ['ldk', 'living', 'dining', 'kitchen', 'japanese', 'bedroom', 'kids', 'study'].includes(t);
}
