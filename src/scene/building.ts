/**
 * 建物モデル → 3D ジオメトリ
 * 単位: m。平面 (x, y[下向き]) → ワールド (X = x, Z = y)、Y が上。
 */
import * as THREE from 'three';
import type { BuildingModel, Floor, Opening, Room, Stair, Wall } from '../core/types';
import { pointInPolygon, isHoleLoop } from '../core/geometry';
import { isRectilinear, polygonToRects, rectsMinus, offsetPolygon, type Rect } from '../core/rects';
import { MeshBuilder, V } from './meshBuilder';
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

export function buildBuilding(model: BuildingModel, opts: BuildOptions): { mb: MeshBuilder; meta: BuildingMeta } {
  const mb = new MeshBuilder();
  const meta: BuildingMeta = { bbox: new THREE.Box3(), rooms: [], wallTop: [], outlines: [], topY: 0, doorLeaves: [], doors: [] };
  const ext = opts.exterior;
  const spec = opts.spec ?? BUILDER_SPECS[0];
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
    for (const w of f.walls) {
      if (stub(w)) continue;
      // 仕様に合わせて開口の高さを調整（フルハイトドア・サッシ上端＝天井）
      const ops = f.openings
        .filter((o) => o.wallId === w.id)
        .map((o) => ({ ...o, ...effectiveOpening(o, f.ceilingHeight, spec) }))
        .sort((a, b) => a.t0 - b.t0);
      const accentHere =
        !!ext.accent &&
        ((ext.accentRule === 'upper' && f.level >= 2) ||
          (ext.accentRule === 'lower' && f.level === 1) ||
          (ext.accentRule === 'entrance' && w.exterior && isEntranceColumn(w, entranceRanges)));
      buildWall(mb, f, w, ops, fl, top, accentHere ? 'ext.accent' : 'ext.wall', isTop, spec);
      for (const o of ops) buildOpening(mb, f, w, o, fl, meta, spec);
    }
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
      emitSlab(mb, 'int.slab', poly, [...voids, ...holeRects], fl - 0.24, fl - 0.005);
      // 下階からはみ出した部分（オーバーハング・ピロティの天井）は軒天の仕上げで見せる
      if (lower) emitFlat(mb, 'ext.soffit', poly, [...voids, ...holeRects, ...lowerRects], fl - 0.25, false);
    }
    // ---- 天井 ----
    const upper = model.floors[model.floors.indexOf(f) + 1];
    const ceilVoids = upper ? stairVoidsFor(model, upper) : [];
    for (const r of f.rooms) {
      if (r.type === 'void') continue;
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
      buildStairs(mb, s, fl, upper.elevation * MM);
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
    const pts = polyMm.map((p) => V(p.x * MM, y, p.y * MM));
    mb.polygon(key, pts, n, uA, vA);
  }
}

function emitSlab(mb: MeshBuilder, key: string, polyMm: { x: number; y: number }[], voidsMm: Rect[], y0: number, y1: number) {
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
    if (inside) mb.quad(key, pa, pb, tb, ta);
    else mb.quad(key, pb, pa, ta, tb);
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

/** 壁を開口部で分割して生成 */
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
  const wallTop = parapet ? Math.min(top, fl + 1.1) : w.exterior || facesOutdoor ? top : fl + f.ceilingHeight * MM;
  const topKey = w.exterior || facesOutdoor ? 'ext.wallTop' : 'int.wallTop';
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
    const panes = width > 1.0 && o.windowStyle !== 'high' ? 2 : 1;
    const innerW = width - fw * 2;
    const innerH = H - fw * 2;
    for (let i = 0; i < panes; i++) {
      const pw = panes === 2 ? innerW / 2 + 0.02 : innerW;
      const off = panes === 2 ? (i === 0 ? -innerW / 4 + 0.01 : innerW / 4 - 0.01) : 0;
      const depthOff = panes === 2 ? (i === 0 ? 0.015 : -0.015) : 0;
      const c = plane.clone().addScaledVector(dir, off).addScaledVector(outN, depthOff).setY(sill + fw);
      // 障子の框
      const sw = 0.03;
      mb.box(frame, c.clone(), dir, pw, sw, 0.028);
      mb.box(frame, c.clone().setY(sill + fw + innerH - sw), dir, pw, sw, 0.028);
      mb.box(frame, c.clone().addScaledVector(dir, -pw / 2 + sw / 2), dir, sw, innerH, 0.028);
      mb.box(frame, c.clone().addScaledVector(dir, pw / 2 - sw / 2), dir, sw, innerH, 0.028);
      // ガラス（両面）
      const g0 = c.clone().addScaledVector(dir, -pw / 2 + sw).setY(sill + fw + sw);
      const g1 = c.clone().addScaledVector(dir, pw / 2 - sw).setY(sill + fw + sw);
      const g2 = g1.clone().setY(sill + fw + innerH - sw);
      const g3 = g0.clone().setY(sill + fw + innerH - sw);
      mb.quad(glassKey, g0, g1, g2, g3);
      mb.quad(glassKey, g1, g0, g3, g2);
    }
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
        // 両脇にまとめたドレープ（ひだを丸い縦の束で表現）
        for (const side of [-1, 1]) {
          const folds = 6;
          const outside = fitsAt(side * (width / 2 + 0.03 + (folds - 1) * 0.058 + 0.04));
          for (let k = 0; k < folds; k++) {
            const u = outside ? side * (width / 2 + 0.03 + k * 0.058) : side * (width / 2 - 0.04 - k * 0.058);
            const c = inner.clone().addScaledVector(dir, u).addScaledVector(outN, k % 2 ? 0.018 : -0.018);
            mb.roundedBox('f.curtain', c.setY(fl + 0.012), dir, 0.07, ceil - fl - 0.02, 0.055, 0.026, 2);
          }
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
    dmb.box('int.door', V(lw / 2, fl + 0.008, 0), V(1, 0, 0), lw, H - 0.008 - topGap, doorT);
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
    dmb.box('int.door', V(0, fl + 0.008, 0), V(1, 0, 0), lw, H - 0.008 - topGap, doorT * 0.9);
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
      // 壁から 0.7m 以上離し、約 1.8m 間隔で均等配置
      const nx = Math.max(1, Math.round((x1 - x0 - 1.4) / 1.8) + 1);
      const nz = Math.max(1, Math.round((z1 - z0 - 1.4) / 1.8) + 1);
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < nz; j++) {
          const x = nx === 1 ? (x0 + x1) / 2 : x0 + 0.7 + ((x1 - x0 - 1.4) * i) / (nx - 1);
          const z = nz === 1 ? (z0 + z1) / 2 : z0 + 0.7 + ((z1 - z0 - 1.4) * j) / (nz - 1);
          if (!pointInPolygon({ x: x / MM, y: z / MM }, r.polygon)) continue;
          mb.cylinder('f.downlightRing', V(x, ceil - 0.004, z), 0.055, 0.003, 20);
          mb.cylinder('f.downlight', V(x, ceil - 0.006, z), 0.042, 0.003, 20);
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
function buildStairs(mb: MeshBuilder, s: Stair, y0: number, y1: number) {
  const rise = y1 - y0;
  const n = stairStepCount(rise / MM);
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
}
