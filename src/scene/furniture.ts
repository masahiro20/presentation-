/**
 * 家具・設備の自動配置
 * 部屋の種類と開口部（窓・ドア）の位置から、壁際の空いている場所に配置する。
 */
import * as THREE from 'three';
import type { BuildingModel, Floor, Room } from '../core/types';
import { largestInnerRect, type Rect } from '../core/rects';
import { MeshBuilder, V } from './meshBuilder';
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

export function buildFurniture(model: BuildingModel): { mb: MeshBuilder; lights: LightPoint[]; occupancy: Map<string, Footprint[]>; kitchenSide: Map<string, Side> } {
  const mb = new MeshBuilder();
  const lights: LightPoint[] = [];
  const occupancy = new Map<string, Footprint[]>();
  kitchenSides = new Map();
  for (const f of model.floors) {
    for (const room of f.rooms) {
      const inner = largestInnerRect(room.polygon, 5);
      if (!inner) continue;
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
      const ctx: RoomCtx = { mb, R, y: f.elevation * MM, blocked: { n: [], s: [], e: [], w: [] }, windows: { n: 0, s: 0, e: 0, w: 0 }, lights, room };
      collectBlocked(ctx, f, inner);
      const ceilingY = f.ceilingHeight * MM;
      const center = V((R.minX + R.maxX) / 2, ctx.y + ceilingY - 0.02, (R.minZ + R.maxZ) / 2);
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
  }
  currentOcc = null;
  return { mb, lights, occupancy, kitchenSide: kitchenSides };
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

function kitchen(ctx: RoomCtx, fr: Frame, len: number, ceilingY: number) {
  // 背面収納
  const bw = Math.min(len - 0.3, 2.7);
  fr.box('f.cabinet', 0, 0, bw - 0.75, 0.45, 0, 0.9);
  fr.box('f.counter', 0, 0, bw - 0.75, 0.47, 0.9, 0.03);
  // 冷蔵庫
  fr.box('f.fridge', bw / 2 - 0.36, 0, 0.68, 0.7, 0, 1.82);
  // 対面カウンター（シンク・コンロ）
  const cw = Math.min(len - 0.4, 2.55);
  const cv = 0.45 + 0.9;
  fr.box('f.cabinet', 0, cv, cw, 0.65, 0, 0.85);
  fr.box('f.counter', 0, cv - 0.01, cw + 0.02, 0.67, 0.85, 0.04);
  // 腰壁の立ち上がり（対面側）
  fr.box('f.counter', 0, cv + 0.65, cw + 0.02, 0.1, 0, 1.05);
  // シンク
  fr.box('f.chrome', -cw / 2 + 0.6, cv + 0.12, 0.75, 0.42, 0.855, 0.04);
  fr.cyl('f.chrome', -cw / 2 + 0.6, cv + 0.08, 0.015, 0.89, 0.28);
  // コンロ
  fr.box('f.screen', cw / 2 - 0.5, cv + 0.08, 0.6, 0.5, 0.89, 0.01);
  // 天井埋込の薄型フード（線を増やさない）
  fr.box('f.hood', cw / 2 - 0.5, cv + 0.05, 0.9, 0.5, ceilingY - 0.025, 0.025);
  // 小物
  fr.cyl('f.white', 0.1, cv + 0.3, 0.1, 0.89, 0.12);
  fr.sphere('f.leaf', -0.1, cv + 0.35, 1.0, 0.09);
  void ctx;
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
  kitchenSides.set(ctx.room.id, kSide);
  kitchen(ctx, kf, klen, ceilingY);
  ctx.lights.push({ pos: kf.point(0, 1.3, ceilingY - 0.02), kind: 'ceiling', roomId: ctx.room.id });
  // ダイニング
  diningSet(kf, 0, kDepth + dDepth / 2, ctx.lights, ctx.room.id, ceilingY);
  if (!hasLiving) return;
  // リビング: 反対側の壁 or 窓のない長辺
  const livStart = kDepth + dDepth;
  const livDepth = total - livStart;
  const endSide = opposite[kSide];
  const { f: ef, len: elen } = sideFrame(ctx, endSide);
  const tvU = findSpot(ctx, endSide, 2.0, elen, 0);
  if (tvU != null && livDepth >= 3.2) {
    tvSet(ef, tvU, 0.02);
    const sofaV = Math.min(livDepth - 1.0, 3.0);
    rug(ef, tvU, 0.9, 2.2, Math.max(1.4, sofaV - 0.7));
    coffeeTable(ef, tvU, 1.2);
    // ソファは TV を向く（反対向きのフレーム）
    const back = new Frame(ctx.mb, ef.point(tvU, sofaV + 0.9, 0), ef.along.clone().negate(), ef.inward.clone().negate());
    sofa(back, 0, 0, 2.1);
    plant(ef, -elen / 2 + 0.35, 0.35, 1.1);
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
  tvSet(tf, tvU2, 0.02);
  const across = tvSide === 'n' || tvSide === 's' ? D : W;
  const sofaV = Math.min(across - 1.0, 2.8);
  rug(tf, tvU2, 0.9, 2.2, Math.max(1.4, sofaV - 0.7));
  coffeeTable(tf, tvU2, 1.25);
  const back = new Frame(ctx.mb, tf.point(tvU2, sofaV + 0.9, 0), tf.along.clone().negate(), tf.inward.clone().negate());
  sofa(back, 0, 0, 2.1);
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
    bed(f, u, 0.02, bw);
    if (placed.withStands) {
      nightstand(f, u - bw / 2 - 0.3, 0.02, ctx.lights, ctx.room.id);
      nightstand(f, u + bw / 2 + 0.3, 0.02, ctx.lights, ctx.room.id);
    }
    rug(f, u, 0.9, bw + 0.9, 1.6);
    // 机（子ども室・小さい部屋）
    if (!big) {
      const other = opposite[s];
      const { f: of, len: olen } = sideFrame(ctx, other);
      const du = findSpot(ctx, other, 1.1, olen, 0);
      if (du != null && depth > 3.0) desk(of, du, 0.02);
    } else {
      const { f: of, len: olen } = sideFrame(ctx, opposite[s]);
      const du = findSpot(ctx, opposite[s], 1.2, olen, olen / 4);
      if (du != null && depth > 3.4) {
        of.box('f.cabinet', du, 0.02, 1.2, 0.45, 0, 0.75);
        plant(of, du + 0.9, 0.3, 0.8);
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
    desk(f, u, 0.02);
    const o = opposite[s];
    const { f: of, len: olen } = sideFrame(ctx, o);
    const su = findSpot(ctx, o, 0.9, olen, 0);
    if (su != null) {
      of.box('f.cabinet', su, 0.02, 0.9, 0.32, 0, 1.8);
      for (let i = 1; i < 5; i++) of.box('f.wood', su, 0.03, 0.84, 0.3, i * 0.36, 0.02);
    }
    return;
  }
}

function layoutJapanese(ctx: RoomCtx) {
  const { R } = ctx;
  const fr = new Frame(ctx.mb, V((R.minX + R.maxX) / 2, ctx.y, (R.minZ + R.maxZ) / 2), V(1, 0, 0), V(0, 0, 1));
  fr.box('f.wood', 0, -0.4, 1.2, 0.8, 0.3, 0.05);
  for (const du of [-0.55, 0.55]) for (const dv of [-0.35, 0.35]) fr.box('f.wood', du, dv - 0.03, 0.06, 0.06, 0, 0.3);
  for (const [du, dv] of [
    [-0.35, -0.75],
    [0.35, -0.75],
    [-0.35, 0.75],
    [0.35, 0.75],
  ])
    fr.box('f.fabric2', du, dv - 0.26, 0.52, 0.52, 0.01, 0.07);
}

function layoutBath(ctx: RoomCtx) {
  const { R } = ctx;
  const W = R.maxX - R.minX;
  const D = R.maxZ - R.minZ;
  // 長辺側の壁に浴槽
  const s: Side = W >= D ? (ctx.windows.n > ctx.windows.s ? 's' : 'n') : ctx.windows.w > ctx.windows.e ? 'e' : 'w';
  const { f, len } = sideFrame(ctx, s);
  const tw = Math.min(len - 0.05, 1.6);
  f.box('f.white', 0, 0, tw, 0.8, 0, 0.55);
  f.box('f.water', 0, 0.08, tw - 0.16, 0.64, 0.5, 0.02);
  // 水栓・鏡
  const o = opposite[s];
  const { f: of } = sideFrame(ctx, o);
  of.box('f.mirror', 0.3, 0.005, 0.45, 0.01, 0.8, 0.8);
  of.box('f.chrome', 0.3, 0.02, 0.2, 0.08, 0.7, 0.05);
}

function layoutWash(ctx: RoomCtx) {
  const order = (['n', 's', 'e', 'w'] as Side[]).sort((a, b) => ctx.windows[a] - ctx.windows[b]);
  let used: Side | null = null;
  for (const s of order) {
    const { f, len } = sideFrame(ctx, s);
    const u = findSpot(ctx, s, 0.8, len, -len / 4);
    if (u == null) continue;
    f.box('f.cabinet', u, 0, 0.75, 0.5, 0, 0.78);
    f.box('f.counter', u, 0, 0.77, 0.52, 0.78, 0.05);
    f.box('f.white', u, 0.1, 0.45, 0.32, 0.8, 0.06);
    f.box('f.mirror', u, 0.005, 0.72, 0.01, 1.05, 0.85);
    f.box('f.chrome', u, 0.05, 0.03, 0.12, 0.83, 0.15);
    used = s;
    break;
  }
  if (!used) return;
  for (const s of order) {
    if (s === used) continue;
    const { f, len } = sideFrame(ctx, s);
    const u = findSpot(ctx, s, 0.65, len, len / 4);
    if (u == null) continue;
    f.box('f.white', u, 0.02, 0.6, 0.6, 0, 0.9);
    f.cyl('f.screen', u, 0.63, 0.17, 0.35, 0.3, 20);
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
  f.box('f.white', 0, 0.02, 0.38, 0.2, 0.45, 0.35); // タンク
  f.box('f.white', 0, 0.2, 0.36, 0.4, 0, 0.4);
  f.cyl('f.white', 0, 0.55, 0.19, 0, 0.4, 20);
  f.box('f.white', 0, 0.2, 0.38, 0.55, 0.4, 0.04);
  f.box('f.chrome', 0.28, 0.4, 0.12, 0.1, 0.7, 0.05);
}

function layoutEntrance(ctx: RoomCtx) {
  const order = (['n', 's', 'e', 'w'] as Side[]).sort((a, b) => ctx.blocked[a].length - ctx.blocked[b].length);
  const s = order[0];
  const { f, len } = sideFrame(ctx, s);
  const u = findSpot(ctx, s, 1.2, len, 0);
  if (u == null) return;
  f.box('f.cabinet', u, 0, 1.2, 0.38, 0.25, 0.85);
  f.box('f.counter', u, 0, 1.22, 0.4, 1.1, 0.03);
  plant(f, u + 0.3, 0.2, 0.35);
  plant(f, u + 0.9, 0.25, 0.7);
}
