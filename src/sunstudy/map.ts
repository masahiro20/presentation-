/**
 * 場所を選ぶ 2D 地図（Canvas のスリッピーマップ。国土地理院タイル）
 *  - タイル: std（標準地図）/ pale（淡色地図）/ seamlessphoto（航空写真, z<=18）
 *  - ドラッグでパン、ホイール・ボタンでズーム（z 5..18、小数ズーム可）、クリックでピン、ピンのドラッグ、2 本指ピンチ
 *  - 敷地の輪郭を描くモード（クリックで頂点追加、最初の頂点か「完了」で閉じる、頂点のドラッグ、右クリック/Backspace で最後の頂点を消す）
 *  - 建物の足跡（e/n）・周辺建物の輪郭・解析半径の円・スケールバー・方位（北が上）の描画
 *  - 周辺建物を選ぶモード（setNeighborPickMode）: クリックした輪郭の id を onNeighborClick に渡す（ピンは動かさない）。
 *    隠した建物の輪郭（hidden）は灰色の破線で描く
 *  - 出典（attribution）とボタン類は DOM 側（placeStep）が描く。ここでは文字列を返すだけ
 *
 * 依存ライブラリ無し。純粋な関数（metersPerPixel / polygonAreaM2 / 画素変換）は Node でも読み込める
 * （モジュール読み込み時に document / window には触らない）。
 */
import type { LatLon } from './types';
import { frameFromLocal } from './types';
import { lonLatToTile, tileToLonLat, metersPerDegree } from '../sun/geo';
import { hitRingAt } from './neighborSelect';

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
export const MAX_ZOOM = 18;
/** Web メルカトルの緯度の限界 */
const MAX_LAT = 85.05112878;
/** タイルキャッシュの上限（枚） */
const TILE_CACHE_MAX = 800;
/** 同時に読み込むタイルの上限 */
const MAX_INFLIGHT = 24;
/** ピンの頭（丸）の中心は基準点から何 px 上か */
const PIN_HEAD_DY = 24;

const TILE_PATH: Record<MapLayer, { dir: string; ext: string }> = {
  std: { dir: 'std', ext: 'png' },
  pale: { dir: 'pale', ext: 'png' },
  photo: { dir: 'seamlessphoto', ext: 'jpg' },
};

export interface MapPickerOptions {
  initial: LatLon;
  zoom?: number;
  layer?: MapLayer;
  /** ピンが置かれた・動いた */
  onPin?: (p: LatLon) => void;
  /** 敷地ポリゴンが変わった（頂点追加・移動・削除・クリア） */
  onPolygonChange?: (poly: LatLon[], closed: boolean) => void;
  /** 表示範囲が変わった（ズーム・中心） */
  onView?: (center: LatLon, zoom: number) => void;
  /** 輪郭モードが地図側の操作（閉じた・Esc）で切り替わった。UI のボタン表示を同期するため */
  onPolygonModeChange?: (on: boolean) => void;
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
}

/** 地図に描く周辺建物の輪郭（ピンからの東・北 m）。hidden = 隠した建物（灰色の破線） */
export interface MapNeighborRing {
  id: string;
  ring: { e: number; n: number }[];
  hidden?: boolean;
}

/** 1 枚も読めないまま何枚失敗したら「地図サーバーに接続できない」と判断するか */
const TILE_FAIL_THRESHOLD = 6;

// ---------------------------------------------------------------------------
// 純粋なヘルパー（DOM 不要）
// ---------------------------------------------------------------------------

/** タイル URL（国土地理院） */
export function tileUrl(layer: MapLayer, z: number, x: number, y: number): string {
  const t = TILE_PATH[layer];
  return `https://cyberjapandata.gsi.go.jp/xyz/${t.dir}/${z}/${x}/${y}.${t.ext}`;
}

export function clampZoom(z: number): number {
  if (!isFinite(z)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
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

const NICE_LENGTHS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];

/** スケールバー: maxPx 以下に収まる「きれいな」長さ（10/20/50/100/200/500 m …）を選ぶ */
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
  | (DragBase & { kind: 'vertex'; index: number; lastFire: number });

interface Pinch {
  startDist: number;
  startZoom: number;
  anchor: LatLon;
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

  private footprint: { e: number; n: number }[] | null = null;
  private footprintInner: { e: number; n: number }[] | null = null;
  private neighborRings: MapNeighborRing[] | null = null;
  private _neighborPick = false;
  /** 選ぶモードでカーソルの下にある輪郭の id */
  private hoverRingId: string | null = null;
  /** 選ぶモードの直前のクリック（ダブルクリックでの拡大の 2 回目で隠す／戻すを打ち消さない） */
  private lastPickClick: { x: number; y: number; t: number } | null = null;
  private radiusM: number | null = null;

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
    if (on && this._neighborPick) {
      // 周辺建物を選ぶモードとは同時に使わない
      this.setNeighborPickMode(false);
      this.opts.onNeighborPickModeChange?.(false);
    }
    if (on) {
      this.setPolyModeInternal(true, false);
    } else if (!this._polyClosed && this._polygon.length >= 3) {
      this._polyClosed = true;
      this.setPolyModeInternal(false, false);
      this.firePolygon();
    } else if (!this._polyClosed && this._polygon.length) {
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
  /** 外から輪郭を与える（3 点以上なら閉じた輪郭として扱う）。onPolygonChange は呼ばない */
  setPolygon(poly: LatLon[]): void {
    this._polygon = poly.map((p) => ({ lat: p.lat, lon: p.lon }));
    this._polyClosed = this._polygon.length >= 3;
    this.requestDraw();
  }
  clearPolygon(): void {
    this._polygon = [];
    this._polyClosed = false;
    this.requestDraw();
    this.firePolygon();
  }
  /** 描いている輪郭を閉じる（3 点以上）。モードも終わる */
  finishPolygon(): void {
    if (this._polyClosed || this._polygon.length < 3) return;
    this.closePolygon();
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

  /** 周辺建物を選ぶモード（クリックで onNeighborClick。ピンは動かさず、ピンのドラッグもしない）。輪郭を描くモードとは同時に使わない */
  get neighborPickMode(): boolean {
    return this._neighborPick;
  }
  setNeighborPickMode(on: boolean): void {
    if (on === this._neighborPick) return;
    this._neighborPick = on;
    if (on && this._polyMode) this.setPolygonMode(false);
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

  private hitPin(x: number, y: number): boolean {
    if (!this._pin) return false;
    const s = this.project(this._pin);
    return Math.hypot(s.x - x, s.y - (y + PIN_HEAD_DY)) <= 14 || Math.hypot(s.x - x, s.y - y) <= 8;
  }

  // ----- イベント ---------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    if (this.disposed) return;
    const pt = this.toLocal(e);
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
      this.canvas.classList.remove('dragging');
      return;
    }
    if (this.pointers.size > 2 || this.pinch) return;

    if (e.button === 2) {
      // 右クリック: 描画中なら最後の頂点を消す
      if (this._polyMode && !this._polyClosed && this._polygon.length) this.removeLastVertex();
      return;
    }
    if (e.button !== 0) return;

    const base: DragBase = { id: e.pointerId, sx: pt.x, sy: pt.y, t0: performance.now(), moved: false };
    const vi = this.hitVertex(pt.x, pt.y);
    if (vi >= 0) {
      this.drag = { kind: 'vertex', ...base, index: vi, lastFire: 0 };
      return;
    }
    if (this._pin && !this._polyMode && !this._neighborPick && this.hitPin(pt.x, pt.y)) {
      const pp = this.project(this._pin);
      this.drag = { kind: 'pin', ...base, offX: pt.x - pp.x, offY: pt.y - pp.y, lastFire: 0 };
      return;
    }
    this.drag = { kind: 'pan', ...base, c0: lonLatToWorldPx(this._center.lon, this._center.lat, this._zoom) };
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.disposed) return;
    const pt = this.toLocal(e);
    this.hover = pt;
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
      // 描画中はラバーバンド（最後の頂点 → カーソル）を更新
      if (this._polyMode && !this._polyClosed && this._polygon.length) this.requestDraw();
      return;
    }

    if (!d.moved && Math.hypot(pt.x - d.sx, pt.y - d.sy) > 5) {
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
      case 'vertex': {
        if (d.index < this._polygon.length) {
          this._polygon[d.index] = this.unproject(pt.x, pt.y);
          this.requestDraw();
          const now = performance.now();
          if (now - d.lastFire > 80) {
            d.lastFire = now;
            this.firePolygon();
          }
        }
        break;
      }
    }
  };

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

    const isClick = !d.moved && e.type !== 'pointercancel' && performance.now() - d.t0 <= 500 && Math.hypot(pt.x - d.sx, pt.y - d.sy) <= 5;

    if (d.kind === 'pan') {
      if (isClick) this.handleClick(pt);
      else if (d.moved) this.scheduleView();
    } else if (d.kind === 'pin') {
      if (d.moved && this._pin) this.opts.onPin?.({ ...this._pin });
    } else if (d.kind === 'vertex') {
      if (d.moved) this.firePolygon();
      else if (isClick && d.index === 0 && this._polyMode && !this._polyClosed && this._polygon.length >= 3) this.closePolygon();
    }
    this.updateHoverCursor(pt);
  };

  private onPointerLeave = (): void => {
    this.hover = null;
    if (this.hoverRingId) {
      this.hoverRingId = null;
      this.requestDraw();
    }
    if (this._polyMode && !this._polyClosed && this._polygon.length) this.requestDraw();
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
    if (this._neighborPick && e.key === 'Escape') {
      e.preventDefault();
      this.setNeighborPickMode(false);
      this.opts.onNeighborPickModeChange?.(false);
      return;
    }
    if (!this._polyMode) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.setPolygonMode(false);
      this.opts.onPolygonModeChange?.(false);
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !this._polyClosed && this._polygon.length) {
      e.preventDefault();
      this.removeLastVertex();
    }
  };

  private onOnline = (): void => {
    this.retryFailedTiles();
  };

  private onWindowResize = (): void => {
    this.resize();
  };

  private updateHoverCursor(pt: { x: number; y: number }): void {
    if (this.drag || this.pinch) return;
    if (this._neighborPick) {
      const id = this.neighborAt(pt.x, pt.y);
      if (id !== this.hoverRingId) {
        this.hoverRingId = id;
        this.requestDraw();
      }
      this.canvas.style.cursor = id ? 'pointer' : '';
      return;
    }
    const over = this.hitVertex(pt.x, pt.y) >= 0 || (!!this._pin && !this._polyMode && this.hitPin(pt.x, pt.y));
    this.canvas.style.cursor = over ? 'pointer' : '';
  }

  /** 左クリック（移動なし）: 周辺建物を選ぶモードなら輪郭の id を返す、輪郭モードなら頂点追加／閉じる、そうでなければピンを置く */
  private handleClick(pt: { x: number; y: number }): void {
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
    const ll = this.unproject(pt.x, pt.y);
    if (this._polyMode) {
      if (this._polyClosed) {
        // 閉じた輪郭がある状態でモードに入っていたら、新しい輪郭を描き始める
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
      if (this._polygon.length) {
        // 直前の頂点と同じ位置（ダブルクリックの 2 回目など）は無視
        const l = this.project(this._polygon[this._polygon.length - 1]);
        if (Math.hypot(pt.x - l.x, pt.y - l.y) <= 5) return;
      }
      this._polygon.push(ll);
      this.requestDraw();
      this.firePolygon();
      return;
    }
    this._pin = ll;
    this.requestDraw();
    this.opts.onPin?.({ ...ll });
  }

  private removeLastVertex(): void {
    this._polygon.pop();
    this.requestDraw();
    this.firePolygon();
  }

  private closePolygon(): void {
    this._polyClosed = true;
    this.setPolyModeInternal(false, true);
    this.requestDraw();
    this.firePolygon();
  }

  private setPolyModeInternal(on: boolean, notify: boolean): void {
    const changed = on !== this._polyMode;
    this._polyMode = on;
    this.canvas.classList.toggle('placing', on);
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
      this.setViewAnchored(ll, anchorPt.x, anchorPt.y, z0 + (target - z0) * k);
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
      this.drawPin(ctx);
      this.drawScaleBar(ctx);
      this.drawNorth(ctx);
    } catch (err) {
      console.warn('地図の描画に失敗しました', err);
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
    const zi = Math.floor(this._zoom);
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
    ctx.save();
    ctx.lineJoin = 'round';

    if (this.neighborRings) {
      const path = (ring: { e: number; n: number }[]) => {
        ctx.beginPath();
        ring.forEach((q, i) => {
          const s = toScreen(q);
          if (i === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
      };
      // 表示中の建物（今までどおりの薄い線）
      ctx.strokeStyle = 'rgba(60,60,60,0.55)';
      ctx.lineWidth = 1;
      for (const r of this.neighborRings) {
        if (r.hidden) continue;
        path(r.ring);
        ctx.stroke();
      }
      // 隠した建物: 地図の建物を白く消した上に灰色の破線
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(85,85,85,0.95)';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1.5;
      for (const r of this.neighborRings) {
        if (!r.hidden) continue;
        path(r.ring);
        ctx.fill();
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

    if (this.footprint) {
      ctx.beginPath();
      this.footprint.forEach((q, i) => {
        const s = toScreen(q);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(47,79,107,0.35)';
      ctx.fill();
      ctx.strokeStyle = this.footprintInner ? 'rgba(47,79,107,0.55)' : '#2f4f6b';
      ctx.lineWidth = this.footprintInner ? 1 : 2;
      ctx.stroke();
      if (this.footprintInner) {
        ctx.beginPath();
        this.footprintInner.forEach((q, i) => {
          const s = toScreen(q);
          if (i === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
        ctx.strokeStyle = '#1f3a52';
        ctx.lineWidth = 2;
        ctx.stroke();
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
        ctx.font = '11px system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif';
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

  private drawPolygon(ctx: CanvasRenderingContext2D): void {
    const poly = this._polygon;
    if (!poly.length) return;
    const pts = poly.map((p) => this.project(p));
    const closed = this._polyClosed && poly.length >= 3;
    const color = '#ff5a36';
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

    // 描画中: 最後の頂点からカーソルまでのラバーバンド
    if (!closed && this._polyMode && this.hover && !this.drag && !this.pinch) {
      const l = pts[pts.length - 1];
      ctx.beginPath();
      ctx.moveTo(l.x, l.y);
      ctx.lineTo(this.hover.x, this.hover.y);
      ctx.strokeStyle = 'rgba(255,90,54,0.6)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 頂点（描画中で 3 点以上なら、最初の頂点を大きくして「ここをクリックで閉じる」）
    for (let i = 0; i < pts.length; i++) {
      const s = pts[i];
      const r = !closed && this._polyMode && i === 0 && poly.length >= 3 ? 7 : 5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // 面積ラベル（閉じた輪郭）
    if (closed) {
      const c = polygonCentroid(poly);
      if (c) {
        const s = this.project(c);
        const label = formatArea(polygonAreaM2(poly));
        ctx.font = 'bold 12px system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width;
        roundRect(ctx, s.x - tw / 2 - 7, s.y - 11, tw + 14, 22, 6);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,90,54,0.7)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#b33a1e';
        ctx.fillText(label, s.x, s.y + 0.5);
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
    const off = this.opts.scaleBarOffset ?? { x: 12, y: 12 };
    const sb = niceScaleBar(metersPerPixel(this._center.lat, this._zoom), Math.min(120, this.W / 3));
    ctx.save();
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif';
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
