/**
 * 見積の数量の「根拠」: takeoff が拾った数量を、図面の上で色分けして示せる形（区画・辺・帯）に分解する。
 * 数字は takeoff と同じ関数で出す（同じ値になる）。設計士が数字を見比べなくても、
 * 図面と色で「なぜこの数量になったか」が一目で分かるようにするためのデータ。描画は drawings/basis.ts
 */
import type { BuildingModel, Floor, Room, Vec2 } from '../core/types';
import {
  takeoff,
  overlay,
  inFloor,
  centroid,
  isBuiltinGarage,
  uncoveredRuns,
  uncoveredArea,
  exteriorRuns,
  gableTriangleArea,
  floorCategory,
  interiorDoors,
  outlineArea,
  bboxOf,
  FOUND_H,
  PARAPET_H,
  type Areas,
  type TakeoffOptions,
  type FloorCategory,
} from './areas';

const r2 = (v: number) => Math.round(v * 100) / 100;
/** takeoff と同じ: 1 階の中庭・テラスはバルコニー（施工面積・防水）に入れない */
const isCourt = (name: string) => /中庭|坪庭|パティオ|ライトコート|テラス|ドッグラン/.test(name);
const dot = (p: Vec2, q: Vec2) => p.x * q.x + p.y * q.y;

// ---------------------------------------------------------------------------------------------
// 床面積・施工面積
// ---------------------------------------------------------------------------------------------

/** 外形の内側にあって床面積から引く区画 */
export type ExcludeKind = 'void' | 'balcony' | 'court' | 'garage';
export const EXCLUDE_LABEL: Record<ExcludeKind, string> = { void: '吹抜', balcony: 'バルコニー', court: '中庭・テラス', garage: 'ビルトインガレージ' };

export interface FloorAreaBasis {
  floor: Floor;
  level: number;
  /** 外形の面積 (㎡) */
  outline: number;
  /** 床面積 (㎡) = 外形 − 外形の内側の吹抜・バルコニー・中庭 − ビルトインガレージ */
  floorArea: number;
  excluded: { room: Room; kind: ExcludeKind; area: number }[];
  /** ポーチの区画（施工面積に） */
  porch: Room[];
  /** 施工面積に入れるバルコニー（2 階以上、中庭を除く） */
  countedBalcony: Room[];
  /** 施工面積に入れる吹抜（2 階以上） */
  countedVoid: Room[];
  /** この階の外形のうち、すぐ下の階の外形の外にある面積 (㎡)（下の階から見た「上の階の下の屋外」。1 階は 0） */
  overhang: number;
}

export interface AreaBasis {
  areas: Areas;
  floors: FloorAreaBasis[];
  /** 2 階の下の屋外（ピロティ・張り出し。施工面積に） (㎡) */
  pilotis: number;
}

export function areaBasis(model: BuildingModel, opts: TakeoffOptions): AreaBasis {
  const areas = takeoff(model, opts);
  const floors = model.floors.slice().sort((a, b) => a.level - b.level);
  const ov = overlay(floors);
  const out = floors.map((f, i): FloorAreaBasis => {
    const inside = (r: Room) => r.polygon.length >= 3 && inFloor(f, centroid(r.polygon).x, centroid(r.polygon).y);
    const excluded: FloorAreaBasis['excluded'] = [];
    for (const r of f.rooms) {
      if (!inside(r)) continue;
      if (r.type === 'void') excluded.push({ room: r, kind: 'void', area: r.area });
      else if (r.type === 'balcony') excluded.push({ room: r, kind: isCourt(r.name) ? 'court' : 'balcony', area: r.area });
      else if (isBuiltinGarage(r)) excluded.push({ room: r, kind: 'garage', area: r.area });
    }
    const outline = outlineArea(f);
    return {
      floor: f,
      level: f.level,
      outline: r2(outline),
      floorArea: r2(Math.max(0, outline - excluded.reduce((s, e) => s + e.area, 0))),
      excluded,
      porch: f.rooms.filter((r) => r.type === 'porch'),
      countedBalcony: f.level >= 2 ? f.rooms.filter((r) => r.type === 'balcony' && !isCourt(r.name)) : [],
      countedVoid: f.level >= 2 ? f.rooms.filter((r) => r.type === 'void') : [],
      overhang: r2(ov.exposedBelow[i] ?? 0),
    };
  });
  return { areas, floors: out, pilotis: r2(ov.exposedBelow[1] ?? 0) };
}

/** 上の階の外形のうち下の階の外形の外にある所（張り出し・ピロティ）の面積と位置（100mm 格子）。注記を置く場所に使う */
export function exposedRegion(upper: Floor, lower: Floor, step = 100): { area: number; cx: number; cy: number; minX: number; minY: number; maxX: number; maxY: number } | null {
  const pts = upper.outline.flat();
  if (!pts.length) return null;
  const bb = bboxOf(pts);
  let n = 0;
  let sx = 0;
  let sy = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let x = bb.minX + step / 2; x < bb.maxX; x += step)
    for (let y = bb.minY + step / 2; y < bb.maxY; y += step) {
      if (!inFloor(upper, x, y) || inFloor(lower, x, y)) continue;
      n++;
      sx += x;
      sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  if (!n) return null;
  return { area: r2((n * step * step) / 1e6), cx: sx / n, cy: sy / n, minX: minX - step / 2, minY: minY - step / 2, maxX: maxX + step / 2, maxY: maxY + step / 2 };
}

// ---------------------------------------------------------------------------------------------
// 外壁面積（方位ごとの帯）
// ---------------------------------------------------------------------------------------------

export type WallDir = 'south' | 'east' | 'north' | 'west';
export const WALL_DIRS: WallDir[] = ['south', 'east', 'north', 'west'];
export const WALL_DIR_JA: Record<WallDir, string> = { south: '南', east: '東', north: '北', west: '西' };
export type WallKind = 'found' | 'wall' | 'parapet' | 'gable' | 'garage';
export const WALL_KIND_LABEL: Record<WallKind, string> = { found: '基礎の立ち上がり', wall: '外壁', parapet: 'パラペット', gable: '妻壁（三角）', garage: 'ガレージの外壁（断熱から引く）' };

/** 立面（方位）の上に置く 1 枚の帯。u は立面の左→右 (mm)、y は GL からの高さ (mm) */
export interface WallPiece {
  dir: WallDir;
  level: number;
  kind: WallKind;
  u0: number;
  u1: number;
  y0: number;
  y1: number;
  /** 見る人に近いほど大きい（重なりの描画順） */
  near: number;
  /** 長さ (m)・高さ (m)・面積 (㎡) */
  len: number;
  height: number;
  area: number;
}

export interface WallRow {
  kind: WallKind;
  level: number;
  len: number;
  height: number;
  area: number;
}

export interface WallBasis {
  pieces: WallPiece[];
  byDir: Record<WallDir, { rows: WallRow[]; total: number }>;
  /** 帯の合計（= 外壁面積。丸めの差だけ） */
  total: number;
  extWall: number;
  garageWall: number;
  insulWall: number;
  /** 階ごとの帯の高さ (GL から mm) */
  bands: { level: number; y0: number; y1: number }[];
  maxY: number;
  /** 図面上の北・東の向き（90° 単位に丸めたもの） */
  axes: { north: Vec2; east: Vec2 };
}

/** 真北の角度から、図面上の北・東の向き（建物の軸に揃えるため 90° 単位に丸める。立面図の向きの決め方と同じ） */
export function compassAxes(northAngleDeg: number): { north: Vec2; east: Vec2 } {
  const a = (northAngleDeg * Math.PI) / 180;
  const n = { x: Math.sin(a), y: -Math.cos(a) };
  const cands: Vec2[] = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];
  const north = cands.slice().sort((p, q) => dot(q, n) - dot(p, n))[0];
  return { north, east: { x: -north.y, y: north.x } };
}

/** 方位の向き（その面が向く方向） */
export function dirVec(dir: WallDir, axes: { north: Vec2; east: Vec2 }): Vec2 {
  if (dir === 'north') return axes.north;
  if (dir === 'south') return { x: -axes.north.x, y: -axes.north.y };
  if (dir === 'east') return axes.east;
  return { x: -axes.east.x, y: -axes.east.y };
}

/** その方位の立面を見たときの「右」（南立面は西→東、東立面は南→北 …） */
export function rightVec(dir: WallDir, axes: { north: Vec2; east: Vec2 }): Vec2 {
  if (dir === 'south') return axes.east;
  if (dir === 'north') return { x: -axes.east.x, y: -axes.east.y };
  if (dir === 'east') return axes.north;
  return { x: -axes.north.x, y: -axes.north.y };
}

export function wallDirOf(outward: Vec2, axes: { north: Vec2; east: Vec2 }): WallDir {
  let best: WallDir = 'south';
  let bd = -Infinity;
  for (const d of WALL_DIRS) {
    const v = dot(outward, dirVec(d, axes));
    if (v > bd) {
      bd = v;
      best = d;
    }
  }
  return best;
}

/** 外形の辺 a→b の外側へ向く単位法線（辺の中点を 150 ずらして、階の外形の外に出る側） */
export function outwardOf(f: Floor, a: Vec2, b: Vec2): Vec2 {
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const n = { x: -(b.y - a.y) / L, y: (b.x - a.x) / L };
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return inFloor(f, m.x + n.x * 150, m.y + n.y * 150) ? { x: -n.x, y: -n.y } : n;
}

export function wallBasis(model: BuildingModel, opts: TakeoffOptions): WallBasis {
  const areas = takeoff(model, opts);
  const floors = model.floors.slice().sort((a, b) => a.level - b.level);
  const axes = compassAxes(model.northAngleDeg);
  const pieces: WallPiece[] = [];
  // 階の帯（GL からの高さ mm）: 1 階は基礎の立ち上がり 500 の上に階高、2 階はその上に階高 …（takeoff の 階高 + 0.5 と同じ量）
  let base = FOUND_H * 1000;
  const bands = floors.map((f) => {
    const b = { level: f.level, y0: base, y1: base + f.height };
    base += f.height;
    return b;
  });
  const bandOf = (lv: number) => bands.find((b) => b.level === lv) ?? bands[bands.length - 1];
  const add = (dir: WallDir, level: number, kind: WallKind, a: Vec2, b: Vec2, y0: number, y1: number) => {
    const right = rightVec(dir, axes);
    const ua = dot(a, right);
    const ub = dot(b, right);
    const len = Math.hypot(b.x - a.x, b.y - a.y) / 1000;
    const height = (y1 - y0) / 1000;
    if (len < 0.001 || height <= 0) return;
    pieces.push({ dir, level, kind, u0: Math.min(ua, ub), u1: Math.max(ua, ub), y0, y1, near: dot({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dirVec(dir, axes)), len, height, area: len * height });
  };
  for (const f of floors) {
    const band = bandOf(f.level);
    for (const loop of f.outline)
      for (let k = 0; k < loop.length; k++) {
        const a = loop[k];
        const b = loop[(k + 1) % loop.length];
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1) continue;
        const dir = wallDirOf(outwardOf(f, a, b), axes);
        if (f.level === 1) add(dir, 1, 'found', a, b, 0, FOUND_H * 1000);
        add(dir, f.level, 'wall', a, b, band.y0, band.y1);
      }
  }
  const top = floors[floors.length - 1];
  const box = opts.roofType === 'flat' || opts.roofType === 'shed';
  if (box && top) {
    // パラペット: 最上階の全辺だけ（下屋の縁は鼻隠しで立ち上がりは無い。拾いと同じ）
    const tb = bandOf(top.level);
    for (const loop of top.outline)
      for (let k = 0; k < loop.length; k++) {
        const a = loop[k];
        const b = loop[(k + 1) % loop.length];
        add(wallDirOf(outwardOf(top, a, b), axes), top.level, 'parapet', a, b, tb.y1, tb.y1 + PARAPET_H * 1000);
      }
  } else if (opts.roofType === 'gable' && top) {
    // 妻壁の三角 2 面: 棟は長手に通るので、三角は短辺側の 2 方位に 1 つずつ
    const bb = bboxOf(top.outline.flat());
    const w = bb.maxX - bb.minX;
    const h = bb.maxY - bb.minY;
    const shortAlongX = w < h;
    const S = Math.min(w, h);
    const rise = (S / 2) * (opts.pitch / 10);
    const tri = gableTriangleArea(top, opts.pitch);
    const band = bandOf(top.level);
    const corners: Vec2[] = [{ x: bb.minX, y: bb.minY }, { x: bb.maxX, y: bb.minY }, { x: bb.maxX, y: bb.maxY }, { x: bb.minX, y: bb.maxY }];
    for (const dir of WALL_DIRS) {
      const d = dirVec(dir, axes);
      const faces = shortAlongX ? Math.abs(d.y) > Math.abs(d.x) : Math.abs(d.x) > Math.abs(d.y);
      if (!faces) continue;
      const right = rightVec(dir, axes);
      const us = corners.map((c) => dot(c, right));
      pieces.push({ dir, level: top.level, kind: 'gable', u0: Math.min(...us), u1: Math.max(...us), y0: band.y1, y1: band.y1 + rise, near: Math.max(...corners.map((c) => dot(c, d))), len: S / 1000, height: rise / 1000, area: tri });
    }
  }
  // ガレージの外壁（断熱は入れないので壁の断熱面積から引く）: 1 階は基礎の立ち上がり分も
  for (const f of floors) {
    const band = bandOf(f.level);
    for (const g of f.rooms) {
      if (!isBuiltinGarage(g) || !inFloor(f, centroid(g.polygon).x, centroid(g.polygon).y)) continue;
      for (const run of exteriorRuns(f, g.polygon)) add(wallDirOf(run.outward, axes), f.level, 'garage', run.a, run.b, f.level === 1 ? 0 : band.y0, band.y1);
    }
  }
  // 集計（方位 × 種類 × 階）
  const byDir = Object.fromEntries(WALL_DIRS.map((d) => [d, { rows: [] as WallRow[], total: 0 }])) as WallBasis['byDir'];
  const order: WallKind[] = ['found', 'wall', 'parapet', 'gable'];
  for (const d of WALL_DIRS) {
    for (const kind of order)
      for (const band of bands) {
        const ps = pieces.filter((p) => p.dir === d && p.kind === kind && p.level === band.level);
        if (!ps.length) continue;
        if (kind === 'found' && band.level !== 1) continue;
        byDir[d].rows.push({ kind, level: band.level, len: r2(ps.reduce((s, p) => s + p.len, 0)), height: r2(ps[0].height), area: r2(ps.reduce((s, p) => s + p.area, 0)) });
      }
    byDir[d].total = r2(byDir[d].rows.reduce((s, r) => s + r.area, 0));
  }
  const total = r2(pieces.filter((p) => p.kind !== 'garage').reduce((s, p) => s + p.area, 0));
  const garageWall = r2(pieces.filter((p) => p.kind === 'garage').reduce((s, p) => s + p.area, 0));
  return { pieces, byDir, total, extWall: areas.extWall, garageWall, insulWall: areas.insulWall, bands, maxY: Math.max(...pieces.map((p) => p.y1), bands[bands.length - 1]?.y1 ?? 0), axes };
}

/** 点検用: 帯の合計が拾いの外壁面積と合っているか（丸めの差 0.05㎡ まで） */
export function basisTotalsMatch(model: BuildingModel, opts: TakeoffOptions): boolean {
  const wb = wallBasis(model, opts);
  return Math.abs(wb.total - wb.extWall) < 0.05 && Math.abs(wb.garageWall - (wb.extWall - wb.insulWall)) < 0.05;
}

// ---------------------------------------------------------------------------------------------
// 屋根・軒天・断熱
// ---------------------------------------------------------------------------------------------

export interface EaveRun {
  level: number;
  a: Vec2;
  b: Vec2;
  /** mm */
  len: number;
  outward: Vec2;
}

export interface RoofBasis {
  areas: Areas;
  /** 屋根の平面 (㎡) = 各階の外形を真上から重ねた面積 */
  union: number;
  loops: { level: number; loop: Vec2[] }[];
  topLevel: number;
  /** 軒の出 (m)。陸屋根は 0 */
  eavesM: number;
  /** 軒の出を付ける辺: 最上階の全辺＋下屋の縁 */
  eaveRuns: EaveRun[];
  /** 軒先の総延長 (m) */
  eaveLen: number;
  /** 軒の出の面積 (㎡) = 総延長 × 軒の出 */
  eaveArea: number;
  /** 勾配の倍率 */
  slope: number;
  roofArea: number;
  /** 外気に接する床（上の階が下の階より張り出した所の床下） (㎡) */
  overhang: number;
  soffitArea: number;
  /** ガレージの上が屋根になっている面積 (㎡)（天井の断熱から引き、軒天に足す） */
  garageCeil: number;
  garage: { level: number; room: Room; uncovered: number }[];
  /** 外形の中のポーチ・テラスの上が屋根になっている面積 (㎡)（天井の断熱から引き、軒天に足す） */
  porchCeil: number;
  insulArea: number;
  roofName: string;
}

export function roofBasis(model: BuildingModel, opts: TakeoffOptions): RoofBasis {
  const areas = takeoff(model, opts);
  const floors = model.floors.slice().sort((a, b) => a.level - b.level);
  const ov = overlay(floors);
  const top = floors[floors.length - 1];
  const eavesM = opts.roofType === 'flat' ? 0 : opts.eavesMm / 1000;
  const eaveRuns: EaveRun[] = [];
  if (top)
    for (const loop of top.outline)
      for (let k = 0; k < loop.length; k++) {
        const a = loop[k];
        const b = loop[(k + 1) % loop.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1) continue;
        eaveRuns.push({ level: top.level, a, b, len, outward: outwardOf(top, a, b) });
      }
  for (let i = 0; i < floors.length - 1; i++) {
    const f = floors[i];
    for (const run of uncoveredRuns(f, floors[i + 1])) eaveRuns.push({ level: f.level, a: run.a, b: run.b, len: run.len, outward: outwardOf(f, run.a, run.b) });
  }
  const eaveLen = r2(eaveRuns.reduce((s, r) => s + r.len, 0) / 1000);
  const slope = opts.roofType === 'flat' ? 1 : Math.sqrt(1 + (opts.pitch / 10) ** 2);
  const garage: RoofBasis['garage'] = [];
  let porchCeil = 0;
  for (let i = 0; i < floors.length; i++) {
    const f = floors[i];
    for (const g of f.rooms) {
      if (g.polygon.length < 3 || !inFloor(f, centroid(g.polygon).x, centroid(g.polygon).y)) continue;
      if (isBuiltinGarage(g)) garage.push({ level: f.level, room: g, uncovered: r2(uncoveredArea(g.polygon, floors.slice(i + 1))) });
      else if (g.type === 'porch') porchCeil += uncoveredArea(g.polygon, floors.slice(i + 1));
    }
  }
  const roofName = opts.roofType === 'flat' ? '陸屋根' : opts.roofType === 'shed' ? `片流れ ${opts.pitch} 寸` : opts.roofType === 'gable' ? `切妻 ${opts.pitch} 寸` : `寄棟 ${opts.pitch} 寸`;
  return {
    areas,
    union: r2(ov.union),
    loops: floors.flatMap((f) => f.outline.map((loop) => ({ level: f.level, loop }))),
    topLevel: top?.level ?? 1,
    eavesM,
    eaveRuns,
    eaveLen,
    eaveArea: r2(eaveLen * eavesM),
    slope,
    roofArea: areas.roofArea,
    overhang: r2(ov.exposedBelow.reduce((s, v) => s + v, 0)),
    soffitArea: areas.soffitArea,
    garageCeil: r2(garage.reduce((s, g) => s + g.uncovered, 0)),
    garage,
    porchCeil: r2(porchCeil),
    insulArea: areas.insulArea,
    roofName,
  };
}

// ---------------------------------------------------------------------------------------------
// 内部（床仕上げ・建具・水まわり）
// ---------------------------------------------------------------------------------------------

export type InteriorCat = FloorCategory | 'garage' | 'porch';
export const INTERIOR_CAT_LABEL: Record<InteriorCat, string> = {
  flooring: 'フローリング',
  tile: 'フロアタイル',
  tatami: '畳',
  doma: '土間（内部ポーチ）',
  garage: 'ガレージ土間（外部ポーチ扱い）',
  porch: '外部ポーチ',
  none: '拾わない（浴室・階段・吹抜など）',
};

export interface InteriorBasis {
  areas: Areas;
  floors: { level: number; floor: Floor; rooms: { room: Room; cat: InteriorCat; area: number }[]; doors: Vec2[]; toilets: Room[] }[];
  byCat: Record<InteriorCat, number>;
  /** 畳の枚数（1 帖） */
  tatamiCount: number;
  doors: number;
  toilets: number;
  stairs: number;
  kitchenType?: Areas['kitchenType'];
}

export function interiorBasis(model: BuildingModel, opts: TakeoffOptions): InteriorBasis {
  const areas = takeoff(model, opts);
  const floors = model.floors.slice().sort((a, b) => a.level - b.level);
  const byCat: Record<InteriorCat, number> = { flooring: 0, tile: 0, tatami: 0, doma: 0, garage: 0, porch: 0, none: 0 };
  const out = floors.map((f) => {
    const rooms = f.rooms.map((r) => {
      const cat: InteriorCat = isBuiltinGarage(r) && inFloor(f, centroid(r.polygon).x, centroid(r.polygon).y) ? 'garage' : r.type === 'porch' ? 'porch' : floorCategory(r);
      byCat[cat] += r.area;
      return { room: r, cat, area: r.area };
    });
    const doors: Vec2[] = [];
    for (const o of interiorDoors(f)) {
      const w = f.walls.find((x) => x.id === o.wallId);
      if (!w) continue;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
      const t = (o.t0 + o.t1) / 2;
      doors.push({ x: w.a.x + ((w.b.x - w.a.x) / L) * t, y: w.a.y + ((w.b.y - w.a.y) / L) * t });
    }
    const toilets = f.rooms.filter((r) => r.type === 'toilet' || /トイレ|便所|ＷＣ|WC/.test(r.name));
    return { level: f.level, floor: f, rooms, doors, toilets };
  });
  for (const k of Object.keys(byCat) as InteriorCat[]) byCat[k] = r2(byCat[k]);
  return { areas, floors: out, byCat, tatamiCount: areas.tatami1, doors: areas.doors, toilets: areas.toilets, stairs: areas.stairs, kitchenType: areas.kitchenType };
}
