/**
 * 外構・敷地の自動生成
 * 玄関の向きを「道路側」とし、駐車スペース・アプローチ・植栽・フェンスを配置する。
 */
import * as THREE from 'three';
import { MeshBuilder, V } from './meshBuilder';
import type { BuildingMeta } from './building';
import type { ExteriorStyle } from '../styles/presets';
import { mulberry32 } from '../styles/noise';
import type { PlanSide, RoadInfo, SiteData } from '../core/types';

export interface SiteInfo {
  /** 敷地の範囲（ワールド） */
  min: THREE.Vector2;
  max: THREE.Vector2;
  /** 道路側の向き（外向き単位ベクトル） */
  roadDir: THREE.Vector3;
  /** 道路の中心線上の点 */
  roadCenter: THREE.Vector3;
  parking: { center: THREE.Vector3; along: THREE.Vector3 } | null;
}

const SIDE_WORLD: Record<PlanSide, THREE.Vector3> = { top: V(0, 0, -1), bottom: V(0, 0, 1), left: V(-1, 0, 0), right: V(1, 0, 0) };

/** 主な接道（複数あれば玄関に近い向き → 駐車場の奥行が取れる側 → 広い道路） */
export function primaryRoad(site: SiteData | undefined, entranceOutward?: THREE.Vector3, bbox?: THREE.Box3): RoadInfo | null {
  if (!site?.roads.length) return null;
  // 建物から敷地境界までの奥行（m）。駐車場（約5.5m）が取れない側は避ける
  const depth = (r: RoadInfo): number | null => {
    const bd = site.bounds?.[r.side];
    if (bd == null || !bbox) return null;
    const v = bd / 1000;
    return r.side === 'top' ? bbox.min.z - v : r.side === 'bottom' ? v - bbox.max.z : r.side === 'left' ? bbox.min.x - v : v - bbox.max.x;
  };
  const score = (r: RoadInfo) => {
    const d = depth(r);
    const room = d == null ? 0 : d >= 5.5 ? 8 : d >= 3 ? 2 : -8;
    return (entranceOutward ? SIDE_WORLD[r.side].dot(entranceOutward) * 6 : 0) + room + (r.widthMm ?? 4000) / 1000 + (r.source === 'manual' ? 100 : 0);
  };
  return site.roads.slice().sort((a, b) => score(b) - score(a))[0];
}

/** 平面図用の外構（ワールド座標 m） */
export interface LandscapePlan {
  trees: { x: number; z: number; r: number }[];
  shrubs: { x: number; z: number; r: number }[];
  paving: { key: string; pts: THREE.Vector3[] }[];
  /** 駐車場の車（中心・車の前後方向） */
  cars: { x: number; z: number; dirX: number; dirZ: number }[];
}

/** 図面の記号から読んだ外構（ワールド座標 m） */
export interface PlanExterior {
  cars: { x: number; z: number; dirX: number; dirZ: number }[];
  trees: { x: number; z: number; r: number }[];
}

export function buildLandscape(meta: BuildingMeta, style: ExteriorStyle, siteData?: SiteData, planExt?: PlanExterior): { mb: MeshBuilder; site: SiteInfo; trees: MeshBuilder; plan: LandscapePlan; town: { mb: MeshBuilder; box: THREE.Box3 }[] } {
  const mb = new MeshBuilder();
  const trees = new MeshBuilder();
  const plan: LandscapePlan = { trees: [], shrubs: [], paving: [], cars: [] };
  const b = meta.bbox;
  const ent = meta.entrance;
  // 道路方向: 図面から読み取った接道 → 無ければ玄関の外向き（軸に丸める）
  const pr = primaryRoad(siteData, ent?.outward, b);
  let road = pr ? SIDE_WORLD[pr.side].clone() : ent ? ent.outward.clone() : V(0, 0, 1);
  if (Math.abs(road.x) > Math.abs(road.z)) road = V(Math.sign(road.x), 0, 0);
  else road = V(0, 0, Math.sign(road.z) || 1);
  const side = 1.6;
  const back = 2.2;
  const min = new THREE.Vector2(b.min.x - side, b.min.z - side);
  const max = new THREE.Vector2(b.max.x + side, b.max.z + side);
  // 図面の敷地境界線（分かった辺のみ。建物からの距離は 0.3〜20m に制限）
  const bd = siteData?.bounds ?? {};
  const clampOut = (edge: number, pos: number | undefined, sign: number, def: number) => {
    if (pos == null) return edge + sign * def;
    const d = (pos / 1000 - edge) * sign;
    return edge + sign * Math.max(0.3, Math.min(20, d));
  };
  const front = 6.0; // 道路側の余白（駐車場）の既定
  min.x = clampOut(b.min.x, bd.left, -1, road.x < 0 ? front : road.x > 0 ? back : side);
  max.x = clampOut(b.max.x, bd.right, 1, road.x > 0 ? front : road.x < 0 ? back : side);
  min.y = clampOut(b.min.z, bd.top, -1, road.z < 0 ? front : road.z > 0 ? back : side);
  max.y = clampOut(b.max.z, bd.bottom, 1, road.z > 0 ? front : road.z < 0 ? back : side);

  // 敷地（芝・砂利など）: 少し高くして周囲の地面と区別
  const gy = 0.0;
  // 図面から敷地の形が読めた場合はその形（斜めの境界もそのまま）
  const poly = siteData?.polygon?.map((q) => V(q.x / 1000, gy, q.y / 1000));
  if (poly && poly.length >= 3) mb.polygon('l.ground', poly, V(0, 1, 0), V(1, 0, 0), V(0, 0, 1));
  else mb.quad('l.ground', V(min.x, gy, min.y), V(min.x, gy, max.y), V(max.x, gy, max.y), V(max.x, gy, min.y), V(1, 0, 0), V(0, 0, 1));
  // 周辺の地面（広く）
  const R = 120;
  const cx = (min.x + max.x) / 2;
  const cz = (min.y + max.y) / 2;
  mb.quad('l.far', V(cx - R, -0.02, cz - R), V(cx - R, -0.02, cz + R), V(cx + R, -0.02, cz + R), V(cx + R, -0.02, cz - R), V(1, 0, 0), V(0, 0, 1));

  // 道路（図面の幅員。不明なら 6m）
  const roadW = pr?.widthMm ? Math.max(3, Math.min(20, pr.widthMm / 1000)) : 6;
  let roadCenter: THREE.Vector3;
  const roadEdges = (siteData?.edges ?? []).filter((e) => e.kind === 'road');
  if (roadEdges.length) {
    // 「道路境界線」の辺ごとに、その外側へ道路を敷く
    const sc = V((b.min.x + b.max.x) / 2, 0, (b.min.z + b.max.z) / 2);
    let bestDot = -Infinity;
    roadCenter = V(0, 0, 0);
    for (const e of roadEdges) {
      const A = V(e.a.x / 1000, 0, e.a.y / 1000);
      const B = V(e.b.x / 1000, 0, e.b.y / 1000);
      const dir = B.clone().sub(A).normalize();
      let out = V(-dir.z, 0, dir.x);
      const mid = A.clone().add(B).multiplyScalar(0.5);
      if (out.dot(mid.clone().sub(sc)) < 0) out = out.negate();
      const A2 = A.clone().addScaledVector(dir, -12);
      const B2 = B.clone().addScaledVector(dir, 12);
      const p = [A2, B2, B2.clone().addScaledVector(out, roadW), A2.clone().addScaledVector(out, roadW)].map((q) => q.setY(0.005));
      const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
      if (n.y < 0) mb.quad('l.road', p[0], p[3], p[2], p[1], V(1, 0, 0), V(0, 0, 1));
      else mb.quad('l.road', p[0], p[1], p[2], p[3], V(1, 0, 0), V(0, 0, 1));
      mb.box('l.curb', mid.clone().addScaledVector(out, 0.1), dir, A.distanceTo(B) + 0.2, 0.12, 0.2);
      const d = out.dot(road);
      if (d > bestDot) {
        bestDot = d;
        roadCenter = mid.clone().addScaledVector(out, roadW / 2);
      }
    }
  } else if (road.x !== 0) {
    const x0 = road.x > 0 ? max.x + 0.2 : min.x - 0.2 - roadW;
    mb.quad('l.road', V(x0, 0.005, cz - 60), V(x0, 0.005, cz + 60), V(x0 + roadW, 0.005, cz + 60), V(x0 + roadW, 0.005, cz - 60), V(1, 0, 0), V(0, 0, 1));
    roadCenter = V(x0 + roadW / 2, 0, cz);
    // 縁石
    mb.aabb('l.curb', V(road.x > 0 ? max.x : min.x - 0.2, 0, cz - 60), V(road.x > 0 ? max.x + 0.2 : min.x, 0.12, cz + 60));
  } else {
    const z0 = road.z > 0 ? max.y + 0.2 : min.y - 0.2 - roadW;
    mb.quad('l.road', V(cx - 60, 0.005, z0), V(cx - 60, 0.005, z0 + roadW), V(cx + 60, 0.005, z0 + roadW), V(cx + 60, 0.005, z0), V(1, 0, 0), V(0, 0, 1));
    roadCenter = V(cx, 0, z0 + roadW / 2);
    mb.aabb('l.curb', V(cx - 60, 0, road.z > 0 ? max.y : min.y - 0.2), V(cx + 60, 0.12, road.z > 0 ? max.y + 0.2 : min.y));
  }

  // 駐車スペース（道路側の余白。玄関アプローチの横）
  const along = road.x !== 0 ? V(0, 0, 1) : V(1, 0, 0);
  const frontEdge = road.x > 0 ? b.max.x : road.x < 0 ? b.min.x : road.z > 0 ? b.max.z : b.min.z;
  const siteEdge = road.x > 0 ? max.x : road.x < 0 ? min.x : road.z > 0 ? max.y : min.y;
  const entAlong = ent ? ent.pos.dot(along) : (road.x !== 0 ? cz : cx);
  const alongMin = road.x !== 0 ? min.y : min.x;
  const alongMax = road.x !== 0 ? max.y : max.x;
  // 玄関から遠い側に駐車場
  const parkW = 5.4;
  const room1 = entAlong - alongMin;
  const room2 = alongMax - entAlong;
  const parkSign = room1 > room2 ? -1 : 1;
  const parkCenterAlong = parkSign < 0 ? Math.max(alongMin + parkW / 2 + 0.3, entAlong - 1.4 - parkW / 2) : Math.min(alongMax - parkW / 2 - 0.3, entAlong + 1.4 + parkW / 2);
  const depthA = Math.min(frontEdge, siteEdge) + 0.3;
  const depthB = Math.max(frontEdge, siteEdge);
  const toWorld = (a: number, d: number, y: number) => (road.x !== 0 ? V(d, y, a) : V(a, y, d));
  const rect = (key: string, a0: number, a1: number, d0: number, d1: number, y: number) => {
    const p = [toWorld(a0, d0, y), toWorld(a1, d0, y), toWorld(a1, d1, y), toWorld(a0, d1, y)];
    plan.paving.push({ key, pts: p });
    const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
    if (n.y < 0) mb.quad(key, p[0], p[3], p[2], p[1], V(1, 0, 0), V(0, 0, 1));
    else mb.quad(key, p[0], p[1], p[2], p[3], V(1, 0, 0), V(0, 0, 1));
  };
  rect('l.driveway', parkCenterAlong - parkW / 2, parkCenterAlong + parkW / 2, depthA - 0.3, depthB, 0.012);
  const parking = { center: toWorld(parkCenterAlong, (depthA + depthB) / 2, 0), along };
  // 図面に車が描かれていれば、その位置・向きに駐車場（舗装）を取る。車そのものは平面図にだけ描く（3D の外観パースは建物を主役に）
  if (planExt?.cars.length) {
    for (const c of planExt.cars) {
      plan.cars.push(c);
      const a = V(c.dirX, 0, c.dirZ).normalize();
      const s = V(-a.z, 0, a.x);
      const p = [V(c.x, 0.012, c.z).addScaledVector(a, -2.7).addScaledVector(s, -1.35), V(c.x, 0.012, c.z).addScaledVector(a, 2.7).addScaledVector(s, -1.35), V(c.x, 0.012, c.z).addScaledVector(a, 2.7).addScaledVector(s, 1.35), V(c.x, 0.012, c.z).addScaledVector(a, -2.7).addScaledVector(s, 1.35)];
      plan.paving.push({ key: 'l.driveway', pts: p });
      const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
      if (n.y < 0) mb.quad('l.driveway', p[0], p[3], p[2], p[1], V(1, 0, 0), V(0, 0, 1));
      else mb.quad('l.driveway', p[0], p[1], p[2], p[3], V(1, 0, 0), V(0, 0, 1));
    }
  } else if (depthB - depthA > 4.8) {
    // 駐車場の車（奥行が足りるときだけ。道路に向けて前進駐車）
    const nCar = parkW >= 5.0 ? 2 : 1;
    for (let i = 0; i < nCar; i++) {
      const a = parkCenterAlong + (nCar === 2 ? (i - 0.5) * 2.6 : 0);
      const c = toWorld(a, (depthA + depthB) / 2, 0);
      plan.cars.push({ x: c.x, z: c.z, dirX: road.x, dirZ: road.z });
    }
  }

  // アプローチ（玄関ポーチから道路まで）
  if (ent) {
    rect('l.approach', entAlong - 0.65, entAlong + 0.65, depthA + 1.2, depthB, 0.018);
  }

  function shrub(p: THREE.Vector3, s: number) {
    if (!spotOk(p, s * 0.5)) return;
    plan.shrubs.push({ x: p.x, z: p.z, r: s * 0.75 });
    // 低木: 葉カードの小さな塊
    for (let i = 0; i < 7; i++) {
      const off = V((rnd() - 0.5) * s * 1.4, s * (0.35 + rnd() * 0.5), (rnd() - 0.5) * s * 1.4);
      trees.card('l.leafCardDark', p.clone().setY(0).add(off), s * (1.0 + rnd() * 0.5), new THREE.Euler(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI));
    }
  }
  /** 植栽を置ける位置か: 敷地の内側（形が分かれば）、建物・駐車場・アプローチに重ならない */
  function spotOk(p: THREE.Vector3, r: number): boolean {
    if (p.x - r < min.x || p.x + r > max.x || p.z - r < min.y || p.z + r > max.y) return false;
    if (poly && poly.length >= 3) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i];
        const c = poly[j];
        if (a.z > p.z !== c.z > p.z && p.x < ((c.x - a.x) * (p.z - a.z)) / (c.z - a.z) + a.x) inside = !inside;
      }
      if (!inside) return false;
    }
    if (p.x > b.min.x - r - 0.3 && p.x < b.max.x + r + 0.3 && p.z > b.min.z - r - 0.3 && p.z < b.max.z + r + 0.3) return false;
    for (const pv of plan.paving) {
      const xs = pv.pts.map((q) => q.x);
      const zs = pv.pts.map((q) => q.z);
      if (p.x > Math.min(...xs) - r && p.x < Math.max(...xs) + r && p.z > Math.min(...zs) - r && p.z < Math.max(...zs) + r) return false;
    }
    return true;
  }
  // フェンス・生垣（道路側以外の3辺）
  const rnd = mulberry32(42);
  const fenceType = style.landscape.fence;
  const neighborEdges = (siteData?.edges ?? []).filter((e) => e.kind === 'neighbor');
  const edges: [THREE.Vector3, THREE.Vector3][] = neighborEdges.length
    ? neighborEdges.map((e) => [V(e.a.x / 1000, 0, e.a.y / 1000), V(e.b.x / 1000, 0, e.b.y / 1000)])
    : [
        [V(min.x, 0, min.y), V(max.x, 0, min.y)],
        [V(max.x, 0, min.y), V(max.x, 0, max.y)],
        [V(max.x, 0, max.y), V(min.x, 0, max.y)],
        [V(min.x, 0, max.y), V(min.x, 0, min.y)],
      ];
  for (const [a, c] of edges) {
    const mid = a.clone().add(c).multiplyScalar(0.5);
    const out = mid.clone().sub(V(cx, 0, cz));
    const isRoadSide = out.normalize().dot(road) > 0.9;
    if (isRoadSide) continue;
    // 側面のフェンスは建物の正面より奥だけ（道路側は開放的に）
    const isSide = Math.abs(out.dot(road)) < 0.1;
    if (isSide) {
      // 道路方向への射影が「建物正面 - 0.5m」を超える部分を切り詰める
      const sgn = road.x + road.z;
      const sFront = frontEdge * sgn - 0.5;
      for (const p of [a, c]) {
        const sp = p.dot(road);
        if (sp > sFront) p.addScaledVector(road, sFront - sp);
      }
      mid.copy(a).add(c).multiplyScalar(0.5);
    }
    const dir = c.clone().sub(a);
    const L = dir.length();
    if (L < 0.3) continue;
    dir.normalize();
    if (fenceType === 'block' || fenceType === 'wood') {
      mb.box('l.block', mid.clone(), dir, L, 0.4, 0.12);
      if (fenceType === 'wood') {
        const n = Math.floor(L / 0.12);
        for (let i = 0; i < n; i += 1) {
          if (i % 2) continue;
          const p = a.clone().addScaledVector(dir, (i + 0.5) * 0.12).setY(0.4);
          mb.box('l.fenceWood', p, dir, 0.09, 0.8, 0.02);
        }
        mb.box('l.fenceWood', mid.clone().setY(1.15), dir, L, 0.04, 0.05);
      }
    } else if (fenceType === 'hedge') {
      const n = Math.max(1, Math.floor(L / 0.9));
      for (let i = 0; i < n; i++) {
        const p = a.clone().addScaledVector(dir, (i + 0.5) * (L / n));
        shrub(p, 0.6);
      }
    }
  }

  // 植栽: シンボルツリー（アプローチ脇）と庭木
  const addTree = (p0: THREE.Vector3, h: number, kind: 'natural' | 'japanese' | 'modern', exact = false) => {
    // 敷地の内側で、建物から離れた位置に（だめなら敷地の中心へ寄せて探す。見つからなければ植えない）
    const r0 = h * 0.22;
    const siteC = V((min.x + max.x) / 2, 0, (min.y + max.y) / 2);
    let p: THREE.Vector3 | null = exact ? p0.clone() : null;
    for (let k = 0; k <= 6 && !p; k++) {
      const q = p0.clone().lerp(siteC, k * 0.12);
      if (spotOk(q, r0)) p = q;
    }
    if (!p) return;
    plan.trees.push({ x: p.x, z: p.z, r: h * (kind === 'modern' ? 0.26 : 0.3) });
    // 株立ち（アオダモ・ヤマボウシ風）: 幹 → 枝 → 小枝の分岐構造に、枝先だけ葉を付けて軽やかな樹冠にする
    const leafKey = kind === 'japanese' ? 'l.leafCardDark' : 'l.leafSpray';
    const up = V(0, 1, 0);
    const turn = (d: THREE.Vector3, minA: number, maxA: number) => {
      // d を、ランダムな直交軸まわりに minA〜maxA 回し、少し上向きに寄せる
      const ax = new THREE.Vector3().crossVectors(d, Math.abs(d.y) < 0.95 ? up : V(1, 0, 0)).normalize();
      ax.applyAxisAngle(d, rnd() * Math.PI * 2);
      const out = d.clone().applyAxisAngle(ax, minA + rnd() * (maxA - minA));
      return out.lerp(up, 0.15).normalize();
    };
    const leaves = (a: THREE.Vector3, b: THREE.Vector3, sz: number) => {
      const n = 3;
      for (let i = 0; i < n; i++) {
        const q = a.clone().lerp(b, 0.35 + 0.65 * rnd()).add(V((rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.12));
        trees.card(leafKey, q, sz * (0.75 + rnd() * 0.5), new THREE.Euler((rnd() - 0.5) * 1.6, rnd() * Math.PI * 2, (rnd() - 0.5) * 1.6));
      }
    };
    const leafSize = Math.max(0.32, h * 0.11);
    const grow = (a: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, level: number) => {
      const b = a.clone().addScaledVector(dir, len);
      trees.tube('l.trunk', a, b, r, r * 0.72);
      if (level >= 3) {
        leaves(a, b, leafSize);
        return;
      }
      const nChild = level === 0 ? 3 : 2;
      for (let i = 0; i < nChild; i++) {
        const t = 0.5 + (0.45 * (i + rnd() * 0.6)) / nChild;
        grow(a.clone().lerp(b, t), turn(dir, 0.45, 0.85), len * (0.5 + rnd() * 0.15), r * 0.55, level + 1);
      }
      // 先端の延長
      grow(b, turn(dir, 0.05, 0.25), len * (0.55 + rnd() * 0.1), r * 0.7, level + 1);
      if (level >= 2) leaves(a, b, leafSize * 0.9);
    };
    const stems = kind === 'modern' ? 4 : kind === 'natural' ? 3 : 1;
    for (let i = 0; i < stems; i++) {
      const az = (i / stems) * Math.PI * 2 + rnd() * 0.8;
      const lean = stems > 1 ? 0.14 + rnd() * 0.16 : 0.04;
      const d0 = V(Math.cos(az) * lean, 1, Math.sin(az) * lean).normalize();
      const base = p.clone().setY(0).add(V(Math.cos(az) * 0.06, 0, Math.sin(az) * 0.06));
      const r0 = (stems > 1 ? 0.04 : 0.08) * (h / 4);
      grow(base, d0, h * (0.42 + rnd() * 0.08), r0, 0);
    }
  };
  const kind = style.landscape.trees;
  // 図面に描かれた植栽はその位置に（大きさは記号の半径から）
  const drawn = planExt?.trees ?? [];
  for (const t of drawn) addTree(V(t.x, 0, t.z), Math.min(5.5, Math.max(2.2, t.r * 4.5)), kind, true);
  // 中庭（空に開いた void の区画）にはシンボルツリーと低木を置く（中庭のある平屋の定番。敷地が狭くても植栽が入る）
  for (const ri of meta.rooms) {
    const isCourt = ri.room.type === 'void' || (ri.room.type === 'balcony' && /中庭|坪庭|パティオ|ライトコート/.test(ri.room.name));
    if (!isCourt || ri.floor.level !== 1 || ri.poly.length < 3) continue;
    let area = 0;
    for (let i = 0, j = ri.poly.length - 1; i < ri.poly.length; j = i++) area += ri.poly[j].x * ri.poly[i].y - ri.poly[i].x * ri.poly[j].y;
    area = Math.abs(area) / 2;
    if (area < 3.5) continue;
    const c = V(ri.center.x, 0, ri.center.z);
    if (drawn.some((t) => Math.hypot(t.x - c.x, t.z - c.z) < 2.5)) continue;
    // 木は中心から少し外し（通路や掃き出し窓の正面を空ける）、高さは中庭の広さに合わせる
    const span = Math.sqrt(area);
    const off = Math.min(0.9, span * 0.18);
    addTree(c.clone().add(V(off * 0.7, 0, -off * 0.7)), Math.min(4.6, Math.max(2.8, span * 1.25)), kind, true);
    shrub(c.clone().add(V(-off, 0, off * 0.8)), 0.3);
    if (area >= 8) shrub(c.clone().add(V(off * 1.3, 0, off * 1.1)), 0.25);
  }
  if (ent && drawn.length < 2) {
    // シンボルツリーは駐車場と反対側の敷地の角（構図の額縁になる位置）
    const cornerAlong = parkSign > 0 ? alongMin + 1.3 : alongMax - 1.3;
    const tp = toWorld(Math.abs(cornerAlong - entAlong) > 1.8 ? cornerAlong : entAlong - 2.2 * parkSign, depthB - 1.1, 0);
    addTree(tp, 4.2, kind);
    shrub(toWorld(entAlong + 1.0 * -parkSign, depthB - 0.5, 0), 0.35);
    shrub(toWorld(entAlong + 2.2 * -parkSign, depthB - 0.6, 0), 0.4);
  }
  // 裏庭・側面
  const backCenter = road.clone().multiplyScalar(-1);
  const bpos = V(cx, 0, cz).addScaledVector(backCenter, (road.x !== 0 ? max.x - min.x : max.y - min.y) / 2 - 0.9);
  if (drawn.length < 2) {
    addTree(bpos.clone().addScaledVector(along, (alongMax - alongMin) * 0.35), 3.6, kind);
    addTree(bpos.clone().addScaledVector(along, -(alongMax - alongMin) * 0.38), 3.0, kind);
  }
  for (let i = 0; i < 5; i++) shrub(bpos.clone().addScaledVector(along, (rnd() - 0.5) * (alongMax - alongMin) * 0.8), 0.3 + rnd() * 0.2);
  // 庭木が足りなければ、敷地の空いている所（建物・舗装から離れた場所）に植える
  for (let guard = 0; plan.trees.length < 3 && guard < 3; guard++) {
    let best: { p: THREE.Vector3; score: number } | null = null;
    for (let x = min.x + 1; x <= max.x - 1; x += 0.5)
      for (let z = min.y + 1; z <= max.y - 1; z += 0.5) {
        const p = V(x, 0, z);
        if (!spotOk(p, 1.0)) continue;
        // 建物に近すぎず（2m 程度）、既存の木から離れた所
        const dB = Math.max(b.min.x - x, x - b.max.x, b.min.z - z, z - b.max.z, 0);
        const dT = Math.min(99, ...plan.trees.map((t) => Math.hypot(t.x - x, t.z - z)));
        // 道路側（建物の正面の前）は外観を隠すので避け、庭側・脇を優先
        const front = (x - (b.min.x + b.max.x) / 2) * road.x + (z - (b.min.z + b.max.z) / 2) * road.z > (road.x !== 0 ? (b.max.x - b.min.x) / 2 : (b.max.z - b.min.z) / 2);
        const score = -Math.abs(dB - 2.2) + Math.min(dT, 6) * 0.8 - (front ? 4 : 0);
        if (!best || score > best.score) best = { p, score };
      }
    if (!best) break;
    const n0 = plan.trees.length;
    addTree(best.p, 3.4 + rnd() * 0.8, kind);
    if (plan.trees.length === n0) break;
    shrub(best.p.clone().add(V(0.9, 0, 0.5)), 0.35);
  }

  // 隣家（住宅地の中の敷地に見せる: 道路以外の 3 辺のすぐ外に、淡い色の箱型住宅を並べる）
  const town: { mb: MeshBuilder; box: THREE.Box3 }[] = [];
  {
    let seed = 7;
    const r2 = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const sides: { n: THREE.Vector3; ok: boolean }[] = [
      { n: V(1, 0, 0), ok: !(road.x > 0) },
      { n: V(-1, 0, 0), ok: !(road.x < 0) },
      { n: V(0, 0, 1), ok: !(road.z > 0) },
      { n: V(0, 0, -1), ok: !(road.z < 0) },
    ];
    for (const s of sides) {
      if (!s.ok) continue;
      const alongV = V(-s.n.z, 0, s.n.x);
      const edge = s.n.x !== 0 ? (s.n.x > 0 ? max.x : min.x) : s.n.z > 0 ? max.y : min.y;
      const span = s.n.x !== 0 ? [min.y, max.y] : [min.x, max.x];
      // 道路に面する側の隣家は、道路境界から 1.5m 以上下がる（道路まで迫り出して外観を塞がない）
      const sideOfRoad = Math.abs(s.n.dot(road)) < 0.5;
      if (sideOfRoad) {
        const roadEdge = road.x !== 0 ? (road.x > 0 ? max.x : min.x) : road.z > 0 ? max.y : min.y;
        const sgn = road.x + road.z;
        if (sgn > 0) span[1] = Math.min(span[1], roadEdge - 3.0);
        else span[0] = Math.max(span[0], roadEdge + 3.0);
      }
      let t = span[0] - (sideOfRoad && road.x + road.z < 0 ? 0 : 4 + r2() * 3);
      while (t < span[1] + (sideOfRoad && road.x + road.z > 0 ? 0 : 4)) {
        const w = 6 + r2() * 3;
        const d = 6.5 + r2() * 2.5;
        const hh = r2() > 0.3 ? 6.0 : 3.2;
        const gap = 2.2 + r2() * 1.8;
        if (t + w > span[1] + (sideOfRoad && road.x + road.z > 0 ? 0 : 4)) break;
        const cA = (s.n.x !== 0 ? 0 : 1) * 0;
        void cA;
        const center = V(0, 0, 0);
        if (s.n.x !== 0) center.set(edge + s.n.x * (gap + d / 2), 0, t + w / 2);
        else center.set(t + w / 2, 0, edge + s.n.z * (gap + d / 2));
        const dir = s.n.x !== 0 ? V(0, 0, 1) : V(1, 0, 0);
        const len = w;
        const depth = d;
        // 躯体と、薄い片流れの屋根（色は 3 種からばらつかせる）
        const key = r2() > 0.66 ? 'l.nbWallB' : r2() > 0.4 ? 'l.nbWallA' : 'l.nbWallC';
        const one = new MeshBuilder();
        mb_box(one, key, center, dir, len, hh, depth);
        mb_box(one, 'l.nbRoof', center.clone().setY(hh), dir, len + 0.5, 0.35, depth + 0.5);
        const ex = dir.x !== 0 ? len : depth;
        const ez = dir.x !== 0 ? depth : len;
        town.push({ mb: one, box: new THREE.Box3(V(center.x - ex / 2, 0, center.z - ez / 2), V(center.x + ex / 2, hh + 0.4, center.z + ez / 2)) });
        t += w + 0.4 + r2() * 1.2;
        void alongV;
      }
    }
  }

  return {
    mb,
    trees,
    town,
    site: { min, max, roadDir: road, roadCenter, parking },
    plan,
  };
}

function mb_box(m: MeshBuilder, key: string, base: THREE.Vector3, dir: THREE.Vector3, len: number, height: number, depth: number) {
  m.box(key, base, dir, len, height, depth);
}
