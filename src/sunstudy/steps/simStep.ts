/**
 * ステップ 3「日照シミュレーション」
 *  ステージ: 時刻バー（再生・日付チップ）、太陽バッジ、視点ボタン、前提チップ、出典、隣家の編集ポップアップ
 *  サイド: 建設地と建物／表示／周辺建物の修正／日当たりの解析（地面・面の日照時間マップ、測定点、日影図、季節比較の撮影、
 *          タイムラプス動画、レポート・プロジェクト保存）
 *
 * ワールド: X=東, Z=南(-Z=北), Y=上。原点 = ピン、Y=0 = ピン位置の地盤高。太陽方向は sunDirectionWorld(az, elev, 0)。時刻は JST。
 * 建物の 3D データが無くても（土地だけでも）使える。
 */
import * as THREE from 'three';
import { clear, download, field, h, modal, progressModal, section, segmented, svgToDataUrl, svgToPng, toast } from '../../app/dom';
import { formatHM, keyDates, localDate, sunDirectionWorld, sunPosition, sunriseSunset, trueSolarToLocal } from '../../sun/solar';
import type { CameraProgram } from '../../video/paths';
import { recordProgram } from '../../video/recorder';
import { facadeSunHours, groundHeatmapMesh, groundSunHoursStudy, measureMarker, measurePointHours, shadowDiagramStudy, studyDates } from '../analysis';
import { buildingCenter, buildingExtent, buildingFootprintEN, currentPlaced, ensurePlaced } from '../building';
import { groundYWorld, loadEnvironment, rebuildEnvironment, sitePolygonWorld } from '../environment';
import { makeManualNeighbor } from '../neighbors';
import { downloadProject } from '../project';
import { assumptionItems, downloadReport, fmtSigned, neighborCounts, openReport } from '../report';
import { clearGroup } from '../scene';
import type { CameraView } from '../scene';
import type { StudyStep } from '../shell';
import { emit, on, study, uid, visibleNeighbors } from '../state';
import { SunPath } from '../sunpath';
import { DEM_LABEL, horizonElevation } from '../terrain';
import { NEIGHBOR_SOURCE_LABEL, bearingName, worldToEN } from '../types';
import type { Neighbor, NeighborSource } from '../types';

// ---------------------------------------------------------------------------
// モジュールの状態（ステップを出入りしても残す）
// ---------------------------------------------------------------------------

/** 周辺環境の版。'env' などのたびに増え、mount 時に builtVersion と違えば作り直す */
let envVersion = 0;
let builtVersion = -1;
for (const ev of ['env', 'neighbors', 'site', 'placement', 'model', 'frame']) on(ev, () => envVersion++);

let raf = 0;
/** 地面の日照時間マップ・面の日照時間（overlay グループに入れたまま残す） */
let heat: THREE.Mesh | null = null;
let facade: THREE.Mesh | null = null;
let firstMount = true;
let cleanup: (() => void) | null = null;
/** 「確認済」にした隣家 */
const confirmed = new Set<string>();
/** 太陽の通り道を作ったときの条件 */
let pathKey = '';

type ViewKind = 'bird' | 'top' | 'south' | 'east' | 'west' | 'orbit' | 'wide';
type EN = { e: number; n: number };
type HorizonLike = { elevDeg: Float32Array; source: string; radiusKm: number };

const DIR8 = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
const SRC_SHORT: Record<NeighborSource, string> = { plateau: 'PLATEAU', gsi: '国土地理院', osm: 'OpenStreetMap', manual: '手入力' };
const PRESETS: [string, number][] = [
  ['平屋 4m', 4],
  ['2階 7m', 7],
  ['3階 9.5m', 9.5],
  ['4階 12.5m', 12.5],
];

// ---------------------------------------------------------------------------
// 小さな幾何・補助
// ---------------------------------------------------------------------------

/** 視点（c: 建物中心、R: 軌道半径、bh: 建物の高さ） */
function viewOf(kind: ViewKind, c: THREE.Vector3, R: number, bh: number): CameraView {
  const s = R / 22;
  const mid = c.clone().setY(c.y + Math.max(1, bh / 2));
  switch (kind) {
    case 'bird':
      return { pos: c.clone().add(new THREE.Vector3(R * 1.6, R * 1.7, R * 2.1)), target: c.clone().setY(c.y + 1), fov: 45 };
    case 'top':
      return { pos: c.clone().add(new THREE.Vector3(0.01, R * 4.2, 0.02)), target: c.clone(), fov: 40 };
    case 'south':
      return { pos: c.clone().add(new THREE.Vector3(0, R * 0.8 + bh * 0.3, R * 2.6)), target: mid, fov: 45 };
    case 'east':
      return { pos: c.clone().add(new THREE.Vector3(R * 2.6, R * 0.8 + bh * 0.3, 0)), target: mid, fov: 45 };
    case 'west':
      return { pos: c.clone().add(new THREE.Vector3(-R * 2.6, R * 0.8 + bh * 0.3, 0)), target: mid, fov: 45 };
    case 'orbit':
      return { pos: c.clone().add(new THREE.Vector3(26 * s, 30 * s, 38 * s)), target: c.clone().setY(c.y + 2), fov: 45 };
    case 'wide':
    default:
      return { pos: c.clone().add(new THREE.Vector3(R * 3.5, R * 2.2, R * 4.5)), target: c.clone(), fov: 45 };
  }
}

/** 点 (x, z) が多角形（Vector2: x→x, y→z）の内側か */
function pointInPoly(x: number, z: number, poly: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > z !== b.y > z && x < ((b.x - a.x) * (z - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segDist(p: EN, a: EN, b: EN): number {
  const dx = b.e - a.e;
  const dy = b.n - a.n;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((p.e - a.e) * dx + (p.n - a.n) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.e - (a.e + dx * t), p.n - (a.n + dy * t));
}

/** 2 つの輪郭の最短距離（辺と頂点）。片方が 1 点でもよい */
function ringDist(a: EN[], b: EN[]): number {
  let d = Infinity;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) d = Math.min(d, segDist(a[i], b[j], b[(j + 1) % b.length]), segDist(b[j], a[i], a[(i + 1) % a.length]));
  return d;
}

function ringCentroid(r: EN[]): EN {
  let e = 0;
  let n = 0;
  for (const p of r) {
    e += p.e;
    n += p.n;
  }
  const k = Math.max(1, r.length);
  return { e: e / k, n: n / k };
}

/** from → to の方位（真北から時計回り、度） */
function bearingEN(from: EN, to: EN): number {
  return ((Math.atan2(to.e - from.e, to.n - from.n) * 180) / Math.PI + 360) % 360;
}

/** 山・丘（地平線の仰角）を考慮した日の出・日の入（2 分刻みで走査） */
function horizonSunTimes(lat: number, lon: number, y: number, m: number, d: number, hz: HorizonLike): { rise: number; set: number } | null {
  let rise: number | null = null;
  let set: number | null = null;
  for (let hh = 3; hh <= 21; hh += 2 / 60) {
    const sp = sunPosition(localDate(y, m, d, hh), lat, lon);
    if (sp.elevation > horizonElevation(hz, sp.azimuth)) {
      if (rise == null) rise = hh;
      set = hh;
    }
  }
  return rise != null && set != null ? { rise, set } : null;
}

/** 建物の足跡の外周に沿って約 1m ごとに地形の高さを採り、平均する（平均地盤面。GL=0 からの m） */
function avgGroundAlongFootprint(fallback: THREE.Vector3): number {
  const fp = currentPlaced()?.footprintWorld();
  if (!fp || fp.length < 3) return groundYWorld(fallback.x, fallback.z);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < fp.length; i++) {
    const a = fp[i];
    const b = fp[(i + 1) % fp.length];
    const steps = Math.max(1, Math.ceil(a.distanceTo(b)));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      sum += groundYWorld(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      cnt++;
    }
  }
  return cnt ? sum / cnt : 0;
}

function neighborIdOf(o: THREE.Object3D | null | undefined): string | null {
  for (let p: THREE.Object3D | null = o ?? null; p; p = p.parent) {
    const id = p.userData?.neighborId;
    if (typeof id === 'string') return id;
  }
  return null;
}

function isDescendant(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === root) return true;
  return false;
}

function kindTag(kind: Neighbor['heightKind']): HTMLElement {
  const m: Record<Neighbor['heightKind'], [string, string]> = { measured: ['measured', '実測の高さ'], estimated: ['estimated', '高さは推定'], manual: ['manual', '手入力'] };
  return h('span', { class: `src-tag ${m[kind][0]}` }, m[kind][1]);
}

function sourceKind(src: NeighborSource, list: Neighbor[]): Neighbor['heightKind'] {
  if (src === 'manual') return 'manual';
  const own = list.filter((n) => n.source === src);
  if (!own.length) return src === 'plateau' ? 'measured' : 'estimated';
  return own.some((n) => n.heightKind === 'estimated') ? 'estimated' : 'measured';
}

function disposeMesh(m: THREE.Mesh) {
  m.geometry?.dispose();
  for (const mt of Array.isArray(m.material) ? m.material : [m.material]) mt?.dispose();
}

const num = (value: number, min = 0, max = 500, step = 0.5) => h('input', { type: 'number', value, min, max, step }) as HTMLInputElement;

const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError';

// ---------------------------------------------------------------------------
// ステップ
// ---------------------------------------------------------------------------

export const simStep: StudyStep = {
  id: 'sim',
  label: '日照シミュレーション',
  enabled: () => !!study.frame,
  disabledHint: '先に「場所」で建設地を指定してください',
  uses3d: true,
  unmount() {
    cancelAnimationFrame(raf);
    raf = 0;
    study.ui.playing = false;
    cleanup?.();
    cleanup = null;
  },
  async mount(ctx) {
    const { scene, stage, side, shell } = ctx;
    const f = study.frame;
    if (!f) return;
    const ui = study.ui;
    ui.playing = false;
    const canvas = scene.renderer.domElement;
    const disposers: (() => void)[] = [];
    cleanup?.();
    cleanup = () => {
      for (const d of disposers.splice(0)) {
        try {
          d();
        } catch (e) {
          console.warn(e);
        }
      }
    };

    // ---- シーンの準備 ----
    ensurePlaced(scene);
    const landOnly = !study.model;
    // 別のステップで overlay が空にされていたら、残していた参照を捨てる
    if (heat && heat.parent !== scene.groups.overlay) heat = null;
    if (facade && facade.parent !== scene.groups.overlay) facade = null;
    const existingPath = scene.userData.sunPath as SunPath | undefined;
    const sunPath: SunPath = existingPath ?? new SunPath(scene.groups.sunpath);
    scene.userData.sunPath = sunPath;
    const center = buildingCenter();
    const R = Math.max(22, buildingExtent() * 1.6);
    const bh = currentPlaced()?.dimensions().h ?? 0;

    const applyShow = () => {
      scene.groups.neighbors.visible = study.show.neighbors;
      scene.groups.site.visible = study.show.site;
      scene.groups.markers.visible = study.show.points;
      sunPath.setVisible(study.show.sunPath);
      scene.invalidate();
    };
    const rebuildEnv = () => {
      rebuildEnvironment(scene, buildingFootprintEN());
      builtVersion = envVersion;
      applyShow();
    };
    if (!scene.groups.terrain.children.length || builtVersion !== envVersion) rebuildEnv();
    else applyShow();

    const buildPath = () => {
      const key = [f.lat.toFixed(6), f.lon.toFixed(6), ui.year, center.x.toFixed(2), center.y.toFixed(2), center.z.toFixed(2), R.toFixed(2)].join('|');
      if (key === pathKey) return;
      pathKey = key;
      sunPath.build(f.lat, f.lon, ui.year, center, R);
      sunPath.setVisible(study.show.sunPath);
    };
    buildPath();
    scene.fitShadow(center, Math.max(45, buildingExtent() * 1.5));

    if (firstMount) {
      firstMount = false;
      const w = keyDates(ui.year)[0];
      ui.month = w.month;
      ui.day = w.day;
      ui.hour = 12;
      scene.applyView(viewOf('bird', center, R, bh));
    }

    // ---- 日の出・日の入のキャッシュ ----
    const rsCache = new Map<string, { sunrise: number; sunset: number; noon: number }>();
    const rsNow = () => {
      const k = `${ui.year}-${ui.month}-${ui.day}`;
      let v = rsCache.get(k);
      if (!v) {
        v = sunriseSunset(ui.year, ui.month, ui.day, f.lat, f.lon);
        rsCache.set(k, v);
      }
      return v;
    };
    const hzCache = new Map<string, { rise: number; set: number } | null>();
    const hzNow = () => {
      const hz = study.horizon;
      if (!hz) return null;
      const k = `${ui.year}-${ui.month}-${ui.day}`;
      if (!hzCache.has(k)) hzCache.set(k, horizonSunTimes(f.lat, f.lon, ui.year, ui.month, ui.day, hz));
      return hzCache.get(k) ?? null;
    };
    const dayNow = () => ({ year: ui.year, month: ui.month, day: ui.day, lat: f.lat, lon: f.lon });

    // ---- 太陽バッジと時刻の反映 ----
    const badge = h('div', { class: 'sun-badge', style: 'pointer-events:auto' });
    const timeEl = h('div', { class: 'time' });
    const subEl = h('div', { class: 'sub' });
    const slider = h('input', { type: 'range', min: 4, max: 20, step: 1 / 60, value: ui.hour }) as HTMLInputElement;
    let lastEnv = 0;
    const apply = (envNow = false) => {
      const sp = sunPosition(localDate(ui.year, ui.month, ui.day, ui.hour), f.lat, f.lon);
      const dir = sunDirectionWorld(sp.azimuth, sp.elevation, 0);
      const now = performance.now();
      const env = envNow || now - lastEnv > 400;
      if (env) lastEnv = now;
      scene.setSunDirection(dir, env);
      sunPath.updateMarker(dir, center, R);
      const rs = rsNow();
      timeEl.textContent = formatHM(ui.hour);
      subEl.textContent = `${ui.year}年${ui.month}月${ui.day}日`;
      const mins = Math.round((rs.sunset - rs.sunrise) * 60);
      clear(badge);
      badge.append(
        h('div', null, h('b', null, `${ui.month}月${ui.day}日 ${formatHM(ui.hour)}`)),
        h('div', null, sp.elevation > 0 ? `太陽高度 ${sp.elevation.toFixed(1)}°／方位 ${bearingName(sp.azimuth)}（${sp.azimuth.toFixed(0)}°）` : '日没後・日の出前'),
        h('div', { class: 'dim' }, `日の出 ${formatHM(rs.sunrise)}／南中 ${formatHM(rs.noon)}／日の入 ${formatHM(rs.sunset)}`),
        h('div', { class: 'dim' }, `昼の長さ ${Math.floor(mins / 60)}時間${mins % 60}分`),
      );
      const hz = hzNow();
      if (hz) badge.append(h('div', { class: 'dim' }, `山・丘を考慮した日の出／日の入 ${formatHM(hz.rise)}／${formatHM(hz.set)}`));
      badge.append(h('div', { class: 'dim small' }, '時刻は日本標準時（JST）'));
      if (slider.value !== String(ui.hour)) slider.value = String(ui.hour);
      emit('time');
    };

    // ---- ステージ: 時刻バー ----
    const playBtn = h('button', { class: 'play', title: '再生／一時停止' }, '▶');
    let lastT = 0;
    const tick = (t: number) => {
      if (!ui.playing) return;
      const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
      lastT = t;
      ui.hour += dt * ui.speed; // 1 秒 ≈ 1 時間 × 速さ
      const rs = rsNow();
      if (ui.hour > rs.sunset + 0.3) ui.hour = rs.sunrise - 0.3;
      apply();
      raf = requestAnimationFrame(tick);
    };
    const setPlaying = (p: boolean) => {
      ui.playing = p;
      playBtn.textContent = p ? '❚❚' : '▶';
      lastT = 0;
      cancelAnimationFrame(raf);
      if (p) raf = requestAnimationFrame(tick);
      else apply(true);
    };
    playBtn.addEventListener('click', () => setPlaying(!ui.playing));

    const dateChips = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center' });
    const renderDateChips = () => {
      clear(dateChips);
      const today = new Date();
      const opts = [...keyDates(ui.year).map((k) => ({ label: k.label, m: k.month, d: k.day })), { label: '今日', m: today.getMonth() + 1, d: today.getDate() }];
      for (const o of opts)
        dateChips.appendChild(
          h(
            'button',
            {
              class: `chip ${ui.month === o.m && ui.day === o.d ? 'on' : ''}`,
              onclick: () => {
                ui.month = o.m;
                ui.day = o.d;
                renderDateChips();
                apply(true);
              },
            },
            o.label,
          ),
        );
      dateChips.appendChild(
        h('input', {
          type: 'date',
          value: `${ui.year}-${String(ui.month).padStart(2, '0')}-${String(ui.day).padStart(2, '0')}`,
          style: 'background:transparent;color:#fff;border:1px solid #50555d;border-radius:999px;padding:3px 10px',
          onchange: (e: Event) => {
            const [y, m, d] = (e.target as HTMLInputElement).value.split('-').map(Number);
            if (!y || !m || !d) return;
            ui.year = y;
            ui.month = m;
            ui.day = d;
            buildPath();
            renderDateChips();
            renderPoints();
            apply(true);
          },
        }),
      );
    };
    slider.addEventListener('input', () => {
      ui.hour = +slider.value;
      apply();
    });
    slider.addEventListener('change', () => apply(true));
    const speedText = (s: number) => (s < 1 ? `1秒 ≈ ${Math.round(s * 60)}分` : `1秒 ≈ ${s}時間`);
    const speedLabel = h('div', { class: 'sub' }, speedText(ui.speed));
    const speedSel = h(
      'select',
      { title: '再生の速さ' },
      [0.5, 1, 2, 4].map((v) => h('option', { value: v, selected: v === ui.speed }, `${v}倍`)),
    ) as HTMLSelectElement;
    if (![0.5, 1, 2, 4].includes(ui.speed)) {
      ui.speed = 1;
      speedSel.value = '1';
    }
    speedSel.addEventListener('change', () => {
      ui.speed = +speedSel.value;
      speedLabel.textContent = speedText(ui.speed);
    });
    const bar = h(
      'div',
      { class: 'overlay-bar', style: 'pointer-events:auto' },
      playBtn,
      h('div', null, timeEl, subEl),
      slider,
      h('div', { class: 'speed' }, speedSel, speedLabel),
      h('div', { style: 'flex-basis:100%;height:0' }),
      dateChips,
    );

    // ---- ステージ: 視点・お客様モード ----
    const fly = (k: ViewKind) => scene.flyTo(viewOf(k, center, R, bh));
    const presentBtn = h('button', { class: 'btn', title: 'サイドパネルを隠して 3D を大きく表示します（F キーで切替、Esc で終了）' }, 'お客様モード');
    const isPresenting = () => document.body.classList.contains('presenting');
    const setPresenting = (onOff: boolean) => {
      document.body.classList.toggle('presenting', onOff);
      presentBtn.classList.toggle('on', onOff);
      presentBtn.textContent = onOff ? 'お客様モードを終了（Esc）' : 'お客様モード';
      requestAnimationFrame(() => scene.resize());
    };
    presentBtn.addEventListener('click', () => setPresenting(!isPresenting()));
    const viewDefs: [ViewKind, string][] = [
      ['bird', '鳥瞰'],
      ['top', '真上から'],
      ['south', '南から'],
      ['east', '東から'],
      ['west', '西から'],
      ['orbit', '太陽軌道'],
      ['wide', '広域'],
    ];
    const views = h('div', { class: 'view-tools' }, ...viewDefs.map(([k, l]) => h('button', { class: 'btn', onclick: () => fly(k) }, l)), presentBtn);

    // ---- ステージ: 前提チップ・出典・案内 ----
    const chipsLine = h('div', { class: 'chips' });
    let neighborSection: HTMLElement | null = null;
    const renderChipsLine = () => {
      clear(chipsLine);
      for (const it of assumptionItems()) {
        const toModel = it.key === 'unit' || it.key === 'dims' || it.key === 'heading' || it.key === 'gl';
        const act = toModel && study.model ? () => void shell.go('model') : it.key === 'neighbors' ? () => neighborSection?.scrollIntoView({ behavior: 'smooth', block: 'start' }) : null;
        const cls = `chip light ${it.warn ? 'caution' : ''}`;
        chipsLine.appendChild(
          act ? h('button', { class: cls, title: it.key === 'neighbors' ? '周辺建物の修正へ' : '「建物」のステップで調整します', onclick: act }, it.text) : h('span', { class: cls }, it.text),
        );
      }
    };
    const attribution = h('div', { class: 'attribution' });
    const renderAttribution = () => {
      const parts: string[] = [];
      if (study.env.attribution) parts.push(study.env.attribution);
      parts.push(`地形: ${DEM_LABEL[study.grid?.source ?? 'flat'] ?? study.grid?.source ?? ''}`);
      if (study.neighborSources.includes('plateau')) parts.push('周辺建物: PLATEAU（国土交通省）');
      attribution.textContent = parts.join(' ／ ');
    };
    const note = h('div', { class: 'stage-note', style: 'display:none' });
    const setNote = (t: string | null) => {
      const txt = t ?? (landOnly ? '建物なしで土地の日当たりを見ています' : null);
      note.style.display = txt ? '' : 'none';
      note.textContent = txt ?? '';
    };
    const envWarnStage = h('div');
    const renderEnvWarn = () => {
      clear(envWarnStage);
      clear(envWarnSide);
      if (study.env.loaded) return;
      const make = () =>
        h(
          'div',
          { class: 'warn float' },
          '周辺環境（地形・航空写真・周辺建物）がまだ読み込まれていません。平らな地面で表示しています。',
          h('div', { class: 'btn-row', style: 'margin:6px 0 0' }, h('button', { class: 'btn sm dark', onclick: () => void loadEnv() }, '周辺環境を読み込む')),
        );
      envWarnStage.appendChild(make());
      envWarnSide.appendChild(make());
    };
    const stageLeft = h('div', { class: 'stage-left' }, views, chipsLine, envWarnStage);
    stage.append(stageLeft, badge, bar, note, attribution);

    // ---- 周辺環境の読み込み ----
    const loadEnv = async () => {
      if (study.env.loading) return;
      const pm = progressModal('周辺環境を取得しています（地形・航空写真・周辺建物）');
      try {
        const rep = await loadEnvironment({ signal: pm.signal, onProgress: (m, r) => pm.set(r, m) });
        if (rep.errors.length) toast(rep.errors.join('\n'), 'error', 8000);
        else toast('周辺環境を読み込みました', 'ok');
      } catch (e) {
        if (!isAbort(e)) toast(`周辺環境を取得できませんでした: ${(e as Error).message}`, 'error', 6000);
      } finally {
        pm.close();
      }
    };

    // ---- サイド: 見出し ----
    side.append(
      h('h2', null, '日照シミュレーション'),
      h('p', { class: 'lead' }, '実在の場所に置いた建物で、季節・時刻ごとの太陽の動きと影を確認できます。地面や建物の面の日照時間、測定点の季節別の日照時間、日影図、季節比較の撮影、タイムラプス動画、印刷用レポートが作れます。'),
    );
    const envWarnSide = h('div');
    side.appendChild(envWarnSide);

    // ---- サイド 1: 建設地と建物 ----
    const siteBox = h('div');
    const renderSite = () => {
      clear(siteBox);
      const placed = currentPlaced();
      const p = study.placement;
      const rows: [string, string][] = [
        ['住所', f.address],
        ['緯度・経度', `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`],
        ['地盤高', f.groundElev != null ? `T.P. ${f.groundElev.toFixed(1)} m（${DEM_LABEL[study.grid?.source ?? 'flat'] ?? ''}）` : '未取得（平地として表示）'],
      ];
      if (placed) {
        const d = placed.dimensions();
        rows.push(['建物', `${d.w.toFixed(1)}×${d.d.toFixed(1)}×${d.h.toFixed(1)} m／方位 北から${(((p.headingDeg % 360) + 360) % 360).toFixed(0)}°／GL ${fmtSigned(p.baseY)} m`]);
      } else rows.push(['建物', '建物なし（土地だけの日当たりを見ています）']);
      siteBox.appendChild(h('div', { class: 'env-status' }, ...rows.flatMap(([k, v]) => [h('span', { class: 'k' }, k), h('span', null, v)])));
      const list = visibleNeighbors();
      const srcs: NeighborSource[] = [...study.neighborSources];
      if (list.some((n) => n.source === 'manual') && !srcs.includes('manual')) srcs.push('manual');
      if (srcs.length) {
        siteBox.appendChild(h('div', { class: 'field-label' }, '周辺建物の出典'));
        for (const s of srcs) siteBox.appendChild(h('div', { style: 'font-size:12.5px;margin:2px 0' }, NEIGHBOR_SOURCE_LABEL[s], kindTag(sourceKind(s, list))));
      }
      for (const n of study.neighborNotes) siteBox.appendChild(h('div', { class: 'info-box' }, n));
      if (study.horizon) siteBox.appendChild(h('div', { class: 'info-box' }, `周囲の山・丘による日照の遮りを考慮しています（半径約 ${study.horizon.radiusKm} km の地形）。`));
      siteBox.appendChild(
        h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => void shell.go('place') }, '場所を変える'), h('button', { class: 'btn sm', onclick: () => void shell.go('model') }, '建物を調整する')),
      );
    };
    side.appendChild(section('建設地と建物', siteBox));

    // ---- サイド 2: 表示 ----
    type ShowKey = keyof typeof study.show;
    const showCheck = (key: ShowKey, label: string, extra?: () => void) =>
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: study.show[key],
          onchange: (e: Event) => {
            study.show[key] = (e.target as HTMLInputElement).checked;
            extra?.();
            applyShow();
          },
        }),
        label,
      );
    side.appendChild(
      section(
        '表示',
        showCheck('aerial', '航空写真（地面に貼る）', () => rebuildEnv()),
        showCheck('neighbors', '周辺建物'),
        showCheck('sunPath', '太陽の通り道と方位リング'),
        showCheck('site', '敷地の輪郭'),
        showCheck('points', '測定点'),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => void loadEnv() }, '🔄 周辺建物を取り直す')),
        h('p', { class: 'hint' }, '地形・航空写真・周辺建物を国土地理院・PLATEAU から再取得します。手動で追加した隣家と高さの修正は残ります。'),
      ),
    );

    // ---- サイド 3: 周辺建物の修正 ----
    const setOverride = (id: string, o: { height?: number; hidden?: boolean }) => {
      const n = study.neighbors.find((x) => x.id === id);
      if (!n) return;
      if (n.source === 'manual') {
        if (o.height != null && o.height > 0) {
          n.height = o.height;
          n.heightKind = 'manual';
        }
        if (o.hidden) study.neighbors = study.neighbors.filter((x) => x.id !== id);
      } else {
        const cur = study.neighborOverrides[id] ?? {};
        study.neighborOverrides[id] = { ...cur, ...(o.height != null && o.height > 0 ? { height: Math.round(o.height * 10) / 10 } : {}), ...(o.hidden != null ? { hidden: o.hidden } : {}) };
      }
      emit('neighbors');
    };

    let pop: HTMLElement | null = null;
    const closePop = () => {
      pop?.remove();
      pop = null;
    };
    const openPop = (n: Neighbor, e: PointerEvent) => {
      closePop();
      const eff = visibleNeighbors().find((x) => x.id === n.id) ?? n;
      const hIn = num(eff.height, 1, 300, 0.1);
      const r = stage.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.width - 260, e.clientX - r.left + 10));
      const top = Math.max(8, Math.min(r.height - 190, e.clientY - r.top + 10));
      pop = h(
        'div',
        { class: 'pop', style: `left:${left}px;top:${top}px` },
        h('h5', null, eff.label ?? '周辺建物', kindTag(eff.heightKind)),
        h('div', { class: 'hint' }, `出典: ${SRC_SHORT[eff.source]}${eff.heightKind === 'estimated' ? '（高さは建物の種類からの推定です）' : ''}`),
        h('div', { class: 'row' }, '高さ', hIn, 'm'),
        h('div', { class: 'row', style: 'flex-wrap:wrap' }, ...PRESETS.map(([l, v]) => h('button', { class: 'btn sm', onclick: () => (hIn.value = String(v)) }, l))),
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn sm dark',
              onclick: () => {
                setOverride(n.id, { height: +hIn.value });
                closePop();
              },
            },
            '適用',
          ),
          h(
            'button',
            {
              class: 'btn sm',
              onclick: () => {
                setOverride(n.id, { hidden: true });
                closePop();
              },
            },
            n.source === 'manual' ? '削除' : '非表示にする',
          ),
          h('button', { class: 'btn sm ghost', onclick: closePop }, '閉じる'),
        ),
      );
      stage.appendChild(pop);
    };
    disposers.push(closePop);

    const nbSummary = h('div', { class: 'info-box' });
    const nbList = h('div');
    const neighborRow = (n: Neighbor, dist: number, br: number) => {
      const done = confirmed.has(n.id);
      const hIn = num(n.height, 1, 300, 0.1);
      const applyH = (v: number) => {
        if (!(v > 0)) return;
        setOverride(n.id, { height: v });
      };
      return h(
        'div',
        { class: `nb-row ${done ? 'done' : ''}` },
        h('div', null, h('b', null, n.label ?? `${SRC_SHORT[n.source]}の建物`), kindTag(n.heightKind), h('span', { class: 'meta' }, `約 ${Math.round(dist)} m・${bearingName(br)}側・高さ 約 ${n.height.toFixed(1)} m`)),
        h('div', { class: 'btn-row', style: 'margin:4px 0' }, ...PRESETS.map(([l, v]) => h('button', { class: 'btn sm', onclick: () => applyH(v) }, l))),
        h(
          'div',
          { class: 'btn-row', style: 'margin:4px 0;align-items:center' },
          hIn,
          h('span', { class: 'meta' }, 'm'),
          h('button', { class: 'btn sm', onclick: () => applyH(+hIn.value) }, '適用'),
          h('button', { class: 'btn sm ghost', onclick: () => setOverride(n.id, { hidden: true }) }, '非表示'),
          h(
            'label',
            { class: 'check', style: 'margin:0 0 0 auto' },
            h('input', {
              type: 'checkbox',
              checked: done,
              onchange: (e: Event) => {
                if ((e.target as HTMLInputElement).checked) confirmed.add(n.id);
                else confirmed.delete(n.id);
                renderNeighborList();
              },
            }),
            '確認済',
          ),
        ),
      );
    };
    const renderNeighborList = () => {
      const list = visibleNeighbors();
      const c = neighborCounts(list);
      nbSummary.textContent = `周辺建物 ${c.total}棟（実測の高さ ${c.measured}・推定 ${c.estimated}・手入力 ${c.manual}）`;
      clear(nbList);
      const fp = buildingFootprintEN();
      const ref: EN[] = fp && fp.length >= 3 ? fp : [{ e: 0, n: 0 }];
      const cEN = worldToEN(center);
      const cands = list
        .filter((n) => n.source !== 'manual' && n.heightKind === 'estimated')
        .map((n) => ({ n, dist: ringDist(n.ring, ref), br: bearingEN(cEN, ringCentroid(n.ring)) }))
        .filter((x) => x.dist <= 25 && x.br >= 60 && x.br <= 300)
        .sort((a, b) => (confirmed.has(a.n.id) ? 1 : 0) - (confirmed.has(b.n.id) ? 1 : 0) || a.dist - b.dist);
      nbList.appendChild(h('div', { class: 'field-label', style: 'margin-top:8px' }, `要確認の隣家（高さが推定で、建物から 25 m 以内の東〜南〜西側）: ${cands.length}棟`));
      if (!cands.length) nbList.appendChild(h('p', { class: 'hint' }, '該当なし'));
      for (const x of cands) nbList.appendChild(neighborRow(x.n, x.dist, x.br));
    };

    const dirSel = h('select', null, DIR8.map((d, i) => h('option', { value: i * 45, selected: d === '南' }, d))) as HTMLSelectElement;
    const distIn = num(10, 1, 300, 0.5);
    const widIn = num(8, 1, 200, 0.5);
    const depIn = num(8, 1, 200, 0.5);
    const hgtIn = num(7, 1, 300, 0.1);
    const addManual = () => {
      const dirDeg = +dirSel.value;
      const n = makeManualNeighbor(dirDeg, +distIn.value, +widIn.value, +depIn.value, +hgtIn.value);
      // 建物の中心からの方向・距離にする（ピンと建物がずれていても分かりやすい）
      const c = worldToEN(center);
      n.ring = n.ring.map((p) => ({ e: p.e + c.e, n: p.n + c.n }));
      if (!n.label) n.label = `隣家（${DIR8[Math.round(dirDeg / 45) % 8]}・約${Math.round(+distIn.value)}m）`;
      study.neighbors.push(n);
      emit('neighbors');
      toast('隣家を追加しました（クリックすると高さを直せます）', 'ok');
    };
    const clearManual = () => {
      const k = study.neighbors.filter((n) => n.source === 'manual').length;
      if (!k) {
        toast('手動で追加した隣家はありません');
        return;
      }
      study.neighbors = study.neighbors.filter((n) => n.source !== 'manual');
      emit('neighbors');
      toast(`手動で追加した隣家 ${k} 棟を消しました`, 'ok');
    };
    neighborSection = section(
      '周辺建物の修正',
      h('p', { class: 'hint' }, '建物をクリックすると高さを直せます（推定値の建物は薄い茶色）。'),
      nbSummary,
      nbList,
      h('div', { class: 'field-label', style: 'margin-top:12px' }, '隣家を手動で追加（建物の中心からの方向・距離）'),
      h('div', { class: 'manual-grid' }, field('方向', dirSel), field('距離 m', distIn), field('幅 m', widIn), field('奥行 m', depIn), field('高さ m', hgtIn)),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: addManual }, '＋ 隣家を追加'), h('button', { class: 'btn sm ghost', onclick: clearManual }, '手動で追加した隣家をすべて消す')),
    );
    side.appendChild(neighborSection);

    // ---- 3D のクリック（隣家の選択・測定点の配置）。ドラッグ（回転・移動）と区別する ----
    let placing = false;
    let down: { x: number; y: number; t: number } | null = null;
    const pickNeighbor = (e: PointerEvent) => {
      closePop();
      const hit = scene.pick(scene.ndcFromEvent(e), [scene.groups.neighbors]);
      const id = neighborIdOf(hit?.object);
      if (!id) return;
      const n = study.neighbors.find((x) => x.id === id);
      if (!n) return;
      openPop(n, e);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const dt = performance.now() - down.t;
      down = null;
      if (moved > 6 || dt > 700) return;
      if (placing) placePoint(e);
      else pickNeighbor(e);
    };
    canvas.addEventListener('pointerdown', onDown, true);
    canvas.addEventListener('pointerup', onUp, true);
    disposers.push(() => {
      canvas.removeEventListener('pointerdown', onDown, true);
      canvas.removeEventListener('pointerup', onUp, true);
    });

    // ---- サイド 4: 日当たりの解析 ----
    // 地面の日照時間マップ
    const heatBtn = h('button', { class: 'btn sm' }) as HTMLButtonElement;
    const heatMax = h('span');
    const heatLegend = h('div', { class: 'legend', style: 'display:none;margin:6px 0' }, h('span', null, '0時間'), h('div', { class: 'grad' }), heatMax);
    const syncHeatUI = () => {
      heatBtn.textContent = heat ? '🌡 地面の日照時間マップを消す' : '🌡 地面の日照時間マップ（表示中の日付）';
      heatBtn.classList.toggle('dark', !!heat);
      heatLegend.style.display = heat ? 'flex' : 'none';
      if (heat) heatMax.textContent = `${Number(heat.userData.maxHours ?? 0).toFixed(1)}時間`;
    };
    const removeHeat = () => {
      if (!heat) return;
      scene.groups.overlay.remove(heat);
      disposeMesh(heat);
      heat = null;
      scene.invalidate();
    };
    const runHeat = async () => {
      if (heat) {
        removeHeat();
        syncHeatUI();
        return;
      }
      const pm = progressModal(`${ui.month}月${ui.day}日の地面の日照時間マップを計算しています`);
      try {
        const half = Math.max(22, buildingExtent() * 1.2 + 8);
        const g = await groundSunHoursStudy(scene, dayNow(), {
          center: center.clone(),
          half,
          groundY: groundYWorld,
          onProgress: (r) => pm.set(r),
          signal: pm.signal,
          ...({ horizon: study.horizon ?? undefined } as object),
        });
        if (pm.signal.aborted) return;
        const rs = rsNow();
        const max = Math.max(1, rs.sunset - rs.sunrise);
        const fp = currentPlaced()?.footprintWorld() ?? null;
        const mesh = groundHeatmapMesh(g, max, groundYWorld, fp && fp.length >= 3 ? (x, z) => !pointInPoly(x, z, fp) : undefined);
        mesh.userData.maxHours = max;
        mesh.userData.heatmap = true;
        heat = mesh;
        scene.groups.overlay.add(mesh);
        scene.invalidate();
        syncHeatUI();
        // レポート用に真上から撮影して、視点は戻す
        const prev = scene.currentView();
        scene.applyView(viewOf('top', center, R, bh));
        study.results.heatmapUrl = await scene.capture(1600, 900);
        scene.applyView(prev);
        study.results.heatmapLabel = `${ui.month}月${ui.day}日（この日の昼の長さ ${max.toFixed(1)}時間）`;
        toast('日照時間マップを作成しました', 'ok');
      } catch (e) {
        if (!isAbort(e)) {
          console.error(e);
          toast(`日照時間マップの作成に失敗しました: ${(e as Error).message}`, 'error');
        }
      } finally {
        pm.close();
      }
    };
    heatBtn.addEventListener('click', () => void runHeat());

    // 建物の面の日照時間
    const facadeBtn = h('button', { class: 'btn sm', disabled: landOnly, title: landOnly ? '建物の 3D データを読み込むと使えます' : '' }) as HTMLButtonElement;
    const facadeMax = h('span');
    const facadeLegend = h('div', { class: 'legend facade', style: 'display:none;margin:6px 0' }, h('span', null, '0時間'), h('div', { class: 'grad' }), facadeMax);
    const syncFacadeUI = () => {
      facadeBtn.textContent = facade ? '🏠 建物の面の日照時間を消す' : '🏠 建物の面の日照時間（表示中の日付）';
      facadeBtn.classList.toggle('dark', !!facade);
      facadeLegend.style.display = facade ? 'flex' : 'none';
      if (facade) facadeMax.textContent = `${Number(facade.userData.maxHours ?? 0).toFixed(1)}時間`;
    };
    const removeFacade = () => {
      if (!facade) return;
      scene.groups.overlay.remove(facade);
      disposeMesh(facade);
      facade = null;
      scene.invalidate();
    };
    const runFacade = async () => {
      if (facade) {
        removeFacade();
        syncFacadeUI();
        return;
      }
      if (!study.model) {
        toast('建物の 3D データを読み込むと使えます');
        return;
      }
      const pm = progressModal(`${ui.month}月${ui.day}日の建物の面の日照時間を計算しています`);
      try {
        const mesh = await facadeSunHours(scene, dayNow(), { onProgress: (r) => pm.set(r), signal: pm.signal, ...({ horizon: study.horizon ?? undefined } as object) });
        if (pm.signal.aborted) return;
        if (mesh.userData.maxHours == null) {
          const rs = rsNow();
          mesh.userData.maxHours = Math.max(1, rs.sunset - rs.sunrise);
        }
        facade = mesh;
        scene.groups.overlay.add(mesh);
        scene.invalidate();
        syncFacadeUI();
        study.results.facadeUrl = await scene.capture(1600, 900);
        toast('建物の面の日照時間を表示しました', 'ok');
      } catch (e) {
        if (!isAbort(e)) {
          console.error(e);
          toast(`面の日照時間の計算に失敗しました: ${(e as Error).message}`, 'error');
        }
      } finally {
        pm.close();
      }
    };
    facadeBtn.addEventListener('click', () => void runFacade());

    // 測定点
    const rebuildMarkers = () => {
      clearGroup(scene.groups.markers);
      try {
        study.points.forEach((p, i) => scene.groups.markers.add(measureMarker(p, i)));
      } catch (e) {
        console.warn('測定点のマーカーを作れませんでした', e);
      }
      scene.groups.markers.visible = study.show.points;
      scene.invalidate();
    };
    const placeBtn = h('button', { class: 'btn sm' }, '＋ クリックで測定点を置く') as HTMLButtonElement;
    const setPlacing = (p: boolean) => {
      placing = p;
      placeBtn.classList.toggle('dark', p);
      placeBtn.textContent = p ? '測定点を置くのをやめる（Esc）' : '＋ クリックで測定点を置く';
      canvas.style.cursor = p ? 'crosshair' : scene.navMode === 'pan' ? 'grab' : '';
      setNote(p ? '建物の面や地面をクリックすると測定点を置きます（Esc で終了）' : null);
    };
    placeBtn.addEventListener('click', () => setPlacing(!placing));
    disposers.push(() => {
      if (placing) setPlacing(false);
    });
    const placePoint = (e: PointerEvent) => {
      const hit = scene.pick(scene.ndcFromEvent(e), [scene.groups.building, scene.groups.terrain]);
      if (!hit) {
        toast('建物の面か地面をクリックしてください');
        return;
      }
      const onTerrain = isDescendant(hit.object, scene.groups.terrain);
      let normal = new THREE.Vector3(0, 1, 0);
      if (!onTerrain && hit.face) normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
      // 外向き（カメラ側）に揃える
      const toCam = scene.camera.position.clone().sub(hit.point);
      if (normal.dot(toCam) < 0) normal.negate();
      const n = study.points.length + 1;
      study.points.push({ id: uid('pt'), label: `測定点${n}`, pos: [hit.point.x, hit.point.y, hit.point.z], normal: [normal.x, normal.y, normal.z] });
      emit('points');
      toast(`測定点${n} を置きました（${onTerrain ? '地面' : '建物の面'}）`, 'ok');
    };
    const ptBox = h('div');
    const renderPoints = () => {
      clear(ptBox);
      if (!study.points.length) {
        ptBox.appendChild(h('p', { class: 'hint' }, 'まだ測定点がありません。窓の中心などに置くと、季節ごとに日が当たる時間と時間帯が分かります。'));
        return;
      }
      const dates = keyDates(ui.year);
      const cell = (p: (typeof study.points)[number], d: (typeof dates)[number]) => {
        const r = p.results?.find((x) => x.dateId === d.id) ?? p.results?.find((x) => x.month === d.month && x.day === d.day);
        if (!r) return h('td', { style: 'color:var(--ink3)' }, '—');
        return h(
          'td',
          null,
          h('div', null, h('b', null, `${r.hours.toFixed(1)}時間`)),
          h('div', { class: 'spans' }, r.spans.length ? r.spans.map(([a, b]) => `${formatHM(a)}〜${formatHM(b)}`).join('、') : '日は当たりません'),
        );
      };
      ptBox.appendChild(
        h(
          'table',
          { class: 'pt-table' },
          h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, '名前'), ...dates.map((d) => h('th', null, d.label)), h('th', null, ''))),
          h(
            'tbody',
            null,
            ...study.points.map((p, i) =>
              h(
                'tr',
                null,
                h('td', null, String(i + 1)),
                h(
                  'td',
                  null,
                  h('input', {
                    type: 'text',
                    value: p.label,
                    title: '名前を変える',
                    onchange: (e: Event) => {
                      p.label = (e.target as HTMLInputElement).value.trim() || `測定点${i + 1}`;
                      emit('points');
                    },
                  }),
                ),
                ...dates.map((d) => cell(p, d)),
                h(
                  'td',
                  null,
                  h(
                    'button',
                    {
                      class: 'del',
                      title: '削除',
                      onclick: () => {
                        study.points.splice(i, 1);
                        emit('points');
                      },
                    },
                    '×',
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    };
    const runPoints = async () => {
      if (!study.points.length) {
        toast('先に測定点を置いてください');
        return;
      }
      const pm = progressModal('測定点の日照時間を解析しています（冬至・春分・夏至・秋分）');
      try {
        const dates = studyDates(ui.year);
        const pts = [...study.points];
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          pm.set(i / pts.length, `${p.label} を解析中…`);
          const res = await measurePointHours(scene, p, dates, { lat: f.lat, lon: f.lon }, { signal: pm.signal, ...({ horizon: study.horizon ?? undefined } as object) });
          if (pm.signal.aborted) break;
          p.results = res;
        }
        emit('points');
        if (!pm.signal.aborted) toast('測定点の解析が完了しました', 'ok');
      } catch (e) {
        if (!isAbort(e)) {
          console.error(e);
          toast(`測定点の解析に失敗しました: ${(e as Error).message}`, 'error');
        }
      } finally {
        pm.close();
      }
    };

    // 日影図
    let includeNb = false;
    let hokkaido = false;
    const glInfo = h('div', { class: 'hint' });
    const solarEl = h('div', { class: 'hint' });
    const solarNote = () => {
      const [a, b] = hokkaido ? [9, 15] : [8, 16];
      const w = keyDates(ui.year)[0];
      const la = trueSolarToLocal(ui.year, w.month, w.day, a, f.lon);
      const lb = trueSolarToLocal(ui.year, w.month, w.day, b, f.lon);
      return `冬至日 真太陽時 ${a}:00〜${b}:00（この場所では JST ${formatHM(la)}〜${formatHM(lb)}）`;
    };
    const renderDiagramInfo = () => {
      const avg = avgGroundAlongFootprint(center);
      glInfo.textContent = `平均地盤面 GL${fmtSigned(avg)} m（測定面 = 平均地盤面 + 1.5／4／6.5 m）`;
      solarEl.textContent = solarNote();
    };
    const runDiagram = async (height: number, label: string) => {
      if (!study.model) {
        toast('日影図には建物の 3D データが必要です');
        return;
      }
      const pm = progressModal(`日影図（測定面 平均地盤面+${height}m）を作成しています`);
      let res: Awaited<ReturnType<typeof shadowDiagramStudy>> | null = null;
      const plane = Math.round((avgGroundAlongFootprint(center) + height) * 100) / 100;
      try {
        res = await shadowDiagramStudy(scene, {
          lat: f.lat,
          lon: f.lon,
          year: ui.year,
          planeHeight: plane,
          includeNeighbors: includeNb,
          includeTerrain: true,
          center: center.clone(),
          sitePolygon: sitePolygonWorld(),
          onProgress: (r) => pm.set(r),
          signal: pm.signal,
          ...({ hours: hokkaido ? [9, 15] : [8, 16] } as object),
        });
        if (pm.signal.aborted) res = null;
      } catch (e) {
        if (!isAbort(e)) {
          console.error(e);
          toast(`日影図の作成に失敗しました: ${(e as Error).message}`, 'error');
        }
      } finally {
        pm.close();
      }
      if (!res) return;
      const out = res;
      study.results.diagramSvg = out.svg;
      study.results.diagramSummary = out.summary;
      const body = h(
        'div',
        null,
        h('div', { html: out.svg }),
        h('p', { class: 'hint' }, `${label}／測定面 平均地盤面+${height} m（GL${fmtSigned(plane)} m）／${solarNote()}／${includeNb ? '周辺建物を含む' : '自建物のみ'}`),
        h('p', { class: 'hint' }, out.summary.length ? out.summary.map((s) => `${s.hour}時間日影: 敷地境界から最大 約${s.maxDist.toFixed(1)} m`).join('／') : ''),
        h('div', { class: 'warn' }, '検討用であり申請図ではありません。'),
      );
      modal(
        '日影図',
        body,
        [
          { label: 'SVG で保存', onClick: () => download(svgToDataUrl(out.svg), `${study.name}_日影図_GL+${height}m.svg`) },
          { label: 'PNG で保存', onClick: () => void svgToPng(out.svg, 2400).then((u) => download(u, `${study.name}_日影図_GL+${height}m.png`)) },
          { label: '閉じる', primary: true },
        ],
        true,
      );
    };
    const siteHint = sitePolygonWorld() ? null : h('p', { class: 'hint' }, '敷地の輪郭が未指定のため、5m/10m ラインは表示されません（建設地のステップで描けます）。');

    // 季節の比較を撮影
    const imgBox = h('div');
    const renderImages = () => {
      clear(imgBox);
      const imgs = study.results.images;
      if (!imgs.length) return;
      imgBox.append(
        h(
          'div',
          { class: 'img-grid' },
          ...imgs.map((im) =>
            h(
              'figure',
              null,
              h('img', { src: im.url, alt: im.label }),
              h('figcaption', { style: 'display:flex;justify-content:space-between;align-items:center;gap:4px' }, h('span', null, im.label), h('button', { class: 'btn sm', onclick: () => download(im.url, `${study.name}_${im.label.replace(/[:\s]/g, '')}.jpg`) }, '保存')),
            ),
          ),
        ),
        h(
          'button',
          {
            class: 'btn sm block',
            onclick: () => {
              imgs.forEach((im, i) => setTimeout(() => download(im.url, `${study.name}_${String(i + 1).padStart(2, '0')}_${im.label.replace(/[:\s]/g, '')}.jpg`), i * 250));
            },
          },
          'すべて保存',
        ),
      );
    };
    const captureSeasons = async () => {
      const pm = progressModal('季節ごとの日当たりを撮影しています', false);
      const prev = { month: ui.month, day: ui.day, hour: ui.hour };
      if (ui.playing) setPlaying(false);
      try {
        const kd = keyDates(ui.year);
        const w = kd.find((k) => k.id === 'winter') ?? kd[0];
        const s = kd.find((k) => k.id === 'spring') ?? kd[1];
        const u = kd.find((k) => k.id === 'summer') ?? kd[2];
        const shots = [
          { label: `${w.label} 9:00`, m: w.month, d: w.day, hour: 9 },
          { label: `${w.label} 12:00`, m: w.month, d: w.day, hour: 12 },
          { label: `${w.label} 15:00`, m: w.month, d: w.day, hour: 15 },
          { label: `${s.label} 12:00`, m: s.month, d: s.day, hour: 12 },
          { label: `${u.label} 9:00`, m: u.month, d: u.day, hour: 9 },
          { label: `${u.label} 12:00`, m: u.month, d: u.day, hour: 12 },
          { label: `${u.label} 15:00`, m: u.month, d: u.day, hour: 15 },
        ];
        const out: { label: string; url: string }[] = [];
        for (let i = 0; i < shots.length; i++) {
          const sh = shots[i];
          ui.month = sh.m;
          ui.day = sh.d;
          ui.hour = sh.hour;
          apply(true);
          pm.set(i / shots.length, sh.label);
          out.push({ label: sh.label, url: await scene.capture(1600, 900) });
        }
        study.results.images = out;
        renderImages();
        toast('季節の比較画像を撮影しました（レポートに入ります）', 'ok');
      } catch (e) {
        console.error(e);
        toast(`撮影に失敗しました: ${(e as Error).message}`, 'error');
      } finally {
        Object.assign(ui, prev);
        renderDateChips();
        apply(true);
        pm.close();
      }
    };

    // タイムラプス動画
    let tlSeason: 'winter' | 'summer' = 'winter';
    let tlRes: '1080' | '720' = '1080';
    const recordTimelapse = async () => {
      const kd = keyDates(ui.year);
      const d = kd.find((k) => k.id === tlSeason) ?? kd[0];
      const rs = sunriseSunset(ui.year, d.month, d.day, f.lat, f.lon);
      const from = rs.sunrise + 0.2;
      const to = rs.sunset - 0.2;
      const dur = 12;
      const view = scene.currentView();
      const program: CameraProgram = {
        duration: dur,
        captions: [],
        sample: (t) => {
          const k = Math.max(0, Math.min(1, t / dur));
          const hour = from + (to - from) * k;
          return { pos: view.pos, target: view.target, fov: view.fov, fade: 0, hour, caption: `${d.label} ${formatHM(hour)}（JST）` };
        },
      };
      const label = `日照タイムラプス（${d.label}）`;
      const [w, hh] = tlRes === '1080' ? [1920, 1080] : [1280, 720];
      if (ui.playing) setPlaying(false);
      const pm = progressModal(`${label}を書き出しています（約${dur}秒の動画）`);
      let lastSlot = -1;
      let result: Awaited<ReturnType<typeof recordProgram>> | null = null;
      try {
        result = await recordProgram(scene, program, {
          width: w,
          height: hh,
          fps: 30,
          signal: pm.signal,
          title: `${study.name}　${label}`,
          onProgress: (r, p) => pm.set(r, `${Math.round(r * 100)}%`, p),
          beforeFrame: (_t, s) => {
            if (s.hour == null) return;
            const sp = sunPosition(localDate(ui.year, d.month, d.day, s.hour), f.lat, f.lon);
            const dir = sunDirectionWorld(sp.azimuth, sp.elevation, 0);
            // 空の環境光はシミュレーション時刻 15 分ごとに作り直す
            const slot = Math.floor(s.hour * 4);
            const env = slot !== lastSlot;
            lastSlot = slot;
            scene.setSunDirection(dir, env);
            sunPath.updateMarker(dir, center, R);
          },
        });
      } catch (e) {
        if (!isAbort(e)) {
          console.error(e);
          toast(`動画の書き出しに失敗しました: ${(e as Error).message}`, 'error');
        }
      } finally {
        pm.close();
        scene.applyView(view);
        apply(true);
      }
      if (!result) return;
      const out = result;
      const url = URL.createObjectURL(out.blob);
      modal(
        label,
        h('video', { src: url, controls: true, autoplay: true, style: 'width:100%' }),
        [
          { label: `${out.ext.toUpperCase()} をダウンロード`, primary: true, onClick: () => download(url, `${study.name}_${label}.${out.ext}`) },
          { label: '閉じる' },
        ],
        true,
      );
    };

    const analysis = section(
      '日当たりの解析',
      heatBtn,
      heatLegend,
      h('div', { style: 'height:6px' }),
      facadeBtn,
      facadeLegend,
      h('p', { class: 'hint' }, '直射日光が当たる時間の合計（青=短い → 赤=長い）。地形・周辺建物・自建物の影を計算します。'),
      h('div', { class: 'field-label', style: 'margin-top:12px' }, '📍 測定点（窓の中心など）'),
      h('div', { class: 'btn-row' }, placeBtn, h('button', { class: 'btn sm primary', onclick: () => void runPoints() }, '☀ 測定点を解析（冬至・春分・夏至・秋分）')),
      ptBox,
      h('div', { class: 'field-label', style: 'margin-top:12px' }, '📐 日影図（冬至日）'),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn sm', disabled: landOnly, onclick: () => void runDiagram(1.5, 'GL+1.5m') }, 'GL+1.5m（低層住居専用地域など）'),
        h('button', { class: 'btn sm', disabled: landOnly, onclick: () => void runDiagram(4, 'GL+4m') }, 'GL+4m（中高層住居・近隣商業など）'),
        h('button', { class: 'btn sm', disabled: landOnly, onclick: () => void runDiagram(6.5, 'GL+6.5m') }, 'GL+6.5m（条例による地域）'),
      ),
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: includeNb,
          onchange: (e: Event) => (includeNb = (e.target as HTMLInputElement).checked),
        }),
        '周辺建物を含める',
      ),
      h('p', { class: 'hint' }, '法規の日影図は自建物のみで作成します。実際の日当たりの確認には周辺建物を含めてください。'),
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: hokkaido,
          onchange: (e: Event) => {
            hokkaido = (e.target as HTMLInputElement).checked;
            renderDiagramInfo();
          },
        }),
        '北海道（真太陽時 9〜15時）',
      ),
      glInfo,
      solarEl,
      siteHint,
      h('p', { class: 'hint' }, landOnly ? '日影図には建物の 3D データが必要です。' : '検討用であり申請図ではありません。'),
      h('div', { class: 'field-label', style: 'margin-top:12px' }, '📷 撮影・動画'),
      h('button', { class: 'btn sm block', onclick: () => void captureSeasons() }, '📷 季節の日当たり比較を撮影（冬至 9/12/15時・春分 12時・夏至 9/12/15時）'),
      h('p', { class: 'hint' }, '今の視点で撮影します。先に「鳥瞰」などで見せたい角度にしてください。'),
      imgBox,
      h('div', { class: 'field-label', style: 'margin-top:10px' }, '🎬 タイムラプス動画（MP4）'),
      segmented<'winter' | 'summer'>(
        [
          { value: 'winter', label: '冬至' },
          { value: 'summer', label: '夏至' },
        ],
        tlSeason,
        (v) => (tlSeason = v),
      ),
      h('div', { style: 'height:6px' }),
      segmented<'1080' | '720'>(
        [
          { value: '1080', label: 'フルHD 1080p' },
          { value: '720', label: 'HD 720p（速い）' },
        ],
        tlRes,
        (v) => (tlRes = v),
      ),
      h('button', { class: 'btn sm block', style: 'margin-top:8px', onclick: () => void recordTimelapse() }, '🎬 タイムラプスを書き出す（約12秒・日の出〜日の入）'),
      h('p', { class: 'hint' }, '今の視点のまま 1 コマずつ描いて書き出します。パソコンの性能により数分かかります。MP4 に未対応のブラウザでは WebM になります。'),
    );
    side.appendChild(analysis);

    // ---- サイド 5: レポート・保存 ----
    side.appendChild(
      section(
        'レポート・保存',
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn primary', onclick: () => openReport() }, '🖨 レポート（印刷・PDF）'),
          h('button', { class: 'btn', onclick: () => downloadReport() }, '保存（HTML）'),
          h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                try {
                  downloadProject();
                } catch (e) {
                  toast(`プロジェクトを保存できませんでした: ${(e as Error).message}`, 'error');
                }
              },
            },
            '💾 プロジェクトを保存',
          ),
        ),
        h('p', { class: 'hint' }, 'レポートには撮影した比較画像・日照時間マップ・測定点の表・日影図のうち、作成済みのものが入ります。本資料は検討用であり、法規上の日影規制の判定・申請図ではありません。'),
      ),
    );

    // ---- キー操作（F: お客様モード、Esc: 終了） ----
    const typing = (e: KeyboardEvent) => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        setPresenting(!isPresenting());
      } else if (e.key === 'Escape') {
        if (isPresenting()) setPresenting(false);
        if (placing) setPlacing(false);
        closePop();
      }
    };
    window.addEventListener('keydown', onKey);
    disposers.push(
      () => window.removeEventListener('keydown', onKey),
      () => {
        if (isPresenting()) setPresenting(false);
      },
    );

    // ---- 状態の変化に追従 ----
    disposers.push(
      on('neighbors', () => {
        rebuildEnv();
        renderNeighborList();
        renderSite();
        renderChipsLine();
        renderDiagramInfo();
      }),
      on('points', () => {
        rebuildMarkers();
        renderPoints();
      }),
      on('env', () => {
        if (study.env.loading) return;
        hzCache.clear();
        rebuildEnv();
        renderSite();
        renderChipsLine();
        renderAttribution();
        renderEnvWarn();
        renderNeighborList();
        renderDiagramInfo();
        apply(true);
      }),
    );

    // ---- 初期描画 ----
    renderDateChips();
    renderChipsLine();
    renderAttribution();
    renderEnvWarn();
    renderSite();
    renderNeighborList();
    rebuildMarkers();
    renderPoints();
    renderDiagramInfo();
    renderImages();
    syncHeatUI();
    syncFacadeUI();
    setNote(null);
    apply(true);
  },
};
