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
  mode: 'day' | 'evening' | 'night';
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
    const L = o.skyE * (o.mode === 'evening' ? 0.07 : 0.14);
    const skyCol = new THREE.Color(o.mode === 'evening' ? '#ffe2c4' : '#eef3ff');
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
  const lampScale = o.mode === 'night' ? 0.02 : o.mode === 'evening' ? 0.016 : 0.01;
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
