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
  /**
   * 木目の向き: 写真は木目が縦（v の向き）。部材の UV は「長さの向き = u」で作るので、ふつうは縦横を入れ替えて貼る。
   * 戸・板張りの壁のように、木目を縦に流す素材は MatSpec.grainV で入れ替えずに使う
   */
  grainAlongV?: boolean;
  /** 粗さのむらの強さ（1 = 写真のまま）。木の突板は、艶のむらが強いと斜めの光で濡れたような筋が出るので弱める */
  roughDetail?: number;
}

/** パターン → 実写素材 */
const PHOTO: Partial<Record<Pattern, PhotoDef>> = {
  // 塗り壁の粒子感・左官のムラは写真らしさの要（弱すぎると均一な CG に見える）
  // 外壁の塗り壁（ジョリパット）: 新築の面は、離れて見るとほぼ均一で、近づくと細かい粒が見える。
  // 0.5 では 1〜2 m の大きなしみが繰り返して、汚れた壁に見えていた（粒の凹凸・粗さは写真のまま）
  stucco: { id: 'white_plaster_02', tile: 2.4, detail: 0.2 },
  // 室内の塗り壁: 御社の提案パース（林様・堀様・吉田様）の壁は、色むらのほとんど無い細かい粒子の面。
  // 0.6 では古い塗装のしみのようなムラが出て、打ち放しコンクリートの壁のように見えていた
  plaster: { id: 'painted_plaster_wall', tile: 2.4, detail: 0.36 },
  concrete: { id: 'concrete_floor_02', tile: 4, detail: 0.7 },
  woodFloor: { id: 'wood_floor', tile: 2.0 },
  woodSiding: { id: 'wood_planks', tile: 2.0 },
  tileFloor: { id: 'large_floor_tiles_02', tile: 2.4 },
  marble: { id: 'marble_01', tile: 2.4 },
  asphalt: { id: 'asphalt_02', tile: 5, detail: 0.65 },
  // 外構の地面: 芝と砂利は手続き的だと一様な模様で CG らしかった。実写（葉のある芝・砂利）に
  grass: { id: 'leafy_grass', tile: 2.0, detail: 0.85 },
  gravel: { id: 'gravel_concrete_03', tile: 2.0, detail: 0.8 },
  // 布もの（ソファ・クッション・ラグ・寝具）: ヘリンボーンのウール。平均色はテイストの色に合わせる
  fabric: { id: 'poly_wool_herringbone', tile: 0.5, detail: 0.9 },
  // 家具・造作・階段の踏板・戸の木: オークの突板（板目）。手続き的な木目は近くで見るとぼやけて、木に見えなかった
  wood: { id: 'oak_veneer_01', tile: 1.2, detail: 0.9, grainAlongV: true, roughDetail: 0.4 },
};

interface Loaded {
  diff: ImageData;
  nor: HTMLImageElement | ImageBitmap;
  rough: ImageData;
  mean: [number, number, number];
  meanRough: number;
  /** 縦横を入れ替えた版（木目を u の向きに流すとき。使うときに 1 度だけ作る） */
  swapped?: { diff: ImageData; nor: HTMLCanvasElement; rough: ImageData };
}

/** 画像の縦横を入れ替える（対角線で折り返す）。法線マップは、向きも入れ替わるので R と G を入れ替える */
function transpose(src: ImageData, normal = false): ImageData {
  const w = src.width;
  const h = src.height;
  const out = new ImageData(h, w);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const o = (x * h + y) * 4;
      out.data[o] = src.data[normal ? i + 1 : i];
      out.data[o + 1] = src.data[normal ? i : i + 1];
      out.data[o + 2] = src.data[i + 2];
      out.data[o + 3] = 255;
    }
  return out;
}

function swappedOf(L: Loaded): NonNullable<Loaded['swapped']> {
  if (L.swapped) return L.swapped;
  const img = L.nor as HTMLImageElement;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const n = transpose(ctx.getImageData(0, 0, c.width, c.height), true);
  const nc = document.createElement('canvas');
  nc.width = n.width;
  nc.height = n.height;
  nc.getContext('2d')!.putImageData(n, 0, 0);
  L.swapped = { diff: transpose(L.diff), nor: nc, rough: transpose(L.rough) };
  return L.swapped;
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
  // 木目の向き（上の grainAlongV）
  const swap = !!def.grainAlongV && !spec.grainV;
  const key = `${def.id}|${spec.color}|${spec.roughness ?? ''}|${swap ? 'u' : 'v'}`;
  const hit = setCache.get(key);
  if (hit) return hit;
  const S = swap ? swappedOf(L) : null;
  // 写真の模様を残したまま、平均色をテイストの色に合わせる（線形空間で各チャンネルを倍率調整）
  const target = new THREE.Color(spec.color); // three の Color は線形
  const k = [target.r / Math.max(1e-4, L.mean[0]), target.g / Math.max(1e-4, L.mean[1]), target.b / Math.max(1e-4, L.mean[2])];
  const src = S ? S.diff : L.diff;
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
    t.anisotropy = 16;
    t.needsUpdate = true;
    return t;
  };
  const map = wrap(new THREE.CanvasTexture(c), true);
  const normalMap = wrap(S ? new THREE.CanvasTexture(S.nor) : new THREE.Texture(L.nor as HTMLImageElement), false);
  let rough = S ? S.rough : L.rough;
  if (def.roughDetail != null && def.roughDetail !== 1) {
    // 粗さのむらを弱める（平均はそのまま）
    const flat = new ImageData(rough.width, rough.height);
    const m = L.meanRough * 255;
    for (let i = 0; i < rough.data.length; i += 4) {
      const v = Math.max(0, Math.min(255, Math.round(m + (rough.data[i + 1] - m) * def.roughDetail)));
      flat.data[i] = flat.data[i + 1] = flat.data[i + 2] = v;
      flat.data[i + 3] = 255;
    }
    rough = flat;
  }
  const rc = document.createElement('canvas');
  rc.width = rough.width;
  rc.height = rough.height;
  rc.getContext('2d')!.putImageData(rough, 0, 0);
  const roughnessMap = wrap(new THREE.CanvasTexture(rc), false);
  const want = spec.roughness ?? L.meanRough;
  const set: PhotoSet = { map, normalMap, roughnessMap, tile: def.tile, roughnessScale: Math.min(2.5, want / Math.max(0.05, L.meanRough)) };
  setCache.set(key, set);
  return set;
}
