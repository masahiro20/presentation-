/**
 * 3D 画面のまま直す（パースを見ながら）:
 *  - 天井高: 部屋の床をクリックして選び（複数可）、その部屋だけの天井高を決める（LDK と水まわりだけ 3,500 など）
 *  - シャッター: ガレージの外壁をクリックして、その壁いっぱいのシャッターを置く（もう一度クリックで外す）
 * 方眼の修正画面（planEditor）にも同じ道具がある。ここは「見ながら」用。
 */
import * as THREE from 'three';
import { h, clear, toast } from './dom';
import { state } from './state';
import type { Viewer } from '../scene/viewer';
import { pointInPolygon } from '../core/geometry';
import { OUTDOOR_TYPES, type BuildingModel, type Floor, type Opening, type Wall } from '../core/types';
import { SHUTTER_LAYOUTS, applyShutterLayout, autoShutterLayout, shutterLayoutOf } from '../core/shutter';
import { OPENING_LABEL, OPENING_DEFAULT, OPENING_KINDS, WINDOW_SHAPES, applyWindowShape, applyOpeningKind, setOpeningWidth, flipHinge, flipSwing, openingSummary, isSlidingWindow, clampToWall } from '../core/openings';

export function createEditTool3d(v: Viewer, host: HTMLElement, onModelEdited: () => void, onActivate?: () => void) {
  const panel = h('div', { class: 'furn-tool edit3d', hidden: true });
  host.appendChild(panel);
  let active = false;
  let mode: 'ceiling' | 'shutter' | 'opening' = 'opening';
  let ceilH = 3500;
  const selected = new Set<string>();
  /** シャッター: 最後に触った壁（形を選び直す対象） */
  let lastShutter: { level: number; wallId: string } | null = null;
  /** 窓・戸: 選んだ開口。無い所をクリックしたときは「ここに置く」候補（壁と位置） */
  let opSel: { level: number; id: string } | null = null;
  let opSpot: { level: number; wallId: string; t: number } | null = null;
  const overlay = new THREE.Group();
  overlay.name = 'edit3d-overlay';
  v.scene.add(overlay);

  const model = () => state.model as BuildingModel | null;
  const floorAt = (y: number): Floor | null => {
    const m = model();
    if (!m) return null;
    const fs = m.floors.slice().sort((a, b) => a.elevation - b.elevation);
    let f: Floor | null = fs[0] ?? null;
    for (const x of fs) if (x.elevation / 1000 <= y + 0.3) f = x;
    return f;
  };
  const roomsSelected = () => {
    const m = model();
    const out: { f: Floor; r: Floor['rooms'][number] }[] = [];
    if (!m) return out;
    for (const f of m.floors) for (const r of f.rooms) if (selected.has(r.id)) out.push({ f, r });
    return out;
  };

  /** 選んだ部屋の床にオレンジの面を重ねる */
  const paintOverlay = () => {
    for (const c of [...overlay.children]) {
      overlay.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    for (const { f, r } of roomsSelected()) {
      const shape = new THREE.Shape(r.polygon.map((p) => new THREE.Vector2(p.x / 1000, -p.y / 1000)));
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#d9822b', transparent: true, opacity: 0.35, depthWrite: false }));
      mesh.position.y = f.elevation / 1000 + 0.03;
      mesh.userData.noShadow = true;
      overlay.add(mesh);
    }
    v.invalidate();
  };

  const commit = () => {
    onModelEdited();
    render();
  };

  const onPick = (pt0: THREE.Vector3, ndc?: THREE.Vector2) => {
    // 天井高: 屋根越しに見ているときは、その下の床の点を使う（屋根の点では隣の部屋になる）
    const pt = mode === 'ceiling' && ndc ? (v.pickFloorPoint(ndc) ?? pt0) : pt0;
    const f = floorAt(pt.y);
    if (!f) return;
    const p = { x: pt.x * 1000, y: pt.z * 1000 };
    if (mode === 'ceiling') {
      const room = f.rooms.find((r) => pointInPolygon(p, r.polygon));
      if (!room) {
        toast('部屋の床をクリックしてください');
        return;
      }
      if (OUTDOOR_TYPES.includes(room.type) || room.type === 'void' || room.type === 'stairs') {
        toast(`${room.name || room.type} には天井がありません`);
        return;
      }
      if (selected.has(room.id)) selected.delete(room.id);
      else selected.add(room.id);
      paintOverlay();
      render();
      return;
    }
    if (mode === 'opening') {
      // 窓・戸: クリックした点にいちばん近い壁の、その位置の開口を選ぶ。無ければ「ここに置く」
      let near: { w: Wall; d: number; t: number } | null = null;
      for (const w of f.walls) {
        const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
        const ux = (w.b.x - w.a.x) / L;
        const uy = (w.b.y - w.a.y) / L;
        const t = Math.max(0, Math.min(L, (p.x - w.a.x) * ux + (p.y - w.a.y) * uy));
        const d = Math.hypot(p.x - (w.a.x + ux * t), p.y - (w.a.y + uy * t));
        if (d < 500 && (!near || d < near.d)) near = { w, d, t };
      }
      if (!near) {
        toast('窓・戸のある壁をクリックしてください');
        return;
      }
      const ops = f.openings.filter((o) => o.wallId === near!.w.id);
      const hit = ops.find((o) => near!.t >= o.t0 - 150 && near!.t <= o.t1 + 150) ?? ops.sort((a, b) => Math.abs((a.t0 + a.t1) / 2 - near!.t) - Math.abs((b.t0 + b.t1) / 2 - near!.t)).find((o) => Math.abs((o.t0 + o.t1) / 2 - near!.t) < 900);
      if (hit) {
        opSel = { level: f.level, id: hit.id };
        opSpot = null;
        toast(`${OPENING_LABEL[hit.kind]}を選びました: ${openingSummary(hit)}`, 'ok', 3000);
      } else {
        opSel = null;
        opSpot = { level: f.level, wallId: near.w.id, t: near.t };
      }
      render();
      return;
    }
    // シャッター: クリックした点にいちばん近い外壁
    let best: { w: Wall; d: number; t: number; L: number } | null = null;
    for (const w of f.walls) {
      if (!w.exterior) continue;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      const t = Math.max(0, Math.min(L, (p.x - w.a.x) * ux + (p.y - w.a.y) * uy));
      const q = { x: w.a.x + ux * t, y: w.a.y + uy * t };
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < 450 && (!best || d < best.d)) best = { w, d, t, L };
    }
    if (!best) {
      toast('外壁をクリックしてください（ガレージの道路側の壁）');
      return;
    }
    const { w, t, L } = best;
    const ex = f.openings.find((o) => o.wallId === w.id && t >= o.t0 - 30 && t <= o.t1 + 30);
    if (ex?.kind === 'shutter') {
      f.openings = f.openings.filter((o) => !(o.wallId === w.id && o.kind === 'shutter'));
      lastShutter = null;
      toast('シャッターを外しました', 'ok');
    } else {
      if (L - 160 < 1500) {
        toast('壁が短すぎます（シャッターは 1.6m 以上の壁に）');
        return;
      }
      // 窓・戸の上なら、それを外してシャッターに
      if (ex) f.openings = f.openings.filter((o) => o !== ex);
      applyShutterLayout(f, w, autoShutterLayout(L));
      lastShutter = { level: f.level, wallId: w.id };
      toast('シャッターを置きました（形は左のパネルで 1 台／2 台を選べます）', 'ok');
    }
    commit();
  };

  const applyCeiling = () => {
    const rs = roomsSelected();
    if (!rs.length) {
      toast('部屋をクリックして選んでください');
      return;
    }
    for (const { f, r } of rs) {
      if (ceilH === f.ceilingHeight) delete r.ceilingHeight;
      else r.ceilingHeight = ceilH;
    }
    toast(`${rs.length} 室の天井高を ${ceilH} mm にしました`, 'ok');
    commit();
  };
  const resetCeiling = () => {
    const rs = roomsSelected();
    for (const { r } of rs) delete r.ceilingHeight;
    toast(`${rs.length} 室を階の天井高に戻しました`, 'ok');
    commit();
  };

  const render = () => {
    clear(panel);
    panel.hidden = !active;
    if (!active) return;
    const m = model();
    const modeBtn = (id: typeof mode, label: string) =>
      h(
        'button',
        {
          class: `btn sm ${mode === id ? 'dark' : 'ghost'}`,
          onclick: () => {
            mode = id;
            selected.clear();
            paintOverlay();
            render();
          },
        },
        label,
      );
    panel.append(h('div', { class: 'furn-head' }, h('span', null, '3D で直す'), h('button', { class: 'btn xs ghost', onclick: () => setActive(false) }, '閉じる')), h('div', { style: 'display:flex;gap:6px;margin:4px 0 8px' }, modeBtn('opening', '窓・戸'), modeBtn('ceiling', '天井高'), modeBtn('shutter', 'シャッター')));
    if (mode === 'opening') {
      renderOpening(m);
      return;
    }
    if (mode === 'ceiling') {
      const rs = roomsSelected();
      const custom = m ? m.floors.flatMap((f) => f.rooms.filter((r) => r.ceilingHeight).map((r) => `${f.level}階 ${r.name} ${r.ceilingHeight}`)) : [];
      panel.append(
        h('p', { class: 'hint', style: 'margin:0 0 6px' }, '部屋の床をクリックして選びます（複数可。もう一度で外す）。選んだ部屋だけの天井高になります。例: LDK と水まわりだけ 3,500。'),
        h('div', { class: 'furn-sel' }, rs.length ? rs.map(({ f, r }) => h('div', null, `${f.level}階 ${r.name || r.type}${r.ceilingHeight ? `（今 ${r.ceilingHeight}）` : ''}`)) : h('div', { class: 'hint' }, 'まだ選んでいません')),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '天井高 (mm)'), h('input', { type: 'number', step: 50, min: 2000, max: 6000, value: ceilH, onchange: (e: Event) => (ceilH = +(e.target as HTMLInputElement).value || 3500) })),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn sm primary', onclick: applyCeiling }, '選んだ部屋に適用'), ...(rs.some(({ r }) => r.ceilingHeight) ? [h('button', { class: 'btn sm ghost', onclick: resetCeiling }, '階の天井高に戻す')] : [])),
        ...(custom.length ? [h('p', { class: 'hint', style: 'margin-top:8px' }, `個別の天井高: ${custom.join('・')}`)] : []),
      );
    } else {
      const n = m ? m.floors.reduce((s, f) => s + f.openings.filter((o) => o.kind === 'shutter').length, 0) : 0;
      panel.append(h('p', { class: 'hint', style: 'margin:0' }, 'ガレージの外壁をクリック → シャッター。もう一度で外す。'), h('p', { class: 'hint' }, n ? `シャッター ${n} か所` : 'シャッターはまだありません'));
      const lf = lastShutter && m ? m.floors.find((f) => f.level === lastShutter!.level) : null;
      const lw = lf?.walls.find((x) => x.id === lastShutter!.wallId);
      if (lf && lw) {
        const cur = shutterLayoutOf(lf, lw.id);
        panel.append(
          h('div', { class: 'field-label', style: 'margin-top:8px' }, '形'),
          h(
            'div',
            { class: 'segmented' },
            ...SHUTTER_LAYOUTS.map((l) =>
              h(
                'button',
                {
                  class: cur === l.id ? 'on' : '',
                  title: l.hint,
                  onclick: () => {
                    applyShutterLayout(lf, lw, l.id);
                    commit();
                  },
                },
                l.label,
              ),
            ),
          ),
        );
      }
    }
  };

  /** 窓・戸のパネル: 選んだ開口の種類・形・幅・腰高・高さ・開き方。無い所をクリックしたら「ここに置く」 */
  const renderOpening = (m: BuildingModel | null) => {
    const f = m && opSel ? m.floors.find((x) => x.level === opSel!.level) : null;
    const op = f?.openings.find((o) => o.id === opSel!.id);
    panel.append(h('p', { class: 'hint', style: 'margin:0 0 6px' }, '窓・戸をクリックして選びます。パースを見ながら形（掃き出し／腰窓…）・幅・高さ・吊元を変えられます。何も無い壁をクリックすると、そこに置けます。'));
    if (op && f) {
      const wall = f.walls.find((x) => x.id === op.wallId);
      const wallLen = wall ? Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) : 10000;
      const change = (fn: () => void) => {
        fn();
        clampToWall(op, wallLen);
        commit();
      };
      const numField = (label: string, get: () => number, set: (v: number) => void, step = 10) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('input', { type: 'number', value: Math.round(get()), step, onchange: (e: Event) => change(() => set(+(e.target as HTMLInputElement).value)) }));
      panel.append(
        h('div', { class: 'furn-sel' }, h('div', { class: 'field-label' }, `${f.level}階 ${OPENING_LABEL[op.kind]}`), h('div', { class: 'hint' }, openingSummary(op))),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '種類'), h('select', { onchange: (e: Event) => change(() => applyOpeningKind(op, (e.target as HTMLSelectElement).value as Opening['kind'], f.ceilingHeight)) }, OPENING_KINDS.map((k) => h('option', { value: k, selected: k === op.kind }, OPENING_LABEL[k])))),
      );
      if (op.kind === 'window')
        panel.append(
          h('div', { class: 'field-label' }, '窓の形'),
          h('div', { class: 'segmented' }, ...(Object.keys(WINDOW_SHAPES) as (keyof typeof WINDOW_SHAPES)[]).map((k) => h('button', { class: (op.windowStyle ?? (isSlidingWindow(op) ? (op.sill === 0 ? 'hakidashi' : 'koshi') : 'small')) === k ? 'on' : '', title: WINDOW_SHAPES[k].label, onclick: () => change(() => applyWindowShape(op, k, f.ceilingHeight, wallLen)) }, WINDOW_SHAPES[k].short))),
          h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 8px' }, numField('腰高 (mm)', () => op.sill, (v) => (op.sill = Math.max(0, v)), 50), numField('高さ (mm)', () => op.height, (v) => (op.height = Math.max(200, v)), 50)),
        );
      if (op.kind === 'door' || op.kind === 'entrance')
        panel.append(
          h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => change(() => flipHinge(op)) }, '吊元を左右入れ替え'), op.kind === 'door' ? h('button', { class: 'btn sm', onclick: () => change(() => flipSwing(op)) }, '開く向きを反対側へ') : null),
        );
      if (op.kind === 'sliding')
        panel.append(
          h('div', { class: 'btn-row' }, op.t1 - op.t0 < 1200 ? h('button', { class: 'btn sm', onclick: () => change(() => flipHinge(op)) }, '引き込む側を入れ替え') : null, h('button', { class: 'btn sm', onclick: () => change(() => flipSwing(op)) }, '戸の面を反対側へ')),
        );
      panel.append(
        h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 8px' }, numField('幅 (mm)', () => op.t1 - op.t0, (v) => setOpeningWidth(op, v, wallLen)), numField('壁の始点から (mm)', () => op.t0, (v) => { const w0 = op.t1 - op.t0; op.t0 = Math.max(20, v); op.t1 = op.t0 + w0; }, 5)),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => { f.openings = f.openings.filter((o) => o.id !== op.id); opSel = null; commit(); } }, '消す'), h('button', { class: 'btn sm ghost', onclick: () => { opSel = null; render(); } }, '選ぶのをやめる')),
      );
      return;
    }
    if (opSpot && m) {
      const fl = m.floors.find((x) => x.level === opSpot!.level);
      const w = fl?.walls.find((x) => x.id === opSpot!.wallId);
      if (fl && w) {
        const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
        const put = (kind: 'window' | 'door' | 'sliding') => {
          const width = Math.min(OPENING_DEFAULT[kind], L - 80);
          if (width < 300) {
            toast('壁が短すぎて置けません');
            return;
          }
          const t0 = Math.max(40, Math.min(L - 40 - width, opSpot!.t - width / 2));
          if (fl.openings.some((o) => o.wallId === w.id && o.t1 > t0 + 10 && o.t0 < t0 + width - 10)) {
            toast('ほかの窓・戸と重なります');
            return;
          }
          const op: Opening = { id: `${w.id}-V${Date.now().toString(36)}`, wallId: w.id, kind, t0, t1: t0 + width, sill: 0, height: 2000, hingeAtStart: true, swingSide: 1, confidence: 1 };
          if (kind === 'window') applyWindowShape(op, w.exterior && width >= 1600 ? 'hakidashi' : 'koshi', fl.ceilingHeight, L);
          if (kind === 'door' && w.exterior && fl.level === 1) applyOpeningKind(op, 'entrance', fl.ceilingHeight);
          fl.openings.push(op);
          opSel = { level: fl.level, id: op.id };
          opSpot = null;
          commit();
        };
        panel.append(
          h('div', { class: 'furn-sel' }, h('div', { class: 'field-label' }, `${fl.level}階 ${w.exterior ? '外壁' : '内壁'}（長さ ${Math.round(L).toLocaleString()}）のここに置く`)),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => put('window') }, '窓'), h('button', { class: 'btn sm', onclick: () => put('door') }, w.exterior && fl.level === 1 ? '玄関ドア' : '開き戸'), h('button', { class: 'btn sm', onclick: () => put('sliding') }, '引戸')),
        );
      }
      return;
    }
    const n = m ? m.floors.reduce((s, f) => s + f.openings.length, 0) : 0;
    panel.append(h('p', { class: 'hint' }, n ? `窓・戸 ${n} か所` : '窓・戸はまだありません'));
  };

  function setActive(on: boolean) {
    active = on;
    if (on) onActivate?.();
    v.onPick = on ? onPick : null;
    if (!on) {
      selected.clear();
      opSel = null;
      opSpot = null;
      paintOverlay();
    }
    render();
    btn.classList.toggle('on', on);
  }

  const btn = h('button', { class: 'nav-btn', title: '窓・戸・天井高・シャッター（3D を見ながら、窓や壁・部屋をクリックして直す）', onclick: () => setActive(!active) }, h('span', { class: 'ic' }, '⌂'), '窓・戸');
  return { button: btn, setActive, isActive: () => active };
}
