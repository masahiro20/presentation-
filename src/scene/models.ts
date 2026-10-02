/**
 * 実物の 3D モデル（Poly Haven・CC0。public/models）の読み込みと配置
 * 観葉植物・ラウンジチェアなど、手続き的な形状では質感の出ない小物に使う。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ModelPlacement } from './furniture';

const cache = new Map<string, Promise<THREE.Object3D | null>>();

function loadModel(id: string): Promise<THREE.Object3D | null> {
  let p = cache.get(id);
  if (!p) {
    p = (async () => {
      try {
        const url = new URL(`models/${id}/${id}.gltf`, document.baseURI).toString();
        const gltf = await new GLTFLoader().loadAsync(url);
        const root = gltf.scene;
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.castShadow = true;
            m.receiveShadow = true;
          }
        });
        return root;
      } catch (e) {
        console.warn('3D モデルを読み込めませんでした', id, e);
        return null;
      }
    })();
    cache.set(id, p);
  }
  return p;
}

/** 置き場所に合わせてモデルを複製・配置する（床に接地、高さを合わせる） */
export async function placeModels(list: ModelPlacement[], group: THREE.Group, isCurrent: () => boolean = () => true): Promise<number> {
  let n = 0;
  for (const pl of list) {
    const src = await loadModel(pl.id);
    if (!isCurrent()) return n;
    if (!src) continue;
    const o = src.clone(true);
    const box = new THREE.Box3().setFromObject(o);
    const h = box.max.y - box.min.y;
    const k = h > 0 ? pl.height / h : 1;
    o.scale.setScalar(k);
    o.rotation.y = pl.rotY;
    const c = box.getCenter(new THREE.Vector3());
    // 底面の中心を置き場所に（回転の中心も置き場所）
    const pivot = new THREE.Group();
    pivot.position.copy(pl.pos);
    o.position.set(-c.x * k, pl.pos.y - box.min.y * k - pl.pos.y, -c.z * k);
    pivot.rotation.y = pl.rotY;
    o.rotation.y = 0;
    pivot.add(o);
    pivot.userData.model = pl.id;
    group.add(pivot);
    n++;
  }
  return n;
}
