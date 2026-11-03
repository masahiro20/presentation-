/**
 * 外構に手で置く物（植栽・フェンス・車・BBQ セット・ベンチ・自転車・物置・ポスト・プランター・庭園灯）の 3D。
 * 木・低木は外構（landscape.ts）の植栽と同じ作りで植えるので、ここでは「物」だけを作る。
 * 平面図用の外形（LandscapePlan.items）も返す。
 */
import * as THREE from 'three';
import type { ExteriorItem, ExteriorKind } from '../core/types';
import { MeshBuilder, V } from './meshBuilder';

export const EXTERIOR_LABEL: Record<ExteriorKind, string> = {
  tree: '庭木（株立ち）',
  shrub: '低木',
  car: '車',
  fence: 'フェンス（木ルーバー）',
  bbq: 'BBQ グリル',
  bench: 'ベンチ',
  bicycle: '自転車',
  shed: '物置',
  post: 'ポスト',
  planter: 'プランター',
  light: '庭園灯',
};

/** 置くときの既定（高さ・長さ） */
export const EXTERIOR_DEFAULTS: Record<ExteriorKind, { h?: number; len?: number }> = {
  tree: { h: 3.6 },
  shrub: {},
  car: {},
  fence: { h: 1.2, len: 3.0 },
  bbq: {},
  bench: { len: 1.5 },
  bicycle: {},
  shed: { h: 2.1, len: 1.8 },
  post: {},
  planter: { len: 0.9 },
  light: { h: 0.8 },
};

/** 平面図の外形（m）: 幅 w（向きに沿う）× 奥行 d。木・低木は半径 */
export function exteriorFootprint(it: ExteriorItem): { w: number; d: number; r?: number } {
  switch (it.kind) {
    case 'tree':
      return { w: 0, d: 0, r: (it.h ?? 3.6) * 0.26 };
    case 'shrub':
      return { w: 0, d: 0, r: 0.45 };
    case 'car':
      return { w: 4.6, d: 1.8 };
    case 'fence':
      return { w: it.len ?? 3, d: 0.12 };
    case 'bbq':
      return { w: 1.2, d: 0.6 };
    case 'bench':
      return { w: it.len ?? 1.5, d: 0.5 };
    case 'bicycle':
      return { w: 1.75, d: 0.5 };
    case 'shed':
      return { w: it.len ?? 1.8, d: 0.9 };
    case 'post':
      return { w: 0.4, d: 0.3 };
    case 'planter':
      return { w: it.len ?? 0.9, d: 0.4 };
    case 'light':
      return { w: 0.2, d: 0.2 };
  }
}

/** 局所座標（u = 向きに沿う、v = 向きの左手側）で箱・円柱を置くための小さな枠 */
class Fr {
  readonly along: THREE.Vector3;
  readonly side: THREE.Vector3;
  constructor(
    readonly mb: MeshBuilder,
    readonly origin: THREE.Vector3,
    rotDeg: number,
  ) {
    const r = (rotDeg * Math.PI) / 180;
    this.along = V(Math.cos(r), 0, Math.sin(r));
    this.side = V(-Math.sin(r), 0, Math.cos(r));
  }
  p(u: number, v: number, y: number) {
    return this.origin.clone().addScaledVector(this.along, u).addScaledVector(this.side, v).setY(y);
  }
  box(key: string, u: number, v: number, w: number, d: number, y0: number, h: number) {
    this.mb.box(key, this.p(u, v, y0), this.along, w, h, d);
  }
  cyl(key: string, u: number, v: number, r: number, y0: number, h: number, seg = 14) {
    this.mb.cylinder(key, this.p(u, v, y0), r, h, seg);
  }
}

/**
 * 木・低木以外の物を作る。戻り値は作ったか（木・低木は false → 外構側で植える）
 */
export function buildExteriorObject(mb: MeshBuilder, it: ExteriorItem): boolean {
  const o = V(it.x / 1000, 0, it.y / 1000);
  const fr = new Fr(mb, o, it.rot);
  switch (it.kind) {
    case 'tree':
    case 'shrub':
      return false;
    case 'car': {
      // 乗用車（SUV 寄り）: 車体・キャビン・窓・タイヤ。色はチャコール
      const body = 'x.carBody';
      fr.box(body, 0, 0, 4.6, 1.8, 0.3, 0.55);
      fr.box(body, -0.2, 0, 2.6, 1.7, 0.85, 0.02);
      fr.box('x.carGlass', -0.2, 0, 2.5, 1.62, 0.85, 0.55);
      fr.box(body, -0.2, 0, 2.5, 1.66, 1.4, 0.06);
      for (const du of [-1.45, 1.45]) for (const dv of [-0.82, 0.82]) {
        const c = fr.p(du, dv, 0.33);
        // タイヤ（横向きの円柱）
        const geo = new THREE.CylinderGeometry(0.33, 0.33, 0.22, 18);
        const m = new THREE.Matrix4().makeBasis(fr.along, fr.side, new THREE.Vector3().crossVectors(fr.along, fr.side)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
        m.setPosition(c);
        mb.addGeometry('x.tire', geo, m);
        geo.dispose();
      }
      // ライト
      for (const dv of [-0.6, 0.6]) fr.box('x.lamp', 2.29, dv, 0.04, 0.3, 0.6, 0.12);
      return true;
    }
    case 'fence': {
      // 木の縦ルーバーのフェンス（御社の事例: ブロックの基礎＋木の縦格子）。(x, y) から向きへ len
      const L = it.len ?? 3;
      const H = it.h ?? 1.2;
      fr.box('l.block', L / 2, 0, L, 0.12, 0, 0.3);
      const n = Math.floor(L / 0.12);
      for (let i = 0; i < n; i += 2) fr.box('l.fenceWood', (i + 0.5) * 0.12, 0, 0.09, 0.02, 0.3, H - 0.3);
      fr.box('l.fenceWood', L / 2, 0, L, 0.05, H - 0.04, 0.04);
      fr.box('l.fenceWood', L / 2, 0, L, 0.05, 0.32, 0.04);
      return true;
    }
    case 'bbq': {
      // BBQ グリル（蓋付き・脚・サイドテーブル）
      fr.box('x.steel', 0, 0, 0.6, 0.5, 0.75, 0.25);
      fr.box('x.steel', 0, 0, 0.58, 0.48, 1.0, 0.03);
      fr.box('x.steelDark', 0, 0, 0.6, 0.5, 1.0, 0.18);
      for (const du of [-0.25, 0.25]) for (const dv of [-0.2, 0.2]) fr.cyl('x.steelDark', du, dv, 0.015, 0, 0.75, 8);
      fr.box('f.wood', -0.45, 0, 0.3, 0.45, 0.78, 0.03);
      fr.box('f.wood', 0.45, 0, 0.3, 0.45, 0.78, 0.03);
      fr.cyl('x.steel', 0.18, 0, 0.006, 1.18, 0.02, 6);
      return true;
    }
    case 'bench': {
      const L = it.len ?? 1.5;
      fr.box('f.wood', 0, 0, L, 0.45, 0.42, 0.05);
      for (const du of [-L / 2 + 0.1, L / 2 - 0.1]) fr.box('x.steelDark', du, 0, 0.05, 0.4, 0, 0.42);
      return true;
    }
    case 'bicycle': {
      // 自転車: 2 つの車輪（薄い円柱）とフレーム（細い箱）、サドル、ハンドル
      for (const du of [-0.55, 0.55]) {
        const c = fr.p(du, 0, 0.34);
        const geo = new THREE.CylinderGeometry(0.34, 0.34, 0.03, 20);
        const m = new THREE.Matrix4().makeBasis(fr.along, fr.side, new THREE.Vector3().crossVectors(fr.along, fr.side)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
        m.setPosition(c);
        mb.addGeometry('x.tire', geo, m);
        geo.dispose();
      }
      mb.tube('x.steelDark', fr.p(-0.55, 0, 0.34), fr.p(0.05, 0, 0.75), 0.015);
      mb.tube('x.steelDark', fr.p(0.05, 0, 0.75), fr.p(0.5, 0, 0.9), 0.015);
      mb.tube('x.steelDark', fr.p(0.05, 0, 0.75), fr.p(0.1, 0, 0.38), 0.015);
      mb.tube('x.steelDark', fr.p(0.1, 0, 0.38), fr.p(0.55, 0, 0.34), 0.015);
      mb.tube('x.steelDark', fr.p(0.1, 0, 0.38), fr.p(0.45, 0, 0.9), 0.015);
      fr.box('f.handle', -0.05, 0, 0.25, 0.1, 0.85, 0.05);
      fr.box('x.steelDark', 0.5, 0, 0.03, 0.5, 0.95, 0.025);
      fr.cyl('x.steelDark', 0.5, 0, 0.012, 0.6, 0.35, 6);
      return true;
    }
    case 'shed': {
      // 物置（スチール・グレー。片流れの薄い屋根）
      const W = it.len ?? 1.8;
      const H = it.h ?? 2.1;
      fr.box('x.shed', 0, 0, W, 0.9, 0.05, H - 0.05);
      fr.box('x.shedRoof', 0, 0, W + 0.1, 1.0, H, 0.06);
      fr.box('f.handle', 0, -0.46, 0.012, 0.012, 0.3, H - 0.6);
      return true;
    }
    case 'post': {
      // ポスト（黒い箱を細い柱に）
      fr.cyl('x.steelDark', 0, 0, 0.03, 0, 1.0, 8);
      fr.box('x.steelDark', 0, 0, 0.38, 0.28, 1.0, 0.36);
      fr.box('x.steel', 0, -0.141, 0.3, 0.01, 1.2, 0.03);
      return true;
    }
    case 'planter': {
      const L = it.len ?? 0.9;
      fr.box('l.block', 0, 0, L, 0.4, 0, 0.4);
      fr.box('l.soilDark', 0, 0, L - 0.06, 0.34, 0.4, 0.01);
      // 葉（小さな球をいくつか）
      for (let i = 0; i < Math.max(2, Math.round(L / 0.3)); i++) mb.sphere('l.leafDark', fr.p(-L / 2 + 0.15 + i * 0.3, (i % 2 ? 0.06 : -0.06), 0.55), 0.16, 8, 0.8);
      return true;
    }
    case 'light': {
      const H = it.h ?? 0.8;
      fr.cyl('x.steelDark', 0, 0, 0.025, 0, H, 8);
      fr.box('x.steelDark', 0, 0, 0.14, 0.14, H, 0.05);
      fr.box('x.lamp', 0, 0, 0.1, 0.1, H - 0.08, 0.08);
      return true;
    }
  }
}
