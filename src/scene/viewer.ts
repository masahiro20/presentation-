/**
 * 3D ビューア（リアルタイム PBR + 影 + アンビエントオクルージョン）
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import type { BuildingModel } from '../core/types';
import { buildBuilding, type BuildingMeta } from './building';
import { buildRoofs, type RoofInfo } from './roof';
import { buildFurniture, type LightPoint, type Footprint } from './furniture';
import { placeModels } from './models';
import { distantTreeBand } from './distant';
import { exteriorShots, interiorShots, facadeWindows, type Shot } from './shots';
import { buildOccluder } from '../sun/analysis';
import { buildLandscape, type SiteInfo } from './landscape';
import { MaterialRegistry } from './materials';
import { makeSkyTexture } from './sky';
import { exteriorById, interiorById, type DesignOptions } from '../styles/presets';
import { preloadPhotoTextures } from '../styles/photoTextures';
import { clearMaterialCache } from '../styles/textures';
import { resolveSpec } from '../styles/spec';

/** 建築パース用カメラ: レンズシフトで縦線を垂直に保つ */
export class ArchCamera extends THREE.PerspectiveCamera {
  shiftY = 0;
  updateProjectionMatrix() {
    super.updateProjectionMatrix();
    if (this.shiftY) {
      this.projectionMatrix.elements[9] += this.shiftY;
      this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
    }
  }
}

export interface CameraView {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
  /** 縦線補正（true ならカメラを水平にしてレンズシフトで構図を合わせる） */
  architectural?: boolean;
}

export interface SceneState {
  model: BuildingModel;
  meta: BuildingMeta;
  roof: RoofInfo;
  site: SiteInfo;
  lights: LightPoint[];
  occupancy: Map<string, Footprint[]>;
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new ArchCamera(50, 1, 0.05, 2000);
  readonly controls: OrbitControls;
  readonly composer: EffectComposer;
  readonly sun = new THREE.DirectionalLight('#fff3e0', 3);
  readonly hemi = new THREE.HemisphereLight('#dbe8ff', '#6b6a5e', 0.35);
  readonly root = new THREE.Group();
  readonly groups = {
    building: new THREE.Group(),
    roof: new THREE.Group(),
    furniture: new THREE.Group(),
    landscape: new THREE.Group(),
    context: new THREE.Group(),
    overlay: new THREE.Group(),
    lights: new THREE.Group(),
    /** 設計の 3D データ（3DS など）で置き換えた正確な建物。setModel では消さない（src/app/externalBuilding.ts が管理） */
    external: new THREE.Group(),
  };
  registry: MaterialRegistry;
  state: SceneState | null = null;
  design: DesignOptions;
  sunDir = new THREE.Vector3(0.4, 0.7, 0.5).normalize();
  /** 実物モデルの非同期配置の世代（図面を読み直したら古い配置を捨てる） */
  private modelGen = 0;
  private gtao: GTAOPass;
  private smaa: SMAAPass;
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
  private keys = new Set<string>();
  private walkOcc: { state: SceneState; occ: ReturnType<typeof buildOccluder> } | null = null;
  private lastTick = performance.now();
  private camMoved() {
    this._dirty = true;
    this.lastMove = performance.now();
  }
  private raf = 0;
  private skyTex: THREE.DataTexture | null = null;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  quality: 'fast' | 'high' = 'high';
  contextLost = false;
  userData: Record<string, unknown> = {};
  private shotCache: { state: SceneState; interiors: Map<string, Shot[]> } | null = null;
  /** 影の範囲の中心（PDF の建物と外部の建物の和）。fitShadow が決める */
  private shadowCenter: THREE.Vector3 | null = null;
  /** 外部の建物が PDF の建物に代わっている間、PDF 由来のグループを隠した */
  private pdfGroupsHidden = false;
  onAfterRender?: () => void;
  private anim: { from: CameraView; to: CameraView; t0: number; dur: number } | null = null;

  constructor(readonly container: HTMLElement, design: DesignOptions) {
    this.design = design;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // 影はカメラを動かしただけでは変わらないので、場面が変わったときだけ描き直す
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    // GPU がリセットされた後は、GPU 上にしか無い空の環境マップを作り直す
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.updateEnvironment();
      this.dirty = true;
    });
    this.renderer.domElement.addEventListener('webglcontextlost', () => {
      this.contextLost = true;
    });
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.rotateSpeed = 0.85;
    this.controls.panSpeed = 1.1;
    this.controls.zoomSpeed = 1.2;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    // ホイールはカーソルの位置に向かってズーム（見たい所へ寄っていける）
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 0.2;
    this.controls.addEventListener('change', () => {
      this.camMoved();
    });
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', () => {
      if (this.navMode === 'pan') el.style.cursor = 'grabbing';
    });
    window.addEventListener('pointerup', () => {
      if (this.navMode === 'pan') el.style.cursor = 'grab';
    });
    this.controls.addEventListener('start', () => {
      this.anim = null;
      if (this.camera.shiftY) {
        this.camera.shiftY = 0;
        this.camera.updateProjectionMatrix();
      }
    });

    this.scene.add(this.root);
    for (const g of Object.values(this.groups)) this.root.add(g);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    this.registry = new MaterialRegistry(exteriorById(design.exteriorId), interiorById(design.interiorId), { night: design.timeOfDay === 'night' });
    // 実写テクスチャを読み込んだら、マテリアルを作り直して差し替える
    void preloadPhotoTextures().then(() => {
      clearMaterialCache();
      this.setDesign({ ...this.design });
    });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
    this.gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.2, scale: 1.2 });
    this.gtao.blendIntensity = 0.85;
    this.composer.addPass(this.gtao);
    this.composer.addPass(new OutputPass());
    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resize();
    this.bindKeys();
    this.loop();
  }

  navMode: 'orbit' | 'pan' = 'orbit';
  /** 左ドラッグの操作: 回転（orbit）か、画面を掴んで移動（pan） */
  setNavMode(mode: 'orbit' | 'pan') {
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
  zoomBy(k: number) {
    this.anim = null;
    if (this.camera.shiftY) {
      this.camera.shiftY = 0;
      this.camera.updateProjectionMatrix();
    }
    const t = this.controls.target;
    const off = this.camera.position.clone().sub(t);
    const d = off.length();
    // 近づきすぎたら注視点ごと前へ進む（室内を歩くように）
    if (k < 1 && d * k < 0.6) {
      const step = off.clone().normalize().multiplyScalar(-Math.max(0.4, d * (1 - k)));
      this.camera.position.add(step);
      t.add(step);
    } else {
      this.camera.position.copy(t).addScaledVector(off, k);
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

  resize() {
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
    this.dirty = true;
  }

  invalidate() {
    this.dirty = true;
  }

  private paused = false;
  pause(p: boolean) {
    this.paused = p;
    if (!p) this.dirty = true;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.paused) return;
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (this.anim) {
      const t = Math.min(1, (now - this.anim.t0) / this.anim.dur);
      const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.applyView(lerpView(this.anim.from, this.anim.to, k));
      if (t >= 1) this.anim = null;
      this.camMoved();
    }
    if (this.keys.size) this.walk(dt);
    const moved = this.controls.update();
    if (moved) this.camMoved();
    // 操作中（直近 0.2 秒以内にカメラが動いた）は後処理なし・低めの解像度で軽く描き、止まったら高品質で1枚描く
    const moving = now - this.lastMove < 200 && this.quality === 'high';
    if (moving) {
      if (!this._dirty) return;
      this._dirty = false;
      if (this.renderMode !== 'fast') {
        this.renderMode = 'fast';
        this.applyPixelRatio(this.fastPR);
      }
      const t0 = performance.now();
      this.renderer.render(this.scene, this.camera);
      this.onAfterRender?.();
      // 描画が重ければ解像度をさらに下げ、軽ければ戻す
      const ms = performance.now() - t0;
      if (ms > 28 && this.fastPR > 0.5) {
        this.fastPR = Math.max(0.5, this.fastPR * 0.85);
        this.applyPixelRatio(this.fastPR);
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

  /** キーボードで歩く: W/S・↑/↓ 前後、A/D・←/→ 左右、Q/E 下/上、Shift で速く */
  private walk(dt: number) {
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    f.normalize();
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const mv = new THREE.Vector3();
    const k = this.keys;
    if (k.has('w') || k.has('arrowup')) mv.add(f);
    if (k.has('s') || k.has('arrowdown')) mv.sub(f);
    if (k.has('d') || k.has('arrowright')) mv.add(r);
    if (k.has('a') || k.has('arrowleft')) mv.sub(r);
    if (k.has('e')) mv.y += 1;
    if (k.has('q')) mv.y -= 1;
    if (mv.lengthSq() === 0) return;
    // 室内は歩く速さ、外観は建物の大きさに合わせて速く
    const indoor = this.camera.position.y < 8;
    const speed = (indoor ? 2.2 : 9) * (k.has('shift') ? 3 : 1);
    mv.normalize().multiplyScalar(speed * dt);
    // 壁の通り抜けを防ぐ（壁に沿って滑るように、東西・南北を別々に判定）
    if (this.state) {
      if (!this.walkOcc || this.walkOcc.state !== this.state) this.walkOcc = { state: this.state, occ: buildOccluder(this, { buildingOnly: true }) };
      const ray = new THREE.Ray();
      const blocked = (d: THREE.Vector3) => {
        const len = d.length();
        if (len < 1e-6) return false;
        for (const dy of [0, -0.9]) {
          ray.origin.copy(this.camera.position).setY(this.camera.position.y + dy);
          ray.direction.copy(d).normalize();
          const hit = this.walkOcc!.occ.bvh.raycastFirst(ray, THREE.DoubleSide);
          if (hit && hit.distance < len + 0.3) return true;
        }
        return false;
      };
      const dx = new THREE.Vector3(mv.x, 0, 0);
      const dz = new THREE.Vector3(0, 0, mv.z);
      if (blocked(dx)) mv.x = 0;
      if (blocked(dz)) mv.z = 0;
      if (mv.lengthSq() === 0) return;
    }
    this.anim = null;
    this.camera.position.add(mv);
    this.controls.target.add(mv);
    this.camMoved();
  }

  /** キー操作の受付（入力欄の操作中は除く） */
  private bindKeys() {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    };
    const WALK = new Set(['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift']);
    window.addEventListener('keydown', (e) => {
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!this.container.getClientRects().length || getComputedStyle(this.container).visibility === 'hidden') return;
      const key = e.key.toLowerCase();
      if (!WALK.has(key)) return;
      this.keys.add(key);
      if (key.startsWith('arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  renderFrame() {
    if (this.quality === 'high') this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.onAfterRender?.();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
  }

  // ------------------------------------------------------------------
  // シーン構築
  // ------------------------------------------------------------------

  setModel(model: BuildingModel) {
    const ext = exteriorById(this.design.exteriorId);
    for (const g of [this.groups.building, this.groups.roof, this.groups.furniture, this.groups.landscape, this.groups.lights]) clearGroup(g);
    // 天井高の上書き（仕様の調整）
    const ch = this.design.specPatch?.ceilingHeight;
    if (ch) for (const f of model.floors) f.ceilingHeight = Math.min(ch, f.height - 200);
    const { mb, meta } = buildBuilding(model, { exterior: ext, spec: resolveSpec(this.design.specId, this.design.specPatch) });
    const resolve = (k: string) => this.registry.get(k);
    this.groups.building.add(mb.build(resolve, { name: 'building' }));
    const roof = buildRoofs(model, ext, this.design.roofOverride, this.design.roofPitch);
    this.groups.roof.add(roof.mb.build(resolve, { name: 'roof' }));
    const fur = buildFurniture(model);
    this.groups.furniture.add(fur.mb.build(resolve, { name: 'furniture' }));
    // 実物のモデル（観葉植物・ラウンジチェア）は読み込み後に追加
    const gen = ++this.modelGen;
    void placeModels(fur.models, this.groups.furniture, () => gen === this.modelGen).then((n) => {
      if (n) this.dirty = true;
    });
    const land = buildLandscape(meta, ext, model.site);
    const landG = land.mb.build(resolve, { name: 'landscape', castShadow: false });
    this.groups.landscape.add(landG);
    this.groups.landscape.add(land.trees.build(resolve, { name: 'trees' }));
    // 遠景の木立（地平線まで何もない地面にしない）
    this.groups.landscape.add(distantTreeBand((land.site.min.x + land.site.max.x) / 2, (land.site.min.y + land.site.max.y) / 2));
    // ガラスは影を落とさない
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.userData.matKey?.startsWith('ext.glass') || m.userData.matKey === 'f.water')) {
        m.castShadow = false;
        m.renderOrder = 2;
      }
    });
    this.state = { model, meta, roof: roof.info, site: land.site, lights: fur.lights, occupancy: fur.occupancy };
    this.fitShadow();
    this.updateInteriorLights();
    this.updateEnvironment();
    // 外部の建物（3DS）で置き換え中なら、作り直した PDF の建物もまた隠す
    this.applyExternalReplace();
    this.dirty = true;
  }

  /**
   * 外部の正確な建物（groups.external）が PDF の建物に代わるとき（userData.externalReplaces かつ日照ステップ表示中 userData.externalMounted）、
   * PDF 由来の建物・屋根・家具・室内照明を隠す。条件が外れたら元に戻す（隠していたときだけ戻すので、断面表示などの状態を壊さない）
   */
  applyExternalReplace() {
    const hide = this.userData.externalReplaces === true && this.userData.externalMounted === true && this.groups.external.children.length > 0;
    if (hide) {
      for (const g of [this.groups.building, this.groups.roof, this.groups.furniture, this.groups.lights]) g.visible = false;
      this.pdfGroupsHidden = true;
    } else if (this.pdfGroupsHidden) {
      this.groups.building.visible = true;
      this.groups.roof.visible = true;
      this.groups.furniture.visible = this.design.furniture;
      this.groups.lights.visible = true;
      this.pdfGroupsHidden = false;
    }
    this.dirty = true;
  }

  /** 遮蔽物のキャッシュ（歩行の壁判定・見どころカメラ）を捨てる。外部の建物が変わったときに呼ぶ */
  invalidateOccluders() {
    this.walkOcc = null;
    this.shotCache = null;
  }

  /** 外部の建物（groups.external）のワールド bbox（無ければ null） */
  externalBox(): THREE.Box3 | null {
    if (!this.groups.external.children.length) return null;
    this.groups.external.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(this.groups.external, true);
    return b.isEmpty() ? null : b;
  }

  /** テイスト変更（屋根形状の変更時のみ屋根を再生成） */
  setDesign(design: DesignOptions) {
    const prev = this.design;
    this.design = design;
    this.registry.update(exteriorById(design.exteriorId), interiorById(design.interiorId), {
      wallColor: design.wallColorOverride,
      doorColor: design.specPatch?.doorColor,
      night: design.timeOfDay === 'night',
    });
    if (!this.state) return;
    const ext = exteriorById(design.exteriorId);
    const roofChanged =
      prev.exteriorId !== design.exteriorId || prev.roofOverride !== design.roofOverride || prev.roofPitch !== design.roofPitch || prev.specId !== design.specId || JSON.stringify(prev.specPatch) !== JSON.stringify(design.specPatch);
    if (roofChanged || prev.exteriorId !== design.exteriorId) {
      // 外構・アクセント位置も変わるので建物以外を再構築
      this.setModel(this.state.model);
      return;
    }
    this.registry.apply(this.root);
    this.groups.furniture.visible = design.furniture;
    if (prev.timeOfDay !== design.timeOfDay) {
      this.updateInteriorLights();
      this.updateEnvironment();
    }
    void ext;
    this.dirty = true;
  }

  /**
   * 影の範囲（平行光源の正射影カメラ）を建物に合わせる。
   * PDF の建物（meta.bbox）と外部の建物（groups.external、あれば）の和にさらに extra を加えた箱を囲む。
   * setModel から毎回呼ばれるので、外部の建物を足した後も setModel で範囲が戻ることはない
   */
  fitShadow(extra?: THREE.Box3) {
    if (!this.state) return;
    const b = this.state.meta.bbox.clone();
    const ext = this.externalBox();
    if (ext) b.union(ext);
    if (extra && !extra.isEmpty()) b.union(extra);
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5 + 14;
    this.fitShadowTo(c, r);
  }

  /** 影の範囲を中心 center・半径 radius (m) の箱にする */
  fitShadowTo(center: THREE.Vector3, radius: number) {
    const r = Math.max(1, radius);
    const c = center.clone();
    this.shadowCenter = c;
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.5;
    cam.far = 200;
    cam.updateProjectionMatrix();
    this.sun.target.position.copy(c);
    this.setSunDirection(this.sunDir);
  }

  setSunDirection(dir: THREE.Vector3, envUpdate = true) {
    this.sunDir.copy(dir).normalize();
    const b = this.state?.meta.bbox;
    const c = this.shadowCenter ? this.shadowCenter.clone() : b ? b.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(this.sunDir, 80);
    const elev = Math.asin(this.sunDir.y);
    const night = this.design.timeOfDay === 'night';
    const k = night ? 0 : Math.max(0, Math.min(1, elev / 0.12));
    const warm = 1 - Math.min(1, Math.max(0, elev / 0.6));
    this.sun.color.setRGB(1, 0.93 - 0.25 * warm, 0.84 - 0.45 * warm);
    this.sun.intensity = 5.5 * k;
    this.sun.visible = k > 0.001;
    this.hemi.intensity = night ? 0.03 : 0.08 + 0.12 * Math.min(1, Math.max(0, elev * 3));
    if (envUpdate) this.updateEnvironment();
    this.dirty = true;
  }

  updateEnvironment(sunDisk = false) {
    const mode = this.design.timeOfDay;
    this.skyTex?.dispose();
    this.skyTex = makeSkyTexture({ sunDir: this.sunDir, mode, sunDisk, width: 512 });
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromEquirectangular(this.skyTex);
    this.scene.environment = this.envRT.texture;
    this.scene.background = this.skyTex;
    this.scene.environmentIntensity = mode === 'night' ? 0.25 : 0.6;
    this.renderer.toneMappingExposure = mode === 'night' ? 1.3 : mode === 'evening' ? 1.05 : 0.9;
    this.dirty = true;
  }

  getSkyTexture(sunDisk: boolean) {
    return makeSkyTexture({ sunDir: this.sunDir, mode: this.design.timeOfDay, sunDisk, width: 1024 });
  }

  /** 検証用: 画面上の点（0〜1）にある面の材料キーと座標 */
  debugPick(nx: number, ny: number): { key: string; point: number[] } | null {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx * 2 - 1, 1 - ny * 2), this.camera);
    const hits = rc.intersectObjects([this.groups.building, this.groups.roof, this.groups.furniture, this.groups.landscape], true);
    const h = hits.find((x) => (x.object as THREE.Mesh).visible);
    if (!h) return null;
    const m = (h.object as THREE.Mesh).material as THREE.Material;
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
    return { key: m.name || h.object.name, point: h.point.toArray().map((v) => Math.round(v * 1000)), n: n ? n.toArray().map((v) => Math.round(v * 10) / 10) : null } as never;
  }

  /** 室内照明（夜景時は点光源、昼は弱い補助光で室内の暗さを緩和） */
  updateInteriorLights() {
    clearGroup(this.groups.lights);
    if (!this.state) return;
    const night = this.design.timeOfDay === 'night';
    const kelvin = interiorById(this.design.interiorId).lightKelvin;
    const col = kelvinToColor(kelvin);
    const used = new Set<string>();
    for (const l of this.state.lights) {
      const key = `${l.roomId}:${l.kind}`;
      if (!night && used.has(key)) continue;
      used.add(key);
      const intensity = night ? (l.kind === 'ceiling' ? 6 : l.kind === 'pendant' ? 3 : 1.2) : l.kind === 'ceiling' ? 2.2 : 0;
      if (intensity <= 0) continue;
      const p = new THREE.PointLight(night ? col : new THREE.Color('#fff6ea'), intensity, night ? 7 : 7, night ? 1.6 : 1.0);
      p.position.copy(l.pos);
      // 昼は部屋の中ほどに置いて天井・壁・床をまんべんなく照らす（間接光の近似）
      if (l.kind === 'ceiling') p.position.y -= night ? 0.3 : 1.2;
      this.groups.lights.add(p);
    }
    this.dirty = true;
  }

  // ------------------------------------------------------------------
  // カメラ
  // ------------------------------------------------------------------

  /** 自動生成の見どころカメラ */
  shots(aspect = 16 / 9): Shot[] {
    if (!this.state) return [];
    const s = this.state;
    if (!this.shotCache || this.shotCache.state !== s) {
      // 家具込みの BVH でレイキャストし、室内の見通しを評価
      const occ = buildOccluder(this, { buildingOnly: true, furniture: this.groups.furniture.visible });
      const ray = new THREE.Ray();
      const fn = (o: THREE.Vector3, d: THREE.Vector3, far: number) => {
        ray.origin.copy(o);
        ray.direction.copy(d);
        const hit = occ.bvh.raycastFirst(ray, THREE.DoubleSide);
        return hit ? Math.min(far, hit.distance) : far;
      };
      this.shotCache = { state: s, interiors: new Map() };
      this.shotCache.interiors.set(aspect.toFixed(2), interiorShots(s.model, s.meta, s.occupancy, aspect, fn));
      occ.mesh.geometry.dispose();
    }
    const key = aspect.toFixed(2);
    if (!this.shotCache.interiors.has(key)) {
      // 縦横比が違う場合は最も近いものを流用
      const first = [...this.shotCache.interiors.values()][0];
      this.shotCache.interiors.set(key, first);
    }
    return [...exteriorShots(s.meta, s.site, s.roof, aspect, s.model.northAngleDeg, facadeWindows(s.model)), ...this.shotCache.interiors.get(key)!];
  }

  /** ショットを適用（時間帯・パース用の太陽も切り替え） */
  applyShot(shot: Shot, animate = false) {
    const tod = shot.timeOfDay ?? this.design.timeOfDay;
    if (tod !== this.design.timeOfDay) this.setDesign({ ...this.design, timeOfDay: tod });
    if (shot.sunDir) this.setSunDirection(shot.sunDir);
    if (animate) this.flyTo(shot.view);
    else this.applyView(shot.view);
  }

  currentView(): CameraView {
    return { pos: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov, architectural: this.camera.shiftY !== 0 };
  }

  applyView(v: CameraView) {
    this.camera.fov = v.fov;
    if (v.architectural) {
      // 水平視線 + シフト
      const dir = v.target.clone().sub(v.pos);
      const horiz = Math.hypot(dir.x, dir.z);
      const tan = dir.y / Math.max(0.001, horiz);
      const halfTan = Math.tan((v.fov * Math.PI) / 360);
      this.camera.shiftY = Math.max(-0.9, Math.min(0.9, tan / halfTan));
      this.camera.position.copy(v.pos);
      const flatTarget = v.target.clone();
      flatTarget.y = v.pos.y;
      this.controls.target.copy(flatTarget);
      this.camera.lookAt(flatTarget);
    } else {
      this.camera.shiftY = 0;
      this.camera.position.copy(v.pos);
      this.controls.target.copy(v.target);
      this.camera.lookAt(v.target);
    }
    this.camera.updateProjectionMatrix();
    this.camMoved();
  }

  flyTo(v: CameraView, dur = 900) {
    const from = this.currentView();
    if (this.camera.shiftY !== 0) {
      // シフト状態から補間するため、見かけの注視点を復元
      from.target = from.pos.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).multiplyScalar(10));
      from.target.y += this.camera.shiftY * Math.tan((this.camera.fov * Math.PI) / 360) * 10;
    }
    this.anim = { from, to: v, t0: performance.now(), dur };
    this.camMoved();
  }

  /** 断面（模型）表示: 指定階より上と屋根を隠し、天井を消す */
  setCutaway(level: number | null) {
    this.groups.roof.visible = level == null;
    const model = this.state?.model;
    // 天井はマテリアル単位で非表示
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.userData.matKey === 'int.ceiling') m.visible = level == null;
    });
    if (model && level != null) {
      const f = model.floors.find((f) => f.level === level);
      const clipY = f ? (f.elevation + f.ceilingHeight * 0.55) / 1000 : Infinity;
      const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), clipY);
      this.renderer.clippingPlanes = [plane];
    } else {
      this.renderer.clippingPlanes = [];
    }
    this.dirty = true;
  }

  /** 指定解像度で書き出し（高品質） */
  async capture(width: number, height: number, mime = 'image/jpeg', q = 0.92): Promise<string> {
    const prev = { w: this.container.clientWidth, h: this.container.clientHeight, pr: this.renderer.getPixelRatio() };
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(1);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const qPrev = this.quality;
    this.quality = 'high';
    this.renderFrame();
    const url = this.renderer.domElement.toDataURL(mime, q);
    this.quality = qPrev;
    this.renderer.setPixelRatio(prev.pr);
    this.resize();
    return url;
  }
}

function lerpView(a: CameraView, b: CameraView, t: number): CameraView {
  return {
    pos: a.pos.clone().lerp(b.pos, t),
    target: a.target.clone().lerp(b.target, t),
    fov: a.fov + (b.fov - a.fov) * t,
    architectural: t > 0.98 ? b.architectural : false,
  };
}

export function clearGroup(g: THREE.Group) {
  for (const c of [...g.children]) {
    g.remove(c);
    c.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
  }
}

export function kelvinToColor(k: number): THREE.Color {
  const t = k / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (x: number) => Math.max(0, Math.min(255, x)) / 255;
  return new THREE.Color().setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace);
}
