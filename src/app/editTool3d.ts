/**
 * 3D 画面のまま直す（パースを見ながら）:
 *  - 天井高: 部屋の床をクリックして選び（複数可）、その部屋だけの天井高を決める（LDK と水まわりだけ 3,500 など）
 *  - シャッター: ガレージの外壁をクリックして、その壁いっぱいのシャッターを置く（もう一度クリックで外す）
 * 方眼の修正画面（planEditor）にも同じ道具がある。ここは「見ながら」用。
 */
import * as THREE from 'three';
import { h, clear, toast } from './dom';
import { state } from './state';
import type { DimLine3D, Handle3D, Viewer } from '../scene/viewer';
import { distPointSegment, pointInPolygon } from '../core/geometry';
import { mmText, openingGaps } from '../core/dims';
import { OUTDOOR_TYPES, FLOOR_FINISH_LABEL, FLOOR_OFFSET_PRESETS, VOID_GUARDS, VOID_GUARD_LABEL, ROOF_KIND_LABEL, type BuildingModel, type Floor, type FloorFinish, type Opening, type RoofHigh, type RoofKind, type RoofPatch, type Canopy, type VoidGuard, type Wall } from '../core/types';
import { SHUTTER_LAYOUTS, applyShutterLayout, autoShutterLayout, shutterLayoutOf } from '../core/shutter';
import { OPENING_LABEL, OPENING_DEFAULT, OPENING_KINDS, WINDOW_SHAPES, applyWindowShape, applyOpeningKind, setInteriorWindow, setOpeningWidth, flipHinge, flipSwing, openingSummary, openingLabel, setExteriorDoorRole, isSlidingWindow, clampToWall } from '../core/openings';
import { effectiveOpening, resolveSpec } from '../styles/spec';
import { roofMasses, roofMassAt, patchLoop, type RoofMass } from '../scene/roof';
import { SASH_MIN_CHECK, SASH_QUICK_WIDTHS, isStandardSashWidth, nearestSashWidth, sashWidthLabel } from '../core/sash';
import { wallTopOf } from '../scene/building';
import { exteriorById } from '../styles/presets';
import { emit } from './state';
import { stairStringerOf } from '../coordinate/catalog';
import { massName, massSourceTag, massState, roofPatchControls, segButtons, sideLabel } from './roofPatchPanel';
import type { Stair, StairBuild, StairFrame, StairLook, StairRail, StairStringer, StairTread } from '../core/types';
import { STAIR_ENTRY_LABEL, STAIR_KIND_LABEL, wrapFlights } from '../core/stairs';
import { STAIR_BUILD_LABEL, STAIR_BUILDS, STAIR_FRAME_LABEL, STAIR_FRAMES, STAIR_RAIL_LABEL, STAIR_RAILS, STAIR_STRINGER_LABEL, STAIR_STRINGERS, STAIR_TREAD_LABEL, STAIR_TREADS, stairLevels, stairNoteFor, stairNoteIndexToEdit } from '../core/focus';
import { focusNotes, openFocusDialog, setStairBuild, setStairLookAt, stairBuildNow } from './focusNotes';
import { keepInsideFloor, linkedStairs, movedCorner, placeStair, rotateStair, stairAtPoint, wallsThroughStair, type StairGrid, type StairRef } from '../core/stairEdit';

/** 階段の短い名前（トースト・パネルの見出し） */
const STAIR_SHORT: Record<Stair['kind'], string> = { straight: '直階段', u: '折り返し階段', uOpen: 'コの字階段', l: 'かね折れ階段' };

export function createEditTool3d(v: Viewer, host: HTMLElement, onModelEdited: () => void, onActivate?: () => void) {
  const panel = h('div', { class: 'furn-tool edit3d', hidden: true });
  host.appendChild(panel);
  let active = false;
  let mode: 'ceiling' | 'shutter' | 'opening' | 'roof' | 'stairs' = 'opening';
  /** 階段: 選んだ階段（3D でクリック）。掴んで動かす・回すハンドルで回している間の状態（linked = 上下の階の同じ階段） */
  let stairSel: { level: number; id: string } | null = null;
  let stairDrag: (StairRef & { linked: StairRef[]; press: { x: number; y: number }; o: { minX: number; minY: number }; preview: { minX: number; minY: number } | null }) | null = null;
  let stairRot: (StairRef & { linked: StairRef[]; a0: number; q: number }) | null = null;
  let ceilH = 3500;
  /** 屋根: 選んだ塊（階と、その塊の中の点） */
  let roofSel: { level: number; at: { x: number; y: number } } | null = null;
  /** 壁を足す（床を 2 回クリック）: 道具を開いている間の状態と、1 点目（図面座標 mm） */
  let wallDraw: { on: boolean; level: number | null; a: { x: number; y: number } | null } = { on: false, level: null, a: null };
  /** 屋根を足す（床を 2 回クリックして四角）: 1 つ目の角（図面座標 mm） */
  let roofDraw: { on: boolean; level: number | null; a: { x: number; y: number } | null } = { on: false, level: null, a: null };
  const selected = new Set<string>();
  /** シャッター: 最後に触った壁（形を選び直す対象） */
  let lastShutter: { level: number; wallId: string } | null = null;
  /** 窓・戸: 選んだ開口。無い所をクリックしたときは「ここに置く」候補（壁と位置） */
  let opSel: { level: number; id: string } | null = null;
  let opSpot: { level: number; wallId: string; t: number } | null = null;
  /** 選んだ庇（3D でクリック、または「庇を付ける」で足した直後） */
  let canopySel: { level: number; id: string } | null = null;
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
  // ---- 階段（3D でクリックして選ぶ → ドラッグで移動・回すハンドルで 90°。上下の階の同じ階段も一緒に） ----
  const selectedStair = (): StairRef | null => {
    const m = model();
    const f = m && stairSel ? m.floors.find((x) => x.level === stairSel!.level) : null;
    const st = f?.stairs.find((s) => s.id === stairSel!.id) ?? null;
    return f && st ? { f, st } : null;
  };
  /** 3D の点（world m）にある階段。その階の床から上の階の床までの高さの間で外形の中（段の途中をクリックしても、その階の階段になる） */
  const stairAt3d = (pt: THREE.Vector3, matKey = 'int.stairs'): StairRef | null => {
    const m = model();
    if (!m) return null;
    const fs = m.floors.slice().sort((a, b) => a.elevation - b.elevation);
    const p = { x: pt.x * 1000, y: pt.z * 1000 };
    for (let i = fs.length - 1; i >= 0; i--) {
      const f = fs[i];
      const y0 = f.elevation / 1000;
      const y1 = (fs[i + 1]?.elevation ?? f.elevation + f.height) / 1000;
      if (pt.y < y0 - 0.15 || pt.y > y1 + 0.15) continue;
      // 3D に立ち上がっているのは上の階へ昇る階段だけ。段は外形 ± 60 mm。
      // 鉄骨（ささら桁は踏板の小口の位置 = 外形の縁）・手すりは、上の階の床より下なら外形 + 10 mm まで、
      // 上の階の床の高さでは外形の 15 mm 内側だけ（上の階の吹抜の手すり（f.metal）が階段の縁にあっても、階段を選ばないように）
      const st = stairAtPoint({ stairs: f.stairs.filter((s) => s.goesUp) }, p, matKey.startsWith('int.stairs') ? 60 : pt.y < y1 - 0.05 ? 10 : -15);
      if (st) return { f, st };
    }
    return null;
  };
  /** 階段をそろえる格子（通り芯の位相・半間）。Shift で格子なし */
  const stairGrid = (free: boolean): StairGrid | null => {
    if (free) return null;
    const mod = model()?.module;
    return { step: mod?.grid ?? 455, phaseX: mod?.phaseX ?? 0, phaseY: mod?.phaseY ?? 0 };
  };
  type Rect = { minX: number; minY: number; maxX: number; maxY: number };
  const stairOutline = (f: Floor, r: Rect) => {
    const y = f.elevation / 1000 + 0.04;
    return [new THREE.Vector3(r.minX / 1000, y, r.minY / 1000), new THREE.Vector3(r.maxX / 1000, y, r.minY / 1000), new THREE.Vector3(r.maxX / 1000, y, r.maxY / 1000), new THREE.Vector3(r.minX / 1000, y, r.maxY / 1000)];
  };
  /** 回すハンドル: 昇り口の辺の外（ホール側。たいてい開けていて見える）、床から 0.1 m */
  const stairHandles = (f: Floor, st: Stair): Handle3D[] => {
    const y = f.elevation / 1000 + 0.1;
    const cx = (st.minX + st.maxX) / 2;
    const cy = (st.minY + st.maxY) / 2;
    const off = 420;
    const q = st.entry === 'n' ? { x: cx, y: st.minY - off } : st.entry === 's' ? { x: cx, y: st.maxY + off } : st.entry === 'e' ? { x: st.maxX + off, y: cy } : { x: st.minX - off, y: cy };
    return [{ id: 'st:rot', kind: 'rotate', pos: new THREE.Vector3(q.x / 1000, y, q.y / 1000), title: 'ドラッグで 90° ずつ回す（クリック・R キーで右へ 90°）' }];
  };
  /** 階段の幅 W・奥行 D（床の高さに） */
  const stairDims = (f: Floor, r: Rect): DimLine3D[] => {
    const y = f.elevation / 1000 + 0.06;
    const P = (x: number, z: number) => new THREE.Vector3(x / 1000, y, z / 1000);
    return [
      { id: 'st:w', a: P(r.minX, r.minY - 220), b: P(r.maxX, r.minY - 220), label: `W ${mmText(r.maxX - r.minX)}` },
      { id: 'st:d', a: P(r.minX - 220, r.minY), b: P(r.minX - 220, r.maxY), label: `D ${mmText(r.maxY - r.minY)}` },
    ];
  };
  /** 選んだ階段に橙の枠・回すハンドル・寸法（preview = ドラッグ中の下見せの外形） */
  const showStairSel = (preview?: Rect) => {
    const s = selectedStair();
    if (!s || !active || mode !== 'stairs') {
      if (active && mode === 'stairs') v.setSelection(null);
      return;
    }
    const r = preview ?? s.st;
    v.setSelection(stairOutline(s.f, r));
    v.setHandles(preview ? null : stairHandles(s.f, s.st));
    v.setDimLines(stairDims(s.f, r));
  };
  /** 階段を選んで「階段」の道具にする */
  const selectStair = (sr: StairRef) => {
    if (!active) setActive(true);
    mode = 'stairs';
    stairSel = { level: sr.f.level, id: sr.st.id };
    selected.clear();
    paintOverlay();
    opSel = null;
    opSpot = null;
    canopySel = null;
    render();
    toast(`${sr.f.level}階の${STAIR_SHORT[sr.st.kind]}を選びました（ドラッグで移動・R で 90° 回す）`, 'ok', 2500);
  };
  /** 動かした・回した後: 階段の中を通る壁があれば知らせる */
  const afterStairEdit = (s: StairRef, msg: string) => {
    const through = wallsThroughStair(s.f, s.st);
    toast(through.length ? `${msg}。壁 ${through.length} か所と重なっています（位置を直すか、方眼で壁を直してください）` : msg, through.length ? 'info' : 'ok', 3500);
    commit();
  };
  /** 右（dir = 1）・左へ 90° 回す。上下の階の同じ階段も同じだけ回して、角の位置をそろえる */
  const turnStair = (s: StairRef, linked: StairRef[], q: number) => {
    const g = stairGrid(false);
    for (let i = 0; i < Math.abs(q); i++) {
      const dir = q > 0 ? 1 : -1;
      const before = { minX: s.st.minX, minY: s.st.minY };
      rotateStair(s.st, dir, g);
      // 外壁沿いの長い階段を中心で回すと外へ出る: 外形の中へ寄せる
      keepInsideFloor(s.f, s.st);
      for (const l of linked) {
        const ox = l.st.minX - before.minX;
        const oy = l.st.minY - before.minY;
        rotateStair(l.st, dir, null);
        placeStair(l.st, s.st.minX + ox, s.st.minY + oy);
      }
    }
    afterStairEdit(s, `階段を${q > 0 ? '右' : '左'}へ ${Math.abs(q) * 90}° 回しました（昇り口: ${STAIR_ENTRY_LABEL[s.st.entry]}）`);
  };
  /** 選んだ階段の上で押したら移動、回すハンドルなら回す。それ以外はカメラ操作のまま */
  const stairDragStart = (p: THREE.Vector3, ndc?: THREE.Vector2): boolean => {
    const s = selectedStair();
    const m = model();
    if (!s || !m) return false;
    const linked = linkedStairs(m, s.f.level, s.st);
    const hd = ndc ? v.pickHandle(ndc) : null;
    if (hd?.id === 'st:rot') {
      const cx = (s.st.minX + s.st.maxX) / 2000;
      const cz = (s.st.minY + s.st.maxY) / 2000;
      stairRot = { ...s, linked, a0: Math.atan2(p.z - cz, p.x - cx), q: 0 };
      return true;
    }
    const x = p.x * 1000;
    const y = p.z * 1000;
    if (x < s.st.minX - 150 || x > s.st.maxX + 150 || y < s.st.minY - 150 || y > s.st.maxY + 150) return false;
    // 高さも階段の範囲（その階の床〜上の階の床）。上の階の床の上で押したときは掴まない
    const upper = m.floors.find((f) => f.level === s.f.level + 1);
    if (p.y < s.f.elevation / 1000 - 0.2 || p.y > (upper ? upper.elevation : s.f.elevation + s.f.height) / 1000 + 0.2) return false;
    stairDrag = { ...s, linked, press: { x, y }, o: { minX: s.st.minX, minY: s.st.minY }, preview: null };
    return true;
  };
  /** 階段の種類・曲がる向きなどを変える（上下の階の同じ階段にも同じ変更） */
  const editStair = (fn: (st: Stair) => void, msg: string) => {
    const s = selectedStair();
    if (!s) return;
    const linked = linkedStairs(model()!, s.f.level, s.st);
    fn(s.st);
    for (const l of linked) fn(l.st);
    afterStairEdit(s, msg);
  };
  /** 階段のつくり・手すり（こだわり指定）を変える: その階の階段の指定に入れて、3D を作り直す */
  const changeLook = (level: number, patch: Partial<StairLook>, msg: string) => {
    setStairLookAt(level, patch);
    toast(msg, 'ok', 3000);
    commit();
  };
  /** 窓・戸の両端のハンドル（高さの中ほど）。端を引っ張ると幅が変わる */
  const openingHandles = (f: Floor, w: Wall, t0: number, t1: number, op: Opening): Handle3D[] => {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    const fl = f.elevation / 1000;
    const eff = effectiveOpening(op, f.ceilingHeight, resolveSpec(state.design.specId, state.design.specPatch));
    const ym = fl + (eff.sill + eff.height / 2) / 1000;
    const P = (t: number) => new THREE.Vector3((w.a.x + ux * t) / 1000, ym, (w.a.y + uy * t) / 1000);
    const title = '端をドラッグで幅を変える（半間の格子に止まる。Shift で自由）';
    return [
      { id: 'op:t0', kind: 'end', pos: P(t0), title },
      { id: 'op:t1', kind: 'end', pos: P(t1), title },
    ];
  };
  /**
   * 窓・戸の寸法線（CAD の「選ぶと寸法が出る」）: 幅 W・高さ H・腰高 FL+（黒）と、
   * 両端から隣の窓・戸（無ければ壁の端）までの空き（青。札をクリックして数値を打つと、その空きになる位置へ動く）
   */
  const opDimLines = (f: Floor, w: Wall, t0: number, t1: number, op: Opening): DimLine3D[] => {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    const fl = f.elevation / 1000;
    const eff = effectiveOpening(op, f.ceilingHeight, resolveSpec(state.design.specId, state.design.specPatch));
    const y0 = fl + eff.sill / 1000;
    const y1 = fl + (eff.sill + eff.height) / 1000;
    const ym = (y0 + y1) / 2;
    const P = (t: number, y: number) => new THREE.Vector3((w.a.x + ux * t) / 1000, y, (w.a.y + uy * t) / 1000);
    const yw = Math.max(fl + 0.1, y0 - 0.14);
    const out: DimLine3D[] = [
      { id: 'w', a: P(t0, yw), b: P(t1, yw), label: `W ${mmText(t1 - t0)}` },
      { id: 'h', a: P(t1 + 140, y0), b: P(t1 + 140, y1), label: `H ${mmText(eff.height)}` },
    ];
    if (eff.sill > 0) out.push({ id: 'sill', a: P(t0 - 140, fl), b: P(t0 - 140, y0), label: `FL+${mmText(eff.sill)}` });
    const g = openingGaps({ id: op.id, wallId: op.wallId, t0, t1 }, L, f.openings);
    if (g.left >= 10) out.push({ id: 'gap:t0', a: P(g.lo, ym), b: P(t0, ym), label: mmText(g.left), kind: 'gap', editable: true });
    if (g.right >= 10) out.push({ id: 'gap:t1', a: P(t1, ym), b: P(g.hi, ym), label: mmText(g.right), kind: 'gap', editable: true });
    return out;
  };
  /** 窓・戸を壁に沿って動かせる範囲（隣の窓・戸の端から 20、壁の端から 40） */
  const slideRange = (f: Floor, op: Opening, L: number) => {
    const g = openingGaps(op, L, f.openings);
    const width = op.t1 - op.t0;
    return { lo: g.lo + (g.lo > 0 ? 20 : 40), hi: g.hi - width - (g.hi < L ? 20 : 40), g, width };
  };
  /** 青の札に数値を打ったとき: その空きになるように窓・戸を壁に沿って動かす（幅はそのまま） */
  const applyOpGapEdit = (id: string, val: number) => {
    const s = selectedOpening();
    if (!s) return;
    const { f, op, w } = s;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const { lo, hi, g, width } = slideRange(f, op, L);
    const want = Math.max(0, Math.round(val));
    const t0 = id === 'gap:t0' ? g.lo + want : id === 'gap:t1' ? g.hi - want - width : null;
    if (t0 == null) return;
    op.t0 = Math.round(Math.max(lo, Math.min(hi, t0)));
    op.t1 = op.t0 + width;
    toast(`${OPENING_LABEL[op.kind]}を動かしました（${id === 'gap:t0' ? '始点側' : '終点側'}の空き ${mmText(id === 'gap:t0' ? op.t0 - g.lo : g.hi - op.t1)} mm）`, 'ok', 2000);
    commit();
  };
  /** 選んだ窓・戸に橙の枠・ハンドル・寸法線を出す（無ければ消す） */
  const showOpSel = () => {
    const s = selectedOpening();
    v.setSelection(s ? openingFrame(s.f, s.w, s.op.t0, s.op.t1, s.op) : null);
    v.setHandles(s && active && mode === 'opening' ? openingHandles(s.f, s.w, s.op.t0, s.op.t1, s.op) : null);
    v.setDimLines(s && active && mode === 'opening' ? opDimLines(s.f, s.w, s.op.t0, s.op.t1, s.op) : null);
    if (s && active && mode === 'opening') v.onDimEdit = applyOpGapEdit;
  };
  /**
   * 矢印キー: 選んだ窓・戸を壁に沿って 10 mm（Shift 100・Ctrl 半間）ずつ動かす（← →）、窓の腰高を 50 mm ずつ（↑ ↓）。
   * Delete で消す、Esc で選ぶのをやめる（入力欄に文字を打っている間は効かせない）
   */
  const onKey = (e: KeyboardEvent) => {
    if (active && mode === 'stairs' && stairSel) {
      onStairKey(e);
      return;
    }
    if (!active || mode !== 'opening' || !opSel || canopySel || wallDraw.on) return;
    const tg = e.target as HTMLElement | null;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
    const s = selectedOpening();
    if (!s) return;
    const { f, op, w } = s;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const step = e.ctrlKey || e.metaKey ? (model()?.module?.grid ?? 455) : e.shiftKey ? 100 : 10;
    const slide = (dt: number) => {
      handled();
      const { lo, hi, width } = slideRange(f, op, L);
      const t0 = Math.max(lo, Math.min(hi, Math.round(op.t0 + dt)));
      if (t0 === op.t0) return;
      op.t0 = t0;
      op.t1 = t0 + width;
      commit();
    };
    if (e.key === 'ArrowLeft') slide(-step);
    else if (e.key === 'ArrowRight') slide(step);
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && op.kind === 'window') {
      handled();
      op.sill = Math.max(0, Math.min(f.ceilingHeight - op.height, op.sill + (e.key === 'ArrowUp' ? 50 : -50)));
      commit();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      handled();
      f.openings = f.openings.filter((o) => o.id !== op.id);
      opSel = null;
      commit();
    } else if (e.key === 'Escape') {
      handled();
      opSel = null;
      render();
    }
  };
  /** 階段: 矢印キーで 10 mm（Shift 100・Ctrl 半間）ずつ動かす、R で右へ 90°（Shift+R で左）、Delete で消す、Esc で選ぶのをやめる */
  const onStairKey = (e: KeyboardEvent) => {
    const tg = e.target as HTMLElement | null;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
    const s = selectedStair();
    if (!s) return;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const linked = linkedStairs(model()!, s.f.level, s.st);
    const step = e.ctrlKey || e.metaKey ? (model()?.module?.grid ?? 455) : e.shiftKey ? 100 : 10;
    const mv = (dx: number, dy: number) => {
      handled();
      for (const x of [s, ...linked]) placeStair(x.st, x.st.minX + dx, x.st.minY + dy);
      commit();
    };
    if (e.key === 'ArrowLeft') mv(-step, 0);
    else if (e.key === 'ArrowRight') mv(step, 0);
    else if (e.key === 'ArrowUp') mv(0, -step);
    else if (e.key === 'ArrowDown') mv(0, step);
    else if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) {
      handled();
      turnStair(s, linked, e.shiftKey ? -1 : 1);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      handled();
      removeStair();
    } else if (e.key === 'Escape') {
      handled();
      stairSel = null;
      render();
    }
  };
  /** 選んだ階段を消す（上下の階の同じ階段も） */
  const removeStair = () => {
    const s = selectedStair();
    if (!s) return;
    const linked = linkedStairs(model()!, s.f.level, s.st);
    s.f.stairs = s.f.stairs.filter((x) => x.id !== s.st.id);
    for (const l of linked) l.f.stairs = l.f.stairs.filter((x) => x.id !== l.st.id);
    stairSel = null;
    toast(`${s.f.level}階の${STAIR_SHORT[s.st.kind]}を消しました${linked.length ? `（${linked.map((l) => `${l.f.level}階`).join('・')}の同じ階段も）` : ''}`, 'ok', 3000);
    commit();
  };
  window.addEventListener('keydown', onKey, true);
  /** 窓・戸の端を掴んで幅を変えている間の状態 */
  let opEdge: { f: Floor; op: Opening; w: Wall; L: number; which: 't0' | 't1'; preview: { t0: number; t1: number } | null } | null = null;
  /** 選んだ窓・戸の上で押したらドラッグ開始（壁に沿って動く）。端のハンドルなら幅を変える。それ以外はカメラ操作のまま */
  const dragStart = (p: THREE.Vector3, ndc?: THREE.Vector2): boolean => {
    if (active && mode === 'stairs') return stairDragStart(p, ndc);
    if (active && mode === 'roof') return roofHandleStart(ndc);
    if (!active || mode !== 'opening' || !opSel) return false;
    const s = selectedOpening();
    if (!s) return false;
    const hd = ndc ? v.pickHandle(ndc) : null;
    if (hd && (hd.id === 'op:t0' || hd.id === 'op:t1')) {
      opEdge = { f: s.f, op: s.op, w: s.w, L: wallParam(s.w, p).L, which: hd.id === 'op:t0' ? 't0' : 't1', preview: null };
      return true;
    }
    const { t, d } = wallParam(s.w, p);
    if (d > 450 || t < s.op.t0 - 150 || t > s.op.t1 + 150) return false;
    const fl = s.f.elevation / 1000;
    const eff = effectiveOpening(s.op, s.f.ceilingHeight, resolveSpec(state.design.specId, state.design.specPatch));
    if (p.y < fl + eff.sill / 1000 - 0.3 || p.y > fl + (eff.sill + eff.height) / 1000 + 0.3) return false;
    opDrag = { f: s.f, op: s.op, w: s.w, L: wallParam(s.w, p).L, width: s.op.t1 - s.op.t0, t0Start: s.op.t0, tPress: t, preview: null };
    return true;
  };
  const dragMove = (p: THREE.Vector3, ndc?: THREE.Vector2) => {
    if (stairDrag) {
      // 階段を動かす: 左上の角を通り芯の半間の格子に（Shift で自由）
      const d = stairDrag;
      const c = movedCorner(d.o, p.x * 1000 - d.press.x, p.z * 1000 - d.press.y, stairGrid(v.dragMods.shift));
      d.preview = c;
      showStairSel({ minX: c.minX, minY: c.minY, maxX: c.minX + (d.st.maxX - d.st.minX), maxY: c.minY + (d.st.maxY - d.st.minY) });
      const dx = c.minX - d.o.minX;
      const dy = c.minY - d.o.minY;
      const sg = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${mmText(Math.abs(n))}`;
      v.setDragLabel(`移動 X ${sg(dx)}・Y ${sg(dy)} mm${v.dragMods.shift ? '' : '（半間の格子。Shift で自由）'}`);
      return;
    }
    if (stairRot) {
      // 回すハンドル: 階段の中心のまわりの角度を 90° 刻みに
      const s = stairRot;
      const cx = (s.st.minX + s.st.maxX) / 2000;
      const cz = (s.st.minY + s.st.maxY) / 2000;
      let da = Math.atan2(p.z - cz, p.x - cx) - s.a0;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      s.q = Math.round(da / (Math.PI / 2));
      const tmp: Stair = { ...s.st };
      for (let i = 0; i < Math.abs(s.q); i++) rotateStair(tmp, s.q > 0 ? 1 : -1, stairGrid(false));
      showStairSel(tmp);
      v.setDragLabel(s.q ? `${s.q > 0 ? '右' : '左'}へ ${Math.abs(s.q) * 90}°（昇り口: ${STAIR_ENTRY_LABEL[tmp.entry]}）` : '回す（90° ずつ）');
      return;
    }
    if (roofHd) {
      roofHandleMove(p, ndc);
      return;
    }
    if (opEdge) {
      const { f, op, w, L, which } = opEdge;
      let { t } = wallParam(w, p);
      // ほかの窓・戸と重ならない範囲と壁の端。最小幅 300
      const fixed = which === 't0' ? op.t1 : op.t0;
      let lo = 40;
      let hi = L - 40;
      for (const o of f.openings) {
        if (o.wallId !== w.id || o.id === op.id) continue;
        if (o.t1 <= Math.min(op.t0, fixed) + 1) lo = Math.max(lo, o.t1 + 20);
        else if (o.t0 >= Math.max(op.t1, fixed) - 1) hi = Math.min(hi, o.t0 - 20);
      }
      if (which === 't0') hi = Math.min(hi, fixed - 300);
      else lo = Math.max(lo, fixed + 300);
      // 窓は標準のサッシ幅（柱芯の割 − 130: 780・1,235・1,690・2,600…）に止める（7cm 以内）。それ以外は半間（455）の格子（Shift で自由）
      const grid = model()?.module?.grid ?? 455;
      let std = false;
      if (!v.dragMods.shift) {
        const wantW = which === 't0' ? fixed - t : t - fixed;
        const sw = op.kind === 'window' && wantW > SASH_MIN_CHECK ? nearestSashWidth(wantW) : null;
        if (sw != null && Math.abs(sw - wantW) < 70) {
          t = which === 't0' ? fixed - sw : fixed + sw;
          std = true;
        } else {
          const g = Math.round(t / grid) * grid;
          if (Math.abs(g - t) < 80) t = g;
        }
      }
      t = Math.max(lo, Math.min(hi, Math.round(t)));
      const t0 = which === 't0' ? t : op.t0;
      const t1 = which === 't1' ? t : op.t1;
      opEdge.preview = { t0, t1 };
      v.setSelection(openingFrame(f, w, t0, t1, op));
      v.setHandles(openingHandles(f, w, t0, t1, op));
      v.setDimLines(opDimLines(f, w, t0, t1, op));
      v.setDragLabel(std ? `幅 ${sashWidthLabel(Math.round(t1 - t0))} 標準` : `幅 ${Math.round(t1 - t0).toLocaleString()} mm`);
      return;
    }
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
    v.setDimLines(opDimLines(f, w, t0, t0 + width, op));
  };
  const dragEnd = (_p: THREE.Vector3, moved: boolean) => {
    if (stairDrag) {
      const d = stairDrag;
      stairDrag = null;
      if (!moved || !d.preview || (d.preview.minX === d.o.minX && d.preview.minY === d.o.minY)) {
        showStairSel();
        return;
      }
      const dx = d.preview.minX - d.o.minX;
      const dy = d.preview.minY - d.o.minY;
      placeStair(d.st, d.preview.minX, d.preview.minY);
      for (const l of d.linked) placeStair(l.st, l.st.minX + dx, l.st.minY + dy);
      afterStairEdit(d, `階段を動かしました${d.linked.length ? `（${d.linked.map((l) => `${l.f.level}階`).join('・')}の同じ階段も）` : ''}`);
      return;
    }
    if (stairRot) {
      const s = stairRot;
      stairRot = null;
      // クリックだけなら右へ 90°
      const q = moved ? s.q : 1;
      if (!q) {
        showStairSel();
        return;
      }
      turnStair(s, s.linked, q);
      return;
    }
    if (roofHd) {
      roofHandleEnd(moved);
      return;
    }
    if (opEdge) {
      const e = opEdge;
      opEdge = null;
      if (!moved || !e.preview || (Math.abs(e.preview.t0 - e.op.t0) < 1 && Math.abs(e.preview.t1 - e.op.t1) < 1)) {
        showOpSel();
        return;
      }
      e.op.t0 = e.preview.t0;
      e.op.t1 = e.preview.t1;
      toast(`${OPENING_LABEL[e.op.kind]}の幅を ${Math.round(e.op.t1 - e.op.t0).toLocaleString()} mm にしました`, 'ok', 2500);
      commit();
      return;
    }
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

  /** クリックした面の素材から「床」「壁・窓・戸」「屋根」を見分ける（CAD のように、見ている物をそのまま選ぶため） */
  const FLOOR_KEYS = /^int\.(floor|wetFloor|entranceFloor|tatami|slab)$|^ext\.(balcony|terrace|concrete)$/;
  const WALL_KEYS = /^(ext\.(wall|accent|glass\w*|frame|door|shutter|sash\w*)|int\.(wall|accent|bathWall|wallTop|door\w*|frame\w*|glass\w*)|f\.metal)$/;
  const ROOF_KEYS = /^ext\.(roof|soffit|fascia|gutter)$/;
  /** 階段の部材（段・ささら桁・受け材・手すり）。手すり・鉄骨は階段の外形の中と高さの範囲で当たったものだけを階段とみなす */
  const STAIR_KEYS = /^(int\.stairs(@\w+)?|f\.metal|f\.steelWhite|f\.paintBlack)$/;

  // ---- 屋根: 塊（上の階が載らない範囲のつながった所）を選んで、掛け方・向き・勾配・軒の出を塊ごとに変える ----
  const masses = (): RoofMass[] => {
    const m = model();
    return m ? roofMasses(m, exteriorById(state.design.exteriorId), state.design.roofOverride) : [];
  };
  const selectedMass = (): RoofMass | null => (roofSel ? roofMassAt(masses().filter((x) => x.level === roofSel!.level), roofSel.at, 0) : null);
  /** 選んだ屋根の塊の範囲に橙の枠（軒の高さ） */
  const showRoofSel = () => {
    const ms = selectedMass();
    const m = model();
    const f = m && ms ? m.floors.find((x) => x.level === ms.level) : null;
    if (!ms || !m || !f) {
      v.setSelection(null);
      return;
    }
    const y = (ms.manual && ms.patch?.topMm != null ? (f.elevation + ms.patch.topMm) / 1000 : wallTopOf(m, f) / 1000) + 0.1;
    const b = ms.bbox;
    v.setSelection([new THREE.Vector3(b.minX / 1000, y, b.minY / 1000), new THREE.Vector3(b.maxX / 1000, y, b.minY / 1000), new THREE.Vector3(b.maxX / 1000, y, b.maxY / 1000), new THREE.Vector3(b.minX / 1000, y, b.maxY / 1000)]);
    v.setHandles(ms.omit ? null : roofHandles(m, ms, f));
  };
  /** 屋根の塊の今の値（手直し → 全体の設定の順） */
  const roofNow = (ms: RoofMass) => {
    const ext = exteriorById(state.design.exteriorId);
    const p = ms.patch;
    const wholeEaves = state.design.eaves ?? ext.roof.eaves;
    return {
      eaveOf: (s: RoofHigh) => p?.eavesBy?.[s] ?? p?.eaves ?? wholeEaves,
      pitch: p?.pitch ?? state.design.roofPitch ?? ext.roof.pitch,
      parapet: p?.parapet ?? 550,
      ridgeX: p?.ridge ? p.ridge === 'x' : ms.bbox.maxX - ms.bbox.minX >= ms.bbox.maxY - ms.bbox.minY,
    };
  };
  type RoofPreview = { eavesBy?: Partial<Record<RoofHigh, number>>; pitch?: number; high?: RoofHigh; parapet?: number };
  /**
   * 屋根のハンドル（CAD 感覚で屋根を直す）:
   *  - 軒の出: 4 辺の軒先の矢印。外へ引っ張ると伸びる（上の階に接する辺には無い）
   *  - 勾配: 棟（片流れは高い側の軒先）の上下の矢印。上へ引くと急に。陸屋根ではパラペットの高さ
   *  - 片流れの高い側: 真ん中の三角。高くしたい辺の方へドラッグ
   * 位置の高さは目安（軒 = 壁の天端、棟 = 軒 + 勾配 × 半スパン）
   */
  const roofHandles = (m: BuildingModel, ms: RoofMass, f: Floor, pv: RoofPreview = {}): Handle3D[] => {
    const now = roofNow(ms);
    const eaveOf = (s: RoofHigh) => pv.eavesBy?.[s] ?? now.eaveOf(s);
    const pitch = pv.pitch ?? now.pitch;
    const high = pv.high ?? ms.high;
    const y0 = ms.manual && ms.patch?.topMm != null ? (f.elevation + ms.patch.topMm) / 1000 : wallTopOf(m, f) / 1000;
    const b = ms.bbox;
    const cx = (b.minX + b.maxX) / 2000;
    const cz = (b.minY + b.maxY) / 2000;
    const W = (b.maxX - b.minX) / 1000;
    const D = (b.maxY - b.minY) / 1000;
    const north = m.northAngleDeg;
    const edgeMid = (s: RoofHigh, off: number): [number, number] => (s === 'n' ? [cx, b.minY / 1000 - off] : s === 's' ? [cx, b.maxY / 1000 + off] : s === 'e' ? [b.maxX / 1000 + off, cz] : [b.minX / 1000 - off, cz]);
    const out: Handle3D[] = [];
    for (const s of ['n', 's', 'e', 'w'] as RoofHigh[]) {
      if (ms.attached.includes(s)) continue;
      const [x, z] = edgeMid(s, eaveOf(s) / 1000);
      out.push({ id: `eave:${s}`, kind: 'eave', pos: new THREE.Vector3(x, y0 + 0.1, z), title: `${sideLabel(s, north)}の軒の出 ${Math.round(eaveOf(s))} mm。外へ引っ張ると伸びる（50 mm 刻み。Shift で細かく）` });
    }
    if (ms.kind === 'flat') {
      const par = (pv.parapet ?? now.parapet) / 1000;
      out.push({ id: 'pitch', kind: 'pitch', pos: new THREE.Vector3(cx, y0 + par, cz), title: `パラペット ${Math.round(par * 1000)} mm。上下にドラッグ` });
    } else if (ms.kind === 'shed') {
      const span = high === 'n' || high === 's' ? D : W;
      const [x, z] = edgeMid(high, 0);
      out.push({ id: 'pitch', kind: 'pitch', pos: new THREE.Vector3(x, y0 + (pitch / 10) * span, z), title: `勾配 ${pitch} 寸。上下にドラッグ（0.5 寸刻み。Shift で 0.1）` });
      out.push({ id: 'high', kind: 'arrow', on: true, pos: new THREE.Vector3(cx, y0 + ((pitch / 10) * span) / 2 + 0.25, cz), title: `高い側: ${sideLabel(high, north)}。高くしたい辺の方へドラッグ` });
    } else {
      const halfSpan = (now.ridgeX ? D : W) / 2;
      out.push({ id: 'pitch', kind: 'pitch', pos: new THREE.Vector3(cx, y0 + (pitch / 10) * halfSpan, cz), title: `勾配 ${pitch} 寸。上下にドラッグ（0.5 寸刻み。Shift で 0.1）` });
    }
    return out;
  };
  /** 屋根のハンドルを掴んでいる間 */
  let roofHd: { ms: RoofMass; f: Floor; m: BuildingModel; id: string; anchor: THREE.Vector3; y0: number; pv: RoofPreview; label: string } | null = null;
  const roofHandleStart = (ndc: THREE.Vector2 | undefined): boolean => {
    if (!ndc || !roofSel || roofDraw.on) return false;
    const hd = v.pickHandle(ndc);
    if (!hd) return false;
    const ms = selectedMass();
    const m = model();
    const f = m && ms ? m.floors.find((x) => x.level === ms.level) : null;
    if (!ms || !m || !f) return false;
    const y0 = ms.manual && ms.patch?.topMm != null ? (f.elevation + ms.patch.topMm) / 1000 : wallTopOf(m, f) / 1000;
    roofHd = { ms, f, m, id: hd.id, anchor: hd.pos.clone(), y0, pv: {}, label: '' };
    return true;
  };
  const roofHandleMove = (p: THREE.Vector3, ndc?: THREE.Vector2) => {
    if (!roofHd) return;
    const { ms, f, m, id, anchor, y0 } = roofHd;
    const now = roofNow(ms);
    const b = ms.bbox;
    const fine = v.dragMods.shift;
    const snap = (val: number, step: number) => Math.round(val / step) * step;
    if (id.startsWith('eave:')) {
      const s = id.slice(5) as RoofHigh;
      const raw = s === 'n' ? b.minY / 1000 - p.z : s === 's' ? p.z - b.maxY / 1000 : s === 'e' ? p.x - b.maxX / 1000 : b.minX / 1000 - p.x;
      const val = Math.max(0, Math.min(2500, snap(raw * 1000, fine ? 10 : 50)));
      roofHd.pv = { eavesBy: { [s]: val } };
      roofHd.label = `${sideLabel(s, m.northAngleDeg)}の軒の出 ${val} mm`;
    } else if (id === 'pitch') {
      const vp = ndc ? v.verticalPoint(ndc, anchor) : null;
      if (!vp) return;
      const dh = Math.max(0, vp.y - y0);
      if (ms.kind === 'flat') {
        const par = Math.max(0, Math.min(1500, snap(dh * 1000, fine ? 10 : 50)));
        roofHd.pv = { parapet: par };
        roofHd.label = `パラペット ${par} mm`;
      } else {
        const W = (b.maxX - b.minX) / 1000;
        const D = (b.maxY - b.minY) / 1000;
        const span = ms.kind === 'shed' ? (ms.high === 'n' || ms.high === 's' ? D : W) : (now.ridgeX ? D : W) / 2;
        const pitch = Math.max(0.3, Math.min(10, snap((dh / Math.max(0.5, span)) * 10, fine ? 0.1 : 0.5)));
        roofHd.pv = { pitch: +pitch.toFixed(1) };
        roofHd.label = `勾配 ${+pitch.toFixed(1)} 寸`;
      }
    } else if (id === 'high') {
      // いちばん近い辺を高い側に
      const dn = Math.abs(p.z - b.minY / 1000);
      const ds = Math.abs(p.z - b.maxY / 1000);
      const de = Math.abs(p.x - b.maxX / 1000);
      const dw = Math.abs(p.x - b.minX / 1000);
      const best = Math.min(dn, ds, de, dw);
      const high: RoofHigh = best === dn ? 'n' : best === ds ? 's' : best === de ? 'e' : 'w';
      roofHd.pv = { high };
      roofHd.label = `高い側: ${sideLabel(high, m.northAngleDeg)}`;
    }
    v.setHandles(roofHandles(m, ms, f, roofHd.pv));
    v.setDragLabel(roofHd.label);
  };
  const roofHandleEnd = (moved: boolean) => {
    if (!roofHd) return;
    const d = roofHd;
    roofHd = null;
    const pv = d.pv;
    if (!moved || !Object.keys(pv).length) {
      showRoofSel();
      return;
    }
    if (pv.eavesBy) {
      const [s, val] = Object.entries(pv.eavesBy)[0] as [RoofHigh, number];
      patchRoof((q) => { (q.eavesBy ??= {})[s] = val; }, `${sideLabel(s, d.m.northAngleDeg)}の軒の出を ${val} mm にしました`);
    } else if (pv.parapet != null) patchRoof((q) => { q.parapet = pv.parapet; }, `パラペットを ${pv.parapet} mm にしました`);
    else if (pv.pitch != null) patchRoof((q) => { q.pitch = pv.pitch; }, `勾配を ${pv.pitch} 寸にしました`);
    else if (pv.high) patchRoof((q) => { q.high = pv.high; q.kind = 'shed'; }, `高い側を${sideLabel(pv.high, d.m.northAngleDeg)}にしました`);
  };
  /** 屋根を足す: 1 つ目の角に橙の印 */
  const showRoofDrawMark = () => {
    const m = model();
    const f = m && roofDraw.level != null ? m.floors.find((x) => x.level === roofDraw.level) : null;
    if (!f || !roofDraw.a) {
      v.setSelection(null);
      return;
    }
    const y = wallTopOf(m!, f) / 1000 + 0.1;
    const { x, y: z } = roofDraw.a;
    const r = 150;
    v.setSelection([new THREE.Vector3((x - r) / 1000, y, (z - r) / 1000), new THREE.Vector3((x + r) / 1000, y, (z - r) / 1000), new THREE.Vector3((x + r) / 1000, y, (z + r) / 1000), new THREE.Vector3((x - r) / 1000, y, (z + r) / 1000)]);
  };
  /** 2 つ目の角: 四角形の屋根を足して選ぶ */
  const addRoofRect = (f: Floor, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const m = model();
    if (!m) return false;
    const rect = { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
    if (rect.maxX - rect.minX < 600 || rect.maxY - rect.minY < 600) {
      toast('小さすぎます（60cm 以上の四角にしてください）');
      return false;
    }
    const p: RoofPatch = { id: `R${f.level}-${Date.now().toString(36)}`, level: f.level, at: { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 }, rect };
    (m.roofPatches ??= []).push(p);
    roofSel = { level: f.level, at: { ...p.at } };
    toast(`${f.level}階に屋根を足しました（${((rect.maxX - rect.minX) / 1000).toFixed(1)} × ${((rect.maxY - rect.minY) / 1000).toFixed(1)} m）。右で掛け方・向き・勾配・高さを直せます`, 'ok', 3500);
    return true;
  };
  const selectMassAt = (p: { x: number; y: number }): RoofMass | null => {
    const ms = roofMassAt(masses(), p, 900);
    roofSel = ms ? { level: ms.level, at: ms.center } : null;
    return ms;
  };
  /** 選んだ塊の手直し（無ければ作る）に fn を当て、空になったら消す */
  const patchRoof = (fn: (p: RoofPatch) => void, msg?: string) => {
    const ms = selectedMass();
    const m = model();
    if (!ms || !m) return;
    const list = (m.roofPatches ??= []);
    let p = ms.patch ?? null;
    if (!p) {
      p = { id: `R${ms.level}-${Date.now().toString(36)}`, level: ms.level, at: { ...ms.center } };
      list.push(p);
    }
    fn(p);
    // 手で直した塊は、立面図を読み直しても上書きしない（「立面図から」の印を外す）
    delete p.source;
    // 手で描いた範囲（足した屋根・屋根なし）は項目が空でも残す
    if (!patchLoop(p) && !p.kind && !p.high && !p.ridge && p.pitch == null && p.eaves == null && !p.eavesBy && p.parapet == null) m.roofPatches = list.filter((x) => x !== p);
    if (msg) toast(msg, 'ok', 2500);
    commit();
  };

  // ---- 壁を足す（床の 2 点をクリック。壁の端に吸着、無ければ半間の格子） ----
  const snapWallPoint = (f: Floor, p: { x: number; y: number }): { p: { x: number; y: number }; joined: boolean } => {
    let best: { p: { x: number; y: number }; d: number } | null = null;
    for (const w of f.walls) for (const e of [w.a, w.b]) {
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d < 300 && (!best || d < best.d)) best = { p: { x: e.x, y: e.y }, d };
    }
    if (best) return { p: best.p, joined: true };
    const m = model();
    const g = m?.module?.grid ?? 455;
    const px = m?.module?.phaseX ?? 0;
    const py = m?.module?.phaseY ?? 0;
    return { p: { x: px + Math.round((p.x - px) / g) * g, y: py + Math.round((p.y - py) / g) * g }, joined: false };
  };
  const showWallDrawMark = () => {
    const m = model();
    const f = m && wallDraw.level != null ? m.floors.find((x) => x.level === wallDraw.level) : null;
    if (!f || !wallDraw.a) {
      v.setSelection(null);
      return;
    }
    const y = f.elevation / 1000 + 0.05;
    const { x, y: z } = wallDraw.a;
    const r = 0.12;
    v.setSelection([new THREE.Vector3((x - r * 1000) / 1000, y, (z - r * 1000) / 1000), new THREE.Vector3((x + r * 1000) / 1000, y, (z - r * 1000) / 1000), new THREE.Vector3((x + r * 1000) / 1000, y, (z + r * 1000) / 1000), new THREE.Vector3((x - r * 1000) / 1000, y, (z + r * 1000) / 1000)]);
  };
  /** 2 点目: 壁を足す。外形の線上なら外壁（外向きは外形の内外で決める）、そうでなければ間仕切り */
  const addWallTo = (f: Floor, a: { x: number; y: number }, b: { x: number; y: number }, joinedA: boolean, joinedB: boolean) => {
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 200) {
      toast('短すぎます（20cm 以上）');
      return false;
    }
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const loops = f.outline.filter((l) => l.length >= 3);
    const distToOutline = Math.min(Infinity, ...loops.flatMap((l) => l.map((p, i) => distPointSegment(mid, p, l[(i + 1) % l.length]))));
    const exterior = distToOutline < 200;
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    // a→b に対して左側の法線
    const n = { x: -uy, y: ux };
    const probe = { x: mid.x + n.x * 400, y: mid.y + n.y * 400 };
    const leftInside = loops.some((l) => pointInPolygon(probe, l));
    const thick = exterior ? Math.max(120, ...f.walls.filter((w) => w.exterior).map((w) => w.thickness)) : Math.max(90, Math.min(...f.walls.filter((w) => !w.exterior).map((w) => w.thickness), 120));
    const wall: Wall = { id: `F${f.level}-W${Date.now().toString(36)}`, a: { ...a }, b: { ...b }, thickness: thick, exterior, joinedA, joinedB, ...(exterior ? { outsideSign: (leftInside ? -1 : 1) as 1 | -1 } : {}) };
    f.walls.push(wall);
    // 端がつながった既存の壁側にも「つながっている」印を付ける（小口の仕上げが外に出ないように）
    for (const w of f.walls) {
      if (w === wall) continue;
      for (const end of ['a', 'b'] as const) {
        const e = w[end];
        if ((joinedA && Math.hypot(e.x - a.x, e.y - a.y) < 1) || (joinedB && Math.hypot(e.x - b.x, e.y - b.y) < 1)) {
          if (end === 'a') w.joinedA = true;
          else w.joinedB = true;
        }
      }
    }
    toast(`${f.level}階に${exterior ? '外壁' : '間仕切り'}を足しました（${(L / 1000).toFixed(2)} m。部屋の区画は方眼の修正画面で作り直されます）`, 'ok', 3500);
    return true;
  };

  // ---- 庇（壁の外面に取り付く薄い屋根） ----
  /** 庇の 3D の位置（壁の外面から depth 出す板）。当たり判定と橙の枠に使う */
  const canopyBox = (f: Floor, c: Canopy) => {
    const w = f.walls.find((x) => x.id === c.wallId);
    if (!w) return null;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    let sg = w.outsideSign ?? 0;
    if (!sg) {
      const mid = { x: w.a.x + ux * ((c.t0 + c.t1) / 2), y: w.a.y + uy * ((c.t0 + c.t1) / 2) };
      const inside = (s: number) => f.outline.some((l) => pointInPolygon({ x: mid.x - uy * s * (w.thickness / 2 + 350), y: mid.y + ux * s * (w.thickness / 2 + 350) }, l));
      sg = inside(1) && !inside(-1) ? -1 : 1;
    }
    const nx = -uy * sg;
    const ny = ux * sg;
    const t = w.thickness / 2;
    const t0 = Math.max(0, Math.min(c.t0, c.t1));
    const t1 = Math.min(L, Math.max(c.t0, c.t1));
    const yb = f.elevation / 1000 + c.bottomMm / 1000;
    const th = (c.thickness ?? 120) / 1000;
    const slope = (c.pitch ?? 0.5) / 10;
    const D = c.depth;
    const P = (s: number, d: number, y: number) => new THREE.Vector3((w.a.x + ux * s + nx * d) / 1000, y, (w.a.y + uy * s + ny * d) / 1000);
    return { w, L, ux, uy, nx, ny, t0, t1, yb, th, D, slope, top: [P(t0, t, yb + th), P(t1, t, yb + th), P(t1, t + D, yb + th - (D / 1000) * slope), P(t0, t + D, yb + th - (D / 1000) * slope)] };
  };
  const canopyAt = (pt: THREE.Vector3): { f: Floor; c: Canopy } | null => {
    const m = model();
    if (!m?.canopies?.length) return null;
    for (const f of m.floors)
      for (const c of m.canopies) {
        if (c.level !== f.level) continue;
        const b = canopyBox(f, c);
        if (!b) continue;
        const px = pt.x * 1000 - b.w.a.x;
        const py = pt.z * 1000 - b.w.a.y;
        const s = px * b.ux + py * b.uy;
        const d = px * b.nx + py * b.ny;
        const yTip = b.yb - (b.D / 1000) * b.slope;
        if (s >= b.t0 - 60 && s <= b.t1 + 60 && d >= b.w.thickness / 2 - 80 && d <= b.w.thickness / 2 + b.D + 80 && pt.y >= Math.min(b.yb, yTip) - 0.06 && pt.y <= b.yb + b.th + 0.1) return { f, c };
      }
    return null;
  };
  const showCanopySel = () => {
    const m = model();
    const f = m && canopySel ? m.floors.find((x) => x.level === canopySel!.level) : null;
    const c = m?.canopies?.find((x) => x.id === canopySel?.id);
    const b = f && c ? canopyBox(f, c) : null;
    v.setSelection(b ? b.top.map((p) => p.clone().setY(p.y + 0.02)) : null);
  };
  /** 庇を足す（壁の始点からの位置 t0〜t1、床からの下端の高さ、出 mm）→ 選んだ状態に */
  const addCanopy = (f: Floor, w: Wall, t0: number, t1: number, bottomMm: number, depth: number) => {
    const m = model();
    if (!m) return;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const a = Math.max(0, Math.min(t0, t1));
    const b = Math.min(L, Math.max(t0, t1));
    if (b - a < 300) {
      toast('壁が短すぎて庇を付けられません');
      return;
    }
    const c: Canopy = { id: `C${f.level}-${Date.now().toString(36)}`, level: f.level, wallId: w.id, t0: Math.round(a), t1: Math.round(b), bottomMm: Math.round(bottomMm / 10) * 10, depth };
    (m.canopies ??= []).push(c);
    canopySel = { level: f.level, id: c.id };
    opSel = null;
    opSpot = null;
    toast(`庇を付けました（幅 ${Math.round(b - a).toLocaleString()}・出 ${depth}）。右で出・高さ・幅を直せます`, 'ok', 3000);
    commit();
  };

  const onPick = (pt0: THREE.Vector3, ndc?: THREE.Vector2) => {
    if (mode === 'opening' && wallDraw.on) {
      // 壁を足す: 床の点（屋根・家具越しでもその下の床）を半間の格子か壁の端に吸着
      const fp = (ndc ? v.pickFloorPoint(ndc) : null) ?? pt0;
      const f = floorAt(fp.y);
      if (!f) return;
      const snap = snapWallPoint(f, { x: fp.x * 1000, y: fp.z * 1000 });
      if (!wallDraw.a || wallDraw.level !== f.level) {
        wallDraw = { on: true, level: f.level, a: snap.p };
        toast(`${f.level}階 1 点目（${snap.joined ? '壁の端' : '格子'}）。次に 2 点目の床をクリック`, 'info', 2500);
        showWallDrawMark();
        render();
        return;
      }
      const a = wallDraw.a;
      const joinedA = f.walls.some((w) => Math.hypot(w.a.x - a.x, w.a.y - a.y) < 1 || Math.hypot(w.b.x - a.x, w.b.y - a.y) < 1);
      if (addWallTo(f, a, snap.p, joinedA, snap.joined)) {
        // 続けて描けるように 2 点目を次の 1 点目に
        wallDraw = { on: true, level: f.level, a: snap.p };
        commit();
        showWallDrawMark();
      }
      return;
    }
    if (mode === 'roof' && roofDraw.on) {
      // 屋根を足す: 床の点（屋根・家具越しでもその下の床）を壁の端か半間の格子に吸着。2 回目の角で四角形の屋根を足す
      const fp = (ndc ? v.pickFloorPoint(ndc) : null) ?? pt0;
      const f = floorAt(fp.y);
      if (!f) return;
      const snap = snapWallPoint(f, { x: fp.x * 1000, y: fp.z * 1000 });
      if (!roofDraw.a || roofDraw.level !== f.level) {
        roofDraw = { on: true, level: f.level, a: snap.p };
        toast(`${f.level}階 屋根の 1 つ目の角（${snap.joined ? '壁の端' : '格子'}）。次に対角の角の床をクリック`, 'info', 2500);
        showRoofDrawMark();
        render();
        return;
      }
      if (addRoofRect(f, roofDraw.a, snap.p)) {
        roofDraw = { on: false, level: null, a: null };
        commit();
      }
      return;
    }
    if (mode === 'roof') {
      const hit = ndc ? v.pickHit(ndc) : null;
      const p = hit ? { x: hit.point.x * 1000, y: hit.point.z * 1000 } : { x: pt0.x * 1000, y: pt0.z * 1000 };
      if (hit && (hit.group === 'furniture' || hit.group === 'landscape') && ndc && v.onPickIdle?.(hit, ndc)) return;
      const ms = selectMassAt(p);
      if (!ms) toast('屋根をクリックして選んでください（軒の下の壁でも可）');
      else toast(`${massName(ms)}を選びました`, 'ok', 2500);
      render();
      return;
    }
    // 階段の回すハンドルをクリックした: 回すのはドラッグの終わり（dragEnd）。ここで選び直すと、回した直後に選択が外れる
    if (mode === 'stairs' && ndc && v.pickHandle(ndc)) return;
    // 見ている物を優先: 家具・外構の物ならその道具へ。床なら部屋（天井高・床）、壁・窓・戸なら窓・戸、屋根なら屋根。シャッターの道具のときは従来どおり外壁
    if (mode !== 'shutter' && ndc) {
      const hit = v.pickHit(ndc);
      // 階段（段・手すり）をクリック: どのモードでも階段を選ぶ
      if (hit && (hit.group === 'building' || hit.group === 'cut') && STAIR_KEYS.test(hit.matKey)) {
        const sr = stairAt3d(hit.point, hit.matKey);
        if (sr) {
          selectStair(sr);
          return;
        }
      }
      if (hit && mode === 'stairs') {
        stairSel = null;
        render();
        toast('階段の段をクリックして選びます');
        return;
      }
      if (hit) {
        if (hit.group === 'furniture' || hit.group === 'landscape') {
          if (v.onPickIdle?.(hit, ndc)) return;
          // 家具・外構の飾り（照明の笠・植栽の鉢など、選べる物に属さない部品）: 壁を選びに行かない
          toast(hit.group === 'furniture' ? '家具・造作をクリックすると「家具」の道具で直せます' : '置いた物をクリックすると「外構」の道具で直せます', 'info', 2500);
          return;
        }
        if (mode === 'opening' && hit.matKey === 'ext.canopy') {
          const cs = canopyAt(hit.point);
          if (cs) {
            canopySel = { level: cs.f.level, id: cs.c.id };
            opSel = null;
            opSpot = null;
            showCanopySel();
            render();
            toast('庇を選びました（出・高さ・幅・消す）', 'ok', 2000);
            return;
          }
        }
        if ((hit.group === 'roof' || ROOF_KEYS.test(hit.matKey)) && pickHere(hit, ndc)) return;
        if (mode === 'opening' && FLOOR_KEYS.test(hit.matKey) && pickHere(hit, ndc)) return;
        if (mode === 'ceiling' && WALL_KEYS.test(hit.matKey) && pickHere(hit, ndc)) return;
      }
    }
    if (mode === 'stairs') {
      // 階段の道具: 階段以外の所（何も無い所）をクリックしたら選ぶのをやめる（下のシャッターの処理へ進ませない）
      stairSel = null;
      render();
      return;
    }
    // 天井高: 屋根越しに見ているときは、その下の床の点を使う（屋根の点では隣の部屋になる）
    let pt = mode === 'ceiling' && ndc ? (v.pickFloorPoint(ndc) ?? pt0) : pt0;
    if (mode === 'opening' && ndc) {
      // 窓・戸: ガラス・枠・戸そのものをクリックしたときは、その面の点を使う。
      // pt0（pickPoint）はガラスを透かして奥の床に当たるので、外から斜めに見ると壁から 50cm 以上離れた点になり、窓を選べなかった
      const hit = v.pickHit(ndc);
      if (hit && (hit.group === 'building' || hit.group === 'cut') && /^(ext|int)\.(door|glass\w*|shutter|frame|sash)/.test(hit.matKey)) pt = hit.point;
    }
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
      canopySel = null;
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
    if (!(active && ((mode === 'opening' && opSel && !canopySel && !wallDraw.on) || (mode === 'roof' && roofSel && !roofDraw.on) || (mode === 'stairs' && stairSel)))) v.setHandles(null);
    if (!(active && mode === 'opening' && opSel && !canopySel && !wallDraw.on)) {
      v.setDimLines(null);
      if (v.onDimEdit === applyOpGapEdit) v.onDimEdit = null;
    }
    if (active && mode === 'opening' && wallDraw.on) showWallDrawMark();
    if (active && mode === 'opening' && canopySel) showCanopySel();
    else if (active && mode === 'opening') showOpSel();
    else if (active && mode === 'roof') {
      if (roofDraw.on && roofDraw.a) showRoofDrawMark();
      else showRoofSel();
    }
    else if (active && mode === 'stairs') showStairSel();
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
    panel.append(h('div', { class: 'furn-head' }, h('span', null, '3D で直す'), h('button', { class: 'btn xs ghost', onclick: () => setActive(false) }, '閉じる')), h('div', { style: 'display:flex;gap:6px;margin:4px 0 8px;flex-wrap:wrap' }, modeBtn('opening', '窓・戸'), modeBtn('ceiling', '天井高'), modeBtn('shutter', 'シャッター'), modeBtn('roof', '屋根'), modeBtn('stairs', '階段')));
    if (mode === 'opening') {
      renderOpening(m);
      return;
    }
    if (mode === 'stairs') {
      renderStairs(m);
      return;
    }
    if (mode === 'roof') {
      renderRoof(m);
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
              { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value as VoidGuard | ''; for (const { r } of voids) { if (v) r.voidGuard = v; else delete r.voidGuard; } toast(v ? `吹抜の縁を${VOID_GUARD_LABEL[v]}にしました` : '家全体の設定に戻しました', 'ok'); commit(); } },
              h('option', { value: '', selected: !g }, '家全体の設定のまま（パースの「納まり」）'),
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

  /** 階段のパネル: 選んだ階段の向き・種類・曲がる向き・上る/下る・寸法。未選択なら階段の一覧（押すと選ぶ） */
  const renderStairs = (m: BuildingModel | null) => {
    const s = selectedStair();
    if (!s || !m) {
      const all = m ? m.floors.flatMap((f) => f.stairs.filter((x) => x.goesUp).map((st) => ({ f, st }))) : [];
      panel.append(
        h('p', { class: 'hint', style: 'margin:0 0 6px' }, '階段の段をクリックして選びます。選んだ階段はドラッグで移動、回すハンドル（または R キー）で 90° ずつ回せます。上の階の同じ位置の階段（DN）も一緒に動きます。'),
        all.length
          ? h('div', { class: 'btn-row' }, ...all.map(({ f, st }) => h('button', { class: 'btn sm', onclick: () => selectStair({ f, st }) }, `${f.level}階 ${STAIR_SHORT[st.kind]}`)))
          : h('p', { class: 'hint' }, '上の階へ上る階段がありません（方眼の「階段」で描けます）'),
      );
      return;
    }
    const { f, st } = s;
    const linked = linkedStairs(m, f.level, st);
    const w = st.maxX - st.minX;
    const d = st.maxY - st.minY;
    const num = (label: string, get: () => number, set: (val: number) => void) =>
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('input', { type: 'number', step: 5, value: Math.round(get()), onchange: (e: Event) => { const val = Number((e.target as HTMLInputElement).value); if (val > 0) set(val); } }));
    panel.append(
      h('div', { class: 'furn-sel' }, h('div', null, h('b', null, `${f.level}階 ${STAIR_SHORT[st.kind]}`), `（${w.toLocaleString()} × ${d.toLocaleString()}・昇り口: ${STAIR_ENTRY_LABEL[st.entry]}）`), linked.length ? h('div', { class: 'hint', style: 'margin:2px 0 0' }, `${linked.map((l) => `${l.f.level}階`).join('・')}の同じ位置の階段（${linked[0].st.goesUp ? 'UP' : 'DN'}）も一緒に動きます`) : null),
      h('div', { class: 'field-label', style: 'margin-top:6px' }, '向き'),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn sm', title: 'Shift+R', onclick: () => turnStair(s, linked, -1) }, '⟲ 左へ 90°'),
        h('button', { class: 'btn sm', title: 'R', onclick: () => turnStair(s, linked, 1) }, '⟳ 右へ 90°'),
        st.kind !== 'straight' ? h('button', { class: 'btn sm', onclick: () => editStair((x) => { x.turn = (x.turn ?? (x.kind === 'l' ? 'right' : 'left')) === 'left' ? 'right' : 'left'; }, '曲がる向きを反対にしました') }, '曲がる向きを反対に') : null,
      ),
      h('div', { class: 'field-label', style: 'margin-top:8px' }, '種類'),
      segButtons(
        (Object.keys(STAIR_SHORT) as Stair['kind'][]).map((k) => ({ v: k, label: STAIR_SHORT[k].replace('階段', ''), title: STAIR_KIND_LABEL[k] })),
        st.kind,
        (val) => editStair((x) => { x.kind = val as Stair['kind']; }, `${STAIR_SHORT[val as Stair['kind']]}にしました`),
      ),
      ...(st.kind === 'uOpen' && w < 2100 && d < 2100 ? [h('p', { class: 'warn' }, 'コの字階段は幅 2,100 以上（段 910 × 2 ＋ 吹抜 300）が要ります。狭いので折り返しとして描いています')] : []),
      // コの字階段の角: 四角い踊り場か、回り段（図面の角の斜めの線の数）
      ...(st.kind === 'uOpen'
        ? [
            h('div', { class: 'field-label', style: 'margin-top:8px', title: '図面の角に斜めの線が 1 本なら「回り段 2 段」、2 本なら「3 段回り」です' }, '角（コの字の 2 つの角）'),
            segButtons(
              [
                { v: '1', label: '踊り場', title: '四角い踊り場（1 段ぶん）' },
                { v: '2', label: '回り段 2 段', title: '斜めの線 1 本で 2 段に割る' },
                { v: '3', label: '3 段回り', title: '30°ずつ 3 段に割る' },
              ],
              String(st.cornerSteps ?? 1),
              (val) => editStair((x) => { if (val === '1') delete x.cornerSteps; else x.cornerSteps = Number(val) as 2 | 3; }, `角を「${val === '1' ? '踊り場' : val === '2' ? '回り段 2 段' : '3 段回り'}」にしました`),
            ),
          ]
        : []),
      // 昇り口の広い段（ひな壇）: 最初の列の段を、床からの台にする（脇の列のあるコの字階段）
      ...((wrapFlights(st)?.len1 ?? 0) > 0
        ? [
            h('div', { class: 'field-label', style: 'margin-top:8px', title: '最初の数段を、床からの厚い板の台にします。図面では、最初の列の段の線が列の外まで伸びた入れ子の四角で描かれます' }, '昇り口の広い段（ひな壇）'),
            segButtons(
              [
                { v: '0', label: 'なし' },
                { v: '1', label: '1 段' },
                { v: '2', label: '2 段' },
                { v: '3', label: '3 段' },
                { v: '4', label: '4 段' },
              ],
              String(Math.min(4, st.wideSteps ?? 0)),
              (val) =>
                editStair(
                  (x) => {
                    const n = Number(val);
                    if (n > 0) x.wideSteps = n;
                    else {
                      delete x.wideSteps;
                      delete x.wideShape;
                    }
                  },
                  val === '0' ? '昇り口の広い段をやめました' : `最初の ${val} 段を広い段（ひな壇）にしました`,
                ),
            ),
            ...(st.wideSteps
              ? [
                  segButtons(
                    [
                      { v: 'full', label: '幅いっぱい', title: 'どの段も階段室の幅いっぱいの台' },
                      { v: 'corner', label: '角から 2 方向', title: '2 段目から上は、手前と脇の 2 方向に下りる角のひな壇' },
                    ],
                    st.wideShape ?? 'full',
                    (val) => editStair((x) => { if (val === 'corner') x.wideShape = 'corner'; else delete x.wideShape; }, `ひな壇を「${val === 'corner' ? '角から 2 方向' : '幅いっぱい'}」にしました`),
                  ),
                ]
              : []),
          ]
        : []),
      // 階段のつくり = コーディネートの「階段」の品目（家に 1 つ。3D・説明文・仕様書・見積が同じ品目を見る）
      h('div', { class: 'field-label', style: 'margin-top:8px', title: 'コーディネートの「階段」と同じ品目です。家じゅうの階段に共通で、仕様書・見積の品目も同じになります' }, 'つくり（家じゅうの階段に共通）'),
      segButtons(
        STAIR_BUILDS.map((k) => ({ v: k, label: STAIR_BUILD_LABEL[k].replace(/（.*）/, ''), title: STAIR_BUILD_LABEL[k] })),
        stairBuildNow(),
        (val) => {
          if (!setStairBuild(val as StairBuild)) return;
          toast(`階段を「${STAIR_BUILD_LABEL[val as StairBuild].replace(/（.*）/, '')}」にしました（コーディネートの「階段」も同じ品目です）`, 'ok', 3500);
          render();
        },
      ),
      // こだわり指定（参考資料）: この階段の桁・手すり・踏板の色・鉄の色を変える。参考画像・ひとこと・段数は「参考資料」の画面で
      ...(stairBuildNow() === 'steel'
        ? [
            h('div', { class: 'field-label', style: 'margin-top:8px', title: '御社の施工事例は、両側の黒い鋼板のささら桁で踏板を挟む形です' }, '鉄骨の桁'),
            segButtons(
              STAIR_STRINGERS.map((k) => ({ v: k, label: STAIR_STRINGER_LABEL[k] })),
              st.look?.stringer ?? stairStringerOf(state.design),
              (val) => changeLook(f.level, { stringer: val as StairStringer }, `${f.level}階の階段の桁を「${STAIR_STRINGER_LABEL[val as StairStringer]}」にしました`),
            ),
          ]
        : []),
      h('div', { class: 'field-label', style: 'margin-top:8px' }, '手すり'),
      segButtons(
        STAIR_RAILS.map((k) => ({ v: k, label: STAIR_RAIL_LABEL[k].replace(/（.*）/, ''), title: STAIR_RAIL_LABEL[k] })),
        st.look?.rail ?? st.rail ?? 'bar',
        (val) => changeLook(f.level, { rail: val as StairRail }, `${f.level}階の階段の手すりを「${STAIR_RAIL_LABEL[val as StairRail].replace(/（.*）/, '')}」にしました`),
      ),
      h('div', { class: 'field-label', style: 'margin-top:8px' }, '踏板の色'),
      segButtons(
        STAIR_TREADS.map((k) => ({ v: k, label: STAIR_TREAD_LABEL[k].replace(/（.*）/, ''), title: STAIR_TREAD_LABEL[k] })),
        st.look?.tread ?? 'floor',
        (val) => changeLook(f.level, { tread: val as StairTread }, `${f.level}階の階段の踏板を「${STAIR_TREAD_LABEL[val as StairTread]}」にしました`),
      ),
      h('div', { class: 'field-label', style: 'margin-top:8px' }, '鉄の色（桁・アイアンの手すり）'),
      segButtons(
        STAIR_FRAMES.map((k) => ({ v: k, label: STAIR_FRAME_LABEL[k] })),
        st.look?.frame ?? 'black',
        (val) => changeLook(f.level, { frame: val as StairFrame }, `${f.level}階の階段の鉄の色を「${STAIR_FRAME_LABEL[val as StairFrame]}」にしました`),
      ),
      (() => {
        const notes = focusNotes();
        const note = stairNoteFor(notes, f.level);
        // 直す指定: その階を決めたもの。階段が 1 か所だけの家は「すべての階段」の指定（3D のつくり・手すりのボタンと同じ決まり）
        const editIdx = stairNoteIndexToEdit(notes, f.level, stairLevels(state.model));
        const n = note?.images.length ?? 0;
        return h(
          'div',
          { class: 'btn-row', style: 'margin-top:6px' },
          h(
            'button',
            {
              class: 'btn sm',
              title: '「この写真のような階段で提案したい」を添えます。参考画像とひとことは、パースの仕上げ（カット集・AI 仕上げ）にも伝わります。段数の指定もここで',
              onclick: () => openFocusDialog({ ...(editIdx >= 0 ? { editId: notes[editIdx].id } : { part: 'stair' as const, level: f.level }), onClose: () => commit() }),
            },
            n ? `参考資料（画像 ${n} 枚${note?.note ? '・ひとこと' : ''}）を直す` : '参考画像・ひとこと・段数を添える',
          ),
        );
      })(),
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 8px;margin-top:6px' }, num('幅 W (mm)', () => w, (val) => editStair((x) => { x.maxX = x.minX + Math.max(600, val); }, `幅を ${mmText(Math.max(600, val))} mm にしました`)), num('奥行 D (mm)', () => d, (val) => editStair((x) => { x.maxY = x.minY + Math.max(600, val); }, `奥行を ${mmText(Math.max(600, val))} mm にしました`))),
      h('p', { class: 'hint' }, 'ドラッグで移動（半間の格子に止まる。Shift で自由）、矢印キーで 10 mm（Shift 100・Ctrl 半間）。上の階の床の穴（吹抜）も一緒に動きます。'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn sm ghost', onclick: () => removeStair() }, 'この階段を消す（Delete）'), h('button', { class: 'btn sm ghost', onclick: () => { stairSel = null; render(); } }, '選ぶのをやめる（Esc）')),
    );
  };
  /** 屋根のパネル: 全体の掛け方と、選んだ塊の掛け方・向き・勾配・軒の出・パラペット */
  const renderRoof = (m: BuildingModel | null) => {
    const ext = exteriorById(state.design.exteriorId);
    const wholeKind: RoofKind = state.design.roofOverride ?? ext.roof.type;
    const wholePitch = state.design.roofPitch ?? ext.roof.pitch;
    const setWhole = (patch: Partial<typeof state.design>) => {
      state.design = { ...state.design, ...patch };
      emit('design');
      v.setDesign(state.design);
      render();
    };
    const seg = segButtons;
    panel.append(
      h('p', { class: 'hint', style: 'margin:0 0 6px' }, '屋根をクリックして塊を選びます（橙の枠）。塊ごとに掛け方・向き・勾配・軒の出を変えられます。最上階の塊と下屋（下の階の、上の階が載らない所）は別の塊です。'),
      h('div', { class: 'field-label' }, `全体の屋根（${ROOF_KIND_LABEL[wholeKind]}${wholeKind === 'flat' ? '' : ` ${wholePitch} 寸`}・軒 ${state.design.eaves ?? ext.roof.eaves} mm）`),
      seg(
        [{ v: 'auto', label: 'テイスト' }, ...(Object.keys(ROOF_KIND_LABEL) as RoofKind[]).map((k) => ({ v: k, label: ROOF_KIND_LABEL[k] }))],
        state.design.roofOverride ?? 'auto',
        (val) => {
          // 切妻・寄棟にしたのに勾配が緩い（片流れ用の 0.5 寸）ままでは平らに見えるので、4 寸にしておく
          const steep = (val === 'gable' || val === 'hip') && wholePitch < 2.5 && state.design.roofPitch == null;
          setWhole({ roofOverride: val === 'auto' ? undefined : (val as RoofKind), ...(steep ? { roofPitch: 4 } : {}) });
        },
      ),
    );
    // 足す: 屋根（抜けている所・ポーチ・カーポート）と壁（抜けている所）
    if (roofDraw.on) {
      panel.append(
        h('div', { class: 'furn-sel', style: 'margin-top:8px' }, h('div', { class: 'field-label' }, '屋根を足す'), h('div', { class: 'hint' }, roofDraw.a ? `${roofDraw.level}階 1 つ目の角を取りました（橙）。対角の角の床をクリックすると四角形の屋根になります。` : '屋根を掛けたい範囲の床を、四角形の対角の 2 点でクリックします（壁の端に吸着、無ければ半間の格子）。屋根の高さはその階の壁の天端。')),
        h('div', { class: 'btn-row' }, roofDraw.a ? h('button', { class: 'btn sm', onclick: () => { roofDraw = { on: true, level: null, a: null }; v.setSelection(null); render(); } }, '1 つ目を取り直す') : null, h('button', { class: 'btn sm ghost', onclick: () => { roofDraw = { on: false, level: null, a: null }; v.setSelection(null); render(); } }, '屋根を足すのをやめる')),
        h('p', { class: 'hint' }, '屋根が抜けている所を塞ぐ・ポーチやカーポートに屋根を掛けるときに。足した屋根は 3D でクリックすると掛け方・向き・勾配・高さを直せ、消せます。'),
      );
      return;
    }
    const ms = selectedMass();
    const addRow = h(
      'div',
      { class: 'btn-row', style: 'margin-top:8px' },
      h('button', { class: 'btn sm', onclick: () => { roofDraw = { on: true, level: null, a: null }; roofSel = null; v.setSelection(null); render(); } }, '屋根を足す（床を 2 回クリックで四角）'),
      h('button', { class: 'btn sm', onclick: () => { mode = 'opening'; wallDraw = { on: true, level: null, a: null }; roofSel = null; opSel = null; opSpot = null; v.setSelection(null); render(); } }, '壁を足す（床を 2 回クリック）'),
    );
    if (!ms || !m) {
      const n = m?.roofPatches?.length ?? 0;
      const added = m?.roofPatches?.filter((x) => patchLoop(x)).length ?? 0;
      const fromElev = m?.roofPatches?.filter((x) => x.source === 'elevation').length ?? 0;
      panel.append(addRow, h('p', { class: 'hint', style: 'margin-top:8px' }, n ? `塊ごとの手直し ${n - added} か所${fromElev ? `（うち立面図から読んだ掛け方 ${fromElev} か所）` : ''}${added ? `・手で描いた屋根・屋根なし ${added} か所` : ''}` : 'まだ塊を選んでいません'));
      if (n > added)
        panel.append(
          h('div', { class: 'btn-row' }, h('button', { class: 'btn sm ghost', onclick: () => { if (m) m.roofPatches = m.roofPatches?.filter((x) => patchLoop(x)) ?? []; toast('屋根の手直しをすべておまかせに戻しました（手で描いた屋根は残します）', 'ok'); commit(); } }, 'すべておまかせに戻す')),
        );
      return;
    }
    const p = ms.patch;
    const north = m.northAngleDeg;
    panel.append(
      h('div', { class: 'furn-sel', style: 'margin-top:8px' }, h('div', { class: 'field-label' }, massName(ms), massSourceTag(ms)), h('div', { class: 'hint' }, massState(ms, north))),
      ...roofPatchControls({
        model: m,
        ms,
        wholePitch,
        wholeEaves: state.design.eaves ?? ext.roof.eaves,
        edit: patchRoof,
        remove: () => {
          if (p) m.roofPatches = (m.roofPatches ?? []).filter((x) => x !== p);
          roofSel = null;
          v.setSelection(null);
          toast(ms.omit ? '屋根なしの範囲を消しました' : '足した屋根を消しました', 'ok');
          commit();
        },
        deselect: () => { roofSel = null; render(); },
      }),
      addRow,
      h('p', { class: 'hint' }, '屋根が抜けている所は「屋根を足す」で塞げます。形を自由に描く・角を動かす・屋根なしの範囲は、図面読込の方眼の「屋根」の道具で。外形（外壁）が欠けて屋根が出ないときは「壁を足す」か方眼で外壁を直すと屋根も作り直されます。'),
    );
  };

  /** 窓・戸のパネル: 選んだ開口の種類・形・幅・腰高・高さ・開き方。無い所をクリックしたら「ここに置く」 */
  const renderOpening = (m: BuildingModel | null) => {
    const f = m && opSel ? m.floors.find((x) => x.level === opSel!.level) : null;
    const op = f?.openings.find((o) => o.id === opSel!.id);
    if (wallDraw.on) {
      panel.append(
        h('div', { class: 'furn-sel' }, h('div', { class: 'field-label' }, '壁を足す'), h('div', { class: 'hint' }, wallDraw.a ? `${wallDraw.level}階 1 点目を取りました（橙）。2 点目の床をクリックすると壁になります。続けてクリックすると次の壁。` : '床を 2 回クリックします（壁の端に吸着、無ければ半間の格子）。外形の線上なら外壁、そうでなければ間仕切りになります。')),
        h('div', { class: 'btn-row' }, wallDraw.a ? h('button', { class: 'btn sm', onclick: () => { wallDraw = { on: true, level: null, a: null }; v.setSelection(null); render(); } }, '1 点目を取り直す') : null, h('button', { class: 'btn sm ghost', onclick: () => { wallDraw = { on: false, level: null, a: null }; v.setSelection(null); render(); } }, '壁を足すのをやめる')),
        h('p', { class: 'hint' }, '壁の抜け（外から室内が見える所）を塞ぐときに。部屋の区画や平面図は、方眼の修正画面で作り直されます。'),
      );
      return;
    }
    if (canopySel && m) {
      const cf = m.floors.find((x) => x.level === canopySel!.level);
      const c = m.canopies?.find((x) => x.id === canopySel!.id);
      const cw = cf?.walls.find((x) => x.id === c?.wallId);
      if (cf && c && cw) {
        const L = Math.hypot(cw.b.x - cw.a.x, cw.b.y - cw.a.y);
        const upd = (fn: () => void) => {
          fn();
          const a = Math.max(0, Math.min(c.t0, c.t1));
          const b = Math.min(L, Math.max(c.t0, c.t1));
          c.t0 = a;
          c.t1 = b;
          commit();
        };
        const segN = (items: number[], cur: number, fmt: (x: number) => string, set: (x: number) => void) => h('div', { class: 'segmented' }, ...items.map((x) => h('button', { class: Math.abs(cur - x) < 0.01 ? 'on' : '', onclick: () => upd(() => set(x)) }, fmt(x))));
        const num = (label: string, get: () => number, set: (v: number) => void, step = 10) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('input', { type: 'number', value: Math.round(get()), step, onchange: (e: Event) => upd(() => set(+(e.target as HTMLInputElement).value)) }));
        panel.append(
          h('div', { class: 'furn-sel' }, h('div', { class: 'field-label' }, `${cf.level}階 庇（幅 ${Math.round(c.t1 - c.t0).toLocaleString()}・出 ${c.depth.toLocaleString()}・下端 FL+${c.bottomMm.toLocaleString()}）`), h('div', { class: 'hint' }, '壁の外面から出る薄い板。先端がわずかに下がります（勾配）。窓の上なら下端は窓の上端＋100 が目安。')),
          h('div', { class: 'field-label' }, '出 (mm)'),
          segN([450, 600, 900, 1200, 1500, 1820], c.depth, (x) => x.toLocaleString(), (x) => (c.depth = x)),
          h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 8px' }, num('下端の高さ FL+ (mm)', () => c.bottomMm, (v) => (c.bottomMm = Math.max(1500, v)), 50), num('幅 (mm)', () => c.t1 - c.t0, (v) => { const mid = (c.t0 + c.t1) / 2; const w2 = Math.max(300, v) / 2; c.t0 = mid - w2; c.t1 = mid + w2; }, 50)),
          h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 8px' }, num('壁の始点から (mm)', () => c.t0, (v) => { const w0 = c.t1 - c.t0; c.t0 = v; c.t1 = v + w0; }, 50), num('厚み (mm)', () => c.thickness ?? 120, (v) => (c.thickness = Math.max(40, v)), 20)),
          h('div', { class: 'field-label' }, '勾配（寸）'),
          segN([0, 0.5, 1, 2, 3], c.pitch ?? 0.5, (x) => `${x}`, (x) => (c.pitch = x)),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => { m.canopies = (m.canopies ?? []).filter((x) => x.id !== c.id); if (!m.canopies.length) delete m.canopies; canopySel = null; v.setSelection(null); toast('庇を消しました', 'ok'); commit(); } }, '消す'), h('button', { class: 'btn sm ghost', onclick: () => { canopySel = null; v.setSelection(null); render(); } }, '選ぶのをやめる')),
        );
        return;
      }
      canopySel = null;
    }
    panel.append(h('p', { class: 'hint', style: 'margin:0 0 6px' }, opSel ? '橙の枠が選んだ窓・戸。そのまま掴んで壁に沿ってドラッグで動かせます（半間の格子に止まり、隣の窓・戸の手前で止まります）。黒の札は幅・高さ・腰高、青の札は隣の窓・戸や壁の端までの空きで、青をクリックして数値を打つとその位置に動きます。矢印キー ← → で 10 mm（Shift 100・Ctrl 半間）、窓は ↑ ↓ で腰高 50 mm ずつ。' : '窓・戸をクリックして選びます。パースを見ながら形（掃き出し／腰窓…）・幅・高さ・吊元を変えられます。何も無い壁をクリックすると、そこに置けます。'));
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
        h('div', { class: 'furn-sel' }, h('div', { class: 'field-label' }, `${f.level}階 ${openingLabel(op)}`), h('div', { class: 'hint' }, openingSummary(op))),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '種類'), h('select', { onchange: (e: Event) => change(() => applyOpeningKind(op, (e.target as HTMLSelectElement).value as Opening['kind'], f.ceilingHeight)) }, OPENING_KINDS.map((k) => h('option', { value: k, selected: k === op.kind }, OPENING_LABEL[k])))),
      );
      if (op.kind === 'window') {
        const width = op.t1 - op.t0;
        const std = isStandardSashWidth(width);
        panel.append(
          h('div', { class: 'field-label' }, '窓の形'),
          h('div', { class: 'segmented' }, ...(Object.keys(WINDOW_SHAPES) as (keyof typeof WINDOW_SHAPES)[]).map((k) => h('button', { class: (op.windowStyle ?? (isSlidingWindow(op) ? (op.sill === 0 ? 'hakidashi' : 'koshi') : 'small')) === k ? 'on' : '', title: WINDOW_SHAPES[k].label, onclick: () => change(() => applyWindowShape(op, k, f.ceilingHeight, wallLen)) }, WINDOW_SHAPES[k].short))),
          h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 8px' }, numField('腰高 (mm)', () => op.sill, (v) => (op.sill = Math.max(0, v)), 50), numField('高さ (mm)', () => op.height, (v) => (op.height = Math.max(200, v)), 50)),
          // 間仕切り（外壁でない壁）の窓: 室内窓（部屋と部屋の間のガラス）か、外に面した窓か
          ...(wall && !wall.exterior
            ? [
                h('div', { class: 'field-label' }, '間仕切りの窓の扱い'),
                h(
                  'div',
                  { class: 'segmented' },
                  h('button', { class: op.interior ? 'on' : '', title: '部屋と部屋の間のガラス（FIX）。カーテン・水切りを付けず、採光の窓には数えません', onclick: () => change(() => setInteriorWindow(op, true)) }, '室内窓'),
                  h('button', { class: !op.interior ? 'on' : '', title: '中庭・バルコニーなど、外に面した窓として扱います', onclick: () => change(() => setInteriorWindow(op, false)) }, '外に面した窓'),
                ),
              ]
            : []),
          // 標準の幅（半間の割）: 柱芯 910 → 780、1,365 → 1,235、1,820 → 1,690、2,730 → 2,600 …
          h('div', { class: 'field-label' }, std ? '幅（標準の寸法）' : `幅 W${Math.round(width).toLocaleString()} は半間の割に合いません → ${sashWidthLabel(nearestSashWidth(width))} が近い寸法`),
          h('div', { class: 'segmented' }, ...SASH_QUICK_WIDTHS.map((x) => h('button', { class: Math.abs(width - x) <= 70 ? 'on' : '', title: sashWidthLabel(x), disabled: x > wallLen - 40, onclick: () => change(() => setOpeningWidth(op, x, wallLen)) }, x.toLocaleString()))),
        );
      }
      if (op.kind === 'door' || op.kind === 'entrance') {
        panel.append(
          h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => change(() => flipHinge(op)) }, '吊元を左右入れ替え'), op.kind === 'door' && !op.service ? h('button', { class: 'btn sm', onclick: () => change(() => flipSwing(op)) }, '開く向きを反対側へ') : null),
        );
        // 1 階の外壁の開き戸: 玄関ドア（庇・ポーチ付き）か勝手口（庇・ポーチなし。ガレージの通用口も）か
        if (wall?.exterior && f.level === 1)
          panel.append(
            h('div', { class: 'field-label' }, '外へ出る戸の役割'),
            h(
              'div',
              { class: 'segmented' },
              h('button', { class: op.kind === 'entrance' || !op.service ? 'on' : '', title: '庇とポーチが付きます', onclick: () => change(() => setExteriorDoorRole(op, 'entrance', f.ceilingHeight)) }, '玄関ドア'),
              h('button', { class: op.kind === 'door' && op.service ? 'on' : '', title: '庇・ポーチなしの外部ドア（ガレージの通用口もこちら）', onclick: () => change(() => setExteriorDoorRole(op, 'service', f.ceilingHeight)) }, '勝手口'),
            ),
          );
      }
      if (op.kind === 'sliding')
        panel.append(
          h('div', { class: 'btn-row' }, op.t1 - op.t0 < 1200 ? h('button', { class: 'btn sm', onclick: () => change(() => flipHinge(op)) }, '引き込む側を入れ替え') : null, h('button', { class: 'btn sm', onclick: () => change(() => flipSwing(op)) }, '戸の面を反対側へ')),
        );
      panel.append(
        h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 8px' }, numField('幅 (mm)', () => op.t1 - op.t0, (v) => setOpeningWidth(op, v, wallLen)), numField('壁の始点から (mm)', () => op.t0, (v) => { const w0 = op.t1 - op.t0; op.t0 = Math.max(20, v); op.t1 = op.t0 + w0; }, 5)),
        h('div', { class: 'btn-row' }, wall && op.kind !== 'open' ? h('button', { class: 'btn sm', title: 'この窓・戸の上に庇を付けます（上端＋100 の高さ、左右 150 ずつ広く）', onclick: () => addCanopy(f, wall, op.t0 - 150, op.t1 + 150, op.sill + op.height + 100, op.kind === 'window' ? 900 : 1200) }, 'この上に庇を付ける') : null, h('button', { class: 'btn sm', onclick: () => { f.openings = f.openings.filter((o) => o.id !== op.id); opSel = null; commit(); } }, '消す'), h('button', { class: 'btn sm ghost', onclick: () => { opSel = null; render(); } }, '選ぶのをやめる')),
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
        // 壁の天端: 自動（天井まで／外壁は軒まで）・腰壁・袖壁・軒まで・軒より高く（パラペット）
        const eaveMm = Math.round(wallTopOf(m, fl) - fl.elevation);
        const topOpts: { v: string; label: string; mm: number | null }[] = [
          { v: 'auto', label: '自動', mm: null },
          { v: '1100', label: '腰壁 1,100', mm: 1100 },
          { v: '2400', label: '袖壁 2,400', mm: 2400 },
          { v: 'eave', label: `軒まで ${eaveMm.toLocaleString()}`, mm: eaveMm },
          { v: 'eave300', label: '軒＋300（パラペット）', mm: eaveMm + 300 },
          { v: 'eave600', label: '軒＋600', mm: eaveMm + 600 },
        ];
        const curTop = w.topMm == null ? 'auto' : topOpts.find((o) => o.mm === w.topMm)?.v ?? 'custom';
        const setTop = (mm: number | null) => {
          if (mm == null) delete w.topMm;
          else w.topMm = Math.max(300, Math.round(mm / 10) * 10);
          toast(mm == null ? '壁の高さを自動に戻しました' : `壁の天端を床から ${w.topMm!.toLocaleString()} mm にしました`, 'ok', 2500);
          commit();
        };
        panel.append(
          h('div', { class: 'furn-sel' }, h('div', { class: 'field-label' }, `${fl.level}階 ${w.exterior ? '外壁' : '内壁'}（長さ ${Math.round(L).toLocaleString()}${w.topMm != null ? `・天端 FL+${w.topMm.toLocaleString()}` : ''}）`)),
          h('div', { class: 'field-label' }, 'ここに置く'),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => put('window') }, '窓'), h('button', { class: 'btn sm', onclick: () => put('door') }, w.exterior && fl.level === 1 ? '玄関ドア' : '開き戸'), h('button', { class: 'btn sm', onclick: () => put('sliding') }, '引戸'), w.exterior ? h('button', { class: 'btn sm', title: 'ここに幅 1,820・出 900 の庇を付けます（勝手口や掃き出し窓の上、ウッドデッキの屋根に）', onclick: () => addCanopy(fl, w, opSpot!.t - 910, opSpot!.t + 910, 2200, 900) }, '庇を付ける') : null),
          h('div', { class: 'field-label', style: 'margin-top:8px' }, '壁の高さ（天端）'),
          h('div', { class: 'segmented' }, ...topOpts.map((o) => h('button', { class: curTop === o.v ? 'on' : '', onclick: () => setTop(o.mm) }, o.label))),
          h(
            'div',
            { style: 'display:flex;gap:6px;align-items:center;margin-top:4px' },
            h('input', { type: 'number', step: 50, min: 300, max: 9000, value: w.topMm ?? '', placeholder: '指定 mm', style: 'width:110px', onchange: (e: Event) => { const val = Number((e.target as HTMLInputElement).value); if (val >= 300) setTop(val); } }),
            h('span', { class: 'hint', style: 'margin:0' }, '床からの mm。袖壁の天端、パラペットの立ち上げ、腰壁に'),
          ),
          h('div', { class: 'field-label', style: 'margin-top:8px' }, w.exterior ? '壁の仕上げ（テイストのアクセント材）' : '壁の仕上げ（アクセントクロス）'),
          h('div', { class: 'segmented' }, h('button', { class: w.accent === undefined ? 'on' : '', onclick: () => setAccent(undefined) }, 'テイストのまま'), h('button', { class: w.accent === true ? 'on' : '', onclick: () => setAccent(true) }, 'アクセント'), h('button', { class: w.accent === false ? 'on' : '', onclick: () => setAccent(false) }, '通常')),
          h('p', { class: 'hint' }, w.exterior ? 'アクセント材はテイスト（外観）で決まります。' : '内壁は両面とも変わります。'),
        );
      }
      return;
    }
    const n = m ? m.floors.reduce((s, f) => s + f.openings.length, 0) : 0;
    panel.append(
      h('p', { class: 'hint' }, n ? `窓・戸 ${n} か所` : '窓・戸はまだありません'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => { wallDraw = { on: true, level: null, a: null }; opSel = null; opSpot = null; render(); } }, '壁を足す（床を 2 回クリック）')),
    );
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
      opEdge = null;
      roofHd = null;
      roofSel = null;
      stairSel = null;
      stairDrag = null;
      stairRot = null;
      wallDraw = { on: false, level: null, a: null };
      roofDraw = { on: false, level: null, a: null };
      paintOverlay();
      v.setSelection(null);
      v.setHandles(null);
    }
    render();
    btn.classList.toggle('on', on);
  }

  /** 道具を開いていないときのクリック: 床なら部屋（天井高・床の仕上げ）、壁・窓・戸なら窓・戸、屋根なら屋根の道具を開いて選ぶ。該当すれば true */
  function pickHere(hit: { matKey: string; point: THREE.Vector3; group?: string }, ndc?: THREE.Vector2): boolean {
    // 階段の段・ささら桁・手すり: 階段を選ぶ（移動・回す）
    if (STAIR_KEYS.test(hit.matKey)) {
      const sr = stairAt3d(hit.point, hit.matKey);
      if (sr) {
        selectStair(sr);
        return true;
      }
    }
    // 吹抜の縁の手すり（鉄骨・ガラス）: その吹抜を選ぶ（落下防止を 鉄骨手すり・腰壁・ガラス手すり から選べる）
    if (/^(f\.metal|ext\.glass)$/.test(hit.matKey) && hit.group !== 'furniture') {
      const fv = floorAt(hit.point.y);
      const pv = { x: hit.point.x * 1000, y: hit.point.z * 1000 };
      const vr = fv && fv.level >= 2 ? fv.rooms.find((r) => r.type === 'void' && r.polygon.some((a, i) => distPointSegment(pv, a, r.polygon[(i + 1) % r.polygon.length]) < 260)) : undefined;
      if (fv && vr) {
        if (!active) setActive(true);
        mode = 'ceiling';
        selected.clear();
        selected.add(vr.id);
        paintOverlay();
        render();
        toast(`${fv.level}階の吹抜を選びました（落下防止: 鉄骨手すり・腰壁・ガラス手すり から選べます）`, 'ok', 3500);
        return true;
      }
    }
    if (hit.group === 'roof' || ROOF_KEYS.test(hit.matKey)) {
      const ms = selectMassAt({ x: hit.point.x * 1000, y: hit.point.z * 1000 });
      if (!ms) return false;
      if (!active) setActive(true);
      mode = 'roof';
      selected.clear();
      paintOverlay();
      render();
      toast(`${massName(ms)}を選びました（掛け方・向き・勾配・軒の出）`, 'ok', 2500);
      return true;
    }
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

  const btn = h('button', { class: 'nav-btn', title: '窓・戸・壁・天井高・シャッター・屋根（3D を見ながら、窓や壁・部屋の床・屋根をクリックして直す。選んだ窓・戸はドラッグで動かす）', onclick: () => setActive(!active) }, h('span', { class: 'ic' }, '⌂'), '窓・戸');
  /** 元に戻した後: 消えた窓・戸・階段・庇の選択を外して、枠・つまみ・パネルを今のモデルに合わせる */
  const refresh = () => {
    if (opSel && !selectedOpening()) opSel = null;
    if (stairSel && !selectedStair()) stairSel = null;
    const m = model();
    if (canopySel && !m?.canopies?.some((c) => c.id === canopySel!.id)) canopySel = null;
    opSpot = null;
    paintOverlay();
    render();
  };
  return { button: btn, setActive, isActive: () => active, pickHere, dragStart, dragMove, dragEnd, refresh };
}
