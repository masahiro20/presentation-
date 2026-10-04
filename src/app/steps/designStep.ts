import * as THREE from 'three';
import { h, clear, toast, progressModal, section, segmented, modal, download } from '../dom';
import { state, uid, emit, type GalleryItem } from '../state';
import type { Step, StepCtx } from '../app';
import { EXTERIOR_STYLES, INTERIOR_STYLES, exteriorById, type DesignOptions, type RoofType, type TimeOfDay } from '../../styles/presets';
import { BUILDER_SPECS, resolveSpec } from '../../styles/spec';
import type { Shot } from '../../scene/shots';
import { renderPhotoreal, PhotorealError } from '../../scene/photoreal';
import { renderStudio } from '../../scene/studio';
import { exportGlb, sceneInfo, downloadBlob } from '../../scene/exportGlb';
import { exportCuts } from '../cuts';

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

/** 室内・夕景・夜景は露出を上げる（写真と同じ考え方） */
function exposureFor(kind: string | undefined, tod: string): number {
  if (kind === 'interior') return tod === 'night' ? 1.5 : 1.9;
  if (tod === 'night') return 1.4;
  if (tod === 'evening') return 1.15;
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
    // 1回目: 通常 → 2回目: テクスチャ・区画を小さく → 3回目: 半分の解像度で計算して拡大
    const stages = [
      { safe: false, w: W, h: H, note: '' },
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

export const designStep: Step = {
  id: 'design',
  label: '外観・内観パース',
  needsModel: true,
  uses3d: true,
  mount(ctx) {
    const v = ctx.app.viewer;
    v.setCutaway(null);
    ctx.app.viewer.groups.context.visible = false;
    let shots = currentShots(ctx);
    let active: Shot | null = null;
    if (!v.userData.shownDesign) {
      v.userData.shownDesign = true;
      const first = shots.find((s) => s.id === 'ext-front');
      if (first) {
        v.applyShot(first);
        active = first;
      }
    }

    // ---- ステージ上のツール ----
    const tools = h('div', { class: 'view-tools', style: 'pointer-events:auto' });
    const toolBtn = (label: string, fn: () => void) => h('button', { class: 'btn', onclick: fn }, label);
    const setCut = (lv: number | null) => {
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
        setCut(null);
        const s = shots.find((x) => x.id === 'ext-front');
        if (s) v.applyShot(s, true);
      }),
      toolBtn('鳥瞰', () => {
        setCut(null);
        const s = shots.find((x) => x.id === 'aerial');
        if (s) v.applyShot(s, true);
      }),
      ...v.state!.model.floors.map((f) => toolBtn(`${f.level}階 模型`, () => setCut(f.level))),
    );
    ctx.stage.appendChild(tools);

    // ---- サイドパネル ----
    const side = ctx.side;
    const update = (patch: Partial<DesignOptions>) => {
      state.design = { ...state.design, ...patch };
      v.setDesign(state.design);
      shots = currentShots(ctx);
      renderSide();
    };
    const renderSide = () => {
      clear(side);
      side.append(
        h('h2', null, '外観・内観パース'),
        h('p', { class: 'lead' }, '「こういうイメージ」を選ぶだけで、外壁・屋根・床・家具まで一式の仕上げが切り替わります。見どころのカメラは自動で用意しています。'),
      );
      const extCard = (s: (typeof EXTERIOR_STYLES)[number]) => styleCard(s, s.id === state.design.exteriorId, () => update({ exteriorId: s.id, roofOverride: undefined, roofPitch: undefined, wallColorOverride: undefined }));
      const intCard = (s: (typeof INTERIOR_STYLES)[number]) => styleCard(s, s.id === state.design.interiorId, () => update({ interiorId: s.id }));
      const others = (cards: HTMLElement[], open: boolean) =>
        h('details', { open, style: 'margin-top:8px' }, h('summary', { style: 'font-size:12.5px;color:#8b9098;cursor:pointer' }, 'その他のテイスト（比較用）'), h('div', { class: 'style-grid', style: 'margin-top:8px' }, cards));
      const spec = resolveSpec(state.design.specId, state.design.specPatch);
      side.append(
        section(
          '標準仕様（納まり）',
          segmented(
            BUILDER_SPECS.map((b) => ({ value: b.id, label: b.name })),
            state.design.specId,
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
            h('div', { class: 'field-label', style: 'margin-top:8px' }, '室内ドアの色'),
            h(
              'div',
              { class: 'btn-row' },
              ...[
                ['', 'テイスト標準'],
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
          '外観のテイスト',
          h('div', { class: 'style-grid' }, EXTERIOR_STYLES.filter((s) => s.id.startsWith('hl-')).map(extCard)),
          others(EXTERIOR_STYLES.filter((s) => !s.id.startsWith('hl-')).map(extCard), !state.design.exteriorId.startsWith('hl-')),
        ),
        section(
          '内観のテイスト',
          h('div', { class: 'style-grid' }, INTERIOR_STYLES.filter((s) => s.id.startsWith('hl-')).map(intCard)),
          others(INTERIOR_STYLES.filter((s) => !s.id.startsWith('hl-')).map(intCard), !state.design.interiorId.startsWith('hl-')),
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
            return h('label', { class: 'field', style: 'margin-top:10px' }, label, slider, h('span', { class: 'hint' }, '10 に対する立ち上がり。ホームランディック標準は片流れ 0.5 寸。切妻・寄棟にする場合は 3〜5 寸'));
          })(),
          h('div', { class: 'field-label', style: 'margin-top:10px' }, '時間帯'),
          segmented<TimeOfDay>(
            [
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
        ),
      );
      // 見どころ
      const list = h('div', { class: 'shot-list' });
      for (const s of shots) {
        list.appendChild(
          h(
            'button',
            {
              class: 'shot-btn',
              onclick: () => {
                v.setCutaway(null);
                v.applyShot(s, true);
                active = s;
              },
            },
            h('span', { class: `k ${s.kind === 'interior' ? 'int' : ''}` }, s.kind === 'interior' ? '内観' : s.kind === 'aerial' ? '鳥瞰' : '外観'),
            h('div', null, s.title.replace(/^内観パース|^外観パース/, '').replace(/[（）]/g, '') || s.title),
          ),
        );
      }
      side.append(section('見どころカメラ（自動）', list, h('p', { class: 'hint' }, 'ドラッグで回転（クリックした物を中心に回ります）、右ドラッグ（または画面右の「✋移動」・スペースキー）で画面を掴んで移動、ホイールでカーソルの位置へズーム。「👁目線」にすると人の目の高さで歩けます: ドラッグで見回し、ホイールまたは W・S で前後、A・D で左右、Shift で速く。壁は通り抜けず、階段も上れます。')));
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
        return { id: active?.id ?? uid('custom'), kind: active?.kind ?? 'exterior', title: active?.title ?? 'パース', caption: active?.caption ?? '', view: cur, sunDir: null, timeOfDay: state.design.timeOfDay };
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
          'AI 仕上げ用カット集',
          h('p', { class: 'hint', style: 'margin-top:0' }, '見どころカメラの構図を高品質描画で一括保存し、画像生成 AI に渡すための説明文（部屋・素材・光）を付けて ZIP にまとめます。構図と間取りはそのまま、質感だけを写真のように仕上げてもらう使い方です。'),
          h('button', { class: 'btn primary block', onclick: () => void exportCuts(ctx, shots, { width: state.render.width, height: state.render.height }) }, `📦 カット集を保存（${shots.length}枚・ZIP）`),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => void exportCuts(ctx, shots.filter((s) => s.kind !== 'interior'), { width: state.render.width, height: state.render.height }) }, '外観だけ'), h('button', { class: 'btn sm', onclick: () => void exportCuts(ctx, shots.filter((s) => s.kind === 'interior'), { width: state.render.width, height: state.render.height }) }, '内観だけ'), h('button', { class: 'btn sm', onclick: () => void exportCuts(ctx, [currentAsShot()], { width: state.render.width, height: state.render.height }) }, 'この構図だけ')),
          h('p', { class: 'hint' }, 'サイズは下の「サイズ」の設定です。ZIP の「カット一覧と説明文.txt」に、各カットのプロンプト（日本語・英語）が入っています。'),
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
            '✨ この構図を提案用パースとして保存（写真品質）',
          ),
          h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, '品質'), samplesSel), h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'サイズ'), sizeSel)),
          h('button', { class: 'btn dark block', onclick: () => batch(shots, 'photoreal') }, `🖼 おすすめパースを写真品質で一括作成（${shots.length}枚）`),
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
            } }, '⚡ 高品質描画で保存（数秒）'),
            h('button', { class: 'btn sm', onclick: () => batch(shots, 'studio') }, '⚡ 高品質描画で一括作成'),
          ),
          h(
            'button',
            {
              class: 'btn sm ghost block',
              style: 'margin-top:6px',
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
            '🧊 3D モデルを書き出す（.glb・外部レンダラー用）',
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
