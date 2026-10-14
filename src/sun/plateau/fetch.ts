/**
 * 両アプリ共通の入口: 葉選択 → 並列取得 → keep → 復号 → 分割 → 重複除去 → 状態（§4 のパイプライン）。
 *
 * fetchPlateauBuildings の段階（PlateauStage。進捗もこの順に出る）:
 *  1. geocode: muniCodesAround（中心＋±(radius+marginM) の 4 隅）。全滅 → 索引に region があれば muniCodesByRegion、それも無ければ error
 *  2. index:   loadPlateauIndex → pickDataset。索引に無い市区は missingMuniCds に。ピンの市区のコードが索引に無ければ（市区町村コードの改編:
 *              浜松市 2024 年の区再編で逆ジオコーダは新コード 22138 を返すが索引は旧 22131〜22137）索引の region のうちピンを含む市区を
 *              候補に足す（regionAdded。注記用）。救済できたらピンのコードだけ missingMuniCds から外す（隅の未整備な隣接市区は残す）。
 *              隅のコードが索引に無いだけなら未整備の隣接市区（救済しない）。候補が 1 件も無ければ none/outside
 *  3. tileset: データセットごとに resolveTilesetUrl（-latest → 索引 URL）→ fetchCached → parseTileset。-latest に無い（missing）データセットは
 *              索引の tileset.json を試し、それが 4xx なら対象外側（missingMuniCds）に、取れるなら index 経由で続ける（浜松市の旧 7 区）。
 *              取得失敗はそのデータセットだけ落とす（全滅で error/tileset）。葉の選択（selectContentTiles）もここで行い、
 *              複数データセットの葉を合わせて近い順に並べ、maxTiles を超えた分は遠い方から捨てる（truncated）。
 *              葉を選ぶ箱は半径そのもの（radiusM）で、region までの距離が radiusM を超える葉は読まない: keep（棟の矩形までの距離 ≤ radiusM）
 *              と整合させる（棟の矩形は葉の region の内側なので、region が半径の外の葉には keep される棟が無い。marginM は市区の判定だけに使う）
 *  4. tiles:   並列 concurrency で fetchCached（進捗はバイト。totalBytes は Content-Length の合計、不明な葉は 3 MB の見積り）。
 *              maxBytes は Content-Length の累計（近い葉から順。最初の 1 枚は必ず取る）で判定し、超えた葉から先は捨てる（truncated）。
 *              判定は「自分より近い葉のサイズが出そろってから」行うので、結果は並列数に依らない。失敗は failedTiles。
 *              Draco デコーダの用意（ensureDracoReady）はこの段と並列に始め、用意できないと分かったらダウンロードを止めて error/decode
 *  5. decode:  タイルごとに parseB3dm → readBuildingRecords → keep（_xmin.._ymax 矩形までの距離 ≤ radiusM）→ 1 棟も無ければ復号しない →
 *              decodeTileGlb → splitBuildings。ダウンロードを全部終えてから順に行う（進捗の段階が前後しない）。読めないタイルはキャッシュから捨てる
 *  6. merge:   gml_id で重複除去（先に来た＝近い葉を優先）、lodCounts
 *
 * 返す PlateauBuilding.ring/holes/mesh は anchor 基準。ピン基準への変換は呼び出し側（frameToLocal(pin, anchor) を足す）。
 * 復号・分割済みタイルは URL キーで LRU（24 枚）に保持し、ピンが変わっても再復号しない（anchor 基準なので再利用できる）。
 * 分割は棟ごとに増やす: 前回 keep に入らなかった棟だけを次回 splitBuildings に掛ける（keep は半径に依るため）。
 * 生バイトは fetchCached（Cache API 'plateau-tiles-v1' 30 日 ＋ メモリ LRU 80 MB）。200 でも中身（.b3dm の magic・.json の構文）を検証してから書く。
 * 中止は signal.reason を throw、それ以外の失敗は status に畳む。
 * 期限（第 2 回レビュー）: 段ごとの期限（PLATEAU_TIMEOUTS。opts.timeouts で上書き）を呼び出し側の signal と合成して fetchImpl に渡す
 * （geocode/index/-latest は catalog.ts の NetOpts.timeoutMs、tileset/タイルは linkedController のタイマー）。期限切れは中止ではなく
 * 失敗: rethrowIfAborted は呼び出し側の signal だけ見るので、逆ジオコーダの期限切れは region 予備経路へ、tileset は error/tileset、
 * タイルは failedTiles に落ちる（無応答のサーバで fetchPlateauBuildings が永遠に返らないことはない）
 * 仕様: scratchpad/plateau-spec.md §2.9・§4（W7 が実装）
 */
import { degBoxAround, degBoxDistanceM } from '../geodesy';
import { parseB3dm, peekB3dmHeader, type B3dm } from './b3dm';
import { readBuildingRecords, splitBuildings, type BuildingRecord, type SplitMeta } from './buildings';
import { PLATEAU_TIMEOUTS, loadPlateauIndex, muniCodesAround, muniCodesByRegion, pickDataset, resolveTilesetUrl, timeoutReason, type NetOpts } from './catalog';
import { ensureDracoReady, getDracoDecoder } from './draco';
import { decodeTileGlb } from './glb';
import { parseTileset, selectContentTiles, type ContentTile } from './tileset';
import type { DecodedTile, DracoDecoderLike, PlateauBuilding, PlateauDatasetInfo, PlateauNetStage, PlateauProgress, PlateauStage, PlateauTimeouts } from './types';

export interface PlateauFetchOptions extends Omit<NetOpts, 'timeoutMs'> {
  onProgress?: (p: PlateauProgress) => void;
  /** 段ごとの期限 [ms]。省略した段は PLATEAU_TIMEOUTS（geocode 8 s・index 10 s・latest 8 s・tileset 20 s・tile 60 s）。テストでは短くする */
  timeouts?: PlateauTimeouts;
  /** 省略時は getDracoDecoder() */
  draco?: DracoDecoderLike;
  indexUrl?: string | URL;
  /** この距離までの葉は全部読む（既定 150 m） */
  nearM?: number;
  /** 1 / tan(8.2°): 高さ 1 m の建物の影が届く距離（既定 6.9） */
  reachFactor?: number;
  /** 遠い葉は「影の届く距離 − 葉までの距離」がこの余裕以内なら読む（既定 60 m） */
  reachMargin?: number;
  /** 市区の判定（逆ジオコーダの 4 隅・索引の region）で半径に足す余白（既定 30 m）。葉の選択には使わない */
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
      /** 索引に無い市区（注記用。改編の救済で region から市区を足せたときは空） */
      missingMuniCds: string[];
      /** 逆ジオコーダのコードが索引に無く、索引の region で足した市区（市区町村コードの改編の救済。注記用） */
      regionAdded?: string[];
    }
  | { status: 'none'; reason: 'outside' | 'noTiles'; muniCds: string[] }
  | { status: 'error'; stage: PlateauStage; message: string };

/** fetchCached の追加オプション */
export interface FetchCachedOptions extends NetOpts {
  /** 応答ヘッダが読めた時点で Content-Length（無ければ null）を知らせる。メモリ LRU・Cache API から返すときは実際のバイト数 */
  onHeaders?: (contentLength: number | null) => void;
}

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
/** Content-Length が分からないときの 1 枚の見積り（maxBytes の判定・totalBytes 用。世田谷の葉 ≈ 3 MB） */
const UNKNOWN_TILE_BYTES = 3 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

function abortReason(signal: AbortSignal): Error {
  return (signal.reason as Error | undefined) ?? new Error('中止しました');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** 中止による失敗なら signal.reason を投げ直す（それ以外は呼び出し側が status に畳む） */
function rethrowIfAborted(e: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) throw (signal.reason as Error | undefined) ?? e;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 既定の fetch（globalThis.fetch を呼ぶ時点で解決する） */
const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

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
  /** 応答ヘッダの Content-Length（無ければ null。キャッシュから返すときは実バイト数。取得に失敗したら null） */
  headers: Promise<number | null>;
  /** 待っている呼び出しの数。全員が中止したら下層の fetch も中止する */
  waiters: number;
  /** 下層の fetch の中止用（呼び出しごとの signal は束ねて、ここには直接渡さない） */
  controller: AbortController;
  settled: boolean;
}

/** URL → 取得中／取得済みの項目（Map の挿入順 = 古い順。触ったら末尾に移す） */
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

/**
 * URL の拡張子で中身を検証する: .b3dm は magic 'b3dm' と version（peekB3dmHeader）、.json は JSON.parse。他は検証しない。
 * 200 で返ってきたエラーページ（キャプティブポータル・CDN の HTML など）を 30 日キャッシュしないため
 */
function validateContent(url: string, buf: ArrayBuffer): void {
  const path = url.replace(/[?#].*$/, '');
  if (/\.b3dm$/i.test(path)) {
    peekB3dmHeader(buf);
  } else if (/\.json$/i.test(path)) {
    try {
      JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
    } catch (e) {
      throw new Error(`JSON ではありません（${errorMessage(e)}）`);
    }
  }
}

/** Cache API から読む（30 日より古い・中身が不正・壊れていれば捨てて null） */
async function readCache(cache: Cache, url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await cache.match(url);
    if (!res) return null;
    const at = Number(res.headers.get(CACHED_AT_HEADER));
    if (!Number.isFinite(at) || Date.now() - at > CACHE_MAX_AGE_MS) {
      void cache.delete(url).catch(() => undefined);
      return null;
    }
    const buf = await res.arrayBuffer();
    try {
      validateContent(url, buf);
    } catch {
      void cache.delete(url).catch(() => undefined);
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

/** 進行中の Cache API への書き込み（clearPlateauCaches が待つ） */
const pendingPuts = new Set<Promise<void>>();
/** clearPlateauCaches のたびに増える。書き込みの最中に空にされたら、その書き込みは自分で消す */
let cacheGeneration = 0;

/** Cache API に書く（容量超過などは無視する）。進行中の書き込みは pendingPuts に控える */
function writeCache(cache: Cache, url: string, buf: ArrayBuffer, contentType: string | null): void {
  const gen = cacheGeneration;
  const p = (async () => {
    try {
      await cache.put(url, new Response(buf, { headers: { 'content-type': contentType ?? 'application/octet-stream', [CACHED_AT_HEADER]: String(Date.now()) } }));
      // put の最中に clearPlateauCaches が走った: 消したはずの項目を復活させない
      if (gen !== cacheGeneration) await cache.delete(url);
    } catch {
      /* 容量超過・opaque など: キャッシュできなくても取得は成功している */
    }
  })();
  pendingPuts.add(p);
  void p.then(() => pendingPuts.delete(p));
}

/** 取得を始めてメモリ LRU に登録する（呼び出し側の signal は渡さない。中止は waitEntry が束ねる） */
function startLoad(url: string, fetchImpl?: typeof fetch): MemEntry {
  const f = fetchImpl ?? defaultFetch;
  const controller = new AbortController();
  let resolveHeaders: (n: number | null) => void = () => undefined;
  const headers = new Promise<number | null>((r) => {
    resolveHeaders = r;
  });
  const load = async (): Promise<ArrayBuffer> => {
    try {
      const cache = await openCache();
      if (cache) {
        const cached = await readCache(cache, url);
        if (cached) {
          resolveHeaders(cached.byteLength);
          return cached;
        }
      }
      throwIfAborted(controller.signal);
      const res = await f(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      const lenHeader = res.headers.get('content-length');
      const len = lenHeader === null ? NaN : Number(lenHeader);
      resolveHeaders(Number.isFinite(len) && len >= 0 ? len : null);
      const buf = await res.arrayBuffer();
      throwIfAborted(controller.signal);
      try {
        validateContent(url, buf);
      } catch (e) {
        throw new Error(`応答の中身が不正です（${errorMessage(e)}）: ${url}`);
      }
      if (cache) writeCache(cache, url, buf, res.headers.get('content-type'));
      return buf;
    } finally {
      // 失敗・中止でヘッダが出なかった分（既に解決していれば何もしない）
      resolveHeaders(null);
    }
  };
  const entry: MemEntry = { promise: load(), bytes: 0, headers, waiters: 0, controller, settled: false };
  memCache.set(url, entry);
  entry.promise.then(
    (buf) => {
      entry.settled = true;
      if (memCache.get(url) !== entry) return;
      entry.bytes = buf.byteLength;
      memBytes += buf.byteLength;
      memEvict();
    },
    () => {
      // 失敗（中止・中身の不正を含む）は残さない: 次の呼び出しで取り直す
      entry.settled = true;
      if (memCache.get(url) === entry) memCache.delete(url);
    },
  );
  return entry;
}

/**
 * 共有の取得を自分の signal で待つ。中止したら自分だけ reject し、待っている全員が中止したときだけ下層の fetch を中止する
 * （先に始めた呼び出しの中止が、同じ URL を待つ別の呼び出しに伝播しない）
 */
function waitEntry(entry: MemEntry, signal?: AbortSignal, onHeaders?: (contentLength: number | null) => void): Promise<ArrayBuffer> {
  entry.waiters++;
  if (onHeaders) void entry.headers.then((n) => (signal?.aborted ? undefined : onHeaders(n)));
  return new Promise<ArrayBuffer>((resolve, reject) => {
    let done = false;
    const finish = () => {
      done = true;
      entry.waiters--;
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (done) return;
      finish();
      if (entry.waiters === 0 && !entry.settled) entry.controller.abort(abortReason(signal!));
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(
      (v) => {
        if (done) return;
        finish();
        resolve(v);
      },
      (e) => {
        if (done) return;
        finish();
        reject(e);
      },
    );
  });
}

/**
 * Cache API 'plateau-tiles-v1'（typeof caches のガード・30 日）＋ メモリ LRU（URL → Promise<ArrayBuffer>、80 MB）。
 * 200 でも中身（.b3dm の magic・.json の構文）を検証してからキャッシュに書く。不正な中身は失敗（Error）でキャッシュしない。
 * 同じ URL の取得は 1 本に束ね、呼び出しごとの signal で待つ（opts.onHeaders で Content-Length を受け取れる）
 */
export async function fetchCached(url: string, opts?: FetchCachedOptions): Promise<ArrayBuffer> {
  throwIfAborted(opts?.signal);
  let entry = memTouch(url);
  if (!entry || entry.controller.signal.aborted) entry = startLoad(url, opts?.fetchImpl);
  return waitEntry(entry, opts?.signal, opts?.onHeaders);
}

/** 1 つの URL をメモリ LRU・分割キャッシュ・Cache API から捨てる（200 で返ってきたが読めなかったタイル用） */
async function evictCached(url: string): Promise<void> {
  const e = memCache.get(url);
  if (e) {
    memCache.delete(url);
    memBytes -= e.bytes;
  }
  splitCache.delete(url);
  const cache = await openCache();
  if (cache) await cache.delete(url).catch(() => undefined);
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

/**
 * メモリ LRU・分割キャッシュ・Cache API をすべて空にする（テスト・「周辺建物を取り直す」の強制再取得用）。
 * 進行中の Cache API への書き込みを待ってから消す（消した直後に遅い put が完了して項目が復活しないように）
 */
export async function clearPlateauCaches(): Promise<void> {
  cacheGeneration++;
  memCache.clear();
  memBytes = 0;
  splitCache.clear();
  if (typeof caches !== 'undefined') {
    await Promise.allSettled([...pendingPuts]);
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

/** maxBytes の予算で捨てた葉の取得を中止する理由（failedTiles には数えない） */
class BudgetExceeded extends Error {
  constructor() {
    super('データ量の上限（maxBytes）');
    this.name = 'BudgetExceeded';
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

/**
 * 親の signal に連動する AbortController（tileset.json・タイル 1 枚ごとの中止用）。timeoutMs（正の有限数）を渡すと期限で abort する
 * （理由は timeoutReason。親の中止とは区別され、呼び出し側は rethrowIfAborted(e, 親) で失敗として扱える）。使い終わったら dispose()
 */
function linkedController(parent?: AbortSignal, timeoutMs?: number): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortReason(parent!));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0 && !controller.signal.aborted ? setTimeout(() => controller.abort(timeoutReason(timeoutMs)), timeoutMs) : null;
  return {
    controller,
    dispose: () => {
      if (timer != null) clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

/** 中止は signal.reason を throw。他は status に畳む */
export async function fetchPlateauBuildings(lat: number, lon: number, radiusM: number, opts?: PlateauFetchOptions): Promise<PlateauFetchResult> {
  const o = opts ?? {};
  const signal = o.signal;
  const net: NetOpts = { fetchImpl: o.fetchImpl, signal };
  /** 段の期限 [ms]（opts.timeouts → 既定） */
  const timeoutOf = (s: PlateauNetStage): number => o.timeouts?.[s] ?? PLATEAU_TIMEOUTS[s];
  const nearM = o.nearM ?? DEFAULTS.nearM;
  const reachFactor = o.reachFactor ?? DEFAULTS.reachFactor;
  const reachMargin = o.reachMargin ?? DEFAULTS.reachMargin;
  const marginM = o.marginM ?? DEFAULTS.marginM;
  const maxTiles = o.maxTiles ?? DEFAULTS.maxTiles;
  const maxBytes = o.maxBytes ?? DEFAULTS.maxBytes;
  const concurrency = Math.max(1, Math.floor(o.concurrency ?? DEFAULTS.concurrency));
  /** 市区の判定（索引の region の予備経路）に使う箱。余白付き */
  const muniBox = degBoxAround(lat, lon, radiusM + marginM);
  /** 葉の選択に使う箱。半径そのもの（keep の判定と整合させる） */
  const selectBox = degBoxAround(lat, lon, radiusM);

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
      muniCds = await muniCodesAround(lat, lon, radiusM + marginM, { ...net, timeoutMs: timeoutOf('geocode') });
    } catch (e) {
      // 期限切れもここ（中止は呼び出し側の signal だけ）: region の予備経路へ
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
      index = await loadPlateauIndex({ ...net, url: o.indexUrl, timeoutMs: timeoutOf('index') });
    } catch (e) {
      rethrowIfAborted(e, signal);
      // 逆ジオコーダも索引も取れない: 原因は通信（最初に失敗した段で報告）
      if (geocodeError) return { status: 'error', stage: 'geocode', message: `逆ジオコーダと PLATEAU の索引を取得できません（${geocodeError} / ${errorMessage(e)}）` };
      return { status: 'error', stage: 'index', message: errorMessage(e) };
    }
    const pinBox = { west: lon, east: lon, south: lat, north: lat };
    if (muniCds.length === 0) {
      // 逆ジオコーダ不通: 索引の region（W16）で市区を引く予備経路。ピンを含む市区を先頭に、続けて箱と交差する市区
      const inPin = muniCodesByRegion(index, pinBox);
      muniCds = [...inPin, ...muniCodesByRegion(index, muniBox).filter((cd) => !inPin.includes(cd))];
      if (muniCds.length === 0) return { status: 'error', stage: 'geocode', message: geocodeError ?? '市区町村コードが分かりません' };
    } else {
      // 逆ジオコーダは中心を先頭に返すが、中心の 1 点だけ失敗して隅だけ取れたときは隣接市区が先頭になる。
      // 索引の region でピンを含む市区を先頭に並べ直す（datasets[0]・注記の先頭がピンの市区になる約束を保つ。順序以外は変えない）
      const inPin = new Set(muniCodesByRegion(index, pinBox));
      muniCds = [...muniCds.filter((cd) => inPin.has(cd)), ...muniCds.filter((cd) => !inPin.has(cd))];
    }
    let missingMuniCds: string[] = [];
    const candidates: PlateauDatasetInfo[] = [];
    for (const cd of muniCds) {
      const ds = pickDataset(index, cd);
      if (ds) candidates.push(ds);
      else missingMuniCds.push(cd);
    }
    /** 索引の region で足した市区（注記用。市区町村コードの改編の救済） */
    const regionAdded: string[] = [];
    const centerCd = muniCds[0];
    if (centerCd !== undefined && missingMuniCds.includes(centerCd)) {
      // ピン（中心）の市区のコードが索引に無い: 市区町村コードの改編（浜松市 2024: 22138 ↔ 索引 22131〜22137）か本当に未整備か。
      // 索引の region（索引生成時に -latest または tileset.json の root.region から付ける）のうち **ピンを含む** 市区だけ候補に足す
      // （箱と交差するだけの無関係な隣接市区は足さない。隅のコードが索引に無いだけなら未整備の隣接市区なので救済しない）。
      // 救済できたらピンのコードだけを missingMuniCds から外す（隅の未整備な隣接市区の注記は残す）
      const pinBox = { west: lon, east: lon, south: lat, north: lat };
      for (const cd of muniCodesByRegion(index, pinBox)) {
        if (candidates.some((c) => c.muniCd === cd)) continue;
        const ds = pickDataset(index, cd);
        if (!ds) continue;
        candidates.push(ds);
        regionAdded.push(cd);
      }
      if (regionAdded.length > 0) missingMuniCds = missingMuniCds.filter((cd) => cd !== centerCd);
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
        /** tileset.json の期限。-latest の期限は resolveTilesetUrl の中なので、計時は -latest の解決が終わってから始める（tileset.json が 20 s を丸ごと使える） */
        let linked: ReturnType<typeof linkedController> | null = null;
        try {
          const r = await resolveTilesetUrl(ds0, { ...net, timeoutMs: timeoutOf('latest') });
          const ds: PlateauDatasetInfo = r.url === ds0.tilesetUrl ? ds0 : { ...ds0, tilesetUrl: r.url };
          // 期限切れは中止ではなくそのデータセットの失敗
          linked = linkedController(signal, timeoutOf('tileset'));
          let buf: ArrayBuffer;
          try {
            buf = await fetchCached(ds.tilesetUrl, { fetchImpl: o.fetchImpl, signal: linked.controller.signal });
          } catch (e) {
            rethrowIfAborted(e, signal);
            // -latest が「データセット無し」（r.missing。索引の URL で試している）で、その索引の URL も 4xx: データセットが消えた → 未整備側に寄せる。
            // 索引の URL が取れる限りは index 経由で続ける（浜松市の旧 7 区: -latest には無いが tileset.json の配信は続いている）。
            // 通信エラー・期限切れ・5xx はデータセットの失敗（tilesetErrors → 全滅なら error/tileset）
            if (r.missing && /HTTP 4\d\d/.test(errorMessage(e))) {
              missingMuniCds.push(ds0.muniCd);
              return;
            }
            throw e;
          }
          const json: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
          const ts = parseTileset(json, ds.tilesetUrl);
          const sel = selectContentTiles(ts, selectBox, { lat, lon, nearM, reachFactor, reachMargin, maxTiles });
          if (sel.truncated) truncated = true;
          usable.push(ds);
          // region までの距離が半径を超える葉（箱の角で交差するだけ）は keep される棟が無いので読まない
          for (const tile of sel.tiles) if (tile.distanceM <= radiusM) selected.push({ tile, ds });
        } catch (e) {
          rethrowIfAborted(e, signal);
          tilesetErrors.push(`${ds0.label}: ${errorMessage(e)}`);
        } finally {
          linked?.dispose();
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

    // 4. tiles（並列ダウンロード。Content-Length の累計が maxBytes を超える葉から先は捨てる）
    stage = 'tiles';
    // デコーダの用意はダウンロードと並列に始める（wasm が配信できない環境では全部ダウンロードする前に error/decode にする）
    let decoderError: DecoderUnavailable | null = null;
    getDecoder().catch((e: unknown) => {
      decoderError = e instanceof DecoderUnavailable ? e : new DecoderUnavailable(e);
    });
    const total = selected.length;
    const buffers: (ArrayBuffer | null)[] = new Array(total).fill(null);
    const downloadMs: number[] = new Array(total).fill(0);
    /** 取得を決めた葉（予算で捨てた葉・デコーダ失敗で止めた葉は false のまま） */
    const admitted: boolean[] = new Array(total).fill(false);
    /** 予算で捨てた葉 */
    const dropped: boolean[] = new Array(total).fill(false);
    /** 葉ごとの Content-Length（不明なら見積り）。ヘッダが読めた時点・または失敗した時点（0）で解決する */
    const sizeOf: Promise<number>[] = [];
    const knownSize: (number | null)[] = new Array(total).fill(null);
    let failedTiles = 0;
    let bytes = 0;
    let done = 0;
    let next = 0;
    /** 進捗の分母: 捨てていない葉の Content-Length（不明なら見積り）の合計 */
    const totalBytes = () => {
      let s = 0;
      for (let i = 0; i < total; i++) if (!dropped[i]) s += knownSize[i] ?? UNKNOWN_TILE_BYTES;
      return s;
    };
    const remaining = () => dropped.reduce((n, d) => n + (d ? 0 : 1), 0);
    progress({ message: `建物タイル 0/${total}（0.0 MB）`, done: 0, total, bytes: 0, totalBytes: totalBytes(), ratio: 0.12 });
    const worker = async () => {
      for (;;) {
        throwIfAborted(signal);
        if (decoderError || next >= total) return;
        const i = next++;
        // 1 枚ごとの期限（予算で捨てるときの中止もこの controller）。期限切れは failedTiles（中止は親 signal だけ）
        const { controller, dispose } = linkedController(signal, timeoutOf('tile'));
        let resolveSize: (n: number) => void = () => undefined;
        sizeOf[i] = new Promise<number>((r) => {
          resolveSize = r;
        });
        const t0 = performance.now();
        const bufP = fetchCached(selected[i].tile.url, {
          fetchImpl: o.fetchImpl,
          signal: controller.signal,
          onHeaders: (len) => {
            knownSize[i] = len ?? UNKNOWN_TILE_BYTES;
            resolveSize(knownSize[i]!);
          },
        });
        bufP.catch(() => resolveSize(0));
        try {
          // 予算判定: 自分より近い葉のサイズが出そろってから、累計で見る（結果は並列数に依らず葉の順序とサイズだけで決まる）。最初の 1 枚は必ず取る
          const sizes = await Promise.all(sizeOf.slice(0, i + 1));
          const prefix = sizes.reduce((a, b) => a + b, 0);
          if (i > 0 && prefix > maxBytes) {
            truncated = true;
            dropped[i] = true;
            for (let k = next; k < total; k++) dropped[k] = true;
            next = total;
            controller.abort(new BudgetExceeded());
            await bufP.catch(() => undefined);
            dispose();
            progress({ message: `建物タイル ${done}/${remaining()}（${fmtMB(bytes)} MB）`, done, total: remaining(), bytes, totalBytes: totalBytes(), ratio: 0.12 + 0.68 * (done / remaining()) });
            continue;
          }
          admitted[i] = true;
          const buf = await bufP;
          buffers[i] = buf;
          bytes += buf.byteLength;
        } catch (e) {
          rethrowIfAborted(e, signal);
          failedTiles++;
          console.warn(`PLATEAU: 建物タイルを取得できません（${selected[i].tile.url}）`, e);
        } finally {
          dispose();
          downloadMs[i] = performance.now() - t0;
        }
        done++;
        progress({ message: `建物タイル ${done}/${remaining()}（${fmtMB(bytes)} MB）`, done, total: remaining(), bytes, totalBytes: totalBytes(), ratio: 0.12 + 0.68 * (done / remaining()) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    throwIfAborted(signal);
    if (decoderError) return { status: 'error', stage: 'decode', message: (decoderError as DecoderUnavailable).message };
    // 予算で捨てた分は total から外す（失敗ではない）
    const attempted = selected.filter((_, i) => admitted[i]);
    const attemptedBuffers = buffers.filter((_, i) => admitted[i]);
    const attemptedMs = downloadMs.filter((_, i) => admitted[i]);
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
        // 200 で返ってきたが読めない中身: キャッシュに残すと取り直しても直らないので捨てる
        await evictCached(tile.url);
      }
      progress({ message: `建物の形状を復号（${totalBuildings.toLocaleString('ja-JP')} 棟）`, done: i + 1, total: attempted.length, bytes, totalBytes: bytes, ratio: 0.8 + 0.17 * ((i + 1) / attempted.length) });
    }
    if (tileStats.length === 0) return { status: 'error', stage: 'tiles', message: `建物タイルを 1 枚も読めません（${attempted.length} 枚とも失敗）` };

    // 6. merge（gml_id で重複除去。近い葉が先）
    stage = 'merge';
    progress({ message: '周辺建物を統合しています…', done: 0, total: 1, bytes, totalBytes: bytes, ratio: 0.98 });
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
    progress({ message: `周辺建物 ${buildings.length.toLocaleString('ja-JP')} 棟`, done: 1, total: 1, bytes, totalBytes: bytes, ratio: 1 });
    return { status: 'covered', buildings, datasets, tiles: tileStats, failedTiles, truncated, lodCounts, missingMuniCds, regionAdded };
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
    const meta: SplitMeta = { muniCd: ds.muniCd, pref: ds.pref, city: ds.city, ward: ds.ward, year: ds.year, datasetLod: ds.lod, tileUrl: url };
    const res = splitBuildings(tile, entry.b3dm, meta, { keep: (r) => need.has(r.batchId) });
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
