/**
 * 積算の「面」シートにあたる数量: 読み込んだ間取り（部屋・外形・開口）と屋根・軒の設定から自動で拾う。
 * 設計士が直せるように、すべての値は上書きできる（areasOverride）。
 */
import type { BuildingModel, Floor, RoomType, Vec2 } from '../core/types';
import { polygonArea } from '../core/geometry';
import type { Grade } from './catalog';

export interface Areas {
  grade: Grade;
  /** 各階の床面積 (㎡) */
  floor1: number;
  floor2: number;
  floor3: number;
  /** 延床面積 (㎡) = 1〜3階 */
  totalArea: number;
  /** 延床坪 */
  totalTsubo: number;
  /** 外部ポーチ・テラス面積 (㎡) */
  porchOut: number;
  /** 内部ポーチ・テラス面積 (㎡) */
  porchIn: number;
  /** 施工面積に加える分（ポーチ・庇など） (㎡) */
  extraArea: number;
  balconyArea: number;
  /** 吹抜 (㎡) */
  voidArea: number;
  /** ロフト（半分換算後） (㎡) */
  loftArea: number;
  /** 施工面積 (㎡) = 延床 + extra + バルコニー + ロフト + 吹抜 */
  constArea: number;
  constTsubo: number;
  /** 建築面積 (㎡) */
  buildArea: number;
  /** 外壁面積 (㎡) */
  extWall: number;
  /** 基礎外周 (m) */
  foundPerim: number;
  /** 軒天面積 (㎡) */
  soffitArea: number;
  /** 屋根面積 (㎡) */
  roofArea: number;
  /** 軒先（鼻隠し）長さ (m) */
  eaveLen: number;
  /** 棟長さ (m) */
  ridgeLen: number;
  /** 建物角（1〜3階の合計） */
  corners: number;
  /** 断熱面積（室内天井＆外部床） (㎡) */
  insulArea: number;
  /** 高天井（H2500からの差） (㎥) */
  highCeil: number;
  /** 勾配天井 (㎡) */
  slopeCeil: number;
  /** 敷地外周 (m) */
  siteEdge: number;
  /** 建具個数（室内ドア・引戸） */
  doors: number;
  /** フローリング面積 (㎡) */
  flooringArea: number;
  /** フロアタイル面積（洗面・トイレ） (㎡) */
  floorTileArea: number;
  /** トイレ数 */
  toilets: number;
  /** 階段数 */
  stairs: number;
  /** 竪樋本数 */
  downspouts1: number;
  downspouts2: number;
  /** 畳 */
  tatami1: number;
  tatamiHalf: number;
  /** 延床 30 坪に対する倍率（電気の箇所数など） */
  scale: number;
  /** 換気扇ダクト・パイプファン（グレードで既定が違う） */
  fanDucts: number;
  pipeFans: number;
  /** 2階の水回り: 無し／あり／2階リビング */
  wet2f: 'none' | 'some' | 'ldk';
  /** 給湯: エコキュート（電気）か ガス */
  waterHeater: 'ecocute' | 'gas';
  /** SOLIDO 面積・角数（アクセント外壁） */
  solidoArea: number;
  solidoCorners: number;
  /** 深基礎 (m) */
  deepFound100: number;
  deepFound200: number;
  deepFound300: number;
  deepFound400: number;
  /** 任意のもの */
  fireZone: boolean;
  evoltz: boolean;
  soffitWood: boolean;
  addInsul: boolean;
  pocketKey: boolean;
  solidFloor: boolean;
  doorPaint: boolean;
  balconyTile: boolean;
  handwash: boolean;
  kanta: boolean;
  slopSink: boolean;
  septic: boolean;
  structCalc: boolean;
  evOutlet: boolean;
  soundArea: number;
  innerTileArea: number;
  innerSolidoArea: number;
  paintWallArea: number;
  woodCeilArea: number;
  handrailLen: number;
  doorCloth: number;
  soStyle: number;
  travelKm: number;
}

/** 画面で編集できる項目の説明（順番どおりに並べる） */
export const AREA_FIELDS: { key: keyof Areas; label: string; unit: string; group: string }[] = [
  { key: 'floor1', label: '1階床面積', unit: '㎡', group: '面積' },
  { key: 'floor2', label: '2階床面積', unit: '㎡', group: '面積' },
  { key: 'floor3', label: '3階床面積', unit: '㎡', group: '面積' },
  { key: 'porchOut', label: '外部ポーチ・テラス面積', unit: '㎡', group: '面積' },
  { key: 'porchIn', label: '内部ポーチ・テラス面積', unit: '㎡', group: '面積' },
  { key: 'extraArea', label: '施工面積（追加分）', unit: '㎡', group: '面積' },
  { key: 'balconyArea', label: 'バルコニー面積', unit: '㎡', group: '面積' },
  { key: 'voidArea', label: '吹き抜け', unit: '㎡', group: '面積' },
  { key: 'loftArea', label: 'ロフト ※半分換算', unit: '㎡', group: '面積' },
  { key: 'buildArea', label: '建築面積', unit: '㎡', group: '面積' },
  { key: 'extWall', label: '外壁面積', unit: '㎡', group: '外部' },
  { key: 'foundPerim', label: '基礎外周', unit: 'm', group: '外部' },
  { key: 'soffitArea', label: '軒天面積', unit: '㎡', group: '外部' },
  { key: 'roofArea', label: '屋根面積', unit: '㎡', group: '外部' },
  { key: 'eaveLen', label: '軒先（鼻隠し）', unit: 'm', group: '外部' },
  { key: 'ridgeLen', label: '棟長さ', unit: 'm', group: '外部' },
  { key: 'corners', label: '建物角 1階・2階・3階', unit: 'ヵ所', group: '外部' },
  { key: 'insulArea', label: '断熱面積 室内天井＆外部床', unit: '㎡', group: '外部' },
  { key: 'siteEdge', label: '敷地外周', unit: 'm', group: '外部' },
  { key: 'downspouts1', label: '竪樋 1階', unit: '本', group: '外部' },
  { key: 'downspouts2', label: '竪樋 2階', unit: '本', group: '外部' },
  { key: 'solidoArea', label: 'SOLIDO 面積', unit: '㎡', group: '外部' },
  { key: 'solidoCorners', label: 'SOLIDO 角数', unit: 'ヵ所', group: '外部' },
  { key: 'highCeil', label: '高天井（H2500からの差）', unit: '㎥', group: '内部' },
  { key: 'slopeCeil', label: '勾配天井', unit: '㎡', group: '内部' },
  { key: 'doors', label: '建具個数', unit: '箇所', group: '内部' },
  { key: 'flooringArea', label: 'フローリング面積', unit: '㎡', group: '内部' },
  { key: 'floorTileArea', label: 'フロアタイル面積', unit: '㎡', group: '内部' },
  { key: 'toilets', label: 'トイレ数', unit: 'ヵ所', group: '内部' },
  { key: 'stairs', label: '階段数', unit: 'ヵ所', group: '内部' },
  { key: 'tatami1', label: '畳（1帖）', unit: '枚', group: '内部' },
  { key: 'tatamiHalf', label: '畳（半帖）', unit: '枚', group: '内部' },
  { key: 'fanDucts', label: '換気扇ダクト', unit: 'ヵ所', group: '設備' },
  { key: 'pipeFans', label: 'パイプファン', unit: 'ヵ所', group: '設備' },
  { key: 'deepFound100', label: '深基礎 H-100', unit: 'm', group: '任意' },
  { key: 'deepFound200', label: '深基礎 H-200', unit: 'm', group: '任意' },
  { key: 'deepFound300', label: '深基礎 H-300', unit: 'm', group: '任意' },
  { key: 'deepFound400', label: '深基礎 H-400', unit: 'm', group: '任意' },
  { key: 'soundArea', label: '室内防音材', unit: '㎡', group: '任意' },
  { key: 'innerTileArea', label: '室内タイル床', unit: '㎡', group: '任意' },
  { key: 'innerSolidoArea', label: '室内 SOLIDO 壁', unit: '㎡', group: '任意' },
  { key: 'paintWallArea', label: '室内塗り壁', unit: '㎡', group: '任意' },
  { key: 'woodCeilArea', label: '木板天井', unit: '㎡', group: '任意' },
  { key: 'handrailLen', label: 'St 手摺', unit: 'm', group: '任意' },
  { key: 'doorCloth', label: '建具クロス張り', unit: 'ヵ所', group: '任意' },
  { key: 'soStyle', label: 'So スタイル スイッチ', unit: 'ヵ所', group: '任意' },
  { key: 'travelKm', label: '交通費（15km 超）', unit: 'km', group: '任意' },
];

export const AREA_OPTIONS: { key: keyof Areas; label: string }[] = [
  { key: 'fireZone', label: '準防火地域' },
  { key: 'evoltz', label: '制振ダンパー evoltz' },
  { key: 'soffitWood', label: '木板軒天' },
  { key: 'addInsul', label: '外壁付加断熱（ネオマ）' },
  { key: 'pocketKey', label: '玄関ポケットキー' },
  { key: 'solidFloor', label: '無垢床の現場塗装' },
  { key: 'doorPaint', label: '建具塗装' },
  { key: 'balconyTile', label: 'バルコニータイル' },
  { key: 'handwash', label: 'トイレ手洗いカウンター' },
  { key: 'kanta', label: '幹太くん引き込み' },
  { key: 'slopSink', label: 'スロップシンク' },
  { key: 'septic', label: '浄化槽' },
  { key: 'structCalc', label: '許容応力度計算（別途）' },
  { key: 'evOutlet', label: 'EV コンセント' },
];

export interface TakeoffOptions {
  grade: Grade;
  /** 軒の出 (mm) */
  eavesMm: number;
  /** 屋根勾配（寸） */
  pitch: number;
  roofType: 'gable' | 'hip' | 'shed' | 'flat';
  /** アクセント外壁（SOLIDO）の範囲 */
  solido?: 'upper' | 'entrance' | 'lower' | 'none';
}

const T = 0.3025;
const r2 = (v: number) => Math.round(v * 100) / 100;

function perimeter(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return s;
}

function roomsArea(f: Floor, types: RoomType[]): number {
  return f.rooms.filter((r) => types.includes(r.type)).reduce((s, r) => s + r.area, 0);
}

function outlineArea(f: Floor): number {
  return f.outline.reduce((s, l) => s + Math.abs(polygonArea(l)) / 1e6, 0);
}

/** 間取りから数量を拾う */
export function takeoff(model: BuildingModel, opts: TakeoffOptions): Areas {
  const floors = model.floors.slice().sort((a, b) => a.level - b.level);
  const fl = (lv: number) => floors.find((f) => f.level === lv);
  const floorArea = (f?: Floor) => (f ? Math.max(0, outlineArea(f) - roomsArea(f, ['void', 'balcony'])) : 0);
  const floor1 = r2(floorArea(fl(1)));
  const floor2 = r2(floorArea(fl(2)));
  const floor3 = r2(floorArea(fl(3)));
  const totalArea = r2(floor1 + floor2 + floor3);
  const porch = r2(floors.reduce((s, f) => s + roomsArea(f, ['porch']), 0));
  const balconyArea = r2(floors.reduce((s, f) => s + roomsArea(f, ['balcony']), 0));
  const voidArea = r2(floors.filter((f) => f.level >= 2).reduce((s, f) => s + roomsArea(f, ['void']), 0));
  const extraArea = porch;
  const loftArea = 0;
  const constArea = r2(totalArea + extraArea + balconyArea + loftArea + voidArea);
  const buildArea = r2(Math.max(floor1, floor2, floor3, floorArea(fl(1))));
  // 外壁面積: 各階の外周 × 階高（社内の拾い方に合わせ、開口は引かない）＋ 陸屋根・片流れのパラペット分
  let extWall = 0;
  let corners = 0;
  for (const f of floors) {
    const per = f.outline.reduce((s, l) => s + perimeter(l), 0) / 1000;
    extWall += per * (f.height / 1000);
    corners += f.outline.reduce((s, l) => s + l.length, 0);
  }
  const f1 = fl(1);
  const foundPerim = r2(f1 ? f1.outline.reduce((s, l) => s + perimeter(l), 0) / 1000 : 0);
  const top = floors[floors.length - 1];
  const topPerim = top ? top.outline.reduce((s, l) => s + perimeter(l), 0) / 1000 : 0;
  if (opts.roofType === 'flat' || opts.roofType === 'shed') extWall += topPerim * 0.6;
  extWall = r2(Math.max(0, extWall));
  const eaveOut = opts.roofType === 'flat' ? 0 : opts.eavesMm / 1000;
  // 屋根の平面: 下階のはみ出し分も屋根（下屋）になる
  let roofPlan = floorArea(top);
  for (let i = 0; i < floors.length - 1; i++) roofPlan += Math.max(0, floorArea(floors[i]) - floorArea(floors[i + 1]));
  const slope = opts.roofType === 'flat' ? 1 : Math.sqrt(1 + (opts.pitch / 10) ** 2);
  // 役物・重ね代の分として 5% 見込む
  const roofArea = r2((roofPlan + topPerim * eaveOut) * slope * 1.05);
  // 軒天: 軒の出の裏 ＋ 上階が下階より張り出す部分の裏（オーバーハング）
  const lowerRoofPerim = floors.length >= 2 ? Math.max(0, foundPerim - topPerim) : 0;
  const overhang = Math.max(0, floor2 - floor1) + Math.max(0, floor3 - floor2);
  const soffitArea = r2((topPerim + lowerRoofPerim) * eaveOut + overhang);
  // 軒先: 切妻・片流れは長手の辺、寄棟・陸屋根（パラペット）は外周
  const bb = top ? bboxOf(top.outline.flat()) : null;
  const longSide = bb ? Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) / 1000 : 0;
  const eaveLen = r2(opts.roofType === 'gable' ? longSide * 2 + 2 * eaveOut * 2 : opts.roofType === 'shed' ? longSide + 2 * eaveOut : topPerim + 8 * eaveOut);
  const ridgeLen = r2(opts.roofType === 'flat' ? 0 : longSide);
  const insulArea = r2(floorArea(top) + overhang);
  const siteEdge = r2(model.site?.polygon?.length ? perimeter(model.site.polygon) / 1000 : Math.max(40, 4 * Math.sqrt(buildArea * 2.4)));
  const doors = floors.reduce((s, f) => s + f.openings.filter((o) => (o.kind === 'door' || o.kind === 'sliding') && !f.walls.find((w) => w.id === o.wallId)?.exterior).length, 0);
  const flooringArea = r2(floors.reduce((s, f) => s + roomsArea(f, ['ldk', 'living', 'dining', 'kitchen', 'bedroom', 'kids', 'study', 'hall', 'closet', 'storage', 'other']), 0));
  const floorTileArea = r2(floors.reduce((s, f) => s + roomsArea(f, ['washroom']), 0));
  const toilets = Math.max(1, floors.reduce((s, f) => s + f.rooms.filter((r) => r.type === 'toilet').length, 0));
  const stairs = Math.max(0, floors.length - 1);
  const tatami = floors.reduce((s, f) => s + roomsArea(f, ['japanese']), 0) / 1.62;
  const totalTsubo = Math.floor(totalArea * T * 100) / 100;
  const constTsubo = Math.floor(constArea * T * 100) / 100;
  const f2 = fl(2);
  const wet2f: Areas['wet2f'] = f2?.rooms.some((r) => r.type === 'ldk' || r.type === 'kitchen') ? 'ldk' : f2?.rooms.some((r) => ['toilet', 'washroom', 'bath'].includes(r.type)) ? 'some' : 'none';
  // SOLIDO アクセント: 上階なら 2 階の外壁、玄関まわりなら 15 ㎡ ほど
  const solido = opts.solido ?? 'none';
  const upperWall = f2 ? (f2.outline.reduce((s, l) => s + perimeter(l), 0) / 1000) * (f2.height / 1000) * 0.85 : 0;
  const solidoArea = r2(solido === 'upper' ? upperWall : solido === 'lower' ? extWall - upperWall : solido === 'entrance' ? 15 : 0);
  const solidoCorners = solido === 'upper' ? (f2?.outline.reduce((s, l) => s + l.length, 0) ?? 0) : solido === 'lower' ? (f1?.outline.reduce((s, l) => s + l.length, 0) ?? 0) : solido === 'entrance' ? 2 : 0;
  return {
    grade: opts.grade,
    floor1,
    floor2,
    floor3,
    totalArea,
    totalTsubo,
    porchOut: porch,
    porchIn: porch,
    extraArea,
    balconyArea,
    voidArea,
    loftArea,
    constArea,
    constTsubo,
    buildArea,
    extWall,
    foundPerim,
    soffitArea,
    roofArea,
    eaveLen,
    ridgeLen,
    corners,
    insulArea,
    highCeil: 0,
    slopeCeil: 0,
    siteEdge,
    doors,
    flooringArea,
    floorTileArea,
    toilets,
    stairs,
    downspouts1: floors.length >= 2 ? 3 : 4,
    downspouts2: floors.length >= 2 ? 3 : 0,
    tatami1: Math.round(tatami),
    tatamiHalf: 0,
    scale: totalTsubo / 30,
    fanDucts: opts.grade === 'P' ? 3 : 6,
    pipeFans: opts.grade === 'P' ? 3 : 5,
    wet2f,
    waterHeater: 'ecocute',
    solidoArea,
    solidoCorners,
    deepFound100: 0,
    deepFound200: 0,
    deepFound300: 0,
    deepFound400: 0,
    fireZone: false,
    evoltz: false,
    soffitWood: false,
    addInsul: false,
    pocketKey: false,
    solidFloor: false,
    doorPaint: false,
    balconyTile: false,
    handwash: false,
    kanta: false,
    slopSink: false,
    septic: false,
    structCalc: false,
    evOutlet: false,
    soundArea: 0,
    innerTileArea: 0,
    innerSolidoArea: 0,
    paintWallArea: 0,
    woodCeilArea: 0,
    handrailLen: 0,
    doorCloth: 0,
    soStyle: 0,
    travelKm: 0,
  };
}

function bboxOf(pts: Vec2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** 上書きを当てて、派生する値（延床・施工面積・坪・倍率）を計算し直す */
export function applyOverrides(base: Areas, ov: Partial<Areas>): Areas {
  const a: Areas = { ...base, ...ov };
  a.totalArea = r2(a.floor1 + a.floor2 + a.floor3);
  a.totalTsubo = Math.floor(a.totalArea * T * 100) / 100;
  a.constArea = r2(a.totalArea + a.extraArea + a.balconyArea + a.loftArea + a.voidArea);
  a.constTsubo = Math.floor(a.constArea * T * 100) / 100;
  a.scale = a.totalTsubo / 30;
  return a;
}
