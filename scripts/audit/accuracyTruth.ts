/**
 * 正解データとの比較（部門ごと）。scripts/audit/accuracy.ts から使う。
 * src/eval/accuracy.ts（修正画面の「評価用に保存」の採点）を、部門を分けて・階段を足して・位置合わせを入れて作り直したもの。
 */
import { pointInPolygon } from '../../src/core/geometry';
import { classifyRoomName } from '../../src/parser/labels';
import type { Vec2 } from '../../src/core/types';

export interface TruthFloor {
  level: number;
  walls: { a: Vec2; b: Vec2; thickness: number; exterior: boolean }[];
  openings: { kind: string; width: number; center: Vec2 | null }[];
  rooms: { name: string; type: string; area: number; polygon: Vec2[] }[];
  stairs?: { kind: string; goesUp: boolean; minX: number; minY: number; maxX: number; maxY: number }[];
}

export const wallCenter = (w: { a: Vec2; b: Vec2 }) => ({ x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 });
const dist2seg = (p: Vec2, a: Vec2, b: Vec2) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
};

/** 壁の長さを 10cm ごとに区切り、相手の壁の芯から tol 以内にある長さの割合と、その平均のずれ */
function wallCover(src: TruthFloor['walls'], dst: TruthFloor['walls'], tol = 150) {
  let covered = 0;
  let total = 0;
  let errSum = 0;
  for (const w of src) {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const n = Math.max(1, Math.round(L / 100));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const p = { x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t };
      total += L / n;
      let best = Infinity;
      for (const v of dst) best = Math.min(best, dist2seg(p, v.a, v.b));
      if (best <= tol) {
        covered += L / n;
        errSum += best * (L / n);
      }
    }
  }
  return { ratio: total ? covered / total : 1, meanErr: covered ? errSum / covered : 0 };
}

function iou(a: Vec2[], b: Vec2[], step = 100): number {
  const xs = [...a, ...b].map((p) => p.x);
  const ys = [...a, ...b].map((p) => p.y);
  let inter = 0;
  let ua = 0;
  for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step)
    for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) {
      const ia = pointInPolygon({ x, y }, a);
      const ib = pointInPolygon({ x, y }, b);
      if (ia && ib) inter++;
      if (ia || ib) ua++;
    }
  return ua ? inter / ua : 0;
}

const opClass = (k: string) => (k === 'window' ? 'window' : k === 'entrance' ? 'entrance' : k === 'sliding' ? 'sliding' : k === 'shutter' ? 'shutter' : k === 'open' ? 'open' : 'door');

function bbox(ws: TruthFloor['walls']) {
  const xs = ws.flatMap((w) => [w.a.x, w.b.x]);
  const ys = ws.flatMap((w) => [w.a.y, w.b.y]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function moved(f: TruthFloor, dx: number, dy: number): TruthFloor {
  const m = (p: Vec2) => ({ x: p.x + dx, y: p.y + dy });
  return {
    level: f.level,
    walls: f.walls.map((w) => ({ ...w, a: m(w.a), b: m(w.b) })),
    openings: f.openings.map((o) => ({ ...o, center: o.center ? m(o.center) : null })),
    rooms: f.rooms.map((r) => ({ ...r, polygon: r.polygon.map(m) })),
    stairs: (f.stairs ?? []).map((s) => ({ ...s, minX: s.minX + dx, maxX: s.maxX + dx, minY: s.minY + dy, maxY: s.maxY + dy })),
  };
}

export interface CategoryScore {
  level: number;
  /** 位置合わせで動かした量（mm）。大きいときは原点の取り方が違う */
  shift: { x: number; y: number };
  walls: { recall: number; precision: number; meanErrMm: number };
  rooms: { recall: number; precision: number; typeAccuracy: number; nameAccuracy: number; truth: number; auto: number };
  area: { truth: number; auto: number; errPct: number };
  openings: {
    truth: number;
    auto: number;
    recall: number;
    precision: number;
    kindAccuracy: number;
    byKind: Record<string, { truth: number; found: number; auto: number }>;
  };
  stairs: { truth: number; auto: number; kindMatch: number; iou: number };
}

export function scoreFloor(auto0: TruthFloor, truth: TruthFloor): CategoryScore {
  // 位置合わせ: 外周の壁の左上をそろえる（読み取りの原点は「1 階外壁芯の左上」、正解の原点は図面による）
  let auto = auto0;
  let shift = { x: 0, y: 0 };
  if (auto0.walls.length && truth.walls.length) {
    const A = bbox(auto0.walls.filter((w) => w.exterior).length ? auto0.walls.filter((w) => w.exterior) : auto0.walls);
    const T = bbox(truth.walls.filter((w) => w.exterior).length ? truth.walls.filter((w) => w.exterior) : truth.walls);
    // 外周の左上で大まかに合わせ、±300mm を 20mm 刻みで探して壁がいちばん重なる位置にする（壁芯か外面かの描き方の違いを吸収）
    const base = { x: T.minX - A.minX, y: T.minY - A.minY };
    let best = { ...base };
    let bestV = -1;
    for (let dx = -300; dx <= 300; dx += 20)
      for (let dy = -300; dy <= 300; dy += 20) {
        const v = wallCover(truth.walls, moved(auto0, base.x + dx, base.y + dy).walls, 60).ratio;
        if (v > bestV) {
          bestV = v;
          best = { x: base.x + dx, y: base.y + dy };
        }
      }
    shift = best;
    auto = moved(auto0, shift.x, shift.y);
  }
  const wr = wallCover(truth.walls, auto.walls);
  const wp = wallCover(auto.walls, truth.walls);
  // 部屋
  const matched = new Map<number, number>();
  const used = new Set<number>();
  truth.rooms.forEach((t, i) => {
    let best = -1;
    let bv = 0;
    auto.rooms.forEach((r, j) => {
      if (used.has(j)) return;
      const v = iou(t.polygon, r.polygon);
      if (v > bv) {
        bv = v;
        best = j;
      }
    });
    if (best >= 0 && bv >= 0.6) {
      matched.set(i, best);
      used.add(best);
    }
  });
  let typeOk = 0;
  let nameOk = 0;
  for (const [i, j] of matched) {
    const want = truth.rooms[i].type || classifyRoomName(truth.rooms[i].name) || 'other';
    if (want === auto.rooms[j].type) typeOk++;
    if (truth.rooms[i].name.replace(/\s/g, '') === auto.rooms[j].name.replace(/\s/g, '')) nameOk++;
  }
  const areaT = truth.rooms.reduce((s, r) => s + r.area, 0);
  const areaA = auto.rooms.reduce((s, r) => s + r.area, 0);
  // 建具（中心が 450mm 以内で 1 対 1 に対応）
  const byKind: CategoryScore['openings']['byKind'] = {};
  const usedOp = new Set<number>();
  let hit = 0;
  let kindOk = 0;
  for (const t of truth.openings) {
    const k = opClass(t.kind);
    byKind[k] ??= { truth: 0, found: 0, auto: 0 };
    byKind[k].truth++;
    if (!t.center) continue;
    let best = -1;
    let bd = 450;
    auto.openings.forEach((o, j) => {
      if (!o.center || usedOp.has(j)) return;
      const d = Math.hypot(o.center.x - t.center!.x, o.center.y - t.center!.y);
      if (d < bd) {
        bd = d;
        best = j;
      }
    });
    if (best < 0) continue;
    usedOp.add(best);
    hit++;
    if (opClass(auto.openings[best].kind) === k) {
      kindOk++;
      byKind[k].found++;
    }
  }
  for (const o of auto.openings) {
    const k = opClass(o.kind);
    byKind[k] ??= { truth: 0, found: 0, auto: 0 };
    byKind[k].auto++;
  }
  // 階段
  const ts = truth.stairs ?? [];
  const as = auto.stairs ?? [];
  let kindMatch = 0;
  let iouSum = 0;
  for (const t of ts) {
    let best: (typeof as)[number] | null = null;
    let bv = 0;
    for (const a of as) {
      if (a.goesUp !== t.goesUp) continue;
      const ix = Math.max(0, Math.min(a.maxX, t.maxX) - Math.max(a.minX, t.minX));
      const iy = Math.max(0, Math.min(a.maxY, t.maxY) - Math.max(a.minY, t.minY));
      const inter = ix * iy;
      const u = (a.maxX - a.minX) * (a.maxY - a.minY) + (t.maxX - t.minX) * (t.maxY - t.minY) - inter;
      const v = u > 0 ? inter / u : 0;
      if (v > bv) {
        bv = v;
        best = a;
      }
    }
    if (best) {
      iouSum += bv;
      if (best.kind === t.kind) kindMatch++;
    }
  }
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    level: truth.level,
    shift: { x: Math.round(shift.x), y: Math.round(shift.y) },
    walls: { recall: r2(wr.ratio), precision: r2(wp.ratio), meanErrMm: Math.round(wr.meanErr) },
    rooms: {
      recall: truth.rooms.length ? r2(matched.size / truth.rooms.length) : 1,
      precision: auto.rooms.length ? r2(used.size / auto.rooms.length) : 1,
      typeAccuracy: matched.size ? r2(typeOk / matched.size) : 1,
      nameAccuracy: matched.size ? r2(nameOk / matched.size) : 1,
      truth: truth.rooms.length,
      auto: auto.rooms.length,
    },
    area: { truth: r2(areaT), auto: r2(areaA), errPct: areaT ? Math.round((Math.abs(areaA - areaT) / areaT) * 1000) / 10 : 0 },
    openings: {
      truth: truth.openings.length,
      auto: auto.openings.length,
      recall: truth.openings.length ? r2(hit / truth.openings.length) : 1,
      precision: auto.openings.length ? r2(hit / auto.openings.length) : 1,
      kindAccuracy: hit ? r2(kindOk / hit) : 1,
      byKind,
    },
    stairs: { truth: ts.length, auto: as.length, kindMatch, iou: ts.length ? r2(iouSum / ts.length) : 1 },
  };
}
