window.addEventListener("error", () => ((window as any).__failed = true));
window.addEventListener("unhandledrejection", () => ((window as any).__failed = true));
import * as THREE from 'three';
import { parsePdfInBrowser } from './parser/browser';
import { Viewer } from './scene/viewer';
import { DEFAULT_DESIGN } from './styles/presets';
import { sunPosition, sunDirectionWorld, localDate } from './sun/solar';

const params = new URLSearchParams(location.search);
const file = params.get('file') ?? 'sample_house_A3.pdf';
const buf = new Uint8Array(await (await fetch(`./samples/${file}`)).arrayBuffer());
const model = await parsePdfInBrowser(buf);
const design = { ...DEFAULT_DESIGN, exteriorId: params.get('ext') ?? DEFAULT_DESIGN.exteriorId, interiorId: params.get('int') ?? DEFAULT_DESIGN.interiorId, timeOfDay: (params.get('tod') as any) ?? 'day' };
const viewer = new Viewer(document.getElementById('v')!, design);
viewer.quality = (params.get('q') as any) ?? 'high';
const sp = params.get("az") ? { azimuth: +params.get("az")!, elevation: +(params.get("el") ?? 40) } : sunPosition(localDate(2026, 5, 10, +(params.get("h") ?? 10)), 35.68, 139.77);
viewer.sunDir.copy(sunDirectionWorld(sp.azimuth, sp.elevation, model.northAngleDeg));
viewer.setModel(model);
const b = viewer.state!.meta.bbox;
const c = b.getCenter(new THREE.Vector3());
const view = params.get('view') ?? 'ext';
if (view === 'ext') viewer.applyView({ pos: new THREE.Vector3(c.x + 13, 1.6, c.z + 16), target: new THREE.Vector3(c.x, 3.2, c.z), fov: 45, architectural: true });
else if (view === 'aerial') viewer.applyView({ pos: new THREE.Vector3(c.x + 14, 14, c.z + 18), target: new THREE.Vector3(c.x, 2, c.z), fov: 45 });
else if (view === 'cut') { viewer.setCutaway(+(params.get('lv') ?? 1)); viewer.applyView({ pos: new THREE.Vector3(c.x + 6, 14, c.z + 11), target: new THREE.Vector3(c.x, 0, c.z), fov: 45 }); }
else if (view === 'int') viewer.applyView({ pos: new THREE.Vector3(+(params.get('x') ?? 6), 0.5 + 1.35, +(params.get('z') ?? 7)), target: new THREE.Vector3(+(params.get('tx') ?? 0.5), 1.2, +(params.get('tz') ?? 3)), fov: 62, architectural: true });
// キッチンの型を試す: kt=two|island|wall|peninsula（1 階 LDK の西側の壁に置く。kx/ky mm, kr 度, kl m）
if (params.get('kt')) {
  const ldk = model.floors[0].rooms.find((r) => r.type === 'ldk' || r.type === 'living');
  if (ldk) {
    const xs = ldk.polygon.map((p) => p.x), ys = ldk.polygon.map((p) => p.y);
    model.furniture = [{ level: 1, items: [{ id: 'k1', kind: 'kitchen', x: +(params.get('kx') ?? Math.min(...xs) + 70), y: +(params.get('ky') ?? (Math.min(...ys) + Math.max(...ys)) / 2), rot: +(params.get('kr') ?? -90), len: +(params.get('kl') ?? (Math.max(...ys) - Math.min(...ys)) / 1000), kitchenType: params.get('kt') as any, roomId: ldk.id }] }];
    viewer.setModel(model);
  }
}
const shotId = params.get('shot');
if (shotId) {
  const shots = viewer.shots(1280 / 800);
  (window as any).shots = shots.map((s) => [s.id, s.title]);
  const s = shots.find((s) => s.id === shotId || s.id.startsWith(shotId));
  if (s) viewer.applyShot(s);
}
// 写真の仕上げ（グレーディング）だけを試す: grade=1
if (params.get('grade')) {
  const { finishPhoto } = await import('./scene/photoreal');
  const W = +(params.get('w') ?? 1280);
  const H = +(params.get('hh') ?? 720);
  const url0 = await viewer.capture(W, H, 'image/png');
  const im = new Image();
  im.src = url0;
  await im.decode();
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  cv.getContext('2d')!.drawImage(im, 0, 0);
  const interior = params.get('view') === 'int' || (params.get('shot') ?? '').startsWith('int');
  const url = finishPhoto(cv, { interior, tod: design.timeOfDay });
  viewer.pause(true);
  document.body.innerHTML = `<img id="ptimg" src="${url}" style="width:100vw;display:block">`;
  await (document.getElementById('ptimg') as HTMLImageElement).decode();
}
if (params.get('pt')) {
  const { renderPhotoreal } = await import('./scene/photoreal');
  const url = await renderPhotoreal(viewer, { width: +(params.get('w') ?? 480), height: +(params.get('hh') ?? 300), samples: +params.get('pt')!, timeLimit: 3000000, exposure: +(params.get('exp') ?? (params.get('shot')?.startsWith('int') ? 1.9 : 1.0)) });
  viewer.pause(true);
  document.body.innerHTML = `<img id="ptimg" src="${url}" style="width:100vw;display:block">`;
  await (document.getElementById('ptimg') as HTMLImageElement).decode();
  (window as any).__ptUrl = url;
}
if (params.get('elev')) {
  const { renderElevation } = await import('./drawings/elevation');
  const r = renderElevation(viewer, params.get('elev') as any, { color: params.get('color') !== '0' });
  viewer.pause(true);
  document.body.style.background = '#fff';
  document.body.innerHTML = `<div style="width:100vw">${r.svg.replace('<svg ', '<svg width="100%" ')}</div>`;
}
(window as any).__ready = true;
(window as any).viewer = viewer;
(window as any).model = model;
if (params.get('envI')) { viewer.scene.environmentIntensity = +params.get('envI')!; }
if (params.get('hemiI')) { viewer.hemi.intensity = +params.get('hemiI')!; }
if (params.get('bg') === '0') { viewer.scene.background = new THREE.Color('#000'); }
viewer.invalidate();
