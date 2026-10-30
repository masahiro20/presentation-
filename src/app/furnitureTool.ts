/**
 * 3D 画面で家具・造作を置き直す道具（パースを見ながら「造作本棚をここに」「キッチンを Ⅱ 型に」）。
 * 右の操作バーの「家具」で開く。床をクリック → 置く、家具をクリック → 選んで型・形・幅・向きを変える。
 * 置き直した階は手配置（model.furniture）になり、平面図・見積（キッチンの型）にもつながる。
 */
import * as THREE from 'three';
import type { BuildingModel, BuiltinVariant, Floor, FurnitureItem, FurnitureKind, Vec2 } from '../core/types';
import { distPointSegment, pointInPolygon } from '../core/geometry';
import { BUILTIN_VARIANTS, FURNITURE_LABEL, KITCHEN_TYPES, furnitureDims, furnitureItems } from '../scene/furniture';
import type { Viewer } from '../scene/viewer';
import { h, clear, toast } from './dom';
import { state } from './state';

/** 壁に背を付けて置く家具（それ以外はクリックした点が中心） */
const WALL_KINDS = new Set<FurnitureKind>(['kitchen', 'cupboard', 'fridge', 'tv', 'bookshelf', 'desk', 'cabinet', 'sofa', 'bed', 'shoeCabinet', 'washstand', 'washer', 'toilet', 'mirror', 'nightstand', 'bath', 'builtin']);

/** 追加できる家具（造作は形ごとに並べる） */
const ADD_FURNITURE: FurnitureKind[] = ['sofa', 'dining', 'tv', 'rug', 'coffeeTable', 'desk', 'bookshelf', 'cupboard', 'bed', 'plant', 'chair', 'lowTable'];

interface Add {
  kind: FurnitureKind;
  variant?: BuiltinVariant;
  kitchenType?: FurnitureItem['kitchenType'];
}

export function createFurnitureTool(v: Viewer, host: HTMLElement, onModelEdited: () => void, onActivate?: () => void) {
  const panel = h('div', { class: 'furn-tool', hidden: true });
  host.appendChild(panel);
  let active = false;
  let sel: { level: number; id: string } | null = null;
  let add: Add | null = null;
  let moving = false;

  const model = () => state.model as BuildingModel | null;
  const floorAt = (y: number): Floor | null => {
    const m = model();
    if (!m) return null;
    const fs = m.floors.slice().sort((a, b) => a.elevation - b.elevation);
    let f: Floor | null = fs[0] ?? null;
    for (const x of fs) if (x.elevation / 1000 <= y + 0.3) f = x;
    return f;
  };
  const itemsOf = (level: number): FurnitureItem[] => {
    const m = model()!;
    const ex = m.furniture?.find((o) => o.level === level);
    if (ex) return ex.items;
    return furnitureItems(m).get(level) ?? [];
  };
  /** 手配置の階にする（自動配置の結果を初期値に） */
  const explicit = (level: number): FurnitureItem[] => {
    const m = model()!;
    let ex = m.furniture?.find((o) => o.level === level);
    if (!ex) {
      ex = { level, items: itemsOf(level).map((it) => ({ ...it })) };
      m.furniture = [...(m.furniture ?? []), ex];
    }
    return ex.items;
  };
  const commit = () => {
    const m = model();
    if (!m) return;
    v.rebuildFurniture(m);
    onModelEdited();
    render();
  };
  const selected = (): FurnitureItem | null => (sel ? itemsOf(sel.level).find((x) => x.id === sel!.id) ?? null : null);
  const editSel = (fn: (x: FurnitureItem) => void) => {
    if (!sel) return;
    const x = explicit(sel.level).find((q) => q.id === sel!.id);
    if (!x) return;
    fn(x);
    commit();
  };

  /** 点（mm）に最も近い壁に背を付ける位置と向き */
  const snapToWall = (f: Floor, p: Vec2): { x: number; y: number; rot: number } | null => {
    let best: { d: number; q: Vec2; n: Vec2; t: number } | null = null;
    for (const w of f.walls) {
      const d = distPointSegment(p, w.a, w.b);
      if (d > 2500 || (best && d >= best.d)) continue;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
      const u = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
      const t = Math.max(0, Math.min(L, (p.x - w.a.x) * u.x + (p.y - w.a.y) * u.y));
      const q = { x: w.a.x + u.x * t, y: w.a.y + u.y * t };
      let n = { x: -u.y, y: u.x };
      if ((p.x - q.x) * n.x + (p.y - q.y) * n.y < 0) n = { x: -n.x, y: -n.y };
      best = { d, q, n, t: w.thickness };
    }
    if (!best) return null;
    const off = best.t / 2 + 5;
    // Frame の向き: along = (cos r, sin r)、inward = (-sin r, cos r)。inward を壁から部屋側へ
    const along = { x: best.n.y, y: -best.n.x };
    return { x: Math.round(best.q.x + best.n.x * off), y: Math.round(best.q.y + best.n.y * off), rot: Math.round((Math.atan2(along.y, along.x) * 180) / Math.PI) };
  };
  /** 点（mm）にある家具（足元の外形の中。小さい物を優先） */
  const itemAt = (level: number, p: Vec2): FurnitureItem | null => {
    let best: { it: FurnitureItem; a: number } | null = null;
    for (const it of itemsOf(level)) {
      const { w, d, v0 } = furnitureDims(it);
      const r = (it.rot * Math.PI) / 180;
      const dx = (p.x - it.x) / 1000;
      const dy = (p.y - it.y) / 1000;
      const u = dx * Math.cos(r) + dy * Math.sin(r);
      const vv = -dx * Math.sin(r) + dy * Math.cos(r);
      if (Math.abs(u) <= w / 2 + 0.08 && vv >= v0 - 0.08 && vv <= v0 + d + 0.08) {
        const a = w * d;
        if (!best || a < best.a) best = { it, a };
      }
    }
    return best?.it ?? null;
  };

  const onPick = (pt: THREE.Vector3) => {
    const f = floorAt(pt.y);
    if (!f) return;
    const p = { x: pt.x * 1000, y: pt.z * 1000 };
    const room = f.rooms.find((r) => pointInPolygon(p, r.polygon));
    if (add || (moving && sel)) {
      const kind = add ? add.kind : selected()?.kind;
      if (!kind) return;
      const wallish = WALL_KINDS.has(kind);
      const snap = wallish ? snapToWall(f, p) : null;
      const pos = snap ?? { x: Math.round(p.x), y: Math.round(p.y), rot: snapToWall(f, p)?.rot ?? 0 };
      if (add) {
        const list = explicit(f.level);
        const id = `u${Date.now().toString(36)}`;
        const defaults: Partial<FurnitureItem> = kind === 'builtin' ? { variant: add.variant ?? 'wallShelf' } : kind === 'kitchen' ? { len: 2.7, kitchenType: add.kitchenType ?? 'peninsula' } : kind === 'sofa' ? { w: 2.1 } : kind === 'tv' ? { w: 1.8 } : kind === 'rug' ? { w: 2.2, d: 1.6 } : {};
        list.push({ id, kind, ...pos, roomId: room?.id, ...defaults });
        sel = { level: f.level, id };
        add = null;
        toast(`${labelOf(list[list.length - 1])}を置きました。向き・幅はパネルで変えられます`, 'ok', 2500);
      } else if (sel) {
        const s = sel;
        const x = explicit(s.level).find((q) => q.id === s.id);
        if (x) Object.assign(x, pos, { roomId: room?.id ?? x.roomId });
        moving = false;
      }
      commit();
      return;
    }
    const it = itemAt(f.level, p);
    sel = it ? { level: f.level, id: it.id } : null;
    render();
  };

  const labelOf = (it: FurnitureItem) => (it.kind === 'builtin' ? BUILTIN_VARIANTS[it.variant ?? 'wallShelf'].label : FURNITURE_LABEL[it.kind]);
  const num = (label: string, value: number, step: number, min: number, max: number, set: (x: FurnitureItem, v: number) => void) =>
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('input', { type: 'number', step, min, max, value: +value.toFixed(2), onchange: (e: Event) => editSel((x) => set(x, +(e.target as HTMLInputElement).value)) }));
  const pick = <T extends string>(label: string, opts: [T, string][], cur: T, set: (x: FurnitureItem, v: T) => void) =>
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('select', { onchange: (e: Event) => editSel((x) => set(x, (e.target as HTMLSelectElement).value as T)) }, opts.map(([val, l]) => h('option', { value: val, selected: val === cur }, l))));

  function render() {
    clear(panel);
    panel.hidden = !active;
    if (!active) return;
    panel.append(
      h('div', { class: 'furn-head' }, h('strong', null, '家具・造作'), h('button', { class: 'btn sm ghost', onclick: () => setActive(false) }, '閉じる')),
      h('p', { class: 'hint' }, add ? `「${add.kind === 'builtin' ? BUILTIN_VARIANTS[add.variant ?? 'wallShelf'].label : add.kind === 'kitchen' ? `キッチン（${KITCHEN_TYPES.find((k) => k[0] === add!.kitchenType)?.[1] ?? ''}）` : FURNITURE_LABEL[add.kind]}」: 置きたい壁ぎわの床をクリック` : moving ? '移す先の床をクリック（壁ぎわの家具は壁に付きます）' : '家具をクリックして選ぶ／下から選んで床をクリックで置く'),
    );
    const it = selected();
    if (it) {
      const box = h('div', { class: 'furn-sel' }, h('div', { class: 'field-label' }, labelOf(it)));
      box.append(
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn sm', onclick: () => editSel((x) => (x.rot = ((x.rot - 90 + 540) % 360) - 180)) }, '↶ 90°'),
          h('button', { class: 'btn sm', onclick: () => editSel((x) => (x.rot = ((x.rot + 90 + 540) % 360) - 180)) }, '↷ 90°'),
          h('button', { class: `btn sm ${moving ? 'dark' : ''}`, onclick: () => { moving = !moving; add = null; render(); } }, '移す'),
        ),
      );
      if (it.kind === 'kitchen') {
        box.append(
          pick('キッチンの型', KITCHEN_TYPES, it.kitchenType ?? 'peninsula', (x, val) => (x.kitchenType = val)),
          pick('コンロの位置（部屋側から見て）', [['right', '右'], ['left', '左']], it.stoveSide ?? 'right', (x, val) => (x.stoveSide = val)),
          pick('冷蔵庫', [['right', '右端'], ['left', '左端'], ['none', '置かない']], it.fridge ?? 'right', (x, val) => (x.fridge = val)),
          pick('レンジフード', [['on', 'あり'], ['off', 'なし']], it.hood === false ? 'off' : 'on', (x, val) => (x.hood = val === 'on')),
          num('長さ (m)', it.len ?? 3, 0.1, 1.5, 6, (x, val) => (x.len = val)),
        );
        if (it.kitchenType === 'l') box.append(num('袖の長さ (m)', it.d ?? 2.1, 0.1, 1.5, 2.8, (x, val) => (x.d = val)));
      }
      if (it.kind === 'builtin') {
        const b = BUILTIN_VARIANTS[it.variant ?? 'wallShelf'];
        box.append(
          pick('造作の形', (Object.keys(BUILTIN_VARIANTS) as BuiltinVariant[]).map((k) => [k, BUILTIN_VARIANTS[k].label] as [BuiltinVariant, string]), it.variant ?? 'wallShelf', (x, val) => { x.variant = val; delete x.w; delete x.d; }),
          num('幅 (m)', it.w ?? b.w, 0.1, 0.4, 6, (x, val) => (x.w = val)),
          num('奥行 (m)', it.d ?? b.d, 0.05, 0.15, 0.8, (x, val) => (x.d = val)),
          h('p', { class: 'hint' }, b.note),
        );
      }
      if (['sofa', 'bed', 'tv', 'rug', 'cupboard', 'dining'].includes(it.kind)) box.append(num('幅 (m)', furnitureDims(it).w, 0.1, 0.6, 4, (x, val) => (x.w = val)));
      box.append(
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn sm', onclick: () => { const s = sel!; const list = explicit(s.level); const i = list.findIndex((q) => q.id === s.id); if (i >= 0) list.splice(i, 1); sel = null; commit(); } }, '消す'),
          h('button', { class: 'btn sm ghost', onclick: () => { sel = null; moving = false; render(); } }, '選ぶのをやめる'),
        ),
      );
      panel.append(box);
    }
    const chip = (label: string, a: Add) =>
      h('button', { class: `btn sm ${add && add.kind === a.kind && add.variant === a.variant && add.kitchenType === a.kitchenType ? 'dark' : 'ghost'}`, onclick: () => { add = add && add.kind === a.kind && add.variant === a.variant && add.kitchenType === a.kitchenType ? null : a; moving = false; render(); } }, label);
    panel.append(
      h('div', { class: 'field-label', style: 'margin-top:8px' }, '造作家具を置く'),
      h('div', { class: 'chips' }, (Object.keys(BUILTIN_VARIANTS) as BuiltinVariant[]).map((k) => chip(BUILTIN_VARIANTS[k].label.replace(/（.*$/, ''), { kind: 'builtin', variant: k }))),
      h('div', { class: 'field-label', style: 'margin-top:8px' }, 'キッチンを置く'),
      h('div', { class: 'chips' }, KITCHEN_TYPES.map(([k, l]) => chip(l.replace(/（.*$/, ''), { kind: 'kitchen', kitchenType: k }))),
      h('div', { class: 'field-label', style: 'margin-top:8px' }, '家具を置く'),
      h('div', { class: 'chips' }, ADD_FURNITURE.map((k) => chip(FURNITURE_LABEL[k], { kind: k }))),
    );
    const m = model();
    const manual = (m?.furniture ?? []).map((o) => o.level);
    if (manual.length)
      panel.append(
        h('button', { class: 'btn sm ghost block', style: 'margin-top:10px', onclick: () => { const mm = model(); if (!mm) return; mm.furniture = []; sel = null; commit(); } }, '自動配置に戻す（すべての階）'),
      );
  }

  function setActive(on: boolean) {
    active = on;
    if (on) onActivate?.();
    v.onPick = on ? onPick : null;
    if (!on) {
      sel = null;
      add = null;
      moving = false;
    }
    render();
    btn.classList.toggle('on', on);
  }

  const btn = h('button', { class: 'nav-btn', title: '家具・造作（パースを見ながら造作本棚を置く、キッチンの型を変える）\n床をクリックで置く、家具をクリックで選ぶ', onclick: () => setActive(!active) }, h('span', { class: 'ic' }, '▦'), '家具');
  return { button: btn, setActive, isActive: () => active };
}
