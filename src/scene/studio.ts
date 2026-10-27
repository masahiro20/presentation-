/**
 * 写真品質の代替描画（GPU のパストレーシングが完了できない環境向け）
 *
 * 通常の描画（ラスタライズ）を、提案用に最大限まで引き上げて1枚を仕上げる:
 * - 実写の空（HDRI）を背景に使い、太陽の方位を日照の設定に合わせる
 * - 大きな影の解像度・柔らかい影・環境遮蔽（GTAO）
 * - 2倍の解像度で描いて縮小（ジャギーを消す）
 * - 写真的なトーン仕上げ
 * パストレーシングより軽く、どのパソコンでもほぼ確実に完了する。
 */
import * as THREE from 'three';
import type { Viewer } from './viewer';
import { loadHdri } from './hdri';
import { finishPhoto } from './photoFinish';

export interface StudioOptions {
  width: number;
  height: number;
  exposure?: number;
  interior?: boolean;
}

const skyTexCache = new WeakMap<THREE.Texture, THREE.Texture>();
/** HDRI を貼った空の球。球の UV は正距円筒の向きと左右が逆なので、テクスチャを左右反転して貼る */
function skyDome(tex: THREE.Texture, rotY: number, intensity: number, radius: number): THREE.Mesh {
  let t = skyTexCache.get(tex);
  if (!t) {
    t = tex.clone();
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.x = -1;
    t.offset.x = 1;
    t.needsUpdate = true;
    skyTexCache.set(tex, t);
  }
  const mat = new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: true });
  mat.color.setScalar(intensity);
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 32), mat);
  m.rotation.y = rotY;
  m.frustumCulled = false;
  m.renderOrder = -1000;
  m.name = 'studioSky';
  return m;
}

export async function renderStudio(viewer: Viewer, opts: StudioOptions): Promise<string> {
  const renderer = viewer.renderer;
  const scene = viewer.scene;
  const night = viewer.design.timeOfDay === 'night';
  const max = renderer.capabilities.maxTextureSize;
  // 2倍で描いて縮小（GPU の上限を超えない範囲で）
  const ss = Math.max(1, Math.min(2, Math.floor(max / Math.max(opts.width, opts.height))));
  const W = opts.width * ss;
  const H = opts.height * ss;

  const prev = {
    bg: scene.background,
    bgI: scene.backgroundIntensity,
    bgRot: scene.backgroundRotation.clone(),
    exp: renderer.toneMappingExposure,
    shadowType: renderer.shadowMap.type,
    radius: viewer.sun.shadow.radius,
    lights: viewer.groups.lights.visible,
    hemi: viewer.hemi.intensity,
    env: scene.environmentIntensity,
  };
  let skyMesh: THREE.Mesh | null = null;
  try {
    const hdri = await loadHdri(viewer.design.timeOfDay);
    if (hdri) {
      // 背景だけを実写の空に（環境光はリアルタイム描画で確実に動く手続き的な空のまま。浮動小数のテクスチャを
      // 環境光に変換できない GPU があるため）。
      // three.js の scene.background（箱）は、建築写真の水平なカメラ（あおり補正）で空が真っ青な塊になる不具合があるので、
      // カメラを包む大きな球に貼って描く（普通の形なので、どんなカメラでも正しく写る）
      const sd = viewer.sunDir;
      const rot = hdri.sunAzimuth - (night ? 0 : Math.atan2(sd.z, sd.x));
      const intensity = Math.min(4, (night ? 0.45 : 1.1) / Math.max(0.02, hdri.irradiance / Math.PI));
      skyMesh = skyDome(hdri.texture, rot, intensity, viewer.camera.far * 0.5);
      skyMesh.position.copy(viewer.camera.position);
      scene.add(skyMesh);
      scene.background = null;
    }
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    viewer.sun.shadow.radius = 5;
    renderer.shadowMap.needsUpdate = true;
    // 室内の照明: 内観はもちろん、夜景の外観も点ける（窓の明かりが夜景の主役）
    if (opts.interior || night) viewer.groups.lights.visible = true;
    if (night && !opts.interior) {
      // 夜景の外観: 建物が真っ黒な影になっていた。空の残光と街の明かりの分だけ周囲光を足し、外壁の形が読めるようにする
      viewer.hemi.intensity = 0.35;
      scene.environmentIntensity = 0.6;
    }
    renderer.toneMappingExposure = (opts.exposure ?? 1) * (opts.interior ? 0.75 : 0.95);
    const url = await viewer.capture(W, H, 'image/png');
    // 縮小して写真の仕上げ
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = opts.width;
    c.height = opts.height;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, opts.width, opts.height);
    return finishPhoto(c, { interior: !!opts.interior, tod: viewer.design.timeOfDay });
  } finally {
    if (skyMesh) scene.remove(skyMesh);
    scene.background = prev.bg;
    scene.backgroundIntensity = prev.bgI;
    scene.backgroundRotation.copy(prev.bgRot);
    renderer.toneMappingExposure = prev.exp;
    renderer.shadowMap.type = prev.shadowType;
    viewer.sun.shadow.radius = prev.radius;
    renderer.shadowMap.needsUpdate = true;
    viewer.groups.lights.visible = prev.lights;
    viewer.hemi.intensity = prev.hemi;
    scene.environmentIntensity = prev.env;
    viewer.invalidate();
  }
}
