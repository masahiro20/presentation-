/**
 * Google の実写 3D（Photorealistic 3D Tiles。Google Earth と同じ写真測量の街並み）を、日照シミュレーションの周辺環境として敷く。
 *
 * - 取得: Map Tiles API（https://tile.googleapis.com/v1/3dtiles/root.json?key=…）。キーは日照ステップの「Google Maps API キー」欄
 *   （Google Cloud で Map Tiles API を有効にしたキー）。読み込みは 3d-tiles-renderer（タイルの選択・セッション・Draco の復号）。
 * - 座標: タイルは地球中心の座標（ECEF）。敷地のピン（緯度・経度）での東・北・上の座標系に直し、日照ステップの東・北 → ワールド
 *   （SunContext.toWorld と同じ: 建物の中心が原点、東・北は真北の角度で回す）へ置く。地面の高さは敷地の周りの路面を下向きに探って 0 に合わせる。
 * - 敷地: 計画する家と重なる既存の建物・樹木は、敷地の範囲を地面の高さに押しつぶして消す（TileFlatteningPlugin）。
 * - 影: 実写の建物・樹木は影を落とす（太陽の位置どおり）。実写の面は写真の明暗を持つので、影は受けない（二重に暗くならないように）。
 * - 表示の決まり: Google のロゴと、表示中のタイルの著作権表記を画面に出す（GoogleCloudAuthPlugin の getAttributions）。
 *   タイルを保存・書き出し・解析用の形状に変換することは利用規約で認められていないので、ここでは表示と影だけに使う。
 */
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin, GLTFExtensionsPlugin, TileFlatteningPlugin, TileCompressionPlugin, UnloadTilesPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

export const GOOGLE_3D_ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';

/** 敷地の東・北 → ワールドの置き方（SunContext.toWorld と同じ） */
export interface EarthFrame {
  lat: number;
  lon: number;
  /** 敷地のピン（東・北 = 0）のワールド座標（地面 y=0） */
  origin: THREE.Vector3;
  /** ワールドでの東・北の向き（単位ベクトル、水平） */
  east: THREE.Vector3;
  north: THREE.Vector3;
}

export type EarthStatus = { kind: 'idle' } | { kind: 'checking' } | { kind: 'loading'; tiles: number } | { kind: 'ready'; tiles: number } | { kind: 'error'; message: string };

/**
 * キーで root.json を 1 回取って、使えるかを確かめる（Map Tiles API が無効・請求先が無い・キーの制限 などの理由をそのまま返す）
 */
export async function checkGoogle3dKey(key: string, fetchFn: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!key.trim()) return { ok: false, message: 'Google Maps API キーが入っていません（日照ステップの「敷地」の欄に入れてください）' };
  try {
    const res = await fetchFn(`${GOOGLE_3D_ROOT}?key=${encodeURIComponent(key.trim())}`);
    if (res.ok) return { ok: true };
    let detail = '';
    try {
      const js = (await res.json()) as { error?: { message?: string; status?: string } };
      detail = js.error?.message ?? js.error?.status ?? '';
    } catch {
      detail = '';
    }
    return { ok: false, message: googleErrorText(res.status, detail) };
  } catch (e) {
    return { ok: false, message: `Google のサーバーに接続できませんでした（${(e as Error).message}）` };
  }
}

/** Google の応答を、直し方の分かる日本語に */
export function googleErrorText(status: number, detail: string): string {
  if (/not been used|is disabled|SERVICE_DISABLED|API_KEY_SERVICE_BLOCKED|not authorized to use this API/i.test(detail))
    return `このキーでは Map Tiles API が使えません。Google Cloud コンソールで「Map Tiles API」を有効にし、キーの「API の制限」に Map Tiles API を入れてください（${detail}）`;
  if (/billing/i.test(detail)) return `Google Cloud の請求先アカウントが設定されていません（Map Tiles API は請求先の登録が必要です）。${detail}`;
  if (/referer|referrer|RefererNotAllowed/i.test(detail)) return `キーの「ウェブサイトの制限」にこのサイトの URL が入っていません（${detail}）`;
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(detail)) return `API キーが正しくありません（${detail}）`;
  if (status === 429) return `利用の上限に達しました（しばらく待つか、Google Cloud の割り当てを確認してください）。${detail}`;
  return `Google 実写 3D を読み込めませんでした（${status}${detail ? `: ${detail}` : ''}）`;
}

/** 敷地を押しつぶすときの余白 (m)。境界の塀・植栽の取り残しを減らす */
const SITE_MARGIN = 0.6;
/** 読み込む範囲の半径 (m)。これより遠いタイルは粗いまま（地平線まで細かく読むと重い） */
const DETAIL_RADIUS = 260;

export class GoogleEarthLayer {
  /** ワールドに置く入れ物（行列で ECEF → 敷地の東北上 → ワールドに変換） */
  readonly group = new THREE.Group();
  private tiles: TilesRenderer | null = null;
  private auth: GoogleCloudAuthPlugin | null = null;
  private flatten: TileFlatteningPlugin | null = null;
  private shape: THREE.Mesh | null = null;
  private frame: EarthFrame | null = null;
  /** ECEF → ワールド（地面合わせ前） */
  private baseMatrix = new THREE.Matrix4();
  private groundY = 0;
  private groundFixed = false;
  /** 地面合わせの回数（最初は粗いタイルで測るので、細かいタイルが届いたら 3 回まで測り直す） */
  private groundFits = 0;
  private draco: DRACOLoader | null = null;
  status: EarthStatus = { kind: 'idle' };
  onStatus: ((s: EarthStatus) => void) | null = null;
  /** 描き直しが要るとき（タイルが届いた・地面を合わせた） */
  onChange: (() => void) | null = null;
  /** 影を落とすか */
  castShadow = true;

  constructor() {
    this.group.name = 'google-earth';
    this.group.matrixAutoUpdate = false;
  }

  private setStatus(s: EarthStatus) {
    this.status = s;
    this.onStatus?.(s);
  }

  get active(): boolean {
    return !!this.tiles;
  }

  /**
   * 読み込みを始める。sitePoly = 敷地（または計画する家の外形を少し広げたもの）の東・北 (m)。その中の既存の建物は地面に押しつぶす
   */
  async start(key: string, frame: EarthFrame, sitePoly: { e: number; n: number }[] | null, opts: { url?: string } = {}) {
    this.stop();
    this.setStatus({ kind: 'checking' });
    // opts.url: Google 以外の 3D Tiles（地球中心の座標のもの。検証用に PLATEAU など）を同じ経路で敷く
    if (!opts.url) {
      const chk = await checkGoogle3dKey(key);
      if (!chk.ok) {
        this.setStatus({ kind: 'error', message: chk.message });
        return;
      }
    }
    this.frame = frame;
    const tiles = new TilesRenderer(opts.url ?? GOOGLE_3D_ROOT);
    if (!opts.url) {
      this.auth = new GoogleCloudAuthPlugin({ apiToken: key.trim(), autoRefreshToken: true, useRecommendedSettings: true });
      tiles.registerPlugin(this.auth);
    }
    this.draco = new DRACOLoader().setWorkerLimit(2);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: this.draco }));
    tiles.registerPlugin(new TileCompressionPlugin());
    tiles.registerPlugin(new UnloadTilesPlugin());
    this.flatten = new TileFlatteningPlugin();
    tiles.registerPlugin(this.flatten);
    // 住宅の日照には敷地の周り数百 m が見えれば十分。細かさは画面上の誤差 12px まで（推奨設定の 20 より細かく）
    tiles.errorTarget = 12;
    tiles.addEventListener('load-model', ({ scene }: { scene: THREE.Object3D }) => {
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = this.castShadow;
        m.receiveShadow = false;
        m.userData.googleEarth = true;
        // 霧で遠くを溶かす（ビューアの霧に合わせる）。写真は照明を持つので明るさはそのまま（MeshBasicMaterial）
        const mat = m.material as THREE.Material & { fog?: boolean };
        if (mat) mat.fog = true;
      });
      this.onChange?.();
    });
    tiles.addEventListener('load-error', (e: { error?: Error; url?: string }) => {
      console.warn('Google 3D Tiles load error', e.error?.message, e.url);
    });
    tiles.addEventListener('tiles-load-end', () => {
      this.fitGround();
      this.setStatus({ kind: 'ready', tiles: tiles.visibleTiles.size });
      this.onChange?.();
    });
    this.tiles = tiles;
    this.group.add(tiles.group);
    this.computeBaseMatrix();
    this.applyMatrix();
    if (sitePoly && sitePoly.length >= 3) this.setSite(sitePoly);
    this.setStatus({ kind: 'loading', tiles: 0 });
  }

  /** 敷地の位置・向きが変わったとき（微調整・建設地の変更）に置き直す。地面の高さは測り直す */
  setFrame(frame: EarthFrame) {
    const f = this.frame;
    if (f && Math.abs(f.lat - frame.lat) < 1e-9 && Math.abs(f.lon - frame.lon) < 1e-9 && f.origin.distanceTo(frame.origin) < 1e-6 && f.east.distanceTo(frame.east) < 1e-9) return;
    this.frame = frame;
    if (!this.tiles) return;
    const latLonMoved = !f || Math.abs(f.lat - frame.lat) > 1e-7 || Math.abs(f.lon - frame.lon) > 1e-7;
    if (latLonMoved) {
      this.groundY = 0;
      this.groundFixed = false;
      this.groundFits = 0;
    }
    this.computeBaseMatrix();
    this.applyMatrix();
    if (latLonMoved) this.fitGround();
    if (this.shapePoly) this.setSite(this.shapePoly);
    this.onChange?.();
  }

  /** ECEF → 敷地の東北上（ピン、楕円体高 0）→ ワールド */
  private computeBaseMatrix() {
    const f = this.frame!;
    const tiles = this.tiles!;
    const enu = tiles.ellipsoid.getEastNorthUpFrame(THREE.MathUtils.degToRad(f.lat), THREE.MathUtils.degToRad(f.lon), 0, new THREE.Matrix4());
    const toEnu = enu.clone().invert();
    // 東北上 (x=東, y=北, z=上) → ワールド: 列 = east, north, up、平行移動 = ピンのワールド位置
    const w = new THREE.Matrix4().makeBasis(f.east, f.north, new THREE.Vector3(0, 1, 0)).setPosition(f.origin);
    this.baseMatrix.multiplyMatrices(w, toEnu);
  }

  private applyMatrix() {
    const m = new THREE.Matrix4().makeTranslation(0, -this.groundY, 0).multiply(this.baseMatrix);
    this.group.matrix.copy(m);
    this.group.matrixWorldNeedsUpdate = true;
    this.group.updateMatrixWorld(true);
  }

  /**
   * 地面の高さを合わせる: 敷地のピンの周り（半径 12〜45 m の輪の上 48 点）から下向きに探り、当たった高さの下から 15% を路面とする
   * （屋根・樹木に当たった点は高いので外れる）。合わせるのは最初の 1 回だけ（タイルが細かくなるたびに地面が動かないように）
   */
  private fitGround() {
    if (this.groundFixed || !this.tiles || !this.frame) return;
    this.groundFits++;
    const f = this.frame;
    const rc = new THREE.Raycaster();
    const hs: number[] = [];
    this.group.updateMatrixWorld(true);
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const r = 12 + (i % 4) * 11;
      const p = f.origin.clone().addScaledVector(f.east, Math.cos(a) * r).addScaledVector(f.north, Math.sin(a) * r);
      rc.set(p.setY(this.groundY + 2000), new THREE.Vector3(0, -1, 0));
      rc.far = 6000;
      const hit = rc.intersectObject(this.tiles.group, true)[0];
      if (hit) hs.push(hit.point.y);
    }
    if (hs.length < 12) return;
    hs.sort((x, y) => x - y);
    const ground = hs[Math.floor(hs.length * 0.15)];
    this.groundY += ground;
    this.groundFixed = this.groundFits >= 3 || Math.abs(ground) < 0.3;
    this.applyMatrix();
    if (this.shapePoly) this.setSite(this.shapePoly);
  }

  private shapePoly: { e: number; n: number }[] | null = null;

  /** 敷地の範囲（東・北 m）の既存の建物・樹木を地面の高さに押しつぶす */
  setSite(poly: { e: number; n: number }[]) {
    this.shapePoly = poly;
    if (!this.tiles || !this.flatten || !this.frame) return;
    if (this.shape) {
      this.flatten.deleteShape(this.shape);
      this.shape.geometry.dispose();
      this.shape = null;
    }
    // 外形を少し広げた多角形（重心から外へ）
    const cx = poly.reduce((s, p) => s + p.e, 0) / poly.length;
    const cy = poly.reduce((s, p) => s + p.n, 0) / poly.length;
    const grown = poly.map((p) => {
      const dx = p.e - cx;
      const dy = p.n - cy;
      const d = Math.hypot(dx, dy) || 1;
      return { e: p.e + (dx / d) * SITE_MARGIN, n: p.n + (dy / d) * SITE_MARGIN };
    });
    const f = this.frame;
    // ワールド（地面 y=0）の多角形 → タイルの座標（ECEF）
    const inv = this.group.matrix.clone().invert();
    const shape = new THREE.Shape(grown.map((p) => new THREE.Vector2(p.e, p.n)));
    const geo = new THREE.ShapeGeometry(shape);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const w = f.origin.clone().addScaledVector(f.east, pos.getX(i)).addScaledVector(f.north, pos.getY(i)).setY(0.02);
      w.applyMatrix4(inv);
      pos.setXYZ(i, w.x, w.y, w.z);
    }
    pos.needsUpdate = true;
    geo.computeBoundingSphere();
    this.shape = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    // 押しつぶす向き = 敷地での「上」（ECEF の単位ベクトル）
    const up = new THREE.Vector3(0, 1, 0).transformDirection(inv).normalize();
    // 型定義は古い署名（threshold: number）だが、実装は options オブジェクトを受ける
    (this.flatten.addShape as unknown as (m: THREE.Mesh, d: THREE.Vector3, o: { threshold: number }) => void)(this.shape, up, { threshold: Infinity });
  }

  /** 毎コマ: カメラに合わせてタイルを選び直す。読み込み中は描き直しを続ける（true を返す） */
  update(camera: THREE.Camera, renderer: THREE.WebGLRenderer): boolean {
    const tiles = this.tiles;
    if (!tiles) return false;
    if (!tiles.hasCamera(camera)) tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    // 遠くのタイルは粗く: カメラが敷地から離れるほど誤差の許容を広げる
    const f = this.frame;
    if (f) {
      const d = camera.position.distanceTo(f.origin);
      tiles.errorTarget = d > DETAIL_RADIUS ? 24 : 12;
    }
    tiles.update();
    // isLoading: ダウンロード・解析が残っている間 true（終わると tiles-load-end が出て false に戻る）
    const busy = (tiles as unknown as { isLoading: boolean }).isLoading;
    if (busy && this.status.kind === 'ready') this.setStatus({ kind: 'loading', tiles: tiles.visibleTiles.size });
    else if (!busy && this.status.kind === 'loading' && tiles.visibleTiles.size > 0) {
      this.fitGround();
      this.setStatus({ kind: 'ready', tiles: tiles.visibleTiles.size });
    }
    return busy;
  }

  /** 画面に出す帰属（Google のロゴ・著作権）。表示中のタイルが無ければ空 */
  attributions(): string {
    if (!this.tiles) return '';
    const list = this.tiles.getAttributions();
    return list
      .filter((a) => a.type === 'string')
      .map((a) => String(a.value))
      .filter(Boolean)
      .join(' ');
  }

  setShadow(on: boolean) {
    this.castShadow = on;
    this.tiles?.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = on;
    });
  }

  stop() {
    if (this.tiles) {
      this.group.remove(this.tiles.group);
      this.tiles.dispose();
    }
    this.draco?.dispose();
    this.draco = null;
    this.tiles = null;
    this.auth = null;
    this.flatten = null;
    this.shape?.geometry.dispose();
    this.shape = null;
    this.groundY = 0;
    this.groundFixed = false;
    this.groundFits = 0;
    this.setStatus({ kind: 'idle' });
  }
}
