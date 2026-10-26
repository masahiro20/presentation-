/**
 * MCP の render_views（scripts/mcp-render.mjs）が裏の Chrome で開く撮影ページ。
 *   render.html?src=<JSON の URL>   JSON = { model: BuildingModel, design?: Partial<DesignOptions> }
 * 読み込みが終わると window.__ready = true。window.__shots() でカット一覧、
 * window.__renderShot(id, w, h, grade) で 1 カットを PNG の data URL にする（grade = 写真の仕上げを掛ける）。
 */
window.addEventListener('error', () => ((window as unknown as { __failed: boolean }).__failed = true));
window.addEventListener('unhandledrejection', () => ((window as unknown as { __failed: boolean }).__failed = true));
import * as THREE from 'three';
import { Viewer } from './scene/viewer';
import { auditEnvelope, type EnvelopeAudit } from './scene/selfCheck';
import { DEFAULT_DESIGN, type DesignOptions } from './styles/presets';
import { sunPosition, sunDirectionWorld, localDate } from './sun/solar';
import { finishPhoto } from './scene/photoFinish';
import { exportAr } from './scene/exportAr';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BuildingModel } from './core/types';

interface Payload {
  model: BuildingModel;
  design?: Partial<DesignOptions>;
}

const params = new URLSearchParams(location.search);
const src = params.get('src');
if (!src) throw new Error('src（間取り JSON の URL）がありません');
const payload = (await (await fetch(src)).json()) as Payload;
if (!payload?.model?.floors?.length) throw new Error('JSON に model がありません');
const design: DesignOptions = { ...DEFAULT_DESIGN, ...(payload.design ?? {}) };
const viewer = new Viewer(document.getElementById('v')!, design);
viewer.quality = 'high';
viewer.viewMode = 'finish';
const sp = sunPosition(localDate(2026, 5, 10, 10), 35.68, 139.77);
viewer.setSunDirection(sunDirectionWorld(sp.azimuth, sp.elevation, payload.model.northAngleDeg));
viewer.setModel(payload.model);

(window as unknown as { __viewer: Viewer }).__viewer = viewer;
const w = window as unknown as {
  __ready: boolean;
  __shots: (aspect?: number) => { id: string; kind: string; title: string; caption: string; level: number | null; roomId: string | null }[];
  __renderShot: (id: string, W: number, H: number, grade: boolean) => Promise<string>;
};
w.__shots = (aspect = 16 / 9) => viewer.shots(aspect).map((s) => ({ id: s.id, kind: s.kind, title: s.title, caption: s.caption, level: s.level ?? null, roomId: s.roomId ?? null }));
w.__renderShot = async (id, W, H, grade) => {
  const s = viewer.shots(W / H).find((x) => x.id === id);
  if (!s) throw new Error(`カット ${id} がありません`);
  viewer.applyShot(s);
  await new Promise((r) => setTimeout(r, 400));
  const url = await viewer.capture(W, H, 'image/png');
  if (!grade) return url;
  const im = new Image();
  im.src = url;
  await im.decode();
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  cv.getContext('2d')!.drawImage(im, 0, 0);
  return finishPhoto(cv, { interior: s.kind === 'interior', tod: s.timeOfDay ?? viewer.design.timeOfDay });
};
/**
 * 点検用: 建物の箱の中心を、方位角 az（度。0 = 図面の下側＝+Z から、時計回り）・仰角 el（度）から見た 1 枚。
 * 道路側・庭側のカットに入らない裏側や妻側の崩れ（壁の欠け・屋根の穴）を見るために使う
 */
(w as unknown as { __renderOrbit: (az: number, el: number, W: number, H: number) => Promise<string> }).__renderOrbit = async (az, el, W, H) => {
  const b = (viewer as unknown as { state: { meta: { bbox: THREE.Box3 } } }).state.meta.bbox;
  const c = b.getCenter(new THREE.Vector3());
  const size = b.getSize(new THREE.Vector3());
  const r = Math.max(size.x, size.z, size.y * 1.6) * 1.35 + 4;
  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  const pos = new THREE.Vector3(c.x + Math.sin(a) * Math.cos(e) * r, c.y + Math.sin(e) * r, c.z + Math.cos(a) * Math.cos(e) * r);
  viewer.setCut(null);
  viewer.applyView({ pos, target: c, fov: 40, architectural: false });
  await new Promise((res) => setTimeout(res, 300));
  return viewer.capture(W, H, 'image/png');
};
(w as unknown as { __auditScene: () => EnvelopeAudit }).__auditScene = () => auditEnvelope(viewer);
/** 点検用: AR のデータ（体験リンクで使う）を書き出し、大きさと置き方（中心が原点・地盤面が 0）を返す */
(w as unknown as { __checkAr: (fmt: 'glb' | 'usdz', scale: number, o?: { furniture?: boolean; tex?: number }) => Promise<{ bytes: number; box?: number[]; tris?: number; tex?: number }> }).__checkAr = async (fmt, scale, o) => {
  const data = await exportAr(viewer, fmt, scale, o);
  if (fmt !== 'glb') return { bytes: data.byteLength };
  const gltf = await new GLTFLoader().parseAsync(data.slice().buffer, '');
  const b = new THREE.Box3().setFromObject(gltf.scene);
  let tris = 0;
  const texs = new Set<unknown>();
  gltf.scene.traverse((m) => {
    const mesh = m as THREE.Mesh;
    if (!mesh.isMesh) return;
    tris += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    for (const t of [mat.map, mat.normalMap, mat.roughnessMap]) if (t) texs.add(t.image);
  });
  return { tris: Math.round(tris), tex: texs.size, bytes: data.byteLength, box: [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => +v.toFixed(2)) };
};
w.__ready = true;
