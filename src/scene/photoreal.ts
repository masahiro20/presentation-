/**
 * 写真品質レンダリング（GPU パストレーシング）
 * 大域照明・柔らかい影・映り込みを物理的に計算する。数十秒〜数分で収束。
 */
import * as THREE from 'three';
import { WebGLPathTracer, DenoiseMaterial } from 'three-gpu-pathtracer';
import { oidnDenoise } from './oidn';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { Viewer } from './viewer';
import { loadHdri, equirectIrradiance } from './hdri';
import { buildInteriorPhotoLights, buildExteriorLights } from './interiorLights';
import { interiorById, type TimeOfDay } from '../styles/presets';
import { interiorFor } from '../coordinate/catalog';
import { resolveSpec } from '../styles/spec';
import { kelvinToColor } from './viewer';

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
  /** GPU に載せるテクスチャ1枚の大きさ（全テクスチャを1つの配列にまとめるため、メモリに直結する） */
  textureSize?: number;
  onStatus?: (msg: string) => void;
  /** 実写の空（HDRI）を使う（既定: 使う。読み込めなければ手続き的な空） */
  hdri?: boolean;
  /** 内観（窓の面光源・照明の点灯・露出の自動調整） */
  interior?: boolean;
  /** 「ここで仕上げる」: 計算を打ち切り、その時点の画像で仕上げる */
  finish?: AbortSignal;
  /** AI ノイズ除去（OIDN・WebGPU）を使う（既定: 使える環境なら使う） */
  denoise?: boolean;
}

export interface Saved {
  mat: THREE.Material;
  props: Record<string, unknown>;
}

/** パストレース用にマテリアルを物理的な値へ一時変更 */
export function prepareMaterials(root: THREE.Object3D): Saved[] {
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

export function restoreMaterials(saved: Saved[]) {
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

/** 画像の輝度の分位点（0〜255） */
function lumaPercentile(src: HTMLCanvasElement, q: number): number {
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 54;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const v: number[] = [];
  for (let i = 0; i < d.length; i += 4) v.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
  v.sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(v.length * q))];
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
  // 検証用: ?ptfail で失敗させ、代替の高品質描画を確認する
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('ptfail')) throw new PhotorealError('検証用の失敗', 'shader');
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
  const tod = viewer.design.timeOfDay;
  const night = tod === 'night';
  const dusk = night || tod === 'evening';
  const sky = viewer.getSkyTexture(false);
  scene.environment = sky;
  scene.background = sky;
  scene.environmentIntensity = night ? 0.4 : 1.0;
  const prevEnvRot = scene.environmentRotation.clone();
  const prevBgRot = scene.backgroundRotation.clone();
  const prevBgI = scene.backgroundIntensity;
  const sunI0 = viewer.sun.intensity;
  // 実写の空（HDRI）: 雲・大気・太陽を含む光源と背景。太陽の方位を日照の設定に合わせ、明るさは手続き的な空＋太陽にそろえる
  let usingHdri = false;
  let skyE = 0;
  if (opts.hdri !== false) {
    opts.onStatus?.('実写の空を準備中');
    const hdri = await loadHdri(viewer.design.timeOfDay);
    if (hdri) {
      const img = sky.image as { data: Float32Array; width: number; height: number };
      const sd = viewer.sunDir;
      const target = night ? 0 : sky.image ? Math.atan2(sd.z, sd.x) : 0;
      const procE = equirectIrradiance(img.data, img.width, img.height) * (night ? 0.4 : 1) + (night ? 0 : sunI0 * 1.15 * Math.max(0, sd.y));
      // 夕景は実写の空の方が暗く沈みがちなので少し持ち上げる。夜景はブルーアワーの空が見える明るさに固定
      // （手続き的な夜空は暗すぎて、合わせると空が真っ黒になる）
      const k = night ? 0.08 / Math.max(1e-4, hdri.irradiance) : (procE > 0 && hdri.irradiance > 0 ? procE / hdri.irradiance : 1) * (tod === 'evening' ? 1.35 : 1);
      skyE = procE;
      scene.environment = hdri.texture;
      scene.background = hdri.texture;
      scene.environmentIntensity = k;
      scene.backgroundIntensity = k;
      scene.environmentRotation.set(0, hdri.sunAzimuth - target, 0);
      scene.backgroundRotation.set(0, hdri.sunAzimuth - target, 0);
      usingHdri = true;
    }
  }
  // リアルタイム用の補助光・点光源は使わない（夕景・夜景は下で物理的な照明を置く）
  const lightVis = viewer.groups.lights.visible;
  viewer.groups.lights.visible = false;
  const hemiVis = viewer.hemi.visible;
  viewer.hemi.visible = false;
  const sunI = viewer.sun.intensity;
  // HDRI の場合は太陽も空の画像に含まれるので、平行光源の太陽は消す
  viewer.sun.intensity = usingHdri && !night ? 0 : sunI * 1.15;
  const prevExposure = renderer.toneMappingExposure;
  if (opts.exposure) renderer.toneMappingExposure = opts.exposure;
  const baseExposure = renderer.toneMappingExposure;
  // 内観: 窓の面光源と照明（夜は既存の点光源の代わりに使う）
  let extraLights: THREE.Group | null = null;
  if (opts.interior && viewer.state) {
    if (!skyE) {
      const img = sky.image as { data: Float32Array; width: number; height: number };
      skyE = equirectIrradiance(img.data, img.width, img.height) * (night ? 0.4 : 1) + (night ? 0 : sunI0 * 1.15 * Math.max(0, viewer.sunDir.y));
    }
    // 夜は屋外が暗いので、照明の明るさは昼の空を基準にする
    const refE = night ? Math.max(skyE, 1e-3) * 1500 : skyE;
    extraLights = buildInteriorPhotoLights({
      model: viewer.state.model,
      spec: resolveSpec(viewer.design.specId, viewer.design.specPatch),
      lights: viewer.state.lights,
      camera: camera.position,
      skyE: refE,
      lampColor: kelvinToColor(interiorFor(viewer.design).lightKelvin),
      mode: viewer.design.timeOfDay,
    });
    scene.add(extraLights);
    scene.updateMatrixWorld(true);
  }
  // 夕景・夜景の外観: 室内の灯り（全階）・ポーチ・植栽のアップライト・フットライト
  let extLights: THREE.Group | null = null;
  if (dusk && viewer.state) {
    if (!skyE) {
      const img = sky.image as { data: Float32Array; width: number; height: number };
      skyE = equirectIrradiance(img.data, img.width, img.height) * (night ? 0.4 : 1) + (night ? 0 : sunI0 * 1.15 * Math.max(0, viewer.sunDir.y));
    }
    const refE = night ? Math.max(skyE, 1e-3) * 1500 : skyE;
    extLights = buildExteriorLights({
      meta: viewer.state.meta,
      plan: viewer.state.plan,
      // 内観では室内の灯りは上で置いているので、外部の器具だけ
      lights: opts.interior ? [] : viewer.state.lights,
      mode: tod,
      skyE: refE,
      lampColor: kelvinToColor(interiorFor(viewer.design).lightKelvin),
      physical: true,
    });
    scene.add(extLights);
    scene.updateMatrixWorld(true);
  }
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
  // テクスチャ配列: 既定 1024×1024×枚数 は内蔵 GPU でメモリ不足になりやすい（74枚で約300MB）
  const ts = opts.textureSize ?? (opts.safe ? 256 : 512);
  pt.textureSize.set(ts, ts);
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

  // 検証用: URL の ?ptlimit=秒 で計算時間の上限を変える（GPU の無い環境での確認用）
  const urlLimit = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('ptlimit')) : 0;
  const limit = urlLimit > 0 ? urlLimit * 1000 : (opts.timeLimit ?? 240000);
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
      if (opts.finish?.aborted && pt.samples >= 1) break;
    }
    check();
    console.info(`写真品質レンダリング: ${Math.floor(pt.samples)} サンプル / ${Math.round((performance.now() - t0) / 1000)} 秒`);
    if (pt.samples < 1) throw new PhotorealError('計算が進みませんでした', 'no-samples');
    // 露出を自動で合わせる（写真の自動露出と同じ。内観は室内の中間の明るさを基準に、窓の外は白く飛ぶのが自然。
    // 夕景・夜景は暗い側に基準を置き、灯りが主役になる明るさに）
    {
      const target = opts.interior ? (night ? 96 : 118) : night ? 52 : tod === 'evening' ? 86 : 108;
      const lo = opts.interior ? 0.1 : 0.45;
      const hi = opts.interior ? 8 : night ? 4.5 : 2.6;
      for (let it = 0; it < 5; it++) {
        present(false);
        const m = lumaPercentile(canvas, 0.5);
        const f = Math.max(0.5, Math.min(2.2, Math.pow(target / Math.max(2, m), 1.3)));
        renderer.toneMappingExposure = Math.max(baseExposure * lo, Math.min(baseExposure * hi, renderer.toneMappingExposure * f));
        if (Math.abs(f - 1) < 0.04) break;
      }
      console.info(`写真品質レンダリング: 露出 ${renderer.toneMappingExposure.toFixed(2)}`);
    }
    // AI ノイズ除去（OIDN）。WebGPU の無い環境・失敗時は従来のノイズ除去（サンプルが少ないときは強め）
    const aiTex = opts.denoise === false ? null : await oidnDenoise({ renderer, target: pt.target, scene, camera, onStatus: opts.onStatus, signal: opts.signal });
    if (aiTex) {
      const mat = quad.material as THREE.MeshBasicMaterial;
      quad.material = mat;
      mat.map = aiTex;
      mat.needsUpdate = true;
      renderer.setRenderTarget(null);
      renderer.autoClear = true;
      quad.render(renderer);
      aiTex.dispose();
    } else {
      const u = (denoise as unknown as { uniforms: Record<string, { value: number }> }).uniforms;
      if (pt.samples < 64) {
        const k = Math.min(1, (64 - pt.samples) / 48);
        u.sigma.value = 2.2 + 1.8 * k;
        u.threshold.value = 0.08 + 0.1 * k;
      }
      present(true);
    }
    await gpuWait(gl, () => lost);
    check();
    const luma = meanLuma(canvas);
    if (luma < (night ? 1.5 : 4)) throw new PhotorealError(`画像が真っ黒になりました（平均輝度 ${luma.toFixed(1)}）`, 'black');
    return finishPhoto(canvas, { interior: !!opts.interior, tod });
  } finally {
    canvas.removeEventListener('webglcontextlost', onLost);
    renderer.debug.onShaderError = prevOnShaderError;
    pt.dispose();
    quad.dispose();
    denoise.dispose();
    restoreMaterials(saved);
    if (extraLights) scene.remove(extraLights);
    if (extLights) scene.remove(extLights);
    sky.dispose();
    scene.environment = prevEnv;
    scene.background = prevBg;
    scene.environmentIntensity = prevEnvI;
    scene.backgroundIntensity = prevBgI;
    scene.environmentRotation.copy(prevEnvRot);
    scene.backgroundRotation.copy(prevBgRot);
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

/** 写真としての仕上げ: ハイライトのにじみ（ブルーム）、ごく弱い周辺減光とトーンカーブ、フィルムの粒子 */
export interface FinishOptions {
  vignette?: number;
  contrast?: number;
  bloom?: number;
  grain?: number;
  /** 内観（彩度・クラリティを控えめに、影をやわらかく） */
  interior?: boolean;
  tod?: TimeOfDay;
  /** 彩度の低い色ほど強く持ち上げる（ヴァイブランス） */
  vibrance?: number;
  /** 局所コントラスト（大きな半径のアンシャープマスク。素材の質感が立つ） */
  clarity?: number;
  /** 影を少し青く、ハイライトを少し暖かく（0〜255 の量） */
  splitTone?: number;
}

/**
 * 写真の仕上げ（建築写真家のレタッチに倣う）:
 * ブルーム → クラリティ（局所コントラスト） → トーンカーブ（S 字・黒の持ち上げ・ハイライトのショルダー）→
 * ヴァイブランス → スプリットトーン → 粒子 → ビネット
 */
export function finishPhoto(src: HTMLCanvasElement, opts: FinishOptions = {}): string {
  const w = src.width;
  const h = src.height;
  const interior = opts.interior ?? false;
  const tod = opts.tod ?? 'day';
  const dusk = tod === 'night' || tod === 'evening';
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  // ブルーム: 明るい部分（空・窓・照明）だけを取り出してぼかし、薄く重ねる（レンズのにじみ）
  const bloom = opts.bloom ?? (dusk ? 0.14 : interior ? 0.1 : 0.06);
  if (bloom > 0) {
    const s = Math.max(1, Math.round(Math.max(w, h) / 240));
    const bw = Math.max(1, Math.floor(w / s));
    const bh = Math.max(1, Math.floor(h / s));
    const b = document.createElement('canvas');
    b.width = bw;
    b.height = bh;
    const bc = b.getContext('2d', { willReadFrequently: true })!;
    bc.drawImage(src, 0, 0, bw, bh);
    const bi = bc.getImageData(0, 0, bw, bh);
    const bd = bi.data;
    for (let i = 0; i < bd.length; i += 4) {
      const l = (0.2126 * bd[i] + 0.7152 * bd[i + 1] + 0.0722 * bd[i + 2]) / 255;
      const t = Math.max(0, (l - 0.72) / 0.28);
      bd[i] *= t;
      bd[i + 1] *= t;
      bd[i + 2] *= t;
    }
    bc.putImageData(bi, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = bloom;
    ctx.filter = `blur(${Math.max(2, Math.round(Math.max(w, h) / 90))}px)`;
    ctx.drawImage(b, 0, 0, w, h);
    ctx.restore();
  }
  // クラリティ: 大きくぼかした画像との差を少し足す（局所コントラスト。塗り壁・石・木の質感が立ち、写真の「抜け」が出る）
  const clarity = opts.clarity ?? (interior ? 0.12 : 0.18);
  let blur: Uint8ClampedArray | null = null;
  if (clarity > 0) {
    const s = 6;
    const bw = Math.max(1, Math.ceil(w / s));
    const bh = Math.max(1, Math.ceil(h / s));
    const b = document.createElement('canvas');
    b.width = bw;
    b.height = bh;
    const bc = b.getContext('2d')!;
    bc.filter = `blur(${Math.max(1, Math.round(bw / 70))}px)`;
    bc.drawImage(src, 0, 0, bw, bh);
    const u = document.createElement('canvas');
    u.width = w;
    u.height = h;
    const uc = u.getContext('2d', { willReadFrequently: true })!;
    uc.imageSmoothingEnabled = true;
    uc.imageSmoothingQuality = 'high';
    uc.drawImage(b, 0, 0, w, h);
    blur = uc.getImageData(0, 0, w, h).data;
  }
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const k = opts.contrast ?? (interior ? 0.07 : 0.1);
  const grain = (opts.grain ?? 0.008) * 255;
  const vib = opts.vibrance ?? (interior ? 0.08 : 0.14);
  const st = opts.splitTone ?? (dusk ? 0 : 5);
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  // トーンカーブ: S 字（中間調を締める）＋ 黒をわずかに持ち上げ（フィルムの黒）＋ ハイライトのショルダー（白飛びをなだらかに）
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let v = x + k * Math.sin((x - 0.5) * Math.PI * 2) * -0.5 * Math.sin(x * Math.PI);
    if (v > 0.86) v = 0.86 + (v - 0.86) * 0.78;
    v = 0.012 + v * 0.988;
    lut[i] = Math.max(0, Math.min(1, v)) * 255;
  }
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const sample = (v: number) => {
    const i = v < 0 ? 0 : v > 255 ? 255 : v;
    const i0 = i | 0;
    const f = i - i0;
    return i0 >= 255 ? lut[255] : lut[i0] + (lut[i0 + 1] - lut[i0]) * f;
  };
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i];
    let g = d[i + 1];
    let b = d[i + 2];
    if (blur) {
      r = clamp(r + clarity * (r - blur[i]));
      g = clamp(g + clarity * (g - blur[i + 1]));
      b = clamp(b + clarity * (b - blur[i + 2]));
    }
    r = sample(r);
    g = sample(g);
    b = sample(b);
    // ヴァイブランス: 彩度の低い色ほど持ち上げ、もともと鮮やかな色は増やしすぎない
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    const f = 1 + vib * (1 - sat);
    r = l + (r - l) * f;
    g = l + (g - l) * f;
    b = l + (b - l) * f;
    // スプリットトーン: 影は少し青く、ハイライトは少し暖かく
    if (st > 0) {
      const t = (l / 255 - 0.5) * 2;
      if (t < 0) {
        b += -t * st;
        r -= -t * st * 0.4;
      } else {
        r += t * st;
        g += t * st * 0.5;
      }
    }
    const gn = grain > 0 ? rnd() * grain : 0;
    d[i] = clamp(r + gn);
    d[i + 1] = clamp(g + gn);
    d[i + 2] = clamp(b + gn);
  }
  ctx.putImageData(img, 0, 0);
  const v = opts.vignette ?? (interior ? 0.14 : 0.18);
  const gr = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.38, w / 2, h / 2, Math.hypot(w, h) * 0.64);
  gr.addColorStop(0, 'rgba(0,0,0,0)');
  gr.addColorStop(1, `rgba(0,0,0,${v})`);
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.95);
}
