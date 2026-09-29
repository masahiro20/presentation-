/**
 * 手続き的 PBR テクスチャ生成（外部画像素材不要・ライセンスフリー）
 * 各パターンで色・高さ(→法線)・粗さを生成する。
 */
import * as THREE from 'three';
import { ValueNoise, mulberry32 } from './noise';

export type Pattern =
  | 'plaster'
  | 'stucco'
  | 'paint'
  | 'siding'
  | 'lapSiding'
  | 'woodSiding'
  | 'galvalume'
  | 'brick'
  | 'stone'
  | 'concrete'
  | 'woodFloor'
  | 'herringbone'
  | 'tileFloor'
  | 'marble'
  | 'tatami'
  | 'slate'
  | 'roofTile'
  | 'standingSeam'
  | 'grass'
  | 'asphalt'
  | 'paving'
  | 'gravel'
  | 'fabric'
  | 'wood'
  | 'leather';

export interface MatSpec {
  pattern: Pattern;
  color: string;
  color2?: string;
  roughness?: number;
  metalness?: number;
  /** テクスチャ1枚が覆う長さ (m) */
  tile?: number;
  normalStrength?: number;
  /** 板幅・タイル寸法 (m)。フローリングは板幅、タイルは短辺 */
  size?: number;
  /** タイルの長辺 (m) */
  size2?: number;
  /** 発光（照明器具など） */
  emissive?: string;
  emissiveIntensity?: number;
}

const DEFAULT_TILE: Record<Pattern, number> = {
  plaster: 2,
  stucco: 3,
  paint: 2,
  siding: 1.82,
  lapSiding: 1.8,
  woodSiding: 1.26,
  galvalume: 1.6,
  brick: 1.0,
  stone: 2.4,
  concrete: 3.6,
  woodFloor: 2.4,
  herringbone: 1.2,
  tileFloor: 2.4,
  marble: 2.4,
  tatami: 1.82,
  slate: 1.8,
  roofTile: 1.2,
  standingSeam: 1.8,
  grass: 4,
  asphalt: 6,
  paving: 1.2,
  gravel: 2,
  fabric: 0.4,
  wood: 1.2,
  leather: 0.6,
};

export function tileOf(spec: MatSpec) {
  return spec.tile ?? DEFAULT_TILE[spec.pattern];
}

function hexToRgb(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  // sRGB 値（0..1）
  return [c.r, c.g, c.b].map((v) => THREE.ColorManagement.enabled ? linearToSrgb(v) : v) as [number, number, number];
}

function linearToSrgb(v: number) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

interface Buffers {
  size: number;
  col: Float32Array; // rgb 0..1 (sRGB)
  h: Float32Array; // 0..1
  r: Float32Array; // roughness 0..1
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** 目地などの溝: 位置 x (0..1周期) に幅 w の溝 */
function groove(frac: number, w: number): number {
  const d = Math.min(frac, 1 - frac);
  return smooth(0, w, d);
}

export function generatePattern(spec: MatSpec, size = 512, seed = 7): Buffers {
  const N = size;
  const col = new Float32Array(N * N * 3);
  const h = new Float32Array(N * N);
  const r = new Float32Array(N * N);
  const base = hexToRgb(spec.color);
  const alt = spec.color2 ? hexToRgb(spec.color2) : base;
  const noise = new ValueNoise(seed);
  const rnd = mulberry32(seed * 13 + 5);
  const baseRough = spec.roughness ?? 0.8;
  const tile = tileOf(spec);
  // 1m あたりの画素数
  const ppm = N / tile;
  const cellRand = (i: number, j: number, k = 0) => {
    let x = (i * 374761393 + j * 668265263 + k * 2147483647 + seed * 144269) | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  };
  const set = (i: number, c: [number, number, number], hh: number, rr: number) => {
    col[i * 3] = c[0];
    col[i * 3 + 1] = c[1];
    col[i * 3 + 2] = c[2];
    h[i] = hh;
    r[i] = rr;
  };
  const tint = (c: [number, number, number], k: number): [number, number, number] => [c[0] * k, c[1] * k, c[2] * k];
  const lerp3 = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
    mix(a[0], b[0], t),
    mix(a[1], b[1], t),
    mix(a[2], b[2], t),
  ];

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const mx = x / ppm; // m
      const my = y / ppm;
      const n1 = noise.fbm(x, y, N, 8, 5);
      const n2 = noise.fbm(x + 71, y + 13, N, 32, 3);
      switch (spec.pattern) {
        case 'plaster': {
          const k = 0.955 + 0.06 * n1 + 0.025 * n2;
          set(i, tint(base, k), n2 * 0.5 + n1 * 0.3, baseRough - 0.05 + 0.1 * n2);
          break;
        }
        case 'stucco': {
          // 外壁の塗り壁: コテむらのやわらかな陰影（目地なし）
          const trowel = noise.fbm(x * 0.6 + n1 * 90, y * 1.4, N, 5, 4);
          const fine = noise.fbm(x * 3, y * 3, N * 3, 48, 2);
          const k = 0.965 + 0.045 * trowel + 0.02 * fine;
          set(i, tint(base, k), trowel * 0.25 + fine * 0.08, baseRough - 0.03 + 0.06 * fine);
          break;
        }
        case 'paint': {
          const k = 0.97 + 0.04 * n1;
          set(i, tint(base, k), n2 * 0.15, baseRough);
          break;
        }
        case 'siding': {
          // 455mm ピッチの横目地 + 石目調
          const band = my / 0.455;
          const bi = Math.floor(band);
          const g = groove(band - bi, 0.02);
          const vj = mx / 1.82 + (bi % 2) * 0.5;
          const gv = groove(vj - Math.floor(vj), 0.004);
          const var1 = 0.94 + 0.08 * cellRand(bi, Math.floor(vj));
          const stone = noise.fbm(x * 2, y * 2, N * 2, 24, 3);
          const k = var1 * (0.92 + 0.12 * stone) * mix(0.55, 1, g * gv);
          set(i, lerp3(tint(base, k), tint(alt, k), stone * 0.3), g * gv * (0.7 + 0.3 * stone), baseRough);
          break;
        }
        case 'lapSiding': {
          const bh = 0.18;
          const band = my / bh;
          const bi = Math.floor(band);
          const f = band - bi;
          // 下端に影、上へ向かって厚みが薄くなる
          const hh = 0.35 + 0.65 * f;
          const grain = noise.fbm(x * 0.25, y * 6, N, 16, 3);
          const k = (0.9 + 0.12 * cellRand(bi, 3)) * (0.95 + 0.08 * grain) * (f > 0.94 ? 0.7 : 1);
          set(i, tint(base, k), hh, baseRough);
          break;
        }
        case 'woodSiding': {
          const bw = 0.105;
          const col_ = mx / bw;
          const bi = Math.floor(col_);
          const g = groove(col_ - bi, 0.05);
          const grain = noise.fbm(x * 8, y * 0.3, N * 8, 12, 4);
          const rv = cellRand(bi, 1);
          const c = lerp3(base, alt, rv * 0.7);
          const k = (0.85 + 0.25 * grain) * mix(0.5, 1, g);
          set(i, tint(c, k), g * (0.8 + 0.2 * grain), baseRough);
          break;
        }
        case 'galvalume': {
          const pitch = 0.2;
          const f = (mx / pitch) % 1;
          const rib = f < 0.12 ? Math.sin((f / 0.12) * Math.PI) : 0;
          const k = 0.95 + 0.06 * n2;
          set(i, tint(base, k * (1 - rib * 0.08)), 0.2 + rib * 0.8, baseRough - rib * 0.1);
          break;
        }
        case 'standingSeam': {
          const pitch = 0.45;
          const f = (mx / pitch) % 1;
          const seam = f < 0.05 ? 1 : 0;
          const k = 0.96 + 0.05 * n2;
          set(i, tint(base, k * (seam ? 1.08 : 1)), 0.3 + seam * 0.7, baseRough);
          break;
        }
        case 'brick': {
          const bw = 0.235;
          const bh = 0.068;
          const row = Math.floor(my / bh);
          const off = (row % 2) * 0.5;
          const cx = mx / bw + off;
          const ci = Math.floor(cx);
          const gx = groove(cx - ci, 0.035);
          const gy = groove(my / bh - row, 0.06);
          const g = gx * gy;
          const rv = cellRand(ci, row);
          const c = lerp3(base, alt, rv);
          const k = (0.88 + 0.18 * n2) * (0.9 + 0.2 * rv);
          set(i, g > 0.5 ? tint(c, k) : [0.62, 0.6, 0.57], g * (0.7 + 0.3 * n2), g > 0.5 ? baseRough : 0.95);
          break;
        }
        case 'stone': {
          const bw = 0.6;
          const bh = 0.3;
          const row = Math.floor(my / bh);
          const off = (row % 2) * 0.37;
          const cx = mx / bw + off;
          const ci = Math.floor(cx);
          const g = groove(cx - ci, 0.012) * groove(my / bh - row, 0.025);
          const rv = cellRand(ci, row);
          const surf = noise.fbm(x * 1.5, y * 1.5, N * 1.5, 18, 5);
          const c = lerp3(base, alt, rv * 0.8);
          set(i, tint(c, (0.85 + 0.25 * surf) * mix(0.6, 1, g)), g * (0.6 + 0.4 * surf), baseRough);
          break;
        }
        case 'concrete': {
          const pw = 1.8;
          const ph = 0.9;
          const gx = groove((mx / pw) % 1, 0.003);
          const gy = groove((my / ph) % 1, 0.006);
          // セパ穴
          const hx = ((mx / pw) * 4) % 1;
          const hy = ((my / ph) * 2) % 1;
          const hole = Math.hypot(hx - 0.5, hy - 0.5) < 0.018 ? 0 : 1;
          const k = (0.9 + 0.12 * n1 + 0.06 * n2) * mix(0.8, 1, gx * gy) * (hole ? 1 : 0.7);
          set(i, tint(base, k), gx * gy * hole * (0.8 + 0.2 * n2), baseRough);
          break;
        }
        case 'woodFloor': {
          const pw = spec.size ?? 0.15;
          const pl = spec.size2 ?? 1.2;
          const colI = Math.floor(mx / pw);
          const off = cellRand(colI, 99) * pl;
          const rowF = (my + off) / pl;
          const rowI = Math.floor(rowF);
          const gx = groove((mx / pw) % 1, 0.02);
          const gy = groove(rowF - rowI, 0.004);
          const rv = cellRand(colI, rowI);
          const grain = noise.fbm((x + rv * 300) * 6, y * 0.25, N * 6, 10, 4);
          const knots = noise.fbm(x * 2 + rv * 100, y * 0.5, N * 2, 6, 2);
          const c = lerp3(base, alt, rv * 0.8);
          const k = (0.82 + 0.3 * grain) * (0.95 + 0.1 * knots) * mix(0.6, 1, gx * gy);
          set(i, tint(c, k), gx * gy * (0.9 + 0.1 * grain), baseRough - 0.05 + 0.1 * grain);
          break;
        }
        case 'herringbone': {
          const w = 0.09;
          const L = 0.45;
          const u = mx / w;
          const v = my / w;
          const blk = Math.floor((u + v) / (L / w));
          const dir = blk % 2;
          const a = dir ? u : v;
          const b = dir ? v : u;
          const ai = Math.floor(a);
          const g = groove(a - ai, 0.04) * groove(((b + ai) / (L / w)) % 1, 0.01);
          const rv = cellRand(ai, blk);
          const grain = noise.fbm(x * (dir ? 0.3 : 6), y * (dir ? 6 : 0.3), N * 6, 10, 3);
          const c = lerp3(base, alt, rv * 0.8);
          set(i, tint(c, (0.82 + 0.3 * grain) * mix(0.6, 1, g)), g, baseRough);
          break;
        }
        case 'tileFloor':
        case 'marble': {
          const ts = spec.size ?? 0.6;
          const ts2 = spec.size2 ?? ts;
          const gx = groove((mx / ts) % 1, 0.0025 / ts);
          const gy = groove((my / ts2) % 1, 0.0025 / ts2);
          const g = gx * gy;
          let c = base;
          let k = 0.95 + 0.06 * n2;
          if (spec.pattern === 'marble') {
            const w = noise.fbm(x + 40 * n1 * N * 0.01, y, N, 6, 5);
            const vein = Math.pow(1 - Math.abs(Math.sin((mx + my * 0.6 + n1 * 3.5) * 5)), 18);
            c = lerp3(base, alt, Math.min(1, vein * 0.8 + w * 0.1));
            k = 0.97 + 0.04 * n2;
          }
          // 目地は細く淡く（ノイズになる線を抑える）
          set(i, g > 0.5 ? tint(c, k) : tint(base, 0.88), 0.6 + 0.4 * g, g > 0.5 ? baseRough : 0.8);
          break;
        }
        case 'tatami': {
          // 半畳 910x910 に斜めの目
          const cx = mx / 0.91;
          const cy = my / 0.91;
          const gx = groove(cx % 1, 0.012);
          const gy = groove(cy % 1, 0.012);
          const heri = Math.min(cx % 1, 1 - (cx % 1)) < 0.028 ? 1 : 0; // 縁
          const dir = (Math.floor(cx) + Math.floor(cy)) % 2;
          const weave = 0.5 + 0.5 * Math.sin(((dir ? mx : my) / 0.006) * Math.PI);
          const c = heri ? tint(alt, 0.9) : lerp3(base, tint(base, 0.85), weave * 0.5 + n2 * 0.2);
          set(i, c, heri ? 0.9 : 0.4 + 0.3 * weave, baseRough);
          void gx;
          void gy;
          break;
        }
        case 'slate': {
          const rh = 0.227;
          const rw = 0.91;
          const row = Math.floor(my / rh);
          const f = my / rh - row;
          const cx = mx / rw + (row % 2) * 0.5;
          const ci = Math.floor(cx);
          const gv = groove(cx - ci, 0.01);
          const hh = (0.3 + 0.7 * f) * gv;
          const rv = cellRand(ci, row);
          const k = (0.85 + 0.2 * rv) * (0.92 + 0.1 * n2) * (f > 0.95 ? 0.55 : 1);
          set(i, tint(lerp3(base, alt, rv * 0.5), k), hh, baseRough);
          break;
        }
        case 'roofTile': {
          // 桟瓦: 横方向の波 + 段
          const rh = 0.235;
          const row = Math.floor(my / rh);
          const f = my / rh - row;
          const wave = 0.5 + 0.5 * Math.cos((mx / 0.305) * Math.PI * 2);
          const hh = wave * 0.7 + f * 0.3;
          const k = (0.75 + 0.35 * wave) * (0.93 + 0.08 * n2) * (f > 0.93 ? 0.6 : 1);
          set(i, tint(lerp3(base, alt, cellRand(Math.floor(mx / 0.305), row) * 0.4), k), hh, baseRough - wave * 0.15);
          break;
        }
        case 'grass': {
          const blades = noise.fbm(x * 6, y * 6, N * 6, 64, 3);
          const patches = n1;
          const c = lerp3(base, alt, patches * 0.8 + blades * 0.2);
          set(i, tint(c, 0.8 + 0.4 * blades), blades, 0.95);
          break;
        }
        case 'asphalt': {
          const g1 = noise.fbm(x * 8, y * 8, N * 8, 128, 2);
          const speck = cellRand(x, y) > 0.985 ? 1.4 : 1;
          set(i, tint(base, (0.85 + 0.25 * g1 + 0.05 * n1) * speck), g1, 0.9);
          break;
        }
        case 'gravel': {
          const g1 = noise.fbm(x * 4, y * 4, N * 4, 64, 3);
          const c = lerp3(base, alt, cellRand(Math.floor(x / 3), Math.floor(y / 3)));
          set(i, tint(c, 0.7 + 0.5 * g1), g1, 0.95);
          break;
        }
        case 'paving': {
          const bw = 0.3;
          const bh = 0.3;
          const row = Math.floor(my / bh);
          const cx = mx / bw + (row % 2) * 0.5;
          const ci = Math.floor(cx);
          const g = groove(cx - ci, 0.03) * groove(my / bh - row, 0.03);
          const rv = cellRand(ci, row);
          set(i, g > 0.5 ? tint(lerp3(base, alt, rv), 0.9 + 0.15 * n2) : [0.45, 0.44, 0.42], g, baseRough);
          break;
        }
        case 'fabric': {
          // 織り目は画面上でモアレになりやすいので、ごく弱いむら程度に
          const slub = noise.fbm(x * 4, y * 0.5, N * 4, 32, 3);
          set(i, tint(base, 0.97 + 0.03 * slub + 0.03 * n1), slub * 0.3, baseRough);
          break;
        }
        case 'leather': {
          const g1 = noise.fbm(x * 3, y * 3, N * 3, 48, 3);
          set(i, tint(base, 0.85 + 0.2 * n1 + 0.08 * g1), g1, baseRough - 0.1 * g1);
          break;
        }
        case 'wood': {
          const grain = noise.fbm(x * 0.3 + n1 * 60, y * 8, N * 8, 10, 4);
          const ring = 0.5 + 0.5 * Math.sin((my * 60 + n1 * 12) * 1.0);
          set(i, tint(lerp3(base, alt, ring * 0.35), 0.85 + 0.25 * grain), grain * 0.5, baseRough);
          break;
        }
      }
    }
  }
  void rnd;
  return { size: N, col, h, r };
}

export interface TextureSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

function makeCanvas(n: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(n, n);
  const c = document.createElement('canvas');
  c.width = n;
  c.height = n;
  return c;
}

function toTexture(n: number, fill: (d: Uint8ClampedArray) => void, srgb: boolean): THREE.Texture {
  const c = makeCanvas(n);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const img = ctx.createImageData(n, n);
  fill(img.data);
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c as HTMLCanvasElement);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const cache = new Map<string, TextureSet>();

export function textureSet(spec: MatSpec, size = 512): TextureSet {
  const key = JSON.stringify([spec.pattern, spec.color, spec.color2, spec.roughness, spec.tile, spec.normalStrength, spec.size, spec.size2, size]);
  const hit = cache.get(key);
  if (hit) return hit;
  const b = generatePattern(spec, size);
  const n = b.size;
  const map = toTexture(
    n,
    (d) => {
      for (let i = 0; i < n * n; i++) {
        d[i * 4] = Math.min(255, b.col[i * 3] * 255);
        d[i * 4 + 1] = Math.min(255, b.col[i * 3 + 1] * 255);
        d[i * 4 + 2] = Math.min(255, b.col[i * 3 + 2] * 255);
        d[i * 4 + 3] = 255;
      }
    },
    true,
  );
  const strength = (spec.normalStrength ?? 1) * (n / tileOf(spec)) * 0.004;
  const normalMap = toTexture(
    n,
    (d) => {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const hx = b.h[y * n + ((x + 1) % n)] - b.h[y * n + ((x - 1 + n) % n)];
          const hy = b.h[((y + 1) % n) * n + x] - b.h[((y - 1 + n) % n) * n + x];
          let nx = -hx * strength * 10;
          let ny = hy * strength * 10;
          let nz = 1;
          const l = Math.hypot(nx, ny, nz);
          nx /= l;
          ny /= l;
          nz /= l;
          const i = (y * n + x) * 4;
          d[i] = (nx * 0.5 + 0.5) * 255;
          d[i + 1] = (ny * 0.5 + 0.5) * 255;
          d[i + 2] = (nz * 0.5 + 0.5) * 255;
          d[i + 3] = 255;
        }
      }
    },
    false,
  );
  const roughnessMap = toTexture(
    n,
    (d) => {
      for (let i = 0; i < n * n; i++) {
        const v = Math.max(0.02, Math.min(1, b.r[i])) * 255;
        d[i * 4] = v;
        d[i * 4 + 1] = v; // G チャンネルが roughness
        d[i * 4 + 2] = v;
        d[i * 4 + 3] = 255;
      }
    },
    false,
  );
  const set = { map, normalMap, roughnessMap };
  cache.set(key, set);
  return set;
}

const matCache = new Map<string, THREE.MeshStandardMaterial>();

/**
 * マテリアル生成。ジオメトリの UV はメートル単位で作るので、repeat = 1/tile。
 */
export function makeMaterial(spec: MatSpec, opts: { side?: THREE.Side; size?: number } = {}): THREE.MeshStandardMaterial {
  const key = JSON.stringify([spec, opts.side ?? 0]);
  const hit = matCache.get(key);
  if (hit) return hit;
  const flat = spec.pattern === 'paint' && !spec.normalStrength;
  let mat: THREE.MeshStandardMaterial;
  if (flat) {
    mat = new THREE.MeshStandardMaterial({ color: spec.color, roughness: spec.roughness ?? 0.85, metalness: spec.metalness ?? 0 });
  } else {
    const t = textureSet(spec, opts.size ?? 512);
    const rep = 1 / tileOf(spec);
    const cl = (tx: THREE.Texture) => {
      const c = tx.clone();
      c.repeat.set(rep, rep);
      c.needsUpdate = true;
      return c;
    };
    mat = new THREE.MeshStandardMaterial({
      map: cl(t.map),
      normalMap: cl(t.normalMap),
      roughnessMap: cl(t.roughnessMap),
      roughness: 1,
      metalness: spec.metalness ?? 0,
    });
    mat.normalScale.set(1, 1);
  }
  if (spec.emissive) {
    mat.emissive = new THREE.Color(spec.emissive);
    mat.emissiveIntensity = spec.emissiveIntensity ?? 1;
  }
  if (opts.side !== undefined) mat.side = opts.side;
  mat.name = spec.pattern;
  matCache.set(key, mat);
  return mat;
}

export function clearMaterialCache() {
  for (const m of matCache.values()) m.dispose();
  matCache.clear();
}

const leafCache = new Map<string, THREE.Texture>();

/** 葉の集まりを描いたアルファ付きテクスチャ（植栽用） */
export function leafCardTexture(color: string, color2: string, seed = 3, leafLen = 0.09): THREE.Texture {
  const key = [color, color2, seed, leafLen].join();
  const hit = leafCache.get(key);
  if (hit) return hit;
  const N = 512;
  const c = makeCanvas(N) as HTMLCanvasElement;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, N, N);
  const rnd = mulberry32(seed);
  const a = new THREE.Color(color);
  const b = new THREE.Color(color2);
  const count = Math.round(260 * (0.09 / leafLen));
  for (let i = 0; i < count; i++) {
    // 中心ほど密に
    const r = Math.sqrt(rnd()) * N * 0.46;
    const t = rnd() * Math.PI * 2;
    const x = N / 2 + Math.cos(t) * r;
    const y = N / 2 + Math.sin(t) * r;
    const len = N * leafLen * (0.7 + rnd() * 0.6);
    const col = a.clone().lerp(b, rnd()).multiplyScalar(0.8 + rnd() * 0.4);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rnd() * Math.PI * 2);
    ctx.fillStyle = `rgb(${Math.min(255, col.r * 255)},${Math.min(255, col.g * 255)},${Math.min(255, col.b * 255)})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, len / 2, len / 5.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  leafCache.set(key, tex);
  return tex;
}
