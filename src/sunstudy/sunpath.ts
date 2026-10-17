/**
 * 太陽の通り道（冬至・春秋分・夏至）・方位リング・現在の太陽マーカー
 * 既存 src/sun/context.ts の buildSunPath / updateSunMarker を、建物モデルに依存しない形にしたもの。
 * 太陽方向は sunDirectionWorld(az, elev, 0)（ワールド: -Z が北、+X が東）。時刻は JST（solar.ts の既定 tz=9）。
 *
 * ここで作るものは影を落とさない・受けない（castShadow / receiveShadow = false、toneMapped = false）。
 * 線は細い管（TubeGeometry）で描く（THREE.Line は 1px で遠くから見づらい）。
 */
import * as THREE from 'three';
import { textSprite } from '../sun/context';
import { keyDates, localDate, sunDirectionWorld, sunPosition, sunriseSunset } from '../sun/solar';
import { clearGroup } from './scene';

/** 季節ごとの色 */
export const SUNPATH_COLORS: Record<string, string> = { winter: '#4ea3ff', spring: '#6ccf7a', summer: '#ffa53b' };

/** 太陽の方向（ワールド、単位ベクトル）。northAngleDeg = 0 固定 */
export function sunDirAt(lat: number, lon: number, year: number, month: number, day: number, hours: number): THREE.Vector3 {
  const sp = sunPosition(localDate(year, month, day, hours), lat, lon);
  return sunDirectionWorld(sp.azimuth, sp.elevation, 0);
}

export class SunPath {
  /** 通り道・方位リング */
  readonly pathG = new THREE.Group();
  /** 現在の太陽 */
  readonly markerG = new THREE.Group();

  private visible = true;
  /** 太陽が地平線上にあるか（updateMarker で更新） */
  private markerAbove = false;
  /** 太陽マーカーの部品（毎回作り直さず位置だけ更新する。半径が変わったら作り直す） */
  private marker: { sun: THREE.Mesh; glow: THREE.Sprite; line: THREE.Line; radius: number } | null = null;

  constructor(parent: THREE.Group) {
    this.pathG.name = 'sunpath-path';
    this.markerG.name = 'sunpath-marker';
    parent.add(this.pathG, this.markerG);
  }

  /**
   * 通り道を作り直す。center: 建物中心（ワールド, y は地面）、radius: 軌道の半径 (m)
   * 冬至 (青)・春分 (緑)・夏至 (橙) の 3 本 + 毎正時の点・時刻ラベル + 日付ラベル + 方位リング（北は赤）
   */
  build(lat: number, lon: number, year: number, center: THREE.Vector3, radius: number): void {
    clearGroup(this.pathG);
    const R = Math.max(1, radius);
    // 既存（半径 22m）での見え方を基準に、大きさを半径に比例させる
    const s = R / 22;
    const c = center.clone();

    for (const d of keyDates(year)) {
      if (d.id === 'autumn') continue;
      const color = SUNPATH_COLORS[d.id];
      const rs = sunriseSunset(d.year, d.month, d.day, lat, lon);
      // 軌道（5 分刻み）
      const pts: THREE.Vector3[] = [];
      for (let h = rs.sunrise; h <= rs.sunset + 1e-9; h += 1 / 12) {
        const sp = sunPosition(localDate(d.year, d.month, d.day, h), lat, lon);
        if (sp.elevation < -0.5) continue;
        pts.push(c.clone().addScaledVector(sunDirectionWorld(sp.azimuth, Math.max(0, sp.elevation), 0), R));
      }
      if (pts.length >= 2) {
        const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
        const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(16, pts.length), Math.max(0.05, 0.09 * s), 6, false), flatMat(color));
        this.pathG.add(markNoShadow(tube, 3));
      }
      // 毎正時の点と時刻ラベル
      for (let h = Math.ceil(rs.sunrise); h <= Math.floor(rs.sunset); h++) {
        const sp = sunPosition(localDate(d.year, d.month, d.day, h), lat, lon);
        if (sp.elevation < 0) continue;
        const p = c.clone().addScaledVector(sunDirectionWorld(sp.azimuth, sp.elevation, 0), R);
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.22 * s, 12, 8), flatMat(color));
        dot.position.copy(p);
        this.pathG.add(markNoShadow(dot, 3));
        const label = textSprite(`${h}時`, { size: 40, color: '#fff', bg: 'rgba(0,0,0,0.45)', scale: 0.8 });
        label.position.copy(p).add(new THREE.Vector3(0, 0.7 * s, 0));
        this.pathG.add(markNoShadow(label, 10));
      }
      // 日付ラベル（南中）
      const noon = sunPosition(localDate(d.year, d.month, d.day, rs.noon), lat, lon);
      const lp = c.clone().addScaledVector(sunDirectionWorld(noon.azimuth, noon.elevation, 0), R + 2.5 * s);
      const lab = textSprite(d.label, { size: 44, color: '#fff', bg: color, scale: 1.3 });
      lab.position.copy(lp);
      this.pathG.add(markNoShadow(lab, 10));
    }

    // 方位リング（地面の少し上。平らな地形との z ファイトを避けるため polygonOffset）
    const ringY = center.y + 0.05;
    const ringW = Math.max(0.08, 0.12 * s);
    const ringMat = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      toneMapped: false,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(R - ringW, R + ringW, 128), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(center.x, ringY, center.z);
    this.pathG.add(markNoShadow(ring, 2));
    // 30° ごとの目盛り（90° ごとは長く）。lookAt で +Z（箱の長辺）を中心へ向ける = 放射方向
    for (let az = 0; az < 360; az += 30) {
      const d = sunDirectionWorld(az, 0, 0);
      const major = az % 90 === 0;
      const len = (major ? 1.4 : 0.7) * s;
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.15 * s, 0.02, len), flatMat('#ffffff'));
      tick.position.set(center.x, ringY + 0.01, center.z).addScaledVector(d, R);
      tick.lookAt(center.x, ringY + 0.01, center.z);
      this.pathG.add(markNoShadow(tick, 2));
    }
    const dirs: [string, number][] = [
      ['北', 0],
      ['東', 90],
      ['南', 180],
      ['西', 270],
    ];
    for (const [label, az] of dirs) {
      const d = sunDirectionWorld(az, 0, 0);
      const sp = textSprite(label, { size: 56, color: '#fff', bg: label === '北' ? '#d9534f' : 'rgba(0,0,0,0.55)', scale: 1.6 });
      sp.position.set(center.x, ringY + 0.9 * s, center.z).addScaledVector(d, R + 1.8 * s);
      this.pathG.add(markNoShadow(sp, 10));
    }
    this.pathG.visible = this.visible;
  }

  /** 現在の太陽位置（dir: 単位ベクトル）。地平線下なら消す */
  updateMarker(dir: THREE.Vector3, center: THREE.Vector3, radius: number): void {
    const R = Math.max(1, radius);
    if (dir.y <= 0) {
      this.markerAbove = false;
      this.markerG.visible = false;
      return;
    }
    if (!this.marker || Math.abs(this.marker.radius - R) > R * 0.01) this.buildMarker(R);
    const m = this.marker!;
    const d = dir.clone().normalize();
    const p = center.clone().addScaledVector(d, R);
    m.sun.position.copy(p);
    m.glow.position.copy(p);
    const pos = m.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, center.x, center.y + 0.1, center.z);
    pos.setXYZ(1, p.x, p.y, p.z);
    pos.needsUpdate = true;
    m.line.geometry.computeBoundingSphere();
    m.line.computeLineDistances();
    this.markerAbove = true;
    this.markerG.visible = this.visible;
  }

  private buildMarker(R: number) {
    clearGroup(this.markerG);
    const s = R / 22;
    const sun = new THREE.Mesh(new THREE.SphereGeometry(0.7 * s, 20, 14), flatMat('#fff1b0'));
    const glow = textSprite('☀', { size: 90, color: '#ffd24a', scale: 3 });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: '#ffd24a', dashSize: 0.6 * s, gapSize: 0.4 * s, toneMapped: false }));
    this.markerG.add(markNoShadow(sun, 3), markNoShadow(glow, 10), markNoShadow(line, 3));
    this.marker = { sun, glow, line, radius: R };
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.pathG.visible = v;
    this.markerG.visible = v && this.markerAbove;
  }

  clear(): void {
    clearGroup(this.pathG);
    clearGroup(this.markerG);
    this.marker = null;
    this.markerAbove = false;
  }
}

/** 光に影響されない単色マテリアル */
function flatMat(color: string): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, toneMapped: false });
}

/** 影を落とさない・受けない。renderOrder で地形より後に描く */
function markNoShadow<T extends THREE.Object3D>(o: T, renderOrder: number): T {
  o.castShadow = false;
  o.receiveShadow = false;
  o.renderOrder = renderOrder;
  return o;
}
