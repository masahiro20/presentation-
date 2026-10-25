/**
 * 設計の 3D データ（ARCHITREND ZERO の 3DS 書き出しなど）から高さを測り、PDF から読んだ間取りに反映する。
 *
 * PDF の平面図には高さが書かれていないので、床の高さ・階高・窓の腰高と高さ・屋根の形と勾配は推定になる。
 * 3DS は部材の名前（壁・窓など）を持たないが、形（mm 単位）と素材（ガラスは透明）は正確なので、
 *   - 床: 各階の部屋の中にある、上を向いた水平な面の高さ（面積が一番大きい高さ）
 *   - 地面: 1 階の床より下で一番広い水平面（敷地）
 *   - 窓: 透明な素材（ガラス）のかたまりの下端・上端・幅
 *   - 屋根: 上を向いた傾いた面の勾配と向きの数（0 = 陸屋根、1 = 片流れ、2 = 切妻、4 = 寄棟）
 * を測る。3DS は間取りに位置合わせ（日照の 3DS パネルの自動合わせ）した後のワールド座標（m, Y が上）で受け取る。
 */
import type { BuildingModel, Floor, Opening, Vec2 } from '../core/types';
import type { RoofType } from '../styles/presets';
import { pointInPolygon } from '../core/geometry';

const MM = 0.001;

export interface GlassPanel {
  /** 中心（ワールド m） */
  cx: number;
  cz: number;
  yMin: number;
  yMax: number;
  /** 水平の幅 (m) と向き（x 方向に長いか） */
  width: number;
  alongX: boolean;
}

export interface Measured3d {
  groundY: number | null;
  /** 階ごとの床の高さ（ワールド m）。測れなかった階は null */
  floorY: (number | null)[];
  topY: number;
  roof: { type: RoofType; pitch: number; slopeArea: number } | null;
  glass: GlassPanel[];
}

interface Tri {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  cx: number;
  cy: number;
  cz: number;
}

function* tris(a: Float32Array): Generator<Tri> {
  for (let i = 0; i + 8 < a.length; i += 9) yield { ax: a[i], ay: a[i + 1], az: a[i + 2], bx: a[i + 3], by: a[i + 4], bz: a[i + 5], cx: a[i + 6], cy: a[i + 7], cz: a[i + 8] };
}

function normalArea(t: Tri): { nx: number; ny: number; nz: number; area: number } {
  const ux = t.bx - t.ax;
  const uy = t.by - t.ay;
  const uz = t.bz - t.az;
  const vx = t.cx - t.ax;
  const vy = t.cy - t.ay;
  const vz = t.cz - t.az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  return l < 1e-12 ? { nx: 0, ny: 0, nz: 0, area: 0 } : { nx: nx / l, ny: ny / l, nz: nz / l, area: l / 2 };
}

/** 階の部屋（吹抜を除く）の外形をワールド XZ に */
function floorPolys(f: Floor): Vec2[][] {
  return f.rooms.filter((r) => r.type !== 'void' && r.polygon.length >= 3).map((r) => r.polygon);
}

function insideFloor(polys: Vec2[][], x: number, z: number): boolean {
  const p = { x: x / MM, y: z / MM };
  return polys.some((poly) => pointInPolygon(p, poly));
}

/**
 * 位置合わせ済みの 3D の三角形（ワールド m・9 floats / 三角形）から高さを測る。
 * @param solid ガラス以外の三角形
 * @param glass ガラスの三角形
 * @param expectFloorY 今の間取りの各階の床の高さ（ワールド m）: どの水平面がどの階の床かを決める目安
 */
export function measure3d(model: BuildingModel, solid: Float32Array, glass: Float32Array, expectFloorY: number[]): Measured3d {
  const floors = [...model.floors].sort((a, b) => a.level - b.level);
  const polys = floors.map(floorPolys);
  // ---- 水平面（上向き）: 階ごとに部屋の中の面積を高さ 2cm 刻みで集計 ----
  const bins = floors.map(() => new Map<number, number>());
  const groundBins = new Map<number, number>();
  const slopes = new Map<string, number>();
  /** 向きごとの傾いた面の一番高い所（切妻なら両側が棟で同じ高さになる） */
  const dirTop = new Map<number, number>();
  let topY = -Infinity;
  let minY = Infinity;
  let slopeArea = 0;
  for (const t of tris(solid)) {
    const { nx, ny, nz, area } = normalArea(t);
    if (area <= 0) continue;
    topY = Math.max(topY, t.ay, t.by, t.cy);
    minY = Math.min(minY, t.ay, t.by, t.cy);
    const y = (t.ay + t.by + t.cy) / 3;
    const x = (t.ax + t.bx + t.cx) / 3;
    const z = (t.az + t.bz + t.cz) / 3;
    if (ny > 0.9995) {
      const k = Math.round(y / 0.02);
      groundBins.set(k, (groundBins.get(k) ?? 0) + area);
      floors.forEach((_, i) => {
        if (Math.abs(y - expectFloorY[i]) > 0.9) return;
        if (!insideFloor(polys[i], x, z)) return;
        bins[i].set(k, (bins[i].get(k) ?? 0) + area);
      });
    } else if (ny > 0.05 && area > 0.02) {
      // 上を向いた傾いた面（屋根・庇）: 勾配（寸）と向き（45° 刻み）
      const sun = Math.round((Math.sqrt(1 - ny * ny) / ny) * 10 * 2) / 2;
      if (sun > 0 && sun <= 12) {
        const dir = Math.round((Math.atan2(nz, nx) * 180) / Math.PI / 45) * 45;
        const d360 = ((dir % 360) + 360) % 360;
        const key = `${sun}|${d360}`;
        slopes.set(key, (slopes.get(key) ?? 0) + area);
        dirTop.set(d360, Math.max(dirTop.get(d360) ?? -Infinity, t.ay, t.by, t.cy));
        slopeArea += area;
      }
    }
  }
  const peak = (m: Map<number, number>, min: number): number | null => {
    let best: number | null = null;
    let bestA = min;
    for (const [k, a] of m) {
      // 隣の刻みもまとめて（仕上げの厚み）
      const s = a + (m.get(k - 1) ?? 0) * 0.5 + (m.get(k + 1) ?? 0) * 0.5;
      if (s > bestA) {
        bestA = s;
        best = k * 0.02;
      }
    }
    return best;
  };
  const floorY = floors.map((f, i) => {
    const area = f.rooms.filter((r) => r.type !== 'void').reduce((s, r) => s + r.area, 0);
    return peak(bins[i], Math.max(4, area * 0.25));
  });
  // 地面: 3D の一番下（敷地の板を隠していても基礎の下端 ≒ GL）。1 階の床との差が 5cm〜1.5m のときだけ信じる。
  // そうでなければ 1 階の床より 5cm 以上下で一番広い水平面（敷地の板）
  let groundY: number | null = null;
  if (floorY[0] != null && Number.isFinite(minY) && floorY[0] - minY >= 0.05 && floorY[0] - minY <= 1.5) groundY = minY;
  else if (floorY[0] != null) {
    let best = 0;
    for (const [k, a] of groundBins) {
      const y = k * 0.02;
      if (y < floorY[0]! - 0.05 && a > best) {
        best = a;
        groundY = y;
      }
    }
  }
  // ---- 屋根: 主な勾配と向きの数 ----
  let roof: Measured3d['roof'] = null;
  const footprint = floors[0] ? floors[0].rooms.reduce((s, r) => s + r.area, 0) : 0;
  if (slopeArea > Math.max(6, footprint * 0.25)) {
    const byDir = new Map<number, number>();
    const byPitch = new Map<number, number>();
    for (const [key, a] of slopes) {
      const [p, d] = key.split('|').map(Number);
      byDir.set(d, (byDir.get(d) ?? 0) + a);
      byPitch.set(p, (byPitch.get(p) ?? 0) + a);
    }
    const dirs = [...byDir.entries()].filter(([, a]) => a > slopeArea * 0.12).map(([d]) => d);
    const pitch = [...byPitch.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // 切妻: 向かい合う 2 面が同じ高さの棟で出会う。高さが違う向かい合わせは、別々の片流れ（御社の箱の家に多い）
    const ridge = dirs.some((d) => dirs.includes((d + 180) % 360) && Math.abs((dirTop.get(d) ?? 0) - (dirTop.get((d + 180) % 360) ?? 0)) < 0.08);
    const type: RoofType = dirs.length >= 4 ? 'hip' : ridge ? 'gable' : 'shed';
    roof = { type, pitch, slopeArea };
  } else {
    roof = { type: 'flat', pitch: 0, slopeArea };
  }
  return { groundY, floorY, topY: Number.isFinite(topY) ? topY : 0, roof, glass: glassPanels(glass) };
}

/** ガラスの三角形を、近いものどうしでまとめて窓 1 枚ずつに（障子が複数枚の窓は 1 つに） */
export function glassPanels(glass: Float32Array): GlassPanel[] {
  const boxes: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }[] = [];
  for (const t of tris(glass)) {
    boxes.push({ x0: Math.min(t.ax, t.bx, t.cx), x1: Math.max(t.ax, t.bx, t.cx), y0: Math.min(t.ay, t.by, t.cy), y1: Math.max(t.ay, t.by, t.cy), z0: Math.min(t.az, t.bz, t.cz), z1: Math.max(t.az, t.bz, t.cz) });
  }
  // 素朴な合体（ガラスの三角形は数百程度）: 12cm 以内で重なる箱を繰り返しまとめる
  const gap = 0.12;
  const near = (a: (typeof boxes)[number], b: (typeof boxes)[number]) => a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1 && a.z0 - gap <= b.z1 && b.z0 - gap <= a.z1;
  let merged = true;
  let list = boxes;
  while (merged) {
    merged = false;
    const out: typeof boxes = [];
    for (const b of list) {
      const hit = out.find((o) => near(o, b));
      if (hit) {
        hit.x0 = Math.min(hit.x0, b.x0);
        hit.x1 = Math.max(hit.x1, b.x1);
        hit.y0 = Math.min(hit.y0, b.y0);
        hit.y1 = Math.max(hit.y1, b.y1);
        hit.z0 = Math.min(hit.z0, b.z0);
        hit.z1 = Math.max(hit.z1, b.z1);
        merged = true;
      } else out.push({ ...b });
    }
    list = out;
  }
  return list
    .filter((b) => b.y1 - b.y0 > 0.15 && Math.max(b.x1 - b.x0, b.z1 - b.z0) > 0.12)
    .map((b) => {
      const alongX = b.x1 - b.x0 >= b.z1 - b.z0;
      return { cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2, yMin: b.y0, yMax: b.y1, width: alongX ? b.x1 - b.x0 : b.z1 - b.z0, alongX };
    });
}

/** ガラスは障子・枠の内側なので、窓の外寸はガラスより少し大きい（片側の見込み） */
const FRAME = 40;

export interface HeightChanges {
  model: BuildingModel;
  /** 足した窓の数 */
  windowsAdded?: number;
  roof: { type: RoofType; pitch: number } | null;
  notes: string[];
  windowsMatched: number;
  windowsTotal: number;
}

function openingCenter(f: Floor, o: Opening): { x: number; z: number; alongX: boolean; len: number } | null {
  const w = f.walls.find((x) => x.id === o.wallId);
  if (!w) return null;
  const dx = w.b.x - w.a.x;
  const dy = w.b.y - w.a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1) return null;
  const t = (o.t0 + o.t1) / 2 / L;
  return { x: (w.a.x + dx * t) * MM, z: (w.a.y + dy * t) * MM, alongX: Math.abs(dx) >= Math.abs(dy), len: (o.t1 - o.t0) * MM };
}

/**
 * 測った高さを間取りに反映した新しいモデル（元は変えない）。
 * @param floorWorldY 今の間取りの各階の床（ワールド m）
 */
export function applyMeasured(model: BuildingModel, m: Measured3d, floorWorldY: number[]): HeightChanges {
  const out: BuildingModel = JSON.parse(JSON.stringify(model));
  const floors = [...out.floors].sort((a, b) => a.level - b.level);
  const notes: string[] = [];
  // 床の高さ（GL から）: 地面が測れたときだけ 1 階の床高を直す。上の階は 1 階からの差で
  const base = m.groundY;
  const fy = m.floorY;
  const orig = floors.map((f) => f.elevation);
  if (base != null && fy[0] != null) {
    const e1 = Math.round(((fy[0] - base) / MM) / 10) * 10;
    if (e1 > 100 && e1 < 1500 && Math.abs(e1 - floors[0].elevation) >= 20) {
      notes.push(`1 階の床の高さ GL+${floors[0].elevation} → GL+${e1}`);
      floors[0].elevation = e1;
    }
  }
  // 上の階: すぐ下の階の床からの差（階高）で。測れなかった階はその下の階に合わせて動かすだけ
  for (let i = 1; i < floors.length; i++) {
    const cur = orig[i] - orig[i - 1];
    let h = cur;
    if (fy[i] != null && fy[i - 1] != null) {
      const rel = Math.round(((fy[i]! - fy[i - 1]!) / MM) / 10) * 10;
      if (rel > 2200 && rel < 4500) h = rel;
    }
    floors[i].elevation = floors[i - 1].elevation + h;
    if (Math.abs(h - cur) >= 20) notes.push(`${floors[i - 1].level} 階の階高 ${cur} → ${h}`);
  }
  // 階高は次の階の床までの差
  for (let i = 0; i + 1 < floors.length; i++) {
    const h = floors[i + 1].elevation - floors[i].elevation;
    if (h > 2200 && h !== floors[i].height) floors[i].height = h;
  }
  // 窓: 開口の中心に一番近い、同じ向きのガラス（中心のずれ 0.35m 以内、幅の差 60% 以内）
  let matched = 0;
  let total = 0;
  const used = new Set<GlassPanel>();
  floors.forEach((f, i) => {
    const fwy = floorWorldY[i] ?? f.elevation * MM;
    // 測った床とずれていたら、ガラスの高さは測った床から
    const floorY = fy[i] ?? fwy;
    for (const o of f.openings) {
      if (o.kind !== 'window') continue;
      total++;
      const c = openingCenter(f, o);
      if (!c) continue;
      let best: GlassPanel | null = null;
      let bestD = 0.35;
      for (const g of m.glass) {
        if (used.has(g) || g.alongX !== c.alongX) continue;
        if (g.yMin < floorY - 0.2 || g.yMin > floorY + 2.6) continue;
        const d = Math.hypot(g.cx - c.x, g.cz - c.z);
        if (d < bestD && Math.abs(g.width - c.len) < Math.max(0.3, c.len * 0.6)) {
          bestD = d;
          best = g;
        }
      }
      if (!best) continue;
      used.add(best);
      matched++;
      const sill = Math.max(0, Math.round(((best.yMin - floorY) / MM - FRAME) / 10) * 10);
      const height = Math.round(((best.yMax - best.yMin) / MM + FRAME * 2) / 10) * 10;
      if (Math.abs(sill - o.sill) >= 30 || Math.abs(height - o.height) >= 30) {
        o.sill = sill;
        o.height = height;
      }
    }
  });
  if (total) notes.push(`窓の高さ: ${matched} / ${total} か所を 3D データのガラスに合わせました`);
  // 図面から読めなかった窓: 外壁の上にあるのに、どの開口とも重ならないガラスは窓として足す
  let added = 0;
  for (const g of m.glass) {
    if (used.has(g) || g.width < 0.25) continue;
    // どの階か: ガラスの下端より下で一番高い床
    let fi = -1;
    floors.forEach((f, i) => {
      const y = fy[i] ?? floorWorldY[i] ?? f.elevation * MM;
      if (y <= g.yMin + 0.3) fi = i;
    });
    if (fi < 0) continue;
    const f = floors[fi];
    const floorY = fy[fi] ?? floorWorldY[fi] ?? f.elevation * MM;
    if (g.yMax - floorY > 3.2) continue;
    let best: { w: (typeof f.walls)[number]; t: number; L: number; d: number } | null = null;
    for (const w of f.walls) {
      if (!w.exterior) continue;
      const dx = w.b.x - w.a.x;
      const dy = w.b.y - w.a.y;
      const L = Math.hypot(dx, dy);
      if (L < 600 || (Math.abs(dx) >= Math.abs(dy)) !== g.alongX) continue;
      const px = g.cx / MM - w.a.x;
      const py = g.cz / MM - w.a.y;
      const t = (px * dx + py * dy) / L;
      const d = Math.abs(px * dy - py * dx) / L;
      if (t < 0 || t > L || d > 350) continue;
      if (!best || d < best.d) best = { w, t, L, d };
    }
    if (!best) continue;
    const half = (g.width / MM) / 2 + FRAME;
    const t0 = Math.max(0, Math.round(best.t - half));
    const t1 = Math.min(best.L, Math.round(best.t + half));
    if (f.openings.some((o) => o.wallId === best!.w.id && o.t0 < t1 + 50 && o.t1 > t0 - 50)) continue;
    const sill = Math.max(0, Math.round(((g.yMin - floorY) / MM - FRAME) / 10) * 10);
    const height = Math.round(((g.yMax - g.yMin) / MM + FRAME * 2) / 10) * 10;
    f.openings.push({ id: `o3d-${f.level}-${++added}`, wallId: best.w.id, kind: 'window', t0, t1, sill, height, windowStyle: height >= 1800 && sill < 200 ? 'hakidashi' : height <= 700 ? (sill >= 1300 ? 'high' : 'small') : 'koshi', confidence: 0.9 });
  }
  if (added) notes.push(`図面から読めなかった窓 ${added} か所を 3D データから足しました`);
  let roof: HeightChanges['roof'] = null;
  if (m.roof) {
    roof = { type: m.roof.type, pitch: m.roof.pitch };
    notes.push(m.roof.type === 'flat' ? '屋根: 陸屋根（傾いた屋根面なし）' : `屋根: ${{ shed: '片流れ', gable: '切妻', hip: '寄棟', flat: '陸屋根' }[m.roof.type]} ${m.roof.pitch} 寸`);
  }
  if (base != null) notes.push(`最高高さ GL+${Math.round((m.topY - base) / MM / 10) * 10}`);
  return { model: out, roof, notes, windowsMatched: matched, windowsTotal: total, windowsAdded: added };
}
