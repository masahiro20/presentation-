/**
 * 解析結果（壁片・開口・文字）から建物モデルを組み立てる
 */
import type { BuildingModel, Floor, Opening, Room, RoomType, Stair, Vec2, Wall, WindowStyle } from '../core/types';
import { bboxGap, bboxOf, distPointSegment, pointInPolygon, polygonArea, type BBox } from '../core/geometry';
import type { PageVectors } from './pdfExtract';
import { detectWalls, heavyWidthThreshold, type Arc, type DetectedOpening, type Seg, type WallDetection } from './walls';
import { rasterizeSegments, dominantAngles, detectWallsRaster, detectWallsRasterAuto, type BinaryImage } from './rasterWalls';
import { Grid, WALL, OUTSIDE, FREE, dilateMask, erodeMask, traceMask } from './raster';
import { classifyRoomName, parseAreaLabel, parseFloorTitle, parseStairMark, normalizeText } from './labels';
import { detectStairs } from './stairs';
import { detectSite, translateSite } from './site';

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
  return {
    pageIndex: p.pageIndex,
    segs: p.segments
      // 白い塗り（隠蔽用マスク）の輪郭は除外
      .filter((s) => !(s.source === 'fill' && /^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(s.color)))
      .map((s) => ({ a: sc(s.a), b: sc(s.b), width: s.width, dashed: s.dashed, source: s.source })),
    arcs: p.curves.filter((c) => !c.dashed).map((c) => ({ p0: sc(c.p0), p1: sc(c.p1), p2: sc(c.p2), p3: sc(c.p3) })),
    texts: p.texts.map((t) => ({ str: t.str, x: t.cx * k, y: t.cy * k, size: t.size * k, angle: t.angle })),
    fills: p.fills.map((f) => ({ polygon: f.polygon.map(sc) })),
    masks: p.fills.filter((f) => /^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(f.color) && f.polygon.length >= 4 && f.polygon.length <= 8).map((f) => f.polygon.map(sc)),
    colorFills: p.fills
      .filter((f) => f.polygon.length >= 3 && !/^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(f.color) && f.color.toLowerCase() !== '#000000')
      .map((f) => ({ poly: f.polygon.map(sc), color: f.color.toLowerCase() })),
    rasterMask: p.raster ? { data: p.raster.mask, w: p.raster.w, h: p.raster.h, res: k / p.raster.scale, ox: 0, oy: 0 } : undefined,
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
      if (widthMm >= 1600 && facingSouth) return { style: 'koshi', sill: 900, height: 1300 };
      return { style: 'koshi', sill: 900, height: 1100 };
    default:
      return { style: 'koshi', sill: 900, height: 1100 };
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
  if (/境界|道路|隣地|通り芯|芯|^GL|天井|床補強|予定|参考/.test(s)) return false;
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
    .map((o) => ({ x: o.t.x, y: o.t.y, nm: o.nm!, type: classifyRoomName(o.nm!)! }));
  if (names.length < 2) return false;
  let changed = false;
  for (let iter = 0; iter < 3; iter++) {
    const { labels } = grid.labelComponents();
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
      // 室名どうしを分ける線のうち、小さい側が 0.6㎡ 以上で最も短いもの
      let best: { cells: number[]; L: number } | null = null;
      const A = distinct[0];
      for (const B of distinct.slice(1)) {
        for (const sg of cands) {
          const cells = lineCells(grid, sg.a, sg.b);
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
          const L = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
          if (!best || L < best.L) best = { cells, L };
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
export function buildFloor(plan: PlanData, level: number, northAngleDeg: number, warnings: string[], expectedArea?: number): Floor {
  const walls = plan.walls;
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
      for (const [u, m] of contact) mergeTo.set(u, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
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
      const main = mainName(a.names)!;
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
    } else {
      name = '室';
      type = 'other';
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

  // ---- 外形 ----
  const building = new Uint8Array(grid.w * grid.h);
  for (let i = 0; i < building.length; i++) building[i] = grid.data[i] !== OUTSIDE && !courtLabels.has(labels[i]) ? 1 : 0;
  const extD = walls.length ? Math.max(...walls.map((w) => w.d)) : 150;
  const eroded = erodeMask(building, grid.w, grid.h, Math.max(1, Math.round(extD / 2 / res)));
  const outline = traceMask(eroded, grid, res * 1.5).filter((l) => Math.abs(polygonArea(l)) > 2e6);

  // ---- 外壁判定 ----
  const sideState = (p: Vec2) => {
    const [x, y] = grid.cellOf(p);
    return grid.get(x, y);
  };
  const outWalls: Wall[] = [];
  const openings: Opening[] = [];
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
    const exterior = outPlus + outMinus >= 2 && (outPlus === 0 || outMinus === 0);
    // Wall の a→b 方向に対する n の向き: perp(u) = (-u.y, u.x) = n
    const outsideSign: 1 | -1 | undefined = exterior ? (outPlus > outMinus ? 1 : -1) : undefined;
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
      const inSign = exterior ? -(outsideSign ?? 1) : 1;
      const inRoom = roomAt({ x: center.x + w.n.x * inSign * (w.d / 2 + 60), y: center.y + w.n.y * inSign * (w.d / 2 + 60) });
      const otherRoom = roomAt({ x: center.x - w.n.x * inSign * (w.d / 2 + 60), y: center.y - w.n.y * inSign * (w.d / 2 + 60) });
      const width = t1 - t0;
      let kind: Opening['kind'];
      let sill = 0;
      let height = 2000;
      let windowStyle: WindowStyle | undefined;
      if (exterior) {
        if (op.kind === 'door' || inRoom?.type === 'entrance' && op.kind !== 'window') {
          kind = 'entrance';
          height = 2200;
        } else {
          kind = 'window';
          const outN = { x: w.n.x * (outsideSign ?? 1), y: w.n.y * (outsideSign ?? 1) };
          const facingSouth = outN.x * southVec.x + outN.y * southVec.y > 0.7;
          const ws = windowStyleFor(inRoom?.type ?? null, width, facingSouth);
          sill = ws.sill;
          height = ws.height;
          windowStyle = ws.style;
        }
      } else {
        if (op.kind === 'door') kind = 'door';
        else if (op.kind === 'window') kind = 'sliding';
        else kind = 'open';
        height = 2000;
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
        swingSide: op.swingSign,
        confidence: op.confidence,
      });
    }
  });

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
    stairs.push({
      id: `F${level}-S${stairs.length + 1}`,
      minX: r.minX,
      minY: r.minY,
      maxX: r.maxX,
      maxY: r.maxY,
      kind,
      entry: sides[0].s,
      goesUp: !hasDn,
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
  };
}

/** 方位記号「N」の周囲の図形から真北方向を推定 */
function bezierMid(a: Arc): Vec2 {
  return { x: 0.125 * a.p0.x + 0.375 * a.p1.x + 0.375 * a.p2.x + 0.125 * a.p3.x, y: 0.125 * a.p0.y + 0.375 * a.p1.y + 0.375 * a.p2.y + 0.125 * a.p3.y };
}

function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  return {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  };
}

/**
 * 方位記号の図形から真北を求める（ARCHITREND などの「円＋星形＋北を指す長い線と片羽の矢」）。
 * 円の中心を通る長い線のうち、端に矢羽（短い線）が付いている側、または「真北」「N」の文字に近い側を北とする。
 */
export function detectCompass(p: PageMm): number | null {
  const segs = p.segs;
  // 円周候補の点（短い線分の端点・円弧の点）を格子に登録
  const cell = 300;
  const grid = new Map<string, Vec2[]>();
  const add = (q: Vec2) => {
    const k = `${Math.floor(q.x / cell)},${Math.floor(q.y / cell)}`;
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(q);
  };
  for (const sg of segs) if (Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y) < 400) add(sg.a), add(sg.b);
  for (const a of p.arcs) add(a.p0), add(a.p3), add(bezierMid(a));
  const around = (c: Vec2, r: number) => {
    const out: Vec2[] = [];
    for (let gx = Math.floor((c.x - r) / cell); gx <= Math.floor((c.x + r) / cell); gx++)
      for (let gy = Math.floor((c.y - r) / cell); gy <= Math.floor((c.y + r) / cell); gy++) for (const q of grid.get(`${gx},${gy}`) ?? []) out.push(q);
    return out;
  };
  const labels = p.texts.filter((t) => /^(真北|N|Ｎ|北|NORTH)$/i.test(t.str.trim()));
  let best: { deg: number; score: number } | null = null;
  for (const L of segs) {
    const len = Math.hypot(L.b.x - L.a.x, L.b.y - L.a.y);
    if (len < 1500 || len > 15000) continue;
    const C = { x: (L.a.x + L.b.x) / 2, y: (L.a.y + L.b.y) / 2 };
    const half = len / 2;
    const pts = around(C, half * 0.9).map((q) => ({ q, d: Math.hypot(q.x - C.x, q.y - C.y) })).filter((o) => o.d > half * 0.15 && o.d < half * 0.9);
    if (pts.length < 24) continue;
    // 半径のヒストグラムの山 = 円
    const bins = new Map<number, typeof pts>();
    for (const o of pts) {
      const k = Math.round(o.d / (half * 0.04));
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k)!.push(o);
    }
    let ring: typeof pts = [];
    for (const [k, v] of bins) {
      const all = v.concat(bins.get(k + 1) ?? []);
      if (all.length > ring.length) ring = all;
    }
    if (ring.length < 20) continue;
    const sectors = new Set(ring.map((o) => Math.floor(((Math.atan2(o.q.y - C.y, o.q.x - C.x) + Math.PI) / (Math.PI * 2)) * 8) % 8));
    if (sectors.size < 7) continue;
    const r = ring.reduce((s0, o) => s0 + o.d, 0) / ring.length;
    if (half < r * 1.4) continue;
    // 両端のどちらが北か
    const ends = [L.a, L.b];
    const ux = (L.b.x - L.a.x) / len;
    const uy = (L.b.y - L.a.y) / len;
    const endScore = ends.map((E) => {
      let sc = 0;
      for (const sg of segs) {
        if (sg === L) continue;
        const sl = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
        if (sl > r * 1.2) continue;
        const near = Math.min(Math.hypot(sg.a.x - E.x, sg.a.y - E.y), Math.hypot(sg.b.x - E.x, sg.b.y - E.y));
        if (near > r * 0.7) continue;
        const cos = Math.abs(((sg.b.x - sg.a.x) * ux + (sg.b.y - sg.a.y) * uy) / Math.max(1e-6, sl));
        if (cos < 0.97) sc += 1;
      }
      return sc;
    });
    // 家具（丸テーブルと椅子など）は端の周りに線が多い。方位記号の矢羽は数本
    if (Math.max(...endScore) > 6) continue;
    for (let k = 0; k < 2; k++) for (const t of labels) if (Math.hypot(t.x - ends[k].x, t.y - ends[k].y) < r * 2.5) endScore[k] += 5;
    if (endScore[0] === endScore[1]) continue;
    const E = endScore[0] > endScore[1] ? ends[0] : ends[1];
    const score = Math.max(...endScore) + ring.length / 10;
    const deg = Math.round((Math.atan2(E.x - C.x, -(E.y - C.y)) * 180) / Math.PI) || 0;
    if (!best || score > best.score) best = { deg, score };
  }
  return best ? best.deg : null;
}

export function detectNorth(pages: PageMm[]): number | null {
  for (const p of pages) {
    const c = detectCompass(p);
    if (c != null) return c;
  }
  for (const p of pages) {
    const ns = p.texts.filter((t) => /^(真北|N|Ｎ|北|NORTH)$/i.test(t.str.trim()));
    for (const t of ns) {
      const R = t.size * 5;
      const pts: Vec2[] = [];
      for (const s of p.segs) {
        for (const q of [s.a, s.b]) if (Math.hypot(q.x - t.x, q.y - t.y) < R) pts.push(q);
      }
      for (const a of p.arcs) for (const q of [a.p0, a.p3]) if (Math.hypot(q.x - t.x, q.y - t.y) < R) pts.push(q);
      for (const f of p.fills) for (const q of f.polygon) if (Math.hypot(q.x - t.x, q.y - t.y) < R) pts.push(q);
      if (pts.length < 3) continue;
      // 方位記号の円の中心（円弧の外接円）を優先し、無ければ図形の重心
      let cx = pts.reduce((s0, q) => s0 + q.x, 0) / pts.length;
      let cy = pts.reduce((s0, q) => s0 + q.y, 0) / pts.length;
      const centers: Vec2[] = [];
      for (const a of p.arcs) {
        if (Math.hypot(a.p0.x - t.x, a.p0.y - t.y) > R) continue;
        const c = circumcenter(a.p0, bezierMid(a), a.p3);
        if (c) centers.push(c);
      }
      if (centers.length >= 2) {
        cx = centers.reduce((s0, q) => s0 + q.x, 0) / centers.length;
        cy = centers.reduce((s0, q) => s0 + q.y, 0) / centers.length;
      }
      const vx = t.x - cx;
      const vy = t.y - cy;
      if (Math.hypot(vx, vy) < t.size * 0.5) continue;
      let deg = (Math.atan2(vx, -vy) * 180) / Math.PI;
      deg = Math.round(deg) || 0;
      return deg;
    }
  }
  return null;
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
    let ww = makeWalls(detectWalls(page.segs, page.arcs, {}, page.masks));
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
    if ((globalThis as any).__DBG_PLANS) ((globalThis as any).__DBG_CLUSTERS ??= []).push(...groups.map((g) => ({ page: page.pageIndex, walls: g })));
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
        .filter((c) => c.area >= 0.6 && c.area <= 80 && isRoomShaped(c.poly))
        .map((c) => ({ ...c, labels: labelTexts.filter((t) => pointInPolygon({ x: t.x, y: t.y }, c.poly)) }))
        .filter((c) => c.labels.length)
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
      plans.push({ pageIndex: page.pageIndex, bbox, floorHint: null, walls: g, texts, segs, siteTexts, siteSegs, wallPolys, sashPolys, roomFills, sketchLines, loose, scan });
    }
  }
  assignFloorTitles(plans, pages);
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
    q.wallPolys.push(...p.wallPolys);
    q.sashPolys.push(...p.sashPolys);
    q.roomFills.push(...p.roomFills);
    if (p.sketchLines) q.sketchLines = [...(q.sketchLines ?? []), ...p.sketchLines];
    if (p.loose) q.loose = true;
    q.bbox = { minX: Math.min(q.bbox.minX, p.bbox.minX), minY: Math.min(q.bbox.minY, p.bbox.minY), maxX: Math.max(q.bbox.maxX, p.bbox.maxX), maxY: Math.max(q.bbox.maxY, p.bbox.maxY) };
    plans.splice(plans.indexOf(p), 1);
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
  p.siteTexts = p.siteTexts.map((t) => ({ ...t, x: t.x + d.x, y: t.y + d.y }));
  p.siteSegs = p.siteSegs.map((s) => ({ ...s, a: tr(s.a), b: tr(s.b) }));
  p.wallPolys = p.wallPolys.map((poly) => poly.map(tr));
  p.sashPolys = p.sashPolys.map((poly) => poly.map(tr));
  p.roomFills = p.roomFills.map((poly) => poly.map(tr));
  if (p.sketchLines) p.sketchLines = p.sketchLines.map((sg) => ({ ...sg, a: tr(sg.a), b: tr(sg.b) }));
  p.bbox = { minX: p.bbox.minX + d.x, maxX: p.bbox.maxX + d.x, minY: p.bbox.minY + d.y, maxY: p.bbox.maxY + d.y };
}

export function assembleModel(pages: PageMm[], name: string, warnings: string[]): Omit<BuildingModel, 'report'> & { thicknesses: number[] } {
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
  const areaTable = readAreaTable(pages);
  const floors: Floor[] = [];
  const thicknesses = new Set<number>();
  let elev = 500;
  for (const p of sorted) {
    const f = buildFloor(p, levelOf.get(p)!, north, warnings, areaTable[levelOf.get(p)!]);
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
  // 接道・敷地（1階の図面の周囲から）
  const site = base ? detectSite(base.siteTexts, base.siteSegs, base.bbox, north) : null;
  // 原点を1階外壁芯の左上に揃える
  const o1 = floors[0]?.outline.flat() ?? [];
  if (o1.length) {
    const dx = -Math.min(...o1.map((p) => p.x));
    const dy = -Math.min(...o1.map((p) => p.y));
    for (const f of floors) translateFloor(f, dx, dy);
    if (site) translateSite(site, dx, dy);
  }
  return { name, floors, northAngleDeg: north, site: site ?? undefined, thicknesses: [...thicknesses].sort((a, b) => a - b) };
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
}

export { normalizeText };
