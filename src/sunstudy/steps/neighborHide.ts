/**
 * 日照シミュレーション: 周辺建物を選んで隠す／戻す（「周辺建物の修正」の「🏠 建物を選んで隠す」）
 *
 *  モード中（ボタンが dark・十字カーソル）:
 *   - クリック（押してから 3 px 以内で離す。回転のドラッグでは選ばない）で建物の選択を切り替える（橙色で強調）
 *   - Shift＋ドラッグで画面に矩形を描き、足跡の重心（建物の高さの中ほど）が入る建物をまとめて選ぶ
 *   - 隠した建物は半透明（25 %）で表示し、クリックで選んで「戻す」で戻せる
 *   - ステージ左上の列（視点ボタン・前提チップの下）の操作バー: 「選択 N 棟」「隠す」「戻す」「選択を解除」「終了」と操作の案内。
 *     Esc・「終了」・画面を離れるとモードを終え、半透明の表示と強調を消す
 *  モード外でも「隠した建物（N 棟）」の一覧から 1 棟ずつ・すべて戻せる。
 *
 * 隠す／戻すは state.setNeighborsHidden（'neighbors' を発火）→ 画面側で古い解析結果を捨てて周辺建物を作り直す。
 * 表示はすべて scene.groups.select に入れる（影を落とさない・解析の BVH に入らない・撮影には写さない）。
 */
import * as THREE from 'three';
import { clear, h, toast } from '../../app/dom';
import { ALIGN_COLORS } from '../../sun/align';
import { buildNeighborGhosts, ghostMaterial, hiddenNeighborsForScene } from '../environment';
import { addSelection, footprintCentroid, idsInRect, normRect, rectIsTiny, splitSelection, toggleSelection } from '../neighborSelect';
import type { StudyScene } from '../scene';
import { clearGroup } from '../scene';
import { effectiveNeighbors, hiddenNeighbors, restoreAllNeighbors, setNeighborsHidden } from '../state';
import type { EN, Neighbor } from '../types';

/** これ以内の移動で離したらクリック（px） */
const CLICK_PX = 3;
/** 選択の強調色（2 点合わせの「実際の位置」の目印と同じ橙） */
const SEL_COLOR = ALIGN_COLORS.target;

export const HIDE_BUTTON_LABEL = '🏠 建物を選んで隠す';
export const HIDE_BUTTON_ACTIVE = '隠す建物をクリック（Shift＋ドラッグで範囲選択・Esc で終了）';

export interface NeighborHideOptions {
  scene: StudyScene;
  /** 3D の上に重ねるステージ（範囲選択の矩形を入れる） */
  stage: HTMLElement;
  /** 操作バーを入れる所（ステージ左上の列） */
  barHost: HTMLElement;
  /** 3D に出す周辺建物の除外に使う建物の足跡（buildingExclusionEN） */
  exclusion: () => EN[] | null;
  /** 建物の名前（ラベルか「出典の建物」） */
  nameOf: (n: Neighbor) => string;
  /** 建物からの方向・距離（「約 12 m・南側」） */
  whereOf: (n: Neighbor) => string;
  /** モードに入る／出る直前（測定点の配置・隣家のポップアップを止める、周辺建物の表示を入れる） */
  onModeChange: (on: boolean) => void;
}

export interface NeighborHide {
  /** 「🏠 建物を選んで隠す」ボタン */
  button: HTMLButtonElement;
  /** 「隠した建物（N 棟）」の一覧（details） */
  hiddenList: HTMLElement;
  active(): boolean;
  setActive(on: boolean): void;
  /** canvas の pointerdown（capture）。モード中は true（隣家のポップアップ・測定点の配置を出さない） */
  onPointerDown(e: PointerEvent): boolean;
  onPointerUp(e: PointerEvent): boolean;
  /** 周辺建物を作り直した後（隠す／戻す・高さ・周辺環境・配置の変更）: 半透明の表示・選択・一覧を作り直す */
  refresh(): void;
  dispose(): void;
}

function neighborIdOf(o: THREE.Object3D | null | undefined): string | null {
  for (let p: THREE.Object3D | null = o ?? null; p; p = p.parent) {
    const id = p.userData?.neighborId;
    if (typeof id === 'string') return id;
  }
  return null;
}

/** グループ内の周辺建物のメッシュ（id → メッシュ） */
function meshesById(root: THREE.Object3D): Map<string, THREE.Mesh> {
  const out = new Map<string, THREE.Mesh>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const id = m.userData?.neighborId;
    if (typeof id === 'string' && !out.has(id)) out.set(id, m);
  });
  return out;
}

export function createNeighborHide(opts: NeighborHideOptions): NeighborHide {
  const { scene, stage } = opts;
  const canvas = scene.renderer.domElement;
  const group = scene.groups.select;
  let on = false;
  let sel = new Set<string>();
  let ghosts: THREE.Group | null = null;
  const highlights = new THREE.Group();
  highlights.name = 'neighbor-highlights';

  // マテリアルはこのモジュールで持つ（メッシュは userData.sharedMaterial で clearGroup に解放させない）
  const mats = {
    ghost: ghostMaterial(),
    ghostSel: ghostMaterial(SEL_COLOR, 0.42),
    // 隠した建物の輪郭（濃い灰色の破線。地図の「隠した建物」と同じ見せ方）
    ghostEdge: new THREE.LineDashedMaterial({ color: '#3d444c', dashSize: 0.7, gapSize: 0.45, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }),
    hl: new THREE.MeshBasicMaterial({ color: SEL_COLOR, transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    edge: new THREE.LineBasicMaterial({ color: SEL_COLOR, toneMapped: false }),
  };

  // ---- ボタン・操作バー・範囲の矩形 ----
  const button = h('button', { class: 'btn sm', onclick: () => setActive(!on) }) as HTMLButtonElement;
  const countEl = h('span', { class: 'count' });
  const hideBtn = h('button', { class: 'btn sm primary', onclick: () => act(true) }, '隠す') as HTMLButtonElement;
  const restoreBtn = h('button', { class: 'btn sm', onclick: () => act(false) }, '戻す') as HTMLButtonElement;
  const clearBtn = h(
    'button',
    {
      class: 'btn sm',
      onclick: () => {
        sel = new Set();
        paint();
      },
    },
    '選択を解除',
  ) as HTMLButtonElement;
  const exitBtn = h('button', { class: 'btn sm ghost', onclick: () => setActive(false) }, '終了');
  const bar = h(
    'div',
    { class: 'nb-select-bar', style: 'pointer-events:auto' },
    h('div', { class: 'row' }, countEl, hideBtn, restoreBtn, clearBtn, exitBtn),
    h('div', { class: 'help' }, 'クリックで選択／解除・Shift＋ドラッグで範囲選択。半透明の建物は隠した建物（選んで「戻す」）'),
  );
  const rectEl = h('div', { class: 'nb-select-rect', style: 'display:none' });

  // ---- 隠した建物の一覧 ----
  const hiddenList = h('details', { class: 'nb-hidden' });
  let lastHiddenCount = -1;
  const renderHiddenList = () => {
    const list = hiddenNeighbors();
    const n = list.length;
    clear(hiddenList);
    hiddenList.appendChild(h('summary', null, `隠した建物（${n} 棟）`));
    if (n > 0 && lastHiddenCount <= 0) (hiddenList as HTMLDetailsElement).open = true;
    if (n === 0) (hiddenList as HTMLDetailsElement).open = false;
    lastHiddenCount = n;
    if (!n) {
      hiddenList.appendChild(h('p', { class: 'hint' }, '隠した建物はありません。取り壊す既存の家・もう無い建物・形の違う建物などは「建物を選んで隠す」で影と解析から外せます。'));
      return;
    }
    for (const nb of list)
      hiddenList.appendChild(
        h(
          'div',
          { class: 'nb-hidden-row' },
          h('div', { class: 'nb-hidden-name' }, h('b', null, opts.nameOf(nb)), h('span', { class: 'meta' }, `${opts.whereOf(nb)}・高さ 約 ${nb.height.toFixed(1)} m`)),
          h(
            'button',
            {
              class: 'btn sm',
              onclick: () => {
                if (setNeighborsHidden([nb.id], false)) toast(`${opts.nameOf(nb)}を戻しました`, 'ok');
              },
            },
            '戻す',
          ),
        ),
      );
    hiddenList.appendChild(
      h(
        'div',
        { class: 'btn-row', style: 'margin:6px 0 0' },
        h(
          'button',
          {
            class: 'btn sm ghost',
            onclick: () => {
              const k = restoreAllNeighbors();
              if (k) toast(`隠した建物 ${k} 棟をすべて戻しました`, 'ok');
            },
          },
          'すべて戻す',
        ),
      ),
    );
  };

  // ---- 3D の表示 ----
  const sceneIds = () => ({ visible: new Set(meshesById(scene.groups.neighbors).keys()), hidden: new Set(ghosts ? meshesById(ghosts).keys() : []) });

  /** 半透明の表示を作り直す（隠した建物の一覧・地形・配置が変わった） */
  const rebuildGhosts = () => {
    if (ghosts) {
      group.remove(ghosts);
      clearGroup(ghosts);
      ghosts = null;
    }
    if (!on) return;
    const list = hiddenNeighborsForScene(opts.exclusion());
    if (!list.length) return;
    ghosts = buildNeighborGhosts(list, { material: mats.ghost });
    // 半透明の面だけでは航空写真の上で見えにくいので、輪郭を破線で描く（クリックの当たり判定には使わない）
    for (const [id, m] of meshesById(ghosts)) {
      const l = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), mats.ghostEdge);
      l.computeLineDistances();
      l.renderOrder = 4;
      l.raycast = () => {};
      l.userData = { neighborId: id, ghostEdge: true, noShadow: true, overlay: true, sharedMaterial: true };
      ghosts.add(l);
    }
    group.add(ghosts);
  };

  /** 選択の強調・操作バーを今の選択に合わせる */
  const paint = () => {
    clearGroup(highlights);
    if (!on) {
      scene.invalidate();
      return;
    }
    const ids = sceneIds();
    // 取り直し・高さの変更で無くなった建物は選択から外す
    sel = new Set([...sel].filter((id) => ids.visible.has(id) || ids.hidden.has(id)));
    const vis = meshesById(scene.groups.neighbors);
    const edge = (geo: THREE.BufferGeometry, src: THREE.Object3D) => {
      const l = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), mats.edge);
      l.applyMatrix4(src.matrixWorld);
      l.renderOrder = 5;
      l.raycast = () => {};
      l.userData = { noShadow: true, overlay: true, sharedMaterial: true };
      highlights.add(l);
    };
    for (const id of sel) {
      const m = vis.get(id);
      if (!m) continue;
      m.updateMatrixWorld(true);
      const hl = new THREE.Mesh(m.geometry.clone(), mats.hl);
      hl.applyMatrix4(m.matrixWorld);
      hl.castShadow = false;
      hl.receiveShadow = false;
      hl.renderOrder = 4;
      hl.userData = { neighborId: id, highlight: true, noShadow: true, overlay: true, sharedMaterial: true };
      highlights.add(hl);
      edge(m.geometry, m);
    }
    if (ghosts) {
      ghosts.updateMatrixWorld(true);
      for (const [id, g] of meshesById(ghosts)) {
        const s = sel.has(id);
        g.material = s ? mats.ghostSel : mats.ghost;
        if (s) edge(g.geometry, g);
      }
    }
    if (!highlights.parent) group.add(highlights);
    const { toHide, toRestore } = splitSelection(sel, ids.visible, ids.hidden);
    countEl.textContent = `選択 ${sel.size} 棟${toRestore.length && toHide.length ? `（隠した建物 ${toRestore.length}）` : toRestore.length ? '（隠した建物）' : ''}`;
    hideBtn.disabled = !toHide.length;
    restoreBtn.disabled = !toRestore.length;
    clearBtn.disabled = !sel.size;
    scene.invalidate();
  };

  /** 隠す（hide=true）／戻す */
  const act = (hide: boolean) => {
    const ids = sceneIds();
    const { toHide, toRestore } = splitSelection(sel, ids.visible, ids.hidden);
    const target = hide ? toHide : toRestore;
    if (!target.length) return;
    for (const id of target) sel.delete(id);
    // setNeighborsHidden → 'neighbors' → 画面側で作り直し → refresh()
    const k = setNeighborsHidden(target, hide);
    if (!k) {
      paint();
      return;
    }
    if (hide) toast(`${k} 棟を隠しました（影・解析からも外しています。「隠した建物」から戻せます）`, 'ok');
    else toast(`${k} 棟を戻しました`, 'ok');
  };

  // ---- ポインタ ----
  let down: { x: number; y: number } | null = null;
  let box: { id: number; x0: number; y0: number; x1: number; y1: number } | null = null;

  const pickAt = (e: { clientX: number; clientY: number }): string | null => {
    const roots: THREE.Object3D[] = [scene.groups.neighbors];
    if (ghosts) roots.push(ghosts);
    return neighborIdOf(scene.pick(scene.ndcFromEvent(e), roots)?.object);
  };

  /** 画面上の代表点（足跡の重心・高さの中ほど）。client 座標 */
  const screenPoints = (): { id: string; x: number; y: number; inFront: boolean }[] => {
    const r = canvas.getBoundingClientRect();
    const rings = new Map(effectiveNeighbors().map((n) => [n.id, n.ring]));
    const out: { id: string; x: number; y: number; inFront: boolean }[] = [];
    const v = new THREE.Vector3();
    const cam = scene.camera;
    cam.updateMatrixWorld();
    const add = (id: string, m: THREE.Mesh) => {
      const ring = rings.get(id);
      if (!ring) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox!;
      const c = footprintCentroid(ring);
      v.set(c.e, (bb.min.y + bb.max.y) / 2, -c.n).applyMatrix4(m.matrixWorld);
      // カメラの後ろは投影が反転するので選ばない
      const inFront = v.clone().applyMatrix4(cam.matrixWorldInverse).z < 0;
      v.project(cam);
      out.push({ id, x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height, inFront: inFront && Math.abs(v.z) <= 1 });
    };
    scene.groups.neighbors.updateMatrixWorld(true);
    for (const [id, m] of meshesById(scene.groups.neighbors)) add(id, m);
    if (ghosts) {
      ghosts.updateMatrixWorld(true);
      for (const [id, m] of meshesById(ghosts)) add(id, m);
    }
    return out;
  };

  const drawRect = () => {
    if (!box) {
      rectEl.style.display = 'none';
      return;
    }
    const sr = stage.getBoundingClientRect();
    const r = normRect({ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y1 });
    Object.assign(rectEl.style, { display: '', left: `${r.x0 - sr.left}px`, top: `${r.y0 - sr.top}px`, width: `${r.x1 - r.x0}px`, height: `${r.y1 - r.y0}px` });
  };

  const onMove = (e: PointerEvent) => {
    if (!box || e.pointerId !== box.id) return;
    box.x1 = e.clientX;
    box.y1 = e.clientY;
    drawRect();
  };
  const endBox = () => {
    if (box) {
      try {
        canvas.releasePointerCapture(box.id);
      } catch {
        /* 既に外れている */
      }
    }
    box = null;
    drawRect();
  };
  const onCancel = (e: PointerEvent) => {
    if (box && e.pointerId === box.id) endBox();
    down = null;
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointercancel', onCancel);

  const toggleAt = (e: { clientX: number; clientY: number }) => {
    const id = pickAt(e);
    if (!id) return;
    sel = toggleSelection(sel, [id]);
    paint();
  };

  const onPointerDown = (e: PointerEvent): boolean => {
    if (!on) return false;
    if (e.button !== 0) return true;
    if (e.shiftKey) {
      // 範囲選択: 回転・移動（OrbitControls）には渡さない
      e.stopImmediatePropagation();
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* 対応していない環境 */
      }
      box = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
      down = null;
      drawRect();
      return true;
    }
    down = { x: e.clientX, y: e.clientY };
    return true;
  };

  const onPointerUp = (e: PointerEvent): boolean => {
    if (!on) return false;
    if (box && e.pointerId === box.id) {
      box.x1 = e.clientX;
      box.y1 = e.clientY;
      const r = normRect({ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y1 });
      endBox();
      if (rectIsTiny(r, CLICK_PX)) toggleAt(e);
      else {
        const ids = idsInRect(screenPoints(), r);
        if (!ids.length) toast('範囲の中に周辺建物がありません');
        sel = addSelection(sel, ids);
        paint();
      }
      return true;
    }
    if (e.button !== 0 || !down) return true;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved <= CLICK_PX) toggleAt(e);
    return true;
  };

  // ---- モード ----
  const syncButton = () => {
    button.classList.toggle('dark', on);
    button.textContent = on ? HIDE_BUTTON_ACTIVE : HIDE_BUTTON_LABEL;
    button.title = on ? 'もう一度押すと終了します' : '3D で周辺建物をクリック（Shift＋ドラッグで範囲）して選び、影と解析から外します';
  };

  const setActive = (next: boolean) => {
    if (next === on) return;
    opts.onModeChange(next);
    on = next;
    syncButton();
    if (on) {
      opts.barHost.appendChild(bar);
      stage.appendChild(rectEl);
      canvas.style.cursor = 'crosshair';
      toast('隠したい建物をクリックして選び（もう一度クリックで解除）、上の「隠す」を押します。Shift＋ドラッグで範囲選択。隠した建物は半透明で表示され、選んで「戻す」で戻せます。Esc で終了', 'info', 8000);
      rebuildGhosts();
      paint();
    } else {
      endBox();
      down = null;
      sel = new Set();
      bar.remove();
      rectEl.remove();
      rebuildGhosts();
      paint();
      group.remove(highlights);
      canvas.style.cursor = scene.navMode === 'pan' ? 'grab' : '';
    }
  };

  const refresh = () => {
    renderHiddenList();
    if (!on) return;
    rebuildGhosts();
    paint();
  };

  syncButton();
  renderHiddenList();

  return {
    button,
    hiddenList,
    active: () => on,
    setActive,
    onPointerDown,
    onPointerUp,
    refresh,
    dispose() {
      setActive(false);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointercancel', onCancel);
      for (const m of Object.values(mats)) m.dispose();
    },
  };
}
