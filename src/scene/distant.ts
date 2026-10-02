/**
 * 遠景（敷地のまわりの木立のシルエット）
 * 地平線まで何もない地面は CG らしさの大きな原因になる。敷地を中心とした大きな円筒の帯に、
 * 手続き的に描いた木立の絵（透過）を貼る。パストレーサーでも軽い（1 枚の帯）。
 */
import * as THREE from 'three';
import { mulberry32 } from '../styles/noise';

let tex: THREE.Texture | null = null;

function treeLineTexture(): THREE.Texture {
  if (tex) return tex;
  const W = 2048;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);
  const rnd = mulberry32(17);
  // 奥の列（淡く・低め）→ 手前の列（濃く・高め）
  const rows = [
    { base: 0.62, h: 0.35, col: [118, 132, 112], n: 70, r: [18, 40] },
    { base: 0.78, h: 0.55, col: [84, 102, 74], n: 55, r: [24, 60] },
    { base: 0.92, h: 0.75, col: [62, 80, 54], n: 40, r: [30, 80] },
  ];
  for (const row of rows) {
    for (let i = 0; i < row.n; i++) {
      const x = (i / row.n) * W + rnd() * (W / row.n);
      const top = H * (1 - row.h * (0.55 + rnd() * 0.45));
      const r = row.r[0] + rnd() * (row.r[1] - row.r[0]);
      const k = 0.85 + rnd() * 0.3;
      ctx.fillStyle = `rgb(${row.col[0] * k | 0},${row.col[1] * k | 0},${row.col[2] * k | 0})`;
      // 樹冠: いくつかの円を重ねる（左右の端でつながるよう、はみ出しは反対側にも描く）
      for (const dx of [0, -W, W]) {
        ctx.beginPath();
        for (let j = 0; j < 6; j++) {
          const cx = x + dx + (rnd() - 0.5) * r * 1.2;
          const cy = top + r * 0.6 + rnd() * r * 0.8;
          ctx.moveTo(cx + r * 0.6, cy);
          ctx.arc(cx, cy, r * (0.45 + rnd() * 0.35), 0, Math.PI * 2);
        }
        ctx.rect(x + dx - r * 0.7, top + r, r * 1.4, H * row.base - top);
        ctx.fill();
      }
    }
    ctx.fillRect(0, H * row.base, W, H * (1 - row.base));
  }
  tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** 敷地の中心 (cx, cz) を囲む遠景の帯 */
export function distantTreeBand(cx: number, cz: number, radius = 90, height = 9): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(radius, radius, height, 96, 1, true);
  geo.translate(0, height / 2 - 0.3, 0);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 5);
  const mat = new THREE.MeshStandardMaterial({ map: treeLineTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, color: '#ffffff' });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(cx, 0, cz);
  m.castShadow = false;
  m.receiveShadow = false;
  m.name = 'distant';
  return m;
}
