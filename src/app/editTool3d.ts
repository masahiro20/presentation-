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
import { OUTDOOR_TYPES, FLOOR_FINISH_LABEL, FLOOR_OFFSET_PRESETS, VOID_GUARDS, VOID_GUARD_LABEL, type BuildingModel, type Floor, type FloorFinish, type Opening, type VoidGuard, type Wall } from '../core/types';
import { SHUTTER_LAYOUTS, applyShutterLayout, autoShutterLayout, shutterLayoutOf } from '../core/shutter';
import { OPENING_LABEL, OPENING_DEFAULT, OPENING_KINDS, WINDOW_SHAPES, applyWindowShape, applyOpeningKind, setOpeningWidth, flipHinge, flipSwing, openingSummary, isSlidingWindow, clampToWall } from '../core/openings';
import { effectiveOpening, resolveSpec } from '../styles/spec';

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
  /** 選んだ窓・戸を掴んで壁に沿って動かしている間の状態 */
  let opDrag: { f: Floor; op: Opening; w: Wall; L: number; width: number; t0Start: number; tPress: number; preview: number | null } | null = null;
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

  /** 点（world）を壁に落とした位置 t（壁の始点から mm）と壁からの距離 d */
  const wallParam = (w: Wall, p: THREE.Vector3) => {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    const px = p.x * 1000;
    const py = p.z * 1000;
    const t = (px - w.a.x) * ux + (py - w.a.y) * uy;
    return { t, d: Math.hypot(px - (w.a.x + ux * t), py - (w.a.y + uy * t)), L };
  };
  /** 窓・戸の枠（壁面上の矩形。world m）: 選択の表示とドラッグ中の下見せ。高さは 3D と同じ仕様の補正（サッシ上端＝天井など）を掛ける */
  const openingFrame = (f: Floor, w: Wall, t0: number, t1: number, op: Opening): THREE.Vector3[] => {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    const fl = f.elevation / 1000;
    const eff = effectiveOpening(op, f.ceilingHeight, resolveSpec(state.design.specId, state.design.specPatch));
    const y0 = fl + eff.sill / 1000;
    const y1 = fl + (eff.sill + eff.height) / 1000;
    const P = (t: number, y: number) => new THREE.Vector3((w.a.x + ux * t) / 1000, y, (w.a.y + uy * t) / 1000);
    return [P(t0, y0), P(t1, y0), P(t1, y1), P(t0, y1)];
  };
  const selectedOpening = () => {
    const m = model();
    const f = m && opSel ? m.floors.find((x) => x.level === opSel!.level) : null;
    const op = f?.openings.find((o) => o.id === opSel!.id) ?? null;
    const w = f && op ? f.walls.find((x) => x.id === op.wallId) ?? null : null;
    return f && op && w ? { f, op, w } : null;
  };
  /** 選んだ窓・戸に橙の枠を出す（無ければ消す） */
  const showOpSel = () => {
    const s = selectedOpening();
    v.setSelection(s ? openingFrame(s.f, s.w, s.op.t0, s.op.t1, s.op) : null);
  };
  /** 選んだ窓・戸の上で押したらドラッグ開始（壁に沿って動く）。それ以外はカメラ操作のまま */
  const dragStart = (p: THREE.Vector3): boolean => {
    if (!active || mode !== 'opening' || !opSel) return false;
    const s = selectedOpening();
    if (!s) return false;
    const { t, d } = wallParam(s.w, p);
    if (d > 450 || t < s.op.t0 - 150 || t > s.op.t1 + 150) return false;
    const fl = s.f.elevation / 1000;
    const eff = effectiveOpening(s.op, s.f.ceilingHeight, resolveSpec(state.design.specId, state.design.specPatch));
    if (p.y < fl + eff.sill / 1000 - 0.3 || p.y > fl + (eff.sill + eff.height) / 1000 + 0.3) return false;
    opDrag = { f: s.f, op: s.op, w: s.w, L: wallParam(s.w, p).L, width: s.op.t1 - s.op.t0, t0Start: s.op.t0, tPress: t, preview: null };
    return true;
  };
  const dragMove = (p: THREE.Vector3) => {
    if (!opDrag) return;
    const { f, op, w, L, width } = opDrag;
    const { t } = wallParam(w, p);
    let t0 = opDrag.t0Start + (t - opDrag.tPress);
    // ほかの窓・戸と重ならない範囲（隣の開口の端で止まる）と、壁の端
    let lo = 40;
    let hi = L - 40 - width;
    for (const o of f.openings) {
      if (o.wallId !== w.id || o.id === op.id) continue;
      if (o.t1 <= opDrag.t0Start + 1) lo = Math.max(lo, o.t1 + 20);
      else if (o.t0 >= opDrag.t0Start + width - 1) hi = Math.min(hi, o.t0 - 20 - width);
    }
    // 半間（455）の格子に止める: 開口の端が格子に乗る所（6cm 以内）
    const grid = model()?.module?.grid ?? 455;
    for (const edge of [0, width]) {
      const g = Math.round((t0 + edge) / grid) * grid - edge;
      if (Math.abs(g - t0) < 60) {
        t0 = g;
        break;
      }
    }
    t0 = Math.max(lo, Math.min(hi, Math.round(t0)));
    opDrag.preview = t0;
    v.setSelection(openingFrame(f, w, t0, t0 + width, op));
  };
  const dragEnd = (_p: THREE.Vector3, moved: boolean) => {
    if (!opDrag) return;
    const d = opDrag;
    opDrag = null;
    if (!moved || d.preview == null || Math.abs(d.preview - d.t0Start) < 1) {
      showOpSel();
      return;
    }
    d.op.t0 = d.preview;
    d.op.t1 = d.preview + d.width;
    toast(`${OPENING_LABEL[d.op.kind]}を壁の始点から ${Math.round(d.op.t0).toLocaleString()} mm へ動かしました`, 'ok', 2500);
    commit();
  };

  /** クリックした面の素材から「床」「壁・窓・戸」を見分ける（CAD のように、見ている物をそのまま選ぶため） */
  const FLOOR_KEYS = /^int\.(floor|wetFloor|entranceFloor|tatami|slab)$|^ext\.(balcony|terrace|concrete)$/;
  const WALL_KEYS = /^(ext\.(wall|accent|glass\w*|frame|door|shutter|sash\w*)|int\.(wall|accent|bathWall|wallTop|door\w*|frame\w*|glass\w*)|f\.metal)$/;

  const onPick = (pt0: THREE.Vector3, ndc?: THREE.Vector2) => {
    // 見ている物を優先: 家具・外構の物ならその道具へ。床なら部屋（天井高・床）、壁・窓・戸なら窓・戸。シャッターの道具のときは従来どおり外壁
    if (mode !== 'shutter' && ndc) {
      const hit = v.pickHit(ndc);
      if (hit) {
        if (hit.group === 'furniture' || hit.group === 'landscape') {
          if (v.onPickIdle?.(hit, ndc)) return;
          // 家具・外構の飾り（照明の笠・植栽の鉢など、選べる物に属さない部品）: 壁を選びに行かない
          toast(hit.group === 'furniture' ? '家具・造作をクリックすると「家具」の道具で直せます' : '置いた物をクリックすると「外構」の道具で直せます', 'info', 2500);
          return;
        }
        if (mode === 'opening' && FLOOR_KEYS.test(hit.matKey) && pickHere(hit, ndc)) return;
        if (mode === 'ceiling' && WALL_KEYS.test(hit.matKey) && pickHere(hit, ndc)) return;
      }
    }
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
      if (OUTDOOR_TYPES.includes(room.type) || room.type === 'stairs') {
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
        // 壁でない物（家具・外構）をクリックしたら、その物の道具へ
        if (ndc && v.onPickIdle) {
          const hit = v.pickHit(ndc);
          if (hit && hit.group !== 'building' && hit.group !== 'cut' && v.onPickIdle(hit, ndc)) return;
        }
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
      if (r.type === 'void') continue;
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
    if (active && mode === 'opening') showOpSel();
    else if (active) v.setSelection(null);
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
        h('p', { class: 'hint', style: 'margin:0 0 6px' }, '部屋の床をクリックして選びます（複数可。もう一度で外す）。選んだ部屋だけの天井高・床の仕上げ・床の段差（小上がり・ダウンリビング）になります。吹抜を選ぶと落下防止の種類を選べます。'),
        h('div', { class: 'furn-sel' }, rs.length ? rs.map(({ f, r }) => h('div', null, `${f.level}階 ${r.name || r.type}${r.ceilingHeight ? `（天井 ${r.ceilingHeight}）` : ''}${r.floorFinish ? `（床: ${FLOOR_FINISH_LABEL[r.floorFinish]}）` : ''}`)) : h('div', { class: 'hint' }, 'まだ選んでいません')),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '天井高 (mm)'), h('input', { type: 'number', step: 50, min: 2000, max: 6000, value: ceilH, onchange: (e: Event) => (ceilH = +(e.target as HTMLInputElement).value || 3500) })),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn sm primary', onclick: applyCeiling }, '選んだ部屋に適用'), ...(rs.some(({ r }) => r.ceilingHeight) ? [h('button', { class: 'btn sm ghost', onclick: resetCeiling }, '階の天井高に戻す')] : [])),
      );
      if (rs.length) {
        // 床の仕上げ（選んだ部屋に）。「部屋の種類のまま」で上書きを消す
        const cur = rs.length === 1 ? rs[0].r.floorFinish ?? '' : '';
        panel.append(
          h('div', { class: 'field-label', style: 'margin-top:8px' }, '床の仕上げ'),
          h(
            'div',
            { class: 'segmented' },
            h('button', { class: cur === '' ? 'on' : '', onclick: () => { for (const { r } of rs) delete r.floorFinish; commit(); } }, '種類のまま'),
            ...(Object.keys(FLOOR_FINISH_LABEL) as FloorFinish[]).map((k) => h('button', { class: cur === k ? 'on' : '', title: FLOOR_FINISH_LABEL[k], onclick: () => { for (const { r } of rs) r.floorFinish = k; toast(`${rs.length} 室の床を${FLOOR_FINISH_LABEL[k]}にしました`, 'ok'); commit(); } }, FLOOR_FINISH_LABEL[k].replace(/（.*）/, ''))),
          ),
        );
      }
      if (rs.length) {
        // 床の段差（小上がり・ダウンリビング・中二階）
        const cur = rs.length === 1 ? rs[0].r.floorOffset ?? 0 : 0;
        const opts = FLOOR_OFFSET_PRESETS.slice();
        if (!opts.some((o) => o.v === cur)) opts.push({ label: `指定 ${cur > 0 ? '+' : ''}${cur}`, v: cur });
        const setOff = (v: number) => {
          for (const { r } of rs) {
            if (v) r.floorOffset = v;
            else delete r.floorOffset;
          }
          toast(v ? `${rs.length} 室の床を FL${v > 0 ? '+' : ''}${v} にしました（框と蹴込みが付きます）` : `${rs.length} 室の段差を無くしました`, 'ok');
          commit();
        };
        panel.append(
          h('div', { class: 'field-label', style: 'margin-top:8px' }, '床の高さ（FL からの段差）'),
          h(
            'div',
            { style: 'display:flex;gap:6px;align-items:center' },
            h('select', { onchange: (e: Event) => setOff(Number((e.target as HTMLSelectElement).value)) }, ...opts.map((o) => h('option', { value: String(o.v), selected: o.v === cur }, o.label))),
            h('input', { type: 'number', step: 50, min: -1500, max: 2500, value: cur, style: 'width:84px', title: 'mm', onchange: (e: Event) => setOff(Math.round(Number((e.target as HTMLInputElement).value) / 10) * 10) }),
            h('span', { class: 'hint', style: 'margin:0' }, 'mm'),
          ),
          h('p', { class: 'hint' }, '小上がりの畳コーナーは +300〜400、ダウンリビングは −300〜400。中二階（+1,400 など）はその部屋の天井高も上げてください。'),
        );
        const voids = rs.filter(({ r }) => r.type === 'void');
        if (voids.length) {
          const g = voids.length === 1 ? voids[0].r.voidGuard : undefined;
          panel.append(
            h('div', { class: 'field-label', style: 'margin-top:8px' }, '吹抜の落下防止（上階の縁）'),
            h(
              'select',
              { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value as VoidGuard | ''; for (const { r } of voids) { if (v) r.voidGuard = v; else delete r.voidGuard; } toast(v ? `吹抜の縁を${VOID_GUARD_LABEL[v]}にしました` : 'テイストの既定に戻しました', 'ok'); commit(); } },
              h('option', { value: '', selected: !g }, 'テイストの既定'),
              ...VOID_GUARDS.map((k) => h('option', { value: k, selected: g === k }, VOID_GUARD_LABEL[k])),
            ),
          );
        }
      }
      if (custom.length) panel.append(h('p', { class: 'hint', style: 'margin-top:8px' }, `個別の天井高: ${custom.join('・')}`));
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
    panel.append(h('p', { class: 'hint', style: 'margin:0 0 6px' }, opSel ? '橙の枠が選んだ窓・戸。そのまま掴んで壁に沿ってドラッグで動かせます（半間の格子に止まり、隣の窓・戸の手前で止まります）。' : '窓・戸をクリックして選びます。パースを見ながら形（掃き出し／腰窓…）・幅・高さ・吊元を変えられます。何も無い壁をクリックすると、そこに置けます。'));
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
        // 壁の仕上げ: テイストのアクセント材（外壁）／アクセントクロス（内壁）をこの壁だけに
        const setAccent = (val: boolean | undefined) => {
          if (val === undefined) delete w.accent;
          else w.accent = val;
          toast(val === undefined ? 'テイストの決まりに戻しました' : val ? (w.exterior ? 'この壁をアクセント仕上げにしました' : 'この壁をアクセントクロスにしました') : '通常の仕上げにしました', 'ok');
          commit();
        };
        panel.append(
          h('div', { class: 'furn-sel' }, h('div', { class: 'field-label' }, `${fl.level}階 ${w.exterior ? '外壁' : '内壁'}（長さ ${Math.round(L).toLocaleString()}）`)),
          h('div', { class: 'field-label' }, 'ここに置く'),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => put('window') }, '窓'), h('button', { class: 'btn sm', onclick: () => put('door') }, w.exterior && fl.level === 1 ? '玄関ドア' : '開き戸'), h('button', { class: 'btn sm', onclick: () => put('sliding') }, '引戸')),
          h('div', { class: 'field-label', style: 'margin-top:8px' }, w.exterior ? '壁の仕上げ（テイストのアクセント材）' : '壁の仕上げ（アクセントクロス）'),
          h('div', { class: 'segmented' }, h('button', { class: w.accent === undefined ? 'on' : '', onclick: () => setAccent(undefined) }, 'テイストのまま'), h('button', { class: w.accent === true ? 'on' : '', onclick: () => setAccent(true) }, 'アクセント'), h('button', { class: w.accent === false ? 'on' : '', onclick: () => setAccent(false) }, '通常')),
          h('p', { class: 'hint' }, w.exterior ? 'アクセント材はテイスト（外観）で決まります。' : '内壁は両面とも変わります。'),
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
      opDrag = null;
      paintOverlay();
      v.setSelection(null);
    }
    render();
    btn.classList.toggle('on', on);
  }

  /** 道具を開いていないときのクリック: 床なら部屋（天井高・床の仕上げ）、壁・窓・戸なら窓・戸の道具を開いて選ぶ。該当すれば true */
  function pickHere(hit: { matKey: string; point: THREE.Vector3 }, ndc?: THREE.Vector2): boolean {
    const f = floorAt(hit.point.y);
    if (!f) return false;
    const p = { x: hit.point.x * 1000, y: hit.point.z * 1000 };
    if (FLOOR_KEYS.test(hit.matKey)) {
      const room = f.rooms.find((r) => pointInPolygon(p, r.polygon));
      if (!room || OUTDOOR_TYPES.includes(room.type) || room.type === 'stairs') return false;
      if (!active) setActive(true);
      mode = 'ceiling';
      selected.clear();
      selected.add(room.id);
      paintOverlay();
      render();
      toast(`${f.level}階 ${room.name || room.type} を選びました（天井高・床の仕上げ）`, 'ok', 2500);
      return true;
    }
    if (WALL_KEYS.test(hit.matKey)) {
      if (!active) setActive(true);
      mode = 'opening';
      selected.clear();
      paintOverlay();
      onPick(hit.point, ndc);
      return true;
    }
    return false;
  }

  const btn = h('button', { class: 'nav-btn', title: '窓・戸・壁・天井高・シャッター（3D を見ながら、窓や壁・部屋の床をクリックして直す。選んだ窓・戸はドラッグで動かす）', onclick: () => setActive(!active) }, h('span', { class: 'ic' }, '⌂'), '窓・戸');
  return { button: btn, setActive, isActive: () => active, pickHere, dragStart, dragMove, dragEnd };
}
