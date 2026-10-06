/**
 * 家具・設備の自動配置
 * 部屋の種類と開口部（窓・ドア）の位置から、壁際の空いている場所に配置する。
 */
import * as THREE from 'three';
import type { BuildingModel, Floor, Room, FurnitureItem, FurnitureKind } from '../core/types';
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
export interface ModelPlacement {
  id: 'potted_plant_02' | 'modern_arm_chair_01';
  pos: V3;
  /** Y 軸まわりの回転（ラジアン） */
  rotY: number;
  /** 目標の高さ (m)。モデルの大きさから倍率を決める */
  height: number;
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
      currentOcc.push({ minX: c.x - ex, maxX: c.x + ex, minZ: c.z - ez, maxZ: c.z + ez, maxY: y0 + h });
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
}

/** 家具を置くときの階の情報 */
interface ItemEnv {
  mb: MeshBuilder;
  y: number;
  ceilingY: number;
  lights: LightPoint[];
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
};

/** 平面に描くときの外形 (m): 幅 w（並び方向）、奥行 d、基準点から奥行方向への始まり v0 */
export function furnitureDims(it: FurnitureItem): { w: number; d: number; v0: number } {
  switch (it.kind) {
    case 'kitchen':
      return { w: Math.max(1.5, (it.len ?? 3) - 0.3), d: (it.kitchenType ?? 'peninsula') === 'wall' ? 0.7 : 2.1, v0: 0 };
    case 'fridge':
      return { w: 0.68, d: 0.7, v0: 0 };
    case 'cupboard':
      return { w: it.w ?? 1.8, d: 0.45, v0: 0 };
    case 'dining':
      return { w: 1.6, d: 1.65, v0: -0.83 };
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
    const env: ItemEnv = { mb, y: f.elevation * MM, ceilingY: f.ceilingHeight * MM, lights };
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
      const ctx: RoomCtx = { mb, R, y: f.elevation * MM, blocked: { n: [], s: [], e: [], w: [] }, windows: { n: 0, s: 0, e: 0, w: 0 }, lights, room, env };
      collectBlocked(ctx, f, inner);
      const ceilingY = f.ceilingHeight * MM;
      const center = V((R.minX + R.maxX) / 2, ctx.y + ceilingY - 0.02, (R.minZ + R.maxZ) / 2);
      if (override) {
        if (!['void', 'balcony', 'porch', 'garage', 'other', 'closet', 'storage'].includes(room.type)) lights.push({ pos: center, kind: 'ceiling', roomId: room.id });
        continue;
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
        emitItem({ ...it, roomId: currentRoomId || undefined }, env);
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

/** 記録した家具 1 つの形を作る */
function emitItem(it: FurnitureItem, env: ItemEnv) {
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
      diningSet(fr, 0, 0, env.lights, roomId, env.ceilingY);
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
      if (currentOcc) currentOcc.push({ minX: p.x - 0.4, maxX: p.x + 0.4, minZ: p.z - 0.4, maxZ: p.z + 0.4, maxY: 0.8 });
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
  const d = 0.9;
  fr.box('f.fabric', u, v, w, d, 0.1, 0.32); // 座面台
  fr.box('f.fabric', u, v, w, 0.22, 0.1, 0.72); // 背
  fr.box('f.fabric', u - w / 2 + 0.1, v, 0.2, d, 0.1, 0.52); // 肘
  fr.box('f.fabric', u + w / 2 - 0.1, v, 0.2, d, 0.1, 0.52);
  const seatW = (w - 0.4) / 3;
  for (let i = 0; i < 3; i++) fr.box('f.fabric', u - w / 2 + 0.2 + seatW * (i + 0.5), v + 0.22, seatW - 0.02, d - 0.24, 0.42, 0.12);
  // クッション
  fr.box('f.fabric2', u - w / 2 + 0.45, v + 0.24, 0.42, 0.14, 0.52, 0.38);
  fr.box('f.fabric2', u + w / 2 - 0.45, v + 0.24, 0.42, 0.14, 0.52, 0.38);
  for (const du of [-w / 2 + 0.08, w / 2 - 0.08]) for (const dv of [0.08, d - 0.08]) fr.box('f.metal', u + du, v + dv - 0.02, 0.04, 0.04, 0, 0.1);
}

function coffeeTable(fr: Frame, u: number, v: number) {
  fr.box('f.wood', u, v, 1.0, 0.5, 0.33, 0.04);
  for (const du of [-0.45, 0.45]) for (const dv of [0.03, 0.43]) fr.box('f.wood', u + du, v + dv, 0.04, 0.04, 0, 0.33);
  // 小物
  fr.cyl('f.white', u + 0.25, v + 0.25, 0.08, 0.37, 0.02);
  fr.box('f.fabric2', u - 0.2, v + 0.15, 0.22, 0.16, 0.37, 0.04);
}

function tvSet(fr: Frame, u: number, v: number, w = 1.8) {
  fr.box('f.cabinet', u, v, w, 0.42, 0.05, 0.4);
  fr.box('f.screen', u, v + 0.12, 1.3, 0.05, 0.47, 0.76);
  fr.box('f.metal', u, v + 0.1, 0.3, 0.2, 0.45, 0.02);
  // 観葉植物
  plant(fr, u + w / 2 + 0.35, v + 0.3, 1.0);
}

export function plant(fr: Frame, u: number, v: number, scale = 1) {
  // 実物の観葉植物モデル（読み込めない環境では下の簡易形状）
  const p = fr.point(u, v, 0);
  currentModels.push({ id: 'potted_plant_02', pos: p, rotY: Math.sin(u * 12.9898 + v * 4.1) * Math.PI, height: 1.15 * scale });
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

function diningSet(fr: Frame, u: number, v: number, lights: LightPoint[], roomId: string, ceilingY: number) {
  // v = テーブル中心までの距離
  const tw = 1.6;
  const td = 0.85;
  fr.box('f.wood', u, v - td / 2, tw, td, 0.69, 0.04);
  for (const du of [-tw / 2 + 0.08, tw / 2 - 0.08]) for (const dv of [-td / 2 + 0.08, td / 2 - 0.08]) fr.box('f.wood', u + du, v + dv - 0.025, 0.05, 0.05, 0, 0.69);
  for (const du of [-0.4, 0.4])
    for (const side of [-1, 1]) {
      const cv = v + side * (td / 2 + 0.2);
      fr.box('f.wood', u + du, cv - 0.22, 0.44, 0.44, 0.42, 0.04);
      for (const lu of [-0.19, 0.19]) for (const lv of [-0.19, 0.19]) fr.box('f.wood', u + du + lu, cv + lv - 0.015, 0.03, 0.03, 0, 0.42);
      fr.box('f.wood', u + du, cv + side * 0.2 - 0.015, 0.42, 0.03, 0.46, 0.4);
      fr.box('f.fabric', u + du, cv - 0.2, 0.4, 0.4, 0.46, 0.03);
    }
  // ペンダントライト 2灯
  for (const du of [-0.4, 0.4]) {
    const y = 1.55;
    fr.box('f.metal', u + du, v - 0.005, 0.01, 0.01, y + 0.2, ceilingY - y - 0.2);
    fr.cyl('f.lampShade', u + du, v, 0.16, y, 0.2, 18);
    fr.sphere('f.lamp', u + du, v, y + 0.02, 0.06);
    lights.push({ pos: fr.point(u + du, v, y - 0.05), kind: 'pendant', roomId });
  }
}

function kitchen(fr: Frame, len: number, ceilingY: number, opt: Pick<FurnitureItem, 'kitchenType' | 'stoveSide' | 'fridge' | 'hood'> = {}) {
  const type = opt.kitchenType ?? 'peninsula';
  const stoveSign = (opt.stoveSide ?? 'right') === 'right' ? 1 : -1;
  const fridge = opt.fridge ?? 'right';
  const hood = opt.hood !== false;
  // 小物（木のトレーと白い器、細い一輪挿し）
  const props = (cv: number) => {
    fr.box('f.wood', 0.05 * stoveSign, cv + 0.3, 0.42, 0.26, 0.89, 0.018);
    fr.cyl('f.white', -0.03, cv + 0.3, 0.07, 0.908, 0.09);
    fr.cyl('f.white', 0.13, cv + 0.3, 0.045, 0.908, 0.13);
    fr.cyl('f.white', -0.45 * stoveSign, cv + 0.32, 0.035, 0.89, 0.22);
    fr.cyl('f.leaf', -0.45 * stoveSign, cv + 0.32, 0.004, 1.11, 0.22, 6);
    fr.sphere('f.leaf', -0.45 * stoveSign, cv + 0.32, 1.35, 0.045, 1.4);
  };
  // シンク・コンロ・フード（カウンターの中心線 cv、幅 cw）
  const fittings = (cv: number, cw: number, depth: number) => {
    const sinkU = -stoveSign * (cw / 2 - 0.6);
    const stoveU = stoveSign * (cw / 2 - 0.5);
    fr.box('f.chrome', sinkU, cv + 0.12, 0.75, 0.42, 0.855, 0.04);
    fr.cyl('f.chrome', sinkU, cv + 0.08, 0.015, 0.89, 0.28);
    fr.box('f.screen', stoveU, cv + 0.08, 0.6, 0.5, 0.89, 0.01);
    if (hood) {
      if (type === 'wall') {
        // 壁付けは壁掛けのスリムなフード
        fr.box('f.hood', stoveU, cv + 0.02, 0.75, depth - 0.1, 1.55, 0.06);
        fr.box('f.hood', stoveU, cv + 0.02, 0.5, 0.3, 1.61, ceilingY - 1.61);
      } else fr.box('f.hood', stoveU, cv + 0.05, 0.9, 0.5, ceilingY - 0.025, 0.025); // 天井埋込の薄型フード
    }
  };
  if (type === 'wall') {
    // 壁付け I 型: 壁沿いのカウンターにシンク・コンロ。冷蔵庫はその端
    const cw = Math.min(len - 0.3, 3.0) - (fridge === 'none' ? 0 : 0.75);
    const cu = fridge === 'none' ? 0 : fridge === 'right' ? -0.375 : 0.375;
    fr.box('f.cabinet', cu, 0, cw, 0.65, 0, 0.85);
    fr.box('f.counter', cu, -0.01, cw + 0.02, 0.67, 0.85, 0.04);
    // 吊戸棚
    fr.box('f.cabinet', cu, 0, cw, 0.35, 1.55, ceilingY - 1.6);
    const sinkU = cu - stoveSign * (cw / 2 - 0.6);
    const stoveU = cu + stoveSign * (cw / 2 - 0.5);
    fr.box('f.chrome', sinkU, 0.12, 0.75, 0.42, 0.855, 0.04);
    fr.cyl('f.chrome', sinkU, 0.08, 0.015, 0.89, 0.28);
    fr.box('f.screen', stoveU, 0.08, 0.6, 0.5, 0.89, 0.01);
    if (hood) fr.box('f.hood', stoveU, 0.02, 0.75, 0.5, 1.5, 0.06);
    if (fridge !== 'none') fr.box('f.fridge', (fridge === 'right' ? 1 : -1) * (cw / 2 + 0.375 - 0.36) + cu, 0, 0.68, 0.7, 0, 1.82);
    return;
  }
  // 背面収納（冷蔵庫の分だけ短く）
  const bw = Math.min(len - 0.3, 2.7);
  const cabW = fridge === 'none' ? bw : bw - 0.75;
  const cabU = fridge === 'none' ? 0 : fridge === 'right' ? -0.375 : 0.375;
  fr.box('f.cabinet', cabU, 0, cabW, 0.45, 0, 0.9);
  fr.box('f.counter', cabU, 0, cabW, 0.47, 0.9, 0.03);
  if (fridge !== 'none') fr.box('f.fridge', (fridge === 'right' ? 1 : -1) * (bw / 2 - 0.36), 0, 0.68, 0.7, 0, 1.82);
  // 対面カウンター（シンク・コンロ）
  const cw = Math.min(len - 0.4, 2.55);
  const cv = 0.45 + 0.9;
  fr.box('f.cabinet', 0, cv, cw, 0.65, 0, 0.85);
  fr.box('f.counter', 0, cv - 0.01, cw + 0.02, type === 'island' ? 0.95 : 0.67, 0.85, 0.04);
  // ペニンシュラは部屋側に腰壁の立ち上がり。アイランドは四方から使えるフラットなカウンター
  if (type === 'peninsula') fr.box('f.counter', 0, cv + 0.65, cw + 0.02, 0.1, 0, 1.05);
  else fr.box('f.cabinet', 0, cv + 0.65, cw, 0.3, 0, 0.85);
  fittings(cv, cw, 0.65);
  props(cv);
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
  const total = kSide === 'e' || kSide === 'w' ? W : D;
  const kDepth = total >= 6.5 ? 2.5 : 2.3;
  const dDepth = total >= 6.5 ? 2.4 : 2.1;
  const hasLiving = total - kDepth - dDepth >= 2.4 && ctx.room.type !== 'dining' && ctx.room.type !== 'kitchen';
  const { f: kf, len: klen } = sideFrame(ctx, kSide);
  place('kitchen', kf, 0, 0, ctx.env, { len: +klen.toFixed(2) });
  // ダイニング
  place('dining', kf, 0, kDepth + dDepth / 2, ctx.env);
  if (!hasLiving) return;
  // リビング: 反対側の壁 or 窓のない長辺
  const livStart = kDepth + dDepth;
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

function bed(fr: Frame, u: number, v: number, w: number) {
  const L = 2.0;
  fr.box('f.wood', u, v, w + 0.06, L + 0.04, 0.08, 0.22);
  fr.box('f.wood', u, v - 0.04, w + 0.06, 0.06, 0.08, 0.85); // ヘッドボード
  fr.box('f.bedding', u, v + 0.02, w, L, 0.3, 0.2);
  fr.box('f.fabric2', u, v + 0.75, w + 0.02, L - 0.72, 0.48, 0.05); // 掛け布団
  fr.box('f.fabric2', u, v + 1.75, w + 0.04, 0.3, 0.3, 0.2);
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
  place('bath', f, 0, 0, ctx.env, { len: +tw.toFixed(2) });
  // 水栓・鏡
  const o = opposite[s];
  const { f: of } = sideFrame(ctx, o);
  place('mirror', of, 0.3, 0, ctx.env);
}

function layoutWash(ctx: RoomCtx) {
  const order = (['n', 's', 'e', 'w'] as Side[]).sort((a, b) => ctx.windows[a] - ctx.windows[b]);
  let used: Side | null = null;
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
