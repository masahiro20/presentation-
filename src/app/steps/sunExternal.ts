/**
 * 日照ステップの「設計の 3D データで正確な建物にする」パネルと「2 点合わせ」（建物の角 → 航空写真の同じ角）。
 * sunStep.ts から mount 時に作り、unmount で dispose する。状態は state.external と externalBuilding.ts の controller。
 */
import * as THREE from 'three';
import { h, clear, toast, progressModal, section, field } from '../dom';
import { state, emit } from '../state';
import { siteLatLon } from '../../sun/geo';
import type { StepCtx } from '../app';
import type { Viewer } from '../../scene/viewer';
import { textSprite, type SunContext } from '../../sun/context';
import { solveTwoPoint, normDeg180, ALIGN_COLORS, TWO_POINT_STEPS, TWO_POINT_CANCEL_HINT, MIN_PAIR_DIST_M, type EN } from '../../sun/align';
import { ACCEPT_EXT } from '../../sunstudy/importModel';
import { UNIT_LABEL, type ImportedModel, type LengthUnit } from '../../sunstudy/types';
import { applyTwoPointToSite, sizeText, snapToOutlineVertex, suggestsMirror, suggestsUnitError } from '../externalFit';
import { createExternal, externalController, installExternal, loadExternal, loadSampleExternal, setExternalMounted, type ExternalController } from '../externalBuilding';

export interface ExternalPanelDeps {
  ctx: StepCtx;
  sc: SunContext;
  /** PDF の bbox 中心（建物はワールドに固定なので変わらない） */
  center: THREE.Vector3;
  /** 建物の大きさの目安 (m) */
  R: number;
  /** 太陽軌道・航空写真・周辺建物を今の建設地で作り直す */
  reloadContext: () => Promise<void>;
  /** 太陽方向を今の日時で再適用する */
  applySun: () => void;
  /** 建物に依存する解析結果（部屋の日当たり・日影図・日照時間マップ）を捨てる */
  invalidateResults: () => void;
  /** 建設地の表示を更新 */
  showLoc: () => void;
  /** 航空写真をクリックして置くモードを切る（2 点合わせと同時に有効にしない） */
  cancelPlacing: () => void;
  /** 航空写真が無ければ読み込む。読めなければ false */
  ensureAerial: () => Promise<boolean>;
}

export interface ExternalPanel {
  section: HTMLElement;
  twoPointBtn: HTMLButtonElement;
  /** 2 点合わせの待ち受け中なら中止する。notice があれば（中止したときだけ）その案内を出す。位置・向き・配置を変える前に呼ぶ（指した角の座標はワールドなので古くなる） */
  cancelTwoPoint: (notice?: string) => void;
  /** emit('model') の後（方位の回転など）に external を再同期する */
  afterModelRebuilt: () => void;
  dispose: () => void;
}

const TWO_POINT_LABEL = '📍 2 点合わせ（建物の角 → 航空写真の同じ角）';
const UNITS: LengthUnit[] = ['mm', 'cm', 'm', 'in', 'ft', 'custom'];
/** クリックとドラッグを分ける移動量 (px)。「敷地をクリック」（sunStep）も同じ値で判定する */
export const CLICK_PX = 3;
/** 3DS の配置を変えたときに待ち受け中の 2 点合わせを中止する案内 */
const TWO_POINT_ABORT_EXT = '3DS の配置を変えたので 2 点合わせを中止しました（指した角の位置が変わるため）';
/** 2 つの角が近すぎるときの案内（標準の日照ツールと同じ文言） */
export const TOO_CLOSE_MSG = `2 つの角が近すぎます（${MIN_PAIR_DIST_M} m 以上離れた角を選んでください）`;

/** pointerdown → pointerup の移動が CLICK_PX 以内ならクリック（それより大きければ視点のドラッグ） */
export function isClick(down: { x: number; y: number }, up: { x: number; y: number }): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= CLICK_PX;
}

/** 2 点合わせの手順の文言（段階 0..3）: 両アプリ共通の文言に中止の案内を添える（括弧で終わる文言には括弧を重ねない） */
export function twoPointStepText(stage: number): string {
  const step = TWO_POINT_STEPS[Math.min(Math.max(stage, 0), TWO_POINT_STEPS.length - 1)];
  return step.endsWith('）') ? `${step}。${TWO_POINT_CANCEL_HINT}` : `${step}（${TWO_POINT_CANCEL_HINT}）`;
}

/** 2 つの角（建物側どうし・航空写真側どうし）が MIN_PAIR_DIST_M より近いと向きが定まらない */
export function pairTooClose(a: EN, b: EN): boolean {
  return Math.hypot(a.e - b.e, a.n - b.n) < MIN_PAIR_DIST_M;
}

/** 配置の状態の文言: 手で調整した／自動で合わせた／自動で合わせられなかった（fit 無し） */
export function placementStateText(e: { manual?: boolean; fit?: unknown }): string {
  return e.manual ? '手で調整した配置です' : e.fit ? '間取りの外形に自動で合わせた配置です' : '未調整（自動で合わせられませんでした）';
}

/** 2 点合わせで建物の角を拾う対象: 表示中でメッシュのあるグループだけ（隠れている PDF の建物を 3DS 越しに拾わない） */
export function pickRoots(groups: THREE.Object3D[]): THREE.Object3D[] {
  return groups.filter((g) => g.visible && g.children.length > 0);
}

/** o が root の子孫（root 自身を含む）か */
export function descendsFrom(o: THREE.Object3D | null, root: THREE.Object3D): boolean {
  for (let p = o; p; p = p.parent) if (p === root) return true;
  return false;
}

export function createExternalPanel(deps: ExternalPanelDeps): ExternalPanel {
  const { ctx, sc, center: c, R } = deps;
  const v: Viewer = ctx.app.viewer;
  const canvasEl = v.renderer.domElement;
  let ctrl: ExternalController | null = externalController();
  // 日照ステップ表示中: external を見せ、置き換えなら PDF の建物を隠す。他のステップでは逆
  if (!ctrl && state.external) ctrl = installExternal(v, state.external);
  setExternalMounted(v, true);
  ctrl?.sync(v);

  const flyTop = () => v.flyTo({ pos: c.clone().add(new THREE.Vector3(0.01, R * 4.2, 0.02)), target: c.clone(), fov: 40 });

  // ---------------------------------------------------------------- 読み込み

  const fileIn = h('input', { type: 'file', accept: ACCEPT_EXT.map((e) => '.' + e).join(','), style: 'display:none' }) as HTMLInputElement;
  fileIn.addEventListener('change', () => {
    const f = fileIn.files?.[0];
    fileIn.value = '';
    if (f) void importFrom(() => loadExternal(f), f.name);
  });
  const importFrom = async (load: () => Promise<ImportedModel>, label: string) => {
    const pm = progressModal('3D データを読み込んでいます', false);
    pm.set(0.2, label);
    try {
      const m = await load();
      pm.set(0.85, '間取りの外形に合わせています…');
      await new Promise((r) => setTimeout(r, 0));
      // 待ち受け中の 2 点合わせは、指した角が古い建物のものなので中止する
      cancelTwoPoint(TWO_POINT_ABORT_EXT);
      ctrl = installExternal(v, createExternal(m));
      const fitted = runAutoFit();
      deps.invalidateResults();
      refresh();
      deps.applySun();
      flyTop();
      const tri = `${m.triangles.toLocaleString()} 三角形`;
      if (fitted) toast(`${m.name} を読み込みました（${tri}）。間取りの外形に合わせました`, 'ok');
      else toast(`${m.name} を読み込みました（${tri}）。自動では合わせられなかったので、手で位置を合わせてください`, 'info', 8000);
    } catch (e) {
      toast((e as Error).message, 'error', 9000);
    } finally {
      pm.close();
    }
  };

  /**
   * 間取りに自動で合わせ、単位や鏡像の疑いがあれば案内する。合わせられたら true（例外や false 戻りなら false。配置は変えない）。
   * preferRotDeg: 同点のときに優先する回転（省略時は今の回転）
   */
  const runAutoFit = (preferRotDeg?: number): boolean => {
    if (!ctrl) return false;
    let fitted = false;
    try {
      // 戻り値は PlanFit（成功時）。外形が取れないときに false を返す版の controller でも扱えるようにする
      const r: unknown = ctrl.autoFitToPlan(v, preferRotDeg);
      fitted = r !== false;
    } catch (e) {
      toast(`間取りに合わせられませんでした: ${(e as Error).message}`, 'error', 8000);
      return false;
    }
    if (!fitted) {
      toast('間取りに合わせられませんでした（3DS か間取りの外形が取れません）。手で位置を合わせてください', 'error', 8000);
      return false;
    }
    ctrl.ext.manual = false;
    const fit = ctrl.ext.fit;
    if (fit) {
      if (suggestsUnitError(fit)) toast(`PDF の外形 ${sizeText(fit.pdfW, fit.pdfD)} に対して 3DS は ${sizeText(fit.extW, fit.extD)} です。単位を確認してください`, 'info', 8000);
      else if (suggestsMirror(fit.score, fit.mirrorScore ?? fit.score)) toast(`外形の形が合いません（残差 ${fit.score.toFixed(2)} m。左右反転すると ${(fit.mirrorScore ?? fit.score).toFixed(2)} m）。鏡像で保存されたデータなら「左右反転」を試してください`, 'info', 8000);
      else if (fit.mismatchM > 0.6) toast(`PDF の外形 ${sizeText(fit.pdfW, fit.pdfD)} に対して 3DS は ${sizeText(fit.extW, fit.extD)} です（ポーチ・下屋などが含まれていると差が出ます）。主屋の壁を PDF の外形に合わせました`, 'info', 8000);
    }
    return true;
  };

  // ---------------------------------------------------------------- 変更の反映（1 本に集約）

  /** 配置・単位などの変更後: controller を同期（必要なら作り直し）、影の範囲を合わせ、結果を無効化、表示を更新 */
  const apply = (opts: { rebuild?: boolean; refit?: boolean; preferRotDeg?: number } = {}) => {
    if (!ctrl) return;
    // 指した角はワールド座標なので、3DS が動く前に待ち受けを中止する（単位・反転・床高・微調整・回転・自動合わせのすべてがここを通る）
    cancelTwoPoint(TWO_POINT_ABORT_EXT);
    if (opts.rebuild) ctrl.rebuild(v);
    if (opts.refit) runAutoFit(opts.preferRotDeg);
    else ctrl.sync(v);
    deps.invalidateResults();
    deps.applySun();
    refresh();
  };
  const nudge = (dx: number, dz: number) => {
    if (!ctrl) return;
    ctrl.ext.dx = Math.round((ctrl.ext.dx + dx) * 1000) / 1000;
    ctrl.ext.dz = Math.round((ctrl.ext.dz + dz) * 1000) / 1000;
    ctrl.ext.manual = true;
    apply();
  };
  const rotate = (d: number) => {
    if (!ctrl) return;
    ctrl.ext.planRotDeg = normDeg180(Math.round((ctrl.ext.planRotDeg + d) * 100) / 100);
    ctrl.ext.manual = true;
    apply();
  };

  // ---------------------------------------------------------------- パネル

  const info = h('div', { class: 'highlight', style: 'display:none' });
  const controls = h('div', { style: 'display:none' });
  const unitSel = h('select', null, UNITS.map((u) => h('option', { value: u }, UNIT_LABEL[u]))) as HTMLSelectElement;
  const scaleIn = h('input', { type: 'number', step: 'any', min: 0.000001, value: 1 }) as HTMLInputElement;
  const scaleField = field('1 単位 = 何 m か', scaleIn, '任意の倍率。例: 1 単位が 1 尺なら 0.303');
  const mirrorCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const floorIn = h('input', { type: 'number', step: 0.05, min: -5, max: 10 }) as HTMLInputElement;
  const replacesCb = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const stateLine = h('div', { class: 'hint' });
  // 戻すときは、前回の自動合わせが選んだ回転を優先する（手で 90° 回した後に 180° 側へ飛ばないように）
  const resetBtn = h('button', { class: 'btn sm ghost', onclick: () => apply({ refit: true, preferRotDeg: ctrl?.ext.fit?.planRotDeg }) }, '自動配置に戻す') as HTMLButtonElement;
  const rotBtn = (label: string, deg: number, title: string) => h('button', { class: 'btn sm', title, onclick: () => rotate(deg) }, label);

  unitSel.addEventListener('change', () => {
    if (!ctrl) return;
    ctrl.ext.placement.unit = unitSel.value as LengthUnit;
    scaleField.style.display = unitSel.value === 'custom' ? '' : 'none';
    apply({ rebuild: true, refit: true });
  });
  scaleIn.addEventListener('change', () => {
    if (!ctrl) return;
    const s = +scaleIn.value;
    if (!(s > 0)) return;
    ctrl.ext.placement.customScale = s;
    apply({ rebuild: true, refit: true });
  });
  mirrorCb.addEventListener('change', () => {
    if (!ctrl) return;
    ctrl.ext.placement.mirror = mirrorCb.checked;
    apply({ rebuild: true, refit: true });
  });
  floorIn.addEventListener('change', () => {
    if (!ctrl) return;
    const f = +floorIn.value;
    if (!Number.isFinite(f)) return;
    ctrl.ext.floor1M = f;
    apply();
  });
  replacesCb.addEventListener('change', () => {
    if (!ctrl) return;
    cancelTwoPoint(TWO_POINT_ABORT_EXT);
    ctrl.setReplaces(v, replacesCb.checked);
    deps.invalidateResults();
    deps.applySun();
    refresh();
  });

  const refresh = () => {
    const e = ctrl?.ext;
    const has = !!e && ctrl?.wrapper.parent === v.groups.external;
    info.style.display = has ? '' : 'none';
    controls.style.display = has ? '' : 'none';
    if (!e || !ctrl) return;
    clear(info);
    const lines: (string | HTMLElement)[] = [];
    if (e.fit) {
      const f = e.fit;
      const diff = f.mismatchM <= 0.3 ? '一致' : `差 ${f.mismatchM.toFixed(1)} m`;
      lines.push(h('b', null, `PDF 外形 ${sizeText(f.pdfW, f.pdfD)}／3DS ${sizeText(f.extW, f.extD)}（${diff}）`));
      const mirror = suggestsMirror(f.score, f.mirrorScore ?? f.score);
      lines.push(`外形の残差 ${f.score.toFixed(2)} m${mirror ? ' — 形が合いません。左右反転を試してください' : f.mismatchM > 0.3 ? '（PDF に無いポーチ・下屋などの分。主屋の壁で合わせています）' : ''}${f.swapped ? '（幅と奥行きを入れ替えて合わせました）' : ''}`);
    } else lines.push(h('b', null, `${e.model.name}`));
    const b = ctrl.worldBox();
    lines.push(`3DS の大きさ ${(b.max.x - b.min.x).toFixed(1)}×${(b.max.z - b.min.z).toFixed(1)} m・高さ ${(b.max.y - b.min.y).toFixed(1)} m／回転 ${e.planRotDeg.toFixed(0)}°・ずれ 右 ${e.dx.toFixed(2)} m・下 ${e.dz.toFixed(2)} m`);
    for (const n of e.model.notes) lines.push(h('span', { class: 'hint' }, n));
    for (const l of lines) info.append(typeof l === 'string' ? h('div', null, l) : l);
    unitSel.value = e.placement.unit;
    scaleIn.value = String(e.placement.customScale);
    scaleField.style.display = e.placement.unit === 'custom' ? '' : 'none';
    mirrorCb.checked = e.placement.mirror;
    // floor1M 未設定なら PDF の 1 階床高と同じ（= 3DS の底面を GL に置く）
    floorIn.value = (e.floor1M ?? pdfFloorText()).toFixed(2);
    replacesCb.checked = e.replaces;
    stateLine.textContent = placementStateText(e);
    resetBtn.disabled = !e.manual;
  };
  const pdfFloorText = () => {
    const st = v.state;
    const r1 = st?.meta.rooms.find((r) => r.floor.level === 1) ?? st?.meta.rooms[0];
    return r1 ? r1.floorY : 0;
  };

  const removeBtn = h(
    'button',
    {
      class: 'btn sm ghost',
      onclick: () => {
        if (!ctrl) return;
        cancelTwoPoint();
        installExternal(v, null);
        ctrl = null;
        deps.invalidateResults();
        deps.applySun();
        refresh();
        toast('3DS を外しました。PDF から起こした建物に戻ります', 'ok');
      },
    },
    '3DS を外す',
  );

  controls.append(
    field('単位', unitSel, '寸法から推定しています。大きさが合わないときは変えてください'),
    scaleField,
    h('label', { class: 'check' }, mirrorCb, '左右反転（鏡像で保存されたデータ）'),
    field('1階の床の高さ (m)', floorIn, `3DS の最下点から 1 階の床までの高さ。PDF の 1 階床（GL+${pdfFloorText().toFixed(2)} m）に合わせて上下します`),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => apply({ refit: true }) }, '間取りに自動で合わせる')),
    h('div', { class: 'field-label', style: 'margin-top:8px' }, '位置の微調整（図面の上下左右で）'),
    // 4 列のグリッド（btn-row だと 4 つ目が折り返して 1 つだけ次の行になる）
    h(
      'div',
      { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:4px 0' },
      h('button', { class: 'btn sm', onclick: () => nudge(0, -0.1) }, '上へ0.1m'),
      h('button', { class: 'btn sm', onclick: () => nudge(0, 0.1) }, '下へ0.1m'),
      h('button', { class: 'btn sm', onclick: () => nudge(-0.1, 0) }, '左へ0.1m'),
      h('button', { class: 'btn sm', onclick: () => nudge(0.1, 0) }, '右へ0.1m'),
      h('button', { class: 'btn sm', onclick: () => nudge(0, -0.5) }, '上へ0.5m'),
      h('button', { class: 'btn sm', onclick: () => nudge(0, 0.5) }, '下へ0.5m'),
      h('button', { class: 'btn sm', onclick: () => nudge(-0.5, 0) }, '左へ0.5m'),
      h('button', { class: 'btn sm', onclick: () => nudge(0.5, 0) }, '右へ0.5m'),
    ),
    h(
      'div',
      { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:4px 0' },
      rotBtn('↺ 90°', -90, '上から見て反時計回りに 90°（3D の上で Shift+R）'),
      rotBtn('↻ 90°', 90, '上から見て時計回りに 90°（3D の上で R）'),
      rotBtn('↺ 1°', -1, '上から見て反時計回りに 1°'),
      rotBtn('↻ 1°', 1, '上から見て時計回りに 1°'),
    ),
    h('label', { class: 'check' }, replacesCb, '3DS で影を計算する（PDF の建物は隠す）'),
    h('div', { class: 'btn-row', style: 'align-items:center' }, stateLine, resetBtn, removeBtn),
  );

  const panel = section(
    '設計の 3D データで正確な建物にする',
    h('p', { class: 'hint', style: 'margin:0 0 6px' }, '設計チームの 3DS（OBJ/STL/GLB/FBX も可）を読み込むと、図面から起こした建物の代わりに正確な形で影を落とします。読み込むと間取り（PDF）の外形に自動で合わせます。3D の画面にファイルを落としても読み込めます'),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => fileIn.click() }, 'ファイルを選択（3DS など）'), h('button', { class: 'btn sm', onclick: () => void importFrom(loadSampleExternal, 'サンプルの住宅') }, 'サンプルの住宅で試す'), fileIn),
    info,
    controls,
  );
  refresh();

  // ---------------------------------------------------------------- 3D の画面へのドロップ

  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDrop = (e: DragEvent) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    void importFrom(() => loadExternal(f), f.name);
  };
  canvasEl.addEventListener('dragover', onDragOver);
  canvasEl.addEventListener('drop', onDrop);

  // ---------------------------------------------------------------- 2 点合わせ

  const twoPointBtn = h('button', { class: 'btn sm block', style: 'margin-top:6px' }, TWO_POINT_LABEL) as HTMLButtonElement;
  let tp: { picks: THREE.Vector3[]; markers: THREE.Group } | null = null;
  let down: { x: number; y: number } | null = null;
  const ghost = new Map<THREE.Material, { transparent: boolean; opacity: number; depthWrite: boolean }>();

  /** 待ち受け中に建物を半透明にする（航空写真の上の角が見えるように） */
  const setGhost = (on: boolean) => {
    if (on) {
      for (const g of [v.groups.external, v.groups.building, v.groups.roof])
        g.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          for (const mt of Array.isArray(m.material) ? m.material : [m.material]) {
            if (!mt) continue;
            if (!ghost.has(mt)) ghost.set(mt, { transparent: mt.transparent, opacity: mt.opacity, depthWrite: mt.depthWrite });
            mt.transparent = true;
            mt.opacity = 0.25;
            mt.depthWrite = false;
            mt.needsUpdate = true;
          }
        });
    } else {
      for (const [mt, o] of ghost) {
        mt.transparent = o.transparent;
        mt.opacity = o.opacity;
        mt.depthWrite = o.depthWrite;
        mt.needsUpdate = true;
      }
      ghost.clear();
    }
    v.invalidate();
  };
  const setStatus = () => {
    const armed = !!tp;
    twoPointBtn.classList.toggle('dark', armed);
    twoPointBtn.textContent = armed ? twoPointStepText(tp!.picks.length) : TWO_POINT_LABEL;
    canvasEl.style.cursor = armed ? 'crosshair' : '';
  };
  const addMarker = (p: THREE.Vector3, n: number, kind: 'building' | 'aerial') => {
    if (!tp) return;
    const color = kind === 'building' ? ALIGN_COLORS.model : ALIGN_COLORS.target;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.35, 32), new THREE.MeshBasicMaterial({ color, toneMapped: false, depthTest: false, transparent: true, opacity: 0.9 }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.copy(p).setY(p.y + 0.05);
    disc.renderOrder = 20;
    disc.castShadow = false;
    disc.userData.noShadow = true;
    const label = textSprite(String(n), { size: 44, color: '#fff', bg: color, scale: 1.1 });
    label.position.copy(p).setY(p.y + 0.6);
    label.userData.noShadow = true;
    tp.markers.add(disc, label);
    if (kind === 'aerial') {
      const P = tp.picks[tp.picks.length - 2];
      const geo = new THREE.BufferGeometry().setFromPoints([P.clone().setY(P.y + 0.05), p.clone().setY(p.y + 0.05)]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: '#ffd24a', toneMapped: false, depthTest: false }));
      line.renderOrder = 20;
      line.userData.noShadow = true;
      tp.markers.add(line);
    }
    v.invalidate();
  };
  const ndcOf = (e: PointerEvent) => {
    const r = canvasEl.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  /**
   * 建物の角を拾う: 見えているグループ（3DS・PDF の建物・屋根）のうち手前に当たったもの。角に吸着する。
   * 置き換え中は PDF の建物・屋根が隠れているので 3DS だけ、置き換えでない 3DS は PDF の建物と重なって見えるので見えている方を拾う
   */
  const pickBuilding = (ndc: THREE.Vector2): THREE.Vector3 | null => {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, v.camera);
    const roots = pickRoots([v.groups.external, v.groups.building, v.groups.roof]);
    if (!roots.length) return null;
    const hits = rc.intersectObjects(roots, true);
    const hit = hits.find((x) => (x.object as THREE.Mesh).isMesh && x.object.visible);
    if (!hit) return null;
    const onExt = !!ctrl && descendsFrom(hit.object, ctrl.wrapper);
    return snapCorner(hit.point, hit.object as THREE.Mesh, onExt ? ctrl : null);
  };
  /** 吸着: 当たったメッシュの頂点が 0.3 m 以内にあればそれ、external ならその高さの外形（軒先なら軒先）の頂点 0.6 m 以内、無ければそのまま */
  const snapCorner = (p: THREE.Vector3, mesh: THREE.Mesh, ext: ExternalController | null): THREE.Vector3 => {
    let best: THREE.Vector3 | null = null;
    let bd = 0.3;
    const pos = mesh.geometry.getAttribute('position');
    if (pos) {
      mesh.updateMatrixWorld(true);
      const w = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        w.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        const d = w.distanceTo(p);
        if (d <= bd) {
          bd = d;
          best = w.clone();
        }
      }
    }
    if (best) return best;
    if (ext) {
      const local = ext.worldToLocal(p);
      const hull = ext.outlineLocal({ yMin: local.y - 0.3, yMax: local.y + 0.3 });
      const s = snapToOutlineVertex({ e: local.x, n: -local.z }, hull, 0.6);
      if (s) return ext.localToWorld(s).setY(p.y);
    }
    return p.clone();
  };
  const finishTwoPoint = async () => {
    if (!tp || tp.picks.length < 4 || !state.model) return;
    const [P1, Q1, P2, Q2] = tp.picks;
    const en = (p: THREE.Vector3): EN => sc.fromWorld(p);
    // 2 つの角が近いと向きが定まらない（吸着で同じ角の別の頂点に付くと 1e-6 m のチェックは通ってしまう）
    if (pairTooClose(en(P1), en(P2)) || pairTooClose(en(Q1), en(Q2))) {
      toast(TOO_CLOSE_MSG, 'error', 7000);
      cancelTwoPoint();
      return;
    }
    let fit;
    try {
      fit = solveTwoPoint([en(P1), en(P2)], [en(Q1), en(Q2)], { allowScale: false });
    } catch (e) {
      toast(`2 点が近すぎます: ${(e as Error).message}`, 'error');
      cancelTwoPoint();
      return;
    }
    const r = applyTwoPointToSite(state.site, state.model.northAngleDeg, fit);
    cancelTwoPoint();
    state.model.northAngleDeg = r.northAngleDeg;
    state.site = { ...state.site, offsetE: r.offsetE, offsetN: r.offsetN };
    emit('model');
    ctx.app.ensureScene();
    ctrl?.sync(v);
    sc.buildNeighbors();
    deps.showLoc();
    deps.invalidateResults();
    await deps.reloadContext();
    ctrl?.sync(v);
    flyTop();
    const ratio = fit.scaleRatio ?? 1;
    toast(`2 点合わせで位置と向きを合わせました（残差 ${fit.rmsM.toFixed(2)} m）`, 'ok');
    if (Math.abs(ratio - 1) > 0.05) toast(`クリックした 2 点の間隔が建物と航空写真で ${Math.round(Math.abs(ratio - 1) * 100)}% 違います。同じ角を選んでいるか確認してください`, 'info', 8000);
  };
  const handlePick = (e: PointerEvent) => {
    if (!tp) return;
    const ndc = ndcOf(e);
    const i = tp.picks.length;
    if (i % 2 === 0) {
      const p = pickBuilding(ndc);
      if (!p) {
        toast('建物の角をクリックしてください');
        return;
      }
      if (i === 2 && pairTooClose(sc.fromWorld(tp.picks[0]), sc.fromWorld(p))) {
        toast(`${TOO_CLOSE_MSG}。別の角をクリックしてください`, 'error', 7000);
        return;
      }
      tp.picks.push(p);
      addMarker(p, i / 2 + 1, 'building');
      setGhost(true);
    } else {
      const q = sc.pickAerial(ndc);
      if (!q) {
        toast('航空写真の上をクリックしてください');
        return;
      }
      if (i === 3 && pairTooClose(sc.fromWorld(tp.picks[1]), sc.fromWorld(q))) {
        toast(`${TOO_CLOSE_MSG}。航空写真で別の角の位置をクリックしてください`, 'error', 7000);
        return;
      }
      tp.picks.push(q.clone());
      addMarker(q, (i - 1) / 2 + 1, 'aerial');
      setGhost(false);
    }
    setStatus();
    if (tp.picks.length >= 4) void finishTwoPoint();
  };
  const onDown = (e: PointerEvent) => {
    if (!tp || e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    if (!tp || e.button !== 0 || !down) return;
    const d = down;
    down = null;
    if (!isClick(d, { x: e.clientX, y: e.clientY })) return;
    handlePick(e);
  };
  canvasEl.addEventListener('pointerdown', onDown, true);
  canvasEl.addEventListener('pointerup', onUp, true);

  const cancelTwoPoint = (notice?: string) => {
    if (!tp) return;
    tp.markers.removeFromParent();
    tp.markers.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    tp = null;
    setGhost(false);
    setStatus();
    if (notice) toast(notice);
  };
  const armTwoPoint = async () => {
    if (tp) {
      cancelTwoPoint();
      return;
    }
    if (!(await deps.ensureAerial())) return;
    deps.cancelPlacing();
    const markers = new THREE.Group();
    markers.name = 'two-point-markers';
    v.groups.overlay.add(markers);
    tp = { picks: [], markers };
    setStatus();
    flyTop();
  };
  twoPointBtn.addEventListener('click', () => void armTwoPoint());

  // ---------------------------------------------------------------- キー操作（Esc 中止、R / Shift+R で 90° 回転）

  let hover = false;
  const onEnter = () => (hover = true);
  const onLeave = () => (hover = false);
  canvasEl.addEventListener('pointerenter', onEnter);
  canvasEl.addEventListener('pointerleave', onLeave);
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === 'Escape') {
      cancelTwoPoint('2 点合わせを中止しました');
      deps.cancelPlacing();
      return;
    }
    if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && hover && ctrl) {
      e.preventDefault();
      // 待ち受け中に回すと指した角がずれるので、R は受け付けない
      if (tp) {
        toast('2 点合わせの待ち受け中は回転できません（先に Esc で中止してください）');
        return;
      }
      rotate(e.shiftKey ? -90 : 90);
    }
  };
  window.addEventListener('keydown', onKey);

  // 検証用（E2E）: 内部状態を覗く
  (window as unknown as { __sunDebug: unknown }).__sunDebug = {
    state,
    sc,
    external: () => ctrl,
    geo: () => siteLatLon(state.site),
    twoPoint: {
      picks: () => tp?.picks ?? null,
      armed: () => !!tp,
      /** 画面の NDC で建物の角を拾ってみる（吸着後の点か null） */
      pickBuilding: (nx: number, ny: number) => pickBuilding(new THREE.Vector2(nx, ny)),
      /** 同じ raycast の当たり（名前・距離・表示・3DS か） */
      hits: (nx: number, ny: number) => {
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(nx, ny), v.camera);
        const roots = pickRoots([v.groups.external, v.groups.building, v.groups.roof]);
        return rc.intersectObjects(roots, true).map((x) => ({ name: x.object.name, type: x.object.type, visible: x.object.visible, distance: x.distance, point: x.point.toArray(), ext: !!ctrl && descendsFrom(x.object, ctrl.wrapper) }));
      },
    },
  };

  return {
    section: panel,
    twoPointBtn,
    cancelTwoPoint,
    afterModelRebuilt: () => {
      ctrl?.sync(v);
      refresh();
    },
    dispose: () => {
      cancelTwoPoint();
      canvasEl.removeEventListener('dragover', onDragOver);
      canvasEl.removeEventListener('drop', onDrop);
      canvasEl.removeEventListener('pointerdown', onDown, true);
      canvasEl.removeEventListener('pointerup', onUp, true);
      canvasEl.removeEventListener('pointerenter', onEnter);
      canvasEl.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('keydown', onKey);
      canvasEl.style.cursor = '';
      setExternalMounted(v, false);
    },
  };
}

/** 建設地セクションに置く 2 点合わせのボタンと説明 */
export function twoPointBlock(panel: ExternalPanel): HTMLElement[] {
  return [panel.twoPointBtn, h('p', { class: 'hint', style: 'margin:2px 0 0' }, '建物の角と、航空写真でその角がある位置を 2 組クリックすると、位置と向きを同時に合わせます（真上から見える屋根＝軒先の角どうしで合わせてください）。大きくずれているときは先に上の「敷地をクリック」で大まかに合わせます')];
}
