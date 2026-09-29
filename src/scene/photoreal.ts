/**
 * 写真品質レンダリング（GPU パストレーシング）
 * 大域照明・柔らかい影・映り込みを物理的に計算する。数十秒〜数分で収束。
 */
import * as THREE from 'three';
import { WebGLPathTracer, DenoiseMaterial } from 'three-gpu-pathtracer';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { Viewer } from './viewer';

export interface PhotorealOptions {
  width: number;
  height: number;
  samples: number;
  /** 最大時間 (ms) */
  timeLimit?: number;
  bounces?: number;
  onProgress?: (samples: number, total: number, preview?: () => string) => void;
  signal?: AbortSignal;
  /** 露出（室内は写真と同じく室内に合わせて明るめに） */
  exposure?: number;
}

interface Saved {
  mat: THREE.Material;
  props: Record<string, unknown>;
}

/** パストレース用にマテリアルを物理的な値へ一時変更 */
function prepareMaterials(root: THREE.Object3D): Saved[] {
  const saved: Saved[] = [];
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (!m || seen.has(m)) return;
    seen.add(m);
    const sm = m as THREE.MeshPhysicalMaterial;
    const props: Record<string, unknown> = { envMapIntensity: sm.envMapIntensity };
    if (m.userData.isGlass) {
      Object.assign(props, { transparent: sm.transparent, opacity: sm.opacity, transmission: sm.transmission, roughness: sm.roughness, color: sm.color.clone(), depthWrite: sm.depthWrite });
      const frosted = sm.roughness > 0.2;
      sm.transparent = false;
      sm.opacity = 1;
      sm.transmission = 1;
      sm.roughness = frosted ? 0.35 : 0.0;
      sm.ior = 1.5;
      sm.color.set(frosted ? '#f2f4f5' : '#f4f8f7');
      (sm as unknown as { thickness: number }).thickness = 0;
    }
    if ('envMapIntensity' in sm) sm.envMapIntensity = 1;
    saved.push({ mat: m, props });
  });
  return saved;
}

function restoreMaterials(saved: Saved[]) {
  for (const s of saved) Object.assign(s.mat, s.props);
}

export async function renderPhotoreal(viewer: Viewer, opts: PhotorealOptions): Promise<string> {
  const renderer = viewer.renderer;
  const scene = viewer.scene;
  const camera = viewer.camera;
  const prevSize = renderer.getSize(new THREE.Vector2());
  const prevPR = renderer.getPixelRatio();
  const prevAspect = camera.aspect;
  viewer.pause(true);

  renderer.setPixelRatio(1);
  renderer.setSize(opts.width, opts.height, false);
  camera.aspect = opts.width / opts.height;
  camera.updateProjectionMatrix();

  // 空（パストレーサーは正距円筒の HDR をそのまま光源として使う）
  const prevEnv = scene.environment;
  const prevBg = scene.background;
  const prevEnvI = scene.environmentIntensity;
  const night = viewer.design.timeOfDay === 'night';
  const sky = viewer.getSkyTexture(false);
  scene.environment = sky;
  scene.background = sky;
  scene.environmentIntensity = night ? 0.4 : 1.0;
  // 昼の補助光（室内の擬似間接光）は不要
  const lightVis = viewer.groups.lights.visible;
  if (!night) viewer.groups.lights.visible = false;
  const hemiVis = viewer.hemi.visible;
  viewer.hemi.visible = false;
  const sunI = viewer.sun.intensity;
  viewer.sun.intensity = sunI * 1.15;
  const prevExposure = renderer.toneMappingExposure;
  if (opts.exposure) renderer.toneMappingExposure = opts.exposure;
  const saved = prepareMaterials(scene);

  const pt = new WebGLPathTracer(renderer);
  pt.bounces = opts.bounces ?? 6;
  pt.transmissiveBounces = 6;
  pt.filterGlossyFactor = 0.5;
  pt.minSamples = 1;
  pt.renderDelay = 0;
  pt.fadeDuration = 0;
  pt.tiles.set(2, 2);
  pt.renderToCanvas = false;
  pt.multipleImportanceSampling = true;
  (pt as unknown as { dynamicLowRes: boolean }).dynamicLowRes = false;
  pt.setScene(scene, camera);

  const quad = new FullScreenQuad(new THREE.MeshBasicMaterial({ transparent: false }));
  const denoise = new DenoiseMaterial({ sigma: 2.2, threshold: 0.08, kSigma: 1 });
  const present = (useDenoise: boolean) => {
    const mat = useDenoise ? denoise : (quad.material as THREE.MeshBasicMaterial);
    if (useDenoise) (denoise as unknown as { map: THREE.Texture }).map = pt.target.texture;
    else (mat as THREE.MeshBasicMaterial).map = pt.target.texture;
    quad.material = mat;
    renderer.setRenderTarget(null);
    renderer.autoClear = true;
    quad.render(renderer);
  };

  const t0 = performance.now();
  const limit = opts.timeLimit ?? 180000;
  try {
    while (pt.samples < opts.samples) {
      if (opts.signal?.aborted) throw new DOMException('中止しました', 'AbortError');
      pt.renderSample();
      if (Math.floor(pt.samples) % 4 === 0) {
        opts.onProgress?.(Math.floor(pt.samples), opts.samples, () => {
          present(false);
          return renderer.domElement.toDataURL('image/jpeg', 0.7);
        });
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      if (performance.now() - t0 > limit) break;
    }
    present(true);
    return finishPhoto(renderer.domElement);
  } finally {
    pt.dispose();
    quad.dispose();
    denoise.dispose();
    restoreMaterials(saved);
    sky.dispose();
    scene.environment = prevEnv;
    scene.background = prevBg;
    scene.environmentIntensity = prevEnvI;
    viewer.groups.lights.visible = lightVis;
    viewer.hemi.visible = hemiVis;
    viewer.sun.intensity = sunI;
    renderer.toneMappingExposure = prevExposure;
    renderer.setPixelRatio(prevPR);
    renderer.setSize(prevSize.x, prevSize.y, false);
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();
    viewer.pause(false);
    viewer.resize();
  }
}

/** 写真としての仕上げ: ごく弱い周辺減光とトーンカーブ */
export function finishPhoto(src: HTMLCanvasElement, opts: { vignette?: number; contrast?: number } = {}): string {
  const w = src.width;
  const h = src.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const k = opts.contrast ?? 0.06;
  // S字カーブ（中間調を少し締める）
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    const s = x + k * Math.sin((x - 0.5) * Math.PI * 2) * -0.5 * Math.sin(x * Math.PI);
    lut[i] = Math.round(Math.max(0, Math.min(1, s)) * 255);
  }
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
  ctx.putImageData(img, 0, 0);
  const v = opts.vignette ?? 0.14;
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.62);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${v})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.95);
}
