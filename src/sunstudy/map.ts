/**
 * 場所を選ぶ 2D 地図（Canvas のスリッピーマップ。国土地理院タイル）
 *  - タイル: std（標準地図）/ pale（淡色地図）/ seamlessphoto（航空写真）。配信はどれも z18 まで（MAP_LAYER_MAX_ZOOM）
 *  - ドラッグでパン、ホイール・ボタン・ダブルクリック・2 本指ピンチでズーム（z 5..22、小数ズーム可）。
 *    18 より先はタイルを取り直さず、z18 のタイルを 2^(zoom − 18) 倍に引き伸ばして描く（タイルのキャッシュは取得したズームの URL のまま）。
 *    スケールバー・metersPerPixel は表示のズームで計算するので、引き伸ばしても正しい
 *  - クリックでピン、ピンのドラッグ
 *  - 敷地の輪郭:
 *     描くモード（setPolygonMode）: クリックで頂点追加、最初の頂点・Enter・「完了」で閉じる、右クリック/Backspace で最後の頂点を消す
 *     編集モード（setPolygonEditMode）: 頂点のドラッグ（選択）、選んだ頂点を Delete／右クリックで削除（3 点まで）、辺の中点の「＋」で頂点を足す
 *       （クリックで中点に、ドラッグでその場所に）、面積の札をドラッグで輪郭全体を動かす
 *     描く・編集の間は辺の長さ（m, 小数 2 桁）と面積を表示。Shift を押しながら置く／ドラッグすると、新しい辺を直前の辺に直角か平行にそろえる
 *     （頂点のドラッグでは前後の辺のどちらにも。両方そろう点が近ければそこへ）。
 *     Ctrl+Z / Shift+Ctrl+Z（Ctrl+Y）で輪郭の変更を取り消し／やり直し（頂点の追加・移動・削除・閉じる・消す・数値での変更）
 *     どの頂点も（描く・編集のモードでなくても）ドラッグで動かせる（今までどおり）
 *  - 道具（setTool）: 'point' クリックした地点、'line' 2 回のクリック（向き）、'edge' 敷地の輪郭の辺、'lot' 区画の多角形（敷地の輪郭とは別に描く）。
 *    道具が付いている間はクリックでピンを動かさない。Esc で外れる（onToolChange(null)）
 *  - 想定の家（setPlannedHouses）: 水色の足元に「想定」の札（含めない設定のときは薄い破線）。どのモードでもないときクリックで選び（onPlannedSelect）、
 *    ドラッグで動かす（onPlannedMove）、R / Shift+R で 90° 回す（onPlannedRotate）、矢印キーで 0.1 m（Shift で 1 m）、Delete で消す（onPlannedDelete）。
 *    生成した区画（setLotOutlines）は青の破線
 *  - 建物の足跡（e/n）・周辺建物の輪郭・解析半径の円・スケールバー・方位（北が上）の描画
 *  - 周辺建物を選ぶモード（setNeighborPickMode）: クリックした輪郭の id を onNeighborClick に渡す（ピンは動かさない）。
 *    隠した建物の輪郭（hidden）は灰色の破線で描く（表示だけ隠した建物 viewOnly は青の破線。影・解析には残っている）
 *  - 出典（attribution）とボタン類は DOM 側（placeStep）が描く。ここでは文字列を返すだけ
 *
 * 依存ライブラリ無し。純粋な関数（metersPerPixel / polygonAreaM2 / 辺の長さ・スナップ・画素変換）は Node でも読み込める
 * （モジュール読み込み時に document / window には触らない）。
 */
import type { LatLon } from './types';
import { frameFromLocal, frameToLocal } from './types';
import { lonLatToTile, tileToLonLat, metersPerDegree } from '../sun/geo';
import { hitRingAt, segmentDistance } from './neighborSelect';

export type MapLayer = 'std' | 'pale' | 'photo';

export const MAP_LAYER_LABEL: Record<MapLayer, string> = { std: '標準地図', pale: '淡色地図', photo: '航空写真' };

/** 出典の表記（レイヤーごと） */
export const MAP_LAYER_ATTRIBUTION: Record<MapLayer, string> = {
  std: '地理院タイル（標準地図）',
  pale: '地理院タイル（淡色地図）',
  photo: '地理院タイル（シームレス空中写真）',
};

export const TILE_SIZE = 256;
export const MIN_ZOOM = 5;
/** 地図の最大ズーム。タイルの配信は各レイヤーの上限（MAP_LAYER_MAX_ZOOM）まで、それより先はタイルを引き伸ばして描く（敷地の角を細かく置けるように） */
export const MAX_ZOOM = 22;
/** 地理院タイルの配信上の最大ズーム */
export const TILE_MAX_ZOOM = 18;
/** レイヤーごとのタイル配信の最大ズーム（標準地図・淡色地図・シームレス空中写真とも 18） */
export const MAP_LAYER_MAX_ZOOM: Record<MapLayer, number> = { std: 18, pale: 18, photo: 18 };
/** Web メルカトルの緯度の限界 */
const MAX_LAT = 85.05112878;
/** タイルキャッシュの上限（枚） */
const TILE_CACHE_MAX = 800;
/** 同時に読み込むタイルの上限 */
const MAX_INFLIGHT = 24;
/** ピンの頭（丸）の中心は基準点から何 px 上か */
const PIN_HEAD_DY = 24;
/** ドラッグとみなす動き (px)。これ以下で離せばクリック（今までの地図の操作） */
const DRAG_PX = 5;
/** 道具（想定の家を置く・辺を選ぶなど）のクリック: 押してから離すまでの動きがこれ以下 (px) */
const TOOL_CLICK_PX = 3;
/** 取り消しの記録の上限 */
const HISTORY_MAX = 100;
/** 辺の中点の「＋」を出す辺の画面上の長さの下限 (px) */
const MID_HANDLE_MIN_PX = 28;
/** 辺の長さの札を出す辺の画面上の長さの下限 (px) */
const EDGE_LABEL_MIN_PX = 30;
/** 文字のフォント */
const FONT = 'system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif';

const TILE_PATH: Record<MapLayer, { dir: string; ext: string }> = {
  std: { dir: 'std', ext: 'png' },
  pale: { dir: 'pale', ext: 'png' },
  photo: { dir: 'seamlessphoto', ext: 'jpg' },
};

/** 地図に重ねる道具の種類 */
export type MapToolKind = 'point' | 'line' | 'edge' | 'lot';

/**
 * 道具: 'point' = クリックした地点（preview があればカーソルの所にその形を破線で）、'line' = 2 回のクリック（a → b）、
 * 'edge' = 敷地の輪郭の辺（辺 i = poly[i] → poly[i+1]）、'lot' = 区画の多角形（最初の点・Enter で閉じる。3 点以上）
 */
export type MapTool =
  | { kind: 'point'; onPick: (p: LatLon) => void; preview?: (p: LatLon) => { e: number; n: number }[] | null }
  | { kind: 'line'; onPick: (a: LatLon, b: LatLon) => void }
  | { kind: 'edge'; onPick: (index: number) => void }
  | { kind: 'lot'; onPick: (poly: LatLon[]) => void };

export interface MapPickerOptions {
  initial: LatLon;
  zoom?: number;
  layer?: MapLayer;
  /** ピンが置かれた・動いた */
  onPin?: (p: LatLon) => void;
  /** 敷地ポリゴンが変わった（頂点追加・移動・削除・クリア・取り消し） */
  onPolygonChange?: (poly: LatLon[], closed: boolean) => void;
  /** 表示範囲が変わった（ズーム・中心） */
  onView?: (center: LatLon, zoom: number) => void;
  /** 輪郭モードが地図側の操作（閉じた・Esc・取り消し）で切り替わった。UI のボタン表示を同期するため */
  onPolygonModeChange?: (on: boolean) => void;
  /** 輪郭の編集モードが地図側の操作（Esc・輪郭が無くなった）で切り替わった */
  onEditModeChange?: (on: boolean) => void;
  /** 道具が地図側の操作（Esc）で外れた */
  onToolChange?: (kind: MapToolKind | null) => void;
  /** 輪郭の取り消し・やり直しの可否が変わった */
  onHistoryChange?: () => void;
  /** 案内（「3 点より少なくできません」など）。DOM 側がトーストで出す */
  onNotice?: (msg: string) => void;
  /** 描くたびに（地図に重ねた DOM の位置合わせ用。軽い処理だけ） */
  onDraw?: () => void;
  /** スケールバーの位置（左下からのオフセット px）。既定 {x:12, y:12} */
  scaleBarOffset?: { x: number; y: number };
  /**
   * 地図タイルが 1 枚も読めないまま一定枚数失敗した（地図サーバーに接続できない環境・オフライン）。
   * 1 回だけ呼ばれる。その後 1 枚でも読めれば onTilesAvailable が呼ばれ、また失敗が続けば再度呼ばれる
   */
  onTilesUnavailable?: () => void;
  /** 地図タイルが読めるようになった（onTilesUnavailable の後） */
  onTilesAvailable?: () => void;
  /** 周辺建物を選ぶモードで地図をクリックした（輪郭の id。輪郭の外なら null） */
  onNeighborClick?: (id: string | null) => void;
  /** 周辺建物を選ぶモードが地図側の操作（Esc）で終わった */
  onNeighborPickModeChange?: (on: boolean) => void;
  /** 想定の家をクリックで選んだ／選択を外した（null） */
  onPlannedSelect?: (id: string | null) => void;
  /** 想定の家をドラッグ・矢印キーで動かした（東・北 m の移動量。ドラッグは指を離したときに 1 回） */
  onPlannedMove?: (id: string, dE: number, dN: number) => void;
  /** 選んだ想定の家を R（+90 = 上から見て時計回り）/ Shift+R（−90）で回した */
  onPlannedRotate?: (id: string, deltaDeg: number) => void;
  /** 選んだ想定の家を Delete で消す */
  onPlannedDelete?: (id: string) => void;
}

/** 地図に描く周辺建物の輪郭（ピンからの東・北 m）。hidden = 隠した建物（灰色の破線）、hidden + viewOnly = 表示だけ隠した建物（青の破線） */
export interface MapNeighborRing {
  id: string;
  ring: { e: number; n: number }[];
  hidden?: boolean;
  viewOnly?: boolean;
}

/** 地図に描く想定の家（ピンからの東・北 m）。lines = 棟などの線、inactive = 影・解析に含めない設定（薄い破線） */
export interface MapPlannedHouse {
  id: string;
  ring: { e: number; n: number }[];
  lines?: { e: number; n: number }[][];
  inactive?: boolean;
}

/** 1 枚も読めないまま何枚失敗したら「地図サーバーに接続できない」と判断するか */
const TILE_FAIL_THRESHOLD = 6;

// ---------------------------------------------------------------------------
// 純粋なヘルパー（DOM 不要）
// ---------------------------------------------------------------------------

/** 画面の点 */
export interface XY {
  x: number;
  y: number;
}

/** タイル URL（国土地理院） */
export function tileUrl(layer: MapLayer, z: number, x: number, y: number): string {
  const t = TILE_PATH[layer];
  return `https://cyberjapandata.gsi.go.jp/xyz/${t.dir}/${z}/${x}/${y}.${t.ext}`;
}

export function clampZoom(z: number): number {
  if (!isFinite(z)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** 表示のズーム zoom で取得するタイルのズーム（整数。レイヤーの配信上限まで。それより先は引き伸ばす） */
export function tileZoomFor(layer: MapLayer, zoom: number): number {
  const max = MAP_LAYER_MAX_ZOOM[layer] ?? TILE_MAX_ZOOM;
  return Math.max(0, Math.min(Math.floor(clampZoom(zoom) + 1e-9), max));
}

/** 中心座標を Web メルカトルの範囲に収める（緯度 ±85°、経度は -180..180 に折り返す） */
export function clampCenter(p: LatLon): LatLon {
  const lat = Math.min(MAX_LAT, Math.max(-MAX_LAT, isFinite(p.lat) ? p.lat : 0));
  const lon0 = isFinite(p.lon) ? p.lon : 0;
  const lon = ((((lon0 + 180) % 360) + 360) % 360) - 180;
  return { lat, lon };
}

/** 緯度経度 → ズーム z の世界画素座標（タイル 256px。z は小数でもよい） */
export function lonLatToWorldPx(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const t = lonLatToTile(lon, lat, zoom);
  return { x: t.x * TILE_SIZE, y: t.y * TILE_SIZE };
}

/** 世界画素座標 → 緯度経度 */
export function worldPxToLonLat(x: number, y: number, zoom: number): LatLon {
  const ll = tileToLonLat(x / TILE_SIZE, y / TILE_SIZE, zoom);
  return { lat: ll.lat, lon: ll.lon };
}

/** 緯度でのメートル／画素（Web メルカトル, タイル 256px） */
export function metersPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/** 多角形（緯度経度）の面積 (㎡)。局所平面（重心の緯度での m/度）で靴紐公式 */
export function polygonAreaM2(poly: LatLon[]): number {
  if (poly.length < 3) return 0;
  const o = meanLatLon(poly);
  const { mLat, mLon } = metersPerDegree(o.lat);
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ax = (a.lon - o.lon) * mLon;
    const ay = (a.lat - o.lat) * mLat;
    const bx = (b.lon - o.lon) * mLon;
    const by = (b.lat - o.lat) * mLat;
    s += ax * by - bx * ay;
  }
  return Math.abs(s) / 2;
}

function meanLatLon(poly: LatLon[]): LatLon {
  let lat = 0;
  let lon = 0;
  for (const p of poly) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / poly.length, lon: lon / poly.length };
}

/** 多角形の重心（面積重心。退化していれば頂点の平均）。空なら null */
export function polygonCentroid(poly: LatLon[]): LatLon | null {
  if (!poly.length) return null;
  const o = meanLatLon(poly);
  if (poly.length < 3) return o;
  const { mLat, mLon } = metersPerDegree(o.lat);
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const px = (p.lon - o.lon) * mLon;
    const py = (p.lat - o.lat) * mLat;
    const qx = (q.lon - o.lon) * mLon;
    const qy = (q.lat - o.lat) * mLat;
    const cross = px * qy - qx * py;
    a2 += cross;
    cx += (px + qx) * cross;
    cy += (py + qy) * cross;
  }
  if (Math.abs(a2) < 1e-6) return o;
  cx /= 3 * a2;
  cy /= 3 * a2;
  return { lat: o.lat + cy / mLat, lon: o.lon + cx / mLon };
}

/** 面積の表示文字列（㎡ と 坪） */
export function formatArea(areaM2: number): string {
  return `${areaM2.toFixed(1)}㎡（${(areaM2 / 3.305785).toFixed(1)}坪）`;
}

/** 長さの表示文字列（m, 小数 2 桁） */
export function formatLength(m: number): string {
  return `${m.toFixed(2)}m`;
}

/** 2 点間の水平距離 (m)。a を基準にした局所平面（敷地の大きさなら誤差は 1 mm 未満） */
export function distanceM(a: LatLon, b: LatLon): number {
  const d = frameToLocal(a, b);
  return Math.hypot(d.e, d.n);
}

/** 方位（真北から時計回り, 度, [0, 360)）: a → b */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const d = frameToLocal(a, b);
  const deg = (Math.atan2(d.e, d.n) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** 辺の長さ (m)。closed なら n 本（辺 i = poly[i] → poly[i+1]、最後は poly[n−1] → poly[0]）、閉じていなければ n − 1 本 */
export function edgeLengthsM(poly: LatLon[], closed = true): number[] {
  const n = poly.length;
  if (n < 2) return [];
  const out: number[] = [];
  const m = closed && n >= 3 ? n : n - 1;
  for (let i = 0; i < m; i++) out.push(distanceM(poly[i], poly[(i + 1) % n]));
  return out;
}

/**
 * 辺 i（poly[i] → poly[i+1]）の長さを lengthM にした多角形: 辺の終点 poly[i+1]（最後の辺なら poly[0]）を辺の向きに沿って動かす（他の頂点はそのまま）。
 * 長さ 0 の辺・範囲外の i・正でない長さなら null。元の配列は変えない
 */
export function withEdgeLength(poly: LatLon[], i: number, lengthM: number): LatLon[] | null {
  const n = poly.length;
  if (n < 2 || !Number.isInteger(i) || i < 0 || i >= n || !(lengthM > 0) || !Number.isFinite(lengthM)) return null;
  const j = (i + 1) % n;
  if (j === i) return null;
  const a = poly[i];
  const d = frameToLocal(a, poly[j]);
  const L = Math.hypot(d.e, d.n);
  if (!(L > 1e-9)) return null;
  const k = lengthM / L;
  const out = poly.map((p) => ({ lat: p.lat, lon: p.lon }));
  out[j] = frameFromLocal(a, d.e * k, d.n * k);
  return out;
}

/**
 * 長方形の区画: 中心 c、間口 width（方位 bearingDeg = 真北から時計回りの向きに沿った辺）× 奥行 depth。
 * 頂点の順: 間口の辺（辺 1）→ 奥行の辺 → 間口の辺 → 奥行の辺（上から見て反時計回り）
 */
export function rectangleLot(c: LatLon, width: number, depth: number, bearing: number): LatLon[] {
  const r = (bearing * Math.PI) / 180;
  const u = { e: Math.sin(r), n: Math.cos(r) };
  const v = { e: -u.n, n: u.e };
  const a = width / 2;
  const b = depth / 2;
  const at = (su: number, sv: number) => frameFromLocal(c, su * a * u.e + sv * b * v.e, su * a * u.n + sv * b * v.n);
  return [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
}

/** 多角形を東・北 (m) に動かす（最初の頂点を基準にした局所平面で。形は変わらない） */
export function translatePolygon(poly: LatLon[], dE: number, dN: number): LatLon[] {
  if (!poly.length) return [];
  const o = poly[0];
  return poly.map((p) => {
    const q = frameToLocal(o, p);
    return frameFromLocal(o, q.e + dE, q.n + dN);
  });
}

const sub = (a: XY, b: XY): XY => ({ x: a.x - b.x, y: a.y - b.y });
const unit = (v: XY): XY | null => {
  const L = Math.hypot(v.x, v.y);
  return L > 1e-9 ? { x: v.x / L, y: v.y / L } : null;
};
/** 点 p を、点 o を通る向き d（単位）の直線に下ろした足 */
const projectOnLine = (p: XY, o: XY, d: XY): XY => {
  const t = (p.x - o.x) * d.x + (p.y - o.y) * d.y;
  return { x: o.x + d.x * t, y: o.y + d.y * t };
};

/**
 * Shift のスナップ（画面座標。Web メルカトルは角度を保つので画面の直角 = 地面の直角）:
 * 新しい辺 from → to を、直前の辺 prev → from に平行（延長）か直角のうち近い方にそろえた to。prev が無ければ東西・南北にそろえる
 */
export function snapToPrevEdge(prev: XY | null, from: XY, to: XY): XY {
  const ax = (prev && unit(sub(from, prev))) || { x: 1, y: 0 };
  const perp = { x: -ax.y, y: ax.x };
  const d = sub(to, from);
  const a = d.x * ax.x + d.y * ax.y;
  const b = d.x * perp.x + d.y * perp.y;
  return Math.abs(a) >= Math.abs(b) ? { x: from.x + ax.x * a, y: from.y + ax.y * a } : { x: from.x + perp.x * b, y: from.y + perp.y * b };
}

/**
 * Shift で頂点 i をドラッグするときのスナップ（画面座標）: 前の辺（i−1 → i）を、その前の辺（i−2 → i−1）に直角か平行に、
 * 後の辺（i → i+1）を、その後の辺（i+1 → i+2）に直角か平行にそろえる直線を作り、両方が交わる点がカーソルから tol px 以内ならそこ
 * （長方形の角）、そうでなければ近い方の直線に下ろした点。そろえる辺が無ければ cursor のまま
 */
export function snapVertex(pts: XY[], i: number, closed: boolean, cursor: XY, tol = 24): XY {
  const n = pts.length;
  const at = (k: number): number => (closed ? ((k % n) + n) % n : k);
  const ok = (k: number) => (closed ? n >= 3 : k >= 0 && k < n);
  const lines: { o: XY; d: XY }[] = [];
  const addLine = (through: number, from: number) => {
    if (!ok(through) || !ok(from)) return;
    const a = at(through);
    const b = at(from);
    if (a === i || b === i || a === b) return;
    const u = unit(sub(pts[a], pts[b]));
    if (!u) return;
    const cands = [u, { x: -u.y, y: u.x }];
    let best = cands[0];
    let bestD = Infinity;
    for (const d of cands) {
      const q = projectOnLine(cursor, pts[a], d);
      const dist = Math.hypot(q.x - cursor.x, q.y - cursor.y);
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    lines.push({ o: pts[a], d: best });
  };
  addLine(i - 1, i - 2);
  addLine(i + 1, i + 2);
  if (!lines.length) return { ...cursor };
  if (lines.length === 2) {
    const [l1, l2] = lines;
    const det = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
    if (Math.abs(det) > 1e-9) {
      const w = sub(l2.o, l1.o);
      const t = (w.x * l2.d.y - w.y * l2.d.x) / det;
      const x = { x: l1.o.x + l1.d.x * t, y: l1.o.y + l1.d.y * t };
      if (Math.hypot(x.x - cursor.x, x.y - cursor.y) <= tol) return x;
    }
  }
  let best = cursor;
  let bestD = Infinity;
  for (const l of lines) {
    const q = projectOnLine(cursor, l.o, l.d);
    const d = Math.hypot(q.x - cursor.x, q.y - cursor.y);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return { ...best };
}

const NICE_LENGTHS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];

/** スケールバー: maxPx 以下に収まる「きれいな」長さ（0.5/1/2/5/10/20/50/100 m …）を選ぶ */
export function niceScaleBar(metersPerPx: number, maxPx = 120): { meters: number; px: number; label: string } {
  const maxM = metersPerPx * maxPx;
  let m = NICE_LENGTHS[0];
  for (const n of NICE_LENGTHS) if (n <= maxM) m = n;
  const px = m / metersPerPx;
  const label = m >= 1000 ? `${m / 1000}km` : `${m}m`;
  return { meters: m, px, label };
}

// ---------------------------------------------------------------------------
// MapPicker
// ---------------------------------------------------------------------------

type TileEntry = HTMLImageElement | 'loading' | 'error';

interface DragBase {
  id: number;
  sx: number;
  sy: number;
  t0: number;
  moved: boolean;
}
type Drag =
  | (DragBase & { kind: 'pan'; c0: { x: number; y: number } })
  | (DragBase & { kind: 'pin'; offX: number; offY: number; lastFire: number })
  | (DragBase & { kind: 'vertex'; index: number; lastFire: number; recorded: boolean })
  /** 辺の中点の「＋」: クリックで中点に、動かしたらその場所に頂点を足して頂点のドラッグに変わる */
  | (DragBase & { kind: 'mid'; edge: number })
  /** 輪郭全体を動かす（面積の札） */
  | (DragBase & { kind: 'move'; start: LatLon; base: LatLon[]; lastFire: number; recorded: boolean })
  | (DragBase & { kind: 'planned'; plannedId: string; start: LatLon });

interface Pinch {
  startDist: number;
  startZoom: number;
  anchor: LatLon;
}

interface PolySnapshot {
  poly: LatLon[];
  closed: boolean;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class MapPicker {
  readonly canvas: HTMLCanvasElement;

  private readonly container: HTMLElement;
  private readonly opts: MapPickerOptions;
  private readonly ctx: CanvasRenderingContext2D | null;

  private W = 0;
  private H = 0;
  private dpr = 1;

  private _center: LatLon;
  private _zoom: number;
  private _layer: MapLayer;
  private _pin: LatLon | null = null;

  private _polygon: LatLon[] = [];
  private _polyClosed = false;
  private _polyMode = false;
  /** 輪郭の編集モード（閉じた輪郭の頂点の選択・削除・中点の「＋」・全体の移動・辺の長さの表示） */
  private _polyEdit = false;
  /** 編集モードで選んだ頂点（無ければ −1） */
  private selVertex = -1;
  /** 強調する辺（サイドの辺の一覧で入力中の辺）。無ければ −1 */
  private highlightEdge = -1;
  private undoStack: PolySnapshot[] = [];
  private redoStack: PolySnapshot[] = [];
  /** 面積の札の画面上の矩形（編集モードで全体を動かすつまみ） */
  private moveHandleRect: Rect | null = null;

  private footprint: { e: number; n: number }[] | null = null;
  private footprintInner: { e: number; n: number }[] | null = null;
  private neighborRings: MapNeighborRing[] | null = null;
  private _neighborPick = false;
  /** 選ぶモードでカーソルの下にある輪郭の id */
  private hoverRingId: string | null = null;
  /** 選ぶモードの直前のクリック（ダブルクリックでの拡大の 2 回目で隠す／戻すを打ち消さない） */
  private lastPickClick: { x: number; y: number; t: number } | null = null;
  private radiusM: number | null = null;

  private planned: MapPlannedHouse[] = [];
  private _plannedSel: string | null = null;
  /** ドラッグ中の想定の家のずれ（東・北 m） */
  private plannedPreview: { id: string; dE: number; dN: number } | null = null;
  private hoverPlanned: string | null = null;
  private lots: { e: number; n: number }[][] = [];

  private _tool: MapTool | null = null;
  /** 'line' の 1 点目 */
  private lineA: LatLon | null = null;
  /** 'lot' で描いている区画の頂点 */
  private lotPts: LatLon[] = [];
  /** 'edge' でカーソルの下にある辺 */
  private hoverEdge = -1;

  private readonly cache = new Map<string, TileEntry>();
  private inflight = 0;
  /** 連続して失敗したタイル数（1 枚読めたら 0 に戻る） */
  private failStreak = 0;
  private tilesUnavailable = false;

  private rafId = 0;
  private animId = 0;
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private drag: Drag | null = null;
  private pinch: Pinch | null = null;
  private hover: { x: number; y: number } | null = null;
  /** Shift を押している（スナップの下見） */
  private shiftHeld = false;
  /** スケールバーの位置（setScaleBarOffset。無ければ opts.scaleBarOffset） */
  private scaleBarOffset: { x: number; y: number } | null = null;

  private ro: ResizeObserver | null = null;

  constructor(container: HTMLElement, opts: MapPickerOptions) {
    this.container = container;
    this.opts = opts;
    this._center = clampCenter(opts.initial);
    this._zoom = clampZoom(opts.zoom ?? 16);
    this._layer = opts.layer ?? 'std';

    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', '地図');
    container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDblClick);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('online', this.onOnline);

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(container);
    } else {
      window.addEventListener('resize', this.onWindowResize);
    }
    this.resize();
  }

  // ----- レイヤー ---------------------------------------------------------

  get layer(): MapLayer {
    return this._layer;
  }
  setLayer(l: MapLayer): void {
    if (l === this._layer) return;
    this._layer = l;
    this.requestDraw();
  }

  /** 出典の文字列（現在のレイヤー） */
  get attribution(): string {
    return MAP_LAYER_ATTRIBUTION[this._layer];
  }

  // ----- 表示範囲 ---------------------------------------------------------

  get zoom(): number {
    return this._zoom;
  }
  get center(): LatLon {
    return { ...this._center };
  }
  /** いま取得しているタイルのズーム（18 より先に拡大していれば 18） */
  get tileZoom(): number {
    return tileZoomFor(this._layer, this._zoom);
  }
  /** タイルを引き伸ばして描いているか（表示のズームがタイルの配信上限より大きい） */
  get overzoomed(): boolean {
    return this._zoom > (MAP_LAYER_MAX_ZOOM[this._layer] ?? TILE_MAX_ZOOM) + 1e-9;
  }
  /** 地図の中心での m/px（表示のズーム） */
  get metersPerPixel(): number {
    return metersPerPixel(this._center.lat, this._zoom);
  }
  /** いま描いているスケールバー */
  get scaleBar(): { meters: number; px: number; label: string } {
    return niceScaleBar(this.metersPerPixel, Math.min(120, this.W / 3 || 120));
  }
  /** スケールバーの位置（左下からのオフセット px）。地図の左下に重ねた DOM（状態の表示）の上に出すため */
  setScaleBarOffset(off: { x: number; y: number }): void {
    const cur = this.scaleBarOffset;
    if (cur && cur.x === off.x && cur.y === off.y) return;
    this.scaleBarOffset = { x: off.x, y: off.y };
    this.requestDraw();
  }
  setCenter(p: LatLon, zoom?: number): void {
    this.stopAnim();
    this._center = clampCenter(p);
    if (zoom !== undefined) this._zoom = clampZoom(zoom);
    this.requestDraw();
  }
  /** 中心を基準にズーム（ボタン用。アニメーションあり、終了後に onView） */
  zoomBy(delta: number): void {
    this.animateZoom(clampZoom(this._zoom + delta), { x: this.W / 2, y: this.H / 2 });
  }
  /** ピンからの東・北 (m) → キャンバス内の画面 px（ピンが無ければ null） */
  screenOf(e: number, n: number): XY | null {
    if (!this._pin) return null;
    return this.project(frameFromLocal(this._pin, e, n));
  }
  /** キャンバス内の画面 px → 緯度経度 */
  latLonAt(x: number, y: number): LatLon {
    return this.unproject(x, y);
  }
  /** 緯度経度 → キャンバス内の画面 px */
  screenOfLatLon(p: LatLon): XY {
    return this.project(p);
  }

  // ----- ピン -------------------------------------------------------------

  get pin(): LatLon | null {
    return this._pin ? { ...this._pin } : null;
  }
  /** ピンを置く（center=true なら地図も移動）。onPin は呼ばない */
  setPin(p: LatLon, center = true): void {
    this._pin = { lat: p.lat, lon: p.lon };
    if (center) this.setCenter(p);
    this.requestDraw();
  }

  // ----- 敷地の輪郭 -------------------------------------------------------

  /** 敷地の輪郭を描くモード */
  get polygonMode(): boolean {
    return this._polyMode;
  }
  /**
   * on=true: クリックで頂点を追加するモードに入る（閉じた輪郭が既にあれば、最初のクリックで新しい輪郭を描き始める）
   * on=false: 描きかけの輪郭は 3 点以上なら閉じ、2 点以下なら消す
   */
  setPolygonMode(on: boolean): void {
    if (on === this._polyMode) return;
    if (on) this.endOtherModes('poly');
    if (on) {
      this.setPolyModeInternal(true, false);
    } else if (!this._polyClosed && this._polygon.length >= 3) {
      this.record();
      this._polyClosed = true;
      this.setPolyModeInternal(false, false);
      this.firePolygon();
    } else if (!this._polyClosed && this._polygon.length) {
      this.record();
      this._polygon = [];
      this.setPolyModeInternal(false, false);
      this.firePolygon();
    } else {
      this.setPolyModeInternal(false, false);
    }
    this.requestDraw();
  }
  get polygon(): LatLon[] {
    return this._polygon.map((p) => ({ ...p }));
  }
  /** 閉じた輪郭か（3 点以上） */
  get polygonClosed(): boolean {
    return this._polyClosed && this._polygon.length >= 3;
  }
  /** 外から輪郭を与える（3 点以上なら閉じた輪郭として扱う）。onPolygonChange は呼ばない。取り消しの記録は消す */
  setPolygon(poly: LatLon[]): void {
    this._polygon = poly.map((p) => ({ lat: p.lat, lon: p.lon }));
    this._polyClosed = this._polygon.length >= 3;
    this.selVertex = -1;
    this.undoStack = [];
    this.redoStack = [];
    this.opts.onHistoryChange?.();
    if (!this.polygonClosed && this._polyEdit) this.setEditInternal(false, true);
    this.requestDraw();
  }
  /** 輪郭を置き換える（取り消しできる操作として記録し、閉じた輪郭として onPolygonChange を呼ぶ）。寸法で区画を作るときなど */
  editPolygon(poly: LatLon[]): void {
    if (poly.length < 3) return;
    this.record();
    if (this._polyMode) this.setPolyModeInternal(false, true);
    this._polygon = poly.map((p) => ({ lat: p.lat, lon: p.lon }));
    this._polyClosed = true;
    this.selVertex = -1;
    this.requestDraw();
    this.firePolygon();
  }
  clearPolygon(): void {
    if (this._polygon.length) this.record();
    this._polygon = [];
    this._polyClosed = false;
    this.selVertex = -1;
    if (this._polyEdit) this.setEditInternal(false, true);
    this.requestDraw();
    this.firePolygon();
  }
  /** 描いている輪郭を閉じる（3 点以上）。モードも終わる */
  finishPolygon(): void {
    if (this._polyClosed || this._polygon.length < 3) return;
    this.closePolygon();
  }
  /** 辺の長さ (m)。閉じていれば n 本、描いている途中なら n − 1 本 */
  get edgeLengths(): number[] {
    return edgeLengthsM(this._polygon, this.polygonClosed);
  }
  /** 辺 i の長さを数値で変える（辺の終点を辺の向きに沿って動かす。取り消しできる）。できなければ false */
  setEdgeLength(i: number, lengthM: number): boolean {
    if (!this.polygonClosed) return false;
    const next = withEdgeLength(this._polygon, i, lengthM);
    if (!next) return false;
    this.record();
    this._polygon = next;
    this.requestDraw();
    this.firePolygon();
    return true;
  }
  /** 強調する辺（サイドの一覧で入力中の辺。−1 / null で消す） */
  setHighlightEdge(i: number | null): void {
    const v = i ?? -1;
    if (v === this.highlightEdge) return;
    this.highlightEdge = v;
    this.requestDraw();
  }

  /** 輪郭の編集モード（閉じた輪郭があるときだけ入れる） */
  get polygonEditMode(): boolean {
    return this._polyEdit;
  }
  setPolygonEditMode(on: boolean): void {
    if (on === this._polyEdit) return;
    if (on && !this.polygonClosed) return;
    if (on) this.endOtherModes('edit');
    this.setEditInternal(on, false);
  }
  /** 編集モードで選んだ頂点（無ければ −1） */
  get selectedVertex(): number {
    return this.selVertex;
  }
  selectVertex(i: number): void {
    this.selVertex = this._polyEdit && i >= 0 && i < this._polygon.length ? i : -1;
    this.requestDraw();
  }
  /** 頂点 i を消す（閉じた輪郭は 3 点まで。取り消しできる） */
  deleteVertex(i: number): boolean {
    if (i < 0 || i >= this._polygon.length) return false;
    if (this.polygonClosed && this._polygon.length <= 3) {
      this.opts.onNotice?.('敷地の輪郭は 3 点より少なくできません（消すときは「輪郭を消す」）');
      return false;
    }
    this.record();
    this._polygon.splice(i, 1);
    this.selVertex = -1;
    this.requestDraw();
    this.firePolygon();
    return true;
  }
  /** 辺 i の中点（または at）に頂点を足す（閉じた輪郭。取り消しできる）。足した頂点の番号 */
  insertVertex(i: number, at?: LatLon): number {
    const n = this._polygon.length;
    if (!this.polygonClosed || i < 0 || i >= n) return -1;
    const a = this._polygon[i];
    const b = this._polygon[(i + 1) % n];
    const p = at ?? frameFromLocal(a, frameToLocal(a, b).e / 2, frameToLocal(a, b).n / 2);
    this.record();
    this._polygon.splice(i + 1, 0, { lat: p.lat, lon: p.lon });
    this.selVertex = this._polyEdit ? i + 1 : -1;
    this.requestDraw();
    this.firePolygon();
    return i + 1;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  /** 輪郭の変更を 1 つ取り消す（できなければ false） */
  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push(this.snapshotPoly());
    this.restore(s);
    return true;
  }
  /** 取り消した変更をやり直す（できなければ false） */
  redo(): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push(this.snapshotPoly());
    this.restore(s);
    return true;
  }

  // ----- オーバーレイ -----------------------------------------------------

  /** 建物の足跡（ピンからの東・北 m の多角形）を表示。null で消す */
  setFootprint(fp: { e: number; n: number }[] | null, inner: { e: number; n: number }[] | null = null): void {
    this.footprint = fp && fp.length >= 3 ? fp.map((q) => ({ e: q.e, n: q.n })) : null;
    // 内側の線（壁の外形）。塗りは軒先（航空写真で見える外形）、濃い線は壁
    this.footprintInner = inner && inner.length >= 3 ? inner.map((q) => ({ e: q.e, n: q.n })) : null;
    this.requestDraw();
  }
  /**
   * 周辺建物の輪郭（ピンからの東・北 m）を薄く表示。輪郭の配列（id 無し）か、id・hidden 付きの配列を受け取る。
   * hidden の輪郭は灰色の破線。id は周辺建物を選ぶモードのクリックで返す（id 無しの輪郭は ring0, ring1… になる）
   */
  setNeighborRings(rings: ({ e: number; n: number }[] | MapNeighborRing)[] | null): void {
    const list = (rings ?? []).map((r, i): MapNeighborRing => (Array.isArray(r) ? { id: `ring${i}`, ring: r } : r)).filter((r) => r.ring.length >= 3);
    this.neighborRings = list.length ? list : null;
    if (this.hoverRingId && !list.some((r) => r.id === this.hoverRingId)) this.hoverRingId = null;
    this.requestDraw();
  }

  /** 想定の家（ピンからの東・北 m）。選んでいた家が無くなれば選択を外す（onPlannedSelect は呼ばない） */
  setPlannedHouses(list: MapPlannedHouse[] | null): void {
    this.planned = (list ?? []).filter((p) => p.ring.length >= 3).map((p) => ({ ...p, ring: p.ring.map((q) => ({ e: q.e, n: q.n })) }));
    if (this._plannedSel && !this.planned.some((p) => p.id === this._plannedSel)) this._plannedSel = null;
    if (this.hoverPlanned && !this.planned.some((p) => p.id === this.hoverPlanned)) this.hoverPlanned = null;
    this.requestDraw();
  }
  /** 選んでいる想定の家の id */
  get plannedSelection(): string | null {
    return this._plannedSel;
  }
  /** 想定の家を選ぶ（onPlannedSelect は呼ばない）。null で外す */
  setPlannedSelection(id: string | null): void {
    const v = id && this.planned.some((p) => p.id === id) ? id : null;
    if (v && (this._polyMode || this._polyEdit || this._neighborPick || this._tool)) return;
    if (v === this._plannedSel) return;
    this._plannedSel = v;
    this.requestDraw();
  }
  /** 生成した区画（ピンからの東・北 m）を破線で表示 */
  setLotOutlines(lots: { e: number; n: number }[][] | null): void {
    this.lots = (lots ?? []).filter((l) => l.length >= 3).map((l) => l.map((q) => ({ e: q.e, n: q.n })));
    this.requestDraw();
  }
  /** 画面上の点（キャンバス内 px）にある想定の家の id（無ければ null） */
  plannedAt(x: number, y: number): string | null {
    const pin = this._pin;
    if (!pin || !this.planned.length) return null;
    const rings = this.planned.map((p) => ({ id: p.id, ring: p.ring.map((q) => this.project(frameFromLocal(pin, q.e, q.n))) }));
    return hitRingAt({ x, y }, rings, 4);
  }

  // ----- 道具 -------------------------------------------------------------

  /** いま付いている道具 */
  get tool(): MapToolKind | null {
    return this._tool?.kind ?? null;
  }
  /** 'lot' で描いている頂点の数 */
  get lotPointCount(): number {
    return this.lotPts.length;
  }
  /** 'line' の 1 点目を置いたか */
  get lineStarted(): boolean {
    return !!this.lineA;
  }
  /** 道具を付ける（null で外す）。輪郭を描く・編集・周辺建物を選ぶモードは終える。onToolChange は呼ばない */
  setTool(tool: MapTool | null): void {
    if (tool) this.endOtherModes('tool');
    this._tool = tool;
    this.lineA = null;
    this.lotPts = [];
    this.hoverEdge = -1;
    this.canvas.classList.toggle('placing', !!tool || this._polyMode);
    this.canvas.style.cursor = '';
    this.requestDraw();
  }

  /** 周辺建物を選ぶモード（クリックで onNeighborClick。ピンは動かさず、ピンのドラッグもしない）。輪郭を描くモードとは同時に使わない */
  get neighborPickMode(): boolean {
    return this._neighborPick;
  }
  setNeighborPickMode(on: boolean): void {
    if (on === this._neighborPick) return;
    if (on) this.endOtherModes('pick');
    this._neighborPick = on;
    this.canvas.classList.toggle('picking', on);
    this.hoverRingId = null;
    this.canvas.style.cursor = '';
    this.requestDraw();
  }

  /** 画面上の点（キャンバス内 px）にある周辺建物の輪郭の id（無ければ null） */
  neighborAt(x: number, y: number): string | null {
    const pin = this._pin;
    if (!pin || !this.neighborRings) return null;
    const rings = this.neighborRings.map((r) => ({ id: r.id, ring: r.ring.map((q) => this.project(frameFromLocal(pin, q.e, q.n))) }));
    return hitRingAt({ x, y }, rings, 4);
  }

  /** 解析範囲の円（半径 m）。null で消す */
  setRadiusRing(m: number | null): void {
    this.radiusM = m !== null && isFinite(m) && m > 0 ? m : null;
    this.requestDraw();
  }

  // ----- サイズ・出力・後片付け -------------------------------------------

  resize(): void {
    if (this.disposed) return;
    const w = this.container.clientWidth || this.canvas.clientWidth || 0;
    const h = this.container.clientHeight || this.canvas.clientHeight || 0;
    const dpr = Math.min(2, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    if (w <= 0 || h <= 0) return;
    if (w === this.W && h === this.H && dpr === this.dpr && this.canvas.width === Math.round(w * dpr)) return;
    this.W = w;
    this.H = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.requestDraw();
  }

  /** 現在の表示を画像に（レポート用）。失敗時は空文字 */
  snapshot(): string {
    try {
      this.draw();
      return this.canvas.toDataURL('image/jpeg', 0.9);
    } catch {
      return '';
    }
  }

  /** 読み込みに失敗したタイルをもう一度試す（回線が戻ったとき） */
  retryFailedTiles(): void {
    for (const [k, v] of this.cache) if (v === 'error') this.cache.delete(k);
    this.requestDraw();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerUp);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('dblclick', this.onDblClick);
    c.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('resize', this.onWindowResize);
    this.ro?.disconnect();
    this.ro = null;
    this.stopAnim();
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.viewTimer) {
      clearTimeout(this.viewTimer);
      this.viewTimer = null;
    }
    this.cache.clear();
    this.pointers.clear();
    this.drag = null;
    this.pinch = null;
    this._tool = null;
    if (c.parentNode) c.parentNode.removeChild(c);
  }

  // ----- 座標変換（画面 px ⇄ 緯度経度） -----------------------------------

  private project(p: LatLon): { x: number; y: number } {
    const c = lonLatToWorldPx(this._center.lon, this._center.lat, this._zoom);
    const w = lonLatToWorldPx(p.lon, p.lat, this._zoom);
    return { x: this.W / 2 + (w.x - c.x), y: this.H / 2 + (w.y - c.y) };
  }

  private unproject(x: number, y: number): LatLon {
    const c = lonLatToWorldPx(this._center.lon, this._center.lat, this._zoom);
    return clampCenter(worldPxToLonLat(c.x + (x - this.W / 2), c.y + (y - this.H / 2), this._zoom));
  }

  /** 地理座標 ll が画面の (sx, sy) に来るように、ズーム z で中心を決める */
  private setViewAnchored(ll: LatLon, sx: number, sy: number, z: number): void {
    this._zoom = clampZoom(z);
    const a = lonLatToWorldPx(ll.lon, ll.lat, this._zoom);
    this._center = clampCenter(worldPxToLonLat(a.x - (sx - this.W / 2), a.y - (sy - this.H / 2), this._zoom));
  }

  private toLocal(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ----- モード -----------------------------------------------------------

  /** 新しいモードに入る前に他のモードを終える（地図側から終えたものは DOM 側に知らせる） */
  private endOtherModes(next: 'poly' | 'edit' | 'pick' | 'tool'): void {
    if (next !== 'tool' && this._tool) {
      this.setTool(null);
      this.opts.onToolChange?.(null);
    }
    if (next !== 'pick' && this._neighborPick) {
      // 周辺建物を選ぶモードとは同時に使わない
      this.setNeighborPickMode(false);
      this.opts.onNeighborPickModeChange?.(false);
    }
    if (next !== 'poly' && this._polyMode) {
      this.setPolygonMode(false);
      this.opts.onPolygonModeChange?.(false);
    }
    if (next !== 'edit' && this._polyEdit) this.setEditInternal(false, true);
    if (this._plannedSel) {
      this._plannedSel = null;
      this.opts.onPlannedSelect?.(null);
    }
  }

  private setEditInternal(on: boolean, notify: boolean): void {
    const changed = on !== this._polyEdit;
    this._polyEdit = on;
    this.selVertex = -1;
    this.canvas.classList.toggle('editing', on);
    this.requestDraw();
    if (changed && notify) this.opts.onEditModeChange?.(on);
  }

  // ----- 取り消し ---------------------------------------------------------

  private snapshotPoly(): PolySnapshot {
    return { poly: this.polygon, closed: this._polyClosed };
  }

  /** 輪郭を変える直前に呼ぶ（取り消しの記録） */
  private record(): void {
    this.undoStack.push(this.snapshotPoly());
    if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift();
    this.redoStack = [];
    this.opts.onHistoryChange?.();
  }

  private restore(s: PolySnapshot): void {
    this._polygon = s.poly.map((p) => ({ ...p }));
    this._polyClosed = s.closed && this._polygon.length >= 3;
    this.selVertex = -1;
    // 描きかけの状態に戻したら描くモードに、閉じた輪郭に戻したら描くモードを終える（空に戻したときは今のまま）
    const wantDraw = this._polyClosed ? false : this._polygon.length > 0 ? true : this._polyMode;
    if (wantDraw && this._polyEdit) this.setEditInternal(false, true);
    if (wantDraw && (this._tool || this._neighborPick)) this.endOtherModes('poly');
    if (wantDraw !== this._polyMode) this.setPolyModeInternal(wantDraw, true);
    if (!this.polygonClosed && this._polyEdit) this.setEditInternal(false, true);
    this.requestDraw();
    this.firePolygon();
    this.opts.onHistoryChange?.();
  }

  // ----- 当たり判定 -------------------------------------------------------

  private hitVertex(x: number, y: number): number {
    let best = -1;
    let bestD = 9;
    for (let i = 0; i < this._polygon.length; i++) {
      const s = this.project(this._polygon[i]);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** 編集モードの辺の中点の「＋」 */
  private hitMidpoint(x: number, y: number): number {
    if (!this._polyEdit || !this.polygonClosed) return -1;
    const pts = this._polygon.map((p) => this.project(p));
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if (Math.hypot(b.x - a.x, b.y - a.y) < MID_HANDLE_MIN_PX) continue;
      if (Math.hypot((a.x + b.x) / 2 - x, (a.y + b.y) / 2 - y) <= 8) return i;
    }
    return -1;
  }

  private hitMoveHandle(x: number, y: number): boolean {
    const r = this.moveHandleRect;
    return !!r && this._polyEdit && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  /** 閉じた敷地の輪郭の辺（画面で 10 px 以内の最も近い辺）。無ければ −1 */
  private hitEdge(x: number, y: number): number {
    if (!this.polygonClosed) return -1;
    const pts = this._polygon.map((p) => this.project(p));
    let best = -1;
    let bestD = 10;
    for (let i = 0; i < pts.length; i++) {
      const d = segmentDistance({ x, y }, pts[i], pts[(i + 1) % pts.length]);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private hitPin(x: number, y: number): boolean {
    if (!this._pin) return false;
    const s = this.project(this._pin);
    return Math.hypot(s.x - x, s.y - (y + PIN_HEAD_DY)) <= 14 || Math.hypot(s.x - x, s.y - y) <= 8;
  }

  /** 想定の家をクリック・ドラッグで扱えるか（どのモードでもないとき） */
  private plannedInteractive(): boolean {
    return !!this._pin && !this._polyMode && !this._polyEdit && !this._neighborPick && !this._tool;
  }

  // ----- イベント ---------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    if (this.disposed) return;
    const pt = this.toLocal(e);
    this.shiftHeld = e.shiftKey;
    this.pointers.set(e.pointerId, pt);
    this.stopAnim();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 対応していない環境 */
    }
    if (this.pointers.size === 2) {
      // 2 本指: ピンチ開始（進行中のドラッグは取り消す）
      const [a, b] = [...this.pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.pinch = { startDist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), startZoom: this._zoom, anchor: this.unproject(mid.x, mid.y) };
      this.drag = null;
      this.plannedPreview = null;
      this.canvas.classList.remove('dragging');
      return;
    }
    if (this.pointers.size > 2 || this.pinch) return;

    if (e.button === 2) {
      this.handleRightClick(pt);
      return;
    }
    if (e.button !== 0) return;

    const base: DragBase = { id: e.pointerId, sx: pt.x, sy: pt.y, t0: performance.now(), moved: false };
    const panDrag = (): Drag => ({ kind: 'pan', ...base, c0: lonLatToWorldPx(this._center.lon, this._center.lat, this._zoom) });
    if (this._tool) {
      // 道具が付いている間はパンとクリックだけ（頂点・ピン・想定の家は動かさない）
      this.drag = panDrag();
      return;
    }
    const vi = this.hitVertex(pt.x, pt.y);
    if (vi >= 0) {
      if (this._polyEdit && this.selVertex !== vi) {
        this.selVertex = vi;
        this.requestDraw();
      }
      this.drag = { kind: 'vertex', ...base, index: vi, lastFire: 0, recorded: false };
      return;
    }
    if (this._polyEdit) {
      const mi = this.hitMidpoint(pt.x, pt.y);
      if (mi >= 0) {
        this.drag = { kind: 'mid', ...base, edge: mi };
        return;
      }
      if (this.hitMoveHandle(pt.x, pt.y)) {
        this.drag = { kind: 'move', ...base, start: this.unproject(pt.x, pt.y), base: this.polygon, lastFire: 0, recorded: false };
        return;
      }
    }
    if (this._pin && !this._polyMode && !this._neighborPick && this.hitPin(pt.x, pt.y)) {
      const pp = this.project(this._pin);
      this.drag = { kind: 'pin', ...base, offX: pt.x - pp.x, offY: pt.y - pp.y, lastFire: 0 };
      return;
    }
    if (this.plannedInteractive()) {
      const id = this.plannedAt(pt.x, pt.y);
      if (id) {
        if (id !== this._plannedSel) {
          this._plannedSel = id;
          this.requestDraw();
          this.opts.onPlannedSelect?.(id);
        }
        this.drag = { kind: 'planned', ...base, plannedId: id, start: this.unproject(pt.x, pt.y) };
        return;
      }
    }
    this.drag = panDrag();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.disposed) return;
    const pt = this.toLocal(e);
    this.hover = pt;
    this.shiftHeld = e.shiftKey;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, pt);

    if (this.pinch) {
      if (this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const z = clampZoom(this.pinch.startZoom + Math.log2(dist / this.pinch.startDist));
        this.setViewAnchored(this.pinch.anchor, mid.x, mid.y, z);
        this.requestDraw();
      }
      return;
    }

    const d = this.drag;
    if (!d || d.id !== e.pointerId) {
      this.updateHoverCursor(pt);
      // 描画中・道具の下見はカーソルに追従（ラバーバンド・置く家の形）
      if (this.followsCursor()) this.requestDraw();
      return;
    }

    if (!d.moved && Math.hypot(pt.x - d.sx, pt.y - d.sy) > DRAG_PX) {
      d.moved = true;
      if (d.kind === 'pan') this.canvas.classList.add('dragging');
    }
    if (!d.moved) return;

    switch (d.kind) {
      case 'pan': {
        const cx = d.c0.x - (pt.x - d.sx);
        const cy = d.c0.y - (pt.y - d.sy);
        this._center = clampCenter(worldPxToLonLat(cx, cy, this._zoom));
        this.requestDraw();
        this.scheduleView();
        break;
      }
      case 'pin': {
        this._pin = this.unproject(pt.x - d.offX, pt.y - d.offY);
        this.requestDraw();
        const now = performance.now();
        if (now - d.lastFire > 80) {
          d.lastFire = now;
          this.opts.onPin?.({ ...this._pin });
        }
        break;
      }
      case 'mid': {
        // 動かし始めたら辺の途中に頂点を足し、その頂点のドラッグに切り替える
        const n = this._polygon.length;
        if (!this.polygonClosed || d.edge >= n) {
          this.drag = null;
          break;
        }
        this.record();
        this._polygon.splice(d.edge + 1, 0, this.unproject(pt.x, pt.y));
        this.selVertex = d.edge + 1;
        this.drag = { kind: 'vertex', id: d.id, sx: d.sx, sy: d.sy, t0: d.t0, moved: true, index: d.edge + 1, lastFire: 0, recorded: true };
        this.moveVertexTo(this.drag, pt, e.shiftKey);
        break;
      }
      case 'vertex': {
        if (d.index < this._polygon.length) {
          if (!d.recorded) {
            this.record();
            d.recorded = true;
          }
          this.moveVertexTo(d, pt, e.shiftKey);
        }
        break;
      }
      case 'move': {
        if (!d.recorded) {
          this.record();
          d.recorded = true;
        }
        const del = frameToLocal(d.start, this.unproject(pt.x, pt.y));
        this._polygon = translatePolygon(d.base, del.e, del.n);
        this.requestDraw();
        const now = performance.now();
        if (now - d.lastFire > 80) {
          d.lastFire = now;
          this.firePolygon();
        }
        break;
      }
      case 'planned': {
        const pin = this._pin;
        if (!pin) break;
        const a = frameToLocal(pin, d.start);
        const b = frameToLocal(pin, this.unproject(pt.x, pt.y));
        this.plannedPreview = { id: d.plannedId, dE: b.e - a.e, dN: b.n - a.n };
        this.canvas.style.cursor = 'grabbing';
        this.requestDraw();
        break;
      }
    }
  };

  /** 頂点のドラッグ: Shift なら前後の辺に直角・平行にそろえる */
  private moveVertexTo(d: Extract<Drag, { kind: 'vertex' }>, pt: XY, shift: boolean): void {
    let target: XY = pt;
    if (shift) {
      const pts = this._polygon.map((p) => this.project(p));
      target = snapVertex(pts, d.index, this.polygonClosed, pt);
    }
    this._polygon[d.index] = this.unproject(target.x, target.y);
    this.requestDraw();
    const now = performance.now();
    if (now - d.lastFire > 80) {
      d.lastFire = now;
      this.firePolygon();
    }
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (this.disposed) return;
    const pt = this.toLocal(e);
    this.pointers.delete(e.pointerId);

    if (this.pinch) {
      if (this.pointers.size < 2) {
        this.pinch = null;
        this.scheduleView();
      }
      return;
    }

    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    this.canvas.classList.remove('dragging');

    const dist = Math.hypot(pt.x - d.sx, pt.y - d.sy);
    const isClick = !d.moved && e.type !== 'pointercancel' && performance.now() - d.t0 <= 500 && dist <= DRAG_PX;

    switch (d.kind) {
      case 'pan':
        if (isClick) this.handleClick(pt, dist, e.shiftKey);
        else if (d.moved) this.scheduleView();
        break;
      case 'pin':
        if (d.moved && this._pin) this.opts.onPin?.({ ...this._pin });
        break;
      case 'vertex':
        if (d.moved) this.firePolygon();
        else if (isClick && d.index === 0 && this._polyMode && !this._polyClosed && this._polygon.length >= 3) this.closePolygon();
        break;
      case 'mid':
        if (isClick) this.insertVertex(d.edge);
        break;
      case 'move':
        if (d.moved) this.firePolygon();
        break;
      case 'planned': {
        const p = this.plannedPreview;
        this.plannedPreview = null;
        if (d.moved && p && e.type !== 'pointercancel' && (Math.abs(p.dE) > 1e-6 || Math.abs(p.dN) > 1e-6)) this.opts.onPlannedMove?.(p.id, p.dE, p.dN);
        this.requestDraw();
        break;
      }
    }
    this.updateHoverCursor(pt);
  };

  private onPointerLeave = (): void => {
    this.hover = null;
    if (this.hoverRingId) {
      this.hoverRingId = null;
      this.requestDraw();
    }
    if (this.hoverPlanned || this.hoverEdge >= 0) {
      this.hoverPlanned = null;
      this.hoverEdge = -1;
      this.requestDraw();
    }
    if (this.followsCursor()) this.requestDraw();
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.disposed) return;
    e.preventDefault();
    const pt = this.toLocal(e);
    let delta: number;
    if (e.deltaMode !== 0 || Math.abs(e.deltaY) >= 40) delta = e.deltaY < 0 ? 0.25 : -0.25; // マウスホイール（行・ページ単位含む）
    else delta = -e.deltaY / 160; // トラックパッド（細かい連続値）
    this.stopAnim();
    const z = clampZoom(this._zoom + delta);
    if (z === this._zoom) return;
    this.setViewAnchored(this.unproject(pt.x, pt.y), pt.x, pt.y, z);
    if (this.drag?.kind === 'pan') {
      // パン中にズームしたら基準を更新
      this.drag.sx = pt.x;
      this.drag.sy = pt.y;
      this.drag.c0 = lonLatToWorldPx(this._center.lon, this._center.lat, this._zoom);
    }
    this.requestDraw();
    this.scheduleView();
  };

  private onDblClick = (e: MouseEvent): void => {
    if (this.disposed) return;
    e.preventDefault();
    const pt = this.toLocal(e);
    this.animateZoom(clampZoom(this._zoom + 1), pt);
  };

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private onKey = (e: KeyboardEvent): void => {
    if (this.disposed) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.key === 'Shift') {
      this.shiftHeld = true;
      if (this.followsCursor()) this.requestDraw();
      return;
    }
    // 輪郭の取り消し・やり直し（道具が付いている間は輪郭を変えない。区画を描いているときは最後の点を戻す）
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (this._tool) {
        if (k === 'z' && !e.shiftKey && this._tool.kind === 'lot' && this.lotPts.length) {
          e.preventDefault();
          this.lotPts.pop();
          this.requestDraw();
        }
        return;
      }
      if (k === 'z' && !e.shiftKey) {
        if (this.undo()) e.preventDefault();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        if (this.redo()) e.preventDefault();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (this._tool) {
        e.preventDefault();
        this.setTool(null);
        this.opts.onToolChange?.(null);
        return;
      }
      if (this._neighborPick) {
        e.preventDefault();
        this.setNeighborPickMode(false);
        this.opts.onNeighborPickModeChange?.(false);
        return;
      }
      if (this._polyMode) {
        e.preventDefault();
        this.setPolygonMode(false);
        this.opts.onPolygonModeChange?.(false);
        return;
      }
      if (this._polyEdit) {
        e.preventDefault();
        this.setEditInternal(false, true);
        return;
      }
      if (this._plannedSel) {
        e.preventDefault();
        this._plannedSel = null;
        this.requestDraw();
        this.opts.onPlannedSelect?.(null);
      }
      return;
    }
    if (e.altKey) return;
    if (e.key === 'Enter') {
      if (this._tool?.kind === 'lot' && this.lotPts.length >= 3) {
        e.preventDefault();
        this.finishLot();
      } else if (this._polyMode && !this._polyClosed && this._polygon.length >= 3) {
        e.preventDefault();
        this.closePolygon();
      }
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (this._tool?.kind === 'lot') {
        if (this.lotPts.length) {
          e.preventDefault();
          this.lotPts.pop();
          this.requestDraw();
        }
        return;
      }
      if (this._polyMode) {
        if (!this._polyClosed && this._polygon.length) {
          e.preventDefault();
          this.removeLastVertex();
        }
        return;
      }
      if (this._polyEdit) {
        if (this.selVertex >= 0) {
          e.preventDefault();
          this.deleteVertex(this.selVertex);
        }
        return;
      }
      if (this._plannedSel && !this._tool && !this._neighborPick) {
        e.preventDefault();
        this.opts.onPlannedDelete?.(this._plannedSel);
      }
      return;
    }
    // 選んだ想定の家: R / Shift+R で 90° 回す、矢印キーで動かす（0.1 m、Shift で 1 m。建物を置くステップと同じ）
    const sel = this._plannedSel;
    if (!sel || !this.plannedInteractive()) return;
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      this.opts.onPlannedRotate?.(sel, e.shiftKey ? -90 : 90);
      return;
    }
    const step = e.shiftKey ? 1 : 0.1;
    const mv: Record<string, [number, number]> = { ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] };
    const m = mv[e.key];
    if (m) {
      e.preventDefault();
      this.opts.onPlannedMove?.(sel, m[0], m[1]);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key !== 'Shift') return;
    this.shiftHeld = false;
    if (this.followsCursor()) this.requestDraw();
  };

  private onOnline = (): void => {
    this.retryFailedTiles();
  };

  private onWindowResize = (): void => {
    this.resize();
  };

  /** カーソルに追従して描き直すものがあるか（輪郭・区画のラバーバンド、2 点の線、置く家の形、辺の強調） */
  private followsCursor(): boolean {
    if (this._polyMode && !this._polyClosed && this._polygon.length) return true;
    const t = this._tool;
    if (!t) return false;
    return t.kind === 'point' ? !!t.preview : t.kind === 'line' ? !!this.lineA : t.kind === 'lot' ? this.lotPts.length > 0 : false;
  }

  private updateHoverCursor(pt: { x: number; y: number }): void {
    if (this.drag || this.pinch) return;
    if (this._tool) {
      if (this._tool.kind === 'edge') {
        const i = this.hitEdge(pt.x, pt.y);
        if (i !== this.hoverEdge) {
          this.hoverEdge = i;
          this.requestDraw();
        }
        this.canvas.style.cursor = i >= 0 ? 'pointer' : '';
      } else if (this._tool.kind === 'lot' && this.lotPts.length >= 3) {
        const f = this.project(this.lotPts[0]);
        this.canvas.style.cursor = Math.hypot(pt.x - f.x, pt.y - f.y) <= 10 ? 'pointer' : '';
      } else this.canvas.style.cursor = '';
      return;
    }
    if (this._neighborPick) {
      const id = this.neighborAt(pt.x, pt.y);
      if (id !== this.hoverRingId) {
        this.hoverRingId = id;
        this.requestDraw();
      }
      this.canvas.style.cursor = id ? 'pointer' : '';
      return;
    }
    if (this.hitVertex(pt.x, pt.y) >= 0 || this.hitMidpoint(pt.x, pt.y) >= 0) {
      this.canvas.style.cursor = 'pointer';
      return;
    }
    if (this.hitMoveHandle(pt.x, pt.y)) {
      this.canvas.style.cursor = 'move';
      return;
    }
    if (this._pin && !this._polyMode && this.hitPin(pt.x, pt.y)) {
      this.canvas.style.cursor = 'pointer';
      return;
    }
    const hp = this.plannedInteractive() ? this.plannedAt(pt.x, pt.y) : null;
    if (hp !== this.hoverPlanned) {
      this.hoverPlanned = hp;
      this.requestDraw();
    }
    this.canvas.style.cursor = hp ? 'move' : '';
  }

  /** 左クリック（移動なし）: 道具・周辺建物を選ぶ・輪郭を描く・編集・想定の家の選択の解除、どれでもなければピンを置く */
  private handleClick(pt: { x: number; y: number }, dist: number, shift: boolean): void {
    if (this._tool) {
      if (dist <= TOOL_CLICK_PX) this.handleToolClick(pt, shift);
      return;
    }
    if (this._neighborPick) {
      const now = performance.now();
      const last = this.lastPickClick;
      if (last && now - last.t < 400 && Math.hypot(pt.x - last.x, pt.y - last.y) <= 6) {
        // ダブルクリック（拡大）の 2 回目
        this.lastPickClick = null;
        return;
      }
      this.lastPickClick = { x: pt.x, y: pt.y, t: now };
      this.opts.onNeighborClick?.(this.neighborAt(pt.x, pt.y));
      return;
    }
    if (this._polyMode) {
      let recorded = false;
      if (this._polyClosed) {
        // 閉じた輪郭がある状態でモードに入っていたら、新しい輪郭を描き始める（取り消しで元の輪郭に戻せる）
        this.record();
        recorded = true;
        this._polygon = [];
        this._polyClosed = false;
      }
      if (this._polygon.length >= 3) {
        const f = this.project(this._polygon[0]);
        if (Math.hypot(pt.x - f.x, pt.y - f.y) <= 10) {
          this.closePolygon();
          return;
        }
      }
      let target: XY = pt;
      if (this._polygon.length) {
        // 直前の頂点と同じ位置（ダブルクリックの 2 回目など）は無視
        const l = this.project(this._polygon[this._polygon.length - 1]);
        if (Math.hypot(pt.x - l.x, pt.y - l.y) <= 5) return;
        if (shift) target = snapToPrevEdge(this._polygon.length >= 2 ? this.project(this._polygon[this._polygon.length - 2]) : null, l, pt);
      }
      if (!recorded) this.record();
      this._polygon.push(this.unproject(target.x, target.y));
      this.requestDraw();
      this.firePolygon();
      return;
    }
    if (this._polyEdit) {
      // 編集中は空いている所をクリックしても頂点の選択を外すだけ（ピンは動かさない）
      if (this.selVertex >= 0) {
        this.selVertex = -1;
        this.requestDraw();
      }
      return;
    }
    if (this._plannedSel) {
      // 想定の家を選んでいるときは、空いている所のクリックで選択を外すだけ（ピンは動かさない）
      this._plannedSel = null;
      this.requestDraw();
      this.opts.onPlannedSelect?.(null);
      return;
    }
    const ll = this.unproject(pt.x, pt.y);
    this._pin = ll;
    this.requestDraw();
    this.opts.onPin?.({ ...ll });
  }

  private handleToolClick(pt: XY, shift: boolean): void {
    const tool = this._tool;
    if (!tool) return;
    const ll = this.unproject(pt.x, pt.y);
    switch (tool.kind) {
      case 'point':
        tool.onPick(ll);
        break;
      case 'line': {
        const a = this.lineA;
        if (!a) {
          this.lineA = ll;
          this.requestDraw();
          return;
        }
        const s = this.project(a);
        if (Math.hypot(pt.x - s.x, pt.y - s.y) <= 5) return;
        const b = shift ? this.unproject(...xyArgs(snapToPrevEdge(null, s, pt))) : ll;
        this.lineA = null;
        this.requestDraw();
        tool.onPick(a, b);
        break;
      }
      case 'edge': {
        const i = this.hitEdge(pt.x, pt.y);
        if (i >= 0) tool.onPick(i);
        else this.opts.onNotice?.('敷地の輪郭の辺（線）をクリックしてください');
        break;
      }
      case 'lot': {
        const pts = this.lotPts;
        if (pts.length >= 3) {
          const f = this.project(pts[0]);
          if (Math.hypot(pt.x - f.x, pt.y - f.y) <= 10) {
            this.finishLot();
            return;
          }
        }
        let target: XY = pt;
        if (pts.length) {
          const l = this.project(pts[pts.length - 1]);
          if (Math.hypot(pt.x - l.x, pt.y - l.y) <= 5) return;
          if (shift) target = snapToPrevEdge(pts.length >= 2 ? this.project(pts[pts.length - 2]) : null, l, pt);
        }
        pts.push(this.unproject(target.x, target.y));
        this.requestDraw();
        break;
      }
    }
  }

  private finishLot(): void {
    const tool = this._tool;
    if (tool?.kind !== 'lot' || this.lotPts.length < 3) return;
    const poly = this.lotPts.map((p) => ({ ...p }));
    this.lotPts = [];
    this.requestDraw();
    tool.onPick(poly);
  }

  private handleRightClick(pt: XY): void {
    if (this._tool) {
      if (this._tool.kind === 'lot' && this.lotPts.length) {
        this.lotPts.pop();
        this.requestDraw();
      } else if (this._tool.kind === 'line' && this.lineA) {
        this.lineA = null;
        this.requestDraw();
      }
      return;
    }
    // 描画中なら最後の頂点を消す
    if (this._polyMode) {
      if (!this._polyClosed && this._polygon.length) this.removeLastVertex();
      return;
    }
    // 編集中: 右クリックした頂点を消す
    if (this._polyEdit) {
      const vi = this.hitVertex(pt.x, pt.y);
      if (vi >= 0) this.deleteVertex(vi);
    }
  }

  private removeLastVertex(): void {
    this.record();
    this._polygon.pop();
    this.requestDraw();
    this.firePolygon();
  }

  private closePolygon(): void {
    this.record();
    this._polyClosed = true;
    this.setPolyModeInternal(false, true);
    this.requestDraw();
    this.firePolygon();
  }

  private setPolyModeInternal(on: boolean, notify: boolean): void {
    const changed = on !== this._polyMode;
    this._polyMode = on;
    this.canvas.classList.toggle('placing', on || !!this._tool);
    if (changed && notify) this.opts.onPolygonModeChange?.(on);
  }

  private firePolygon(): void {
    this.opts.onPolygonChange?.(this.polygon, this._polyClosed && this._polygon.length >= 3);
  }

  private scheduleView(): void {
    if (this.viewTimer) clearTimeout(this.viewTimer);
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null;
      if (!this.disposed) this.opts.onView?.(this.center, this._zoom);
    }, 150);
  }

  // ----- ズームのアニメーション --------------------------------------------

  private animateZoom(target: number, anchorPt: { x: number; y: number }): void {
    this.stopAnim();
    if (target === this._zoom) return;
    const ll = this.unproject(anchorPt.x, anchorPt.y);
    if (typeof requestAnimationFrame === 'undefined') {
      this.setViewAnchored(ll, anchorPt.x, anchorPt.y, target);
      this.requestDraw();
      this.scheduleView();
      return;
    }
    const z0 = this._zoom;
    const t0 = performance.now();
    const dur = 220;
    const step = () => {
      if (this.disposed) return;
      const t = Math.min(1, (performance.now() - t0) / dur);
      const k = 1 - (1 - t) ** 3;
      this.setViewAnchored(ll, anchorPt.x, anchorPt.y, t >= 1 ? target : z0 + (target - z0) * k);
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = 0;
      }
      this.draw();
      if (t < 1) this.animId = requestAnimationFrame(step);
      else {
        this.animId = 0;
        this.scheduleView();
      }
    };
    this.animId = requestAnimationFrame(step);
  }

  private stopAnim(): void {
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = 0;
    }
  }

  // ----- 描画 -------------------------------------------------------------

  private requestDraw(): void {
    if (this.disposed || this.rafId) return;
    if (typeof requestAnimationFrame === 'undefined') {
      this.draw();
      return;
    }
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.draw();
    });
  }

  private draw(): void {
    if (this.disposed) return;
    const ctx = this.ctx;
    if (!ctx || this.W <= 0 || this.H <= 0) return;
    try {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = '#e9e6df';
      ctx.fillRect(0, 0, this.W, this.H);
      this.drawTiles(ctx);
      this.drawOverlays(ctx);
      this.drawPolygon(ctx);
      this.drawToolOverlay(ctx);
      this.drawPin(ctx);
      this.drawScaleBar(ctx);
      this.drawNorth(ctx);
    } catch (err) {
      console.warn('地図の描画に失敗しました', err);
    }
    try {
      this.opts.onDraw?.();
    } catch (err) {
      console.warn(err);
    }
  }

  private getTile(z: number, x: number, y: number): TileEntry {
    const url = tileUrl(this._layer, z, x, y);
    const c = this.cache.get(url);
    if (c !== undefined) {
      if (typeof c !== 'string') {
        // LRU: 使ったものを末尾へ
        this.cache.delete(url);
        this.cache.set(url, c);
      }
      return c;
    }
    if (this.inflight >= MAX_INFLIGHT) return 'loading'; // 次の描画で改めて試す
    this.cache.set(url, 'loading');
    this.inflight++;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      this.inflight--;
      if (this.disposed) return;
      this.cache.set(url, img);
      this.failStreak = 0;
      if (this.tilesUnavailable) {
        this.tilesUnavailable = false;
        this.opts.onTilesAvailable?.();
      }
      this.trimCache();
      this.requestDraw();
    };
    img.onerror = () => {
      this.inflight--;
      if (this.disposed) return;
      this.cache.set(url, 'error');
      this.failStreak++;
      if (!this.tilesUnavailable && this.failStreak >= TILE_FAIL_THRESHOLD) {
        this.tilesUnavailable = true;
        this.opts.onTilesUnavailable?.();
      }
      this.requestDraw();
    };
    img.src = url;
    return 'loading';
  }

  private trimCache(): void {
    if (this.cache.size <= TILE_CACHE_MAX) return;
    for (const [k, v] of this.cache) {
      if (v === 'loading') continue;
      this.cache.delete(k);
      if (this.cache.size <= TILE_CACHE_MAX - 100) break;
    }
  }

  private drawTiles(ctx: CanvasRenderingContext2D): void {
    const W = this.W;
    const H = this.H;
    // タイルの取得ズーム（レイヤーの配信上限まで）。それより拡大した分は引き伸ばして描く
    const zi = tileZoomFor(this._layer, this._zoom);
    const scale = 2 ** (this._zoom - zi);
    const ts = TILE_SIZE * scale;
    const n = 2 ** zi;
    const ct = lonLatToTile(this._center.lon, this._center.lat, zi);
    const x0 = Math.floor(ct.x - W / 2 / ts);
    const x1 = Math.ceil(ct.x + W / 2 / ts);
    const y0 = Math.max(0, Math.floor(ct.y - H / 2 / ts));
    const y1 = Math.min(n - 1, Math.ceil(ct.y + H / 2 / ts));
    ctx.imageSmoothingEnabled = true;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const sx = W / 2 + (tx - ct.x) * ts;
        const sy = H / 2 + (ty - ct.y) * ts;
        // 隣接タイルと境界を共有するように丸める（隙間・重なりを防ぐ）
        const X0 = Math.round(sx);
        const Y0 = Math.round(sy);
        const X1 = Math.round(sx + ts);
        const Y1 = Math.round(sy + ts);
        if (X1 <= 0 || Y1 <= 0 || X0 >= W || Y0 >= H) continue;
        const wx = ((tx % n) + n) % n;
        const tile = this.getTile(zi, wx, ty);
        if (typeof tile !== 'string') {
          try {
            ctx.drawImage(tile, X0, Y0, X1 - X0, Y1 - Y0);
            continue;
          } catch {
            this.cache.set(tileUrl(this._layer, zi, wx, ty), 'error');
          }
        }
        ctx.fillStyle = tile === 'error' ? '#dcd9d2' : '#e4e1da';
        ctx.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
        // 読み込み中は親タイル（1 段粗い）の該当部分を拡大して仮表示
        if (zi > 0) {
          const parent = this.cache.get(tileUrl(this._layer, zi - 1, wx >> 1, ty >> 1));
          if (parent && typeof parent !== 'string') {
            const half = TILE_SIZE / 2;
            try {
              ctx.drawImage(parent, (wx & 1) * half, (ty & 1) * half, half, half, X0, Y0, X1 - X0, Y1 - Y0);
            } catch {
              /* 壊れた画像は無視 */
            }
          }
        }
      }
    }
  }

  private drawOverlays(ctx: CanvasRenderingContext2D): void {
    const pin = this._pin;
    if (!pin) return;
    const toScreen = (q: { e: number; n: number }) => this.project(frameFromLocal(pin, q.e, q.n));
    const path = (ring: { e: number; n: number }[], close = true) => {
      ctx.beginPath();
      ring.forEach((q, i) => {
        const s = toScreen(q);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      if (close) ctx.closePath();
    };
    ctx.save();
    ctx.lineJoin = 'round';

    if (this.neighborRings) {
      // 表示中の建物（今までどおりの薄い線）
      ctx.strokeStyle = 'rgba(60,60,60,0.55)';
      ctx.lineWidth = 1;
      for (const r of this.neighborRings) {
        if (r.hidden) continue;
        path(r.ring);
        ctx.stroke();
      }
      // 計算から除外した建物: 地図の建物を白く消した上に灰色の破線
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(85,85,85,0.95)';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1.5;
      for (const r of this.neighborRings) {
        if (!r.hidden || r.viewOnly) continue;
        path(r.ring);
        ctx.fill();
        ctx.stroke();
      }
      // 表示だけ隠した建物（影・解析には残る）: 塗らずに青の破線
      ctx.strokeStyle = 'rgba(40,110,190,0.95)';
      for (const r of this.neighborRings) {
        if (!r.hidden || !r.viewOnly) continue;
        path(r.ring);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // 選ぶモード: カーソルの下の建物を強調（隠す／戻す対象）
      const hov = this._neighborPick && this.hoverRingId ? this.neighborRings.find((r) => r.id === this.hoverRingId) : null;
      if (hov) {
        path(hov.ring);
        ctx.fillStyle = 'rgba(229,83,31,0.18)';
        ctx.fill();
        ctx.strokeStyle = '#e5531f';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // 生成した区画（隣の区画・描いた区画）: 青の破線
    if (this.lots.length) {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(47,96,150,0.9)';
      ctx.fillStyle = 'rgba(63,106,152,0.06)';
      ctx.lineWidth = 1.5;
      for (const l of this.lots) {
        path(l);
        ctx.fill();
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    if (this.footprint) {
      path(this.footprint);
      ctx.fillStyle = 'rgba(47,79,107,0.35)';
      ctx.fill();
      ctx.strokeStyle = this.footprintInner ? 'rgba(47,79,107,0.55)' : '#2f4f6b';
      ctx.lineWidth = this.footprintInner ? 1 : 2;
      ctx.stroke();
      if (this.footprintInner) {
        path(this.footprintInner);
        ctx.strokeStyle = '#1f3a52';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // 想定の家: 水色の足元 + 「想定」の札（含めない設定のときは薄い破線）。選んだ家は橙の線
    for (const p of this.planned) {
      const off = this.plannedPreview && this.plannedPreview.id === p.id ? this.plannedPreview : null;
      const shift = (q: { e: number; n: number }) => (off ? { e: q.e + off.dE, n: q.n + off.dN } : q);
      const ring = p.ring.map(shift);
      const sel = p.id === this._plannedSel;
      const hov = !sel && p.id === this.hoverPlanned;
      path(ring);
      ctx.fillStyle = p.inactive ? 'rgba(111,143,179,0.14)' : 'rgba(126,170,222,0.55)';
      ctx.fill();
      if (p.inactive) ctx.setLineDash([5, 4]);
      ctx.strokeStyle = sel ? '#e5531f' : hov ? '#1f4f86' : p.inactive ? 'rgba(63,106,152,0.75)' : '#3f6a98';
      ctx.lineWidth = sel ? 2.5 : hov ? 2 : 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      if (p.lines) {
        ctx.strokeStyle = p.inactive ? 'rgba(47,79,107,0.35)' : 'rgba(31,58,92,0.75)';
        ctx.lineWidth = 1;
        for (const l of p.lines) {
          if (l.length < 2) continue;
          path(l.map(shift), false);
          ctx.stroke();
        }
      }
      const sp = ring.map(toScreen);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const s of sp) {
        minX = Math.min(minX, s.x);
        maxX = Math.max(maxX, s.x);
        minY = Math.min(minY, s.y);
        maxY = Math.max(maxY, s.y);
      }
      if (maxX - minX >= 30 && maxY - minY >= 18) {
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        this.drawTag(ctx, p.inactive ? '想定（含めない）' : '想定', cx, cy, { bg: p.inactive ? 'rgba(255,255,255,0.9)' : sel ? '#e5531f' : '#3f6a98', fg: p.inactive ? '#3f6a98' : '#fff', size: 10.5 });
      }
    }

    if (this.radiusM) {
      const r = this.radiusM / metersPerPixel(pin.lat, this._zoom);
      if (isFinite(r) && r > 2 && r < 1e5) {
        const c = this.project(pin);
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = 'rgba(80,80,80,0.85)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        const label = `解析範囲 半径${this.radiusM}m`;
        ctx.font = `11px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.strokeText(label, c.x, c.y - r - 4);
        ctx.fillStyle = '#333';
        ctx.fillText(label, c.x, c.y - r - 4);
      }
    }
    ctx.restore();
  }

  /** 角丸の札（中心 x, y）。描いた矩形を返す */
  private drawTag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, o: { bg?: string; fg?: string; border?: string; size?: number; bold?: boolean } = {}): Rect {
    const size = o.size ?? 11;
    ctx.save();
    ctx.font = `${o.bold === false ? '' : 'bold '}${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width;
    const w = tw + 10;
    const h = size + 7;
    const r: Rect = { x: x - w / 2, y: y - h / 2, w, h };
    roundRect(ctx, r.x, r.y, r.w, r.h, 5);
    ctx.fillStyle = o.bg ?? 'rgba(255,255,255,0.92)';
    ctx.fill();
    if (o.border) {
      ctx.strokeStyle = o.border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.fillStyle = o.fg ?? '#222';
    ctx.fillText(text, x, y + 0.5);
    ctx.restore();
    return r;
  }

  /**
   * 辺の長さの札: 辺 a → b の中点から外側（centroid = 多角形の内側の目安の反対）へ、札が辺・中点の「＋」に重ならない分だけずらす
   */
  private drawEdgeLabel(ctx: CanvasRenderingContext2D, a: XY, b: XY, centroid: XY, text: string, o: { strong?: boolean; color?: string; border?: string } = {}): void {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let nx = (b.y - a.y) / L;
    let ny = -(b.x - a.x) / L;
    if (nx * (mx - centroid.x) + ny * (my - centroid.y) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const size = 11;
    ctx.save();
    ctx.font = `bold ${size}px ${FONT}`;
    const w = ctx.measureText(text).width + 10;
    ctx.restore();
    const h = size + 7;
    // 札の中心から辺までの距離 = 札の半分の幅・高さを法線に投影した長さ + すき間（「＋」の分）
    const off = Math.abs(nx) * (w / 2) + Math.abs(ny) * (h / 2) + (this._polyEdit ? 9 : 5);
    this.drawTag(ctx, text, mx + nx * off, my + ny * off, {
      bg: o.strong ? '#1f6fd1' : 'rgba(255,255,255,0.94)',
      fg: o.strong ? '#fff' : (o.color ?? '#9a2f17'),
      border: o.strong ? undefined : (o.border ?? 'rgba(255,90,54,0.65)'),
      size,
    });
  }

  private drawPolygon(ctx: CanvasRenderingContext2D): void {
    const poly = this._polygon;
    this.moveHandleRect = null;
    if (!poly.length) return;
    const pts = poly.map((p) => this.project(p));
    const closed = this._polyClosed && poly.length >= 3;
    const drawing = !closed && this._polyMode;
    const color = '#ff5a36';
    // 辺の長さ・面積を出すか（描く・編集の間と、辺の一覧で入力中の辺）
    const showLengths = drawing || this._polyEdit || (this._tool?.kind === 'edge' && closed);
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (poly.length >= 3) {
      ctx.beginPath();
      pts.forEach((s, i) => (i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,90,54,0.18)';
      ctx.fill();
    }

    if (poly.length >= 2) {
      ctx.beginPath();
      pts.forEach((s, i) => (i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y)));
      if (closed) ctx.closePath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(closed ? [] : [7, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 強調する辺（辺の一覧で入力中・辺を選ぶ道具のカーソルの下）
    const strongEdge = this._tool?.kind === 'edge' ? this.hoverEdge : this.highlightEdge;
    const nEdges = closed ? poly.length : poly.length - 1;
    if (strongEdge >= 0 && strongEdge < nEdges) {
      const a = pts[strongEdge];
      const b = pts[(strongEdge + 1) % pts.length];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = '#1f6fd1';
      ctx.lineWidth = 5;
      ctx.stroke();
    }

    // 描画中: 最後の頂点からカーソルまでのラバーバンド（Shift で直前の辺に直角・平行）
    let band: XY | null = null;
    if (drawing && this.hover && !this.drag && !this.pinch) {
      const l = pts[pts.length - 1];
      band = this.shiftHeld ? snapToPrevEdge(pts.length >= 2 ? pts[pts.length - 2] : null, l, this.hover) : this.hover;
      ctx.beginPath();
      ctx.moveTo(l.x, l.y);
      ctx.lineTo(band.x, band.y);
      ctx.strokeStyle = 'rgba(255,90,54,0.6)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 辺の長さ（m, 小数 2 桁）。短すぎる辺は札を省く（強調している辺は出す）
    if (showLengths || strongEdge >= 0) {
      const lens = edgeLengthsM(poly, closed);
      const cen = pts.reduce((s, p) => ({ x: s.x + p.x / pts.length, y: s.y + p.y / pts.length }), { x: 0, y: 0 });
      for (let i = 0; i < lens.length; i++) {
        if (!showLengths && i !== strongEdge) continue;
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if (Math.hypot(b.x - a.x, b.y - a.y) < EDGE_LABEL_MIN_PX && i !== strongEdge) continue;
        this.drawEdgeLabel(ctx, a, b, cen, `辺${i + 1} ${formatLength(lens[i])}`, { strong: i === strongEdge });
      }
      if (band && this.hover) {
        const last = poly[poly.length - 1];
        const L = distanceM(last, this.unproject(band.x, band.y));
        this.drawTag(ctx, formatLength(L), band.x + 14, band.y - 14, { bg: 'rgba(31,34,38,0.86)', fg: '#fff', size: 11 });
      }
    }

    // 編集モード: 辺の中点の「＋」（クリックで頂点を足す）
    if (this._polyEdit && closed) {
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if (Math.hypot(b.x - a.x, b.y - a.y) < MID_HANDLE_MIN_PX) continue;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        ctx.beginPath();
        ctx.rect(mx - 5.5, my - 5.5, 11, 11);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(mx - 3, my);
        ctx.lineTo(mx + 3, my);
        ctx.moveTo(mx, my - 3);
        ctx.lineTo(mx, my + 3);
        ctx.strokeStyle = '#9a2f17';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // 頂点（描画中で 3 点以上なら、最初の頂点を大きくして「ここをクリックで閉じる」。編集で選んだ頂点は塗りつぶす）
    for (let i = 0; i < pts.length; i++) {
      const s = pts[i];
      const sel = this._polyEdit && i === this.selVertex;
      const r = !closed && this._polyMode && i === 0 && poly.length >= 3 ? 7 : sel ? 6.5 : 5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = sel ? color : '#fff';
      ctx.fill();
      ctx.strokeStyle = sel ? '#9a2f17' : color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // 面積ラベル（閉じた輪郭。描いている途中も 3 点以上なら閉じたときの面積）。編集モードではつまみ（ドラッグで輪郭全体を動かす）
    if (closed || (drawing && poly.length >= 3)) {
      const c = polygonCentroid(poly);
      if (c) {
        const s = this.project(c);
        // ピンが面積の札に重なるときは札を少し下へ（ピンは上に向かって描く）
        if (this._pin) {
          const pp = this.project(this._pin);
          if (Math.abs(pp.x - s.x) < 90 && pp.y - s.y > -16 && pp.y - s.y < PIN_HEAD_DY + 26) s.y = pp.y + 18;
        }
        const area = formatArea(polygonAreaM2(poly));
        const label = this._polyEdit ? `✥ ${area}` : closed ? area : `${area}（閉じると）`;
        ctx.font = `bold 12px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width;
        const rect: Rect = { x: s.x - tw / 2 - 7, y: s.y - 11, w: tw + 14, h: 22 };
        roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 6);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fill();
        ctx.strokeStyle = this._polyEdit ? '#b33a1e' : 'rgba(255,90,54,0.7)';
        ctx.lineWidth = this._polyEdit ? 1.5 : 1;
        ctx.stroke();
        ctx.fillStyle = '#b33a1e';
        ctx.fillText(label, s.x, s.y + 0.5);
        if (this._polyEdit) this.moveHandleRect = rect;
      }
    }
    ctx.restore();
  }

  /** 道具の下見: 置く家の形・2 点の線・描いている区画 */
  private drawToolOverlay(ctx: CanvasRenderingContext2D): void {
    const tool = this._tool;
    if (!tool) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const blue = '#2f6096';
    if (tool.kind === 'point' && tool.preview && this.hover && !this.drag && this._pin) {
      const ring = tool.preview(this.unproject(this.hover.x, this.hover.y));
      if (ring && ring.length >= 3) {
        const pin = this._pin;
        ctx.beginPath();
        ring.forEach((q, i) => {
          const s = this.project(frameFromLocal(pin, q.e, q.n));
          if (i === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
        ctx.fillStyle = 'rgba(126,170,222,0.35)';
        ctx.fill();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = blue;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (tool.kind === 'line' && this.lineA) {
      const a = this.project(this.lineA);
      ctx.beginPath();
      ctx.arc(a.x, a.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = blue;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (this.hover && !this.drag) {
        const b = this.shiftHeld ? snapToPrevEdge(null, a, this.hover) : this.hover;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = blue;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        const bb = this.unproject(b.x, b.y);
        this.drawTag(ctx, `向き ${bearingDeg(this.lineA, bb).toFixed(1)}°・${formatLength(distanceM(this.lineA, bb))}`, b.x + 14, b.y - 14, { bg: 'rgba(31,34,38,0.86)', fg: '#fff' });
      }
    }
    if (tool.kind === 'lot' && this.lotPts.length) {
      const pts = this.lotPts.map((p) => this.project(p));
      if (pts.length >= 3) {
        ctx.beginPath();
        pts.forEach((s, i) => (i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y)));
        ctx.closePath();
        ctx.fillStyle = 'rgba(63,106,152,0.12)';
        ctx.fill();
      }
      ctx.beginPath();
      pts.forEach((s, i) => (i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y)));
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = blue;
      ctx.lineWidth = 2;
      ctx.stroke();
      let band: XY | null = null;
      if (this.hover && !this.drag) {
        const l = pts[pts.length - 1];
        band = this.shiftHeld ? snapToPrevEdge(pts.length >= 2 ? pts[pts.length - 2] : null, l, this.hover) : this.hover;
        ctx.beginPath();
        ctx.moveTo(l.x, l.y);
        ctx.lineTo(band.x, band.y);
        ctx.strokeStyle = 'rgba(47,96,150,0.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const lens = edgeLengthsM(this.lotPts, false);
      const cen = pts.reduce((s, p) => ({ x: s.x + p.x / pts.length, y: s.y + p.y / pts.length }), { x: 0, y: 0 });
      for (let i = 0; i < lens.length; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (Math.hypot(b.x - a.x, b.y - a.y) < EDGE_LABEL_MIN_PX) continue;
        this.drawEdgeLabel(ctx, a, b, cen, formatLength(lens[i]), { color: blue, border: 'rgba(47,96,150,0.6)' });
      }
      if (band) {
        const L = distanceM(this.lotPts[this.lotPts.length - 1], this.unproject(band.x, band.y));
        this.drawTag(ctx, formatLength(L), band.x + 14, band.y - 14, { bg: 'rgba(31,34,38,0.86)', fg: '#fff' });
      }
      for (let i = 0; i < pts.length; i++) {
        const s = pts[i];
        ctx.beginPath();
        ctx.arc(s.x, s.y, i === 0 && pts.length >= 3 ? 7 : 5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = blue;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawPin(ctx: CanvasRenderingContext2D): void {
    const pin = this._pin;
    if (!pin) return;
    const { x, y } = this.project(pin);
    if (x < -40 || y < -40 || x > this.W + 40 || y > this.H + 40) return;
    ctx.save();
    // 接地点の小さな影
    ctx.beginPath();
    ctx.ellipse(x, y + 1, 5, 2.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fill();
    // 涙形のマーカー
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    const hy = y - PIN_HEAD_DY;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x - 3, y - 9, x - 11, hy + 9, x - 11, hy);
    ctx.arc(x, hy, 11, Math.PI, 0);
    ctx.bezierCurveTo(x + 11, hy + 9, x + 3, y - 9, x, y);
    ctx.closePath();
    ctx.fillStyle = '#e8402a';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = 'rgba(130,25,10,0.7)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // 白い中心
    ctx.beginPath();
    ctx.arc(x, hy, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
  }

  private drawScaleBar(ctx: CanvasRenderingContext2D): void {
    const off = this.scaleBarOffset ?? this.opts.scaleBarOffset ?? { x: 12, y: 12 };
    const sb = niceScaleBar(metersPerPixel(this._center.lat, this._zoom), Math.min(120, this.W / 3));
    ctx.save();
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const tw = ctx.measureText(sb.label).width;
    const barW = Math.max(sb.px, 20);
    const boxW = Math.max(barW, tw) + 16;
    const boxH = 30;
    const x = off.x;
    const yb = this.H - off.y;
    roundRect(ctx, x, yb - boxH, boxW, boxH, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();
    ctx.fillStyle = '#222';
    ctx.fillText(sb.label, x + 8, yb - 16);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 8, yb - 12);
    ctx.lineTo(x + 8, yb - 7);
    ctx.lineTo(x + 8 + barW, yb - 7);
    ctx.lineTo(x + 8 + barW, yb - 12);
    ctx.stroke();
    ctx.restore();
  }

  private drawNorth(ctx: CanvasRenderingContext2D): void {
    const r = 17;
    const cx = this.W - 14 - r;
    const cy = 14 + r;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // N の文字
    ctx.font = 'bold 11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#222';
    ctx.fillText('N', cx, cy - 7);
    // 上向きの矢印
    ctx.strokeStyle = '#e8402a';
    ctx.fillStyle = '#e8402a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy + 12);
    ctx.lineTo(cx, cy + 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - 1);
    ctx.lineTo(cx - 4, cy + 5);
    ctx.lineTo(cx + 4, cy + 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

const xyArgs = (p: XY): [number, number] => [p.x, p.y];

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}
