/**
 * テイスト（仕上げイメージ）プリセット
 * お客様が「こういうイメージ」を選ぶだけで外観・内観の仕上げが決まる。
 */
import type { MatSpec } from './textures';

export type RoofType = 'gable' | 'hip' | 'shed' | 'flat';

export interface ExteriorStyle {
  id: string;
  name: string;
  catch: string;
  description: string;
  /** カード表示用の配色 [外壁, アクセント, 屋根, サッシ] */
  swatch: string[];
  roof: {
    type: RoofType;
    /** 勾配 (寸) = 10 に対する立ち上がり */
    pitch: number;
    /** 軒の出 (mm) */
    eaves: number;
    /** けらばの出 (mm) */
    verge: number;
    material: MatSpec;
    fascia: string;
    soffit: MatSpec;
    gutter: boolean;
  };
  wall: MatSpec;
  /** 2階・玄関まわりなどのアクセント外壁 */
  accent?: MatSpec;
  accentRule: 'upper' | 'entrance' | 'lower' | 'none';
  foundation: MatSpec;
  frame: { color: string; metalness: number };
  entranceDoor: MatSpec;
  /** 外構 */
  landscape: {
    ground: MatSpec;
    approach: MatSpec;
    driveway: MatSpec;
    fence: 'wood' | 'block' | 'hedge' | 'none';
    trees: 'natural' | 'japanese' | 'modern';
  };
}

export interface InteriorStyle {
  id: string;
  name: string;
  catch: string;
  description: string;
  swatch: string[];
  floor: MatSpec;
  wetFloor: MatSpec;
  entranceFloor: MatSpec;
  wall: MatSpec;
  accentWall?: MatSpec;
  ceiling: MatSpec;
  door: MatSpec;
  trim: string;
  furniture: {
    wood: MatSpec;
    fabric: MatSpec;
    fabric2: MatSpec;
    metal: string;
    counter: MatSpec;
    cabinet: MatSpec;
    rug: MatSpec;
  };
  /** 照明の色温度 (K) */
  lightKelvin: number;
}

const ext = (s: ExteriorStyle) => s;
const int = (s: InteriorStyle) => s;

export const EXTERIOR_STYLES: ExteriorStyle[] = [
  // ---- ホームランディック標準（塗り壁） ----
  ext({
    id: 'hl-white-plaster',
    name: '塗り壁ホワイト',
    catch: '白の塗り壁 × 黒サッシ',
    description: 'やわらかなコテむらの白い塗り壁に、細い黒のサッシ。軒を抑えた片流れのシャープなシルエットと、玄関まわりの木の温もりが上質な佇まいをつくります。',
    swatch: ['#f1efea', '#1f1f1f', '#8b6a4c', '#2b2b2b'],
    roof: {
      type: 'shed',
      pitch: 1.5,
      eaves: 120,
      verge: 80,
      material: { pattern: 'standingSeam', color: '#2b2c2e', roughness: 0.5, metalness: 0.45 },
      fascia: '#f1efea',
      soffit: { pattern: 'paint', color: '#f1efea' },
      gutter: false,
    },
    wall: { pattern: 'stucco', color: '#efece6', roughness: 0.95 },
    accent: { pattern: 'woodSiding', color: '#8e6a49', color2: '#7a5a3d', roughness: 0.7 },
    accentRule: 'entrance',
    foundation: { pattern: 'concrete', color: '#a7a49f', roughness: 0.9 },
    frame: { color: '#1f1f1f', metalness: 0.35 },
    entranceDoor: { pattern: 'wood', color: '#7d5b3e', color2: '#664a31', roughness: 0.55 },
    landscape: {
      ground: { pattern: 'gravel', color: '#c9c4ba', color2: '#a9a397' },
      approach: { pattern: 'tileFloor', color: '#9b968f', roughness: 0.7, size: 0.6, size2: 0.6 },
      driveway: { pattern: 'concrete', color: '#bdbab4', roughness: 0.9 },
      fence: 'none',
      trees: 'modern',
    },
  }),
  ext({
    id: 'hl-greige-cube',
    name: '塗り壁グレージュ',
    catch: 'グレージュのキューブ',
    description: 'あたたかみのあるグレージュの塗り壁で包んだ、陸屋根の水平ラインが美しいキューブ型。余計な線を出さない、静かで洗練された外観です。',
    swatch: ['#d8d1c6', '#2a2a2a', '#b7ad9f', '#1f1f1f'],
    roof: {
      type: 'flat',
      pitch: 0,
      eaves: 0,
      verge: 0,
      material: { pattern: 'concrete', color: '#9f9b95', roughness: 0.9 },
      fascia: '#cfc8bc',
      soffit: { pattern: 'paint', color: '#e9e5de' },
      gutter: false,
    },
    wall: { pattern: 'stucco', color: '#d6cfc3', roughness: 0.95 },
    accent: { pattern: 'stucco', color: '#b6ad9f', roughness: 0.95 },
    accentRule: 'entrance',
    foundation: { pattern: 'concrete', color: '#a19e99', roughness: 0.9 },
    frame: { color: '#1f1f1f', metalness: 0.35 },
    entranceDoor: { pattern: 'woodSiding', color: '#6f5440', color2: '#5e4735', roughness: 0.5 },
    landscape: {
      ground: { pattern: 'gravel', color: '#bfb9ae', color2: '#9d978b' },
      approach: { pattern: 'tileFloor', color: '#8d8983', roughness: 0.7, size: 0.6, size2: 0.6 },
      driveway: { pattern: 'concrete', color: '#b8b5ae', roughness: 0.9 },
      fence: 'none',
      trees: 'modern',
    },
  }),
  ext({
    id: 'hl-gray-plaster',
    name: '塗り壁ライトグレー',
    catch: 'ライトグレー × 木目の軒天',
    description: '明るいグレーの塗り壁に、木目の軒天と玄関まわりの木をあわせた都会的なデザイン。控えめな軒の片流れで、陰影と奥行きを演出します。',
    swatch: ['#cfcfcc', '#8e6a49', '#2c2d2f', '#1f1f1f'],
    roof: {
      type: 'shed',
      pitch: 2,
      eaves: 350,
      verge: 200,
      material: { pattern: 'standingSeam', color: '#2c2d2f', roughness: 0.5, metalness: 0.45 },
      fascia: '#2c2d2f',
      soffit: { pattern: 'woodSiding', color: '#a07b56', color2: '#8c6947', roughness: 0.7 },
      gutter: false,
    },
    wall: { pattern: 'stucco', color: '#cdcdca', roughness: 0.95 },
    accent: { pattern: 'woodSiding', color: '#94704f', color2: '#7f5e41', roughness: 0.7 },
    accentRule: 'entrance',
    foundation: { pattern: 'concrete', color: '#a19e99', roughness: 0.9 },
    frame: { color: '#1f1f1f', metalness: 0.35 },
    entranceDoor: { pattern: 'wood', color: '#7a5a3e', color2: '#65492f', roughness: 0.55 },
    landscape: {
      ground: { pattern: 'grass', color: '#617f43', color2: '#7f9c56' },
      approach: { pattern: 'tileFloor', color: '#8f8b85', roughness: 0.7, size: 0.6, size2: 0.6 },
      driveway: { pattern: 'concrete', color: '#bab7b1', roughness: 0.9 },
      fence: 'none',
      trees: 'modern',
    },
  }),
  ext({
    id: 'hl-charcoal-plaster',
    name: '塗り壁チャコール',
    catch: '深みのあるチャコール × 木',
    description: 'チャコールグレーの塗り壁に木の温もりを添えた、重厚でシックな外観。夜景では木部と窓の灯りが美しく浮かび上がります。',
    swatch: ['#4a4845', '#9a7654', '#2a2a2a', '#1a1a1a'],
    roof: {
      type: 'shed',
      pitch: 1.5,
      eaves: 150,
      verge: 100,
      material: { pattern: 'standingSeam', color: '#2a2a2b', roughness: 0.5, metalness: 0.45 },
      fascia: '#3f3d3b',
      soffit: { pattern: 'woodSiding', color: '#9a7654', color2: '#86633f', roughness: 0.7 },
      gutter: false,
    },
    wall: { pattern: 'stucco', color: '#4b4946', roughness: 0.95 },
    accent: { pattern: 'woodSiding', color: '#9a7654', color2: '#86633f', roughness: 0.7 },
    accentRule: 'entrance',
    foundation: { pattern: 'concrete', color: '#96938e', roughness: 0.9 },
    frame: { color: '#1a1a1a', metalness: 0.35 },
    entranceDoor: { pattern: 'wood', color: '#8a6644', color2: '#735333', roughness: 0.55 },
    landscape: {
      ground: { pattern: 'gravel', color: '#aaa59b', color2: '#8a847a' },
      approach: { pattern: 'tileFloor', color: '#6f6b66', roughness: 0.7, size: 0.6, size2: 0.6 },
      driveway: { pattern: 'concrete', color: '#b2afa9', roughness: 0.9 },
      fence: 'none',
      trees: 'modern',
    },
  }),
  // ---- その他のテイスト ----
  ext({
    id: 'simple-modern',
    name: 'シンプルモダン',
    catch: '白×黒のキューブ',
    description: '白い塗り壁にブラックのガルバリウムを効かせた、軒ゼロのシャープな箱型デザイン。',
    swatch: ['#f2f1ee', '#2b2c2e', '#2b2c2e', '#1d1d1f'],
    roof: {
      type: 'shed',
      pitch: 1.0,
      eaves: 150,
      verge: 100,
      material: { pattern: 'standingSeam', color: '#2f3033', roughness: 0.45, metalness: 0.5 },
      fascia: '#2b2c2e',
      soffit: { pattern: 'paint', color: '#2b2c2e', roughness: 0.8 },
      gutter: false,
    },
    wall: { pattern: 'plaster', color: '#f1f0ec', roughness: 0.9 },
    accent: { pattern: 'galvalume', color: '#2e2f32', roughness: 0.4, metalness: 0.55 },
    accentRule: 'entrance',
    foundation: { pattern: 'concrete', color: '#9c9a96', roughness: 0.9 },
    frame: { color: '#1c1c1e', metalness: 0.4 },
    entranceDoor: { pattern: 'wood', color: '#6e4b31', color2: '#4d3220', roughness: 0.55 },
    landscape: {
      ground: { pattern: 'grass', color: '#5d7e3a', color2: '#7c9a4b' },
      approach: { pattern: 'tileFloor', color: '#8d8a85', roughness: 0.7, tile: 2.4 },
      driveway: { pattern: 'concrete', color: '#b3b0aa', roughness: 0.9 },
      fence: 'block',
      trees: 'modern',
    },
  }),
  ext({
    id: 'natural',
    name: 'ナチュラル',
    catch: '木のぬくもりと切妻屋根',
    description: 'やさしいベージュの外壁に天然木調のアクセント。深めの軒が表情をつくる、飽きのこない定番スタイル。',
    swatch: ['#e9e1d3', '#a8764a', '#4a4d52', '#f3f1ec'],
    roof: {
      type: 'gable',
      pitch: 4,
      eaves: 600,
      verge: 450,
      material: { pattern: 'slate', color: '#4a4d52', color2: '#3b3e42', roughness: 0.75 },
      fascia: '#f3f1ec',
      soffit: { pattern: 'woodSiding', color: '#c89a6c', color2: '#b5855a', roughness: 0.7, tile: 1.26 },
      gutter: true,
    },
    wall: { pattern: 'siding', color: '#e8dfd0', color2: '#ddd2c0', roughness: 0.85 },
    accent: { pattern: 'woodSiding', color: '#b07c4f', color2: '#8f6039', roughness: 0.7 },
    accentRule: 'entrance',
    foundation: { pattern: 'concrete', color: '#a19e98', roughness: 0.9 },
    frame: { color: '#efeeea', metalness: 0.2 },
    entranceDoor: { pattern: 'wood', color: '#9b6b43', color2: '#7a5132', roughness: 0.6 },
    landscape: {
      ground: { pattern: 'grass', color: '#628538', color2: '#83a452' },
      approach: { pattern: 'paving', color: '#b9a88f', color2: '#a39278', roughness: 0.8 },
      driveway: { pattern: 'concrete', color: '#b8b5ae', roughness: 0.9 },
      fence: 'wood',
      trees: 'natural',
    },
  }),
  ext({
    id: 'wa-modern',
    name: '和モダン',
    catch: '深い軒と格子の陰影',
    description: '墨色の外壁に木格子、いぶし瓦の寄棟屋根。深い軒が落とす陰影で、凛とした佇まいに。',
    swatch: ['#3a3836', '#9c7652', '#55585c', '#3d3a36'],
    roof: {
      type: 'hip',
      pitch: 4.5,
      eaves: 900,
      verge: 900,
      material: { pattern: 'roofTile', color: '#5d6166', color2: '#4d5156', roughness: 0.55, metalness: 0.15 },
      fascia: '#2d2b29',
      soffit: { pattern: 'woodSiding', color: '#a77c52', color2: '#94693f', roughness: 0.7 },
      gutter: true,
    },
    wall: { pattern: 'plaster', color: '#3b3937', roughness: 0.92 },
    accent: { pattern: 'woodSiding', color: '#9a7249', color2: '#7d5835', roughness: 0.75 },
    accentRule: 'lower',
    foundation: { pattern: 'concrete', color: '#8f8c87', roughness: 0.9 },
    frame: { color: '#3a352f', metalness: 0.3 },
    entranceDoor: { pattern: 'woodSiding', color: '#6b4c30', color2: '#5a3e25', roughness: 0.6 },
    landscape: {
      ground: { pattern: 'gravel', color: '#b8b3a8', color2: '#8f8a80' },
      approach: { pattern: 'stone', color: '#8e8a82', color2: '#77736c', roughness: 0.8 },
      driveway: { pattern: 'concrete', color: '#aeaba5', roughness: 0.9 },
      fence: 'hedge',
      trees: 'japanese',
    },
  }),
  ext({
    id: 'nordic',
    name: '北欧',
    catch: '白い板張りと急勾配の屋根',
    description: '白い横張りの板壁に、黒い急勾配の切妻屋根。北欧の街並みのような可愛らしさとぬくもり。',
    swatch: ['#f4f2ed', '#2f3134', '#2f3134', '#f4f2ed'],
    roof: {
      type: 'gable',
      pitch: 7,
      eaves: 350,
      verge: 300,
      material: { pattern: 'standingSeam', color: '#2e3033', roughness: 0.5, metalness: 0.45 },
      fascia: '#f4f2ed',
      soffit: { pattern: 'paint', color: '#f4f2ed' },
      gutter: true,
    },
    wall: { pattern: 'lapSiding', color: '#f3f1ec', roughness: 0.8 },
    accent: undefined,
    accentRule: 'none',
    foundation: { pattern: 'concrete', color: '#a3a09a', roughness: 0.9 },
    frame: { color: '#1f2023', metalness: 0.3 },
    entranceDoor: { pattern: 'paint', color: '#35506b', roughness: 0.5 },
    landscape: {
      ground: { pattern: 'grass', color: '#5f8a3d', color2: '#86ab57' },
      approach: { pattern: 'paving', color: '#a09c95', color2: '#8c8881' },
      driveway: { pattern: 'gravel', color: '#c5c0b6', color2: '#a8a298' },
      fence: 'wood',
      trees: 'natural',
    },
  }),
  ext({
    id: 'south-euro',
    name: '南欧',
    catch: '陽だまりの塗り壁とオレンジ瓦',
    description: 'アイボリーの塗り壁とテラコッタの瓦。明るく開放的な、リゾートのような外観。',
    swatch: ['#efe4cf', '#c46b3e', '#c46b3e', '#f2eee6'],
    roof: {
      type: 'hip',
      pitch: 4,
      eaves: 450,
      verge: 450,
      material: { pattern: 'roofTile', color: '#c56a3d', color2: '#a9542d', roughness: 0.7 },
      fascia: '#efe4cf',
      soffit: { pattern: 'paint', color: '#f2ebdd' },
      gutter: true,
    },
    wall: { pattern: 'plaster', color: '#eee2cb', roughness: 0.95 },
    accent: { pattern: 'stone', color: '#c8b797', color2: '#b09f80', roughness: 0.85 },
    accentRule: 'entrance',
    foundation: { pattern: 'concrete', color: '#a8a39a', roughness: 0.9 },
    frame: { color: '#f2eee6', metalness: 0.2 },
    entranceDoor: { pattern: 'wood', color: '#7d4d2c', color2: '#653c20', roughness: 0.6 },
    landscape: {
      ground: { pattern: 'grass', color: '#6a8c3c', color2: '#8fae55' },
      approach: { pattern: 'brick', color: '#b86b45', color2: '#9c5634', roughness: 0.85 },
      driveway: { pattern: 'concrete', color: '#bdb8ae', roughness: 0.9 },
      fence: 'block',
      trees: 'natural',
    },
  }),
  ext({
    id: 'industrial',
    name: 'ガルバ×ウッド',
    catch: '無骨でクールな片流れ',
    description: 'ブラックのガルバリウム角波に杉板のアクセント。片流れ屋根で、太陽光パネルとも好相性。',
    swatch: ['#2d2f31', '#b98a5a', '#2d2f31', '#1f2022'],
    roof: {
      type: 'shed',
      pitch: 2.5,
      eaves: 300,
      verge: 200,
      material: { pattern: 'standingSeam', color: '#2c2e30', roughness: 0.45, metalness: 0.55 },
      fascia: '#2c2e30',
      soffit: { pattern: 'woodSiding', color: '#b98a5a', color2: '#a0744a', roughness: 0.7 },
      gutter: false,
    },
    wall: { pattern: 'galvalume', color: '#2e3032', roughness: 0.4, metalness: 0.55 },
    accent: { pattern: 'woodSiding', color: '#b98a5a', color2: '#9b6e43', roughness: 0.75 },
    accentRule: 'entrance',
    foundation: { pattern: 'concrete', color: '#96938e', roughness: 0.9 },
    frame: { color: '#1f2022', metalness: 0.4 },
    entranceDoor: { pattern: 'woodSiding', color: '#b0814f', color2: '#946538', roughness: 0.6 },
    landscape: {
      ground: { pattern: 'gravel', color: '#9e9a93', color2: '#7f7b74' },
      approach: { pattern: 'concrete', color: '#a9a6a0', roughness: 0.85 },
      driveway: { pattern: 'concrete', color: '#b1aea8', roughness: 0.9 },
      fence: 'none',
      trees: 'modern',
    },
  }),
  ext({
    id: 'hotel-like',
    name: 'ラグジュアリー',
    catch: 'タイルと石張りの重厚感',
    description: '白系タイルに石張りのアクセント、陸屋根のフラットな水平ライン。ホテルのような上質感。',
    swatch: ['#ece9e3', '#6f6a63', '#d9d6d0', '#3a3a3c'],
    roof: {
      type: 'flat',
      pitch: 0,
      eaves: 0,
      verge: 0,
      material: { pattern: 'concrete', color: '#9d9a95', roughness: 0.9 },
      fascia: '#e6e3dd',
      soffit: { pattern: 'paint', color: '#f1efeb' },
      gutter: false,
    },
    wall: { pattern: 'brick', color: '#ebe7e0', color2: '#ddd8cf', roughness: 0.6, tile: 1.0 },
    accent: { pattern: 'stone', color: '#77716a', color2: '#5e5953', roughness: 0.7 },
    accentRule: 'entrance',
    foundation: { pattern: 'concrete', color: '#9f9c97', roughness: 0.9 },
    frame: { color: '#3a3a3c', metalness: 0.5 },
    entranceDoor: { pattern: 'woodSiding', color: '#4b3627', color2: '#3b2a1e', roughness: 0.45 },
    landscape: {
      ground: { pattern: 'grass', color: '#557a36', color2: '#779a4a' },
      approach: { pattern: 'tileFloor', color: '#6d6861', roughness: 0.6 },
      driveway: { pattern: 'tileFloor', color: '#a19c94', roughness: 0.7 },
      fence: 'block',
      trees: 'modern',
    },
  }),
];

export const INTERIOR_STYLES: InteriorStyle[] = [
  // ---- ホームランディック標準（淡色・ホテルライク） ----
  int({
    id: 'hl-greige-hotel',
    name: 'ホテルライク・グレージュ',
    catch: '淡いグレージュ × 大判タイル',
    description: '淡いグレージュの壁と大判タイルの床、天井まで届くフルハイトドアで線を減らした、ホテルのように静かで上質な空間。石目のアクセントウォールと間接照明が陰影を添えます。',
    swatch: ['#ece8e2', '#cfc8bd', '#bdb6ab', '#6d5a48'],
    floor: { pattern: 'tileFloor', color: '#d3ccc1', roughness: 0.28, size: 0.6, size2: 1.2, tile: 2.4 },
    wetFloor: { pattern: 'tileFloor', color: '#cfc8bd', roughness: 0.4, size: 0.3, size2: 0.6, tile: 1.2 },
    entranceFloor: { pattern: 'tileFloor', color: '#a39c92', roughness: 0.45, size: 0.6, size2: 1.2, tile: 2.4 },
    wall: { pattern: 'plaster', color: '#ece8e2', roughness: 0.95, normalStrength: 0.08 },
    accentWall: { pattern: 'marble', color: '#c9c2b7', color2: '#b3aa9e', roughness: 0.45, size: 0.6, size2: 1.2 },
    ceiling: { pattern: 'paint', color: '#f6f5f2' },
    door: { pattern: 'paint', color: '#dcd6cc', roughness: 0.55 },
    trim: '#e3ded6',
    furniture: {
      wood: { pattern: 'wood', color: '#6d5a48', color2: '#5b4a3a', roughness: 0.5 },
      fabric: { pattern: 'fabric', color: '#cbc3b6', roughness: 0.95 },
      fabric2: { pattern: 'fabric', color: '#a09688', roughness: 0.95 },
      metal: '#2b2b2b',
      counter: { pattern: 'marble', color: '#efedea', color2: '#d6d1ca', roughness: 0.25 },
      cabinet: { pattern: 'paint', color: '#d2cbc0', roughness: 0.45 },
      rug: { pattern: 'fabric', color: '#dbd3c6', roughness: 1 },
    },
    lightKelvin: 2800,
  }),
  int({
    id: 'hl-pale-beige',
    name: 'ペールベージュ',
    catch: '淡いベージュ × 幅広オーク',
    description: '淡いベージュでまとめた、やわらかく明るい空間。幅広のオーク床と、壁と同化するフルハイトドアで、広がりと統一感を感じられます。',
    swatch: ['#efe9e0', '#d6c2a6', '#e4d9c8', '#a88d6f'],
    floor: { pattern: 'woodFloor', color: '#d4c0a3', color2: '#cbb697', roughness: 0.5, size: 0.19, size2: 1.8 },
    wetFloor: { pattern: 'tileFloor', color: '#ddd5c8', roughness: 0.45, size: 0.3, size2: 0.6, tile: 1.2 },
    entranceFloor: { pattern: 'tileFloor', color: '#b3a998', roughness: 0.5, size: 0.6, size2: 0.6 },
    wall: { pattern: 'plaster', color: '#efe9e0', roughness: 0.95, normalStrength: 0.08 },
    accentWall: { pattern: 'plaster', color: '#e2d6c5', roughness: 0.95, normalStrength: 0.1 },
    ceiling: { pattern: 'paint', color: '#f7f5f1' },
    door: { pattern: 'paint', color: '#e9e2d6', roughness: 0.55 },
    trim: '#ebe4d8',
    furniture: {
      wood: { pattern: 'wood', color: '#b89a78', color2: '#a3855f', roughness: 0.55 },
      fabric: { pattern: 'fabric', color: '#e3d9ca', roughness: 0.95 },
      fabric2: { pattern: 'fabric', color: '#c4b39c', roughness: 0.95 },
      metal: '#3a3530',
      counter: { pattern: 'marble', color: '#f1eee9', color2: '#ddd6cc', roughness: 0.25 },
      cabinet: { pattern: 'wood', color: '#cdb596', color2: '#bfa684', roughness: 0.55 },
      rug: { pattern: 'fabric', color: '#e8dfd1', roughness: 1 },
    },
    lightKelvin: 2800,
  }),
  int({
    id: 'hl-light-gray',
    name: 'ライトグレー',
    catch: 'ライトグレー × ホワイトオーク',
    description: '明るいグレーの壁と床に、ホワイトオークと黒の細いラインを効かせたミニマルな空間。凛とした透明感のある仕上がりです。',
    swatch: ['#e7e7e5', '#c9c9c6', '#dccbb1', '#2b2b2b'],
    floor: { pattern: 'tileFloor', color: '#c9c9c6', roughness: 0.3, size: 0.6, size2: 1.2, tile: 2.4 },
    wetFloor: { pattern: 'tileFloor', color: '#c4c4c1', roughness: 0.45, size: 0.3, size2: 0.6, tile: 1.2 },
    entranceFloor: { pattern: 'tileFloor', color: '#8f8f8c', roughness: 0.5, size: 0.6, size2: 1.2, tile: 2.4 },
    wall: { pattern: 'plaster', color: '#e8e8e6', roughness: 0.95, normalStrength: 0.08 },
    accentWall: { pattern: 'plaster', color: '#bdbdba', roughness: 0.95, normalStrength: 0.1 },
    ceiling: { pattern: 'paint', color: '#f5f5f4' },
    door: { pattern: 'paint', color: '#dededb', roughness: 0.55 },
    trim: '#e2e2df',
    furniture: {
      wood: { pattern: 'wood', color: '#d7c3a4', color2: '#c7b08f', roughness: 0.55 },
      fabric: { pattern: 'fabric', color: '#bfbfbc', roughness: 0.95 },
      fabric2: { pattern: 'fabric', color: '#8f8f8c', roughness: 0.95 },
      metal: '#1f1f1f',
      counter: { pattern: 'marble', color: '#eeeeec', color2: '#cfcfcc', roughness: 0.25 },
      cabinet: { pattern: 'paint', color: '#d9d9d6', roughness: 0.45 },
      rug: { pattern: 'fabric', color: '#d4d4d1', roughness: 1 },
    },
    lightKelvin: 3200,
  }),
  int({
    id: 'hl-greige-walnut',
    name: 'グレージュ×ウォールナット',
    catch: '落ち着いたグレージュ × 深い木目',
    description: 'グレージュの壁にウォールナットの木目を合わせた、落ち着きのある大人の空間。天井際の間接照明が壁をやわらかく照らします。',
    swatch: ['#e6e0d7', '#b6a894', '#5c4636', '#2b2b2b'],
    floor: { pattern: 'woodFloor', color: '#b8a894', color2: '#ad9c86', roughness: 0.45, size: 0.19, size2: 1.8 },
    wetFloor: { pattern: 'tileFloor', color: '#c8c0b4', roughness: 0.45, size: 0.3, size2: 0.6, tile: 1.2 },
    entranceFloor: { pattern: 'tileFloor', color: '#8e877d', roughness: 0.5, size: 0.6, size2: 1.2, tile: 2.4 },
    wall: { pattern: 'plaster', color: '#e6e0d7', roughness: 0.95, normalStrength: 0.08 },
    accentWall: { pattern: 'woodSiding', color: '#5c4636', color2: '#4d3a2d', roughness: 0.55 },
    ceiling: { pattern: 'paint', color: '#f4f2ee' },
    door: { pattern: 'paint', color: '#d6cec2', roughness: 0.55 },
    trim: '#ddd6cb',
    furniture: {
      wood: { pattern: 'wood', color: '#5c4636', color2: '#4a382b', roughness: 0.45 },
      fabric: { pattern: 'fabric', color: '#c7bdaf', roughness: 0.95 },
      fabric2: { pattern: 'fabric', color: '#8c8175', roughness: 0.95 },
      metal: '#2b2b2b',
      counter: { pattern: 'marble', color: '#ebe8e3', color2: '#cfc8be', roughness: 0.25 },
      cabinet: { pattern: 'wood', color: '#5c4636', color2: '#4a382b', roughness: 0.45 },
      rug: { pattern: 'fabric', color: '#cfc5b6', roughness: 1 },
    },
    lightKelvin: 2700,
  }),
  // ---- その他のテイスト ----
  int({
    id: 'natural-oak',
    name: 'ナチュラル',
    catch: 'オーク×白の明るい空間',
    description: '明るいオークの床と白い壁。やわらかな北欧家具で、光があふれる居心地のよい空間。',
    swatch: ['#c9a47a', '#f6f4f0', '#e7ddcc', '#8c9a7a'],
    floor: { pattern: 'woodFloor', color: '#c9a377', color2: '#b8905f', roughness: 0.55 },
    wetFloor: { pattern: 'tileFloor', color: '#d9d5cd', roughness: 0.6, tile: 1.8 },
    entranceFloor: { pattern: 'tileFloor', color: '#8f8a82', roughness: 0.7 },
    wall: { pattern: 'plaster', color: '#f6f4ef', roughness: 0.95, normalStrength: 0.12 },
    ceiling: { pattern: 'paint', color: '#fbfaf7' },
    door: { pattern: 'wood', color: '#caa57c', color2: '#b8905f', roughness: 0.6 },
    trim: '#e9e3d8',
    furniture: {
      wood: { pattern: 'wood', color: '#c29a6c', color2: '#a67c4f', roughness: 0.6 },
      fabric: { pattern: 'fabric', color: '#d9d2c4', roughness: 0.95 },
      fabric2: { pattern: 'fabric', color: '#8f9c80', roughness: 0.95 },
      metal: '#2b2b2b',
      counter: { pattern: 'paint', color: '#f4f3f0', roughness: 0.35 },
      cabinet: { pattern: 'wood', color: '#d4b48e', color2: '#c29f76', roughness: 0.6 },
      rug: { pattern: 'fabric', color: '#e6dfd1', roughness: 1 },
    },
    lightKelvin: 3000,
  }),
  int({
    id: 'modern-gray',
    name: 'モダン',
    catch: 'グレー×ブラックの洗練',
    description: '大判タイル調の床にグレーのアクセントクロス、ブラックのアイアン。都会的で落ち着いた空間。',
    swatch: ['#9a9893', '#ebeae7', '#4a4b4e', '#1f1f21'],
    floor: { pattern: 'tileFloor', color: '#a7a49e', roughness: 0.35, tile: 2.4 },
    wetFloor: { pattern: 'tileFloor', color: '#8d8a85', roughness: 0.5, tile: 1.8 },
    entranceFloor: { pattern: 'tileFloor', color: '#5e5b57', roughness: 0.5 },
    wall: { pattern: 'plaster', color: '#eceae6', roughness: 0.95, normalStrength: 0.12 },
    accentWall: { pattern: 'plaster', color: '#5b5c5f', roughness: 0.95, normalStrength: 0.4 },
    ceiling: { pattern: 'paint', color: '#f6f6f4' },
    door: { pattern: 'paint', color: '#e8e7e3', roughness: 0.5 },
    trim: '#3a3a3c',
    furniture: {
      wood: { pattern: 'wood', color: '#5a4636', color2: '#44352a', roughness: 0.5 },
      fabric: { pattern: 'fabric', color: '#77787a', roughness: 0.95 },
      fabric2: { pattern: 'fabric', color: '#3f4042', roughness: 0.95 },
      metal: '#1d1d1f',
      counter: { pattern: 'marble', color: '#eeede9', color2: '#9a9893', roughness: 0.25 },
      cabinet: { pattern: 'paint', color: '#3b3b3d', roughness: 0.45 },
      rug: { pattern: 'fabric', color: '#8b8a86', roughness: 1 },
    },
    lightKelvin: 3500,
  }),
  int({
    id: 'nordic-white',
    name: '北欧',
    catch: 'ホワイトオーク×くすみカラー',
    description: '白っぽいホワイトオークの床に、くすみブルーのアクセント壁。シンプルで温かみのある北欧インテリア。',
    swatch: ['#dcc7a6', '#f5f3ee', '#8fa3b1', '#e3b7a0'],
    floor: { pattern: 'woodFloor', color: '#dcc4a0', color2: '#cfb48c', roughness: 0.6 },
    wetFloor: { pattern: 'tileFloor', color: '#e2dfd8', roughness: 0.6, tile: 1.8 },
    entranceFloor: { pattern: 'tileFloor', color: '#a7a29a', roughness: 0.7 },
    wall: { pattern: 'plaster', color: '#f5f3ee', roughness: 0.95, normalStrength: 0.12 },
    accentWall: { pattern: 'plaster', color: '#8ea2b0', roughness: 0.95, normalStrength: 0.3 },
    ceiling: { pattern: 'paint', color: '#fbfaf8' },
    door: { pattern: 'paint', color: '#f3f1ec', roughness: 0.5 },
    trim: '#efebe4',
    furniture: {
      wood: { pattern: 'wood', color: '#d2b38a', color2: '#bf9d72', roughness: 0.6 },
      fabric: { pattern: 'fabric', color: '#c9ccc8', roughness: 0.95 },
      fabric2: { pattern: 'fabric', color: '#dcae95', roughness: 0.95 },
      metal: '#2d2d2d',
      counter: { pattern: 'paint', color: '#f6f5f2', roughness: 0.35 },
      cabinet: { pattern: 'paint', color: '#eef0ee', roughness: 0.5 },
      rug: { pattern: 'fabric', color: '#efe9df', roughness: 1 },
    },
    lightKelvin: 2900,
  }),
  int({
    id: 'vintage-cafe',
    name: 'カフェ・ヴィンテージ',
    catch: 'ウォールナット×レンガ',
    description: '深い色の無垢床とレンガのアクセント壁、レザーのソファ。カフェのような味わい深い空間。',
    swatch: ['#6e4b33', '#b56e4b', '#efe8dc', '#3b2d22'],
    floor: { pattern: 'herringbone', color: '#7a5337', color2: '#5f3f28', roughness: 0.55 },
    wetFloor: { pattern: 'tileFloor', color: '#cfc8bb', roughness: 0.6, tile: 1.2 },
    entranceFloor: { pattern: 'brick', color: '#8c5a3e', color2: '#6f432c', roughness: 0.85 },
    wall: { pattern: 'plaster', color: '#efe8dc', roughness: 0.95, normalStrength: 0.5 },
    accentWall: { pattern: 'brick', color: '#b06a48', color2: '#8e4f33', roughness: 0.9 },
    ceiling: { pattern: 'paint', color: '#f4efe6' },
    door: { pattern: 'wood', color: '#6d4a31', color2: '#583b26', roughness: 0.55 },
    trim: '#4a3526',
    furniture: {
      wood: { pattern: 'wood', color: '#5e3f29', color2: '#4a311f', roughness: 0.5 },
      fabric: { pattern: 'leather', color: '#7a4a2c', roughness: 0.55 },
      fabric2: { pattern: 'fabric', color: '#5d6b58', roughness: 0.95 },
      metal: '#1c1a18',
      counter: { pattern: 'wood', color: '#7b5537', color2: '#5e3f28', roughness: 0.45 },
      cabinet: { pattern: 'paint', color: '#3e4a44', roughness: 0.55 },
      rug: { pattern: 'fabric', color: '#8e5b3f', roughness: 1 },
    },
    lightKelvin: 2700,
  }),
  int({
    id: 'hotel-like',
    name: 'ホテルライク',
    catch: '大理石×間接照明',
    description: '大理石調の床とダークトーンのアクセントに間接照明。ホテルのスイートのような上質な空間。',
    swatch: ['#e9e6e1', '#4a3f38', '#c7b299', '#1f1d1c'],
    floor: { pattern: 'marble', color: '#ebe8e3', color2: '#a8a198', roughness: 0.2 },
    wetFloor: { pattern: 'marble', color: '#e3dfd9', color2: '#9e978e', roughness: 0.3, tile: 1.8 },
    entranceFloor: { pattern: 'marble', color: '#4a4744', color2: '#8a8580', roughness: 0.3 },
    wall: { pattern: 'plaster', color: '#eeebe6', roughness: 0.95, normalStrength: 0.12 },
    accentWall: { pattern: 'woodSiding', color: '#4a3a2e', color2: '#3d2f25', roughness: 0.6 },
    ceiling: { pattern: 'paint', color: '#f5f3f0' },
    door: { pattern: 'wood', color: '#4c3a2d', color2: '#3b2c22', roughness: 0.45 },
    trim: '#2b2826',
    furniture: {
      wood: { pattern: 'wood', color: '#4a3a2e', color2: '#3a2c22', roughness: 0.4 },
      fabric: { pattern: 'fabric', color: '#c9bcab', roughness: 0.95 },
      fabric2: { pattern: 'fabric', color: '#403b38', roughness: 0.95 },
      metal: '#b39062',
      counter: { pattern: 'marble', color: '#2f2d2c', color2: '#8a8580', roughness: 0.2 },
      cabinet: { pattern: 'wood', color: '#4a3a2e', color2: '#3a2c22', roughness: 0.45 },
      rug: { pattern: 'fabric', color: '#b9ad9c', roughness: 1 },
    },
    lightKelvin: 2800,
  }),
  int({
    id: 'wa-modern',
    name: '和モダン',
    catch: '畳と木と障子の光',
    description: 'ナラの床と和紙のような塗り壁、落ち着いた木の家具。和のしつらえを現代的に。',
    swatch: ['#b58f63', '#ece5d6', '#c7c19a', '#3d3226'],
    floor: { pattern: 'woodFloor', color: '#b58d62', color2: '#9f774d', roughness: 0.6 },
    wetFloor: { pattern: 'tileFloor', color: '#a9a49a', roughness: 0.6, tile: 1.2 },
    entranceFloor: { pattern: 'stone', color: '#6d6a64', color2: '#5a5752', roughness: 0.8 },
    wall: { pattern: 'plaster', color: '#ece4d4', roughness: 0.95, normalStrength: 0.6 },
    accentWall: { pattern: 'plaster', color: '#9b8a6e', roughness: 0.95, normalStrength: 0.6 },
    ceiling: { pattern: 'woodSiding', color: '#caa77c', color2: '#b8946a', roughness: 0.7 },
    door: { pattern: 'wood', color: '#b08a60', color2: '#98734b', roughness: 0.6 },
    trim: '#8a6a47',
    furniture: {
      wood: { pattern: 'wood', color: '#8a6440', color2: '#6f4f31', roughness: 0.55 },
      fabric: { pattern: 'fabric', color: '#b9ae93', roughness: 0.95 },
      fabric2: { pattern: 'fabric', color: '#6f7358', roughness: 0.95 },
      metal: '#2a2724',
      counter: { pattern: 'wood', color: '#9c7650', color2: '#83603d', roughness: 0.5 },
      cabinet: { pattern: 'wood', color: '#a58158', color2: '#8c6a44', roughness: 0.55 },
      rug: { pattern: 'fabric', color: '#cfc4a8', roughness: 1 },
    },
    lightKelvin: 2800,
  }),
];

export const TATAMI: MatSpec = { pattern: 'tatami', color: '#b9b77e', color2: '#3b3a33', roughness: 0.85 };

export type TimeOfDay = 'day' | 'evening' | 'night';

export interface DesignOptions {
  /** 標準仕様（建具・窓・照明の納まり） */
  specId: string;
  exteriorId: string;
  interiorId: string;
  roofOverride?: RoofType;
  wallColorOverride?: string;
  timeOfDay: TimeOfDay;
  furniture: boolean;
}

export const DEFAULT_DESIGN: DesignOptions = {
  specId: 'homelandick',
  exteriorId: 'hl-white-plaster',
  interiorId: 'hl-greige-hotel',
  timeOfDay: 'day',
  furniture: true,
};

export function exteriorById(id: string) {
  return EXTERIOR_STYLES.find((s) => s.id === id) ?? EXTERIOR_STYLES[0];
}
export function interiorById(id: string) {
  return INTERIOR_STYLES.find((s) => s.id === id) ?? INTERIOR_STYLES[0];
}
