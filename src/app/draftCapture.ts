/**
 * 下書きのパース（プレゼン資料の仮の画像）。
 * 写真への仕上げは外部ツール（Nano Banana Pro など）で行い、仕上げた画像を取り込むとこの下書きより優先される。
 * ここでは高品質描画（実写の空・柔らかい影・2 倍描画）で数秒で 1 枚を作るだけ。
 */
import type { StepCtx } from './app';
import { state, uid, emit, type GalleryItem } from './state';
import type { Shot } from '../scene/shots';
import { renderStudio } from '../scene/studio';

/** 室内・夕景・夜景は露出を上げる（写真と同じ考え方） */
export function exposureFor(kind: string | undefined, tod: string): number {
  // 内観は 1.9 だと壁が真っ白に飛び、AI 仕上げの手掛かり（壁と天井の境・陰影）が消えていた
  if (kind === 'interior') return tod === 'night' ? 1.5 : 1.6;
  // 夜景は建物が真っ黒な影になっていた（窓だけ光る）。空の残光で外壁の形が読める明るさに
  if (tod === 'night') return 2.2;
  if (tod === 'evening') return 1.15;
  if (tod === 'morning') return 1.05;
  return 1.0;
}

/** ショットを下書きとして描いてギャラリーに入れる（同じショットの古い下書きは置き換え） */
export async function captureDraft(ctx: StepCtx, shot: Shot, size = { width: 1920, height: 1080 }): Promise<GalleryItem> {
  const v = ctx.app.viewer;
  v.applyShot(shot);
  const url = await renderStudio(v, { width: size.width, height: size.height, exposure: exposureFor(shot.kind, v.design.timeOfDay), interior: shot.kind === 'interior' });
  const item: GalleryItem = { id: uid('img'), title: shot.title, caption: shot.caption, url, kind: shot.kind, quality: 'realtime', shotId: shot.id };
  const idx = state.gallery.findIndex((g) => g.shotId === shot.id && g.quality === 'realtime');
  if (idx >= 0) state.gallery.splice(idx, 1, item);
  else state.gallery.push(item);
  emit('gallery');
  return item;
}

/** そのショットに外部で仕上げた写真がもう取り込まれているか */
export function hasFinished(shotId: string): boolean {
  return state.gallery.some((g) => g.shotId === `${shotId}-ai`);
}
