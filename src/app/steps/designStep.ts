import * as THREE from 'three';
import { FINISH_CATEGORIES, selectedProduct } from '../../coordinate/catalog';
import { syncEstimateWithFinishes } from './estimateStep';

/** テイストを変えたとき、その部位のコーディネートの選択を既定に戻す */
function clearFinishes(part: '外部' | '内部'): Record<string, string> | undefined {
  const f = { ...(state.design.finishes ?? {}) };
  for (const c of FINISH_CATEGORIES) if (c.part === part) delete f[c.id];
  return Object.keys(f).length ? f : undefined;
}
import { h, clear, toast, progressModal, section, segmented, modal, download } from '../dom';
import { state, uid, emit, type GalleryItem } from '../state';
import type { Step, StepCtx } from '../app';
import { EXTERIOR_STYLES, INTERIOR_STYLES, MAIN_EXTERIOR_IDS, MAIN_INTERIOR_IDS, exteriorById, type DesignOptions, type RoofType, type TimeOfDay } from '../../styles/presets';
import { BUILDER_SPECS, resolveSpec } from '../../styles/spec';
import type { Shot } from '../../scene/shots';
import { renderPhotoreal, PhotorealError } from '../../scene/photoreal';
import { renderStudio } from '../../scene/studio';
import { exportGlb, sceneInfo, downloadBlob } from '../../scene/exportGlb';
import { exportCuts } from '../cuts';
import { importFinishedImages } from '../finishImport';
import { startCinema } from '../cinema';
import { aiSettingsUi, runAiFinish, runAiFinishBatch } from '../aiFinish';
import { MOODS, moodOf, applyMood } from '../../coordinate/moods';
import type { Viewer } from '../../scene/viewer';

function styleCard(s: { id: string; name: string; catch: string; swatch: string[] }, on: boolean, onClick: () => void) {
  return h(
    'button',
    { class: `style-card ${on ? 'on' : ''}`, onclick: onClick, title: s.catch },
    h('div', { class: 'sw' }, s.swatch.map((c) => h('span', { style: `background:${c}` }))),
    h('div', { class: 'nm' }, s.name),
    h('div', { class: 'ct' }, s.catch),
  );
}

export function currentShots(ctx: StepCtx): Shot[] {
  const el = ctx.app.viewerHost;
  return ctx.app.viewer.shots(el.clientWidth / Math.max(1, el.clientHeight));
}

export interface CaptureOptions {
  /** studio = 高品質描画（実写の空・柔らかい影・2倍描画。数秒で必ず仕上がる） */
  quality: 'realtime' | 'photoreal' | 'studio';
  samples?: number;
  silent?: boolean;
  /** 一括作成時: 進捗表示を共有 */
  progress?: { set(r: number, msg?: string, preview?: string): void; signal: AbortSignal; finish?: AbortSignal };
  /** 一括作成時の全体に対する位置 */
  slot?: { index: number; total: number };
}

/** 独立 GPU（GeForce / Radeon RX / Arc）か。実写テクスチャを大きいまま載せられる */
function discreteGpu(renderer: THREE.WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    return /GeForce|RTX|GTX|Radeon RX|Radeon Pro|Arc\(TM\) A|Apple M[1-9] (Pro|Max|Ultra)/i.test(name);
  } catch {
    return false;
  }
}

/** 室内・夕景・夜景は露出を上げる（写真と同じ考え方） */
function exposureFor(kind: string | undefined, tod: string): number {
  if (kind === 'interior') return tod === 'night' ? 1.5 : 1.9;
  if (tod === 'night') return 1.4;
  if (tod === 'evening') return 1.15;
  if (tod === 'morning') return 1.05;
  return 1.0;
}

export async function captureShot(ctx: StepCtx, shot: Shot | null, opts: CaptureOptions): Promise<GalleryItem | null> {
  const v = ctx.app.viewer;
  if (shot) v.applyShot(shot);
  const { quality } = opts;
  const W = quality === 'photoreal' ? state.render.width : 1920;
  const H = quality === 'photoreal' ? state.render.height : 1080;
  const samples = opts.samples ?? state.render.samples;
  let url: string;
  let studioUsed = false;
  if (quality === 'photoreal') {
    const own = opts.progress ? null : progressModal('提案用パースを写真品質でレンダリング中（光の反射・間接光を計算しています）', true, 'ここで仕上げる');
    const pm = opts.progress ?? own!;
    const slot = opts.slot ?? { index: 0, total: 1 };
    const kind = shot?.kind ?? (v.camera.position.y < 8 && v.state && isInside(ctx) ? 'interior' : 'exterior');
    const exposure = exposureFor(kind, v.design.timeOfDay);
    const view = v.currentView();
    // 1回目: 通常（独立 GPU なら実写テクスチャを 1024 で載せる）→ 2回目: テクスチャ・区画を小さく → 3回目: 半分の解像度で計算して拡大
    const stages: { safe: boolean; w: number; h: number; note: string; textureSize?: number }[] = [
      { safe: false, w: W, h: H, note: '', textureSize: discreteGpu(v.renderer) ? 1024 : 512 },
      { safe: true, w: W, h: H, note: '（負荷を下げて再計算中）' },
      { safe: true, w: Math.round(W / 2), h: Math.round(H / 2), note: '（軽量モードで再計算中）', textureSize: 128 },
    ];
    const attempt = (st: (typeof stages)[number]) =>
      renderPhotoreal(v, {
        width: st.w,
        height: st.h,
        samples: st.safe ? Math.min(samples, 256) : samples,
        signal: pm.signal,
        exposure,
        interior: kind === 'interior',
        finish: pm.finish,
        safe: st.safe,
        textureSize: st.textureSize,
        onStatus: (m) => pm.set(slot.index / slot.total, `${shot?.title ?? 'パース'}：${m}${st.note}`),
        onProgress: (s, total, preview) => pm.set((slot.index + s / total) / slot.total, `${shot?.title ?? 'パース'}：${s} / ${total} サンプル${st.note}`, preview?.()),
      });
    try {
      let lastErr: unknown = null;
      let got: string | null = null;
      errLog.length = 0;
      for (const st of stages) {
        try {
          got = await attempt(st);
          if (st.w !== W) got = await upscaleImage(got, W, H);
          break;
        } catch (e) {
          lastErr = e;
          if ((e as Error).name === 'AbortError') throw e;
          errLog.push(`${st.w}x${st.h}${st.safe ? ' safe' : ''}: ${(e as Error).message}`);
          console.warn('写真品質レンダリングに失敗しました。設定を下げて再試行します:', (e as Error).message);
          if (!(await v.waitForContext())) throw new Error('GPU がリセットされたまま復帰しませんでした。ページを再読み込みしてください');
          if (shot) v.applyShot(shot);
          else v.applyView(view);
        }
      }
      if (!got) {
        // パストレーシングが完了できない環境: 高品質のリアルタイム描画（実写の空・柔らかい影・環境遮蔽・2倍描画）で必ず1枚仕上げる
        pm.set((slot.index + 0.95) / slot.total, `${shot?.title ?? 'パース'}：高品質描画で仕上げています`);
        try {
          if (!(await v.waitForContext())) throw new Error('GPU が復帰しませんでした');
          if (shot) v.applyShot(shot);
          else v.applyView(view);
          got = await renderStudio(v, { width: W, height: H, exposure, interior: kind === 'interior' });
          studioUsed = true;
          lastPhotorealFailure = { e: (lastErr as Error) ?? new Error('不明'), shot };
        } catch (e2) {
          errLog.push(`高品質描画: ${(e2 as Error).message}`);
          throw lastErr ?? e2;
        }
      }
      url = got;
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        own?.close();
        lastPhotorealFailure = { e: e as Error, shot };
        // 一括作成中は1枚ごとに案内を出さず、最後にまとめて出す
        if (!opts.silent) photorealFailed(ctx, e as Error, shot);
      }
      return null;
    } finally {
      own?.close();
    }
  } else if (quality === 'studio') {
    const kind = shot?.kind ?? (v.camera.position.y < 8 && v.state && isInside(ctx) ? 'interior' : 'exterior');
    url = await renderStudio(v, { width: state.render.width, height: state.render.height, exposure: exposureFor(kind, v.design.timeOfDay), interior: kind === 'interior' });
    studioUsed = true;
  } else {
    url = await v.capture(W, H);
  }
  const item: GalleryItem = {
    id: uid('img'),
    title: shot?.title ?? 'パース',
    caption: shot?.caption ?? '',
    url,
    kind: shot?.kind ?? 'other',
    quality: quality === 'realtime' ? 'realtime' : 'photoreal',
    shotId: shot?.id,
  };
  // 同じショットの古い画像は置き換え
  const idx = state.gallery.findIndex((g) => g.shotId && g.shotId === item.shotId && g.quality === item.quality);
  if (idx >= 0) state.gallery.splice(idx, 1, item);
  else state.gallery.push(item);
  emit('gallery');
  if (!opts.silent)
    toast(
      studioUsed
        ? quality === 'studio'
          ? '提案用パース（高品質描画）を保存しました'
          : 'このパソコンでは光の計算（パストレーシング）を完了できなかったため、高品質描画で仕上げて保存しました'
        : quality === 'photoreal'
          ? '提案用パース（写真品質）を保存しました'
          : '下書きパースを保存しました',
      'ok',
    );
  return item;
}

/** 直近の写真品質レンダリングの失敗内容（問い合わせ用） */
const errLog: string[] = [];
export let lastPhotorealFailure: { e: Error; shot: Shot | null } | null = null;
export function clearPhotorealFailure() {
  lastPhotorealFailure = null;
}

/** 画像を拡大（高品質補間） */
async function upscaleImage(url: string, w: number, h: number): Promise<string> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.93);
}

/** 写真品質で出力できなかったときの案内（真っ黒な画像は保存しない） */
export function photorealFailed(ctx: StepCtx, e: Error, shot: Shot | null) {
  const gl = ctx.app.viewer.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '不明';
  const software = /swiftshader|llvmpipe|software|basic render/i.test(gpu);
  const body = h(
    'div',
    null,
    h('p', null, `写真品質のレンダリングを完了できませんでした。（${e.message}）`),
    h('p', { class: 'hint' }, `使用中の GPU: ${gpu}`),
    h(
      'ul',
      { class: 'hint' },
      software ? h('li', null, 'ブラウザのハードウェアアクセラレーションが無効になっています。Chrome の「設定 → システム → グラフィック アクセラレーションが使用可能な場合は使用する」をオンにして再起動してください。') : null,
      h('li', null, 'ノートパソコンは電源につなぎ、他のタブ（動画や地図など）を閉じてから再度お試しください。'),
      h('li', null, '「写真品質の設定」で解像度を下げる（1280×720 など）と成功しやすくなります。'),
      h('li', null, 'Chrome または Edge の最新版をお使いください。'),
    ),
  );
  const caps = ctx.app.viewer.renderer.capabilities;
  const diag = [
    `エラー: ${e.message}`,
    ...errLog.map((x, i) => `試行${i + 1}: ${x}`),
    `GPU: ${gpu}`,
    `最大テクスチャ: ${caps.maxTextureSize}`,
    `ブラウザ: ${navigator.userAgent}`,
  ].join('\n');
  const pre = h('textarea', { readonly: true, style: 'width:100%;height:110px;font-size:11px;margin-top:6px' }, diag) as HTMLTextAreaElement;
  body.append(
    h('div', { class: 'field-label', style: 'margin-top:10px' }, '原因調査用の情報（このままコピーして送ってください）'),
    pre,
    h(
      'button',
      {
        class: 'btn sm',
        onclick: () => {
          navigator.clipboard?.writeText(diag).then(
            () => toast('コピーしました', 'ok'),
            () => {
              pre.select();
              toast('選択しました。Ctrl+C でコピーしてください');
            },
          );
        },
      },
      '情報をコピー',
    ),
  );
  modal('写真品質で出力できませんでした', body, [
    { label: '閉じる' },
    {
      label: '確認用の下書きとして保存',
      onClick: () => void captureShot(ctx, shot, { quality: 'realtime' }),
    },
  ]);
}

/** 現在のカメラが建物の内側か（室内露出の判定） */
function isInside(ctx: StepCtx): boolean {
  const v = ctx.app.viewer;
  const p = v.camera.position;
  const b = v.state!.meta.bbox;
  return p.x > b.min.x && p.x < b.max.x && p.z > b.min.z && p.z < b.max.z && p.y < v.state!.meta.topY;
}

/** サイドパネルで開いているタブ（作り直しても保つ） */
let designTab = 'taste';

export const designStep: Step = {
  id: 'design',
  label: '外観・内観パース',
  short: 'パース',
  needsModel: true,
  uses3d: true,
  mount(ctx) {
    const v = ctx.app.viewer;
    v.setCutaway(null);
    v.setTownVisible(false);
    ctx.app.viewer.groups.context.visible = false;
    let shots = currentShots(ctx);
    let active: Shot | null = null;
    if (!v.userData.shownDesign) {
      v.userData.shownDesign = true;
      const first = shots.find((s) => s.id === 'ext-front');
      if (first) {
        v.applyShot(first);
        active = first;
        // 図面から建物が立ち上がる演出
        window.setTimeout(() => v.playReveal(2600), 120);
      }
    }

    // ---- ステージ上のツール ----
    const tools = h('div', { class: 'view-tools', style: 'pointer-events:auto' });
    const toolBtn = (label: string, fn: () => void) => h('button', { class: 'btn', onclick: fn }, label);
    const setCut = (lv: number | null) => {
      const s = shots.find((x) => (lv == null ? x.id === 'ext-front' : x.id === `cut-${lv}`));
      if (s) {
        v.applyShot(s, true);
        active = s;
        return;
      }
      v.setCutaway(lv);
      if (lv != null) {
        const b = v.state!.meta.bbox;
        const c = b.getCenter(new THREE.Vector3());
        const r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
        v.flyTo({ pos: c.clone().add(new THREE.Vector3(r * 0.55, r * 1.25, r * 0.95)), target: c.clone().setY(lv * 1.5), fov: 40 });
      }
    };
    tools.append(
      toolBtn('外観', () => {
        v.setCutaway(null);
        const s = shots.find((x) => x.id === 'ext-front');
        if (s) {
          v.applyShot(s, true);
          active = s;
        }
      }),
      toolBtn('鳥瞰', () => {
        v.setCutaway(null);
        const s = shots.find((x) => x.id === 'aerial');
        if (s) {
          v.applyShot(s, true);
          active = s;
        }
      }),
      ...v.state!.model.floors.map((f) => toolBtn(`${f.level}階 模型`, () => setCut(f.level))),
      toolBtn('断面', () => {
        const s = shots.find((x) => x.id === 'section-1');
        if (s) {
          v.applyShot(s, true);
          active = s;
        }
      }),
      toolBtn('▶ シネマ', () => startCinema(v, ctx.stage, shots, { start: Math.max(0, shots.findIndex((x) => x === active)) })),
    );
    {
      // 模型の部屋名タグ
      const lbl = toolBtn('部屋名', () => {
        v.setRoomLabels(!v.roomLabelsShown());
        lbl.classList.toggle('on', v.roomLabelsShown());
      });
      lbl.title = '輪切り模型に部屋名と帖数の札を表示する';
      lbl.classList.toggle('on', v.roomLabelsShown());
      tools.appendChild(lbl);
    }
    ctx.stage.appendChild(tools);

    // ---- 見どころカメラのフィルムストリップ（ステージ下）: 小さな下書き画像つき ----
    const strip = h('div', { class: 'shot-strip' });
    ctx.stage.appendChild(strip);
    const thumbs = (v.userData.shotThumbs ??= new Map<string, string>()) as Map<string, string>;
    let thumbGen = 0;
    const kindLabel = (s: Shot) => (s.kind === 'interior' ? '内観' : s.kind === 'aerial' ? '鳥瞰' : s.kind === 'cutaway' ? '模型' : s.kind === 'section' ? '断面' : '外観');
    const renderStrip = () => {
      clear(strip);
      for (const s of shots) {
        const th = h('div', { class: 'th' }, thumbs.has(s.id) ? h('img', { src: thumbs.get(s.id)! }) : kindLabel(s));
        const card = h(
          'button',
          {
            class: `shot-card ${active?.id === s.id ? 'on' : ''}`,
            title: s.caption,
            onclick: () => {
              v.applyShot(s, true);
              active = s;
              for (const c of strip.children) c.classList.toggle('on', c === card);
            },
          },
          th,
          h('div', { class: 't' }, h('span', { class: `k ${s.kind === 'interior' ? 'int' : s.kind === 'cutaway' || s.kind === 'section' ? 'cut' : ''}` }, kindLabel(s)), (s.title.replace(/^内観パース|^外観パース/, '').replace(/[（）]/g, '') || s.title).normalize('NFKC')),
        );
        strip.appendChild(card);
      }
      scheduleThumbs();
    };
    /** 下書きのサムネイルは画面が空いたときに少しずつ（カメラだけ動かして小さく描く。輪切り・断面・時間帯の違う構図は札だけ） */
    const scheduleThumbs = () => {
      const gen = ++thumbGen;
      // 時間帯の違う構図も、今の光のまま構図だけ描く（夕景・夜景の雰囲気は選んでから）
      const todo = shots.filter((s) => !thumbs.has(s.id) && !s.cutaway && !s.section);
      if (!todo.length) return;
      const idle = (fn: () => void) => ((window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback ? (window as unknown as { requestIdleCallback: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback(fn, { timeout: 1500 }) : window.setTimeout(fn, 300));
      const step = (i: number) => {
        if (gen !== thumbGen || i >= todo.length || !v.state) return;
        const s = todo[i];
        try {
          thumbs.set(s.id, v.captureQuick(s.view, 192, 108));
          const card = [...strip.children].find((c) => (c as HTMLElement).title === s.caption && c.textContent?.includes((s.title.replace(/^内観パース|^外観パース/, '').replace(/[（）]/g, '') || s.title).normalize('NFKC')));
          const th = card?.querySelector('.th');
          if (th) {
            clear(th);
            th.appendChild(h('img', { src: thumbs.get(s.id)! }));
          }
        } catch {
          // 描けない環境では札のまま
        }
        idle(() => step(i + 1));
      };
      idle(() => step(0));
    };

    // ---- サイドパネル ----
    const side = ctx.side;
    const update = (patch: Partial<DesignOptions>) => {
      state.design = { ...state.design, ...patch };
      v.setDesign(state.design);
      shots = currentShots(ctx);
      renderSide();
    };
    /** コーディネートで商品を選ぶ: 3D と見積の行を同時に */
    const chooseFinish = (catId: string, productId: string) => {
      const finishes = { ...(state.design.finishes ?? {}), [catId]: productId };
      update({ finishes });
      syncEstimateWithFinishes();
    };
    const renderSide = () => {
      clear(side);
      side.append(
        h('h2', null, '外観・内観パース'),
      );
      const extCard = (s: (typeof EXTERIOR_STYLES)[number]) => styleCard(s, s.id === state.design.exteriorId, () => update({ exteriorId: s.id, roofOverride: undefined, roofPitch: undefined, wallColorOverride: undefined, eaves: undefined, finishes: clearFinishes('外部') }));
      const intCard = (s: (typeof INTERIOR_STYLES)[number]) => styleCard(s, s.id === state.design.interiorId, () => update({ interiorId: s.id, finishes: clearFinishes('内部') }));
      const others = (cards: HTMLElement[], open: boolean) =>
        h('details', { open, style: 'margin-top:8px' }, h('summary', { style: 'font-size:12.5px;color:#8b9098;cursor:pointer' }, 'その他のテイスト（比較用）'), h('div', { class: 'style-grid', style: 'margin-top:8px' }, cards));
      const spec = resolveSpec(state.design.specId, state.design.specPatch);
      side.append(
        section(
          '標準仕様（納まり）',
          segmented(
            BUILDER_SPECS.map((b) => ({ value: b.id, label: b.name })),
            spec.id,
            (val) => update({ specId: val }),
          ),
          h('p', { class: 'hint' }, spec.description),
          h(
            'details',
            { style: 'margin-top:6px' },
            h('summary', { style: 'font-size:12.5px;color:#5b6068;cursor:pointer' }, '納まりを細かく調整'),
            ...(
              [
                ['fullHeightDoors', 'フルハイトドア（天井までの扉・上枠なし）', spec.doors.fullHeight],
                ['windowHeadAtCeiling', 'サッシ上端を天井高にそろえる', spec.windows.headAtCeiling],
                ['indirectLighting', '天井際の間接照明', spec.indirectLighting],
              ] as const
            ).map(([k, label, val]) =>
              h(
                'label',
                { class: 'check' },
                h('input', { type: 'checkbox', checked: val, onchange: (e: Event) => update({ specPatch: { ...state.design.specPatch, [k]: (e.target as HTMLInputElement).checked } }) }),
                label,
              ),
            ),
            h('div', { class: 'field-label', style: 'margin-top:6px' }, 'カーテン'),
            segmented(
              [
                { value: 'pocket', label: 'カーテンボックス' },
                { value: 'rail', label: 'レール' },
                { value: 'none', label: 'なし' },
              ],
              spec.curtains,
              (val) => update({ specPatch: { ...state.design.specPatch, curtains: val as 'pocket' | 'rail' | 'none' } }),
            ),
            ...(v.state!.model.floors.some((f) => f.rooms.some((r) => r.type === 'void'))
              ? [
                  h('div', { class: 'field-label', style: 'margin-top:8px' }, '吹抜の 2 階側（落下防止）'),
                  segmented(
                    [
                      { value: 'rail', label: '鉄骨手すり' },
                      { value: 'half', label: '腰壁' },
                      { value: 'halfGlass', label: '腰壁＋ガラス' },
                      { value: 'wall', label: '壁' },
                    ],
                    spec.voidGuard,
                    (val) => update({ specPatch: { ...state.design.specPatch, voidGuard: val as 'rail' | 'half' | 'halfGlass' | 'wall' } }),
                  ),
                  h('p', { class: 'hint', style: 'margin:4px 0 0' }, '黒皮鉄のフラットバー手すり（御社の標準）／腰壁 H1100／腰壁 H900 にガラス H300／天井までの壁。図面に線が無い縁にも付けます。'),
                ]
              : []),
            h('div', { class: 'field-label', style: 'margin-top:8px' }, '室内ドアの色'),
            h(
              'div',
              { class: 'btn-row' },
              ...[
                ['', '壁になじませる'],
                ['preset', 'テイスト標準'],
                ['#f2f0ec', 'ホワイト'],
                ['#d8d1c6', 'グレージュ'],
                ['#bfbfbc', 'グレー'],
                ['wood', '木目'],
                ['#2e2d2c', 'ブラック'],
              ].map(([c, label]) =>
                h(
                  'button',
                  {
                    class: `btn sm ${(state.design.specPatch?.doorColor ?? '') === c ? 'dark' : ''}`,
                    onclick: () => update({ specPatch: { ...state.design.specPatch, doorColor: c || undefined } }),
                  },
                  label,
                ),
              ),
            ),
            h(
              'label',
              { class: 'field' },
              h('span', { class: 'field-label' }, '天井高 (mm)'),
              h('input', {
                type: 'number',
                step: 50,
                value: state.design.specPatch?.ceilingHeight ?? v.state!.model.floors[0].ceilingHeight,
                onchange: (e: Event) => update({ specPatch: { ...state.design.specPatch, ceilingHeight: +(e.target as HTMLInputElement).value } }),
              }),
            ),
          ),
        ),
        section(
          'コーディネート',
          h('p', { class: 'hint', style: 'margin:0 0 6px' }, 'まず「雰囲気」を選ぶと、外観・内観のテイストと部位ごとの商品がまとめて入れ替わります（御社の事例と SNS で人気の組み合わせ）。そのあと部位ごとに差し替えてください。'),
          (() => {
            const cur = moodOf(state.design);
            const grid = h(
              'div',
              { class: 'style-grid mood-grid' },
              MOODS.map((m) =>
                styleCard({ id: m.id, name: m.name, catch: m.catch, swatch: m.swatch }, cur?.id === m.id, () => {
                  update(applyMood(state.design, m));
                  syncEstimateWithFinishes();
                }),
              ),
            );
            const why = cur
              ? h(
                  'div',
                  { class: 'mood-why' },
                  h('div', { class: 'k' }, `${cur.name}: なぜこの組み合わせか`),
                  h('p', null, cur.why),
                  h('p', null, h('b', null, '合う間取り・お客様 '), cur.fits),
                  h('p', null, h('b', null, 'ひとひねり '), cur.twists.join('／')),
                  h('p', { class: 'hint', style: 'margin:4px 0 0' }, `参考: ${cur.refs}`),
                )
              : h('p', { class: 'hint', style: 'margin:4px 0 0' }, '雰囲気を選ぶと、その組み合わせの考え方（お客様に話せる言葉）がここに出ます。');
            return h('div', { style: 'margin-bottom:10px' }, grid, why);
          })(),
          h('p', { class: 'hint', style: 'margin:0 0 10px' }, '部位ごとにメーカー・品番を選ぶと、3D の仕上げと見積の該当行が同時に変わります。テイストを変えると標準に戻ります。'),
          ...(['外部', '内部', '設備'] as const).map((part) =>
            h(
              'div',
              { class: 'coord-part' },
              h('div', { class: 'coord-part-title' }, part),
              ...FINISH_CATEGORIES.filter((c) => c.part === part).map((cat) => {
                const cur = selectedProduct(cat, state.design);
                const sel = h('select', { onchange: (e: Event) => chooseFinish(cat.id, (e.target as HTMLSelectElement).value) }, ...cat.products.map((p) => h('option', { value: p.id, selected: p.id === cur.id }, `${p.maker}　${p.name}${p.color ? `　${p.color}` : ''}`)));
                const note = h('input', { type: 'text', class: 'note', placeholder: '品番・メモ（例: IS-1234、AA-1234）', value: state.design.finishNotes?.[cat.id] ?? '', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); const notes = { ...(state.design.finishNotes ?? {}) }; if (v) notes[cat.id] = v; else delete notes[cat.id]; state.design = { ...state.design, finishNotes: notes }; } });
                return h('div', { class: 'coord-row' }, h('div', { class: 'sw' }, ...cur.swatch.map((c) => h('span', { style: `background:${c}` }))), h('div', { class: 'body' }, h('div', { class: 'k' }, cat.label), sel, h('div', { class: 'cd' }, [cur.code, cur.note].filter(Boolean).join('　')), note));
              }),
            ),
          ),
        ),
        section(
          '外観のテイスト',
          h('div', { class: 'style-grid' }, MAIN_EXTERIOR_IDS.map((id) => EXTERIOR_STYLES.find((s) => s.id === id)!).filter(Boolean).map(extCard)),
          others(EXTERIOR_STYLES.filter((s) => !MAIN_EXTERIOR_IDS.includes(s.id)).map(extCard), !state.design.exteriorId.startsWith('hl-')),
        ),
        section(
          '内観のテイスト',
          h('div', { class: 'style-grid' }, MAIN_INTERIOR_IDS.map((id) => INTERIOR_STYLES.find((s) => s.id === id)!).filter(Boolean).map(intCard)),
          others(INTERIOR_STYLES.filter((s) => !MAIN_INTERIOR_IDS.includes(s.id)).map(intCard), !state.design.interiorId.startsWith('hl-')),
        ),
        section(
          '細かく調整',
          h('div', { class: 'field-label' }, '屋根の形'),
          segmented<RoofType | 'auto'>(
            [
              { value: 'auto', label: 'おまかせ' },
              { value: 'gable', label: '切妻' },
              { value: 'hip', label: '寄棟' },
              { value: 'shed', label: '片流れ' },
              { value: 'flat', label: '陸屋根' },
            ],
            state.design.roofOverride ?? 'auto',
            (val) => update({ roofOverride: val === 'auto' ? undefined : val }),
          ),
          (() => {
            const ext = exteriorById(state.design.exteriorId);
            const type = state.design.roofOverride ?? ext.roof.type;
            if (type === 'flat') return null;
            const cur = state.design.roofPitch ?? ext.roof.pitch;
            const label = h('span', { class: 'field-label' }, `屋根の勾配 ${cur} 寸`);
            const slider = h('input', {
              type: 'range',
              min: 0.5,
              max: 6,
              step: 0.5,
              value: cur,
              oninput: (e: Event) => (label.textContent = `屋根の勾配 ${(e.target as HTMLInputElement).value} 寸`),
              onchange: (e: Event) => update({ roofPitch: +(e.target as HTMLInputElement).value }),
            });
            return h('label', { class: 'field', style: 'margin-top:10px' }, label, slider, h('span', { class: 'hint' }, '10 に対する立ち上がり。標準は片流れ 0.5 寸。切妻・寄棟にする場合は 3〜5 寸'));
          })(),
          (() => {
            const ext = exteriorById(state.design.exteriorId);
            const cur = state.design.eaves ?? ext.roof.eaves;
            const label = h('span', { class: 'field-label' }, `軒の出 ${cur} mm`);
            const slider = h('input', {
              type: 'range',
              min: 0,
              max: 1500,
              step: 50,
              value: cur,
              oninput: (e: Event) => (label.textContent = `軒の出 ${(e.target as HTMLInputElement).value} mm`),
              onchange: (e: Event) => update({ eaves: +(e.target as HTMLInputElement).value }),
            });
            return h('label', { class: 'field', style: 'margin-top:10px' }, label, slider, h('span', { class: 'hint' }, '0〜150mm で軒の無い箱、450〜900mm で深い軒（夏の日射を遮ります）'));
          })(),
          h('div', { class: 'field-label', style: 'margin-top:10px' }, '時間帯'),
          segmented<TimeOfDay>(
            [
              { value: 'morning', label: '朝' },
              { value: 'day', label: '昼' },
              { value: 'evening', label: '夕景' },
              { value: 'night', label: '夜景' },
            ],
            state.design.timeOfDay,
            (val) => update({ timeOfDay: val }),
          ),
          h(
            'div',
            { class: 'btn-row', style: 'align-items:center' },
            h('span', { class: 'field-label', style: 'margin:0' }, '外壁の色'),
            h('input', {
              type: 'color',
              value: state.design.wallColorOverride ?? EXTERIOR_STYLES.find((s) => s.id === state.design.exteriorId)!.wall.color,
              onchange: (e: Event) => update({ wallColorOverride: (e.target as HTMLInputElement).value }),
            }),
            h('button', { class: 'btn sm ghost', onclick: () => update({ wallColorOverride: undefined }) }, '標準に戻す'),
            h('label', { class: 'check', style: 'margin-left:auto' }, h('input', { type: 'checkbox', checked: state.design.furniture, onchange: (e: Event) => update({ furniture: (e.target as HTMLInputElement).checked }) }), '家具'),
          ),
          h(
            'label',
            { class: 'check', title: '仕上げを白いクレイにして、形・光・空間だけを見るスタディ模型の表現。パース・輪切り・断面・カット集・立面図すべてに効きます' },
            h('input', { type: 'checkbox', checked: !!state.design.clay, onchange: (e: Event) => update({ clay: (e.target as HTMLInputElement).checked }) }),
            '白模型（スタディ模型）で見る',
          ),
        ),
      );
      // 見どころカメラはステージ下のフィルムストリップに
      renderStrip();
      // 撮影
      const samplesSel = h(
        'select',
        { onchange: (e: Event) => (state.render.samples = +(e.target as HTMLSelectElement).value) },
        h('option', { value: 256, selected: state.render.samples === 256 }, '標準（約30秒〜1分／枚）'),
        h('option', { value: 512, selected: state.render.samples === 512 }, '高品質（約1〜2分／枚）'),
        h('option', { value: 1200, selected: state.render.samples === 1200 }, '最高品質（数分／枚）'),
      ) as HTMLSelectElement;
      const sizeSel = h(
        'select',
        {
          onchange: (e: Event) => {
            const [w, hh] = (e.target as HTMLSelectElement).value.split('x').map(Number);
            state.render.width = w;
            state.render.height = hh;
          },
        },
        h('option', { value: '1280x720', selected: state.render.width === 1280 }, 'HD（1280×720・軽い）'),
        h('option', { value: '1920x1080', selected: state.render.width === 1920 }, 'フルHD（1920×1080）'),
        h('option', { value: '2560x1440', selected: state.render.width === 2560 }, 'WQHD（2560×1440）'),
        h('option', { value: '3840x2160', selected: state.render.width === 3840 }, '4K（3840×2160・印刷向け）'),
      ) as HTMLSelectElement;
      const currentAsShot = (): Shot => {
        const cur = v.currentView();
        const cutLv = v.cutawayLevel();
        const cc = v.currentCut();
        const sec = cc && 'section' in cc ? cc.section : undefined;
        return {
          id: active?.id ?? uid('custom'),
          kind: cutLv != null ? 'cutaway' : sec ? 'section' : (active?.kind ?? 'exterior'),
          title: active?.title ?? (cutLv != null ? `${cutLv}階 輪切り模型` : sec ? '断面パース' : 'パース'),
          caption: active?.caption ?? '',
          view: cur,
          sunDir: null,
          timeOfDay: state.design.timeOfDay,
          cutaway: cutLv ?? undefined,
          section: sec,
          level: cutLv ?? active?.level,
        };
      };
      const batch = async (list: Shot[], quality: 'photoreal' | 'realtime' | 'studio') => {
        const pm = progressModal(quality === 'photoreal' ? `提案用パースを写真品質で一括作成中（${list.length}枚）` : quality === 'studio' ? `提案用パースを高品質描画で一括作成中（${list.length}枚）` : 'おすすめパースを下書き作成中');
        const prev = v.currentView();
        const prevDesign = { ...state.design };
        let n = 0;
        clearPhotorealFailure();
        try {
          for (let i = 0; i < list.length; i++) {
            if (pm.signal.aborted) break;
            pm.set(i / list.length, list[i].title);
            const it = await captureShot(ctx, list[i], { quality, silent: true, progress: pm, slot: { index: i, total: list.length } });
            if (it) n++;
            // 1枚目から全ての段階で失敗した場合は、残りも同じ結果になるため中断
            else if (quality === 'photoreal' && n === 0 && lastPhotorealFailure) break;
            await new Promise((r) => setTimeout(r, 30));
          }
        } finally {
          pm.close();
          if (prevDesign.timeOfDay !== state.design.timeOfDay) update({ timeOfDay: prevDesign.timeOfDay });
          v.applyView(prev);
          renderGallery();
          if (n) toast(`${n}枚のパースを作成しました`, 'ok');
          if (lastPhotorealFailure) photorealFailed(ctx, lastPhotorealFailure.e, lastPhotorealFailure.shot);
        }
      };
      side.append(
        section(
          '写真仕上げ（カット集 → 好きなツール → 取り込み）',
          h('p', { class: 'hint', style: 'margin-top:0' }, '① カット集を保存（ZIP: 各カットの画像と、AI に渡す説明文）→ ② ChatGPT・Gemini・Midjourney・Krea など好きな画像生成ツールで写真に仕上げる → ③ 仕上がった画像をここで取り込むと、同じカットの下書きより優先してプレゼン資料に入ります。'),
          h('button', { class: 'btn primary block', onclick: () => void exportCuts(ctx, shots, { width: state.render.width, height: state.render.height }) }, `① カット集を保存（${shots.length}枚・ZIP）`),
          h('button', { class: 'btn dark block', style: 'margin-top:8px', onclick: () => void importFinishedImages(ctx, shots) }, '③ 仕上げた写真を取り込む（複数可）'),
          h('p', { class: 'hint' }, 'ファイル名の末尾の「__c-…」を残して保存すると、どのカットの仕上げか自動で分かります。名前が変わっても、取り込むときに一覧で選び直せます。'),
        ),
        section(
          '写真仕上げ（Google AI を直接呼ぶ・無料枠）',
          h('p', { class: 'hint', style: 'margin-top:0' }, '今の構図（高品質描画か、保存済みの写真品質パース）と輪郭の線画を Google の画像生成 AI に渡し、壁・窓・家具の位置を変えないよう指示して写真に仕上げます。仕上がりはギャラリー（プレゼン資料）に入ります。'),
          ...aiSettingsUi(),
          h('button', { class: 'btn primary block', onclick: () => void runAiFinish(ctx, currentAsShot()) }, '✨ この構図を写真に仕上げる'),
          h(
            'div',
            { class: 'btn-row' },
            h('button', { class: 'btn sm', onclick: () => void runAiFinishBatch(ctx, shots.filter((s) => s.kind === 'interior')) }, `内観を一括（${shots.filter((s) => s.kind === 'interior').length}枚）`),
            h('button', { class: 'btn sm', onclick: () => void runAiFinishBatch(ctx, shots.filter((s) => s.kind === 'exterior' || s.kind === 'aerial')) }, `外観を一括（${shots.filter((s) => s.kind === 'exterior' || s.kind === 'aerial').length}枚）`),
          ),
          h('p', { class: 'hint' }, '注意: 図面から作った画像が Google に送られます。守秘のある案件では使う前にご確認ください。AI は窓や家具の位置を変えることがあるので、仕上がりは必ず下絵と見比べてください。さらに上の画質が要るときは「3D モデルを書き出す」→ Blender（README 参照）。'),
        ),
        section(
          'カット集（高解像度で一括保存）',
          h('p', { class: 'hint', style: 'margin-top:0' }, '見どころカメラの構図を高品質描画で一括保存し、ZIP にまとめます。'),
          h('button', { class: 'btn primary block', onclick: () => void exportCuts(ctx, shots, { width: state.render.width, height: state.render.height }) }, `カット集を保存（${shots.length}枚・ZIP）`),
          
          h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => void exportCuts(ctx, shots.filter((s) => s.kind !== 'interior'), { width: state.render.width, height: state.render.height }) }, '外観だけ'), h('button', { class: 'btn sm', onclick: () => void exportCuts(ctx, shots.filter((s) => s.kind === 'interior'), { width: state.render.width, height: state.render.height }) }, '内観だけ'), h('button', { class: 'btn sm', onclick: () => void exportCuts(ctx, [currentAsShot()], { width: state.render.width, height: state.render.height }) }, 'この構図だけ')),
          h('p', { class: 'hint' }, 'サイズは下の「サイズ」の設定です。'),
        ),
        section(
          '提案用パースの書き出し',
          h('p', { class: 'hint', style: 'margin-top:0' }, '「写真品質」は光の反射・間接光を物理的に計算します（GPU の性能により数分）。途中で「ここで仕上げる」を押すと、その時点の画像で保存できます。計算できないパソコンでは自動で高品質描画に切り替えます。急ぐときは「高品質描画」（数秒）をお使いください。'),
          h(
            'button',
            {
              class: 'btn primary block',
              onclick: async () => {
                const shot = currentAsShot();
                const it = await captureShot(ctx, null, { quality: 'photoreal' });
                if (it) {
                  it.title = shot.title;
                  it.caption = shot.caption;
                  it.kind = shot.kind;
                  it.shotId = shot.id;
                  showImage(it);
                }
                renderGallery();
              },
            },
            'この構図を提案用パースとして保存（写真品質）',
          ),
          h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, '品質'), samplesSel), h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'サイズ'), sizeSel)),
          h('button', { class: 'btn dark block', onclick: () => batch(shots, 'photoreal') }, `おすすめパースを写真品質で一括作成（${shots.length}枚）`),
          h(
            'div',
            { class: 'btn-row' },
            h('button', { class: 'btn sm', onclick: async () => {
              const shot = currentAsShot();
              const it = await captureShot(ctx, null, { quality: 'studio' });
              if (it) {
                it.title = shot.title;
                it.caption = shot.caption;
                it.kind = shot.kind;
                it.shotId = shot.id;
                showImage(it);
              }
              renderGallery();
            } }, '高品質描画で保存（数秒）'),
            h('button', { class: 'btn sm', onclick: () => batch(shots, 'studio') }, '高品質描画で一括作成'),
          ),
          h(
            'button',
            {
              class: 'btn primary block',
              style: 'margin-top:10px',
              title: 'Blender・D5 Render・Twinmotion・Lumion などで写真品質のパースを作るための 3D モデル（材料・テクスチャ付き）と、見どころカメラの位置',
              onclick: async () => {
                const pm = progressModal('3D モデルを書き出しています', false);
                try {
                  const glb = await exportGlb(v);
                  downloadBlob(glb, `${state.name}_3Dモデル.glb`, 'model/gltf-binary');
                  downloadBlob(JSON.stringify(sceneInfo(v), null, 1), `${state.name}_カメラ.json`, 'application/json');
                  toast('3D モデル（.glb）とカメラ位置（.json）を書き出しました', 'ok');
                } catch (e) {
                  toast(`書き出しに失敗しました: ${(e as Error).message}`, 'error');
                } finally {
                  pm.close();
                }
              },
            },
            'D5・Twinmotion へ渡す 3D モデル（.glb＋カメラ）',
          ),
        ),
      );
      const gal = h('div', { class: 'gallery' });
      side.append(section('ギャラリー（プレゼン資料に使われます）', gal));
      const renderGallery = () => {
        clear(gal);
        if (!state.gallery.length) gal.appendChild(h('p', { class: 'hint' }, 'まだ画像がありません'));
        for (const g of state.gallery) {
          gal.appendChild(
            h(
              'figure',
              null,
              h('img', { src: g.url, onclick: () => showImage(g), style: 'cursor:zoom-in' }),
              h('span', { class: 'badge', style: g.quality === 'photoreal' ? 'background:#b8683a' : '' }, g.quality === 'photoreal' ? '提案用・写真品質' : '下書き'),
              h(
                'button',
                {
                  class: 'del',
                  title: '削除',
                  onclick: () => {
                    state.gallery = state.gallery.filter((x) => x !== g);
                    renderGallery();
                  },
                },
                '×',
              ),
              h('figcaption', null, g.title),
            ),
          );
        }
      };
      renderGallery();
      // ---- 区画をタブにまとめる（縦に長い一覧をやめ、今の作業に必要なものだけを見せる） ----
      const TABS: { id: string; label: string; match: RegExp }[] = [
        { id: 'taste', label: 'テイスト', match: /テイスト|細かく調整/ },
        { id: 'coord', label: 'コーディネート', match: /コーディネート/ },
        { id: 'spec', label: '納まり', match: /標準仕様/ },
        { id: 'export', label: '書き出し', match: /書き出し|カット集|ギャラリー|写真仕上げ/ },
      ];
      const secs = [...side.querySelectorAll(':scope > .panel-section')] as HTMLElement[];
      const panes = new Map(TABS.map((t) => [t.id, h('div', { class: 'tab-pane', 'data-tab': t.id })]));
      for (const sec of secs) {
        const title = sec.querySelector('h4, summary')?.textContent ?? '';
        const t = TABS.find((x) => x.match.test(title)) ?? TABS[0];
        panes.get(t.id)!.appendChild(sec);
      }
      const bar = h('div', { class: 'side-tabs' });
      const show = (id: string) => {
        designTab = id;
        for (const [k, el] of panes) el.hidden = k !== id;
        for (const b of bar.children) (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.tab === id);
      };
      for (const t of TABS) bar.appendChild(h('button', { class: 'side-tab', 'data-tab': t.id, onclick: () => show(t.id) }, t.label));
      side.append(bar, ...panes.values());
      show(designTab);
    };
    renderSide();
  },
};

export function showImage(g: GalleryItem) {
  modal(g.title, h('div', null, h('img', { src: g.url }), g.caption ? h('p', { style: 'font-size:13px;color:#5b6068' }, g.caption) : null), [
    { label: 'ダウンロード', primary: true, onClick: () => download(g.url, `${state.name}_${g.title}.jpg`) },
    { label: '閉じる' },
  ], true);
}


