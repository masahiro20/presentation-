/**
 * 3D 画面で外構の物を置く道具: 植栽（庭木・低木）・フェンス・車・BBQ グリル・ベンチ・自転車・物置・ポスト・プランター・庭園灯。
 * 右の操作バーの「外構」で開く。地面をクリック → 置く、置いた物をクリック → 選んで回す・大きさを変える・消す。
 * 置いた物は model.exteriorItems に入り、平面図・体験リンク・保存ファイルにも載る（外構だけ作り直すので速い）。
 */
import * as THREE from 'three';
import type { BuildingModel, ExteriorItem, ExteriorKind } from '../core/types';
import { EXTERIOR_DEFAULTS, EXTERIOR_LABEL, exteriorFootprint } from '../scene/exteriorItems';
import type { Viewer } from '../scene/viewer';
import { h, clear, toast } from './dom';
import { state } from './state';

const ORDER: ExteriorKind[] = ['tree', 'shrub', 'fence', 'car', 'bbq', 'bench', 'bicycle', 'shed', 'post', 'planter', 'light'];

export function createExteriorTool(v: Viewer, host: HTMLElement, onModelEdited: () => void, onActivate?: () => void) {
  const panel = h('div', { class: 'furn-tool', hidden: true });
  host.appendChild(panel);
  let active = false;
  let sel: string | null = null;
  let add: ExteriorKind | null = null;
  let moving = false;
  let seq = 0;

  const model = () => state.model as BuildingModel | null;
  const items = (): ExteriorItem[] => {
    const m = model();
    if (!m) return [];
    return (m.exteriorItems ??= []);
  };
  const selected = () => items().find((x) => x.id === sel) ?? null;
  const commit = () => {
    const m = model();
    if (!m) return;
    if (m.exteriorItems && !m.exteriorItems.length) delete m.exteriorItems;
    v.rebuildLandscape(m);
    onModelEdited();
    render();
  };
  const editSel = (fn: (x: ExteriorItem) => void) => {
    const it = selected();
    if (!it) return;
    fn(it);
    commit();
  };
  /** 点（mm）にある物（外形の中。フェンスは線の近く） */
  const itemAt = (p: { x: number; y: number }): ExteriorItem | null => {
    let best: { it: ExteriorItem; d: number } | null = null;
    for (const it of items()) {
      const fp = exteriorFootprint(it);
      const r = (it.rot * Math.PI) / 180;
      const dx = (p.x - it.x) / 1000;
      const dy = (p.y - it.y) / 1000;
      const u = dx * Math.cos(r) + dy * Math.sin(r);
      const w = -dx * Math.sin(r) + dy * Math.cos(r);
      let d: number;
      if (fp.r) d = Math.hypot(dx, dy) - fp.r;
      else if (it.kind === 'fence') d = u < 0 || u > fp.w ? Math.min(Math.hypot(dx, dy), Math.hypot(u - fp.w, w)) : Math.abs(w) - 0.3;
      else d = Math.max(Math.abs(u) - fp.w / 2, Math.abs(w) - fp.d / 2);
      if (d < 0.35 && (!best || d < best.d)) best = { it, d };
    }
    return best?.it ?? null;
  };
  /** 建物の正面（道路）の向きに合わせた既定の向き（車は道路へ頭を向ける、フェンスは敷地の辺に沿う） */
  const defaultRot = (kind: ExteriorKind): number => {
    const road = v.state?.site.roadDir;
    if (!road) return 0;
    const a = (Math.atan2(road.z, road.x) * 180) / Math.PI;
    if (kind === 'car') return Math.round(a);
    if (kind === 'fence' || kind === 'bench') return Math.round(a + 90);
    return 0;
  };

  const onPick = (pt: THREE.Vector3, ndc?: THREE.Vector2) => {
    const p = { x: Math.round(pt.x * 1000), y: Math.round(pt.z * 1000) };
    if (add || (moving && sel)) {
      if (add) {
        const kind = add;
        const d = EXTERIOR_DEFAULTS[kind];
        const id = `x${Date.now().toString(36)}${++seq}`;
        items().push({ id, kind, x: p.x, y: p.y, rot: defaultRot(kind), ...(d.h ? { h: d.h } : {}), ...(d.len ? { len: d.len } : {}) });
        sel = id;
        add = null;
        toast(`${EXTERIOR_LABEL[kind]}を置きました。向き・大きさはパネルで変えられます`, 'ok', 2500);
      } else {
        const it = selected();
        if (it) {
          it.x = p.x;
          it.y = p.y;
        }
        moving = false;
      }
      commit();
      return;
    }
    // 見ている物を優先: 外構の物でない物（家具・窓・壁・床）をクリックしたら、その物の道具へ
    if (ndc && v.onPickIdle) {
      const hit = v.pickHit(ndc);
      if (hit && hit.group !== 'landscape' && hit.group !== 'ground' && v.onPickIdle(hit, ndc)) return;
    }
    const it = itemAt(p);
    sel = it ? it.id : null;
    render();
  };
  /** 道具を開いていないときのクリック: その点に置いた物があれば道具を開いて選ぶ */
  const pickHere = (pt: THREE.Vector3): boolean => {
    const it = itemAt({ x: Math.round(pt.x * 1000), y: Math.round(pt.z * 1000) });
    if (!it) return false;
    if (!active) setActive(true);
    sel = it.id;
    add = null;
    moving = false;
    render();
    return true;
  };

  const num = (label: string, value: number, step: number, min: number, max: number, set: (x: ExteriorItem, v: number) => void) =>
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('input', { type: 'number', step, min, max, value: +value.toFixed(2), onchange: (e: Event) => editSel((x) => set(x, +(e.target as HTMLInputElement).value)) }));

  function render() {
    clear(panel);
    panel.hidden = !active;
    if (!active) return;
    panel.append(
      h('div', { class: 'furn-head' }, h('strong', null, '外構に置く'), h('button', { class: 'btn sm ghost', onclick: () => setActive(false) }, '閉じる')),
      h('p', { class: 'hint' }, add ? `「${EXTERIOR_LABEL[add]}」: 置きたい地面をクリック` : moving ? '移す先の地面をクリック' : '置いた物をクリックして選ぶ／下から選んで地面をクリックで置く'),
    );
    const it = selected();
    if (it) {
      const fp = exteriorFootprint(it);
      const box = h('div', { class: 'furn-sel' }, h('div', { class: 'field-label' }, EXTERIOR_LABEL[it.kind]));
      box.append(
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn sm', onclick: () => editSel((x) => (x.rot = ((x.rot - 45 + 540) % 360) - 180)) }, '↶ 45°'),
          h('button', { class: 'btn sm', onclick: () => editSel((x) => (x.rot = ((x.rot + 45 + 540) % 360) - 180)) }, '↷ 45°'),
          h('button', { class: `btn sm ${moving ? 'dark' : ''}`, onclick: () => { moving = !moving; add = null; render(); } }, '移す'),
        ),
      );
      if (it.kind === 'tree') box.append(num('高さ (m)', it.h ?? 3.6, 0.2, 1.8, 7, (x, val) => (x.h = val)));
      if (it.kind === 'fence') box.append(num('長さ (m)', it.len ?? 3, 0.5, 0.5, 20, (x, val) => (x.len = val)), num('高さ (m)', it.h ?? 1.2, 0.1, 0.6, 2.2, (x, val) => (x.h = val)), h('p', { class: 'hint' }, '置いた点から向きの方へ伸びます。↶↷ で向き'));
      if (it.kind === 'shed') box.append(num('幅 (m)', it.len ?? 1.8, 0.1, 0.9, 3.6, (x, val) => (x.len = val)), num('高さ (m)', it.h ?? 2.1, 0.1, 1.5, 2.6, (x, val) => (x.h = val)));
      if (it.kind === 'bench' || it.kind === 'planter') box.append(num('幅 (m)', it.len ?? (it.kind === 'bench' ? 1.5 : 0.9), 0.1, 0.5, 4, (x, val) => (x.len = val)));
      if (it.kind === 'light') box.append(num('高さ (m)', it.h ?? 0.8, 0.1, 0.3, 3, (x, val) => (x.h = val)));
      box.append(
        h('p', { class: 'hint' }, fp.r ? `樹冠の半径 約 ${fp.r.toFixed(1)}m` : `${fp.w.toFixed(1)} × ${fp.d.toFixed(1)} m`),
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn sm', onclick: () => { const list = items(); const i = list.findIndex((q) => q.id === sel); if (i >= 0) list.splice(i, 1); sel = null; commit(); } }, '消す'),
          h('button', { class: 'btn sm ghost', onclick: () => { sel = null; moving = false; render(); } }, '選ぶのをやめる'),
        ),
      );
      panel.append(box);
    }
    panel.append(
      h('div', { class: 'field-label', style: 'margin-top:8px' }, '置く物'),
      h(
        'div',
        { class: 'chips' },
        ORDER.map((k) => h('button', { class: `btn sm ${add === k ? 'dark' : 'ghost'}`, onclick: () => { add = add === k ? null : k; moving = false; render(); } }, EXTERIOR_LABEL[k].replace(/（.*$/, ''))),
      ),
      h('p', { class: 'hint', style: 'margin-top:8px' }, '御社の外構の定番: 砂利に飛び石、株立ちの木を 2〜3 本、ブロック＋木ルーバーの塀。自動の植栽に足す形で置けます'),
    );
    const n = items().length;
    if (n) panel.append(h('button', { class: 'btn sm ghost block', style: 'margin-top:10px', onclick: () => { const m = model(); if (!m) return; delete m.exteriorItems; sel = null; commit(); } }, `置いた物をすべて消す（${n}）`));
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

  const btn = h('button', { class: 'nav-btn', title: '外構に置く（植栽・フェンス・車・BBQ・ベンチ・自転車・物置・ポスト・庭園灯）\n地面をクリックで置く、物をクリックで選ぶ', onclick: () => setActive(!active) }, h('span', { class: 'ic' }, '🌳'), '外構');
  return { button: btn, setActive, isActive: () => active, pickHere };
}
