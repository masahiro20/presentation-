/**
 * MCP の render_views（scripts/mcp-render.mjs）が裏の Chrome で開く撮影ページ。
 *   render.html?src=<JSON の URL>   JSON = { model: BuildingModel, design?: Partial<DesignOptions> }
 * 読み込みが終わると window.__ready = true。window.__shots() でカット一覧、
 * window.__renderShot(id, w, h, grade) で 1 カットを PNG の data URL にする（grade = 写真の仕上げを掛ける）。
 */
window.addEventListener('error', () => ((window as unknown as { __failed: boolean }).__failed = true));
window.addEventListener('unhandledrejection', () => ((window as unknown as { __failed: boolean }).__failed = true));
import { Viewer } from './scene/viewer';
import { DEFAULT_DESIGN, type DesignOptions } from './styles/presets';
import { sunPosition, sunDirectionWorld, localDate } from './sun/solar';
import { finishPhoto } from './scene/photoreal';
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
w.__ready = true;
