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
import type { BuildingModel, Room } from '../core/types';
import { buildBuilding, CUT_HEIGHT, MM, type BuildingMeta, type DoorInfo } from './building';
import { MeshBuilder, topClip, verticalClip } from './meshBuilder';
import { buildRoofs, type RoofInfo } from './roof';
import { buildFurniture, setKitchenFinish, setFurnitureVocab, type LightPoint, type Footprint } from './furniture';
import { contactShadows } from './contactShadow';
import { placeModels } from './models';
import { distantTreeBand } from './distant';
import { exteriorShots, sectionShots, interiorShots, facadeWindows, type Shot } from './shots';
import { buildOccluder, externalHasVisibleMesh } from '../sun/analysis';
import { buildLandscape, type SiteInfo, type LandscapePlan } from './landscape';
import { buildExteriorLights } from './interiorLights';
import { MaterialRegistry } from './materials';
import { makeSkyTexture } from './sky';
import { exteriorById, interiorById, type DesignOptions } from '../styles/presets';
import { exteriorFor, interiorFor } from '../coordinate/catalog';
import { preloadPhotoTextures } from '../styles/photoTextures';
import { clearMaterialCache } from '../styles/textures';
import { resolveSpec } from '../styles/spec';

/** 建築パース用カメラ: レンズシフトで縦線を垂直に保つ */
/** 暗い色か（キッチンの扉の色でレンジフードをシルバー／ブラックに振り分ける） */
function isDarkColor(hex: string): boolean {
  const c = new THREE.Color(hex);
  // 御社の事例: グレーの扉でもフードは黒（シルバーは白系の扉のときだけ）
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b < 0.45;
}

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
  /** 外構の配置（植栽・舗装・車。夜景の照明や平面図に使う） */
  plan: LandscapePlan;
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
  /** 床・壁からの照り返し（下向きの面＝天井・軒裏に当たる光）。空の環境光は下半分が地面の色で暗く、天井が濁って見えるので補う */
  readonly bounce = new THREE.HemisphereLight('#f6eee2', '#000000', 0.2);
  readonly root = new THREE.Group();
  readonly groups = {
    building: new THREE.Group(),
    roof: new THREE.Group(),
    furniture: new THREE.Group(),
    /** 輪切り（模型）表示用に作り直した建物・家具 */
    cut: new THREE.Group(),
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
  /** 開閉できる扉（部品ごとの Group） */
  private doors: { info: DoorInfo; group: THREE.Group }[] = [];
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
  private keys = new Set<string>();
  private walkOcc: { state: SceneState; cut: string; occ: ReturnType<typeof buildOccluder> } | null = null;
  /** 切断表示（輪切り／断面）の状態（null = 通常表示） */
  private cut: CutSpec | null = null;
  private cutBuilt: { key: string } | null = null;
  /** 輪切り模型の部屋名タグ */
  private roomLabels = true;
  /** 歩行の速度（慣性付き）と、ホイール操作で残っている前進量 */
  private walkVel = new THREE.Vector3();
  private walkImpulse = new THREE.Vector3();
  /** 目線モードの見回し: 指の位置（2 本指のつまみで前後） */
  private walkPtrs = new Map<number, { x: number; y: number }>();
  private walkPinch: number | null = null;
  /** 目線モードの目の高さ（床から） */
  eyeHeight = 1.5;
  private lastTick = performance.now();
  private camMoved() {
    this.cullTown();
    this.declutterLabels();
    this._dirty = true;
    this.lastMove = performance.now();
  }
  private raf = 0;
  private skyTex: THREE.DataTexture | null = null;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  quality: 'fast' | 'high' = 'high';
  /**
   * 表示の重さ: 'browse'（閲覧。見て回る間は後処理なし・操作中は解像度を落として軽く）／'finish'（仕上げ。止まると GTAO・SMAA 込みで描く）。
   * 保存・書き出し（capture / renderStudio / renderPhotoreal）は表示モードに関係なく常に高品質
   */
  viewMode: 'browse' | 'finish' = 'browse';
  /** 操作中に解像度を落としている（復帰時に元の解像度へ戻す） */
  private motionPR = false;
  contextLost = false;
  userData: Record<string, unknown> = {};
  /**
   * 外部の建物（groups.external）のワールド bbox を速く返す関数（src/app/externalBuilding.ts が置く: 配置の箱の 8 隅から計算）。
   * 無ければ externalBox() は全頂点を歩く
   */
  externalBounds: (() => THREE.Box3 | null) | null = null;
  private shotCache: { state: SceneState; interiors: Map<string, Shot[]> } | null = null;
  /** 影の範囲の中心（PDF の建物と外部の建物の和）。fitShadow が決める */
  private shadowCenter: THREE.Vector3 | null = null;
  /** 外部の建物が PDF の建物に代わっている間、PDF 由来のグループを隠した */
  private pdfGroupsHidden = false;
  onAfterRender?: () => void;
  private anim: { from: CameraView; to: CameraView; t0: number; dur: number } | null = null;

  constructor(readonly container: HTMLElement, design: DesignOptions) {
    this.design = design;
    // 自動点検（スクリーンショット）用のフック
    (globalThis as any).__viewer = this;
    (globalThis as any).__THREE = THREE;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // 影はカメラを動かしただけでは変わらないので、場面が変わったときだけ描き直す
    this.renderer.shadowMap.autoUpdate = false;
    // 写真的なトーン（ハイライトの転び方が自然で、白い壁が飛ばない）
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
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
    // クリック（ほとんど動かさずに離した）で扉を開閉
    let downAt: { x: number; y: number; t: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 0) downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    el.addEventListener('pointerup', (e) => {
      const d0 = downAt;
      downAt = null;
      if (!d0 || e.button !== 0 || this.cut) return;
      if (Math.hypot(e.clientX - d0.x, e.clientY - d0.y) > 5 || performance.now() - d0.t > 400) return;
      const r = el.getBoundingClientRect();
      this.toggleDoorAt(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1));
    });
    el.addEventListener('pointerdown', (e) => {
      if (this.navMode === 'pan') el.style.cursor = 'grabbing';
      if (this.navMode === 'walk') {
        this.walkPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.walkPinch = null;
        el.setPointerCapture(e.pointerId);
        el.style.cursor = 'grabbing';
        this.anim = null;
        return;
      }
      // 回転の中心をカーソルの下にある面の奥行きに合わせる（視線はそのまま）。
      // 遠くの注視点を中心に回ると、クリックした物が大きく振られて操作しづらい
      const rotates = (this.navMode === 'orbit' && e.button === 0) || (this.navMode === 'pan' && e.button === 2);
      if (rotates && e.pointerType !== 'touch') this.pivotToCursor(e.clientX, e.clientY);
      else if (rotates && e.pointerType === 'touch' && this.walkPtrs.size === 0) this.pivotToCursor(e.clientX, e.clientY);
    });
    el.addEventListener('pointermove', (e) => {
      if (this.navMode !== 'walk') return;
      const prev = this.walkPtrs.get(e.pointerId);
      if (!prev) return;
      this.walkPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.walkPtrs.size >= 2) {
        // 2 本指: 開くと前進、閉じると後退
        const pts = [...this.walkPtrs.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (this.walkPinch != null) this.walkImpulse.addScaledVector(this.forwardFlat(), (d - this.walkPinch) * 0.012);
        this.walkPinch = d;
        return;
      }
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      // 画面を掴んで回す感覚: 右へドラッグすると景色が右へ流れ、視線は左へ
      const k = (0.0032 * this.camera.fov) / 55;
      this.lookBy(dx * k, dy * k);
    });
    const endPtr = (e: PointerEvent) => {
      this.walkPtrs.delete(e.pointerId);
      if (this.walkPtrs.size < 2) this.walkPinch = null;
      if (this.navMode === 'pan') el.style.cursor = 'grab';
      if (this.navMode === 'walk') el.style.cursor = this.walkPtrs.size ? 'grabbing' : 'grab';
    };
    el.addEventListener('pointerup', endPtr);
    el.addEventListener('pointercancel', endPtr);
    window.addEventListener('pointerup', () => {
      if (this.navMode === 'pan' && this.walkPtrs.size === 0) el.style.cursor = 'grab';
    });
    el.addEventListener(
      'wheel',
      (e) => {
        if (this.navMode !== 'walk') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        // ホイール 1 目盛りで約 0.6m 前進（なめらかに進む）
        const step = -e.deltaY * (e.deltaMode === 1 ? 0.2 : 0.006);
        this.walkImpulse.addScaledVector(this.forwardFlat(), step);
        this.anim = null;
      },
      { passive: false, capture: true },
    );
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
    // 照り返しは下から上へ（HemisphereLight は position の向きが「空」側）
    this.bounce.position.set(0, -1, 0);
    this.scene.add(this.sun, this.sun.target, this.hemi, this.bounce);

    this.registry = new MaterialRegistry(exteriorFor(design), interiorFor(design), { night: design.timeOfDay === 'night', clay: design.clay });
    // 実写テクスチャを読み込んだら、マテリアルを作り直して差し替える
    void preloadPhotoTextures().then(() => {
      clearMaterialCache();
      this.setDesign({ ...this.design });
    });

    this.composer = new EffectComposer(this.renderer);
    this.applyViewMode();
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

  navMode: 'orbit' | 'pan' | 'walk' = 'orbit';
  /** 左ドラッグの操作: 回転（orbit）、画面を掴んで移動（pan）、目線で歩く（walk: ドラッグで見回し・ホイールで前後） */
  setNavMode(mode: 'orbit' | 'pan' | 'walk') {
    const prev = this.navMode;
    this.navMode = mode;
    const M = THREE.MOUSE;
    const T = THREE.TOUCH;
    this.walkPtrs.clear();
    this.walkPinch = null;
    if (mode === 'walk') {
      this.controls.enabled = false;
      this.anim = null;
      if (this.camera.shiftY) {
        this.camera.shiftY = 0;
        this.camera.updateProjectionMatrix();
      }
      this.enterEyeLevel();
      this.renderer.domElement.style.cursor = 'grab';
      return;
    }
    this.controls.enabled = true;
    if (prev === 'walk') {
      // 注視点を目の前 3m に置き、そのまま回転・移動に移れるようにする
      this.controls.target.copy(this.camera.position).addScaledVector(this.forwardFlat(), 3);
      this.controls.target.y = this.camera.position.y - 0.3;
      this.controls.update();
    }
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
    if (this.navMode === 'walk') {
      // 目線モードでは前後に歩く
      this.walkImpulse.addScaledVector(this.forwardFlat(), k < 1 ? 1.2 : -1.2);
      return;
    }
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

  /** 建物（壁・床・屋根）だけの当たり判定（歩行の壁抜け防止・床の高さ・回転の中心に使う） */
  private occluder() {
    if (!this.state) return null;
    const cutKey = JSON.stringify(this.cut);
    if (!this.walkOcc || this.walkOcc.state !== this.state || this.walkOcc.cut !== cutKey) this.walkOcc = { state: this.state, cut: cutKey, occ: buildOccluder(this, { buildingOnly: true }) };
    return this.walkOcc.occ;
  }

  /** 画面上の点（クライアント座標）の下にある面までの距離。無ければ地面との交点、それも無ければ null */
  private depthAt(cx: number, cy: number): number | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const nx = ((cx - r.left) / Math.max(1, r.width)) * 2 - 1;
    const ny = 1 - ((cy - r.top) / Math.max(1, r.height)) * 2;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const occ = this.occluder();
    if (occ) {
      const hit = occ.bvh.raycastFirst(rc.ray, THREE.DoubleSide);
      if (hit && hit.distance > 0.05) return hit.distance;
    }
    // 家具・外構
    const hits = rc.intersectObjects([this.groups.furniture, this.groups.landscape], true);
    const h = hits.find((x) => (x.object as THREE.Mesh).visible && x.distance > 0.05);
    if (h) return h.distance;
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const p = new THREE.Vector3();
    if (rc.ray.intersectPlane(ground, p)) return p.distanceTo(this.camera.position);
    return null;
  }

  /** 回転の中心を、カーソルの下の面と同じ奥行き（視線上）に移す。視線は変えないので画面は動かない */
  private pivotToCursor(cx: number, cy: number) {
    const d = this.depthAt(cx, cy);
    if (d == null) return;
    const dist = Math.max(0.3, Math.min(400, d));
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.controls.target.copy(this.camera.position).addScaledVector(dir, dist);
    this.controls.update();
  }

  /** 水平な前方向 */
  private forwardFlat() {
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    return f.normalize();
  }

  /** 目線モードの見回し（yaw: 左右、pitch: 上下、ラジアン） */
  private lookBy(yaw: number, pitch: number) {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    e.y += yaw;
    e.x = Math.max(-Math.PI * 0.42, Math.min(Math.PI * 0.42, e.x + pitch));
    e.z = 0;
    this.camera.quaternion.setFromEuler(e);
    this.syncWalkTarget();
    this.camMoved();
  }

  private syncWalkTarget() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.controls.target.copy(this.camera.position).addScaledVector(dir, 3);
  }

  /** 今いる場所の床の高さ（カメラの真下 4m 以内に床があれば） */
  private floorBelow(): number | null {
    const occ = this.occluder();
    if (!occ) return 0;
    const ray = new THREE.Ray(this.camera.position.clone(), new THREE.Vector3(0, -1, 0));
    const hit = occ.bvh.raycastFirst(ray, THREE.DoubleSide);
    if (hit && hit.distance < 4) return hit.point.y;
    return this.camera.position.y < 4 ? 0 : null;
  }

  /** 目線の高さに降りる（上空から切り替えたときは建物の前に立つ） */
  private enterEyeLevel() {
    const b = this.state?.meta.bbox;
    const pos = this.camera.position;
    if (b && pos.y > 6) {
      // 上空からは、玄関があれば玄関の正面、無ければ今いる方角の建物の外に立つ
      const ent = this.state!.meta.entrance;
      if (ent) pos.copy(ent.pos).addScaledVector(ent.outward, 4);
      else {
        const c = new THREE.Vector3((b.min.x + b.max.x) / 2, 0, (b.min.z + b.max.z) / 2);
        const dir = pos.clone().setY(0).sub(c);
        if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
        dir.normalize();
        const rx = (b.max.x - b.min.x) / 2 + 4;
        const rz = (b.max.z - b.min.z) / 2 + 4;
        pos.copy(c).add(new THREE.Vector3(dir.x * rx, 0, dir.z * rz));
      }
      pos.y = this.eyeHeight;
      const look = b.getCenter(new THREE.Vector3()).setY(this.eyeHeight);
      this.camera.lookAt(look);
    } else {
      const fy = this.floorBelow();
      pos.y = (fy ?? 0) + this.eyeHeight;
      // 水平に近い視線に戻す
      const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      e.x = Math.max(-0.35, Math.min(0.35, e.x));
      e.z = 0;
      this.camera.quaternion.setFromEuler(e);
    }
    this.walkVel.set(0, 0, 0);
    this.walkImpulse.set(0, 0, 0);
    this.syncWalkTarget();
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
    this.motionPR = false;
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
    if (this.keys.size || this.walkVel.lengthSq() > 1e-6 || this.walkImpulse.lengthSq() > 1e-6) this.walk(dt);
    this.stepDoors(dt);
    if (this.drift && !this.anim && this.navMode !== 'walk') {
      // ゆっくり回り込む（高品質描画のまま: 操作扱いにしない）
      const t = this.controls.target;
      const p = this.camera.position.clone().sub(t).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.drift * dt).add(t);
      this.camera.position.copy(p);
      const look = t.clone();
      if (this.camera.shiftY !== 0) look.y = p.y;
      this.camera.lookAt(look);
      // カメラだけが動く: 影は描き直さない
      this._dirty = true;
    }
    const moved = this.navMode === 'walk' ? false : this.controls.update();
    if (moved) this.camMoved();
    // 操作中（直近 0.2 秒以内にカメラが動いた）は後処理なし・低めの解像度で軽く描き、止まったら高品質で1枚描く
    // 操作中（直近 0.35 秒以内にカメラが動いた）は後処理なしで素早く描き、止まったら後処理込みで 1 枚描く。
    // 解像度は切り替えない（切り替えるたびに後処理のバッファを作り直してカクつくため）
    const moving = now - this.lastMove < 350;
    if (moving) {
      if (!this._dirty) return;
      this._dirty = false;
      // 操作中は描く画素を減らす（後処理のバッファには触らないので切り替えは軽い）
      this.setMotionPR(true);
      this.renderer.render(this.scene, this.camera);
      this.onAfterRender?.();
      this.hqPending = true;
      return;
    }
    if (!this._dirty && !this.hqPending) return;
    this._dirty = false;
    this.hqPending = false;
    this.setMotionPR(false);
    this.renderFrame();
  };

  /** 操作中だけ描画の解像度を落とす（高精細ディスプレイで 1.5 倍 → 1 倍。画素数が半分以下になる） */
  private setMotionPR(on: boolean) {
    const want = on ? Math.min(1, this.fullPR()) : this.fullPR();
    if (on === this.motionPR && Math.abs(this.renderer.getPixelRatio() - want) < 0.01) return;
    this.motionPR = on;
    if (Math.abs(this.renderer.getPixelRatio() - want) < 0.01) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(want);
    this.renderer.setSize(w, h, false);
  }

  /** 表示モード（閲覧＝軽快／仕上げ＝高品質）を切り替える */
  setViewMode(mode: 'browse' | 'finish') {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    this.applyViewMode();
    this.dirty = true;
  }

  /**
   * 表示モードの構造的な違い（閲覧は描く量そのものを減らす）:
   *  - 室内の点光源: 閲覧の昼・朝は消す（太陽・空・環境光だけ。点光源は画素ごとの計算が重い）。夕景・夜景は雰囲気に要るので残す
   *  - 影の解像度: 閲覧 2048、仕上げ 4096
   *  - 画素比: 閲覧は 1（高精細画面でも等倍）、仕上げは 1.5 まで
   */
  private applyViewMode() {
    const browse = this.viewMode === 'browse';
    const size = browse ? 2048 : 4096;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      (this.sun.shadow as unknown as { map: unknown }).map = null;
    }
    this.applyLightsVisibility();
    this.applyPixelRatio(this.fullPR());
    this.dirty = true;
  }

  /** 室内の点光源を見せるか（外部モデルで隠している間はそちらが優先） */
  private applyLightsVisibility() {
    if (this.pdfGroupsHidden) return;
    const tod = this.design.timeOfDay;
    const needed = tod === 'evening' || tod === 'night';
    this.groups.lights.visible = this.viewMode === 'finish' || needed;
  }

  /** 画面の解像度（仕上げは高精細ディスプレイでも 1.5 倍まで。閲覧は等倍: 画素数が 2.25 分の 1 になる） */
  private fullPR() {
    return Math.min(window.devicePixelRatio || 1, this.viewMode === 'browse' ? 1 : 1.5);
  }

  private applyPixelRatio(pr: number) {
    if (Math.abs(this.renderer.getPixelRatio() - pr) < 0.01) return;
    this.renderer.setPixelRatio(pr);
    this.resize();
  }

  /** 歩く: W/S・↑/↓ 前後、A/D・←/→ 左右、Q/E 下/上、Shift で速く。慣性を付けてなめらかに動き、壁は通り抜けない */
  private walk(dt: number) {
    const f = this.forwardFlat();
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const want = new THREE.Vector3();
    const k = this.keys;
    if (k.has('w') || k.has('arrowup')) want.add(f);
    if (k.has('s') || k.has('arrowdown')) want.sub(f);
    if (k.has('d') || k.has('arrowright')) want.add(r);
    if (k.has('a') || k.has('arrowleft')) want.sub(r);
    if (k.has('e')) want.y += 1;
    if (k.has('q')) want.y -= 1;
    const walkMode = this.navMode === 'walk';
    // 室内・目線は歩く速さ、外観は建物の大きさに合わせて速く
    const indoor = walkMode || this.camera.position.y < 8;
    const speed = (indoor ? 1.6 : 9) * (k.has('shift') ? 2.5 : 1);
    if (want.lengthSq() > 0) want.normalize().multiplyScalar(speed);
    // 慣性: 加速 0.18 秒、減速 0.25 秒程度
    const tau = want.lengthSq() > 0 ? 0.18 : 0.25;
    const a = 1 - Math.exp(-dt / tau);
    this.walkVel.lerp(want, a);
    if (this.walkVel.lengthSq() < 1e-5 && want.lengthSq() === 0) this.walkVel.set(0, 0, 0);
    const mv = this.walkVel.clone().multiplyScalar(dt);
    // ホイールの前進分は指数的に消化する
    if (this.walkImpulse.lengthSq() > 1e-8) {
      const part = 1 - Math.exp(-dt / 0.12);
      const d = this.walkImpulse.clone().multiplyScalar(part);
      mv.add(d);
      this.walkImpulse.sub(d);
      if (this.walkImpulse.lengthSq() < 1e-6) this.walkImpulse.set(0, 0, 0);
    }
    if (mv.lengthSq() === 0 && !walkMode) return;
    // 壁の通り抜けを防ぐ（壁に沿って滑るように、東西・南北を別々に判定）
    const occ = this.occluder();
    if (occ && mv.lengthSq() > 0) {
      const ray = new THREE.Ray();
      const blocked = (d: THREE.Vector3) => {
        const len = d.length();
        if (len < 1e-6) return false;
        for (const dy of [0, -0.9]) {
          ray.origin.copy(this.camera.position).setY(this.camera.position.y + dy);
          ray.direction.copy(d).normalize();
          const hit = occ.bvh.raycastFirst(ray, THREE.DoubleSide);
          if (hit && hit.distance < len + 0.3) return true;
        }
        return false;
      };
      const dx = new THREE.Vector3(mv.x, 0, 0);
      const dz = new THREE.Vector3(0, 0, mv.z);
      if (blocked(dx)) {
        mv.x = 0;
        this.walkVel.x = 0;
        this.walkImpulse.x = 0;
      }
      if (blocked(dz)) {
        mv.z = 0;
        this.walkVel.z = 0;
        this.walkImpulse.z = 0;
      }
    }
    if (mv.lengthSq() > 0) {
      this.anim = null;
      this.camera.position.add(mv);
      this.controls.target.add(mv);
      this.camMoved();
    }
    // 目線モードは床の高さに追従する（階段も上れる）。Q/E で浮いた分はそのまま
    if (walkMode && !k.has('q') && !k.has('e')) {
      const fy = this.floorBelow();
      if (fy != null) {
        const ty = fy + this.eyeHeight;
        const dy = ty - this.camera.position.y;
        if (Math.abs(dy) > 0.002) {
          const step = dy * (1 - Math.exp(-dt / 0.15));
          this.camera.position.y += step;
          this.controls.target.y += step;
          this.camMoved();
        }
      }
    }
  }

  /** 画面上のボタン（スマホ）から歩く操作を入れる: 'w' 'a' 's' 'd' を押した／離した */
  pressKey(key: 'w' | 'a' | 's' | 'd' | 'shift', on: boolean) {
    if (on) this.keys.add(key);
    else this.keys.delete(key);
    this.dirty = true;
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

  renderFrame(force = false) {
    if (this.quality === 'high' && (force || this.viewMode === 'finish')) this.composer.render();
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
    const ext = this.extStyle();
    for (const g of [this.groups.building, this.groups.roof, this.groups.furniture, this.groups.landscape, this.groups.lights, this.groups.cut]) clearGroup(g);
    this.cutBuilt = null;
    // 天井高の上書き（仕様の調整）
    const ch = this.design.specPatch?.ceilingHeight;
    if (ch) for (const f of model.floors) f.ceilingHeight = Math.min(ch, f.height - 200);
    const { mb, meta } = buildBuilding(model, { exterior: ext, spec: resolveSpec(this.design.specId, this.design.specPatch) });
    const resolve = (k: string) => this.registry.get(k);
    this.groups.building.add(mb.build(resolve, { name: 'building' }));
    // 扉は独立した部品にして、ウォークスルーで開閉できるようにする
    this.doors = [];
    for (const info of meta.doors) {
      const group = new THREE.Group();
      group.name = `door:${info.id}`;
      group.add(info.mb.build(resolve, { name: 'door' }));
      this.groups.building.add(group);
      this.doors.push({ info, group });
    }
    this.setDoors(null);
    const roof = buildRoofs(model, ext, this.design.roofOverride, this.design.roofPitch);
    this.groups.roof.add(roof.mb.build(resolve, { name: 'roof' }));
    this.edgeLines = [];
    this.rebuildEdges([this.groups.building, this.groups.roof]);
    setKitchenFinish({ dark: isDarkColor(interiorFor(this.design).furniture.cabinet.color) });
    setFurnitureVocab(interiorFor(this.design));
    const fur = buildFurniture(model);
    this.groups.furniture.add(fur.mb.build(resolve, { name: 'furniture' }));
    this.groups.furniture.add(contactShadows(fur.occupancy));
    // 実物のモデル（観葉植物・ラウンジチェア）は読み込み後に追加
    const gen = ++this.modelGen;
    void placeModels(fur.models, this.groups.furniture, () => gen === this.modelGen).then((n) => {
      if (n) this.dirty = true;
    });
    const ex0 = model.floors.find((f) => f.exterior)?.exterior;
    const planExt = ex0
      ? {
          cars: ex0.cars.map((c) => ({ x: c.x * MM, z: c.y * MM, dirX: Math.cos((c.rot * Math.PI) / 180), dirZ: Math.sin((c.rot * Math.PI) / 180) })),
          trees: ex0.trees.map((t) => ({ x: t.x * MM, z: t.y * MM, r: t.r * MM })),
        }
      : undefined;
    const land = buildLandscape(meta, ext, model.site, planExt);
    const landG = land.mb.build(resolve, { name: 'landscape', castShadow: false });
    this.groups.landscape.add(landG);
    this.groups.landscape.add(land.trees.build(resolve, { name: 'trees' }));
    this.town = [];
    for (const t of land.town) {
      const g = t.mb.build(resolve, { name: 'town', castShadow: true });
      this.groups.landscape.add(g);
      this.town.push({ g, box: t.box });
    }
    this.cullTown();
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
    this.state = { model, meta, roof: roof.info, site: land.site, plan: land.plan, lights: fur.lights, occupancy: fur.occupancy };
    this.fitShadow();
    this.updateInteriorLights();
    this.updateEnvironment();
    // 切断表示中なら、新しい建物で作り直す
    this.setCut(this.cut);
    // 外部の建物（3DS）で置き換え中なら、作り直した PDF の建物もまた隠す
    this.applyExternalReplace();
    this.dirty = true;
  }

  /** 扉の開き具合を設定（null = 通常表示の状態に戻す）。map に無い扉は閉じる */
  setDoors(open: Map<string, number> | null) {
    this.doorAnim.clear();
    for (const { info, group } of this.doors) {
      const frac = open ? Math.max(0, Math.min(1, open.get(info.id) ?? 0)) : info.staticOpen;
      this.poseDoor(info, group, frac);
    }
    if (this.doors.length) this.camMoved();
  }

  private poseDoor(info: DoorInfo, group: THREE.Group, frac: number) {
    group.position.copy(info.origin);
    group.rotation.set(0, info.yaw0, 0);
    if (info.kind === 'swing') group.rotation.y = info.yaw0 + info.openAngle * frac;
    else group.position.addScaledVector(info.slideDir, info.slideDist * frac);
    group.userData.frac = frac;
  }

  /** クリックで扉を開け閉めする（アニメーション中の扉: id → 目標の開き具合） */
  private doorAnim = new Map<string, number>();
  /** 画面上の点にある扉を開閉する。扉に当たれば true */
  toggleDoorAt(ndc: THREE.Vector2): boolean {
    if (!this.doors.length) return false;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    // 見えている面（Mesh）だけを対象にする（稜線の線や非表示の物に当たらないように）
    const shown = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
      return (o as THREE.Mesh).isMesh === true;
    };
    const vis = this.doors.filter((d) => shown(d.group) || d.group.visible);
    const hits = rc.intersectObjects(vis.map((d) => d.group), true).filter((x) => shown(x.object));
    if (!hits.length) return false;
    // 扉より手前に壁があれば無視
    const wall = rc.intersectObjects([this.groups.building], true).filter((x) => shown(x.object) && !String(x.object.userData.matKey ?? '').startsWith('ext.glass')).find((x) => !this.doors.some((d) => d.group === x.object.parent?.parent || d.group === x.object.parent));
    if (wall && wall.distance < hits[0].distance - 0.05) return false;
    let o: THREE.Object3D | null = hits[0].object;
    while (o && !this.doors.some((d) => d.group === o)) o = o.parent;
    const d = this.doors.find((x) => x.group === o);
    if (!d) return false;
    const cur = (d.group.userData.frac as number | undefined) ?? d.info.staticOpen;
    this.doorAnim.set(d.info.id, cur > 0.5 ? 0 : 1);
    this.dirty = true;
    return true;
  }

  private stepDoors(dt: number) {
    if (!this.doorAnim.size) return;
    for (const [id, target] of [...this.doorAnim]) {
      const d = this.doors.find((x) => x.info.id === id);
      if (!d) {
        this.doorAnim.delete(id);
        continue;
      }
      const cur = (d.group.userData.frac as number | undefined) ?? d.info.staticOpen;
      const step = dt * 1.6;
      const next = Math.abs(target - cur) <= step ? target : cur + Math.sign(target - cur) * step;
      this.poseDoor(d.info, d.group, next);
      if (next === target) this.doorAnim.delete(id);
    }
    this.walkOcc = null;
    this.camMoved();
  }

  /** 扉の一覧（経路の計画用） */
  doorInfos(): DoorInfo[] {
    return this.doors.map((d) => d.info);
  }

  /**
   * 外部の正確な建物（groups.external）が PDF の建物に代わるとき（userData.externalReplaces かつ日照ステップ表示中 userData.externalMounted
   * かつ表示中のメッシュがある）、PDF 由来の建物・屋根・家具・室内照明を隠す。条件が外れたら元に戻す（隠していたときだけ戻すので、
   * 断面表示などの状態を壊さない）。メッシュが 1 つも無い（すべて非表示の）3DS では隠さない（建物が何も無い画面にならないように）
   */
  applyExternalReplace() {
    const hide = this.userData.externalReplaces === true && this.userData.externalMounted === true && externalHasVisibleMesh(this);
    if (hide) {
      for (const g of [this.groups.building, this.groups.roof, this.groups.furniture, this.groups.lights]) g.visible = false;
      this.pdfGroupsHidden = true;
    } else if (this.pdfGroupsHidden) {
      this.groups.building.visible = true;
      this.groups.roof.visible = true;
      this.groups.furniture.visible = this.design.furniture;
      this.pdfGroupsHidden = false;
      this.applyLightsVisibility();
    }
    this.dirty = true;
  }

  /** 遮蔽物のキャッシュ（歩行の壁判定・見どころカメラ）を捨てる。外部の建物が変わったときに呼ぶ */
  invalidateOccluders() {
    this.walkOcc = null;
    this.shotCache = null;
  }

  /** 外部の建物（groups.external）のワールド bbox（無ければ null）。externalBounds があればそれ（全頂点を歩かない） */
  externalBox(): THREE.Box3 | null {
    if (!this.groups.external.children.length) return null;
    if (this.externalBounds) {
      const b = this.externalBounds();
      return b && !b.isEmpty() ? b : null;
    }
    this.groups.external.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(this.groups.external, true);
    return b.isEmpty() ? null : b;
  }

  /** テイスト変更（屋根形状の変更時のみ屋根を再生成） */
  /** 現在の外観テイスト（軒の出の上書きを反映） */
  extStyle() {
    const e = exteriorFor(this.design);
    const ev = this.design.eaves;
    return ev == null ? e : { ...e, roof: { ...e.roof, eaves: ev, verge: Math.min(e.roof.verge, ev) } };
  }

  setDesign(design: DesignOptions) {
    const prev = this.design;
    this.design = design;
    this.registry.update(exteriorFor(design), interiorFor(design), {
      wallColor: design.wallColorOverride,
      doorColor: design.specPatch?.doorColor,
      night: design.timeOfDay === 'night',
      clay: design.clay,
    });
    if (!this.state) return;
    const ext = exteriorFor(design);
    const roofChanged =
      prev.exteriorId !== design.exteriorId || prev.roofOverride !== design.roofOverride || prev.roofPitch !== design.roofPitch || prev.eaves !== design.eaves || prev.specId !== design.specId || JSON.stringify(prev.specPatch) !== JSON.stringify(design.specPatch) || (prev.finishes?.accent ?? '') !== (design.finishes?.accent ?? '');
    if (roofChanged || prev.exteriorId !== design.exteriorId) {
      // 外構・アクセント位置も変わるので建物以外を再構築
      this.setModel(this.state.model);
      return;
    }
    this.registry.apply(this.root);
    if (prev.clay !== design.clay) this.applyEdgeVisibility();
    this.groups.furniture.visible = design.furniture && this.cut == null;
    if (this.cut && prev.furniture !== design.furniture) this.setCut(this.cut);
    if (prev.timeOfDay !== design.timeOfDay) {
      this.updateInteriorLights();
      this.updateEnvironment();
    }
    this.applyLightsVisibility();
    void ext;
    this.dirty = true;
  }

  /**
   * 影の範囲（平行光源の正射影カメラ）を建物に合わせる。
   * PDF の建物（meta.bbox）と外部の建物（groups.external、日照ステップ表示中 = 見えているときだけ）の和にさらに extra を加えた箱を囲む。
   * setModel から毎回呼ばれるので、外部の建物を足した後も setModel で範囲が戻ることはない。
   * 見えていない 3DS（他のステップ）は範囲に入れない（単位違いで巨大なままの 3DS が PDF の建物の影を粗くしないように）
   */
  fitShadow(extra?: THREE.Box3) {
    if (!this.state) return;
    const b = this.state.meta.bbox.clone();
    const ext = this.userData.externalMounted === true || this.groups.external.visible ? this.externalBox() : null;
    if (ext) b.union(ext);
    if (extra && !extra.isEmpty()) b.union(extra);
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5 + 7;
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
    // 照り返し: 日中は床（明るいオーク・タイル）が太陽と空に照らされて天井を照らす。夕景は暖かく弱く、夜は室内灯だけ
    const evening = this.design.timeOfDay === 'evening';
    // 物理的な光の単位（拡散反射で 1/π になる）なので、天井を壁と同じ明るさにするには 2 前後が要る
    this.bounce.intensity = night ? 0.08 : evening ? 0.6 : 0.8 + 1.4 * Math.min(1, Math.max(0, elev * 3));
    this.bounce.color.set(evening ? '#f3d9bd' : '#f4efe8');
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
    this.scene.environmentIntensity = mode === 'night' ? 0.28 : mode === 'morning' ? 0.6 : 0.66;
    this.renderer.toneMappingExposure = mode === 'night' ? 1.5 : mode === 'evening' ? 1.2 : mode === 'morning' ? 1.1 : 1.0;
    // 遠くほど空気に溶ける薄い靄（奥行き感。室内の距離では効かない）。朝は靄が濃い
    const fogCol = mode === 'night' ? '#0a0d14' : mode === 'evening' ? '#d9b79a' : mode === 'morning' ? '#e3e2e6' : '#cfd6dc';
    const fogD = mode === 'morning' ? 0.0036 : 0.0024;
    if (!this.scene.fog) this.scene.fog = new THREE.FogExp2(fogCol, fogD);
    else {
      (this.scene.fog as THREE.FogExp2).color.set(fogCol);
      (this.scene.fog as THREE.FogExp2).density = fogD;
    }
    this.dirty = true;
  }

  // ------------------------------------------------------------------
  // 演出
  // ------------------------------------------------------------------
  private revealToken = 0;
  private town: { g: THREE.Group; box: THREE.Box3 }[] = [];
  private townVisible = true;
  /** 隣家（想定の街並み）の表示。日照では実際の周辺建物を使うので消す */
  setTownVisible(on: boolean) {
    this.townVisible = on;
    this.cullTown();
    this.dirty = true;
  }
  /** カメラと建物の間に入る隣家、カメラに近すぎる隣家は隠す（視界を塞がない） */
  private cullTown() {
    if (!this.town.length) return;
    const cam = this.camera.position;
    const tgt = this.controls.target;
    const ray = new THREE.Ray(cam.clone(), tgt.clone().sub(cam).normalize());
    const dist = cam.distanceTo(tgt);
    const hit = new THREE.Vector3();
    for (const t of this.town) {
      let show = this.townVisible;
      if (show) {
        const grown = t.box.clone().expandByScalar(2.5);
        if (grown.containsPoint(cam)) show = false;
        else if (ray.intersectBox(t.box.clone().expandByScalar(3.2), hit) && hit.distanceTo(cam) < dist - 1) show = false;
        // 高い視点（鳥瞰）では、カメラより手前に張り出す隣家は隠す
        else if (cam.y > 7 && t.box.distanceToPoint(new THREE.Vector3(cam.x, 0, cam.z)) < 10) show = false;
      }
      if (t.g.visible !== show) {
        t.g.visible = show;
        this.dirty = true;
      }
    }
  }
  /** 図面から建物が立ち上がる演出: 地面から屋根まで水平の切断面を持ち上げながら、カメラをゆっくり回し込む */
  playReveal(dur = 2600) {
    if (!this.state || this.cut) return;
    const token = ++this.revealToken;
    const topY = Math.max(this.state.roof.maxY, this.state.meta.topY) + 0.6;
    const view = this.currentView();
    const up = new THREE.Vector3(0, 1, 0);
    const d = view.pos.clone().sub(view.target).applyAxisAngle(up, -0.32).multiplyScalar(1.08);
    const from: CameraView = { ...view, pos: view.target.clone().add(d).add(new THREE.Vector3(0, 0.9, 0)) };
    this.applyView(from);
    this.flyTo(view, dur + 900);
    const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), -0.4);
    const t0 = performance.now();
    const step = () => {
      if (token !== this.revealToken) return;
      const t = Math.min(1, (performance.now() - t0) / dur);
      const k = 1 - Math.pow(1 - t, 3);
      plane.constant = -0.4 + (topY + 0.4) * k;
      this.renderer.clippingPlanes = [plane];
      this.dirty = true;
      if (t < 1) requestAnimationFrame(step);
      else {
        this.renderer.clippingPlanes = [];
        this.dirty = true;
      }
    };
    requestAnimationFrame(step);
  }

  /** シネマ用のゆっくりした回り込み（rad/s。0 で停止） */
  private drift = 0;
  setDrift(radPerSec: number) {
    this.drift = radPerSec;
    if (radPerSec) this.dirty = true;
  }

  // ------------------------------------------------------------------
  // 白模型の線（稜線を細い線で重ねる）
  // ------------------------------------------------------------------
  private edgeLines: THREE.LineSegments[] = [];
  private edgeLinesFor(group: THREE.Group): THREE.LineSegments | null {
    const pos: number[] = [];
    group.updateMatrixWorld(true);
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      const key = (m.userData.matKey as string | undefined) ?? '';
      if (!key || key.startsWith('ext.glass') || key.startsWith('f.') || key === 'cut.north' || key === 'int.ceiling') return;
      let p: THREE.Object3D | null = m.parent;
      let skip = false;
      while (p && p !== group) {
        if (/^(door|cutdoor):/.test(p.name) || p.userData.roomLabel) skip = true;
        p = p.parent;
      }
      if (skip) return;
      const eg = new THREE.EdgesGeometry(m.geometry, 24);
      const a = eg.getAttribute('position');
      const v = new THREE.Vector3();
      for (let i = 0; i < a.count; i++) {
        v.fromBufferAttribute(a, i).applyMatrix4(m.matrixWorld);
        pos.push(v.x, v.y, v.z);
      }
      eg.dispose();
    });
    if (!pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({ color: '#34322f', transparent: true, opacity: 0.55, depthWrite: false });
    const ls = new THREE.LineSegments(geo, mat);
    ls.name = 'edges';
    ls.renderOrder = 3;
    ls.userData.edges = true;
    return ls;
  }

  private rebuildEdges(groups: THREE.Group[]) {
    for (const g of groups) {
      for (const old of this.edgeLines.filter((e) => e.parent === g)) {
        g.remove(old);
        old.geometry.dispose();
        (old.material as THREE.Material).dispose();
      }
      this.edgeLines = this.edgeLines.filter((e) => e.parent !== null && e.parent !== g);
      const ls = this.edgeLinesFor(g);
      if (ls) {
        ls.visible = !!this.design.clay;
        g.add(ls);
        this.edgeLines.push(ls);
      }
    }
  }

  private applyEdgeVisibility() {
    for (const e of this.edgeLines) e.visible = !!this.design.clay;
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

  /** 室内照明（夕景・夜景は点光源＋外部の照明、昼は弱い補助光で室内の暗さを緩和） */
  updateInteriorLights() {
    clearGroup(this.groups.lights);
    if (!this.state) return;
    const tod = this.design.timeOfDay;
    const night = tod === 'night' || tod === 'evening';
    const kelvin = interiorFor(this.design).lightKelvin;
    const col = kelvinToColor(kelvin);
    const used = new Set<string>();
    const dim = tod === 'evening' ? 0.75 : 1;
    for (const l of this.state.lights) {
      const key = `${l.roomId}:${l.kind}`;
      if (!night && used.has(key)) continue;
      used.add(key);
      const intensity = night ? (l.kind === 'ceiling' ? 6 * dim : l.kind === 'pendant' ? 3 * dim : 1.2 * dim) : l.kind === 'ceiling' ? 2.2 : 0;
      if (intensity <= 0) continue;
      const p = new THREE.PointLight(night ? col : new THREE.Color('#fff6ea'), intensity, night ? 7 : 7, night ? 1.6 : 1.0);
      p.position.copy(l.pos);
      // 昼は部屋の中ほどに置いて天井・壁・床をまんべんなく照らす（間接光の近似）
      if (l.kind === 'ceiling') p.position.y -= night ? 0.3 : 1.2;
      this.groups.lights.add(p);
    }
    // 外部の照明（ポーチ・植栽のアップライト・フットライト）。室内の灯りは上で点けているので外す
    if (night) {
      const ext = buildExteriorLights({ meta: this.state.meta, plan: this.state.plan, lights: [], mode: tod, skyE: 1, lampColor: col, physical: false });
      this.groups.lights.add(ext);
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
      // 家具込みの BVH でレイキャストし、室内の見通しを評価（輪切り表示中でも通常の建物で評価する）
      const occ = buildOccluder(this, { buildingOnly: true, furniture: this.design.furniture });
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
    return [...exteriorShots(s.meta, s.site, s.roof, aspect, s.model.northAngleDeg, facadeWindows(s.model)), ...sectionShots(s.model, s.meta, s.site.roadDir, aspect), ...this.shotCache.interiors.get(key)!];
  }

  /** ショットを適用（時間帯・パース用の太陽も切り替え） */
  applyShot(shot: Shot, animate = false) {
    const tod = shot.timeOfDay ?? this.design.timeOfDay;
    if (tod !== this.design.timeOfDay) this.setDesign({ ...this.design, timeOfDay: tod });
    if (shot.sunDir) this.setSunDirection(shot.sunDir);
    this.setCut(shot.cutaway != null ? { level: shot.cutaway } : shot.section ? { section: shot.section } : null);
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
    if (this.navMode === 'walk') this.syncWalkTarget();
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

  /** 輪切り表示中の階（null = 通常表示・断面表示） */
  cutawayLevel(): number | null {
    return this.cut && 'level' in this.cut ? this.cut.level : null;
  }

  /** 現在の切断（輪切り／断面）。null = 通常表示 */
  currentCut(): CutSpec | null {
    return this.cut;
  }

  /** 輪切り模型の部屋名タグの表示／非表示 */
  setRoomLabels(on: boolean) {
    this.roomLabels = on;
    this.groups.cut.traverse((o) => {
      if (o.userData.roomLabel) o.visible = on;
    });
    this.declutterLabels();
    this.dirty = true;
  }

  /** 部屋名の札が画面上で重なるときは、広い部屋の札を優先して残し、重なる札を隠す */
  private declutterLabels() {
    if (!this.roomLabels) return;
    const labels: THREE.Sprite[] = [];
    this.groups.cut.traverse((o) => {
      if (o.userData.roomLabel) labels.push(o as THREE.Sprite);
    });
    if (!labels.length) return;
    const W = this.renderer.domElement.clientWidth || 1;
    const Hh = this.renderer.domElement.clientHeight || 1;
    this.camera.updateMatrixWorld();
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const v = new THREE.Vector3();
    labels.sort((a, b) => (b.userData.labelPriority ?? 0) - (a.userData.labelPriority ?? 0));
    for (const sp of labels) {
      v.setFromMatrixPosition(sp.matrixWorld).project(this.camera);
      if (v.z > 1) {
        sp.visible = false;
        continue;
      }
      const cx = ((v.x + 1) / 2) * W;
      const cy = ((1 - v.y) / 2) * Hh;
      // 画面固定の札の高さ（px）: scale.y は画面の高さに対する割合
      const hpx = (sp.scale.y / (2 * Math.tan((this.camera.fov * Math.PI) / 360))) * Hh + 4;
      const wpx = hpx * (sp.userData.aspect ?? 3);
      const r = { x0: cx - wpx / 2, x1: cx + wpx / 2, y0: cy - hpx / 2, y1: cy + hpx / 2 };
      const hit = placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
      sp.visible = !hit;
      if (!hit) placed.push(r);
    }
  }

  roomLabelsShown() {
    return this.roomLabels;
  }

  /** 輪切り（模型）表示: 指定階の壁を腰の高さで切る。null = 通常表示 */
  setCutaway(level: number | null) {
    this.setCut(level == null ? null : { level });
  }

  /** 断面表示: 鉛直の面で建物を切る（n の向きの側を取り除く）。null = 通常表示 */
  setSection(section: SectionSpec | null) {
    this.setCut(section ? { section } : null);
  }

  /**
   * 切断表示: 建物・屋根・扉・家具を切った状態で作り直して見せる。
   * 切り口は白い断面で閉じる（クリッピングで中身が抜けて見えることが無い）
   */
  setCut(spec: CutSpec | null) {
    const model = this.state?.model;
    const level = spec && 'level' in spec ? spec.level : null;
    const f = level != null && model ? model.floors.find((x) => x.level === level) : undefined;
    const sec = spec && 'section' in spec ? spec.section : null;
    const on = !!model && (!!f || !!sec);
    this.cut = on ? spec : null;
    this.revealToken++;
    this.renderer.clippingPlanes = [];
    this.groups.roof.visible = !on;
    this.groups.building.visible = !on;
    this.groups.furniture.visible = !on && this.design.furniture;
    this.groups.cut.visible = on;
    if (on && model) {
      const key = [JSON.stringify(spec), this.design.exteriorId, this.design.interiorId, this.design.specId, JSON.stringify(this.design.specPatch ?? null), this.design.furniture, this.design.roofOverride ?? '', this.design.roofPitch ?? '', this.design.eaves ?? ''].join('|');
      if (!this.cutBuilt || this.cutBuilt.key !== key) {
        clearGroup(this.groups.cut);
        const ext = this.extStyle();
        const resolve = (k: string) => this.registry.get(k);
        const cutY = f ? f.elevation * MM + CUT_HEIGHT : 0;
        const clip = sec ? verticalClip(sec.nx, sec.nz, sec.d) : topClip(cutY);
        const { mb, meta } = buildBuilding(model, {
          exterior: ext,
          spec: resolveSpec(this.design.specId, this.design.specPatch),
          cut: f ? { level: level!, height: CUT_HEIGHT } : undefined,
          clip: sec ? clip : undefined,
        });
        this.groups.cut.add(mb.build(resolve, { name: 'cut-building' }));
        // 切断面より低い屋根（下屋・ポーチ屋根）／断面では切った屋根を残す
        const cutRoof = buildRoofs(model, ext, this.design.roofOverride, this.design.roofPitch, clip);
        this.groups.cut.add(cutRoof.mb.build(resolve, { name: 'cut-roof' }));
        // 扉は少し開いた状態で固定（間取りのつながりが見える）
        for (const info of meta.doors) {
          const g = new THREE.Group();
          g.name = `cutdoor:${info.id}`;
          g.add(info.mb.build(resolve, { name: 'door' }));
          g.position.copy(info.origin);
          g.rotation.set(0, info.yaw0, 0);
          // 断面では切り口を合わせるため閉じたまま。輪切りでは少し開ける
          const frac = sec ? 0 : info.kind === 'swing' ? Math.max(info.staticOpen, 0.35) : info.staticOpen;
          if (info.kind === 'swing') g.rotation.y = info.yaw0 + info.openAngle * frac;
          else g.position.addScaledVector(info.slideDir, info.slideDist * frac);
          this.groups.cut.add(g);
        }
        // 部屋名タグ（模型の札のように、切り口の少し上に浮かせる）
        if (f) {
          for (const r of f.rooms) {
            if (r.type === 'void' || r.area < 1.2) continue;
            const sp = roomLabelSprite(r);
            if (!sp) continue;
            sp.position.set(r.labelPos.x * MM, cutY + 0.22, r.labelPos.y * MM);
            sp.visible = this.roomLabels;
            this.groups.cut.add(sp);
          }
          // 設計士のメモ（図面の吹き出し）: 薄い生成りの札。部屋名より優先して残す
          for (const n of f.notes ?? []) {
            const sp = tagSprite(n.text, '', 0.02, true, true);
            if (!sp) continue;
            sp.position.set(n.x * MM, cutY + 0.3, n.y * MM);
            sp.userData.labelPriority = 1e9;
            sp.visible = this.roomLabels;
            this.groups.cut.add(sp);
          }
          this.groups.cut.updateMatrixWorld(true);
          this.declutterLabels();
        }
        // 方位（真北）の印を敷地の角に置く（輪切りのみ。断面では壁越しに見えて邪魔になる）
        if (f) this.groups.cut.add(northMarker(this.state!.meta.bbox, model.northAngleDeg, resolve));
        if (this.design.furniture) {
          setKitchenFinish({ dark: isDarkColor(interiorFor(this.design).furniture.cabinet.color) });
    setFurnitureVocab(interiorFor(this.design));
          const fur = buildFurniture(model, { cut: f ? { level: level!, y: cutY } : undefined, clip: sec ? clip : undefined });
          this.groups.cut.add(fur.mb.build(resolve, { name: 'cut-furniture' }));
          if (f) this.groups.cut.add(contactShadows(fur.occupancy, new Set(f.rooms.map((r) => r.id))));
          const gen = this.modelGen;
          const built = { key };
          this.cutBuilt = built;
          void placeModels(fur.models, this.groups.cut, () => gen === this.modelGen && this.cutBuilt === built).then((n) => {
            if (n) this.dirty = true;
          });
        } else {
          this.cutBuilt = { key };
        }
        this.groups.cut.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && (m.userData.matKey?.startsWith('ext.glass') || m.userData.matKey === 'f.water')) {
            m.castShadow = false;
            m.renderOrder = 2;
          }
        });
        this.rebuildEdges([this.groups.cut]);
      }
    }
    this.walkOcc = null;
    this.dirty = true;
  }

  /** 小さなサムネイル用の素早い描画（後処理なし。カメラだけを一時的に切り替える） */
  captureQuick(view: CameraView, width: number, height: number): string {
    const prevView = this.currentView();
    const prev = { pr: this.renderer.getPixelRatio() };
    const prevSize = this.renderer.getSize(new THREE.Vector2());
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.applyView(view);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/jpeg', 0.8);
    // 後処理のバッファ（composer）は触らない: 作り直すたびに GPU メモリを確保し直してカクつく
    this.renderer.setPixelRatio(prev.pr);
    this.renderer.setSize(prevSize.x, prevSize.y, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = Math.max(1, this.container.clientWidth) / Math.max(1, this.container.clientHeight);
    this.camera.updateProjectionMatrix();
    this.applyView(prevView);
    this.dirty = true;
    return url;
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
    this.renderFrame(true);
    const url = this.renderer.domElement.toDataURL(mime, q);
    this.quality = qPrev;
    this.motionPR = false;
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
      // 札（Sprite）のキャンバス画像とマテリアルはその札だけのもの: 捨てないと GPU メモリに残り続ける
      const sp = o as THREE.Sprite;
      if ((sp as unknown as { isSprite?: boolean }).isSprite && o.userData.roomLabel) {
        const mat = sp.material as THREE.SpriteMaterial;
        mat.map?.dispose();
        mat.dispose();
      }
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

/** 鉛直の切断面: (nx, 0, nz) の向きの側を取り除く。d = 面上の点·n（ワールド m） */
export interface SectionSpec {
  nx: number;
  nz: number;
  d: number;
}
/** 切断の指定: 輪切り（階）か断面 */
export type CutSpec = { level: number } | { section: SectionSpec };

/** 真北の印（矢印と N）。模型の脇に置く */
function northMarker(bbox: THREE.Box3, northAngleDeg: number, resolve: (k: string) => THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.name = 'north-marker';
  const na = (northAngleDeg * Math.PI) / 180;
  const nv = new THREE.Vector3(Math.sin(na), 0, -Math.cos(na));
  const pv = new THREE.Vector3(-nv.z, 0, nv.x);
  const base = new THREE.Vector3(bbox.max.x + 1.6, 0.03, bbox.min.z - 1.0);
  const mb = new MeshBuilder();
  const up = new THREE.Vector3(0, 1, 0);
  const tip = base.clone().addScaledVector(nv, 0.9);
  const l = base.clone().addScaledVector(nv, -0.45).addScaledVector(pv, -0.32);
  const r = base.clone().addScaledVector(nv, -0.45).addScaledVector(pv, 0.32);
  const notch = base.clone().addScaledVector(nv, -0.2);
  // 上から見て反時計回り（+y が表）
  mb.polygon('cut.north', [tip, l, notch, r], up);
  // 細いリング
  mb.cylinder('cut.north', base.clone().setY(0.02), 0.62, 0.012, 40, true);
  mb.cylinder('l.ground', base.clone().setY(0.025), 0.57, 0.012, 40, true);
  g.add(mb.build(resolve, { name: 'north', castShadow: false }));
  const sp = tagSprite('N', '', 0.55);
  if (sp) {
    sp.position.copy(tip).addScaledVector(nv, 0.45).setY(0.3);
    g.add(sp);
  }
  return g;
}

/** 部屋名と帖数を書いた札（スプライト）。模型に置く名札のように、常にカメラを向く */
function roomLabelSprite(r: Room): THREE.Sprite | null {
  const name = (r.name.replace(/[（(].*?[)）]/g, '').trim() || r.name).normalize('NFKC');
  const tatami = r.labeledTatami ?? r.area / 1.62;
  const sub = tatami >= 1 ? `${tatami.toFixed(tatami >= 10 ? 0 : 1)}帖` : '';
  const sp = tagSprite(name, sub, 0.024, true);
  if (sp) sp.userData.labelPriority = r.area;
  return sp;
}

/** 白い札に文字を書いたスプライト（高さ h [m]） */
function tagSprite(name: string, sub: string, h: number, screenFixed = false, note = false): THREE.Sprite | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  if (!g) return null;
  const S = 2;
  const font = `${note ? 400 : 500} ${(note ? 17 : 20) * S}px "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif`;
  const subFont = `400 ${14 * S}px "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif`;
  g.font = font;
  const wName = g.measureText(name).width;
  g.font = subFont;
  const wSub = sub ? g.measureText(sub).width + 10 * S : 0;
  const padX = 14 * S;
  const W = Math.ceil(wName + wSub + padX * 2);
  const H = 34 * S;
  c.width = W;
  c.height = H;
  // 白い札（角丸）と細い縁
  const rad = H / 2;
  g.beginPath();
  g.moveTo(rad, 0);
  g.lineTo(W - rad, 0);
  g.quadraticCurveTo(W, 0, W, rad);
  g.lineTo(W, H - rad);
  g.quadraticCurveTo(W, H, W - rad, H);
  g.lineTo(rad, H);
  g.quadraticCurveTo(0, H, 0, H - rad);
  g.lineTo(0, rad);
  g.quadraticCurveTo(0, 0, rad, 0);
  g.closePath();
  g.fillStyle = note ? 'rgba(255,247,226,0.96)' : 'rgba(255,255,255,0.94)';
  g.fill();
  g.lineWidth = 1 * S;
  g.strokeStyle = note ? 'rgba(140,100,40,0.35)' : 'rgba(40,40,40,0.18)';
  g.stroke();
  g.fillStyle = note ? '#4a3a1a' : '#20232a';
  g.textBaseline = 'middle';
  g.font = font;
  g.fillText(name, padX, H / 2 + 1 * S);
  if (sub) {
    g.fillStyle = '#6b6f78';
    g.font = subFont;
    g.fillText(sub, padX + wName + 10 * S, H / 2 + 2 * S);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  // screenFixed: 画面上で一定の大きさ（遠くの札が小さくなりすぎず、近くで巨大にならない）
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, sizeAttenuation: !screenFixed });
  const sp = new THREE.Sprite(mat);
  sp.scale.set((h * W) / H, h, 1);
  sp.userData.aspect = W / H;
  sp.renderOrder = 50;
  sp.userData.roomLabel = true;
  return sp;
}
