/**
 * 暮らしの動線: 部屋どうしのつながり（戸・開口の位置）から、毎日の動き（朝・帰宅・洗濯・買い物）の経路と長さを出す。
 *
 * 見る人（お客様）: 平面図の上の矢印と「約 6 m・9 歩」で、要望（寝室とトイレは近く・回遊）が体で分かる。
 * 使う人（設計士）: 動線の長さを数字で言える。ご要望との照合の「近さ」の根拠にもなる。
 *
 * 経路は部屋のつながりの最短（部屋の中心 → 戸 → 次の部屋の中心）。階をまたぐ動きは階段の部屋を経由する。
 */
import { pointInPolygon } from './geometry';
import { ROOM_TYPE_LABEL, type BuildingModel, type Floor, type Room, type RoomType, type Vec2 } from './types';

export interface RouteLeg {
  level: number;
  /** 図面座標 (mm) の折れ線 */
  points: Vec2[];
  rooms: string[];
}

export interface Route {
  id: string;
  title: string;
  /** お客様向けのひとこと */
  caption: string;
  from: Room;
  to: Room;
  legs: RouteLeg[];
  /** 長さ m（階段の上り下りは 1 階分 4 m として足す） */
  meters: number;
  steps: number;
  /** 通った部屋の名前（出発を含む） */
  via: string[];
}

interface Node {
  key: string;
  room: Room;
  floor: Floor;
  c: Vec2;
}
interface Edge {
  to: string;
  /** 通る戸の位置（図面 mm） */
  at: Vec2;
  cost: number;
  stairs?: boolean;
}

const centroid = (poly: Vec2[]): Vec2 => {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const w = p.x * q.y - q.x * p.y;
    a += w;
    cx += (p.x + q.x) * w;
    cy += (p.y + q.y) * w;
  }
  if (Math.abs(a) < 1) return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length };
  return { x: cx / (3 * a), y: cy / (3 * a) };
};
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const roomAt = (f: Floor, p: Vec2): Room | null => f.rooms.find((r) => pointInPolygon(p, r.polygon)) ?? null;

/** 部屋のつながり（同じ階は戸・開口で、階は階段の区画どうしで） */
export function roomGraph(model: BuildingModel): { nodes: Map<string, Node>; edges: Map<string, Edge[]> } {
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge[]>();
  const add = (a: string, b: string, at: Vec2, cost: number, stairs = false) => {
    (edges.get(a) ?? edges.set(a, []).get(a)!).push({ to: b, at, cost, stairs });
    (edges.get(b) ?? edges.set(b, []).get(b)!).push({ to: a, at, cost, stairs });
  };
  for (const f of model.floors) {
    for (const r of f.rooms) if (r.type !== 'void') nodes.set(`${f.level}:${r.id}`, { key: `${f.level}:${r.id}`, room: r, floor: f, c: centroid(r.polygon) });
    for (const o of f.openings) {
      if (o.kind === 'window') continue;
      const w = f.walls.find((q) => q.id === o.wallId);
      if (!w) continue;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      const t = (o.t0 + o.t1) / 2;
      const at = { x: w.a.x + ux * t, y: w.a.y + uy * t };
      const off = w.thickness / 2 + 250;
      const ra = roomAt(f, { x: at.x - uy * off, y: at.y + ux * off });
      const rb = roomAt(f, { x: at.x + uy * off, y: at.y - ux * off });
      if (!ra || !rb || ra === rb) continue;
      const ka = `${f.level}:${ra.id}`;
      const kb = `${f.level}:${rb.id}`;
      if (!nodes.has(ka) || !nodes.has(kb)) continue;
      add(ka, kb, at, dist(nodes.get(ka)!.c, at) + dist(at, nodes.get(kb)!.c));
    }
    // 壁の無い開き（LDK と階段ホールが一続きなど）: 隣接して辺を共有する部屋は、間に戸が無くても行き来できる扱いにする
    for (const a of f.rooms)
      for (const b of f.rooms) {
        if (a.id >= b.id || a.type === 'void' || b.type === 'void') continue;
        const ka = `${f.level}:${a.id}`;
        const kb = `${f.level}:${b.id}`;
        if (edges.get(ka)?.some((e) => e.to === kb)) continue;
        const shared = sharedEdge(a.polygon, b.polygon);
        if (!shared || shared.len < 600) continue;
        // 壁があるか: 共有辺の中点の上に壁があれば行き来できない
        const mid = { x: (shared.a.x + shared.b.x) / 2, y: (shared.a.y + shared.b.y) / 2 };
        const walled = f.walls.some((w) => distToSeg(mid, w.a, w.b) < 120);
        if (walled) continue;
        add(ka, kb, mid, dist(nodes.get(ka)!.c, mid) + dist(mid, nodes.get(kb)!.c));
      }
  }
  // 階段: 下の階の階段の区画と、上の階で同じ位置にある階段の区画をつなぐ
  for (let i = 0; i + 1 < model.floors.length; i++) {
    const lo = model.floors[i];
    const hi = model.floors[i + 1];
    const stairsLo = lo.rooms.filter((r) => r.type === 'stairs');
    const stairsHi = hi.rooms.filter((r) => r.type === 'stairs' || r.type === 'hall');
    for (const s of stairsLo) {
      const c = centroid(s.polygon);
      const up = stairsHi.filter((r) => pointInPolygon(c, r.polygon) || dist(centroid(r.polygon), c) < 2500).sort((p, q) => dist(centroid(p.polygon), c) - dist(centroid(q.polygon), c))[0];
      if (!up) continue;
      add(`${lo.level}:${s.id}`, `${hi.level}:${up.id}`, c, 4000, true);
    }
    // 階段の区画が無い図面: 階段の矩形の位置で代用
    if (!stairsLo.length)
      for (const st of lo.stairs) {
        const c = { x: (st.minX + st.maxX) / 2, y: (st.minY + st.maxY) / 2 };
        const a = roomAt(lo, c);
        const b = roomAt(hi, c) ?? hi.rooms.filter((r) => r.type === 'hall').sort((p, q) => dist(centroid(p.polygon), c) - dist(centroid(q.polygon), c))[0];
        if (a && b) add(`${lo.level}:${a.id}`, `${hi.level}:${b.id}`, c, 4000, true);
      }
  }
  return { nodes, edges };
}

function sharedEdge(a: Vec2[], b: Vec2[]): { a: Vec2; b: Vec2; len: number } | null {
  let best: { a: Vec2; b: Vec2; len: number } | null = null;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const r = b[j];
      const s = b[(j + 1) % b.length];
      // 同一直線上で重なる長さ
      const L = dist(p, q);
      if (L < 1) continue;
      const ux = (q.x - p.x) / L;
      const uy = (q.y - p.y) / L;
      const off = (v: Vec2) => Math.abs((v.x - p.x) * -uy + (v.y - p.y) * ux);
      if (off(r) > 60 || off(s) > 60) continue;
      const t0 = Math.max(0, Math.min((r.x - p.x) * ux + (r.y - p.y) * uy, (s.x - p.x) * ux + (s.y - p.y) * uy));
      const t1 = Math.min(L, Math.max((r.x - p.x) * ux + (r.y - p.y) * uy, (s.x - p.x) * ux + (s.y - p.y) * uy));
      if (t1 - t0 > (best?.len ?? 0)) best = { a: { x: p.x + ux * t0, y: p.y + uy * t0 }, b: { x: p.x + ux * t1, y: p.y + uy * t1 }, len: t1 - t0 };
    }
  }
  return best;
}

function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(p.x - a.x - dx * u, p.y - a.y - dy * u);
}

/** 最短経路（ダイクストラ）。戻り値は通った節点と戸の位置 */
function shortest(g: ReturnType<typeof roomGraph>, from: string, to: string): { keys: string[]; ats: (Vec2 | null)[]; cost: number } | null {
  const dist0 = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { k: string; at: Vec2 }>();
  const done = new Set<string>();
  while (true) {
    let cur: string | null = null;
    let best = Infinity;
    for (const [k, d] of dist0) if (!done.has(k) && d < best) {
      best = d;
      cur = k;
    }
    if (cur == null) break;
    if (cur === to) break;
    done.add(cur);
    for (const e of g.edges.get(cur) ?? []) {
      const nd = best + e.cost;
      if (nd < (dist0.get(e.to) ?? Infinity)) {
        dist0.set(e.to, nd);
        prev.set(e.to, { k: cur, at: e.at });
      }
    }
  }
  if (!dist0.has(to)) return null;
  const keys: string[] = [to];
  const ats: (Vec2 | null)[] = [null];
  let k = to;
  while (k !== from) {
    const p = prev.get(k)!;
    keys.unshift(p.k);
    ats.unshift(p.at);
    k = p.k;
  }
  return { keys, ats, cost: dist0.get(to)! };
}

type Cand = { key: string; room: Room; floor: Floor };
const candidates = (model: BuildingModel, types: RoomType[], re?: RegExp): Cand[] => {
  const c: Cand[] = [];
  for (const f of model.floors) for (const r of f.rooms) if (types.includes(r.type) || (re && re.test(r.name))) c.push({ key: `${f.level}:${r.id}`, room: r, floor: f });
  return c.sort((a, b) => b.room.area - a.room.area);
};

/** 毎日の動線（図面にある部屋だけ）。各立ち寄り先は、前の場所からいちばん近い部屋を選ぶ（2 階の寝室なら 2 階のトイレ） */
export function dailyRoutes(model: BuildingModel): Route[] {
  const g = roomGraph(model);
  const out: Route[] = [];
  const bed = candidates(model, ['bedroom']);
  const wc = candidates(model, ['toilet']);
  const wash = candidates(model, ['washroom']);
  const kit = candidates(model, ['kitchen', 'ldk', 'dining']);
  const ent = candidates(model, ['entrance']);
  const ldk = candidates(model, ['ldk', 'living']);
  const dry = candidates(model, ['balcony'], /ランドリー|物干|サンルーム|洗濯/);
  const pantry = candidates(model, [], /パントリー|pantry|土間収納|食品庫/i);
  const defs: { id: string; title: string; caption: string; stops: Cand[][] }[] = [
    { id: 'morning', title: '朝の動線', caption: '起きてから、トイレ・洗面を済ませてキッチンへ', stops: [bed, wc, wash, kit] },
    { id: 'home', title: '帰宅の動線', caption: '玄関から手を洗ってリビングへ', stops: [ent, wash, ldk] },
    { id: 'laundry', title: '洗濯の動線', caption: '洗面・脱衣から干す場所へ', stops: [wash, dry] },
    { id: 'shopping', title: '買い物の動線', caption: '玄関からキッチン・パントリーへ', stops: [ent, pantry.length ? pantry : kit] },
  ];
  for (const d of defs) {
    if (d.stops.some((c) => !c.length)) continue;
    // 出発は候補のいちばん広い部屋。以降は前の場所から最短のもの
    const picked: Cand[] = [d.stops[0][0]];
    const paths: NonNullable<ReturnType<typeof shortest>>[] = [];
    let ok = true;
    for (let i = 1; i < d.stops.length; i++) {
      let best: { c: Cand; sp: NonNullable<ReturnType<typeof shortest>> } | null = null;
      for (const c of d.stops[i]) {
        if (c.key === picked[picked.length - 1].key) {
          best = { c, sp: { keys: [c.key], ats: [null], cost: 0 } };
          break;
        }
        const sp = shortest(g, picked[picked.length - 1].key, c.key);
        if (sp && (!best || sp.cost < best.sp.cost)) best = { c, sp };
      }
      if (!best) {
        ok = false;
        break;
      }
      picked.push(best.c);
      paths.push(best.sp);
    }
    if (!ok) continue;
    const legs: RouteLeg[] = [];
    let meters = 0;
    const via: string[] = [picked[0].room.name || ROOM_TYPE_LABEL[picked[0].room.type]];
    for (const sp of paths) {
      if (sp.keys.length < 2) continue;
      let curLevel = g.nodes.get(sp.keys[0])!.floor.level;
      let pts: Vec2[] = [g.nodes.get(sp.keys[0])!.c];
      let rooms: string[] = [sp.keys[0]];
      const legStart = legs.length;
      for (let k = 1; k < sp.keys.length; k++) {
        const n = g.nodes.get(sp.keys[k])!;
        const at = sp.ats[k - 1]!;
        if (n.floor.level !== curLevel) {
          pts.push(at);
          legs.push({ level: curLevel, points: pts, rooms });
          curLevel = n.floor.level;
          pts = [at, n.c];
          rooms = [sp.keys[k]];
          meters += 4;
          continue;
        }
        pts.push(at, n.c);
        rooms.push(sp.keys[k]);
      }
      legs.push({ level: curLevel, points: pts, rooms });
      for (const leg of legs.slice(legStart)) for (let j = 1; j < leg.points.length; j++) meters += dist(leg.points[j - 1], leg.points[j]) / 1000;
      for (const k of sp.keys.slice(1)) {
        const nm = g.nodes.get(k)!.room.name || ROOM_TYPE_LABEL[g.nodes.get(k)!.room.type];
        if (via[via.length - 1] !== nm) via.push(nm);
      }
    }
    if (!legs.length) continue;
    out.push({ id: d.id, title: d.title, caption: d.caption, from: picked[0].room, to: picked[picked.length - 1].room, legs, meters: Math.round(meters * 10) / 10, steps: Math.max(1, Math.round(meters / 0.65)), via });
  }
  return out;
}

const ROUTE_COLORS: Record<string, string> = { morning: '#d9822b', home: '#2f7d4a', laundry: '#3b6fb6', shopping: '#8b5cf6' };
export const routeColor = (id: string) => ROUTE_COLORS[id] ?? '#444';

/** 平面図 SVG（floorPlanSvg の出力。座標は図面 mm）に動線の矢印を重ねる */
export function overlayRoutes(svg: string, level: number, routes: Route[]): string {
  const g: string[] = [];
  for (const r of routes) {
    const col = routeColor(r.id);
    for (const leg of r.legs) {
      if (leg.level !== level || leg.points.length < 2) continue;
      const d = leg.points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ');
      g.push(`<path d="${d}" fill="none" stroke="#fff" stroke-width="170" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>`);
      g.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="80" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="260 160" marker-end="url(#rt-${r.id})"/>`);
      const s = leg.points[0];
      g.push(`<circle cx="${s.x.toFixed(0)}" cy="${s.y.toFixed(0)}" r="150" fill="${col}" stroke="#fff" stroke-width="40"/>`);
    }
  }
  if (!g.length) return svg;
  const defs = routes.map((r) => `<marker id="rt-${r.id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${routeColor(r.id)}"/></marker>`).join('');
  return svg.replace(/<\/svg>\s*$/, `<defs>${defs}</defs><g class="routes">${g.join('')}</g></svg>`);
}
