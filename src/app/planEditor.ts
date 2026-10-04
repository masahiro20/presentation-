/**
 * 間取りの手修正
 *
 * 図面の読み取りで壁が足りない・余分な所を、平面の上で直接直せるようにする。
 * - 壁を描く（端点・壁の線・縦横にそろえて吸着）／壁を消す
 * - 窓・ドア・引戸を壁に置く／消す
 * - 部屋名を置く・変える（用途も選べる）
 * 壁を直すたびに、図面の読み取りと同じ方法で部屋を作り直す。
 */
import type { BuildingModel, Floor, Opening, Room, RoomType, Vec2, Wall } from '../core/types';
import { ROOM_TYPE_LABEL } from '../core/types';
import { rebuildFloor, type RoomLabel } from '../parser/assemble';
import { pointInPolygon } from '../core/geometry';
import { h, clear, toast } from './dom';

type Tool = 'select' | 'wall' | 'window' | 'door' | 'sliding' | 'label';
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
};

const OPENING_DEFAULT: Record<'window' | 'door' | 'sliding', number> = { window: 1690, door: 780, sliding: 1640 };
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
  const undo: string[] = [];
  const redo: string[] = [];
  let seq = 0;

  const W = () => works[fi];
  const snapshot = () => JSON.stringify({ floor: W().floor, labels: W().labels, removed: W().removed });
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
    sel = null;
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
    ['select', '選択', '壁・窓・部屋名をクリックして選ぶ（Delete で削除）'],
    ['wall', '壁を描く', 'クリックで始点、もう一度クリックで終点。続けて描けます（Esc / 右クリックで終了、Shift で斜め）'],
    ['window', '窓', '壁をクリックすると窓を置きます'],
    ['door', '開き戸', '壁をクリックすると開き戸を置きます'],
    ['sliding', '引戸', '壁をクリックすると引戸を置きます'],
    ['label', '部屋名', '部屋の中をクリックして部屋名を置きます'],
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
  const applyVb = () => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
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

  // ---- 吸着 ----
  const snap = (p: Vec2, from: Vec2 | null, free: boolean): { p: Vec2; hint: string } => {
    const tol = 14 * mmPerPx();
    const f = W().floor;
    let best: { p: Vec2; d: number; hint: string } | null = null;
    for (const w of f.walls)
      for (const q of [w.a, w.b]) {
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
        break;
      }
    }
    // 他の壁の端と縦横をそろえる
    if (!hint) {
      for (const w of f.walls)
        for (const e of [w.a, w.b]) {
          if ((!from || Math.abs(q.y - from.y) > 1 || free) && Math.abs(e.x - q.x) < tol) q.x = e.x;
          if ((!from || Math.abs(q.x - from.x) > 1 || free) && Math.abs(e.y - q.y) < tol) q.y = e.y;
        }
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
    changed = true;
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
  const gWalls = document.createElementNS(NS, 'g');
  const gOps = document.createElementNS(NS, 'g');
  const gLabels = document.createElementNS(NS, 'g');
  const gPreview = document.createElementNS(NS, 'g');
  svg.append(gGhost, gRooms, gWalls, gOps, gLabels, gPreview);

  const wallPoly = (w: Wall) => {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const nx = (-(w.b.y - w.a.y) / L) * (w.thickness / 2);
    const ny = ((w.b.x - w.a.x) / L) * (w.thickness / 2);
    return `${w.a.x + nx},${w.a.y + ny} ${w.b.x + nx},${w.b.y + ny} ${w.b.x - nx},${w.b.y - ny} ${w.a.x - nx},${w.a.y - ny}`;
  };

  const draw = () => {
    for (const g of [gGhost, gRooms, gWalls, gOps, gLabels, gPreview]) while (g.firstChild) g.removeChild(g.firstChild);
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
    for (const w of f.walls) {
      const on = sel?.kind === 'wall' && sel.id === w.id;
      const p = el('polygon', { points: wallPoly(w), fill: on ? '#d9822b' : w.exterior ? '#1f2226' : '#3d424a', class: 'pe-wall' }, gWalls);
      p.dataset.id = w.id;
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

  const types = Object.keys(ROOM_TYPE_LABEL) as RoomType[];
  const renderPanel = () => {
    clear(panel);
    const f = W().floor;
    panel.append(h('h3', null, `${f.level}階の修正`));
    const tip = toolDefs.find((t) => t[0] === tool)![2];
    panel.append(h('p', { class: 'hint' }, tip));
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
            h('select', { onchange: (e: Event) => { pushUndo(); l.type = (e.target as HTMLSelectElement).value as RoomType; rebuild(); draw(); } }, types.map((t) => h('option', { value: t, selected: t === (l.type ?? room?.type) }, ROOM_TYPE_LABEL[t]))),
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
    svg.style.cursor = t === 'select' ? 'default' : 'crosshair';
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
    const t0 = Math.max(40, Math.min(L - 40 - width, t - width / 2));
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
    if (tool === 'select') {
      const t = e.target as SVGElement;
      if (t.classList.contains('pe-label')) sel = { kind: 'label', index: +(t.dataset.index ?? -1) };
      else if (t.classList.contains('pe-op')) sel = { kind: 'opening', id: t.dataset.id! };
      else if (t.classList.contains('pe-wall')) sel = { kind: 'wall', id: t.dataset.id! };
      else {
        const hit = wallAt(p);
        sel = hit ? { kind: 'wall', id: hit.w.id } : null;
      }
      draw();
    } else if (tool === 'wall') {
      const s = snap(p, wallStart, e.shiftKey).p;
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
    if (tool === 'wall') {
      const s = snap(p, wallStart, e.shiftKey);
      el('circle', { cx: s.p.x, cy: s.p.y, r: 5 * px, fill: s.hint ? '#d9822b' : '#22252a' }, gPreview);
      if (wallStart) {
        el('line', { x1: wallStart.x, y1: wallStart.y, x2: s.p.x, y2: s.p.y, stroke: '#d9822b', 'stroke-width': thickness, 'stroke-opacity': 0.6 }, gPreview);
        const L = Math.round(Math.hypot(s.p.x - wallStart.x, s.p.y - wallStart.y));
        const t = el('text', { x: (wallStart.x + s.p.x) / 2, y: (wallStart.y + s.p.y) / 2 - 10 * px, 'font-size': 12 * px, 'text-anchor': 'middle', fill: '#d9822b', stroke: '#fff', 'stroke-width': 3 * px, 'paint-order': 'stroke' }, gPreview);
        t.textContent = `${L}mm`;
      }
      status.textContent = s.hint ? `吸着: ${s.hint}` : '';
    } else if (tool === 'window' || tool === 'door' || tool === 'sliding') {
      const hit = wallAt(p, 14);
      if (hit) el('polygon', { points: wallPoly(hit.w), fill: 'none', stroke: '#d9822b', 'stroke-width': 4 * px }, gPreview);
      status.textContent = hit ? `${OPENING_LABEL[tool]}を置く` : '';
    } else status.textContent = '';
  });
  svg.addEventListener('pointerup', () => {
    pan = null;
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      e.preventDefault();
      deleteSel();
    } else if (e.key === 'Escape') {
      wallStart = null;
      sel = null;
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
      onDone(true);
    } else onDone(false);
  };

  requestAnimationFrame(() => {
    fit();
    setTool('select');
  });
}
