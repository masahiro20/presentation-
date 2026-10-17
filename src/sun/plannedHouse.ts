/**
 * 想定の家（未建築の隣家）: 分譲地などで隣の家がまだ建っていないときに「建った想定」で置く仮の建物（共有の純粋な計算）。
 * 日照ツール（src/sunstudy）とプレゼン側（src/sun/context.ts）の両方から使う。DOM は使わない（three.js はジオメトリを作るところだけ）。
 *
 * 座標: EN（e: 東 +, n: 北 +, m）。どの基準から測った EN かは呼び出し側が決める（日照ツールはピンから、プレゼン側は建物の中心から）。
 *
 * 家の形（PlannedHouse）:
 *  - 足元は (ce, cn) を中心にした width × depth の長方形。width の軸（棟の向き・長手）は方位 rotDeg（真北から時計回り）を向く。
 *    depth の軸は width の軸を反時計回りに 90° 回した向き（方位 rotDeg − 90°）。例: rotDeg = 90 なら width は東西、+depth は北。
 *  - 高さは足元の地盤（baseY）から: eaveHeight = 壁の線での屋根の上面の高さ（軒の高さ）、ridgeHeight = いちばん高い所（最高高さ）。
 *  - 屋根: gable 切妻（棟は width の軸に沿って depth/2 の所。妻壁は棟まで）、hip 寄棟（棟の長さ = width − depth、0 以下なら方形 = ピラミッド）、
 *    shed 片流れ（+depth 側が高い。軒の出を含めた高い側の端が ridgeHeight）、flat 陸屋根（箱。ridgeHeight = eaveHeight）。
 *  - 軒の出（既定 0.45 m）は屋根の板（厚さ 0.15 m）として四周に出す（影に入る）。陸屋根には付けない。
 *
 * ジオメトリ（buildPlannedHouseGeometry）: インデックスなし・面ごとの法線・外向きの巻き。閉じた殻が 2 つ（壁の本体と屋根の板。陸屋根は 1 つ）で、
 * 本体の上面は屋根の板の下面と重なる（外からは見えない）。グループ: 0 = 屋根（materialIndex 0）、1 = 壁（materialIndex 1）。
 * new THREE.Mesh(geo, [roofMat, wallMat]) で塗り分ける（周辺建物の ExtrudeGeometry の [屋根, 壁] と同じ並び）。
 */
import * as THREE from 'three';
import { distPointSegment, dominantAngleDeg, minAreaRect, pointInPolygon, polygonArea, type EN } from './align';

export type { EN };

// ---------------------------------------------------------------------------
// 型・定数
// ---------------------------------------------------------------------------

export type RoofType = 'gable' | 'hip' | 'shed' | 'flat';
export const ROOF_TYPES: readonly RoofType[] = ['gable', 'hip', 'shed', 'flat'];
export const ROOF_LABEL: Readonly<Record<RoofType, string>> = { gable: '切妻', hip: '寄棟', shed: '片流れ', flat: '陸屋根' };

export type PlannedPresetId = 'hiraya' | 'gable2' | 'shed2' | 'hip2' | 'flat3' | 'apartment2' | 'box';

export interface PlannedPreset {
  id: PlannedPresetId;
  /** 選択肢の名前 */
  label: string;
  /** 棟の向き（長手）の長さ (m) */
  width: number;
  depth: number;
  /** 軒の高さ (m)。片流れは低い側 */
  eaveHeight: number;
  /** 最高高さ (m)。片流れは高い側 */
  ridgeHeight: number;
  roof: RoofType;
}

export interface PlannedHouse {
  id: string;
  /** 足元の中心（呼び出し側の EN, m） */
  ce: number;
  cn: number;
  /** 棟の向き（長手）の長さ (m) */
  width: number;
  /** 奥行き (m) */
  depth: number;
  /** width の軸の方位（真北から時計回り, 度） */
  rotDeg: number;
  /** 軒の高さ（壁の線での屋根の上面, m）。片流れは低い側 */
  eaveHeight: number;
  /** 最高高さ (m)。陸屋根は eaveHeight と同じ */
  ridgeHeight: number;
  roof: RoofType;
  /** 元にしたプリセット（任意） */
  preset?: PlannedPresetId;
  /** 名前（任意。無ければ「想定の家」） */
  label?: string;
}

/** 想定の家のプリセット（寸法は一般的な建売・分譲住宅の目安） */
export const PLANNED_PRESETS: readonly PlannedPreset[] = [
  { id: 'hiraya', label: '平屋（切妻）', width: 12, depth: 8, eaveHeight: 3.0, ridgeHeight: 5.0, roof: 'gable' },
  { id: 'gable2', label: '2 階建て（切妻）', width: 9.1, depth: 7.3, eaveHeight: 6.0, ridgeHeight: 8.5, roof: 'gable' },
  { id: 'shed2', label: '2 階建て（片流れ）', width: 9.1, depth: 7.3, eaveHeight: 5.5, ridgeHeight: 7.5, roof: 'shed' },
  { id: 'hip2', label: '2 階建て（寄棟）', width: 9.1, depth: 7.3, eaveHeight: 6.0, ridgeHeight: 8.0, roof: 'hip' },
  { id: 'flat3', label: '3 階建て（陸屋根）', width: 8, depth: 8, eaveHeight: 9.5, ridgeHeight: 9.5, roof: 'flat' },
  { id: 'apartment2', label: 'アパート 2 階（陸屋根）', width: 16, depth: 9, eaveHeight: 7.0, ridgeHeight: 7.0, roof: 'flat' },
  { id: 'box', label: '箱（高さだけ）', width: 8, depth: 8, eaveHeight: 7, ridgeHeight: 7, roof: 'flat' },
];
export const PLANNED_PRESET_IDS: readonly PlannedPresetId[] = PLANNED_PRESETS.map((p) => p.id);
/** 既定のプリセット（2 階建て・切妻） */
export const DEFAULT_PLANNED_PRESET: PlannedPresetId = 'gable2';
/** 名前が無いときの表示 */
export const PLANNED_DEFAULT_LABEL = '想定の家';
/** 色（壁・屋根）。半透明にしない（影を落とす実体として見せる） */
export const PLANNED_COLORS = { wall: '#cfdcec', roof: '#6f8fb3' } as const;
/** ジオメトリのグループ（materialIndex） */
export const PLANNED_GROUP_ROOF = 0;
export const PLANNED_GROUP_WALL = 1;
/** 軒の出 (m) */
export const PLANNED_EAVE_OVERHANG = 0.45;
/** 屋根の板の厚さ (m)。壁の上端は屋根の上面より この分だけ下 */
export const PLANNED_ROOF_THICKNESS = 0.15;
/** 寸法の下限・上限 (m) */
export const PLANNED_MIN_SIZE = 1;
export const PLANNED_MAX_SIZE = 300;
/** 高さの下限 (m) */
export const PLANNED_MIN_HEIGHT = 1;
/** houseInLot が置く家の最小寸法 (m)。これより小さくしか入らない敷地では null */
export const PLANNED_MIN_LOT_HOUSE = 3;
/** 名前の長さの上限（文字） */
export const PLANNED_LABEL_MAX = 40;
/** 屋根の勾配（寸）の上限。15 寸 ≈ 56°（急勾配の屋根の上限として十分） */
export const PITCH_MAX_SUN = 15;

/**
 * 勾配の水平距離 [m]（ジオメトリと同じ約束: 切妻・寄棟は棟が中央なので奥行の半分、片流れは高い側の端が最高高さなので 奥行 + 軒の出）。
 * 陸屋根は null
 */
export function pitchRun(h: Pick<PlannedHouse, 'roof' | 'depth'>): number | null {
  if (h.roof === 'flat') return null;
  return h.roof === 'shed' ? h.depth + PLANNED_EAVE_OVERHANG : h.depth / 2;
}

/** 今の屋根の勾配（寸 = 水平 10 に対する立ち上がり。0.1 寸に丸める）。陸屋根は 0 */
export function pitchSun(h: Pick<PlannedHouse, 'roof' | 'depth' | 'eaveHeight' | 'ridgeHeight'>): number {
  const run = pitchRun(h);
  if (run == null || run <= 0) return 0;
  return Math.max(0, Math.round(((h.ridgeHeight - h.eaveHeight) / run) * 10 * 10) / 10);
}

/**
 * 勾配（寸）から最高高さ [m] を決める: 軒高 + 水平距離 × 寸 ÷ 10（0.01 m に丸め、PLANNED_MAX_SIZE まで）。
 * 陸屋根・負の値・数でなければ null。0 寸は最高高さ = 軒高
 */
export function ridgeFromPitch(h: Pick<PlannedHouse, 'roof' | 'depth' | 'eaveHeight'>, sun: number): number | null {
  const run = pitchRun(h);
  if (run == null || !Number.isFinite(sun) || sun < 0) return null;
  const s = Math.min(PITCH_MAX_SUN, sun);
  return Math.round(Math.min(PLANNED_MAX_SIZE, h.eaveHeight + (run * s) / 10) * 100) / 100;
}

/** プリセット（知らない id なら既定の 2 階建て・切妻） */
export function plannedPreset(id: PlannedPresetId | string | undefined | null): PlannedPreset {
  return PLANNED_PRESETS.find((p) => p.id === id) ?? PLANNED_PRESETS.find((p) => p.id === DEFAULT_PLANNED_PRESET)!;
}

export function isPlannedPresetId(v: unknown): v is PlannedPresetId {
  return typeof v === 'string' && (PLANNED_PRESET_IDS as readonly string[]).includes(v);
}

export function isRoofType(v: unknown): v is RoofType {
  return typeof v === 'string' && (ROOF_TYPES as readonly string[]).includes(v);
}

let plannedSeq = 0;
/** 新しい想定の家の id（'planned:<時刻>:<連番>'） */
export function newPlannedId(): string {
  plannedSeq++;
  return `planned:${Date.now().toString(36)}:${plannedSeq.toString(36)}`;
}

// ---------------------------------------------------------------------------
// 形
// ---------------------------------------------------------------------------

/** width の軸（u）と depth の軸（v。u を反時計回りに 90°）の単位ベクトル（EN） */
export function plannedAxes(rotDeg: number): { u: EN; v: EN } {
  const r = (rotDeg * Math.PI) / 180;
  const u = { e: Math.sin(r), n: Math.cos(r) };
  return { u, v: { e: -u.n, n: u.e } };
}

/** 家の局所座標（u: width の軸, v: depth の軸。中心が 0）→ EN */
export function plannedLocalToEN(h: Pick<PlannedHouse, 'ce' | 'cn' | 'rotDeg'>, u: number, v: number): EN {
  const ax = plannedAxes(h.rotDeg);
  return { e: h.ce + u * ax.u.e + v * ax.v.e, n: h.cn + u * ax.u.n + v * ax.v.n };
}

/** 足元の 4 隅（反時計回り）: (−w/2, −d/2) → (+w/2, −d/2) → (+w/2, +d/2) → (−w/2, +d/2) */
export function plannedFootprint(h: Pick<PlannedHouse, 'ce' | 'cn' | 'rotDeg' | 'width' | 'depth'>): EN[] {
  const a = h.width / 2;
  const b = h.depth / 2;
  return [plannedLocalToEN(h, -a, -b), plannedLocalToEN(h, a, -b), plannedLocalToEN(h, a, b), plannedLocalToEN(h, -a, b)];
}

const finite = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 値を整える（保存データ・入力欄の値に使う）: 数値は有限値だけ（無ければプリセット・既定の値）、寸法は 1〜300 m、
 * 高さは 1 m 以上、棟 ≥ 軒、陸屋根は棟 = 軒、方位は [0, 360)、知らない屋根の形は切妻、知らないプリセットは外す、
 * 名前は前後の空白を落として 40 文字まで（空なら外す）、id が無ければ新しく作る。元のオブジェクトは変えない
 */
export function clampHouse(raw: Partial<PlannedHouse> | Record<string, unknown> | null | undefined): PlannedHouse {
  const h = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const p = plannedPreset(isPlannedPresetId(h.preset) ? h.preset : DEFAULT_PLANNED_PRESET);
  const roof: RoofType = isRoofType(h.roof) ? h.roof : p.roof;
  const width = clampN(finite(h.width, p.width), PLANNED_MIN_SIZE, PLANNED_MAX_SIZE);
  const depth = clampN(finite(h.depth, p.depth), PLANNED_MIN_SIZE, PLANNED_MAX_SIZE);
  const eave = clampN(finite(h.eaveHeight, p.eaveHeight), PLANNED_MIN_HEIGHT, PLANNED_MAX_SIZE);
  const ridge = roof === 'flat' ? eave : clampN(Math.max(eave, finite(h.ridgeHeight, Math.max(eave, p.ridgeHeight))), PLANNED_MIN_HEIGHT, PLANNED_MAX_SIZE);
  const rot = ((finite(h.rotDeg, 0) % 360) + 360) % 360;
  const out: PlannedHouse = {
    id: typeof h.id === 'string' && h.id ? h.id : newPlannedId(),
    ce: finite(h.ce, 0),
    cn: finite(h.cn, 0),
    width,
    depth,
    rotDeg: rot >= 360 - 1e-12 ? 0 : rot,
    eaveHeight: eave,
    ridgeHeight: ridge,
    roof,
  };
  if (isPlannedPresetId(h.preset)) out.preset = h.preset;
  const label = typeof h.label === 'string' ? h.label.trim().slice(0, PLANNED_LABEL_MAX) : '';
  if (label) out.label = label;
  return out;
}

/** プリセットの家を (ce, cn) に方位 rotDeg で置く（id・名前は任意） */
export function houseFromPreset(id: PlannedPresetId, ce: number, cn: number, rotDeg: number, opts: { id?: string; label?: string } = {}): PlannedHouse {
  const p = plannedPreset(id);
  return clampHouse({ id: opts.id, ce, cn, width: p.width, depth: p.depth, rotDeg, eaveHeight: p.eaveHeight, ridgeHeight: p.ridgeHeight, roof: p.roof, preset: p.id, label: opts.label });
}

/**
 * 周辺建物としての値（外周リング・高さ）に合わせた想定の家（元のオブジェクトは変えない）:
 *  - 中心 = リングの頂点の平均（リングを平行移動するコード — ピンを動かしたときの周辺環境のずらしなど — に追従する）
 *  - 高さ = height（高さだけ直されたとき。軒も同じ比で変える）
 * ring・height が無い／壊れていれば h のまま
 */
export function syncPlannedHouse(h: PlannedHouse, ring?: readonly EN[] | null, height?: number | null): PlannedHouse {
  let out = h;
  if (ring && ring.length >= 3 && ring.every((p) => Number.isFinite(p.e) && Number.isFinite(p.n))) {
    let e = 0;
    let n = 0;
    for (const p of ring) {
      e += p.e;
      n += p.n;
    }
    e /= ring.length;
    n /= ring.length;
    if (Math.abs(e - h.ce) > 1e-6 || Math.abs(n - h.cn) > 1e-6) out = { ...out, ce: e, cn: n };
  }
  if (typeof height === 'number' && Number.isFinite(height) && height > 0 && Math.abs(height - h.ridgeHeight) > 1e-6) {
    const k = height / h.ridgeHeight;
    out = clampHouse({ ...out, ridgeHeight: height, eaveHeight: out.roof === 'flat' ? height : h.eaveHeight * k });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ジオメトリ
// ---------------------------------------------------------------------------

interface P2 {
  u: number;
  v: number;
}
interface P3 {
  u: number;
  v: number;
  z: number;
}
/** 屋根面: z = a·u + b·v + c（足元の地盤からの高さ） */
interface Plane {
  a: number;
  b: number;
  c: number;
}

const planeZ = (p: Plane, u: number, v: number) => p.a * u + p.b * v + p.c;

/** 屋根の上面の平面（屋根の高さ = これらの最小値）。o = 軒の出 */
function roofPlanes(h: PlannedHouse, o: number): Plane[] {
  const W = h.width;
  const D = h.depth;
  const E = h.eaveHeight;
  const H = Math.max(0, h.ridgeHeight - E);
  const out: Plane[] = [];
  if (h.roof === 'flat' || H <= 1e-9) out.push({ a: 0, b: 0, c: E });
  else if (h.roof === 'shed') {
    // 低い側（−depth/2 の壁の線）で E、高い側の端（+depth/2 + 軒の出）で ridgeHeight
    const s = H / (D + o);
    out.push({ a: 0, b: s, c: E + (s * D) / 2 });
  } else {
    const s = H / (D / 2);
    out.push({ a: 0, b: s, c: E + (s * D) / 2 }, { a: 0, b: -s, c: E + (s * D) / 2 });
    if (h.roof === 'hip') {
      const r = Math.max(0, (W - D) / 2);
      const su = H / (W / 2 - r);
      out.push({ a: su, b: 0, c: E + (su * W) / 2 }, { a: -su, b: 0, c: E + (su * W) / 2 });
    }
  }
  // 同じ平面は 1 つに（同じ値の最小を 2 つの面で取り合わない）
  return out.filter((p, i) => !out.slice(0, i).some((q) => Math.abs(q.a - p.a) < 1e-12 && Math.abs(q.b - p.b) < 1e-12 && Math.abs(q.c - p.c) < 1e-9));
}

/** 凸多角形を半平面 A·u + B·v + C ≤ 0 で切り取る */
function clipHalf(poly: P2[], A: number, B: number, C: number): P2[] {
  const out: P2[] = [];
  const f = (p: P2) => A * p.u + B * p.v + C;
  const eps = 1e-10;
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const prev = poly[(i + poly.length - 1) % poly.length];
    const fc = f(cur);
    const fp = f(prev);
    const ci = fc <= eps;
    const pi = fp <= eps;
    if (ci) {
      if (!pi) {
        const t = fp / (fp - fc);
        out.push({ u: prev.u + (cur.u - prev.u) * t, v: prev.v + (cur.v - prev.v) * t });
      }
      out.push(cur);
    } else if (pi) {
      const t = fp / (fp - fc);
      out.push({ u: prev.u + (cur.u - prev.u) * t, v: prev.v + (cur.v - prev.v) * t });
    }
  }
  return out;
}

const area2 = (poly: P2[]) => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.u * b.v - b.u * a.v;
  }
  return s / 2;
};

/** 同じ点を 1 つの点にまとめる（面どうしで頂点が完全に一致するように） */
class PointPool {
  private pts: P2[] = [];
  get(p: P2): P2 {
    for (const q of this.pts) if (Math.abs(q.u - p.u) < 1e-7 && Math.abs(q.v - p.v) < 1e-7) return q;
    const c = { u: p.u, v: p.v };
    this.pts.push(c);
    return c;
  }
}

/** 長方形の中を「どの屋根面が最小か」で分けた凸多角形（反時計回り。頂点は pool で共有） */
function roofRegions(planes: Plane[], u0: number, u1: number, v0: number, v1: number, pool: PointPool): P2[][] {
  const rect: P2[] = [
    { u: u0, v: v0 },
    { u: u1, v: v0 },
    { u: u1, v: v1 },
    { u: u0, v: v1 },
  ];
  const out: P2[][] = [];
  for (let i = 0; i < planes.length; i++) {
    let poly = rect;
    for (let j = 0; j < planes.length && poly.length >= 3; j++) {
      if (j === i) continue;
      const A = planes[i].a - planes[j].a;
      const B = planes[i].b - planes[j].b;
      const C = planes[i].c - planes[j].c;
      poly = clipHalf(poly, A, B, C);
    }
    // 頂点をまとめ、続けて同じ点・面積 0 の多角形を除く
    const merged: P2[] = [];
    for (const p of poly) {
      const q = pool.get(p);
      if (merged[merged.length - 1] !== q) merged.push(q);
    }
    while (merged.length > 1 && merged[0] === merged[merged.length - 1]) merged.pop();
    if (merged.length >= 3 && area2(merged) > 1e-8) out.push(merged);
  }
  return out;
}

/** 線分 a→b の上にある点（端点を含む）を a からの順に */
function pointsOnSide(polys: P2[][], a: P2, b: P2): P2[] {
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const L2 = du * du + dv * dv;
  const L = Math.sqrt(L2);
  const seen = new Set<P2>();
  const out: { p: P2; t: number }[] = [];
  for (const poly of polys)
    for (const p of poly) {
      if (seen.has(p)) continue;
      const t = ((p.u - a.u) * du + (p.v - a.v) * dv) / L2;
      const off = Math.abs((p.u - a.u) * dv - (p.v - a.v) * du) / L;
      if (off > 1e-6 || t < -1e-9 || t > 1 + 1e-9) continue;
      seen.add(p);
      out.push({ p, t });
    }
  return out.sort((x, y) => x.t - y.t).map((x) => x.p);
}

/** 三角形の集まり（局所座標、屋根・壁） */
class TriSink {
  roof: P3[] = [];
  wall: P3[] = [];
  /** 平らな凸多角形を外向き（outward の側から見て反時計回り）に三角形に分けて足す（4 点以上は重心から扇形: 一直線上の点があっても潰れた三角形を作らない） */
  poly(pts: P3[], outward: [number, number, number], group: 'roof' | 'wall') {
    if (pts.length < 3) return;
    // Newell 法の法線
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      nx += (a.v - b.v) * (a.z + b.z);
      ny += (a.z - b.z) * (a.u + b.u);
      nz += (a.u - b.u) * (a.v + b.v);
    }
    const ps = nx * outward[0] + ny * outward[1] + nz * outward[2] < 0 ? pts.slice().reverse() : pts;
    const t = group === 'roof' ? this.roof : this.wall;
    if (ps.length === 3) {
      t.push(ps[0], ps[1], ps[2]);
      return;
    }
    const c: P3 = { u: 0, v: 0, z: 0 };
    for (const p of ps) {
      c.u += p.u / ps.length;
      c.v += p.v / ps.length;
      c.z += p.z / ps.length;
    }
    for (let i = 0; i < ps.length; i++) t.push(c, ps[i], ps[(i + 1) % ps.length]);
  }
}

export interface PlannedGeometryOptions {
  /** EN (m) と高さ y（ワールド）→ ワールド座標 */
  toWorld: (e: number, n: number, y: number) => THREE.Vector3;
  /** 足元の地盤のワールド y（足跡の中でいちばん低い地盤）。高さはここから測る */
  baseY: number;
  /** 軒の出（屋根の板を四周に PLANNED_EAVE_OVERHANG 出す）。既定 true。陸屋根には付けない */
  eaves?: boolean;
  /** 壁を baseY より下へ延ばす量 (m)。傾斜地で足元に隙間を作らないため。既定 0 */
  sink?: number;
}

/** 局所座標の三角形（屋根・壁）。テスト・解析用（ジオメトリは buildPlannedHouseGeometry） */
export function plannedHouseTriangles(hIn: PlannedHouse, opts: { eaves?: boolean; sink?: number } = {}): { roof: P3[]; wall: P3[] } {
  const h = clampHouse(hIn);
  const W = h.width;
  const D = h.depth;
  const flat = h.roof === 'flat';
  const o = flat || opts.eaves === false ? 0 : PLANNED_EAVE_OVERHANG;
  const t = flat ? 0 : PLANNED_ROOF_THICKNESS;
  const z0 = -Math.max(0, finite(opts.sink, 0));
  const planes = roofPlanes(h, o);
  const zTop = (p: P2) => {
    let z = Infinity;
    for (const pl of planes) z = Math.min(z, planeZ(pl, p.u, p.v));
    return z;
  };
  const pool = new PointPool();
  const sink = new TriSink();
  const UP: [number, number, number] = [0, 0, 1];
  const DOWN: [number, number, number] = [0, 0, -1];
  const corners = (u0: number, u1: number, v0: number, v1: number): P2[] => [pool.get({ u: u0, v: v0 }), pool.get({ u: u1, v: v0 }), pool.get({ u: u1, v: v1 }), pool.get({ u: u0, v: v1 })];

  // 壁の本体: 足元の長方形を、屋根の上面から厚さ t だけ下の面まで立ち上げる（陸屋根は屋根の上面まで = 箱）
  const bodyRegions = roofRegions(planes, -W / 2, W / 2, -D / 2, D / 2, pool);
  const bodyTop = (p: P2) => zTop(p) - t;
  for (const poly of bodyRegions) sink.poly(poly.map((p) => ({ u: p.u, v: p.v, z: bodyTop(p) })), UP, 'roof');
  const rc = corners(-W / 2, W / 2, -D / 2, D / 2);
  for (let k = 0; k < 4; k++) {
    const a = rc[k];
    const b = rc[(k + 1) % 4];
    const chain = pointsOnSide(bodyRegions, a, b);
    const pts: P3[] = [{ u: a.u, v: a.v, z: z0 }, { u: b.u, v: b.v, z: z0 }, ...chain.reverse().map((p) => ({ u: p.u, v: p.v, z: bodyTop(p) }))];
    sink.poly(pts, [b.v - a.v, -(b.u - a.u), 0], 'wall');
  }
  sink.poly(
    rc.map((p) => ({ u: p.u, v: p.v, z: z0 })),
    DOWN,
    'wall',
  );

  // 屋根の板（軒の出を含む）: 上面・下面（軒裏）・四周の鼻先
  if (!flat) {
    const slabRegions = roofRegions(planes, -W / 2 - o, W / 2 + o, -D / 2 - o, D / 2 + o, pool);
    for (const poly of slabRegions) {
      sink.poly(poly.map((p) => ({ u: p.u, v: p.v, z: zTop(p) })), UP, 'roof');
      sink.poly(poly.map((p) => ({ u: p.u, v: p.v, z: zTop(p) - t })), DOWN, 'roof');
    }
    const sc = corners(-W / 2 - o, W / 2 + o, -D / 2 - o, D / 2 + o);
    for (let k = 0; k < 4; k++) {
      const a = sc[k];
      const b = sc[(k + 1) % 4];
      const out: [number, number, number] = [b.v - a.v, -(b.u - a.u), 0];
      const chain = pointsOnSide(slabRegions, a, b);
      for (let i = 0; i + 1 < chain.length; i++) {
        const p = chain[i];
        const q = chain[i + 1];
        sink.poly(
          [
            { u: p.u, v: p.v, z: zTop(p) - t },
            { u: q.u, v: q.v, z: zTop(q) - t },
            { u: q.u, v: q.v, z: zTop(q) },
            { u: p.u, v: p.v, z: zTop(p) },
          ],
          out,
          'roof',
        );
      }
    }
  }
  return { roof: sink.roof, wall: sink.wall };
}

/**
 * 想定の家のジオメトリ（閉じた・インデックスなし・面ごとの法線・外向きの巻き）。
 * グループ 0 = 屋根（屋根の板の上面・軒裏・鼻先と、見えない本体の上面）、グループ 1 = 壁（壁と底）。
 * 使い方: new THREE.Mesh(geo, [roofMat, wallMat])。単一のマテリアルを渡せば全体がその色（グループは無視される）。
 * 高さは opts.baseY から: 最高点 = baseY + ridgeHeight（軒の出の板もこれを超えない）、壁の線での屋根の上面 = baseY + eaveHeight。
 * toWorld が鏡映（左手系）でも外向きになるよう巻きを合わせる
 */
export function buildPlannedHouseGeometry(hIn: PlannedHouse, opts: PlannedGeometryOptions): THREE.BufferGeometry {
  const h = clampHouse(hIn);
  const tris = plannedHouseTriangles(h, { eaves: opts.eaves, sink: opts.sink });
  const ax = plannedAxes(h.rotDeg);
  const baseY = finite(opts.baseY, 0);
  const world = (p: P3) => opts.toWorld(h.ce + p.u * ax.u.e + p.v * ax.v.e, h.cn + p.u * ax.u.n + p.v * ax.v.n, baseY + p.z);
  // toWorld の向き（右手系か）: 局所の東・北・上の 3 つのベクトルの行列式
  const o0 = opts.toWorld(h.ce, h.cn, baseY);
  const de = opts.toWorld(h.ce + 1, h.cn, baseY).sub(o0);
  const dn = opts.toWorld(h.ce, h.cn + 1, baseY).sub(o0);
  const dy = opts.toWorld(h.ce, h.cn, baseY + 1).sub(o0);
  const flip = de.dot(dn.clone().cross(dy)) < 0;
  const all = [...tris.roof, ...tris.wall];
  const pos = new Float32Array(all.length * 3);
  const nor = new Float32Array(all.length * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < all.length; i += 3) {
    a.copy(world(all[i]));
    b.copy(world(flip ? all[i + 2] : all[i + 1]));
    c.copy(world(flip ? all[i + 1] : all[i + 2]));
    n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    for (const [k, p] of [a, b, c].entries()) {
      pos.set([p.x, p.y, p.z], (i + k) * 3);
      nor.set([n.x, n.y, n.z], (i + k) * 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.addGroup(0, tris.roof.length, PLANNED_GROUP_ROOF);
  geo.addGroup(tris.roof.length, tris.wall.length, PLANNED_GROUP_WALL);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// 区画（敷地）
// ---------------------------------------------------------------------------

export interface HouseInLotOptions {
  /** 家の形（既定 2 階建て・切妻） */
  preset?: PlannedPresetId;
  /** 隣地側（front 以外のすべての辺）からの離れ (m)。既定 1.0 */
  sideSetback?: number;
  /** 道路側（frontEdgeIndex の辺）からの離れ (m)。既定 2.0。frontEdgeIndex が無ければ使わない */
  frontSetback?: number;
  /** 道路側の辺（lot[i] → lot[i+1]）。無ければすべての辺を sideSetback で */
  frontEdgeIndex?: number;
  /** 建ぺい率の上限（足元の面積 ≤ coverage × 区画の面積）。既定 0.5 */
  coverage?: number;
  /** 置き場所に余裕があるとき寄せる側: 'north' = 北側（南に庭をとる一般的な配置。北隣の日照には厳しめ = 安全側）、'center' = 中央。既定 'north' */
  prefer?: 'north' | 'center';
  id?: string;
  label?: string;
}

/** 点と、u/v 軸に沿った長方形 [cu ± a] × [cv ± b] の距離（内側なら 0） */
function distPointBox(p: P2, cu: number, cv: number, a: number, b: number): number {
  const du = Math.max(0, Math.abs(p.u - cu) - a);
  const dv = Math.max(0, Math.abs(p.v - cv) - b);
  return Math.hypot(du, dv);
}

/** 線分 p→q が長方形の内部に入るか（Liang–Barsky） */
function segmentHitsBox(p: P2, q: P2, cu: number, cv: number, a: number, b: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const du = q.u - p.u;
  const dv = q.v - p.v;
  const tests: [number, number][] = [
    [-du, p.u - (cu - a)],
    [du, cu + a - p.u],
    [-dv, p.v - (cv - b)],
    [dv, cv + b - p.v],
  ];
  for (const [P, Q] of tests) {
    if (P === 0) {
      if (Q < 0) return false;
      continue;
    }
    const r = Q / P;
    if (P < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t1 >= t0;
}

const toUV = (p: EN, ax: { u: EN; v: EN }): P2 => ({ u: p.e * ax.u.e + p.n * ax.u.n, v: p.e * ax.v.e + p.n * ax.v.n });

/**
 * 区画（lot、EN の多角形。向きは問わない）の中に想定の家を置く:
 * 区画の主な向き（dominantAngleDeg・minAreaRect）に合わせ、すべての辺から離れ（front の辺は frontSetback、他は sideSetback）
 * 以上離して、建ぺい率（coverage）以内で、プリセットの大きさが入らなければ縮めて（幅・奥行きを別々にも）置く。
 * 余裕があれば北側に寄せる（prefer）。凹んだ区画（L 字・旗竿地）でも足元の長方形全体を区画の内側・離れ以上に保つ。
 * 区画が壊れている・小さすぎて 3 m × 3 m も入らなければ null
 */
export function houseInLot(lotIn: EN[], opts: HouseInLotOptions = {}): PlannedHouse | null {
  let lot = lotIn.filter((p) => p && Number.isFinite(p.e) && Number.isFinite(p.n));
  if (lot.length !== lotIn.length) return null;
  if (lot.length >= 2 && Math.hypot(lot[0].e - lot[lot.length - 1].e, lot[0].n - lot[lot.length - 1].n) < 1e-9) lot = lot.slice(0, -1);
  if (lot.length < 3) return null;
  const lotArea = Math.abs(polygonArea(lot));
  if (!(lotArea > 1e-6)) return null;
  const preset = plannedPreset(opts.preset);
  const side = Math.max(1e-6, finite(opts.sideSetback, 1.0));
  const front = Math.max(1e-6, finite(opts.frontSetback, 2.0));
  const fi = Number.isInteger(opts.frontEdgeIndex) ? (((opts.frontEdgeIndex as number) % lot.length) + lot.length) % lot.length : -1;
  const setback = lot.map((_, i) => (i === fi ? front : side));
  const coverage = clampN(finite(opts.coverage, 0.5), 0.01, 1);
  // 建ぺい率で大きさを決める（縦横比はプリセットのまま）
  let W0 = preset.width;
  let D0 = preset.depth;
  const maxA = coverage * lotArea;
  if (W0 * D0 > maxA) {
    const k = Math.sqrt(maxA / (W0 * D0));
    W0 *= k;
    D0 *= k;
  }
  if (Math.min(W0, D0) < PLANNED_MIN_LOT_HOUSE) {
    // 建ぺい率で小さくなりすぎるときは、細長くせずに最小寸法までの正方形寄りに
    if (W0 * D0 < PLANNED_MIN_LOT_HOUSE * PLANNED_MIN_LOT_HOUSE) return null;
    D0 = Math.max(PLANNED_MIN_LOT_HOUSE, D0);
    W0 = Math.max(PLANNED_MIN_LOT_HOUSE, maxA / D0);
  }
  const prefer = opts.prefer ?? 'north';
  // 向きの候補（width の軸の方位）
  const cands: number[] = [];
  const addCand = (a: number) => {
    const x = ((a % 180) + 180) % 180;
    if (!cands.some((c) => Math.abs(((x - c + 90 + 180) % 180) - 90) < 0.5)) cands.push(x);
  };
  const dom = dominantAngleDeg(lot);
  addCand(dom);
  addCand(dom + 90);
  const mar = minAreaRect(lot);
  if (mar) {
    addCand(mar.angleDeg);
    addCand(mar.angleDeg + 90);
  }

  type Best = { rot: number; cu: number; cv: number; w: number; d: number; north: number; centerDist: number };
  let best: Best | null = null;
  const centroidEN = lot.reduce((s, p) => ({ e: s.e + p.e / lot.length, n: s.n + p.n / lot.length }), { e: 0, n: 0 });
  const better = (x: Best, y: Best | null): boolean => {
    if (!y) return true;
    const ax = x.w * x.d;
    const ay = y.w * y.d;
    if (ax > ay * 1.002) return true;
    if (ax < ay / 1.002) return false;
    if (prefer === 'north' && Math.abs(x.north - y.north) > 0.01) return x.north > y.north;
    return x.centerDist < y.centerDist - 1e-6;
  };

  for (const rot of cands) {
    const ax = plannedAxes(rot);
    const poly = lot.map((p) => toUV(p, ax));
    const polyEN = poly.map((p) => ({ e: p.u, n: p.v }));
    const nb = { u: dotEN({ e: 0, n: 1 }, ax.u), v: dotEN({ e: 0, n: 1 }, ax.v) };
    const cUV = toUV(centroidEN, ax);
    /** 中心 (cu, cv)・幅 w・奥行き d の長方形が区画の内側にあり、どの辺からも離れ以上か */
    const feasible = (cu: number, cv: number, w: number, d: number): boolean => {
      const a = w / 2;
      const b = d / 2;
      if (!pointInPolygon({ e: cu, n: cv }, polyEN)) return false;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % poly.length];
        const s = setback[i];
        // 辺が長方形に入る（区画の凹みの角が食い込むなど）→ 不可。入らなければ距離 = 端点と長方形・長方形の角と辺の最短
        if (segmentHitsBox(p, q, cu, cv, a, b)) return false;
        if (distPointBox(p, cu, cv, a, b) < s || distPointBox(q, cu, cv, a, b) < s) return false;
        for (const [su, sv] of CORNER_SIGNS) if (distPointSegment({ e: cu + su * a, n: cv + sv * b }, polyEN[i], polyEN[(i + 1) % poly.length]) < s) return false;
      }
      return true;
    };
    /** 中心 (cu, cv) で入る一様な縮尺（0 = 最小寸法でも入らない） */
    const minScale = PLANNED_MIN_LOT_HOUSE / Math.min(W0, D0);
    const scaleAt = (cu: number, cv: number): number => {
      if (feasible(cu, cv, W0, D0)) return 1;
      if (!feasible(cu, cv, W0 * minScale, D0 * minScale)) return 0;
      let lo = minScale;
      let hi = 1;
      for (let k = 0; k < 18; k++) {
        const m = (lo + hi) / 2;
        if (feasible(cu, cv, W0 * m, D0 * m)) lo = m;
        else hi = m;
      }
      return lo;
    };
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of poly) {
      u0 = Math.min(u0, p.u);
      u1 = Math.max(u1, p.u);
      v0 = Math.min(v0, p.v);
      v1 = Math.max(v1, p.v);
    }
    let rb: Best | null = null;
    const consider = (cu: number, cv: number, w: number, d: number) => {
      const c: Best = { rot, cu, cv, w, d, north: cu * nb.u + cv * nb.v, centerDist: Math.hypot(cu - cUV.u, cv - cUV.v) };
      if (better(c, rb)) rb = c;
    };
    // 粗い格子 → 良い所のまわりを細かく
    const N = 36;
    const su = (u1 - u0) / N;
    const sv = (v1 - v0) / N;
    let local: { cu: number; cv: number; s: number }[] = [];
    for (let i = 0; i <= N; i++)
      for (let j = 0; j <= N; j++) {
        const cu = u0 + su * i;
        const cv = v0 + sv * j;
        const s = scaleAt(cu, cv);
        if (s <= 0) continue;
        local.push({ cu, cv, s });
        consider(cu, cv, W0 * s, D0 * s);
      }
    if (!local.length) continue;
    const top = local.reduce((m, x) => Math.max(m, x.s), 0);
    local = local.filter((x) => x.s >= top - 1e-3);
    // 縮尺が同じ候補が多い（余裕がある）ときは寄せる側の端の数点だけを細かく見る
    const northOf = (x: { cu: number; cv: number }) => x.cu * nb.u + x.cv * nb.v;
    const distOf = (x: { cu: number; cv: number }) => Math.hypot(x.cu - cUV.u, x.cv - cUV.v);
    local.sort((x, y) => (prefer === 'north' ? northOf(y) - northOf(x) : distOf(x) - distOf(y)));
    for (const x of local.slice(0, 4)) {
      const M = 6;
      for (let i = -M; i <= M; i++)
        for (let j = -M; j <= M; j++) {
          const cu = x.cu + (su * i) / M;
          const cv = x.cv + (sv * j) / M;
          const s = scaleAt(cu, cv);
          if (s > 0) consider(cu, cv, W0 * s, D0 * s);
        }
    }
    const r = rb as Best | null;
    if (!r) continue;
    // 縮めたときは幅・奥行きを別々に伸ばせるだけ伸ばす（建ぺい率は W0 × D0 ≤ 上限なので超えない）
    if (r.w < W0 - 1e-6 || r.d < D0 - 1e-6) {
      const grow = (axis: 'w' | 'd') => {
        const fits = (m: number) => feasible(r.cu, r.cv, axis === 'w' ? m : r.w, axis === 'd' ? m : r.d);
        let lo = axis === 'w' ? r.w : r.d;
        let hi = axis === 'w' ? W0 : D0;
        if (fits(hi)) lo = hi;
        else
          for (let k = 0; k < 18; k++) {
            const m = (lo + hi) / 2;
            if (fits(m)) lo = m;
            else hi = m;
          }
        if (axis === 'w') r.w = lo;
        else r.d = lo;
      };
      grow('w');
      grow('d');
    }
    if (better(r, best)) best = r;
  }
  const b = best as Best | null;
  if (!b || Math.min(b.w, b.d) < PLANNED_MIN_LOT_HOUSE - 1e-6) return null;
  const ax = plannedAxes(b.rot);
  let rot = b.rot;
  let w = b.w;
  let d = b.d;
  // 棟は長手に（縮めて幅 < 奥行きになったら入れ替える）
  if (w < d - 1e-9) {
    [w, d] = [d, w];
    rot += 90;
  }
  // 方位は [0, 180)（+depth 側 = 片流れの高い側がなるべく北を向く）
  rot = ((rot % 180) + 180) % 180;
  const c = { e: b.cu * ax.u.e + b.cv * ax.v.e, n: b.cu * ax.u.n + b.cv * ax.v.n };
  return clampHouse({
    id: opts.id,
    ce: c.e,
    cn: c.n,
    width: w,
    depth: d,
    rotDeg: rot,
    eaveHeight: preset.eaveHeight,
    ridgeHeight: preset.ridgeHeight,
    roof: preset.roof,
    preset: preset.id,
    label: opts.label,
  });
}

const dotEN = (a: EN, b: EN) => a.e * b.e + a.n * b.n;
const CORNER_SIGNS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** 辺 i の端点（lot[i], lot[i+1]） */
function edgeOf(site: EN[], edgeIndex: number): [EN, EN] {
  const n = site.length;
  const i = ((Math.trunc(edgeIndex) % n) + n) % n;
  return [site[i], site[(i + 1) % n]];
}

/**
 * 辺 edgeIndex（site[i] → site[i+1]）の向こう側の区画: 辺の直線について site を鏡に映した形（同じ形の隣地）。
 * 向き（反時計回り／時計回り）は site と同じにする（点の順を逆にする）。共有する辺は結果の辺 (2n − 2 − i) % n（向きは逆: site[i+1] → site[i]）。
 * site が辺の直線の片側にある（辺が凸包の辺）なら重ならない
 */
export function mirrorLotAcrossEdge(site: EN[], edgeIndex: number): EN[] {
  if (site.length < 3) return site.map((p) => ({ ...p }));
  const [a, b] = edgeOf(site, edgeIndex);
  const de = b.e - a.e;
  const dn = b.n - a.n;
  const L2 = de * de + dn * dn;
  if (!(L2 > 0)) return site.map((p) => ({ ...p }));
  const mapped = site.map((p) => {
    const t = ((p.e - a.e) * de + (p.n - a.n) * dn) / L2;
    const fe = a.e + de * t;
    const fn = a.n + dn * t;
    return { e: 2 * fe - p.e, n: 2 * fn - p.n };
  });
  return mapped.reverse();
}

/**
 * 辺 edgeIndex の向こう側の区画: site を、辺に垂直な方向の幅（辺の直線から最も遠い点までの距離）だけ辺の外へずらした形
 * （分譲地で同じ形の区画が並ぶときの隣地。長方形なら向かいの辺がこの辺にぴったり重なる）。点の順・向きは site と同じ。
 * site が辺の直線の片側にある（辺が凸包の辺）なら重ならない
 */
export function translateLotAcrossEdge(site: EN[], edgeIndex: number): EN[] {
  if (site.length < 3) return site.map((p) => ({ ...p }));
  const [a, b] = edgeOf(site, edgeIndex);
  const de = b.e - a.e;
  const dn = b.n - a.n;
  const L = Math.hypot(de, dn);
  if (!(L > 0)) return site.map((p) => ({ ...p }));
  // 辺の法線（どちらかの向き）と、各点の符号付き距離
  const nrm = { e: dn / L, n: -de / L };
  let lo = 0;
  let hi = 0;
  for (const p of site) {
    const s = (p.e - a.e) * nrm.e + (p.n - a.n) * nrm.n;
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  // site がある側の反対へ、その側の幅だけずらす
  const shift = -lo >= hi ? { e: nrm.e * -lo, n: nrm.n * -lo } : { e: -nrm.e * hi, n: -nrm.n * hi };
  return site.map((p) => ({ e: p.e + shift.e, n: p.n + shift.n }));
}
