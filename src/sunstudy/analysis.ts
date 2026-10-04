/**
 * 日照解析（3D データ読み込み版）
 *  - 地面の日照時間マップ、建物の面の日照時間、測定点の日照時間（季節別）、日影図
 *  - 影を落とす物体: 地形・周辺建物・読み込んだ建物（BVH レイキャスト）
 *  - 太陽方向は sunDirectionWorld(az, elev, 0)（ワールド X=東, -Z=北, Y=上）
 *
 * 汎用のコア（格子の日照時間・日影図の描画・BVH 作成）は src/sun/analysis.ts に置き、ここから呼ぶ。
 *
 * 斜面への配慮:
 *  - 地面のサンプル高さは地形 BVH への真下レイキャスト（y=+500 から）で求め、無ければ groundY コールバック
 *  - レイの始点は太陽方向ではなく「上（+Y）」または面の法線方向にずらす（斜面で地形自身に当たらないように）
 *  - 日影図の建物内外判定は建物だけの BVH への真下レイキャスト
 *
 * このモジュールは Node（vitest）でも読み込めるように、DOM を使うものは関数の中でだけ使う
 * （scene.ts は型だけ、textSprite は遅延 import）。
 */
import * as THREE from 'three';
import {
  bakeWorldTriangles,
  buildOccluderFrom,
  heatColor,
  isShadedFrom,
  marchingSegments,
  raycastFirstKind,
  segmentsToPolylines,
  shadowDiagramCore,
  sunHoursGrid,
  sunSamplesForDay,
  throwIfAborted,
  yieldUI,
  type GridResult,
  type Occluder,
  type OccluderPart,
  type ShadowDiagram,
  type ShadowOutline,
  type SunSample,
} from '../sun/analysis';
import { localDate, sunPosition, sunriseSunset, trueSolarToLocal } from '../sun/solar';
import { horizonElevation, type HorizonProfile } from './terrain';
import type { StudyScene } from './scene';
import type { MeasurePoint, MeasureResult, StudyDate } from './types';

export interface OccluderOpts {
  terrain: boolean;
  neighbors: boolean;
  building: boolean;
}

/** 日付（ローカル）と場所 */
export interface StudyDay {
  year: number;
  month: number;
  day: number;
  lat: number;
  lon: number;
}

/** 地面のサンプル点を地形面から持ち上げる量 (m)。太陽方向ではなく +Y にずらす */
export const GROUND_LIFT = 0.15;
/** 面のサンプル点を法線方向に浮かせる量 (m) */
export const SURFACE_LIFT = 0.02;
/** 真下レイキャストの始点の高さ (m) と到達距離 */
const DOWN_FROM = 500;
const DOWN_FAR = 1500;
const DOWN = new THREE.Vector3(0, -1, 0);

// ---------------------------------------------------------------------------
// 解析用の日付（二十四節気）
// ---------------------------------------------------------------------------

const JST = 9;

/** 赤緯（度）。場所には依存しない */
function declinationAt(ms: number): number {
  return sunPosition(new Date(ms), 35, 135).declination;
}

/** [a, b] (ms) で f の符号が変わる時刻を二分探索（f(a) と f(b) の符号が異なること） */
function bisectMs(f: (ms: number) => number, a: number, b: number): number {
  let fa = f(a);
  for (let i = 0; i < 44; i++) {
    const m = (a + b) / 2;
    const fm = f(m);
    if (fa * fm <= 0) b = m;
    else {
      a = m;
      fa = fm;
    }
  }
  return (a + b) / 2;
}

function jstMonthDay(ms: number): { month: number; day: number } {
  const d = new Date(ms + JST * 3600000);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * 解析用の日付（冬至・春分・夏至・秋分）。赤緯の零点（春分・秋分）と極値（夏至・冬至）を二分探索で求め、
 * JST の日付にする（年によって 1 日ずれる: 例 2027 年の春分は 3/21）。
 */
export function studyDates(year: number): StudyDate[] {
  const utc = (m: number, d: number) => Date.UTC(year, m - 1, d);
  const h = 3600000;
  // 極値は赤緯の時間微分（中心差分）の零点
  const slope = (ms: number) => declinationAt(ms + h) - declinationAt(ms - h);
  const spring = bisectMs(declinationAt, utc(3, 14), utc(3, 27)); // − → +
  const summer = bisectMs(slope, utc(6, 14), utc(6, 28)); // 増加 → 減少
  const autumn = bisectMs(declinationAt, utc(9, 16), utc(9, 29)); // + → −
  const winter = bisectMs(slope, utc(12, 14), utc(12, 28)); // 減少 → 増加
  const mk = (id: string, label: string, ms: number): StudyDate => ({ id, label, year, ...jstMonthDay(ms) });
  return [mk('winter', '冬至', winter), mk('spring', '春分', spring), mk('summer', '夏至', summer), mk('autumn', '秋分', autumn)];
}

// ---------------------------------------------------------------------------
// 遮蔽物（BVH）
// ---------------------------------------------------------------------------

/** 解析用の遮蔽物。extra に地形（キャッシュ）が入る */
export interface StudyOccluder extends Occluder {
  /** true なら bvh / mesh はキャッシュされた地形のもの（disposeStudyOccluder では解放しない） */
  cached?: boolean;
}

let terrainCache: { key: string; occ: Occluder } | null = null;

/** 解析から除くメッシュ: ガラス等（noShadow）と解析結果の表示（overlay） */
function studyMeshFilter(m: THREE.Mesh): boolean {
  return !m.userData.noShadow && !m.userData.overlay;
}

/** 地形グループの内容を表すキー（メッシュ・geometry の uuid と配置） */
function terrainKey(scene: StudyScene): string {
  const g = scene.groups.terrain;
  g.updateMatrixWorld(true);
  const parts: string[] = [];
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible || !studyMeshFilter(m)) return;
    const e = m.matrixWorld.elements;
    parts.push(`${m.uuid}:${m.geometry.uuid}:${e[12].toFixed(3)},${e[13].toFixed(3)},${e[14].toFixed(3)}`);
  });
  return parts.join('|');
}

/** 地形のキャッシュを解放する（周辺環境を作り直したときなど。次回の解析で作り直される） */
export function clearStudyOccluderCache(): void {
  if (terrainCache) {
    terrainCache.occ.mesh.geometry.dispose();
    terrainCache = null;
  }
}

/**
 * 地形だけの遮蔽物（キャッシュ。地形は大きく、変わることが少ない）。地形メッシュが無ければ null。
 * 返り値を dispose しないこと（clearStudyOccluderCache を使う）
 */
export function terrainOccluder(scene: StudyScene): Occluder | null {
  const key = terrainKey(scene);
  if (!key) {
    clearStudyOccluderCache();
    return null;
  }
  if (terrainCache && terrainCache.key === key) return terrainCache.occ;
  clearStudyOccluderCache();
  const occ = buildOccluderFrom([{ root: scene.groups.terrain, kind: 'terrain' }], studyMeshFilter);
  terrainCache = { key, occ };
  return occ;
}

/**
 * シーン内の影を落とす物体から BVH を作る。
 * 建物・周辺建物は小さい BVH を毎回作り、地形はキャッシュしたものを extra に付ける。
 * 種別: 'terrain' | 'neighbor' | 'building'（raycastFirstKind で引ける）
 */
export function buildStudyOccluder(scene: StudyScene, opts: OccluderOpts): StudyOccluder {
  const parts: OccluderPart[] = [];
  if (opts.building) parts.push({ root: scene.groups.building, kind: 'building' });
  if (opts.neighbors) parts.push({ root: scene.groups.neighbors, kind: 'neighbor' });
  const terr = opts.terrain ? terrainOccluder(scene) : null;
  if (!parts.length && terr) return { ...terr, cached: true };
  const occ: StudyOccluder = buildOccluderFrom(parts, studyMeshFilter);
  if (terr) occ.extra = [terr];
  return occ;
}

/** origin から dir（太陽方向）に遮蔽物があるか。始点はずらさない（occ.extra の地形も判定） */
export function isShadedStudy(occ: Occluder, origin: THREE.Vector3, dir: THREE.Vector3, far = 2000): boolean {
  return isShadedFrom(occ, origin, dir, far);
}

/** buildStudyOccluder の結果を解放する（キャッシュされた地形は解放しない） */
export function disposeStudyOccluder(occ: StudyOccluder): void {
  if (!occ.cached) occ.mesh.geometry.dispose();
}

const _down = new THREE.Vector3();

/**
 * 地形面の高さを真下レイキャストで求める関数を返す。地形メッシュが無い／当たらない場所は fallback(x, z)。
 * 毎回呼ぶより、1 回の解析で 1 つ作って使い回す（地形 BVH はキャッシュ）
 */
export function groundSampler(scene: StudyScene, fallback: (x: number, z: number) => number): (x: number, z: number) => number {
  const terr = terrainOccluder(scene);
  if (!terr) return fallback;
  return (x, z) => {
    _down.set(x, DOWN_FROM, z);
    const hit = raycastFirstKind(terr, _down, DOWN, DOWN_FAR);
    return hit && hit.kind === 'terrain' ? hit.point.y : fallback(x, z);
  };
}

/** 地平線（遠方の地形）より低い時刻を除く */
function aboveHorizon(samples: SunSample[], horizon?: HorizonProfile | null): SunSample[] {
  if (!horizon) return samples;
  return samples.filter((s) => s.elev > horizonElevation(horizon, s.az));
}

// ---------------------------------------------------------------------------
// 地面の日照時間マップ
// ---------------------------------------------------------------------------

/**
 * 地面（地形面の 15cm 上）の日照時間マップ。範囲は center ± half (m)、cell (m) 間隔。
 * 地形の高さは地形 BVH への真下レイキャスト、無ければ groundY(x, z)。
 * horizon があれば、その方位の地平線より低い太陽は日影として扱う。
 */
export async function groundSunHoursStudy(
  scene: StudyScene,
  day: StudyDay,
  opts: {
    center: THREE.Vector3;
    half?: number;
    cell?: number;
    stepMin?: number;
    groundY: (x: number, z: number) => number;
    horizon?: HorizonProfile | null;
    onProgress?: (r: number) => void;
    signal?: AbortSignal;
  },
): Promise<GridResult> {
  const half = opts.half ?? 22;
  const cell = opts.cell ?? 0.5;
  const stepMin = opts.stepMin ?? 10;
  const nx = Math.ceil((half * 2) / cell);
  const nz = nx;
  const occ = buildStudyOccluder(scene, { terrain: true, neighbors: true, building: true });
  try {
    const samples = aboveHorizon(sunSamplesForDay({ ...day, northAngleDeg: 0 }, { stepMin, minElev: 0.5, centered: true }), opts.horizon);
    const ground = groundSampler(scene, opts.groundY);
    const c = opts.center;
    return await sunHoursGrid(occ, samples, { x0: c.x - half, z0: c.z - half, cell, nx, nz }, (x, z) => ground(x, z) + GROUND_LIFT, {
      onProgress: opts.onProgress,
      signal: opts.signal,
      stepHours: stepMin / 60,
      exactOrigin: true,
    });
  } finally {
    disposeStudyOccluder(occ);
  }
}

/** 日照時間マップの色（heatmapMesh と同じ canvas）。mask(x,z)=false は透明 */
function heatTexture(g: GridResult, maxHours: number, mask?: (x: number, z: number) => boolean): THREE.CanvasTexture {
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
  return tex;
}

/**
 * 日照時間マップの面（地形に沿わせるため、各頂点を groundY + 0.12 に持ち上げた格子メッシュ。頂点はワールド座標）。
 * mask(x,z)=false の場所は透明（建物の足跡など）。既存 heatColor の配色。userData.maxHours / overlay
 */
export function groundHeatmapMesh(g: GridResult, maxHours: number, groundY: (x: number, z: number) => number, mask?: (x: number, z: number) => boolean): THREE.Mesh {
  const tex = heatTexture(g, maxHours, mask);
  const w = g.nx * g.cell;
  const h = g.nz * g.cell;
  const geo = new THREE.PlaneGeometry(w, h, g.nx, g.nz);
  geo.rotateX(-Math.PI / 2);
  // PlaneGeometry の UV: v=1 が +Y(→ -Z)。flipY=false なので行0 = v0 = +Z 側…を合わせる（heatmapMesh と同じ）
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  geo.translate(g.x0 + w / 2, 0, g.z0 + h / 2);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, groundY(pos.getX(i), pos.getZ(i)) + 0.12);
  pos.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 3;
  mesh.userData.maxHours = maxHours;
  mesh.userData.overlay = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// 建物の面の日照時間
// ---------------------------------------------------------------------------

/** 再現性のある乱数（mulberry32） */
function seeded(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** 面あたりの最大サンプル数と、1 サンプルが受け持つ面積 (m²)（≈0.4m 間隔） */
const FACE_MAX_SAMPLES = 48;
const FACE_AREA_PER_SAMPLE = 0.16;
/** これより多い三角形は 1 面 1 サンプルの粗い解析にする */
const FACE_COARSE_THRESHOLD = 400_000;

/**
 * 建物の面の日照時間。読み込んだ建物（可視・noShadow でない）の各三角形を面積に応じて 1〜48 点サンプルし、
 * 日の出〜日の入を stepMin ごとに太陽方向へレイキャスト（自建物・周辺建物・地形で遮蔽）。
 * 面の向きに関係なく「太陽のある側」から判定する（法線の向きが不揃いなデータでも動く）。
 * 結果は頂点色（面ごとの時間, heatColor）を付けた非インデックス geometry の Mesh。
 * userData: { maxHours（昼の長さ）, facade: true, overlay: true, coarse, faceHours }
 */
export async function facadeSunHours(
  scene: StudyScene,
  day: StudyDay,
  opts: { stepMin?: number; horizon?: HorizonProfile | null; onProgress?: (r: number) => void; signal?: AbortSignal } = {},
): Promise<THREE.Mesh> {
  const stepMin = opts.stepMin ?? 10;
  const step = stepMin / 60;
  const baked = bakeWorldTriangles([{ root: scene.groups.building, kind: 'building' }], studyMeshFilter);
  const n = baked.triangles;
  const pos = baked.positions;
  const coarse = n > FACE_COARSE_THRESHOLD;
  const rs = sunriseSunset(day.year, day.month, day.day, day.lat, day.lon);
  const maxHours = Math.max(0.1, rs.sunset - rs.sunrise);
  const samples = aboveHorizon(sunSamplesForDay({ ...day, northAngleDeg: 0 }, { stepMin, minElev: 0.5, centered: true }), opts.horizon);
  const colors = new Float32Array(n * 9);
  const faceHours = new Float32Array(n);
  const occ = buildStudyOccluder(scene, { terrain: true, neighbors: true, building: true });
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const o = new THREE.Vector3();
  const tri = new THREE.Triangle(a, b, c);
  const col = new THREE.Color();
  let pts = new Float64Array(FACE_MAX_SAMPLES * 3);
  try {
    for (let f = 0; f < n; f++) {
      a.fromArray(pos, f * 9);
      b.fromArray(pos, f * 9 + 3);
      c.fromArray(pos, f * 9 + 6);
      tri.getNormal(nrm);
      let hours = 0;
      if (nrm.lengthSq() > 0 && samples.length) {
        const area = tri.getArea();
        const k = coarse ? 1 : Math.max(1, Math.min(FACE_MAX_SAMPLES, Math.ceil(area / FACE_AREA_PER_SAMPLE)));
        if (pts.length < k * 3) pts = new Float64Array(k * 3);
        // 層化した重心座標（u を k 等分し、各層で乱数）。sqrt で三角形上に一様
        const rnd = seeded(f + 1);
        for (let s = 0; s < k; s++) {
          const u = (s + rnd()) / k;
          const v = rnd();
          const su = Math.sqrt(u);
          const w0 = 1 - su;
          const w1 = v * su;
          const w2 = 1 - w0 - w1;
          pts[s * 3] = a.x * w0 + b.x * w1 + c.x * w2;
          pts[s * 3 + 1] = a.y * w0 + b.y * w1 + c.y * w2;
          pts[s * 3 + 2] = a.z * w0 + b.z * w1 + c.z * w2;
        }
        for (const smp of samples) {
          // 太陽のある側へ法線方向に 2cm 浮かせる（面の向きには依存しない）
          const side = nrm.dot(smp.dir) > 0 ? SURFACE_LIFT : -SURFACE_LIFT;
          let lit = 0;
          for (let s = 0; s < k; s++) {
            o.set(pts[s * 3] + nrm.x * side, pts[s * 3 + 1] + nrm.y * side, pts[s * 3 + 2] + nrm.z * side);
            if (!isShadedStudy(occ, o, smp.dir)) lit++;
          }
          hours += (lit / k) * step;
        }
      }
      faceHours[f] = hours;
      const [r, g, bb] = heatColor(hours / maxHours);
      col.setRGB(r / 255, g / 255, bb / 255, THREE.SRGBColorSpace);
      for (let v = 0; v < 3; v++) {
        colors[f * 9 + v * 3] = col.r;
        colors[f * 9 + v * 3 + 1] = col.g;
        colors[f * 9 + v * 3 + 2] = col.b;
      }
      if (f % 400 === 399) {
        opts.onProgress?.(f / n);
        await yieldUI();
        throwIfAborted(opts.signal);
      }
    }
  } finally {
    disposeStudyOccluder(occ);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, toneMapped: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 2;
  mesh.userData = { maxHours, facade: true, overlay: true, coarse, faceHours };
  opts.onProgress?.(1);
  return mesh;
}

// ---------------------------------------------------------------------------
// 測定点
// ---------------------------------------------------------------------------

/** 連続して日が当たる時刻サンプル（中心 h、幅 step）を区間にまとめ、[from, to] に切り詰める */
function mergeSpans(litH: number[], step: number, from: number, to: number): [number, number][] {
  const spans: [number, number][] = [];
  let s0 = NaN;
  let prev = NaN;
  const flush = () => {
    if (Number.isNaN(s0)) return;
    const lo = Math.max(from, s0 - step / 2);
    const hi = Math.min(to, prev + step / 2);
    if (hi > lo) spans.push([lo, hi]);
  };
  for (const h of litH) {
    if (Number.isNaN(s0) || h - prev > step * 1.5) {
      flush();
      s0 = h;
    }
    prev = h;
  }
  flush();
  return spans;
}

/**
 * 測定点のレイの始点。面の点は法線方向に 2cm。地面の点（法線が上向きで地形面の近く）は
 * 地形 BVH への真下レイキャストで高さを合わせ、さらに +15cm 上げる
 */
function measureOrigin(scene: StudyScene, pos: THREE.Vector3, n: THREE.Vector3, groundY?: (x: number, z: number) => number): THREE.Vector3 {
  const origin = pos.clone().addScaledVector(n, SURFACE_LIFT);
  if (n.y > 0.99) {
    const ground = groundSampler(scene, groundY ?? (() => pos.y));
    const gy = ground(pos.x, pos.z);
    if (Math.abs(gy - pos.y) < 0.5) {
      origin.y = gy + SURFACE_LIFT + GROUND_LIFT;
    } else {
      origin.y += GROUND_LIFT;
    }
  }
  return origin;
}

/**
 * 測定点の日照時間（複数の日付）。日の出〜日の入を stepMin ごとに判定し、
 * 面が太陽を向き（dot(n, dir) > 0）、地平線より高く、遮蔽されない時刻を「日が当たる」とする。
 * spans は連続して日が当たる時間帯 [h0 − step/2, h1 + step/2]（日の出・日の入で切る）、hours はその合計
 */
export async function measurePointHours(
  scene: StudyScene,
  pt: MeasurePoint,
  dates: StudyDate[],
  loc: { lat: number; lon: number },
  opts: { stepMin?: number; horizon?: HorizonProfile | null; groundY?: (x: number, z: number) => number; signal?: AbortSignal } = {},
): Promise<MeasureResult[]> {
  const stepMin = opts.stepMin ?? 5;
  const step = stepMin / 60;
  const occ = buildStudyOccluder(scene, { terrain: true, neighbors: true, building: true });
  try {
    const n = new THREE.Vector3().fromArray(pt.normal);
    if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
    n.normalize();
    const pos = new THREE.Vector3().fromArray(pt.pos);
    const origin = measureOrigin(scene, pos, n, opts.groundY);
    const out: MeasureResult[] = [];
    for (const d of dates) {
      throwIfAborted(opts.signal);
      const rs = sunriseSunset(d.year, d.month, d.day, loc.lat, loc.lon);
      const samples = sunSamplesForDay({ year: d.year, month: d.month, day: d.day, lat: loc.lat, lon: loc.lon, northAngleDeg: 0 }, { stepMin, minElev: 0, centered: true });
      const litH: number[] = [];
      for (const s of samples) {
        if (n.dot(s.dir) <= 0) continue;
        if (opts.horizon && s.elev <= horizonElevation(opts.horizon, s.az)) continue;
        if (isShadedStudy(occ, origin, s.dir)) continue;
        litH.push(s.h);
      }
      const spans = mergeSpans(litH, step, rs.sunrise, rs.sunset);
      const hours = spans.reduce((acc, [a, b]) => acc + (b - a), 0);
      out.push({
        dateId: d.id,
        dateLabel: d.label,
        month: d.month,
        day: d.day,
        hours,
        first: spans.length ? spans[0][0] : null,
        last: spans.length ? spans[spans.length - 1][1] : null,
        spans,
      });
      await yieldUI();
    }
    return out;
  } finally {
    disposeStudyOccluder(occ);
  }
}

// ---------------------------------------------------------------------------
// 日影図
// ---------------------------------------------------------------------------

/**
 * 日影図（冬至日・真太陽時 hours（既定 8〜16 時）・測定面 y = planeHeight の水平面。呼び出し側で 平均地盤面 + h を渡す）。
 *  - 遮蔽物: 建物（+ includeNeighbors なら周辺建物、+ includeTerrain なら地形）
 *  - 建物の内外は「建物だけの BVH」への真下レイキャストで判定し、その輪郭をマーチングスクエアで描く
 *  - half 省略時: max(34, (建物の最高高さ − 測定面) / tan(時間帯の最低太陽高度) + 6) を 34〜90 に収める。cell は 0.3（half > 60 なら 0.5）
 *  - 敷地境界: sitePolygon（ワールド XZ）があればその多角形。無ければ描かず、5m/10m ラインも省く
 */
export async function shadowDiagramStudy(
  scene: StudyScene,
  p: {
    lat: number;
    lon: number;
    year: number;
    planeHeight: number;
    includeNeighbors: boolean;
    includeTerrain?: boolean;
    center: THREE.Vector3;
    half?: number;
    sitePolygon: THREE.Vector2[] | null;
    /** 真太陽時の範囲 (h)。省略時 [8, 16] */
    hours?: [number, number];
    onProgress?: (r: number) => void;
    signal?: AbortSignal;
  },
): Promise<ShadowDiagram> {
  const Y = p.year;
  const M = 12;
  const D = 22;
  const [H0, H1] = p.hours ?? [8, 16];
  const planeHeight = p.planeHeight;
  // 範囲: 建物の最高高さと時間帯の最低太陽高度から影の長さを見積もる
  let half = p.half;
  if (half === undefined) {
    const box = new THREE.Box3().setFromObject(scene.groups.building);
    const buildingTop = box.isEmpty() ? planeHeight : box.max.y;
    let minElev = Infinity;
    for (let s = H0; s <= H1 + 1e-9; s += 0.5) {
      const lh = trueSolarToLocal(Y, M, D, s, p.lon);
      const el = sunPosition(localDate(Y, M, D, lh), p.lat, p.lon).elevation;
      if (el > 0) minElev = Math.min(minElev, el);
    }
    const len = Number.isFinite(minElev) && minElev > 0.5 ? Math.max(0, buildingTop - planeHeight) / Math.tan((minElev * Math.PI) / 180) + 6 : 90;
    half = Math.min(90, Math.max(34, len));
  }
  const cell = half > 60 ? 0.5 : 0.3;
  const nx = Math.ceil((half * 2) / cell);
  const nz = nx;
  const x0 = p.center.x - half;
  const z0 = p.center.z - half;
  const buildingOnly = buildStudyOccluder(scene, { terrain: false, neighbors: false, building: true });
  const occ = buildStudyOccluder(scene, { terrain: !!p.includeTerrain, neighbors: p.includeNeighbors, building: true });
  try {
    // 建物の内外（真下レイキャスト）
    const mask = new Float32Array(nx * nz);
    const o = new THREE.Vector3();
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        o.set(x0 + (i + 0.5) * cell, DOWN_FROM, z0 + (j + 0.5) * cell);
        if (raycastFirstKind(buildingOnly, o, DOWN, DOWN_FAR)) mask[j * nx + i] = 1;
      }
      if (j % 16 === 15) {
        await yieldUI();
        throwIfAborted(p.signal);
      }
    }
    const insideBuilding = (x: number, z: number) => {
      const i = Math.floor((x - x0) / cell);
      const j = Math.floor((z - z0) / cell);
      if (i < 0 || j < 0 || i >= nx || j >= nz) return false;
      return mask[j * nx + i] === 1;
    };
    const outlines: ShadowOutline[] = segmentsToPolylines(marchingSegments(mask, nx, nz, 0.5)).map((pl) => ({
      points: pl.points.map((q) => ({ x: x0 + (q.x + 0.5) * cell, y: z0 + (q.y + 0.5) * cell })),
      closed: pl.closed,
      fill: true,
    }));
    const site = p.sitePolygon && p.sitePolygon.length >= 3 ? { polygon: p.sitePolygon.map((v) => ({ x: v.x, y: v.y })) } : null;
    const note = (p.includeNeighbors ? '※周辺建物を含みます' : '※周辺建物は含みません') + (p.includeTerrain ? '（地形の影を含む）' : '');
    return await shadowDiagramCore({
      occ,
      lat: p.lat,
      lon: p.lon,
      northAngleDeg: 0,
      year: Y,
      planeHeight,
      center: { x: p.center.x, z: p.center.z },
      half,
      cell,
      stepMin: 10,
      hours: p.hours,
      insideBuilding,
      outlines,
      site,
      note,
      onProgress: p.onProgress,
      signal: p.signal,
    });
  } finally {
    disposeStudyOccluder(buildingOnly);
    disposeStudyOccluder(occ);
  }
}

// ---------------------------------------------------------------------------
// 測定点のマーカー
// ---------------------------------------------------------------------------

/**
 * 測定点のマーカー（球 + 番号ラベル）。userData.pointId（グループ・球・ラベルすべて）。
 * ラベルは textSprite を遅延 import して付けるので一瞬遅れて現れる（onReady で再描画できる）
 */
export function measureMarker(pt: MeasurePoint, index: number, onReady?: () => void): THREE.Object3D {
  const g = new THREE.Group();
  g.name = `measure:${pt.id}`;
  g.position.fromArray(pt.pos);
  g.userData.pointId = pt.id;
  g.renderOrder = 6;
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.18, 20, 14), new THREE.MeshBasicMaterial({ color: '#ff8f1f', toneMapped: false }));
  sphere.castShadow = false;
  sphere.receiveShadow = false;
  sphere.renderOrder = 6;
  sphere.userData.pointId = pt.id;
  g.add(sphere);
  // DOM（canvas）を使うので遅延 import（このモジュールを Node でも読み込めるように）
  import('../sun/context')
    .then(({ textSprite }) => {
      const sp = textSprite(`${index + 1}`, { size: 40, color: '#fff', bg: '#ff8f1f', scale: 0.9 });
      sp.position.set(0, 0.5, 0);
      sp.renderOrder = 6;
      sp.userData.pointId = pt.id;
      g.add(sp);
      onReady?.();
    })
    .catch(() => {});
  return g;
}
