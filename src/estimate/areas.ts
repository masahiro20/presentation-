/**
 * 積算の「面」シートにあたる数量: 読み込んだ間取り（部屋・外形・開口）と屋根・軒の設定から自動で拾う。
 * 設計士が直せるように、すべての値は上書きできる（areasOverride）。
 */
import { excludedFromFloorArea, isSeparateGarage, type BuildingModel, type Floor, type Room, type RoomType, type Vec2 } from '../core/types';
import { pointInPolygon, polygonArea } from '../core/geometry';
import { isOpenSkyBalcony } from '../core/balcony';
import { isStairwellVoid } from '../core/floorArea';
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
  /** 施工面積に加える分（ポーチ・庇・ビルトインガレージなど） (㎡) */
  extraArea: number;
  /** ビルトインガレージの面積 (㎡)。床面積には入れず施工面積に入れる。土間は外部ポーチと同じ扱い。断熱は入れない */
  garageArea: number;
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
  /** 断熱面積（室内天井＆外部床） (㎡) = 屋根の下の天井（ガレージの上を除く）＋ 外気に接する床（オーバーハングした 2 階の床） */
  insulArea: number;
  /** 壁の断熱面積 (㎡) = 外壁面積 − ガレージの外壁（ガレージには断熱を入れない） */
  insulWall: number;
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
  /** ホームエレベーター（図面に EV の区画があれば自動で入る） */
  elevator: boolean;
  soundArea: number;
  innerTileArea: number;
  innerSolidoArea: number;
  paintWallArea: number;
  woodCeilArea: number;
  handrailLen: number;
  doorCloth: number;
  soStyle: number;
  travelKm: number;
  /** 図面から読んだキッチンの形（見積のキッチンの既定に使う） */
  kitchenType?: 'peninsula' | 'island' | 'wall' | 'two' | 'l';
}

/** 画面で編集できる項目の説明（順番どおりに並べる） */
export const AREA_FIELDS: { key: keyof Areas; label: string; unit: string; group: string }[] = [
  { key: 'floor1', label: '1階床面積', unit: '㎡', group: '面積' },
  { key: 'floor2', label: '2階床面積', unit: '㎡', group: '面積' },
  { key: 'floor3', label: '3階床面積', unit: '㎡', group: '面積' },
  { key: 'porchOut', label: '外部ポーチ・テラス面積', unit: '㎡', group: '面積' },
  { key: 'porchIn', label: '内部ポーチ・テラス面積', unit: '㎡', group: '面積' },
  { key: 'extraArea', label: '施工面積（追加分）', unit: '㎡', group: '面積' },
  { key: 'garageArea', label: 'ビルトインガレージ ※施工面積に', unit: '㎡', group: '面積' },
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
  { key: 'insulWall', label: '断熱面積 壁 ※ガレージを除く', unit: '㎡', group: '外部' },
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
  { key: 'elevator', label: 'ホームエレベーター' },
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
/** 1 階の外壁に足す基礎の立ち上がり（GL+500）(m) */
export const FOUND_H = 0.5;
/** 陸屋根・片流れの箱のパラペットの高さ (m) */
export const PARAPET_H = 0.9;

export function perimeter(poly: Vec2[]): number {
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

export function outlineArea(f: Floor): number {
  return f.outline.reduce((s, l) => s + Math.abs(polygonArea(l)) / 1e6, 0);
}

/** 点が階の外形の内側か（外形の輪が複数・中庭の穴があっても偶奇で判定） */
export function inFloor(f: Floor, x: number, y: number): boolean {
  let inside = false;
  for (const l of f.outline) {
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
      const a = l[i];
      const b = l[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

export function centroid(poly: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

/**
 * 各階の外形を 50mm 格子で重ね合わせて面積を数える（㎡）。
 *  union: どれかの階の外形に入る（建築面積）
 *  openSky: そのうち、いちばん上に来る階が「空に開いたバルコニー」（ルーフバルコニーなど。屋根を掛けない。core/balcony.ts）の所
 *  exposedBelow[i]: i 階の外形のうち、すぐ下の階の外形の外にある所（ピロティ・オーバーハング・張り出しの床下）
 */
export function overlay(floors: Floor[], step = 50) {
  const loops = floors.flatMap((f) => f.outline);
  const xs = loops.flat().map((p) => p.x);
  const ys = loops.flat().map((p) => p.y);
  const exposedBelow = floors.map(() => 0);
  let union = 0;
  let openSky = 0;
  if (!xs.length) return { union, openSky, exposedBelow };
  const open = floors.map((f, k) => f.rooms.filter((r) => isOpenSkyBalcony(floors, k, r)).map((r) => r.polygon));
  const hasOpen = open.some((o) => o.length > 0);
  const cell = (step * step) / 1e6;
  for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) {
    for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) {
      const ins = floors.map((f) => inFloor(f, x, y));
      if (ins.some(Boolean)) {
        union += cell;
        if (hasOpen) {
          const ti = ins.lastIndexOf(true);
          if (open[ti].some((poly) => pointInPolygon({ x, y }, poly))) openSky += cell;
        }
      }
      for (let i = 1; i < floors.length; i++) if (ins[i] && !ins[i - 1]) exposedBelow[i] += cell;
    }
  }
  return { union, openSky, exposedBelow };
}

/** i 階の外周のうち、上の階の外形の下に入っていない長さ（m）: 下屋の屋根の縁（パラペット・軒先になる） */
export function uncoveredEdge(f: Floor, upper: Floor | undefined, step = 100): number {
  return uncoveredRuns(f, upper, step).reduce((s, r) => s + r.len, 0) / 1000;
}

/** 下屋の縁の区間: i 階の外形の辺のうち、上の階の外形の下に入っていない部分（辺ごとに区切る。根拠の図に描く） */
export function uncoveredRuns(f: Floor, upper: Floor | undefined, step = 100): { a: Vec2; b: Vec2; len: number }[] {
  const out: { a: Vec2; b: Vec2; len: number }[] = [];
  for (const l of f.outline) {
    for (let i = 0; i < l.length; i++) {
      const a = l[i];
      const b = l[(i + 1) % l.length];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 1) continue;
      const n = Math.max(1, Math.round(L / step));
      let run: number | null = null;
      for (let k = 0; k <= n; k++) {
        const open = k < n && (() => {
          const t = (k + 0.5) / n;
          const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          return !upper || !inFloor(upper, p.x, p.y);
        })();
        if (open && run == null) run = k;
        if (!open && run != null) {
          const t0 = run / n;
          const t1 = k / n;
          out.push({ a: { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 }, b: { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 }, len: (L * (k - run)) / n });
          run = null;
        }
      }
    }
  }
  return out;
}

/** 家の中に組み込まれたガレージ（床は土間。床面積に入れず施工面積に、断熱は入れない） */
export function isBuiltinGarage(r: Room): boolean {
  return r.type === 'garage' && !isSeparateGarage(r) && r.polygon.length >= 3;
}

/** 多角形のうち、上の階の外形に覆われていない面積 (㎡)（50mm 格子）: ガレージの上が屋根（天井の断熱の対象外）かどうか */
export function uncoveredArea(poly: Vec2[], uppers: Floor[], step = 50): number {
  if (poly.length < 3) return 0;
  const bb = bboxOf(poly);
  const cell = (step * step) / 1e6;
  let area = 0;
  for (let x = bb.minX + step / 2; x < bb.maxX; x += step)
    for (let y = bb.minY + step / 2; y < bb.maxY; y += step) {
      if (!inPoly(poly, x, y)) continue;
      if (!uppers.some((u) => inFloor(u, x, y))) area += cell;
    }
  return area;
}

function inPoly(poly: Vec2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** 多角形の辺のうち外壁になっている長さ (m)（辺の中点を外へ 150 ずらした点が階の外形の外） */
export function exteriorEdgeLen(f: Floor, poly: Vec2[], step = 100): number {
  return exteriorRuns(f, poly, step).reduce((s, r) => s + r.len, 0) / 1000;
}

/**
 * 多角形の辺のうち外壁になっている区間（根拠の図に描く）。outward は外側（階の外形の外）へ向く単位法線
 */
export function exteriorRuns(f: Floor, poly: Vec2[], step = 100): { a: Vec2; b: Vec2; len: number; outward: Vec2 }[] {
  const out: { a: Vec2; b: Vec2; len: number; outward: Vec2 }[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 1) continue;
    const nx = -(b.y - a.y) / L;
    const ny = (b.x - a.x) / L;
    const n = Math.max(1, Math.round(L / step));
    let run: number | null = null;
    let sign = 1;
    const flush = (k: number) => {
      if (run == null) return;
      const t0 = run / n;
      const t1 = k / n;
      out.push({ a: { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 }, b: { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 }, len: (L * (k - run)) / n, outward: { x: nx * sign, y: ny * sign } });
      run = null;
    };
    for (let k = 0; k <= n; k++) {
      let ext = false;
      let s = 1;
      if (k < n) {
        const t = (k + 0.5) / n;
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const outA = !inFloor(f, p.x + nx * 150, p.y + ny * 150);
        const outB = !inFloor(f, p.x - nx * 150, p.y - ny * 150);
        ext = outA !== outB;
        s = outA ? 1 : -1;
      }
      if (ext && run != null && s !== sign) flush(k);
      if (ext && run == null) {
        run = k;
        sign = s;
      }
      if (!ext) flush(k);
    }
  }
  return out;
}

/** 外形の出隅（外側に尖った角）の数 */
export function convexCorners(f: Floor): number {
  let n = 0;
  for (const l of f.outline) {
    const sgn = Math.sign(polygonArea(l)) || 1;
    for (let i = 0; i < l.length; i++) {
      const a = l[(i - 1 + l.length) % l.length];
      const b = l[i];
      const c = l[(i + 1) % l.length];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1e3) continue;
      if (Math.sign(cross) === sgn) n++;
    }
  }
  return n;
}

/** 間取りから数量を拾う */
export function takeoff(model: BuildingModel, opts: TakeoffOptions): Areas {
  const floors = model.floors.slice().sort((a, b) => a.level - b.level);
  const fl = (lv: number) => floors.find((f) => f.level === lv);
  // 床面積 = 外形 − 外形の内側にある吹抜・バルコニー（中庭のように外形の外にある区画は引かない。
  // 以前は外形の外の中庭まで引いていて、堀様邸の 1 階が 81.59 → 65.00㎡ と 2 割少なく出ていた）
  // ビルトインガレージ（外形の内側）: 床面積には入れない。施工面積に入れ、土間は外部ポーチと同じ扱い、断熱は入れない（御社の拾い方）
  const garageRooms = (f: Floor) => f.rooms.filter((r) => isBuiltinGarage(r) && inFloor(f, centroid(r.polygon).x, centroid(r.polygon).y));
  const garageArea = r2(floors.reduce((s, f) => s + garageRooms(f).reduce((t, r) => t + r.area, 0), 0));
  // 階段室の吹抜（下の階の階段の真上の小さな吹抜）は図面の面積表と同じく床に数える（有元様邸 3 階: 65.33 ㎡ に階段の上 8.28 ㎡ を含む）
  const isStairwell = (f: Floor, r: Room) => isStairwellVoid(r, fl(f.level - 1));
  const floorArea = (f?: Floor) => {
    if (!f) return 0;
    const inner = f.rooms.filter((r) => (r.type === 'void' || r.type === 'balcony') && r.polygon.length >= 3 && inFloor(f, centroid(r.polygon).x, centroid(r.polygon).y) && !isStairwell(f, r));
    return Math.max(0, outlineArea(f) - inner.reduce((s, r) => s + r.area, 0) - garageRooms(f).reduce((s, r) => s + r.area, 0));
  };
  const floor1 = r2(floorArea(fl(1)));
  const floor2 = r2(floorArea(fl(2)));
  const floor3 = r2(floorArea(fl(3)));
  const totalArea = r2(floor1 + floor2 + floor3);
  const porchRooms = floors.reduce((s, f) => s + roomsArea(f, ['porch']), 0);
  // バルコニーは 2 階以上の屋外の床だけ（1 階の中庭・テラスはバルコニーではない。堀様邸で中庭 16.56㎡ が防水・施工面積に入っていた）
  const isCourt = (name: string) => /中庭|坪庭|パティオ|ライトコート|テラス|ドッグラン/.test(name);
  const balconyArea = r2(floors.filter((f) => f.level >= 2).reduce((s, f) => s + f.rooms.filter((r) => r.type === 'balcony' && !isCourt(r.name)).reduce((t, r) => t + r.area, 0), 0));
  // 吹抜（内部足場・施工面積）: 階段室の吹抜は入れない（御社の積算でも 0）
  const voidArea = r2(floors.filter((f) => f.level >= 2).reduce((s, f) => s + f.rooms.filter((r) => r.type === 'void' && !isStairwell(f, r)).reduce((t, r) => t + r.area, 0), 0));
  // 各階の外形の重ね合わせ: 建築面積・屋根・ピロティ（上の階の下の屋外）
  const ov = overlay(floors);
  const pilotis = ov.exposedBelow[1] ?? 0; // 2 階の下の屋外（ポーチ・ビルトインガレージ・張り出し）
  const exposedFloors = ov.exposedBelow.reduce((s, v) => s + v, 0); // 外気に接する床（2 階以上の張り出しの床下）
  // 施工面積の追加分: ポーチの区画＋上の階の下に入る屋外（有元様邸: 1 階の外の 2 階の下 34.6㎡ ≒ 社内の 34.09㎡）＋ビルトインガレージ
  const extraArea = r2(porchRooms + pilotis + garageArea);
  const loftArea = 0;
  const constArea = r2(totalArea + extraArea + balconyArea + loftArea + voidArea);
  // 建築面積: 各階の外形を真上から重ねた面積（2 階の張り出しも入る）
  const buildArea = r2(Math.max(ov.union, floor1));
  // 外壁面積（社内の拾い方: 開口は引かない）: 各階の外周 × 階高。1 階は基礎の立ち上がり（GL+500）から。
  // 陸屋根・片流れの箱はパラペット（約 900）を、最上階の外周と下屋の縁（上の階が載っていない外周）に回す
  let extWall = 0;
  let corners = 0;
  for (const f of floors) {
    const per = f.outline.reduce((s, l) => s + perimeter(l), 0) / 1000;
    extWall += per * (f.height / 1000 + (f.level === 1 ? FOUND_H : 0));
    corners += convexCorners(f);
  }
  const f1 = fl(1);
  const foundPerim = r2(f1 ? f1.outline.reduce((s, l) => s + perimeter(l), 0) / 1000 : 0);
  const top = floors[floors.length - 1];
  const topPerim = top ? top.outline.reduce((s, l) => s + perimeter(l), 0) / 1000 : 0;
  // 下屋の縁（i 階の外周のうち i+1 階が載っていない長さ）
  let lowerEdges = 0;
  for (let i = 0; i < floors.length - 1; i++) lowerEdges += uncoveredEdge(floors[i], floors[i + 1]);
  const box = opts.roofType === 'flat' || opts.roofType === 'shed';
  // パラペットは最上階の外周だけ（下屋の縁は鼻隠しで、立ち上がりは無い。吉田大仁様邸: 外壁 393 → 342 ㎡ で御社の 344 に一致）
  if (box) extWall += topPerim * PARAPET_H;
  else if (opts.roofType === 'gable' && top) {
    // 切妻の妻壁（三角形 2 面）: 底辺 = 短辺、高さ = 短辺の半分 × 勾配。三角 1 面 = 短辺 × 高さ ÷ 2 を 2 面
    // （以前は 1 面分しか足していなかった。妻側の立面を見れば三角は両端に 1 つずつある）
    extWall += 2 * gableTriangleArea(top, opts.pitch);
  }
  extWall = r2(Math.max(0, extWall));
  const eaveOut = opts.roofType === 'flat' ? 0 : opts.eavesMm / 1000;
  // 屋根の平面: 各階の外形を真上から重ねた面積（吹抜の上にも屋根はある。下屋も入る）から、空に開いたバルコニー（ルーフバルコニーなど。
  // 屋根を掛けず、防水のバルコニーとして拾う）を除く
  const roofPlan = Math.max(0, ov.union - ov.openSky);
  const slope = opts.roofType === 'flat' ? 1 : Math.sqrt(1 + (opts.pitch / 10) ** 2);
  const roofArea = r2((roofPlan + (topPerim + lowerEdges) * eaveOut) * slope);
  const overhang = exposedFloors;
  // 軒先: 切妻・片流れは長手の辺、寄棟・陸屋根（パラペット）は外周
  const bb = top ? bboxOf(top.outline.flat()) : null;
  const longSide = bb ? Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) / 1000 : 0;
  const shortSide = bb ? Math.min(bb.maxX - bb.minX, bb.maxY - bb.minY) / 1000 : 0;
  // 片流れ: 御社の低勾配の箱は長手方向に流し、軒先（軒樋）は短辺側の 1 辺（堀様邸・有元様邸とも 6.5m）。
  // 上の階がほとんど載らない下屋の塊（ガレージ・平屋部分）は別の屋根なので、その短辺にも軒樋が付く（吉田大仁様邸: 2 階 5.0 ＋ 母屋 9.55 ＋ ガレージ 6.37 ≒ 御社 26.4 のうち 21）
  let lowerShort = 0;
  for (let i = 0; i < floors.length - 1; i++)
    for (const loop of floors[i].outline) {
      if (loop.length < 3) continue;
      const area = Math.abs(polygonArea(loop)) / 1e6;
      if (area < 6 || uncoveredArea(loop, floors.slice(i + 1)) < area * 0.5) continue;
      const lb = bboxOf(loop);
      lowerShort += Math.min(lb.maxX - lb.minX, lb.maxY - lb.minY) / 1000;
    }
  const eaveLen = r2(opts.roofType === 'gable' ? longSide * 2 + 2 * eaveOut * 2 : opts.roofType === 'shed' ? shortSide + 2 * eaveOut + lowerShort : topPerim + 8 * eaveOut);
  // 換気棟: 片流れの箱は御社の見積で毎回 10m（堀様邸・有元様邸・積算シートの既定）。切妻・寄棟は長手
  const ridgeLen = r2(opts.roofType === 'flat' ? 0 : opts.roofType === 'shed' ? 10 : longSide);
  // 断熱（室内天井＆外部床）: 屋根の下の天井（重ね合わせた外形 ≒ 屋根面積の平面）＋ 外気に接する床（オーバーハングした 2 階の床下）。
  // ガレージには断熱を入れないので、ガレージの上が屋根の所（上の階が載っていない所）は天井の断熱から引く
  let garageCeil = 0;
  let garageWall = 0;
  // 外形の中にある屋根付きの屋外（ポーチ・テラス）の天井は軒天であって断熱しない（吉田大仁様邸の積算: 室内天井 83.12 ＋ 外気床 4.55 で、19 ㎡ のテラスは入れない）
  let porchCeil = 0;
  for (let i = 0; i < floors.length; i++) {
    const f = floors[i];
    for (const g of garageRooms(f)) {
      garageCeil += uncoveredArea(g.polygon, floors.slice(i + 1));
      garageWall += exteriorEdgeLen(f, g.polygon) * (f.height / 1000 + (f.level === 1 ? FOUND_H : 0));
    }
    for (const p of f.rooms.filter((r) => r.type === 'porch' && r.polygon.length >= 3 && inFloor(f, centroid(r.polygon).x, centroid(r.polygon).y))) porchCeil += uncoveredArea(p.polygon, floors.slice(i + 1));
  }
  const insulArea = r2(Math.max(0, roofPlan - garageCeil - porchCeil + overhang));
  // 軒天: 軒の出の裏 ＋ 上階が下階より張り出す部分の裏（オーバーハング・ピロティ）＋ 屋根の下の屋外の天井（ビルトインガレージ・ポーチ。御社の積算は外部天井 PB として軒天に数える）
  const soffitArea = r2((topPerim + lowerEdges) * eaveOut + overhang + garageCeil + porchCeil);
  const insulWall = r2(Math.max(0, extWall - garageWall));
  const siteEdge = r2(model.site?.polygon?.length ? perimeter(model.site.polygon) / 1000 : Math.max(40, 4 * Math.sqrt(buildArea * 2.4)));
  const doors = floors.reduce((s, f) => s + interiorDoors(f).length, 0);
  // 床仕上げ: 挽板フローリングは居室・ホール・書斎。フロアタイルは洗面脱衣・トイレ・収納（土間の収納は除く）。
  // 設計士が 3D・方眼で床の仕上げを変えた部屋（畳コーナー・土間リビングなど）はそれに従う（floorCategory）
  const catArea = (cat: FloorCategory) => r2(floors.reduce((s, f) => s + f.rooms.filter((r) => floorCategory(r) === cat).reduce((t, r) => t + r.area, 0), 0));
  // S 仕様の既定の床はフロアタイル（吉田大仁様邸の積算S: フローリング 0・フロアタイル 97 ㎡）。設計士が部屋の床を木（挽板）にしたときはそれに従う
  const budgetTile = opts.grade === 'S';
  const defaultWood = (r: Room) => floorCategory(r) === 'flooring' && !r.floorFinish;
  const defaultWoodArea = r2(floors.reduce((s, f) => s + f.rooms.filter(defaultWood).reduce((t, r) => t + r.area, 0), 0));
  const flooringArea = r2(catArea('flooring') - (budgetTile ? defaultWoodArea : 0));
  const floorTileArea = r2(catArea('tile') + (budgetTile ? defaultWoodArea : 0));
  // 内部ポーチ（玄関土間）: 玄関＋土間の収納（＋土間に変えた部屋）。外部ポーチ: ポーチの区画、無ければ御社の標準 1,365×1,820（2.48㎡）
  const porchIn = catArea('doma');
  // ガレージの土間は基礎（建築面積）の中なので外部ポーチには入れない（吉田大仁様邸の積算: 外部ポーチ・テラス 19.04 にガレージ 43.47 は含まない）
  const porchOut = r2(porchRooms > 0 ? porchRooms : 2.48);
  // トイレ: 便所の区画のほか、「洗面・トイレ」のように洗面室と一緒の区画も 1 か所と数える（堀様邸の 1 階）
  const toilets = Math.max(1, floors.reduce((s, f) => s + f.rooms.filter((r) => r.type === 'toilet' || /トイレ|便所|ＷＣ|WC/.test(r.name)).length, 0));
  const stairs = Math.max(0, floors.length - 1);
  const tatami = floors.reduce((s, f) => s + f.rooms.filter((r) => floorCategory(r) === 'tatami').reduce((t, r) => t + r.area, 0), 0) / 1.62;
  const totalTsubo = Math.floor(totalArea * T * 100) / 100;
  const constTsubo = Math.floor(constArea * T * 100) / 100;
  const f2 = fl(2);
  const wet2f: Areas['wet2f'] = f2?.rooms.some((r) => r.type === 'ldk' || r.type === 'kitchen') ? 'ldk' : f2?.rooms.some((r) => ['toilet', 'washroom', 'bath'].includes(r.type)) ? 'some' : 'none';
  // SOLIDO アクセント: 上階なら 2 階の外壁、玄関まわりなら 15 ㎡ ほど
  const solido = opts.solido ?? 'none';
  const upperWall = f2 ? (f2.outline.reduce((s, l) => s + perimeter(l), 0) / 1000) * (f2.height / 1000) * 0.85 : 0;
  const solidoArea = r2(solido === 'upper' ? upperWall : solido === 'lower' ? extWall - upperWall : solido === 'entrance' ? 15 : 0);
  const solidoCorners = solido === 'upper' ? (f2?.outline.reduce((s, l) => s + l.length, 0) ?? 0) : solido === 'lower' ? (f1?.outline.reduce((s, l) => s + l.length, 0) ?? 0) : solido === 'entrance' ? 2 : 0;
  // 高天井（H2500 からの差）: 階の天井高・部屋ごとの天井高（図面の注記「CH=2700」・修正画面の範囲指定）が 2,500 を超える分 × 床面積（㎥）。
  // 御社の積算の「高天井（H2500からの差）」（吉田大仁様邸 1st plan: 102 ㎥）に当たる
  const highCeil = r2(
    floors.reduce(
      (s, f) =>
        s +
        f.rooms
          .filter((r) => !excludedFromFloorArea(r.type))
          .reduce((t, r) => {
            const ch = r.ceilingHeight ?? f.ceilingHeight;
            return t + (ch > 2500 ? ((ch - 2500) / 1000) * r.area : 0);
          }, 0),
      0,
    ),
  );
  return {
    grade: opts.grade,
    floor1,
    floor2,
    floor3,
    totalArea,
    totalTsubo,
    porchOut,
    porchIn,
    extraArea,
    garageArea,
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
    insulWall,
    highCeil,
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
    // 図面に EV（エレベーター）の区画があれば家庭用エレベーターを入れる（有元様邸: 3 階建てで各階に ＥＶ）
    elevator: floors.some((f) => f.rooms.some((r) => /^(EV|ＥＶ|ELV|ＥＬＶ|エレベーター|エレベータ)$/i.test(r.name.replace(/\s/g, '')))),
    soundArea: 0,
    innerTileArea: 0,
    innerSolidoArea: 0,
    paintWallArea: 0,
    woodCeilArea: 0,
    handrailLen: 0,
    doorCloth: 0,
    soStyle: 0,
    travelKm: 0,
    // 3D や修正画面で置き直した家具（キッチンの型を変えた）を図面の記号より優先
    kitchenType: [...(model.furniture ?? []).flatMap((x) => x.items), ...floors.flatMap((f) => f.planItems ?? [])].find((it) => it.kind === 'kitchen' && it.kitchenType)?.kitchenType,
  };
}

/** 切妻の妻壁の三角 1 面の面積 (㎡): 底辺 = 最上階の短辺、高さ = 短辺の半分 × 勾配 */
export function gableTriangleArea(top: Floor, pitch: number): number {
  const tb = bboxOf(top.outline.flat());
  const shortSide = Math.min(tb.maxX - tb.minX, tb.maxY - tb.minY) / 1000;
  return (shortSide / 2) * ((shortSide / 2) * (pitch / 10));
}

/** 床の仕上げの拾い分け（見積の床材・土間・畳の数量）。設計士が変えた床の仕上げ（Room.floorFinish）が最優先 */
export type FloorCategory = 'flooring' | 'tile' | 'tatami' | 'doma' | 'none';
export const FLOOR_CATEGORY_LABEL: Record<FloorCategory, string> = { flooring: 'フローリング', tile: 'フロアタイル', tatami: '畳', doma: '土間（内部ポーチ）', none: '拾わない' };
const FLOORING_TYPES: RoomType[] = ['ldk', 'living', 'dining', 'kitchen', 'bedroom', 'kids', 'study', 'hall', 'other'];
const TILE_TYPES: RoomType[] = ['washroom', 'toilet', 'closet', 'storage'];
const isDomaName = (name: string) => /土間|SIC|シューズ/.test(name);
export function floorCategory(r: Room): FloorCategory {
  if (r.floorFinish === 'wood') return 'flooring';
  if (r.floorFinish === 'tile') return 'tile';
  if (r.floorFinish === 'tatami') return 'tatami';
  if (r.floorFinish === 'doma') return 'doma';
  if (r.type === 'japanese') return 'tatami';
  if (r.type === 'entrance' || ((r.type === 'storage' || r.type === 'closet') && isDomaName(r.name))) return 'doma';
  if (FLOORING_TYPES.includes(r.type)) return 'flooring';
  if (TILE_TYPES.includes(r.type)) return 'tile';
  return 'none';
}

/** 室内の建具（片開き戸・引戸。外壁の戸は玄関ドア・勝手口なので数えない） */
export function interiorDoors(f: Floor) {
  return f.openings.filter((o) => (o.kind === 'door' || o.kind === 'sliding') && !f.walls.find((w) => w.id === o.wallId)?.exterior);
}

export function bboxOf(pts: Vec2[]) {
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
