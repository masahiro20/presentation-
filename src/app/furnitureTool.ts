/**
 * 3D 画面で家具・造作を置き直す道具（パースを見ながら「造作本棚をここに」「キッチンを Ⅱ 型に」）。
 * 右の操作バーの「家具」で開く。床をクリック → 置く、家具をクリック → 選んで型・形・幅・向きを変える。
 * 置き直した階は手配置（model.furniture）になり、平面図・見積（キッチンの型）にもつながる。
 */
import * as THREE from 'three';
import { FABRIC_COLORS, WOOD_TONES, roomFloorOffsetMm, type BuildingModel, type BuiltinVariant, type FabricColor, type Floor, type FurnitureItem, type FurnitureKind, type Vec2 } from '../core/types';
import { distPointSegment, pointInPolygon } from '../core/geometry';
import { BUILTIN_VARIANTS, FURNITURE_LABEL, KITCHEN_TYPES, SOFA_SHAPES, LEG_SIDES, WASH_STYLES, furnitureDims, furnitureItems } from '../scene/furniture';
import { furnitureGaps, mmText } from '../core/dims';
import type { DimLine3D, Handle3D, Viewer } from '../scene/viewer';
import { h, clear, toast } from './dom';
import { state } from './state';

/** 幅（w）をハンドルで変えられる家具。キッチンは長さ（len = w + 0.3） */
const WIDTH_KINDS = new Set<FurnitureKind>(['sofa', 'bed', 'tv', 'rug', 'cupboard', 'dining', 'hanger', 'builtin', 'washstand', 'kitchen']);
/** 奥行（d）をハンドルで変えられる家具（L 型キッチンは袖の長さ） */
const DEPTH_KINDS = new Set<FurnitureKind>(['rug', 'builtin']);
const snapTo = (v: number, step: number) => Math.round(v / step) * step;
const normDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** 壁に背を付けて置く家具（それ以外はクリックした点が中心） */
const WALL_KINDS = new Set<FurnitureKind>(['kitchen', 'cupboard', 'fridge', 'tv', 'bookshelf', 'desk', 'cabinet', 'sofa', 'bed', 'shoeCabinet', 'washstand', 'washer', 'toilet', 'mirror', 'nightstand', 'bath', 'builtin', 'hanger']);

/** 追加できる家具（造作は形ごとに並べる） */
const ADD_FURNITURE: FurnitureKind[] = ['sofa', 'dining', 'tv', 'rug', 'coffeeTable', 'desk', 'bookshelf', 'cupboard', 'hanger', 'washstand', 'bed', 'plant', 'chair', 'lowTable'];
/** 木の色味を選べる家具（木の部品がある物） */
const WOOD_KINDS = new Set<FurnitureKind>(['dining', 'coffeeTable', 'tv', 'chair', 'bed', 'nightstand', 'desk', 'cabinet', 'bookshelf', 'lowTable', 'shoeCabinet', 'cupboard', 'hanger', 'builtin', 'washstand']);
/** 張地の色を選べる家具 */
const FABRIC_KINDS = new Set<FurnitureKind>(['sofa', 'chair', 'bed', 'dining']);

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
  /** 選んだ家具を掴んで動かしている間の状態（元の位置と、いま置こうとしている位置） */
  let drag: { x0: number; y0: number; rot0: number; p0: THREE.Vector3; f: Floor; preview: { x: number; y: number; rot: number } | null } | null = null;

  const model = () => state.model as BuildingModel | null;
  const floorOf = (level: number): Floor | null => model()?.floors.find((f) => f.level === level) ?? null;
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

  /** 点（mm）に最も近い壁に背を付ける位置と向き（maxD より遠い壁には付けない） */
  const snapToWall = (f: Floor, p: Vec2, maxD = 2500): { x: number; y: number; rot: number } | null => {
    let best: { d: number; q: Vec2; n: Vec2; t: number } | null = null;
    for (const w of f.walls) {
      const d = distPointSegment(p, w.a, w.b);
      if (d > maxD || (best && d >= best.d)) continue;
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
  const itemAt = (level: number, p: Vec2, tol = 0.08, near = 0): FurnitureItem | null => {
    let best: { it: FurnitureItem; a: number } | null = null;
    let nearest: { it: FurnitureItem; d: number } | null = null;
    for (const it of itemsOf(level)) {
      const { w, d, v0 } = furnitureDims(it);
      const r = (it.rot * Math.PI) / 180;
      const dx = (p.x - it.x) / 1000;
      const dy = (p.y - it.y) / 1000;
      const u = dx * Math.cos(r) + dy * Math.sin(r);
      const vv = -dx * Math.sin(r) + dy * Math.cos(r);
      if (Math.abs(u) <= w / 2 + tol && vv >= v0 - tol && vv <= v0 + d + tol) {
        const a = w * d;
        if (!best || a < best.a) best = { it, a };
      }
      // 足元の外形からの距離（照明・フードなど足元より外に出ている部品をクリックしたときの拾い）
      const dist = Math.max(Math.abs(u) - w / 2, v0 - vv, vv - (v0 + d), 0);
      if (!nearest || dist < nearest.d) nearest = { it, d: dist };
    }
    if (best) return best.it;
    return near > 0 && nearest && nearest.d <= near ? nearest.it : null;
  };

  /** 家具の足元の外形（world m）。選択の枠・ドラッグ中の下見せに使う */
  const footprintWorld = (it: FurnitureItem, f: Floor, pos: { x: number; y: number; rot: number } = it): THREE.Vector3[] => {
    const { w, d, v0 } = furnitureDims(it);
    const r = (pos.rot * Math.PI) / 180;
    const cx = pos.x / 1000;
    const cz = pos.y / 1000;
    const room = f.rooms.find((rm) => pointInPolygon({ x: pos.x, y: pos.y }, rm.polygon));
    const y = f.elevation / 1000 + (room ? roomFloorOffsetMm(room) / 1000 : 0);
    const P = (u: number, vv: number) => new THREE.Vector3(cx + u * Math.cos(r) - vv * Math.sin(r), y, cz + u * Math.sin(r) + vv * Math.cos(r));
    return [P(-w / 2, v0), P(w / 2, v0), P(w / 2, v0 + d), P(-w / 2, v0 + d)];
  };
  /** 家具の寸法の読み書き（ハンドル用）。幅はキッチンだけ len（= 幅 + 0.3）で持つ */
  const dimsOf = (it: FurnitureItem) => furnitureDims(it);
  const applyWidth = (x: FurnitureItem, w: number) => {
    if (x.kind === 'kitchen') x.len = +(w + 0.3).toFixed(2);
    else if (x.kind === 'bed') x.w = +(w - 0.06).toFixed(2);
    else x.w = +w.toFixed(2);
  };
  /**
   * CAD のハンドル: 回転（前面の先の丸）・幅（左右の辺の四角）・奥行（前面の四角）。
   * pos を渡すとその位置・寸法でのハンドル（ドラッグ中の下見せ）
   */
  const handlesFor = (it: FurnitureItem, f: Floor, pos: { x: number; y: number; rot: number } = it, dims: { w: number; d: number; v0: number } = dimsOf(it)): Handle3D[] => {
    const { w, d, v0 } = dims;
    const r = (pos.rot * Math.PI) / 180;
    const cx = pos.x / 1000;
    const cz = pos.y / 1000;
    const room = f.rooms.find((rm) => pointInPolygon({ x: pos.x, y: pos.y }, rm.polygon));
    const y = f.elevation / 1000 + (room ? roomFloorOffsetMm(room) / 1000 : 0) + 0.05;
    const P = (u: number, vv: number) => new THREE.Vector3(cx + u * Math.cos(r) - vv * Math.sin(r), y, cz + u * Math.sin(r) + vv * Math.cos(r));
    const out: Handle3D[] = [{ id: 'rot', kind: 'rotate', pos: P(0, v0 + d + 0.45), title: 'ドラッグで回す（15° 刻み。Shift で自由）' }];
    if (WIDTH_KINDS.has(it.kind)) {
      out.push({ id: 'w+', kind: 'size', pos: P(w / 2, v0 + d / 2), title: 'ドラッグで幅を変える' }, { id: 'w-', kind: 'size', pos: P(-w / 2, v0 + d / 2), title: 'ドラッグで幅を変える' });
    }
    if (DEPTH_KINDS.has(it.kind) || (it.kind === 'kitchen' && it.kitchenType === 'l')) out.push({ id: 'd+', kind: 'size', pos: P(0, v0 + d), title: it.kind === 'kitchen' ? 'ドラッグで袖の長さを変える' : 'ドラッグで奥行を変える' });
    return out;
  };
  /** 選んでいる家具に枠・ハンドル・寸法線を出す（無ければ消す） */
  const showSel = () => {
    const it = selected();
    const f = it && sel ? floorOf(sel.level) : null;
    v.setSelection(it && f ? footprintWorld(it, f) : null);
    v.setHandles(it && f && active && !add ? handlesFor(it, f) : null);
    v.setDimLines(it && f && active && !add ? dimLinesFor(it, f) : null);
    if (it && f && active) v.onDimEdit = applyGapEdit;
  };
  /** ハンドルを掴んで回す・広げる間の状態 */
  let hdrag: { id: string; f: Floor; x0: number; y0: number; rot0: number; dims0: { w: number; d: number; v0: number }; preview: { x: number; y: number; rot: number; w: number; d: number } | null } | null = null;
  const handleDragStart = (ndc: THREE.Vector2 | undefined): boolean => {
    if (!ndc || !sel) return false;
    const hd = v.pickHandle(ndc);
    if (!hd) return false;
    const it = selected();
    const f = floorOf(sel.level);
    if (!it || !f) return false;
    hdrag = { id: hd.id, f, x0: it.x, y0: it.y, rot0: it.rot, dims0: dimsOf(it), preview: null };
    moving = false;
    return true;
  };
  const handleDragMove = (p: THREE.Vector3) => {
    if (!hdrag) return;
    const it = selected();
    if (!it) return;
    const { id, f, x0, y0, rot0, dims0 } = hdrag;
    const fine = v.dragMods.shift;
    const cx = x0 / 1000;
    const cz = y0 / 1000;
    const dx = p.x - cx;
    const dz = p.z - cz;
    let pv = { x: x0, y: y0, rot: rot0, w: dims0.w, d: dims0.d };
    let label = '';
    if (id === 'rot') {
      // ハンドルは前面（local +v）の先にあるので、その向き = rot + 90°
      const deg = (Math.atan2(dz, dx) * 180) / Math.PI - 90;
      const rot = normDeg(fine ? Math.round(deg) : snapTo(deg, 15));
      pv = { ...pv, rot };
      label = `${rot}°`;
    } else {
      const r = (rot0 * Math.PI) / 180;
      const u = dx * Math.cos(r) + dz * Math.sin(r);
      const vv = -dx * Math.sin(r) + dz * Math.cos(r);
      const step = fine ? 0.01 : 0.05;
      if (id === 'w+' || id === 'w-') {
        const far = dims0.w / 2;
        const raw = id === 'w+' ? u + far : -u + far;
        const w = Math.max(0.4, Math.min(6, snapTo(raw, step)));
        const shift = ((w - dims0.w) / 2) * (id === 'w+' ? 1 : -1);
        pv = { ...pv, w, x: Math.round(x0 + shift * Math.cos(r) * 1000), y: Math.round(y0 + shift * Math.sin(r) * 1000) };
        label = `${it.kind === 'kitchen' ? '長さ' : it.kind === 'hanger' ? '長さ' : '幅'} ${(it.kind === 'kitchen' ? w + 0.3 : w).toFixed(2)} m`;
      } else {
        const d = Math.max(0.15, Math.min(3, snapTo(vv - dims0.v0, step)));
        pv = { ...pv, d };
        label = `${it.kind === 'kitchen' ? '袖' : '奥行'} ${d.toFixed(2)} m`;
      }
    }
    hdrag.preview = pv;
    const dims = { w: pv.w, d: pv.d, v0: dims0.v0 };
    v.setSelection(footprintWorldDims(f, pv, dims));
    v.setHandles(handlesFor(it, f, pv, dims));
    v.setDimLines(dimLinesFor(it, f, pv, dims));
    v.setDragLabel(label);
  };
  const handleDragEnd = (moved: boolean) => {
    if (!hdrag) return;
    const d = hdrag;
    hdrag = null;
    if (!moved || !d.preview) {
      showSel();
      return;
    }
    const pv = d.preview;
    editSel((x) => {
      x.rot = pv.rot;
      if (d.id === 'w+' || d.id === 'w-') {
        applyWidth(x, pv.w);
        x.x = pv.x;
        x.y = pv.y;
      } else if (d.id === 'd+') x.d = +pv.d.toFixed(2);
    });
  };
  /** 寸法を指定した足元の外形（ドラッグ中の下見せ） */
  const footprintWorldDims = (f: Floor, pos: { x: number; y: number; rot: number }, dims: { w: number; d: number; v0: number }): THREE.Vector3[] => {
    const { w, d, v0 } = dims;
    const r = (pos.rot * Math.PI) / 180;
    const cx = pos.x / 1000;
    const cz = pos.y / 1000;
    const room = f.rooms.find((rm) => pointInPolygon({ x: pos.x, y: pos.y }, rm.polygon));
    const y = f.elevation / 1000 + (room ? roomFloorOffsetMm(room) / 1000 : 0);
    const P = (u: number, vv: number) => new THREE.Vector3(cx + u * Math.cos(r) - vv * Math.sin(r), y, cz + u * Math.sin(r) + vv * Math.cos(r));
    return [P(-w / 2, v0), P(w / 2, v0), P(w / 2, v0 + d), P(-w / 2, v0 + d)];
  };
  /**
   * 選んだ家具の寸法線（CAD・ウォークインホームの「選ぶと寸法が出る」）:
   * 幅 W・奥行 D（黒）と、背面・正面・左右の壁までの距離（青。壁芯の多角形から壁の半分の厚さ 60 を引いた、仕上げ面までの概算）。
   * 青の札はクリックして数値を打つと、その距離になるように家具が動く（applyGapEdit）
   */
  const dimLinesFor = (it: FurnitureItem, f: Floor, pos: { x: number; y: number; rot: number } = it, dims: { w: number; d: number; v0: number } = dimsOf(it)): DimLine3D[] => {
    const { w, d, v0 } = dims;
    const r = (pos.rot * Math.PI) / 180;
    const cx = pos.x / 1000;
    const cz = pos.y / 1000;
    const room = f.rooms.find((rm) => pointInPolygon({ x: pos.x, y: pos.y }, rm.polygon));
    const y = f.elevation / 1000 + (room ? roomFloorOffsetMm(room) / 1000 : 0) + 0.03;
    const P = (u: number, vv: number) => new THREE.Vector3(cx + u * Math.cos(r) - vv * Math.sin(r), y, cz + u * Math.sin(r) + vv * Math.cos(r));
    const out: DimLine3D[] = [
      { id: 'w', a: P(-w / 2, v0 + d + 0.22), b: P(w / 2, v0 + d + 0.22), label: `W ${mmText(w * 1000)}` },
      { id: 'd', a: P(w / 2 + 0.22, v0), b: P(w / 2 + 0.22, v0 + d), label: `D ${mmText(d * 1000)}` },
    ];
    if (room) {
      const g = furnitureGaps(pos, dims, room.polygon, 60);
      const uDir = new THREE.Vector3(Math.cos(r), 0, Math.sin(r));
      const vDir = new THREE.Vector3(-Math.sin(r), 0, Math.cos(r));
      const gap = (id: string, val: number | null, a: THREE.Vector3, dir: THREE.Vector3) => {
        if (val == null || val < 10 || val > 12000) return;
        out.push({ id, a, b: a.clone().addScaledVector(dir, val / 1000), label: mmText(val), kind: 'gap', editable: true });
      };
      gap('gap:back', g.back, P(0, v0), vDir.clone().negate());
      gap('gap:front', g.front, P(0, v0 + d), vDir);
      gap('gap:a', g.sideA, P(-w / 2, v0 + d / 2), uDir.clone().negate());
      gap('gap:b', g.sideB, P(w / 2, v0 + d / 2), uDir);
    }
    return out;
  };
  /** 青の札（壁までの距離）に数値を打ったとき: その距離になるように家具を動かす */
  const applyGapEdit = (id: string, val: number) => {
    const it = selected();
    const f = sel ? floorOf(sel.level) : null;
    if (!it || !f) return;
    const room = f.rooms.find((rm) => pointInPolygon({ x: it.x, y: it.y }, rm.polygon));
    if (!room) return;
    const g = furnitureGaps(it, dimsOf(it), room.polygon, 60);
    const key = id === 'gap:back' ? 'back' : id === 'gap:front' ? 'front' : id === 'gap:a' ? 'sideA' : id === 'gap:b' ? 'sideB' : null;
    if (!key) return;
    const cur = g[key];
    if (cur == null) return;
    const want = Math.max(0, Math.round(val));
    const delta = want - cur;
    const r = (it.rot * Math.PI) / 180;
    const u = { x: Math.cos(r), y: Math.sin(r) };
    const vv = { x: -Math.sin(r), y: Math.cos(r) };
    // 背面の空きを増やす = 部屋側（+v）へ、正面を増やす = 壁側（−v）へ、−u 側を増やす = +u へ、+u 側を増やす = −u へ
    const dir = key === 'back' ? vv : key === 'front' ? { x: -vv.x, y: -vv.y } : key === 'sideA' ? u : { x: -u.x, y: -u.y };
    editSel((x) => {
      x.x = Math.round(x.x + dir.x * delta);
      x.y = Math.round(x.y + dir.y * delta);
    });
    toast(`${labelOf(it)}を壁から ${mmText(want)} mm の位置にしました`, 'ok', 2000);
  };
  /** 矢印キーで 10 mm（Shift 100・Ctrl 半間）ずつ動かす。Delete で消す、Esc で選ぶのをやめる、R で 90° 回す（入力欄に文字を打っている間は効かせない） */
  const onKey = (e: KeyboardEvent) => {
    if (!active || !sel || add) return;
    const tg = e.target as HTMLElement | null;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
    const step = e.ctrlKey || e.metaKey ? (model()?.module?.grid ?? 455) : e.shiftKey ? 100 : 10;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const mv = (dx: number, dy: number) => {
      handled();
      editSel((x) => {
        x.x += dx;
        x.y += dy;
      });
    };
    if (e.key === 'ArrowLeft') mv(-step, 0);
    else if (e.key === 'ArrowRight') mv(step, 0);
    else if (e.key === 'ArrowUp') mv(0, -step);
    else if (e.key === 'ArrowDown') mv(0, step);
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      handled();
      const s = sel;
      const list = explicit(s.level);
      const i = list.findIndex((q) => q.id === s.id);
      if (i >= 0) list.splice(i, 1);
      sel = null;
      commit();
    } else if (e.key === 'Escape') {
      handled();
      sel = null;
      moving = false;
      render();
    } else if (e.key.toLowerCase() === 'r') {
      handled();
      editSel((x) => (x.rot = ((x.rot + (e.shiftKey ? -90 : 90) + 540) % 360) - 180));
    }
  };
  window.addEventListener('keydown', onKey, true);
  /** 選んだ家具の上で押したらドラッグ開始（道具を開いていて、その家具を選んでいるときだけ。それ以外はカメラ操作のまま）。先にハンドルを見る */
  /** 点（mm）から家具の足元の外形までの距離（m。中なら 0） */
  const itemDist = (it: FurnitureItem, p: Vec2): number => {
    const { w, d, v0 } = furnitureDims(it);
    const r = (it.rot * Math.PI) / 180;
    const dx = (p.x - it.x) / 1000;
    const dy = (p.y - it.y) / 1000;
    const u = dx * Math.cos(r) + dy * Math.sin(r);
    const vv = -dx * Math.sin(r) + dy * Math.cos(r);
    return Math.max(Math.abs(u) - w / 2, v0 - vv, vv - (v0 + d), 0);
  };
  const dragStart = (p: THREE.Vector3, ndc?: THREE.Vector2): boolean => {
    if (!active || add || !sel) return false;
    if (handleDragStart(ndc)) return true;
    const f = floorAt(p.y);
    if (!f || f.level !== sel.level) return false;
    const pt = { x: p.x * 1000, y: p.z * 1000 };
    // 選んでいる家具を優先: 押した面の点が足元の外形から 30cm 以内なら掴む
    // （背もたれの天端・フードなど、斜めから見ると足元の外形の外に当たる面を押しても掴める。下に敷いたラグに取られない）
    const cur = selected();
    const it = cur && itemDist(cur, pt) <= 0.3 ? cur : itemAt(f.level, pt, 0.08, 0.6);
    if (!it || it.id !== sel.id) return false;
    drag = { x0: it.x, y0: it.y, rot0: it.rot, p0: p.clone(), f, preview: null };
    moving = false;
    return true;
  };
  const dragMove = (p: THREE.Vector3) => {
    if (hdrag) {
      handleDragMove(p);
      return;
    }
    if (!drag) return;
    const it = selected();
    if (!it) return;
    const raw = { x: drag.x0 + (p.x - drag.p0.x) * 1000, y: drag.y0 + (p.z - drag.p0.z) * 1000 };
    // 壁に背を付ける家具は、壁ぎわ（70cm 以内）まで持っていくと壁に吸着（向きも壁に沿う）。部屋の中では自由に動く
    const snap = WALL_KINDS.has(it.kind) ? snapToWall(drag.f, raw, 700) : null;
    drag.preview = snap ?? { x: Math.round(raw.x), y: Math.round(raw.y), rot: drag.rot0 };
    v.setSelection(footprintWorld(it, drag.f, drag.preview));
    v.setHandles(handlesFor(it, drag.f, drag.preview));
    v.setDimLines(dimLinesFor(it, drag.f, drag.preview));
  };
  const dragEnd = (_p: THREE.Vector3, moved: boolean) => {
    if (hdrag) {
      handleDragEnd(moved);
      return;
    }
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!moved || !d.preview) {
      showSel();
      return;
    }
    const pv = d.preview;
    const room = d.f.rooms.find((r) => pointInPolygon({ x: pv.x, y: pv.y }, r.polygon));
    editSel((x) => Object.assign(x, pv, { roomId: room?.id ?? x.roomId }));
  };

  const onPick = (pt: THREE.Vector3, ndc?: THREE.Vector2) => {
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
        const defaults: Partial<FurnitureItem> = kind === 'builtin' ? { variant: add.variant ?? 'wallShelf' } : kind === 'kitchen' ? { len: 2.7, kitchenType: add.kitchenType ?? 'peninsula' } : kind === 'sofa' ? { w: 2.1 } : kind === 'tv' ? { w: 1.8 } : kind === 'rug' ? { w: 2.2, d: 1.6 } : kind === 'hanger' ? { w: 1.8 } : kind === 'washstand' ? { w: 0.9 } : {};
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
    // 見ている物を優先: 家具でない物（窓・壁・床・外構の物）をクリックしたら、その物の道具へ
    if (ndc && v.onPickIdle) {
      const hit = v.pickHit(ndc);
      if (hit && hit.group !== 'furniture' && !(hit.group === 'building' && itemAt(f.level, p)) && v.onPickIdle(hit, ndc)) return;
    }
    const it = itemAt(f.level, p);
    sel = it ? { level: f.level, id: it.id } : null;
    render();
  };
  /** 道具を開いていないときのクリック: その点に家具があれば道具を開いて選ぶ */
  const pickHere = (pt: THREE.Vector3): boolean => {
    const f = floorAt(pt.y);
    if (!f) return false;
    // 家具の面をクリックしたときは、足元の外形から 0.6m まで（照明の笠・フードなど張り出した部品）も同じ家具とみなす
    const it = itemAt(f.level, { x: pt.x * 1000, y: pt.z * 1000 }, 0.08, 0.6);
    if (!it) return false;
    if (!active) setActive(true);
    sel = { level: f.level, id: it.id };
    add = null;
    moving = false;
    render();
    return true;
  };

  const labelOf = (it: FurnitureItem) => (it.kind === 'builtin' ? BUILTIN_VARIANTS[it.variant ?? 'wallShelf'].label : FURNITURE_LABEL[it.kind]);
  const num = (label: string, value: number, step: number, min: number, max: number, set: (x: FurnitureItem, v: number) => void) =>
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('input', { type: 'number', step, min, max, value: +value.toFixed(2), onchange: (e: Event) => editSel((x) => set(x, +(e.target as HTMLInputElement).value)) }));
  const pick = <T extends string>(label: string, opts: [T, string][], cur: T, set: (x: FurnitureItem, v: T) => void) =>
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h('select', { onchange: (e: Event) => editSel((x) => set(x, (e.target as HTMLSelectElement).value as T)) }, opts.map(([val, l]) => h('option', { value: val, selected: val === cur }, l))));

  function render() {
    clear(panel);
    panel.hidden = !active;
    showSel();
    if (!active) return;
    panel.append(
      h('div', { class: 'furn-head' }, h('strong', null, '家具・造作'), h('button', { class: 'btn sm ghost', onclick: () => setActive(false) }, '閉じる')),
      h('p', { class: 'hint' }, add ? `「${add.kind === 'builtin' ? BUILTIN_VARIANTS[add.variant ?? 'wallShelf'].label : add.kind === 'kitchen' ? `キッチン（${KITCHEN_TYPES.find((k) => k[0] === add!.kitchenType)?.[1] ?? ''}）` : FURNITURE_LABEL[add.kind]}」: 置きたい壁ぎわの床をクリック` : moving ? '移す先の床をクリック（壁ぎわの家具は壁に付きます）' : sel ? '橙の枠が選んだ家具。掴んでドラッグで動かし、前の丸で回し、辺の四角で広げます（壁ぎわの家具は壁に沿います。Shift で細かく）。黒の札は幅・奥行、青の札は壁までの距離で、青をクリックして数値を打つとその位置に動きます。矢印キーで 10 mm（Shift 100・Ctrl 半間）ずつ動かせます' : '家具をクリックして選ぶ／下から選んで床をクリックで置く'),
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
      if (['sofa', 'bed', 'tv', 'rug', 'cupboard', 'dining', 'hanger'].includes(it.kind)) box.append(num(it.kind === 'hanger' ? '長さ (m)' : '幅 (m)', furnitureDims(it).w, 0.1, 0.6, 6, (x, val) => (x.w = val)));
      if (it.kind === 'sofa' || it.kind === 'cupboard') {
        box.append(pick('形', SOFA_SHAPES as unknown as ['i' | 'l', string][], it.shape ?? 'i', (x, val) => (x.shape = val)));
        if (it.shape === 'l')
          box.append(
            pick(it.kind === 'sofa' ? 'カウチの側（部屋側から見て）' : '袖の側（部屋側から見て）', LEG_SIDES as unknown as ['left' | 'right', string][], it.legSide ?? 'right', (x, val) => (x.legSide = val)),
            num(it.kind === 'sofa' ? 'カウチの奥行 (m)' : '袖の長さ (m)', it.leg ?? (it.kind === 'sofa' ? 1.6 : 1.8), 0.1, it.kind === 'sofa' ? 1.2 : 0.9, 3, (x, val) => (x.leg = val)),
          );
      }
      if (it.kind === 'washstand') {
        box.append(
          num('幅 (m)', it.w ?? 0.77, 0.05, 0.6, 2.4, (x, val) => (x.w = val)),
          pick('作り', WASH_STYLES as unknown as ['unit' | 'custom', string][], it.washStyle ?? 'unit', (x, val) => (x.washStyle = val)),
        );
      }
      // 素材（木の色味・張地の色）: この家具だけ変える。標準はテイストの色
      if (WOOD_KINDS.has(it.kind)) box.append(pick('木の色味', WOOD_TONES, it.woodTone ?? 'natural', (x, val) => { if (val === 'natural') delete x.woodTone; else x.woodTone = val; }));
      if (FABRIC_KINDS.has(it.kind)) box.append(pick('張地の色', FABRIC_COLORS.map(([k, l]) => [k, l] as [FabricColor, string]), it.fabricColor ?? 'preset', (x, val) => { if (val === 'preset') delete x.fabricColor; else x.fabricColor = val; }));
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
      hdrag = null;
      v.setHandles(null);
      v.setDimLines(null);
      if (v.onDimEdit === applyGapEdit) v.onDimEdit = null;
    }
    render();
    btn.classList.toggle('on', on);
  }

  const btn = h('button', { class: 'nav-btn', title: '家具・造作（パースを見ながら造作本棚を置く、キッチンの型を変える）\n床をクリックで置く、家具をクリックで選ぶ、選んだ家具はドラッグで動かす', onclick: () => setActive(!active) }, h('span', { class: 'ic' }, '▦'), '家具');
  /** 元に戻した後: 消えた家具の選択を外して、枠・つまみ・パネルを今のモデルに合わせる */
  const refresh = () => {
    if (sel && !selected()) sel = null;
    render();
  };
  return { button: btn, setActive, isActive: () => active, pickHere, dragStart, dragMove, dragEnd, refresh };
}
