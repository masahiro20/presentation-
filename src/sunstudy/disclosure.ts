/**
 * 周辺建物の扱いの開示（日影図の SVG・レポート・画面の注記）
 *
 * 計算から除外した建物・表示だけ隠した建物・敷地に重なって自動で外した建物を、印刷物にいつも書き出す
 * （「都合の悪い建物を勝手に消した」と言われないように、何を・なぜ外したかを残す）。
 *  - neighborDisclosure(): 数と理由ごとの内訳（想定の家 = 未建築の仮の建物の棟数と、含めているかも）
 *  - disclosureLines(): 注記の文（日影図の脚注・レポートの各ページ）
 *  - appendSvgFootnote(): 日影図の SVG の下に脚注を足す（viewBox を伸ばす。svgFootnote.ts）
 *  - neighborWhere(): 建物からの方向・距離（「約 12 m・南側」）
 *  - plateauShapeOf() / plateauShapeCounts(): PLATEAU の建物が屋根形状（LOD2 以上）か箱形（LOD1）か（棟数行「屋根形状あり N・箱形 M」）
 *  - plateauSourceTag() / plateauAttribution() / plateauDisclosureText(): 使ったデータセット（study.env.plateau.datasets）からの出典の文
 *  - sourcesLine(): 「周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）401 棟・国土地理院（推定）6 棟」
 *  - measuredHeightPreset(): 「最高高さに合わせる」（LOD1 の天端は点群の中央値で、実測の最高高さより低い）
 *
 * DOM を使わない（vitest で読み込める）。
 */
import type { PlateauDatasetInfo } from '../sun/plateau';
import { plateauDatasetLabel } from '../sun/plateau';
import { buildingCenter, buildingExclusionEN, buildingFootprintEN } from './building';
import { siteExcludedCount } from './environment';
import { analysisNeighbors, effectiveNeighbors, excludedNeighbors, study, viewOnlyNeighbors } from './state';
import { HIDE_REASONS, HIDE_REASON_LABEL, bearingName, worldToEN } from './types';
import type { EN, Neighbor, NeighborHideReason, NeighborSource } from './types';

/** 出典の短い名前 */
export const SOURCE_SHORT: Record<NeighborSource, string> = { plateau: 'PLATEAU', gsi: '国土地理院', osm: 'OpenStreetMap', manual: '手入力' };

// ---------------------------------------------------------------------------
// PLATEAU の形状・出典の文
// ---------------------------------------------------------------------------

/**
 * PLATEAU の建物の形: 'roof' = 屋根形状（LOD2 以上。mesh があれば屋根の三角形を持つ）、'box' = 箱形（LOD1。天端は点群の中央値）。
 * PLATEAU の建物でなければ null。lod は建物の _lod（無ければデータセットの LOD）で、mesh.roofTriangles が 0 の mesh（屋根面の無い形状）は箱形とみなす
 */
export function plateauShapeOf(n: Pick<Neighbor, 'plateau' | 'mesh'>): 'roof' | 'box' | null {
  const a = n.plateau;
  if (!a) return null;
  const lod = a.lod ?? a.datasetLod;
  if (!(lod >= 2)) return 'box';
  if (n.mesh && !(n.mesh.roofTriangles > 0)) return 'box';
  return 'roof';
}

/** PLATEAU の建物の内訳: plateau = PLATEAU の建物の数、roof = 屋根形状、box = 箱形（旧形式の保存データのように plateau 属性が無い PLATEAU の建物は other） */
export function plateauShapeCounts(list: Pick<Neighbor, 'source' | 'plateau' | 'mesh'>[]): { plateau: number; roof: number; box: number; other: number } {
  let roof = 0;
  let box = 0;
  let other = 0;
  for (const n of list) {
    if (n.source !== 'plateau') continue;
    const s = plateauShapeOf(n);
    if (s === 'roof') roof++;
    else if (s === 'box') box++;
    else other++;
  }
  return { plateau: roof + box + other, roof, box, other };
}

/** 「屋根形状あり N・箱形 M」（PLATEAU の建物が無ければ null。属性の無い旧データだけなら「実測 N」） */
export function plateauShapeText(c: ReturnType<typeof plateauShapeCounts>): string | null {
  if (!c.plateau) return null;
  if (!c.roof && !c.box) return `実測 ${c.other}`;
  return `屋根形状あり ${c.roof}・箱形 ${c.box}`;
}

/** 使った PLATEAU のデータセット（study.env.plateau.datasets。無ければ []） */
export function plateauDatasets(): PlateauDatasetInfo[] {
  return study.env.plateau?.datasets ?? [];
}

/** 区名（無ければ市名）。「世田谷区」「名古屋市守山区」は ward、「川越市」は city */
const wardName = (d: PlateauDatasetInfo) => d.ward ?? d.city;
const uniq = <T,>(a: T[]) => [...new Set(a)];

/**
 * 周辺建物の出典タグの短い文: 「PLATEAU 2025・世田谷区・実測」（区境で 2 データセットなら「PLATEAU 2022・東区／守山区・実測」）。
 * データセットが分からない（旧形式の保存データ）ときは「PLATEAU・実測の高さ」
 */
export function plateauSourceTag(datasets: PlateauDatasetInfo[] = plateauDatasets()): string {
  if (!datasets.length) return 'PLATEAU・実測の高さ';
  const years = uniq(datasets.map((d) => String(d.year))).join('／');
  const wards = uniq(datasets.map(wardName)).join('／');
  return `PLATEAU ${years}・${wards}・実測`;
}

/** 3D 画面の出典行: 「周辺建物: PLATEAU（国土交通省 3D都市モデル）東京都世田谷区・2025年度・LOD2」（データセットが分からなければ名前だけ） */
export function plateauAttribution(datasets: PlateauDatasetInfo[] = plateauDatasets()): string {
  const head = '周辺建物: PLATEAU（国土交通省 3D都市モデル）';
  return datasets.length ? `${head}${datasets.map((d) => d.label).join('／')}` : head;
}

/** 出典の一覧（レポートの ul・サイドの「周辺建物の出典」）に出す PLATEAU の行。データセットごとに 1 行、分からなければ types の NEIGHBOR_SOURCE_LABEL 相当の 1 行 */
export function plateauSourceLabels(datasets: PlateauDatasetInfo[] = plateauDatasets()): string[] {
  return datasets.length ? datasets.map(plateauDatasetLabel) : ['PLATEAU（国土交通省 3D都市モデル・実測の高さ・形状）'];
}

/**
 * 共通の開示文（レポートの前提・注意）: 「周辺建物の形状・高さ: 国土交通省 PLATEAU 3D都市モデル（世田谷区・2025年度・LOD2）。LOD1 の建物は箱形で
 * 天端は点群の中央値（最高高さは建物クリックで確認・適用できます）。年度以降の新築・解体は反映されていない場合があります。」
 * データセットが分からなければ括弧を省く。LOD1 の文は建物単位（list = 解析に入れた建物。箱形 = _lod ?? datasetLod ≤ 1 の建物が 1 棟でもあれば出す。
 * 東京 23 区の 2025 年版のようにデータセットは LOD2 でも住宅はほぼ全棟 _lod=1 の箱なので、データセットの LOD だけでは判定しない。
 * 属性の無い旧データは形が分からないので出す（安全側）。list に PLATEAU の建物が無ければデータセットで判定（LOD1 があるとき。分からなければ出す）
 */
export function plateauDisclosureText(datasets: PlateauDatasetInfo[] = plateauDatasets(), list: Pick<Neighbor, 'source' | 'plateau' | 'mesh'>[] = analysisNeighbors()): string {
  const where = datasets.length ? `（${datasets.map((d) => `${wardName(d)}・${d.year}年度・LOD${d.lod}`).join('／')}）` : '';
  const c = plateauShapeCounts(list);
  const lod1 = c.plateau > 0 ? c.box > 0 || c.other > 0 : !datasets.length || datasets.some((d) => d.lod <= 1);
  return `周辺建物の形状・高さ: 国土交通省 PLATEAU 3D都市モデル${where}。${lod1 ? 'LOD1 の建物は箱形で天端は点群の中央値（最高高さは建物クリックで確認・適用できます）。' : ''}年度以降の新築・解体は反映されていない場合があります。`;
}

/** 出典ごとの棟数（影・解析に入る建物。想定の家は手入力に含めない） */
export interface SourceCount {
  source: NeighborSource;
  count: number;
  /** その出典に高さが推定の建物があるか（「（推定）」を付ける） */
  estimated: boolean;
}

/** 出典ごとに数える（PLATEAU → 国土地理院 → OpenStreetMap → 手入力の順。0 棟の出典は省く） */
export function countBySource(list: Pick<Neighbor, 'source' | 'heightKind' | 'planned'>[]): SourceCount[] {
  const order: NeighborSource[] = ['plateau', 'gsi', 'osm', 'manual'];
  return order
    .map((source) => {
      const own = list.filter((n) => n.source === source && !n.planned);
      return { source, count: own.length, estimated: own.some((n) => n.heightKind === 'estimated') };
    })
    .filter((c) => c.count > 0);
}

/**
 * 「周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）401 棟・国土地理院（推定）6 棟」。
 * PLATEAU の括弧はデータセット（区・年度・LOD）、分からなければ「PLATEAU（国土交通省）」。出典が無ければ null
 */
export function sourcesLine(counts: SourceCount[], datasets: PlateauDatasetInfo[] = plateauDatasets()): string | null {
  if (!counts.length) return null;
  const name = (c: SourceCount) => {
    if (c.source === 'plateau') return datasets.length ? `PLATEAU（${datasets.map((d) => `${wardName(d)}・${d.year}年度・LOD${d.lod}`).join('／')}）` : 'PLATEAU（国土交通省）';
    const base = c.source === 'manual' ? '手入力' : SOURCE_SHORT[c.source];
    return c.estimated ? `${base}（推定）` : base;
  };
  // 括弧で終わる名前は詰める（「国土地理院（推定）6 棟」）、そうでなければ空白を入れる（「手入力 1 棟」）
  return `周辺建物の出典: ${counts.map((c) => `${name(c)}${name(c).endsWith('）') ? '' : ' '}${c.count} 棟`).join('・')}`;
}

/**
 * 高さのプリセット「最高高さに合わせる (7.6 m)」: PLATEAU の実測の最高高さ（bldg:measuredHeight）が今の高さと 0.5 m 以上違うときだけ。
 * LOD1 の形状の高さ（zmax − zmin）は点群の中央値で、最高高さより中央値 0.9〜1.0 m 低い（安全側ではない）ので、必要なら実測値に合わせられるようにする
 */
export function measuredHeightPreset(n: Pick<Neighbor, 'height' | 'plateau'>, minDiffM = 0.5): { label: string; value: number } | null {
  const m = n.plateau?.measuredHeight;
  if (typeof m !== 'number' || !Number.isFinite(m) || !(m > 0)) return null;
  const v = Math.round(m * 10) / 10;
  if (Math.abs(v - n.height) < minDiffM) return null;
  return { label: `最高高さに合わせる (${v.toFixed(1)} m)`, value: v };
}

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
  /**
   * 影・解析に入る建物の出典ごとの棟数（「周辺建物の出典: …」の行）。自動取得をした（study.neighborSources がある）ときだけ。
   * 古い呼び出し側が作った値には無い
   */
  sources?: SourceCount[];
  /** 使った PLATEAU のデータセット（出典行の区・年度・LOD）。分からなければ [] */
  plateauDatasets?: PlateauDatasetInfo[];
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
  const d: NeighborDisclosure = { excluded, viewOnly, byReason, autoOnSite, planned };
  // 出典の行は自動取得をしたときだけ（手動の隣家だけの検討では出典を問わない）
  if (study.neighborSources.length) {
    d.sources = countBySource(analysisNeighbors());
    d.plateauDatasets = plateauDatasets();
  }
  return d;
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
 *  5. 周辺建物の出典（自動取得をした時だけ）: 「周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）401 棟・国土地理院（推定）6 棟」
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
  const src = d.sources ? sourcesLine(d.sources, d.plateauDatasets ?? []) : null;
  if (src) lines.push(src);
  return lines;
}

export { appendSvgFootnote, wrapFootnote } from './svgFootnote';
