/**
 * 両アプリ共通の入口: 葉選択 → 並列取得 → keep → 復号 → 分割 → 重複除去 → 状態（§4 のパイプライン）。
 *
 * fetchPlateauBuildings の段階（PlateauStage。進捗もこの順に出る）:
 *  1. geocode: muniCodesAround（中心＋±(radius+marginM) の 4 隅）。全滅 → 索引に region があれば muniCodesByRegion、それも無ければ error
 *  2. index:   loadPlateauIndex → pickDataset。索引に無い市区は missingMuniCds に。全部無ければ none/outside
 *  3. tileset: データセットごとに resolveTilesetUrl（-latest → 索引 URL）→ fetchCached → parseTileset。missing は対象外側に、
 *              取得失敗はそのデータセットだけ落とす（全滅で error/tileset）。葉の選択（selectContentTiles）もここで行い、
 *              複数データセットの葉を合わせて近い順に並べ、maxTiles を超えた分は遠い方から捨てる（truncated）
 *  4. tiles:   並列 concurrency で fetchCached（進捗はバイト）。maxBytes を超えそうなら残りを捨てる（truncated）。失敗は failedTiles
 *  5. decode:  タイルごとに parseB3dm → readBuildingRecords → keep（_xmin.._ymax 矩形までの距離 ≤ radiusM）→ 1 棟も無ければ復号しない →
 *              decodeTileGlb → splitBuildings。ダウンロードを全部終えてから順に行う（進捗の段階が前後しない）
 *  6. merge:   gml_id で重複除去（先に来た＝近い葉を優先）、lodCounts
 *
 * 返す PlateauBuilding.ring/holes/mesh は anchor 基準。ピン基準への変換は呼び出し側（frameToLocal(pin, anchor) を足す）。
 * 復号・分割済みタイルは URL キーで LRU（24 枚）に保持し、ピンが変わっても再復号しない（anchor 基準なので再利用できる）。
 * 分割は棟ごとに増やす: 前回 keep に入らなかった棟だけを次回 splitBuildings に掛ける（keep は半径に依るため）。
 * 生バイトは fetchCached（Cache API 'plateau-tiles-v1' 30 日 ＋ メモリ LRU 80 MB）。
 * 中止は signal.reason を throw、それ以外の失敗は status に畳む。
 * 仕様: scratchpad/plateau-spec.md §2.9・§4（W7 が実装）
 */
import { degBoxAround, degBoxDistanceM } from '../geodesy';
import { parseB3dm, type B3dm } from './b3dm';
import { readBuildingRecords, splitBuildings, type BuildingRecord } from './buildings';
import { loadPlateauIndex, muniCodesAround, muniCodesByRegion, pickDataset, resolveTilesetUrl, type NetOpts } from './catalog';
import { ensureDracoReady, getDracoDecoder } from './draco';
import { decodeTileGlb } from './glb';
import { parseTileset, selectContentTiles, type ContentTile } from './tileset';
import type { DecodedTile, DracoDecoderLike, PlateauBuilding, PlateauDatasetInfo, PlateauProgress, PlateauStage } from './types';

export interface PlateauFetchOptions extends NetOpts {
  onProgress?: (p: PlateauProgress) => void;
  /** 省略時は getDracoDecoder() */
  draco?: DracoDecoderLike;
  indexUrl?: string | URL;
  /** この距離までの葉は全部読む（既定 150 m） */
  nearM?: number;
  /** 1 / tan(8.2°): 高さ 1 m の建物の影が届く距離（既定 6.9） */
  reachFactor?: number;
  /** 遠い葉は「影の届く距離 − 葉までの距離」がこの余裕以内なら読む（既定 60 m） */
  reachMargin?: number;
  /** 半径に足す余白（既定 30 m） */
  marginM?: number;
  /** 既定 16 */
  maxTiles?: number;
  /** 既定 64 MiB */
  maxBytes?: number;
  /** 既定 4 */
  concurrency?: number;
}

export type PlateauFetchResult =
  | {
      status: 'covered';
      buildings: PlateauBuilding[];
      datasets: PlateauDatasetInfo[];
      tiles: { url: string; bytes: number; buildings: number; ms: number }[];
      failedTiles: number;
      truncated: boolean;
      lodCounts: Record<string, number>;
      /** 索引に無い市区（注記用） */
      missingMuniCds: string[];
    }
  | { status: 'none'; reason: 'outside' | 'noTiles'; muniCds: string[] }
  | { status: 'error'; stage: PlateauStage; message: string };

/** 既定値（§0 の実測で決めた葉の選択規則・上限） */
const DEFAULTS = {
  nearM: 150,
  reachFactor: 6.9,
  reachMargin: 60,
  marginM: 30,
  maxTiles: 16,
  maxBytes: 64 * 1024 * 1024,
  concurrency: 4,
} as const;

/** Cache API の名前（URL はハッシュ付きで不変なので 30 日保持） */
const CACHE_NAME = 'plateau-tiles-v1';
const CACHE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
/** 保存した時刻を持つ独自ヘッダ（Cache API は有効期限を見ないので自分で見る） */
const CACHED_AT_HEADER = 'x-plateau-cached-at';
/** メモリ LRU（生バイト）の上限 */
const MEM_LRU_BYTES = 80 * 1024 * 1024;
/** 復号・分割済みタイルの LRU の枚数 */
const SPLIT_LRU_TILES = 24;
/** Content-Length が分からないときの 1 枚の見積り（maxBytes の判定用。世田谷の葉 ≈ 3 MB） */
const UNKNOWN_TILE_BYTES = 3 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw (signal.reason as Error | undefined) ?? new Error('中止しました');
}

/** 中止による失敗なら signal.reason を投げ直す（それ以外は呼び出し側が status に畳む） */
function rethrowIfAborted(e: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) throw (signal.reason as Error | undefined) ?? e;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 'PLATEAU（国土交通省 3D都市モデル・東京都世田谷区・2025年度・LOD2）' */
export function plateauDatasetLabel(d: PlateauDatasetInfo): string {
  return `PLATEAU（国土交通省 3D都市モデル・${d.label}）`;
}

// ---------------------------------------------------------------------------
// 生バイトのキャッシュ（Cache API ＋ メモリ LRU）
// ---------------------------------------------------------------------------

interface MemEntry {
  promise: Promise<ArrayBuffer>;
  /** 解決後に埋める（取得中は 0） */
  bytes: number;
}

/** URL → Promise<ArrayBuffer>（Map の挿入順 = 古い順。触ったら末尾に移す） */
const memCache = new Map<string, MemEntry>();
let memBytes = 0;

function memTouch(url: string): MemEntry | undefined {
  const e = memCache.get(url);
  if (e) {
    memCache.delete(url);
    memCache.set(url, e);
  }
  return e;
}

/** 上限を超えた分を古い方から捨てる（取得中の項目は数えない） */
function memEvict(): void {
  for (const [url, e] of memCache) {
    if (memBytes <= MEM_LRU_BYTES) break;
    if (e.bytes === 0) continue;
    memCache.delete(url);
    memBytes -= e.bytes;
  }
}

/** Cache API を開く（無い・開けない（http の非 localhost など）なら null） */
async function openCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/** Cache API から読む（30 日より古い・壊れていれば捨てて null） */
async function readCache(cache: Cache, url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await cache.match(url);
    if (!res) return null;
    const at = Number(res.headers.get(CACHED_AT_HEADER));
    if (!Number.isFinite(at) || Date.now() - at > CACHE_MAX_AGE_MS) {
      void cache.delete(url).catch(() => undefined);
      return null;
    }
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

/** Cache API に書く（容量超過などは無視する） */
async function writeCache(cache: Cache, url: string, buf: ArrayBuffer, contentType: string | null): Promise<void> {
  try {
    await cache.put(url, new Response(buf, { headers: { 'content-type': contentType ?? 'application/octet-stream', [CACHED_AT_HEADER]: String(Date.now()) } }));
  } catch {
    /* 容量超過・opaque など: キャッシュできなくても取得は成功している */
  }
}

/** Cache API 'plateau-tiles-v1'（typeof caches のガード・30 日）＋ メモリ LRU（URL → Promise<ArrayBuffer>、80 MB） */
export async function fetchCached(url: string, opts?: NetOpts): Promise<ArrayBuffer> {
  throwIfAborted(opts?.signal);
  const hit = memTouch(url);
  if (hit) return hit.promise;
  const f = opts?.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const load = async (): Promise<ArrayBuffer> => {
    const cache = await openCache();
    if (cache) {
      const cached = await readCache(cache, url);
      if (cached) return cached;
    }
    throwIfAborted(opts?.signal);
    const res = await f(url, { signal: opts?.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    const buf = await res.arrayBuffer();
    if (cache) void writeCache(cache, url, buf, res.headers.get('content-type'));
    return buf;
  };
  const entry: MemEntry = { promise: load(), bytes: 0 };
  memCache.set(url, entry);
  entry.promise.then(
    (buf) => {
      if (memCache.get(url) !== entry) return;
      entry.bytes = buf.byteLength;
      memBytes += buf.byteLength;
      memEvict();
    },
    () => {
      // 失敗（中止を含む）は残さない: 次の呼び出しで取り直す
      if (memCache.get(url) === entry) memCache.delete(url);
    },
  );
  return entry.promise;
}

// ---------------------------------------------------------------------------
// 復号・分割済みタイルのキャッシュ（URL キー・LRU 24 枚）
// ---------------------------------------------------------------------------

interface TileEntry {
  b3dm: B3dm;
  records: BuildingRecord[];
  /** 復号は 1 回だけ（必要になった時点で始める） */
  decoded: Promise<DecodedTile> | null;
  /** batchId → 建物（分割できた棟） */
  buildings: Map<number, PlateauBuilding>;
  /** 分割を試みた batchId（建物にならなかった棟も含む。二度試さない） */
  tried: Set<number>;
}

const splitCache = new Map<string, TileEntry>();

function splitTouch(url: string): TileEntry | undefined {
  const e = splitCache.get(url);
  if (e) {
    splitCache.delete(url);
    splitCache.set(url, e);
  }
  return e;
}

function splitPut(url: string, e: TileEntry): void {
  splitCache.set(url, e);
  for (const k of splitCache.keys()) {
    if (splitCache.size <= SPLIT_LRU_TILES) break;
    splitCache.delete(k);
  }
}

/** メモリ LRU・分割キャッシュ・Cache API をすべて空にする（テスト・「周辺建物を取り直す」の強制再取得用） */
export async function clearPlateauCaches(): Promise<void> {
  memCache.clear();
  memBytes = 0;
  splitCache.clear();
  if (typeof caches !== 'undefined') {
    try {
      await caches.delete(CACHE_NAME);
    } catch {
      /* Cache API が使えない環境 */
    }
  }
}

// ---------------------------------------------------------------------------
// パイプライン
// ---------------------------------------------------------------------------

/** 選んだ葉とそのデータセット */
interface Selected {
  tile: ContentTile;
  ds: PlateauDatasetInfo;
}

/** デコーダが用意できない（wasm/js とも失敗）ことを示す。全体を error/decode に畳む */
class DecoderUnavailable extends Error {
  constructor(cause: unknown) {
    super(`Draco デコーダを用意できません（${errorMessage(cause)}）`);
    this.name = 'DecoderUnavailable';
  }
}

const isThenable = (v: unknown): v is PromiseLike<unknown> => !!v && typeof (v as PromiseLike<unknown>).then === 'function';

/** 記録の矩形（_xmin.._ymax）または _x/_y までの距離が radiusM 以内か。どちらも無ければ判定できないので残す */
function withinRadius(r: BuildingRecord, lat: number, lon: number, radiusM: number): boolean {
  if (r.xmin != null && r.xmax != null && r.ymin != null && r.ymax != null) {
    return degBoxDistanceM(lat, lon, { west: r.xmin, south: r.ymin, east: r.xmax, north: r.ymax }) <= radiusM;
  }
  if (r.x != null && r.y != null) return degBoxDistanceM(lat, lon, { west: r.x, south: r.y, east: r.x, north: r.y }) <= radiusM;
  return true;
}

const fmtMB = (bytes: number) => (bytes / 1048576).toFixed(1);

/** 中止は signal.reason を throw。他は status に畳む */
export async function fetchPlateauBuildings(lat: number, lon: number, radiusM: number, opts?: PlateauFetchOptions): Promise<PlateauFetchResult> {
  const o = opts ?? {};
  const signal = o.signal;
  const net: NetOpts = { fetchImpl: o.fetchImpl, signal };
  const nearM = o.nearM ?? DEFAULTS.nearM;
  const reachFactor = o.reachFactor ?? DEFAULTS.reachFactor;
  const reachMargin = o.reachMargin ?? DEFAULTS.reachMargin;
  const marginM = o.marginM ?? DEFAULTS.marginM;
  const maxTiles = o.maxTiles ?? DEFAULTS.maxTiles;
  const maxBytes = o.maxBytes ?? DEFAULTS.maxBytes;
  const concurrency = Math.max(1, Math.floor(o.concurrency ?? DEFAULTS.concurrency));
  const box = degBoxAround(lat, lon, radiusM + marginM);

  let stage: PlateauStage = 'geocode';
  const progress = (p: Omit<PlateauProgress, 'stage'>) => o.onProgress?.({ stage, ...p });

  // デコーダ（注入があればそれ、無ければモジュール既定の DRACOLoader を preload 待ち）。失敗は error/decode に畳む
  let decoderPending: Promise<DracoDecoderLike> | null = null;
  const getDecoder = (): Promise<DracoDecoderLike> =>
    (decoderPending ??= (async () => {
      try {
        if (o.draco) {
          const r = o.draco.preload();
          if (isThenable(r)) await r;
          return o.draco;
        }
        await ensureDracoReady();
        return getDracoDecoder();
      } catch (e) {
        throw new DecoderUnavailable(e);
      }
    })());

  try {
    // 1. geocode
    throwIfAborted(signal);
    progress({ message: '市区町村を調べています', done: 0, total: 1, bytes: 0, totalBytes: null, ratio: 0.02 });
    let muniCds: string[];
    let geocodeError: string | null = null;
    try {
      muniCds = await muniCodesAround(lat, lon, radiusM + marginM, net);
    } catch (e) {
      rethrowIfAborted(e, signal);
      geocodeError = errorMessage(e);
      muniCds = [];
    }

    // 2. index
    stage = 'index';
    throwIfAborted(signal);
    progress({ message: 'PLATEAU の索引を読み込んでいます', done: 0, total: 1, bytes: 0, totalBytes: null, ratio: 0.06 });
    let index;
    try {
      index = await loadPlateauIndex({ ...net, url: o.indexUrl });
    } catch (e) {
      rethrowIfAborted(e, signal);
      // 逆ジオコーダも索引も取れない: 原因は通信（最初に失敗した段で報告）
      if (geocodeError) return { status: 'error', stage: 'geocode', message: `逆ジオコーダと PLATEAU の索引を取得できません（${geocodeError} / ${errorMessage(e)}）` };
      return { status: 'error', stage: 'index', message: errorMessage(e) };
    }
    if (muniCds.length === 0) {
      // 逆ジオコーダ不通: 索引の region（W16）で市区を引く予備経路
      muniCds = muniCodesByRegion(index, box);
      if (muniCds.length === 0) return { status: 'error', stage: 'geocode', message: geocodeError ?? '市区町村コードが分かりません' };
    }
    const missingMuniCds: string[] = [];
    const candidates: PlateauDatasetInfo[] = [];
    for (const cd of muniCds) {
      const ds = pickDataset(index, cd);
      if (ds) candidates.push(ds);
      else missingMuniCds.push(cd);
    }
    if (candidates.length === 0) return { status: 'none', reason: 'outside', muniCds };

    // 3. tileset（解決 → 取得 → 解釈 → 葉の選択）
    stage = 'tileset';
    throwIfAborted(signal);
    progress({ message: `建物タイルの一覧を取得（${candidates.map((d) => d.label).join('・')}）`, done: 0, total: candidates.length, bytes: 0, totalBytes: null, ratio: 0.1 });
    const tilesetErrors: string[] = [];
    let selected: Selected[] = [];
    let truncated = false;
    const usable: PlateauDatasetInfo[] = [];
    await Promise.all(
      candidates.map(async (ds0) => {
        try {
          const r = await resolveTilesetUrl(ds0, net);
          if (r.missing) {
            // -latest が「データセット無し」: 索引が古い。未整備側に寄せる
            missingMuniCds.push(ds0.muniCd);
            return;
          }
          const ds: PlateauDatasetInfo = r.url === ds0.tilesetUrl ? ds0 : { ...ds0, tilesetUrl: r.url };
          const buf = await fetchCached(ds.tilesetUrl, net);
          const json: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
          const ts = parseTileset(json, ds.tilesetUrl);
          const sel = selectContentTiles(ts, box, { lat, lon, nearM, reachFactor, reachMargin, maxTiles });
          if (sel.truncated) truncated = true;
          usable.push(ds);
          for (const tile of sel.tiles) selected.push({ tile, ds });
        } catch (e) {
          rethrowIfAborted(e, signal);
          tilesetErrors.push(`${ds0.label}: ${errorMessage(e)}`);
        }
      }),
    );
    throwIfAborted(signal);
    if (usable.length === 0) {
      if (tilesetErrors.length > 0) return { status: 'error', stage: 'tileset', message: `tileset.json を取得できません（${tilesetErrors.join(' / ')}）` };
      return { status: 'none', reason: 'outside', muniCds };
    }
    // 複数データセットの葉を合わせて近い順（同距離は深い順 → URL 順）。同じ URL は 1 回
    selected.sort((a, b) => a.tile.distanceM - b.tile.distanceM || b.tile.depth - a.tile.depth || (a.tile.url < b.tile.url ? -1 : a.tile.url > b.tile.url ? 1 : 0));
    const seenUrl = new Set<string>();
    selected = selected.filter((s) => (seenUrl.has(s.tile.url) ? false : (seenUrl.add(s.tile.url), true)));
    if (selected.length > maxTiles) {
      selected = selected.slice(0, Math.max(0, maxTiles));
      truncated = true;
    }
    if (selected.length === 0) return { status: 'none', reason: 'noTiles', muniCds };

    // 4. tiles（並列ダウンロード。maxBytes の予算を超えそうなら残りを捨てる）
    stage = 'tiles';
    const total = selected.length;
    const buffers: (ArrayBuffer | null)[] = new Array(total).fill(null);
    const downloadMs: number[] = new Array(total).fill(0);
    /** 取得を試みた葉（予算切れで捨てた葉は false のまま） */
    const tried: boolean[] = new Array(total).fill(false);
    let failedTiles = 0;
    let bytes = 0;
    let done = 0;
    let next = 0;
    let inflight = 0;
    progress({ message: `建物タイル 0/${total}（0.0 MB）`, done: 0, total, bytes: 0, totalBytes: null, ratio: 0.12 });
    const worker = async () => {
      for (;;) {
        throwIfAborted(signal);
        if (next >= total) return;
        if (bytes + inflight * UNKNOWN_TILE_BYTES > maxBytes) {
          // 予算切れ: 残り（遠い方）は捨てる
          truncated = true;
          next = total;
          return;
        }
        const i = next++;
        tried[i] = true;
        inflight++;
        const t0 = performance.now();
        try {
          const buf = await fetchCached(selected[i].tile.url, net);
          buffers[i] = buf;
          bytes += buf.byteLength;
        } catch (e) {
          rethrowIfAborted(e, signal);
          failedTiles++;
        } finally {
          inflight--;
          downloadMs[i] = performance.now() - t0;
        }
        done++;
        progress({ message: `建物タイル ${done}/${total}（${fmtMB(bytes)} MB）`, done, total, bytes, totalBytes: null, ratio: 0.12 + 0.68 * (done / total) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    throwIfAborted(signal);
    // 予算で捨てた分は total から外す（失敗ではない）
    const attempted = selected.filter((_, i) => tried[i]);
    const attemptedBuffers = buffers.filter((_, i) => tried[i]);
    const attemptedMs = downloadMs.filter((_, i) => tried[i]);
    if (attempted.length > 0 && failedTiles >= attempted.length) {
      return { status: 'error', stage: 'tiles', message: `建物タイルを 1 枚も取得できません（${attempted.length} 枚とも失敗）` };
    }

    // 5. decode（parseB3dm → keep → 復号 → 分割。順に進める）
    stage = 'decode';
    const tileStats: { url: string; bytes: number; buildings: number; ms: number }[] = [];
    const perTile: PlateauBuilding[][] = [];
    let totalBuildings = 0;
    for (let i = 0; i < attempted.length; i++) {
      throwIfAborted(signal);
      const buf = attemptedBuffers[i];
      const { tile, ds } = attempted[i];
      if (!buf) continue;
      const t0 = performance.now();
      try {
        const list = await splitTile(tile.url, buf, ds, lat, lon, radiusM, getDecoder);
        perTile.push(list);
        totalBuildings += list.length;
        tileStats.push({ url: tile.url, bytes: buf.byteLength, buildings: list.length, ms: attemptedMs[i] + (performance.now() - t0) });
      } catch (e) {
        rethrowIfAborted(e, signal);
        if (e instanceof DecoderUnavailable) return { status: 'error', stage: 'decode', message: e.message };
        failedTiles++;
        console.warn(`PLATEAU: 建物タイルを読めません（${tile.url}）`, e);
      }
      progress({ message: `建物の形状を復号（${totalBuildings.toLocaleString('ja-JP')} 棟）`, done: i + 1, total: attempted.length, bytes, totalBytes: null, ratio: 0.8 + 0.17 * ((i + 1) / attempted.length) });
    }
    if (tileStats.length === 0) return { status: 'error', stage: 'tiles', message: `建物タイルを 1 枚も読めません（${attempted.length} 枚とも失敗）` };

    // 6. merge（gml_id で重複除去。近い葉が先）
    stage = 'merge';
    progress({ message: '周辺建物を統合しています…', done: 0, total: 1, bytes, totalBytes: null, ratio: 0.98 });
    const seen = new Set<string>();
    const buildings: PlateauBuilding[] = [];
    const lodCounts: Record<string, number> = {};
    for (const list of perTile) {
      for (const b of list) {
        if (seen.has(b.gmlId)) continue;
        seen.add(b.gmlId);
        buildings.push(b);
        const key = String(b.attrs.lod ?? b.attrs.datasetLod);
        lodCounts[key] = (lodCounts[key] ?? 0) + 1;
      }
    }
    if (buildings.length === 0) return { status: 'none', reason: 'noTiles', muniCds };
    // 使ったデータセット = 読んだ葉を持つもの（市区ごとに 1 件）。順序は候補（中心の市区が先頭）のまま
    const usedCds = new Set(attempted.map((s) => s.ds.muniCd));
    const datasets = usable.filter((d) => usedCds.has(d.muniCd)).sort((a, b) => candidates.findIndex((c) => c.muniCd === a.muniCd) - candidates.findIndex((c) => c.muniCd === b.muniCd));
    progress({ message: `周辺建物 ${buildings.length.toLocaleString('ja-JP')} 棟`, done: 1, total: 1, bytes, totalBytes: null, ratio: 1 });
    return { status: 'covered', buildings, datasets, tiles: tileStats, failedTiles, truncated, lodCounts, missingMuniCds };
  } catch (e) {
    rethrowIfAborted(e, signal);
    return { status: 'error', stage, message: errorMessage(e) };
  }
}

/**
 * タイル 1 枚: parseB3dm → 記録 → keep（半径内の棟）→ 未分割の棟があれば復号して splitBuildings → 半径内の棟を返す。
 * 復号・分割は URL キーのキャッシュに積む（ピンが動いても再復号しない）
 */
async function splitTile(url: string, buf: ArrayBuffer, ds: PlateauDatasetInfo, lat: number, lon: number, radiusM: number, getDecoder: () => Promise<DracoDecoderLike>): Promise<PlateauBuilding[]> {
  let entry = splitTouch(url);
  if (!entry) {
    const b3dm = parseB3dm(buf);
    entry = { b3dm, records: readBuildingRecords(b3dm.batchTable), decoded: null, buildings: new Map(), tried: new Set() };
    splitPut(url, entry);
  }
  const keepIds = entry.records.filter((r) => withinRadius(r, lat, lon, radiusM)).map((r) => r.batchId);
  if (keepIds.length === 0) return [];
  const need = new Set(keepIds.filter((id) => !entry!.tried.has(id)));
  if (need.size > 0) {
    const draco = await getDecoder();
    entry.decoded ??= decodeTileGlb(entry.b3dm.glb, draco);
    let tile: DecodedTile;
    try {
      tile = await entry.decoded;
    } catch (e) {
      entry.decoded = null;
      throw e;
    }
    const meta = { muniCd: ds.muniCd, pref: ds.pref, city: ds.city, ward: ds.ward, year: ds.year, datasetLod: ds.lod };
    const res = splitBuildings(tile, entry.b3dm, meta, { keep: (r) => need.has(r.batchId), tileUrl: url });
    for (const b of res.buildings) entry.buildings.set(b.batchId, b);
    for (const id of need) entry.tried.add(id);
  }
  const out: PlateauBuilding[] = [];
  for (const id of keepIds) {
    const b = entry.buildings.get(id);
    if (b) out.push(b);
  }
  return out;
}
