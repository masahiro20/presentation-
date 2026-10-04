/**
 * 地形（国土地理院 標高タイル）: 取得・デコード・標高の補間・地形メッシュ
 *
 * タイル: https://cyberjapandata.gsi.go.jp/xyz/{source}/{z}/{x}/{y}.png
 *   dem1a_png (1m, z=17, 都市部・平野のみ) → dem5a_png (5m, z=15) → dem5b_png → dem5c_png → dem_png (10m DEM10B, z=14)
 * PNG の画素: x = R*65536 + G*256 + B。(128,0,0) は無効値（海・欠測）。
 *   h = x < 2^23 ? x * 0.01 : (x - 2^24) * 0.01 [m]。行 0 = 北。
 *
 * 取得の流れ（fetchHeightGrid）
 *   1. ピン位置 ±radiusM の正方形をおおうタイルを、細かい順に取得する（dem1a → dem5a → …）。
 *      タイルの半数以上が得られたデータを採用する（404 = その地域には提供されていない）。
 *   2. 採用したデータの穴（404 のタイル・無効値）を、より粗いデータをバイリニア補間で再標本化して埋める。
 *   3. それでも残った無効値は NaN のまま（sampleHeight が近傍の有効値で代用する）。
 *   全データが取得できない（通信不可・提供地域外・すべて無効値）ときは日本語メッセージの Error を投げる。
 *   呼び出し側（environment.ts）は flatGrid に切り替えて続行する。
 *
 * 純粋な関数（decodeDemPixel, sampleHeight, flatGrid, gridStats, minHeightInRing, タイル計算, 再標本化）は
 * DOM に依存しないので Node 上のテストで検証できる。buildTerrainMesh も aerial 無しなら Node で動く。
 */
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { lonLatToTile, metersPerDegree, tileToLonLat, toLocal } from '../sun/geo';
import type { AerialImage, HeightGrid } from './types';

export type DemSource = 'dem1a' | 'dem5a' | 'dem5b' | 'dem5c' | 'dem10b';

export const DEM_LABEL: Record<string, string> = {
  dem1a: '国土地理院 標高タイル DEM1A（1m メッシュ・航空レーザー測量）',
  dem5a: '国土地理院 標高タイル DEM5A（5m メッシュ・航空レーザー測量）',
  dem5b: '国土地理院 標高タイル DEM5B（5m メッシュ・写真測量）',
  dem5c: '国土地理院 標高タイル DEM5C（5m メッシュ）',
  dem10b: '国土地理院 標高タイル DEM10B（10m メッシュ）',
  flat: '標高データなし（平地として扱います）',
};

/** 標高タイルのデータソース（細かい順。この順に試し、穴は後ろのデータで埋める） */
export interface DemSourceSpec {
  id: DemSource;
  /** タイル URL のレイヤー名 */
  layer: string;
  /** 取得するズーム */
  z: number;
  /** 進捗表示用の解像度ラベル */
  label: string;
}

export const DEM_SOURCES: readonly DemSourceSpec[] = [
  { id: 'dem1a', layer: 'dem1a_png', z: 17, label: '1m' },
  { id: 'dem5a', layer: 'dem5a_png', z: 15, label: '5m' },
  { id: 'dem5b', layer: 'dem5b_png', z: 15, label: '5m' },
  { id: 'dem5c', layer: 'dem5c_png', z: 15, label: '5m' },
  { id: 'dem10b', layer: 'dem_png', z: 14, label: '10m' },
];

export const DEM_TILE_BASE = 'https://cyberjapandata.gsi.go.jp/xyz';
/** タイル 1 枚の画素数（正方形） */
export const DEM_TILE = 256;
/** 1 回の取得で扱うタイル数の上限（これを超える半径は縮める。64 枚 = 2048² 画素 ≈ 16 MB） */
export const DEM_MAX_TILES = 64;

export function demTileUrl(spec: DemSourceSpec, x: number, y: number): string {
  return `${DEM_TILE_BASE}/${spec.layer}/${spec.z}/${x}/${y}.png`;
}

// ---------------------------------------------------------------------------
// 画素のデコード
// ---------------------------------------------------------------------------

/** 標高タイル PNG の画素 → 標高 (m)。無効値 (128,0,0) は NaN */
export function decodeDemPixel(r: number, g: number, b: number): number {
  if (r === 128 && g === 0 && b === 0) return NaN;
  const x = r * 65536 + g * 256 + b;
  return (x < 8388608 ? x : x - 16777216) * 0.01;
}

// ---------------------------------------------------------------------------
// タイルの範囲とモザイク（タイルを並べた 1 枚の格子）
// ---------------------------------------------------------------------------

/** タイル番号の範囲（x0..x1, y0..y1 を含む） */
export interface TileRange {
  z: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function tileCount(r: TileRange): number {
  return (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
}

/** ピン位置 ±radiusM の正方形をおおうタイルの範囲。タイル数が DEM_MAX_TILES を超えるときは半径を縮める */
export function demTileRange(lat: number, lon: number, radiusM: number, z: number): TileRange {
  const { mLat, mLon } = metersPerDegree(lat);
  const nTiles = 2 ** z;
  const clampT = (v: number) => Math.min(nTiles - 1, Math.max(0, Math.floor(v)));
  let r = Math.max(1, radiusM);
  for (;;) {
    const t0 = lonLatToTile(lon - r / mLon, lat + r / mLat, z);
    const t1 = lonLatToTile(lon + r / mLon, lat - r / mLat, z);
    const range: TileRange = { z, x0: clampT(t0.x), y0: clampT(t0.y), x1: clampT(t1.x), y1: clampT(t1.y) };
    if (tileCount(range) <= DEM_MAX_TILES || r <= 1) return range;
    r *= 0.8;
  }
}

/** 細かいモザイクの範囲を完全におおう、ズーム zc でのタイル範囲 */
export function coveringRange(fine: TileRange, zc: number): TileRange {
  const s = 2 ** (zc - fine.z);
  return {
    z: zc,
    x0: Math.floor(fine.x0 * s),
    y0: Math.floor(fine.y0 * s),
    x1: Math.ceil((fine.x1 + 1) * s) - 1,
    y1: Math.ceil((fine.y1 + 1) * s) - 1,
  };
}

/** タイルを並べた標高の格子（行 0 = 北、列 0 = 西）。未取得・無効値は NaN */
export interface DemMosaic extends TileRange {
  nx: number;
  ny: number;
  values: Float32Array;
  /** 取得できたタイル数 (200) */
  okTiles: number;
  /** 提供されていないタイル数 (404) */
  missingTiles: number;
  /** 通信エラー等で取得できなかったタイル数 */
  failedTiles: number;
  totalTiles: number;
}

export function createMosaic(range: TileRange): DemMosaic {
  const nx = (range.x1 - range.x0 + 1) * DEM_TILE;
  const ny = (range.y1 - range.y0 + 1) * DEM_TILE;
  const values = new Float32Array(nx * ny);
  values.fill(NaN);
  return { ...range, nx, ny, values, okTiles: 0, missingTiles: 0, failedTiles: 0, totalTiles: tileCount(range) };
}

/** タイル画像の RGBA 画素列（DEM_TILE × DEM_TILE）をデコードしてモザイクに書き込む */
export function writeTile(m: DemMosaic, tx: number, ty: number, rgba: Uint8ClampedArray | Uint8Array): void {
  const ox = (tx - m.x0) * DEM_TILE;
  const oy = (ty - m.y0) * DEM_TILE;
  if (ox < 0 || oy < 0 || ox + DEM_TILE > m.nx || oy + DEM_TILE > m.ny) throw new Error('タイルがモザイクの範囲外です');
  const v = m.values;
  let p = 0;
  for (let row = 0; row < DEM_TILE; row++) {
    let k = (oy + row) * m.nx + ox;
    for (let col = 0; col < DEM_TILE; col++, k++, p += 4) {
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      if (r === 128 && g === 0 && b === 0) {
        v[k] = NaN;
      } else {
        const x = r * 65536 + g * 256 + b;
        v[k] = (x < 8388608 ? x : x - 16777216) * 0.01;
      }
    }
  }
}

export function countNaN(values: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < values.length; i++) if (values[i] !== values[i]) n++;
  return n;
}

/**
 * 細かいモザイクの NaN を、粗いモザイクをバイリニア補間で再標本化して埋める。
 * どちらも Web メルカトルのタイル画素なので、対応はタイル座標の算術だけで決まる。
 * @returns 残った NaN の数
 */
export function fillFromCoarser(fine: DemMosaic, coarse: DemMosaic): number {
  const s = 2 ** (coarse.z - fine.z);
  // 列ごとの粗い側の画素座標（画素中心 = 整数）
  const fxs = new Float64Array(fine.nx);
  for (let c = 0; c < fine.nx; c++) fxs[c] = ((fine.x0 + (c + 0.5) / DEM_TILE) * s - coarse.x0) * DEM_TILE - 0.5;
  let remaining = 0;
  for (let r = 0; r < fine.ny; r++) {
    const fy = ((fine.y0 + (r + 0.5) / DEM_TILE) * s - coarse.y0) * DEM_TILE - 0.5;
    const base = r * fine.nx;
    for (let c = 0; c < fine.nx; c++) {
      const k = base + c;
      const v = fine.values[k];
      if (v === v) continue;
      const h = bilinear(coarse.values, coarse.nx, coarse.ny, fxs[c], fy);
      if (h === h) fine.values[k] = h;
      else remaining++;
    }
  }
  return remaining;
}

/** モザイク → HeightGrid（範囲はタイル四隅の緯度経度をピンからの東・北 m に変換） */
export function mosaicToGrid(m: DemMosaic, lat: number, lon: number, source: DemSource | string): HeightGrid {
  const nw = tileToLonLat(m.x0, m.y0, m.z);
  const se = tileToLonLat(m.x1 + 1, m.y1 + 1, m.z);
  const a = toLocal(nw.lat, nw.lon, lat, lon);
  const b = toLocal(se.lat, se.lon, lat, lon);
  const resolution = ((b.e - a.e) / m.nx + (a.n - b.n) / m.ny) / 2;
  return { west: a.e, east: b.e, south: b.n, north: a.n, nx: m.nx, ny: m.ny, values: m.values, source, resolution };
}

// ---------------------------------------------------------------------------
// タイルの取得（ブラウザー専用）
// ---------------------------------------------------------------------------

type TileResult = { status: 'ok'; data: Uint8ClampedArray } | { status: 'missing' } | { status: 'failed'; error: Error };

let demCanvas: HTMLCanvasElement | null = null;
let demCtx: CanvasRenderingContext2D | null = null;

function tileContext(): CanvasRenderingContext2D {
  if (!demCtx) {
    demCanvas = document.createElement('canvas');
    demCanvas.width = DEM_TILE;
    demCanvas.height = DEM_TILE;
    demCtx = demCanvas.getContext('2d', { willReadFrequently: true });
    if (!demCtx) throw new Error('Canvas 2D コンテキストを作成できませんでした');
  }
  return demCtx;
}

/** PNG の Blob を画像として読み、画素列を返す（色変換を避けるため可能なら createImageBitmap を使う） */
async function decodeTileImage(blob: Blob): Promise<Uint8ClampedArray> {
  let src: CanvasImageSource | null = null;
  let bitmap: ImageBitmap | null = null;
  if (typeof createImageBitmap === 'function') {
    try {
      bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      src = bitmap;
    } catch {
      bitmap = null;
    }
  }
  let objectUrl: string | null = null;
  if (!src) {
    objectUrl = URL.createObjectURL(blob);
    src = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('標高タイル PNG のデコードに失敗しました'));
      img.src = objectUrl!;
    });
  }
  try {
    const ctx = tileContext();
    ctx.clearRect(0, 0, DEM_TILE, DEM_TILE);
    ctx.drawImage(src, 0, 0, DEM_TILE, DEM_TILE);
    // drawImage と getImageData の間に await を挟まないので、共有 canvas を並列に使っても安全
    return ctx.getImageData(0, 0, DEM_TILE, DEM_TILE).data;
  } finally {
    bitmap?.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

/** タイル 1 枚を取得する。404 は「提供なし」、通信エラーは「失敗」として区別する */
async function fetchDemTile(url: string, signal?: AbortSignal): Promise<TileResult> {
  try {
    const res = await fetch(url, { signal, mode: 'cors' });
    if (res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'failed', error: new Error(`HTTP ${res.status}`) };
    const blob = await res.blob();
    return { status: 'ok', data: await decodeTileImage(blob) };
  } catch (e) {
    if (signal?.aborted) throw new Error('標高データの取得を中止しました');
    return { status: 'failed', error: e instanceof Error ? e : new Error(String(e)) };
  }
}

async function fetchMosaic(spec: DemSourceSpec, range: TileRange, o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void }): Promise<DemMosaic> {
  const m = createMosaic(range);
  const total = m.totalTiles;
  let done = 0;
  o.onProgress?.(0, total);
  const jobs: Promise<void>[] = [];
  for (let ty = range.y0; ty <= range.y1; ty++)
    for (let tx = range.x0; tx <= range.x1; tx++) {
      jobs.push(
        fetchDemTile(demTileUrl(spec, tx, ty), o.signal).then((res) => {
          if (res.status === 'ok') {
            writeTile(m, tx, ty, res.data);
            m.okTiles++;
          } else if (res.status === 'missing') m.missingTiles++;
          else m.failedTiles++;
          done++;
          o.onProgress?.(done, total);
        }),
      );
    }
  await Promise.all(jobs);
  return m;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('標高データの取得を中止しました');
}

/**
 * ピン位置を中心に半径 radiusM をおおう標高の格子を取得する（最も細かい利用可能な DEM）。
 * 格子は Web メルカトルのタイル画素をそのまま使い、範囲は west/east/south/north（ピンからの m）で表す。
 */
export async function fetchHeightGrid(lat: number, lon: number, radiusM: number, opts: { signal?: AbortSignal; onProgress?: (msg: string) => void } = {}): Promise<HeightGrid> {
  if (typeof document === 'undefined' || typeof fetch !== 'function') throw new Error('標高データの取得はブラウザー上でのみ行えます');
  const { signal, onProgress } = opts;
  let sawNetworkError = false;
  for (let i = 0; i < DEM_SOURCES.length; i++) {
    const spec = DEM_SOURCES[i];
    throwIfAborted(signal);
    const range = demTileRange(lat, lon, radiusM, spec.z);
    const mosaic = await fetchMosaic(spec, range, {
      signal,
      onProgress: (d, t) => onProgress?.(`標高データ（${spec.label}）を取得しています… ${d}/${t}`),
    });
    if (mosaic.failedTiles) sawNetworkError = true;
    if (mosaic.okTiles === 0) {
      // 1 枚も取れず、すべて通信エラーなら他のデータも取れないので打ち切る
      if (mosaic.failedTiles === mosaic.totalTiles) throw new Error('国土地理院の標高タイルサーバーに接続できませんでした（インターネット接続を確認してください）');
      continue;
    }
    // タイルの半数未満しか提供されていない地域 → 次の粗いデータへ
    if (mosaic.okTiles * 2 < mosaic.totalTiles) continue;
    // 穴（404 のタイル・無効値）をより粗いデータで埋める
    let remaining = countNaN(mosaic.values);
    for (let j = i + 1; j < DEM_SOURCES.length && remaining > 0; j++) {
      throwIfAborted(signal);
      const cs = DEM_SOURCES[j];
      const coarse = await fetchMosaic(cs, coveringRange(mosaic, cs.z), {
        signal,
        onProgress: (d, t) => onProgress?.(`標高データ（${spec.label}）の欠損を ${cs.label} データで補っています… ${d}/${t}`),
      });
      if (coarse.failedTiles) sawNetworkError = true;
      if (!coarse.okTiles) continue;
      remaining = fillFromCoarser(mosaic, coarse);
    }
    if (remaining >= mosaic.values.length) throw new Error('標高データがすべて無効値でした（海上などの可能性があります）');
    onProgress?.(`標高データ（${spec.label}）を読み込みました`);
    return mosaicToGrid(mosaic, lat, lon, spec.id);
  }
  throw new Error(sawNetworkError ? '国土地理院の標高タイルサーバーに接続できませんでした（インターネット接続を確認してください）' : 'この地域の標高タイルは提供されていません');
}

// ---------------------------------------------------------------------------
// 格子のサンプリング（純粋関数）
// ---------------------------------------------------------------------------

/**
 * NaN を考慮したバイリニア補間。fx, fy は画素座標（画素中心 = 整数、行 0 = 北）で、範囲外は縁に丸める。
 * 4 隅のうち有効なものだけで重みを正規化する。有効な重みがほぼ 0 のとき（ちょうど NaN の画素上）は
 * 最も近い有効な隅の値。4 隅とも NaN なら NaN。
 */
function bilinear(values: Float32Array, nx: number, ny: number, fx: number, fy: number): number {
  if (fx < 0 || fx !== fx) fx = 0;
  else if (fx > nx - 1) fx = nx - 1;
  if (fy < 0 || fy !== fy) fy = 0;
  else if (fy > ny - 1) fy = ny - 1;
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  const c1 = c0 + 1 < nx ? c0 + 1 : c0;
  const r1 = r0 + 1 < ny ? r0 + 1 : r0;
  const tx = fx - c0;
  const ty = fy - r0;
  const i0 = r0 * nx;
  const i1 = r1 * nx;
  const v00 = values[i0 + c0];
  const v01 = values[i0 + c1];
  const v10 = values[i1 + c0];
  const v11 = values[i1 + c1];
  const w00 = (1 - tx) * (1 - ty);
  const w01 = tx * (1 - ty);
  const w10 = (1 - tx) * ty;
  const w11 = tx * ty;
  // 速い経路: 4 隅とも有効
  if (v00 === v00 && v01 === v01 && v10 === v10 && v11 === v11) return v00 * w00 + v01 * w01 + v10 * w10 + v11 * w11;
  let sum = 0;
  let wsum = 0;
  let best = NaN;
  let bestW = -1;
  if (v00 === v00) {
    sum += v00 * w00;
    wsum += w00;
    if (w00 > bestW) {
      bestW = w00;
      best = v00;
    }
  }
  if (v01 === v01) {
    sum += v01 * w01;
    wsum += w01;
    if (w01 > bestW) {
      bestW = w01;
      best = v01;
    }
  }
  if (v10 === v10) {
    sum += v10 * w10;
    wsum += w10;
    if (w10 > bestW) {
      bestW = w10;
      best = v10;
    }
  }
  if (v11 === v11) {
    sum += v11 * w11;
    wsum += w11;
    if (w11 > bestW) {
      bestW = w11;
      best = v11;
    }
  }
  if (wsum > 1e-6) return sum / wsum;
  return best;
}

/** (fx, fy) の周囲を正方形のリング状に広げて探し、最初に見つかったリング内で最も近い有効値を返す。無ければ NaN */
function nearestValid(values: Float32Array, nx: number, ny: number, fx: number, fy: number, maxRing: number): number {
  const cc = Math.min(nx - 1, Math.max(0, Math.round(fx)));
  const rc = Math.min(ny - 1, Math.max(0, Math.round(fy)));
  for (let ring = 1; ring <= maxRing; ring++) {
    let best = NaN;
    let bestD = Infinity;
    const cMin = cc - ring;
    const cMax = cc + ring;
    const rMin = rc - ring;
    const rMax = rc + ring;
    if (cMin < 0 && cMax >= nx && rMin < 0 && rMax >= ny) break; // 格子全体を調べ終えた
    // 上下の辺
    for (let c = Math.max(0, cMin); c <= Math.min(nx - 1, cMax); c++) {
      if (rMin >= 0) {
        const v = values[rMin * nx + c];
        if (v === v) {
          const d = (c - fx) * (c - fx) + (rMin - fy) * (rMin - fy);
          if (d < bestD) {
            bestD = d;
            best = v;
          }
        }
      }
      if (rMax < ny) {
        const v = values[rMax * nx + c];
        if (v === v) {
          const d = (c - fx) * (c - fx) + (rMax - fy) * (rMax - fy);
          if (d < bestD) {
            bestD = d;
            best = v;
          }
        }
      }
    }
    // 左右の辺（隅は上下で済み）
    for (let r = Math.max(0, rMin + 1); r <= Math.min(ny - 1, rMax - 1); r++) {
      if (cMin >= 0) {
        const v = values[r * nx + cMin];
        if (v === v) {
          const d = (cMin - fx) * (cMin - fx) + (r - fy) * (r - fy);
          if (d < bestD) {
            bestD = d;
            best = v;
          }
        }
      }
      if (cMax < nx) {
        const v = values[r * nx + cMax];
        if (v === v) {
          const d = (cMax - fx) * (cMax - fx) + (r - fy) * (r - fy);
          if (d < bestD) {
            bestD = d;
            best = v;
          }
        }
      }
    }
    if (best === best) return best;
  }
  return NaN;
}

/** 近傍探索の最大リング数（セル単位） */
const NEAREST_SEARCH_RINGS = 25;

/** 標高をバイリニア補間で返す（e: 東 m, n: 北 m）。範囲外は最も近い縁の値。NaN は近傍の有効値で代用 */
export function sampleHeight(g: HeightGrid, e: number, n: number): number {
  const { nx, ny } = g;
  if (nx < 1 || ny < 1 || g.values.length < nx * ny) return NaN;
  const ew = g.east - g.west;
  const ns = g.north - g.south;
  // 画素中心の座標: 列 c の中心 = west + (c + 0.5) * dx、行 r の中心 = north - (r + 0.5) * dy
  const fx = ew > 0 ? ((e - g.west) / ew) * nx - 0.5 : 0;
  const fy = ns > 0 ? ((g.north - n) / ns) * ny - 0.5 : 0;
  const v = bilinear(g.values, nx, ny, fx, fy);
  if (v === v) return v;
  return nearestValid(g.values, nx, ny, fx, fy, NEAREST_SEARCH_RINGS);
}

/** 平地の格子（ネットワーク不可のとき） */
export function flatGrid(radiusM: number, elev = 0): HeightGrid {
  const r = Number.isFinite(radiusM) && Math.abs(radiusM) > 0 ? Math.abs(radiusM) : 1;
  const values = new Float32Array(4);
  values.fill(Number.isFinite(elev) ? elev : 0);
  return { west: -r, east: r, south: -r, north: r, nx: 2, ny: 2, values, source: 'flat', resolution: r };
}

/** 多角形（e/n）の内側・周囲の最低標高（周辺建物の足元を決める）。有効値が無ければ 0 */
export function minHeightInRing(g: HeightGrid, ring: { e: number; n: number }[]): number {
  let min = Infinity;
  const take = (e: number, n: number) => {
    const h = sampleHeight(g, e, n);
    if (h === h && h < min) min = h;
  };
  if (!ring.length) return 0;
  let ce = 0;
  let cn = 0;
  for (const p of ring) {
    ce += p.e;
    cn += p.n;
    take(p.e, p.n);
  }
  ce /= ring.length;
  cn /= ring.length;
  // 内側: 重心と、各頂点→重心の中点。辺の中点も見る
  take(ce, cn);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    take((a.e + ce) / 2, (a.n + cn) / 2);
    take((a.e + b.e) / 2, (a.n + b.n) / 2);
  }
  return min === Infinity ? 0 : min;
}

/** 格子の統計（UI 表示用）: ピン位置 ±radiusM 内の最低・最高標高、ピン位置との高低差。有効値が無ければ groundElev */
export function gridStats(g: HeightGrid, groundElev: number, radiusM: number): { min: number; max: number; relMin: number; relMax: number } {
  const { nx, ny } = g;
  let min = Infinity;
  let max = -Infinity;
  if (nx >= 1 && ny >= 1 && g.values.length >= nx * ny) {
    const dx = (g.east - g.west) / nx;
    const dy = (g.north - g.south) / ny;
    const r = Math.abs(radiusM);
    const clampC = (v: number) => Math.min(nx - 1, Math.max(0, v));
    const clampR = (v: number) => Math.min(ny - 1, Math.max(0, v));
    // 画素中心が ±r に入る列・行の範囲。入る画素が無ければピンに最も近い画素
    let c0 = clampC(Math.ceil((-r - g.west) / dx - 0.5));
    let c1 = clampC(Math.floor((r - g.west) / dx - 0.5));
    if (c0 > c1) c0 = c1 = clampC(Math.round((0 - g.west) / dx - 0.5));
    let r0 = clampR(Math.ceil((g.north - r) / dy - 0.5));
    let r1 = clampR(Math.floor((g.north + r) / dy - 0.5));
    if (r0 > r1) r0 = r1 = clampR(Math.round(g.north / dy - 0.5));
    const v = g.values;
    for (let row = r0; row <= r1; row++) {
      const base = row * nx;
      for (let col = c0; col <= c1; col++) {
        const h = v[base + col];
        if (h !== h) continue;
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
  }
  if (min === Infinity) return { min: groundElev, max: groundElev, relMin: 0, relMax: 0 };
  return { min, max, relMin: min - groundElev, relMax: max - groundElev };
}

// ---------------------------------------------------------------------------
// 地形メッシュ
// ---------------------------------------------------------------------------

/** 頂点数が maxVertices 以下になる、格子の等間隔な間引き（列数・行数とストライド） */
export function terrainGridSize(nx: number, ny: number, maxVertices: number): { cols: number; rows: number; stride: number } {
  const budget = Math.max(4, Math.floor(maxVertices));
  nx = Math.max(1, nx);
  ny = Math.max(1, ny);
  let stride = Math.max(1, Math.ceil(Math.sqrt((nx * ny) / budget)));
  for (;;) {
    const cols = Math.ceil(nx / stride) + 1;
    const rows = Math.ceil(ny / stride) + 1;
    if (cols * rows <= budget || (cols <= 2 && rows <= 2)) return { cols, rows, stride };
    stride++;
  }
}

/**
 * 地形メッシュ。頂点 y = 標高 - groundElev（ピン位置が 0）。航空写真があれば貼る（UV: u=(e-west)/(east-west), v=(n-south)/(north-south)）。
 * 頂点数は maxVertices 以下に間引く。receiveShadow と castShadow を有効に。userData.terrain = true。
 * 頂点の並び: 行 0 = 北（z が最も小さい）、列 0 = 西。ワールド x = 東 (e)、z = 南 (-n)。
 */
export function buildTerrainMesh(g: HeightGrid, groundElev: number, opts: { aerial?: AerialImage | null; maxVertices?: number } = {}): THREE.Mesh {
  const { cols, rows } = terrainGridSize(g.nx, g.ny, opts.maxVertices ?? 160_000);
  const aerial = opts.aerial ?? null;
  const count = cols * rows;
  const pos = new Float32Array(count * 3);
  const uv = aerial ? new Float32Array(count * 2) : null;
  const aw = aerial ? aerial.east - aerial.west : 1;
  const ah = aerial ? aerial.north - aerial.south : 1;
  const ge = Number.isFinite(groundElev) ? groundElev : 0;
  let k = 0;
  for (let j = 0; j < rows; j++) {
    const n = g.north - ((g.north - g.south) * j) / (rows - 1);
    for (let i = 0; i < cols; i++, k++) {
      const e = g.west + ((g.east - g.west) * i) / (cols - 1);
      const h = sampleHeight(g, e, n);
      pos[k * 3] = e;
      pos[k * 3 + 1] = h === h ? h - ge : 0;
      pos[k * 3 + 2] = -n;
      if (uv && aerial) {
        const u = (e - aerial.west) / aw;
        const v = (n - aerial.south) / ah;
        uv[k * 2] = u < 0 ? 0 : u > 1 ? 1 : u;
        uv[k * 2 + 1] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
  }
  // 三角形（上から見て反時計回り = 法線が +Y）
  const triCount = (cols - 1) * (rows - 1) * 2;
  const index = count > 65535 ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3);
  let q = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      index[q++] = a;
      index[q++] = c;
      index[q++] = b;
      index[q++] = b;
      index[q++] = c;
      index[q++] = d;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (uv) geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  let material: THREE.MeshStandardMaterial;
  if (aerial) {
    const tex = new THREE.CanvasTexture(aerial.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 });
  } else {
    material = new THREE.MeshStandardMaterial({ color: '#b9b4a5', roughness: 0.95, metalness: 0 });
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.userData.terrain = true;
  mesh.userData.matKey = 'terrain';
  mesh.userData.source = g.source;
  // BVH（クリック・解析のレイキャストを高速化）
  geometry.boundsTree = new MeshBVH(geometry);
  mesh.raycast = acceleratedRaycast;
  return mesh;
}
