/**
 * 太陽の通り道の図（冬至・春分／秋分・夏至の弧、毎正時の点、方位の輪、いまの太陽）。
 *
 * 見る人: 設計士・コーディネーター（日当たりの検討）と、お客様（日照の説明を受けるとき）。
 * 建物・周辺環境の上に重なる「図」なので、主役の建物を隠さないように細く・小さく・静かに描く:
 *  - 弧と輪は、画面上で一定の太さの線（Line2。遠くでも近くでも同じ太さ。THREE.Line は 1px で遠くから見えず、管は近くで太くなる）
 *  - 時刻・方位の文字は地（丸い札）を敷かず、濃い字に白いふちを付ける（地図の注記と同じ。淡い舗装・航空写真・空のどの上でも読める）。大きさは画面上で一定
 *  - 季節の札には、その日の南中高度を入れる（設計の検討でいちばん使う数字）
 *  - 重なった札は、大事なもの（方位 → 季節 → 時刻）を残して間引く（見る向きで重なり方が変わるので、描くたびに決め直す）
 *
 * ここで作るものは影を落とさない・受けない。クリックの当たり判定にも入らない（周辺建物のクリックを邪魔しない）。
 */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { keyDates, localDate, sunDirectionWorld, sunPosition, sunriseSunset } from './solar';

/** 季節の色（線・点・札）。冬 = 青、春秋 = 緑、夏 = 橙（日影図でよく使う並び）。写真の上でも沈まない中間の明るさ */
export const SEASON_COLORS: Record<'winter' | 'spring' | 'summer', string> = { winter: '#3f8ae0', spring: '#3fa568', summer: '#ee8727' };
const SEASON_LABEL: Record<'winter' | 'spring' | 'summer', string> = { winter: '冬至', spring: '春分・秋分', summer: '夏至' };
const NORTH_RED = '#d2493f';
const INK = '#1e252c';
const HALO = 'rgba(255, 255, 255, 0.94)';
const FONT = "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif";

export interface SunDiagramOpts {
  lat: number;
  lon: number;
  year: number;
  /** 建物の中心（ワールド。y は地面） */
  center: THREE.Vector3;
  /** 弧・輪の半径 (m) */
  radius: number;
  northAngleDeg: number;
}

/** 弧の時刻ラベルを出す時刻: 冬至は 8・10・14・16 時、春秋分・夏至は 6・9・15・18 時（12 時は季節の札がある） */
export function labelHours(id: 'winter' | 'spring' | 'summer', from: number, to: number): number[] {
  const out: number[] = [];
  for (let h = Math.ceil(from); h <= Math.floor(to); h++) {
    if (h === 12) continue;
    if (id === 'winter' ? h % 2 === 0 : h % 3 === 0) out.push(h);
  }
  return out;
}

/** 画面上の長方形（px。y は下向き） */
export interface LabelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  priority: number;
  /** カメラからの距離（同じ大事さなら近い方を残す） */
  depth: number;
}

/**
 * 重なった札の間引き: 大事なもの（priority の大きいもの）、同じなら手前のものから置いていき、置いた札と重なるものは隠す。
 * 返り値は boxes と同じ並びで、出す = true。
 */
export function declutter(boxes: (LabelBox | null)[], gap = 3): boolean[] {
  const order = boxes.map((b, i) => ({ b, i })).filter((e): e is { b: LabelBox; i: number } => !!e.b);
  order.sort((p, q) => q.b.priority - p.b.priority || p.b.depth - q.b.depth || p.i - q.i);
  const kept: LabelBox[] = [];
  const show = boxes.map(() => false);
  for (const { b, i } of order) {
    const hit = kept.some((k) => b.x0 < k.x1 + gap && b.x1 > k.x0 - gap && b.y0 < k.y1 + gap && b.y1 > k.y0 - gap);
    if (hit) continue;
    kept.push(b);
    show[i] = true;
  }
  return show;
}

interface Label {
  sprite: THREE.Sprite;
  /** 画面上の大きさ（CSS px。画面の高さ 900 px のとき） */
  w: number;
  h: number;
  priority: number;
}

interface TextRun {
  text: string;
  weight?: number;
  /** 文字の大きさの倍率（既定 1） */
  k?: number;
  color?: string;
}

/** 文字の札を作る。px = 画面上の文字の大きさ。bg を付けると丸い地に白い字の札、付けなければ濃い字に白いふち */
function makeLabel(runs: TextRun[], o: { px: number; priority: number; bg?: string; color?: string; round?: boolean; centerY?: number }): Label {
  const dpr = typeof window !== 'undefined' ? Math.min(3, Math.max(1, Math.ceil(window.devicePixelRatio || 1))) : 1;
  const K = dpr * 2; // 画面の画素の 2 倍で描いて縮める（斜めの位置でも字がにじまない）
  const size = o.px * K;
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const fontOf = (r: TextRun) => `${r.weight ?? 600} ${Math.round(size * (r.k ?? 1))}px ${FONT}`;
  let tw = 0;
  for (const r of runs) {
    g.font = fontOf(r);
    tw += g.measureText(r.text).width;
  }
  const padX = o.bg ? size * (o.round ? 0.42 : 0.72) : size * 0.32;
  const hgt = Math.ceil(size * (o.bg ? 1.78 : 1.5));
  const wid = o.round ? hgt : Math.ceil(tw + padX * 2);
  c.width = wid;
  c.height = hgt;
  if (o.bg) {
    g.fillStyle = o.bg;
    g.beginPath();
    g.roundRect(0, 0, wid, hgt, hgt / 2);
    g.fill();
  }
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.lineJoin = 'round';
  let x = (wid - tw) / 2;
  const y = hgt / 2 + size * 0.04;
  // ふち（地の無い札）: 先に全部のふちを描いてから字を載せる（隣の字のふちが字に掛からない）。
  // 地図の注記と同じ「濃い字に白いふち」: 淡い舗装・白い建物・空の上でも、濃い屋根・航空写真の上でも読める
  // （白い字に暗いふちは、周辺建物を取ったあとの淡い画面で沈んでいた）
  if (!o.bg) {
    let xs = x;
    g.save();
    g.shadowColor = 'rgba(255, 255, 255, 0.85)';
    g.shadowBlur = size * 0.16;
    for (const r of runs) {
      g.font = fontOf(r);
      g.strokeStyle = HALO;
      g.lineWidth = size * 0.24;
      g.strokeText(r.text, xs, y);
      xs += g.measureText(r.text).width;
    }
    g.restore();
  }
  for (const r of runs) {
    g.font = fontOf(r);
    g.fillStyle = r.color ?? o.color ?? (o.bg ? '#fff' : INK);
    g.fillText(r.text, x, y);
    x += g.measureText(r.text).width;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, toneMapped: false, sizeAttenuation: false, fog: false });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 10;
  if (o.centerY != null) sprite.center.set(0.5, o.centerY);
  quiet(sprite);
  return { sprite, w: wid / K, h: hgt / K, priority: o.priority };
}

/** 影・クリック・環境遮蔽（GTAO）に入れない */
function quiet<T extends THREE.Object3D>(o: T): T {
  o.castShadow = false;
  o.receiveShadow = false;
  o.userData.noShadow = true;
  o.userData.noAO = true;
  o.raycast = () => {};
  return o;
}

function lineMat(color: string, px: number, opacity: number, dashed?: { dash: number; gap: number }): LineMaterial {
  const m = new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: px, transparent: true, opacity, depthWrite: false, toneMapped: false, dashed: !!dashed, dashSize: dashed?.dash ?? 1, gapSize: dashed?.gap ?? 1 });
  m.userData.px = px;
  return m;
}

/** 毎正時の点の絵（色の丸に白いふち） */
function dotTexture(color: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.arc(32, 32, 27, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.96)';
  g.fill();
  g.beginPath();
  g.arc(32, 32, 19, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** いまの太陽の絵（芯は白く、まわりへ淡くにじむ） */
function sunTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(80, 80, 0, 80, 80, 80);
  gr.addColorStop(0, 'rgba(255, 252, 232, 1)');
  gr.addColorStop(0.2, 'rgba(255, 238, 170, 1)');
  gr.addColorStop(0.3, 'rgba(255, 214, 96, 0.92)');
  gr.addColorStop(0.36, 'rgba(255, 196, 64, 0.42)');
  gr.addColorStop(0.62, 'rgba(255, 190, 60, 0.14)');
  gr.addColorStop(1, 'rgba(255, 186, 56, 0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 160, 160);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const _v = new THREE.Vector3();
const _vp = new THREE.Vector4();

export class SunDiagram {
  private labels: Label[] = [];
  private lines: LineMaterial[] = [];
  private points: THREE.PointsMaterial[] = [];
  private own: { dispose(): void }[] = [];
  private marker: { glow: THREE.Sprite; ray: Line2; radius: number } | null = null;
  private markerOwn: { dispose(): void }[] = [];

  constructor(
    /** 弧・点・輪・札 */
    readonly pathG: THREE.Group,
    /** いまの太陽 */
    readonly markerG: THREE.Group,
  ) {
    pathG.name = 'sun-diagram';
    markerG.name = 'sun-marker';
  }

  private clearPath() {
    for (const c of [...this.pathG.children]) this.pathG.remove(c);
    for (const d of this.own) d.dispose();
    this.own = [];
    this.labels = [];
    this.lines = [];
    this.points = [];
  }

  private line(pts: THREE.Vector3[], color: string, px: number, opacity: number, order: number): Line2 {
    const geo = new LineGeometry();
    geo.setPositions(pts.flatMap((p) => [p.x, p.y, p.z]));
    const mat = lineMat(color, px, opacity);
    const l = quiet(new Line2(geo, mat));
    l.renderOrder = order;
    this.own.push(geo, mat);
    this.lines.push(mat);
    this.pathG.add(l);
    return l;
  }

  private addLabel(l: Label, at: THREE.Vector3) {
    l.sprite.position.copy(at);
    this.labels.push(l);
    const m = l.sprite.material as THREE.SpriteMaterial;
    this.own.push(m, m.map!);
    this.pathG.add(l.sprite);
  }

  /** 弧・点・輪・札を作り直す */
  build(o: SunDiagramOpts): void {
    this.clearPath();
    const R = Math.max(1, o.radius);
    const c = o.center.clone();
    const dirOf = (az: number, el: number) => sunDirectionWorld(az, el, o.northAngleDeg);

    for (const d of keyDates(o.year)) {
      if (d.id === 'autumn') continue;
      const id = d.id as 'winter' | 'spring' | 'summer';
      const color = SEASON_COLORS[id];
      const rs = sunriseSunset(d.year, d.month, d.day, o.lat, o.lon);
      // 弧（5 分刻み）。下に暗い線を敷く（空・白い壁・写真のどの上でも輪郭が出る）
      const pts: THREE.Vector3[] = [];
      for (let h = rs.sunrise; h <= rs.sunset + 1e-9; h += 1 / 12) {
        const sp = sunPosition(localDate(d.year, d.month, d.day, h), o.lat, o.lon);
        if (sp.elevation < -0.5) continue;
        pts.push(c.clone().addScaledVector(dirOf(sp.azimuth, Math.max(0, sp.elevation)), R));
      }
      if (pts.length >= 2) {
        this.line(pts, '#141a20', 4.2, 0.2, 2);
        this.line(pts, color, 2.3, 0.98, 3);
      }
      // 毎正時の点（画面上で一定の大きさ）
      const dots: number[] = [];
      for (let h = Math.ceil(rs.sunrise); h <= Math.floor(rs.sunset); h++) {
        const sp = sunPosition(localDate(d.year, d.month, d.day, h), o.lat, o.lon);
        if (sp.elevation < 0) continue;
        const p = c.clone().addScaledVector(dirOf(sp.azimuth, sp.elevation), R);
        dots.push(p.x, p.y, p.z);
      }
      if (dots.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(dots, 3));
        const tex = dotTexture(color);
        // 透過として描く（弧の線より後に描いて、点が線の上に載る）
        const mat = new THREE.PointsMaterial({ map: tex, size: 10, sizeAttenuation: false, alphaTest: 0.5, transparent: true, depthWrite: false, toneMapped: false, fog: false });
        mat.userData.px = 10;
        const pt = quiet(new THREE.Points(geo, mat));
        pt.renderOrder = 4;
        this.own.push(geo, mat, tex);
        this.points.push(mat);
        this.pathG.add(pt);
      }
      // 時刻（点の少し上）
      for (const h of labelHours(id, rs.sunrise, rs.sunset)) {
        const sp = sunPosition(localDate(d.year, d.month, d.day, h), o.lat, o.lon);
        if (sp.elevation < 0) continue;
        this.addLabel(makeLabel([{ text: String(h), weight: 700 }, { text: '時', k: 0.86, weight: 600 }], { px: 12.5, priority: id === 'spring' ? 40 : 50, centerY: -0.42 }), c.clone().addScaledVector(dirOf(sp.azimuth, sp.elevation), R));
      }
      // 季節の札（南中の点の上）: 季節と、その日の南中高度
      const noon = sunPosition(localDate(d.year, d.month, d.day, rs.noon), o.lat, o.lon);
      this.addLabel(
        makeLabel([{ text: SEASON_LABEL[id], weight: 700 }, { text: `　南中 ${Math.round(noon.elevation)}°`, weight: 500, k: 0.94, color: 'rgba(255,255,255,0.94)' }], { px: 12, priority: id === 'spring' ? 84 : 86, bg: color, centerY: -0.5 }),
        c.clone().addScaledVector(dirOf(noon.azimuth, noon.elevation), R),
      );
    }

    // 方位の輪（地面の少し上）と目盛り: 10° ごとに短く、30° ごとに中くらい、東西南北は長く
    const y = c.y + 0.06;
    const ringPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 180; i++) {
      const a = (i / 180) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(c.x + Math.cos(a) * R, y, c.z + Math.sin(a) * R));
    }
    this.line(ringPts, '#141a20', 3.6, 0.16, 1);
    const ring = this.line(ringPts, '#ffffff', 1.7, 0.92, 2);
    const seg: number[] = [];
    const s = R / 22;
    for (let az = 0; az < 360; az += 10) {
      const d = dirOf(az, 0);
      const len = (az % 90 === 0 ? 1.5 : az % 30 === 0 ? 0.8 : 0.36) * s;
      const a = _v.set(c.x, y, c.z).addScaledVector(d, R - len);
      seg.push(a.x, a.y, a.z);
      const b = _v.set(c.x, y, c.z).addScaledVector(d, R);
      seg.push(b.x, b.y, b.z);
    }
    const segGeo = new LineSegmentsGeometry();
    segGeo.setPositions(seg);
    const segMat = lineMat('#ffffff', 1.4, 0.9);
    const ticks = quiet(new LineSegments2(segGeo, segMat));
    ticks.renderOrder = 2;
    this.own.push(segGeo, segMat);
    this.lines.push(segMat);
    this.pathG.add(ticks);
    // 東西南北（北だけ赤い丸の札）
    for (const [label, az] of [
      ['北', 0],
      ['東', 90],
      ['南', 180],
      ['西', 270],
    ] as [string, number][]) {
      const at = new THREE.Vector3(c.x, y, c.z).addScaledVector(dirOf(az, 0), R + 1.5 * s);
      if (label === '北') this.addLabel(makeLabel([{ text: label, weight: 700 }], { px: 13, priority: 100, bg: NORTH_RED, round: true, centerY: 0.5 }), at);
      else this.addLabel(makeLabel([{ text: label, weight: 700 }], { px: 14, priority: 92, centerY: 0.5 }), at);
    }

    // 描くたびに、そのカメラ・画面の大きさで札の大きさを決め、重なった札を間引く（輪は札より先に描かれる）
    ring.frustumCulled = false;
    const obj = ring as unknown as THREE.Object3D;
    const base = obj.onBeforeRender;
    obj.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
      base.call(obj, renderer, scene, camera, geometry, material, group);
      (renderer as THREE.WebGLRenderer).getViewport(_vp);
      this.layout(camera, _vp.z, _vp.w);
    };
  }

  /**
   * 札・点・線の大きさを、このカメラと画面の大きさ（CSS px）に合わせ、重なった札を間引く。
   * 札は「隠す」のではなく大きさ 0 にする（描く物の一覧を作ったあとでも、その描画から効く）。
   */
  layout(camera: THREE.Camera, viewW: number, viewH: number): void {
    if (!(viewW > 0 && viewH > 0)) return;
    // 画面が大きいときは札も少し大きく（高さ 900 px を基準に 0.85〜1.6 倍）
    const ui = Math.min(1.6, Math.max(0.85, viewH / 900));
    for (const m of this.lines) m.linewidth = (m.userData.px as number) * ui;
    for (const m of this.points) m.size = (m.userData.px as number) * ui;
    const p11 = camera.projectionMatrix.elements[5];
    if (!(p11 > 0)) return;
    const k = 2 / (viewH * p11);
    const cam = camera.getWorldPosition(new THREE.Vector3());
    const boxes: (LabelBox | null)[] = this.labels.map((l) => {
      const w = l.w * ui;
      const h = l.h * ui;
      _v.copy(l.sprite.position);
      l.sprite.parent?.localToWorld(_v);
      const depth = _v.distanceTo(cam);
      _v.project(camera);
      if (_v.z < -1 || _v.z > 1) return null;
      const sx = (_v.x * 0.5 + 0.5) * viewW;
      const sy = (0.5 - _v.y * 0.5) * viewH;
      const cx = l.sprite.center.x;
      const cy = l.sprite.center.y;
      return { x0: sx - w * cx, x1: sx + w * (1 - cx), y0: sy - h * (1 - cy), y1: sy + h * cy, priority: l.priority, depth };
    });
    const show = declutter(boxes);
    this.labels.forEach((l, i) => {
      const on = show[i];
      const sx = on ? l.w * ui * k : 0;
      const sy = on ? l.h * ui * k : 0;
      if (Math.abs(l.sprite.scale.x - sx) > 1e-9 || Math.abs(l.sprite.scale.y - sy) > 1e-9) {
        l.sprite.scale.set(sx, sy, 1);
        l.sprite.updateMatrixWorld(true);
      }
    });
    if (this.marker) {
      const g = 58 * ui * k;
      if (Math.abs(this.marker.glow.scale.x - g) > 1e-9) {
        this.marker.glow.scale.set(g, g, 1);
        this.marker.glow.updateMatrixWorld(true);
      }
      (this.marker.ray.material as LineMaterial).linewidth = 1.6 * ui;
    }
  }

  /** いまの太陽（dir = 太陽の向きの単位ベクトル。地平線の下なら null）。部品は作り直さず、位置だけ動かす */
  setSun(dir: THREE.Vector3 | null, center: THREE.Vector3, radius: number): void {
    if (!dir || dir.y <= 0) {
      this.markerG.visible = false;
      return;
    }
    const R = Math.max(1, radius);
    if (!this.marker || Math.abs(this.marker.radius - R) > 1e-6) this.buildMarker(R);
    const m = this.marker!;
    const p = center.clone().addScaledVector(_v.copy(dir).normalize(), R);
    m.glow.position.copy(p);
    // 光の向きの線: 頂点の入れ物を作り直さず、中の数字だけ書き換える（時刻を動かすたびに呼ばれる。作り直すと GPU のバッファが溜まる）
    const geo = m.ray.geometry as LineGeometry;
    const st = geo.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute;
    const arr = st.data.array as Float32Array;
    arr[0] = center.x;
    arr[1] = center.y + 0.1;
    arr[2] = center.z;
    arr[3] = p.x;
    arr[4] = p.y;
    arr[5] = p.z;
    st.data.needsUpdate = true;
    const ds = geo.getAttribute('instanceDistanceStart') as THREE.InterleavedBufferAttribute | undefined;
    if (ds) {
      const d = ds.data.array as Float32Array;
      d[0] = 0;
      d[1] = Math.hypot(p.x - center.x, p.y - center.y - 0.1, p.z - center.z);
      ds.data.needsUpdate = true;
    }
    this.markerG.visible = true;
  }

  private buildMarker(R: number) {
    for (const c of [...this.markerG.children]) this.markerG.remove(c);
    for (const d of this.markerOwn) d.dispose();
    const tex = sunTexture();
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, toneMapped: false, sizeAttenuation: false, fog: false });
    const glow = quiet(new THREE.Sprite(mat));
    glow.renderOrder = 9;
    // 最初の 1 コマ（layout の前）にも、おおよその大きさで出す
    glow.scale.set(0.05, 0.05, 1);
    const geo = new LineGeometry();
    geo.setPositions([0, 0, 0, 0, 1, 0]);
    const s = R / 22;
    const rayMat = lineMat('#ffc94f', 1.6, 0.9, { dash: 0.55 * s, gap: 0.38 * s });
    const ray = quiet(new Line2(geo, rayMat));
    // 破線の刻み（線に沿った距離）の入れ物を先に作っておく（setSun は中の数字だけ書き換える）
    ray.computeLineDistances();
    ray.frustumCulled = false;
    ray.renderOrder = 3;
    this.markerOwn = [tex, mat, geo, rayMat];
    this.markerG.add(ray, glow);
    this.marker = { glow, ray, radius: R };
  }

  dispose(): void {
    this.clearPath();
    for (const c of [...this.markerG.children]) this.markerG.remove(c);
    for (const d of this.markerOwn) d.dispose();
    this.markerOwn = [];
    this.marker = null;
  }
}
