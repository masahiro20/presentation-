/**
 * パス出力: 同じ構図を「色」ではなく「情報」で書き出す（AI・Blender に形を固定して渡すための条件画像）
 *  - depth   : 奥行き（近いほど白）
 *  - normal  : 面の向き（カメラ空間）
 *  - lines   : 稜線の線画（白地に黒）
 *  - segment : 素材ID（壁・床・窓などを決まった色で塗り分け）
 */
import * as THREE from 'three';
import type { Viewer } from './viewer';

export type PassKind = 'depth' | 'normal' | 'lines' | 'segment';

export const PASS_LABEL: Record<PassKind, string> = { depth: '深度', normal: '法線', lines: '線画', segment: '素材ID' };

/** 素材ID の色（AI の領域指定・照合に使う。値は固定） */
export const SEGMENTS: { id: string; ja: string; color: string; test: (k: string) => boolean }[] = [
  { id: 'ext_wall', ja: '外壁', color: '#ff0000', test: (k) => k === 'ext.wall' || k === 'ext.accent' || k === 'ext.wallTop' },
  { id: 'foundation', ja: '基礎', color: '#800000', test: (k) => k === 'ext.foundation' },
  { id: 'roof', ja: '屋根・軒', color: '#0000ff', test: (k) => /^ext\.(roof|fascia|gutter|canopy|soffit)/.test(k) },
  { id: 'glass', ja: 'ガラス', color: '#00ffff', test: (k) => k.startsWith('ext.glass') || k === 'f.mirror' },
  { id: 'frame', ja: 'サッシ枠', color: '#ff00ff', test: (k) => k === 'ext.frame' },
  { id: 'door', ja: '扉', color: '#ff8000', test: (k) => k === 'ext.door' || k === 'int.door' || k === 'ext.shutter' },
  { id: 'int_wall', ja: '内壁', color: '#ffff00', test: (k) => /^int\.(wall|accent|bathWall|wallTop|trim|shadowGap)/.test(k) },
  { id: 'ceiling', ja: '天井', color: '#80ff00', test: (k) => k === 'int.ceiling' },
  { id: 'floor', ja: '床', color: '#00ff00', test: (k) => /^int\.(floor|wetFloor|entranceFloor|tatami|slab)/.test(k) || k === 'ext.balcony' || k === 'ext.terrace' },
  { id: 'stairs', ja: '階段', color: '#008080', test: (k) => k === 'int.stairs' },
  { id: 'cut', ja: '切り口', color: '#ffffff', test: (k) => k === 'cut.face' },
  { id: 'furniture', ja: '家具・設備', color: '#8000ff', test: (k) => k.startsWith('f.') },
  { id: 'ground', ja: '地面・外構', color: '#808000', test: (k) => /^l\.(ground|approach|driveway|far|paving|deck|gravel)/.test(k) || k === 'ext.concrete' },
  { id: 'road', ja: '道路', color: '#404040', test: (k) => k === 'l.road' || k === 'l.curb' },
  { id: 'plant', ja: '植栽', color: '#008000', test: (k) => /^l\.(leaf|trunk)/.test(k) || k === 'f.leaf' },
  { id: 'fence', ja: '塀・フェンス', color: '#c08040', test: (k) => /^l\.(fence|hedge)/.test(k) },
];
const OTHER = '#202020';

function segColor(key: string): string {
  return SEGMENTS.find((s) => s.test(key))?.color ?? OTHER;
}

export function segmentLegend(): string {
  return SEGMENTS.map((s) => `${s.color}  ${s.ja}（${s.id}）`).join('\n') + `\n${OTHER}  その他`;
}

function depthMaterial(near: number, far: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uNear: { value: near }, uFar: { value: far } },
    side: THREE.DoubleSide,
    vertexShader: 'varying float vZ; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform float uNear; uniform float uFar; varying float vZ; void main(){ float t = clamp((vZ - uNear) / (uFar - uNear), 0.0, 1.0); float v = 1.0 - t; gl_FragColor = vec4(vec3(v), 1.0); }',
  });
}

function normalMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vN; void main(){ vec3 n = normalize(vN); if(!gl_FrontFacing) n = -n; gl_FragColor = vec4(n * 0.5 + 0.5, 1.0); }',
  });
}

/** 指定の種類のパスを、現在のカメラのまま width×height で描いて PNG の dataURL を返す */
function drawPass<T>(viewer: Viewer, kind: PassKind, width: number, height: number, grab: (c: HTMLCanvasElement) => T): T {
  const { renderer, scene, camera } = viewer;
  const saved = {
    bg: scene.background,
    env: scene.environment,
    fog: scene.fog,
    tm: renderer.toneMapping,
    pr: renderer.getPixelRatio(),
    aspect: camera.aspect,
    clip: renderer.clippingPlanes,
  };
  const swapped: { m: THREE.Mesh; mat: THREE.Material | THREE.Material[] }[] = [];
  const hidden: THREE.Object3D[] = [];
  const edgeMats: { l: THREE.LineSegments; vis: boolean; color: THREE.Color; op: number }[] = [];
  let shared: THREE.Material | null = null;
  const made: THREE.Material[] = [];
  try {
    // 距離の範囲（深度用）: 建物の外接ボックスの角までの距離
    const box = new THREE.Box3();
    for (const g of [viewer.groups.building, viewer.groups.roof, viewer.groups.cut]) if (g.visible) box.expandByObject(g);
    let near = 0.3;
    let far = 60;
    if (!box.isEmpty()) {
      const d: number[] = [];
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) d.push(new THREE.Vector3(x, y, z).sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3())));
      near = Math.max(0.2, Math.min(...d) - 0.5);
      far = Math.max(near + 1, Math.max(...d) + 1);
    }
    scene.background = new THREE.Color(kind === 'lines' ? '#ffffff' : kind === 'depth' ? '#000000' : kind === 'normal' ? '#8080ff' : '#000000');
    scene.environment = null;
    scene.fog = null;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.clippingPlanes = [];
    if (kind === 'depth') shared = depthMaterial(near, far);
    else if (kind === 'normal') shared = normalMaterial();
    else if (kind === 'lines') shared = new THREE.MeshBasicMaterial({ color: '#ffffff', polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, fog: false, toneMapped: false });
    if (shared) made.push(shared);
    const segCache = new Map<string, THREE.Material>();
    scene.traverse((o) => {
      // 稜線は通常表示では非表示なので、親が見えていれば拾う
      if (!o.visible && !o.userData.edges) return;
      if (o.userData.edges) {
        let p: THREE.Object3D | null = o.parent;
        while (p) {
          if (!p.visible) return;
          p = p.parent;
        }
      }
      const m = o as THREE.Mesh;
      if ((o as THREE.Sprite).isSprite || o.userData.roomLabel) {
        hidden.push(o);
        o.visible = false;
        return;
      }
      if ((o as THREE.LineSegments).isLineSegments) {
        const l = o as THREE.LineSegments;
        const mat = l.material as THREE.LineBasicMaterial;
        if (l.userData.edges && kind === 'lines') {
          edgeMats.push({ l, vis: l.visible, color: mat.color.clone(), op: mat.opacity });
          mat.color.set('#000000');
          mat.opacity = 1;
          l.visible = true;
        } else if (l.userData.edges) {
          edgeMats.push({ l, vis: l.visible, color: mat.color.clone(), op: mat.opacity });
          l.visible = false;
        } else {
          hidden.push(o);
          o.visible = false;
        }
        return;
      }
      if (!m.isMesh) return;
      swapped.push({ m, mat: m.material });
      if (kind === 'segment') {
        const key = (m.userData.matKey as string | undefined) ?? '';
        const c = key ? segColor(key) : OTHER;
        let mat = segCache.get(c);
        if (!mat) {
          mat = new THREE.MeshBasicMaterial({ color: c, fog: false, toneMapped: false });
          segCache.set(c, mat);
          made.push(mat);
        }
        m.material = mat;
      } else if (shared) m.material = shared;
    });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    return grab(renderer.domElement);
  } finally {
    for (const s of swapped) s.m.material = s.mat;
    for (const o of hidden) o.visible = true;
    for (const e of edgeMats) {
      e.l.visible = e.vis;
      (e.l.material as THREE.LineBasicMaterial).color.copy(e.color);
      (e.l.material as THREE.LineBasicMaterial).opacity = e.op;
    }
    for (const m of made) m.dispose();
    scene.background = saved.bg;
    scene.environment = saved.env;
    scene.fog = saved.fog;
    renderer.toneMapping = saved.tm;
    renderer.clippingPlanes = saved.clip;
    renderer.setPixelRatio(saved.pr);
    camera.aspect = saved.aspect;
    viewer.resize();
    viewer.invalidate();
  }
}

const toData = (c: HTMLCanvasElement) => {
  const t = document.createElement('canvas');
  t.width = c.width;
  t.height = c.height;
  const g = t.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(c, 0, 0);
  return g.getImageData(0, 0, t.width, t.height);
};

/** 線画: 稜線のベクター線に、法線・素材ID・深度の変化点（輪郭・折れ目・素材の境）を足して、白地に黒で描く */
function linesPass(viewer: Viewer, width: number, height: number): string {
  const geo = drawPass(viewer, 'lines', width, height, toData);
  const nor = drawPass(viewer, 'normal', width, height, toData);
  const seg = drawPass(viewer, 'segment', width, height, toData);
  const dep = drawPass(viewer, 'depth', width, height, toData);
  const W = width;
  const H = height;
  const out = new Uint8ClampedArray(W * H * 4).fill(255);
  const diff = (a: ImageData, i: number, j: number) => Math.abs(a.data[i] - a.data[j]) + Math.abs(a.data[i + 1] - a.data[j + 1]) + Math.abs(a.data[i + 2] - a.data[j + 2]);
  for (let y = 0; y < H - 1; y++)
    for (let x = 0; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      const r = i + 4;
      const d = i + W * 4;
      const edge =
        diff(nor, i, r) > 60 || diff(nor, i, d) > 60 || diff(seg, i, r) > 40 || diff(seg, i, d) > 40 || Math.abs(dep.data[i] - dep.data[r]) > 10 || Math.abs(dep.data[i] - dep.data[d]) > 10 || geo.data[i] < 128;
      if (edge) {
        out[i] = out[i + 1] = out[i + 2] = 20;
      }
    }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  c.getContext('2d')!.putImageData(new ImageData(out, W, H), 0, 0);
  return c.toDataURL('image/png');
}

export function renderPass(viewer: Viewer, kind: PassKind, width: number, height: number): string {
  if (kind === 'lines') return linesPass(viewer, width, height);
  return drawPass(viewer, kind, width, height, (c) => c.toDataURL('image/png'));
}
(globalThis as unknown as { __renderPass: typeof renderPass }).__renderPass = renderPass;
