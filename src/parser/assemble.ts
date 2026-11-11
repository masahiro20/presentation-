/**
 * 解析結果（壁片・開口・文字）から建物モデルを組み立てる
 */
import { titleBlockKind, PAGE_KIND_LABEL } from './pageMap';
import { ensureGarageShutters } from './garageShutter';
import { ensureOpenings, relocateAutoShutters } from './ensureOpenings';
import { chooseEntrance } from './entranceChoice';
import { applyCeilingNotes, assignLdkRoles, reconcileTatami } from './tatamiCheck';
import { detectPassMarks, marksCrossing } from './passMarks';
import { absorbStairRing, carveStairRegion } from './stairRooms';
import { findBalconyRails } from './balconyRails';
import { matchStairs, overhangArea, stairIoU, wallFitRatio } from '../core/floorAlign';
import { OUTDOOR_TYPES, excludedFromFloorArea, isExteriorWorks, type BuildingModel, type Floor, type FurnitureKind, type Opening, type PlanSide, type Room, type RoomType, type Stair, type Vec2, type Wall, type WindowStyle, type GarageKind, floorOffsetByName, type VoidGuard, type FloorFinish } from '../core/types';
import { bboxGap, bboxOf, distPointSegment, pointInPolygon, polygonArea, polygonCentroid, type BBox } from '../core/geometry';
import type { PageVectors } from './pdfExtract';
import { detectWalls, heavyWidthThreshold, polylineArcs, type Arc, type DetectedOpening, type Seg, type WallDetection } from './walls';
import { rasterizeSegments, dominantAngles, detectWallsRaster, detectWallsRasterAuto, type BinaryImage } from './rasterWalls';
import { Grid, WALL, OUTSIDE, FREE, dilateMask, erodeMask, traceMask } from './raster';
import { classifyRoomName, parseAreaLabel, parseFloorTitle, parseStairMark, normalizeText, parseSashCode, parseFlOffset, parseStepCount, isOpenMark, parseSashKind } from './labels';
import { detectStairs, stairEntryFromArrow, stairSideOf, stairMarkDist, stairMarkReach, STAIR_MARK_RANGE } from './stairs';
import { inferNamelessRoom, doorSwingFor, isCirculation, mustSeparate, ROOM_KNOWLEDGE } from './roomKnowledge';
import { detectSite, translateSite, nearestSide, SIDES } from './site';
import { detectSymbols, dashedOutlines, dashedCarSymbols, symbolsToItems, detectNotes } from './symbols';
import { readContextItems } from './context';
import { northCandidates, pickNorth } from './north';
import { senseFurniture } from './furnitureSense';
import type { SymbolSignature } from './symbolDict';
import { chooseModule, moduleInfoOf, snapCoord, snapTolerance, endTolerance, snapStairs, translateModule, woodWallThickness, type ModuleFit, type ModuleMode } from './module';

export interface MmText {
  str: string;
  x: number;
  y: number;
  size: number;
  angle: number;
}

export interface PageMm {
  pageIndex: number;
  segs: Seg[];
  arcs: Arc[];
  texts: MmText[];
  fills: { polygon: Vec2[] }[];
  /** 白い塗り（壁の上に重ねて窓・ガラス部分を抜いている図面がある） */
  masks: Vec2[][];
  /** 色付きの塗り（壁・柱の塗りつぶしを含む） */
  colorFills: { poly: Vec2[]; color: string }[];
  /** スキャン図面の「太い線（壁）」の画像（mm 座標） */
  rasterMask?: BinaryImage;
}

export function pageToMm(p: PageVectors, k: number): PageMm {
  const sc = (q: Vec2) => ({ x: q.x * k, y: q.y * k });
  const segs: Seg[] = p.segments
    // 白い塗り（隠蔽用マスク）の輪郭は除外
    .filter((s) => !(s.source === 'fill' && /^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(s.color)))
    .map((s) => ({ a: sc(s.a), b: sc(s.b), width: s.width, dashed: s.dashed, source: s.source, ...(s.source === 'fill' ? { color: s.color.toLowerCase() } : {}) }));
  const curves: Arc[] = p.curves.filter((c) => !c.dashed).map((c) => ({ p0: sc(c.p0), p1: sc(c.p1), p2: sc(c.p2), p3: sc(c.p3), width: c.width }));
  return {
    pageIndex: p.pageIndex,
    segs,
    // 折れ線から円弧（開き戸の軌跡）を復元して足す。
    // 以前は「ベジェ曲線が 8 本未満の図面だけ」だったが、ARCHITREND の提案図は戸の円弧を折れ線で、植栽・車・家具の記号をベジェで描く。
    // 植栽や車のある図面（14 件中 7 件）では戸の記号が 1 つも読めず、開き戸が窓・開口になっていた（吉田大仁様邸 1st-2 の玄関ドア・田中様邸・酒井様邸・市岡様邸・伊藤様邸・有元様邸）
    arcs: [...curves, ...polylineArcs(segs.filter((s) => s.source !== 'fill'))],
    texts: p.texts.map((t) => ({ str: t.str, x: t.cx * k, y: t.cy * k, size: t.size * k, angle: t.angle })),
    fills: p.fills.map((f) => ({ polygon: f.polygon.map(sc) })),
    // 引込み戸の白抜きは L 字（6 点）・T 字（8 点）＋閉じる点なので 12 点まで
    masks: p.fills.filter((f) => /^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(f.color) && f.polygon.length >= 4 && f.polygon.length <= 12).map((f) => f.polygon.map(sc)),
    colorFills: p.fills
      .filter((f) => f.polygon.length >= 3 && !/^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(f.color) && f.color.toLowerCase() !== '#000000')
      .map((f) => ({ poly: f.polygon.map(sc), color: f.color.toLowerCase() })),
    rasterMask: p.raster ? { data: p.raster.mask, w: p.raster.w, h: p.raster.h, res: k / p.raster.scale, ox: 0, oy: 0 } : undefined,
  };
}

/**
 * 図面の傾き（図面全体が回転して配置されている PDF）を求める。
 * 長い線の角度を 90° で折り返して集計し、最も多い向きが水平・垂直からずれている分を返す（度、-45〜45）。
 */
export function dominantTilt(p: PageMm): number {
  const bins = new Float64Array(180); // 0.5° 刻み（0〜90°）
  let total = 0;
  for (const s of p.segs) {
    if (s.dashed) continue;
    const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    if (L < 300) continue;
    let a = (Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x) * 180) / Math.PI;
    a = ((a % 90) + 90) % 90;
    bins[Math.min(179, Math.floor(a * 2))] += L;
    total += L;
  }
  if (!total) return 0;
  let best = 0;
  let bestW = -1;
  for (let i = 0; i < 180; i++) {
    const w = bins[(i + 179) % 180] + bins[i] + bins[(i + 1) % 180];
    if (w > bestW) {
      bestW = w;
      best = i;
    }
  }
  // 重心
  let sw = 0;
  let sa = 0;
  for (let k = -2; k <= 2; k++) {
    const j = (best + k + 180) % 180;
    let a = (j + 0.5) / 2;
    if (best + k < 0) a -= 90;
    if (best + k >= 180) a += 90;
    sw += bins[j];
    sa += bins[j] * a;
  }
  let t = sw ? sa / sw : 0;
  if (t > 45) t -= 90;
  // 図面の大半がその向きでなければ傾きとみなさない
  return bestW / total > 0.3 ? t : 0;
}

/** 図面を角度 deg（度）だけ回転（図面の傾きを戻す） */
export function rotatePageMm(p: PageMm, deg: number): PageMm {
  const xs = p.segs.flatMap((s) => [s.a.x, s.b.x]);
  const ys = p.segs.flatMap((s) => [s.a.y, s.b.y]);
  const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
  const cy = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
  const th = (deg * Math.PI) / 180;
  const c = Math.cos(th);
  const sn = Math.sin(th);
  const R = (q: Vec2): Vec2 => ({ x: cx + (q.x - cx) * c - (q.y - cy) * sn, y: cy + (q.x - cx) * sn + (q.y - cy) * c });
  return {
    ...p,
    segs: p.segs.map((s) => ({ ...s, a: R(s.a), b: R(s.b) })),
    arcs: p.arcs.map((a) => ({ ...a, p0: R(a.p0), p1: R(a.p1), p2: R(a.p2), p3: R(a.p3) })),
    texts: p.texts.map((t) => ({ ...t, ...R({ x: t.x, y: t.y }), angle: t.angle + th })),
    fills: p.fills.map((f) => ({ polygon: f.polygon.map(R) })),
    masks: p.masks.map((m) => m.map(R)),
    colorFills: p.colorFills.map((f) => ({ ...f, poly: f.poly.map(R) })),
  };
}

/** 作業用の壁（軸・区間表現を保持） */
interface WWall {
  a: Vec2;
  b: Vec2;
  u: Vec2;
  n: Vec2;
  d: number;
  /** 軸上の区間（延長前） */
  t0: number;
  t1: number;
  o: number;
  g: number;
  openings: DetectedOpening[];
  joinedA: boolean;
  joinedB: boolean;
  /**
   * 弱い壁: 壁片は柱の塗り（壁厚の正方形）だけで、残りは帯の中の線だけを根拠にした「窓」（確信度 0.7）が 2m 超。
   * 窓と窓の間の柱と直交する壁の柱が一直線に並び、その間にベッドの縁が入ると生まれる（吉田大仁様邸 2 階の洋室 5.3 帖が 2 つに割れた）。
   * 室名の無い断片を作っているだけなら部屋に戻す（収納の前の引戸のように部屋を分けているなら残す）
   */
  weak?: boolean;
}

function makeWalls(det: WallDetection): WWall[] {
  const walls: WWall[] = [];
  // 軸ごとにまとめる（壁片と開口の両方が軸を占有する）
  interface AxisAcc {
    g: number;
    o: number;
    items: { t0: number; t1: number; d: number; op?: DetectedOpening }[];
  }
  const axes: AxisAcc[] = [];
  const findAxis = (g: number, o: number) => {
    let a = axes.find((x) => x.g === g && Math.abs(x.o - o) < 20);
    if (!a) {
      a = { g, o, items: [] };
      axes.push(a);
    }
    return a;
  };
  for (const p of det.pieces) findAxis(p.g, p.o).items.push({ t0: p.t0, t1: p.t1, d: p.d });
  for (const op of det.openings) findAxis(op.g, op.o).items.push({ t0: op.t0, t1: op.t1, d: op.d, op });
  for (const ax of axes) {
    const grp = det.groups[ax.g];
    ax.items.sort((a, b) => a.t0 - b.t0);
    const runs: { t0: number; t1: number; ops: DetectedOpening[]; dsum: number; lsum: number; maxPiece: number }[] = [];
    for (const it of ax.items) {
      const last = runs[runs.length - 1];
      const L = it.t1 - it.t0;
      if (last && it.t0 <= last.t1 + 30) {
        last.t1 = Math.max(last.t1, it.t1);
        if (it.op) last.ops.push(it.op);
        else {
          last.dsum += it.d * L;
          last.lsum += L;
          last.maxPiece = Math.max(last.maxPiece, L);
        }
      } else {
        runs.push({ t0: it.t0, t1: it.t1, ops: it.op ? [it.op] : [], dsum: it.op ? 0 : it.d * L, lsum: it.op ? 0 : L, maxPiece: it.op ? 0 : L });
      }
    }
    for (const r of runs) {
      const d = r.lsum > 0 ? r.dsum / r.lsum : r.ops[0]?.d || 120;
      const a = { x: grp.u.x * r.t0 + grp.n.x * ax.o, y: grp.u.y * r.t0 + grp.n.y * ax.o };
      const b = { x: grp.u.x * r.t1 + grp.n.x * ax.o, y: grp.u.y * r.t1 + grp.n.y * ax.o };
      const L = r.t1 - r.t0;
      const opLen = r.ops.reduce((s0, op) => s0 + (op.t1 - op.t0), 0);
      const weak = r.ops.length > 0 && L > 2000 && opLen >= L * 0.8 && r.maxPiece <= d * 1.3 && r.ops.every((op) => op.kind === 'window' && op.confidence <= 0.7);
      walls.push({ a, b, u: grp.u, n: grp.n, d, t0: r.t0, t1: r.t1, o: ax.o, g: ax.g, openings: r.ops, joinedA: false, joinedB: false, ...(weak ? { weak } : {}) });
    }
  }
  return walls;
}

/** 壁端を他の壁へ延長して接合する */
function joinWalls(walls: WWall[]) {
  const ext: { t0: number; t1: number }[] = walls.map((w) => ({ t0: w.t0, t1: w.t1 }));
  walls.forEach((w, i) => {
    for (const end of [0, 1] as const) {
      const tEnd = end === 0 ? w.t0 : w.t1;
      const dir = end === 0 ? -1 : 1;
      let best: { dt: number; corner: boolean; other: WWall } | null = null;
      for (const v of walls) {
        if (v === w || v.g === w.g) continue;
        // w の軸線と v の軸線の交点
        const den = w.u.x * v.n.x + w.u.y * v.n.y; // u_w · n_v
        if (Math.abs(den) < 0.2) continue;
        // 点 p(t) = u_w t + n_w o_w,  n_v · p = o_v
        const nwv = w.n.x * v.n.x + w.n.y * v.n.y;
        const t = (v.o - nwv * w.o) / den;
        const beyond = (t - tEnd) * dir; // 端から外向きの距離
        const reach = v.d / 2 + w.d + 60;
        if (beyond < -(v.d / 2 + 5) || beyond > reach) continue;
        // 交点が v の区間内にあるか
        const p = { x: w.u.x * t + w.n.x * w.o, y: w.u.y * t + w.n.y * w.o };
        const tv = p.x * v.u.x + p.y * v.u.y;
        const tol = w.d / 2 + 40;
        if (tv < v.t0 - tol || tv > v.t1 + tol) continue;
        const corner = tv < v.t0 + tol || tv > v.t1 - tol;
        const dt = t - tEnd;
        if (!best || Math.abs(dt) < Math.abs(best.dt)) best = { dt, corner, other: v };
      }
      if (best) {
        const add = best.corner ? best.other.d / 2 : 0;
        const newT = tEnd + best.dt + dir * add;
        if (end === 0) {
          ext[i].t0 = Math.min(w.t0, newT);
          w.joinedA = true;
        } else {
          ext[i].t1 = Math.max(w.t1, newT);
          w.joinedB = true;
        }
      }
    }
  });
  walls.forEach((w, i) => {
    w.t0 = ext[i].t0;
    w.t1 = ext[i].t1;
    w.a = { x: w.u.x * w.t0 + w.n.x * w.o, y: w.u.y * w.t0 + w.n.y * w.o };
    w.b = { x: w.u.x * w.t1 + w.n.x * w.o, y: w.u.y * w.t1 + w.n.y * w.o };
  });
}

function wallBBox(w: WWall): BBox {
  return {
    minX: Math.min(w.a.x, w.b.x) - w.d / 2,
    minY: Math.min(w.a.y, w.b.y) - w.d / 2,
    maxX: Math.max(w.a.x, w.b.x) + w.d / 2,
    maxY: Math.max(w.a.y, w.b.y) + w.d / 2,
  };
}

/** 接続関係から壁群をクラスタリングし、図面（階）ごとに分ける */
function clusterPlans(walls: WWall[], ext?: BBox, mergeGap = 600, minPart = 2500, windowSegs?: Seg[], nearTol = 40): WWall[][] {
  const parent = walls.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const unite = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const A = walls[i];
      const B = walls[j];
      if (bboxGap(wallBBox(A), wallBBox(B)) > nearTol) continue;
      const near =
        distPointSegment(A.a, B.a, B.b) <= B.d / 2 + nearTol ||
        distPointSegment(A.b, B.a, B.b) <= B.d / 2 + nearTol ||
        distPointSegment(B.a, A.a, A.b) <= A.d / 2 + nearTol ||
        distPointSegment(B.b, A.a, A.b) <= A.d / 2 + nearTol;
      if (near) unite(i, j);
    }
  }
  // 同じ直線上の壁の間に、窓（サッシ）の細い線が通っている場合はつながっている（全面ガラスの面）
  if (windowSegs) {
    for (let i = 0; i < walls.length; i++) {
      for (let j = 0; j < walls.length; j++) {
        const A = walls[i];
        const B = walls[j];
        if (i === j || find(i) === find(j)) continue;
        if (Math.abs(A.u.x * B.u.x + A.u.y * B.u.y) < 0.998) continue;
        // B の両端を A の軸座標で
        const tb0 = Math.min(B.a.x * A.u.x + B.a.y * A.u.y, B.b.x * A.u.x + B.b.y * A.u.y);
        const ob = ((B.a.x + B.b.x) / 2) * A.n.x + ((B.a.y + B.b.y) / 2) * A.n.y;
        const oa = ((A.a.x + A.b.x) / 2) * A.n.x + ((A.a.y + A.b.y) / 2) * A.n.y;
        const ta1 = Math.max(A.a.x * A.u.x + A.a.y * A.u.y, A.b.x * A.u.x + A.b.y * A.u.y);
        if (Math.abs(ob - oa) > 80) continue;
        const gap = tb0 - ta1;
        if (gap < 300 || gap > 5000) continue;
        const band = Math.max(A.d, B.d) / 2 + 40;
        let cov = 0;
        const iv: [number, number][] = [];
        for (const sg of windowSegs) {
          const oa0 = sg.a.x * A.n.x + sg.a.y * A.n.y - oa;
          const ob0 = sg.b.x * A.n.x + sg.b.y * A.n.y - oa;
          if (Math.abs(oa0) > band || Math.abs(ob0) > band) continue;
          const s0 = Math.max(ta1, Math.min(sg.a.x * A.u.x + sg.a.y * A.u.y, sg.b.x * A.u.x + sg.b.y * A.u.y));
          const s1 = Math.min(tb0, Math.max(sg.a.x * A.u.x + sg.a.y * A.u.y, sg.b.x * A.u.x + sg.b.y * A.u.y));
          if (s1 > s0) iv.push([s0, s1]);
        }
        iv.sort((p, q) => p[0] - q[0]);
        let cur: [number, number] | null = null;
        for (const v of iv) {
          if (cur && v[0] <= cur[1]) cur[1] = Math.max(cur[1], v[1]);
          else {
            if (cur) cov += cur[1] - cur[0];
            cur = [v[0], v[1]];
          }
        }
        if (cur) cov += cur[1] - cur[0];
        if (cov >= gap * 0.6) unite(i, j);
      }
    }
  }
  const comps = new Map<number, WWall[]>();
  walls.forEach((w, i) => {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(w);
  });
  const lenOf = (ws: WWall[]) => ws.reduce((s, w) => s + Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y), 0);
  let groups = [...comps.values()].filter((c) => lenOf(c) >= minPart);
  // 図面枠（ページ全体を囲む二重線）は、他の図と bbox が重なってまとめられてしまうので先に除く
  if (ext) {
    const W = ext.maxX - ext.minX;
    const H = ext.maxY - ext.minY;
    groups = groups.filter((g) => {
      const b = g.map(wallBBox).reduce((a, c) => ({ minX: Math.min(a.minX, c.minX), minY: Math.min(a.minY, c.minY), maxX: Math.max(a.maxX, c.maxX), maxY: Math.max(a.maxY, c.maxY) }));
      return !(b.maxX - b.minX > W * 0.8 && b.maxY - b.minY > H * 0.8);
    });
  }
  // 近接する成分は同じ図面
  const bb = (ws: WWall[]) => ws.map(wallBBox).reduce((a, b) => ({
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (bboxGap(bb(groups[i]), bb(groups[j])) < mergeGap) {
          groups[i] = groups[i].concat(groups[j]);
          groups.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  // 小さすぎる図（凡例・詳細図など）は除外
  groups = groups.filter((g) => lenOf(g) >= 8000);
  return groups;
}

export interface PlanData {
  pageIndex: number;
  bbox: BBox;
  floorHint: number | null;
  walls: WWall[];
  texts: MmText[];
  segs: Seg[];
  /** 円弧（コンロの輪・丸テーブル・便器の形など、家具の文脈読みに使う） */
  arcs: Arc[];
  /** 敷地・道路の読み取り用（建物の周囲 30m の文字と線） */
  siteTexts: MmText[];
  siteSegs: Seg[];
  /** 壁の塗りつぶし（曲面・斜めの壁・柱も形のまま部屋の区切りに使う） */
  wallPolys: Vec2[][];
  /** 細長い白抜き（窓・ガラス戸の記号）: 部屋の区切りとして使う */
  sashPolys: Vec2[][];
  /** 室名の入った色塗り（カラー平面図の部屋の塗り）: 輪郭を部屋の区切りに使う */
  roomFills: Vec2[][];
  /** 手描き風の図面（太線を画像にして壁を検出した）: 太線を内外判定の仕切りに使う */
  sketchLines?: Seg[];
  /** 画像から壁を検出した図面（手描き風・スキャン）: 線の揺れ・途切れを許容する */
  loose?: boolean;
  /** スキャン画像の図面 */
  scan?: boolean;
}

function windowStyleFor(room: RoomType | null, widthMm: number, facingSouth: boolean): { style: WindowStyle; sill: number; height: number } {
  switch (room) {
    case 'ldk':
    case 'living':
    case 'dining':
    case 'japanese':
      if (widthMm >= 1500) return { style: 'hakidashi', sill: 0, height: 2200 };
      return { style: 'koshi', sill: 900, height: 1100 };
    case 'bath':
      return { style: 'small', sill: 1100, height: 900 };
    case 'toilet':
    case 'washroom':
    case 'closet':
    case 'storage':
      return { style: 'small', sill: 1400, height: 600 };
    case 'stairs':
    case 'hall':
      return { style: 'high', sill: 1500, height: 700 };
    case 'kitchen':
      return { style: 'small', sill: 1200, height: 700 };
    case 'bedroom':
    case 'kids':
    case 'study':
    default:
      // 居室の大きな窓は腰高にせず、天井付けの横長（FIX＋横すべり出し）に。細い窓は縦すべり出し（天井まで）
      if (widthMm >= 1400) return { style: 'high', sill: 1300, height: 700 };
      return { style: 'koshi', sill: 900, height: 1100 };
  }
  void facingSouth;
}

/**
 * ホームランディックの窓の語彙: 掃き出し窓は LDK（庭側）に 1 ヵ所だけ。残りの大きな窓は天井付けの横長 FIX、細い窓は縦すべり出しにする。
 * 図面にサッシ記号・FL 注記で寸法が書かれた窓はそのまま。
 */
function applyWindowVocabulary(openings: Opening[], info: Map<number, { room: RoomType | null; south: number; drawn: boolean; marked?: boolean }>) {
  const living = new Set<RoomType | null>(['ldk', 'living', 'dining', 'japanese']);
  const cands = openings
    .map((o, i) => ({ o, i, inf: info.get(i) }))
    .filter((x) => x.o.kind === 'window' && x.o.windowStyle === 'hakidashi' && x.inf && !x.inf.drawn && living.has(x.inf.room));
  // 通り口の印で「出入りする窓」が分かっている図面: 居間に印のある窓があれば、印の無い窓は掃き出しにしない
  const hasMarked = [...info.entries()].some(([i, inf]) => inf.marked && living.has(inf.room) && openings[i]?.kind === 'window');
  if (cands.length <= (hasMarked ? 0 : 1)) return;
  // 庭側（南）に面した幅の広い窓を掃き出しに残す
  cands.sort((a, b) => b.o.t1 - b.o.t0 + b.inf!.south * 1500 - (a.o.t1 - a.o.t0 + a.inf!.south * 1500));
  for (const x of cands.slice(hasMarked ? 0 : 1)) {
    const w = x.o.t1 - x.o.t0;
    if (w >= 1400) {
      x.o.windowStyle = 'high';
      x.o.sill = 1300;
      x.o.height = 700;
    } else {
      x.o.windowStyle = 'koshi';
      x.o.sill = 900;
      x.o.height = 1100;
    }
  }
}

const MAIN_PRIORITY: RoomType[] = ['ldk', 'living', 'dining', 'kitchen', 'japanese', 'bedroom', 'kids', 'study', 'entrance', 'washroom', 'bath', 'toilet', 'balcony', 'garage', 'hall', 'stairs', 'closet', 'storage', 'porch', 'void', 'other'];

/**
 * 1つの領域の室名のうち代表となるもの（居室を優先、同格なら大きい文字）。
 * 領域の広さ（㎡）が分かるときは、その用途としてあり得ない広さの名前（22㎡のトイレなど）を後回しにする
 */
function mainName<T extends { type: RoomType; size: number }>(names: T[], areaM2?: number): T | undefined {
  const fits = (t: RoomType) => areaM2 == null || areaM2 <= ROOM_KNOWLEDGE[t].tatami[1] * 1.62 * 3;
  return names.slice().sort((p, q) => Number(fits(q.type)) - Number(fits(p.type)) || MAIN_PRIORITY.indexOf(p.type) - MAIN_PRIORITY.indexOf(q.type) || q.size - p.size)[0];
}

/**
 * 文字を室名として使える形に整える。説明文（「上部寝室から使う」など）は null。
 * 「※」以降の注記・括弧の帖数は除く。
 */
export function cleanRoomName(raw: string): string | null {
  let s0 = raw.trim().replace(/[\uff61-\uff9f]+/g, (m) => m.normalize('NFKC')).replace(/[※＊*].*$/, '').replace(/[（(][^）)]*[）)]?$/, '').trim();
  if (!s0) return null;
  const n = normalizeText(s0);
  // 説明文: 長い、または助詞・動詞の語尾を含む
  // （「階段下１ｍくらいの収納」のような引き出し線の注記が室名になり、洋室が 2 つに割れていた: 田中様）
  const sentence = /(から|まで|ため|する|して|できる|ように|ません|ます|です|だけ|の空|を|が見|に使|予定|検討|想定|可能|くらい|ぐらい|ほどの|程度|あたり|^ここ|^この|近くに|つなが|飾る|欲しい|ほしい|希望|として|活用|^上は|^下は|ちゃん)/.test(n);
  if (n.length > 12 || (sentence && n.length > 5)) return /中庭|坪庭/.test(n) ? '中庭' : null;
  // 設備・家具・寸法・申請などの注記
  if (/【|】|申請|開口\d|\d(M|MM|ｍ)$|^PS$|^MB$|洗濯機|冷蔵庫|ベンチ|テーブル|カウンター|ドラム|上部|下部|鉄骨|造作|^OPEN$|吊戸|棚$|ガラス/.test(n)) return null;
  // 建具の仕様（引き違い・透明・型板…）と家具・器具の名前（背面収納・手洗い器・カップボード…）は室名ではない
  if (/引き?違い?|片開き|両開き|片引き?|引込み?|折れ?戸|親子|^透明|型板|型ガラス|網入|LOW-?E|複層|アルミ|樹脂|障子|ふすま|襖|^FIX|床付け?|天付け?|^TW$|^APW|サーモス|^YKK|^LIXIL|クロス|見切|サッシ|ｻｯｼ|換気|框/i.test(n)) return null;
  if (/背面収納|カップボード|食器棚|^手洗い?器?$|洗面台|洗面化粧台|エアコン|^TV|テレビ|ソファ|ベッド|デスク|^机$|椅子|タンス|本棚|物干|ハンガー|下駄箱|靴箱|可動棚|枕棚|パイプ|洗濯機|乾燥機|便器|浴槽|給湯器|分電盤|換気扇|レンジ|コンロ|シンク|IH$/i.test(n)) return null;
  return s0;
}

/** 室名らしい短い語（説明文・寸法・記号は除く） */
export function looksLikeRoomName(raw: string): boolean {
  const s = normalizeText(raw);
  if (s.length < 2 || s.length > 10) return false;
  if (/[。、，,：:！!？?「」『』]/.test(s)) return false;
  if (/^[\d.,+\-×XW*＊()（）]+$/.test(s)) return false;
  if (/\d{3,}/.test(s)) return false;
  if (/^(UP|DN|FIX|FL|GL|CH|H=|W=|PS|MB|SK|冷|W\d)/.test(s)) return false;
  if (/境界|道路|隣地|通り芯|芯|^GL|天井|床補強|予定|参考|将来|スロープ|想定|程度|ライン|シャッター/.test(s)) return false;
  // 日本語を含む語、または英字のみの略称
  if (/^※/.test(raw.trim())) return false;
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(s) || /^[A-Z]{2,5}$/.test(s);
}

/**
 * 吹抜の範囲: 「吹抜」の文字を含み、対角線（×印）が引かれた長方形。
 * 吹抜は手すり・腰壁の細い線で描かれ壁として拾えないため、×印から範囲を求める。
 */
export function voidRectangles(plan: { segs: Seg[]; texts: MmText[]; walls?: { a: Vec2; b: Vec2 }[] }, level?: number): BBox[] {
  const voidTexts = plan.texts.filter((t) => /吹抜|吹き抜け|VOID/i.test(t.str));
  if (!voidTexts.length) return [];
  // 斜めの線（文字の部分などで途切れたものは、同じ直線上でつなぐ）
  const raw = plan.segs.filter((sg) => {
    const L = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
    if (L < 30) return false;
    const a = Math.abs(Math.atan2(sg.b.y - sg.a.y, sg.b.x - sg.a.x)) % (Math.PI / 2);
    return a > 0.25 && a < Math.PI / 2 - 0.25;
  });
  // 長い断片を基準線にして、その直線上（40mm 以内）の断片を 700mm までの隙間でつなぐ
  const used = new Uint8Array(raw.length);
  const order = raw.map((_, i) => i).sort((i, j) => Math.hypot(raw[j].b.x - raw[j].a.x, raw[j].b.y - raw[j].a.y) - Math.hypot(raw[i].b.x - raw[i].a.x, raw[i].b.y - raw[i].a.y));
  const diag: { a: Vec2; b: Vec2 }[] = [];
  for (const i of order) {
    if (used[i]) continue;
    const S = raw[i];
    const L = Math.hypot(S.b.x - S.a.x, S.b.y - S.a.y);
    if (L < 250) break;
    const u = { x: (S.b.x - S.a.x) / L, y: (S.b.y - S.a.y) / L };
    const off = (q: Vec2) => Math.abs((q.x - S.a.x) * -u.y + (q.y - S.a.y) * u.x);
    const tt = (q: Vec2) => (q.x - S.a.x) * u.x + (q.y - S.a.y) * u.y;
    const ivs: [number, number, number][] = [];
    raw.forEach((q, j) => {
      if (off(q.a) < 40 && off(q.b) < 40) ivs.push([Math.min(tt(q.a), tt(q.b)), Math.max(tt(q.a), tt(q.b)), j]);
    });
    ivs.sort((p, q) => p[0] - q[0]);
    let lo = 0;
    let hi = L;
    let grew = true;
    while (grew) {
      grew = false;
      for (const [a, b] of ivs) {
        if (b > hi && a <= hi + 700) (hi = b), (grew = true);
        if (a < lo && b >= lo - 700) (lo = a), (grew = true);
      }
    }
    for (const [a, b, j] of ivs) if (a >= lo - 1 && b <= hi + 1) used[j] = 1;
    if (hi - lo >= 1500) diag.push({ a: { x: S.a.x + u.x * lo, y: S.a.y + u.y * lo }, b: { x: S.a.x + u.x * hi, y: S.a.y + u.y * hi } });
  }
  const out: BBox[] = [];
  for (let i = 0; i < diag.length; i++) {
    for (let j = i + 1; j < diag.length; j++) {
      const A = diag[i];
      const B = diag[j];
      const pts = [A.a, A.b, B.a, B.b];
      const bb = bboxOf(pts);
      if (bb.maxX - bb.minX < 1200 || bb.maxY - bb.minY < 1200) continue;
      // 4点がそれぞれ長方形の角にある（＝2本の対角線）
      const tol = 200;
      const corners = [
        { x: bb.minX, y: bb.minY },
        { x: bb.maxX, y: bb.minY },
        { x: bb.maxX, y: bb.maxY },
        { x: bb.minX, y: bb.maxY },
      ];
      // 4つの角のうち3つ以上に対角線の端がある（片方の線が家具・階段で途切れていても可）
      if (corners.filter((c) => pts.some((q) => Math.abs(q.x - c.x) < tol && Math.abs(q.y - c.y) < tol)).length < 3) continue;
      // 2本は交差している
      const cr = (p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2) => {
        const d = (p1.x - p0.x) * (q1.y - q0.y) - (p1.y - p0.y) * (q1.x - q0.x);
        if (Math.abs(d) < 1e-9) return false;
        const t = ((q0.x - p0.x) * (q1.y - q0.y) - (q0.y - p0.y) * (q1.x - q0.x)) / d;
        const v = ((q0.x - p0.x) * (p1.y - p0.y) - (q0.y - p0.y) * (p1.x - p0.x)) / d;
        return t > 0.05 && t < 0.95 && v > 0.05 && v < 0.95;
      };
      if (!cr(A.a, A.b, B.a, B.b)) continue;
      if (!voidTexts.some((t) => t.x > bb.minX && t.x < bb.maxX && t.y > bb.minY && t.y < bb.maxY)) continue;
      if (out.some((o) => Math.abs(o.minX - bb.minX) < 200 && Math.abs(o.minY - bb.minY) < 200)) continue;
      out.push(bb);
    }
  }
  // × 印の無い吹抜（堀様邸の 2 階: 白い長方形に「吹抜」の文字だけで、ホールとの境は手すりの細い線）:
  // 文字の上下左右で最も近い細い線（手すり・腰壁）または壁を 4 辺とする長方形。4 辺とも 8 割以上が線で囲まれ、中にほかの室名が無いもの。
  // 1 階の「上部吹抜」（破線の範囲）は対象外（2 階以上の「吹抜」だけ）
  if (level == null || level >= 2) {
    type Ln = { o: number; t0: number; t1: number };
    const H: Ln[] = [];
    const V: Ln[] = [];
    const addLn = (a: Vec2, b: Vec2) => {
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 300) return;
      if (Math.abs(b.y - a.y) < L * 0.02) H.push({ o: (a.y + b.y) / 2, t0: Math.min(a.x, b.x), t1: Math.max(a.x, b.x) });
      else if (Math.abs(b.x - a.x) < L * 0.02) V.push({ o: (a.x + b.x) / 2, t0: Math.min(a.y, b.y), t1: Math.max(a.y, b.y) });
    };
    for (const s of plan.segs) if (!s.dashed) addLn(s.a, s.b);
    for (const w of plan.walls ?? []) addLn(w.a, w.b);
    const covered = (lines: Ln[], o: number, t0: number, t1: number) => {
      const ivs = lines
        .filter((l) => Math.abs(l.o - o) <= 60 && l.t1 > t0 && l.t0 < t1)
        .map((l) => [Math.max(t0, l.t0), Math.min(t1, l.t1)] as [number, number])
        .sort((p, q) => p[0] - q[0]);
      let s = 0;
      let cur = -Infinity;
      for (const [a, b] of ivs) {
        const a2 = Math.max(a, cur);
        if (b > a2) {
          s += b - a2;
          cur = b;
        }
      }
      return s;
    };
    const isRoomLabel = (s: string) => /[぀-ヿ㐀-鿿]{2,}/.test(s) && !/吹抜|吹き抜け|手摺|手すり|腰壁|笠木|勾配|天井|ガラス|窓/.test(s);
    for (const t of voidTexts) {
      if (!/^(吹抜|吹き抜け|VOID)$/i.test(t.str.replace(/\s/g, ''))) continue;
      if (out.some((o) => t.x > o.minX && t.x < o.maxX && t.y > o.minY && t.y < o.maxY)) continue;
      const above = H.filter((l) => l.o < t.y - 150 && l.t0 <= t.x && l.t1 >= t.x).sort((p, q) => q.o - p.o)[0];
      const below = H.filter((l) => l.o > t.y + 150 && l.t0 <= t.x && l.t1 >= t.x).sort((p, q) => p.o - q.o)[0];
      const left = V.filter((l) => l.o < t.x - 150 && l.t0 <= t.y && l.t1 >= t.y).sort((p, q) => q.o - p.o)[0];
      const right = V.filter((l) => l.o > t.x + 150 && l.t0 <= t.y && l.t1 >= t.y).sort((p, q) => p.o - q.o)[0];
      if (!above || !below || !left || !right) continue;
      const bb: BBox = { minX: left.o, maxX: right.o, minY: above.o, maxY: below.o };
      const w = bb.maxX - bb.minX;
      const h = bb.maxY - bb.minY;
      if (w < 1200 || h < 1200 || w * h > 60e6) continue;
      if (covered(H, bb.minY, bb.minX, bb.maxX) < w * 0.8 || covered(H, bb.maxY, bb.minX, bb.maxX) < w * 0.8 || covered(V, bb.minX, bb.minY, bb.maxY) < h * 0.8 || covered(V, bb.maxX, bb.minY, bb.maxY) < h * 0.8) continue;
      if (plan.texts.some((q) => q !== t && q.x > bb.minX + 100 && q.x < bb.maxX - 100 && q.y > bb.minY + 100 && q.y < bb.maxY - 100 && isRoomLabel(q.str))) continue;
      out.push(bb);
    }
  }
  return out;
}

/** 線分が通るセル（太さ1セル） */
function lineCells(grid: Grid, a: Vec2, b: Vec2): number[] {
  const [x0, y0] = grid.cellOf(a);
  const [x1, y1] = grid.cellOf(b);
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / n);
    const y = Math.round(y0 + ((y1 - y0) * i) / n);
    if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) continue;
    out.push(y * grid.w + x);
    // 斜めの抜けを防ぐため隣も塞ぐ
    if (x + 1 < grid.w) out.push(y * grid.w + x + 1);
  }
  return out;
}

/**
 * 室名が2つ以上入った区画を、壁から壁へ渡る線（収納の戸・間仕切り・出入口の線）で分ける。
 * 線で区切ると室名が別々になる場合だけ採用するので、カウンターなどで部屋を誤って割ることはない。
 */
function splitMergedRegions(grid: Grid, plan: PlanData): boolean {
  const names = plan.texts
    .map((t) => ({ t, nm: cleanRoomName(t.str) }))
    .filter((o) => o.nm && classifyRoomName(o.nm) != null)
    .map((o) => ({ x: o.t.x, y: o.t.y, nm: o.nm!, type: classifyRoomName(o.nm!)!, tatami: undefined as number | undefined }));
  if (names.length < 2) return false;
  // 室名のそばの帖数（「6帖」「40.1帖」）: 区切りの候補が複数あるとき、帖数に合う面積になる線を選ぶ
  for (const t of plan.texts) {
    const area = parseAreaLabel(t.str);
    const tatami = area?.tatami ?? (area?.m2 ? area.m2 / 1.62 : undefined);
    if (!tatami) continue;
    const near = names
      .map((n) => ({ n, d: Math.hypot(n.x - t.x, n.y - t.y) }))
      .filter((o) => o.d < 1500)
      .sort((a, b) => a.d - b.d)[0];
    if (near && near.n.tatami == null) near.n.tatami = tatami;
  }
  let changed = false;
  for (let iter = 0; iter < 6; iter++) {
    const { labels, sizes } = grid.labelComponents();
    const byLabel = new Map<number, typeof names>();
    for (const n of names) {
      const [cx, cy] = grid.cellOf(n);
      if (cx < 0 || cy < 0 || cx >= grid.w || cy >= grid.h) continue;
      const l = labels[cy * grid.w + cx];
      if (!l) continue;
      if (!byLabel.has(l)) byLabel.set(l, []);
      byLabel.get(l)!.push(n);
    }
    let any = false;
    for (const [l, ns] of byLabel) {
      const distinct = ns.filter((n, i) => ns.findIndex((m) => m.nm === n.nm) === i);
      if (distinct.length < 2) continue;
      // 区画の範囲
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < labels.length; i++)
        if (labels[i] === l) {
          const x = i % grid.w;
          const y = (i / grid.w) | 0;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      const p0 = grid.centerOf(minX, minY);
      const p1 = grid.centerOf(maxX, maxY);
      const nearWall = (q: Vec2) => {
        const [x, y] = grid.cellOf(q);
        for (let dy = -4; dy <= 4; dy++)
          for (let dx = -4; dx <= 4; dx++) {
            const v = grid.get(x + dx, y + dy);
            if (v === WALL) return true;
          }
        return false;
      };
      const cands = plan.segs.filter((sg) => {
        const L = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
        if (L < 350 || L > 5000) return false;
        const m = { x: (sg.a.x + sg.b.x) / 2, y: (sg.a.y + sg.b.y) / 2 };
        if (m.x < p0.x || m.x > p1.x || m.y < p0.y || m.y > p1.y) return false;
        const [mx, my] = grid.cellOf(m);
        if (labels[my * grid.w + mx] !== l) return false;
        return nearWall(sg.a) && nearWall(sg.b);
      });
      // 区切りの候補: 図面の線（戸・間仕切り）と、壁の端からその壁の向きに延ばして 2m 以内で別の壁に当たる線
      // （戸の開口・壁の端にある出入口。収納の折れ戸や、壁の端と直角の壁の間の出入口がこれで閉じる）
      const candCells: { cells: number[]; L: number; maxPiece: number }[] = cands.map((sg) => ({ cells: lineCells(grid, sg.a, sg.b), L: Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y), maxPiece: Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y) }));
      /** 壁の端から延ばした線（同じ行・列ごとに集め、壁をはさんで一直線に並ぶものはまとめて 1 本の仮想の間仕切りにする） */
      const extended: { cells: number[]; L: number; axis: 'h' | 'v'; line: number; from: number; to: number }[] = [];
      {
        const maxLen = Math.round(2730 / grid.res);
        const dirs = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ];
        const seenKey = new Set<string>();
        const x0 = Math.max(0, minX - 1);
        const x1 = Math.min(grid.w - 1, maxX + 1);
        const y0 = Math.max(0, minY - 1);
        const y1 = Math.min(grid.h - 1, maxY + 1);
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const i = y * grid.w + x;
            if (grid.data[i] !== WALL) continue;
            for (const [dx, dy] of dirs) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= grid.w || ny >= grid.h) continue;
              if (labels[ny * grid.w + nx] !== l) continue;
              const px = x - dx;
              const py = y - dy;
              if (px < 0 || py < 0 || px >= grid.w || py >= grid.h) continue;
              if (grid.data[py * grid.w + px] !== WALL) continue;
              // 同じ壁の端（厚みぶんの並び）は 4 セルごとに 1 本
              const key = `${dx},${dy},${dx ? x : y},${Math.floor((dx ? y : x) / 4)}`;
              if (seenKey.has(key)) continue;
              seenKey.add(key);
              const cells: number[] = [];
              let cx = nx;
              let cy = ny;
              let hit = false;
              for (let k = 0; k < maxLen; k++) {
                const c = cy * grid.w + cx;
                if (grid.data[c] === WALL) {
                  hit = true;
                  break;
                }
                if (labels[c] !== l) break;
                cells.push(c);
                cx += dx;
                cy += dy;
                if (cx < 0 || cy < 0 || cx >= grid.w || cy >= grid.h) break;
              }
              if (hit && cells.length >= 2) {
                candCells.push({ cells, L: cells.length * grid.res, maxPiece: cells.length * grid.res });
                const axis = dx ? 'h' : 'v';
                const ts = cells.map((c) => (axis === 'h' ? c % grid.w : Math.floor(c / grid.w)));
                extended.push({ cells, L: cells.length * grid.res, axis, line: axis === 'h' ? ny : nx, from: Math.min(...ts), to: Math.max(...ts) });
              }
            }
          }
        // 同じ直線上で、間が壁だけの延長線どうしをつなぐ（LDK と洗面脱衣室・ホールが壁なしで続く間取りで、
        // 中庭や玄関の壁をはさんで一直線に並ぶ壁の端から「見えない間仕切り」を引く）
        const byLine = new Map<string, typeof extended>();
        for (const e of extended) {
          const k = `${e.axis}:${e.line}`;
          if (!byLine.has(k)) byLine.set(k, []);
          byLine.get(k)!.push(e);
        }
        for (const [k, list] of byLine) {
          if (list.length < 2) continue;
          const axis = k[0] as 'h' | 'v';
          list.sort((a, b) => a.from - b.from);
          let run: typeof extended = [list[0]];
          const flush = () => {
            if (run.length >= 2) {
              const cells = [...new Set(run.flatMap((r) => r.cells))];
              candCells.push({ cells, L: cells.length * grid.res, maxPiece: Math.max(...run.map((r) => r.L)) });
            }
          };
          for (let i = 1; i < list.length; i++) {
            const prev = run[run.length - 1];
            const cur = list[i];
            // 間のセルが全部壁なら同じ仮想線
            let wallOnly = cur.from > prev.to;
            for (let t = prev.to + 1; wallOnly && t < cur.from; t++) {
              const c = axis === 'h' ? list[0].line * grid.w + t : t * grid.w + list[0].line;
              if (grid.data[c] !== WALL) wallOnly = false;
            }
            if (wallOnly && cur.from - prev.to <= Math.round(6000 / grid.res)) run.push(cur);
            else {
              flush();
              run = [cur];
            }
          }
          flush();
        }
      }
      // 室名どうしを分ける線のうち、小さい側が 0.6㎡ 以上で最も短いもの。
      // 1 本の線で分けられないときだけ、壁をはさんで一直線に並ぶ延長線の組（仮想の間仕切り）を使い、
      // 帖数が書いてあれば両側の面積が帖数に合う組を選ぶ
      let best: { cells: number[]; score: number } | null = null;
      const total = sizes[l] ?? 0;
      const A = distinct[0];
      for (const B of distinct.slice(1)) {
        // 収納・トイレ・個室が他の部屋と一続きになっているときは、1.5 間までの線も使う（普通の戸は 2m まで）
        const strict = mustSeparate(A.type, B.type);
        for (const pass of [0, 1] as const) {
        for (const cd of candCells) {
          const combo = cd.L > cd.maxPiece + 1;
          if (combo !== (pass === 1)) continue;
          if (combo) {
            if (cd.maxPiece > (strict ? 2730 : 2000) || cd.L > 6000) continue;
          } else if (cd.L > 2000 && !strict) continue;
          const cells = cd.cells;
          const blocked = new Set(cells);
          const [ax, ay] = grid.cellOf(A);
          const [bx, by] = grid.cellOf(B);
          const start = ay * grid.w + ax;
          const goal = by * grid.w + bx;
          if (blocked.has(start) || blocked.has(goal)) continue;
          const seen = new Uint8Array(labels.length);
          const q = [start];
          seen[start] = 1;
          let reached = false;
          let count = 0;
          while (q.length) {
            const i = q.pop()!;
            count++;
            if (i === goal) {
              reached = true;
              break;
            }
            const x = i % grid.w;
            for (const j of [x > 0 ? i - 1 : -1, x < grid.w - 1 ? i + 1 : -1, i - grid.w, i + grid.w]) {
              if (j < 0 || j >= labels.length || seen[j] || labels[j] !== l || blocked.has(j)) continue;
              seen[j] = 1;
              q.push(j);
            }
          }
          if (reached) continue;
          const area = (count * grid.res * grid.res) / 1e6;
          if (area < 0.6) continue;
          // 帖数との照合（延長線の組だけ）: A 側・B 側それぞれ、室名が 1 種類だけで帖数が分かるときは面積のずれを見る
          // （線の長さが同じ候補どうしの決め手。長さが違えば短い線が優先）
          let score = combo ? Math.round(cd.L / 300) * 300 * 10 : cd.L;
          const sideA = ns.filter((n) => {
            const [x, y] = grid.cellOf(n);
            return seen[y * grid.w + x] === 1;
          });
          const sideB = ns.filter((n) => !sideA.includes(n));
          const otherArea = ((total - count - cells.length) * grid.res * grid.res) / 1e6;
          for (const [side, ar] of combo ? ([[sideA, area], [sideB, otherArea]] as [typeof ns, number][]) : []) {
            const kinds = [...new Set(side.map((n) => n.nm))];
            if (kinds.length !== 1) continue;
            const tat = side.find((n) => n.tatami != null)?.tatami;
            if (tat == null) continue;
            const want = tat * 1.62;
            score += Math.min(2999, (Math.abs(ar - want) / want) * 3000);
          }
          if (!best || score < best.score) best = { cells, score };
        }
        if (best) break;
        }
        if (best) break;
      }
      if (best) {
        for (const i of best.cells) grid.data[i] = WALL;
        any = true;
        changed = true;
      }
    }
    if (!any) break;
  }
  return changed;
}

/** 太線を画像にして壁を検出する（手描き風の図面用） */
function rasterWallDetection(page: PageMm): WallDetection | null {
  const segs = page.segs.filter((sg) => !sg.dashed && sg.source === 'stroke');
  if (segs.length < 200) return null;
  const hT = heavyWidthThreshold(segs);
  const heavy = hT == null ? segs : segs.filter((sg) => sg.width >= hT);
  if (heavy.length < 100) return null;
  const bb = bboxOf(heavy.flatMap((sg) => [sg.a, sg.b]));
  const res = 20;
  // 画像が大きくなりすぎる場合は粗くする
  const cells = ((bb.maxX - bb.minX) / res) * ((bb.maxY - bb.minY) / res);
  const r = cells > 6e6 ? res * Math.sqrt(cells / 6e6) : res;
  const img = rasterizeSegments(heavy, bb, r);
  const ang = dominantAngles(heavy);
  if (!ang.length) return null;
  return detectWallsRaster(img, ang, { closeRadius: Math.max(2, Math.round(80 / r)) });
}

/** 壁の芯の間隔を 910mm モジュール（半間 455mm）に合わせる縮尺の補正係数 */
export function moduleScaleFromWalls(walls: { a: Vec2; b: Vec2; thickness?: number }[]): { factor: number; confidence: number } {
  const ax = walls
    .map((w) => {
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (L < 300) return null;
      let th = Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x);
      if (th < 0) th += Math.PI;
      if (th >= Math.PI) th -= Math.PI;
      const n = { x: -Math.sin(th), y: Math.cos(th) };
      return { th, o: ((w.a.x + w.b.x) / 2) * n.x + ((w.a.y + w.b.y) / 2) * n.y, L };
    })
    .filter((x): x is { th: number; o: number; L: number } => !!x);
  const ds: { d: number; w: number }[] = [];
  for (let i = 0; i < ax.length; i++)
    for (let j = i + 1; j < ax.length; j++) {
      const dth = Math.abs(ax[i].th - ax[j].th);
      if (Math.min(dth, Math.PI - dth) > 0.03) continue;
      const d = Math.abs(ax[i].o - ax[j].o);
      if (d < 400 || d > 12000) continue;
      ds.push({ d, w: Math.min(ax[i].L, ax[j].L) });
    }
  if (ds.length < 10) return { factor: 1, confidence: 0 };
  const W = ds.reduce((s0, q) => s0 + q.w, 0);
  const fit = (f: number) => ds.reduce((s0, q) => s0 + q.w * Math.cos((2 * Math.PI * q.d * f) / 455), 0) / W;
  // 910mm の倍数は 1/100 と 1/50 で区別できないので、壁の厚み（実物は 100〜180mm 程度）で絞る
  const th = walls.map((w) => w.thickness ?? 0).filter((t) => t > 0).sort((a, b) => a - b);
  // 外壁の厚み（内壁や細い線に引っ張られないよう、厚い側の 75% 点）
  const medT = th.length ? th[Math.floor(th.length * 0.75)] : 0;
  const thickPenalty = (f: number) => (medT ? Math.abs(Math.log((medT * f) / 130)) : 0);
  let best = 1;
  let bs = -Infinity;
  let bfit = 0;
  for (const base of [0.5, 0.6, 2 / 3, Math.SQRT1_2, 0.75, 1, 4 / 3, Math.SQRT2, 1.5, 2]) {
    // 印刷の伸縮を考えて ±4% の範囲で合わせる
    for (let f = base * 0.96; f <= base * 1.04; f += base * 0.0025) {
      const v = fit(f);
      const sc0 = v - thickPenalty(f) * 1.2;
      if (sc0 > bs) {
        bs = sc0;
        best = f;
        bfit = v;
      }
    }
  }
  // 厚みだけで見ても今の縮尺が明らかにおかしい（外壁が 250mm 超・60mm 未満）ときは、模数の一致が弱くても補正する
  const thickBad = medT > 0 && thickPenalty(1) > 0.6 && thickPenalty(best) < 0.3;
  return { factor: best, confidence: thickBad ? Math.max(bfit, 0.3) : bfit };
}

/** 文字 t と同じ行で、読む向きに続く文字（近い順、最大 maxSizes 文字分の距離）。縦書き・回転した図面にも対応 */
function followingOnLine(t: MmText, texts: MmText[], maxSizes: number): MmText[] {
  const u = { x: Math.cos(t.angle), y: Math.sin(t.angle) };
  return texts
    .map((q) => {
      const dx = q.x - t.x;
      const dy = q.y - t.y;
      return { q, along: dx * u.x + dy * u.y, perp: Math.abs(-dx * u.y + dy * u.x) };
    })
    .filter((o) => o.q !== t && o.perp < t.size * 0.6 && o.along > 0 && o.along < t.size * maxSizes)
    .sort((a, b) => a.along - b.along)
    .map((o) => o.q);
}

/** 面積表（「1階 100.20」「2階 34.15」）を読む。階 → ㎡ */
export function readAreaTable(pages: PageMm[]): Record<number, number> & { build?: number; total?: number } {
  const out: Record<number, number> & { build?: number; total?: number } = {};
  for (const p of pages) {
    for (const t of p.texts) {
      const s = normalizeText(t.str).replace(/\s/g, '');
      const m = /^([1-9])階$/.exec(s);
      // 建築面積・延床面積も拾う（上下階の重ね位置の検算に使う）
      const key: number | 'build' | 'total' | null = m ? +m[1] : /^建築面積$/.test(s) ? 'build' : /^延床面積$|^延べ床面積$/.test(s) ? 'total' : null;
      if (key == null) continue;
      const cands = followingOnLine(t, p.texts, 20)
        .map((q) => ({ q, v: /^(\d{1,3}\.\d{1,2})(㎡|m2|m²)?$/.exec(normalizeText(q.str).replace(/\s/g, '')) }))
        .filter((o) => o.v);
      if (cands.length && (out as Record<string, number | undefined>)[key] == null) (out as Record<string, number>)[key] = parseFloat(cands[0].v![1]);
    }
  }
  return out;
}

/** 文字の位置の区画。文字の中心が区切り線の上に乗っている場合は、周囲（±3セル）で最も多い区画 */
function labelNear(grid: Grid, lb: Int32Array | number[], p: Vec2): number {
  const [cx, cy] = grid.cellOf(p);
  if (cx >= 0 && cy >= 0 && cx < grid.w && cy < grid.h && lb[cy * grid.w + cx]) return lb[cy * grid.w + cx];
  const cnt = new Map<number, number>();
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) continue;
      const l = lb[y * grid.w + x];
      if (l) cnt.set(l, (cnt.get(l) ?? 0) + 1);
    }
  let best = 0;
  let bn = 0;
  for (const [l, n] of cnt) if (n > bn) [best, bn] = [l, n];
  return best;
}

/** 同じ直線上に並ぶ壁の間の隙間（最大 maxGap） */
function collinearGaps(walls: WWall[], maxGap: number, axisTol = 30): { a: Vec2; b: Vec2; d: number }[] {
  const out: { a: Vec2; b: Vec2; d: number }[] = [];
  const byAxis: WWall[][] = [];
  for (const w of walls) {
    const ax = byAxis.find((ws) => ws[0].g === w.g && Math.abs(ws[0].o - w.o) < axisTol);
    if (ax) ax.push(w);
    else byAxis.push([w]);
  }
  for (const ws of byAxis) {
    ws.sort((p, q) => p.t0 - q.t0);
    let end = ws[0].t1;
    let endO = ws[0].o;
    for (let k = 1; k < ws.length; k++) {
      const w = ws[k];
      const gap = w.t0 - end;
      if (gap > 30 && gap <= maxGap) {
        const P = (t: number, o: number) => ({ x: w.u.x * t + w.n.x * o, y: w.u.y * t + w.n.y * o });
        out.push({ a: P(end, endO), b: P(w.t0, w.o), d: w.d });
      }
      if (w.t1 > end) {
        end = w.t1;
        endO = w.o;
      }
    }
  }
  return out;
}

/**
 * オーバースライダー（ガレージのドア）のレールを壁から外す。
 * レールは車の出入口の両端・中央から車庫の中へ直角に伸びる細い二重線で、帯の中の平行線なので「全長が窓の壁」として読まれる。
 * そのままだと車庫の中を仕切り、出入口の前を塞ぐ壁にもなって、車庫が部屋として閉じない（吉田大仁様邸 1st-2: 車庫 27 帖が消えていた）。
 * 条件: 2.4m 以上の切れ目（出入口）に直交し、「窓」が出入口の線から 450mm 以内で始まって 1.5m 以上伸び、その先で壁が終わっている
 * （先に壁の実体が続くものは、窓のある本物の側壁）。戻り値は外したレールの数
 */
export function cutGarageRails(walls: WWall[], nearGarage: (a: Vec2, b: Vec2) => boolean): number {
  let cut = 0;
  const gaps = collinearGaps(walls, 7500).filter((c) => Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y) >= 2400 && nearGarage(c.a, c.b));
  for (const c of gaps) {
    const L = Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y);
    const ug = { x: (c.b.x - c.a.x) / L, y: (c.b.y - c.a.y) / L };
    for (const w of [...walls]) {
      if (Math.abs(w.u.x * ug.x + w.u.y * ug.y) > 0.05) continue;
      // 壁の軸線が出入口の線を横切る位置（両端の袖壁の位置を含む）
      const tg = (w.a.x - c.a.x) * ug.x + (w.a.y - c.a.y) * ug.y;
      if (tg < -250 || tg > L + 250) continue;
      const tLine = c.a.x * w.u.x + c.a.y * w.u.y;
      const ta = w.a.x * w.u.x + w.a.y * w.u.y;
      const tb = w.b.x * w.u.x + w.b.y * w.u.y;
      const T0 = Math.min(ta, tb);
      const T1 = Math.max(ta, tb);
      const rail = w.openings.find((op) => {
        if (op.kind !== 'window' || op.t1 - op.t0 < 1500) return false;
        // 壁のほとんど（7 割以上）がレール。窓のほかに壁の実体が長く続くものは、ふつうの壁（池本様邸の LDK の壁）
        if (op.t1 - op.t0 < (T1 - T0) * 0.7) return false;
        const lowNear = Math.abs(op.t0 - tLine) <= Math.abs(op.t1 - tLine);
        // 出入口の線から車庫の中へ一方向に伸びる: 付け根は線の手前 150mm〜奥 450mm（線をまたいで両側に伸びる窓・引戸は違う）
        const near = lowNear ? op.t0 : op.t1;
        const far = lowNear ? op.t1 : op.t0;
        const dNear = (near - tLine) * Math.sign(far - tLine);
        if (dNear < -150 || dNear > 450) return false;
        // レールの先（車庫の奥）で壁が終わっていること
        return lowNear ? Math.abs(T1 - op.t1) <= 300 : Math.abs(op.t0 - T0) <= 300;
      });
      if (!rail) continue;
      const lowNear = Math.abs(rail.t0 - tLine) <= Math.abs(rail.t1 - tLine);
      (globalThis as { __closerTrace?: string[] }).__closerTrace?.push(`rail wall (${Math.round(w.a.x)},${Math.round(w.a.y)})-(${Math.round(w.b.x)},${Math.round(w.b.y)}) win ${Math.round(rail.t0)}..${Math.round(rail.t1)} conf=${rail.confidence} gap (${Math.round(c.a.x)},${Math.round(c.a.y)})-(${Math.round(c.b.x)},${Math.round(c.b.y)})`);
      // 残す部分: 出入口の線の側（レールの付け根より外。袖壁の実体があれば残る）
      const keep: [number, number] = lowNear ? [T0, rail.t0] : [rail.t1, T1];
      cut++;
      if (keep[1] - keep[0] < 150) {
        walls.splice(walls.indexOf(w), 1);
        continue;
      }
      // 壁は写してから直す（元の図面の壁はそのまま）
      const nw: WWall = { ...w };
      const P = (t: number) => ({ x: w.u.x * t + w.n.x * w.o, y: w.u.y * t + w.n.y * w.o });
      const aLow = ta <= tb;
      if (lowNear) {
        // 上側（t の大きい側）を切る
        if (aLow) {
          nw.b = P(keep[1]);
          nw.joinedB = true;
        } else {
          nw.a = P(keep[1]);
          nw.joinedA = true;
        }
        nw.t1 = Math.min(w.t1, keep[1]);
      } else {
        if (aLow) {
          nw.a = P(keep[0]);
          nw.joinedA = true;
        } else {
          nw.b = P(keep[0]);
          nw.joinedB = true;
        }
        nw.t0 = Math.max(w.t0, keep[0]);
      }
      nw.openings = w.openings.filter((op) => op !== rail && op.t0 >= keep[0] - 1 && op.t1 <= keep[1] + 1);
      delete nw.weak;
      walls[walls.indexOf(w)] = nw;
    }
  }
  return cut;
}

/**
 * 壁の一部の区間（壁に沿った位置 t の範囲）を切り取り、残りを別々の壁にする。切り取った区間に掛かる開口は捨てる。
 * 柱 1 本ぶんにも満たない端（80 mm 未満）は残さない
 */
export function cutWallSpans(walls: WWall[], w: WWall, spans: [number, number][]): void {
  const idx = walls.indexOf(w);
  if (idx < 0 || !spans.length) return;
  const P = (t: number): Vec2 => ({ x: w.u.x * t + w.n.x * w.o, y: w.u.y * t + w.n.y * w.o });
  const sorted = spans.map(([a, b]) => [Math.max(w.t0, Math.min(a, b)), Math.min(w.t1, Math.max(a, b))] as [number, number]).sort((p, q) => p[0] - q[0]);
  const keep: [number, number][] = [];
  let cur = w.t0;
  for (const [a, b] of sorted) {
    if (a - cur >= 80) keep.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (w.t1 - cur >= 80) keep.push([cur, w.t1]);
  const aLow = w.a.x * w.u.x + w.a.y * w.u.y <= w.b.x * w.u.x + w.b.y * w.u.y;
  const parts: WWall[] = keep.map(([lo, hi]) => {
    const nw: WWall = { ...w, t0: lo, t1: hi, openings: w.openings.filter((op) => op.t0 >= lo - 1 && op.t1 <= hi + 1) };
    const cutLo = lo > w.t0 + 1;
    const cutHi = hi < w.t1 - 1;
    const pLo = cutLo ? P(lo) : aLow ? w.a : w.b;
    const pHi = cutHi ? P(hi) : aLow ? w.b : w.a;
    if (aLow) {
      nw.a = pLo;
      nw.b = pHi;
      if (cutLo) nw.joinedA = false;
      if (cutHi) nw.joinedB = false;
    } else {
      nw.b = pLo;
      nw.a = pHi;
      if (cutLo) nw.joinedB = false;
      if (cutHi) nw.joinedA = false;
    }
    delete nw.weak;
    return nw;
  });
  walls.splice(idx, 1, ...parts);
}

/** 1つの図面（階）から部屋・外形などを作る */
export interface FloorHints {
  /** この点を含む区画は中庭（上階の床が無く、ガラス戸に囲まれた室名の無い区画） */
  courtyards?: Vec2[];
  /** 平屋と分かっている（面積表の 2 階が 0、または「平屋」の表記）。階段の文字が無ければ階段を探さない */
  singleStorey?: boolean;
  /** この点を含む区画は家の外（手で外構・後付け／離れのガレージにした区画）。外形に入れない */
  outdoorAt?: Vec2[];
  /** 戸・シャッター・玄関ドアの「常識の補い」をしない（方眼で直したものを作り直すとき。消した戸・シャッターが戻らないように） */
  noAutoOpenings?: boolean;
}

/** 2 つの部屋が壁を挟んで隣り合うか（壁芯の外形どうしが 300mm 以上重なる辺を持つ） */
function polysAdjacent(pa: Vec2[], pb: Vec2[], tol = 90, minOverlap = 300): boolean {
  for (let i = 0; i < pa.length; i++) {
    const a0 = pa[i];
    const a1 = pa[(i + 1) % pa.length];
    const L = Math.hypot(a1.x - a0.x, a1.y - a0.y);
    if (L < minOverlap) continue;
    const ux = (a1.x - a0.x) / L;
    const uy = (a1.y - a0.y) / L;
    for (let j = 0; j < pb.length; j++) {
      const b0 = pb[j];
      const b1 = pb[(j + 1) % pb.length];
      // 平行で、同じ直線上（法線方向の差が tol 以内）
      const d0 = Math.abs((b0.x - a0.x) * -uy + (b0.y - a0.y) * ux);
      const d1 = Math.abs((b1.x - a0.x) * -uy + (b1.y - a0.y) * ux);
      if (d0 > tol || d1 > tol) continue;
      const t0 = (b0.x - a0.x) * ux + (b0.y - a0.y) * uy;
      const t1 = (b1.x - a0.x) * ux + (b1.y - a0.y) * uy;
      const ov = Math.min(L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
      if (ov >= minOverlap) return true;
    }
  }
  return false;
}

/** 同じ線（平面の線と周囲の線で重複したもの）を 1 本にする */
function uniqueSegs(segs: Seg[]): Seg[] {
  const seen = new Set<string>();
  const out: Seg[] = [];
  for (const s of segs) {
    const k = `${Math.round(s.a.x)},${Math.round(s.a.y)},${Math.round(s.b.x)},${Math.round(s.b.y)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * 曲線の壁（R 壁）: 壁色の塗りのうち、細長い帯（両端の短辺 ≈ 壁厚、長辺は多くの短い辺で曲がる）を、
 * 中心線に沿った短い壁の連なりにする。直線の帯は線の検出で拾えているので、曲がっているもの（向きの変化の合計 12° 以上）だけ。
 * 林様邸の階段ヌックの R 壁・2 階の吹抜の曲面壁のような、ARCHITREND の塗りの R 壁に対応する
 */
/**
 * 帯状の塗り（R 壁）を、両端の「蓋」で区切った 2 本の縁（片方は逆順にして同じ向き）に分ける。
 *  1. 鋭く曲がる頂点（50° 以上）を近いもの同士でまとめ、ちょうど 2 か所（両端の蓋）に分かれれば、その間の 2 本が縁
 *     （蓋の脇に小さな段差や、まっすぐな壁への継ぎ足しがあっても分けられる。堀様邸の玄関の R 壁）
 *  2. だめなら、いちばん長い 2 辺を蓋とみなす（蓋以外の辺がすべて短い、平坦化した曲線の帯。林様邸）
 */
function bandChains(poly: Vec2[], E: number[]): [Vec2[], Vec2[]] | null {
  const n = poly.length;
  const turnAt = (i: number) => {
    const a = poly[(i - 1 + n) % n];
    const b = poly[i];
    const c = poly[(i + 1) % n];
    const t1 = Math.atan2(b.y - a.y, b.x - a.x);
    const t2 = Math.atan2(c.y - b.y, c.x - b.x);
    let d = Math.abs(t2 - t1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  };
  const split = (i1: number, i2: number): [Vec2[], Vec2[]] | null => {
    // i1 → i2（前向き）と i2 → i1（前向き）の 2 本。どちらも 3 点以上
    const A: Vec2[] = [];
    for (let k = i1; k !== i2; k = (k + 1) % n) A.push(poly[k]);
    A.push(poly[i2]);
    const B: Vec2[] = [];
    for (let k = i2; k !== i1; k = (k + 1) % n) B.push(poly[k]);
    B.push(poly[i1]);
    if (A.length < 3 || B.length < 3) return null;
    B.reverse();
    return [A, B];
  };
  // 1. 鋭い角のまとまり
  const sharp = poly.map((_, i) => turnAt(i) > (50 * Math.PI) / 180);
  if (sharp.some(Boolean)) {
    const start = sharp.findIndex((v) => !v);
    if (start >= 0) {
      const runs: number[][] = [];
      let cur: number[] | null = null;
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n;
        // 鋭い角どうしが 250mm 以内に続けば同じ蓋
        if (sharp[i]) {
          if (cur && Math.hypot(poly[i].x - poly[cur[cur.length - 1]].x, poly[i].y - poly[cur[cur.length - 1]].y) < 250) cur.push(i);
          else {
            cur = [i];
            runs.push(cur);
          }
        } else if (cur && E[(i - 1 + n) % n] > 40) cur = null;
      }
      if (runs.length === 2) {
        const r = split(runs[0][runs[0].length - 1], runs[1][0]);
        const r2 = split(runs[1][runs[1].length - 1], runs[0][0]);
        if (r && r2) return [r[0], r2[0].slice().reverse()];
      }
    }
  }
  // 2. いちばん長い 2 辺が蓋
  const order = E.map((l, i) => ({ l, i })).sort((a, b) => b.l - a.l);
  const [c1, c2] = order;
  if (!c1 || !c2) return null;
  if (c1.l < 60 || c1.l > 320 || c2.l < 60 || c2.l > 320) return null;
  if (order[2] && order[2].l > 160) return null;
  const gap = Math.abs(c1.i - c2.i);
  if (gap < 3 || n - gap < 3) return null;
  const i1 = Math.min(c1.i, c2.i);
  const i2 = Math.max(c1.i, c2.i);
  return split((i1 + 1) % n, i2);
}

function curvedWallsFromFills(polys: Vec2[][], existing: WWall[]): WWall[] {
  const out: WWall[] = [];
  let idx = 0;
  const lenOf = (c: Vec2[]) => c.reduce((s, p, i) => (i ? s + Math.hypot(p.x - c[i - 1].x, p.y - c[i - 1].y) : 0), 0);
  const at = (c: Vec2[], L: number, t: number): Vec2 => {
    let d = t * L;
    for (let i = 1; i < c.length; i++) {
      const s = Math.hypot(c[i].x - c[i - 1].x, c[i].y - c[i - 1].y);
      if (d <= s || i === c.length - 1) {
        const f = s ? Math.max(0, Math.min(1, d / s)) : 0;
        return { x: c[i - 1].x + (c[i].x - c[i - 1].x) * f, y: c[i - 1].y + (c[i].y - c[i - 1].y) * f };
      }
      d -= s;
    }
    return c[c.length - 1];
  };
  for (const poly of polys) {
    const n = poly.length;
    if (n < 12 || n > 400) continue;
    const E = poly.map((p, i) => {
      const q = poly[(i + 1) % n];
      return Math.hypot(q.x - p.x, q.y - p.y);
    });
    const chains = bandChains(poly, E);
    if (!chains) continue;
    const [chainA, chainB] = chains;
    const LA = lenOf(chainA);
    const LB = lenOf(chainB);
    if (LA < 300 || LB < 300 || LA / LB > 2.2 || LB / LA > 2.2) continue;
    const K = Math.max(3, Math.round(Math.max(LA, LB) / 120));
    const center: Vec2[] = [];
    let thick = 0;
    for (let k = 0; k <= K; k++) {
      const t = k / K;
      const a = at(chainA, LA, t);
      const b = at(chainB, LB, t);
      center.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      thick += Math.hypot(a.x - b.x, a.y - b.y);
    }
    thick /= K + 1;
    if (thick < 60 || thick > 320) continue;
    let turn = 0;
    for (let k = 1; k + 1 < center.length; k++) {
      const a = Math.atan2(center[k].y - center[k - 1].y, center[k].x - center[k - 1].x);
      const b = Math.atan2(center[k + 1].y - center[k].y, center[k + 1].x - center[k].x);
      let d = Math.abs(b - a);
      if (d > Math.PI) d = 2 * Math.PI - d;
      turn += d;
    }
    if (turn < (12 * Math.PI) / 180) continue;
    // 既存の壁と重なるもの（中心線の半分以上が既存の壁の帯の中）は除く
    const covered = center.filter((p) => existing.some((w) => distPointSegment(p, w.a, w.b) < w.d / 2 + 30)).length;
    if (covered > center.length * 0.5) continue;
    const d = Math.round(thick);
    for (let k = 0; k + 1 < center.length; k++) {
      const a = center[k];
      const b = center[k + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 10) continue;
      const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      // g は壁ごとに固有の負の値（同じ軸の仲間として扱われないように）
      out.push({ a, b, u, n: { x: -u.y, y: u.x }, d, t0: 0, t1: L, o: 0, g: -(1000 + idx), openings: [], joinedA: k > 0, joinedB: k + 2 < center.length });
      idx++;
    }
  }
  return out;
}

export function buildFloor(plan: PlanData, level: number, northAngleDeg: number, warnings: string[], expectedArea?: number, hints?: FloorHints): Floor {
  const curved = curvedWallsFromFills(plan.wallPolys, plan.walls);
  // 図面の壁の配列は写して使う（車庫のレール外し・弱い壁の除去で図面のデータを書き換えないように。同じ図面から階を組み立て直すことがある）
  const walls = [...plan.walls, ...curved];
  if (curved.length) (globalThis as { __curvedTrace?: number[] }).__curvedTrace = [...((globalThis as { __curvedTrace?: number[] }).__curvedTrace ?? []), curved.length];
  // 通り口の印（ARCHITREND の提案図: 人が通る建具に付く、両端に丸の付いた短い線。passMarks.ts）
  const passMarks = plan.scan || plan.loose || (globalThis as { __NO_PASS_MARKS?: boolean }).__NO_PASS_MARKS ? [] : detectPassMarks(plan.segs, plan.arcs);
  /** 印を使う図面か（4 個以上あれば、印の有無を建具の判断に使う） */
  const usesMarks = passMarks.length >= 4;
  const wallPoint = (w: WWall, t: number): Vec2 => ({ x: w.u.x * t + w.n.x * w.o, y: w.u.y * t + w.n.y * w.o });
  const opMarked = (w: WWall, op: { t0: number; t1: number }) => marksCrossing(passMarks, wallPoint(w, op.t0), wallPoint(w, op.t1), 0, op.t1 - op.t0) > 0;
  /**
   * 印の無い「弱い開口」: 壁の切れ目に細い線が通っているだけ（確信度 0.7 以下）で、印が横切らないもの。
   * 室内なら建具ではなく、棚・ハンガーパイプ・浴槽の縁・上がり框・手すりの線（外壁なら、通れない窓）
   */
  const unmarkedOps: { w: WWall; op: DetectedOpening }[] = [];
  if (usesMarks) for (const w of walls) for (const op of w.openings) if (op.kind === 'window' && op.confidence <= 0.7 && !opMarked(w, op)) unmarkedOps.push({ w, op });
  const unmarkedSet = new Set(unmarkedOps.map((x) => x.op));
  (globalThis as { __markTrace?: string[] }).__markTrace?.push(`L${level} marks=${passMarks.length} unmarked=${unmarkedOps.map((x) => Math.round(x.op.t1 - x.op.t0)).join('/')}`);
  const res = 20;
  const grid = Grid.around(plan.bbox.minX, plan.bbox.minY, plan.bbox.maxX, plan.bbox.maxY, res, 1200);
  // 家具・車の記号（実線のまとまり・破線の輪郭）。車庫の出入口を塞ぐ判定にも使うので先に読む
  const segsU = plan.scan || plan.loose ? [] : uniqueSegs([...plan.segs, ...plan.siteSegs]);
  const dashed = segsU.length ? dashedOutlines(segsU) : [];
  const solidSymbols = segsU.length ? detectSymbols(segsU) : [];
  const symbols = [...solidSymbols, ...dashedCarSymbols(dashed, solidSymbols)];
  if ((globalThis as any).__DBG_PLANS) {
    ((globalThis as any).__DBG_SYMBOLS ??= []).push({ level, symbols });
    ((globalThis as any).__DBG_SEGSU ??= []).push({ level, segs: segsU });
    ((globalThis as any).__DBG_WOPS ??= []).push({ level, walls: walls.map((w) => ({ a: w.a, b: w.b, d: w.d, weak: !!w.weak, ops: w.openings.map((op) => ({ a: wallPoint(w, op.t0), b: wallPoint(w, op.t1), kind: op.kind, conf: op.confidence, unmarked: unmarkedSet.has(op), marked: opMarked(w, op) })) })) });
  }
  // オーバースライダー（ガレージのドア）のレールを壁から外す（車庫の室名か車の記号が近くにある出入口だけ）
  if (!plan.scan && !plan.loose) {
    const marks: Vec2[] = [
      ...plan.texts.filter((t) => {
        const nm = cleanRoomName(t.str);
        return nm != null && classifyRoomName(nm) === 'garage';
      }),
      ...symbols.filter((sy) => sy.kind === 'car'),
    ].map((t) => ({ x: t.x, y: t.y }));
    if (marks.length) {
      const n = cutGarageRails(walls, (a, b) => marks.some((t) => distPointSegment(t, a, b) <= 4500));
      if (n) (globalThis as { __closerTrace?: string[] }).__closerTrace?.push(`rails ${n}`);
    }
  }
  // 手すりが細い線だけで描かれたバルコニー（2 階以上）: 室名が屋外にあるとき、細い線と壁で囲まれた範囲の縁に手すり壁を補う。
  // 壁として足しておけば、あとは壁で囲まれたバルコニーと同じ流れで部屋・外壁・3D の手すりになる（balconyRails.ts）
  if (level >= 2 && segsU.length && !(globalThis as { __NO_BALCONY_RAILS?: boolean }).__NO_BALCONY_RAILS) {
    const near = (p: Vec2, m: number) => p.x > plan.bbox.minX - m && p.x < plan.bbox.maxX + m && p.y > plan.bbox.minY - m && p.y < plan.bbox.maxY + m;
    const seen = new Set<string>();
    const balLabels: Vec2[] = [];
    for (const t of [...plan.texts, ...plan.siteTexts]) {
      if (!near(t, 2000)) continue;
      const nm = cleanRoomName(t.str);
      const ty = nm ? classifyRoomName(nm) : null;
      if (!nm || !(ty === 'balcony' || ty === 'deck' || ty === 'terrace') || /庭|COURT/i.test(nm)) continue;
      const key = `${Math.round(t.x)},${Math.round(t.y)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      balLabels.push({ x: t.x, y: t.y });
    }
    if (balLabels.length) {
      const found = findBalconyRails({
        bbox: plan.bbox,
        labels: balLabels,
        walls,
        wallPolys: [...plan.wallPolys, ...plan.sashPolys],
        closers: collinearGaps(walls, 4600),
        lines: segsU.filter((sg) => sg.source === 'stroke' && !sg.dashed && near(sg.a, 2600) && near(sg.b, 2600)),
      });
      let k = 0;
      for (const f of found)
        for (const r of f.rails) {
          const L = Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y);
          const u = { x: (r.b.x - r.a.x) / L, y: (r.b.y - r.a.y) / L };
          const n = { x: -u.y, y: u.x };
          // g は壁ごとに固有の負の値（同じ軸の仲間として扱われないように）
          walls.push({ a: r.a, b: r.b, u, n, d: r.d, t0: r.a.x * u.x + r.a.y * u.y, t1: r.b.x * u.x + r.b.y * u.y, o: r.a.x * n.x + r.a.y * n.y, g: -(3000 + k++), openings: [], joinedA: true, joinedB: true });
        }
      (globalThis as { __railTrace?: string[] }).__railTrace?.push(...found.map((f) => `L${level} バルコニー ${f.area.toFixed(2)}㎡ 手すり ${f.rails.map((r) => `${Math.round(r.a.x)},${Math.round(r.a.y)}-${Math.round(r.b.x)},${Math.round(r.b.y)} d${r.d}`).join(' / ')}`));
    }
  }
  // 部屋の区切り: 壁・壁の塗り・窓の白抜き・吹抜（×印の四角）の輪郭
  const voidRects = voidRectangles(plan, level);
  const drawBarriers = () => {
    for (const w of walls) grid.fillThickSegment(w.a, w.b, w.d, WALL);
    for (const poly of plan.wallPolys) grid.fillPolygon(poly, WALL);
    for (const poly of plan.sashPolys) grid.fillPolygon(poly, WALL);
    for (const r of voidRects) {
      const c = [
        { x: r.minX, y: r.minY },
        { x: r.maxX, y: r.minY },
        { x: r.maxX, y: r.maxY },
        { x: r.minX, y: r.maxY },
      ];
      for (let i = 0; i < 4; i++) grid.fillThickSegment(c[i], c[(i + 1) % 4], 40, WALL);
    }
  };
  drawBarriers();
  // 部屋の区切り: 同じ直線上の壁と壁の間の 2m 以下の切れ目（戸・出入口）も区切る。
  // 収納の折れ戸・引戸が細い線だけで描かれていても、部屋と収納が分かれる
  for (const c of collinearGaps(walls, 2000)) grid.fillThickSegment(c.a, c.b, Math.min(c.d, 60), WALL);
  // 内外の判定では、同じ直線上の壁と壁の間（窓・出入口。記号が読めなかったものも含む）を塞いでおく。
  // 角の窓や、記号の描き方が違う窓から部屋が「外」に漏れるのを防ぐ
  const GAP = 3;
  // 手描き風の図面は線が揺れているので、同じ直線とみなす幅を広げ、全面ガラスの長い開口も塞ぐ
  const closers = plan.loose ? collinearGaps(walls, 6500, 90) : collinearGaps(walls, 4600);
  for (const c of closers) grid.fillThickSegment(c.a, c.b, c.d, GAP);
  // 4.6m を超える切れ目でも、その線上に細線（シャッター・全面ガラス・カーポートの縁）が引いてあれば塞ぐ。
  // 車庫の出入口（〜6.5m）は薄い壁として区画も分ける（車庫が外に漏れて消えないように）
  if (!plan.loose && !(globalThis as { __noLongClosers?: boolean }).__noLongClosers) {
    const thin = plan.segs.filter((sg) => sg.source === 'stroke' && !sg.dashed);
    /** 線分 a-b の上（±60mm）にある細線が、その長さの何割を覆うか */
    const thinCoverage = (a: Vec2, b: Vec2, tol = 250): number => {
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L <= 0) return 0;
      const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      const nrm = { x: -u.y, y: u.x };
      const iv: [number, number][] = [];
      for (const sg of thin) {
        // シャッターの一点鎖線は壁の線から少し内側に描かれるので、±25cm まで見る（短い線の断片は数えない）
        if (Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y) < 200) continue;
        const oa = (sg.a.x - a.x) * nrm.x + (sg.a.y - a.y) * nrm.y;
        const ob = (sg.b.x - a.x) * nrm.x + (sg.b.y - a.y) * nrm.y;
        if (Math.abs(oa) > tol || Math.abs(ob) > tol || Math.abs(oa - ob) > 60) continue;
        const ta = (sg.a.x - a.x) * u.x + (sg.a.y - a.y) * u.y;
        const tb = (sg.b.x - a.x) * u.x + (sg.b.y - a.y) * u.y;
        const s0 = Math.max(0, Math.min(ta, tb));
        const s1 = Math.min(L, Math.max(ta, tb));
        if (s1 > s0) iv.push([s0, s1]);
      }
      iv.sort((p, q) => p[0] - q[0]);
      let covered = 0;
      let cur: [number, number] | null = null;
      for (const v of iv) {
        if (cur && v[0] <= cur[1]) cur[1] = Math.max(cur[1], v[1]);
        else {
          if (cur) covered += cur[1] - cur[0];
          cur = [v[0], v[1]];
        }
      }
      if (cur) covered += cur[1] - cur[0];
      return covered / L;
    };
    const closeWithLine = (a: Vec2, b: Vec2, d: number) => {
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      grid.fillThickSegment(a, b, L <= 6500 ? 60 : d, L <= 6500 ? WALL : GAP);
    };
    // 車庫・カーポートの出入口だけが対象（バルコニーや中庭の開口を塞がないように、車庫の室名が近くにある線だけ）
    const garageLabels = plan.texts.filter((t) => {
      const nm = cleanRoomName(t.str);
      return nm != null && classifyRoomName(nm) === 'garage';
    });
    // 車庫の室名、または車の記号が線の近く（4.5m 以内）にあること
    const carMarks = symbols.filter((sy) => sy.kind === 'car').map((sy) => ({ x: sy.x, y: sy.y }));
    const nearGarage = (a: Vec2, b: Vec2) => [...garageLabels, ...carMarks].some((t) => distPointSegment({ x: t.x, y: t.y }, a, b) <= 4500);
    /** 線の片側 2.5m 以内に壁が 1 つも無い（出入口は外に向いて開いている。玄関の上がり框の線などは両側に壁がある） */
    const opensOutside = (a: Vec2, b: Vec2): boolean => {
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      const nrm = { x: -u.y, y: u.x };
      for (const sg of [1, -1]) {
        let blocked = false;
        for (const w of walls) {
          for (const q of [w.a, w.b, { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 }]) {
            const t = (q.x - a.x) * u.x + (q.y - a.y) * u.y;
            const o = ((q.x - a.x) * nrm.x + (q.y - a.y) * nrm.y) * sg;
            // 出入口の両端にある壁（側壁がそのまま外へ伸びた袖壁）は「前を塞ぐ壁」ではない
            if (t > 300 && t < L - 300 && o > 150 && o < 2500) blocked = true;
          }
          if (blocked) break;
        }
        if (!blocked) return true;
      }
      return false;
    };
    for (const c of collinearGaps(walls, 6500)) {
      const L = Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y);
      if (L <= 4600 || !nearGarage(c.a, c.b) || !opensOutside(c.a, c.b)) continue;
      if (thinCoverage(c.a, c.b) < 0.6) continue;
      (globalThis as { __closerTrace?: string[] }).__closerTrace?.push(`collinear ${Math.round(c.a.x)},${Math.round(c.a.y)}-${Math.round(c.b.x)},${Math.round(c.b.y)} L=${Math.round(L)}`);
      closeWithLine(c.a, c.b, c.d);
    }
    // 平行な 2 枚の壁の端が向かい合っていて（車庫の両側の壁など）、端と端を結ぶ線上に細線が引いてあれば塞ぐ
    const ends: { p: Vec2; w: WWall }[] = [];
    for (const w of walls) {
      if (!w.joinedA) ends.push({ p: w.a, w });
      if (!w.joinedB) ends.push({ p: w.b, w });
    }
    for (let i = 0; i < ends.length; i++)
      for (let j = i + 1; j < ends.length; j++) {
        const e = ends[i];
        const f = ends[j];
        if (e.w === f.w) continue;
        const dx = f.p.x - e.p.x;
        const dy = f.p.y - e.p.y;
        const L = Math.hypot(dx, dy);
        const parallel = Math.abs(e.w.u.x * f.w.u.x + e.w.u.y * f.w.u.y) >= 0.98;
        if (parallel) {
          // 車庫の出入口 1 ヵ所ぶん（2.4〜6.5m。短い線は玄関の上がり框などを拾う。長い線は敷地の線を拾って外を部屋にしてしまう）
          if (L < 2400 || L > 6500) continue;
          // 結ぶ線は壁と直交（壁の向きに沿う成分が小さい）
          if (Math.abs(dx * e.w.u.x + dy * e.w.u.y) > 60) continue;
        } else {
          // 袖壁の端から、直交する側壁の端まで（2 台用シャッター・後付けガレージの間口は 7.5m まで）。
          // 結ぶ線は片方の壁の延長上（袖壁をそのまま伸ばした線）にあること
          if (L < 2400 || L > 7500) continue;
          // 伸ばすのは壁の端から外へ。壁の本体の上を戻っていく線は「延長」ではない
          // （吉田大仁様邸 1st-2: 袖壁の外の端から車庫の中へ 5m 戻る線が引かれ、車庫の南の帯が別の区画になっていた）
          const outward = (w: WWall, end: Vec2, other: Vec2) => {
            const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
            return (other.x - end.x) * (end.x - mid.x) + (other.y - end.y) * (end.y - mid.y) > 0;
          };
          const along = (w: WWall, end: Vec2, other: Vec2) => Math.abs(dx * w.u.x + dy * w.u.y) >= L - 60 && outward(w, end, other);
          if (!along(e.w, e.p, f.p) && !along(f.w, f.p, e.p)) continue;
        }
        if (!nearGarage(e.p, f.p) || !opensOutside(e.p, f.p) || thinCoverage(e.p, f.p) < 0.6) continue;
        (globalThis as { __closerTrace?: string[] }).__closerTrace?.push(`ends ${Math.round(e.p.x)},${Math.round(e.p.y)}-${Math.round(f.p.x)},${Math.round(f.p.y)} L=${Math.round(L)}`);
        closeWithLine(e.p, f.p, Math.max(e.w.d, f.w.d));
      }
  }
  // 画像から読んだ図面: 他の壁につながっていない壁の端どうしが近い（70cm 以内）場合は、内外の判定用に仮につなぐ
  if (plan.loose) {
    const ends: { p: Vec2; w: WWall }[] = [];
    for (const w of walls) {
      if (!w.joinedA) ends.push({ p: w.a, w });
      if (!w.joinedB) ends.push({ p: w.b, w });
    }
    for (const e of ends) {
      let best: { p: Vec2; d: number } | null = null;
      for (const f of ends) {
        if (f.w === e.w) continue;
        const d = Math.hypot(f.p.x - e.p.x, f.p.y - e.p.y);
        if (d <= 700 && (!best || d < best.d)) best = { p: f.p, d };
      }
      if (best) grid.fillThickSegment(e.p, best.p, Math.max(60, e.w.d), GAP);
    }
  }
  // 手描き風の図面: 窓・ガラス戸の線（太線）も内外の判定だけに使う
  if (plan.sketchLines) for (const sg of plan.sketchLines) grid.fillThickSegment(sg.a, sg.b, 40, GAP);
  drawBarriers();
  grid.floodOutside();
  /** 内外判定のために塞いだ切れ目（ポーチなど、屋外に開いた区画の判定に使う） */
  const gapMask = new Uint8Array(grid.data.length);
  for (let i = 0; i < grid.data.length; i++)
    if (grid.data[i] === GAP) {
      grid.data[i] = FREE;
      gapMask[i] = 1;
    }
  // 室名の入った色塗り（カラー平面図）の輪郭: 内外の判定の後、建物の内側でだけ部屋の区切りにする
  const fillCells: number[] = [];
  // 弱い壁（柱と柱の間の「窓」だけの壁）も同じ扱い: 室名の無い断片を作っているだけなら、下で隣の部屋に戻す
  // 印（通り口の印）が横切る壁は本物の建具なので、弱い壁として外さない
  const weakWalls = walls.filter((w) => w.weak && !(usesMarks && w.openings.some((op) => opMarked(w, op))));
  const weakCells = new Set<number>();
  if (weakWalls.length) {
    const tmp = new Grid(grid.w, grid.h, grid.res, grid.ox, grid.oy);
    for (const w of weakWalls) tmp.fillThickSegment(w.a, w.b, w.d, WALL);
    for (let i = 0; i < tmp.data.length; i++)
      if (tmp.data[i] === WALL && grid.data[i] === WALL) {
        fillCells.push(i);
        weakCells.add(i);
      }
  }
  /** 弱い壁（壁ごと）の升。印の無い弱い開口の升は unmarkedCellOp（両方に入る升もある） */
  const weakWallCells = new Set(weakCells);
  // 印の無い弱い開口の区間も「戻せる区切り」に入れる（升 → どの開口か）
  const unmarkedCellOp = new Map<number, number>();
  if (unmarkedOps.length) {
    const tmp = new Grid(grid.w, grid.h, grid.res, grid.ox, grid.oy);
    unmarkedOps.slice(0, 250).forEach((uo, k) => tmp.fillThickSegment(wallPoint(uo.w, uo.op.t0), wallPoint(uo.w, uo.op.t1), uo.w.d, k + 2));
    for (let i = 0; i < tmp.data.length; i++)
      if (tmp.data[i] >= 2 && grid.data[i] === WALL) {
        if (!weakCells.has(i)) fillCells.push(i);
        weakCells.add(i);
        unmarkedCellOp.set(i, tmp.data[i] - 2);
      }
  }
  if (plan.roomFills.length && !(globalThis as { __NO_ROOM_FILLS?: boolean }).__NO_ROOM_FILLS) {
    const tmp = new Grid(grid.w, grid.h, grid.res, grid.ox, grid.oy);
    for (const poly of plan.roomFills) for (let i = 0; i < poly.length; i++) tmp.fillThickSegment(poly[i], poly[(i + 1) % poly.length], 30, WALL);
    for (let i = 0; i < tmp.data.length; i++)
      if (tmp.data[i] === WALL && grid.data[i] === FREE) {
        grid.data[i] = WALL;
        fillCells.push(i);
      }
  }
  if ((globalThis as any).__DBG_STAGE === 1) (globalThis as any).__DBG_GRID?.(grid, plan, level, grid.labelComponents().labels);
  // 1つの区画に別々の部屋の室名が入っている場合は、戸・間仕切りの線で分け直す
  splitMergedRegions(grid, plan);
  if ((globalThis as any).__DBG_STAGE === 2) (globalThis as any).__DBG_GRID?.(grid, plan, level, grid.labelComponents().labels);
  // 色塗りの線で割れて名前の無い断片になった所は、その線を外して隣の部屋に戻す
  if (fillCells.length) {
    const named = plan.texts.filter((t) => {
      const nm = cleanRoomName(t.str);
      return (nm && (classifyRoomName(nm) != null || looksLikeRoomName(nm))) || parseAreaLabel(t.str) != null || parseStairMark(t.str) != null;
    });
    // 隣り合う塗りの境目にできる細い隙間（0.3㎡未満）は区切りの一部として埋める
    {
      const { labels: lb, sizes: sz } = grid.labelComponents();
      const sliverCells = (0.3 * 1e6) / (grid.res * grid.res);
      const touchesFill = new Set<number>();
      for (const i of fillCells) {
        // 印の無い弱い開口のそばの細い断片は、埋めずに下で隣の部屋へ戻す
        if (unmarkedCellOp.has(i)) continue;
        const x = i % grid.w;
        for (const j of [x > 0 ? i - 1 : -1, x < grid.w - 1 ? i + 1 : -1, i - grid.w, i + grid.w]) if (j >= 0 && j < lb.length && lb[j]) touchesFill.add(lb[j]);
      }
      for (let i = 0; i < lb.length; i++) if (lb[i] && sz[lb[i]] < sliverCells && touchesFill.has(lb[i])) grid.data[i] = WALL;
    }
    for (let iter = 0; iter < 3; iter++) {
      const { labels: lb, sizes: szIter } = grid.labelComponents();
      const hasName = new Set<number>();
      for (const t of named) {
        const l = labelNear(grid, lb, t);
        if (l) hasName.add(l);
      }
      // 弱い壁を挟んで戻してよい断片: 文字が 1 つも無く 2㎡ 以上（通路・玄関収納のような小さな室は、室名が壁に掛かって拾えなくても戻さない）
      const hasAnyText = new Set<number>();
      for (const t of plan.texts) {
        const l = labelNear(grid, lb, t);
        if (l) hasAnyText.add(l);
      }
      const weakMergeOk = (u: number) => !hasAnyText.has(u) && (szIter[u] ?? 0) >= (2 * 1e6) / (grid.res * grid.res);
      // 印の無い弱い開口（細い線だけの「引戸」）を挟んで、名前の無い断片 u を隣 v に戻してよいか:
      //  (a) u が奥行 800 mm 以下の細い帯（ハンガーパイプ・棚・壁付けの造作の線と壁の間）
      //  (b) v に帖数が書いてあり、いまは足りず、u を足すと帖数に近づく（オープンクローゼット・パントリーの棚の線）
      //  (c) v が浴室で、ユニットバスとして小さすぎる（浴槽の縁の線で 2 つに割れている）
      // どれでもなければ戻さない（木の描かれた坪庭のような、印の無い窓に囲まれた区画を部屋に混ぜない）
      let unmarkedMergeOk: (u: number, v: number) => boolean = () => false;
      // 名前の無い断片 u を隣 v に戻すと、v が図面の帖数を 6% 以上超えて今より遠ざかるなら戻さない（v は u 抜きで帖数どおり）。
      // 色塗りの境目で分かれた名前の無い通路が、帖数を見ずに隣の FC（2帖）に戻されて 4.6 帖になっていた（伊藤様邸 1 階）
      let overTatami: (u: number, v: number) => boolean = () => false;
      {
        const cellM2 = (grid.res * grid.res) / 1e6;
        const tats = new Map<number, number[]>();
        for (const t of named) {
          const ar = parseAreaLabel(t.str);
          const tat = ar?.tatami ?? (ar?.m2 ? ar.m2 / 1.62 : undefined);
          if (!tat) continue;
          const l = labelNear(grid, lb, t);
          if (l) (tats.get(l) ?? tats.set(l, []).get(l)!).push(tat);
        }
        overTatami = (u, v) => {
          const ts = tats.get(v) ?? [];
          if (ts.length !== 1) return false;
          // 升の面積は壁の厚みぶん小さい（壁芯の面積の 0.93 倍ほど）
          const T = ts[0] * 1.62 * 0.93;
          const au = (szIter[u] ?? 0) * cellM2;
          const av = (szIter[v] ?? 0) * cellM2;
          return av + au > T * 1.06 && Math.abs(av + au - T) > Math.abs(av - T);
        };
      }
      if (unmarkedCellOp.size) {
        const cellM2 = (grid.res * grid.res) / 1e6;
        const box = new Map<number, [number, number, number, number]>();
        for (let i = 0; i < lb.length; i++) {
          const l = lb[i];
          if (!l) continue;
          const x = i % grid.w;
          const y = (i / grid.w) | 0;
          const b = box.get(l);
          if (!b) box.set(l, [x, y, x, y]);
          else {
            if (x < b[0]) b[0] = x;
            if (y < b[1]) b[1] = y;
            if (x > b[2]) b[2] = x;
            if (y > b[3]) b[3] = y;
          }
        }
        const typesIn = new Map<number, Set<RoomType>>();
        const tatamiIn = new Map<number, number[]>();
        for (const t of named) {
          const l = labelNear(grid, lb, t);
          if (!l) continue;
          const nm = cleanRoomName(t.str);
          const ty = nm ? classifyRoomName(nm) : null;
          if (ty) (typesIn.get(l) ?? typesIn.set(l, new Set()).get(l)!).add(ty);
          const ar = parseAreaLabel(t.str);
          const tat = ar?.tatami ?? (ar?.m2 ? ar.m2 / 1.62 : undefined);
          if (tat) (tatamiIn.get(l) ?? tatamiIn.set(l, []).get(l)!).push(tat);
        }
        unmarkedMergeOk = (u, v) => {
          const b = box.get(u);
          if (!b) return false;
          const depth = Math.min(b[2] - b[0] + 1, b[3] - b[1] + 1) * grid.res;
          const au = (szIter[u] ?? 0) * cellM2;
          const av = (szIter[v] ?? 0) * cellM2;
          const tats = tatamiIn.get(v) ?? [];
          // 升の面積は壁の厚みぶん小さい（壁芯の面積の 0.93 倍ほど）
          const T = tats.length === 1 ? tats[0] * 1.62 * 0.93 : null;
          // v の帖数が、u を足すと合わなくなる（6% 超の超過で、今より遠ざかる）なら別の区画（戸の付いた収納など）
          if (T != null && av + au > T * 1.06 && Math.abs(av + au - T) > Math.abs(av - T)) return false;
          if (depth <= 800) return true;
          if (T != null && av < T * 0.97 && av + au <= T * 1.1 && Math.abs(av + au - T) < Math.abs(av - T)) return true;
          const ty = typesIn.get(v);
          if (ty?.has('bath') && ty.size === 1 && av < 1.9 && av + au <= 3.4) return true;
          return false;
        };
      }
      // 塗りの線の両側の区画（線の太さ分だけ離れて見る）
      const sides = (i: number): number[] => {
        const x = i % grid.w;
        const out = new Set<number>();
        // 壁の帯（弱い壁・印の無い開口）は壁厚ぶん（〜120 mm = 6 升）先まで見る。色塗りの線は細いので 3 升
        const reach = weakCells.has(i) ? 6 : 3;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          for (let k = 1; k <= reach; k++) {
            const xx = x + dx * k;
            const j = i + dx * k + dy * k * grid.w;
            if (xx < 0 || xx >= grid.w || j < 0 || j >= lb.length) break;
            if (lb[j]) {
              out.add(lb[j]);
              break;
            }
            if (grid.data[j] !== WALL) break;
          }
        }
        return [...out];
      };
      // 中庭・バルコニー・吹抜など屋外扱いの区画: 弱い壁（中庭のガラス壁のこともある）を挟んでは戻さない
      const outdoorLabels = new Set<number>();
      for (const t of named) {
        const nm = cleanRoomName(t.str);
        const ty = nm ? classifyRoomName(nm) : null;
        if (ty && (OUTDOOR_TYPES.includes(ty) || ty === 'void')) {
          const l = labelNear(grid, lb, t);
          if (l) outdoorLabels.add(l);
        }
      }
      // 名前の無い断片ごとに、塗りの線を挟んで接する長さが最も長い隣の区画を選ぶ
      const contact = new Map<number, Map<number, number>>();
      const cellSides = new Map<number, number[]>();
      for (const i of fillCells) {
        if (grid.data[i] !== WALL) continue;
        const sd = sides(i);
        if (sd.length !== 2) continue;
        if (weakCells.has(i) && (outdoorLabels.has(sd[0]) || outdoorLabels.has(sd[1]))) continue;
        cellSides.set(i, sd);
        for (const [u, v] of [sd, [sd[1], sd[0]]]) {
          if (hasName.has(u)) continue;
          if (weakCells.has(i) && !(unmarkedCellOp.has(i) && unmarkedMergeOk(u, v)) && !(weakWallCells.has(i) && weakMergeOk(u))) continue;
          if (!weakCells.has(i) && overTatami(u, v)) continue;
          const m = contact.get(u) ?? new Map<number, number>();
          m.set(v, (m.get(v) ?? 0) + 1);
          contact.set(u, m);
        }
      }
      const mergeTo = new Map<number, number>();
      // 車庫の塗りに接する大きな名前の無い断片（アプローチ・庭）は車庫に戻さない
      const garageLabels = new Set<number>();
      for (const t of named) {
        const nm = cleanRoomName(t.str);
        if (nm && classifyRoomName(nm) === 'garage') {
          const l = labelNear(grid, lb, t);
          if (l) garageLabels.add(l);
        }
      }
      const { sizes: szNow } = grid.labelComponents();
      const bigCells = (12 * 1e6) / (grid.res * grid.res);
      for (const [u, m] of contact) {
        const order = [...m.entries()].sort((a, b) => b[1] - a[1]);
        const pick = order.find(([v]) => !(garageLabels.has(v) && (szNow[u] ?? 0) >= bigCells));
        if (pick) mergeTo.set(u, pick[0]);
      }
      let changedAny = false;
      for (const [i, sd] of cellSides) {
        const [u, v] = sd;
        if (mergeTo.get(u) === v || mergeTo.get(v) === u) {
          grid.data[i] = FREE;
          changedAny = true;
        }
      }
      if (!changedAny) break;
    }
  }
  // 部屋に戻した弱い壁（真ん中の升が通れるようになったもの）は、壁・建具ごと無かったことにする
  for (const w of weakWalls) {
    const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
    const [cx, cy] = grid.cellOf(mid);
    if (grid.get(cx, cy) !== FREE) continue;
    const k = walls.indexOf(w);
    if (k >= 0) walls.splice(k, 1);
    warnings.push(`${level}階: 柱と柱の間の線を引戸と読んでいた壁（${Math.round(Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)).toLocaleString()}mm）を外しました（家具の縁）`);
  }
  // 部屋に戻した「印の無い弱い開口」: その区間を壁から切り取る（残りの壁・建具はそのまま）
  if (unmarkedOps.length) {
    const cuts = new Map<WWall, DetectedOpening[]>();
    for (const { w, op } of unmarkedOps) {
      if (!walls.includes(w)) continue;
      // 区間に沿って見て、半分以上が通れるようになっていたら戻したとみなす（真ん中は直交する壁が横切っていることがある）
      let free = 0;
      const N = 11;
      for (let k = 0; k < N; k++) {
        const [cx, cy] = grid.cellOf(wallPoint(w, op.t0 + ((op.t1 - op.t0) * (k + 0.5)) / N));
        if (grid.get(cx, cy) === FREE) free++;
      }
      if (free < N / 2) continue;
      (cuts.get(w) ?? cuts.set(w, []).get(w)!).push(op);
    }
    for (const [w, ops] of cuts) {
      cutWallSpans(walls, w, ops.map((op) => [op.t0, op.t1] as [number, number]));
      for (const op of ops) warnings.push(`${level}階: 細い線だけの「引戸」（${Math.round(op.t1 - op.t0).toLocaleString()}mm）は通り口の印が無いので、棚・パイプなどの線として外しました`);
    }
  }
  const { labels, sizes } = grid.labelComponents();
  (globalThis as any).__DBG_GRID?.(grid, plan, level, labels);

  // ---- 文字の割り当て ----
  interface RoomAcc {
    id: number;
    names: { str: string; type: RoomType; size: number; x: number; y: number }[];
    /** 辞書に無いが室名らしい文字（「美容院区画」「バックヤード」など） */
    others: { str: string; size: number; x: number; y: number }[];
    areas: { tatami: number; x: number; y: number }[];
    tatami?: number;
    stair?: 'up' | 'down';
    textPos?: Vec2;
  }
  const acc = new Map<number, RoomAcc>();
  const labelAt = (p: Vec2): number => {
    const near = labelNear(grid, labels, p);
    if (near) return near;
    const [cx, cy] = grid.cellOf(p);
    for (let r = 0; r <= 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) continue;
          const l = labels[y * grid.w + x];
          if (l) return l;
        }
      }
    }
    return 0;
  };
  /** 文字を区画に割り当てる（only を渡すと、その区画に入る文字だけをやり直す: 階段を別の区画に分けた後） */
  const collectTexts = (only?: Set<number>) => {
    if (only) for (const l of only) acc.delete(l);
    for (const t of plan.texts) {
      const l = labelAt({ x: t.x, y: t.y });
      if (!l || (only && !only.has(l))) continue;
      if (!acc.has(l)) acc.set(l, { id: l, names: [], others: [], areas: [] });
      const a = acc.get(l)!;
      const area = parseAreaLabel(t.str);
      const tatami = area?.tatami ?? (area?.m2 ? area.m2 / 1.62 : undefined);
      if (tatami) a.areas.push({ tatami, x: t.x, y: t.y });
      // 矢印だけ（↑↓）は階段の印とは限らない: バルコニーの水勾配の矢印で、室名の無いバルコニーが「階段」になっていた（市岡様邸 3 階）。
      // UP・DN の文字だけを区画の名前の根拠にする（本物の階段は、段の線から読んだ範囲で後から「階段」になる）
      const st = /^[↑↓]$/.test(t.str.trim()) ? null : parseStairMark(t.str);
      if (st) a.stair = st;
      const nm = cleanRoomName(t.str);
      const type = nm ? classifyRoomName(nm) : null;
      if (type) a.names.push({ str: nm!, type, size: t.size, x: t.x, y: t.y });
      else if (nm && !area && !st && looksLikeRoomName(nm)) a.others.push({ str: nm, size: t.size, x: t.x, y: t.y });
    }
    // 帖数は、室名に最も近い表記を採用（1つの領域に複数の部屋が入った場合）
    for (const a of acc.values()) {
      if (!a.areas.length || (only && !only.has(a.id))) continue;
      const ref = mainName(a.names) ?? a.others[0];
      const near = ref ? a.areas.slice().sort((p, q) => Math.hypot(p.x - ref.x, p.y - ref.y) - Math.hypot(q.x - ref.x, q.y - ref.y))[0] : a.areas[0];
      a.tatami = near.tatami;
    }
  };
  collectTexts();

  // ---- 部屋ポリゴン ----
  /** 中庭など、壁に囲まれていても屋外の領域（外形・屋根から除く） */
  const courtLabels = new Set<number>();
  const labelOfRoom = new Map<number, number>();
  const thick = walls.map((w) => w.d).sort((a, b) => a - b);
  const medianD = thick.length ? thick[Math.floor(thick.length / 2)] : 120;
  const k = Math.max(1, Math.round(medianD / 2 / res));
  const rooms: Room[] = [];
  /** 室名が無く、仮の名前（収納・室）にした区画 */
  const autoNamed = new Set<number>();
  const minCells = (0.4 * 1e6) / (res * res);
  /**
   * 部屋にしない小さな区画。内法 0.4㎡ 未満は壁のすき間・線の重なりが多いので捨てるが、
   * 収納の名前（物入・収納・CL・SC）の入った区画は内法 0.15㎡ から部屋にする
   * （半間の物入 910×455 は内法 0.26㎡ ほど。捨てると 3D で床に穴があき、戸の向こうが抜ける。田中様邸 1 階）
   */
  const minStorageCells = (0.15 * 1e6) / (res * res);
  const tooSmall = (l: number): boolean => {
    if (sizes[l] >= minCells) return false;
    if (sizes[l] < minStorageCells) return true;
    const a = acc.get(l);
    return !a?.names.some((n) => n.type === 'storage' || n.type === 'closet');
  };
  /**
   * 区画（ラベル l）の輪郭: 升を壁の芯まで広げてなぞる。
   * extra = 区画に含める升（階段の中の中壁・手すりの線）、blocked = 広げない升（分けた階段の範囲）
   */
  const traceLabel = (l: number, extra?: Uint8Array | null, blocked?: Uint8Array | null): { poly: Vec2[]; area: number; mask: Uint8Array } | null => {
    const mask = new Uint8Array(grid.w * grid.h);
    for (let i = 0; i < mask.length; i++) if (labels[i] === l || (extra && extra[i])) mask[i] = 1;
    const dil = dilateMask(mask, grid.w, grid.h, k, (i) => grid.data[i] === WALL && !(blocked && blocked[i]));
    const loops = traceMask(dil, grid);
    if (!loops.length) return null;
    return { poly: loops[0], area: Math.abs(polygonArea(loops[0])) / 1e6, mask };
  };
  for (let l = 1; l < sizes.length; l++) {
    if (tooSmall(l)) continue;
    const traced = traceLabel(l);
    if (!traced) continue;
    const { poly, area, mask } = traced;
    const a = acc.get(l);
    let name = '';
    let type: RoomType = 'other';
    let labelPos: Vec2 | null = null;
    if (!a?.names.length && a?.others.length) {
      // 辞書に無い室名（店舗区画など）はそのまま名前にする
      const main = a.others.slice().sort((p, q) => q.size - p.size)[0];
      name = [...new Set(a.others.map((n) => n.str))].slice(0, 2).join('・');
      type = 'other';
      labelPos = { x: main.x, y: main.y };
    } else if (a?.names.length) {
      // 複数の室名が1つの領域に入った場合（LDK＋パントリーなど）は主な部屋を代表にする
      let main = mainName(a.names, area)!;
      // 吹抜の区画に居室・ホールの名前は入らない。吹抜と居室の名前が一緒に入ったのは内壁が読めずにまとまった区画なので、
      // 吹抜にしない（田添様邸の 2 階: 内壁が読めず 2 階全体が「吹抜・子供室①・ホール②・トイレ②・子供室②」になり、3D で 2 階の床が抜けていた）
      if (main.type === 'void') {
        const rooms2 = a.names.filter((n) => !['void', 'stairs', 'balcony', 'porch'].includes(n.type));
        if (rooms2.length) main = mainName(rooms2)!;
      }
      // 「外部物置」と「庇」が同じ区画に入った軒下のテラス: 物置が 15㎡ を超えることは無いので屋外（庇・ポーチ）を代表にする
      if ((main.type === 'storage' || main.type === 'closet') && area > 15) {
        const outdoor = a.names.find((n) => n.type === 'porch' || n.type === 'balcony');
        if (outdoor) main = outdoor;
      }
      const uniq = [...new Set([main.str, ...a.names.map((n) => n.str)])];
      name = uniq.join('・');
      type = main.type;
      labelPos = { x: main.x, y: main.y };
      if (type === 'balcony' && /庭|COURT/i.test(main.str)) courtLabels.add(l);
      // 2 階以上のデッキ・テラスはバルコニー
      if (level >= 2 && (type === 'deck' || type === 'terrace' || type === 'carport' || type === 'parking')) type = 'balcony';
      // 1 階の外構（カーポート・駐車場・デッキ・テラス・外部物置）は家の外形に入れない
      if (level <= 1 && isExteriorWorks(type)) courtLabels.add(l);
    } else if (a?.stair) {
      name = '階段';
      type = 'stairs';
    } else if (area < 2.0) {
      name = '収納';
      type = 'storage';
      autoNamed.add(rooms.length);
    } else {
      name = '室';
      type = 'other';
      autoNamed.add(rooms.length);
    }
    if (!labelPos) {
      // 領域の中心付近のセル
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let i = 0; i < mask.length; i++)
        if (mask[i]) {
          sx += i % grid.w;
          sy += (i / grid.w) | 0;
          n++;
        }
      labelPos = grid.centerOf(sx / n, sy / n);
    }
    labelOfRoom.set(rooms.length, l);
    rooms.push({
      id: `F${level}-R${rooms.length + 1}`,
      name,
      type,
      polygon: poly,
      area,
      labelPos,
      labeledTatami: a?.tatami,
      stairDir: a?.stair,
    });
  }

  // 中庭に（ガラス戸などを挟んで）接する、文字の無い小さな区画は中庭の一部
  if (courtLabels.size) {
    rooms.forEach((rm, idx) => {
      if (rm.name !== '室' || rm.area > 20) return;
      const l = labelOfRoom.get(idx);
      if (l == null) return;
      const R = 10;
      let touches = false;
      for (let i = 0; i < labels.length && !touches; i++) {
        if (labels[i] !== l) continue;
        const x = i % grid.w;
        const y = (i / grid.w) | 0;
        for (const [dx, dy] of [[R, 0], [-R, 0], [0, R], [0, -R]]) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= grid.w || yy >= grid.h) continue;
          if (courtLabels.has(labels[yy * grid.w + xx])) {
            touches = true;
            break;
          }
        }
      }
      if (touches) {
        rm.name = '中庭';
        rm.type = 'balcony';
        courtLabels.add(l);
      }
    });
  }

  // ×印の吹抜とほぼ同じ範囲の区画は吹抜（「吹抜」の文字が隣の区画に入っていても）
  {
    // ×印に当たる区画を先に全部決める（2 つ目の×印が、1 つ目の吹抜を「文字だけが入った隣の区画」として外していた）
    const marked = new Map<Room, { vr: BBox; own: boolean }>();
    for (const vr of voidRects) {
      const ra = ((vr.maxX - vr.minX) * (vr.maxY - vr.minY)) / 1e6;
      const r = rooms.find((rm) => {
        if (marked.has(rm)) return false;
        const c = rm.polygon.reduce((a0, q) => ({ x: a0.x + q.x / rm.polygon.length, y: a0.y + q.y / rm.polygon.length }), { x: 0, y: 0 });
        return c.x > vr.minX && c.x < vr.maxX && c.y > vr.minY && c.y < vr.maxY && rm.area > ra * 0.6 && rm.area < ra * 1.4;
      });
      // own = 「吹抜」の文字がこの区画の中にある（文字が隣へはみ出していない）
      if (r) marked.set(r, { vr, own: /吹抜|吹き抜け/.test(r.name) });
    }
    for (const [r, { vr, own }] of marked) {
      r.name = '吹抜';
      r.type = 'void';
      // 文字が自分の中にあるなら、ほかの「吹抜」は別の吹抜（階段の上の小さな吹抜など。大崎様邸 2 階: 床面積に数えていた）。
      // 文字が無いときだけ、×印に接する隣の区画に入った「吹抜」の文字を外す
      if (own) continue;
      for (const o of rooms) {
        if (o === r || marked.has(o) || !/吹抜|吹き抜け/.test(o.name)) continue;
        const ob = bboxOf(o.polygon);
        if (ob.minX > vr.maxX + 400 || ob.maxX < vr.minX - 400 || ob.minY > vr.maxY + 400 || ob.maxY < vr.minY - 400) continue;
        const rest = o.name.split('・').filter((n) => !/吹抜|吹き抜け/.test(n));
        if (rest.length) o.name = rest.join('・');
        if (o.type === 'void') o.type = rest.length ? classifyRoomName(rest[0]) ?? 'other' : 'other';
      }
    }
  }

  // 面積表との照合: 図面の面積表（「1階 100.20」）より明らかに大きい場合は、室名の無い区画のうち
  // 外すと面積表に合うもの（ガラス戸に囲まれた中庭、壁に囲まれたポーチ）を屋外とする
  if (expectedArea && expectedArea > 5) {
    const extD0 = walls.length ? Math.max(...walls.map((w) => w.d)) : 150;
    const bm = new Uint8Array(grid.w * grid.h);
    for (let i = 0; i < bm.length; i++) bm[i] = grid.data[i] !== OUTSIDE && !courtLabels.has(labels[i]) ? 1 : 0;
    const er = erodeMask(bm, grid.w, grid.h, Math.max(1, Math.round(extD0 / 2 / res)));
    let cells = 0;
    for (let i = 0; i < er.length; i++) cells += er[i];
    const excluded = rooms.filter((r) => (excludedFromFloorArea(r.type) && r.type !== 'balcony' && r.type !== 'porch') || (r.type === 'balcony' && !/庭/.test(r.name))).reduce((s0, r) => s0 + r.area, 0);
    const A = (cells * res * res) / 1e6 - excluded;
    const err0 = (A - expectedArea) / expectedArea;
    if ((globalThis as { __alignDebug?: boolean }).__alignDebug) console.log(`[area] level ${level} A=${A.toFixed(2)} expected=${expectedArea} err0=${(err0 * 100).toFixed(1)}% unnamed=${JSON.stringify(rooms.filter((r) => r.name === '室').map((r) => +r.area.toFixed(2)))}`);
    // 2.5% 以上多ければ探す（吉田大仁様邸: 斜めの外壁の外側の庭の隅 3.4 ㎡ を室内と読んで 1 階が 3.8% 多かった）
    if (err0 > 0.025) {
      const cand = rooms.map((r, idx) => ({ r, idx })).filter(({ r }) => r.name === '室' && r.area >= 1.5).slice(0, 12);
      let best: { set: number[]; err: number } | null = null;
      const n = cand.length;
      for (let mask = 1; mask < 1 << n; mask++) {
        const set: number[] = [];
        for (let b = 0; b < n; b++) if (mask & (1 << b)) set.push(b);
        if (set.length > 3) continue;
        const sub = set.reduce((s0, b) => s0 + cand[b].r.area, 0);
        const err = Math.abs(A - sub - expectedArea) / expectedArea;
        if (!best || err < best.err) best = { set, err };
      }
      if (best && best.err < 0.025 && best.err < err0 * 0.75) {
        for (const b of best.set) {
          const { r, idx } = cand[b];
          const l = labelOfRoom.get(idx);
          if (l == null) continue;
          // 内外判定で塞いだ切れ目に接する → 屋外に開いたポーチ、接しない → 中庭
          let open = false;
          for (let i = 0; i < labels.length && !open; i++) {
            if (labels[i] !== l) continue;
            const x = i % grid.w;
            for (let d = 1; d <= 4 && !open; d++)
              for (const j of [x >= d ? i - d : -1, x + d < grid.w ? i + d : -1, i - d * grid.w, i + d * grid.w])
                if (j >= 0 && j < gapMask.length && gapMask[j]) {
                  open = true;
                  break;
                }
          }
          if (level <= 1) {
            r.name = open ? 'ポーチ' : '中庭';
            r.type = open ? 'porch' : 'balcony';
            // 面積表から外した区画の推定名（車が置いてあれば後でガレージに直す）
            r.inferred = true;
            courtLabels.add(l);
          } else if (open) {
            // 2階以上: 屋外に開いた区画はバルコニー・屋根
            r.name = 'バルコニー';
            r.type = 'balcony';
            courtLabels.add(l);
          } else {
            // 2階以上: 壁に囲まれた区画は吹抜
            r.name = '吹抜';
            r.type = 'void';
          }
        }
      }
    }
  }

  // 上下階の比較で分かった中庭（室名が無く、上階に床が無く、ガラス戸に囲まれた区画）
  for (const pt of hints?.courtyards ?? []) {
    const idx = rooms.findIndex((r) => r.name === '室' && pointInPolygon(pt, r.polygon));
    if (idx < 0) continue;
    const l = labelOfRoom.get(idx);
    if (l == null) continue;
    rooms[idx].name = '中庭';
    rooms[idx].type = 'balcony';
    courtLabels.add(l);
  }

  for (const pt of hints?.outdoorAt ?? []) {
    const idx = rooms.findIndex((r) => pointInPolygon(pt, r.polygon));
    const l = idx >= 0 ? labelOfRoom.get(idx) : undefined;
    if (l != null) courtLabels.add(l);
  }

  // 「玄関ホール」は床のある通路（hall）として読むが、玄関（土間）の室名が無い図面ではそれを玄関にする
  if (level === 1 && !rooms.some((r) => r.type === 'entrance')) {
    const gh = rooms.find((r) => r.type === 'hall' && /玄関/.test(r.name));
    if (gh) gh.type = 'entrance';
  }

  // トイレ・浴室としてあり得ない広さ（7㎡を超えるトイレなど）の区画は、壁の読めなかった小部屋の名前が廊下に入ったもの → ホール
  for (const rm of rooms) {
    if ((rm.type === 'toilet' || rm.type === 'bath') && rm.area > ROOM_KNOWLEDGE[rm.type].tatami[1] * 1.62 * 3) {
      rm.name = 'ホール';
      rm.type = 'hall';
      rm.inferred = true;
    }
  }

  // 2 階以上で、室名が無く、一辺がまるごと屋外に開いている区画はバルコニー。
  // 手すりが細い線だけで描かれたバルコニーは壁で囲まれず、内外の判定用に塞いだ線（袖壁の端どうしを結ぶ線）で区切られる。
  // 部屋の外壁の読み落とし（窓 1 つ分の切れ目）と区別するため、開いた線が 1.5m 以上で、その辺の 6 割以上を占めるものだけ
  // （市岡様邸 3 階: 室名が区画の外に書かれたバルコニーが、隣の洋室から推定して「WIC」になっていた）
  if (level >= 2) {
    for (const idx of autoNamed) {
      const rm = rooms[idx];
      if (rm.name !== '室' && rm.name !== '収納') continue;
      const l = labelOfRoom.get(idx);
      if (l == null || courtLabels.has(l)) continue;
      let gx0 = Infinity;
      let gy0 = Infinity;
      let gx1 = -Infinity;
      let gy1 = -Infinity;
      let rx0 = Infinity;
      let ry0 = Infinity;
      let rx1 = -Infinity;
      let ry1 = -Infinity;
      let gapCells = 0;
      for (let i = 0; i < labels.length; i++) {
        if (labels[i] !== l) continue;
        const x = i % grid.w;
        const y = (i / grid.w) | 0;
        if (x < rx0) rx0 = x;
        if (x > rx1) rx1 = x;
        if (y < ry0) ry0 = y;
        if (y > ry1) ry1 = y;
        if (!gapMask[i]) continue;
        gapCells++;
        if (x < gx0) gx0 = x;
        if (x > gx1) gx1 = x;
        if (y < gy0) gy0 = y;
        if (y > gy1) gy1 = y;
      }
      if (!gapCells) continue;
      const gw = (gx1 - gx0 + 1) * res;
      const gh = (gy1 - gy0 + 1) * res;
      const horiz = gw >= gh;
      const gapLen = horiz ? gw : gh;
      const sideLen = (horiz ? rx1 - rx0 + 1 : ry1 - ry0 + 1) * res;
      // 開いた線は区画の端（辺）にあること
      const atEdge = horiz ? gy0 - ry0 <= 6 || ry1 - gy1 <= 6 : gx0 - rx0 <= 6 || rx1 - gx1 <= 6;
      if (gapLen < 1500 || gapLen < sideLen * 0.6 || !atEdge) continue;
      rm.name = 'バルコニー';
      rm.type = 'balcony';
      rm.inferred = true;
      courtLabels.add(l);
    }
  }

  // 室名の無い区画の名前を、隣の部屋から推定する（玄関の隣 → シューズクローク、キッチンの隣 → パントリー、寝室の隣 → WIC …）
  for (const idx of autoNamed) {
    const rm = rooms[idx];
    // 内外の判定でバルコニー・中庭・ポーチになった区画はそのまま
    if (rm.name !== '室' && rm.name !== '収納') continue;
    const neighbors = rooms.filter((o, j) => j !== idx && !autoNamed.has(j) && polysAdjacent(rm.polygon, o.polygon)).map((o) => o.type);
    const bb = bboxOf(rm.polygon);
    const bw = bb.maxX - bb.minX;
    const bh = bb.maxY - bb.minY;
    // 車庫に接する大きな区画（室名が無い）は駐車場からのアプローチ・自転車置き場
    if (rm.name === '室' && rm.area >= 10 && neighbors.includes('garage')) {
      rm.name = 'アプローチ';
      rm.type = 'porch';
      rm.inferred = true;
      continue;
    }
    const guess = inferNamelessRoom(neighbors, rm.area, { level, width: Math.min(bw, bh), length: Math.max(bw, bh) });
    if (guess) {
      rm.name = guess.name;
      rm.type = guess.type;
      rm.inferred = true;
    } else if (rm.name === '収納') rm.inferred = true;
  }

  // ---- 外形 ----
  const building = new Uint8Array(grid.w * grid.h);
  for (let i = 0; i < building.length; i++) building[i] = grid.data[i] !== OUTSIDE && !courtLabels.has(labels[i]) ? 1 : 0;
  const extD = walls.length ? Math.max(...walls.map((w) => w.d)) : 150;
  const eroded = erodeMask(building, grid.w, grid.h, Math.max(1, Math.round(extD / 2 / res)));
  const outline = traceMask(eroded, grid, res * 1.5).filter((l) => Math.abs(polygonArea(l)) > 2e6);

  // ---- 外壁判定 ----
  const sideState = (p: Vec2) => {
    const [x, y] = grid.cellOf(p);
    // 中庭・ポーチ（屋外の区画）は外として扱う → 面した壁は外壁、ガラス戸は窓になる
    if (x >= 0 && y >= 0 && x < grid.w && y < grid.h && courtLabels.has(labels[y * grid.w + x])) return OUTSIDE;
    return grid.get(x, y);
  };
  const outWalls: Wall[] = [];
  const openings: Opening[] = [];
  // 窓ごとの補助情報（部屋・南向き度・図面に寸法が書かれていたか）: 窓の語彙の後処理に使う
  const winInfo = new Map<number, { room: RoomType | null; south: number; drawn: boolean; marked?: boolean }>();
  const roomAt = (p: Vec2): Room | null => {
    const [x, y] = grid.cellOf(p);
    const l = x >= 0 && y >= 0 && x < grid.w && y < grid.h ? labels[y * grid.w + x] : 0;
    if (!l) return null;
    // ラベル番号 → 部屋（sizes の順番で作ったので対応表を持つ）
    return roomByLabel.get(l) ?? null;
  };
  const roomByLabel = new Map<number, Room>();
  {
    let ri = 0;
    for (let l = 1; l < sizes.length; l++) {
      if (tooSmall(l)) continue;
      // traceMask が空だった場合のズレを避けるため中心点で照合
      const r = rooms[ri];
      if (!r) break;
      roomByLabel.set(l, r);
      ri++;
    }
  }
  // 確実な対応付け: 各部屋の labelPos から
  roomByLabel.clear();
  for (const r of rooms) {
    const [x, y] = grid.cellOf(r.labelPos);
    let l = labels[y * grid.w + x];
    if (!l) l = labelAt(r.labelPos);
    if (l) roomByLabel.set(l, r);
  }

  const southVec = (() => {
    // 真南の方向（図面座標）
    const a = (northAngleDeg * Math.PI) / 180;
    // 真北 = 図面の上 (0,-1) を時計回りに a 回転
    const nx = Math.sin(a);
    const ny = -Math.cos(a);
    return { x: -nx, y: -ny };
  })();

  walls.forEach((w, wi) => {
    const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    // 壁に沿って数点サンプリングし、どちらかが外部か
    let outPlus = 0;
    let outMinus = 0;
    const off = w.d / 2 + res * 3;
    for (let s = 0.1; s <= 0.9; s += 0.2) {
      const p = { x: w.a.x + (w.b.x - w.a.x) * s, y: w.a.y + (w.b.y - w.a.y) * s };
      if (sideState({ x: p.x + w.n.x * off, y: p.y + w.n.y * off }) === OUTSIDE) outPlus++;
      if (sideState({ x: p.x - w.n.x * off, y: p.y - w.n.y * off }) === OUTSIDE) outMinus++;
    }
    // 片側の大半が屋外なら外壁。長い壁の一部だけ両側が屋外（ピロティ・ポーチ・バルコニーの囲い）でも外壁として扱う
    // （以前は「片側が全て屋内」を条件にしていたため、玄関ポーチの下まで伸びた外壁が内壁扱いになり、
    //  外観で壁の仕上げが変わる・基礎との間に隙間が出る、といった見た目の崩れが起きていた）
    const exterior = Math.max(outPlus, outMinus) >= 3;
    // Wall の a→b 方向に対する n の向き: perp(u) = (-u.y, u.x) = n
    const outsideSign: 1 | -1 | undefined = exterior ? (outPlus >= outMinus ? 1 : -1) : undefined;
    const id = `F${level}-W${wi + 1}`;
    outWalls.push({
      id,
      a: w.a,
      b: w.b,
      thickness: Math.round(w.d),
      exterior,
      outsideSign,
      joinedA: w.joinedA,
      joinedB: w.joinedB,
    });
    void mid;
    void L;
    for (const op of w.openings) {
      const t0 = Math.max(0, op.t0 - w.t0);
      const t1 = Math.min(L, op.t1 - w.t0);
      if (t1 - t0 < 200) continue;
      const center = { x: w.a.x + w.u.x * ((t0 + t1) / 2), y: w.a.y + w.u.y * ((t0 + t1) / 2) };
      // 開口のそばに書かれた注記（サッシ記号・FL+・開口・FIX など）。壁に沿って開口幅+余裕、壁と直交方向に 900mm 以内
      const notes = plan.texts
        .map((t) => {
          const dx = t.x - center.x;
          const dy = t.y - center.y;
          const along = Math.abs(dx * w.u.x + dy * w.u.y);
          const across = Math.abs(dx * w.n.x + dy * w.n.y);
          return { t, along, across };
        })
        .filter((q) => q.along <= (t1 - t0) / 2 + 350 && q.across <= 900)
        .sort((a, b) => a.across + a.along * 0.3 - (b.across + b.along * 0.3));
      const noteSash = notes.map((q) => ({ q, v: parseSashCode(q.t.str) })).find((q) => q.v)?.v ?? null;
      const noteFl = notes.map((q) => parseFlOffset(q.t.str)).find((v) => v != null) ?? null;
      const noteOpen = notes.some((q) => isOpenMark(q.t.str));
      const noteKind = notes.map((q) => parseSashKind(q.t.str)).find((v) => v != null) ?? null;
      // 開口ごとの内外: 壁全体は内壁扱いでも、この窓の片側だけが屋外（入隅・坪庭）なら外壁の窓として扱う
      let opOut: 1 | -1 | undefined = exterior ? outsideSign : undefined;
      if (!exterior && op.kind === 'window') {
        const offS = w.d / 2 + res * 3;
        const sp = sideState({ x: center.x + w.n.x * offS, y: center.y + w.n.y * offS });
        const sm = sideState({ x: center.x - w.n.x * offS, y: center.y - w.n.y * offS });
        if (sp === OUTSIDE && sm !== OUTSIDE) opOut = 1;
        else if (sm === OUTSIDE && sp !== OUTSIDE) opOut = -1;
      }
      let inSign = opOut != null ? -opOut : 1;
      let inRoom = roomAt({ x: center.x + w.n.x * inSign * (w.d / 2 + 60), y: center.y + w.n.y * inSign * (w.d / 2 + 60) });
      let otherRoom = roomAt({ x: center.x - w.n.x * inSign * (w.d / 2 + 60), y: center.y - w.n.y * inSign * (w.d / 2 + 60) });
      // サッシの記号が、室内と屋外の区画（中庭・バルコニー・ポーチ・デッキ）の間にある → ガラスの建具（窓）。車庫との間は家の中の戸のまま
      if (opOut == null && op.kind === 'window' && inRoom && otherRoom && inRoom.type !== 'garage' && otherRoom.type !== 'garage') {
        const oi = OUTDOOR_TYPES.includes(inRoom.type);
        const oo = OUTDOOR_TYPES.includes(otherRoom.type);
        if (oi !== oo) {
          if (oi) {
            inSign = -inSign;
            [inRoom, otherRoom] = [otherRoom, inRoom];
          }
          opOut = -inSign as 1 | -1;
        }
      }
      const opExterior = opOut != null;
      const width = t1 - t0;
      let kind: Opening['kind'];
      let sill = 0;
      let height = 2000;
      let windowStyle: WindowStyle | undefined;
      // 外壁扱いの壁でも、両側が室内（中庭に面する壁の、ホール側の区間など）なら室内の建具として扱う
      const outdoorType = (t: RoomType | undefined) => !t || OUTDOOR_TYPES.includes(t);
      const bothInside = !!inRoom && !!otherRoom && !outdoorType(inRoom.type) && !outdoorType(otherRoom.type);
      // ビルトインガレージと玄関・ホールの間の戸は家の中の戸（玄関ドアにすると外開き＋庇・ポーチが付いてしまう）
      const garageSide = inRoom?.type === 'garage' || otherRoom?.type === 'garage';
      const garageInner = garageSide && !!inRoom && !!otherRoom && (inRoom.type === 'garage' ? !outdoorType(otherRoom.type) : !outdoorType(inRoom.type));
      if (opExterior && !bothInside && !garageInner) {
        if (level === 1 && (op.kind === 'door' || (inRoom?.type === 'entrance' && op.kind !== 'window'))) {
          kind = 'entrance';
          height = 2200;
        } else if (op.kind === 'door') {
          // 2 階以上の外壁の扉（バルコニーへの出入り）
          kind = 'door';
          height = 2000;
        } else {
          kind = 'window';
          const outN = { x: w.n.x * (opOut ?? 1), y: w.n.y * (opOut ?? 1) };
          const southDot = outN.x * southVec.x + outN.y * southVec.y;
          const facingSouth = southDot > 0.7;
          const ws = windowStyleFor(inRoom?.type ?? null, width, facingSouth);
          sill = ws.sill;
          height = ws.height;
          windowStyle = ws.style;
          winInfo.set(openings.length, { room: inRoom?.type ?? null, south: Math.max(0, southDot), drawn: !!(noteSash && Math.abs(noteSash.width - width) <= Math.max(300, width * 0.35)) || (noteFl != null && noteFl < 1600) });
          // 図面に書かれたサッシ記号（例 16511 = W1650×H1170）があれば、その寸法を優先する
          if (noteSash && Math.abs(noteSash.width - width) <= Math.max(300, width * 0.35)) {
            height = noteSash.height;
            if (noteFl != null && noteFl < 1600) sill = noteFl;
            else if (height >= 1800) sill = 0;
            else sill = Math.max(0, 2000 - height);
            windowStyle = height >= 1800 ? 'hakidashi' : height <= 600 ? (sill >= 1300 ? 'high' : 'small') : 'koshi';
          } else if (noteFl != null && noteFl < 1600) {
            // FL+900 などの腰高の注記だけがある場合
            sill = noteFl;
            height = Math.min(height, 2000 - sill);
            windowStyle = sill === 0 ? 'hakidashi' : sill >= 1300 ? 'high' : 'koshi';
          }
          // 通り口の印が横切る窓 = 人が出入りする窓（掃き出し・テラスドア・勝手口）。床までの高さにする
          if (usesMarks && opMarked(w, op)) {
            windowStyle = 'hakidashi';
            sill = 0;
            if (height < 1800) height = 2000;
            const inf = winInfo.get(openings.length);
            if (inf) {
              inf.drawn = true;
              inf.marked = true;
            }
          }
          void noteKind;
        }
      } else {
        if (op.kind === 'door') kind = 'door';
        else if (op.kind === 'window') kind = 'sliding';
        else kind = 'open';
        // 印を使う図面で、印が無く細い線だけが根拠の「引戸」は建具ではない（上がり框・手すり・通り抜けの境・棚の前の線・
        // タイルの目地）。区切りは残して建具なしの開口にする。室名の無い区画（造作の棚・土間の奥）との間でも同じ:
        // 池本様邸 1 階の土間収納の中に 1.7m、パントリーの冷蔵庫置場の前に 1.3m、服部様邸のペット室の棚の前に 2.2m の「引戸」ができていた
        if (kind === 'sliding' && unmarkedSet.has(op) && inRoom && otherRoom) kind = 'open';
        // 「開口」の注記 = 建具なしの開口部。「引違」「FIX」の注記があれば引戸／固定として扱う
        if (noteOpen) kind = 'open';
        else if (noteKind === 'sliding' && kind !== 'door') kind = 'sliding';
        height = 2000;
        if (noteSash && Math.abs(noteSash.width - width) <= Math.max(300, width * 0.35)) height = noteSash.height >= 1800 ? noteSash.height : 2000;
        void otherRoom;
        // 幅 500 mm 未満の「引戸」は人が通れない（引込み戸の戸袋の端などの線）→ 建具にしない
        if (kind === 'sliding' && width < 500) continue;
      }
      openings.push({
        id: `${id}-O${openings.length + 1}`,
        wallId: id,
        kind,
        t0,
        t1,
        sill,
        height,
        windowStyle,
        // 引戸は「引き込む側」を hingeAtStart に持つ（false = 始点側へ、true = 終点側へ）。図面の戸袋が読めたらその側
        hingeAtStart: kind === 'sliding' && op.pocketSide != null ? op.pocketSide > 0 : op.hingeAtStart,
        // 開く向きが読めない戸は、両側の部屋の種類から（個室・浴室はその部屋の中へ、トイレ・収納は外へ、通路からは部屋の中へ）
        swingSide:
          op.swingSign ??
          (kind === 'door'
            ? (() => {
                const side = doorSwingFor(inRoom?.type ?? null, otherRoom?.type ?? null);
                return side === 'a' ? (inSign as 1 | -1) : side === 'b' ? (-inSign as 1 | -1) : undefined;
              })()
            : undefined),
        confidence: op.confidence,
      });
    }
  });

  // 印が壁を横切っているのに開口が読めていない所 = 読み落とした建具（壁の脇に描かれたアウトセット引戸・斜めの壁のテラスドアなど）。
  // 印の位置に建具を足す。幅は、壁に沿って印の位置を通る細い線（戸・サッシの線）の長さ。無ければ標準の幅
  if (usesMarks) {
    const thin = plan.segs.filter((sg) => sg.source === 'stroke' && !sg.dashed);
    walls.forEach((w, wi) => {
      const ow = outWalls[wi];
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (L < 700) return;
      for (const k of passMarks) {
        if (k.len < 350) continue;
        if (marksCrossing([k], w.a, w.b, 0, L, 0) === 0) continue;
        const t = ((k.a.x + k.b.x) / 2 - w.a.x) * w.u.x + ((k.a.y + k.b.y) / 2 - w.a.y) * w.u.y;
        if (t < 150 || t > L - 150) continue;
        const mine = openings.filter((o) => o.wallId === ow.id);
        // すでに開口がある（少し離れていても同じ建具の印）
        if (mine.some((o) => t > o.t0 - 250 && t < o.t1 + 250)) continue;
        // 壁に沿って印の位置を通る細い線（壁芯から 160 mm 以内、長さ 500〜2,800 mm）
        let lo = Infinity;
        let hi = -Infinity;
        for (const sg of thin) {
          const len = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
          if (len < 500 || len > 2800) continue;
          const oa = (sg.a.x - w.a.x) * w.n.x + (sg.a.y - w.a.y) * w.n.y;
          const ob = (sg.b.x - w.a.x) * w.n.x + (sg.b.y - w.a.y) * w.n.y;
          if (Math.abs(oa) > 160 || Math.abs(ob) > 160 || Math.abs(oa - ob) > 20) continue;
          const ta = (sg.a.x - w.a.x) * w.u.x + (sg.a.y - w.a.y) * w.u.y;
          const tb = (sg.b.x - w.a.x) * w.u.x + (sg.b.y - w.a.y) * w.u.y;
          const s0 = Math.min(ta, tb);
          const s1 = Math.max(ta, tb);
          if (t < s0 + 60 || t > s1 - 60) continue;
          lo = Math.min(lo, s0);
          hi = Math.max(hi, s1);
        }
        const off = w.d / 2 + res * 3;
        const c0 = { x: w.a.x + w.u.x * t, y: w.a.y + w.u.y * t };
        const sp = sideState({ x: c0.x + w.n.x * off, y: c0.y + w.n.y * off });
        const sm = sideState({ x: c0.x - w.n.x * off, y: c0.y - w.n.y * off });
        const out: 1 | -1 | undefined = sp === OUTSIDE && sm !== OUTSIDE ? 1 : sm === OUTSIDE && sp !== OUTSIDE ? -1 : undefined;
        if (sp === OUTSIDE && sm === OUTSIDE) continue;
        // 印は建具の真ん中を横切る。線が片側へ長く伸びていれば（アウトセット引戸のレール・戸袋）、短い側に合わせて左右対称に取る
        const std = out != null ? 1650 : 780;
        const half = Math.min(t - lo, hi - t);
        if (half >= 275 && half <= 1400) {
          lo = t - half;
          hi = t + half;
        } else {
          lo = t - std / 2;
          hi = t + std / 2;
        }
        // 壁の中・隣の開口の手前に収める
        let t0 = Math.max(60, lo);
        let t1 = Math.min(L - 60, hi);
        for (const o of mine) {
          if (o.t1 <= t) t0 = Math.max(t0, o.t1 + 100);
          if (o.t0 >= t) t1 = Math.min(t1, o.t0 - 100);
        }
        if (t1 - t0 < 550 || t < t0 || t > t1) continue;
        const inSign = out != null ? -out : 1;
        const inRoom = roomAt({ x: c0.x + w.n.x * inSign * (w.d / 2 + 60), y: c0.y + w.n.y * inSign * (w.d / 2 + 60) });
        if (out != null) {
          const outN = { x: w.n.x * out, y: w.n.y * out };
          winInfo.set(openings.length, { room: inRoom?.type ?? null, south: Math.max(0, outN.x * southVec.x + outN.y * southVec.y), drawn: true, marked: true });
          openings.push({ id: `${ow.id}-O${openings.length + 1}`, wallId: ow.id, kind: 'window', t0, t1, sill: 0, height: 2000, windowStyle: 'hakidashi', confidence: 0.6 });
          warnings.push(`${level}階: 通り口の印がある外壁に、出入りできる窓（幅 ${Math.round(t1 - t0).toLocaleString()}mm）を置きました（図面の線では窓が読めなかった所。方眼で確かめてください）`);
        } else {
          openings.push({ id: `${ow.id}-O${openings.length + 1}`, wallId: ow.id, kind: 'sliding', t0, t1, sill: 0, height: 2000, confidence: 0.6 });
          warnings.push(`${level}階: 通り口の印がある壁に、引戸（幅 ${Math.round(t1 - t0).toLocaleString()}mm）を置きました（壁の脇に描かれた戸。方眼で確かめてください）`);
        }
      }
    });
  }

  applyWindowVocabulary(openings, winInfo);
  // 玄関ドアは 1 つ: 残りの外壁の開き戸は勝手口（ガレージの通用口を含む）、塀・袖壁の戸は開口にする
  if (level === 1) chooseEntrance({ walls: outWalls, openings, rooms, outline });

  // ---- 階段 ----
  const stairs: Stair[] = [];
  const nonWallSegs = plan.segs.filter((s) => {
    const m = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
    const [x, y] = grid.cellOf(m);
    return grid.get(x, y) === FREE;
  });
  const stairMarks = plan.texts.filter((t) => parseStairMark(t.str) != null || /階段/.test(t.str));
  const stairCands = detectStairs(nonWallSegs, plan.bbox);
  {
    const tr = (globalThis as { __stairTrace?: string[] }).__stairTrace;
    if (tr) for (const t of stairMarks) tr.push(`${level}F mark "${t.str}" ${Math.round(t.x)},${Math.round(t.y)}`);
    if (tr) for (const c of stairCands) tr.push(`${level}F detect ${Math.round(c.minX)},${Math.round(c.minY)}-${Math.round(c.maxX)},${Math.round(c.maxY)} n=${c.treadCount} ${c.treadOrient} flights=${c.flights} walk=${c.walk ?? '-'}`);
  }
  // 1 つの文字が「階段」と認めるのは、いちばん近い候補 1 つだけ。本物の階段のそばの床の目地（フローリング・デッキ・タイル）が、
  // 隣の階段の UP の文字で階段になっていた（堀様邸 FUKUI 1 階: LDK のフローリングの線）
  const supported = new Set<(typeof stairCands)[number]>();
  for (const t of stairMarks) {
    const near = stairCands
      .map((c) => ({ c, d: stairMarkDist(c, t), reach: stairMarkReach(c, t) }))
      .filter((q) => q.reach <= STAIR_MARK_RANGE)
      .sort((a, b) => a.d - b.d || b.c.treadCount - a.c.treadCount)[0];
    if (near) supported.add(near.c);
  }
  for (const c of stairCands) {
    const why = (globalThis as { __stairTrace?: string[] }).__stairTrace;
    // 「UP・DN・階段」の文字が近くに無いもの（タイル目地・デッキ材など）は階段にしない
    if (stairMarks.length && !supported.has(c)) {
      why?.push(`${level}F skip(no mark) ${Math.round(c.minX)},${Math.round(c.minY)}`);
      continue;
    }
    // 平屋で階段の文字も無い図面の等間隔線は、玄関・土間収納のタイル目地
    if (hints?.singleStorey && !stairMarks.length) continue;
    {
      const cc = { x: (c.minX + c.maxX) / 2, y: (c.minY + c.maxY) / 2 };
      const rr = roomAt(cc);
      if (rr && OUTDOOR_TYPES.includes(rr.type)) continue;
      // 建物の外（寸法線・図面の余白の等間隔線）は階段にしない
      if (!rr && !outline.some((l) => pointInPolygon(cc, l))) continue;
    }
    // 周囲の壁面まで広げる。
    // 辺の 1/4・3/4 の 2 点から外へ進み、両方が同じくらいの距離で壁に当たるときだけ、そこまで広げる。
    // （以前は辺の中央 1 点で「壁に当たるまで最大 400mm」広げていた。折り返し階段は中央が中壁なので奥へ広がらず、
    //   昇り口の側は壁が無いのでホールへ 400mm はみ出し、階段全体が昇り口側へ半間ほどずれて置かれていた）
    const r = { ...c };
    type Sd = 'n' | 's' | 'e' | 'w';
    const wallAhead = (side: Sd, max: number): number | null => {
      const ds: number[] = [];
      for (const fr of [0.25, 0.75]) {
        let d: number | null = null;
        for (let k = 1; k * res <= max; k++) {
          const p =
            side === 'n'
              ? { x: r.minX + (r.maxX - r.minX) * fr, y: r.minY - k * res }
              : side === 's'
                ? { x: r.minX + (r.maxX - r.minX) * fr, y: r.maxY + k * res }
                : side === 'w'
                  ? { x: r.minX - k * res, y: r.minY + (r.maxY - r.minY) * fr }
                  : { x: r.maxX + k * res, y: r.minY + (r.maxY - r.minY) * fr };
          if (sideState(p) !== FREE) {
            d = (k - 1) * res;
            break;
          }
        }
        if (d == null) return null;
        ds.push(d);
      }
      return Math.abs(ds[0] - ds[1]) <= 160 ? Math.min(ds[0], ds[1]) : null;
    };
    const growBy = (side: Sd, d: number) => {
      if (side === 'n') r.minY -= d;
      else if (side === 's') r.maxY += d;
      else if (side === 'w') r.minX -= d;
      else r.maxX += d;
    };
    for (const sd of ['e', 'w', 's', 'n'] as const) {
      const d = wallAhead(sd, 400);
      if (d != null && d > 0) growBy(sd, d);
    }
    // 切断線の先の列: コの字に回る階段の 3 列目は、切断線より上なので段の線が 1〜2 本しか描かれず候補に入らない。
    // 範囲の横に、段の線（その辺に直交する線）が 2 本以上、1.2m 以内の壁まで続いていれば、そこまでが階段
    // （吉田大仁様邸 1st 1 階: 2,730×1,820 の階段が 1,820 角と読まれ、右の 910 が LDK の床になっていた）
    for (const sd of ['e', 'w', 's', 'n'] as const) {
      const d = wallAhead(sd, 1200);
      if (d == null || d < 500) continue;
      const horiz = sd === 'e' || sd === 'w';
      // 帯（いまの辺から壁まで）
      const s0 = sd === 'e' ? r.maxX : sd === 'w' ? r.minX - d : sd === 's' ? r.maxY : r.minY - d;
      const s1 = s0 + d;
      const lo = horiz ? r.minY : r.minX;
      const hi = horiz ? r.maxY : r.maxX;
      const pos = new Set<number>();
      for (const sg of nonWallSegs) {
        if (sg.dashed) continue;
        const a0 = horiz ? Math.min(sg.a.x, sg.b.x) : Math.min(sg.a.y, sg.b.y);
        const a1 = horiz ? Math.max(sg.a.x, sg.b.x) : Math.max(sg.a.y, sg.b.y);
        const p0 = horiz ? sg.a.y : sg.a.x;
        const p1 = horiz ? sg.b.y : sg.b.x;
        if (Math.abs(p0 - p1) > 10 || a1 - a0 < 450) continue;
        if (p0 < lo + 100 || p0 > hi - 100) continue;
        if (Math.min(a1, s1) - Math.max(a0, s0) < d * 0.8) continue;
        pos.add(Math.round(p0 / 150));
      }
      if (pos.size < 2) continue;
      // 帯にほかの部屋の名前が無いこと
      const bx0 = horiz ? s0 : lo;
      const bx1 = horiz ? s1 : hi;
      const by0 = horiz ? lo : s0;
      const by1 = horiz ? hi : s1;
      if (plan.texts.some((t) => t.x > bx0 && t.x < bx1 && t.y > by0 && t.y < by1 && parseStairMark(t.str) == null && !/階段/.test(t.str) && cleanRoomName(t.str) != null && (classifyRoomName(cleanRoomName(t.str)!) != null || parseAreaLabel(t.str) != null))) continue;
      growBy(sd, d);
      (globalThis as { __stairTrace?: string[] }).__stairTrace?.push(`${level}F grow(${sd}) +${Math.round(d)} 切断線の先の列`);
    }
    // 回り階段の回る部分（段の線が等間隔でない）は候補に入らない。階段・吹抜（下階の階段の上）と読めた小さな区画に
    // 候補が 4 割以上重なっていれば、その区画いっぱいまでを階段にする（舟橋様邸 2 階: 上 910mm の回り段が欠けていた）
    for (const rm of rooms) {
      if (rm.type !== 'stairs' && !(rm.type === 'void' && level > 1)) continue;
      if (rm.area > 5.5) continue;
      const bx = bboxOf(rm.polygon);
      const ix = Math.min(r.maxX, bx.maxX) - Math.max(r.minX, bx.minX);
      const iy = Math.min(r.maxY, bx.maxY) - Math.max(r.minY, bx.minY);
      if (ix <= 0 || iy <= 0 || (ix * iy) / Math.max(1, (bx.maxX - bx.minX) * (bx.maxY - bx.minY)) < 0.4) continue;
      const half = 60;
      // 折り返し階段の UP・DN の文字は、昇り口・降り口の手前（階段の外）に書かれる。文字のある帯は階段の前の踊り場・ホールなので、
      // そちらへは広げない（大崎様邸 2 階: 降り口の前の踊り場 910 mm が階段の区画に入り、階段が 3,640 に伸びて降り口が外壁側になっていた）。
      // 文字が階段の真正面（階段の幅の中）にあり、その帯の中を通る線（回り段の線）が無いときだけ。
      // 直階段は上の端の踊り場まで含めて読んできたので変えない（市岡様邸 4 階: 塔屋の階段と、屋上へ出る戸の前の踊り場）
      const markIn = (x0: number, y0: number, x1: number, y1: number) => {
        if (c.flights < 2) return false;
        if (!plan.texts.some((t) => parseStairMark(t.str) != null && t.x > x0 && t.x < x1 && t.y > y0 && t.y < y1)) return false;
        // 帯の中を通る線（中点が帯の縁から 120mm 以上内側）。帯の縁の線（最後の段の線・壁の面・隣の吹抜の縁）は数えない
        const inS = (q: Vec2) => q.x > x0 - 50 && q.x < x1 + 50 && q.y > y0 - 50 && q.y < y1 + 50;
        let lines = 0;
        for (const sg of plan.segs) {
          if (sg.dashed || sg.source !== 'stroke' || !inS(sg.a) || !inS(sg.b)) continue;
          if (Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y) < 300) continue;
          const mx = (sg.a.x + sg.b.x) / 2;
          const my = (sg.a.y + sg.b.y) / 2;
          if (mx > x0 + 120 && mx < x1 - 120 && my > y0 + 120 && my < y1 - 120) lines++;
        }
        return lines < 2;
      };
      const { minX: sx0, minY: sy0, maxX: sx1, maxY: sy1 } = r;
      if (bx.minX + half < r.minX && !markIn(bx.minX, sy0, sx0, sy1)) r.minX = bx.minX + half;
      if (bx.minY + half < r.minY && !markIn(sx0, bx.minY, sx1, sy0)) r.minY = bx.minY + half;
      if (bx.maxX - half > r.maxX && !markIn(sx1, sy0, bx.maxX, sy1)) r.maxX = bx.maxX - half;
      if (bx.maxY - half > r.maxY && !markIn(sx0, sy1, sx1, bx.maxY)) r.maxY = bx.maxY - half;
    }
    // 昇り口 = 壁の少ない辺
    const sideWallRatio = (side: 'n' | 's' | 'e' | 'w') => {
      let wall = 0;
      let n = 0;
      const N = 12;
      for (let i = 1; i < N; i++) {
        const f = i / N;
        let p: Vec2;
        if (side === 'n') p = { x: r.minX + (r.maxX - r.minX) * f, y: r.minY - res * 4 };
        else if (side === 's') p = { x: r.minX + (r.maxX - r.minX) * f, y: r.maxY + res * 4 };
        else if (side === 'w') p = { x: r.minX - res * 4, y: r.minY + (r.maxY - r.minY) * f };
        else p = { x: r.maxX + res * 4, y: r.minY + (r.maxY - r.minY) * f };
        n++;
        if (sideState(p) !== FREE) wall++;
      }
      return wall / n;
    };
    const sides = (['n', 's', 'e', 'w'] as const).map((s) => ({ s, r: sideWallRatio(s) })).sort((a, b) => a.r - b.r);
    const w = r.maxX - r.minX;
    const h = r.maxY - r.minY;
    // 1 列の段の線が階段の幅いっぱいに通っていれば、正方形に近くても直階段（幅の広い数段の階段）
    // （幅 1.6m 以上で奥行も 1.5m を超えるものは、2 列の段の線がそろって 1 本につながった折り返し階段）
    const across = c.treadOrient === 'h' ? w : h;
    const runLen = c.treadOrient === 'h' ? c.maxY - c.minY : c.maxX - c.minX;
    // 左右の列にそれぞれ歩行線があれば、段の線が中央でつながって見えても折り返し階段（サンプル図面）
    const fullWidth = c.flights === 1 && !c.mixed && c.walk !== 'columns' && (c.treadLen ?? 0) >= across * 0.8 && !((c.treadLen ?? 0) >= 1600 && runLen > 1500);
    const kind: Stair['kind'] = !fullWidth && (c.flights >= 2 || Math.max(w, h) / Math.min(w, h) < 1.5) ? 'u' : 'straight';
    // 階段のそばの UP／DN の文字（矢印の始点の横。昇り口の 1 段手前に置かれるので矩形から 900mm まで見る）
    const nearMark = (dir: 'up' | 'down') =>
      plan.texts
        .filter((t) => parseStairMark(t.str) === dir)
        .map((t) => ({ t, d: stairMarkDist(r, t) }))
        // かね折れ階段の文字は角の斜め先に来る（林様邸: 横 508・縦 770）ので、縦・横の離れで見る
        .filter((q) => stairMarkReach(r, q.t) <= STAIR_MARK_RANGE)
        .sort((a, b) => a.d - b.d)[0]?.t ?? null;
    const upMark = nearMark('up');
    const dnMark = nearMark('down');
    const hasDn = !!dnMark;
    // UP と DN の両方がある階段（3 階建ての 2 階・上階の図に下階の UP が写っている）は「昇る階段」として読み、
    // 最上階だけ後で降り口に直す（finishTopFloorStairs）。以前は DN の文字が 300mm 以内に無いと最上階でも UP になっていた。
    // 昇りと降りが隣り合う別々の階段（3 階建ての 2 階）は、隣の階段の文字も 900mm 以内に入るので、近いほうの文字で決める
    const goesUp = upMark && dnMark ? stairMarkDist(r, upMark) <= stairMarkDist(r, dnMark) + 100 : !!upMark || !hasDn;
    const upSide = upMark ? stairSideOf(r, upMark) : null;
    const dnSide = dnMark ? stairSideOf(r, dnMark) : null;
    // 文字が無ければ矢印（軸と矢じり）から
    const arrowTail = !upMark && !dnMark ? stairEntryFromArrow(r, nonWallSegs, []) : null;
    // 昇り口: UP の文字の側（降りる階段は DN の文字の側）。読めなければ矢印、それも無ければ壁の少ない辺
    const arrowSide = goesUp ? (upSide ?? arrowTail) : (dnSide ?? arrowTail);
    // 段の向きがそろっている階段は、昇り口は段の並ぶ向きの両端のどちらか（段が横線なら上か下）。
    // UP の文字は昇り口の横（階段の脇）に置かれることもあり、いちばん近い辺が側面になることがある
    const onAxis = (sd: Sd | null): boolean => !sd || !!c.mixed || (c.treadOrient === 'h' ? sd === 'n' || sd === 's' : sd === 'e' || sd === 'w');
    const toAxis = (sd: Sd | null, mark: Vec2 | null): Sd | null => {
      if (!sd || onAxis(sd) || !mark) return sd;
      if (c.treadOrient === 'h') return mark.y < (r.minY + r.maxY) / 2 ? 'n' : 's';
      return mark.x < (r.minX + r.maxX) / 2 ? 'w' : 'e';
    };
    // 矢印が無いときは、壁が少なく、かつホール・LDK など人の通る部屋に面した辺（階段は通路から上がる）
    const sideRoom = (side: 'n' | 's' | 'e' | 'w') => {
      const cx = (r.minX + r.maxX) / 2;
      const cy = (r.minY + r.maxY) / 2;
      const p = side === 'n' ? { x: cx, y: r.minY - 500 } : side === 's' ? { x: cx, y: r.maxY + 500 } : side === 'w' ? { x: r.minX - 500, y: cy } : { x: r.maxX + 500, y: cy };
      return roomAt(p);
    };
    const bySense = (['n', 's', 'e', 'w'] as const)
      .map((sd) => ({ s: sd, score: sideWallRatio(sd) - (isCirculation(sideRoom(sd)?.type) ? 0.35 : 0) }))
      .sort((a, b) => a.score - b.score);
    const mark = goesUp ? upMark : dnMark;
    const markSide = toAxis(arrowSide, mark);
    const senseAxis = bySense.filter((q) => onAxis(q.s));
    // その辺の壁に戸・開口があるか（階段の入口の戸。内外の判定用の升目では戸も壁として塗ってあるので、壁の割合だけでは入口が「壁」に見える）
    const sideHasDoor = (sd: Sd): boolean =>
      openings.some((o) => {
        if (o.kind === 'window') return false;
        const ow = outWalls.find((x) => x.id === o.wallId);
        if (!ow) return false;
        const oL = Math.hypot(ow.b.x - ow.a.x, ow.b.y - ow.a.y) || 1;
        const oc = { x: ow.a.x + ((ow.b.x - ow.a.x) / oL) * ((o.t0 + o.t1) / 2), y: ow.a.y + ((ow.b.y - ow.a.y) / oL) * ((o.t0 + o.t1) / 2) };
        const horiz = sd === 'n' || sd === 's';
        const line = sd === 'n' ? r.minY : sd === 's' ? r.maxY : sd === 'w' ? r.minX : r.maxX;
        const along = horiz ? oc.x : oc.y;
        return Math.abs((horiz ? oc.y : oc.x) - line) <= 350 && along > (horiz ? r.minX : r.minY) - 100 && along < (horiz ? r.maxX : r.maxY) + 100;
      });
    let entry: Stair['entry'] = markSide && (sideWallRatio(markSide) < 0.9 || sideHasDoor(markSide)) ? markSide : (senseAxis[0] ?? bySense[0]).s;
    let kindOut: Stair['kind'] = kind;
    let turn: Stair['turn'] | undefined;
    void sides;
    // かね折れ階段: UP の文字が段の並びの「横」にあって端に寄り、その端の側（段の並ぶ向き）が壁。
    // 最初の 2〜3 段が直角に付き、角で曲がって長い列を昇る（林様邸 1 階: 西の端から北へ上がり、東へ曲がる）
    const rawSide = goesUp ? upSide : dnSide;
    (globalThis as { __stairTrace?: string[] }).__stairTrace?.push(`${level}F cand ${Math.round(c.minX)},${Math.round(c.minY)}-${Math.round(c.maxX)},${Math.round(c.maxY)} r ${Math.round(r.minX)},${Math.round(r.minY)}-${Math.round(r.maxX)},${Math.round(r.maxY)} orient=${c.treadOrient} flights=${c.flights} mixed=${!!c.mixed} up=${upMark ? `${Math.round(upMark.x)},${Math.round(upMark.y)}` : '-'} dn=${dnMark ? `${Math.round(dnMark.x)},${Math.round(dnMark.y)}` : '-'} goesUp=${goesUp} rawSide=${rawSide} markSide=${markSide} wall(raw)=${rawSide ? sideWallRatio(rawSide).toFixed(2) : '-'} entry=${entry}`);
    // （文字が範囲の内側にあるとき＝範囲を階段室いっぱいに広げたときは、一番近い辺が側面になるだけなので見ない: 舟橋様 2 階・市岡様 4 階）
    if (mark && rawSide && !c.mixed && !onAxis(rawSide) && stairMarkDist(r, mark) > 50) {
      const horiz = c.treadOrient === 'v';
      const lo = horiz ? r.minX : r.minY;
      const hi = horiz ? r.maxX : r.maxY;
      const pos = horiz ? mark.x : mark.y;
      const nearLo = pos - lo <= (hi - lo) * 0.35;
      const nearHi = hi - pos <= (hi - lo) * 0.35;
      const endSide: Sd = horiz ? (nearLo ? 'w' : 'e') : nearLo ? 'n' : 's';
      // その端の先（最初の数段の幅ぶん。1.2m まで）に壁があること。あれば、そこまでが階段
      const dEnd = hi - lo >= 1800 && (nearLo || nearHi) ? wallAhead(endSide, 1200) : null;
      if (dEnd != null) {
        growBy(endSide, dEnd);
        const farDir = horiz ? { x: nearLo ? 1 : -1, y: 0 } : { x: 0, y: nearLo ? 1 : -1 };
        // 昇る人から見た右向き（core/stairs.ts の stairFrame と同じ）
        const right = rawSide === 'n' ? { x: -1, y: 0 } : rawSide === 's' ? { x: 1, y: 0 } : rawSide === 'w' ? { x: 0, y: 1 } : { x: 0, y: -1 };
        kindOut = 'l';
        entry = rawSide;
        turn = farDir.x * right.x + farDir.y * right.y > 0 ? 'right' : 'left';
        // 最初の数段のぶん、文字の側へ範囲を伸ばす
        growBy(rawSide, Math.max(0, Math.min(800, stairMarkDist(r, mark) - 100)));
      }
    }
    // 階段の「奥」（踊り場・回り段。段の線が等間隔でないので候補に入らない）: 昇り口の反対側で、
    // 300〜1,200mm 先に壁があればそこまでを階段にする（舟橋様邸 1 階: 奥の 857mm が欠けていた）
    if (kindOut === 'u' && !c.mixed && onAxis(entry)) {
      const far: Sd = entry === 'n' ? 's' : entry === 's' ? 'n' : entry === 'e' ? 'w' : 'e';
      const d = wallAhead(far, 1200);
      if (d != null && d >= 300) growBy(far, d);
    }
    // 「14段」などの段数注記（階段の近く）
    const stepNote = plan.texts
      .map((t) => ({ n: parseStepCount(t.str), d: Math.hypot(Math.max(0, r.minX - t.x, t.x - r.maxX), Math.max(0, r.minY - t.y, t.y - r.maxY)) }))
      .filter((q) => q.n != null && q.d <= 1200)
      .sort((a, b) => a.d - b.d)[0];
    const stair: Stair = {
      id: `F${level}-S${stairs.length + 1}`,
      minX: r.minX,
      minY: r.minY,
      maxX: r.maxX,
      maxY: r.maxY,
      kind: kindOut,
      ...(turn ? { turn } : {}),
      entry,
      goesUp,
      ...(stepNote ? { steps: stepNote.n! } : {}),
    };
    stairMarkSides.set(stair, { up: upSide, down: dnSide, arrowTail });
    stairs.push(stair);
  }
  dedupeStairs(stairs, level);
  // 階段の中の壁（折り返しの中壁・手すり壁）にある「引戸・開口」は建具ではない。
  // 手すり壁は細い二重線で描かれ、全長が引戸として読まれて階段と吹抜を戸でつないでいた（舟橋様邸 2 階の S2625）
  for (let i = openings.length - 1; i >= 0; i--) {
    const o = openings[i];
    // 開き戸（円弧の記号がある）は根拠が強いので残す
    if (o.kind !== 'sliding' && o.kind !== 'open') continue;
    const w = outWalls.find((x) => x.id === o.wallId);
    if (!w) continue;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    const c = { x: w.a.x + ux * ((o.t0 + o.t1) / 2), y: w.a.y + uy * ((o.t0 + o.t1) / 2) };
    const off = w.thickness / 2 + 250;
    const inStairRect = (p: Vec2) => stairs.some((st) => p.x > st.minX && p.x < st.maxX && p.y > st.minY && p.y < st.maxY);
    if (inStairRect({ x: c.x - uy * off, y: c.y + ux * off }) && inStairRect({ x: c.x + uy * off, y: c.y - ux * off })) openings.splice(i, 1);
  }
  // 階段の部屋ラベルを補正（階段が大部分を占める部屋）
  for (const st of stairs) {
    const c = { x: (st.minX + st.maxX) / 2, y: (st.minY + st.maxY) / 2 };
    const r = roomAt(c);
    if (r && r.type === 'other') {
      r.type = 'stairs';
      r.name = '階段';
    }
  }

  // 室名の無い区画（「室」のまま残ったもの）で、戸・引戸・開口で 3 つ以上の部屋とつながるものは通路（ホール）。
  // 洗面の通路のように室名の書かれていない廊下は、隣の部屋の種類だけでは決められない（伊藤様邸 1 階: トイレ・FC・脱衣室・物入の戸が集まる所）
  {
    const linked = new Map<Room, Set<Room>>();
    for (const o of openings) {
      if (o.kind === 'window' || o.kind === 'shutter') continue;
      const w = outWalls.find((x) => x.id === o.wallId);
      if (!w) continue;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      const c = { x: w.a.x + ux * ((o.t0 + o.t1) / 2), y: w.a.y + uy * ((o.t0 + o.t1) / 2) };
      const off = w.thickness / 2 + 150;
      const ra = roomAt({ x: c.x - uy * off, y: c.y + ux * off });
      const rb = roomAt({ x: c.x + uy * off, y: c.y - ux * off });
      if (!ra || !rb || ra === rb) continue;
      (linked.get(ra) ?? linked.set(ra, new Set()).get(ra)!).add(rb);
      (linked.get(rb) ?? linked.set(rb, new Set()).get(rb)!).add(ra);
    }
    for (const idx of autoNamed) {
      const rm = rooms[idx];
      if (rm.name !== '室' || rm.inferred || rm.area > 16) continue;
      const others = [...(linked.get(rm) ?? [])];
      if (others.length < 3) continue;
      rm.name = 'ホール';
      rm.type = 'hall';
      rm.inferred = true;
    }
  }

  // ---- LDK・ホール・パントリーと一続きに読めた階段を、「階段」という別の区画に分ける ----
  // リビング階段・ホールから上がる階段は昇り口に壁も戸も無く、壁で囲まれた範囲としては隣の部屋と一続きになる。
  // そのままだと「ＬＤＫ・階段 26.6 帖（図面は 22.8 帖）」のように帖数が合わず、床の拾いにも階段の分が入る
  // 階段の範囲は上の階の図と突き合わせて初めて決まることがある（1 階の図は切断線の先が描かれない: 林様邸）ので、
  // ここでは分けずに、上下階で階段の範囲をそろえた後（splitStairRooms）に実行する
  const splitStairs = (stairsNow: Stair[]) => {
    if (plan.scan || plan.loose || (globalThis as { __NO_STAIR_ROOMS?: boolean }).__NO_STAIR_ROOMS) return;
    const trace = (globalThis as { __stairTrace?: string[] }).__stairTrace;
    const uniqStr = (xs: string[]) => [...new Set(xs)];
    /** 区画の中の点（名前を置く位置）: 升の重心にいちばん近い升 */
    const insidePoint = (l: number): Vec2 | null => {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let i = 0; i < labels.length; i++)
        if (labels[i] === l) {
          sx += i % grid.w;
          sy += (i / grid.w) | 0;
          n++;
        }
      if (!n) return null;
      const gx = sx / n;
      const gy = sy / n;
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < labels.length; i++)
        if (labels[i] === l) {
          const d = (i % grid.w - gx) ** 2 + (((i / grid.w) | 0) - gy) ** 2;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      return grid.centerOf(best % grid.w, (best / grid.w) | 0);
    };
    /** 分けた階段の範囲の升（残りの部屋の輪郭を、ここへは広げない） */
    const carvedBox = new Uint8Array(grid.w * grid.h);
    /**
     * 階段の範囲の中の壁の升（折り返しの中壁・手すり・段の線を壁と読んだもの）は階段の一部。
     * ほかの部屋・屋外との間の壁（8 升 = 160mm 以内に own 以外の区画がある）は入れない。範囲の升を carvedBox にも記す
     */
    const stairInnerOf = (st: Stair, own: Set<number>): Uint8Array => {
      const stairInner = new Uint8Array(grid.w * grid.h);
      const [x0, y0] = grid.cellOf({ x: st.minX + res / 2, y: st.minY + res / 2 });
      const [x1, y1] = grid.cellOf({ x: st.maxX - res / 2, y: st.maxY - res / 2 });
      for (let y = Math.max(0, y0); y <= Math.min(grid.h - 1, y1); y++)
        for (let x = Math.max(0, x0); x <= Math.min(grid.w - 1, x1); x++) {
          const i = y * grid.w + x;
          carvedBox[i] = 1;
          if (grid.data[i] !== WALL) continue;
          let foreign = false;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            for (let q = 1; q <= 8; q++) {
              const xx = x + dx * q;
              const yy = y + dy * q;
              if (xx < 0 || yy < 0 || xx >= grid.w || yy >= grid.h) break;
              const j = yy * grid.w + xx;
              if (grid.data[j] === WALL) continue;
              if (grid.data[j] === OUTSIDE || (labels[j] && !own.has(labels[j]))) foreign = true;
              break;
            }
            if (foreign) break;
          }
          if (!foreign) stairInner[i] = 1;
        }
      return stairInner;
    };
    for (const st of stairsNow) {
      const boxM2 = ((st.maxX - st.minX) * (st.maxY - st.minY)) / 1e6;
      if (boxM2 < 1.2 || boxM2 > 10) continue;
      // 階段の範囲にいちばん多く入っている区画（中心は折り返しの中壁の上のことがある）
      const count = new Map<number, number>();
      {
        const [x0, y0] = grid.cellOf({ x: st.minX, y: st.minY });
        const [x1, y1] = grid.cellOf({ x: st.maxX, y: st.maxY });
        for (let y = Math.max(0, y0); y <= Math.min(grid.h - 1, y1); y += 2)
          for (let x = Math.max(0, x0); x <= Math.min(grid.w - 1, x1); x += 2) {
            const l = labels[y * grid.w + x];
            if (l) count.set(l, (count.get(l) ?? 0) + 1);
          }
      }
      const l = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!l) continue;
      const rm = roomByLabel.get(l);
      const a0 = acc.get(l);
      if (!rm || !a0) continue;
      if (OUTDOOR_TYPES.includes(rm.type) || rm.type === 'void' || courtLabels.has(l)) continue;
      const inBox = (p: Vec2) => p.x > st.minX - 30 && p.x < st.maxX + 30 && p.y > st.minY - 30 && p.y < st.maxY + 30;
      // 階段の範囲の外に、階段以外の室名があること（階段だけの区画・名前の無い区画は分けない）
      const outNames = a0.names.filter((n) => n.type !== 'stairs' && !inBox(n));
      const outOthers = a0.names.length ? [] : a0.others.filter((o) => !inBox(o));
      if (!outNames.length && !outOthers.length) {
        // すでに別の区画として読めている階段: 階段と壁の間の細いすき間がホールとつながっていると、ホールの輪郭が階段を
        // 輪のように囲んで面積が二重になる。すき間を階段に含めて、両方の輪郭を引き直す（有元様邸 2 階）
        if (rm.type === 'stairs') {
          // すき間を取る相手: 部屋になっていない細い断片か、階段の前の通路・居室（収納・水まわりの小さな部屋からは取らない）
          const openTypes: RoomType[] = ['hall', 'ldk', 'living', 'dining', 'kitchen', 'entrance', 'stairs', 'bedroom', 'kids', 'study', 'japanese', 'other'];
          const touched = absorbStairRing(grid, labels, sizes, l, st, (fl) => {
            const fr = roomByLabel.get(fl);
            return !fr || (openTypes.includes(fr.type) && !courtLabels.has(fl));
          });
          if (touched.length) {
            const tS = traceLabel(l, stairInnerOf(st, new Set<number>([l, ...touched])));
            if (tS) {
              rm.polygon = tS.poly;
              rm.area = tS.area;
            }
            for (const fl of touched) {
              const fr = roomByLabel.get(fl);
              // 相手の輪郭は普通に引き直す（すき間が無くなったので、階段を囲まない）
              const tF = fr ? traceLabel(fl) : null;
              if (fr && tF) {
                fr.polygon = tF.poly;
                fr.area = tF.area;
              }
            }
            trace?.push(`${level}F 階段の区画: 階段と壁の間のすき間を階段に含めた（${touched.map((fl) => roomByLabel.get(fl)?.name ?? fl).join('・')} から）`);
          }
        }
        continue;
      }
      // 後の処理（中庭・ホールへの読み替えなど）で名前が変わっていない区画だけ、名前を付け直す
      const before = new Set(a0.names.length ? a0.names.map((n) => n.str) : a0.others.map((o) => o.str));
      const parts = rm.name.split('・');
      const untouched = parts.every((q) => before.has(q));
      const mainOut = mainName(outNames) ?? outOthers.slice().sort((p, q) => q.size - p.size)[0];
      const mainPoint = !inBox(rm.labelPos) ? rm.labelPos : mainOut ? { x: mainOut.x, y: mainOut.y } : null;
      const carved = carveStairRegion(grid, labels, sizes, l, st, { namedPoints: [...outNames, ...outOthers], mainPoint });
      trace?.push(`${level}F 階段の区画: ${rm.name}（${(rm.area / 1.62).toFixed(1)} 帖） 範囲 ${Math.round(st.minX)},${Math.round(st.minY)}-${Math.round(st.maxX)},${Math.round(st.maxY)} 外の名前 ${[...outNames, ...outOthers].map((n) => `${n.str}@${Math.round(n.x)},${Math.round(n.y)}`).join(' ')} 全部の名前 ${a0.names.map((n) => `${n.str}:${n.type}@${Math.round(n.x)},${Math.round(n.y)}`).join(' ')} → ${carved ? '分ける' : '分けない'}`);
      if (!carved) continue;
      const affected = new Set<number>([l, carved.stairLabel, ...carved.extraLabels]);
      // 階段が部屋の真ん中の島になる（残りが階段を輪のように囲む）ときは分けない: 部屋の輪郭は外周 1 本なので、
      // 残りの輪郭が階段ごと囲み、面積が二重になる
      {
        const probe = traceLabel(l, null, null);
        if (!probe || pointInPolygon({ x: (st.minX + st.maxX) / 2, y: (st.minY + st.maxY) / 2 }, probe.poly)) {
          for (let i = 0; i < labels.length; i++) if (labels[i] !== l && affected.has(labels[i])) labels[i] = l;
          for (const q of affected) if (q !== l) sizes[l] += sizes[q] ?? 0;
          sizes.length = carved.stairLabel;
          trace?.push(`${level}F 階段の区画: 残りが階段を囲むので分けない`);
          continue;
        }
      }
      collectTexts(affected);
      const stairInner = stairInnerOf(st, affected);
      // 階段の区画（名前に「階段」が入るもの＝「階段ヌック」なども階段の名前。階段下収納は別）
      const aS = acc.get(carved.stairLabel);
      const isStairName = (n: { str: string; type: RoomType }) => n.type === 'stairs' || (/階段/.test(n.str) && !/収納|物入|クローゼット|倉庫|トイレ/.test(n.str));
      const stairNames = (aS?.names ?? []).filter(isStairName);
      // 階段の範囲に入っていた、階段以外の名前（階段下収納など）は、残りの部屋の名前に付けておく
      const strayNames = (aS?.names ?? []).filter((n) => !isStairName(n)).map((n) => n.str);
      const tS = traceLabel(carved.stairLabel, stairInner);
      if (tS) {
        const lp = stairNames[0] ? { x: stairNames[0].x, y: stairNames[0].y } : insidePoint(carved.stairLabel) ?? { x: (st.minX + st.maxX) / 2, y: (st.minY + st.maxY) / 2 };
        const sr: Room = {
          id: `F${level}-R${rooms.length + 1}`,
          name: stairNames.length ? uniqStr(stairNames.map((n) => n.str)).join('・') : '階段',
          type: 'stairs',
          polygon: tS.poly,
          area: tS.area,
          labelPos: lp,
          // 「階段ヌック（3帖）」のように、階段そのものに帖数が書いてあるときだけ
          labeledTatami: stairNames.length && !strayNames.length ? aS?.tatami : undefined,
          stairDir: aS?.stair ?? (st.goesUp ? 'up' : 'down'),
        };
        labelOfRoom.set(rooms.length, carved.stairLabel);
        roomByLabel.set(carved.stairLabel, sr);
        rooms.push(sr);
      }
      // 残りの主な区画（元の部屋）
      const t0 = traceLabel(l, null, carvedBox);
      if (t0) {
        rm.polygon = t0.poly;
        rm.area = t0.area;
      }
      const a1 = acc.get(l);
      if (untouched && a1 && (a1.names.length || a1.others.length)) {
        const real = a1.names.filter((n) => !isStairName(n));
        if (real.length) {
          const main = mainName(real, rm.area)!;
          rm.name = uniqStr([main.str, ...real.map((n) => n.str), ...strayNames]).join('・');
          rm.type = level >= 2 && (main.type === 'deck' || main.type === 'terrace' || main.type === 'carport' || main.type === 'parking') ? 'balcony' : main.type;
          rm.labelPos = { x: main.x, y: main.y };
        } else if (!a1.names.length && a1.others.length) {
          const main = a1.others.slice().sort((p, q) => q.size - p.size)[0];
          rm.name = uniqStr(a1.others.map((n) => n.str)).slice(0, 2).join('・');
          rm.type = 'other';
          rm.labelPos = { x: main.x, y: main.y };
        }
        rm.labeledTatami = a1.tatami;
        delete rm.stairDir;
      } else {
        const stripped = parts.filter((q) => classifyRoomName(q) !== 'stairs');
        if (stripped.length && stripped.length < parts.length) rm.name = stripped.join('・');
        if (rm.type === 'stairs' && stripped.length) rm.type = classifyRoomName(stripped[0]) ?? 'other';
        // 階段があるので「階段」と名付けていた区画: 階段を抜いた残りは、階段の前のホール
        if (!stripped.length) {
          rm.name = 'ホール';
          rm.type = 'hall';
          rm.inferred = true;
        }
        delete rm.stairDir;
      }
      // 名前の位置が自分の区画に無ければ、区画の中へ（部屋と区画の対応を保つ）
      if (labelAt(rm.labelPos) !== l) {
        const p = insidePoint(l);
        if (p) rm.labelPos = p;
      }
      roomByLabel.set(l, rm);
      // 階段の向こう側に離れた区画（名前のあるもの・広いもの）
      for (const el of carved.extraLabels) {
        if ((sizes[el] ?? 0) < minCells) continue;
        const tE = traceLabel(el, null, carvedBox);
        if (!tE) continue;
        const aE = acc.get(el);
        const real = (aE?.names ?? []).filter((n) => n.type !== 'stairs');
        let er: Room;
        if (real.length) {
          const main = mainName(real, tE.area)!;
          er = { id: '', name: uniqStr([main.str, ...real.map((n) => n.str)]).join('・'), type: main.type, polygon: tE.poly, area: tE.area, labelPos: { x: main.x, y: main.y }, labeledTatami: aE?.tatami };
        } else if (aE?.others.length) {
          const main = aE.others.slice().sort((p, q) => q.size - p.size)[0];
          er = { id: '', name: uniqStr(aE.others.map((n) => n.str)).slice(0, 2).join('・'), type: 'other', polygon: tE.poly, area: tE.area, labelPos: { x: main.x, y: main.y }, labeledTatami: aE.tatami };
        } else {
          // 名前の無い広い残り: 階段の先の通路
          er = { id: '', name: 'ホール', type: 'hall', polygon: tE.poly, area: tE.area, labelPos: insidePoint(el) ?? tE.poly[0], inferred: true };
        }
        if (labelAt(er.labelPos) !== el) er.labelPos = insidePoint(el) ?? er.labelPos;
        er.id = `F${level}-R${rooms.length + 1}`;
        labelOfRoom.set(rooms.length, el);
        roomByLabel.set(el, er);
        rooms.push(er);
      }
      trace?.push(`${level}F 階段の区画を分けた: ${parts.join('・')} → ${rm.name}（${(rm.area / 1.62).toFixed(1)} 帖）＋階段（${tS ? (tS.area / 1.62).toFixed(1) : '-'} 帖）${carved.extraLabels.length ? ` ＋別の区画 ${carved.extraLabels.length}` : ''}${carved.joinedCells ? ` 階段に含めた残り ${((carved.joinedCells * res * res) / 1e6).toFixed(1)}㎡` : ''}`);
    }
  };

  if (!rooms.length) warnings.push(`${level}階: 部屋を検出できませんでした`);
  // 設計士のメモ（室名より小さい文字の説明文）
  const labelSizes = rooms.map((r) => plan.texts.find((t) => Math.abs(t.x - r.labelPos.x) < 50 && Math.abs(t.y - r.labelPos.y) < 50)?.size ?? 0).filter((s) => s > 0).sort((a, b) => a - b);
  const labelSize = labelSizes.length ? labelSizes[Math.floor(labelSizes.length / 2)] : 280;
  const nearTexts = plan.siteTexts.filter((t) => t.x > plan.bbox.minX - 3000 && t.x < plan.bbox.maxX + 3000 && t.y > plan.bbox.minY - 3000 && t.y < plan.bbox.maxY + 3000 && !plan.texts.some((u) => u.x === t.x && u.y === t.y));
  const notes = plan.scan ? [] : detectNotes([...plan.texts, ...nearTexts], labelSize, rooms);
  // 家具・設備・車・植栽の記号（スキャン図面には無い）。階段の範囲の線（段・手すり）は家具の記号ではない
  // （コの字階段の段の線が「ソファ＋丸テーブル」として読まれ、本物の L 型ソファが「LDK にソファは 1 つ」で落ちていた）
  const inStair = (p: Vec2) => stairs.some((st) => p.x > st.minX - 100 && p.x < st.maxX + 100 && p.y > st.minY - 100 && p.y < st.maxY + 100);
  const symbolsOut = symbols.filter((s) => s.kind === 'car' || !inStair({ x: s.x, y: s.y }));
  const sym = plan.scan || plan.loose ? { items: [], exterior: { cars: [], trees: [] } } : symbolsToItems(symbolsOut, rooms, outWalls, outline, level, (globalThis as { __symTrace?: string[] }).__symTrace);
  // 文脈読み（部屋の種類・大きさ・壁からの位置・隣の物との関係）。同じ部屋で同じ種類を読めたら、形の決め打ちの結果より優先する
  const g = globalThis as { __symbolDict?: SymbolSignature[]; __ctxTrace?: string[]; __dashTrace?: string[] };
  const dashRects = dashed
    .filter((o) => {
      const L = Math.max(o.maxX - o.minX, o.maxY - o.minY);
      const S = Math.min(o.maxX - o.minX, o.maxY - o.minY);
      return L >= 400 && L <= 3600 && S >= 280 && S <= 2400;
    })
    .map((o) => ({ minX: o.minX, minY: o.minY, maxX: o.maxX, maxY: o.maxY, inner: 0, innerRects: 0, arcs: 0, width: 0, dashed: true }));
  if (g.__dashTrace) for (const o of dashed) g.__dashTrace.push(`${level}F 破線の輪郭 ${Math.round(o.maxX - o.minX)}x${Math.round(o.maxY - o.minY)} n=${o.n} @${Math.round((o.minX + o.maxX) / 2)},${Math.round((o.minY + o.maxY) / 2)}`);
  const ctx = plan.scan || plan.loose ? null : readContextItems(uniqueSegs(plan.segs), plan.arcs, rooms, outWalls, level, g.__symbolDict, sym.items, dashRects);
  if (ctx) {
    ctx.items = ctx.items.filter((it) => !inStair({ x: it.x, y: it.y }));
    ctx.candidates = ctx.candidates.filter((cd) => !inStair({ x: cd.cx, y: cd.cy }));
  }
  if (ctx && g.__ctxTrace) g.__ctxTrace.push(...ctx.trace.map((t) => `${level}F ${t}`));
  // 同じ部屋で同じ種類を文脈読みが読めたら、形の決め打ちの方は外す（食卓はキッチンと兼ねて読むことがあるので、キッチンを読んだ部屋の食卓も）
  const taken = new Set((ctx?.items ?? []).flatMap((it) => (it.kind === 'kitchen' ? [`${it.roomId}:kitchen`, `${it.roomId}:dining`] : [`${it.roomId}:${it.kind}`])));
  const merged0 = [...(ctx?.items ?? []), ...sym.items.filter((it) => !(it.roomId && taken.has(`${it.roomId}:${it.kind}`)))];
  // 常識で整理（LDK に食卓 2 つ、玄関に便器…は読み違い）
  const sensed = senseFurniture(merged0, rooms);
  if (sensed.removed.length && g.__ctxTrace) g.__ctxTrace.push(...sensed.removed.map((t) => `${level}F 整理: ${t}`));
  const mergedItems = sensed.items;
  void (null as FurnitureKind | null);
  // 車の記号からガレージと分かった区画も含める（記号の読み取りの後）
  // ガレージの建て方: 家の外形の中ならビルトイン、外形に接していれば後付け、離れていれば離れのガレージ
  for (const r of rooms) {
    if (r.type !== 'garage' || r.garageKind) continue;
    const c = r.polygon.reduce((a0, q) => ({ x: a0.x + q.x / r.polygon.length, y: a0.y + q.y / r.polygon.length }), { x: 0, y: 0 });
    if (outline.some((l) => pointInPolygon(c, l))) {
      r.garageKind = 'builtin';
      continue;
    }
    let d = Infinity;
    for (const l of outline) for (const q of r.polygon) for (let i = 0; i < l.length; i++) d = Math.min(d, distPointSegment(q, l[i], l[(i + 1) % l.length]));
    r.garageKind = d <= 600 ? 'attached' : 'detached';
  }
  // ビルトインガレージの壁の無い辺（シャッター）に、外壁＋シャッターの開口を足す（壁だけから描き直しても消えないように）
  if (ensureGarageShutters(outWalls, openings, rooms, level)) warnings.push(`${level}階: ガレージの壁の無い辺にシャッターを置きました（違えば方眼の「シャッター」で直せます）`);
  // 帖数との照合: 開口付きの壁で分かれた LDK などを同じ部屋に（池本様邸の ＬＤＫ 24.7 帖 → 15.3 帖 ＋ pantry① 11.8 帖）
  {
    const rec = reconcileTatami(rooms, outWalls, openings, level);
    warnings.push(...rec.warnings);
    // 分かれた LDK の区画に役割（キッチン側／リビング側）。図面のキッチンの記号がある方がキッチン側
    for (const t of assignLdkRoles(rooms, rec.renamed, mergedItems, plan.texts)) warnings.push(`${level}階 ${t}`);
  }
  // 天井高の注記（「天井高2.6m」「CH=2400」）はその部屋だけの天井高
  // 室名から分かる床の段差（小上がり畳コーナー +400、ダウンリビング −400）
  for (const r of rooms) {
    const off = floorOffsetByName(r.name);
    if (off != null && r.floorOffset == null) r.floorOffset = off;
  }
  for (const c of applyCeilingNotes(rooms, plan.texts)) {
    const r = rooms.find((x) => x.id === c.roomId)!;
    notes.push({ text: `${r.name}: 天井高 ${c.ch} mm（図面の注記）`, x: r.labelPos.x, y: r.labelPos.y, roomId: r.id });
  }
  // 戸・シャッター・玄関ドアが読めなかった部屋を常識で補う（吉田様邸: 2 階の洋室・トイレに戸が無い、玄関ドア・シャッターが無い）
  for (const t of hints?.noAutoOpenings ? [] : ensureOpenings(outWalls, openings, rooms, level)) {
    warnings.push(t);
    const rm = rooms.find((r) => t.startsWith(`${level}階 ${r.name}:`));
    if (rm) notes.push({ text: t.replace(/^\d+階 /, ''), x: rm.labelPos.x, y: rm.labelPos.y, roomId: rm.id });
  }
  const floorOut: Floor = {
    level,
    elevation: 0,
    height: 2900,
    ceilingHeight: 2400,
    walls: outWalls,
    openings,
    rooms,
    stairs,
    outline,
    planItems: mergedItems.length ? mergedItems : undefined,
    symbolCandidates: ctx?.candidates.length ? ctx.candidates : undefined,
    exterior: sym.exterior.cars.length || sym.exterior.trees.length ? sym.exterior : undefined,
    notes: notes.length ? notes : undefined,
  };
  stairRoomSplitters.set(floorOut, () => {
    // 部屋の一覧が差し替えられていたら（離れの統合など）触らない
    if (floorOut.rooms === rooms) splitStairs(floorOut.stairs);
    (globalThis as { __roomTrace?: string[] }).__roomTrace?.push(`${level}F 階段を分けた後: ${rooms.map((r) => `${r.name}:${(r.area / 1.62).toFixed(1)}[${r.polygon.map((q) => `${Math.round(q.x)},${Math.round(q.y)}`).join(' ')}]`).join(' | ')}`);
  });
  (globalThis as { __roomTrace?: string[] }).__roomTrace?.push(`${level}F buildFloor: ${rooms.map((r) => `${r.name}:${(r.area / 1.62).toFixed(1)}[${r.polygon.map((q) => `${Math.round(q.x)},${Math.round(q.y)}`).join(' ')}]`).join(' | ')}`);
  return floorOut;
}

/** 階ごとの「階段を隣の部屋から分ける」処理（buildFloor が登録する。升目を持っているので、座標を動かす前に呼ぶ） */
const stairRoomSplitters = new WeakMap<Floor, () => void>();

/**
 * LDK・ホール・パントリーと一続きに読めた階段を、「階段」という別の部屋に分ける（その階の rooms を書き換える）。
 * 上下階で階段の範囲をそろえた後・格子へ寄せる前に 1 回だけ呼ぶ
 */
export function splitStairRooms(f: Floor): void {
  const run = stairRoomSplitters.get(f);
  if (!run) return;
  stairRoomSplitters.delete(f);
  run();
}

/** 方位記号から真北を読む（north.ts）。候補の点数がいちばん高いものを返す */
export function detectCompass(p: PageMm): number | null {
  const tr = (globalThis as { __compassTrace?: string[] }).__compassTrace;
  const cands = northCandidates(p, tr);
  const c = cands[0];
  tr?.push(...cands.map((o) => `${o.how} deg=${o.deg} score=${o.score} at=(${o.at.x.toFixed(0)},${o.at.y.toFixed(0)})`));
  return c && c.score >= 3 ? c.deg : null;
}

export function detectNorth(pages: PageMm[]): number | null {
  const c = pickNorth(pages);
  return c ? c.deg : null;
}

/**
 * 部屋の形をした塗り: 頂点が少なく、辺が 45° の倍数の向き。
 * カラー平面図の床のグラデーション（同心円の塗り）や家具の曲線は除く。
 */
function isRoomShaped(poly: Vec2[]): boolean {
  // ほぼ同じ点の重複を除く
  const pts = poly.filter((q, i) => i === 0 || Math.hypot(q.x - poly[i - 1].x, q.y - poly[i - 1].y) > 30);
  if (pts.length < 3 || pts.length > 14) return false;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 30) continue;
    const deg = (((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI) % 45 + 45) % 45;
    if (Math.min(deg, 45 - deg) > 3) return false;
  }
  return true;
}

/** 細長い帯状の塗り（手すり壁・腰壁・曲面の壁など）: 幅 40〜180mm、長さ 600mm 以上 */
function isStripFill(poly: Vec2[]): boolean {
  const area = Math.abs(polygonArea(poly));
  let per = 0;
  for (let i = 0; i < poly.length; i++) per += Math.hypot(poly[(i + 1) % poly.length].x - poly[i].x, poly[(i + 1) % poly.length].y - poly[i].y);
  if (per < 1200) return false;
  const width = (2 * area) / per;
  return width >= 40 && width <= 180 && per / 2 >= 600;
}

/** 塗りの太さ（面積 ÷ 周長の半分）。細長い帯なら幅、矩形なら 幅×長さ÷(幅+長さ) */
export function fillWidth(poly: Vec2[]): number {
  let per = 0;
  for (let i = 0; i < poly.length; i++) per += Math.hypot(poly[(i + 1) % poly.length].x - poly[i].x, poly[(i + 1) % poly.length].y - poly[i].y);
  return per > 0 ? (2 * Math.abs(polygonArea(poly))) / per : 0;
}

/** 壁の塗りとして扱う太さの上限 (mm)。壁の塗りは壁の厚み（提案図で 40〜120mm、RC・1/50 でも 250mm まで）しか無い */
const WALL_FILL_MAX_W = 260;
/** これより太い塗りは、壁の色でも壁として塗らない（部屋・造作の塗り。600 角の柱は 300 なので壁のまま） */
const WALL_FILL_FAT_W = 400;

/**
 * 壁の塗りの色: その色の塗りの頂点の大半が検出した壁の上にあり、塗りの大半が壁の厚みしか無い色。
 *
 * 部屋の形の塗りも頂点は壁の上にあるので、太さで見分ける。奥行 455mm の収納の塗りは太さ 300〜340mm になる
 * （田中様邸: 収納 5 か所を桃色で塗った図面で、桃色が「壁の色」になり、物入・パントリーがまるごと壁として塗られて部屋が消えていた）。
 * 室名・帖数の入った塗りは部屋なので、1 つでもあればその色は壁の色ではない
 */
export function wallFillColors(fills: { poly: Vec2[]; color: string }[], walls: { a: Vec2; b: Vec2; d: number }[], labelPoints: Vec2[] = []): Set<string> {
  const stat = new Map<string, { n: number; on: number; polys: number; thin: number; room: boolean }>();
  for (const f of fills) {
    const st = stat.get(f.color) ?? { n: 0, on: 0, polys: 0, thin: 0, room: false };
    st.polys++;
    const wd = fillWidth(f.poly);
    if (wd > 0 && wd <= WALL_FILL_MAX_W) st.thin++;
    else if (!st.room && wd > WALL_FILL_MAX_W && labelPoints.length) {
      const bb = bboxOf(f.poly);
      if (labelPoints.some((t) => t.x > bb.minX && t.x < bb.maxX && t.y > bb.minY && t.y < bb.maxY && pointInPolygon(t, f.poly))) st.room = true;
    }
    for (const q of f.poly) {
      st.n++;
      if (walls.some((w) => distPointSegment(q, w.a, w.b) <= w.d / 2 + 40)) st.on++;
    }
    stat.set(f.color, st);
  }
  const out = new Set<string>();
  for (const [c, st] of stat) if (st.polys >= 5 && !st.room && st.on / st.n >= 0.6 && st.thin / st.polys >= 0.6) out.add(c);
  return out;
}

/**
 * 壁ではない塗りの色: 壁の色でなく、その色の塗りの面積の 7 割以上が「太い塗り」（部屋・階段の段・造作・家具の形）の色。
 * 細い帯ばかりの色（柱・腰壁・手すり壁かもしれない）は入れない
 */
export function softFillColors(fills: { poly: Vec2[]; color: string }[], wallColors: Set<string>): Set<string> {
  const stat = new Map<string, { fat: number; all: number }>();
  for (const f of fills) {
    if (wallColors.has(f.color)) continue;
    const st = stat.get(f.color) ?? { fat: 0, all: 0 };
    const a = Math.abs(polygonArea(f.poly));
    st.all += a;
    if (fillWidth(f.poly) > WALL_FILL_MAX_W) st.fat += a;
    stat.set(f.color, st);
  }
  const out = new Set<string>();
  for (const [c, st] of stat) if (st.all > 0 && st.fat / st.all >= 0.7) out.add(c);
  return out;
}

/**
 * 図面に描かれた壁（壁の色の細長い塗り）を、検出した壁がどれだけ説明しているか:
 * 塗りの長い辺（300 mm 以上）の上の点（1/4・1/2・3/4）のうち、検出した壁の面の近くにある点の数
 */
export function wallStripCoverage(fills: { poly: Vec2[]; color: string }[], wallColors: Set<string>, walls: { a: Vec2; b: Vec2; d: number }[]): { n: number; on: number } {
  let n = 0;
  let on = 0;
  for (const f of fills) {
    if (!wallColors.has(f.color)) continue;
    const wd = fillWidth(f.poly);
    if (wd <= 0 || wd > WALL_FILL_MAX_W) continue;
    for (let i = 0; i < f.poly.length; i++) {
      const a = f.poly[i];
      const b = f.poly[(i + 1) % f.poly.length];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 300) continue;
      for (const t of [0.25, 0.5, 0.75]) {
        const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        n++;
        if (walls.some((w) => distPointSegment(q, w.a, w.b) <= w.d / 2 + 40)) on++;
      }
    }
  }
  return { n, on };
}

/**
 * ページが何の図面か（見出しと室名から）。
 * 吉田大仁様邸 1st プラン: 2 ページ目の立面図 4 面の外壁の線が平面図の区画のように見え、3〜7 階として読まれていた（「4 階・6 階」が残った）。
 * - elevation: 「立面図・断面図・矩計図・展開図」の見出しがあり「平面図」が無く、室名がほとんど無い → 平面図としては読まない（高さの寸法は別に読む）
 * - other: 他のページに室名があるのに、このページには室名も「平面図」の見出しも無い（表・図面枠・配置図など）
 * - plan: それ以外
 */
export function pageDrawingKind(texts: { str: string }[], opts: { raster?: boolean; docHasRooms: boolean; multiPage: boolean }): 'plan' | 'elevation' | 'other' {
  if (opts.raster) return 'plan';
  const norm = texts.map((t) => normalizeText(t.str));
  const hasPlanTitle = norm.some((s) => /平面図|平面|PLAN/.test(s));
  const hasElevTitle = norm.some((s) => /立面図|断面図|矩計図|展開図/.test(s));
  const roomTextN = texts.filter((t) => classifyRoomName(t.str) != null || parseAreaLabel(t.str) != null).length;
  if (hasElevTitle && !hasPlanTitle && roomTextN < 3) return 'elevation';
  if (opts.multiPage && opts.docHasRooms && roomTextN === 0 && !hasPlanTitle) return 'other';
  return 'plan';
}

/** 同じページに平面図と立面図が並ぶとき: 区画にいちばん近い図面名が「立面図・断面図」なら、その区画は平面図ではない */
function nearestTitleIsElevation(bbox: BBox, texts: MmText[]): boolean {
  const w = bbox.maxX - bbox.minX;
  const hgt = bbox.maxY - bbox.minY;
  let best: { d: number; elev: boolean } | null = null;
  for (const t of texts) {
    const s = normalizeText(t.str);
    const elev = /立面図|断面図|矩計図|展開図/.test(s);
    if (!elev && !/平面図|PLAN/.test(s)) continue;
    const dx = Math.max(0, bbox.minX - t.x, t.x - bbox.maxX);
    const dy = Math.max(0, bbox.minY - t.y, t.y - bbox.maxY);
    if (dx > w * 0.3 || dy > hgt * 0.8) continue;
    const d = dx * 3 + dy;
    if (!best || d < best.d) best = { d, elev };
  }
  return !!best?.elev;
}

export function detectPlans(pages: PageMm[], warnings: string[]): PlanData[] {
  const plans: PlanData[] = [];
  const isRoomText = (t: MmText) => classifyRoomName(t.str) != null || parseAreaLabel(t.str) != null;
  const docHasRooms = pages.some((pg) => pg.texts.some(isRoomText));
  // 図面枠の「図面名」が平面図以外（配置図・求積図・立面図・断面図・展開図・仕上表…）のページは、他に平面図のページがあれば読まない
  // （意匠図一式で、建物の形と室名の入った配置図が「3 階」として読まれていた）
  const tbKind = pages.map((pg) => titleBlockKind(pg.texts));
  const NOT_PLAN = new Set(['site', 'area', 'elevation', 'section', 'interior', 'finish', 'fixture', 'location', 'index', 'roof', 'structure']);
  const hasPlanPage = pages.some((pg, i) => tbKind[i] === 'plan' || (tbKind[i] == null && pg.texts.some(isRoomText)));
  for (const page of pages) {
    const tk = tbKind[pages.indexOf(page)];
    if (tk && NOT_PLAN.has(tk) && hasPlanPage && pages.length > 1) {
      warnings.push(`${page.pageIndex + 1}ページ目: 図面名が「${PAGE_KIND_LABEL[tk as keyof typeof PAGE_KIND_LABEL]}」のページなので平面図としては読みません`);
      continue;
    }
    const kind = pageDrawingKind(page.texts, { raster: !!page.rasterMask, docHasRooms, multiPage: pages.length > 1 });
    if (kind === 'elevation') {
      warnings.push(`${page.pageIndex + 1}ページ目: 立面図・断面図のページなので平面図としては読みません（高さの寸法は使います）`);
      continue;
    }
    if (kind === 'other') {
      warnings.push(`${page.pageIndex + 1}ページ目: 室名の無いページ（表・図面枠・配置図など）は平面図としては読みません`);
      continue;
    }
    const pageExt =
      page.segs.length >= 50 || !page.rasterMask
        ? bboxOf(page.segs.flatMap((sg) => [sg.a, sg.b]))
        : { minX: 0, minY: 0, maxX: page.rasterMask.w * page.rasterMask.res, maxY: page.rasterMask.h * page.rasterMask.res };
    let ww = makeWalls(detectWalls(page.segs, page.arcs, (globalThis as { __wallBands?: boolean }).__wallBands ? { bands: true } : {}, page.masks));
    joinWalls(ww);
    let groups = clusterPlans(ww, pageExt);
    let sketchHeavy: Seg[] | null = null;
    let loose = false;
    let scan = false;
    // スキャン図面: 画像の太い線から壁を検出する
    if (!groups.length && page.rasterMask) {
      // 細い線は画像の段階で消してあるので、残った帯はすべて壁（最小の厚みは画素数で決める）
      const det2 = detectWallsRasterAuto(page.rasterMask, { closeRadius: 1, minThickness: page.rasterMask.res * 2.5, maxThickness: 400 });
      if (det2) {
        const w2 = makeWalls(det2);
        joinWalls(w2);
        const g2 = clusterPlans(w2, pageExt, 1200, 600);
        if (g2.length) {
          ww = w2;
          groups = g2;
          loose = true;
          scan = true;
        }
      }
    }
    // 平行線として壁が取れない図面（手描き風の線・揺れのある線）は、太線を画像にして帯として検出する
    if (!groups.length) {
      const det2 = rasterWallDetection(page);
      if (det2) {
        const w2 = makeWalls(det2);
        joinWalls(w2);
        // 窓などで壁が途切れやすいので、近い図はまとめる
        const g2 = clusterPlans(w2, pageExt, 1200, 600, page.segs.filter((sg) => sg.source === 'stroke'));
        if (g2.length) {
          ww = w2;
          groups = g2;
          loose = true;
          const st = page.segs.filter((sg) => !sg.dashed && sg.source === 'stroke');
          const hT = heavyWidthThreshold(st);
          sketchHeavy = hT == null ? st : st.filter((sg) => sg.width >= hT);
        }
      }
    }
    if ((globalThis as any).__DBG_PLANS) {
      ((globalThis as any).__DBG_PAGES ??= []).push(page);
      ((globalThis as any).__DBG_CLUSTERS ??= []).push(...groups.map((g) => ({ page: page.pageIndex, walls: g })));
      ((globalThis as any).__DBG_WALLS ??= []).push({ page: page.pageIndex, walls: ww.map((w) => ({ a: w.a, b: w.b, d: w.d })), ext: pageExt, texts: page.texts.filter((t) => /階|平面|プラン|提案/.test(t.str)).map((t) => ({ x: Math.round(t.x), y: Math.round(t.y), s: t.str })) });
      const lens = ww.map((w) => w.t1 - w.t0);
      console.log('walls', ww.length, 'len<300', lens.filter((l) => l < 300).length, '<1000', lens.filter((l) => l >= 300 && l < 1000).length, '>=1000', lens.filter((l) => l >= 1000).length, 'd', ww.slice(0, 12).map((w) => Math.round(w.d)).join('/'));
    }
    const roomLabelPts = page.texts.filter(isRoomText).map((t) => ({ x: t.x, y: t.y }));
    let wallColors = wallFillColors(page.colorFills, ww, roomLabelPts);
    // 壁を色の塗りで描く図面: 図面に描かれた壁（壁の色の細長い塗り）を取りこぼしていたら、
    // 壁ではない色（部屋・階段の段・造作）の塗りの輪郭を壁面の候補から外して読み直す。
    // 壁の両側に階段の色の帯が並ぶ所で、本物の壁の線の組が「帯に挟まれた入れ子」として捨てられる（有元様邸 2 階:
    // 寝室と階段ホールの間の壁 4.6 m と、2 つの階段の間の壁・引込み戸が消えていた）。取りこぼしの無い図面は 1 回目のまま
    if (wallColors.size && !loose && !scan && !(globalThis as { __NO_SOFT_FILLS?: boolean }).__NO_SOFT_FILLS) {
      const soft = softFillColors(page.colorFills, wallColors);
      const cov1 = wallStripCoverage(page.colorFills, wallColors, ww);
      if (soft.size && cov1.n >= 20 && cov1.on < cov1.n) {
        const ww2 = makeWalls(detectWalls(page.segs, page.arcs, { ...((globalThis as { __wallBands?: boolean }).__wallBands ? { bands: true } : {}), softFillColors: soft }, page.masks));
        joinWalls(ww2);
        const cov2 = wallStripCoverage(page.colorFills, wallColors, ww2);
        (globalThis as { __softTrace?: string[] }).__softTrace?.push(`p${page.pageIndex + 1} 壁の塗りの縁 ${cov1.n} 点: 1 回目 ${cov1.on}・読み直し ${cov2.on}（壁 ${ww.length} → ${ww2.length}）soft=${[...soft].join(',')}`);
        // 読み直しのほうが、描かれた壁を 1% 以上多く説明できるときだけ切り替える
        if (cov2.on > cov1.on + Math.max(2, cov1.n * 0.01)) {
          const g2 = clusterPlans(ww2, pageExt);
          if (g2.length >= groups.length) {
            ww = ww2;
            groups = g2;
            wallColors = wallFillColors(page.colorFills, ww, roomLabelPts);
          }
        }
      }
    }
    if (!groups.length && !page.rasterMask) warnings.push(`${page.pageIndex + 1}ページ目: 平面図の壁を検出できませんでした`);
    // 平面図でないもの（立面図・図面枠・表・カタログ）を除く
    const pageHasRooms = page.texts.some(isRoomText);
    const boxes = groups.map((g) => bboxOf(g.flatMap((w) => [w.a, w.b])));
    const ext = pageExt;
    const inside = (a: BBox, b: BBox) => a.minX >= b.minX - 50 && a.maxX <= b.maxX + 50 && a.minY >= b.minY - 50 && a.maxY <= b.maxY + 50;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const bbox = boxes[gi];
      // 他の図を丸ごと囲む（図面枠・敷地の枠など）、ページ全体に広がる枠
      const dbg = (globalThis as any).__DBG_PLANS;
      if (dbg) console.log('cluster', gi, g.length, Math.round(bbox.maxX - bbox.minX), Math.round(bbox.maxY - bbox.minY), 'ext', Math.round(ext.maxX - ext.minX), Math.round(ext.maxY - ext.minY), 'contains', boxes.some((b, j) => j !== gi && inside(b, bbox)));
      if (boxes.some((b, j) => j !== gi && inside(b, bbox))) continue;
      if (bbox.maxX - bbox.minX > (ext.maxX - ext.minX) * 0.8 && bbox.maxY - bbox.minY > (ext.maxY - ext.minY) * 0.8) continue;
      // 室名・帖数が1つも無い（立面図・表など）
      const roomTexts = page.texts.filter((t) => t.x > bbox.minX && t.x < bbox.maxX && t.y > bbox.minY && t.y < bbox.maxY && isRoomText(t)).length;
      if (pageHasRooms && roomTexts === 0) continue;
      // 平面図と立面図が同じページに並ぶ図面: 立面図の見出しが付く区画は読まない
      if (roomTexts === 0 && nearestTitleIsElevation(bbox, page.texts)) continue;
      const margin = 400;
      const inBox = (x: number, y: number, m: number) => x > bbox.minX - m && x < bbox.maxX + m && y > bbox.minY - m && y < bbox.maxY + m;
      const texts = page.texts.filter((t) => inBox(t.x, t.y, margin));
      const segs = page.segs.filter((s) => inBox((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, margin));
      const siteTexts = page.texts.filter((t) => inBox(t.x, t.y, 30000));
      const siteSegs = page.segs.filter((s) => inBox(s.a.x, s.a.y, 30000) || inBox(s.b.x, s.b.y, 30000));
      const wallPolys = page.colorFills
        // 壁の色でも、太い塗り（部屋・造作の形）は壁として塗らない
        .filter((f) => f.poly.every((q) => inBox(q.x, q.y, margin)) && ((wallColors.has(f.color) && fillWidth(f.poly) <= WALL_FILL_FAT_W) || isStripFill(f.poly)))
        .map((f) => f.poly);
      const sashPolys = page.masks.filter((poly) => {
        if (!poly.every((q) => inBox(q.x, q.y, margin))) return false;
        const b = bboxOf(poly);
        const w = b.maxX - b.minX;
        const h = b.maxY - b.minY;
        const thin = Math.min(w, h);
        const long = Math.max(w, h);
        return thin >= 40 && thin <= 220 && long >= 500;
      });
      const labelTexts = texts.filter((t) => {
        const nm = cleanRoomName(t.str);
        return (nm && classifyRoomName(nm) != null) || parseAreaLabel(t.str) != null || /階段/.test(t.str);
      });
      // グラデーションは同じ部屋の中で少しずつ小さくなる矩形の重ね塗りで描かれるので、
      // 同じ室名を含む入れ子の塗りは一番外側だけを使う
      const roomFills: Vec2[][] = [];
      const cand = page.colorFills
        .filter((f) => !wallColors.has(f.color) && !isStripFill(f.poly) && f.poly.every((q) => inBox(q.x, q.y, margin)))
        .map((f) => ({ poly: f.poly, area: Math.abs(polygonArea(f.poly)) / 1e6, bb: bboxOf(f.poly) }))
        .filter((c) => c.area >= 0.6 && c.area <= 150 && isRoomShaped(c.poly))
        .map((c) => ({ ...c, labels: labelTexts.filter((t) => pointInPolygon({ x: t.x, y: t.y }, c.poly)) }))
        // 80㎡ を超える塗りは車庫・カーポートだけ
        .filter((c) => c.labels.length && (c.area <= 80 || c.labels.some((t) => classifyRoomName(t.str) === 'garage')))
        .sort((a, b) => b.area - a.area);
      const kept: typeof cand = [];
      for (const c of cand) {
        const inner = kept.some(
          (k) =>
            c.bb.minX >= k.bb.minX - 60 && c.bb.maxX <= k.bb.maxX + 60 && c.bb.minY >= k.bb.minY - 60 && c.bb.maxY <= k.bb.maxY + 60 &&
            c.labels.every((t) => k.labels.includes(t)),
        );
        if (inner) continue;
        kept.push(c);
        roomFills.push(c.poly);
      }
      const sketchLines = sketchHeavy ? sketchHeavy.filter((sg) => inBox(sg.a.x, sg.a.y, margin) && inBox(sg.b.x, sg.b.y, margin)) : undefined;
      plans.push({ pageIndex: page.pageIndex, bbox, floorHint: null, walls: g, texts, segs, arcs: page.arcs, siteTexts, siteSegs, wallPolys, sashPolys, roomFills, sketchLines, loose, scan });
    }
  }
  assignFloorTitles(plans, pages);
  // 玄関のある図は 1 階（見出しが図面名欄にしか無く、別の図に 1 階が割り当たっていたら入れ替える）
  for (const page of pages) {
    const onPage = plans.filter((p) => p.pageIndex === page.pageIndex);
    if (onPage.length < 2) continue;
    const hasEntrance = (p: PlanData) => p.texts.some((t) => {
      const nm = cleanRoomName(t.str);
      return nm != null && classifyRoomName(nm) === 'entrance' && !/吹抜|上部/.test(t.str);
    });
    const ent = onPage.filter(hasEntrance);
    if (ent.length !== 1 || ent[0].floorHint === 1) continue;
    const other = onPage.find((p) => p.floorHint === 1);
    const old = ent[0].floorHint;
    ent[0].floorHint = 1;
    if (other) other.floorHint = old != null && old !== 1 ? old : 2;
  }
  // 見出しの無い図が、見出しのある図のすぐ近く（吹抜などで分かれた同じ階の一部）にあればまとめる
  for (const p of plans.slice()) {
    if (p.floorHint != null) continue;
    const near = plans
      .filter((q) => q !== p && q.pageIndex === p.pageIndex && q.floorHint != null)
      .map((q) => ({ q, gap: bboxGap(p.bbox, q.bbox) }))
      .filter((o) => o.gap < 3000)
      .sort((a, b) => a.gap - b.gap)[0];
    if (!near) continue;
    const q = near.q;
    // 室名が 2 つ以上重なる離れた図は、同じ階の一部ではなく別案・部分図（池本様の 2 階の脇に描かれた変更案が 2 階に合体し、漫画部屋・吹抜が 2 つずつになっていた）
    const namesOf = (pl: PlanData) => new Set(pl.texts.map((t) => cleanRoomName(t.str)).filter((n): n is string => !!n && classifyRoomName(n) != null));
    const np = namesOf(p);
    const nq = namesOf(q);
    let dup = 0;
    for (const n of np) if (nq.has(n)) dup++;
    if (dup >= 2 && near.gap > 300) {
      plans.splice(plans.indexOf(p), 1);
      warnings.push(`${p.pageIndex + 1}ページ目: ${near.q.floorHint}階の脇の小さな図（変更案・部分図）は読み飛ばしました`);
      continue;
    }
    q.walls.push(...p.walls);
    const seen = new Set(q.texts);
    q.texts.push(...p.texts.filter((t) => !seen.has(t)));
    q.segs.push(...p.segs);
    q.arcs.push(...p.arcs);
    q.wallPolys.push(...p.wallPolys);
    q.sashPolys.push(...p.sashPolys);
    q.roomFills.push(...p.roomFills);
    if (p.sketchLines) q.sketchLines = [...(q.sketchLines ?? []), ...p.sketchLines];
    if (p.loose) q.loose = true;
    q.bbox = { minX: Math.min(q.bbox.minX, p.bbox.minX), minY: Math.min(q.bbox.minY, p.bbox.minY), maxX: Math.max(q.bbox.maxX, p.bbox.maxX), maxY: Math.max(q.bbox.maxY, p.bbox.maxY) };
    plans.splice(plans.indexOf(p), 1);
  }
  // 周囲の線（敷地・車・植栽の読み取り用）から、同じページにある別の階の図面の範囲を除く
  for (const p of plans) {
    const others = plans.filter((q) => q !== p && q.pageIndex === p.pageIndex);
    if (!others.length) continue;
    const inOther = (q: Vec2) => others.some((o) => q.x > o.bbox.minX - 400 && q.x < o.bbox.maxX + 400 && q.y > o.bbox.minY - 400 && q.y < o.bbox.maxY + 400);
    p.siteSegs = p.siteSegs.filter((s) => !(inOther(s.a) && inOther(s.b)));
    p.siteTexts = p.siteTexts.filter((t) => !inOther(t));
  }
  return plans;
}

/** 階段ごとの「UP の文字の側・DN の文字の側・矢印の始点の側」（最上階の階段を降り口に直すときに使う） */
const stairMarkSides = new WeakMap<Stair, { up: Stair['entry'] | null; down: Stair['entry'] | null; arrowTail: Stair['entry'] | null }>();

/**
 * 最上階の階段は「降りる階段」。上の階が無いのに UP と読んだ階段（上階の図に下階の UP の文字と矢印がそのまま写る）を直す。
 * 降り口は DN の文字の側。文字が無く矢印だけの直階段は、矢印の始点（下階の昇り口）の反対側が降り口
 */
export function finishTopFloorStairs(floors: Floor[]): void {
  if (floors.length < 2) return;
  const opposite: Record<Stair['entry'], Stair['entry']> = { n: 's', s: 'n', e: 'w', w: 'e' };
  const area = (s: Stair) => Math.max(1, (s.maxX - s.minX) * (s.maxY - s.minY));
  const overlaps = (st: Stair, list: Stair[]) =>
    list.some((b) => {
      const ix = Math.min(st.maxX, b.maxX) - Math.max(st.minX, b.minX);
      const iy = Math.min(st.maxY, b.maxY) - Math.max(st.minY, b.minY);
      return ix > 0 && iy > 0 && (ix * iy) / Math.min(area(st), area(b)) >= 0.3;
    });
  const toDown = (st: Stair) => {
    st.goesUp = false;
    const ms = stairMarkSides.get(st);
    if (ms?.down) st.entry = ms.down;
    // 直階段は、昇り口（UP の文字・矢印の始点）の反対の端が上の階の降り口
    else if (st.kind === 'straight' && ((ms?.up && st.entry === ms.up) || (ms?.arrowTail && st.entry === ms.arrowTail))) st.entry = opposite[st.entry];
  };
  for (let i = 1; i < floors.length; i++) {
    const f = floors[i];
    const below = floors[i - 1];
    const above = floors[i + 1];
    for (const st of f.stairs) {
      if (!st.goesUp) continue;
      if (!above) {
        // 最上階: 下の階の階段と重なるもの（同じ階段室）だけ。重ならない「昇る階段」はロフトへの固定階段のことがあり、
        // 降りる階段にすると、その下の床に穴があいてしまう
        if (overlaps(st, below.stairs)) toDown(st);
        continue;
      }
      // 途中の階: UP と DN の両方が書かれ、上の階のその位置に階段が無ければ、下からの階段の降り口
      // （池本様邸 2 階。有元様邸 2 階の 13 段は 1 階の階段が読めていなくても降り口）
      const ms = stairMarkSides.get(st);
      if (ms?.up && ms?.down && !overlaps(st, above.stairs)) toDown(st);
    }
  }
}

/**
 * 上下階で同じ階段の範囲をそろえる。下の階の図は切断線（床から 1.4m ほど）より上の段が描かれないことがあり、
 * 上の階の図は手すりの細い線だけで段が少ししか読めないことがある。重なる階段どうしで、読みの足りない側を補う。
 *  (a) 上の階の読みが下の階の 6 割に満たない → 下の階と同じ範囲（同じ吹抜けを上から見ている）
 *  (b) 下の階の読みが、昇り口の反対側（かね折れは曲がる側も）で上の階より短い → 上の階の範囲まで伸ばす
 */
export function reconcileStairs(floors: Floor[], warnings?: string[]): void {
  const area = (s: Stair) => (s.maxX - s.minX) * (s.maxY - s.minY);
  const opposite: Record<Stair['entry'], Stair['entry']> = { n: 's', s: 'n', e: 'w', w: 'e' };
  // 上の階に降りる階段があるのに、下の階のその位置に階段が無い → 同じ範囲に昇る階段を補う。
  // 1 階の図は切断線（床から 1.4 m）までしか段を描かないので、階段下を物入にした折り返し階段は段の線が 3 本ほどしか無く、
  // 階段として読めないことがある（有元様邸 1 階: 2 階の床に穴だけあいて、昇る階段が無かった）
  for (let i = 0; i + 1 < floors.length; i++) {
    const lo = floors[i];
    for (const u of floors[i + 1].stairs) {
      if (u.goesUp || u.kind === 'l') continue;
      const m2 = area(u) / 1e6;
      if (m2 < 1.5 || m2 > 9) continue;
      const overlaps = lo.stairs.some((s) => {
        const ix = Math.min(s.maxX, u.maxX) - Math.max(s.minX, u.minX);
        const iy = Math.min(s.maxY, u.maxY) - Math.max(s.minY, u.minY);
        return ix > 0 && iy > 0 && (ix * iy) / Math.min(area(s), area(u)) > 0.2;
      });
      if (overlaps) continue;
      // 下の階の建物の中（四隅とも）
      const mgn = 120;
      const inside = (x: number, y: number) => lo.outline.some((l) => pointInPolygon({ x, y }, l));
      if (!lo.outline.length || !(inside(u.minX + mgn, u.minY + mgn) && inside(u.maxX - mgn, u.minY + mgn) && inside(u.maxX - mgn, u.maxY - mgn) && inside(u.minX + mgn, u.maxY - mgn))) continue;
      lo.stairs.push({
        id: `F${lo.level}-S${lo.stairs.length + 1}`,
        minX: u.minX,
        minY: u.minY,
        maxX: u.maxX,
        maxY: u.maxY,
        kind: u.kind,
        ...(u.turn ? { turn: u.turn } : {}),
        // 折り返しは上の階の降り口と同じ側から昇る。直階段は反対の端から
        entry: u.kind === 'straight' ? opposite[u.entry] : u.entry,
        goesUp: true,
        ...(u.steps ? { steps: u.steps } : {}),
      });
      warnings?.push(`${lo.level}階: ${floors[i + 1].level}階の降りる階段の真下に、昇る階段を補いました（${lo.level}階の図では段の線が読めませんでした。方眼の「階段」で位置と昇り口を確かめてください）`);
    }
  }
  for (let i = 0; i + 1 < floors.length; i++) {
    for (const lo of floors[i].stairs) {
      if (!lo.goesUp) continue;
      let up: Stair | null = null;
      let best = 0;
      for (const u of floors[i + 1].stairs) {
        const ix = Math.min(lo.maxX, u.maxX) - Math.max(lo.minX, u.minX);
        const iy = Math.min(lo.maxY, u.maxY) - Math.max(lo.minY, u.minY);
        if (ix <= 0 || iy <= 0) continue;
        const ov = (ix * iy) / Math.min(area(lo), area(u));
        if (ov >= 0.5 && ov > best) {
          up = u;
          best = ov;
        }
      }
      if (!up) continue;
      if (area(up) < area(lo) * 0.6) {
        // 下の階の範囲が上の階の建物の中に納まっているときだけ（3 階が小さい家で、2 階の階段の範囲が 3 階の外壁の外へ出ないように）
        const outline = floors[i + 1].outline;
        const inside = (x: number, y: number) => outline.some((l) => pointInPolygon({ x, y }, l));
        const m = 120;
        if (!outline.length || (inside(lo.minX + m, lo.minY + m) && inside(lo.maxX - m, lo.minY + m) && inside(lo.maxX - m, lo.maxY - m) && inside(lo.minX + m, lo.maxY - m))) {
          up.minX = lo.minX;
          up.minY = lo.minY;
          up.maxX = lo.maxX;
          up.maxY = lo.maxY;
          fixTopEntry(floors[i + 1], up, lo);
        }
        continue;
      }
      // 伸ばしてよい側: 昇り口の反対（切断線より上の段）。かね折れは曲がっていく側も。
      // 左右には伸ばさない（上下階の図面が半間ずれて重なっていると、隣のトイレまで階段になった: 吉田大仁様邸 1st-2）
      const right: Record<Stair['entry'], Stair['entry']> = { n: 'w', s: 'e', w: 's', e: 'n' };
      const sides: Stair['entry'][] = [opposite[lo.entry]];
      if (lo.kind === 'l') {
        const r = right[lo.entry];
        sides.push((lo.turn ?? 'right') === 'right' ? r : opposite[r]);
      }
      for (const sd of sides) {
        const d = sd === 'n' ? lo.minY - up.minY : sd === 's' ? up.maxY - lo.maxY : sd === 'w' ? lo.minX - up.minX : up.maxX - lo.maxX;
        if (d < 300 || d > 1900) continue;
        if (sd === 'n') lo.minY -= d;
        else if (sd === 's') lo.maxY += d;
        else if (sd === 'w') lo.minX -= d;
        else lo.maxX += d;
      }
    }
  }
}

/**
 * 上下階の階段が「同じ大きさなのに半間の倍数だけずれて重なっている」とき、上の階を動かす量（ぴったり重なる位置へ）。
 * 動かさない（すでに重なっている・大きさが違う・壁の乗りが悪くなる・上の階が下の階からはみ出す）ときは null
 */
export function stairAlignShift(lower: Floor, upper: Floor): Vec2 | null {
  const m = matchStairs(lower, upper);
  if (!m || m.iou >= 0.8) return null;
  const a = m.lower;
  const b = m.upper;
  // 同じ大きさの階段（切断線の先まで読めた範囲どうし）
  if (Math.abs(a.maxX - a.minX - (b.maxX - b.minX)) > 150 || Math.abs(a.maxY - a.minY - (b.maxY - b.minY)) > 150) return null;
  const snap = (v: number) => Math.round(v / 455) * 455 || 0;
  const d = { x: snap(-m.dx), y: snap(-m.dy) };
  if ((!d.x && !d.y) || Math.max(Math.abs(d.x), Math.abs(d.y)) > 1820) return null;
  const moved: Stair = { ...b, minX: b.minX + d.x, maxX: b.maxX + d.x, minY: b.minY + d.y, maxY: b.maxY + d.y };
  if (stairIoU(a, moved) < 0.9) return null;
  // 壁の乗りが悪くならないこと、上の階が下の階の外へはみ出さないこと
  if (wallFitRatio(lower, upper, d) < wallFitRatio(lower, upper) - 0.02) return null;
  const shifted = { ...upper, outline: upper.outline.map((l) => l.map((q) => ({ x: q.x + d.x, y: q.y + d.y }))) };
  if (overhangArea(lower, shifted) > overhangArea(lower, upper) + 1) return null;
  return d;
}

/**
 * 上下階の重ね位置の検算（外壁）: 上の階の外壁が、下の階の外壁から半間（455）だけずれて平行に並んでいて、
 * 半間動かせば 1 面まるごと（2 間以上）そろうなら、そろう位置へ直す量を返す。
 *
 * 910 の格子に乗った家は、室内の壁の重なりだけでは半間ずれた位置も同じくらい良く見える。
 * 外壁が 1 面まるごと 455 だけはね出す・455 だけ下がる納まりはまず無い（柱・基礎・屋根がその分だけ増える）ので、
 * 階段が決め手にならないとき（片方が読み切れていない）は、外壁がそろう位置を取る。
 * 動かすと、いまそろっている外壁がずれる・壁の乗りが悪くなる・階段の重なりが大きく減る、のどれかなら直さない
 * （田中様邸: 1 階の階段がかね折れの 1 列目しか読めず、2 階は 2 本の階段が重なって 1 つに読めていて、1 階が 455 西にずれていた。
 *   東の外壁 5.5 m がそろう位置へ直すと、階段室の東の壁も上下でそろう）
 */
export function flushAlignShift(lower: Floor, upper: Floor): Vec2 | null {
  type AX = { v: boolean; c: number; t0: number; t1: number };
  const ext = (f: Floor): AX[] => {
    const out: AX[] = [];
    for (const w of f.walls) {
      if (!w.exterior) continue;
      if (Math.abs(w.a.x - w.b.x) < 1) out.push({ v: true, c: w.a.x, t0: Math.min(w.a.y, w.b.y), t1: Math.max(w.a.y, w.b.y) });
      else if (Math.abs(w.a.y - w.b.y) < 1) out.push({ v: false, c: w.a.y, t0: Math.min(w.a.x, w.b.x), t1: Math.max(w.a.x, w.b.x) });
    }
    return out;
  };
  const A = ext(lower);
  const B = ext(upper);
  if (!A.length || !B.length) return null;
  /** 上の階を d だけ動かしたとき、外壁どうしが同じ面にそろう長さ */
  const flush = (d: Vec2): number => {
    let sum = 0;
    for (const b of B)
      for (const a of A) {
        if (a.v !== b.v) continue;
        const dc = b.v ? d.x : d.y;
        const dt = b.v ? d.y : d.x;
        if (Math.abs(a.c - (b.c + dc)) > 40) continue;
        sum += Math.max(0, Math.min(a.t1, b.t1 + dt) - Math.max(a.t0, b.t0 + dt));
      }
    return sum;
  };
  const base = flush({ x: 0, y: 0 });
  let best: { d: Vec2; gain: number } | null = null;
  for (const d of [
    { x: 455, y: 0 },
    { x: -455, y: 0 },
    { x: 0, y: 455 },
    { x: 0, y: -455 },
  ]) {
    const gain = flush(d) - base;
    if (gain >= 3640 && (!best || gain > best.gain)) best = { d, gain };
  }
  if (!best) return null;
  const d = best.d;
  // 室内の壁も含めた壁の乗りが悪くならないこと
  if (wallFitRatio(lower, upper, d) < wallFitRatio(lower, upper)) return null;
  // 上の階が下の階の外へ大きくはみ出さないこと
  const shifted = { ...upper, outline: upper.outline.map((l) => l.map((q) => ({ x: q.x + d.x, y: q.y + d.y }))) };
  if (overhangArea(lower, shifted) > overhangArea(lower, upper) + 1) return null;
  // 階段: よく重なっている階段（同じ範囲に読めている）を引き離さない。動かした後も重なっていること
  const m = matchStairs(lower, upper);
  if (m) {
    const moved: Stair = { ...m.upper, minX: m.upper.minX + d.x, maxX: m.upper.maxX + d.x, minY: m.upper.minY + d.y, maxY: m.upper.maxY + d.y };
    const iou = stairIoU(m.lower, moved);
    // 小さいほうの階段（読み切れていない側）が、大きいほうの範囲に 7 割以上入っていること
    const ix = Math.max(0, Math.min(m.lower.maxX, moved.maxX) - Math.max(m.lower.minX, moved.minX));
    const iy = Math.max(0, Math.min(m.lower.maxY, moved.maxY) - Math.max(m.lower.minY, moved.minY));
    const small = Math.min((m.lower.maxX - m.lower.minX) * (m.lower.maxY - m.lower.minY), (moved.maxX - moved.minX) * (moved.maxY - moved.minY));
    if (small <= 0 || (ix * iy) / small < 0.7 || iou < m.iou - 0.12) return null;
  }
  return d;
}

/** 階段の辺 side の、辺に沿った位置 frac（0〜1。辺の左／上の端から）から外へ出られるか（400mm 先までに壁が無いか、そこに戸・開口がある） */
export function stairSideOpen(f: Pick<Floor, 'walls' | 'openings'>, st: Stair, side: Stair['entry'], frac = 0.5): boolean {
  const horiz = side === 'n' || side === 's';
  const along = horiz ? st.minX + (st.maxX - st.minX) * frac : st.minY + (st.maxY - st.minY) * frac;
  const edge = horiz ? { x: along, y: side === 'n' ? st.minY : st.maxY } : { x: side === 'w' ? st.minX : st.maxX, y: along };
  const dir = side === 'n' ? { x: 0, y: -1 } : side === 's' ? { x: 0, y: 1 } : side === 'e' ? { x: 1, y: 0 } : { x: -1, y: 0 };
  // 範囲の縁は壁の芯に寄せてあることがある（内側 200mm から見る）
  const from = { x: edge.x - dir.x * 200, y: edge.y - dir.y * 200 };
  const to = { x: edge.x + dir.x * 400, y: edge.y + dir.y * 400 };
  const cross = (a: Vec2, b: Vec2, c: Vec2, d: Vec2) => {
    const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  };
  return !f.walls.some((w) => {
    if (!cross(from, to, w.a, w.b)) return false;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const t = ((edge.x - w.a.x) * (w.b.x - w.a.x) + (edge.y - w.a.y) * (w.b.y - w.a.y)) / L;
    return !f.openings.some((o) => o.wallId === w.id && o.kind !== 'window' && t >= o.t0 - 300 && t <= o.t1 + 300);
  });
}

/**
 * 上の階の階段（降りる階段）の範囲を下の階に合わせたあと、降り口が壁を向いていたら決め直す。
 * 下の階の階段の「上の端」（最後の列の先）から降りる: まっすぐ出られればその辺、壁なら上の端の横（開いている側）から入って曲がる
 * （堀様邸 FUKUI 2 階: 東の端の踊り場へ北から入り、西へ降りる。範囲を 4,550 に広げると東の壁向きの降り口になっていた）
 */
function fixTopEntry(fUp: Floor, up: Stair, lo: Stair): void {
  if (stairSideOpen(fUp, up, up.entry)) return;
  const opposite: Record<Stair['entry'], Stair['entry']> = { n: 's', s: 'n', e: 'w', w: 'e' };
  /** 昇る人の右手側の辺（stairFrame と同じ向き） */
  const rightOf: Record<Stair['entry'], Stair['entry']> = { n: 'w', s: 'e', w: 's', e: 'n' };
  // 下の階の階段の、上の端がある辺
  let top: Stair['entry'];
  if (lo.kind === 'straight') top = opposite[lo.entry];
  else if (lo.kind === 'l') top = (lo.turn ?? 'right') === 'right' ? rightOf[lo.entry] : opposite[rightOf[lo.entry]];
  else top = lo.entry;
  if (stairSideOpen(fUp, up, top)) {
    up.entry = top;
    if (lo.kind !== 'l') up.kind = lo.kind;
    return;
  }
  if (lo.kind === 'u' || lo.kind === 'uOpen') return;
  // 上の端の横: 端から半間の位置で、開いている側
  const horizTop = top === 'e' || top === 'w';
  const frac = (() => {
    const len = horizTop ? up.maxX - up.minX : up.maxY - up.minY;
    const f = Math.min(0.5, 455 / Math.max(1, len));
    return top === 'e' || top === 's' ? 1 - f : f;
  })();
  const sides: Stair['entry'][] = horizTop ? ['n', 's'] : ['w', 'e'];
  const open = sides.filter((sd) => stairSideOpen(fUp, up, sd, frac));
  if (open.length !== 1) return;
  const entry = open[0];
  // 入ってから、上の端と反対の向き（下の階へ降りていく向き）へ曲がる
  const runTo = opposite[top];
  up.kind = 'l';
  up.entry = entry;
  up.turn = rightOf[entry] === runTo ? 'right' : 'left';
}

/**
 * 同じ階段を 2 つに読まない: コの字階段の 2 つの折り返しが別々の候補になり、壁まで広げた矩形が重なる
 * （吉田大仁様邸 1st-2: 2,275×1,820 の階段の中に 1,365 角の「階段」がもう 1 つでき、3D に二重の階段が出ていた）。
 * 小さいほうの 5 割以上が大きいほうに入っていれば、大きいほうだけ残す。id は F{階}-S{番号} で振り直す
 */
export function dedupeStairs(stairs: Stair[], level: number): void {
  for (let i = stairs.length - 1; i >= 0; i--) {
    const a = stairs[i];
    const areaA = (a.maxX - a.minX) * (a.maxY - a.minY);
    const covered = stairs.some((b, j) => {
      if (j === i) return false;
      const areaB = (b.maxX - b.minX) * (b.maxY - b.minY);
      if (areaB < areaA || (areaB === areaA && j > i)) return false;
      const ix = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const iy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      return ix > 0 && iy > 0 && (ix * iy) / areaA >= 0.5;
    });
    if (covered) stairs.splice(i, 1);
  }
  stairs.forEach((st, i) => (st.id = `F${level}-S${i + 1}`));
}

/**
 * 「1階平面図」などの見出しを図面に1対1で割り当てる。
 * 見出しは図面の真下（または真上）に置かれることが多いので、横方向のずれを重く評価する。
 */
export function assignFloorTitles(plans: PlanData[], pages: PageMm[]) {
  const cands: { plan: PlanData; title: MmText; floor: number; score: number }[] = [];
  for (const page of pages) {
    const onPage = plans.filter((p) => p.pageIndex === page.pageIndex);
    // 見出しとみなす文字: 「1階平面図」、または「1階」の直後（同じ行の右）に「平面図」がある
    const isTitle = (t: MmText) => {
      const s0 = normalizeText(t.str);
      if (/平面|PLAN/.test(s0)) return true;
      return followingOnLine(t, page.texts, 12).some((q) => /^平面/.test(normalizeText(q.str).replace(/\s/g, '')));
    };
    for (const t of page.texts) {
      const f = parseFloorTitle(t.str);
      if (f == null || !isTitle(t)) continue;
      // 図面名欄の「1階平面図, 2階平面図」のように 1 行に複数の階が並ぶものは見出しではない
      const s0 = normalizeText(t.str);
      if (/[,、，]/.test(s0) && /平面/.test(s0)) continue;
      if (followingOnLine(t, page.texts, 3).some((q) => parseFloorTitle(q.str) != null && parseFloorTitle(q.str) !== f)) continue;
      const lenOf = (pl: PlanData) => pl.walls.reduce((s0, w) => s0 + Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y), 0);
      const maxLen = Math.max(...onPage.map(lenOf));
      for (const p of onPage) {
        const b = p.bbox;
        const dx = Math.max(0, b.minX - t.x, t.x - b.maxX);
        const dy = Math.max(0, b.minY - t.y, t.y - b.maxY);
        const h = b.maxY - b.minY;
        const w = b.maxX - b.minX;
        // 見出しと図の間に面積表・注記が入ると図の高さの 0.9 倍より離れる（吉田大仁様邸 1st-2: 5.6 m 角の 2 階の 6.6 m 下に「2階 平面図」）
        if (onPage.length > 1 && (dy > Math.max(h * 0.9, 7000) || dx > w * 0.6)) continue;
        // 図面名は図の「下」に書くのが決まり。上下に図が並ぶ図面では、上の図の見出しが下の図の真上に来るので、
        // 「図の上にある見出し」は図の高さ分だけ遠いものとして扱う（田中様邸: 3 階の見出しが 2 階の図に付き、2 階と 3 階が入れ替わっていた）
        const above = t.y < b.minY;
        // 図と見出しの間に描かれた小さな図（変更案・部分図）が見出しを取らないように、小さな図は最後の候補にする
        const small = lenOf(p) < maxLen * 0.4;
        cands.push({ plan: p, title: t, floor: f, score: dx * 3 + dy + (above ? h : 0) + (small ? 100000 : 0) });
      }
    }
  }
  cands.sort((a, b) => a.score - b.score);
  const usedPlan = new Set<PlanData>();
  const usedTitle = new Set<MmText>();
  const usedFloor = new Set<string>();
  for (const c of cands) {
    const fk = `${c.plan.pageIndex}:${c.floor}`;
    if (usedPlan.has(c.plan) || usedTitle.has(c.title) || usedFloor.has(fk)) continue;
    c.plan.floorHint = c.floor;
    usedPlan.add(c.plan);
    usedTitle.add(c.title);
    usedFloor.add(fk);
  }
}

/** 各階の外形を真上から重ねた面積（㎡。100mm の格子で数える。建築面積の検算用） */
export function outlineUnionArea(floors: { outline: Vec2[][] }[]): number {
  const loops = floors.flatMap((f) => f.outline).filter((l) => l.length >= 3);
  if (!loops.length) return 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of loops)
    for (const q of l) {
      minX = Math.min(minX, q.x);
      minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x);
      maxY = Math.max(maxY, q.y);
    }
  const step = 100;
  let n = 0;
  for (let y = minY + step / 2; y < maxY; y += step) for (let x = minX + step / 2; x < maxX; x += step) if (loops.some((l) => pointInPolygon({ x, y }, l))) n++;
  return (n * step * step) / 1e6;
}

/** 上階の図面を下階に位置合わせするための平行移動量（壁の重なり・階段位置・外形の包含で評価） */
export function alignOffset(base: PlanData, other: PlanData, mode: 'walls' | 'stairs' = 'walls'): Vec2 {
  type AX = { c: number; t0: number; t1: number };
  const axesOf = (p: PlanData, vertical: boolean): AX[] =>
    p.walls
      .filter((w) => (vertical ? Math.abs(w.u.y) > 0.99 : Math.abs(w.u.x) > 0.99))
      .map((w) =>
        vertical
          ? { c: w.a.x, t0: Math.min(w.a.y, w.b.y), t1: Math.max(w.a.y, w.b.y) }
          : { c: w.a.y, t0: Math.min(w.a.x, w.b.x), t1: Math.max(w.a.x, w.b.x) },
      );
  const AV = axesOf(base, true);
  const AH = axesOf(base, false);
  const BV = axesOf(other, true);
  const BH = axesOf(other, false);
  const overlapScore = (A: AX[], B: AX[], dc: number, dt: number) => {
    let s = 0;
    for (const b of B) {
      for (const a of A) {
        if (Math.abs(a.c - (b.c + dc)) > 25) continue;
        s += Math.max(0, Math.min(a.t1, b.t1 + dt) - Math.max(a.t0, b.t0 + dt));
      }
    }
    return s;
  };
  // 1次元の候補（重みの大きい順に上位のみ）
  const cands1d = (A: AX[], B: AX[]) => {
    const m = new Map<number, number>();
    for (const a of A)
      for (const b of B) {
        const c = Math.round(a.c - b.c);
        m.set(c, (m.get(c) ?? 0) + Math.min(a.t1 - a.t0, b.t1 - b.t0));
      }
    return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([c]) => c);
  };
  const dxs = new Set(cands1d(AV, BV));
  const dys = new Set(cands1d(AH, BH));
  dxs.add(Math.round(base.bbox.minX - other.bbox.minX));
  dys.add(Math.round(base.bbox.minY - other.bbox.minY));
  // 階段の一致
  const sa = detectStairs(base.segs, base.bbox);
  const sb = detectStairs(other.segs, other.bbox);
  const dbg = (globalThis as { __alignDebug?: boolean }).__alignDebug;
  if (dbg) console.log(`[align] base stairs ${JSON.stringify(sa.map((s) => [s.minX, s.minY, s.maxX, s.maxY]))} other stairs ${JSON.stringify(sb.map((s) => [s.minX, s.minY, s.maxX, s.maxY]))} other bbox ${JSON.stringify(other.bbox)}`);
  for (const a of sa)
    for (const b of sb) {
      dxs.add(Math.round((a.minX + a.maxX) / 2 - (b.minX + b.maxX) / 2));
      dys.add(Math.round((a.minY + a.maxY) / 2 - (b.minY + b.maxY) / 2));
    }
  // エレベーター（EV）は上下階で同じ位置に通る → 文字の位置を合わせる候補と加点
  const evOf = (p: PlanData) => p.texts.filter((t) => /^(EV|ＥＶ|ELV|ＥＬＶ|エレベーター)$/i.test(normalizeText(t.str).replace(/\s/g, '')));
  const evA = evOf(base);
  const evB = evOf(other);
  for (const a of evA)
    for (const b of evB) {
      dxs.add(Math.round(a.x - b.x));
      dys.add(Math.round(a.y - b.y));
    }
  const areaB = (other.bbox.maxX - other.bbox.minX) * (other.bbox.maxY - other.bbox.minY);
  let best = { x: 0, y: 0 };
  let bestScore = -Infinity;
  for (const dx of dxs)
    for (const dy of dys) {
      const wallScore = overlapScore(AV, BV, dx, dy) + overlapScore(AH, BH, dy, dx);
      // 階段は上下階で必ず同じ位置に通る → いちばん良く重なる階段の組で壁の点を重み付けし、さらに加点する
      // （吉田大仁様邸: 2 階 5 × 6.4 m の壁は 1 階の玄関・ガレージの壁にも 910 の格子で良く重なり、階段から 6 m 離れた所に載っていた。
      //   壁の重なりだけでは小さな 2 階の位置は決まらない。階段が読めていない図面は壁だけで決める）
      // 重なりは IoU（重なり ÷ 合わせた範囲）で見る: 同じ大きさの階段が同じ位置にあるときだけ 1 に近づき、
      // 車の記号の縞（吉田大仁様邸のガレージで階段に見えた 1.3 × 0.9 m）に 2 階の階段 1.8 × 1.8 m が載っても 0.4 止まり
      let stairBest = 0;
      for (const a of sa)
        for (const b of sb) {
          const ix = Math.max(0, Math.min(a.maxX, b.maxX + dx) - Math.max(a.minX, b.minX + dx));
          const iy = Math.max(0, Math.min(a.maxY, b.maxY + dy) - Math.max(a.minY, b.minY + dy));
          const inter = ix * iy;
          const union = (a.maxX - a.minX) * (a.maxY - a.minY) + (b.maxX - b.minX) * (b.maxY - b.minY) - inter;
          if (union > 0) stairBest = Math.max(stairBest, inter / union);
        }
      // 'walls': 壁の重なりが主で階段は加点（既定）。'stairs': 階段の重なりが主（面積表の建築面積が合わないときの再試行。
      // 既定にすると、デッキの縞・車の記号を階段と見た図面（伊藤様・池本様・舟橋様）で逆にずれる）
      let score = mode === 'stairs' && sa.length && sb.length ? wallScore * (0.15 + 0.85 * stairBest) + 80000 * stairBest : wallScore + 20000 * stairBest;
      for (const a of evA) for (const b of evB) score += 30000 * Math.max(0, 1 - Math.hypot(a.x - (b.x + dx), a.y - (b.y + dy)) / 600);
      if (dbg && (stairBest > 0 || score > 20000)) console.log(`[align] d=(${dx},${dy}) wall=${Math.round(wallScore)} stair=${stairBest.toFixed(2)} score=${Math.round(score)}`);
      // 上階が下階の外形からはみ出す面積にペナルティ
      const ix = Math.max(0, Math.min(base.bbox.maxX, other.bbox.maxX + dx) - Math.max(base.bbox.minX, other.bbox.minX + dx));
      const iy = Math.max(0, Math.min(base.bbox.maxY, other.bbox.maxY + dy) - Math.max(base.bbox.minY, other.bbox.minY + dy));
      score -= 10000 * (1 - (ix * iy) / Math.max(1, areaB));
      if (score > bestScore) {
        bestScore = score;
        best = { x: dx, y: dy };
      }
    }
  return best;
}

export function translatePlan(p: PlanData, d: Vec2) {
  const tr = (q: Vec2) => ({ x: q.x + d.x, y: q.y + d.y });
  for (const w of p.walls) {
    w.a = tr(w.a);
    w.b = tr(w.b);
    const dt = d.x * w.u.x + d.y * w.u.y;
    const dO = d.x * w.n.x + d.y * w.n.y;
    w.t0 += dt;
    w.t1 += dt;
    w.o += dO;
    for (const op of w.openings) {
      op.t0 += dt;
      op.t1 += dt;
      op.o += dO;
    }
  }
  if ((globalThis as any).__DBG_PLANS) {
    console.log('translate page', p.pageIndex, 'floorHint', p.floorHint, 'by', Math.round(d.x), Math.round(d.y));
    const q = p as PlanData & { __dbgShift?: Vec2 };
    q.__dbgShift = { x: (q.__dbgShift?.x ?? 0) + d.x, y: (q.__dbgShift?.y ?? 0) + d.y };
  }
  p.texts = p.texts.map((t) => ({ ...t, x: t.x + d.x, y: t.y + d.y }));
  p.segs = p.segs.map((s) => ({ ...s, a: tr(s.a), b: tr(s.b) }));
  p.arcs = p.arcs.map((a) => ({ ...a, p0: tr(a.p0), p1: tr(a.p1), p2: tr(a.p2), p3: tr(a.p3) }));
  p.siteTexts = p.siteTexts.map((t) => ({ ...t, x: t.x + d.x, y: t.y + d.y }));
  p.siteSegs = p.siteSegs.map((s) => ({ ...s, a: tr(s.a), b: tr(s.b) }));
  p.wallPolys = p.wallPolys.map((poly) => poly.map(tr));
  p.sashPolys = p.sashPolys.map((poly) => poly.map(tr));
  p.roomFills = p.roomFills.map((poly) => poly.map(tr));
  if (p.sketchLines) p.sketchLines = p.sketchLines.map((sg) => ({ ...sg, a: tr(sg.a), b: tr(sg.b) }));
  p.bbox = { minX: p.bbox.minX + d.x, maxX: p.bbox.maxX + d.x, minY: p.bbox.minY + d.y, maxY: p.bbox.maxY + d.y };
}

/**
 * 組み立てた階を木造のモジュール格子（半間 455 / 500）へ寄せる。
 * 部屋の区切りは図面の線のまま解析し、結果（壁芯・開口・部屋・外形・階段）だけを格子へ寄せる。
 * 縦横の壁の芯を格子へ寄せ、壁の端は接していた直交する壁の芯へ付け直し、部屋・外形の頂点は元の壁を追って動かす。
 * 斜めの壁・格子から大きく外れた壁はそのまま
 */
function snapFloorWalls(f: Floor, m: ModuleFit) {
  const tol = snapTolerance(m.grid);
  const tolEnd = endTolerance(m.grid);
  type Ax = { wall: Wall; horiz: boolean; oldAxis: number; newAxis: number; lo: number; hi: number };
  const axes: Ax[] = [];
  for (const w of f.walls) {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (L < 1) continue;
    const horiz = Math.abs(w.b.y - w.a.y) < L * 0.02;
    const vert = Math.abs(w.b.x - w.a.x) < L * 0.02;
    if (!horiz && !vert) continue;
    const oldAxis = horiz ? (w.a.y + w.b.y) / 2 : (w.a.x + w.b.x) / 2;
    const sn = snapCoord(oldAxis, horiz ? m.phaseY : m.phaseX, m.grid);
    const e0 = horiz ? w.a.x : w.a.y;
    const e1 = horiz ? w.b.x : w.b.y;
    axes.push({ wall: w, horiz, oldAxis, newAxis: Math.abs(sn - oldAxis) <= tol ? sn : oldAxis, lo: Math.min(e0, e1), hi: Math.max(e0, e1) });
  }
  /** 元の位置 v に最も近かった（横 or 縦の）壁の芯の、寄せた後の位置 */
  const follow = (v: number, horiz: boolean, within: number): number | null => {
    let best: Ax | null = null;
    for (const ax of axes) {
      if (ax.horiz !== horiz) continue;
      const d = Math.abs(ax.oldAxis - v);
      if (d <= within && (!best || d < Math.abs(best.oldAxis - v))) best = ax;
    }
    return best ? best.newAxis : null;
  };
  // 壁: 芯を寄せ、端は接していた直交する壁の芯へ（無ければ格子へ）
  const shiftA = new Map<string, number>();
  for (const ax of axes) {
    const w = ax.wall;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const u = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
    const endPos = (p: Vec2) => (ax.horiz ? p.x : p.y);
    const newEnd = (p: Vec2): number => {
      const v = endPos(p);
      const f0 = follow(v, !ax.horiz, 250);
      if (f0 != null) return f0;
      const sn = snapCoord(v, ax.horiz ? m.phaseX : m.phaseY, m.grid);
      return Math.abs(sn - v) <= tolEnd ? sn : v;
    };
    let ea = newEnd(w.a);
    let eb = newEnd(w.b);
    // 短い壁（柱型など）は両端が同じ直交壁へ寄ってしまうので、端は格子だけで寄せる
    if (Math.abs(ea - eb) < 200) {
      const gridEnd = (p: Vec2) => {
        const v = endPos(p);
        const sn = snapCoord(v, ax.horiz ? m.phaseX : m.phaseY, m.grid);
        return Math.abs(sn - v) <= tolEnd ? sn : v;
      };
      ea = gridEnd(w.a);
      eb = gridEnd(w.b);
      if (Math.abs(ea - eb) < 100) {
        ea = endPos(w.a);
        eb = endPos(w.b);
      }
    }
    const na = ax.horiz ? { x: ea, y: ax.newAxis } : { x: ax.newAxis, y: ea };
    const nb = ax.horiz ? { x: eb, y: ax.newAxis } : { x: ax.newAxis, y: eb };
    // a が壁の向きに沿ってどれだけ動いたか（開口の位置は a からの距離なので差し引く）
    const da = (na.x - w.a.x) * u.x + (na.y - w.a.y) * u.y;
    shiftA.set(w.id, da);
    w.a = na;
    w.b = nb;
  }
  // 斜めの壁: 向きは変えないが、端が接していた縦・横の壁が格子へ動いたら、端もその壁の芯を追う。
  // そのままだと、動いた壁の角から斜めの壁の端が 5〜6cm 取り残され、外形の両端に小さな段ができる（田中様邸 2 階: 三角のバルコニーの斜めの手すり）
  const axisWalls = new Set(axes.map((ax) => ax.wall));
  /** p のそば（芯から 160mm 以内・壁の区間 ±300mm）を通っていた縦（horiz=false）・横（true）の壁の、寄せた後の芯 */
  const followAt = (p: Vec2, horiz: boolean): number | null => {
    let best: Ax | null = null;
    let bd = Infinity;
    for (const ax of axes) {
      if (ax.horiz !== horiz) continue;
      const d = Math.abs(ax.oldAxis - (horiz ? p.y : p.x));
      const t = horiz ? p.x : p.y;
      if (d > 160 || t < ax.lo - 300 || t > ax.hi + 300) continue;
      if (d < bd) {
        bd = d;
        best = ax;
      }
    }
    return best ? best.newAxis : null;
  };
  const diagMoves: { oldA: Vec2; oldB: Vec2; a: Vec2; b: Vec2 }[] = [];
  for (const w of f.walls) {
    if (axisWalls.has(w)) continue;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (L < 300) continue;
    const mv = (p: Vec2): Vec2 => ({ x: followAt(p, false) ?? p.x, y: followAt(p, true) ?? p.y });
    const na = mv(w.a);
    const nb = mv(w.b);
    if (Math.hypot(na.x - w.a.x, na.y - w.a.y) < 1 && Math.hypot(nb.x - w.b.x, nb.y - w.b.y) < 1) continue;
    // 長さ・向きが大きく変わるなら触らない
    const L2 = Math.hypot(nb.x - na.x, nb.y - na.y);
    if (L2 < L * 0.85 || L2 > L * 1.15 || Math.abs((nb.x - na.x) * (w.b.y - w.a.y) - (nb.y - na.y) * (w.b.x - w.a.x)) / (L * L2) > 0.12) continue;
    const u = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
    shiftA.set(w.id, (na.x - w.a.x) * u.x + (na.y - w.a.y) * u.y);
    diagMoves.push({ oldA: { ...w.a }, oldB: { ...w.b }, a: na, b: nb });
    w.a = na;
    w.b = nb;
  }
  for (const op of f.openings) {
    const da = shiftA.get(op.wallId);
    if (da == null) continue;
    const w = f.walls.find((q) => q.id === op.wallId)!;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const wd = op.t1 - op.t0;
    op.t0 = Math.max(0, Math.min(L - wd, op.t0 - da));
    op.t1 = Math.min(L, op.t0 + wd);
  }
  // 角の接合（直交する壁の芯まで伸ばした端を、相手の壁厚の半分だけ延長して角を埋める）を結び直す
  rejoinFloorWalls(f);
  // 部屋・外形の頂点は元の壁を追う（壁に乗っていなかった頂点はそのまま）
  const movePoly = (poly: Vec2[]): Vec2[] => {
    const n = poly.length;
    const out: Vec2[] = [];
    /** 斜めの壁を追って動かした頂点 */
    const onDiag: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const p = poly[i];
      const prev = poly[(i + n - 1) % n];
      const next = poly[(i + 1) % n];
      const vertEdge = (q: Vec2) => Math.abs(q.x - p.x) < 1 && Math.abs(q.y - p.y) >= 1;
      const horizEdge = (q: Vec2) => Math.abs(q.y - p.y) < 1 && Math.abs(q.x - p.x) >= 1;
      let x = p.x;
      let y = p.y;
      // 壁に乗っていない頂点（吹抜・玄関の開口の縁など）は格子へ
      const gridOr = (v: number, phase: number) => {
        const sn = snapCoord(v, phase, m.grid);
        return Math.abs(sn - v) <= tol ? sn : v;
      };
      const hasV = vertEdge(prev) || vertEdge(next);
      const hasH = horizEdge(prev) || horizEdge(next);
      if (hasV) x = follow(p.x, false, 160) ?? gridOr(p.x, m.phaseX);
      if (hasH) y = follow(p.y, true, 160) ?? gridOr(p.y, m.phaseY);
      // 斜めの辺の端の頂点は、動いた斜めの壁の線の上へ（もう一方の辺が縦・横なら、その線との交点）
      if (diagMoves.length && !(hasV && hasH)) {
        let dm: (typeof diagMoves)[number] | null = null;
        let bd = 220;
        for (const d of diagMoves) {
          const dd = distPointSegment(p, d.oldA, d.oldB);
          if (dd >= bd) continue;
          // 隣の辺のどちらかが、その壁と平行（斜めの辺）であること
          const wl = Math.hypot(d.oldB.x - d.oldA.x, d.oldB.y - d.oldA.y) || 1;
          const par = [prev, next].some((q) => {
            const el = Math.hypot(q.x - p.x, q.y - p.y);
            return el > 1 && Math.abs((q.x - p.x) * (d.oldB.y - d.oldA.y) - (q.y - p.y) * (d.oldB.x - d.oldA.x)) / (el * wl) < 0.12;
          });
          if (!par) continue;
          bd = dd;
          dm = d;
        }
        if (dm) {
          const dx = dm.b.x - dm.a.x;
          const dy = dm.b.y - dm.a.y;
          let nx = x;
          let ny = y;
          if (hasH && Math.abs(dy) > 1) nx = dm.a.x + ((y - dm.a.y) * dx) / dy;
          else if (hasV && Math.abs(dx) > 1) ny = dm.a.y + ((x - dm.a.x) * dy) / dx;
          else {
            // 斜めの辺どうしの頂点: 近いほうの端
            const near = Math.hypot(p.x - dm.oldA.x, p.y - dm.oldA.y) <= Math.hypot(p.x - dm.oldB.x, p.y - dm.oldB.y) ? dm.a : dm.b;
            nx = near.x;
            ny = near.y;
          }
          if (Math.hypot(nx - p.x, ny - p.y) <= 300) {
            x = nx;
            y = ny;
            onDiag[i] = true;
          }
        }
      }
      out.push({ x, y });
    }
    // 斜めの壁の端へ動かした頂点のまわりを整える: すぐ隣（15mm 以内）の頂点は同じ角、
    // 隣へ続く辺がほぼ縦・ほぼ横（ずれ 12mm 以内）なら隣の頂点をこの線に合わせる（升目でなぞった輪郭の端数が残って、外形がわずかに傾く）
    for (let i = 0; i < n; i++) {
      if (!onDiag[i]) continue;
      for (const j of [(i + n - 1) % n, (i + 1) % n]) {
        const q = out[j];
        const dx = Math.abs(q.x - out[i].x);
        const dy = Math.abs(q.y - out[i].y);
        if (dx <= 15 && dy <= 15) out[i] = { x: q.x, y: q.y };
        else if (dx > 0 && dx <= 12 && dy > 200) out[j] = { x: out[i].x, y: q.y };
        else if (dy > 0 && dy <= 12 && dx > 200) out[j] = { x: q.x, y: out[i].y };
      }
    }
    return cleanPolygon(out, poly);
  };
  for (const r of f.rooms) {
    r.polygon = movePoly(r.polygon);
    r.area = Math.round((Math.abs(polygonArea(r.polygon)) / 1e6) * 100) / 100;
  }
  f.outline = f.outline.map(movePoly);
}

/** 同じ点になった頂点・一直線上の中間点を除く（3 点未満になったら元のまま） */
export function cleanPolygon(out: Vec2[], fallback: Vec2[]): Vec2[] {
  const dedup: Vec2[] = [];
  for (const p of out) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.x - p.x) < 1 && Math.abs(last.y - p.y) < 1) continue;
    dedup.push(p);
  }
  while (dedup.length > 1 && Math.abs(dedup[0].x - dedup[dedup.length - 1].x) < 1 && Math.abs(dedup[0].y - dedup[dedup.length - 1].y) < 1) dedup.pop();
  // 行って戻るだけのとげ（a → p → a の側へ戻る。面積 0）を除く。格子へ寄せると、数 cm の欠けの両端が同じ線に乗ってとげになる
  // （有元様邸 2 階の階段: 5005,1820 → 4827,1820 → 5005,1820）
  for (let guard = 0; guard < 8 && dedup.length > 3; guard++) {
    let removed = false;
    for (let i = 0; i < dedup.length && dedup.length > 3; i++) {
      const a = dedup[(i + dedup.length - 1) % dedup.length];
      const p = dedup[i];
      const b = dedup[(i + 1) % dedup.length];
      const cross = (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
      const dot = (p.x - a.x) * (b.x - p.x) + (p.y - a.y) * (b.y - p.y);
      if (Math.abs(cross) < 1 && dot < 0) {
        dedup.splice(i, 1);
        // 戻った先が a と同じ点なら、それも 1 つにする
        const j = i % dedup.length;
        const q = dedup[(j + dedup.length - 1) % dedup.length];
        if (dedup.length > 3 && Math.abs(q.x - dedup[j].x) < 1 && Math.abs(q.y - dedup[j].y) < 1) dedup.splice(j, 1);
        removed = true;
        i--;
      }
    }
    if (!removed) break;
  }
  const clean: Vec2[] = [];
  for (let i = 0; i < dedup.length; i++) {
    const a = dedup[(i + dedup.length - 1) % dedup.length];
    const p = dedup[i];
    const b = dedup[(i + 1) % dedup.length];
    const cross = (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
    if (Math.abs(cross) < 1 && (p.x - a.x) * (b.x - p.x) + (p.y - a.y) * (b.y - p.y) > 0) continue;
    clean.push(p);
  }
  return clean.length >= 3 ? clean : fallback;
}

/** 階の壁を軸線の形に直して角の接合をやり直し、壁の端点・開口の位置・接合フラグを書き戻す */
export function rejoinFloorWalls(f: Floor) {
  const groups: { u: Vec2 }[] = [];
  const groupOf = (u: Vec2) => {
    let gi = groups.findIndex((g) => Math.abs(g.u.x * u.y - g.u.y * u.x) < 0.02 && g.u.x * u.x + g.u.y * u.y > 0);
    if (gi < 0) {
      groups.push({ u });
      gi = groups.length - 1;
    }
    return gi;
  };
  const ww: { w: Wall; ax: WWall; swapped: boolean }[] = [];
  for (const w of f.walls) {
    let a = w.a;
    let b = w.b;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 30) continue;
    let u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    const swapped = u.x < -1e-6 || (Math.abs(u.x) <= 1e-6 && u.y < 0);
    if (swapped) {
      [a, b] = [b, a];
      u = { x: -u.x, y: -u.y };
    }
    const n = { x: -u.y, y: u.x };
    const t0 = a.x * u.x + a.y * u.y;
    const o = a.x * n.x + a.y * n.y;
    ww.push({ w, swapped, ax: { a, b, u, n, d: w.thickness, t0, t1: t0 + L, o, g: groupOf(u), openings: [], joinedA: false, joinedB: false } });
  }
  joinWalls(ww.map((q) => q.ax));
  for (const { w, ax, swapped } of ww) {
    const na = swapped ? ax.b : ax.a;
    const nb = swapped ? ax.a : ax.b;
    const newL = Math.hypot(nb.x - na.x, nb.y - na.y);
    // a 側（元の向きでの a）がどれだけ手前へ伸びたか。向きを入れ替えて計算した壁（右から左へ・下から上へ引かれた壁。斜めの壁に多い）も、
    // 元の a からの距離で測る（以前は入れ替えた壁で元の b から測っていて、開口が壁の反対の端まで押しやられていた:
    // 吉田大仁様邸 1st の斜めの壁のテラス窓が 1.8 m ずれ、印のある出入口の位置が壁になっていた）
    const ext0 = Math.hypot(na.x - w.a.x, na.y - w.a.y);
    for (const op of f.openings) {
      if (op.wallId !== w.id) continue;
      const wd = op.t1 - op.t0;
      op.t0 = Math.max(0, Math.min(newL - wd, op.t0 + ext0));
      op.t1 = Math.min(newL, op.t0 + wd);
    }
    w.a = { x: Math.round(na.x * 10) / 10, y: Math.round(na.y * 10) / 10 };
    w.b = { x: Math.round(nb.x * 10) / 10, y: Math.round(nb.y * 10) / 10 };
    w.joinedA = w.joinedA || (swapped ? ax.joinedB : ax.joinedA);
    w.joinedB = w.joinedB || (swapped ? ax.joinedA : ax.joinedB);
  }
}

export interface AssembleOptions {
  /** 木造のモジュール: auto = 図面から判定（尺／メーター）, shaku = 910, meter = 1000, none = 寄せない */
  module?: ModuleMode;
}

export function assembleModel(pages: PageMm[], name: string, warnings: string[], opts: AssembleOptions = {}): Omit<BuildingModel, 'report'> & { thicknesses: number[]; northDetected: boolean; areaTable: Record<number, number>; floorPages: Record<number, number> } {
  let plans = detectPlans(pages, warnings);
  // 見出しの読めないスキャン図面が複数ページにある場合は、別案（打合せ用の比較案など）の可能性が高いので1ページ目だけを使う
  if (plans.length && plans.every((p) => p.scan && p.floorHint == null)) {
    const first = Math.min(...plans.map((p) => p.pageIndex));
    if (plans.some((p) => p.pageIndex !== first)) {
      plans = plans.filter((p) => p.pageIndex === first);
      warnings.push(`スキャン図面が複数ページあり階を判別できないため、${first + 1}ページ目の図面だけを解析しました（他のページは別案の可能性があります）`);
    }
  }
  // 階の決定
  const hinted = plans.filter((p) => p.floorHint != null);
  const wallLen = (p: PlanData) => p.walls.reduce((s0, w) => s0 + Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y), 0);
  const ordered = plans.slice().sort((a, b) => {
    const fa = a.floorHint ?? 99;
    const fb = b.floorHint ?? 99;
    if (fa !== fb) return fa - fb;
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    // 見出しの無いスキャン図面（色付きの配置図兼平面図など）は、いちばん大きい区画を 1 階にする（左端の区画が車庫だった）
    if (fa === 99 && a.scan && b.scan) return wallLen(b) - wallLen(a);
    return a.bbox.minX - b.bbox.minX;
  });
  // 見出しが 1 つも無い 1 ページの図面（配置図兼平面図）: 区画は同じ敷地の上に描かれているので、位置合わせはしない
  const samePageUnhinted = plans.length > 1 && plans.every((p) => p.floorHint == null && p.pageIndex === plans[0].pageIndex);
  const used = new Set<number>();
  const levelOf = new Map<PlanData, number>();
  let nextLevel = 1;
  for (const p of ordered) {
    let lv = p.floorHint ?? 0;
    if (!lv || used.has(lv)) {
      while (used.has(nextLevel)) nextLevel++;
      lv = nextLevel;
    }
    used.add(lv);
    levelOf.set(p, lv);
  }
  if (plans.length > 1 && hinted.length < plans.length) warnings.push('階の見出しが見つからない図面があり、配置順で階を割り当てました');

  const northDeg = detectNorth(pages);
  if (northDeg == null) warnings.push('方位記号が見つかりませんでした（図面の上を北として扱います）');
  const north = northDeg ?? 0;

  const sorted = ordered.slice().sort((a, b) => levelOf.get(a)! - levelOf.get(b)!);
  // 位置合わせ
  const base = sorted[0];
  if (base) {
    // 上の階は「すぐ下の階」に順に合わせる（3 階を 1 階に合わせると、1 階が小さい 3 階建て（有元様邸: 1 階 5m 四方の下屋・駐車場）で手がかりが足りずにずれる）
    if (!samePageUnhinted) {
      let below = base;
      for (const p of sorted.slice(1)) {
        translatePlan(p, alignOffset(below, p));
        below = p;
      }
    }
    // 原点を1階の左上へ
    const o = { x: -base.bbox.minX, y: -base.bbox.minY };
    if ((globalThis as any).__DBG_PLANS) console.log('origin(page→model)', Math.round(base.bbox.minX), Math.round(base.bbox.minY));
    for (const p of sorted) translatePlan(p, o);
  }
  // 木造のモジュール: 全階の壁芯から格子（半間 455 / 500）の位相を求め、乗っている図面は壁芯を格子へ寄せる（柱は上下階で通るので位相は共通）
  const moduleMode: ModuleMode = opts.module ?? 'auto';
  const mfit = chooseModule(sorted.flatMap((p) => p.walls.map((w) => ({ a: w.a, b: w.b }))), moduleMode);
  const moduleInfo = mfit ? moduleInfoOf(mfit, moduleMode === 'auto' ? 'auto' : 'manual', true) : undefined;
  if (mfit) {
    if (mfit.onGrid < 0.7) warnings.push(`壁芯の ${Math.round(mfit.onGrid * 100)}% しか ${mfit.size === 910 ? '尺（910）' : 'メーター（1000）'}モジュールの格子に乗っていません（乗っていない壁はそのまま）`);
  } else if (moduleMode === 'auto') {
    warnings.push('壁芯が 910／1000 のモジュール格子にそろっていないため、図面の寸法のまま読み取りました（読み込みのやり直しでモジュールを指定できます）');
  }
  const areaTable = readAreaTable(pages);
  const floors: Floor[] = [];
  const thicknesses = new Set<number>();
  let elev = 500;
  const planOf = new Map<Floor, PlanData>();
  const singleStorey = sorted.length === 1 && (areaTable[2] === 0 || pages.some((pg) => pg.texts.some((t) => /平屋/.test(t.str))));
  for (const p of sorted) {
    const f = buildFloor(p, levelOf.get(p)!, north, warnings, areaTable[levelOf.get(p)!], { singleStorey });
    planOf.set(f, p);
    // 部屋が取れない図（凡例・断面など）は階として扱わない
    const roomArea = f.rooms.reduce((s0, r) => s0 + r.area, 0);
    if (f.rooms.length === 0 || roomArea < 4) continue;
    // 部屋が1〜2つで極端に広い（表・枠を部屋と誤認）
    if (f.rooms.length <= 2 && roomArea > 100) continue;
    f.elevation = elev;
    elev += f.height;
    f.walls.forEach((w) => thicknesses.add(w.thickness));
    floors.push(f);
  }
  if ((globalThis as any).__DBG_PLANS) {
    (globalThis as any).__DBG_PLANOF = floors.map((f) => {
      const p = planOf.get(f) as (PlanData & { __dbgShift?: Vec2 }) | undefined;
      return { level: f.level, pageIndex: p?.pageIndex, shift: p?.__dbgShift ?? { x: 0, y: 0 } };
    });
  }
  if (samePageUnhinted && floors.length > 1) {
    // 同じ敷地の上の離れた区画（車庫・離れ・物置）: 階段が無く、母屋より小さいものは「上の階」ではなく 1 階の一部
    const areaOf = (f: Floor) => f.rooms.reduce((s0, r) => s0 + r.area, 0);
    const base = floors[0];
    for (const f of floors.slice(1)) {
      if (f.stairs.length || areaOf(f) >= areaOf(base) * 0.6) continue;
      base.walls.push(...f.walls);
      base.openings.push(...f.openings);
      base.rooms.push(...f.rooms);
      base.outline.push(...f.outline);
      if (f.planItems?.length) (base.planItems ??= []).push(...f.planItems);
      floors.splice(floors.indexOf(f), 1);
      warnings.push('離れた区画（車庫・離れなど）を上の階ではなく 1 階の一部として読みました（修正画面で確認してください）');
    }
    // 落ちた区画（敷地の枠など）の分だけ階番号が飛んでいたら詰める
    let lv = 1;
    let e = 500;
    for (const f of floors) {
      f.level = lv++;
      f.elevation = e;
      e += f.height;
    }
  }
  finishTopFloorStairs(floors);
  // 面積表の建築面積で上下階の重ね位置を検算: 各階の外形を重ねた面積が建築面積と 5% 以上違い、上の階を半間・1 間だけずらすと 3% 以内に収まるなら、その位置に直す。
  // 910 の格子に乗った家は壁の重なりだけでは半間ずれた位置も同じくらい良く見える（舟橋様邸: 2 階が 910 北にずれて重なり、建築面積 77.29 → 84.28 ㎡、無いはずの張り出し 8.5 ㎡ が生まれていた）
  if (!samePageUnhinted && floors.length >= 2 && areaTable.build != null && areaTable.build > 5) {
    const build = areaTable.build;
    const err0 = Math.abs(outlineUnionArea(floors) - build) / build;
    if (err0 > 0.05) {
      for (let i = 1; i < floors.length; i++) {
        // 候補: 半間・1 間のずらし と、階段の重なりを主にした位置合わせ（吉田大仁様邸: 2 階の壁が 1 階の玄関・ガレージの壁に良く重なり、階段から 6 m 離れて載っていた）
        const shifts = [-910, -455, 0, 455, 910];
        const cands: Vec2[] = [];
        for (const dx of shifts) for (const dy of shifts) if (dx || dy) cands.push({ x: dx, y: dy });
        const pBelow = planOf.get(floors[i - 1]);
        const pThis = planOf.get(floors[i]);
        if (pBelow && pThis) {
          const d = alignOffset(pBelow, pThis, 'stairs');
          if (Math.abs(d.x) > 50 || Math.abs(d.y) > 50) cands.push(d);
        }
        // 上下階の階段がすでに重なっているなら、その重なりを崩すずらしは採らない。
        // 建築面積にはポーチ・庇の屋根も入るので、外形の重なりだけ合わせると階段が半間ずれた位置を選ぶことがある
        // （吉田大仁様邸 1st-2: 車庫が読めて外形が広がったら、2 階が 910 南へ動いて階段が外れた）
        const stairOverlap = (d: Vec2): number => {
          let ov = 0;
          for (const a of floors[i - 1].stairs)
            for (const b of floors[i].stairs) {
              const ix = Math.min(a.maxX, b.maxX + d.x) - Math.max(a.minX, b.minX + d.x);
              const iy = Math.min(a.maxY, b.maxY + d.y) - Math.max(a.minY, b.minY + d.y);
              if (ix <= 0 || iy <= 0) continue;
              ov = Math.max(ov, (ix * iy) / Math.max(1, Math.min((a.maxX - a.minX) * (a.maxY - a.minY), (b.maxX - b.minX) * (b.maxY - b.minY))));
            }
          return ov;
        };
        const ov0 = stairOverlap({ x: 0, y: 0 });
        let best: { d: Vec2; err: number } | null = null;
        for (const d of cands) {
          if (ov0 >= 0.5 && stairOverlap(d) < ov0 - 0.15) continue;
          const moved = floors.map((f, k) => (k >= i ? { ...f, outline: f.outline.map((l) => l.map((q) => ({ x: q.x + d.x, y: q.y + d.y }))) } : f));
          const err = Math.abs(outlineUnionArea(moved) - build) / build;
          if (!best || err < best.err) best = { d, err };
        }
        // 3% 以内に収まるか、差が 3/4 以下に縮んで 8% 以内なら採用
        if (!best || !((best.err <= 0.03 && best.err < err0 * 0.75) || (best.err < err0 * 0.75 && best.err <= 0.08))) continue;
        // その階とその上の階の図面をずらして組み立て直す（上の階はその階に合わせてあるので一緒に動く）
        for (let k = i; k < floors.length; k++) {
          const p = planOf.get(floors[k])!;
          translatePlan(p, best.d);
          const nf = buildFloor(p, floors[k].level, north, warnings, areaTable[floors[k].level], { singleStorey });
          nf.elevation = floors[k].elevation;
          planOf.set(nf, p);
          floors[k] = nf;
        }
        warnings.push(`${floors[i].level}階の重ね位置を面積表の建築面積（${build} ㎡）に合わせて ${best.d.x ? `左右 ${best.d.x} mm` : ''}${best.d.x && best.d.y ? '・' : ''}${best.d.y ? `上下 ${best.d.y} mm` : ''} 動かしました（方眼の「上下階」で重なりを確かめてください）`);
        break;
      }
    }
  }
  // 階段の重なりで上下階の重ね位置を検算: 読み終えた階段（切断線の先まで広げた範囲）が上下で同じ大きさなのに、
  // 半間・1 間ずれて重なっているなら、ぴったり重なる位置へ上の階を直す。910 の格子に乗った家は壁の重なりだけでは
  // 半間ずれた位置も同じくらい良く見え、図面の線だけで合わせた段階では階段の範囲が短くて決められないことがある
  // （吉田大仁様邸 1st-2: 1 階も 2 階も 2,730×1,820 の階段が 910 ずれて重なっていた。直すと壁の乗りも 40 → 48%）
  if (!samePageUnhinted && floors.length >= 2) {
    for (let i = 1; i < floors.length; i++) {
      const d = stairAlignShift(floors[i - 1], floors[i]);
      if (!d) continue;
      for (let k = i; k < floors.length; k++) {
        const p = planOf.get(floors[k]);
        if (!p) continue;
        translatePlan(p, d);
        const nf = buildFloor(p, floors[k].level, north, warnings, areaTable[floors[k].level], { singleStorey });
        nf.elevation = floors[k].elevation;
        planOf.set(nf, p);
        floors[k] = nf;
      }
      const how = [d.x ? `${d.x > 0 ? '右' : '左'}へ ${Math.abs(d.x).toLocaleString()} mm` : '', d.y ? `${d.y > 0 ? '下' : '上'}へ ${Math.abs(d.y).toLocaleString()} mm` : ''].filter(Boolean).join('・');
      warnings.push(`${floors[i].level}階の重ね位置を、階段が下の階の階段にぴったり重なる位置（${how}）へ直しました（方眼の「上下階」で重なりを確かめられます）`);
    }
  }
  // 外壁で上下階の重ね位置を検算: 上の階の外壁が下の階の外壁から半間だけずれて並び、半間動かせば 1 面まるごとそろうなら直す
  // （階段がよく重なっている家は動かさない。flushAlignShift）
  if (!samePageUnhinted && floors.length >= 2) {
    for (let i = 1; i < floors.length; i++) {
      const d = flushAlignShift(floors[i - 1], floors[i]);
      if (!d) continue;
      for (let k = i; k < floors.length; k++) {
        const p = planOf.get(floors[k]);
        if (!p) continue;
        translatePlan(p, d);
        const nf = buildFloor(p, floors[k].level, north, warnings, areaTable[floors[k].level], { singleStorey });
        nf.elevation = floors[k].elevation;
        planOf.set(nf, p);
        floors[k] = nf;
      }
      const how = [d.x ? `${d.x > 0 ? '右' : '左'}へ ${Math.abs(d.x).toLocaleString()} mm` : '', d.y ? `${d.y > 0 ? '下' : '上'}へ ${Math.abs(d.y).toLocaleString()} mm` : ''].filter(Boolean).join('・');
      warnings.push(`${floors[i].level}階の重ね位置を、外壁が下の階の外壁とそろう位置（${how}）へ直しました（方眼の「上下階」で重なりを確かめられます）`);
    }
  }
  // 1階の室名の無い区画で、上階に床が無く（2階図で空白）、周囲の大半がガラス戸・窓なら中庭（コの字プランの光庭）。
  // 面積表の無い図面（CAD 書き出し等）では面積の照合で見つけられないため、上下階の比較で判定する
  if (floors.length >= 2) {
    const f1 = floors[0];
    const f2 = floors[1];
    const pts: Vec2[] = [];
    for (const r of f1.rooms) {
      if (r.name !== '室' || r.area < 6 || r.area > 40) continue;
      const c = polygonCentroid(r.polygon);
      if (f2.outline.some((l) => pointInPolygon(c, l))) continue;
      // 区画の周囲のうち、窓・引戸・開口が占める長さ
      let perim = 0;
      let glass = 0;
      for (let i = 0; i < r.polygon.length; i++) {
        const a = r.polygon[i];
        const b = r.polygon[(i + 1) % r.polygon.length];
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        perim += L;
        for (const o of f1.openings) {
          if (o.kind === 'door' || o.kind === 'entrance') continue;
          const w = f1.walls.find((q) => q.id === o.wallId);
          if (!w) continue;
          const oa = { x: w.a.x + ((w.b.x - w.a.x) * o.t0) / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y), y: w.a.y + ((w.b.y - w.a.y) * o.t0) / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) };
          const ob = { x: w.a.x + ((w.b.x - w.a.x) * o.t1) / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y), y: w.a.y + ((w.b.y - w.a.y) * o.t1) / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) };
          // 開口が区画のこの辺の上にあるか（辺から 150mm 以内、辺の範囲内）
          const dist = (p: Vec2) => {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (L * L || 1)));
            return Math.hypot(p.x - a.x - dx * u, p.y - a.y - dy * u);
          };
          if (dist(oa) < 150 && dist(ob) < 150) glass += o.t1 - o.t0;
        }
      }
      if (perim > 0 && glass / perim >= 0.4) pts.push(c);
    }
    if (pts.length) {
      const p = planOf.get(f1)!;
      const nf = buildFloor(p, f1.level, north, warnings, areaTable[f1.level], { courtyards: pts, singleStorey });
      nf.elevation = f1.elevation;
      planOf.set(nf, p);
      floors[0] = nf;
    }
  }
  // 住宅の階段として大きすぎるもの（縞模様の床・デッキ材などを巻き込んだ）は、上下階の同じ位置の階段に合わせる
  for (const f of floors) {
    const implausible = (s: Stair) => {
      const w = s.maxX - s.minX;
      const h = s.maxY - s.minY;
      return Math.min(w, h) > 2800 || Math.max(w, h) > 5200;
    };
    f.stairs = f.stairs.flatMap((s) => {
      if (!implausible(s)) return [s];
      const idx = floors.indexOf(f);
      const near = [floors[idx - 1], floors[idx + 1]]
        .filter(Boolean)
        .flatMap((g) => g!.stairs)
        .filter((t) => !implausible(t) && t.minX >= s.minX - 300 && t.maxX <= s.maxX + 300 && t.minY >= s.minY - 300 && t.maxY <= s.maxY + 300);
      if (!near.length) return [];
      const t = near[0];
      return [{ ...t, id: s.id, goesUp: s.goesUp }];
    });
  }
  // 上下階で同じ階段の範囲をそろえてから、LDK・ホールと一続きに読めた階段を別の部屋に分ける（升目の座標のうちに）
  finishTopFloorStairs(floors);
  reconcileStairs(floors, warnings);
  for (const f of floors) splitStairRooms(f);
  // 木造として: 部屋・外形・階段も格子へ寄せ、壁厚を在来木造の標準（外壁 160・内壁 130）にそろえる
  if (mfit && moduleInfo) {
    thicknesses.clear();
    for (const f of floors) {
      for (const w of f.walls) {
        w.thickness = woodWallThickness(w);
        thicknesses.add(w.thickness);
      }
      snapFloorWalls(f, mfit);
      snapStairs(f, moduleInfo);
    }
  }
  // 接道・敷地（1階の図面の周囲から）
  const site = base ? detectSite(base.siteTexts, base.siteSegs, base.bbox, north) : null;
  if (site?.warning) warnings.push(site.warning);
  // 道路の文字が無い図面: 隣地境界線の無い側、駐車場（車の記号）のある側を接道と見る
  if (site && base && !site.roads.length && site.edges?.length) {
    const c = { x: (base.bbox.minX + base.bbox.maxX) / 2, y: (base.bbox.minY + base.bbox.maxY) / 2 };
    const neighborSides = new Set(site.edges.filter((e) => e.kind === 'neighbor').map((e) => nearestSide({ x: (e.a.x + e.b.x) / 2 - c.x, y: (e.a.y + e.b.y) / 2 - c.y })));
    const open = SIDES.filter((sd) => !neighborSides.has(sd));
    const cars = floors[0]?.exterior?.cars ?? [];
    let pick: PlanSide | null = null;
    if (open.length && cars.length) {
      const count = new Map<PlanSide, number>();
      for (const car of cars) {
        const sd = nearestSide({ x: car.x - c.x, y: car.y - c.y });
        if (open.includes(sd)) count.set(sd, (count.get(sd) ?? 0) + 1);
      }
      pick = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    if (!pick && open.length === 1 && neighborSides.size >= 2) pick = open[0];
    if (pick) site.roads.push({ side: pick, label: cars.length ? '隣地境界線の無い側（駐車場あり）' : '隣地境界線の無い側', source: 'inferred' });
  }
  // 常識で補ったガレージのシャッターは、接道が分かれば道路側の辺へ置き直す
  const roadSide = site?.roads[0]?.side;
  const f1 = floors[0];
  if (roadSide && f1 && relocateAutoShutters(f1.walls, f1.openings, f1.rooms, roadSide, f1.level)) warnings.push(`1階 車庫: シャッターを道路側（${{ top: '上', bottom: '下', left: '左', right: '右' }[roadSide]}）の辺に置き直しました`);
  // （上下階の検算で階を組み立て直したあとにも、もう一度）
  finishTopFloorStairs(floors);
  reconcileStairs(floors);
  // 原点を1階外壁芯の左上に揃える
  const o1 = floors[0]?.outline.flat() ?? [];
  if (o1.length) {
    const dx = -Math.min(...o1.map((p) => p.x));
    const dy = -Math.min(...o1.map((p) => p.y));
    for (const f of floors) translateFloor(f, dx, dy);
    if (site) translateSite(site, dx, dy);
    if (moduleInfo) translateModule(moduleInfo, dx, dy);
    // 点検用（図面の線に読み取り結果を重ねる）: 図面の座標 → モデルの座標のずらし量を、最後の原点合わせまで含めて残す
    if ((globalThis as any).__DBG_PLANS) {
      (globalThis as any).__DBG_PLANOF = floors.map((f) => {
        const p = planOf.get(f) as (PlanData & { __dbgShift?: Vec2 }) | undefined;
        return { level: f.level, pageIndex: p?.pageIndex, shift: { x: (p?.__dbgShift?.x ?? 0) + dx, y: (p?.__dbgShift?.y ?? 0) + dy } };
      });
    }
  }
  // 階ごとの元のページ（読み込み結果の「PDF の中身」で、どのページを何階として読んだかを見せる）
  const floorPages: Record<number, number> = {};
  for (const f of floors) {
    const pg = planOf.get(f)?.pageIndex;
    if (pg != null) floorPages[f.level] = pg;
  }
  return { name, floors, northAngleDeg: north, site: site ?? undefined, module: moduleInfo, thicknesses: [...thicknesses].sort((a, b) => a - b), northDetected: northDeg != null, areaTable, floorPages };
}

export function translateFloor(f: Floor, dx: number, dy: number) {
  const tr = (p: Vec2) => ({ x: Math.round((p.x + dx) * 10) / 10, y: Math.round((p.y + dy) * 10) / 10 });
  for (const w of f.walls) {
    w.a = tr(w.a);
    w.b = tr(w.b);
  }
  for (const r of f.rooms) {
    r.polygon = r.polygon.map(tr);
    r.labelPos = tr(r.labelPos);
  }
  for (const s of f.stairs) {
    s.minX += dx;
    s.maxX += dx;
    s.minY += dy;
    s.maxY += dy;
  }
  f.outline = f.outline.map((l) => l.map(tr));
  if (f.planItems) for (const it of f.planItems) { it.x = Math.round(it.x + dx); it.y = Math.round(it.y + dy); }
  if (f.notes) for (const n of f.notes) { n.x = Math.round(n.x + dx); n.y = Math.round(n.y + dy); }
  if (f.exterior) {
    f.exterior.cars = f.exterior.cars.map((c) => ({ ...c, x: Math.round(c.x + dx), y: Math.round(c.y + dy) }));
    f.exterior.trees = f.exterior.trees.map((t) => ({ ...t, x: Math.round(t.x + dx), y: Math.round(t.y + dy) }));
  }
}

export { normalizeText };

/** 部屋名のラベル（手修正で置く・既存の部屋から引き継ぐ） */
export interface RoomLabel {
  name: string;
  x: number;
  y: number;
  /** この部屋だけの天井高 (mm)（修正画面で範囲指定したもの） */
  ceilingHeight?: number;
  /** 用途を手で指定した場合（同じ名前の部屋に引き継ぐ） */
  type?: RoomType;
  /** ガレージの建て方を手で指定した場合 */
  garageKind?: GarageKind;
  /** 床の FL からの段差 (mm)（小上がり・ダウンリビング。修正画面・3D で指定） */
  floorOffset?: number;
  /** 吹抜の落下防止の種類 */
  voidGuard?: VoidGuard;
  /** 床の仕上げの上書き（3D で指定） */
  floorFinish?: FloorFinish;
}

/**
 * 手で修正した壁・開口・部屋名から、その階の部屋・外壁・開口を作り直す。
 * 図面の読み取りと同じ処理（壁で囲まれた範囲を部屋にする）を、修正後の壁で実行する。
 */
export function rebuildFloor(f: Floor, labels: RoomLabel[], northAngleDeg: number, warnings: string[] = [], keep?: { rooms: Room[]; removed: { a: Vec2; b: Vec2 }[] }): Floor {
  // 以前の読み取り（シャッターの壁を足す前）のガレージ: 壁の無い辺に外壁＋シャッターを足してから作り直す
  if (keep?.rooms.length) ensureGarageShutters(f.walls, f.openings, keep.rooms, f.level);
  const groups: { u: Vec2 }[] = [];
  const groupOf = (u: Vec2) => {
    let gi = groups.findIndex((g) => Math.abs(g.u.x * u.y - g.u.y * u.x) < 0.02 && g.u.x * u.x + g.u.y * u.y > 0);
    if (gi < 0) {
      groups.push({ u });
      gi = groups.length - 1;
    }
    return gi;
  };
  const kindOf = (k: Opening['kind']): DetectedOpening['kind'] => (k === 'entrance' || k === 'shutter' ? 'door' : k === 'open' ? 'open' : k);
  const walls: WWall[] = [];
  for (const w of f.walls) {
    let a = w.a;
    let b = w.b;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 30) continue;
    let u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    // 向きをそろえる（同じ直線上の壁を同じ組にするため）
    const swapped = u.x < -1e-6 || (Math.abs(u.x) <= 1e-6 && u.y < 0);
    if (swapped) {
      [a, b] = [b, a];
      u = { x: -u.x, y: -u.y };
    }
    const n = { x: -u.y, y: u.x };
    const g = groupOf(u);
    const t0 = a.x * u.x + a.y * u.y;
    const o = a.x * n.x + a.y * n.y;
    const openings: DetectedOpening[] = f.openings
      .filter((op) => op.wallId === w.id)
      .map((op) => {
        const s0 = swapped ? L - op.t1 : op.t0;
        const s1 = swapped ? L - op.t0 : op.t1;
        return {
          g,
          o,
          d: w.thickness,
          t0: t0 + s0,
          t1: t0 + s1,
          kind: kindOf(op.kind),
          hingeAtStart: op.hingeAtStart == null ? undefined : swapped ? !op.hingeAtStart : op.hingeAtStart,
          swingSign: op.swingSide == null ? undefined : ((swapped ? -op.swingSide : op.swingSide) as 1 | -1),
          confidence: 1,
        };
      });
    walls.push({ a, b, u, n, d: w.thickness, t0, t1: t0 + L, o, g, openings, joinedA: false, joinedB: false });
  }
  joinWalls(walls);
  const xs = walls.flatMap((w) => [w.a.x, w.b.x]);
  const ys = walls.flatMap((w) => [w.a.y, w.b.y]);
  const bbox = xs.length ? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const plan: PlanData = {
    pageIndex: 0,
    bbox,
    floorHint: f.level,
    walls,
    texts: labels.map((l) => ({ str: l.name, x: l.x, y: l.y, size: 250, angle: 0 })),
    segs: [],
    arcs: [],
    siteTexts: [],
    siteSegs: [],
    wallPolys: [],
    sashPolys: [],
    roomFills: [],
  };
  // 手で外構・後付け／離れのガレージにした区画は家の外形から外す。元の読み取りで家の外だったガレージも同じ扱いを保つ
  const outdoorAt = labels
    .filter((l) => {
      if (l.type) return isExteriorWorks(l.type) || (l.type === 'garage' && (l.garageKind === 'attached' || l.garageKind === 'detached'));
      const prev = f.rooms.find((r) => pointInPolygon({ x: l.x, y: l.y }, r.polygon));
      return !!prev && (isExteriorWorks(prev.type) || (prev.type === 'garage' && (prev.garageKind === 'attached' || prev.garageKind === 'detached')));
    })
    .map((l) => ({ x: l.x, y: l.y }));
  const nf = buildFloor(plan, f.level, northAngleDeg, warnings, undefined, { outdoorAt, noAutoOpenings: true });
  // 階段（読み取ったもの・方眼で描いたもの）が LDK・ホールと一続きなら、読み取りのときと同じように「階段」の部屋に分ける
  // （作り直しのたびに LDK が階段の分だけ広くなったり戻ったりしないように）
  nf.stairs = f.stairs;
  splitStairRooms(nf);
  // 窓・ドアの種類は、修正前（読み取り結果や手で選んだもの）をそのまま引き継ぐ。
  // 作り直しの自動判定（外壁の引戸→窓、内壁の窓→引戸 など）で、手で選んだ種類が変わらないように
  const center = (fl: Floor, op: Opening) => {
    const w = fl.walls.find((x) => x.id === op.wallId);
    if (!w) return null;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const u = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
    const t = (op.t0 + op.t1) / 2;
    return { p: { x: w.a.x + u.x * t, y: w.a.y + u.y * t }, u };
  };
  for (const op of nf.openings) {
    const c = center(nf, op);
    if (!c) continue;
    let best: { src: Opening; d: number; u: Vec2 } | null = null;
    for (const src of f.openings) {
      const sc = center(f, src);
      if (!sc) continue;
      if (Math.abs(sc.u.x * c.u.y - sc.u.y * c.u.x) > 0.1) continue;
      const d = Math.hypot(sc.p.x - c.p.x, sc.p.y - c.p.y);
      if (d < 200 && (!best || d < best.d)) best = { src, d, u: sc.u };
    }
    if (!best) continue;
    const src = best.src;
    const reversed = best.u.x * c.u.x + best.u.y * c.u.y < 0;
    op.kind = src.kind;
    if (src.kind === 'window') {
      // 修正前の腰高・高さ・形（掃き出し／腰窓／小窓…）をそのまま引き継ぐ。
      // 以前は作り直しで窓と判定された開口には引き継いでおらず、方眼で「掃き出し」に変えても作り直しで腰窓に戻っていた
      op.sill = src.sill ?? op.sill ?? 900;
      op.height = src.height || op.height || 1100;
      op.windowStyle = src.windowStyle ?? op.windowStyle;
    } else {
      op.sill = 0;
      op.height = src.kind === 'entrance' ? Math.max(2200, src.height) : src.kind === 'shutter' ? src.height || 2300 : src.height || 2000;
      op.windowStyle = undefined;
    }
    if (src.hingeAtStart != null) op.hingeAtStart = reversed ? !src.hingeAtStart : src.hingeAtStart;
    if (src.swingSide != null) op.swingSide = (reversed ? -src.swingSide : src.swingSide) as 1 | -1;
  }
  // 元の図面では壁以外（色の塗り・建具の記号など）で分かれていた部屋は、そのまま分けておく。
  // ただし、手で消した壁の所は分けない（部屋をつなげたい修正なので）
  if (keep?.rooms.length) {
    const out: Room[] = [];
    for (const r of nf.rooms) {
      const inside = keep.rooms.filter((q) => pointInPolygon(q.labelPos, r.polygon));
      const nearRemoved = keep.removed.some((w) => {
        const m = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
        return pointInPolygon(m, r.polygon) || r.polygon.some((p, i) => distPointSegment(m, p, r.polygon[(i + 1) % r.polygon.length]) < 300);
      });
      const cover = inside.reduce((a, q) => a + q.area, 0);
      if (inside.length >= 2 && !nearRemoved && Math.abs(cover - r.area) <= Math.max(0.6, r.area * 0.04)) out.push(...inside);
      else out.push(r);
    }
    nf.rooms = out;
  }
  // 部屋名は、その部屋の中に置かれたラベルの名前に（手で付け直した名前・用途を反映）
  for (const r of nf.rooms) {
    const l = labels.find((x) => pointInPolygon({ x: x.x, y: x.y }, r.polygon));
    if (!l) continue;
    if (l.name !== r.name) {
      r.name = l.name;
      const c = classifyRoomName(l.name);
      if (c) r.type = c;
    }
    if (l.type) r.type = l.type;
    if (r.type === 'garage' && l.garageKind) r.garageKind = l.garageKind;
    if (l.ceilingHeight) r.ceilingHeight = l.ceilingHeight;
    else delete r.ceilingHeight;
    // 床の段差・吹抜の手すり・床の仕上げ（修正画面・3D で決めたもの。無ければ室名から: 小上がり +400 など）
    const byName = floorOffsetByName(r.name);
    if (l.floorOffset != null && l.floorOffset !== 0) r.floorOffset = l.floorOffset;
    else if (l.floorOffset === 0 || byName == null) delete r.floorOffset;
    else r.floorOffset = byName;
    if (l.voidGuard) r.voidGuard = l.voidGuard;
    else delete r.voidGuard;
    if (l.floorFinish) r.floorFinish = l.floorFinish;
    else delete r.floorFinish;
    r.labelPos = { x: l.x, y: l.y };
  }
  // 図面から読んだ家具は、部屋が描き直されても同じ位置にあるものとして部屋を引き直す
  const planItems = f.planItems?.map((it) => ({ ...it, roomId: nf.rooms.find((r) => pointInPolygon({ x: it.x, y: it.y }, r.polygon))?.id ?? it.roomId }));
  const notes = f.notes?.map((n) => ({ ...n, roomId: nf.rooms.find((r) => pointInPolygon({ x: n.x, y: n.y }, r.polygon))?.id ?? n.roomId }));
  return { ...nf, elevation: f.elevation, height: f.height, ceilingHeight: f.ceilingHeight, stairs: f.stairs, planItems, exterior: f.exterior, notes, ...(f.posts ? { posts: f.posts } : {}) };
}
