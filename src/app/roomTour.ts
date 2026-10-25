/**
 * ルームツアー動画の素材（外部の AI で動画にするための下絵）
 *
 * 動画の描画はツールでは行わない。YouTube のルームツアーのように「玄関から入って、目線の高さ・広角で、
 * ゆっくり歩きながら各部屋を見せる」経路を図面から組み（video/paths の walkthroughProgram）、
 * その経路の上のキーフレーム（広角の静止画）と、2 枚ずつをつなぐクリップの指示文を ZIP にまとめる。
 *
 * 流れ: キーフレームを Nano Banana Pro で写真に仕上げる → 2 枚ずつ（最初と最後のフレーム）を動画 AI（Veo など）に渡して
 *       クリップにする → つないで 1 本にする → 「仕上げた動画を取り込む」で資料と共有リンクに入れる。
 */
import * as THREE from 'three';
import type { StepCtx } from './app';
import { state } from './state';
import { progressModal, toast, download } from './dom';
import { walkthroughProgram, type CameraProgram } from '../video/paths';
import { renderStudio } from '../scene/studio';
import { exposureFor } from './draftCapture';
import { makeZip, cutPrompt } from './cuts';
import { pointInPolygon } from '../core/geometry';
import type { Shot } from '../scene/shots';
import type { Viewer } from '../scene/viewer';

/** ルームツアーの画角（縦の視野角）。16:9 で横約 95°＝フルサイズ 16mm 相当の広角（YouTube のルームツアーの定番） */
export const TOUR_FOV = 64;
export interface TourKey {
  t: number;
  pos: THREE.Vector3;
  target: THREE.Vector3;
  caption: string;
  roomId?: string;
  /** その時点の扉の開き（通り抜ける扉を開けておく） */
  doors?: ReturnType<CameraProgram['sample']>['doors'];
  /** 同じ見回し（部屋の中で向きだけ変える）の始め／終わり。次のキーへのクリップは「見回し」になる */
  pan?: 'start' | 'end';
}

const MM = 0.001;

/** 図面からルームツアーの経路を作る */
export function tourProgram(ctx: StepCtx, shots: Shot[]): CameraProgram | null {
  const st = ctx.app.viewer.state;
  if (!st) return null;
  return walkthroughProgram(st.model, st.meta, st.site, shots);
}

/**
 * キーフレームは「立ち止まって見回す所」（部屋の見せ場）から取る: 見回しの始めと終わりの 2 枚。
 * 歩いている途中のコマは壁や扉を正面から見ていることが多く、ルームツアーの絵にならないので使わない。
 * 部屋から部屋へは YouTube のルームツアーと同じくカットでつなぐ（つなぎのクリップは任意）
 */
const SKIP_STOP = /^(おじゃまします|2階へ|3階へ|ホール|廊下|収納|納戸|物入|押入|クローゼット|SIC|WIC|WCL|パントリー)/;

/** 下絵がほぼ一色（壁や扉を正面から見ているだけ）か: 64×36 に縮めた明るさのばらつきで判定 */
async function isBlank(url: string): Promise<boolean> {
  const im = new Image();
  im.src = url;
  await im.decode();
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 36;
  const g = cv.getContext('2d')!;
  g.drawImage(im, 0, 0, 64, 36);
  const d = g.getImageData(0, 0, 64, 36).data;
  let sum = 0;
  let sq = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const y = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    sum += y;
    sq += y * y;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean)) < 0.07;
}

export function tourKeys(v: Viewer, program: CameraProgram): TourKey[] {
  const holds = program.holds ?? [];
  const keys: TourKey[] = [];
  const push = (t: number, caption: string, pan?: 'start' | 'end') => {
    const s = program.sample(t);
    if (s.fade > 0.3) return;
    keys.push({ t, pos: s.pos.clone(), target: s.target.clone(), caption, roomId: roomAt(v, s.pos)?.id, doors: s.doors, pan });
  };
  for (const h of holds) {
    // 通過点（ホール・階段の上がり口・おじゃまします）と収納は見せ場ではない（壁しか写らない）
    if (SKIP_STOP.test(h.caption)) continue;
    const dur = h.t1 - h.t0;
    if (dur < 1.6) {
      push(h.t0 + dur / 2, h.caption);
      continue;
    }
    push(h.t0 + 0.2, h.caption, 'start');
    push(h.t1 - 0.2, h.caption, 'end');
  }
  if (keys.length >= 2) return keys;
  // 見回しが取れない（部屋が読めていない等）ときは 7 秒ごと
  for (let t = 0; t < program.duration - 0.5; t += 7) push(t, [...program.captions].reverse().find((c) => t >= c.t0 - 0.2)?.text ?? '');
  return keys;
}

function roomAt(v: Viewer, p: THREE.Vector3) {
  const st = v.state;
  if (!st) return undefined;
  const floor = [...st.model.floors].sort((a, b) => b.elevation - a.elevation).find((f) => p.y >= f.elevation * MM - 0.2);
  return floor?.rooms.find((r) => pointInPolygon({ x: p.x / MM, y: p.z / MM }, r.polygon));
}

/** 2 枚のキーフレームの間の動き（動画 AI への指示） */
function motion(a: TourKey, b: TourKey): { ja: string; en: string } {
  const d = Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
  const ya = Math.atan2(a.target.x - a.pos.x, a.target.z - a.pos.z);
  const yb = Math.atan2(b.target.x - b.pos.x, b.target.z - b.pos.z);
  let turn = ((yb - ya) * 180) / Math.PI;
  while (turn > 180) turn -= 360;
  while (turn < -180) turn += 360;
  const climb = b.pos.y - a.pos.y;
  const ja: string[] = [];
  const en: string[] = [];
  if (climb > 0.8) {
    ja.push(`階段を上る（${climb.toFixed(1)}m）`);
    en.push(`walk up the stairs (${climb.toFixed(1)} m)`);
  } else if (d > 0.3) {
    ja.push(`前へ ${d.toFixed(1)}m ゆっくり歩く`);
    en.push(`walk forward slowly about ${d.toFixed(1)} m`);
  }
  if (Math.abs(turn) > 12) {
    // 左手系の向きに注意: three.js の上から見て +turn は左回り
    const dir = turn > 0 ? '左' : '右';
    ja.push(`${dir}へ ${Math.abs(Math.round(turn))}° 向きを変える`);
    en.push(`turn ${turn > 0 ? 'left' : 'right'} about ${Math.abs(Math.round(turn))} degrees`);
  }
  if (!ja.length) {
    ja.push('立ち止まり、部屋をゆっくり見回す');
    en.push('pause and slowly look around the room');
  }
  return { ja: ja.join('・'), en: en.join(', then ') };
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();

function dataUrlToBytes(url: string): Uint8Array {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** キーフレーム（広角・目線の高さ）と、クリップの指示文を ZIP にまとめて保存 */
export async function exportRoomTour(ctx: StepCtx, shots: Shot[], size = { width: 1920, height: 1080 }) {
  const v = ctx.app.viewer;
  const program = tourProgram(ctx, shots);
  if (!program) return;
  const keys = tourKeys(v, program);
  if (keys.length < 2) {
    toast('ルームツアーの経路を作れませんでした（玄関・扉の読み取りを確認してください）', 'error');
    return;
  }
  const pm = progressModal(`ルームツアーの下絵を作成中（${keys.length} 枚・広角）`);
  const prev = v.currentView();
  const prevLabels = v.roomLabelsShown();
  v.setRoomLabels(false);
  const entries: { name: string; data: Uint8Array }[] = [];
  const names: string[] = [];
  const kept: TourKey[] = [];
  const dropped: TourKey[] = [];
  const frameTxt: string[] = [];
  try {
    for (let i = 0; i < keys.length; i++) {
      if (pm.signal.aborted) return;
      const k = keys[i];
      pm.set(i / keys.length, k.caption || `キーフレーム ${i + 1}`);
      // 目線の高さで水平に構える（縦の線をまっすぐ: 建築の写真・ルームツアーの撮り方）
      v.setDoors(k.doors ?? null);
      v.applyView({ pos: k.pos, target: k.target, fov: TOUR_FOV, architectural: true });
      await new Promise((r) => setTimeout(r, 40));
      // 白い壁が飛ばないよう、パースの下絵より少し露出を控える（仕上げで明るさは戻せるが、飛んだ白は戻せない）
      const inside = !!k.roomId;
      const url = await renderStudio(v, { width: size.width, height: size.height, interior: inside, exposure: inside ? exposureFor('interior', v.design.timeOfDay) * 0.85 : exposureFor('exterior', v.design.timeOfDay) });
      if (await isBlank(url)) {
        dropped.push(k);
        continue;
      }
      kept.push(k);
      const name = `${String(kept.length).padStart(2, '0')}_${safe(k.caption || 'ルームツアー')}.jpg`;
      names.push(name);
      entries.push({ name: `キーフレーム/${name}`, data: dataUrlToBytes(url) });
      const p = cutPrompt({ id: `tour-${kept.length}`, kind: inside ? 'interior' : 'exterior', title: k.caption || 'ルームツアー', caption: '', view: { pos: k.pos, target: k.target, fov: TOUR_FOV, architectural: true }, sunDir: null, roomId: k.roomId }, i);
      frameTxt.push(`■ ${name}`, p.ja + ' 超広角（16mm 相当）の目線の高さの写真として。', '', p.en + ' Ultra-wide 16mm, eye level 1.5 m.', '');
    }
    if (kept.length < 2) {
      toast('ルームツアーの見せ場の構図が取れませんでした（部屋・扉の読み取りを確認してください）', 'error');
      return;
    }
    const clips: string[] = [];
    for (let i = 0; i + 1 < kept.length; i++) {
      const a = kept[i];
      const b = kept[i + 1];
      const m = motion(a, b);
      const panClip = a.pan === 'start' && b.pan === 'end' && a.caption === b.caption;
      const walk = Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z) + Math.abs(b.pos.y - a.pos.y) * 2;
      const secs = panClip ? 6 : Math.max(4, Math.min(8, Math.round(walk / 0.8)));
      const label = panClip ? '見回し（必須）' : walk > 7 ? 'つなぎ（任意・カットでつなぐのがおすすめ）' : 'つなぎ（任意）';
      clips.push(
        `■ クリップ ${String(i + 1).padStart(2, '0')}【${label}】約 ${secs} 秒: 最初のフレーム ${names[i]} → 最後のフレーム ${names[i + 1]}`,
        `【日本語】日本の注文住宅のルームツアー動画。最初のフレームから始まり、最後のフレームでぴったり終わる。動き: ${panClip ? '立ち止まったまま、ゆっくり部屋を見回す（カメラの位置は動かさずに向きだけ変える）' : m.ja}。目線の高さ 1.5m、超広角 16mm、ジンバルで撮ったなめらかな手持ち撮影（揺れなし）、ゆっくり一定の速さ。建物・素材・家具・光はフレームのとおりに変えない。人物・文字なし。`,
        `【English】Real-estate room tour video of a Japanese custom-built house, YouTube room tour style. Start exactly on the first frame and end exactly on the last frame. Camera motion: ${panClip ? 'stay in place and slowly pan across the room (rotate only, no translation)' : m.en}. Eye level 1.5 m, ultra-wide 16mm lens, smooth gimbal-stabilized movement, slow constant pace, no shake. Keep the architecture, materials, furniture and lighting exactly as in the frames. No people, no text.`,
        '',
      );
    }
    const readme = [
      `${state.name}　ルームツアー動画の素材`,
      `作成: ${new Date().toLocaleString('ja-JP')}　キーフレーム ${kept.length} 枚・クリップ ${kept.length - 1} 本（壁しか写らない構図 ${dropped.length} 枚は除外）`,
      '',
      '作り方',
      '1. キーフレーム/ の画像を Nano Banana Pro で写真に仕上げる（プロンプトは「キーフレームの説明文.txt」）。',
      '   最初に仕上げた 1 枚（LDK がおすすめ）を毎回「参考画像」として一緒に渡すと、床・壁・光の色が全カットでそろいます。',
      '   ファイル名（番号）は変えずに保存してください。',
      '2. 仕上げたキーフレームを 2 枚ずつ（開始 → 終了）、動画 AI（Google Flow／Veo の「最初と最後のフレーム」など）に渡し、',
      '   「クリップの指示文.txt」の該当クリップの文を貼ってクリップを作る。【見回し（必須）】だけ作れば部屋ごとの映像はそろいます。',
      '   【つなぎ（任意）】は部屋から部屋へ歩く映像。YouTube のルームツアーと同じく、部屋の間はカットでつないでも自然です。',
      '3. クリップを番号順につなぐ（Flow のシーンビルダー、CapCut など）。字幕は部屋名（キーフレームのファイル名）を参考に。',
      '4. できた動画を、パース →「仕上げ（外部）」→「仕上げた動画を取り込む」で取り込むと、プレゼン資料と共有リンクに入ります。',
      '',
      '撮り方の約束（YouTube のルームツアーの定番）: 玄関から入る／目線の高さ 1.5m／超広角（16mm 相当）／縦の線はまっすぐ／ゆっくり一定の速さ／部屋の見せ場で立ち止まって見回す。',
    ];
    entries.push({ name: 'はじめにお読みください.txt', data: new TextEncoder().encode(readme.join('\n')) });
    entries.push({ name: 'キーフレームの説明文.txt', data: new TextEncoder().encode(frameTxt.join('\n')) });
    entries.push({ name: 'クリップの指示文.txt', data: new TextEncoder().encode(clips.join('\n')) });
    const zip = makeZip(entries);
    const url = URL.createObjectURL(zip);
    download(url, `${safe(state.name)}_ルームツアー素材.zip`);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`ルームツアーの素材を保存しました（キーフレーム ${kept.length} 枚・${(zip.size / 1024 / 1024).toFixed(1)} MB）`, 'ok', 6000);
  } finally {
    pm.close();
    v.setDoors(null);
    v.setRoomLabels(prevLabels);
    v.applyView(prev);
  }
}

/** 3D の上でルームツアーの経路を広角で再生して確かめる（停止は戻り値の関数） */
export function previewRoomTour(ctx: StepCtx, shots: Shot[], onEnd?: () => void): () => void {
  const v = ctx.app.viewer;
  const program = tourProgram(ctx, shots);
  if (!program) return () => {};
  const prev = v.currentView();
  const t0 = performance.now();
  let raf = 0;
  v.controls.enabled = false;
  const stop = () => {
    cancelAnimationFrame(raf);
    v.controls.enabled = true;
    v.setDoors(null);
    v.applyView(prev);
  };
  const tick = () => {
    const t = (performance.now() - t0) / 1000;
    if (t >= program.duration) {
      stop();
      onEnd?.();
      return;
    }
    const s = program.sample(t);
    v.setDoors(s.doors ?? null);
    v.applyView({ pos: s.pos, target: s.target, fov: TOUR_FOV, architectural: true });
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return stop;
}
