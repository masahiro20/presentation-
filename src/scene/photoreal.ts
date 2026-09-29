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
  /** GPU の負荷を下げた安全モード（再試行用） */
  safe?: boolean;
  onStatus?: (msg: string) => void;
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

/** 写真品質レンダリングの失敗理由（真っ黒な画像を保存しないために区別する） */
export class PhotorealError extends Error {
  constructor(
    message: string,
    readonly reason: 'context-lost' | 'shader' | 'no-samples' | 'black',
  ) {
    super(message);
    this.name = 'PhotorealError';
  }
}

/** GPU の処理完了を待つ（WebGL2 のフェンス）。重い処理を一度に積んで GPU がリセットされるのを防ぐ */
async function gpuWait(gl: WebGL2RenderingContext, isLost: () => boolean, maxMs = 30000) {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return;
  gl.flush();
  const t0 = performance.now();
  try {
    for (;;) {
      if (isLost()) return;
      const r = gl.clientWaitSync(sync, 0, 0);
      if (r === gl.ALREADY_SIGNALED || r === gl.CONDITION_SATISFIED || r === gl.WAIT_FAILED) return;
      if (performance.now() - t0 > maxMs) return;
      await new Promise((res) => setTimeout(res, 4));
    }
  } finally {
    gl.deleteSync(sync);
  }
}

/** 画像の平均輝度（0〜255） */
function meanLuma(src: HTMLCanvasElement): number {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 36;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return sum / (d.length / 4);
}

export async function renderPhotoreal(viewer: Viewer, opts: PhotorealOptions): Promise<string> {
  const renderer = viewer.renderer;
  const scene = viewer.scene;
  const camera = viewer.camera;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const canvas = renderer.domElement;
  const prevSize = renderer.getSize(new THREE.Vector2());
  const prevPR = renderer.getPixelRatio();
  const prevAspect = camera.aspect;
  viewer.pause(true);

  // GPU のリセット（コンテキストロス）とシェーダーのコンパイル失敗を検知
  let lost = false;
  const onLost = () => {
    lost = true;
  };
  canvas.addEventListener('webglcontextlost', onLost);
  let shaderFailed = false;
  const prevOnShaderError = renderer.debug.onShaderError;
  renderer.debug.onShaderError = (glc, program, vs, fs) => {
    shaderFailed = true;
    console.error('写真品質レンダリング: シェーダーのコンパイルに失敗しました', glc.getProgramInfoLog(program), glc.getShaderInfoLog(fs));
  };

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
  // 1回の描画を小さな区画（タイル）に分け、GPU の負荷を細かく刻む
  const tileBase = opts.safe ? 240 : 400;
  const tiles = new THREE.Vector2(Math.max(1, Math.ceil(opts.width / tileBase)), Math.max(1, Math.ceil(opts.height / tileBase)));
  pt.tiles.copy(tiles);
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

  const check = () => {
    if (opts.signal?.aborted) throw new DOMException('中止しました', 'AbortError');
    if (lost) throw new PhotorealError('GPU がリセットされました（処理が重すぎた可能性があります）', 'context-lost');
    if (shaderFailed) throw new PhotorealError('このパソコンの GPU では写真品質の計算プログラムを準備できませんでした', 'shader');
  };

  const limit = opts.timeLimit ?? 240000;
  try {
    // シェーダーの準備（Windows では初回に時間がかかることがある）
    const tc = performance.now();
    while (pt.samples === 0) {
      check();
      pt.renderSample();
      await gpuWait(gl, () => lost);
      if (pt.samples > 0) break;
      opts.onStatus?.('GPU の準備中（初回は1〜2分かかることがあります）');
      if (performance.now() - tc > 300000) throw new PhotorealError('GPU の準備が終わりませんでした', 'no-samples');
      await new Promise((r) => setTimeout(r, 30));
    }

    const t0 = performance.now();
    let batch = 1;
    let lastUi = 0;
    let lastPreview = t0;
    while (pt.samples < opts.samples) {
      check();
      const tb = performance.now();
      for (let i = 0; i < batch && pt.samples < opts.samples; i++) pt.renderSample();
      await gpuWait(gl, () => lost);
      const perTile = (performance.now() - tb) / batch;
      // 1回あたり 30〜60ms 程度に収まるよう、まとめて描く枚数とタイルの細かさを調整
      if (perTile > 150 && Number.isInteger(pt.samples) && pt.tiles.x * pt.tiles.y < 256) {
        pt.tiles.set(pt.tiles.x * 2, pt.tiles.y * 2);
      }
      batch = Math.max(1, Math.min(32, Math.floor(45 / Math.max(1, perTile))));
      const now = performance.now();
      if (now - lastUi > 250) {
        lastUi = now;
        const wantPreview = now - lastPreview > 6000;
        if (wantPreview) lastPreview = now;
        opts.onProgress?.(Math.floor(pt.samples), opts.samples, wantPreview ? () => {
          present(false);
          return renderer.domElement.toDataURL('image/jpeg', 0.7);
        } : undefined);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      if (now - t0 > limit) break;
    }
    check();
    if (pt.samples < 1) throw new PhotorealError('計算が進みませんでした', 'no-samples');
    present(true);
    await gpuWait(gl, () => lost);
    check();
    const luma = meanLuma(canvas);
    if (luma < (night ? 1.5 : 4)) throw new PhotorealError(`画像が真っ黒になりました（平均輝度 ${luma.toFixed(1)}）`, 'black');
    return finishPhoto(canvas);
  } finally {
    canvas.removeEventListener('webglcontextlost', onLost);
    renderer.debug.onShaderError = prevOnShaderError;
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
