/**
 * 間取りの手修正
 *
 * 図面の読み取りで壁が足りない・余分な所を、平面の上で直接直せるようにする。
 * - 壁を描く（端点・壁の線・縦横にそろえて吸着）／壁を消す
 * - 窓・ドア・引戸を壁に置く／消す
 * - 部屋名を置く・変える（用途も選べる）
 * 壁を直すたびに、図面の読み取りと同じ方法で部屋を作り直す。
 */
import type { BuildingModel, BuiltinVariant, Floor, FurnitureItem, FurnitureKind, Opening, Room, RoomType, Vec2, Wall } from '../core/types';
import { stairLayout, STAIR_KIND_LABEL, STAIR_ENTRY_LABEL, type StairPiece } from '../core/stairs';
import { furnitureSymbol } from './furnitureSymbols';
import type { Stair } from '../core/types';
import { buildFurniture, furnitureDims, FURNITURE_LABEL, BUILTIN_VARIANTS, KITCHEN_TYPES } from '../scene/furniture';
import { rebuildFloor, type RoomLabel } from '../parser/assemble';
import { pointInPolygon } from '../core/geometry';
import { loadSymbolDict, saveSymbolDict, learnSymbol, signatureOf } from '../parser/symbolDict';
import { h, clear, toast, useSelect } from './dom';
import { useValueOf, applyUseValue } from '../core/roomUse';
import { chooseModule } from '../parser/module';

type Tool = 'select' | 'wall' | 'window' | 'door' | 'sliding' | 'label' | 'furniture' | 'stairs';
type Sel = { kind: 'wall'; id: string } | { kind: 'opening'; id: string } | { kind: 'label'; index: number } | null;

interface FloorWork {
  floor: Floor;
  labels: RoomLabel[];
  removed: { a: Vec2; b: Vec2 }[];
  original: Room[];
}

const ROOM_TINT: Partial<Record<RoomType, string>> = {
  ldk: '#f3e6d6', living: '#f3e6d6', dining: '#f3e6d6', kitchen: '#f3e6d6', japanese: '#e6ead2', bedroom: '#e3e9f1', kids: '#e3eef0', study: '#ece6f1',
  bath: '#dfeaf2', washroom: '#dfeaf2', toilet: '#dfeaf2', entrance: '#e8e3dc', hall: '#efece6', storage: '#ebe7e0', closet: '#ebe7e0', stairs: '#e9e9e9', void: '#f7f7f7', balcony: '#e5e8e2', porch: '#e5e8e2',
  garage: '#dcdcd8', carport: '#e0e0dc', parking: '#e0e0dc', deck: '#eadfce', terrace: '#e6e2da', shed: '#e2ddd4',
};

const OPENING_DEFAULT: Record<'window' | 'door' | 'sliding', number> = { window: 1690, door: 780, sliding: 1640 };
/** 窓の形（腰高と高さ。天井付けの高窓は天井高から決める） */
const WINDOW_SHAPES = {
  hakidashi: { label: '掃き出し（床から天井まで）', sill: () => 0, height: (ch: number) => ch },
  koshi: { label: '腰窓', sill: () => 900, height: (ch: number) => ch - 900 },
  small: { label: '小窓（浴室・トイレなど、曇りガラス）', sill: () => 1400, height: () => 600 },
  high: { label: '高窓（天井付け・横長）', sill: (ch: number) => ch - 500, height: () => 500 },
  slit: { label: '縦スリット（細長・床から天井）', sill: () => 0, height: (ch: number) => ch },
} as const;

const OPENING_LABEL: Record<string, string> = { window: '窓', door: '開き戸', sliding: '引戸', entrance: '玄関ドア', open: '開口' };

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export function openPlanEditor(host: HTMLElement, model: BuildingModel, onDone: (changed: boolean) => void, pdfName = '') {
  const autoFloors = clone(model.floors);
  const works: FloorWork[] = model.floors.map((f) => ({
    floor: clone(f),
    labels: f.rooms.filter((r) => r.type !== 'stairs').map((r) => ({ name: r.name, x: r.labelPos.x, y: r.labelPos.y })),
    removed: [],
    original: clone(f.rooms),
  }));
  let fi = 0;
  let tool: Tool = 'select';
  let sel: Sel = null;
  let changed = false;
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
  let stairDrag: { id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
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
    draw();
  };

  // ---- 画面 ----
  const root = h('div', { class: 'pe-root' });
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
    ['label', '部屋名', '部屋の中をクリックして部屋名を置きます'],
    ['furniture', '家具', '家具をドラッグで移動、R キーで回転（矢印が部屋側・手前）、Delete で削除。右の一覧から追加できます。キッチンは型・コンロ・冷蔵庫・フードを選べます'],
    ['stairs', '階段', '空いている所をドラッグして階段の範囲を描きます。既存の階段はクリックで選び、ドラッグで移動、R キーで昇り口を回転、Delete で削除'],
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
    h('button', { class: 'btn sm ghost', title: '読み取り精度の評価用に、自動の読み取り結果と、直した正解の間取りを1つのファイルに保存します', onclick: () => saveTruth() }, '評価用に保存'),
    h('button', { class: 'btn sm ghost', onclick: () => close(false) }, 'やめる'),
    h('button', { class: 'btn sm primary', onclick: () => close(true) }, '修正を反映する'),
  );
  root.append(bar, h('div', { class: 'pe-body' }, h('div', { class: 'pe-canvas' }, svg, status), panel));
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
      { step: half, color: '#f0ece5' },
      { step: gridBase.size, color: '#e4dfd6' },
      { step: gridBase.size * 4, color: '#d5cfc4' },
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
    changed = true;
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
  svg.append(gGrid, gGhost, gRooms, gStairs, gFurn, gWalls, gOps, gLabels, gPreviewStatic, gPreview);

  const wallPoly = (w: Wall) => {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const nx = (-(w.b.y - w.a.y) / L) * (w.thickness / 2);
    const ny = ((w.b.x - w.a.x) / L) * (w.thickness / 2);
    return `${w.a.x + nx},${w.a.y + ny} ${w.b.x + nx},${w.b.y + ny} ${w.b.x - nx},${w.b.y - ny} ${w.a.x - nx},${w.a.y - ny}`;
  };

  const draw = () => {
    for (const g of [gGhost, gRooms, gStairs, gFurn, gWalls, gOps, gLabels, gPreviewStatic, gPreview]) while (g.firstChild) g.removeChild(g.firstChild);
    const f = W().floor;
    const fs = Math.max(120, Math.min(320, 13 * mmPerPx()));
    // 他の階（位置合わせの目安）
    for (const o of works)
      if (o !== W())
        for (const w of o.floor.walls) el('polygon', { points: wallPoly(w), fill: '#c9cdd3', 'fill-opacity': 0.35 }, gGhost);
    for (const r of f.rooms) {
      el('polygon', { points: r.polygon.map((p) => `${p.x},${p.y}`).join(' '), fill: ROOM_TINT[r.type] ?? '#efece6', stroke: '#fff', 'stroke-width': 20 }, gRooms);
      const a = el('text', { x: r.labelPos.x, y: r.labelPos.y + fs * 1.15, 'font-size': fs * 0.75, 'text-anchor': 'middle', fill: '#8b8f96' }, gRooms);
      a.textContent = `${(r.labeledTatami ?? r.area / 1.62).toFixed(1)}帖`;
    }
    // 階段（段割り・昇る向き）
    const stairMode = tool === 'stairs';
    const drawStair = (st: Stair, parent: Element, on: boolean, ghost = false) => {
      const lay = stairLayout(st, 14);
      const g = el('g', { class: 'pe-stair', 'pointer-events': stairMode && !ghost ? 'auto' : 'none', opacity: ghost ? 0.7 : stairMode ? 1 : 0.75 }, parent) as SVGGElement;
      g.dataset.id = st.id;
      el('rect', { x: st.minX, y: st.minY, width: st.maxX - st.minX, height: st.maxY - st.minY, fill: on ? '#f3c89a' : '#e9e6df', stroke: on ? '#d9822b' : '#8b8f96', 'stroke-width': on ? 30 : 14 }, g);
      for (const q of lay.pieces) el('rect', { x: q.minX, y: q.minY, width: q.maxX - q.minX, height: q.maxY - q.minY, fill: q.kind === 'landing' ? '#ddd8cf' : 'none', stroke: '#9a9a9a', 'stroke-width': 8, 'pointer-events': 'none' }, g);
      const cs = lay.pieces.map((q: StairPiece) => `${(q.minX + q.maxX) / 2},${(q.minY + q.maxY) / 2}`);
      if (cs.length > 1) el('polyline', { points: cs.join(' '), fill: 'none', stroke: '#6d7178', 'stroke-width': 14, 'pointer-events': 'none' }, g);
      const last = lay.pieces[lay.pieces.length - 1];
      if (last) {
        const cx = (last.minX + last.maxX) / 2;
        const cy = (last.minY + last.maxY) / 2;
        const d = last.dir;
        el('polygon', { points: `${cx + d.x * 180},${cy + d.y * 180} ${cx - d.y * 100},${cy + d.x * 100} ${cx + d.y * 100},${cy - d.x * 100}`, fill: '#6d7178', 'pointer-events': 'none' }, g);
      }
      const first = lay.pieces[0];
      if (first) {
        const t = el('text', { x: (first.minX + first.maxX) / 2, y: (first.minY + first.maxY) / 2 + fs * 0.3, 'font-size': fs * 0.7, 'text-anchor': 'middle', fill: '#4a4e55', 'pointer-events': 'none', 'font-weight': 600 }, g);
        t.textContent = st.goesUp ? 'UP' : 'DN';
      }
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
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      const a = { x: w.a.x + ux * op.t0, y: w.a.y + uy * op.t0 };
      const b = { x: w.a.x + ux * op.t1, y: w.a.y + uy * op.t1 };
      const on = sel?.kind === 'opening' && sel.id === op.id;
      const col = on ? '#d9822b' : op.kind === 'window' ? '#4a90c2' : op.kind === 'sliding' ? '#5aa36f' : op.kind === 'open' ? '#bbb' : '#c46a3a';
      const line = el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: col, 'stroke-width': w.thickness + 30, 'stroke-linecap': 'butt', class: 'pe-op' }, gOps);
      line.dataset.id = op.id;
      el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: '#fff', 'stroke-width': Math.max(14, w.thickness * 0.25), 'pointer-events': 'none' }, gOps);
    }
    W().labels.forEach((l, i) => {
      const on = sel?.kind === 'label' && sel.index === i;
      const t = el('text', { x: l.x, y: l.y, 'font-size': fs, 'text-anchor': 'middle', fill: on ? '#d9822b' : '#22252a', 'font-weight': 600, class: 'pe-label', stroke: '#fff', 'stroke-width': fs * 0.2, 'paint-order': 'stroke' }, gLabels);
      t.textContent = l.name;
      (t as SVGElement).dataset.index = String(i);
    });
    renderPanel();
    renderTabs();
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
    panel.append(h('h3', null, `${f.level}階の修正`));
    const tip = toolDefs.find((t) => t[0] === tool)![2];
    panel.append(h('p', { class: 'hint' }, tip));
    if (tool === 'stairs') {
      const st = stairSel ? f.stairs.find((x) => x.id === stairSel) : null;
      if (st) {
        const edit = (fn: (x: Stair) => void) => {
          pushUndo();
          const x = W().floor.stairs.find((q) => q.id === st.id);
          if (x) fn(x);
          changed = true;
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
                h('option', { value: 'left', selected: (st.turn ?? (st.kind === 'u' ? 'left' : 'right')) === 'left' }, '左'),
                h('option', { value: 'right', selected: (st.turn ?? (st.kind === 'u' ? 'left' : 'right')) === 'right' }, '右'),
              ]),
            ),
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
          changed = true;
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
        if (it.kind === 'cupboard')
          panel.append(
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, '幅 (m)'), h('input', { type: 'number', step: 0.1, min: 0.6, max: 4, value: it.w ?? 1.8, onchange: (e: Event) => edit((x) => (x.w = +(e.target as HTMLInputElement).value)) })),
          );
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
        h('button', { class: 'btn sm ghost block', disabled: !ex, onclick: () => { pushUndo(); furn.set(level, null); autoCache = null; furnSel = null; changed = true; draw(); } }, '自動配置に戻す（この階）'),
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
        panel.append(
          h('div', { class: 'field-label' }, `${OPENING_LABEL[op.kind]}（幅 ${Math.round(op.t1 - op.t0)}mm）`),
          h(
            'label',
            { class: 'field' },
            h('span', { class: 'field-label' }, '種類'),
            h('select', { onchange: (e: Event) => { pushUndo(); op.kind = (e.target as HTMLSelectElement).value as Opening['kind']; rebuild(); draw(); } }, (['window', 'door', 'sliding', 'entrance', 'open'] as const).map((k) => h('option', { value: k, selected: k === op.kind }, OPENING_LABEL[k]))),
          ),
          ...(op.kind === 'window'
            ? [h(
                'label',
                { class: 'field' },
                h('span', { class: 'field-label' }, '窓の形'),
                h(
                  'select',
                  {
                    onchange: (e: Event) => {
                      const v = (e.target as HTMLSelectElement).value as keyof typeof WINDOW_SHAPES;
                      pushUndo();
                      const sh = WINDOW_SHAPES[v];
                      op.windowStyle = v;
                      op.sill = sh.sill(f.ceilingHeight);
                      op.height = sh.height(f.ceilingHeight);
                      if (v === 'slit' && op.t1 - op.t0 > 450) {
                        // 縦スリットは幅 300mm に絞る（中心はそのまま）
                        const c = (op.t0 + op.t1) / 2;
                        op.t0 = c - 150;
                        op.t1 = c + 150;
                      }
                      rebuild();
                      draw();
                    },
                  },
                  (Object.keys(WINDOW_SHAPES) as (keyof typeof WINDOW_SHAPES)[]).map((k) => h('option', { value: k, selected: k === (op.windowStyle ?? 'koshi') }, WINDOW_SHAPES[k].label)),
                ),
                h('span', { class: 'hint' }, '腰高・高さは標準仕様（サッシ上端＝天井）に合わせて 3D に反映'),
              )]
            : []),
          h(
            'label',
            { class: 'field' },
            h('span', { class: 'field-label' }, '幅 (mm)'),
            h('input', {
              type: 'number',
              value: Math.round(op.t1 - op.t0),
              step: 10,
              onchange: (e: Event) => {
                const w = f.walls.find((x) => x.id === op.wallId);
                if (!w) return;
                pushUndo();
                const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
                const c = (op.t0 + op.t1) / 2;
                const half = Math.min(L - 40, +(e.target as HTMLInputElement).value) / 2;
                op.t0 = Math.max(20, c - half);
                op.t1 = Math.min(L - 20, op.t0 + half * 2);
                rebuild();
                draw();
              },
            }),
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
          h('button', { class: 'btn sm block', onclick: () => deleteSel() }, 'この部屋名を消す（Delete）'),
        );
        setTimeout(() => input.focus(), 0);
      }
    }
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

  const deleteSel = () => {
    if (tool === 'stairs') {
      if (!stairSel) return;
      pushUndo();
      const f = W().floor;
      f.stairs = f.stairs.filter((x) => x.id !== stairSel);
      stairSel = null;
      changed = true;
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
      changed = true;
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

  const addOpening = (kind: 'window' | 'door' | 'sliding', p: Vec2) => {
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
      existing.kind = kind;
      if (kind === 'window') {
        existing.sill = 900;
        existing.height = 1100;
      } else {
        existing.sill = 0;
        existing.height = 2000;
      }
      sel = { kind: 'opening', id: existing.id };
      rebuild();
      draw();
      toast(`${OPENING_LABEL[kind]}に変更しました`, 'ok');
      return;
    }
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const width = Math.min(OPENING_DEFAULT[kind], L - 80);
    if (width < 300) {
      toast('壁が短すぎて置けません');
      return;
    }
    // 縦横の壁では、窓・戸の中心を方眼（半間）の線に合わせる（910 の柱間に掃き出し、455 ずれで戸）
    let tc = t;
    const step = snapStep();
    if (step) {
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      const half = gridBase.size / 2;
      if (Math.abs(uy) < 0.01) tc = (onGrid(w.a.x + ux * t, gridBase.phaseX, half) - w.a.x) * ux;
      else if (Math.abs(ux) < 0.01) tc = (onGrid(w.a.y + uy * t, gridBase.phaseY, half) - w.a.y) * uy;
    }
    const t0 = Math.max(40, Math.min(L - 40 - width, tc - width / 2));
    const t1 = t0 + width;
    const f = W().floor;
    if (f.openings.some((o) => o.wallId === w.id && o.t1 > t0 + 10 && o.t0 < t1 - 10)) {
      toast('ほかの窓・ドアと重なります');
      return;
    }
    pushUndo();
    f.openings.push({ id: `${w.id}-U${++seq}`, wallId: w.id, kind, t0, t1, sill: kind === 'window' ? 900 : 0, height: kind === 'window' ? 1100 : 2000, hingeAtStart: true, swingSide: 1, confidence: 1 });
    rebuild();
    draw();
  };

  // ---- 操作 ----
  let pan: { x: number; y: number; vb: typeof vb } | null = null;
  /** 壁の端点のドラッグ: 動かす端と、同じ点につながった他の壁の端、窓・戸の元の位置（絶対座標） */
  let endDrag: { moved: boolean; start: Vec2; ends: { w: Wall; end: 'a' | 'b' }[]; ops: { op: Opening; c0: Vec2; c1: Vec2 }[]; anchor: Vec2 } | null = null;
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
        changed = true;
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
      else if (t.classList.contains('pe-op')) sel = { kind: 'opening', id: t.dataset.id! };
      else if (t.classList.contains('pe-wall')) sel = { kind: 'wall', id: t.dataset.id! };
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
        changed = true;
        draw();
      }
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
        it.x = Math.round((drag.ox + dx) / 10) * 10;
        it.y = Math.round((drag.oy + dy) / 10) * 10;
        changed = true;
        draw();
      }
      return;
    }
    if (tool === 'wall') {
      const s = snap(p, wallStart, e.shiftKey, e.altKey);
      // 吸着した点の目印（十字）
      el('line', { x1: s.p.x - 14 * px, y1: s.p.y, x2: s.p.x + 14 * px, y2: s.p.y, stroke: '#d9822b', 'stroke-width': 1.2 * px }, gPreview);
      el('line', { x1: s.p.x, y1: s.p.y - 14 * px, x2: s.p.x, y2: s.p.y + 14 * px, stroke: '#d9822b', 'stroke-width': 1.2 * px }, gPreview);
      el('circle', { cx: s.p.x, cy: s.p.y, r: 4 * px, fill: s.hint ? '#d9822b' : '#22252a' }, gPreview);
      if (wallStart) {
        el('line', { x1: wallStart.x, y1: wallStart.y, x2: s.p.x, y2: s.p.y, stroke: '#d9822b', 'stroke-width': thickness, 'stroke-opacity': 0.6 }, gPreview);
        const L = Math.round(Math.hypot(s.p.x - wallStart.x, s.p.y - wallStart.y));
        const t = el('text', { x: (wallStart.x + s.p.x) / 2, y: (wallStart.y + s.p.y) / 2 - 10 * px, 'font-size': 12 * px, 'text-anchor': 'middle', fill: '#d9822b', stroke: '#fff', 'stroke-width': 3 * px, 'paint-order': 'stroke' }, gPreview);
        t.textContent = lenLabel(L);
      }
      status.textContent = s.hint ? `吸着: ${s.hint}（Alt を押している間はフリー）` : e.altKey ? 'フリー（吸着なし）' : '';
    } else if (tool === 'stairs' && !stairSel) {
      const s = snap(p, null, true, e.altKey);
      el('line', { x1: s.p.x - 14 * px, y1: s.p.y, x2: s.p.x + 14 * px, y2: s.p.y, stroke: '#d9822b', 'stroke-width': 1.2 * px }, gPreview);
      el('line', { x1: s.p.x, y1: s.p.y - 14 * px, x2: s.p.x, y2: s.p.y + 14 * px, stroke: '#d9822b', 'stroke-width': 1.2 * px }, gPreview);
      status.textContent = s.hint ? `吸着: ${s.hint}` : '';
    } else if (tool === 'window' || tool === 'door' || tool === 'sliding') {
      const hit = wallAt(p, 14);
      if (hit) el('polygon', { points: wallPoly(hit.w), fill: 'none', stroke: '#d9822b', 'stroke-width': 4 * px }, gPreview);
      status.textContent = hit ? `${OPENING_LABEL[tool]}を置く` : '';
    } else status.textContent = '';
  });
  svg.addEventListener('pointerup', () => {
    if (endDrag) {
      const d = endDrag;
      endDrag = null;
      if (d.moved) {
        // 長さが無くなった壁・窓は消す
        const f = W().floor;
        f.walls = f.walls.filter((w) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) >= 50);
        f.openings = f.openings.filter((o) => o.t1 - o.t0 >= 100 && f.walls.some((w) => w.id === o.wallId));
        changed = true;
        rebuild();
      }
      draw();
    }
    pan = null;
    drag = null;
    stairDrag = null;
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
      changed = true;
      draw();
    }
  });
  const onKey = (e: KeyboardEvent) => {
    const tg = e.target as HTMLElement;
    const typing = tg && (tg.tagName === 'INPUT' || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA');
    if (e.key === ' ' && !typing) {
      spaceDown = e.type === 'keydown';
      e.preventDefault();
      return;
    }
    if (e.type !== 'keydown' || typing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && (sel || (tool === 'furniture' && furnSel) || (tool === 'stairs' && stairSel))) {
      e.preventDefault();
      deleteSel();
    } else if (e.key === 'Escape') {
      wallStart = null;
      sel = null;
      addKind = null;
      stairSel = null;
      stairDraw = null;
      draw();
    } else if (tool === 'stairs' && stairSel && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      pushUndo();
      const st = W().floor.stairs.find((x) => x.id === stairSel);
      const order: Stair['entry'][] = ['n', 'e', 's', 'w'];
      if (st) st.entry = order[(order.indexOf(st.entry) + (e.shiftKey ? 3 : 1)) % 4];
      changed = true;
      draw();
    } else if (tool === 'furniture' && furnSel && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      pushUndo();
      const list = ensureExplicit(W().floor.level);
      const it = list.find((x) => x.id === furnSel);
      if (it) it.rot = ((it.rot + (e.shiftKey ? -90 : 90) + 540) % 360) - 180;
      changed = true;
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
