import * as THREE from 'three';
import { h, clear, toast, progressModal, section, segmented, modal, download } from '../dom';
import { state, uid, emit, type GalleryItem } from '../state';
import type { Step, StepCtx } from '../app';
import { EXTERIOR_STYLES, INTERIOR_STYLES, type DesignOptions, type RoofType, type TimeOfDay } from '../../styles/presets';
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

export async function captureShot(ctx: StepCtx, shot: Shot | null, quality: 'realtime' | 'photoreal', samples = 256, silent = false): Promise<GalleryItem | null> {
  const v = ctx.app.viewer;
  if (shot) v.applyShot(shot);
  const W = 1920;
  const H = 1080;
  let url: string;
  if (quality === 'photoreal') {
    const pm = progressModal('写真品質でレンダリング中（光の反射・間接光を計算しています）');
    try {
      url = await renderPhotoreal(v, {
        width: W,
        height: H,
        samples,
        signal: pm.signal,
        onProgress: (s, total, preview) => pm.set(s / total, `${s} / ${total} サンプル`, s % 32 === 0 && preview ? preview() : undefined),
      });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast(`レンダリングに失敗しました: ${(e as Error).message}`, 'error');
      return null;
    } finally {
      pm.close();
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
  if (!silent) toast('パースをギャラリーに追加しました', 'ok');
  return item;
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
      side.append(
        section('外観のテイスト', h('div', { class: 'style-grid' }, EXTERIOR_STYLES.map((s) => styleCard(s, s.id === state.design.exteriorId, () => update({ exteriorId: s.id, roofOverride: undefined, wallColorOverride: undefined }))))),
        section('内観のテイスト', h('div', { class: 'style-grid' }, INTERIOR_STYLES.map((s) => styleCard(s, s.id === state.design.interiorId, () => update({ interiorId: s.id }))))),
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
      const samplesSel = h('select', null, h('option', { value: 192 }, '標準（約30秒〜）'), h('option', { value: 512, selected: true }, '高品質（約1〜2分）'), h('option', { value: 1200 }, '最高品質（数分）')) as HTMLSelectElement;
      side.append(
        section(
          '撮影・書き出し',
          h(
            'div',
            { class: 'btn-row' },
            h('button', { class: 'btn dark', onclick: () => captureShot(ctx, null, 'realtime').then(() => renderGallery()) }, '📷 この構図を保存'),
            h(
              'button',
              {
                class: 'btn primary',
                onclick: async () => {
                  const cur = v.currentView();
                  const shot: Shot = { id: active?.id ?? uid('custom'), kind: active?.kind ?? 'exterior', title: active?.title ?? 'パース', caption: active?.caption ?? '', view: cur, sunDir: null, timeOfDay: state.design.timeOfDay };
                  await captureShot(ctx, null, 'photoreal', +samplesSel.value).then((it) => {
                    if (it) {
                      it.title = shot.title;
                      it.caption = shot.caption;
                      it.kind = shot.kind;
                      it.shotId = shot.id;
                      showImage(it);
                    }
                  });
                  renderGallery();
                },
              },
              '✨ 写真品質でレンダリング',
            ),
          ),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, '写真品質の設定'), samplesSel),
          h(
            'button',
            {
              class: 'btn block',
              onclick: async () => {
                const pm = progressModal('おすすめパースを一括作成中');
                const prev = v.currentView();
                const prevDesign = { ...state.design };
                try {
                  for (let i = 0; i < shots.length; i++) {
                    if (pm.signal.aborted) break;
                    pm.set(i / shots.length, shots[i].title);
                    await captureShot(ctx, shots[i], 'realtime', 0, true);
                    await new Promise((r) => setTimeout(r, 30));
                  }
                } finally {
                  pm.close();
                  if (prevDesign.timeOfDay !== state.design.timeOfDay) update({ timeOfDay: prevDesign.timeOfDay });
                  v.applyView(prev);
                  renderGallery();
                  toast(`${shots.length}枚のパースを作成しました`, 'ok');
                }
              },
            },
            '🖼 おすすめパースを一括作成（リアルタイム画質）',
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
              h('span', { class: 'badge' }, g.quality === 'photoreal' ? '写真品質' : 'リアルタイム'),
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
