import * as THREE from 'three';
import { h, clear, toast, progressModal, section, segmented, modal, download } from '../dom';
import { state, uid, emit, type GalleryItem } from '../state';
import type { Step, StepCtx } from '../app';
import { EXTERIOR_STYLES, INTERIOR_STYLES, type DesignOptions, type RoofType, type TimeOfDay } from '../../styles/presets';
import { BUILDER_SPECS, specById } from '../../styles/spec';
import type { Shot } from '../../scene/shots';
import { renderPhotoreal } from '../../scene/photoreal';

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
  quality: 'realtime' | 'photoreal';
  samples?: number;
  silent?: boolean;
  /** 一括作成時: 進捗表示を共有 */
  progress?: { set(r: number, msg?: string, preview?: string): void; signal: AbortSignal };
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
  if (quality === 'photoreal') {
    const own = opts.progress ? null : progressModal('提案用パースを写真品質でレンダリング中（光の反射・間接光を計算しています）');
    const pm = opts.progress ?? own!;
    const slot = opts.slot ?? { index: 0, total: 1 };
    try {
      url = await renderPhotoreal(v, {
        width: W,
        height: H,
        samples,
        signal: pm.signal,
        exposure: exposureFor(shot?.kind ?? (v.camera.position.y < 8 && v.state && isInside(ctx) ? 'interior' : 'exterior'), v.design.timeOfDay),
        onProgress: (s, total, preview) =>
          pm.set((slot.index + s / total) / slot.total, `${shot?.title ?? 'パース'}：${s} / ${total} サンプル`, s % 32 === 0 && preview ? preview() : undefined),
      });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast(`レンダリングに失敗しました: ${(e as Error).message}`, 'error');
      return null;
    } finally {
      own?.close();
    }
  } else {
    url = await v.capture(W, H);
  }
  const item: GalleryItem = {
    id: uid('img'),
    title: shot?.title ?? 'パース',
    caption: shot?.caption ?? '',
    url,
    kind: shot?.kind ?? 'other',
    quality,
    shotId: shot?.id,
  };
  // 同じショットの古い画像は置き換え
  const idx = state.gallery.findIndex((g) => g.shotId && g.shotId === item.shotId && g.quality === quality);
  if (idx >= 0) state.gallery.splice(idx, 1, item);
  else state.gallery.push(item);
  emit('gallery');
  if (!opts.silent) toast(quality === 'photoreal' ? '提案用パース（写真品質）を保存しました' : '下書きパースを保存しました', 'ok');
  return item;
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
      const extCard = (s: (typeof EXTERIOR_STYLES)[number]) => styleCard(s, s.id === state.design.exteriorId, () => update({ exteriorId: s.id, roofOverride: undefined, wallColorOverride: undefined }));
      const intCard = (s: (typeof INTERIOR_STYLES)[number]) => styleCard(s, s.id === state.design.interiorId, () => update({ interiorId: s.id }));
      const others = (cards: HTMLElement[], open: boolean) =>
        h('details', { open, style: 'margin-top:8px' }, h('summary', { style: 'font-size:12.5px;color:#8b9098;cursor:pointer' }, 'その他のテイスト（比較用）'), h('div', { class: 'style-grid', style: 'margin-top:8px' }, cards));
      const spec = specById(state.design.specId);
      side.append(
        section(
          '標準仕様（納まり）',
          segmented(
            BUILDER_SPECS.map((b) => ({ value: b.id, label: b.name })),
            state.design.specId,
            (val) => update({ specId: val }),
          ),
          h('p', { class: 'hint' }, spec.description),
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
      side.append(section('見どころカメラ（自動）', list, h('p', { class: 'hint' }, 'ドラッグで回転・右ドラッグで移動・ホイールでズーム。気に入った構図で撮影してください。')));
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
        h('option', { value: '1920x1080', selected: state.render.width === 1920 }, 'フルHD（1920×1080）'),
        h('option', { value: '2560x1440', selected: state.render.width === 2560 }, 'WQHD（2560×1440）'),
        h('option', { value: '3840x2160', selected: state.render.width === 3840 }, '4K（3840×2160・印刷向け）'),
      ) as HTMLSelectElement;
      const currentAsShot = (): Shot => {
        const cur = v.currentView();
        return { id: active?.id ?? uid('custom'), kind: active?.kind ?? 'exterior', title: active?.title ?? 'パース', caption: active?.caption ?? '', view: cur, sunDir: null, timeOfDay: state.design.timeOfDay };
      };
      const batch = async (list: Shot[], quality: 'photoreal' | 'realtime') => {
        const pm = progressModal(quality === 'photoreal' ? `提案用パースを写真品質で一括作成中（${list.length}枚）` : 'おすすめパースを下書き作成中');
        const prev = v.currentView();
        const prevDesign = { ...state.design };
        let n = 0;
        try {
          for (let i = 0; i < list.length; i++) {
            if (pm.signal.aborted) break;
            pm.set(i / list.length, list[i].title);
            const it = await captureShot(ctx, list[i], { quality, silent: true, progress: pm, slot: { index: i, total: list.length } });
            if (it) n++;
            await new Promise((r) => setTimeout(r, 30));
          }
        } finally {
          pm.close();
          if (prevDesign.timeOfDay !== state.design.timeOfDay) update({ timeOfDay: prevDesign.timeOfDay });
          v.applyView(prev);
          renderGallery();
          toast(`${n}枚のパースを作成しました`, 'ok');
        }
      };
      side.append(
        section(
          '提案用パースの書き出し',
          h('p', { class: 'hint', style: 'margin-top:0' }, '操作中の画面は動きを優先したリアルタイム表示です。提案用に保存するパースは、光の反射・間接光・柔らかな影を物理的に計算した写真品質で書き出します。'),
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
            h('button', { class: 'btn sm ghost', onclick: () => captureShot(ctx, null, { quality: 'realtime' }).then(() => renderGallery()) }, '下書きとして保存（すぐ）'),
            h('button', { class: 'btn sm ghost', onclick: () => batch(shots, 'realtime') }, '下書きを一括作成'),
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
