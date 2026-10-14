/**
 * 周辺建物: PLATEAU（国土交通省 3D都市モデル・3D Tiles。実測の高さ・実形状）→ 国土地理院（種類から推定）→ OSM の順に取得・統合し、
 * 地形に接地したメッシュ（PLATEAU は実形状、他は押し出し）を作る
 *
 * PLATEAU 3D Tiles: src/sun/plateau（fetchPlateauBuildings）。市区の索引 → 葉タイルの選択 → b3dm の復号 → 建物ごとの分割・足元輪郭。
 *   建物は anchor（経緯度）基準で返るので plateauNeighbors.ts でピン基準の Neighbor にする（id = plateau:gml_id。ピンを動かしても同じ）。
 *   国土地理院のタイルと並列に取り、PLATEAU の実足元と重なる国土地理院の建物は捨てる（PLATEAU に無い建物だけ補う）。
 * 国土地理院 最適化ベクトルタイル: https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/16/{x}/{y}.pbf  layer 'BldA'
 *   vt_code 3101 普通建物 7 m / 3102 堅ろう建物 12 m / 3103 高層建物 30 m / 3111 普通無壁舎 2.8 m / 3112 堅ろう無壁舎 4 m
 * OSM: 既存 fetchOsmBuildings（最後の手段）。
 *
 * タイルには周囲 80 単位ほどの「のりしろ」が入っているので、タイルの範囲でポリゴンを切り取ってから使う
 * （隣のタイルと同じ建物が二重に出ないように。境界をまたぐ建物は 2 片に分かれるが、合わせると元の形になる）。
 */
import * as THREE from 'three';
import { bboxOf, cleanRing, coverageRatio, fillGapsWith, pointInRing, ringArea, ringCenter, samplePoints, type BBoxEN } from '../sun/footprint';
import { fetchOsmBuildings, lonLatToTile, metersPerDegree, tileToLonLat, toLocal } from '../sun/geo';
import { decodeMvt } from '../sun/mvt';
import { PLANNED_COLORS, buildPlannedHouseGeometry, plannedFootprint, syncPlannedHouse } from '../sun/plannedHouse';
import { buildPlateauGeometry, fetchPlateauBuildings, loadPlateauIndex } from '../sun/plateau';
import type { PlateauAttrs, PlateauFetchOptions, PlateauFetchResult } from '../sun/plateau';
import { plateauNotes, plateauProgressText, plateauToNeighbor, reachHeight } from './plateauNeighbors';
import { frameToLocal } from './types';
import type { AerialImage, HeightGrid, LatLon, Neighbor, NeighborSource, PlateauEnvInfo } from './types';

export interface FetchNeighborsResult {
  list: Neighbor[];
  sourcesUsed: NeighborSource[];
  /** 利用者向けの注記（例: 「この地域は PLATEAU（3D都市モデル）が未整備のため、高さは建物の種類から推定しています」） */
  notes: string[];
  /** PLATEAU を使ったときだけ: 使ったデータセット・索引の生成日時（study.env.plateau・保存データの出典行）と LOD 別の棟数 */
  plateau?: PlateauEnvInfo & { lodCounts: Record<string, number> };
}

export type EN = { e: number; n: number };

/** 本モジュールが Neighbor に足す省略可能な情報（型は共有の Neighbor のまま、実行時に持ち回る） */
export type NeighborEx = Neighbor & {
  /** 150 m より遠い建物（高層で冬の朝夕に影が届くので残したもの）。屋上に航空写真は貼らない */
  far?: boolean;
};

export const GSI_TILE_URL = (z: number, x: number, y: number) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${x}/${y}.pbf`;
/** 建物タイルのズーム（国土地理院の最適化ベクトルタイル） */
export const NEIGHBOR_TILE_Z = 16;
/** この距離までは全部残す [m] */
export const NEIGHBOR_NEAR_M = 150;
/** 1 / tan(8.2°): 東京の冬至 8 時ごろの太陽高度で、高さ 1 m の建物の影が届く距離 */
export const SHADOW_REACH_FACTOR = 6.9;
/** 遠い建物は「影の届く距離 − 建物までの距離」がこの余裕以内なら残す [m] */
export const SHADOW_REACH_MARGIN = 60;
/** 国土地理院の建物が PLATEAU のポリゴンとこれ以上重なっていれば「同じ建物」とみなして捨てる */
export const GSI_OVERLAP_MAX = 0.3;

const NETWORK_ERROR = '周辺建物を取得できませんでした（インターネット接続を確認してください）';

// ---------------------------------------------------------------------------
// 幾何のユーティリティ（リングの基本は src/sun/footprint.ts に移した。既存の呼び出しのためここから再 export）
// ---------------------------------------------------------------------------

export { bboxOf, cleanRing, coverageRatio, fillGapsWith, ringArea, ringCenter, samplePoints, type BBoxEN };

/** 線分 ab と cd が交わるか（端点を含む） */
function segmentsCross(a: EN, b: EN, c: EN, d: EN): boolean {
  const o = (p: EN, q: EN, r: EN) => Math.sign((q.e - p.e) * (r.n - p.n) - (q.n - p.n) * (r.e - p.e));
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

/** 2 つの多角形が重なるか（頂点が相手の内側・中心が相手の内側・辺が交わる） */
export function ringsOverlap(a: EN[], b: EN[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  const ba = bboxOf(a);
  const bb = bboxOf(b);
  if (ba.maxE < bb.minE || bb.maxE < ba.minE || ba.maxN < bb.minN || bb.maxN < ba.minN) return false;
  if (a.some((p) => pointInRing(p, b)) || b.some((p) => pointInRing(p, a))) return true;
  if (pointInRing(ringCenter(a), b) || pointInRing(ringCenter(b), a)) return true;
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i];
    const a1 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) if (segmentsCross(a0, a1, b[j], b[(j + 1) % b.length])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// タイルの読み込み（純粋関数。テスト可）
// ---------------------------------------------------------------------------

type TilePt = [number, number];

/** タイル座標（y 下向き）での符号付き面積 ×2。外周は正、穴は負 */
function tileArea2(ring: TilePt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    s += ax * by - bx * ay;
  }
  return s;
}

/** 矩形 [lo, hi]² で多角形を切り取る（Sutherland–Hodgman。向きは保たれる） */
export function clipRingToRect(ring: TilePt[], lo: number, hi: number): TilePt[] {
  if (ring.every(([x, y]) => x >= lo && x <= hi && y >= lo && y <= hi)) return ring;
  let out = ring;
  const planes: [0 | 1, number, boolean][] = [
    [0, lo, false],
    [0, hi, true],
    [1, lo, false],
    [1, hi, true],
  ];
  for (const [axis, bound, keepLess] of planes) {
    const inp = out;
    out = [];
    if (!inp.length) break;
    const inside = (p: TilePt) => (keepLess ? p[axis] <= bound : p[axis] >= bound);
    const cut = (a: TilePt, b: TilePt): TilePt => {
      const t = (bound - a[axis]) / (b[axis] - a[axis]);
      const o = axis === 0 ? 1 : 0;
      const other = a[o] + (b[o] - a[o]) * t;
      return axis === 0 ? [bound, other] : [other, bound];
    };
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i];
      const prev = inp[(i + inp.length - 1) % inp.length];
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cut(prev, cur));
        out.push(cur);
      } else if (pi) out.push(cut(prev, cur));
    }
  }
  return out;
}

/** タイル座標のリング → ピンからの東・北 (m)。短すぎる辺・閉じる点を除く。3 点未満なら null */
function tileRingToLocal(ring: TilePt[], tx: number, ty: number, z: number, extent: number, pinLat: number, pinLon: number): EN[] | null {
  const pts = ring.map(([px, py]) => {
    const ll = tileToLonLat(tx + px / extent, ty + py / extent, z);
    return toLocal(ll.lat, ll.lon, pinLat, pinLon);
  });
  const c = cleanRing(pts);
  return c.length >= 3 ? c : null;
}

/** 出典とリング中心の緯度経度から決定的な id を作る（再取得しても同じ建物が同じ id になる） */
export function neighborId(source: NeighborSource, ring: EN[], pinLat: number, pinLon: number): string {
  const c = ringCenter(ring);
  const { mLat, mLon } = metersPerDegree(pinLat);
  const lat = pinLat + c.n / mLat;
  const lon = pinLon + c.e / mLon;
  // 中心が同じでも大きさが違う屋根面（同心の塔屋など）を区別するため、面積 (m²) も含める
  return `${source}:${lat.toFixed(5)}:${lon.toFixed(5)}:${Math.round(Math.abs(ringArea(ring)))}`;
}

interface ParsedPolygon {
  outer: EN[];
  holes: EN[][];
}

/** ベクトルタイル（MVT）のポリゴン地物のリング列を「外周 + 穴」のまとまりに分ける（タイル範囲で切り取り、m に変換） */
function featurePolygons(rings: TilePt[][], tx: number, ty: number, z: number, extent: number, pinLat: number, pinLon: number, minArea = 1): ParsedPolygon[] {
  const out: ParsedPolygon[] = [];
  let cur: ParsedPolygon | null = null;
  for (const raw of rings) {
    if (raw.length < 3) continue;
    const isOuter = tileArea2(raw) > 0;
    const clipped = clipRingToRect(raw, 0, extent);
    if (clipped.length < 3) {
      if (isOuter) cur = null;
      continue;
    }
    const local = tileRingToLocal(clipped, tx, ty, z, extent, pinLat, pinLon);
    if (!local) {
      if (isOuter) cur = null;
      continue;
    }
    if (isOuter) {
      cur = null;
      if (Math.abs(ringArea(local)) < minArea) continue;
      cur = { outer: local, holes: [] };
      out.push(cur);
    } else if (cur) {
      // 穴はタイル境界で切られると外周に接してしまうので、切られていないものだけ使う
      if (clipped === raw && Math.abs(ringArea(local)) >= 0.5) cur.holes.push(local);
    }
  }
  return out;
}

/** 国土地理院の建物種類コード → 推定の高さ・ラベル */
export function gsiBuildingKind(code: number): { height: number; label?: string } {
  switch (code) {
    case 3101:
      return { height: 7.0, label: '普通建物' };
    case 3102:
      return { height: 12, label: '堅ろう建物' };
    case 3103:
      return { height: 30, label: '高層建物' };
    case 3111:
      return { height: 2.8, label: 'カーポート等（無壁舎）' };
    case 3112:
      return { height: 4, label: 'カーポート等（無壁舎）' };
    default:
      return { height: 7 };
  }
}

/** 国土地理院 最適化ベクトルタイル（BldA）→ 建物（高さは種類から推定）。外周のみ */
export function parseGsiTile(bytes: Uint8Array, tx: number, ty: number, z: number, pinLat: number, pinLon: number): Neighbor[] {
  const layer = decodeMvt(bytes)['BldA'];
  if (!layer) return [];
  const out: Neighbor[] = [];
  for (const f of layer.features) {
    if (f.type !== 3) continue;
    const kind = gsiBuildingKind(Number(f.props['vt_code'] ?? 0));
    for (const poly of featurePolygons(f.rings, tx, ty, z, layer.extent, pinLat, pinLon)) {
      const nb: Neighbor = { id: neighborId('gsi', poly.outer, pinLat, pinLon), ring: poly.outer, height: kind.height, source: 'gsi', heightKind: 'estimated' };
      if (kind.label) nb.label = kind.label;
      out.push(nb);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 取得と統合
// ---------------------------------------------------------------------------

interface TileXY {
  x: number;
  y: number;
}

/** ピンから ±radiusM を覆うタイル */
export function tilesAround(lat: number, lon: number, radiusM: number, z: number): TileXY[] {
  const { mLat, mLon } = metersPerDegree(lat);
  const t0 = lonLatToTile(lon - radiusM / mLon, lat + radiusM / mLat, z);
  const t1 = lonLatToTile(lon + radiusM / mLon, lat - radiusM / mLat, z);
  const out: TileXY[] = [];
  for (let ty = Math.floor(t0.y); ty <= Math.floor(t1.y); ty++) for (let tx = Math.floor(t0.x); tx <= Math.floor(t1.x); tx++) out.push({ x: tx, y: ty });
  return out;
}

type TileResult = { status: 'ok'; list: Neighbor[] } | { status: 'none' } | { status: 'error'; error: Error };

async function fetchTile(url: string, parse: (bytes: Uint8Array) => Neighbor[], signal?: AbortSignal): Promise<TileResult> {
  try {
    const res = await fetch(url, { signal });
    if (res.status === 404) return { status: 'none' };
    if (!res.ok) return { status: 'error', error: new Error(`HTTP ${res.status}`) };
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { status: 'ok', list: parse(bytes) };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { status: 'error', error: e instanceof Error ? e : new Error(String(e)) };
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw (signal.reason as Error | undefined) ?? new Error('中止しました');
}

/**
 * 遠い建物の残し方: 150 m 以内はすべて、それより遠くは冬の朝夕に影が届きうる高い建物だけ（far を付ける）。
 * heightOf は到達判定に使う高さ（既定は height。PLATEAU は max(形状の高さ, 実測の最高高さ) = reachHeight）
 */
export function applyDistanceRule<T extends Neighbor>(list: T[], nearM = NEIGHBOR_NEAR_M, heightOf: (n: T) => number = (n) => n.height): (T & { far?: boolean })[] {
  const out: (T & { far?: boolean })[] = [];
  for (const nb of list) {
    const c = ringCenter(nb.ring);
    const d = Math.hypot(c.e, c.n);
    if (d < nearM) {
      out.push(nb);
      continue;
    }
    if (d - heightOf(nb) * SHADOW_REACH_FACTOR < SHADOW_REACH_MARGIN) out.push({ ...nb, far: true });
  }
  return out;
}

function dedupeById<T extends Neighbor>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((b) => {
    if (seen.has(b.id)) return false;
    seen.add(b.id);
    return true;
  });
}

/** PLATEAU のポリゴンと重なる国土地理院の建物を除く（PLATEAU に無い建物 = 新しい建物・LOD0 のみの建物だけ残す） */
export function fillGapsWithGsi(plateau: Neighbor[], gsi: Neighbor[], maxOverlap = GSI_OVERLAP_MAX): Neighbor[] {
  return fillGapsWith(plateau, gsi, maxOverlap);
}

/**
 * ピン位置から半径 radiusM の建物を取得。PLATEAU（3D Tiles。実測の高さ・形状）で取れた範囲は PLATEAU を使い、
 * PLATEAU に無い建物（実足元の輪郭と重ならないもの）だけ国土地理院で補う。PLATEAU が未整備・取得失敗なら国土地理院、両方失敗なら OSM。すべて失敗なら throw。
 * PLATEAU と国土地理院のタイルは並列に取る。id は PLATEAU が `plateau:${gml_id}`（ピンを動かしても同じ）、他は出典とリング座標から決定的に作る
 * （再取得しても同じ建物が同じ id になるように。上書き設定の保持のため）。
 * opts.plateau は fetchPlateauBuildings に渡す追加の設定（テストの fetchImpl・draco・indexUrl、上限など。signal はこちらのものを使う）。
 * 戻り値の plateau は PLATEAU を使ったときだけ（使ったデータセット・索引の生成日時・LOD 別の棟数。study.env.plateau と開示に使う）
 */
export async function fetchNeighbors(
  lat: number,
  lon: number,
  radiusM: number,
  opts: { signal?: AbortSignal; onProgress?: (msg: string) => void; sources?: NeighborSource[]; plateau?: Partial<PlateauFetchOptions> } = {},
): Promise<FetchNeighborsResult> {
  const { signal, onProgress } = opts;
  const sources = opts.sources ?? ['plateau', 'gsi', 'osm'];
  const z = NEIGHBOR_TILE_Z;
  const tiles = tilesAround(lat, lon, radiusM, z);
  const notes: string[] = [];
  const sourcesUsed: NeighborSource[] = [];
  let errors = 0;
  throwIfAborted(signal);

  // 1. PLATEAU（3D Tiles）と 2. 国土地理院のタイルを並列に始める（PLATEAU は数 MB の転送になるので待ち時間を重ねる。中止は signal.reason が投げられる）
  const tPlateau: Promise<PlateauFetchResult | null> = sources.includes('plateau')
    ? (() => {
        onProgress?.('周辺建物（PLATEAU）を取得しています…');
        // 進捗の文に添えるデータセット名（tileset の段の文「建物タイルの一覧を取得（…）」から拾う）
        let dataset = '';
        return fetchPlateauBuildings(lat, lon, radiusM, {
          ...opts.plateau,
          signal,
          onProgress: (p) => {
            if (p.stage === 'tileset') dataset = /^建物タイルの一覧を取得（(.+)）$/.exec(p.message)?.[1] ?? dataset;
            onProgress?.(plateauProgressText(p, dataset));
            opts.plateau?.onProgress?.(p);
          },
        });
      })()
    : Promise.resolve(null);
  const tGsi: Promise<TileResult[] | null> = sources.includes('gsi')
    ? (() => {
        onProgress?.('周辺建物（国土地理院）を取得しています…');
        return Promise.all(tiles.map((t) => fetchTile(GSI_TILE_URL(z, t.x, t.y), (b) => parseGsiTile(b, t.x, t.y, z, lat, lon), signal)));
      })()
    : Promise.resolve(null);
  const [pr, gsiRs] = await Promise.all([tPlateau, tGsi]);
  throwIfAborted(signal);

  // PLATEAU: covered なら Neighbor に（ring/holes をピン基準へ。mesh は anchor 基準のまま）
  let plateau: Neighbor[] = [];
  let covered: Extract<PlateauFetchResult, { status: 'covered' }> | null = null;
  /** 一部のタイルが取れなかった・上限で捨てた・通信エラー（covered でなければ注記は「通信エラー」側） */
  let plateauPartial = false;
  /** 索引に無い（= その地域は PLATEAU が未整備） */
  let plateauMissing = false;
  /** データセットはあるが半径内に建物タイルが無い */
  let plateauNoTiles = false;
  if (pr) {
    if (pr.status === 'covered') {
      covered = pr;
      plateauPartial = pr.failedTiles > 0 || pr.truncated;
      plateau = dedupeById(pr.buildings.map((b) => plateauToNeighbor(b, { lat, lon })));
    } else if (pr.status === 'none') {
      plateauMissing = true;
      plateauNoTiles = pr.reason === 'noTiles';
    } else {
      errors++;
      plateauPartial = true;
    }
  }

  // 国土地理院（PLATEAU と重ならない建物だけ補う）
  let gsi: Neighbor[] = [];
  let gsiOk = false;
  let gsiFailed = false;
  if (gsiRs) {
    let failedTiles = 0;
    for (const r of gsiRs) {
      if (r.status === 'ok') {
        gsiOk = true;
        gsi.push(...r.list);
      } else if (r.status === 'error') failedTiles++;
    }
    if (failedTiles) {
      errors++;
      if (!gsiOk) gsiFailed = true;
    }
    gsi = dedupeById(gsi);
  }

  onProgress?.('周辺建物を統合しています…');
  let list: Neighbor[] = [];
  let plateauInfo: FetchNeighborsResult['plateau'];
  if (covered) {
    const fill = fillGapsWithGsi(plateau, gsi);
    list = [...plateau, ...fill];
    sourcesUsed.push('plateau');
    if (fill.length) sourcesUsed.push('gsi');
    // 注記（plateauNotes）は距離ルールの後に先頭へ入れる: 国土地理院のタイルは半径より広い範囲（z16 のタイル全体）を覆うので、
    // 補った棟数は実際に一覧へ残った棟数で書く（タイル全体の数だと実態の 10 倍以上になる）
    if (gsiFailed) notes.push('国土地理院の地図データは取得できませんでした。');
    plateauInfo = { datasets: covered.datasets, indexGenerated: await plateauIndexGenerated(opts.plateau, signal), lodCounts: covered.lodCounts };
  } else if (gsiOk) {
    // 国土地理院のタイルは取得できた（建物が 0 棟でも「データはある」として扱う）
    list = gsi;
    sourcesUsed.push('gsi');
    const hint = '周辺建物の高さは国土地理院の建物種類から推定しています（普通建物 約7m・堅ろう建物 12m・高層 30m・無壁舎 2.8m）。実際の高さが分かる建物は、建物をクリックして修正してください。';
    if (!gsi.length) {
      notes.push('この範囲には国土地理院の地図データに建物がありません（田畑・空き地など）。隣家があれば手動で追加してください。');
      // 建物が 0 棟でも PLATEAU を試みて無かった理由は残す（山村など: 開示・E2E で「未整備」か「通信エラー」かが分かるように）
      if (sources.includes('plateau') && plateauPartial && !plateauMissing) notes.push('PLATEAU（3D都市モデル）のデータも取得できませんでした（通信エラー）。');
      else if (sources.includes('plateau') && plateauNoTiles) notes.push('この範囲には PLATEAU（3D都市モデル）の建物データもありません。');
      else if (sources.includes('plateau')) notes.push('この地域は PLATEAU（3D都市モデル）が未整備です。');
    } else if (sources.includes('plateau') && plateauPartial && !plateauMissing)
      notes.push('PLATEAU のデータを取得できなかったため（通信エラー）、周辺建物の高さは国土地理院の建物種類から推定しています。「周辺建物を取り直す」でやり直せます。');
    else if (sources.includes('plateau') && plateauNoTiles) notes.push(`この範囲には PLATEAU（3D都市モデル）の建物データが無いため、${hint}`);
    else if (sources.includes('plateau')) notes.push(`この地域は PLATEAU（3D都市モデル）が未整備のため、${hint}`);
    else notes.push(hint);
  } else if (sources.includes('osm')) {
    // 3. OSM（最後の手段）
    throwIfAborted(signal);
    onProgress?.('周辺建物（OpenStreetMap）を取得しています…');
    try {
      const osm = await fetchOsmBuildings(lat, lon, radiusM);
      list = dedupeById(
        osm
          .map((b): Neighbor | null => {
            const ring = cleanRing(b.ring);
            if (ring.length < 3) return null;
            const nb: Neighbor = { id: neighborId('osm', ring, lat, lon), ring, height: b.height, source: 'osm', heightKind: b.height === 6.8 ? 'estimated' : 'measured' };
            if (b.label) nb.label = b.label;
            return nb;
          })
          .filter((b): b is Neighbor => b !== null),
      );
      sourcesUsed.push('osm');
      notes.push('PLATEAU・国土地理院の建物データが得られなかったため、OpenStreetMap の建物を使用しています（高さの多くは推定）。建物をクリックして高さを修正できます。');
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new Error(NETWORK_ERROR);
    }
  } else if (errors) {
    throw new Error(NETWORK_ERROR);
  }
  // 影の到達判定は PLATEAU の実測の最高高さも見る（LOD1 の形状の高さは点群の中央値で低め）
  const kept = applyDistanceRule(list, NEIGHBOR_NEAR_M, reachHeight);
  if (covered) notes.unshift(...plateauNotes(covered, kept.filter((n) => n.source === 'gsi').length));
  if (!kept.length && !notes.length) notes.push('周辺に建物データが見つかりませんでした。必要なら「隣家を追加」で手動で置いてください。');

  const out: FetchNeighborsResult = { list: kept, sourcesUsed, notes };
  if (plateauInfo) out.plateau = plateauInfo;
  return out;
}

/** 索引の生成日時（出典行の再現用）。索引は fetchPlateauBuildings が同じ fetchImpl でメモ化しているので通信は増えない。取れなければ '' */
async function plateauIndexGenerated(o: Partial<PlateauFetchOptions> | undefined, signal?: AbortSignal): Promise<string> {
  try {
    return (await loadPlateauIndex({ fetchImpl: o?.fetchImpl, signal, url: o?.indexUrl })).generated;
  } catch {
    return '';
  }
}

/** 多角形（e/n）のいずれかと重なる建物を除く（敷地内の既存建物・建て替え前の家など） */
export function excludeOverlapping(list: Neighbor[], polygons: EN[][]): Neighbor[] {
  const polys = polygons.filter((p) => p.length >= 3);
  if (!polys.length) return list;
  return list.filter((nb) => !polys.some((poly) => ringsOverlap(nb.ring, poly)));
}

let manualCounter = 0;

/** 手動の隣家（方位 deg・距離 m・幅・奥行・高さ）。方位 dirDeg の方向へ distance 進んだ点を中心にした軸平行の矩形 */
export function makeManualNeighbor(dirDeg: number, distance: number, width: number, depth: number, height: number): Neighbor {
  const a = (dirDeg * Math.PI) / 180;
  const ce = Math.sin(a) * distance;
  const cn = Math.cos(a) * distance;
  const hw = Math.max(0.1, width) / 2;
  const hd = Math.max(0.1, depth) / 2;
  manualCounter++;
  return {
    id: `manual:${Date.now().toString(36)}:${manualCounter}`,
    ring: [
      { e: ce - hw, n: cn - hd },
      { e: ce + hw, n: cn - hd },
      { e: ce + hw, n: cn + hd },
      { e: ce - hw, n: cn + hd },
    ],
    height: Math.max(0.1, height),
    source: 'manual',
    heightKind: 'manual',
    label: '隣家',
  };
}

// ---------------------------------------------------------------------------
// メッシュ
// ---------------------------------------------------------------------------

const WALL_COLOR: Record<Neighbor['heightKind'], string> = { measured: '#e8e6e1', estimated: '#ead9c2', manual: '#d9c7a8' };

/** 想定の家の色（壁・屋根。半透明にしない） */
export const PLANNED_WALL_COLOR = PLANNED_COLORS.wall;
export const PLANNED_ROOF_COLOR = PLANNED_COLORS.roof;

/**
 * 周辺建物のメッシュを作る。押し出し: 足元は groundY(e, n)（ワールド y。地形の最低点）、上面は 足元 + height。
 * 屋上に航空写真を貼る（aerial があれば）。壁は明るいグレー、推定は薄いベージュ、手動は薄い茶。
 * 各 Mesh の userData: { neighborId, neighbor: true, heightKind, matKey: 'neighbor' }。castShadow / receiveShadow。
 *
 * 想定の家（nb.planned）は押し出しではなく屋根付きの形（buildPlannedHouseGeometry。軒の出も影に入る）で、壁 #cfdcec・屋根 #6f8fb3
 * （不透明・航空写真は貼らない）。足元は手動の隣家と同じく groundY の最低点 + 0.3（groundY は 0.3 m 下げた地盤を渡す約束）から高さを測り、
 * 壁は 0.3 m 地面に埋める。userData は同じ + planned: true。マテリアルは [屋根, 壁]（グループ 0 = 屋根、1 = 壁）
 *
 * PLATEAU の実形状（nb.mesh と nb.plateau）は押し出さず buildPlateauGeometry で描く（仕様 §5 の接地）:
 *  - 平行移動 off = frameToLocal(pin, plateau.anchor)（ring と同じ量。mesh は anchor 基準のままなのでピン移動で頂点を書き換えない。pin が無ければ (0, 0) = テスト用）
 *  - 足元 baseY（plateauBaseY）: DEM の格子内なら ring（+ 重心）の groundY の最低点 + 0.3（押し出しの measured と同じ規則 = DEM 最低点）、
 *    格子の外（far の建物）なら plateau.zmin − groundElev（絶対標高）、DEM が無い（grid 無し／'flat'）なら groundY の最低点 + 0.3（平地では 0）
 *  - heightScale = height / (zmax − zmin)（高さの上書きは足元を固定した縦の伸縮）、sinkBottom 0.3（壁の下端だけ地面に埋める。屋根は動かない）、
 *    航空写真は far でない建物の屋根に平面投影（anchor 基準 → ピン基準に off を足して写真の範囲に正規化）。
 *    マテリアルは [屋根, 壁]（groups 0 = 屋根, 1 = 壁。押し出しと同じ配列の契約）、userData も同じ 4 キー
 *
 * Shape は (e, n) で作り、+Z へ押し出してから rotateX(-π/2) する: (e, n, d) → (x=e, y=d, z=-n)。これはワールドの (x=東, z=南) に一致する。
 */
export function buildNeighborMeshes(
  list: Neighbor[],
  opts: { groundY: (e: number, n: number) => number; aerial?: AerialImage | null; pin?: LatLon | null; grid?: HeightGrid | null; groundElev?: number | null },
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'neighbors';
  const aerial = opts.aerial ?? null;
  let tex: THREE.CanvasTexture | null = null;
  if (aerial && aerial.east > aerial.west && aerial.north > aerial.south) {
    tex = new THREE.CanvasTexture(aerial.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  const roofPlain = new THREE.MeshStandardMaterial({ color: '#8d8f93', roughness: 0.8 });
  const roofAerial = tex ? new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }) : null;
  const wallMats: Partial<Record<Neighbor['heightKind'], THREE.MeshStandardMaterial>> = {};
  const wallMat = (kind: Neighbor['heightKind']) => (wallMats[kind] ??= new THREE.MeshStandardMaterial({ color: WALL_COLOR[kind] ?? WALL_COLOR.measured, roughness: 0.9 }));
  let plannedMats: THREE.MeshStandardMaterial[] | null = null;

  for (const nb of list as NeighborEx[]) {
    if (nb.hidden) continue;
    if (nb.planned) {
      // 想定の家: 屋根付きの形（中心・高さは ring・height に合わせる）
      const p = syncPlannedHouse(nb.planned, nb.ring, nb.height);
      let g0 = Infinity;
      for (const c of plannedFootprint(p)) {
        const g = opts.groundY(c.e, c.n);
        if (Number.isFinite(g) && g < g0) g0 = g;
      }
      if (!Number.isFinite(g0)) g0 = 0;
      const geo = buildPlannedHouseGeometry(p, { toWorld: (e, n, y) => new THREE.Vector3(e, y, -n), baseY: g0 + 0.3, sink: 0.3 });
      plannedMats ??= [new THREE.MeshStandardMaterial({ color: PLANNED_ROOF_COLOR, roughness: 0.75 }), new THREE.MeshStandardMaterial({ color: PLANNED_WALL_COLOR, roughness: 0.85 })];
      const mesh = new THREE.Mesh(geo, plannedMats);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = nb.label ?? '想定の家';
      mesh.userData = { neighbor: true, neighborId: nb.id, heightKind: nb.heightKind, matKey: 'neighbor', planned: true };
      group.add(mesh);
      continue;
    }
    if (nb.mesh && nb.plateau) {
      // PLATEAU の実形状
      const off = opts.pin ? frameToLocal(opts.pin, nb.plateau.anchor) : { e: 0, n: 0 };
      const baseY = plateauBaseY(nb as Neighbor & { plateau: PlateauAttrs }, opts);
      const span = nb.plateau.zmax - nb.plateau.zmin;
      const heightScale = span > 0.01 ? Math.max(0.1, nb.height) / span : 1;
      const useAerial = !!roofAerial && !!aerial && !nb.far;
      const roofUV = useAerial && aerial ? { west: aerial.west, east: aerial.east, south: aerial.south, north: aerial.north, toEN: (x: number, zl: number) => ({ e: x + off.e, n: -zl + off.n }) } : null;
      const geo = buildPlateauGeometry(nb.mesh, { heightScale, sinkBottom: 0.3, roofUV });
      geo.translate(off.e, baseY, -off.n);
      const mesh = new THREE.Mesh(geo, [useAerial && roofAerial ? roofAerial : roofPlain, wallMat(nb.heightKind)]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = nb.label ?? '周辺建物';
      mesh.userData = { neighbor: true, neighborId: nb.id, heightKind: nb.heightKind, matKey: 'neighbor' };
      group.add(mesh);
      continue;
    }
    const ring = cleanRing(nb.ring);
    if (ring.length < 3) continue;
    const shape = new THREE.Shape(ring.map((p) => new THREE.Vector2(p.e, p.n)));
    for (const h of nb.holes ?? []) {
      const hr = cleanRing(h);
      if (hr.length >= 3) shape.holes.push(new THREE.Path(hr.map((p) => new THREE.Vector2(p.e, p.n))));
    }
    let minG = Infinity;
    let maxG = -Infinity;
    for (const p of ring) {
      const g = opts.groundY(p.e, p.n);
      if (!Number.isFinite(g)) continue;
      if (g < minG) minG = g;
      if (g > maxG) maxG = g;
    }
    if (!Number.isFinite(minG)) {
      minG = 0;
      maxG = 0;
    }
    // 推定の高さは「地面からの高さ」なので、傾斜地では高い側の地面を基準にする（低い側に合わせると低く見えるため）
    const depth = Math.max(0.1, nb.heightKind === 'estimated' ? nb.height + (maxG - minG) + 0.3 : nb.height + 0.3);
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, minG, 0);
    const useAerial = !!roofAerial && !nb.far;
    if (useAerial && aerial) {
      // 屋根面（上向き）の UV を航空写真の座標に（x = e, z = -n）
      const pos = geo.getAttribute('position');
      const nor = geo.getAttribute('normal');
      const uv = geo.getAttribute('uv');
      for (let i = 0; i < pos.count; i++) {
        if (nor.getY(i) < 0.9) continue;
        const e = pos.getX(i);
        const n = -pos.getZ(i);
        uv.setXY(i, (e - aerial.west) / (aerial.east - aerial.west), (n - aerial.south) / (aerial.north - aerial.south));
      }
      uv.needsUpdate = true;
    }
    // ExtrudeGeometry のグループ: 0 = 上下面, 1 = 側面
    const mesh = new THREE.Mesh(geo, [useAerial && roofAerial ? roofAerial : roofPlain, wallMat(nb.heightKind)]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = nb.label ?? '周辺建物';
    mesh.userData = { neighbor: true, neighborId: nb.id, heightKind: nb.heightKind, matKey: 'neighbor' };
    group.add(mesh);
  }
  return group;
}

/**
 * PLATEAU の実形状の足元（ワールド y。足元の頂点 y=0 がここに来る。壁は sinkBottom でさらに 0.3 m 埋める）。仕様 §5:
 *  - DEM の格子内（ring の重心が grid の範囲内）: ring の頂点 + 重心の groundY の最低点 + 0.3（groundY は 0.3 m 下げた値を渡す約束。押し出しの measured と同じ = DEM 最低点）
 *  - DEM があるが格子の外（far の建物）: plateau.zmin − groundElev（PLATEAU の地盤 T.P. を絶対標高として使う。_zmin と DEM5A は ±0.4 m で一致）
 *  - DEM が無い（grid 無し／source 'flat'）: groundY の最低点 + 0.3（平地の groundY は −0.3 なので 0）
 */
export function plateauBaseY(nb: Neighbor & { plateau: PlateauAttrs }, opts: { groundY: (e: number, n: number) => number; grid?: HeightGrid | null; groundElev?: number | null }): number {
  const c = ringCenter(nb.ring);
  const g = opts.grid;
  if (g && g.source !== 'flat' && !(c.e >= g.west && c.e <= g.east && c.n >= g.south && c.n <= g.north) && Number.isFinite(nb.plateau.zmin)) {
    return nb.plateau.zmin - (opts.groundElev ?? 0);
  }
  let minG = Infinity;
  for (const p of [...nb.ring, c]) {
    const y = opts.groundY(p.e, p.n);
    if (Number.isFinite(y) && y < minG) minG = y;
  }
  return Number.isFinite(minG) ? minG + 0.3 : 0;
}
