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

/** 内観の標準の露出の指定（draftCapture の exposureFor） */
const INTERIOR_EXPOSURE = 1.6;

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
  // 画面用の空の球があると実写の空（こちらの球）を隠すので、描く間だけ外す
  const hadDome = viewer.hasSkyDome();
  try {
    // 画面がすでに実写の空（球）で描いているときは、それをそのまま使う
    const hdri = (await viewer.ensurePhotoSky()) ? null : await loadHdri(viewer.design.timeOfDay);
    if (hdri && hadDome) viewer.useSkyDome(false);
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
    viewer.invalidate(); // 影の描き直し（描く直前に needsUpdate が立つ）
    // 室内の照明: 内観はもちろん、夜景の外観も点ける（窓の明かりが夜景の主役）
    if (opts.interior || night) viewer.groups.lights.visible = true;
    // 照明を点けた状態の光の配分に（内観は、窓からの面の光で明暗を付け、均一な光を抑える）
    viewer.refreshLightBalance();
    // 光のにじみ・階調は、下の写真仕上げ（finishPhoto）が掛ける。画面用の後処理と二重にしない
    viewer.setScreenFinish(false);
    if (night && !opts.interior) {
      // 夜景の外観: 建物が真っ黒な影になっていた。空の残光と街の明かりの分だけ周囲光を足し、外壁の形が読めるようにする
      viewer.hemi.intensity = 0.35;
      scene.environmentIntensity = 0.6;
    }
    // 内観の露出: 壁の明るさに合わせた倍率（濃い壁の家は上げる）に、呼び出し側の指定（内観の標準 1.6 を 1 とする）を掛ける
    // （夕景・夜景・スマホは今までどおり: 指定 × 0.75）
    const wallGain = viewer.interiorExposureGain();
    renderer.toneMappingExposure = !opts.interior ? (opts.exposure ?? 1) * 0.95 : wallGain > 0 ? wallGain * ((opts.exposure ?? INTERIOR_EXPOSURE) / INTERIOR_EXPOSURE) : (opts.exposure ?? 1) * 0.75;
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
    if (hadDome && !viewer.hasSkyDome()) viewer.useSkyDome(true);
    scene.background = prev.bg;
    scene.backgroundIntensity = prev.bgI;
    scene.backgroundRotation.copy(prev.bgRot);
    renderer.toneMappingExposure = prev.exp;
    renderer.shadowMap.type = prev.shadowType;
    viewer.sun.shadow.radius = prev.radius;
    viewer.groups.lights.visible = prev.lights;
    viewer.hemi.intensity = prev.hemi;
    scene.environmentIntensity = prev.env;
    viewer.setScreenFinish(true);
    viewer.refreshLightBalance();
    viewer.invalidate();
  }
}
