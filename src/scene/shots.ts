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

/** 外壁の窓（外向きの法線・面積）。外観パースで窓の多い面を選ぶのに使う */
export interface FacadeWindow {
  center: THREE.Vector3;
  normal: THREE.Vector3;
  area: number;
}

export function facadeWindows(model: BuildingModel): FacadeWindow[] {
  const out: FacadeWindow[] = [];
  for (const f of model.floors) {
    for (const op of f.openings) {
      if (op.kind !== 'window' && op.kind !== 'sliding' && op.kind !== 'entrance') continue;
      const w = f.walls.find((x) => x.id === op.wallId);
      if (!w || !w.exterior) continue;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      const t = (op.t0 + op.t1) / 2;
      const cx = w.a.x + ux * t;
      const cy = w.a.y + uy * t;
      // 外向き: 外形の内外で確かめる
      let sgn = w.outsideSign ?? 1;
      const probe = (sg: number) => f.outline.some((l) => {
        const q = { x: cx - uy * sg * (w.thickness / 2 + 300), y: cy + ux * sg * (w.thickness / 2 + 300) };
        let inside = false;
        for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
          if (l[i].y > q.y !== l[j].y > q.y && q.x < ((l[j].x - l[i].x) * (q.y - l[i].y)) / (l[j].y - l[i].y) + l[i].x) inside = !inside;
        }
        return inside;
      });
      const pin = probe(1);
      const min = probe(-1);
      if (pin !== min) sgn = pin ? -1 : 1;
      const area = ((op.t1 - op.t0) * Math.max(600, op.height)) / 1e6;
      out.push({ center: new THREE.Vector3(cx * MM, (f.elevation + op.sill + op.height / 2) * MM, cy * MM), normal: new THREE.Vector3(-uy * sgn, 0, ux * sgn), area: area * (op.kind === 'entrance' ? 1.5 : 1) });
    }
  }
  return out;
}

/** その方向（建物から見たカメラの方向）から見える窓の量 */
function facadeScore(wins: FacadeWindow[], fromDir: THREE.Vector3): number {
  let s = 0;
  for (const w of wins) {
    const c = w.normal.dot(fromDir);
    if (c > 0.15) s += w.area * c;
  }
  return s;
}

export function exteriorShots(meta: BuildingMeta, site: SiteInfo, roof: RoofInfo, aspect = 16 / 9, northAngleDeg = 0, wins: FacadeWindow[] = []): Shot[] {
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
  let frontDir = road.clone().multiplyScalar(Math.cos(0.6)).addScaledVector(along, entSide * Math.sin(0.6)).normalize();
  // 窓の情報があれば、道路側の半分の中で窓（＝表情）が最も多く見える角度を選ぶ（窓の無い壁ばかり写さない）
  let gardenPick: THREE.Vector3 | null = null;
  if (wins.length) {
    const cands: { dir: THREE.Vector3; score: number }[] = [];
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      // 正面だけ・側面だけの真横より、2面が見える斜めの角度を少し優先
      const diag = Math.abs(Math.sin(2 * a)) * 0.15 + 0.85;
      cands.push({ dir: d, score: facadeScore(wins, d) * diag });
    }
    const roadSide = cands.filter((c) => c.dir.dot(road) > 0.25).sort((a, b) => b.score - a.score);
    if (roadSide[0] && roadSide[0].score > 0) frontDir = roadSide[0].dir.clone();
    const rest = cands.filter((c) => c.dir.dot(frontDir) < 0.2).sort((a, b) => b.score - a.score);
    if (rest[0] && rest[0].score > 0) gardenPick = rest[0].dir.clone();
  }
  shots.push(mk('ext-front', '外観パース（道路側）', '道路から見た正面の外観。玄関まわりのデザインと全体のバランスをご確認いただけます。', frontDir));
  const otherDir = road.clone().multiplyScalar(Math.cos(0.7)).addScaledVector(along, -entSide * Math.sin(0.7)).normalize();
  shots.push(mk('ext-front2', '外観パース（別アングル）', '反対側の角から見た外観。建物の奥行きと屋根の形がよくわかります。', otherDir, 'day', 1));
  // 庭側（道路の反対 or 最も窓の多い面）
  const gardenDir = gardenPick ?? road.clone().negate().multiplyScalar(Math.cos(0.45)).addScaledVector(along, Math.sin(0.45)).normalize();
  shots.push(mk('ext-garden', '外観パース（庭側）', '庭側からの外観。大きな窓からの明るさと、庭とのつながりをイメージしてください。', gardenDir));
  shots.push(mk('ext-evening', '夕景パース', '夕暮れどき、室内の灯りがともる外観。帰宅したくなる佇まいを演出します。', frontDir, 'evening'));
  shots.push(mk('ext-night', '夜景パース', '夜の外観。窓からこぼれる灯りが、暮らしのぬくもりを伝えます。', frontDir, 'night'));
  // 鳥瞰
  const aerialDir = frontDir.clone();
  const dist = fitDistance(pts, center, aerialDir.clone().negate(), eye, 45, aspect) * 1.6;
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

/** 原点から方向へのレイの到達距離（障害物がなければ far） */
export type RayFn = (origin: THREE.Vector3, dir: THREE.Vector3, far: number) => number;

export function interiorShots(model: BuildingModel, meta: BuildingMeta, occupancy: Map<string, Footprint[]>, aspect = 16 / 9, ray?: RayFn): Shot[] {
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
    // 狭い部屋（収納・書斎コーナーなど）はパース向きでない
    if (room.area < 5 && room.type !== 'entrance') continue;
    const y0 = ri.floorY;
    const eyeH = room.type === 'japanese' ? 1.15 : room.type === 'bath' ? 1.3 : 1.35;
    const occ = occupancy.get(room.id) ?? [];
    const wins = windowsOf(model, ri.floor.level, room, y0);
    const center = new THREE.Vector3((R.minX + R.maxX) / 2, y0 + 1.1, (R.minZ + R.maxZ) / 2);
    let best: { score: number; pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
    const vfov = aspect > 1.4 ? 58 : 66;
    const halfH = Math.atan(Math.tan((vfov * Math.PI) / 360) * aspect);
    // 候補位置: 部屋内の格子点（家具・扉の近くは除外）
    const cands: THREE.Vector3[] = [];
    const step = Math.max(0.4, Math.min(W, D) / 6);
    const ins = Math.min(0.4, Math.min(W, D) * 0.18);
    for (let x = R.minX + ins; x <= R.maxX - ins + 1e-6; x += step)
      for (let z = R.minZ + ins; z <= R.maxZ - ins + 1e-6; z += step) {
        const pos = new THREE.Vector3(x, y0 + eyeH, z);
        if (occ.some((o) => o.maxY > 0.5 && x > o.minX - 0.3 && x < o.maxX + 0.3 && z > o.minZ - 0.3 && z < o.maxZ + 0.3)) continue;
        if (meta.doorLeaves.some((d) => Math.abs(d.a.y - y0) < 0.5 && distToSeg2(pos, d.a, d.b) < 0.7)) continue;
        cands.push(pos);
      }
    const diag = Math.hypot(W, D);
    for (const pos of cands) {
      for (let k = 0; k < 16; k++) {
        const yaw = (k / 16) * Math.PI * 2;
        const dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
        let score: number;
        if (ray) {
          // 視野内のレイで開放感・近接障害物・外の眺め（窓）を評価
          let sum = 0;
          let minC = Infinity;
          let outside = 0;
          let centerOut = false;
          const N = 13;
          for (let r = 0; r < N; r++) {
            const a = -halfH * 0.95 + (2 * halfH * 0.95 * r) / (N - 1);
            const d = dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
            for (const dy of [0, -0.45]) {
              const o = pos.clone();
              o.y += dy;
              const dist = ray(o, d, 9);
              sum += Math.min(dist, diag);
              if (Math.abs(a) < halfH * 0.45) minC = Math.min(minC, dist);
              if (dist > diag + 0.8 && dy === 0) outside++;
              if (dist > diag + 0.8 && dy === 0 && Math.abs(a) < halfH * 0.2) centerOut = true;
            }
          }
          const mean = sum / (N * 2);
          const cornerBonus = Math.min(Math.abs(pos.x - center.x) / (W / 2), 1) * Math.min(Math.abs(pos.z - center.z) / (D / 2), 1);
          // 窓は視野の端に入るのが良い（正面に窓だけが見える逆光の構図は避ける）
          score = mean * 1.4 + Math.min(outside, 3) * 0.3 + cornerBonus * 1.5 - (minC < 1.6 ? (1.6 - minC) * 6 : 0) - (centerOut ? 2.5 : 0);
          // 部屋の中心方向を向いているほど良い
          const toC = center.clone().sub(pos).setY(0);
          if (toC.lengthSq() > 0.01) score += toC.normalize().dot(dir) * 2.0;
        } else {
          const toC = center.clone().sub(pos).setY(0);
          score = toC.length() * 1.5 + (toC.lengthSq() > 0.01 ? toC.normalize().dot(dir) * 2 : 0);
          for (const w of wins) {
            const v = w.center.clone().sub(pos).setY(0);
            const ang = Math.acos(Math.max(-1, Math.min(1, v.normalize().dot(dir))));
            if (ang < halfH * 0.95) score += w.weight;
          }
        }
        if (!best || score > best.score) {
          const target = pos.clone().addScaledVector(dir, Math.max(2, diag * 0.7)).setY(y0 + 1.15);
          best = { score, pos, target };
        }
      }
    }
    if (!best) {
      best = { score: 0, pos: new THREE.Vector3(R.minX + 0.3, y0 + eyeH, R.minZ + 0.3), target: center.clone() };
    }
    const label = room.name || ROOM_TYPE_LABEL[room.type];
    void best;
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

function distToSeg2(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const l2 = abx * abx + abz * abz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2));
  return Math.hypot(a.x + abx * t - p.x, a.z + abz * t - p.z);
}
