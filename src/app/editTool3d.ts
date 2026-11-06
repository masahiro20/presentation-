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
import { distPointSegment, pointInPolygon } from '../core/geometry';
import { OUTDOOR_TYPES, FLOOR_FINISH_LABEL, FLOOR_OFFSET_PRESETS, VOID_GUARDS, VOID_GUARD_LABEL, ROOF_KIND_LABEL, type BuildingModel, type Floor, type FloorFinish, type Opening, type RoofHigh, type RoofKind, type RoofPatch, type Canopy, type VoidGuard, type Wall } from '../core/types';
import { SHUTTER_LAYOUTS, applyShutterLayout, autoShutterLayout, shutterLayoutOf } from '../core/shutter';
import { OPENING_LABEL, OPENING_DEFAULT, OPENING_KINDS, WINDOW_SHAPES, applyWindowShape, applyOpeningKind, setOpeningWidth, flipHinge, flipSwing, openingSummary, isSlidingWindow, clampToWall } from '../core/openings';
import { effectiveOpening, resolveSpec } from '../styles/spec';
import { roofMasses, roofMassAt, type RoofMass } from '../scene/roof';
import { SASH_QUICK_WIDTHS, isStandardSashWidth, nearestSashWidth, sashWidthLabel } from '../core/sash';
import { wallTopOf } from '../scene/building';
import { exteriorById } from '../styles/presets';
import { emit } from './state';

/** 図面の辺（上下左右）に方位を添える: 「上（北）」 */
function sideLabel(s: RoofHigh, northDeg: number): string {
  const names: Record<RoofHigh, string> = { n: '上', s: '下', e: '右', w: '左' };
  const a = (northDeg * Math.PI) / 180;
  const nv = { x: Math.sin(a), y: -Math.cos(a) };
  const ev = { x: -nv.y, y: nv.x };
  const sv: Record<RoofHigh, { x: number; y: number }> = { n: { x: 0, y: -1 }, s: { x: 0, y: 1 }, e: { x: 1, y: 0 }, w: { x: -1, y: 0 } };
  const dn = sv[s].x * nv.x + sv[s].y * nv.y;
  const de = sv[s].x * ev.x + sv[s].y * ev.y;
  const comp = Math.abs(dn) >= Math.abs(de) ? (dn > 0 ? '北' : '南') : de > 0 ? '東' : '西';
  return `${names[s]}（${comp}）`;
}

export function createEditTool3d(v: Viewer, host: HTMLElement, onModelEdited: () => void, onActivate?: () => void) {
  const panel = h('div', { class: 'furn-tool edit3d', hidden: true });
  host.appendChild(panel);
  let active = false;
  let mode: 'ceiling' | 'shutter' | 'opening' | 'roof' = 'opening';
  let ceilH = 3500;
  /** 屋根: 選んだ塊（階と、その塊の中の点） */
  let roofSel: { level: number; at: { x: number; y: number } } | null = null;
  /** 壁を足す（床を 2 回クリック）: 道具を開いている間の状態と、1 点目（図面座標 mm） */
  let wallDraw: { on: boolean; level: number | null; a: { x: number; y: number } | null } = { on: false, level: null, a: null };
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

  /** クリックした面の素材から「床」「壁・窓・戸」「屋根」を見分ける（CAD のように、見ている物をそのまま選ぶため） */
  const FLOOR_KEYS = /^int\.(floor|wetFloor|entranceFloor|tatami|slab)$|^ext\.(balcony|terrace|concrete)$/;
  const WALL_KEYS = /^(ext\.(wall|accent|glass\w*|frame|door|shutter|sash\w*)|int\.(wall|accent|bathWall|wallTop|door\w*|frame\w*|glass\w*)|f\.metal)$/;
  const ROOF_KEYS = /^ext\.(roof|soffit|fascia|gutter)$/;

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
    const y = wallTopOf(m, f) / 1000 + 0.1;
    const b = ms.bbox;
    v.setSelection([new THREE.Vector3(b.minX / 1000, y, b.minY / 1000), new THREE.Vector3(b.maxX / 1000, y, b.minY / 1000), new THREE.Vector3(b.maxX / 1000, y, b.maxY / 1000), new THREE.Vector3(b.minX / 1000, y, b.maxY / 1000)]);
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
    if (!p.kind && !p.high && !p.ridge && p.pitch == null && p.eaves == null && !p.eavesBy && p.parapet == null) m.roofPatches = list.filter((x) => x !== p);
    if (msg) toast(msg, 'ok', 2500);
    commit();
  };
  const massName = (ms: RoofMass) => `${ms.level}階の${ms.isTop ? '屋根' : '下屋'}（${((ms.bbox.maxX - ms.bbox.minX) / 1000).toFixed(1)} × ${((ms.bbox.maxY - ms.bbox.minY) / 1000).toFixed(1)} m）`;

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
    // 見ている物を優先: 家具・外構の物ならその道具へ。床なら部屋（天井高・床）、壁・窓・戸なら窓・戸、屋根なら屋根。シャッターの道具のときは従来どおり外壁
    if (mode !== 'shutter' && ndc) {
      const hit = v.pickHit(ndc);
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
    if (active && mode === 'opening' && wallDraw.on) showWallDrawMark();
    if (active && mode === 'opening' && canopySel) showCanopySel();
    else if (active && mode === 'opening') showOpSel();
    else if (active && mode === 'roof') showRoofSel();
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
    panel.append(h('div', { class: 'furn-head' }, h('span', null, '3D で直す'), h('button', { class: 'btn xs ghost', onclick: () => setActive(false) }, '閉じる')), h('div', { style: 'display:flex;gap:6px;margin:4px 0 8px;flex-wrap:wrap' }, modeBtn('opening', '窓・戸'), modeBtn('ceiling', '天井高'), modeBtn('shutter', 'シャッター'), modeBtn('roof', '屋根')));
    if (mode === 'opening') {
      renderOpening(m);
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
    const seg = (items: { v: string; label: string; title?: string }[], cur: string, on: (val: string) => void) =>
      h('div', { class: 'segmented' }, ...items.map((it) => h('button', { class: cur === it.v ? 'on' : '', title: it.title, onclick: () => on(it.v) }, it.label)));
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
    const ms = selectedMass();
    if (!ms || !m) {
      const n = m?.roofPatches?.length ?? 0;
      panel.append(h('p', { class: 'hint', style: 'margin-top:8px' }, n ? `塊ごとの手直し ${n} か所` : 'まだ塊を選んでいません'));
      if (n)
        panel.append(
          h('div', { class: 'btn-row' }, h('button', { class: 'btn sm ghost', onclick: () => { if (m) m.roofPatches = []; toast('屋根をすべておまかせに戻しました', 'ok'); commit(); } }, 'すべておまかせに戻す')),
        );
      return;
    }
    const p = ms.patch;
    const north = m.northAngleDeg;
    const kindCur = p?.kind ?? 'auto';
    panel.append(
      h('div', { class: 'furn-sel', style: 'margin-top:8px' }, h('div', { class: 'field-label' }, massName(ms)), h('div', { class: 'hint' }, `今: ${ROOF_KIND_LABEL[ms.kind]}${ms.kind === 'shed' ? `・高い側 ${sideLabel(ms.high, north)}` : ''}${ms.attached.length ? `・上の階に接する辺 ${ms.attached.map((s) => sideLabel(s, north).replace(/（.*/, '')).join('・')}` : ''}${p ? '（手直しあり）' : ''}`)),
      h('div', { class: 'field-label' }, 'この塊の掛け方'),
      seg(
        [{ v: 'auto', label: 'おまかせ', title: ms.isTop ? '全体の屋根と同じ' : '緩い片流れの下屋（上の階に接する辺が高い）' }, ...(Object.keys(ROOF_KIND_LABEL) as RoofKind[]).map((k) => ({ v: k, label: ROOF_KIND_LABEL[k] }))],
        kindCur,
        (val) =>
          patchRoof((q) => {
            if (val === 'auto') delete q.kind;
            else q.kind = val as RoofKind;
            // 切妻・寄棟にしたのに勾配が緩い（片流れ用の 0.5 寸）ままでは平らに見えるので、4 寸にしておく（勾配を決めていないときだけ）
            if ((val === 'gable' || val === 'hip') && q.pitch == null && wholePitch < 2.5) q.pitch = 4;
          }, val === 'auto' ? 'おまかせに戻しました' : `${ROOF_KIND_LABEL[val as RoofKind]}にしました`),
      ),
    );
    if (ms.kind === 'shed')
      panel.append(
        h('div', { class: 'field-label', style: 'margin-top:8px' }, '高い側（水は反対へ流れます）'),
        seg(
          [{ v: 'auto', label: 'おまかせ' }, ...(['n', 's', 'e', 'w'] as RoofHigh[]).map((s) => ({ v: s, label: sideLabel(s, north) }))],
          p?.high ?? 'auto',
          (val) => patchRoof((q) => { if (val === 'auto') delete q.high; else q.high = val as RoofHigh; }, val === 'auto' ? '向きをおまかせに戻しました' : `${sideLabel(val as RoofHigh, north)}を高くしました`),
        ),
      );
    if (ms.kind === 'gable' || ms.kind === 'hip')
      panel.append(
        h('div', { class: 'field-label', style: 'margin-top:8px' }, '棟の向き'),
        seg(
          [
            { v: 'auto', label: '長い辺に沿う' },
            { v: 'x', label: '横（図面の左右）', title: '棟が左右に通り、屋根は上下へ流れる' },
            { v: 'z', label: '縦（図面の上下）', title: '棟が上下に通り、屋根は左右へ流れる' },
          ],
          p?.ridge ?? 'auto',
          (val) => patchRoof((q) => { if (val === 'auto') delete q.ridge; else q.ridge = val as 'x' | 'z'; }, '棟の向きを変えました'),
        ),
      );
    if (ms.kind !== 'flat') {
      const pitches = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6];
      panel.append(
        h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 8px;margin-top:8px' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, '勾配（寸）'), h('select', { onchange: (e: Event) => { const val = (e.target as HTMLSelectElement).value; patchRoof((q) => { if (val === '') delete q.pitch; else q.pitch = Number(val); }, val === '' ? '勾配をおまかせに戻しました' : `勾配を ${val} 寸にしました`); } }, h('option', { value: '', selected: p?.pitch == null }, `おまかせ（${ms.isTop ? wholePitch : '0.5〜1'}）`), ...pitches.map((x) => h('option', { value: String(x), selected: p?.pitch === x }, `${x} 寸`)))),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, '軒の出 (mm)'), h('select', { onchange: (e: Event) => { const val = (e.target as HTMLSelectElement).value; patchRoof((q) => { if (val === '') delete q.eaves; else q.eaves = Number(val); }, val === '' ? '軒の出をおまかせに戻しました' : `軒の出を ${val} mm にしました`); } }, h('option', { value: '', selected: p?.eaves == null }, `おまかせ（${state.design.eaves ?? ext.roof.eaves}）`), ...[0, 150, 300, 450, 600, 750, 900, 1200].map((x) => h('option', { value: String(x), selected: p?.eaves === x }, `${x}`)))),
        ),
      );
      // 屋根を片側だけ伸ばす: 辺ごとの軒の出（寄棟は 4 辺同じ出でないと隅が合わないので対象外）
      if (ms.kind !== 'hip') {
        const sides: RoofHigh[] = ['n', 'e', 's', 'w'];
        const baseEaves = p?.eaves ?? state.design.eaves ?? ext.roof.eaves;
        panel.append(
          h('div', { class: 'field-label', style: 'margin-top:8px' }, '屋根を伸ばす（辺ごとの軒の出 mm）'),
          h(
            'div',
            { style: 'display:grid;grid-template-columns:1fr 1fr;gap:4px 8px' },
            ...sides.map((s) =>
              h(
                'label',
                { class: 'field', style: 'margin:0' },
                h('span', { class: 'field-label' }, sideLabel(s, north)),
                h(
                  'select',
                  {
                    onchange: (e: Event) => {
                      const val = (e.target as HTMLSelectElement).value;
                      patchRoof((q) => {
                        const by = { ...(q.eavesBy ?? {}) };
                        if (val === '') delete by[s];
                        else by[s] = Number(val);
                        if (Object.keys(by).length) q.eavesBy = by;
                        else delete q.eavesBy;
                      }, val === '' ? `${sideLabel(s, north)}の出をほかの辺と同じに戻しました` : `${sideLabel(s, north)}の屋根を ${val} mm 出しました`);
                    },
                  },
                  h('option', { value: '', selected: p?.eavesBy?.[s] == null }, `同じ（${baseEaves}）`),
                  ...[0, 150, 300, 450, 600, 900, 1200, 1500, 1820, 2730].map((x) => h('option', { value: String(x), selected: p?.eavesBy?.[s] === x }, `${x}`)),
                ),
              ),
            ),
          ),
          h('p', { class: 'hint', style: 'margin:2px 0 0' }, '庭側だけ深い軒にする・窓の上に屋根を伸ばすときに。窓 1 か所だけなら「窓・戸」の道具で庇を付けます。'),
        );
      }
    } else {
      panel.append(
        h('label', { class: 'field', style: 'margin-top:8px' }, h('span', { class: 'field-label' }, 'パラペットの立ち上がり (mm)'), h('select', { onchange: (e: Event) => { const val = (e.target as HTMLSelectElement).value; patchRoof((q) => { if (val === '') delete q.parapet; else q.parapet = Number(val); }, val === '' ? 'パラペットを標準（550）に戻しました' : `パラペットを ${val} mm にしました`); } }, h('option', { value: '', selected: p?.parapet == null }, '標準（550）'), ...[300, 450, 700, 900, 1200].map((x) => h('option', { value: String(x), selected: p?.parapet === x }, `${x}`)))),
      );
    }
    panel.append(
      h('div', { class: 'btn-row' }, p ? h('button', { class: 'btn sm', onclick: () => patchRoof((q) => { delete q.kind; delete q.high; delete q.ridge; delete q.pitch; delete q.eaves; delete q.eavesBy; delete q.parapet; }, 'この屋根をおまかせに戻しました') }, 'この塊をおまかせに戻す') : null, h('button', { class: 'btn sm ghost', onclick: () => { roofSel = null; render(); } }, '選ぶのをやめる')),
      h('p', { class: 'hint' }, '屋根が抜けて見える・出ないときは、方眼の修正画面で外形（外壁）を直すと屋根も作り直されます。塊の分け方は外形のつながり（上の階が載らない範囲）で決まります。'),
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
      if (op.kind === 'window') {
        const width = op.t1 - op.t0;
        const std = isStandardSashWidth(width);
        panel.append(
          h('div', { class: 'field-label' }, '窓の形'),
          h('div', { class: 'segmented' }, ...(Object.keys(WINDOW_SHAPES) as (keyof typeof WINDOW_SHAPES)[]).map((k) => h('button', { class: (op.windowStyle ?? (isSlidingWindow(op) ? (op.sill === 0 ? 'hakidashi' : 'koshi') : 'small')) === k ? 'on' : '', title: WINDOW_SHAPES[k].label, onclick: () => change(() => applyWindowShape(op, k, f.ceilingHeight, wallLen)) }, WINDOW_SHAPES[k].short))),
          h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:0 8px' }, numField('腰高 (mm)', () => op.sill, (v) => (op.sill = Math.max(0, v)), 50), numField('高さ (mm)', () => op.height, (v) => (op.height = Math.max(200, v)), 50)),
          // 標準の幅（半間の割）: 柱芯 910 → 780、1,365 → 1,235、1,820 → 1,690、2,730 → 2,600 …
          h('div', { class: 'field-label' }, std ? '幅（標準の寸法）' : `幅 W${Math.round(width).toLocaleString()} は半間の割に合いません → ${sashWidthLabel(nearestSashWidth(width))} が近い寸法`),
          h('div', { class: 'segmented' }, ...SASH_QUICK_WIDTHS.map((x) => h('button', { class: Math.abs(width - x) <= 70 ? 'on' : '', title: sashWidthLabel(x), disabled: x > wallLen - 40, onclick: () => change(() => setOpeningWidth(op, x, wallLen)) }, x.toLocaleString()))),
        );
      }
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
      roofSel = null;
      wallDraw = { on: false, level: null, a: null };
      paintOverlay();
      v.setSelection(null);
    }
    render();
    btn.classList.toggle('on', on);
  }

  /** 道具を開いていないときのクリック: 床なら部屋（天井高・床の仕上げ）、壁・窓・戸なら窓・戸、屋根なら屋根の道具を開いて選ぶ。該当すれば true */
  function pickHere(hit: { matKey: string; point: THREE.Vector3; group?: string }, ndc?: THREE.Vector2): boolean {
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
  return { button: btn, setActive, isActive: () => active, pickHere, dragStart, dragMove, dragEnd };
}
