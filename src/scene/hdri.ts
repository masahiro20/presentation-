/**
 * 写真品質レンダリング用の実写の空（HDRI）
 *
 * 手続き的な空は雲や大気の深みが乏しく、CG らしさの大きな原因になる。Poly Haven の CC0 HDRI（雲のある実写の空）を
 * 光源と背景に使う。HDRI の太陽の向きを画像から求め、建物に対する太陽の方位（日照の設定）に合わせて回転する。
 * 明るさは、それまでの空＋太陽の水平面照度にそろえる（露出・内観の明るさの調整をそのまま使えるように）。
 */
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

export type SkyMode = 'morning' | 'day' | 'evening' | 'night';

/** 同梱の HDRI（public/hdri。いずれも Poly Haven・CC0） */
const FILES: Record<SkyMode, string> = {
  morning: 'kloofendal_misty_morning_puresky_2k.hdr',
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
  /** 地平線のすぐ上（仰角 0.5〜4°）の色（リニア。太陽のまわりの明るい所を除いた平均）。遠景のかすみの色に使う */
  horizon: THREE.Color;
  /** 空（上半分）の明るさの中央値。画面の空の明るさをそろえる基準（太陽や雲の白に引っ張られない） */
  skyMedian: number;
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

/** base64 テキストを取得し、元のバイナリの Blob URL にする */
export async function b64BlobUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const bin = atob((await res.text()).trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes]));
}

export function loadHdri(mode: SkyMode): Promise<Hdri | null> {
  let p = cache.get(mode);
  if (!p) {
    p = (async () => {
      try {
        const loader = new HDRLoader();
        loader.setDataType(THREE.FloatType);
        let tex: THREE.DataTexture;
        try {
          tex = (await loader.loadAsync(hdriUrl(FILES[mode]))) as THREE.DataTexture;
        } catch {
          // .hdr を配信しない公開先: base64 テキストの写しから読み込む
          const url = await b64BlobUrl(hdriUrl(FILES[mode]) + '.txt');
          try {
            tex = (await loader.loadAsync(url)) as THREE.DataTexture;
          } finally {
            URL.revokeObjectURL(url);
          }
        }
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
        // 空（上半分）の明るさの中央値（まばらに拾う）
        const lum = (i: number) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        const ls: number[] = [];
        for (let r = Math.floor(H / 2) + 4; r < H; r += 6) for (let c = 0; c < W; c += 6) ls.push(lum((r * W + c) * ch));
        ls.sort((a, b) => a - b);
        const skyMedian = ls.length ? ls[Math.floor(ls.length / 2)] : 1;
        // 地平線のすぐ上の色: 明るさが下から 7 割までの画素の平均（夕景の太陽のまわりの光を入れると、かすみが真っ白になる）
        const r0 = Math.floor(H / 2 + (0.5 / 180) * H);
        const r1 = Math.ceil(H / 2 + (4 / 180) * H);
        const hl: number[] = [];
        for (let r = r0; r <= r1; r++) for (let c = 0; c < W; c += 2) hl.push(lum((r * W + c) * ch));
        hl.sort((a, b) => a - b);
        const cut = hl.length ? hl[Math.floor(hl.length * 0.7)] : Infinity;
        const hz = new THREE.Color(0, 0, 0);
        let hn = 0;
        for (let r = r0; r <= r1; r++)
          for (let c = 0; c < W; c += 2) {
            const i = (r * W + c) * ch;
            if (lum(i) > cut) continue;
            hz.r += data[i];
            hz.g += data[i + 1];
            hz.b += data[i + 2];
            hn++;
          }
        hz.multiplyScalar(1 / Math.max(1, hn));
        return { texture: tex, sunAzimuth: Math.atan2(d.z, d.x), sunElevation: Math.asin(d.y), irradiance: equirectIrradiance(data, W, H, ch), horizon: hz, skyMedian };
      } catch (e) {
        console.warn('HDRI を読み込めませんでした（手続き的な空で描画します）', e);
        return null;
      }
    })();
    cache.set(mode, p);
  }
  return p;
}

const screenTex = new WeakMap<THREE.DataTexture, THREE.DataTexture>();
/**
 * 画面の空の球に貼る写し（半精度・左右反転）。
 * 半精度のテクスチャは WebGL2 ならどの GPU でもなめらかに拡大できる（単精度は拡張が無いと黒くなる）。
 * 球の UV は正距円筒の向きと左右が逆なので、左右反転して貼る。太陽の円盤の極端な値は頭打ちにする（光のにじみが暴れない）
 */
export function hdriScreenTexture(h: Hdri): THREE.DataTexture {
  let t = screenTex.get(h.texture);
  if (!t) {
    const img = h.texture.image as { data: Float32Array; width: number; height: number };
    const n = img.width * img.height;
    const ch = img.data.length / n;
    const out = new Uint16Array(n * 4);
    const one = THREE.DataUtils.toHalfFloat(1);
    // 青の彩度を少し抑える（絵はがきのような濃い青にしない。建築写真の落ち着いた空）
    const SAT = 0.78;
    for (let i = 0; i < n; i++) {
      const r = Math.min(img.data[i * ch], 48);
      const g = Math.min(img.data[i * ch + 1], 48);
      const b = Math.min(img.data[i * ch + 2], 48);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      out[i * 4] = THREE.DataUtils.toHalfFloat(l + (r - l) * SAT);
      out[i * 4 + 1] = THREE.DataUtils.toHalfFloat(l + (g - l) * SAT);
      out[i * 4 + 2] = THREE.DataUtils.toHalfFloat(l + (b - l) * SAT);
      out[i * 4 + 3] = one;
    }
    t = new THREE.DataTexture(out, img.width, img.height, THREE.RGBAFormat, THREE.HalfFloatType);
    t.colorSpace = THREE.LinearSRGBColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.flipY = false;
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.x = -1;
    t.offset.x = 1;
    t.needsUpdate = true;
    screenTex.set(h.texture, t);
  }
  return t;
}
