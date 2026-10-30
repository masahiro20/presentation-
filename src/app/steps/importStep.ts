import { h, clear, toast, progressModal, section, field, segmented, fold, download, modal } from '../dom';
import { state, emit } from '../state';
import { rememberOffice, forgetOfficeLogo } from '../office';
import type { Step, StepCtx } from '../app';
import { parsePdfInBrowser, extractPdfText } from '../../parser/browser';
import { parseDxf, type ModuleMode } from '../../parser';
import { decodeDxf } from '../../parser/dxf';
import { floorPlanSvg } from '../../drawings/plan';
import { openPlanEditor } from '../planEditor';
import { excludedFromFloorArea, type BuildingModel, type PlanSide } from '../../core/types';
import { openProjectFile, isProjectFile, saveProjectFile } from '../project';
import { woodCheck, type WoodIssue } from '../../parser/woodCheck';
import { parseWishes, checkWishes, WISH_STATUS_LABEL, type WishResult } from '../../core/wishes';
import { planSummary, diffPlans, type PlanSummary } from '../../core/planDiff';
import { estimateSummary } from './estimateStep';
import { receiveCustomerInbox, inboxSummary } from '../customerInbox';
import { openSiteStudy, siteStudyCheck, rowsEl } from '../siteStudyDialog';
import { loadSymbolDict, saveSymbolDict, learnSymbol, signatureOf, countDict, exportDict, importDict, type SymbolSignature } from '../../parser/symbolDict';
import { SYMBOL_DICT_SEED } from '../../parser/symbolDictSeed';
import { ACCEPT_EXT } from '../../sunstudy/importModel';
import { createExternal, installExternal, loadExternal, setExternalMounted } from '../externalBuilding';
import { applyHeightsFromExternal } from '../externalHeights';

/** 図面の種類（読み取りのパターン）: 迷ったら「自動」。種類を選ぶと縮尺・モジュール・画像解析・傾き補正の初期値が決まる */
export type DrawingKind = 'auto' | 'scan' | 'detail' | 'architrend' | 'meter';
export const DRAWING_KINDS: { id: DrawingKind; label: string; hint: string; preset: { scale?: number; module?: ModuleMode; rasterImages?: boolean; straighten?: boolean } }[] = [
  { id: 'auto', label: '自動（CAD の PDF）', hint: '縮尺・モジュールを図面から判定します', preset: {} },
  { id: 'scan', label: '色付き・手描き・スキャンの図面', hint: '画像として壁・部屋を読み、傾きを水平に戻します。精度は下がるので修正画面で直してください', preset: { rasterImages: true, straighten: true } },
  { id: 'detail', label: '1/50〜1/60 の詳細図', hint: '縮尺 1/50 で読みます（違えば縮尺の欄で直す）。寸法線・設備の記号が多い図面', preset: { scale: 50, module: 'shaku' } },
  { id: 'architrend', label: 'ARCHITREND ZERO の図面', hint: '尺モジュール（910）の格子にそろえます。3DS を一緒に置くと高さも合います', preset: { module: 'shaku' } },
  { id: 'meter', label: '他社・メーターモジュールの図面', hint: 'メーターモジュール（1000）の格子にそろえます', preset: { module: 'meter' } },
];

async function loadPdf(ctx: StepCtx, data: Uint8Array, name: string, scaleDenominator?: number, kind: 'pdf' | 'dxf' = 'pdf', moduleMode: ModuleMode = 'auto', drawing: DrawingKind = 'auto') {
  const pm = progressModal('平面図を解析しています', false);
  try {
    // 修正画面で教えた家具記号（部屋種別×大きさ→種類）を読み取りに使う
    (globalThis as { __symbolDict?: SymbolSignature[] }).__symbolDict = loadSymbolDict();
    const model =
      kind === 'dxf'
        ? parseDxf(decodeDxf(data), { name, module: moduleMode })
        : await parsePdfInBrowser(data.slice(), {
            name,
            scaleDenominator,
            module: moduleMode,
            rasterImages: DRAWING_KINDS.find((k) => k.id === drawing)?.preset.rasterImages,
            straighten: DRAWING_KINDS.find((k) => k.id === drawing)?.preset.straighten,
            onProgress: (msg, r) => pm.set(r, msg),
          });
    const rooms = model.floors.reduce((s, f) => s + f.rooms.length, 0);
    if (!model.floors.length || rooms === 0) {
      toast('平面図を認識できませんでした。CAD から出力したベクター形式の PDF をお試しください', 'error', 6000);
      return;
    }
    // 別の図面を読むとき（「別の PDF を読み込む」のあと、または開いているプロジェクトに違う名前の PDF）: 前のプランの要約を残して「前回からの変更」を出す。
    // 同じ図面の再解析（縮尺・モジュールの指定）は差分を作らない
    const prevSummary = pendingRevision ?? (state.model && state.pdfName && state.pdfName !== name ? summarizeCurrent() : null);
    pendingRevision = null;
    if (prevSummary) {
      (state.revisions ??= []).push(prevSummary);
      if (state.revisions.length > 10) state.revisions.splice(0, state.revisions.length - 10);
    }
    state.model = model;
    // 立面図の屋根勾配が読めたら、外観の屋根に使う（形は外観テイストのまま）
    if (model.heights?.roofPitch != null) state.design = { ...state.design, roofPitch: model.heights.roofPitch };
    state.pdfName = name;
    lastPdf = { data, name, kind, moduleMode, drawing };
    emit('model');
    toast(`${model.floors.length}階分・${rooms}室を認識しました`, 'ok');
    ctx.app.go('import');
  } catch (e) {
    console.error(e);
    toast(`PDF の読み込みに失敗しました: ${(e as Error).message}`, 'error', 6000);
  } finally {
    pm.close();
  }
}

let lastPdf: { data: Uint8Array; name: string; kind: 'pdf' | 'dxf'; moduleMode?: ModuleMode; drawing?: DrawingKind } | null = null;

/** 「別の PDF を読み込む」で消す前のプランの要約（次に読んだ図面との差分に使う） */
let pendingRevision: PlanSummary | null = null;
function summarizeCurrent(): PlanSummary | null {
  if (!state.model) return null;
  let grand: number | undefined;
  try {
    grand = estimateSummary()?.grand;
  } catch {
    grand = undefined;
  }
  return planSummary(state.model, state.pdfName ?? '前回', grand);
}

/** 設計の 3D データ（ARCHITREND の 3DS など） */
const is3dFile = (f: File) => ACCEPT_EXT.includes((f.name.split('.').pop() ?? '').toLowerCase());

/**
 * 図面と一緒に置いた 3D データで、床・窓の腰高と高さ・屋根を最初から 3D のとおりにする。
 * 間取りの外形に自動で合わせてから測る（合わなければ何も変えず、日照の画面で手で合わせる案内を出す）
 */
async function heightsFrom3dFile(ctx: StepCtx, f: File): Promise<boolean> {
  if (!state.model) return false;
  const pm = progressModal('3D データから高さを測っています', false);
  try {
    pm.set(0.15, f.name);
    const m = await loadExternal(f);
    pm.set(0.6, '間取りの外形に合わせています…');
    await new Promise((r) => setTimeout(r, 0));
    ctx.app.ensureScene();
    const v = ctx.app.viewer;
    const ctrl = installExternal(v, createExternal(m));
    if (!ctrl) return false;
    const r: unknown = ctrl.autoFitToPlan(v);
    setExternalMounted(v, false);
    if (r === false || ctrl.ext.fit?.unitSuspect) {
      const why = ctrl.fitError ?? (ctrl.ext.fit?.unitSuspect ? '大きさが合わず、単位の違いの疑いがあります' : '');
      toast(`${f.name} を間取りの外形に自動で合わせられませんでした${why ? `（${why}）` : ''}。日照の画面で位置を合わせてから「3D データの高さを間取りに反映」を押してください`, 'info', 10000);
      return false;
    }
    ctrl.ext.manual = false;
    pm.set(0.85, '床・窓・屋根の高さを測っています…');
    const ch = applyHeightsFromExternal(v, ctrl);
    ctx.app.ensureScene();
    ctrl.sync(v);
    setExternalMounted(v, false);
    if (ch) toast([`${f.name} から高さを反映しました`, ...ch.notes].join('\n'), 'ok', 9000);
    return !!ch;
  } catch (e) {
    toast(`3D データを読めませんでした: ${(e as Error).message}`, 'error', 8000);
    return false;
  } finally {
    pm.close();
  }
}

/** モジュールの表示名 */
export function moduleLabel(model: BuildingModel): string {
  const m = model.module;
  if (!m) return '図面の寸法のまま（モジュール格子に乗っていない）';
  return `${m.size === 910 ? '尺モジュール 910（半間 455 格子）' : 'メーターモジュール 1000（500 格子）'}・壁芯の ${Math.round(m.fit * 100)}% が格子に整合${m.source === 'manual' ? '・手動指定' : ''}`;
}

/** 表紙の背景（御社の施工事例・ラインナップの写真。ゆっくり寄りながら切り替わる） */
const BG_PHOTOS = ['./brand/lineup-02.jpg', './brand/works-tower.jpg', './brand/int-ldk.jpg', './brand/works-garage.jpg', './brand/lineup-01.jpg', './brand/int-lounge.jpg', './brand/lineup-03.jpg', './brand/works-white.jpg'];
/** 御社サイトの背景動画（読めれば写真の上に重ねる。読めないときは写真の切り替えのまま） */
const BG_VIDEO = 'https://www.homelandick.com/wp-content/themes/Template/data/video/pc/bg-vid.mp4';

/** Works: 御社の家（homelandick.com の施工事例） */
const WORKS: { src: string; title: string; wide?: boolean }[] = [
  { src: './brand/works-garage.jpg', title: 'ガレージのある平屋', wide: true },
  { src: './brand/int-ldk.jpg', title: '吹抜けの LDK・鉄骨階段' },
  { src: './brand/int-washitsu.jpg', title: '畳の間・格子' },
  { src: './brand/works-black.jpg', title: 'ガルバリウムの箱' },
  { src: './brand/works-white.jpg', title: '塗り壁と植栽' },
  { src: './brand/int-lounge.jpg', title: '中庭に開くラウンジ', wide: true },
];

/** Proposal: このツールが図面から作るもの（サンプル邸から自動で出したもの。クリックでサンプルを読み込む） */
const PROPOSAL: { src: string; title: string; wide?: boolean; plan?: boolean }[] = [
  { src: './showcase/int-ldk.jpg', title: '内観パース — テイストを選ぶだけで家具・照明まで', wide: true },
  { src: './showcase/ext-front.jpg', title: '外観パース' },
  { src: './showcase/aerial.jpg', title: '俯瞰の模型・日照' },
  { src: './showcase/sheet-elev.jpg', title: '立面図 4 面＋外部仕上表', plan: true },
  { src: './showcase/int-bed.jpg', title: '個室のパース' },
];

const FLOW: [string, string][] = [
  ['図面を読む', '平面図の PDF・DXF を置くだけ。壁・建具・室名・階段・方位を読み、木造として立ち上げます。'],
  ['パース・ルームツアー', '外観・内観を御社のテイストで組み、Nano Banana Pro で写真に、動画 AI でルームツアーに仕上げて取り込みます。'],
  ['図面', '平面図・立面図・断面図を御社の書き方で A3 に。'],
  ['日照', '建設地の航空写真と周辺建物で、季節・時刻ごとの日当たりと日影図。'],
  ['見積・資金計画', '間取りから積算し、見積書と資金計画書まで。'],
  ['お客様に渡す', '提案資料と、スマホで歩ける体験リンク。'],
];

function dropScreen(ctx: StepCtx) {
  const input = h('input', { type: 'file', multiple: true, accept: ['application/pdf', '.pdf', '.dxf', '.json', ...ACCEPT_EXT.map((e) => '.' + e)].join(','), style: 'display:none' }) as HTMLInputElement;
  // 平面図（PDF・DXF）と 3D データ（3DS など）は一緒に置ける: 図面を読んでから、3D で高さを合わせる
  const readFiles = async (files: File[]) => {
    const plan = files.find((f) => !is3dFile(f));
    const ext = files.find(is3dFile);
    if (!plan) {
      if (ext) toast('3D データ（3DS など）は、平面図の PDF と一緒に置いてください（図面の間取りに合わせて高さを測ります）', 'info', 8000);
      return;
    }
    const before = state.model;
    await readFile(plan);
    if (ext && state.model && state.model !== before && (await heightsFrom3dFile(ctx, ext))) void ctx.app.go('import');
  };
  const readFile = async (f: File) => {
    if (isProjectFile(f)) {
      try {
        await openProjectFile(f);
      } catch (e) {
        toast((e as Error).message, 'error', 6000);
      }
      return;
    }
    return loadPdf(ctx, new Uint8Array(await f.arrayBuffer()), f.name.replace(/\.(pdf|dxf)$/i, ''), undefined, /\.dxf$/i.test(f.name) ? 'dxf' : 'pdf');
  };
  input.addEventListener('change', () => {
    const fs = [...(input.files ?? [])];
    input.value = '';
    if (fs.length) void readFiles(fs);
  });
  const sample = async (file: string) => {
    const buf = new Uint8Array(await (await fetch(`./samples/${file}`)).arrayBuffer());
    loadPdf(ctx, buf, 'サンプル邸');
  };
  const pick = () => input.click();

  // 背景: 写真を 7 秒ごとにゆっくり寄りながら切り替え、御社の背景動画が読めればその上に重ねる
  const bg = h('div', { class: 'lp-bg' }, ...BG_PHOTOS.map((src, i) => h('img', { src, alt: '', class: i === 0 ? 'on' : '', loading: i < 2 ? 'eager' : 'lazy' })));
  const imgs = [...bg.querySelectorAll('img')];
  let cur = 0;
  const timer = window.setInterval(() => {
    if (!bg.isConnected) return window.clearInterval(timer);
    imgs[cur].classList.remove('on');
    cur = (cur + 1) % imgs.length;
    // アニメーションを最初からかけ直す
    void imgs[cur].offsetWidth;
    imgs[cur].classList.add('on');
  }, 7000);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const vid = h('video', { muted: true, autoplay: true, loop: true, playsinline: true, preload: 'auto', src: BG_VIDEO }) as HTMLVideoElement;
    vid.muted = true;
    vid.addEventListener('playing', () => vid.classList.add('on'), { once: true });
    vid.addEventListener('error', () => vid.remove(), { once: true });
    bg.appendChild(vid);
  }

  const company = (state.company || 'ホームランディック一級建築士事務所').replace(/[　 ]+/g, ' ');
  const left = h(
    'div',
    { class: 'lp-left' },
    h('div', { class: 'lp-brand' }, 'HOME LANDICK'),
    h('p', { class: 'lp-catch' }, '強く、賢く、そして美しく。'),
    h('p', { class: 'lp-catch-en' }, 'Home Landick Architectural Design Office'),
    h('div', { class: 'lp-tool' }, 'Proposal Studio — 図面から、ご提案まで'),
    h(
      'div',
      { class: 'lp-specs' },
      h('div', { class: 'lp-spec' }, h('small', null, 'Ua値'), h('b', null, '0.46 以下')),
      h('div', { class: 'lp-spec' }, h('small', null, 'C値'), h('b', null, '0.5 以下')),
      h('div', { class: 'lp-spec' }, h('small', null, '耐震等級'), h('b', { class: 's' }, '最高等級3', h('br'), '認定取得')),
    ),
  );

  const drop = h(
    'div',
    { class: 'lp-drop', role: 'button', tabindex: '0', onclick: pick, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } } },
    h('b', null, '平面図の PDF をここに置く'),
    h('span', null, 'DXF・保存したプロジェクト（.madori.json）も開けます。ARCHITREND の 3DS を一緒に置くと、床・窓・屋根の高さも 3D のとおりに'),
    h('span', { class: 'lp-btn solid' }, 'ファイルを選ぶ'),
    input,
  );
  const fig = (c: { src: string; title: string; wide?: boolean; plan?: boolean }, onclick?: () => void) =>
    h('figure', { class: `${c.wide ? 'w' : ''}${c.plan ? ' plan' : ''}`, onclick, style: onclick ? 'cursor:pointer' : '' }, h('img', { src: c.src, alt: c.title, loading: 'lazy' }), h('figcaption', null, c.title));

  const col = h(
    'div',
    { class: 'lp-col' },
    h(
      'div',
      { class: 'lp-hero' },
      h('img', { src: './brand/works-tower.jpg', alt: '' }),
      h('div', { class: 'lp-hero-tx' }, h('h1', null, '妥協を知らない', h('br'), 'あなたへの「最適解」を、', h('br'), 'その場でかたちに。'), h('p', null, '間取りの図面から、パース・コーディネート・図面・日照・見積まで。')),
    ),
    h(
      'section',
      { class: 'lp-sec' },
      h('h2', null, 'Start', h('small', null, 'はじめる')),
      h('p', { class: 'lp-lead' }, 'CAD（ARCHITREND・Walk in home・JW-CAD など）から書き出した平面図の PDF を置くと、木造として立ち上げ、ご提案に必要なものがこの画面の中で揃います。'),
      drop,
      h(
        'div',
        { class: 'lp-samples' },
        h('span', null, 'サンプルで試す'),
        h('button', { class: 'lnk', onclick: () => sample('sample_house_A3.pdf') }, 'A3・1 階 2 階'),
        h('button', { class: 'lnk', onclick: () => sample('sample_house_pages.pdf') }, '階ごと・方位回転'),
        h('button', { class: 'lnk', onclick: () => sample('sample_house_site.pdf') }, '敷地・道路あり'),
        h('span', { class: 'sep' }, '｜'),
        h('button', { class: 'lnk', onclick: () => openSiteStudy() }, state.siteStudy ? '敷地から先に検討（控えあり）' : '図面がまだ無い: 敷地から先に検討'),
      ),
    ),
    h(
      'section',
      { class: 'lp-sec' },
      h('h2', null, 'Works', h('small', null, '施工事例')),
      h('p', { class: 'lp-lead' }, '設計事務所の洗練されたデザイン力と、高性能工務店の確かな技術力・施工力。パースのテイストも、この家々を基準に整えています。'),
      h('div', { class: 'lp-works' }, ...WORKS.map((c) => fig(c))),
      h('div', { class: 'lp-more' }, h('a', { class: 'lp-btn', href: 'https://www.homelandick.com/works/', target: '_blank', rel: 'noopener' }, '施工事例を見る')),
    ),
    h(
      'section',
      { class: 'lp-sec' },
      h('h2', null, 'Proposal', h('small', null, '図面からつくるもの')),
      h('p', { class: 'lp-lead' }, 'サンプル邸の平面図 1 枚から、このツールが自動でつくったものです。写真をクリックするとサンプルを開きます。'),
      h('div', { class: 'lp-works' }, ...PROPOSAL.map((c) => fig(c, () => sample('sample_house_A3.pdf')))),
    ),
    h(
      'section',
      { class: 'lp-sec' },
      h('h2', null, 'Plan', h('small', null, '間取り')),
      h('p', { class: 'lp-lead' }, '読み取った間取りは、尺モジュールの方眼の上でそのまま直せます。平面図は柱・建具記号・帖数まで御社の書き方で。'),
      h('div', { class: 'lp-works' }, fig({ src: './showcase/sheet-plan.jpg', title: '平面図（木造の表記）', wide: true, plan: true }, () => sample('sample_house_A3.pdf'))),
    ),
    h(
      'section',
      { class: 'lp-sec' },
      h('h2', null, 'Flow', h('small', null, '流れ')),
      h('ol', { class: 'lp-flow' }, ...FLOW.map(([t, d]) => h('li', null, h('div', null, h('b', null, t), d)))),
    ),
    h(
      'footer',
      { class: 'lp-foot' },
      h('button', { class: 'lnk', onclick: () => document.body.classList.toggle('cover-settings') }, '事務所の設定・読み取りの辞書・MCP'),
      h('a', { class: 'lnk', href: './sun.html' }, '3D データで日照だけ検討'),
      h('a', { class: 'lnk', href: 'https://www.homelandick.com/', target: '_blank', rel: 'noopener' }, 'homelandick.com'),
      h('div', { class: 'copy' }, `© ${company}`),
    ),
  );
  const fab = h('div', { class: 'lp-fab' }, h('button', { class: 'main', onclick: pick }, '図面を読み込む'), h('button', { onclick: () => sample('sample_house_A3.pdf') }, 'サンプルで試す'));
  const scroll = h('div', { class: 'lp-scroll' }, left, col);
  const root = h('div', { class: 'landing' }, bg, scroll, fab);

  // 欄の小見出しごとに、見えたらふわっと出す
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add('in')), { root: scroll, threshold: 0.12 });
  col.querySelectorAll('.lp-sec').forEach((el) => io.observe(el));
  // ドロップは画面全体で受ける
  const over = (e: DragEvent) => {
    e.preventDefault();
    root.classList.add('hover');
  };
  root.addEventListener('dragover', over);
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget as Node)) root.classList.remove('hover');
  });
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    root.classList.remove('hover');
    const fs = [...(e.dataTransfer?.files ?? [])];
    if (fs.length) void readFiles(fs);
  });
  return root;
}

export const importStep: Step = {
  id: 'import',
  label: '図面読込',
  needsModel: false,
  uses3d: false,
  unmount() {
    document.body.classList.remove('cover', 'cover-settings');
    resultCleanup?.();
  },
  mount(ctx) {
    ctx.stage.style.pointerEvents = 'auto';
    document.body.classList.toggle('cover', !state.model);
    if (!state.model) {
      ctx.stage.appendChild(dropScreen(ctx));
      ctx.side.append(
        h('h2', null, '事務所と設定'),
        h('p', { class: 'lead' }, '表題欄・ヘッダー・資料に入る事務所の情報と、読み取りの辞書・MCP の設定です。CAD（ARCHITREND・Walk in home・JW-CAD など）から出力したベクター形式の PDF に対応しています。'),
        section(
          'お客様情報',
          field('プロジェクト名', h('input', { type: 'text', value: state.name, oninput: (e: Event) => (state.name = (e.target as HTMLInputElement).value) })),
          field('お客様名', h('input', { type: 'text', value: state.customer, oninput: (e: Event) => (state.customer = (e.target as HTMLInputElement).value) })),
          field('事務所ロゴ（図面の表題欄・ヘッダー・シネマに入ります）', logoInput()),
          field('事務所名（表題欄のロゴの横。全角スペースで 2 行）', h('input', { type: 'text', value: state.company, placeholder: 'ホームランディック　一級建築士事務所', oninput: (e: Event) => { state.company = (e.target as HTMLInputElement).value; rememberOffice(); } })),
          field('資格・氏名（表題欄の右。「一級建築士第〇〇号　氏名」）', h('input', { type: 'text', value: state.license ?? '', placeholder: '一級建築士第42260号　伊岐見 優', oninput: (e: Event) => { state.license = (e.target as HTMLInputElement).value; rememberOffice(); } })),
          field('設計者（表題欄）', h('input', { type: 'text', value: state.designer ?? '', oninput: (e: Event) => { state.designer = (e.target as HTMLInputElement).value; rememberOffice(); } })),
          h('p', { class: 'hint' }, '事務所名・ロゴ・資格・設計者はこのブラウザに覚え、次のプロジェクトでも表題欄に自動で入ります。'),
        ),
        dictCard(),
        mcpCard(),
        fold(
          '読み取りのコツ',
          {},
          h(
            'ul',
            { style: 'font-size:13px;line-height:1.9;color:#5b6068;padding-left:18px;margin:0' },
            h('li', null, '「S=1/100」などの縮尺表記、または寸法線と寸法値があると縮尺を自動判定します'),
            h('li', null, '室名（LDK・洋室・和室・浴室など）と帖数の文字から部屋の用途を判定します'),
            h('li', null, '方位記号（N）から真北の向きを読み取ります'),
            h('li', null, '「前面道路」「幅員4.0m」などの文字と敷地境界線から、道路に面する側と敷地の広さを読み取ります'),
            h('li', null, '「S=1/100」のまま縮小印刷された図面も、帖数表記から実際の縮尺に補正します'),
            h('li', null, 'スキャン画像の PDF は読み取り精度が下がります'),
          ),
        ),
      );
      return;
    }
    renderResult(ctx);
    ctx.side.append(dictCard(), mcpCard());
  },
};

/** 敷地の検討との照合: 図面を描く前に控えた条件（敷地・建蔽率・容積率・希望の坪数）と、読み取った間取りを比べる */
function siteStudyFold(model: BuildingModel): HTMLElement | null {
  const c = siteStudyCheck(model);
  if (!c) return null;
  const s = state.siteStudy!;
  const el = fold(
    '敷地の検討との照合',
    { open: c.verdict !== 'ok', meta: c.verdict === 'ok' ? '入っています' : c.verdict === 'check' ? '要確認' : '超えています' },
    h('p', { class: 'hint', style: 'margin:0 0 4px' }, `図面を描く前に控えた条件（間口 ${s.frontage} × 奥行 ${s.depth} m・${s.bcr}／${s.far}%・ご希望 ${s.floors === 1 ? '平屋' : `${s.floors} 階建て`} ${s.wantTsubo} 坪）と比べました。`),
    rowsEl(c.rows),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn xs ghost', onclick: () => openSiteStudy(() => { const nx = siteStudyFold(model); if (nx) el.replaceWith(nx); }) }, '条件を見直す'), h('button', { class: 'btn xs ghost', onclick: () => { state.siteStudy = undefined; el.remove(); } }, '照合をやめる')),
  );
  return el;
}

/** 前回からの変更: 図面を読み直したとき、前のプランとの差分を 1 枚に（資料・議事録にも同じものが入る） */
function revisionFold(model: BuildingModel): HTMLElement | null {
  const prev = state.revisions?.[state.revisions.length - 1];
  if (!prev) return null;
  let grand: number | undefined;
  try {
    grand = estimateSummary()?.grand;
  } catch {
    grand = undefined;
  }
  const changes = diffPlans(prev, planSummary(model, state.pdfName ?? '今回', grand));
  const body = h('div', { class: 'check-rows diff' });
  if (!changes.length) body.appendChild(h('p', { class: 'hint', style: 'margin:6px 12px' }, '部屋・帖数・窓・階段・延床に変わりはありません。'));
  for (const c of changes) body.appendChild(h('div', { class: `check-row long ${c.delta != null && c.delta < 0 ? 'info' : 'ok'}` }, h('span', { class: 'ic' }, c.kind === 'cost' ? '￥' : c.delta == null ? '・' : c.delta > 0 ? '＋' : '－'), h('span', { class: 'lb' }, c.kind === 'cost' ? '概算' : c.kind === 'area' ? '延床' : `${c.level ?? ''}階`), h('span', { class: 'dt' }, c.text.replace(/^\d階\s?/, ''))));
  const el = fold(`前回からの変更（${prev.name.replace(/\.pdf$/i, '')} → 今回）`, { open: changes.length > 0, meta: changes.length ? `${changes.length} 件` : '変更なし' }, h('p', { class: 'hint', style: 'margin:0 0 4px' }, '読み直す前のプランと比べた変更です。資料の「前回からの変更」のページと議事録に同じ内容が入ります。'), body, h('div', { class: 'btn-row' }, h('button', { class: 'btn xs ghost', onclick: () => { state.revisions = []; el.remove(); } }, '比較をやめる')));
  return el;
}

/** ご要望との照合: 要望の文章を貼ると、部屋・広さ・引き戸・近さ・向きなどを間取りと突き合わせる（結果は資料の「ご要望との照合」のページにも載る） */
function wishesFold(model: BuildingModel): HTMLElement {
  const list = h('div', { class: 'check-rows wishes' });
  const run = () => {
    clear(list);
    const text = state.wishes ?? '';
    if (!text.trim()) {
      list.appendChild(h('p', { class: 'hint', style: 'margin:6px 12px' }, 'ヒアリングシート・要望書の文章をそのまま貼ってください（1 行 1 要望でなくても構いません）。'));
      return;
    }
    const wishes = parseWishes(text);
    const narrow = woodCheck(model).filter((i) => i.id.startsWith('narrow-')).map((i) => i.title);
    const rs = checkWishes(model, wishes, { narrowIssues: narrow });
    const order: Record<WishResult['status'], number> = { ng: 0, check: 1, ok: 2, na: 3 };
    rs.sort((a, b) => order[a.status] - order[b.status]);
    for (const r of rs) {
      const cls = r.status === 'ng' ? 'ng' : r.status === 'check' ? 'info' : r.status === 'ok' ? 'ok' : 'na';
      list.appendChild(
        h(
          'div',
          { class: `check-row long ${cls}` },
          h('span', { class: 'ic' }, r.status === 'ng' ? '✖' : r.status === 'check' ? '⚠' : r.status === 'ok' ? '✓' : '…'),
          h('span', { class: 'lb' }, WISH_STATUS_LABEL[r.status]),
          h('span', { class: 'dt' }, h('b', null, r.wish.label), h('br'), r.evidence),
        ),
      );
    }
    const n = rs.filter((r) => r.status !== 'na').length;
    meta.textContent = n ? `${rs.filter((r) => r.status === 'ok').length}/${n} 叶っています` : '';
  };
  const meta = h('span');
  let timer = 0;
  const ta = h('textarea', {
    class: 'wishes-text',
    rows: 6,
    placeholder: '例）部屋数は、居間、食堂、和室、寝室、個人部屋 2 つ\n居間 6〜8 畳\n寝室とトイレは近くに／ドアは引き戸／台所は東側で朝日が入るように\n今のソファ 220×95 とダブルベッドを持ち込む',
    oninput: (e: Event) => {
      state.wishes = (e.target as HTMLTextAreaElement).value;
      window.clearTimeout(timer);
      timer = window.setTimeout(run, 400);
    },
  }) as HTMLTextAreaElement;
  ta.value = state.wishes ?? '';
  // 体験リンクでお客様が書いたご要望を受け取る（体験リンクを作ってあるときだけ出す）
  const recv = state.coord.shareUrl
    ? h(
        'button',
        {
          class: 'btn sm',
          style: 'margin:0 0 6px',
          onclick: async (e: Event) => {
            const b = e.currentTarget as HTMLButtonElement;
            b.disabled = true;
            const r = await receiveCustomerInbox();
            b.disabled = false;
            ta.value = state.wishes ?? '';
            run();
            toast(inboxSummary(r), r ? 'ok' : 'info', 6000);
          },
        },
        '体験リンクからお客様のご要望を受け取る',
      )
    : null;
  // メモ・PDF のファイルから読み込む（文字の入った PDF・テキスト。スキャン・手書きの画像は文字を取り出せない）
  const fileIn = h('input', { type: 'file', accept: '.txt,.md,.csv,.pdf,text/plain,application/pdf', multiple: true, style: 'display:none' }) as HTMLInputElement;
  fileIn.addEventListener('change', async () => {
    const files = [...(fileIn.files ?? [])];
    fileIn.value = '';
    let added = 0;
    const empty: string[] = [];
    for (const f of files) {
      let text = '';
      try {
        text = /\.pdf$/i.test(f.name) ? await extractPdfText(new Uint8Array(await f.arrayBuffer())) : await f.text();
      } catch (e) {
        toast(`${f.name}: 読めませんでした（${(e as Error).message}）`, 'error', 6000);
        continue;
      }
      if (text.replace(/\s/g, '').length < 4) {
        empty.push(f.name);
        continue;
      }
      const block = `【${f.name}】\n${text.trim()}`;
      if ((state.wishes ?? '').includes(block)) continue;
      state.wishes = `${(state.wishes ?? '').trim()}${state.wishes?.trim() ? '\n\n' : ''}${block}`;
      added++;
    }
    ta.value = state.wishes ?? '';
    run();
    if (added) toast(`${added} 件のファイルの文章を入れました`, 'ok');
    if (empty.length) toast(`${empty.join('・')}: 文字が入っていない PDF（スキャン・手書き）のようです。文章を手で貼ってください`, 'info', 8000);
  });
  const fromFile = h('button', { class: 'btn sm', style: 'margin:0 6px 6px 0', onclick: () => fileIn.click() }, 'メモ・PDF から読み込む');
  const box = h('div', null, h('p', { class: 'hint', style: 'margin:0 0 6px' }, 'お客様の要望の文章を貼ると、部屋の有無・広さ・引き戸・部屋どうしの近さ・向き・階数・駐車台数を間取りと突き合わせます。結果は資料の「ご要望との照合」のページに入ります。'), h('div', null, fromFile, recv, fileIn), ta, list);
  const el = fold('ご要望との照合', { open: !!state.wishes, meta: '' }, box);
  const metaSlot = el.querySelector('summary .meta, summary span:last-child');
  if (metaSlot) metaSlot.appendChild(meta);
  run();
  return el;
}

/**
 * 読み取りの辞書（御社の図面の家具・設備の記号）: 修正画面で直した答えを覚え、過去の図面からまとめて学習し、
 * JSON で持ち運べる。初期辞書は御社の過去プランから同梱
 */
function dictCard(): HTMLElement {
  const body = h('div');
  const el = fold('読み取りの辞書（御社の図面の記号）', { open: false, meta: '', cls: 'dict-fold' }, body);
  const render = () => {
    clear(body);
    const dict = loadSymbolDict();
    const c = countDict(dict);
    el.setMeta(`学習 ${c.user + c.bulk} 件・初期 ${c.seed} 件`);
    const bulkInput = h('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, style: 'display:none' }) as HTMLInputElement;
    const jsonInput = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none' }) as HTMLInputElement;
    bulkInput.addEventListener('change', async () => {
      const files = Array.from(bulkInput.files ?? []);
      if (!files.length) return;
      const pm = progressModal('過去の図面から記号を学習しています', false);
      let learned = 0;
      let plans = 0;
      try {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          pm.set(i / files.length, `${i + 1}/${files.length} ${f.name}`);
          try {
            const data = new Uint8Array(await f.arrayBuffer());
            (globalThis as { __symbolDict?: SymbolSignature[] }).__symbolDict = dict;
            const model = await parsePdfInBrowser(data, { name: f.name });
            if (!model.floors.length) continue;
            plans++;
            for (const fl of model.floors) {
              for (const cand of fl.symbolCandidates ?? []) {
                if (!cand.kind) continue;
                const room = fl.rooms.find((r) => r.id === cand.roomId);
                if (!room) continue;
                learnSymbol(dict, signatureOf(room.type, cand.w, cand.h, cand.inner), cand.kind, 'bulk');
                learned++;
              }
            }
          } catch (e) {
            console.warn('bulk learn failed', f.name, e);
          }
        }
        saveSymbolDict(dict);
        (globalThis as { __symbolDict?: SymbolSignature[] }).__symbolDict = dict;
        toast(`${plans} 図面から ${learned} 件の記号を覚えました（規則で決まらない候補に使います）`, 'ok', 6000);
      } finally {
        pm.close();
        render();
      }
    });
    jsonInput.addEventListener('change', async () => {
      const f = jsonInput.files?.[0];
      if (!f) return;
      try {
        const n = importDict(dict, await f.text());
        saveSymbolDict(dict);
        (globalThis as { __symbolDict?: SymbolSignature[] }).__symbolDict = dict;
        toast(`辞書を ${n} 件取り込みました`, 'ok');
      } catch (e) {
        toast(`取り込めませんでした: ${(e as Error).message}`, 'error');
      }
      render();
    });
    body.append(
      h('p', { class: 'hint', style: 'margin:0 0 8px' }, '図面の長方形（部屋の種類×大きさ×中の線）が何の家具・設備だったかを覚える辞書です。修正画面で家具を直すと自動で覚え、次の図面から同じ形を同じ家具として読みます。'),
      h(
        'ul',
        { class: 'dict-counts' },
        h('li', null, h('b', null, `${c.user} 件`), ' 修正画面で覚えた答え（規則より優先）'),
        h('li', null, h('b', null, `${c.bulk} 件`), ' 過去の図面から一括学習（規則で決まらない候補に使う）'),
        h('li', null, h('b', null, `${c.seed} 件`), ` 同梱の初期辞書（御社の過去プラン ${SEED_PLANS} 図面から）`),
      ),
      h(
        'div',
        { class: 'btn-row', style: 'margin-top:8px' },
        h('button', { class: 'btn sm', onclick: () => bulkInput.click() }, '過去の図面から一括学習（PDF を複数選択）'),
        h(
          'button',
          {
            class: 'btn sm',
            onclick: () => {
              const blob = new Blob([exportDict(dict)], { type: 'application/json' });
              const u = URL.createObjectURL(blob);
              download(u, 'madori-symbol-dict.json');
              setTimeout(() => URL.revokeObjectURL(u), 10000);
            },
          },
          '書き出し（JSON）',
        ),
        h('button', { class: 'btn sm', onclick: () => jsonInput.click() }, '取り込み（JSON）'),
        h(
          'button',
          {
            class: 'btn sm ghost',
            disabled: c.user + c.bulk === 0,
            onclick: () =>
              modal('学習した辞書を消しますか', h('p', null, `修正画面で覚えた ${c.user} 件と一括学習の ${c.bulk} 件を消します（同梱の初期辞書は残ります）。`), [
                {
                  label: '消す',
                  primary: true,
                  onClick: () => {
                    saveSymbolDict([]);
                    (globalThis as { __symbolDict?: SymbolSignature[] }).__symbolDict = loadSymbolDict();
                    toast('学習した辞書を消しました', 'ok');
                    render();
                  },
                },
                { label: 'やめる' },
              ]),
          },
          '学習を消す',
        ),
      ),
      bulkInput,
      jsonInput,
    );
  };
  render();
  return el;
}

/** 初期辞書の元になった図面の数（symbolDictSeed.ts のコメントと同じ） */
const SEED_PLANS = 23;
void SYMBOL_DICT_SEED;

/** この画面の URL から本番の MCP エンドポイントを出す（ローカル・file: のときは本番 URL） */
function mcpEndpoint(): string {
  const origin = typeof location !== 'undefined' && /^https?:/.test(location.protocol) && !/localhost|127\.0\.0\.1/.test(location.hostname) ? location.origin : 'https://madori-presentation.vercel.app';
  return `${origin}/api/mcp`;
}

/** Claude Code・Codex などの AI エージェントから、このツールを MCP で使うための接続カード */
function mcpCard(): HTMLElement {
  const url = mcpEndpoint();
  const cmd = (label: string, text: string) =>
    h(
      'div',
      { class: 'mcp-cmd' },
      h('span', { class: 'mcp-cmd-label' }, label),
      h('code', null, text),
      h(
        'button',
        {
          class: 'btn sm',
          onclick: () => {
            navigator.clipboard?.writeText(text).then(
              () => toast('コピーしました', 'ok', 1500),
              () => toast('コピーできませんでした。選択して Ctrl+C で写してください', 'error'),
            );
          },
        },
        'コピー',
      ),
    );
  const exportModel = () => {
    const model = state.model;
    if (!model) return;
    const blob = new Blob([JSON.stringify(model)], { type: 'application/json' });
    const u = URL.createObjectURL(blob);
    download(u, `${(state.name || model.name || 'madori').replace(/[\\/:*?"<>|]+/g, '_')}.model.json`);
    setTimeout(() => URL.revokeObjectURL(u), 10000);
  };
  return fold(
    'Claude Code・Codex との連携（MCP）',
    { open: false, meta: '接続コマンド', cls: 'mcp-fold' },
    h('p', { class: 'hint', style: 'margin:0 0 8px' }, 'このツールの図面読み取り・木造チェック・清書平面図（SVG）・DXF・概算見積・仕上げカタログを、Claude Code や Codex などの AI エージェントから MCP ツールとして呼べます。追加の設定は不要です。'),
    h('div', { class: 'mcp-group' }, h('b', null, 'この URL に接続する（どこからでも）')),
    cmd('Claude Code', `claude mcp add --transport http madori ${url}`),
    cmd('Codex CLI', `codex mcp add madori --url ${url}`),
    cmd('config.toml', `[mcp_servers.madori]\nurl = "${url}"`),
    h('div', { class: 'mcp-group' }, h('b', null, 'リポジトリのフォルダで動かす（Node.js だけで動く）')),
    cmd('Claude Code', 'claude mcp add madori -- node scripts/mcp-server.mjs'),
    cmd('Codex CLI', 'codex mcp add madori -- node scripts/mcp-server.mjs'),
    h('p', { class: 'hint', style: 'margin:8px 0 0' }, 'ツール: parse_floor_plan（PDF/DXF → 間取り）・wood_check・floor_plan_svg・export_dxf・estimate・catalog・get_model。リポジトリで動かす版には render_views（3D パースを画像で返す。Chrome が必要）もあります。URL 接続では PDF は base64 か pdf_url で渡します（4.5 MB まで）。'),
    state.model
      ? h(
          'div',
          { class: 'btn-row', style: 'margin-top:8px' },
          h('button', { class: 'btn sm', onclick: exportModel }, '読み取った間取りを JSON で書き出す'),
          h('span', { class: 'hint', style: 'align-self:center' }, 'MCP の model として渡せます'),
        )
      : null,
  );
}

const PLAN_SIDE_LABEL: Record<PlanSide, string> = { top: '図面の上', right: '図面の右', bottom: '図面の下', left: '図面の左' };

/** 図面の辺 → 方位（北・南東など） */
function sideCompass(side: PlanSide, northDeg: number): string {
  const v = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] }[side];
  const a = (northDeg * Math.PI) / 180;
  const n = [Math.sin(a), -Math.cos(a)];
  const e = [Math.cos(a), Math.sin(a)];
  const deg = ((Math.atan2(v[0] * e[0] + v[1] * e[1], v[0] * n[0] + v[1] * n[1]) * 180) / Math.PI + 360) % 360;
  return ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(deg / 45) % 8];
}

/** 接道（道路に面する側）と敷地の確認・修正 */
function roadSection(model: NonNullable<typeof state.model>, redraw: () => void): HTMLElement {
  const box = h('div');
  const render = () => {
    clear(box);
    const site = model.site;
    const roads = site?.roads ?? [];
    const sides: PlanSide[] = ['top', 'right', 'bottom', 'left'];
    const detected = roads.filter((r) => r.source !== 'manual');
    const summary = roads.length
      ? roads.map((r) => `${sideCompass(r.side, model.northAngleDeg)}側（${PLAN_SIDE_LABEL[r.side]}）${r.widthMm ? `・幅員${(r.widthMm / 1000).toFixed(1)}m` : ''}`).join('／')
      : '図面に道路の表記が見つかりませんでした。玄関の向きを道路側として扱っています';
    const inferred = detected.filter((r) => r.source === 'inferred');
    const src = inferred.length && inferred.length === detected.length
      ? `道路の文字は無く、${inferred.map((r) => r.label).filter(Boolean).join('・')}から推定`
      : detected.length ? `図面の「${detected.map((r) => r.label).filter(Boolean).join('」「')}」から読み取り` : roads.length ? '手動で設定' : '';
    const nb = site ? Object.keys(site.bounds).length : 0;
    const parts: (HTMLElement | null)[] = [
      h('div', { style: 'font-size:13px;line-height:1.8' }, h('b', null, '道路：'), summary),
      src ? h('div', { class: 'hint', style: 'margin:0' }, src) : null,
      h('div', { class: 'field-label', style: 'margin-top:8px' }, '道路に面している側（角地は複数選択）'),
      h(
        'div',
        { class: 'btn-row', style: 'margin-top:0' },
        sides.map((sd) => {
          const on = roads.some((r) => r.side === sd);
          return h(
            'button',
            {
              class: `btn sm ${on ? 'dark' : ''}`,
              onclick: () => {
                const s0 = (model.site ??= { roads: [], bounds: {} });
                if (on) s0.roads = s0.roads.filter((r) => r.side !== sd);
                else s0.roads.push({ side: sd, source: 'manual', widthMm: s0.roads[0]?.widthMm });
                emit('model');
                redraw();
                render();
              },
            },
            `${sideCompass(sd, model.northAngleDeg)}（${PLAN_SIDE_LABEL[sd].replace('図面の', '')}）`,
          );
        }),
      ),
      roads.length
        ? field(
            '道路幅員 (m)',
            h('input', {
              type: 'number',
              step: 0.5,
              min: 2,
              max: 30,
              value: roads[0].widthMm ? roads[0].widthMm / 1000 : '',
              placeholder: '例: 4.0',
              onchange: (e: Event) => {
                const v = parseFloat((e.target as HTMLInputElement).value);
                for (const r of roads) r.widthMm = Number.isFinite(v) ? v * 1000 : undefined;
                emit('model');
                redraw();
                render();
              },
            }),
          )
        : null,
      h(
        'div',
        { style: 'font-size:12.5px;color:#5b6068;line-height:1.8' },
        `敷地境界線：${nb ? `${nb}辺を図面から読み取り` : '図面から読み取れなかったため標準の余白で作成'}${site?.areaM2 ? `／敷地面積 ${site.areaM2.toFixed(2)}㎡（${(site.areaM2 / 3.30579).toFixed(1)}坪）` : ''}`,
      ),
      h('p', { class: 'hint' }, '道路側に駐車スペース・アプローチを配置し、「道路側から見た外観パース」を作成します。'),
    ];
    box.append(...parts.filter((x): x is HTMLElement => !!x));
  };
  render();
  const roads = model.site?.roads ?? [];
  return fold('接道・敷地', { meta: roads.length ? `道路 ${roads.length} 面` : '' }, box);
}

/** 図面読込の結果画面で開いている方眼の修正（ステップを離れるときに外す） */
let resultCleanup: (() => void) | null = null;

function renderResult(ctx: StepCtx) {
  document.body.classList.remove('cover', 'cover-settings');
  const model = state.model!;
  const view = h('div', { class: 'plan-view' });
  // 木造チェックの「図面で見る」で赤表示する項目（state.plans には入れない: 資料・図面出力には載せない）
  let shownIssue: WoodIssue | null = null;
  let plansStale = false;
  const drawPlans = () => {
    plansStale = false;
    clear(view);
    // 確認表示は設計図書らしく: 方眼紙の背景（通り芯の格子）に、御社の表記（黒塗りの壁・JIS の建具記号）
    state.plans = model.floors.map((f) => ({ level: f.level, svg: floorPlanSvg(model, f, { paper: 'grid' }) }));
    state.sheets = [];
    if (shownIssue) {
      view.appendChild(
        h(
          'div',
          { class: 'plan-marks-banner' },
          h('span', null, h('b', null, '赤表示: '), shownIssue.title),
          h(
            'button',
            {
              class: 'btn sm',
              onclick: () => {
                shownIssue = null;
                drawPlans();
              },
            },
            '表示を消す',
          ),
        ),
      );
    }
    for (const f of model.floors) {
      const mk = shownIssue?.marks?.filter((x) => x.level === f.level) ?? [];
      const svg = mk.length ? floorPlanSvg(model, f, { marks: mk, paper: 'grid' }) : state.plans.find((p) => p.level === f.level)!.svg;
      view.appendChild(h('div', { class: `sheet level-${f.level} ${mk.length ? 'marked' : ''}`, html: svg }));
    }
  };
  /** 図面で見ている間だけ描き直す（方眼で直している間は、離れるときにまとめて作る） */
  const redrawPlans = () => {
    if (mode === 'sheet') drawPlans();
    else plansStale = true;
  };

  // 表示: 方眼の上でそのまま直す（既定）／仕上がりの図面で見る
  let mode: 'edit' | 'sheet' = 'edit';
  resultCleanup?.();
  const editor = openPlanEditor(ctx.stage, model, () => {}, state.pdfName ?? '', {
    embedded: true,
    onCommit: () => {
      plansStale = true;
      emit('model');
      refreshSummary();
    },
  });
  resultCleanup = () => {
    editor.destroy();
    if (plansStale && state.model === model) state.plans = model.floors.map((f) => ({ level: f.level, svg: floorPlanSvg(model, f) }));
    resultCleanup = null;
  };
  view.hidden = true;
  ctx.stage.appendChild(view);
  const modeSeg = h('div', { class: 'segmented imp-mode' });
  const setMode = (m: 'edit' | 'sheet') => {
    mode = m;
    editor.el.hidden = m !== 'edit';
    view.hidden = m !== 'sheet';
    if (m === 'sheet') drawPlans();
    clear(modeSeg);
    for (const [v, l] of [['edit', '方眼で直す'], ['sheet', '図面で見る']] as const) modeSeg.appendChild(h('button', { class: v === mode ? 'on' : '', onclick: () => setMode(v) }, l));
  };
  setMode('edit');
  const showMarks = (issue: WoodIssue | null) => {
    shownIssue = issue;
    setMode('sheet');
    const lv = issue?.marks?.[0]?.level;
    if (lv != null) view.querySelector(`.sheet.level-${lv}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const openEditor = () => setMode('edit');

  const rep = model.report;
  const scaleLabel = rep.scaleDenominator ? `1/${rep.scaleDenominator}` : `約1/${Math.round(rep.mmPerPt / 0.3528)}`;
  const srcLabel: Record<string, string> = { dimension: '寸法線から判定', text: '縮尺表記から判定', area: '帖数から推定', module: '壁の間隔から推定', default: '既定値', manual: '手動指定' };

  // 要点（直すたびに更新）: 階・部屋・窓とドア・延床と、読み取りチェック
  const summary = h('div', { class: 'imp-summary' });
  const checkHost = h('div');
  function refreshSummary() {
    const rooms = model.floors.reduce((s, f) => s + f.rooms.length, 0);
    const openings = model.floors.reduce((s, f) => s + f.openings.length, 0);
    const totalArea = model.floors.reduce((s, f) => s + f.rooms.reduce((a, r) => a + r.area, 0), 0);
    clear(summary);
    summary.append(
      h('b', null, `${model.floors.length}階・${rooms}部屋・窓とドア ${openings}`),
      h('span', null, `延床 約${(totalArea / 3.30579).toFixed(1)}坪（${totalArea.toFixed(1)}㎡）／縮尺 ${scaleLabel}／${moduleLabel(model).replace(/（.*$/, '')}`),
    );
    clear(checkHost);
    checkHost.append(
      checkCard(
        model,
        openEditor,
        () => {
          northFold.open = true;
          northInput?.focus();
        },
        () => {
          emit('model');
          toast('読み取りを修正しました', 'ok');
          ctx.app.go('import');
        },
        showMarks,
        (level) => {
          setMode('edit');
          editor.showLevel(level);
        },
      ),
    );
  }

  const side = ctx.side;
  side.append(
    h('h2', null, '図面の解析結果'),
    summary,
    modeSeg,
    h('p', { class: 'hint imp-hint' }, '方眼の上でそのまま直せます（壁・窓・戸・部屋名・家具・階段・柱）。部屋名や用途は、名前をクリック。'),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary block', onclick: () => ctx.app.go('design') }, '3D パースを作成する →')),
    h(
      'div',
      { class: 'btn-row', style: 'margin-top:0' },
      h(
        'button',
        {
          class: 'btn block',
          title: '3D を立ち上げ、外観・内観のカット、図面シート、提案資料までを一気に作って資料の画面を開きます（高品質描画。写真品質は資料の画面で後から掛けられます）',
          onclick: () => {
            state.autoRun = 'draft';
            ctx.app.go('present');
          },
        },
        '提案一式をまとめて作る（パース・図面・資料）',
      ),
    ),
    checkHost,
  );
  if (rep.warnings.length)
    side.append(
      fold(
        '読み取りのメモ',
        { meta: `${rep.warnings.length} 件` },
        h('div', { style: 'font-size:12.5px;color:#5b6068;line-height:1.8' }, `縮尺 ${scaleLabel}（${srcLabel[rep.scaleSource]}）／壁厚 ${rep.wallThicknesses.slice(0, 4).join('・')}mm`),
        ...rep.warnings.map((w) => h('div', { class: 'warn' }, w)),
      ),
    );

  // 方位
  const northVal = h('span', null, `${model.northAngleDeg}°`);
  let northInput: HTMLInputElement | null = null;
  const northFold = fold(
      '方位・高さ',
      { meta: `真北 ${model.northAngleDeg}°・1階床 GL+${model.floors[0]?.elevation ?? 500}` },
      field(
        '真北の向き（図面の上から時計回り）',
        (northInput = h('input', {
          type: 'range',
          min: -180,
          max: 180,
          step: 1,
          value: model.northAngleDeg,
          oninput: (e: Event) => {
            model.northAngleDeg = +(e.target as HTMLInputElement).value;
            northVal.textContent = `${model.northAngleDeg}°`;
          },
          onchange: () => {
            emit('model');
            redrawPlans();
          },
        }) as HTMLInputElement),
      ),
      northVal,
      // 道路に面する辺（図面に書かれていない・違うときは手で指定。外観パース・外構・日照の道路側に使う）
      (() => {
        const cur = model.site?.roads.find((r) => r.source === 'manual')?.side ?? (model.site?.roads.length ? 'auto' : 'auto');
        const read = model.site?.roads.filter((r) => r.source !== 'manual') ?? [];
        const lbl = read.length ? `図面から: ${read.map((r) => PLAN_SIDE_LABEL[r.side].replace('図面の', '')).join('・')}` : '図面から読み取れませんでした（玄関の向きで仮に決めます）';
        return h(
          'div',
          { class: 'field', style: 'margin-top:10px' },
          h('span', { class: 'field-label' }, '道路に面する辺（手で指定）'),
          segmented<'auto' | 'top' | 'bottom' | 'left' | 'right'>(
            [
              { value: 'auto', label: '自動' },
              { value: 'top', label: '上' },
              { value: 'bottom', label: '下' },
              { value: 'left', label: '左' },
              { value: 'right', label: '右' },
            ],
            cur as 'auto' | 'top' | 'bottom' | 'left' | 'right',
            (val) => {
              if (!model.site) model.site = { roads: [], bounds: {} };
              model.site.roads = model.site.roads.filter((r) => r.source !== 'manual');
              if (val !== 'auto') model.site.roads.unshift({ side: val, source: 'manual', label: '手入力' });
              emit('model');
              redrawPlans();
            },
          ),
          h('span', { class: 'hint' }, lbl),
        );
      })(),
      h(
        'div',
        { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px' },
        field('1階床高 (mm)', numInput(model.floors[0]?.elevation ?? 500, (v) => {
          let e = v;
          for (const f of model.floors) {
            f.elevation = e;
            e += f.height;
          }
          emit('model');
        })),
        field('階高 (mm)', numInput(model.floors[0]?.height ?? 2900, (v) => {
          let e = model.floors[0]?.elevation ?? 500;
          for (const f of model.floors) {
            f.height = v;
            f.elevation = e;
            e += v;
          }
          emit('model');
        })),
        field('天井高 (mm)', numInput(model.floors[0]?.ceilingHeight ?? 2400, (v) => {
          for (const f of model.floors) f.ceilingHeight = v;
          emit('model');
        })),
      ),
  );
  side.append(northFold);

  // 接道・敷地
  side.append(roadSection(model, redrawPlans));
  const diffBox = revisionFold(model);
  if (diffBox) side.append(diffBox);
  const studyBox = siteStudyFold(model);
  if (studyBox) side.append(studyBox);
  side.append(wishesFold(model));

  // 再読み込み
  const scaleSel = h(
    'select',
    null,
    h('option', { value: '' }, '自動判定'),
    [30, 50, 100, 150, 200].map((n) => h('option', { value: n, selected: rep.scaleDenominator === n && rep.scaleSource === 'manual' }, `1/${n}`)),
  ) as HTMLSelectElement;
  const curModule: ModuleMode = lastPdf?.moduleMode ?? 'auto';
  const moduleSel = h(
    'select',
    null,
    (
      [
        ['auto', '自動判定（尺／メーター）'],
        ['shaku', '尺モジュール 910'],
        ['meter', 'メーターモジュール 1000'],
        ['none', '図面の寸法のまま'],
      ] as [ModuleMode, string][]
    ).map(([v, l]) => h('option', { value: v, selected: v === curModule }, l)),
  ) as HTMLSelectElement;
  const ext3dIn = h('input', { type: 'file', accept: ACCEPT_EXT.map((e) => '.' + e).join(','), style: 'display:none' }) as HTMLInputElement;
  ext3dIn.addEventListener('change', async () => {
    const f = ext3dIn.files?.[0];
    ext3dIn.value = '';
    if (!f) return;
    // 方眼の修正を先に間取りへ入れてから測る
    resultCleanup?.();
    await heightsFrom3dFile(ctx, f);
    void ctx.app.go('import');
  });
  const kindHint = h('span', { class: 'hint' }, DRAWING_KINDS.find((k) => k.id === (lastPdf?.drawing ?? 'auto'))?.hint ?? '');
  const kindSel = h(
    'select',
    {
      onchange: (e: Event) => {
        const k = DRAWING_KINDS.find((x) => x.id === (e.target as HTMLSelectElement).value);
        if (!k) return;
        kindHint.textContent = k.hint;
        if (k.preset.scale) scaleSel.value = String(k.preset.scale);
        if (k.preset.module) moduleSel.value = k.preset.module;
      },
    },
    ...DRAWING_KINDS.map((k) => h('option', { value: k.id, selected: k.id === (lastPdf?.drawing ?? 'auto') }, k.label)),
  ) as HTMLSelectElement;
  side.append(
    fold(
      '読み込みのやり直し・保存',
      {},
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '図面の種類（読み取りのパターン）'), kindSel, kindHint),
      field('縮尺を指定して再解析', scaleSel, '縮尺がずれている場合に指定してください'),
      field('木造モジュール', moduleSel, '壁芯を 455（尺）／500（メーター）の格子にそろえます。自動で判定できない図面は指定してください'),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn sm', disabled: !lastPdf, onclick: () => lastPdf && loadPdf(ctx, lastPdf.data, lastPdf.name, scaleSel.value ? +scaleSel.value : undefined, lastPdf.kind, moduleSel.value as ModuleMode, kindSel.value as DrawingKind) }, '再解析'),
        h('button', { class: 'btn sm', title: '図面の読み取り結果・修正・テイスト・建設地をファイルに保存（Ctrl+S）', onclick: () => void saveProjectFile() }, 'プロジェクトを保存'),
        h('button', { class: 'btn sm ghost', title: '読み取り精度の評価用に、自動の読み取り結果と、直した正解の間取りを1つのファイルに保存します', onclick: () => editor.saveTruth() }, '評価用に保存'),
      ),
      h('p', { class: 'hint', style: 'margin:10px 0 4px' }, 'ARCHITREND の 3DS など、設計の 3D データがあれば、床・窓の腰高と高さ・屋根を 3D のとおりに直せます。'),
      h(
        'div',
        { class: 'btn-row', style: 'margin-top:0' },
        h('button', { class: 'btn sm', onclick: () => ext3dIn.click() }, '3D データ（3DS）で高さを合わせる'),
        ext3dIn,
        h('button', { class: 'btn sm ghost', title: '次に読む図面との「前回からの変更」が出ます', onclick: () => { pendingRevision = summarizeCurrent(); state.model = null; emit('model'); ctx.app.go('import'); } }, '別の PDF を読み込む'),
      ),
    ),
  );
  refreshSummary();
}

function numInput(v: number, onChange: (v: number) => void) {
  return h('input', { type: 'number', value: v, step: 50, onchange: (e: Event) => onChange(+(e.target as HTMLInputElement).value) });
}

/**
 * 読み込み直後の確認カード: 階・玄関・方位・階段・部屋・窓ドアを一目で確認し、
 * 怪しい所は修正画面へ直接飛べるようにする
 */
function checkCard(model: BuildingModel, openEditor: () => void, focusNorth: () => void, onFix: () => void, showMarks: (issue: WoodIssue | null) => void, openLevel: (level: number) => void): HTMLElement {
  type Row = { ok: boolean | null; label: string; detail: string; action?: { label: string; fn: () => void }; action2?: { label: string; fn: () => void } };
  const rows: Row[] = [];
  const floors = model.floors;
  const multi = floors.length >= 2;
  // 階
  const thin = floors.filter((f) => f.rooms.filter((r) => r.type !== 'void').length < 3);
  rows.push({
    ok: floors.length > 0 && thin.length === 0,
    label: '階',
    detail: !floors.length ? '階が読み取れていません' : thin.length ? `${thin.map((f) => `${f.level}階`).join('・')}の部屋がほとんど読めていません（縮尺・壁線の太さを確認）` : floors.map((f) => `${f.level}階 ${f.rooms.filter((r) => r.type !== 'void').length}室`).join('　'),
    action: thin.length ? { label: '方眼で確認', fn: () => openLevel(thin[0].level) } : undefined,
  });
  // 玄関
  const entF = floors.find((f) => f.openings.some((o) => o.kind === 'entrance'));
  const entRoom = floors.flatMap((f) => f.rooms).find((r) => r.type === 'entrance');
  rows.push({
    ok: !!entF,
    label: '玄関',
    detail: entF ? `${entF.level}階に玄関ドア${entRoom ? `（${entRoom.name}）` : ''}` : entRoom ? `「${entRoom.name}」はありますが玄関ドアが読めていません` : '玄関が見つかりません',
    action: entF ? undefined : { label: '方眼で玄関を置く', fn: openEditor },
  });
  // 方位
  const nd = model.report.northDetected;
  rows.push({
    ok: nd === false ? null : true,
    label: '方位',
    detail: nd === false ? '方位記号が無いため、図面の上を北としています' : `真北 ${model.northAngleDeg}°（${nd ? '方位記号から' : '設定値'}）`,
    action: nd === false ? { label: '真北を指定', fn: focusNorth } : undefined,
  });
  // 木造モジュール
  rows.push({
    ok: model.module ? (model.module.fit >= 0.9 ? true : null) : null,
    label: 'モジュール',
    detail: model.module ? `${model.module.size === 910 ? '尺 910' : 'メーター 1000'}（壁芯の ${Math.round(model.module.fit * 100)}% が格子に整合）` : '格子に乗っていないため図面の寸法のまま（読み込みのやり直しで指定できます）',
  });
  // 階段
  const stairsPerFloor = floors.map((f) => `${f.level}階 ${f.stairs.length}`);
  const f1stairs = floors[0]?.stairs.filter((s) => s.goesUp).length ?? 0;
  rows.push({
    ok: multi ? f1stairs > 0 : true,
    label: '階段',
    detail: multi ? (f1stairs ? `${stairsPerFloor.join('・')} か所` : '1階に上り階段が見つかりません（ウォークスルー・吹抜に影響）') : '平屋（階段なし）',
    action: multi && !f1stairs ? { label: '方眼で階段を描く', fn: openEditor } : undefined,
  });
  // 部屋名
  // 名前の無い細い区画（線の読み違いの隙間）は数えない
  const allRooms = floors.flatMap((f) => f.rooms.filter((r) => r.type !== 'void' && r.name.trim()));
  const unnamed = allRooms.filter((r) => r.type === 'other' || /^室$|^部屋$/.test(r.name.trim()));
  const inferred = allRooms.filter((r) => r.inferred && r.type !== 'other');
  const hasLdk = allRooms.some((r) => r.type === 'ldk' || r.type === 'living');
  rows.push({
    ok: unnamed.length === 0 && hasLdk,
    label: '部屋',
    detail: `${allRooms.length}室${hasLdk ? '' : '（LDK／リビングが見つかりません）'}${unnamed.length ? `、用途が分からない部屋 ${unnamed.length}（${unnamed.slice(0, 3).map((r) => r.name).join('・')}${unnamed.length > 3 ? '…' : ''}）` : ''}${inferred.length ? `、名前が無く隣の部屋から推定 ${inferred.length}（${[...new Set(inferred.map((r) => r.name))].slice(0, 4).join('・')}）` : ''}`,
    action: unnamed.length || !hasLdk ? { label: '部屋名を直す', fn: openEditor } : undefined,
  });
  // 窓・ドア
  const noWin = floors.filter((f) => !f.openings.some((o) => o.kind === 'window' || o.kind === 'entrance'));
  const opCount = floors.map((f) => `${f.level}階 窓${f.openings.filter((o) => o.kind === 'window').length}・戸${f.openings.filter((o) => o.kind !== 'window').length}`);
  rows.push({
    ok: noWin.length === 0,
    label: '窓・ドア',
    detail: noWin.length ? `${noWin.map((f) => `${f.level}階`).join('・')}に窓が読めていません` : opCount.join('　'),
    action: noWin.length ? { label: '方眼で窓を置く', fn: openEditor } : undefined,
  });
  // 外形（階ごとの面積の目安）
  const areas = floors.map((f) => f.rooms.filter((r) => !excludedFromFloorArea(r.type)).reduce((a, r) => a + r.area, 0));
  const odd = areas.findIndex((a, i) => i > 0 && areas[0] > 0 && a > areas[0] * 1.35);
  rows.push({
    ok: odd < 0,
    label: '広さ',
    detail: odd < 0 ? areas.map((a, i) => `${floors[i].level}階 ${(a / 3.30579).toFixed(1)}坪`).join('　') : `${floors[odd].level}階が1階より大きく読めています（壁の読み落としの可能性）`,
    action: odd < 0 ? undefined : { label: '方眼で確認', fn: openEditor },
  });

  // 木造（在来軸組）の常識: 壁の端・直下率・梁のスパン・耐力壁・出入口・階段・UB の寸法
  const issues = woodCheck(model);
  const shown = [...issues.filter((i) => i.severity === 'warn'), ...issues.filter((i) => i.severity === 'info')].slice(0, 6);
  if (!shown.length) {
    rows.push({ ok: true, label: '木造', detail: '壁の端・直下率・梁のスパン・出入口・階段の位置に不自然な所はありません' });
  }
  for (const it of shown) {
    const fix = it.fix;
    rows.push({
      ok: it.severity === 'warn' ? false : null,
      label: '木造',
      detail: `${it.title} — ${it.detail}`,
      action: fix
        ? {
            label: fix.label,
            fn: () => {
              fix.apply(model);
              onFix();
            },
          }
        : { label: '方眼で確認', fn: openEditor },
      action2: it.marks?.length ? { label: '図面で見る', fn: () => showMarks(it) } : undefined,
    });
  }

  const ng = rows.filter((r) => r.ok === false).length;
  // 問題が無ければ 1 行に畳む（開くと項目ごとの結果）
  const head = h('summary', { class: 'check-head' }, h('b', null, ng ? `確認してください（${ng} 件）` : '読み取りチェック: 問題なし'), h('span', null, ng ? '⚠ の項目はパースの出来に影響します' : '階・玄関・階段・部屋・窓が揃っています（開くと詳細）'));
  const list = h(
    'div',
    { class: 'check-rows' },
    ...rows.map((r) =>
      h(
        'div',
        { class: `check-row ${r.ok === false ? 'ng' : r.ok === null ? 'info' : 'ok'}${r.detail.length > 48 || r.action || r.action2 ? ' long' : ''}` },
        h('span', { class: 'ic' }, r.ok === false ? '⚠' : r.ok === null ? 'ℹ' : '✓'),
        h('span', { class: 'lb' }, r.label),
        h('span', { class: 'dt' }, r.detail),
        r.action || r.action2
          ? h('div', { class: 'check-actions' }, r.action ? h('button', { class: 'btn sm', onclick: r.action.fn }, r.action.label) : null, r.action2 ? h('button', { class: 'btn sm ghost', onclick: r.action2.fn }, r.action2.label) : null)
          : null,
      ),
    ),
  );
  return h('details', { class: `check-card ${ng ? 'has-ng' : ''}`, open: ng > 0 }, head, list);
}


/** ロゴ画像の選択（縮小して保存。透過 PNG 推奨） */
function logoInput(): HTMLElement {
  const prev = h('img', { style: `max-height:40px;max-width:160px;display:${state.logo ? 'block' : 'none'};margin:6px 0;background:#888;padding:4px;border-radius:2px` }) as HTMLImageElement;
  if (state.logo) prev.src = state.logo;
  const inp = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/svg+xml,image/webp' }) as HTMLInputElement;
  inp.addEventListener('change', async () => {
    const f = inp.files?.[0];
    if (!f) return;
    try {
      const url = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = () => rej(new Error('読み込めませんでした'));
        r.readAsDataURL(f);
      });
      const img = new Image();
      img.src = url;
      await img.decode();
      const k = Math.min(1, 600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      state.logo = c.toDataURL('image/png');
      rememberOffice();
      prev.src = state.logo;
      prev.style.display = 'block';
      emit('project');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  });
  inp.style.display = 'none';
  const pick = h('button', { class: 'btn sm', onclick: () => inp.click() }, 'ロゴ画像を選ぶ');
  const clearBtn = h('button', { class: 'btn sm ghost', onclick: () => { state.logo = undefined; prev.style.display = 'none'; forgetOfficeLogo(); emit('project'); } }, 'ロゴを外す');
  return h('div', null, prev, h('div', { class: 'btn-row', style: 'margin:4px 0 0' }, pick, clearBtn), inp);
}
