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
import { stairFrame } from '../core/stairs';

export interface Shot {
  id: string;
  kind: 'exterior' | 'interior' | 'aerial' | 'cutaway' | 'section';
  title: string;
  caption: string;
  view: CameraView;
  /** パース用の太陽（ワールド方向）。null なら実際の太陽位置 */
  sunDir: THREE.Vector3 | null;
  timeOfDay?: 'morning' | 'day' | 'evening' | 'night';
  roomId?: string;
  level?: number;
  /** 輪切り模型: 切る階 */
  cutaway?: number;
  /** 断面: 鉛直の切断面（n の側を取り除く） */
  section?: { nx: number; nz: number; d: number };
}

/** 斜め上から見下ろすカメラで、点群が収まる距離を探す */
function fitOblique(pts: THREE.Vector3[], target: THREE.Vector3, fromDir: THREE.Vector3, elevRad: number, vfov: number, aspect: number, margin = 1.1): number {
  const tanV = Math.tan((vfov * Math.PI) / 360);
  const tanH = tanV * aspect;
  const hdir = fromDir.clone().setY(0).normalize();
  const fits = (dist: number) => {
    const pos = target.clone().addScaledVector(hdir, dist * Math.cos(elevRad)).add(new THREE.Vector3(0, dist * Math.sin(elevRad), 0));
    const fwd = target.clone().sub(pos).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    for (const p of pts) {
      const r = p.clone().sub(pos);
      const z = r.dot(fwd);
      if (z < 0.5) return false;
      if ((Math.abs(r.dot(right)) / z) * margin > tanH) return false;
      if ((Math.abs(r.dot(up)) / z) * margin > tanV) return false;
    }
    return true;
  };
  let lo = 1;
  let hi = 400;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

function sunForView(pos: THREE.Vector3, target: THREE.Vector3, sideSign = -1, elevDeg = 38, sideDeg = 55): THREE.Vector3 {
  // カメラの左後方 55° から光が当たるように（朝・夕は横から低く差し込む）
  const d = new THREE.Vector3().subVectors(target, pos).setY(0).normalize();
  const back = d.clone().negate();
  const ang = (sideSign * sideDeg * Math.PI) / 180;
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
  // 目の高さ 1.5m、35mm 相当の画角（広角の歪みを避ける）、建物のまわりに余白を取る
  const eye = 1.5;
  const vfov = 38;
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
    const dist = fitDistance(pts, center, dir, eye, vfov, aspect, 1.3);
    const pos = center.clone().addScaledVector(dir, -dist).setY(eye);
    // シフト量は、建物の上端と下端の見かけの高さの真ん中に合わせる（以前は高さの 4 割に固定で、3 階建てでは屋根が切れていた）
    const fwd = dir.clone().setY(0).normalize();
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      const r = p.clone().sub(pos);
      const z = r.dot(fwd);
      if (z < 0.5) continue;
      lo = Math.min(lo, r.y / z);
      hi = Math.max(hi, r.y / z);
    }
    const midTan = Number.isFinite(lo) ? (lo + hi) / 2 : (topY * 0.4 - eye) / dist;
    const target = center.clone().setY(eye + midTan * dist);
    // 時間帯ごとの太陽: 昼は高く（38°）、朝は低く横から（長い影と靄）、夕景はさらに低く逆光気味
    const elev = tod === 'morning' ? 16 : tod === 'evening' ? 9 : 38;
    const side = tod === 'morning' ? 88 : tod === 'evening' ? 112 : 55;
    return { id, kind: 'exterior', title, caption, view: { pos, target, fov: vfov, architectural: true }, sunDir: sunForView(pos, target, sideSign, elev, side), timeOfDay: tod };
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
    // 道路側の正面: 御社の外観パースは道路から玄関のある面を正面寄りに撮る（堀様邸: 道路に面した細い面と R 壁の玄関）。
    // 窓の多さだけで選ぶと、道路から 70° 以上振れて窓の多い長手の面を撮ってしまうので、道路から ±50° に絞り、
    // 道路の正面ほど・玄関が見えるほど高く評価する
    const maxScore = Math.max(1e-6, ...cands.map((c) => c.score));
    const entOut = ent ? ent.outward.clone().setY(0).normalize() : null;
    const roadSide = cands
      .filter((c) => c.dir.dot(road) > 0.64)
      .map((c) => ({ ...c, score: (c.score / maxScore) * (0.5 + 0.5 * c.dir.dot(road)) + (entOut ? Math.max(0, entOut.dot(c.dir)) * 0.6 : 0) }))
      .sort((a, b) => b.score - a.score);
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
  // 見上げ（御社の提案セットにある、道路際から低い目線で壁と空を見上げるカット）
  {
    const dir = frontDir.clone().negate().normalize();
    const lowEye = 0.6;
    const dist = fitDistance(pts, center, dir, lowEye, 48, aspect, 1.15) * 1.05;
    const pos = center.clone().addScaledVector(dir, -dist).setY(lowEye);
    const target = center.clone().setY(topY * 0.62);
    shots.push({ id: 'ext-low', kind: 'exterior', title: '外観パース（見上げ）', caption: '道路際から見上げた外観。塗り壁の面と空の広がり、軒の薄さが際立ちます。', view: { pos, target, fov: 48, architectural: false }, sunDir: sunForView(pos, target, -1, 42, 60), timeOfDay: 'day' });
  }
  shots.push(mk('ext-morning', '朝のパース', '朝の光が横から差し込む外観。長い影と薄い靄が、塗り壁の質感を引き立てます。', frontDir, 'morning'));
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
  // 輪切り模型（階ごと）: 壁を腰の高さで切って、道路側の斜め上から見下ろす
  for (const o of meta.outlines) {
    const bb = new THREE.Box2();
    for (const poly of o.polys) for (const p of poly) bb.expandByPoint(p);
    if (bb.isEmpty()) continue;
    const cpts: THREE.Vector3[] = [];
    for (const x of [bb.min.x - 0.4, bb.max.x + 0.4]) for (const z of [bb.min.y - 0.4, bb.max.y + 0.4]) for (const y of [o.y - 0.3, o.y + 1.5]) cpts.push(new THREE.Vector3(x, y, z));
    const tgt = new THREE.Vector3((bb.min.x + bb.max.x) / 2, o.y + 0.5, (bb.min.y + bb.max.y) / 2);
    const elev = (36 * Math.PI) / 180;
    const cfov = 36;
    const d = fitOblique(cpts, tgt, frontDir, elev, cfov, aspect, 1.06);
    const cpos = tgt.clone().addScaledVector(frontDir.clone().setY(0).normalize(), d * Math.cos(elev)).add(new THREE.Vector3(0, d * Math.sin(elev), 0));
    shots.push({
      id: `cut-${o.level}`,
      kind: 'cutaway',
      title: `${o.level}階 輪切り模型`,
      caption: `${o.level}階の壁を腰の高さで水平に切り、斜め上から見下ろした模型。部屋のつながり・広さ・家具の配置が一目でわかります。`,
      view: { pos: cpos, target: tgt, fov: cfov },
      sunDir: sunForView(cpos, tgt, -1, 52),
      timeOfDay: 'day',
      level: o.level,
      cutaway: o.level,
    });
  }
  return shots;
}

/**
 * 断面パース: 建物を鉛直に切って、階段・吹抜・天井高のつながりを見せる。
 * 1 枚目は階段の進行方向に沿って（階段があれば）、2 枚目はそれと直交する向き。
 */
export function sectionShots(model: BuildingModel, meta: BuildingMeta, roadDir: THREE.Vector3, aspect = 16 / 9): Shot[] {
  const b = meta.bbox;
  if (b.isEmpty()) return [];
  const c = b.getCenter(new THREE.Vector3());
  const road = new THREE.Vector3(roadDir.x, 0, roadDir.z).normalize();
  const stair = model.floors[0]?.stairs.find((s) => s.goesUp) ?? model.floors.flatMap((f) => f.stairs)[0];
  // 1 枚目の切断面の法線（取り除く側 = カメラ側）。階段があれば階段の進行方向を含む面
  let n1: THREE.Vector3;
  let through: THREE.Vector3;
  if (stair) {
    const F = stairFrame(stair);
    n1 = new THREE.Vector3(F.r.x, 0, F.r.y).normalize();
    through = new THREE.Vector3(((stair.minX + stair.maxX) / 2) * MM, 0, ((stair.minY + stair.maxY) / 2) * MM);
  } else {
    n1 = road.clone();
    through = c.clone();
  }
  if (n1.dot(road) < -0.05) n1.negate();
  const topY = b.max.y + 0.3;
  const corners: THREE.Vector3[] = [];
  for (const x of [b.min.x - 0.5, b.max.x + 0.5]) for (const z of [b.min.z - 0.5, b.max.z + 0.5]) for (const y of [-0.2, topY]) corners.push(new THREE.Vector3(x, y, z));
  const mk = (id: string, title: string, caption: string, n: THREE.Vector3, p: THREE.Vector3): Shot => {
    const d = n.dot(p);
    // 残る側の点群（取り除く側の角は切断面の上に寄せる）
    const pts = corners.map((q) => {
      const f = q.dot(n) - d;
      return f > 0 ? q.clone().addScaledVector(n, -f) : q.clone();
    });
    const tgt = c.clone().addScaledVector(n, -(c.dot(n) - d)).setY(topY * 0.42);
    const elev = (14 * Math.PI) / 180;
    const fov = 34;
    const dist = fitOblique(pts, tgt, n, elev, fov, aspect, 1.08);
    const pos = tgt.clone().addScaledVector(n, dist * Math.cos(elev)).add(new THREE.Vector3(0, dist * Math.sin(elev), 0));
    return { id, kind: 'section', title, caption, view: { pos, target: tgt, fov }, sunDir: sunForView(pos, tgt, -1, 42), timeOfDay: 'day', section: { nx: n.x, nz: n.z, d } };
  };
  const shots: Shot[] = [];
  shots.push(
    mk(
      'section-1',
      stair ? '断面パース（階段まわり）' : '断面パース',
      '建物を縦に切った断面。各階の天井の高さ、階段や吹抜のつながり、窓の高さの関係が一目でわかります。',
      n1,
      through,
    ),
  );
  const n2 = new THREE.Vector3(-n1.z, 0, n1.x);
  if (n2.dot(road) < -0.05) n2.negate();
  shots.push(mk('section-2', '断面パース（直交方向）', '反対の向きに切った断面。LDK の奥行きと天井高、上下階の関係をご確認いただけます。', n2, c));
  return shots;
}

interface WinInfo {
  center: THREE.Vector3;
  width: number;
  weight: number;
  /** 窓から部屋の内側へ向かう水平の単位ベクトル */
  inward: THREE.Vector3;
  /** 腰高（m）。掃き出し窓は 0 */
  sill: number;
}

/** 原点から方向へのレイの到達距離（障害物がなければ far） */
export type RayFn = (origin: THREE.Vector3, dir: THREE.Vector3, far: number) => number;

export function interiorShots(model: BuildingModel, meta: BuildingMeta, occupancy: Map<string, Footprint[]>, aspect = 16 / 9, ray?: RayFn): Shot[] {
  const shots: Shot[] = [];
  const priority = ['ldk', 'living', 'dining', 'kitchen', 'japanese', 'bedroom', 'kids', 'study', 'entrance', 'bath', 'washroom'];
  const rooms = meta.rooms
    .filter((r) => isHabitable(r.room.type) || r.room.type === 'entrance' || r.room.type === 'bath')
    .sort((a, b) => priority.indexOf(a.room.type) - priority.indexOf(b.room.type) || b.room.area - a.room.area);
  // 個室（寝室・子供室）のカットは、いちばん広い 1 室だけ。御社の内観パースの組は LDK・吹抜・キッチン・書斎・ホールが中心で、
  // 小さな洋室を何枚も並べても見せ場にならない（ベッドと壁だけのカットが続いていた）
  let privateShots = 0;
  for (const ri of rooms) {
    const room = ri.room;
    if ((room.type === 'bedroom' || room.type === 'kids') && privateShots >= 1) continue;
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
    let best: { score: number; pos: THREE.Vector3; target: THREE.Vector3; mean: number } | null = null;
    // 小さな個室（寝室・子供室・和室・書斎）は建築写真の作法どおり、入口か部屋の隅に立って対角を広角で撮る。
    // 以前は部屋の中の格子点（ベッドから 30cm 離れた所）から選んでいて、ベッドと壁しか写らないカットが多かった
    const smallRoom = ['bedroom', 'kids', 'japanese', 'study'].includes(room.type) && room.area < 16;
    // 建築写真の広角より気持ち広め（16:9 で水平約 86°、20mm 相当）。小さな個室はさらに広角（16mm 相当）
    const vfov = smallRoom ? (aspect > 1.4 ? 66 : 74) : aspect > 1.4 ? 56 : 64;
    const halfH = Math.atan(Math.tan((vfov * Math.PI) / 360) * aspect);
    // 候補位置: 部屋内の格子点（家具・扉の近くは除外）
    const cands: THREE.Vector3[] = [];
    const step = Math.max(0.4, Math.min(W, D) / 6);
    const ins = Math.min(0.4, Math.min(W, D) * 0.18);
    for (let x = R.minX + ins; x <= R.maxX - ins + 1e-6; x += step)
      for (let z = R.minZ + ins; z <= R.maxZ - ins + 1e-6; z += step) {
        const pos = new THREE.Vector3(x, y0 + eyeH, z);
        if (occ.some((o) => o.maxY > 0.5 && x > o.minX - 0.3 && x < o.maxX + 0.3 && z > o.minZ - 0.3 && z < o.maxZ + 0.3)) continue;
        // 背の高い物（レンジフード・カップボード・トール収納）のすぐそばには立たない（頭上に大きな箱がかぶる構図を避ける）
        if (occ.some((o) => o.maxY > 1.4 && x > o.minX - 0.9 && x < o.maxX + 0.9 && z > o.minZ - 0.9 && z < o.maxZ + 0.9)) continue;
        if (meta.doorLeaves.some((d) => Math.abs(d.a.y - y0) < 0.5 && distToSeg2(pos, d.a, d.b) < 0.7)) continue;
        cands.push(pos);
      }
    if (smallRoom) {
      // 部屋の 4 隅（壁から 30cm）と、入口の内側（扉の脇 50cm）。背の高い家具のすぐそばだけ避ける
      const c2: THREE.Vector3[] = [];
      for (const [x, z] of [
        [R.minX + 0.3, R.minZ + 0.3],
        [R.maxX - 0.3, R.minZ + 0.3],
        [R.minX + 0.3, R.maxZ - 0.3],
        [R.maxX - 0.3, R.maxZ - 0.3],
      ])
        c2.push(new THREE.Vector3(x, y0 + eyeH, z));
      for (const d of meta.doorLeaves) {
        if (Math.abs(d.a.y - y0) > 0.5) continue;
        const mid = d.a.clone().add(d.b).multiplyScalar(0.5);
        const toC = center.clone().sub(mid).setY(0);
        if (toC.length() > Math.hypot(W, D) * 0.75) continue;
        if (mid.x < R.minX - 0.6 || mid.x > R.maxX + 0.6 || mid.z < R.minZ - 0.6 || mid.z > R.maxZ + 0.6) continue;
        c2.push(mid.clone().addScaledVector(toC.normalize(), 0.5).setY(y0 + eyeH));
      }
      for (const p2 of c2) {
        if (occ.some((o) => o.maxY > 1.4 && p2.x > o.minX - 0.3 && p2.x < o.maxX + 0.3 && p2.z > o.minZ - 0.3 && p2.z < o.maxZ + 0.3)) continue;
        if (p2.x < R.minX || p2.x > R.maxX || p2.z < R.minZ || p2.z > R.maxZ) continue;
        cands.push(p2);
      }
    }
    const diag = Math.hypot(W, D);
    for (const pos of cands) {
      for (let k = 0; k < 16; k++) {
        const yaw = (k / 16) * Math.PI * 2;
        const dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
        let score: number;
        let meanDist = Infinity;
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
          meanDist = mean;
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
        // 家具が画面の端で切れる構図は避ける（ソファ・テーブルが縁で半分になるカット）。
        // キッチンや収納のような長い物は端で切れても自然なので軽く見る
        let cut = 0;
        for (const o of occ) {
          if (o.maxY < 0.4) continue;
          const size = Math.max(o.maxX - o.minX, o.maxZ - o.minZ);
          let inside = 0;
          let edge = 0;
          for (const [cx, cz] of [
            [o.minX, o.minZ],
            [o.maxX, o.minZ],
            [o.minX, o.maxZ],
            [o.maxX, o.maxZ],
          ]) {
            const vx = cx - pos.x;
            const vz = cz - pos.z;
            const d = Math.hypot(vx, vz);
            if (d < 0.05) {
              inside++;
              continue;
            }
            const dot = (vx * dir.x + vz * dir.z) / d;
            if (dot <= 0) {
              if (d < diag) edge++;
              continue;
            }
            const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
            if (ang < halfH) inside++;
            else if (d < diag) edge++;
          }
          if (inside > 0 && edge > 0) cut += size > 2.0 ? 0.35 : 1;
        }
        score -= Math.min(cut, 3) * 0.9;
        if (!best || score > best.score) {
          const target = pos.clone().addScaledVector(dir, Math.max(2, diag * 0.7)).setY(y0 + 1.15);
          best = { score, pos, target, mean: ray ? meanDist : Infinity };
        }
      }
    }
    if (!best) {
      best = { score: 0, pos: new THREE.Vector3(R.minX + 0.3, y0 + eyeH, R.minZ + 0.3), target: center.clone(), mean: Infinity };
    }
    // どこを向いても壁がすぐ目の前（狭い玄関・土間など）になる部屋は、パースとして成立しないので外す。
    // 玄関は廊下状の土間・SIC だと見せ場にならないので、ゆとりのある玄関ホールだけ
    if (best.mean < (room.type === 'entrance' ? 2.4 : 1.7)) continue;
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
    if (room.type === 'bedroom' || room.type === 'kids') privateShots++;
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
  shots.push(...extraInteriorShots(model, meta, occupancy, aspect, ray));
  return shots;
}

/**
 * 御社の提案セット（服部様・林様・池本様の最終パース）から学んだ追加のカット:
 *  - 中庭を望む: 中庭に面した一番大きな部屋から、中庭の窓を正面に
 *  - ホール・廊下: 長い廊下の端から奥へ（突き当たりの窓・中庭の緑を見せる）
 *  - キッチンから: LDK をキッチン側からダイニング・リビングへ（料理をしながら見える景色）
 */
function extraInteriorShots(model: BuildingModel, meta: BuildingMeta, occupancy: Map<string, Footprint[]>, aspect: number, ray?: RayFn): Shot[] {
  const out: Shot[] = [];
  const vfov = aspect > 1.4 ? 56 : 64;
  const eyeH = 1.35;
  const distToPoly = (p: THREE.Vector3, poly: THREE.Vector2[]) => {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      best = Math.min(best, distToSeg2(p, new THREE.Vector3(a.x, 0, a.y), new THREE.Vector3(b.x, 0, b.y)));
    }
    return best;
  };
  const inPoly = (x: number, z: number, poly: THREE.Vector2[]) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > z !== b.y > z && x < ((b.x - a.x) * (z - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  const clear = (pos: THREE.Vector3, dir: THREE.Vector3) => (ray ? ray(pos, dir, 9) : 9);
  // ---- 中庭を望む ----
  // 中庭: 1 階の空に開いた区画（2 階の void は室内の吹抜なので含めない）
  const courts = meta.rooms.filter((r) => (r.room.type === 'void' && r.floor.level === 1) || /中庭|坪庭|パティオ|ライトコート|ドッグラン/.test(r.room.name));
  for (const ct of courts) {
    const cands = meta.rooms
      .filter((r) => r !== ct && r.floor.level === ct.floor.level && isHabitable(r.room.type) && r.room.area >= 6)
      .sort((a, b) => b.room.area - a.room.area);
    let made = false;
    for (const ri of cands) {
      if (made) break;
      const wins = windowsOf(model, ri.floor.level, ri.room, ri.floorY).filter((w) => distToPoly(w.center, ct.poly) < 0.7);
      if (!wins.length) continue;
      // 掃き出し（腰高 0.6m 未満）を優先し、その中で大きい窓。高窓しか無ければ高窓
      const w = wins.sort((a, b) => (a.sill < 0.6 ? 0 : 1) - (b.sill < 0.6 ? 0 : 1) || b.weight - a.weight)[0];
      const inner = largestInnerRect(ri.room.polygon, 5);
      if (!inner) continue;
      const R = { minX: inner.minX * MM, maxX: inner.maxX * MM, minZ: inner.minY * MM, maxZ: inner.maxY * MM };
      // 窓の壁の法線に沿って部屋の奥へ下がる（L 字の部屋で中心へ向かうと窓を横から見てしまう）
      const away = w.inward.clone();
      const occ = occupancy.get(ri.room.id) ?? [];
      // 窓から部屋の奥へ下がる（家具に当たらない、部屋の内側にある位置）
      let pos: THREE.Vector3 | null = null;
      for (let d = Math.min(4.2, Math.hypot(R.maxX - R.minX, R.maxZ - R.minZ) * 0.75); d >= 1.6; d -= 0.3) {
        const p = w.center.clone().setY(0).addScaledVector(away, d);
        p.y = ri.floorY + eyeH;
        if (!inPoly(p.x, p.z, ri.poly)) continue;
        // 部屋の多角形が中庭を囲んでいる（穴になっている）ことがあるので、中庭や他の部屋の中は除く
        if (courts.some((c) => inPoly(p.x, p.z, c.poly))) continue;
        if (meta.rooms.some((o) => o !== ri && o.floor.level === ri.floor.level && o.room.area < ri.room.area && inPoly(p.x, p.z, o.poly))) continue;
        if (occ.some((o) => o.maxY > 0.5 && p.x > o.minX - 0.3 && p.x < o.maxX + 0.3 && p.z > o.minZ - 0.3 && p.z < o.maxZ + 0.3)) continue;
        pos = p;
        break;
      }
      if (!pos) continue;
      const target = w.center.clone().setY(ri.floorY + 1.25);
      const dir = target.clone().sub(pos).setY(0).normalize();
      if (clear(pos, dir) < 1.5) continue;
      out.push({
        id: `int-court-${ct.room.id}`,
        kind: 'interior',
        title: `内観パース（${ri.room.name || ROOM_TYPE_LABEL[ri.room.type]}から${ct.room.name || '中庭'}）`,
        caption: `${ri.room.name || ROOM_TYPE_LABEL[ri.room.type]}から${ct.room.name || '中庭'}を望む。窓いっぱいの緑と空が、室内の静けさを引き立てます。`,
        view: { pos, target, fov: vfov, architectural: true },
        sunDir: null,
        roomId: ri.room.id,
        level: ri.floor.level,
      });
      made = true;
    }
  }
  // ---- ホール・廊下 ----
  // 吹抜を囲む L 字・ロの字のホールは「一番大きな内接長方形」が吹抜の上に来てしまうので、
  // ホールの床の上（吹抜・中庭・他室を除く）を 30cm 刻みで歩き、一番奥まで見通せる端と向きを選ぶ
  const holes = meta.rooms.filter((r) => r.room.type === 'void' || /中庭|坪庭|パティオ|ライトコート|ドッグラン/.test(r.room.name));
  for (const ri of meta.rooms.filter((r) => r.room.type === 'hall')) {
    if (ri.room.area < 3.2) continue;
    let bb = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const p of ri.poly) bb = { minX: Math.min(bb.minX, p.x), maxX: Math.max(bb.maxX, p.x), minZ: Math.min(bb.minZ, p.y), maxZ: Math.max(bb.maxZ, p.y) };
    if (bb.maxX - bb.minX < 3.0 && bb.maxZ - bb.minZ < 3.0) continue;
    const others = meta.rooms.filter((o) => o !== ri && o.floor.level === ri.floor.level && o.room.area < ri.room.area);
    const dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
    let best: { pos: THREE.Vector3; dir: THREE.Vector3; see: number; score: number } | null = null;
    for (let x = bb.minX + 0.45; x <= bb.maxX - 0.45; x += 0.3) {
      for (let z = bb.minZ + 0.45; z <= bb.maxZ - 0.45; z += 0.3) {
        if (!inPoly(x, z, ri.poly)) continue;
        const pos = new THREE.Vector3(x, ri.floorY + eyeH, z);
        if (distToPoly(pos, ri.poly) < 0.42) continue;
        if (holes.some((h) => h.floor.level === ri.floor.level && inPoly(x, z, h.poly))) continue;
        if (others.some((o) => inPoly(x, z, o.poly))) continue;
        for (const dir of dirs) {
          const see = clear(pos, dir);
          // 3.6m 先まで見通せない廊下は見せ場にならない
          if (see < 3.6) continue;
          // 見る先の 2.4m は自分の床（吹抜の上を見渡すのではなく、廊下を歩く向き）
          let walk = true;
          for (let d = 0.6; d <= 2.4 && walk; d += 0.6) {
            const q = pos.clone().addScaledVector(dir, d);
            if (!inPoly(q.x, q.z, ri.poly) || holes.some((h) => h.floor.level === ri.floor.level && inPoly(q.x, q.z, h.poly))) walk = false;
          }
          if (!walk) continue;
          // 幅 90cm の廊下の真ん中からだと両脇の壁が画面の大半を占め、壁の中に立っているような絵になる。
          // 両脇あわせて 1.5m 以上ひらけている（広いホール・吹抜や階段に面した廊下）所だけを撮る
          const side = new THREE.Vector3(-dir.z, 0, dir.x);
          const l = clear(pos, side);
          const r = clear(pos, side.clone().negate());
          if (Math.min(l, r) < 0.4 || l + r < 1.5) continue;
          // 画角の内側（斜め 25°・45°）もすぐ壁だと、画面の半分が壁の絵になる
          const diag = [25, -25, 45, -45].map((deg) => {
            const a = (deg * Math.PI) / 180;
            return clear(pos, new THREE.Vector3(dir.x * Math.cos(a) - dir.z * Math.sin(a), 0, dir.x * Math.sin(a) + dir.z * Math.cos(a)));
          });
          if (Math.min(diag[0], diag[1]) < 1.6 || Math.min(diag[2], diag[3]) < 0.8) continue;
          const back = clear(pos, dir.clone().negate());
          // 廊下の端に立って奥を見る（背中側はすぐ壁）が廊下らしい
          const score = see + (back < 0.9 ? 0.6 : 0) - back * 0.15;
          if (!best || score > best.score) best = { pos, dir, see, score };
        }
      }
    }
    if (!best) continue;
    const target = best.pos.clone().addScaledVector(best.dir, Math.max(3, best.see * 0.8)).setY(ri.floorY + 1.2);
    out.push({
      id: `int-hall-${ri.room.id}`,
      kind: 'interior',
      title: `内観パース（${ri.room.name || 'ホール'}）`,
      caption: `${ri.room.name || 'ホール'}の奥行き。突き当たりの光に向かって歩く、家の中の小さな道です。`,
      view: { pos: best.pos, target, fov: vfov, architectural: true },
      sunDir: null,
      roomId: ri.room.id,
      level: ri.floor.level,
    });
  }
  // ---- キッチンから（LDK） ----
  for (const ri of meta.rooms.filter((r) => (r.room.type === 'ldk' || r.room.type === 'kitchen') && r.room.area >= 16)) {
    const occ = occupancy.get(ri.room.id) ?? [];
    // 背の高い物（レンジフード・カップボード）がキッチンの目印
    const tall = occ.filter((o) => o.maxY > 1.4);
    if (!tall.length) continue;
    const kb = tall.reduce((b, o) => ({ minX: Math.min(b.minX, o.minX), maxX: Math.max(b.maxX, o.maxX), minZ: Math.min(b.minZ, o.minZ), maxZ: Math.max(b.maxZ, o.maxZ) }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
    const kc = new THREE.Vector3((kb.minX + kb.maxX) / 2, 0, (kb.minZ + kb.maxZ) / 2);
    const rc = ri.center.clone().setY(0);
    const toRoom = rc.clone().sub(kc).setY(0);
    if (toRoom.length() < 2.5) continue;
    toRoom.normalize();
    // キッチンの前（部屋側）に立ち、ダイニング・リビングの方を見る
    let pos: THREE.Vector3 | null = null;
    for (let d = 1.2; d <= 2.4; d += 0.3) {
      const p = kc.clone().addScaledVector(toRoom, Math.max(kb.maxX - kb.minX, kb.maxZ - kb.minZ) / 2 + d);
      p.y = ri.floorY + eyeH;
      if (!inPoly(p.x, p.z, ri.poly)) continue;
      if (meta.rooms.some((o) => o !== ri && o.floor.level === ri.floor.level && o.room.area < ri.room.area && inPoly(p.x, p.z, o.poly))) continue;
      if (occ.some((o) => o.maxY > 0.5 && p.x > o.minX - 0.25 && p.x < o.maxX + 0.25 && p.z > o.minZ - 0.25 && p.z < o.maxZ + 0.25)) continue;
      pos = p;
      break;
    }
    if (!pos) continue;
    const target = pos.clone().addScaledVector(toRoom, Math.max(3, toRoom.length() * 2)).setY(ri.floorY + 1.15);
    if (clear(pos, toRoom) < 2.5) continue;
    out.push({
      id: `int-kitchen-${ri.room.id}`,
      kind: 'interior',
      title: '内観パース（キッチンから）',
      caption: 'キッチンに立ったときの景色。料理をしながら家族と会話し、ダイニングとリビングを見渡せます。',
      view: { pos, target, fov: vfov, architectural: true },
      sunDir: null,
      roomId: ri.room.id,
      level: ri.floor.level,
    });
  }
  return out;
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
    // 壁の法線のうち、部屋の内側を向く方
    let nx = -(w.b.y - w.a.y);
    let ny = w.b.x - w.a.x;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const probe = { x: cx + nx * 400, y: cy + ny * 400 };
    let inside = false;
    const poly = room.polygon;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > probe.y !== b.y > probe.y && probe.x < ((b.x - a.x) * (probe.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    const inward = new THREE.Vector3(inside ? nx : -nx, 0, inside ? ny : -ny);
    out.push({ center: new THREE.Vector3(cx * MM, y0 + (o.sill + o.height / 2) * MM, cy * MM), width, weight: width * (o.height / 1000), inward, sill: o.sill * MM });
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
