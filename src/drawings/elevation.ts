/**
 * 立面図・断面図の自動作成
 *  - 3D モデルを正投影し、特徴線（稜線・輪郭線）を深度バッファで隠線処理してベクター線に
 *  - 塗り（カラー立面）は同じ正投影のレンダリング画像
 *  - 立面図: 御社の書き方（GL・基礎高・各階 FL・軒高の点線と名前、左右の寸法の連鎖、勾配の記号、枠つきの図面名）
 *  - 断面図: 切断した建物（切り口は濃い塗り）に GL・FL・天井高・最高高さの寸法を記入
 */
import { exteriorFor } from '../coordinate/catalog';
import * as THREE from 'three';
import type { Viewer, SectionSpec } from '../scene/viewer';
import { wrapSheet, boxedTitle, esc, type SheetInfo, type Vb } from './sheet';
import { WALL_MARKS } from './finishTable';
import type { DesignOptions } from '../styles/presets';

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
  /** ワールドの点 → 図面 mm と見えるか（深度で判定） */
  project: (p: THREE.Vector3) => { x: number; y: number; visible: boolean };
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
  const project = (q: THREE.Vector3) => {
    const pp = toPx(q);
    return { x: pp.x * mmPerPx, y: pp.y * mmPerPx, visible: visible(pp.x, pp.y, pp.depth) };
  };
  return { lines, weighted, anchors, fillUrl, Wmm: (uMax - uMin) * 1000, Hmm: (yMax - yMin) * 1000, yMax, box, project };
}

/** 立面図の高さの一覧（m）。御社の立面図の寸法の並び: 基礎高・各階 FL・各階の軒高・最高軒高・最高高さ */
export interface ElevationHeights {
  /** 基礎天端（GL から）。3D の基礎は FL−100 まで */
  foundation: number;
  /** 階ごと: FL と、その階の軒高（上の階の FL。最上階は外壁の天端） */
  floors: { level: number; fl: number; eave: number }[];
  /** 最高軒高 */
  eaveMax: number;
  /** 最高高さ（屋根の頂部） */
  max: number;
}

export function elevationHeights(viewer: Viewer): ElevationHeights {
  const st = viewer.state!;
  const model = st.model;
  const floors = model.floors.map((f, i) => {
    const next = model.floors[i + 1];
    return { level: f.level, fl: f.elevation / 1000, eave: next ? next.elevation / 1000 : st.meta.topY };
  });
  const top = floors[floors.length - 1];
  const eaveMax = top ? top.eave : st.meta.topY;
  return { foundation: Math.max(0.2, ((model.floors[0]?.elevation ?? 600) - 100) / 1000), floors, eaveMax, max: Math.max(st.roof.maxY, st.meta.topY, eaveMax) };
}

interface ComposeOpts {
  /** 図面名（「南側 立面図」。縮尺は後ろに付く） */
  title: string;
  heights: ElevationHeights;
  /** 屋根勾配（寸）。0 なら勾配の記号を描かない */
  pitch?: number;
  /** 材料の面に置く丸数字（外部仕上表の行名と対応） */
  marks?: { cat: MatCat; text: string }[];
  /** 右側に足す高さの線（断面図の天井高など） */
  rightExtra?: { label: string; y: number }[];
  /** 線画に重ねる記号（建具記号など。図面 mm） */
  symbols?: string;
  sheet?: SheetInfo;
}

let clipSeq = 0;

/** 線分の SVG パス（M x y L x y）を読む */
function parseSeg(d: string): { x0: number; y0: number; x1: number; y1: number } | null {
  const m = /^M(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)L(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)$/.exec(d);
  return m ? { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] } : null;
}

/**
 * 注記と SVG の組み立て（御社の立面図の書き方）:
 *  - GL は一点鎖線、基礎高・各階 FL・軒高は図の裏を通る点線。線の上に名前（左: 軒高・基礎高・GL、右: FL・最上階の軒高）
 *  - 左に寸法の連鎖 3 本（階ごとの高さ／最高軒高／最高高さ）、右に階高の連鎖（GL→1FL→2FL→軒高）。数字は 3 桁区切り
 *  - 屋根の斜めの線の上に勾配の記号（10 に対する立ち上がり）
 *  - 図の下に枠つきの図面名「南側 立面図 S:1/100」（縮尺は図枠に入れるときに決まる）
 */
function compose(o: OrthoResult, c: ComposeOpts): { svg: string; vb: Vb; inner: string } {
  const yOf = (worldY: number) => (o.yMax - worldY) * 1000;
  const fmt = (m: number) => Math.round(m * 1000).toLocaleString('en-US');
  const H = c.heights;
  const glY = yOf(0);
  const FS = 190;
  const xL = -1300;
  const xR = o.Wmm + 1300;
  let back = '';
  let ann = '';
  // GL（一点鎖線）
  back += `<line x1="${xL - 400}" y1="${glY.toFixed(0)}" x2="${xR + 400}" y2="${glY.toFixed(0)}" stroke="#111" stroke-width="20" stroke-dasharray="500 110 50 110"/>`;
  // 高さの点線（図の裏）
  const seen = new Set<number>();
  const level = (y: number) => {
    const k = Math.round(y);
    if (seen.has(k) || Math.abs(y - glY) < 40) return;
    seen.add(k);
    back += `<line x1="${xL}" y1="${k}" x2="${xR}" y2="${k}" stroke="#333" stroke-width="9" stroke-dasharray="140 80"/>`;
  };
  level(yOf(H.foundation));
  for (const f of H.floors) {
    level(yOf(f.fl));
    level(yOf(f.eave));
  }
  for (const e of c.rightExtra ?? []) level(yOf(e.y));
  const text = (x: number, y: number, t: string, anchor: 'start' | 'middle' | 'end' = 'start', fs = FS, rot = 0) =>
    `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" font-size="${fs}" text-anchor="${anchor}" fill="#111"${rot ? ` transform="rotate(${rot} ${x.toFixed(0)} ${y.toFixed(0)})"` : ''}>${esc(t)}</text>`;
  // 線の名前（左: 軒高・基礎高・GL、右: FL・最上階の軒高）
  const labelL = (y: number, t: string) => (ann += text(xL + 60, y - 45, t));
  const labelR = (y: number, t: string) => (ann += text(xR - 60, y - 45, t, 'end'));
  labelL(glY, 'GL');
  labelL(yOf(H.foundation), '基礎高');
  for (const f of H.floors) {
    labelL(yOf(f.eave), `${f.level}階軒高`);
    labelR(yOf(f.fl), `${f.level}階FL`);
  }
  const top = H.floors[H.floors.length - 1];
  if (top) labelR(yOf(top.eave), `${top.level}階軒高`);
  for (const e of c.rightExtra ?? []) labelR(yOf(e.y), e.label);
  // 寸法の連鎖
  const chain = (x: number, hs: number[], labels: string[], side: 'left' | 'right') => {
    for (let i = 0; i + 1 < hs.length; i++) {
      const y0 = yOf(hs[i]);
      const y1 = yOf(hs[i + 1]);
      if (Math.abs(y0 - y1) < 5) continue;
      ann += `<line x1="${x}" y1="${y0.toFixed(0)}" x2="${x}" y2="${y1.toFixed(0)}" stroke="#111" stroke-width="10"/>`;
      const tx = side === 'left' ? x - 70 : x + 70 + FS * 0.75;
      ann += text(tx, (y0 + y1) / 2, labels[i], 'middle', FS, -90);
    }
    for (const hh of hs) ann += `<circle cx="${x}" cy="${yOf(hh).toFixed(0)}" r="28" fill="#111"/>`;
    // 線の端の短い水平線（寸法の補助線）
    for (const hh of hs) {
      const y = yOf(hh).toFixed(0);
      ann += side === 'left' ? `<line x1="${x - 120}" y1="${y}" x2="${x + 120}" y2="${y}" stroke="#111" stroke-width="6"/>` : `<line x1="${x - 120}" y1="${y}" x2="${x + 120}" y2="${y}" stroke="#111" stroke-width="6"/>`;
    }
  };
  // 左 1: GL → 基礎高 → 各階の軒高 → 最高高さ
  const c1 = [0, H.foundation, ...H.floors.map((f) => f.eave), H.max].filter((v, i, a) => i === 0 || v > a[i - 1] + 0.001);
  chain(-1500, c1, c1.slice(1).map((v, i) => fmt(v - c1[i])), 'left');
  // 左 2・3: 最高軒高・最高高さ
  chain(-2050, [0, H.eaveMax], [`${fmt(H.eaveMax)}（最高軒高）`], 'left');
  chain(-2600, [0, H.max], [`${fmt(H.max)}（最高高さ）`], 'left');
  // 右: GL → 各階 FL → 最上階の軒高（階高）
  const cr = [0, ...H.floors.map((f) => f.fl), ...(top ? [top.eave] : [])].filter((v, i, a) => i === 0 || v > a[i - 1] + 0.001);
  chain(o.Wmm + 1500, cr, cr.slice(1).map((v, i) => (i === 0 ? fmt(v - cr[i]) : `${fmt(v - cr[i])}（階高）`)), 'right');
  // 屋根勾配の記号: いちばん長い斜めの外形線の上に、水平 10 と立ち上がりの三角
  if (c.pitch && c.pitch > 0) {
    let best: { x0: number; y0: number; x1: number; y1: number; len: number } | null = null;
    const limitY = yOf(H.eaveMax) + 400;
    for (const d of o.weighted.outline) {
      const s = parseSeg(d);
      if (!s) continue;
      const dx = s.x1 - s.x0;
      const dy = s.y1 - s.y0;
      const len = Math.hypot(dx, dy);
      if (len < 1200 || Math.abs(dx) < 1) continue;
      const slope = Math.abs(dy / dx);
      if (slope < 0.03 || slope > 1.6) continue;
      if (Math.min(s.y0, s.y1) > limitY) continue;
      if (!best || len > best.len) best = { ...s, len };
    }
    if (best) {
      const [p, q] = best.x0 <= best.x1 ? [{ x: best.x0, y: best.y0 }, { x: best.x1, y: best.y1 }] : [{ x: best.x1, y: best.y1 }, { x: best.x0, y: best.y0 }];
      const risesRight = q.y < p.y;
      const base = 1000;
      const rise = 100 * c.pitch;
      const mx = (p.x + q.x) / 2;
      const my = (p.y + q.y) / 2;
      const ax = mx - base / 2;
      const ay = my - 420 + rise / 2;
      const vx = risesRight ? ax + base : ax;
      ann += `<polyline points="${risesRight ? `${ax},${ay} ${ax + base},${ay} ${vx},${ay - rise} ${ax},${ay}` : `${ax},${ay} ${ax + base},${ay} ${vx},${ay - rise} ${ax},${ay}`}" fill="none" stroke="#111" stroke-width="10"/>`;
      ann += text(ax + base / 2, ay - rise - 70, '10', 'middle', 170);
      ann += risesRight ? text(vx + 70, ay - rise / 2 + 60, String(c.pitch), 'start', 170) : text(vx - 70, ay - rise / 2 + 60, String(c.pitch), 'end', 170);
    }
  }
  // 材料の丸数字（外部仕上表の行名）
  for (const m of c.marks ?? []) {
    const a = o.anchors[m.cat];
    if (!a) continue;
    ann += `<circle cx="${a.x.toFixed(0)}" cy="${a.y.toFixed(0)}" r="210" fill="#fff" stroke="#111" stroke-width="14"/>`;
    ann += text(a.x, a.y + 95, m.text, 'middle', 280);
  }
  // 図面名（枠つき）
  ann += boxedTitle(o.Wmm / 2, glY + 950, `${c.title} S:1/{{SCALE}}`, 300);
  const vb: Vb = { x: -3100, y: -700, w: o.Wmm + 3100 + 2300, h: glY + 950 + 510 + 250 + 700 };
  const img = o.fillUrl ? `<image href="${o.fillUrl}" x="0" y="0" width="${o.Wmm}" height="${o.Hmm}" preserveAspectRatio="none" opacity="0.8"/>` : '';
  // 線の太さの階層（1/100 で 0.5 / 0.35 / 0.18 / 0.1 mm 相当）
  const W8 = o.weighted;
  const path = (d: string[], w: number, col = '#111') => (d.length ? `<path d="${d.join('')}" stroke="${col}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` : '');
  // GL より下（基礎の埋まる部分）は描かない
  const clipId = `elv${(clipSeq = (clipSeq + 1) % 100000)}`;
  const clip = `<clipPath id="${clipId}"><rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${(glY - vb.y).toFixed(0)}"/></clipPath>`;
  const inner = back + clip + `<g clip-path="url(#${clipId})">` + img + path(W8.fine, 9, '#333') + path(W8.opening, 16, '#222') + path(W8.step, 26) + path(W8.outline, 45) + (c.symbols ?? '') + '</g>' + ann;
  if (c.sheet) return { svg: wrapSheet(inner, vb, c.sheet), vb, inner };
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" font-family="'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif">` +
    `<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="#fff"/>` +
    inner.replace(/\{\{SCALE\}\}/g, '100') +
    `</svg>`;
  return { svg, vb, inner };
}

/**
 * 建具記号（JIS・御社の立面図）: 縦すべり出し・横すべり出しの障子に、丁番側の辺の中点を頂点にした三角を実線で描く。
 * この面を向いていて、手前の物に隠れていない障子だけ
 */
function sashSymbols(o: OrthoResult, sashes: { outN: THREE.Vector3; tri?: { apex: THREE.Vector3; a: THREE.Vector3; b: THREE.Vector3 } }[], viewDir: THREE.Vector3): string {
  let s = '';
  for (const sh of sashes) {
    if (!sh.tri || sh.outN.dot(viewDir) > -0.5) continue;
    const apex = o.project(sh.tri.apex);
    const a = o.project(sh.tri.a);
    const b = o.project(sh.tri.b);
    if (!apex.visible || !a.visible || !b.visible) continue;
    // 小さすぎる障子（スリット）は描かない
    if (Math.hypot(a.x - b.x, a.y - b.y) < 250) continue;
    s += `<path d="M${a.x.toFixed(0)} ${a.y.toFixed(0)}L${apex.x.toFixed(0)} ${apex.y.toFixed(0)}L${b.x.toFixed(0)} ${b.y.toFixed(0)}" fill="none" stroke="#222" stroke-width="9" stroke-linejoin="round"/>`;
  }
  return s;
}

/** 屋根勾配（寸）。陸屋根は 0 */
export function roofPitchOf(design: DesignOptions): number {
  const ext = exteriorFor(design);
  const type = design.roofOverride ?? ext.roof.type;
  return type === 'flat' ? 0 : (design.roofPitch ?? ext.roof.pitch);
}

export function renderElevation(viewer: Viewer, dir: ElevationDir, opts: ElevationOptions = {}): ElevationResult {
  const st = viewer.state!;
  const model = st.model;
  const viewDir = elevationViewDir(dir, model.northAngleDeg);
  const o = orthoDrawing(viewer, { viewDir, groups: ['building', 'roof'], mmPerPx: opts.mmPerPx ?? 8, color: opts.color !== false, includeInterior: false });
  const title = `${JP[dir]}側 立面図`;
  const ext = exteriorFor(viewer.design);
  const marks: { cat: MatCat; text: string }[] = ext.accent ? [{ cat: 'accent', text: WALL_MARKS.accent }] : [];
  const { svg, vb, inner } = compose(o, { title, heights: elevationHeights(viewer), pitch: roofPitchOf(viewer.design), marks, symbols: sashSymbols(o, st.meta.sashes, viewDir), sheet: opts.sheet ? { ...opts.sheet, drawing: opts.sheet.drawing || title } : undefined });
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
  const title = `断面図 ${label}-${label}`;
  const rightExtra = model.floors.map((f) => ({ label: `${f.level}階 天井（CH ${f.ceilingHeight.toLocaleString('en-US')}）`, y: (f.elevation + f.ceilingHeight) / 1000 }));
  const { svg, vb, inner } = compose(o, { title, heights: elevationHeights(viewer), rightExtra, sheet: opts.sheet ? { ...opts.sheet, drawing: opts.sheet.drawing || title } : undefined });
  return { dir: 'section', title, svg, widthMm: vb.w, heightMm: vb.h, inner, vb };
}
