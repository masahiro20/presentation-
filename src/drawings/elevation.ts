/**
 * 立面図の自動作成
 *  - 3D モデルを正投影し、特徴線（稜線・輪郭線）を深度バッファで隠線処理してベクター線に
 *  - 塗り（カラー立面）は同じ正投影のレンダリング画像
 *  - GL・各階 FL・軒高・最高高さの寸法、方位名を記入
 */
import * as THREE from 'three';
import type { Viewer } from '../scene/viewer';

export type ElevationDir = 'south' | 'north' | 'east' | 'west';

export interface ElevationOptions {
  /** 1px あたりの mm（隠線処理の解像度） */
  mmPerPx?: number;
  color?: boolean;
}

export interface ElevationResult {
  dir: ElevationDir;
  title: string;
  svg: string;
  widthMm: number;
  heightMm: number;
}

const JP: Record<ElevationDir, string> = { south: '南', north: '北', east: '東', west: '西' };

/**
 * 真北の角度から、各方位の立面を見る方向（ワールド、カメラの視線方向）を求める。
 * 建物の軸に揃えるため 90° 単位に丸める。
 */
export function elevationViewDir(dir: ElevationDir, northAngleDeg: number): THREE.Vector3 {
  const a = (northAngleDeg * Math.PI) / 180;
  const north = new THREE.Vector2(Math.sin(a), -Math.cos(a));
  const cands = [new THREE.Vector2(0, -1), new THREE.Vector2(1, 0), new THREE.Vector2(0, 1), new THREE.Vector2(-1, 0)];
  const snap = (v: THREE.Vector2) => cands.slice().sort((p, q) => q.dot(v) - p.dot(v))[0];
  const nAxis = snap(north);
  // 図面座標（y 下向き）で北を時計回りに 90° 回すと東
  const eAxis = new THREE.Vector2(-nAxis.y, nAxis.x);
  // 南立面図 = 南側から北を見る → 視線は北向き
  const face: Record<ElevationDir, THREE.Vector2> = {
    south: nAxis.clone(),
    north: nAxis.clone().negate(),
    east: eAxis.clone().negate(),
    west: eAxis.clone(),
  };
  const v = face[dir];
  return new THREE.Vector3(v.x, 0, v.y);
}

interface EdgeSeg {
  a: THREE.Vector3;
  b: THREE.Vector3;
}

function collectEdges(roots: THREE.Object3D[], thresholdDeg: number): EdgeSeg[] {
  const out: EdgeSeg[] = [];
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.visible) return;
      const key = m.userData.matKey as string | undefined;
      if (!key) return;
      // 室内・家具の線は不要（窓越しの線は隠線処理でも消えるが、処理量削減）
      if (key.startsWith('int.') || key.startsWith('f.')) return;
      const eg = new THREE.EdgesGeometry(m.geometry, thresholdDeg);
      const pos = eg.getAttribute('position');
      for (let i = 0; i < pos.count; i += 2) {
        const a = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(m.matrixWorld);
        out.push({ a, b });
      }
      eg.dispose();
    });
  }
  return out;
}

export function renderElevation(viewer: Viewer, dir: ElevationDir, opts: ElevationOptions = {}): ElevationResult {
  const st = viewer.state!;
  const model = st.model;
  const viewDir = elevationViewDir(dir, model.northAngleDeg);
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(viewDir, up).normalize(); // 画面右
  const roots = [viewer.groups.building, viewer.groups.roof];

  // 範囲
  const box = new THREE.Box3();
  for (const r of roots) box.expandByObject(r);
  const corners: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
  const us = corners.map((c) => c.dot(right));
  const ds = corners.map((c) => c.dot(viewDir));
  const uMin = Math.min(...us) - 0.3;
  const uMax = Math.max(...us) + 0.3;
  const yMin = -0.2;
  const yMax = box.max.y + 0.3;
  const dMin = Math.min(...ds) - 1;
  const dMax = Math.max(...ds) + 1;
  const mmPerPx = opts.mmPerPx ?? 8;
  const W = Math.ceil(((uMax - uMin) * 1000) / mmPerPx);
  const H = Math.ceil(((yMax - yMin) * 1000) / mmPerPx);

  // 正投影カメラ（視線 = viewDir）
  const center = right.clone().multiplyScalar((uMin + uMax) / 2).add(new THREE.Vector3(0, (yMin + yMax) / 2, 0));
  const cam = new THREE.OrthographicCamera(-(uMax - uMin) / 2, (uMax - uMin) / 2, (yMax - yMin) / 2, -(yMax - yMin) / 2, 0.01, dMax - dMin + 2);
  cam.position.copy(center).addScaledVector(viewDir, dMin - 1);
  cam.up.set(0, 1, 0);
  cam.lookAt(cam.position.clone().add(viewDir));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();

  const renderer = viewer.renderer;
  const scene = viewer.scene;
  // 他のグループを隠す
  const vis = Object.fromEntries(Object.entries(viewer.groups).map(([k, g]) => [k, g.visible]));
  for (const [k, g] of Object.entries(viewer.groups)) g.visible = k === 'building' || k === 'roof';
  const prevClip = renderer.clippingPlanes;
  renderer.clippingPlanes = [];
  // ---- 深度マップ ----
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType });
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  const prevOverride = scene.overrideMaterial;
  const prevBg = scene.background;
  scene.overrideMaterial = depthMat;
  scene.background = null;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0xffffff, 1);
  renderer.clear();
  renderer.render(scene, cam);
  const buf = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = prevOverride;
  const unpack = (i: number) => {
    // RGBADepthPacking の逆変換
    const r = buf[i] / 255;
    const g = buf[i + 1] / 255;
    const b = buf[i + 2] / 255;
    const a = buf[i + 3] / 255;
    return r * (255 / 256) + g * (255 / 256 / 256) + b * (255 / 256 / 256 / 256) + a * (255 / 256 / 256 / 256 / 256);
  };

  // ---- 塗りの画像 ----
  let fillUrl = '';
  if (opts.color !== false) {
    const prevSize = renderer.getSize(new THREE.Vector2());
    const prevPR = renderer.getPixelRatio();
    const prevTM = renderer.toneMappingExposure;
    const prevEnvI = scene.environmentIntensity;
    const sunVis = viewer.sun.visible;
    const sunPos = viewer.sun.position.clone();
    renderer.setPixelRatio(1);
    const scale = Math.min(1, 2400 / Math.max(W, H));
    renderer.setSize(Math.round(W * scale * 1.0), Math.round(H * scale), false);
    scene.background = new THREE.Color('#ffffff');
    // 左上から柔らかい光
    viewer.sun.visible = true;
    const c0 = box.getCenter(new THREE.Vector3());
    viewer.sun.position.copy(c0).addScaledVector(viewDir, -40).addScaledVector(right, -25).add(new THREE.Vector3(0, 45, 0));
    viewer.sun.target.position.copy(c0);
    viewer.sun.target.updateMatrixWorld();
    scene.environmentIntensity = 0.9;
    renderer.toneMappingExposure = 1.05;
    renderer.setRenderTarget(null);
    renderer.render(scene, cam);
    fillUrl = renderer.domElement.toDataURL('image/png');
    renderer.setSize(prevSize.x, prevSize.y, false);
    renderer.setPixelRatio(prevPR);
    renderer.toneMappingExposure = prevTM;
    scene.environmentIntensity = prevEnvI;
    viewer.sun.visible = sunVis;
    viewer.sun.position.copy(sunPos);
  }
  scene.background = prevBg;
  renderer.clippingPlanes = prevClip;
  for (const [k, g] of Object.entries(viewer.groups)) g.visible = vis[k];
  depthMat.dispose();
  rt.dispose();
  viewer.resize();

  // ---- 隠線処理 ----
  const edges = collectEdges(roots, 25);
  const toPx = (p: THREE.Vector3) => {
    const u = p.dot(right);
    const d = p.dot(viewDir);
    return { x: ((u - uMin) * 1000) / mmPerPx, y: ((yMax - p.y) * 1000) / mmPerPx, depth: (d - (dMin - 1) - cam.near) / (cam.far - cam.near) };
  };
  const visible = (x: number, y: number, depth: number) => {
    let best = 1;
    const xi = Math.round(x);
    const yi = Math.round(y);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const px = xi + dx;
        const py = yi + dy;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        // readPixels は下から上
        const i = ((H - 1 - py) * W + px) * 4;
        best = Math.min(best, unpack(i));
      }
    return depth <= best + 0.0035;
  };
  const lines: string[] = [];
  const outline: string[] = [];
  for (const e of edges) {
    const A = toPx(e.a);
    const B = toPx(e.b);
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    if (len < 0.5) continue;
    // 視線方向と平行な線（点に潰れる）は除外済み。サンプリングして可視区間を抽出
    const n = Math.max(2, Math.ceil(len / 1.5));
    let runStart: number | null = null;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = A.x + (B.x - A.x) * t;
      const y = A.y + (B.y - A.y) * t;
      const d = A.depth + (B.depth - A.depth) * t;
      const vis = visible(x, y, d);
      if (vis && runStart == null) runStart = t;
      if ((!vis || i === n) && runStart != null) {
        const tEnd = vis ? t : (i - 1) / n;
        if (tEnd - runStart > 0.5 / n) {
          const x0 = (A.x + (B.x - A.x) * runStart) * mmPerPx;
          const y0 = (A.y + (B.y - A.y) * runStart) * mmPerPx;
          const x1 = (A.x + (B.x - A.x) * tEnd) * mmPerPx;
          const y1 = (A.y + (B.y - A.y) * tEnd) * mmPerPx;
          lines.push(`M${x0.toFixed(0)} ${y0.toFixed(0)}L${x1.toFixed(0)} ${y1.toFixed(0)}`);
        }
        runStart = null;
      }
    }
  }
  void outline;

  // ---- 注記 ----
  const Wmm = (uMax - uMin) * 1000;
  const Hmm = (yMax - yMin) * 1000;
  const yOf = (worldY: number) => (yMax - worldY) * 1000;
  const glY = yOf(0);
  const levels: { label: string; y: number }[] = [{ label: '▽GL±0', y: 0 }];
  for (const f of model.floors) levels.push({ label: `▽${f.level}FL +${f.elevation}`, y: f.elevation / 1000 });
  const eaveY = st.roof.eaveY || st.meta.topY;
  levels.push({ label: `▽軒高 +${Math.round(eaveY * 1000)}`, y: eaveY });
  const maxY = Math.max(st.roof.maxY, st.meta.topY);
  levels.push({ label: `▽最高高さ +${Math.round(maxY * 1000)}`, y: maxY });
  const pad = 2600;
  const vbX = -pad;
  const vbY = -1400;
  const vbW = Wmm + pad * 2 + 2400;
  const vbH = Hmm + 1400 + 1800;
  const dimX = Wmm + 700;
  let ann = '';
  // GL
  ann += `<line x1="${-1500}" y1="${glY}" x2="${Wmm + 1500}" y2="${glY}" stroke="#111" stroke-width="45"/>`;
  for (const lv of levels) {
    const y = yOf(lv.y);
    ann += `<line x1="${Wmm + 100}" y1="${y}" x2="${dimX + 300}" y2="${y}" stroke="#555" stroke-width="10" stroke-dasharray="60 30"/>`;
    ann += `<text x="${dimX + 380}" y="${y - 40}" font-size="190" fill="#222">${lv.label}</text>`;
  }
  // 高さ寸法
  const sortedLv = levels.slice().sort((a, b) => a.y - b.y);
  for (let i = 0; i + 1 < sortedLv.length; i++) {
    const y0 = yOf(sortedLv[i].y);
    const y1 = yOf(sortedLv[i + 1].y);
    if (Math.abs(y0 - y1) < 50) continue;
    ann += `<line x1="${dimX}" y1="${y0}" x2="${dimX}" y2="${y1}" stroke="#333" stroke-width="12"/>`;
    for (const y of [y0, y1]) ann += `<line x1="${dimX - 60}" y1="${y + 60}" x2="${dimX + 60}" y2="${y - 60}" stroke="#333" stroke-width="16"/>`;
    ann += `<text x="${dimX - 90}" y="${(y0 + y1) / 2}" font-size="150" fill="#333" text-anchor="middle" transform="rotate(-90 ${dimX - 90} ${(y0 + y1) / 2})">${Math.round(Math.abs(y0 - y1))}</text>`;
  }
  const title = `${JP[dir]}立面図`;
  ann += `<text x="${Wmm / 2}" y="${glY + 1200}" font-size="330" text-anchor="middle" fill="#111" font-weight="bold">${title}</text>`;
  ann += `<text x="${Wmm / 2}" y="${glY + 1550}" font-size="190" text-anchor="middle" fill="#555">S=1/100</text>`;

  const img = fillUrl ? `<image href="${fillUrl}" x="0" y="0" width="${Wmm}" height="${Hmm}" preserveAspectRatio="none" opacity="0.92"/>` : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" font-family="'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif">` +
    `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="#fff"/>` +
    img +
    `<path d="${lines.join('')}" stroke="#1a1a1a" stroke-width="20" fill="none" stroke-linecap="round"/>` +
    ann +
    `</svg>`;
  return { dir, title, svg, widthMm: vbW, heightMm: vbH };
}
