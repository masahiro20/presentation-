/**
 * 建物モデル → 3D ジオメトリ
 * 単位: m。平面 (x, y[下向き]) → ワールド (X = x, Z = y)、Y が上。
 */
import * as THREE from 'three';
import type { BuildingModel, Floor, Opening, Room, Stair, Wall } from '../core/types';
import { pointInPolygon, isHoleLoop } from '../core/geometry';
import { isRectilinear, polygonToRects, rectsMinus, offsetPolygon, type Rect } from '../core/rects';
import { MeshBuilder, V } from './meshBuilder';
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
  entrance?: { pos: THREE.Vector3; outward: THREE.Vector3; width: number };
  wallTop: number[];
  /** 開いた扉の位置（カメラの干渉判定用） */
  doorLeaves: { a: THREE.Vector3; b: THREE.Vector3 }[];
  /** 各階の外形（ワールド） */
  outlines: { level: number; y: number; polys: THREE.Vector2[][] }[];
  topY: number;
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
  const meta: BuildingMeta = { bbox: new THREE.Box3(), rooms: [], wallTop: [], outlines: [], topY: 0, doorLeaves: [] };
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
    for (const w of f.walls) {
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
    for (const poly of f.outline) {
      if (holes.includes(poly)) continue;
      emitSlab(mb, 'int.slab', poly, [...voids, ...holeRects], fl - 0.24, fl - 0.005);
    }
    // ---- 天井 ----
    const upper = model.floors[model.floors.indexOf(f) + 1];
    const ceilVoids = upper ? stairVoidsFor(model, upper) : [];
    for (const r of f.rooms) {
      if (['balcony', 'porch', 'void'].includes(r.type)) continue;
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

  // 各面の素材
  const sideKey = (sign: 1 | -1): string => {
    if (w.exterior && w.outsideSign === sign) return extKey;
    // 室内側: 部屋の種類で変える
    const mid = { x: (w.a.x + w.b.x) / 2 + nPlan.x * sign * (w.thickness / 2 + 80), y: (w.a.y + w.b.y) / 2 + nPlan.y * sign * (w.thickness / 2 + 80) };
    const r = roomAt(f, mid.x, mid.y);
    if (r?.type === 'bath') return 'int.bathWall';
    if (r && (r.type === 'ldk' || r.type === 'living') && !w.exterior && ops.length === 0 && L > 2.2) return 'int.accent';
    return 'int.wall';
  };
  const kPlus = sideKey(1);
  const kMinus = sideKey(-1);
  const bottom = w.exterior && f.level === 1 ? fl - 0.1 : fl;
  const wallTop = w.exterior ? top : fl + f.ceilingHeight * MM;
  const topKey = w.exterior ? 'ext.wallTop' : 'int.wallTop';
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
  const outSign = w.exterior ? (w.outsideSign ?? 1) : 1;
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
    const frosted = o.windowStyle === 'small' || o.windowStyle === 'high';
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
      if (spec.curtains === 'pocket') {
        // 天井埋込のカーテンボックス: 天井から床まで落ちる薄手のドレープ（レールは見せない）
        const pocket = inner.clone().setY(ceil - 0.004);
        mb.box('int.shadowGap', pocket, dir, width + 0.7, 0.004, 0.16);
        // 両脇にまとめたドレープ（ひだを丸い縦の束で表現）
        for (const side of [-1, 1]) {
          const folds = 6;
          for (let k = 0; k < folds; k++) {
            const u = side * (width / 2 + 0.03 + k * 0.058);
            const c = inner.clone().addScaledVector(dir, u).addScaledVector(outN, k % 2 ? 0.018 : -0.018);
            mb.roundedBox('f.curtain', c.setY(fl + 0.012), dir, 0.07, ceil - fl - 0.02, 0.055, 0.026, 2);
          }
        }
        return;
      }
      const cy = fl + Math.min(2.35, (o.sill + o.height) * MM + 0.1);
      // 両端にまとめたカーテン
      for (const side of [-1, 1]) {
        const c = inner.clone().addScaledVector(dir, side * (width / 2 + 0.05));
        mb.box('f.curtain', c.setY(fl + (o.sill > 0 ? o.sill * MM - 0.1 : 0.01)), dir, 0.28, cy - (fl + (o.sill > 0 ? o.sill * MM - 0.1 : 0.01)), 0.1);
      }
      mb.box('f.metal', inner.clone().setY(cy), dir, width + 0.5, 0.025, 0.025);
    }
    return;
  }

  if (o.kind === 'entrance') {
    const plane = mid.clone().addScaledVector(outN, t / 2 - 0.06);
    const fw = 0.05;
    mb.box('ext.frame', plane.clone().setY(head - fw), dir, width, fw, 0.08);
    mb.box('ext.frame', plane.clone().addScaledVector(dir, -width / 2 + fw / 2).setY(sill), dir, fw, H, 0.08);
    mb.box('ext.frame', plane.clone().addScaledVector(dir, width / 2 - fw / 2).setY(sill), dir, fw, H, 0.08);
    // 扉（閉）
    const dw = width - fw * 2;
    mb.box('ext.door', plane.clone().setY(sill), dir, dw, H - fw, 0.045);
    // 縦長の取っ手
    const hx = plane.clone().addScaledVector(dir, dw / 2 - 0.12).addScaledVector(outN, 0.05).setY(sill + 0.75);
    mb.box('f.metal', hx, dir, 0.02, 0.8, 0.02);
    // 採光スリット
    const sl = plane.clone().addScaledVector(dir, -dw / 2 + 0.12).addScaledVector(outN, 0.024).setY(sill + 0.3);
    mb.box('ext.glassFrosted', sl, dir, 0.08, H - 0.6, 0.004);
    // ポーチと庇
    const porchW = Math.max(1.6, width + 0.8);
    const porchD = 1.3;
    const pc = mid.clone().addScaledVector(outN, t / 2 + porchD / 2);
    mb.box('l.porch', pc.clone().setY(0), dir, porchW, fl - 0.02, porchD);
    const step = mid.clone().addScaledVector(outN, t / 2 + porchD + 0.2);
    mb.box('l.porch', step.clone().setY(0), dir, porchW, (fl - 0.02) / 2, 0.4);
    const canopy = mid.clone().addScaledVector(outN, t / 2 + 0.5);
    mb.box('ext.canopy', canopy.setY(head + 0.25), dir, porchW, 0.06, 1.0);
    meta.entrance = { pos: mid.clone().setY(fl), outward: outN.clone(), width };
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
  const handle = (base: THREE.Vector3, along: THREE.Vector3, nrm: THREE.Vector3) => {
    if (spec.doors.handle === 'slim-lever') {
      // 細身のレバーハンドル（両面）
      for (const sgn of [1, -1]) {
        const p = base.clone().addScaledVector(nrm, sgn * (doorT / 2 + 0.028));
        mb.box('f.handle', p.clone().addScaledVector(along, 0.055), along, 0.13, 0.012, 0.012);
        mb.box('f.handle', p.clone().addScaledVector(nrm, -sgn * 0.014).addScaledVector(along, 0), along, 0.012, 0.012, 0.028);
      }
    } else {
      mb.box('f.metal', base.clone().addScaledVector(nrm, doorT / 2 + 0.02), along, 0.12, 0.02, 0.02);
      mb.box('f.metal', base.clone().addScaledVector(nrm, -doorT / 2 - 0.02), along, 0.12, 0.02, 0.02);
    }
  };
  if (o.kind === 'door') {
    const hingeS = o.hingeAtStart !== false ? s0 : s1;
    const towards = o.hingeAtStart !== false ? 1 : -1; // ヒンジから戸先方向
    const side = (o.swingSide ?? 1) as number;
    const hinge = A.clone().addScaledVector(dir, hingeS).addScaledVector(nW, side * (t / 2));
    // 80度開いた扉
    const ang = (80 * Math.PI) / 180;
    const leafDir = dir.clone().multiplyScalar(towards * Math.cos(ang)).addScaledVector(nW, side * Math.sin(ang)).normalize();
    const lw = width - 0.008;
    const c = hinge.clone().addScaledVector(leafDir, lw / 2).setY(fl + 0.008);
    mb.box('int.door', c, leafDir, lw, H - 0.008 - topGap, doorT);
    meta.doorLeaves.push({ a: hinge.clone().setY(fl), b: hinge.clone().addScaledVector(leafDir, lw).setY(fl) });
    const knob = hinge.clone().addScaledVector(leafDir, lw - 0.075).setY(fl + 1.0);
    const nLeaf = new THREE.Vector3(-leafDir.z, 0, leafDir.x);
    handle(knob, leafDir.clone().negate(), nLeaf);
  } else if (o.kind === 'sliding') {
    // 半分開いた引戸（壁面に沿って）。フルハイトは上レールを天井に埋め込み見せない
    const face = mid.clone().addScaledVector(nW, t / 2 + 0.025);
    const lw = width * 0.55;
    const c = face.clone().addScaledVector(dir, -width / 2 + lw / 2 - width * 0.35).setY(fl + 0.008);
    mb.box('int.door', c, dir, lw, H - 0.008 - topGap, doorT * 0.9);
    meta.doorLeaves.push({ a: c.clone().addScaledVector(dir, -lw / 2), b: c.clone().addScaledVector(dir, lw / 2) });
    if (!spec.doors.fullHeight) mb.box(trim, face.clone().setY(head + cw), dir, width * 2, 0.04, 0.03);
    // 引手（細い縦長の彫り込みを暗い線で表現）
    mb.box('f.handle', c.clone().addScaledVector(dir, lw / 2 - 0.05).addScaledVector(nW, doorT * 0.45 + 0.001).setY(fl + 0.85), dir, 0.012, 0.35, 0.002);
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
  const n = Math.max(10, Math.round(rise / 0.2));
  const rh = rise / n;
  const r = { minX: s.minX * MM, maxX: s.maxX * MM, minZ: s.minY * MM, maxZ: s.maxY * MM };
  const w = r.maxX - r.minX;
  const d = r.maxZ - r.minZ;
  // 昇り方向（入口から奥へ）
  const entry = s.entry;
  const runAlongZ = entry === 'n' || entry === 's';
  const tread = 'int.stairs';
  const riser = 'int.stairs';
  const put = (x0: number, z0: number, x1: number, z1: number, yTop: number) => {
    const min = V(Math.min(x0, x1), yTop - rh * 0.9 - 0.04, Math.min(z0, z1));
    const max = V(Math.max(x0, x1), yTop, Math.max(z0, z1));
    // 踏板
    mb.aabb(tread, V(min.x, yTop - 0.035, min.z), max);
    // 蹴込み
    mb.aabb(riser, min, V(max.x, yTop - 0.035, max.z));
  };
  if (s.kind === 'straight') {
    const len = runAlongZ ? d : w;
    const step = len / n;
    for (let i = 0; i < n; i++) {
      const yTop = y0 + rh * (i + 1);
      if (runAlongZ) {
        const zs = entry === 's' ? r.maxZ - step * i : r.minZ + step * i;
        const ze = entry === 's' ? zs - step : zs + step;
        put(r.minX, zs, r.maxX, ze, yTop);
      } else {
        const xs = entry === 'e' ? r.maxX - step * i : r.minX + step * i;
        const xe = entry === 'e' ? xs - step : xs + step;
        put(xs, r.minZ, xe, r.maxZ, yTop);
      }
    }
    return;
  }
  // 折り返し階段: 入口辺に平行な方向で左右2列に分け、奥で踊り場
  const n1 = Math.floor(n / 2);
  const n2 = n - n1 - 1; // 踊り場で1段分
  if (runAlongZ) {
    const half = w / 2;
    const land = Math.min(d * 0.4, half);
    const runLen = d - land;
    const st1 = runLen / n1;
    const st2 = runLen / n2;
    const fromS = entry === 's';
    const zStart = fromS ? r.maxZ : r.minZ;
    const sgn = fromS ? -1 : 1;
    for (let i = 0; i < n1; i++) {
      const z0 = zStart + sgn * st1 * i;
      put(r.minX, z0, r.minX + half, z0 + sgn * st1, y0 + rh * (i + 1));
    }
    // 踊り場
    const zl = zStart + sgn * runLen;
    const yl = y0 + rh * (n1 + 1);
    put(r.minX, zl, r.maxX, zl + sgn * land, yl);
    for (let i = 0; i < n2; i++) {
      const z0 = zl - sgn * st2 * i;
      put(r.minX + half, z0, r.maxX, z0 - sgn * st2, yl + rh * (i + 1));
    }
    // 中央の腰壁
    mb.aabb('int.wall', V(r.minX + half - 0.05, y0, Math.min(zStart, zl)), V(r.minX + half + 0.05, y0 + rise * 0.5 + 0.9, Math.max(zStart, zl)));
  } else {
    const half = d / 2;
    const land = Math.min(w * 0.4, half);
    const runLen = w - land;
    const st1 = runLen / n1;
    const st2 = runLen / n2;
    const fromE = entry === 'e';
    const xStart = fromE ? r.maxX : r.minX;
    const sgn = fromE ? -1 : 1;
    for (let i = 0; i < n1; i++) {
      const x0 = xStart + sgn * st1 * i;
      put(x0, r.minZ, x0 + sgn * st1, r.minZ + half, y0 + rh * (i + 1));
    }
    const xl = xStart + sgn * runLen;
    const yl = y0 + rh * (n1 + 1);
    put(xl, r.minZ, xl + sgn * land, r.maxZ, yl);
    for (let i = 0; i < n2; i++) {
      const x0 = xl - sgn * st2 * i;
      put(x0, r.minZ + half, x0 - sgn * st2, r.maxZ, yl + rh * (i + 1));
    }
    mb.aabb('int.wall', V(Math.min(xStart, xl), y0, r.minZ + half - 0.05), V(Math.max(xStart, xl), y0 + rise * 0.5 + 0.9, r.minZ + half + 0.05));
  }
}
