/**
 * マテリアルキー → マテリアル。テイスト変更時はここを差し替えるだけで即座に反映される。
 */
import * as THREE from 'three';
import { makeMaterial, leafCardTexture, leafSprayTexture, type MatSpec } from '../styles/textures';
import { TATAMI, type ExteriorStyle, type InteriorStyle } from '../styles/presets';
import { FABRIC_COLORS } from '../core/types';
import { patchRoomProbe } from './roomProbe';

export class MaterialRegistry {
  private map = new Map<string, THREE.Material>();
  private fallback = new THREE.MeshStandardMaterial({ color: '#cccccc', roughness: 0.8 });

  constructor(
    public ext: ExteriorStyle,
    public int: InteriorStyle,
    public opts: { wallColor?: string; doorColor?: string; night?: boolean; evening?: boolean; clay?: boolean } = {},
  ) {
    this.rebuild();
  }

  get(key: string): THREE.Material {
    return this.map.get(key) ?? this.map.get(key.split(':')[0]) ?? this.fallback;
  }

  update(ext: ExteriorStyle, int: InteriorStyle, opts: { wallColor?: string; doorColor?: string; night?: boolean; evening?: boolean; clay?: boolean } = {}) {
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
    set('ext.shutter', M({ pattern: 'slat', color: '#8e9195', roughness: 0.6, metalness: 0.25, normalStrength: 0.28 }));
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
    set('int.stairs', M(i.floor.pattern === 'woodFloor' || i.floor.pattern === 'herringbone' ? { ...i.floor, pattern: 'wood' } : { pattern: 'wood', color: '#b8905f', color2: '#a07a4f' }));
    // 踏板の色（こだわりの参考資料で階段ごとに選べる。指定が無ければ int.stairs = 床に合わせた木）
    set('int.stairs@oak', M({ pattern: 'wood', color: '#c2a071', color2: '#ad8c5f', roughness: 0.5 }));
    set('int.stairs@walnut', M({ pattern: 'wood', color: '#5e4634', color2: '#4e3a2b', roughness: 0.5 }));
    set('int.stairs@white', M({ pattern: 'wood', color: '#e9e4da', color2: '#dfd9cd', roughness: 0.55 }));
    set('int.stairs@black', M({ pattern: 'wood', color: '#2e2b29', color2: '#252321', roughness: 0.55 }));
    set('int.stairs@mortar', M({ pattern: 'plaster', color: '#9d9b95', color2: '#95938d', roughness: 0.62, normalStrength: 0.16 }));
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
    set('f.metal', color(F.metal, 0.35, 0.8));
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
    set('f.carcass', color('#3b3b3b', 0.7, 0.1));
    set('int.shadowGap', color('#3a3836', 0.95));
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
    set('f.chrome', color('#d9dadc', 0.15, 1));
    set('f.counter', M(F.counter));
    set('f.cabinet', M(F.cabinet));
    set('f.rug', M(F.rug));
    set('f.white', color('#f6f6f4', 0.15, 0, { envMapIntensity: 1 }));
    set('f.fridge', color('#e8e8e6', 0.25, 0.3));
    set('f.screen', color('#0c0d0f', 0.12, 0.2));
    set('f.bedding', M({ pattern: 'fabric', color: '#f4f2ee', roughness: 0.95 }));
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
    set('l.ground', M(L.ground));
    // 敷地の外は落ち着いた緑の地面（一面の舗装は駐車場のように見えるので避ける）。彩度を抑えて建物を主役に
    set('l.far', M({ pattern: 'grass', color: '#727a60', color2: '#838a70', tile: 3 }));
    // 想定の街並み（town.ts）: 主役を引き立てる淡い色（彩度・明暗差を抑える）。壁 5 色・屋根 3 色をばらつかせる
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
    set('l.nbGlass', color('#56636e', 0.1, 0.2, { envMapIntensity: 1.3 }));
    set('l.nbFrame', color('#d9d7d1', 0.6));
    // 夕景・夜景では、街並みの窓の一部に明かりが点く（昼は普通のガラス）
    set('l.nbGlassLit', dusk ? color('#f1d7a6', 0.4, 0, { emissive: new THREE.Color('#ffcf8a'), emissiveIntensity: night ? 0.9 : 0.6 }) : color('#56636e', 0.1, 0.2, { envMapIntensity: 1.3 }));
    // 生垣の芯（葉のカードの奥に見える濃い緑のかたまり）
    set('l.hedge', M({ pattern: 'grass', color: '#34482c', color2: '#3f5634', tile: 1.2, roughness: 0.95 }));
    set('l.nbDoor', color('#4a4038', 0.6));
    set('l.nbBase', color('#b9b6af', 0.92));
    // 区画の地面（砂利・土間・芝）と駐車場の舗装、道路の側溝
    set('l.nbLotA', M({ pattern: 'gravel', color: '#aba69c', color2: '#98948b' }));
    set('l.nbLotB', M({ pattern: 'gravel', color: '#a39f95', color2: '#918d84' }));
    set('l.nbLotC', M({ pattern: 'grass', color: '#7d8767', color2: '#8c9474', tile: 3 }));
    set('l.nbPave', M({ pattern: 'concrete', color: '#b0ada7', roughness: 0.9 }));
    set('l.gutter', color('#bdbab3', 0.9));
    set('l.nbCarLight', color('#e9e9e6', 0.3, 0.3));
    set('l.nbCarDark', color('#2c2e31', 0.3, 0.4));
    set('l.nbCarGrey', color('#8c8f93', 0.3, 0.5));
    set('l.road', M({ pattern: 'asphalt', color: '#4a4b4d', tile: 6 }));
    set('l.curb', color('#b8b6b0', 0.9));
    // 道路の白線（OpenStreetMap の街路用）
    set('l.roadLine', color('#e8e6e0', 0.8));
    set('l.driveway', M(L.driveway));
    set('l.approach', M(L.approach));
    set('l.porch', M(L.approach));
    // 塀のブロックはグレーに塗る（施工写真）。木ルーバーは黄味を抑えた落ち着いた茶（ウリンや塗装のアコヤ）
    set('l.block', M({ pattern: 'plaster', color: '#a9a6a0', color2: '#9e9b95', roughness: 0.92, normalStrength: 0.2 }));
    // 高低差の処理: RC 擁壁（打放しの明るいグレー）、石積み（間知ブロックの暗い灰褐色）
    set('l.retain', M({ pattern: 'plaster', color: '#b6b3ab', color2: '#a7a49c', roughness: 0.9, normalStrength: 0.25 }));
    set('l.stone', M({ pattern: 'plaster', color: '#8d877c', color2: '#7a756b', roughness: 0.95, normalStrength: 0.45, tile: 0.6 }));
    set('l.fenceWood', M({ pattern: 'wood', color: '#7a6350', color2: '#64503f', roughness: 0.75 }));
    set('l.trunk', color('#5a4636', 0.9));
    set('l.leaf', color('#4d7a33', 0.75));
    set('l.leafDark', color('#3a5f2a', 0.8));
    set('l.leafLight', color('#6a9444', 0.75));
    const leafMat = (c1: string, c2: string, seed: number) =>
      new THREE.MeshStandardMaterial({ map: leafCardTexture(c1, c2, seed), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.7 });
    set('l.leafCard', leafMat('#5f8a3c', '#9dbb5c', 3));
    set('l.leafSpray', new THREE.MeshStandardMaterial({ map: leafSprayTexture('#5e8c3a', '#a9c766', 5), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.65 }));
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
    for (const m of this.map.values()) patchRoomProbe(m);
    patchRoomProbe(this.fallback);
  }
}
