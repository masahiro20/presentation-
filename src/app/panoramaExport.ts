/**
 * 360° ビューの書き出し（部屋ごとのパノラマ画像）と、その場で見回せるプレビュー。
 * 立つ位置は部屋の名札の位置（部屋のほぼ中央）・床から 1.4m の目線。正面（画像の中央）は、その部屋の内観パースの向き。
 * 画像は 360° 写真の印（GPano）入りの JPEG を ZIP にまとめる（Google フォト・Facebook・Windows のフォトで見回せる）。
 */
import * as THREE from 'three';
import type { StepCtx } from './app';
import { state } from './state';
import { h, modal, progressModal, toast, download } from './dom';
import { makeZip } from './cuts';
import { MM } from '../scene/building';
import { addPanoXmp, cubeToEquirect, type V3 } from '../scene/panorama';
import type { Room, RoomType, Vec2 } from '../core/types';
import type { Footprint } from '../scene/furniture';
import { pointInPolygon } from '../core/geometry';
import type { Shot } from '../scene/shots';

/** 360° を撮る部屋の種類（暮らしの場所。収納・トイレ・階段・外は撮らない） */
const PANO_TYPES = new Set<RoomType>(['ldk', 'living', 'dining', 'kitchen', 'japanese', 'bedroom', 'kids', 'study', 'entrance', 'hall', 'washroom']);
/** 並べる順（同じ階の中で）: LDK → 玄関・ホール → 個室 → 水まわり */
const RANK: Partial<Record<RoomType, number>> = { ldk: 0, living: 0, dining: 1, kitchen: 1, entrance: 2, hall: 3, japanese: 4, bedroom: 4, kids: 5, study: 5, washroom: 7 };
/** 目線の高さ [m]（立って見回す。家具の天板より上・建具の上枠より下） */
const EYE = 1.4;

export interface PanoPoint {
  roomId: string;
  title: string;
  pos: THREE.Vector3;
  heading: V3;
}

const segDist = (p: Vec2, a: Vec2, b: Vec2) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};

/**
 * 部屋の中で立つ位置 [mm]: 家具（背の高さ 30cm 以上。敷物は除く）から離れ、壁から 45cm 以上、なるべく部屋の中央。
 * 名札の位置はキッチンの島・テーブルの上になることがある（LDK で目の前がレンジフードになっていた）
 */
export function standPoint(room: Room, footprints: Footprint[], floorY: number): Vec2 {
  const poly = room.polygon;
  if (poly.length < 3) return room.labelPos;
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const cx = room.labelPos.x;
  const cy = room.labelPos.y;
  const tall = footprints.filter((f) => f.maxY - floorY > 0.3).map((f) => ({ x0: f.minX / MM, x1: f.maxX / MM, y0: f.minZ / MM, y1: f.maxZ / MM }));
  const step = Math.max(100, Math.min(300, Math.min(x1 - x0, y1 - y0) / 12));
  let best: { p: Vec2; s: number } | null = null;
  for (let x = x0 + step / 2; x < x1; x += step) {
    for (let y = y0 + step / 2; y < y1; y += step) {
      const p = { x, y };
      if (!pointInPolygon(p, poly)) continue;
      let wall = Infinity;
      for (let i = 0; i < poly.length; i++) wall = Math.min(wall, segDist(p, poly[i], poly[(i + 1) % poly.length]));
      if (wall < 450) continue;
      let clear = 1500;
      for (const f of tall) {
        const dx = Math.max(f.x0 - x, 0, x - f.x1);
        const dy = Math.max(f.y0 - y, 0, y - f.y1);
        clear = Math.min(clear, Math.hypot(dx, dy));
      }
      if (clear < 450) continue;
      const s = Math.min(clear, 1200) * 1.5 + Math.min(wall, 1500) - 0.35 * Math.hypot(x - cx, y - cy);
      if (!best || s > best.s) best = { p, s };
    }
  }
  return best?.p ?? room.labelPos;
}

/** 360° を撮る位置（部屋ごと）。小さな部屋（ホール 4㎡未満・洗面 2.5㎡未満など）は撮らない。暮らしの中心（LDK）から順に */
export function panoPoints(rooms: { room: Room; elevation: number; level: number }[], shots: Shot[], occupancy?: Map<string, Footprint[]>): PanoPoint[] {
  const out: PanoPoint[] = [];
  for (const { room: r, elevation, level } of rooms) {
    if (!PANO_TYPES.has(r.type)) continue;
    const min = r.type === 'hall' ? 4 : r.type === 'washroom' ? 2.5 : 3;
    if (r.area < min) continue;
    const floorY = (elevation + (r.floorOffset ?? 0)) * MM;
    const at = standPoint(r, occupancy?.get(r.id) ?? [], floorY);
    const pos = new THREE.Vector3(at.x * MM, floorY + EYE, at.y * MM);
    const shot = shots.find((s) => s.kind === 'interior' && s.roomId === r.id);
    let heading: V3 = [0, 0, 1];
    if (shot) {
      const d = shot.view.target.clone().sub(shot.view.pos).setY(0);
      if (d.lengthSq() > 1e-6) {
        d.normalize();
        heading = [d.x, 0, d.z];
      }
    }
    const name = r.name.replace(/[（(].*?[)）]/g, '').trim().normalize('NFKC') || r.name;
    out.push({ roomId: r.id, title: `${level}階 ${name}`, pos, heading, rank: RANK[r.type] ?? 9, level } as PanoPoint & { rank: number; level: number });
  }
  return (out as (PanoPoint & { rank: number; level: number })[]).sort((a, b) => a.level - b.level || a.rank - b.rank);
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();

interface PanoImage {
  title: string;
  canvas: HTMLCanvasElement;
}

/** 6 面を撮って 1 枚の 360° 画像（canvas）にする */
function shootPano(ctx: StepCtx, p: { pos: THREE.Vector3; heading: V3 }, face: number): HTMLCanvasElement {
  const faces = ctx.app.viewer.captureCubeFaces(p.pos, face);
  const W = face * 4;
  const px = cubeToEquirect(faces, face, W, p.heading);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = W / 2;
  c.getContext('2d')!.putImageData(new ImageData(px, W, W / 2), 0, 0);
  return c;
}

async function jpegWithPano(c: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('画像を作れませんでした'))), 'image/jpeg', 0.9));
  return addPanoXmp(new Uint8Array(await blob.arrayBuffer()), c.width, c.height);
}

async function saveZip(images: PanoImage[]) {
  const entries: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < images.length; i++) entries.push({ name: `${String(i + 1).padStart(2, '0')}_${safe(images[i].title)}_360.jpg`, data: await jpegWithPano(images[i].canvas) });
  entries.push({
    name: '00_360度ビューの見方.txt',
    data: new TextEncoder().encode(
      [
        '360° ビュー（部屋ごとに見回せる画像）',
        '',
        '・スマホ: Google フォトに入れて開くと、指で動かして見回せます（360° 写真として認識されます）。',
        '・パソコン: Windows の「フォト」、または Facebook に投稿すると見回せます。',
        '・普通の画像として開くと、横に長いゆがんだ写真に見えます（正距円筒という形式です）。',
        '・お客様にお渡しするときは、間取りの確認用（仕上げの色・家具は検討中のもの）とお伝えください。',
      ].join('\n'),
    ),
  });
  const zip = makeZip(entries);
  const url = URL.createObjectURL(zip);
  download(url, `${safe(state.name)}_360度ビュー.zip`);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(`360° ビューを保存しました（${images.length}枚・${(zip.size / 1024 / 1024).toFixed(1)} MB）`, 'ok', 6000);
}

/** その場で見回すプレビュー（ドラッグで向き・ホイールで寄る）。閉じたら描画を止めて片付ける */
function panoViewer(images: PanoImage[]): HTMLElement {
  const wrap = h('div', { class: 'pano-view' });
  const canvas = h('canvas', { class: 'pano-canvas' }) as HTMLCanvasElement;
  const tabs = h('div', { class: 'btn-row pano-tabs' });
  wrap.append(canvas, tabs, h('p', { class: 'hint' }, 'ドラッグで見回す・ホイールで寄る。保存した画像は Google フォトなどで同じように見回せます。'));
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100);
  const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), mat));
  let yaw = 0;
  let pitch = 0;
  let tex: THREE.Texture | null = null;
  const show = (i: number) => {
    tex?.dispose();
    tex = new THREE.CanvasTexture(images[i].canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    // 球の内側から見ると左右が逆になるので、横に反転して貼る（画像の中央が正面 = +X）
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.x = -1;
    tex.offset.x = 1;
    mat.map = tex;
    mat.needsUpdate = true;
    yaw = 0;
    pitch = 0;
    for (const [j, b] of [...tabs.children].entries()) b.classList.toggle('primary', j === i);
  };
  images.forEach((im, i) => tabs.append(h('button', { class: 'btn sm', onclick: () => show(i) }, im.title)));
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    yaw += (e.clientX - drag.x) * 0.004;
    pitch = Math.max(-1.4, Math.min(1.4, pitch + (e.clientY - drag.y) * 0.004));
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', () => (drag = null));
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      cam.fov = Math.max(35, Math.min(100, cam.fov + Math.sign(e.deltaY) * 4));
      cam.updateProjectionMatrix();
    },
    { passive: false },
  );
  let raf = 0;
  let shown = false;
  const loop = () => {
    if (wrap.isConnected) shown = true;
    else if (shown) {
      // 閉じた: 片付ける
      renderer.dispose();
      tex?.dispose();
      return;
    }
    const w = canvas.clientWidth || 800;
    const hh = canvas.clientHeight || 450;
    if (canvas.width !== w || canvas.height !== hh) {
      renderer.setSize(w, hh, false);
      cam.aspect = w / hh;
      cam.updateProjectionMatrix();
    }
    // yaw 0・pitch 0 で +X（画像の中央）を見る。右へドラッグすると左を向く（つかんで回す感覚）
    const d = new THREE.Vector3(Math.cos(pitch) * Math.cos(-yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(-yaw));
    cam.lookAt(d);
    renderer.render(scene, cam);
    raf = requestAnimationFrame(loop);
  };
  show(0);
  raf = requestAnimationFrame(loop);
  return wrap;
}

function openPreview(images: PanoImage[]) {
  modal('360° ビュー（部屋ごとに見回す）', panoViewer(images), [{ label: '閉じる' }, { label: 'ZIP で保存', primary: true, onClick: () => void saveZip(images) }], true);
}

/** 部屋ごとの 360° ビューを作る（LDK・個室・玄関など） */
export async function exportRoomPanoramas(ctx: StepCtx, shots: Shot[], face = 1024) {
  const model = state.model;
  if (!model) return;
  const v = ctx.app.viewer;
  const rooms = model.floors.flatMap((f) => f.rooms.map((room) => ({ room, elevation: f.elevation, level: f.level })));
  const pts = panoPoints(rooms, shots, v.state?.occupancy);
  if (!pts.length) {
    toast('360° を撮る部屋が見つかりませんでした（居室・LDK・玄関など）', 'info');
    return;
  }
  const prevView = v.currentView();
  v.setCutaway(null);
  const pm = progressModal('360° ビューを作っています');
  const images: PanoImage[] = [];
  try {
    for (let i = 0; i < pts.length; i++) {
      if (pm.signal.aborted) break;
      pm.set(i / pts.length, `${pts[i].title}（${i + 1}/${pts.length}）`);
      await new Promise((r) => setTimeout(r, 30));
      images.push({ title: pts[i].title, canvas: shootPano(ctx, pts[i], face) });
    }
  } finally {
    pm.close();
    v.applyView(prevView);
  }
  if (images.length) openPreview(images);
}

/** いまの目線の位置で 360° を 1 枚（向きは今の正面） */
export async function exportPanoramaHere(ctx: StepCtx, face = 1024) {
  const v = ctx.app.viewer;
  const view = v.currentView();
  const d = view.target.clone().sub(view.pos).setY(0);
  const heading: V3 = d.lengthSq() > 1e-6 ? (d.normalize().toArray() as V3) : [0, 0, 1];
  const pm = progressModal('360° ビューを作っています', false);
  try {
    await new Promise((r) => setTimeout(r, 30));
    const canvas = shootPano(ctx, { pos: view.pos.clone(), heading }, face);
    openPreview([{ title: 'この位置', canvas }]);
  } finally {
    pm.close();
  }
}
