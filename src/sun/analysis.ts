/**
 * 日照解析（BVH による高速レイキャスト）
 *  - 部屋ごとの直射日光の入り方（時刻別の床面の日射率）
 *  - 敷地まわりの日照時間マップ
 *  - 日影図（時刻日影線・等時間日影線）
 */
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Viewer } from '../scene/viewer';
import type { BuildingModel, Room } from '../core/types';
import { isHabitable } from '../core/types';
import { pointInPolygon, insideLoops } from '../core/geometry';
import { sunPosition, sunDirectionWorld, localDate, sunriseSunset, trueSolarToLocal } from './solar';

export interface Occluder {
  bvh: MeshBVH;
  mesh: THREE.Mesh;
}

/** 影を落とす物体を1つの BVH にまとめる */
export function buildOccluder(viewer: Viewer, opts: { context?: boolean; trees?: boolean; buildingOnly?: boolean; furniture?: boolean; force?: boolean } = {}): Occluder {
  const positions: number[] = [];
  const add = (root: THREE.Object3D, filter?: (m: THREE.Mesh) => boolean) => {
    // 非表示のグループ（輪切り表示中の通常の建物など）は、force 指定が無ければ含めない
    if (!root.visible && !opts.force) return;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.visible) return;
      if (filter && !filter(m)) return;
      const key = (m.userData.matKey as string | undefined) ?? '';
      if (key.startsWith('ext.glass') || key === 'f.curtain' || key === 'f.water') return;
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
      const pos = g.getAttribute('position');
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        positions.push(v.x, v.y, v.z);
      }
    });
  };
  add(viewer.groups.building);
  add(viewer.groups.roof);
  if (!opts.force) add(viewer.groups.cut);
  if (opts.furniture) add(viewer.groups.furniture);
  if (!opts.buildingOnly) {
    if (opts.context !== false) add(viewer.groups.context, (m) => !!m.userData.neighbor);
    if (opts.trees) add(viewer.groups.landscape, (m) => (m.userData.matKey ?? '').startsWith('l.leaf') || m.userData.matKey === 'l.trunk');
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const bvh = new MeshBVH(geo);
  const mesh = new THREE.Mesh(geo);
  return { bvh, mesh };
}

const _ray = new THREE.Ray();

export function isShaded(occ: Occluder, p: THREE.Vector3, dir: THREE.Vector3): boolean {
  _ray.origin.copy(p).addScaledVector(dir, 0.02);
  _ray.direction.copy(dir);
  return !!occ.bvh.raycastFirst(_ray, THREE.DoubleSide);
}

export interface SunDay {
  year: number;
  month: number;
  day: number;
  lat: number;
  lon: number;
  northAngleDeg: number;
}

export interface RoomSunResult {
  roomId: string;
  name: string;
  level: number;
  type: Room['type'];
  /** 時刻 (h) ごとの床面日射率 0..1 */
  series: { h: number; frac: number }[];
  /** 直射日光が入る時間（床面の 3% 以上に日が当たる時間の合計, h） */
  hours: number;
  first: number | null;
  last: number | null;
  peak: number;
  peakAt: number | null;
}

async function yieldUI() {
  await new Promise((r) => setTimeout(r, 0));
}

/** 部屋ごとの日当たり */
export async function analyzeRooms(viewer: Viewer, day: SunDay, opts: { stepMin?: number; spacing?: number; onProgress?: (r: number) => void } = {}): Promise<RoomSunResult[]> {
  const st = viewer.state!;
  const model: BuildingModel = st.model;
  const occ = buildOccluder(viewer, { context: true, trees: false, force: true });
  const step = (opts.stepMin ?? 10) / 60;
  const spacing = opts.spacing ?? 0.35;
  const rs = sunriseSunset(day.year, day.month, day.day, day.lat, day.lon);
  const times: { h: number; dir: THREE.Vector3 }[] = [];
  for (let h = Math.ceil(rs.sunrise / step) * step; h <= rs.sunset; h += step) {
    const sp = sunPosition(localDate(day.year, day.month, day.day, h), day.lat, day.lon);
    if (sp.elevation <= 0.5) continue;
    times.push({ h, dir: sunDirectionWorld(sp.azimuth, sp.elevation, day.northAngleDeg) });
  }
  const out: RoomSunResult[] = [];
  const rooms = st.meta.rooms.filter((r) => isHabitable(r.room.type) || r.room.type === 'entrance' || r.room.type === 'hall');
  let done = 0;
  for (const ri of rooms) {
    const poly = ri.room.polygon.map((p) => ({ x: p.x / 1000, y: p.y / 1000 }));
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    const pts: THREE.Vector3[] = [];
    for (let x = Math.min(...xs) + spacing / 2; x < Math.max(...xs); x += spacing)
      for (let z = Math.min(...ys) + spacing / 2; z < Math.max(...ys); z += spacing) {
        if (!pointInPolygon({ x, y: z }, poly)) continue;
        // 壁際は除外
        const nearEdge = poly.some((p, i) => {
          const q = poly[(i + 1) % poly.length];
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.y) * dy) / l2));
          return Math.hypot(p.x + dx * t - x, p.y + dy * t - z) < 0.12;
        });
        if (!nearEdge) pts.push(new THREE.Vector3(x, ri.floorY + 0.03, z));
      }
    const series: { h: number; frac: number }[] = [];
    for (const t of times) {
      let lit = 0;
      for (const p of pts) if (!isShaded(occ, p, t.dir)) lit++;
      series.push({ h: t.h, frac: pts.length ? lit / pts.length : 0 });
    }
    const litTimes = series.filter((s) => s.frac >= 0.03);
    const peak = series.reduce((a, s) => (s.frac > a.frac ? s : a), { h: 0, frac: 0 });
    out.push({
      roomId: ri.room.id,
      name: ri.room.name,
      level: ri.floor.level,
      type: ri.room.type,
      series,
      hours: litTimes.length * step,
      first: litTimes.length ? litTimes[0].h : null,
      last: litTimes.length ? litTimes[litTimes.length - 1].h : null,
      peak: peak.frac,
      peakAt: peak.frac > 0 ? peak.h : null,
    });
    done++;
    opts.onProgress?.(done / rooms.length);
    await yieldUI();
  }
  occ.mesh.geometry.dispose();
  return out;
}

export interface GridResult {
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  values: Float32Array;
}

/** 地面の日照時間マップ（指定した時間帯, h 単位） */
export async function groundSunHours(viewer: Viewer, day: SunDay, opts: { from?: number; to?: number; stepMin?: number; cell?: number; half?: number; height?: number; onProgress?: (r: number) => void } = {}): Promise<GridResult> {
  const st = viewer.state!;
  const occ = buildOccluder(viewer, { context: true, trees: true, force: true });
  const c = st.meta.bbox.getCenter(new THREE.Vector3());
  const half = opts.half ?? 22;
  const cell = opts.cell ?? 0.5;
  const nx = Math.ceil((half * 2) / cell);
  const nz = nx;
  const x0 = c.x - half;
  const z0 = c.z - half;
  const step = (opts.stepMin ?? 15) / 60;
  const rs = sunriseSunset(day.year, day.month, day.day, day.lat, day.lon);
  const from = opts.from ?? rs.sunrise;
  const to = opts.to ?? rs.sunset;
  const dirs: THREE.Vector3[] = [];
  for (let h = from + step / 2; h < to; h += step) {
    const sp = sunPosition(localDate(day.year, day.month, day.day, h), day.lat, day.lon);
    if (sp.elevation > 0.5) dirs.push(sunDirectionWorld(sp.azimuth, sp.elevation, day.northAngleDeg));
  }
  const values = new Float32Array(nx * nz);
  const p = new THREE.Vector3();
  const y = opts.height ?? 0.05;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      p.set(x0 + (i + 0.5) * cell, y, z0 + (j + 0.5) * cell);
      let lit = 0;
      for (const d of dirs) if (!isShaded(occ, p, d)) lit++;
      values[j * nx + i] = lit * step;
    }
    if (j % 8 === 0) {
      opts.onProgress?.(j / nz);
      await yieldUI();
    }
  }
  occ.mesh.geometry.dispose();
  return { x0, z0, cell, nx, nz, values };
}

/** 日照時間マップをテクスチャ付きの面にする */
export function heatmapMesh(g: GridResult, maxHours: number, y = 0.06, mask?: (x: number, z: number) => boolean): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = g.nx;
  c.height = g.nz;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(g.nx, g.nz);
  for (let j = 0; j < g.nz; j++)
    for (let i = 0; i < g.nx; i++) {
      const v = g.values[j * g.nx + i] / maxHours;
      const [r, gg, b] = heatColor(v);
      const k = (j * g.nx + i) * 4;
      const x = g.x0 + (i + 0.5) * g.cell;
      const z = g.z0 + (j + 0.5) * g.cell;
      const hidden = mask ? !mask(x, z) : false;
      img.data[k] = r;
      img.data[k + 1] = gg;
      img.data[k + 2] = b;
      img.data[k + 3] = hidden ? 0 : 150;
    }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.flipY = false;
  const w = g.nx * g.cell;
  const h = g.nz * g.cell;
  const geo = new THREE.PlaneGeometry(w, h);
  geo.rotateX(-Math.PI / 2);
  // PlaneGeometry の UV: v=1 が +Y(→ -Z)。flipY=false なので行0 = v0 = +Z 側…を合わせる
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(g.x0 + w / 2, y, g.z0 + h / 2);
  mesh.renderOrder = 3;
  return mesh;
}

/** 青（日陰）→ 緑 → 黄 → 赤（よく日が当たる） */
export function heatColor(v: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, [40, 60, 150]],
    [0.25, [50, 140, 210]],
    [0.5, [80, 190, 120]],
    [0.75, [240, 210, 60]],
    [1, [235, 90, 40]],
  ];
  const t = Math.max(0, Math.min(1, v));
  for (let i = 0; i + 1 < stops.length; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (t <= b) {
      const k = (t - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k];
    }
  }
  return stops[stops.length - 1][1];
}

// ---------------------------------------------------------------------------
// 日影図
// ---------------------------------------------------------------------------

export interface ShadowDiagram {
  svg: string;
  /** 等時間日影線の最大到達距離など */
  summary: { hour: number; maxDist: number }[];
}

function marchingSegments(values: Float32Array, nx: number, nz: number, level: number): [number, number, number, number][] {
  const segs: [number, number, number, number][] = [];
  const v = (i: number, j: number) => values[j * nx + i];
  const interp = (a: number, b: number) => (level - a) / (b - a || 1e-9);
  for (let j = 0; j + 1 < nz; j++)
    for (let i = 0; i + 1 < nx; i++) {
      const a = v(i, j);
      const b = v(i + 1, j);
      const c = v(i + 1, j + 1);
      const d = v(i, j + 1);
      const idx = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const top: [number, number] = [i + interp(a, b), j];
      const right: [number, number] = [i + 1, j + interp(b, c)];
      const bottom: [number, number] = [i + interp(d, c), j + 1];
      const left: [number, number] = [i, j + interp(a, d)];
      const add = (p: [number, number], q: [number, number]) => segs.push([p[0], p[1], q[0], q[1]]);
      switch (idx) {
        case 1:
        case 14:
          add(left, top);
          break;
        case 2:
        case 13:
          add(top, right);
          break;
        case 3:
        case 12:
          add(left, right);
          break;
        case 4:
        case 11:
          add(right, bottom);
          break;
        case 6:
        case 9:
          add(top, bottom);
          break;
        case 7:
        case 8:
          add(left, bottom);
          break;
        case 5:
          add(left, top);
          add(right, bottom);
          break;
        case 10:
          add(top, right);
          add(left, bottom);
          break;
      }
    }
  return segs;
}

/**
 * 日影図（冬至日・真太陽時 8〜16 時）
 * planeHeight: 測定面の高さ (m)。1.5 / 4.0 など
 */
export async function shadowDiagram(viewer: Viewer, loc: { lat: number; lon: number; northAngleDeg: number; year: number }, planeHeight = 1.5, onProgress?: (r: number) => void): Promise<ShadowDiagram> {
  const st = viewer.state!;
  const occ = buildOccluder(viewer, { buildingOnly: true, force: true });
  const c = st.meta.bbox.getCenter(new THREE.Vector3());
  const half = 34;
  const cell = 0.3;
  const nx = Math.ceil((half * 2) / cell);
  const nz = nx;
  const x0 = c.x - half;
  const z0 = c.z - half;
  const Y = loc.year;
  const M = 12;
  const D = 22;
  const stepMin = 10;
  const hours: number[] = [];
  for (let s = 8; s <= 16 + 1e-6; s += stepMin / 60) hours.push(s);
  const dirs = hours.map((s) => {
    const lh = trueSolarToLocal(Y, M, D, s, loc.lon);
    const sp = sunPosition(localDate(Y, M, D, lh), loc.lat, loc.lon);
    return { s, dir: sunDirectionWorld(sp.azimuth, sp.elevation, loc.northAngleDeg), elev: sp.elevation };
  });
  const count = new Float32Array(nx * nz);
  const hourMasks = new Map<number, Float32Array>();
  for (let s = 8; s <= 16; s++) hourMasks.set(s, new Float32Array(nx * nz));
  const p = new THREE.Vector3();
  const footprints = st.meta.outlines.map((o) => o.polys.map((poly) => poly.map((q) => ({ x: q.x, y: q.y }))));
  const inBuilding = (x: number, z: number) => footprints.some((loops) => insideLoops({ x, y: z }, loops));
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      p.set(x0 + (i + 0.5) * cell, planeHeight, z0 + (j + 0.5) * cell);
      if (inBuilding(p.x, p.z)) {
        // 建物内部は日影図の対象外（等時間線が内部に出ないよう最大値に）
        count[j * nx + i] = 8;
        for (const m of hourMasks.values()) m[j * nx + i] = 1;
        continue;
      }
      let shaded = 0;
      for (let k = 0; k < dirs.length; k++) {
        const d = dirs[k];
        const sh = d.elev <= 0 || isShaded(occ, p, d.dir);
        // 台形則で時間を積算
        const w = k === 0 || k === dirs.length - 1 ? 0.5 : 1;
        if (sh) shaded += (w * stepMin) / 60;
        const hr = d.s;
        if (Math.abs(hr - Math.round(hr)) < 1e-6 && hourMasks.has(Math.round(hr))) hourMasks.get(Math.round(hr))![j * nx + i] = sh ? 1 : 0;
      }
      count[j * nx + i] = shaded;
    }
    if (j % 10 === 0) {
      onProgress?.(j / nz);
      await yieldUI();
    }
  }
  occ.mesh.geometry.dispose();

  // ---- SVG ----
  const S = 100; // 1m = 100 単位
  const toX = (gi: number) => (x0 + gi * cell) * S;
  const toY = (gj: number) => (z0 + gj * cell) * S;
  let body = '';
  // 敷地・建物
  const site = st.site;
  body += `<rect x="${site.min.x * S}" y="${site.min.y * S}" width="${(site.max.x - site.min.x) * S}" height="${(site.max.y - site.min.y) * S}" fill="none" stroke="#333" stroke-width="12" stroke-dasharray="60 25 10 25"/>`;
  // 5m・10m ライン（敷地境界から）
  for (const [d, col] of [
    [5, '#9a9a9a'],
    [10, '#bdbdbd'],
  ] as const) {
    body += `<rect x="${(site.min.x - d) * S}" y="${(site.min.y - d) * S}" width="${(site.max.x - site.min.x + d * 2) * S}" height="${(site.max.y - site.min.y + d * 2) * S}" fill="none" stroke="${col}" stroke-width="8" stroke-dasharray="30 20"/>`;
    body += `<text x="${(site.max.x + d) * S + 20}" y="${(site.min.y - d) * S + 60}" font-size="70" fill="${col}">${d}mライン</text>`;
  }
  for (const o of st.meta.outlines) {
    for (const poly of o.polys) body += `<polygon points="${poly.map((q) => `${q.x * S},${q.y * S}`).join(' ')}" fill="${o.level === 1 ? '#555' : 'none'}" stroke="#222" stroke-width="10" fill-opacity="0.35"/>`;
  }
  // 時刻日影線
  for (const [h, mask] of hourMasks) {
    const segs = marchingSegments(mask, nx, nz, 0.5);
    const d = segs.map(([a, b, cc, dd]) => `M${toX(a + 0.5).toFixed(0)} ${toY(b + 0.5).toFixed(0)}L${toX(cc + 0.5).toFixed(0)} ${toY(dd + 0.5).toFixed(0)}`).join('');
    body += `<path d="${d}" stroke="#3b7dd8" stroke-width="7" fill="none" opacity="0.8"/>`;
    // ラベル: 影の先端（中心から最も遠い点）
    let far: [number, number] | null = null;
    let fd = 0;
    for (const [a, b] of segs) {
      const X = x0 + (a + 0.5) * cell;
      const Z = z0 + (b + 0.5) * cell;
      const dd = Math.hypot(X - c.x, Z - c.z);
      if (dd > fd) {
        fd = dd;
        far = [X, Z];
      }
    }
    if (far) body += `<text x="${far[0] * S}" y="${far[1] * S}" font-size="80" fill="#3b7dd8" font-weight="bold">${h}時</text>`;
  }
  // 等時間日影線
  const summary: { hour: number; maxDist: number }[] = [];
  const eqCols: Record<number, string> = { 2: '#e67e22', 3: '#d35400', 4: '#c0392b', 5: '#8e44ad' };
  for (const hh of [2, 3, 4, 5]) {
    const segs = marchingSegments(count, nx, nz, hh);
    const d = segs.map(([a, b, cc, dd]) => `M${toX(a + 0.5).toFixed(0)} ${toY(b + 0.5).toFixed(0)}L${toX(cc + 0.5).toFixed(0)} ${toY(dd + 0.5).toFixed(0)}`).join('');
    body += `<path d="${d}" stroke="${eqCols[hh]}" stroke-width="14" fill="none"/>`;
    let maxDist = 0;
    let lab: [number, number] | null = null;
    for (const [a, b] of segs) {
      const X = x0 + (a + 0.5) * cell;
      const Z = z0 + (b + 0.5) * cell;
      // 敷地境界からの距離
      const dx = Math.max(site.min.x - X, 0, X - site.max.x);
      const dz = Math.max(site.min.y - Z, 0, Z - site.max.y);
      const dist = Math.hypot(dx, dz);
      if (dist > maxDist) {
        maxDist = dist;
        lab = [X, Z];
      }
    }
    summary.push({ hour: hh, maxDist });
    if (lab) body += `<text x="${lab[0] * S + 30}" y="${lab[1] * S - 20}" font-size="90" fill="${eqCols[hh]}" font-weight="bold">${hh}時間</text>`;
  }
  // 方位
  const nA = loc.northAngleDeg;
  const ax = (x0 + half * 2 - 3) * S;
  const ay = (z0 + 3) * S;
  body += `<g transform="translate(${ax} ${ay}) rotate(${nA})"><circle r="150" fill="#fff" stroke="#333" stroke-width="10"/><path d="M0 -160 L50 90 L0 50 L-50 90Z" fill="#333"/><text y="-190" font-size="110" text-anchor="middle" font-weight="bold">N</text></g>`;
  const vb = `${x0 * S} ${z0 * S - 250} ${half * 2 * S} ${half * 2 * S + 500}`;
  const title = `日影図（冬至日 真太陽時 8:00〜16:00 / 測定面 GL+${planeHeight}m）`;
  const legend = `<text x="${x0 * S + 60}" y="${z0 * S - 120}" font-size="110" font-weight="bold" fill="#222">${title}</text>` +
    `<text x="${x0 * S + 60}" y="${(z0 + half * 2) * S + 180}" font-size="75" fill="#555">青線: 時刻日影線（毎正時）　橙〜紫: 等時間日影線（2・3・4・5時間）　点線: 敷地境界・5m/10mライン　※周辺建物は含みません</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" font-family="'Noto Sans JP','Hiragino Sans',sans-serif"><rect x="${x0 * S}" y="${z0 * S - 250}" width="${half * 2 * S}" height="${half * 2 * S + 500}" fill="#fff"/>${body}${legend}</svg>`;
  return { svg, summary };
}
