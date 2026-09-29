/**
 * 解析結果（壁片・開口・文字）から建物モデルを組み立てる
 */
import type { BuildingModel, Floor, Opening, Room, RoomType, Stair, Vec2, Wall, WindowStyle } from '../core/types';
import { bboxGap, bboxOf, distPointSegment, polygonArea, type BBox } from '../core/geometry';
import type { PageVectors } from './pdfExtract';
import { detectWalls, type Arc, type DetectedOpening, type Seg, type WallDetection } from './walls';
import { Grid, WALL, OUTSIDE, FREE, dilateMask, erodeMask, traceMask } from './raster';
import { classifyRoomName, parseAreaLabel, parseFloorTitle, parseStairMark, normalizeText } from './labels';
import { detectStairs } from './stairs';

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
function clusterPlans(walls: WWall[]): WWall[][] {
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
  const comps = new Map<number, WWall[]>();
  walls.forEach((w, i) => {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(w);
  });
  const lenOf = (ws: WWall[]) => ws.reduce((s, w) => s + Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y), 0);
  let groups = [...comps.values()].filter((c) => lenOf(c) >= 2500);
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
        if (bboxGap(bb(groups[i]), bb(groups[j])) < 600) {
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

/** 1つの図面（階）から部屋・外形などを作る */
export function buildFloor(plan: PlanData, level: number, northAngleDeg: number, warnings: string[]): Floor {
  const walls = plan.walls;
  const res = 20;
  const grid = Grid.around(plan.bbox.minX, plan.bbox.minY, plan.bbox.maxX, plan.bbox.maxY, res, 1200);
  for (const w of walls) grid.fillThickSegment(w.a, w.b, w.d, WALL);
  grid.floodOutside();
  const { labels, sizes } = grid.labelComponents();

  // ---- 文字の割り当て ----
  interface RoomAcc {
    id: number;
    names: { str: string; type: RoomType; size: number; x: number; y: number }[];
    tatami?: number;
    stair?: 'up' | 'down';
    textPos?: Vec2;
  }
  const acc = new Map<number, RoomAcc>();
  const labelAt = (p: Vec2): number => {
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
    if (!acc.has(l)) acc.set(l, { id: l, names: [] });
    const a = acc.get(l)!;
    const area = parseAreaLabel(t.str);
    if (area?.tatami) a.tatami = area.tatami;
    else if (area?.m2) a.tatami = area.m2 / 1.62;
    const st = parseStairMark(t.str);
    if (st) a.stair = st;
    const type = classifyRoomName(t.str);
    if (type) a.names.push({ str: t.str, type, size: t.size, x: t.x, y: t.y });
  }

  // ---- 部屋ポリゴン ----
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
    if (a?.names.length) {
      // 最も大きい文字を室名に
      const main = a.names.slice().sort((p, q) => q.size - p.size)[0];
      const uniq = [...new Set(a.names.map((n) => n.str))];
      name = uniq.join('・');
      type = main.type;
      labelPos = { x: main.x, y: main.y };
      if (uniq.length > 1) {
        // 玄関+ホールのように複数の名前 → 大きい方の種別
        const types = a.names.map((n) => n.type);
        if (types.includes('ldk')) type = 'ldk';
        else if (types.includes('living')) type = 'living';
      }
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

  // ---- 外形 ----
  const building = new Uint8Array(grid.w * grid.h);
  for (let i = 0; i < building.length; i++) building[i] = grid.data[i] !== OUTSIDE ? 1 : 0;
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
  for (const c of detectStairs(nonWallSegs, plan.bbox)) {
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

export function detectNorth(pages: PageMm[]): number | null {
  for (const p of pages) {
    const ns = p.texts.filter((t) => /^(N|Ｎ|北|NORTH)$/i.test(t.str.trim()));
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

export function detectPlans(pages: PageMm[], warnings: string[]): PlanData[] {
  const plans: PlanData[] = [];
  for (const page of pages) {
    const det = detectWalls(page.segs, page.arcs);
    const ww = makeWalls(det);
    joinWalls(ww);
    const groups = clusterPlans(ww);
    if (!groups.length) warnings.push(`${page.pageIndex + 1}ページ目: 平面図の壁を検出できませんでした`);
    for (const g of groups) {
      const bbox = bboxOf(g.flatMap((w) => [w.a, w.b]));
      const margin = 400;
      const inBox = (x: number, y: number, m: number) => x > bbox.minX - m && x < bbox.maxX + m && y > bbox.minY - m && y < bbox.maxY + m;
      const texts = page.texts.filter((t) => inBox(t.x, t.y, margin));
      const segs = page.segs.filter((s) => inBox((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, margin));
      // 階の見出し
      let floorHint: number | null = null;
      let bestD = Infinity;
      for (const t of page.texts) {
        const f = parseFloorTitle(t.str);
        if (f == null) continue;
        const dx = Math.max(0, bbox.minX - t.x, t.x - bbox.maxX);
        const dy = Math.max(0, bbox.minY - t.y, t.y - bbox.maxY);
        const d = Math.hypot(dx, dy);
        if (d < bestD) {
          bestD = d;
          floorHint = f;
        }
      }
      const h = bbox.maxY - bbox.minY;
      if (bestD > h * 0.8 && groups.length > 1) floorHint = null;
      plans.push({ pageIndex: page.pageIndex, bbox, floorHint, walls: g, texts, segs });
    }
  }
  return plans;
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
  p.bbox = { minX: p.bbox.minX + d.x, maxX: p.bbox.maxX + d.x, minY: p.bbox.minY + d.y, maxY: p.bbox.maxY + d.y };
}

export function assembleModel(pages: PageMm[], name: string, warnings: string[]): Omit<BuildingModel, 'report'> & { thicknesses: number[] } {
  const plans = detectPlans(pages, warnings);
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
  const floors: Floor[] = [];
  const thicknesses = new Set<number>();
  let elev = 500;
  for (const p of sorted) {
    const f = buildFloor(p, levelOf.get(p)!, north, warnings);
    f.elevation = elev;
    elev += f.height;
    f.walls.forEach((w) => thicknesses.add(w.thickness));
    floors.push(f);
  }
  // 原点を1階外壁芯の左上に揃える
  const o1 = floors[0]?.outline.flat() ?? [];
  if (o1.length) {
    const dx = -Math.min(...o1.map((p) => p.x));
    const dy = -Math.min(...o1.map((p) => p.y));
    for (const f of floors) translateFloor(f, dx, dy);
  }
  return { name, floors, northAngleDeg: north, thicknesses: [...thicknesses].sort((a, b) => a - b) };
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
