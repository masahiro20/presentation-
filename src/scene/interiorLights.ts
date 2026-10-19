/**
 * 写真品質の内観用の光源
 *
 * 室内は窓から入る空の光だけだと、パストレーサーが窓を「たまたま」通る光線でしか明るさを拾えず、暗くノイズだらけになる。
 * 設計事務所の内観パースと同じ考え方で、
 * - 窓の室内側に、窓と同じ大きさの面光源（ポータル）を置く（カメラには写らず、窓からの光を直接サンプリングできる）
 * - 天井のダウンライト・ペンダントを点灯する（日中でも照明を点けた、温かみのある室内に）
 * 明るさは屋外の水平面照度に対する比で決める（露出の自動調整と組み合わせる）。
 */
import * as THREE from 'three';
import { PhysicalSpotLight } from 'three-gpu-pathtracer';
import type { BuildingModel, Floor, Wall } from '../core/types';
import { pointInPolygon } from '../core/geometry';
import { effectiveOpening, type BuilderSpec } from '../styles/spec';
import type { LightPoint } from './furniture';
import type { BuildingMeta } from './building';
import type { LandscapePlan } from './landscape';

export type PhotoMode = 'morning' | 'day' | 'evening' | 'night';

const MM = 0.001;

export interface InteriorLightOptions {
  model: BuildingModel;
  spec: BuilderSpec;
  lights: LightPoint[];
  /** カメラ位置（同じ階・近くの光源だけを使う。光源が多すぎると1本あたりのサンプルが減る） */
  camera: THREE.Vector3;
  /** 屋外の水平面照度（空＋太陽。レンダラーの単位） */
  skyE: number;
  /** 照明の色 */
  lampColor: THREE.Color;
  mode: PhotoMode;
}

/** カメラのある階（と吹抜でつながる上の階） */
function floorsNear(model: BuildingModel, y: number): Floor[] {
  const fs = [...model.floors].sort((a, b) => a.elevation - b.elevation);
  let i = fs.findIndex((f) => y >= f.elevation * MM - 0.2 && y < (f.elevation + f.height) * MM);
  if (i < 0) i = y < fs[0].elevation * MM ? 0 : fs.length - 1;
  return fs.slice(i, i + 2);
}

/** 外壁の室内側の法線（外形の内外で確かめる） */
function inwardNormal(f: Floor, w: Wall, mid: THREE.Vector3, nW: THREE.Vector3): THREE.Vector3 {
  let outSign = w.outsideSign ?? 1;
  if (f.outline.length) {
    const t = w.thickness * MM;
    const probe = (sg: number) => {
      const q = mid.clone().addScaledVector(nW, sg * (t / 2 + 0.35));
      return f.outline.some((l) => pointInPolygon({ x: q.x / MM, y: q.z / MM }, l));
    };
    const plusIn = probe(1);
    const minusIn = probe(-1);
    if (plusIn !== minusIn) outSign = plusIn ? -1 : 1;
  }
  return nW.clone().multiplyScalar(-outSign);
}

export function buildInteriorPhotoLights(o: InteriorLightOptions): THREE.Group {
  const g = new THREE.Group();
  g.name = 'photoreal-interior-lights';
  const floors = floorsNear(o.model, o.camera.y);
  const near = (p: THREE.Vector3, r: number) => Math.hypot(p.x - o.camera.x, p.z - o.camera.z) < r;

  // 窓のポータル（昼・夕方。夜は窓の外が暗いので不要）
  if (o.mode !== 'night') {
    // 空の平均的な輝度（太陽を除いた分の目安）。窓からの光の「補い」なので控えめに
    const L = o.skyE * (o.mode === 'evening' ? 0.07 : o.mode === 'morning' ? 0.1 : 0.14);
    const skyCol = new THREE.Color(o.mode === 'evening' ? '#ffe2c4' : o.mode === 'morning' ? '#f4eef2' : '#eef3ff');
    for (const f of floors) {
      const fl = f.elevation * MM;
      const walls = new Map(f.walls.map((w) => [w.id, w]));
      for (const op of f.openings) {
        if (op.kind !== 'window') continue;
        const w = walls.get(op.wallId);
        if (!w || !w.exterior) continue;
        const eff = effectiveOpening(op, f.ceilingHeight, o.spec);
        const A = new THREE.Vector3(w.a.x * MM, 0, w.a.y * MM);
        const B = new THREE.Vector3(w.b.x * MM, 0, w.b.y * MM);
        const dir = new THREE.Vector3().subVectors(B, A).normalize();
        const nW = new THREE.Vector3(-dir.z, 0, dir.x);
        const width = (op.t1 - op.t0) * MM - 0.06;
        const height = eff.height * MM - 0.06;
        if (width < 0.2 || height < 0.2) continue;
        const mid = A.clone().addScaledVector(dir, ((op.t0 + op.t1) / 2) * MM);
        if (!near(mid, 14)) continue;
        const inN = inwardNormal(f, w, mid, nW);
        const pos = mid.clone().addScaledVector(inN, (w.thickness * MM) / 2 + 0.02);
        pos.y = fl + (eff.sill + eff.height / 2) * MM;
        const l = new THREE.RectAreaLight(skyCol, L, width, height);
        l.position.copy(pos);
        // 光は -Z 方向（lookAt の向き）に出る → 室内側を向ける
        l.lookAt(pos.clone().add(inN));
        g.add(l);
      }
    }
  }

  // ダウンライト・ペンダント（同じ階・近くのもの）
  const lampScale = o.mode === 'night' ? 0.03 : o.mode === 'evening' ? 0.02 : 0.01;
  const Ed = o.skyE * lampScale; // 器具の真下の床の照度の目安
  const levels = new Set(floors.slice(0, 1).map((f) => f.elevation));
  const floorOf = (y: number) => o.model.floors.find((f) => y >= f.elevation * MM - 0.1 && y < (f.elevation + f.height) * MM);
  let count = 0;
  for (const lp of o.lights) {
    const f = floorOf(lp.pos.y);
    if (!f || !levels.has(f.elevation) || !near(lp.pos, 11)) continue;
    if (count >= 24) break;
    count++;
    if (lp.kind === 'ceiling') {
      const h = Math.max(1.8, lp.pos.y - f.elevation * MM);
      const s = new PhysicalSpotLight(o.lampColor, Ed * h * h);
      s.position.set(lp.pos.x, lp.pos.y - 0.03, lp.pos.z);
      s.target.position.set(lp.pos.x, lp.pos.y - 3, lp.pos.z);
      s.angle = THREE.MathUtils.degToRad(58);
      s.penumbra = 0.55;
      s.decay = 2;
      s.distance = 0;
      s.radius = 0.05;
      g.add(s, s.target);
    } else if (lp.kind === 'pendant') {
      const p = new THREE.PointLight(o.lampColor, Ed * 0.8 * 0.6, 0, 2);
      p.position.copy(lp.pos);
      g.add(p);
    } else {
      const p = new THREE.PointLight(o.lampColor, Ed * 0.3, 0, 2);
      p.position.copy(lp.pos);
      g.add(p);
    }
  }
  return g;
}

export interface ExteriorLightOptions {
  meta: BuildingMeta;
  plan: LandscapePlan;
  /** 室内の照明（窓の灯り用。全階） */
  lights: LightPoint[];
  mode: PhotoMode;
  /** 基準の照度（夜は昼の空を基準にした値を渡す） */
  skyE: number;
  lampColor: THREE.Color;
  /** パストレーサー用（物理的な減衰・大きさ）。false ならリアルタイム描画向けの値 */
  physical?: boolean;
}

/**
 * 夕景・夜景の外観用の照明
 * - 室内の天井照明を全室で点ける（窓からこぼれる灯り）
 * - 玄関ポーチのダウンライト、シンボルツリーのアップライト、アプローチのフットライト
 * 写真の夜景パースと同じ考え方で、建物のまわりに「灯りの層」をつくる。
 */
export function buildExteriorLights(o: ExteriorLightOptions): THREE.Group {
  const g = new THREE.Group();
  g.name = 'exterior-lights';
  if (o.mode !== 'evening' && o.mode !== 'night') return g;
  const night = o.mode === 'night';
  const Ed = o.skyE * (night ? 0.03 : 0.02);
  const warm = new THREE.Color('#ffd9a8');
  // 室内の灯り（全階の天井照明。夕景は控えめ）
  let n = 0;
  for (const lp of o.lights) {
    if (lp.kind !== 'ceiling') continue;
    if (n++ > 48) break;
    if (o.physical) {
      const p = new THREE.PointLight(o.lampColor, Ed * 3.2 * (night ? 1 : 0.7), 0, 2);
      p.position.set(lp.pos.x, lp.pos.y - 0.25, lp.pos.z);
      g.add(p);
    } else {
      const p = new THREE.PointLight(o.lampColor, night ? 6 : 4.5, 7, 1.6);
      p.position.set(lp.pos.x, lp.pos.y - 0.3, lp.pos.z);
      g.add(p);
    }
  }
  // 玄関ポーチのダウンライト（庇の下）
  const ent = o.meta.entrance;
  if (ent) {
    const pos = ent.pos.clone().addScaledVector(ent.outward, 0.55);
    pos.y = ent.pos.y + 2.25;
    const s = new PhysicalSpotLight(warm, o.physical ? Ed * 2.25 * 2.25 * 1.4 : night ? 14 : 9);
    s.position.copy(pos);
    s.target.position.set(pos.x, pos.y - 3, pos.z);
    s.angle = THREE.MathUtils.degToRad(55);
    s.penumbra = 0.6;
    s.decay = o.physical ? 2 : 1.6;
    s.distance = o.physical ? 0 : 7;
    s.radius = 0.04;
    g.add(s, s.target);
    // アプローチのフットライト（道路へ向かって 1.6m ごと）
    const n0 = Math.min(3, Math.floor(ent.width > 0 ? 3 : 2));
    for (let i = 1; i <= n0; i++) {
      const q = ent.pos.clone().addScaledVector(ent.outward, 1.2 + i * 1.6);
      q.y = 0.28;
      const p = new THREE.PointLight(warm, o.physical ? Ed * 0.12 : night ? 0.9 : 0.6, o.physical ? 0 : 2.6, o.physical ? 2 : 1.8);
      p.position.copy(q);
      g.add(p);
    }
  }
  // シンボルツリーのアップライト（大きい木から 2 本まで）
  const trees = [...o.plan.trees].sort((a, b) => b.r - a.r).slice(0, 2);
  for (const t of trees) {
    const base = new THREE.Vector3(t.x + t.r * 0.9, 0.12, t.z + t.r * 0.6);
    const s = new PhysicalSpotLight(warm, o.physical ? Ed * 2.6 * 2.6 * 1.2 : night ? 12 : 8);
    s.position.copy(base);
    s.target.position.set(t.x, t.r * 3.2, t.z);
    s.angle = THREE.MathUtils.degToRad(28);
    s.penumbra = 0.7;
    s.decay = o.physical ? 2 : 1.6;
    s.distance = o.physical ? 0 : 9;
    s.radius = 0.03;
    g.add(s, s.target);
  }
  return g;
}
