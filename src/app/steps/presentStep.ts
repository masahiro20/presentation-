import * as THREE from 'three';
import { stylesFor, FINISH_CATEGORIES, selectedProduct } from '../../coordinate/catalog';
import { h, clear, toast, progressModal, section, download, setPrintPage } from '../dom';
import { woodCheck } from '../../parser/woodCheck';
import { parseWishes, checkWishes, type WishResult } from '../../core/wishes';
import { state, type GalleryItem } from '../state';
import type { Step, StepCtx } from '../app';
import { excludedFromFloorArea } from '../../core/types';
import { exteriorById, interiorById } from '../../styles/presets';
import { currentShots } from './designStep';
import { captureDraft, hasFinished } from '../draftCapture';
import { renderElevation, type ElevationDir } from '../../drawings/elevation';
import { buildSheets } from './elevationStep';
import { estimateSummary } from './estimateStep';
import { floorPlanSvg } from '../../drawings/plan';
import { analyzeRooms } from '../../sun/analysis';
import { externalController, externalSampleY, setExternalMounted } from '../externalBuilding';
import { sunHighlights, sunTimelineSvg, type SeasonResult } from '../../sun/report';
import { siteLatLon } from '../../sun/geo';
import { keyDates, sunPosition, sunDirectionWorld, localDate } from '../../sun/solar';
import { activeSunContext } from './sunStep';
import { NO_NEIGHBORS_DISCLOSURE, collectDisclosure, disclosureLines, excludedTableRows, plannedLine, type SunDisclosure } from '../sunDisclosure';

/** 日当たりを設計の 3D データ（3DS）で解析しているときに資料に添える注記 */
export const SUN_EXTERNAL_CAPTION = '日当たりは設計 3D データ（3DS）で解析';

/** 光と日当たりの注記（3DS で置き換えているときだけ）。資料の数字・写真がどの建物のものかを示す */
export function sunCaption(external: { replaces: boolean } | null | undefined): string | null {
  return external?.replaces ? SUN_EXTERNAL_CAPTION : null;
}

/**
 * 資料の日照のページに書く周辺建物の扱い: 結果を作った時点の写し（state.sun.disclosure）、無ければ今の扱い
 * （日照ステップを開いていなければ周辺建物なし）
 */
export function deckDisclosure(saved: SunDisclosure | undefined, now: SunDisclosure | null | undefined): SunDisclosure {
  return saved ?? now ?? NO_NEIGHBORS_DISCLOSURE;
}

/** 資料の表のページあたりの行数 */
export const EXCLUDED_ROWS_PER_SLIDE = 12;

/** 足りない素材をすべて自動で作る（一気通貫） */
export async function autoGenerate(ctx: StepCtx) {
  const app = ctx.app;
  app.ensureScene();
  const v = app.viewer;
  const pm = progressModal('プレゼン資料の素材を自動作成しています');
  const prevView = v.currentView();
  const prevDesign = { ...state.design };
  try {
    // パース: 外部で仕上げた写真がまだ無いカットだけ、3D の下絵を入れる（仕上げた写真を取り込むと入れ替わる）
    // パース背景の想像の家並みは資料には写さない（白い箱が主役を食うので、遠景の木立だけにする）
    v.setTownVisible(false);
    const all = currentShots(ctx);
    // 内観は暮らしの中心（LDK）→ 迎える場所（玄関・ホール・階段）→ 水まわり → 個室の順に。何もない個室の角は資料に向かない
    const roomRank = (t: string) => (/LDK|ＬＤＫ|リビング|ダイニング|キッチン/.test(t) ? 0 : /玄関|ホール|階段|吹抜/.test(t) ? 1 : /洗面|浴室|脱衣/.test(t) ? 2 : 3);
    const interiors = all.filter((s) => s.kind === 'interior').sort((a, b) => roomRank(a.title) - roomRank(b.title));
    const pick = [
      ...all.filter((s) => ['ext-front', 'ext-garden', 'ext-evening', 'aerial'].includes(s.id)),
      ...interiors.filter((s, i) => i < 2 || roomRank(s.title) < 3).slice(0, 4),
    ].filter((s) => !hasFinished(s.id) && !state.gallery.some((g) => g.shotId === s.id));
    for (let i = 0; i < pick.length; i++) {
      if (pm.signal.aborted) return;
      pm.set((i / pick.length) * 0.7, `下絵: ${pick[i].title}`);
      try {
        await captureDraft(ctx, pick[i]);
      } catch (e) {
        console.warn('下絵を描けませんでした', pick[i].title, e);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    if (prevDesign.timeOfDay !== state.design.timeOfDay) {
      state.design = prevDesign;
      v.setDesign(state.design);
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
    // A3 の図面シート（平面図・立面図＋外部仕上表・建具表）。資料の「図面」のページに載せる
    if (!state.sheets.length) {
      try {
        buildSheets(ctx.app);
      } catch (e) {
        console.error(e);
      }
    }
    state.plans = state.model!.floors.map((f) => ({ level: f.level, svg: floorPlanSvg(state.model!, f) }));
    // 日照
    // 設計の 3DS があるときは、解析と撮影の間だけ日照ステップと同じ表示にする（3DS を見せ、置き換えなら PDF の建物・屋根・家具を隠す）。
    // 解析（buildOccluder）は 3DS で影を計算するので、写真も同じ建物でないと数字と写真が別の建物になる
    const extCtrl = externalController();
    if (extCtrl) {
      setExternalMounted(v, true);
      // PDF の建物が作り直されていたら、ラッパー位置・影の範囲・隠す設定を今の状態に合わせる
      if (extCtrl.dirty) extCtrl.sync(v);
    }
    try {
      if (!state.sun.seasons.length) {
        const { lat, lon } = siteLatLon(state.site);
        const seasons: SeasonResult[] = [];
        const dates = keyDates(new Date().getFullYear()).filter((d) => d.id !== 'autumn');
        // 設計の 3DS で置き換えているときは、3DS 自身の床の上から測る（日照ステップと同じ）
        const sy = externalSampleY(v);
        try {
          for (let i = 0; i < dates.length; i++) {
            if (pm.signal.aborted) return;
            const d = dates[i];
            const rooms = await analyzeRooms(v, { year: d.year, month: d.month, day: d.day, lat, lon, northAngleDeg: state.model!.northAngleDeg }, { onProgress: (r) => pm.set(0.75 + ((i + r) / dates.length) * 0.12, `日当たりを解析中（${d.label}）`), sampleY: sy?.fn });
            seasons.push({ id: d.id as SeasonResult['id'], label: d.label, dateLabel: `${d.month}月${d.day}日`, rooms });
          }
        } finally {
          sy?.dispose();
        }
        const order = ['winter', 'spring', 'summer'];
        seasons.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        state.sun.seasons = seasons;
        state.sun.highlights = sunHighlights(seasons);
        // 解析した時点の周辺建物の扱い（計算から除外・表示だけ隠した建物）を資料の注記に使う
        state.sun.disclosure = collectDisclosure(activeSunContext());
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
    } finally {
      // 他のステップでは PDF の建物のまま（3DS の表示は日照ステップの間だけ）
      if (extCtrl) setExternalMounted(v, false);
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
  // 同じ構図は 1 枚に: 写真仕上げ（AI・外部ツールで仕上げて取り込んだもの）＞ 写真品質 ＞ 下書き
  const baseId = (g: GalleryItem) => g.shotId?.replace(/-ai$/, '');
  const rank = (g: GalleryItem) => (g.shotId?.endsWith('-ai') ? 2 : g.quality === 'photoreal' ? 1 : 0);
  const best = new Map<string, GalleryItem>();
  const loose: GalleryItem[] = [];
  for (const g of list) {
    const id = baseId(g);
    if (!id) {
      loose.push(g);
      continue;
    }
    const cur = best.get(id);
    if (!cur || rank(g) > rank(cur)) best.set(id, g);
  }
  const chosen = [...best.values(), ...loose];
  // 写真品質（仕上げ含む）を先に、下書きは後ろ
  return [...chosen.filter((g) => g.quality === 'photoreal'), ...chosen.filter((g) => g.quality !== 'photoreal')];
}

const photo = (g: GalleryItem | undefined) => (g ? h('img', { class: 'photo', src: g.url, alt: g.title }) : null);

/** 見出し（ホームランディックの提案書の書式: 小さな英字の見出し・和文・短い線。番号は付けない） */
function head(_no: number, en: string, ja: string) {
  return h('div', { class: 'hl-head' }, h('div', { class: 'en' }, en.toUpperCase()), h('h2', null, ja), h('div', { class: 'hl-rule' }));
}

/** 外観・内観のテイストと間取りから、提案の言葉を組み立てる */
function conceptCopy(extName: string, intName: string, hasCourt: boolean, hasVoid: boolean, floors: number) {
  const lead = hasVoid ? '光が降りそそぐ吹抜けと、\n余白を楽しむ住まい。' : hasCourt ? '中庭の光と緑を、\n暮らしの中心に。' : floors >= 2 ? '端正なかたちに、\nやわらかな光を纏う家。' : '水平にひろがる、\n穏やかでのびやかな平屋。';
  const body = `外観は「${extName}」。素材の表情と深い陰影で、街並みに静かな品格を添えます。室内は「${intName}」を基調に、線を減らした納まりで、ホテルのように落ち着いた空間に仕上げました。`;
  return { lead, body };
}

/** 資料の日照のページの注記（周辺建物の扱い: 影に入れた棟数・出典（PLATEAU・国土地理院）・除外・表示だけ隠した建物・想定の家） */
function sunNote(d: SunDisclosure, target: 'deck' | 'diagram') {
  return h('div', { class: 'sun-note', 'data-target': target }, ...disclosureLines(d, target).map((t) => h('div', null, t)));
}

/**
 * プレゼン資料のページ。opts.disclosure: 今の周辺建物の扱い（state.sun.disclosure が無いときに使う）
 */
export function buildDeck(opts: { disclosure?: SunDisclosure | null } = {}): HTMLElement[] {
  const model = state.model!;
  const { ext, int } = stylesFor(state.design);
  const extAll = pick('exterior');
  const exts = extAll.filter((g) => !/夕景|夜景/.test(g.title)).concat(extAll.filter((g) => /夕景|夜景/.test(g.title)));
  const ints = pick('interior');
  const aerial = pick('aerial')[0];
  // 輪切りの模型・断面パースは資料に載せない（作りかけに見える。間取りは平面図のページで伝える）
  const hero = exts[0] ?? aerial ?? ints[0];
  const slides: HTMLElement[] = [];
  const brand = state.company || '';
  const today = new Date();
  const dateStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;
  const rooms = model.floors.flatMap((f) => f.rooms);
  const totalArea = model.floors.reduce((s, f) => s + f.rooms.filter((r) => !excludedFromFloorArea(r.type)).reduce((a, r) => a + r.area, 0), 0);
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
  if (state.wishes?.trim()) chapters.push({ en: 'Wishes', ja: 'ご要望との照合' });
  if (state.elevations.length) chapters.push({ en: 'Drawings', ja: '図面' });
  if (state.deckFunding) chapters.push({ en: 'Budget', ja: '資金計画' });
  if (state.sun.seasons.length || state.sun.images.length) chapters.push({ en: 'Sunlight', ja: '光と日当たり' });
  const no = (en: string) => chapters.findIndex((c) => c.en === en) + 1;

  const office = state.company || 'ホームランディック一級建築士事務所';
  const kind = state.gallery.length ? 'PRESENTATION' : 'FIRST PLAN';
  // 表紙（白地・中央に小さく。社内の提案書と同じ書式）
  slides.push(
    slide(
      'hl hl-cover',
      h(
        'div',
        { class: 'c' },
        h('div', { class: 'office' }, office),
        h('div', { class: 'title' }, `[ ${state.customer.replace(/様$/, '')}様邸　${kind} ]`),
        state.logo ? h('img', { class: 'logo', src: state.logo, alt: '' }) : h('div', { class: 'mark' }, h('div', null, 'HOME LANDICK'), h('div', null, 'Architectural design office')),
        h('div', { class: 'date' }, dateStr),
      ),
    ),
  );
  // 理念・アプローチ
  slides.push(
    slide('hl hl-text', head(0, 'Philosophy', '理念'), h('div', { class: 'body' }, h('p', null, '私たちは『ご家族の暮らしをデザインする』を信条に、'), h('p', null, '本当に住みたい家　性能とデザインを両立した住まいを提供します。'))),
  );
  slides.push(
    slide(
      'hl hl-text',
      head(0, 'Our Approach', '私たちのアプローチ'),
      h('div', { class: 'body' }, h('p', null, '1.　性能の高い住まい（断熱・気密・耐震）'), h('p', null, '2.　意匠デザインで「器」ではなく「体験」を設計'), h('p', null, 'ご家族と共に、唯一無二の空間を共創します。')),
    ),
  );
  // 建築概要（読み取った間取りから）
  const f1 = model.floors[0];
  const buildArea = f1 ? f1.rooms.filter((r) => !['balcony', 'void'].includes(r.type)).reduce((a, r) => a + r.area, 0) : 0;
  const ov: [string, string][] = [
    ['敷地所在地', state.site.address && !/（仮）/.test(state.site.address) ? state.site.address : '—'],
    ['建築面積', `${buildArea.toFixed(2)} ㎡`],
    ['延床面積', `${totalArea.toFixed(2)} ㎡（約 ${(totalArea / 3.30579).toFixed(1)} 坪）`],
    ['構造', 'ＳＥ構法'],
    ['規模', `${model.floors.length}階建て`],
    ['主要用途', '住宅'],
  ];
  if (ldk) ov.push([ldk.name.normalize('NFKC'), `${tatami(ldk)} 帖`]);
  ov.push(['外観', ext.name], ['内観', int.name]);
  slides.push(
    slide(
      'hl hl-overview',
      h('div', null, head(0, 'Project Overview', '建築概要'), h('dl', { class: 'ov' }, ...ov.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, `［　${v}　］`)]))),
      h('div', { class: 'ph' }, photo(exts[0] ?? hero)),
    ),
  );
  // 仕上げ・設備（コーディネート: メーカー・品番）
  slides.push(
    slide(
      'hl hl-finish',
      h(
        'div',
        null,
        head(0, 'Finish & Equipment', '仕上げ・設備'),
        h(
          'div',
          { class: 'finish-grid' },
          ...FINISH_CATEGORIES.map((cat) => {
            const p = selectedProduct(cat, state.design);
            const memo = state.design.finishNotes?.[cat.id];
            // コーディネートの段取り: 決定済みは「決定」、候補を絞った部位は「ご検討中（候補 n 案）」
            const it = state.coord.items[cat.id];
            const st = it?.status === 'decided' ? '決定' : (it?.candidates?.length ?? 0) >= 2 ? `ご検討中（候補 ${it!.candidates!.length} 案）` : '';
            return h('div', { class: 'finish-row' }, h('div', { class: 'sw' }, ...p.swatch.map((c) => h('span', { style: `background:${c}` }))), h('div', { class: 'k' }, cat.label), h('div', { class: 'v' }, h('div', { class: 'nm' }, `${p.maker}　${p.name}`), h('div', { class: 'cd' }, [memo ?? p.code.replace(/\s*※品番は品番メモに/, ''), p.color].filter(Boolean).join('　'), st ? h('span', { class: `st ${it?.status === 'decided' ? 'ok' : ''}` }, st) : null)));
          }),
        ),
      ),
    ),
  );
  void copy;
  void lines;
  void chapters;
  // パース: 1 枚ずつ全面に、画だけで見せる（「道路側」「下絵」などの社内向けの文字は載せない）
  const full = (g: GalleryItem) => slide('hl full', photo(g));
  for (const g of [...exts, ...(aerial ? [aerial] : [])]) slides.push(full(g));
  for (const g of ints) slides.push(full(g));
  // 間取り: 1 階ずつ 1 枚に、図面を大きく。左に階の部屋と広さ
  if (state.plans.length) {
    const n = no('Floor Plan');
    model.floors.forEach((f, fi) => {
      const list = f.rooms.filter((r) => r.area > 2 && !['void', 'stairs'].includes(r.type)).sort((a, b) => b.area - a.area);
      const area = f.rooms.filter((r) => !excludedFromFloorArea(r.type)).reduce((a, r) => a + r.area, 0);
      slides.push(
        slide(
          'drawing plan-one',
          h(
            'div',
            { style: 'min-height:0;overflow:hidden' },
            head(n, 'Floor Plan', `${f.level}階 間取り`),
            fi === 0 ? h('p', null, `家族の動線と、光の入り方を丁寧に読み解いた ${model.floors.length > 1 ? `${model.floors.length}層` : 'ワンフロア'}の構成です。`) : null,
            h('div', { class: 'floor-area serif' }, `${f.level}F　約 ${area.toFixed(1)}㎡`),
            h('table', { class: 'schedule' }, h('tbody', null, ...list.slice(0, 12).map((r) => h('tr', null, h('td', null, r.name.normalize('NFKC')), h('td', { class: 'a' }, `${tatami(r)}帖`))))),
            f.notes?.length ? h('div', { class: 'plan-notes' }, h('div', { class: 'label' }, '設計士のメモ'), ...f.notes.slice(0, 6).map((n) => h('p', null, n.text))) : null,
          ),
          h('div', { class: 'sheet one' }, h('div', { class: 'svgbox', html: floorPlanSvg(model, f, { showLandscape: false, showRoad: false }) })),
        ),
      );
    });
  }
  // ご要望との照合: 言ったことが図面に入っているかを一目で（叶っている → 要確認 → 打合せ の順）
  if (state.wishes?.trim()) {
    const ws = parseWishes(state.wishes);
    const narrow = woodCheck(model).filter((i) => i.id.startsWith('narrow-')).map((i) => i.title);
    const rs = checkWishes(model, ws, { narrowIssues: narrow });
    const order: Record<WishResult['status'], number> = { ok: 0, check: 1, ng: 2, na: 3 };
    rs.sort((a, b) => order[a.status] - order[b.status]);
    const judged = rs.filter((r) => r.status !== 'na');
    // 入っていない・要確認は打合せの肝なので必ず載せ、残りを「叶っています」で埋める（表示は叶っている → 要確認 → 入っていない）
    const must = judged.filter((r) => r.status !== 'ok').slice(0, 5);
    const shown = [...must, ...judged.filter((r) => r.status === 'ok')].slice(0, 8).sort((a, b) => order[a.status] - order[b.status]);
    const rest = judged.length - shown.length;
    const notes = rs.filter((r) => r.status === 'na').slice(0, 5);
    if (shown.length || notes.length) {
      const mark = (st: WishResult['status']) => (st === 'ok' ? '✓' : st === 'check' ? '△' : st === 'ng' ? '－' : '…');
      slides.push(
        slide(
          'hl hl-overview hl-wishes',
          h(
            'div',
            null,
            head(no('Wishes'), 'Your Requests', 'ご要望との照合'),
            h('p', null, 'お聞きしたご要望が、この間取りにどう入っているかをまとめました。△・－ の項目は次回の打合せでご相談します。'),
            h('table', { class: 'wish-table' }, h('tbody', null, ...shown.map((r) => h('tr', { class: `w-${r.status}` }, h('td', { class: 'm' }, mark(r.status)), h('td', null, h('b', null, r.wish.label), h('span', { class: 'ev' }, r.evidence)))))),
            rest > 0 || notes.length ? h('p', { class: 'wish-notes' }, [rest > 0 ? `ほか ${rest} 件` : '', notes.length ? `打合せで確認: ${notes.map((r) => r.wish.label).join('／')}` : ''].filter(Boolean).join('　')) : null,
          ),
          h('div', { class: 'ph' }, photo(ints[0] ?? exts[0] ?? hero)),
        ),
      );
    }
  }
  // 立面図: 間取りのページと同じく、図面枠・表題欄の付いたシートではなく 4 面の絵だけを抜き出して大きく
  if (state.elevations.length) {
    const n = no('Drawings');
    const order = ['south', 'east', 'north', 'west'];
    const els = [...state.elevations].sort((a, b) => order.indexOf(a.dir) - order.indexOf(b.dir));
    slides.push(slide('drawing elev-grid', h('div', { style: 'min-height:0;overflow:hidden' }, head(n, 'Elevation', '立面図'), h('p', null, '東西南北の 4 面です。屋根のかたち・窓の並び・高さの関係をご覧ください。')), h('div', { class: 'elev4' }, ...els.map((e) => h('div', { class: 'svgbox', html: e.svg })))));
  }
  // 光と日当たり
  if (state.sun.seasons.length || state.sun.images.length) {
    const winter = state.sun.seasons.find((x) => x.id === 'winter') ?? state.sun.seasons[0];
    // 周辺建物の扱い（計算から除外した建物の理由ごとの棟数・表示だけ隠した建物の棟数）を日照のページすべてに添える
    const disc = deckDisclosure(state.sun.disclosure, opts.disclosure);
    slides.push(
      slide(
        'sun',
        h(
          'div',
          { style: 'min-height:0;overflow:hidden' },
          head(no('Sunlight'), 'Sunlight', '光と日当たり'),
          ...state.sun.highlights.slice(0, 3).map((hl) => h('div', { class: 'hl' }, h('b', { class: 'serif' }, hl.title), h('span', null, hl.body))),
          sunCaption(state.external) ? h('p', { style: 'font-size:1.05cqw;color:var(--ink-3);margin-top:1.2cqw' }, sunCaption(state.external)) : null,
          sunNote(disc, 'deck'),
        ),
        state.sun.images.length
          ? h('div', { class: 'sungrid' }, ...state.sun.images.slice(0, 4).map((im) => h('div', { class: 'cell' }, h('img', { class: 'photo', src: im.url }), h('div', { class: 'lbl' }, im.label))))
          : winter
            ? h('div', { class: 'svgfit', html: sunTimelineSvg(winter) })
            : null,
      ),
    );
    if (state.sun.diagramSvg) slides.push(slide('sun', h('div', null, head(no('Sunlight'), 'Shadow Study', '日影図（冬至）'), h('p', null, '冬至の日に、建物がまわりへ落とす影の範囲を時刻ごとに示しています。'), sunNote(disc, 'diagram')), h('div', { class: 'svgfit', html: state.sun.diagramSvg })));
    // 計算から除外した周辺建物の表（出典・高さ・理由・方向と距離）
    const rows = excludedTableRows(disc);
    for (let i = 0; i < rows.length; i += EXCLUDED_ROWS_PER_SLIDE) {
      const part = rows.slice(i, i + EXCLUDED_ROWS_PER_SLIDE);
      slides.push(
        slide(
          'sun sun-excluded',
          h(
            'div',
            { style: 'min-height:0;overflow:hidden' },
            head(no('Sunlight'), 'Excluded Buildings', '計算から除外した周辺建物'),
            h('p', null, '日当たりの解析から外した周辺建物の一覧です。出典・高さ・外した理由と、計画建物から見た方向・距離を示します。'),
            sunNote(disc, 'deck'),
          ),
          h(
            'div',
            { class: 'tblbox' },
            h(
              'table',
              { class: 'excluded' },
              h('thead', null, h('tr', null, ...['No.', '出典', '高さ', '理由', '方向・距離'].map((t) => h('th', null, t)))),
              h('tbody', null, ...part.map((r) => h('tr', null, h('td', { class: 'n' }, String(r.no)), h('td', null, r.source), h('td', { class: 'a' }, r.height), h('td', null, r.reason), h('td', null, r.where)))),
            ),
            i + EXCLUDED_ROWS_PER_SLIDE < rows.length ? h('p', { class: 'cont' }, `（${rows.length} 棟のうち ${i + 1}〜${i + part.length}。次のページへ続く）`) : null,
          ),
        ),
      );
    }
  }
  // 「上質を支える納まり」のページは載せない（お客様には仕上げ・パースで伝わる）
  // 動画
  if (state.videos.length) {
    slides.push(slide('full', h('video', { src: state.videos[0].url, controls: true, muted: true, loop: true, poster: hero?.url }), h('div', { class: 'capbox' }, h('div', { class: 'latin' }, 'Movie'), h('h3', { class: 'serif' }, state.videos[0].title))));
  }
  // 締め（社内の提案書と同じ: 言葉・事務所・担当・連絡先）
  const contact: [string, string | undefined][] = [
    ['設計担当', state.designer],
    ['TEL', state.tel],
    ['Email', state.email],
    ['URL', state.url],
  ];
  // 資金計画（概算）: 本体工事〜総合計。数字は見積の画面の資金計画書と同じ
  if (state.deckFunding) {
    const sm = estimateSummary();
    if (sm) {
      const yenJ = (v: number) => `¥${Math.round(v).toLocaleString('ja-JP')}`;
      const rows: [string, string][] = [
        ['① 本体工事（税抜）', yenJ(sm.body)],
        ['② 付帯工事（税抜）', yenJ(sm.sub2)],
        ['消費税', yenJ(sm.tax)],
        ['建物工事 合計（税込）', yenJ(sm.contract)],
        ['④ 土地関連費用', yenJ(sm.sub4)],
        ['⑤ 諸費用', yenJ(sm.sub5)],
        ['⑥ ローン諸費用', yenJ(sm.sub6)],
        ['総合計', yenJ(sm.grand)],
      ];
      slides.push(
        slide(
          'hl hl-overview hl-budget',
          h(
            'div',
            null,
            head(no('Budget'), 'Budget Plan', '資金計画（概算）'),
            h('dl', { class: 'ov' }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', { class: /合計/.test(k) ? 'total' : '' }, v)])),
            h('p', { class: 'budget-note' }, `${sm.grade} シリーズ・施工面積 ${sm.tsubo.toFixed(1)} 坪（${sm.constArea.toFixed(2)} ㎡）・坪単価 ${yenJ(sm.tsuboPrice)}（建物工事 税込）。概算です。詳細は御見積書・資金計画書をご覧ください。`),
          ),
          h('div', { class: 'ph' }, photo(exts[1] ?? exts[0] ?? hero)),
        ),
      );
    }
  }
  slides.push(
    slide(
      'hl hl-cover hl-close',
      h(
        'div',
        { class: 'c' },
        h('div', { class: 'mark' }, h('div', null, 'HOME LANDICK'), h('div', null, 'Architectural design office')),
        h('div', { class: 'motto' }, '「美しく、安心で快適な暮らしを」'),
        h('div', { class: 'office' }, office),
        h('div', { class: 'contact' }, ...contact.filter(([, v]) => v).map(([k, v]) => h('div', null, h('span', null, k), `：［　${v}　］`))),
      ),
    ),
  );
  slides.forEach((s, i) => {
    const dark = s.classList.contains('cover') || s.classList.contains('full');
    if (!s.classList.contains('cover') && !s.classList.contains('hl-cover')) s.appendChild(h('div', { class: `pageno ${dark ? 'light' : ''}` }, `${String(i + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`));
    if (!s.classList.contains('cover') && !s.classList.contains('hl-cover') && brand && !s.classList.contains('full')) s.appendChild(h('div', { class: 'brandline' }, brand));
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
  short: '資料',
  needsModel: true,
  uses3d: false,
  unmount() {
    setPrintPage(null);
  },
  mount(ctx) {
    setPrintPage('A4 landscape');
    const deck = h('div', { class: 'deck view' });
    ctx.stage.appendChild(deck);
    // 解析結果に写しが無いときは、今の周辺建物の扱いで注記する
    const deckOpts = () => ({ disclosure: collectDisclosure(activeSunContext()) });
    // 収録内容（自動作成の後にも数が更新されるよう、資料と一緒に描き直す）
    const contentsBox = section('収録内容');
    const paintContents = () => {
      while (contentsBox.childElementCount > 1) contentsBox.lastElementChild!.remove();
      contentsBox.append(
        h(
          'ul',
          { style: 'font-size:13px;line-height:1.9;color:#5b6068;padding-left:18px;margin:0' },
          h('li', null, `パース ${state.gallery.length} 枚（仕上げ済み ${state.gallery.filter((g) => g.quality === 'photoreal').length} 枚）`),
          h('li', null, `立面図 ${state.elevations.length} 面・平面図 ${state.plans.length} 枚`),
          h('li', null, `日照解析 ${state.sun.seasons.length ? '済' : '未'}／日影図 ${state.sun.diagramSvg ? '済' : '未'}${sunCaption(state.external) ? '（設計 3D データで解析）' : ''}`),
          (() => {
            const d = deckDisclosure(state.sun.disclosure, collectDisclosure(activeSunContext()));
            return d.excluded.length || d.viewOnly.length ? h('li', null, `周辺建物: 計算から除外 ${d.excluded.length} 棟・表示だけ隠す ${d.viewOnly.length} 棟（資料の日照のページに注記）`) : null;
          })(),
          (() => {
            // 周辺建物の出典（PLATEAU・国土地理院の棟数。資料の日照のページに同じ行を注記）
            const src = deckDisclosure(state.sun.disclosure, collectDisclosure(activeSunContext())).sources?.[0];
            return src ? h('li', null, `${src}（資料の日照のページに注記）`) : null;
          })(),
          (() => {
            // 想定の家（未建築の仮の建物）を置いたときは、その棟数と扱いも（資料の日照のページに同じ行を注記）
            const pl = plannedLine(deckDisclosure(state.sun.disclosure, collectDisclosure(activeSunContext())));
            return pl ? h('li', null, `${pl}（資料の日照のページに注記）`) : null;
          })(),
          h('li', null, `動画 ${state.videos.length} 本`),
        ),
        h('p', { class: 'hint' }, '外部で仕上げて取り込んだ写真がある場合は優先して使われます。印刷は A4 横に最適化されています。')
      );
    };
    const render = () => {
      clear(deck);
      paintContents();
      const slides = buildDeck(deckOpts());
      deck.append(
        h(
          'div',
          { class: 'deck-tools' },
          h('button', { class: 'btn primary', onclick: () => present(buildDeck(deckOpts())) }, '▶ プレゼンを開始（全画面）'),
          h('button', { class: 'btn', onclick: () => window.print() }, 'PDF で保存（印刷）'),
          h('button', { class: 'btn', onclick: () => exportHtml(buildDeck(deckOpts())) }, 'HTML で保存（お客様へ送付用）'),
        ),
        ...slides,
      );
    };
    render();
    // 読み込み直後の「提案一式をまとめて作る」から来たときは、そのまま自動作成を始める
    if (state.autoRun) {
      const mode = state.autoRun;
      state.autoRun = undefined;
      setTimeout(async () => {
        void mode;
        await autoGenerate(ctx);
        render();
      }, 50);
    }
    ctx.side.append(
      h('h2', null, 'プレゼン資料'),
      h('button', { class: 'btn primary block', onclick: async () => { await autoGenerate(ctx); render(); } }, '足りない素材を自動作成して資料を完成'),
      h('p', { class: 'hint' }, 'パースは、外部（Nano Banana Pro）で仕上げて取り込んだ写真を使います。まだ仕上げていないカットには 3D の下絵（「下絵」の印付き）が入り、あとで取り込むと入れ替わります（パース →「仕上げ（外部）」）。'),
      h('label', { class: 'check', style: 'display:flex;gap:8px;align-items:center;margin:10px 0 4px;font-size:12.5px' }, h('input', { type: 'checkbox', checked: !!state.deckFunding, onchange: (e: Event) => { state.deckFunding = (e.target as HTMLInputElement).checked; render(); } }), '資金計画（概算）のページを入れる'),
      section(
        '表紙の情報',
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'プロジェクト名'), h('input', { type: 'text', value: state.name, onchange: (e: Event) => { state.name = (e.target as HTMLInputElement).value; render(); } })),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'お客様名'), h('input', { type: 'text', value: state.customer, onchange: (e: Event) => { state.customer = (e.target as HTMLInputElement).value; render(); } })),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '事務所名'), h('input', { type: 'text', value: state.company, placeholder: 'ホームランディック一級建築士事務所', onchange: (e: Event) => { state.company = (e.target as HTMLInputElement).value; render(); } })),
        ...(
          [
            ['designer', '設計担当'],
            ['tel', 'TEL'],
            ['email', 'Email'],
            ['url', 'URL'],
          ] as const
        ).map(([k, label]) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('input', { type: 'text', value: state[k] ?? '', onchange: (e: Event) => { state[k] = (e.target as HTMLInputElement).value; render(); } }))),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '敷地所在地（建築概要に記載）'), h('input', { type: 'text', value: state.site.address, onchange: (e: Event) => { state.site = { ...state.site, address: (e.target as HTMLInputElement).value }; render(); } })),
      ),
      contentsBox,
    );
  },
};
