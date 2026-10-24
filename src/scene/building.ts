/**
 * 建物モデル → 3D ジオメトリ
 * 単位: m。平面 (x, y[下向き]) → ワールド (X = x, Z = y)、Y が上。
 */
import * as THREE from 'three';
import type { BuildingModel, Floor, Opening, Room, Stair, Wall } from '../core/types';
import { pointInPolygon, isHoleLoop } from '../core/geometry';
import { isRectilinear, polygonToRects, rectsMinus, offsetPolygon, type Rect } from '../core/rects';
import { MeshBuilder, topClip, type ClipPlane, V } from './meshBuilder';
import { stairLayout, stairStepCount } from '../core/stairs';
import type { ExteriorStyle } from '../styles/presets';
import { BUILDER_SPECS, effectiveOpening, type BuilderSpec } from '../styles/spec';

export const MM = 0.001;

export interface BuildOptions {
  exterior: ExteriorStyle;
  /** 標準仕様（建具・窓・照明の納まり） */
  spec?: BuilderSpec;
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
  kind: 'swing' | 'slide';
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
  /** 通常表示（ウォークスルー以外）での開き具合 0〜1 */
  staticOpen: number;
  mb: MeshBuilder;
  width: number;
}

const up = new THREE.Vector3(0, 1, 0);

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

/** 上下階の階段（上階の床に穴をあける） */
export function stairVoidsFor(model: BuildingModel, f: Floor): Rect[] {
  const idx = model.floors.indexOf(f);
  const below = model.floors[idx - 1];
  const out: Rect[] = [];
  if (below) for (const s of below.stairs) if (s.goesUp) out.push(s);
  // 上階に DN 階段があり、下階に対応する階段がない場合も穴を開ける
  for (const s of f.stairs) {
    if (!s.goesUp && below && !below.stairs.some((b) => Math.abs(b.minX - s.minX) < 300 && Math.abs(b.minY - s.minY) < 300)) out.push(s);
  }
  // 吹抜
  for (const r of f.rooms) if (r.type === 'void') {
    const xs = r.polygon.map((p) => p.x);
    const ys = r.polygon.map((p) => p.y);
    out.push({ minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) });
  }
  return out;
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
    for (const w0 of f.walls) {
      if (stub(w0)) continue;
      // 仕様に合わせて開口の高さを調整（フルハイトドア・サッシ上端＝天井）
      const ops0 = f.openings
        .filter((o) => o.wallId === w0.id)
        .map((o) => ({ ...o, ...effectiveOpening(o, f.ceilingHeight, spec) }))
        .sort((a, b) => a.t0 - b.t0);
      pieces.push(...splitAtVoid(f, w0, ops0));
    }
    for (const { w, ops } of pieces) {
      const accentHere =
        !!ext.accent &&
        ((ext.accentRule === 'upper' && f.level >= 2) ||
          (ext.accentRule === 'lower' && f.level === 1) ||
          (ext.accentRule === 'entrance' && w.exterior && isEntranceColumn(w, entranceRanges)));
      buildWall(mb, f, w, ops, fl, top, accentHere ? 'ext.accent' : 'ext.wall', isTop, spec);
      for (const o of ops) buildOpening(mb, f, w, o, fl, meta, spec);
    }
    // 吹抜の縁（壁の無い所）の落下防止
    buildVoidGuardsOnOpenEdges(mb, f, fl, spec);
    // 斜めの壁の継ぎ目（外側の角のくさび状の隙間）を丸柱で埋める
    for (const j of diagonalJoints(f.walls.filter((w) => !stub(w)))) {
      const w = j.w;
      const outdoorAt = (x: number, y: number) => {
        const r = roomAt(f, x, y);
        return !r || r.type === 'balcony' || r.type === 'porch';
      };
      const bothOutdoor = w.exterior && [1, -1].every((sg) => outdoorAt(j.p.x + ((w.b.y - w.a.y) / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)) * -sg * (w.thickness + 80), j.p.y + ((w.b.x - w.a.x) / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)) * sg * (w.thickness + 80)));
      const bottom = w.exterior && f.level === 1 ? (bothOutdoor ? -0.05 : fl - 0.1) : fl;
      const wallTop = w.exterior ? top : fl + f.ceilingHeight * MM;
      const key = w.exterior ? (ext.accent && ((ext.accentRule === 'upper' && f.level >= 2) || (ext.accentRule === 'lower' && f.level === 1)) ? 'ext.accent' : 'ext.wall') : 'int.wall';
      mb.cylinder(key, V(j.p.x * MM, bottom, j.p.y * MM), (j.t * MM) / 2 - 0.002, wallTop - bottom, 24, false);
    }

    // ---- 床 ----
    const voids = stairVoidsFor(model, f);
    for (const r of f.rooms) {
      if (r.type === 'void') continue;
      const key = floorKeyFor(r);
      const y = fl + (r.type === 'entrance' ? -0.0 : 0);
      emitFlat(mb, key, r.polygon, voids, y, true);
    }
    // 構造スラブ（断面表示・光漏れ防止）
    // 中庭などの穴の部分にはスラブを張らない
    const holes = f.outline.filter((l) => isHoleLoop(l, f.outline));
    const holeRects = holes.length ? polygonToRects(holes) : [];
    const lower = model.floors[model.floors.indexOf(f) - 1];
    const lowerRects = lower ? polygonToRects(lower.outline.filter((l) => !isHoleLoop(l, lower.outline))) : [];
    for (const poly of f.outline) {
      if (holes.includes(poly)) continue;
      emitSlab(mb, 'int.slab', poly, [...voids, ...holeRects], fl - 0.24, fl - 0.005, 'ext.wall'); // 外周の小口は外から見える（2階の跳ね出しの下など）ので外壁の仕上げ
      // 下階からはみ出した部分（オーバーハング・ピロティの天井）は軒天の仕上げで見せる
      if (lower) emitFlat(mb, 'ext.soffit', poly, [...voids, ...holeRects, ...lowerRects], fl - 0.25, false);
    }
    // ---- 天井 ----
    const upper = model.floors[model.floors.indexOf(f) + 1];
    const ceilVoids = upper ? stairVoidsFor(model, upper) : [];
    for (const r of f.rooms) {
      if (r.type === 'void') {
        // 吹抜の上（この階の天井の高さ）にも天井を張る。以前は張っておらず、1 階から見上げると屋根の裏（黒い板金）が見えていた。
        // 1 階の中庭（空に開いた区画）には張らない
        if (f.level >= 2) emitFlat(mb, 'int.ceiling', r.polygon, ceilVoids, fl + f.ceilingHeight * MM, false);
        continue;
      }
      if (r.type === 'balcony' || r.type === 'porch') {
        // 屋根・上階の下に入るバルコニー・ポーチの天井は軒天（木目など）。中庭は空に開く
        if (/庭|COURT/i.test(r.name)) continue;
        emitFlat(mb, 'ext.soffit', r.polygon, [], top - (upper ? 0.25 : 0.02), false);
        continue;
      }
      emitFlat(mb, 'int.ceiling', r.polygon, ceilVoids, fl + f.ceilingHeight * MM, false);
    }
    // ---- 天井の設備（ダウンライト・間接照明） ----
    buildCeilingDetails(mb, f, fl, spec);
    // ---- 階段 ----
    for (const s of f.stairs) {
      if (!s.goesUp || !upper) continue;
      buildStairs(mb, s, fl, upper.elevation * MM, f);
    }
  }

  // ---- 基礎 ----
  const f1 = model.floors[0];
  if (f1) {
    // 外形の外に立つ外壁（中庭・ポーチの囲い、外形の切り欠きに沿う壁）にも基礎を付ける。外形に沿った基礎より
    // わずかに細くし、同じ面が重ならないようにする（外形の基礎がある所では中に隠れる）
    for (const w of f1.walls) {
      if (!w.exterior) continue;
      const A = V(w.a.x * MM, 0, w.a.y * MM);
      const B = V(w.b.x * MM, 0, w.b.y * MM);
      const L = A.distanceTo(B);
      if (L < 0.05) continue;
      const dir = new THREE.Vector3().subVectors(B, A).normalize();
      const c = A.clone().addScaledVector(dir, L / 2).setY(-0.06);
      // 壁の軸線は接合先の壁の外面まで延ばしてあるので、帯は壁と同じ長さで角が閉じる。細くした分（片側 15mm）だけ
      // 端も引っ込め、接合先の帯の面と揃える（斜めの接合は下の丸柱で埋める）
      mb.box('ext.foundation', c, dir, L - 0.03, f1.elevation * MM - 0.1 + 0.06, w.thickness * MM - 0.03);
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
        const pa = V(a.x, -0.05, a.y);
        const pb = V(b.x, -0.05, b.y);
        const ta = V(a.x, f1.elevation * MM - 0.1, a.y);
        const tb = V(b.x, f1.elevation * MM - 0.1, b.y);
        const n = new THREE.Vector3(b.y - a.y, 0, -(b.x - a.x));
        const center = new THREE.Vector3((a.x + b.x) / 2, 0, (a.y + b.y) / 2);
        const inside = pointInPolygon({ x: center.x + n.x * 0.01, y: center.z + n.z * 0.01 }, off);
        if (inside) mb.quad('ext.foundation', pa, pb, tb, ta);
        else mb.quad('ext.foundation', pb, pa, ta, tb);
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
        const pa = V(a.x, y - 0.03, a.y);
        const pb = V(b.x, y - 0.03, b.y);
        const ta = V(a.x, y + 0.005, a.y);
        const tb = V(b.x, y + 0.005, b.y);
        if (inside) mb.quad('ext.frame', pa, pb, tb, ta);
        else mb.quad('ext.frame', pb, pa, ta, tb);
      }
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

export function floorKeyFor(r: Room): string {
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

function emitSlab(mb: MeshBuilder, key: string, polyMm: { x: number; y: number }[], voidsMm: Rect[], y0: number, y1: number, edgeKey = key) {
  emitFlat(mb, key, polyMm, voidsMm, y0, false);
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


/**
 * 斜めの壁（直交しない壁同士）の継ぎ目。角が直角でないと、矩形の壁同士では外側の角にくさび状の隙間が残るので、
 * 壁の軸線の交点に壁厚の丸柱を立てて埋める。戻り値は交点と、その継ぎ目の最大壁厚（mm）。
 */
function diagonalJoints(walls: Wall[], onlyExterior = false): { p: { x: number; y: number }; t: number; w: Wall }[] {
  const out: { p: { x: number; y: number }; t: number; w: Wall }[] = [];
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
        out.push({ p, t, w });
      }
    }
  }
  return out;
}

/**
 * 吹抜の縁の鉄骨手すり（御社の標準: 黒皮鉄のフラットバー）。
 * 支柱 FB-12×50 @ ≤1.0m、笠木は丸パイプ φ32（H1100）、縦桟 FB-9×30 @110
 */
function buildVoidRail(mb: MeshBuilder, A: THREE.Vector3, B: THREE.Vector3, fl: number) {
  const L = A.distanceTo(B);
  if (L < 0.15) return;
  const dir = new THREE.Vector3().subVectors(B, A).normalize();
  const H = 1.1;
  const metal = 'f.metal';
  const nPost = Math.max(2, Math.ceil(L / 1.0) + 1);
  for (let i = 0; i < nPost; i++) {
    const s = 0.03 + ((L - 0.06) * i) / (nPost - 1);
    mb.box(metal, A.clone().addScaledVector(dir, s).setY(fl), dir, 0.012, H - 0.02, 0.05);
  }
  mb.tube(metal, A.clone().setY(fl + H), B.clone().setY(fl + H), 0.016, 0.016, 10);
  // 縦桟（細い）
  for (let s = 0.14; s < L - 0.08; s += 0.11) mb.box(metal, A.clone().addScaledVector(dir, s).setY(fl + 0.05), dir, 0.009, H - 0.09, 0.03);
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
      if (len < 300) continue;
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
      if (!other || other.type === 'void' || other.type === 'balcony' || other.type === 'porch') continue;
      const A = V(p.x * MM, 0, p.y * MM);
      const B = V(q.x * MM, 0, q.y * MM);
      const dir = new THREE.Vector3().subVectors(B, A).normalize();
      const L = A.distanceTo(B);
      const midV = A.clone().addScaledVector(dir, L / 2);
      // 縁から部屋側へ少し（6cm）寄せて、床の小口に重ねない
      const inset = new THREE.Vector3(nx, 0, ny).multiplyScalar(0.06);
      if (spec.voidGuard === 'rail') buildVoidRail(mb, A.clone().add(inset), B.clone().add(inset), fl);
      else if (spec.voidGuard === 'half') mb.box(['int.wall', 'int.wall', 'int.wallTop', 'int.wallTop', 'int.wall', 'int.wall'], midV.clone().add(inset).setY(fl), dir, L, 1.1, 0.12);
      else if (spec.voidGuard === 'halfGlass') {
        mb.box(['int.wall', 'int.wall', 'int.wallTop', 'int.wallTop', 'int.wall', 'int.wall'], midV.clone().add(inset).setY(fl), dir, L, 0.9, 0.12);
        voidGlassOnTop(mb, A.clone().add(inset), B.clone().add(inset), fl + 0.9);
      } else mb.box(['int.wall', 'int.wall', 'int.wallTop', 'int.wallTop', 'int.wall', 'int.wall'], midV.clone().add(inset).setY(fl), dir, L, f.ceilingHeight * MM, 0.12);
    }
  }
}

/** 壁を開口部で分割して生成 */
/**
 * 1 本の壁のうち「吹抜とホール・LDK の境」になっている区間を切り出す（その区間は手すり・腰壁になる）。
 * 堀様邸の 2 階: 吹抜の下辺からホールと中庭の境まで 1 本の外壁として読めていたため、吹抜の縁まで外壁（天井までの壁）になっていた
 */
function splitAtVoid(f: Floor, w: Wall, ops: Opening[]): { w: Wall; ops: Opening[] }[] {
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
    ops: ops.filter((o) => o.t0 >= a - 1 && o.t1 <= b + 1).map((o) => ({ ...o, t0: o.t0 - a, t1: o.t1 - a })),
  });
  const out: { w: Wall; ops: Opening[] }[] = [];
  if (t0 > 50) out.push(sub(0, t0, false));
  out.push(sub(t0, t1, true));
  if (t1 < L - 50) out.push(sub(t1, L, false));
  return out;
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
  const isOutdoor = (r: Room | null) => !!r && (r.type === 'balcony' || r.type === 'porch');
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
  const guard: BuilderSpec['voidGuard'] = voidEdge ? spec.voidGuard : 'wall';
  if (guard === 'rail') {
    buildVoidRail(mb, A, B, fl);
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
    if (r && (r.type === 'ldk' || r.type === 'living') && !w.exterior && ops.length === 0 && L > 2.2) return 'int.accent';
    return 'int.wall';
  };
  const kPlus = sideKey(1);
  const kMinus = sideKey(-1);
  // 1階の外壁は基礎天端まで下げる。両側とも屋外の塀状の壁（中庭・ポーチの囲い）は外形の外で基礎が無いので地面まで
  const bothOutdoor = (!rPlus || isOutdoor(rPlus)) && (!rMinus || isOutdoor(rMinus));
  const bottom = w.exterior && f.level === 1 ? (bothOutdoor ? -0.05 : fl - 0.1) : fl;
  const wallTop = parapet ? Math.min(top, fl + 1.1) : guard === 'half' ? fl + 1.1 : guard === 'halfGlass' ? fl + 0.9 : w.exterior || facesOutdoor ? top : fl + f.ceilingHeight * MM;
  const topKey = w.exterior || facesOutdoor ? 'ext.wallTop' : 'int.wallTop';
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
  const firstCap = w.joinedA ? null : jambKey;
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    const s0 = Math.max(0, o.t0 * MM);
    const s1 = Math.min(L, o.t1 * MM);
    seg(cursor, s0, bottom, wallTop, cursor === 0 ? firstCap : jambKey, jambKey);
    const sill = fl + o.sill * MM;
    const head = Math.min(wallTop, fl + (o.sill + o.height) * MM);
    if (o.sill > 0) seg(s0, s1, bottom, sill, null, null);
    if (head < wallTop - 0.005) seg(s0, s1, head, wallTop, null, null);
    cursor = s1;
  }
  seg(cursor, L, bottom, wallTop, ops.length === 0 ? firstCap : jambKey, w.joinedB ? null : jambKey);
}

function buildOpening(mb: MeshBuilder, f: Floor, w: Wall, o: Opening, fl: number, meta: BuildingMeta, spec: BuilderSpec) {
  const A = V(w.a.x * MM, 0, w.a.y * MM);
  const B = V(w.b.x * MM, 0, w.b.y * MM);
  const dir = new THREE.Vector3().subVectors(B, A).normalize();
  const nW = new THREE.Vector3(-dir.z, 0, dir.x); // 平面の n と一致
  const t = w.thickness * MM;
  const s0 = o.t0 * MM;
  const s1 = o.t1 * MM;
  const width = s1 - s0;
  const mid = A.clone().addScaledVector(dir, (s0 + s1) / 2);
  const sill = fl + o.sill * MM;
  const head = fl + (o.sill + o.height) * MM;
  const H = head - sill;
  let outSign = w.exterior ? (w.outsideSign ?? 1) : 1;
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
    // サッシ枠は外壁寄り（半外付け）
    const plane = mid.clone().addScaledVector(outN, t / 2 - 0.05);
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
    if (flat) cells.push({ w: innerW, vent: 'top' });
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
        meta.sashes.push(sash);
      }
      u += cell.w;
    });
    // 外部の水切り
    mb.box(frame, mid.clone().addScaledVector(outN, t / 2 + 0.01).setY(sill - 0.02), dir, width + 0.04, 0.02, 0.05);
    // 室内の窓台
    if (o.sill > 0 && spec.windows.sillBoard) mb.box('int.trim', mid.clone().addScaledVector(outN, -t / 2 + 0.01).setY(sill - 0.02), dir, width + 0.06, 0.02, 0.06);
    // カーテン（居室の掃き出し・腰窓）
    const inRoom = roomAt(f, (mid.x - outN.x * (t / 2 + 0.2)) / MM, (mid.z - outN.z * (t / 2 + 0.2)) / MM);
    if (spec.curtains !== 'none' && inRoom && ['ldk', 'living', 'dining', 'bedroom', 'kids', 'study'].includes(inRoom.type) && width > 0.7) {
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
      // 両端にまとめたカーテン
      for (const side of [-1, 1]) {
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

  if (o.kind === 'entrance') {
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
    // 縦長の取っ手（戸先側・外側）と採光スリット（ヒンジ側）
    dmb.box('f.metal', V(dw - 0.12, sill + 0.75, zOut * 0.05), V(1, 0, 0), 0.02, 0.8, 0.02);
    dmb.box('ext.glassFrosted', V(0.12, sill + 0.3, zOut * 0.024), V(1, 0, 0), 0.08, H - 0.6, 0.004);
    const inward = outN.clone().negate();
    meta.doors.push({
      id: o.id,
      kind: 'swing',
      level: f.level,
      origin: hinge,
      yaw0: Math.atan2(-closedDir.z, closedDir.x),
      openAngle: Math.atan2(closedDir.z * inward.x - closedDir.x * inward.z, closedDir.dot(inward)),
      slideDir: new THREE.Vector3(),
      slideDist: 0,
      staticOpen: 0,
      mb: dmb,
      width: dw,
    });
    // ポーチと庇
    const porchW = Math.max(1.6, width + 0.8);
    const porchD = 1.3;
    const pc = mid.clone().addScaledVector(outN, t / 2 + porchD / 2);
    mb.box('l.porch', pc.clone().setY(0), dir, porchW, fl - 0.02, porchD);
    const step = mid.clone().addScaledVector(outN, t / 2 + porchD + 0.2);
    mb.box('l.porch', step.clone().setY(0), dir, porchW, (fl - 0.02) / 2, 0.4);
    const canopy = mid.clone().addScaledVector(outN, t / 2 + 0.5);
    mb.box('ext.canopy', canopy.setY(head + 0.25), dir, porchW, 0.06, 1.0);
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
      staticOpen: ang > 0 ? ang / 1.396 : 0,
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
    for (const sd of [1, -1])
      for (const fc of [1, -1]) {
        const dist = Math.min(width * 0.92, avail(sd));
        if (dist < 0.3 || !insideAt(sd, fc, dist * 0.5) || !insideAt(sd, fc, dist)) continue;
        if (!pick || dist > pick.dist) pick = { sd, fc, dist };
      }
    const fc = pick?.fc ?? 1;
    const face = mid.clone().addScaledVector(nW, fc * (t / 2 + 0.025));
    const slideDir = dir.clone().multiplyScalar(pick?.sd ?? 1);
    const slideDist = pick?.dist ?? 0;
    const staticOpen = pick && slideDist >= width * 0.4 ? 0.6 : 0;
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
      staticOpen,
      mb: dmb,
      width: lw,
    });
    const cs = face.clone().addScaledVector(slideDir, slideDist * staticOpen).setY(fl);
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

/** 天井のダウンライト・間接照明 */
function buildCeilingDetails(mb: MeshBuilder, f: Floor, fl: number, spec: BuilderSpec) {
  const ceil = fl + f.ceilingHeight * MM;
  for (const r of f.rooms) {
    if (['closet', 'storage', 'void', 'balcony', 'porch', 'stairs'].includes(r.type)) continue;
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
    } else if (!['bath', 'toilet'].includes(r.type)) {
      mb.cylinder('f.lampShade', V((x0 + x1) / 2, ceil - 0.08, (z0 + z1) / 2), 0.28, 0.08, 28);
    }
    // 間接照明: LDK・リビング・寝室の長い壁の天井際（窓のない壁）
    if (spec.indirectLighting && ['ldk', 'living', 'bedroom'].includes(r.type)) {
      let best: { a: THREE.Vector3; b: THREE.Vector3; len: number } | null = null;
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
        if (!best || len > best.len) best = { a: V(p.x * MM, 0, p.y * MM), b: V(q.x * MM, 0, q.y * MM), len };
      }
      if (best) {
        const d = best.b.clone().sub(best.a).normalize();
        const n = new THREE.Vector3(-d.z, 0, d.x);
        const mid = best.a.clone().add(best.b).multiplyScalar(0.5);
        // 室内側へ
        const inside = pointInPolygon({ x: (mid.x + n.x * 0.3) / MM, y: (mid.z + n.z * 0.3) / MM }, r.polygon) ? 1 : -1;
        const c = mid.clone().addScaledVector(n, inside * 0.16);
        mb.box('int.shadowGap', c.clone().setY(ceil - 0.005), d, best.len - 0.3, 0.005, 0.14);
        mb.box('f.cove', c.clone().addScaledVector(n, -inside * 0.03).setY(ceil - 0.012), d, best.len - 0.4, 0.006, 0.03);
      }
    }
  }
}

/** 階段（直・折り返し） */
function buildStairs(mb: MeshBuilder, s: Stair, y0: number, y1: number, f?: Floor) {
  const rise = y1 - y0;
  const n = stairStepCount(rise / MM, s);
  const rh = rise / n;
  const tread = 'int.stairs';
  // 蹴込みの無い「ストリップ階段」: 厚さ 40mm の踏板を、両端の細いスチールの受け材で支える（重い箱の積み重ねに見せない）
  const put = (p: { minX: number; minY: number; maxX: number; maxY: number }, yTop: number) => {
    const min = V(p.minX * MM, yTop - 0.04, p.minY * MM);
    const max = V(p.maxX * MM, yTop, p.maxY * MM);
    if (max.x - min.x < 0.01 || max.z - min.z < 0.01) return;
    mb.aabb(tread, min, max);
    // 受け材（踏板の長手方向の両端＝階段の両脇の下に薄い板）
    const longX = max.x - min.x >= max.z - min.z;
    const plateT = 0.012;
    const ph = Math.min(0.08, rh * 0.5);
    if (longX) {
      for (const x of [min.x + 0.03, max.x - 0.03 - plateT]) mb.aabb('ext.frame', V(x, yTop - 0.04 - ph, min.z + 0.02), V(x + plateT, yTop - 0.04, max.z - 0.02));
    } else {
      for (const z of [min.z + 0.03, max.z - 0.03 - plateT]) mb.aabb('ext.frame', V(min.x + 0.02, yTop - 0.04 - ph, z), V(max.x - 0.02, yTop - 0.04, z + plateT));
    }
  };
  const lay = stairLayout(s, n);
  for (const p of lay.pieces) put(p, y0 + rh * p.i);
  // 折り返し階段の中央の腰壁
  if (lay.wall) mb.aabb('int.wall', V(lay.wall.minX * MM, y0, lay.wall.minY * MM), V(lay.wall.maxX * MM, y0 + rise * 0.5 + 0.9, lay.wall.maxY * MM));
  steelStairDetails(mb, lay, rh, y0, f);
}

/**
 * 鉄骨階段の表現: 直線の区間ごとに中央のささら桁（黒皮鉄の鋼板）を勾配なりに通し、
 * 壁の無い側にフラットバーの支柱と丸パイプの手すりを付ける（ホームランディックの標準）。
 */
function steelStairDetails(mb: MeshBuilder, lay: ReturnType<typeof stairLayout>, rh: number, y0: number, f?: Floor) {
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
  const metal = 'f.metal';
  for (const run of runs.filter((r) => r.length >= 2)) {
    const a = run[0];
    const b = run[run.length - 1];
    const d = V(a.dir.x, 0, a.dir.y).normalize();
    const perp = V(-d.z, 0, d.x);
    const ca = center(a).setY(y0 + rh * a.i - 0.04);
    const cb = center(b).setY(y0 + rh * b.i - 0.04);
    const treadD = Math.abs(V(b.maxX - b.minX, 0, b.maxY - b.minY).dot(d)) * MM;
    const treadW = Math.abs(V(b.maxX - b.minX, 0, b.maxY - b.minY).dot(perp)) * MM;
    // ささら桁: 踏板の下 12cm を中心に、区間の両端へ踏板 1 枚分延ばした鋼板（t12 × 200）
    const x = cb.clone().sub(ca);
    const len = x.length() + treadD;
    x.normalize();
    const z = perp.clone();
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    const geo = new THREE.BoxGeometry(len, 0.2, 0.012);
    const m = new THREE.Matrix4().makeBasis(x, y, z);
    m.setPosition(ca.clone().add(cb).multiplyScalar(0.5).addScaledVector(y, -0.12));
    mb.addGeometry(metal, geo, m);
    geo.dispose();
    // 手すり: 壁の無い側（踏板の脇 30cm が階段以外の部屋）にだけ
    for (const sg of [1, -1]) {
      let open = false;
      if (f) {
        const mid = center(run[Math.floor(run.length / 2)]);
        const q = mid.clone().addScaledVector(perp, sg * (treadW / 2 + 0.3));
        const r = roomAt(f, q.x / MM, q.z / MM);
        open = !!r && r.type !== 'stairs' && r.type !== 'closet' && r.type !== 'storage';
      }
      if (!open) continue;
      const posts: THREE.Vector3[] = [];
      run.forEach((p, k) => {
        if (k % 2 && k !== run.length - 1) return;
        const c = center(p).setY(y0 + rh * p.i);
        const base = c.addScaledVector(perp, sg * (treadW / 2 - 0.05));
        // 支柱: フラットバー 12×40、踏板の上 900
        mb.box(metal, base.clone(), d, 0.04, 0.9, 0.012);
        posts.push(base.clone().setY(base.y + 0.9));
      });
      // 丸パイプ φ32 の手すり（支柱の天端を結ぶ）
      for (let k = 0; k + 1 < posts.length; k++) mb.tube(metal, posts[k], posts[k + 1], 0.016, 0.016, 10);
    }
  }
}
