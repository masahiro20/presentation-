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
import { finishPhoto } from './photoreal';

export interface StudioOptions {
  width: number;
  height: number;
  exposure?: number;
  interior?: boolean;
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
  };
  try {
    const hdri = await loadHdri(viewer.design.timeOfDay);
    if (hdri) {
      // 背景だけを実写の空に（環境光はリアルタイム描画で確実に動く手続き的な空のまま。浮動小数のテクスチャを
      // 環境光に変換できない GPU があるため）
      const sd = viewer.sunDir;
      const rot = hdri.sunAzimuth - (night ? 0 : Math.atan2(sd.z, sd.x));
      scene.background = hdri.texture;
      scene.backgroundRotation.set(0, rot, 0);
      scene.backgroundIntensity = Math.min(4, (night ? 0.3 : 1.1) / Math.max(0.02, hdri.irradiance / Math.PI));
    }
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    viewer.sun.shadow.radius = 5;
    renderer.shadowMap.needsUpdate = true;
    if (opts.interior) viewer.groups.lights.visible = true;
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
    return finishPhoto(c, { contrast: 0.08, vignette: 0.16 });
  } finally {
    scene.background = prev.bg;
    scene.backgroundIntensity = prev.bgI;
    scene.backgroundRotation.copy(prev.bgRot);
    renderer.toneMappingExposure = prev.exp;
    renderer.shadowMap.type = prev.shadowType;
    viewer.sun.shadow.radius = prev.radius;
    renderer.shadowMap.needsUpdate = true;
    viewer.groups.lights.visible = prev.lights;
    viewer.invalidate();
  }
}
