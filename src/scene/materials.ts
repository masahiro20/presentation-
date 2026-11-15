/**
 * マテリアルキー → マテリアル。テイスト変更時はここを差し替えるだけで即座に反映される。
 */
import * as THREE from 'three';
import { makeMaterial, leafCardTexture, leafSprayTexture, type MatSpec } from '../styles/textures';
import { TATAMI, type ExteriorStyle, type InteriorStyle } from '../styles/presets';
import { FABRIC_COLORS } from '../core/types';
import { patchRoomProbe } from './roomProbe';
import { SCALLOP } from './meshBuilder';

let scallopTex: THREE.DataTexture | null = null;
/**
 * 壁に落ちるダウンライトの光の明るさの分布（アルファ）。真下を向いた器具（配光の半角 18°、52° で消える）から、
 * 距離 1 の壁の点 (x, z)（x = 横、z = 器具からの下がり）の照度 = 配光 × 1 / (x² + 1 + z²)^1.5。
 * 上の縁は双曲線になる（器具から近い壁ほど、天井のすぐ下から光が始まる）
 */
function scallopTexture(): THREE.DataTexture {
  if (scallopTex) return scallopTex;
  const W = 64;
  const H = 128;
  const sm = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const cb = Math.cos((18 * Math.PI) / 180);
  const cc = Math.cos((52 * Math.PI) / 180);
  const e = new Float32Array(W * H);
  let max = 0;
  for (let j = 0; j < H; j++) {
    const z = SCALLOP.z * (1 - j / (H - 1));
    for (let k = 0; k < W; k++) {
      const x = SCALLOP.u * ((2 * k) / (W - 1) - 1);
      const d2 = x * x + 1 + z * z;
      let v = sm(cc, cb, z / Math.sqrt(d2)) / Math.pow(d2, 1.5);
      // 面の縁で途切れないよう、横と下の端で 0 にする
      v *= 1 - sm(0.7, 1, Math.abs(x) / SCALLOP.u);
      v *= 1 - sm(0.72, 1, z / SCALLOP.z);
      e[j * W + k] = v;
      if (v > max) max = v;
    }
  }
  const data = new Uint8Array(W * H * 4);
  for (let n = 0; n < W * H; n++) data.set([255, 255, 255, Math.round(255 * Math.pow(e[n] / max, 0.85))], n * 4);
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  scallopTex = tex;
  return tex;
}

/** 照明の色を見るときの、写真の白の基準（K） */
const LAMP_WB = 3600;

/** 影の中の線の濃さ（面の色の、線形の明るさに掛ける）: 扉の目地・手掛けの溝／台輪／天井の溝 */
const JOINT_SHADE = 0.32;
const KICK_SHADE = 0.22;
const GAP_SHADE = 0.3;

/** 面の色の影の色（線形の明るさを k 倍）。floor を渡すと、それより暗くはしない */
function shadeOf(hex: string, k: number, floor?: string): string {
  const c = new THREE.Color(hex).multiplyScalar(k);
  if (floor) {
    const m = new THREE.Color(floor);
    c.setRGB(Math.max(c.r, m.r), Math.max(c.g, m.g), Math.max(c.b, m.b));
  }
  return '#' + c.getHexString();
}

/**
 * 照明の色（色温度 K）を、写真の色に直す。電球色（2,700K）をそのまま画面に出すと橙色（255, 167, 87）で、
 * 夜の室内が一面の橙になる。建築写真はカメラの白の基準を照明に寄せて撮る（LAMP_WB）ので、暖かい白に見える
 */
export function lampTint(kelvin: number): THREE.Color {
  const k2c = (k: number) => {
    const t = k / 100;
    const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    const c = (x: number) => Math.max(0, Math.min(255, x)) / 255;
    return new THREE.Color().setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace);
  };
  const lamp = k2c(kelvin);
  const wb = k2c(LAMP_WB);
  const out = new THREE.Color(lamp.r / wb.r, lamp.g / wb.g, lamp.b / wb.b);
  const m = Math.max(out.r, out.g, out.b) || 1;
  return out.multiplyScalar(1 / m);
}

/** 室内の素材（内装・家具）か。室内の拡散光の倍率（roomProbe.ts の roomIndirect）を掛ける素材 */
export function isIndoorKey(key: string): boolean {
  return key.startsWith('int.') || key.startsWith('f.');
}

/** 階段の踏板の木（指定が無いとき）: 木の床ならその木。タイル・石の床の内装は、家具の木（食卓・造作と同じ木）に合わせる */
export function stairWoodSpec(i: InteriorStyle): MatSpec {
  return i.floor.pattern === 'woodFloor' || i.floor.pattern === 'herringbone' ? { ...i.floor, pattern: 'wood' } : { ...i.furniture.wood, pattern: 'wood' };
}

export class MaterialRegistry {
  private map = new Map<string, THREE.Material>();
  private fallback = new THREE.MeshStandardMaterial({ color: '#cccccc', roughness: 0.8 });

  constructor(
    public ext: ExteriorStyle,
    public int: InteriorStyle,
    public opts: { wallColor?: string; doorColor?: string; night?: boolean; evening?: boolean; clay?: boolean; townLook?: 'color' } = {},
  ) {
    this.rebuild();
  }

  get(key: string): THREE.Material {
    return this.map.get(key) ?? this.map.get(key.split(':')[0]) ?? this.fallback;
  }

  update(ext: ExteriorStyle, int: InteriorStyle, opts: { wallColor?: string; doorColor?: string; night?: boolean; evening?: boolean; clay?: boolean; townLook?: 'color' } = {}) {
    this.ext = ext;
    this.int = int;
    this.opts = opts;
    this.rebuild();
  }

  /** シーン内の Mesh のマテリアルを再割り当て */
  apply(root: THREE.Object3D) {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData.matKey) m.material = this.get(m.userData.matKey);
    });
  }

  private rebuild() {
    const e = this.ext;
    const i = this.int;
    const M = (s: MatSpec, side?: THREE.Side) => makeMaterial(s, { side });
    /** 戸・板張りの壁: 木目を縦に流す（家具・踏板は部材の長さの向き） */
    const vgrain = (s: MatSpec): MatSpec => (s.pattern === 'wood' ? { ...s, grainV: true } : s);
    const color = (c: string, rough = 0.6, metal = 0, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
      new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal, ...extra });
    const wall: MatSpec = this.opts.wallColor ? { ...e.wall, color: this.opts.wallColor } : e.wall;
    const night = !!this.opts.night;
    // 夕景・夜景（街並みの窓に明かりが点く）
    const dusk = night || !!this.opts.evening;
    const set = (k: string, m: THREE.Material) => this.map.set(k, m);

    // 外装
    set('ext.wall', M(wall));
    set('ext.accent', M(e.accent ?? wall));
    // 外壁の天端（笠木）は外壁の色に合わせて少し暗く（黒い家に白い縁が出ないように）
    set('ext.wallTop', M(wall));
    set('ext.foundation', M(e.foundation));
    set('ext.frame', color(e.frame.color, 0.35, Math.max(0.5, e.frame.metalness)));
    set('ext.door', M(vgrain(e.entranceDoor)));
    set('ext.roof', M(e.roof.material));
    set('ext.fascia', color(e.roof.fascia, 0.6, 0.1));
    set('ext.soffit', M(e.roof.soffit));
    set('ext.gutter', color(e.roof.fascia, 0.5, 0.2));
    set('ext.canopy', color(e.roof.fascia, 0.5, 0.2));
    set('ext.balcony', M({ pattern: 'woodFloor', color: '#8a7a68', color2: '#76685a', roughness: 0.8 }));
    // 外構: ガレージ・カーポート・駐車場の土間コンクリート、テラスのタイル、ガレージのシャッター（ガルバの横スラット）
    set('ext.concrete', color('#b8b5ae', 0.92));
    set('ext.terrace', M(i.entranceFloor));
    // シャッター: スラットの陰影は模様で出す（細い黒い線を形で並べると、離れたときに破線にちらつく）
    // ガレージの扉: サッシと同じ色の、平らな大きい板を横に重ねた扉（オーバースライダー）。
    // 以前は銀色の巻き上げシャッター（細いスラット＋箱）で、外観の正面でそこだけ安く見えていた
    // （御社のご提案: 吉田様邸の正面は、黒い平らな扉が外壁の暗い枠に納まる）
    set('ext.shutter', M({ pattern: 'slat', color: e.frame.color, size: 0.5, tile: 1.0, roughness: 0.5, metalness: 0.3, normalStrength: 0.12 }));
    // 透明ガラス（Low-E クリア）: ほぼ無色で、映り込みは控えめに。色付き・濃い不透明度だとスモークガラスのように外が曇って見える
    const glass = new THREE.MeshPhysicalMaterial({
      color: '#f2f6f7',
      metalness: 0,
      roughness: 0.02,
      transparent: true,
      opacity: night ? 0.08 : 0.13,
      envMapIntensity: 1.1,
      side: THREE.DoubleSide,
      depthWrite: false,
      ior: 1.5,
      specularIntensity: 1,
    });
    glass.userData.isGlass = true;
    set('ext.glass', glass);
    const frosted = new THREE.MeshPhysicalMaterial({
      color: night ? '#fff1d6' : '#eef2f4',
      roughness: 0.5,
      transparent: true,
      opacity: 0.85,
      emissive: night ? '#ffcf8a' : '#000000',
      emissiveIntensity: night ? 0.6 : 0,
      side: THREE.DoubleSide,
    });
    frosted.userData.isGlass = true;
    set('ext.glassFrosted', frosted);

    // 内装
    set('int.wall', M(i.wall));
    set('int.accent', M(vgrain(i.accentWall ?? i.wall)));
    set('int.bathWall', M({ pattern: 'tileFloor', color: '#e9e7e2', roughness: 0.35, tile: 1.8 }));
    set('int.wallTop', color('#e9e6e0', 0.9));
    // 輪切り模型の切り口（白い断面）
    set('cut.face', color('#f6f4f0', 0.95));
    set('cut.north', color('#2a2d33', 0.8));
    set('int.ceiling', M(i.ceiling));
    // LDK だけの天井（板張りなど）。指定が無ければ ceiling と同じ
    set('int.ceilingMain', M(i.ceilingMain ?? i.ceiling));
    set('int.floor', M(i.floor));
    set('int.wetFloor', M(i.wetFloor));
    set('int.entranceFloor', M(i.entranceFloor));
    set('int.tatami', M(TATAMI));
    // 既定: 室内の壁と同じ色のフラット扉（KAMIYA フルハイトドアをクロスになじませる納まり）
    set('int.door', M(vgrain(this.opts.doorColor ? (this.opts.doorColor === 'wood' ? { pattern: 'wood', color: '#b89572', color2: '#a2805d', roughness: 0.55 } : this.opts.doorColor === 'preset' ? i.door : { pattern: 'paint', color: this.opts.doorColor, roughness: 0.55 }) : { pattern: 'paint', color: i.wall.color, roughness: 0.6 })));
    set('int.trim', color(i.trim, 0.5));
    // 壁と同じ色の収納の扉の目地: 扉の色の影（面より一段暗い線）
    set('int.doorJoint', new THREE.MeshStandardMaterial({ color: ((this.map.get('int.door') as THREE.MeshStandardMaterial).color ?? new THREE.Color('#ffffff')).clone().multiplyScalar(JOINT_SHADE), roughness: 0.8 }));
    // 木の見切り（窓の額縁・室内窓の枠・腰壁の笠木）: 家具・造作と同じ木
    set('int.woodTrim', M(i.furniture.wood));
    // 踏板の木: 木の床ならその木。タイル・石の床の内装は、家具の木（食卓・造作と同じ木）に合わせる
    // （以前は決め打ちのオーク色で、暗い色の内装に明るい橙色の階段が立っていた。吉田様邸のご提案は、暗い木の踏板）
    set('int.stairs', M(stairWoodSpec(i)));
    // 踏板の色（こだわりの参考資料で階段ごとに選べる。指定が無ければ int.stairs = 床に合わせた木）
    set('int.stairs@oak', M({ pattern: 'wood', color: '#c2a071', color2: '#ad8c5f', roughness: 0.5 }));
    set('int.stairs@walnut', M({ pattern: 'wood', color: '#5e4634', color2: '#4e3a2b', roughness: 0.5 }));
    set('int.stairs@white', M({ pattern: 'wood', color: '#e9e4da', color2: '#dfd9cd', roughness: 0.55 }));
    set('int.stairs@black', M({ pattern: 'wood', color: '#2e2b29', color2: '#252321', roughness: 0.55 }));
    set('int.stairs@mortar', M({ pattern: 'plaster', color: '#9d9b95', color2: '#95938d', roughness: 0.62, normalStrength: 0.16 }));
    // 木の塊（昇り口の木の箱・ひな壇の台）の側面: 踏板と同じ素材。キーだけ分けて、木目を部材ごとに回さず横に通す（meshBuilder の GRAIN_KEY）
    for (const k of ['', '@oak', '@walnut', '@white', '@black', '@mortar']) set(`int.stairsMass${k}`, this.map.get(`int.stairs${k}`)!.clone());
    set('int.slab', color('#b9b5ae', 0.95));

    // 家具
    const F = i.furniture;
    set('f.wood', M(F.wood));
    set('f.fabric', M(F.fabric));
    set('f.fabric2', M(F.fabric2));
    // 家具ごとの素材の切替（3D で選んだ物の「素材」）: 木の色味 2 段階（標準はテイストの色）と張地の色。
    // 家具の部品は 'f.wood' などのキーで作られ、MeshBuilder.keyMap で 'f.wood@dark' に差し替わる
    set('f.wood@light', M({ ...F.wood, color: '#d6c2a0', color2: '#c4ac86' }));
    set('f.wood@dark', M({ ...F.wood, color: '#5b4432', color2: '#4b3728' }));
    for (const [k, , c1, c2] of FABRIC_COLORS) {
      if (!c1) continue;
      set(`f.fabric@${k}`, M({ ...F.fabric, color: c1 }));
      set(`f.fabric2@${k}`, M({ ...F.fabric2, color: c2 }));
    }
    // 鉄（階段の桁・手すり・家具の脚）: 黒皮鉄などの暗い色は金属の光り方、グレーなどの明るい色は塗装の鉄（焼付塗装）。
    // 明るい色を金属のままにすると、室内の弱い映り込みでは色が沈んで、グレーの手すりが黒く見えていた
    set('f.metal', new THREE.Color(F.metal).getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace).l > 0.4 ? color(F.metal, 0.5, 0.2) : color(F.metal, 0.35, 0.8));
    set('f.handle', color('#262626', 0.4, 0.6));
    // 黒の塗りつぶし塗装（木製スケルトン階段の側板など。金属の光り方をさせない）
    set('f.paintBlack', color('#242424', 0.62, 0.05));
    // 白く塗った鉄（階段の骨組み・手すりを白にする指定）
    set('f.steelWhite', color('#eceae5', 0.5, 0.15));
    set('f.hood', color('#e9e7e3', 0.45, 0.2));
    // LINE KITCHEN: ステンレス（バイブレーション）のシンク、レンジフードのシルバー／ブラック、キャビネット内部のチャコールグレー
    set('f.stainless', color('#b9bbbd', 0.32, 0.9));
    // 白系のキッチンのフード（ステンレス・白）。金属感を強くすると、室内の弱い映り込みでは黒く沈んで「黒いフード」に見えていた
    set('f.hoodSilver', color('#dcdcda', 0.42, 0.25));
    set('f.hoodDark', color('#1b1b1b', 0.45, 0.6));
    // Y チェアのペーパーコードの座（生成りの紙紐）
    set('f.cord', color('#d8c8a6', 0.95, 0));
    // 造作本棚に並べる本（落ち着いた色の背表紙）
    set('f.book1', color('#6f6253', 0.85));
    set('f.book2', color('#3e4246', 0.8));
    set('f.book3', color('#a99a83', 0.85));
    // ペンダントの笠（マットな生成りの白。少し光を帯びる）
    set('f.shade', color('#f1ece3', 0.85, 0, { emissive: new THREE.Color('#ffe0b8'), emissiveIntensity: night ? 1.2 : 0.12 }));
    // 和紙の球のペンダントの骨（細い線）
    // 和紙の球のペンダントの骨: 笠と同じ生成りで、わずかに濃い線（内側の灯りを受けて少し光る）。
    // 暗い色のままだと、明るい笠の上に黒い線が走って、提灯の骨組みだけが目立っていた
    set('f.shadeRib', color('#ddd5c4', 0.9, 0, { emissive: new THREE.Color('#ffe0b8'), emissiveIntensity: night ? 0.5 : 0.06 }));
    // 丸テーブルの脚: 白い内装では白い塗装の鉄、暗い内装では家具の鉄の色
    set('f.tableLeg', color(new THREE.Color(i.wall.color).getHSL({ h: 0, s: 0, l: 0 }).l > 0.7 ? '#e6e4df' : F.metal, 0.45, 0.35));
    set('f.carcass', color('#3b3b3b', 0.7, 0.1));
    // 天井の溝（間接照明・カーテンボックス）・壁と同じ色の収納の台輪: 天井の色の影。白い天井では黒い線にしない
    // （上限は今までの濃いグレー。暗い内装では今までどおり）
    set('int.shadowGap', color(shadeOf(i.ceiling.color, GAP_SHADE, '#3a3836'), 0.95));
    set('f.downlightRing', color('#f4f3f0', 0.4, 0.2));
    set('f.downlight', color('#fffaf0', 0.2, 0, { emissive: new THREE.Color('#fff1dc'), emissiveIntensity: night ? 14 : 1.2 }));
    // 間接照明の光る帯（昼も、灯っていることが分かる明るさに）
    set('f.cove', color('#fff6e8', 0.3, 0, { emissive: new THREE.Color('#ffdcaa'), emissiveIntensity: night ? 18 : 1.6 }));
    // 間接照明が壁・床を照らす光: 加算で重ねる面。光源の側（UV の v = 1）から離れるほど弱くなる（v = 0 で消える）
    {
      const N = 32;
      const data = new Uint8Array(4 * N);
      for (let k = 0; k < N; k++) {
        const t = k / (N - 1);
        data.set([255, 255, 255, Math.round(255 * t * t)], k * 4);
      }
      const tex = new THREE.DataTexture(data, 1, N, THREE.RGBAFormat);
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      set('f.coveGlow', new THREE.MeshBasicMaterial({ color: '#ffcf96', map: tex, transparent: true, opacity: night ? 0.5 : 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    }
    // ダウンライトが壁に落とす光（スカラップ）: 器具の真下から広がる、放物線の縁の光のだまり。壁の色に染めて加算で重ねる
    {
      const lamp = lampTint(i.lightKelvin);
      const wc = new THREE.Color(i.wall.color);
      const tint = new THREE.Color(lamp.r * (0.3 + 0.7 * wc.r), lamp.g * (0.3 + 0.7 * wc.g), lamp.b * (0.3 + 0.7 * wc.b));
      set('f.coveGlowScallop', new THREE.MeshBasicMaterial({ color: tint, map: scallopTexture(), transparent: true, opacity: night ? 0.62 : this.opts.evening ? 0.5 : 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    }
    set('f.chrome', color('#d9dadc', 0.15, 1));
    set('f.counter', M(F.counter));
    set('f.cabinet', M(F.cabinet));
    // 扉と扉の間の目地・手掛けの溝・台輪: 面材の色の影（面材より一段暗い）。黒で描くと、白い面材の上で線だけが浮いて見える
    // （御社のご提案: 大崎様邸のキッチンは、白い面材に細い影の目地だけ。黒い面材なら今までどおり黒い線）
    set('f.joint', color(shadeOf(F.cabinet.color, JOINT_SHADE), 0.8));
    set('f.kick', color(shadeOf(F.cabinet.color, KICK_SHADE), 0.9));
    set('f.rug', M(F.rug));
    set('f.white', color('#f6f6f4', 0.15, 0, { envMapIntensity: 1 }));
    set('f.fridge', color('#e8e8e6', 0.25, 0.3));
    set('f.screen', color('#0c0d0f', 0.12, 0.2));
    set('f.bedding', M({ pattern: 'fabric', color: '#f4f2ee', roughness: 0.95 }));
    // ローテーブルの石の天板（明るいトラバーチン調。つやは抑えめ）
    set('f.stoneTop', M({ pattern: 'marble', color: '#e7e1d6', color2: '#c9bfae', roughness: 0.34, size: 1.6, tile: 1.6 }));
    // 掛け布・小さな置きクッション（生成りのウール。薄い布なので両面を描く）
    set('f.throw', M({ pattern: 'fabric', color: '#cfc4b0', roughness: 1, tile: 0.7 }, THREE.DoubleSide));
    set('f.curtain', M({ pattern: 'fabric', color: '#ebe6de', roughness: 1, tile: 1.2 }));
    set('f.leaf', color('#3f6b2e', 0.7));
    set('f.soil', color('#3a2b20', 1));
    set('f.pot', color('#e6e1d8', 0.6));
    set('f.lampShade', color('#f2ede3', 0.7, 0, { emissive: new THREE.Color('#ffd9a0'), emissiveIntensity: night ? 1.5 : 0.05 }));
    set('f.lamp', color('#fff4dd', 0.3, 0, { emissive: new THREE.Color('#ffe2b0'), emissiveIntensity: night ? 6 : 0.5 }));
    set('f.mirror', color('#dfe6ea', 0.02, 1));
    set('f.water', new THREE.MeshPhysicalMaterial({ color: '#bcd8e0', roughness: 0.05, transmission: 0.0, transparent: true, opacity: 0.6 }));

    // 外構
    const L = e.landscape;
    // 地面の色は、テイストの指定より一段落として寒色へ少し寄せる（御社スタッフの外観パース: 地面は中間〜濃いグレーの一様な面。
    // 日なたの明るいコンクリート・砂利が画面の下 1/3 を白く占めると、建物が浮いて見える）
    const calm = (hex: string, k: number) => {
      const c = new THREE.Color(hex);
      const hsl = { h: 0, s: 0, l: 0 };
      c.getHSL(hsl, THREE.SRGBColorSpace);
      // 明るい色ほど大きく落とす（もともと濃い石・タイルはほぼそのまま）。彩度は 6 割に。
      // 上を向いた面は、空の光を壁の倍ほど受ける。壁と同じ明るさの色では、地面のほうがずっと明るく写る
      const l = hsl.l > 0.36 ? 0.36 + (hsl.l - 0.36) * k : hsl.l;
      c.setHSL(hsl.h, hsl.s * 0.6, l, THREE.SRGBColorSpace);
      return '#' + c.getHexString();
    };
    const calmSpec = (m: MatSpec, k: number): MatSpec => ({ ...m, color: calm(m.color, k), ...(m.color2 ? { color2: calm(m.color2, k) } : {}) });
    set('l.ground', M(L.ground.pattern === 'grass' ? L.ground : calmSpec(L.ground, 0.28)));
    // 敷地の外は落ち着いた緑の地面（一面の舗装は駐車場のように見えるので避ける）。彩度を抑えて建物を主役に
    set('l.far', M({ pattern: 'grass', color: '#727a60', color2: '#838a70', tile: 3 }));
    // 想定の街並み（town.ts）: 主役を引き立てる淡い色（彩度・明暗差を抑える）。壁 5 色・屋根 3 色をばらつかせる
    // 街並み（想定の隣家）の見せ方。既定は「淡い量塊」: 壁・屋根・窓を、ほぼ同じ淡い色の塊で見せる
    // （御社スタッフの Twinmotion の外観: 隣家は白い箱。主役の家だけに色と素材がある。
    //  窓・玄関戸・屋根の色まで描き分けると、想定の家並みが主役と同じ濃さで並び、絵がうるさくなる）。
    // townLook = 'color' で、今までの色付きの家並み
    const massing = this.opts.townLook !== 'color';
    if (massing) {
      // 空より少し明るい程度の、青みのある淡いグレー（白すぎると、画面の端で主役より目立つ）
      set('l.nbWallA', color('#d3d7da', 0.95));
      set('l.nbWallB', color('#cdd2d6', 0.95));
      set('l.nbWallC', color('#c7ccd1', 0.95));
      set('l.nbWallD', color('#d1d4d5', 0.95));
      set('l.nbWallE', color('#c1c7cc', 0.95));
      set('l.nbRoofA', color('#b6bcc2', 0.85));
      set('l.nbRoofB', color('#bbc0c4', 0.85));
      set('l.nbRoofC', color('#b2b9c0', 0.8));
      set('l.nbRoof', color('#b4bac0', 0.85));
      // 窓は、壁よりわずかに沈んだ淡い青み（穴が開いていることだけ分かる）。枠・玄関戸・基礎は壁の色
      set('l.nbGlass', color('#b6c1cb', 0.5, 0, { envMapIntensity: 0.6 }));
      set('l.nbFrame', color('#cdd2d6', 0.8));
    } else {
      set('l.nbWallA', color('#cdc9c0', 0.95));
      set('l.nbWallB', color('#bfbab0', 0.95));
      set('l.nbWallC', color('#b3b0aa', 0.95));
      set('l.nbWallD', color('#c6bfb1', 0.95));
      set('l.nbWallE', color('#9a9995', 0.95));
      set('l.nbRoofA', color('#4b4d50', 0.7));
      set('l.nbRoofB', color('#5d564f', 0.75));
      set('l.nbRoofC', color('#6d7073', 0.5, 0.25));
      set('l.nbRoof', color('#45474a', 0.75));
      // 窓は空を映す暗いガラス、枠は白、玄関戸は濃い茶、基礎は明るいコンクリート色
      // （つやを強くしすぎると、太陽の映り込みが白い点になって、室内から見た隣家の窓に明かりの粒が並ぶ）
      set('l.nbGlass', color('#56636e', 0.26, 0.2, { envMapIntensity: 1.3 }));
      set('l.nbFrame', color('#d9d7d1', 0.6));
    }
    // 夕景・夜景では、街並みの窓の一部に明かりが点く（昼は普通のガラス）
    set('l.nbGlassLit', dusk ? color('#f1d7a6', 0.4, 0, { emissive: new THREE.Color('#ffcf8a'), emissiveIntensity: night ? 0.9 : 0.6 }) : (this.map.get('l.nbGlass') as THREE.MeshStandardMaterial).clone());
    // 生垣の芯（葉のカードの奥に見える濃い緑のかたまり）
    // （淡い量塊の街並みでも、芯は葉より暗く: 芯だけ淡いと、淡い箱に濃い葉が点々と貼り付いた斑模様に見える）
    set('l.hedge', M({ pattern: 'grass', color: massing ? '#4c5f42' : '#34482c', color2: massing ? '#586c4d' : '#3f5634', tile: 1.2, roughness: 0.95 }));
    set('l.nbDoor', color(massing ? '#c0c5c9' : '#4a4038', 0.6));
    set('l.nbBase', color(massing ? '#c5cace' : '#b9b6af', 0.92));
    // 区画の地面（砂利・土間・芝）と駐車場の舗装、道路の側溝
    // 淡い量塊の街並みでは、隣の区画の地面も、主役の敷地の地面と同じ中間のグレーにそろえる（区画ごとの明るい斑を作らない）
    set('l.nbLotA', M({ pattern: 'gravel', color: massing ? '#8f9193' : '#aba69c', color2: massing ? '#858789' : '#98948b' }));
    set('l.nbLotB', M({ pattern: 'gravel', color: massing ? '#898b8d' : '#a39f95', color2: massing ? '#808284' : '#918d84' }));
    set('l.nbLotC', M({ pattern: 'grass', color: massing ? '#8f987f' : '#7d8767', color2: massing ? '#99a189' : '#8c9474', tile: 3 }));
    set('l.nbPave', M({ pattern: 'plaster', color: massing ? '#868889' : '#b0ada7', roughness: 0.9, tile: 5 }));
    set('l.gutter', color(massing ? '#9a9b9a' : '#bdbab3', 0.9));
    set('l.nbCarLight', color(massing ? '#dfe1e3' : '#e9e9e6', 0.3, massing ? 0.1 : 0.3));
    set('l.nbCarDark', color(massing ? '#b4b8bc' : '#2c2e31', 0.3, massing ? 0.1 : 0.4));
    set('l.nbCarGrey', color(massing ? '#c9ccd0' : '#8c8f93', 0.3, massing ? 0.1 : 0.5));
    // 道路: 淡い量塊の街並みでは、アスファルトを一段明るく・線を控えめに（画面の下 1/3 を濃い帯と白い線が占めない）
    set('l.road', M({ pattern: 'asphalt', color: massing ? '#6a6c6f' : '#4a4b4d', tile: 6 }));
    set('l.curb', color(massing ? '#9b9c9b' : '#b8b6b0', 0.9));
    // 道路の白線（OpenStreetMap の街路用）
    set('l.roadLine', color(massing ? '#b9babb' : '#e8e6e0', 0.8));
    // 駐車場の土間コンクリート: 金ごて仕上げの一様な面（型枠の割り・セパ穴は壁のもの。床には出ない）
    set('l.driveway', M(L.driveway.pattern === 'concrete' ? { ...calmSpec(L.driveway, 0.28), pattern: 'plaster', tile: 5, normalStrength: 0.12 } : calmSpec(L.driveway, 0.28)));
    set('l.approach', M(calmSpec(L.approach, 0.5)));
    set('l.porch', M(L.approach));
    // 塀のブロックはグレーに塗る（施工写真）。木ルーバーは黄味を抑えた落ち着いた茶（ウリンや塗装のアコヤ）
    set('l.block', M({ pattern: 'plaster', color: '#a9a6a0', color2: '#9e9b95', roughness: 0.92, normalStrength: 0.2 }));
    // 高低差の処理: RC 擁壁（打放しの明るいグレー）、石積み（間知ブロックの暗い灰褐色）
    set('l.retain', M({ pattern: 'plaster', color: '#b6b3ab', color2: '#a7a49c', roughness: 0.9, normalStrength: 0.25 }));
    set('l.stone', M({ pattern: 'plaster', color: '#8d877c', color2: '#7a756b', roughness: 0.95, normalStrength: 0.45, tile: 0.6 }));
    set('l.fenceWood', M({ pattern: 'wood', color: '#7a6350', color2: '#64503f', roughness: 0.75 }));
    // 庭を囲む白い塗り壁の塀と、その笠木（薄いグレーの金物）
    set('l.gardenWall', M({ pattern: 'plaster', color: '#e7e5e0', color2: '#deddd7', roughness: 0.94, normalStrength: 0.18 }));
    set('l.gardenWallCap', color('#b9b8b4', 0.6, 0.2));
    // 庭のウッドデッキ（ハードウッドの板。少し灰色がかった茶）と、庭の芝
    set('l.deck', M({ pattern: 'woodFloor', color: '#8a7460', color2: '#786452', roughness: 0.8 }));
    set('l.lawn', M({ pattern: 'grass', color: '#647648', color2: '#73855a', tile: 2 }));
    // 幹・枝: 灰色がかった樹皮（アオダモ・ヤマボウシの株立ち。赤茶色だと枝が太く重く見える）
    set('l.trunk', color('#6f675d', 0.9));
    set('l.leaf', color('#4d7a33', 0.75));
    set('l.leafDark', color('#3a5f2a', 0.8));
    set('l.leafLight', color('#6a9444', 0.75));
    // 葉は光を透かす: 影の側の葉も、葉の色でうっすら明るい（逆光の葉が黒い塊にならない）。
    // 葉の絵そのものを弱く光らせて近似する（昼 0.22・夕 0.1・夜はほぼ 0）
    const leafGlow = night ? 0.01 : this.opts.evening ? 0.1 : 0.22;
    const leafOf = (map: THREE.Texture, roughness: number) =>
      new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, roughness, emissive: new THREE.Color('#ffffff'), emissiveMap: map, emissiveIntensity: leafGlow });
    const leafMat = (c1: string, c2: string, seed: number) => leafOf(leafCardTexture(c1, c2, seed), 0.7);
    set('l.leafCard', leafMat('#5f8a3c', '#9dbb5c', 3));
    set('l.leafSpray', leafOf(leafSprayTexture('#5e8c3a', '#a9c766', 5), 0.65));
    set('l.leafCardDark', leafMat('#3f6630', '#6f9448', 7));
    // 街並みの庭木（少し明るく黄味のある葉。主役の植栽より淡く）
    set('l.leafCardSoft', leafMat('#6f9450', '#a6c078', 11));
    set('l.soilDark', color('#4a3b2f', 0.95));
    // 外構に置く物（車・BBQ・物置・ポスト・庭園灯）
    set('x.carBody', color('#3a3c40', 0.35, 0.6));
    set('x.carGlass', color('#1d2328', 0.1, 0.4));
    set('x.tire', color('#141414', 0.9));
    set('x.steel', color('#9a9c9e', 0.35, 0.8));
    set('x.steelDark', color('#2b2d30', 0.55, 0.4));
    set('x.shed', color('#8d9094', 0.6, 0.3));
    set('x.shedRoof', color('#3f4246', 0.6, 0.3));
    set('x.lamp', color('#fff2d6', 0.3, 0, { emissive: new THREE.Color('#ffe2b0'), emissiveIntensity: night ? 4 : 0.3 }));

    for (const [k, m] of this.map) {
      m.name = k;
      // 室内は空からの環境光が壁で遮られるため弱める（窓からの日射と室内照明で照らす）
      if ((k.startsWith('int.') || k.startsWith('f.')) && 'envMapIntensity' in m && !m.userData.isGlass) {
        (m as THREE.MeshStandardMaterial).envMapIntensity = k === 'f.chrome' || k === 'f.mirror' ? 0.8 : k.startsWith('int.') && /floor|Floor|tatami/.test(k) ? 0.55 : 0.4;
      }
    }
    // 白模型（スタディ模型）: ガラス以外を白いクレイに。外構は淡いグレー、植栽の葉はそのまま
    if (this.opts.clay) {
      // 線を重ねるため面を少し奥へ（polygonOffset）
      const clayM = color('#edebe6', 0.92, 0, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      const clayGround = color('#d6d3cd', 1);
      const clayRoad = color('#c9c6c0', 1);
      const hidden = new THREE.MeshBasicMaterial({ visible: false });
      for (const [k, m] of [...this.map]) {
        if ((m as THREE.Material).userData?.isGlass) continue;
        if (k.startsWith('l.leaf') || k === 'l.trunk') continue;
        // 光の帯（加算の薄い面）は白模型では出さない
        if (k.startsWith('f.coveGlow')) {
          this.map.set(k, hidden);
          continue;
        }
        if (k === 'l.road' || k === 'l.curb') this.map.set(k, clayRoad);
        else if (k.startsWith('l.')) this.map.set(k, clayGround);
        else if (k === 'cut.north' || k === 'int.shadowGap') this.map.set(k, color('#55575b', 0.9));
        else this.map.set(k, clayM);
      }
    }
    // 部屋の映り込み（床・天板・ガラスに、窓と照明が映る）を、標準・物理マテリアルすべてに足す
    // 内装・家具の素材には、室内の拡散光の倍率も掛かるようにする（白模型は、内外で同じ素材を使うので掛けない）
    for (const [k, m] of this.map) patchRoomProbe(m, !this.opts.clay && isIndoorKey(k));
    patchRoomProbe(this.fallback);
  }
}
