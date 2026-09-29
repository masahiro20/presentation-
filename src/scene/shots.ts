/**
 * 見どころカメラの自動生成
 *  - 外観: 道路側の2点透視（縦線補正）、庭側、鳥瞰、夜景
 *  - 内観: 部屋ごとに、奥行き・窓の見え方・家具との干渉を評価して最適な視点を選ぶ
 */
import * as THREE from 'three';
import type { BuildingModel, Room } from '../core/types';
import { isHabitable, ROOM_TYPE_LABEL } from '../core/types';
import { largestInnerRect } from '../core/rects';
import type { BuildingMeta } from './building';
import type { SiteInfo } from './landscape';
import type { CameraView } from './viewer';
import type { Footprint } from './furniture';
import type { RoofInfo } from './roof';
import { MM } from './building';

export interface Shot {
  id: string;
  kind: 'exterior' | 'interior' | 'aerial';
  title: string;
  caption: string;
  view: CameraView;
  /** パース用の太陽（ワールド方向）。null なら実際の太陽位置 */
  sunDir: THREE.Vector3 | null;
  timeOfDay?: 'day' | 'evening' | 'night';
  roomId?: string;
  level?: number;
}

function sunForView(pos: THREE.Vector3, target: THREE.Vector3, sideSign = -1, elevDeg = 38): THREE.Vector3 {
  // カメラの左後方 40° から光が当たるように
  const d = new THREE.Vector3().subVectors(target, pos).setY(0).normalize();
  const back = d.clone().negate();
  const ang = (sideSign * 55 * Math.PI) / 180;
  const h = back.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), ang);
  const el = (elevDeg * Math.PI) / 180;
  return new THREE.Vector3(h.x * Math.cos(el), Math.sin(el), h.z * Math.cos(el)).normalize();
}

/** 建物の点群が収まる距離を探す（水平視線 + シフト前提） */
function fitDistance(pts: THREE.Vector3[], center: THREE.Vector3, dir: THREE.Vector3, eye: number, vfov: number, aspect: number, margin = 1.12): number {
  const tanV = Math.tan((vfov * Math.PI) / 360);
  const tanH = tanV * aspect;
  const fits = (dist: number) => {
    const cam = center.clone().addScaledVector(dir, -dist).setY(eye);
    const fwd = dir.clone().setY(0).normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      const r = p.clone().sub(cam);
      const z = r.dot(fwd);
      if (z < 0.5) return false;
      const x = r.dot(right) / z;
      const y = r.y / z;
      if (Math.abs(x) * margin > tanH) return false;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    // シフトで上下を合わせたときに収まるか
    return (maxY - minY) * margin <= 2 * tanV;
  };
  let lo = 2;
  let hi = 200;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (fits(m)) hi = m;
    else lo = m;
  }
  return hi;
}

export function exteriorShots(meta: BuildingMeta, site: SiteInfo, roof: RoofInfo, aspect = 16 / 9, northAngleDeg = 0): Shot[] {
  const b = meta.bbox;
  const topY = Math.max(roof.maxY, meta.topY) + 0.2;
  const pts: THREE.Vector3[] = [];
  for (const x of [b.min.x - 0.6, b.max.x + 0.6])
    for (const z of [b.min.z - 0.6, b.max.z + 0.6]) for (const y of [0, topY]) pts.push(new THREE.Vector3(x, y, z));
  const center = new THREE.Vector3((b.min.x + b.max.x) / 2, 0, (b.min.z + b.max.z) / 2);
  const road = site.roadDir.clone();
  const shots: Shot[] = [];
  const eye = 1.55;
  const vfov = 42;
  // 道路側から、玄関が見える向きに 35° 振る
  const ent = meta.entrance;
  const along = new THREE.Vector3(-road.z, 0, road.x);
  // 道路面と一緒に見せる側面は、南向き（日の当たる明るい面）を優先する
  const na = (northAngleDeg * Math.PI) / 180;
  const south = new THREE.Vector3(-Math.sin(na), 0, Math.cos(na));
  const southSide = Math.sign(along.dot(south));
  const entSide = Math.abs(along.dot(south)) > 0.3 ? southSide : ent ? Math.sign(ent.pos.clone().sub(center).dot(along)) || 1 : 1;
  const mk = (id: string, title: string, caption: string, fromDir: THREE.Vector3, tod: Shot['timeOfDay'] = 'day', sideSign = -1): Shot => {
    const dir = fromDir.clone().negate().normalize(); // カメラの視線方向
    const dist = fitDistance(pts, center, dir, eye, vfov, aspect);
    const pos = center.clone().addScaledVector(dir, -dist).setY(eye);
    const target = center.clone().setY(topY * 0.42);
    return { id, kind: 'exterior', title, caption, view: { pos, target, fov: vfov, architectural: true }, sunDir: sunForView(pos, target, sideSign), timeOfDay: tod };
  };
  const frontDir = road.clone().multiplyScalar(Math.cos(0.6)).addScaledVector(along, entSide * Math.sin(0.6)).normalize();
  shots.push(mk('ext-front', '外観パース（道路側）', '道路から見た正面の外観。玄関まわりのデザインと全体のバランスをご確認いただけます。', frontDir));
  const otherDir = road.clone().multiplyScalar(Math.cos(0.7)).addScaledVector(along, -entSide * Math.sin(0.7)).normalize();
  shots.push(mk('ext-front2', '外観パース（別アングル）', '反対側の角から見た外観。建物の奥行きと屋根の形がよくわかります。', otherDir, 'day', 1));
  // 庭側（道路の反対 or 最も窓の多い面）
  const gardenDir = road.clone().negate().multiplyScalar(Math.cos(0.45)).addScaledVector(along, Math.sin(0.45)).normalize();
  shots.push(mk('ext-garden', '外観パース（庭側）', '庭側からの外観。大きな窓からの明るさと、庭とのつながりをイメージしてください。', gardenDir));
  shots.push(mk('ext-evening', '夕景パース', '夕暮れどき、室内の灯りがともる外観。帰宅したくなる佇まいを演出します。', frontDir, 'evening'));
  shots.push(mk('ext-night', '夜景パース', '夜の外観。窓からこぼれる灯りが、暮らしのぬくもりを伝えます。', frontDir, 'night'));
  // 鳥瞰
  const aerialDir = frontDir.clone();
  const dist = fitDistance(pts, center, aerialDir.clone().negate(), eye, 45, aspect) * 0.95;
  const pos = center.clone().addScaledVector(aerialDir, dist * 0.85).setY(dist * 0.62);
  shots.push({
    id: 'aerial',
    kind: 'aerial',
    title: '鳥瞰パース',
    caption: '上空から見た建物と敷地。駐車スペースやアプローチ、庭の配置を一目でご確認いただけます。',
    view: { pos, target: center.clone().setY(1.5), fov: 45 },
    sunDir: sunForView(pos, center, -1, 45),
    timeOfDay: 'day',
  });
  return shots;
}

interface WinInfo {
  center: THREE.Vector3;
  width: number;
  weight: number;
}

export function interiorShots(model: BuildingModel, meta: BuildingMeta, occupancy: Map<string, Footprint[]>, aspect = 16 / 9): Shot[] {
  const shots: Shot[] = [];
  const priority = ['ldk', 'living', 'dining', 'kitchen', 'japanese', 'bedroom', 'kids', 'study', 'entrance', 'bath', 'washroom'];
  const rooms = meta.rooms
    .filter((r) => isHabitable(r.room.type) || r.room.type === 'entrance' || r.room.type === 'bath')
    .sort((a, b) => priority.indexOf(a.room.type) - priority.indexOf(b.room.type) || b.room.area - a.room.area);
  for (const ri of rooms) {
    const room = ri.room;
    const inner = largestInnerRect(room.polygon, 5);
    if (!inner) continue;
    const R = { minX: inner.minX * MM, maxX: inner.maxX * MM, minZ: inner.minY * MM, maxZ: inner.maxY * MM };
    const W = R.maxX - R.minX;
    const D = R.maxZ - R.minZ;
    if (W < 1.2 || D < 1.2) continue;
    const y0 = ri.floorY;
    const eyeH = room.type === 'japanese' ? 1.15 : room.type === 'bath' ? 1.3 : 1.35;
    const occ = occupancy.get(room.id) ?? [];
    const wins = windowsOf(model, ri.floor.level, room, y0);
    const cands: THREE.Vector3[] = [];
    const ins = Math.min(0.45, Math.min(W, D) * 0.2);
    for (const x of [R.minX + ins, (R.minX + R.maxX) / 2, R.maxX - ins])
      for (const z of [R.minZ + ins, (R.minZ + R.maxZ) / 2, R.maxZ - ins]) {
        if (x === (R.minX + R.maxX) / 2 && z === (R.minZ + R.maxZ) / 2) continue;
        cands.push(new THREE.Vector3(x, y0 + eyeH, z));
      }
    const center = new THREE.Vector3((R.minX + R.maxX) / 2, y0 + 1.1, (R.minZ + R.maxZ) / 2);
    let best: { score: number; pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
    const vfov = aspect > 1.4 ? 58 : 66;
    const halfH = Math.atan(Math.tan((vfov * Math.PI) / 360) * aspect);
    for (const pos of cands) {
      // 家具と干渉しない
      const blocked = occ.some((o) => o.maxY > eyeH - 0.25 && pos.x > o.minX - 0.25 && pos.x < o.maxX + 0.25 && pos.z > o.minZ - 0.25 && pos.z < o.maxZ + 0.25);
      if (blocked) continue;
      // 注視点: 部屋の反対側（中心を通る）
      const dir = center.clone().sub(pos).setY(0);
      const depth = Math.max(0.5, dir.length());
      dir.normalize();
      const far = pos.clone().addScaledVector(dir, depth * 2);
      const target = new THREE.Vector3(far.x, y0 + 1.15, far.z);
      // 窓の見え方
      let winScore = 0;
      for (const w of wins) {
        const v = w.center.clone().sub(pos).setY(0);
        const L = v.length();
        if (L < 0.3) continue;
        const ang = Math.acos(Math.max(-1, Math.min(1, v.normalize().dot(dir))));
        if (ang < halfH * 0.95) winScore += w.weight * (ang > halfH * 0.25 ? 1.2 : 0.8); // 正面逆光より側面が良い
      }
      // 視線上の障害物（近すぎる家具）
      let nearPenalty = 0;
      for (const o of occ) {
        if (o.maxY < eyeH - 0.3) continue;
        const c = new THREE.Vector3((o.minX + o.maxX) / 2, pos.y, (o.minZ + o.maxZ) / 2);
        const v = c.clone().sub(pos);
        const dist = v.length();
        if (dist < 1.4 && v.setY(0).normalize().dot(dir) > 0.7) nearPenalty += 3;
      }
      const cornerBonus = Math.abs(pos.x - center.x) > W * 0.2 && Math.abs(pos.z - center.z) > D * 0.2 ? 1.5 : 0;
      const score = depth * 1.5 + winScore + cornerBonus - nearPenalty;
      if (!best || score > best.score) best = { score, pos, target };
    }
    if (!best) {
      best = { score: 0, pos: new THREE.Vector3(R.minX + 0.3, y0 + eyeH, R.minZ + 0.3), target: center.clone() };
    }
    const label = room.name || ROOM_TYPE_LABEL[room.type];
    const tatami = room.labeledTatami ?? room.area / 1.62;
    const facing = wins.length ? `窓からたっぷりと光が入る` : '落ち着いた';
    const caption =
      room.type === 'ldk' || room.type === 'living'
        ? `${tatami.toFixed(1)}帖の${label}。${facing}家族が集まる空間です。`
        : room.type === 'japanese'
          ? `${tatami.toFixed(1)}帖の和室。来客時や子どもの遊び場、お昼寝にも使える多目的な空間です。`
          : room.type === 'bath'
            ? 'ゆったりとくつろげる浴室。'
            : room.type === 'entrance'
              ? '家族やお客様を迎える玄関。収納をしっかり確保しています。'
              : `${tatami.toFixed(1)}帖の${label}。${facing}空間です。`;
    shots.push({
      id: `int-${room.id}`,
      kind: 'interior',
      title: `内観パース（${label}）`,
      caption,
      view: { pos: best.pos, target: best.target, fov: vfov, architectural: true },
      sunDir: null,
      roomId: room.id,
      level: ri.floor.level,
    });
  }
  return shots;
}

function windowsOf(model: BuildingModel, level: number, room: Room, y0: number): WinInfo[] {
  const f = model.floors.find((f) => f.level === level)!;
  const out: WinInfo[] = [];
  for (const o of f.openings) {
    if (o.kind !== 'window') continue;
    const w = f.walls.find((w) => w.id === o.wallId);
    if (!w) continue;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const t = (o.t0 + o.t1) / 2 / L;
    const cx = w.a.x + (w.b.x - w.a.x) * t;
    const cy = w.a.y + (w.b.y - w.a.y) * t;
    // 部屋の境界の近く
    const near = room.polygon.some((p, i) => {
      const q = room.polygon[(i + 1) % room.polygon.length];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const l2 = dx * dx + dy * dy || 1;
      const s = Math.max(0, Math.min(1, ((cx - p.x) * dx + (cy - p.y) * dy) / l2));
      return Math.hypot(p.x + dx * s - cx, p.y + dy * s - cy) < 250;
    });
    if (!near) continue;
    const width = (o.t1 - o.t0) * MM;
    out.push({ center: new THREE.Vector3(cx * MM, y0 + (o.sill + o.height / 2) * MM, cy * MM), width, weight: width * (o.height / 1000) });
  }
  return out;
}
