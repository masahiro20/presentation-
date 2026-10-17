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
import { exteriorById } from '../styles/presets';
import type { MatSpec } from '../styles/textures';

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
  /** 線の太さの階層: 外形線（空との境）・見え掛かりの段差・開口まわり・目地などの細線 */
  weighted: { outline: string[]; step: string[]; opening: string[]; fine: string[] };
  /** 仕上げの引き出し線を付ける位置（図面 mm）。材料の種類ごと */
  anchors: Partial<Record<MatCat, { x: number; y: number }>>;
  fillUrl: string;
  Wmm: number;
  Hmm: number;
  yMax: number;
  box: THREE.Box3;
}

/** 立面の材料の種類（引き出し線の注記・線の太さに使う） */
type MatCat = 'wall' | 'accent' | 'roof' | 'glass' | 'frame' | 'foundation' | 'door';
const CAT_KEYS: [MatCat, RegExp][] = [
  ['accent', /^ext\.accent/],
  ['wall', /^ext\.wall/],
  ['roof', /^ext\.(roof|fascia)/],
  ['glass', /^ext\.glass/],
  ['frame', /^ext\.(frame|gutter)/],
  ['foundation', /^ext\.foundation/],
  ['door', /^ext\.door/],
];
const CAT_ID: Record<MatCat, number> = { wall: 1, accent: 2, roof: 3, glass: 4, frame: 5, foundation: 6, door: 7 };
const catOf = (key: string | undefined): MatCat | null => {
  if (!key) return null;
  for (const [c, re] of CAT_KEYS) if (re.test(key)) return c;
  return null;
};

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
  // ---- 材料の種類の画像（引き出し線の位置・開口まわりの線の判定） ----
  const idBuf = new Uint8Array(W * H * 4);
  {
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    const mats = new Map<number, THREE.MeshBasicMaterial>();
    const matFor = (id: number) => {
      if (!mats.has(id)) mats.set(id, new THREE.MeshBasicMaterial({ color: new THREE.Color(id / 255, 0, 0), toneMapped: false, side: THREE.DoubleSide }));
      return mats.get(id)!;
    };
    for (const r of roots)
      r.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const c = catOf(m.userData.matKey as string | undefined);
        swapped.push([m, m.material]);
        m.material = matFor(c ? CAT_ID[c] : 0);
      });
    const prevTM = renderer.toneMapping;
    const prevCS = renderer.outputColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, idBuf);
    renderer.setRenderTarget(null);
    renderer.setClearColor(0xffffff, 1);
    renderer.toneMapping = prevTM;
    renderer.outputColorSpace = prevCS;
    for (const [m, mat] of swapped) m.material = mat;
    for (const mm of mats.values()) mm.dispose();
  }
  const idAt = (px: number, py: number) => {
    if (px < 0 || py < 0 || px >= W || py >= H) return 0;
    return idBuf[((H - 1 - py) * W + px) * 4];
  };
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
    // 立面の塗りは、左上 45° の光で軒・庇・凹凸の影を落とす（プレゼン立面の慣例。奥行きが読める）
    const prevCast = viewer.sun.castShadow;
    viewer.sun.castShadow = true;
    renderer.setPixelRatio(1);
    const scale = Math.min(1, 2400 / Math.max(W, H));
    renderer.setSize(Math.round(W * scale * 1.0), Math.round(H * scale), false);
    scene.background = new THREE.Color('#ffffff');
    // 左上から柔らかい光
    viewer.sun.visible = true;
    const c0 = box.getCenter(new THREE.Vector3());
    viewer.sun.position.copy(c0).addScaledVector(viewDir, -30).addScaledVector(right, -22).add(new THREE.Vector3(0, 30, 0));
    viewer.sun.target.position.copy(c0);
    viewer.sun.target.updateMatrixWorld();
    scene.environmentIntensity = 0.9;
    renderer.toneMappingExposure = 1.05;
    renderer.setRenderTarget(null);
    // 影の地図は普段は動かしたときだけ作り直すので、この光の向きで作り直させる
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, cam);
    renderer.shadowMap.needsUpdate = true;
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
  const weighted: OrthoResult['weighted'] = { outline: [], step: [], opening: [], fine: [] };
  const BG = 0.9995;
  const depthAt = (px: number, py: number) => (px < 0 || py < 0 || px >= W || py >= H ? 1 : unpack(((H - 1 - py) * W + px) * 4));
  // 線の両側（法線方向に 3px）の奥行き・材料を見て、太さを決める
  const classify = (A: { x: number; y: number }, B: { x: number; y: number }, t0: number, t1: number): keyof OrthoResult['weighted'] | null => {
    const L = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    const nx = -(B.y - A.y) / L;
    const ny = (B.x - A.x) / L;
    let bg = 0;
    let jump = 0;
    let open = 0;
    let seam = 0;
    const N = 5;
    for (let k = 0; k < N; k++) {
      const t = t0 + ((t1 - t0) * (k + 0.5)) / N;
      const x = A.x + (B.x - A.x) * t;
      const y = A.y + (B.y - A.y) * t;
      const pa = [Math.round(x + nx * 3), Math.round(y + ny * 3)];
      const pb = [Math.round(x - nx * 3), Math.round(y - ny * 3)];
      const da = depthAt(pa[0], pa[1]);
      const db = depthAt(pb[0], pb[1]);
      if (da >= BG || db >= BG) bg++;
      else if (Math.abs(da - db) * (dMax - dMin + 2) > 0.12) jump++;
      const ia = idAt(pa[0], pa[1]);
      const ib = idAt(pb[0], pb[1]);
      if ([ia, ib].some((i) => i === CAT_ID.glass || i === CAT_ID.frame || i === CAT_ID.door)) open++;
      // 同じ塗り壁の同じ面の中の線（モデルの継ぎ目）は描かない（塗り壁に目地は無い）
      if (ia === ib && (ia === CAT_ID.wall || ia === CAT_ID.accent || ia === CAT_ID.foundation) && Math.abs(da - db) * (dMax - dMin + 2) < 0.02) seam++;
    }
    if (seam >= 4) return null;
    if (bg >= 2) return 'outline';
    if (jump >= 2) return 'step';
    if (open >= 2) return 'opening';
    return 'fine';
  };
  // 材料ごとに、その材料の面のいちばん内側の点（引き出し線の起点）
  const anchors: OrthoResult['anchors'] = {};
  {
    const stride = 4;
    const best: Partial<Record<MatCat, { x: number; y: number; r: number }>> = {};
    const rs = [64, 44, 30, 20, 12, 6];
    for (let py = stride; py < H - stride; py += stride)
      for (let px = stride; px < W - stride; px += stride) {
        const id = idAt(px, py);
        if (!id) continue;
        const cat = (Object.keys(CAT_ID) as MatCat[]).find((c) => CAT_ID[c] === id);
        if (!cat) continue;
        const cur = best[cat]?.r ?? 0;
        for (const r of rs) {
          if (r <= cur) break;
          const ok = [[r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]].every(([dx, dy]) => idAt(Math.round(px + dx), Math.round(py + dy)) === id);
          if (ok) {
            best[cat] = { x: px, y: py, r };
            break;
          }
        }
      }
    for (const [c, b] of Object.entries(best) as [MatCat, { x: number; y: number; r: number }][]) anchors[c] = { x: b.x * mmPerPx, y: b.y * mmPerPx };
  }
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
          const seg = `M${x0.toFixed(0)} ${y0.toFixed(0)}L${x1.toFixed(0)} ${y1.toFixed(0)}`;
          lines.push(seg);
          const cls = classify(A, B, runStart, tEnd);
          if (cls) weighted[cls].push(seg);
        }
        runStart = null;
      }
    }
  }
  return { lines, weighted, anchors, fillUrl, Wmm: (uMax - uMin) * 1000, Hmm: (yMax - yMin) * 1000, yMax, box };
}

interface LevelMark {
  label: string;
  y: number;
  /** 寸法の連鎖に使う */
  dim?: boolean;
}

/** 注記（GL 線・レベル・高さ寸法・図面名）と SVG の組み立て */
/** 仕上げの名前（引き出し線の注記） */
function finishName(m: MatSpec | undefined): string {
  switch (m?.pattern) {
    case 'stucco':
    case 'plaster':
      return '塗り壁（左官仕上げ）';
    case 'solido':
      return 'SOLIDO（セメント板）張り';
    case 'standingSeam':
      return 'ガルバリウム鋼板 立平葺き';
    case 'paint':
      return '塗装仕上げ';
    case 'concrete':
      return 'コンクリート 化粧仕上げ';
    case 'stone':
    case 'brick':
      return 'タイル張り';
    case 'galvalume':
      return 'ガルバリウム鋼板 張り';
    case 'woodSiding':
    case 'wood':
      return '木板張り';
    case 'siding':
    case 'lapSiding':
      return '窯業系サイディング';
    case 'slate':
      return 'スレート葺き';
    case 'roofTile':
      return '瓦葺き';
    default:
      return m?.pattern && /galva|metal|seam/i.test(m.pattern) ? 'ガルバリウム鋼板 張り' : m?.pattern && /siding|lap|board|cedar|wood/i.test(m.pattern) ? '外装材 張り' : '仕上げ';
  }
}

/** 立面図の材料の注記（外壁・アクセント・屋根・サッシ・基礎） */
function finishNotes(exteriorId: string): { cat: MatCat; text: string }[] {
  const st = exteriorById(exteriorId);
  const isPlaster = (m?: MatSpec) => m?.pattern === 'stucco' || m?.pattern === 'plaster';
  // テイスト名が塗り材の商品名（ジョリパット・そとん壁・Sto）なら、それを外壁の名前に使う
  const wallName = isPlaster(st.wall) && /ジョリパット|そとん|Sto|塗り壁/.test(st.name) ? `${st.name.replace(/\s*×.*$/, '')}（塗り壁）` : finishName(st.wall);
  const notes: { cat: MatCat; text: string }[] = [{ cat: 'wall', text: `外壁　${wallName}` }];
  if (st.accent) notes.push({ cat: 'accent', text: `外壁（アクセント）　${finishName(st.accent)}` });
  notes.push({ cat: 'roof', text: `屋根　${finishName(st.roof.material)}` });
  const dark = new THREE.Color(st.frame.color).getHSL({ h: 0, s: 0, l: 0 }).l < 0.3;
  notes.push({ cat: 'frame', text: `サッシ　アルミ樹脂複合（${dark ? 'ブラック' : 'シルバー'}）` });
  notes.push({ cat: 'foundation', text: '基礎　コンクリート 化粧モルタル' });
  return notes;
}

function compose(o: OrthoResult, levels: LevelMark[], title: string, subtitle: string, sheet?: SheetInfo, notes: { cat: MatCat; text: string }[] = []): { svg: string; vb: Vb; inner: string } {
  const yOf = (worldY: number) => (o.yMax - worldY) * 1000;
  const glY = yOf(0);
  const pad = notes.length ? 4600 : 2600;
  const vb: Vb = { x: -pad, y: -1400, w: o.Wmm + pad + 2600 + 3600, h: o.Hmm + 1400 + (sheet ? 900 : 1900) };
  const dimX = o.Wmm + 700;
  let ann = '';
  // GL: 太い地盤線と、その下の斜線（地面）
  ann += `<line x1="${-1500}" y1="${glY}" x2="${o.Wmm + 1500}" y2="${glY}" stroke="#111" stroke-width="55"/>`;
  for (let x = -1400; x < o.Wmm + 1500; x += 220) ann += `<line x1="${x}" y1="${glY + 30}" x2="${x - 160}" y2="${glY + 190}" stroke="#777" stroke-width="9"/>`;
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
  // 仕上げの引き出し線: 材料の面の内側に点、左の余白へ水平に引き出して名前を書く（重ならないよう上から順に詰める）
  const placed = notes
    .map((n) => ({ ...n, a: o.anchors[n.cat] }))
    .filter((n): n is { cat: MatCat; text: string; a: { x: number; y: number } } => !!n.a)
    .sort((a, b) => a.a.y - b.a.y);
  let lastY = -Infinity;
  const tx = -350;
  for (const n of placed) {
    const ly = Math.max(n.a.y, lastY + 420);
    lastY = ly;
    ann += `<circle cx="${n.a.x.toFixed(0)}" cy="${n.a.y.toFixed(0)}" r="45" fill="#111"/>`;
    ann += `<polyline points="${n.a.x.toFixed(0)},${n.a.y.toFixed(0)} ${Math.min(n.a.x, 250).toFixed(0)},${ly.toFixed(0)} ${tx},${ly.toFixed(0)}" fill="none" stroke="#111" stroke-width="10"/>`;
    ann += `<text x="${tx - 60}" y="${(ly + 55).toFixed(0)}" font-size="150" text-anchor="end" fill="#111">${n.text}</text>`;
  }
  // 図面名と縮尺（下線つき）
  const ty = glY + 1150;
  ann += `<text x="${o.Wmm / 2}" y="${ty}" font-size="300" text-anchor="middle" fill="#111" font-weight="bold" letter-spacing="40">${title}</text>`;
  ann += `<line x1="${o.Wmm / 2 - 1300}" y1="${ty + 110}" x2="${o.Wmm / 2 + 1300}" y2="${ty + 110}" stroke="#111" stroke-width="18"/>`;
  // 縮尺はシートの表題欄に書く（並べる枚数で縮尺が変わるため）
  void subtitle;
  const img = o.fillUrl ? `<image href="${o.fillUrl}" x="0" y="0" width="${o.Wmm}" height="${o.Hmm}" preserveAspectRatio="none" opacity="0.8"/>` : '';
  // 線の太さの階層（1/100 で 0.5 / 0.35 / 0.18 / 0.1 mm 相当）
  const W8 = o.weighted;
  const path = (d: string[], w: number, c = '#111') => (d.length ? `<path d="${d.join('')}" stroke="${c}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` : '');
  const inner = img + path(W8.fine, 9, '#333') + path(W8.opening, 16, '#222') + path(W8.step, 26) + path(W8.outline, 45) + ann;
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
  const { svg, vb, inner } = compose(o, levels, title, 'S = 1 / 100', opts.sheet ? { ...opts.sheet, drawing: opts.sheet.drawing || title } : undefined, finishNotes(viewer.design.exteriorId));
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
