/**
 * プロジェクトの保存／読込（JSON。3D データと周辺環境を同梱）と、直近の設定の自動保存（localStorage）
 *
 * 保存形式は types.ts の ProjectJson。
 *  - 3D データ: 元ファイルを base64 で同梱（40MB まで。超えると省略し、開いたときに再読み込みを促す）
 *  - 周辺環境 (env): 標高格子は cm 単位の Int16 を base64 に（無効値 -32768）。Int16 の範囲（±327 m）に収めるため、
 *    値は「ピン位置の地盤高（frame.groundElev を整数 m に丸めたもの）からの相対値」で保存し、読込時に同じ基準を足す。
 *    航空写真は JPEG dataURL（長辺 2048px・品質 0.8）、周辺建物は自動取得分のみ（手動は manualNeighbors）、遠方の地平線は number[]。
 *    JSON 全体が約 60MB を超えそうなときは env を省略する（開いたときに再取得）。
 *  - localStorage 'sunstudy.recent': 直近の場所・敷地・配置・名前（3D データは含まない）。失敗しても何もしない。
 */
import { download, toast } from '../app/dom';
import { base64ToArrayBuffer, importModelFile } from './importModel';
import { resetPlaced } from './building';
import { emit, study } from './state';
import { sampleHeight } from './terrain';
import { DEFAULT_PLACEMENT, UNIT_LABEL } from './types';
import type { AerialImage, GeoFrame, HeightGrid, LatLon, LengthUnit, ModelPlacement, Neighbor, PlacementAlignment, ProjectEnv, ProjectJson } from './types';

/** 同梱する 3D データの上限 (bytes) */
const MODEL_LIMIT = 40 * 1024 * 1024;
/** JSON 全体の目安の上限 (文字数 ≈ bytes) */
const JSON_LIMIT = 60 * 1024 * 1024;
const RECENT_KEY = 'sunstudy.recent';
/** 標高格子の無効値（Int16） */
const INVALID_I16 = -32768;
/** 同梱する航空写真の長辺 (px) */
const AERIAL_MAX_PX = 2048;

/** 周辺環境がプロジェクトの保存データから復元されたもの（この起動で取得していない）か */
let envFromProject = false;

/** 周辺環境が「保存データの復元」か（場所のステップで「保存データを使用」と表示する） */
export function envIsFromSavedProject(): boolean {
  return envFromProject;
}

/** 周辺環境をこの起動で取得（または破棄）したときに呼ぶ */
export function markEnvFetched(): void {
  envFromProject = false;
}

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

/** 3 の倍数で約 1MB。連結しても境界でパディングが入らない */
const B64_CHUNK = 1048575;

/** バイト列 → base64（約 1MB ごとに分けて変換し、巨大な一時文字列を避ける） */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    const sub = bytes.subarray(i, Math.min(bytes.length, i + B64_CHUNK));
    let bin = '';
    for (let j = 0; j < sub.length; j += 0x8000) bin += String.fromCharCode(...sub.subarray(j, Math.min(sub.length, j + 0x8000)));
    parts.push(btoa(bin));
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// 周辺環境の変換
// ---------------------------------------------------------------------------

/** 標高格子 → Int16 (cm, 基準 base m からの相対) の base64 */
function encodeGrid(g: HeightGrid, base: number): NonNullable<ProjectEnv['grid']> {
  const n = g.nx * g.ny;
  const i16 = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = i < g.values.length ? g.values[i] : NaN;
    if (v !== v) {
      i16[i] = INVALID_I16;
      continue;
    }
    const cm = Math.round((v - base) * 100);
    i16[i] = cm < -32767 ? -32767 : cm > 32767 ? 32767 : cm;
  }
  return { west: g.west, east: g.east, south: g.south, north: g.north, nx: g.nx, ny: g.ny, source: g.source, resolution: g.resolution, valuesB64: bytesToBase64(new Uint8Array(i16.buffer)) };
}

/** base64 の Int16 → 標高格子（Float32、無効値は NaN） */
function decodeGrid(g: NonNullable<ProjectEnv['grid']>, base: number): HeightGrid {
  const nx = Math.max(1, Math.floor(Number(g.nx)));
  const ny = Math.max(1, Math.floor(Number(g.ny)));
  const buf = base64ToArrayBuffer(g.valuesB64);
  const i16 = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
  const values = new Float32Array(nx * ny);
  for (let i = 0; i < values.length; i++) {
    const c = i < i16.length ? i16[i] : INVALID_I16;
    values[i] = c === INVALID_I16 ? NaN : c / 100 + base;
  }
  return { west: +g.west, east: +g.east, south: +g.south, north: +g.north, nx, ny, values, source: String(g.source ?? 'dem10b'), resolution: Number.isFinite(+g.resolution) ? +g.resolution : 10 };
}

/** 航空写真 → JPEG dataURL（長辺 2048px 以下）。描けないとき（汚染された canvas など）は null */
function encodeAerial(a: AerialImage): ProjectEnv['aerial'] {
  try {
    const src = a.canvas;
    const k = Math.min(1, AERIAL_MAX_PX / Math.max(1, src.width, src.height));
    let c: HTMLCanvasElement = src;
    if (k < 1) {
      c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(src.width * k));
      c.height = Math.max(1, Math.round(src.height * k));
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(src, 0, 0, c.width, c.height);
    }
    return { dataUrl: c.toDataURL('image/jpeg', 0.8), west: a.west, east: a.east, south: a.south, north: a.north, attribution: a.attribution };
  } catch {
    return null;
  }
}

/** JPEG dataURL → 航空写真（Image を canvas に描く。非同期） */
async function decodeAerial(a: NonNullable<ProjectEnv['aerial']>): Promise<AerialImage | null> {
  try {
    const img = new Image();
    img.src = a.dataUrl;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, img.naturalWidth);
    canvas.height = Math.max(1, img.naturalHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return { canvas, west: +a.west, east: +a.east, south: +a.south, north: +a.north, attribution: String(a.attribution ?? '出典: 国土地理院') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

const isLatLon = (p: unknown): p is LatLon => !!p && typeof p === 'object' && Number.isFinite((p as LatLon).lat) && Number.isFinite((p as LatLon).lon);
const isEN = (p: unknown): p is { e: number; n: number } => !!p && typeof p === 'object' && Number.isFinite((p as { e: number }).e) && Number.isFinite((p as { n: number }).n);

/** 保存データの位置合わせの記録を検査して整える（無い・壊れている部分は捨てる）。古いデータには無い */
function sanitizeAlignment(a: unknown): PlacementAlignment | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const x = a as Record<string, unknown>;
  const out: PlacementAlignment = { at: typeof x.at === 'string' ? x.at : '' };
  if (x.kind === 'twoPoint' || x.kind === 'siteFit' || x.kind === 'orient') out.kind = x.kind;
  if (Array.isArray(x.pairs)) {
    const pairs = x.pairs
      .filter((q): q is { local: { e: number; n: number }; target: LatLon } => !!q && typeof q === 'object' && isEN((q as { local: unknown }).local) && isLatLon((q as { target: unknown }).target))
      .map((q) => ({ local: { e: +q.local.e, n: +q.local.n }, target: { lat: +q.target.lat, lon: +q.target.lon } }));
    if (pairs.length) out.pairs = pairs;
  }
  for (const k of ['unitScaleM', 'rmsM', 'scaleRatio'] as const) if (Number.isFinite(x[k] as number)) out[k] = x[k] as number;
  if (typeof x.mirror === 'boolean') out.mirror = x.mirror;
  if (x.upAxis === 'z' || x.upAxis === 'y') out.upAxis = x.upAxis;
  if (isLatLon(x.pivotLatLon)) out.pivotLatLon = { lat: +x.pivotLatLon.lat, lon: +x.pivotLatLon.lon };
  // 2 点合わせなのに対応点が無ければ、種類は外して pivot の記録だけ残す
  if (out.kind === 'twoPoint' && !out.pairs) delete out.kind;
  return out;
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const LENGTH_UNITS = Object.keys(UNIT_LABEL) as LengthUnit[];

/**
 * 保存データの配置を今の形に（新しい任意項目が無くても既定値で埋める）。
 * 手で編集した・壊れた JSON や localStorage から文字列・NaN・未知の単位が入ると pivot の行列が NaN になって建物が消えるので、
 * 数値は有限値だけ、列挙は既知の値だけを受け取り、それ以外は既定値にする
 */
export function sanitizePlacement(pl: Partial<ModelPlacement> | undefined | null): ModelPlacement {
  const p: Partial<Record<keyof ModelPlacement, unknown>> = pl && typeof pl === 'object' ? (pl as Partial<Record<keyof ModelPlacement, unknown>>) : {};
  const num = (v: unknown, d: number) => (isFiniteNum(v) ? v : d);
  const D = DEFAULT_PLACEMENT;
  const out: ModelPlacement = {
    unit: LENGTH_UNITS.includes(p.unit as LengthUnit) ? (p.unit as LengthUnit) : D.unit,
    customScale: isFiniteNum(p.customScale) && p.customScale > 0 ? p.customScale : D.customScale,
    upAxis: p.upAxis === 'z' || p.upAxis === 'y' ? p.upAxis : D.upAxis,
    headingDeg: num(p.headingDeg, D.headingDeg),
    offsetE: num(p.offsetE, D.offsetE),
    offsetN: num(p.offsetN, D.offsetN),
    baseY: num(p.baseY, D.baseY),
    appearance: p.appearance === 'white' || p.appearance === 'original' ? p.appearance : D.appearance,
    mirror: p.mirror === true,
    hiddenObjects: Array.isArray(p.hiddenObjects) ? (p.hiddenObjects as unknown[]).filter((s): s is string => typeof s === 'string') : [],
  };
  const al = sanitizeAlignment(p.alignment);
  if (al) out.alignment = al;
  return out;
}

function buildProject(notes: string[]): ProjectJson {
  const m = study.model;
  let model: ProjectJson['model'] = null;
  if (m) {
    if (m.data.byteLength > MODEL_LIMIT) notes.push(`3D データ（${(m.data.byteLength / 1048576).toFixed(0)}MB）は 40MB を超えるため同梱しません。開いたときに同じファイルを再度読み込んでください`);
    else model = { name: m.name, format: m.format, base64: bytesToBase64(new Uint8Array(m.data)) };
  }
  const json: ProjectJson = {
    version: 1,
    app: 'sunstudy',
    savedAt: new Date().toISOString(),
    name: study.name,
    customer: study.customer,
    company: study.company,
    frame: study.frame ? { ...study.frame } : null,
    sitePolygon: study.sitePolygon.filter(isLatLon).map((p) => ({ lat: p.lat, lon: p.lon })),
    placement: { ...study.placement, hiddenObjects: [...(study.placement.hiddenObjects ?? [])] },
    model,
    manualNeighbors: study.neighbors.filter((n) => n.source === 'manual').map((n) => ({ ...n, ring: n.ring.map((q) => ({ e: q.e, n: q.n })) })),
    neighborOverrides: { ...study.neighborOverrides },
    points: JSON.parse(JSON.stringify(study.points)) as ProjectJson['points'],
  };
  const autoNeighbors = study.neighbors.filter((n) => n.source !== 'manual');
  if (study.env.loaded && (study.grid || study.aerial || autoNeighbors.length)) {
    const base = Math.round(study.frame?.groundElev ?? 0);
    const env: ProjectEnv = {
      fetchedAt: json.savedAt,
      grid: study.grid ? encodeGrid(study.grid, base) : null,
      aerial: study.aerial ? encodeAerial(study.aerial) : null,
      neighbors: autoNeighbors.map((n) => ({ ...n, ring: n.ring.map((q) => ({ e: q.e, n: q.n })) })),
      neighborSources: [...study.neighborSources],
      neighborNotes: [...study.neighborNotes],
      horizon: study.horizon ? { elevDeg: Array.from(study.horizon.elevDeg), source: study.horizon.source, radiusKm: study.horizon.radiusKm } : null,
    };
    const approx = (model?.base64.length ?? 0) + (env.grid?.valuesB64.length ?? 0) + (env.aerial?.dataUrl.length ?? 0) + JSON.stringify(env.neighbors).length + 8000;
    if (approx > JSON_LIMIT) notes.push('周辺環境（地形・航空写真・周辺建物）はファイルが大きくなりすぎるため同梱しません。開いたときに「周辺環境を読み込む」で再取得してください');
    else json.env = env;
  }
  return json;
}

/** 現在の状態を JSON に（3D データは 40MB までなら同梱） */
export function serializeProject(): ProjectJson {
  return buildProject([]);
}

/** ファイル名に使えない文字を置き換える */
function safeFileName(s: string): string {
  const t = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return t || 'プロジェクト';
}

/** ファイルに保存（ダウンロード） */
export function downloadProject(): void {
  const notes: string[] = [];
  const json = buildProject(notes);
  const text = JSON.stringify(json);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  download(url, `${safeFileName(study.name)}_日照検討.json`);
  // ダウンロードの開始を待ってから解放
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  for (const n of notes) toast(n, 'info', 9000);
  toast(`プロジェクトを保存しました（${(text.length / 1048576).toFixed(1)} MB）`, 'ok');
}

// ---------------------------------------------------------------------------
// 読込
// ---------------------------------------------------------------------------

function isProjectJson(p: unknown): p is ProjectJson {
  return !!p && typeof p === 'object' && (p as ProjectJson).app === 'sunstudy';
}

/**
 * JSON を状態に反映（3D データ・周辺環境の復元を含む）。
 * イベント 'frame' 'site' 'model' 'placement' 'neighbors' 'points' 'project' 'env' を発火
 */
export async function applyProject(p: ProjectJson): Promise<void> {
  if (!isProjectJson(p)) throw new Error('日照シミュレーションのプロジェクトファイルではありません');
  study.name = typeof p.name === 'string' && p.name.trim() ? p.name : study.name;
  study.customer = typeof p.customer === 'string' ? p.customer : '';
  study.company = typeof p.company === 'string' ? p.company : '';
  study.frame = isLatLon(p.frame)
    ? ({ lat: +p.frame.lat, lon: +p.frame.lon, address: typeof p.frame.address === 'string' ? p.frame.address : '', groundElev: Number.isFinite(p.frame.groundElev as number) ? (p.frame.groundElev as number) : null } satisfies GeoFrame)
    : null;
  study.sitePolygon = Array.isArray(p.sitePolygon) ? p.sitePolygon.filter(isLatLon).map((q) => ({ lat: +q.lat, lon: +q.lon })) : [];
  study.placement = sanitizePlacement(p.placement as Partial<ModelPlacement> | undefined);
  study.neighborOverrides = p.neighborOverrides && typeof p.neighborOverrides === 'object' ? { ...p.neighborOverrides } : {};
  // 測定点は最後に入れる（下の 'placement' などの発火で古い結果を捨てる処理が走り、復元した結果まで消えないように）
  const points = Array.isArray(p.points) ? p.points : [];
  study.points = [];
  study.results = { images: [] };

  // 周辺環境
  const manual: Neighbor[] = Array.isArray(p.manualNeighbors) ? p.manualNeighbors.filter((n) => n && Array.isArray(n.ring)) : [];
  let auto: Neighbor[] = [];
  study.grid = null;
  study.aerial = null;
  study.horizon = null;
  study.neighborSources = [];
  study.neighborNotes = [];
  envFromProject = false;
  const env = p.env;
  if (env && typeof env === 'object') {
    const base = Math.round(study.frame?.groundElev ?? 0);
    if (env.grid && typeof env.grid.valuesB64 === 'string') {
      try {
        study.grid = decodeGrid(env.grid, base);
      } catch (e) {
        console.warn('標高格子を復元できませんでした', e);
      }
    }
    if (env.aerial && typeof env.aerial.dataUrl === 'string') study.aerial = await decodeAerial(env.aerial);
    auto = Array.isArray(env.neighbors) ? env.neighbors.filter((n) => n && Array.isArray(n.ring)) : [];
    study.neighborSources = Array.isArray(env.neighborSources) ? [...env.neighborSources] : [];
    study.neighborNotes = Array.isArray(env.neighborNotes) ? env.neighborNotes.filter((s) => typeof s === 'string') : [];
    if (env.horizon && Array.isArray(env.horizon.elevDeg) && env.horizon.elevDeg.length === 360) {
      study.horizon = { elevDeg: Float32Array.from(env.horizon.elevDeg, (v) => (Number.isFinite(v) ? v : 0)), source: String(env.horizon.source ?? 'dem10b'), radiusKm: Number.isFinite(env.horizon.radiusKm) ? env.horizon.radiusKm : 10 };
    }
    // ピン位置の地盤高が無ければ格子から
    if (study.frame && study.grid && study.frame.groundElev == null) {
      const h0 = sampleHeight(study.grid, 0, 0);
      study.frame.groundElev = Number.isFinite(h0) ? h0 : 0;
    }
    study.env = { loaded: true, loading: false, error: null, attribution: study.aerial?.attribution ?? '出典: 国土地理院' };
    envFromProject = true;
  } else {
    study.env = { loaded: false, loading: false, error: null, attribution: '' };
  }
  study.neighbors = [...manual, ...auto];

  // 3D データ
  // 旧 model / placement に束縛された配置済み建物を捨てる（地図の足跡が古い建物のまま残らないように）
  resetPlaced();
  study.model = null;
  if (p.model && typeof p.model.base64 === 'string' && p.model.base64.length) {
    try {
      study.model = await importModelFile({ name: String(p.model.name || `model.${p.model.format || '3ds'}`), data: base64ToArrayBuffer(p.model.base64) });
    } catch (e) {
      toast(`同梱の 3D データを読み込めませんでした: ${e instanceof Error ? e.message : String(e)}`, 'error', 9000);
    }
  }

  for (const ev of ['frame', 'site', 'model', 'placement', 'neighbors', 'project', 'env']) emit(ev);
  // 測定点（解析結果込み）は配置・周辺環境のイベントの後で入れる。
  // 注意: その後に「建設地」で周辺環境を再取得すると（地形が変わるので）結果は捨てられる（loadEnvironment の 'frame'）
  study.points = points;
  emit('points');
}

/** ファイルから読込 */
export async function loadProjectFile(file: File): Promise<void> {
  const text = await file.text();
  let p: unknown;
  try {
    p = JSON.parse(text);
  } catch {
    throw new Error('JSON として読み取れませんでした（日照シミュレーションで保存した .json を選んでください）');
  }
  if (!isProjectJson(p)) throw new Error('日照シミュレーションのプロジェクトファイルではありません（app が sunstudy ではありません）');
  await applyProject(p);
}

/** URL から読込（?project=...） */
export async function loadProjectFromUrl(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`プロジェクトを取得できませんでした (${res.status}): ${url}`);
  const p = (await res.json()) as unknown;
  if (!isProjectJson(p)) throw new Error('日照シミュレーションのプロジェクトファイルではありません');
  await applyProject(p);
}

// ---------------------------------------------------------------------------
// 直近の設定（localStorage）
// ---------------------------------------------------------------------------

export interface RecentData {
  frame: GeoFrame | null;
  sitePolygon: LatLon[];
  placement: ModelPlacement;
  name: string;
  customer: string;
  company: string;
  savedAt: string;
}

/** 直近の場所・設定を localStorage に残す（3D データは含まない）。失敗しても何もしない */
export function saveRecent(): void {
  try {
    const d: RecentData = {
      frame: study.frame ? { ...study.frame } : null,
      sitePolygon: study.sitePolygon.map((p) => ({ lat: p.lat, lon: p.lon })),
      placement: { ...study.placement, hiddenObjects: [...(study.placement.hiddenObjects ?? [])] },
      name: study.name,
      customer: study.customer,
      company: study.company,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(RECENT_KEY, JSON.stringify(d));
  } catch {
    /* プライベートモード・容量超過など */
  }
}

/** 直近の設定を読む（状態には反映しない）。無ければ null */
export function readRecent(): RecentData | null {
  try {
    const s = localStorage.getItem(RECENT_KEY);
    if (!s) return null;
    const d = JSON.parse(s) as Partial<RecentData>;
    if (!d || typeof d !== 'object') return null;
    return {
      frame: isLatLon(d.frame) ? { lat: +d.frame.lat, lon: +d.frame.lon, address: typeof d.frame.address === 'string' ? d.frame.address : '', groundElev: Number.isFinite(d.frame.groundElev as number) ? (d.frame.groundElev as number) : null } : null,
      sitePolygon: Array.isArray(d.sitePolygon) ? d.sitePolygon.filter(isLatLon).map((q) => ({ lat: +q.lat, lon: +q.lon })) : [],
      placement: sanitizePlacement(d.placement),
      name: typeof d.name === 'string' ? d.name : '',
      customer: typeof d.customer === 'string' ? d.customer : '',
      company: typeof d.company === 'string' ? d.company : '',
      savedAt: typeof d.savedAt === 'string' ? d.savedAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * 直近の設定を状態に戻す（まだ場所が決まっていないときだけ場所・敷地・配置を戻す）。
 * 保存データがあれば true
 */
export function restoreRecent(): boolean {
  const d = readRecent();
  if (!d) return false;
  try {
    if (!study.frame) {
      if (d.frame) study.frame = { ...d.frame, groundElev: null };
      study.sitePolygon = d.sitePolygon;
      study.placement = d.placement;
      if (d.name) study.name = d.name;
      if (d.customer) study.customer = d.customer;
      if (d.company) study.company = d.company;
      emit('frame');
      emit('site');
      emit('placement');
      emit('project');
    }
    return true;
  } catch {
    return false;
  }
}
