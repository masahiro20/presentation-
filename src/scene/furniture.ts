/**
 * 家具・設備の自動配置
 * 部屋の種類と開口部（窓・ドア）の位置から、壁際の空いている場所に配置する。
 */
import * as THREE from 'three';
import { excludedFromFloorArea, type BuildingModel, type BuiltinVariant, type Floor, type Room, type FurnitureItem, type FurnitureKind, type Wall } from '../core/types';
import { pointInPolygon } from '../core/geometry';
import { largestInnerRect, rectsMinus, type Rect } from '../core/rects';
import { MeshBuilder, topClip, type ClipPlane, V } from './meshBuilder';
import { MM } from './building';

export type Side = 'n' | 's' | 'e' | 'w';
type V3 = THREE.Vector3;

export interface LightPoint {
  pos: V3;
  kind: 'ceiling' | 'pendant' | 'lamp';
  roomId: string;
}

/** 壁沿いの局所座標系: u = 壁に沿う方向, v = 壁から室内へ */
/** 家具の占有範囲（カメラ位置の衝突判定に使う） */
export interface Footprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  maxY: number;
  /** 底の高さ（ワールド座標）。床に接している家具の接地影に使う。吊戸棚・レンジフードなど浮いているものは床より上 */
  baseY?: number;
  /** 点検用: 置いた物の材質キー */
  key?: string;
}
let currentOcc: Footprint[] | null = null;

/** 平面図に描く家具の外形（ワールド座標 m。x-z 平面） */
export interface PlanItem {
  key: string;
  shape: 'box' | 'circle';
  cx: number;
  cz: number;
  /** box: 幅（along 方向）・奥行（inward 方向）と向き */
  w: number;
  d: number;
  ax: number;
  az: number;
  /** circle: 半径 */
  r: number;
  /** 上端の高さ（重ね順に使う） */
  top: number;
  roomId: string;
}
let currentPlan: PlanItem[] | null = null;

/** 実物の 3D モデル（Poly Haven・CC0。public/models）を置く位置 */
export type ModelId = 'potted_plant_02' | 'potted_plant_04' | 'modern_arm_chair_01' | 'coffee_table_round_01' | 'side_table_01' | 'ceramic_vase_01' | 'modern_ceiling_lamp_01';
export interface ModelPlacement {
  id: ModelId;
  pos: V3;
  /** Y 軸まわりの回転（ラジアン） */
  rotY: number;
  /** 目標の高さ (m)。モデルの大きさから倍率を決める */
  height: number;
  /** 'top' = 上端を pos に合わせる（天井から吊るペンダント）。既定は底面 */
  anchor?: 'top' | 'bottom';
}
let currentModels: ModelPlacement[] = [];
let currentRoomId = '';
/** 平面図に描かない部材（照明・小物・水栓など） */
const PLAN_SKIP = new Set(['f.lamp', 'f.lampShade', 'f.leaf', 'f.chrome', 'f.screen', 'f.hood', 'f.white', 'f.metal']);

class Frame {
  constructor(
    readonly mb: MeshBuilder,
    readonly origin: V3,
    readonly along: V3,
    readonly inward: V3,
  ) {}
  /** u: 中心位置（壁に沿う）, v: 壁からの距離, w: 幅, d: 奥行, y0: 下端, h: 高さ */
  box(key: string, u: number, v: number, w: number, d: number, y0: number, h: number) {
    const c = this.origin.clone().addScaledVector(this.along, u).addScaledVector(this.inward, v + d / 2);
    c.y = this.origin.y + y0;
    // 布・寝具・天板は角を丸めて、CG らしい硬い稜線を避ける
    const soft = key === 'f.fabric' || key === 'f.fabric2' || key === 'f.bedding';
    const minDim = Math.min(w, d, h);
    if (soft && minDim > 0.03) this.mb.roundedBox(key, c, this.along, w, h, d, Math.min(0.06, minDim * 0.3), 3);
    else if ((key === 'f.wood' || key === 'f.counter' || key === 'f.cabinet') && minDim > 0.02) this.mb.roundedBox(key, c, this.along, w, h, d, Math.min(0.006, minDim * 0.25), 1);
    else this.mb.box(key, c, this.along, w, h, d);
    if (currentPlan && !PLAN_SKIP.has(key) && w >= 0.12 && d >= 0.12 && y0 < 1.2) {
      currentPlan.push({ key, shape: 'box', cx: c.x, cz: c.z, w, d, ax: this.along.x, az: this.along.z, r: 0, top: y0 + h, roomId: currentRoomId });
    }
    if (currentOcc && y0 + h > 0.3 && key !== 'f.rug') {
      const ex = Math.abs(this.along.x) * w / 2 + Math.abs(this.inward.x) * d / 2;
      const ez = Math.abs(this.along.z) * w / 2 + Math.abs(this.inward.z) * d / 2;
      currentOcc.push({ minX: c.x - ex, maxX: c.x + ex, minZ: c.z - ez, maxZ: c.z + ez, maxY: y0 + h, baseY: this.origin.y + y0, key });
    }
  }
  cyl(key: string, u: number, v: number, r: number, y0: number, h: number, seg = 16) {
    const c = this.origin.clone().addScaledVector(this.along, u).addScaledVector(this.inward, v);
    if (currentPlan && !PLAN_SKIP.has(key) && r >= 0.1 && y0 < 1.2) currentPlan.push({ key, shape: 'circle', cx: c.x, cz: c.z, w: 0, d: 0, ax: 1, az: 0, r, top: y0 + h, roomId: currentRoomId });
    c.y = this.origin.y + y0;
    this.mb.cylinder(key, c, r, h, seg);
  }
  sphere(key: string, u: number, v: number, y: number, r: number, sy = 1) {
    const c = this.origin.clone().addScaledVector(this.along, u).addScaledVector(this.inward, v);
    c.y = this.origin.y + y;
    this.mb.sphere(key, c, r, 10, sy);
  }
  point(u: number, v: number, y: number): V3 {
    const c = this.origin.clone().addScaledVector(this.along, u).addScaledVector(this.inward, v);
    c.y = this.origin.y + y;
    return c;
  }
}

interface RoomCtx {
  mb: MeshBuilder;
  R: { minX: number; maxX: number; minZ: number; maxZ: number };
  y: number;
  blocked: Record<Side, [number, number][]>;
  windows: Record<Side, number>;
  lights: LightPoint[];
  room: Room;
  env: ItemEnv;
  /** 図面の記号から置いた家具の種類（自動配置はこれ以外を補う） */
  has: Set<FurnitureKind>;
  /** 図面から置いたキッチン（ダイニングの並びに使う） */
  planKitchen?: FurnitureItem;
  /** 図面から置いたソファ（ラグ・ローテーブル・テレビ台を周りに補う） */
  planSofas?: FurnitureItem[];
}

/** 家具を置くときの階の情報 */
interface ItemEnv {
  mb: MeshBuilder;
  y: number;
  ceilingY: number;
  lights: LightPoint[];
  /** この階の壁（自動で置いた家具が壁にめり込んだら押し戻す） */
  walls?: Wall[];
}
/** この階に置いた家具（手修正の初期値・平面図に使う） */
let currentItems: FurnitureItem[] | null = null;
let itemSeq = 0;
const DEG = 180 / Math.PI;

export const FURNITURE_LABEL: Record<FurnitureKind, string> = {
  kitchen: 'キッチン',
  dining: 'ダイニング',
  sofa: 'ソファ',
  coffeeTable: 'ローテーブル',
  tv: 'テレビ台',
  rug: 'ラグ',
  plant: '観葉植物',
  chair: 'チェア',
  bed: 'ベッド',
  nightstand: 'ナイトテーブル',
  desk: 'デスク',
  cabinet: '収納',
  bookshelf: '本棚',
  lowTable: '座卓',
  bath: '浴槽',
  mirror: '鏡',
  washstand: '洗面台',
  washer: '洗濯機',
  toilet: 'トイレ',
  shoeCabinet: '下駄箱',
  fridge: '冷蔵庫',
  cupboard: '背面収納',
  builtin: '造作家具',
};

/** キッチンの型（選択肢の表示名） */
export const KITCHEN_TYPES: [NonNullable<FurnitureItem['kitchenType']>, string][] = [
  ['peninsula', '対面ペニンシュラ（カウンタースタイル）'],
  ['island', 'アイランド'],
  ['wall', '壁付け I 型'],
  ['two', 'Ⅱ型（壁にコンロ・対面にシンク）'],
  ['l', 'L 型（壁にシンク・袖にコンロ）'],
];

/** 造作家具の形（名前・既定の幅 m・奥行 m・説明） */
export const BUILTIN_VARIANTS: Record<BuiltinVariant, { label: string; w: number; d: number; note: string }> = {
  wallShelf: { label: '造作本棚（壁一面・天井まで）', w: 2.4, d: 0.35, note: '縦板 600 前後の割り、棚板 350 ピッチ。本と小物を飾る' },
  shelfDesk: { label: '本棚＋デスク（スタディコーナー）', w: 2.0, d: 0.55, note: '天板 H720 の通しカウンター、上部はオープン棚' },
  floatTv: { label: 'フロートテレビボード＋飾り棚', w: 2.4, d: 0.42, note: '床から浮かせた箱（H250〜600）と上部の浮き棚' },
  openShelf: { label: '飾り棚（浮き棚 3 段）', w: 1.6, d: 0.25, note: '壁から持ち出した厚板の棚' },
  bench: { label: '造作ベンチ（収納付き）', w: 1.8, d: 0.45, note: '窓辺・ダイニング脇。座面 H420、クッション付き' },
  counter: { label: 'スタディカウンター（壁付け）', w: 2.0, d: 0.5, note: '天板 H720 の持ち出しカウンター' },
  tallStorage: { label: '壁面収納（扉付き・天井まで）', w: 2.4, d: 0.45, note: 'クロスになじむフラット扉、目地だけ見せる' },
  lowShelf: { label: '腰高のオープン棚', w: 1.8, d: 0.35, note: '窓下・吹抜の手すり際。H900' },
};

/** 平面に描くときの外形 (m): 幅 w（並び方向）、奥行 d、基準点から奥行方向への始まり v0 */
export function furnitureDims(it: FurnitureItem): { w: number; d: number; v0: number } {
  switch (it.kind) {
    case 'kitchen':
      if (it.kitchenType === 'l') return { w: Math.max(1.8, (it.len ?? 3) - 0.3), d: it.d ? Math.max(1.5, Math.min(2.8, it.d)) : 2.1, v0: 0 };
      return { w: Math.max(1.5, (it.len ?? 3) - 0.3), d: (it.kitchenType ?? 'peninsula') === 'wall' ? 0.7 : (it.d ? Math.max(1.2, Math.min(2.6, it.d)) : 1.52) + 0.45, v0: 0 };
    case 'builtin': {
      const b = BUILTIN_VARIANTS[it.variant ?? 'wallShelf'];
      return { w: it.w ?? b.w, d: it.d ?? b.d, v0: 0 };
    }
    case 'fridge':
      return { w: 0.68, d: 0.7, v0: 0 };
    case 'cupboard':
      return { w: it.w ?? 1.8, d: 0.45, v0: 0 };
    case 'dining':
      return { w: it.w ?? 1.8, d: 1.65, v0: -0.83 };
    case 'sofa':
      return { w: it.w ?? 2.1, d: 0.9, v0: 0 };
    case 'coffeeTable':
      return { w: 1.0, d: 0.5, v0: 0 };
    case 'tv':
      return { w: it.w ?? 1.8, d: 0.42, v0: 0 };
    case 'rug':
      return { w: it.w ?? 2.2, d: it.d ?? 1.6, v0: 0 };
    case 'plant':
      return { w: 0.5 * (it.w ?? 1), d: 0.5 * (it.w ?? 1), v0: -0.25 * (it.w ?? 1) };
    case 'chair':
      return { w: 0.75, d: 0.8, v0: -0.4 };
    case 'bed':
      return { w: (it.w ?? 1.4) + 0.06, d: 2.04, v0: -0.04 };
    case 'nightstand':
      return { w: 0.45, d: 0.4, v0: 0 };
    case 'desk':
      return { w: 1.0, d: 1.2, v0: 0 };
    case 'cabinet':
      return { w: 1.2, d: 0.45, v0: 0 };
    case 'bookshelf':
      return { w: 0.9, d: 0.32, v0: 0 };
    case 'lowTable':
      return { w: 1.2, d: 2.0, v0: -1.0 };
    case 'bath':
      return { w: it.len ?? 1.6, d: 0.8, v0: 0 };
    case 'mirror':
      return { w: 0.45, d: 0.06, v0: 0 };
    case 'washstand':
      return { w: 0.77, d: 0.52, v0: 0 };
    case 'washer':
      return { w: 0.6, d: 0.6, v0: 0 };
    case 'toilet':
      return { w: 0.4, d: 0.75, v0: 0 };
    case 'shoeCabinet':
      return { w: 1.22, d: 0.4, v0: 0 };
  }
}

function sideFrame(ctx: RoomCtx, s: Side, R = ctx.R): { f: Frame; len: number } {
  const { mb, y } = ctx;
  const cx = (R.minX + R.maxX) / 2;
  const cz = (R.minZ + R.maxZ) / 2;
  switch (s) {
    case 'n':
      return { f: new Frame(mb, V(cx, y, R.minZ), V(1, 0, 0), V(0, 0, 1)), len: R.maxX - R.minX };
    case 's':
      return { f: new Frame(mb, V(cx, y, R.maxZ), V(-1, 0, 0), V(0, 0, -1)), len: R.maxX - R.minX };
    case 'w':
      return { f: new Frame(mb, V(R.minX, y, cz), V(0, 0, -1), V(1, 0, 0)), len: R.maxZ - R.minZ };
    case 'e':
      return { f: new Frame(mb, V(R.maxX, y, cz), V(0, 0, 1), V(-1, 0, 0)), len: R.maxZ - R.minZ };
  }
}

const opposite: Record<Side, Side> = { n: 's', s: 'n', e: 'w', w: 'e' };

/** 壁沿いの区間 [u0,u1]（中心基準）が開口と干渉しないか */
function isFree(ctx: RoomCtx, s: Side, u0: number, u1: number): boolean {
  return !ctx.blocked[s].some(([a, b]) => a < u1 && b > u0);
}

/** 幅 w の家具を置ける、中央に最も近い位置 */
function findSpot(ctx: RoomCtx, s: Side, w: number, len: number, prefer = 0): number | null {
  const cands: number[] = [];
  for (let u = -len / 2 + w / 2 + 0.05; u <= len / 2 - w / 2 - 0.05; u += 0.05) cands.push(u);
  cands.sort((a, b) => Math.abs(a - prefer) - Math.abs(b - prefer));
  for (const u of cands) if (isFree(ctx, s, u - w / 2, u + w / 2)) return u;
  return null;
}

/** 実物モデルを使える環境か（ブラウザ）。使えない場合は簡易形状で植物を描く */
let modelsAvailable = typeof document !== 'undefined';
export function setModelsAvailable(v: boolean) {
  modelsAvailable = v;
}

export function buildFurniture(
  model: BuildingModel,
  opts: { cut?: { level: number; y: number }; clip?: ClipPlane } = {},
): { mb: MeshBuilder; lights: LightPoint[]; occupancy: Map<string, Footprint[]>; kitchenSide: Map<string, Side>; models: ModelPlacement[]; items: Map<number, FurnitureItem[]> } {
  const mb = new MeshBuilder();
  // 輪切り（模型）: 切断面より上は作らず、切った階より上の階の家具は置かない
  mb.clip = opts.clip ?? (opts.cut ? topClip(opts.cut.y) : null);
  currentModels = [];
  const lights: LightPoint[] = [];
  const occupancy = new Map<string, Footprint[]>();
  kitchenSides = new Map();
  const items = new Map<number, FurnitureItem[]>();
  for (const f of model.floors) {
    if (opts.cut && f.level > opts.cut.level) continue;
    currentItems = [];
    items.set(f.level, currentItems);
    // 手で置き直した階は、その家具だけを置く（天井の照明は自動のまま）
    const override = model.furniture?.find((o) => o.level === f.level);
    const env: ItemEnv = { mb, y: f.elevation * MM, ceilingY: f.ceilingHeight * MM, lights, walls: f.walls };
    for (const room of f.rooms) {
      let inner = largestInnerRect(room.polygon, 5);
      if (!inner) continue;
      // 階段の上には家具を置かない: 部屋の内側の矩形から階段を除いた最大の矩形を使う
      const stairRects = f.stairs.filter((st) => st.maxX > inner!.minX && st.minX < inner!.maxX && st.maxY > inner!.minY && st.minY < inner!.maxY).map((st) => ({ minX: st.minX - 150, minY: st.minY - 150, maxX: st.maxX + 150, maxY: st.maxY + 150 }));
      if (stairRects.length) {
        const parts = rectsMinus([inner], stairRects).sort((a, b) => (b.maxX - b.minX) * (b.maxY - b.minY) - (a.maxX - a.minX) * (a.maxY - a.minY));
        if (parts[0]) inner = parts[0];
      }
      const inset = 0.07;
      const R = {
        minX: inner.minX * MM + inset,
        maxX: inner.maxX * MM - inset,
        minZ: inner.minY * MM + inset,
        maxZ: inner.maxY * MM - inset,
      };
      if (R.maxX - R.minX < 0.5 || R.maxZ - R.minZ < 0.5) continue;
      currentOcc = [];
      occupancy.set(room.id, currentOcc);
      currentRoomId = room.id;
      const ctx: RoomCtx = { mb, R, y: f.elevation * MM, blocked: { n: [], s: [], e: [], w: [] }, windows: { n: 0, s: 0, e: 0, w: 0 }, lights, room, env, has: new Set() };
      collectBlocked(ctx, f, inner);
      const ceilingY = f.ceilingHeight * MM;
      const center = V((R.minX + R.maxX) / 2, ctx.y + ceilingY - 0.02, (R.minZ + R.maxZ) / 2);
      if (override) {
        if (!excludedFromFloorArea(room.type) && !['other', 'closet', 'storage'].includes(room.type)) lights.push({ pos: center, kind: 'ceiling', roomId: room.id });
        continue;
      }
      // 図面の記号から読んだ家具は、図面どおりの位置・向きに先に置く
      for (const it of f.planItems ?? []) {
        if (it.roomId !== room.id) continue;
        emitItem({ ...it }, env);
        ctx.has.add(it.kind);
        if (it.kind === 'kitchen') ctx.planKitchen = it;
        if (it.kind === 'sofa') (ctx.planSofas ??= []).push(it);
      }
      switch (room.type) {
        case 'ldk':
        case 'living':
        case 'dining':
        case 'kitchen':
          layoutLDK(ctx, model, f);
          break;
        case 'bedroom':
        case 'kids':
          layoutBedroom(ctx, room.name.includes('主') || (R.maxX - R.minX) * (R.maxZ - R.minZ) > 11);
          lights.push({ pos: center, kind: 'ceiling', roomId: room.id });
          break;
        case 'study':
          layoutStudy(ctx);
          lights.push({ pos: center, kind: 'ceiling', roomId: room.id });
          break;
        case 'japanese':
          layoutJapanese(ctx);
          lights.push({ pos: center, kind: 'ceiling', roomId: room.id });
          break;
        case 'bath':
          layoutBath(ctx);
          lights.push({ pos: center, kind: 'ceiling', roomId: room.id });
          break;
        case 'washroom':
          layoutWash(ctx);
          lights.push({ pos: center, kind: 'ceiling', roomId: room.id });
          break;
        case 'toilet':
          layoutToilet(ctx);
          lights.push({ pos: center, kind: 'ceiling', roomId: room.id });
          break;
        case 'entrance':
          layoutEntrance(ctx);
          lights.push({ pos: center, kind: 'ceiling', roomId: room.id });
          break;
        case 'hall':
          lights.push({ pos: center, kind: 'ceiling', roomId: room.id });
          break;
        default:
          break;
      }
    }
    if (override) {
      for (const it of override.items) {
        const room = (it.roomId && f.rooms.find((r) => r.id === it.roomId)) || f.rooms.find((r) => pointInPolygon({ x: it.x, y: it.y }, r.polygon));
        currentRoomId = room?.id ?? '';
        if (currentRoomId && !occupancy.has(currentRoomId)) occupancy.set(currentRoomId, []);
        currentOcc = currentRoomId ? occupancy.get(currentRoomId)! : null;
        emitItem({ ...it, roomId: currentRoomId || undefined }, { ...env, walls: undefined });
      }
    }
  }
  currentOcc = null;
  currentItems = null;
  // 切断で取り除いた側・切断面より上の実物モデル（観葉植物など）は置かない
  const clip = mb.clip;
  const models = clip ? currentModels.filter((m) => m.pos.dot(clip.n) - clip.d < (clip.n.y > 0.5 ? -0.3 : 0)) : currentModels;
  return { mb, lights, occupancy, kitchenSide: kitchenSides, models, items };
}

/** 置く家具の一覧（手で置き直した階はその内容、ほかは自動配置の結果） */
export function furnitureItems(model: BuildingModel): Map<number, FurnitureItem[]> {
  return buildFurniture(model).items;
}

function sideOfRot(rot: number): Side {
  const r = ((Math.round(rot / 90) % 4) + 4) % 4;
  return (['n', 'e', 's', 'w'] as Side[])[r];
}

/** 家具を置く: 位置・向きを記録してから形を作る（手修正の初期値・平面図・3D を同じ経路で） */
function place(kind: FurnitureKind, fr: Frame, u: number, v: number, env: ItemEnv, extra: Partial<FurnitureItem> = {}) {
  const p = fr.point(u, v, 0);
  const it: FurnitureItem = { id: `fi${++itemSeq}`, kind, x: Math.round(p.x / MM), y: Math.round(p.z / MM), rot: Math.round(Math.atan2(fr.along.z, fr.along.x) * DEG), roomId: currentRoomId || undefined, ...extra };
  emitItem(it, env);
}

/**
 * 足した占有範囲が壁の面からどれだけ中へ入り込んでいるか（m）と、押し戻す向き。
 * 壁の芯を 5cm おきにたどり、家具の外形（AABB）を壁厚の半分だけ広げた中に入る点の深さを見る
 */
function wallIntrusion(fps: Footprint[], walls: Wall[]): { pen: number; push: THREE.Vector2 } {
  let pen = 0;
  const push = new THREE.Vector2();
  for (const fp of fps) {
    for (const w of walls) {
      const ax = w.a.x * MM, az = w.a.y * MM, bx = w.b.x * MM, bz = w.b.y * MM;
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      const t = (w.thickness || 120) * MM * 0.5;
      if (Math.max(ax, bx) < fp.minX - t || Math.min(ax, bx) > fp.maxX + t || Math.max(az, bz) < fp.minZ - t || Math.min(az, bz) > fp.maxZ + t) continue;
      const n = Math.max(2, Math.ceil(L / 0.05));
      let wp = 0;
      for (let i = 0; i <= n; i++) {
        const x = ax + ((bx - ax) * i) / n;
        const z = az + ((bz - az) * i) / n;
        const dx = Math.min(x - fp.minX, fp.maxX - x);
        const dz = Math.min(z - fp.minZ, fp.maxZ - z);
        if (dx > -t && dz > -t) wp = Math.max(wp, Math.min(dx, dz) + t);
      }
      if (wp > pen) {
        pen = wp;
        // 壁の法線のうち、家具の中心の側
        const nx = -(bz - az) / L, nz = (bx - ax) / L;
        const cx = (fp.minX + fp.maxX) / 2 - ax, cz = (fp.minZ + fp.maxZ) / 2 - az;
        const sgn = nx * cx + nz * cz >= 0 ? 1 : -1;
        push.set(nx * sgn, nz * sgn);
      }
    }
  }
  return { pen, push };
}

/** これ以上壁に入り込んだら置き直す（m）。薄い巾木・額縁ぶんの誤差は見逃す */
const WALL_TOL = 0.03;
/** 置き直しても入り込むとき、無くても困らない物は置かない */
const OPTIONAL_KINDS = new Set<FurnitureKind>(['fridge', 'plant', 'chair', 'nightstand', 'desk', 'bookshelf', 'cabinet', 'cupboard', 'tv', 'coffeeTable', 'rug', 'lowTable', 'builtin']);

/**
 * 記録した家具 1 つの形を作る。自動で置いた家具が壁を突き抜けていたら（図面の読み違い・狭い部屋）、
 * 壁から離れる向きに押し戻して置き直し、それでも突き抜ける小物は置かない
 */
function emitItem(it: FurnitureItem, env: ItemEnv) {
  if (!env.walls?.length || !currentOcc) {
    emitItemRaw(it, env);
    return;
  }
  const snap = () => ({ mb: env.mb.mark(), occ: currentOcc!.length, items: currentItems?.length ?? 0, lights: env.lights.length, models: currentModels.length, plan: currentPlan?.length ?? 0 });
  const back = (s: ReturnType<typeof snap>) => {
    env.mb.restore(s.mb);
    currentOcc!.length = s.occ;
    if (currentItems) currentItems.length = s.items;
    env.lights.length = s.lights;
    currentModels.length = s.models;
    if (currentPlan) currentPlan.length = s.plan;
  };
  const s0 = snap();
  emitItemRaw(it, env);
  let res = wallIntrusion(currentOcc.slice(s0.occ), env.walls);
  if (res.pen <= WALL_TOL) return;
  if (it.kind === 'kitchen') {
    // キッチンは動かさず（カップボード・照明の位置がキッチンから決まる）、端の冷蔵庫・背面収納を詰めて収める
    const variants: Partial<FurnitureItem>[] = [{ fridge: 'none' }, { fridge: 'none', len: Math.max(2.4, (it.len ?? 3) - 0.6) }];
    let best: { pen: number; v: Partial<FurnitureItem> } = { pen: res.pen, v: {} };
    for (const v of variants) {
      back(s0);
      emitItemRaw({ ...it, ...v }, env);
      const r = wallIntrusion(currentOcc.slice(s0.occ), env.walls).pen;
      if (r < best.pen - 0.02) best = { pen: r, v };
      if (r <= WALL_TOL) break;
    }
    // それでも当たるときは、壁から 30cm までの範囲でキッチンごと押し戻す
    for (let k = 0, cur = { ...best.v }; k < 3 && best.pen > WALL_TOL; k++) {
      back(s0);
      emitItemRaw({ ...it, ...cur }, env);
      const r = wallIntrusion(currentOcc.slice(s0.occ), env.walls);
      if (r.pen < best.pen - 0.02) best = { pen: r.pen, v: { ...cur } };
      const nx = (cur.x ?? it.x) + Math.round((r.push.x * (r.pen + 0.01)) / MM);
      const ny = (cur.y ?? it.y) + Math.round((r.push.y * (r.pen + 0.01)) / MM);
      if (Math.hypot(nx - it.x, ny - it.y) > 300) break;
      cur = { ...cur, x: nx, y: ny };
    }
    back(s0);
    Object.assign(it, best.v);
    emitItemRaw(it, env);
    return;
  }
  // 幅はそのまま → 部屋より長いソファ・造作（図面の記号の読み違い）は幅を詰めて、それぞれ壁から押し戻す
  const w0 = it.w ?? (it.kind === 'dining' ? 1.8 : it.kind === 'sofa' ? 2.1 : undefined);
  const widths = w0 && w0 > 1 ? [it.w, ...[0.92, 0.84, 0.76, 0.68].map((k) => +(w0 * k).toFixed(2))] : [it.w];
  let best = { pen: res.pen, x: it.x, y: it.y, w: it.w };
  for (const w of widths) {
    let cur = { x: it.x, y: it.y, w };
    for (let k = 0; k < 4; k++) {
      if (k > 0 || w !== it.w) {
        back(s0);
        emitItemRaw({ ...it, ...cur }, env);
        res = wallIntrusion(currentOcc.slice(s0.occ), env.walls);
      }
      if (res.pen < best.pen - 0.005) best = { pen: res.pen, ...cur };
      if (res.pen <= WALL_TOL) {
        Object.assign(it, cur);
        return;
      }
      cur = { ...cur, x: Math.round(cur.x + (res.push.x * (res.pen + 0.01)) / MM), y: Math.round(cur.y + (res.push.y * (res.pen + 0.01)) / MM) };
    }
  }
  back(s0);
  if (best.pen > 0.12 && OPTIONAL_KINDS.has(it.kind)) return;
  Object.assign(it, best);
  emitItemRaw(it, env);
}

function emitItemRaw(it: FurnitureItem, env: ItemEnv) {
  currentItems?.push(it);
  const r = it.rot / DEG;
  const fr = new Frame(env.mb, V(it.x * MM, env.y, it.y * MM), V(Math.cos(r), 0, Math.sin(r)), V(-Math.sin(r), 0, Math.cos(r)));
  const roomId = it.roomId ?? currentRoomId;
  switch (it.kind) {
    case 'kitchen':
      kitchen(fr, it.len ?? 3, env.ceilingY, it);
      kitchenSides.set(roomId, sideOfRot(it.rot));
      env.lights.push({ pos: fr.point(0, (it.kitchenType ?? 'peninsula') === 'wall' ? 1.0 : 1.3, env.ceilingY - 0.02), kind: 'ceiling', roomId });
      break;
    case 'fridge':
      fr.box('f.fridge', 0, 0, 0.68, 0.7, 0, 1.82);
      fr.box('f.metal', 0.2, 0.7, 0.02, 0.02, 0.9, 0.6);
      break;
    case 'cupboard': {
      const cw = it.w ?? 1.8;
      fr.box('f.cabinet', 0, 0, cw, 0.45, 0, 0.9);
      fr.box('f.counter', 0, 0, cw, 0.47, 0.9, 0.03);
      break;
    }
    case 'dining':
      diningSet(fr, 0, 0, env.lights, roomId, env.ceilingY, it.w);
      break;
    case 'sofa':
      sofa(fr, 0, 0, it.w ?? 2.1);
      break;
    case 'coffeeTable':
      coffeeTable(fr, 0, 0);
      break;
    case 'tv':
      tvSet(fr, 0, 0, it.w ?? 1.8);
      break;
    case 'rug':
      rug(fr, 0, 0, it.w ?? 2.2, it.d ?? 1.6);
      break;
    case 'plant':
      plant(fr, 0, 0, it.w ?? 1);
      break;
    case 'chair': {
      const p = fr.point(0, 0, 0);
      currentModels.push({ id: 'modern_arm_chair_01', pos: p, rotY: Math.atan2(fr.inward.x, fr.inward.z), height: 0.82 });
      if (currentPlan) currentPlan.push({ key: 'f.fabric', shape: 'box', cx: p.x, cz: p.z, w: 0.75, d: 0.8, ax: fr.along.x, az: fr.along.z, r: 0, top: 0.8, roomId });
      if (currentOcc) currentOcc.push({ minX: p.x - 0.4, maxX: p.x + 0.4, minZ: p.z - 0.4, maxZ: p.z + 0.4, maxY: p.y + 0.8, baseY: p.y });
      break;
    }
    case 'bed':
      bed(fr, 0, 0, it.w ?? 1.4);
      break;
    case 'nightstand':
      nightstand(fr, 0, 0, env.lights, roomId);
      break;
    case 'desk':
      desk(fr, 0, 0);
      break;
    case 'cabinet':
      fr.box('f.cabinet', 0, 0, 1.2, 0.45, 0, 0.75);
      break;
    case 'bookshelf':
      fr.box('f.cabinet', 0, 0, 0.9, 0.32, 0, 1.8);
      for (let i = 1; i < 5; i++) fr.box('f.wood', 0, 0.01, 0.84, 0.3, i * 0.36, 0.02);
      break;
    case 'builtin':
      builtinFurniture(fr, it, env.ceilingY);
      break;
    case 'lowTable':
      fr.box('f.wood', 0, -0.4, 1.2, 0.8, 0.3, 0.05);
      for (const du of [-0.55, 0.55]) for (const dv of [-0.35, 0.35]) fr.box('f.wood', du, dv - 0.03, 0.06, 0.06, 0, 0.3);
      for (const [du, dv] of [
        [-0.35, -0.75],
        [0.35, -0.75],
        [-0.35, 0.75],
        [0.35, 0.75],
      ])
        fr.box('f.fabric2', du, dv - 0.26, 0.52, 0.52, 0.01, 0.07);
      break;
    case 'bath': {
      const tw = it.len ?? 1.6;
      fr.box('f.white', 0, 0, tw, 0.8, 0, 0.55);
      fr.box('f.water', 0, 0.08, tw - 0.16, 0.64, 0.5, 0.02);
      break;
    }
    case 'mirror':
      fr.box('f.mirror', 0, 0.005, 0.45, 0.01, 0.8, 0.8);
      fr.box('f.chrome', 0, 0.02, 0.2, 0.08, 0.7, 0.05);
      break;
    case 'washstand':
      fr.box('f.cabinet', 0, 0, 0.75, 0.5, 0, 0.78);
      fr.box('f.counter', 0, 0, 0.77, 0.52, 0.78, 0.05);
      fr.box('f.white', 0, 0.1, 0.45, 0.32, 0.8, 0.06);
      fr.box('f.mirror', 0, 0.005, 0.72, 0.01, 1.05, 0.85);
      fr.box('f.chrome', 0, 0.05, 0.03, 0.12, 0.83, 0.15);
      break;
    case 'washer':
      fr.box('f.white', 0, 0, 0.6, 0.6, 0, 0.9);
      fr.cyl('f.screen', 0, 0.61, 0.17, 0.35, 0.3, 20);
      break;
    case 'toilet':
      fr.box('f.white', 0, 0.02, 0.38, 0.2, 0.45, 0.35); // タンク
      fr.box('f.white', 0, 0.2, 0.36, 0.4, 0, 0.4);
      fr.cyl('f.white', 0, 0.55, 0.19, 0, 0.4, 20);
      fr.box('f.white', 0, 0.2, 0.38, 0.55, 0.4, 0.04);
      fr.box('f.chrome', 0.28, 0.4, 0.12, 0.1, 0.7, 0.05);
      break;
    case 'shoeCabinet':
      fr.box('f.cabinet', 0, 0, 1.2, 0.38, 0.25, 0.85);
      fr.box('f.counter', 0, 0, 1.22, 0.4, 1.1, 0.03);
      break;
  }
}

let kitchenSides = new Map<string, Side>();

/** 平面図用: 家具の外形を階ごとに（3D と同じ自動配置） */
export function planFurniture(model: BuildingModel): Map<number, PlanItem[]> {
  const out = new Map<number, PlanItem[]>();
  currentPlan = [];
  try {
    buildFurniture(model);
    const roomFloor = new Map<string, number>();
    for (const f of model.floors) for (const r of f.rooms) roomFloor.set(r.id, f.level);
    for (const it of currentPlan) {
      const lv = roomFloor.get(it.roomId);
      if (lv == null) continue;
      if (!out.has(lv)) out.set(lv, []);
      out.get(lv)!.push(it);
    }
  } finally {
    currentPlan = null;
  }
  return out;
}

function collectBlocked(ctx: RoomCtx, f: Floor, inner: Rect) {
  const tol = 400; // mm
  for (const o of f.openings) {
    const w = f.walls.find((w) => w.id === o.wallId);
    if (!w) continue;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    const p0 = { x: w.a.x + ux * o.t0, y: w.a.y + uy * o.t0 };
    const p1 = { x: w.a.x + ux * o.t1, y: w.a.y + uy * o.t1 };
    const horiz = Math.abs(uy) < 0.1;
    const vert = Math.abs(ux) < 0.1;
    // 低い窓（腰高 > 1.1m）は家具の妨げにならない
    const blocks = !(o.kind === 'window' && o.sill >= 1100);
    const extra = o.kind === 'door' ? 0.1 : 0.05;
    const addH = (side: Side, z: number) => {
      if (Math.abs(p0.y - z) > tol) return;
      const { f: fr } = sideFrame(ctx, side);
      const a = (p0.x * MM - fr.origin.x) * fr.along.x;
      const b = (p1.x * MM - fr.origin.x) * fr.along.x;
      if (blocks) ctx.blocked[side].push([Math.min(a, b) - extra, Math.max(a, b) + extra]);
      if (o.kind === 'window') ctx.windows[side] += Math.abs(b - a) * (o.windowStyle === 'hakidashi' ? 2 : 1);
    };
    const addV = (side: Side, x: number) => {
      if (Math.abs(p0.x - x) > tol) return;
      const { f: fr } = sideFrame(ctx, side);
      const a = (p0.y * MM - fr.origin.z) * fr.along.z;
      const b = (p1.y * MM - fr.origin.z) * fr.along.z;
      if (blocks) ctx.blocked[side].push([Math.min(a, b) - extra, Math.max(a, b) + extra]);
      if (o.kind === 'window') ctx.windows[side] += Math.abs(b - a) * (o.windowStyle === 'hakidashi' ? 2 : 1);
    };
    const within = (v: number, a: number, b: number) => v > a - 200 && v < b + 200;
    if (horiz && (within(p0.x, inner.minX, inner.maxX) || within(p1.x, inner.minX, inner.maxX))) {
      addH('n', inner.minY);
      addH('s', inner.maxY);
    }
    if (vert && (within(p0.y, inner.minY, inner.maxY) || within(p1.y, inner.minY, inner.maxY))) {
      addV('w', inner.minX);
      addV('e', inner.maxX);
    }
  }
}

// ---------------------------------------------------------------------------
// 家具パーツ
// ---------------------------------------------------------------------------

function sofa(fr: Frame, u: number, v: number, w: number) {
  // 低く奥行きのある、肘のないモジュールソファ（ミノッティ・B&B イタリア系の設計事務所でよく選ぶ形）
  const d = 0.9;
  // 奥に引いた黒い台座で浮いて見せる
  fr.box('f.metal', u, v + 0.06, w - 0.12, d - 0.12, 0, 0.07);
  fr.box('f.fabric', u, v, w, d, 0.07, 0.25); // 座の台
  const n = w > 2.4 ? 3 : 2;
  const sw = w / n;
  for (let i = 0; i < n; i++) fr.box('f.fabric', u - w / 2 + sw * (i + 0.5), v + 0.2, sw - 0.012, d - 0.2, 0.32, 0.1); // 座クッション
  fr.box('f.fabric', u, v, w, 0.2, 0.32, 0.36); // 低い背
  // 背クッション（ゆったりと）とアクセントのクッション 2 つ
  for (let i = 0; i < n; i++) fr.box('f.fabric', u - w / 2 + sw * (i + 0.5), v + 0.16, sw - 0.06, 0.16, 0.42, 0.34);
  fr.box('f.fabric2', u - w / 2 + 0.35, v + 0.3, 0.42, 0.12, 0.42, 0.36);
  fr.box('f.fabric2', u + w / 2 - 0.55, v + 0.3, 0.38, 0.12, 0.42, 0.32);
  // ソファ脇のサイドテーブル（オークの箱型・実物モデル）と、その上の器
  const sp = fr.point(u + w / 2 + 0.32, v + 0.35, 0);
  currentModels.push({ id: 'side_table_01', pos: sp, rotY: Math.atan2(fr.inward.x, fr.inward.z), height: 0.5 });
  currentModels.push({ id: 'ceramic_vase_01', pos: sp.clone().setY(sp.y + 0.5), rotY: 0.7, height: 0.2 });
  if (currentPlan) currentPlan.push({ key: 'f.wood', shape: 'box', cx: sp.x, cz: sp.z, w: 0.45, d: 0.45, ax: fr.along.x, az: fr.along.z, r: 0, top: 0.5, roomId: currentRoomId });
  if (currentOcc) currentOcc.push({ minX: sp.x - 0.25, maxX: sp.x + 0.25, minZ: sp.z - 0.25, maxZ: sp.z + 0.25, maxY: sp.y + 0.5, baseY: sp.y });
}

function coffeeTable(fr: Frame, u: number, v: number) {
  // 実物のローテーブル（大理石の丸天板・スチール脚）と、その上の陶器の花器。読み込めない環境では下の簡易形状
  const p = fr.point(u, v + 0.3, 0);
  currentModels.push({ id: 'coffee_table_round_01', pos: p, rotY: 0.3, height: 0.4 });
  currentModels.push({ id: 'ceramic_vase_01', pos: p.clone().setY(p.y + 0.4).addScaledVector(fr.along, 0.18), rotY: 1.1, height: 0.26 });
  if (currentPlan) currentPlan.push({ key: 'f.counter', shape: 'circle', cx: p.x, cz: p.z, w: 0, d: 0, ax: 1, az: 0, r: 0.48, top: 0.4, roomId: currentRoomId });
  if (currentOcc) currentOcc.push({ minX: p.x - 0.5, maxX: p.x + 0.5, minZ: p.z - 0.5, maxZ: p.z + 0.5, maxY: p.y + 0.4, baseY: p.y });
  if (modelsAvailable) return;
  // 低い石の天板（トラバーチン調）を、ひと回り小さい台座で浮かせる
  fr.box('f.counter', u, v, 1.1, 0.55, 0.28, 0.06);
  fr.box('f.counter', u, v + 0.08, 0.8, 0.39, 0, 0.28);
  // 小物（本と器）
  fr.box('f.fabric2', u - 0.25, v + 0.16, 0.26, 0.2, 0.34, 0.035);
  fr.cyl('f.white', u + 0.28, v + 0.27, 0.07, 0.34, 0.1, 18);
}

function tvSet(fr: Frame, u: number, v: number, w = 1.8) {
  // 壁付けの浮いた薄いボードと、壁掛けのテレビ（脚や台座を見せない）
  fr.box('f.cabinet', u, v, w, 0.38, 0.28, 0.3);
  fr.box('f.screen', u, v + 0.0, 1.3, 0.035, 0.95, 0.75);
  // ボードの上: 本を 3 冊重ねた束と小さな器（テレビの脇）
  fr.box('f.fabric2', u + w / 2 - 0.22, v + 0.2, 0.24, 0.18, 0.58, 0.022);
  fr.box('f.white', u + w / 2 - 0.2, v + 0.21, 0.2, 0.15, 0.602, 0.02);
  fr.box('f.fabric', u + w / 2 - 0.24, v + 0.19, 0.22, 0.16, 0.622, 0.018);
  fr.cyl('f.white', u - w / 2 + 0.2, v + 0.2, 0.06, 0.58, 0.09, 18);
  plant(fr, u + w / 2 + 0.35, v + 0.3, 1.0);
}

export function plant(fr: Frame, u: number, v: number, scale = 1) {
  // 実物の観葉植物モデル（読み込めない環境では下の簡易形状）
  const p = fr.point(u, v, 0);
  const alt = (Math.sin(p.x * 7.3 + p.z * 3.1) + 1) * 0.5 > 0.55;
  currentModels.push({ id: alt ? 'potted_plant_04' : 'potted_plant_02', pos: p, rotY: Math.sin(u * 12.9898 + v * 4.1) * Math.PI, height: (alt ? 0.95 : 1.15) * scale });
  if (currentPlan) currentPlan.push({ key: 'f.pot', shape: 'circle', cx: p.x, cz: p.z, w: 0, d: 0, ax: 1, az: 0, r: 0.3 * scale, top: 1, roomId: currentRoomId });
  if (modelsAvailable) return;
  fr.cyl('f.pot', u, v, 0.17 * scale, 0, 0.35 * scale, 14);
  fr.box('f.soil', u, v - 0.13 * scale, 0.26 * scale, 0.26 * scale, 0.33 * scale, 0.02);
  const rnd = (i: number) => Math.sin(i * 12.9898 + u * 78.233) * 0.5 + 0.5;
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const r = 0.14 * scale * (0.6 + rnd(i));
    fr.sphere('f.leaf', u + Math.cos(a) * r, v + Math.sin(a) * r, (0.6 + rnd(i + 3) * 0.7) * scale, 0.16 * scale, 0.8);
  }
  fr.sphere('f.leaf', u, v, 1.25 * scale, 0.2 * scale, 0.9);
}

function rug(fr: Frame, u: number, v: number, w: number, d: number) {
  fr.box('f.rug', u, v, w, d, 0.002, 0.012);
}

function diningSet(fr: Frame, u: number, v: number, lights: LightPoint[], roomId: string, ceilingY: number, width?: number) {
  // v = テーブル中心までの距離。無垢の一枚板（厚 4cm）を 2 枚の板脚で受ける、設計事務所らしい端正なテーブル
  const tw = width ?? 1.8;
  const td = 0.9;
  const perSide = tw >= 2.3 ? 3 : 2;
  // 御社の事例: 4 人掛けは丸テーブル（φ1.2、1 本脚）に Y チェア。6 人掛けは一枚板
  const round = vocab.table === 'round' && perSide === 2;
  if (round) {
    const R = Math.min(0.62, Math.max(0.52, tw / 2));
    fr.cyl('f.wood', u, v, R, 0.68, 0.04, 40);
    fr.cyl('f.wood', u, v, 0.055, 0.02, 0.66, 14);
    fr.cyl('f.metal', u, v, 0.3, 0, 0.02, 32);
  } else {
    fr.box('f.wood', u, v - td / 2, tw, td, 0.68, 0.04);
    for (const du of [-tw / 2 + 0.22, tw / 2 - 0.22]) fr.box('f.wood', u + du, v - td / 2 + 0.12, 0.04, td - 0.24, 0, 0.68);
  }
  // 天板の上の小物: 中央に花器（実物モデル）、端に浅い器を 2 つ（写真の「生活感」）
  currentModels.push({ id: 'ceramic_vase_01', pos: fr.point(u + (round ? 0 : 0.12), v, 0.72), rotY: 0.4, height: 0.24 });
  if (!round)
    for (const du of [-tw / 2 + 0.3, tw / 2 - 0.3]) {
      fr.cyl('f.white', u + du, v - 0.08, 0.11, 0.72, 0.012, 20);
      fr.cyl('f.white', u + du, v - 0.08, 0.075, 0.732, 0.04, 20);
    }
  // 椅子: 御社の事例は Y チェア（曲げ木の笠木・Y の背・ペーパーコードの座）。従来は丸脚の軽い木椅子。長いテーブルは 3 脚ずつ
  const pitch = perSide === 3 ? (tw - 0.5) / 2 : 0.9;
  const chairUs = perSide === 3 ? [-pitch, 0, pitch] : round ? [-0.36, 0.36] : [-0.45, 0.45];
  for (const du of chairUs)
    for (const side of [-1, 1]) {
      const cu = u + du;
      const cv = v + side * ((round ? 0.5 : td / 2) + 0.2);
      if (vocab.chair === 'y') {
        yChair(fr, cu, cv, side);
        continue;
      }
      // 座（布）と座枠
      fr.box('f.fabric2', cu, cv - 0.22, 0.43, 0.43, 0.42, 0.045);
      fr.box('f.wood', cu, cv - 0.21, 0.41, 0.41, 0.395, 0.025);
      // 丸脚（わずかに外へ開く）
      for (const lu of [-0.17, 0.17]) for (const lv of [-0.17, 0.17]) fr.cyl('f.wood', cu + lu, cv + lv, 0.013, 0, 0.395, 10);
      // 背: 2 本の丸い支柱と、薄い曲げ板
      for (const lu of [-0.17, 0.17]) fr.cyl('f.wood', cu + lu, cv + side * 0.17, 0.012, 0.395, 0.32, 10);
      fr.box('f.wood', cu, cv + side * 0.17 - 0.012, 0.4, 0.024, 0.6, 0.12);
    }
  // ペンダント: 御社の事例は PH 5 風（白）か黒いドームを 1 灯（長いテーブルは 2 灯）。従来は乳白ガラスの球（実物モデル）を 2〜3 灯
  if (vocab.pendant !== 'globes') {
    const us = tw >= 2.3 && !round ? [-tw / 4, tw / 4] : [0];
    for (const du of us) {
      const y = 1.5;
      pendant(fr, u + du, v, y, ceilingY, vocab.pendant);
      lights.push({ pos: fr.point(u + du, v, y - 0.12), kind: 'pendant', roomId });
    }
    return;
  }
  const n = tw >= 2.3 ? 3 : 2;
  const us = n === 3 ? [-0.62, 0, 0.62] : [-0.42, 0.42];
  for (const du of us) {
    const y = 1.52;
    // 球の直径 ≈ モデルの高さ × 0.4。球が φ25cm ほどになる大きさにし、天井までは細いロッドでつなぐ
    const mh = 0.62;
    const top = y + mh - 0.02;
    currentModels.push({ id: 'modern_ceiling_lamp_01', pos: fr.point(u + du, v, top), rotY: 0, height: mh, anchor: 'top' });
    if (modelsAvailable && ceilingY > top + 0.02) fr.cyl('f.metal', u + du, v, 0.004, top, ceilingY - top, 8);
    if (!modelsAvailable) {
      fr.box('f.metal', u + du, v - 0.004, 0.006, 0.006, y + 0.16, ceilingY - y - 0.16);
      fr.cyl('f.lampShade', u + du, v, 0.11, y, 0.16, 18);
      fr.sphere('f.lamp', u + du, v, y + 0.01, 0.045);
    }
    lights.push({ pos: fr.point(u + du, v, y - 0.1), kind: 'pendant', roomId });
  }
}

/** キッチンの仕上げ（扉が暗い色か）。レンジフードの色（シルバー／ブラック）を扉に合わせるために、組み立て前に設定する */
let kitchenFinish = { dark: false };
export function setKitchenFinish(f: { dark: boolean }) {
  kitchenFinish = f;
}

/** 家具・照明の語彙（テイストごと）。組み立て前に設定する */
let vocab: { pendant: 'ph5' | 'dome' | 'globes'; chair: 'y' | 'light'; table: 'round' | 'plank' } = { pendant: 'globes', chair: 'light', table: 'plank' };
export function setFurnitureVocab(style: { id: string; vocab?: { pendant?: 'ph5' | 'dome' | 'globes'; chair?: 'y' | 'light'; table?: 'round' | 'plank' } }) {
  const hl = style.id.startsWith('hl-');
  vocab = {
    pendant: style.vocab?.pendant ?? (hl ? 'ph5' : 'globes'),
    chair: style.vocab?.chair ?? (hl ? 'y' : 'light'),
    table: style.vocab?.table ?? (hl ? 'round' : 'plank'),
  };
}

/** 天井から吊る照明（御社の事例の語彙）。y = 器具の下端 */
function pendant(fr: Frame, u: number, v: number, y: number, ceilingY: number, kind: 'ph5' | 'dome') {
  const P = (yy: number) => fr.point(u, v, yy);
  if (kind === 'ph5') {
    // PH 5 風: 上の大きな笠（φ50）・中のリング（φ33）・下の小さな笠（φ16）を白で重ね、細いロッドで吊る
    const key = 'f.shade';
    fr.mb.tube(key, P(y + 0.13), P(y + 0.24), 0.25, 0.1, 28);
    fr.mb.tube(key, P(y + 0.07), P(y + 0.12), 0.165, 0.11, 24);
    fr.mb.tube(key, P(y), P(y + 0.05), 0.08, 0.055, 20);
    fr.cyl('f.lamp', u, v, 0.045, y + 0.05, 0.02, 16);
    fr.cyl('f.metal', u, v, 0.004, y + 0.24, Math.max(0.05, ceilingY - y - 0.24), 8);
    fr.cyl('f.metal', u, v, 0.03, ceilingY - 0.015, 0.015, 16);
  } else {
    // 黒いドーム（φ42・高さ 20cm）。内側に温かい光
    const key = 'f.hoodDark';
    fr.mb.tube(key, P(y), P(y + 0.17), 0.21, 0.13, 28);
    fr.cyl(key, u, v, 0.13, y + 0.17, 0.035, 20);
    fr.cyl('f.lamp', u, v, 0.1, y + 0.01, 0.01, 20);
    fr.cyl('f.metal', u, v, 0.005, y + 0.2, Math.max(0.05, ceilingY - y - 0.2), 8);
    fr.cyl('f.metal', u, v, 0.03, ceilingY - 0.015, 0.015, 16);
  }
}

/** Y チェア風の椅子: 丸脚、ペーパーコードの座、半円に曲げた笠木（肘まで）、Y の背 */
function yChair(fr: Frame, cu: number, cv: number, side: number) {
  const W = 0.54;
  const D = 0.5;
  const seatY = 0.43;
  const railY = 0.74;
  // 座（紙紐の編み）と座枠
  fr.box('f.cord', cu, cv - D / 2 + 0.03, W - 0.08, D - 0.08, seatY - 0.02, 0.025);
  fr.box('f.wood', cu, cv - D / 2, W - 0.02, 0.03, seatY - 0.045, 0.03);
  fr.box('f.wood', cu, cv + D / 2 - 0.03, W - 0.02, 0.03, seatY - 0.045, 0.03);
  for (const lu of [-1, 1]) fr.box('f.wood', cu + lu * (W / 2 - 0.025), cv - D / 2, 0.03, D, seatY - 0.045, 0.03);
  // 脚: 後ろ脚は笠木まで伸びる
  for (const lu of [-1, 1]) {
    fr.cyl('f.wood', cu + lu * (W / 2 - 0.035), cv - side * (D / 2 - 0.04), 0.015, 0, seatY - 0.02, 10);
    fr.cyl('f.wood', cu + lu * (W / 2 - 0.035), cv + side * (D / 2 - 0.04), 0.015, 0, railY, 10);
  }
  // 笠木: 後ろから両肘へ回る半円（曲げ木）
  const R = W / 2 - 0.02;
  const n = 9;
  let prev: V3 | null = null;
  for (let k = 0; k <= n; k++) {
    const a = (Math.PI * k) / n;
    const pt = fr.point(cu + Math.cos(a) * R, cv + side * Math.sin(a) * (D / 2 - 0.02), railY);
    if (prev) fr.mb.tube('f.wood', prev, pt, 0.017, 0.017, 8);
    prev = pt;
  }
  // Y の背板: 座の後ろ中央から上へ 1 本、途中で 2 本に分かれて笠木へ
  const b0 = fr.point(cu, cv + side * (D / 2 - 0.03), seatY);
  const b1 = fr.point(cu, cv + side * (D / 2 - 0.02), seatY + 0.13);
  fr.mb.tube('f.wood', b0, b1, 0.014, 0.012, 8);
  for (const lu of [-1, 1]) fr.mb.tube('f.wood', b1, fr.point(cu + lu * 0.07, cv + side * (D / 2 - 0.015), railY - 0.01), 0.012, 0.01, 8);
}

/**
 * LINE KITCHEN（ホームランディックの標準キッチン）。カタログ・プランニングシートの呼び寸法どおりに作る。
 * - 間口 W2290 / 2440 / 2590（シンクキャビネット 750/900/1050 ＋ 食器洗い機 450 ＋ 加熱機器キャビネット 1050）、高さ H850、キャビネット奥行 650
 * - ペニンシュラ・アイランドはカウンタースタイル: 天板 D750（ダイニング側に 100 の持ち出し）、ダイニング側は FIX パネル
 * - 天板 20mm（ステンレス バイブレーション or 扉同色のメラミン）、フラット扉は取っ手なしで天板の下に手掛けの影の線（LINE）
 * - アンダーシンク W800×D435×H190、IH 3 口 W750、浅型食器洗い機 W450、台輪 H100
 * - レンジフード: 壁付け I 型・Ⅱ型は ASR-3A-9027（薄型・壁掛け）、ペニンシュラ・アイランドは天吊りの箱型（TAJIMA FLBT）。色は扉に合わせてシルバー／ブラック
 * - 背面はカップボード フロアタイプ（D450 H850）＋ 吊戸（H600）、端にトール（H2050 D650）のミックスタイプ。冷蔵庫はその並び
 * - Ⅱ型: 壁に加熱機器キャビネット W1840、対面にシンクキャビネット W1840（D750）
 */
/** 本の並び（棚板の上、幅 w の中に背の違う本を詰め、ところどころ空けて小物を置く） */
function books(fr: Frame, u: number, v: number, w: number, d: number, y: number, maxH: number, seed: number) {
  let s = seed * 9301 + 49297;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const keys = ['f.book1', 'f.book2', 'f.book3', 'f.white'];
  let x = u - w / 2 + 0.03;
  const end = u + w / 2 - 0.03;
  // 段の半分ほどだけ本を詰める（ぎっしりより、余白のある飾り方）
  const fillTo = x + (end - x) * (0.45 + rnd() * 0.35);
  while (x < fillTo) {
    const bw = 0.018 + rnd() * 0.025;
    const bh = Math.min(maxH - 0.03, 0.18 + rnd() * 0.12);
    fr.box(keys[Math.floor(rnd() * keys.length)], x + bw / 2, v + 0.02, bw, Math.min(d - 0.04, 0.16 + rnd() * 0.06), y, bh);
    x += bw + 0.002;
  }
  // 残りに器か観葉植物
  if (end - x > 0.25 && maxH > 0.2) {
    if (rnd() > 0.5) fr.cyl('f.white', (x + end) / 2, v + d / 2, 0.06, y, Math.min(maxH - 0.04, 0.16));
    else {
      fr.cyl('f.pot', (x + end) / 2, v + d / 2, 0.06, y, 0.1);
      fr.sphere('f.leaf', (x + end) / 2, v + d / 2, y + 0.16, 0.08, 1.2);
    }
  }
}

/** 造作家具（形は variant）。奥行方向 v = 0 が壁 */
function builtinFurniture(fr: Frame, it: FurnitureItem, ceilingY: number) {
  const variant = it.variant ?? 'wallShelf';
  const b = BUILTIN_VARIANTS[variant];
  const w = it.w ?? b.w;
  const d = it.d ?? b.d;
  const T = 0.025; // 板厚
  const top = Math.min(ceilingY - 0.005, it.h ?? ceilingY);
  /** 縦板で割ったオープン棚（y0〜y1） */
  const openShelves = (y0: number, y1: number, dd: number, pitch = 0.35, seed = 1) => {
    const n = Math.max(1, Math.round(w / 0.75));
    const cw = w / n;
    for (let i = 0; i <= n; i++) fr.box('f.wood', -w / 2 + i * cw, 0, T, dd, y0, y1 - y0);
    const rows = Math.max(1, Math.round((y1 - y0) / pitch));
    const ph = (y1 - y0) / rows;
    for (let r = 0; r <= rows; r++) fr.box('f.wood', 0, 0, w, dd, Math.min(y1 - T, y0 + r * ph), T);
    for (let r = 0; r < rows; r++)
      for (let i = 0; i < n; i++) if ((r + i + seed) % 3 !== 2) books(fr, -w / 2 + (i + 0.5) * cw, 0, cw - T, dd, y0 + r * ph + T, ph - T, seed * 31 + r * 7 + i);
  };
  switch (variant) {
    case 'wallShelf':
      fr.box('f.wood', 0, 0, w, 0.01, 0, top); // 背板
      openShelves(0, top, d, 0.35, 1);
      break;
    case 'shelfDesk': {
      // 天板 H720 の通しカウンター（奥行 d）と、上部のオープン棚（奥行 300）
      fr.box('f.wood', 0, 0, w, d, 0.7, 0.03);
      fr.box('f.wood', -w / 2 + T / 2, 0, T, d, 0, 0.7);
      fr.box('f.wood', w / 2 - T / 2, 0, T, d, 0, 0.7);
      fr.box('f.cabinet', w / 2 - 0.25, 0, 0.45, d - 0.02, 0.0, 0.7);
      openShelves(1.15, top, 0.3, 0.33, 2);
      fr.cyl('f.handle', -w / 4, d * 0.55, 0.015, 0.73, 0.38);
      fr.sphere('f.shade', -w / 4, d * 0.55, 1.13, 0.07, 0.8);
      break;
    }
    case 'floatTv': {
      // 床から浮かせた箱（H250〜600）、上部に浮き棚 2 段、テレビ
      fr.box('f.cabinet', 0, 0, w, d, 0.25, 0.35);
      fr.box('f.handle', 0, d - 0.003, w - 0.02, 0.006, 0.57, 0.01);
      for (let k = 1; k < 3; k++) fr.box('f.handle', -w / 2 + (w / 3) * k, d - 0.003, 0.004, 0.006, 0.27, 0.3);
      fr.box('f.screen', 0, 0.12, Math.min(1.45, w * 0.6), 0.04, 0.85, 0.82);
      for (const y of [1.85, 2.15]) if (y < top - 0.1) {
        fr.box('f.wood', -w / 2 + 0.35, 0, 0.6, 0.22, y, 0.03);
        books(fr, -w / 2 + 0.35, 0, 0.56, 0.22, y + 0.03, 0.24, y * 10);
      }
      break;
    }
    case 'openShelf':
      for (const [i, y] of [1.1, 1.45, 1.8].entries()) {
        fr.box('f.wood', 0, 0, w, d, y, 0.035);
        books(fr, 0, 0, w, d, y + 0.035, 0.3, i + 5);
      }
      break;
    case 'bench':
      fr.box('f.cabinet', 0, 0, w, d, 0.06, 0.34);
      fr.box('int.shadowGap', 0, 0.04, w - 0.08, d - 0.08, 0, 0.06);
      fr.box('f.fabric', 0, 0.02, w - 0.04, d - 0.04, 0.4, 0.05);
      for (const du of [-w / 3, w / 3]) fr.box('f.fabric2', du, 0.02, 0.45, 0.14, 0.45, 0.38);
      break;
    case 'counter':
      fr.box('f.wood', 0, 0, w, d, 0.7, 0.03);
      for (const du of [-w / 2 + 0.1, w / 2 - 0.1]) fr.box('f.metal', du, 0, 0.02, d - 0.05, 0.62, 0.08);
      fr.box('f.cabinet', w / 2 - 0.25, 0, 0.45, d - 0.02, 0, 0.62);
      break;
    case 'tallStorage': {
      const n = Math.max(2, Math.round(w / 0.6));
      fr.box('int.shadowGap', 0, 0.04, w - 0.04, d - 0.06, 0, 0.06);
      fr.box('int.door', 0, 0, w, d, 0.06, top - 0.06);
      for (let k = 1; k < n; k++) fr.box('f.handle', -w / 2 + (w / n) * k, d - 0.002, 0.004, 0.004, 0.08, top - 0.12);
      fr.box('f.handle', 0, d - 0.002, w - 0.01, 0.004, 0.95, 0.004);
      break;
    }
    case 'lowShelf':
      fr.box('f.wood', 0, 0, w, d, 0.88, 0.03);
      openShelves(0.0, 0.88, d, 0.42, 3);
      break;
  }
}

function kitchen(fr: Frame, len: number, ceilingY: number, opt: Pick<FurnitureItem, 'kitchenType' | 'stoveSide' | 'fridge' | 'hood' | 'd'> = {}) {
  const type = opt.kitchenType ?? 'peninsula';
  const stoveSign = (opt.stoveSide ?? 'right') === 'right' ? 1 : -1;
  const fridge = opt.fridge ?? 'right';
  const hood = opt.hood !== false;
  const hoodKey = kitchenFinish.dark ? 'f.hoodDark' : 'f.hoodSilver';
  const H = 0.85;
  const TOP = 0.02;
  const KICK = 0.1;
  const D = 0.65;
  /** 手掛けの影の線・扉の目地（扉面から 3mm 出した細い黒い帯） */
  const lineH = (u: number, v: number, w: number, y: number, h: number, dir: 1 | -1) => fr.box('f.handle', u, dir > 0 ? v - 0.003 : v - 0.009, w, 0.012, y, h);
  /**
   * キャビネット本体: 台輪（奥に引く）・箱・天板・手掛けの線・扉の目地。
   * front = 扉の面がある側（+1: 室内側 v+d, -1: 壁側 v）。sections = 扉の割り（幅と引出し段数）。topD = 天板の奥行（持ち出し分を含む）
   */
  const cabinet = (u: number, v: number, w: number, d: number, sections: { w: number; rows: number }[], front: 1 | -1, topD = d, topShift = 0) => {
    fr.box('int.shadowGap', u, v + 0.04, w - 0.08, d - 0.08, 0, KICK);
    fr.box('f.cabinet', u, v, w, d, KICK, H - KICK - TOP);
    fr.box('f.counter', u, v + topShift, w, topD, H - TOP, TOP);
    const face = front > 0 ? v + d : v;
    // 手掛け（天板のすぐ下、間口いっぱい）
    lineH(u, face, w - 0.02, H - TOP - 0.03, 0.022, front);
    // 扉の割り: 縦目地と引出しの段
    let x = u - w / 2 + 0.02;
    sections.forEach((sec, i) => {
      if (i > 0) fr.box('f.handle', x, front > 0 ? face - 0.003 : face - 0.009, 0.004, 0.012, KICK + 0.01, H - KICK - TOP - 0.05);
      const body = H - KICK - TOP - 0.03;
      for (let r = 1; r < sec.rows; r++) {
        // 1 段目は浅い引出し（天板下 170）、残りを等分
        const y = r === 1 ? H - TOP - 0.03 - 0.17 : KICK + ((body - 0.17) * (sec.rows - r)) / (sec.rows - 1);
        lineH(x + sec.w / 2, face, sec.w - 0.01, y, 0.006, front);
      }
      x += sec.w;
    });
  };
  /** 間口の呼称と扉の割り（右シンクのとき左から: シンク / 食器洗い機 / 加熱機器） */
  const sizing = (avail: number) => {
    const W = avail >= 2.65 ? 2.59 : avail >= 2.5 ? 2.44 : 2.29;
    const sinkW = W === 2.59 ? 1.05 : W === 2.44 ? 0.9 : 0.75;
    const secs = [
      { w: sinkW, rows: 2 },
      { w: 0.45, rows: 1 },
      { w: 1.05, rows: 3 },
    ];
    return { W, secs: stoveSign > 0 ? secs : secs.slice().reverse(), sinkU: stoveSign * -(W / 2 - sinkW / 2), stoveU: stoveSign * (W / 2 - 0.525) };
  };
  /** アンダーシンク（天板に穴を開け、ステンレスの槽を下げる）と水栓 */
  const sink = (u: number, v: number, topD: number, faucetV: number) => {
    const sw = 0.8;
    const sd = 0.435;
    // 槽（ステンレス）: 天板より 10mm 下から H190
    fr.box('f.stainless', u, v + (topD - sd) / 2, sw, sd, H - 0.2, 0.19);
    fr.box('f.carcass', u, v + (topD - sd) / 2 + 0.01, sw - 0.02, sd - 0.02, H - 0.19, 0.17);
    // 水栓（グースネック・クローム）
    fr.cyl('f.chrome', u + 0.3, faucetV, 0.016, H, 0.3, 12);
    fr.box('f.chrome', u + 0.3, faucetV - 0.1, 0.03, 0.2, H + 0.28, 0.025);
    fr.cyl('f.chrome', u + 0.3, faucetV - 0.19, 0.012, H + 0.17, 0.12, 10);
  };
  /** IH 3 口（黒ガラス、天板に落とし込み） */
  const ih = (u: number, v: number, topD: number) => {
    fr.box('f.screen', u, v + (topD - 0.52) / 2, 0.75, 0.52, H - 0.002, 0.006);
    for (const du of [-0.2, 0.2]) fr.cyl('f.handle', u + du, v + topD / 2 + 0.08, 0.09, H + 0.004, 0.001, 20);
    fr.cyl('f.handle', u, v + topD / 2 - 0.1, 0.08, H + 0.004, 0.001, 20);
  };
  /** 壁掛けの薄型フード（御社の事例: 横長の薄い箱 W900 D480 H110、ダクトは壁・天井内で見せない。黒が基本） */
  const wallHood = (u: number) => {
    fr.box(hoodKey, u, 0.02, 0.9, 0.48, 1.58, 0.11);
    fr.box(hoodKey, u, 0.02, 0.86, 0.3, 1.69, 0.02);
  };
  /** 天吊りの箱型フード（ペニンシュラ・アイランド: W900 D500 H220 の薄い箱＋細いダクトカバー。黒） */
  const ceilingHood = (u: number, v: number) => {
    fr.box(hoodKey, u, v - 0.25, 0.9, 0.5, 1.66, 0.22);
    fr.box(hoodKey, u, v - 0.11, 0.22, 0.22, 1.88, Math.max(0.05, ceilingY - 1.88));
  };
  /** 小物: 黒いトレーと器、細い一輪挿し */
  const props = (u: number, v: number) => {
    fr.box('f.handle', u - 0.1 * stoveSign, v, 0.4, 0.26, H, 0.015);
    fr.cyl('f.white', u - 0.14 * stoveSign, v, 0.065, H + 0.015, 0.08);
    fr.cyl('f.white', u + 0.02 * stoveSign, v + 0.02, 0.04, H + 0.015, 0.12);
    fr.cyl('f.white', u + 0.45 * stoveSign, v, 0.03, H, 0.24);
    fr.sphere('f.leaf', u + 0.45 * stoveSign, v, H + 0.34, 0.05, 1.5);
  };
  /** 冷蔵庫（扉面が平らな W680 D700 H1820） */
  const fridgeBox = (u: number) => {
    fr.box('f.fridge', u, 0.02, 0.68, 0.7, 0, 1.82);
    fr.box('f.handle', u - 0.3, 0.72, 0.012, 0.012, 0.95, 0.5);
  };
  /**
   * 背面収納: カップボード フロアタイプ（D450 H850）＋吊戸（D350 H600 上端 2050）、冷蔵庫と反対の端にトール（D650 H2050）
   * wallW = 使える壁の長さ。冷蔵庫は fridge の側の端
   */
  const backStorage = (wallW: number, withTall = true) => {
    const fw = fridge === 'none' ? 0 : 0.72;
    const tallW = withTall ? 0.9 : 0;
    const cupW = Math.max(0.9, Math.min(2.74, wallW - fw - tallW));
    const fSign = fridge === 'right' ? 1 : -1;
    const x0 = -wallW / 2;
    // 並び（左から）: 冷蔵庫が左なら 冷蔵庫 / カップボード / トール、右なら トール / カップボード / 冷蔵庫
    const order = fSign < 0 ? ['fridge', 'cup', 'tall'] : ['tall', 'cup', 'fridge'];
    let x = x0 + (wallW - fw - tallW - cupW) / 2;
    for (const part of order) {
      if (part === 'fridge' && fw) {
        fridgeBox(x + fw / 2);
        x += fw;
      } else if (part === 'cup') {
        const n = Math.max(2, Math.round(cupW / 0.9));
        const secs = Array.from({ length: n }, () => ({ w: cupW / n, rows: 2 }));
        cabinet(x + cupW / 2, 0.02, cupW, 0.45, secs, 1);
        // 吊戸（扉同材、取っ手なし）
        fr.box('f.cabinet', x + cupW / 2, 0.02, cupW, 0.35, 1.45, 0.6);
        lineH(x + cupW / 2, 0.37, cupW - 0.02, 1.47, 0.02, 1);
        for (let k = 1; k < n; k++) fr.box('f.handle', x + (cupW / n) * k, 0.37 - 0.003, 0.004, 0.012, 1.5, 0.5);
        x += cupW;
      } else if (part === 'tall' && tallW) {
        fr.box('int.shadowGap', x + tallW / 2, 0.06, tallW - 0.08, 0.57, 0, KICK);
        fr.box('f.cabinet', x + tallW / 2, 0.02, tallW, 0.65, KICK, 2.05 - KICK);
        fr.box('f.handle', x + tallW / 2, 0.67 - 0.003, 0.004, 0.012, 0.15, 1.85);
        lineH(x + tallW / 2, 0.67, tallW - 0.02, 1.0, 0.012, 1);
        x += tallW;
      }
    }
  };

  if (type === 'wall') {
    // 壁付け I 型: 壁沿いにキッチン、その端に冷蔵庫。吊戸は加熱機器側がフィラー
    const fw = fridge === 'none' ? 0 : 0.72;
    const { W, secs, sinkU, stoveU } = sizing(Math.min(len - 0.3, 3.2) - fw);
    const cu = fridge === 'none' ? 0 : (fridge === 'right' ? -1 : 1) * (fw / 2);
    cabinet(cu, 0.02, W, D, secs, 1);
    sink(cu + sinkU, 0.02, D, 0.02 + 0.08);
    ih(cu + stoveU, 0.02, D);
    // 吊戸はシンク側だけ。加熱機器の上は壁を見せて薄型フードだけ（御社の事例: フードの周りに箱を付けない）
    const upW = W - 1.05 - 0.08;
    if (upW >= 0.6) {
      const uc = cu - stoveSign * ((1.05 + 0.08) / 2);
      fr.box('f.cabinet', uc, 0.02, upW, 0.35, 1.45, 0.6);
      lineH(uc, 0.37, upW - 0.02, 1.47, 0.02, 1);
    }
    if (hood) wallHood(cu + stoveU);
    if (fw) fridgeBox(cu + (fridge === 'right' ? 1 : -1) * (W / 2 + fw / 2));
    props(cu, 0.02 + D - 0.2);
    return;
  }
  const wallW = Math.min(len - 0.3, 3.4);
  if (type === 'l') {
    // L 型: 壁沿いにシンク（吊戸つき）、コンロ側の端から袖（D650）を部屋側へ伸ばして加熱機器
    const legL = opt.d ? Math.max(1.5, Math.min(2.8, opt.d)) : 2.1;
    const W = Math.min(wallW, 2.75);
    const cu = 0;
    const legU = cu + stoveSign * (W / 2 - D / 2);
    // 壁側（シンク）: 袖と重なる角は袖が受ける
    const mainW = W - D;
    const mainU = cu - stoveSign * (D / 2);
    const n = Math.max(2, Math.round(mainW / 0.6));
    cabinet(mainU, 0.02, mainW, D, Array.from({ length: n }, (_, i) => ({ w: mainW / n, rows: i === 0 ? 2 : 3 })), 1);
    sink(mainU - stoveSign * (mainW / 2 - 0.55), 0.02, D, 0.02 + 0.08);
    fr.box('f.cabinet', mainU, 0.02, mainW, 0.35, 1.45, 0.6);
    lineH(mainU, 0.37, mainW - 0.02, 1.47, 0.02, 1);
    // 袖（角から部屋側へ）: 扉は内側（シンク側）
    fr.box('int.shadowGap', legU, 0.06, D - 0.08, legL - 0.08, 0, KICK);
    fr.box('f.cabinet', legU, 0.02, D, legL, KICK, H - KICK - TOP);
    fr.box('f.counter', legU, 0.02, D, legL, H - TOP, TOP);
    fr.box('f.handle', legU - stoveSign * (D / 2 + 0.003), 0.04, 0.012, legL - 0.06, H - TOP - 0.05, 0.022);
    const ihV = 0.02 + Math.min(legL - 0.45, 1.05);
    fr.box('f.screen', legU, ihV - 0.375, 0.52, 0.75, H - 0.002, 0.006);
    for (const dv of [-0.2, 0.2]) fr.cyl('f.handle', legU + 0.08 * stoveSign, ihV + dv, 0.09, H + 0.004, 0.001, 20);
    if (hood) {
      fr.box(hoodKey, legU, ihV - 0.45, 0.5, 0.9, 1.66, 0.22);
      fr.box(hoodKey, legU, ihV - 0.11, 0.22, 0.22, 1.88, Math.max(0.05, ceilingY - 1.88));
    }
    if (fridge !== 'none') fridgeBox(cu - stoveSign * (W / 2 + 0.36));
    props(mainU, 0.02 + D - 0.2);
    return;
  }
  if (type === 'two') {
    // Ⅱ型: 壁に加熱機器キャビネット W1840、対面にシンクキャビネット W1840（カウンタースタイル D750）
    const su = stoveSign * (wallW / 2 - 0.92);
    cabinet(su, 0.02, 1.84, D, [{ w: 0.9, rows: 3 }, { w: 0.9, rows: 3 }], 1);
    ih(su, 0.02, D);
    if (hood) wallHood(su);
    // 壁の残りにカップボードと冷蔵庫
    const restW = wallW - 1.84 - 0.05;
    if (restW >= 1.2) {
      const rc = -stoveSign * (wallW / 2 - restW / 2);
      const fw = fridge === 'none' ? 0 : 0.72;
      const cupW = Math.max(0.6, restW - fw);
      const fridgeFirst = (fridge === 'right' ? 1 : -1) === stoveSign ? false : true;
      const cx = rc + (fridgeFirst ? 1 : -1) * stoveSign * (fw / 2);
      cabinet(cx, 0.02, cupW, 0.45, [{ w: cupW / 2, rows: 2 }, { w: cupW / 2, rows: 2 }], 1);
      fr.box('f.cabinet', cx, 0.02, cupW, 0.35, 1.45, 0.6);
      lineH(cx, 0.37, cupW - 0.02, 1.47, 0.02, 1);
      if (fw) fridgeBox(rc - (fridgeFirst ? 1 : -1) * stoveSign * (cupW / 2));
    }
    const cv = opt.d ? Math.max(1.3, Math.min(2.6, opt.d)) : 0.65 + 1.0 + 0.325;
    cabinet(su, cv - D / 2, 1.84, D, [{ w: 1.0, rows: 2 }, { w: 0.84, rows: 1 }], -1, 0.75, 0.05);
    sink(su - stoveSign * 0.3, cv - D / 2 + 0.1, 0.65, cv + 0.3);
    props(su + stoveSign * 0.5, cv + 0.1);
    return;
  }
  // ペニンシュラ・アイランド: 背面収納 ＋ 対面のキッチン（カウンタースタイル D750）
  backStorage(wallW, true);
  const { W, secs, sinkU, stoveU } = sizing(Math.min(len - 0.4, 3.0));
  const cv = opt.d ? Math.max(1.3, Math.min(2.6, opt.d)) : 0.45 + 1.0 + 0.325;
  // 扉はキッチン側（壁向き）、天板はダイニング側へ 100 持ち出し
  cabinet(0, cv - D / 2, W, D, secs, -1, 0.75, 0.05);
  sink(sinkU, cv - D / 2 + 0.1, 0.65, cv + 0.3);
  ih(stoveU, cv - D / 2, D);
  if (hood) ceilingHood(stoveU, cv);
  props(0, cv + 0.12);
}

function layoutLDK(ctx: RoomCtx, model: BuildingModel, f: Floor) {
  const { R } = ctx;
  const W = R.maxX - R.minX;
  const D = R.maxZ - R.minZ;
  const ceilingY = f.ceilingHeight * MM;
  const winSide = (Object.entries(ctx.windows) as [Side, number][]).sort((a, b) => b[1] - a[1])[0][0];
  const longX = W >= D;
  const winParallelLong = (winSide === 'n' || winSide === 's') === longX;
  // 水回り（家事動線: 洗面 > 浴室 > トイレ）に近い側にキッチン
  const cx0 = (R.minX + R.maxX) / 2;
  const cz0 = (R.minZ + R.maxZ) / 2;
  const wetRooms = ['washroom', 'bath', 'toilet']
    .map((t) => f.rooms.filter((r) => r.type === t))
    .find((l) => l.length) ?? [];
  const wetC = wetRooms.length
    ? wetRooms
        .map((r) => ({ x: r.labelPos.x * MM, y: r.labelPos.y * MM }))
        .sort((a, b) => Math.hypot(a.x - cx0, a.y - cz0) - Math.hypot(b.x - cx0, b.y - cz0))[0]
    : null;
  // 並べる方向（K→D→L）
  let kSide: Side;
  if (winParallelLong) {
    if (longX) kSide = wetC && wetC.x > (R.minX + R.maxX) / 2 ? 'e' : 'w';
    else kSide = wetC && wetC.y > (R.minZ + R.maxZ) / 2 ? 's' : 'n';
  } else {
    kSide = opposite[winSide];
  }
  if (ctx.planKitchen) kSide = sideOfRot(ctx.planKitchen.rot);
  const total = kSide === 'e' || kSide === 'w' ? W : D;
  const kDepth = total >= 6.5 ? 2.5 : 2.3;
  const dDepth = total >= 6.5 ? 2.4 : 2.1;
  const { f: kf, len: klen } = sideFrame(ctx, kSide);
  // 図面にキッチン・ダイニングがあるときは、それらが矩形の中でどこまで占めているかを測って居間の余地を出す。
  // L 字の LDK では図面のキッチンが矩形の外（袖の部分）にあることが多く、以前は「K → D → L が矩形に収まらない」と
  // 判定して 29 帖の LDK にソファが無かった
  let livStartPlan: number | null = null;
  if (ctx.planKitchen || ctx.has.has('dining')) {
    let used = 0;
    for (const o of currentOcc ?? []) {
      const corners = [V(o.minX, 0, o.minZ), V(o.maxX, 0, o.minZ), V(o.minX, 0, o.maxZ), V(o.maxX, 0, o.maxZ)];
      const inAlong = corners.some((c) => Math.abs(c.clone().sub(kf.origin).dot(kf.along)) <= klen / 2 + 0.3);
      if (!inAlong) continue;
      for (const c of corners) used = Math.max(used, c.clone().sub(kf.origin).dot(kf.inward));
    }
    livStartPlan = Math.min(total, Math.max(0, used + 0.5));
  }
  const hasLiving = (livStartPlan != null ? total - livStartPlan : total - kDepth - dDepth) >= 2.4 && ctx.room.type !== 'dining' && ctx.room.type !== 'kitchen';
  // キッチン（I 型でも間口 1.8m・通路込みの奥行 2m）が収まらない区画は、読み違いの小部屋なので何も置かない
  // （以前は間口 0.8m の区画にも背面収納ごとキッチンを置き、冷蔵庫・トール収納が壁を突き抜けていた）
  if (!ctx.planKitchen && (klen < 1.8 || total < 2.0)) return;
  // 居間・食堂だけの部屋（プレイルーム・セカンドリビングなど）は、家にキッチン・LDK が別にあればキッチンを置かない
  const kitchenElsewhere = ctx.room.type !== 'ldk' && ctx.room.type !== 'kitchen' && model.floors.some((fl) => fl.rooms.some((r) => r !== ctx.room && (r.type === 'ldk' || r.type === 'kitchen')));
  if (!ctx.has.has('kitchen') && !kitchenElsewhere) place('kitchen', kf, 0, 0, ctx.env, { len: +klen.toFixed(2) });
  // ダイニング
  if (!ctx.has.has('dining')) place('dining', kf, 0, kDepth + dDepth / 2, ctx.env);
  if (!hasLiving) return;
  // 図面にソファがあればリビングの配置はそのまま。周りにラグ・ローテーブル・観葉植物・テレビ台を補って生活感を出す
  if (ctx.has.has('sofa')) {
    dressLiving(ctx);
    ctx.lights.push({ pos: kf.point(0, kDepth + dDepth + (total - kDepth - dDepth) / 2, ceilingY - 0.02), kind: 'ceiling', roomId: ctx.room.id });
    return;
  }
  // リビング: 反対側の壁 or 窓のない長辺
  const livStart = livStartPlan ?? kDepth + dDepth;
  const livDepth = total - livStart;
  const endSide = opposite[kSide];
  const { f: ef, len: elen } = sideFrame(ctx, endSide);
  const tvU = findSpot(ctx, endSide, 2.0, elen, 0);
  if (tvU != null && livDepth >= 3.2) {
    place('tv', ef, tvU, 0.02, ctx.env, { w: 1.8 });
    const sofaV = Math.min(livDepth - 1.0, 3.0);
    place('rug', ef, tvU, 0.9, ctx.env, { w: 2.2, d: +Math.max(1.4, sofaV - 0.7).toFixed(2) });
    place('coffeeTable', ef, tvU, 1.2, ctx.env);
    // ソファは TV を向く（反対向きのフレーム）
    const back = new Frame(ctx.mb, ef.point(tvU, sofaV + 0.9, 0), ef.along.clone().negate(), ef.inward.clone().negate());
    place('sofa', back, 0, 0, ctx.env, { w: 2.1 });
    place('plant', ef, -elen / 2 + 0.35, 0.35, ctx.env, { w: 1.1 });
    // ラウンジチェア（ソファの横で TV・ソファの方を向く）
    const chairU = tvU + 1.75;
    if (Math.abs(chairU) < elen / 2 - 0.5 && isFree(ctx, endSide, chairU - 0.45, chairU + 0.45)) {
      const cp = ef.point(chairU, Math.max(1.4, sofaV - 0.6), 0);
      const toward = ef.point(tvU, sofaV * 0.5, 0).sub(cp).setY(0).normalize();
      // チェアの向き（inward）を TV・ソファの方へ
      place('chair', new Frame(ctx.mb, cp, V(toward.z, 0, -toward.x), toward), 0, 0, ctx.env);
    }
    ctx.lights.push({ pos: ef.point(tvU, livDepth / 2, ceilingY - 0.02), kind: 'ceiling', roomId: ctx.room.id });
    return;
  }
  // 窓のない長辺に TV を置き、ソファは向かい（窓側）
  const sides: Side[] = kSide === 'e' || kSide === 'w' ? ['n', 's'] : ['w', 'e'];
  const tvSide = sides.sort((a, b) => ctx.windows[a] - ctx.windows[b])[0];
  const { f: tf, len: tlen } = sideFrame(ctx, tvSide);
  // リビング域の中心（tf の u 座標）
  const kfCenterToLiv = kf.point(0, livStart + livDepth / 2, 0);
  const uLiv = kfCenterToLiv.clone().sub(tf.origin).dot(tf.along);
  const tvU2 = findSpot(ctx, tvSide, 1.9, tlen, uLiv) ?? uLiv;
  place('tv', tf, tvU2, 0.02, ctx.env, { w: 1.8 });
  const across = tvSide === 'n' || tvSide === 's' ? D : W;
  const sofaV = Math.min(across - 1.0, 2.8);
  place('rug', tf, tvU2, 0.9, ctx.env, { w: 2.2, d: +Math.max(1.4, sofaV - 0.7).toFixed(2) });
  place('coffeeTable', tf, tvU2, 1.25, ctx.env);
  const back = new Frame(ctx.mb, tf.point(tvU2, sofaV + 0.9, 0), tf.along.clone().negate(), tf.inward.clone().negate());
  place('sofa', back, 0, 0, ctx.env, { w: 2.1 });
  ctx.lights.push({ pos: tf.point(tvU2, across / 2, ceilingY - 0.02), kind: 'ceiling', roomId: ctx.room.id });
  void model;
}

/** 図面どおりに置いたソファの周りを整える: ラグ・ローテーブル・観葉植物、向かいの壁にテレビ台 */
function dressLiving(ctx: RoomCtx) {
  const sofas = ctx.planSofas ?? [];
  if (!sofas.length) return;
  const { R } = ctx;
  const s = [...sofas].sort((a, b) => (b.w ?? 2.1) - (a.w ?? 2.1))[0];
  const w = s.w ?? 2.1;
  const r = s.rot / DEG;
  const fr = new Frame(ctx.mb, V(s.x * MM, ctx.y, s.y * MM), V(Math.cos(r), 0, Math.sin(r)), V(-Math.sin(r), 0, Math.cos(r)));
  // ソファの正面（v = 0.9）から部屋の内側の矩形の縁までの距離
  const front = fr.point(0, 0.9, 0);
  const dir = fr.inward;
  const hit = (lim: number, p: number, d: number) => (Math.abs(d) < 1e-6 ? Infinity : (lim - p) / d);
  const depth = Math.min(...[hit(R.maxX, front.x, dir.x), hit(R.minX, front.x, dir.x), hit(R.maxZ, front.z, dir.z), hit(R.minZ, front.z, dir.z)].filter((t) => t > 0));
  // 置き場所が空いているか（部屋の矩形の内側で、置いた家具と重ならない）。ラグは除く
  const free = (u: number, v: number, fw: number, fd: number) => {
    const c = fr.point(u, v, 0);
    const ex = Math.abs(fr.along.x) * fw / 2 + Math.abs(fr.inward.x) * fd / 2;
    const ez = Math.abs(fr.along.z) * fw / 2 + Math.abs(fr.inward.z) * fd / 2;
    if (c.x - ex < R.minX || c.x + ex > R.maxX || c.z - ez < R.minZ || c.z + ez > R.maxZ) return false;
    return !(currentOcc ?? []).some((o) => o.minX < c.x + ex && o.maxX > c.x - ex && o.minZ < c.z + ez && o.maxZ > c.z - ez);
  };
  // ラグ: ソファの前半分から前へ 2m（手前の空きに合わせて縮める）
  if (!ctx.has.has('rug') && depth >= 1.2) {
    const rd = +Math.min(2.0, depth + 0.35).toFixed(2);
    place('rug', fr, 0, 0.55 + rd / 2, ctx.env, { w: +Math.max(2.0, w + 0.4).toFixed(2), d: rd });
  }
  // ローテーブル: 正面 0.75m 先
  if (!ctx.has.has('coffeeTable') && depth >= 2.0 && free(0, 1.65, 1.0, 1.0)) place('coffeeTable', fr, 0, 1.65, ctx.env);
  // 観葉植物: ソファの脇（空いている側）
  if (!ctx.has.has('plant')) {
    for (const side of [1, -1]) {
      const u = side * (w / 2 + 0.55);
      if (free(u, 0.35, 0.7, 0.7)) {
        place('plant', fr, u, 0.35, ctx.env, { w: 1.0 });
        break;
      }
    }
  }
  // テレビ台: ソファが向く壁（2.4〜5.5m 先）に、開口と家具を避けて
  if (!ctx.has.has('tv') && depth >= 2.4 - 0.9 && depth <= 5.5) {
    const tvSide = opposite[sideOfRot(s.rot)];
    const { f: tf, len: tlen } = sideFrame(ctx, tvSide);
    const u = fr.point(0, 0, 0).sub(tf.origin).dot(tf.along);
    if (Math.abs(u) < tlen / 2 - 1.0 && isFree(ctx, tvSide, u - 1.0, u + 1.0)) {
      const c = tf.point(u, 0.25, 0);
      const ex = Math.abs(tf.along.x) * 0.95 + Math.abs(tf.inward.x) * 0.25;
      const ez = Math.abs(tf.along.z) * 0.95 + Math.abs(tf.inward.z) * 0.25;
      if (!(currentOcc ?? []).some((o) => o.minX < c.x + ex && o.maxX > c.x - ex && o.minZ < c.z + ez && o.maxZ > c.z - ez)) place('tv', tf, u, 0.02, ctx.env, { w: 1.8 });
    }
  }
}

function bed(fr: Frame, u: number, v: number, w: number) {
  const L = 2.0;
  fr.box('f.wood', u, v, w + 0.06, L + 0.04, 0.08, 0.22);
  fr.box('f.wood', u, v - 0.04, w + 0.06, 0.06, 0.08, 0.85); // ヘッドボード
  fr.box('f.bedding', u, v + 0.02, w, L, 0.3, 0.2);
  fr.box('f.fabric2', u, v + 0.75, w + 0.02, L - 0.72, 0.48, 0.05); // 掛け布団
  fr.box('f.fabric2', u, v + 1.75, w + 0.04, 0.3, 0.3, 0.2);
  // 足元に畳んだスロー（濃い色の布）を掛ける（写真の「生活感」。真っ平らな掛け布団だけだと展示場のベッドに見える）
  fr.box('f.fabric', u, v + 1.4, w + 0.08, 0.55, 0.53, 0.035);
  fr.box('f.fabric', u, v + 1.4, w + 0.08, 0.3, 0.565, 0.02);
  const np = w > 1.2 ? 2 : 1;
  for (let i = 0; i < np; i++) {
    const pu = np === 2 ? u + (i === 0 ? -w / 4 : w / 4) : u;
    fr.box('f.bedding', pu, v + 0.1, np === 2 ? w / 2 - 0.1 : w - 0.2, 0.4, 0.5, 0.12);
  }
}

function nightstand(fr: Frame, u: number, v: number, lights: LightPoint[], roomId: string) {
  fr.box('f.wood', u, v, 0.45, 0.4, 0, 0.5);
  fr.cyl('f.metal', u, v + 0.2, 0.06, 0.5, 0.02);
  fr.cyl('f.metal', u, v + 0.2, 0.01, 0.52, 0.3);
  fr.cyl('f.lampShade', u, v + 0.2, 0.12, 0.72, 0.2);
  // 読みかけの本とカップ
  fr.box('f.fabric2', u - 0.1, v - 0.05, 0.17, 0.13, 0.5, 0.022);
  fr.box('f.white', u - 0.1, v - 0.05, 0.15, 0.11, 0.522, 0.012);
  fr.cyl('f.white', u + 0.14, v - 0.08, 0.035, 0.5, 0.07, 16);
  lights.push({ pos: fr.point(u, v + 0.2, 0.8), kind: 'lamp', roomId });
}

function layoutBedroom(ctx: RoomCtx, big: boolean) {
  const { R } = ctx;
  const W = R.maxX - R.minX;
  const D = R.maxZ - R.minZ;
  const bw = big ? (Math.min(W, D) > 3.2 ? 1.6 : 1.4) : 1.0;
  // 窓の少ない壁から順に試す（ナイトテーブル付き → ベッドのみ の順）
  const order = (['n', 's', 'e', 'w'] as Side[]).sort((a, b) => ctx.windows[a] - ctx.windows[b]);
  let placed: { s: Side; f: Frame; len: number; u: number; depth: number; withStands: boolean } | null = null;
  for (const withStands of big ? [true, false] : [false]) {
    for (const s of order) {
      const { f, len } = sideFrame(ctx, s);
      const depth = s === 'n' || s === 's' ? D : W;
      if (depth < 2.5) continue;
      const u = findSpot(ctx, s, withStands ? bw + 1.0 : bw + 0.1, len, 0);
      if (u == null) continue;
      placed = { s, f, len, u, depth, withStands };
      break;
    }
    if (placed) break;
  }
  if (ctx.has.has('bed')) placed = null;
  if (placed) {
    const { s, f, u, depth } = placed;
    place('bed', f, u, 0.02, ctx.env, { w: bw });
    if (placed.withStands) {
      place('nightstand', f, u - bw / 2 - 0.3, 0.02, ctx.env);
      place('nightstand', f, u + bw / 2 + 0.3, 0.02, ctx.env);
    }
    place('rug', f, u, 0.9, ctx.env, { w: +(bw + 0.9).toFixed(2), d: 1.6 });
    // 机（子ども室・小さい部屋）
    if (!big) {
      const other = opposite[s];
      const { f: of, len: olen } = sideFrame(ctx, other);
      const du = findSpot(ctx, other, 1.1, olen, 0);
      if (du != null && depth > 3.0) place('desk', of, du, 0.02, ctx.env);
    } else {
      const { f: of, len: olen } = sideFrame(ctx, opposite[s]);
      const du = findSpot(ctx, opposite[s], 1.2, olen, olen / 4);
      if (du != null && depth > 3.4) {
        place('cabinet', of, du, 0.02, ctx.env);
        place('plant', of, du + 0.9, 0.3, ctx.env, { w: 0.8 });
      }
    }
    return;
  }
}

function desk(fr: Frame, u: number, v: number) {
  fr.box('f.wood', u, v, 1.0, 0.55, 0.7, 0.03);
  fr.box('f.wood', u - 0.48, v, 0.03, 0.55, 0, 0.7);
  fr.box('f.wood', u + 0.48, v, 0.03, 0.55, 0, 0.7);
  fr.box('f.screen', u, v + 0.08, 0.55, 0.03, 0.73, 0.34);
  fr.box('f.fabric2', u, v + 0.75, 0.45, 0.45, 0.42, 0.08);
  fr.box('f.fabric2', u, v + 0.95, 0.45, 0.06, 0.5, 0.45);
  fr.cyl('f.metal', u, v + 0.75, 0.03, 0, 0.42);
}

function layoutStudy(ctx: RoomCtx) {
  const order = (['n', 's', 'e', 'w'] as Side[]).sort((a, b) => ctx.windows[b] - ctx.windows[a]);
  for (const s of order) {
    const { f, len } = sideFrame(ctx, s);
    const u = findSpot(ctx, s, 1.1, len, 0);
    if (u == null) continue;
    place('desk', f, u, 0.02, ctx.env);
    const o = opposite[s];
    const { f: of, len: olen } = sideFrame(ctx, o);
    const su = findSpot(ctx, o, 0.9, olen, 0);
    if (su != null) place('bookshelf', of, su, 0.02, ctx.env);
    return;
  }
}

function layoutJapanese(ctx: RoomCtx) {
  const { R } = ctx;
  const fr = new Frame(ctx.mb, V((R.minX + R.maxX) / 2, ctx.y, (R.minZ + R.maxZ) / 2), V(1, 0, 0), V(0, 0, 1));
  place('lowTable', fr, 0, 0, ctx.env);
}

function layoutBath(ctx: RoomCtx) {
  const { R } = ctx;
  const W = R.maxX - R.minX;
  const D = R.maxZ - R.minZ;
  // 長辺側の壁に浴槽
  const s: Side = W >= D ? (ctx.windows.n > ctx.windows.s ? 's' : 'n') : ctx.windows.w > ctx.windows.e ? 'e' : 'w';
  const { f, len } = sideFrame(ctx, s);
  const tw = Math.min(len - 0.05, 1.6);
  if (!ctx.has.has('bath')) place('bath', f, 0, 0, ctx.env, { len: +tw.toFixed(2) });
  // 水栓・鏡
  const o = opposite[s];
  const { f: of } = sideFrame(ctx, o);
  place('mirror', of, 0.3, 0, ctx.env);
}

function layoutWash(ctx: RoomCtx) {
  const order = (['n', 's', 'e', 'w'] as Side[]).sort((a, b) => ctx.windows[a] - ctx.windows[b]);
  let used: Side | null = null;
  if (ctx.has.has('washstand')) used = sideOfRot(ctx.has.has('washstand') ? (currentItems?.find((it) => it.roomId === ctx.room.id && it.kind === 'washstand')?.rot ?? 0) : 0);
  else
    for (const s of order) {
      const { f, len } = sideFrame(ctx, s);
      const u = findSpot(ctx, s, 0.8, len, -len / 4);
      if (u == null) continue;
      place('washstand', f, u, 0, ctx.env);
      used = s;
      break;
    }
  if (!used) return;
  for (const s of order) {
    if (s === used) continue;
    const { f, len } = sideFrame(ctx, s);
    const u = findSpot(ctx, s, 0.65, len, len / 4);
    if (u == null) continue;
    place('washer', f, u, 0.02, ctx.env);
    return;
  }
}

function layoutToilet(ctx: RoomCtx) {
  const { R } = ctx;
  const W = R.maxX - R.minX;
  const D = R.maxZ - R.minZ;
  // 短辺の奥（ドアのない側）
  const cands: Side[] = W < D ? ['n', 's'] : ['w', 'e'];
  if (ctx.has.has('toilet')) return;
  const s = cands.sort((a, b) => ctx.blocked[a].length - ctx.blocked[b].length)[0];
  const { f } = sideFrame(ctx, s);
  place('toilet', f, 0, 0, ctx.env);
}

function layoutEntrance(ctx: RoomCtx) {
  const order = (['n', 's', 'e', 'w'] as Side[]).sort((a, b) => ctx.blocked[a].length - ctx.blocked[b].length);
  const s = order[0];
  const { f, len } = sideFrame(ctx, s);
  const u = findSpot(ctx, s, 1.2, len, 0);
  if (u == null) return;
  place('shoeCabinet', f, u, 0, ctx.env);
  place('plant', f, u + 0.3, 0.2, ctx.env, { w: 0.35 });
  place('plant', f, u + 0.9, 0.25, ctx.env, { w: 0.7 });
}
