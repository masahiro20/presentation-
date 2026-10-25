/**
 * 画像の仕上げと書き出し用のマテリアル調整（GPU パストレーシングは外し、外部ツールで仕上げる方針に変更）
 * - finishPhoto: 下絵（カット集・資料の下書き）を写真らしく整える（ブルーム・トーンカーブ・粒子・周辺減光）
 * - prepareMaterials / restoreMaterials: 3D の書き出し（AR・glTF）でガラスなどを物理的な値に一時変更
 */
import * as THREE from 'three';
import type { TimeOfDay } from '../styles/presets';

export interface Saved {
  mat: THREE.Material;
  props: Record<string, unknown>;
}

/** 書き出し用にマテリアルを物理的な値へ一時変更 */
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
