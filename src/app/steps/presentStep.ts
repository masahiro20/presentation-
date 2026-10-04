import * as THREE from 'three';
import { h, clear, toast, progressModal, section, download } from '../dom';
import { state, type GalleryItem } from '../state';
import type { Step, StepCtx } from '../app';
import { exteriorById, interiorById } from '../../styles/presets';
import { captureShot, clearPhotorealFailure, lastPhotorealFailure, photorealFailed, currentShots } from './designStep';
import { renderElevation, type ElevationDir } from '../../drawings/elevation';
import { floorPlanSvg } from '../../drawings/plan';
import { analyzeRooms } from '../../sun/analysis';
import { externalSampleY } from '../externalBuilding';
import { sunHighlights, sunTimelineSvg, type SeasonResult } from '../../sun/report';
import { siteLatLon } from '../../sun/geo';
import { keyDates, sunPosition, sunDirectionWorld, localDate } from '../../sun/solar';
import { resolveSpec } from '../../styles/spec';

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
    ].filter((s) => !state.gallery.some((g) => g.shotId === s.id && g.quality === 'photoreal'));
    if (pick.length) {
      const shots = pick;
      const sub = {
        signal: pm.signal,
        set: (r: number, msg?: string, preview?: string) => pm.set(r * 0.7, msg, preview),
      };
      clearPhotorealFailure();
      let ok = 0;
      for (let i = 0; i < shots.length; i++) {
        if (pm.signal.aborted) return;
        const it = await captureShot(ctx, shots[i], { quality: draft ? 'studio' : 'photoreal', silent: true, progress: sub, slot: { index: i, total: shots.length } });
        if (it) ok++;
        else if (!draft && ok === 0 && lastPhotorealFailure) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      if (lastPhotorealFailure) photorealFailed(ctx, lastPhotorealFailure.e, lastPhotorealFailure.shot);
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
      // 設計の 3DS で置き換えているときは、3DS 自身の床の上から測る（日照ステップと同じ）
      const sy = externalSampleY(v);
      for (let i = 0; i < dates.length; i++) {
        if (pm.signal.aborted) {
          sy?.dispose();
          return;
        }
        const d = dates[i];
        const rooms = await analyzeRooms(v, { year: d.year, month: d.month, day: d.day, lat, lon, northAngleDeg: state.model!.northAngleDeg }, { onProgress: (r) => pm.set(0.75 + ((i + r) / dates.length) * 0.12, `日当たりを解析中（${d.label}）`), sampleY: sy?.fn });
        seasons.push({ id: d.id as SeasonResult['id'], label: d.label, dateLabel: `${d.month}月${d.day}日`, rooms });
      }
      sy?.dispose();
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

function slide(cls: string, ...children: (Node | null | false | undefined)[]) {
  return h('div', { class: `slide ${cls}` }, ...(children.filter(Boolean) as Node[]));
}

function pick(kind: GalleryItem['kind']) {
  const list = state.gallery.filter((g) => g.kind === kind);
  // 写真品質を優先し、同じ構図の下書きは除く
  const photo = list.filter((g) => g.quality === 'photoreal');
  const drafts = list.filter((g) => g.quality !== 'photoreal' && !photo.some((p) => p.shotId && p.shotId === g.shotId));
  return [...photo, ...drafts];
}

/** 下書き画像には印を付け、提案時に気付けるようにする */
function draftMark(g: GalleryItem | undefined) {
  return g && g.quality !== 'photoreal' ? h('div', { class: 'draft' }, '下書き') : null;
}

const photo = (g: GalleryItem | undefined) => (g ? h('img', { class: 'photo', src: g.url, alt: g.title }) : null);
const cleanTitle = (t: string) => t.replace(/^(外観|内観|鳥瞰)[:：]?/, '').replace(/(内観|外観)?パース[（(]?/, '').replace(/[）)]$/, '').trim() || t;

/** 章の見出し（番号・英字・和文） */
function head(no: number, en: string, ja: string) {
  return h('div', null, h('div', { class: 'head' }, h('span', { class: 'no' }, String(no).padStart(2, '0')), h('div', null, h('div', { class: 'en latin' }, en), h('h2', { class: 'serif' }, ja))), h('div', { class: 'rule' }));
}

/** 外観・内観のテイストと間取りから、提案の言葉を組み立てる */
function conceptCopy(extName: string, intName: string, hasCourt: boolean, hasVoid: boolean, floors: number) {
  const lead = hasVoid ? '光が降りそそぐ吹抜けと、\n余白を楽しむ住まい。' : hasCourt ? '中庭の光と緑を、\n暮らしの中心に。' : floors >= 2 ? '端正なかたちに、\nやわらかな光を纏う家。' : '水平にひろがる、\n穏やかでのびやかな平屋。';
  const body = `外観は「${extName}」。素材の表情と深い陰影で、街並みに静かな品格を添えます。室内は「${intName}」を基調に、線を減らした納まりで、ホテルのように落ち着いた空間に仕上げました。`;
  return { lead, body };
}

export function buildDeck(): HTMLElement[] {
  const model = state.model!;
  const ext = exteriorById(state.design.exteriorId);
  const int = interiorById(state.design.interiorId);
  const spec = resolveSpec(state.design.specId, state.design.specPatch);
  const extAll = pick('exterior');
  const exts = extAll.filter((g) => !/夕景|夜景/.test(g.title)).concat(extAll.filter((g) => /夕景|夜景/.test(g.title)));
  const ints = pick('interior');
  const aerial = pick('aerial')[0];
  const hero = exts[0] ?? aerial ?? ints[0];
  const slides: HTMLElement[] = [];
  const brand = state.company || '';
  const today = new Date();
  const dateStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;
  const rooms = model.floors.flatMap((f) => f.rooms);
  const totalArea = model.floors.reduce((s, f) => s + f.rooms.filter((r) => !['balcony', 'porch', 'void'].includes(r.type)).reduce((a, r) => a + r.area, 0), 0);
  const ldk = rooms.find((r) => r.type === 'ldk' || r.type === 'living');
  const tatami = (r: { labeledTatami?: number; area: number }) => (r.labeledTatami ?? r.area / 1.62).toFixed(1);
  const hasVoid = rooms.some((r) => r.type === 'void');
  const hasCourt = rooms.some((r) => /中庭/.test(r.name));
  const copy = conceptCopy(ext.name, int.name, hasCourt, hasVoid, model.floors.length);
  const lines = (t: string) => t.split('\n').flatMap((x, i) => (i ? [h('br'), x] : [x]));

  // 章立て（素材のあるものだけ）
  const chapters: { en: string; ja: string }[] = [{ en: 'Concept', ja: 'コンセプト' }];
  if (exts.length || aerial) chapters.push({ en: 'Exterior', ja: '外観' });
  if (ints.length) chapters.push({ en: 'Interior', ja: '内観' });
  if (state.plans.length) chapters.push({ en: 'Floor Plan', ja: '間取り' });
  if (state.elevations.length) chapters.push({ en: 'Elevation', ja: '立面' });
  if (state.sun.seasons.length || state.sun.images.length) chapters.push({ en: 'Sunlight', ja: '光と日当たり' });
  chapters.push({ en: 'Details', ja: '上質を支える納まり' });
  const no = (en: string) => chapters.findIndex((c) => c.en === en) + 1;

  // 表紙
  slides.push(
    slide(
      'cover',
      photo(hero),
      h('div', { class: 'shade' }),
      h('div', { class: 'corner latin' }, 'Residential Design Proposal'),
      h('div', { class: 'corner-r latin' }, dateStr),
      h(
        'div',
        { class: 'txt' },
        h('div', { class: 'latin' }, `Proposal for ${state.customer.replace(/様$/, '')}`),
        h('h1', { class: 'serif' }, state.name),
        h('div', { class: 'meta' }, h('span', null, `${state.customer}　ご提案資料`), h('i'), h('span', null, brand || '')),
      ),
    ),
  );
  // 目次
  slides.push(
    slide(
      'index',
      h('div', { class: 'left' }, photo(ints[0] ?? exts[1] ?? hero)),
      h(
        'div',
        { class: 'right' },
        h('div', { class: 'latin', style: 'font-size:1.05cqw;color:var(--ink-3)' }, 'Contents'),
        h('h2', { class: 'serif', style: 'margin:0.6cqw 0 0;font-size:2.3cqw;letter-spacing:0.14em;font-weight:500' }, '目次'),
        h('ol', null, ...chapters.map((c, i) => h('li', null, h('span', { class: 'n' }, String(i + 1).padStart(2, '0')), h('span', { class: 'serif' }, c.ja), h('span', { class: 'e latin' }, c.en)))),
      ),
    ),
  );
  // コンセプト
  slides.push(
    slide(
      'split wide-photo',
      h('div', { class: 'ph' }, photo(exts[0] ?? hero), draftMark(exts[0] ?? hero)),
      h(
        'div',
        { class: 'tx' },
        head(no('Concept'), 'Concept', 'コンセプト'),
        h('div', { class: 'lead-copy serif' }, ...lines(copy.lead)),
        h('p', null, copy.body),
        h(
          'dl',
          { class: 'facts' },
          h('dt', null, '延床面積'),
          h('dd', null, `約 ${totalArea.toFixed(1)}㎡（約 ${(totalArea / 3.30579).toFixed(1)}坪）`),
          h('dt', null, '階数'),
          h('dd', null, `${model.floors.length}階建て`),
          ldk ? h('dt', null, ldk.name.normalize('NFKC')) : null,
          ldk ? h('dd', null, `${tatami(ldk)}帖`) : null,
          h('dt', null, '外観'),
          h('dd', null, ext.name),
          h('dt', null, '内観'),
          h('dd', null, int.name),
        ),
      ),
    ),
  );
  // 外観
  if (exts.length || aerial) {
    const n = no('Exterior');
    const first = exts[0] ?? aerial!;
    slides.push(
      slide(
        'full',
        photo(first),
        h('div', { class: 'capbox' }, h('div', { class: 'latin' }, `${String(n).padStart(2, '0')} — Exterior`), h('h3', { class: 'serif' }, cleanTitle(first.title)), h('p', null, first.caption || ext.description)),
        draftMark(first),
      ),
    );
    const rest = [...exts.slice(1), ...(aerial && first !== aerial ? [aerial] : [])];
    for (let i = 0; i < rest.length; i += 2) {
      const set = rest.slice(i, i + 2);
      if (set.length === 1) {
        slides.push(slide('full', photo(set[0]), h('div', { class: 'capbox' }, h('div', { class: 'latin' }, 'Exterior'), h('h3', { class: 'serif' }, cleanTitle(set[0].title)), set[0].caption ? h('p', null, set[0].caption) : null), draftMark(set[0])));
        continue;
      }
      slides.push(
        slide(
          'pair',
          head(n, 'Exterior', '外観'),
          h('div', { class: 'row', style: 'grid-template-columns:1fr 1fr' }, ...set.map((g) => h('div', { class: 'cell' }, photo(g), h('div', { class: 'lbl serif' }, cleanTitle(g.title)), draftMark(g)))),
        ),
      );
    }
  }
  // 内観
  if (ints.length) {
    const n = no('Interior');
    slides.push(
      slide(
        'split photo-right',
        h(
          'div',
          { class: 'tx' },
          head(n, 'Interior', '内観'),
          h('div', { class: 'lead-copy serif', style: 'font-size:1.55cqw' }, ...lines('線を減らし、\n素材と光で魅せる空間。')),
          h('p', null, int.description),
          h('p', { style: 'font-size:0.95cqw;color:var(--ink-3)' }, cleanTitle(ints[0].title)),
        ),
        h('div', { class: 'ph' }, photo(ints[0]), draftMark(ints[0])),
      ),
    );
    const rest = ints.slice(1);
    for (let i = 0; i < rest.length; i += 3) {
      const set = rest.slice(i, i + 3);
      if (set.length === 1) {
        slides.push(slide('full', photo(set[0]), h('div', { class: 'capbox' }, h('div', { class: 'latin' }, 'Interior'), h('h3', { class: 'serif' }, cleanTitle(set[0].title)), set[0].caption ? h('p', null, set[0].caption) : null), draftMark(set[0])));
        continue;
      }
      const cols = set.length === 3 ? '1.4fr 1fr 1fr' : '1fr 1fr';
      slides.push(
        slide(
          'pair',
          head(n, 'Interior', '内観'),
          h('div', { class: 'row', style: `grid-template-columns:${cols}` }, ...set.map((g) => h('div', { class: 'cell' }, photo(g), h('div', { class: 'lbl serif' }, cleanTitle(g.title)), draftMark(g)))),
        ),
      );
    }
  }
  // 間取り
  if (state.plans.length) {
    const sched = model.floors.flatMap((f) =>
      f.rooms.filter((r) => r.area > 2 && !['void', 'stairs'].includes(r.type)).map((r) => h('tr', null, h('td', { class: 'f' }, `${f.level}F`), h('td', null, r.name.normalize('NFKC')), h('td', { class: 'a' }, `${tatami(r)}帖`))),
    );
    slides.push(
      slide(
        'drawing',
        h(
          'div',
          { style: 'min-height:0;overflow:hidden' },
          head(no('Floor Plan'), 'Floor Plan', '間取り'),
          h('p', null, `家族の動線と、光の入り方を丁寧に読み解いた ${model.floors.length > 1 ? `${model.floors.length}層` : 'ワンフロア'}の構成です。`),
          h('table', { class: 'schedule' }, h('tbody', null, ...sched.slice(0, 16))),
        ),
        // 資料では敷地全体ではなく建物まわりを大きく見せる
        h('div', { class: 'sheet', style: `grid-template-columns:repeat(${Math.min(2, model.floors.length)},1fr)` }, ...model.floors.slice(0, 2).map((f) => h('div', { class: 'svgbox', html: floorPlanSvg(model, f, { showLandscape: false, showRoad: false }) }))),
      ),
    );
  }
  // 立面
  if (state.elevations.length) {
    slides.push(
      slide(
        'drawing',
        h('div', null, head(no('Elevation'), 'Elevation', '立面'), h('p', null, `${ext.name}の外壁と、深い軒の水平線で、四方どこから見ても整ったプロポーションに。`)),
        h('div', { class: 'sheet', style: 'grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr' }, ...state.elevations.slice(0, 4).map((e) => h('div', { class: 'svgbox', html: e.svg }))),
      ),
    );
  }
  // 光と日当たり
  if (state.sun.seasons.length || state.sun.images.length) {
    const winter = state.sun.seasons.find((x) => x.id === 'winter') ?? state.sun.seasons[0];
    slides.push(
      slide(
        'sun',
        h(
          'div',
          { style: 'min-height:0;overflow:hidden' },
          head(no('Sunlight'), 'Sunlight', '光と日当たり'),
          ...state.sun.highlights.slice(0, 3).map((hl) => h('div', { class: 'hl' }, h('b', { class: 'serif' }, hl.title), h('span', null, hl.body))),
        ),
        state.sun.images.length
          ? h('div', { class: 'sungrid' }, ...state.sun.images.slice(0, 4).map((im) => h('div', { class: 'cell' }, h('img', { class: 'photo', src: im.url }), h('div', { class: 'lbl' }, im.label))))
          : winter
            ? h('div', { class: 'svgfit', html: sunTimelineSvg(winter) })
            : null,
      ),
    );
    if (state.sun.diagramSvg) slides.push(slide('sun', h('div', null, head(no('Sunlight'), 'Shadow Study', '日影図（冬至）'), h('p', null, '冬至の日に、建物がまわりへ落とす影の範囲を時刻ごとに示しています。')), h('div', { class: 'svgfit', html: state.sun.diagramSvg })));
  }
  // 上質を支える納まり
  const items: { k: string; t: string; d: string }[] = [];
  if (spec.doors.fullHeight) items.push({ k: 'Full-height Door', t: 'フルハイトドア', d: '天井まで届く扉で、上枠や下がり壁のない、すっきりとした開口に。' });
  if (spec.windows.headAtCeiling) items.push({ k: 'Window Line', t: '天井にそろう窓', d: 'サッシの高さを天井にそろえ、窓まわりの線を消して光を深く導きます。' });
  if (spec.windows.interiorReveal === 'plaster') items.push({ k: 'Plaster Reveal', t: '塗り回しの窓まわり', d: '額縁を設けず、壁と同じ仕上げで包み込む静かな納まり。' });
  if (spec.curtains === 'pocket') items.push({ k: 'Curtain Pocket', t: 'カーテンボックス', d: 'レールを天井に納め、布のひだだけが美しく見えるように。' });
  if (spec.lighting === 'downlight') items.push({ k: 'Lighting', t: 'ダウンライト計画', d: '器具の存在を消し、必要な場所に光だけを置く照明計画。' });
  if (spec.indirectLighting) items.push({ k: 'Indirect Light', t: '間接照明', d: '天井際をやわらかく照らし、夜の空間に奥行きを生みます。' });
  if (spec.baseboard === 'recessed') items.push({ k: 'Baseboard', t: '入り巾木', d: '巾木を壁面より奥に納め、床と壁の境目を細い影の線だけに。' });
  if (items.length) {
    slides.push(
      slide(
        'details',
        h('div', { style: 'display:flex;flex-direction:column;justify-content:center' }, head(no('Details'), 'Details', '上質を支える納まり'), h('p', null, '仕上げの色だけでなく、見えない部分の納まりが空間の品格を決めます。線を一本ずつ減らし、素材と光が主役になる空間をつくります。')),
        h('div', { class: 'list' }, ...items.slice(0, 6).map((it) => h('div', { class: 'item' }, h('div', { class: 'k latin' }, it.k), h('h4', { class: 'serif' }, it.t), h('p', null, it.d)))),
      ),
    );
  }
  // 動画
  if (state.videos.length) {
    slides.push(slide('full', h('video', { src: state.videos[0].url, controls: true, muted: true, loop: true, poster: hero?.url }), h('div', { class: 'capbox' }, h('div', { class: 'latin' }, 'Movie'), h('h3', { class: 'serif' }, state.videos[0].title))));
  }
  // 締め
  const last = exts.find((g) => /夕景|夜景/.test(g.title)) ?? exts[1] ?? hero;
  slides.push(
    slide(
      'cover',
      photo(last),
      h('div', { class: 'shade' }),
      h('div', { class: 'txt' }, h('div', { class: 'latin' }, 'Thank you'), h('h1', { class: 'serif', style: 'font-size:3.2cqw' }, '理想の暮らしを、かたちに。'), h('div', { class: 'meta' }, h('span', null, brand || 'ご清聴ありがとうございました'))),
    ),
  );
  slides.forEach((s, i) => {
    const dark = s.classList.contains('cover') || s.classList.contains('full');
    if (!s.classList.contains('cover')) s.appendChild(h('div', { class: `pageno ${dark ? 'light' : ''}` }, `${String(i + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`));
    if (!s.classList.contains('cover') && brand && !s.classList.contains('full')) s.appendChild(h('div', { class: 'brandline' }, brand));
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
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${state.name}</title><link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700&family=Shippori+Mincho:wght@400;500;600&family=Cormorant+Garamond:wght@300;400;500&display=swap" rel="stylesheet"><style>${css}\nbody{overflow:auto;background:#1b1c1e;padding:24px 0}</style></head><body>${body}</body></html>`;
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
      h('button', { class: 'btn sm ghost', onclick: async () => { await autoGenerate(ctx, true); render(); } }, '⚡ 高品質描画ですばやく資料を完成（数十秒）'),
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
