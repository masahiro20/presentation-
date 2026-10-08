/**
 * 日照解析（BVH による高速レイキャスト）
 *
 * 汎用コア（Viewer に依存しない）
 *  - buildOccluderFrom / bakeWorldTriangles: 任意の Object3D 群からワールド座標の三角形を焼き込み、1 つの BVH にする
 *    （root ごとに種別 kind を付け、レイキャストの faceIndex から種別を引ける）
 *  - isShaded / isShadedFrom / isShadedMulti / raycastFirstKind: 遮蔽判定
 *  - sunSamplesForDay: 1 日の太陽方向の時刻表
 *  - sunHoursGrid: 格子の日照時間
 *  - shadowDiagramCore: 日影図（時刻日影線・等時間日影線・規制時間の強調・5m/10m ライン）の SVG
 *  - shadowDiagramExtent / shadowDiagramCell / shadowDiagramGrid: 日影図の範囲（建物と影が届く範囲を囲む長方形、中心から最大 400m）と
 *    格子（格子数・レイキャスト数の上限内）
 *  - marchingSegments / segmentsToPolylines / offsetPolygon / offsetRegion / distanceToPolygon（実体は offset.ts）/ yieldUI / heatColor
 *  - 規制時間のプリセット SHADOW_REGULATION_PRESETS（実体は shadowRegulation.ts）
 *
 * 既存アプリ（Viewer）用のラッパー: buildOccluder / analyzeRooms / groundSunHours / heatmapMesh / shadowDiagram
 * （shadowDiagram 以外の結果は以前の実装と同じ。shadowDiagram は範囲・冬至日・5m/10m ライン・窓ガラスの扱いを直した）
 */
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Viewer } from '../scene/viewer';
import type { BuildingModel, Room } from '../core/types';
import { isHabitable } from '../core/types';
import { pointInPolygon, insideLoops } from '../core/geometry';
import { sunPosition, sunDirectionWorld, localDate, sunriseSunset, trueSolarToLocal, formatHM, winterSolstice } from './solar';
import { bboxOf, distanceToPolygon, marchingSegments, offsetRegion, rectPolygon, segmentsToPolylines, type Pt2, type Segment } from './offset';
import { DEFAULT_SHADOW_LEVELS, type ShadowRegulation } from './shadowRegulation';

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

/** 窓ガラス（既存アプリの PDF の建物のガラス matKey、読み込んだ 3D データのガラス userData.glass） */
function isGlassMesh(m: THREE.Mesh): boolean {
  return ((m.userData.matKey as string | undefined) ?? '').startsWith('ext.glass') || m.userData.glass === true;
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
 *  - opts.opaqueGlass: 窓ガラス（isGlassMesh）も不透明として焼き込む（日影図: 建物は中身の詰まった塊として影を落とし、
 *    窓から窓へ抜ける光で影の中に日向の点ができないように）
 */
export function bakeWorldTriangles(roots: THREE.Object3D[] | OccluderPart[], filter?: (m: THREE.Mesh) => boolean, opts: { ancestors?: boolean; ignoreVisibility?: boolean; opaqueGlass?: boolean } = {}): BakedTriangles {
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
      const glass = !!opts.opaqueGlass && isGlassMesh(m);
      if (m.userData.noShadow && !glass) return;
      if (filter && !filter(m)) return;
      if (excludedMatKey(m) && !glass) return;
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
export function buildOccluderFrom(roots: THREE.Object3D[] | OccluderPart[], filter?: (m: THREE.Mesh) => boolean, opts: { ancestors?: boolean; ignoreVisibility?: boolean; opaqueGlass?: boolean } = {}): Occluder {
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
 * false なら 3DS を使わない、省略時は externalReplacesBuilding（日照ステップ表示中の置き換え）に従う。
 * opts.opaqueGlass: 窓ガラスも影を落とす（日影図）。省略時はガラスは光を通す（部屋の日当たり・実時間の影）
 */
export function buildOccluder(viewer: Viewer, opts: { context?: boolean; trees?: boolean; buildingOnly?: boolean; furniture?: boolean; external?: boolean; opaqueGlass?: boolean } = {}): Occluder {
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
  return buildOccluderFrom(parts, filter, { ancestors: false, opaqueGlass: opts.opaqueGlass });
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
// 2D の補助（等値線・多角形）: 実体は src/sun/offset.ts（three.js に依存しない）
// ---------------------------------------------------------------------------

export { marchingSegments, segmentsToPolylines, offsetPolygon, offsetRegion, distanceToPolygon, isSimplePolygon, rectPolygon, pointInRegion, OFFSET_ARC_STEP_DEG } from './offset';
export type { Segment, Polyline, Pt2, EdgeRefine } from './offset';
export { SHADOW_REGULATION_PRESETS, SHADOW_REGION_HOURS, DEFAULT_SHADOW_LEVELS, ALL_REGULATION_LEVELS, shadowRegulationPreset } from './shadowRegulation';
export type { ShadowRegulation, ShadowRegulationPreset, ShadowRegion } from './shadowRegulation';

// ---------------------------------------------------------------------------
// 日影図
// ---------------------------------------------------------------------------

/** 水平の箱（ワールド XZ） */
export interface XZBox {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** 等時間日影線 1 本の集計 */
export interface ShadowDiagramSummary {
  hour: number;
  /** 等時間日影線の最大到達距離（敷地境界から, m。敷地が無ければ建物の輪郭から） */
  maxDist: number;
  /** 規制の線なら 'limitNear'（5〜10m）/ 'limitFar'（10m 超）。同じ時間なら 'limitNear' */
  role?: 'limitNear' | 'limitFar';
}

export interface ShadowDiagram {
  svg: string;
  /** 等時間日影線の最大到達距離（敷地境界から, m）。時間の小さい順 */
  summary: ShadowDiagramSummary[];
  /**
   * 描いた範囲（ワールド）。x0..x0+2·halfX、z0..z0+2·halfZ。half は max(halfX, halfZ)
   * （half を指定した正方形の図では halfX = halfZ = half。自動の範囲は建物と影を囲む長方形）
   */
  extent: { x0: number; z0: number; half: number; cell: number; halfX: number; halfZ: number };
  /** 使った冬至日（JST） */
  date: { year: number; month: number; day: number };
  /**
   * 影が図の範囲の外まで伸びているか。自動の範囲（autoExtent）では建物の影が上限 SHADOW_DIAGRAM_MAX_HALF で切れたか、
   * 固定の範囲（half・extent）では図の縁まで遮蔽物の影が届いているか
   */
  clipped: boolean;
}

/** 日影図に描く輪郭。{x,y}[] は閉じた輪郭（塗りなし） */
export type ShadowOutline = Pt2[] | { points: Pt2[]; fill?: boolean; closed?: boolean };

/** 日影図の描き方（両アプリ共通。shadowDiagram の over・shadowDiagramStudy の引数でも渡せる） */
export interface ShadowDiagramOptions {
  /** 真太陽時の範囲 (h)。省略時 [8, 16]（北海道は [9, 15]: SHADOW_REGION_HOURS） */
  hours?: [number, number];
  /** 等時間日影線を描く時間 (h)。省略時 [2, 3, 4, 5]（DEFAULT_SHADOW_LEVELS）。2.5・1.5 なども可 */
  levels?: number[];
  /**
   * 規制時間（SHADOW_REGULATION_PRESETS など）。指定すると limitNear・limitFar の 2 本を太く描き
   * 「5〜10m の規制 X 時間」「10m 超の規制 Y 時間」と書く（levels に無ければ足す）。他の線は細く描く。適否の判定はしない
   */
  regulation?: ShadowRegulation | null;
  /** 時刻日影線の間隔 (分)。60（既定: 毎正時）または 30（8:00, 8:30 … 16:00。ラベルは正時だけ） */
  timeLineIntervalMin?: 30 | 60;
}

export interface ShadowDiagramParams extends ShadowDiagramOptions {
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
  /** 中心からの範囲 (m)。省略時 34。autoExtent があれば最小値として使い、影が届く範囲まで広げる */
  half?: number;
  /**
   * 建物の最高高さ (m) と水平の箱から範囲を自動で決める（shadowDiagramExtent）。
   * bbox 省略時は建物を中心の点とみなす。include は一緒に入れる範囲（敷地の 10m ラインなど）
   */
  autoExtent?: { buildingTop: number; bbox?: XZBox | null; include?: XZBox[]; margin?: number; maxHalf?: number };
  /**
   * 計算済みの範囲（shadowDiagramExtent の結果など。中心・半分の幅・格子）。half・autoExtent・cell より優先。
   * 呼び出し側で同じ格子を使う（建物の内外のマスクを作る）ときに渡す
   */
  extent?: ShadowDiagramGridSpec;
  /** 格子 (m)。省略時 0.3。格子数が cellBudget を超えるときは粗くする */
  cell?: number;
  /** 格子数の上限（既定 SHADOW_DIAGRAM_CELL_BUDGET = 4M） */
  cellBudget?: number;
  /** レイキャスト数の目安の上限（既定 SHADOW_DIAGRAM_RAY_BUDGET。extent を渡したときは使わない） */
  rayBudget?: number;
  /** 粗い時間刻み (分)。省略時 10 */
  stepMin?: number;
  /** 建物の内部か（内部は対象外として最大値にする） */
  insideBuilding: (x: number, z: number) => boolean;
  /** insideBuilding を呼ぶ範囲（この箱の外は建物の外とみなす。速さのため）。省略時は全体 */
  buildingBox?: XZBox | null;
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
export const SHADOW_DIAGRAM_CLIPPED_NOTE = '※影の一部が図の範囲の外まで伸びています';
/** 日影図の範囲の既定・最小 (m, 中心から) */
export const SHADOW_DIAGRAM_MIN_HALF = 34;
/** 日影図の範囲の上限 (m, 中心から) */
export const SHADOW_DIAGRAM_MAX_HALF = 400;
/** 日影図の格子数の上限（これを超える範囲では格子を粗くする） */
export const SHADOW_DIAGRAM_CELL_BUDGET = 4_000_000;
/**
 * 日影図のレイキャスト数の目安の上限（周辺建物が密で範囲が広いときは、これに収まるように格子を粗くする。
 * 影が落ち得ない点はレイキャストしないので、ふつうはここまで届かない）
 */
export const SHADOW_DIAGRAM_RAY_BUDGET = 8_000_000;

/** 遮蔽状態の遷移を二分探索する細かさ（1 刻みを 2^REFINE に分ける: 10 分刻み・5 回 → 18.75 秒） */
const REFINE = 5;
/** 時刻日影線の交点を格子の辺の上で二分探索する回数（格子 / 2^7） */
const LINE_REFINE = 7;

/** 格子 (m): base 以上で、格子数 (2·halfX / cell)·(2·halfZ / cell) が budget を超えない（1mm 単位で切り上げ） */
export function shadowDiagramCell(halfX: number, halfZ = halfX, base = 0.3, budget = SHADOW_DIAGRAM_CELL_BUDGET): number {
  const minCell = Math.sqrt((4 * halfX * halfZ) / Math.max(1, budget));
  let cell = Math.max(base, Math.ceil(minCell * 1000 - 1e-9) / 1000);
  while (Math.ceil((2 * halfX) / cell) * Math.ceil((2 * halfZ) / cell) > budget) cell += 0.001;
  return cell;
}

/** 日影図の格子の決め方: 中心（格子の中心）・半分の幅（東西 halfX・南北 halfZ）・格子 (m) */
export interface ShadowDiagramGridSpec {
  center: { x: number; z: number };
  halfX: number;
  halfZ: number;
  cell: number;
}

/** 格子の左上（x0, z0）とセル数 */
export function shadowDiagramGrid(g: ShadowDiagramGridSpec): { x0: number; z0: number; nx: number; nz: number; cell: number } {
  return { x0: g.center.x - g.halfX, z0: g.center.z - g.halfZ, nx: Math.max(1, Math.ceil((2 * g.halfX) / g.cell)), nz: Math.max(1, Math.ceil((2 * g.halfZ) / g.cell)), cell: g.cell };
}

/** 遮蔽物（extra も含む）のワールドの箱。三角形が無ければ空の箱 */
export function occluderBounds(occ: Occluder, out = new THREE.Box3()): THREE.Box3 {
  const g = occ.mesh.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  if (g.boundingBox && !g.boundingBox.isEmpty()) out.union(g.boundingBox);
  if (occ.extra) for (const e of occ.extra) occluderBounds(e, out);
  return out;
}

/** 箱を d 広げる */
export function expandXZBox(b: XZBox, d: number): XZBox {
  return { minX: b.minX - d, minZ: b.minZ - d, maxX: b.maxX + d, maxZ: b.maxZ + d };
}

/** 多角形（ワールド XZ: x→x, z→y）の箱 */
export function xzBoxOf(poly: Pt2[]): XZBox | null {
  if (!poly.length) return null;
  const b = bboxOf(poly);
  return { minX: b.minX, minZ: b.minY, maxX: b.maxX, maxZ: b.maxY };
}

/** shadowDiagramExtent の結果 */
export interface ShadowDiagramExtent extends ShadowDiagramGridSpec {
  /** max(halfX, halfZ) */
  half: number;
  /** 時間帯で最も低い太陽の高度 (度) */
  minElev: number;
  /** 最も低い太陽での最高高さの影の長さ (m) */
  shadowLength: number;
  /** 必要な範囲が maxHalf を超えた（図の外まで影が伸びる） */
  clipped: boolean;
}

/**
 * 日影図の範囲。冬至日の hours（真太陽時）の各時刻（5 分刻み + 両端）で、建物の箱を太陽と反対の向きへ
 * (buildingTop − planeHeight)·cot(太陽高度) だけずらした箱（＝最高高さの影の先端が届く範囲）と、建物の箱・include の箱を
 * すべて囲む長方形 + 余白（margin + ラベルの分）。center（建物の中心）± minHalf の正方形は必ず含め、center ± maxHalf を超える分は切る。
 * 格子は格子数が cellBudget 以内になるように決める（shadowDiagramCell）。結果の center は長方形（格子）の中心
 */
export function shadowDiagramExtent(p: {
  lat: number;
  lon: number;
  year: number;
  northAngleDeg?: number;
  hours?: [number, number];
  planeHeight: number;
  buildingTop: number;
  /** 建物の水平の箱。省略時は center の点 */
  bbox?: XZBox | null;
  /** 建物の中心（ラベル・最小の正方形の中心）。省略時は bbox の中心 */
  center?: { x: number; z: number };
  /** 一緒に入れる範囲（敷地の 10m ラインなど） */
  include?: XZBox[];
  /** 余白 (m)。既定 6（これに範囲の 3% を足す: ラベルの分） */
  margin?: number;
  /** 最小（center からの半分の幅, m）。既定 34 */
  minHalf?: number;
  /** 最大（center からの半分の幅, m）。既定 400 */
  maxHalf?: number;
  /** 格子の最小 (m)。既定 0.3 */
  cell?: number;
  cellBudget?: number;
}): ShadowDiagramExtent {
  const [H0, H1] = p.hours ?? [8, 16];
  const w = winterSolstice(p.year);
  const c = p.center ?? (p.bbox ? { x: (p.bbox.minX + p.bbox.maxX) / 2, z: (p.bbox.minZ + p.bbox.maxZ) / 2 } : { x: 0, z: 0 });
  const box: XZBox = p.bbox ?? { minX: c.x, minZ: c.z, maxX: c.x, maxZ: c.z };
  const rise = Math.max(0, p.buildingTop - p.planeHeight);
  const u: XZBox = { ...box };
  const grow = (b: XZBox) => {
    u.minX = Math.min(u.minX, b.minX);
    u.minZ = Math.min(u.minZ, b.minZ);
    u.maxX = Math.max(u.maxX, b.maxX);
    u.maxZ = Math.max(u.maxZ, b.maxZ);
  };
  let minElev = Infinity;
  let shadowLength = 0;
  const n = Math.max(1, Math.ceil(((H1 - H0) * 60) / 5));
  for (let k = 0; k <= n; k++) {
    const s = H0 + ((H1 - H0) * k) / n;
    const lh = trueSolarToLocal(p.year, w.month, w.day, s, p.lon);
    const sp = sunPosition(localDate(p.year, w.month, w.day, lh), p.lat, p.lon);
    if (sp.elevation <= 0) continue; // 太陽が地平線の下: 影ではなく夜（全面が日影）
    minElev = Math.min(minElev, sp.elevation);
    if (rise <= 0) continue;
    const L = rise / Math.tan((Math.max(0.5, sp.elevation) * Math.PI) / 180);
    shadowLength = Math.max(shadowLength, L);
    const dir = sunDirectionWorld(sp.azimuth, sp.elevation, p.northAngleDeg ?? 0);
    const hl = Math.hypot(dir.x, dir.z) || 1;
    const ox = (-dir.x / hl) * L;
    const oz = (-dir.z / hl) * L;
    grow({ minX: box.minX + ox, minZ: box.minZ + oz, maxX: box.maxX + ox, maxZ: box.maxZ + oz });
  }
  for (const b of p.include ?? []) grow(b);
  // 余白（ラベルの分として範囲の 3% を足す）と最小の正方形
  const m = (p.margin ?? 6) + 0.03 * Math.max(u.maxX - u.minX, u.maxZ - u.minZ) / 2;
  const minHalf = p.minHalf ?? SHADOW_DIAGRAM_MIN_HALF;
  const maxHalf = Math.max(minHalf, p.maxHalf ?? SHADOW_DIAGRAM_MAX_HALF);
  const need: XZBox = { minX: Math.min(u.minX - m, c.x - minHalf), minZ: Math.min(u.minZ - m, c.z - minHalf), maxX: Math.max(u.maxX + m, c.x + minHalf), maxZ: Math.max(u.maxZ + m, c.z + minHalf) };
  const r: XZBox = { minX: Math.max(need.minX, c.x - maxHalf), minZ: Math.max(need.minZ, c.z - maxHalf), maxX: Math.min(need.maxX, c.x + maxHalf), maxZ: Math.min(need.maxZ, c.z + maxHalf) };
  const clipped = r.minX > need.minX + 1e-9 || r.minZ > need.minZ + 1e-9 || r.maxX < need.maxX - 1e-9 || r.maxZ < need.maxZ - 1e-9;
  const halfX = (r.maxX - r.minX) / 2;
  const halfZ = (r.maxZ - r.minZ) / 2;
  return {
    center: { x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 },
    halfX,
    halfZ,
    half: Math.max(halfX, halfZ),
    cell: shadowDiagramCell(halfX, halfZ, p.cell ?? 0.3, p.cellBudget),
    minElev: Number.isFinite(minElev) ? minElev : 0,
    shadowLength,
    clipped,
  };
}

/** 遮蔽物の箱の測定面より上の部分を、太陽と反対の向きに測定面へ写した凸包（この外の点には影が落ちない） */
interface ShadowHull {
  xs: Float64Array;
  zs: Float64Array;
  n: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function shadowHull(box: THREE.Box3, dir: THREE.Vector3, plane: number, pad = 0.05): ShadowHull | null {
  if (box.isEmpty() || box.max.y <= plane || dir.y <= 0) return null;
  const y0 = Math.max(box.min.y, plane);
  const pts: [number, number][] = [];
  for (const x of [box.min.x - pad, box.max.x + pad])
    for (const z of [box.min.z - pad, box.max.z + pad])
      for (const y of [y0, box.max.y + pad]) {
        const k = (y - plane) / dir.y;
        pts.push([x - dir.x * k, z - dir.z * k]);
      }
  // 単調連鎖法の凸包（反時計回り: x 右・z 上の向き）
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of pts) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  const h: ShadowHull = { xs: new Float64Array(hull.length), zs: new Float64Array(hull.length), n: hull.length, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  hull.forEach(([x, z], i) => {
    h.xs[i] = x;
    h.zs[i] = z;
    h.minX = Math.min(h.minX, x);
    h.maxX = Math.max(h.maxX, x);
    h.minZ = Math.min(h.minZ, z);
    h.maxZ = Math.max(h.maxZ, z);
  });
  return h;
}

function inHull(h: ShadowHull, x: number, z: number): boolean {
  if (x < h.minX || x > h.maxX || z < h.minZ || z > h.maxZ) return false;
  if (h.n < 3) return true;
  for (let i = 0; i < h.n; i++) {
    const j = i + 1 === h.n ? 0 : i + 1;
    if ((h.xs[j] - h.xs[i]) * (z - h.zs[i]) - (h.zs[j] - h.zs[i]) * (x - h.xs[i]) < -1e-9) return false;
  }
  return true;
}

/**
 * 遮蔽物（extra も含む）の三角形を水平の升目（重心で振り分け）ごとの箱にまとめる。測定面より上に出る箱だけ返す。
 * 周辺建物が多いときに、時刻ごとに影が落ち得る場所を絞るために使う
 */
function occluderClusters(occ: Occluder, plane: number, bounds: THREE.Box3): THREE.Box3[] {
  if (bounds.isEmpty()) return [];
  const B = Math.max(4, (bounds.max.x - bounds.min.x) / 128, (bounds.max.z - bounds.min.z) / 128);
  const nbx = Math.max(1, Math.ceil((bounds.max.x - bounds.min.x) / B) + 1);
  const boxes = new Map<number, THREE.Box3>();
  const v = new THREE.Vector3();
  const visit = (o: Occluder) => {
    const pos = o.mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (pos) {
      const a = pos.array as ArrayLike<number>;
      for (let t = 0; t + 8 < a.length; t += 9) {
        const cx = (a[t] + a[t + 3] + a[t + 6]) / 3;
        const cz = (a[t + 2] + a[t + 5] + a[t + 8]) / 3;
        const key = Math.floor((cz - bounds.min.z) / B) * nbx + Math.floor((cx - bounds.min.x) / B);
        let b = boxes.get(key);
        if (!b) boxes.set(key, (b = new THREE.Box3()));
        b.expandByPoint(v.set(a[t], a[t + 1], a[t + 2]));
        b.expandByPoint(v.set(a[t + 3], a[t + 4], a[t + 5]));
        b.expandByPoint(v.set(a[t + 6], a[t + 7], a[t + 8]));
      }
    }
    if (o.extra) for (const e of o.extra) visit(e);
  };
  visit(occ);
  return [...boxes.values()].filter((b) => b.max.y > plane);
}

/** 影が落ち得る場所の 2 値画像（画素 R m。1 = その画素のどこかに影が落ち得る） */
interface MayShade {
  data: Uint8Array;
}

/**
 * 箱ごとの影の凸包（箱を水平に R/2 広げて写すので、画素の中心の判定で画素全体を覆う）を塗る。
 * 画素の中心が凸包の内側なら 1（凸包と画素が重なれば必ず 1）
 */
function rasterMayShade(boxes: THREE.Box3[], dir: THREE.Vector3, plane: number, g: { bx0: number; bz0: number; R: number; bw: number; bh: number }): MayShade {
  const data = new Uint8Array(g.bw * g.bh);
  const pad = 0.05 + g.R / 2;
  for (const b of boxes) {
    const h = shadowHull(b, dir, plane, pad);
    if (!h) continue;
    const j0 = Math.max(0, Math.floor((h.minZ - g.bz0) / g.R - 0.5));
    const j1 = Math.min(g.bh - 1, Math.ceil((h.maxZ - g.bz0) / g.R - 0.5));
    for (let j = j0; j <= j1; j++) {
      const zc = g.bz0 + (j + 0.5) * g.R;
      let xa = Infinity;
      let xb = -Infinity;
      for (let e = 0; e < h.n; e++) {
        const f = e + 1 === h.n ? 0 : e + 1;
        const za = h.zs[e];
        const zb = h.zs[f];
        if ((za <= zc && zc <= zb) || (zb <= zc && zc <= za)) {
          const x = zb === za ? Math.min(h.xs[e], h.xs[f]) : h.xs[e] + ((zc - za) * (h.xs[f] - h.xs[e])) / (zb - za);
          const x2 = zb === za ? Math.max(h.xs[e], h.xs[f]) : x;
          xa = Math.min(xa, x);
          xb = Math.max(xb, x2);
        }
      }
      if (!(xb >= xa)) continue;
      const i0 = Math.max(0, Math.ceil((xa - g.bx0) / g.R - 0.5));
      const i1 = Math.min(g.bw - 1, Math.floor((xb - g.bx0) / g.R - 0.5));
      const row = j * g.bw;
      for (let i = i0; i <= i1; i++) data[row + i] = 1;
    }
  }
  return { data };
}

/** 等時間日影線の時間（levels と規制の 2 本、0 < h < 時間帯の長さ、重複なし、小さい順） */
function diagramLevels(levels: number[] | undefined, reg: ShadowRegulation | null, span: number): number[] {
  const all = [...(levels ?? DEFAULT_SHADOW_LEVELS), ...(reg ? [reg.limitNear, reg.limitFar] : [])].filter((h) => Number.isFinite(h) && h > 0 && h < span);
  const out: number[] = [];
  for (const h of all.sort((a, b) => a - b)) if (!out.some((q) => Math.abs(q - h) < 1e-9)) out.push(h);
  return out;
}

/** 等時間日影線の色（時間ごと） */
const EQ_COLORS: Record<string, string> = { '1': '#f1c40f', '1.5': '#b7950b', '2': '#e67e22', '2.5': '#a04000', '3': '#d35400', '4': '#c0392b', '5': '#8e44ad', '6': '#6c3483' };
const eqColor = (h: number) => EQ_COLORS[String(Math.round(h * 100) / 100)] ?? '#8e44ad';
const fmtHours = (h: number) => String(Math.round(h * 100) / 100);

/**
 * 日影図（冬至日・真太陽時）。冬至日はその年の実際の日付（winterSolstice: 年により 12/21 か 12/22）。
 * 各セルについて粗い刻み（stepMin）で日影かを判定し、隣り合う刻みで状態が変わる区間は時刻を二分探索して
 * 遷移時刻を求め、日影の時間を正確に積算する（等時間日影線が刻み幅で動かないように。線はセルの値の線形補間）。
 * 時刻日影線は毎正時（timeLineIntervalMin: 30 なら 30 分ごと）の判定で、線の位置は格子の辺の上で二分探索して求める。
 * 遮蔽物の箱の影が落ち得ない場所はレイキャストを省く（広い範囲でも速い）。
 */
export async function shadowDiagramCore(p: ShadowDiagramParams): Promise<ShadowDiagram> {
  const { occ, lat, lon, planeHeight } = p;
  const Y = p.year;
  const wd = winterSolstice(Y);
  const M = wd.month;
  const D = wd.day;
  const stepMin = p.stepMin ?? 10;
  const [H0, H1] = p.hours ?? [8, 16];
  const span = H1 - H0;
  const reg = p.regulation ?? null;
  const levels = diagramLevels(p.levels, reg, span);
  const nCoarse = Math.max(1, Math.round((span * 60) / stepMin));
  const coarseStep = span / nCoarse;
  const fine = 1 << REFINE;
  const nFine = nCoarse * fine;
  const fineStep = coarseStep / fine;
  // 細かい刻みの太陽方向（二分探索で使う）。粗い刻み k は細かい刻み k*fine
  const dirAt = (s: number) => {
    const lh = trueSolarToLocal(Y, M, D, s, lon);
    const sp = sunPosition(localDate(Y, M, D, lh), lat, lon);
    return { s, dir: sunDirectionWorld(sp.azimuth, sp.elevation, p.northAngleDeg), elev: sp.elevation };
  };
  const fineDirs: { s: number; dir: THREE.Vector3; elev: number }[] = [];
  for (let f = 0; f <= nFine; f++) fineDirs.push(dirAt(H0 + f * fineStep));
  // 範囲: 計算済みの extent、autoExtent（影の届く範囲の長方形）、または center ± half の正方形
  let spec: ShadowDiagramGridSpec;
  /** autoExtent の範囲が上限で切れたか（undefined: 自動の範囲ではない → 図の縁のセルで調べる） */
  let autoClipped: boolean | undefined;
  if (p.extent) spec = p.extent;
  else if (p.autoExtent) {
    const e = shadowDiagramExtent({
      lat,
      lon,
      year: Y,
      northAngleDeg: p.northAngleDeg,
      hours: [H0, H1],
      planeHeight,
      buildingTop: p.autoExtent.buildingTop,
      bbox: p.autoExtent.bbox,
      center: p.center,
      include: p.autoExtent.include,
      margin: p.autoExtent.margin,
      minHalf: p.half ?? SHADOW_DIAGRAM_MIN_HALF,
      maxHalf: p.autoExtent.maxHalf,
      cell: p.cell,
      cellBudget: p.cellBudget,
    });
    spec = e;
    autoClipped = e.clipped;
  } else {
    const h = p.half ?? SHADOW_DIAGRAM_MIN_HALF;
    spec = { center: p.center, halfX: h, halfZ: h, cell: shadowDiagramCell(h, h, p.cell ?? 0.3, p.cellBudget) };
  }
  const halfX = spec.halfX;
  const halfZ = spec.halfZ;
  /** 建物の中心（ラベルの位置の基準） */
  const c = p.center;
  /** 格子の中心 */
  const gc = spec.center;
  const occBox = occluderBounds(occ);
  const hulls = fineDirs.map((d) => (d.elev > 0 ? shadowHull(occBox, d.dir, planeHeight) : null));
  // 時刻ごとの「影が落ち得る場所」の画像（遮蔽物を水平 4m 程度の箱に分け、箱ごとの影の凸包を塗る）。
  // 周辺建物が多い・範囲が広いときに、影の落ちない点のレイキャストを省く。画像は格子の大きさによらない
  const clusters = occluderClusters(occ, planeHeight, occBox);
  const R = Math.max(0.25, Math.sqrt((4 * halfX * halfZ) / 262144));
  const mg = { bx0: gc.x - halfX, bz0: gc.z - halfZ, R, bw: Math.max(1, Math.ceil((2 * halfX) / R) + 1), bh: Math.max(1, Math.ceil((2 * halfZ) / R) + 1) };
  const coarseMay: (MayShade | null)[] = [];
  for (let k = 0; k <= nCoarse; k++) coarseMay.push(hulls[k * fine] ? rasterMayShade(clusters, fineDirs[k * fine].dir, planeHeight, mg) : null);
  if (!p.extent) {
    // レイキャスト数の目安（影が落ち得る画素の面積 / 格子の面積 × 時刻の数）が上限を超えるなら格子を粗くする
    let area = 0;
    for (const m of coarseMay) if (m) for (let q = 0; q < m.data.length; q++) area += m.data[q];
    area *= R * R;
    const rayCell = Math.sqrt(area / Math.max(1, p.rayBudget ?? SHADOW_DIAGRAM_RAY_BUDGET));
    if (rayCell > spec.cell) spec = { ...spec, cell: Math.ceil(rayCell * 1000) / 1000 };
  }
  const { x0, z0, nx, nz, cell } = shadowDiagramGrid(spec);
  const N = nx * nz;
  const count = new Float32Array(N);
  // 時刻日影線（毎正時、または 30 分ごと）
  const iv = p.timeLineIntervalMin === 30 ? 30 : 60;
  interface TimeLine {
    s: number;
    hourly: boolean;
    dir: THREE.Vector3;
    elev: number;
    hull: ShadowHull | null;
    /** 粗い刻みと一致すれば k（その判定を使う）、しなければ -1 */
    k: number;
    mask: Uint8Array;
  }
  const lines: TimeLine[] = [];
  for (let m = Math.ceil((H0 * 60) / iv - 1e-9) * iv; m <= H1 * 60 + 1e-9; m += iv) {
    const s = m / 60;
    const fpos = (s - H0) / fineStep;
    const fi = Math.round(fpos);
    const aligned = Math.abs(fpos - fi) < 1e-6 && fi >= 0 && fi <= nFine;
    const e = aligned ? fineDirs[fi] : dirAt(s);
    const k = aligned && fi % fine === 0 ? fi / fine : -1;
    lines.push({ s, hourly: Math.abs(s - Math.round(s)) < 1e-9, dir: e.dir, elev: e.elev, hull: aligned ? hulls[fi] : e.elev > 0 ? shadowHull(occBox, e.dir, planeHeight) : null, k, mask: new Uint8Array(N) });
  }
  // 影が落ち得る範囲（全時刻の凸包の外接矩形）。この外のセルは遮蔽物が無い点と同じ結果
  let rx0 = Infinity;
  let rx1 = -Infinity;
  let rz0 = Infinity;
  let rz1 = -Infinity;
  for (const h of [...hulls, ...lines.map((l) => l.hull)]) {
    if (!h) continue;
    rx0 = Math.min(rx0, h.minX);
    rx1 = Math.max(rx1, h.maxX);
    rz0 = Math.min(rz0, h.minZ);
    rz1 = Math.max(rz1, h.maxZ);
  }
  const lineMay = lines.map((l) => (l.k >= 0 ? coarseMay[l.k] : l.hull ? rasterMayShade(clusters, l.dir, planeHeight, mg) : null));
  const mayAt = (m: MayShade | null, x: number, z: number) => {
    if (!m) return false;
    const i = Math.floor((x - mg.bx0) / R);
    const j = Math.floor((z - mg.bz0) / R);
    // 画像の外（格子の端の半端）は分からないので「落ち得る」とする
    return i < 0 || j < 0 || i >= mg.bw || j >= mg.bh || m.data[j * mg.bw + i] === 1;
  };
  const bb = p.buildingBox ? expandXZBox(p.buildingBox, 0.5) : null;
  const inside = (x: number, z: number) => (!bb || (x >= bb.minX && x <= bb.maxX && z >= bb.minZ && z <= bb.maxZ)) && p.insideBuilding(x, z);
  const pt = new THREE.Vector3();
  const states = new Uint8Array(nCoarse + 1);
  const isNight = (f: number) => fineDirs[f].elev <= 0;
  // pt の位置で、細かい刻み f に日影か（太陽が地平線の下なら日影）
  // レイの長さ: 遮蔽物の最も高い所を越えるまで（それより先には当たる物が無い。BVH の探索を短くする）
  const topY = occBox.isEmpty() ? planeHeight : occBox.max.y;
  const farFor = (dir: THREE.Vector3) => Math.min(2000, (topY - planeHeight) / Math.max(1e-6, dir.y) + 1);
  const fineFar = fineDirs.map((d) => farFor(d.dir));
  const shadedAt = (f: number) => {
    const d = fineDirs[f];
    if (d.elev <= 0) return true;
    const h = hulls[f];
    if (!h || !inHull(h, pt.x, pt.z)) return false;
    if (f % fine === 0 && !mayAt(coarseMay[f / fine], pt.x, pt.z)) return false;
    return isShaded(occ, pt, d.dir, fineFar[f]);
  };
  const lineFar = lines.map((l) => farFor(l.dir));
  const shadedLine = (l: TimeLine, li: number) => l.elev <= 0 || (!!l.hull && inHull(l.hull, pt.x, pt.z) && mayAt(lineMay[li], pt.x, pt.z) && isShaded(occ, pt, l.dir, lineFar[li]));
  // 区間ごとに日影の時間を積算。状態が変わる区間は遷移時刻を二分探索
  const integrate = (sh: (f: number) => boolean): number => {
    for (let k = 0; k <= nCoarse; k++) states[k] = sh(k * fine) ? 1 : 0;
    let shaded = 0;
    for (let k = 0; k < nCoarse; k++) {
      const a = states[k];
      const b = states[k + 1];
      if (a === b) {
        if (a) shaded += coarseStep;
        continue;
      }
      // lo は状態 a、hi は状態 b。a→b が変わる最初の細かい刻みを探す
      let lo = k * fine;
      let hi = (k + 1) * fine;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if ((sh(mid) ? 1 : 0) === a) lo = mid;
        else hi = mid;
      }
      const tA = (hi - k * fine) * fineStep; // 状態 a が続いた時間
      shaded += a ? tA : coarseStep - tA;
    }
    return shaded;
  };
  // 遮蔽物の無い点（夜の時間だけ日影）
  const freeCount = integrate(isNight);
  const freeMask = lines.map((l) => (l.elev <= 0 ? 1 : 0));
  for (let j = 0; j < nz; j++) {
    const z = z0 + (j + 0.5) * cell;
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * cell;
      const idx = j * nx + i;
      if (inside(x, z)) {
        // 建物内部は日影図の対象外（等時間線が内部に出ないよう最大値に）
        count[idx] = span;
        for (const l of lines) l.mask[idx] = 1;
        continue;
      }
      if (x < rx0 || x > rx1 || z < rz0 || z > rz1) {
        count[idx] = freeCount;
        for (let li = 0; li < lines.length; li++) lines[li].mask[idx] = freeMask[li];
        continue;
      }
      pt.set(x, planeHeight, z);
      count[idx] = integrate(shadedAt);
      for (let li = 0; li < lines.length; li++) {
        const l = lines[li];
        l.mask[idx] = l.k >= 0 ? states[l.k] : shadedLine(l, li) ? 1 : 0;
      }
    }
    if (j % 10 === 0) {
      p.onProgress?.(j / nz);
      await yieldUI();
      throwIfAborted(p.signal);
    }
  }
  // 範囲の外まで影が伸びているか: 自動の範囲なら建物の影が上限で切れたか（周辺建物の影は範囲の外へ続いて当然なので見ない）、
  // そうでなければ図の縁のセルまで遮蔽物の影が届いているか
  const edgeShaded = () => {
    const sh = (idx: number) => count[idx] > freeCount + 1e-6;
    for (let i = 0; i < nx; i++) if (sh(i) || sh((nz - 1) * nx + i)) return true;
    for (let j = 0; j < nz; j++) if (sh(j * nx) || sh(j * nx + nx - 1)) return true;
    return false;
  };
  const clipped = autoClipped ?? edgeShaded();

  // ---- SVG ----
  const S = 100; // 1m = 100 単位
  const K = Math.max(1, halfX / SHADOW_DIAGRAM_MIN_HALF, (0.6 * halfZ) / SHADOW_DIAGRAM_MIN_HALF); // 文字・線の太さの倍率（広い図でも読めるように。文字は横書きなので幅に合わせる）
  const toX = (gi: number) => (x0 + gi * cell) * S;
  const toY = (gj: number) => (z0 + gj * cell) * S;
  const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
  const fs = (v: number) => fmt(v * K);
  const ptsAttr = (poly: Pt2[]) => poly.map((q) => `${fmt(q.x * S)},${fmt(q.y * S)}`).join(' ');
  /** 格子座標の線分 → path の d（端点をつないだ折れ線） */
  const pathD = (segs: Segment[]) =>
    segmentsToPolylines(segs, 1e-7)
      .map((pl) => `M${pl.points.map((q) => `${toX(q.x + 0.5).toFixed(0)} ${toY(q.y + 0.5).toFixed(0)}`).join('L')}${pl.closed ? 'Z' : ''}`)
      .join('');
  let body = '';
  // 敷地（指定があるときだけ。無ければ 5m/10m ラインも省く）
  const sitePoly = p.site && p.site.polygon.length >= 3 ? p.site.polygon : null;
  if (sitePoly) {
    body += `<polygon points="${ptsAttr(sitePoly)}" fill="none" stroke="#333" stroke-width="${fs(12)}" stroke-dasharray="${fs(60)} ${fs(25)} ${fs(10)} ${fs(25)}"/>`;
    // 5m・10m ライン（敷地境界から水平距離 5m・10m の線。凸の角は円弧）
    for (const [d, col] of [
      [5, '#9a9a9a'],
      [10, '#bdbdbd'],
    ] as const) {
      const loops = offsetRegion(sitePoly, d);
      if (!loops.length) continue;
      const ob = bboxOf(loops[0]);
      const dd = loops.map((l) => `M${l.map((q) => `${fmt(q.x * S)} ${fmt(q.y * S)}`).join('L')}Z`).join('');
      body += `<path data-offset="${d}" d="${dd}" fill="none" stroke="${col}" stroke-width="${fs(8)}" stroke-dasharray="${fs(30)} ${fs(20)}"/>`;
      body += `<text x="${fmt(ob.maxX * S + 20 * K)}" y="${fmt(ob.minY * S + 60 * K)}" font-size="${fs(70)}" fill="${col}">${d}mライン</text>`;
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
    body += `<${tag} points="${ptsAttr(ol.points)}" fill="${ol.fill && closed ? '#555' : 'none'}" stroke="#222" stroke-width="${fs(10)}" fill-opacity="0.35"/>`;
  }
  // 時刻日影線（線の位置は格子の辺の上で二分探索: 0/1 の判定でも格子の 1/128 の精度）
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    const memo = new Map<string, number>();
    const at = (gx: number, gz: number) => {
      const x = x0 + (gx + 0.5) * cell;
      const z = z0 + (gz + 0.5) * cell;
      if (inside(x, z)) return 1;
      if (x < rx0 || x > rx1 || z < rz0 || z > rz1) return l.elev <= 0 ? 1 : 0;
      pt.set(x, planeHeight, z);
      return shadedLine(l, li) ? 1 : 0;
    };
    const refine = (i0: number, j0: number, i1: number, j1: number, t: number) => {
      const key = `${i0},${j0},${i1},${j1}`;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      const a = l.mask[j0 * nx + i0];
      let lo = 0;
      let hi = 1;
      for (let it = 0; it < LINE_REFINE; it++) {
        const mid = (lo + hi) / 2;
        if (at(i0 + (i1 - i0) * mid, j0 + (j1 - j0) * mid) === a) lo = mid;
        else hi = mid;
      }
      void t; // 線形補間の値は 0/1 の格子では常に中点なので使わない
      const r = (lo + hi) / 2;
      memo.set(key, r);
      return r;
    };
    const segs = marchingSegments(l.mask, nx, nz, 0.5, refine);
    if (!segs.length) continue;
    body += l.hourly
      ? `<path data-time="${formatHM(l.s)}" d="${pathD(segs)}" stroke="#3b7dd8" stroke-width="${fs(7)}" fill="none" opacity="0.8"/>`
      : `<path data-time="${formatHM(l.s)}" d="${pathD(segs)}" stroke="#3b7dd8" stroke-width="${fs(4)}" fill="none" opacity="0.6" stroke-dasharray="${fs(24)} ${fs(14)}"/>`;
    if (!l.hourly) continue;
    // ラベル: 影の先端（中心から最も遠い点）。正時だけ
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
    // 東側の先端は文字を左へ（図の外にはみ出さない）
    if (far) body += `<text x="${fmt(far[0] * S)}" y="${fmt(far[1] * S)}" font-size="${fs(80)}" fill="#3b7dd8" font-weight="bold"${far[0] > c.x ? ' text-anchor="end"' : ''}>${Math.round(l.s)}時</text>`;
  }
  // 等時間日影線（規制の 2 本は太く、他は細く）
  const summary: ShadowDiagramSummary[] = [];
  const isLevel = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  for (const hh of levels) {
    const segs = marchingSegments(count, nx, nz, hh);
    const col = eqColor(hh);
    const near = !!reg && isLevel(hh, reg.limitNear);
    const farLine = !!reg && isLevel(hh, reg.limitFar);
    const emph = near || farLine;
    const width = reg ? (emph ? 20 : 6) : 14;
    const role = near ? ' data-role="limitNear"' : farLine ? ' data-role="limitFar"' : '';
    if (segs.length) body += `<path data-level="${fmtHours(hh)}"${role} d="${pathD(segs)}" stroke="${col}" stroke-width="${fs(width)}" fill="none"${reg && !emph ? ' opacity="0.85"' : ''}/>`;
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
    const s: ShadowDiagramSummary = { hour: hh, maxDist };
    if (near) s.role = 'limitNear';
    else if (farLine) s.role = 'limitFar';
    summary.push(s);
    if (!lab) continue;
    if (emph) {
      const texts = [...(near ? [`5〜10m の規制 ${fmtHours(reg!.limitNear)} 時間`] : []), ...(farLine ? [`10m 超の規制 ${fmtHours(reg!.limitFar)} 時間`] : [])].join('／');
      body += `<text x="${fmt(lab[0] * S + 30 * K)}" y="${fmt(lab[1] * S - 20 * K)}" font-size="${fs(95)}" fill="${col}" font-weight="bold" stroke="#fff" stroke-width="${fs(14)}" paint-order="stroke">${texts}</text>`;
    } else body += `<text x="${fmt(lab[0] * S + 30 * K)}" y="${fmt(lab[1] * S - 20 * K)}" font-size="${fs(reg ? 70 : 90)}" fill="${col}" font-weight="bold">${fmtHours(hh)}時間</text>`;
  }
  // 方位: 四隅のうち影の線が最も少ない所（同じなら右上）。影は北へ伸びるので、ふつうは南側の隅になる
  const nA = p.northAngleDeg;
  const corner = (() => {
    const r = Math.min(nx, nz, Math.ceil((6 * K) / cell));
    const shadedIn = (ci: number, cj: number) => {
      let n = 0;
      for (let j = cj; j < cj + r; j++) for (let i = ci; i < ci + r; i++) if (count[j * nx + i] > freeCount + 1e-6) n++;
      return n;
    };
    const cands = [
      { fx: 1, fz: 0, n: shadedIn(nx - r, 0) },
      { fx: 1, fz: 1, n: shadedIn(nx - r, nz - r) },
      { fx: 0, fz: 1, n: shadedIn(0, nz - r) },
      { fx: 0, fz: 0, n: shadedIn(0, 0) },
    ];
    return cands.reduce((a, b) => (b.n < a.n ? b : a));
  })();
  const ax = (corner.fx ? x0 + halfX * 2 - 3 * K : x0 + 3 * K) * S;
  const ay = (corner.fz ? z0 + halfZ * 2 - 3 * K : z0 + 3 * K) * S;
  body += `<g transform="translate(${fmt(ax)} ${fmt(ay)}) rotate(${nA}) scale(${fmt(K)})"><circle r="150" fill="#fff" stroke="#333" stroke-width="10"/><path d="M0 -160 L50 90 L0 50 L-50 90Z" fill="#333"/><text y="-190" font-size="110" text-anchor="middle" font-weight="bold">N</text></g>`;
  // 透かし（薄い灰色の斜め文字。図の中央）
  const watermark = p.watermark === undefined ? SHADOW_DIAGRAM_WATERMARK : p.watermark;
  if (watermark) {
    const wfs = Math.max(60, Math.round((Math.min(halfX, 1.6 * halfZ) * 2 * S) / 42));
    body += `<text transform="translate(${fmt(gc.x * S)} ${fmt(gc.z * S)}) rotate(-30)" text-anchor="middle" font-size="${wfs}" fill="#9a9a9a" opacity="0.35" font-weight="bold" pointer-events="none">${watermark}</text>`;
  }
  // 題名: 冬至日の日付・真太陽時と、この場所での JST（均時差・経度差を含む）
  const subtitle = p.subtitle === undefined ? SHADOW_DIAGRAM_SUBTITLE : p.subtitle;
  const jst0 = formatHM(trueSolarToLocal(Y, M, D, H0, lon));
  const jst1 = formatHM(trueSolarToLocal(Y, M, D, H1, lon));
  const title = `日影図（冬至日 ${M}月${D}日 真太陽時 ${formatHM(H0)}〜${formatHM(H1)} ＝ この場所では JST ${jst0}〜${jst1} ／ 測定面 GL+${p.planeLabel ?? String(planeHeight)}m）`;
  const siteText = sitePoly ? '点線: 敷地境界・5m/10mライン（敷地境界から水平距離 5m・10m）' : SHADOW_DIAGRAM_NO_SITE_NOTE;
  const timeText = iv === 30 ? '青線: 時刻日影線（30 分ごと。破線は 30 分、ラベルは正時）' : '青線: 時刻日影線（毎正時）';
  const legend1 = `${timeText}　橙〜紫: 等時間日影線（${levels.map(fmtHours).join('・')}時間）`;
  const regText = reg
    ? `太線: 規制時間${reg.label ? ` ${reg.label}` : ''}（5〜10m の規制 ${fmtHours(reg.limitNear)} 時間・10m 超の規制 ${fmtHours(reg.limitFar)} 時間。線を描くだけで、規制への適否は判定していません）`
    : '';
  const legendLines = [legend1, regText, [siteText, p.note ?? '', clipped ? SHADOW_DIAGRAM_CLIPPED_NOTE : ''].filter(Boolean).join('　')].filter(Boolean);
  const top = z0 * S - (subtitle ? 330 : 250) * K;
  const bottom = (z0 + halfZ * 2) * S + (60 + 120 * legendLines.length) * K;
  const legend =
    `<text x="${fmt(x0 * S + 60 * K)}" y="${fmt(z0 * S - (subtitle ? 200 : 120) * K)}" font-size="${fs(110)}" font-weight="bold" fill="#222">${title}</text>` +
    (subtitle ? `<text x="${fmt(x0 * S + 60 * K)}" y="${fmt(z0 * S - 80 * K)}" font-size="${fs(70)}" fill="#777">${subtitle}</text>` : '') +
    legendLines.map((t, i) => `<text x="${fmt(x0 * S + 60 * K)}" y="${fmt((z0 + halfZ * 2) * S + (160 + 120 * i) * K)}" font-size="${fs(75)}" fill="#555">${t}</text>`).join('');
  const vb = `${fmt(x0 * S)} ${fmt(top)} ${fmt(halfX * 2 * S)} ${fmt(bottom - top)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" font-family="'Noto Sans JP','Hiragino Sans',sans-serif"><rect x="${fmt(x0 * S)}" y="${fmt(top)}" width="${fmt(halfX * 2 * S)}" height="${fmt(bottom - top)}" fill="#fff"/>${body}${legend}</svg>`;
  return { svg, summary, extent: { x0, z0, half: Math.max(halfX, halfZ), cell, halfX, halfZ }, date: { year: Y, month: M, day: D }, clipped };
}

/** shadowDiagram の上書き: 外部の建物（3DS）で置き換えているときに、その輪郭・中心を使う。描き方（ShadowDiagramOptions）も渡せる */
export interface ShadowDiagramOverrides extends ShadowDiagramOptions {
  /** 建物の輪郭（ワールド XZ）。省略時は PDF の各階外形 */
  outlines?: THREE.Vector2[][];
  /** 建物の内部か。省略時は PDF の 1 階外形の内側 */
  insideBuilding?: (x: number, z: number) => boolean;
  /** 図の中心（ワールド XZ）。省略時は影を落とす建物（PDF の建物・屋根、置き換え中は 3DS）の箱の中心 */
  center?: THREE.Vector2;
  /** 建物の最高高さ (m)。省略時は影を落とす建物の箱の上端 */
  buildingTop?: number;
  /** 外部の建物（3DS）を PDF の建物の代わりに使うか（buildOccluder と同じ。省略時は日照ステップ表示中の置き換えに従う） */
  external?: boolean;
}

/**
 * 既存アプリ: 日影図（冬至日・真太陽時 8〜16 時）
 * planeHeight: 測定面の高さ (m)。1.5 / 4.0 など
 * 範囲は影を落とす建物の箱・最高高さと時間帯の最低太陽高度から決める（shadowDiagramExtent: 敷地の 10m ラインも入れる、34〜400m）
 */
export async function shadowDiagram(viewer: Viewer, loc: { lat: number; lon: number; northAngleDeg: number; year: number }, planeHeight = 1.5, onProgress?: (r: number) => void, over: ShadowDiagramOverrides = {}): Promise<ShadowDiagram> {
  const st = viewer.state!;
  // 日影図の建物は中身の詰まった塊: 窓ガラスも影を落とす（窓から窓へ抜ける光で影の中に日向の点ができないように）
  const occ = buildOccluder(viewer, { buildingOnly: true, external: over.external, opaqueGlass: true });
  try {
    const ob = occluderBounds(occ);
    const mb = st.meta.bbox;
    const pdfBox: XZBox = { minX: mb.min.x, minZ: mb.min.z, maxX: mb.max.x, maxZ: mb.max.z };
    const box: XZBox = ob.isEmpty() ? pdfBox : { minX: ob.min.x, minZ: ob.min.z, maxX: ob.max.x, maxZ: ob.max.z };
    const top = over.buildingTop ?? (ob.isEmpty() ? mb.max.y : ob.max.y);
    const c = over.center ? { x: over.center.x, z: over.center.y } : { x: (box.minX + box.maxX) / 2, z: (box.minZ + box.maxZ) / 2 };
    const footprints = st.meta.outlines.map((o) => o.polys.map((poly) => poly.map((q) => ({ x: q.x, y: q.y }))));
    const outlines: ShadowOutline[] = [];
    if (over.outlines) for (const poly of over.outlines) outlines.push({ points: poly.map((q) => ({ x: q.x, y: q.y })), fill: true });
    else for (const o of st.meta.outlines) for (const poly of o.polys) outlines.push({ points: poly.map((q) => ({ x: q.x, y: q.y })), fill: o.level === 1 });
    const insideBuilding = over.insideBuilding ?? ((x: number, z: number) => footprints.some((loops) => insideLoops({ x, y: z }, loops)));
    const site = st.site;
    const sitePoly = rectPolygon(site.min.x, site.min.y, site.max.x, site.max.y);
    const unionBox = (a: XZBox, b: XZBox): XZBox => ({ minX: Math.min(a.minX, b.minX), minZ: Math.min(a.minZ, b.minZ), maxX: Math.max(a.maxX, b.maxX), maxZ: Math.max(a.maxZ, b.maxZ) });
    return await shadowDiagramCore({
      occ,
      lat: loc.lat,
      lon: loc.lon,
      northAngleDeg: loc.northAngleDeg,
      year: loc.year,
      planeHeight,
      center: c,
      half: SHADOW_DIAGRAM_MIN_HALF,
      // 敷地の 10m ライン（+ ラベル）も図に入れる
      autoExtent: { buildingTop: top, bbox: box, include: [expandXZBox(xzBoxOf(sitePoly)!, 11)] },
      cell: 0.3,
      stepMin: 10,
      hours: over.hours,
      levels: over.levels,
      regulation: over.regulation,
      timeLineIntervalMin: over.timeLineIntervalMin,
      insideBuilding,
      buildingBox: over.insideBuilding ? box : unionBox(box, pdfBox),
      outlines,
      site: { polygon: sitePoly },
      note: '※周辺建物は含みません',
      // 既存アプリは図面の方位記号と住所から配置するので「航空写真上での手動配置」の副題は付けない
      subtitle: null,
      onProgress,
    });
  } finally {
    disposeOccluder(occ);
  }
}
