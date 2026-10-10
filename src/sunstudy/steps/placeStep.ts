/**
 * ステップ 1「建設地」: 住所検索／地図クリックでピン、敷地の輪郭、周辺環境（地形・航空写真・周辺建物）の読み込み、
 * プロジェクトの保存／読込
 *
 * 画面: ステージに 2D 地図（MapPicker）とその上のツール・状態表示、サイドに住所検索・敷地・周辺環境・プロジェクト。
 * 状態の更新は必ず study を書き換えて emit し、表示を refresh*() で作り直す。
 * ピンを動かしたとき: 周辺環境が読み込み済みで移動が小さければ（150m 未満）、格子・航空写真・周辺建物を新しいピン基準に
 * ずらして使い続ける（座標系の原点 = ピン）。大きく動いたときは破棄し、再読み込みを促す。
 * 建物と測定点の追従は周辺環境とは別に followPinMove（alignment.ts）で決める: 位置合わせ・手で置いた記録がある建物は
 * 地球上の同じ所に留まり、読み込んだだけの建物はピンに付いて動く。測定点は建物と同じだけ動く。
 * 3D の pivot は placement を書き換えた後に必ず applyTransform() で同期する（日照画面が古い位置で描かないように）。
 *
 * 敷地を細かく描く: 地図はズーム 22 まで（18 より先は写真を引き伸ばす）。輪郭を描く・編集する間は辺の長さ（m, 小数 2 桁）と面積を地図に出し、
 * サイドの「辺の長さ」で辺ごとの長さを数値で直せる（辺の終点を辺の向きに動かす）。「寸法で区画を作る」は間口 × 奥行・向きの長方形をピン
 * （輪郭があればその重心）を中心に作る。Ctrl+Z / Shift+Ctrl+Z で輪郭の変更を取り消し／やり直し。
 * 想定の家（未建築の隣家）: 「＋ 想定の家を置く」（地図をクリックした所に）、「隣の区画に想定の家」（敷地の辺の向こうに同じ形の区画を並べて中に置く）、
 * 「区画を描いて家を置く」。どれも state の addPlannedHouse / updatePlannedHouse / removePlannedHouse を通す。地図で選んでドラッグ・R で回転・
 * 小さな編集欄で寸法・高さ・屋根を直す。生成した区画は地図に破線で出す（この画面だけの表示。保存はしない）。
 */
import { h, clear, toast, progressModal, section, segmented, field } from '../../app/dom';
import { geocode, PRECISION_LABEL, parseDegrees, parseLatLonFields, formatDeg, formatDms } from '../../sun/geo';
import type { StudyStep, StudyCtx } from '../shell';
import {
  study,
  emit,
  on,
  visibleNeighbors,
  effectiveNeighbors,
  hiddenNeighbors,
  setNeighborsHidden,
  restoreAllNeighbors,
  getHideDefaults,
  plannedHouses,
  addPlannedHouse,
  updatePlannedHouse,
  removePlannedHouse,
  clearPlannedHouses,
  setPlannedEnabled,
  type PlannedNeighbor,
} from '../state';
import { hideOptionsControl, hideToastText } from './neighborHide';
import type { GeoFrame, LatLon, NeighborSource } from '../types';
import { frameFromLocal, frameToLocal } from '../types';
import { MapPicker, MAP_LAYER_LABEL, MAX_ZOOM, MIN_ZOOM, bearingDeg, edgeLengthsM, formatLength, polygonAreaM2, polygonCentroid, rectangleLot, type MapLayer, type MapPlannedHouse } from '../map';
import {
  DEFAULT_PLANNED_PRESET,
  PLANNED_PRESETS,
  ROOF_LABEL,
  ROOF_TYPES,
  houseFromPreset,
  houseInLot,
  isPlannedPresetId,
  isRoofType,
  plannedFootprint,
  plannedLocalToEN,
  plannedPreset,
  translateLotAcrossEdge,
  type EN,
  type PlannedHouse,
  type PlannedPresetId,
  type RoofType,
} from '../../sun/plannedHouse';
import { dominantAngleDeg, polygonArea } from '../../sun/align';
import { loadEnvironment, NEIGHBOR_RADIUS } from '../environment';
import { DEM_LABEL, gridStats, sampleHeight } from '../terrain';
import { buildingEavesOutlineEN, buildingFootprintEN, buildingOutlineEN, currentPlaced, ensurePlacedData } from '../building';
import { followPinMove } from '../alignment';
import { downloadProject, loadProjectFile, loadProjectFromUrl, saveRecent, readRecent, envIsFromSavedProject, markEnvFetched } from '../project';

/** 初期表示（東京駅付近） */
const TOKYO: LatLon = { lat: 35.681236, lon: 139.767125 };
/** 検索した住所をピンの住所として使い続ける距離 (m) */
const ADDRESS_KEEP_M = 300;
/** これ以上ピンを動かしたら周辺環境を破棄する (m) */
const ENV_SHIFT_MAX_M = 150;
/** 1 坪 (㎡) */
const TSUBO = 3.305785;
/** 高低差を見る半径 (m) */
const STATS_RADIUS = 60;

let map: MapPicker | null = null;

/** 地図タイルが読めないときに地図上へ出す案内 */

let offlineNote: HTMLElement | null = null;
let disposers: (() => void)[] = [];
/** 住所の基準点（検索結果・読み込んだプロジェクトの住所）。ピンが近ければこの住所を使う */
let anchor: { lat: number; lon: number; address: string } | null = null;
/** この起動で周辺環境を取得したか（保存データの復元と区別） */
let fetchedThisSession = false;
/** 描いている途中の輪郭の頂点数 */
let drawCount = 0;
/** 周辺環境を取得（復元）したときのピン位置。ここから ENV_SHIFT_MAX_M 以上離れたら周辺環境を捨てる（ドラッグの積算） */
let envOrigin: LatLon | null = null;
/** 想定の家を置くときの形（最後に選んだもの。画面を移っても覚えておく） */
let plannedPresetChoice: PlannedPresetId = DEFAULT_PLANNED_PRESET;
/**
 * 想定の家と一緒に作った区画（家の中心からの東・北 m）。地図に破線で出すだけで保存はしない。
 * 家の中心からの相対で持つので、ピンを動かして家がずれても区画は家に付いていく（家を手で動かしたときは区画をその場に残す）
 */
const plannedLots = new Map<string, EN[]>();

const fmtDeg = formatDeg;
const coordAddress = (p: LatLon) => `緯度 ${fmtDeg(p.lat)}, 経度 ${fmtDeg(p.lon)} 付近`;
const isCoordAddress = (s: string) => /^緯度 .* 付近$/.test(s);

/**
 * 「座標で指定」の入力欄を読む（緯度・経度の 2 欄。経度が空なら緯度の欄の「緯度, 経度」の 1 行や Google マップの URL も可）。
 * 緯度と経度を取り違えていて parseLatLonFields が入れ替えたときは swapped = true（案内を出すため）。読めない・日本国内でなければ null
 */
export function readCoordInput(latText: string, lonText = ''): { lat: number; lon: number; swapped: boolean } | null {
  const r = parseLatLonFields(latText, lonText);
  if (!r) return null;
  // 入れ替えの判定: 緯度の欄をそのまま角度として読んだ値が結果の経度と一致していれば取り違えていた（1 行入力は欄を分けたのと同じに扱う）
  let a = latText;
  let b = lonText;
  if (!b.trim()) {
    const parts = latText.normalize('NFKC').split(/[,，]/);
    if (parts.length === 2) [a, b] = parts;
  }
  const rawLat = b.trim() ? parseDegrees(a) : null;
  const swapped = rawLat != null && Math.abs(rawLat - r.lon) < 1e-9 && Math.abs(rawLat - r.lat) > 1e-9;
  return { lat: r.lat, lon: r.lon, swapped };
}

/** クリップボードに書く文字列（「緯度, 経度」。住所検索の欄や Google マップにそのまま貼れる形） */
export function coordClipboardText(p: LatLon): string {
  return `${fmtDeg(p.lat)}, ${fmtDeg(p.lon)}`;
}
/** 角度を [0, 360) に */
const norm360 = (d: number) => ((d % 360) + 360) % 360;

/**
 * 想定の家を置く向き（width の軸 = 棟の方位）: 敷地の輪郭があれば、その主な向き（辺の長さで重み付け）と直角の向きのうち東西に近い方
 * （棟を東西に通して南の面を長くとる一般的な配置）。輪郭が無ければ計画の建物と平行（headingDeg + 90）、建物も無ければ 90（棟が東西）
 */
export function plannedRotationFor(siteEN: EN[] | null, headingDeg?: number | null): number {
  if (siteEN && siteEN.length >= 3 && Math.abs(polygonArea(siteEN)) > 1e-6) {
    const a = dominantAngleDeg(siteEN); // [0, 90)
    return a >= 45 ? a : a + 90;
  }
  if (headingDeg != null && Number.isFinite(headingDeg)) return norm360(headingDeg + 90);
  return 90;
}

/** 敷地の辺 i（site[i] → site[i+1]）が外周の辺か（敷地全体がその辺の直線の片側にある = 向こう側に区画を並べても敷地と重ならない） */
export function isOuterEdge(site: EN[], i: number, tol = 0.05): boolean {
  const n = site.length;
  if (n < 3 || !Number.isInteger(i) || i < 0 || i >= n) return false;
  const a = site[i];
  const b = site[(i + 1) % n];
  const L = Math.hypot(b.e - a.e, b.n - a.n);
  if (!(L > 1e-6)) return false;
  let pos = 0;
  let neg = 0;
  for (const p of site) {
    const s = ((b.e - a.e) * (p.n - a.n) - (b.n - a.n) * (p.e - a.e)) / L;
    if (s > tol) pos++;
    else if (s < -tol) neg++;
  }
  return !(pos && neg);
}

/** 隣の区画と想定の家 */
export interface NeighborLotPlan {
  /** 区画（敷地と同じ形・同じ点の順。ピンからの東・北 m） */
  lot: EN[];
  house: PlannedHouse;
  /** 区画の前面（道路側とみなした辺）の番号 */
  frontEdgeIndex: number;
}

/**
 * 「隣の区画に想定の家」: 敷地（ピンからの東・北 m）の辺 i の向こうに、敷地と同じ形の区画を並べ（translateLotAcrossEdge。分譲地で同じ区画が並ぶ想定）、
 * その中に想定の家を置く（houseInLot）。区画の前面（道路側とみなして 2 m 離す）は、クリックした辺に平行で敷地から最も遠い辺（区画の辺 i）。
 * クリックした辺（敷地との境界）を含む他の辺からは 1 m、建ぺい率 50% 以内で、余裕があれば北に寄せる。
 * 凹んだ所の辺なら 'concave'、家（3 m × 3 m 以上）が入らなければ 'small'、壊れた入力は 'invalid'
 */
export function neighborLotPlan(site: EN[], i: number, preset: PlannedPresetId = DEFAULT_PLANNED_PRESET): NeighborLotPlan | 'concave' | 'small' | 'invalid' {
  const n = site.length;
  if (n < 3 || !Number.isInteger(i) || i < 0 || i >= n || !(Math.abs(polygonArea(site)) > 1e-6)) return 'invalid';
  if (!isOuterEdge(site, i)) return 'concave';
  const lot = translateLotAcrossEdge(site, i);
  const house = houseInLot(lot, { preset, frontEdgeIndex: i });
  if (!house) return 'small';
  return { lot, house, frontEdgeIndex: i };
}

/** 想定の家の屋根の線（地図に描く。切妻 = 棟、寄棟 = 棟と隅棟、片流れ・陸屋根は無し）。ピンからの東・北 m */
export function plannedRoofLines(h: PlannedHouse): EN[][] {
  const a = h.width / 2;
  const b = h.depth / 2;
  const at = (u: number, v: number) => plannedLocalToEN(h, u, v);
  if (h.roof === 'gable') return [[at(-a, 0), at(a, 0)]];
  if (h.roof === 'hip') {
    const r = Math.max(0, a - b);
    return [
      [at(-r, 0), at(r, 0)],
      [at(-r, 0), at(-a, -b)],
      [at(-r, 0), at(-a, b)],
      [at(r, 0), at(a, -b)],
      [at(r, 0), at(a, b)],
    ];
  }
  return [];
}

const signedM = (v: number, d = 1) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(d)}m`;
const tpText = (v: number) => `T.P.${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)} m`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function distM(a: LatLon, b: LatLon): number {
  const d = frameToLocal(a, b);
  return Math.hypot(d.e, d.n);
}

function siteArea(): number | null {
  if (study.sitePolygon.length < 3) return null;
  try {
    const a = polygonAreaM2(study.sitePolygon);
    return Number.isFinite(a) && a > 0 ? a : null;
  } catch {
    return null;
  }
}

const areaText = (a: number) => `${a.toFixed(1)}㎡（${(a / TSUBO).toFixed(1)}坪）`;

const SOURCE_TAG: Record<NeighborSource, { cls: string; label: string }> = {
  plateau: { cls: 'measured', label: 'PLATEAU・実測の高さ' },
  gsi: { cls: 'estimated', label: '国土地理院・高さは推定' },
  osm: { cls: 'estimated', label: 'OpenStreetMap・高さは推定' },
  manual: { cls: 'manual', label: '手動で追加' },
};

/** 外部サーバーに届かなかったときの案内（既存アプリと同じ文言） */
function networkHint(): string {
  return /localhost|127\.0\.0\.1/.test(location.hostname)
    ? 'インターネット接続を確認してください。取得できなかった項目は平地・写真なし・建物なしとして続行できます'
    : '公開プレビュー版では外部の地図サーバーへの接続が制限されることがあります。お手元のパソコンで start.bat から起動してお試しください';
}

// ---------------------------------------------------------------------------
// 状態の更新
// ---------------------------------------------------------------------------

/** 周辺環境を破棄する（ピンが大きく動いた・場所を変えた） */
function invalidateEnv() {
  envOrigin = null;
  study.grid = null;
  study.aerial = null;
  study.horizon = null;
  study.neighbors = study.neighbors.filter((n) => n.source === 'manual');
  study.neighborSources = [];
  study.neighborNotes = [];
  study.env = { loaded: false, loading: false, error: null, attribution: '' };
  markEnvFetched();
  emit('env');
  emit('neighbors');
}

/** ピンが prev → next に動いた: 周辺環境を新しい原点にずらす（小さな移動）か破棄する */
function relocateEnvironment(prev: GeoFrame, next: GeoFrame) {
  const d = frameToLocal(prev, next);
  const dist = Math.hypot(d.e, d.n);
  if (dist < 0.01) {
    next.groundElev = prev.groundElev;
    return;
  }
  // 取得したときの位置からの累積の移動量で判定する（ドラッグで少しずつ動かしても遠くへ行けば捨てる）
  const origin = envOrigin ?? prev;
  const total = distM(origin, next);
  if (!study.env.loaded || !study.grid || total > ENV_SHIFT_MAX_M) {
    invalidateEnv();
    return;
  }
  const shift = (o: { west: number; east: number; south: number; north: number }) => {
    o.west -= d.e;
    o.east -= d.e;
    o.south -= d.n;
    o.north -= d.n;
  };
  shift(study.grid);
  if (study.aerial) shift(study.aerial);
  for (const n of study.neighbors) {
    n.ring = n.ring.map((q) => ({ e: q.e - d.e, n: q.n - d.n }));
    // PLATEAU の中庭などの穴も同じ座標系なので一緒にずらす
    const x = n as typeof n & { holes?: { e: number; n: number }[][] };
    if (x.holes) x.holes = x.holes.map((h) => h.map((q) => ({ e: q.e - d.e, n: q.n - d.n })));
  }
  // 建物と測定点は周辺環境とは別に followPinMove（setFrame）で追従させる（周辺環境を捨てる分岐でも同じ規則になるように）
  const h0 = sampleHeight(study.grid, 0, 0);
  next.groundElev = Number.isFinite(h0) ? h0 : prev.groundElev;
  emit('env');
  emit('neighbors');
}

/** ピンの位置と住所を確定する */
function setFrame(p: LatLon, address: string) {
  const prev = study.frame;
  const next: GeoFrame = { lat: p.lat, lon: p.lon, address, groundElev: null };
  if (prev) relocateEnvironment(prev, next);
  else if (study.env.loaded) invalidateEnv();
  const moved = !prev || distM(prev, next) >= 0.01;
  study.frame = next;
  if (moved) {
    // 建物: 位置合わせ・手で置いた記録があれば地球上の同じ所に保つ（2 点合わせは対応点から解き直す）。
    // 新しいピンから周辺環境の半径より遠くなるときは（建設地そのものが変わった）ピンの位置に戻して記録を外す。
    // 記録が無い（読み込んだだけの）建物はピンに付いて動く。測定点は建物と同じだけ動く
    const r = followPinMove(prev, next, study.model ? study.placement : null, study.points, NEIGHBOR_RADIUS);
    if (r.kind === 'reset') toast('建設地が大きく変わったため、建物をピンの位置に戻しました。「建物を置く」で位置合わせをやり直してください', 'info', 8000);
    // 3D の pivot は placement を書き換えただけでは動かないので、ここで同期する（日照画面に直接進んでも正しい位置で描く・解析する）
    currentPlaced()?.applyTransform();
  }
  emit('frame');
  // 建物の位置（ピンからの相対）が変わったので、地図の足跡・日照画面の視点などに知らせる
  if (study.model && moved) emit('placement');
  saveRecent();
}

/** 地図上でピンが置かれた・動いた */
function pinFromMap(p: LatLon) {
  const addr = anchor && distM(anchor, p) < ADDRESS_KEEP_M ? anchor.address : coordAddress(p);
  setFrame(p, addr);
}

/** 面積 0 の輪郭を閉じたことを既に伝えたか（頂点をドラッグするたびに繰り返さない） */
let degenerateWarned = false;

/**
 * 敷地ポリゴンを状態に反映（閉じた 3 点以上だけを敷地とみなす）。
 * 閉じていても面積が 0（点が一直線上・同じ点の繰り返し: A→B→A を A で閉じるなど）なら敷地とはみなさない
 * （輪郭に合わせる計算で矩形が作れず、周辺建物の除外にも使えない）
 */
function applyPolygon(poly: LatLon[], closed: boolean) {
  drawCount = poly.length;
  const degenerate = closed && poly.length >= 3 && !(polygonAreaM2(poly) > 0);
  if (degenerate && !degenerateWarned) toast('敷地の輪郭の面積が 0 です（点が一直線上か同じ点の繰り返し）。描き直してください', 'error', 7000);
  degenerateWarned = degenerate;
  const next = closed && poly.length >= 3 && !degenerate ? poly.map((q) => ({ lat: q.lat, lon: q.lon })) : [];
  const same = next.length === study.sitePolygon.length && next.every((q, i) => Math.abs(q.lat - study.sitePolygon[i].lat) < 1e-9 && Math.abs(q.lon - study.sitePolygon[i].lon) < 1e-9);
  if (!same) {
    study.sitePolygon = next;
    emit('site');
    saveRecent();
  }
}

// ---------------------------------------------------------------------------
// ステップ
// ---------------------------------------------------------------------------

export const placeStep: StudyStep = {
  id: 'place',
  label: '建設地',
  enabled: () => true,
  uses3d: false,
  unmount() {
    for (const f of disposers.splice(0)) f();
    try {
      map?.dispose();
    } catch {
      /* 地図が初期化できていない */
    }
    map = null;
    offlineNote = null;
    (window as unknown as { placeMap?: MapPicker | null }).placeMap = null;
  },
  mount(ctx: StudyCtx) {
    const { stage, side, shell } = ctx;
    drawCount = 0;
    /** 「地図で建物を選んで隠す」モード（クリックで輪郭の建物を隠す／戻す。ピンは動かさない） */
    let pickOn = false;
    /** 地図に付けている道具: 想定の家を置く・隣の区画・区画を描く・前面の向き（2 点）。無ければ null */
    let toolMode: 'place' | 'edge' | 'lot' | 'front' | null = null;
    /** 地図で選んでいる想定の家 */
    let selPlanned: string | null = null;
    /** 編集欄を作った家（選択が変わったら作り直す） */
    let popFor: string | null = null;
    /** 選んでいる家の足元（ピンからの東・北 m。編集欄の位置合わせ用） */
    let selRing: EN[] | null = null;
    // 保存データから周辺環境が復元されている場合は、今のピン位置を取得位置として扱う
    if (study.env.loaded && study.frame && !envOrigin) envOrigin = { lat: study.frame.lat, lon: study.frame.lon };
    if (study.frame && study.frame.address && !isCoordAddress(study.frame.address)) anchor = { lat: study.frame.lat, lon: study.frame.lon, address: study.frame.address };

    // ---- ステージ: 地図 ----
    const root = h('div', { class: 'map-root' });
    stage.appendChild(root);
    const status = h('div', { class: 'map-status' });
    const attrib = h('div', { class: 'map-attrib' });
    const hint = h('div', { class: 'map-hint' });
    const toolbar = h('div', { class: 'map-tools' });
    // ズーム（5〜22。18 より先は写真を引き伸ばす）と今のズームの表示
    const zoomInBtn = h('button', { title: '拡大（最大 22。18 より先は写真を引き伸ばして細かく描けます）', onclick: () => map?.zoomBy(1) }, '＋');
    const zoomOutBtn = h('button', { title: '縮小', onclick: () => map?.zoomBy(-1) }, '－');
    const zoomLevel = h('div', { class: 'map-zoom-level', title: '地図のズーム' });
    const zoom = h('div', { class: 'map-zoom' }, zoomInBtn, zoomLevel, zoomOutBtn);
    const overzoomNote = h('div', { class: 'map-overzoom', style: 'display:none' }, '18 より先は写真を引き伸ばしています（点は細かく置けます）');
    // 選んだ想定の家の小さな編集欄（地図の上、家の横に浮かべる）
    const plannedPop = h('div', { class: 'map-planned-pop', style: 'display:none' });
    // 編集欄の入力中でも Esc で閉じる（地図の Esc は入力欄では効かないので）
    plannedPop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        selectPlanned(null);
      }
    });
    root.append(toolbar, zoom, overzoomNote, status, attrib, hint, plannedPop);

    // 地図レイヤー
    const layerSeg = segmented<MapLayer>(
      [
        { value: 'std', label: MAP_LAYER_LABEL.std },
        { value: 'photo', label: MAP_LAYER_LABEL.photo },
        { value: 'pale', label: MAP_LAYER_LABEL.pale },
      ],
      'std',
      (v) => {
        map?.setLayer(v);
        refreshAttrib();
      },
    );

    // 敷地の輪郭のボタン（地図上とサイドの 2 か所に同じものを置く）
    const polyButtons: { toggle: HTMLButtonElement; clearBtn: HTMLButtonElement; editBtn: HTMLButtonElement }[] = [];
    const makePolyButtons = () => {
      const toggle = h('button', {
        class: 'btn',
        onclick: () => {
          if (!map) return;
          if (map.polygonMode) {
            if (drawCount >= 3) map.finishPolygon();
            map.setPolygonMode(false);
          } else {
            map.setPolygonMode(true);
          }
          refreshAll();
        },
      });
      const clearBtn = h('button', {
        class: 'btn',
        onclick: () => {
          if (!map) return;
          map.clearPolygon();
          map.setPolygonMode(false);
          applyPolygon([], false);
          refreshAll();
        },
      }, '輪郭を消す');
      // 輪郭の編集（頂点の追加・削除・移動、辺の長さの表示）
      const editBtn = h('button', {
        class: 'btn',
        title: '頂点のドラッグ・追加（辺の中点の＋）・削除（選んで Delete／右クリック）、面積の札のドラッグで全体を移動。辺の長さを表示します',
        onclick: () => {
          if (!map) return;
          const on = !map.polygonEditMode;
          map.setPolygonEditMode(on);
          if (on && map.polygonEditMode)
            toast('輪郭の編集: 頂点をドラッグで移動、辺の中点の「＋」で頂点を追加、頂点を選んで Delete（または右クリック）で削除、面積の札をドラッグで全体を移動。Shift で直角・平行にそろえる。Ctrl+Z で元に戻す。Esc で終了', 'info', 8000);
          refreshAll();
        },
      });
      polyButtons.push({ toggle, clearBtn, editBtn });
      return [toggle, editBtn, clearBtn];
    };

    const locateBtn = h('button', {
      class: 'btn',
      title: 'この端末の現在地にピンを置く',
      onclick: () => {
        if (!navigator.geolocation) {
          toast('この環境では現在地を取得できません', 'error');
          return;
        }
        locateBtn.disabled = true;
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            locateBtn.disabled = false;
            const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
            anchor = null;
            setFrame(p, coordAddress(p));
            map?.setCenter(p, 17);
            map?.setPin(p, true);
            refreshAll();
          },
          () => {
            locateBtn.disabled = false;
            toast('現在地を取得できませんでした（位置情報の許可を確認してください）', 'error');
          },
          { enableHighAccuracy: true, timeout: 10000 },
        );
      },
    }, '📍 現在地');
    toolbar.append(layerSeg, ...makePolyButtons(), locateBtn);

    // ---- サイド ----
    side.append(h('h2', null, '建設地を指定'), h('p', { class: 'lead' }, '住所で探すか、地図をクリックして建設地にピンを置きます。ピンの位置が 3D の原点（建物を置く場所・地盤高の基準）になります。「建物を置く」で位置を合わせた建物は、ピンを動かしても地球上の同じ所に留まります。航空写真に切り替えると敷地の形がよく分かります。'));

    // 住所で探す
    const q = h('input', { type: 'text', placeholder: '例: 愛知県小牧市小牧4-213（番地まで。Google マップの URL や緯度,経度でも可）', autocomplete: 'off' });
    // Google Geocoding API のキー（任意）。国土地理院・アドレス・ベース・レジストリで番地まで出ないときの補助
    const googleKeyInput = h('input', {
      type: 'password',
      placeholder: 'Google Maps API キー（任意）',
      autocomplete: 'off',
      value: (() => {
        try {
          return localStorage.getItem('googleMapsKey') ?? '';
        } catch {
          return '';
        }
      })(),
      onchange: (e: Event) => {
        try {
          localStorage.setItem('googleMapsKey', (e.target as HTMLInputElement).value.trim());
        } catch {
          // 保存できない環境では入力中だけ使う
        }
      },
    });
    const results = h('div', { class: 'geo-results' });
    const searchBtn = h('button', { class: 'btn', onclick: () => void search() }, '検索');
    const search = async () => {
      const text = q.value.trim();
      if (!text) {
        toast('住所を入力してください', 'error');
        return;
      }
      searchBtn.disabled = true;
      clear(results);
      results.appendChild(h('div', { class: 'hint' }, '検索中…（番地の照合に数秒かかることがあります）'));
      try {
        const list = (await geocode(text, { googleKey: googleKeyInput.value.trim() || undefined })).slice(0, 6);
        clear(results);
        if (!list.length) {
          results.appendChild(h('div', { class: 'warn' }, '見つかりませんでした。番地を省く、または市区町村から入力してみてください。地図を直接クリックしてピンを置くこともできます'));
          return;
        }
        for (const r of list) {
          // 番地・号・座標まで特定できた候補はピンが正確なので一段寄せる（タイルの配信上限 18。敷地を描くときはさらに 22 まで拡大できる）
          const precise = r.precision === 'point' || r.precision === 'go' || r.precision === 'ban';
          results.appendChild(
            h('button', {
              class: 'btn sm',
              onclick: () => {
                anchor = { lat: r.lat, lon: r.lon, address: r.title };
                setFrame(r, r.title);
                map?.setCenter(r, precise ? 18 : 17);
                map?.setPin(r, true);
                refreshAll();
                if (r.precision === 'town' || r.precision === 'chome')
                  toast('番地までは特定できませんでした。地図上でピンをドラッグ（または航空写真でクリック）して建設地に合わせてください', 'info', 8000);
              },
            }, r.title, h('span', { class: 'hint', style: 'margin-left:6px' }, PRECISION_LABEL[r.precision])),
          );
        }
        results.appendChild(h('div', { class: 'hint' }, '候補を選ぶとピンが置かれます。番地まで一致しない場合は、地図上でピンをドラッグして合わせてください'));
      } catch (e) {
        clear(results);
        results.appendChild(h('div', { class: 'warn' }, errMsg(e)));
      } finally {
        searchBtn.disabled = false;
      }
    };
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void search();
      }
    });
    side.appendChild(
      section(
        '住所で探す',
        h('div', { class: 'btn-row', style: 'margin:0' }, h('div', { class: 'field', style: 'flex:1;margin:0' }, q), searchBtn),
        h(
          'details',
          { style: 'margin:6px 0' },
          h('summary', { class: 'hint', style: 'cursor:pointer' }, '番地まで出ないときは Google の住所検索を使う（API キーを設定）'),
          h('div', { class: 'field', style: 'margin:6px 0 0' }, googleKeyInput),
          h('span', { class: 'hint' }, 'Google Cloud で「Geocoding API」を有効にしたキーを貼ると、住居表示の無い地域や新しい番地も特定できます。キーはこのパソコンにだけ保存されます'),
        ),
        results,
      ),
    );

    // 座標で指定（緯度・経度）: 住所の無い分譲地・造成地など、座標が分かっているときに直接ピンを置く。
    // 欄は編集中でなければいつも今のピンの座標（10 進）を示し、下に度分秒とコピー。住所検索の欄より後ろに置く（自動テストは最初の text 入力を住所欄とみなす）
    const latIn = h('input', { type: 'text', class: 'coord-lat', placeholder: '例: 35.21058 または 35°12′38.1″', autocomplete: 'off' });
    const lonIn = h('input', { type: 'text', class: 'coord-lon', placeholder: '例: 136.93831', autocomplete: 'off' });
    const dmsOut = h('span', { class: 'coord-dms' });
    const copyBtn = h('button', { class: 'btn sm', title: '今のピンの座標を「緯度, 経度」の形でコピー', onclick: () => void copyCoords() }, 'コピー');
    const applyCoords = () => {
      const r = readCoordInput(latIn.value, lonIn.value);
      if (!r) {
        toast('緯度・経度を読み取れませんでした。10 進（35.21058）か度分秒（35°12′38.1″）で、日本国内の座標を入力してください', 'error', 8000);
        return;
      }
      if (r.swapped) toast('緯度と経度が逆だったので入れ替えました', 'info');
      const p: LatLon = { lat: r.lat, lon: r.lon };
      // 座標の直接指定は番地まで特定した扱い（住所の基準点は外し、住所は座標の文字列にする）
      anchor = null;
      setFrame(p, coordAddress(p));
      // 欄が編集中（Enter で確定）でも、読み取った値を 10 進に揃えて見せる
      latIn.value = fmtDeg(p.lat);
      lonIn.value = fmtDeg(p.lon);
      map?.setCenter(p, 18);
      map?.setPin(p, true);
      refreshAll();
    };
    const copyCoords = async () => {
      const f = study.frame;
      if (!f) return;
      const text = coordClipboardText(f);
      try {
        await navigator.clipboard.writeText(text);
        toast('座標をコピーしました', 'ok');
      } catch {
        toast(`コピーできませんでした（この環境ではクリップボードを使えません）。座標: ${text}`, 'error', 8000);
      }
    };
    for (const el of [latIn, lonIn])
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyCoords();
        }
      });
    side.appendChild(
      section(
        '座標で指定（緯度・経度）',
        h('p', { class: 'hint', style: 'margin:0 0 4px' }, '住所の無い分譲地・造成地など、座標が分かっているときはここに入力します。10 進（35.21058）でも度分秒（35°12′38.1″・35度12分38.1秒）でも可。「緯度, 経度」の 1 行や Google マップの URL を緯度の欄に貼ってもよいです。欄にはいつも今のピンの座標が表示されます。'),
        h('div', { class: 'pos-fields' }, field('緯度', latIn), field('経度', lonIn)),
        h('div', { class: 'coord-row' }, dmsOut, copyBtn),
        h('div', { class: 'btn-row', style: 'margin:6px 0 0' }, h('button', { class: 'btn', onclick: applyCoords }, 'この座標にピンを置く')),
      ),
    );

    // 敷地（任意）
    const areaOut = h('div', { class: 'ok-box', style: 'display:none' });
    const polyInfo = h('div', { class: 'info-box' });
    const footprintHint = h('p', { class: 'hint', style: 'margin:4px 0 0;display:none' }, '地図上の建物: 濃い線 = 壁、薄い面 = 軒先（航空写真で見えるのは軒先です）');
    // 取り消し・やり直し（輪郭の変更。Ctrl+Z / Shift+Ctrl+Z でも）
    const undoBtn = h('button', { class: 'btn sm ghost', title: '輪郭の変更を元に戻す（Ctrl+Z）', onclick: () => map?.undo() }, '↶ 元に戻す');
    const redoBtn = h('button', { class: 'btn sm ghost', title: '元に戻した変更をやり直す（Shift+Ctrl+Z）', onclick: () => map?.redo() }, '↷ やり直す');
    // 辺の長さ（数値で直す）
    const edgeBox = h('div', { class: 'edge-box' });
    // 寸法で区画を作る（間口 × 奥行・向き）
    const lotWIn = h('input', { type: 'number', class: 'lot-w', step: '0.01', min: '0.1', placeholder: '例: 12.5' });
    const lotDIn = h('input', { type: 'number', class: 'lot-d', step: '0.01', min: '0.1', placeholder: '例: 18' });
    const lotDirIn = h('input', { type: 'number', class: 'lot-dir', step: '0.1', value: '90' });
    const frontPickBtn = h('button', { class: 'btn sm', onclick: () => armTool(toolMode === 'front' ? null : 'front') });
    const makeLotBtn = h('button', { class: 'btn', onclick: () => makeLotFromDims() }, 'この寸法で区画を作る');
    const dimsBox = h(
      'details',
      { class: 'lot-dims' },
      h('summary', null, '寸法で区画を作る（間口 × 奥行）'),
      h('p', { class: 'hint', style: 'margin:4px 0' }, '測量図・販売図面の寸法から長方形の敷地を作ります。向き = 間口（前面の道路に沿った辺）の方位で、真北から時計回り（0° = 南北、90° = 東西）。輪郭があればその重心、無ければピンを中心に置きます（作り直しは Ctrl+Z で戻せます）。'),
      h('div', { class: 'lot-dims-grid' }, field('間口 (m)', lotWIn), field('奥行 (m)', lotDIn), field('向き (°)', lotDirIn)),
      h('div', { class: 'btn-row', style: 'margin:4px 0' }, frontPickBtn, makeLotBtn),
    );
    side.appendChild(
      section(
        '敷地（任意）',
        h('p', { class: 'hint', style: 'margin:0 0 8px' }, '敷地の輪郭を描いておくと、日影図の 5m／10m ラインの基準になり、敷地内にある既存の建物（取り壊す家など）を周辺建物から自動で除外できます。「建物を置く」の「敷地の輪郭に合わせる」でも使います。地図は 22 まで拡大でき、角を細かく置けます（Shift で直前の辺に直角・平行）。'),
        areaOut,
        polyInfo,
        h('div', { class: 'btn-row' }, ...makePolyButtons()),
        h('div', { class: 'btn-row', style: 'margin:0 0 6px' }, undoBtn, redoBtn),
        edgeBox,
        dimsBox,
        footprintHint,
      ),
    );

    // 周辺環境
    const envBox = h('div');
    side.appendChild(section('周辺環境の読み込み', envBox));

    // 想定の家（未建築の隣家）
    const plannedSel = h(
      'select',
      {
        class: 'planned-preset',
        onchange: () => {
          if (isPlannedPresetId(plannedSel.value)) plannedPresetChoice = plannedSel.value;
          // 置いている途中なら、次に置く家の形（カーソルの下見）を変える。隣の区画・区画はクリックした時の形で置く
          if (toolMode === 'place') armTool('place', false);
          else refreshHint();
        },
      },
      PLANNED_PRESETS.map((pr) => h('option', { value: pr.id, selected: pr.id === plannedPresetChoice }, `${pr.label} ${pr.width}×${pr.depth} m・最高 ${pr.ridgeHeight} m`)),
    ) as HTMLSelectElement;
    const plannedPlaceBtn = h('button', { class: 'btn sm', onclick: () => armTool(toolMode === 'place' ? null : 'place') });
    const plannedEdgeBtn = h('button', { class: 'btn sm', onclick: () => armTool(toolMode === 'edge' ? null : 'edge') });
    const plannedLotBtn = h('button', { class: 'btn sm', onclick: () => armTool(toolMode === 'lot' ? null : 'lot') });
    const plannedRule = h('p', { class: 'hint', style: 'margin:4px 0' });
    const plannedList = h('div', { class: 'planned-list' });
    const plannedEnabledCb = h('input', { type: 'checkbox', class: 'planned-enabled', checked: study.plannedEnabled, onchange: () => setPlannedEnabled(plannedEnabledCb.checked) }) as HTMLInputElement;
    const plannedClearBtn = h(
      'button',
      {
        class: 'btn sm ghost',
        onclick: () => {
          const k = clearPlannedHouses();
          plannedLots.clear();
          if (k) toast(`想定の家 ${k} 棟を消しました`, 'ok');
          refreshPlanned();
        },
      },
      '想定の家をすべて消す',
    );
    side.appendChild(
      section(
        '想定の家（未建築の隣家）',
        h('p', { class: 'hint', style: 'margin:0 0 6px' }, '分譲地などで、隣の家がまだ建っていないときに「建った想定」で仮の家を置きます。置いた家は影・日照の解析・日影図に入り、注記とレポートに「想定」と出ます。地図で選んでドラッグで移動・R で回転、編集欄で寸法・高さ・屋根を直せます。'),
        field('置く家の形', plannedSel),
        h('div', { class: 'btn-row planned-tools', style: 'margin:4px 0' }, plannedPlaceBtn, plannedEdgeBtn, plannedLotBtn),
        plannedRule,
        plannedList,
        h('label', { class: 'check' }, plannedEnabledCb, '想定の建物を含める（影・解析）'),
        h('div', { class: 'btn-row', style: 'margin:2px 0 0' }, plannedClearBtn),
      ),
    );

    // プロジェクト
    const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files?.[0];
      fileIn.value = '';
      if (!f) return;
      const pm = progressModal('プロジェクトを開いています', false);
      pm.set(0.3, f.name);
      try {
        await loadProjectFile(f);
        fetchedThisSession = false;
        anchor = null;
        toast(`「${study.name}」を開きました`, 'ok');
        pm.close();
        await shell.go('place');
      } catch (e) {
        pm.close();
        toast(`プロジェクトを開けませんでした: ${errMsg(e)}`, 'error', 9000);
      }
    });
    side.appendChild(
      section(
        'プロジェクト',
        h(
          'div',
          { class: 'btn-row' },
          h('button', {
            class: 'btn',
            onclick: () => {
              try {
                downloadProject();
              } catch (e) {
                toast(`保存できませんでした: ${errMsg(e)}`, 'error', 8000);
              }
            },
          }, '💾 保存（JSON）'),
          h('button', { class: 'btn', onclick: () => fileIn.click() }, '📂 開く'),
          fileIn,
        ),
        h('p', { class: 'hint', style: 'margin:0' }, '場所・敷地・建物の 3D データ・配置に加えて、取得した周辺環境（地形・航空写真・周辺建物）も 1 つの JSON に同梱します。保存したファイルは、インターネットに接続できない場所でも開いて検討を続けられます。'),
        h(
          'button',
          {
            class: 'btn sm block',
            style: 'margin-top:10px',
            onclick: async () => {
              const pm = progressModal('デモのプロジェクトを開いています', false);
              try {
                // 同梱のデモ（世田谷区奥沢・地形/航空写真/周辺建物/サンプル住宅入り）。地図サーバーに接続できない環境でも 3D と解析を試せる
                await loadProjectFromUrl(new URL('demo/okusawa.json', document.baseURI).toString());
                pm.close();
                toast('デモのプロジェクトを開きました（世田谷区奥沢・サンプル住宅）', 'ok');
                await shell.go('model');
              } catch (e) {
                pm.close();
                toast(`デモを開けませんでした: ${errMsg(e)}`, 'error', 8000);
              }
            },
          },
          '▶ デモを開く（世田谷区奥沢・サンプル住宅・周辺環境入り）',
        ),
      ),
    );

    // ---- 表示の更新 ----
    /** 座標の欄: 編集中（どちらかの欄にフォーカス）でなければ今のピンの座標を示す。度分秒の行とコピーはいつも今のピン */
    const refreshCoords = () => {
      const f = study.frame;
      const editing = document.activeElement === latIn || document.activeElement === lonIn;
      if (!editing) {
        latIn.value = f ? fmtDeg(f.lat) : '';
        lonIn.value = f ? fmtDeg(f.lon) : '';
      }
      dmsOut.textContent = f ? `度分秒: ${formatDms(f.lat, 'lat')}　${formatDms(f.lon, 'lon')}` : 'ピンを置くと、ここに座標が表示されます';
      copyBtn.disabled = !f;
    };
    // ピンの移動・住所検索・プロジェクトの読込など frame が変わる経路はすべて refreshStatus を通るので、座標の欄もここで更新する
    const refreshStatus = () => {
      clear(status);
      const f = study.frame;
      status.appendChild(h('b', null, f ? f.address : '地図をクリックして建設地を指定してください'));
      if (f) {
        status.append(h('br'), `緯度 ${fmtDeg(f.lat)}　経度 ${fmtDeg(f.lon)}`);
        if (study.env.loaded && f.groundElev != null) status.append(h('br'), `地盤高 ${tpText(f.groundElev)}（出典: ${DEM_LABEL[study.grid?.source ?? ''] ?? study.grid?.source ?? '不明'}）`);
      }
      const a = siteArea();
      if (a != null) status.append(h('br'), `敷地面積 ${areaText(a)}`);
      refreshCoords();
      // スケールバーは左下の状態の表示の上に出す（重なって見えなくならないように）
      map?.setScaleBarOffset({ x: 14, y: 14 + (status.offsetHeight || 0) + 8 });
    };

    const refreshAttrib = () => {
      let a = '';
      try {
        a = map?.attribution ?? '';
      } catch {
        a = '';
      }
      attrib.textContent = a.includes('国土地理院') ? a : `${a ? a + '／' : ''}出典: 国土地理院`;
    };

    const hintText = (): string => {
      const mode = !!map?.polygonMode;
      if (toolMode === 'place') return `地図をクリックした所に想定の家（${plannedPreset(plannedPresetChoice).label}）を置きます。続けて置けます。Esc で終了`;
      if (toolMode === 'edge') return '敷地の輪郭の辺をクリックすると、その向こうに同じ形の区画（青の破線）と想定の家を置きます。Esc で終了';
      if (toolMode === 'lot') {
        const k = map?.lotPointCount ?? 0;
        return k >= 3
          ? `区画の頂点 ${k} 点。最初の点をクリックか Enter で閉じると、中に想定の家を置きます。右クリック／Backspace で 1 点戻す。Esc で終了`
          : '区画の角を順にクリックしてください（道路側の辺から描き始めると、その辺から 2 m 離して置きます）。Shift で直前の辺に直角・平行。Esc で終了';
      }
      if (toolMode === 'front') return map?.lineStarted ? '2 点目をクリックしてください（前面の道路に沿って）。Esc でやめる' : '前面の道路（間口の辺）に沿って 2 点をクリックすると、その向きを「向き」に入れます。Esc でやめる';
      if (pickOn) return '周辺建物の輪郭をクリックすると隠します（右の欄で選んだ隠し方・理由で。灰色の破線 = 計算から除外、青の破線 = 表示だけ隠した建物。もう一度クリックで戻します）。ピンは動きません。Esc で終了';
      if (map?.polygonEditMode)
        return '輪郭の編集: 頂点をドラッグで移動・クリックで選んで Delete（右クリック）で削除、辺の中点の「＋」で頂点を追加、面積の札をドラッグで全体を移動。Shift で直角・平行にそろえる。Ctrl+Z で元に戻す。Esc で終了';
      if (mode)
        return drawCount >= 3
          ? `頂点 ${drawCount} 点。最初の点をクリックするか「描き終える（完了）」で輪郭を閉じます。右クリック／Backspace で 1 点戻す。Shift で直前の辺に直角・平行`
          : '敷地の角を順にクリックしてください（3 点以上）。頂点はドラッグで動かせます。Shift で直前の辺に直角・平行。細かく描くときは拡大（22 まで）';
      if (selPlanned) return '想定の家: ドラッグで移動・R / Shift+R で 90° 回転・矢印キーで 0.1 m（Shift で 1 m）・Delete で削除。空いている所をクリックで選択を外します';
      if (!study.frame) return '地図をクリックすると建設地のピンを置けます。ドラッグで地図を動かし、ホイールで拡大・縮小';
      return 'ピンはドラッグで微調整できます。「航空写真」に切り替えると建物や敷地の形が見えます';
    };
    const refreshHint = () => {
      const t = hintText();
      if (hint.textContent !== t) hint.textContent = t;
    };

    const refreshPolyUI = () => {
      const mode = !!map?.polygonMode;
      const has = study.sitePolygon.length >= 3;
      const editing = !!map?.polygonEditMode;
      for (const b of polyButtons) {
        b.toggle.textContent = mode ? (drawCount >= 3 ? '✓ 描き終える（完了）' : '▭ 描いています…（やめる）') : has ? '▭ 敷地の輪郭を描き直す' : '▭ 敷地の輪郭を描く';
        b.toggle.classList.toggle('on', mode);
        b.toggle.classList.toggle('dark', mode);
        b.toggle.disabled = !map;
        b.clearBtn.disabled = !map || (!has && drawCount === 0);
        b.editBtn.textContent = editing ? '✓ 編集を終える（Esc）' : '✎ 輪郭を編集';
        b.editBtn.classList.toggle('on', editing);
        b.editBtn.classList.toggle('dark', editing);
        b.editBtn.disabled = !map || (!editing && !has);
      }
      refreshUndo();
      renderEdges();
      frontPickBtn.textContent = toolMode === 'front' ? (map?.lineStarted ? '2 点目をクリック…（Esc）' : '2 点をクリック…（Esc）') : '地図で前面の辺をクリック';
      frontPickBtn.classList.toggle('dark', toolMode === 'front');
      frontPickBtn.disabled = !map || !study.frame;
      makeLotBtn.disabled = !map || !study.frame;
      const a = siteArea();
      areaOut.style.display = a != null ? '' : 'none';
      if (a != null) areaOut.textContent = `敷地面積 ${areaText(a)}（${study.sitePolygon.length} 点の輪郭。地図上で計算した概算です）`;
      polyInfo.style.display = has ? 'none' : '';
      polyInfo.textContent = mode ? '地図上で敷地の角を順にクリックしてください。' : '敷地の輪郭はまだありません。描かなくても検討はできます（ただし日影図に敷地境界と 5m／10m ラインは描かれず、等時間日影線の到達距離は建物の輪郭から測ります）。';
      footprintHint.style.display = study.model ? '' : 'none';
      if (map) {
        try {
          // 建物の外形: 塗り = 軒先（全高さの凸包。航空写真に写るのはこれ）、濃い線 = 壁。外形が取れなければ足跡の矩形
          if (study.model) {
            ensurePlacedData();
            map.setFootprint(buildingEavesOutlineEN() ?? buildingFootprintEN(), buildingOutlineEN());
          } else map.setFootprint(null);
        } catch {
          /* 地図未実装 */
        }
      }
    };

    const refreshEnv = () => {
      clear(envBox);
      const f = study.frame;
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (offline) envBox.appendChild(h('div', { class: 'warn' }, 'オフラインです。保存済みのプロジェクトを開けば検討を続けられます'));
      if (study.env.loading) {
        envBox.appendChild(h('div', { class: 'info-box' }, '地形・航空写真・周辺建物を取得しています…'));
        return;
      }
      if (!study.env.loaded) {
        envBox.appendChild(h('p', { class: 'hint', style: 'margin:0 0 8px' }, f ? `ピンの位置を中心に、地形（標高）・航空写真・周辺建物（半径約 ${NEIGHBOR_RADIUS}m）を国土地理院・PLATEAU の公開データから自動で取得します。` : 'まず地図でピンを置いてください。'));
        envBox.appendChild(h('button', { class: 'btn primary block', disabled: !f || offline, onclick: () => void loadEnv() }, 'この場所で周辺環境を読み込む →'));
        return;
      }
      const saved = envIsFromSavedProject() && !fetchedThisSession;
      if (saved) envBox.appendChild(h('div', { class: 'ok-box' }, '周辺環境: 保存データを使用（プロジェクトに同梱されていた地形・航空写真・周辺建物）'));
      const rows = h('div', { class: 'env-status' });
      const g = study.grid;
      if (g) {
        const st = gridStats(g, f?.groundElev ?? 0, STATS_RADIUS);
        rows.append(h('span', { class: 'k' }, '地形'), h('span', null, DEM_LABEL[g.source] ?? g.source, h('br'), g.source === 'flat' ? '高低差は考慮されません' : `敷地周辺の高低差 ${signedM(st.relMin)} 〜 ${signedM(st.relMax)}`));
      } else rows.append(h('span', { class: 'k' }, '地形'), h('span', null, 'なし（平地として扱います）'));
      rows.append(h('span', { class: 'k' }, '航空写真'), h('span', null, study.aerial ? '取得（国土地理院 シームレス空中写真）' : 'なし'));
      // 想定の家は下の「想定の家」の欄で数える
      const vis = visibleNeighbors().filter((n) => !n.planned);
      const auto = vis.filter((n) => n.source !== 'manual');
      const manualCount = vis.length - auto.length;
      const tags = study.neighborSources.filter((s) => s !== 'manual').map((s) => h('span', { class: `src-tag ${SOURCE_TAG[s]?.cls ?? ''}` }, SOURCE_TAG[s]?.label ?? s));
      const hiddenList = hiddenNeighbors();
      const hiddenCount = hiddenList.length;
      const viewCount = hiddenList.filter((n) => n.hideMode === 'view').length;
      const hiddenText = hiddenCount ? `・隠した建物 ${hiddenCount}棟（計算から除外 ${hiddenCount - viewCount}・表示だけ ${viewCount}）` : null;
      const plannedCount = plannedHouses().length;
      const plannedText = plannedCount ? `・想定の家 ${plannedCount}棟${study.plannedEnabled ? '' : '（含めない）'}` : null;
      rows.append(h('span', { class: 'k' }, '周辺建物'), h('span', null, `${auto.length}棟`, ...tags, manualCount ? `（手動 ${manualCount}棟）` : null, hiddenText, plannedText));
      envBox.appendChild(rows);
      // 地図で建物を選んで隠す（取り壊す既存の家・もう無い建物・形の違う建物などを影と解析から外す）
      if (study.neighbors.length) {
        envBox.appendChild(
          h(
            'div',
            { class: 'btn-row', style: 'margin:4px 0' },
            h('button', { class: `btn sm${pickOn ? ' dark' : ''}`, onclick: () => setPick(!pickOn) }, pickOn ? '建物の輪郭をクリックで隠す／戻す（Esc で終了）' : '地図で建物を選んで隠す'),
            hiddenCount
              ? h(
                  'button',
                  {
                    class: 'btn sm ghost',
                    onclick: () => {
                      const k = restoreAllNeighbors();
                      if (k) toast(`隠した建物 ${k} 棟をすべて戻しました`, 'ok');
                    },
                  },
                  'すべて戻す',
                )
              : null,
          ),
        );
        // 地図のクリックで隠すときの隠し方・理由（選んだものは日照シミュレーションでも既定になる）
        if (pickOn) envBox.appendChild(hideOptionsControl({ remember: true, compact: true }).el);
        if (pickOn || hiddenCount)
          envBox.appendChild(
            h(
              'p',
              { class: 'hint', style: 'margin:0 0 6px' },
              '計算から除外した建物は灰色の破線で表示し、3D・影・日照の解析・日影図から外します。表示だけ隠した建物は青の破線で、3D には描きませんが影・解析には残します。日照シミュレーションの「周辺建物の修正」でも選んで隠す・戻す・隠し方と理由の変更ができます。',
            ),
          );
      }
      for (const n of study.neighborNotes) envBox.appendChild(h('div', { class: 'info-box' }, n));
      if (study.env.error) {
        for (const line of study.env.error.split('\n').filter(Boolean)) envBox.appendChild(h('div', { class: 'warn' }, line));
        envBox.appendChild(h('p', { class: 'hint', style: 'margin:0 0 6px' }, networkHint()));
      }
      envBox.appendChild(
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn', disabled: !f || offline, onclick: () => void loadEnv() }, study.env.error ? '再取得' : saved ? '最新を再取得' : '周辺環境を再読み込み'),
          study.model
            ? h('button', { class: 'btn primary', onclick: () => void shell.go('model') }, 'つぎへ: 建物 →')
            : h('button', { class: 'btn primary', onclick: () => void shell.go('model') }, 'つぎへ: 3D データを読み込む →'),
        ),
      );
    };

    const refreshRings = () => {
      if (!map) return;
      try {
        if (study.env.loaded) {
          // 想定の家は別に描く（setPlannedHouses）。建物を選んで隠すモードの対象にもしない
          map.setNeighborRings(
            effectiveNeighbors()
              .filter((n) => !n.planned)
              .map((n) => ({ id: n.id, ring: n.ring, hidden: !!n.hidden, viewOnly: !!n.hidden && n.hideMode === 'view' })),
          );
          map.setRadiusRing(NEIGHBOR_RADIUS);
        } else {
          map.setNeighborRings(null);
          map.setRadiusRing(null);
        }
      } catch {
        /* 地図未実装 */
      }
    };

    // ---- 敷地: 辺の長さ・取り消し・寸法で区画 ----
    const refreshUndo = () => {
      undoBtn.disabled = !map?.canUndo;
      redoBtn.disabled = !map?.canRedo;
    };

    /** 辺の長さの一覧（閉じた輪郭）。辺の数が同じなら入力中でない欄の値だけ直す（入力欄を移っても位置を失わない） */
    const renderEdges = () => {
      const poly = study.sitePolygon;
      if (poly.length < 3) {
        clear(edgeBox);
        edgeBox.style.display = 'none';
        return;
      }
      edgeBox.style.display = '';
      const lens = edgeLengthsM(poly, true);
      const perimeter = `周長 ${formatLength(lens.reduce((a, b) => a + b, 0))}・${poly.length} 点`;
      const inputs = [...edgeBox.querySelectorAll<HTMLInputElement>('input.edge-len')];
      if (inputs.length === lens.length) {
        inputs.forEach((inp, i) => {
          if (document.activeElement !== inp) inp.value = lens[i].toFixed(2);
        });
        const per = edgeBox.querySelector('.edge-perimeter');
        if (per) per.textContent = perimeter;
        return;
      }
      clear(edgeBox);
      const list = h('div', { class: 'edge-list' });
      lens.forEach((len, i) => {
        const inp = h('input', {
          type: 'number',
          class: 'edge-len',
          step: '0.01',
          min: '0.01',
          value: len.toFixed(2),
          'data-edge': String(i),
          onchange: () => {
            const v = parseFloat(inp.value);
            if (!(v > 0) || v > 10000 || !map?.setEdgeLength(i, v)) {
              toast('辺の長さは 0 より大きい m で入力してください', 'error');
              inp.value = (edgeLengthsM(study.sitePolygon, true)[i] ?? len).toFixed(2);
            }
          },
          onfocus: () => map?.setHighlightEdge(i),
          onblur: () => map?.setHighlightEdge(null),
        }) as HTMLInputElement;
        const lab = field(`辺 ${i + 1}`, inp);
        lab.classList.add('edge-field');
        lab.addEventListener('mouseenter', () => map?.setHighlightEdge(i));
        lab.addEventListener('mouseleave', () => {
          if (document.activeElement !== inp) map?.setHighlightEdge(null);
        });
        list.appendChild(lab);
      });
      edgeBox.append(
        h('div', { class: 'edge-head' }, h('span', { class: 'field-label' }, '辺の長さ (m)'), h('span', { class: 'edge-perimeter' }, perimeter)),
        list,
        h('p', { class: 'hint', style: 'margin:2px 0 6px' }, '辺 1 = 1 点目 → 2 点目（地図の「辺1」の札）。数値を変えると、その辺の終点が辺の向きに沿って動きます（ほかの頂点はそのまま）。'),
      );
    };

    /** 「寸法で区画を作る」: 間口 × 奥行・向きの長方形を、輪郭の重心（無ければピン）を中心に作る（取り消しできる） */
    const makeLotFromDims = () => {
      const w = parseFloat(lotWIn.value);
      const d = parseFloat(lotDIn.value);
      const dir = parseFloat(lotDirIn.value);
      if (!(w > 0 && w <= 1000) || !(d > 0 && d <= 1000)) {
        toast('間口・奥行を m で入力してください（0 より大きく 1000 m 以下）', 'error');
        return;
      }
      if (!Number.isFinite(dir)) {
        toast('向きを度で入力してください（真北から時計回り。0° = 南北、90° = 東西）', 'error');
        return;
      }
      const c = study.sitePolygon.length >= 3 ? polygonCentroid(study.sitePolygon) : study.frame;
      if (!c || !map) {
        toast('先に地図でピンを置いてください', 'error');
        return;
      }
      map.editPolygon(rectangleLot(c, w, d, norm360(dir)));
      refreshAll();
      toast(`間口 ${w.toFixed(2)} m × 奥行 ${d.toFixed(2)} m（${(w * d).toFixed(1)}㎡）の区画を作りました（Ctrl+Z で元に戻せます）`, 'ok');
    };

    // ---- 想定の家 ----
    /** 敷地の輪郭（ピンからの東・北 m。閉じていて面積があれば） */
    const siteEN = (): EN[] | null => {
      const f = study.frame;
      if (!f || study.sitePolygon.length < 3) return null;
      const pts = study.sitePolygon.map((p) => frameToLocal(f, p));
      return Math.abs(polygonArea(pts)) > 1e-6 ? pts : null;
    };
    const presetChoice = (): PlannedPresetId => (isPlannedPresetId(plannedSel.value) ? plannedSel.value : plannedPresetChoice);
    const findPlanned = (id: string | null): PlannedNeighbor | null => (id ? (plannedHouses().find((n) => n.id === id) ?? null) : null);
    const meanEN = (pts: EN[]): EN => pts.reduce((s, p) => ({ e: s.e + p.e / pts.length, n: s.n + p.n / pts.length }), { e: 0, n: 0 });
    /** 区画を家の中心からの相対で覚える */
    const rememberLot = (nb: PlannedNeighbor, lot: EN[]) => plannedLots.set(nb.id, lot.map((q) => ({ e: q.e - nb.planned.ce, n: q.n - nb.planned.cn })));

    const TOOL_GUIDE: Record<'place' | 'edge' | 'lot' | 'front', () => string> = {
      place: () => `地図をクリックした所に「${plannedPreset(plannedPresetChoice).label}」を置きます（続けて置けます・Esc で終了）。置いた家はクリックで選んでドラッグで移動、R で回転、Delete で削除できます`,
      edge: () => '敷地の輪郭の辺をクリックすると、その向こうに敷地と同じ形の区画（青の破線）を並べ、中に想定の家を置きます（続けて別の辺も・Esc で終了）',
      lot: () => '区画の角を順にクリックし、最初の点をクリックか Enter で閉じると、その中に想定の家を置きます。道路側の辺から描き始めてください（その辺から 2 m 離します）。Esc で終了',
      front: () => '前面の道路（間口の辺）に沿って 2 点をクリックすると、その向きを「向き」に入れます（Esc でやめる）',
    };

    /** 地図の道具を付ける／外す。guide = false なら案内のトーストを出さない（形を変えて付け直すとき） */
    const armTool = (mode: 'place' | 'edge' | 'lot' | 'front' | null, guide = true) => {
      if (!map) return;
      if (mode && !study.frame) {
        toast('先に地図でピンを置いてください', 'error');
        return;
      }
      if (mode === 'edge' && !siteEN()) {
        toast('先に敷地の輪郭を描いてください（隣の区画は敷地と同じ形で並べます）', 'error', 6000);
        return;
      }
      if (mode && selPlanned) selectPlanned(null);
      toolMode = mode;
      if (mode === 'place') {
        const rot = plannedRotationFor(siteEN(), study.model ? study.placement.headingDeg : null);
        const pr = plannedPreset(presetChoice());
        map.setTool({
          kind: 'point',
          onPick: (p) => placePlannedAt(p, rot),
          preview: (p) => {
            const f = study.frame;
            if (!f) return null;
            const q = frameToLocal(f, p);
            return plannedFootprint({ ce: q.e, cn: q.n, rotDeg: rot, width: pr.width, depth: pr.depth });
          },
        });
      } else if (mode === 'edge') map.setTool({ kind: 'edge', onPick: (i) => plannedFromEdge(i) });
      else if (mode === 'lot') map.setTool({ kind: 'lot', onPick: (poly) => plannedFromLot(poly) });
      else if (mode === 'front') map.setTool({ kind: 'line', onPick: (a, b) => frontFromLine(a, b) });
      else map.setTool(null);
      if (mode && guide) toast(TOOL_GUIDE[mode](), 'info', 8000);
      refreshAll();
    };

    const placePlannedAt = (p: LatLon, rot: number) => {
      const f = study.frame;
      if (!f) return;
      const q = frameToLocal(f, p);
      const preset = presetChoice();
      addPlannedHouse(houseFromPreset(preset, q.e, q.n, rot));
      toast(`想定の家（${plannedPreset(preset).label}）を置きました。続けてクリックで置けます（Esc で終了）`, 'ok');
    };

    const plannedFromEdge = (i: number) => {
      const site = siteEN();
      if (!site) {
        toast('先に敷地の輪郭を描いてください', 'error');
        return;
      }
      const r = neighborLotPlan(site, i, presetChoice());
      if (r === 'concave') {
        toast('この辺は敷地の凹んだ所にあるため、向こうに区画を並べられません。外周の辺をクリックしてください', 'error', 6000);
        return;
      }
      if (r === 'small' || r === 'invalid') {
        toast('区画が小さく、想定の家（3 m × 3 m 以上）が入りませんでした', 'error', 6000);
        return;
      }
      // 同じ区画に重ねて置かない
      const c = meanEN(r.lot);
      for (const n of plannedHouses()) {
        const rel = plannedLots.get(n.id);
        if (!rel) continue;
        const lc = meanEN(rel);
        if (Math.hypot(lc.e + n.planned.ce - c.e, lc.n + n.planned.cn - c.n) < 0.5) {
          toast('この区画には既に想定の家を置いています', 'info');
          return;
        }
      }
      const nb = addPlannedHouse(r.house);
      rememberLot(nb, r.lot);
      refreshPlanned();
      toast(`辺${i + 1} の向こうに区画（${Math.abs(polygonArea(r.lot)).toFixed(1)}㎡）と想定の家（${nb.planned.width.toFixed(1)}×${nb.planned.depth.toFixed(1)} m）を置きました`, 'ok');
    };

    const plannedFromLot = (poly: LatLon[]) => {
      const f = study.frame;
      if (!f) return;
      const lot = poly.map((p) => frameToLocal(f, p));
      const area = Math.abs(polygonArea(lot));
      if (!(area > 1)) {
        toast('区画の面積が小さすぎます。描き直してください', 'error');
        return;
      }
      const hse = houseInLot(lot, { preset: presetChoice(), frontEdgeIndex: 0 });
      if (!hse) {
        toast('区画が小さく、想定の家（3 m × 3 m 以上）が入りませんでした', 'error', 6000);
        return;
      }
      const nb = addPlannedHouse(hse);
      rememberLot(nb, lot);
      refreshPlanned();
      toast(`区画（${area.toFixed(1)}㎡）の中に想定の家を置きました。続けて次の区画を描けます（Esc で終了）`, 'ok');
    };

    const frontFromLine = (a: LatLon, b: LatLon) => {
      const brg = Math.round((bearingDeg(a, b) % 180) * 10) / 10;
      lotDirIn.value = String(brg);
      dimsBox.open = true;
      armTool(null);
      toast(`前面の向きを ${brg}° にしました（「この寸法で区画を作る」で作ります）`, 'ok');
    };

    const movePlanned = (id: string, dE: number, dN: number) => {
      const n = findPlanned(id);
      if (!n) return;
      // 区画は地面に残す（家だけ動かす）
      const rel = plannedLots.get(id);
      if (rel) plannedLots.set(id, rel.map((q) => ({ e: q.e - dE, n: q.n - dN })));
      if (!updatePlannedHouse(id, { ce: n.planned.ce + dE, cn: n.planned.cn + dN }) && rel) plannedLots.set(id, rel);
    };
    const rotatePlanned = (id: string, d: number) => {
      const n = findPlanned(id);
      if (n) updatePlannedHouse(id, { rotDeg: norm360(n.planned.rotDeg + d) });
    };
    const deletePlanned = (id: string) => {
      if (!removePlannedHouse(id)) return;
      plannedLots.delete(id);
      if (selPlanned === id) selectPlanned(null);
      toast('想定の家を削除しました', 'ok');
    };

    /** 想定の家を選ぶ（地図の強調と編集欄）。道具が付いている間は選べない */
    const selectPlanned = (id: string | null) => {
      map?.setPlannedSelection(id);
      selPlanned = map ? map.plannedSelection : null;
      buildPop();
      refreshPlannedPanel();
      refreshHint();
    };
    /** 一覧の「地図で選ぶ」: 道具・モードを外して選び、画面の外なら地図をその家へ */
    const focusPlanned = (id: string) => {
      if (toolMode) armTool(null);
      if (pickOn) setPick(false);
      if (map?.polygonMode) {
        if (drawCount >= 3) map.finishPolygon();
        map.setPolygonMode(false);
      }
      if (map?.polygonEditMode) map.setPolygonEditMode(false);
      selectPlanned(id);
      const n = findPlanned(id);
      const f = study.frame;
      if (map && n && f) {
        const s = map.screenOf(n.planned.ce, n.planned.cn);
        const w = root.clientWidth;
        const hgt = root.clientHeight;
        if (!s || s.x < 40 || s.y < 40 || s.x > w - 40 || s.y > hgt - 40) map.setCenter(frameFromLocal(f, n.planned.ce, n.planned.cn));
      }
      refreshAll();
    };

    // 編集欄（選んだ家の横に浮かべる）
    const popInputs: { inp: HTMLInputElement | HTMLSelectElement; get: (p: PlannedHouse) => string }[] = [];
    const fmt = (v: number, d = 2) => String(Math.round(v * 10 ** d) / 10 ** d);
    /** プリセットのままの形ならその id（寸法・高さ・屋根が同じ）。変えていれば '' */
    const presetOf = (p: PlannedHouse): string => {
      if (!p.preset) return '';
      const pr = plannedPreset(p.preset);
      const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6;
      return eq(pr.width, p.width) && eq(pr.depth, p.depth) && eq(pr.eaveHeight, p.eaveHeight) && eq(pr.ridgeHeight, p.ridgeHeight) && pr.roof === p.roof ? p.preset : '';
    };
    const syncPop = () => {
      const n = findPlanned(popFor);
      if (!n) return;
      for (const { inp, get } of popInputs) if (document.activeElement !== inp) inp.value = get(n.planned);
      const head = plannedPop.querySelector('.pp-name');
      if (head) head.textContent = n.label ?? '想定の家';
    };
    const buildPop = () => {
      clear(plannedPop);
      popInputs.length = 0;
      const n = findPlanned(selPlanned);
      popFor = n ? n.id : null;
      selRing = n ? n.ring.map((q) => ({ e: q.e, n: q.n })) : null;
      if (!n) {
        plannedPop.style.display = 'none';
        return;
      }
      const id = n.id;
      const cur = () => findPlanned(id)?.planned ?? null;
      const upd = (patch: Partial<Omit<PlannedHouse, 'id'>>) => {
        if (!updatePlannedHouse(id, patch)) syncPop();
      };
      const numField = (label: string, cls: string, step: string, get: (p: PlannedHouse) => string, set: (v: number, p: PlannedHouse) => void) => {
        const inp = h('input', {
          type: 'number',
          class: cls,
          step,
          onchange: () => {
            const v = parseFloat(inp.value);
            const p = cur();
            if (!p || !Number.isFinite(v)) {
              syncPop();
              return;
            }
            set(v, p);
          },
        }) as HTMLInputElement;
        popInputs.push({ inp, get });
        return field(label, inp);
      };
      const presetSel = h(
        'select',
        {
          class: 'pp-preset',
          onchange: () => {
            const v = presetSel.value;
            if (!isPlannedPresetId(v)) {
              syncPop();
              return;
            }
            const pr = plannedPreset(v);
            upd({ preset: v, width: pr.width, depth: pr.depth, eaveHeight: pr.eaveHeight, ridgeHeight: pr.ridgeHeight, roof: pr.roof });
          },
        },
        h('option', { value: '' }, '（寸法を変えた形）'),
        PLANNED_PRESETS.map((pr) => h('option', { value: pr.id }, pr.label)),
      ) as HTMLSelectElement;
      popInputs.push({ inp: presetSel, get: presetOf });
      const roofSel = h(
        'select',
        {
          class: 'pp-roof',
          onchange: () => {
            const p = cur();
            const r = roofSel.value;
            if (!p || !isRoofType(r)) return;
            const patch: Partial<PlannedHouse> = { roof: r as RoofType };
            // 陸屋根から勾配屋根に変えたときは棟を軒より上げる
            if (r !== 'flat' && p.ridgeHeight - p.eaveHeight < 0.5) patch.ridgeHeight = p.eaveHeight + (r === 'shed' ? 2 : 2.5);
            upd(patch);
          },
        },
        ROOF_TYPES.map((r) => h('option', { value: r }, ROOF_LABEL[r])),
      ) as HTMLSelectElement;
      popInputs.push({ inp: roofSel, get: (p) => p.roof });
      plannedPop.append(
        h(
          'div',
          { class: 'pp-head' },
          h('b', { class: 'pp-name' }, n.label ?? '想定の家'),
          h('span', { class: 'pp-tag' }, '想定・未建築'),
          h('button', { class: 'pp-close', title: '閉じる（Esc）', onclick: () => selectPlanned(null) }, '×'),
        ),
        field('プリセット', presetSel),
        h(
          'div',
          { class: 'pp-grid' },
          numField('幅 (m)', 'pp-w', '0.1', (p) => fmt(p.width), (v) => upd({ width: v })),
          numField('奥行 (m)', 'pp-d', '0.1', (p) => fmt(p.depth), (v) => upd({ depth: v })),
          numField('向き (°)', 'pp-rot', '1', (p) => fmt(p.rotDeg, 1), (v) => upd({ rotDeg: norm360(v) })),
          numField('軒高 (m)', 'pp-eave', '0.1', (p) => fmt(p.eaveHeight), (v, p) => upd(p.roof === 'flat' ? { eaveHeight: v, ridgeHeight: v } : { eaveHeight: v, ridgeHeight: Math.max(v, p.ridgeHeight) })),
          numField('最高高さ (m)', 'pp-ridge', '0.1', (p) => fmt(p.ridgeHeight), (v, p) => upd(p.roof === 'flat' ? { eaveHeight: v, ridgeHeight: v } : { ridgeHeight: v, eaveHeight: Math.min(p.eaveHeight, v) })),
          field('屋根', roofSel),
        ),
        h(
          'div',
          { class: 'btn-row', style: 'margin:6px 0 0' },
          h('button', { class: 'btn sm pp-rot90', title: '上から見て時計回りに 90°（R。Shift+R で反対回り）', onclick: () => rotatePlanned(id, 90) }, '↻ 90°'),
          h('button', { class: 'btn sm ghost pp-del', title: 'この想定の家を消す（Delete）', onclick: () => deletePlanned(id) }, '削除'),
        ),
        h('p', { class: 'hint', style: 'margin:4px 0 0' }, 'ドラッグで移動・R / Shift+R で 90° 回転・矢印キーで 0.1 m（Shift で 1 m）・Delete で削除'),
      );
      plannedPop.style.display = '';
      syncPop();
      positionPop();
    };
    /** 編集欄を選んだ家の横へ（地図を描くたびに） */
    const positionPop = () => {
      if (!map || !selRing || plannedPop.style.display === 'none') return;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const q of selRing) {
        const s = map.screenOf(q.e, q.n);
        if (!s) return;
        minX = Math.min(minX, s.x);
        maxX = Math.max(maxX, s.x);
        minY = Math.min(minY, s.y);
        maxY = Math.max(maxY, s.y);
      }
      const W = root.clientWidth;
      const H = root.clientHeight;
      const pw = plannedPop.offsetWidth || 250;
      const ph = plannedPop.offsetHeight || 280;
      let x = maxX + 16;
      if (x + pw > W - 64) x = minX - 16 - pw;
      x = Math.max(8, Math.min(W - pw - 64, x));
      let y = (minY + maxY) / 2 - ph / 2;
      y = Math.max(60, Math.min(H - ph - 48, y));
      const l = `${Math.round(x)}px`;
      const t = `${Math.round(y)}px`;
      if (plannedPop.style.left !== l) plannedPop.style.left = l;
      if (plannedPop.style.top !== t) plannedPop.style.top = t;
    };

    /** サイドの「想定の家」の欄（ボタンの状態・一覧・含めるか） */
    const refreshPlannedPanel = () => {
      const has = !!study.frame && !!map;
      const siteOk = !!siteEN();
      const btn = (b: HTMLButtonElement, armed: boolean, onText: string, offText: string, disabled: boolean) => {
        b.textContent = armed ? onText : offText;
        b.classList.toggle('dark', armed);
        b.disabled = disabled && !armed;
      };
      btn(plannedPlaceBtn, toolMode === 'place', '想定の家を置くのをやめる（Esc）', '＋ 想定の家を置く', !has);
      btn(plannedEdgeBtn, toolMode === 'edge', '辺をクリック…（Esc でやめる）', '隣の区画に想定の家', !has || !siteOk);
      btn(plannedLotBtn, toolMode === 'lot', '区画を描いています…（Esc でやめる）', '区画を描いて家を置く', !has);
      plannedEdgeBtn.title = siteOk ? '敷地の輪郭の辺をクリックすると、その向こうに同じ形の区画と想定の家を置きます' : '先に敷地の輪郭を描いてください';
      plannedRule.textContent =
        toolMode === 'edge'
          ? '隣の区画: クリックした辺の向こうに、敷地と同じ形・同じ大きさの区画を並べ（地図に青の破線）、中に家を置きます。家はクリックした境界と横の境界から 1 m、向かいの辺（道路側とみなします）から 2 m 離し、建ぺい率 50% 以内で北側に寄せます。'
          : toolMode === 'lot'
            ? '区画: 角を順にクリックし、最初の点をクリックか Enter で閉じます。最初に描いた辺を道路側とみなして 2 m、ほかの辺から 1 m 離し、建ぺい率 50% 以内で北側に寄せて置きます。'
            : toolMode === 'place'
              ? 'クリックした所を中心に置きます（敷地の輪郭があればその向きにそろえ、棟は東西寄り）。'
              : !study.frame
                ? 'まず地図でピンを置いてください。'
                : siteOk
                  ? '「隣の区画に想定の家」は敷地の辺をクリックして、隣に同じ形の区画を並べて家を置きます（分譲地向け）。'
                  : '「隣の区画に想定の家」は敷地の輪郭を描くと使えます。';
      if (plannedEnabledCb.checked !== study.plannedEnabled) plannedEnabledCb.checked = study.plannedEnabled;
      const list = plannedHouses();
      clear(plannedList);
      for (const n of list) {
        const p = n.planned;
        const pre = presetOf(p);
        const meta = `${pre ? plannedPreset(pre).label : '寸法を変えた形'}・${p.width.toFixed(1)}×${p.depth.toFixed(1)} m・最高 ${p.ridgeHeight.toFixed(1)} m${plannedLots.has(n.id) ? '・区画つき' : ''}${n.hidden ? '・隠しています' : ''}`;
        plannedList.appendChild(
          h(
            'div',
            { class: `nb-row planned-row${n.id === selPlanned ? ' sel' : ''}`, 'data-id': n.id },
            h('div', null, h('b', null, n.label ?? '想定の家'), h('span', { class: 'meta' }, meta)),
            h(
              'div',
              { class: 'btn-row', style: 'margin:4px 0 0' },
              h('button', { class: 'btn sm', onclick: () => focusPlanned(n.id) }, n.id === selPlanned ? '選んでいます' : '地図で選ぶ'),
              h('button', { class: 'btn sm ghost', onclick: () => deletePlanned(n.id) }, '削除'),
            ),
          ),
        );
      }
      if (!list.length) plannedList.appendChild(h('p', { class: 'hint', style: 'margin:2px 0' }, 'まだ置いていません。'));
      plannedClearBtn.style.display = list.length ? '' : 'none';
    };

    /** 想定の家を地図に（足元・屋根の線・区画）と、サイドの欄・編集欄を今の状態に */
    const refreshPlanned = () => {
      const list = plannedHouses();
      for (const id of [...plannedLots.keys()]) if (!list.some((n) => n.id === id)) plannedLots.delete(id);
      if (map) {
        try {
          // 含めない設定・計算から除外して隠した家は薄い破線（「想定（含めない）」）
          map.setPlannedHouses(
            list.map((n): MapPlannedHouse => ({ id: n.id, ring: n.ring, lines: plannedRoofLines(n.planned), inactive: !study.plannedEnabled || (!!n.hidden && n.hideMode !== 'view') })),
          );
          map.setLotOutlines(list.filter((n) => plannedLots.has(n.id)).map((n) => plannedLots.get(n.id)!.map((q) => ({ e: q.e + n.planned.ce, n: q.n + n.planned.cn }))));
        } catch {
          /* 地図未実装 */
        }
      }
      if (selPlanned && !list.some((n) => n.id === selPlanned)) selPlanned = null;
      if (map && map.plannedSelection !== selPlanned) selPlanned = map.plannedSelection;
      if (popFor !== selPlanned) buildPop();
      else {
        const n = findPlanned(selPlanned);
        selRing = n ? n.ring.map((q) => ({ e: q.e, n: q.n })) : null;
        syncPop();
        positionPop();
      }
      refreshPlannedPanel();
      refreshHint();
    };

    /** ズームの表示（今のズーム・18 より先の案内・ボタンの上限） */
    const refreshZoomUI = () => {
      if (!map) return;
      const z = map.zoom;
      const txt = Math.abs(z - Math.round(z)) < 0.05 ? String(Math.round(z)) : z.toFixed(1);
      if (zoomLevel.textContent !== txt) zoomLevel.textContent = txt;
      const disp = map.overzoomed ? '' : 'none';
      if (overzoomNote.style.display !== disp) overzoomNote.style.display = disp;
      zoomInBtn.disabled = z >= MAX_ZOOM - 1e-6;
      zoomOutBtn.disabled = z <= MIN_ZOOM + 1e-6;
    };
    /** 地図を描くたびに（編集欄の位置・ズームの表示・描いている区画の点数の案内） */
    const onMapDraw = () => {
      positionPop();
      refreshZoomUI();
      if (toolMode === 'lot' || toolMode === 'front') {
        refreshHint();
        if (toolMode === 'front') {
          const t = map?.lineStarted ? '2 点目をクリック…（Esc）' : '2 点をクリック…（Esc）';
          if (frontPickBtn.textContent !== t) frontPickBtn.textContent = t;
        }
      }
    };

    const refreshAll = () => {
      refreshStatus();
      refreshPolyUI();
      refreshEnv();
      refreshPlannedPanel();
      refreshHint();
      refreshAttrib();
    };

    /** 「地図で建物を選んで隠す」の切り替え（輪郭を描くモードとは同時に使わない。MapPicker 側でも排他） */
    const setPick = (onOff: boolean) => {
      if (!map) return;
      if (onOff && map.polygonMode) {
        if (drawCount >= 3) map.finishPolygon();
        map.setPolygonMode(false);
      }
      pickOn = onOff;
      map.setNeighborPickMode(onOff);
      if (onOff) toast('地図の建物の輪郭をクリックすると隠します。隠した建物（灰色の破線）をもう一度クリックすると戻します。Esc で終了', 'info', 8000);
      refreshAll();
    };
    /** 選ぶモードで輪郭をクリックした: その建物を隠す／戻す */
    const toggleNeighborFromMap = (id: string | null) => {
      if (!id) {
        toast('周辺建物の輪郭の内側をクリックしてください（建物の無い所ではピンは動きません）');
        return;
      }
      const n = effectiveNeighbors().find((x) => x.id === id);
      if (!n) return;
      const name = n.label ?? '建物';
      if (n.hidden) {
        setNeighborsHidden([id], false);
        toast(`${name}を戻しました`, 'ok');
      } else {
        // 直近に選んだ隠し方・理由で（地図の下の欄・日照シミュレーションの操作バーと共通）
        const info = getHideDefaults();
        setNeighborsHidden([id], true, info);
        toast(hideToastText(name, info.mode, 'map'), 'ok');
      }
    };

    const loadEnv = async () => {
      if (!study.frame) {
        toast('先に地図でピンを置いてください', 'error');
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        toast('オフラインです。保存済みのプロジェクトを開けば検討を続けられます', 'error', 6000);
        return;
      }
      const pm = progressModal('地形・航空写真・周辺建物を取得しています', false);
      let report: Awaited<ReturnType<typeof loadEnvironment>>;
      try {
        report = await loadEnvironment({ onProgress: (msg, ratio) => pm.set(ratio, msg) });
        envOrigin = study.frame ? { lat: study.frame.lat, lon: study.frame.lon } : null;
      } catch (e) {
        study.env.loading = false;
        emit('env');
        toast(`周辺環境を取得できませんでした: ${errMsg(e)}`, 'error', 9000);
        refreshAll();
        return;
      } finally {
        pm.close();
      }
      fetchedThisSession = true;
      markEnvFetched();
      saveRecent();
      if (map) {
        try {
          study.results.mapUrl = map.snapshot();
        } catch {
          /* 画像化できない */
        }
      }
      refreshRings();
      refreshAll();
      if (report.errors.length) toast(`一部のデータを取得できませんでした（${report.errors.length} 件）。詳細はサイドパネルをご覧ください`, 'error', 7000);
      else toast('周辺環境を読み込みました', 'ok');
      if (!study.model) {
        toast('つぎに、建物の 3D データを読み込みます', 'info');
        void shell.go('model');
      }
    };

    // ---- 地図を作る（表示の更新関数を定義した後に。コンストラクタ内で onView が呼ばれても良いように） ----
    const recent = readRecent();
    const initial: LatLon = study.frame ?? (recent?.frame && Number.isFinite(recent.frame.lat) && Number.isFinite(recent.frame.lon) ? recent.frame : TOKYO);
    try {
      map = new MapPicker(root, {
        initial: { lat: initial.lat, lon: initial.lon },
        zoom: study.frame ? 17 : 16,
        layer: 'std',
        onPin: (p) => {
          pinFromMap(p);
          refreshAll();
        },
        onPolygonChange: (poly, closed) => {
          applyPolygon(poly, closed);
          refreshAll();
        },
        onView: () => refreshAttrib(),
        onPolygonModeChange: () => {
          drawCount = 0;
          refreshAll();
        },
        onEditModeChange: () => refreshAll(),
        onToolChange: (kind) => {
          if (!kind) toolMode = null;
          refreshAll();
        },
        onHistoryChange: () => refreshUndo(),
        onNotice: (msg) => toast(msg, 'info'),
        onDraw: () => onMapDraw(),
        onNeighborClick: (id) => toggleNeighborFromMap(id),
        onNeighborPickModeChange: (onOff) => {
          pickOn = onOff;
          refreshAll();
        },
        onPlannedSelect: (id) => {
          selPlanned = id;
          buildPop();
          refreshPlannedPanel();
          refreshHint();
        },
        onPlannedMove: (id, dE, dN) => movePlanned(id, dE, dN),
        onPlannedRotate: (id, d) => rotatePlanned(id, d),
        onPlannedDelete: (id) => deletePlanned(id),
        // 地図サーバー（国土地理院）に接続できない環境（社内の制限・オフライン・外部通信を遮断するホスティング）では
        // 地図が灰色のままになる。原因と回避策（同梱デモ／制限のない環境で開く）を地図の上に示す
        onTilesUnavailable: () => {
          if (offlineNote) return;
          offlineNote = h(
            'div',
            { class: 'warn map-offline-note' },
            h('b', null, navigator.onLine ? '地図サーバー（国土地理院）に接続できません' : 'インターネットに接続されていません'),
            h(
              'div',
              { style: 'margin-top:4px' },
              navigator.onLine
                ? 'この環境では外部サーバーへの通信が制限されているため、地図・住所検索・周辺環境（地形・周辺建物）を取得できません。サイドの「▶ デモを開く」で同梱のデモを試すか、制限のないパソコン（start-sun.bat）や公開版の URL でこのページを開いてください。保存済みのプロジェクト（JSON）は周辺環境ごと開けます。'
                : '接続が戻ると自動で再読み込みします。保存済みのプロジェクト（JSON）や「▶ デモを開く」はオフラインでも開けます。',
            ),
          );
          root.appendChild(offlineNote);
        },
        onTilesAvailable: () => {
          offlineNote?.remove();
          offlineNote = null;
        },
      });
    } catch (e) {
      map = null;
      root.appendChild(h('div', { class: 'warn', style: 'position:absolute;left:14px;top:60px;z-index:3;max-width:420px' }, `地図を表示できませんでした: ${errMsg(e)}`));
    }

    // 自動テスト・不具合の調査用（window.study と同じ扱い）
    (window as unknown as { placeMap?: MapPicker | null }).placeMap = map;

    // ---- 初期状態を地図へ ----
    if (map) {
      try {
        if (study.frame) map.setPin(study.frame, true);
        if (study.sitePolygon.length >= 3) map.setPolygon(study.sitePolygon);
      } catch {
        /* 地図未実装 */
      }
      refreshRings();
    }
    refreshPlanned();
    refreshAll();
    refreshZoomUI();

    // ---- 他所からの変更に追従 ----
    disposers.push(
      on('env', () => {
        // 周辺環境を捨てた（ピンを大きく動かした）ら、建物を選ぶモードも終える（選ぶ輪郭が無い）
        if (pickOn && !study.env.loaded) setPick(false);
        refreshEnv();
        refreshStatus();
        refreshRings();
      }),
      on('frame', () => {
        refreshStatus();
        // 想定の家・区画はピンからの東・北で描くので、ピンが動いたら描き直す
        refreshPlanned();
      }),
      // 隠す／戻す・手動の隣家の追加・想定の家の追加／変更／削除など: 地図の輪郭（隠した建物は破線）と棟数を更新
      on('neighbors', () => {
        refreshRings();
        refreshEnv();
        refreshPlanned();
      }),
      on('site', () => {
        refreshPolyUI();
        // 敷地の輪郭が無くなったら「隣の区画」は使えない
        if (toolMode === 'edge' && !siteEN()) armTool(null);
        else refreshPlannedPanel();
      }),
      on('model', refreshPolyUI),
      // 位置合わせ・ピンの移動で建物の外形が変わったら地図の足跡も追従
      on('placement', refreshPolyUI),
    );
    const onLine = () => refreshEnv();
    window.addEventListener('online', onLine);
    window.addEventListener('offline', onLine);
    disposers.push(() => {
      window.removeEventListener('online', onLine);
      window.removeEventListener('offline', onLine);
    });
  },
};
