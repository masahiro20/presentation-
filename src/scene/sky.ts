/**
 * 手続き的 HDR 空（正距円筒図法）。リアルタイム用の環境光とパストレーサーの光源を兼ねる。
 */
import * as THREE from 'three';

export interface SkyParams {
  /** 太陽方向（ワールド、単位ベクトル） */
  sunDir: THREE.Vector3;
  /** 'day' | 'evening' | 'night' */
  mode: 'day' | 'evening' | 'night';
  /** 太陽円盤を含めるか（パストレーサー用） */
  sunDisk: boolean;
  width?: number;
  /** 地面の反射色 */
  groundColor?: THREE.Color;
  sunIntensity?: number;
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function makeSkyTexture(p: SkyParams): THREE.DataTexture {
  const W = p.width ?? 512;
  const H = W / 2;
  const data = new Float32Array(W * H * 4);
  const sun = p.sunDir.clone().normalize();
  const sunElev = Math.asin(Math.max(-1, Math.min(1, sun.y)));
  const dayF = smoothstep(-0.1, 0.25, sunElev);
  const low = 1 - smoothstep(0.0, 0.5, sunElev);
  let zenith: THREE.Color;
  let horizon: THREE.Color;
  let glowCol: THREE.Color;
  if (p.mode === 'night') {
    zenith = new THREE.Color(0.004, 0.008, 0.025);
    horizon = new THREE.Color(0.03, 0.04, 0.08);
    glowCol = new THREE.Color(0.02, 0.02, 0.04);
  } else {
    zenith = new THREE.Color(0.22, 0.38, 0.72).lerp(new THREE.Color(0.12, 0.18, 0.45), low * 0.6).multiplyScalar(0.35 + 0.65 * dayF);
    horizon = new THREE.Color(0.82, 0.86, 0.9).lerp(new THREE.Color(1.0, 0.62, 0.35), low * (p.mode === 'evening' ? 0.95 : 0.55)).multiplyScalar(0.45 + 0.75 * dayF);
    glowCol = new THREE.Color(1.0, 0.85, 0.6).lerp(new THREE.Color(1.0, 0.45, 0.15), low);
  }
  const ground = p.groundColor ?? new THREE.Color(0.3, 0.28, 0.22);
  const sunI = p.sunIntensity ?? (p.mode === 'night' ? 0 : 60000 * (0.1 + 0.9 * dayF));
  const sunCos = Math.cos((0.53 * Math.PI) / 180 / 2 * 2.2);
  const dir = new THREE.Vector3();
  for (let y = 0; y < H; y++) {
    // three.js の equirectUv: u = atan(z,x)/2π + 0.5, v = asin(y)/π + 0.5（DataTexture は 1 行目が v=0）
    const el = ((y + 0.5) / H - 0.5) * Math.PI;
    for (let x = 0; x < W; x++) {
      const az = ((x + 0.5) / W - 0.5) * Math.PI * 2;
      dir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
      const i = (y * W + x) * 4;
      let r: number;
      let g: number;
      let b: number;
      if (dir.y >= 0) {
        const t = Math.pow(1 - dir.y, 3);
        r = zenith.r + (horizon.r - zenith.r) * t;
        g = zenith.g + (horizon.g - zenith.g) * t;
        b = zenith.b + (horizon.b - zenith.b) * t;
        const cosS = dir.dot(sun);
        const glow = Math.pow(Math.max(0, cosS), 8) * 0.8 + Math.pow(Math.max(0, cosS), 64) * 2.0;
        const gk = p.mode === 'night' ? 0 : glow * (0.4 + low) * dayF;
        r += glowCol.r * gk;
        g += glowCol.g * gk;
        b += glowCol.b * gk;
        if (p.sunDisk && cosS > sunCos && sun.y > -0.02) {
          r += sunI * glowCol.r * 0.9 + sunI * 0.1;
          g += sunI * glowCol.g * 0.9 + sunI * 0.1;
          b += sunI * glowCol.b * 0.9 + sunI * 0.1;
        }
        if (p.mode === 'night') {
          // 星
          const hsh = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
          if (hsh - Math.floor(hsh) > 0.9985 && dir.y > 0.15) {
            r += 0.6;
            g += 0.6;
            b += 0.7;
          }
        }
      } else {
        const k = (p.mode === 'night' ? 0.05 : 0.35 + 0.6 * dayF) * (0.6 + 0.4 * Math.pow(1 + dir.y, 4));
        r = ground.r * k + horizon.r * 0.15 * Math.pow(1 + dir.y, 8);
        g = ground.g * k + horizon.g * 0.15 * Math.pow(1 + dir.y, 8);
        b = ground.b * k + horizon.b * 0.15 * Math.pow(1 + dir.y, 8);
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
