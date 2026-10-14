/**
 * PLATEAU のカタログ: 市区索引（public/plateau-index.json）・逆ジオコーダ（国土地理院）・-latest エイリアス解決・データセット選択。
 *
 * 取得の流れ（fetch.ts が呼ぶ順）:
 *  1. muniCodesAround: 中心＋4 隅の 5 点を国土地理院の逆ジオコーダに allSettled で掛け、市区町村コード（muniCd）を重複除去して返す
 *     （区境では複数の市区になる。1 件も取れなければ throw → 索引に region があれば muniCodesByRegion が予備経路）
 *  2. loadPlateauIndex: 索引（市区 → 年度・LOD・tileset.json の URL）。Promise をメモ化し 1 ページ 1 回しか取らない
 *  3. pickDataset: 市区の sets[0]（LOD 降順・同 LOD はテクスチャ無し先）を PlateauDatasetInfo に
 *  4. resolveTilesetUrl: -latest エイリアス（no-cache・ACAO *）から実 tileset.json の絶対 URL を引く。children が無ければ「-latest に無い」（missing。
 *     fetch.ts は索引の URL を試し、4xx なら対象外・取れれば続ける）、通信失敗なら索引の URL に退避（索引が古いと 404 になり得るが、それは
 *     fetch.ts が通信エラーとして扱う）
 *
 * fetch は fetchImpl で差し替えられる（テストはスタブ、本番は globalThis.fetch）。中止は signal.reason をそのまま throw する。
 * 期限（第 2 回レビュー）: 各段の fetch には呼び出し側の signal と期限（NetOpts.timeoutMs。省略時は PLATEAU_TIMEOUTS の段の既定）を
 * deadlineSignal で合成した signal を渡す。期限切れは中止ではなく通信失敗として扱う（throwIfAborted は呼び出し側の signal だけ見る）ので、
 * 逆ジオコーダの期限切れは muniCodesAround の throw → fetch.ts の region 予備経路へ、-latest の期限切れは索引 URL への退避になる。
 * signal を無視する fetchImpl（テストのスタブなど）でも待ちが終わるよう、fetch の Promise 自体も raceWithAbort で待つ。
 * 仕様: scratchpad/plateau-spec.md §2.8・§4（W6 が実装）
 */
import { degBoxAround, degBoxIntersects } from '../geodesy';
import type { GeoBox, PlateauDatasetInfo, PlateauNetStage } from './types';

export interface PlateauIndexSet {
  lod: number;
  tex: boolean;
  /** urlPrefix からの相対（scripts/plateau-index.mjs の出力。絶対 URL でもよい） */
  url: string;
  size: number | null;
}

export interface PlateauArea {
  pref: string;
  city: string;
  ward: string | null;
  year: number;
  /** LOD 降順・同 LOD はテクスチャ無し先（pickDataset で改めて並べ直すので順序に依存しない） */
  sets: PlateauIndexSet[];
  /**
   * W16: -latest ラッパーの root.region（-latest に無い市区は索引の tileset.json の root.region）を度に [west, south, east, north]。
   * 逆ジオコーダ不通時と、逆ジオコーダのコードが索引に 1 件も無いとき（市区町村コードの改編）の予備経路 muniCodesByRegion に使う
   */
  region?: [number, number, number, number];
}

export interface PlateauIndex {
  generated: string;
  source: string;
  urlPrefix: string;
  /** muniCd → 市区 */
  areas: Record<string, PlateauArea>;
}

export interface NetOpts {
  fetchImpl?: typeof fetch;
  /** 呼び出し側の中止。中止は signal.reason を throw する（期限切れとは区別する） */
  signal?: AbortSignal;
  /** この呼び出し（1 段）の期限 [ms]。省略時は段の既定（PLATEAU_TIMEOUTS）。正の有限数でなければ期限なし */
  timeoutMs?: number;
}

/** 段ごとの既定の期限 [ms]（第 2 回レビュー: geocode 8 s・index 10 s・-latest 8 s・tileset 20 s・タイル 1 枚 60 s） */
export const PLATEAU_TIMEOUTS: Readonly<Record<PlateauNetStage, number>> = { geocode: 8000, index: 10000, latest: 8000, tileset: 20000, tile: 60000 };

/** 期限切れの理由（AbortSignal.timeout と同じ name 'TimeoutError'。呼び出し側の中止（signal.reason）とは別物として扱う） */
export function timeoutReason(ms: number): Error {
  return new DOMException(`期限切れ（${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} 秒以内に応答がありません）`, 'TimeoutError');
}

export function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && e.name === 'TimeoutError';
}

/**
 * 呼び出し側の signal と期限を合成した AbortSignal（fetchImpl に渡す用）。
 *  - 親が中止されたら親の reason で、期限が来たら timeoutReason で abort する（先に来た方）
 *  - AbortSignal.any / AbortSignal.timeout は使わず自前で合成する: 無い環境でも動き、dispose() でタイマーと listener を確実に外せる
 *    （AbortSignal.timeout のタイマーは止められない）
 *  - ms が正の有限数でなければ期限なし（親に連動するだけ）
 * 使い終わったら必ず dispose() を呼ぶ
 */
export function deadlineSignal(parent: AbortSignal | undefined, ms: number | undefined): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort((parent!.reason as Error | undefined) ?? new Error('中止しました'));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = ms != null && Number.isFinite(ms) && ms > 0 && !controller.signal.aborted ? setTimeout(() => controller.abort(timeoutReason(ms)), ms) : null;
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer != null) clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

/** 国土地理院 逆ジオコーダ（緯度経度 → 市区町村コード muniCd） */
export const REVERSE_GEOCODER_URL = (lat: number, lon: number) => `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lon}`;

/** -latest エイリアス（no-cache。root.children[0].content.uri に実 tileset.json の絶対 URL を持つラッパー。無いデータセットは 200 で children 無し） */
export const PLATEAU_LATEST_URL = (muniCd: string, lod: number, tex: boolean) => `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/${muniCd}-bldg-lod${lod}-${tex ? 'texture' : 'notexture'}-latest/tileset.json`;

/** 索引の既定の場所（配信ルート直下の public/plateau-index.json）。document が無い Node では相対のまま（opts.url を渡す） */
const INDEX_FILE = 'plateau-index.json';

/** 既定の fetch（globalThis.fetch を呼ぶ時点で解決する。メモ化のキーにも使うのでモジュールに 1 個） */
const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

function pickFetch(opts?: NetOpts): typeof fetch {
  return opts?.fetchImpl ?? defaultFetch;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw (signal.reason as Error | undefined) ?? new Error('中止しました');
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 索引の形を最低限検証する（壊れた JSON や別物の HTML を読んでしまったときに後段で落ちないように） */
function validateIndex(json: unknown, url: string): PlateauIndex {
  const j = json as Partial<PlateauIndex> | null;
  if (!j || typeof j !== 'object' || typeof j.urlPrefix !== 'string' || !j.areas || typeof j.areas !== 'object' || Array.isArray(j.areas)) {
    throw new Error(`PLATEAU の索引の形が不正です: ${url}`);
  }
  return { generated: typeof j.generated === 'string' ? j.generated : '', source: typeof j.source === 'string' ? j.source : '', urlPrefix: j.urlPrefix, areas: j.areas };
}

/**
 * 索引のメモ（fetch 関数 → URL → Promise）。fetchImpl ごとに分けるので、テストのスタブどうしは混ざらず、
 * 同じ fetchImpl（本番は defaultFetch）で呼べば 2 回目以降は通信しない。失敗した Promise はメモから外し、取り直せるようにする。
 * メモの Promise は呼び出し側の signal 無し・期限だけで取る（先に始めた呼び出しの中止が、同じ索引を待つ別の呼び出しに伝播しないように。
 * 索引は小さいので下層の fetch は中止しない。期限切れは失敗としてメモから外れる）。呼び出し側は raceWithAbort で自分の signal だけで待ちを打ち切る
 */
const indexMemo = new WeakMap<typeof fetch, Map<string, Promise<PlateauIndex>>>();

/** 共有の Promise を自分の signal で待つ（中止したら自分だけ signal.reason で reject） */
function raceWithAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject((signal.reason as Error | undefined) ?? new Error('中止しました'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** 既定 new URL('plateau-index.json', document.baseURI)。Promise をメモ化 */
export async function loadPlateauIndex(opts?: NetOpts & { url?: string | URL }): Promise<PlateauIndex> {
  throwIfAborted(opts?.signal);
  const url = opts?.url != null ? String(opts.url) : typeof document !== 'undefined' ? new URL(INDEX_FILE, document.baseURI).toString() : INDEX_FILE;
  const f = pickFetch(opts);
  let byUrl = indexMemo.get(f);
  if (!byUrl) {
    byUrl = new Map();
    indexMemo.set(f, byUrl);
  }
  const hit = byUrl.get(url);
  if (hit) return raceWithAbort(hit, opts?.signal);
  const p = (async () => {
    const dl = deadlineSignal(undefined, opts?.timeoutMs ?? PLATEAU_TIMEOUTS.index);
    try {
      const res = await raceWithAbort(f(url, { signal: dl.signal }), dl.signal);
      if (!res.ok) throw new Error(`PLATEAU の索引を取得できません（HTTP ${res.status}）: ${url}`);
      let json: unknown;
      try {
        json = await raceWithAbort(res.json(), dl.signal);
      } catch (e) {
        throw new Error(`PLATEAU の索引を読めません（${errorMessage(e)}）: ${url}`);
      }
      return validateIndex(json, url);
    } catch (e) {
      if (isTimeoutError(e)) throw new Error(`PLATEAU の索引を取得できません（${errorMessage(e)}）: ${url}`);
      throw e;
    } finally {
      dl.dispose();
    }
  })();
  byUrl.set(url, p);
  p.catch(() => byUrl!.delete(url));
  return raceWithAbort(p, opts?.signal);
}

/** 逆ジオコーダの応答 { results: { muniCd, lv01Nm } }。海上などでは results が null */
function parseMuniCd(json: unknown): string | null {
  const r = (json as { results?: { muniCd?: unknown } | null } | null)?.results;
  const cd = r && typeof r === 'object' ? r.muniCd : null;
  return typeof cd === 'string' && /^\d{5}$/.test(cd) ? cd : null;
}

/** 中心＋4 隅を allSettled で逆ジオコーディングし重複除去。1 件も取れなければ throw */
export async function muniCodesAround(lat: number, lon: number, radiusM: number, opts?: NetOpts): Promise<string[]> {
  throwIfAborted(opts?.signal);
  const f = pickFetch(opts);
  const box = degBoxAround(lat, lon, radiusM);
  // 中心を先頭に（重複除去で残るのは先に来た方。ピンの市区が datasets[0] になる）
  const points: [number, number][] = [
    [lat, lon],
    [box.south, box.west],
    [box.south, box.east],
    [box.north, box.west],
    [box.north, box.east],
  ];
  // 5 点でひとつの期限（段の期限）。期限切れは失敗に数える（全滅なら throw → fetch.ts の region 予備経路）
  const dl = deadlineSignal(opts?.signal, opts?.timeoutMs ?? PLATEAU_TIMEOUTS.geocode);
  let settled: PromiseSettledResult<string | null>[];
  try {
    settled = await Promise.allSettled(
      points.map(async ([la, lo]) => {
        const res = await raceWithAbort(f(REVERSE_GEOCODER_URL(la, lo), { signal: dl.signal }), dl.signal);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseMuniCd(await raceWithAbort(res.json(), dl.signal));
      }),
    );
  } finally {
    dl.dispose();
  }
  throwIfAborted(opts?.signal);
  const codes: string[] = [];
  const errors: string[] = [];
  for (const s of settled) {
    if (s.status === 'rejected') errors.push(errorMessage(s.reason));
    else if (s.value && !codes.includes(s.value)) codes.push(s.value);
  }
  if (codes.length === 0) {
    const why = errors.length > 0 ? `通信エラー: ${errors[0]}` : '市区町村が見つかりません（海上など）';
    throw new Error(`逆ジオコーダ（国土地理院）から市区町村コードを取得できません（${why}）`);
  }
  return codes;
}

/** 索引に region があるときの予備経路（W16）: box と交差する市区。region を持つ市区が無い索引では [] */
export function muniCodesByRegion(index: PlateauIndex, box: GeoBox): string[] {
  const out: string[] = [];
  for (const [muniCd, area] of Object.entries(index.areas)) {
    const r = area.region;
    if (!Array.isArray(r) || r.length < 4 || r.slice(0, 4).some((v) => typeof v !== 'number' || !Number.isFinite(v))) continue;
    if (degBoxIntersects({ west: r[0], south: r[1], east: r[2], north: r[3] }, box)) out.push(muniCd);
  }
  return out;
}

/** LOD 降順・同 LOD はテクスチャ無し先（転送量が少ない方）。元の配列は変えない */
function sortSets(sets: PlateauIndexSet[]): PlateauIndexSet[] {
  return [...sets].sort((a, b) => b.lod - a.lod || Number(a.tex) - Number(b.tex));
}

/** 索引の url を絶対 URL に（相対なら urlPrefix を前置） */
function absoluteUrl(url: string, prefix: string): string {
  return /^https?:\/\//.test(url) ? url : prefix + url;
}

/** sets[0]（LOD 降順・同 LOD はテクスチャ無し先）。索引に無ければ null */
export function pickDataset(index: PlateauIndex, muniCd: string): PlateauDatasetInfo | null {
  const area = index.areas[muniCd];
  if (!area || !Array.isArray(area.sets) || area.sets.length === 0) return null;
  const set = sortSets(area.sets)[0];
  const ward = area.ward ?? null;
  return {
    muniCd,
    pref: area.pref,
    city: area.city,
    ward,
    year: area.year,
    lod: set.lod,
    tex: set.tex,
    tilesetUrl: absoluteUrl(set.url, index.urlPrefix),
    label: `${area.pref}${area.city}${ward ?? ''}・${area.year}年度・LOD${set.lod}`,
  };
}

/** -latest ラッパーの root.children[0].content.uri（3D Tiles 0.0 の content.url も読む） */
function wrapperContentUri(json: unknown): { uri: string | null; hasChildren: boolean } {
  const root = (json as { root?: { children?: unknown } } | null)?.root;
  const children = root && typeof root === 'object' ? root.children : undefined;
  if (!Array.isArray(children) || children.length === 0) return { uri: null, hasChildren: false };
  const content = (children[0] as { content?: { uri?: unknown; url?: unknown } } | null)?.content;
  const uri = content?.uri ?? content?.url;
  return { uri: typeof uri === 'string' && uri.length > 0 ? uri : null, hasChildren: true };
}

/**
 * tileset.json の実 URL を解決する。
 *  - -latest が取れ children[0].content.uri があれば それ（絶対 URL に正規化）: via 'latest'
 *  - -latest が取れ children が無ければ -latest にそのデータセットが無い: missing true（url は索引のもの。呼び出し側（fetch.ts）は索引の URL を
 *    試し、4xx なら「対象外」扱い、取れるなら index 経由で続ける。浜松市の旧 7 区は -latest に無いが tileset.json の配信は続いている）
 *  - -latest が取れない（非 2xx・通信失敗・JSON でない・期限切れ）なら 索引の URL に退避: via 'index'
 */
export async function resolveTilesetUrl(ds: PlateauDatasetInfo, opts?: NetOpts): Promise<{ url: string; via: 'latest' | 'index'; missing: boolean }> {
  throwIfAborted(opts?.signal);
  const f = pickFetch(opts);
  const latestUrl = PLATEAU_LATEST_URL(ds.muniCd, ds.lod, ds.tex);
  const dl = deadlineSignal(opts?.signal, opts?.timeoutMs ?? PLATEAU_TIMEOUTS.latest);
  try {
    const res = await raceWithAbort(f(latestUrl, { signal: dl.signal, cache: 'no-store' }), dl.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { uri, hasChildren } = wrapperContentUri(await raceWithAbort(res.json(), dl.signal));
    if (!hasChildren) return { url: ds.tilesetUrl, via: 'latest', missing: true };
    if (uri) return { url: new URL(uri, latestUrl).toString(), via: 'latest', missing: false };
    // children はあるが content.uri が無い（形が変わった）: 索引の URL で続ける
    return { url: ds.tilesetUrl, via: 'index', missing: false };
  } catch (e) {
    // 呼び出し側の中止だけ投げ直す（期限切れは通信失敗と同じく索引 URL に退避）
    if (opts?.signal?.aborted) throw e;
    return { url: ds.tilesetUrl, via: 'index', missing: false };
  } finally {
    dl.dispose();
  }
}
