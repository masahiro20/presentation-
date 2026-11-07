/**
 * 敷地の高低差（SiteLevels）の共通の計算（DOM・3D に依存しない）:
 * 辺の向きと高さ、玄関の階段の段数、説明の文、国土地理院の標高データからの推定、擁壁・階段の数量（資金計画の概算）
 */
import { APPROACH_LABEL, RETAINING_LABEL, type BuildingModel, type PlanSide, type RetainingKind, type SiteLevels } from './types';

export const PLAN_SIDES: readonly PlanSide[] = ['top', 'right', 'bottom', 'left'];

/** 外向きの向き（ワールド x = 図面の右、z = 図面の下）から、図面の辺 */
export function sideOfOutward(x: number, z: number): PlanSide {
  if (Math.abs(x) >= Math.abs(z)) return x >= 0 ? 'right' : 'left';
  return z >= 0 ? 'bottom' : 'top';
}

/** 図面の辺に方位を添える: 「上（北）」。northDeg は図面の上から時計回りの真北の向き */
export function planSideCompass(side: PlanSide, northDeg: number): string {
  const names: Record<PlanSide, string> = { top: '上', bottom: '下', right: '右', left: '左' };
  const a = (northDeg * Math.PI) / 180;
  const nv = { x: Math.sin(a), y: -Math.cos(a) };
  const ev = { x: -nv.y, y: nv.x };
  const sv: Record<PlanSide, { x: number; y: number }> = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, right: { x: 1, y: 0 }, left: { x: -1, y: 0 } };
  const dn = sv[side].x * nv.x + sv[side].y * nv.y;
  const de = sv[side].x * ev.x + sv[side].y * ev.y;
  const comp = Math.abs(dn) >= Math.abs(de) ? (dn > 0 ? '北' : '南') : de > 0 ? '東' : '西';
  return `${names[side]}（${comp}）`;
}

/** 設計 GL に対する辺の地盤の高さ (m)。道路側は路面、ほかは隣地 */
export function levelAtSide(levels: SiteLevels | undefined, side: PlanSide, isRoad: boolean): number {
  if (!levels) return 0;
  const mm = isRoad ? levels.roadMm : levels.neighborMm?.[side];
  return (mm ?? 0) / 1000;
}

/** 高低差の設定があるか（どれかの辺が 5 cm 以上） */
export function hasLevels(levels?: SiteLevels): boolean {
  if (!levels) return false;
  if (Math.abs(levels.roadMm ?? 0) >= 50) return true;
  return Object.values(levels.neighborMm ?? {}).some((v) => Math.abs(v ?? 0) >= 50);
}

/** 玄関の階段: 蹴上 180 以下になる段数と、踏面 300 の奥行 */
export function stepCount(diffMm: number): { n: number; riserMm: number; treadMm: number; runMm: number } {
  const d = Math.abs(diffMm);
  if (d < 30) return { n: 0, riserMm: 0, treadMm: 300, runMm: 0 };
  const n = Math.max(1, Math.ceil(d / 180));
  const treadMm = n >= 8 ? 280 : 300;
  return { n, riserMm: Math.round(d / n), treadMm, runMm: n * treadMm };
}

const cm = (mm: number) => `${Math.round(Math.abs(mm) / 10)} cm`;

/** 設定の説明（確認用の 1〜数行） */
export function levelsSummary(levels: SiteLevels | undefined, northDeg: number): string[] {
  const out: string[] = [];
  if (!levels) return out;
  const r = levels.roadMm ?? 0;
  if (Math.abs(r) >= 50) {
    const how = levels.retaining ?? 'rc';
    const ap = levels.approach ?? 'steps';
    const st = stepCount(r);
    out.push(
      `道路が敷地より ${cm(r)} ${r < 0 ? '低い' : '高い'}（${RETAINING_LABEL[how]}・${APPROACH_LABEL[ap]}${ap === 'steps' && st.n ? ` ${st.n} 段` : ''}${levels.parkingAtRoad && r < 0 ? '・駐車場は道路の高さ' : ''}）`,
    );
  }
  for (const s of PLAN_SIDES) {
    const v = levels.neighborMm?.[s] ?? 0;
    if (Math.abs(v) >= 50) out.push(`${planSideCompass(s, northDeg)}の隣地が ${cm(v)} ${v < 0 ? '低い' : '高い'}`);
  }
  return out;
}

/** 標高の標本（m）の中央値。有効値が無ければ NaN */
export function median(vals: number[]): number {
  const v = vals.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export interface LevelSamples {
  /** 建物の足元（設計 GL の基準にする）の標高 m */
  gl: number[];
  /** 前面道路の路面の標高 m */
  road: number[];
  /** 隣地（辺ごと）の標高 m */
  neighbors: Partial<Record<PlanSide, number[]>>;
}

/**
 * 標高データの標本から高低差を決める。差が解像度相応の誤差（1m メッシュ 15 cm・5m 以上 25 cm）より小さければ 0、
 * それ以外は 5 cm 刻み。隣地の差は 3 m（建物 1 階分）までに丸める（データの誤りで極端な値が出ないように）
 */
export function levelsFromSamples(s: LevelSamples, opts: { resolutionM: number; sourceLabel: string; roadSide?: PlanSide }): SiteLevels | null {
  const gl = median(s.gl);
  if (!Number.isFinite(gl)) return null;
  const noise = opts.resolutionM <= 1.5 ? 0.15 : 0.25;
  const diff = (vals: number[] | undefined): number | undefined => {
    if (!vals?.length) return undefined;
    const m = median(vals);
    if (!Number.isFinite(m)) return undefined;
    const d = m - gl;
    if (Math.abs(d) < noise) return 0;
    return Math.max(-3000, Math.min(3000, Math.round((d * 1000) / 50) * 50));
  };
  const out: SiteLevels = { source: 'dem', note: `${opts.sourceLabel}から推定（誤差 ±${Math.round(noise * 100)} cm 程度。現地で確認してください）` };
  const r = diff(s.road);
  if (r != null) out.roadMm = r;
  const nb: Partial<Record<PlanSide, number>> = {};
  for (const side of PLAN_SIDES) {
    if (side === opts.roadSide) continue;
    const d = diff(s.neighbors[side]);
    if (d != null && d !== 0) nb[side] = d;
  }
  if (Object.keys(nb).length) out.neighborMm = nb;
  return out;
}

/** 敷地の外形（図面座標 mm）: 図面の敷地線 → 無ければ建物の外形に標準の余白（道路側 6 m・ほか 1.6 m） */
export function siteExtentsMm(model: BuildingModel, roadSide: PlanSide | null): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const poly = model.site?.polygon;
  if (poly && poly.length >= 3) {
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }
  const pts = model.floors.flatMap((f) => f.outline.flat());
  if (pts.length < 3) return null;
  const b = { minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxX: Math.max(...pts.map((p) => p.x)), maxY: Math.max(...pts.map((p) => p.y)) };
  const bd = model.site?.bounds ?? {};
  const m = (side: PlanSide) => (roadSide === side ? 6000 : 1600);
  return {
    minX: bd.left ?? b.minX - m('left'),
    maxX: bd.right ?? b.maxX + m('right'),
    minY: bd.top ?? b.minY - m('top'),
    maxY: bd.bottom ?? b.maxY + m('bottom'),
  };
}

/** 主な道路側（図面の接道 → 無ければ null） */
export function roadSideOf(model: BuildingModel): PlanSide | null {
  const roads = model.site?.roads ?? [];
  if (!roads.length) return null;
  return roads.slice().sort((a, b) => (b.source === 'manual' ? 1 : 0) - (a.source === 'manual' ? 1 : 0) || (b.widthMm ?? 0) - (a.widthMm ?? 0))[0].side;
}

export interface RetainingQuantities {
  kind: RetainingKind;
  /** 自分の敷地で造る擁壁（敷地の方が高い辺）: 辺ごとの長さ m と高さ m */
  walls: { side: PlanSide; lengthM: number; heightM: number }[];
  wallAreaM2: number;
  /** 玄関の階段の段数（スロープなら 0） */
  steps: number;
  ramp: boolean;
}

/** 擁壁・階段の数量（資金計画の概算用）。道路側・隣地側とも「敷地の方が高い」辺に自分の擁壁を見込む */
export function retainingQuantities(model: BuildingModel): RetainingQuantities | null {
  const lv = model.siteLevels;
  if (!hasLevels(lv)) return null;
  const roadSide = roadSideOf(model);
  const ext = siteExtentsMm(model, roadSide);
  if (!ext) return null;
  const lenOf = (side: PlanSide) => ((side === 'top' || side === 'bottom' ? ext.maxX - ext.minX : ext.maxY - ext.minY) / 1000);
  const walls: RetainingQuantities['walls'] = [];
  for (const side of PLAN_SIDES) {
    const mm = side === roadSide ? (lv!.roadMm ?? 0) : (lv!.neighborMm?.[side] ?? 0);
    if (mm < -50) walls.push({ side, lengthM: Math.round(lenOf(side) * 10) / 10, heightM: Math.round((-mm / 1000) * 100) / 100 });
  }
  const kind = lv!.retaining ?? 'rc';
  const wallAreaM2 = Math.round(walls.reduce((s, w) => s + w.lengthM * w.heightM, 0) * 10) / 10;
  const r = lv!.roadMm ?? 0;
  const ramp = (lv!.approach ?? 'steps') === 'ramp' && Math.abs(r) >= 50;
  const steps = ramp ? 0 : stepCount(r).n;
  return { kind, walls, wallAreaM2, steps, ramp };
}
