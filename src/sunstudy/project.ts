/**
 * プロジェクトの保存／読込（JSON。3D データと周辺環境を同梱）と、直近の設定の自動保存（localStorage）
 *
 * 保存形式は types.ts の ProjectJson。
 *  - 3D データ: 元ファイルを base64 で同梱（40MB まで。超えると省略し、開いたときに再読み込みを促す）
 *  - 周辺環境 (env): 標高格子は cm 単位の Int16 を base64 に（無効値 -32768）。Int16 の範囲（±327 m）に収めるため、
 *    値は「ピン位置の地盤高（frame.groundElev を整数 m に丸めたもの）からの相対値」で保存し、読込時に同じ基準を足す。
 *    航空写真は JPEG dataURL（長辺 2048px・品質 0.8）、周辺建物は自動取得分のみ（手動は manualNeighbors）、遠方の地平線は number[]。
 *    PLATEAU の実形状（Neighbor.mesh の Float32Array）は Int16 cm の meshQ（SavedNeighbor）にして同梱し、PLATEAU の出典（使ったデータセット・
 *    索引の生成日時）は env.plateau に残す（開いたときに再取得せず出典行を再現する）。
 *    JSON 全体が約 60MB を超えそうなときは env を省略する（開いたときに再取得）。
 *  - localStorage 'sunstudy.recent': 直近の場所・敷地・配置・名前（3D データは含まない）。失敗しても何もしない。
 */
import { download, toast } from '../app/dom';
import { base64ToArrayBuffer, importModelFile } from './importModel';
import { resetPlaced } from './building';
import { emit, normalizeHideInfo, plannedToNeighbor, study } from './state';
import { PLANNED_DEFAULT_LABEL, clampHouse, syncPlannedHouse } from '../sun/plannedHouse';
import { QUANTIZE_LIMIT_M, dequantizeMesh, quantizeMesh } from '../sun/plateau';
import type { PlateauAttrs, PlateauDatasetInfo } from '../sun/plateau';
import { sampleHeight } from './terrain';
import { polygonAreaM2 } from './map';
import { DEFAULT_PLACEMENT, UNIT_LABEL } from './types';
import type { AerialImage, GeoFrame, HeightGrid, LatLon, LengthUnit, ModelPlacement, Neighbor, NeighborOverride, PlacementAlignment, PlateauEnvInfo, ProjectEnv, ProjectJson, SavedNeighbor } from './types';

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

/** 保存データの敷地の輪郭: 緯度経度でない点を除き、3 点未満・面積 0（一直線上・同じ点の繰り返し）なら無しにする */
function cleanPolygon(v: unknown): LatLon[] {
  const poly = Array.isArray(v) ? (v as unknown[]).filter(isLatLon).map((q) => ({ lat: +q.lat, lon: +q.lon })) : [];
  if (poly.length < 3) return [];
  try {
    return polygonAreaM2(poly) > 0 ? poly : [];
  } catch {
    return [];
  }
}

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

/**
 * 保存データの周辺建物の上書き（高さ・隠す・隠し方・理由）を整える。
 * 隠した記録に隠し方・理由が無い（この機能より前の保存データ）・知らない値なら「計算から除外」「その他」として読む。
 * 高さは正の有限値だけ、hidden は真偽値だけ受け取る。中身が空になった上書きは捨てる
 */
export function sanitizeNeighborOverrides(v: unknown): Record<string, NeighborOverride> {
  const out: Record<string, NeighborOverride> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const next: NeighborOverride = {};
    if (isFiniteNum(o.height) && o.height > 0) next.height = o.height;
    if (typeof o.hidden === 'boolean') next.hidden = o.hidden;
    if (next.hidden) {
      const info = normalizeHideInfo({ mode: o.hideMode, reason: o.hideReason, note: o.hideNote });
      next.hideMode = info.mode;
      next.hideReason = info.reason;
      if (info.note) next.hideNote = info.note;
    }
    if (Object.keys(next).length) out[id] = next;
  }
  return out;
}

/** 保存データの周辺建物（手動の隣家・同梱の自動取得分）の隠した記録を整える（隠し方・理由が無ければ計算から除外・その他） */
export function sanitizeNeighborHide(n: Neighbor): Neighbor {
  const out: Neighbor = { ...n };
  if (out.hidden === true) {
    const info = normalizeHideInfo({ mode: out.hideMode, reason: out.hideReason, note: out.hideNote });
    out.hideMode = info.mode;
    out.hideReason = info.reason;
    if (info.note) out.hideNote = info.note;
    else delete out.hideNote;
  } else {
    delete out.hidden;
    delete out.hideMode;
    delete out.hideReason;
    delete out.hideNote;
  }
  return out;
}

/**
 * 保存データの想定の家（Neighbor.planned）を整える: 手動の隣家で planned がオブジェクトなら clampHouse で整え（数値は有限値・屋根の形とプリセットは
 * 知っている値だけ）、中心が壊れていれば ring の平均から、ring・height・label・source・heightKind を planned から作り直す（隠した記録は残す）。
 * planned が壊れている・自動取得の建物に付いているなら planned を外す。planned の無い建物はそのまま
 */
export function sanitizePlannedNeighbor(n: Neighbor): Neighbor {
  if (!('planned' in n)) return n;
  const raw = n.planned as unknown;
  if (n.source !== 'manual' || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const out: Neighbor = { ...n };
    delete out.planned;
    return out;
  }
  const r = raw as Record<string, unknown>;
  const label = typeof r.label === 'string' && r.label.trim() ? r.label : typeof n.label === 'string' && n.label.trim() && n.label !== PLANNED_DEFAULT_LABEL ? n.label : undefined;
  let p = clampHouse({ ...r, id: typeof n.id === 'string' && n.id ? n.id : undefined, label });
  const ring = Array.isArray(n.ring) ? n.ring.filter(isEN) : [];
  if (!(isFiniteNum(r.ce) && isFiniteNum(r.cn))) p = syncPlannedHouse(p, ring);
  return plannedToNeighbor(p, n);
}

// ---------------------------------------------------------------------------
// PLATEAU の実形状と属性（保存形 ↔ 実行時）
// ---------------------------------------------------------------------------

type PlateauWarning = NonNullable<PlateauAttrs['warnings']>[number];
const PLATEAU_LODS: readonly number[] = [1, 2, 3, 4];
const FOOTPRINT_KINDS: readonly PlateauAttrs['footprint'][] = ['bottom', 'hull'];
const PLATEAU_WARNINGS: readonly PlateauWarning[] = ['noBottom', 'baseMismatch', 'islands'];

/**
 * 実行時の周辺建物 → 保存形。mesh（Float32Array。JSON.stringify で壊れる）は Int16 cm の meshQ に。
 * 量子化できない（±327 m を超える巨大な建物など）ときは meshQ 無し（開いたとき ring の押し出しで描く）。ring・holes・plateau は写しを作る
 */
export function toSavedNeighbor(n: Neighbor): SavedNeighbor {
  const { mesh, ...rest } = n;
  const out: SavedNeighbor = { ...rest, ring: n.ring.map((q) => ({ e: q.e, n: q.n })) };
  if (n.holes) out.holes = n.holes.map((h) => h.map((q) => ({ e: q.e, n: q.n })));
  if (n.plateau) {
    out.plateau = { ...n.plateau, anchor: { ...n.plateau.anchor } };
    if (n.plateau.warnings) out.plateau.warnings = [...n.plateau.warnings];
  }
  if (mesh) {
    // Int16 cm（±327.67 m）に収まらない形状（電波塔など高さ 327 m 超。横方向は取得側が anchor を取り直すので収まる）は
    // quantizeMesh が天端を丸めてしまうので meshQ を省き、開いたときは足元の押し出し（ring × height）で描く
    let worst = 0;
    for (let i = 0; i < mesh.tris.length; i++) {
      const a = Math.abs(mesh.tris[i]);
      if (a > worst) worst = a;
    }
    if (worst > QUANTIZE_LIMIT_M) {
      console.warn(`周辺建物 ${n.id} の形状は保存形（±${QUANTIZE_LIMIT_M} m）に収まらないため保存しません（最大 ${worst.toFixed(1)} m。開いたときは足元の押し出しで描きます）`);
    } else {
      try {
        out.meshQ = quantizeMesh(mesh);
      } catch (e) {
        console.warn(`周辺建物 ${n.id} の形状を保存できません（開いたときは足元の押し出しで描きます）`, e);
      }
    }
  }
  return out;
}

/** 保存形 → 実行時。meshQ → mesh（壊れていれば mesh 無し = ring の押し出しで描く）。meshQ の無い古い保存データもそのまま開ける */
export function fromSavedNeighbor(s: SavedNeighbor): Neighbor {
  const { meshQ, ...rest } = s;
  const out: Neighbor = { ...rest };
  if (meshQ != null) {
    try {
      out.mesh = dequantizeMesh(meshQ);
    } catch (e) {
      console.warn(`周辺建物 ${String(s.id)} の形状（meshQ）を読めません（足元の押し出しで描きます）`, e);
    }
  }
  return out;
}

/** 保存データの PLATEAU 属性を検査して整える。gmlId・anchor・zmin/zmax（zmax > zmin）が無い・壊れていれば null。任意の項目は型が合うものだけ残す */
function sanitizePlateauAttrsRaw(raw: unknown): PlateauAttrs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.gmlId !== 'string' || !a.gmlId || !isLatLon(a.anchor) || !isFiniteNum(a.zmin) || !isFiniteNum(a.zmax) || a.zmax <= a.zmin) return null;
  const lod = isFiniteNum(a.lod) && PLATEAU_LODS.includes(a.lod) ? (a.lod as PlateauAttrs['lod']) : null;
  const out: PlateauAttrs = {
    gmlId: a.gmlId,
    lod,
    datasetLod: isFiniteNum(a.datasetLod) ? a.datasetLod : (lod ?? 1),
    year: isFiniteNum(a.year) ? a.year : 0,
    muniCd: typeof a.muniCd === 'string' ? a.muniCd : '',
    pref: typeof a.pref === 'string' ? a.pref : '',
    city: typeof a.city === 'string' ? a.city : '',
    ward: typeof a.ward === 'string' ? a.ward : null,
    anchor: { lat: +a.anchor.lat, lon: +a.anchor.lon },
    zmin: a.zmin,
    zmax: a.zmax,
    footprint: FOOTPRINT_KINDS.includes(a.footprint as PlateauAttrs['footprint']) ? (a.footprint as PlateauAttrs['footprint']) : 'hull',
  };
  for (const k of ['measuredHeight', 'storeys', 'storeysBelow', 'surveyYear'] as const) if (isFiniteNum(a[k])) out[k] = a[k] as number;
  for (const k of ['usage', 'name', 'address', 'buildingId', 'lod1HeightType'] as const) if (typeof a[k] === 'string' && a[k]) out[k] = a[k] as string;
  const re = a.roofEstimate as Record<string, unknown> | undefined;
  if (re && typeof re === 'object' && re.kind === 'hip' && isFiniteNum(re.eave) && isFiniteNum(re.ridge) && isFiniteNum(re.boxHeight) && re.eave > 0 && re.ridge > re.eave) {
    out.roofEstimate = { kind: 'hip', eave: re.eave, ridge: re.ridge, boxHeight: re.boxHeight };
  }
  if (Array.isArray(a.warnings)) {
    const w = (a.warnings as unknown[]).filter((x): x is PlateauWarning => PLATEAU_WARNINGS.includes(x as PlateauWarning));
    if (w.length) out.warnings = w;
  }
  return out;
}

/**
 * 保存データの周辺建物の PLATEAU 属性と実形状を検査する。gmlId・anchor・zmin/zmax が不正なら plateau と mesh を外す（ring の押し出しで描く）。
 * mesh は属性があり tris が Float32Array で 9 の倍数のときだけ残す（plateau 無しの mesh は配置できないので外す）。plateau も mesh も無い建物はそのまま
 */
export function sanitizePlateauAttrs(n: Neighbor): Neighbor {
  if (!('plateau' in n) && !('mesh' in n)) return n;
  const out: Neighbor = { ...n };
  const attrs = sanitizePlateauAttrsRaw(out.plateau);
  if (!attrs) {
    delete out.plateau;
    delete out.mesh;
    return out;
  }
  out.plateau = attrs;
  const m = out.mesh as unknown;
  const tris = m && typeof m === 'object' ? (m as { tris?: unknown }).tris : undefined;
  if (tris instanceof Float32Array && tris.length > 0 && tris.length % 9 === 0) {
    const roof = (m as { roofTriangles?: unknown }).roofTriangles;
    out.mesh = { tris, roofTriangles: isFiniteNum(roof) ? Math.max(0, Math.min(tris.length / 9, Math.floor(roof))) : 0 };
  } else delete out.mesh;
  return out;
}

/** 保存データの PLATEAU の出典（使ったデータセット・索引の生成日時）。muniCd と label のあるデータセットだけ残し、1 件も無ければ無し */
function sanitizeEnvPlateau(v: unknown): PlateauEnvInfo | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const x = v as { datasets?: unknown; indexGenerated?: unknown };
  const datasets: PlateauDatasetInfo[] = [];
  if (Array.isArray(x.datasets)) {
    for (const raw of x.datasets as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const d = raw as Record<string, unknown>;
      if (typeof d.muniCd !== 'string' || typeof d.label !== 'string' || !d.label) continue;
      datasets.push({
        muniCd: d.muniCd,
        pref: typeof d.pref === 'string' ? d.pref : '',
        city: typeof d.city === 'string' ? d.city : '',
        ward: typeof d.ward === 'string' ? d.ward : null,
        year: isFiniteNum(d.year) ? d.year : 0,
        lod: isFiniteNum(d.lod) ? d.lod : 1,
        tex: d.tex === true,
        tilesetUrl: typeof d.tilesetUrl === 'string' ? d.tilesetUrl : '',
        label: d.label,
      });
    }
  }
  if (!datasets.length) return undefined;
  return { datasets, indexGenerated: typeof x.indexGenerated === 'string' ? x.indexGenerated : '' };
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
    manualNeighbors: study.neighbors
      .filter((n) => n.source === 'manual')
      .map((n) => {
        const out: Neighbor = { ...n, ring: n.ring.map((q) => ({ e: q.e, n: q.n })) };
        // 想定の家は今の形（ring・height に合わせた中心・高さ）で書く
        if (n.planned) out.planned = { ...syncPlannedHouse(n.planned, n.ring, n.height) };
        return out;
      }),
    plannedEnabled: study.plannedEnabled,
    roofEstimate: study.roofEstimate,
    neighborOverrides: Object.fromEntries(Object.entries(study.neighborOverrides).map(([id, o]) => [id, { ...o }])),
    points: JSON.parse(JSON.stringify(study.points)) as ProjectJson['points'],
  };
  const autoNeighbors = study.neighbors.filter((n) => n.source !== 'manual');
  if (study.env.loaded && (study.grid || study.aerial || autoNeighbors.length)) {
    const base = Math.round(study.frame?.groundElev ?? 0);
    const env: ProjectEnv = {
      fetchedAt: json.savedAt,
      grid: study.grid ? encodeGrid(study.grid, base) : null,
      aerial: study.aerial ? encodeAerial(study.aerial) : null,
      neighbors: autoNeighbors.map(toSavedNeighbor),
      neighborSources: [...study.neighborSources],
      neighborNotes: [...study.neighborNotes],
      horizon: study.horizon ? { elevDeg: Array.from(study.horizon.elevDeg), source: study.horizon.source, radiusKm: study.horizon.radiusKm } : null,
    };
    // PLATEAU の出典（使ったデータセット・索引の生成日時）。開いたときに再取得せず出典行を再現する
    if (study.env.plateau) env.plateau = { datasets: study.env.plateau.datasets.map((d) => ({ ...d })), indexGenerated: study.env.plateau.indexGenerated };
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
  study.sitePolygon = cleanPolygon(p.sitePolygon);
  study.placement = sanitizePlacement(p.placement as Partial<ModelPlacement> | undefined);
  // 隠した記録に隠し方・理由が無い古いデータは「計算から除外」「その他」として読む
  study.neighborOverrides = sanitizeNeighborOverrides(p.neighborOverrides);
  // 測定点は最後に入れる（下の 'placement' などの発火で古い結果を捨てる処理が走り、復元した結果まで消えないように）
  const points = Array.isArray(p.points) ? p.points : [];
  study.points = [];
  study.results = { images: [] };

  // 周辺環境
  const manual: Neighbor[] = Array.isArray(p.manualNeighbors) ? p.manualNeighbors.filter((n) => n && Array.isArray(n.ring)).map(sanitizePlateauAttrs).map(sanitizeNeighborHide).map(sanitizePlannedNeighbor) : [];
  // 想定の家を影・解析に含めるか（無い古いデータは含める）
  study.plannedEnabled = p.plannedEnabled !== false;
  study.roofEstimate = p.roofEstimate !== false;
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
    // meshQ → mesh（壊れていれば mesh 無し = 押し出しで描く）→ PLATEAU 属性の検査 → 隠した記録 → 想定の家
    auto = Array.isArray(env.neighbors) ? env.neighbors.filter((n) => n && Array.isArray(n.ring)).map(fromSavedNeighbor).map(sanitizePlateauAttrs).map(sanitizeNeighborHide).map(sanitizePlannedNeighbor) : [];
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
    const plateauEnv = sanitizeEnvPlateau(env.plateau);
    if (plateauEnv) study.env.plateau = plateauEnv;
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
      sitePolygon: cleanPolygon(d.sitePolygon),
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
