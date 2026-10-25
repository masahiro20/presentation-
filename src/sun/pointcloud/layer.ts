/**
 * 点群の 3D 表示（点）と、点群から見つけた樹木（影を落とし、日照の解析にも入る）。
 *
 * 置き方: 点・木は東・北・地面からの高さ（x = 東, y = 上, z = −北）で持ち、グループの行列で日照ステップのワールドへ置く
 * （SunContext.toWorld と同じ。建設地の微調整・真北の角度が変わっても行列を差し替えるだけ）。
 * 地面からの高さにするので、坂の点群も平らな地面（y = 0）の周辺建物とそろう。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { groundAt, pointInRing, type CloudTree, type GroundGrid } from './fit';
import type { EN } from '../plateau/types';
import type { SiteCloud } from './place';

/** 画面に出す点の上限（多いと重い。解析には使わないので間引いてよい） */
const MAX_DRAW = 700_000;

export class PointCloudLayer {
  readonly group = new THREE.Group();
  private points: THREE.Points | null = null;
  private trees: THREE.Mesh | null = null;
  treeCount = 0;

  constructor() {
    this.group.name = 'point-cloud';
    this.group.matrixAutoUpdate = false;
  }

  /** 東・北・上 → ワールド（toWorld(e, n, y) と同じ） */
  setFrame(toWorld: (e: number, n: number, y?: number) => THREE.Vector3) {
    const o = toWorld(0, 0, 0);
    const ex = toWorld(1, 0, 0).sub(o);
    const en = toWorld(0, 1, 0).sub(o);
    // 局所 (x = 東, y = 上, z = −北) → ワールド
    this.group.matrix.makeBasis(ex, new THREE.Vector3(0, 1, 0), en.negate()).setPosition(o);
    this.group.matrixWorldNeedsUpdate = true;
  }

  /** exclude: 計画地（建て替える敷地）。中の点（今の家・庭木）は出さない */
  setPoints(c: SiteCloud, ground: GroundGrid, exclude: EN[] | null = null) {
    this.clearPoints();
    const step = Math.max(1, Math.ceil(c.count / MAX_DRAW));
    const n = Math.ceil(c.count / step);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    let k = 0;
    let hMax = 1;
    const hs = new Float32Array(n);
    const idx = new Int32Array(n);
    for (let i = 0; i < c.count; i += step) {
      if (exclude && pointInRing(c.e[i], c.n[i], exclude)) continue;
      const h = c.z[i] - groundAt(ground, c.e[i], c.n[i]);
      idx[k] = i;
      hs[k] = h;
      if (h > hMax) hMax = h;
      pos[k * 3] = c.e[i];
      pos[k * 3 + 1] = Math.max(0.02, h);
      pos[k * 3 + 2] = -c.n[i];
      k++;
    }
    const tmp = new THREE.Color();
    for (let j = 0; j < k; j++) {
      const i = idx[j];
      if (c.rgb) tmp.setRGB(c.rgb[i * 3] / 255, c.rgb[i * 3 + 1] / 255, c.rgb[i * 3 + 2] / 255, THREE.SRGBColorSpace);
      else {
        // 色の無い点群: 高さで色分け（地面 = 灰、低い = 青緑、高い = 橙）
        const t = Math.min(1, Math.max(0, hs[j] / Math.min(30, hMax)));
        tmp.setHSL(0.55 - 0.5 * t, hs[j] < 0.5 ? 0.05 : 0.65, hs[j] < 0.5 ? 0.62 : 0.55);
      }
      col[j * 3] = tmp.r;
      col[j * 3 + 1] = tmp.g;
      col[j * 3 + 2] = tmp.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, k * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, k * 3), 3));
    geo.computeBoundingSphere();
    const mat = new THREE.PointsMaterial({ size: 0.35, vertexColors: true, sizeAttenuation: true });
    this.points = new THREE.Points(geo, mat);
    this.points.name = 'point-cloud-points';
    // 点は影・解析に入れない
    this.points.userData.noShadow = true;
    this.points.castShadow = false;
    this.points.frustumCulled = false;
    this.group.add(this.points);
  }

  /** 木: 幹（円柱）と樹冠（つぶした多面体の球）。影を落とし、日照の解析の遮蔽物（userData.neighbor）にも入る */
  setTrees(trees: CloudTree[]) {
    this.clearTrees();
    this.treeCount = trees.length;
    if (!trees.length) return;
    const parts: THREE.BufferGeometry[] = [];
    for (const t of trees) {
      const crownH = Math.max(1, t.height - t.crownBase);
      const crown = new THREE.IcosahedronGeometry(1, 1);
      crown.scale(t.radius, crownH / 2, t.radius);
      crown.translate(t.e, t.crownBase + crownH / 2, -t.n);
      const trunk = new THREE.CylinderGeometry(0.12, 0.16, t.crownBase + 0.3, 6);
      trunk.translate(t.e, (t.crownBase + 0.3) / 2, -t.n);
      parts.push(crown.toNonIndexed(), trunk.toNonIndexed());
      crown.dispose();
      trunk.dispose();
    }
    const geo = mergeGeometries(parts.map((g) => {
      g.deleteAttribute('uv');
      return g;
    }));
    for (const g of parts) g.dispose();
    if (!geo) return;
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#6f8f5a', roughness: 0.95, flatShading: true }));
    mesh.name = 'point-cloud-trees';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.neighbor = true;
    mesh.userData.lidarTree = true;
    this.trees = mesh;
    this.group.add(mesh);
  }

  setVisible(points: boolean, trees: boolean) {
    if (this.points) this.points.visible = points;
    if (this.trees) this.trees.visible = trees;
  }

  get hasPoints(): boolean {
    return !!this.points;
  }

  private clearPoints() {
    if (!this.points) return;
    this.group.remove(this.points);
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.points = null;
  }

  private clearTrees() {
    if (!this.trees) return;
    this.group.remove(this.trees);
    this.trees.geometry.dispose();
    (this.trees.material as THREE.Material).dispose();
    this.trees = null;
    this.treeCount = 0;
  }

  clear() {
    this.clearPoints();
    this.clearTrees();
  }
}
