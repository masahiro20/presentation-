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
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { BuildingModel, Room } from '../core/types';
import { buildBuilding, CUT_HEIGHT, MM, type BuildingMeta, type DoorInfo } from './building';
import { MeshBuilder, topClip, verticalClip } from './meshBuilder';
import { buildRoofs, type RoofInfo } from './roof';
import { buildFurniture, setKitchenFinish, setFurnitureLighting, setFurnitureVocab, type LightPoint, type Footprint } from './furniture';
import { contactShadows } from './contactShadow';
import { placeModels } from './models';
import { distantTreeBand } from './distant';
import { hdriScreenTexture, loadHdri, type Hdri } from './hdri';
import { exteriorShots, sectionShots, interiorShots, facadeWindows, type Shot } from './shots';
import { buildOccluder, externalHasVisibleMesh } from '../sun/analysis';
import { buildLandscape, planExteriorOf, type SiteInfo, type LandscapePlan } from './landscape';
import { buildExteriorLights, windowPortals, type WindowPortal } from './interiorLights';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { MaterialRegistry, lampTint } from './materials';
import { roomProbeUniforms } from './roomProbe';
import { pointInPolygon } from '../core/geometry';
import { labelNotes } from '../core/planNotes';
import { makeNeutralEnvTexture, makeSkyTexture } from './sky';
import { exteriorById, interiorById, type DesignOptions, type ExteriorStyle } from '../styles/presets';
import { exteriorFor, interiorFor, stairBuildOf } from '../coordinate/catalog';
import { preloadPhotoTextures } from '../styles/photoTextures';
import { clearMaterialCache } from '../styles/textures';
import { resolveSpec } from '../styles/spec';

/** 建築パース用カメラ: レンズシフトで縦線を垂直に保つ */
/** 暗い色か（キッチンの扉の色でレンジフードをシルバー／ブラックに振り分ける） */
function isDarkColor(hex: string): boolean {
  const c = new THREE.Color(hex);
  // 御社の事例: グレーの扉はフードも黒。明るいグレージュ（モルタライト）・白系の扉は、ステンレス・白のフード
  // （堀様の提案パース: グレージュのアイランドに白いフード。以前はモルタライトも「暗い色」に入り、黒いフードになっていた）
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b < 0.3;
}

/** 窓からの空の光（面の光）: 同時に使う数・窓の明るさ（輝度）／昼の室内の補助光（部屋の真ん中の点の光）の強さ */
/** 窓からの空の光（面の光）を同時に使う数（数を変えるとシェーダーを作り直すので固定） */
const PORTAL_MAX = 4;

/**
 * 絵づくりの値（光の配分・にじみ・階調）。1 か所にまとめて、点検のときは実行中に差し替えて見比べられるようにする
 * （viewer.look を書き換えて applyLook()）
 */
export const DEFAULT_LOOK = {
  /** 室内（昼・仕上げ表示）の均一な光の倍率: 空の拡散光・床の照り返し・無地の環境光 */
  hemi: 0.22,
  bounce: 0.18,
  env: 0.32,
  /**
   * 窓の明るさ（面の光の輝度）・室内側へ出す距離 (m)・下へ傾ける量。
   * 傾けると、窓の脇の壁に光の境目が斜めの線で出るので 0 にしている
   */
  portalL: 3.4,
  portalInset: 0.1,
  portalTilt: 0,
  /** 昼の室内の補助光（部屋の真ん中の点の光） */
  dayFill: 0.15,
  /** 夕景・夜の室内: ダウンライト（下向きの光）の強さ・床からの照り返し（天井と壁の上を照らす） */
  lampSpot: 11,
  nightBounce: 0.5,
  /**
   * 室内の露出を壁の明るさに合わせる強さ（0 = 合わせない）。濃い壁の部屋は、カメラと同じように露出を上げる:
   * 均一な光を減らしたぶん、濃いグレーの壁の家は真っ暗になる。上げると窓の外は白く飛ぶが、写真の内観もそうなる
   */
  autoExposure: 0.3,
  /** 室内（昼）の露出の底上げ: 均一な光を減らしたぶん、白い壁がグレーに沈んで見えないように */
  interiorBoost: 1.22,
  /** 光のにじみ: 強さ・広がり・にじみ始める明るさ */
  bloom: 0.13,
  bloomRadius: 0.62,
  bloomThreshold: 1.2,
  /** 仕上げの階調: 周辺減光・中間の明暗・彩度 */
  vignette: 0.14,
  contrast: 0.12,
  saturation: 1.03,
  /** 部屋の映り込みの強さ */
  probeGain: 1,
};

/** 仕上げの階調（画面に出す直前の色に掛ける）: 周辺減光・中間の明暗・彩度 */
const GRADE_SHADER = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignette: { value: DEFAULT_LOOK.vignette },
    contrast: { value: DEFAULT_LOOK.contrast },
    saturation: { value: DEFAULT_LOOK.saturation },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float contrast;
    uniform float saturation;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D( tDiffuse, vUv );
      vec2 q = ( vUv - 0.5 ) * vec2( 1.0, 0.82 );
      float edge = smoothstep( 0.32, 0.78, length( q ) );
      c.rgb *= 1.0 - vignette * edge;
      vec3 s = c.rgb * c.rgb * ( 3.0 - 2.0 * c.rgb );
      c.rgb = mix( c.rgb, s, contrast );
      float l = dot( c.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      c.rgb = mix( vec3( l ), c.rgb, saturation );
      gl_FragColor = c;
    }`,
};

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

/** クリックした点の下にある物（どのグループの、どの素材の面か） */
export interface PickHit {
  group: 'building' | 'furniture' | 'landscape' | 'roof' | 'cut' | 'ground';
  matKey: string;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
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
    /** 日照の地形（国土地理院の標高。src/sun/context.ts が置く。解析の遮蔽物の種別 'terrain'） */
    terrain: new THREE.Group(),
    overlay: new THREE.Group(),
    lights: new THREE.Group(),
    /** 設計の 3D データ（3DS など）で置き換えた正確な建物。setModel では消さない（src/app/externalBuilding.ts が管理） */
    external: new THREE.Group(),
  };
  registry: MaterialRegistry;
  state: SceneState | null = null;
  design: DesignOptions;
  /** 開閉できる扉（部品ごとの Group） */
  /** at: 閉じた状態の板の中心（y は板の下端 = その階の床） */
  private doors: { info: DoorInfo; group: THREE.Group; at: THREE.Vector3 }[] = [];
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
    if (v) this.shadowDirty = true;
  }
  /**
   * 影の描き直しが要る。three.js の needsUpdate は「次の render() で 1 回」なので、ここで直接立てると
   * 環境マップ（PMREM）やサムネイルなど別の描画に食われて、画面の影が古いまま（全部影の中）になる。
   * 自分の描画の直前（flushShadow）で立てる
   */
  private shadowDirty = true;
  private flushShadow() {
    if (!this.shadowDirty) return;
    this.shadowDirty = false;
    this.renderer.shadowMap.needsUpdate = true;
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
  /** ホイールのズームで残っている移動量（数フレームかけてなめらかに消化する） */
  private zoomRemain = new THREE.Vector3();
  /** 操作中の 1 コマにかかった時間の平均（重い環境では操作中だけ解像度を下げる） */
  private motionFrameMs = 16;
  private lastTick = performance.now();
  private camMoved() {
    this.cullTown();
    this.syncDayLights();
    this.declutterLabels();
    this._dirty = true;
    this.lastMove = performance.now();
  }
  /**
   * 昼の室内の補助光（点光源）は壁・屋根で遮られないので、外から見ると 2 階の部屋の光が外壁を抜けて
   * 下の屋根や外壁に光の丸を落とす。カメラが建物の外にいる昼は消す（夕景・夜景は窓の灯りとして点けたまま）
   */
  private syncDayLights() {
    this.applyLightsVisibility();
    this.applyLightBalance();
  }
  /**
   * 光の配分（外観／内観）。室内は床の照り返し・空の拡散光を強めにして天井まで明るく（これまでの値）。
   * 外から見るときは、その拡散光が外壁を一様に照らして「日なたも日陰も同じ灰色」の平板な絵になっていたので、
   * 拡散光を抑えて太陽の明暗（日なた・日陰・影）を立てる。写真の外観はこの明暗差で立体に見える
   */
  private lightBase = { sun: 0, hemi: 0, bounce: 0, env: 0.66 };
  /**
   * 室内から外を見るとき、ガラスに室内の明るい環境が映り込んで、窓の外の木や中庭が白くかすんで見えていた。
   * 室内の視点では映り込みとガラスの色の濃さを抑える（御社の提案パースは、ガラス越しの中庭の緑がはっきり見える）
   */
  private tuneGlass(outside: boolean) {
    const g = this.registry.get('ext.glass') as THREE.MeshPhysicalMaterial;
    if (!g?.userData?.isGlass) return;
    const night = this.design.timeOfDay === 'night';
    const env = outside ? 1.1 : 0.15;
    const op = night ? 0.08 : outside ? 0.13 : 0.05;
    if (g.envMapIntensity !== env || g.opacity !== op) {
      g.envMapIntensity = env;
      g.opacity = op;
      this._dirty = true;
    }
  }
  private balanceOutside: string | null = null;
  /** 時間帯ごとの露出（室内では壁の明るさで補正する前の値） */
  private exposureBase = 1;
  private applyLightBalance(force = false) {
    const outside = !this.cameraInside();
    this.tuneGlass(outside);
    // 窓からの面の光が点いているか（仕上げ表示の室内）。閲覧表示では点けないので、均一な光を今までどおりにする
    const portalsOn = !outside && this.portalGroup.visible;
    const balanceKey = `${outside}|${portalsOn}`;
    if (!force && balanceKey === this.balanceOutside) return;
    this.balanceOutside = balanceKey;
    const night = this.design.timeOfDay === 'night';
    const b = this.lightBase;
    if (outside && !night) {
      this.sun.intensity = b.sun * 1.25;
      this.hemi.intensity = b.hemi * 0.5;
      this.bounce.intensity = b.bounce * 0.3;
      this.scene.environmentIntensity = b.env * 0.7;
    } else if (!outside && !night) {
      // 室内（昼）: 全体を均一に照らす光（空の拡散光・床の照り返し・環境光）を少し抑えて、窓から入る日差しとの明暗を残す。
      // 御社の提案パースは、白い壁でも面ごとに明るさが違い、奥は暗く沈む。以前の値では白い壁が白飛びして平板だった
      // 2026-11-13: 窓からの光を面の光（assignPortals）で入れたので、均一な光はさらに抑える。窓の近くから奥へ、明るさの勾配ができる
      this.sun.intensity = b.sun;
      // 夕景は今までどおり: 均一な光を抑えると、照明の暖色だけが勝って橙色に寄りすぎる
      const cut = portalsOn && this.design.timeOfDay !== 'evening';
      this.hemi.intensity = b.hemi * (cut ? this.look.hemi : 0.8);
      this.bounce.intensity = b.bounce * (cut ? this.look.bounce : 0.72);
      this.scene.environmentIntensity = b.env * (cut ? this.look.env : 0.9);
    } else if (outside) {
      // 夜の外観: 空の残光と街の明かりの分だけ周囲光を足す（建物が真っ黒な影にならず、外壁の形が読める）
      this.sun.intensity = b.sun;
      this.hemi.intensity = 0.3;
      this.bounce.intensity = b.bounce;
      this.scene.environmentIntensity = 0.55;
    } else {
      // 夜の室内: 照明は下向き（updateInteriorLights）。天井と壁の上の方は、床・家具からの照り返しで明るくなる
      this.sun.intensity = b.sun;
      this.hemi.intensity = b.hemi;
      this.bounce.intensity = Math.max(b.bounce, this.look.nightBounce);
      this.scene.environmentIntensity = b.env;
    }
    // 露出: 室内（面の光あり）は壁の明るさに合わせる
    this.renderer.toneMappingExposure = this.exposureBase * (portalsOn && this.design.timeOfDay !== 'evening' ? this.wallExposureGain() : 1);
    // 光のにじみ: 屋外の昼は弱く（日なたの白い壁や隣家の箱まで光って見える）。室内と夕景・夜景は、窓・照明がにじむ
    const dusk = this.design.timeOfDay === 'evening' || night;
    this.bloom.strength = this.lowPower ? 0 : this.look.bloom * (outside && !dusk ? 0.35 : 1);
    this.bloom.enabled = !this.lowPower && this.screenFinish;
    // 室内の視点では空（青）の環境光をやめ、暖かい無彩色の環境光にする（グレーの壁・白い布が青くかぶらない）
    const indoorEnv = !outside && this.envIndoorRT ? this.envIndoorRT.texture : this.envRT?.texture ?? null;
    if (this.scene.environment !== indoorEnv) this.scene.environment = indoorEnv;
    this.hemi.color.set(outside ? '#dbe8ff' : '#efeae2');
    this._dirty = true;
  }
  /**
   * 壁の明るさに合わせた露出の倍率。白い壁（明るさ 0.76）を 1 として、濃い壁ほど上げる（カメラが暗い部屋で露出を上げるのと同じ）
   */
  wallExposureGain(): number {
    if (this.look.autoExposure <= 0) return this.look.interiorBoost;
    const wc = new THREE.Color(interiorFor(this.design).wall.color);
    const lum = 0.2126 * wc.r + 0.7152 * wc.g + 0.0722 * wc.b;
    return Math.min(2.6, this.look.interiorBoost * Math.max(1, Math.pow(0.76 / Math.max(0.06, lum), this.look.autoExposure)));
  }
  /** 内観の露出の倍率（昼・朝で、窓からの面の光が使えるときだけ壁の明るさに合わせる。夕景・夜景・スマホは 0 = 今までどおり） */
  interiorExposureGain(): number {
    const tod = this.design.timeOfDay;
    return this.portalLights.length > 0 && (tod === 'day' || tod === 'morning') ? this.wallExposureGain() : 0;
  }
  /** 光の配分と露出を、いまの状態（室内／屋外・照明の表示）で計算し直す（書き出しの前後で呼ぶ） */
  refreshLightBalance() {
    this.applyLightBalance(true);
  }
  /**
   * 画面用の後処理（光のにじみ・階調）を切る／戻す。
   * 書き出し（カット集・資料の下絵）は、2D の写真仕上げ（finishPhoto）が同じ処理をするので、二重に掛けない
   */
  setScreenFinish(on: boolean) {
    this.screenFinish = on;
    this.bloom.enabled = on && !this.lowPower;
    this.grade.enabled = on;
  }
  private screenFinish = true;
  /**
   * スマホ・タブレット（指で操作する端末）: 面の光（窓からの光）と光のにじみは使わない。
   * どちらも画面の全部の点で計算が増えるので、歩いている間のコマ数が落ちる。光の配分は今までどおり
   */
  readonly lowPower = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  /** カメラが建物の箱の中（室内の視点）か */
  private cameraInside(): boolean {
    const b = this.state?.meta.bbox;
    const p = this.camera.position;
    return !!b && p.x > b.min.x + 0.2 && p.x < b.max.x - 0.2 && p.z > b.min.z + 0.2 && p.z < b.max.z - 0.2 && p.y < b.max.y;
  }
  private raf = 0;
  private skyTex: THREE.DataTexture | null = null;
  /** 空を背景（scene.background）ではなく大きな球で描く（縦画面・広い画角で背景の立方体が崩れる環境向け。体験リンクで使う） */
  private skyDome: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null = null;
  /**
   * 実写の空（雲のある空の写真）の球と、地平線のかすみの帯。
   * 画面の空が平らなグラデーションだと絵が冷たく見えるので、外観を立ち上げた最初から写真の空にする。
   * 球・帯はレイヤー 1 に置き、画面のカメラだけが写す（立面図の作図・部屋の映り込みの撮影には写らない）
   */
  private photoSky: { dome: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>; haze: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>; mode: string; hdri: Hdri } | null = null;
  /** 画面に実写の空を使うか。日照の検討（時刻で空の色が変わる）では手続きの空に戻す */
  private photoSkyOn = true;
  private photoSkyToken = 0;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  /** 室内の視点用の環境光（空の青を持ち込まない暖かい無彩色）。施工写真の室内は白が白く、グレーがグレーに見える */
  private envIndoorRT: THREE.WebGLRenderTarget | null = null;
  /** 部屋の映り込み（roomProbe.ts）: いまいる部屋の中心から撮った 6 面の絵 */
  private probeRT: THREE.WebGLCubeRenderTarget | null = null;
  private probeCam: THREE.CubeCamera | null = null;
  private probeEnv: THREE.WebGLRenderTarget | null = null;
  private probeRoom = '';
  private probeDirty = true;
  /** 窓からの空の光（面の光）: 外壁の窓の一覧と、いまいる部屋の窓に割り当てる光の持ち駒 */
  /** 絵づくりの値（DEFAULT_LOOK）。書き換えたら applyLook() */
  look = { ...DEFAULT_LOOK };
  applyLook() {
    this.bloom.radius = this.look.bloomRadius;
    this.bloom.threshold = this.look.bloomThreshold;
    const gu = this.grade.uniforms as Record<string, { value: number }>;
    gu.vignette.value = this.look.vignette;
    gu.contrast.value = this.look.contrast;
    gu.saturation.value = this.look.saturation;
    roomProbeUniforms.roomProbeGain.value = this.look.probeGain;
    this.portalKey = '';
    this.updateInteriorLights();
    this.applyLightBalance(true);
    this.dirty = true;
  }
  /** 室内の灯りの 2 組（室内から見るとき／外から見るとき）。updateInteriorLights が作る */
  private lampSets: { inner: THREE.Group; outer: THREE.Group } | null = null;
  private portals: WindowPortal[] = [];
  private portalLights: THREE.RectAreaLight[] = [];
  private portalGroup = new THREE.Group();
  private portalKey = '';
  private bloom!: UnrealBloomPass;
  private grade!: ShaderPass;
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
    // 影の縁をやわらかく（PCFSoft）。写真仕上げ（studio）と同じ
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 影はカメラを動かしただけでは変わらないので、場面が変わったときだけ描き直す
    this.renderer.shadowMap.autoUpdate = false;
    // 写真的なトーン（ハイライトの転び方が自然で、白い壁が飛ばない）
    // レイヤー 1 = 実写の空の球とかすみの帯（画面のカメラだけが写す）
    this.camera.layers.enable(1);
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
    // 面の光（窓からの空の光）の計算に使う表を用意し、持ち駒を置く。数を変えるとシェーダーを作り直すので、
    // いつも同じ数だけ置き、使わない分は明るさ 0 にする。室内の昼の点の光（groups.lights）と違い、閲覧表示でも使う
    RectAreaLightUniformsLib.init();
    this.portalGroup.name = 'window-portals';
    this.portalGroup.visible = false;
    for (let i = 0; i < (this.lowPower ? 0 : PORTAL_MAX); i++) {
      const pl = new THREE.RectAreaLight('#eef3ff', 0, 1, 1);
      this.portalLights.push(pl);
      this.portalGroup.add(pl);
    }
    this.scene.add(this.portalGroup);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.rotateSpeed = 0.85;
    this.controls.panSpeed = 1.1;
    this.controls.zoomSpeed = 1.2;
    // 上も見上げられるように、カメラが回転の中心より下へ回り込むのを許す。床・地面より下には行かず、
    // 床に当たったら回転の中心のほうを持ち上げて見上げを続ける（clampAboveFloor）
    this.controls.maxPolarAngle = Math.PI * 0.97;
    // ホイールは自前で処理する（OrbitControls のズームは中心に近づくほど一歩が小さくなり、途中で進まなくなる）。
    // 指 2 本のつまみは OrbitControls のまま（カーソル位置へ寄る）
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 0.05;
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
      if (!d0 || e.button !== 0) return;
      if (Math.hypot(e.clientX - d0.x, e.clientY - d0.y) > 5 || performance.now() - d0.t > 400) return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      // 家具を置く・選ぶモードでは、扉の開閉より先にクリックを渡す（模型・断面の表示でも、上から見て家具を置ける）
      if (this.onPick) {
        const p = this.pickPoint(ndc);
        if (p) {
          this.onPick(p, ndc);
          return;
        }
      }
      // 扉の開閉は通常表示だけ（模型では扉を少し開けた形で作り直している）
      if (!this.cut && this.toggleDoorAt(ndc)) return;
      // 道具を開いていなければ、クリックした物を選んで直す（歩くモードでは扉の開閉だけ）
      if (this.onPickIdle && this.navMode !== 'walk') {
        const hit = this.pickHit(ndc);
        if (hit) this.onPickIdle(hit, ndc);
      }
    });
    el.addEventListener('pointerdown', (e) => {
      this.pressPt = { x: e.clientX, y: e.clientY };
      // 選んだ物を掴んで動かす（家具・外構の道具が受け取る）。カメラ操作より先に判定
      if (e.button === 0 && this.onDragStart && this.navMode !== 'walk') {
        const r = el.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        // ハンドル（回転・幅・軒の出の印）の上で押したときは、その印の位置を押した点にする（奥の面に当てると、面の高さの分だけ滑る面がずれる）。
        // それ以外は押した面そのもの（窓ガラスも含む）の点。pickPoint はガラスを飛ばして奥の床に当たるので、窓を掴めない
        const hd = this.pickHandle(ndc);
        const p = hd ? hd.pos.clone() : (this.pickHit(ndc)?.point ?? this.pickPoint(ndc));
        if (p && this.onDragStart(p, ndc)) {
          this.drag = { y: p.y, sx: e.clientX, sy: e.clientY, moved: false, last: p.clone() };
          this.controls.enabled = false;
          el.setPointerCapture(e.pointerId);
          el.style.cursor = 'grabbing';
          return;
        }
      }
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
    // ホバー: 選べる物（家具・外構の物・扉・シャッター・窓）の上ではカーソルを手の形に（CAD のように「触れる物」が分かる）。100ms に 1 回だけ当たり判定
    let hoverAt = 0;
    el.addEventListener('pointermove', (e) => {
      this.lastPtr = { x: e.clientX, y: e.clientY };
      if (this.drag) {
        const d = this.drag;
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true;
        this.dragMods = { shift: e.shiftKey, alt: e.altKey };
        const p = this.planePoint(e.clientX, e.clientY, d.y);
        if (p) {
          d.last.copy(p);
          const r = el.getBoundingClientRect();
          this.onDragMove?.(p, new THREE.Vector2(((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1, -((e.clientY - r.top) / Math.max(1, r.height)) * 2 + 1));
        }
        return;
      }
      // カメラ操作が始まった（ボタンを押したまま 3px 以上動かした）ら、外観の 2 点透視のシフトを解く。
      // 押しただけ（クリック）では解かない: クリックの当たり判定が見えている絵とずれないように（start で解いていた頃は外観で窓・屋根を選べなかった）
      if (e.buttons !== 0 && this.pressPt && this.camera.shiftY && this.navMode !== 'walk' && Math.hypot(e.clientX - this.pressPt.x, e.clientY - this.pressPt.y) > 3) {
        this.camera.shiftY = 0;
        this.camera.updateProjectionMatrix();
        this._dirty = true;
      }
      if (this.navMode === 'walk' || e.buttons !== 0) return;
      const now = performance.now();
      if (now - hoverAt < 100) return;
      hoverAt = now;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      // ハンドルの上は常に「掴める」
      if (this.handles.length && this.pickHandle(ndc)) {
        if (el.style.cursor !== 'pointer') el.style.cursor = 'pointer';
        return;
      }
      const hit = this.pickHit(ndc);
      const k = hit?.matKey ?? '';
      const touchable = !!hit && (hit.group === 'furniture' || (hit.group === 'landscape' && k.startsWith('x.')) || k.startsWith('int.stairs') || (!this.cut && /^(ext|int)\.(door|glass\w*|shutter|frame)/.test(k)));
      const want = touchable ? 'pointer' : this.navMode === 'pan' ? 'grab' : '';
      if (el.style.cursor !== want) el.style.cursor = want;
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
    const endDrag = (e: PointerEvent) => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      this.controls.enabled = true;
      el.style.cursor = '';
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // 取得していないときは何もしない
      }
      const p = this.planePoint(e.clientX, e.clientY, d.y) ?? d.last;
      this.dragMods = { shift: e.shiftKey, alt: e.altKey };
      const r = el.getBoundingClientRect();
      this.setDragLabel(null);
      this.onDragEnd?.(p, d.moved, new THREE.Vector2(((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1, -((e.clientY - r.top) / Math.max(1, r.height)) * 2 + 1));
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    const endPtr = (e: PointerEvent) => {
      this.pressPt = null;
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
        if (this.navMode !== 'walk') {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.wheelZoom(e);
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        // ホイール 1 目盛りで約 0.6m 前進（なめらかに進む）
        const step = -e.deltaY * (e.deltaMode === 1 ? 0.2 : 0.006);
        this.walkImpulse.addScaledVector(this.forwardFlat(), step);
        this.anim = null;
      },
      { passive: false, capture: true },
    );
    // 操作を始めたら飛行中の構図移動は止める。外観の 2 点透視のシフト（shiftY）はここでは解かない:
    // start は押した瞬間に来るので、クリックの当たり判定（pointerdown / pointerup）が見えている絵と上下にずれ、
    // 外観で窓や屋根をクリックすると別の所（下の壁など）を選んでいた。シフトはカメラ操作で実際に動かし始めたときに解く（pointermove）
    this.controls.addEventListener('start', () => {
      this.anim = null;
    });

    this.scene.add(this.root);
    this.selGroup.name = 'selection';
    this.scene.add(this.selGroup);
    this.handleGroup.name = 'handles';
    this.scene.add(this.handleGroup);
    this.dimGroup.name = 'dims';
    this.scene.add(this.dimGroup);
    for (const g of Object.values(this.groups)) this.root.add(g);
    // 地形は周辺環境（context）の子: 日照ステップ以外で context を隠すと一緒に隠れる。解析の遮蔽物は groups.terrain を別の種別で焼き込む
    this.groups.context.add(this.groups.terrain);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 3;
    // 照り返しは下から上へ（HemisphereLight は position の向きが「空」側）
    this.bounce.position.set(0, -1, 0);
    this.scene.add(this.sun, this.sun.target, this.hemi, this.bounce);

    this.registry = new MaterialRegistry(exteriorFor(design), interiorFor(design), { night: design.timeOfDay === 'night', evening: design.timeOfDay === 'evening', clay: design.clay });
    // 実写の空は、図面を読んでいる間に先に読み込んでおく（外観が立ち上がった最初のコマから雲のある空にする）
    void loadHdri(design.timeOfDay);
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
    // 葉のカード（葉の絵を貼った透過の板）は陰影の計算から外す。板の四角い輪郭のまま陰が付き、室内の鉢植えの木のまわりの壁に
    // 白い破片のような模様が出ていた（外の木でも、壁際で同じ模様になる）
    const gt = this.gtao as unknown as { _overrideVisibility: () => void; _visibilityCache: THREE.Object3D[]; scene: THREE.Scene };
    const baseOverride = gt._overrideVisibility.bind(gt);
    gt._overrideVisibility = () => {
      baseOverride();
      gt.scene.traverse((o) => {
        // 図の札・印（userData.noAO。日照の太陽の通り道など）も陰影の計算に入れない
        if (o.visible && (o.userData.noAO || ((o as THREE.Mesh).isMesh && String(o.userData.matKey ?? '').startsWith('l.leaf')))) {
          o.visible = false;
          gt._visibilityCache.push(o);
        }
      });
    };
    this.composer.addPass(this.gtao);
    // 光のにじみ: とても明るい所（窓の外の空・日なた・照明）だけが、まわりへ少しあふれる。写真のレンズと同じで、
    // 「光っている」ことが伝わる（にじみが無いと、照明も窓もただの白い面に見える）
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), this.look.bloom, this.look.bloomRadius, this.look.bloomThreshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    // 仕上げの階調: 周辺を少し落として視線を中央へ集め、中間の明暗をわずかに立てる（建築写真の現像と同じ手順）
    this.grade = new ShaderPass(GRADE_SHADER);
    this.composer.addPass(this.grade);
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
    if (prev === 'walk' && mode !== 'walk') this.closeAutoDoors();
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

  /** クリックした点を受け取る（家具を置く・選ぶモード）。null で通常（扉の開閉 → onPickIdle） */
  onPick: ((p: THREE.Vector3, ndc?: THREE.Vector2) => void) | null = null;
  /** 道具を開いていないときのクリック（扉・シャッターでなければ呼ばれる）: クリックした物をそのまま選んで直す */
  onPickIdle: ((hit: PickHit, ndc: THREE.Vector2) => boolean) | null = null;
  /**
   * 選んだ物を掴んで動かす（家具・外構の道具）。押した点で true を返すとカメラ操作を止め、
   * 押した点と同じ高さの水平面に沿った点を move / end に渡す（end の moved は 3px 以上動いたか）
   */
  onDragStart: ((p: THREE.Vector3, ndc: THREE.Vector2) => boolean) | null = null;
  onDragMove: ((p: THREE.Vector3, ndc: THREE.Vector2) => void) | null = null;
  onDragEnd: ((p: THREE.Vector3, moved: boolean, ndc: THREE.Vector2) => void) | null = null;
  private drag: { y: number; sx: number; sy: number; moved: boolean; last: THREE.Vector3 } | null = null;
  /** ドラッグ中の修飾キー（Shift = 細かく／自由、Alt = 格子に止めない）。道具が move の中で読む */
  dragMods = { shift: false, alt: false };
  /** 選んだ物の足元の枠（CAD の選択表示）。撮影には写さない */
  private selGroup = new THREE.Group();
  /** CAD のハンドル（回転・大きさ・軒の出・勾配を掴む印）。画面上の大きさは一定。撮影には写さない */
  private handleGroup = new THREE.Group();
  private handles: Handle3D[] = [];
  private dragLabelEl: HTMLDivElement | null = null;
  /** 寸法線: 線は 3D（物の手前でも見える）、札は HTML で毎コマ位置を合わせる。撮影には写さない */
  private dimGroup = new THREE.Group();
  private dimLabels: { el: HTMLDivElement; p: THREE.Vector3; a: THREE.Vector3; b: THREE.Vector3; gap: boolean }[] = [];
  /** 寸法の札で数値（mm）を打ったとき。道具（家具・窓戸）が設定する */
  onDimEdit: ((id: string, valueMm: number) => void) | null = null;
  private lastPtr = { x: 0, y: 0 };
  /** ボタンを押した位置（カメラ操作が始まったかの判定: 3px 以上動いたら 2 点透視のシフトを解く） */
  private pressPt: { x: number; y: number } | null = null;

  /** world の点 → キャンバス上の画素（左上原点） */
  toScreen(p: THREE.Vector3): { x: number; y: number } {
    const r = this.renderer.domElement.getBoundingClientRect();
    const q = p.clone().project(this.camera);
    return { x: ((q.x + 1) / 2) * r.width, y: ((1 - q.y) / 2) * r.height };
  }
  /** 画面の点（NDC）→ キャンバス上の画素 */
  ndcToScreen(ndc: THREE.Vector2): { x: number; y: number } {
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: ((ndc.x + 1) / 2) * r.width, y: ((1 - ndc.y) / 2) * r.height };
  }
  /** 画面の点から、anchor を通りカメラに正対する鉛直面との交点（高さ方向のドラッグ用: 勾配・パラペット・高さ） */
  verticalPoint(ndc: THREE.Vector2, anchor: THREE.Vector3): THREE.Vector3 | null {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const n = this.camera.getWorldDirection(new THREE.Vector3());
    n.y = 0;
    if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
    n.normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, anchor);
    const p = new THREE.Vector3();
    return rc.ray.intersectPlane(plane, p) ? p : null;
  }
  /** ハンドルを出す（null で消す）。選んだ物の枠（setSelection）とは別に管理 */
  setHandles(handles: Handle3D[] | null) {
    clearGroup(this.handleGroup);
    this.handles = handles ? handles.slice() : [];
    if (this.handles.length) {
      const r = this.renderer.domElement.getBoundingClientRect();
      // sizeAttenuation=false のスプライトは scale 1 ≒ 距離 1 の world 1m。画面の高さに対する比で画素数を決める
      const px = 20;
      const s = ((2 * px) / Math.max(1, r.height)) / Math.max(0.1, this.camera.projectionMatrix.elements[5]);
      for (const hd of this.handles) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: handleTexture(hd.kind, !!hd.on), sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }));
        sp.scale.set(s, s, 1);
        sp.position.copy(hd.pos);
        sp.renderOrder = 1000;
        sp.userData.noShadow = true;
        sp.userData.handleId = hd.id;
        this.handleGroup.add(sp);
      }
    }
    this.dirty = true;
  }
  /** 画面の点の近く（radiusPx 以内）にあるハンドル。いちばん近いもの */
  pickHandle(ndc: THREE.Vector2, radiusPx = 14): Handle3D | null {
    if (!this.handles.length) return null;
    const s = this.ndcToScreen(ndc);
    let best: { h: Handle3D; d: number } | null = null;
    for (const hd of this.handles) {
      const q = this.toScreen(hd.pos);
      const d = Math.hypot(q.x - s.x, q.y - s.y);
      if (d <= radiusPx && (!best || d < best.d)) best = { h: hd, d };
    }
    return best?.h ?? null;
  }
  /** ドラッグ中にカーソルのそばに出す寸法の表示（「幅 2.10 m」「15°」）。null で消す */
  setDragLabel(text: string | null) {
    const host = this.renderer.domElement.parentElement;
    if (!host) return;
    if (!this.dragLabelEl) {
      this.dragLabelEl = document.createElement('div');
      this.dragLabelEl.className = 'drag-label';
      host.appendChild(this.dragLabelEl);
    }
    const el = this.dragLabelEl;
    if (!text) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent = text;
    const r = host.getBoundingClientRect();
    el.style.left = `${this.lastPtr.x - r.left + 16}px`;
    el.style.top = `${this.lastPtr.y - r.top - 30}px`;
  }

  /** 寸法線を出す（null で消す）。選んだ物の枠・ハンドルとは別に管理 */
  setDimLines(lines: DimLine3D[] | null) {
    clearGroup(this.dimGroup);
    for (const l of this.dimLabels) l.el.remove();
    this.dimLabels = [];
    const host = this.renderer.domElement.parentElement;
    if (lines && lines.length && host) {
      const up = new THREE.Vector3(0, 1, 0);
      const byKind: Record<'size' | 'gap', number[]> = { size: [], gap: [] };
      for (const l of lines) {
        const dir = l.b.clone().sub(l.a);
        const len = dir.length();
        if (len < 1e-4) continue;
        dir.divideScalar(len);
        // 端の印は線と直交（水平の線は水平面の中、鉛直の線は x 向き）
        const perp = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3().crossVectors(dir, up).normalize();
        const t = 0.07;
        const pos = byKind[l.kind ?? 'size'];
        const push = (p: THREE.Vector3, q: THREE.Vector3) => pos.push(p.x, p.y, p.z, q.x, q.y, q.z);
        push(l.a, l.b);
        push(l.a.clone().addScaledVector(perp, -t), l.a.clone().addScaledVector(perp, t));
        push(l.b.clone().addScaledVector(perp, -t), l.b.clone().addScaledVector(perp, t));
        const el = document.createElement('div');
        el.className = `dim-label${(l.kind ?? 'size') === 'gap' ? ' gap' : ''}${l.editable ? ' editable' : ''}`;
        el.textContent = l.label;
        if (l.editable) {
          el.title = 'クリックして数値（mm）を打つと、その距離に動きます';
          el.addEventListener('pointerdown', (e) => e.stopPropagation());
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            this.editDimLabel(el, l);
          });
        }
        host.appendChild(el);
        this.dimLabels.push({ el, p: l.a.clone().add(l.b).multiplyScalar(0.5), a: l.a.clone(), b: l.b.clone(), gap: (l.kind ?? 'size') === 'gap' });
      }
      for (const kind of ['size', 'gap'] as const) {
        if (!byKind[kind].length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(byKind[kind], 3));
        const ln = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: kind === 'gap' ? 0x2d6cdf : 0x1f2326, depthTest: false, transparent: true, opacity: 0.92 }));
        ln.renderOrder = 999;
        ln.userData.noShadow = true;
        this.dimGroup.add(ln);
      }
      this.updateDimLabels();
    }
    this.dirty = true;
  }
  /** 札の中で数値を打つ（Enter で確定・Esc／外をクリックでやめる） */
  private editDimLabel(el: HTMLDivElement, l: DimLine3D) {
    if (el.querySelector('input')) return;
    const text = el.textContent ?? '';
    const cur = parseInt((l.label.match(/[\d,]+/)?.[0] ?? '').replace(/,/g, ''), 10);
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '10';
    input.value = Number.isFinite(cur) ? String(cur) : '';
    // Enter で確定・Esc／外をクリックでやめる。input を外すと Chrome は blur を同期で投げるので、二重に片付けない
    let finished = false;
    const done = (commit: boolean) => {
      if (finished) return;
      finished = true;
      const val = +input.value;
      try {
        input.remove();
      } catch {
        /* blur の中で先に外れていた */
      }
      el.textContent = text;
      if (commit && Number.isFinite(val)) this.onDimEdit?.(l.id, val);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      else if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(false));
    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();
  }
  /**
   * 札を 3D の位置に合わせる（毎コマ）。カメラの後ろ・画面の外は隠す。
   * 物の寸法（W・D・H）の札は、遠くて線が 36px に満たないとき（札どうしが重なるだけ）も隠す。壁までの距離（青）は数値を打つ札なので短くても出す
   */
  private updateDimLabels() {
    if (!this.dimLabels.length) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const toPx = (v: THREE.Vector3) => {
      const q = v.clone().project(this.camera);
      return { x: ((q.x + 1) / 2) * r.width, y: ((1 - q.y) / 2) * r.height, z: q.z };
    };
    for (const { el, p, a, b, gap } of this.dimLabels) {
      const q = toPx(p);
      const pa = toPx(a);
      const pb = toPx(b);
      const long = gap || Math.hypot(pa.x - pb.x, pa.y - pb.y) >= 36 || pa.z >= 1 || pb.z >= 1;
      const vis = q.z < 1 && q.x >= -0.05 * r.width && q.x <= 1.05 * r.width && q.y >= -0.05 * r.height && q.y <= 1.05 * r.height && long;
      el.hidden = !vis;
      if (!vis) continue;
      el.style.left = `${q.x}px`;
      el.style.top = `${q.y}px`;
    }
  }

  /** 画面上の点の下に何があるか（扉・屋根・天井は透かさず、いちばん手前の面）。何も無ければ地面の点 */
  /** 画面の点から、高さ y の水平面との交点（ドラッグで物を滑らせる面） */
  private planePoint(cx: number, cy: number, y: number): THREE.Vector3 | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / Math.max(1, r.width)) * 2 - 1, -((cy - r.top) / Math.max(1, r.height)) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    return rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? p : null;
  }

  /**
   * 選んだ物の足元の枠（CAD の選択表示）: world の多角形（m。凸な四角・円を想定）。橙の線と薄い塗りを、物の手前でも見えるように描く。null で消す
   */
  setSelection(points: THREE.Vector3[] | null) {
    clearGroup(this.selGroup);
    if (points && points.length >= 3) {
      const pts = points.map((p) => p.clone().setY(p.y + 0.02));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xff7a1a, depthTest: false, transparent: true, opacity: 0.95 }));
      line.renderOrder = 999;
      const pos: number[] = [];
      for (let i = 1; i + 1 < pts.length; i++) pos.push(pts[0].x, pts[0].y, pts[0].z, pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.16, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      fill.renderOrder = 998;
      for (const o of [line, fill]) {
        o.userData.noShadow = true;
        o.castShadow = false;
        o.receiveShadow = false;
      }
      this.selGroup.add(fill, line);
    }
    this.dirty = true;
  }

  pickHit(ndc: THREE.Vector2): PickHit | null {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const shown = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
      return (o as THREE.Mesh).isMesh === true;
    };
    const groups: [PickHit['group'], THREE.Object3D][] = [
      ['building', this.groups.building],
      ['furniture', this.groups.furniture],
      ['landscape', this.groups.landscape],
      ['roof', this.groups.roof],
      ['cut', this.groups.cut],
    ];
    const hits = rc.intersectObjects(groups.map((g) => g[1]), true).filter((x) => shown(x.object) && x.distance > 0.05 && !x.object.userData.noShadow);
    for (const x of hits) {
      const key = String(x.object.userData.matKey ?? '');
      // 外部の実物モデル（観葉植物など）はキーが無い。家具扱い
      let group: PickHit['group'] | null = null;
      for (let o: THREE.Object3D | null = x.object; o && !group; o = o.parent) {
        // 模型・断面の表示の中身は、切って作り直した建物・屋根・家具。元のグループとして返す（道具のクリック判定が通常表示と同じになる）
        if (o.parent === this.groups.cut) group = o.name === 'cut-roof' ? 'roof' : o.name === 'cut-furniture' ? 'furniture' : o.name === 'cut-building' || o.name.startsWith('cutdoor') ? 'building' : 'cut';
        else group = groups.find((g) => g[1] === o)?.[0] ?? null;
      }
      if (!group) continue;
      return { group, matKey: key, point: x.point.clone(), normal: x.face ? x.face.normal.clone().transformDirection(x.object.matrixWorld) : new THREE.Vector3(0, 1, 0), distance: x.distance };
    }
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const p = new THREE.Vector3();
    return rc.ray.intersectPlane(ground, p) ? { group: 'ground', matKey: '', point: p, normal: new THREE.Vector3(0, 1, 0), distance: p.distanceTo(this.camera.position) } : null;
  }

  /** 画面上の点（NDC）の下にある「床」の点（屋根・壁・天井は透かす。家具の天板はその下の床の高さに落とす）。床が無ければ null */
  pickFloorPoint(ndc: THREE.Vector2): THREE.Vector3 | null {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const shown = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
      return (o as THREE.Mesh).isMesh === true;
    };
    const hits = rc.intersectObjects([this.groups.building, this.groups.furniture, this.groups.cut], true).filter((x) => shown(x.object) && x.distance > 0.05);
    const floorLike = /^int\.(floor|wetFloor|entranceFloor|tatami|slab)|^ext\.(balcony|terrace|concrete)|^l\.(deck|paving)/;
    const h = hits.find((x) => floorLike.test(String(x.object.userData.matKey ?? '')));
    if (h) return h.point.clone();
    // 家具の上: その真下の床（同じ x/z）
    const fh = hits.find((x) => String(x.object.userData.matKey ?? '').startsWith('f.'));
    if (fh) return fh.point.clone();
    return null;
  }

  /** 画面上の点（NDC）の下にある床・家具の点（ワールド座標）。屋根・天井は透かして、その下の床を探す */
  pickPoint(ndc: THREE.Vector2): THREE.Vector3 | null {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const shown = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
      return (o as THREE.Mesh).isMesh === true;
    };
    const hits = rc.intersectObjects([this.groups.building, this.groups.furniture, this.groups.cut], true).filter((x) => shown(x.object) && x.distance > 0.05);
    // 上向きの面（床・家具の天板）か家具の面。下向きの面（天井）は飛ばす
    const h = hits.find((x) => {
      const k = String(x.object.userData.matKey ?? '');
      if (k.startsWith('ext.glass') || k.startsWith('int.ceiling') || k === 'ext.soffit') return false;
      return true;
    });
    if (h) return h.point.clone();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const p = new THREE.Vector3();
    return rc.ray.intersectPlane(ground, p) ? p : null;
  }

  /** 外構（敷地・道路・植栽・隣家・手で置いた物）を作って landscape のグループに入れる */
  private addLandscape(model: BuildingModel, meta: BuildingMeta, ext: ExteriorStyle, resolve: (k: string) => THREE.Material) {
    const land = buildLandscape(meta, ext, model.site, planExteriorOf(model), model.siteLevels, { light: this.lowPower });
    const landG = land.mb.build(resolve, { name: 'landscape', castShadow: false });
    this.groups.landscape.add(landG);
    // 擁壁・階段（敷地の高低差）は影を落とす
    if (!land.walls.isEmpty()) this.groups.landscape.add(land.walls.build(resolve, { name: 'walls', castShadow: true }));
    this.groups.landscape.add(land.trees.build(resolve, { name: 'trees' }));
    // 想定の街並み: 区画ごとに 1 つのまとまり（家・塀・生垣・木・車＋区画の地面）。カメラの前に入る区画は丸ごと隠す
    this.town = [];
    this.townRoads = null;
    for (const t of land.town.lots) {
      const g = t.mb.build(resolve, { name: 'town', castShadow: false });
      const flat = t.flat.build(resolve, { name: 'townFlat', castShadow: false });
      this.groups.landscape.add(g, flat);
      this.town.push({ g, flat, box: t.box, solid: t.solid, cast: false });
    }
    if (!land.town.roads.isEmpty()) {
      this.townRoads = land.town.roads.build(resolve, { name: 'townRoads', castShadow: false });
      this.groups.landscape.add(this.townRoads);
    }
    this.cullTown();
    this.updateTownCasters();
    // 遠景の木立（地平線まで何もない地面にしない）
    this.groups.landscape.add(distantTreeBand((land.site.min.x + land.site.max.x) / 2, (land.site.min.y + land.site.max.y) / 2));
    return land;
  }

  /** 外構だけを作り直す（3D 画面で植栽・フェンス・車などを置いたとき。建物・屋根・家具はそのまま） */
  rebuildLandscape(model: BuildingModel) {
    if (!this.state) return;
    clearGroup(this.groups.landscape);
    const resolve = (k: string) => this.registry.get(k);
    const land = this.addLandscape(model, this.state.meta, exteriorFor(this.design), resolve);
    this.state = { ...this.state, model, site: land.site, plan: land.plan };
    this.walkOcc = null;
    this.dirty = true;
  }

  /** 家具だけを作り直す（3D 画面で家具を置き直したとき。建物・屋根・外構はそのまま） */
  rebuildFurniture(model: BuildingModel) {
    if (!this.state) return;
    clearGroup(this.groups.furniture);
    const resolve = (k: string) => this.registry.get(k);
    setKitchenFinish({ dark: isDarkColor(interiorFor(this.design).furniture.cabinet.color) });
    setFurnitureVocab(interiorFor(this.design));
    setFurnitureLighting({ indirect: resolveSpec(this.design.specId, this.design.specPatch).indirectLighting });
    const fur = buildFurniture(model);
    this.groups.furniture.add(fur.mb.build(resolve, { name: 'furniture' }));
    this.groups.furniture.add(contactShadows(fur.occupancy));
    const gen = ++this.modelGen;
    void placeModels(fur.models, this.groups.furniture, () => gen === this.modelGen).then((n) => {
      if (n) this.dirty = true;
    });
    this.state = { ...this.state, model, lights: fur.lights, occupancy: fur.occupancy };
    this.walkOcc = null;
    this.updateInteriorLights();
    this.cutBuilt = null;
    if (this.cut) this.setCut(this.cut);
    this.dirty = true;
  }

  /**
   * 建物（壁・床・屋根）だけの当たり判定（歩行の壁抜け防止・床の高さ・回転の中心に使う）。
   * 開き戸・引戸の板は入れない: 戸は閉じて描くので、板を入れると戸口を通れなくなる（歩くモードでは近づくと戸が開く → autoDoors）
   */
  private occluder() {
    if (!this.state) return null;
    const cutKey = JSON.stringify(this.cut);
    if (!this.walkOcc || this.walkOcc.state !== this.state || this.walkOcc.cut !== cutKey) this.walkOcc = { state: this.state, cut: cutKey, occ: buildOccluder(this, { buildingOnly: true, doors: false }) };
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
    // 戸の板は当たり判定に入っていないので、別に当てる（閉じた戸を指してズームしたとき、戸の向こうの壁までの距離にならないように）
    const leaf = this.doors.length
      ? rc.intersectObjects(this.doors.filter((d) => d.group.userData.walkThrough).map((d) => d.group), true).find((x) => (x.object as THREE.Mesh).visible && x.distance > 0.05)
      : undefined;
    if (occ) {
      const hit = occ.bvh.raycastFirst(rc.ray, THREE.DoubleSide);
      if (hit && hit.distance > 0.05) return leaf ? Math.min(hit.distance, leaf.distance) : hit.distance;
    }
    if (leaf) return leaf.distance;
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

  /**
   * ホイールのズーム: カーソルの下の面までの距離に比例した一歩で、カーソルの方向へ進む／下がる。
   * 中心に近づいても一歩が小さくなりすぎない（最小 0.25m）ので、途中で止まらずに部屋の奥まで入っていける
   */
  private wheelZoom(e: WheelEvent) {
    const notch = Math.max(-4, Math.min(4, e.deltaMode === 1 ? e.deltaY / 3 : e.deltaMode === 2 ? e.deltaY : e.deltaY / 100));
    if (!notch) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
    const ny = 1 - ((e.clientY - r.top) / Math.max(1, r.height)) * 2;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const d = this.depthAt(e.clientX, e.clientY) ?? this.camera.position.distanceTo(this.controls.target);
    // 室内（目の前の面が近い）は一歩を小さく、外観は大きく。1 回のホイールで 2 目盛りぶんまで
    const inside = d < 8;
    const k = (inside ? 0.11 : 0.2) * this.controls.zoomSpeed;
    const step = Math.max(inside ? 0.12 : 0.25, Math.min(60, d * k)) * Math.min(2, Math.abs(notch));
    // 寄るときは面の手前 0.3m を目安に（ただし最小の一歩は進めるので、壁の向こうへも抜けられる）
    const move = notch < 0 ? Math.min(step, Math.max(0.25, d - 0.3)) : -step;
    this.zoomRemain.addScaledVector(rc.ray.direction, move);
    this.anim = null;
    this.lastMove = performance.now();
  }

  /** ズームの残りを消化する（約 0.12 秒で追いつく指数的な動き。コマ数が少なくても同じ時間で終わる） */
  private stepZoom(dt: number) {
    if (this.zoomRemain.lengthSq() < 1e-8) return;
    const part = 1 - Math.exp(-dt / 0.09);
    const mv = this.zoomRemain.clone().multiplyScalar(part);
    this.zoomRemain.sub(mv);
    if (this.zoomRemain.lengthSq() < 1e-6) {
      mv.add(this.zoomRemain);
      this.zoomRemain.set(0, 0, 0);
    }
    this.camera.position.add(mv);
    this.controls.target.add(mv);
    // 回転の中心が真後ろ・すぐ足元にならないように、視線の先 1.5m 以上に置き直す
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const ahead = this.controls.target.clone().sub(this.camera.position).dot(dir);
    if (ahead < 1.5) this.controls.target.copy(this.camera.position).addScaledVector(dir, 1.5);
    this.clampAboveFloor();
    this.camMoved();
  }

  /** カメラが床・地面より下に潜らないようにする。潜った分は回転の中心ごと持ち上げる（＝見上げに変わる） */
  private clampAboveFloor() {
    if (this.navMode === 'walk') return;
    const pos = this.camera.position;
    let floor = 0;
    const occ = this.occluder();
    if (occ) {
      // 少し上から下へ: 1 コマで床をわずかに突き抜けた場合も、その床を拾う
      const ray = new THREE.Ray(pos.clone().setY(pos.y + 0.3), new THREE.Vector3(0, -1, 0));
      const hit = occ.bvh.raycastFirst(ray, THREE.DoubleSide);
      if (hit && hit.distance < 6) floor = hit.point.y;
    }
    const minY = floor + 0.25;
    if (pos.y >= minY) return;
    const dy = minY - pos.y;
    pos.y += dy;
    this.controls.target.y += dy;
    this.camera.lookAt(this.controls.target);
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

  /** 毎コマ呼ぶ処理（Google 実写 3D のタイル選択など）。true を返すと描き直す */
  readonly frameHooks = new Set<() => boolean>();

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.paused) return;
    for (const hook of this.frameHooks) if (hook()) this._dirty = true;
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
    if (this.navMode !== 'walk') this.stepZoom(dt);
    // 慣性はコマ数ではなく時間で減らす（重い環境でコマが少ないと、慣性がだらだら長く続いて「ズズズ」と滑っていた）。
    // 60fps で 1 コマ 20% 減衰 ＝ 約 0.2 秒で止まる（0.1 秒だと止まり方が急で雑に見えた）
    this.controls.dampingFactor = Math.min(0.9, 1 - Math.pow(0.8, Math.max(0.5, dt * 60)));
    // 回転の速さ: 室内（回転の中心が近い）はゆっくり、外観は速め。室内で少し動かしただけで大きく振れる「雑な」動きを抑える
    {
      const dist = this.camera.position.distanceTo(this.controls.target);
      this.controls.rotateSpeed = dist < 6 ? 0.42 : dist < 14 ? 0.6 : 0.8;
      this.controls.panSpeed = dist < 6 ? 0.7 : 1.1;
    }
    const moved = this.navMode === 'walk' ? false : this.controls.update();
    if (moved) {
      this.clampAboveFloor();
      this.camMoved();
    }
    this.updateDimLabels();
    // 操作中（直近 0.2 秒以内にカメラが動いた）は後処理なし・低めの解像度で軽く描き、止まったら高品質で1枚描く
    // 操作中（直近 0.35 秒以内にカメラが動いた）は後処理なしで素早く描き、止まったら後処理込みで 1 枚描く。
    // 解像度は切り替えない（切り替えるたびに後処理のバッファを作り直してカクつくため）
    const moving = now - this.lastMove < 350;
    if (moving) {
      if (!this._dirty) return;
      this._dirty = false;
      // 操作中は描く画素を減らす（後処理のバッファには触らないので切り替えは軽い）
      this.motionFrameMs = this.motionFrameMs * 0.8 + dt * 1000 * 0.2;
      this.setMotionPR(true);
      this.flushShadow();
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

  /**
   * 操作中だけ描画の解像度を落とす（高精細ディスプレイで 1.5 倍 → 1 倍。画素数が半分以下になる）。
   * 影の地図は場面が変わったときにしか描き直さない（autoUpdate = false）ので、重い環境でも解像度は落とさない
   * （以前の 1024 への切り替えは、操作の軽さにはほぼ効かず、影がぼやけて質感だけ落ちていた）
   */
  private setMotionPR(on: boolean) {
    // 操作中は等倍。それでも 1 コマ 30ms を超える重い環境では 0.7 倍まで下げる（止まれば元の精細さで描き直す）
    const want = on ? Math.min(1, this.fullPR()) * (this.motionFrameMs > 30 ? 0.7 : 1) : this.fullPR();
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
      // 影の地図は場面が変わるまで描き直さない設定なので、描き直しを予約する（でないと切り替え直後は影が消える）
      this.shadowDirty = true;
    }
    this.applyLightsVisibility();
    this.applyPixelRatio(this.fullPR());
    this.dirty = true;
  }

  /** 室内の点光源を見せるか（外部モデルで隠している間はそちらが優先） */
  private applyLightsVisibility() {
    if (this.pdfGroupsHidden) {
      this.portalGroup.visible = false;
      return;
    }
    const tod = this.design.timeOfDay;
    const needed = tod === 'evening' || tod === 'night';
    const inside = this.cameraInside();
    this.groups.lights.visible = needed || (this.viewMode === 'finish' && inside);
    // 室内の灯り: 室内から見るときは下向きの光、外から見るときは窓を灯す全方向の光
    if (this.lampSets && (this.lampSets.inner.visible !== inside || this.lampSets.outer.visible === inside)) {
      this.lampSets.inner.visible = inside;
      this.lampSets.outer.visible = !inside;
      this._dirty = true;
    }
    this.portalGroup.visible = this.portalLights.length > 0 && tod !== 'night' && !this.cut && this.cameraInside();
    // 歩いて別の部屋へ入ったら、その部屋の窓に付け替える（止まった絵を待たない）
    if (this.portalGroup.visible && this.assignPortals(this.roomAtCamera()?.ri ?? null)) this.probeDirty = true;
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
      this.autoDoors();
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

  hasSkyDome(): boolean {
    return !!this.skyDome;
  }

  /** 空を球で描く（on）／背景に戻す（off）。球はカメラに追従する */
  useSkyDome(on: boolean) {
    if (on && !this.skyDome) {
      const mat = new THREE.MeshBasicMaterial({ map: this.skyTex ?? undefined, side: THREE.BackSide, fog: false });
      const m = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), mat);
      m.name = 'skydome';
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.userData.noShadow = true;
      m.renderOrder = -1000;
      this.skyDome = m;
      this.scene.add(m);
      this.scene.background = null;
    } else if (!on && this.skyDome) {
      this.scene.remove(this.skyDome);
      this.skyDome.geometry.dispose();
      this.skyDome.material.dispose();
      this.skyDome = null;
      this.scene.background = this.skyTex;
    }
    this.dirty = true;
  }

  /** カメラのいる部屋（その階の床から天井までの高さにいて、部屋の形の中） */
  private roomAtCamera() {
    const st = this.state;
    if (!st) return null;
    const p = this.camera.position;
    let best: { ri: (typeof st.meta.rooms)[number]; top: number } | null = null;
    for (const ri of st.meta.rooms) {
      if (ri.room.type === 'void' || ri.poly.length < 3) continue;
      const top = ri.floorY + Math.max(2.1, (ri.floor.ceilingHeight ?? 2400) * MM);
      if (p.y < ri.floorY - 0.05 || p.y > ri.floorY + ri.floor.height * MM + 0.05) continue;
      if (!pointInPolygon({ x: p.x, y: p.z }, ri.poly)) continue;
      if (!best || ri.room.area < best.ri.room.area) best = { ri, top };
    }
    return best;
  }

  /**
   * いまいる部屋の窓に、面の光（窓からの空の光）を割り当てる。変わったら true。
   * 窓の近くは明るく、奥へ行くほど暗くなる。窓のある壁そのものには当たらない（逆光の壁は暗い）。影は落とさない
   */
  private assignPortals(ri: SceneState['meta']['rooms'][number] | null): boolean {
    if (!this.state) return false;
    const tod = this.design.timeOfDay;
    const key = `${ri?.room.id ?? ''}|${tod}|${this.portalLights.length}`;
    if (key === this.portalKey) return false;
    this.portalKey = key;
    let list: WindowPortal[] = [];
    if (ri && tod !== 'night') {
      // 吹抜の上の窓（ハイサイド）も、下の部屋の窓として数える
      const voids = this.state!.meta.rooms.filter((o) => o.room.type === 'void' && o.floor.level === ri.floor.level + 1 && pointInPolygon({ x: o.center.x, y: o.center.z }, ri.poly));
      const inRoom = (p: WindowPortal, poly: THREE.Vector2[]) => pointInPolygon({ x: p.pos.x + p.normal.x * 0.35, y: p.pos.z + p.normal.z * 0.35 }, poly);
      list = this.portals
        .filter((p) => (p.level === ri.floor.level && inRoom(p, ri.poly)) || (p.level === ri.floor.level + 1 && voids.some((v) => inRoom(p, v.poly))))
        .sort((a, b) => b.width * b.height - a.width * a.height)
        .slice(0, PORTAL_MAX);
    }
    const L = this.look.portalL * (tod === 'evening' ? 0.4 : tod === 'morning' ? 0.75 : 1);
    const col = tod === 'evening' ? '#ffd9b0' : tod === 'morning' ? '#f6eef0' : '#eef3ff';
    this.portalLights.forEach((l, i) => {
      const p = list[i];
      if (!p) {
        l.intensity = 0;
        return;
      }
      l.width = p.width;
      l.height = p.height;
      // 室内側へ少し出す: 光は面の表側にしか出ないので、窓枠・窓まわりの壁の小口は光の裏になり、白く光らない
      l.position.copy(p.pos).addScaledVector(p.normal, this.look.portalInset);
      l.lookAt(l.position.clone().add(p.normal).setY(l.position.y - this.look.portalTilt));
      l.color.set(col);
      l.intensity = L;
    });
    return true;
  }

  /**
   * 部屋の映り込みを撮り直す（止まった絵を描く直前）。カメラが室内にいて、場面が変わったか別の部屋へ移ったときだけ。
   * 家具は写さない: 撮った位置のすぐそばの家具は、箱投影で壁いっぱいに引き伸ばされて映ってしまう。映り込みの主役は窓・壁・天井の光
   */
  private updateRoomProbe() {
    const U = roomProbeUniforms;
    const env = this.scene.environment;
    const hit = !this.cut && !this.pdfGroupsHidden && this.cameraInside() ? this.roomAtCamera() : null;
    if (this.assignPortals(hit?.ri ?? null)) this.probeDirty = true;
    // 環境マップと同じ段数の絵にする（シェーダーが同じ関数で引くため）。小さすぎる環境マップのときは使わない
    const size = env?.image ? Math.round((env.image as { height: number }).height / 4) : 0;
    // 指で操作する端末（スマホ・タブレット）では撮らない: 止まるたびに 6 面を描くぶん、次の操作の出だしが遅れる
    if (!hit || size < 64 || this.contextLost || this.lowPower) {
      U.roomProbeOn.value = 0;
      this.probeRoom = '';
      return;
    }
    const { ri } = hit;
    if (!this.probeDirty && this.probeRoom === ri.room.id && this.probeEnv && U.roomProbeOn.value === 1) return;
    if (!this.probeRT || this.probeRT.width !== size) {
      this.probeRT?.dispose();
      this.probeRT = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
      this.probeCam = new THREE.CubeCamera(0.05, 80, this.probeRT);
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const q of ri.poly) {
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minZ = Math.min(minZ, q.y);
      maxZ = Math.max(maxZ, q.y);
    }
    // 吹抜の下の部屋は、上の階の天井までを箱にする
    const above = this.state!.meta.rooms.find(
      (o) => o.room.type === 'void' && o.floor.level === ri.floor.level + 1 && pointInPolygon({ x: o.center.x, y: o.center.z }, ri.poly),
    );
    const top = above ? above.floorY + Math.max(2.1, (above.floor.ceilingHeight ?? 2400) * MM) : hit.top;
    const cam = this.probeCam!;
    cam.position.set(ri.center.x, ri.floorY + Math.min(1.3, (top - ri.floorY) * 0.5), ri.center.z);
    const prevTarget = this.renderer.getRenderTarget();
    const furnVisible = this.groups.furniture.visible;
    U.roomProbeOn.value = 0;
    this.groups.furniture.visible = false;
    try {
      cam.update(this.renderer, this.scene);
    } finally {
      this.groups.furniture.visible = furnVisible;
      this.renderer.setRenderTarget(prevTarget);
    }
    this.probeEnv?.dispose();
    this.probeEnv = this.pmrem.fromCubemap(this.probeRT.texture);
    U.roomProbeMap.value = this.probeEnv.texture;
    U.roomProbePos.value.copy(cam.position);
    U.roomProbeMin.value.set(minX, ri.floorY, minZ);
    U.roomProbeMax.value.set(maxX, top, maxZ);
    U.roomProbeOn.value = 1;
    this.probeRoom = ri.room.id;
    this.probeDirty = false;
  }

  /**
   * 止まったときの 1 コマ。閲覧モードでも後処理（GTAO の陰影・SMAA の輪郭）込みで描く:
   * 軽さは操作中のコマ（loop 内の素の描画・低い画素比）で稼ぎ、止まった絵は常に質感を残す。
   * 閲覧と仕上げの違いは画素比（1 / 1.5）と影の解像度（2048 / 4096）だけ
   */
  renderFrame(force = false) {
    if (this.skyDome) this.skyDome.position.copy(this.camera.position);
    if (this.photoSky) {
      this.photoSky.dome.position.copy(this.camera.position);
      this.photoSky.haze.position.copy(this.camera.position);
    }
    this.flushShadow();
    if (this.quality === 'high' || force) this.updateRoomProbe();
    if (this.quality === 'high' || force) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.onAfterRender?.();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    for (const l of this.dimLabels) l.el.remove();
    this.dimLabels = [];
    this.dragLabelEl?.remove();
    this.renderer.dispose();
  }

  // ------------------------------------------------------------------
  // シーン構築
  // ------------------------------------------------------------------

  setModel(model: BuildingModel) {
    this.probeDirty = true;
    const ext = this.extStyle();
    for (const g of [this.groups.building, this.groups.roof, this.groups.furniture, this.groups.landscape, this.groups.lights, this.groups.cut]) clearGroup(g);
    this.cutBuilt = null;
    // 天井高の上書き（仕様の調整）
    const ch = this.design.specPatch?.ceilingHeight;
    if (ch) for (const f of model.floors) f.ceilingHeight = Math.min(ch, f.height - 200);
    const { mb, meta } = buildBuilding(model, { exterior: ext, spec: resolveSpec(this.design.specId, this.design.specPatch), stairBuild: stairBuildOf(this.design) });
    const resolve = (k: string) => this.registry.get(k);
    this.groups.building.add(mb.build(resolve, { name: 'building' }));
    // 扉は独立した部品にして、ウォークスルーで開閉できるようにする
    this.doors = [];
    for (const info of meta.doors) {
      const group = new THREE.Group();
      group.name = `door:${info.id}`;
      group.userData.walkThrough = info.kind !== 'roll';
      group.add(info.mb.build(resolve, { name: 'door' }));
      this.groups.building.add(group);
      // 閉じた状態の板の中心と床の高さ（歩くモードで「近づいたら開ける」の判定に使う）
      this.poseDoor(info, group, 0);
      group.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(group);
      const at = box.isEmpty() ? info.origin.clone() : box.getCenter(new THREE.Vector3()).setY(box.min.y);
      this.doors.push({ info, group, at });
    }
    this.setDoors(null);
    const roof = buildRoofs(model, ext, this.design.roofOverride, this.design.roofPitch);
    this.groups.roof.add(roof.mb.build(resolve, { name: 'roof' }));
    this.edgeLines = [];
    this.rebuildEdges([this.groups.building, this.groups.roof]);
    setKitchenFinish({ dark: isDarkColor(interiorFor(this.design).furniture.cabinet.color) });
    setFurnitureVocab(interiorFor(this.design));
    setFurnitureLighting({ indirect: resolveSpec(this.design.specId, this.design.specPatch).indirectLighting });
    const fur = buildFurniture(model);
    this.groups.furniture.add(fur.mb.build(resolve, { name: 'furniture' }));
    this.groups.furniture.add(contactShadows(fur.occupancy));
    // 実物のモデル（観葉植物・ラウンジチェア）は読み込み後に追加
    const gen = ++this.modelGen;
    void placeModels(fur.models, this.groups.furniture, () => gen === this.modelGen).then((n) => {
      if (n) this.dirty = true;
    });
    const land = this.addLandscape(model, meta, ext, resolve);
    // ガラスは影を落とさない
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.userData.matKey?.startsWith('ext.glass') || m.userData.matKey === 'f.water')) {
        m.castShadow = false;
        m.renderOrder = 2;
      }
    });
    this.state = { model, meta, roof: roof.info, site: land.site, plan: land.plan, lights: fur.lights, occupancy: fur.occupancy };
    this.portals = windowPortals(model, resolveSpec(this.design.specId, this.design.specPatch));
    this.portalKey = '';
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
    this.doorNear.clear();
    this.doorAuto.clear();
    for (const { info, group } of this.doors) {
      const frac = open ? Math.max(0, Math.min(1, open.get(info.id) ?? 0)) : info.staticOpen;
      this.poseDoor(info, group, frac);
    }
    if (this.doors.length) this.camMoved();
  }

  private poseDoor(info: DoorInfo, group: THREE.Group, frac: number) {
    group.position.copy(info.origin);
    group.rotation.set(0, info.yaw0, 0);
    group.scale.set(1, 1, 1);
    if (info.kind === 'swing') group.rotation.y = info.yaw0 + info.openAngle * frac;
    else if (info.kind === 'roll') group.scale.y = Math.max(0.04, 1 - frac * 0.96); // 巻き取り: 上端のボックスへ縮む
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
    // 扉より手前に壁・家具・外構の物があれば無視（車の向こうのシャッターが開かないように）
    const wall = rc
      .intersectObjects([this.groups.building, this.groups.furniture, this.groups.landscape], true)
      .filter((x) => shown(x.object) && !String(x.object.userData.matKey ?? '').startsWith('ext.glass') && !x.object.userData.noShadow)
      .find((x) => !this.doors.some((d) => d.group === x.object.parent?.parent || d.group === x.object.parent));
    if (wall && wall.distance < hits[0].distance - 0.05) return false;
    let o: THREE.Object3D | null = hits[0].object;
    while (o && !this.doors.some((d) => d.group === o)) o = o.parent;
    const d = this.doors.find((x) => x.group === o);
    if (!d) return false;
    const cur = (d.group.userData.frac as number | undefined) ?? d.info.staticOpen;
    this.doorAnim.set(d.info.id, cur > 0.5 ? 0 : 1);
    this.doorAuto.delete(d.info.id);
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
      if (d.info.kind === 'roll') this.walkOcc = null;
      if (next === target) this.doorAnim.delete(id);
    }
    this.camMoved();
  }

  /** 歩くモードで近くにいる戸／そのうち自動で開けた戸（離れたら閉じ直す） */
  private doorNear = new Set<string>();
  private doorAuto = new Set<string>();

  /**
   * 歩くモード: 近づいた開き戸・引戸を自動で開け、離れたら閉じる。
   * 戸は閉じて描く（提案パースの見せ方）ので、そのままだとお客様が体験リンクで歩いたときに戸口で止まってしまう。
   * 手で開け閉めした戸はそのまま（自動で開けた戸だけを閉じ直す）。
   */
  private autoDoors() {
    if (this.navMode !== 'walk' || this.cut || !this.doors.length) return;
    const p = this.camera.position;
    for (const d of this.doors) {
      if (d.info.kind === 'roll') continue;
      const id = d.info.id;
      const was = this.doorNear.has(id);
      const up = p.y - d.at.y;
      const near = up > 0.3 && up < 2.6 && Math.hypot(p.x - d.at.x, p.z - d.at.z) < (was ? 1.9 : 1.35);
      if (near === was) continue;
      if (near) {
        this.doorNear.add(id);
        const cur = (d.group.userData.frac as number | undefined) ?? d.info.staticOpen;
        if (cur < 0.5 && (this.doorAnim.get(id) ?? cur) < 0.5) {
          this.doorAnim.set(id, 1);
          this.doorAuto.add(id);
        }
      } else {
        this.doorNear.delete(id);
        if (this.doorAuto.delete(id)) this.doorAnim.set(id, d.info.staticOpen);
      }
    }
  }

  /** 歩くモードを抜けた・別の構図へ飛んだら、自動で開けた戸を閉じ直す（now: 動きを付けずにすぐ。構図の書き出しに開いた戸が写らないように） */
  private closeAutoDoors(now = false) {
    for (const id of this.doorAuto) {
      const d = this.doors.find((x) => x.info.id === id);
      if (!d) continue;
      if (now) {
        this.doorAnim.delete(id);
        this.poseDoor(d.info, d.group, d.info.staticOpen);
      } else this.doorAnim.set(id, d.info.staticOpen);
    }
    this.doorNear.clear();
    this.doorAuto.clear();
    this.dirty = true;
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
    this.probeDirty = true;
    const prev = this.design;
    this.design = design;
    this.registry.update(exteriorFor(design), interiorFor(design), {
      wallColor: design.wallColorOverride,
      // 室内ドアの色: 手で選んだ色 → コーディネートで選んだ建具の商品 → 壁になじませる（既定）
      doorColor: design.specPatch?.doorColor ?? (design.finishes?.door ? 'preset' : undefined),
      night: design.timeOfDay === 'night',
      evening: design.timeOfDay === 'evening',
      clay: design.clay,
    });
    if (!this.state) return;
    const ext = exteriorFor(design);
    const roofChanged =
      prev.exteriorId !== design.exteriorId || prev.roofOverride !== design.roofOverride || prev.roofPitch !== design.roofPitch || prev.eaves !== design.eaves || prev.specId !== design.specId || JSON.stringify(prev.specPatch) !== JSON.stringify(design.specPatch) || (prev.finishes?.accent ?? '') !== (design.finishes?.accent ?? '');
    // 階段のつくり（コーディネートの「階段」の品目）が変わったら、階段の形を作り直す
    const stairChanged = stairBuildOf(prev) !== stairBuildOf(design);
    if (roofChanged || stairChanged || prev.exteriorId !== design.exteriorId) {
      // 外構・アクセント位置も変わるので建物以外を再構築
      this.setModel(this.state.model);
      return;
    }
    this.registry.apply(this.root);
    // 家具の形に関わる選択（ダイニングのペンダント・椅子・テーブル、キッチンの扉の濃淡）が変わったら、家具だけ作り直す
    // （素材の入れ替えだけでは、ペンダントの形が前のまま残る）
    const furnKey = (d: DesignOptions) => {
      const i = interiorFor(d);
      return JSON.stringify([i.id.startsWith('hl-'), i.vocab ?? null, isDarkColor(i.furniture.cabinet.color)]);
    };
    if (furnKey(prev) !== furnKey(design)) this.rebuildFurniture(this.state.model);
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
  fitShadow(extra?: THREE.Box3, envUpdate = true) {
    if (!this.state) return;
    const b = this.state.meta.bbox.clone();
    const ext = this.userData.externalMounted === true || this.groups.external.visible ? this.externalBox() : null;
    if (ext) b.union(ext);
    if (extra && !extra.isEmpty()) b.union(extra);
    const c = b.getCenter(new THREE.Vector3());
    // 鳥瞰で街並みが出ているときは、まわりの家にも影が付く広さに（syncShadowWide）
    const r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5 + 7 + (this.shadowWide ? 42 : 0);
    this.fitShadowTo(c, r, envUpdate);
  }

  /**
   * 影の届く距離 (m): 太陽（平行光源）を影の中心からこの距離に置き、奥行きは 2.5 倍まで描く。既定 80 m（敷地のまわりの建物）。
   * 日照の地形（丘の影が 300 m 先から届く）では SunContext が伸ばす。横の広さ（radius）は変えない:
   * 敷地に影を落とす物は太陽から見て敷地の後ろに並ぶので、横に広げなくても入る（影の解像度を落とさない）
   */
  private shadowReach = 80;

  /** 影の届く距離を変える（fitShadow で使う。すぐ影の範囲を作り直す） */
  setShadowReach(reach: number) {
    const r = Math.max(40, Math.min(2000, reach));
    if (Math.abs(r - this.shadowReach) < 0.5) return;
    this.shadowReach = r;
    this.fitShadow();
  }

  /** 影の範囲を中心 center・半径 radius (m) の箱にする */
  fitShadowTo(center: THREE.Vector3, radius: number, envUpdate = true) {
    const r = Math.max(1, radius);
    const c = center.clone();
    this.shadowCenter = c;
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.5;
    cam.far = this.shadowReach * 2.5;
    cam.updateProjectionMatrix();
    this.sun.target.position.copy(c);
    this.setSunDirection(this.sunDir, envUpdate);
    this.updateTownCasters();
  }

  setSunDirection(dir: THREE.Vector3, envUpdate = true) {
    this.probeDirty = true;
    this.sunDir.copy(dir).normalize();
    const b = this.state?.meta.bbox;
    const c = this.shadowCenter ? this.shadowCenter.clone() : b ? b.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(this.sunDir, this.shadowReach);
    const elev = Math.asin(this.sunDir.y);
    const night = this.design.timeOfDay === 'night';
    const k = night ? 0 : Math.max(0, Math.min(1, elev / 0.12));
    const warm = 1 - Math.min(1, Math.max(0, elev / 0.6));
    this.sun.color.setRGB(1, 0.93 - 0.25 * warm, 0.84 - 0.45 * warm);
    this.lightBase.sun = 5.5 * k;
    this.sun.visible = k > 0.001;
    this.lightBase.hemi = night ? 0.03 : 0.08 + 0.12 * Math.min(1, Math.max(0, elev * 3));
    // 照り返し: 日中は床（明るいオーク・タイル）が太陽と空に照らされて天井を照らす。夕景は暖かく弱く、夜は室内灯だけ
    const evening = this.design.timeOfDay === 'evening';
    // 物理的な光の単位（拡散反射で 1/π になる）なので、天井を壁と同じ明るさにするには 2 前後が要る
    this.lightBase.bounce = night ? 0.08 : evening ? 0.6 : 0.8 + 1.4 * Math.min(1, Math.max(0, elev * 3));
    this.bounce.color.set(evening ? '#f3d9bd' : night ? '#f1e2cf' : '#f4efe8');
    if (envUpdate) this.updateEnvironment();
    else this.placePhotoSky();
    this.applyLightBalance(true);
    this.dirty = true;
  }

  updateEnvironment(sunDisk = false) {
    this.probeDirty = true;
    const mode = this.design.timeOfDay;
    this.skyTex?.dispose();
    this.skyTex = makeSkyTexture({ sunDir: this.sunDir, mode, sunDisk, width: 512 });
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromEquirectangular(this.skyTex);
    this.scene.environment = this.envRT.texture;
    this.envIndoorRT?.dispose();
    const indoorTex = makeNeutralEnvTexture(mode);
    this.envIndoorRT = this.pmrem.fromEquirectangular(indoorTex);
    indoorTex.dispose();
    if (this.skyDome) {
      this.skyDome.material.map = this.skyTex;
      this.skyDome.material.needsUpdate = true;
      this.scene.background = null;
    } else this.scene.background = this.skyTex;
    this.lightBase.env = mode === 'night' ? 0.28 : mode === 'morning' ? 0.6 : 0.66;
    this.exposureBase = mode === 'night' ? 1.5 : mode === 'evening' ? 1.2 : mode === 'morning' ? 1.1 : 1.0;
    // 露出は applyLightBalance が決める（室内では壁の明るさで補正する）
    this.applyLightBalance(true);
    this.applyHaze();
    this.syncPhotoSky();
    this.dirty = true;
  }

  /**
   * 遠くほど空気に溶けるかすみ（奥行き感。室内の距離では効かない）。朝は濃い。
   * 実写の空のときは、空の地平線の色に合わせて濃くする（30 m 先で 3%、100 m で 3 割、250 m でほぼ空の色）:
   * 街並みの奥と地面の端が空に溶け、地平線まで何もない地面に見えない。
   * 日照の検討（実際の街・地形を遠くまで見る）では薄いまま
   */
  private applyHaze() {
    const mode = this.design.timeOfDay;
    const ps = this.photoSky && this.photoSky.mode === mode ? this.photoSky : null;
    const col = new THREE.Color(mode === 'night' ? '#0a0d14' : mode === 'evening' ? '#d9b79a' : mode === 'morning' ? '#e3e2e6' : '#cfd6dc');
    let d = mode === 'morning' ? 0.0036 : 0.0024;
    if (ps) {
      col.copy(ps.hdri.horizon).multiplyScalar(this.photoSkyIntensity(ps.hdri));
      // かすみが白く飛ばないように、明るさに上限
      const l = 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
      const cap = mode === 'night' ? 0.06 : 0.82;
      if (l > cap) col.multiplyScalar(cap / l);
      d = mode === 'night' ? 0.004 : mode === 'morning' ? 0.0075 : 0.0058;
      ps.haze.material.color.copy(col);
    }
    if (!this.scene.fog) this.scene.fog = new THREE.FogExp2(col, d);
    else {
      (this.scene.fog as THREE.FogExp2).color.copy(col);
      (this.scene.fog as THREE.FogExp2).density = d;
    }
  }

  /**
   * 実写の空の明るさ: 空の明るさの中央値（青空・雲の間の空の地の色）を、時間帯ごとの決まった明るさにそろえる。
   * 写真ごとに太陽の強さが違うので、照度（太陽込み）でそろえると夕景・夜の空が白く飛ぶ
   */
  private photoSkyIntensity(h: Hdri): number {
    const tod = this.design.timeOfDay;
    const target = tod === 'night' ? 0.03 : tod === 'evening' ? 0.24 : tod === 'morning' ? 0.4 : 0.34;
    return Math.min(6, target / Math.max(0.002, h.skyMedian));
  }

  hasPhotoSky(): boolean {
    return !!this.photoSky;
  }

  /** 画面の空に実写の空を使う／使わない（日照の検討では使わない） */
  setPhotoSky(on: boolean) {
    if (this.photoSkyOn === on) return;
    this.photoSkyOn = on;
    this.syncPhotoSky();
    this.applyHaze();
    this.dirty = true;
  }

  private removePhotoSky() {
    const ps = this.photoSky;
    if (!ps) return;
    this.scene.remove(ps.dome, ps.haze);
    ps.dome.geometry.dispose();
    ps.dome.material.dispose();
    ps.haze.geometry.dispose();
    ps.haze.material.map?.dispose();
    ps.haze.material.dispose();
    this.photoSky = null;
  }

  /** 実写の空を、いまの時間帯のものにする（読み込みは 1 回だけ。読めない環境では手続きの空のまま） */
  private syncPhotoSky() {
    const mode = this.design.timeOfDay;
    const want = this.photoSkyOn && !this.design.clay;
    if (this.photoSky && (!want || this.photoSky.mode !== mode)) {
      // 時間帯が変わった・使わなくなった: 前の時間帯の空は、すぐ外す（昼の空のまま夕景を描かない）
      this.removePhotoSky();
      this.applyHaze();
    }
    if (!want) {
      this.photoSkyToken++;
      return;
    }
    if (this.photoSky) {
      this.placePhotoSky();
      return;
    }
    const token = ++this.photoSkyToken;
    void loadHdri(mode).then((h) => {
      if (!h || token !== this.photoSkyToken || this.design.timeOfDay !== mode || !this.photoSkyOn || this.design.clay) return;
      this.installPhotoSky(h, mode);
    });
  }

  /**
   * いまの時間帯の実写の空が画面に出るまで待つ（書き出しの前に呼ぶ）。
   * @returns 実写の空で描いているか（読めない環境・白模型・日照の検討では false）
   */
  async ensurePhotoSky(): Promise<boolean> {
    const mode = this.design.timeOfDay;
    if (!this.photoSkyOn || this.design.clay) return false;
    if (this.photoSky?.mode === mode) return true;
    const h = await loadHdri(mode);
    if (!h || this.design.timeOfDay !== mode || !this.photoSkyOn || this.design.clay) return this.photoSky?.mode === this.design.timeOfDay;
    if (this.photoSky?.mode !== mode) this.installPhotoSky(h, mode);
    return true;
  }

  private installPhotoSky(h: Hdri, mode: string) {
    this.photoSkyToken++;
    this.removePhotoSky();
    const tex = hdriScreenTexture(h);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(860, 64, 32), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }));
    dome.name = 'photoSky';
    // 地平線のかすみ: 地平線より下は空の地平線の色で塗り、上へ向かって透ける（仰角 9° で消える）
    const R = 840;
    const lo = R * Math.tan((7 * Math.PI) / 180);
    const hi = R * Math.tan((9 * Math.PI) / 180);
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 128;
    const g = c.getContext('2d')!;
    const img = g.createImageData(2, 128);
    for (let y = 0; y < 128; y++) {
      // キャンバスの上の行 = 帯の上端
      const hgt = (1 - (y + 0.5) / 128) * (lo + hi) - lo;
      const t = Math.max(0, Math.min(1, hgt / hi));
      const a = Math.pow(1 - t, 2.2);
      for (let x = 0; x < 2; x++) {
        const i = (y * 2 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    const grad = new THREE.CanvasTexture(c);
    grad.colorSpace = THREE.NoColorSpace;
    const hazeGeo = new THREE.CylinderGeometry(R, R, lo + hi, 64, 1, true);
    hazeGeo.translate(0, (hi - lo) / 2, 0);
    const haze = new THREE.Mesh(hazeGeo, new THREE.MeshBasicMaterial({ map: grad, transparent: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    haze.name = 'photoHaze';
    for (const m of [dome, haze] as THREE.Mesh[]) {
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.userData.noShadow = true;
      m.userData.sky = true;
      m.raycast = () => {};
      m.layers.set(1);
    }
    dome.renderOrder = -999;
    haze.renderOrder = -998;
    this.photoSky = { dome, haze, mode, hdri: h };
    this.scene.add(dome, haze);
    this.placePhotoSky();
    this.applyHaze();
    this.dirty = true;
  }

  /** 実写の空の向き（写真の太陽の方位を、いまの太陽の方位に合わせる）と明るさ */
  private placePhotoSky() {
    const ps = this.photoSky;
    if (!ps) return;
    const sd = this.sunDir;
    ps.dome.rotation.y = ps.hdri.sunAzimuth - (this.design.timeOfDay === 'night' ? 0 : Math.atan2(sd.z, sd.x));
    ps.dome.material.color.setScalar(this.photoSkyIntensity(ps.hdri));
    ps.dome.position.copy(this.camera.position);
    ps.haze.position.copy(this.camera.position);
  }

  // ------------------------------------------------------------------
  // 演出
  // ------------------------------------------------------------------
  private revealToken = 0;
  /** g = 影を落とす物（家・塀・生垣・木・車）、flat = 区画の地面（家を隠しても残す = 空き地に見える）、cast = いま影を落としているか */
  private town: { g: THREE.Group; flat: THREE.Group; box: THREE.Box3; solid: THREE.Box3 | null; cast: boolean }[] = [];
  /** 街並みの道路（裏の道・横の道・向かいの縁石）。街並みと一緒に出し入れする */
  private townRoads: THREE.Group | null = null;
  private townVisible = true;
  townShown(): boolean {
    return this.townVisible;
  }
  /** 隣家（想定の街並み）の表示。日照では実際の周辺建物を使うので消す */
  setTownVisible(on: boolean) {
    this.townVisible = on;
    // 「地面だけ」は日照の画面の間だけの表示。どの画面も入るときにここを通るので、ここで戻す
    this.townGroundOnly = false;
    this.cullTown();
    this.dirty = true;
  }
  /**
   * 想定の街並みのうち、区画の地面と道路だけを出す（家・塀・生垣・木・車は出さない）。
   * 日照の画面で、実際の周辺（建物・航空写真・地形）を取る前の下敷きに使う: 平らな緑の地面だけだと殺風景だが、
   * 想像の家を建てると「実在しない建物の影」が計画建物に落ちてしまう。地面と道だけなら影は変わらない。
   */
  private townGroundOnly = false;
  setTownGround(on: boolean) {
    if (this.townGroundOnly === on) return;
    this.townGroundOnly = on;
    this.cullTown();
    this.dirty = true;
  }
  /** カメラと建物の間に入る隣家、カメラに近すぎる隣家は隠す（視界を塞がない） */
  private cullTown() {
    const ground = this.townVisible || this.townGroundOnly;
    if (this.townRoads && this.townRoads.visible !== ground) {
      this.townRoads.visible = ground;
      this.dirty = true;
    }
    if (!this.town.length) return;
    this.syncShadowWide();
    const cam = this.camera.position;
    const tgt = this.controls.target;
    const ray = new THREE.Ray(cam.clone(), tgt.clone().sub(cam).normalize());
    const dist = cam.distanceTo(tgt);
    const hit = new THREE.Vector3();
    for (const t of this.town) {
      let show = this.townVisible;
      if (show) {
        // カメラが区画の中（または 1 m 以内）: 生垣・庭木が目の前に来るので、区画の物を隠す
        if (t.box.clone().expandByScalar(1).containsPoint(cam)) show = false;
        // 視線（カメラ → 注視点）が家のそばを通る: 建物を塞ぐので隠す
        else if (t.solid && ray.intersectBox(t.solid.clone().expandByScalar(3), hit) && hit.distanceTo(cam) < dist - 1) show = false;
        // 高い視点（鳥瞰）では、カメラの足元からカメラと建物の中ほどまでにある家は隠す（手前の屋根が画面を塞ぐ）
        else if (t.solid && cam.y > 7) {
          const c = t.solid.getCenter(hit);
          const to = new THREE.Vector3(c.x - cam.x, 0, c.z - cam.z);
          const fwd = new THREE.Vector3(tgt.x - cam.x, 0, tgt.z - cam.z);
          const span = fwd.length();
          if (t.solid.distanceToPoint(new THREE.Vector3(cam.x, 0, cam.z)) < 8 || (span > 1 && to.dot(fwd) / span > -4 && to.length() < span * 0.62)) show = false;
        }
      }
      if (t.g.visible !== show) {
        t.g.visible = show;
        this.dirty = true;
      }
      if (t.flat.visible !== ground) {
        t.flat.visible = ground;
        this.dirty = true;
      }
    }
  }

  /**
   * 影の範囲を街並みまで広げるか。高い視点（鳥瞰）で街並みが出ているときだけ広げる:
   * 目の高さの外観・内観では、建物のまわりだけを細かい影で描く（塀の格子・窓の見込みの影を鈍らせない）
   */
  private shadowWide = false;
  private syncShadowWide() {
    const wide = this.townVisible && this.town.length > 0 && !this.cut && this.camera.position.y > 7 && !this.cameraInside();
    if (wide === this.shadowWide) return;
    this.shadowWide = wide;
    this.fitShadow(undefined, false);
  }

  /**
   * 街並みの区画のうち、影の範囲に丸ごと入るものだけが影を落とす。
   * 範囲からはみ出す家に影を落とさせると、影が途中で切れて、何もない地面に三角形の影が浮く
   */
  private updateTownCasters() {
    if (!this.town.length) return;
    const c = this.sun.target.position;
    const r = this.sun.shadow.camera.right - 1;
    const sp = new THREE.Sphere();
    for (const t of this.town) {
      t.box.getBoundingSphere(sp);
      const cast = this.shadowWide && Math.hypot(sp.center.x - c.x, sp.center.z - c.z) + sp.radius < r;
      if (cast === t.cast) continue;
      t.cast = cast;
      t.g.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = cast;
      });
      this.dirty = true;
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
      if (!key || key.startsWith('ext.glass') || key.startsWith('f.') || key === 'cut.north' || key.startsWith('int.ceiling')) return;
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
    this.probeDirty = true;
    clearGroup(this.groups.lights);
    this.lampSets = null;
    if (!this.state) return;
    const tod = this.design.timeOfDay;
    const night = tod === 'night' || tod === 'evening';
    const kelvin = interiorFor(this.design).lightKelvin;
    const dim = tod === 'evening' ? 0.75 : 1;
    // 室内の灯りは 2 組: 室内から見るとき（inner）と、外から見るとき（outer）。カメラの位置で切り替える（applyLightsVisibility）
    const inner = new THREE.Group();
    inner.name = 'lamps-inside';
    const outer = new THREE.Group();
    outer.name = 'lamps-outside';
    if (night) {
      // ---- 室内から: 天井の器具は下向きの光。床・家具と、壁の下の方を照らし、天井には直接当てない
      // （以前は天井のすぐ下に置いた全方向の光で、天井に白い光の塊ができ、壁も天井も同じ明るさだった）。
      // 色は、写真の白の基準（materials.ts の LAMP_WB）で見た色: 電球色をそのまま出すと、夜の室内が一面の橙になる
      const col = lampTint(kelvin);
      const down = (pos: THREE.Vector3, k: number) => {
        const sp = new THREE.SpotLight(col, this.look.lampSpot * dim * k, 9, 1.22, 1, 1.5);
        sp.position.set(pos.x, pos.y - 0.04, pos.z);
        sp.target.position.set(pos.x, pos.y - 3, pos.z);
        inner.add(sp, sp.target);
      };
      // ダウンライトの家は、見えている器具のまとまり（3 灯一列・1 灯）の位置から。光のだまりが器具の真下にできる
      const downlights = this.state.meta.downlights;
      const litRooms = new Set(downlights.map((d) => d.roomId));
      for (const d of downlights) down(d.pos, d.lamps >= 3 ? 1 : d.lamps === 2 ? 0.8 : 0.6);
      // ---- 外から: 天井のすぐ下の全方向の光（今までどおり）。窓越しに天井と壁が電球色に灯って見える
      // （下向きの光だけにすると、外から見上げる窓は暗い天井しか写らず、夜景の「窓の灯り」が消える）
      const warm = kelvinToColor(kelvin);
      for (const l of this.state.lights) {
        if (l.kind === 'ceiling') {
          if (!litRooms.has(l.roomId)) down(l.pos, 1);
        } else {
          const p = new THREE.PointLight(col, (l.kind === 'pendant' ? 3 : 1.2) * dim, 7, 1.6);
          p.position.copy(l.pos);
          inner.add(p);
        }
        const q = new THREE.PointLight(warm, (l.kind === 'ceiling' ? 6 : l.kind === 'pendant' ? 3 : 1.2) * dim, 7, 1.6);
        q.position.copy(l.pos);
        if (l.kind === 'ceiling') q.position.y -= 0.3;
        outer.add(q);
      }
      // 外部の照明（ポーチ・植栽のアップライト・フットライト）
      this.groups.lights.add(buildExteriorLights({ meta: this.state.meta, plan: this.state.plan, lights: [], mode: tod, skyE: 1, lampColor: warm, physical: false }));
    } else {
      // 昼の補助光（部屋ごとに 1 つ）は弱く: 部屋の真ん中の点の光は、壁も天井も同じ明るさにしてしまう。
      // 昼の明るさは窓からの光（面の光）で作る。部屋の中ほどに置いて天井・壁・床をまんべんなく照らす（間接光の近似）
      const used = new Set<string>();
      for (const l of this.state.lights) {
        if (l.kind !== 'ceiling' || used.has(l.roomId)) continue;
        used.add(l.roomId);
        const p = new THREE.PointLight('#fff6ea', this.portalLights.length ? this.look.dayFill : 2.2, 7, 1.0);
        p.position.copy(l.pos);
        p.position.y -= 1.2;
        inner.add(p);
      }
    }
    this.groups.lights.add(inner, outer);
    this.lampSets = { inner, outer };
    this.syncDayLights();
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
    if (this.doorAuto.size) this.closeAutoDoors(true);
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
          stairBuild: stairBuildOf(this.design),
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
          const frac = sec ? 0 : info.kind === 'swing' ? Math.max(info.cutOpen, 0.35) : info.cutOpen;
          if (info.kind === 'swing') g.rotation.y = info.yaw0 + info.openAngle * frac;
          else if (info.kind === 'roll') g.scale.y = Math.max(0.04, 1 - frac * 0.96);
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
          // （読み取りが足した注記も、補った場所に気づけるように出す。お客様の画面では、渡す前に外してある。仕様の決まり文句は出さない）
          for (const n of labelNotes(f, true)) {
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
    setFurnitureLighting({ indirect: resolveSpec(this.design.specId, this.design.specPatch).indirectLighting });
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
    this.flushShadow();
    const selVis = this.selGroup.visible;
    this.selGroup.visible = false;
    this.handleGroup.visible = false;
    this.dimGroup.visible = false;
    this.renderer.render(this.scene, this.camera);
    this.selGroup.visible = selVis;
    this.handleGroup.visible = selVis;
    this.dimGroup.visible = selVis;
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
    // 選択の枠・ハンドルは撮影に写さない
    const selVis = this.selGroup.visible;
    this.selGroup.visible = false;
    this.handleGroup.visible = false;
    this.renderFrame(true);
    const url = this.renderer.domElement.toDataURL(mime, q);
    this.selGroup.visible = selVis;
    this.handleGroup.visible = selVis;
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

/** CAD のハンドル: 選んだ物に付く、掴んで動かす印 */
export interface Handle3D {
  id: string;
  /** rotate = 回転（丸に矢印）、size = 大きさ（四角）、end = 端を引っ張る（四角）、eave = 軒の出（矢印）、pitch = 勾配・高さ（上下の矢印）、arrow = 向き（三角） */
  kind: 'rotate' | 'size' | 'end' | 'eave' | 'pitch' | 'arrow';
  pos: THREE.Vector3;
  /** 強調（片流れの高い側など） */
  on?: boolean;
  /** ホバーの説明 */
  title?: string;
}

/** 寸法線（CAD・ウォークインホームの「選ぶと寸法が出る」）: a→b の線に端の印、中ほどに札 */
export interface DimLine3D {
  id: string;
  a: THREE.Vector3;
  b: THREE.Vector3;
  label: string;
  /** size = 物の寸法（濃い線）、gap = 壁・隣の物までの距離（青い線） */
  kind?: 'size' | 'gap';
  /** 札をクリックして数値（mm）を打てる（onDimEdit に id と値が来る） */
  editable?: boolean;
}

const handleTexCache = new Map<string, THREE.CanvasTexture>();
/** ハンドルの絵（64px のキャンバス。白地に橙の縁、種類ごとの記号） */
function handleTexture(kind: Handle3D['kind'], on: boolean): THREE.CanvasTexture {
  const key = `${kind}:${on ? 1 : 0}`;
  const hit = handleTexCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const orange = '#ff7a1a';
  g.lineWidth = 5;
  g.strokeStyle = orange;
  g.fillStyle = on ? orange : '#fff';
  const ink = on ? '#fff' : orange;
  if (kind === 'size' || kind === 'end') {
    g.fillRect(14, 14, 36, 36);
    g.strokeRect(14, 14, 36, 36);
  } else if (kind === 'arrow') {
    g.beginPath();
    g.moveTo(32, 8);
    g.lineTo(56, 52);
    g.lineTo(8, 52);
    g.closePath();
    g.fill();
    g.stroke();
  } else {
    g.beginPath();
    g.arc(32, 32, 24, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.strokeStyle = ink;
    g.fillStyle = ink;
    g.lineWidth = 4;
    if (kind === 'rotate') {
      // 回る矢印
      g.beginPath();
      g.arc(32, 32, 12, -Math.PI * 0.2, Math.PI * 1.35);
      g.stroke();
      g.beginPath();
      g.moveTo(44, 16);
      g.lineTo(46, 30);
      g.lineTo(34, 26);
      g.closePath();
      g.fill();
    } else if (kind === 'pitch') {
      // 上下の矢印
      g.beginPath();
      g.moveTo(32, 16);
      g.lineTo(32, 48);
      g.stroke();
      g.beginPath();
      g.moveTo(32, 12);
      g.lineTo(24, 22);
      g.lineTo(40, 22);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(32, 52);
      g.lineTo(24, 42);
      g.lineTo(40, 42);
      g.closePath();
      g.fill();
    } else {
      // 軒の出: 外へ向く矢印
      g.beginPath();
      g.moveTo(16, 32);
      g.lineTo(44, 32);
      g.stroke();
      g.beginPath();
      g.moveTo(50, 32);
      g.lineTo(38, 24);
      g.lineTo(38, 40);
      g.closePath();
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  handleTexCache.set(key, t);
  return t;
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
