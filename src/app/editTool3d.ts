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
import { OUTDOOR_TYPES, type BuildingModel, type Floor, type Wall } from '../core/types';

export function createEditTool3d(v: Viewer, host: HTMLElement, onModelEdited: () => void, onActivate?: () => void) {
  const panel = h('div', { class: 'furn-tool edit3d', hidden: true });
  host.appendChild(panel);
  let active = false;
  let mode: 'ceiling' | 'shutter' = 'ceiling';
  let ceilH = 3500;
  const selected = new Set<string>();
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
    if (ex) {
      if (ex.kind === 'shutter') {
        f.openings = f.openings.filter((o) => o !== ex);
        toast('シャッターを外しました', 'ok');
      } else {
        ex.kind = 'shutter';
        ex.sill = 0;
        ex.height = Math.min(2300, f.ceilingHeight - 100);
        ex.windowStyle = undefined;
        toast(`この${ex.kind === 'shutter' ? '開口' : '窓'}をシャッターにしました`, 'ok');
      }
    } else {
      if (L < 1800) {
        toast('壁が短すぎます（シャッターは 1.8m 以上の壁に）');
        return;
      }
      f.openings.push({ id: `${w.id}-S${Date.now().toString(36)}`, wallId: w.id, kind: 'shutter', t0: 80, t1: L - 80, sill: 0, height: Math.min(2300, f.ceilingHeight - 100), hingeAtStart: true, swingSide: 1, confidence: 1 });
      toast('シャッターを置きました（もう一度クリックで外す）', 'ok');
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
    panel.append(h('div', { class: 'furn-head' }, h('span', null, '3D で直す'), h('button', { class: 'btn xs ghost', onclick: () => setActive(false) }, '閉じる')), h('div', { style: 'display:flex;gap:6px;margin:4px 0 8px' }, modeBtn('ceiling', '天井高'), modeBtn('shutter', 'シャッター')));
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
      panel.append(h('p', { class: 'hint', style: 'margin:0' }, 'ガレージの外壁（道路側）をクリックすると、その壁いっぱいのシャッターを置きます。窓や戸の上をクリックすると、それをシャッターに替えます。シャッターをもう一度クリックすると外します。'), h('p', { class: 'hint' }, n ? `シャッター ${n} か所` : 'シャッターはまだありません'));
    }
  };

  function setActive(on: boolean) {
    active = on;
    if (on) onActivate?.();
    v.onPick = on ? onPick : null;
    if (!on) {
      selected.clear();
      paintOverlay();
    }
    render();
    btn.classList.toggle('on', on);
  }

  const btn = h('button', { class: 'nav-btn', title: '天井高・シャッター（3D を見ながら、部屋や壁をクリックして直す）', onclick: () => setActive(!active) }, h('span', { class: 'ic' }, '⌂'), '天井');
  return { button: btn, setActive, isActive: () => active };
}
