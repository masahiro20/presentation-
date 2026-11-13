/**
 * 建物モデル → 3D ジオメトリ
 * 単位: m。平面 (x, y[下向き]) → ワールド (X = x, Z = y)、Y が上。
 */
import * as THREE from 'three';
import { postInWall, postSpan } from '../core/posts';
import { DOMA_DROP_MM, isDomaRoom, isExteriorWorks, isSeparateGarage, roomFloorOffsetMm, type BuildingModel, type Floor, type Opening, type Room, type Stair, type StairBuild, type StairLook, type StairRail, type Vec2, type VoidGuard, type Wall } from '../core/types';
import { pointInPolygon, isHoleLoop, bboxOf, mergeIntervals, subtractIntervals } from '../core/geometry';
import { isOpenSkyBalcony } from '../core/balcony';
import { isRectilinear, polygonToRects, rectsMinus, offsetPolygon, type Rect } from '../core/rects';
import { MeshBuilder, topClip, type ClipPlane, V } from './meshBuilder';
import { stairLayout, effectiveStepCount, stairFootprint } from '../core/stairs';
import type { ExteriorStyle } from '../styles/presets';
import { BUILDER_SPECS, effectiveOpening, type BuilderSpec } from '../styles/spec';

export const MM = 0.001;

export interface BuildOptions {
  exterior: ExteriorStyle;
  /** 標準仕様（建具・窓・照明の納まり） */
  spec?: BuilderSpec;
  /** 階段のつくり（コーディネートの「階段」の品目から。coordinate/catalog の stairBuildOf）。省略時は鉄骨 */
  stairBuild?: StairBuild;
  /** 最上階の外壁の高さ（床から、mm） */
  topWallHeight?: number;
  /** 輪切り（模型）: 指定階を床から height (m) の高さで水平に切り、上の階・天井・屋根は作らない */
  cut?: { level: number; height?: number };
  /** 断面: 任意の切断面（鉛直の面など）。cut より優先 */
  clip?: ClipPlane;
}

/** 輪切りの切断高さの既定（床から、m）。腰窓の下端より少し上で、キッチンや家具の形が残る高さ */
export const CUT_HEIGHT = 1.35;
/** 建具など別部品の MeshBuilder にも同じ切断面を掛ける */
let partClip: ClipPlane | null = null;
/** 部品の局所座標（原点 origin・Y 軸まわり yaw）に切断面を変換する */
function localClip(origin: THREE.Vector3, yaw: number): ClipPlane | null {
  if (!partClip) return null;
  const n = partClip.n.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
  return { n, d: partClip.d - partClip.n.dot(origin), capKey: partClip.capKey };
}

export interface RoomInfo {
  room: Room;
  floor: Floor;
  /** ワールド座標の多角形 (x,z) */
  poly: THREE.Vector2[];
  center: THREE.Vector3;
  floorY: number;
}

export interface BuildingMeta {
  bbox: THREE.Box3;
  rooms: RoomInfo[];
  entrance?: { pos: THREE.Vector3; outward: THREE.Vector3; width: number; level: number; openingId: string };
  wallTop: number[];
  /** 開いた扉の位置（カメラの干渉判定用） */
  doorLeaves: { a: THREE.Vector3; b: THREE.Vector3 }[];
  /** 開閉できる扉（独立した部品として表示側で動かす） */
  doors: DoorInfo[];
  /** 各階の外形（ワールド） */
  outlines: { level: number; y: number; polys: THREE.Vector2[][] }[];
  topY: number;
  /** 窓の障子 1 枚ごと（立面図の建具記号用）: ガラス面の 4 隅（ワールド）と、開く窓なら記号の三角（丁番側の中点が頂点） */
  sashes: SashInfo[];
}

export interface SashInfo {
  level: number;
  openingId: string;
  /** 'fix' = はめ殺し、'side' = 縦すべり出し、'top' = 横すべり出し */
  kind: 'fix' | 'side' | 'top';
  /** ガラス面の外向き法線 */
  outN: THREE.Vector3;
  corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
  /** 開く窓の記号: 丁番側の辺の中点（頂点）と、反対側の辺の両端 */
  tri?: { apex: THREE.Vector3; a: THREE.Vector3; b: THREE.Vector3 };
}

/**
 * 扉 1 枚。扉の板は局所座標（原点 = ヒンジ／引戸の閉位置、+X = 閉じた状態で板が伸びる向き）で作り、
 * 表示側で Group に入れて回転（開き戸）または平行移動（引戸）させる。
 */
export interface DoorInfo {
  /** 開口の ID */
  id: string;
  /** swing: 開き戸（回転）、slide: 引戸（平行移動）、roll: 巻き取りシャッター（上端を原点に縦に縮む） */
  kind: 'swing' | 'slide' | 'roll';
  level: number;
  /** Group の位置（床の高さ 0。板の高さは局所座標に含む） */
  origin: THREE.Vector3;
  /** 閉じた状態の Group の Y 回転 */
  yaw0: number;
  /** 開き戸: 全開時の回転（符号付き、ラジアン）。引戸: 0 */
  openAngle: number;
  /** 引戸: 全開時の移動方向と距離 */
  slideDir: THREE.Vector3;
  slideDist: number;
  /**
   * 通常表示（3D・パース）での開き具合 0〜1。室内の戸は閉じて見せる（御社の提案パースは、壁と同色のハイドアを閉じた状態で描く。
   * 以前は開き戸を 80° 開けていて、廊下やホールのパースに開いた戸の板が何枚も立って見えていた）。クリック・ルームツアーで開く
   */
  staticOpen: number;
  /** 輪切り模型（上から見る）で見せる開き具合 0〜1（間取りのつながりが分かるように少し開ける） */
  cutOpen: number;
  mb: MeshBuilder;
  width: number;
}

const up = new THREE.Vector3(0, 1, 0);

/** 家の外の区画（バルコニー・ポーチ・中庭・外構・後付け／離れのガレージ）。面する壁は外壁の仕上げ */
function outdoorRoom(r: Room | null): boolean {
  return !!r && (r.type === 'balcony' || r.type === 'porch' || isExteriorWorks(r.type) || isSeparateGarage(r));
}

/** 家と別に建つ小さな建物（後付け・離れのガレージ・物置）の高さ（地面から、m）。GAW ガレージは H3000 */
export const GARAGE_HEIGHT = 3.0;
export const SHED_HEIGHT = 2.2;
/** 壁（両端と中点）から階の外形までの最短距離 (mm)。外形の中に入っていれば 0 */
function distToOutlineMm(f: Floor, w: Wall): number {
  const loops = f.outline.filter((l) => l.length >= 3);
  if (!loops.length) return 0;
  let d = Infinity;
  for (const p of [w.a, w.b, { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 }]) {
    if (loops.some((l) => pointInPolygon(p, l))) return 0;
    for (const l of loops)
      for (let i = 0; i < l.length; i++) {
        const a = l[i];
        const b = l[(i + 1) % l.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        d = Math.min(d, Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y));
      }
  }
  return d;
}

function annexHeight(r: Room | null): number | null {
  if (!r) return null;
  if (isSeparateGarage(r)) return GARAGE_HEIGHT;
  if (r.type === 'shed') return SHED_HEIGHT;
  return null;
}

export function wallTopOf(model: BuildingModel, f: Floor, opts?: { topWallHeight?: number }): number {
  const idx = model.floors.indexOf(f);
  const next = model.floors[idx + 1];
  if (next) return next.elevation;
  return f.elevation + (opts?.topWallHeight ?? 2750);
}

function roomAt(f: Floor, x: number, y: number): Room | null {
  for (const r of f.rooms) if (pointInPolygon({ x, y }, r.polygon)) return r;
  return null;
}

/** この階より上の階の外形（玄関の庇が要るかの判定: 上階・下屋の下なら庇は要らない） */
function upperOutlinesOf(model: BuildingModel, f: Floor): { x: number; y: number }[][] {
  return model.floors.filter((x) => x.level > f.level).flatMap((x) => x.outline.filter((l) => l.length >= 3 && !isHoleLoop(l, x.outline)));
}

/** 玄関の土間の下がり（m）: 上がり框の段差 */
export const DOMA_DROP = DOMA_DROP_MM * MM;

/**
 * 床の段差の縁（上がり框・小上がりの框・ダウンリビングの段）: この部屋の縁のうち、床の高さが違う部屋と接する辺に、
 * 低い側へ 120 の木の蹴込み（高さ = 段差）と、高い側の床を 30mm 持ち出す天端（框）を付ける。壁の中に隠れる所はそのまま埋め、戸・開口の所で段として見える。
 * 玄関の土間（−180）とホールの境は従来の上がり框と同じ
 */
function buildStepEdges(mb: MeshBuilder, f: Floor, room: Room, fl: number) {
  const here = roomFloorOffsetMm(room);
  const P = room.polygon;
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 300) continue;
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    const nx = -uy;
    const ny = ux;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // この部屋の側（内側）と、向こう側の部屋
    const inSide = pointInPolygon({ x: m.x + nx * 200, y: m.y + ny * 200 }, P) ? 1 : -1;
    const other = roomAt(f, m.x - nx * inSide * 250, m.y - ny * inSide * 250);
    if (!other || other === room || outdoorRoom(other) || other.type === 'void' || isBuiltinGarage(other)) continue;
    const there = roomFloorOffsetMm(other);
    const diff = here - there;
    if (Math.abs(diff) < 20) continue;
    // 両方に段差があるときは高い側の部屋から描く（同じ縁を二重に描かない）
    if (there !== 0 && here < there) continue;
    const lowSide = diff > 0 ? -inSide : inSide;
    const yLow = fl + Math.min(here, there) * MM;
    const hgt = Math.abs(diff) * MM;
    const dir = V(ux, 0, uy);
    // 壁が立っている区間の框は壁の中に隠れるので描かない。戸・開口の区間（出入口）と、壁の無い縁（開けた小上がり）だけ
    for (const [t0, t1] of openRuns(f, a, ux, uy, L)) {
      const len = t1 - t0;
      if (len < 150) continue;
      const mx = a.x + ux * (t0 + t1) / 2;
      const my = a.y + uy * (t0 + t1) / 2;
      const c = V((mx + nx * lowSide * 60) * MM, yLow, (my + ny * lowSide * 60) * MM);
      mb.box('f.wood', c, dir, len * MM, hgt, 0.12);
      const top = V((mx + nx * lowSide * 75) * MM, yLow + hgt - 0.03, (my + ny * lowSide * 75) * MM);
      mb.box('f.wood', top, dir, len * MM, 0.03, 0.15);
    }
  }
}

/**
 * 部屋の縁（a から向き (ux, uy) に長さ L）のうち、壁に隠れない区間 [t0, t1]（mm）。
 * 縁に重なる壁の区間を引き、その壁の戸・引戸・開口・玄関戸の区間は戻す（出入口には框が見える）
 */
export function openRuns(f: Floor, a: Vec2, ux: number, uy: number, L: number): [number, number][] {
  const subtract = (spans: [number, number][], s0: number, s1: number): [number, number][] => {
    const out: [number, number][] = [];
    for (const [p0, p1] of spans) {
      if (s1 <= p0 || s0 >= p1) out.push([p0, p1]);
      else {
        if (s0 > p0) out.push([p0, s0]);
        if (s1 < p1) out.push([s1, p1]);
      }
    }
    return out;
  };
  const along = (p: Vec2) => (p.x - a.x) * ux + (p.y - a.y) * uy;
  const off = (p: Vec2) => Math.abs(-(p.x - a.x) * uy + (p.y - a.y) * ux);
  let open: [number, number][] = [[0, L]];
  for (const w of f.walls) {
    if (off(w.a) > 120 || off(w.b) > 120) continue;
    const wa = along(w.a);
    const wb = along(w.b);
    const t0 = Math.max(0, Math.min(wa, wb));
    const t1 = Math.min(L, Math.max(wa, wb));
    if (t1 - t0 < 50) continue;
    let covered: [number, number][] = [[t0, t1]];
    const wl = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    for (const o of f.openings) {
      if (o.wallId !== w.id || o.kind === 'window' || o.kind === 'shutter') continue;
      const p0 = wa + ((wb - wa) * o.t0) / wl;
      const p1 = wa + ((wb - wa) * o.t1) / wl;
      covered = subtract(covered, Math.min(p0, p1), Math.max(p0, p1));
    }
    for (const [c0, c1] of covered) open = subtract(open, c0, c1);
  }
  return open;
}

/** ビルトインガレージの土間の高さ（GL+40。家の床 FL ではない） */
export const GARAGE_FLOOR_Y = 0.04;
/** 家の中に組み込まれたガレージ（床は土間、車の口には段差を作らない） */
export function isBuiltinGarage(r: Room | null | undefined): boolean {
  return !!r && r.type === 'garage' && !isSeparateGarage(r);
}

/** 1 階のシャッターの口（m の線分）。基礎・水切りをここで切る */
function shutterGaps(f: Floor): { a: THREE.Vector3; b: THREE.Vector3; dir: THREE.Vector3 }[] {
  const out: { a: THREE.Vector3; b: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  for (const o of f.openings) {
    if (o.kind !== 'shutter') continue;
    const w = f.walls.find((x) => x.id === o.wallId);
    if (!w) continue;
    const A = V(w.a.x * MM, 0, w.a.y * MM);
    const B = V(w.b.x * MM, 0, w.b.y * MM);
    const dir = new THREE.Vector3().subVectors(B, A).normalize();
    out.push({ a: A.clone().addScaledVector(dir, o.t0 * MM), b: A.clone().addScaledVector(dir, o.t1 * MM), dir });
  }
  return out;
}

/** 上下階の階段（上階の床に穴をあける） */
export function stairVoidsFor(model: BuildingModel, f: Floor): Rect[] {
  const idx = model.floors.indexOf(f);
  const below = model.floors[idx - 1];
  const out: Rect[] = [];
  // かね折れ階段は L 字の範囲だけ（矩形いっぱいに穴をあけると、角の所の床まで抜ける）
  if (below) for (const s of below.stairs) if (s.goesUp) out.push(...stairFootprint(s));
  // 上階に DN 階段があり、下階に対応する階段がない場合も穴を開ける
  for (const s of f.stairs) {
    if (!s.goesUp && below && !below.stairs.some((b) => Math.abs(b.minX - s.minX) < 300 && Math.abs(b.minY - s.minY) < 300)) out.push(...stairFootprint(s));
  }
  // 吹抜: 形どおりに抜く（L 字・角の丸い吹抜を外接の四角で抜くと、吹抜の脇の廊下の床と、その下の天井まで欠ける。林様邸 2 階）
  for (const r of f.rooms) if (r.type === 'void') out.push(...voidRects(r.polygon));
  return out;
}

/**
 * 吹抜の形を、床・天井の穴に使う長方形の集まりにする。
 *  - 長方形・L 字など軸に平行な形: そのまま分ける（形どおり）
 *  - 斜めの辺・丸い角のある形: 横の帯に分ける。両脇が鉛直な範囲は 1 枚、斜め・曲線の範囲は 40mm ごとの帯で近似する
 */
export function voidRects(poly: Vec2[]): Rect[] {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const bbox: Rect = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  if (poly.length < 3) return [];
  if (isRectilinear(poly, 2)) {
    const rects = polygonToRects([poly], 3);
    return rects.length ? rects : [bbox];
  }
  // 帯の境: 頂点の高さと、斜めの辺が通る範囲の 40mm 刻み
  const STEP = 40;
  const cuts = new Set<number>([bbox.minY, bbox.maxY]);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    cuts.add(a.y);
    if (Math.abs(a.x - b.x) < 2 || Math.abs(a.y - b.y) < 2) continue;
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    for (let y = lo + STEP; y < hi - 1; y += STEP) cuts.add(Math.round(y));
  }
  const levels = [...cuts].sort((p, q) => p - q).filter((y, i, arr) => i === 0 || y - arr[i - 1] > 1);
  const out: Rect[] = [];
  for (let k = 0; k + 1 < levels.length; k++) {
    const y0 = levels[k];
    const y1 = levels[k + 1];
    const ym = (y0 + y1) / 2;
    // 帯の中ほどの高さで多角形を横切る区間
    const cross: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a.y > ym !== b.y > ym) cross.push(a.x + ((b.x - a.x) * (ym - a.y)) / (b.y - a.y));
    }
    cross.sort((p, q) => p - q);
    for (let c = 0; c + 1 < cross.length; c += 2) {
      const x0 = Math.round(cross[c]);
      const x1 = Math.round(cross[c + 1]);
      if (x1 - x0 < 20) continue;
      // 同じ幅で上の帯から続くなら 1 枚にまとめる
      const prev = out.find((r) => Math.abs(r.maxY - y0) < 1 && Math.abs(r.minX - x0) < 2 && Math.abs(r.maxX - x1) < 2);
      if (prev) prev.maxY = y1;
      else out.push({ minX: x0, maxX: x1, minY: y0, maxY: y1 });
    }
  }
  return out.length ? out : [bbox];
}

/**
 * 上下階の外壁の面を揃える（図面の読み取りで芯が数 cm ずれると、外壁に段差の帯ができるため）。
 * 上階の外壁が、下階の外壁とほぼ同じ線（面のずれ 18cm 以内・平行・重なりあり）にあれば、外面を下階に合わせて平行移動する。
 * その線上にある他の壁の端点も一緒に動かし、開口の位置は壁の始点の移動分だけ補正する。
 */
/**
 * 間仕切り壁の端が外壁の中まで食い込み、外壁の外の面のすぐ裏まで来ていると、外から見て細い縦の点線が透ける。
 * 外壁に突き当たる間仕切り壁の端は、外壁の芯（壁の中央）で止める
 */
export function trimInteriorEnds(model: BuildingModel): BuildingModel {
  const floors = model.floors.map((f) => {
    const ext = f.walls.filter((w) => w.exterior);
    const walls = f.walls.map((w) => {
      if (w.exterior) return w;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (L < 1) return w;
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      let { a, b } = w;
      for (const v of ext) {
        const vl = Math.hypot(v.b.x - v.a.x, v.b.y - v.a.y);
        if (vl < 1) continue;
        const vx = (v.b.x - v.a.x) / vl;
        const vy = (v.b.y - v.a.y) / vl;
        // ほぼ直交するものだけ
        if (Math.abs(ux * vx + uy * vy) > 0.2) continue;
        const nx = -vy;
        const ny = vx;
        for (const end of ['a', 'b'] as const) {
          const e = end === 'a' ? a : b;
          const along = (e.x - v.a.x) * vx + (e.y - v.a.y) * vy;
          if (along < -v.thickness || along > vl + v.thickness) continue;
          const off = (e.x - v.a.x) * nx + (e.y - v.a.y) * ny; // 外壁の芯からの距離（符号付き）
          if (Math.abs(off) > v.thickness / 2 + 5 || Math.abs(off) < 1) continue;
          // 壁の向きに沿って、外壁の芯まで戻す
          const dirDot = ux * nx + uy * ny;
          if (Math.abs(dirDot) < 0.5) continue;
          const back = off / dirDot;
          const p = { x: e.x - ux * back, y: e.y - uy * back };
          if (end === 'a') {
            a = p;
          } else b = p;
        }
      }
      if (a === w.a && b === w.b) return w;
      return { ...w, a, b };
    });
    // 開口の位置は始点からの距離なので、始点が動いた壁はずらす
    const openings = f.openings.map((o) => {
      const w0 = f.walls.find((x) => x.id === o.wallId);
      const w1 = walls.find((x) => x.id === o.wallId);
      if (!w0 || !w1 || w0 === w1 || (w0.a.x === w1.a.x && w0.a.y === w1.a.y)) return o;
      const L = Math.hypot(w0.b.x - w0.a.x, w0.b.y - w0.a.y) || 1;
      const d = ((w1.a.x - w0.a.x) * (w0.b.x - w0.a.x) + (w1.a.y - w0.a.y) * (w0.b.y - w0.a.y)) / L;
      return { ...o, t0: o.t0 - d, t1: o.t1 - d };
    });
    return { ...f, walls, openings };
  });
  return { ...model, floors };
}

export function alignUpperWalls(model: BuildingModel): BuildingModel {
  const floors = model.floors.map((f) => ({ ...f, walls: f.walls.map((w) => ({ ...w, a: { ...w.a }, b: { ...w.b } })), openings: f.openings.map((o) => ({ ...o })), outline: f.outline.map((l) => l.map((p) => ({ ...p }))) }));
  for (let i = 1; i < floors.length; i++) {
    const up = floors[i];
    const low = floors[i - 1].walls.filter((w) => w.exterior);
    for (const w of up.walls) {
      if (!w.exterior || w.outsideSign == null) continue;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (L < 300) continue;
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      const nx = -uy * w.outsideSign;
      const ny = ux * w.outsideSign;
      const face = (w.a.x + w.b.x) / 2 * nx + (w.a.y + w.b.y) / 2 * ny + w.thickness / 2;
      let best: number | null = null;
      for (const q of low) {
        const ql = Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y);
        if (ql < 300 || q.outsideSign == null) continue;
        const qx = (q.b.x - q.a.x) / ql;
        const qy = (q.b.y - q.a.y) / ql;
        if (Math.abs(qx * uy - qy * ux) > 0.02) continue;
        const qnx = -qy * q.outsideSign;
        const qny = qx * q.outsideSign;
        if (qnx * nx + qny * ny < 0.9) continue;
        // 重なり
        const t = (p: { x: number; y: number }) => p.x * ux + p.y * uy;
        const ov = Math.min(Math.max(t(w.a), t(w.b)), Math.max(t(q.a), t(q.b))) - Math.max(Math.min(t(w.a), t(w.b)), Math.min(t(q.a), t(q.b)));
        if (ov < 300) continue;
        const qface = (q.a.x + q.b.x) / 2 * nx + (q.a.y + q.b.y) / 2 * ny + q.thickness / 2;
        const d = qface - face;
        if (Math.abs(d) < 3 || Math.abs(d) > 180) continue;
        if (best == null || Math.abs(d) < Math.abs(best)) best = d;
      }
      if (best == null) continue;
      const dx = nx * best;
      const dy = ny * best;
      // 旧い線の上にある端点（この壁と、ここに取り付く壁）を同じだけ動かす
      const onLine = (p: { x: number; y: number }) => {
        const rx = p.x - w.a.x;
        const ry = p.y - w.a.y;
        const along = rx * ux + ry * uy;
        const off = Math.abs(rx * -uy + ry * ux);
        return off < w.thickness / 2 + 30 && along > -w.thickness && along < L + w.thickness;
      };
      // 外形線（床スラブ・屋根の元）のうち、外壁の外面の線上にある点も動かす
      const onFace = (p: { x: number; y: number }) => {
        const rx = p.x - w.a.x;
        const ry = p.y - w.a.y;
        const along = rx * ux + ry * uy;
        const off = rx * nx + ry * ny;
        return Math.abs(off - w.thickness / 2) < 40 || Math.abs(off) < 40 ? along > -w.thickness - 50 && along < L + w.thickness + 50 : false;
      };
      for (const loop of up.outline) for (const p of loop) if (onFace(p)) {
        p.x += dx;
        p.y += dy;
      }
      for (const o of up.walls) {
        const moveA = o === w || onLine(o.a);
        const moveB = o === w || onLine(o.b);
        if (!moveA && !moveB) continue;
        if (moveA && o !== w) {
          const ol = Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y) || 1;
          const shiftT = (dx * (o.b.x - o.a.x) + dy * (o.b.y - o.a.y)) / ol;
          for (const op of up.openings) if (op.wallId === o.id) {
            op.t0 -= shiftT;
            op.t1 -= shiftT;
          }
        }
        if (moveA) {
          o.a.x += dx;
          o.a.y += dy;
        }
        if (moveB) {
          o.b.x += dx;
          o.b.y += dy;
        }
      }
    }
  }
  return { ...model, floors };
}

/** 部屋ごとの天井高 (mm)。無ければ階の天井高 */
export const roomCeilingMm = (f: Floor, r: Room): number => r.ceilingHeight ?? f.ceilingHeight;
/** 内壁の高さ (mm): 壁の両側の部屋の天井高の高い方（部屋が無ければ階の天井高） */
function wallCeilingMm(f: Floor, w: Wall): number {
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
  const nx = -(w.b.y - w.a.y) / L;
  const ny = (w.b.x - w.a.x) / L;
  const mx = (w.a.x + w.b.x) / 2;
  const my = (w.a.y + w.b.y) / 2;
  let best = 0;
  for (const sg of [1, -1]) {
    const p = { x: mx + nx * sg * (w.thickness / 2 + 100), y: my + ny * sg * (w.thickness / 2 + 100) };
    const r = f.rooms.find((q) => pointInPolygon(p, q.polygon));
    if (r?.ceilingHeight) best = Math.max(best, r.ceilingHeight);
  }
  return best || f.ceilingHeight;
}

export function buildBuilding(model: BuildingModel, opts: BuildOptions): { mb: MeshBuilder; meta: BuildingMeta } {
  model = trimInteriorEnds(alignUpperWalls(model));
  const mb = new MeshBuilder();
  const meta: BuildingMeta = { bbox: new THREE.Box3(), rooms: [], wallTop: [], outlines: [], topY: 0, doorLeaves: [], doors: [], sashes: [] };
  const ext = opts.exterior;
  const spec = opts.spec ?? BUILDER_SPECS[0];
  const cutF = opts.cut ? model.floors.find((f) => f.level === opts.cut!.level) : undefined;
  mb.clip = opts.clip ?? (cutF ? topClip(cutF.elevation * MM + (opts.cut!.height ?? CUT_HEIGHT)) : null);
  partClip = mb.clip;
  const entranceWalls = new Set<string>();
  // 玄関のある壁と、その上階の同じ位置の壁（縦のアクセント帯）
  const entranceRanges: { a: THREE.Vector2; b: THREE.Vector2 }[] = [];
  for (const f of model.floors)
    for (const o of f.openings)
      if (o.kind === 'entrance') {
        const w = f.walls.find((w) => w.id === o.wallId);
        if (w) {
          entranceWalls.add(w.id);
          entranceRanges.push({ a: new THREE.Vector2(w.a.x, w.a.y), b: new THREE.Vector2(w.b.x, w.b.y) });
        }
      }

  for (const f of model.floors) {
    // 輪切りでは切った階より上は作らない
    if (cutF && f.level > cutF.level) continue;
    const isTop = model.floors.indexOf(f) === model.floors.length - 1;
    const fl = f.elevation * MM;
    const top = wallTopOf(model, f, opts) * MM;
    meta.wallTop.push(top);
    meta.outlines.push({ level: f.level, y: fl, polys: f.outline.map((l) => l.map((p) => new THREE.Vector2(p.x * MM, p.y * MM))) });
    for (const r of f.rooms) {
      const poly = r.polygon.map((p) => new THREE.Vector2(p.x * MM, p.y * MM));
      meta.rooms.push({ room: r, floor: f, poly, center: V(r.labelPos.x * MM, fl, r.labelPos.y * MM), floorY: fl });
    }

    // ---- 壁 ----
    // 図面の柱の印（壁の厚みほどの短い線分）が外壁の外に少し出ていると、外観に細い柱が飛び出して見える → 3D では省く
    const outlineDist = (p: { x: number; y: number }) => {
      let d = Infinity;
      for (const l of f.outline)
        for (let i = 0; i < l.length; i++) {
          const a = l[i];
          const b = l[(i + 1) % l.length];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const L2 = dx * dx + dy * dy || 1;
          const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
          d = Math.min(d, Math.hypot(p.x - a.x - dx * u, p.y - a.y - dy * u));
        }
      return d;
    };
    const stub = (w: Wall) => {
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (L > Math.max(160, w.thickness * 1.6) || !f.outline.length) return false;
      const m = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
      return !f.outline.some((l) => pointInPolygon(m, l)) && outlineDist(m) < 200;
    };
    const pieces: { w: Wall; ops: Opening[] }[] = [];
    // 吹抜の縁の手すりは、壁ごと・辺ごとの区間を集めて、つながるものを 1 本にまとめてから作る
    beginGuards();
    for (const w0 of f.walls) {
      if (stub(w0)) continue;
      // 仕様に合わせて開口の高さを調整（フルハイトドア・サッシ上端＝天井）
      const ops0 = f.openings
        .filter((o) => o.wallId === w0.id)
        .map((o) => ({ ...o, ...effectiveOpening(o, f.ceilingHeight, spec) }))
        .sort((a, b) => a.t0 - b.t0);
      pieces.push(...splitAtVoid(f, w0, ops0).flatMap((p) => splitAtBalcony(f, p.w, p.ops)));
    }
    for (const { w, ops } of pieces) {
      // 壁ごとの指定（3D でクリックして決めた仕上げ）が最優先。無ければテイストの決まり（上階だけ・下階だけ・玄関の柱型）
      const accentHere =
        w.accent ??
        (!!ext.accent &&
          ((ext.accentRule === 'upper' && f.level >= 2) ||
            (ext.accentRule === 'lower' && f.level === 1) ||
            (ext.accentRule === 'entrance' && w.exterior && isEntranceColumn(w, entranceRanges))));
      buildWall(mb, f, w, ops, fl, top, accentHere ? 'ext.accent' : 'ext.wall', isTop, spec);
      for (const o of ops) buildOpening(mb, f, w, o, fl, meta, spec, upperOutlinesOf(model, f));
    }
    // 吹抜の縁（壁の無い所）の落下防止
    buildVoidGuardsOnOpenEdges(mb, f, fl, spec);
    flushGuards(mb);
    // 手で足した庇
    buildCanopies(mb, model, f, fl);
    // 斜めの壁の継ぎ目（外側の角のくさび状の隙間）を丸柱で埋める
    for (const j of diagonalJoints(f.walls.filter((w) => !stub(w)))) {
      const w = j.w;
      const outdoorAt = (x: number, y: number) => {
        const r = roomAt(f, x, y);
        return !r || outdoorRoom(r);
      };
      const bothOutdoor = w.exterior && [1, -1].every((sg) => outdoorAt(j.p.x + ((w.b.y - w.a.y) / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)) * -sg * (w.thickness + 80), j.p.y + ((w.b.x - w.a.x) / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)) * sg * (w.thickness + 80)));
      const bottom = w.exterior && f.level === 1 ? (bothOutdoor ? -0.05 : fl - 0.1) : fl;
      // 丸柱の高さは、つながる 2 本の壁に合わせる。以前はいつも天井までだったので、吹抜の曲がった手すり（壁は手すりに
      // 置き換わって無い）や曲がった腰壁の継ぎ目に、天井までの柱の列が残っていた（林様邸 2 階の吹抜まわり）
      const tw = jointTop(f, w, fl, spec);
      const tv = jointTop(f, j.v, fl, spec);
      if (tw === null && tv === null) continue; // 両方とも手すり（壁が無い）: 柱を立てない
      const lowTop = typeof tw === 'number' && typeof tv === 'number' ? Math.min(tw, tv) : typeof tw === 'number' && tv === null ? tw : typeof tv === 'number' && tw === null ? tv : null;
      const wallTop = lowTop ?? (w.exterior ? top : fl + f.ceilingHeight * MM);
      const key = w.exterior ? (ext.accent && ((ext.accentRule === 'upper' && f.level >= 2) || (ext.accentRule === 'lower' && f.level === 1)) ? 'ext.accent' : 'ext.wall') : 'int.wall';
      mb.cylinder(key, V(j.p.x * MM, bottom, j.p.y * MM), (j.t * MM) / 2 - 0.002, wallTop - bottom, 24, false);
    }

    // ---- 床 ----
    const voids = stairVoidsFor(model, f);
    // ビルトインガレージは土間（GL+40）。家の床（FL）の高さにすると車の乗り入れ口に基礎の立ち上がり分の段差ができる
    const garageRects = f.level === 1 ? polygonToRects(f.rooms.filter(isBuiltinGarage).map((r) => r.polygon)) : [];
    for (const r of f.rooms) {
      if (r.type === 'void') continue;
      // 外構・後付け／離れのガレージは地面の高さ（家の床の高さではない）
      if (f.level === 1 && (outdoorRoom(r) && r.type !== 'balcony' && r.type !== 'porch')) {
        buildAnnexFloor(mb, f, r, fl);
        continue;
      }
      if (f.level === 1 && isBuiltinGarage(r)) {
        emitFlat(mb, 'ext.concrete', r.polygon, voids, GARAGE_FLOOR_Y, true);
        continue;
      }
      const key = floorKeyFor(r);
      const offMm = roomFloorOffsetMm(r);
      if (offMm !== 0) {
        // 床の段差（玄関の土間 −180・小上がり +400・ダウンリビング −400 など）: その高さに床を張り、縁に蹴込みと框
        const y = fl + offMm * MM;
        emitFlat(mb, key, r.polygon, voids, y, true);
        emitSlab(mb, 'int.slab', r.polygon, voids, fl - 0.24, y - 0.005, offMm > 0 ? 'int.wall' : 'ext.wall');
        buildStepEdges(mb, f, r, fl);
        continue;
      }
      emitFlat(mb, key, r.polygon, voids, fl, true);
    }
    // 構造スラブ（断面表示・光漏れ防止）
    // 中庭などの穴の部分・ガレージの土間にはスラブを張らない。玄関の土間は上で下げて張った
    const holes = f.outline.filter((l) => isHoleLoop(l, f.outline));
    const domaRects = polygonToRects(f.rooms.filter((r) => r.type !== 'void' && roomFloorOffsetMm(r) !== 0).map((r) => r.polygon));
    const holeRects = [...(holes.length ? polygonToRects(holes) : []), ...garageRects, ...domaRects];
    const lower = model.floors[model.floors.indexOf(f) - 1];
    const lowerRects = lower ? polygonToRects(lower.outline.filter((l) => !isHoleLoop(l, lower.outline))) : [];
    for (const poly of f.outline) {
      if (holes.includes(poly)) continue;
      // 外周の小口は外から見える（2階の跳ね出しの下など）ので外壁の仕上げ。吹抜・階段の穴の縁には、下の階の天井からこの階の床まで幕板を張る
      const fasciaY0 = lower ? Math.min(fl - 0.24, lower.elevation * MM + lower.ceilingHeight * MM) : fl - 0.24;
      emitSlab(mb, 'int.slab', poly, [...voids, ...holeRects], fl - 0.24, fl - 0.005, 'ext.wall', lower ? { rects: voids, y0: fasciaY0, y1: fl } : undefined);
      // 下階からはみ出した部分（オーバーハング・ピロティの天井）は軒天の仕上げで見せる
      if (lower) emitFlat(mb, 'ext.soffit', poly, [...voids, ...holeRects, ...lowerRects], fl - 0.25, false);
    }
    // ---- 天井 ----
    const upper = model.floors[model.floors.indexOf(f) + 1];
    const ceilVoids = upper ? stairVoidsFor(model, upper) : [];
    for (const r of f.rooms) {
      if (f.level === 1 && (isSeparateGarage(r) || isExteriorWorks(r.type))) {
        // 家と別に建つガレージ・物置の屋根、カーポートの屋根（デッキ・テラス・駐車場は空に開く）
        buildAnnexRoof(mb, f, r);
        continue;
      }
      if (r.type === 'void') {
        // 吹抜の上（この階の天井の高さ）にも天井を張る。以前は張っておらず、1 階から見上げると屋根の裏（黒い板金）が見えていた。
        // 1 階の中庭（空に開いた区画）には張らない
        if (f.level >= 2) emitFlat(mb, 'int.ceiling', r.polygon, ceilVoids, fl + f.ceilingHeight * MM, false);
        continue;
      }
      if (r.type === 'balcony' || r.type === 'porch') {
        // 屋根・上階の下に入るバルコニー・ポーチの天井は軒天（木目など）。中庭は空に開く
        if (/庭|COURT/i.test(r.name)) continue;
        // 空に開いたバルコニー（ルーフバルコニー・上の階を欠いて作ったバルコニー）は、上の階が載る所にだけ軒天を張る
        if (isOpenSkyBalcony(model.floors, model.floors.indexOf(f), r)) {
          const above = polygonToRects(model.floors.slice(model.floors.indexOf(f) + 1).flatMap((h) => h.outline.filter((l) => !isHoleLoop(l, h.outline))));
          const bb = bboxOf(r.polygon);
          const covered = above.some((a) => Math.min(a.maxX, bb.maxX) - Math.max(a.minX, bb.minX) > 50 && Math.min(a.maxY, bb.maxY) - Math.max(a.minY, bb.minY) > 50);
          if (covered) emitFlat(mb, 'ext.soffit', r.polygon, rectsMinus([{ minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY }], above), top - 0.25, false);
          continue;
        }
        emitFlat(mb, 'ext.soffit', r.polygon, [], top - (upper ? 0.25 : 0.02), false);
        continue;
      }
      // LDK の天井は別の素材にできる（コーディネートの「天井」で板張りを選ぶと LDK だけに張る）
      emitFlat(mb, MAIN_CEILING_ROOMS.has(r.type) ? 'int.ceilingMain' : 'int.ceiling', r.polygon, ceilVoids, fl + roomCeilingMm(f, r) * MM, false);
    }
    // ---- 天井の設備（ダウンライト・間接照明） ----
    buildCeilingDetails(mb, f, fl, spec, ceilVoids);
    // ---- 階段 ----
    for (const s of f.stairs) {
      if (!s.goesUp || !upper) continue;
      buildStairs(mb, s, fl, upper.elevation * MM, f, opts.stairBuild);
    }
  }

  // ---- 基礎 ----
  const f1 = model.floors[0];
  if (f1) {
    // シャッターの口（車の乗り入れ口）には基礎の立ち上がりを出さない: 土間から道路へ段差なしで続く
    const gaps = shutterGaps(f1);
    /** 線分 A→B（m）を、シャッターの口に重なる部分を除いた区間に分ける */
    const splitByGaps = (A: THREE.Vector3, B: THREE.Vector3): [number, number][] => {
      const L = A.distanceTo(B);
      if (L < 0.01) return [];
      const dir = new THREE.Vector3().subVectors(B, A).normalize();
      const cut: [number, number][] = [];
      for (const g of gaps) {
        // 平行で近い（30cm 以内）口だけ
        if (Math.abs(g.dir.dot(dir)) < 0.95) continue;
        const d0 = Math.abs(new THREE.Vector3().subVectors(g.a, A).cross(dir).length());
        if (d0 > 0.3) continue;
        const s0 = new THREE.Vector3().subVectors(g.a, A).dot(dir);
        const s1 = new THREE.Vector3().subVectors(g.b, A).dot(dir);
        const lo = Math.max(0, Math.min(s0, s1));
        const hi = Math.min(L, Math.max(s0, s1));
        if (hi > lo) cut.push([lo, hi]);
      }
      cut.sort((p, q) => p[0] - q[0]);
      const out: [number, number][] = [];
      let cur = 0;
      for (const [lo, hi] of cut) {
        if (lo > cur + 0.01) out.push([cur, lo]);
        cur = Math.max(cur, hi);
      }
      if (cur < L - 0.01) out.push([cur, L]);
      return out;
    };
    // 外形の外に立つ外壁（中庭・ポーチの囲い、外形の切り欠きに沿う壁）にも基礎を付ける。外形に沿った基礎より
    // わずかに細くし、同じ面が重ならないようにする（外形の基礎がある所では中に隠れる）
    for (const w of f1.walls) {
      if (!w.exterior) continue;
      const A = V(w.a.x * MM, 0, w.a.y * MM);
      const B = V(w.b.x * MM, 0, w.b.y * MM);
      const L = A.distanceTo(B);
      if (L < 0.05) continue;
      const dir = new THREE.Vector3().subVectors(B, A).normalize();
      // 壁の軸線は接合先の壁の外面まで延ばしてあるので、帯は壁と同じ長さで角が閉じる。細くした分（片側 15mm）だけ
      // 端も引っ込め、接合先の帯の面と揃える（斜めの接合は下の丸柱で埋める）
      for (const [s0, s1] of splitByGaps(A, B)) {
        const a0 = s0 === 0 ? 0.015 : s0;
        const a1 = s1 === L ? L - 0.015 : s1;
        if (a1 - a0 < 0.02) continue;
        const c = A.clone().addScaledVector(dir, (a0 + a1) / 2).setY(-0.06);
        mb.box('ext.foundation', c, dir, a1 - a0, f1.elevation * MM - 0.1 + 0.06, w.thickness * MM - 0.03);
      }
    }
    for (const j of diagonalJoints(f1.walls, true)) {
      mb.cylinder('ext.foundation', V(j.p.x * MM, -0.06, j.p.y * MM), (j.t * MM - 0.03) / 2 - 0.001, f1.elevation * MM - 0.1 + 0.06, 24, false);
    }
    const extT = Math.max(150, ...f1.walls.filter((w) => w.exterior).map((w) => w.thickness)) * MM;
    for (const poly of f1.outline) {
      const off = offsetPolygon(poly.map((p) => ({ x: p.x * MM, y: p.y * MM })), extT / 2 - 0.012);
      for (let i = 0; i < off.length; i++) {
        const a = off[i];
        const b = off[(i + 1) % off.length];
        // 外向きに表を向ける（offsetPolygon と同じ向き判定）
        const n = new THREE.Vector3(b.y - a.y, 0, -(b.x - a.x));
        const center = new THREE.Vector3((a.x + b.x) / 2, 0, (a.y + b.y) / 2);
        const inside = pointInPolygon({ x: center.x + n.x * 0.01, y: center.z + n.z * 0.01 }, off);
        const A = V(a.x, 0, a.y);
        const B = V(b.x, 0, b.y);
        const dir = new THREE.Vector3().subVectors(B, A).normalize();
        for (const [s0, s1] of splitByGaps(A, B)) {
          const p0 = A.clone().addScaledVector(dir, s0);
          const p1 = A.clone().addScaledVector(dir, s1);
          const pa = p0.clone().setY(-0.05);
          const pb = p1.clone().setY(-0.05);
          const ta = p0.clone().setY(f1.elevation * MM - 0.1);
          const tb = p1.clone().setY(f1.elevation * MM - 0.1);
          if (inside) mb.quad('ext.foundation', pa, pb, tb, ta);
          else mb.quad('ext.foundation', pb, pa, ta, tb);
        }
      }
      // 水切り（基礎天端の帯）
      const w2 = offsetPolygon(poly.map((p) => ({ x: p.x * MM, y: p.y * MM })), extT / 2 + 0.01);
      const y = f1.elevation * MM - 0.1;
      for (let i = 0; i < w2.length; i++) {
        const a = w2[i];
        const b = w2[(i + 1) % w2.length];
        const n = new THREE.Vector3(b.y - a.y, 0, -(b.x - a.x));
        const center = new THREE.Vector3((a.x + b.x) / 2, 0, (a.y + b.y) / 2);
        const inside = pointInPolygon({ x: center.x + n.x * 0.01, y: center.z + n.z * 0.01 }, w2);
        const A = V(a.x, 0, a.y);
        const B = V(b.x, 0, b.y);
        const dir = new THREE.Vector3().subVectors(B, A).normalize();
        for (const [s0, s1] of splitByGaps(A, B)) {
          const p0 = A.clone().addScaledVector(dir, s0);
          const p1 = A.clone().addScaledVector(dir, s1);
          const pa = p0.clone().setY(y - 0.03);
          const pb = p1.clone().setY(y - 0.03);
          const ta = p0.clone().setY(y + 0.005);
          const tb = p1.clone().setY(y + 0.005);
          if (inside) mb.quad('ext.frame', pa, pb, tb, ta);
          else mb.quad('ext.frame', pb, pa, ta, tb);
        }
      }
    }
  }

  // 柱（修正画面で置いた柱のうち、壁から離れて立つもの。壁の中の柱は壁に隠れる）
  for (const f of model.floors) {
    if (cutF && f.level > cutF.level) continue;
    const outer = f.outline.filter((l) => l.length >= 3);
    for (const p of f.posts ?? []) {
      if (postInWall(p, f.walls)) continue;
      const { y0, y1 } = postSpan(model, f, p);
      // 外（外形の外 = 張り出しの足元・ポーチ）の柱は外壁の仕上げ、室内の柱は内壁の仕上げ
      const outside = !outer.some((l) => pointInPolygon(p, l));
      const key = outside ? 'ext.wall' : 'int.wall';
      // 1 階の外の柱は地面（GL）の独立基礎の上から立つ（室内の柱は床の上から）
      const plinth = f.level === 1 && outside ? 0.15 : 0;
      const yb = f.level === 1 && outside ? plinth : y0 * MM;
      const hgt = y1 * MM - yb;
      if (plinth) mb.box('ext.foundation', V(p.x * MM, -0.05, p.y * MM), V(1, 0, 0), p.size * MM + 0.12, plinth + 0.05, p.size * MM + 0.12);
      const base = V(p.x * MM, yb, p.y * MM);
      if (p.round) mb.cylinder(key, base, (p.size * MM) / 2, hgt, 20, true);
      else mb.box(key, base, V(1, 0, 0), p.size * MM, hgt, p.size * MM);
    }
  }

  // bbox
  for (const f of model.floors)
    for (const w of f.walls) {
      meta.bbox.expandByPoint(V(w.a.x * MM, 0, w.a.y * MM));
      meta.bbox.expandByPoint(V(w.b.x * MM, 0, w.b.y * MM));
    }
  meta.topY = Math.max(...meta.wallTop);
  meta.bbox.max.y = meta.topY;
  return { mb, meta };
}

function isEntranceColumn(w: Wall, ranges: { a: THREE.Vector2; b: THREE.Vector2 }[]): boolean {
  for (const r of ranges) {
    const d1 = distToLine(w.a, r.a, r.b);
    const d2 = distToLine(w.b, r.a, r.b);
    if (d1 > 120 || d2 > 120) continue;
    // 範囲が重なる
    const dir = new THREE.Vector2().subVectors(r.b, r.a).normalize();
    const t = (p: { x: number; y: number }) => (p.x - r.a.x) * dir.x + (p.y - r.a.y) * dir.y;
    const L = r.a.distanceTo(r.b);
    const w0 = Math.min(t(w.a), t(w.b));
    const w1 = Math.max(t(w.a), t(w.b));
    if (Math.min(w1, L) - Math.max(w0, 0) > 300) return true;
  }
  return false;
}

function distToLine(p: { x: number; y: number }, a: THREE.Vector2, b: THREE.Vector2) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L;
}

/** 外構・後付け／離れのガレージの床（地面の高さ。デッキは家の床の少し下、テラスは 1 段上がり） */
function buildAnnexFloor(mb: MeshBuilder, f: Floor, r: Room, fl: number) {
  if (r.type === 'deck') {
    const y = Math.max(0.2, fl - 0.05);
    emitSlab(mb, 'ext.balcony', r.polygon, [], 0.02, y, 'ext.balcony');
    emitFlat(mb, 'ext.balcony', r.polygon, [], y, true);
    return;
  }
  if (r.type === 'terrace') {
    const y = Math.min(0.15, fl - 0.05);
    emitSlab(mb, 'ext.terrace', r.polygon, [], 0.0, y, 'ext.foundation');
    emitFlat(mb, 'ext.terrace', r.polygon, [], y, true);
    return;
  }
  emitFlat(mb, 'ext.concrete', r.polygon, [], 0.03, true);
  void f;
}

/** 部屋の外形の辺のうち、壁の無い区間（ガレージの出入口）。戻り値は mm の線分 */
function openEdges(f: Floor, r: Room, minLen = 1800): { a: { x: number; y: number }; b: { x: number; y: number } }[] {
  const out: { a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
  const P = r.polygon;
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < minLen) continue;
    const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    const cov: [number, number][] = [];
    for (const w of f.walls) {
      const tol = w.thickness / 2 + 150;
      const off = (q: { x: number; y: number }) => Math.abs((q.x - a.x) * -u.y + (q.y - a.y) * u.x);
      if (off(w.a) > tol || off(w.b) > tol) continue;
      const ta = (w.a.x - a.x) * u.x + (w.a.y - a.y) * u.y;
      const tb = (w.b.x - a.x) * u.x + (w.b.y - a.y) * u.y;
      const s0 = Math.max(0, Math.min(ta, tb));
      const s1 = Math.min(L, Math.max(ta, tb));
      if (s1 > s0) cov.push([s0, s1]);
    }
    cov.sort((p, q) => p[0] - q[0]);
    let cur = 0;
    const gaps: [number, number][] = [];
    for (const [s0, s1] of cov) {
      if (s0 > cur) gaps.push([cur, s0]);
      cur = Math.max(cur, s1);
    }
    if (cur < L) gaps.push([cur, L]);
    for (const [s0, s1] of gaps) if (s1 - s0 >= minLen) out.push({ a: { x: a.x + u.x * s0, y: a.y + u.y * s0 }, b: { x: a.x + u.x * s1, y: a.y + u.y * s1 } });
  }
  return out;
}

/** 後付け／離れのガレージ・物置の陸屋根とシャッター、カーポートの柱と屋根 */
function buildAnnexRoof(mb: MeshBuilder, f: Floor, r: Room) {
  const poly = r.polygon.map((p) => ({ x: p.x * MM, y: p.y * MM }));
  if (isSeparateGarage(r) || r.type === 'shed') {
    const H = r.type === 'shed' ? SHED_HEIGHT : GARAGE_HEIGHT;
    // 屋根は壁の外面まで（壁芯の外形を壁厚の半分だけ広げる）
    const t = Math.max(0.1, ...f.walls.map((w) => w.thickness * MM)) / 2;
    const roof = offsetPolygon(poly, t).map((p) => ({ x: p.x / MM, y: p.y / MM }));
    emitSlab(mb, 'ext.soffit', roof, [], H - 0.12, H + 0.05, 'ext.wall');
    emitFlat(mb, 'ext.roof', roof, [], H + 0.05, true);
    // 出入口（壁の無い辺）にシャッターと、その上の垂れ壁
    for (const e of openEdges(f, r)) {
      const A = V(e.a.x * MM, 0, e.a.y * MM);
      const B = V(e.b.x * MM, 0, e.b.y * MM);
      const L = A.distanceTo(B);
      const dir = new THREE.Vector3().subVectors(B, A).normalize();
      const mid = A.clone().addScaledVector(dir, L / 2);
      const head = Math.min(H - 0.45, 2.5);
      mb.box('ext.shutter', mid.clone().setY(0.02), dir, L, head - 0.02, 0.05);
      // シャッターボックス（まぐさ）
      mb.box('ext.wall', mid.clone().setY(head), dir, L, H - 0.12 - head, t * 2);
      // スラット（横の目地）: 細い溝を数本
      for (let y = 0.25; y < head - 0.1; y += 0.25) mb.box('ext.frame', mid.clone().setY(y), dir, L - 0.04, 0.008, 0.056);
    }
    return;
  }
  if (r.type === 'carport') {
    // 柱（四隅。長い辺は 3 本）と薄い屋根
    const xs = poly.map((p) => p.x);
    const zs = poly.map((p) => p.y);
    const x0 = Math.min(...xs) + 0.15;
    const x1 = Math.max(...xs) - 0.15;
    const z0 = Math.min(...zs) + 0.15;
    const z1 = Math.max(...zs) - 0.15;
    const H = 2.5;
    const longX = x1 - x0 >= z1 - z0;
    const n = Math.max(x1 - x0, z1 - z0) > 6.5 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const s = i / (n - 1);
      for (const side of [0, 1]) {
        const p = longX ? V(x0 + (x1 - x0) * s, 0, side ? z1 : z0) : V(side ? x1 : x0, 0, z0 + (z1 - z0) * s);
        mb.box('ext.canopy', p, V(1, 0, 0), 0.08, H, 0.08);
      }
    }
    const roof = offsetPolygon(poly, 0.15).map((p) => ({ x: p.x / MM, y: p.y / MM }));
    emitSlab(mb, 'ext.canopy', roof, [], H, H + 0.12, 'ext.canopy');
    emitFlat(mb, 'ext.canopy', roof, [], H + 0.12, true);
  }
}

export function floorKeyFor(r: Room): string {
  if (r.floorFinish) return { wood: 'int.floor', tile: 'int.wetFloor', tatami: 'int.tatami', doma: 'int.entranceFloor' }[r.floorFinish];
  switch (r.type) {
    case 'bath':
    case 'washroom':
    case 'toilet':
      return 'int.wetFloor';
    case 'entrance':
    case 'porch':
    case 'garage':
      return 'int.entranceFloor';
    case 'japanese':
      return 'int.tatami';
    case 'balcony':
      return 'ext.balcony';
    default:
      return 'int.floor';
  }
}

/** 水平な面（床・天井）。直交多角形なら穴（階段・吹抜）を矩形で抜く */
function emitFlat(mb: MeshBuilder, key: string, polyMm: { x: number; y: number }[], voidsMm: Rect[], y: number, faceUp: boolean) {
  const n = faceUp ? up : up.clone().negate();
  const uA = V(1, 0, 0);
  const vA = V(0, 0, 1);
  if (isRectilinear(polyMm, 2)) {
    let rects = polygonToRects([polyMm], 3);
    rects = rectsMinus(rects, voidsMm);
    for (const r of rects) {
      const a = V(r.minX * MM, y, r.minY * MM);
      const b = V(r.maxX * MM, y, r.minY * MM);
      const c = V(r.maxX * MM, y, r.maxY * MM);
      const d = V(r.minX * MM, y, r.maxY * MM);
      if (faceUp) mb.quad(key, a, d, c, b, uA, vA);
      else mb.quad(key, a, b, c, d, uA, vA);
    }
  } else {
    // 斜めの辺・曲線のある部屋も、階段・吹抜の穴を抜く（以前は矩形の部屋だけ抜いていたので、
    // 2cm 斜めに読めた階段の部屋で 2 階の床が階段の穴を塞いでいた）
    for (const piece of polygonMinusRects(polyMm, voidsMm)) {
      const pts = piece.map((p) => V(p.x * MM, y, p.y * MM));
      mb.polygon(key, pts, n, uA, vA);
    }
  }
}

type P2 = { x: number; y: number };
/** 多角形を半平面で切る（Sutherland–Hodgman）。axis の値が v 以下（keepLess）／以上の側を残す */
function clipHalf(poly: P2[], axis: 'x' | 'y', v: number, keepLess: boolean): P2[] {
  const out: P2[] = [];
  const inside = (p: P2) => (keepLess ? p[axis] <= v : p[axis] >= v);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ia = inside(a);
    const ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (v - a[axis]) / (b[axis] - a[axis]);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

function polyArea(p: P2[]) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** 多角形から矩形（mm）を引く。矩形の外側を 4 つの凸な領域（左・右・下・上の帯）に分けて、それぞれで切り出す */
export function polygonMinusRects(poly: P2[], rects: Rect[]): P2[][] {
  let pieces: P2[][] = [poly];
  for (const r of rects) {
    const next: P2[][] = [];
    for (const pc of pieces) {
      const xs = pc.map((p) => p.x);
      const ys = pc.map((p) => p.y);
      if (Math.max(...xs) <= r.minX || Math.min(...xs) >= r.maxX || Math.max(...ys) <= r.minY || Math.min(...ys) >= r.maxY) {
        next.push(pc);
        continue;
      }
      const regions: [('x' | 'y'), number, boolean][][] = [
        [['x', r.minX, true]],
        [['x', r.maxX, false]],
        [['x', r.minX, false], ['x', r.maxX, true], ['y', r.minY, true]],
        [['x', r.minX, false], ['x', r.maxX, true], ['y', r.maxY, false]],
      ];
      for (const reg of regions) {
        let c = pc;
        for (const [ax, v, less] of reg) {
          c = clipHalf(c, ax, v, less);
          if (c.length < 3) break;
        }
        if (c.length >= 3 && polyArea(c) > 100) next.push(c);
      }
    }
    pieces = next;
  }
  return pieces;
}

/**
 * @param fascia 吹抜・階段の穴の縁に張る小口（幕板）: rects = 穴（この縁にだけ張る）、y0 = 下端（下の階の天井の高さ）、y1 = 上端（この階の床の高さ）。
 *   張らないと、下の階から穴の縁を見上げたときに、床の厚みと天井懐のすき間から上の階の部屋の中（家具の裏）が見える
 */
function emitSlab(mb: MeshBuilder, key: string, polyMm: { x: number; y: number }[], voidsMm: Rect[], y0: number, y1: number, edgeKey = key, fascia?: { rects: Rect[]; y0: number; y1: number }) {
  emitFlat(mb, key, polyMm, voidsMm, y0, false);
  if (fascia?.rects.length) {
    const inHole = (x: number, y: number) => fascia.rects.some((r) => x > r.minX && x < r.maxX && y > r.minY && y < r.maxY);
    const toPoly = (r: Rect): P2[] => [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY }, { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY }];
    const pieces: P2[][] = isRectilinear(polyMm, 2) ? rectsMinus(polygonToRects([polyMm], 3), voidsMm).map(toPoly) : polygonMinusRects(polyMm, voidsMm);
    for (const pc of pieces) {
      for (let i = 0; i < pc.length; i++) {
        const a = pc[i];
        const b = pc[(i + 1) % pc.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 5) continue;
        const nx = (b.y - a.y) / len;
        const ny = -(b.x - a.x) / len;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        // 部品の外向きを求め、その先が穴（吹抜・階段）のときだけ張る（部品どうしの継ぎ目・外周には張らない）
        const insidePiece = pointInPolygon({ x: mx + nx * 10, y: my + ny * 10 }, pc);
        const ox = insidePiece ? -nx : nx;
        const oy = insidePiece ? -ny : ny;
        if (!inHole(mx + ox * 10, my + oy * 10)) continue;
        const pa = V(a.x * MM, fascia.y0, a.y * MM);
        const pb = V(b.x * MM, fascia.y0, b.y * MM);
        const ta = V(a.x * MM, fascia.y1, a.y * MM);
        const tb = V(b.x * MM, fascia.y1, b.y * MM);
        if (insidePiece) mb.quad('int.wall', pa, pb, tb, ta);
        else mb.quad('int.wall', pb, pa, ta, tb);
      }
    }
  }
  const pts = polyMm.map((p) => ({ x: p.x * MM, y: p.y * MM }));
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const nrm = new THREE.Vector3(b.y - a.y, 0, -(b.x - a.x)).normalize();
    const mid = { x: (a.x + b.x) / 2 + nrm.x * 0.01, y: (a.y + b.y) / 2 + nrm.z * 0.01 };
    const inside = pointInPolygon(mid, pts);
    const pa = V(a.x, y0, a.y);
    const pb = V(b.x, y0, b.y);
    const ta = V(a.x, y1, a.y);
    const tb = V(b.x, y1, b.y);
    if (inside) mb.quad(edgeKey, pa, pb, tb, ta);
    else mb.quad(edgeKey, pb, pa, ta, tb);
  }
}


/** 吹抜に面する壁（片側が吹抜、反対側がホール・LDK など開いた部屋）なら、その縁の落下防止の種類。そうでなければ null */
export function voidGuardOfWall(f: Floor, w: Wall, spec: BuilderSpec): VoidGuard | null {
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  if (f.level < 2 || w.exterior || L < 1) return null;
  const nx = -(w.b.y - w.a.y) / L;
  const ny = (w.b.x - w.a.x) / L;
  const side = (sign: 1 | -1) => roomAt(f, (w.a.x + w.b.x) / 2 + nx * sign * (w.thickness / 2 + 80), (w.a.y + w.b.y) / 2 + ny * sign * (w.thickness / 2 + 80));
  const rPlus = side(1);
  const rMinus = side(-1);
  const voidPlus = rPlus?.type === 'void';
  const voidMinus = rMinus?.type === 'void';
  if (voidPlus === voidMinus || outdoorRoom(rPlus) || outdoorRoom(rMinus)) return null;
  const other = voidPlus ? rMinus : rPlus;
  if (!other || !['hall', 'ldk', 'living', 'dining', 'kitchen', 'stairs', 'entrance', 'other'].includes(other.type)) return null;
  return guardKindOf(voidPlus ? rPlus : rMinus, spec);
}

/**
 * 継ぎ目の丸柱の天端（m）を決めるための、壁 1 本の高さ:
 * null = 手すり（鉄・アイアン・ガラス）に置き換わって壁が無い／数値 = 腰壁・手すり壁の天端／undefined = 天井まで（今までどおり）
 */
function jointTop(f: Floor, w: Wall, fl: number, spec: BuilderSpec): number | null | undefined {
  if (w.exterior) return undefined;
  const guard = voidGuardOfWall(f, w, spec);
  if (guard === 'steel' || guard === 'iron' || guard === 'glass') return null;
  if (w.topMm != null) return fl + Math.max(300, w.topMm) * MM;
  if (guard === 'half') return fl + 1.1;
  if (guard === 'halfGlass') return fl + 0.9;
  return undefined;
}

/**
 * 斜めの壁（直交しない壁同士）の継ぎ目。角が直角でないと、矩形の壁同士では外側の角にくさび状の隙間が残るので、
 * 壁の軸線の交点に壁厚の丸柱を立てて埋める。戻り値は交点と、その継ぎ目の最大壁厚（mm）。
 */
function diagonalJoints(walls: Wall[], onlyExterior = false): { p: { x: number; y: number }; t: number; w: Wall; v: Wall }[] {
  const out: { p: { x: number; y: number }; t: number; w: Wall; v: Wall }[] = [];
  const angOf = (w: Wall) => Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x);
  const distToSeg = (p: { x: number; y: number }, w: Wall) => {
    const dx = w.b.x - w.a.x;
    const dy = w.b.y - w.a.y;
    const L2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((p.x - w.a.x) * dx + (p.y - w.a.y) * dy) / L2));
    return Math.hypot(p.x - w.a.x - dx * u, p.y - w.a.y - dy * u);
  };
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    if (onlyExterior && !w.exterior) continue;
    for (let j = 0; j < walls.length; j++) {
      if (i === j) continue;
      const v = walls[j];
      if (onlyExterior && !v.exterior) continue;
      // 直交・平行は矩形同士で納まる
      let d = Math.abs(angOf(w) - angOf(v)) % (Math.PI / 2);
      d = Math.min(d, Math.PI / 2 - d);
      if (d < (3 * Math.PI) / 180) continue;
      for (const e of [w.a, w.b]) {
        if (distToSeg(e, v) > w.thickness + v.thickness) continue;
        // 軸線の交点
        const r = { x: w.b.x - w.a.x, y: w.b.y - w.a.y };
        const q = { x: v.b.x - v.a.x, y: v.b.y - v.a.y };
        const den = r.x * q.y - r.y * q.x;
        let p = e;
        if (Math.abs(den) > 1e-6) {
          const tt = ((v.a.x - w.a.x) * q.y - (v.a.y - w.a.y) * q.x) / den;
          const ip = { x: w.a.x + r.x * tt, y: w.a.y + r.y * tt };
          if (Math.hypot(ip.x - e.x, ip.y - e.y) < w.thickness + v.thickness) p = ip;
        }
        const t = Math.max(w.thickness, v.thickness);
        if (out.some((o) => Math.hypot(o.p.x - p.x, o.p.y - p.y) < t)) continue;
        out.push({ p, t, w, v });
      }
    }
  }
  return out;
}

/** 手すり型の落下防止の種類（腰壁・壁は壁として作る） */
type RailKind = 'steel' | 'iron' | 'glass';

/**
 * 吹抜・階段の降り口の手すりを、折れ線 pts（床 fl）に沿って作る。
 *  - steel: 御社の施工事例の形 = 黒の細いフラットバーのフレーム。支柱 FB-12×38 @ ≤1.2m、上の手すり FB-12×44（H1100）、中ほどに横桟 FB-9×25 を 1 本。
 *    縦桟を細かく並べた手すりは御社の事例には無い（縦格子にしたいときは iron）
 *  - iron: 縦格子。20mm 角の支柱 @ ≤1.2m、上に平鋼 40×12、φ12 の細い丸棒 @100（すき間 110 以下。小さなお子さまのいるご家庭向け）
 *  - glass: 30mm 角の支柱 @ ≤1.5m、t12 のガラス全面、上の縁に細い平鋼
 * 支柱は両端・角（向きが 30° 以上変わる頂点）と、その間を等分した位置にだけ立てる
 * （曲がった縁を短い線分で読んだ図面でも、線分ごとに支柱が並ばない）
 */
function buildGuardPath(mb: MeshBuilder, kind: RailKind, pts: THREE.Vector3[], fl: number, key = 'f.metal') {
  // 同じ点の重なり・一直線上の途中の点を除く
  const P: THREE.Vector3[] = [];
  for (const p0 of pts) {
    const p = p0.clone().setY(fl);
    if (P.length && P[P.length - 1].distanceTo(p) < 0.01) continue;
    if (P.length >= 2) {
      const d0 = P[P.length - 1].clone().sub(P[P.length - 2]).normalize();
      const d1 = p.clone().sub(P[P.length - 1]).normalize();
      if (d0.dot(d1) > 0.9994) P.pop(); // 2° 未満
    }
    P.push(p);
  }
  if (P.length < 2) return;
  const segL: number[] = [];
  const segD: THREE.Vector3[] = [];
  let total = 0;
  for (let k = 0; k + 1 < P.length; k++) {
    const d = P[k + 1].clone().sub(P[k]);
    const l = d.length();
    segL.push(l);
    segD.push(d.normalize());
    total += l;
  }
  if (total < 0.15) return;
  const H = 1.1;
  /** 折れ線上の距離 s の点と、その区間の向き */
  const at = (s: number): { p: THREE.Vector3; d: THREE.Vector3 } => {
    let acc = 0;
    for (let k = 0; k < segL.length; k++) {
      if (s <= acc + segL[k] || k === segL.length - 1) return { p: P[k].clone().addScaledVector(segD[k], Math.max(0, Math.min(segL[k], s - acc))), d: segD[k] };
      acc += segL[k];
    }
    return { p: P[0].clone(), d: segD[0] };
  };
  // 支柱の位置（折れ線上の距離）: 両端（30mm 内側）・角・その間を pitch 以下に等分
  const pitch = kind === 'glass' ? 1.5 : 1.2;
  const end = Math.min(0.03, total / 4);
  const stops: number[] = [end];
  let acc = 0;
  for (let k = 1; k < P.length - 1; k++) {
    acc += segL[k - 1];
    if (segD[k - 1].dot(segD[k]) < 0.866 && acc > stops[stops.length - 1] + 0.15 && acc < total - end - 0.15) stops.push(acc);
  }
  stops.push(total - end);
  const posts: number[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const n = Math.max(1, Math.ceil((stops[i + 1] - stops[i] - 0.001) / pitch));
    for (let j = 0; j < n; j++) posts.push(stops[i] + ((stops[i + 1] - stops[i]) * j) / n);
  }
  posts.push(stops[stops.length - 1]);
  const postT = kind === 'steel' ? 0.012 : kind === 'iron' ? 0.02 : 0.03;
  const postW = kind === 'steel' ? 0.038 : postT;
  for (const sPos of posts) {
    const { p, d } = at(sPos);
    mb.box(key, p, d, postT, H - 0.012, postW);
  }
  // 線分ごとの横材。途中の頂点では、角が欠けないように幅の半分だけ延ばす
  for (let k = 0; k < segL.length; k++) {
    const ext0 = k > 0 ? 1 : 0;
    const ext1 = k < segL.length - 1 ? 1 : 0;
    /** 長さ方向に、途中の頂点の側だけ e ずつ延ばした横材 */
    const along = (matKey: string, y: number, h: number, w: number, e: number, trim = 0) => {
      const L = segL[k] + (ext0 + ext1) * e - trim;
      if (L < 0.02) return;
      const mid = P[k].clone().addScaledVector(segD[k], segL[k] / 2 + ((ext1 - ext0) * e) / 2);
      mb.box(matKey, mid.setY(y), segD[k], L, h, w);
    };
    if (kind === 'steel') {
      along(key, fl + H - 0.012, 0.012, 0.044, 0.022); // 上の手すり（フラットバーを平らに）
      along(key, fl + 0.55, 0.009, 0.025, 0.012); // 横桟 1 本
    } else if (kind === 'iron') {
      along(key, fl + H - 0.012, 0.012, 0.04, 0.02);
    } else {
      along('ext.glass', fl + 0.05, H - 0.09, 0.012, 0, 0.02);
      along(key, fl + H - 0.012, 0.012, 0.04, 0.02);
    }
  }
  // 縦格子の丸棒
  if (kind === 'iron') for (let sPos = 0.1; sPos < total - 0.05; sPos += 0.1) mb.cylinder(key, at(sPos).p.setY(fl + 0.02), 0.006, H - 0.05, 8, false);
}

/** 吹抜の縁の手すりの区間。階ごとに集めて、端がつながる区間を 1 本の手すりにまとめてから作る */
interface GuardSeg {
  kind: RailKind;
  a: THREE.Vector3;
  b: THREE.Vector3;
  fl: number;
}
let guardSegs: GuardSeg[] | null = null;

/** これ以降の buildVoidGuard を集め始める（flushGuards でまとめて作る） */
function beginGuards() {
  guardSegs = [];
}

/** 集めた区間を、端がつながるものどうし 1 本の折れ線にまとめて作る（角・曲がった縁・途中で分かれた壁で、支柱が重ならないように） */
function flushGuards(mb: MeshBuilder) {
  const segs = guardSegs ?? [];
  guardSegs = null;
  // 辺ごとに室内側へ 60mm 寄せた区間どうしは、直角の角で端が 85mm 離れる
  const near = (p: THREE.Vector3, q: THREE.Vector3) => Math.hypot(p.x - q.x, p.z - q.z) < 0.1;
  /** 2 直線（p0→p1 と q0→q1）の交点（平面）。ほぼ平行なら null */
  const cross = (p0: THREE.Vector3, p1: THREE.Vector3, q0: THREE.Vector3, q1: THREE.Vector3): THREE.Vector3 | null => {
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const ex = q1.x - q0.x;
    const ez = q1.z - q0.z;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-6 * Math.hypot(dx, dz) * Math.hypot(ex, ez) + 1e-9) return null;
    const t = ((q0.x - p0.x) * ez - (q0.z - p0.z) * ex) / den;
    return new THREE.Vector3(p0.x + dx * t, p0.y, p0.z + dz * t);
  };
  const used = segs.map(() => false);
  /** 点 p に端が付く区間（self 以外。同じ種類・同じ階） */
  const touching = (p: THREE.Vector3, self: number) => segs.map((_, j) => j).filter((j) => j !== self && segs[j].kind === segs[self].kind && Math.abs(segs[j].fl - segs[self].fl) < 0.01 && (near(segs[j].a, p) || near(segs[j].b, p)));
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const pts = [segs[i].a.clone(), segs[i].b.clone()];
    // 両方向へ延ばす。3 本以上が集まる点（T 字）では止める
    for (const head of [false, true]) {
      let cur = i;
      for (;;) {
        const tip = head ? pts[0] : pts[pts.length - 1];
        const t = touching(tip, cur);
        if (t.length !== 1 || used[t[0]]) break;
        const j = t[0];
        used[j] = true;
        const [q0, q1] = near(segs[j].a, tip) ? [segs[j].a, segs[j].b] : [segs[j].b, segs[j].a];
        // 角: 2 本の線の交点に合わせる（端どうしが少し離れていても、手すりが辺と平行のまま角で出会う）
        const prev = head ? pts[1] : pts[pts.length - 2];
        const x = cross(prev, tip, q0, q1);
        if (x && Math.hypot(x.x - tip.x, x.z - tip.z) < 0.2) tip.copy(x);
        else if (!x && Math.hypot(q0.x - tip.x, q0.z - tip.z) > 0.01) {
          // 平行で少しずれている: 段を付けてつなぐ
          if (head) pts.unshift(q0.clone());
          else pts.push(q0.clone());
        }
        if (head) pts.unshift(q1.clone());
        else pts.push(q1.clone());
        cur = j;
      }
    }
    buildGuardPath(mb, segs[i].kind, pts, segs[i].fl);
  }
}

/** 手すり型の落下防止（鉄骨の細いフレーム・縦格子の丸棒・ガラス）を A→B（床 fl）に作る。集めている間は flushGuards でまとめて作る */
function buildVoidGuard(mb: MeshBuilder, kind: RailKind, A: THREE.Vector3, B: THREE.Vector3, fl: number) {
  if (guardSegs) {
    guardSegs.push({ kind, a: A.clone(), b: B.clone(), fl });
    return;
  }
  buildGuardPath(mb, kind, [A, B], fl);
}

/** 腰壁の上のガラス（H300）と細い黒の笠木 */
function voidGlassOnTop(mb: MeshBuilder, A: THREE.Vector3, B: THREE.Vector3, y: number) {
  const L = A.distanceTo(B);
  if (L < 0.1) return;
  const dir = new THREE.Vector3().subVectors(B, A).normalize();
  const mid = A.clone().addScaledVector(dir, L / 2);
  mb.box('ext.glass', mid.clone().setY(y), dir, L - 0.02, 0.3, 0.012);
  mb.box('ext.frame', mid.clone().setY(y + 0.3), dir, L, 0.03, 0.04);
}

/** 吹抜の落下防止の種類: 部屋ごとの指定（3D・方眼）が最優先。無ければテイスト（仕様）の既定（rail = スチール手すり） */
export function guardKindOf(r: Room | null | undefined, spec: BuilderSpec): VoidGuard {
  if (r?.voidGuard) return r.voidGuard;
  return spec.voidGuard === 'rail' ? 'steel' : spec.voidGuard;
}

/**
 * 壁の無い吹抜の縁（図面で手すりの細い線だけ、または何も描かれていない縁）にも仕様の落下防止を付ける。
 * 吹抜の多角形の辺ごとに、壁が沿っていなければ、外側（部屋側）に向けて手すり／腰壁／ガラス／壁を作る
 */
function buildVoidGuardsOnOpenEdges(mb: MeshBuilder, f: Floor, fl: number, spec: BuilderSpec) {
  if (f.level < 2) return;
  const distToSeg = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    return Math.hypot(p.x - a.x - dx * u, p.y - a.y - dy * u);
  };
  for (const r of f.rooms) {
    if (r.type !== 'void') continue;
    const poly = r.polygon;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      // 曲がった縁を短い線分で読んだ図面もある（林様邸 2 階: 200mm 前後の線分が続く）。短い辺も、つながる手すりの一部として拾う
      if (len < 80) continue;
      const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      const ang = Math.atan2(q.y - p.y, q.x - p.x);
      // 壁が沿っていれば buildWall 側で処理済み
      const hasWall = f.walls.some((w) => {
        let d = Math.abs(Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x) - ang) % Math.PI;
        d = Math.min(d, Math.PI - d);
        return d < (8 * Math.PI) / 180 && distToSeg(mid, w.a, w.b) < 150;
      });
      if (hasWall) continue;
      // 外向き（吹抜の外）を求め、その側が部屋なら落下防止が要る
      let nx = -(q.y - p.y) / len;
      let ny = (q.x - p.x) / len;
      if (pointInPolygon({ x: mid.x + nx * 150, y: mid.y + ny * 150 }, poly)) {
        nx = -nx;
        ny = -ny;
      }
      const other = roomAt(f, mid.x + nx * 200, mid.y + ny * 200);
      if (!other || other.type === 'void' || outdoorRoom(other)) continue;
      const A = V(p.x * MM, 0, p.y * MM);
      const B = V(q.x * MM, 0, q.y * MM);
      const dir = new THREE.Vector3().subVectors(B, A).normalize();
      const L = A.distanceTo(B);
      const midV = A.clone().addScaledVector(dir, L / 2);
      // 縁から部屋側へ少し（6cm）寄せて、床の小口に重ねない
      const inset = new THREE.Vector3(nx, 0, ny).multiplyScalar(0.06);
      const kind = guardKindOf(r, spec);
      // 腰壁の天端も壁と同じ仕上げ（塗り回し）。以前は白い板の色で、グレーの壁の家では天端だけ白く浮いていた
      const wallKeys = ['int.wall', 'int.wall', 'int.wall', 'int.wall', 'int.wall', 'int.wall'];
      if (kind === 'half') mb.box(wallKeys, midV.clone().add(inset).setY(fl), dir, L, 1.1, 0.12);
      else if (kind === 'halfGlass') {
        mb.box(wallKeys, midV.clone().add(inset).setY(fl), dir, L, 0.9, 0.12);
        voidGlassOnTop(mb, A.clone().add(inset), B.clone().add(inset), fl + 0.9);
      } else if (kind === 'wall') mb.box(wallKeys, midV.clone().add(inset).setY(fl), dir, L, f.ceilingHeight * MM, 0.12);
      else buildVoidGuard(mb, kind, A.clone().add(inset), B.clone().add(inset), fl);
    }
  }
}

/** 壁を開口部で分割して生成 */
/**
 * 1 本の壁のうち「吹抜とホール・LDK の境」になっている区間を切り出す（その区間は手すり・腰壁になる）。
 * 堀様邸の 2 階: 吹抜の下辺からホールと中庭の境まで 1 本の外壁として読めていたため、吹抜の縁まで外壁（天井までの壁）になっていた
 */
export function splitAtVoid(f: Floor, w: Wall, ops: Opening[]): { w: Wall; ops: Opening[] }[] {
  const whole = [{ w, ops }];
  if (f.level < 2 || !f.rooms.some((r) => r.type === 'void')) return whole;
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  if (L < 600) return whole;
  const ux = (w.b.x - w.a.x) / L;
  const uy = (w.b.y - w.a.y) / L;
  const nx = -uy;
  const ny = ux;
  const off = w.thickness / 2 + 80;
  const openTypes = ['hall', 'ldk', 'living', 'dining', 'kitchen', 'stairs', 'entrance', 'other'];
  const hit = (s: number) => {
    const p = { x: w.a.x + ux * s, y: w.a.y + uy * s };
    const rp = roomAt(f, p.x + nx * off, p.y + ny * off);
    const rm = roomAt(f, p.x - nx * off, p.y - ny * off);
    const vp = rp?.type === 'void';
    const vm = rm?.type === 'void';
    if (vp === vm) return false;
    const other = vp ? rm : rp;
    return !!other && openTypes.includes(other.type);
  };
  const step = 50;
  let t0 = -1;
  let t1 = -1;
  for (let s2 = step / 2; s2 < L; s2 += step) {
    if (hit(s2)) {
      if (t0 < 0) t0 = s2 - step / 2;
      t1 = s2 + step / 2;
    } else if (t0 >= 0) break;
  }
  if (t0 < 0 || t1 - t0 < 300) return whole;
  t0 = Math.max(0, t0);
  t1 = Math.min(L, t1);
  // 吹抜の縁の区間は室内の壁として扱う（外壁の扱いを外す）。前後の区間は元の壁のまま
  const sub = (a: number, b: number, inner: boolean): { w: Wall; ops: Opening[] } => ({
    w: {
      ...w,
      a: { x: w.a.x + ux * a, y: w.a.y + uy * a },
      b: { x: w.a.x + ux * b, y: w.a.y + uy * b },
      exterior: inner ? false : w.exterior,
      joinedA: a > 0 ? true : w.joinedA,
      joinedB: b < L ? true : w.joinedB,
    },
    // 開口は、中心のある区間に入れる（区間の端をまたぐ分は端で止める）。
    // 以前は区間にすっぽり入る開口だけ残していたので、吹抜の縁に少しはみ出した「建具なしの開口」が消えて、
    // ホールから階段の降り口が天井までの壁でふさがっていた（大崎様邸 2 階: 開口 962mm、吹抜の縁は 910mm から）
    ops: ops
      .filter((o) => (o.t0 + o.t1) / 2 >= a && (o.t0 + o.t1) / 2 < b)
      .map((o) => ({ ...o, t0: Math.max(0, o.t0 - a), t1: Math.min(b - a, o.t1 - a) }))
      .filter((o) => o.t1 - o.t0 >= 300),
  });
  const out: { w: Wall; ops: Opening[] }[] = [];
  if (t0 > 50) out.push(sub(0, t0, false));
  out.push(sub(t0, t1, true));
  if (t1 < L - 50) out.push(sub(t1, L, false));
  return out;
}

/**
 * 1 本の壁のうち「バルコニーの縁（両側とも屋外 → 手すり壁 1.1m）」の区間と、室内に面する区間（天井までの外壁）が混ざっているときに分ける。
 * 有元様邸の 3 階: 南の外壁がバルコニー（西）とパントリー（東）にまたがって 1 本で読めていて、壁の中点がバルコニー側だったため
 * 全長が手すり壁になり、パントリーの外壁が無かった（外周の抜け 1.6m）。窓・戸の途中では切らない
 */
export function splitAtBalcony(f: Floor, w: Wall, ops: Opening[]): { w: Wall; ops: Opening[] }[] {
  const whole = [{ w, ops }];
  if (!f.rooms.some((r) => r.type === 'balcony')) return whole;
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  if (L < 600) return whole;
  const ux = (w.b.x - w.a.x) / L;
  const uy = (w.b.y - w.a.y) / L;
  const nx = -uy;
  const ny = ux;
  const off = w.thickness / 2 + 80;
  const parapetAt = (s: number) => {
    const p = { x: w.a.x + ux * s, y: w.a.y + uy * s };
    const rp = roomAt(f, p.x + nx * off, p.y + ny * off);
    const rm = roomAt(f, p.x - nx * off, p.y - ny * off);
    const openPlus = (w.exterior && w.outsideSign === 1) || !rp || outdoorRoom(rp);
    const openMinus = (w.exterior && w.outsideSign === -1) || !rm || outdoorRoom(rm);
    return openPlus && openMinus && (rp?.type === 'balcony' || rm?.type === 'balcony');
  };
  const step = 50;
  const runs: { a: number; b: number; par: boolean }[] = [];
  for (let s = step / 2; s < L; s += step) {
    const par = parapetAt(s);
    const a = s - step / 2;
    const b = Math.min(L, s + step / 2);
    const last = runs[runs.length - 1];
    if (last && last.par === par) last.b = b;
    else runs.push({ a, b, par });
  }
  // 150mm 未満の区間は隣に吸収（壁厚の分だけ判定がずれる所）
  const merged: { a: number; b: number; par: boolean }[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && (r.b - r.a < 150 || last.b - last.a < 150)) {
      if (last.b - last.a < 150 && r.b - r.a >= 150) last.par = r.par;
      last.b = r.b;
    } else if (last && last.par === r.par) last.b = r.b;
    else merged.push({ ...r });
  }
  if (merged.length < 2) return whole;
  // 窓・戸の途中で切らない（境を開口の端へ寄せる）
  for (let i = 1; i < merged.length; i++) {
    const s = merged[i].a;
    const o = ops.find((x) => x.t0 < s - 1 && x.t1 > s + 1);
    if (o) {
      const to = s - o.t0 < o.t1 - s ? o.t0 : o.t1;
      merged[i - 1].b = to;
      merged[i].a = to;
    }
  }
  const sub = (a: number, b: number): { w: Wall; ops: Opening[] } => ({
    w: { ...w, a: { x: w.a.x + ux * a, y: w.a.y + uy * a }, b: { x: w.a.x + ux * b, y: w.a.y + uy * b }, joinedA: a > 0 ? true : w.joinedA, joinedB: b < L ? true : w.joinedB },
    ops: ops.filter((o) => o.t0 >= a - 1 && o.t1 <= b + 1).map((o) => ({ ...o, t0: o.t0 - a, t1: o.t1 - a })),
  });
  return merged.filter((r) => r.b - r.a > 20).map((r) => sub(r.a, r.b));
}

/**
 * 手で足した庇（model.canopies）: 壁の外面に取り付く薄い板。先端がわずかに下がる（既定 0.5 寸）。
 * 黒い薄い板（鼻隠しと同じ色）に、壁との取り付きの水切り
 */
function buildCanopies(mb: MeshBuilder, model: BuildingModel, f: Floor, fl: number) {
  for (const c of model.canopies ?? []) {
    if (c.level !== f.level) continue;
    const w = f.walls.find((x) => x.id === c.wallId);
    if (!w) continue;
    const A = V(w.a.x * MM, 0, w.a.y * MM);
    const B = V(w.b.x * MM, 0, w.b.y * MM);
    const L = A.distanceTo(B);
    if (L < 0.05) continue;
    const dir = B.clone().sub(A).normalize();
    const nW = V(-dir.z, 0, dir.x);
    const t = w.thickness * MM;
    const t0 = Math.max(0, Math.min(c.t0, c.t1) * MM);
    const t1 = Math.min(L, Math.max(c.t0, c.t1) * MM);
    if (t1 - t0 < 0.2) continue;
    const mid = A.clone().addScaledVector(dir, (t0 + t1) / 2);
    // 外向き: 壁の外向きの印、無ければ外形の内外（外形が無ければ部屋の無い側）
    let sg = w.outsideSign ?? 0;
    if (!sg) {
      const inside = (s: number) => {
        const q = mid.clone().addScaledVector(nW, s * (t / 2 + 0.35));
        return f.outline.length ? f.outline.some((l) => pointInPolygon({ x: q.x / MM, y: q.z / MM }, l)) : !!roomAt(f, q.x / MM, q.z / MM);
      };
      sg = inside(1) && !inside(-1) ? -1 : 1;
    }
    const out = nW.clone().multiplyScalar(sg);
    const depth = Math.max(0.3, c.depth * MM);
    const thick = (c.thickness ?? 120) * MM;
    const slope = (c.pitch ?? 0.5) / 10;
    const yWall = fl + c.bottomMm * MM;
    const yTip = yWall - depth * slope;
    const half = dir.clone().multiplyScalar((t1 - t0) / 2);
    const back = mid.clone().addScaledVector(out, t / 2 - 0.02);
    const front = back.clone().addScaledVector(out, depth);
    const b0 = back.clone().sub(half).setY(yWall);
    const b1 = back.clone().add(half).setY(yWall);
    const f0 = front.clone().sub(half).setY(yTip);
    const f1 = front.clone().add(half).setY(yTip);
    const up = V(0, thick, 0);
    const key = 'ext.canopy';
    const tilt = V(out.x * slope, 1, out.z * slope).normalize();
    mb.polygon(key, [b0, b1, f1, f0], tilt.clone().negate()); // 下面（軒天）
    mb.polygon(key, [b0.clone().add(up), b1.clone().add(up), f1.clone().add(up), f0.clone().add(up)], tilt); // 上面
    mb.polygon(key, [f0, f1, f1.clone().add(up), f0.clone().add(up)], out); // 先端
    mb.polygon(key, [b0, f0, f0.clone().add(up), b0.clone().add(up)], dir.clone().negate()); // 脇
    mb.polygon(key, [b1, f1, f1.clone().add(up), b1.clone().add(up)], dir); // 脇
    // 壁との取り付き（水切り）
    mb.box('ext.frame', mid.clone().addScaledVector(out, t / 2 + 0.01).setY(yWall + thick), dir, t1 - t0 + 0.04, 0.03, 0.06);
  }
}

/** ガレージ（土間）の通用口か: 勝手口（service）で、戸のどちらかの側がビルトインガレージ。戸はガレージの土間から立ち上げる */
function isGarageServiceDoor(f: Floor, w: Wall, o: Opening): boolean {
  if (o.kind !== 'door' || !o.service || !w.exterior || f.level !== 1) return false;
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
  const ux = (w.b.x - w.a.x) / L;
  const uy = (w.b.y - w.a.y) / L;
  const c = { x: w.a.x + ux * ((o.t0 + o.t1) / 2), y: w.a.y + uy * ((o.t0 + o.t1) / 2) };
  const off = w.thickness / 2 + 300;
  return [1, -1].some((sg) => isBuiltinGarage(roomAt(f, c.x - uy * sg * off, c.y + ux * sg * off)));
}

function buildWall(mb: MeshBuilder, f: Floor, w: Wall, ops: Opening[], fl: number, top: number, extKey: string, isTop: boolean, spec: BuilderSpec) {
  const A = V(w.a.x * MM, 0, w.a.y * MM);
  const B = V(w.b.x * MM, 0, w.b.y * MM);
  const L = A.distanceTo(B);
  if (L < 0.02) return;
  const dir = new THREE.Vector3().subVectors(B, A).normalize();
  const t = w.thickness * MM;
  const nPlan = { x: -(w.b.y - w.a.y), y: w.b.x - w.a.x };
  const nl = Math.hypot(nPlan.x, nPlan.y) || 1;
  nPlan.x /= nl;
  nPlan.y /= nl;

  // 壁の両側の部屋
  const sideRoom = (sign: 1 | -1) => {
    const mid = { x: (w.a.x + w.b.x) / 2 + nPlan.x * sign * (w.thickness / 2 + 80), y: (w.a.y + w.b.y) / 2 + nPlan.y * sign * (w.thickness / 2 + 80) };
    return roomAt(f, mid.x, mid.y);
  };
  const isOutdoor = outdoorRoom;
  const rPlus = sideRoom(1);
  const rMinus = sideRoom(-1);
  // バルコニーの外周（両側とも屋外）は手すり壁（腰壁＋笠木）、バルコニーと室内の間は外壁
  const openPlus = (w.exterior && w.outsideSign === 1) || !rPlus || isOutdoor(rPlus);
  const openMinus = (w.exterior && w.outsideSign === -1) || !rMinus || isOutdoor(rMinus);
  const parapet = openPlus && openMinus && (rPlus?.type === 'balcony' || rMinus?.type === 'balcony');
  const facesOutdoor = isOutdoor(rPlus) || isOutdoor(rMinus);
  // 吹抜に面する上階の壁: 仕様で 鉄骨手すり／腰壁／腰壁＋ガラス／壁 を選ぶ（片側が吹抜、反対側が部屋のとき）
  const voidPlus = rPlus?.type === 'void';
  const voidMinus = rMinus?.type === 'void';
  // 手すり・腰壁にするのは、吹抜とホール・廊下・LDK など開いた場所の境だけ。寝室・子供室・収納・水まわりとの境は
  // 図面どおり天井までの壁（以前は吹抜に面する壁をすべて手すりにしていて、洋室の壁が消えて手すりが続いていた）
  const other = voidPlus ? rMinus : rPlus;
  const openSide = !!other && ['hall', 'ldk', 'living', 'dining', 'kitchen', 'stairs', 'entrance', 'other'].includes(other.type);
  const voidEdge = f.level >= 2 && voidPlus !== voidMinus && !w.exterior && !facesOutdoor && openSide;
  const guard: VoidGuard = voidEdge ? guardKindOf(voidPlus ? rPlus : rMinus, spec) : 'wall';
  if (guard === 'steel' || guard === 'iron' || guard === 'glass') {
    buildVoidGuard(mb, guard, A, B, fl);
    return;
  }
  // 各面の素材
  const sideKey = (sign: 1 | -1): string => {
    if (w.exterior && w.outsideSign === sign) return extKey;
    // 室内側: 部屋の種類で変える
    const r = sign === 1 ? rPlus : rMinus;
    // 部屋が無い側（ピロティ・ポーチの下など屋外）は外壁の仕上げ
    if (isOutdoor(r) || !r) return extKey;
    if (r?.type === 'bath') return 'int.bathWall';
    // 壁ごとの指定（3D でクリック）が最優先。無ければ LDK の窓の無い長い壁をアクセントクロスに
    if (!w.exterior && w.accent !== undefined) return w.accent ? 'int.accent' : 'int.wall';
    // （腰壁・手すり壁はアクセントにしない: 低い壁だけ色が変わると、造作の箱のように見える）
    if (r && (r.type === 'ldk' || r.type === 'living') && !w.exterior && ops.length === 0 && L > 2.2 && !(w.topMm != null && w.topMm < 1800)) return 'int.accent';
    return 'int.wall';
  };
  const kPlus = sideKey(1);
  const kMinus = sideKey(-1);
  // 1階の外壁は基礎天端まで下げる。両側とも屋外の塀状の壁（中庭・ポーチの囲い）は外形の外で基礎が無いので地面まで
  const bothOutdoor = (!rPlus || isOutdoor(rPlus)) && (!rMinus || isOutdoor(rMinus));
  // ガレージ（土間）に面する間仕切りは土間まで下ろす（家の床の高さで止めると、土間との間に隙間が開く）
  const garageSide = f.level === 1 && !w.exterior && (isBuiltinGarage(rPlus) || isBuiltinGarage(rMinus));
  // 玄関の土間（FL − 180）やダウンリビングなど下がった床に面する間仕切りは、その床まで下ろす
  const lowest = w.exterior ? 0 : Math.min(0, roomFloorOffsetMm(rPlus), roomFloorOffsetMm(rMinus));
  const bottom = w.exterior && f.level === 1 ? (bothOutdoor ? -0.05 : fl - 0.1) : garageSide ? GARAGE_FLOOR_Y - 0.01 : lowest < 0 ? fl + lowest * MM - 0.01 : fl;
  // 後付け・離れのガレージ、物置の囲い（両側とも家の外）はその建物の高さまで
  const annexTop = bothOutdoor ? Math.max(annexHeight(rPlus) ?? 0, annexHeight(rMinus) ?? 0) : 0;
  // 敷地の塀（家から離れて立つ両側とも屋外の壁）は目隠し塀の高さ 1.8m（建物の高さまで立ち上げると敷地が箱で囲まれて見える）。
  // 家に取り付く・家のすぐそばの囲い（中庭の袖壁・ポーチの壁）は建物と同じ高さのまま
  const fence = f.elevation < 1500 && bothOutdoor && annexTop === 0 && distToOutlineMm(f, w) > 900;
  const wallTopAuto = parapet ? Math.min(top, fl + 1.1) : guard === 'half' ? fl + 1.1 : guard === 'halfGlass' ? fl + 0.9 : annexTop > 0 ? annexTop : fence ? 1.8 : w.exterior || facesOutdoor ? top : fl + wallCeilingMm(f, w) * MM;
  // 天端の指定（3D の「窓・戸」の道具で壁をクリック）: 袖壁・腰壁・パラペットの立ち上げ。床から 300mm 以上
  const wallTop = w.topMm != null ? fl + Math.max(300, w.topMm) * MM : wallTopAuto;
  // 室内の腰壁・袖壁の天端は壁と同じ仕上げ（塗り回し）。以前は白い板の色で、グレーの壁の家では天端だけ白く浮いていた
  const topKey = w.exterior || facesOutdoor ? 'ext.wallTop' : 'int.wall';
  if (guard === 'halfGlass') voidGlassOnTop(mb, A, B, fl + 0.9);
  // 開口の小口: 塗り回し（ステルス枠）なら壁と同じ仕上げで線を出さない
  const jambKey = w.exterior
    ? spec.windows.interiorReveal === 'plaster'
      ? 'int.wall'
      : 'int.trim'
    : spec.doors.frame === 'casing'
      ? 'int.trim'
      : 'int.wall';
  void isTop;

  const seg = (s0: number, s1: number, y0: number, y1: number, startCap: string | null, endCap: string | null) => {
    if (s1 - s0 < 0.005 || y1 - y0 < 0.005) return;
    const base = A.clone().addScaledVector(dir, (s0 + s1) / 2).setY(y0);
    mb.box([kPlus, kMinus, topKey, spec.windows.interiorReveal === 'plaster' ? 'int.wall' : 'int.wallTop', startCap, endCap], base, dir, s1 - s0, y1 - y0, t);
  };

  let cursor = 0;
  // 他の壁とつながらない端の小口: 外壁は外装で閉じる（開口の小口と同じ室内の仕上げにすると、外から白い縦の帯に見える）
  const endKey = w.exterior || facesOutdoor ? extKey : jambKey;
  const firstCap = w.joinedA ? null : endKey;
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    const s0 = Math.max(0, o.t0 * MM);
    const s1 = Math.min(L, o.t1 * MM);
    seg(cursor, s0, bottom, wallTop, cursor === 0 ? firstCap : jambKey, jambKey);
    // シャッターは土間（GL+40）から立ち上がる（家の床の高さに合わせると、車の乗り入れ口に段差ができる）
    const base = (o.kind === 'shutter' && f.level === 1) || isGarageServiceDoor(f, w, o) ? GARAGE_FLOOR_Y : fl;
    const sill = base + o.sill * MM;
    const head = Math.min(wallTop, base + (o.sill + o.height) * MM);
    if (o.sill > 0) seg(s0, s1, bottom, sill, null, null);
    if (head < wallTop - 0.005) seg(s0, s1, head, wallTop, null, null);
    cursor = s1;
  }
  seg(cursor, L, bottom, wallTop, ops.length === 0 ? firstCap : jambKey, w.joinedB ? null : endKey);
}

function buildOpening(mb: MeshBuilder, f: Floor, w: Wall, o: Opening, fl: number, meta: BuildingMeta, spec: BuilderSpec, upperOutlines?: { x: number; y: number }[][]) {
  const A = V(w.a.x * MM, 0, w.a.y * MM);
  const B = V(w.b.x * MM, 0, w.b.y * MM);
  const dir = new THREE.Vector3().subVectors(B, A).normalize();
  const nW = new THREE.Vector3(-dir.z, 0, dir.x); // 平面の n と一致
  const t = w.thickness * MM;
  const s0 = o.t0 * MM;
  const s1 = o.t1 * MM;
  const width = s1 - s0;
  const mid = A.clone().addScaledVector(dir, (s0 + s1) / 2);
  let outSign = w.exterior ? (w.outsideSign ?? 1) : 1;
  // 1 階の外壁に置いた「開き戸」で、外側に部屋が無い（または外構・ポーチ）ものは玄関ドア扱い（外開き・庇付き）。
  // 室内の開き戸として作ると、玄関なのに内開きで庇の無い戸になっていた（吉田様邸）
  // 勝手口・ガレージの通用口（service）は玄関にしない（庇・ポーチなしの外部の開き戸として作る）
  const serviceDoor = o.kind === 'door' && !!o.service && w.exterior;
  if (o.kind === 'door' && w.exterior && f.level === 1 && !serviceDoor) {
    const q = mid.clone().addScaledVector(nW, outSign * (t / 2 + 0.3));
    const outsideRoom = roomAt(f, q.x / MM, q.z / MM);
    if (!outsideRoom || (outdoorRoom(outsideRoom) && outsideRoom.type !== 'balcony')) o = { ...o, kind: 'entrance', height: Math.max(o.height, 2200) };
  }
  // 開口の基準の高さ: シャッターはガレージの土間、玄関ドアは玄関の土間（FL − 180）、ほかは家の床
  let base = o.kind === 'shutter' && f.level === 1 ? GARAGE_FLOOR_Y : fl;
  if (o.kind === 'entrance' || serviceDoor) {
    const qi = mid.clone().addScaledVector(nW, -outSign * (t / 2 + 0.3));
    const offIn = roomFloorOffsetMm(roomAt(f, qi.x / MM, qi.z / MM));
    // ガレージの通用口はガレージの土間から（家の床の高さに付けると、土間から 50cm 浮いた戸になる）
    if (isGarageServiceDoor(f, w, o)) base = GARAGE_FLOOR_Y;
    else if (offIn < 0) base = fl + offIn * MM;
  }
  const sill = base + o.sill * MM;
  const head = base + (o.sill + o.height) * MM;
  const H = head - sill;
  // 外壁の外向きは、外形の内外で確かめる（向きを取り違えるとサッシ・カーテンが外に出る）
  if (w.exterior && f.outline.length) {
    const probe = (sg: number) => {
      const q = mid.clone().addScaledVector(nW, sg * (t / 2 + 0.35));
      return f.outline.some((l) => pointInPolygon({ x: q.x / MM, y: q.z / MM }, l));
    };
    const plusIn = probe(1);
    const minusIn = probe(-1);
    if (plusIn !== minusIn) outSign = plusIn ? -1 : 1;
  }
  const outN = nW.clone().multiplyScalar(outSign);

  if (o.kind === 'window') {
    // 室内窓（部屋と部屋の間のガラス）: 壁の芯に FIX のガラスだけ。水切り・カーテンは付けない
    const interiorWin = !!o.interior && !w.exterior;
    // サッシ枠は外壁寄り（半外付け）
    const plane = interiorWin ? mid.clone() : mid.clone().addScaledVector(outN, t / 2 - 0.05);
    const fw = 0.03;
    const fd = 0.07;
    const frame = 'ext.frame';
    // 上下枠・縦枠
    mb.box(frame, plane.clone().setY(sill), dir, width, fw, fd);
    mb.box(frame, plane.clone().setY(head - fw), dir, width, fw, fd);
    mb.box(frame, plane.clone().addScaledVector(dir, -width / 2 + fw / 2).setY(sill), dir, fw, H, fd);
    mb.box(frame, plane.clone().addScaledVector(dir, width / 2 - fw / 2).setY(sill), dir, fw, H, fd);
    // 曇りガラスは浴室・トイレの小窓だけ（天井付けの高窓は透明で空を見せる）
    const frosted = o.windowStyle === 'small';
    const glassKey = frosted ? 'ext.glassFrosted' : 'ext.glass';
    // ホームランディックの窓の語彙: 引違いは使わず、FIX と縦すべり出し・横すべり出しを細い方立てで組む。
    // ガラスは枠の面にそろえ（障子を前後にずらさない）、見付けの線を最小にする
    const innerW = width - fw * 2;
    const innerH = H - fw * 2;
    const y0 = sill + fw;
    const mull = 0.03;
    // 区画: 横長の小窓・高窓は横すべり出し 1 枚。それ以外は FIX（1 枚の幅 1.8m まで）＋ 端に縦すべり出し（幅 0.5m）を 1 枚
    const cells: { w: number; vent: 'none' | 'side' | 'top' }[] = [];
    const flat = H < 0.7 || o.windowStyle === 'high';
    if (interiorWin) {
      const nFix = Math.max(1, Math.ceil(innerW / 1.8));
      for (let k = 0; k < nFix; k++) cells.push({ w: (innerW - mull * (nFix - 1)) / nFix, vent: 'none' });
    } else if (flat) cells.push({ w: innerW, vent: 'top' });
    else if (innerW <= 0.75) cells.push({ w: innerW, vent: 'side' });
    else {
      const ventW = Math.min(0.5, innerW * 0.35);
      const fixW = innerW - ventW - mull;
      const nFix = Math.max(1, Math.ceil(fixW / 1.8));
      const fw1 = (fixW - mull * (nFix - 1)) / nFix;
      for (let k = 0; k < nFix; k++) cells.push({ w: fw1, vent: 'none' });
      // 開く窓は戸袋側（壁の端に近い側）に
      if (o.hingeAtStart === false) cells.push({ w: ventW, vent: 'side' });
      else cells.unshift({ w: ventW, vent: 'side' });
    }
    let u = -innerW / 2;
    cells.forEach((cell, k) => {
      if (k > 0) {
        // 方立て
        mb.box(frame, plane.clone().addScaledVector(dir, u + mull / 2).setY(y0), dir, mull, innerH, fd * 0.8);
        u += mull;
      }
      const c = plane.clone().addScaledVector(dir, u + cell.w / 2);
      let gx0 = -cell.w / 2;
      let gx1 = cell.w / 2;
      let gy0 = y0;
      let gy1 = y0 + innerH;
      if (cell.vent !== 'none') {
        // 開く障子の框（細く、FIX のガラス面とほぼ同じ面に）
        const sw = 0.028;
        mb.box(frame, c.clone().setY(y0), dir, cell.w, sw, 0.03);
        mb.box(frame, c.clone().setY(y0 + innerH - sw), dir, cell.w, sw, 0.03);
        mb.box(frame, c.clone().addScaledVector(dir, -cell.w / 2 + sw / 2).setY(y0), dir, sw, innerH, 0.03);
        mb.box(frame, c.clone().addScaledVector(dir, cell.w / 2 - sw / 2).setY(y0), dir, sw, innerH, 0.03);
        gx0 += sw;
        gx1 -= sw;
        gy0 += sw;
        gy1 -= sw;
      }
      const g0 = c.clone().addScaledVector(dir, gx0).setY(gy0);
      const g1 = c.clone().addScaledVector(dir, gx1).setY(gy0);
      const g2 = g1.clone().setY(gy1);
      const g3 = g0.clone().setY(gy1);
      mb.quad(glassKey, g0, g1, g2, g3);
      mb.quad(glassKey, g1, g0, g3, g2);
      // 立面図の建具記号: 開く窓は丁番側の辺の中点を頂点にした三角（JIS。外開きは実線）
      {
        const sash: SashInfo = { level: f.level, openingId: o.id, kind: cell.vent === 'none' ? 'fix' : cell.vent, outN: outN.clone(), corners: [g0, g1, g2, g3] };
        if (cell.vent === 'top') sash.tri = { apex: g3.clone().lerp(g2, 0.5), a: g0.clone(), b: g1.clone() };
        else if (cell.vent === 'side') {
          // 丁番は壁の端に近い側（最初のセルなら a 側、最後なら b 側）
          const hingeAtA = k === 0;
          sash.tri = hingeAtA ? { apex: g0.clone().lerp(g3, 0.5), a: g1.clone(), b: g2.clone() } : { apex: g1.clone().lerp(g2, 0.5), a: g0.clone(), b: g3.clone() };
        }
        if (!interiorWin) meta.sashes.push(sash);
      }
      u += cell.w;
    });
    // 外部の水切り
    if (!interiorWin) mb.box(frame, mid.clone().addScaledVector(outN, t / 2 + 0.01).setY(sill - 0.02), dir, width + 0.04, 0.02, 0.05);
    // 室内の窓台
    if (!interiorWin && o.sill > 0 && spec.windows.sillBoard) mb.box('int.trim', mid.clone().addScaledVector(outN, -t / 2 + 0.01).setY(sill - 0.02), dir, width + 0.06, 0.02, 0.06);
    // カーテン（居室の掃き出し・腰窓）
    const inRoom = roomAt(f, (mid.x - outN.x * (t / 2 + 0.2)) / MM, (mid.z - outN.z * (t / 2 + 0.2)) / MM);
    // 高窓（下端が床から 1.2m より上・天井付けの横長窓）と小窓（高さ 0.8m 未満）にはカーテンを付けない。
    // 天井付けの細い窓に床までのカーテンが下がっていると、窓の無い所に布がある不自然な絵になる
    const curtainable = o.sill * MM <= 1.2 && o.height * MM >= 0.8;
    if (!interiorWin && spec.curtains !== 'none' && curtainable && inRoom && ['ldk', 'living', 'dining', 'bedroom', 'kids', 'study'].includes(inRoom.type) && width > 0.7) {
      const ceil = fl + f.ceilingHeight * MM;
      const inner = mid.clone().addScaledVector(outN, -t / 2 - 0.12);
      // 束ねたカーテンが窓の脇の壁の外（建物の角の先）に出る場合は、窓の内側に寄せる
      const fitsAt = (u: number) => {
        const q = inner.clone().addScaledVector(dir, u);
        return f.outline.some((l) => pointInPolygon({ x: q.x / MM, y: q.z / MM }, l)) && !!roomAt(f, q.x / MM, q.z / MM);
      };
      if (spec.curtains === 'pocket') {
        // 天井埋込のカーテンボックス: 天井から床まで落ちる薄手のドレープ（レールは見せない）
        const pocket = inner.clone().setY(ceil - 0.004);
        const pL = fitsAt(-(width / 2 + 0.36)) ? 0.35 : 0;
        const pR = fitsAt(width / 2 + 0.36) ? 0.35 : 0;
        mb.box('int.shadowGap', pocket.clone().addScaledVector(dir, (pR - pL) / 2), dir, width + pL + pR, 0.004, 0.16);
        // 布は既定では描かない（御社の提案パースは、ガラス越しの中庭と空を見せる。溝だけが天井に残る）
        if (!spec.drapes) return;
        // 両脇にまとめたドレープ: 波打つ薄い布（正弦波の面）。硬い縦の束に見せない
        for (const side of [-1, 1]) {
          const bundle = 0.34;
          const outside = fitsAt(side * (width / 2 + 0.03 + bundle + 0.04));
          const u0 = outside ? side * (width / 2 + 0.03) : side * (width / 2 - 0.04 - bundle);
          const uStart = side > 0 || !outside ? Math.min(u0, u0 + side * bundle) : u0 - bundle;
          curtainWave(mb, inner.clone().addScaledVector(dir, Math.min(uStart, uStart + bundle)), dir, outN, bundle, fl + 0.015, ceil - 0.012);
        }
        return;
      }
      const cy = fl + Math.min(2.35, (o.sill + o.height) * MM + 0.1);
      // 両端にまとめたカーテン（布を描く設定のときだけ。レールは残す）
      for (const side of spec.drapes ? [-1, 1] : []) {
        const c = inner.clone().addScaledVector(dir, fitsAt(side * (width / 2 + 0.2)) ? side * (width / 2 + 0.05) : side * (width / 2 - 0.15));
        mb.box('f.curtain', c.setY(fl + (o.sill > 0 ? o.sill * MM - 0.1 : 0.01)), dir, 0.28, cy - (fl + (o.sill > 0 ? o.sill * MM - 0.1 : 0.01)), 0.1);
      }
      // レールも建物の外に出ない長さに
      const extL = fitsAt(-(width / 2 + 0.26)) ? 0.25 : 0;
      const extR = fitsAt(width / 2 + 0.26) ? 0.25 : 0;
      mb.box('f.metal', inner.clone().addScaledVector(dir, (extR - extL) / 2).setY(cy), dir, width + extL + extR, 0.025, 0.025);
    }
    return;
  }

  if (o.kind === 'shutter') {
    // ガレージのシャッター（閉）: 開口いっぱいのスラット付きパネル、両脇のガイドレール、上のシャッターボックス
    const plane = mid.clone().addScaledVector(outN, t / 2 - 0.06);
    // スラット付きのパネルは独立した部品（上端が原点）。クリックで巻き取り式に上のボックスへ巻き上がる
    const panelH = H - 0.08;
    const top = plane.clone().setY(sill + 0.02 + panelH);
    const yaw = Math.atan2(-dir.z, dir.x);
    const smb = new MeshBuilder();
    smb.clip = localClip(top, yaw);
    smb.box('ext.shutter', V(0, -panelH, 0), V(1, 0, 0), width - 0.1, panelH, 0.05);
    // 下端の座板（巻き上げても残る）
    smb.box('ext.frame', V(0, -panelH, 0), V(1, 0, 0), width - 0.1, 0.06, 0.06);
    meta.doors.push({
      id: o.id,
      kind: 'roll',
      level: f.level,
      origin: top,
      yaw0: yaw,
      openAngle: 0,
      slideDir: new THREE.Vector3(),
      slideDist: 0,
      staticOpen: 0,
      cutOpen: 0,
      mb: smb,
      width: width - 0.1,
    });
    mb.box('ext.frame', plane.clone().addScaledVector(dir, -width / 2 + 0.025).setY(sill), dir, 0.05, H, 0.1);
    mb.box('ext.frame', plane.clone().addScaledVector(dir, width / 2 - 0.025).setY(sill), dir, 0.05, H, 0.1);
    mb.box('ext.frame', plane.clone().addScaledVector(outN, -0.05).setY(head - 0.3), dir, width, 0.3, 0.2);
    return;
  }

  if (o.kind === 'entrance' || serviceDoor) {
    const plane = mid.clone().addScaledVector(outN, t / 2 - 0.06);
    const fw = 0.05;
    mb.box('ext.frame', plane.clone().setY(head - fw), dir, width, fw, 0.08);
    mb.box('ext.frame', plane.clone().addScaledVector(dir, -width / 2 + fw / 2).setY(sill), dir, fw, H, 0.08);
    mb.box('ext.frame', plane.clone().addScaledVector(dir, width / 2 - fw / 2).setY(sill), dir, fw, H, 0.08);
    // 扉（通常は閉。ウォークスルーで内側へ開く）: ヒンジを原点にした部品
    const dw = width - fw * 2;
    const hingeStart = o.hingeAtStart !== false;
    const closedDir = dir.clone().multiplyScalar(hingeStart ? 1 : -1);
    const hinge = plane.clone().addScaledVector(dir, hingeStart ? -dw / 2 : dw / 2).setY(0);
    const dmb = new MeshBuilder();
    dmb.clip = localClip(hinge, Math.atan2(-closedDir.z, closedDir.x));
    dmb.box('ext.door', V(dw / 2, sill, 0), V(1, 0, 0), dw, H - fw, 0.045);
    const zOut = outN.dot(nW); // 局所 +Z = nW
    if (serviceDoor) {
      // 勝手口ドア: 上半分が型ガラス（採光・採風）、レバーハンドル
      const gw = Math.max(0.2, dw - 0.24);
      dmb.box('ext.glassFrosted', V(dw / 2, sill + H * 0.45, zOut * 0.024), V(1, 0, 0), gw, H * 0.42, 0.004);
      dmb.box('ext.glassFrosted', V(dw / 2, sill + H * 0.45, -zOut * 0.024), V(1, 0, 0), gw, H * 0.42, 0.004);
      dmb.box('f.metal', V(dw - 0.1, sill + 1.0, zOut * 0.04), V(1, 0, 0), 0.12, 0.02, 0.02);
      dmb.box('f.metal', V(dw - 0.1, sill + 1.0, -zOut * 0.04), V(1, 0, 0), 0.12, 0.02, 0.02);
    } else {
      // 縦長の取っ手（戸先側・外側）と採光スリット（ヒンジ側）
      dmb.box('f.metal', V(dw - 0.12, sill + 0.75, zOut * 0.05), V(1, 0, 0), 0.02, 0.8, 0.02);
      dmb.box('ext.glassFrosted', V(0.12, sill + 0.3, zOut * 0.024), V(1, 0, 0), 0.08, H - 0.6, 0.004);
    }
    // 玄関ドアは外開き（日本の玄関は靴を脱ぐ土間に扉が来ないように外へ開く。以前は内開きになっていた）
    const outward = outN.clone();
    meta.doors.push({
      id: o.id,
      kind: 'swing',
      level: f.level,
      origin: hinge,
      yaw0: Math.atan2(-closedDir.z, closedDir.x),
      openAngle: Math.atan2(closedDir.z * outward.x - closedDir.x * outward.z, closedDir.dot(outward)),
      slideDir: new THREE.Vector3(),
      slideDist: 0,
      staticOpen: 0,
      cutOpen: 0,
      mb: dmb,
      width: dw,
    });
    const outPt = mid.clone().addScaledVector(outN, t / 2 + 0.6);
    const outRoom = roomAt(f, outPt.x / MM, outPt.z / MM);
    if (serviceDoor) {
      // 勝手口は踏み段だけ（庇・ポーチは付けない）。戸の下端が地面から 15cm 以上あるとき
      if (!outRoom && base > 0.15) {
        const sc = mid.clone().addScaledVector(outN, t / 2 + 0.2);
        mb.box('l.porch', sc.clone().setY(0), dir, Math.max(0.6, width), Math.max(0.1, base - 0.18), 0.4);
      }
      return;
    }
    // ポーチと庇。外側がポーチの区画なら床は区画のものを使い、上階・下屋・ポーチの天井の下なら庇は付けない
    const porchW = Math.max(1.6, width + 0.8);
    const porchD = 1.3;
    if (!outRoom) {
      // ポーチは土間（玄関ドアの基準）より 30 下。その先に半分の高さの段
      const porchTop = Math.max(0.1, base - 0.03);
      const pc = mid.clone().addScaledVector(outN, t / 2 + porchD / 2);
      mb.box('l.porch', pc.clone().setY(0), dir, porchW, porchTop, porchD);
      const step = mid.clone().addScaledVector(outN, t / 2 + porchD + 0.2);
      mb.box('l.porch', step.clone().setY(0), dir, porchW, porchTop / 2, 0.4);
    }
    const covered = (upperOutlines ?? []).some((l) => pointInPolygon({ x: outPt.x / MM, y: outPt.z / MM }, l)) || outRoom?.type === 'porch';
    if (!covered) {
      // 庇: 奥行 1.2m・厚さ 120 の薄い箱（下面は黒い軒天）。玄関を出た瞬間に雨に濡れないように必ず付ける
      const canopyD = 1.2;
      const canopy = mid.clone().addScaledVector(outN, t / 2 + canopyD / 2 - 0.05);
      mb.box('ext.canopy', canopy.setY(head + 0.2), dir, porchW + 0.3, 0.12, canopyD);
      // 庇の脇の壁の取り付き（水切り）
      mb.box('ext.frame', mid.clone().addScaledVector(outN, t / 2 + 0.02).setY(head + 0.32), dir, porchW + 0.3, 0.04, 0.06);
    }
    // 玄関は最下階のものを採用（上階の外部扉が玄関扱いにならないように）
    if (!meta.entrance || f.level < meta.entrance.level) meta.entrance = { pos: mid.clone().setY(fl), outward: outN.clone(), width, level: f.level, openingId: o.id };
    return;
  }

  // ---- 室内建具 ----
  const trim = 'int.trim';
  const cw = 0.03;
  const doorT = spec.doors.thickness * MM;
  const topGap = spec.doors.topGap * MM;
  if (spec.doors.frame === 'casing') {
    // 一般的な三方枠
    mb.box(trim, mid.clone().setY(head), dir, width + cw * 2, cw, t + 0.012);
    mb.box(trim, mid.clone().addScaledVector(dir, -width / 2 - cw / 2).setY(fl), dir, cw, H + cw, t + 0.012);
    mb.box(trim, mid.clone().addScaledVector(dir, width / 2 + cw / 2).setY(fl), dir, cw, H + cw, t + 0.012);
  } else if (spec.doors.frame === 'inset') {
    // インセット枠: 扉と同色の細い枠を壁厚内に
    const iw = 0.012;
    mb.box('int.door', mid.clone().addScaledVector(dir, -width / 2 + iw / 2).setY(fl), dir, iw, H, t * 0.6);
    mb.box('int.door', mid.clone().addScaledVector(dir, width / 2 - iw / 2).setY(fl), dir, iw, H, t * 0.6);
  }
  // ステルス枠は枠を見せない（小口は壁と同じ仕上げ）
  const handle = (mbx: MeshBuilder, base: THREE.Vector3, along: THREE.Vector3, nrm: THREE.Vector3) => {
    if (spec.doors.handle === 'slim-lever') {
      // 細身のレバーハンドル（両面）
      for (const sgn of [1, -1]) {
        const p = base.clone().addScaledVector(nrm, sgn * (doorT / 2 + 0.028));
        mbx.box('f.handle', p.clone().addScaledVector(along, 0.055), along, 0.13, 0.012, 0.012);
        mbx.box('f.handle', p.clone().addScaledVector(nrm, -sgn * 0.014).addScaledVector(along, 0), along, 0.012, 0.012, 0.028);
      }
    } else {
      mbx.box('f.metal', base.clone().addScaledVector(nrm, doorT / 2 + 0.02), along, 0.12, 0.02, 0.02);
      mbx.box('f.metal', base.clone().addScaledVector(nrm, -doorT / 2 - 0.02), along, 0.12, 0.02, 0.02);
    }
  };
  // LDK とホール・廊下・玄関の間の扉は、黒の細框のガラス戸（ホームランディックの定番）
  const glassEntry = (() => {
    if (w.exterior) return false;
    const side = (sg: number) => roomAt(f, (mid.x + nW.x * sg * (t / 2 + 0.3)) / MM, (mid.z + nW.z * sg * (t / 2 + 0.3)) / MM);
    const a = side(1)?.type;
    const b = side(-1)?.type;
    const ldk = (x?: string) => x === 'ldk' || x === 'living' || x === 'dining';
    const pass = (x?: string) => x === 'hall' || x === 'entrance' || x === 'stairs';
    return (ldk(a) && pass(b)) || (ldk(b) && pass(a));
  })();
  /** 扉の板: 通常は壁になじむフラット扉、LDK の入口は框（30mm の黒）＋ガラス */
  const leaf = (m: MeshBuilder, center: THREE.Vector3, len: number, hgt: number, th: number) => {
    if (!glassEntry) {
      m.box('int.door', center, V(1, 0, 0), len, hgt, th);
      return;
    }
    const fwid = 0.03;
    const fk = 'ext.frame';
    m.box(fk, center.clone().add(V(-len / 2 + fwid / 2, 0, 0)), V(1, 0, 0), fwid, hgt, th);
    m.box(fk, center.clone().add(V(len / 2 - fwid / 2, 0, 0)), V(1, 0, 0), fwid, hgt, th);
    m.box(fk, center.clone(), V(1, 0, 0), len - fwid * 2, fwid * 2, th);
    m.box(fk, center.clone().add(V(0, hgt - fwid, 0)), V(1, 0, 0), len - fwid * 2, fwid, th);
    m.box('ext.glass', center.clone().add(V(0, fwid * 2, 0)), V(1, 0, 0), len - fwid * 2, hgt - fwid * 3, 0.006);
  };
  if (o.kind === 'door') {
    const hingeS = o.hingeAtStart !== false ? s0 : s1;
    const towards = o.hingeAtStart !== false ? 1 : -1; // ヒンジから戸先方向
    // 外壁の扉は室内側へ開く（外へ扉の板が飛び出して見えないように）
    let side = (w.exterior && w.outsideSign ? -w.outsideSign : (o.swingSide ?? 1)) as number;
    // 開いた扉の先端が建物の外に出る場合は反対側へ。どちらも出る場合は閉じておく
    const lw0 = width - 0.008;
    const tipInside = (sd: number) => {
      const hg = A.clone().addScaledVector(dir, hingeS).addScaledVector(nW, sd * (t / 2));
      const ld = dir.clone().multiplyScalar(towards * Math.cos(1.396)).addScaledVector(nW, sd * Math.sin(1.396)).normalize();
      const tip = hg.addScaledVector(ld, lw0);
      return f.outline.some((l) => pointInPolygon({ x: tip.x / MM, y: tip.z / MM }, l));
    };
    let ang = (80 * Math.PI) / 180;
    if (!tipInside(side)) {
      if (!w.exterior && tipInside(-side)) side = -side;
      else ang = 0;
    }
    const hinge = A.clone().addScaledVector(dir, hingeS).addScaledVector(nW, side * (t / 2));
    const leafDir = dir.clone().multiplyScalar(towards * Math.cos(ang)).addScaledVector(nW, side * Math.sin(ang)).normalize();
    const lw = width - 0.008;
    meta.doorLeaves.push({ a: hinge.clone().setY(fl), b: hinge.clone().addScaledVector(leafDir, lw).setY(fl) });
    // 扉の板は独立した部品（ヒンジが原点、+X が閉じた板の向き）。通常表示は従来どおりの開き具合、ウォークスルーで開閉する
    const closedDir = dir.clone().multiplyScalar(towards);
    const fullOpen = dir.clone().multiplyScalar(towards * Math.cos(1.396)).addScaledVector(nW, side * Math.sin(1.396)).normalize();
    const dmb = new MeshBuilder();
    dmb.clip = localClip(hinge.clone().setY(0), Math.atan2(-closedDir.z, closedDir.x));
    leaf(dmb, V(lw / 2, fl + 0.008, 0), lw, H - 0.008 - topGap, doorT);
    handle(dmb, V(lw - 0.075, fl + 1.0, 0), V(-1, 0, 0), V(0, 0, 1));
    meta.doors.push({
      id: o.id,
      kind: 'swing',
      level: f.level,
      origin: hinge.clone().setY(0),
      yaw0: Math.atan2(-closedDir.z, closedDir.x),
      openAngle: Math.atan2(closedDir.z * fullOpen.x - closedDir.x * fullOpen.z, closedDir.dot(fullOpen)),
      slideDir: new THREE.Vector3(),
      slideDist: 0,
      staticOpen: 0,
      cutOpen: ang > 0 ? ang / 1.396 : 0,
      mb: dmb,
      width: lw,
    });
  } else if (o.kind === 'sliding') {
    // 引戸: 通常は 6 割開けておく（壁の端・別の開口・建物の外にはみ出さない側へ引き込む）。ウォークスルーで開閉する
    const Lw = A.distanceTo(B);
    const others = f.openings.filter((q) => q.wallId === w.id && q.id !== o.id);
    const lw = width - 0.01;
    // 引き込める長さ（壁芯方向）: 壁の端か次の開口まで
    const avail = (sd: number) => {
      let lim = sd > 0 ? Lw - 0.05 - s1 : s0 - 0.05;
      for (const q of others) {
        const q0 = q.t0 * MM;
        const q1 = q.t1 * MM;
        if (sd > 0 && q0 > s1 - 0.02) lim = Math.min(lim, q0 - 0.02 - s1);
        if (sd < 0 && q1 < s0 + 0.02) lim = Math.min(lim, s0 - (q1 + 0.02));
      }
      return Math.max(0, lim);
    };
    const insideAt = (sd: number, fc: number, dist: number) => {
      const tt = sd > 0 ? s1 + dist : s0 - dist;
      const p = A.clone().addScaledVector(dir, tt).addScaledVector(nW, fc * (t / 2 + 0.06));
      return !f.outline.length || f.outline.some((l) => pointInPolygon({ x: p.x / MM, y: p.z / MM }, l));
    };
    let pick: { sd: number; fc: number; dist: number } | null = null;
    // 方眼で決めた「引き込む側（hingeAtStart = false なら始点側へ）」「戸の面（swingSide）」を優先し、引き込めないときだけ自動で選ぶ
    const wantSd = o.hingeAtStart == null ? null : o.hingeAtStart === false ? -1 : 1;
    const wantFc = o.swingSide ?? null;
    for (const sd of [1, -1])
      for (const fc of [1, -1]) {
        const dist = Math.min(width * 0.92, avail(sd));
        if (dist < 0.3 || !insideAt(sd, fc, dist * 0.5) || !insideAt(sd, fc, dist)) continue;
        const score = dist + (wantSd === sd ? 10 : 0) + (wantFc === fc ? 5 : 0);
        if (!pick || score > pick.dist + (wantSd === pick.sd ? 10 : 0) + (wantFc === pick.fc ? 5 : 0)) pick = { sd, fc, dist };
      }
    const fc = pick?.fc ?? 1;
    const face = mid.clone().addScaledVector(nW, fc * (t / 2 + 0.025));
    const slideDir = dir.clone().multiplyScalar(pick?.sd ?? 1);
    const slideDist = pick?.dist ?? 0;
    // 通常表示は閉じる。輪切り模型では 6 割開けて、行き来できる所が分かるようにする
    const cutOpen = pick && slideDist >= width * 0.4 ? 0.6 : 0;
    const dmb = new MeshBuilder();
    dmb.clip = localClip(face.clone().setY(0), Math.atan2(-dir.z, dir.x));
    leaf(dmb, V(0, fl + 0.008, 0), lw, H - 0.008 - topGap, doorT * 0.9);
    // 引手（細い縦長の彫り込みを暗い線で表現。引き込む側と反対の端）
    dmb.box('f.handle', V(-(pick?.sd ?? 1) * (lw / 2 - 0.05), fl + 0.85, fc * (doorT * 0.45 + 0.001)), V(1, 0, 0), 0.012, 0.35, 0.002);
    meta.doors.push({
      id: o.id,
      kind: 'slide',
      level: f.level,
      origin: face.clone().setY(0),
      yaw0: Math.atan2(-dir.z, dir.x),
      openAngle: 0,
      slideDir,
      slideDist,
      staticOpen: 0,
      cutOpen,
      mb: dmb,
      width: lw,
    });
    // 開けたときに板が来る位置（家具・カメラが避ける範囲）
    const cs = face.clone().addScaledVector(slideDir, slideDist * cutOpen).setY(fl);
    meta.doorLeaves.push({ a: cs.clone().addScaledVector(dir, -lw / 2), b: cs.clone().addScaledVector(dir, lw / 2) });
    if (!spec.doors.fullHeight) mb.box(trim, face.clone().setY(head + cw), dir, width * 2, 0.04, 0.03);
  }
}

/**
 * 波打つ薄い布（カーテン）: 壁に沿う方向 dir に長さ len、正弦波（振幅 3.5cm・周期 11cm）で前後にうねる面を、両面で作る
 */
function curtainWave(mb: MeshBuilder, start: THREE.Vector3, dir: THREE.Vector3, outN: THREE.Vector3, len: number, y0: number, y1: number) {
  const period = 0.11;
  const amp = 0.035;
  const n = Math.max(4, Math.round((len / period) * 6));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const u = (len * i) / n;
    const w = Math.sin((u / period) * Math.PI * 2) * amp;
    pts.push(start.clone().addScaledVector(dir, u).addScaledVector(outN, w));
  }
  for (let i = 0; i < n; i++) {
    const a = pts[i].clone().setY(y0);
    const b = pts[i + 1].clone().setY(y0);
    const c = pts[i + 1].clone().setY(y1);
    const d = pts[i].clone().setY(y1);
    mb.quad('f.curtain', a, b, c, d, dir, V(0, 1, 0));
    mb.quad('f.curtain', b, a, d, c, dir, V(0, 1, 0));
  }
}

/**
 * 部屋の辺 p→q（mm）から、その辺に沿う壁の室内側の面までの距離 (m)。inward = 室内側の向き（単位ベクトル）。
 * 部屋の多角形は壁の芯に沿うことが多いが、面に沿うこともあるので、沿う壁を探して測る。見つからなければ 65mm
 */
function wallFaceOffsetM(f: Floor, p: Vec2, q: Vec2, inward: { x: number; y: number }): number {
  const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  const ang = Math.atan2(q.y - p.y, q.x - p.x);
  let best = 0.065;
  let bd = 140;
  for (const w of f.walls) {
    let da = Math.abs(Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x) - ang) % Math.PI;
    da = Math.min(da, Math.PI - da);
    if (da > 0.14) continue;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const t = Math.max(0, Math.min(1, ((mid.x - w.a.x) * (w.b.x - w.a.x) + (mid.y - w.a.y) * (w.b.y - w.a.y)) / (L * L)));
    const cx = w.a.x + (w.b.x - w.a.x) * t;
    const cy = w.a.y + (w.b.y - w.a.y) * t;
    const dist = Math.hypot(cx - mid.x, cy - mid.y);
    if (dist >= bd) continue;
    bd = dist;
    // 壁の芯が辺より室内側にあれば +、外側にあれば −
    const s = (cx - mid.x) * inward.x + (cy - mid.y) * inward.y;
    best = Math.max(0.01, (s + w.thickness / 2) * MM);
  }
  return best;
}

/** 間接照明が壁を照らす光の、天井からの長さ (m) */
const WASH_H = 0.6;

/**
 * 部屋の辺 p→q（mm）のうち、天井まで立つ壁が沿っていて、戸・窓の無い区間（辺の p からの距離。m）。
 * 壁の無い所（隣の空間に開いている）・腰壁・開口の所は入らない
 */
function solidWallRuns(f: Floor, p: Vec2, q: Vec2): [number, number][] {
  const L = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const ux = (q.x - p.x) / L;
  const uy = (q.y - p.y) / L;
  const off = (pt: Vec2) => Math.abs(-(pt.x - p.x) * uy + (pt.y - p.y) * ux);
  const out: [number, number][] = [];
  for (const w of f.walls) {
    const wl = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (wl < 200) continue;
    if (Math.abs(((w.b.x - w.a.x) * uy - (w.b.y - w.a.y) * ux) / wl) > 0.14) continue;
    if (off(w.a) > 140 || off(w.b) > 140) continue;
    if (w.topMm != null && w.topMm < f.ceilingHeight - 100) continue;
    const ta = (w.a.x - p.x) * ux + (w.a.y - p.y) * uy;
    const tb = (w.b.x - p.x) * ux + (w.b.y - p.y) * uy;
    const run: [number, number] = [Math.max(0, Math.min(ta, tb)), Math.min(L, Math.max(ta, tb))];
    if (run[1] - run[0] < 300) continue;
    const sgn = tb >= ta ? 1 : -1;
    const holes = f.openings
      .filter((o) => o.wallId === w.id)
      .map((o): [number, number] => {
        const x0 = ta + sgn * o.t0;
        const x1 = ta + sgn * o.t1;
        return [Math.min(x0, x1) - 60, Math.max(x0, x1) + 60];
      });
    out.push(...subtractIntervals(run, mergeIntervals(holes)));
  }
  return mergeIntervals(out, 20).map(([a, b]): [number, number] => [a * MM, b * MM]);
}

/** 主室（LDK）: 天井を別の素材にできる部屋 */
const MAIN_CEILING_ROOMS = new Set<Room['type']>(['ldk', 'living', 'dining', 'kitchen']);

/** 天井のダウンライト・間接照明 */
function buildCeilingDetails(mb: MeshBuilder, f: Floor, fl: number, spec: BuilderSpec, ceilVoids: { minX: number; minY: number; maxX: number; maxY: number }[] = []) {
  // 上が吹抜・階段で天井の無い所（mm）。そこには器具を付けない（以前は LDK の吹抜の空中に、1 階の天井の高さでダウンライトが浮いていた）
  const openAbove = (xMm: number, yMm: number, margin = 100) => ceilVoids.some((v) => xMm > v.minX - margin && xMm < v.maxX + margin && yMm > v.minY - margin && yMm < v.maxY + margin);
  for (const r of f.rooms) {
    const ceil = fl + roomCeilingMm(f, r) * MM;
    if (['closet', 'storage', 'void', 'balcony', 'porch', 'stairs', 'garage'].includes(r.type) || outdoorRoom(r)) continue;
    const xs = r.polygon.map((p) => p.x * MM);
    const zs = r.polygon.map((p) => p.y * MM);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const z0 = Math.min(...zs);
    const z1 = Math.max(...zs);
    if (spec.lighting === 'downlight') {
      // 照明計画: 小さな（φ75）ダウンライトを 3 灯一列のまとまりにして点在させる（均等にばらまかない）。
      // 小さな部屋・水まわりは 1 灯
      const lamp = (x: number, z: number, rr: number) => {
        if (!pointInPolygon({ x: x / MM, y: z / MM }, r.polygon)) return;
        if (openAbove(x / MM, z / MM)) return;
        mb.cylinder('f.downlightRing', V(x, ceil - 0.004, z), rr + 0.008, 0.003, 20);
        mb.cylinder('f.downlight', V(x, ceil - 0.006, z), rr, 0.003, 20);
      };
      const W = x1 - x0;
      const Dp = z1 - z0;
      const small = ['bath', 'toilet', 'washroom', 'closet', 'storage', 'hall', 'entrance', 'corridor'].includes(r.type) || W * Dp < 7;
      if (small) lamp((x0 + x1) / 2, (z0 + z1) / 2, 0.04);
      else {
        const alongX = W >= Dp;
        const L = alongX ? W : Dp;
        const S = alongX ? Dp : W;
        const nL = Math.max(1, Math.round((L - 1.0) / 2.7));
        const nS = S >= 4.6 ? 2 : 1;
        for (let i = 0; i < nL; i++)
          for (let j = 0; j < nS; j++) {
            const cL = nL === 1 ? L / 2 : 0.9 + ((L - 1.8) * i) / (nL - 1);
            const cS = nS === 1 ? S / 2 : 0.9 + ((S - 1.8) * j) / (nS - 1);
            for (const k of [-1, 0, 1]) {
              const a = cL + k * 0.3;
              const x = alongX ? x0 + a : x0 + cS;
              const z = alongX ? z0 + cS : z0 + a;
              lamp(x, z, 0.0375);
            }
          }
      }
    } else if (!['bath', 'toilet'].includes(r.type) && !openAbove((x0 + x1) / 2 / MM, (z0 + z1) / 2 / MM)) {
      mb.cylinder('f.lampShade', V((x0 + x1) / 2, ceil - 0.08, (z0 + z1) / 2), 0.28, 0.08, 28);
    }
    // 間接照明: LDK・リビング・寝室の長い壁の天井際（窓のない壁）
    if (spec.indirectLighting && ['ldk', 'living', 'bedroom'].includes(r.type)) {
      let best: { a: THREE.Vector3; b: THREE.Vector3; len: number; p: Vec2; q: Vec2 } | null = null;
      for (let i = 0; i < r.polygon.length; i++) {
        const p = r.polygon[i];
        const q = r.polygon[(i + 1) % r.polygon.length];
        const len = Math.hypot(q.x - p.x, q.y - p.y) * MM;
        if (len < 2.4) continue;
        const hasWin = f.openings.some((o) => {
          if (o.kind !== 'window') return false;
          const w = f.walls.find((w) => w.id === o.wallId);
          if (!w) return false;
          const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
          const tm = (o.t0 + o.t1) / 2 / L;
          const c = { x: w.a.x + (w.b.x - w.a.x) * tm, y: w.a.y + (w.b.y - w.a.y) * tm };
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const t = Math.max(0, Math.min(1, ((c.x - p.x) * dx + (c.y - p.y) * dy) / (dx * dx + dy * dy)));
          return Math.hypot(p.x + dx * t - c.x, p.y + dy * t - c.y) < 300;
        });
        if (hasWin) continue;
        // 吹抜の下の壁（天井が無い）には付けない: 壁の内側 25cm の所が吹抜なら除く
        {
          const mx = (p.x + q.x) / 2;
          const my = (p.y + q.y) / 2;
          const l = Math.hypot(q.x - p.x, q.y - p.y) || 1;
          const nx = (-(q.y - p.y) / l) * 250;
          const ny = ((q.x - p.x) / l) * 250;
          const inside = pointInPolygon({ x: mx + nx, y: my + ny }, r.polygon) ? { x: mx + nx, y: my + ny } : { x: mx - nx, y: my - ny };
          if (openAbove(inside.x, inside.y, 0)) continue;
        }
        if (!best || len > best.len) best = { a: V(p.x * MM, 0, p.y * MM), b: V(q.x * MM, 0, q.y * MM), len, p, q };
      }
      if (best) {
        const d = best.b.clone().sub(best.a).normalize();
        const n = new THREE.Vector3(-d.z, 0, d.x);
        const mid = best.a.clone().add(best.b).multiplyScalar(0.5);
        // 室内側へ
        const inside = pointInPolygon({ x: (mid.x + n.x * 0.3) / MM, y: (mid.z + n.z * 0.3) / MM }, r.polygon) ? 1 : -1;
        const c = mid.clone().addScaledVector(n, inside * 0.16);
        // 天井のスリット（幅 140）。壁側の 90 が光る帯で、部屋側に細い影の縁が残る
        mb.box('int.shadowGap', c.clone().setY(ceil - 0.005), d, best.len - 0.3, 0.005, 0.14);
        mb.box('f.cove', c.clone().addScaledVector(n, -inside * 0.02).setY(ceil - 0.012), d, best.len - 0.36, 0.006, 0.09);
        // 壁を照らす光: 壁の面のすぐ手前に、天井際から下へ弱くなる光の面（加算）を重ねる。
        // 天井まで立つ壁のある区間にだけ（戸・窓・壁の無い所・腰壁の上には出さない: 光だけが宙に浮いて見える）
        const inward = { x: n.x * inside, y: n.z * inside };
        const face = wallFaceOffsetM(f, best.p, best.q, inward) + 0.004;
        for (const [t0, t1] of solidWallRuns(f, best.p, best.q)) {
          const lenRun = t1 - t0 - 0.06;
          if (lenRun < 0.3) continue;
          const at = best.a.clone().addScaledVector(d, (t0 + t1) / 2).addScaledVector(n, inside * face);
          mb.glowPlane('f.coveGlow', at.setY(ceil - 0.02 - WASH_H / 2), d, V(0, 1, 0), lenRun, WASH_H);
        }
      }
    }
  }
}

/** 踏板の素材のキー（指定が無い・「床に合わせる」は int.stairs） */
const treadKeyOf = (look: StairLook | undefined): string => (look?.tread && look.tread !== 'floor' ? `int.stairs@${look.tread}` : 'int.stairs');
/** 鉄の骨組み・手すりの素材のキー（黒 = テイストの金物の色、白 = 白く塗った鉄） */
const frameKeyOf = (look: StairLook | undefined): string => (look?.frame === 'white' ? 'f.steelWhite' : 'f.metal');

/**
 * 階段（直・折り返し・コの字・かね折れ）。
 * つくりはコーディネートの「階段」の品目（家に 1 つ）、手すり・桁・踏板の色・鉄の色は、こだわり指定（参考資料）で階段ごとに変えられる（Stair.look。core/focus.ts）。
 * 指定が無ければ御社の施工事例の形 = 両側の黒い鋼板のささら桁に木の踏板（蹴込みなし）＋細いフラットバーの手すり
 *  - steel: 厚さ 40 の踏板を、両側のささら桁（黒皮鉄の鋼板 t12 × 250）で支える。蹴込みなし。look.stringer = 'center' なら中央の力桁 1 本
 *  - woodSkeleton: 厚さ 40 の踏板を、両側の木の側板（36 × 260。黒の塗りつぶし = コーディネートの「木製スケルトン階段」）で支える。蹴込みなし
 *  - box: 箱階段。蹴込み板があり、段の両脇は床まで閉じる（下は収納・壁）
 *  - cantilever: 片持ち。厚さ 60 の踏板だけ（桁・側板は見せない）
 */
function buildStairs(mb: MeshBuilder, s: Stair, y0: number, y1: number, f?: Floor, build: StairBuild = 'steel') {
  const rise = y1 - y0;
  const n = effectiveStepCount(rise / MM, s);
  const rh = rise / n;
  const tread = treadKeyOf(s.look);
  const frame = frameKeyOf(s.look);
  const rail: StairRail = s.look?.rail ?? 'bar';
  const centerStringer = build === 'steel' && s.look?.stringer === 'center';
  const thick = build === 'cantilever' ? 0.06 : build === 'box' ? 0.03 : 0.04;
  const put = (p: { minX: number; minY: number; maxX: number; maxY: number; i: number; dir: { x: number; y: number } }, yTop: number) => {
    const min = V(p.minX * MM, yTop - thick, p.minY * MM);
    const max = V(p.maxX * MM, yTop, p.maxY * MM);
    if (max.x - min.x < 0.01 || max.z - min.z < 0.01) return;
    mb.aabb(tread, min, max);
    if (build === 'steel') {
      const longX = max.x - min.x >= max.z - min.z;
      const plateT = 0.012;
      const ph = Math.min(0.08, rh * 0.5);
      if (centerStringer) {
        // 力桁の上の受け板（踏板の中央の下に、幅 240 の鋼板 t9）
        const t = 0.009;
        if (longX) mb.aabb(frame, V((min.x + max.x) / 2 - 0.12, yTop - thick - t, min.z + 0.02), V((min.x + max.x) / 2 + 0.12, yTop - thick, max.z - 0.02));
        else mb.aabb(frame, V(min.x + 0.02, yTop - thick - t, (min.z + max.z) / 2 - 0.12), V(max.x - 0.02, yTop - thick, (min.z + max.z) / 2 + 0.12));
      } else if (longX) {
        // 受け材（踏板の長手方向の両端＝ささら桁の内側に付く薄い板）
        for (const x of [min.x + 0.03, max.x - 0.03 - plateT]) mb.aabb(frame, V(x, yTop - thick - ph, min.z + 0.02), V(x + plateT, yTop - thick, max.z - 0.02));
      } else {
        for (const z of [min.z + 0.03, max.z - 0.03 - plateT]) mb.aabb(frame, V(min.x + 0.02, yTop - thick - ph, z), V(max.x - 0.02, yTop - thick, z + plateT));
      }
    }
    if (build === 'box') {
      // 蹴込み板: 昇る人から見た手前の縁に、1 段下の踏板の天端からこの踏板の下まで
      const t = 0.018;
      const lo = Math.max(y0, yTop - rh);
      const hi = yTop - thick;
      if (hi - lo > 0.01) {
        if (Math.abs(p.dir.x) > 0.5) {
          const x = p.dir.x > 0 ? min.x : max.x - t;
          mb.aabb('int.wall', V(x, lo, min.z), V(x + t, hi, max.z));
        } else {
          const z = p.dir.y > 0 ? min.z : max.z - t;
          mb.aabb('int.wall', V(min.x, lo, z), V(max.x, hi, z + t));
        }
      }
      // 段の両脇を床まで閉じる（段々の側面。壁に沿う側は壁に隠れる）
      const sideT = 0.02;
      if (hi - y0 > 0.02) {
        if (Math.abs(p.dir.x) > 0.5) {
          for (const z of [min.z, max.z - sideT]) mb.aabb('int.wall', V(min.x, y0, z), V(max.x, hi, z + sideT));
        } else {
          for (const x of [min.x, max.x - sideT]) mb.aabb('int.wall', V(x, y0, min.z), V(x + sideT, hi, max.z));
        }
      }
    }
  };
  const lay = stairLayout(s, n);
  for (const p of lay.pieces) put(p, y0 + rh * p.i);
  // 折り返し階段の中央の腰壁
  if (lay.wall) mb.aabb('int.wall', V(lay.wall.minX * MM, y0, lay.wall.minY * MM), V(lay.wall.maxX * MM, y0 + rise * 0.5 + 0.9, lay.wall.maxY * MM));
  stairRunDetails(mb, lay, rh, y0, f, build, rail, thick, centerStringer, frame);
  // コの字階段の中央の吹抜: 上階の床の縁（踊り場の反対側の辺）に手すり。段の脇の手すりは stairRunDetails が吹抜側に付ける
  if (lay.well && rail !== 'none') {
    const w = lay.well;
    const first = lay.pieces[0];
    const horiz = Math.abs(first.dir.x) > 0.5;
    // 昇り口側の辺（吹抜が上階の廊下に開く縁）
    const a = horiz ? V((first.dir.x > 0 ? w.minX : w.maxX) * MM, y1, w.minY * MM) : V(w.minX * MM, y1, (first.dir.y > 0 ? w.minY : w.maxY) * MM);
    const b = horiz ? V(a.x, y1, w.maxY * MM) : V(w.maxX * MM, y1, a.z);
    if (rail === 'glass') buildGuardPath(mb, 'glass', [a, b], y1, frame);
    else if (rail === 'wall') {
      const d = b.clone().sub(a);
      const L = d.length();
      d.normalize();
      mb.box('int.wall', a.clone().addScaledVector(d, L / 2).setY(y1), d, L, 1.0, 0.1);
    } else if (rail === 'wood') {
      const d = b.clone().sub(a);
      const L = d.length();
      d.normalize();
      const posts = Math.max(2, Math.round(L / 0.9) + 1);
      const tops: THREE.Vector3[] = [];
      for (let k = 0; k < posts; k++) {
        const p = a.clone().addScaledVector(d, (L * k) / (posts - 1));
        mb.box('f.wood', p.clone(), d, 0.04, 0.9, 0.04);
        tops.push(p.clone().setY(y1 + 0.9));
      }
      for (let k = 0; k + 1 < tops.length; k++) mb.tube('f.wood', tops[k], tops[k + 1], 0.022, 0.022, 10);
    } else buildGuardPath(mb, 'steel', [a, b], y1, frame);
  }
}

/**
 * 段の列（直線の区間）ごとの骨組みと手すり。
 * 骨組み: 鉄骨 = 両側のささら桁（黒皮鉄の鋼板）を勾配なりに（指定で中央の力桁 1 本）／木のスケルトン = 両側の側板／箱階段・片持ち = なし。
 * 手すりは壁の無い側にだけ: アイアン（細いフラットバーの支柱 @ 約 1m ＋ 上の手すり ＋ 横桟 1 本）・ガラス・腰壁・木。
 */
function stairRunDetails(mb: MeshBuilder, lay: ReturnType<typeof stairLayout>, rh: number, y0: number, f: Floor | undefined, build: StairBuild, rail: StairRail, thick: number, centerStringer = false, metal = 'f.metal') {
  type Piece = (typeof lay.pieces)[number];
  const center = (p: Piece) => V(((p.minX + p.maxX) / 2) * MM, 0, ((p.minY + p.maxY) / 2) * MM);
  // 同じ向きに続く踏板を 1 つの区間に
  const runs: Piece[][] = [];
  for (const p of lay.pieces) {
    if (p.kind !== 'tread') {
      runs.push([]);
      continue;
    }
    const last = runs[runs.length - 1];
    if (last && last.length && last[0].dir.x === p.dir.x && last[0].dir.y === p.dir.y) last.push(p);
    else runs.push([p]);
  }
  const up = new THREE.Vector3(0, 1, 0);
  for (const run of runs.filter((r) => r.length >= 2)) {
    const a = run[0];
    const b = run[run.length - 1];
    const d = V(a.dir.x, 0, a.dir.y).normalize();
    const perp = V(-d.z, 0, d.x);
    const ca = center(a).setY(y0 + rh * a.i - thick);
    const cb = center(b).setY(y0 + rh * b.i - thick);
    const treadD = Math.abs(V(b.maxX - b.minX, 0, b.maxY - b.minY).dot(d)) * MM;
    const treadW = Math.abs(V(b.maxX - b.minX, 0, b.maxY - b.minY).dot(perp)) * MM;
    // 勾配なりの軸（x = 勾配の向き、y = それに直交、z = 階段の幅の向き）
    const x = cb.clone().sub(ca);
    const len = x.length() + treadD;
    x.normalize();
    const z = perp.clone();
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    const mid = ca.clone().add(cb).multiplyScalar(0.5);
    /** 勾配なりの板（厚み t・せい hgt）を、踏板の下 drop・幅方向 off の位置に */
    const sloped = (key: string, hgt: number, t: number, drop: number, off: number) => {
      const geo = new THREE.BoxGeometry(len, hgt, t);
      const m = new THREE.Matrix4().makeBasis(x, y, z);
      m.setPosition(mid.clone().addScaledVector(y, -drop).addScaledVector(z, off));
      mb.addGeometry(key, geo, m);
      geo.dispose();
    };
    /** 勾配なりで、両端が鉛直の板（手すりのガラス・腰壁）: 踏板の天端の線から lo〜hi の高さ、幅方向 off の位置に */
    const upright = (key: string, lo: number, hi: number, t: number, off: number) => {
      const geo = new THREE.BoxGeometry(len, hi - lo, t);
      const m = new THREE.Matrix4().makeBasis(x, up, z);
      m.setPosition(mid.clone().addScaledVector(up, thick + (lo + hi) / 2).addScaledVector(z, off));
      mb.addGeometry(key, geo, m);
      geo.dispose();
    };
    if (build === 'steel') {
      // 力桁（中央 1 本）: 踏板の下 11cm を中心に、幅 100 × せい 180 の角形鋼管
      if (centerStringer) sloped(metal, 0.18, 0.1, 0.11, 0);
      // ささら桁（両側）: 鋼板 t12 × 250。踏板の小口を挟む。外の面を踏板の小口より 3mm 外へ（同じ面に重ねない）
      else for (const sg of [1, -1]) sloped(metal, 0.25, 0.012, 0, sg * (treadW / 2 - 0.003));
    }
    // 木の側板: 両側に 36 × 260（踏板の小口を受ける）。品目どおり黒の塗りつぶし塗装。外の面は踏板の小口より 3mm 外へ
    if (build === 'woodSkeleton') for (const sg of [1, -1]) sloped('f.paintBlack', 0.26, 0.036, 0.09, sg * (treadW / 2 - 0.015));
    if (rail === 'none') continue;
    // 手すり: 壁の無い側（踏板の脇 30cm が階段以外の部屋、またはコの字階段の中央の吹抜）にだけ
    for (const sg of [1, -1]) {
      let open = false;
      const midP = center(run[Math.floor(run.length / 2)]);
      const q = midP.clone().addScaledVector(perp, sg * (treadW / 2 + 0.3));
      if (lay.well && q.x / MM > lay.well.minX && q.x / MM < lay.well.maxX && q.z / MM > lay.well.minY && q.z / MM < lay.well.maxY) open = true;
      else if (f) {
        const r = roomAt(f, q.x / MM, q.z / MM);
        open = !!r && r.type !== 'stairs' && r.type !== 'closet' && r.type !== 'storage';
      }
      if (!open) continue;
      const off = sg * (treadW / 2 - 0.05);
      if (rail === 'glass') {
        // ガラスのパネル（t12・踏板の上 50〜950）と、上の縁の細い笠木
        upright('ext.glass', 0.05, 0.95, 0.012, off);
        upright(metal, 0.95, 0.975, 0.03, off);
        continue;
      }
      if (rail === 'wall') {
        // 腰壁（厚み 100・踏板の下 250 から上 900）と木の笠木
        // 外の面を踏板の小口より 5mm 外へ（同じ面に重なると、踏板の小口がちらついて見える）
        upright('int.wall', -0.25 - thick, 0.9, 0.1, sg * (treadW / 2 - 0.045));
        upright('f.wood', 0.9, 0.93, 0.12, sg * (treadW / 2 - 0.045));
        continue;
      }
      const wood = rail === 'wood';
      const key = wood ? 'f.wood' : metal;
      // 支柱の位置: 木は踏板 2 枚ごと。アイアンは約 1m（踏板 4 枚）ごとに等分（御社の事例は支柱が少なく、横桟 1 本で軽く見せる）
      const last = run.length - 1;
      const seg = wood ? Math.max(1, Math.round(last / 2)) : Math.max(1, Math.round(last / 4));
      const idx = [...new Set(Array.from({ length: seg + 1 }, (_, j) => Math.round((last * j) / seg)))];
      // 鉄骨のささら桁があるときは、支柱を桁の上に立てる（踏板の小口の位置）
      const postOff = !wood && build === 'steel' && !centerStringer ? sg * (treadW / 2 - 0.006) : off;
      const posts: THREE.Vector3[] = [];
      for (const k of idx) {
        const p = run[k];
        const base = center(p).setY(y0 + rh * p.i).addScaledVector(perp, postOff);
        // 支柱: アイアンはフラットバー 12×38（細い面を昇る向きに）、木は 40 角。踏板の上 900
        if (wood) mb.box(key, base.clone(), d, 0.04, 0.9, 0.04);
        else mb.box(key, base.clone(), d, 0.012, 0.9, 0.038);
        posts.push(base.clone().setY(base.y + 0.9));
      }
      if (wood) {
        // 木の手すり（支柱の天端を結ぶ）: φ44
        for (let k = 0; k + 1 < posts.length; k++) mb.tube(key, posts[k], posts[k + 1], 0.022, 0.022, 10);
      } else if (posts.length >= 2) {
        // 上の手すり（フラットバー 12×40 を勾配なりに）と、中ほどの横桟 1 本（9×25）: 両端の支柱の間を通す
        const p0 = posts[0];
        const p1 = posts[posts.length - 1];
        const bar = (drop: number, t: number, w: number) => {
          const a0 = p0.clone().setY(p0.y - drop);
          const a1 = p1.clone().setY(p1.y - drop);
          const ax = a1.clone().sub(a0);
          const L = ax.length();
          ax.normalize();
          const ay = new THREE.Vector3().crossVectors(z, ax).normalize();
          const geo = new THREE.BoxGeometry(L + 0.012, t, w);
          const m = new THREE.Matrix4().makeBasis(ax, ay, z);
          m.setPosition(a0.clone().add(a1).multiplyScalar(0.5));
          mb.addGeometry(key, geo, m);
          geo.dispose();
        };
        bar(0.006, 0.012, 0.04);
        bar(0.45, 0.009, 0.025);
      }
    }
  }
}
