/**
 * マテリアルキー → マテリアル。テイスト変更時はここを差し替えるだけで即座に反映される。
 */
import * as THREE from 'three';
import { makeMaterial, leafCardTexture, type MatSpec } from '../styles/textures';
import { TATAMI, type ExteriorStyle, type InteriorStyle } from '../styles/presets';

export class MaterialRegistry {
  private map = new Map<string, THREE.Material>();
  private fallback = new THREE.MeshStandardMaterial({ color: '#cccccc', roughness: 0.8 });

  constructor(
    public ext: ExteriorStyle,
    public int: InteriorStyle,
    public opts: { wallColor?: string; doorColor?: string; night?: boolean } = {},
  ) {
    this.rebuild();
  }

  get(key: string): THREE.Material {
    return this.map.get(key) ?? this.map.get(key.split(':')[0]) ?? this.fallback;
  }

  update(ext: ExteriorStyle, int: InteriorStyle, opts: { wallColor?: string; doorColor?: string; night?: boolean } = {}) {
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
    const color = (c: string, rough = 0.6, metal = 0, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
      new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal, ...extra });
    const wall: MatSpec = this.opts.wallColor ? { ...e.wall, color: this.opts.wallColor } : e.wall;
    const night = !!this.opts.night;
    const set = (k: string, m: THREE.Material) => this.map.set(k, m);

    // 外装
    set('ext.wall', M(wall));
    set('ext.accent', M(e.accent ?? wall));
    set('ext.wallTop', color('#d8d6d2', 0.9));
    set('ext.foundation', M(e.foundation));
    set('ext.frame', color(e.frame.color, 0.4, e.frame.metalness));
    set('ext.door', M(e.entranceDoor));
    set('ext.roof', M(e.roof.material));
    set('ext.fascia', color(e.roof.fascia, 0.6, 0.1));
    set('ext.soffit', M(e.roof.soffit));
    set('ext.gutter', color(e.roof.fascia, 0.5, 0.2));
    set('ext.canopy', color(e.roof.fascia, 0.5, 0.2));
    set('ext.balcony', M({ pattern: 'woodFloor', color: '#8a7a68', color2: '#76685a', roughness: 0.8 }));
    const glass = new THREE.MeshPhysicalMaterial({
      color: '#aebfc8',
      metalness: 0,
      roughness: 0.02,
      transparent: true,
      opacity: night ? 0.12 : 0.3,
      envMapIntensity: 1.2,
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
    set('int.accent', M(i.accentWall ?? i.wall));
    set('int.bathWall', M({ pattern: 'tileFloor', color: '#e9e7e2', roughness: 0.35, tile: 1.8 }));
    set('int.wallTop', color('#e9e6e0', 0.9));
    set('int.ceiling', M(i.ceiling));
    set('int.floor', M(i.floor));
    set('int.wetFloor', M(i.wetFloor));
    set('int.entranceFloor', M(i.entranceFloor));
    set('int.tatami', M(TATAMI));
    set('int.door', M(this.opts.doorColor ? (this.opts.doorColor === 'wood' ? { pattern: 'wood', color: '#b89572', color2: '#a2805d', roughness: 0.55 } : { pattern: 'paint', color: this.opts.doorColor, roughness: 0.55 }) : i.door));
    set('int.trim', color(i.trim, 0.5));
    set('int.stairs', M(i.floor.pattern === 'woodFloor' || i.floor.pattern === 'herringbone' ? { ...i.floor, pattern: 'wood' } : { pattern: 'wood', color: '#b8905f', color2: '#a07a4f' }));
    set('int.slab', color('#b9b5ae', 0.95));

    // 家具
    const F = i.furniture;
    set('f.wood', M(F.wood));
    set('f.fabric', M(F.fabric));
    set('f.fabric2', M(F.fabric2));
    set('f.metal', color(F.metal, 0.35, 0.8));
    set('f.handle', color('#262626', 0.4, 0.6));
    set('f.hood', color('#e9e7e3', 0.45, 0.2));
    set('int.shadowGap', color('#3a3836', 0.95));
    set('f.downlightRing', color('#f4f3f0', 0.4, 0.2));
    set('f.downlight', color('#fffaf0', 0.2, 0, { emissive: new THREE.Color('#fff1dc'), emissiveIntensity: night ? 14 : 1.2 }));
    set('f.cove', color('#fff6e8', 0.3, 0, { emissive: new THREE.Color('#ffdcaa'), emissiveIntensity: night ? 18 : 0.6 }));
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
    set('l.far', M({ pattern: 'grass', color: '#6f8452', color2: '#8a9a66', tile: 12 }));
    set('l.road', M({ pattern: 'asphalt', color: '#4a4b4d', tile: 6 }));
    set('l.curb', color('#b8b6b0', 0.9));
    set('l.driveway', M(L.driveway));
    set('l.approach', M(L.approach));
    set('l.porch', M(L.approach));
    set('l.block', M({ pattern: 'concrete', color: '#bdbab3', tile: 2 }));
    set('l.fenceWood', M({ pattern: 'wood', color: '#9a7654', color2: '#7d5d40', roughness: 0.8 }));
    set('l.trunk', color('#5a4636', 0.9));
    set('l.leaf', color('#4d7a33', 0.75));
    set('l.leafDark', color('#3a5f2a', 0.8));
    set('l.leafLight', color('#6a9444', 0.75));
    const leafMat = (c1: string, c2: string, seed: number) =>
      new THREE.MeshStandardMaterial({ map: leafCardTexture(c1, c2, seed), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.7 });
    set('l.leafCard', leafMat('#5f8a3c', '#9dbb5c', 3));
    set('l.leafCardDark', leafMat('#3f6630', '#6f9448', 7));

    for (const [k, m] of this.map) {
      m.name = k;
      // 室内は空からの環境光が壁で遮られるため弱める（窓からの日射と室内照明で照らす）
      if ((k.startsWith('int.') || k.startsWith('f.')) && 'envMapIntensity' in m && !m.userData.isGlass) {
        (m as THREE.MeshStandardMaterial).envMapIntensity = k === 'f.chrome' || k === 'f.mirror' ? 0.8 : 0.35;
      }
    }
  }
}
