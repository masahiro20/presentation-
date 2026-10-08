/**
 * 日照検討用の周辺環境（航空写真・周辺建物・太陽軌道・方位）
 */
import * as THREE from 'three';
import type { Viewer } from '../scene/viewer';
import { clearGroup } from '../scene/viewer';
import { fetchAerial, fetchGsiBuildings, fetchOsmBuildings, metersPerDegree, siteLatLon, type NeighborBuilding, type SiteLocation } from './geo';
import { sunPosition, sunDirectionWorld, localDate, keyDates, sunriseSunset } from './solar';
import { ALIGN_COLORS, type EN } from './align';

// ---------------------------------------------------------------- 周辺建物を隠す・高さを直す（純粋な計算。DOM・THREE を使わない）

export interface LatLon {
  lat: number;
  lon: number;
}

/** 選んだ建物の色（2 点合わせの航空写真側の印 ALIGN_COLORS.target と同じオレンジ） */
export const NEIGHBOR_SELECT_COLOR = ALIGN_COLORS.target;
/** 隠した建物を薄く表示するときの不透明度 */
export const GHOST_OPACITY = 0.25;
/** 表示だけ隠した建物の薄い表示の色（計算から除外した建物は灰色） */
export const GHOST_VIEW_COLOR = '#7fb2e5';

/** リングの面積 (m²)。閉じた点（最後 = 最初）が重なっていても同じ値。座標が大きくても（地点によらない座標）桁落ちしないよう最初の点から測る */
export function ringArea(ring: EN[]): number {
  if (ring.length < 3) return 0;
  const o = ring[0];
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j].e - o.e) * (ring[i].n - o.n) - (ring[i].e - o.e) * (ring[j].n - o.n);
  return Math.abs(a) / 2;
}

/** リングの重心（面積で重み付け。点の並び・閉じた点の重なりによらない）。面積が 0 なら頂点の平均。最初の点から測って桁落ちを防ぐ */
export function ringCentroid(ring: EN[]): EN {
  if (!ring.length) return { e: 0, n: 0 };
  const o = ring[0];
  let a = 0;
  let ce = 0;
  let cn = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const je = ring[j].e - o.e;
    const jn = ring[j].n - o.n;
    const ie = ring[i].e - o.e;
    const in_ = ring[i].n - o.n;
    const k = je * in_ - ie * jn;
    a += k;
    ce += (je + ie) * k;
    cn += (jn + in_) * k;
  }
  if (Math.abs(a) < 1e-9) {
    const n = ring.length;
    return ring.reduce((s, p) => ({ e: s.e + (p.e - o.e) / n, n: s.n + (p.n - o.n) / n }), { e: o.e, n: o.n });
  }
  return { e: o.e + ce / (3 * a), n: o.n + cn / (3 * a) };
}

/** 点がリングの内側か（偶奇判定） */
export function pointInRing(p: EN, ring: EN[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.n > p.n !== b.n > p.n && p.e < ((b.e - a.e) * (p.n - a.n)) / (b.n - a.n) + a.e) inside = !inside;
  }
  return inside;
}

/**
 * 地点 origin（緯度・経度）から測った東・北 (m) を、どの地点から測っても同じ値になる東・北 (m) に直す
 * （緯度・経度 × 1° の長さ。基準の緯度は整数度）。建設地のピンを動かして取り直しても同じ建物が同じキーになるように使う
 */
export function absoluteEN(p: EN, origin: LatLon): EN {
  const o = metersPerDegree(origin.lat);
  const lat = origin.lat + p.n / o.mLat;
  const lon = origin.lon + p.e / o.mLon;
  const ref = metersPerDegree(Math.round(origin.lat));
  return { e: lon * ref.mLon, n: lat * ref.mLat };
}

const half = (v: number) => (Math.round(v * 2) / 2).toFixed(1);

/**
 * 周辺建物の「同じ建物か」を表すキー。
 *  - 国土地理院・OSM: 出典 + 重心（0.5 m 単位）+ 面積（1 m² 単位）。origin（外形を測った地点 = 取得したときのピン）を渡すと
 *    重心を地点によらない座標（absoluteEN）で測るので、ピンを動かして取り直しても同じ建物は同じキーになる
 *  - 手動の隣家: 番号（id）。同じ大きさ・場所に 2 棟足しても別の建物になる（id が無ければ形のキー）
 */
export function neighborKey(b: Pick<NeighborBuilding, 'ring' | 'source' | 'id'>, origin?: LatLon | null): string {
  if (b.source === 'manual' && b.id) return `manual:${b.id}`;
  const c = ringCentroid(b.ring);
  const p = origin ? absoluteEN(c, origin) : c;
  return `${b.source}:${half(p.e)}:${half(p.n)}:${Math.round(ringArea(b.ring))}`;
}

/**
 * 2 つの外形が同じ建物か（キーが丸めの境目でずれたとき・国土地理院と OSM で外形が少し違うときの照合）:
 * 面積の比が 0.6〜1/0.6 で、互いの重心が相手の内側にある
 */
export function sameFootprint(a: EN[], b: EN[]): boolean {
  const aa = ringArea(a);
  const ab = ringArea(b);
  if (!(aa > 0 && ab > 0)) return false;
  const r = aa / ab;
  if (r < 0.6 || r > 1 / 0.6) return false;
  return pointInRing(ringCentroid(a), b) && pointInRing(ringCentroid(b), a);
}

/**
 * 隠し方:
 *  - 'view' = 表示だけ隠す（3D には描かないが、影は落とし、部屋の日当たり・日照時間マップにも入れる。プレゼンで視点を遮る建物など）
 *  - 'exclude' = 計算から除外（描かない・影を落とさない・解析に入れない。解体予定の既存建物など）
 */
export type HideMode = 'view' | 'exclude';
/** 隠した理由: 解体予定／敷地内の既存建物／データの誤り／その他（自由記述は note） */
export type HideReason = 'demolish' | 'onSite' | 'dataError' | 'other';

/** 隠し方・理由の記録 */
export interface HideRecord {
  mode: HideMode;
  reason: HideReason;
  /** 理由の自由記述（その他のとき。ほかの理由でも補足として残す） */
  note?: string;
}

export const HIDE_MODES: readonly HideMode[] = ['exclude', 'view'];
export const HIDE_REASONS: readonly HideReason[] = ['demolish', 'onSite', 'dataError', 'other'];
/** 隠し方の名前（選択肢・一覧の見出し） */
export const HIDE_MODE_NAME: Readonly<Record<HideMode, string>> = { view: '表示だけ隠す（影・解析には残す）', exclude: '計算から除外' };
/** 隠し方の短い名前（一覧のボタン・資料の表） */
export const HIDE_MODE_SHORT: Readonly<Record<HideMode, string>> = { view: '表示だけ隠す', exclude: '計算から除外' };
/** 理由の名前 */
export const HIDE_REASON_LABEL: Readonly<Record<HideReason, string>> = { demolish: '解体予定', onSite: '敷地内の既存建物', dataError: 'データの誤り', other: 'その他' };
/** 記録の無い（古い）隠す記録の扱い: 計算から除外・その他（以前の「隠す」は影・解析からも外していた） */
export const LEGACY_HIDE_RECORD: Readonly<HideRecord> = { mode: 'exclude', reason: 'other' };

/**
 * 隠す記録を読む（保存データ・古い記録・欠けた値）。mode・reason が無い／知らない値なら 計算から除外・その他。
 * note は前後の空白を落とし、空なら付けない（200 文字まで）
 */
export function normalizeHideRecord(raw: unknown): HideRecord {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const mode = HIDE_MODES.includes(r.mode as HideMode) ? (r.mode as HideMode) : LEGACY_HIDE_RECORD.mode;
  const reason = HIDE_REASONS.includes(r.reason as HideReason) ? (r.reason as HideReason) : LEGACY_HIDE_RECORD.reason;
  const note = typeof r.note === 'string' ? r.note.trim().slice(0, 200) : '';
  return note ? { mode, reason, note } : { mode, reason };
}

/** 理由の表示（その他は自由記述を括弧で。例 'その他（車庫の屋根）'） */
export function hideReasonText(r: Pick<HideRecord, 'reason' | 'note'>): string {
  const base = HIDE_REASON_LABEL[r.reason];
  return r.note ? `${base}（${r.note}）` : base;
}

/**
 * 隠す・高さの記録（キー → 状態）。外形は地点によらない座標（absoluteEN）で、手動の隣家には無い。
 * hidden は隠した建物のキー（どちらの隠し方でも）、hideInfo はその隠し方・理由。
 * hideInfo に無いキー（古い記録）は 計算から除外・その他（LEGACY_HIDE_RECORD）として扱う
 */
export interface NeighborEdits {
  hidden: Set<string>;
  hideInfo: Map<string, HideRecord>;
  heights: Map<string, number>;
  footprints: Map<string, EN[]>;
}

export function emptyEdits(): NeighborEdits {
  return { hidden: new Set(), hideInfo: new Map(), heights: new Map(), footprints: new Map() };
}

/** キーの隠す記録（隠していなければ null。隠し方・理由の無い古い記録は 計算から除外・その他） */
export function hideRecordOf(edits: NeighborEdits, key: string): HideRecord | null {
  if (!edits.hidden.has(key)) return null;
  return normalizeHideRecord(edits.hideInfo?.get(key));
}

/** 記録の付いたキー（隠した・高さを直した） */
function editedKeys(edits: NeighborEdits): Set<string> {
  return new Set([...edits.hidden, ...edits.heights.keys()]);
}

/**
 * 取り直した一覧に、隠す・高さの記録を当て直す（list の hidden を付け直し、記録のキーを今の建物のキーに付け替える）。
 *  1) キーが同じ記録 2) 無ければ、どの建物にもキーで当たらなかった記録のうち外形が同じ（sameFootprint）もの。
 * keyOf: 建物のキー、footprintOf: 照合に使う外形（手動の隣家は null = キーだけで照合）。
 * 戻り値: 隠した建物の数（今の一覧の中で）
 */
export function reapplyEdits(list: NeighborBuilding[], keyOf: (b: NeighborBuilding) => string, footprintOf: (b: NeighborBuilding) => EN[] | null, edits: NeighborEdits): number {
  const keys = list.map(keyOf);
  const recs = editedKeys(edits);
  const exact = new Set(keys.filter((k) => recs.has(k)));
  const free = [...recs].filter((k) => !exact.has(k) && (edits.footprints.get(k)?.length ?? 0) >= 3);
  // 記録 → 当たった今のキー（外形で当たったものだけ。付け替える）
  const moves = new Map<string, Set<string>>();
  if (free.length)
    list.forEach((b, i) => {
      if (recs.has(keys[i])) return;
      const fp = footprintOf(b);
      if (!fp || fp.length < 3) return;
      const r = free.find((k) => sameFootprint(fp, edits.footprints.get(k)!));
      if (!r) return;
      if (!moves.has(r)) moves.set(r, new Set());
      moves.get(r)!.add(keys[i]);
      // 照合に使った外形は今の建物の外形に更新する
      edits.footprints.set(keys[i], fp);
    });
  for (const [from, tos] of moves) {
    for (const to of tos) {
      if (edits.hidden.has(from)) {
        edits.hidden.add(to);
        // 隠し方・理由も一緒に付け替える（古い記録で無ければ付けない = 計算から除外・その他のまま）
        const info = edits.hideInfo.get(from);
        if (info) edits.hideInfo.set(to, { ...info });
      }
      const hgt = edits.heights.get(from);
      if (hgt != null && !edits.heights.has(to)) edits.heights.set(to, hgt);
    }
    edits.hidden.delete(from);
    edits.hideInfo.delete(from);
    edits.heights.delete(from);
    edits.footprints.delete(from);
  }
  let n = 0;
  list.forEach((b, i) => {
    b.hidden = edits.hidden.has(keys[i]);
    if (b.hidden) n++;
  });
  return n;
}

/** 範囲選択: 画面上の点（建物の中心を投影した px）のうち、2 隅 a・b の長方形（どちら向きのドラッグでも）に入るもののキー */
export function keysInRect(pts: { key: string; x: number; y: number }[], a: { x: number; y: number }, b: { x: number; y: number }): string[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const out = new Set<string>();
  for (const p of pts) if (Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) out.add(p.key);
  return [...out];
}

/** 外形の当たり判定: 点 p（東・北 m）を含む外形のうち、いちばん小さいもののキー（無ければ null） */
export function pickRingAt(items: { key: string; ring: EN[] }[], p: EN): string | null {
  let best: string | null = null;
  let ba = Infinity;
  for (const it of items) {
    if (it.ring.length < 3 || !pointInRing(p, it.ring)) continue;
    const a = ringArea(it.ring);
    if (a < ba) {
      ba = a;
      best = it.key;
    }
  }
  return best;
}

export function textSprite(text: string, opts: { size?: number; color?: string; bg?: string; scale?: number } = {}): THREE.Sprite {
  const size = opts.size ?? 48;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `bold ${size}px 'Noto Sans JP', 'Hiragino Sans', sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + size * 0.8;
  c.width = w;
  c.height = Math.ceil(size * 1.5);
  ctx.font = `bold ${size}px 'Noto Sans JP', 'Hiragino Sans', sans-serif`;
  if (opts.bg) {
    ctx.fillStyle = opts.bg;
    const r = c.height / 2;
    ctx.beginPath();
    ctx.roundRect(0, 0, c.width, c.height, r);
    ctx.fill();
  }
  ctx.fillStyle = opts.color ?? '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2 + size * 0.05);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // 画面上で一定の大きさ（距離で拡大縮小しない）
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false, sizeAttenuation: false });
  const sp = new THREE.Sprite(mat);
  const s = (opts.scale ?? 1) * 0.032;
  sp.scale.set((c.width / c.height) * s, s, 1);
  sp.renderOrder = 10;
  return sp;
}

export interface ContextState {
  site: SiteLocation;
  neighbors: NeighborBuilding[];
  showAerial: boolean;
  showNeighbors: boolean;
  showSunPath: boolean;
  aerialLoaded: boolean;
}

export class SunContext {
  readonly group = new THREE.Group();
  private aerial = new THREE.Group();
  private neighborsG = new THREE.Group();
  /**
   * 隠した建物の薄い表示（影を落とさない・解析に入らない: userData.neighbor を付けず noShadow）。
   * 表示だけ隠した建物の影は、別に neighborsG に影だけのメッシュ（userData.shadowOnly）を作る
   */
  private ghostsG = new THREE.Group();
  private pathG = new THREE.Group();
  private sunMarker = new THREE.Group();
  private aerialInfo: { west: number; east: number; south: number; north: number; tex: THREE.Texture } | null = null;
  state: ContextState;
  year = new Date().getFullYear();
  /** 隠す・高さの記録（取り直し・建設地の微調整の後も同じ建物に当て直す。「周辺建物をすべて消す」で消える） */
  readonly edits: NeighborEdits = emptyEdits();
  /** state.neighbors の外形を測った地点（取得したときのピン）。キーを地点によらない座標で作る */
  private neighborsOrigin: LatLon | null = null;
  private keyCache = new WeakMap<NeighborBuilding, string>();
  private seq = 0;
  /** 隠した建物をすべて薄く表示する（「建物を選んで隠す」の間。薄い建物をクリックして戻せる） */
  private ghostsOn = false;
  /** 隠した建物のうち、これだけは薄く表示する（「隠した建物」の一覧で指している行） */
  private previewKey: string | null = null;
  private highlightKeys = new Set<string>();
  private mats: {
    ghost: THREE.Material;
    ghostView: THREE.Material;
    ghostSel: THREE.Material;
    sel: THREE.Material;
    shadowOnly: THREE.Material;
    edge: THREE.LineBasicMaterial;
    edgeSel: THREE.LineBasicMaterial;
  } | null = null;
  /** buildNeighbors の後に呼ぶ（日照ステップの一覧・選択の表示を合わせる。ステップを離れるときは null に戻す） */
  onNeighborsChange: (() => void) | null = null;

  constructor(
    readonly viewer: Viewer,
    site: SiteLocation,
  ) {
    this.state = { site, neighbors: [], showAerial: true, showNeighbors: true, showSunPath: true, aerialLoaded: false };
    this.ghostsG.name = 'neighbor-ghosts';
    this.group.add(this.aerial, this.neighborsG, this.ghostsG, this.pathG, this.sunMarker);
    viewer.groups.context.add(this.group);
  }

  /**
   * 周辺建物（実体）のグループ。メッシュは userData.neighbor（解析の遮蔽物）と userData.neighborKey を持つ。
   * 表示だけ隠した建物は影だけのメッシュ（userData.shadowOnly。色も奥行きも書かず、影と解析にだけ入る）
   */
  get neighborGroup(): THREE.Group {
    return this.neighborsG;
  }
  /** 隠した建物の薄い表示のグループ。メッシュは userData.ghost と userData.neighborKey を持つ（neighbor は無い） */
  get ghostGroup(): THREE.Group {
    return this.ghostsG;
  }
  /** 隠したキーの集合（どちらの隠し方でも。今の一覧に無い建物の記録も含む） */
  get hiddenKeys(): Set<string> {
    return this.edits.hidden;
  }

  /** キーの隠し方・理由（隠していなければ null。古い記録は 計算から除外・その他） */
  hideRecord(key: string): HideRecord | null {
    return hideRecordOf(this.edits, key);
  }

  /** 建物の隠し方（隠していなければ null） */
  hideModeOf(b: NeighborBuilding): HideMode | null {
    return b.hidden ? (this.hideRecord(this.keyOf(b))?.mode ?? LEGACY_HIDE_RECORD.mode) : null;
  }

  /** 建物のキー（neighborKey。国土地理院・OSM は取得した地点から地点によらない座標で測る） */
  keyOf(b: NeighborBuilding): string {
    let k = this.keyCache.get(b);
    if (k == null) {
      k = neighborKey(b, b.source === 'manual' ? null : (this.neighborsOrigin ?? siteLatLon(this.state.site)));
      this.keyCache.set(b, k);
    }
    return k;
  }

  /** 照合用の外形（地点によらない座標）。手動の隣家は建物に付いて動くので null（キー = 番号だけで照合） */
  private footprintOf(b: NeighborBuilding): EN[] | null {
    if (b.source === 'manual') return null;
    const o = this.neighborsOrigin ?? siteLatLon(this.state.site);
    return b.ring.map((p) => absoluteEN(p, o));
  }

  /** キーの建物（今の一覧の中。重複があれば最初の 1 棟） */
  findByKey(key: string): NeighborBuilding | undefined {
    return this.state.neighbors.find((b) => this.keyOf(b) === key);
  }

  /** 影・解析に使う高さ（直した高さがあればそれ） */
  heightOf(b: NeighborBuilding): number {
    return this.edits.heights.get(this.keyOf(b)) ?? b.height;
  }

  /** 隠した建物（今の一覧の中）。mode を渡すとその隠し方の建物だけ */
  hiddenList(mode?: HideMode): NeighborBuilding[] {
    return this.state.neighbors.filter((b) => b.hidden && (!mode || this.hideModeOf(b) === mode));
  }

  /**
   * 建物を隠す／戻す。戻り値: 状態が変わった建物の数（隠し方を変えた建物も数える）。
   * 隠すときは隠し方・理由（rec。省略時は 計算から除外・その他）を一緒に記録する。
   * 隠す記録は外形と一緒に残し、取り直し（loadNeighbors）の後も同じ建物に当て直す
   */
  setHidden(keys: Iterable<string>, hidden: boolean, rec: Partial<HideRecord> = {}): number {
    const ks = new Set(keys);
    const info = normalizeHideRecord(rec);
    let n = 0;
    for (const b of this.state.neighbors) {
      const k = this.keyOf(b);
      if (!ks.has(k)) continue;
      if (hidden) {
        if (!b.hidden || this.hideRecord(k)?.mode !== info.mode) n++;
        b.hidden = true;
        this.edits.hidden.add(k);
        this.edits.hideInfo.set(k, { ...info });
        const fp = this.footprintOf(b);
        if (fp) this.edits.footprints.set(k, fp);
      } else {
        if (b.hidden) n++;
        b.hidden = false;
      }
    }
    if (!hidden)
      for (const k of ks) {
        this.edits.hidden.delete(k);
        this.edits.hideInfo.delete(k);
        if (!this.edits.heights.has(k)) this.edits.footprints.delete(k);
      }
    this.buildNeighbors();
    return n;
  }

  /** 隠した建物の隠し方を変える（理由はそのまま）。戻り値: 変えた建物の数 */
  setHideMode(keys: Iterable<string>, mode: HideMode): number {
    let n = 0;
    for (const k of new Set(keys)) {
      const r = this.hideRecord(k);
      if (!r || r.mode === mode) continue;
      this.edits.hideInfo.set(k, { ...r, mode });
      n += this.state.neighbors.filter((b) => b.hidden && this.keyOf(b) === k).length;
    }
    if (n) this.buildNeighbors();
    return n;
  }

  /** 隠した建物をすべて戻す（今の一覧に無い建物の記録も消す）。戻り値: 戻した建物の数（今の一覧の中） */
  restoreAll(): number {
    const n = this.hiddenList().length;
    for (const k of this.edits.hidden) if (!this.edits.heights.has(k)) this.edits.footprints.delete(k);
    this.edits.hidden.clear();
    this.edits.hideInfo.clear();
    for (const b of this.state.neighbors) b.hidden = false;
    this.buildNeighbors();
    return n;
  }

  /** 建物の高さを直す（null で元のデータの高さに戻す）。取り直しの後も同じ建物に当て直す */
  setHeight(key: string, height: number | null) {
    const b = this.findByKey(key);
    if (height == null) {
      this.edits.heights.delete(key);
      if (!this.edits.hidden.has(key)) this.edits.footprints.delete(key);
    } else {
      this.edits.heights.set(key, height);
      const fp = b ? this.footprintOf(b) : null;
      if (fp) this.edits.footprints.set(key, fp);
    }
    this.buildNeighbors();
  }

  /** 隠した建物をすべて薄く表示するか（「建物を選んで隠す」の間だけ） */
  setGhosts(on: boolean) {
    this.ghostsOn = on;
    this.applyGhosts();
  }

  /** 隠した建物のうち key だけを薄く（選択色で）表示する（null で消す） */
  setPreview(key: string | null) {
    if (this.previewKey === key) return;
    this.previewKey = key;
    this.applyGhosts();
  }

  /** 選んだ建物をオレンジで表示する（実体・薄い表示の両方。作り直さずにマテリアルだけ替える） */
  setHighlight(keys: Iterable<string>) {
    this.highlightKeys = new Set(keys);
    this.applyGhosts();
  }

  private materials() {
    if (!this.mats) {
      const ghost = new THREE.MeshStandardMaterial({ color: '#b9c0c8', roughness: 0.9, transparent: true, opacity: GHOST_OPACITY, depthWrite: false });
      // 表示だけ隠した建物（影・解析には残る）は青みの薄い表示で、計算から除外した建物（灰色）と見分ける
      const ghostView = new THREE.MeshStandardMaterial({ color: GHOST_VIEW_COLOR, roughness: 0.9, transparent: true, opacity: GHOST_OPACITY, depthWrite: false });
      const ghostSel = new THREE.MeshStandardMaterial({ color: NEIGHBOR_SELECT_COLOR, roughness: 0.9, transparent: true, opacity: 0.45, depthWrite: false });
      const sel = new THREE.MeshStandardMaterial({ color: NEIGHBOR_SELECT_COLOR, emissive: NEIGHBOR_SELECT_COLOR, emissiveIntensity: 0.25, roughness: 0.85 });
      // 影だけのメッシュ: 色も奥行きも書かない（画面には何も描かれない）。three.js は castShadow の可視メッシュを
      // マテリアルの colorWrite によらず影の地図に描くので、実時間の影は落ちる
      const shadowOnly = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
      // 薄い面だけでは航空写真の上で見分けにくいので、輪郭の線を添える（線は影・解析に入らない）
      const edge = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, toneMapped: false });
      const edgeSel = new THREE.LineBasicMaterial({ color: NEIGHBOR_SELECT_COLOR, toneMapped: false });
      this.mats = { ghost, ghostView, ghostSel, sel, shadowOnly, edge, edgeSel };
    }
    return this.mats;
  }

  /** 薄い表示の見え方・選択色を今の設定に合わせる */
  private applyGhosts() {
    const m = this.materials();
    for (const o of this.neighborsG.children) {
      const mesh = o as THREE.Mesh;
      const base = mesh.userData.baseMaterial as THREE.Material[] | undefined;
      if (!base) continue;
      mesh.material = this.highlightKeys.has(mesh.userData.neighborKey as string) ? [m.sel, m.sel] : base;
    }
    for (const o of this.ghostsG.children) {
      const mesh = o as THREE.Mesh;
      const k = mesh.userData.neighborKey as string;
      const pv = k === this.previewKey;
      const on = this.highlightKeys.has(k) || pv;
      mesh.visible = this.ghostsOn || pv;
      mesh.material = on ? m.ghostSel : mesh.userData.hideMode === 'view' ? m.ghostView : m.ghost;
      for (const c of mesh.children) if ((c as THREE.LineSegments).isLineSegments) (c as THREE.LineSegments).material = on ? m.edgeSel : m.edge;
    }
    this.ghostsG.visible = this.state.showNeighbors;
    this.viewer.invalidate();
  }

  /**
   * 範囲選択の対象: 見えている建物（隠した建物は薄く表示している間だけ）の中心（外形の重心・高さの半分）のワールド座標
   */
  selectableCentroids(): { key: string; hidden: boolean; world: THREE.Vector3 }[] {
    if (!this.state.showNeighbors) return [];
    const out: { key: string; hidden: boolean; world: THREE.Vector3 }[] = [];
    for (const b of this.state.neighbors) {
      const key = this.keyOf(b);
      if (b.hidden && !this.ghostsOn) continue;
      const c = ringCentroid(b.ring);
      out.push({ key, hidden: !!b.hidden, world: this.toWorld(c.e, c.n, this.heightOf(b) / 2) });
    }
    return out;
  }

  /**
   * 画面の点（NDC）にある周辺建物。手前の建物（PDF の建物・屋根・3DS など blockers）に当たればそれを優先して null。
   * 隠した建物は薄く表示している間だけ拾う。メッシュに当たらなければ、地面（y = 0）の点を含む外形で拾う
   */
  pickNeighbor(ndc: THREE.Vector2, blockers: THREE.Object3D[] = []): { key: string; hidden: boolean } | null {
    if (!this.state.showNeighbors) return null;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.viewer.camera);
    const shown = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
      return true;
    };
    const hits = rc.intersectObjects([this.neighborsG, this.ghostsG, ...blockers], true);
    // 影だけのメッシュ（表示だけ隠した建物）は画面に見えないので拾わない（薄い表示のほうで拾う）
    const hit = hits.find((x) => (x.object as THREE.Mesh).isMesh && !x.object.userData.shadowOnly && shown(x.object));
    if (hit) {
      const key = hit.object.userData.neighborKey as string | undefined;
      return key ? { key, hidden: !!hit.object.userData.ghost } : null;
    }
    const g = rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (!g) return null;
    const items = this.state.neighbors.filter((b) => !b.hidden || this.ghostsOn || this.keyOf(b) === this.previewKey).map((b) => ({ key: this.keyOf(b), ring: b.ring }));
    const key = pickRingAt(items, this.fromWorld(g));
    return key ? { key, hidden: !!this.findByKey(key)?.hidden } : null;
  }

  /** 東・北 (m) → ワールド */
  toWorld(e: number, n: number, y = 0): THREE.Vector3 {
    const st = this.viewer.state!;
    const c = st.meta.bbox.getCenter(new THREE.Vector3());
    const a = (st.model.northAngleDeg * Math.PI) / 180;
    const north = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
    const east = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    return new THREE.Vector3(c.x, y, c.z).addScaledVector(east, e).addScaledVector(north, n);
  }

  /** ワールド座標 → 建物中心からの東・北 (m) */
  fromWorld(p: THREE.Vector3): { e: number; n: number } {
    const st = this.viewer.state!;
    const c = st.meta.bbox.getCenter(new THREE.Vector3());
    const a = (st.model.northAngleDeg * Math.PI) / 180;
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    return { e: dx * Math.cos(a) + dz * Math.sin(a), n: dx * Math.sin(a) - dz * Math.cos(a) };
  }

  /** 画面上の点が航空写真のどこか（航空写真が無ければ null） */
  pickAerial(ndc: THREE.Vector2): THREE.Vector3 | null {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.viewer.camera);
    const hit = rc.intersectObjects(this.aerial.children, true)[0];
    return hit ? hit.point : null;
  }

  get center() {
    return this.viewer.state!.meta.bbox.getCenter(new THREE.Vector3()).setY(0);
  }

  async loadAerial(kind: 'photo' | 'map' = 'photo') {
    const { lat, lon } = siteLatLon(this.state.site);
    const img = await fetchAerial(lat, lon, 220, kind === 'photo' ? 18 : 17, kind);
    clearGroup(this.aerial);
    const tex = new THREE.CanvasTexture(img.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const geo = new THREE.BufferGeometry();
    const nw = this.toWorld(img.west, img.north, -0.03);
    const ne = this.toWorld(img.east, img.north, -0.03);
    const se = this.toWorld(img.east, img.south, -0.03);
    const sw = this.toWorld(img.west, img.south, -0.03);
    geo.setAttribute('position', new THREE.Float32BufferAttribute([...sw.toArray(), ...se.toArray(), ...ne.toArray(), ...sw.toArray(), ...ne.toArray(), ...nw.toArray()], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
    geo.computeVertexNormals();
    // 法線を上向きに
    const n = geo.getAttribute('normal');
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    mesh.name = 'aerial';
    this.aerial.add(mesh);
    this.state.aerialLoaded = true;
    this.aerialInfo = { west: img.west, east: img.east, south: img.south, north: img.north, tex };
    this.buildNeighbors();
    this.applyVisibility();
    return img.attribution;
  }

  async loadNeighbors(source: 'gsi' | 'osm' = 'gsi') {
    const { lat, lon } = siteLatLon(this.state.site);
    // 国土地理院で取れなければ OpenStreetMap で取り直す（逆も同様）
    const fetchFrom = (src: 'gsi' | 'osm') => (src === 'gsi' ? fetchGsiBuildings(lat, lon, 110) : fetchOsmBuildings(lat, lon, 110));
    let list: NeighborBuilding[] = [];
    let err: Error | null = null;
    for (const src of source === 'gsi' ? (['gsi', 'osm'] as const) : (['osm', 'gsi'] as const)) {
      try {
        list = await fetchFrom(src);
        if (list.length) break;
      } catch (e) {
        err = e as Error;
      }
    }
    if (!list.length && err) throw err;
    // 自分の敷地・新築の建物に重なる建物（建て替え前の既存建物など）は除外
    const st = this.viewer.state!;
    const site = st.site;
    const bb = st.meta.bbox;
    const inSite = (b: NeighborBuilding) => {
      const ws = b.ring.map((p) => this.toWorld(p.e, p.n));
      if (ws.some((w) => w.x > site.min.x - 0.5 && w.x < site.max.x + 0.5 && w.z > site.min.y - 0.5 && w.z < site.max.y + 0.5)) return true;
      const x0 = Math.min(...ws.map((w) => w.x));
      const x1 = Math.max(...ws.map((w) => w.x));
      const z0 = Math.min(...ws.map((w) => w.z));
      const z1 = Math.max(...ws.map((w) => w.z));
      return x1 > bb.min.x - 0.8 && x0 < bb.max.x + 0.8 && z1 > bb.min.z - 0.8 && z0 < bb.max.z + 0.8;
    };
    const manual = this.state.neighbors.filter((b) => b.source === 'manual');
    const fresh = list.filter((b) => !inSite(b));
    for (const b of fresh) b.id = `${b.source}-${++this.seq}`;
    // 外形は取得したときのピンから測っている（キー・照合はここから地点によらない座標に直す）
    this.neighborsOrigin = { lat, lon };
    this.state.neighbors = [...manual, ...fresh];
    // 隠した建物・直した高さを、取り直した一覧の同じ建物に当て直す
    reapplyEdits(this.state.neighbors, (b) => this.keyOf(b), (b) => this.footprintOf(b), this.edits);
    this.buildNeighbors();
    return fresh.length;
  }

  /** 手動で隣家を追加（方向・距離・大きさ） */
  addManualNeighbor(dirDeg: number, distance: number, width = 8, depth = 8, height = 7) {
    const a = (dirDeg * Math.PI) / 180;
    const ce = Math.sin(a) * distance;
    const cn = Math.cos(a) * distance;
    const hw = width / 2;
    const hd = depth / 2;
    this.state.neighbors.push({
      ring: [
        { e: ce - hw, n: cn - hd },
        { e: ce + hw, n: cn - hd },
        { e: ce + hw, n: cn + hd },
        { e: ce - hw, n: cn + hd },
      ],
      height,
      source: 'manual',
      label: '隣家',
      id: `manual-${++this.seq}`,
    });
    this.buildNeighbors();
  }

  /** 周辺建物をすべて消す（隠す・高さの記録も消す） */
  clearNeighbors() {
    this.state.neighbors = [];
    this.edits.hidden.clear();
    this.edits.hideInfo.clear();
    this.edits.heights.clear();
    this.edits.footprints.clear();
    this.highlightKeys.clear();
    this.previewKey = null;
    this.buildNeighbors();
  }

  /**
   * 周辺建物のメッシュを作り直す。隠した建物（b.hidden）は見える実体を作らない。
   *  - 計算から除外: 影・部屋の日当たり・日照時間マップの遮蔽物にも入らない（メッシュを作らない）
   *  - 表示だけ隠す: 影だけのメッシュ（neighborsG・userData.neighbor・userData.shadowOnly・castShadow・colorWrite/depthWrite なし・
   *    receiveShadow なし）を作る。画面には描かれないが、実時間の影を落とし、buildOccluder（userData.neighbor）にも入る
   * どちらも薄い表示（ghostsG）を作り、「建物を選んで隠す」の間だけ見せる: 不透明度 GHOST_OPACITY・depthWrite なし・
   * castShadow なし・userData.noShadow（bakeWorldTriangles が除く）・userData.neighbor なし（buildOccluder の対象外）
   */
  buildNeighbors() {
    clearGroup(this.neighborsG);
    // 薄い表示の輪郭の線（メッシュの子）は clearGroup が捨てないので、ここで捨てる
    this.ghostsG.traverse((o) => {
      if ((o as THREE.LineSegments).isLineSegments) (o as THREE.LineSegments).geometry.dispose();
    });
    clearGroup(this.ghostsG);
    const mats = this.materials();
    const wallMat = new THREE.MeshStandardMaterial({ color: '#e8e6e1', roughness: 0.9 });
    // 航空写真があれば屋上に貼る（Google Earth のような見え方）
    const ai = this.aerialInfo;
    const roofMat = ai ? new THREE.MeshStandardMaterial({ map: ai.tex, roughness: 0.85 }) : new THREE.MeshStandardMaterial({ color: '#8d8f93', roughness: 0.8 });
    const st = this.viewer.state!;
    const c0 = st.meta.bbox.getCenter(new THREE.Vector3());
    const a0 = (st.model.northAngleDeg * Math.PI) / 180;
    const northV = new THREE.Vector3(Math.sin(a0), 0, -Math.cos(a0));
    const eastV = new THREE.Vector3(Math.cos(a0), 0, Math.sin(a0));
    const manualMat = new THREE.MeshStandardMaterial({ color: '#d9c7a8', roughness: 0.9 });
    for (const b of this.state.neighbors) {
      const key = this.keyOf(b);
      const pts = b.ring.map((p) => this.toWorld(p.e, p.n));
      // ワールド XZ で Shape を作り、上方向へ押し出す
      const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.z)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: this.heightOf(b), bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      if (b.hidden) {
        const mode = this.hideModeOf(b) ?? LEGACY_HIDE_RECORD.mode;
        if (mode === 'view') {
          const shadow = new THREE.Mesh(geo.clone(), mats.shadowOnly);
          shadow.castShadow = true;
          shadow.receiveShadow = false;
          shadow.userData.neighbor = true;
          shadow.userData.shadowOnly = true;
          shadow.userData.neighborKey = key;
          shadow.userData.neighborId = b.id;
          this.neighborsG.add(shadow);
        }
        const ghost = new THREE.Mesh(geo, mode === 'view' ? mats.ghostView : mats.ghost);
        ghost.castShadow = false;
        ghost.receiveShadow = false;
        ghost.renderOrder = 5;
        ghost.userData.noShadow = true;
        ghost.userData.ghost = true;
        ghost.userData.hideMode = mode;
        ghost.userData.neighborKey = key;
        ghost.userData.neighborId = b.id;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), mats.edge);
        edges.castShadow = false;
        edges.userData.noShadow = true;
        edges.renderOrder = 6;
        ghost.add(edges);
        this.ghostsG.add(ghost);
        continue;
      }
      if (ai) {
        // 屋根面（上向き）の UV を航空写真の座標に
        const pos = geo.getAttribute('position');
        const nor = geo.getAttribute('normal');
        const uv = geo.getAttribute('uv');
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          if (nor.getY(i) < 0.9) continue;
          v.fromBufferAttribute(pos, i).sub(c0);
          const e = v.dot(eastV);
          const n = v.dot(northV);
          uv.setXY(i, (e - ai.west) / (ai.east - ai.west), (n - ai.south) / (ai.north - ai.south));
        }
        uv.needsUpdate = true;
      }
      // ExtrudeGeometry のグループ: 0 = 上下面, 1 = 側面
      const base = [roofMat, b.source === 'manual' ? manualMat : wallMat];
      const mesh = new THREE.Mesh(geo, base);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.neighbor = true;
      mesh.userData.neighborKey = key;
      mesh.userData.neighborId = b.id;
      mesh.userData.baseMaterial = base;
      mesh.userData.matKey = undefined;
      this.neighborsG.add(mesh);
    }
    // 選択色・薄い表示の見え方を当て直す（今の一覧に無いキーの選択は消す）
    const present = new Set(this.state.neighbors.map((b) => this.keyOf(b)));
    for (const k of [...this.highlightKeys]) if (!present.has(k)) this.highlightKeys.delete(k);
    if (this.previewKey && !present.has(this.previewKey)) this.previewKey = null;
    this.applyGhosts();
    this.applyVisibility();
    this.viewer.invalidate();
    this.onNeighborsChange?.();
  }

  applyVisibility() {
    this.aerial.visible = this.state.showAerial && this.state.aerialLoaded;
    this.neighborsG.visible = this.state.showNeighbors;
    this.ghostsG.visible = this.state.showNeighbors;
    this.pathG.visible = this.state.showSunPath;
    // 航空写真表示中は生成した道路・遠景の地面を隠す
    this.viewer.groups.landscape.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.userData.matKey === 'l.far' || m.userData.matKey === 'l.road' || m.userData.matKey === 'l.curb')) m.visible = !this.aerial.visible;
    });
    this.viewer.invalidate();
  }

  /** 太陽軌道（冬至・春秋分・夏至）と方位 */
  buildSunPath(radius = 22) {
    clearGroup(this.pathG);
    const st = this.viewer.state!;
    const { lat, lon } = siteLatLon(this.state.site);
    const center = this.center;
    const colors: Record<string, string> = { winter: '#4ea3ff', spring: '#6ccf7a', summer: '#ffa53b' };
    for (const d of keyDates(this.year)) {
      if (d.id === 'autumn') continue;
      const pts: THREE.Vector3[] = [];
      const rs = sunriseSunset(d.year, d.month, d.day, lat, lon);
      for (let h = rs.sunrise; h <= rs.sunset; h += 1 / 12) {
        const sp = sunPosition(localDate(d.year, d.month, d.day, h), lat, lon);
        if (sp.elevation < -0.5) continue;
        pts.push(center.clone().addScaledVector(sunDirectionWorld(sp.azimuth, Math.max(0, sp.elevation), st.model.northAngleDeg), radius));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: colors[d.id], linewidth: 2, toneMapped: false, depthTest: true }));
      this.pathG.add(line);
      // 時刻の目盛り
      for (let h = Math.ceil(rs.sunrise); h <= Math.floor(rs.sunset); h++) {
        const sp = sunPosition(localDate(d.year, d.month, d.day, h), lat, lon);
        if (sp.elevation < 0) continue;
        const p = center.clone().addScaledVector(sunDirectionWorld(sp.azimuth, sp.elevation, st.model.northAngleDeg), radius);
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), new THREE.MeshBasicMaterial({ color: colors[d.id], toneMapped: false }));
        dot.position.copy(p);
        this.pathG.add(dot);
        if (d.id === 'winter' ? h % 2 === 0 : h % 3 === 0) {
          const label = textSprite(`${h}時`, { size: 40, color: '#fff', bg: 'rgba(0,0,0,0.45)', scale: 0.9 });
          label.position.copy(p).add(new THREE.Vector3(0, 0.7, 0));
          this.pathG.add(label);
        }
      }
      // 日付ラベル（南中付近）
      const noon = sunPosition(localDate(d.year, d.month, d.day, rs.noon), lat, lon);
      const lp = center.clone().addScaledVector(sunDirectionWorld(noon.azimuth, noon.elevation, st.model.northAngleDeg), radius + 2.5);
      const lab = textSprite(d.label, { size: 44, color: '#fff', bg: colors[d.id], scale: 1.3 });
      lab.position.copy(lp);
      this.pathG.add(lab);
    }
    // 方位リング
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.12, radius + 0.12, 128), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, side: THREE.DoubleSide, toneMapped: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(center).setY(0.05);
    this.pathG.add(ring);
    const dirs: [string, number][] = [
      ['北', 0],
      ['東', 90],
      ['南', 180],
      ['西', 270],
    ];
    for (const [label, az] of dirs) {
      const d = sunDirectionWorld(az, 0, st.model.northAngleDeg);
      const s = textSprite(label, { size: 56, color: '#fff', bg: label === '北' ? '#d9534f' : 'rgba(0,0,0,0.55)', scale: 1.6 });
      s.position.copy(center).addScaledVector(d, radius + 1.8).setY(0.9);
      this.pathG.add(s);
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.02, 1.4), new THREE.MeshBasicMaterial({ color: '#fff', toneMapped: false }));
      tick.position.copy(center).addScaledVector(d, radius).setY(0.06);
      tick.lookAt(center.clone().setY(0.06));
      this.pathG.add(tick);
    }
    this.applyVisibility();
  }

  /** 現在の太陽位置マーカー */
  updateSunMarker(dir: THREE.Vector3, radius = 22) {
    clearGroup(this.sunMarker);
    if (dir.y <= 0) return;
    const p = this.center.addScaledVector(dir, radius);
    const sun = new THREE.Mesh(new THREE.SphereGeometry(0.7, 20, 14), new THREE.MeshBasicMaterial({ color: '#fff1b0', toneMapped: false }));
    sun.position.copy(p);
    this.sunMarker.add(sun);
    const glow = textSprite('☀', { size: 90, color: '#ffd24a', scale: 3 });
    glow.position.copy(p);
    this.sunMarker.add(glow);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([this.center.setY(0.1), p]);
    this.sunMarker.add(new THREE.Line(lineGeo, new THREE.LineDashedMaterial({ color: '#ffd24a', dashSize: 0.6, gapSize: 0.4, toneMapped: false })));
    (this.sunMarker.children[2] as THREE.Line).computeLineDistances();
    this.sunMarker.visible = this.state.showSunPath;
    this.viewer.invalidate();
  }
}
