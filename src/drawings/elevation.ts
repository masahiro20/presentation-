/**
 * 立面図・断面図の自動作成
 *  - 3D モデルを正投影し、特徴線（稜線・輪郭線）を深度バッファで隠線処理してベクター線に
 *  - 塗り（カラー立面）は同じ正投影のレンダリング画像
 *  - 立面図: GL・各階 FL・軒高・最高高さの寸法、方位名を記入
 *  - 断面図: 切断した建物（切り口は濃い塗り）に GL・FL・天井高・最高高さの寸法を記入
 */
import * as THREE from 'three';
import type { Viewer, SectionSpec } from '../scene/viewer';
import { wrapSheet, type SheetInfo, type Vb } from './sheet';

export type ElevationDir = 'south' | 'north' | 'east' | 'west';

export interface ElevationOptions {
  /** 1px あたりの mm（隠線処理の解像度） */
  mmPerPx?: number;
  color?: boolean;
  /** 図枠に入れる */
  sheet?: SheetInfo;
}

export interface ElevationResult {
  dir: ElevationDir | 'section';
  title: string;
  svg: string;
  widthMm: number;
  heightMm: number;
  /** 図枠に流し込むための中身（図面 mm 単位）と範囲 */
  inner: string;
  vb: Vb;
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

function collectEdges(roots: THREE.Object3D[], thresholdDeg: number, includeInterior: boolean): EdgeSeg[] {
  const out: EdgeSeg[] = [];
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.visible || !m.geometry) return;
      // 親が非表示なら描かない
      let p: THREE.Object3D | null = m.parent;
      while (p && p !== root) {
        if (!p.visible) return;
        p = p.parent;
      }
      const key = m.userData.matKey as string | undefined;
      if (!key) return;
      // 家具の線は不要。室内の線は断面図でだけ使う
      if (key.startsWith('f.')) return;
      if (!includeInterior && key.startsWith('int.')) return;
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

interface OrthoParams {
  viewDir: THREE.Vector3;
  /** 描く対象のグループ名（viewer.groups のキー） */
  groups: string[];
  mmPerPx: number;
  color: boolean;
  includeInterior: boolean;
}

interface OrthoResult {
  lines: string[];
  fillUrl: string;
  Wmm: number;
  Hmm: number;
  yMax: number;
  box: THREE.Box3;
}

/** 正投影の線画＋塗り（立面図・断面図の共通部分） */
function orthoDrawing(viewer: Viewer, p: OrthoParams): OrthoResult {
  const viewDir = p.viewDir;
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(viewDir, up).normalize(); // 画面右
  const roots = p.groups.map((k) => (viewer.groups as Record<string, THREE.Group>)[k]);

  // 範囲（見えている Mesh だけ）
  const box = new THREE.Box3();
  for (const r of roots) {
    r.updateMatrixWorld(true);
    r.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.visible || !m.geometry) return;
      let q: THREE.Object3D | null = m.parent;
      while (q && q !== r) {
        if (!q.visible) return;
        q = q.parent;
      }
      if (m.userData.roomLabel) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld));
    });
  }
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
  const mmPerPx = p.mmPerPx;
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
  for (const [k, g] of Object.entries(viewer.groups)) g.visible = p.groups.includes(k);
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
    const r = buf[i] / 255;
    const g = buf[i + 1] / 255;
    const b = buf[i + 2] / 255;
    const a = buf[i + 3] / 255;
    return r * (255 / 256) + g * (255 / 256 / 256) + b * (255 / 256 / 256 / 256) + a * (255 / 256 / 256 / 256 / 256);
  };

  // ---- 塗りの画像 ----
  let fillUrl = '';
  if (p.color) {
    const prevSize = renderer.getSize(new THREE.Vector2());
    const prevPR = renderer.getPixelRatio();
    const prevTM = renderer.toneMappingExposure;
    const prevEnvI = scene.environmentIntensity;
    const sunVis = viewer.sun.visible;
    const sunPos = viewer.sun.position.clone();
    // 図面の塗りは影を落とさない均一な光で（影の有無で面の明るさが変わらないように）
    const prevCast = viewer.sun.castShadow;
    viewer.sun.castShadow = false;
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
    viewer.sun.castShadow = prevCast;
  }
  scene.background = prevBg;
  renderer.clippingPlanes = prevClip;
  for (const [k, g] of Object.entries(viewer.groups)) g.visible = vis[k];
  depthMat.dispose();
  rt.dispose();
  viewer.resize();

  // ---- 隠線処理 ----
  const edges = collectEdges(roots, 25, p.includeInterior);
  const toPx = (q: THREE.Vector3) => {
    const u = q.dot(right);
    const d = q.dot(viewDir);
    return { x: ((u - uMin) * 1000) / mmPerPx, y: ((yMax - q.y) * 1000) / mmPerPx, depth: (d - (dMin - 1) - cam.near) / (cam.far - cam.near) };
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
        const i = ((H - 1 - py) * W + px) * 4;
        best = Math.min(best, unpack(i));
      }
    return depth <= best + 0.0035;
  };
  const lines: string[] = [];
  for (const e of edges) {
    const A = toPx(e.a);
    const B = toPx(e.b);
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    if (len < 0.5) continue;
    const n = Math.max(2, Math.ceil(len / 1.5));
    let runStart: number | null = null;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = A.x + (B.x - A.x) * t;
      const y = A.y + (B.y - A.y) * t;
      const d = A.depth + (B.depth - A.depth) * t;
      const v = visible(x, y, d);
      if (v && runStart == null) runStart = t;
      if ((!v || i === n) && runStart != null) {
        const tEnd = v ? t : (i - 1) / n;
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
  return { lines, fillUrl, Wmm: (uMax - uMin) * 1000, Hmm: (yMax - yMin) * 1000, yMax, box };
}

interface LevelMark {
  label: string;
  y: number;
  /** 寸法の連鎖に使う */
  dim?: boolean;
}

/** 注記（GL 線・レベル・高さ寸法・図面名）と SVG の組み立て */
function compose(o: OrthoResult, levels: LevelMark[], title: string, subtitle: string, sheet?: SheetInfo): { svg: string; vb: Vb; inner: string } {
  const yOf = (worldY: number) => (o.yMax - worldY) * 1000;
  const glY = yOf(0);
  const pad = 2600;
  const vb: Vb = { x: -pad, y: -1400, w: o.Wmm + pad * 2 + 3600, h: o.Hmm + 1400 + (sheet ? 600 : 1800) };
  const dimX = o.Wmm + 700;
  let ann = '';
  ann += `<line x1="${-1500}" y1="${glY}" x2="${o.Wmm + 1500}" y2="${glY}" stroke="#111" stroke-width="45"/>`;
  for (const lv of levels) {
    const y = yOf(lv.y);
    ann += `<line x1="${o.Wmm + 100}" y1="${y}" x2="${dimX + 300}" y2="${y}" stroke="#555" stroke-width="10" stroke-dasharray="60 30"/>`;
    ann += `<text x="${dimX + 380}" y="${y - 40}" font-size="170" fill="#222">${lv.label}</text>`;
  }
  const dimLv = levels.filter((l) => l.dim !== false).slice().sort((a, b) => a.y - b.y);
  for (let i = 0; i + 1 < dimLv.length; i++) {
    const y0 = yOf(dimLv[i].y);
    const y1 = yOf(dimLv[i + 1].y);
    if (Math.abs(y0 - y1) < 50) continue;
    ann += `<line x1="${dimX}" y1="${y0}" x2="${dimX}" y2="${y1}" stroke="#333" stroke-width="12"/>`;
    for (const y of [y0, y1]) ann += `<line x1="${dimX - 60}" y1="${y + 60}" x2="${dimX + 60}" y2="${y - 60}" stroke="#333" stroke-width="16"/>`;
    ann += `<text x="${dimX - 90}" y="${(y0 + y1) / 2}" font-size="150" fill="#333" text-anchor="middle" transform="rotate(-90 ${dimX - 90} ${(y0 + y1) / 2})">${Math.round(Math.abs(y0 - y1))}</text>`;
  }
  // 図面名（縮尺はシートの表題欄に書く）
  ann += `<text x="${o.Wmm / 2}" y="${glY + 1200}" font-size="330" text-anchor="middle" fill="#111" font-weight="bold">${title}</text>`;
  void subtitle;
  const img = o.fillUrl ? `<image href="${o.fillUrl}" x="0" y="0" width="${o.Wmm}" height="${o.Hmm}" preserveAspectRatio="none" opacity="0.92"/>` : '';
  const inner = img + `<path d="${o.lines.join('')}" stroke="#1a1a1a" stroke-width="20" fill="none" stroke-linecap="round"/>` + ann;
  if (sheet) return { svg: wrapSheet(inner, vb, sheet), vb, inner };
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" font-family="'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif">` +
    `<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="#fff"/>` +
    inner +
    `</svg>`;
  return { svg, vb, inner };
}

export function renderElevation(viewer: Viewer, dir: ElevationDir, opts: ElevationOptions = {}): ElevationResult {
  const st = viewer.state!;
  const model = st.model;
  const viewDir = elevationViewDir(dir, model.northAngleDeg);
  const o = orthoDrawing(viewer, { viewDir, groups: ['building', 'roof'], mmPerPx: opts.mmPerPx ?? 8, color: opts.color !== false, includeInterior: false });
  const levels: LevelMark[] = [{ label: '▽GL±0', y: 0 }];
  for (const f of model.floors) levels.push({ label: `▽${f.level}FL +${f.elevation}`, y: f.elevation / 1000 });
  const eaveY = st.roof.eaveY || st.meta.topY;
  levels.push({ label: `▽軒高 +${Math.round(eaveY * 1000)}`, y: eaveY });
  const maxY = Math.max(st.roof.maxY, st.meta.topY);
  levels.push({ label: `▽最高高さ +${Math.round(maxY * 1000)}`, y: maxY });
  const title = `${JP[dir]}立面図`;
  const { svg, vb, inner } = compose(o, levels, title, 'S=1/100', opts.sheet ? { ...opts.sheet, drawing: opts.sheet.drawing || title } : undefined);
  return { dir, title, svg, widthMm: vb.w, heightMm: vb.h, inner, vb };
}

/**
 * 断面図: 鉛直の切断面で切った建物を、取り除いた側から正投影で描く。
 * 切り口は濃い塗りにし、GL・各階 FL・天井高・軒高・最高高さを記入する
 */
export function renderSection(viewer: Viewer, sec: SectionSpec, label: string, opts: ElevationOptions = {}): ElevationResult {
  const st = viewer.state!;
  const model = st.model;
  const prevCut = viewer.currentCut();
  viewer.setSection(sec);
  const cut = viewer.groups.cut;
  // 家具・部屋名・方位は描かない
  const hidden: THREE.Object3D[] = [];
  for (const ch of cut.children) {
    const keep = ch.name === 'cut-building' || ch.name === 'cut-roof' || ch.name.startsWith('cutdoor:');
    if (!keep && ch.visible) {
      ch.visible = false;
      hidden.push(ch);
    }
  }
  // 切り口は濃い塗り
  const dark = new THREE.MeshStandardMaterial({ color: '#4a4a4a', roughness: 1 });
  const swapped: THREE.Mesh[] = [];
  cut.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (m.isMesh && m.userData.matKey === 'cut.face') {
      m.material = dark;
      swapped.push(m);
    }
  });
  let o: OrthoResult;
  try {
    const viewDir = new THREE.Vector3(-sec.nx, 0, -sec.nz).normalize();
    o = orthoDrawing(viewer, { viewDir, groups: ['cut'], mmPerPx: opts.mmPerPx ?? 8, color: opts.color !== false, includeInterior: true });
  } finally {
    for (const m of swapped) m.material = viewer.registry.get('cut.face');
    for (const ch of hidden) ch.visible = true;
    dark.dispose();
    viewer.setCut(prevCut);
  }
  const levels: LevelMark[] = [{ label: '▽GL±0', y: 0 }];
  for (const f of model.floors) {
    levels.push({ label: `▽${f.level}FL +${f.elevation}`, y: f.elevation / 1000 });
    levels.push({ label: `▽${f.level}F 天井 +${f.elevation + f.ceilingHeight}（CH ${f.ceilingHeight}）`, y: (f.elevation + f.ceilingHeight) / 1000 });
  }
  const maxY = Math.max(st.roof.maxY, st.meta.topY);
  levels.push({ label: `▽最高高さ +${Math.round(maxY * 1000)}`, y: maxY });
  const title = `断面図 ${label}-${label}`;
  const { svg, vb, inner } = compose(o, levels, title, 'S=1/100', opts.sheet ? { ...opts.sheet, drawing: opts.sheet.drawing || title } : undefined);
  return { dir: 'section', title, svg, widthMm: vb.w, heightMm: vb.h, inner, vb };
}
