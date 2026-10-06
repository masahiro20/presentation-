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
import { stairLayout, stairFrame, stairStepCount } from '../core/stairs';

export interface CamSample {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
  /** 0..1 黒へのフェード */
  fade: number;
  caption?: string;
  /** 日照タイムラプス用: 時刻 (h) */
  hour?: number;
  /** 扉の開き具合（開口 ID → 0〜1）。無い扉は閉。undefined = 通常表示 */
  doors?: Map<string, number>;
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
  openingId: string;
  /** 扉がある（開口（垂れ壁だけ）なら false） */
  hasDoor: boolean;
  kind: string;
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
      links.push({ a, b, point: new THREE.Vector3(cx * MM, fl, cy * MM), normal: new THREE.Vector3(-nx, 0, -ny), level: f.level, openingId: o.id, hasDoor: o.kind !== 'open', kind: o.kind });
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
  /** 点に最も近い位置のパラメータ */
  nearest(p: THREE.Vector3): number {
    let best = 0;
    let bd = Infinity;
    const N = 60;
    for (let i = 0; i <= N; i++) {
      const d = this.at(i / N).distanceToSquared(p);
      if (d < bd) {
        bd = d;
        best = i / N;
      }
    }
    return best;
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
  /** この区間で通る扉（パラメータ u で通過） */
  doors?: { id: string; u: number }[];
  /** hold 中に開けておく扉（覗き込み） */
  peek?: string;
  /** move: 視線の先読み距離（m）。階段では短く */
  lookDist?: number[];
  /** move: 視線の上下の係数（階段では上を向く） */
  lookPitch?: number;
}

function ease(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** 扉の開き具合の時間変化: 通過の 1.4 秒前から開き始め、0.35 秒前に全開。通過 1.0 秒後から閉じ 2.2 秒後に閉まる */
function doorProfile(dt: number): number {
  if (dt < -1.4 || dt > 2.2) return 0;
  if (dt < -0.35) return ease((dt + 1.4) / 1.05);
  if (dt <= 1.0) return 1;
  return 1 - ease((dt - 1.0) / 1.2);
}

export function walkthroughProgram(model: BuildingModel, meta: BuildingMeta, site: SiteInfo, shots: Shot[]): CameraProgram {
  const links = buildLinks(model);
  const eye = 1.5;
  const speed = 1.0; // m/s
  const rooms = new Map(meta.rooms.map((r) => [r.room.id, r]));
  const segs: Segment[] = [];
  let cur: THREE.Vector3;
  const ent = meta.entrance;
  const entLink = (ent && links.find((l) => l.openingId === ent.openingId)) ?? links.find((l) => (l.a === 'outside' || l.b === 'outside') && l.kind === 'entrance' && l.level === (ent?.level ?? l.level)) ?? links.find((l) => l.a === 'outside' || l.b === 'outside');

  const roomOf = (id: string) => rooms.get(id)?.room;
  const floorYOf = (id: string) => rooms.get(id)?.floorY ?? 0;
  /** 部屋グラフの最短経路（同じ階の扉・開口をたどる） */
  const shortestPath = (from: string, to: string): Link[] | null => {
    if (from === to) return [];
    const prev = new Map<string, { via: Link; from: string }>();
    const queue = [from];
    const seen = new Set([from]);
    while (queue.length) {
      const id = queue.shift()!;
      for (const l of links) {
        if (l.a === 'outside' || l.b === 'outside') continue;
        if (l.a !== id && l.b !== id) continue;
        const other = l.a === id ? l.b : l.a;
        if (seen.has(other)) continue;
        seen.add(other);
        prev.set(other, { via: l, from: id });
        if (other === to) {
          const out: Link[] = [];
          let c = to;
          while (c !== from) {
            const p = prev.get(c)!;
            out.unshift(p.via);
            c = p.from;
          }
          return out;
        }
        queue.push(other);
      }
    }
    return null;
  };

  const moveTo = (pts: THREE.Vector3[], doors: { id: string; point: THREE.Vector3 }[] = []) => {
    const path = new Path([cur, ...pts]);
    if (path.length < 0.1) return;
    const seg: Segment = { kind: 'move', dur: Math.max(1.0, path.length / speed), path };
    if (doors.length) seg.doors = doors.map((d) => ({ id: d.id, u: path.nearest(d.point) }));
    segs.push(seg);
    cur = pts[pts.length - 1];
  };

  /** 扉を通る 3 点（手前・扉・向こう） */
  const through = (l: Link, fromRoom: string, y: number) => {
    const d = l.normal.clone().multiplyScalar(l.a === fromRoom ? 1 : -1);
    return [l.point.clone().addScaledVector(d, -0.7).setY(y), l.point.clone().setY(y), l.point.clone().addScaledVector(d, 0.85).setY(y)];
  };

  const viewPoint = (id: string) => {
    const shot = shots.find((s) => s.roomId === id);
    const ri = rooms.get(id)!;
    if (shot) return { pos: shot.view.pos.clone().setY(ri.floorY + eye), look: shot.view.target.clone().setY(ri.floorY + 1.2) };
    const c = ri.center.clone().setY(ri.floorY + eye);
    return { pos: c, look: c.clone().add(new THREE.Vector3(1, -0.2, 0)) };
  };
  const shownRooms = new Set<string>();
  const showRoom = (id: string, dur = 3.2) => {
    const ri = rooms.get(id);
    if (!ri || shownRooms.has(id)) return;
    const vp = viewPoint(id);
    moveTo([vp.pos]);
    const lookDir = vp.look.clone().sub(vp.pos).setY(0).normalize();
    const l0 = vp.pos.clone().addScaledVector(lookDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.5), 4).setY(ri.floorY + 1.25);
    const l1 = vp.pos.clone().addScaledVector(lookDir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.5), 4).setY(ri.floorY + 1.25);
    const tatami = (ri.room.labeledTatami ?? ri.room.area / 1.62).toFixed(1);
    segs.push({ kind: 'hold', dur, pos: vp.pos, look0: l0, look1: l1, caption: `${ri.room.name}（${tatami}帖）` });
    shownRooms.add(id);
  };
  /** 扉の手前から覗き込む（浴室・小さな部屋） */
  const peekRoom = (l: Link, fromRoom: string, id: string) => {
    const ri = rooms.get(id);
    if (!ri || shownRooms.has(id)) return;
    const y = floorYOf(fromRoom) + eye;
    const d = l.normal.clone().multiplyScalar(l.a === fromRoom ? 1 : -1);
    const p0 = l.point.clone().addScaledVector(d, -0.9).setY(y);
    moveTo([p0]);
    const look = ri.center.clone().setY(ri.floorY + 1.1);
    segs.push({ kind: 'hold', dur: 2.2, pos: p0, look0: l.point.clone().setY(y - 0.1), look1: look, caption: `${ri.room.name}`, peek: l.hasDoor ? l.openingId : undefined });
    shownRooms.add(id);
  };
  /** 今いる部屋から目的の部屋まで扉をたどって歩く。戻り値: 到着できたか */
  let curRoom: string | null = null;
  const walkTo = (to: string): boolean => {
    if (!curRoom) return false;
    const path = shortestPath(curRoom, to);
    if (!path) return false;
    for (const l of path) {
      const from: string = curRoom!;
      const other: string = l.a === from ? l.b : l.a;
      const y = floorYOf(from) + eye;
      // 部屋の中心を経由して扉へ（壁沿いに斜めに突っ切らない）
      const ri = rooms.get(from);
      const pts = through(l, from, y);
      const doors = l.hasDoor ? [{ id: l.openingId, point: pts[1] }] : [];
      if (ri && cur.distanceTo(pts[0]) > 2.5) moveTo([ri.center.clone().setY(y)]);
      moveTo(pts, doors);
      curRoom = other;
    }
    return true;
  };

  // ---- 外から玄関へ ----
  const start = ent ? ent.pos.clone().addScaledVector(ent.outward, 9).setY(eye) : new THREE.Vector3(site.roadCenter.x, eye, site.roadCenter.z);
  cur = start;
  segs.push({ kind: 'hold', dur: 2.2, pos: start, look0: meta.bbox.getCenter(new THREE.Vector3()).setY(3.2), look1: (ent?.pos ?? meta.bbox.getCenter(new THREE.Vector3())).clone().setY(2.2), caption: 'ようこそ。まずは外観からご覧ください' });
  const f1 = model.floors[0];
  const f1y = (f1?.elevation ?? 0) * MM;
  if (ent && entLink) {
    const inside = entLink.a === 'outside' ? entLink.b : entLink.a;
    const porch = ent.pos.clone().addScaledVector(ent.outward, 1.5).setY(ent.pos.y + eye);
    moveTo([ent.pos.clone().addScaledVector(ent.outward, 4.5).setY(eye * 0.9 + ent.pos.y * 0.4), porch]);
    // 玄関ドアが開いて中へ
    const y = ent.pos.y + eye;
    moveTo([ent.pos.clone().setY(y), ent.pos.clone().addScaledVector(ent.outward, -1.0).setY(y)], [{ id: entLink.openingId, point: ent.pos.clone().setY(y) }]);
    segs.push({ kind: 'hold', dur: 1.2, pos: cur.clone(), look0: cur.clone().addScaledVector(ent.outward, -3).setY(y - 0.2), look1: cur.clone().addScaledVector(ent.outward, -3).setY(y - 0.2), caption: 'おじゃまします' });
    curRoom = inside;
  } else if (ent) {
    const porch = ent.pos.clone().addScaledVector(ent.outward, 1.6).setY(ent.pos.y + eye);
    moveTo([ent.pos.clone().addScaledVector(ent.outward, 4.5).setY(eye * 0.9 + ent.pos.y * 0.4), porch]);
    segs.push({ kind: 'cut', dur: 0.9, caption: 'おじゃまします' });
    cur = ent.pos.clone().addScaledVector(ent.outward, -1.1).setY(ent.pos.y + eye);
    const r = f1 && roomAtPoint(f1, cur.x / MM, cur.z / MM);
    curRoom = r?.id ?? meta.rooms.find((x) => x.room.type === 'entrance')?.room.id ?? null;
  } else {
    // 玄関が分からない図面: 玄関室か最初の部屋から
    const first = meta.rooms.find((x) => x.room.type === 'entrance') ?? meta.rooms.find((x) => x.room.type === 'hall') ?? meta.rooms.find((x) => isHabitable(x.room.type));
    segs.push({ kind: 'cut', dur: 0.9, caption: 'おじゃまします' });
    if (first) {
      cur = first.center.clone().setY(first.floorY + eye);
      curRoom = first.room.id;
    }
  }
  if (!curRoom) {
    const first = meta.rooms[0];
    if (first) {
      cur = first.center.clone().setY(first.floorY + eye);
      curRoom = first.room.id;
    }
  }

  // ---- 1 階: 玄関 → ホール → LDK → 和室 → 洗面・浴室 → 書斎・寝室 ----
  const tour = (level: number, order: string[], peekTypes: string[]) => {
    const here = meta.rooms.filter((r) => r.floor.level === level);
    const byType = (t: string) => here.filter((r) => r.room.type === t).sort((a, b) => b.room.area - a.room.area);
    for (const t of order) {
      for (const ri of byType(t)) {
        const id = ri.room.id;
        if (shownRooms.has(id) || !curRoom) continue;
        const small = ri.room.area < 4.5;
        if (peekTypes.includes(t) || (small && t !== 'entrance')) {
          // 隣の部屋まで行って扉から覗く
          const path = shortestPath(curRoom, id);
          if (!path || !path.length) continue;
          const last = path[path.length - 1];
          const before = path.length >= 2 ? (last.a === path[path.length - 2].a || last.a === path[path.length - 2].b ? last.a : last.b) : curRoom;
          if (before !== curRoom && !walkTo(before)) continue;
          peekRoom(last, before, id);
          continue;
        }
        if (!walkTo(id)) {
          // 扉がつながっていない（読み取りで開口が無い）部屋: 暗転してその部屋から再開
          segs.push({ kind: 'cut', dur: 0.8 });
          cur = ri.center.clone().setY(ri.floorY + eye);
          curRoom = id;
        }
        showRoom(id, t === 'ldk' || t === 'living' ? 3.6 : 3.0);
      }
    }
  };
  if (curRoom) {
    const startRi = rooms.get(curRoom);
    if (startRi && startRi.room.type === 'entrance') showRoom(curRoom, 2.0);
    tour(f1?.level ?? 1, ['hall', 'ldk', 'living', 'dining', 'kitchen', 'japanese', 'washroom', 'bath', 'study', 'bedroom', 'kids'], ['bath', 'toilet']);
  }

  // ---- 階段で 2 階へ ----
  const upper = model.floors.slice(1);
  const stair = f1?.stairs.find((s) => s.goesUp) ?? f1?.stairs[0];
  if (!stair && upper.length) {
    // 階段が読み取れていない図面: 暗転して 2 階から
    const f2 = upper[0];
    const start2 = meta.rooms.filter((r) => r.floor === f2).sort((a, b) => (a.room.type === 'hall' ? -1 : 0) - (b.room.type === 'hall' ? -1 : 0) || b.room.area - a.room.area)[0];
    if (start2) {
      segs.push({ kind: 'cut', dur: 0.9, caption: '2階へ' });
      cur = start2.center.clone().setY(start2.floorY + eye);
      curRoom = start2.room.id;
      if (start2.room.type !== 'hall') showRoom(curRoom, 2.6);
      tour(f2.level, ['hall', 'ldk', 'living', 'bedroom', 'kids', 'study', 'japanese', 'washroom', 'bath', 'storage'], ['bath', 'toilet', 'storage']);
    }
  }
  if (stair && upper.length && curRoom) {
    const f2 = upper[0];
    const f2y = f2.elevation * MM;
    const sc = { x: (stair.minX + stair.maxX) / 2, y: (stair.minY + stair.maxY) / 2 };
    const stairRoom = f1 ? roomAtPoint(f1, sc.x, sc.y) : null;
    // 階段のある部屋（階段室が独立していなければ、階段に一番近い扉のある部屋）
    let target = stairRoom?.id ?? null;
    if (!target || !shortestPath(curRoom, target)) {
      const cands = meta.rooms.filter((r) => r.floor === f1 && shortestPath(curRoom!, r.room.id)).sort((a, b) => a.center.distanceTo(new THREE.Vector3(sc.x * MM, 0, sc.y * MM)) - b.center.distanceTo(new THREE.Vector3(sc.x * MM, 0, sc.y * MM)));
      target = cands[0]?.room.id ?? null;
    }
    if (target && walkTo(target)) {
      const lay = stairLayout(stair, stairStepCount((f2.elevation - (f1?.elevation ?? 0)) || 2900, stair));
      const F = stairFrame(stair);
      const rise = f2y - f1y;
      const entryPt = new THREE.Vector3((F.o.x + F.r.x * (F.Lt / 2) - F.u.x * 700) * MM, f1y + eye, (F.o.y + F.r.y * (F.Lt / 2) - F.u.y * 700) * MM);
      moveTo([entryPt]);
      segs.push({ kind: 'hold', dur: 1.0, pos: entryPt, look0: entryPt.clone().add(new THREE.Vector3(F.u.x, 0, F.u.y).multiplyScalar(2.5)).setY(f1y + eye - 0.1), look1: entryPt.clone().add(new THREE.Vector3(F.u.x, 0.6, F.u.y).multiplyScalar(2.5)).setY(f1y + eye + 0.9), caption: '2階へ' });
      const climb: THREE.Vector3[] = [];
      for (const p of lay.pieces) {
        if (p.i % 2 && p.i !== lay.n) continue; // 2 段おきに点を打つ（なめらかに）
        climb.push(new THREE.Vector3(((p.minX + p.maxX) / 2) * MM, f1y + eye + (rise * p.i) / lay.n, ((p.minY + p.maxY) / 2) * MM));
      }
      const last = lay.pieces[lay.pieces.length - 1];
      const top = new THREE.Vector3(((last.minX + last.maxX) / 2 + last.dir.x * 900) * MM, f2y + eye, ((last.minY + last.maxY) / 2 + last.dir.y * 900) * MM);
      climb.push(top);
      moveTo(climb);
      const climbSeg = segs[segs.length - 1];
      if (climbSeg.kind === 'move') {
        climbSeg.lookDist = [0.9, 1.5, 2.1];
        climbSeg.lookPitch = 0.45;
        climbSeg.dur = Math.max(climbSeg.dur, (climbSeg.path?.length ?? 4) / 0.75);
      }
      // 2 階の最初の部屋 = 階段を上がった先の部屋（無ければ 2 階の階段室・ホール）
      const r2 = roomAtPoint(f2, top.x / MM, top.z / MM) ?? f2.rooms.find((r) => r.type === 'hall' || r.type === 'stairs') ?? f2.rooms[0];
      curRoom = r2?.id ?? null;
      if (curRoom) {
        const ri2 = rooms.get(curRoom);
        if (ri2 && ri2.room.type !== 'hall' && ri2.room.type !== 'stairs') showRoom(curRoom, 2.6);
        tour(f2.level, ['hall', 'ldk', 'living', 'bedroom', 'kids', 'study', 'japanese', 'washroom', 'bath', 'storage'], ['bath', 'toilet', 'storage']);
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
  // 扉の通過時刻
  const doorEvents: { id: string; t: number }[] = [];
  const peeks: { id: string; t0: number; t1: number }[] = [];
  for (const s of timed) {
    for (const d of s.doors ?? []) doorEvents.push({ id: d.id, t: s.t0 + d.u * s.dur });
    if (s.peek) peeks.push({ id: s.peek, t0: s.t0, t1: s.t1 });
  }
  const lookAhead = (s: (typeof timed)[number], u: number) => {
    const p = s.path!.at(u);
    const L = Math.max(0.5, s.path!.length);
    // 1.5〜4m 先の点の平均方向（急な曲がり角で壁を向かないように）
    const dir = new THREE.Vector3();
    for (const d of s.lookDist ?? [1.5, 2.5, 3.5, 4.5]) {
      const a = s.path!.at(Math.min(1, u + d / L)).sub(p);
      if (a.lengthSq() > 1e-4) dir.add(a.normalize());
    }
    if (dir.lengthSq() < 1e-6) {
      const back = s.path!.at(Math.max(0, u - 0.5 / L));
      dir.copy(p).sub(back);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    }
    dir.y *= s.lookPitch ?? 0.3;
    return p.clone().add(dir.normalize().multiplyScalar(3)).setY(p.y - 0.15 + (s.lookPitch ? 0.1 : 0));
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
      // 扉: 通過の前後だけ開く。覗き込みの間も開ける
      const doors = new Map<string, number>();
      for (const d of doorEvents) {
        const f = doorProfile(t - d.t);
        if (f > 0) doors.set(d.id, Math.max(doors.get(d.id) ?? 0, f));
      }
      for (const pk of peeks) {
        const f = t < pk.t0 - 1.0 ? 0 : t < pk.t0 ? ease((t - (pk.t0 - 1.0)) / 1.0) : t <= pk.t1 ? 1 : t < pk.t1 + 1.2 ? 1 - ease((t - pk.t1) / 1.2) : 0;
        if (f > 0) doors.set(pk.id, Math.max(doors.get(pk.id) ?? 0, f));
      }
      return { pos, target, fov: 62, fade, caption: cap?.text, doors };
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
