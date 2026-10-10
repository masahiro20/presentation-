/**
 * 周辺建物の扱いの開示（日影図の SVG・レポート・画面の注記）
 *
 * 計算から除外した建物・表示だけ隠した建物・敷地に重なって自動で外した建物を、印刷物にいつも書き出す
 * （「都合の悪い建物を勝手に消した」と言われないように、何を・なぜ外したかを残す）。
 *  - neighborDisclosure(): 数と理由ごとの内訳（想定の家 = 未建築の仮の建物の棟数と、含めているかも）
 *  - disclosureLines(): 注記の文（日影図の脚注・レポートの各ページ）
 *  - appendSvgFootnote(): 日影図の SVG の下に脚注を足す（viewBox を伸ばす。svgFootnote.ts）
 *  - neighborWhere(): 建物からの方向・距離（「約 12 m・南側」）
 *
 * DOM を使わない（vitest で読み込める）。
 */
import { buildingCenter, buildingExclusionEN, buildingFootprintEN } from './building';
import { siteExcludedCount } from './environment';
import { effectiveNeighbors, excludedNeighbors, study, viewOnlyNeighbors } from './state';
import { HIDE_REASONS, HIDE_REASON_LABEL, bearingName, worldToEN } from './types';
import type { EN, Neighbor, NeighborHideReason, NeighborSource } from './types';

/** 出典の短い名前 */
export const SOURCE_SHORT: Record<NeighborSource, string> = { plateau: 'PLATEAU', gsi: '国土地理院', osm: 'OpenStreetMap', manual: '手入力' };

// ---------------------------------------------------------------------------
// 方向・距離
// ---------------------------------------------------------------------------

function segDist(p: EN, a: EN, b: EN): number {
  const dx = b.e - a.e;
  const dy = b.n - a.n;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((p.e - a.e) * dx + (p.n - a.n) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.e - (a.e + dx * t), p.n - (a.n + dy * t));
}

/** 2 つの輪郭の最短距離（辺と頂点。重なっていても辺どうしの距離）。片方が 1 点でもよい */
export function ringDistance(a: EN[], b: EN[]): number {
  let d = Infinity;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) d = Math.min(d, segDist(a[i], b[j], b[(j + 1) % b.length]), segDist(b[j], a[i], a[(i + 1) % a.length]));
  return d;
}

/** 頂点の平均 */
export function ringMean(r: EN[]): EN {
  let e = 0;
  let n = 0;
  for (const p of r) {
    e += p.e;
    n += p.n;
  }
  const k = Math.max(1, r.length);
  return { e: e / k, n: n / k };
}

/** from → to の方位（真北から時計回り、度） */
export function bearingEN(from: EN, to: EN): number {
  return ((Math.atan2(to.e - from.e, to.n - from.n) * 180) / Math.PI + 360) % 360;
}

/**
 * 建物からの距離（足跡の輪郭どうし。建物が無ければピンから）と、建物の中心から見た方向。
 * ref・center を省略すると今の配置済み建物（buildingFootprintEN・buildingCenter）
 */
export function neighborWhere(n: Neighbor, ref?: EN[] | null, center?: EN): { dist: number; bearing: number; text: string } {
  const fp = ref === undefined ? buildingFootprintEN() : ref;
  const r: EN[] = fp && fp.length >= 3 ? fp : [{ e: 0, n: 0 }];
  const c = center ?? worldToEN(buildingCenter());
  const dist = ringDistance(n.ring, r);
  const bearing = bearingEN(c, ringMean(n.ring));
  return { dist, bearing, text: `約 ${Math.round(dist)} m・${bearingName(bearing)}側` };
}

// ---------------------------------------------------------------------------
// 数と理由
// ---------------------------------------------------------------------------

export interface NeighborDisclosure {
  /** 計算から除外した建物（自分で隠したもの。隠し方 'exclude'） */
  excluded: Neighbor[];
  /** 表示だけ隠した建物（影・解析には含む） */
  viewOnly: Neighbor[];
  /** 計算から除外した建物の理由ごとの数（理由の順: 解体予定・敷地内の既存建物・データの誤り・その他。0 の理由は省く） */
  byReason: { reason: NeighborHideReason; label: string; count: number }[];
  /** 敷地の輪郭・計画建物の外形に重なるため自動で外した自動取得の建物の数 */
  autoOnSite: number;
  /**
   * 想定の家（未建築・仮の形状）: count = 計算から除外していない想定の家の棟数（表示だけ隠したものも数える）、
   * enabled = 影・解析に含めているか（study.plannedEnabled）。古い呼び出し側が作った値には無い
   */
  planned?: { count: number; enabled: boolean };
}

/** 隠した理由の文（「その他（倉庫）」のように補足を付ける） */
export function hideReasonText(n: Neighbor): string {
  const r = n.hideReason ?? 'other';
  const label = HIDE_REASON_LABEL[r] ?? HIDE_REASON_LABEL.other;
  return n.hideNote ? `${label}（${n.hideNote}）` : label;
}

/** 今の状態の開示（exclusion は敷地内の自動除外の判定に使う計画建物の外形。省略時は今の配置済み建物） */
export function neighborDisclosure(exclusion?: EN[] | null): NeighborDisclosure {
  const excluded = excludedNeighbors();
  const viewOnly = viewOnlyNeighbors();
  const byReason = HIDE_REASONS.map((reason) => ({ reason, label: HIDE_REASON_LABEL[reason], count: excluded.filter((n) => (n.hideReason ?? 'other') === reason).length })).filter((x) => x.count > 0);
  const autoOnSite = siteExcludedCount(exclusion === undefined ? buildingExclusionEN() : exclusion);
  const planned = { count: effectiveNeighbors().filter((n) => n.planned && (!n.hidden || n.hideMode === 'view')).length, enabled: study.plannedEnabled };
  return { excluded, viewOnly, byReason, autoOnSite, planned };
}

/** 「想定で置いた建物 N 棟（未建築・仮の形状。影・解析に含む）」（含めていなければ「…今は含めていません」）。無ければ null */
export function plannedLine(d: Pick<NeighborDisclosure, 'planned'>): string | null {
  const p = d.planned;
  if (!p || !p.count) return null;
  return `想定で置いた建物 ${p.count} 棟（未建築・仮の形状。${p.enabled ? '影・解析に含む' : '今は含めていません'}）`;
}

/** 「計算から除外した周辺建物 3 棟（解体予定 2・データの誤り 1）」。無ければ「計算から除外した周辺建物 なし」 */
export function excludedLine(d: NeighborDisclosure): string {
  if (!d.excluded.length) return '計算から除外した周辺建物 なし';
  return `計算から除外した周辺建物 ${d.excluded.length} 棟（${d.byReason.map((x) => `${x.label} ${x.count}`).join('・')}）`;
}

/** 「表示だけ隠した建物 N 棟（影・解析には含む）」。無ければ null */
export function viewOnlyLine(d: NeighborDisclosure): string | null {
  return d.viewOnly.length ? `表示だけ隠した建物 ${d.viewOnly.length} 棟（影・解析には含む）` : null;
}

/**
 * 注記の文（日影図の脚注・レポートのページ）。
 *  1. 計算から除外した周辺建物（理由ごとの数。無ければ「なし」）
 *  2. 表示だけ隠した建物（ある時だけ）
 *  3. 想定で置いた建物（未建築の隣家。ある時だけ。含めていなければその旨）
 *  4. 敷地・計画建物に重なって自動で外した自動取得の建物（ある時だけ）
 * neighborsInCalc = false（自建物のみの日影図）なら、先頭で「この図は自建物のみで計算」と断る
 */
export function disclosureLines(opts: { neighborsInCalc?: boolean; disclosure?: NeighborDisclosure } = {}): string[] {
  const d = opts.disclosure ?? neighborDisclosure();
  const lines: string[] = [];
  const head = opts.neighborsInCalc === false ? '周辺建物の扱い（この図は自建物のみで計算。以下は 3D・日照解析での扱い）: ' : '周辺建物の扱い: ';
  lines.push(head + excludedLine(d));
  const v = viewOnlyLine(d);
  if (v) lines.push(v);
  const pl = plannedLine(d);
  if (pl) lines.push(pl);
  if (d.autoOnSite > 0) lines.push(`敷地・計画建物に重なる自動取得の建物 ${d.autoOnSite} 棟は自動で除外`);
  return lines;
}

export { appendSvgFootnote, wrapFootnote } from './svgFootnote';
