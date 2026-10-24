/**
 * 解析結果（壁片・開口・文字）から建物モデルを組み立てる
 */
import type { BuildingModel, Floor, FurnitureKind, Opening, PlanSide, Room, RoomType, Stair, Vec2, Wall, WindowStyle } from '../core/types';
import { bboxGap, bboxOf, distPointSegment, pointInPolygon, polygonArea, polygonCentroid, type BBox } from '../core/geometry';
import type { PageVectors } from './pdfExtract';
import { detectWalls, heavyWidthThreshold, polylineArcs, type Arc, type DetectedOpening, type Seg, type WallDetection } from './walls';
import { rasterizeSegments, dominantAngles, detectWallsRaster, detectWallsRasterAuto, type BinaryImage } from './rasterWalls';
import { Grid, WALL, OUTSIDE, FREE, dilateMask, erodeMask, traceMask } from './raster';
import { classifyRoomName, parseAreaLabel, parseFloorTitle, parseStairMark, normalizeText, parseSashCode, parseFlOffset, parseStepCount, isOpenMark, parseSashKind } from './labels';
import { detectStairs, stairEntryFromArrow } from './stairs';
import { inferNamelessRoom, doorSwingFor, isCirculation, mustSeparate } from './roomKnowledge';
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
    .map((s) => ({ a: sc(s.a), b: sc(s.b), width: s.width, dashed: s.dashed, source: s.source }));
  const curves: Arc[] = p.curves.filter((c) => !c.dashed).map((c) => ({ p0: sc(c.p0), p1: sc(c.p1), p2: sc(c.p2), p3: sc(c.p3), width: c.width }));
  return {
    pageIndex: p.pageIndex,
    segs,
    // 曲線を折れ線で書き出す図面では、折れ線から円弧（開き戸の軌跡）を復元する
    arcs: curves.length < 8 ? [...curves, ...polylineArcs(segs.filter((s) => s.source !== 'fill'))] : curves,
    texts: p.texts.map((t) => ({ str: t.str, x: t.cx * k, y: t.cy * k, size: t.size * k, angle: t.angle })),
    fills: p.fills.map((f) => ({ polygon: f.polygon.map(sc) })),
    masks: p.fills.filter((f) => /^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(f.color) && f.polygon.length >= 4 && f.polygon.length <= 8).map((f) => f.polygon.map(sc)),
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
    const runs: { t0: number; t1: number; ops: DetectedOpening[]; dsum: number; lsum: number }[] = [];
    for (const it of ax.items) {
      const last = runs[runs.length - 1];
      const L = it.t1 - it.t0;
      if (last && it.t0 <= last.t1 + 30) {
        last.t1 = Math.max(last.t1, it.t1);
        if (it.op) last.ops.push(it.op);
        else {
          last.dsum += it.d * L;
          last.lsum += L;
        }
      } else {
        runs.push({ t0: it.t0, t1: it.t1, ops: it.op ? [it.op] : [], dsum: it.op ? 0 : it.d * L, lsum: it.op ? 0 : L });
      }
    }
    for (const r of runs) {
      const d = r.lsum > 0 ? r.dsum / r.lsum : r.ops[0]?.d || 120;
      const a = { x: grp.u.x * r.t0 + grp.n.x * ax.o, y: grp.u.y * r.t0 + grp.n.y * ax.o };
      const b = { x: grp.u.x * r.t1 + grp.n.x * ax.o, y: grp.u.y * r.t1 + grp.n.y * ax.o };
      walls.push({ a, b, u: grp.u, n: grp.n, d, t0: r.t0, t1: r.t1, o: ax.o, g: ax.g, openings: r.ops, joinedA: false, joinedB: false });
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
function clusterPlans(walls: WWall[], ext?: BBox, mergeGap = 600, minPart = 2500, windowSegs?: Seg[]): WWall[][] {
  const parent = walls.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const unite = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const A = walls[i];
      const B = walls[j];
      if (bboxGap(wallBBox(A), wallBBox(B)) > 40) continue;
      const near =
        distPointSegment(A.a, B.a, B.b) <= B.d / 2 + 40 ||
        distPointSegment(A.b, B.a, B.b) <= B.d / 2 + 40 ||
        distPointSegment(B.a, A.a, A.b) <= A.d / 2 + 40 ||
        distPointSegment(B.b, A.a, A.b) <= A.d / 2 + 40;
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
function applyWindowVocabulary(openings: Opening[], info: Map<number, { room: RoomType | null; south: number; drawn: boolean }>) {
  const living = new Set<RoomType | null>(['ldk', 'living', 'dining', 'japanese']);
  const cands = openings
    .map((o, i) => ({ o, i, inf: info.get(i) }))
    .filter((x) => x.o.kind === 'window' && x.o.windowStyle === 'hakidashi' && x.inf && !x.inf.drawn && living.has(x.inf.room));
  if (cands.length <= 1) return;
  // 庭側（南）に面した幅の広い窓を掃き出しに残す
  cands.sort((a, b) => b.o.t1 - b.o.t0 + b.inf!.south * 1500 - (a.o.t1 - a.o.t0 + a.inf!.south * 1500));
  for (const x of cands.slice(1)) {
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

/** 1つの領域の室名のうち代表となるもの（居室を優先、同格なら大きい文字） */
function mainName<T extends { type: RoomType; size: number }>(names: T[]): T | undefined {
  return names.slice().sort((p, q) => MAIN_PRIORITY.indexOf(p.type) - MAIN_PRIORITY.indexOf(q.type) || q.size - p.size)[0];
}

/**
 * 文字を室名として使える形に整える。説明文（「上部寝室から使う」など）は null。
 * 「※」以降の注記・括弧の帖数は除く。
 */
export function cleanRoomName(raw: string): string | null {
  let s0 = raw.trim().replace(/[※＊*].*$/, '').replace(/[（(][^）)]*[）)]?$/, '').trim();
  if (!s0) return null;
  const n = normalizeText(s0);
  // 説明文: 長い、または助詞・動詞の語尾を含む
  const sentence = /(から|まで|ため|する|して|できる|ように|ません|ます|です|だけ|の空|を|が見|に使|予定|検討|想定|可能)/.test(n);
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
export function voidRectangles(plan: { segs: Seg[]; texts: MmText[] }): BBox[] {
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
export function readAreaTable(pages: PageMm[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const p of pages) {
    for (const t of p.texts) {
      const m = /^([1-9])階$/.exec(normalizeText(t.str).replace(/\s/g, ''));
      if (!m) continue;
      const cands = followingOnLine(t, p.texts, 20)
        .map((q) => ({ q, v: /^(\d{1,3}\.\d{1,2})(㎡|m2|m²)?$/.exec(normalizeText(q.str).replace(/\s/g, '')) }))
        .filter((o) => o.v);
      if (cands.length && out[+m[1]] == null) out[+m[1]] = parseFloat(cands[0].v![1]);
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

/** 1つの図面（階）から部屋・外形などを作る */
export interface FloorHints {
  /** この点を含む区画は中庭（上階の床が無く、ガラス戸に囲まれた室名の無い区画） */
  courtyards?: Vec2[];
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
  const walls = curved.length ? [...plan.walls, ...curved] : plan.walls;
  if (curved.length) (globalThis as { __curvedTrace?: number[] }).__curvedTrace = [...((globalThis as { __curvedTrace?: number[] }).__curvedTrace ?? []), curved.length];
  const res = 20;
  const grid = Grid.around(plan.bbox.minX, plan.bbox.minY, plan.bbox.maxX, plan.bbox.maxY, res, 1200);
  // 部屋の区切り: 壁・壁の塗り・窓の白抜き・吹抜（×印の四角）の輪郭
  const voidRects = voidRectangles(plan);
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
  // 家具・車の記号（実線のまとまり・破線の輪郭）。車庫の出入口を塞ぐ判定にも使うので先に読む
  const segsU = plan.scan || plan.loose ? [] : uniqueSegs([...plan.segs, ...plan.siteSegs]);
  const dashed = segsU.length ? dashedOutlines(segsU) : [];
  const solidSymbols = segsU.length ? detectSymbols(segsU) : [];
  const symbols = [...solidSymbols, ...dashedCarSymbols(dashed, solidSymbols)];
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
            if (t > -200 && t < L + 200 && o > 150 && o < 2500) blocked = true;
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
        if (Math.abs(e.w.u.x * f.w.u.x + e.w.u.y * f.w.u.y) < 0.98) continue;
        const dx = f.p.x - e.p.x;
        const dy = f.p.y - e.p.y;
        const L = Math.hypot(dx, dy);
        // 車庫の出入口 1 ヵ所ぶん（2.4〜6.5m。短い線は玄関の上がり框などを拾う。長い線は敷地の線を拾って外を部屋にしてしまう）
        if (L < 2400 || L > 6500) continue;
        // 結ぶ線は壁と直交（壁の向きに沿う成分が小さい）
        if (Math.abs(dx * e.w.u.x + dy * e.w.u.y) > 60) continue;
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
  if (plan.roomFills.length) {
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
        const x = i % grid.w;
        for (const j of [x > 0 ? i - 1 : -1, x < grid.w - 1 ? i + 1 : -1, i - grid.w, i + grid.w]) if (j >= 0 && j < lb.length && lb[j]) touchesFill.add(lb[j]);
      }
      for (let i = 0; i < lb.length; i++) if (lb[i] && sz[lb[i]] < sliverCells && touchesFill.has(lb[i])) grid.data[i] = WALL;
    }
    for (let iter = 0; iter < 3; iter++) {
      const { labels: lb } = grid.labelComponents();
      const hasName = new Set<number>();
      for (const t of named) {
        const l = labelNear(grid, lb, t);
        if (l) hasName.add(l);
      }
      // 塗りの線の両側の区画（線の太さ分だけ離れて見る）
      const sides = (i: number): number[] => {
        const x = i % grid.w;
        const out = new Set<number>();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          for (let k = 1; k <= 3; k++) {
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
      // 名前の無い断片ごとに、塗りの線を挟んで接する長さが最も長い隣の区画を選ぶ
      const contact = new Map<number, Map<number, number>>();
      const cellSides = new Map<number, number[]>();
      for (const i of fillCells) {
        if (grid.data[i] !== WALL) continue;
        const sd = sides(i);
        if (sd.length !== 2) continue;
        cellSides.set(i, sd);
        for (const [u, v] of [sd, [sd[1], sd[0]]]) {
          if (hasName.has(u)) continue;
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
  for (const t of plan.texts) {
    const l = labelAt({ x: t.x, y: t.y });
    if (!l) continue;
    if (!acc.has(l)) acc.set(l, { id: l, names: [], others: [], areas: [] });
    const a = acc.get(l)!;
    const area = parseAreaLabel(t.str);
    const tatami = area?.tatami ?? (area?.m2 ? area.m2 / 1.62 : undefined);
    if (tatami) a.areas.push({ tatami, x: t.x, y: t.y });
    const st = parseStairMark(t.str);
    if (st) a.stair = st;
    const nm = cleanRoomName(t.str);
    const type = nm ? classifyRoomName(nm) : null;
    if (type) a.names.push({ str: nm!, type, size: t.size, x: t.x, y: t.y });
    else if (nm && !area && !st && looksLikeRoomName(nm)) a.others.push({ str: nm, size: t.size, x: t.x, y: t.y });
  }
  // 帖数は、室名に最も近い表記を採用（1つの領域に複数の部屋が入った場合）
  for (const a of acc.values()) {
    if (!a.areas.length) continue;
    const ref = mainName(a.names) ?? a.others[0];
    const near = ref ? a.areas.slice().sort((p, q) => Math.hypot(p.x - ref.x, p.y - ref.y) - Math.hypot(q.x - ref.x, q.y - ref.y))[0] : a.areas[0];
    a.tatami = near.tatami;
  }

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
  for (let l = 1; l < sizes.length; l++) {
    if (sizes[l] < minCells) continue;
    const mask = new Uint8Array(grid.w * grid.h);
    for (let i = 0; i < mask.length; i++) if (labels[i] === l) mask[i] = 1;
    const dil = dilateMask(mask, grid.w, grid.h, k, (i) => grid.data[i] === WALL);
    const loops = traceMask(dil, grid);
    if (!loops.length) continue;
    const poly = loops[0];
    const area = Math.abs(polygonArea(poly)) / 1e6;
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
      let main = mainName(a.names)!;
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
  for (const vr of voidRects) {
    const ra = ((vr.maxX - vr.minX) * (vr.maxY - vr.minY)) / 1e6;
    const r = rooms.find((rm) => {
      const c = rm.polygon.reduce((a0, q) => ({ x: a0.x + q.x / rm.polygon.length, y: a0.y + q.y / rm.polygon.length }), { x: 0, y: 0 });
      return c.x > vr.minX && c.x < vr.maxX && c.y > vr.minY && c.y < vr.maxY && rm.area > ra * 0.6 && rm.area < ra * 1.4;
    });
    if (!r) continue;
    r.name = '吹抜';
    r.type = 'void';
    for (const o of rooms) {
      if (o === r || !/吹抜/.test(o.name)) continue;
      const rest = o.name.split('・').filter((n) => !/吹抜/.test(n));
      if (rest.length) o.name = rest.join('・');
      if (o.type === 'void') o.type = rest.length ? classifyRoomName(rest[0]) ?? 'other' : 'other';
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
    const excluded = rooms.filter((r) => r.type === 'void' || r.type === 'garage' || (r.type === 'balcony' && !/庭/.test(r.name))).reduce((s0, r) => s0 + r.area, 0);
    const A = (cells * res * res) / 1e6 - excluded;
    const err0 = (A - expectedArea) / expectedArea;
    if (err0 > 0.04) {
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
      if (best && best.err < 0.025 && best.err < err0 / 2) {
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

  // 「玄関ホール」は床のある通路（hall）として読むが、玄関（土間）の室名が無い図面ではそれを玄関にする
  if (level === 1 && !rooms.some((r) => r.type === 'entrance')) {
    const gh = rooms.find((r) => r.type === 'hall' && /玄関/.test(r.name));
    if (gh) gh.type = 'entrance';
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
  const winInfo = new Map<number, { room: RoomType | null; south: number; drawn: boolean }>();
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
      if (sizes[l] < minCells) continue;
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
      const inSign = exterior ? -(outsideSign ?? 1) : 1;
      const inRoom = roomAt({ x: center.x + w.n.x * inSign * (w.d / 2 + 60), y: center.y + w.n.y * inSign * (w.d / 2 + 60) });
      const otherRoom = roomAt({ x: center.x - w.n.x * inSign * (w.d / 2 + 60), y: center.y - w.n.y * inSign * (w.d / 2 + 60) });
      const width = t1 - t0;
      let kind: Opening['kind'];
      let sill = 0;
      let height = 2000;
      let windowStyle: WindowStyle | undefined;
      // 外壁扱いの壁でも、両側が室内（中庭に面する壁の、ホール側の区間など）なら室内の建具として扱う
      const outdoorType = (t: string | undefined) => !t || t === 'balcony' || t === 'porch' || t === 'garage';
      const bothInside = !!inRoom && !!otherRoom && !outdoorType(inRoom.type) && !outdoorType(otherRoom.type);
      if (exterior && !bothInside) {
        if (level === 1 && (op.kind === 'door' || (inRoom?.type === 'entrance' && op.kind !== 'window'))) {
          kind = 'entrance';
          height = 2200;
        } else if (op.kind === 'door') {
          // 2 階以上の外壁の扉（バルコニーへの出入り）
          kind = 'door';
          height = 2000;
        } else {
          kind = 'window';
          const outN = { x: w.n.x * (outsideSign ?? 1), y: w.n.y * (outsideSign ?? 1) };
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
          void noteKind;
        }
      } else {
        if (op.kind === 'door') kind = 'door';
        else if (op.kind === 'window') kind = 'sliding';
        else kind = 'open';
        // 「開口」の注記 = 建具なしの開口部。「引違」「FIX」の注記があれば引戸／固定として扱う
        if (noteOpen) kind = 'open';
        else if (noteKind === 'sliding' && kind !== 'door') kind = 'sliding';
        height = 2000;
        if (noteSash && Math.abs(noteSash.width - width) <= Math.max(300, width * 0.35)) height = noteSash.height >= 1800 ? noteSash.height : 2000;
        void otherRoom;
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
        hingeAtStart: op.hingeAtStart,
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

  applyWindowVocabulary(openings, winInfo);

  // ---- 階段 ----
  const stairs: Stair[] = [];
  const nonWallSegs = plan.segs.filter((s) => {
    const m = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
    const [x, y] = grid.cellOf(m);
    return grid.get(x, y) === FREE;
  });
  const stairMarks = plan.texts.filter((t) => parseStairMark(t.str) != null || /階段/.test(t.str));
  for (const c of detectStairs(nonWallSegs, plan.bbox)) {
    // 「UP・DN・階段」の文字が近くに無いもの（タイル目地・デッキ材など）は階段にしない
    if (stairMarks.length && !stairMarks.some((t) => t.x > c.minX - 900 && t.x < c.maxX + 900 && t.y > c.minY - 900 && t.y < c.maxY + 900)) continue;
    {
      const cc = { x: (c.minX + c.maxX) / 2, y: (c.minY + c.maxY) / 2 };
      const rr = roomAt(cc);
      if (rr && (rr.type === 'balcony' || rr.type === 'garage' || rr.type === 'porch')) continue;
      // 建物の外（寸法線・図面の余白の等間隔線）は階段にしない
      if (!rr && !outline.some((l) => pointInPolygon(cc, l))) continue;
    }
    // 周囲の壁面まで広げる
    const r = { ...c };
    const grow = (dx: number, dy: number) => {
      for (let step = 0; step < 20; step++) {
        const probe =
          dx !== 0
            ? { x: (dx > 0 ? r.maxX : r.minX) + dx * res, y: (r.minY + r.maxY) / 2 }
            : { x: (r.minX + r.maxX) / 2, y: (dy > 0 ? r.maxY : r.minY) + dy * res };
        if (sideState(probe) !== FREE) break;
        if (dx > 0) r.maxX += res;
        if (dx < 0) r.minX -= res;
        if (dy > 0) r.maxY += res;
        if (dy < 0) r.minY -= res;
      }
    };
    grow(1, 0);
    grow(-1, 0);
    grow(0, 1);
    grow(0, -1);
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
    const kind: Stair['kind'] = c.flights >= 2 || Math.max(w, h) / Math.min(w, h) < 1.5 ? 'u' : 'straight';
    // 同じ部屋の UP/DN 記号
    const hasDn = plan.texts.some((t) => parseStairMark(t.str) === 'down' && t.x > r.minX - 300 && t.x < r.maxX + 300 && t.y > r.minY - 300 && t.y < r.maxY + 300);
    // 昇り口: 図面の矢印（軸と矢じり）か UP/DN の文字の位置から。読めなければ壁の少ない辺
    const arrowSide = stairEntryFromArrow(
      r,
      nonWallSegs,
      plan.texts.filter((t) => parseStairMark(t.str) != null).map((t) => ({ x: t.x, y: t.y })),
    );
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
    const entry: Stair['entry'] = arrowSide && sideWallRatio(arrowSide) < 0.9 ? arrowSide : bySense[0].s;
    void sides;
    // 「14段」などの段数注記（階段の近く）
    const stepNote = plan.texts
      .map((t) => ({ n: parseStepCount(t.str), d: Math.hypot(Math.max(0, r.minX - t.x, t.x - r.maxX), Math.max(0, r.minY - t.y, t.y - r.maxY)) }))
      .filter((q) => q.n != null && q.d <= 1200)
      .sort((a, b) => a.d - b.d)[0];
    stairs.push({
      id: `F${level}-S${stairs.length + 1}`,
      minX: r.minX,
      minY: r.minY,
      maxX: r.maxX,
      maxY: r.maxY,
      kind,
      entry,
      goesUp: !hasDn,
      ...(stepNote ? { steps: stepNote.n! } : {}),
    });
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

  if (!rooms.length) warnings.push(`${level}階: 部屋を検出できませんでした`);
  // 設計士のメモ（室名より小さい文字の説明文）
  const labelSizes = rooms.map((r) => plan.texts.find((t) => Math.abs(t.x - r.labelPos.x) < 50 && Math.abs(t.y - r.labelPos.y) < 50)?.size ?? 0).filter((s) => s > 0).sort((a, b) => a - b);
  const labelSize = labelSizes.length ? labelSizes[Math.floor(labelSizes.length / 2)] : 280;
  const nearTexts = plan.siteTexts.filter((t) => t.x > plan.bbox.minX - 3000 && t.x < plan.bbox.maxX + 3000 && t.y > plan.bbox.minY - 3000 && t.y < plan.bbox.maxY + 3000 && !plan.texts.some((u) => u.x === t.x && u.y === t.y));
  const notes = plan.scan ? [] : detectNotes([...plan.texts, ...nearTexts], labelSize, rooms);
  // 家具・設備・車・植栽の記号（スキャン図面には無い）
  const sym = plan.scan || plan.loose ? { items: [], exterior: { cars: [], trees: [] } } : symbolsToItems(symbols, rooms, outWalls, outline, level, (globalThis as { __symTrace?: string[] }).__symTrace);
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
  if (ctx && g.__ctxTrace) g.__ctxTrace.push(...ctx.trace.map((t) => `${level}F ${t}`));
  // 同じ部屋で同じ種類を文脈読みが読めたら、形の決め打ちの方は外す（食卓はキッチンと兼ねて読むことがあるので、キッチンを読んだ部屋の食卓も）
  const taken = new Set((ctx?.items ?? []).flatMap((it) => (it.kind === 'kitchen' ? [`${it.roomId}:kitchen`, `${it.roomId}:dining`] : [`${it.roomId}:${it.kind}`])));
  const merged0 = [...(ctx?.items ?? []), ...sym.items.filter((it) => !(it.roomId && taken.has(`${it.roomId}:${it.kind}`)))];
  // 常識で整理（LDK に食卓 2 つ、玄関に便器…は読み違い）
  const sensed = senseFurniture(merged0, rooms);
  if (sensed.removed.length && g.__ctxTrace) g.__ctxTrace.push(...sensed.removed.map((t) => `${level}F 整理: ${t}`));
  const mergedItems = sensed.items;
  void (null as FurnitureKind | null);
  return {
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

/** 壁の塗りの色: その色の塗りの頂点の大半が、検出した壁の上にある色 */
function wallFillColors(fills: { poly: Vec2[]; color: string }[], walls: WWall[]): Set<string> {
  const stat = new Map<string, { n: number; on: number; polys: number; thin: number }>();
  for (const f of fills) {
    const st = stat.get(f.color) ?? { n: 0, on: 0, polys: 0, thin: 0 };
    st.polys++;
    // 壁の塗りは細長い（部屋の形の塗りは頂点が壁の上にあっても壁ではない）
    let per = 0;
    for (let i = 0; i < f.poly.length; i++) per += Math.hypot(f.poly[(i + 1) % f.poly.length].x - f.poly[i].x, f.poly[(i + 1) % f.poly.length].y - f.poly[i].y);
    if (per > 0 && (2 * Math.abs(polygonArea(f.poly))) / per <= 400) st.thin++;
    for (const q of f.poly) {
      st.n++;
      if (walls.some((w) => distPointSegment(q, w.a, w.b) <= w.d / 2 + 40)) st.on++;
    }
    stat.set(f.color, st);
  }
  const out = new Set<string>();
  for (const [c, st] of stat) if (st.polys >= 5 && st.on / st.n >= 0.6 && st.thin / st.polys >= 0.6) out.add(c);
  return out;
}

export function detectPlans(pages: PageMm[], warnings: string[]): PlanData[] {
  const plans: PlanData[] = [];
  for (const page of pages) {
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
      ((globalThis as any).__DBG_CLUSTERS ??= []).push(...groups.map((g) => ({ page: page.pageIndex, walls: g })));
      const lens = ww.map((w) => w.t1 - w.t0);
      console.log('walls', ww.length, 'len<300', lens.filter((l) => l < 300).length, '<1000', lens.filter((l) => l >= 300 && l < 1000).length, '>=1000', lens.filter((l) => l >= 1000).length, 'd', ww.slice(0, 12).map((w) => Math.round(w.d)).join('/'));
    }
    const wallColors = wallFillColors(page.colorFills, ww);
    if (!groups.length && !page.rasterMask) warnings.push(`${page.pageIndex + 1}ページ目: 平面図の壁を検出できませんでした`);
    // 平面図でないもの（立面図・図面枠・表・カタログ）を除く
    const isRoomText = (t: MmText) => classifyRoomName(t.str) != null || parseAreaLabel(t.str) != null;
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
      const margin = 400;
      const inBox = (x: number, y: number, m: number) => x > bbox.minX - m && x < bbox.maxX + m && y > bbox.minY - m && y < bbox.maxY + m;
      const texts = page.texts.filter((t) => inBox(t.x, t.y, margin));
      const segs = page.segs.filter((s) => inBox((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, margin));
      const siteTexts = page.texts.filter((t) => inBox(t.x, t.y, 30000));
      const siteSegs = page.segs.filter((s) => inBox(s.a.x, s.a.y, 30000) || inBox(s.b.x, s.b.y, 30000));
      const wallPolys = page.colorFills
        .filter((f) => f.poly.every((q) => inBox(q.x, q.y, margin)) && (wallColors.has(f.color) || isStripFill(f.poly)))
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

/**
 * 「1階平面図」などの見出しを図面に1対1で割り当てる。
 * 見出しは図面の真下（または真上）に置かれることが多いので、横方向のずれを重く評価する。
 */
function assignFloorTitles(plans: PlanData[], pages: PageMm[]) {
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
      for (const p of onPage) {
        const b = p.bbox;
        const dx = Math.max(0, b.minX - t.x, t.x - b.maxX);
        const dy = Math.max(0, b.minY - t.y, t.y - b.maxY);
        const h = b.maxY - b.minY;
        const w = b.maxX - b.minX;
        if (onPage.length > 1 && (dy > h * 0.9 || dx > w * 0.6)) continue;
        cands.push({ plan: p, title: t, floor: f, score: dx * 3 + dy });
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

/** 上階の図面を下階に位置合わせするための平行移動量（壁の重なり・階段位置・外形の包含で評価） */
export function alignOffset(base: PlanData, other: PlanData): Vec2 {
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
  for (const a of sa)
    for (const b of sb) {
      dxs.add(Math.round((a.minX + a.maxX) / 2 - (b.minX + b.maxX) / 2));
      dys.add(Math.round((a.minY + a.maxY) / 2 - (b.minY + b.maxY) / 2));
    }
  const areaB = (other.bbox.maxX - other.bbox.minX) * (other.bbox.maxY - other.bbox.minY);
  let best = { x: 0, y: 0 };
  let bestScore = -Infinity;
  for (const dx of dxs)
    for (const dy of dys) {
      let score = overlapScore(AV, BV, dx, dy) + overlapScore(AH, BH, dy, dx);
      // 階段が重なる
      for (const a of sa)
        for (const b of sb) {
          const ix = Math.max(0, Math.min(a.maxX, b.maxX + dx) - Math.max(a.minX, b.minX + dx));
          const iy = Math.max(0, Math.min(a.maxY, b.maxY + dy) - Math.max(a.minY, b.minY + dy));
          const inter = ix * iy;
          const ar = (a.maxX - a.minX) * (a.maxY - a.minY);
          if (ar > 0) score += 20000 * (inter / ar);
        }
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
  type Ax = { wall: Wall; horiz: boolean; oldAxis: number; newAxis: number };
  const axes: Ax[] = [];
  for (const w of f.walls) {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (L < 1) continue;
    const horiz = Math.abs(w.b.y - w.a.y) < L * 0.02;
    const vert = Math.abs(w.b.x - w.a.x) < L * 0.02;
    if (!horiz && !vert) continue;
    const oldAxis = horiz ? (w.a.y + w.b.y) / 2 : (w.a.x + w.b.x) / 2;
    const sn = snapCoord(oldAxis, horiz ? m.phaseY : m.phaseX, m.grid);
    axes.push({ wall: w, horiz, oldAxis, newAxis: Math.abs(sn - oldAxis) <= tol ? sn : oldAxis });
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
      if (vertEdge(prev) || vertEdge(next)) x = follow(p.x, false, 160) ?? gridOr(p.x, m.phaseX);
      if (horizEdge(prev) || horizEdge(next)) y = follow(p.y, true, 160) ?? gridOr(p.y, m.phaseY);
      out.push({ x, y });
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
function cleanPolygon(out: Vec2[], fallback: Vec2[]): Vec2[] {
  const dedup: Vec2[] = [];
  for (const p of out) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.x - p.x) < 1 && Math.abs(last.y - p.y) < 1) continue;
    dedup.push(p);
  }
  while (dedup.length > 1 && Math.abs(dedup[0].x - dedup[dedup.length - 1].x) < 1 && Math.abs(dedup[0].y - dedup[dedup.length - 1].y) < 1) dedup.pop();
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
function rejoinFloorWalls(f: Floor) {
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
    const oldA = swapped ? w.b : w.a;
    const oldL = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const na = swapped ? ax.b : ax.a;
    const nb = swapped ? ax.a : ax.b;
    const newL = Math.hypot(nb.x - na.x, nb.y - na.y);
    // a 側（元の向きでの a）がどれだけ手前へ伸びたか
    const ext0 = swapped ? Math.hypot(ax.b.x - oldA.x, ax.b.y - oldA.y) : Math.hypot(ax.a.x - oldA.x, ax.a.y - oldA.y);
    for (const op of f.openings) {
      if (op.wallId !== w.id) continue;
      const wd = op.t1 - op.t0;
      op.t0 = Math.max(0, Math.min(newL - wd, op.t0 + ext0));
      op.t1 = Math.min(newL, op.t0 + wd);
    }
    void oldL;
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

export function assembleModel(pages: PageMm[], name: string, warnings: string[], opts: AssembleOptions = {}): Omit<BuildingModel, 'report'> & { thicknesses: number[]; northDetected: boolean } {
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
  const ordered = plans.slice().sort((a, b) => {
    const fa = a.floorHint ?? 99;
    const fb = b.floorHint ?? 99;
    if (fa !== fb) return fa - fb;
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    return a.bbox.minX - b.bbox.minX;
  });
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
    for (const p of sorted.slice(1)) translatePlan(p, alignOffset(base, p));
    // 原点を1階の左上へ
    const o = { x: -base.bbox.minX, y: -base.bbox.minY };
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
  for (const p of sorted) {
    const f = buildFloor(p, levelOf.get(p)!, north, warnings, areaTable[levelOf.get(p)!]);
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
      const nf = buildFloor(p, f1.level, north, warnings, areaTable[f1.level], { courtyards: pts });
      nf.elevation = f1.elevation;
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
  // 原点を1階外壁芯の左上に揃える
  const o1 = floors[0]?.outline.flat() ?? [];
  if (o1.length) {
    const dx = -Math.min(...o1.map((p) => p.x));
    const dy = -Math.min(...o1.map((p) => p.y));
    for (const f of floors) translateFloor(f, dx, dy);
    if (site) translateSite(site, dx, dy);
    if (moduleInfo) translateModule(moduleInfo, dx, dy);
  }
  return { name, floors, northAngleDeg: north, site: site ?? undefined, module: moduleInfo, thicknesses: [...thicknesses].sort((a, b) => a - b), northDetected: northDeg != null };
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
  /** 用途を手で指定した場合（同じ名前の部屋に引き継ぐ） */
  type?: RoomType;
}

/**
 * 手で修正した壁・開口・部屋名から、その階の部屋・外壁・開口を作り直す。
 * 図面の読み取りと同じ処理（壁で囲まれた範囲を部屋にする）を、修正後の壁で実行する。
 */
export function rebuildFloor(f: Floor, labels: RoomLabel[], northAngleDeg: number, warnings: string[] = [], keep?: { rooms: Room[]; removed: { a: Vec2; b: Vec2 }[] }): Floor {
  const groups: { u: Vec2 }[] = [];
  const groupOf = (u: Vec2) => {
    let gi = groups.findIndex((g) => Math.abs(g.u.x * u.y - g.u.y * u.x) < 0.02 && g.u.x * u.x + g.u.y * u.y > 0);
    if (gi < 0) {
      groups.push({ u });
      gi = groups.length - 1;
    }
    return gi;
  };
  const kindOf = (k: Opening['kind']): DetectedOpening['kind'] => (k === 'entrance' ? 'door' : k === 'open' ? 'open' : k);
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
  const nf = buildFloor(plan, f.level, northAngleDeg, warnings);
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
    const derivedWindow = op.kind === 'window';
    op.kind = src.kind;
    if (src.kind === 'window' && !derivedWindow) {
      op.sill = src.sill || 900;
      op.height = src.height || 1100;
      op.windowStyle = src.windowStyle;
    } else if (src.kind !== 'window') {
      op.sill = 0;
      op.height = src.kind === 'entrance' ? Math.max(2200, src.height) : src.height || 2000;
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
    r.labelPos = { x: l.x, y: l.y };
  }
  // 図面から読んだ家具は、部屋が描き直されても同じ位置にあるものとして部屋を引き直す
  const planItems = f.planItems?.map((it) => ({ ...it, roomId: nf.rooms.find((r) => pointInPolygon({ x: it.x, y: it.y }, r.polygon))?.id ?? it.roomId }));
  const notes = f.notes?.map((n) => ({ ...n, roomId: nf.rooms.find((r) => pointInPolygon({ x: n.x, y: n.y }, r.polygon))?.id ?? n.roomId }));
  return { ...nf, elevation: f.elevation, height: f.height, ceilingHeight: f.ceilingHeight, stairs: f.stairs, planItems, exterior: f.exterior, notes };
}
