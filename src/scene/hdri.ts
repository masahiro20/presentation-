/**
 * 写真品質レンダリング用の実写の空（HDRI）
 *
 * 手続き的な空は雲や大気の深みが乏しく、CG らしさの大きな原因になる。Poly Haven の CC0 HDRI（雲のある実写の空）を
 * 光源と背景に使う。HDRI の太陽の向きを画像から求め、建物に対する太陽の方位（日照の設定）に合わせて回転する。
 * 明るさは、それまでの空＋太陽の水平面照度にそろえる（露出・内観の明るさの調整をそのまま使えるように）。
 */
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

export type SkyMode = 'day' | 'evening' | 'night';

/** 同梱の HDRI（public/hdri。いずれも Poly Haven・CC0） */
const FILES: Record<SkyMode, string> = {
  day: 'kloofendal_48d_partly_cloudy_puresky_2k.hdr',
  evening: 'belfast_sunset_puresky_2k.hdr',
  night: 'kloppenheim_02_puresky_2k.hdr',
};

export interface Hdri {
  texture: THREE.DataTexture;
  /** 太陽の方位 atan2(z, x)（ラジアン、ワールド座標） */
  sunAzimuth: number;
  sunElevation: number;
  /** 水平面照度（空全体、太陽込み） */
  irradiance: number;
}

/** 正距円筒の画素 → 方向（three.js の equirectUv。1 行目が v=0 = 真下、flipY なし。手続き的な空と同じ並び） */
function pixelDir(c: number, r: number, W: number, H: number): THREE.Vector3 {
  const lat = ((r + 0.5) / H - 0.5) * Math.PI;
  const a = ((c + 0.5) / W - 0.5) * Math.PI * 2;
  return new THREE.Vector3(Math.cos(a) * Math.cos(lat), Math.sin(lat), Math.sin(a) * Math.cos(lat));
}

/** RGBA の正距円筒データ（1 行目 = 真下）の水平面照度 */
export function equirectIrradiance(data: ArrayLike<number>, W: number, H: number, channels = 4): number {
  let E = 0;
  const dA = (2 * Math.PI) / W;
  for (let r = Math.floor(H / 2); r < H; r++) {
    const lat = ((r + 0.5) / H - 0.5) * Math.PI;
    const w = Math.sin(lat) * Math.cos(lat) * dA * (Math.PI / H);
    if (w <= 0) continue;
    let row = 0;
    for (let c = 0; c < W; c++) {
      const i = (r * W + c) * channels;
      row += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    E += row * w;
  }
  return E;
}

const cache = new Map<SkyMode, Promise<Hdri | null>>();

function hdriUrl(file: string): string {
  const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
  return new URL(`hdri/${file}`, base).toString();
}

export function loadHdri(mode: SkyMode): Promise<Hdri | null> {
  let p = cache.get(mode);
  if (!p) {
    p = (async () => {
      try {
        const loader = new HDRLoader();
        loader.setDataType(THREE.FloatType);
        const tex = (await loader.loadAsync(hdriUrl(FILES[mode]))) as THREE.DataTexture;
        tex.mapping = THREE.EquirectangularReflectionMapping;
        const img = tex.image as { data: Float32Array; width: number; height: number };
        const { data, width: W, height: H } = img;
        const ch = data.length / (W * H);
        // 行を上下反転して「1 行目 = 真下」に（手続き的な空と同じ並び。パストレーサーで向きが確認済み）
        const rowLen = W * ch;
        const tmp = new Float32Array(rowLen);
        for (let r = 0; r < H / 2; r++) {
          const a = r * rowLen;
          const b = (H - 1 - r) * rowLen;
          tmp.set(data.subarray(a, a + rowLen));
          data.copyWithin(a, b, b + rowLen);
          data.set(tmp, b);
        }
        tex.flipY = false;
        tex.colorSpace = THREE.LinearSRGBColorSpace;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        // 太陽 = 上半分で最も明るい画素
        let best = -1;
        let bc = 0;
        let br = 0;
        for (let r = Math.floor(H / 2); r < H; r++)
          for (let c = 0; c < W; c++) {
            const i = (r * W + c) * ch;
            const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
            if (l > best) {
              best = l;
              bc = c;
              br = r;
            }
          }
        const d = pixelDir(bc, br, W, H);
        return { texture: tex, sunAzimuth: Math.atan2(d.z, d.x), sunElevation: Math.asin(d.y), irradiance: equirectIrradiance(data, W, H, ch) };
      } catch (e) {
        console.warn('HDRI を読み込めませんでした（手続き的な空で描画します）', e);
        return null;
      }
    })();
    cache.set(mode, p);
  }
  return p;
}
