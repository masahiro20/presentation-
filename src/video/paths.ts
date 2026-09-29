/**
 * 動画のカメラワーク
 *  - ウォークスルー: 道路 → アプローチ → 玄関 → 各部屋（ドア経由）→ 階段 → 2階
 *  - ドローン: 建物の周囲を旋回
 *  - 日照タイムラプス: 固定カメラで日の出から日没まで
 */
import * as THREE from 'three';
import type { BuildingModel, Floor, Room } from '../core/types';
import { isHabitable } from '../core/types';
import { pointInPolygon } from '../core/geometry';
import type { BuildingMeta } from '../scene/building';
import type { SiteInfo } from '../scene/landscape';
import type { Shot } from '../scene/shots';

export interface CamSample {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
  /** 0..1 黒へのフェード */
  fade: number;
  caption?: string;
  /** 日照タイムラプス用: 時刻 (h) */
  hour?: number;
}

export interface CameraProgram {
  duration: number;
  sample(t: number): CamSample;
  /** 字幕の区間 */
  captions: { t0: number; t1: number; text: string }[];
}

const MM = 0.001;

interface Link {
  a: string; // room id or 'outside'
  b: string;
  point: THREE.Vector3; // 開口中心（床レベル）
  normal: THREE.Vector3; // a → b 方向
  level: number;
}

function roomAtPoint(f: Floor, x: number, y: number): Room | null {
  for (const r of f.rooms) if (pointInPolygon({ x, y }, r.polygon)) return r;
  return null;
}

function buildLinks(model: BuildingModel): Link[] {
  const links: Link[] = [];
  for (const f of model.floors) {
    const fl = f.elevation * MM;
    for (const o of f.openings) {
      if (o.kind === 'window') continue;
      const w = f.walls.find((w) => w.id === o.wallId);
      if (!w) continue;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      const nx = -uy;
      const ny = ux;
      const t = (o.t0 + o.t1) / 2;
      const cx = w.a.x + ux * t;
      const cy = w.a.y + uy * t;
      const off = w.thickness / 2 + 250;
      const ra = roomAtPoint(f, cx + nx * off, cy + ny * off);
      const rb = roomAtPoint(f, cx - nx * off, cy - ny * off);
      const a = ra?.id ?? 'outside';
      const b = rb?.id ?? 'outside';
      if (a === b) continue;
      links.push({ a, b, point: new THREE.Vector3(cx * MM, fl, cy * MM), normal: new THREE.Vector3(-nx, 0, -ny), level: f.level });
    }
  }
  return links;
}

/** Catmull-Rom 曲線を弧長で等速に */
class Path {
  curve: THREE.CatmullRomCurve3;
  length: number;
  constructor(pts: THREE.Vector3[]) {
    const clean = pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 0.05);
    this.curve = new THREE.CatmullRomCurve3(clean.length >= 2 ? clean : [pts[0], pts[0].clone().add(new THREE.Vector3(0.01, 0, 0))], false, 'centripetal');
    this.length = this.curve.getLength();
  }
  at(u: number) {
    return this.curve.getPointAt(Math.max(0, Math.min(1, u)));
  }
}

interface Segment {
  kind: 'move' | 'hold' | 'cut';
  dur: number;
  path?: Path;
  /** hold: 視点を回す */
  pos?: THREE.Vector3;
  look0?: THREE.Vector3;
  look1?: THREE.Vector3;
  caption?: string;
}

function ease(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export function walkthroughProgram(model: BuildingModel, meta: BuildingMeta, site: SiteInfo, shots: Shot[]): CameraProgram {
  const links = buildLinks(model);
  const eye = 1.5;
  const speed = 1.05; // m/s
  const rooms = new Map(meta.rooms.map((r) => [r.room.id, r]));
  const segs: Segment[] = [];
  let cur: THREE.Vector3;
  const ent = meta.entrance;
  const entLink = links.find((l) => l.a === 'outside' || l.b === 'outside');
  // ---- 外から玄関へ ----
  const start = ent
    ? ent.pos.clone().addScaledVector(ent.outward, 9).setY(eye)
    : new THREE.Vector3(site.roadCenter.x, eye, site.roadCenter.z);
  cur = start;
  const route: THREE.Vector3[] = [start];
  if (ent) {
    const porch = ent.pos.clone().addScaledVector(ent.outward, 1.6).setY(ent.pos.y + eye);
    route.push(ent.pos.clone().addScaledVector(ent.outward, 4.5).setY(eye * 0.9 + ent.pos.y * 0.4), porch);
  }
  segs.push({ kind: 'hold', dur: 2.2, pos: start, look0: meta.bbox.getCenter(new THREE.Vector3()).setY(3.2), look1: (ent?.pos ?? meta.bbox.getCenter(new THREE.Vector3())).clone().setY(2.2), caption: 'ようこそ。まずは外観からご覧ください' });

  // ---- 部屋を巡回（深さ優先） ----
  const startRoom = entLink ? (entLink.a === 'outside' ? entLink.b : entLink.a) : meta.rooms.find((r) => r.room.type === 'entrance')?.room.id;
  const visited = new Set<string>();
  const order: { roomId: string; via: Link | null }[] = [];
  const priority = (id: string) => {
    const r = rooms.get(id)?.room;
    if (!r) return 99;
    const p = ['ldk', 'living', 'dining', 'kitchen', 'japanese', 'hall', 'stairs', 'bedroom', 'kids', 'study', 'entrance'];
    const i = p.indexOf(r.type);
    return i < 0 ? 50 : i;
  };
  const worth = (id: string) => {
    const r = rooms.get(id)?.room;
    return !!r && (isHabitable(r.type) || r.type === 'hall' || r.type === 'entrance' || r.type === 'stairs');
  };
  const dfs = (id: string, via: Link | null) => {
    visited.add(id);
    order.push({ roomId: id, via });
    const next = links
      .filter((l) => (l.a === id || l.b === id) && l.a !== 'outside' && l.b !== 'outside')
      .map((l) => ({ l, other: l.a === id ? l.b : l.a }))
      .filter((x) => !visited.has(x.other) && worth(x.other))
      .sort((x, y) => priority(x.other) - priority(y.other));
    for (const n of next) if (!visited.has(n.other)) {
      dfs(n.other, n.l);
      order.push({ roomId: id, via: null }); // 戻る
    }
  };
  if (startRoom) dfs(startRoom, entLink ?? null);

  // 階段で上の階へ（1階の巡回後）
  const upper = model.floors.slice(1);
  const stairs = model.floors[0]?.stairs.find((s) => s.goesUp);

  const viewPoint = (id: string) => {
    const shot = shots.find((s) => s.roomId === id);
    const ri = rooms.get(id)!;
    if (shot) return { pos: shot.view.pos.clone().setY(ri.floorY + eye), look: shot.view.target.clone().setY(ri.floorY + 1.2) };
    const c = ri.center.clone().setY(ri.floorY + eye);
    return { pos: c, look: c.clone().add(new THREE.Vector3(1, -0.2, 0)) };
  };

  const moveTo = (pts: THREE.Vector3[]) => {
    const path = new Path([cur, ...pts]);
    if (path.length < 0.1) return;
    segs.push({ kind: 'move', dur: Math.max(1.2, path.length / speed), path });
    cur = pts[pts.length - 1];
  };
  moveTo(route.slice(1));
  if (ent) {
    // 玄関ドアは閉じているので、暗転で室内へ
    segs.push({ kind: 'cut', dur: 0.9, caption: 'おじゃまします' });
    cur = ent.pos.clone().addScaledVector(ent.outward, -1.1).setY(ent.pos.y + eye);
    segs.push({ kind: 'hold', dur: 0.8, pos: cur.clone(), look0: cur.clone().addScaledVector(ent.outward, -3), look1: cur.clone().addScaledVector(ent.outward, -3) });
  }

  const shownRooms = new Set<string>();
  let lastRoom: string | null = null;
  for (let i = 0; i < order.length; i++) {
    const { roomId, via } = order[i];
    const ri = rooms.get(roomId);
    if (!ri) continue;
    const y = ri.floorY + eye;
    if (via && lastRoom) {
      // ドアの手前 → ドア → 部屋の中へ
      const d = via.normal.clone().multiplyScalar(via.a === lastRoom ? 1 : -1);
      const p0 = via.point.clone().addScaledVector(d, -0.6).setY(y);
      const p1 = via.point.clone().setY(y);
      const p2 = via.point.clone().addScaledVector(d, 0.8).setY(y);
      moveTo([p0, p1, p2]);
    }
    if (!shownRooms.has(roomId) && isHabitable(ri.room.type) && ri.room.area >= 5) {
      const vp = viewPoint(roomId);
      moveTo([vp.pos]);
      const lookDir = vp.look.clone().sub(vp.pos).setY(0).normalize();
      const l0 = vp.pos.clone().addScaledVector(lookDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.5), 4).setY(ri.floorY + 1.25);
      const l1 = vp.pos.clone().addScaledVector(lookDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.5), 4).setY(ri.floorY + 1.25);
      const tatami = (ri.room.labeledTatami ?? ri.room.area / 1.62).toFixed(1);
      segs.push({ kind: 'hold', dur: 3.2, pos: vp.pos, look0: l0, look1: l1, caption: `${ri.room.name}（${tatami}帖）` });
      shownRooms.add(roomId);
    } else if (!via) {
      // 戻り道: 部屋の中心を通る
      moveTo([ri.center.clone().setY(y)]);
    }
    lastRoom = roomId;
  }

  // ---- 2階へ ----
  if (stairs && upper.length) {
    const f2 = upper[0];
    const up2 = meta.rooms.filter((r) => r.floor === f2);
    const sc = new THREE.Vector3(((stairs.minX + stairs.maxX) / 2) * MM, 0, ((stairs.minY + stairs.maxY) / 2) * MM);
    const f1y = model.floors[0].elevation * MM + eye;
    moveTo([sc.clone().setY(f1y)]);
    segs.push({ kind: 'cut', dur: 0.8, caption: '2階へ' });
    const hallStart = up2.find((r) => r.room.type === 'hall' || r.room.type === 'stairs');
    cur = (hallStart ? hallStart.center.clone() : sc.clone()).setY(f2.elevation * MM + eye);
    const firstUp = up2.filter((r) => isHabitable(r.room.type) && r.room.area >= 5).sort((a, b) => b.room.area - a.room.area)[0];
    const lookFirst = firstUp ? firstUp.center.clone().setY(cur.y - 0.1) : cur.clone().add(new THREE.Vector3(0, -0.1, 2));
    segs.push({ kind: 'hold', dur: 0.6, pos: cur.clone(), look0: lookFirst, look1: lookFirst });
    const order2 = up2
      .filter((r) => isHabitable(r.room.type) && r.room.area >= 5)
      .sort((a, b) => (a.room.name.includes('主') ? -1 : 0) - (b.room.name.includes('主') ? -1 : 0) || b.room.area - a.room.area);
    const hall2 = up2.find((r) => r.room.type === 'hall' || r.room.type === 'stairs');
    for (const r of order2) {
      const link = links.find((l) => (l.a === r.room.id || l.b === r.room.id) && l.level === f2.level);
      const y = r.floorY + eye;
      if (hall2) moveTo([hall2.center.clone().setY(y)]);
      if (link) {
        const toRoom = link.normal.clone().multiplyScalar(link.b === r.room.id ? 1 : -1);
        moveTo([link.point.clone().addScaledVector(toRoom, -0.6).setY(y), link.point.clone().setY(y), link.point.clone().addScaledVector(toRoom, 0.8).setY(y)]);
      }
      const vp = viewPoint(r.room.id);
      moveTo([vp.pos]);
      const lookDir = vp.look.clone().sub(vp.pos).setY(0).normalize();
      const l0 = vp.pos.clone().addScaledVector(lookDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.45), 4).setY(r.floorY + 1.25);
      const l1 = vp.pos.clone().addScaledVector(lookDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.45), 4).setY(r.floorY + 1.25);
      segs.push({ kind: 'hold', dur: 2.8, pos: vp.pos, look0: l0, look1: l1, caption: `${r.room.name}（${(r.room.labeledTatami ?? r.room.area / 1.62).toFixed(1)}帖）` });
      // 部屋から出る
      if (link) {
        const toRoom = link.normal.clone().multiplyScalar(link.b === r.room.id ? 1 : -1);
        moveTo([link.point.clone().addScaledVector(toRoom, 0.8).setY(y), link.point.clone().setY(y), link.point.clone().addScaledVector(toRoom, -0.8).setY(y)]);
      }
    }
  }

  // ---- 時間割り当て ----
  let T = 0;
  const timed = segs.map((s) => {
    const t0 = T;
    T += s.dur;
    return { ...s, t0, t1: T };
  });
  const captions = timed.filter((s) => s.caption).map((s) => ({ t0: s.t0, t1: Math.max(s.t1, s.t0 + 2.5), text: s.caption! }));
  const lookAhead = (s: (typeof timed)[number], u: number) => {
    const p = s.path!.at(u);
    const L = Math.max(0.5, s.path!.length);
    // 1.5〜4m 先の点の平均方向（急な曲がり角で壁を向かないように）
    const dir = new THREE.Vector3();
    for (const d of [1.5, 2.5, 3.5, 4.5]) {
      const a = s.path!.at(Math.min(1, u + d / L)).sub(p);
      if (a.lengthSq() > 1e-4) dir.add(a.normalize());
    }
    if (dir.lengthSq() < 1e-6) {
      const back = s.path!.at(Math.max(0, u - 0.5 / L));
      dir.copy(p).sub(back);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    }
    dir.y *= 0.3;
    return p.clone().add(dir.normalize().multiplyScalar(3)).setY(p.y - 0.15);
  };
  let lastTarget = new THREE.Vector3();
  return {
    duration: T,
    captions,
    sample(t: number): CamSample {
      const s = timed.find((x) => t >= x.t0 && t < x.t1) ?? timed[timed.length - 1];
      const u = Math.max(0, Math.min(1, (t - s.t0) / s.dur));
      let pos: THREE.Vector3;
      let target: THREE.Vector3;
      let fade = 0;
      if (s.kind === 'move') {
        const e = u; // 等速
        pos = s.path!.at(e);
        target = lookAhead(s, e);
        // 前後の hold と視線をなめらかにつなぐ
        const idx = timed.indexOf(s);
        const prev = timed[idx - 1];
        const next = timed[idx + 1];
        if (prev?.kind === 'hold' && u < 0.25) target.lerp(prev.look1!, 1 - ease(u / 0.25));
        if (next?.kind === 'hold' && u > 0.75) target.lerp(next.look0!, ease((u - 0.75) / 0.25));
      } else if (s.kind === 'hold') {
        pos = s.pos!.clone();
        target = s.look0!.clone().lerp(s.look1!, ease(u));
      } else {
        pos = lastTarget.clone();
        const idx = timed.indexOf(s);
        const prev = timed[idx - 1];
        const next = timed[idx + 1];
        pos = u < 0.5 ? (prev?.path?.at(1) ?? prev?.pos ?? cur).clone() : (next?.path?.at(0) ?? next?.pos ?? cur).clone();
        target = u < 0.5 ? (prev?.kind === 'move' ? lookAhead(prev, 1) : prev?.look1 ?? pos) : next?.kind === 'move' ? lookAhead(next, 0) : next?.look0 ?? pos;
        fade = 1 - Math.abs(u - 0.5) * 2;
      }
      lastTarget = target;
      const cap = captions.find((c) => t >= c.t0 && t < c.t1);
      return { pos, target, fov: 62, fade, caption: cap?.text };
    },
  };
}

export function droneProgram(meta: BuildingMeta, duration = 14): CameraProgram {
  const c = meta.bbox.getCenter(new THREE.Vector3());
  const size = meta.bbox.getSize(new THREE.Vector3());
  const R = Math.max(size.x, size.z) * 1.35 + 6;
  const H = meta.topY * 1.6 + 3;
  return {
    duration,
    captions: [{ t0: 0.5, t1: 4, text: '外観 360°' }],
    sample(t: number) {
      const u = t / duration;
      const a = -Math.PI * 0.35 + u * Math.PI * 2 * 0.9;
      const r = R * (1.15 - 0.15 * Math.sin(u * Math.PI));
      const pos = new THREE.Vector3(c.x + Math.cos(a) * r, H * (0.8 + 0.4 * Math.sin(u * Math.PI)), c.z + Math.sin(a) * r);
      return { pos, target: c.clone().setY(meta.topY * 0.35), fov: 45, fade: Math.max(0, 1 - t / 0.6, 1 - (duration - t) / 0.6) };
    },
  };
}

export function sunTimelapseProgram(meta: BuildingMeta, fromH: number, toH: number, duration = 12, view?: { pos: THREE.Vector3; target: THREE.Vector3 }): CameraProgram {
  const c = meta.bbox.getCenter(new THREE.Vector3());
  const size = meta.bbox.getSize(new THREE.Vector3());
  const R = Math.max(size.x, size.z) * 1.6 + 8;
  const pos = view?.pos ?? new THREE.Vector3(c.x + R * 0.6, R * 1.1, c.z + R * 0.9);
  const target = view?.target ?? c.clone().setY(1);
  return {
    duration,
    captions: [],
    sample(t: number) {
      const u = t / duration;
      const hour = fromH + (toH - fromH) * u;
      const hh = Math.floor(hour);
      const mm = Math.floor((hour - hh) * 60);
      return { pos, target, fov: 45, fade: 0, hour, caption: `${hh}:${String(mm).padStart(2, '0')}` };
    },
  };
}
