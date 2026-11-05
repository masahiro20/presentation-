/**
 * 間取りの手修正
 *
 * 図面の読み取りで壁が足りない・余分な所を、平面の上で直接直せるようにする。
 * - 壁を描く（端点・壁の線・縦横にそろえて吸着）／壁を消す
 * - 窓・ドア・引戸を壁に置く／消す
 * - 部屋名を置く・変える（用途も選べる）
 * 壁を直すたびに、図面の読み取りと同じ方法で部屋を作り直す。
 */
import { POST_KIND_LABEL, OUTDOOR_TYPES, type BuildingModel, type BuiltinVariant, type Floor, type FurnitureItem, type FurnitureKind, type Opening, type Post, type PostKind, type Room, type Vec2, type Wall, FLOOR_OFFSET_PRESETS, VOID_GUARDS, VOID_GUARD_LABEL, type VoidGuard } from '../core/types';
import { overhangPoints, suggestOverhangPosts, hasPostNear, OVERHANG_POST_MIN, postLabel } from '../core/posts';
import { STAIR_KIND_LABEL, STAIR_ENTRY_LABEL } from '../core/stairs';
import { furnitureSymbol } from './furnitureSymbols';
import type { Stair } from '../core/types';
import { buildFurniture, furnitureDims, FURNITURE_LABEL, BUILTIN_VARIANTS, KITCHEN_TYPES } from '../scene/furniture';
import { rebuildFloor, type RoomLabel } from '../parser/assemble';
import { pointInPolygon } from '../core/geometry';
import { loadSymbolDict, saveSymbolDict, learnSymbol, signatureOf } from '../parser/symbolDict';
import { h, clear, toast, useSelect } from './dom';
import { useValueOf, applyUseValue } from '../core/roomUse';
import { chooseModule } from '../parser/module';
import { SHUTTER_LAYOUTS, applyShutterLayout, shutterLayoutOf, autoShutterLayout } from '../core/shutter';
import { OPENING_LABEL, OPENING_DEFAULT, OPENING_KINDS, WINDOW_SHAPES, applyWindowShape, applyOpeningKind, setOpeningWidth, flipHinge, flipSwing, openingSummary, isSlidingWindow, clampToWall } from '../core/openings';
import { stairDrawing } from '../core/stairs';
import { SOFA_SHAPES, LEG_SIDES, WASH_STYLES } from '../scene/furniture';

type Tool = 'select' | 'wall' | 'window' | 'door' | 'sliding' | 'shutter' | 'label' | 'furniture' | 'stairs' | 'post' | 'ceiling';
type Sel = { kind: 'wall'; id: string } | { kind: 'opening'; id: string } | { kind: 'label'; index: number } | null;

interface FloorWork {
  floor: Floor;
  labels: RoomLabel[];
  removed: { a: Vec2; b: Vec2 }[];
  original: Room[];
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export interface PlanEditorOptions {
  /**
   * 図面読込の画面に埋め込む: 「やめる／修正を反映する」を出さず、直すたびに間取りへ反映する（onCommit）。
   * 右の詳細パネルは、選んだ物や家具・階段・柱の道具のときだけ図面の上に浮かべる
   */
  embedded?: boolean;
  onCommit?: () => void;
}

export interface PlanEditorHandle {
  /** 修正画面の外枠（埋め込み時に表示を切り替える） */
  el: HTMLElement;
  /** 埋め込みを外す（未反映の修正は反映し、家具の記号を覚える） */
  destroy(): void;
  /** 表示している階を変える（読み取りチェックの「方眼で確認」など） */
  showLevel(level: number): void;
  /** 読み取り精度の評価用に、自動の読み取りと直した正解を保存 */
  saveTruth(): void;
}

export function openPlanEditor(host: HTMLElement, model: BuildingModel, onDone: (changed: boolean) => void, pdfName = '', opts: PlanEditorOptions = {}): PlanEditorHandle {
  const embedded = !!opts.embedded;
  const autoFloors = clone(model.floors);
  const works: FloorWork[] = model.floors.map((f) => ({
    floor: clone(f),
    labels: f.rooms.filter((r) => r.type !== 'stairs').map((r) => ({ name: r.name, x: r.labelPos.x, y: r.labelPos.y, ceilingHeight: r.ceilingHeight, floorOffset: r.floorOffset, voidGuard: r.voidGuard, floorFinish: r.floorFinish })),
    removed: [],
    original: clone(f.rooms),
  }));
  let fi = 0;
  let tool: Tool = 'select';
  let sel: Sel = null;
  let changed = false;
  // 埋め込み時: 直したら少し待ってまとめて間取りへ反映
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  function markChanged() {
    changed = true;
    if (!embedded) return;
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, 250);
  }
  function commit() {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = null;
    works.forEach((w, i) => (model.floors[i] = w.floor));
    const fl = [...furn].filter(([, v]) => v).map(([level, v]) => ({ level, items: v! }));
    if (fl.length) model.furniture = fl;
    else delete model.furniture;
    opts.onCommit?.();
  }
  let wallStart: Vec2 | null = null;
  let thickness = 120;
  // 吸着: 半間（455）／1 間（910）の格子、壁だけ（端点・線・そろえ）、フリー（吸着なし）。Alt を押している間は一時的にフリー
  type SnapMode = 'half' | 'full' | 'wall' | 'free';
  let snapMode: SnapMode = 'half';
  let showGrid = true;
  try {
    const sm = localStorage.getItem('madori.peSnap');
    if (sm === 'half' || sm === 'full' || sm === 'wall' || sm === 'free') snapMode = sm;
    showGrid = localStorage.getItem('madori.peGrid') !== 'off';
  } catch {
    /* 保存できない環境は既定のまま */
  }
  // 家具: 階ごとの手配置（null = 自動配置）
  const furn = new Map<number, FurnitureItem[] | null>();
  for (const f of model.floors) furn.set(f.level, model.furniture?.find((o) => o.level === f.level)?.items.map((it) => ({ ...it })) ?? null);
  let furnSel: string | null = null;
  let addKind: FurnitureKind | null = null;
  let drag: { id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
  let autoCache: Map<number, FurnitureItem[]> | null = null;
  let furnSeq = 0;
  // 階段
  let stairSel: string | null = null;
  let stairDraw: { a: Vec2; b: Vec2 } | null = null;
  /** 天井高の範囲指定（ドラッグの矩形）と、当てる天井高 */
  let ceilDraw: { a: Vec2; b: Vec2 } | null = null;
  let ceilH = 3500;
  let stairDrag: { id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
  // 柱
  let postSel: string | null = null;
  let postKind: PostKind = 'kuda';
  let postSize = 105;
  let postRound = false;
  const undo: string[] = [];
  const redo: string[] = [];
  let seq = 0;

  const W = () => works[fi];
  const snapshot = () => JSON.stringify({ floor: W().floor, labels: W().labels, removed: W().removed, furn: furn.get(W().floor.level) ?? null });
  const pushUndo = () => {
    undo.push(`${fi}|${snapshot()}`);
    if (undo.length > 60) undo.shift();
    redo.length = 0;
  };
  const restore = (s: string) => {
    const i = s.indexOf('|');
    fi = +s.slice(0, i);
    const o = JSON.parse(s.slice(i + 1));
    W().floor = o.floor;
    W().labels = o.labels;
    W().removed = o.removed;
    furn.set(W().floor.level, o.furn ?? null);
    autoCache = null;
    sel = null;
    furnSel = null;
    markChanged();
    draw();
  };

  // ---- 画面 ----
  const root = h('div', { class: `pe-root${embedded ? ' pe-embedded' : ''}` });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'pe-svg');
  const panel = h('div', { class: 'pe-panel' });
  const status = h('div', { class: 'pe-status' });
  const floorTabs = h('div', { class: 'pe-tabs' });
  const toolBtns = new Map<Tool, HTMLButtonElement>();
  const toolDefs: [Tool, string, string][] = [
    ['select', '選択', '壁・窓・部屋名をクリックして選ぶ（Delete で削除）。選んだ壁の両端の丸をドラッグすると伸ばせます（方眼の格子に止まる。Alt でフリー）'],
    ['wall', '壁を描く', 'クリックで始点、もう一度クリックで終点。続けて描けます。方眼の格子（半間 455）に止まります（Esc / 右クリックで終了、Shift で斜め、Alt を押している間はフリー）'],
    ['window', '窓', '壁をクリックすると窓を置きます'],
    ['door', '開き戸', '壁をクリックすると開き戸を置きます'],
    ['sliding', '引戸', '壁をクリックすると引戸を置きます'],
    ['shutter', 'シャッター', 'ガレージの壁をクリックすると、その壁いっぱいのシャッターを置きます（窓・戸の上なら種類の切り替え）'],
    ['label', '部屋名', '部屋の中をクリックして部屋名を置きます'],
    ['furniture', '家具', '家具をドラッグで移動、R キーで回転（矢印が部屋側・手前）、Delete で削除。右の一覧から追加できます。キッチンは型・コンロ・冷蔵庫・フードを選べます'],
    ['stairs', '階段', '空いている所をドラッグして階段の範囲を描きます。既存の階段はクリックで選び、ドラッグで移動、R キーで昇り口を回転、Delete で削除'],
    ['ceiling', '天井高', '部屋をドラッグで囲む（またはクリック）と、その範囲の部屋だけ右の天井高になります（例: LDK と水まわりだけ 3,500）。同じ高さをもう一度当てると階の天井高に戻ります'],
    ['post', '柱', 'クリックで柱を置きます（方眼・壁の端に止まる。Alt でフリー）。柱をクリックで選んで種類・太さを変える、Delete で削除。柱はその階の床から立ちます: 2 階の張り出しの足元の柱は「1 階」に置きます（点線が上の階の外形）。通し柱は 1 階に置くと 2 階の上まで通ります'],
  ];
  const tools = h(
    'div',
    { class: 'pe-tools' },
    ...toolDefs.map(([t, label, tip]) => {
      const b = h('button', { class: 'btn sm', title: tip, onclick: () => setTool(t) }, label) as HTMLButtonElement;
      toolBtns.set(t, b);
      return b;
    }),
  );
  const thickSel = h(
    'select',
    { title: '描く壁の厚さ', onchange: (e: Event) => (thickness = +(e.target as HTMLSelectElement).value) },
    [90, 105, 120, 150, 180].map((v) => h('option', { value: v, selected: v === thickness }, `壁厚 ${v}`)),
  ) as HTMLSelectElement;
  const bar = h(
    'div',
    { class: 'pe-bar' },
    floorTabs,
    tools,
    thickSel,
    h(
      'select',
      {
        title: 'マウスの吸着先。方眼（尺モジュールなら半間 455・1 間 910、メーターモジュールなら 500・1,000）の格子に止まります。Alt を押している間は一時的にフリー',
        onchange: (e: Event) => {
          snapMode = (e.target as HTMLSelectElement).value as SnapMode;
          try {
            localStorage.setItem('madori.peSnap', snapMode);
          } catch {
            /* 保存できない環境は無視 */
          }
          drawGrid();
        },
      },
      ((model.module?.size ?? 910) === 910
        ? ([['half', '吸着: 半間 455'], ['full', '吸着: 1 間 910'], ['wall', '吸着: 壁だけ'], ['free', 'フリー（吸着なし）']] as [SnapMode, string][])
        : ([['half', '吸着: 500 格子'], ['full', '吸着: 1,000 格子'], ['wall', '吸着: 壁だけ'], ['free', 'フリー（吸着なし）']] as [SnapMode, string][])).map(([v, l]) => h('option', { value: v, selected: v === snapMode }, l)),
    ),
    h(
      'label',
      { class: 'check', title: '背景に薄い方眼（半間 455 の線・1 間 910 の線・2 間ごとの濃い線）を敷く' },
      h('input', {
        type: 'checkbox',
        checked: showGrid,
        onchange: (e: Event) => {
          showGrid = (e.target as HTMLInputElement).checked;
          try {
            localStorage.setItem('madori.peGrid', showGrid ? 'on' : 'off');
          } catch {
            /* 保存できない環境は無視 */
          }
          drawGrid();
        },
      }),
      '方眼',
    ),
    h('button', { class: 'btn sm ghost', title: '元に戻す（Ctrl+Z）', onclick: () => doUndo() }, '↶'),
    h('button', { class: 'btn sm ghost', title: 'やり直す（Ctrl+Y）', onclick: () => doRedo() }, '↷'),
    h('button', { class: 'btn sm ghost', title: '全体を表示', onclick: () => fit() }, '全体'),
    h('span', { style: 'flex:1' }),
    // 直した間取りを「正解データ」として保存（読み取り精度の改善に使う。埋め込み時も見える所に）
    h('button', { class: 'btn sm ghost', title: '読み取り精度の改善用に、自動の読み取り結果と、ここで直した正解の間取りを 1 つのファイル（JSON）に保存します。保存したファイルを送っていただくと、読み違いの原因を調べて直します', onclick: () => saveTruth() }, '正解データとして保存'),
    embedded ? null : h('button', { class: 'btn sm ghost', onclick: () => close(false) }, 'やめる'),
    embedded ? null : h('button', { class: 'btn sm primary', onclick: () => close(true) }, '修正を反映する'),
  );
  // 埋め込み時は、いまの道具の使い方を図面の上に 1 行で出す（右のパネルは選んだ時だけ）
  const tipLine = h('div', { class: 'pe-tip' });
  root.append(bar, h('div', { class: 'pe-body' }, h('div', { class: 'pe-canvas' }, svg, status, embedded ? tipLine : null), panel));
  host.appendChild(root);

  // ---- 表示範囲 ----
  let vb = { x: 0, y: 0, w: 10000, h: 8000 };
  const applyVb = () => {
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    drawGrid();
  };
  const fit = () => {
    const pts = model.floors.flatMap((f) => f.walls.flatMap((w) => [w.a, w.b]));
    if (!pts.length) return;
    const x0 = Math.min(...pts.map((p) => p.x)) - 1500;
    const x1 = Math.max(...pts.map((p) => p.x)) + 1500;
    const y0 = Math.min(...pts.map((p) => p.y)) - 1500;
    const y1 = Math.max(...pts.map((p) => p.y)) + 1500;
    const r = svg.getBoundingClientRect();
    const aspect = r.width > 0 && r.height > 0 ? r.width / r.height : 1.4;
    let w = x1 - x0;
    let hh = y1 - y0;
    if (w / hh > aspect) hh = w / aspect;
    else w = hh * aspect;
    vb = { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - hh / 2, w, h: hh };
    applyVb();
  };
  const mmPerPx = () => vb.w / Math.max(1, svg.getBoundingClientRect().width);
  const toMm = (e: MouseEvent): Vec2 => {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const m = svg.getScreenCTM();
    const p = m ? pt.matrixTransform(m.inverse()) : pt;
    return { x: p.x, y: p.y };
  };

  // ---- 方眼（木造モジュールの格子） ----
  // 格子の位相: 読み取りで求めたモジュール（通り芯）。無ければ壁芯から尺モジュールの位相を推定する
  const gridBase = (() => {
    const mod = model.module;
    if (mod) return { size: mod.size, phaseX: mod.phaseX, phaseY: mod.phaseY };
    const fit = chooseModule(model.floors.flatMap((f) => f.walls.map((w) => ({ a: w.a, b: w.b }))), 'shaku');
    return { size: 910 as const, phaseX: fit?.phaseX ?? 0, phaseY: fit?.phaseY ?? 0 };
  })();
  /** 吸着する格子の間隔（mm）。null = 格子に吸着しない */
  const snapStep = (): number | null => (snapMode === 'half' ? gridBase.size / 2 : snapMode === 'full' ? gridBase.size : null);
  const onGrid = (v: number, phase: number, step: number) => phase + Math.round((v - phase) / step) * step;
  /** 長さの表示（尺モジュールでは「2,730mm（1.5 間）」） */
  const lenLabel = (L: number) => {
    const mm = `${Math.round(L).toLocaleString()}mm`;
    if (gridBase.size !== 910) return mm;
    const ken = L / 1820;
    return Math.abs(ken * 4 - Math.round(ken * 4)) < 0.02 ? `${mm}（${+ken.toFixed(2)} 間）` : mm;
  };
  const gGrid = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  gGrid.setAttribute('pointer-events', 'none');
  /** 背景の方眼: 半間（455）のごく薄い線、1 間（910）の薄い線、2 間（3,640 ごと）の少し濃い線。縮小して線が詰まる段は描かない */
  function drawGrid() {
    while (gGrid.firstChild) gGrid.removeChild(gGrid.firstChild);
    if (!showGrid) return;
    const px = mmPerPx();
    const half = gridBase.size / 2;
    const levels: { step: number; color: string; every?: number }[] = [
      { step: half, color: '#ebe6dd' },
      { step: gridBase.size, color: '#dcd5c9' },
      { step: gridBase.size * 4, color: '#c8bfb0' },
    ];
    const x0 = vb.x;
    const x1 = vb.x + vb.w;
    const y0 = vb.y;
    const y1 = vb.y + vb.h;
    for (const lv of levels) {
      if (lv.step / px < 7) continue; // 線が 7px より詰まる段は省く（縮小表示で真っ黒にならないように）
      const nx = Math.ceil((x1 - x0) / lv.step) + 1;
      const ny = Math.ceil((y1 - y0) / lv.step) + 1;
      if (nx + ny > 1200) continue;
      let d = '';
      for (let x = onGrid(x0, gridBase.phaseX, lv.step) - lv.step; x <= x1 + lv.step; x += lv.step) d += `M${x} ${y0}V${y1}`;
      for (let y = onGrid(y0, gridBase.phaseY, lv.step) - lv.step; y <= y1 + lv.step; y += lv.step) d += `M${x0} ${y}H${x1}`;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', lv.color);
      path.setAttribute('stroke-width', '1');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      path.setAttribute('fill', 'none');
      path.setAttribute('shape-rendering', 'crispEdges');
      gGrid.appendChild(path);
    }
  }

  // ---- 吸着 ----
  /**
   * マウスの点を吸着させる。優先: 壁の端 > 壁の線の上 > 他の壁の端と縦横そろえ > 方眼の格子。
   * diag = 斜めを許す（Shift）、loose = 一時的にフリー（Alt）
   */
  const snap = (p: Vec2, from: Vec2 | null, free: boolean, loose = false): { p: Vec2; hint: string } => {
    if (snapMode === 'free' || loose) return { p: { x: Math.round(p.x), y: Math.round(p.y) }, hint: '' };
    // 吸着の範囲は画面上 14px（縮小表示でも 30cm まで）
    const tol = Math.min(14 * mmPerPx(), 300);
    const f = W().floor;
    let best: { p: Vec2; d: number; hint: string } | null = null;
    for (const w of f.walls)
      for (const q of Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) < 300 ? [] : [w.a, w.b]) {
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < tol && (!best || d < best.d)) best = { p: { ...q }, d, hint: '壁の端' };
      }
    if (best) return { p: best.p, hint: best.hint };
    // 壁の中点（CAD の中点スナップ。戸を壁の中央に置く・間仕切りを等分する）
    for (const w of f.walls) {
      if (Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) < 600) continue;
      const m = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
      const d = Math.hypot(m.x - p.x, m.y - p.y);
      if (d < tol * 0.7 && (!best || d < best.d)) best = { p: m, d, hint: '壁の中点' };
    }
    if (best) return { p: best.p, hint: best.hint };
    let q = { ...p };
    let hint = '';
    if (from && !free) {
      // 縦横にそろえる
      if (Math.abs(q.x - from.x) > Math.abs(q.y - from.y)) q.y = from.y;
      else q.x = from.x;
    }
    // 壁の線の上（T字につなぐ）
    for (const w of f.walls) {
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (L < 1) continue;
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      const t = (q.x - w.a.x) * ux + (q.y - w.a.y) * uy;
      if (t < 0 || t > L) continue;
      const px = w.a.x + ux * t;
      const py = w.a.y + uy * t;
      const d = Math.hypot(q.x - px, q.y - py);
      if (d < tol) {
        // 縦横の拘束を保ったまま線に乗せる
        if (from && !free && Math.abs(q.y - from.y) < 1 && Math.abs(uy) > 0.5) q = { x: w.a.x + (ux * (from.y - w.a.y)) / uy, y: from.y };
        else if (from && !free && Math.abs(q.x - from.x) < 1 && Math.abs(ux) > 0.5) q = { x: from.x, y: w.a.y + (uy * (from.x - w.a.x)) / ux };
        else q = { x: px, y: py };
        hint = '壁の上';
        // 縦横の壁の上では、壁に沿う向きも方眼の格子に止める
        const st = snapStep();
        if (st && !(from && !free)) {
          if (Math.abs(uy) < 0.01) q.x = onGrid(q.x, gridBase.phaseX, st);
          else if (Math.abs(ux) < 0.01) q.y = onGrid(q.y, gridBase.phaseY, st);
        }
        break;
      }
    }
    // 他の壁の端と縦横をそろえる候補（柱の印のような 30cm 未満の短い線は除く）と、方眼の格子の候補のうち、カーソルに近い方に止める
    const step = snapStep();
    const lockY = !!from && !free && Math.abs(q.y - from.y) < 1;
    const lockX = !!from && !free && Math.abs(q.x - from.x) < 1;
    if (!hint) {
      let ex: number | null = null;
      let ey: number | null = null;
      for (const w of f.walls) {
        if (Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) < 300) continue;
        for (const e of [w.a, w.b]) {
          if (!lockX && Math.abs(e.x - q.x) < tol && (ex == null || Math.abs(e.x - q.x) < Math.abs(ex - q.x))) ex = e.x;
          if (!lockY && Math.abs(e.y - q.y) < tol && (ey == null || Math.abs(e.y - q.y) < Math.abs(ey - q.y))) ey = e.y;
        }
      }
      const gx = step ? onGrid(q.x, gridBase.phaseX, step) : null;
      const gy = step ? onGrid(q.y, gridBase.phaseY, step) : null;
      const pick = (v: number, e: number | null, g: number | null): { v: number; by: '' | 'wall' | 'grid' } => {
        if (e != null && (g == null || Math.abs(e - v) <= Math.abs(g - v))) return { v: e, by: 'wall' };
        if (g != null) return { v: g, by: 'grid' };
        return { v, by: '' };
      };
      const rx = lockX ? { v: q.x, by: '' as const } : pick(q.x, ex, gx);
      const ry = lockY ? { v: q.y, by: '' as const } : pick(q.y, ey, gy);
      q = { x: rx.v, y: ry.v };
      if (rx.by === 'wall' || ry.by === 'wall') hint = '壁の端とそろえる';
      else if (rx.by === 'grid' || ry.by === 'grid') hint = `${step === 455 ? '半間' : step === 910 ? '1 間' : `${step}mm`}の格子`;
    }
    return { p: { x: Math.round(q.x), y: Math.round(q.y) }, hint };
  };

  /**
   * CAD のスナップの印: 吸着した点の種類で形を変える（端点 □、中点 △、壁の上 ◇、方眼 ＋、そろえ ✚ に長い補助線）。
   * 何に止まったかが一目で分かる
   */
  const snapMark = (p: Vec2, hint: string, px: number) => {
    const s = 7 * px;
    const col = '#d9822b';
    const base = { fill: 'none', stroke: col, 'stroke-width': 1.5 * px, 'pointer-events': 'none' };
    if (hint === '壁の端') el('rect', { x: p.x - s, y: p.y - s, width: s * 2, height: s * 2, ...base }, gPreview);
    else if (hint === '壁の中点') el('polygon', { points: `${p.x},${p.y - s * 1.2} ${p.x - s * 1.1},${p.y + s * 0.8} ${p.x + s * 1.1},${p.y + s * 0.8}`, ...base }, gPreview);
    else if (hint === '壁の上') el('polygon', { points: `${p.x},${p.y - s * 1.2} ${p.x + s * 1.2},${p.y} ${p.x},${p.y + s * 1.2} ${p.x - s * 1.2},${p.y}`, ...base }, gPreview);
    else if (hint === '壁の端とそろえる') {
      el('line', { x1: p.x - 40 * px, y1: p.y, x2: p.x + 40 * px, y2: p.y, ...base, 'stroke-dasharray': `${4 * px} ${4 * px}` }, gPreview);
      el('line', { x1: p.x, y1: p.y - 40 * px, x2: p.x, y2: p.y + 40 * px, ...base, 'stroke-dasharray': `${4 * px} ${4 * px}` }, gPreview);
    } else if (hint) {
      // 方眼の格子: 十字
      el('line', { x1: p.x - s * 1.4, y1: p.y, x2: p.x + s * 1.4, y2: p.y, ...base }, gPreview);
      el('line', { x1: p.x, y1: p.y - s * 1.4, x2: p.x, y2: p.y + s * 1.4, ...base }, gPreview);
    }
    el('circle', { cx: p.x, cy: p.y, r: 2.5 * px, fill: hint ? col : '#22252a', 'pointer-events': 'none' }, gPreview);
  };

  const wallAt = (p: Vec2, tolPx = 10): { w: Wall; t: number } | null => {
    const tol = tolPx * mmPerPx();
    let best: { w: Wall; t: number; d: number } | null = null;
    for (const w of W().floor.walls) {
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (L < 1) continue;
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      const t = (p.x - w.a.x) * ux + (p.y - w.a.y) * uy;
      if (t < 0 || t > L) continue;
      const d = Math.abs(-(p.x - w.a.x) * uy + (p.y - w.a.y) * ux);
      if (d < w.thickness / 2 + tol && (!best || d < best.d)) best = { w, t, d };
    }
    return best ? { w: best.w, t: best.t } : null;
  };

  // ---- 部屋の作り直し ----
  /** 壁・開口の中心点（作り直すと ID が振り直されるので、選択は位置で引き継ぐ） */
  const centerOf = (f: Floor, s: Sel): Vec2 | null => {
    if (s?.kind === 'wall') {
      const w = f.walls.find((x) => x.id === s.id);
      return w ? { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 } : null;
    }
    if (s?.kind === 'opening') {
      const op = f.openings.find((x) => x.id === s.id);
      const w = op && f.walls.find((x) => x.id === op.wallId);
      if (!op || !w) return null;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
      const t = (op.t0 + op.t1) / 2 / L;
      return { x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t };
    }
    return null;
  };
  const rebuild = () => {
    const wk = W();
    const warnings: string[] = [];
    const keepSel = sel && sel.kind !== 'label' ? { kind: sel.kind, p: centerOf(wk.floor, sel) } : null;
    try {
      const nf = rebuildFloor(wk.floor, wk.labels, model.northAngleDeg, warnings, { rooms: wk.original, removed: wk.removed });
      wk.floor = nf;
      if (keepSel?.p) {
        let best: { s: Sel; d: number } | null = null;
        if (keepSel.kind === 'wall') {
          for (const w of nf.walls) {
            const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
            const t = Math.max(0, Math.min(1, ((keepSel.p.x - w.a.x) * (w.b.x - w.a.x) + (keepSel.p.y - w.a.y) * (w.b.y - w.a.y)) / (L * L)));
            const d = Math.hypot(w.a.x + (w.b.x - w.a.x) * t - keepSel.p.x, w.a.y + (w.b.y - w.a.y) * t - keepSel.p.y);
            if (!best || d < best.d) best = { s: { kind: 'wall', id: w.id }, d };
          }
        } else {
          for (const op of nf.openings) {
            const c = centerOf(nf, { kind: 'opening', id: op.id });
            if (!c) continue;
            const d = Math.hypot(c.x - keepSel.p.x, c.y - keepSel.p.y);
            if (!best || d < best.d) best = { s: { kind: 'opening', id: op.id }, d };
          }
        }
        sel = best && best.d < 300 ? best.s : null;
      }
    } catch (e) {
      console.error(e);
      toast(`部屋の作り直しに失敗しました: ${(e as Error).message}`, 'error');
    }
    autoCache = null;
    markChanged();
  };

  // ---- 家具 ----
  /** この階に置く家具（手配置があればそれ、無ければ自動配置の結果） */
  const itemsOf = (level: number): FurnitureItem[] => {
    const ex = furn.get(level);
    if (ex) return ex;
    if (!autoCache) {
      const tmp: BuildingModel = { ...model, floors: works.map((w) => w.floor), furniture: [...furn].filter(([, v]) => v).map(([lv, v]) => ({ level: lv, items: v! })) };
      try {
        autoCache = buildFurniture(tmp).items;
      } catch (e) {
        console.error(e);
        autoCache = new Map();
      }
    }
    return autoCache.get(level) ?? [];
  };
  /** 手で直す階にする（自動配置の結果を初期値に） */
  const ensureExplicit = (level: number): FurnitureItem[] => {
    let ex = furn.get(level);
    if (!ex) {
      ex = itemsOf(level).map((it) => ({ ...it }));
      furn.set(level, ex);
    }
    return ex;
  };
  const furnCorners = (it: FurnitureItem) => {
    const { w, d, v0 } = furnitureDims(it);
    const r = (it.rot * Math.PI) / 180;
    const ax = Math.cos(r);
    const ay = Math.sin(r);
    const ix = -Math.sin(r);
    const iy = Math.cos(r);
    const pt = (u: number, v: number) => ({ x: it.x + (ax * u + ix * v) * 1000, y: it.y + (ay * u + iy * v) * 1000 });
    return { pts: [pt(-w / 2, v0), pt(w / 2, v0), pt(w / 2, v0 + d), pt(-w / 2, v0 + d)], c: pt(0, v0 + d / 2), front: [pt(-w / 2, v0 + d), pt(w / 2, v0 + d)] };
  };

  // ---- 描画 ----
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag: string, attrs: Record<string, string | number>, parent: Element) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    parent.appendChild(e);
    return e;
  };
  const gGhost = document.createElementNS(NS, 'g');
  const gRooms = document.createElementNS(NS, 'g');
  const gStairs = document.createElementNS(NS, 'g');
  const gFurn = document.createElementNS(NS, 'g');
  const gWalls = document.createElementNS(NS, 'g');
  const gOps = document.createElementNS(NS, 'g');
  const gLabels = document.createElementNS(NS, 'g');
  const gPreview = document.createElementNS(NS, 'g');
  const gPreviewStatic = document.createElementNS(NS, 'g');
  const gPosts = document.createElementNS(NS, 'g');
  svg.append(gGrid, gGhost, gRooms, gStairs, gFurn, gWalls, gOps, gPosts, gLabels, gPreviewStatic, gPreview);

  const wallPoly = (w: Wall) => {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const nx = (-(w.b.y - w.a.y) / L) * (w.thickness / 2);
    const ny = ((w.b.x - w.a.x) / L) * (w.thickness / 2);
    return `${w.a.x + nx},${w.a.y + ny} ${w.b.x + nx},${w.b.y + ny} ${w.b.x - nx},${w.b.y - ny} ${w.a.x - nx},${w.a.y - ny}`;
  };

  const draw = () => {
    for (const g of [gGhost, gRooms, gStairs, gFurn, gWalls, gOps, gPosts, gLabels, gPreviewStatic, gPreview]) while (g.firstChild) g.removeChild(g.firstChild);
    const f = W().floor;
    const fs = Math.max(120, Math.min(320, 13 * mmPerPx()));
    // 他の階（位置合わせの目安）
    for (const o of works)
      if (o !== W())
        for (const w of o.floor.walls) el('polygon', { points: wallPoly(w), fill: '#c9cdd3', 'fill-opacity': 0.35 }, gGhost);
    for (const r of f.rooms) {
      el('polygon', { points: r.polygon.map((p) => `${p.x},${p.y}`).join(' '), fill: '#ffffff', 'fill-opacity': 0.55 }, gRooms);
      const a = el('text', { x: r.labelPos.x, y: r.labelPos.y + fs * 1.15, 'font-size': fs * 0.75, 'text-anchor': 'middle', fill: '#8b8f96' }, gRooms);
      a.textContent = `${(r.labeledTatami ?? r.area / 1.62).toFixed(1)}帖`;
    }
    // 階段（段割り・昇る向き）
    const stairMode = tool === 'stairs';
    const drawStair = (st: Stair, parent: Element, on: boolean, ghost = false) => {
      // CAD の表記（清書平面図と同じ）: 段鼻・側桁・歩行線（○→矢じり）・UP/DN と段数。切断線より上は破線
      const dr = stairDrawing(st, f.height || 2900, { cut: true });
      const g = el('g', { class: 'pe-stair', 'pointer-events': stairMode && !ghost ? 'auto' : 'none', opacity: ghost ? 0.7 : stairMode ? 1 : 0.8 }, parent) as SVGGElement;
      g.dataset.id = st.id;
      const ink = on ? '#b4621e' : '#3a3d42';
      el('rect', { x: st.minX, y: st.minY, width: st.maxX - st.minX, height: st.maxY - st.minY, fill: on ? '#f3c89a' : '#f1efe9', stroke: on ? '#d9822b' : 'none', 'stroke-width': 24 }, g);
      if (dr.well) el('rect', { x: dr.well.minX, y: dr.well.minY, width: dr.well.maxX - dr.well.minX, height: dr.well.maxY - dr.well.minY, fill: '#fff', stroke: ink, 'stroke-width': 8, 'pointer-events': 'none' }, g);
      if (dr.wall) el('rect', { x: dr.wall.minX, y: dr.wall.minY, width: dr.wall.maxX - dr.wall.minX, height: dr.wall.maxY - dr.wall.minY, fill: '#3d424a', 'pointer-events': 'none' }, g);
      const seg = (q: { a: Vec2; b: Vec2; above: boolean }, wd: number) => el('line', { x1: q.a.x, y1: q.a.y, x2: q.b.x, y2: q.b.y, stroke: q.above ? '#9a9a9a' : ink, 'stroke-width': wd, 'pointer-events': 'none', ...(q.above ? { 'stroke-dasharray': '70 50' } : {}) }, g);
      for (const e of dr.edges) seg(e, 10);
      for (const r of dr.risers) seg(r, 7);
      el('path', { d: dr.walkPath, fill: 'none', stroke: ink, 'stroke-width': 10, 'stroke-linejoin': 'round', 'pointer-events': 'none' }, g);
      el('circle', { cx: dr.start.x, cy: dr.start.y, r: 45, fill: '#fff', stroke: ink, 'stroke-width': 9, 'pointer-events': 'none' }, g);
      el('polygon', { points: dr.arrow.map((q) => `${q.x},${q.y}`).join(' '), fill: ink, 'pointer-events': 'none' }, g);
      if (dr.cut) el('polyline', { points: dr.cut.map((q) => `${q.x},${q.y}`).join(' '), fill: 'none', stroke: ink, 'stroke-width': 8, 'pointer-events': 'none' }, g);
      const t = el('text', { transform: `translate(${dr.label.x} ${dr.label.y}) rotate(${dr.label.angle})`, 'font-size': Math.max(140, fs * 0.7), 'text-anchor': 'middle', 'dominant-baseline': 'middle', fill: ink, 'pointer-events': 'none', 'font-weight': 600, stroke: '#fff', 'stroke-width': 30, 'paint-order': 'stroke' }, g);
      t.textContent = dr.label.text;
    };
    for (const st of f.stairs) drawStair(st, gStairs, stairMode && stairSel === st.id);
    // 家具（家具の道具のときだけ操作できる）
    const furnMode = tool === 'furniture';
    for (const it of itemsOf(f.level)) {
      const { pts, c } = furnCorners(it);
      const on = furnMode && furnSel === it.id;
      const g = el('g', { class: 'pe-furn', 'pointer-events': furnMode ? 'auto' : 'none', opacity: furnMode ? 1 : 0.6 }, gFurn) as SVGGElement;
      g.dataset.id = it.id;
      // 当たり判定用の外形（選択中は枠を強調）
      el('polygon', { points: pts.map((q) => `${q.x},${q.y}`).join(' '), fill: on ? '#f3c89a' : '#f1ede6', 'fill-opacity': on ? 0.55 : 0.35, stroke: on ? '#d9822b' : 'none', 'stroke-width': 30 }, g);
      // 平面記号（3D と同じ寸法・向き）
      const sym = el('g', { transform: `translate(${it.x} ${it.y}) rotate(${it.rot})`, 'pointer-events': 'none' }, g);
      const M = 1000;
      for (const pr of furnitureSymbol(it)) {
        if (pr.t === 'rect') {
          const a: Record<string, string | number> = { x: (pr.u - pr.w / 2) * M, y: pr.v * M, width: pr.w * M, height: pr.d * M, fill: pr.fill ?? 'none', stroke: pr.stroke ?? '#8b8f96', 'stroke-width': 10 };
          if (pr.r) a.rx = pr.r * M;
          if (pr.dash) a['stroke-dasharray'] = '60 40';
          el('rect', a, sym);
        } else if (pr.t === 'circle') el('circle', { cx: pr.u * M, cy: pr.v * M, r: pr.r * M, fill: pr.fill ?? 'none', stroke: pr.stroke ?? '#8b8f96', 'stroke-width': 10 }, sym);
        else if (pr.t === 'line') el('line', { x1: pr.u1 * M, y1: pr.v1 * M, x2: pr.u2 * M, y2: pr.v2 * M, stroke: pr.stroke ?? '#8b8f96', 'stroke-width': pr.dash ? 10 : 14, ...(pr.dash ? { 'stroke-dasharray': '60 40' } : {}) }, sym);
        else {
          // 文字は回転させず読める向きに（記号の位置だけ使う）
          const t = el('text', { x: pr.u * M, y: pr.v * M, 'font-size': (pr.size ?? 0.16) * M * 0.8, 'text-anchor': 'middle', fill: '#4a4e55', transform: `rotate(${-it.rot} ${pr.u * M} ${pr.v * M})` }, sym);
          t.textContent = pr.text;
        }
      }
      if (it.kind !== 'kitchen') {
        const t = el('text', { x: c.x, y: c.y + fs * 0.3, 'font-size': fs * 0.55, 'text-anchor': 'middle', fill: on ? '#b8683a' : '#6d7178', 'pointer-events': 'none', stroke: '#fff', 'stroke-width': fs * 0.12, 'paint-order': 'stroke' }, g);
        t.textContent = FURNITURE_LABEL[it.kind];
      }
    }
    for (const w of f.walls) {
      const on = sel?.kind === 'wall' && sel.id === w.id;
      const p = el('polygon', { points: wallPoly(w), fill: on ? '#d9822b' : w.exterior ? '#1f2226' : '#3d424a', class: 'pe-wall' }, gWalls);
      p.dataset.id = w.id;
    }
    // 選んだ壁の端点のつまみ（ドラッグで伸ばす・縮める。つながった壁の端も一緒に動く）
    const selWall = sel?.kind === 'wall' ? f.walls.find((x) => x.id === (sel as { id: string }).id) : undefined;
    if (selWall && tool === 'select')
      for (const end of ['a', 'b'] as const) {
        const q = selWall[end];
        const c = el('circle', { cx: q.x, cy: q.y, r: 7 * mmPerPx(), fill: '#fff', stroke: '#d9822b', 'stroke-width': 2.5 * mmPerPx(), class: 'pe-handle' }, gPreviewStatic);
        (c as SVGElement).dataset.end = end;
      }
    for (const op of f.openings) {
      const w = f.walls.find((x) => x.id === op.wallId);
      if (!w) continue;
      drawOpening(f, w, op, sel?.kind === 'opening' && sel.id === op.id, fs);
    }
    drawPosts(f);
    W().labels.forEach((l, i) => {
      const on = sel?.kind === 'label' && sel.index === i;
      // 個別の天井高のある部屋: 床を薄く塗り、名前の下に CH を書く
      if (l.ceilingHeight) {
        const room = f.rooms.find((r) => pointInPolygon({ x: l.x, y: l.y }, r.polygon));
        if (room) el('polygon', { points: room.polygon.map((p) => `${p.x},${p.y}`).join(' '), fill: '#d9a066', 'fill-opacity': 0.14, 'pointer-events': 'none' }, gLabels);
        const c = el('text', { x: l.x, y: l.y + fs * 1.05, 'font-size': fs * 0.72, 'text-anchor': 'middle', fill: '#8a5a2a', 'font-weight': 600, stroke: '#fff', 'stroke-width': fs * 0.2, 'paint-order': 'stroke', 'pointer-events': 'none' }, gLabels);
        c.textContent = `CH${l.ceilingHeight}`;
      }
      const t = el('text', { x: l.x, y: l.y, 'font-size': fs, 'text-anchor': 'middle', fill: on ? '#d9822b' : '#22252a', 'font-weight': 600, class: 'pe-label', stroke: '#fff', 'stroke-width': fs * 0.2, 'paint-order': 'stroke' }, gLabels);
      t.textContent = l.name;
      (t as SVGElement).dataset.index = String(i);
    });
    renderPanel();
    renderTabs();
  };

  /**
   * 窓・戸の記号（JIS の平面表示記号に寄せる）。色で種類、形で「どう開くか」が分かるように:
   *  - 窓: 壁の両面の線＋ガラス線。引違いは 2 枚をずらす、FIX は 1 本、小窓（縦すべり出し）は外に三角
   *  - 開き戸: 吊元から 90° 開いた扉の線と戸先の 1/4 円（開く側に描く）、吊元に●
   *  - 引戸: 戸の線（戸の面の側）と、片引きは引き込む先の破線＋矢印
   *  - 玄関ドア: 開き戸と同じ（外開き）、シャッター: 太い破線
   * 選ぶと橙になり、種類と寸法の文字が出る
   */
  const drawOpening = (f: Floor, w: Wall, op: Opening, on: boolean, fs: number) => {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    const nx = -uy;
    const ny = ux;
    const hh = w.thickness / 2;
    const len = op.t1 - op.t0;
    const P = (t: number, off: number) => ({ x: w.a.x + ux * (op.t0 + t) + nx * off, y: w.a.y + uy * (op.t0 + t) + ny * off });
    const col = on ? '#d9822b' : op.kind === 'window' ? '#2f6fa3' : op.kind === 'sliding' ? '#3f8a55' : op.kind === 'open' ? '#999' : op.kind === 'shutter' ? '#7a6248' : op.kind === 'entrance' ? '#8a3f2a' : '#c0582a';
    const thin = Math.max(6, 1.2 * mmPerPx());
    const mid = Math.max(10, 2 * mmPerPx());
    const ln = (p0: Vec2, p1: Vec2, wd = thin, dash?: string) => el('line', { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, stroke: col, 'stroke-width': wd, 'pointer-events': 'none', ...(dash ? { 'stroke-dasharray': dash } : {}) }, gOps);
    // 開口の白抜き（壁の塗りを消す）と、クリック用の当たり（幅は壁厚＋少し）
    const a = P(0, 0);
    const b = P(len, 0);
    el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: '#fff', 'stroke-width': w.thickness + 4, 'pointer-events': 'none' }, gOps);
    // 開口の両端（枠）
    for (const t of [0, len]) ln(P(t, -hh), P(t, hh), mid);
    if (op.kind === 'window') {
      ln(P(0, -hh), P(len, -hh), thin);
      ln(P(0, hh), P(len, hh), thin);
      if (isSlidingWindow(op)) {
        const g = Math.min(hh * 0.45, 34);
        ln(P(0, -g), P(len * 0.53, -g), mid);
        ln(P(len * 0.47, g), P(len, g), mid);
        ln(P(len * 0.53, -g), P(len * 0.53, g), thin);
        ln(P(len * 0.47, -g), P(len * 0.47, g), thin);
      } else {
        ln(P(0, 0), P(len, 0), mid);
        if (op.windowStyle === 'small') {
          const out = w.exterior ? (w.outsideSign ?? 1) : 1;
          const ap = P(len / 2, (hh + Math.min(len * 0.45, 420)) * out);
          ln(P(0, hh * out), ap, thin);
          ln(ap, P(len, hh * out), thin);
        }
      }
    } else if (op.kind === 'door' || op.kind === 'entrance') {
      const hingeAtStart = op.hingeAtStart !== false;
      // 玄関ドアは外開き（外壁の外側へ）
      const side = op.kind === 'entrance' && w.exterior ? (w.outsideSign ?? 1) : (op.swingSide ?? 1);
      const ht = hingeAtStart ? 0 : len;
      const dirU = hingeAtStart ? 1 : -1;
      const hinge = P(ht, hh * side);
      const tip = P(ht, hh * side + len * side);
      ln(hinge, tip, mid);
      // 戸先の軌跡（1/4 円）
      const N = 12;
      const pts: string[] = [];
      for (let k = 0; k <= N; k++) {
        const ang = (Math.PI / 2) * (k / N);
        const q = P(ht + dirU * Math.sin(ang) * len, hh * side + Math.cos(ang) * len * side);
        pts.push(`${q.x},${q.y}`);
      }
      el('polyline', { points: pts.join(' '), fill: 'none', stroke: col, 'stroke-width': thin, 'stroke-dasharray': `${6 * mmPerPx()} ${4 * mmPerPx()}`, 'pointer-events': 'none' }, gOps);
      el('circle', { cx: hinge.x, cy: hinge.y, r: Math.max(25, 3 * mmPerPx()), fill: col, 'pointer-events': 'none' }, gOps);
    } else if (op.kind === 'sliding') {
      const g = Math.min(hh * 0.45, 34);
      if (len >= 1200) {
        // 引違い: 2 枚を前後にずらして中央で重ねる
        ln(P(0, -g), P(len * 0.54, -g), mid);
        ln(P(len * 0.46, g), P(len, g), mid);
      } else {
        // 片引き: 戸の線（戸の面の側）と、開けたときに戸が重なる壁の位置（破線）＋引き込む向きの矢印
        const side = op.swingSide ?? 1;
        const pocketAtStart = op.hingeAtStart === false;
        ln(P(0, g * side), P(len, g * side), mid);
        const q0 = P(pocketAtStart ? -len : len, g * side * 2.2);
        const q1 = P(pocketAtStart ? 0 : len * 2, g * side * 2.2);
        ln(q0, q1, thin, `${8 * mmPerPx()} ${5 * mmPerPx()}`);
        const tipP = pocketAtStart ? q0 : q1;
        const dx = pocketAtStart ? -ux : ux;
        const dy = pocketAtStart ? -uy : uy;
        const ah = Math.max(90, 9 * mmPerPx());
        el('polygon', { points: `${tipP.x},${tipP.y} ${tipP.x - dx * ah - nx * ah * 0.5},${tipP.y - dy * ah - ny * ah * 0.5} ${tipP.x - dx * ah + nx * ah * 0.5},${tipP.y - dy * ah + ny * ah * 0.5}`, fill: col, 'pointer-events': 'none' }, gOps);
      }
    } else if (op.kind === 'shutter') {
      ln(P(0, 0), P(len, 0), Math.max(14, 3 * mmPerPx()), `${90} ${50}`);
    }
    // 当たり判定（透明の太い線）
    const hit = el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: on ? '#d9822b' : col, 'stroke-opacity': on ? 0.18 : 0.001, 'stroke-width': w.thickness + 30 * mmPerPx() * 0 + Math.max(w.thickness + 60, 14 * mmPerPx()), 'stroke-linecap': 'butt', class: 'pe-op' }, gOps);
    hit.dataset.id = op.id;
    // 文字: 選んだとき、または拡大しているときに種類と寸法
    if (on || fs < 180) {
      const c = P(len / 2, (hh + fs * 0.9) * (op.kind === 'door' || op.kind === 'entrance' ? -(op.swingSide ?? 1) : -1));
      const t = el('text', { x: c.x, y: c.y + fs * 0.25, 'font-size': fs * 0.55, 'text-anchor': 'middle', fill: on ? '#b8683a' : col, stroke: '#fff', 'stroke-width': fs * 0.12, 'paint-order': 'stroke', 'pointer-events': 'none', transform: `rotate(${Math.abs(ux) < 0.01 ? -90 : 0} ${c.x} ${c.y})` }, gOps);
      t.textContent = on ? openingSummary(op) : op.kind === 'window' ? (op.windowStyle && op.windowStyle !== 'none' ? WINDOW_SHAPES[op.windowStyle].short : isSlidingWindow(op) ? '引違い' : 'FIX') : OPENING_LABEL[op.kind];
    }
  };

  /** 上の階（張り出しの確認用） */
  const upperOf = (f: Floor) => works.find((o) => o.floor.level === f.level + 1)?.floor ?? null;
  const lowerOf = (f: Floor) => works.find((o) => o.floor.level === f.level - 1)?.floor ?? null;
  /** 柱の形（角柱は正方形、丸柱は円）。通し柱は○で囲む（JIS の表記）、独立柱は×を入れる */
  const drawPost = (p: Post, parent: Element, opts: { on?: boolean; ghost?: boolean; through?: boolean }) => {
    const g = el('g', { class: 'pe-post', opacity: opts.ghost ? 0.45 : 1, 'pointer-events': tool === 'post' && !opts.ghost ? 'auto' : 'none' }, parent) as SVGGElement;
    g.dataset.id = p.id;
    const s = Math.max(p.size, 11 * mmPerPx());
    const fill = opts.on ? '#d9822b' : p.kind === 'free' ? '#7a5634' : '#1f2226';
    if (p.round) el('circle', { cx: p.x, cy: p.y, r: s / 2, fill, stroke: '#fff', 'stroke-width': 1.2 * mmPerPx() }, g);
    else el('rect', { x: p.x - s / 2, y: p.y - s / 2, width: s, height: s, fill, stroke: '#fff', 'stroke-width': 1.2 * mmPerPx() }, g);
    if (p.kind === 'toshi' || opts.through) el('circle', { cx: p.x, cy: p.y, r: s * 1.05, fill: 'none', stroke: opts.on ? '#d9822b' : '#1f2226', 'stroke-width': 2 * mmPerPx() }, g);
    if (p.kind === 'free') {
      const d = s * 0.32;
      el('line', { x1: p.x - d, y1: p.y - d, x2: p.x + d, y2: p.y + d, stroke: '#fff', 'stroke-width': 1.2 * mmPerPx() }, g);
      el('line', { x1: p.x - d, y1: p.y + d, x2: p.x + d, y2: p.y - d, stroke: '#fff', 'stroke-width': 1.2 * mmPerPx() }, g);
    }
    // 当たり判定を少し広く
    el('circle', { cx: p.x, cy: p.y, r: Math.max(s, 12 * mmPerPx()), fill: 'transparent' }, g);
  };
  const drawPosts = (f: Floor) => {
    const px = mmPerPx();
    // 他の階の柱（薄く）。下の階の通し柱はこの階も通るので○付きで
    const lower = lowerOf(f);
    for (const p of lower?.posts ?? []) drawPost(p, gPosts, { ghost: p.kind !== 'toshi', through: p.kind === 'toshi' });
    const upper = upperOf(f);
    for (const p of upper?.posts ?? []) drawPost(p, gPosts, { ghost: true });
    for (const p of f.posts ?? []) drawPost(p, gPosts, { on: tool === 'post' && postSel === p.id });
    // 柱の道具では、上の階の外形を点線で重ね、張り出しの足元（柱がまだ無い所）に○の目印
    if (tool === 'post' && upper) {
      for (const loop of upper.outline) if (loop.length >= 3) el('polygon', { points: loop.map((q) => `${q.x},${q.y}`).join(' '), fill: 'none', stroke: '#d9822b', 'stroke-width': 2 * px, 'stroke-dasharray': `${8 * px} ${5 * px}`, 'pointer-events': 'none' }, gPosts);
      for (const o of overhangPoints(f, upper)) {
        if (o.depth < OVERHANG_POST_MIN || hasPostNear(f.posts, o.p)) continue;
        el('circle', { cx: o.p.x, cy: o.p.y, r: 10 * px, fill: 'none', stroke: '#d9822b', 'stroke-width': 2 * px, 'stroke-dasharray': `${3 * px} ${3 * px}`, 'pointer-events': 'none' }, gPosts);
      }
    }
  };

  const renderTabs = () => {
    clear(floorTabs);
    works.forEach((w, i) =>
      floorTabs.appendChild(
        h('button', { class: `btn sm ${i === fi ? 'dark' : 'ghost'}`, onclick: () => { fi = i; sel = null; wallStart = null; draw(); } }, `${w.floor.level}階`),
      ),
    );
    for (const [t, b] of toolBtns) b.className = `btn sm ${t === tool ? 'dark' : ''}`;
  };

  const renderPanel = () => {
    clear(panel);
    const f = W().floor;
    const tip = toolDefs.find((t) => t[0] === tool)![2];
    if (embedded) {
      tipLine.textContent = tip;
      // 選んだ物の詳細と、家具・階段・柱の一覧があるときだけ浮かべる
      panel.hidden = !sel && tool !== 'furniture' && tool !== 'stairs' && tool !== 'post' && tool !== 'ceiling';
      if (panel.hidden) return;
    } else {
      panel.append(h('h3', null, `${f.level}階の修正`));
      panel.append(h('p', { class: 'hint' }, tip));
    }
    if (tool === 'post') renderPostPanel(f);
    if (tool === 'ceiling') {
      const n = W().labels.filter((l) => l.ceilingHeight).length;
      panel.append(
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '囲んだ範囲の天井高 (mm)'), h('input', { type: 'number', step: 50, min: 2000, max: 6000, value: ceilH, onchange: (e: Event) => (ceilH = +(e.target as HTMLInputElement).value || 3500) })),
        h('p', { class: 'hint' }, `この階の標準は ${f.ceilingHeight} mm。${n ? `${n} 室に個別の天井高があります（床が薄い橙・CH の表示）` : '個別の天井高はまだありません'}`),
        ...(n
          ? [
              h(
                'button',
                {
                  class: 'btn sm ghost',
                  onclick: () => {
                    pushUndo();
                    for (const l of W().labels) l.ceilingHeight = undefined;
                    markChanged();
                    rebuild();
                    draw();
                  },
                },
                'この階の個別の天井高をすべて戻す',
              ),
            ]
          : []),
      );
    }
    if (tool === 'stairs') {
      const st = stairSel ? f.stairs.find((x) => x.id === stairSel) : null;
      if (st) {
        const edit = (fn: (x: Stair) => void) => {
          pushUndo();
          const x = W().floor.stairs.find((q) => q.id === st.id);
          if (x) fn(x);
          markChanged();
          draw();
        };
        const num = (label: string, get: () => number, set: (v: number) => void, step = 10) =>
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('input', { type: 'number', step, value: Math.round(get()), onchange: (e: Event) => edit(() => set(+(e.target as HTMLInputElement).value)) }));
        panel.append(
          h('div', { class: 'field-label' }, `階段（${STAIR_KIND_LABEL[st.kind]}）`),
          h(
            'label',
            { class: 'field' },
            h('span', { class: 'field-label' }, '種類'),
            h('select', { onchange: (e: Event) => edit((x) => (x.kind = (e.target as HTMLSelectElement).value as Stair['kind'])) }, (Object.keys(STAIR_KIND_LABEL) as Stair['kind'][]).map((k) => h('option', { value: k, selected: k === st.kind }, STAIR_KIND_LABEL[k]))),
          ),
          h(
            'label',
            { class: 'field' },
            h('span', { class: 'field-label' }, '昇り口の辺'),
            h('select', { onchange: (e: Event) => edit((x) => (x.entry = (e.target as HTMLSelectElement).value as Stair['entry'])) }, (Object.keys(STAIR_ENTRY_LABEL) as Stair['entry'][]).map((k) => h('option', { value: k, selected: k === st.entry }, STAIR_ENTRY_LABEL[k]))),
          ),
        );
        if (st.kind !== 'straight')
          panel.append(
            h(
              'label',
              { class: 'field' },
              h('span', { class: 'field-label' }, '曲がる向き（昇る人から見て）'),
              h('select', { onchange: (e: Event) => edit((x) => (x.turn = (e.target as HTMLSelectElement).value as Stair['turn'])) }, [
                h('option', { value: 'left', selected: (st.turn ?? (st.kind === 'l' ? 'right' : 'left')) === 'left' }, '左'),
                h('option', { value: 'right', selected: (st.turn ?? (st.kind === 'l' ? 'right' : 'left')) === 'right' }, '右'),
              ]),
            ),
            ...(st.kind === 'uOpen' && st.maxX - st.minX < 2100 && st.maxY - st.minY < 2100 ? [h('p', { class: 'warn' }, 'コの字階段は幅 2,100 以上（段 910 × 2 ＋ 吹抜 300）が要ります。狭いので折り返しとして描いています')] : []),
          );
        panel.append(
          h(
            'label',
            { class: 'field' },
            h('span', { class: 'field-label' }, '上る／下る'),
            h('select', { onchange: (e: Event) => edit((x) => (x.goesUp = (e.target as HTMLSelectElement).value === 'up')) }, [
              h('option', { value: 'up', selected: st.goesUp }, '上の階へ上る（UP）'),
              h('option', { value: 'down', selected: !st.goesUp }, '下の階へ下る（DN）'),
            ]),
          ),
          h(
            'div',
            { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 8px' },
            num('左端 X (mm)', () => st.minX, (v) => { const w = st.maxX - st.minX; st.minX = v; st.maxX = v + w; }),
            num('上端 Y (mm)', () => st.minY, (v) => { const d = st.maxY - st.minY; st.minY = v; st.maxY = v + d; }),
            num('幅 (mm)', () => st.maxX - st.minX, (v) => (st.maxX = st.minX + Math.max(500, v))),
            num('奥行 (mm)', () => st.maxY - st.minY, (v) => (st.maxY = st.minY + Math.max(500, v))),
            num('段数（0 = 自動）', () => st.steps ?? 0, (v) => { if (v >= 6 && v <= 30) st.steps = Math.round(v); else delete st.steps; }),
          ),
          h('p', { class: 'hint' }, '幅・奥行は壁の内側の寸法で入れてください（例: 折り返し階段 1,820 × 1,820、直階段 910 × 2,730）。上の階の同じ位置には自動で吹抜（階段の穴）ができます。'),
          h('button', { class: 'btn sm block', onclick: () => deleteSel() }, 'この階段を消す（Delete）'),
        );
      } else {
        panel.append(
          h('p', { class: 'hint' }, f.stairs.length ? `この階の階段: ${f.stairs.length} か所。クリックして選ぶと種類・昇り口・寸法を変えられます。` : 'この階に階段はありません。空いている所をドラッグして描いてください。'),
          h('ul', { class: 'hint pe-howto' }, h('li', null, '読み取りで階段が無い・ずれている時は、ここで描き直してください。'), h('li', null, '昇り口は、階段に入る側の辺（ホール側）を選びます。'), h('li', null, '2 階側にも同じ位置に「下る（DN）」階段を置くと、2 階の床に穴が開きます。')),
        );
      }
      return;
    }
    if (tool === 'furniture') {
      const level = f.level;
      const ex = furn.get(level);
      const items = itemsOf(level);
      const it = furnSel ? items.find((x) => x.id === furnSel) : null;
      if (it) {
        const edit = (fn: (x: FurnitureItem) => void) => {
          pushUndo();
          const list = ensureExplicit(level);
          const x = list.find((q) => q.id === it.id);
          if (x) fn(x);
          markChanged();
          draw();
        };
        panel.append(h('div', { class: 'field-label' }, FURNITURE_LABEL[it.kind]));
        panel.append(
          h(
            'div',
            { class: 'btn-row' },
            h('button', { class: 'btn sm', title: '左に 90° 回す（Shift+R）', onclick: () => edit((x) => (x.rot = ((x.rot - 90 + 540) % 360) - 180)) }, '↶ 90°'),
            h('button', { class: 'btn sm', title: '右に 90° 回す（R）', onclick: () => edit((x) => (x.rot = ((x.rot + 90 + 540) % 360) - 180)) }, '↷ 90°'),
          ),
        );
        if (it.kind === 'kitchen') {
          const optSel = (label: string, opts: [string, string][], get: () => string, set: (v: string) => void) =>
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('select', { onchange: (e: Event) => edit(() => set((e.target as HTMLSelectElement).value)) }, opts.map(([v, l]) => h('option', { value: v, selected: v === get() }, l))));
          panel.append(
            optSel('キッチンの型', KITCHEN_TYPES, () => it.kitchenType ?? 'peninsula', (v) => { const x = ensureExplicit(level).find((q) => q.id === it.id)!; x.kitchenType = v as FurnitureItem['kitchenType']; }),
            optSel('コンロの位置（部屋側から見て）', [['right', '右'], ['left', '左']], () => it.stoveSide ?? 'right', (v) => { const x = ensureExplicit(level).find((q) => q.id === it.id)!; x.stoveSide = v as FurnitureItem['stoveSide']; }),
            optSel('冷蔵庫', [['right', '右端'], ['left', '左端'], ['none', '置かない（別に配置）']], () => it.fridge ?? 'right', (v) => { const x = ensureExplicit(level).find((q) => q.id === it.id)!; x.fridge = v as FurnitureItem['fridge']; }),
            optSel('レンジフード', [['on', 'あり'], ['off', 'なし']], () => (it.hood === false ? 'off' : 'on'), (v) => { const x = ensureExplicit(level).find((q) => q.id === it.id)!; x.hood = v === 'on'; }),
            h('p', { class: 'hint' }, 'シンクはコンロの反対側に付きます。記号の矢印が部屋側（手前）です。冷蔵庫を別の場所に置くときは「置かない」にして、一覧の「冷蔵庫」を追加してください。'),
          );
        }
        if (it.kind === 'builtin')
          panel.append(
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, '造作の形'), h('select', { onchange: (e: Event) => edit((x) => { x.variant = (e.target as HTMLSelectElement).value as BuiltinVariant; delete x.w; delete x.d; }) }, (Object.keys(BUILTIN_VARIANTS) as BuiltinVariant[]).map((v) => h('option', { value: v, selected: v === (it.variant ?? 'wallShelf') }, BUILTIN_VARIANTS[v].label)))),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, '幅 (m)'), h('input', { type: 'number', step: 0.1, min: 0.4, max: 6, value: furnitureDims(it).w, onchange: (e: Event) => edit((x) => (x.w = +(e.target as HTMLInputElement).value)) })),
            h('p', { class: 'hint' }, BUILTIN_VARIANTS[it.variant ?? 'wallShelf'].note),
          );
        const selField = (label: string, opts: readonly (readonly [string, string])[], get: () => string, set: (x: FurnitureItem, v: string) => void) =>
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('select', { onchange: (e: Event) => edit((x) => set(x, (e.target as HTMLSelectElement).value)) }, opts.map(([v, l]) => h('option', { value: v, selected: v === get() }, l))));
        const numF = (label: string, get: () => number, set: (x: FurnitureItem, v: number) => void, min: number, max: number, step = 0.1) =>
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('input', { type: 'number', step, min, max, value: +get().toFixed(2), onchange: (e: Event) => edit((x) => set(x, +(e.target as HTMLInputElement).value)) }));
        if (it.kind === 'cupboard')
          panel.append(
            numF('幅 (m)', () => it.w ?? 1.8, (x, v) => (x.w = v), 0.6, 4),
            selField('形', SOFA_SHAPES, () => it.shape ?? 'i', (x, v) => (x.shape = v as FurnitureItem['shape'])),
            ...(it.shape === 'l' ? [selField('袖の側（部屋側から見て）', LEG_SIDES, () => it.legSide ?? 'right', (x, v) => (x.legSide = v as FurnitureItem['legSide'])), numF('袖の長さ (m)', () => it.leg ?? 1.8, (x, v) => (x.leg = v), 0.9, 3)] : []),
          );
        if (it.kind === 'sofa')
          panel.append(
            selField('形', SOFA_SHAPES, () => it.shape ?? 'i', (x, v) => (x.shape = v as FurnitureItem['shape'])),
            ...(it.shape === 'l' ? [selField('カウチの側（部屋側から見て）', LEG_SIDES, () => it.legSide ?? 'right', (x, v) => (x.legSide = v as FurnitureItem['legSide'])), numF('カウチの奥行 (m)', () => it.leg ?? 1.6, (x, v) => (x.leg = v), 1.2, 2.2)] : []),
          );
        if (it.kind === 'washstand')
          panel.append(
            numF('幅 (m)', () => it.w ?? 0.77, (x, v) => (x.w = v), 0.6, 2.4, 0.05),
            selField('作り', WASH_STYLES, () => it.washStyle ?? 'unit', (x, v) => (x.washStyle = v as FurnitureItem['washStyle'])),
            h('p', { class: 'hint' }, '造作: カウンター＋置き型ボウル（幅 1.5m 以上で 2 ボウル）＋木のオープン棚＋壁いっぱいの鏡'),
          );
        if (it.kind === 'hanger') panel.append(numF('長さ (m)', () => it.w ?? 1.8, (x, v) => (x.w = v), 0.6, 6), h('p', { class: 'hint' }, '壁から 300 の位置に φ32 のパイプ（H1,800）と枕棚。ファミクロ・WIC の壁に沿って置きます'));
        if (['sofa', 'bed', 'tv', 'rug'].includes(it.kind))
          panel.append(
            h(
              'label',
              { class: 'field' },
              h('span', { class: 'field-label' }, '幅 (m)'),
              h('input', { type: 'number', step: 0.1, min: 0.6, max: 4, value: it.w ?? furnitureDims(it).w, onchange: (e: Event) => edit((x) => (x.w = +(e.target as HTMLInputElement).value)) }),
            ),
          );
        if (it.kind === 'rug')
          panel.append(
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, '奥行 (m)'), h('input', { type: 'number', step: 0.1, min: 0.6, max: 4, value: it.d ?? 1.6, onchange: (e: Event) => edit((x) => (x.d = +(e.target as HTMLInputElement).value)) })),
          );
        if (it.kind === 'kitchen' || it.kind === 'bath')
          panel.append(
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, '長さ (m)'), h('input', { type: 'number', step: 0.1, min: 1, max: 6, value: it.len ?? (it.kind === 'kitchen' ? 3 : 1.6), onchange: (e: Event) => edit((x) => (x.len = +(e.target as HTMLInputElement).value)) })),
          );
        panel.append(h('button', { class: 'btn sm block', onclick: () => deleteSel() }, '消す（Delete）'));
      }
      panel.append(h('div', { class: 'field-label', style: 'margin-top:10px' }, addKind ? `${FURNITURE_LABEL[addKind]}: 置きたい所をクリック` : '家具を追加'));
      const grid = h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px' });
      for (const k of Object.keys(FURNITURE_LABEL) as FurnitureKind[])
        grid.appendChild(h('button', { class: `btn sm ${addKind === k ? 'dark' : 'ghost'}`, onclick: () => { addKind = addKind === k ? null : k; renderPanel(); } }, FURNITURE_LABEL[k]));
      panel.append(grid);
      panel.append(
        h('p', { class: 'hint', style: 'margin-top:8px' }, ex ? 'この階は手で置いた配置です' : 'この階は自動配置です（動かすと手配置になります）'),
        h('button', { class: 'btn sm ghost block', disabled: !ex, onclick: () => { pushUndo(); furn.set(level, null); autoCache = null; furnSel = null; markChanged(); draw(); } }, '自動配置に戻す（この階）'),
      );
      return;
    }
    if (sel?.kind === 'wall') {
      const sid = sel.id;
      const w = f.walls.find((x) => x.id === sid);
      if (w) {
        const L = Math.round(Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y));
        panel.append(
          h('div', { class: 'field-label' }, `壁（長さ ${L}mm・${w.exterior ? '外壁' : '内壁'}）`),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, '厚さ (mm)'), h('input', { type: 'number', value: w.thickness, step: 5, onchange: (e: Event) => { pushUndo(); w.thickness = +(e.target as HTMLInputElement).value; rebuild(); draw(); } })),
          h('button', { class: 'btn sm block', onclick: () => deleteSel() }, 'この壁を消す（Delete）'),
        );
      }
    } else if (sel?.kind === 'opening') {
      const sid = sel.id;
      const op = f.openings.find((x) => x.id === sid);
      if (op) {
        const wall = f.walls.find((x) => x.id === op.wallId);
        const wallLen = wall ? Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) : 10000;
        /** 変えたら作り直して描く（開口の寸法・向きの変更） */
        const change = (fn: () => void) => {
          pushUndo();
          fn();
          clampToWall(op, wallLen);
          rebuild();
          draw();
        };
        const numField = (label: string, get: () => number, set: (v: number) => void, step = 10, hint?: string) =>
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('input', { type: 'number', value: Math.round(get()), step, onchange: (e: Event) => change(() => set(+(e.target as HTMLInputElement).value)) }), hint ? h('span', { class: 'hint' }, hint) : null);
        panel.append(
          h('div', { class: 'field-label' }, OPENING_LABEL[op.kind]),
          h('p', { class: 'hint', style: 'margin:0 0 6px' }, openingSummary(op)),
          h(
            'label',
            { class: 'field' },
            h('span', { class: 'field-label' }, '種類'),
            h('select', { onchange: (e: Event) => change(() => applyOpeningKind(op, (e.target as HTMLSelectElement).value as Opening['kind'], f.ceilingHeight)) }, OPENING_KINDS.map((k) => h('option', { value: k, selected: k === op.kind }, OPENING_LABEL[k]))),
          ),
          ...(op.kind === 'window'
            ? [
                h('div', { class: 'field-label' }, '窓の形（腰高・高さ・開き方が決まります）'),
                h(
                  'div',
                  { class: 'segmented' },
                  ...(Object.keys(WINDOW_SHAPES) as (keyof typeof WINDOW_SHAPES)[]).map((k) => h('button', { class: (op.windowStyle ?? (isSlidingWindow(op) ? (op.sill === 0 ? 'hakidashi' : 'koshi') : 'small')) === k ? 'on' : '', title: WINDOW_SHAPES[k].label, onclick: () => change(() => applyWindowShape(op, k, f.ceilingHeight, wallLen)) }, WINDOW_SHAPES[k].short)),
                ),
                h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 8px' }, numField('腰高 (mm)', () => op.sill, (v) => (op.sill = Math.max(0, v)), 50), numField('窓の高さ (mm)', () => op.height, (v) => (op.height = Math.max(200, v)), 50)),
                h('span', { class: 'hint' }, `掃出し・腰窓は引違い、小窓は縦すべり出し、高窓・スリットは FIX。この階の天井 ${f.ceilingHeight}（標準仕様はサッシ上端を天井にそろえます）`),
              ]
            : []),
          ...(op.kind === 'door' || op.kind === 'entrance'
            ? [
                h('div', { class: 'field-label' }, '開き方'),
                h(
                  'div',
                  { class: 'btn-row' },
                  h('button', { class: 'btn sm', title: '吊元（丁番）を反対の端へ。記号の●が吊元、弧が戸先の軌跡', onclick: () => change(() => flipHinge(op)) }, '吊元を左右入れ替え'),
                  op.kind === 'door' ? h('button', { class: 'btn sm', title: '壁のどちらの面へ開くか', onclick: () => change(() => flipSwing(op)) }, '開く向きを反対側へ') : null,
                ),
                h('span', { class: 'hint' }, op.kind === 'entrance' ? '玄関ドアは外開き（土間に扉が来ないように）。3D では庇とポーチが付きます' : '個室・浴室は部屋の中へ、トイレ・収納は外へ開くのが普通です'),
              ]
            : []),
          ...(op.kind === 'sliding'
            ? [
                h('div', { class: 'field-label' }, '引き方'),
                h(
                  'div',
                  { class: 'btn-row' },
                  op.t1 - op.t0 < 1200 ? h('button', { class: 'btn sm', title: '片引き戸を開けたとき、戸がどちらの壁に重なるか（破線と矢印）', onclick: () => change(() => flipHinge(op)) }, '引き込む側を入れ替え') : null,
                  h('button', { class: 'btn sm', title: '戸の面が壁のどちら側か（記号の線の側）', onclick: () => change(() => flipSwing(op)) }, '戸の面を反対側へ'),
                ),
                h('span', { class: 'hint' }, op.t1 - op.t0 >= 1200 ? '幅 1,200 以上は引違い（2 枚）。片引きにするには幅を 1,200 未満に' : '片引き戸。幅 1,200 以上にすると引違い（2 枚）になります'),
              ]
            : []),
          ...(op.kind === 'shutter'
            ? [
                h('div', { class: 'field-label' }, 'シャッターの形'),
                h(
                  'div',
                  { class: 'segmented' },
                  ...SHUTTER_LAYOUTS.map((l) =>
                    h(
                      'button',
                      {
                        class: shutterLayoutOf(f, op.wallId) === l.id ? 'on' : '',
                        title: l.hint,
                        onclick: () => {
                          const w = f.walls.find((x) => x.id === op.wallId);
                          if (!w) return;
                          pushUndo();
                          applyShutterLayout(f, w, l.id);
                          sel = null;
                          markChanged();
                          rebuild();
                          draw();
                        },
                      },
                      l.label,
                    ),
                  ),
                ),
              ]
            : []),
          h(
            'div',
            { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 8px' },
            numField('幅 (mm)', () => op.t1 - op.t0, (v) => setOpeningWidth(op, v, wallLen), 10),
            numField('壁の始点から (mm)', () => op.t0, (v) => { const w0 = op.t1 - op.t0; op.t0 = Math.max(20, v); op.t1 = op.t0 + w0; }, 5, '記号の●側ではなく、壁の線の始点から。ドラッグでも動かせます（方眼に止まる）'),
          ),
          h('button', { class: 'btn sm block', onclick: () => deleteSel() }, '消す（Delete）'),
        );
      }
    } else if (sel?.kind === 'label') {
      const l = W().labels[sel.index];
      if (l) {
        const input = h('input', { type: 'text', value: l.name, onchange: (e: Event) => { pushUndo(); l.name = (e.target as HTMLInputElement).value.trim() || l.name; rebuild(); draw(); } }) as HTMLInputElement;
        const room = f.rooms.find((r) => pointInPolygon(l, r.polygon));
        panel.append(
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, '部屋名'), input),
          h(
            'label',
            { class: 'field' },
            h('span', { class: 'field-label' }, '用途'),
            useSelect(l.type ? useValueOf({ type: l.type, garageKind: l.garageKind }) : room ? useValueOf(room) : 'other', (v) => { pushUndo(); applyUseValue(l, v); rebuild(); draw(); }),
          ),
          room ? h('p', { class: 'hint' }, `この部屋: 約${room.area.toFixed(1)}㎡（${(room.labeledTatami ?? room.area / 1.62).toFixed(1)}帖）`) : h('p', { class: 'warn' }, 'このラベルは部屋の外にあります（壁で囲まれていない可能性があります）'),
          // 床の段差（小上がり・ダウンリビング・中二階）: FL からの mm。室名が「小上がり」なら自動で +400
          h(
            'label',
            { class: 'field' },
            h('span', { class: 'field-label' }, '床の高さ（FL からの段差）'),
            h(
              'div',
              { style: 'display:flex;gap:6px;align-items:center' },
              h(
                'select',
                { onchange: (e: Event) => { const v = Number((e.target as HTMLSelectElement).value); pushUndo(); if (v) l.floorOffset = v; else l.floorOffset = 0; rebuild(); draw(); } },
                ...(() => {
                  const cur = l.floorOffset ?? room?.floorOffset ?? 0;
                  const opts = FLOOR_OFFSET_PRESETS.slice();
                  if (!opts.some((o) => o.v === cur)) opts.push({ label: `指定 ${cur > 0 ? '+' : ''}${cur}`, v: cur });
                  return opts.map((o) => h('option', { value: String(o.v), selected: o.v === cur }, o.label));
                })(),
              ),
              h('input', { type: 'number', step: 50, min: -1500, max: 2500, value: l.floorOffset ?? room?.floorOffset ?? 0, style: 'width:84px', title: 'mm（＋は上がる、−は下がる）', onchange: (e: Event) => { const v = Math.round(Number((e.target as HTMLInputElement).value) / 10) * 10; pushUndo(); l.floorOffset = v; rebuild(); draw(); } }),
              h('span', { class: 'hint', style: 'margin:0' }, 'mm'),
            ),
          ),
          ...((room?.type === 'void' || l.type === 'void')
            ? [
                h(
                  'label',
                  { class: 'field' },
                  h('span', { class: 'field-label' }, '吹抜の落下防止（上階の縁）'),
                  h(
                    'select',
                    { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value as VoidGuard | ''; pushUndo(); if (v) l.voidGuard = v; else delete l.voidGuard; rebuild(); draw(); } },
                    h('option', { value: '', selected: !(l.voidGuard ?? room?.voidGuard) }, 'テイストの既定'),
                    ...VOID_GUARDS.map((g) => h('option', { value: g, selected: (l.voidGuard ?? room?.voidGuard) === g }, VOID_GUARD_LABEL[g])),
                  ),
                ),
                h('p', { class: 'hint' }, '1 階の平面図には、この範囲が破線で「上部吹抜」と出ます。'),
              ]
            : []),
          h('button', { class: 'btn sm block', onclick: () => deleteSel() }, 'この部屋名を消す（Delete）'),
        );
        setTimeout(() => input.focus(), 0);
      }
    }
    if (embedded) return;
    panel.append(
      h('div', { class: 'pe-legend' }, h('span', null, h('i', { style: 'background:#1f2226' }), '外壁'), h('span', null, h('i', { style: 'background:#3d424a' }), '内壁'), h('span', null, h('i', { style: 'background:#4a90c2' }), '窓'), h('span', null, h('i', { style: 'background:#c46a3a' }), 'ドア'), h('span', null, h('i', { style: 'background:#5aa36f' }), '引戸')),
      h(
        'ul',
        { class: 'hint pe-howto' },
        h('li', null, '部屋がつながってしまう所は「壁を描く」で仕切りを足してください。'),
        h('li', null, '余分な壁は「選択」でクリックして Delete で消せます。'),
        h('li', null, '部屋名が無い所には「部屋名」で名前を置いてください。'),
        h('li', null, 'ホイールで拡大縮小、右ドラッグで移動。Ctrl+Z で元に戻せます。'),
      ),
    );
  };

  const renderPostPanel = (f: Floor) => {
    const p = postSel ? f.posts?.find((x) => x.id === postSel) : undefined;
    const editPost = (fn: (x: Post) => void) => {
      pushUndo();
      const x = W().floor.posts?.find((q) => q.id === postSel);
      if (x) {
        fn(x);
        x.auto = false;
      }
      markChanged();
      draw();
    };
    const kindSel = h(
      'select',
      {
        onchange: (e: Event) => {
          const v = (e.target as HTMLSelectElement).value as PostKind;
          if (v === 'toshi' && f.level !== 1) {
            toast('通し柱は 1 階に置きます（1 階から 2 階の上まで通ります）', 'info');
            (e.target as HTMLSelectElement).value = p?.kind ?? postKind;
            return;
          }
          if (p) editPost((x) => (x.kind = v));
          else postKind = v;
        },
      },
      ...(['kuda', 'toshi', 'free'] as PostKind[]).map((k) => h('option', { value: k, selected: (p?.kind ?? postKind) === k, disabled: k === 'toshi' && f.level !== 1 }, `${POST_KIND_LABEL[k]}${k === 'kuda' ? '（この階だけ）' : k === 'toshi' ? '（1 階〜2 階の上まで）' : '（壁から離れて立つ・張り出しの足元など）'}`)),
    ) as HTMLSelectElement;
    const sizeSel = h(
      'select',
      { onchange: (e: Event) => { const v = +(e.target as HTMLSelectElement).value; if (p) editPost((x) => (x.size = v)); else postSize = v; } },
      ...[105, 120, 150, 180, 240].map((v) => h('option', { value: v, selected: (p?.size ?? postSize) === v }, `${v}`)),
    ) as HTMLSelectElement;
    const roundChk = h('input', { type: 'checkbox', checked: p?.round ?? postRound, onchange: (e: Event) => { const v = (e.target as HTMLInputElement).checked; if (p) editPost((x) => (x.round = v)); else postRound = v; } }) as HTMLInputElement;
    panel.append(
      h('div', { class: 'field-label' }, p ? `選んだ柱（${f.level}階・${postLabel(p)}${p.auto ? '・自動の提案' : ''}）` : `これから置く柱（${f.level}階）`),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '種類'), kindSel),
      h('div', { style: 'display:flex;gap:10px;align-items:end' }, h('label', { class: 'field', style: 'flex:1' }, h('span', { class: 'field-label' }, '太さ（mm 角／径）'), sizeSel), h('label', { class: 'check' }, roundChk, '丸柱')),
    );
    if (p) panel.append(h('button', { class: 'btn sm block', onclick: () => deleteSel() }, 'この柱を消す（Delete）'));
    const upper = upperOf(f);
    if (upper) {
      const sug = suggestOverhangPosts(f, upper, postSize);
      panel.append(
        h('div', { class: 'field-label', style: 'margin-top:12px' }, `${upper.level} 階の張り出し`),
        h('p', { class: 'hint' }, sug.length ? `${upper.level} 階の外形が ${f.level} 階より半間以上張り出している所が ${sug.length} か所あり、足元に柱がありません（図の○）。` : `${upper.level} 階の張り出しの足元には柱があります（または半間未満の張り出しです）。`),
        sug.length
          ? h('button', { class: 'btn sm primary block', onclick: () => { pushUndo(); const ff = W().floor; ff.posts = [...(ff.posts ?? []), ...suggestOverhangPosts(ff, upper, postSize)]; markChanged(); draw(); toast(`張り出しの足元に柱を ${sug.length} 本置きました（独立柱 ${postSize} 角）`, 'ok'); } }, `張り出しの足元に柱を置く（${sug.length} 本）`)
          : h('span'),
      );
    } else if (lowerOf(f)) {
      panel.append(h('p', { class: 'hint', style: 'margin-top:10px' }, `${f.level} 階が下の階より張り出している所の柱は、${f.level - 1} 階の画面で置きます（柱は立つ階の床に置く）。`));
    }
    const n = f.posts?.length ?? 0;
    panel.append(h('p', { class: 'hint', style: 'margin-top:10px' }, `この階の柱: ${n} 本${n ? `（管柱 ${f.posts!.filter((x) => x.kind === 'kuda').length}・通し柱 ${f.posts!.filter((x) => x.kind === 'toshi').length}・独立柱 ${f.posts!.filter((x) => x.kind === 'free').length}）` : ''}。壁の中の柱は 3D では壁に隠れ、壁から離れた柱は 3D にも立ちます。`));
  };

  const deleteSel = () => {
    if (tool === 'post') {
      if (!postSel) return;
      pushUndo();
      const f = W().floor;
      f.posts = (f.posts ?? []).filter((x) => x.id !== postSel);
      if (!f.posts.length) delete f.posts;
      postSel = null;
      markChanged();
      draw();
      return;
    }
    if (tool === 'stairs') {
      if (!stairSel) return;
      pushUndo();
      const f = W().floor;
      f.stairs = f.stairs.filter((x) => x.id !== stairSel);
      stairSel = null;
      markChanged();
      draw();
      return;
    }
    if (tool === 'furniture') {
      if (!furnSel) return;
      pushUndo();
      const list = ensureExplicit(W().floor.level);
      const i = list.findIndex((x) => x.id === furnSel);
      if (i >= 0) list.splice(i, 1);
      furnSel = null;
      markChanged();
      draw();
      return;
    }
    if (!sel) return;
    pushUndo();
    const wk = W();
    if (sel.kind === 'wall') {
      const id = sel.id;
      const w = wk.floor.walls.find((x) => x.id === id);
      if (w) wk.removed.push({ a: w.a, b: w.b });
      wk.floor.walls = wk.floor.walls.filter((x) => x.id !== id);
      wk.floor.openings = wk.floor.openings.filter((o) => o.wallId !== id);
    } else if (sel.kind === 'opening') {
      const id = sel.id;
      wk.floor.openings = wk.floor.openings.filter((o) => o.id !== id);
    } else {
      wk.labels.splice(sel.index, 1);
    }
    sel = null;
    rebuild();
    draw();
  };

  const setTool = (t: Tool) => {
    tool = t;
    wallStart = null;
    sel = null;
    furnSel = null;
    addKind = null;
    stairSel = null;
    stairDraw = null;
    stairDrag = null;
    postSel = null;
    ceilDraw = null;
    svg.style.cursor = t === 'select' || t === 'furniture' ? 'default' : 'crosshair';
    while (gPreview.firstChild) gPreview.removeChild(gPreview.firstChild);
    draw();
  };

  const addWall = (a: Vec2, b: Vec2) => {
    if (Math.hypot(b.x - a.x, b.y - a.y) < 150) return false;
    pushUndo();
    const f = W().floor;
    f.walls.push({ id: `F${f.level}-U${++seq}`, a, b, thickness, exterior: false });
    rebuild();
    draw();
    return true;
  };

  const addOpening = (kind: 'window' | 'door' | 'sliding' | 'shutter', p: Vec2) => {
    const hit = wallAt(p, 14);
    if (!hit) {
      toast('壁の上をクリックしてください');
      return;
    }
    const { w, t } = hit;
    // 既存の窓・ドアの上なら、その種類を切り替える（例: 引戸を窓に）
    const existing = W().floor.openings.find((o) => o.wallId === w.id && t >= o.t0 - 30 && t <= o.t1 + 30);
    if (existing) {
      if (existing.kind === kind) {
        sel = { kind: 'opening', id: existing.id };
        draw();
        return;
      }
      pushUndo();
      applyOpeningKind(existing, kind, W().floor.ceilingHeight);
      sel = { kind: 'opening', id: existing.id };
      rebuild();
      draw();
      toast(`${OPENING_LABEL[kind]}に変更しました`, 'ok');
      return;
    }
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (kind === 'shutter') {
      if (L - 160 < 1500) {
        toast('壁が短すぎます（シャッターは 1.6m 以上の壁に）');
        return;
      }
      pushUndo();
      applyShutterLayout(W().floor, w, autoShutterLayout(L));
      rebuild();
      draw();
      toast('シャッターを置きました（形はクリックして選べます: 1 台／2 台）', 'ok');
      return;
    }
    const spot = openingSpot(kind, w, t, true);
    if (!spot) {
      toast(L - 80 < 300 ? '壁が短すぎて置けません' : 'ほかの窓・ドアと重なります');
      return;
    }
    const f = W().floor;
    pushUndo();
    const op: Opening = { id: `${w.id}-U${++seq}`, wallId: w.id, kind, t0: spot.t0, t1: spot.t1, sill: 0, height: 2000, hingeAtStart: true, swingSide: 1, confidence: 1 };
    if (kind === 'window') applyWindowShape(op, L >= 1600 && spot.t1 - spot.t0 >= 1600 ? 'hakidashi' : 'koshi', f.ceilingHeight, L);
    // 1 階の外壁で外側に部屋が無い所に置いた開き戸は玄関ドア（外開き・庇付き）
    if (kind === 'door' && w.exterior && f.level === 1) {
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      const c = { x: w.a.x + ux * ((spot.t0 + spot.t1) / 2), y: w.a.y + uy * ((spot.t0 + spot.t1) / 2) };
      const out = (w.outsideSign ?? 1) * (w.thickness / 2 + 300);
      const q = { x: c.x - uy * out, y: c.y + ux * out };
      const outsideRoom = f.rooms.find((r) => pointInPolygon(q, r.polygon));
      if (!outsideRoom || outsideRoom.type === 'porch') {
        applyOpeningKind(op, 'entrance', f.ceilingHeight);
        toast('外に出る戸なので玄関ドア（外開き）にしました。種類はパネルで変えられます', 'ok', 3500);
      }
    }
    f.openings.push(op);
    sel = { kind: 'opening', id: op.id };
    rebuild();
    draw();
  };

  /**
   * 窓・戸を置く位置（壁の始点からの t0/t1）。中心を方眼（半間）の線に止め、既存の窓・戸と重ならない所へずらす。
   * プレビューと実際の配置で同じ計算を使う（カーソルが「止まる」のと同じ所に置かれる）
   */
  const openingSpot = (kind: 'window' | 'door' | 'sliding' | 'shutter', w: Wall, t: number, strict: boolean): { t0: number; t1: number; snapped: boolean } | null => {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const width = Math.min(OPENING_DEFAULT[kind], L - 80);
    if (width < 300) return null;
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    let tc = t;
    let snapped = false;
    const step = snapStep();
    if (step) {
      // 縦横の壁では、窓・戸の端か中心を方眼の線に合わせる（910 の柱間に掃き出し、455 ずれで戸）。近い方に止める
      const half = gridBase.size / 2;
      const along = Math.abs(uy) < 0.01 ? 'x' : Math.abs(ux) < 0.01 ? 'y' : null;
      if (along) {
        const base = along === 'x' ? w.a.x : w.a.y;
        const phase = along === 'x' ? gridBase.phaseX : gridBase.phaseY;
        const sgn = along === 'x' ? ux : uy;
        const toT = (coord: number) => (coord - base) * sgn;
        const abs = base + sgn * t;
        const cands = [toT(onGrid(abs, phase, half)), toT(onGrid(abs - (sgn * width) / 2, phase, half)) + width / 2, toT(onGrid(abs + (sgn * width) / 2, phase, half)) - width / 2];
        tc = cands.sort((p, q) => Math.abs(p - t) - Math.abs(q - t))[0];
        snapped = true;
      }
    }
    const t0 = Math.max(40, Math.min(L - 40 - width, tc - width / 2));
    const t1 = t0 + width;
    const f = W().floor;
    if (strict && f.openings.some((o) => o.wallId === w.id && o.t1 > t0 + 10 && o.t0 < t1 - 10)) return null;
    return { t0, t1, snapped };
  };

  // ---- 操作 ----
  let pan: { x: number; y: number; vb: typeof vb } | null = null;
  /** 壁の端点のドラッグ: 動かす端と、同じ点につながった他の壁の端、窓・戸の元の位置（絶対座標） */
  let endDrag: { moved: boolean; start: Vec2; ends: { w: Wall; end: 'a' | 'b' }[]; ops: { op: Opening; c0: Vec2; c1: Vec2 }[]; anchor: Vec2 } | null = null;
  /** 窓・戸を壁に沿って動かす（st = 掴んだ時の壁上の位置、ot0 = 元の t0） */
  let opDrag: { op: Opening; w: Wall; st: number; ot0: number; moved: boolean } | null = null;
  /** 壁を描く途中の数字入力（長さ mm）と、最後のカーソル位置（向きに使う） */
  let lenBuf = '';
  let lastCursor: Vec2 | null = null;
  /** 始点から p の向き（縦横に丸める）へ、長さ L の点 */
  const lengthPoint = (from: Vec2, toward: Vec2, L: number): Vec2 => {
    const dx = toward.x - from.x;
    const dy = toward.y - from.y;
    if (Math.abs(dx) >= Math.abs(dy)) return { x: from.x + Math.sign(dx || 1) * L, y: from.y };
    return { x: from.x, y: from.y + Math.sign(dy || 1) * L };
  };
  /** 壁に背を付ける家具 */
  const FURNITURE_WALL_KINDS = new Set<FurnitureKind>(['kitchen', 'cupboard', 'fridge', 'tv', 'bookshelf', 'desk', 'cabinet', 'sofa', 'bed', 'shoeCabinet', 'washstand', 'washer', 'toilet', 'mirror', 'nightstand', 'bath', 'builtin', 'hanger']);
  /** 点にいちばん近い壁の面（壁から room 側へ少し離した位置と、壁に沿う向き） */
  const nearestWallSpot = (f: Floor, p: Vec2, maxDist: number): { x: number; y: number; rot: number } | null => {
    let best: { d: number; q: Vec2; n: Vec2; t: number } | null = null;
    for (const w of f.walls) {
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
      const u = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
      const t = Math.max(0, Math.min(L, (p.x - w.a.x) * u.x + (p.y - w.a.y) * u.y));
      const q = { x: w.a.x + u.x * t, y: w.a.y + u.y * t };
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d > maxDist || (best && d >= best.d)) continue;
      let n = { x: -u.y, y: u.x };
      if ((p.x - q.x) * n.x + (p.y - q.y) * n.y < 0) n = { x: -n.x, y: -n.y };
      best = { d, q, n, t: w.thickness };
    }
    if (!best) return null;
    const off = best.t / 2 + 5;
    const along = { x: best.n.y, y: -best.n.x };
    return { x: Math.round(best.q.x + best.n.x * off), y: Math.round(best.q.y + best.n.y * off), rot: Math.round((Math.atan2(along.y, along.x) * 180) / Math.PI) };
  };
  let spaceDown = false;
  svg.addEventListener('contextmenu', (e) => e.preventDefault());
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = toMm(e);
    const k = Math.exp(e.deltaY * 0.0012);
    vb = { x: p.x - (p.x - vb.x) * k, y: p.y - (p.y - vb.y) * k, w: vb.w * k, h: vb.h * k };
    applyVb();
    draw();
  }, { passive: false });
  svg.addEventListener('pointerdown', (e) => {
    if (e.button === 2 || e.button === 1 || spaceDown) {
      if (e.button === 2 && tool === 'wall' && wallStart) {
        wallStart = null;
        while (gPreview.firstChild) gPreview.removeChild(gPreview.firstChild);
        return;
      }
      pan = { x: e.clientX, y: e.clientY, vb: { ...vb } };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    const p = toMm(e);
    if (tool === 'post') {
      const g = (e.target as SVGElement).closest('.pe-post') as SVGGElement | null;
      const f = W().floor;
      if (g?.dataset.id && f.posts?.some((x) => x.id === g.dataset.id)) {
        postSel = g.dataset.id;
        draw();
        return;
      }
      const q = snap(p, null, true, e.altKey).p;
      if (hasPostNear(f.posts, q, 60)) return;
      pushUndo();
      const kind: PostKind = postKind === 'toshi' && f.level !== 1 ? 'kuda' : postKind;
      const id = `F${f.level}-P${++seq}-${Math.round(q.x)}-${Math.round(q.y)}`;
      f.posts = [...(f.posts ?? []), { id, x: Math.round(q.x), y: Math.round(q.y), size: postSize, kind, ...(postRound ? { round: true } : {}) }];
      postSel = id;
      markChanged();
      draw();
      return;
    }
    if (tool === 'ceiling') {
      ceilDraw = { a: p, b: p };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === 'stairs') {
      const g = (e.target as SVGElement).closest('.pe-stair') as SVGGElement | null;
      if (g?.dataset.id) {
        stairSel = g.dataset.id;
        const st = W().floor.stairs.find((x) => x.id === stairSel);
        if (st) stairDrag = { id: st.id, sx: p.x, sy: p.y, ox: st.minX, oy: st.minY, moved: false };
        svg.setPointerCapture(e.pointerId);
        draw();
        return;
      }
      stairSel = null;
      const a = snap(p, null, true, e.altKey).p;
      stairDraw = { a, b: a };
      svg.setPointerCapture(e.pointerId);
      draw();
      return;
    }
    if (tool === 'furniture') {
      const level = W().floor.level;
      if (addKind) {
        pushUndo();
        const list = ensureExplicit(level);
        const id = `fu${++furnSeq}`;
        const defaults: Partial<FurnitureItem> = addKind === 'sofa' ? { w: 2.1 } : addKind === 'bed' ? { w: 1.4 } : addKind === 'tv' ? { w: 1.8 } : addKind === 'rug' ? { w: 2.2, d: 1.6 } : addKind === 'kitchen' ? { len: 2.7 } : addKind === 'bath' ? { len: 1.6 } : addKind === 'builtin' ? { variant: 'wallShelf' } : {};
        list.push({ id, kind: addKind, x: Math.round(p.x), y: Math.round(p.y), rot: 0, ...defaults });
        furnSel = id;
        addKind = null;
        markChanged();
        draw();
        return;
      }
      const g = (e.target as SVGElement).closest('.pe-furn') as SVGGElement | null;
      if (g?.dataset.id) {
        furnSel = g.dataset.id;
        const it = itemsOf(level).find((x) => x.id === furnSel);
        if (it) drag = { id: it.id, sx: p.x, sy: p.y, ox: it.x, oy: it.y, moved: false };
        svg.setPointerCapture(e.pointerId);
      } else furnSel = null;
      draw();
      return;
    }
    if (tool === 'select') {
      const t = e.target as SVGElement;
      if (t.classList.contains('pe-handle') && sel?.kind === 'wall') {
        const sw = W().floor.walls.find((x) => x.id === (sel as { id: string }).id);
        if (sw) {
          const end = t.dataset.end as 'a' | 'b';
          const start = { ...sw[end] };
          const ends: { w: Wall; end: 'a' | 'b' }[] = [];
          for (const w of W().floor.walls) for (const k of ['a', 'b'] as const) if (Math.hypot(w[k].x - start.x, w[k].y - start.y) < 5) ends.push({ w, end: k });
          const ops = W()
            .floor.openings.filter((o) => ends.some((x) => x.w.id === o.wallId))
            .map((op) => {
              const w = W().floor.walls.find((x) => x.id === op.wallId)!;
              const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
              const u = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
              return { op, c0: { x: w.a.x + u.x * op.t0, y: w.a.y + u.y * op.t0 }, c1: { x: w.a.x + u.x * op.t1, y: w.a.y + u.y * op.t1 } };
            });
          const other = end === 'a' ? sw.b : sw.a;
          endDrag = { moved: false, start, ends, ops, anchor: { ...other } };
          svg.setPointerCapture(e.pointerId);
          return;
        }
      }
      if (t.classList.contains('pe-label')) sel = { kind: 'label', index: +(t.dataset.index ?? -1) };
      else if (t.classList.contains('pe-op')) {
        sel = { kind: 'opening', id: t.dataset.id! };
        // 選んだ窓・戸はそのままドラッグで壁に沿って動かせる
        const op = W().floor.openings.find((o) => o.id === t.dataset.id);
        const w = op && W().floor.walls.find((x) => x.id === op.wallId);
        if (op && w) {
          const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
          const st = ((p.x - w.a.x) * (w.b.x - w.a.x) + (p.y - w.a.y) * (w.b.y - w.a.y)) / L;
          opDrag = { op, w, st, ot0: op.t0, moved: false };
          svg.setPointerCapture(e.pointerId);
        }
      } else if (t.classList.contains('pe-wall')) sel = { kind: 'wall', id: t.dataset.id! };
      else {
        const hit = wallAt(p);
        sel = hit ? { kind: 'wall', id: hit.w.id } : null;
      }
      draw();
    } else if (tool === 'wall') {
      const s = snap(p, wallStart, e.shiftKey, e.altKey).p;
      if (!wallStart) wallStart = s;
      else if (addWall(wallStart, s)) wallStart = s;
    } else if (tool === 'label') {
      pushUndo();
      W().labels.push({ name: '洋室', x: Math.round(p.x), y: Math.round(p.y) });
      sel = { kind: 'label', index: W().labels.length - 1 };
      tool = 'select';
      rebuild();
      draw();
    } else {
      addOpening(tool, p);
    }
  });
  svg.addEventListener('pointermove', (e) => {
    if (pan) {
      const k = mmPerPx();
      vb = { ...pan.vb, x: pan.vb.x - (e.clientX - pan.x) * k, y: pan.vb.y - (e.clientY - pan.y) * k };
      applyVb();
      return;
    }
    while (gPreview.firstChild) gPreview.removeChild(gPreview.firstChild);
    const p = toMm(e);
    const px = mmPerPx();
    if (endDrag) {
      if (!endDrag.moved && Math.hypot(p.x - endDrag.start.x, p.y - endDrag.start.y) < 3 * px) return;
      if (!endDrag.moved) {
        pushUndo();
        endDrag.moved = true;
      }
      // 自分の壁の向き（縦横）を保ったまま、格子・他の壁に吸着（Shift で斜め、Alt でフリー）。つながった壁の端は除いて吸着先を探す
      const moving = new Set(endDrag.ends.map((x) => x.w));
      const f = W().floor;
      const saved = f.walls;
      f.walls = saved.filter((w) => !moving.has(w));
      const s = snap(p, endDrag.anchor, e.shiftKey, e.altKey);
      f.walls = saved;
      for (const { w, end } of endDrag.ends) w[end] = { ...s.p };
      for (const { op, c0, c1 } of endDrag.ops) {
        const w = f.walls.find((x) => x.id === op.wallId)!;
        const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
        const u = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
        const proj = (c: Vec2) => (c.x - w.a.x) * u.x + (c.y - w.a.y) * u.y;
        const t0 = Math.max(0, Math.min(proj(c0), proj(c1)));
        const t1 = Math.min(L, Math.max(proj(c0), proj(c1)));
        op.t0 = t0;
        op.t1 = Math.max(t0, t1);
      }
      draw();
      const sw = f.walls.find((x) => sel?.kind === 'wall' && x.id === sel.id);
      if (sw) {
        const L = Math.hypot(sw.b.x - sw.a.x, sw.b.y - sw.a.y);
        const t = el('text', { x: (sw.a.x + sw.b.x) / 2, y: (sw.a.y + sw.b.y) / 2 - 14 * px, 'font-size': 12 * px, 'text-anchor': 'middle', fill: '#d9822b', stroke: '#fff', 'stroke-width': 3 * px, 'paint-order': 'stroke' }, gPreview);
        t.textContent = lenLabel(L);
      }
      status.textContent = s.hint ? `吸着: ${s.hint}（Alt を押している間はフリー）` : '';
      return;
    }
    if (stairDrag) {
      const dx = p.x - stairDrag.sx;
      const dy = p.y - stairDrag.sy;
      if (!stairDrag.moved && Math.hypot(dx, dy) < 3 * px) return;
      if (!stairDrag.moved) {
        pushUndo();
        stairDrag.moved = true;
      }
      const st = W().floor.stairs.find((x) => x.id === stairDrag!.id);
      if (st) {
        const w = st.maxX - st.minX;
        const d = st.maxY - st.minY;
        // 方眼の格子に乗せて動かす（Alt で自由に）
        const step = e.altKey ? null : snapStep();
        st.minX = step ? onGrid(stairDrag.ox + dx, gridBase.phaseX, step) : Math.round((stairDrag.ox + dx) / 10) * 10;
        st.minY = step ? onGrid(stairDrag.oy + dy, gridBase.phaseY, step) : Math.round((stairDrag.oy + dy) / 10) * 10;
        st.maxX = st.minX + w;
        st.maxY = st.minY + d;
        markChanged();
        draw();
      }
      return;
    }
    if (ceilDraw) {
      ceilDraw.b = p;
      const x = Math.min(ceilDraw.a.x, ceilDraw.b.x);
      const y = Math.min(ceilDraw.a.y, ceilDraw.b.y);
      const w = Math.abs(ceilDraw.b.x - ceilDraw.a.x);
      const d = Math.abs(ceilDraw.b.y - ceilDraw.a.y);
      el('rect', { x, y, width: w, height: d, fill: '#d9a066', 'fill-opacity': 0.2, stroke: '#b4762f', 'stroke-width': 3 * px, 'stroke-dasharray': `${12 * px} ${8 * px}` }, gPreview);
      status.textContent = `囲んだ部屋の天井高を ${ceilH} mm に`;
      return;
    }
    if (stairDraw) {
      const s2 = snap(p, null, true, e.altKey);
      stairDraw.b = s2.p;
      const x = Math.min(stairDraw.a.x, stairDraw.b.x);
      const y = Math.min(stairDraw.a.y, stairDraw.b.y);
      const w = Math.abs(stairDraw.b.x - stairDraw.a.x);
      const d = Math.abs(stairDraw.b.y - stairDraw.a.y);
      el('rect', { x, y, width: w, height: d, fill: '#d9822b', 'fill-opacity': 0.25, stroke: '#d9822b', 'stroke-width': 3 * px }, gPreview);
      const t = el('text', { x: x + w / 2, y: y - 8 * px, 'font-size': 12 * px, 'text-anchor': 'middle', fill: '#d9822b', stroke: '#fff', 'stroke-width': 3 * px, 'paint-order': 'stroke' }, gPreview);
      t.textContent = `${lenLabel(w)} × ${lenLabel(d)}`;
      status.textContent = s2.hint ? `吸着: ${s2.hint}` : '';
      return;
    }
    if (opDrag) {
      // 窓・戸を壁に沿って動かす: 端が方眼の線に止まる（Alt でフリー）
      const { op, w } = opDrag;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      const t = (p.x - w.a.x) * ux + (p.y - w.a.y) * uy;
      if (!opDrag.moved && Math.abs(t - opDrag.st) < 3 * px) return;
      if (!opDrag.moved) {
        pushUndo();
        opDrag.moved = true;
      }
      const wd = op.t1 - op.t0;
      let t0 = opDrag.ot0 + (t - opDrag.st);
      let hint = '';
      const step = e.altKey ? null : snapStep();
      if (step) {
        const along = Math.abs(uy) < 0.01 ? 'x' : Math.abs(ux) < 0.01 ? 'y' : null;
        if (along) {
          const base = along === 'x' ? w.a.x : w.a.y;
          const phase = along === 'x' ? gridBase.phaseX : gridBase.phaseY;
          const sgn = along === 'x' ? ux : uy;
          const toT = (coord: number) => (coord - base) * sgn;
          const c0 = toT(onGrid(base + sgn * t0, phase, step));
          const c1 = toT(onGrid(base + sgn * (t0 + wd), phase, step)) - wd;
          const c2 = toT(onGrid(base + sgn * (t0 + wd / 2), phase, step)) - wd / 2;
          const best = [c0, c1, c2].sort((a, b) => Math.abs(a - t0) - Math.abs(b - t0))[0];
          if (Math.abs(best - t0) < Math.min(14 * px, 300)) {
            t0 = best;
            hint = best === c0 ? '始点側の端が方眼' : best === c1 ? '終点側の端が方眼' : '中心が方眼';
          }
        }
      }
      t0 = Math.max(20, Math.min(L - 20 - wd, t0));
      // 他の窓・戸と重ならない
      const others = W().floor.openings.filter((o) => o.wallId === w.id && o.id !== op.id);
      if (!others.some((o) => o.t1 > t0 + 10 && o.t0 < t0 + wd - 10)) {
        op.t0 = t0;
        op.t1 = t0 + wd;
      }
      markChanged();
      draw();
      // 壁の両端からの寸法
      const a = { x: w.a.x + ux * op.t0, y: w.a.y + uy * op.t0 };
      const b = { x: w.a.x + ux * op.t1, y: w.a.y + uy * op.t1 };
      const dim = (q0: Vec2, q1: Vec2, text: string) => {
        el('line', { x1: q0.x, y1: q0.y, x2: q1.x, y2: q1.y, stroke: '#d9822b', 'stroke-width': 1.2 * px, 'stroke-dasharray': `${5 * px} ${3 * px}` }, gPreview);
        const t = el('text', { x: (q0.x + q1.x) / 2, y: (q0.y + q1.y) / 2 - 8 * px, 'font-size': 11 * px, 'text-anchor': 'middle', fill: '#d9822b', stroke: '#fff', 'stroke-width': 3 * px, 'paint-order': 'stroke' }, gPreview);
        t.textContent = text;
      };
      const off = { x: -uy * (w.thickness / 2 + 24 * px), y: ux * (w.thickness / 2 + 24 * px) };
      dim({ x: w.a.x + off.x, y: w.a.y + off.y }, { x: a.x + off.x, y: a.y + off.y }, lenLabel(op.t0));
      dim({ x: b.x + off.x, y: b.y + off.y }, { x: w.b.x + off.x, y: w.b.y + off.y }, lenLabel(L - op.t1));
      snapMark(hint ? a : b, hint ? '方眼' : '', px);
      status.textContent = `${OPENING_LABEL[op.kind]}を動かす${hint ? `・吸着: ${hint}` : ''}（Alt でフリー）`;
      return;
    }
    if (drag) {
      const dx = p.x - drag.sx;
      const dy = p.y - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 3 * px) return;
      if (!drag.moved) {
        pushUndo();
        drag.moved = true;
      }
      const list = ensureExplicit(W().floor.level);
      const it = list.find((x) => x.id === drag!.id);
      if (it) {
        let q: Vec2 = { x: Math.round((drag.ox + dx) / 10) * 10, y: Math.round((drag.oy + dy) / 10) * 10 };
        let hint = '';
        if (!e.altKey && snapMode !== 'free') {
          // 壁ぎわの家具は近くの壁に背を付ける（向きも壁に沿う）。それ以外は方眼の格子に止める
          const f = W().floor;
          const wallish = FURNITURE_WALL_KINDS.has(it.kind);
          const near = wallish ? nearestWallSpot(f, q, 600) : null;
          if (near) {
            q = { x: near.x, y: near.y };
            it.rot = near.rot;
            hint = '壁ぎわ';
          } else {
            const step = snapStep();
            if (step) {
              const gx = onGrid(q.x, gridBase.phaseX, step);
              const gy = onGrid(q.y, gridBase.phaseY, step);
              if (Math.hypot(gx - q.x, gy - q.y) < Math.min(12 * px, 250)) {
                q = { x: gx, y: gy };
                hint = '方眼';
              }
            }
          }
        }
        it.x = q.x;
        it.y = q.y;
        markChanged();
        draw();
        snapMark(q, hint === '壁ぎわ' ? '壁の上' : hint, px);
        status.textContent = `${FURNITURE_LABEL[it.kind]}を動かす${hint ? `・吸着: ${hint}` : ''}（Alt でフリー、R で回転）`;
      }
      return;
    }
    if (tool === 'wall') {
      const s = snap(p, wallStart, e.shiftKey, e.altKey);
      lastCursor = s.p;
      snapMark(s.p, s.hint, px);
      if (wallStart) {
        const end = lenBuf ? lengthPoint(wallStart, s.p, +lenBuf) : s.p;
        el('line', { x1: wallStart.x, y1: wallStart.y, x2: end.x, y2: end.y, stroke: '#d9822b', 'stroke-width': thickness, 'stroke-opacity': 0.6 }, gPreview);
        const L = Math.round(Math.hypot(end.x - wallStart.x, end.y - wallStart.y));
        const t = el('text', { x: (wallStart.x + end.x) / 2, y: (wallStart.y + end.y) / 2 - 10 * px, 'font-size': 12 * px, 'text-anchor': 'middle', fill: '#d9822b', stroke: '#fff', 'stroke-width': 3 * px, 'paint-order': 'stroke' }, gPreview);
        t.textContent = lenBuf ? `${lenBuf} mm ↵` : lenLabel(L);
      }
      status.textContent = lenBuf ? `長さ ${lenBuf} mm（Enter で確定・Esc で取り消し。向きはカーソルの方向）` : s.hint ? `吸着: ${s.hint}（Alt を押している間はフリー。${wallStart ? '数字を打つと長さで決められます' : '始点をクリック'}）` : e.altKey ? 'フリー（吸着なし）' : wallStart ? '終点をクリック（数字を打つと長さで決められます）' : '';
    } else if (tool === 'post') {
      const s = snap(p, null, true, e.altKey);
      const sz = Math.max(postSize, 6 * px);
      el('rect', { x: s.p.x - sz / 2, y: s.p.y - sz / 2, width: sz, height: sz, fill: '#d9822b', 'fill-opacity': 0.6 }, gPreview);
      snapMark(s.p, s.hint, px);
      status.textContent = `${W().floor.level}階に${POST_KIND_LABEL[postKind]}（${postSize}）を置く${s.hint ? `・吸着: ${s.hint}` : ''}`;
    } else if (tool === 'stairs' && !stairSel) {
      const s = snap(p, null, true, e.altKey);
      snapMark(s.p, s.hint, px);
      status.textContent = s.hint ? `吸着: ${s.hint}` : '';
    } else if (tool === 'window' || tool === 'door' || tool === 'sliding' || tool === 'shutter') {
      const hit = wallAt(p, 14);
      if (hit) {
        el('polygon', { points: wallPoly(hit.w), fill: 'none', stroke: '#d9822b', 'stroke-width': 2 * px, 'stroke-opacity': 0.5 }, gPreview);
        if (tool !== 'shutter') {
          // 置かれる位置と幅をその場に出す（カーソルは方眼の線に止まる）
          const spot = openingSpot(tool, hit.w, hit.t, false);
          if (spot) {
            const w = hit.w;
            const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
            const ux = (w.b.x - w.a.x) / L;
            const uy = (w.b.y - w.a.y) / L;
            const a = { x: w.a.x + ux * spot.t0, y: w.a.y + uy * spot.t0 };
            const b = { x: w.a.x + ux * spot.t1, y: w.a.y + uy * spot.t1 };
            const overlap = W().floor.openings.some((o) => o.wallId === w.id && o.t1 > spot.t0 + 10 && o.t0 < spot.t1 - 10);
            el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: overlap ? '#c0392b' : '#d9822b', 'stroke-width': w.thickness + 40, 'stroke-opacity': 0.55 }, gPreview);
            for (const q of [a, b]) snapMark(q, spot.snapped ? '方眼' : '', px);
            const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const t = el('text', { x: c.x, y: c.y - (w.thickness / 2 + 14 * px), 'font-size': 12 * px, 'text-anchor': 'middle', fill: overlap ? '#c0392b' : '#d9822b', stroke: '#fff', 'stroke-width': 3 * px, 'paint-order': 'stroke' }, gPreview);
            t.textContent = overlap ? 'ほかの窓・戸と重なる' : `${OPENING_LABEL[tool]} W${Math.round(spot.t1 - spot.t0).toLocaleString()}　始点から ${Math.round(spot.t0).toLocaleString()}`;
            status.textContent = `${OPENING_LABEL[tool]}を置く${spot.snapped ? '（方眼の線に止まっています）' : ''}`;
            return;
          }
        }
      }
      status.textContent = hit ? `${OPENING_LABEL[tool]}を置く` : '壁の上にカーソルを合わせてください';
    } else status.textContent = '';
  });
  svg.addEventListener('pointerup', () => {
    if (opDrag) {
      const d = opDrag;
      opDrag = null;
      if (d.moved) {
        markChanged();
        rebuild();
      }
      draw();
    }
    if (endDrag) {
      const d = endDrag;
      endDrag = null;
      if (d.moved) {
        // 長さが無くなった壁・窓は消す
        const f = W().floor;
        f.walls = f.walls.filter((w) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) >= 50);
        f.openings = f.openings.filter((o) => o.t1 - o.t0 >= 100 && f.walls.some((w) => w.id === o.wallId));
        markChanged();
        rebuild();
      }
      draw();
    }
    pan = null;
    drag = null;
    stairDrag = null;
    if (ceilDraw) {
      const { a, b } = ceilDraw;
      ceilDraw = null;
      while (gPreview.firstChild) gPreview.removeChild(gPreview.firstChild);
      const f = W().floor;
      const minX = Math.min(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxX = Math.max(a.x, b.x);
      const maxY = Math.max(a.y, b.y);
      const click = maxX - minX < 60 && maxY - minY < 60;
      let hit: RoomLabel[];
      if (click) {
        const room = f.rooms.find((r) => pointInPolygon(a, r.polygon));
        hit = room ? W().labels.filter((l) => pointInPolygon({ x: l.x, y: l.y }, room.polygon)) : [];
      } else hit = W().labels.filter((l) => l.x >= minX && l.x <= maxX && l.y >= minY && l.y <= maxY);
      // 屋外（中庭・バルコニー・ガレージなど）・吹抜には天井が無いので外す
      hit = hit.filter((l) => {
        const room = f.rooms.find((r) => pointInPolygon({ x: l.x, y: l.y }, r.polygon));
        return !room || !(OUTDOOR_TYPES.includes(room.type) || room.type === 'void' || room.type === 'stairs');
      });
      if (!hit.length) {
        toast('部屋名が入るように囲んでください（または部屋をクリック）');
        draw();
        return;
      }
      pushUndo();
      const allSame = hit.every((l) => l.ceilingHeight === ceilH);
      for (const l of hit) l.ceilingHeight = allSame ? undefined : ceilH;
      markChanged();
      rebuild();
      draw();
      toast(allSame ? `${hit.length} 室を階の天井高（${f.ceilingHeight} mm）に戻しました` : `${hit.length} 室の天井高を ${ceilH} mm にしました`, 'ok');
      return;
    }
    if (stairDraw) {
      const { a, b } = stairDraw;
      stairDraw = null;
      while (gPreview.firstChild) gPreview.removeChild(gPreview.firstChild);
      const minX = Math.round(Math.min(a.x, b.x));
      const minY = Math.round(Math.min(a.y, b.y));
      const maxX = Math.round(Math.max(a.x, b.x));
      const maxY = Math.round(Math.max(a.y, b.y));
      const w = maxX - minX;
      const d = maxY - minY;
      if (w < 500 || d < 500) {
        if (w > 60 || d > 60) toast('階段は 500mm 以上の大きさで描いてください');
        draw();
        return;
      }
      pushUndo();
      const f = W().floor;
      const level = f.level;
      // 種類の目安: ほぼ正方形なら折り返し、細長ければ直階段。昇り口は短い辺のうち、同じ位置に階段がある階が無ければ図面の下側
      const kind: Stair['kind'] = Math.max(w, d) / Math.min(w, d) < 1.5 ? 'u' : 'straight';
      const entry: Stair['entry'] = w >= d ? 'w' : 's';
      const below = works.find((o) => o.floor.level === level - 1);
      const hasBelow = !!below?.floor.stairs.some((t) => Math.abs(t.minX - minX) < 600 && Math.abs(t.minY - minY) < 600);
      let k = f.stairs.length + 1;
      while (f.stairs.some((t) => t.id === `F${level}-S${k}`)) k++;
      const id = `F${level}-S${k}`;
      f.stairs.push({ id, minX, minY, maxX, maxY, kind, entry, goesUp: !hasBelow });
      stairSel = id;
      markChanged();
      draw();
    }
  });
  const onKey = (e: KeyboardEvent) => {
    // 埋め込みで隠れている間（図面で見る）は効かせない
    if (!root.offsetParent) return;
    const tg = e.target as HTMLElement;
    if (e.key === ' ' && tg?.tagName === 'BUTTON') return;
    const typing = tg && (tg.tagName === 'INPUT' || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA');
    if (e.key === ' ' && !typing) {
      spaceDown = e.type === 'keydown';
      e.preventDefault();
      return;
    }
    if (e.type !== 'keydown' || typing) return;
    // 壁を描く途中の数字入力: 長さ（mm）を打って Enter で確定（CAD の「長さ入力」）
    if (tool === 'wall' && wallStart && (/^[0-9]$/.test(e.key) || (e.key === 'Backspace' && lenBuf) || (e.key === 'Enter' && lenBuf))) {
      e.preventDefault();
      if (e.key === 'Enter') {
        const L = +lenBuf;
        lenBuf = '';
        if (L >= 150 && lastCursor) {
          const end = lengthPoint(wallStart, lastCursor, L);
          if (addWall(wallStart, end)) wallStart = end;
        }
        draw();
        return;
      }
      lenBuf = e.key === 'Backspace' ? lenBuf.slice(0, -1) : (lenBuf + e.key).slice(0, 6);
      status.textContent = lenBuf ? `長さ ${lenBuf} mm（Enter で確定・Esc で取り消し。向きはカーソルの方向）` : '';
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && (sel || (tool === 'furniture' && furnSel) || (tool === 'stairs' && stairSel) || (tool === 'post' && postSel))) {
      e.preventDefault();
      deleteSel();
    } else if (e.key === 'Escape') {
      if (lenBuf) {
        lenBuf = '';
        draw();
        return;
      }
      wallStart = null;
      sel = null;
      addKind = null;
      stairSel = null;
      stairDraw = null;
      postSel = null;
      draw();
    } else if (tool === 'stairs' && stairSel && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      pushUndo();
      const st = W().floor.stairs.find((x) => x.id === stairSel);
      const order: Stair['entry'][] = ['n', 'e', 's', 'w'];
      if (st) st.entry = order[(order.indexOf(st.entry) + (e.shiftKey ? 3 : 1)) % 4];
      markChanged();
      draw();
    } else if (tool === 'furniture' && furnSel && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      pushUndo();
      const list = ensureExplicit(W().floor.level);
      const it = list.find((x) => x.id === furnSel);
      if (it) it.rot = ((it.rot + (e.shiftKey ? -90 : 90) + 540) % 360) - 180;
      markChanged();
      draw();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      doRedo();
    }
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  const doUndo = () => {
    const s = undo.pop();
    if (!s) return;
    redo.push(`${fi}|${snapshot()}`);
    restore(s);
  };
  const doRedo = () => {
    const s = redo.pop();
    if (!s) return;
    undo.push(`${fi}|${snapshot()}`);
    restore(s);
  };

  /** 精度評価用: 自動の読み取り結果と、手で直した正解を1つの JSON に */
  const saveTruth = () => {
    const strip = (f: Floor) => ({
      level: f.level,
      walls: f.walls.map((w) => ({ a: w.a, b: w.b, thickness: w.thickness, exterior: w.exterior })),
      openings: f.openings.map((o) => {
        const w = f.walls.find((x) => x.id === o.wallId);
        const L = w ? Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1 : 1;
        const t = (o.t0 + o.t1) / 2 / L;
        return { kind: o.kind, width: Math.round(o.t1 - o.t0), center: w ? { x: Math.round(w.a.x + (w.b.x - w.a.x) * t), y: Math.round(w.a.y + (w.b.y - w.a.y) * t) } : null };
      }),
      rooms: f.rooms.map((r) => ({ name: r.name, type: r.type, area: +r.area.toFixed(2), polygon: r.polygon.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) })),
    });
    const data = { format: 'madori-truth-v1', pdf: pdfName, savedAt: new Date().toISOString(), scale: model.report.scaleDenominator, auto: autoFloors.map(strip), truth: works.map((w) => strip(w.floor)) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pdfName || '間取り'}_正解データ.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('評価用データを保存しました（このファイルを送っていただければ精度の測定に使えます）', 'ok', 6000);
  };

  const close = (apply: boolean) => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
    root.remove();
    if (apply && changed) {
      works.forEach((w, i) => (model.floors[i] = w.floor));
      const fl = [...furn].filter(([, v]) => v).map(([level, v]) => ({ level, items: v! }));
      if (fl.length) model.furniture = fl;
      else delete model.furniture;
      learnSymbols(model, fl);
      onDone(true);
    } else onDone(false);
  };

  requestAnimationFrame(() => {
    fit();
    setTool('select');
  });

  return {
    el: root,
    saveTruth: () => saveTruth(),
    destroy() {
      if (commitTimer) commit();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      root.remove();
      if (changed) learnSymbols(model, [...furn].filter(([, v]) => v).map(([level, v]) => ({ level, items: v! })));
    },
    showLevel(level: number) {
      const i = works.findIndex((w) => w.floor.level === level);
      if (i < 0) return;
      fi = i;
      sel = null;
      wallStart = null;
      draw();
    },
  };
}


/**
 * 記号辞書に覚える: 手で直した家具が、図面の長方形（読み取りの候補）の上にあれば「この形はこの家具」と覚える。
 * 次に同じテンプレートの図面を読むとき、同じ形を同じ家具として読む
 */
function learnSymbols(model: BuildingModel, fl: { level: number; items: FurnitureItem[] }[]) {
  const dict = loadSymbolDict();
  let n = 0;
  for (const { level, items } of fl) {
    const f = model.floors.find((x) => x.level === level);
    if (!f?.symbolCandidates?.length) continue;
    for (const it of items) {
      // 家具の基準点（壁側の辺の中央）か、奥行の中心が候補の長方形（350mm の余裕）に入るもの
      const cand = f.symbolCandidates.find((c) => Math.abs(it.x - c.cx) <= c.w / 2 + 350 && Math.abs(it.y - c.cy) <= c.h / 2 + 350);
      if (!cand || cand.kind === it.kind) continue;
      const room = f.rooms.find((r) => r.id === cand.roomId);
      if (!room) continue;
      learnSymbol(dict, signatureOf(room.type, cand.w, cand.h, cand.inner), it.kind);
      n++;
    }
  }
  if (n) {
    saveSymbolDict(dict);
    (globalThis as { __symbolDict?: unknown }).__symbolDict = dict;
    toast(`図面の記号の読み方を ${n} 件覚えました（次の図面から同じ形を同じ家具として読みます）`, 'ok', 5000);
  }
}
