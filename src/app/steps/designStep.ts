import * as THREE from 'three';
import { FINISH_CATEGORIES } from '../../coordinate/catalog';

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
import { exportCuts } from '../cuts';
import { listRefs, addRef, deleteRef, REF_KIND_LABEL, type RefKind } from '../styleRefs';
import { importFinishedImages, importFinishedVideos } from '../finishImport';
import { exportRoomTour, previewRoomTour } from '../roomTour';
import { startCinema } from '../cinema';
import { progress, reconcileDecided } from '../../coordinate/decisions';
import { harmonyCheck } from '../../coordinate/harmony';

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
      const before = state.design;
      state.design = { ...state.design, ...patch };
      emit('design');
      // テイストの切り替えで、コーディネートで決定済みの部位の中身が変わったら決定を外す
      const rec = reconcileDecided(state.coord, before, state.design);
      if (rec.undone.length) {
        state.coord = rec.coord;
        toast(`テイストを変えたので、コーディネートの ${rec.undone.join('・')} の決定を外しました`, 'info', 6000);
      }
      v.setDesign(state.design);
      shots = currentShots(ctx);
      renderSide();
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
          (() => {
            const pr = progress(state.coord);
            const warns = harmonyCheck(state.design).filter((x) => x.level === 'warn');
            return h(
              'div',
              null,
              h('p', { class: 'hint', style: 'margin:0 0 8px' }, '部位ごとの商品選び・候補の絞り込み・お客様の選択の受け取り・仕様決定書は「コーディネート」のステップにまとめました（3D と見積が同時に変わります）。'),
              h('p', { style: 'margin:0 0 8px;font-size:13px' }, `決定 ${pr.decided} / ${pr.total} 部位${warns.length ? `　・　組み合わせの要確認 ${warns.length}` : ''}`),
              h('button', { class: 'btn primary block', onclick: () => void ctx.app.go('coord') }, 'コーディネートを開く →'),
            );
          })(),
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
      // ---- 仕上げ（外部）: 写真の仕上げと動画はツールでは作らず、外部（Nano Banana Pro・動画 AI）で仕上げて取り込む ----
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
      const size = () => ({ width: state.render.width, height: state.render.height });
      let stopTour: (() => void) | null = null;
      const tourBtn = h('button', { class: 'btn sm' }, '▶ 経路を 3D で確かめる') as HTMLButtonElement;
      tourBtn.onclick = () => {
        if (stopTour) {
          stopTour();
          stopTour = null;
          tourBtn.textContent = '▶ 経路を 3D で確かめる';
          return;
        }
        tourBtn.textContent = '■ 止める';
        stopTour = previewRoomTour(ctx, shots, () => {
          stopTour = null;
          tourBtn.textContent = '▶ 経路を 3D で確かめる';
        });
      };
      // お手本の写真（事務所の写真庫）
      const refsBox = h('div', { class: 'gallery refs' });
      const renderRefs = async () => {
        clear(refsBox);
        const refs = await listRefs();
        if (!refs.length) refsBox.appendChild(h('p', { class: 'hint', style: 'grid-column:1/-1;margin:0' }, 'まだ登録されていません。'));
        for (const r of refs)
          refsBox.appendChild(
            h(
              'figure',
              null,
              h('img', { src: r.url, alt: r.name ?? '' }),
              h('figcaption', null, `${REF_KIND_LABEL[r.kind]}${r.name ? `　${r.name}` : ''}${r.office ? '　（事務所の既定）' : ''}`),
              r.office ? null : h('button', { class: 'btn xs ghost del', title: 'この お手本を写真庫から外す', onclick: async () => { await deleteRef(r.id); await renderRefs(); } }, '外す'),
            ),
          );
      };
      const pickRef = (kind: RefKind) => {
        const input = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' }) as HTMLInputElement;
        input.onchange = async () => {
          const files = [...(input.files ?? [])].slice(0, 3);
          for (const f of files) await addRef(f, kind);
          toast(`お手本（${REF_KIND_LABEL[kind]}）を ${files.length} 枚登録しました`, 'ok');
          await renderRefs();
        };
        document.body.appendChild(input);
        input.click();
        input.remove();
      };
      void renderRefs();
      side.append(
        section(
          '仕上げ（外部）① パースのカット集',
          h('p', { class: 'hint', style: 'margin-top:0' }, '見どころの構図を高解像度の下絵にして、Nano Banana Pro に貼る説明文（部屋・素材・品番の色・光）と一緒に ZIP で保存します。仕上げた写真は ③ で取り込むと、プレゼン資料の同じカットの下絵と入れ替わります。'),
          h('button', { class: 'btn primary block', onclick: () => void exportCuts(ctx, shots, size()) }, `カット集を保存（${shots.length}枚・ZIP）`),
          h(
            'div',
            { class: 'btn-row' },
            h('button', { class: 'btn sm', onclick: () => void exportCuts(ctx, shots.filter((s) => s.kind !== 'interior'), size()) }, '外観だけ'),
            h('button', { class: 'btn sm', onclick: () => void exportCuts(ctx, shots.filter((s) => s.kind === 'interior'), size()) }, '内観だけ'),
            h('button', { class: 'btn sm', onclick: () => void exportCuts(ctx, [currentAsShot()], size()) }, 'この構図だけ'),
          ),
          h('label', { class: 'field', style: 'margin-top:8px' }, h('span', { class: 'field-label' }, '下絵のサイズ'), sizeSel),
          h('p', { class: 'hint' }, 'こつ: 最初に仕上げた 1 枚（LDK など）を、次のカットから「参考画像」として一緒に渡すと、床・壁・光の色が全カットでそろいます。'),
        ),
        section(
          'お手本の写真（御社の仕上げパース）',
          h('p', { class: 'hint', style: 'margin-top:0' }, '御社の仕上げパースが「事務所の既定」として最初から入っています（カット集に「この写りで」と同梱され、色味・光・植栽の雰囲気が御社らしくそろいます）。このパソコンで別の写真を登録すると、そちらが優先して使われます（外観・内観それぞれ 3 枚まで）。'),
          refsBox,
          h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => void pickRef('exterior') }, '＋外観のお手本'), h('button', { class: 'btn sm', onclick: () => void pickRef('interior') }, '＋内観のお手本')),
        ),
        section(
          '仕上げ（外部）② ルームツアー動画の素材',
          h('p', { class: 'hint', style: 'margin-top:0' }, 'YouTube のルームツアーのように、玄関から入って目線の高さ・超広角（16mm 相当）で各部屋を見せる経路を図面から作り、部屋ごとの見せ場で見回す始めと終わりのキーフレーム（下絵。壁しか写らない構図は除く）と、2 枚ずつをつなぐ動画 AI 向けの指示文を ZIP にします。キーフレームを Nano Banana Pro で仕上げ → 動画 AI（Veo など、最初と最後のフレーム指定）でクリップに → つないで ③ で取り込みます。'),
          h('button', { class: 'btn primary block', onclick: () => void exportRoomTour(ctx, shots, size()) }, 'ルームツアーの素材を保存（ZIP）'),
          h('div', { class: 'btn-row' }, tourBtn),
        ),
        section(
          '仕上げ（外部）③ 仕上がりを取り込む',
          h('p', { class: 'hint', style: 'margin-top:0' }, '仕上げた写真・動画を取り込むと、プレゼン資料と「お客様に渡す」リンクに入ります。写真はファイル名の末尾の「__c-…」を残すと、どのカットか自動で分かります（名前が変わっても一覧で選び直せます）。'),
          h('button', { class: 'btn dark block', onclick: () => void importFinishedImages(ctx, shots) }, '仕上げた写真を取り込む（複数可）'),
          h('button', { class: 'btn dark block', style: 'margin-top:8px', onclick: () => void importFinishedVideos(() => renderGallery()) }, '仕上げた動画を取り込む（MP4・MOV・WebM）'),
        ),
      );
      const gal = h('div', { class: 'gallery' });
      side.append(section('仕上げ（外部）ギャラリー（プレゼン資料に使われます）', gal));
      const renderGallery = () => {
        clear(gal);
        if (!state.gallery.length && !state.videos.length) gal.appendChild(h('p', { class: 'hint' }, 'まだ取り込んだ写真・動画がありません（資料には 3D の下絵が入ります）'));
        for (const vd of state.videos) {
          gal.appendChild(
            h(
              'figure',
              null,
              h('video', { src: vd.url, muted: true, controls: true, preload: 'metadata' }),
              h('span', { class: 'badge', style: 'background:#b8683a' }, '動画'),
              h('button', { class: 'del', title: '削除', onclick: () => { state.videos = state.videos.filter((x) => x !== vd); renderGallery(); } }, '×'),
              h('figcaption', null, vd.title),
            ),
          );
        }
        for (const g of state.gallery) {
          gal.appendChild(
            h(
              'figure',
              null,
              h('img', { src: g.url, onclick: () => showImage(g), style: 'cursor:zoom-in' }),
              h('span', { class: 'badge', style: g.quality === 'photoreal' ? 'background:#b8683a' : '' }, g.quality === 'photoreal' ? '仕上げ済み' : '下絵'),
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
        { id: 'export', label: '仕上げ（外部）', match: /仕上げ（外部）|お手本の写真/ },
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


