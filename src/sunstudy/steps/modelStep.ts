/**
 * ステップ 2「建物を置く」: 3D データの読み込み、単位・上方向・寸法の確認、方位・正確な位置合わせ・位置・高さ（GL）の調整
 *
 * 状態は study.model / study.placement。変更のたびに
 *   単位・上方向・鏡像・表示・オブジェクト → placed.rebuild() → applyTransform() → emit('placement')
 *   方位・位置・高さ → placed.applyTransform() → emit('placement')
 * を行い、足跡が変わるので rebuildEnvironment（敷地内の既存建物の除外）と影の範囲（fitShadow）を更新する。
 * 「地形に接地」が ON のとき、底面の高さ baseY = 足跡の地形平均 + 設計 GL オフセット（モジュール内の ui に保持）。
 *
 * 正確な位置合わせ（alignment.ts）:
 *   2 点合わせ … 建物の角 → 航空写真でその角の実際の位置、を 2 組クリックして方位・位置を解く（倍率は変えず、比だけ報告）
 *   敷地の輪郭に合わせる … 3DS に敷地（site）オブジェクトがあれば輪郭ごと ICP でフィット、無ければ向きだけ敷地の辺に合わせる
 *   どう置いたかは placement.alignment に残し、ピンが動いても建物が地球上の同じ所に留まるようにする（placeStep が使う）。
 *   手で動かした（ドラッグ・ボタン・数値・回転）ら自動の記録は外し、pivot の緯度経度だけ残す。
 */
import * as THREE from 'three';
import { h, clear, toast, progressModal, section, field, segmented, modal } from '../../app/dom';
import { localDate, sunDirectionWorld, sunPosition } from '../../sun/solar';
import type { StudyStep, StudyCtx } from '../shell';
import { emit, study } from '../state';
import { DEFAULT_PLACEMENT, UNIT_LABEL, bearingName, frameFromLocal } from '../types';
import type { AlignmentPair, EN, ImportedModel, LengthUnit, UpAxis } from '../types';
import { ALIGN_COLORS, MIN_PAIR_DIST_M, TWO_POINT_CANCEL_HINT, TWO_POINT_STEPS } from '../../sun/align';
import { ACCEPT_EXT, importModelFile, isSiteObjectName, loadSampleModel, unitScale } from '../importModel';
import type { PlacedModel } from '../importModel';
import { SCALE_WARN, alignmentContextOk, alignmentLabel, describeAlignment, fitToSite, orientToSite, pivotLatLonOf, reapplyAlignment, refitSiteAlignment, scaleSuspect, siteScaleText, twoPointPlacement } from '../alignment';
import { buildingCenter, buildingExclusionEN, buildingExtent, currentPlaced, ensurePlaced } from '../building';
import { groundY, rebuildEnvironment, sitePolygonEN } from '../environment';
import { saveRecent } from '../project';
import { clearGroup } from '../scene';
import type { StudyScene } from '../scene';

/** 住宅らしい寸法の目安 (m)。外れたら単位の確認を促す */
const SANE = { wMin: 4, wMax: 30, hMin: 3, hMax: 20 };
/** 敷地内の高低差がこれを超えたら設計 GL の確認を促す (m) */
const TERRAIN_RANGE_WARN = 0.5;
/** 周辺環境の作り直し（重い）をまとめる待ち時間 (ms) */
const ENV_DEBOUNCE_MS = 300;
const SAMPLE_PATH = 'samples/sample_house.3ds';
/** これ未満のポインタの移動はクリック（ドラッグ移動を始めない／角の指定とみなす） (px) */
const DRAG_THRESHOLD_PX = 3;
/** 角の指定: 当たったメッシュの最寄り頂点に吸着する距離 (m) */
const SNAP_VERTEX_M = 0.3;
/** 角の指定: 当たった高さの外形（凸包）の最寄り頂点に吸着する距離 (m)、その高さ帯の半幅 (m) */
const SNAP_HULL_M = 0.6;
const SNAP_BAND_M = 0.3;
/** 2 点合わせのボタン（手順の文言・目印の色・角の最小距離は両アプリ共通: src/sun/align.ts） */
const TWO_POINT_LABEL = '📍 2 点合わせ（建物の角 → 航空写真の同じ角）';
/** 大きさの比の表し方（1000 倍なら小数は要らない） */
const fmtRatio = (k: number) => (k >= 10 ? k.toFixed(0) : k.toFixed(3));

const UNIT_SHORT: Record<LengthUnit, string> = { mm: 'mm', cm: 'cm', m: 'm', in: 'in', ft: 'ft', custom: '任意の倍率' };

/** この起動で「配置の確認」を済ませたか（確認は 1 回だけ） */
let confirmed = false;
/** 高さ（地盤）の UI 状態。baseY = 足跡の地形平均 + designGL（follow のとき） */
const ui = { follow: true, designGL: 0, modelRef: null as ImportedModel | null };
let cleanup: (() => void)[] = [];
let envTimer = 0;
let envScene: StudyScene | null = null;

const r2 = (v: number) => Math.round(v * 100) / 100;
const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v : 0).toFixed(d);
const fmtInt = (v: number) => Math.round(v).toLocaleString('ja-JP');
const fmtRaw = (v: number) => (v >= 100 ? fmtInt(v) : v.toLocaleString('ja-JP', { maximumFractionDigits: 2 }));
const signed = (v: number, d = 2) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(d)}`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const num = (el: HTMLInputElement, fallback: number) => {
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
};
const stamp = () => new Date().toISOString();
const materialsOf = (m: THREE.Mesh): THREE.Material[] => (Array.isArray(m.material) ? m.material : [m.material]).filter((x): x is THREE.Material => !!x);

// ---------------------------------------------------------------------------
// 幾何
// ---------------------------------------------------------------------------

/** 足跡の 4 隅・中心・辺の中点 */
function footprintSamples(fp: { e: number; n: number }[]): { e: number; n: number }[] {
  const out = fp.map((p) => ({ e: p.e, n: p.n }));
  if (!fp.length) return out;
  let ce = 0;
  let cn = 0;
  for (const p of fp) {
    ce += p.e / fp.length;
    cn += p.n / fp.length;
  }
  out.push({ e: ce, n: cn });
  for (let i = 0; i < fp.length; i++) {
    const a = fp[i];
    const b = fp[(i + 1) % fp.length];
    out.push({ e: (a.e + b.e) / 2, n: (a.n + b.n) / 2 });
  }
  return out;
}

/** 足跡の下の地形（ワールド y）: 平均・最低・最高 */
function terrainUnder(p: PlacedModel): { mean: number; min: number; max: number } {
  const s = footprintSamples(p.footprintEN());
  if (!s.length) return { mean: 0, min: 0, max: 0 };
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const q of s) {
    const y = groundY(q.e, q.n);
    sum += y;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  return { mean: sum / s.length, min, max };
}

/** 「地形に接地」が ON なら底面の高さを足跡の地形平均 + 設計 GL に */
function applyGL(p: PlacedModel) {
  if (ui.follow) study.placement.baseY = r2(terrainUnder(p).mean + ui.designGL);
}

/** 冬至 12:00 の太陽（影の見え方の確認用） */
function winterSun(scene: StudyScene) {
  const f = study.frame;
  if (!f) return;
  const sp = sunPosition(localDate(study.ui.year, 12, 22, 12), f.lat, f.lon);
  scene.setSunDirection(sunDirectionWorld(sp.azimuth, sp.elevation, 0), true);
}

function fitShadow(scene: StudyScene) {
  scene.fitShadow(buildingCenter(), Math.max(45, buildingExtent() * 1.5));
}

/** 視点の距離の目安 (m) */
function viewRadius(p: PlacedModel): number {
  return Math.max(p.size.x, p.size.y, p.size.z) * 1.2 + 6;
}

/** 南東の上空から見る 3/4 の視点 */
function flyQuarter(scene: StudyScene, p: PlacedModel) {
  const c = buildingCenter();
  const R = viewRadius(p);
  scene.flyTo({ pos: c.clone().add(new THREE.Vector3(R * 1.2, R * 0.9, R * 1.4)), target: c.clone().add(new THREE.Vector3(0, p.size.y / 2, 0)), fov: 45 });
}

/** 真上から見る */
function flyTop(scene: StudyScene, p: PlacedModel) {
  const c = buildingCenter();
  const R = viewRadius(p);
  scene.flyTo({ pos: c.clone().add(new THREE.Vector3(0.01, Math.max(60, R * 4), 0.02)), target: c.clone(), fov: 40 });
}

/** 入力欄の N（図面の上から真北へ時計回り, 0..360） */
function northInput(): number {
  return (((-study.placement.headingDeg) % 360) + 360) % 360;
}

/** 元データの水平の長辺（元の単位） */
function rawHorizontalLong(m: ImportedModel, up: UpAxis): number {
  const s = m.rawBox.getSize(new THREE.Vector3());
  return up === 'z' ? Math.max(s.x, s.y) : Math.max(s.x, s.z);
}

/** 敷地境界までの離れ（閉じた敷地ポリゴンがあるとき） */
function boundaryText(p: PlacedModel): string | null {
  const site = sitePolygonEN();
  if (!site) return null;
  const fp = p.footprintEN();
  if (fp.length < 3) return null;
  const ext = (pts: { e: number; n: number }[]) => ({
    minE: Math.min(...pts.map((q) => q.e)),
    maxE: Math.max(...pts.map((q) => q.e)),
    minN: Math.min(...pts.map((q) => q.n)),
    maxN: Math.max(...pts.map((q) => q.n)),
  });
  const s = ext(site);
  const b = ext(fp);
  const f = (v: number) => (v >= 0 ? `約${fmt(v, 1)} m` : `敷地外 ${fmt(-v, 1)} m`);
  return `敷地境界までの離れ: 北 ${f(s.maxN - b.maxN)}／南 ${f(b.minN - s.minN)}／東 ${f(s.maxE - b.maxE)}／西 ${f(b.minE - s.minE)}`;
}

/** 周辺環境の作り直し（まとめて実行） */
function scheduleEnv(scene: StudyScene, ms: number) {
  envScene = scene;
  if (envTimer) {
    clearTimeout(envTimer);
    envTimer = 0;
  }
  const run = () => {
    envTimer = 0;
    rebuildEnvironment(scene, buildingExclusionEN());
  };
  if (ms <= 0) run();
  else envTimer = window.setTimeout(run, ms);
}

function flushEnv() {
  if (envTimer && envScene) {
    clearTimeout(envTimer);
    envTimer = 0;
    rebuildEnvironment(envScene, buildingExclusionEN());
  }
}

/** 配置が変わった: pivot（建物の基準点）の緯度経度を記録する。ピンが動いても建物を地球上の同じ所に保つ（placeStep） */
function notePivot() {
  const f = study.frame;
  if (!f) return;
  const pl = study.placement;
  const al = pl.alignment ?? { at: stamp() };
  al.pivotLatLon = pivotLatLonOf(f, pl);
  al.at = stamp();
  pl.alignment = al;
}

/** 手で動かした: 自動の位置合わせの記録（種類・対応点）は外し、pivot の緯度経度だけ残す */
function markManual() {
  const pl = study.placement;
  pl.alignment = { at: stamp(), pivotLatLon: pl.alignment?.pivotLatLon };
  notePivot();
}

// ---------------------------------------------------------------------------
// 位置合わせの目印（align グループ。影を落とさない・解析から除く）
// ---------------------------------------------------------------------------

function markOverlay(o: THREE.Object3D) {
  o.userData.overlay = true;
  o.userData.noShadow = true;
  o.castShadow = false;
  o.receiveShadow = false;
}

/** 番号ラベルのスプライト（画面上で一定の大きさ）。src/sun/context.ts の textSprite と同じ描き方だが、プレゼン側の 3D 一式を読み込まないためにここに持つ */
function numberSprite(text: string, color: string): THREE.Sprite {
  const size = 40;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = `bold ${size}px 'Noto Sans JP', 'Hiragino Sans', sans-serif`;
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width) + size * 0.8;
  c.height = Math.ceil(size * 1.5);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, 0, c.width, c.height, c.height / 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2 + size * 0.05);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false, sizeAttenuation: false }));
  const s = 0.9 * 0.032;
  sp.scale.set((c.width / c.height) * s, s, 1);
  return sp;
}

/** 番号つきの円盤（①②） */
function markerDisc(pos: THREE.Vector3, label: string, color: string): THREE.Object3D {
  const g = new THREE.Group();
  g.position.copy(pos);
  markOverlay(g);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.35, 32), new THREE.MeshBasicMaterial({ color, toneMapped: false, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.05;
  disc.renderOrder = 8;
  markOverlay(disc);
  g.add(disc);
  try {
    const sp = numberSprite(label, color);
    sp.position.y = 0.6;
    sp.renderOrder = 9;
    markOverlay(sp);
    g.add(sp);
  } catch {
    /* canvas が使えない環境では番号なし */
  }
  return g;
}

/** 建物の角 → 航空写真の点、を結ぶ線 */
function markerLine(a: THREE.Vector3, b: THREE.Vector3): THREE.Object3D {
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: '#ffffff', toneMapped: false, depthTest: false, transparent: true, opacity: 0.9 }));
  line.renderOrder = 8;
  markOverlay(line);
  return line;
}

/** 2 点合わせの進行状態 */
interface PickState {
  /** 0: 建物の角 1、1: その実際の位置、2: 建物の角 2、3: その実際の位置 */
  stage: 0 | 1 | 2 | 3;
  locals: EN[];
  targets: EN[];
  modelWorld: THREE.Vector3[];
  /** 半透明にした建物のマテリアルの元の値 */
  ghost: { mat: THREE.Material; transparent: boolean; opacity: number; depthWrite: boolean }[] | null;
}

// ---------------------------------------------------------------------------
// ステップ
// ---------------------------------------------------------------------------

export const modelStep: StudyStep = {
  id: 'model',
  label: '建物を置く',
  enabled: () => !!study.frame,
  disabledHint: '先に「建設地」で場所を指定してください',
  uses3d: true,
  unmount() {
    for (const f of cleanup.splice(0)) f();
    flushEnv();
  },
  mount(ctx: StudyCtx) {
    const { scene, stage, side, shell } = ctx;
    scene.controls.enabled = true;

    // 配置済みの建物を用意し、地形に合わせる
    const first = ensurePlaced(scene);
    if (first && study.model) {
      if (ui.modelRef !== study.model) {
        // 別の経路（プロジェクトの読込など）で入った model: 保存されていた底面の高さを尊重して設計 GL を逆算
        ui.modelRef = study.model;
        ui.follow = true;
        ui.designGL = r2(study.placement.baseY - terrainUnder(first).mean);
      } else {
        const before = study.placement.baseY;
        applyGL(first);
        first.applyTransform();
        if (before !== study.placement.baseY) emit('placement');
      }
    }
    rebuildEnvironment(scene, buildingExclusionEN());
    winterSun(scene);
    fitShadow(scene);

    // ---- ファイル入力（ステージとサイドで共用） ----
    const fileIn = h('input', { type: 'file', accept: ACCEPT_EXT.map((e) => '.' + e).join(','), style: 'display:none' });
    fileIn.addEventListener('change', () => {
      const f = fileIn.files?.[0];
      fileIn.value = '';
      if (f) void importFrom(async () => importModelFile({ name: f.name, data: await f.arrayBuffer() }), f.name);
    });

    const importFrom = async (load: () => Promise<ImportedModel>, label: string) => {
      const pm = progressModal('3D データを読み込んでいます', false);
      pm.set(0.2, label);
      try {
        const m = await load();
        pm.set(0.85, '配置しています…');
        applyImported(m);
      } catch (e) {
        toast(errMsg(e), 'error', 9000);
      } finally {
        pm.close();
      }
    };

    /** 読み込んだ 3D データを状態に入れ、配置して表示を作り直す */
    const applyImported = (m: ImportedModel) => {
      cancelPick();
      study.model = m;
      study.placement = { ...DEFAULT_PLACEMENT, unit: m.guessedUnit, upAxis: m.guessedUp, hiddenObjects: m.objects.filter((o) => o.autoHidden).map((o) => o.name) };
      ui.follow = true;
      ui.designGL = 0;
      ui.modelRef = m;
      confirmed = false;
      emit('model');
      const p = ensurePlaced(scene);
      if (!p) return;
      applyGL(p);
      p.applyTransform();
      emit('placement');
      saveRecent();
      flyQuarter(scene, p);
      scheduleEnv(scene, 0);
      fitShadow(scene);
      toast(`${m.name} を読み込みました（${fmtInt(m.triangles)} 三角形）`, 'ok');
      render();
    };

    // ---- 変更後の共通処理 ----
    let refreshers: (() => void)[] = [];
    const refreshAll = () => {
      for (const f of refreshers) f();
    };
    /** 単位・上方向・鏡像・表示・オブジェクトの変更。shapeChanged = false は表示（色）だけの変更（外形は変わらない） */
    const afterRebuild = (shapeChanged = true) => {
      const p = currentPlaced();
      if (!p) return;
      cancelPick();
      p.rebuild();
      const pl = study.placement;
      const al = pl.alignment;
      if (al?.kind === 'twoPoint' && !alignmentContextOk(pl)) {
        // 反転・上方向が変わると、指した角の座標はもう使えない
        pl.alignment = { at: stamp(), pivotLatLon: al.pivotLatLon };
        toast('上方向・反転を変えたので位置合わせをやり直してください', 'info', 8000);
      } else if (al?.kind === 'twoPoint' && study.frame) {
        // 単位が変わっても、指した角は航空写真の同じ所に留まる（対応点を新しい倍率で換算して解き直す）
        reapplyAlignment(study.frame, pl, p);
      } else if (shapeChanged && (al?.kind === 'siteFit' || al?.kind === 'orient')) {
        // 形・寸法が変わると合わせた外形も変わる: 今の形で合わせ直す。できなければ記録を外す（古い残差を表示し続けない）
        const r = refitSiteAlignment(p, pl, sitePolygonEN());
        if (r === 'dropped') toast('形・寸法を変えたので敷地の輪郭への合わせをやり直してください', 'info', 8000);
        else if (r === 'refit' && al.kind === 'siteFit')
          toast(scaleSuspect(al) ? `敷地の向きだけ合わせ直しました（${siteScaleText(al.scaleRatio ?? 1)}。単位を確認してください）` : `敷地の輪郭に合わせ直しました（残差 ${fmt(al.rmsM ?? NaN)} m）`, 'ok');
      }
      applyGL(p);
      p.applyTransform();
      notePivot();
      emit('placement');
      saveRecent();
      scheduleEnv(scene, 0);
      fitShadow(scene);
      refreshAll();
    };
    /** 方位・位置・高さの変更 */
    const afterTransform = (immediateEnv = false) => {
      const p = currentPlaced();
      if (!p) return;
      if (pick) {
        // 2 点合わせの途中でパネルから配置を変えた: 指した角の目印が建物から離れるので中止する
        cancelPick();
        toast('配置を変えたので 2 点合わせを中止しました');
      }
      p.applyTransform();
      applyGL(p);
      p.applyTransform();
      notePivot();
      emit('placement');
      saveRecent();
      scheduleEnv(scene, immediateEnv ? 0 : ENV_DEBOUNCE_MS);
      fitShadow(scene);
      refreshAll();
    };
    /** 手で位置をずらす（ボタン・矢印キー） */
    const nudge = (de: number, dn: number) => {
      const pl = study.placement;
      pl.offsetE = r2(pl.offsetE + de);
      pl.offsetN = r2(pl.offsetN + dn);
      markManual();
      afterTransform(false);
    };
    /** 手で向きを回す（+ は上から見て時計回り） */
    const rotateBy = (deltaDeg: number) => {
      const pl = study.placement;
      pl.headingDeg = r2(pl.headingDeg + deltaDeg);
      markManual();
      afterTransform(false);
    };

    // ---- 2 点合わせ（角の指定） ----
    const canvas = scene.renderer.domElement;
    let pick: PickState | null = null;
    let pickDown: { x: number; y: number } | null = null;
    /** サイドの表示を更新する関数（renderSide が差し替える） */
    let refreshAlign: () => void = () => {};
    /** ステージ上部の案内（renderStage が作る）。2 点合わせ中は手順に差し替える。キー操作の案内はタッチ端末では隠す（CSS .keys） */
    let stageNote: HTMLElement | null = null;
    const refreshStageNote = () => {
      if (!stageNote) return;
      clear(stageNote);
      if (pick) stageNote.append(`${TWO_POINT_STEPS[pick.stage]}　／　${TWO_POINT_CANCEL_HINT}`);
      else stageNote.append('建物をドラッグして敷地に合わせます　／　', h('span', { class: 'keys' }, '矢印キー: 0.1 m（Shift: 1 m）　R / Shift+R: 90° 回転　／　'), '空いた所をドラッグ: 回転　右ドラッグ: 移動');
    };
    const baseCursor = () => (scene.navMode === 'pan' ? 'grab' : '');
    const syncPickUI = () => {
      canvas.style.cursor = pick ? 'crosshair' : baseCursor();
      refreshStageNote();
      refreshAlign();
    };
    const setGhost = (on: boolean) => {
      if (!pick) return;
      if (on && !pick.ghost) {
        const saved: NonNullable<PickState['ghost']> = [];
        scene.groups.building.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          for (const mat of materialsOf(m)) {
            saved.push({ mat, transparent: mat.transparent, opacity: mat.opacity, depthWrite: mat.depthWrite });
            mat.transparent = true;
            mat.opacity = 0.25;
            mat.depthWrite = false;
            mat.needsUpdate = true;
          }
        });
        pick.ghost = saved;
      } else if (!on && pick.ghost) {
        for (const g of pick.ghost) {
          g.mat.transparent = g.transparent;
          g.mat.opacity = g.opacity;
          g.mat.depthWrite = g.depthWrite;
          g.mat.needsUpdate = true;
        }
        pick.ghost = null;
      }
      scene.invalidate();
    };
    /** 目印・半透明・モードを片付ける（結果は触らない） */
    const endPick = () => {
      if (!pick) return;
      setGhost(false);
      pick = null;
      pickDown = null;
      clearGroup(scene.groups.align);
      scene.invalidate();
      syncPickUI();
    };
    const cancelPick = () => {
      if (!pick) return;
      endPick();
    };
    const startPick = () => {
      const p = currentPlaced();
      if (!p || !study.frame) return;
      if (pick) {
        cancelPick();
        toast('2 点合わせを中止しました');
        return;
      }
      if (!study.aerial) {
        // 航空写真が無いと「その角の実際の位置」を指せない（地形の無地の面を指しても意味が無い）
        toast('航空写真が無いので 2 点合わせは使えません。「建設地」で周辺環境を読み込んでください', 'info', 7000);
        return;
      }
      pick = { stage: 0, locals: [], targets: [], modelWorld: [], ghost: null };
      clearGroup(scene.groups.align);
      flyTop(scene, p);
      syncPickUI();
      toast('真上から見ています。建物の角（軒先でも壁でも）をクリックし、つぎに航空写真でその角の実際の位置をクリックします。ホイールで拡大、右ドラッグ（または ✋移動 モード・スペースキー）で画面をずらせます', 'info', 8000);
    };
    /** クリックした建物の点を角に吸着させる: 当たったメッシュの最寄り頂点（0.3 m）→ その高さの外形の最寄り頂点（0.6 m）→ そのまま */
    const snapCorner = (p: PlacedModel, hit: THREE.Intersection): THREE.Vector3 => {
      const pt = hit.point.clone();
      const mesh = hit.object as THREE.Mesh;
      const pos = mesh.geometry?.getAttribute?.('position');
      let best: THREE.Vector3 | null = null;
      let bestD = SNAP_VERTEX_M;
      if (pos) {
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
          const d = v.distanceTo(pt);
          if (d < bestD) {
            bestD = d;
            best = v.clone();
          }
        }
      }
      if (best) return best;
      const local = p.pivot.worldToLocal(pt.clone());
      const hull = p.outlineLocal({ yMin: local.y - SNAP_BAND_M, yMax: local.y + SNAP_BAND_M });
      let bestH: EN | null = null;
      let bd = SNAP_HULL_M;
      for (const q of hull) {
        const d = Math.hypot(q.e - local.x, q.n + local.z);
        if (d < bd) {
          bd = d;
          bestH = q;
        }
      }
      if (bestH) return p.pivot.localToWorld(new THREE.Vector3(bestH.e, local.y, -bestH.n));
      return pt;
    };
    const finishPick = (p: PlacedModel) => {
      const f = study.frame;
      if (!pick || !f) return;
      const [a, b] = pick.locals;
      if (Math.hypot(a.e - b.e, a.n - b.n) < MIN_PAIR_DIST_M) {
        toast(`2 つの角が近すぎます（${MIN_PAIR_DIST_M} m 以上離れた角を選んでください）。もう一度やり直してください`, 'error', 7000);
        cancelPick();
        return;
      }
      const pairs: AlignmentPair[] = pick.locals.map((l, i) => ({ local: { e: l.e, n: l.n }, target: frameFromLocal(f, pick!.targets[i].e, pick!.targets[i].n) }));
      let sol: ReturnType<typeof twoPointPlacement>;
      try {
        sol = twoPointPlacement(p, f, pairs);
      } catch (e) {
        toast(`2 点合わせを計算できませんでした: ${errMsg(e)}`, 'error', 7000);
        cancelPick();
        return;
      }
      endPick();
      const pl = study.placement;
      pl.headingDeg = r2(pl.headingDeg + (((sol.headingDeg - pl.headingDeg) % 360) + 540) % 360 - 180);
      pl.offsetE = r2(sol.offsetE);
      pl.offsetN = r2(sol.offsetN);
      pl.alignment = { kind: 'twoPoint', pairs, unitScaleM: unitScale(pl), mirror: pl.mirror, upAxis: pl.upAxis, rmsM: sol.rmsM, scaleRatio: sol.scaleRatio, at: stamp() };
      // 位置合わせをやり直したので、日照へ進むときの「配置の確認」をもう一度出す
      confirmed = false;
      afterTransform(true);
      toast(`2 点合わせで建物を置きました（残差 ${fmt(sol.rmsM)} m）`, 'ok');
      if (Math.abs(sol.scaleRatio - 1) > SCALE_WARN) toast(`航空写真上の距離はモデルの ${sol.scaleRatio.toFixed(3)} 倍です（約 ${(Math.abs(sol.scaleRatio - 1) * 100).toFixed(1)} % の差）。単位を確認してください。「寸法もこの比で合わせる」で合わせられます`, 'info', 8000);
    };
    const handlePick = (ev: PointerEvent) => {
      if (!pick) return;
      const p = currentPlaced();
      if (!p || !study.frame) {
        cancelPick();
        return;
      }
      const ndc = scene.ndcFromEvent(ev);
      if (pick.stage === 0 || pick.stage === 2) {
        const hit = scene.pick(ndc, [scene.groups.building]);
        if (!hit) {
          toast('建物の角をクリックしてください（航空写真ではなく建物の上）');
          return;
        }
        const world = snapCorner(p, hit);
        const local = p.pivot.worldToLocal(world.clone());
        pick.locals.push({ e: local.x, n: -local.z });
        pick.modelWorld.push(world);
        scene.groups.align.add(markerDisc(world, pick.stage === 0 ? '①' : '②', ALIGN_COLORS.model));
        pick.stage = pick.stage === 0 ? 1 : 3;
        setGhost(true);
      } else {
        const hit = scene.pick(ndc, [scene.groups.terrain]);
        if (!hit) {
          toast('航空写真（地面）の上をクリックしてください');
          return;
        }
        const t = hit.point.clone();
        pick.targets.push({ e: t.x, n: -t.z });
        const idx = pick.stage === 1 ? 0 : 1;
        scene.groups.align.add(markerDisc(t, idx === 0 ? '①' : '②', ALIGN_COLORS.target), markerLine(pick.modelWorld[idx], t));
        setGhost(false);
        if (pick.stage === 3) {
          finishPick(p);
          return;
        }
        pick.stage = 2;
      }
      scene.invalidate();
      syncPickUI();
    };
    const pickUp = (ev: PointerEvent) => {
      if (!pick || !pickDown || ev.button !== 0) return;
      const moved = Math.hypot(ev.clientX - pickDown.x, ev.clientY - pickDown.y);
      pickDown = null;
      if (moved > DRAG_THRESHOLD_PX) return;
      handlePick(ev);
    };

    // ---- 3D 上で建物をドラッグ（3 px 動いてから移動とみなす） ----
    let drag: { start: THREE.Vector3; origE: number; origN: number; plane: THREE.Plane; id: number; sx: number; sy: number; active: boolean } | null = null;
    const planePoint = (ev: PointerEvent, plane: THREE.Plane): THREE.Vector3 | null => {
      const rc = new THREE.Raycaster();
      rc.setFromCamera(scene.ndcFromEvent(ev), scene.camera);
      const out = new THREE.Vector3();
      return rc.ray.intersectPlane(plane, out) ? out : null;
    };
    /** 建物のドラッグを取り消して元の位置に戻す（2 本目の指が触れた = ピンチなど） */
    const cancelDrag = () => {
      if (!drag) return;
      study.placement.offsetE = drag.origE;
      study.placement.offsetN = drag.origN;
      try {
        canvas.releasePointerCapture(drag.id);
      } catch {
        /* 既に解放 */
      }
      drag = null;
      scene.controls.enabled = true;
      canvas.style.cursor = baseCursor();
      currentPlaced()?.applyTransform();
      scene.invalidate();
      refreshPos();
    };
    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      if (drag) {
        // 2 本目のポインタ（タッチのピンチ）: 建物を動かさず、視点操作に任せる
        cancelDrag();
        return;
      }
      if (pick) {
        // 位置合わせ中はクリックで角を指す。視点の操作（OrbitControls）はそのまま通す
        pickDown = { x: ev.clientX, y: ev.clientY };
        return;
      }
      const p = currentPlaced();
      if (!p) return;
      const hit = scene.pick(scene.ndcFromEvent(ev), [scene.groups.building]);
      if (!hit) return;
      // 水平面 y = baseY（法線 (0,1,0)、定数 -baseY）上でポインタの移動量を測る
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -study.placement.baseY);
      const start = planePoint(ev, plane);
      if (!start) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      scene.controls.enabled = false;
      drag = { start, origE: study.placement.offsetE, origN: study.placement.offsetN, plane, id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, active: false };
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* 古い環境 */
      }
    };
    const onMove = (ev: PointerEvent) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const p = currentPlaced();
      if (!p) return;
      if (!drag.active) {
        if (Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < DRAG_THRESHOLD_PX) return;
        drag.active = true;
        canvas.style.cursor = 'move';
      }
      const pt = planePoint(ev, drag.plane);
      if (!pt) return;
      // ワールド x → 東、z → 南（n = -z）
      study.placement.offsetE = r2(drag.origE + (pt.x - drag.start.x));
      study.placement.offsetN = r2(drag.origN - (pt.z - drag.start.z));
      p.applyTransform();
      scene.invalidate();
      refreshPos();
    };
    const endDrag = (ev?: PointerEvent) => {
      if (!drag) return;
      if (ev && ev.pointerId !== drag.id) return;
      if (ev) {
        try {
          canvas.releasePointerCapture(drag.id);
        } catch {
          /* 既に解放 */
        }
      }
      const moved = drag.active;
      drag = null;
      scene.controls.enabled = true;
      canvas.style.cursor = baseCursor();
      if (moved) {
        markManual();
        afterTransform(true);
      }
    };
    canvas.addEventListener('pointerdown', onDown, { capture: true });
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointerup', pickUp);
    canvas.addEventListener('pointercancel', endDrag);
    cleanup.push(() => {
      canvas.removeEventListener('pointerdown', onDown, { capture: true });
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointerup', pickUp);
      canvas.removeEventListener('pointercancel', endDrag);
      if (drag) {
        try {
          canvas.releasePointerCapture(drag.id);
        } catch {
          /* 既に解放 */
        }
        drag = null;
      }
      cancelPick();
      scene.controls.enabled = true;
      canvas.style.cursor = baseCursor();
    });

    // ---- キー操作（ポインタが 3D の上にあり、入力欄にフォーカスが無いとき）----
    let hover = false;
    const onEnter = () => (hover = true);
    const onLeave = () => (hover = false);
    canvas.addEventListener('pointerenter', onEnter);
    canvas.addEventListener('pointerleave', onLeave);
    const typing = (e: KeyboardEvent) => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pick) {
          e.preventDefault();
          cancelPick();
          toast('2 点合わせを中止しました');
        }
        return;
      }
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      // 2 点合わせ中は移動・回転しない（指した角の目印が建物から離れる）
      if (pick) return;
      if (!currentPlaced() || !hover) return;
      const step = e.shiftKey ? 1 : 0.1;
      switch (e.key) {
        case 'ArrowUp':
          nudge(0, step);
          break;
        case 'ArrowDown':
          nudge(0, -step);
          break;
        case 'ArrowLeft':
          nudge(-step, 0);
          break;
        case 'ArrowRight':
          nudge(step, 0);
          break;
        case 'r':
        case 'R':
          rotateBy(e.shiftKey ? -90 : 90);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    cleanup.push(() => {
      window.removeEventListener('keydown', onKey);
      canvas.removeEventListener('pointerenter', onEnter);
      canvas.removeEventListener('pointerleave', onLeave);
    });

    // ---- 位置の表示（ドラッグ中にも更新） ----
    let refreshPos: () => void = () => {};

    // ---- ステージ ----
    const renderStage = () => {
      clear(stage);
      stageNote = null;
      if (study.model) {
        stageNote = h('div', { class: 'stage-note' });
        refreshStageNote();
        stage.appendChild(stageNote);
        return;
      }
      const zone = h(
        'div',
        { class: 'dropzone' },
        h('div', { class: 'big' }, '🏠'),
        h('p', null, h('b', null, '3DS ファイルをここにドロップ'), h('br'), 'または'),
        h('button', { class: 'btn primary', onclick: () => fileIn.click() }, '3D データのファイルを選択'),
      );
      zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('hover');
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('hover'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('hover');
        const f = e.dataTransfer?.files?.[0];
        if (f) void importFrom(async () => importModelFile({ name: f.name, data: await f.arrayBuffer() }), f.name);
      });
      stage.appendChild(
        h(
          'div',
          { class: 'drop light', style: 'pointer-events:auto' },
          h(
            'div',
            { class: 'drop-card' },
            h('h1', null, '3D データを読み込む'),
            h('p', null, '設計チームの 3DS データ（.3ds）をそのまま読み込めます。形だけを取り込み、テクスチャ（画像）は使いません。単位（mm・m など）と上方向は寸法から自動で判定し、つぎの画面で確認・修正できます。'),
            h('div', { style: 'margin:0 0 14px' }, ...['3DS', 'OBJ', 'STL', 'GLB / glTF', 'FBX'].map((s) => h('span', { class: 'fmt' }, s))),
            zone,
            h(
              'div',
              { class: 'btn-row', style: 'justify-content:center;margin-top:14px' },
              h('span', { style: 'font-size:13px;color:#8b9098;align-self:center' }, 'お試し:'),
              h('button', { class: 'btn sm', onclick: () => void importFrom(() => loadSampleModel(SAMPLE_PATH), 'サンプルの住宅') }, 'サンプルの住宅で試す（切妻・約10m×9m）'),
            ),
            h('p', { class: 'sub' }, '読み込んだデータはこのパソコンの中だけで処理され、外部には送られません。'),
          ),
        ),
      );
    };

    // ---- サイド ----
    const renderSide = () => {
      clear(side);
      refreshers = [];
      refreshPos = () => {};
      refreshAlign = () => {};
      const m = study.model;
      const p = currentPlaced();
      if (!m || !p) {
        side.append(
          h('h2', null, '建物の 3D データ'),
          h('p', { class: 'lead' }, '画面の中央に 3DS などの 3D データをドロップしてください。読み込むと、大きさ（単位）・向き・位置・高さをこのパネルで確認・調整できます。'),
          section('対応形式', h('div', { class: 'info-box' }, '3DS（3ds Max・設計 CAD の書き出し）／OBJ／STL／GLB（glTF）／FBX。テクスチャは読み込みません（白モデル、または元データの色）。'), h('button', { class: 'btn block', onclick: () => fileIn.click() }, 'ファイルを選択')),
          section('建設地', h('div', { class: 'info-box' }, study.frame?.address ?? '未指定'), h('button', { class: 'btn block', onclick: () => void shell.go('place') }, '場所を変える')),
          fileIn,
        );
        return;
      }
      const pl = study.placement;

      side.append(
        h('h2', null, '建物の確認と配置'),
        h('p', { class: 'lead' }, '読み込んだ 3D データの大きさ（単位）と向きを確認し、航空写真の上で敷地に合わせます。寸法が実際の建物と合っているか、必ずお確かめください。'),
        h(
          'div',
          { class: 'info-box model-info' },
          h('b', null, m.name),
          `（${m.format.toUpperCase()}・${fmtInt(m.triangles)} 三角形・${m.objects.length} オブジェクト）`,
          h('div', { class: 'btn-row', style: 'margin:6px 0 0' }, h('button', { class: 'btn sm', onclick: () => fileIn.click() }, '別の 3D データを読み込む')),
        ),
        fileIn,
      );
      for (const n of m.notes) side.appendChild(h('div', { class: 'info-box' }, n));

      // ---- 単位（縮尺） ----
      const rawSize = m.rawBox.getSize(new THREE.Vector3());
      const unitSel = h('select', null, ...(Object.keys(UNIT_LABEL) as LengthUnit[]).map((u) => h('option', { value: u, selected: u === pl.unit }, UNIT_LABEL[u])));
      const customIn = h('input', { type: 'number', step: 'any', min: 0, value: String(pl.customScale) });
      const customRow = field('1 単位 = ○ m', customIn, '例: 1 単位が 0.3 m なら 0.3');
      customRow.style.display = pl.unit === 'custom' ? '' : 'none';
      /** 任意の倍率に切り替えて UI を合わせる */
      const setCustomScale = (s: number) => {
        pl.customScale = Number(s.toPrecision(6));
        pl.unit = 'custom';
        unitSel.value = 'custom';
        customIn.value = String(pl.customScale);
        customRow.style.display = '';
      };
      unitSel.addEventListener('change', () => {
        pl.unit = unitSel.value as LengthUnit;
        customRow.style.display = pl.unit === 'custom' ? '' : 'none';
        afterRebuild();
      });
      customIn.addEventListener('change', () => {
        const v = num(customIn, 0);
        if (v > 0) {
          pl.customScale = v;
          afterRebuild();
        } else toast('0 より大きい値を入力してください', 'error');
      });
      const dimsBox = h('div', { class: 'dims' });
      const dimWarn = h('div', { class: 'warn', style: 'display:none' }, '住宅としては大きすぎ／小さすぎます。単位を確認してください（目安: 幅・奥行 4〜30 m、高さ 3〜20 m）');
      const widthIn = h('input', { type: 'number', step: 'any', min: 0, placeholder: '例: 9.1' });
      const fitBtn = h('button', {
        class: 'btn',
        onclick: () => {
          const w = num(widthIn, 0);
          // 表示中のオブジェクトの長辺（元の単位）。寸法表示と同じ基準で合わせる
          const raw = Math.max(p.size.x, p.size.z) / unitScale(pl) || rawHorizontalLong(m, pl.upAxis);
          if (!(w > 0)) {
            toast('実際の幅（m）を入力してください', 'error');
            return;
          }
          if (!(raw > 0)) {
            toast('元データの寸法が取れないため合わせられません', 'error');
            return;
          }
          setCustomScale(w / raw);
          afterRebuild();
          toast(`長い方の辺を ${fmt(w)} m に合わせました（1 単位 = ${pl.customScale.toPrecision(4)} m）`, 'ok');
        },
      }, '合わせる');
      const refreshDims = () => {
        const d = p.dimensions();
        clear(dimsBox);
        for (const [label, v] of [
          ['幅（図面の横）', d.w],
          ['奥行（図面の縦）', d.d],
          ['高さ', d.h],
        ] as [string, number][])
          dimsBox.appendChild(h('div', { class: 'stat' }, h('b', null, fmt(v), h('small', null, 'm')), h('span', null, label)));
        const bad = d.w < SANE.wMin || d.w > SANE.wMax || d.d < SANE.wMin || d.d > SANE.wMax || d.h < SANE.hMin || d.h > SANE.hMax;
        dimWarn.style.display = bad ? '' : 'none';
      };
      refreshDims();
      refreshers.push(refreshDims);
      side.appendChild(
        section(
          '単位（縮尺）',
          field('元データの長さの単位', unitSel, `寸法から自動判定: ${UNIT_LABEL[m.guessedUnit]}`),
          h('p', { class: 'hint', style: 'margin:0 0 6px' }, `寸法 ${fmtRaw(rawSize.x)} × ${fmtRaw(rawSize.y)} × ${fmtRaw(rawSize.z)}（元データの単位）→ ${UNIT_SHORT[m.guessedUnit]} と判定`),
          customRow,
          dimsBox,
          h('p', { class: 'hint', style: 'margin:0 0 6px' }, '回転する前の寸法（図面の横 × 縦 × 高さ）。m 単位の実寸です'),
          dimWarn,
          field('実際の建物の幅（長い方の辺, m）を入力して合わせる', h('div', { class: 'btn-row', style: 'margin:0' }, h('div', { style: 'flex:1' }, widthIn), fitBtn), '図面の寸法が分かるときは、ここで合わせるのが確実です'),
        ),
      );

      // ---- 上方向・反転 ----
      const mirrorCb = h('input', { type: 'checkbox', checked: pl.mirror });
      mirrorCb.addEventListener('change', () => {
        pl.mirror = mirrorCb.checked;
        afterRebuild();
      });
      side.appendChild(
        section(
          '上方向・反転',
          segmented<UpAxis>(
            [
              { value: 'z', label: 'Z-up（3DS・3ds Max 標準）' },
              { value: 'y', label: 'Y-up' },
            ],
            pl.upAxis,
            (v) => {
              pl.upAxis = v;
              afterRebuild();
            },
          ),
          h('p', { class: 'hint' }, `自動判定: ${m.guessedUp === 'z' ? 'Z-up' : 'Y-up'}。建物が横倒しに見えるときは切り替えてください`),
          h('label', { class: 'check' }, mirrorCb, '左右反転（鏡像）'),
          h('p', { class: 'hint', style: 'margin:0' }, '航空写真と比べて左右が逆のとき（鏡像で保存されたデータ）に使います'),
        ),
      );

      // ---- オブジェクト ----
      const objList = h('div', { class: 'obj-list' });
      const refreshObjects = () => {
        clear(objList);
        const s = unitScale(pl);
        const hidden = new Set(pl.hiddenObjects);
        for (const o of m.objects) {
          const cb = h('input', { type: 'checkbox', checked: !hidden.has(o.name), title: '表示' });
          cb.addEventListener('change', () => {
            const set = new Set(pl.hiddenObjects);
            if (cb.checked) set.delete(o.name);
            else set.add(o.name);
            pl.hiddenObjects = [...set];
            afterRebuild();
          });
          const sz = o.size.map((v) => fmt(v * s, 1)).join(' × ');
          objList.appendChild(
            h('label', { class: 'obj-row' }, cb, h('span', { class: 'obj-name', title: o.name }, o.name), h('span', { class: 'obj-meta' }, `${fmtInt(o.triangles)} 三角形・${sz} m`), o.reason ? h('span', { class: 'hint' }, `自動で非表示: ${o.reason}`) : null),
          );
        }
      };
      refreshObjects();
      refreshers.push(refreshObjects);
      const objBody = [h('p', { class: 'hint', style: 'margin:0 0 6px' }, 'チェックを外したオブジェクトは表示・解析から除きます。地面の板・敷地・ダミーは自動で外しています（戻せます）'), objList];
      side.appendChild(section('オブジェクト', m.objects.length > 12 ? h('details', { class: 'obj-details' }, h('summary', null, `オブジェクト一覧（${m.objects.length} 件）`), ...objBody) : h('div', null, ...objBody)));

      // ---- 方位（真北） ----
      const nIn = h('input', { type: 'number', step: 'any', value: fmt(northInput(), 1).replace(/\.0$/, '') });
      const headingOut = h('div', { class: 'info-box' });
      const setN = (N: number) => {
        N = ((N % 360) + 360) % 360;
        pl.headingDeg = r2(-N);
        nIn.value = fmt(N, 1).replace(/\.0$/, '');
        markManual();
        afterTransform(false);
      };
      nIn.addEventListener('change', () => setN(num(nIn, northInput())));
      const refreshHeading = () => {
        headingOut.textContent = `図面の上が向く方位: ${bearingName(pl.headingDeg)}（真北から時計回り ${fmt((((pl.headingDeg % 360) + 360) % 360), 0)}°）`;
        if (document.activeElement !== nIn) nIn.value = fmt(northInput(), 1).replace(/\.0$/, '');
      };
      refreshHeading();
      refreshers.push(refreshHeading);
      side.appendChild(
        section(
          '方位（真北）',
          h('p', { style: 'margin:0 0 6px;font-size:13px;line-height:1.7' }, '配置図（モデル）の真北は、図面の上から時計回りに'),
          h('div', { class: 'btn-row', style: 'margin:0 0 6px;align-items:center' }, h('div', { style: 'width:90px' }, nIn), h('span', null, '°'), h('button', { class: 'btn sm', onclick: () => setN(northInput() - 15) }, '−15°'), h('button', { class: 'btn sm', onclick: () => setN(northInput() - 1) }, '−1°'), h('button', { class: 'btn sm', onclick: () => setN(northInput() + 1) }, '+1°'), h('button', { class: 'btn sm', onclick: () => setN(northInput() + 15) }, '+15°')),
          h(
            'div',
            { class: 'btn-row', style: 'margin:0 0 6px;align-items:center' },
            h('button', { class: 'btn sm', title: '建物を上から見て反時計回りに 90° 回す（Shift+R）', onclick: () => rotateBy(-90) }, '↺ 90°'),
            h('button', { class: 'btn sm', title: '建物を上から見て時計回りに 90° 回す（R）', onclick: () => rotateBy(90) }, '↻ 90°'),
            h('span', { class: 'hint', style: 'margin:0' }, '図面が横向きに描かれているときに'),
          ),
          headingOut,
          h('p', { class: 'hint', style: 'margin:0' }, '地図の上＝真北です。図面の北矢印が磁北の場合は補正してください（関東 約+7°、札幌 約+9.5°）。正確に合わせるには下の「正確な位置合わせ」を使います。'),
        ),
      );

      // ---- 正確な位置合わせ ----
      const alignStatus = h('p', { class: 'hint', style: 'margin:0 0 8px;font-size:12.5px;color:var(--ink2)' });
      const twoPtBtn = h('button', { class: 'btn block', onclick: startPick }) as HTMLButtonElement;
      const scaleWarnText = h('div');
      const scaleBtn = h('button', {
        class: 'btn sm',
        onclick: () => {
          const k = pl.alignment?.scaleRatio;
          if (!k || !(k > 0) || !Number.isFinite(k)) return;
          setCustomScale(unitScale(pl) * k);
          // 新しい倍率で合わせ直す: 2 点合わせは対応点を換算して解き直し（reapplyAlignment）、敷地の輪郭は再フィット（refitSiteAlignment）
          afterRebuild();
          toast(`寸法を ${fmtRatio(k)} 倍にして合わせ直しました（1 単位 = ${pl.customScale.toPrecision(4)} m）`, 'ok');
        },
      }, '寸法もこの比で合わせる');
      const scaleWarn = h('div', { class: 'warn', style: 'display:none' }, scaleWarnText, h('div', { class: 'btn-row', style: 'margin:6px 0 0' }, scaleBtn));
      const siteHint = h('p', { class: 'hint', style: 'margin:4px 0 0' });
      const siteBtn = h('button', {
        class: 'btn block',
        onclick: () => {
          const site = sitePolygonEN();
          if (!site) {
            toast('先に「建設地」で敷地の輪郭を描いてください');
            return;
          }
          cancelPick();
          // 位置合わせをやり直したので、日照へ進むときの「配置の確認」をもう一度出す
          confirmed = false;
          if (p.siteOutlineLocal()) {
            const r = fitToSite(p, site, pl.headingDeg);
            if (!r) {
              toast('敷地の輪郭に合わせられませんでした', 'error');
              return;
            }
            pl.headingDeg = r2(r.headingDeg);
            pl.offsetE = r2(r.offsetE);
            pl.offsetN = r2(r.offsetN);
            pl.alignment = { kind: 'siteFit', rmsM: r.rmsM, scaleRatio: r.scaleRatio, at: stamp() };
            afterTransform(true);
            if (r.unitSuspect) {
              toast(`敷地の大きさが合わないので向きだけ合わせました。${siteScaleText(r.scaleRatio)}。単位（縮尺）を確認してください（「寸法もこの比で合わせる」で合わせられます）`, 'info', 9000);
            } else {
              toast(`敷地の輪郭に合わせました（残差 ${fmt(r.rmsM)} m）`, 'ok');
              if (r.convexOnly) toast('地図で描いた輪郭には凹みがありますが、3DS の敷地は外周が取れない形（接する 2 枚の板など）なので凸包で合わせています。残差が大きめに出ます', 'info', 8000);
              else if (r.rmsM > 0.5) toast('残差が大きめです。3DS の敷地オブジェクトと地図で描いた輪郭の形が違うかもしれません。航空写真で確かめてください', 'info', 8000);
            }
          } else {
            pl.headingDeg = r2(orientToSite(p, site, pl.headingDeg));
            pl.alignment = { kind: 'orient', at: stamp() };
            afterTransform(true);
            toast('建物の向きを敷地の辺に合わせました（位置は変えていません。航空写真に合わせてドラッグするか 2 点合わせで位置を決めてください）', 'info', 8000);
          }
        },
      }) as HTMLButtonElement;
      refreshAlign = () => {
        // 進行中はボタンに手順、状態行に進み具合と中止の仕方（同じ文を 2 か所に出さない）
        alignStatus.textContent = pick ? `2 点合わせ中（${pick.stage + 1} / 4）— ${TWO_POINT_CANCEL_HINT}` : describeAlignment(pl);
        twoPtBtn.textContent = pick ? TWO_POINT_STEPS[pick.stage] : TWO_POINT_LABEL;
        twoPtBtn.classList.toggle('dark', !!pick);
        twoPtBtn.disabled = !pick && !study.aerial;
        twoPtBtn.title = pick || study.aerial ? '' : '先に「建設地」で周辺環境（航空写真）を読み込むと使えます';
        const al = pl.alignment;
        const off = scaleSuspect(al);
        scaleWarn.style.display = off ? '' : 'none';
        if (off && al?.scaleRatio != null) {
          const k = al.scaleRatio;
          scaleWarnText.textContent = al.kind === 'twoPoint' ? `航空写真上の距離はモデルの ${k.toFixed(3)} 倍です（約 ${(Math.abs(k - 1) * 100).toFixed(1)} % の差）。単位（縮尺）が違うかもしれません。` : `${siteScaleText(k)}。単位（縮尺）が違うかもしれません。`;
        }
        const site = sitePolygonEN();
        siteBtn.disabled = !site;
        siteBtn.textContent = '敷地の輪郭に合わせる';
        // 敷地オブジェクトは「非表示にしてあるもの」だけが対象（表示している敷地は建物の一部として扱う）。その違いが分かる文言にする
        const siteObj = m.objects.find((o) => isSiteObjectName(o.name));
        siteHint.textContent = !site
          ? '先に「建設地」で敷地の輪郭を描くと使えます'
          : p.siteOutlineLocal()
            ? `3DS に敷地（${siteObj?.name ?? 'site'}）オブジェクトがあるので輪郭ごと合わせます${p.siteOutlineIsHull() ? '（外周が取れない形なので凸包で合わせます）' : ''}`
            : siteObj
              ? `敷地オブジェクト「${siteObj.name}」を非表示にすると輪郭ごと合わせられます（今は向きだけ合わせます）`
              : '3DS に敷地が無いので向きだけ合わせます';
      };
      refreshAlign();
      refreshers.push(refreshAlign);
      side.appendChild(
        section(
          '正確な位置合わせ',
          alignStatus,
          twoPtBtn,
          h('p', { class: 'hint', style: 'margin:4px 0 8px' }, '真上からの視点で、建物の角 → 航空写真に写っているその角、を 2 組クリックします（軒先なら軒先どうし）。角の近くをクリックすると自動で角に吸着します。方位と位置が決まり、寸法のずれも分かります。'),
          scaleWarn,
          siteBtn,
          siteHint,
        ),
      );

      // ---- 位置 ----
      const posOut = h('div', { class: 'info-box' });
      const eIn = h('input', { type: 'number', step: 0.01, value: fmt(pl.offsetE) });
      const nIn2 = h('input', { type: 'number', step: 0.01, value: fmt(pl.offsetN) });
      eIn.addEventListener('change', () => {
        pl.offsetE = r2(num(eIn, pl.offsetE));
        markManual();
        afterTransform(true);
      });
      nIn2.addEventListener('change', () => {
        pl.offsetN = r2(num(nIn2, pl.offsetN));
        markManual();
        afterTransform(true);
      });
      const resetBtn = h('button', {
        class: 'btn sm ghost',
        onclick: () => {
          pl.offsetE = 0;
          pl.offsetN = 0;
          markManual();
          afterTransform(true);
        },
      }, 'ピンの位置に戻す') as HTMLButtonElement;
      const nudgeRow = (label: string, de: number, dn: number) =>
        [h('span', { class: 'k' }, label), h('button', { class: 'btn sm', onclick: () => nudge(de * 0.1, dn * 0.1) }, '0.1 m'), h('button', { class: 'btn sm', onclick: () => nudge(de * 0.5, dn * 0.5) }, '0.5 m'), h('button', { class: 'btn sm', onclick: () => nudge(de * 2, dn * 2) }, '2 m')];
      refreshPos = () => {
        clear(posOut);
        posOut.append(`ピンから 東へ ${signed(pl.offsetE)} m／北へ ${signed(pl.offsetN)} m`);
        const b = boundaryText(p);
        if (b) posOut.append(h('br'), b);
        if (document.activeElement !== eIn) eIn.value = fmt(pl.offsetE);
        if (document.activeElement !== nIn2) nIn2.value = fmt(pl.offsetN);
        resetBtn.disabled = pl.offsetE === 0 && pl.offsetN === 0;
      };
      refreshPos();
      refreshers.push(refreshPos);
      side.appendChild(
        section(
          '位置',
          h('p', { class: 'hint', style: 'margin:0 0 6px' }, '真上から見た航空写真の上で、建物をドラッグして敷地に合わせます。細かい調整はボタン・矢印キー（0.1 m、Shift で 1 m）・数値で。'),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => flyTop(scene, p) }, '真上から見る'), h('button', { class: 'btn', onclick: () => flyQuarter(scene, p) }, '斜めから見る')),
          h('div', { class: 'nudge' }, ...nudgeRow('北へ', 0, 1), ...nudgeRow('南へ', 0, -1), ...nudgeRow('東へ', 1, 0), ...nudgeRow('西へ', -1, 0)),
          h('div', { class: 'pos-fields' }, field('東へ (m)', eIn), field('北へ (m)', nIn2)),
          h('div', { class: 'btn-row' }, resetBtn),
          posOut,
        ),
      );

      // ---- 高さ（地盤） ----
      const followCb = h('input', { type: 'checkbox', checked: ui.follow });
      const glIn = h('input', { type: 'number', step: 0.05, value: fmt(ui.designGL) });
      const baseIn = h('input', { type: 'number', step: 0.05, value: fmt(pl.baseY) });
      const glRow = field('設計 GL は周辺地盤より（m）', glIn, '＋で盛土、−で切土。造成計画の GL が分かるときに入れます');
      const baseRow = field('建物の底面の高さ（GL からの m）', baseIn, 'GL = ピン位置の地盤高');
      const glOut = h('div', { class: 'info-box' });
      const glWarn = h('div', { class: 'warn', style: 'display:none' });
      const syncGLRows = () => {
        glRow.style.display = ui.follow ? '' : 'none';
        baseRow.style.display = ui.follow ? 'none' : '';
      };
      followCb.addEventListener('change', () => {
        ui.follow = followCb.checked;
        if (ui.follow) ui.designGL = r2(num(glIn, ui.designGL));
        syncGLRows();
        afterTransform(true);
      });
      glIn.addEventListener('change', () => {
        ui.designGL = r2(num(glIn, ui.designGL));
        afterTransform(true);
      });
      baseIn.addEventListener('change', () => {
        pl.baseY = r2(num(baseIn, pl.baseY));
        afterTransform(true);
      });
      const refreshGL = () => {
        const t = terrainUnder(p);
        const ge = study.frame?.groundElev ?? 0;
        if (document.activeElement !== glIn) glIn.value = fmt(ui.designGL);
        if (document.activeElement !== baseIn) baseIn.value = fmt(pl.baseY);
        clear(glOut);
        glOut.append(`建物の底面: GL${signed(pl.baseY)}m（T.P.${signed(ge + pl.baseY)}m）`);
        if (study.grid) glOut.append(h('br'), `足元の地盤: 平均 GL${signed(t.mean)}m（最低 ${signed(t.min)} 〜 最高 ${signed(t.max)}）`);
        else glOut.append(h('br'), '地形データが無いため平地（GL±0）として扱っています。「建設地」で周辺環境を読み込むと地形に合わせます');
        const range = t.max - t.min;
        glWarn.style.display = range > TERRAIN_RANGE_WARN ? '' : 'none';
        glWarn.textContent = `敷地内に約 ${fmt(range, 1)} m の高低差があります。造成後の GL（設計 GL）を確認してください`;
      };
      syncGLRows();
      refreshGL();
      refreshers.push(refreshGL);
      side.appendChild(
        section(
          '高さ（地盤）',
          h('label', { class: 'check' }, followCb, '地形に接地（建物の足元の地盤の平均に合わせる）'),
          glRow,
          baseRow,
          glOut,
          glWarn,
          h('p', { class: 'hint', style: 'margin:0' }, 'GL = ピン位置の地盤高（国土地理院の標高データ）、建物の足元は足跡の地形平均。周辺建物の高さの比較や影の長さに影響します。'),
        ),
      );

      // ---- 表示 ----
      side.appendChild(
        section(
          '表示',
          segmented<'white' | 'original'>(
            [
              { value: 'white', label: '白モデル' },
              { value: 'original', label: '元の色' },
            ],
            pl.appearance,
            (v) => {
              pl.appearance = v;
              afterRebuild(false);
            },
          ),
          h('p', { class: 'hint', style: 'margin:0' }, '白モデルは影の形が見やすく、お客様への説明向きです'),
        ),
      );

      // ---- 進む ----
      const confirmAndGo = () => {
        cancelPick();
        if (confirmed) {
          void shell.go('sim');
          return;
        }
        const d = p.dimensions();
        const kv = (k: string, v: string) => [h('span', { class: 'k' }, k), h('span', null, v)];
        const content = h(
          'div',
          null,
          h('p', { style: 'margin:0 0 10px;font-size:13px;line-height:1.7' }, 'つぎの内容で日照シミュレーションに進みます。寸法や方位が違うと結果も違ってきますので、お確かめください。'),
          h(
            'div',
            { class: 'kv' },
            ...kv('単位', pl.unit === 'custom' ? `任意の倍率（1 単位 = ${pl.customScale.toPrecision(4)} m）` : UNIT_LABEL[pl.unit]),
            ...kv('寸法', `幅 ${fmt(d.w)} m × 奥行 ${fmt(d.d)} m × 高さ ${fmt(d.h)} m`),
            ...kv('方位', `図面の上が ${bearingName(pl.headingDeg)} を向く（真北は図面の上から時計回りに ${fmt(northInput(), 0)}°）`),
            ...kv('位置', `ピンから 東へ ${signed(pl.offsetE)} m／北へ ${signed(pl.offsetN)} m`),
            ...kv('位置合わせ', alignmentLabel(pl)),
            ...kv('GL', `建物の底面 GL${signed(pl.baseY)} m（T.P.${signed((study.frame?.groundElev ?? 0) + pl.baseY)} m）`),
          ),
        );
        modal('配置の確認', content, [
          { label: '戻って修正' },
          {
            label: '確認して進む',
            primary: true,
            onClick: () => {
              confirmed = true;
              void shell.go('sim');
            },
          },
        ]);
      };
      side.appendChild(
        h(
          'div',
          { class: 'btn-row', style: 'margin-top:16px' },
          h('button', { class: 'btn primary block', onclick: confirmAndGo }, '日照シミュレーションへ →'),
          h('button', { class: 'btn block ghost', onclick: () => void shell.go('place') }, '場所を変える'),
        ),
      );
    };

    const render = () => {
      renderStage();
      renderSide();
    };
    render();
  },
};
