/** 日照シミュレーション（3D データ読み込み版）の状態 */
import { PLANNED_DEFAULT_LABEL, clampHouse, plannedFootprint, syncPlannedHouse, type PlannedHouse } from '../sun/plannedHouse';
import type { AerialImage, GeoFrame, HeightGrid, ImportedModel, LatLon, MeasurePoint, ModelPlacement, Neighbor, NeighborHideInfo, NeighborHideMode, NeighborHideReason, NeighborOverride, NeighborSource } from './types';
import { DEFAULT_PLACEMENT, HIDE_MODES, HIDE_REASONS } from './types';

export interface StudyUI {
  year: number;
  month: number;
  day: number;
  /** ローカル時刻 (h, 小数) */
  hour: number;
  playing: boolean;
  speed: number;
}

export interface StudyState {
  name: string;
  customer: string;
  company: string;
  /** 建設地（ピン）。未設定なら null */
  frame: GeoFrame | null;
  /** 敷地の輪郭（任意。地図上で描く） */
  sitePolygon: LatLon[];
  /** 地形 */
  grid: HeightGrid | null;
  aerial: AerialImage | null;
  /** 遠方の地形（山・丘）による地平線の高度角（方位 0..359°、真北から時計回り）。無ければ null */
  horizon: { elevDeg: Float32Array; source: string; radiusKm: number } | null;
  /** 周辺建物（自動取得 + 手動） */
  neighbors: Neighbor[];
  neighborSources: NeighborSource[];
  neighborNotes: string[];
  /** 自動取得した建物への上書き（高さ修正・隠す。隠し方・理由も）。id → 値 */
  neighborOverrides: Record<string, NeighborOverride>;
  /**
   * 想定の家（Neighbor.planned）を 3D・影・解析に含めるか（既定 true）。false の間は計算から除外した建物と同じく
   * 描かない・影を落とさない・解析しない（hidden には触らない。「隠した建物」の一覧にも出さない）。保存データに残す
   */
  plannedEnabled: boolean;
  /** 読み込んだ 3D データと配置 */
  model: ImportedModel | null;
  placement: ModelPlacement;
  /** 測定点 */
  points: MeasurePoint[];
  ui: StudyUI;
  show: { aerial: boolean; neighbors: boolean; terrain: boolean; sunPath: boolean; site: boolean; points: boolean };
  /** 周辺環境の取得状況 */
  env: { loaded: boolean; loading: boolean; error: string | null; attribution: string };
  /** 解析結果（レポート用） */
  results: {
    images: { label: string; url: string }[];
    diagramSvg?: string;
    diagramSummary?: { hour: number; maxDist: number; role?: 'limitNear' | 'limitFar' }[];
    /** 日影図の条件（測定面・規制値・時刻日影線の間隔・周辺建物を含むか）。レポートの見出しに使う */
    diagramInfo?: { plane: string; regulation: string | null; halfHour: boolean; includeNeighbors: boolean };
    /** 等時間日影線の到達距離の基準: 敷地境界 / 建物の輪郭（敷地の輪郭が無いとき） */
    diagramRef?: 'site' | 'outline';
    heatmapUrl?: string;
    heatmapLabel?: string;
    facadeUrl?: string;
    facadeLabel?: string;
    mapUrl?: string;
  };
}

export const study: StudyState = {
  name: '〇〇様邸 日照検討',
  customer: '〇〇様',
  company: '',
  frame: null,
  sitePolygon: [],
  grid: null,
  aerial: null,
  horizon: null,
  neighbors: [],
  neighborSources: [],
  neighborNotes: [],
  neighborOverrides: {},
  plannedEnabled: true,
  model: null,
  placement: { ...DEFAULT_PLACEMENT },
  points: [],
  ui: { year: new Date().getFullYear(), month: 12, day: 22, hour: 10, playing: false, speed: 1 },
  show: { aerial: true, neighbors: true, terrain: true, sunPath: true, site: true, points: true },
  env: { loaded: false, loading: false, error: null, attribution: '' },
  results: { images: [] },
};

type Handler = (payload?: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

/**
 * イベント:
 *  'frame'      ピン位置・住所が変わった
 *  'site'       敷地ポリゴンが変わった
 *  'env'        地形・航空写真・周辺建物の取得状況が変わった（再構築が必要）
 *  'neighbors'  周辺建物の一覧が変わった（手動追加・高さ修正・隠す／戻す・削除・想定の家の追加／変更／削除・想定の家を含めるかの切替）
 *  'model'      3D データを読み込んだ／差し替えた
 *  'placement'  単位・向き・位置・高さ・表示が変わった
 *  'points'     測定点が変わった
 *  'project'    プロジェクト名など
 *  'time'       日付・時刻が変わった
 */
export function on(ev: string, fn: Handler) {
  if (!handlers.has(ev)) handlers.set(ev, new Set());
  handlers.get(ev)!.add(fn);
  return () => handlers.get(ev)!.delete(fn);
}

export function emit(ev: string, payload?: unknown) {
  handlers.get(ev)?.forEach((f) => f(payload));
}

let idc = 0;
export const uid = (p = 'id') => `${p}-${Date.now().toString(36)}-${(idc++).toString(36)}`;

/** 隠し方・理由の既定（古い保存データの「隠した」は計算から除外・その他として読む） */
export const DEFAULT_HIDE_INFO: Readonly<NeighborHideInfo> = { mode: 'exclude', reason: 'other' };
/** 理由の補足の長さの上限（文字） */
export const HIDE_NOTE_MAX = 200;

/** 保存データ・入力の隠し方・理由を整える（知らない値は既定に、補足は前後の空白を除いて 200 文字まで、空なら無し） */
export function normalizeHideInfo(raw: { mode?: unknown; reason?: unknown; note?: unknown } | null | undefined): NeighborHideInfo {
  const mode = HIDE_MODES.includes(raw?.mode as NeighborHideMode) ? (raw!.mode as NeighborHideMode) : DEFAULT_HIDE_INFO.mode;
  const reason = HIDE_REASONS.includes(raw?.reason as NeighborHideReason) ? (raw!.reason as NeighborHideReason) : DEFAULT_HIDE_INFO.reason;
  const note = typeof raw?.note === 'string' ? raw.note.trim().slice(0, HIDE_NOTE_MAX) : '';
  return note ? { mode, reason, note } : { mode, reason };
}

/** 隠した建物の隠し方・理由（隠していなければ null）。effectiveNeighbors の結果に使う */
export function hideInfoOf(n: Neighbor): NeighborHideInfo | null {
  if (!n.hidden) return null;
  return normalizeHideInfo({ mode: n.hideMode, reason: n.hideReason, note: n.hideNote });
}

/** 直近に選んだ隠し方・理由（操作バー・ポップアップ・建設地の地図で共有。保存はしない） */
let hideDefaults: NeighborHideInfo = { ...DEFAULT_HIDE_INFO };
export function getHideDefaults(): NeighborHideInfo {
  return { ...hideDefaults };
}
export function setHideDefaults(info: Partial<NeighborHideInfo>): void {
  hideDefaults = normalizeHideInfo({ ...hideDefaults, ...info });
}

/**
 * 上書き（高さ・隠す・隠し方・理由）を適用した周辺建物（隠したものも含む）。手動の隣家は本体の hidden / hideMode…、
 * 自動取得の建物は neighborOverrides で隠す。隠した建物の hideMode・hideReason はいつも入っている（古いデータは計算から除外・その他）
 */
export function effectiveNeighbors(): Neighbor[] {
  return study.neighbors.map((n) => {
    const o = study.neighborOverrides[n.id];
    // 上書きが無く、隠し方・理由も整っていれば元のオブジェクトをそのまま返す（今までどおり。rebuildEnvironment の baseElev など）
    if (!o) {
      const info = hideInfoOf(n);
      const clean = info
        ? n.hideMode === info.mode && n.hideReason === info.reason && n.hideNote === info.note
        : n.hideMode === undefined && n.hideReason === undefined && n.hideNote === undefined;
      if (clean) return n;
    }
    const e: Neighbor = o
      ? {
          ...n,
          height: o.height ?? n.height,
          hidden: o.hidden ?? n.hidden,
          hideMode: o.hideMode ?? n.hideMode,
          hideReason: o.hideReason ?? n.hideReason,
          hideNote: o.hideNote ?? n.hideNote,
          heightKind: o.height != null ? ('manual' as const) : n.heightKind,
        }
      : { ...n };
    if (e.hidden) {
      const info = hideInfoOf(e)!;
      e.hideMode = info.mode;
      e.hideReason = info.reason;
      if (info.note) e.hideNote = info.note;
      else delete e.hideNote;
    } else {
      delete e.hideMode;
      delete e.hideReason;
      delete e.hideNote;
    }
    return e;
  });
}

/**
 * 3D・影・解析に入れてよいか: 想定の家（planned）は study.plannedEnabled のときだけ、それ以外はいつも true。
 * visibleNeighbors / hiddenNeighbors / excludedNeighbors / viewOnlyNeighbors / analysisNeighbors はこれで絞る（effectiveNeighbors は絞らない）
 */
export function plannedActive(n: Neighbor): boolean {
  return !n.planned || study.plannedEnabled;
}

/** 3D に描く周辺建物（隠していないもの。上書きを適用。想定の家は含めるときだけ） */
export function visibleNeighbors(): Neighbor[] {
  return effectiveNeighbors().filter((n) => !n.hidden && plannedActive(n));
}

/** 隠した周辺建物（上書きを適用。手動の隣家で隠したものも含む。隠し方は問わない。想定の家は含めるときだけ）。3D には描かない */
export function hiddenNeighbors(): Neighbor[] {
  return effectiveNeighbors().filter((n) => !!n.hidden && plannedActive(n));
}

/** 計算から除外した周辺建物（描かない・影を落とさない・解析しない） */
export function excludedNeighbors(): Neighbor[] {
  return hiddenNeighbors().filter((n) => n.hideMode !== 'view');
}

/** 表示だけ隠した周辺建物（描かないが、影・解析・日影図には残す） */
export function viewOnlyNeighbors(): Neighbor[] {
  return hiddenNeighbors().filter((n) => n.hideMode === 'view');
}

/** 影・解析に入る周辺建物（隠していないもの + 表示だけ隠したもの。計算から除外したもの・含めない想定の家は入らない） */
export function analysisNeighbors(): Neighbor[] {
  return effectiveNeighbors().filter((n) => (!n.hidden || n.hideMode === 'view') && plannedActive(n));
}

/** 隠し方・理由が同じか */
const sameHide = (a: NeighborHideInfo | null, b: NeighborHideInfo | null) => (!a && !b) || (!!a && !!b && a.mode === b.mode && a.reason === b.reason && (a.note ?? '') === (b.note ?? ''));

/** 1 棟の隠す／戻す・隠し方の書き込み（手動の隣家は本体、自動取得の建物は上書き） */
function writeHide(n: Neighbor, info: NeighborHideInfo | null): void {
  const o = study.neighborOverrides[n.id];
  if (n.source === 'manual') {
    if (info) {
      n.hidden = true;
      n.hideMode = info.mode;
      n.hideReason = info.reason;
      if (info.note) n.hideNote = info.note;
      else delete n.hideNote;
    } else {
      delete n.hidden;
      delete n.hideMode;
      delete n.hideReason;
      delete n.hideNote;
    }
    // 手動の隣家に上書きの hidden・隠し方は使わない（古いデータに残っていても外す）
    if (o && ('hidden' in o || 'hideMode' in o || 'hideReason' in o || 'hideNote' in o)) {
      const rest: NeighborOverride = { ...o };
      delete rest.hidden;
      delete rest.hideMode;
      delete rest.hideReason;
      delete rest.hideNote;
      if (Object.keys(rest).length) study.neighborOverrides[n.id] = rest;
      else delete study.neighborOverrides[n.id];
    }
    return;
  }
  const next: NeighborOverride = { ...(o ?? {}) };
  delete next.hideMode;
  delete next.hideReason;
  delete next.hideNote;
  if (info) {
    next.hidden = true;
    next.hideMode = info.mode;
    next.hideReason = info.reason;
    if (info.note) next.hideNote = info.note;
  } else if (n.hidden) next.hidden = false;
  else delete next.hidden;
  if (Object.keys(next).length) study.neighborOverrides[n.id] = next;
  else delete study.neighborOverrides[n.id];
}

/**
 * 周辺建物を隠す／戻す。自動取得の建物は neighborOverrides[id] に、手動の隣家は本体に書く
 * （手動の隣家も消さずに隠すので「戻す」で戻せる。消すのは別の「削除」）。
 * 隠すときは隠し方・理由（info。省略時は計算から除外・その他）も書く。隠している建物に別の隠し方・理由で隠すと書き換える。
 * 戻すときは上書きの hidden・隠し方・理由を外し（元データが隠れていなければ）、空になった上書きは消す。
 * 1 棟でも変わったら 'neighbors' を 1 回だけ発火する（古い解析結果はそこで捨てられる）。変わった棟数を返す
 */
export function setNeighborsHidden(ids: string[], hidden: boolean, info?: Partial<NeighborHideInfo>): number {
  const want = new Set(ids);
  const target = hidden ? normalizeHideInfo({ ...DEFAULT_HIDE_INFO, ...(info ?? {}) }) : null;
  const eff = new Map(effectiveNeighbors().map((n) => [n.id, n]));
  let changed = 0;
  for (const n of study.neighbors) {
    if (!want.has(n.id)) continue;
    const cur = hideInfoOf(eff.get(n.id) ?? n);
    if (sameHide(cur, target)) continue;
    writeHide(n, target);
    changed++;
  }
  if (changed) emit('neighbors');
  return changed;
}

/** 隠した建物の隠し方・理由を変える（隠していない建物は無視。'neighbors' を 1 回だけ発火）。変わった棟数を返す */
export function setNeighborsHideInfo(ids: string[], patch: Partial<NeighborHideInfo>): number {
  const want = new Set(ids);
  const eff = new Map(effectiveNeighbors().map((n) => [n.id, n]));
  let changed = 0;
  for (const n of study.neighbors) {
    if (!want.has(n.id)) continue;
    const cur = hideInfoOf(eff.get(n.id) ?? n);
    if (!cur) continue;
    const next = normalizeHideInfo({ ...cur, ...patch });
    if (sameHide(cur, next)) continue;
    writeHide(n, next);
    changed++;
  }
  if (changed) emit('neighbors');
  return changed;
}

/** 隠した周辺建物をすべて戻す（'neighbors' を 1 回だけ発火）。mode を渡すとその隠し方の建物だけ。戻した棟数を返す */
export function restoreAllNeighbors(mode?: NeighborHideMode): number {
  return setNeighborsHidden(
    hiddenNeighbors()
      .filter((n) => !mode || n.hideMode === mode)
      .map((n) => n.id),
    false,
  );
}

// ---------------------------------------------------------------------------
// 想定の家（未建築の隣家）
// ---------------------------------------------------------------------------

/** 想定の家（planned のある周辺建物） */
export type PlannedNeighbor = Neighbor & { planned: PlannedHouse };

export function isPlannedNeighbor(n: Neighbor | null | undefined): n is PlannedNeighbor {
  return !!n && !!n.planned;
}

/**
 * 想定の家 → 周辺建物（source 'manual'・heightKind 'manual'・ring = 足元・height = 最高高さ・label = 名前か「想定の家」）。
 * prev を渡すと隠した記録（hidden・隠し方・理由）と baseElev を引き継ぐ
 */
export function plannedToNeighbor(h: Partial<PlannedHouse>, prev?: Neighbor): PlannedNeighbor {
  const p = clampHouse(h);
  const out: PlannedNeighbor = { id: p.id, ring: plannedFootprint(p), height: p.ridgeHeight, source: 'manual', heightKind: 'manual', label: p.label ?? PLANNED_DEFAULT_LABEL, planned: p };
  if (prev) {
    if (prev.baseElev != null) out.baseElev = prev.baseElev;
    if (prev.hidden) {
      out.hidden = true;
      if (prev.hideMode) out.hideMode = prev.hideMode;
      if (prev.hideReason) out.hideReason = prev.hideReason;
      if (prev.hideNote) out.hideNote = prev.hideNote;
    }
  }
  return out;
}

/** 今の形（ring・height を直接変えられていたら、中心・高さをそちらに合わせる） */
function currentPlanned(n: PlannedNeighbor): PlannedHouse {
  return syncPlannedHouse(n.planned, n.ring, n.height);
}

/**
 * 想定の家の一覧（study.neighbors の中の planned 付き。含めない設定でも全部）。
 * 返す前に planned を ring・height に合わせ直す（ピンを動かしたときに ring だけずらされても中心が追従する）
 */
export function plannedHouses(): PlannedNeighbor[] {
  const out: PlannedNeighbor[] = [];
  for (const n of study.neighbors) {
    if (!isPlannedNeighbor(n)) continue;
    const cur = currentPlanned(n);
    if (cur !== n.planned) n.planned = cur;
    out.push(n);
  }
  return out;
}

/**
 * 想定の家を足す（値は clampHouse で整える。id が無い・他の建物と重なれば新しく作る）。'neighbors' を 1 回発火。足した周辺建物を返す
 */
export function addPlannedHouse(h: Partial<PlannedHouse>): PlannedNeighbor {
  const taken = new Set(study.neighbors.map((n) => n.id));
  const p = clampHouse({ ...h, id: h.id && !taken.has(h.id) ? h.id : undefined });
  const n = plannedToNeighbor(p);
  study.neighbors.push(n);
  emit('neighbors');
  return n;
}

/**
 * 想定の家を変える（patch に無い値は今のまま。label に空文字を渡すと名前を外して「想定の家」に）。
 * 変わったら 'neighbors' を 1 回発火して true。無い id・変わらなければ false
 */
export function updatePlannedHouse(id: string, patch: Partial<Omit<PlannedHouse, 'id'>>): boolean {
  const i = study.neighbors.findIndex((n) => n.id === id && !!n.planned);
  if (i < 0) return false;
  const n = study.neighbors[i] as PlannedNeighbor;
  const cur = currentPlanned(n);
  const next = clampHouse({ ...cur, ...patch, id: cur.id });
  const same = JSON.stringify(next) === JSON.stringify(n.planned) && n.label === (next.label ?? PLANNED_DEFAULT_LABEL);
  if (same) return false;
  const nb = plannedToNeighbor(next, n);
  // 同じオブジェクトを書き換える（一覧・選択が参照を持っていても追従するように）
  for (const k of Object.keys(n) as (keyof Neighbor)[]) if (!(k in nb)) delete n[k];
  Object.assign(n, nb);
  emit('neighbors');
  return true;
}

/** 想定の家を消す（上書きの記録も消す）。消したら 'neighbors' を 1 回発火して true */
export function removePlannedHouse(id: string): boolean {
  const before = study.neighbors.length;
  study.neighbors = study.neighbors.filter((n) => !(n.id === id && n.planned));
  if (study.neighbors.length === before) return false;
  delete study.neighborOverrides[id];
  emit('neighbors');
  return true;
}

/** 想定の家をすべて消す（'neighbors' を 1 回発火）。消した棟数を返す */
export function clearPlannedHouses(): number {
  const gone = study.neighbors.filter((n) => n.planned);
  if (!gone.length) return 0;
  study.neighbors = study.neighbors.filter((n) => !n.planned);
  for (const n of gone) delete study.neighborOverrides[n.id];
  emit('neighbors');
  return gone.length;
}

/** 想定の家を 3D・影・解析に含めるか（変わったら 'neighbors' を 1 回発火して true） */
export function setPlannedEnabled(on: boolean): boolean {
  if (study.plannedEnabled === on) return false;
  study.plannedEnabled = on;
  emit('neighbors');
  return true;
}
