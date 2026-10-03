/**
 * 日照検討用の周辺環境（航空写真・周辺建物・太陽軌道・方位）
 */
import * as THREE from 'three';
import type { Viewer } from '../scene/viewer';
import { clearGroup } from '../scene/viewer';
import { fetchAerial, fetchGsiBuildings, fetchOsmBuildings, siteLatLon, type NeighborBuilding, type SiteLocation } from './geo';
import { sunPosition, sunDirectionWorld, localDate, keyDates, sunriseSunset } from './solar';

export function textSprite(text: string, opts: { size?: number; color?: string; bg?: string; scale?: number } = {}): THREE.Sprite {
  const size = opts.size ?? 48;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `bold ${size}px 'Noto Sans JP', 'Hiragino Sans', sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + size * 0.8;
  c.width = w;
  c.height = Math.ceil(size * 1.5);
  ctx.font = `bold ${size}px 'Noto Sans JP', 'Hiragino Sans', sans-serif`;
  if (opts.bg) {
    ctx.fillStyle = opts.bg;
    const r = c.height / 2;
    ctx.beginPath();
    ctx.roundRect(0, 0, c.width, c.height, r);
    ctx.fill();
  }
  ctx.fillStyle = opts.color ?? '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2 + size * 0.05);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // 画面上で一定の大きさ（距離で拡大縮小しない）
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false, sizeAttenuation: false });
  const sp = new THREE.Sprite(mat);
  const s = (opts.scale ?? 1) * 0.032;
  sp.scale.set((c.width / c.height) * s, s, 1);
  sp.renderOrder = 10;
  return sp;
}

export interface ContextState {
  site: SiteLocation;
  neighbors: NeighborBuilding[];
  showAerial: boolean;
  showNeighbors: boolean;
  showSunPath: boolean;
  aerialLoaded: boolean;
}

export class SunContext {
  readonly group = new THREE.Group();
  private aerial = new THREE.Group();
  private neighborsG = new THREE.Group();
  private pathG = new THREE.Group();
  private sunMarker = new THREE.Group();
  private aerialInfo: { west: number; east: number; south: number; north: number; tex: THREE.Texture } | null = null;
  state: ContextState;
  year = new Date().getFullYear();

  constructor(
    readonly viewer: Viewer,
    site: SiteLocation,
  ) {
    this.state = { site, neighbors: [], showAerial: true, showNeighbors: true, showSunPath: true, aerialLoaded: false };
    this.group.add(this.aerial, this.neighborsG, this.pathG, this.sunMarker);
    viewer.groups.context.add(this.group);
  }

  /** 東・北 (m) → ワールド */
  toWorld(e: number, n: number, y = 0): THREE.Vector3 {
    const st = this.viewer.state!;
    const c = st.meta.bbox.getCenter(new THREE.Vector3());
    const a = (st.model.northAngleDeg * Math.PI) / 180;
    const north = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
    const east = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    return new THREE.Vector3(c.x, y, c.z).addScaledVector(east, e).addScaledVector(north, n);
  }

  /** ワールド座標 → 建物中心からの東・北 (m) */
  fromWorld(p: THREE.Vector3): { e: number; n: number } {
    const st = this.viewer.state!;
    const c = st.meta.bbox.getCenter(new THREE.Vector3());
    const a = (st.model.northAngleDeg * Math.PI) / 180;
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    return { e: dx * Math.cos(a) + dz * Math.sin(a), n: dx * Math.sin(a) - dz * Math.cos(a) };
  }

  /** 画面上の点が航空写真のどこか（航空写真が無ければ null） */
  pickAerial(ndc: THREE.Vector2): THREE.Vector3 | null {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.viewer.camera);
    const hit = rc.intersectObjects(this.aerial.children, true)[0];
    return hit ? hit.point : null;
  }

  get center() {
    return this.viewer.state!.meta.bbox.getCenter(new THREE.Vector3()).setY(0);
  }

  async loadAerial(kind: 'photo' | 'map' = 'photo') {
    const { lat, lon } = siteLatLon(this.state.site);
    const img = await fetchAerial(lat, lon, 220, kind === 'photo' ? 18 : 17, kind);
    clearGroup(this.aerial);
    const tex = new THREE.CanvasTexture(img.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const geo = new THREE.BufferGeometry();
    const nw = this.toWorld(img.west, img.north, -0.03);
    const ne = this.toWorld(img.east, img.north, -0.03);
    const se = this.toWorld(img.east, img.south, -0.03);
    const sw = this.toWorld(img.west, img.south, -0.03);
    geo.setAttribute('position', new THREE.Float32BufferAttribute([...sw.toArray(), ...se.toArray(), ...ne.toArray(), ...sw.toArray(), ...ne.toArray(), ...nw.toArray()], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
    geo.computeVertexNormals();
    // 法線を上向きに
    const n = geo.getAttribute('normal');
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    mesh.name = 'aerial';
    this.aerial.add(mesh);
    this.state.aerialLoaded = true;
    this.aerialInfo = { west: img.west, east: img.east, south: img.south, north: img.north, tex };
    this.buildNeighbors();
    this.applyVisibility();
    return img.attribution;
  }

  async loadNeighbors(source: 'gsi' | 'osm' = 'gsi') {
    const { lat, lon } = siteLatLon(this.state.site);
    // 国土地理院で取れなければ OpenStreetMap で取り直す（逆も同様）
    const fetchFrom = (src: 'gsi' | 'osm') => (src === 'gsi' ? fetchGsiBuildings(lat, lon, 110) : fetchOsmBuildings(lat, lon, 110));
    let list: NeighborBuilding[] = [];
    let err: Error | null = null;
    for (const src of source === 'gsi' ? (['gsi', 'osm'] as const) : (['osm', 'gsi'] as const)) {
      try {
        list = await fetchFrom(src);
        if (list.length) break;
      } catch (e) {
        err = e as Error;
      }
    }
    if (!list.length && err) throw err;
    // 自分の敷地・新築の建物に重なる建物（建て替え前の既存建物など）は除外
    const st = this.viewer.state!;
    const site = st.site;
    const bb = st.meta.bbox;
    const inSite = (b: NeighborBuilding) => {
      const ws = b.ring.map((p) => this.toWorld(p.e, p.n));
      if (ws.some((w) => w.x > site.min.x - 0.5 && w.x < site.max.x + 0.5 && w.z > site.min.y - 0.5 && w.z < site.max.y + 0.5)) return true;
      const x0 = Math.min(...ws.map((w) => w.x));
      const x1 = Math.max(...ws.map((w) => w.x));
      const z0 = Math.min(...ws.map((w) => w.z));
      const z1 = Math.max(...ws.map((w) => w.z));
      return x1 > bb.min.x - 0.8 && x0 < bb.max.x + 0.8 && z1 > bb.min.z - 0.8 && z0 < bb.max.z + 0.8;
    };
    const manual = this.state.neighbors.filter((b) => b.source === 'manual');
    this.state.neighbors = [...manual, ...list.filter((b) => !inSite(b))];
    this.buildNeighbors();
    return this.state.neighbors.length - manual.length;
  }

  /** 手動で隣家を追加（方向・距離・大きさ） */
  addManualNeighbor(dirDeg: number, distance: number, width = 8, depth = 8, height = 7) {
    const a = (dirDeg * Math.PI) / 180;
    const ce = Math.sin(a) * distance;
    const cn = Math.cos(a) * distance;
    const hw = width / 2;
    const hd = depth / 2;
    this.state.neighbors.push({
      ring: [
        { e: ce - hw, n: cn - hd },
        { e: ce + hw, n: cn - hd },
        { e: ce + hw, n: cn + hd },
        { e: ce - hw, n: cn + hd },
      ],
      height,
      source: 'manual',
      label: '隣家',
    });
    this.buildNeighbors();
  }

  clearNeighbors() {
    this.state.neighbors = [];
    this.buildNeighbors();
  }

  buildNeighbors() {
    clearGroup(this.neighborsG);
    const wallMat = new THREE.MeshStandardMaterial({ color: '#e8e6e1', roughness: 0.9 });
    // 航空写真があれば屋上に貼る（Google Earth のような見え方）
    const ai = this.aerialInfo;
    const roofMat = ai ? new THREE.MeshStandardMaterial({ map: ai.tex, roughness: 0.85 }) : new THREE.MeshStandardMaterial({ color: '#8d8f93', roughness: 0.8 });
    const st = this.viewer.state!;
    const c0 = st.meta.bbox.getCenter(new THREE.Vector3());
    const a0 = (st.model.northAngleDeg * Math.PI) / 180;
    const northV = new THREE.Vector3(Math.sin(a0), 0, -Math.cos(a0));
    const eastV = new THREE.Vector3(Math.cos(a0), 0, Math.sin(a0));
    const manualMat = new THREE.MeshStandardMaterial({ color: '#d9c7a8', roughness: 0.9 });
    for (const b of this.state.neighbors) {
      const pts = b.ring.map((p) => this.toWorld(p.e, p.n));
      // ワールド XZ で Shape を作り、上方向へ押し出す
      const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.z)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: b.height, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      if (ai) {
        // 屋根面（上向き）の UV を航空写真の座標に
        const pos = geo.getAttribute('position');
        const nor = geo.getAttribute('normal');
        const uv = geo.getAttribute('uv');
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          if (nor.getY(i) < 0.9) continue;
          v.fromBufferAttribute(pos, i).sub(c0);
          const e = v.dot(eastV);
          const n = v.dot(northV);
          uv.setXY(i, (e - ai.west) / (ai.east - ai.west), (n - ai.south) / (ai.north - ai.south));
        }
        uv.needsUpdate = true;
      }
      // ExtrudeGeometry のグループ: 0 = 上下面, 1 = 側面
      const mesh = new THREE.Mesh(geo, [roofMat, b.source === 'manual' ? manualMat : wallMat]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.neighbor = true;
      mesh.userData.matKey = undefined;
      this.neighborsG.add(mesh);
    }
    this.applyVisibility();
    this.viewer.invalidate();
  }

  applyVisibility() {
    this.aerial.visible = this.state.showAerial && this.state.aerialLoaded;
    this.neighborsG.visible = this.state.showNeighbors;
    this.pathG.visible = this.state.showSunPath;
    // 航空写真表示中は生成した道路・遠景の地面を隠す
    this.viewer.groups.landscape.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.userData.matKey === 'l.far' || m.userData.matKey === 'l.road' || m.userData.matKey === 'l.curb')) m.visible = !this.aerial.visible;
    });
    this.viewer.invalidate();
  }

  /** 太陽軌道（冬至・春秋分・夏至）と方位 */
  buildSunPath(radius = 22) {
    clearGroup(this.pathG);
    const st = this.viewer.state!;
    const { lat, lon } = siteLatLon(this.state.site);
    const center = this.center;
    const colors: Record<string, string> = { winter: '#4ea3ff', spring: '#6ccf7a', summer: '#ffa53b' };
    for (const d of keyDates(this.year)) {
      if (d.id === 'autumn') continue;
      const pts: THREE.Vector3[] = [];
      const rs = sunriseSunset(d.year, d.month, d.day, lat, lon);
      for (let h = rs.sunrise; h <= rs.sunset; h += 1 / 12) {
        const sp = sunPosition(localDate(d.year, d.month, d.day, h), lat, lon);
        if (sp.elevation < -0.5) continue;
        pts.push(center.clone().addScaledVector(sunDirectionWorld(sp.azimuth, Math.max(0, sp.elevation), st.model.northAngleDeg), radius));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: colors[d.id], linewidth: 2, toneMapped: false, depthTest: true }));
      this.pathG.add(line);
      // 時刻の目盛り
      for (let h = Math.ceil(rs.sunrise); h <= Math.floor(rs.sunset); h++) {
        const sp = sunPosition(localDate(d.year, d.month, d.day, h), lat, lon);
        if (sp.elevation < 0) continue;
        const p = center.clone().addScaledVector(sunDirectionWorld(sp.azimuth, sp.elevation, st.model.northAngleDeg), radius);
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), new THREE.MeshBasicMaterial({ color: colors[d.id], toneMapped: false }));
        dot.position.copy(p);
        this.pathG.add(dot);
        if (d.id === 'winter' ? h % 2 === 0 : h % 3 === 0) {
          const label = textSprite(`${h}時`, { size: 40, color: '#fff', bg: 'rgba(0,0,0,0.45)', scale: 0.9 });
          label.position.copy(p).add(new THREE.Vector3(0, 0.7, 0));
          this.pathG.add(label);
        }
      }
      // 日付ラベル（南中付近）
      const noon = sunPosition(localDate(d.year, d.month, d.day, rs.noon), lat, lon);
      const lp = center.clone().addScaledVector(sunDirectionWorld(noon.azimuth, noon.elevation, st.model.northAngleDeg), radius + 2.5);
      const lab = textSprite(d.label, { size: 44, color: '#fff', bg: colors[d.id], scale: 1.3 });
      lab.position.copy(lp);
      this.pathG.add(lab);
    }
    // 方位リング
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.12, radius + 0.12, 128), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, side: THREE.DoubleSide, toneMapped: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(center).setY(0.05);
    this.pathG.add(ring);
    const dirs: [string, number][] = [
      ['北', 0],
      ['東', 90],
      ['南', 180],
      ['西', 270],
    ];
    for (const [label, az] of dirs) {
      const d = sunDirectionWorld(az, 0, st.model.northAngleDeg);
      const s = textSprite(label, { size: 56, color: '#fff', bg: label === '北' ? '#d9534f' : 'rgba(0,0,0,0.55)', scale: 1.6 });
      s.position.copy(center).addScaledVector(d, radius + 1.8).setY(0.9);
      this.pathG.add(s);
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.02, 1.4), new THREE.MeshBasicMaterial({ color: '#fff', toneMapped: false }));
      tick.position.copy(center).addScaledVector(d, radius).setY(0.06);
      tick.lookAt(center.clone().setY(0.06));
      this.pathG.add(tick);
    }
    this.applyVisibility();
  }

  /** 現在の太陽位置マーカー */
  updateSunMarker(dir: THREE.Vector3, radius = 22) {
    clearGroup(this.sunMarker);
    if (dir.y <= 0) return;
    const p = this.center.addScaledVector(dir, radius);
    const sun = new THREE.Mesh(new THREE.SphereGeometry(0.7, 20, 14), new THREE.MeshBasicMaterial({ color: '#fff1b0', toneMapped: false }));
    sun.position.copy(p);
    this.sunMarker.add(sun);
    const glow = textSprite('☀', { size: 90, color: '#ffd24a', scale: 3 });
    glow.position.copy(p);
    this.sunMarker.add(glow);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([this.center.setY(0.1), p]);
    this.sunMarker.add(new THREE.Line(lineGeo, new THREE.LineDashedMaterial({ color: '#ffd24a', dashSize: 0.6, gapSize: 0.4, toneMapped: false })));
    (this.sunMarker.children[2] as THREE.Line).computeLineDistances();
    this.sunMarker.visible = this.state.showSunPath;
    this.viewer.invalidate();
  }
}
