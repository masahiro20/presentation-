/**
 * ステップ 2「建物を置く」: 3D データの読み込み、単位・上方向・寸法の確認、方位・位置・高さ（GL）の調整
 *
 * 状態は study.model / study.placement。変更のたびに
 *   単位・上方向・鏡像・表示・オブジェクト → placed.rebuild() → applyTransform() → emit('placement')
 *   方位・位置・高さ → placed.applyTransform() → emit('placement')
 * を行い、足跡が変わるので rebuildEnvironment（敷地内の既存建物の除外）と影の範囲（fitShadow）を更新する。
 * 「地形に接地」が ON のとき、底面の高さ baseY = 足跡の地形平均 + 設計 GL オフセット（モジュール内の ui に保持）。
 */
import * as THREE from 'three';
import { h, clear, toast, progressModal, section, field, segmented, modal } from '../../app/dom';
import { localDate, sunDirectionWorld, sunPosition } from '../../sun/solar';
import type { StudyStep, StudyCtx } from '../shell';
import { emit, study } from '../state';
import { DEFAULT_PLACEMENT, UNIT_LABEL, bearingName } from '../types';
import type { ImportedModel, LengthUnit, UpAxis } from '../types';
import { ACCEPT_EXT, importModelFile, loadSampleModel, unitScale } from '../importModel';
import type { PlacedModel } from '../importModel';
import { buildingCenter, buildingExtent, buildingFootprintEN, currentPlaced, ensurePlaced } from '../building';
import { groundY, rebuildEnvironment, sitePolygonEN } from '../environment';
import { saveRecent } from '../project';
import type { StudyScene } from '../scene';

/** 住宅らしい寸法の目安 (m)。外れたら単位の確認を促す */
const SANE = { wMin: 4, wMax: 30, hMin: 3, hMax: 20 };
/** 敷地内の高低差がこれを超えたら設計 GL の確認を促す (m) */
const TERRAIN_RANGE_WARN = 0.5;
/** 周辺環境の作り直し（重い）をまとめる待ち時間 (ms) */
const ENV_DEBOUNCE_MS = 300;
const SAMPLE_PATH = 'samples/sample_house.3ds';

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
    rebuildEnvironment(scene, buildingFootprintEN());
  };
  if (ms <= 0) run();
  else envTimer = window.setTimeout(run, ms);
}

function flushEnv() {
  if (envTimer && envScene) {
    clearTimeout(envTimer);
    envTimer = 0;
    rebuildEnvironment(envScene, buildingFootprintEN());
  }
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
    rebuildEnvironment(scene, buildingFootprintEN());
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
    /** 単位・上方向・鏡像・表示・オブジェクトの変更 */
    const afterRebuild = () => {
      const p = currentPlaced();
      if (!p) return;
      p.rebuild();
      applyGL(p);
      p.applyTransform();
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
      p.applyTransform();
      applyGL(p);
      p.applyTransform();
      emit('placement');
      saveRecent();
      scheduleEnv(scene, immediateEnv ? 0 : ENV_DEBOUNCE_MS);
      fitShadow(scene);
      refreshAll();
    };

    // ---- 3D 上で建物をドラッグ ----
    const canvas = scene.renderer.domElement;
    let drag: { start: THREE.Vector3; origE: number; origN: number; plane: THREE.Plane; id: number } | null = null;
    const planePoint = (ev: PointerEvent, plane: THREE.Plane): THREE.Vector3 | null => {
      const rc = new THREE.Raycaster();
      rc.setFromCamera(scene.ndcFromEvent(ev), scene.camera);
      const out = new THREE.Vector3();
      return rc.ray.intersectPlane(plane, out) ? out : null;
    };
    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0 || drag) return;
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
      drag = { start, origE: study.placement.offsetE, origN: study.placement.offsetN, plane, id: ev.pointerId };
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* 古い環境 */
      }
      canvas.style.cursor = 'move';
    };
    const onMove = (ev: PointerEvent) => {
      if (!drag) return;
      const p = currentPlaced();
      if (!p) return;
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
      if (ev) {
        try {
          canvas.releasePointerCapture(drag.id);
        } catch {
          /* 既に解放 */
        }
      }
      drag = null;
      scene.controls.enabled = true;
      canvas.style.cursor = '';
      afterTransform(true);
    };
    canvas.addEventListener('pointerdown', onDown, { capture: true });
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    cleanup.push(() => {
      canvas.removeEventListener('pointerdown', onDown, { capture: true });
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      if (drag) {
        try {
          canvas.releasePointerCapture(drag.id);
        } catch {
          /* 既に解放 */
        }
        drag = null;
      }
      scene.controls.enabled = true;
      canvas.style.cursor = '';
    });

    // ---- 位置の表示（ドラッグ中にも更新） ----
    let refreshPos: () => void = () => {};

    // ---- ステージ ----
    const renderStage = () => {
      clear(stage);
      if (study.model) {
        stage.appendChild(h('div', { class: 'stage-note' }, '建物をドラッグして敷地に合わせます　／　空いた所をドラッグ: 回転　右ドラッグ: 移動'));
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
          pl.customScale = w / raw;
          pl.unit = 'custom';
          unitSel.value = 'custom';
          customIn.value = String(r2(pl.customScale * 10000) / 10000);
          customRow.style.display = '';
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
          headingOut,
          h('p', { class: 'hint', style: 'margin:0' }, '地図の上＝真北です。図面の北矢印が磁北の場合は補正してください（関東 約+7°、札幌 約+9.5°）。「真上から見る」で航空写真に建物の形を合わせるのが確実です。'),
        ),
      );

      // ---- 位置 ----
      const posOut = h('div', { class: 'info-box' });
      const nudge = (de: number, dn: number) => {
        pl.offsetE = r2(pl.offsetE + de);
        pl.offsetN = r2(pl.offsetN + dn);
        afterTransform(false);
      };
      const nudgeRow = (label: string, de: number, dn: number) =>
        [h('span', { class: 'k' }, label), h('button', { class: 'btn sm', onclick: () => nudge(de * 0.5, dn * 0.5) }, '0.5 m'), h('button', { class: 'btn sm', onclick: () => nudge(de * 2, dn * 2) }, '2 m')];
      refreshPos = () => {
        clear(posOut);
        posOut.append(`ピンから 東へ ${signed(pl.offsetE)} m／北へ ${signed(pl.offsetN)} m`);
        const b = boundaryText(p);
        if (b) posOut.append(h('br'), b);
      };
      refreshPos();
      refreshers.push(refreshPos);
      side.appendChild(
        section(
          '位置',
          h('p', { class: 'hint', style: 'margin:0 0 6px' }, '真上から見た航空写真の上で、建物をドラッグして敷地に合わせます。細かい調整はボタンで。'),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => flyTop(scene, p) }, '真上から見る'), h('button', { class: 'btn', onclick: () => flyQuarter(scene, p) }, '斜めから見る')),
          h('div', { class: 'nudge' }, ...nudgeRow('北へ', 0, 1), ...nudgeRow('南へ', 0, -1), ...nudgeRow('東へ', 1, 0), ...nudgeRow('西へ', -1, 0)),
          h('div', { class: 'btn-row' }, h('button', {
            class: 'btn sm',
            onclick: () => {
              pl.offsetE = 0;
              pl.offsetN = 0;
              afterTransform(true);
            },
          }, 'ピンの位置に戻す')),
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
              afterRebuild();
            },
          ),
          h('p', { class: 'hint', style: 'margin:0' }, '白モデルは影の形が見やすく、お客様への説明向きです'),
        ),
      );

      // ---- 進む ----
      const confirmAndGo = () => {
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
