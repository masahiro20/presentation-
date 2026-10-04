/**
 * 日照シミュレーション用の 3D シーン（地形・周辺建物・読み込んだ建物・太陽・影）
 *
 * ワールド座標: X=東, Z=南(-Z=北), Y=上 [m]。原点 = ピン位置、Y=0 = ピン位置の地盤高。
 * 既存 src/scene/viewer.ts の描画基盤（renderer / controls / 太陽光と影 / 空の環境光 / 後処理 / 撮影 / 視点移動）を
 * 建物固有の部分を持たない形で実装する。グループが空（モデル・地形がまだ無い）でも単体で動く。
 *
 * 影について:
 *  - 影を落とすのは castShadow=true の Mesh だけ（three の既定は false）。sunpath / overlay / markers に入れるものは
 *    castShadow を立てないこと（Group の castShadow は効かないので、作る側が各 Mesh で保証する）。
 *  - 影の範囲は fitShadow(center, radius) で指定した中心 ± radius。建物を動かしたら呼び直す。
 *  - 影のカメラの near/far・位置は太陽方向で決まるので setSunDirection のたびに再計算する（遠くの高い建物も落とす）。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { makeSkyTexture } from '../scene/sky';

export interface CameraView {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

/** 地形の取得半径 (m)。environment.ts の TERRAIN_RADIUS と同じ値（影のカメラの奥行きに使う） */
const TERRAIN_RADIUS_M = 260;
/** カメラを地面からこれ以上は離す (m) */
const CAMERA_GROUND_CLEARANCE = 1.2;

type RaycasterBVH = THREE.Raycaster & { firstHitOnly?: boolean };

export class StudyScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** shiftY は動画書き出し（recorder）との互換のため。常に 0 */
  readonly camera: THREE.PerspectiveCamera & { shiftY?: number };
  readonly controls: OrbitControls;
  readonly composer: EffectComposer;
  readonly sun = new THREE.DirectionalLight('#fff3e0', 3);
  readonly hemi = new THREE.HemisphereLight('#dbe8ff', '#6b6a5e', 0.35);
  readonly root = new THREE.Group();
  /**
   * 描画グループ:
   *  terrain   地形（航空写真を貼った面）。影を受ける・落とす
   *  neighbors 周辺建物（userData.neighborId を持つ Mesh）
   *  building  読み込んだ建物（PlacedModel.pivot）
   *  site      敷地の輪郭・ピン
   *  sunpath   太陽の通り道・方位リング・太陽マーカー（影を落とさない）
   *  overlay   解析結果（日照時間マップ・面の色分け）
   *  markers   測定点
   *  align     位置合わせ中の目印（①②の円盤と対応線。environment.ts は触らない。影を落とさない・解析から除く）
   */
  readonly groups = {
    terrain: new THREE.Group(),
    neighbors: new THREE.Group(),
    building: new THREE.Group(),
    site: new THREE.Group(),
    sunpath: new THREE.Group(),
    overlay: new THREE.Group(),
    markers: new THREE.Group(),
    align: new THREE.Group(),
  };
  sunDir = new THREE.Vector3(0.4, 0.7, 0.5).normalize();
  navMode: 'orbit' | 'pan' = 'orbit';
  userData: Record<string, unknown> = {};
  /** 描画後に呼ばれる（E2E・撮影用） */
  onAfterRender?: () => void;
  contextLost = false;

  /** 影の範囲（fitShadow で設定） */
  readonly shadowCenter = new THREE.Vector3(0, 0, 0);
  shadowRadius = 45;

  private _dirty = true;
  /** 場面（形・光・材料）が変わった: 影も描き直す。カメラだけの移動では影は描き直さない（重い） */
  private get dirty() {
    return this._dirty;
  }
  private set dirty(v: boolean) {
    this._dirty = v;
    if (v && this.renderer) this.renderer.shadowMap.needsUpdate = true;
  }
  /** 最後にカメラが動いた時刻（操作中は軽い描画にする） */
  private lastMove = 0;
  private hqPending = false;
  private renderMode: 'fast' | 'hq' = 'hq';
  private fastPR = 1;
  /** カメラが動いたので地面との干渉を見直す */
  private clampPending = true;
  private raf = 0;
  private paused = false;
  private skyTex: THREE.DataTexture | null = null;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private anim: { from: CameraView; to: CameraView; t0: number; dur: number } | null = null;
  private passes: { render: RenderPass; output: OutputPass; smaa: SMAAPass };
  private ro: ResizeObserver;
  private groundRay: RaycasterBVH = new THREE.Raycaster();
  private onWindowPointerUp: () => void;
  private onContextLost: () => void;
  private onContextRestored: () => void;

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // 影はカメラを動かしただけでは変わらないので、場面が変わったときだけ描き直す（dirty セッター）
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    // GPU がリセットされた後は、GPU 上にしか無い空の環境マップを作り直す
    this.onContextRestored = () => {
      this.contextLost = false;
      this.updateEnvironment();
      this.dirty = true;
    };
    this.onContextLost = () => {
      this.contextLost = true;
    };
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    const cam = new THREE.PerspectiveCamera(45, 1, 0.5, 4000) as THREE.PerspectiveCamera & { shiftY?: number };
    cam.shiftY = 0;
    this.camera = cam;
    // 初期視点: 南東上空から原点（ピン位置）を見る
    this.camera.position.set(32, 26, 46);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 2, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.rotateSpeed = 0.85;
    this.controls.panSpeed = 1.1;
    this.controls.zoomSpeed = 1.2;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    // ホイールはカーソルの位置に向かってズーム（見たい所へ寄っていける）
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 1500;
    this.controls.addEventListener('change', () => this.camMoved());
    this.controls.addEventListener('start', () => {
      this.anim = null;
    });
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', () => {
      if (this.navMode === 'pan') el.style.cursor = 'grabbing';
    });
    this.onWindowPointerUp = () => {
      if (this.navMode === 'pan') el.style.cursor = 'grab';
    };
    window.addEventListener('pointerup', this.onWindowPointerUp);
    this.controls.update();

    this.scene.add(this.root);
    for (const g of Object.values(this.groups)) this.root.add(g);
    this.groups.terrain.name = 'terrain';
    this.groups.neighbors.name = 'neighbors';
    this.groups.building.name = 'building';
    this.groups.site.name = 'site';
    this.groups.sunpath.name = 'sunpath';
    this.groups.overlay.name = 'overlay';
    this.groups.markers.name = 'markers';
    this.groups.align.name = 'align';

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.radius = 2.5;
    this.sun.shadow.normalBias = 0.08;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    this.composer = new EffectComposer(this.renderer);
    this.passes = { render: new RenderPass(this.scene, this.camera), output: new OutputPass(), smaa: new SMAAPass() };
    this.composer.addPass(this.passes.render);
    this.composer.addPass(this.passes.output);
    this.composer.addPass(this.passes.smaa);

    // 太陽・影・空（env も作る）
    this.setSunDirection(this.sunDir, true);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.loop();
  }

  private camMoved() {
    this._dirty = true;
    this.lastMove = performance.now();
    this.clampPending = true;
  }

  /** 左ドラッグの操作: 回転（orbit）か、画面を掴んで移動（pan） */
  setNavMode(mode: 'orbit' | 'pan'): void {
    this.navMode = mode;
    const M = THREE.MOUSE;
    const T = THREE.TOUCH;
    if (mode === 'pan') {
      this.controls.mouseButtons = { LEFT: M.PAN, MIDDLE: M.DOLLY, RIGHT: M.ROTATE };
      this.controls.touches = { ONE: T.PAN, TWO: T.DOLLY_ROTATE };
    } else {
      this.controls.mouseButtons = { LEFT: M.ROTATE, MIDDLE: M.DOLLY, RIGHT: M.PAN };
      this.controls.touches = { ONE: T.ROTATE, TWO: T.DOLLY_PAN };
    }
    this.renderer.domElement.style.cursor = mode === 'pan' ? 'grab' : '';
  }

  /** ボタンでのズーム（k < 1 で近づく） */
  zoomBy(k: number): void {
    this.anim = null;
    const t = this.controls.target;
    const off = this.camera.position.clone().sub(t);
    const d = off.length();
    // 近づきすぎたら注視点ごと前へ進む
    if (k < 1 && d * k < this.controls.minDistance * 1.2) {
      const step = off.clone().normalize().multiplyScalar(-Math.max(0.4, d * (1 - k)));
      this.camera.position.add(step);
      t.add(step);
    } else {
      const nd = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, d * k));
      this.camera.position.copy(t).addScaledVector(off.normalize(), nd);
    }
    this.controls.update();
    this.camMoved();
  }

  /** GPU のリセットからの復帰を待つ */
  async waitForContext(timeoutMs = 15000): Promise<boolean> {
    const t0 = performance.now();
    while (this.contextLost && performance.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 100));
    return !this.contextLost;
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    // 画面サイズでは影は変わらない（影は描き直さない）
    this._dirty = true;
  }

  /** 場面が変わった（影も描き直す） */
  invalidate(): void {
    this.dirty = true;
  }

  pause(p: boolean): void {
    this.paused = p;
    if (!p) this.dirty = true;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.paused || this.contextLost) return;
    const now = performance.now();
    if (this.anim) {
      const t = Math.min(1, (now - this.anim.t0) / this.anim.dur);
      const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.applyView(lerpView(this.anim.from, this.anim.to, k));
      if (t >= 1) this.anim = null;
      this.camMoved();
    }
    const moved = this.controls.update();
    if (moved) this.camMoved();
    if (this.clampPending) {
      this.clampPending = false;
      this.clampCameraAboveGround();
    }
    // 操作中（直近 0.2 秒以内にカメラが動いた）は後処理なし・低めの解像度で軽く描き、止まったら高品質で1枚描く
    const moving = now - this.lastMove < 200;
    if (moving) {
      if (!this._dirty) return;
      this._dirty = false;
      if (this.renderMode !== 'fast') {
        this.renderMode = 'fast';
        this.applyPixelRatio(this.fastPR);
        this._dirty = false;
      }
      const t0 = performance.now();
      this.renderer.render(this.scene, this.camera);
      this.onAfterRender?.();
      // 描画が重ければ解像度をさらに下げ、軽ければ戻す
      const ms = performance.now() - t0;
      if (ms > 28 && this.fastPR > 0.5) {
        this.fastPR = Math.max(0.5, this.fastPR * 0.85);
        this.applyPixelRatio(this.fastPR);
        this._dirty = false;
      } else if (ms < 10 && this.fastPR < this.fullPR()) this.fastPR = Math.min(this.fullPR(), this.fastPR * 1.1);
      this.hqPending = true;
      return;
    }
    if (!this._dirty && !this.hqPending) return;
    this._dirty = false;
    this.hqPending = false;
    if (this.renderMode !== 'hq') {
      this.renderMode = 'hq';
      this.applyPixelRatio(this.fullPR());
      this._dirty = false;
    }
    this.renderFrame();
  };

  private fullPR() {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  private applyPixelRatio(pr: number) {
    if (Math.abs(this.renderer.getPixelRatio() - pr) < 0.01) return;
    this.renderer.setPixelRatio(pr);
    this.resize();
  }

  /**
   * カメラを地面より下へ行かせない。カメラの真上から真下へ地形にレイを飛ばし（地形メッシュには terrain モジュールが
   * three-mesh-bvh の boundsTree / 高速 raycast を付けている前提。無くても動く）、地面 + 1.2m を下回っていたら
   * カメラと注視点を同じだけ持ち上げる。地形が無いときは y=0 の平地とみなす。
   */
  private clampCameraAboveGround() {
    const cam = this.camera;
    let groundY = 0;
    if (this.groups.terrain.children.length) {
      const rc = this.groundRay;
      rc.firstHitOnly = true;
      // カメラが地面の下に潜っていても当たるように、十分高い所から真下へ
      rc.set(new THREE.Vector3(cam.position.x, cam.position.y + 2000, cam.position.z), new THREE.Vector3(0, -1, 0));
      rc.near = 0;
      rc.far = Infinity;
      const hits = rc.intersectObjects(this.groups.terrain.children, true);
      if (!hits.length) return;
      // 一番高い面（最初のヒット）が地面
      groundY = hits[0].point.y;
    }
    const minY = groundY + CAMERA_GROUND_CLEARANCE;
    if (cam.position.y >= minY) return;
    const dy = minY - cam.position.y;
    cam.position.y += dy;
    this.controls.target.y += dy;
    this._dirty = true;
    this.lastMove = performance.now();
  }

  /** 1 フレーム描く（後処理込み） */
  renderFrame(): void {
    this.composer.render();
    this.onAfterRender?.();
  }

  /**
   * 太陽の方向（単位ベクトル、ワールド）。envUpdate=true なら空の環境光も作り直す（重いので操作中は false）。
   * 高度が低いほど色を暖色に、地平線下では太陽光を消す。
   */
  setSunDirection(dir: THREE.Vector3, envUpdate = true): void {
    this.sunDir.copy(dir).normalize();
    const elev = Math.asin(Math.max(-1, Math.min(1, this.sunDir.y)));
    const k = Math.max(0, Math.min(1, elev / 0.12));
    const warm = 1 - Math.min(1, Math.max(0, elev / 0.6));
    this.sun.color.setRGB(1, 0.93 - 0.25 * warm, 0.84 - 0.45 * warm);
    this.sun.intensity = 5.5 * k;
    this.sun.visible = k > 0.001;
    this.hemi.intensity = 0.08 + 0.12 * Math.min(1, Math.max(0, elev * 3));
    this.applyShadowFit();
    if (envUpdate) this.updateEnvironment();
    this.invalidate();
  }

  /** 影の範囲を合わせる（中心と半径 m。建物中心 ± 45m 程度）。建物を動かしたら呼び直す */
  fitShadow(center: THREE.Vector3, radius: number): void {
    this.shadowCenter.copy(center);
    this.shadowRadius = Math.max(1, radius);
    this.applyShadowFit();
    this.invalidate();
  }

  /**
   * 影のカメラ（平行投影）を現在の太陽方向に合わせる。
   * 横方向の箱は中心 ± radius。光源は中心から太陽方向へ D = 2·radius + 260（地形の取得半径）離した所に置き、
   * near=1、far=D + 2·radius + 300 とすることで、太陽側の遠くて高い周辺建物（地形半径の端まで）も影を落とせる。
   * bias は深度 [0,1] 単位なので、far-near で割ってワールドで約 2cm に保つ。
   */
  private applyShadowFit() {
    const r = this.shadowRadius;
    const D = r * 2 + TERRAIN_RADIUS_M;
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 1;
    cam.far = D + r * 2 + 300;
    cam.updateProjectionMatrix();
    this.sun.position.copy(this.shadowCenter).addScaledVector(this.sunDir, D);
    this.sun.target.position.copy(this.shadowCenter);
    this.sun.target.updateMatrixWorld();
    this.sun.shadow.bias = -0.02 / (cam.far - cam.near);
  }

  /** 空の環境光・背景を作り直す */
  updateEnvironment(): void {
    if (this.contextLost) return;
    this.skyTex?.dispose();
    this.skyTex = makeSkyTexture({ sunDir: this.sunDir, mode: 'day', sunDisk: false, width: 512 });
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromEquirectangular(this.skyTex);
    this.scene.environment = this.envRT.texture;
    this.scene.background = this.skyTex;
    this.scene.environmentIntensity = 0.6;
    this.renderer.toneMappingExposure = 0.9;
    this.dirty = true;
  }

  /** ポインタイベント → NDC */
  ndcFromEvent(e: { clientX: number; clientY: number }): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    const w = Math.max(1, r.width);
    const h = Math.max(1, r.height);
    return new THREE.Vector2(((e.clientX - r.left) / w) * 2 - 1, -((e.clientY - r.top) / h) * 2 + 1);
  }

  /** 画面上の点から指定グループへレイキャスト（最前面の可視メッシュ）。無ければ null */
  pick(ndc: THREE.Vector2, roots: THREE.Object3D[]): THREE.Intersection | null {
    const rc: RaycasterBVH = new THREE.Raycaster();
    rc.firstHitOnly = true;
    rc.setFromCamera(ndc, this.camera);
    const hits = rc.intersectObjects(roots, true);
    for (const hit of hits) if (isVisibleDeep(hit.object)) return hit;
    return null;
  }

  currentView(): CameraView {
    return { pos: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov };
  }

  applyView(v: CameraView): void {
    this.camera.fov = v.fov;
    this.camera.shiftY = 0;
    this.camera.position.copy(v.pos);
    this.controls.target.copy(v.target);
    this.camera.lookAt(v.target);
    this.camera.updateProjectionMatrix();
    this.camMoved();
  }

  flyTo(v: CameraView, dur = 900): void {
    if (dur <= 0) {
      this.anim = null;
      this.applyView(v);
      return;
    }
    this.anim = { from: this.currentView(), to: { pos: v.pos.clone(), target: v.target.clone(), fov: v.fov }, t0: performance.now(), dur };
    this.camMoved();
  }

  /** 指定解像度で書き出し（高品質） */
  async capture(width: number, height: number, mime = 'image/jpeg', q = 0.92): Promise<string> {
    const prevPR = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(1);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // 影も最新にしてから描く
    this.renderer.shadowMap.needsUpdate = true;
    this.renderFrame();
    const url = this.renderer.domElement.toDataURL(mime, q);
    this.renderer.setPixelRatio(prevPR);
    this.resize();
    return url;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener('pointerup', this.onWindowPointerUp);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.controls.dispose();
    this.passes.render.dispose();
    this.passes.output.dispose();
    this.passes.smaa.dispose();
    this.composer.dispose();
    this.envRT?.dispose();
    this.envRT = null;
    this.skyTex?.dispose();
    this.skyTex = null;
    this.pmrem.dispose();
    this.scene.environment = null;
    this.scene.background = null;
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function lerpView(a: CameraView, b: CameraView, t: number): CameraView {
  return {
    pos: a.pos.clone().lerp(b.pos, t),
    target: a.target.clone().lerp(b.target, t),
    fov: a.fov + (b.fov - a.fov) * t,
  };
}

/** 祖先まで含めて visible か */
function isVisibleDeep(o: THREE.Object3D | null): boolean {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

const TEXTURE_SLOTS = ['map', 'alphaMap', 'bumpMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'displacementMap', 'lightMap', 'specularMap'] as const;

/**
 * ジオメトリ・マテリアル・マテリアルのテクスチャ（map / bumpMap / alphaMap など。envMap は共有なので除く）をすべて解放する。
 * Mesh のほか Line / Points / Sprite も対象。
 * `userData.sharedMaterial === true` のオブジェクトはマテリアル（とそのテクスチャ）を解放しない（他で使い続けるもの）。
 */
export function disposeDeep(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    m.geometry?.dispose();
    if (!m.material || o.userData.sharedMaterial === true) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      const rec = mat as unknown as Record<string, unknown>;
      for (const slot of TEXTURE_SLOTS) {
        const t = rec[slot] as THREE.Texture | null | undefined;
        if (t && (t as THREE.Texture).isTexture) t.dispose();
      }
      mat.dispose();
    }
  });
}

/**
 * グループの子をすべて取り除き、ジオメトリとマテリアル（テクスチャ含む）を解放する。
 * 解放したくないマテリアルを持つオブジェクトには `userData.sharedMaterial = true` を付けておく。
 */
export function clearGroup(g: THREE.Object3D) {
  for (const c of [...g.children]) {
    g.remove(c);
    disposeDeep(c);
  }
}
