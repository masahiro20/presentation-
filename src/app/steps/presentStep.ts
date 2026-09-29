import * as THREE from 'three';
import { h, clear, toast, progressModal, section, download } from '../dom';
import { state, type GalleryItem } from '../state';
import type { Step, StepCtx } from '../app';
import { exteriorById, interiorById } from '../../styles/presets';
import { captureShot, currentShots } from './designStep';
import { renderElevation, type ElevationDir } from '../../drawings/elevation';
import { floorPlanSvg } from '../../drawings/plan';
import { analyzeRooms } from '../../sun/analysis';
import { sunHighlights, sunTimelineSvg, type SeasonResult } from '../../sun/report';
import { siteLatLon } from '../../sun/geo';
import { keyDates, sunPosition, sunDirectionWorld, localDate } from '../../sun/solar';
import { ROOM_TYPE_LABEL } from '../../core/types';

/** 足りない素材をすべて自動で作る（一気通貫） */
export async function autoGenerate(ctx: StepCtx, draft = false) {
  const app = ctx.app;
  app.ensureScene();
  const v = app.viewer;
  const pm = progressModal('プレゼン資料の素材を自動作成しています');
  const prevView = v.currentView();
  const prevDesign = { ...state.design };
  try {
    // パース
    // 提案用パース（写真品質）: まだ写真品質のないショットだけ
    const all = currentShots(ctx);
    const pick = [
      ...all.filter((s) => ['ext-front', 'ext-garden', 'ext-evening', 'aerial'].includes(s.id)),
      ...all.filter((s) => s.kind === 'interior').slice(0, 4),
    ].filter((s) => !state.gallery.some((g) => g.shotId === s.id && g.quality === (draft ? 'realtime' : 'photoreal')));
    if (pick.length) {
      const shots = pick;
      const sub = {
        signal: pm.signal,
        set: (r: number, msg?: string, preview?: string) => pm.set(r * 0.7, msg, preview),
      };
      for (let i = 0; i < shots.length; i++) {
        if (pm.signal.aborted) return;
        await captureShot(ctx, shots[i], { quality: draft ? 'realtime' : 'photoreal', silent: true, progress: sub, slot: { index: i, total: shots.length } });
        await new Promise((r) => setTimeout(r, 20));
      }
      if (prevDesign.timeOfDay !== state.design.timeOfDay) {
        state.design = prevDesign;
        v.setDesign(state.design);
      }
    }
    // 図面
    pm.set(0.72, '立面図・平面図を作成中');
    await new Promise((r) => setTimeout(r, 20));
    if (!state.elevations.length) {
      state.elevations = (['south', 'east', 'north', 'west'] as ElevationDir[]).map((d) => {
        const r = renderElevation(v, d, { color: true });
        return { dir: d, title: r.title, svg: r.svg };
      });
    }
    state.plans = state.model!.floors.map((f) => ({ level: f.level, svg: floorPlanSvg(state.model!, f) }));
    // 日照
    if (!state.sun.seasons.length) {
      const { lat, lon } = siteLatLon(state.site);
      const seasons: SeasonResult[] = [];
      const dates = keyDates(new Date().getFullYear()).filter((d) => d.id !== 'autumn');
      for (let i = 0; i < dates.length; i++) {
        if (pm.signal.aborted) return;
        const d = dates[i];
        const rooms = await analyzeRooms(v, { year: d.year, month: d.month, day: d.day, lat, lon, northAngleDeg: state.model!.northAngleDeg }, { onProgress: (r) => pm.set(0.75 + ((i + r) / dates.length) * 0.12, `日当たりを解析中（${d.label}）`) });
        seasons.push({ id: d.id as SeasonResult['id'], label: d.label, dateLabel: `${d.month}月${d.day}日`, rooms });
      }
      const order = ['winter', 'spring', 'summer'];
      seasons.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      state.sun.seasons = seasons;
      state.sun.highlights = sunHighlights(seasons);
    }
    if (!state.sun.images.length) {
      const { lat, lon } = siteLatLon(state.site);
      const y = new Date().getFullYear();
      const ldkShot = currentShots(ctx).find((s) => s.kind === 'interior');
      const b = v.state!.meta.bbox;
      const c = b.getCenter(new THREE.Vector3());
      const R = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
      const aerial = { pos: c.clone().set(c.x + R * 1.5, R * 1.6, c.z + R * 2), target: c.clone().setY(1), fov: 45 };
      const list = [
        { label: '冬至 10:00（外観）', m: 12, d: 22, hh: 10, view: aerial },
        { label: '冬至 14:00（外観）', m: 12, d: 22, hh: 14, view: aerial },
        ...(ldkShot ? [{ label: '冬至 12:00（室内）', m: 12, d: 22, hh: 12, view: ldkShot.view }, { label: '夏至 12:00（室内）', m: 6, d: 21, hh: 12, view: ldkShot.view }] : []),
      ];
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        pm.set(0.87 + (i / list.length) * 0.12, `日当たり比較を撮影中（${s.label}）`);
        const sp = sunPosition(localDate(y, s.m, s.d, s.hh), lat, lon);
        v.setSunDirection(sunDirectionWorld(sp.azimuth, sp.elevation, state.model!.northAngleDeg));
        v.applyView(s.view);
        state.sun.images.push({ label: s.label, url: await v.capture(1600, 900) });
      }
    }
    toast('プレゼン資料の素材がそろいました', 'ok');
  } finally {
    v.applyView(prevView);
    pm.close();
  }
}

function slide(cls: string, ...children: (Node | null)[]) {
  return h('div', { class: `slide ${cls}` }, ...children);
}

function pick(kind: GalleryItem['kind']) {
  const list = state.gallery.filter((g) => g.kind === kind);
  // 写真品質を優先し、同じ構図の下書きは除く
  const photo = list.filter((g) => g.quality === 'photoreal');
  const drafts = list.filter((g) => g.quality !== 'photoreal' && !photo.some((p) => p.shotId && p.shotId === g.shotId));
  return [...photo, ...drafts];
}

/** 下書き画像には「下書き」の印を付け、提案時に気付けるようにする */
function draftMark(g: GalleryItem | undefined) {
  return g && g.quality !== 'photoreal' ? h('div', { style: 'position:absolute;top:2%;right:2%;background:rgba(184,104,58,0.9);color:#fff;font-size:11px;padding:3px 8px;border-radius:4px' }, '下書き（写真品質で書き出してください）') : null;
}

export function buildDeck(): HTMLElement[] {
  const model = state.model!;
  const ext = exteriorById(state.design.exteriorId);
  const int = interiorById(state.design.interiorId);
  const exts = pick('exterior').filter((g) => !/夕景|夜景/.test(g.title)).concat(pick('exterior').filter((g) => /夕景|夜景/.test(g.title)));
  const ints = pick('interior');
  const aerial = pick('aerial')[0];
  const hero = exts[0] ?? aerial ?? ints[0];
  const slides: HTMLElement[] = [];
  const brand = state.company || '';
  const today = new Date();
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const totalArea = model.floors.reduce((s, f) => s + f.rooms.reduce((a, r) => a + r.area, 0), 0);
  const ldk = model.floors.flatMap((f) => f.rooms).find((r) => r.type === 'ldk' || r.type === 'living');

  // 表紙
  slides.push(
    slide(
      'cover',
      hero ? h('img', { class: 'bg', src: hero.url }) : null,
      h('div', { class: 'shade' }),
      h('div', { class: 'txt' }, h('div', { class: 'en' }, 'HOUSE PLAN PRESENTATION'), h('h1', null, state.name), h('p', null, `${state.customer}　ご提案資料　${dateStr}`), brand ? h('p', null, brand) : null),
    ),
  );
  // コンセプト
  slides.push(
    slide(
      '',
      h(
        'div',
        { class: 'pad' },
        h('h2', null, h('small', null, 'CONCEPT'), '暮らしのイメージ'),
        h(
          'div',
          { class: 'grow' },
          h(
            'div',
            { class: 'col', style: 'flex:0.9' },
            h('p', null, h('b', null, `外観：${ext.name}`), h('br'), ext.description),
            h('p', null, h('b', null, `内観：${int.name}`), h('br'), int.description),
            h('p', null, `延床面積 約${totalArea.toFixed(1)}㎡（約${(totalArea / 3.30579).toFixed(1)}坪）・${model.floors.length}階建て${ldk ? `・${(ldk.labeledTatami ?? ldk.area / 1.62).toFixed(1)}帖の${ldk.name}` : ''}`),
            state.sun.highlights[0] ? h('p', null, h('b', null, `☀ ${state.sun.highlights[0].title}`), h('br'), state.sun.highlights[0].body) : null,
          ),
          h('div', { class: 'col' }, exts[0] ? h('div', { class: 'fill' }, h('img', { src: exts[0].url })) : null, ints[0] ? h('div', { class: 'fill' }, h('img', { src: ints[0].url })) : null),
        ),
      ),
    ),
  );
  // 間取り
  if (state.plans.length) {
    slides.push(
      slide(
        '',
        h(
          'div',
          { class: 'pad' },
          h('h2', null, h('small', null, 'FLOOR PLAN'), '間取り'),
          h('div', { class: 'grow' }, state.plans.map((p) => h('div', { class: 'fill' }, h('div', { class: 'svgbox', html: p.svg })))),
        ),
      ),
    );
  }
  // 外観
  for (const g of exts.slice(0, 5)) slides.push(slide('', h('div', { class: 'fill', style: 'position:absolute;inset:0' }, h('img', { src: g.url, style: 'border-radius:0' })), h('div', { class: 'cap' }, h('b', null, g.title), g.caption), draftMark(g)));
  if (aerial) slides.push(slide('', h('div', { class: 'fill', style: 'position:absolute;inset:0' }, h('img', { src: aerial.url, style: 'border-radius:0' })), h('div', { class: 'cap' }, h('b', null, aerial.title), aerial.caption)));
  // 内観
  for (const g of ints) slides.push(slide('', h('div', { class: 'fill', style: 'position:absolute;inset:0' }, h('img', { src: g.url, style: 'border-radius:0' })), h('div', { class: 'cap' }, h('b', null, g.title.replace(/内観パース[（(]?/, '').replace(/[）)]$/, '')), g.caption), draftMark(g)));
  // 立面図
  if (state.elevations.length) {
    slides.push(
      slide(
        '',
        h(
          'div',
          { class: 'pad' },
          h('h2', null, h('small', null, 'ELEVATION'), '立面図'),
          h(
            'div',
            { class: 'grow', style: 'flex-wrap:wrap' },
            state.elevations.map((e) => h('div', { class: 'fill', style: 'flex:0 0 49%;height:49%' }, h('div', { class: 'svgbox', html: e.svg }))),
          ),
        ),
      ),
    );
  }
  // 日照
  if (state.sun.seasons.length || state.sun.images.length) {
    const winter = state.sun.seasons.find((s) => s.id === 'winter') ?? state.sun.seasons[0];
    slides.push(
      slide(
        '',
        h(
          'div',
          { class: 'pad' },
          h('h2', null, h('small', null, 'SUNLIGHT'), '日当たりシミュレーション'),
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'col', style: 'flex:0.8;overflow:hidden' }, ...state.sun.highlights.slice(0, 3).map((hl) => h('p', null, h('b', null, `☀ ${hl.title}`), h('br'), hl.body))),
            winter ? h('div', { class: 'col' }, h('div', { class: 'fill' }, h('div', { class: 'svgbox', html: sunTimelineSvg(winter) }))) : null,
          ),
        ),
      ),
    );
    if (state.sun.images.length) {
      slides.push(
        slide(
          '',
          h(
            'div',
            { class: 'pad' },
            h('h2', null, h('small', null, 'SEASONS'), '季節・時刻による日差しの違い'),
            h(
              'div',
              { class: 'grow', style: 'flex-wrap:wrap' },
              state.sun.images.slice(0, 4).map((im) => h('div', { class: 'fill', style: 'flex:0 0 49%;height:48%' }, h('img', { src: im.url }), h('div', { class: 'cap', style: 'border-radius:0 0 4px 4px' }, im.label))),
            ),
          ),
        ),
      );
    }
    if (state.sun.diagramSvg) {
      slides.push(slide('', h('div', { class: 'pad' }, h('h2', null, h('small', null, 'SHADOW'), '日影図（冬至）'), h('div', { class: 'grow' }, h('div', { class: 'fill' }, h('div', { class: 'svgbox', html: state.sun.diagramSvg! }))))));
    }
  }
  // 部屋の一覧
  const rows = model.floors.flatMap((f) => f.rooms.filter((r) => r.area > 2).map((r) => [`${f.level}F`, r.name, ROOM_TYPE_LABEL[r.type], `${(r.labeledTatami ?? r.area / 1.62).toFixed(1)}帖`]));
  slides.push(
    slide(
      '',
      h(
        'div',
        { class: 'pad' },
        h('h2', null, h('small', null, 'ROOMS'), 'お部屋の一覧'),
        h(
          'div',
          { class: 'grow' },
          h(
            'div',
            { class: 'col', style: 'font-size:clamp(9px,1vw,13px);columns:2;display:block' },
            ...rows.map((r) => h('div', { style: 'display:flex;gap:8px;border-bottom:1px solid #eee;padding:3px 0;break-inside:avoid' }, h('span', { style: 'color:#b8683a;width:2.5em' }, r[0]), h('span', { style: 'flex:1' }, r[1]), h('span', { style: 'color:#888' }, r[3]))),
          ),
        ),
      ),
    ),
  );
  // 動画
  if (state.videos.length) {
    slides.push(slide('', h('div', { class: 'pad' }, h('h2', null, h('small', null, 'MOVIE'), state.videos[0].title), h('div', { class: 'grow' }, h('div', { class: 'fill' }, h('video', { src: state.videos[0].url, controls: true, muted: true, loop: true, poster: hero?.url }))))));
  }
  // 締め
  slides.push(
    slide(
      'cover',
      (exts[1] ?? hero) ? h('img', { class: 'bg', src: (exts[1] ?? hero)!.url }) : null,
      h('div', { class: 'shade' }),
      h('div', { class: 'txt' }, h('div', { class: 'en' }, 'THANK YOU'), h('h1', null, '理想の暮らしを、かたちに。'), h('p', null, brand || 'ご清聴ありがとうございました')),
    ),
  );
  slides.forEach((s, i) => {
    if (!s.classList.contains('cover')) s.appendChild(h('div', { class: 'pageno' }, `${i + 1} / ${slides.length}`));
    if (!s.classList.contains('cover') && brand) s.appendChild(h('div', { class: 'brandline' }, brand));
  });
  return slides;
}

function present(slides: HTMLElement[]) {
  let i = 0;
  const box = h('div', { class: 'present-full' });
  const show = () => {
    clear(box);
    box.appendChild(slides[i].cloneNode(true));
  };
  const close = () => {
    box.remove();
    nav.remove();
    document.removeEventListener('keydown', key);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') i = Math.min(slides.length - 1, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') i = Math.max(0, i - 1);
    else if (e.key === 'Escape') return close();
    else return;
    show();
  };
  const nav = h(
    'div',
    { class: 'present-nav' },
    h('button', { class: 'btn sm', onclick: () => { i = Math.max(0, i - 1); show(); } }, '◀'),
    h('button', { class: 'btn sm', onclick: () => { i = Math.min(slides.length - 1, i + 1); show(); } }, '▶'),
    h('button', { class: 'btn sm', onclick: close }, '終了'),
  );
  box.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).tagName === 'VIDEO') return;
    i = Math.min(slides.length - 1, i + 1);
    show();
  });
  document.addEventListener('keydown', key);
  document.body.append(box, nav);
  box.requestFullscreen?.().catch(() => {});
  show();
}

async function exportHtml(slides: HTMLElement[]) {
  const css = [...document.styleSheets]
    .map((s) => {
      try {
        return [...s.cssRules].map((r) => r.cssText).join('\n');
      } catch {
        return '';
      }
    })
    .join('\n');
  const body = slides.map((s) => s.outerHTML).join('\n');
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${state.name}</title><style>${css}\nbody{overflow:auto;background:#2a2d31;padding:24px 0}</style></head><body>${body}</body></html>`;
  const blob = new Blob([html], { type: 'text/html' });
  download(URL.createObjectURL(blob), `${state.name}_プレゼン.html`);
}

export const presentStep: Step = {
  id: 'present',
  label: 'プレゼン資料',
  needsModel: true,
  uses3d: false,
  mount(ctx) {
    const deck = h('div', { class: 'deck view' });
    ctx.stage.appendChild(deck);
    const render = () => {
      clear(deck);
      const slides = buildDeck();
      deck.append(
        h(
          'div',
          { class: 'deck-tools' },
          h('button', { class: 'btn primary', onclick: () => present(buildDeck()) }, '▶ プレゼンを開始（全画面）'),
          h('button', { class: 'btn', onclick: () => window.print() }, '🖨 PDF で保存（印刷）'),
          h('button', { class: 'btn', onclick: () => exportHtml(buildDeck()) }, '⬇ HTML で保存（お客様へ送付用）'),
        ),
        ...slides,
      );
    };
    render();
    ctx.side.append(
      h('h2', null, 'プレゼン資料'),
      h('p', { class: 'lead' }, 'ここまでに作成したパース・図面・日照検討・動画から、お客様向けのプレゼン資料を自動で組み立てます。足りない素材はボタン一つで自動作成できます。'),
      h('button', { class: 'btn primary block', onclick: async () => { await autoGenerate(ctx); render(); } }, '✨ 足りない素材を自動作成して資料を完成（写真品質）'),
      h('p', { class: 'hint' }, `提案用パース（外観・夕景・鳥瞰・主な部屋）を写真品質でレンダリングします。1枚あたり1〜2分ほどかかります。`),
      h('button', { class: 'btn sm ghost', onclick: async () => { await autoGenerate(ctx, true); render(); } }, 'まずは下書きで資料の構成を確認（すぐ）'),
      section(
        '表紙の情報',
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'プロジェクト名'), h('input', { type: 'text', value: state.name, onchange: (e: Event) => { state.name = (e.target as HTMLInputElement).value; render(); } })),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'お客様名'), h('input', { type: 'text', value: state.customer, onchange: (e: Event) => { state.customer = (e.target as HTMLInputElement).value; render(); } })),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '会社名・担当者'), h('input', { type: 'text', value: state.company, onchange: (e: Event) => { state.company = (e.target as HTMLInputElement).value; render(); } })),
      ),
      section(
        '収録内容',
        h(
          'ul',
          { style: 'font-size:13px;line-height:1.9;color:#5b6068;padding-left:18px;margin:0' },
          h('li', null, `パース ${state.gallery.length} 枚（写真品質 ${state.gallery.filter((g) => g.quality === 'photoreal').length} 枚）`),
          h('li', null, `立面図 ${state.elevations.length} 面・平面図 ${state.plans.length} 枚`),
          h('li', null, `日照解析 ${state.sun.seasons.length ? '済' : '未'}／日影図 ${state.sun.diagramSvg ? '済' : '未'}`),
          h('li', null, `動画 ${state.videos.length} 本`),
        ),
        h('p', { class: 'hint' }, '写真品質のパースがある場合は優先して使われます。印刷は A4 横に最適化されています。'),
      ),
    );
  },
};
