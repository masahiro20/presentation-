/**
 * 家具の接地影（コンタクトシャドウ）。
 * 室内の家具は屋根の下にあって太陽の影が落ちず、閲覧モードでは AO も掛けないので床から浮いて見える。
 * 足元に柔らかい暗がりの板を 1 枚置くだけで「置いてある」感が出る（実時間の建築 CG で常套の手法）。
 */
import * as THREE from 'three';
import type { Footprint } from './furniture';

let tex: THREE.Texture | null = null;

/** 角の丸い四角の、縁に向かって消える影の画像（1 枚を全家具で使い回す） */
function shadowTexture(): THREE.Texture {
  if (tex) return tex;
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  const inset = 0.24;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) / N;
      const y = (j + 0.5) / N;
      const dx = Math.max(0, Math.abs(x - 0.5) - (0.5 - inset)) / inset;
      const dy = Math.max(0, Math.abs(y - 0.5) - (0.5 - inset)) / inset;
      const d = Math.min(1, Math.hypot(dx, dy));
      const s = d * d * (3 - 2 * d);
      const a = Math.pow(1 - s, 1.6);
      const k = (j * N + i) * 4;
      data[k] = 0;
      data[k + 1] = 0;
      data[k + 2] = 0;
      data[k + 3] = Math.round(a * 255);
    }
  }
  tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

let geo: THREE.PlaneGeometry | null = null;
let mat: THREE.MeshBasicMaterial | null = null;

/**
 * 床に接している家具（底が床から 15cm 以内・高さ 30cm 以上・大きすぎない）の足元に影の板を置く。
 * roomIds を渡すとその部屋の家具だけ（輪切り模型用）。
 */
export function contactShadows(occ: Map<string, Footprint[]>, roomIds?: Set<string>): THREE.Group {
  const g = new THREE.Group();
  g.name = 'contactShadows';
  if (!geo) {
    geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
  }
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, opacity: 0.38, depthWrite: false, color: '#000000', polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    mat.name = 'contactShadow';
  }
  for (const [roomId, fps] of occ) {
    if (roomIds && !roomIds.has(roomId)) continue;
    for (const fp of fps) {
      if (fp.baseY == null) continue;
      const h = fp.maxY - fp.baseY;
      const w = fp.maxX - fp.minX;
      const d = fp.maxZ - fp.minZ;
      if (h < 0.3 || w < 0.2 || d < 0.2 || w * d > 9) continue;
      // 影の広がり: 低くて大きい物ほど縁が短く、脚物は少し広く
      const pad = Math.min(0.22, 0.08 + 0.12 * Math.min(1, h / 0.8));
      const m = new THREE.Mesh(geo, mat);
      m.position.set((fp.minX + fp.maxX) / 2, fp.baseY + 0.004, (fp.minZ + fp.maxZ) / 2);
      m.scale.set(w + pad * 2, 1, d + pad * 2);
      m.renderOrder = 2;
      m.castShadow = false;
      m.receiveShadow = false;
      m.userData.decal = true;
      g.add(m);
    }
  }
  return g;
}
