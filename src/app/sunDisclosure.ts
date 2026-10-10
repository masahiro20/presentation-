/**
 * 日照の結果に添える「周辺建物の扱い」の開示（DOM を使わない純粋な部分）。
 *
 * 建物を恣意的に外したと言われないように、計算から除外した周辺建物は理由ごとの棟数
 * （プレゼン資料では 出典・高さ・理由・方向距離 の表）を、表示だけ隠した建物は棟数を、
 * 部屋の日当たり・日照時間マップ・日影図（SVG）・プレゼン資料の日照のページに必ず印字する。
 * 想定の家（未建築の仮の建物）を置いたときは「想定で置いた建物 N 棟（未建築・仮の形状。…）」の行も同じ所に印字する。
 * 数字は解析した時点の扱い（collectDisclosure の写し）で書く（state.sun.disclosure）。
 */
import { HIDE_MODE_SHORT, HIDE_REASONS, HIDE_REASON_LABEL, hideReasonText, ringCentroid, type HideMode, type HideReason, type HideRecord } from '../sun/context';
import type { NeighborBuilding } from '../sun/geo';

export const NEIGHBOR_SOURCE_LABEL: Record<NeighborBuilding['source'], string> = { gsi: '国土地理院', osm: 'OpenStreetMap', manual: '手動で追加' };
const DIR8 = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];

/** 建物の名前（OSM の名前・手動の隣家・出典） */
export function neighborTitle(b: Pick<NeighborBuilding, 'label' | 'source'>): string {
  return b.label ?? (b.source === 'manual' ? '隣家' : `${NEIGHBOR_SOURCE_LABEL[b.source]}の建物`);
}

/** 計画建物（外形の原点 = 建物の中心）から見た方角と距離 */
export function neighborWhere(b: Pick<NeighborBuilding, 'ring'>): string {
  const c = ringCentroid(b.ring);
  const az = ((Math.atan2(c.e, c.n) * 180) / Math.PI + 360) % 360;
  return `${DIR8[Math.round(az / 45) % 8]} 約 ${Math.round(Math.hypot(c.e, c.n))} m`;
}

/** 隠した建物 1 棟の記録（資料に書く分） */
export interface HiddenEntry {
  key: string;
  /** 建物の名前（OSM の名前・隣家・「国土地理院の建物」） */
  title: string;
  source: NeighborBuilding['source'];
  /** 影・解析に使う高さ (m)。直した高さがあればそれ */
  height: number;
  /** 高さを手で直したか */
  heightEdited: boolean;
  mode: HideMode;
  reason: HideReason;
  note?: string;
  /** 計画建物から見た方角と距離（例 '南 約 12 m'） */
  where: string;
  /** 想定の家（未建築の仮の建物） */
  planned?: boolean;
}

/** 解析した時点の周辺建物の扱い */
export interface SunDisclosure {
  /** 影・解析に入れた周辺建物の数（表示だけ隠した建物を含む。計算から除外した建物は含まない） */
  included: number;
  /** 計算から除外した建物（描かない・影を落とさない・解析に入れない） */
  excluded: HiddenEntry[];
  /** 表示だけ隠した建物（描かないが、影・解析には含む） */
  viewOnly: HiddenEntry[];
  /**
   * 想定の家（未建築・仮の形状）: count = 計算から除外していない想定の家の棟数（表示だけ隠したものも数える）、enabled = 影・解析に含めたか。
   * 想定の家が無ければ省く（古い写しにも無い）。含めたときは included にも入っている
   */
  planned?: { count: number; enabled: boolean };
}

/** 周辺建物が無い（日照ステップで読み込んでいない）ときの扱い */
export const NO_NEIGHBORS_DISCLOSURE: Readonly<SunDisclosure> = { included: 0, excluded: [], viewOnly: [] };

/** collectDisclosure に渡すもの（SunContext。テストでは偽物を渡せるよう、使う所だけの型） */
export interface DisclosureSource {
  state: { neighbors: NeighborBuilding[] };
  keyOf(b: NeighborBuilding): string;
  heightOf(b: NeighborBuilding): number;
  hideRecord(key: string): HideRecord | null;
  edits: { heights: Map<string, number> };
  /** 想定の家を影・解析に含めるか（SunContext.plannedEnabled。無ければ含める） */
  plannedEnabled?: boolean;
}

/** 今の周辺建物の扱いを写す（null = 周辺建物を読み込んでいない） */
export function collectDisclosure(sc: DisclosureSource | null | undefined): SunDisclosure {
  if (!sc) return { included: 0, excluded: [], viewOnly: [] };
  const out: SunDisclosure = { included: 0, excluded: [], viewOnly: [] };
  const plannedOn = sc.plannedEnabled !== false;
  let planned = 0;
  for (const b of sc.state.neighbors) {
    const key = sc.keyOf(b);
    const rec = b.hidden ? sc.hideRecord(key) : null;
    if (b.planned) {
      if (!rec || rec.mode === 'view') planned++;
      // 含めていない想定の家は数えない（除外・表示だけ隠した建物の一覧にも出さない。想定の家の行で断る）
      if (!plannedOn) continue;
    }
    if (!rec || rec.mode === 'view') out.included++;
    if (!rec) continue;
    const e: HiddenEntry = {
      key,
      title: neighborTitle(b),
      source: b.source,
      height: sc.heightOf(b),
      heightEdited: sc.edits.heights.has(key),
      mode: rec.mode,
      reason: rec.reason,
      where: neighborWhere(b),
    };
    if (rec.note) e.note = rec.note;
    if (b.planned) e.planned = true;
    (rec.mode === 'view' ? out.viewOnly : out.excluded).push(e);
  }
  if (planned) out.planned = { count: planned, enabled: plannedOn };
  return out;
}

/** 想定の家の行（あるときだけ）: 「想定で置いた建物 N 棟（未建築・仮の形状。影・解析に含む）」／含めていなければ「…今は含めていません」 */
export function plannedLine(d: Pick<SunDisclosure, 'planned'>): string | null {
  const p = d.planned;
  if (!p || !p.count) return null;
  return `想定で置いた建物 ${p.count} 棟（未建築・仮の形状。${p.enabled ? '影・解析に含む' : '今は含めていません'}）`;
}

/** 理由ごとの棟数（理由の並びは HIDE_REASONS の順。例 '解体予定 2・その他 1'） */
export function reasonCountsText(entries: Pick<HiddenEntry, 'reason'>[]): string {
  const n = new Map<HideReason, number>();
  for (const e of entries) n.set(e.reason, (n.get(e.reason) ?? 0) + 1);
  return HIDE_REASONS.filter((r) => n.has(r))
    .map((r) => `${HIDE_REASON_LABEL[r]} ${n.get(r)}`)
    .join('・');
}

/** 計算から除外した建物の行（いつも出す。無ければ「なし」） */
export function excludedLine(d: Pick<SunDisclosure, 'excluded'>): string {
  return d.excluded.length ? `計算から除外した周辺建物 ${d.excluded.length} 棟（${reasonCountsText(d.excluded)}）` : '計算から除外した周辺建物 なし';
}

/** 表示だけ隠した建物の行（あるときだけ） */
export function viewOnlyLine(d: Pick<SunDisclosure, 'viewOnly'>): string | null {
  return d.viewOnly.length ? `表示だけ隠した建物 ${d.viewOnly.length} 棟（影・解析には含む）` : null;
}

/** 日影図の注記の 1 行目（この版の日影図は計画建物だけの影） */
export const DIAGRAM_NEIGHBORS_NOTE = '※周辺建物は日影図に含めていません（計画建物の影のみ）。部屋の日当たり・日照時間マップでの周辺建物の扱い:';

export type DisclosureTarget = 'rooms' | 'heatmap' | 'diagram' | 'deck';

/**
 * 結果に添える注記の行。
 *  - rooms / heatmap / deck: 周辺建物 N 棟の影を含めたか（読み込んでいなければその旨）＋ 除外・表示だけ隠した建物
 *  - diagram: 周辺建物は日影図に含めていない旨 ＋ 除外・表示だけ隠した建物（部屋の日当たり・日照時間マップでの扱い）
 */
export function disclosureLines(d: SunDisclosure, target: DisclosureTarget): string[] {
  const hidden = d.excluded.length + d.viewOnly.length;
  const pl = plannedLine(d);
  const rest = [excludedLine(d), viewOnlyLine(d), pl].filter((x): x is string => !!x);
  if (target === 'diagram') return [DIAGRAM_NEIGHBORS_NOTE, ...rest];
  const what = target === 'rooms' ? '部屋の日当たり' : target === 'heatmap' ? '日照時間マップ' : '日当たりの解析';
  if (!d.included && !hidden) return [`※${what}は周辺建物を読み込まずに計算しています（計画建物の影のみ）`, ...(pl ? [pl] : [])];
  return [`※${what}は周辺建物 ${d.included} 棟の影を含めて計算しています`, ...rest];
}

/** 資料の表の 1 行（No.・出典・高さ・理由・方向・距離） */
export interface ExcludedRow {
  no: number;
  source: string;
  height: string;
  reason: string;
  where: string;
}

/** 計算から除外した建物の表（資料用） */
export function excludedTableRows(d: Pick<SunDisclosure, 'excluded'>): ExcludedRow[] {
  return d.excluded.map((e, i) => ({
    no: i + 1,
    // 名前のある建物（OSM の名前・隣家）は出典に添える。想定の家は「想定の家（未建築）」と名前
    source: e.planned
      ? `想定の家（未建築${e.title && e.title !== '想定の家' ? `・${e.title}` : ''}）`
      : e.title === `${NEIGHBOR_SOURCE_LABEL[e.source]}の建物`
        ? NEIGHBOR_SOURCE_LABEL[e.source]
        : `${NEIGHBOR_SOURCE_LABEL[e.source]}（${e.title}）`,
    height: `${e.height.toFixed(1)} m${e.planned ? '（想定）' : e.heightEdited ? '（手入力）' : e.source === 'gsi' ? '（推定）' : ''}`,
    reason: hideReasonText(e),
    where: e.where,
  }));
}

/** 隠し方の短い名前（一覧の見出しなど） */
export function hideModeShort(mode: HideMode): string {
  return HIDE_MODE_SHORT[mode];
}

const escXml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * SVG（日影図）の下に注記の行を足す: viewBox の高さを伸ばし、白地の上に左寄せで書く。
 * 文字の大きさは凡例の文字（fill="#555" の最後の text）に合わせる（無ければ図の幅の 1/90）。
 * data-disclosure の g にまとめる（2 回足さないように、既にあれば作り直す）
 */
export function appendSvgFootnote(svg: string, lines: string[]): string {
  if (!lines.length) return svg;
  // 先に足した注記があれば外して、その分を除いた高さから測る
  const prev = /<g data-disclosure="1" data-disclosure-h="([\d.]+)">[\s\S]*?<\/g>/.exec(svg);
  const src = prev ? svg.replace(prev[0], '') : svg;
  const open = /<svg\b[^>]*>/.exec(src);
  if (!open) return svg;
  const vbm = /viewBox="([^"]+)"/.exec(open[0]);
  const nums = vbm ? vbm[1].trim().split(/[\s,]+/).map(Number) : [];
  if (nums.length !== 4 || nums.some((x) => !Number.isFinite(x))) return svg;
  const [x, y, w, hgt] = nums;
  const h0 = prev ? hgt - Number(prev[1]) : hgt;
  const legendFs = [...src.matchAll(/<text\b[^>]*font-size="([\d.]+)"[^>]*fill="#555"/g)].map((m) => Number(m[1])).filter((v) => v > 0);
  const fs = legendFs.length ? legendFs[legendFs.length - 1] : w / 90;
  const lh = fs * 1.6;
  const add = lh * lines.length + fs * 0.9;
  const r = (v: number) => (Math.round(v * 100) / 100).toString();
  const bottom = y + h0;
  const texts = lines.map((t, i) => `<text x="${r(x + fs * 0.8)}" y="${r(bottom + lh * (i + 0.85))}" font-size="${r(fs)}" fill="#333"${i === 0 ? ' font-weight="bold"' : ''}>${escXml(t)}</text>`).join('');
  const g = `<g data-disclosure="1" data-disclosure-h="${r(add)}"><rect x="${r(x)}" y="${r(bottom)}" width="${r(w)}" height="${r(add)}" fill="#fff"/>${texts}</g>`;
  const head = open[0].replace(/viewBox="[^"]+"/, `viewBox="${r(x)} ${r(y)} ${r(w)} ${r(h0 + add)}"`);
  const body = src.slice(open.index + open[0].length).replace(/<\/svg>\s*$/, '');
  return `${src.slice(0, open.index)}${head}${body}${g}</svg>`;
}
