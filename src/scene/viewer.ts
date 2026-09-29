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
import { exteriorShots, interiorShots, type Shot } from './shots';
import { buildLandscape, type SiteInfo } from './landscape';
import { MaterialRegistry } from './materials';
import { makeSkyTexture } from './sky';
import { exteriorById, interiorById, type DesignOptions } from '../styles/presets';

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
  };
  registry: MaterialRegistry;
  state: SceneState | null = null;
  design: DesignOptions;
  sunDir = new THREE.Vector3(0.4, 0.7, 0.5).normalize();
  private gtao: GTAOPass;
  private smaa: SMAAPass;
  private dirty = true;
  private raf = 0;
  private skyTex: THREE.DataTexture | null = null;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  quality: 'fast' | 'high' = 'high';
  userData: Record<string, unknown> = {};
  onAfterRender?: () => void;
  private anim: { from: CameraView; to: CameraView; t0: number; dur: number } | null = null;

  constructor(readonly container: HTMLElement, design: DesignOptions) {
    this.design = design;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.addEventListener('change', () => {
      this.dirty = true;
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
    this.loop();
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
    if (this.anim) {
      const t = Math.min(1, (performance.now() - this.anim.t0) / this.anim.dur);
      const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.applyView(lerpView(this.anim.from, this.anim.to, k));
      if (t >= 1) this.anim = null;
      this.dirty = true;
    }
    const moved = this.controls.update();
    if (moved) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.renderFrame();
  };

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
    const { mb, meta } = buildBuilding(model, { exterior: ext });
    const resolve = (k: string) => this.registry.get(k);
    this.groups.building.add(mb.build(resolve, { name: 'building' }));
    const roof = buildRoofs(model, ext, this.design.roofOverride);
    this.groups.roof.add(roof.mb.build(resolve, { name: 'roof' }));
    const fur = buildFurniture(model);
    this.groups.furniture.add(fur.mb.build(resolve, { name: 'furniture' }));
    const land = buildLandscape(meta, ext);
    const landG = land.mb.build(resolve, { name: 'landscape', castShadow: false });
    this.groups.landscape.add(landG);
    this.groups.landscape.add(land.trees.build(resolve, { name: 'trees' }));
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
    this.dirty = true;
  }

  /** テイスト変更（屋根形状の変更時のみ屋根を再生成） */
  setDesign(design: DesignOptions) {
    const prev = this.design;
    this.design = design;
    this.registry.update(exteriorById(design.exteriorId), interiorById(design.interiorId), {
      wallColor: design.wallColorOverride,
      night: design.timeOfDay === 'night',
    });
    if (!this.state) return;
    const ext = exteriorById(design.exteriorId);
    const roofChanged = prev.exteriorId !== design.exteriorId || prev.roofOverride !== design.roofOverride;
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

  private fitShadow() {
    if (!this.state) return;
    const b = this.state.meta.bbox;
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5 + 14;
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
    const c = b ? b.getCenter(new THREE.Vector3()) : new THREE.Vector3();
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
    return [...exteriorShots(s.meta, s.site, s.roof, aspect, s.model.northAngleDeg), ...interiorShots(s.model, s.meta, s.occupancy, aspect)];
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
    this.dirty = true;
  }

  flyTo(v: CameraView, dur = 900) {
    const from = this.currentView();
    if (this.camera.shiftY !== 0) {
      // シフト状態から補間するため、見かけの注視点を復元
      from.target = from.pos.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).multiplyScalar(10));
      from.target.y += this.camera.shiftY * Math.tan((this.camera.fov * Math.PI) / 360) * 10;
    }
    this.anim = { from, to: v, t0: performance.now(), dur };
    this.dirty = true;
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
