/**
 * 日照解析（BVH による高速レイキャスト）
 *
 * 汎用コア（Viewer に依存しない）
 *  - buildOccluderFrom / bakeWorldTriangles: 任意の Object3D 群からワールド座標の三角形を焼き込み、1 つの BVH にする
 *    （root ごとに種別 kind を付け、レイキャストの faceIndex から種別を引ける）
 *  - isShaded / isShadedFrom / isShadedMulti / raycastFirstKind: 遮蔽判定
 *  - sunSamplesForDay: 1 日の太陽方向の時刻表
 *  - sunHoursGrid: 格子の日照時間
 *  - shadowDiagramCore: 日影図（時刻日影線・等時間日影線）の SVG
 *  - marchingSegments / segmentsToPolylines / offsetPolygon / distanceToPolygon / yieldUI / heatColor
 *
 * 既存アプリ（Viewer）用のラッパー: buildOccluder / analyzeRooms / groundSunHours / heatmapMesh / shadowDiagram
 * （結果は以前の実装と同じ）
 */
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Viewer } from '../scene/viewer';
import type { BuildingModel, Room } from '../core/types';
import { isHabitable } from '../core/types';
import { pointInPolygon, insideLoops } from '../core/geometry';
import { sunPosition, sunDirectionWorld, localDate, sunriseSunset, trueSolarToLocal, formatHM } from './solar';

// ---------------------------------------------------------------------------
// 遮蔽物（BVH）
// ---------------------------------------------------------------------------

/** 三角形番号（焼き込んだ順＝元の番号）の範囲とその種別 */
export interface OccluderRange {
  start: number;
  end: number;
  kind: string;
}

export interface Occluder {
  bvh: MeshBVH;
  mesh: THREE.Mesh;
  /** root ごとの三角形の範囲（start 以上 end 未満）。buildOccluderFrom が設定する */
  ranges: OccluderRange[];
  /** レイキャスト結果の faceIndex → 種別（'building' など。範囲外は ''） */
  kindOf: (faceIndex: number) => string;
  /** 三角形数 */
  triangles: number;
  /**
   * 追加の遮蔽物（別の BVH）。isShaded / isShadedFrom / raycastFirstKind はこちらも順に判定する。
   * 地形のように大きく変化の少ないものをキャッシュして使い回すためのもの（sunstudy/analysis.ts の buildStudyOccluder 参照）
   */
  extra?: Occluder[];
}

/** 焼き込む対象: root と、その三角形に付ける種別 */
export interface OccluderPart {
  root: THREE.Object3D;
  kind: string;
}

/** ワールド座標に焼き込んだ三角形（9 floats / 三角形） */
export interface BakedTriangles {
  positions: Float32Array;
  ranges: OccluderRange[];
  triangles: number;
}

/** 影を落とさないマテリアル（既存アプリのガラス・カーテン・水面） */
function excludedMatKey(m: THREE.Mesh): boolean {
  const key = (m.userData.matKey as string | undefined) ?? '';
  return key.startsWith('ext.glass') || key === 'f.curtain' || key === 'f.water';
}

/** root（含まない）までの祖先がすべて visible か */
function visibleUpTo(o: THREE.Object3D, root: THREE.Object3D): boolean {
  let p = o.parent;
  while (p && p !== root) {
    if (!p.visible) return false;
    p = p.parent;
  }
  return true;
}

function triangleCount(g: THREE.BufferGeometry): number {
  const pos = g.getAttribute('position');
  if (!pos) return 0;
  return Math.floor((g.index ? g.index.count : pos.count) / 3);
}

const _v = new THREE.Vector3();

/** 1 メッシュの三角形をワールド座標で positions[offset..] に書き、次の書き込み位置を返す */
function appendTriangles(positions: Float32Array, offset: number, m: THREE.Mesh): number {
  const g = m.geometry;
  const pos = g.getAttribute('position');
  const idx = g.index;
  const mw = m.matrixWorld;
  const n = triangleCount(g) * 3;
  let o = offset;
  for (let i = 0; i < n; i++) {
    const vi = idx ? idx.getX(i) : i;
    _v.fromBufferAttribute(pos, vi).applyMatrix4(mw);
    positions[o++] = _v.x;
    positions[o++] = _v.y;
    positions[o++] = _v.z;
  }
  return o;
}

function normalizeParts(roots: THREE.Object3D[] | OccluderPart[]): OccluderPart[] {
  return roots.map((r, i) => {
    const o = r as THREE.Object3D;
    if (o.isObject3D) return { root: o, kind: o.name || `root${i}` };
    return r as OccluderPart;
  });
}

/**
 * 可視メッシュの三角形をワールド座標で焼き込む（インデックス付きは index を辿る。toNonIndexed は使わない）。
 *  - userData.noShadow のメッシュ、ガラス等（matKey）は除く
 *  - opts.ancestors（既定 true）: root までの祖先グループが非表示なら除く。false なら各メッシュ自身の visible だけを見る（既存アプリ互換）
 */
export function bakeWorldTriangles(roots: THREE.Object3D[] | OccluderPart[], filter?: (m: THREE.Mesh) => boolean, opts: { ancestors?: boolean; ignoreVisibility?: boolean } = {}): BakedTriangles {
  const parts = normalizeParts(roots);
  const ancestors = opts.ancestors !== false && !opts.ignoreVisibility;
  const ignoreVis = !!opts.ignoreVisibility;
  const lists: { kind: string; meshes: THREE.Mesh[] }[] = [];
  let total = 0;
  for (const part of parts) {
    part.root.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    part.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (!ignoreVis && !m.visible)) return;
      if (ancestors && !visibleUpTo(m, part.root)) return;
      if (m.userData.noShadow) return;
      if (filter && !filter(m)) return;
      if (excludedMatKey(m)) return;
      const n = triangleCount(m.geometry);
      if (!n) return;
      meshes.push(m);
      total += n;
    });
    lists.push({ kind: part.kind, meshes });
  }
  const positions = new Float32Array(total * 9);
  const ranges: OccluderRange[] = [];
  let o = 0;
  for (const l of lists) {
    const start = o / 9;
    for (const m of l.meshes) o = appendTriangles(positions, o, m);
    ranges.push({ start, end: o / 9, kind: l.kind });
  }
  return { positions, ranges, triangles: total };
}

/** 焼き込んだ三角形から BVH を作る */
export function occluderFromTriangles(b: BakedTriangles): Occluder {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
  const bvh = new MeshBVH(geo);
  const mesh = new THREE.Mesh(geo);
  const ranges = b.ranges;
  // MeshBVH は index を並べ替える（position はそのまま）。faceIndex → index の先頭頂点 / 3 が元の三角形番号
  const index = geo.index;
  const kindOf = (faceIndex: number): string => {
    const orig = index ? Math.floor(index.getX(faceIndex * 3) / 3) : faceIndex;
    for (const r of ranges) if (orig >= r.start && orig < r.end) return r.kind;
    return '';
  };
  return { bvh, mesh, ranges, kindOf, triangles: b.triangles };
}

/**
 * 影を落とす物体を 1 つの BVH にまとめる。
 *  buildOccluderFrom([group1, group2]) — 種別は root の name
 *  buildOccluderFrom([{ root, kind: 'building' }, { root, kind: 'neighbor' }]) — 種別を指定
 */
export function buildOccluderFrom(roots: THREE.Object3D[] | OccluderPart[], filter?: (m: THREE.Mesh) => boolean, opts: { ancestors?: boolean; ignoreVisibility?: boolean } = {}): Occluder {
  return occluderFromTriangles(bakeWorldTriangles(roots, filter, opts));
}

/** 外部の正確な建物（groups.external）に表示中のメッシュが 1 つ以上あるか（すべて非表示・空のデータなら false） */
export function externalHasVisibleMesh(viewer: Viewer): boolean {
  let has = false;
  viewer.groups.external.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.visible) has = true;
  });
  return has;
}

/**
 * 外部の正確な建物（groups.external）が PDF の建物に代わって影を落とすか:
 * userData.externalReplaces かつ 日照ステップ表示中（userData.externalMounted）かつ 表示中のメッシュがある。
 * 他のステップ（デザイン・ウォークスルー・提案資料）では、見えている PDF の建物が壁判定・見どころ・影を担う。
 * 日照ステップ外で 3DS を使いたい解析は buildOccluder に external: true を渡す
 */
export function externalReplacesBuilding(viewer: Viewer): boolean {
  if (viewer.userData.externalReplaces !== true) return false;
  if (viewer.userData.externalMounted !== true) return false;
  return externalHasVisibleMesh(viewer);
}

/**
 * 既存アプリ: 影を落とす物体を 1 つの BVH にまとめる。
 * 外部の建物（3DS）が置き換え中なら、建物の種別 'building' は groups.external だけ（PDF の建物・屋根は焼き込まない）。
 * opts.external: true なら日照ステップ表示中でなくても 3DS を使う（表示中のメッシュがあるとき。提案資料の解析など）、
 * false なら 3DS を使わない、省略時は externalReplacesBuilding（日照ステップ表示中の置き換え）に従う
 */
export function buildOccluder(viewer: Viewer, opts: { context?: boolean; trees?: boolean; buildingOnly?: boolean; furniture?: boolean; external?: boolean } = {}): Occluder {
  const useExternal = opts.external === true ? externalHasVisibleMesh(viewer) : opts.external === false ? false : externalReplacesBuilding(viewer);
  const parts: OccluderPart[] = useExternal
    ? [{ root: viewer.groups.external, kind: 'building' }]
    : [
        { root: viewer.groups.building, kind: 'building' },
        { root: viewer.groups.roof, kind: 'building' },
      ];
  const filters = new Map<THREE.Object3D, (m: THREE.Mesh) => boolean>();
  if (opts.furniture) parts.push({ root: viewer.groups.furniture, kind: 'furniture' });
  if (!opts.buildingOnly) {
    if (opts.context !== false) {
      parts.push({ root: viewer.groups.context, kind: 'neighbor' });
      filters.set(viewer.groups.context, (m) => !!m.userData.neighbor);
    }
    if (opts.trees) {
      parts.push({ root: viewer.groups.landscape, kind: 'tree' });
      filters.set(viewer.groups.landscape, (m) => (m.userData.matKey ?? '').startsWith('l.leaf') || m.userData.matKey === 'l.trunk');
    }
  }
  // root ごとに別のフィルタ: メッシュの祖先からどの root に属するかを調べる
  const rootOf = (m: THREE.Object3D): THREE.Object3D | null => {
    let p: THREE.Object3D | null = m;
    while (p) {
      if (filters.has(p)) return p;
      p = p.parent;
    }
    return null;
  };
  const filter = filters.size ? (m: THREE.Mesh) => {
    const r = rootOf(m);
    return r ? filters.get(r)!(m) : true;
  } : undefined;
  // 既存の挙動: 各メッシュ自身の visible だけを見る（グループの表示切替は影響しない）
  return buildOccluderFrom(parts, filter, { ancestors: false });
}

const _ray = new THREE.Ray();

function hitAny(occ: Occluder, far: number): boolean {
  if (occ.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, far)) return true;
  if (occ.extra) for (const e of occ.extra) if (hitAny(e, far)) return true;
  return false;
}

/** p から dir へ 2cm 進めた点を始点に、太陽方向に遮蔽物があるか（occ.extra も判定） */
export function isShaded(occ: Occluder, p: THREE.Vector3, dir: THREE.Vector3, far = 2000): boolean {
  _ray.origin.copy(p).addScaledVector(dir, 0.02);
  _ray.direction.copy(dir);
  return hitAny(occ, far);
}

/** origin をそのまま始点にして判定する（始点のずらし方を呼び出し側で決める場合） */
export function isShadedFrom(occ: Occluder, origin: THREE.Vector3, dir: THREE.Vector3, far = 2000): boolean {
  _ray.origin.copy(origin);
  _ray.direction.copy(dir);
  return hitAny(occ, far);
}

/** 複数の遮蔽物のいずれかに当たるか（小さいものを先に並べると速い） */
export function isShadedMulti(occs: Occluder[], p: THREE.Vector3, dir: THREE.Vector3, far = 2000): boolean {
  _ray.origin.copy(p).addScaledVector(dir, 0.02);
  _ray.direction.copy(dir);
  for (const o of occs) if (hitAny(o, far)) return true;
  return false;
}

export interface KindHit {
  distance: number;
  point: THREE.Vector3;
  kind: string;
}

/** origin から dir へ最初に当たる三角形（occ.extra も含めて最も近いもの）とその種別 */
export function raycastFirstKind(occ: Occluder, origin: THREE.Vector3, dir: THREE.Vector3, far = 2000): KindHit | null {
  _ray.origin.copy(origin);
  _ray.direction.copy(dir);
  let best: KindHit | null = null;
  const visit = (o: Occluder) => {
    const hit = o.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, best ? best.distance : far);
    if (hit && (!best || hit.distance < best.distance)) best = { distance: hit.distance, point: hit.point.clone(), kind: o.kindOf(hit.faceIndex ?? -1) };
    if (o.extra) for (const e of o.extra) visit(e);
  };
  visit(occ);
  return best;
}

/** BVH の geometry を解放する（extra は解放しない: キャッシュされた地形など） */
export function disposeOccluder(occ: Occluder) {
  occ.mesh.geometry.dispose();
}

// ---------------------------------------------------------------------------
// 太陽方向の時刻表
// ---------------------------------------------------------------------------

export interface SunDay {
  year: number;
  month: number;
  day: number;
  lat: number;
  lon: number;
  northAngleDeg: number;
}

export interface SunSample {
  /** ローカル時刻 (h, JST) */
  h: number;
  dir: THREE.Vector3;
  /** 高度 (度) */
  elev: number;
  /** 方位 (度, 真北から時計回り) */
  az: number;
}

/**
 * 1 日の太陽方向の時刻表。
 *  from/to: 範囲 (h)。省略時は日の出〜日の入
 *  centered: true なら from + step/2 から step ごと（格子の積算向け）。false なら step の倍数の時刻（from 以上 to 以下）
 *  minElev: この高度 (度) 以下の時刻は除く（既定 0.5）
 */
export function sunSamplesForDay(day: SunDay, opts: { from?: number; to?: number; stepMin: number; minElev?: number; centered?: boolean }): SunSample[] {
  const step = opts.stepMin / 60;
  const needRs = opts.from === undefined || opts.to === undefined;
  const rs = needRs ? sunriseSunset(day.year, day.month, day.day, day.lat, day.lon) : null;
  const from = opts.from ?? rs!.sunrise;
  const to = opts.to ?? rs!.sunset;
  const minElev = opts.minElev ?? 0.5;
  const out: SunSample[] = [];
  const push = (h: number) => {
    const sp = sunPosition(localDate(day.year, day.month, day.day, h), day.lat, day.lon);
    if (sp.elevation <= minElev) return;
    out.push({ h, dir: sunDirectionWorld(sp.azimuth, sp.elevation, day.northAngleDeg), elev: sp.elevation, az: sp.azimuth });
  };
  if (opts.centered) {
    for (let h = from + step / 2; h < to; h += step) push(h);
  } else {
    for (let h = Math.ceil(from / step) * step; h <= to; h += step) push(h);
  }
  return out;
}

export async function yieldUI() {
  await new Promise((r) => setTimeout(r, 0));
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('中断しました', 'AbortError');
}

// ---------------------------------------------------------------------------
// 部屋ごとの日当たり（既存アプリ）
// ---------------------------------------------------------------------------

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

/**
 * 部屋ごとの日当たり（PDF の部屋の床面に測定点を置く）。
 * opts.sampleY(x, z, floorY): 測定点の高さを決める（省略時 floorY + 0.03）。外部の建物（3DS）で置き換えているときに、
 * 3DS 自身の床の上から測るために使う。
 * opts.external: 外部の建物（3DS）を PDF の建物の代わりに使うか（buildOccluder と同じ。省略時は日照ステップ表示中の置き換えに従う）
 */
export async function analyzeRooms(viewer: Viewer, day: SunDay, opts: { stepMin?: number; spacing?: number; onProgress?: (r: number) => void; sampleY?: (x: number, z: number, floorY: number) => number; external?: boolean } = {}): Promise<RoomSunResult[]> {
  const st = viewer.state!;
  const model: BuildingModel = st.model;
  void model;
  const occ = buildOccluder(viewer, { context: true, trees: false, external: opts.external });
  const step = (opts.stepMin ?? 10) / 60;
  const spacing = opts.spacing ?? 0.35;
  const times = sunSamplesForDay(day, { stepMin: opts.stepMin ?? 10, minElev: 0.5, centered: false });
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
        if (!nearEdge) pts.push(new THREE.Vector3(x, opts.sampleY ? opts.sampleY(x, z, ri.floorY) : ri.floorY + 0.03, z));
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
  disposeOccluder(occ);
  return out;
}

// ---------------------------------------------------------------------------
// 格子の日照時間
// ---------------------------------------------------------------------------

export interface GridResult {
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  values: Float32Array;
}

export interface GridRect {
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
}

/**
 * 格子の各セル中心（高さ heightAt(x, z)）で、samples の各時刻に日が当たるかを判定し、当たった時間 (h) を返す。
 *  stepHours: 1 サンプルの重み (h)
 *  exactOrigin: true なら heightAt の点をそのまま始点にする（isShadedFrom）。false（既定）なら太陽方向に 2cm ずらす（isShaded）
 */
export async function sunHoursGrid(
  occ: Occluder,
  samples: SunSample[],
  rect: GridRect,
  heightAt: (x: number, z: number) => number,
  opts: { onProgress?: (r: number) => void; signal?: AbortSignal; stepHours: number; exactOrigin?: boolean },
): Promise<GridResult> {
  const { x0, z0, cell, nx, nz } = rect;
  const values = new Float32Array(nx * nz);
  const p = new THREE.Vector3();
  const test = opts.exactOrigin ? isShadedFrom : isShaded;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * cell;
      const z = z0 + (j + 0.5) * cell;
      p.set(x, heightAt(x, z), z);
      let lit = 0;
      for (const s of samples) if (!test(occ, p, s.dir)) lit++;
      values[j * nx + i] = lit * opts.stepHours;
    }
    if (j % 8 === 0) {
      opts.onProgress?.(j / nz);
      await yieldUI();
      throwIfAborted(opts.signal);
    }
  }
  return { x0, z0, cell, nx, nz, values };
}

/**
 * 既存アプリ: 地面の日照時間マップ（指定した時間帯, h 単位）。opts.center で格子の中心を指定できる（省略時は PDF の建物の中心）。
 * opts.external: 外部の建物（3DS）を PDF の建物の代わりに使うか（buildOccluder と同じ。省略時は日照ステップ表示中の置き換えに従う）
 */
export async function groundSunHours(viewer: Viewer, day: SunDay, opts: { from?: number; to?: number; stepMin?: number; cell?: number; half?: number; height?: number; center?: { x: number; z: number }; onProgress?: (r: number) => void; external?: boolean } = {}): Promise<GridResult> {
  const st = viewer.state!;
  const occ = buildOccluder(viewer, { context: true, trees: true, external: opts.external });
  const c = opts.center ? new THREE.Vector3(opts.center.x, 0, opts.center.z) : st.meta.bbox.getCenter(new THREE.Vector3());
  const half = opts.half ?? 22;
  const cell = opts.cell ?? 0.5;
  const nx = Math.ceil((half * 2) / cell);
  const nz = nx;
  const stepMin = opts.stepMin ?? 15;
  const samples = sunSamplesForDay(day, { from: opts.from, to: opts.to, stepMin, minElev: 0.5, centered: true });
  const y = opts.height ?? 0.05;
  const g = await sunHoursGrid(occ, samples, { x0: c.x - half, z0: c.z - half, cell, nx, nz }, () => y, { onProgress: opts.onProgress, stepHours: stepMin / 60 });
  disposeOccluder(occ);
  return g;
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
// 2D の補助（等値線・多角形）
// ---------------------------------------------------------------------------

export type Segment = [number, number, number, number];

/** マーチングスクエア（格子座標の線分。i, j はセル番号で、中心は +0.5） */
export function marchingSegments(values: Float32Array, nx: number, nz: number, level: number): Segment[] {
  const segs: Segment[] = [];
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

export interface Polyline {
  points: { x: number; y: number }[];
  closed: boolean;
}

/** 線分の端点をつないで折れ線にする（端点は eps で丸めて一致を判定） */
export function segmentsToPolylines(segs: Segment[], eps = 1e-6): Polyline[] {
  const key = (x: number, y: number) => `${Math.round(x / eps)},${Math.round(y / eps)}`;
  const used = new Uint8Array(segs.length);
  const byPoint = new Map<string, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    for (const k of [key(s[0], s[1]), key(s[2], s[3])]) {
      const l = byPoint.get(k);
      if (l) l.push(i);
      else byPoint.set(k, [i]);
    }
  }
  const takeFrom = (k: string, exclude: number): number => {
    const l = byPoint.get(k);
    if (!l) return -1;
    for (const i of l) if (!used[i] && i !== exclude) return i;
    return -1;
  };
  const out: Polyline[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const s = segs[i];
    const pts: { x: number; y: number }[] = [
      { x: s[0], y: s[1] },
      { x: s[2], y: s[3] },
    ];
    // 前方へ伸ばす
    const extend = (forward: boolean) => {
      for (;;) {
        const end = forward ? pts[pts.length - 1] : pts[0];
        const k = key(end.x, end.y);
        const j = takeFrom(k, -1);
        if (j < 0) return;
        used[j] = 1;
        const t = segs[j];
        const sameStart = key(t[0], t[1]) === k;
        const next = sameStart ? { x: t[2], y: t[3] } : { x: t[0], y: t[1] };
        if (forward) pts.push(next);
        else pts.unshift(next);
      }
    };
    extend(true);
    extend(false);
    const closed = pts.length > 2 && key(pts[0].x, pts[0].y) === key(pts[pts.length - 1].x, pts[pts.length - 1].y);
    if (closed) pts.pop();
    out.push({ points: pts, closed });
  }
  return out;
}

export interface Pt2 {
  x: number;
  y: number;
}

function signedArea(poly: Pt2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function bboxOf(poly: Pt2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** 矩形 [min, (max.x,min.y), max, (min.x,max.y)] */
export function rectPolygon(minX: number, minY: number, maxX: number, maxY: number): Pt2[] {
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

function segmentsIntersect(a: Pt2, b: Pt2, c: Pt2, d: Pt2): boolean {
  const cross = (o: Pt2, p: Pt2, q: Pt2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 単純多角形か（隣り合わない辺が交差しない） */
export function isSimplePolygon(poly: Pt2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  return true;
}

/**
 * 多角形を外側へ d だけオフセットする（各辺を法線方向に平行移動し、隣の辺との交点を頂点にする）。
 * 矩形なら各辺を d 広げた矩形になる。頂点が 3 未満・自己交差・オフセット結果が壊れる（凹みが深い）ときは
 * 外接矩形を d 広げた矩形に退避する。
 */
export function offsetPolygon(polyIn: Pt2[], d: number): Pt2[] {
  // 重複点・閉じ点を除く
  const poly: Pt2[] = [];
  for (const p of polyIn) {
    const q = poly[poly.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-9) poly.push({ x: p.x, y: p.y });
  }
  if (poly.length > 1 && Math.hypot(poly[0].x - poly[poly.length - 1].x, poly[0].y - poly[poly.length - 1].y) < 1e-9) poly.pop();
  const bb = bboxOf(polyIn.length ? polyIn : [{ x: 0, y: 0 }]);
  const fallback = () => rectPolygon(bb.minX - d, bb.minY - d, bb.maxX + d, bb.maxY + d);
  if (poly.length < 3 || !isSimplePolygon(poly)) return fallback();
  const area = signedArea(poly);
  if (Math.abs(area) < 1e-9) return fallback();
  const sign = area > 0 ? 1 : -1; // 外向き法線: 面積が正なら (dy, -dx)、負なら (-dy, dx)
  const n = poly.length;
  // 各辺のオフセット線（点 + 方向）
  const lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const l = Math.hypot(dx, dy) || 1;
    const nx = (sign * dy) / l;
    const ny = (-sign * dx) / l;
    return { px: p.x + nx * d, py: p.y + ny * d, dx, dy };
  });
  const out: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const a = lines[(i - 1 + n) % n]; // 頂点 i に入る辺
    const b = lines[i]; // 頂点 i から出る辺
    const det = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(det) < 1e-12) {
      // 平行（直線上の頂点）: 法線方向にそのまま
      out.push({ x: b.px, y: b.py });
      continue;
    }
    const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / det;
    out.push({ x: a.px + a.dx * t, y: a.py + a.dy * t });
  }
  // 結果が壊れていれば退避
  if (!isSimplePolygon(out) || Math.sign(signedArea(out)) !== sign || Math.abs(signedArea(out)) < Math.abs(area)) return fallback();
  return out;
}

/** 点から多角形への距離（内部なら 0） */
export function distanceToPolygon(p: Pt2, poly: Pt2[]): number {
  if (poly.length >= 3 && pointInPolygon(p, poly)) return 0;
  let best = Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y));
  }
  return Number.isFinite(best) ? best : 0;
}

// ---------------------------------------------------------------------------
// 日影図
// ---------------------------------------------------------------------------

export interface ShadowDiagram {
  svg: string;
  /** 等時間日影線の最大到達距離（敷地境界から, m） */
  summary: { hour: number; maxDist: number }[];
  /** 描いた範囲（ワールド） */
  extent: { x0: number; z0: number; half: number; cell: number };
}

/** 日影図に描く輪郭。{x,y}[] は閉じた輪郭（塗りなし） */
export type ShadowOutline = Pt2[] | { points: Pt2[]; fill?: boolean; closed?: boolean };

export interface ShadowDiagramParams {
  occ: Occluder;
  lat: number;
  lon: number;
  northAngleDeg: number;
  year: number;
  /** 測定面の高さ (m)。1.5 / 4.0 / 6.5 など */
  planeHeight: number;
  /** 測定面の表記（例 '1.5'。省略時は planeHeight をそのまま表示）。測定面を平均地盤面基準で渡すときに使う */
  planeLabel?: string;
  /** 図の中心（ワールド XZ） */
  center: { x: number; z: number };
  /** 中心からの範囲 (m)。省略時 34。autoExtent があれば max(half, 建物の影の長さ + 6) */
  half?: number;
  /** 建物の最高高さ (m) から範囲を自動で決める */
  autoExtent?: { buildingTop: number };
  /** 格子 (m)。省略時 0.3 */
  cell?: number;
  /** 粗い時間刻み (分)。省略時 10 */
  stepMin?: number;
  /** 真太陽時の範囲 (h)。省略時 [8, 16]（北海道は [9, 15]） */
  hours?: [number, number];
  /** 等時間日影線を描く時間 (h)。省略時 [2, 3, 4, 5] */
  levels?: number[];
  /** 建物の内部か（内部は対象外として最大値にする） */
  insideBuilding: (x: number, z: number) => boolean;
  /** 建物の輪郭（ワールド XZ, x→x, z→y） */
  outlines: ShadowOutline[];
  /**
   * 敷地境界（ワールド XZ の多角形。矩形は 4 点）。
   * 省略時（null/undefined）は敷地境界・5m/10m ラインを描かず、summary.maxDist は建物の輪郭からの距離になる
   */
  site?: { polygon: Pt2[] } | null;
  /** 凡例に付ける注記（'※周辺建物を含みます' など） */
  note?: string;
  /** 副題。省略時は '建物の位置・方位は航空写真上での手動配置によるものです'、null なら描かない */
  subtitle?: string | null;
  /** 斜めの薄い透かし文字。省略時は '参考図（簡易シミュレーション）／建築確認申請用の日影図ではありません'、null なら描かない */
  watermark?: string | null;
  onProgress?: (r: number) => void;
  signal?: AbortSignal;
}

export const SHADOW_DIAGRAM_SUBTITLE = '建物の位置・方位は航空写真上での手動配置によるものです';
export const SHADOW_DIAGRAM_WATERMARK = '参考図（簡易シミュレーション）／建築確認申請用の日影図ではありません';
export const SHADOW_DIAGRAM_NO_SITE_NOTE = '敷地境界が未指定のため 5m/10m ラインは省略しています';

/** 遮蔽状態の遷移を二分探索する細かさ（1 刻みを 2^REFINE に分ける: 10 分刻み・5 回 → 18.75 秒） */
const REFINE = 5;

/**
 * 日影図（冬至日・真太陽時）。
 * 各セルについて粗い刻み（stepMin）で日影かを判定し、隣り合う刻みで状態が変わる区間は時刻を二分探索して
 * 遷移時刻を求め、日影の時間を正確に積算する（等時間日影線が刻み幅で動かないように）。時刻日影線は毎正時の判定。
 */
export async function shadowDiagramCore(p: ShadowDiagramParams): Promise<ShadowDiagram> {
  const { occ, lat, lon, planeHeight } = p;
  const Y = p.year;
  const M = 12;
  const D = 22;
  const stepMin = p.stepMin ?? 10;
  const [H0, H1] = p.hours ?? [8, 16];
  const span = H1 - H0;
  const levels = p.levels ?? [2, 3, 4, 5];
  const nCoarse = Math.round((span * 60) / stepMin);
  const fine = 1 << REFINE;
  const nFine = nCoarse * fine;
  const fineStep = stepMin / 60 / fine;
  // 細かい刻みの太陽方向（二分探索で使う）。粗い刻み k は細かい刻み k*fine
  const dirAt = (s: number) => {
    const lh = trueSolarToLocal(Y, M, D, s, lon);
    const sp = sunPosition(localDate(Y, M, D, lh), lat, lon);
    return { s, dir: sunDirectionWorld(sp.azimuth, sp.elevation, p.northAngleDeg), elev: sp.elevation };
  };
  const fineDirs: { s: number; dir: THREE.Vector3; elev: number }[] = [];
  for (let f = 0; f <= nFine; f++) fineDirs.push(dirAt(H0 + f * fineStep));
  const coarse = (k: number) => fineDirs[k * fine];
  // 範囲
  let half = p.half ?? 34;
  if (p.autoExtent) {
    let minElev = Infinity;
    for (let k = 0; k <= nCoarse; k++) if (coarse(k).elev > 0) minElev = Math.min(minElev, coarse(k).elev);
    if (Number.isFinite(minElev) && minElev > 0.5) {
      const len = Math.max(0, p.autoExtent.buildingTop - planeHeight) / Math.tan((minElev * Math.PI) / 180) + 6;
      half = Math.max(half, len);
    }
  }
  const cell = p.cell ?? 0.3;
  const nx = Math.ceil((half * 2) / cell);
  const nz = nx;
  const c = p.center;
  const x0 = c.x - half;
  const z0 = c.z - half;
  const count = new Float32Array(nx * nz);
  const hourMasks = new Map<number, Float32Array>();
  for (let s = Math.ceil(H0); s <= H1; s++) hourMasks.set(s, new Float32Array(nx * nz));
  const pt = new THREE.Vector3();
  const states = new Uint8Array(nCoarse + 1);
  const shadedAt = (f: number) => {
    const d = fineDirs[f];
    return d.elev <= 0 || isShaded(occ, pt, d.dir);
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      pt.set(x0 + (i + 0.5) * cell, planeHeight, z0 + (j + 0.5) * cell);
      const idx = j * nx + i;
      if (p.insideBuilding(pt.x, pt.z)) {
        // 建物内部は日影図の対象外（等時間線が内部に出ないよう最大値に）
        count[idx] = span;
        for (const m of hourMasks.values()) m[idx] = 1;
        continue;
      }
      for (let k = 0; k <= nCoarse; k++) {
        const sh = shadedAt(k * fine);
        states[k] = sh ? 1 : 0;
        const hr = coarse(k).s;
        if (Math.abs(hr - Math.round(hr)) < 1e-6 && hourMasks.has(Math.round(hr))) hourMasks.get(Math.round(hr))![idx] = sh ? 1 : 0;
      }
      // 区間ごとに日影の時間を積算。状態が変わる区間は遷移時刻を二分探索
      let shaded = 0;
      for (let k = 0; k < nCoarse; k++) {
        const a = states[k];
        const b = states[k + 1];
        if (a === b) {
          if (a) shaded += stepMin / 60;
          continue;
        }
        // lo は状態 a、hi は状態 b。a→b が変わる最初の細かい刻みを探す
        let lo = k * fine;
        let hi = (k + 1) * fine;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if ((shadedAt(mid) ? 1 : 0) === a) lo = mid;
          else hi = mid;
        }
        const tA = (hi - k * fine) * fineStep; // 状態 a が続いた時間
        shaded += a ? tA : stepMin / 60 - tA;
      }
      count[idx] = shaded;
    }
    if (j % 10 === 0) {
      p.onProgress?.(j / nz);
      await yieldUI();
      throwIfAborted(p.signal);
    }
  }

  // ---- SVG ----
  const S = 100; // 1m = 100 単位
  const toX = (gi: number) => (x0 + gi * cell) * S;
  const toY = (gj: number) => (z0 + gj * cell) * S;
  const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
  const ptsAttr = (poly: Pt2[]) => poly.map((q) => `${fmt(q.x * S)},${fmt(q.y * S)}`).join(' ');
  let body = '';
  // 敷地（指定があるときだけ。無ければ 5m/10m ラインも省く）
  const sitePoly = p.site && p.site.polygon.length >= 3 ? p.site.polygon : null;
  if (sitePoly) {
    body += `<polygon points="${ptsAttr(sitePoly)}" fill="none" stroke="#333" stroke-width="12" stroke-dasharray="60 25 10 25"/>`;
    // 5m・10m ライン（敷地境界から）
    for (const [d, col] of [
      [5, '#9a9a9a'],
      [10, '#bdbdbd'],
    ] as const) {
      const off = offsetPolygon(sitePoly, d);
      const bb = bboxOf(off);
      body += `<polygon points="${ptsAttr(off)}" fill="none" stroke="${col}" stroke-width="8" stroke-dasharray="30 20"/>`;
      body += `<text x="${fmt(bb.maxX * S + 20)}" y="${fmt(bb.minY * S + 60)}" font-size="70" fill="${col}">${d}mライン</text>`;
    }
  }
  // summary.maxDist の基準: 敷地境界。無ければ建物の輪郭（閉じた多角形）、それも無ければ図の中心
  const refPolys: Pt2[][] = sitePoly
    ? [sitePoly]
    : p.outlines.map((o) => (Array.isArray(o) ? o : o.closed === false ? [] : o.points)).filter((poly) => poly.length >= 3);
  const distFromRef = (X: number, Z: number) => {
    if (!refPolys.length) return Math.hypot(X - c.x, Z - c.z);
    let best = Infinity;
    for (const poly of refPolys) best = Math.min(best, distanceToPolygon({ x: X, y: Z }, poly));
    return best;
  };
  // 建物の輪郭
  for (const o of p.outlines) {
    const ol = Array.isArray(o) ? { points: o, fill: false, closed: true } : o;
    if (ol.points.length < 2) continue;
    const closed = ol.closed !== false;
    const tag = closed ? 'polygon' : 'polyline';
    body += `<${tag} points="${ptsAttr(ol.points)}" fill="${ol.fill && closed ? '#555' : 'none'}" stroke="#222" stroke-width="10" fill-opacity="0.35"/>`;
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
    if (far) body += `<text x="${fmt(far[0] * S)}" y="${fmt(far[1] * S)}" font-size="80" fill="#3b7dd8" font-weight="bold">${h}時</text>`;
  }
  // 等時間日影線
  const summary: { hour: number; maxDist: number }[] = [];
  const eqCols: Record<number, string> = { 1: '#f39c12', 2: '#e67e22', 3: '#d35400', 4: '#c0392b', 5: '#8e44ad', 6: '#6c3483' };
  for (const hh of levels) {
    const segs = marchingSegments(count, nx, nz, hh);
    const col = eqCols[hh] ?? '#8e44ad';
    const d = segs.map(([a, b, cc, dd]) => `M${toX(a + 0.5).toFixed(0)} ${toY(b + 0.5).toFixed(0)}L${toX(cc + 0.5).toFixed(0)} ${toY(dd + 0.5).toFixed(0)}`).join('');
    body += `<path d="${d}" stroke="${col}" stroke-width="14" fill="none"/>`;
    let maxDist = 0;
    let lab: [number, number] | null = null;
    for (const [a, b] of segs) {
      const X = x0 + (a + 0.5) * cell;
      const Z = z0 + (b + 0.5) * cell;
      // 敷地境界（無ければ建物の輪郭）からの距離
      const dist = distFromRef(X, Z);
      if (dist > maxDist) {
        maxDist = dist;
        lab = [X, Z];
      }
    }
    summary.push({ hour: hh, maxDist });
    if (lab) body += `<text x="${fmt(lab[0] * S + 30)}" y="${fmt(lab[1] * S - 20)}" font-size="90" fill="${col}" font-weight="bold">${hh}時間</text>`;
  }
  // 方位
  const nA = p.northAngleDeg;
  const ax = (x0 + half * 2 - 3) * S;
  const ay = (z0 + 3) * S;
  body += `<g transform="translate(${fmt(ax)} ${fmt(ay)}) rotate(${nA})"><circle r="150" fill="#fff" stroke="#333" stroke-width="10"/><path d="M0 -160 L50 90 L0 50 L-50 90Z" fill="#333"/><text y="-190" font-size="110" text-anchor="middle" font-weight="bold">N</text></g>`;
  // 透かし（薄い灰色の斜め文字。図の中央）
  const watermark = p.watermark === undefined ? SHADOW_DIAGRAM_WATERMARK : p.watermark;
  if (watermark) {
    const fs = Math.max(60, Math.round((half * 2 * S) / 42));
    body += `<text transform="translate(${fmt(c.x * S)} ${fmt(c.z * S)}) rotate(-30)" text-anchor="middle" font-size="${fs}" fill="#9a9a9a" opacity="0.35" font-weight="bold" pointer-events="none">${watermark}</text>`;
  }
  // 題名: 真太陽時と、この場所での JST（均時差・経度差を含む）
  const subtitle = p.subtitle === undefined ? SHADOW_DIAGRAM_SUBTITLE : p.subtitle;
  const jst0 = formatHM(trueSolarToLocal(Y, M, D, H0, lon));
  const jst1 = formatHM(trueSolarToLocal(Y, M, D, H1, lon));
  const title = `日影図（冬至日 真太陽時 ${formatHM(H0)}〜${formatHM(H1)} ＝ この場所では JST ${jst0}〜${jst1} ／ 測定面 GL+${p.planeLabel ?? String(planeHeight)}m）`;
  const siteText = sitePoly ? '点線: 敷地境界・5m/10mライン' : SHADOW_DIAGRAM_NO_SITE_NOTE;
  const legendText = `青線: 時刻日影線（毎正時）　橙〜紫: 等時間日影線（${levels.join('・')}時間）　${siteText}${p.note ? `　${p.note}` : ''}`;
  const top = z0 * S - (subtitle ? 330 : 250);
  const bottom = (z0 + half * 2) * S + 250;
  const legend =
    `<text x="${fmt(x0 * S + 60)}" y="${fmt(z0 * S - (subtitle ? 200 : 120))}" font-size="110" font-weight="bold" fill="#222">${title}</text>` +
    (subtitle ? `<text x="${fmt(x0 * S + 60)}" y="${fmt(z0 * S - 80)}" font-size="70" fill="#777">${subtitle}</text>` : '') +
    `<text x="${fmt(x0 * S + 60)}" y="${fmt((z0 + half * 2) * S + 180)}" font-size="75" fill="#555">${legendText}</text>`;
  const vb = `${fmt(x0 * S)} ${fmt(top)} ${fmt(half * 2 * S)} ${fmt(bottom - top)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" font-family="'Noto Sans JP','Hiragino Sans',sans-serif"><rect x="${fmt(x0 * S)}" y="${fmt(top)}" width="${fmt(half * 2 * S)}" height="${fmt(bottom - top)}" fill="#fff"/>${body}${legend}</svg>`;
  return { svg, summary, extent: { x0, z0, half, cell } };
}

/** shadowDiagram の上書き: 外部の建物（3DS）で置き換えているときに、その輪郭・中心を使う */
export interface ShadowDiagramOverrides {
  /** 建物の輪郭（ワールド XZ）。省略時は PDF の各階外形 */
  outlines?: THREE.Vector2[][];
  /** 建物の内部か。省略時は PDF の 1 階外形の内側 */
  insideBuilding?: (x: number, z: number) => boolean;
  /** 図の中心（ワールド XZ）。省略時は PDF の bbox 中心 */
  center?: THREE.Vector2;
  /** 建物の最高高さ (m)。与えると影の長さから図の範囲を広げる */
  buildingTop?: number;
  /** 外部の建物（3DS）を PDF の建物の代わりに使うか（buildOccluder と同じ。省略時は日照ステップ表示中の置き換えに従う） */
  external?: boolean;
}

/**
 * 既存アプリ: 日影図（冬至日・真太陽時 8〜16 時）
 * planeHeight: 測定面の高さ (m)。1.5 / 4.0 など
 */
export async function shadowDiagram(viewer: Viewer, loc: { lat: number; lon: number; northAngleDeg: number; year: number }, planeHeight = 1.5, onProgress?: (r: number) => void, over: ShadowDiagramOverrides = {}): Promise<ShadowDiagram> {
  const st = viewer.state!;
  const occ = buildOccluder(viewer, { buildingOnly: true, external: over.external });
  const c = over.center ? new THREE.Vector3(over.center.x, 0, over.center.y) : st.meta.bbox.getCenter(new THREE.Vector3());
  const footprints = st.meta.outlines.map((o) => o.polys.map((poly) => poly.map((q) => ({ x: q.x, y: q.y }))));
  const outlines: ShadowOutline[] = [];
  if (over.outlines) for (const poly of over.outlines) outlines.push({ points: poly.map((q) => ({ x: q.x, y: q.y })), fill: true });
  else for (const o of st.meta.outlines) for (const poly of o.polys) outlines.push({ points: poly.map((q) => ({ x: q.x, y: q.y })), fill: o.level === 1 });
  const insideBuilding = over.insideBuilding ?? ((x: number, z: number) => footprints.some((loops) => insideLoops({ x, y: z }, loops)));
  const site = st.site;
  const r = await shadowDiagramCore({
    occ,
    lat: loc.lat,
    lon: loc.lon,
    northAngleDeg: loc.northAngleDeg,
    year: loc.year,
    planeHeight,
    center: { x: c.x, z: c.z },
    half: 34,
    autoExtent: over.buildingTop ? { buildingTop: over.buildingTop } : undefined,
    cell: 0.3,
    stepMin: 10,
    insideBuilding,
    outlines,
    site: { polygon: rectPolygon(site.min.x, site.min.y, site.max.x, site.max.y) },
    note: '※周辺建物は含みません',
    // 既存アプリは図面の方位記号と住所から配置するので「航空写真上での手動配置」の副題は付けない
    subtitle: null,
    onProgress,
  });
  disposeOccluder(occ);
  return r;
}
