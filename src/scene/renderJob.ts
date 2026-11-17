/**
 * 高品質パース（Blender / Cycles）へ渡す「レンダリングの依頼」を作る。
 *
 * 渡すもの:
 *   - 形: GLB（建物・屋根・家具・外構。単位 m・Y 上。メッシュごとに材料キー matKey を extras に入れる）
 *   - 見た目と構図: job.json（カメラ・太陽・時間帯・材料キーごとの素材の種類）
 *   - 形の検算値: fingerprint（全体と材料キーごとの外形の大きさ・頂点数）
 *
 * 決まり: Blender 側は形を一切編集しない（素材・光・カメラだけ）。読み込んだ形を fingerprint と突き合わせ、
 * 1mm を超えて違えば描かずに止める（座標系・単位・縮尺の取り違え、書き出しの欠けを見つける）。
 */
import * as THREE from 'three';
import type { Viewer, CameraView } from './viewer';
import { exportGlb } from './exportGlb';

export const RENDER_JOB_VERSION = 1;

export interface RenderJobBox {
  min: [number, number, number];
  max: [number, number, number];
}

export interface RenderJob {
  version: number;
  /** 座標の約束（three.js: 右手系・Y 上・m）。Blender（Z 上）へは (x, y, z) → (x, −z, y) */
  units: 'meter';
  up: 'Y';
  camera: {
    pos: [number, number, number];
    target: [number, number, number];
    /** 縦の画角（度） */
    fovY: number;
    aspect: number;
    /** 2 点透視のレンズシフト（投影行列の y のずれ。画面の高さの半分 = 1） */
    shiftY: number;
  };
  sun: { dir: [number, number, number]; timeOfDay: string };
  /** 室内から撮る構図か（露出・窓の光の扱いを変える） */
  interior: boolean;
  /** 材料キー → 素材の種類（Blender 側で素材を置き換えるときの手がかり。形には関係しない） */
  materials: Record<string, { kind: string; color: string; roughness: number; metalness: number; glass: boolean }>;
  fingerprint: {
    bbox: RenderJobBox;
    /** 材料キーごと（同じキーのメッシュをまとめた外形と頂点数・三角形の数） */
    parts: Record<string, { bbox: RenderJobBox; vertices: number; triangles: number }>;
    meshes: number;
  };
  /** 読み取りで推定した所（図面から確定できていない値）。画像に添えて知らせる */
  inferred: string[];
}

const arr = (v: THREE.Vector3): [number, number, number] => [+v.x.toFixed(5), +v.y.toFixed(5), +v.z.toFixed(5)];
const box = (b: THREE.Box3): RenderJobBox => ({ min: arr(b.min), max: arr(b.max) });

/** 書き出す形（exportGlb と同じ範囲）の検算値 */
export function sceneFingerprint(viewer: Viewer): RenderJob['fingerprint'] {
  const g = viewer.groups;
  const roots = [g.building, g.roof, g.furniture, g.landscape].filter((o) => o.visible);
  const all = new THREE.Box3();
  const parts = new Map<string, { bbox: THREE.Box3; vertices: number; triangles: number }>();
  let meshes = 0;
  const visible = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  };
  const tmp = new THREE.Box3();
  for (const r of roots) {
    r.updateWorldMatrix(true, true);
    r.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !visible(m)) return;
      const pos = m.geometry.attributes.position;
      if (!pos) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      tmp.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld);
      all.union(tmp);
      meshes++;
      const key = String(m.userData.matKey ?? '(none)');
      const p = parts.get(key) ?? { bbox: new THREE.Box3(), vertices: 0, triangles: 0 };
      p.bbox.union(tmp);
      p.vertices += pos.count;
      p.triangles += Math.round((m.geometry.index?.count ?? pos.count) / 3);
      parts.set(key, p);
    });
  }
  return { bbox: box(all), parts: Object.fromEntries([...parts].map(([k, p]) => [k, { bbox: box(p.bbox), vertices: p.vertices, triangles: p.triangles }])), meshes };
}

/** 材料キーから素材の種類（Blender 側の置き換えの手がかり） */
function materialKind(key: string): string {
  if (/glass/i.test(key)) return 'glass';
  if (/^ext\.wall|plaster|^int\.wall|ceiling/.test(key)) return 'plaster';
  if (/floor/.test(key)) return 'floor';
  if (/wood|door|stairs|trim/.test(key)) return 'wood';
  if (/frame|steel|metal|iron|rail|shutter|gutter/.test(key)) return 'metal';
  if (/roof/.test(key)) return 'roof';
  if (/leaf|tree|grass|plant/.test(key)) return 'plant';
  if (/tile|stone|concrete|ground|paving/.test(key)) return 'masonry';
  if (/fabric|sofa|rug|curtain/.test(key)) return 'fabric';
  return 'other';
}

export async function buildRenderJob(viewer: Viewer, view: CameraView = viewer.currentView(), aspect = 16 / 9): Promise<{ glb: ArrayBuffer; job: RenderJob }> {
  // 検算値は、書き出す形と同じ範囲で数える（想定の街並みは書き出さないので、数える前に隠す）
  const town = viewer.townShown();
  viewer.setTownVisible(false);
  let fingerprint: RenderJob['fingerprint'];
  let glb: ArrayBuffer;
  try {
    fingerprint = sceneFingerprint(viewer);
    glb = await exportGlb(viewer);
  } finally {
    viewer.setTownVisible(town);
  }
  const materials: RenderJob['materials'] = {};
  for (const key of Object.keys(fingerprint.parts)) {
    const m = viewer.registry.get(key) as THREE.MeshStandardMaterial;
    materials[key] = {
      kind: materialKind(key),
      color: m.color ? `#${m.color.getHexString(THREE.SRGBColorSpace)}` : '#cccccc',
      roughness: +(m.roughness ?? 0.8).toFixed(3),
      metalness: +(m.metalness ?? 0).toFixed(3),
      glass: !!m.userData?.isGlass,
    };
  }
  // 2 点透視（architectural）: 視線は水平、上下の向きはレンズシフトで表す（applyView と同じ計算）
  let shiftY = 0;
  let target = view.target.clone();
  if (view.architectural) {
    const dir = view.target.clone().sub(view.pos);
    const horiz = Math.hypot(dir.x, dir.z);
    const tan = dir.y / Math.max(0.001, horiz);
    shiftY = Math.max(-0.9, Math.min(0.9, tan / Math.tan((view.fov * Math.PI) / 360)));
    target = view.target.clone().setY(view.pos.y);
  }
  const model = viewer.state?.model;
  const inferred: string[] = [];
  if (model) {
    for (const f of model.floors) for (const r of f.rooms) if ((r as { inferred?: boolean }).inferred) inferred.push(`${f.level}階 ${r.name || '（室名なし）'}: 用途は推定`);
    if (!model.heights) inferred.push('階高・最高高さ・屋根の勾配: 立面図・3D データが無いので標準の値（推定）');
    const sc = model.report?.scaleSource;
    if (sc === 'module' || sc === 'default' || sc === 'area') inferred.push(`縮尺: 寸法線からではなく${sc === 'module' ? '尺モジュール' : sc === 'area' ? '面積表' : '既定値'}から決めた（推定）`);
    let ops = 0;
    let fromDrawing = 0;
    for (const f of model.floors)
      for (const o of f.openings) {
        if (o.kind !== 'window') continue;
        ops++;
        if (o.heightFrom) fromDrawing++;
      }
    if (ops > fromDrawing) inferred.push(`窓の高さ: ${ops} か所のうち ${ops - fromDrawing} か所は、窓の種類ごとの標準の高さ（推定）`);
  }
  const b = viewer.state?.meta.bbox;
  const inside = !!b && view.pos.x > b.min.x && view.pos.x < b.max.x && view.pos.z > b.min.z && view.pos.z < b.max.z && view.pos.y < b.max.y;
  const job: RenderJob = {
    version: RENDER_JOB_VERSION,
    units: 'meter',
    up: 'Y',
    camera: { pos: arr(view.pos), target: arr(target), fovY: +view.fov.toFixed(4), aspect: +aspect.toFixed(6), shiftY: +shiftY.toFixed(6) },
    sun: { dir: arr(viewer.sunDir), timeOfDay: viewer.design.timeOfDay },
    interior: inside,
    materials,
    fingerprint,
    inferred,
  };
  return { glb, job };
}
