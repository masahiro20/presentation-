/** 軽量な値ノイズ / fBm（テクスチャ生成用） */

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ValueNoise {
  private perm: Uint8Array;
  private vals: Float32Array;
  constructor(seed = 1) {
    const rnd = mulberry32(seed);
    this.perm = new Uint8Array(512);
    this.vals = new Float32Array(256);
    const p = [...Array(256).keys()];
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) this.vals[i] = rnd();
  }

  /** 周期 period の値ノイズ（タイル可能） */
  noise2(x: number, y: number, period = 256): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const P = this.perm;
    const m = (k: number) => ((k % period) + period) % period & 255;
    const x0 = m(xi);
    const x1 = m(xi + 1);
    const y0 = m(yi);
    const y1 = m(yi + 1);
    const a = this.vals[P[P[x0] + y0]];
    const b = this.vals[P[P[x1] + y0]];
    const c = this.vals[P[P[x0] + y1]];
    const d = this.vals[P[P[x1] + y1]];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /** タイル可能な fBm。x,y は 0..size、scale はセル数 */
  fbm(x: number, y: number, size: number, cells: number, octaves = 4): number {
    let amp = 0.5;
    let sum = 0;
    let norm = 0;
    let c = cells;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise2((x / size) * c, (y / size) * c, c);
      norm += amp;
      amp *= 0.5;
      c *= 2;
    }
    return sum / norm;
  }
}
