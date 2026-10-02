/**
 * 実写の PBR テクスチャ（Poly Haven・CC0。public/tex）
 *
 * 手続き的なテクスチャは均一で CG らしく見えやすい。塗り壁・床・地面などの主要な素材は実写のスキャン素材に置き換える。
 * テイストの色を保つため、写真の模様・凹凸・粗さはそのまま使い、平均の色だけをテイストの色に合わせる。
 * 読み込みは非同期（読み込むまでは手続き的なテクスチャで表示し、読み込み後に差し替える）。
 */
import * as THREE from 'three';
import type { MatSpec, Pattern } from './textures';

interface PhotoDef {
  id: string;
  /** 写真1枚が覆う長さ (m) */
  tile: number;
  /** 写真の模様の強さ（1 = そのまま。汚れの目立つ素材は弱めて新築らしく） */
  detail?: number;
}

/** パターン → 実写素材 */
const PHOTO: Partial<Record<Pattern, PhotoDef>> = {
  stucco: { id: 'white_plaster_02', tile: 2.4, detail: 0.35 },
  plaster: { id: 'painted_plaster_wall', tile: 2.4, detail: 0.3 },
  concrete: { id: 'concrete_floor_02', tile: 4, detail: 0.6 },
  woodFloor: { id: 'wood_floor', tile: 2.0 },
  woodSiding: { id: 'wood_planks', tile: 2.0 },
  tileFloor: { id: 'large_floor_tiles_02', tile: 2.4 },
  marble: { id: 'marble_01', tile: 2.4 },
  gravel: { id: 'gravel_concrete_03', tile: 3 },
  grass: { id: 'leafy_grass', tile: 3 },
  asphalt: { id: 'asphalt_02', tile: 5 },
};

interface Loaded {
  diff: ImageData;
  nor: HTMLImageElement | ImageBitmap;
  rough: ImageData;
  mean: [number, number, number];
  meanRough: number;
}

const loaded = new Map<string, Loaded>();
let preload: Promise<void> | null = null;

function texBase(): string {
  return typeof document !== 'undefined' ? new URL('tex/', document.baseURI).toString() : '';
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  return img;
}

function imageData(img: HTMLImageElement): ImageData {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

const toLin = (v: number) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const toSrgb8 = (v: number) => {
  const x = Math.max(0, Math.min(1, v));
  return Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255);
};

/** 実写テクスチャを読み込む（一度だけ）。読み込めなかった素材は手続き的なまま */
export function preloadPhotoTextures(): Promise<void> {
  if (preload) return preload;
  if (typeof document === 'undefined') return (preload = Promise.resolve());
  const base = texBase();
  const ids = [...new Set(Object.values(PHOTO).map((d) => d!.id))];
  preload = Promise.all(
    ids.map(async (id) => {
      try {
        const [d, n, r] = await Promise.all(['diff', 'nor', 'rough'].map((k) => loadImage(`${base}${id}/${k}.jpg`)));
        const diff = imageData(d);
        const rough = imageData(r);
        // 平均色（線形）と平均粗さ
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let rr = 0;
        const N = diff.width * diff.height;
        for (let i = 0; i < N; i++) {
          sr += toLin(diff.data[i * 4]);
          sg += toLin(diff.data[i * 4 + 1]);
          sb += toLin(diff.data[i * 4 + 2]);
          rr += rough.data[i * 4 + 1] / 255;
        }
        loaded.set(id, { diff, nor: n, rough, mean: [sr / N, sg / N, sb / N], meanRough: rr / N });
      } catch (e) {
        console.warn('実写テクスチャを読み込めませんでした', id, e);
      }
    }),
  ).then(() => undefined);
  return preload;
}

export function photoTexturesLoaded(): boolean {
  return loaded.size > 0;
}

export interface PhotoSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  tile: number;
  /** 粗さの倍率（テイストの粗さに平均を合わせる） */
  roughnessScale: number;
}

const setCache = new Map<string, PhotoSet>();

/** 実写の素材（読み込み済みで、そのパターンに割り当てがある場合） */
export function photoSet(spec: MatSpec): PhotoSet | null {
  const def = PHOTO[spec.pattern];
  if (!def) return null;
  const L = loaded.get(def.id);
  if (!L) return null;
  const key = `${def.id}|${spec.color}|${spec.roughness ?? ''}`;
  const hit = setCache.get(key);
  if (hit) return hit;
  // 写真の模様を残したまま、平均色をテイストの色に合わせる（線形空間で各チャンネルを倍率調整）
  const target = new THREE.Color(spec.color); // three の Color は線形
  const k = [target.r / Math.max(1e-4, L.mean[0]), target.g / Math.max(1e-4, L.mean[1]), target.b / Math.max(1e-4, L.mean[2])];
  const src = L.diff;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d')!;
  const out = ctx.createImageData(src.width, src.height);
  const det = def.detail ?? 1;
  for (let i = 0; i < src.width * src.height; i++) {
    for (let ch = 0; ch < 3; ch++) {
      // 平均との差を det 倍に（模様・汚れの強さ）してから、テイストの色の平均に合わせる
      const v = L.mean[ch] + (toLin(src.data[i * 4 + ch]) - L.mean[ch]) * det;
      out.data[i * 4 + ch] = toSrgb8(v * k[ch]);
    }
    out.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  const wrap = (t: THREE.Texture, srgb: boolean) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };
  const map = wrap(new THREE.CanvasTexture(c), true);
  const normalMap = wrap(new THREE.Texture(L.nor as HTMLImageElement), false);
  const rc = document.createElement('canvas');
  rc.width = L.rough.width;
  rc.height = L.rough.height;
  rc.getContext('2d')!.putImageData(L.rough, 0, 0);
  const roughnessMap = wrap(new THREE.CanvasTexture(rc), false);
  const want = spec.roughness ?? L.meanRough;
  const set: PhotoSet = { map, normalMap, roughnessMap, tile: def.tile, roughnessScale: Math.min(2.5, want / Math.max(0.05, L.meanRough)) };
  setCache.set(key, set);
  return set;
}
