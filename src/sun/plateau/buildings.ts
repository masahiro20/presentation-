/**
 * 復号したタイルを建物 1 棟ずつに分ける（純関数。テストの中核）: 記録読み・ECEF → anchor 基準の局所座標・ジオイド検査・
 * 底面輪郭（穴・島）・屋根先頭ソート・batchTable との照合。
 *
 * splitBuildings の手順: 頂点ごとに P = center + gltfToEcefAxes(p) → ecefToGeodetic → anchor 基準の (e, n) = toLocal(lat, lon, anchor.lat, anchor.lon)、
 * y = h − minEllipH_b。geoid_b = minEllipH_b − zmin_b、タイル中央値との差 > 0.5 m なら warnings: ['baseMismatch']
 * （葉だけ読む設計では起きない。root・深さ 1〜2 の簡略形状（名古屋 data55）で検出する）。
 * 三角形は batch ごとに非インデックス化し sortRoofFirst。足元は footprintFromBottomFaces（§6）。
 * keep が false の batch は復号結果を捨てる（分割・輪郭の計算をしない。ジオイドの中央値も keep した棟だけで取る）。
 * gml_id が無い batch は `tile:${meta.tileUrl}#${batchId}`（tileUrl が無ければ RTC center で代用）を gmlId にする。
 * anchor は _x/_y だが、局所座標が保存形（Int16 cm = ±327 m）に収まらない長大な構造物は足元輪郭の重心に取り直す。
 *
 * 座標の約束（types.ts）: 局所座標は右手系 x=東, y=上, z=−北 [m]。幾何法線は (B−A)×(C−A) で計算する（復号 normal は使わない。
 * 左手系で計算すると下向き判定が全滅するので注意）。実測: PLATEAU の面は 97 % が外向き、頂点共有は無し（faces×3/verts = 1.00）。
 * 仕様: scratchpad/plateau-spec.md §2.6・§6（W5 が実装）
 */
import { convexHull } from '../align';
import { cleanRing, pointInRing, ringArea, ringCenter } from '../footprint';
import { metersPerDegree, toLocal } from '../geo';
import { ecefToGeodetic, gltfToEcefAxes } from '../geodesy';
import type { B3dm, BatchTable } from './b3dm';
import type { DecodedTile, EN, FootprintKind, NeighborMesh, PlateauAttrs, PlateauBuilding } from './types';

export interface SplitOptions {
  /** 屋根とみなす幾何法線の y の下限（既定 0.5） */
  roofUpMin?: number;
  /** 底面とみなす幾何法線の y の上限（既定 −0.7） */
  bottomDownMax?: number;
  /** 底面三角形は最低点からこの高さ以内（既定 0.5 m） */
  bottomTolM?: number;
  /** ジオイド値のタイル中央値からの許容差（既定 0.5 m） */
  geoidMismatchM?: number;
  /** false を返した batch は分割しない */
  keep?: (b: BuildingRecord) => boolean;
}

/** データセット由来の属性（市区・年度・LOD）＋ gml_id の無い batch の gmlId に使うタイルの URL（`tile:${tileUrl}#${batchId}`。無ければ RTC center で代用） */
export type SplitMeta = Pick<PlateauAttrs, 'muniCd' | 'pref' | 'city' | 'ward' | 'year' | 'datasetLod'> & { tileUrl?: string };

/** batchTable の 1 棟分（無い列は null） */
export interface BuildingRecord {
  batchId: number;
  gmlId: string | null;
  x: number | null;
  y: number | null;
  xmin: number | null;
  xmax: number | null;
  ymin: number | null;
  ymax: number | null;
  zmin: number | null;
  zmax: number | null;
  lod: number | null;
  measuredHeight: number | null;
  storeys: number | null;
  storeysBelow: number | null;
  usage: string | null;
  name: string | null;
  address: string | null;
  buildingId: string | null;
  lod1HeightType: string | null;
  surveyYear: number | null;
}

/** 既定値（SplitOptions の省略時） */
const ROOF_UP_MIN = 0.5;
const BOTTOM_DOWN_MAX = -0.7;
const BOTTOM_TOL_M = 0.5;
const GEOID_MISMATCH_M = 0.5;
/** 外周がこれより小さい建物は捨てる [m²] */
const MIN_OUTER_AREA = 1;
/** 穴・島として数える閉路の最小面積 [m²]（実測: 世田谷の中庭 5.3 m²。これ未満は三角形分割のノイズ） */
const MIN_LOOP_AREA = 0.5;
/** 辺のキーの丸め（1 mm） */
const EDGE_KEY_SCALE = 1000;
/** 局所座標の水平成分がこれを超える建物は anchor を足元輪郭の重心に取り直す [m]（保存形 Int16 cm の ±327.67 m。meshCodec.ts の QUANTIZE_LIMIT_M） */
const MAX_LOCAL_M = 327;

// ---------------------------------------------------------------------------
// 記録読み
// ---------------------------------------------------------------------------

/** PLATEAU の 3D Tiles（plateau-3dtiles 変換）の batchTable の列名 */
const COL = {
  gmlId: 'gml_id',
  x: '_x',
  y: '_y',
  xmin: '_xmin',
  xmax: '_xmax',
  ymin: '_ymin',
  ymax: '_ymax',
  zmin: '_zmin',
  zmax: '_zmax',
  lod: '_lod',
  measuredHeight: 'bldg:measuredHeight',
  storeys: 'bldg:storeysAboveGround',
  storeysBelow: 'bldg:storeysBelowGround',
  usage: 'bldg:usage',
  name: 'gml:name',
  address: 'bldg:address',
  buildingId: 'uro:BuildingIDAttribute_uro:buildingID',
  lod1HeightType: 'uro:lod1HeightType',
  surveyYear: 'uro:BuildingDetailAttribute_uro:surveyYear',
} as const;

/**
 * batchTable を 1 棟ずつの記録にする（batchLength 件。列が無い・null・NaN は null）。
 * 数値列は numbers()（配列列／バイナリ参照列どちらでも。_lod・measuredHeight はタイルによって形が入れ替わる）、文字列列は strings()。
 * bldg:usage の '不明' は「用途が分からない」なので null にする（ラベルに「不明」を出さない）
 */
export function readBuildingRecords(bt: BatchTable): BuildingRecord[] {
  const n = bt.batchLength;
  const num = (name: string) => bt.numbers(name);
  const str = (name: string) => bt.strings(name);
  const cols = {
    gmlId: str(COL.gmlId),
    x: num(COL.x),
    y: num(COL.y),
    xmin: num(COL.xmin),
    xmax: num(COL.xmax),
    ymin: num(COL.ymin),
    ymax: num(COL.ymax),
    zmin: num(COL.zmin),
    zmax: num(COL.zmax),
    lod: num(COL.lod),
    measuredHeight: num(COL.measuredHeight),
    storeys: num(COL.storeys),
    storeysBelow: num(COL.storeysBelow),
    usage: str(COL.usage),
    name: str(COL.name),
    address: str(COL.address),
    buildingId: str(COL.buildingId),
    lod1HeightType: str(COL.lod1HeightType),
    surveyYear: num(COL.surveyYear),
  };
  const numAt = (col: Float64Array | null, i: number): number | null => (col && i < col.length && Number.isFinite(col[i]) ? col[i] : null);
  const strAt = (col: (string | null)[] | null, i: number): string | null => {
    const v = col && i < col.length ? col[i] : null;
    return v != null && v.trim() !== '' ? v : null;
  };
  const out: BuildingRecord[] = [];
  for (let i = 0; i < n; i++) {
    const usage = strAt(cols.usage, i);
    out.push({
      batchId: i,
      gmlId: strAt(cols.gmlId, i),
      x: numAt(cols.x, i),
      y: numAt(cols.y, i),
      xmin: numAt(cols.xmin, i),
      xmax: numAt(cols.xmax, i),
      ymin: numAt(cols.ymin, i),
      ymax: numAt(cols.ymax, i),
      zmin: numAt(cols.zmin, i),
      zmax: numAt(cols.zmax, i),
      lod: numAt(cols.lod, i),
      measuredHeight: numAt(cols.measuredHeight, i),
      storeys: numAt(cols.storeys, i),
      storeysBelow: numAt(cols.storeysBelow, i),
      usage: usage === '不明' ? null : usage,
      name: strAt(cols.name, i),
      address: strAt(cols.address, i),
      buildingId: strAt(cols.buildingId, i),
      lod1HeightType: strAt(cols.lod1HeightType, i),
      surveyYear: numAt(cols.surveyYear, i),
    });
  }
  return out;
}

/** batchTable に無い batchId（BATCH_LENGTH を超える _batchid）のための空の記録 */
function emptyRecord(batchId: number): BuildingRecord {
  return {
    batchId,
    gmlId: null,
    x: null,
    y: null,
    xmin: null,
    xmax: null,
    ymin: null,
    ymax: null,
    zmin: null,
    zmax: null,
    lod: null,
    measuredHeight: null,
    storeys: null,
    storeysBelow: null,
    usage: null,
    name: null,
    address: null,
    buildingId: null,
    lod1HeightType: null,
    surveyYear: null,
  };
}

// ---------------------------------------------------------------------------
// 三角形の幾何
// ---------------------------------------------------------------------------

/** 三角形 t（tris[9t..9t+8]）の幾何法線（正規化）の y 成分。退化（面積 0）なら 0 */
function triNormalY(tris: Float32Array, t: number): number {
  const o = t * 9;
  const ux = tris[o + 3] - tris[o];
  const uy = tris[o + 4] - tris[o + 1];
  const uz = tris[o + 5] - tris[o + 2];
  const vx = tris[o + 6] - tris[o];
  const vy = tris[o + 7] - tris[o + 1];
  const vz = tris[o + 8] - tris[o + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return len > 0 ? ny / len : 0;
}

/** 三角形 t の平面図（x, z）での面積の絶対値 [m²] */
function triPlanArea(tris: Float32Array, t: number): number {
  const o = t * 9;
  const ux = tris[o + 3] - tris[o];
  const uz = tris[o + 5] - tris[o + 2];
  const vx = tris[o + 6] - tris[o];
  const vz = tris[o + 8] - tris[o + 2];
  return Math.abs(ux * vz - uz * vx) / 2;
}

/** 屋根（幾何法線の y ≥ roofUpMin）の三角形を先頭に並べ替える */
export function sortRoofFirst(tris: Float32Array, roofUpMin: number): NeighborMesh {
  const nTri = Math.floor(tris.length / 9);
  const out = new Float32Array(nTri * 9);
  const isRoof = new Uint8Array(nTri);
  let roofTriangles = 0;
  for (let t = 0; t < nTri; t++) {
    if (triNormalY(tris, t) >= roofUpMin) {
      isRoof[t] = 1;
      roofTriangles++;
    }
  }
  let r = 0;
  let w = roofTriangles;
  for (let t = 0; t < nTri; t++) {
    const dst = isRoof[t] ? r++ : w++;
    out.set(tris.subarray(t * 9, t * 9 + 9), dst * 9);
  }
  return { tris: out, roofTriangles };
}

// ---------------------------------------------------------------------------
// 足元輪郭（§6）
// ---------------------------------------------------------------------------

/** 底面三角形（幾何法線 y < bottomDownMax かつ 3 頂点が minY + bottomTolM 以内）の番号 */
function bottomTriangles(tris: Float32Array, bottomDownMax: number, bottomTolM: number): number[] {
  const nTri = Math.floor(tris.length / 9);
  let minY = Infinity;
  for (let i = 1; i < tris.length; i += 3) if (tris[i] < minY) minY = tris[i];
  const limit = minY + bottomTolM;
  const out: number[] = [];
  for (let t = 0; t < nTri; t++) {
    const o = t * 9;
    if (tris[o + 1] > limit || tris[o + 4] > limit || tris[o + 7] > limit) continue;
    if (triNormalY(tris, t) < bottomDownMax) out.push(t);
  }
  return out;
}

/** 平面図の点（x, z）→ 1 mm に丸めたキー */
const vertexKey = (x: number, z: number) => `${Math.round(x * EDGE_KEY_SCALE)},${Math.round(z * EDGE_KEY_SCALE)}`;
const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const directedKey = (a: string, b: string) => `${a}>${b}`;

/**
 * prev → cur と入ってきた向きに対して最も左（反時計回り側）に曲がる候補を選ぶ。
 * 境界辺は底面の領域を左手に見る向きなので、左に曲がる = 領域の内側に沿って曲がる（穴や隣の棟の辺に乗り換えない）。
 * 真後ろ（折り返し）は最後の候補
 */
function leftmostTurn(points: Map<string, EN>, prev: string, cur: string, cands: string[]): string {
  const p = points.get(prev)!;
  const c = points.get(cur)!;
  const dx = c.e - p.e;
  const dy = c.n - p.n;
  let best = cands[0];
  let bestAngle = -Infinity;
  for (const k of cands) {
    const q = points.get(k)!;
    const ex = q.e - c.e;
    const ey = q.n - c.n;
    let a = Math.atan2(dx * ey - dy * ex, dx * ex + dy * ey); // 左折が正
    if (Math.abs(a) >= Math.PI - 1e-9) a = -Math.PI;
    if (a > bestAngle) {
      bestAngle = a;
      best = k;
    }
  }
  return best;
}

/** 同じ頂点を 2 度通る閉路（8 の字）を、その頂点で切って単純な閉路に分ける */
function splitAtRepeats(path: string[]): string[][] {
  const out: string[][] = [];
  const stack: string[] = [];
  const at = new Map<string, number>();
  for (const k of path) {
    const i = at.get(k);
    if (i !== undefined) {
      // k に戻ってきた: stack[i..] が 1 つの閉路。k 自身は残る側の閉路にも属する
      const sub = stack.splice(i);
      for (const v of sub) at.delete(v);
      out.push(sub);
    }
    at.set(k, stack.length);
    stack.push(k);
  }
  out.push(stack);
  return out;
}

/**
 * 底面三角形の境界辺（使用回数 1 の辺）を向き付きでつないで閉路にする。閉じない鎖は捨てる。
 *  - 各三角形を平面図（e, n）で反時計回りに揃えて辺に向きを付ける → 境界辺は常に「底面の領域を左手に見る」向きになる
 *    （外周は反時計回り・穴は時計回りで出てくる。呼び出し側は符号付き面積で穴と島を区別する）
 *  - 次数 ≥ 4 の頂点（穴が外周と 1 点で接する・2 棟が角で接する）では、入ってきた向きから最も左（領域側）に曲がる辺を選ぶ
 *  - 同じ頂点を 2 度通った閉路（8 の字）は、その頂点で切って単純な閉路に分ける
 *  - 辺のキーは平面図の端点（1 mm 丸め）: 高さの違う底面どうしでも平面で重なる辺は内部の辺として消える
 */
function boundaryLoops(tris: Float32Array, bottom: number[]): EN[][] {
  const edgeCount = new Map<string, number>();
  /** 辺 → 向き付きの端点（a → b。底面を左手に見る） */
  const directed = new Map<string, [string, string]>();
  const points = new Map<string, EN>();
  for (const t of bottom) {
    const o = t * 9;
    const keys: string[] = [];
    const pts: EN[] = [];
    for (let k = 0; k < 3; k++) {
      const x = tris[o + k * 3];
      const z = tris[o + k * 3 + 2];
      const key = vertexKey(x, z);
      if (!points.has(key)) points.set(key, { e: x, n: -z });
      keys.push(key);
      pts.push({ e: x, n: -z });
    }
    // 平面図で時計回りの三角形は逆順にして反時計回りに揃える（底面は下向きなので頂点順はそのままだと時計回り）
    if (ringArea(pts) < 0) keys.reverse();
    for (let k = 0; k < 3; k++) {
      const a = keys[k];
      const b = keys[(k + 1) % 3];
      if (a === b) continue;
      const ek = edgeKey(a, b);
      edgeCount.set(ek, (edgeCount.get(ek) ?? 0) + 1);
      if (!directed.has(ek)) directed.set(ek, [a, b]);
    }
  }
  // 境界辺の出発表（頂点 → 向き付き辺の相手）
  const outgoing = new Map<string, string[]>();
  for (const [ek, c] of edgeCount) {
    if (c !== 1) continue;
    const [a, b] = directed.get(ek)!;
    const l = outgoing.get(a);
    if (l) l.push(b);
    else outgoing.set(a, [b]);
  }
  const used = new Set<string>();
  const loops: EN[][] = [];
  for (const start of outgoing.keys()) {
    for (;;) {
      // start から未使用の辺で出発し、start に戻ってくるまで歩く
      const first = (outgoing.get(start) ?? []).find((b) => !used.has(directedKey(start, b)));
      if (first === undefined) break;
      const path = [start];
      let prev = start;
      let cur = first;
      used.add(directedKey(start, first));
      while (cur !== start) {
        path.push(cur);
        const cands = (outgoing.get(cur) ?? []).filter((b) => !used.has(directedKey(cur, b)));
        if (cands.length === 0) break;
        const next = cands.length === 1 ? cands[0] : leftmostTurn(points, prev, cur, cands);
        used.add(directedKey(cur, next));
        prev = cur;
        cur = next;
      }
      if (cur !== start) continue; // 閉じない鎖
      for (const sub of splitAtRepeats(path)) if (sub.length >= 3) loops.push(sub.map((k) => points.get(k)!));
    }
  }
  return loops;
}

/** 点と線分 ab の距離 */
function distToSegment(p: EN, a: EN, b: EN): number {
  const dx = b.e - a.e;
  const dy = b.n - a.n;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.e - a.e) * dx + (p.n - a.n) * dy) / len2)) : 0;
  return Math.hypot(p.e - (a.e + t * dx), p.n - (a.n + t * dy));
}

/** 点がリングの内側または辺上（tol 以内）か */
function pointInOrOnRing(p: EN, ring: EN[], tol: number): boolean {
  if (pointInRing(p, ring)) return true;
  for (let i = 0; i < ring.length; i++) if (distToSegment(p, ring[i], ring[(i + 1) % ring.length]) <= tol) return true;
  return false;
}

/** 全頂点（x, z）の凸包（東・北）。3 点未満なら [] */
function hullOfVertices(tris: Float32Array, only?: number[]): EN[] {
  const pts: EN[] = [];
  if (only) {
    for (const t of only) for (let k = 0; k < 3; k++) pts.push({ e: tris[t * 9 + k * 3], n: -tris[t * 9 + k * 3 + 2] });
  } else {
    for (let i = 0; i < tris.length; i += 3) pts.push({ e: tris[i], n: -tris[i + 2] });
  }
  return convexHull(pts);
}

/**
 * 底面三角形（幾何法線 y < bottomDownMax かつ最低点 + bottomTolM 以内）の境界辺から閉路を作り、外周・穴・島を決める。
 *  - |面積| 最大の閉路 = 外周（反時計回り・cleanRing(0.05)）
 *  - 副閉路（面積 ≥ 0.5 m²）は向きで見分ける（boundaryLoops は底面の領域を左手に見る向きで返す）:
 *    時計回り かつ 重心が外周の内側 かつ 全頂点が外周の内側または辺上 → 穴（時計回りのまま）。
 *    反時計回りで全頂点が外周の内側または辺上 → 外周と平面で重なる別の高さの底面（外周に含まれる）なので足しも引きもしない。
 *    それ以外の反時計回り（外周の外に頂点を持つ）→ 島（別棟・BuildingPart・一部だけ重なる床）
 *  - 島があれば、全底面頂点の凸包を外周にして kind 'hull'（島を捨てない・穴にしない）
 *  - 底面が無ければ全頂点の凸包（kind 'hull'）。外周 < 1 m² は null
 */
export function footprintFromBottomFaces(tris: Float32Array, opts?: SplitOptions): { outer: EN[]; holes: EN[][]; kind: FootprintKind; islands: number } | null {
  const bottom = bottomTriangles(tris, opts?.bottomDownMax ?? BOTTOM_DOWN_MAX, opts?.bottomTolM ?? BOTTOM_TOL_M);
  if (bottom.length === 0) {
    const hull = cleanRing(hullOfVertices(tris));
    if (hull.length < 3 || ringArea(hull) < MIN_OUTER_AREA) return null;
    return { outer: hull, holes: [], kind: 'hull', islands: 0 };
  }
  const loops = boundaryLoops(tris, bottom)
    .map((l) => cleanRing(l))
    .filter((l) => l.length >= 3)
    .map((l) => ({ ring: l, area: ringArea(l) }))
    .sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  // 最大の閉路が時計回り（外周ではなく穴の向き）になるのは辺の向きが壊れているときだけ: 凸包で代用
  if (loops.length === 0 || loops[0].area < MIN_OUTER_AREA) {
    // 底面はあるのに閉路にならない（辺が食い違う）: 底面頂点の凸包で代用
    const hull = cleanRing(hullOfVertices(tris, bottom));
    if (hull.length < 3 || ringArea(hull) < MIN_OUTER_AREA) return null;
    return { outer: hull, holes: [], kind: 'hull', islands: 0 };
  }
  const outer = loops[0].ring;
  const holes: EN[][] = [];
  let islands = 0;
  const tol = 1 / EDGE_KEY_SCALE;
  for (let i = 1; i < loops.length; i++) {
    const { ring, area } = loops[i];
    if (Math.abs(area) < MIN_LOOP_AREA) continue;
    const contained = ring.every((p) => pointInOrOnRing(p, outer, tol));
    if (area < 0) {
      // 時計回り = 領域を左手に見て穴を回っている。外周の内側にあれば穴（外周の外の穴は島の穴なので島側で数える）
      if (contained && pointInRing(ringCenter(ring), outer)) holes.push(ring);
    } else if (!contained) {
      islands++;
    }
  }
  if (islands > 0) {
    const hull = cleanRing(hullOfVertices(tris, bottom));
    if (hull.length < 3 || ringArea(hull) < MIN_OUTER_AREA) return null;
    return { outer: hull, holes: [], kind: 'hull', islands };
  }
  return { outer, holes, kind: 'bottom', islands: 0 };
}

// ---------------------------------------------------------------------------
// 分割
// ---------------------------------------------------------------------------

export interface SplitResult {
  buildings: PlateauBuilding[];
  /** タイル内のジオイド値（最低楕円体高 − _zmin）の中央値 */
  geoidMedian: number;
  skipped: { batchId: number; reason: 'noTriangles' | 'kept' | 'tooSmall' }[];
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 1 棟分の中間データ */
interface BatchWork {
  rec: BuildingRecord;
  /** 三角形番号（tile.index の 3 つ組） */
  tris: number[];
  /** 三角形の頂点ごとの測地座標（9 × 三角形数の順に lat, lon, h） */
  lat: Float64Array;
  lon: Float64Array;
  h: Float64Array;
  minH: number;
  maxH: number;
}

/** 測地座標 → anchor 基準の局所三角形（x=東, y=上（minH が 0）, z=−北）。水平は toLocal（等距円筒・anchor の緯度の metersPerDegree） */
function localTris(w: BatchWork, anchorLat: number, anchorLon: number): Float32Array {
  const n = w.lat.length;
  const tris = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const { e, n: north } = toLocal(w.lat[i], w.lon[i], anchorLat, anchorLon);
    tris[i * 3] = e;
    tris[i * 3 + 1] = w.h[i] - w.minH;
    tris[i * 3 + 2] = -north;
  }
  return tris;
}

/** 局所座標の (e, n) → 緯度経度（toLocal の逆。anchor の緯度の metersPerDegree） */
function fromLocal(e: number, n: number, anchorLat: number, anchorLon: number): { lat: number; lon: number } {
  const { mLat, mLon } = metersPerDegree(anchorLat);
  return { lat: anchorLat + n / mLat, lon: anchorLon + e / mLon };
}

/** 局所座標の水平成分（|x|・|z|）の最大 [m] */
function planExtent(tris: Float32Array): number {
  let m = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const ax = Math.abs(tris[i]);
    const az = Math.abs(tris[i + 2]);
    if (ax > m) m = ax;
    if (az > m) m = az;
  }
  return m;
}

/**
 * 復号したタイル 1 枚を建物ごとに分ける（手順はファイル先頭）。
 * meta はデータセット由来の属性（市区・年度・LOD）と、gml_id の無い batch の gmlId に使う tileUrl。opts.keep で半径外の棟を分割しないで済ませる
 */
export function splitBuildings(tile: DecodedTile, b3dm: B3dm, meta: SplitMeta, opts?: SplitOptions): SplitResult {
  const roofUpMin = opts?.roofUpMin ?? ROOF_UP_MIN;
  const geoidMismatchM = opts?.geoidMismatchM ?? GEOID_MISMATCH_M;
  const records = readBuildingRecords(b3dm.batchTable);
  const skipped: SplitResult['skipped'] = [];

  // 三角形を batch ごとに集める（batch は先頭の頂点で決める。実データは 3 頂点とも同じ）
  const byBatch = new Map<number, number[]>();
  const nTri = Math.floor(tile.index.length / 3);
  for (let t = 0; t < nTri; t++) {
    const b = tile.batchId[tile.index[t * 3]];
    const l = byBatch.get(b);
    if (l) l.push(t);
    else byBatch.set(b, [t]);
  }
  for (const r of records) if (!byBatch.has(r.batchId)) skipped.push({ batchId: r.batchId, reason: 'noTriangles' });

  // keep で絞ってから測地変換（捨てる棟の頂点は変換しない）
  const [cx, cy, cz] = tile.rtcCenter;
  const works: BatchWork[] = [];
  for (const [batchId, triList] of byBatch) {
    const rec = records[batchId] ?? emptyRecord(batchId);
    if (opts?.keep && !opts.keep(rec)) {
      skipped.push({ batchId, reason: 'kept' });
      continue;
    }
    const n = triList.length * 3;
    const lat = new Float64Array(n);
    const lon = new Float64Array(n);
    const h = new Float64Array(n);
    let minH = Infinity;
    let maxH = -Infinity;
    for (let i = 0; i < triList.length; i++) {
      const t = triList[i];
      for (let k = 0; k < 3; k++) {
        const v = tile.index[t * 3 + k] * 3;
        const [ex, ey, ez] = gltfToEcefAxes(tile.positions[v], tile.positions[v + 1], tile.positions[v + 2]);
        const g = ecefToGeodetic(cx + ex, cy + ey, cz + ez);
        const j = i * 3 + k;
        lat[j] = g.lat;
        lon[j] = g.lon;
        h[j] = g.h;
        if (g.h < minH) minH = g.h;
        if (g.h > maxH) maxH = g.h;
      }
    }
    works.push({ rec, tris: triList, lat, lon, h, minH, maxH });
  }

  // ジオイド値（最低楕円体高 − _zmin）。葉タイルでは一定（±0.015 m）。中央値から外れる棟は簡略形状（内部ノード）の疑い
  const geoids = works.filter((w) => w.rec.zmin != null).map((w) => w.minH - w.rec.zmin!);
  const geoidMedian = median(geoids);

  const buildings: PlateauBuilding[] = [];
  for (const w of works) {
    const { rec } = w;
    // anchor: _x/_y → _xmin.._ymax の中心 → 頂点の平均（後で底面輪郭の重心に置き直す）。
    // _x/_y があっても局所座標が ±MAX_LOCAL_M に収まらない長大な構造物は重心に取り直す（保存形 Int16 cm のため）
    let anchorLat: number;
    let anchorLon: number;
    let provisional = false;
    if (rec.x != null && rec.y != null) {
      anchorLat = rec.y;
      anchorLon = rec.x;
    } else if (rec.xmin != null && rec.xmax != null && rec.ymin != null && rec.ymax != null) {
      anchorLat = (rec.ymin + rec.ymax) / 2;
      anchorLon = (rec.xmin + rec.xmax) / 2;
    } else {
      let sLat = 0;
      let sLon = 0;
      for (let i = 0; i < w.lat.length; i++) {
        sLat += w.lat[i];
        sLon += w.lon[i];
      }
      anchorLat = sLat / w.lat.length;
      anchorLon = sLon / w.lon.length;
      provisional = true;
    }
    let tris = localTris(w, anchorLat, anchorLon);
    let fp = footprintFromBottomFaces(tris, opts);
    if (fp && (provisional || planExtent(tris) > MAX_LOCAL_M)) {
      // 仮の anchor（または範囲外）→ 底面輪郭の重心を anchor にして局所座標を作り直す
      const c = ringCenter(fp.outer);
      const a = fromLocal(c.e, c.n, anchorLat, anchorLon);
      anchorLat = a.lat;
      anchorLon = a.lon;
      tris = localTris(w, anchorLat, anchorLon);
      fp = footprintFromBottomFaces(tris, opts);
    }
    if (!fp) {
      skipped.push({ batchId: rec.batchId, reason: 'tooSmall' });
      continue;
    }

    const warnings: NonNullable<PlateauAttrs['warnings']> = [];
    if (fp.kind === 'hull') warnings.push(fp.islands > 0 ? 'islands' : 'noBottom');
    // 高さ基準: _zmin/_zmax（正標高）。無ければタイルのジオイド中央値で楕円体高から換算
    const geoid = Number.isFinite(geoidMedian) ? geoidMedian : 0;
    const zmin = rec.zmin ?? w.minH - geoid;
    const zmax = rec.zmax ?? zmin + (w.maxH - w.minH);
    if (rec.zmin != null && geoids.length > 1 && Math.abs(w.minH - rec.zmin - geoidMedian) > geoidMismatchM) warnings.push('baseMismatch');

    const lod = rec.lod === 1 || rec.lod === 2 || rec.lod === 3 || rec.lod === 4 ? rec.lod : null;
    const gmlId = rec.gmlId ?? `tile:${meta.tileUrl ?? `rtc(${cx},${cy},${cz})`}#${rec.batchId}`;
    const attrs: PlateauAttrs = {
      gmlId,
      lod,
      datasetLod: meta.datasetLod,
      year: meta.year,
      muniCd: meta.muniCd,
      pref: meta.pref,
      city: meta.city,
      ward: meta.ward,
      anchor: { lat: anchorLat, lon: anchorLon },
      zmin,
      zmax,
      ...(rec.measuredHeight != null ? { measuredHeight: rec.measuredHeight } : {}),
      ...(rec.storeys != null ? { storeys: rec.storeys } : {}),
      ...(rec.storeysBelow != null ? { storeysBelow: rec.storeysBelow } : {}),
      ...(rec.usage != null ? { usage: rec.usage } : {}),
      ...(rec.name != null ? { name: rec.name } : {}),
      ...(rec.address != null ? { address: rec.address } : {}),
      ...(rec.buildingId != null ? { buildingId: rec.buildingId } : {}),
      ...(rec.lod1HeightType != null ? { lod1HeightType: rec.lod1HeightType } : {}),
      ...(rec.surveyYear != null ? { surveyYear: rec.surveyYear } : {}),
      footprint: fp.kind,
      ...(warnings.length ? { warnings } : {}),
    };
    buildings.push({ gmlId, batchId: rec.batchId, attrs, ring: fp.outer, holes: fp.holes, height: zmax - zmin, mesh: sortRoofFirst(tris, roofUpMin) });
  }
  return { buildings, geoidMedian, skipped };
}

// ---------------------------------------------------------------------------
// 照合（テスト・プローブ用）
// ---------------------------------------------------------------------------

/**
 * 分割結果と batchTable の記録の差 [m]:
 *  - extentErrM: mesh の頂点の経緯度の範囲（anchor から toLocal の逆で戻す）と _xmin.._ymax の差の最大
 *  - zminErrM: attrs.zmin と _zmin の差（_zmin があるときは 0。無くてジオイド中央値から求めたときに意味を持つ）
 *  - zmaxErrM: attrs.zmin + mesh の最高点 と _zmax の差（形状の高さが _zmax − _zmin と合うか）
 * 記録に該当する列が無いときは NaN
 */
export function compareWithRecord(b: PlateauBuilding, r: BuildingRecord): { extentErrM: number; zminErrM: number; zmaxErrM: number } {
  const { tris } = b.mesh;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i];
    const y = tris[i + 1];
    const z = tris[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    if (y > maxY) maxY = y;
  }
  const { lat: aLat, lon: aLon } = b.attrs.anchor;
  const { mLat, mLon } = metersPerDegree(aLat);
  // 東西は x、南北は −z（n = −z なので z の最小が北端）
  const lonMin = fromLocal(minX, 0, aLat, aLon).lon;
  const lonMax = fromLocal(maxX, 0, aLat, aLon).lon;
  const latMax = fromLocal(0, -minZ, aLat, aLon).lat;
  const latMin = fromLocal(0, -maxZ, aLat, aLon).lat;
  const hasRect = r.xmin != null && r.xmax != null && r.ymin != null && r.ymax != null;
  const extentErrM = hasRect
    ? Math.max(Math.abs(lonMin - r.xmin!) * mLon, Math.abs(lonMax - r.xmax!) * mLon, Math.abs(latMin - r.ymin!) * mLat, Math.abs(latMax - r.ymax!) * mLat)
    : NaN;
  const zminErrM = r.zmin != null ? Math.abs(b.attrs.zmin - r.zmin) : NaN;
  const zmaxErrM = r.zmax != null ? Math.abs(b.attrs.zmin + maxY - r.zmax) : NaN;
  return { extentErrM, zminErrM, zmaxErrM };
}
