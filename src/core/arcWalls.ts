// R 壁（円弧の壁）を、なめらかな 1 本の曲面として扱うための整え直し。
//
// 図面の円弧の壁は、読み取りでは「向きが少しずつ回る短い壁」の集まりになる。しかも短い壁どうしが重なり合って並ぶので、
// そのまま 3D にすると、重なった箱と継ぎ目の丸柱が縦の帯（じゃばら）に見える。
// ここでは、その集まりを見つけて円を当てはめ、円の上に端と端がつながる短い弦（5〜10° 刻み）として並べ直す。
// 弦には arc（円の中心・半径）を付けておき、3D では弦ごとの平らな面ではなく、円の向きの法線でなめらかに描く。

import type { Floor, Opening, Vec2, Wall } from './types';

/** 弦 1 本の角度（rad）: 弦の長さ 180 mm を目安に、5〜10° の間で（面は法線でなめらかにつなぐので、輪郭が角ばらない細かさで足りる） */
const stepOf = (r: number) => Math.min((10 * Math.PI) / 180, Math.max((5 * Math.PI) / 180, 180 / r));

const len = (w: Wall) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);

/**
 * 円弧の弦として使える壁か: arc が付いていて、両端がその円の上にある（5 mm 以内）。
 * 弦を方眼で動かした・図面を回したあとは円から外れるので、ふつうの壁として扱う（次の整え直しで円を当てはめ直す）
 */
export function isArcChord(w: Wall): boolean {
  const c = w.arc;
  if (!c || !(c.r > 0)) return false;
  return Math.abs(Math.hypot(w.a.x - c.cx, w.a.y - c.cy) - c.r) < 5 && Math.abs(Math.hypot(w.b.x - c.cx, w.b.y - c.cy) - c.r) < 5;
}

function segDist(a: Wall, b: Wall): number {
  const pd = (p: Vec2, w: Wall) => {
    const dx = w.b.x - w.a.x;
    const dy = w.b.y - w.a.y;
    const L2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((p.x - w.a.x) * dx + (p.y - w.a.y) * dy) / L2));
    return Math.hypot(p.x - w.a.x - dx * u, p.y - w.a.y - dy * u);
  };
  return Math.min(pd(a.a, b), pd(a.b, b), pd(b.a, a), pd(b.b, a));
}

/** 2 本の線の向きの差（0〜90°） */
function lineAngle(a: Wall, b: Wall): number {
  const ta = Math.atan2(a.b.y - a.a.y, a.b.x - a.a.x);
  const tb = Math.atan2(b.b.y - b.a.y, b.b.x - b.a.x);
  let d = Math.abs(ta - tb) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return (d * 180) / Math.PI;
}

/** 点の集まりに円を当てはめる（最小二乗。Kåsa の方法） */
export function fitCircle(pts: Vec2[]): { cx: number; cy: number; r: number } | null {
  const n = pts.length;
  if (n < 3) return null;
  // 桁落ちを避けるため、重心を原点に
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;
  for (const p of pts) {
    const x = p.x - mx;
    const y = p.y - my;
    const z = x * x + y * y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-6) return null;
  const cx = (sxz * syy - syz * sxy) / (2 * det);
  const cy = (syz * sxx - sxz * sxy) / (2 * det);
  const r = Math.sqrt(cx * cx + cy * cy + sz / n);
  if (!Number.isFinite(r)) return null;
  return { cx: cx + mx, cy: cy + my, r };
}

export interface ArcCluster {
  walls: Wall[];
  cx: number;
  cy: number;
  r: number;
  /** 円弧の始まりと終わりの角度（rad。a0 < a1。弦は a0 → a1 の向きに並べる） */
  a0: number;
  a1: number;
}

/**
 * 円弧の壁になっている「短い壁の集まり」を探す。
 *  - 長さ 60〜520 の壁が、触れ合い（70 以内）ながら、向きを 1.5〜28° ずつ変えて 4 本以上つながる
 *  - 向きの変わる幅が 35° 以上、半径 350〜6,000、当てはめた円からのずれが小さい
 *  - 窓・戸の付いた壁、すでに円弧の弦になっている壁（isArcChord）は対象外
 */
export function findArcClusters(walls: Wall[], openings: Pick<Opening, 'wallId'>[] = []): ArcCluster[] {
  const withOp = new Set(openings.map((o) => o.wallId));
  const cand = walls.filter((w) => !isArcChord(w) && !withOp.has(w.id) && len(w) >= 60 && len(w) <= 520);
  const n = cand.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = lineAngle(cand[i], cand[j]);
      if (d < 1.5 || d > 28) continue;
      if (Math.abs(cand[i].thickness - cand[j].thickness) > 40) continue;
      if (segDist(cand[i], cand[j]) > 70) continue;
      adj[i].push(j);
      adj[j].push(i);
    }
  }
  const seen = new Uint8Array(n);
  const out: ArcCluster[] = [];
  for (let i = 0; i < n; i++) {
    if (seen[i] || !adj[i].length) continue;
    const comp: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      comp.push(j);
      for (const k of adj[j]) if (!seen[k]) { seen[k] = 1; stack.push(k); }
    }
    if (comp.length < 4) continue;
    // 円を当てはめ、円から外れる壁（円弧の端に付いた短い返し・小口の線など）を 1 本ずつ外しながら当てはめ直す
    let ws = comp.map((k) => cand[k]);
    let c: { cx: number; cy: number; r: number } | null = null;
    const ptsOf = (list: Wall[]) => list.flatMap((w) => [w.a, w.b, { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 }]);
    for (;;) {
      c = fitCircle(ptsOf(ws));
      if (!c) break;
      const cc = c;
      // 円からのずれ（弦の中点は矢高ぶん内側に入るので、その分は見込む）と、弦が円に沿っているか（半径の向きに立つ壁でないか）
      const tol = Math.max(45, cc.r * 0.05);
      const badness = (w: Wall) => {
        const dev = Math.max(...[w.a, w.b, { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 }].map((p) => Math.abs(Math.hypot(p.x - cc.cx, p.y - cc.cy) - cc.r)));
        const m = { x: (w.a.x + w.b.x) / 2 - cc.cx, y: (w.a.y + w.b.y) / 2 - cc.cy };
        const ml = Math.hypot(m.x, m.y) || 1;
        const radial = Math.abs((m.x / ml) * ((w.b.x - w.a.x) / len(w)) + (m.y / ml) * ((w.b.y - w.a.y) / len(w)));
        return Math.max(dev / tol, radial / 0.5);
      };
      const scored = ws.map((w) => ({ w, b: badness(w) })).sort((p, q) => q.b - p.b);
      if (scored[0].b <= 1) break;
      ws = ws.filter((w) => w !== scored[0].w);
      if (ws.length < 4) { c = null; break; }
    }
    if (!c || c.r < 350 || c.r > 6000) continue;
    const pts = ptsOf(ws);
    // 角度の範囲: 集まりの中ほどの向きを基準に、巻き戻しのない角度で見る
    const mid = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length - c.cx, y: pts.reduce((s, p) => s + p.y, 0) / pts.length - c.cy };
    const base = Math.atan2(mid.y, mid.x);
    const rel = (p: Vec2) => {
      const a = Math.atan2(p.y - c.cy, p.x - c.cx) - base;
      return Math.atan2(Math.sin(a), Math.cos(a));
    };
    const angs = ws.flatMap((w) => [rel(w.a), rel(w.b)]);
    const lo = Math.min(...angs);
    const hi = Math.max(...angs);
    if (hi - lo < (35 * Math.PI) / 180 || hi - lo > Math.PI * 1.9) continue;
    out.push({ walls: ws, cx: c.cx, cy: c.cy, r: c.r, a0: base + lo, a1: base + hi });
  }
  return out;
}

/**
 * 階の R 壁を、円の上の端と端がつながる弦に並べ直す（その場で書き換える）。戻り値は並べ直した円弧の数。
 * 何度呼んでも同じ結果（並べ直した弦には arc が付き、次からは対象外）。
 */
export function smoothArcWalls(f: Pick<Floor, 'walls' | 'openings'>): number {
  const clusters = findArcClusters(f.walls, f.openings);
  if (!clusters.length) return 0;
  for (const cl of clusters) {
    const drop = new Set(cl.walls.map((w) => w.id));
    const others = f.walls.filter((w) => !drop.has(w.id));
    const at = Math.min(...cl.walls.map((w) => f.walls.indexOf(w)));
    const span = cl.a1 - cl.a0;
    const n = Math.max(3, Math.ceil(span / stepOf(cl.r)));
    const P = (a: number): Vec2 => ({ x: cl.cx + cl.r * Math.cos(a), y: cl.cy + cl.r * Math.sin(a) });
    const ts = cl.walls.map((w) => w.thickness).sort((a, b) => a - b);
    const thickness = ts[Math.floor(ts.length / 2)];
    const exterior = cl.walls.filter((w) => w.exterior).length * 2 > cl.walls.length;
    // 外壁の外側が、円の外（凸の側）か内（凹の側）か
    let outer = 0;
    for (const w of cl.walls) {
      if (!w.exterior || !w.outsideSign) continue;
      const L = len(w) || 1;
      const nx = -(w.b.y - w.a.y) / L;
      const ny = (w.b.x - w.a.x) / L;
      const mx = (w.a.x + w.b.x) / 2 - cl.cx;
      const my = (w.a.y + w.b.y) / 2 - cl.cy;
      outer += w.outsideSign * Math.sign(nx * mx + ny * my);
    }
    // 天端の指定（腰壁の 1,100 など）は、半分以上の弦に付いている値
    const tops = cl.walls.map((w) => w.topMm).filter((v): v is number => v != null);
    const topCount = new Map<number, number>();
    for (const v of tops) topCount.set(v, (topCount.get(v) ?? 0) + 1);
    const topBest = [...topCount.entries()].sort((a, b) => b[1] - a[1])[0];
    const topMm = topBest && topBest[1] * 2 >= cl.walls.length ? topBest[0] : undefined;
    const accent = cl.walls.find((w) => w.accent !== undefined)?.accent;
    // 円弧の端が、ほかの壁につながっているか
    const joined = (p: Vec2) =>
      others.some((w) => {
        const dx = w.b.x - w.a.x;
        const dy = w.b.y - w.a.y;
        const L2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((p.x - w.a.x) * dx + (p.y - w.a.y) * dy) / L2));
        return Math.hypot(p.x - w.a.x - dx * u, p.y - w.a.y - dy * u) < w.thickness / 2 + thickness / 2 + 30;
      });
    const ids = cl.walls.map((w) => w.id);
    const made: Wall[] = [];
    for (let k = 0; k < n; k++) {
      const a = cl.a0 + (span * k) / n;
      const b = cl.a0 + (span * (k + 1)) / n;
      const w: Wall = {
        id: ids[k] ?? `${ids[0]}-r${k}`,
        a: P(a),
        b: P(b),
        thickness,
        exterior,
        joinedA: k > 0 || joined(P(a)),
        joinedB: k < n - 1 || joined(P(b)),
        arc: { cx: cl.cx, cy: cl.cy, r: cl.r, mid: (cl.a0 + cl.a1) / 2 },
      };
      // 弦は角度の増える向きに並ぶので、a→b の左（+1）は円の内側
      if (exterior) w.outsideSign = outer >= 0 ? -1 : 1;
      if (topMm != null) w.topMm = topMm;
      if (accent !== undefined) w.accent = accent;
      made.push(w);
    }
    const kept = f.walls.filter((w) => !drop.has(w.id));
    kept.splice(Math.min(at, kept.length), 0, ...made);
    f.walls.length = 0;
    f.walls.push(...kept);
  }
  return clusters.length;
}

/** 同じ円弧の弦どうしか（3D の継ぎ目の丸柱を立てない・法線をなめらかにつなぐ判定に使う） */
export function sameArc(a: Wall, b: Wall): boolean {
  return isArcChord(a) && isArcChord(b) && Math.abs(a.arc!.cx - b.arc!.cx) < 1 && Math.abs(a.arc!.cy - b.arc!.cy) < 1 && Math.abs(a.arc!.r - b.arc!.r) < 1;
}

/** 保存してあった図面（弦に並べ直す前の読み取り）も 3D でなめらかに出すための、書き換えない版。R 壁が無ければ同じ物を返す */
export function withSmoothArcWalls<T extends Pick<Floor, 'walls' | 'openings'>>(f: T): T {
  if (!findArcClusters(f.walls, f.openings).length) return f;
  const copy = { ...f, walls: f.walls.map((w) => ({ ...w })) };
  smoothArcWalls(copy);
  return copy;
}
