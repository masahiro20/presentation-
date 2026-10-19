/**
 * AI ノイズ除去（Intel Open Image Denoise の Web 版 oidn-web）。
 * パストレーサーの HDR 結果に、アルベド（素材の色）と法線を手がかりとして与え、少ないサンプル数でも
 * 粒子状のノイズの無い写真品質に仕上げる。WebGPU が使えるブラウザ（Chrome・Edge・Safari 26 など）だけで動き、
 * 使えない環境では null を返して従来のノイズ除去にまかせる。重みは public/oidn（RenderKit/oidn-weights）。
 */
import * as THREE from 'three';

export interface OidnInput {
  renderer: THREE.WebGLRenderer;
  /** パストレーサーの結果（線形 HDR・Float） */
  target: THREE.WebGLRenderTarget;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  onStatus?: (msg: string) => void;
  signal?: AbortSignal;
}

export function oidnAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as { gpu?: unknown }).gpu && !(typeof location !== 'undefined' && new URLSearchParams(location.search).get('ptdenoise') === 'off');
}

/** 素材の色（アルベド）と視点座標系の法線を 8bit で描く（OIDN の手がかり用） */
function renderAux(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, w: number, h: number): { albedo: ImageData; normal: ImageData } {
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace, depthBuffer: true });
  const prevTm = renderer.toneMapping;
  const prevOut = renderer.outputColorSpace;
  const prevBg = scene.background;
  const prevEnv = scene.environment;
  const prevFog = scene.fog;
  const prevRT = renderer.getRenderTarget();
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  scene.environment = null;
  scene.fog = null;
  const swapped: { m: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[] = [];
  const hidden: THREE.Object3D[] = [];
  const made: THREE.Material[] = [];
  const read = () => {
    const buf = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    return new ImageData(new Uint8ClampedArray(buf.buffer), w, h);
  };
  try {
    scene.traverse((o) => {
      if (!o.visible) return;
      if ((o as THREE.Sprite).isSprite || (o as THREE.LineSegments).isLineSegments || (o as THREE.Points).isPoints) {
        hidden.push(o);
        o.visible = false;
      }
    });
    // アルベド: 素材の色とテクスチャだけ（照明なし）。ガラスはほぼ白
    const cache = new Map<THREE.Material, THREE.Material>();
    const albedoOf = (src: THREE.Material): THREE.Material => {
      let m = cache.get(src);
      if (m) return m;
      const s = src as THREE.MeshStandardMaterial;
      const basic = new THREE.MeshBasicMaterial({ color: s.color ? s.color.clone() : new THREE.Color(0.8, 0.8, 0.8), map: s.map ?? null, side: src.side, toneMapped: false, fog: false });
      if (s.transparent && s.opacity < 0.6) basic.color.set(0.9, 0.9, 0.9);
      made.push(basic);
      cache.set(src, basic);
      return basic;
    };
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.visible) return;
      swapped.push({ m, mat: m.material });
      m.material = Array.isArray(m.material) ? m.material.map(albedoOf) : albedoOf(m.material);
    });
    scene.background = new THREE.Color(0.75, 0.8, 0.9);
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, camera);
    const albedo = read();
    // 法線（視点座標系。0.5 を中心に ±0.5）
    const nm = new THREE.MeshNormalMaterial({ fog: false });
    made.push(nm);
    for (const { m } of swapped) m.material = nm;
    scene.background = new THREE.Color(0.5, 0.5, 1.0);
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, camera);
    const normal = read();
    return { albedo, normal };
  } finally {
    for (const { m, mat } of swapped) m.material = mat;
    for (const o of hidden) o.visible = true;
    for (const m of made) m.dispose();
    rt.dispose();
    renderer.setRenderTarget(prevRT);
    renderer.toneMapping = prevTm;
    renderer.outputColorSpace = prevOut;
    scene.background = prevBg;
    scene.environment = prevEnv;
    scene.fog = prevFog;
  }
}

let unetPromise: Promise<import('oidn-web').UNet> | null = null;

/** パストレーサーの結果を OIDN でノイズ除去した線形 HDR テクスチャ。使えない環境・失敗時は null */
export async function oidnDenoise(input: OidnInput): Promise<THREE.DataTexture | null> {
  if (!oidnAvailable()) return null;
  const { renderer, target, scene, camera } = input;
  const w = target.width;
  const h = target.height;
  try {
    input.onStatus?.('AI ノイズ除去の準備中');
    if (!unetPromise) {
      unetPromise = import('oidn-web').then(({ initUNetFromURL }) => initUNetFromURL(new URL('/oidn/rt_hdr_alb_nrm.tza', location.origin).href, undefined, { aux: true, hdr: true }));
      unetPromise.catch(() => (unetPromise = null));
    }
    const unet = await unetPromise;
    if (input.signal?.aborted) return null;
    const color = new Float32Array(w * h * 4);
    renderer.readRenderTargetPixels(target, 0, 0, w, h, color);
    for (let i = 0; i < color.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = color[i + c];
        color[i + c] = Number.isFinite(v) && v > 0 ? Math.min(v, 65000) : 0;
      }
      color[i + 3] = 1;
    }
    const { albedo, normal } = renderAux(renderer, scene, camera, w, h);
    input.onStatus?.('AI でノイズを除去中');
    const out = await new Promise<Float32Array>((resolve, reject) => {
      const abort = unet.tileExecute({
        color: { data: color, width: w, height: h },
        albedo,
        normal,
        done: (res) => resolve(res.data),
        error: (e) => reject(e),
        progress: (_o, _t, _tile, i, n) => input.onStatus?.(`AI でノイズを除去中 ${Math.round(((i + 1) / n) * 100)}%`),
      });
      input.signal?.addEventListener('abort', () => {
        abort();
        reject(new DOMException('中止しました', 'AbortError'));
      });
    });
    const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.FloatType);
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    console.info('写真品質レンダリング: OIDN（AI ノイズ除去）を使用');
    return tex;
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') throw e;
    console.warn('OIDN が使えなかったため従来のノイズ除去を使います', e);
    return null;
  }
}
