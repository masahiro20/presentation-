/**
 * PLATEAU の建物（src/sun/plateau の PlateauBuilding）を日照ツールの Neighbor にするアダプタ: 変換・注記・進捗文・
 * クリック情報の行・影の到達判定に使う高さ・年度更新で変わる id への上書きの引き継ぎ。
 *
 * PlateauBuilding の ring/holes/mesh は建物の anchor 基準なので、ring/holes は frameToLocal(pin, anchor) で平行移動してピン基準にする。
 * mesh は anchor 基準のまま持ち回り、配置時（neighbors.ts の buildNeighborMeshes）に同じ量（plateauOffset）を足す（ピン移動で頂点を書き換えない）。
 * PlateauBuilding は fetch.ts の分割キャッシュと共有のオブジェクトなので ring/mesh/attrs は書き換えず、平行移動は新しい配列に作る。
 * 仕様: scratchpad/plateau-spec.md §2.11・§4（フォールバック表）・§8（固定文）（W8 が実装）
 */
import { ROOF_KIND_LABEL } from '../sun/plateau';
import { plateauRegionAddedNote } from '../sun/context';
import { bboxOf, pointInRing, ringArea, ringCenter, type BBoxEN } from '../sun/footprint';
import type { EN, PlateauAttrs, PlateauBuilding, PlateauFetchResult, PlateauProgress } from '../sun/plateau';
import { frameToLocal } from './types';
import type { LatLon, Neighbor, NeighborOverride } from './types';

type PlateauCovered = Extract<PlateauFetchResult, { status: 'covered' }>;
type PlateauWarning = NonNullable<PlateauAttrs['warnings']>[number];

/** 小数 1 桁に丸める（Neighbor.height の約束。PlateauBuilding.height は丸めていない） */
const round1 = (v: number) => Math.round(v * 10) / 10;

/** 足元の照合（rekeyOverridesByFootprint）: 面積比がこの値〜その逆数の範囲で、重心が互いの内側なら同じ建物とみなす */
export const FOOTPRINT_AREA_RATIO_MIN = 0.6;

/** 属性の warnings の利用者向けの文（クリック情報） */
const WARNING_TEXT: Record<PlateauWarning, string> = {
  noBottom: '底面が無いため足元の輪郭は形状の外接凸包',
  islands: '離れた棟をまとめた凸包の足元',
  baseMismatch: '高さの基準がタイル内の他の建物と合わない（簡略形状の可能性）',
};

/**
 * id `plateau:${gmlId}`、source 'plateau'、heightKind 'measured'、height = round1(zmax − zmin)、
 * ring/holes を frameToLocal(pin, anchor) で平行移動、label = usage ?? name。mesh は anchor 基準のまま（共有参照）
 */
export function plateauToNeighbor(b: PlateauBuilding, pin: LatLon): Neighbor {
  const off = frameToLocal(pin, b.attrs.anchor);
  const shift = (ring: EN[]) => ring.map((p) => ({ e: p.e + off.e, n: p.n + off.n }));
  const nb: Neighbor = {
    id: `plateau:${b.gmlId}`,
    ring: shift(b.ring),
    height: Math.max(0.1, round1(b.height)),
    source: 'plateau',
    heightKind: 'measured',
    mesh: b.mesh,
    plateau: { ...b.attrs, anchor: { ...b.attrs.anchor } },
  };
  if (b.holes.length) nb.holes = b.holes.map(shift);
  const label = b.attrs.usage || b.attrs.name;
  if (label) nb.label = label;
  return nb;
}

/** 注記の棟数を数える一覧の要素（Neighbor の必要な欄だけ） */
export type PlateauNotesNeighbor = Pick<Neighbor, 'source' | 'plateau' | 'mesh'>;

/**
 * 注記の棟数（距離ルールの後に一覧へ残った建物で数える）: plateau = PLATEAU の棟数、roof = 屋根形状（LOD2 以上）、box = 箱形、gsi = 国土地理院で補った棟数。
 * 屋根形状の判定は disclosure.ts の plateauShapeOf と同じ規則（lod ?? datasetLod が 2 以上で、mesh があれば roofTriangles > 0）。
 * disclosure.ts は state を読み込むのでここからは参照しない（同じ規則をここに書く）
 */
export function plateauNoteCounts(kept: PlateauNotesNeighbor[]): { plateau: number; roof: number; box: number; gsi: number; est: number } {
  let plateau = 0;
  let est = 0;
  let roof = 0;
  let gsi = 0;
  for (const n of kept) {
    if (n.source === 'gsi') gsi++;
    if (n.source !== 'plateau') continue;
    plateau++;
    const a = n.plateau;
    if (!a) continue;
    const lod = a.lod ?? a.datasetLod;
    if (lod >= 2 && (!n.mesh || n.mesh.roofTriangles > 0)) roof++;
    else if (a.roofEstimate && !a.roofEstimate.user) est++;
  }
  return { plateau, roof, box: plateau - roof, gsi, est };
}

/**
 * 利用者向けの注記（§4 のフォールバック表・§8 の固定文）。kept = 距離ルール（applyDistanceRule）の後に一覧へ残った建物。
 * 棟数・屋根形状あり／箱形・国土地理院で補った棟数はすべて kept で数える（取得した全棟数 r.buildings ではない）。
 * これは取得時（距離ルール後・敷地内の自動除外前）の数で、注記は env.neighborNotes に保存される固定文。計画建物を後から置いて
 * 重なる建物が自動除外されると出典行（disclosure.ts: 自動除外後）の数より多くなり得るので、「N 棟を取得」と取得時の数であることを明示する。
 * 先頭は出典の行: 「PLATEAU（国土交通省 3D都市モデル・東京都世田谷区・2025年度・LOD2）の実測の高さ・形状を使用（N 棟を取得。屋根形状あり M 棟・箱形 K 棟）。」
 * （LOD1 だけのデータセットでは「（N 棟を取得。箱形。天端は点群の中央値）」）。区境で 2 データセットなら名前を「／」でつなぐ
 */
export function plateauNotes(r: PlateauCovered, kept: PlateauNotesNeighbor[]): string[] {
  const notes: string[] = [];
  const { plateau: total, roof, box, gsi: fill, est } = plateauNoteCounts(kept);
  const labels = r.datasets.map((d) => d.label).join('／');
  const head = `PLATEAU（国土交通省 3D都市モデル・${labels}）の実測の高さ・形状を使用`;
  const lod1Only = r.datasets.length > 0 && r.datasets.every((d) => d.lod <= 1);
  notes.push(lod1Only ? `${head}（${total} 棟を取得。箱形。天端は点群の中央値）。` : `${head}（${total} 棟を取得。屋根形状あり ${roof} 棟・箱形 ${box} 棟${est ? `（うち推定の屋根 ${est} 棟）` : ''}）。`);
  if (est > 0) notes.push(`推定の屋根: 箱形の低層住宅 ${est} 棟に、実測の最高高さを棟とする寄棟の屋根を推定してかぶせています（軒の高さは点群の中央値から逆算。実際の屋根の形ではありません）。建物クリックで確認、「推定の屋根」のチェックを外すと実データの箱形に戻せます。`);
  if (fill > 0) notes.push(`国土地理院の地図から ${fill} 棟を補いました（高さは建物の種類から推定）。`);
  if (r.failedTiles > 0) {
    const tiles = r.tiles.length + r.failedTiles;
    notes.push(`PLATEAU の建物タイル ${tiles} 枚のうち ${r.failedTiles} 枚を取得できなかったため、建物が欠けている可能性があります。`);
  }
  if (r.truncated) notes.push('遠方の建物の一部は取得していません（データ量の上限）。');
  if (r.missingMuniCds.length) {
    // 索引に無い市区は名前が分からない（索引に項目が無い）ので市区町村コードで示す
    notes.push(`隣接する市区（市区町村コード ${r.missingMuniCds.join('・')}）は PLATEAU が未整備のため、その範囲は国土地理院の推定で補いました。`);
  }
  // 市区町村コードの改編の救済（索引の region で市区を足した）。文はプレゼン側（context.ts）と共通
  if (r.regionAdded?.length) notes.push(plateauRegionAddedNote(r.datasets, r.regionAdded));
  return notes;
}

/**
 * 進捗の文: '周辺建物（PLATEAU・東京都世田谷区・2025年度・LOD2）: 建物タイル 3/6（8.1 MB）'。
 * PlateauProgress にデータセット名は無いので、呼び出し側（fetchNeighbors）が tileset の段の文から拾って dataset に渡す（無ければ省く）。
 * 統合の段の文（「周辺建物を統合しています…」「周辺建物 N 棟」）はそのまま
 */
export function plateauProgressText(p: PlateauProgress, dataset?: string): string {
  if (p.message.startsWith('周辺建物')) return p.message;
  return `周辺建物（PLATEAU${dataset ? `・${dataset}` : ''}）: ${p.message}`;
}

/**
 * クリック情報の行（§8）: 出典（年度・LOD・箱形か屋根形状か）、実測の最高高さ・階数・用途／モデルの高さ、所在、
 * PLATEAU 地盤 T.P.／地形 T.P.（baseElev があれば）、建物 ID（gml_id）。PLATEAU の建物でなければ []
 */
export function plateauInfoLines(n: Neighbor): string[] {
  const a = n.plateau;
  if (!a) return [];
  const lod = a.lod ?? a.datasetLod;
  const lines: string[] = [`出典: PLATEAU ${a.pref}${a.city}${a.ward ?? ''}・${a.year}年度・LOD${lod}（${lod >= 2 ? '屋根形状' : '箱形'}）`];
  const model = `モデルの高さ ${round1(a.zmax - a.zmin).toFixed(1)} m`;
  const parts: string[] = [];
  if (a.measuredHeight != null && Number.isFinite(a.measuredHeight)) parts.push(`実測の最高高さ ${a.measuredHeight.toFixed(1)} m`);
  if (a.storeys != null && Number.isFinite(a.storeys)) parts.push(`${a.storeys} 階${a.storeysBelow ? `（地下 ${a.storeysBelow} 階）` : ''}`);
  if (a.usage) parts.push(a.usage);
  lines.push(parts.length ? `${parts.join('・')}／${model}` : model);
  if (a.roofEstimate) {
    const r = a.roofEstimate;
    const kind = ROOF_KIND_LABEL[r.kind];
    const dims = r.kind === 'flat' ? `屋上 ${r.eave.toFixed(1)} m・パラペット ${(r.parapet ?? r.ridge - r.eave).toFixed(1)} m` : `軒 ${r.eave.toFixed(1)} m・棟 ${r.ridge.toFixed(1)} m`;
    const fl = r.storeys && r.floorH ? `・${r.storeys} 階 × 階高 ${r.floorH.toFixed(2)} m` : '';
    lines.push(r.user ? `屋根（手入力・${kind}）: ${dims}${fl}` : `推定の屋根（${kind}）: ${dims}${fl}（元の箱の高さ ${r.boxHeight.toFixed(1)} m）。実際の屋根の形ではありません`);
  }
  if (a.name && a.name !== a.usage) lines.push(`名称: ${a.name}`);
  if (a.address) lines.push(`所在: ${a.address}`);
  lines.push(n.baseElev != null && Number.isFinite(n.baseElev) ? `PLATEAU 地盤 T.P. ${a.zmin.toFixed(1)} m／地形 T.P. ${n.baseElev.toFixed(1)} m` : `PLATEAU 地盤 T.P. ${a.zmin.toFixed(1)} m`);
  lines.push(a.buildingId ? `建物 ID ${a.buildingId}（gml_id ${a.gmlId}）` : `gml_id ${a.gmlId}`);
  if (a.warnings?.length) lines.push(`注意: ${a.warnings.map((w) => WARNING_TEXT[w] ?? w).join('・')}`);
  return lines;
}

/** 影の到達判定に使う高さ: max(height, plateau?.measuredHeight ?? 0)（LOD1 の形状の高さは点群の中央値で最高高さより低い） */
export function reachHeight(n: Neighbor): number {
  const m = n.plateau?.measuredHeight;
  return Math.max(n.height, typeof m === 'number' && Number.isFinite(m) ? m : 0);
}

const bboxTouch = (a: BBoxEN, b: BBoxEN) => !(a.maxE < b.minE || b.maxE < a.minE || a.maxN < b.minN || b.maxN < a.minN);

/** 同じ足元か: 面積比が 0.6〜1/0.6 で、重心が互いの内側（同じピン基準の ring どうし） */
function sameFootprint(a: EN[], b: EN[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  const aa = Math.abs(ringArea(a));
  const ab = Math.abs(ringArea(b));
  if (!(aa > 0 && ab > 0)) return false;
  const ratio = aa / ab;
  if (ratio < FOOTPRINT_AREA_RATIO_MIN || ratio > 1 / FOOTPRINT_AREA_RATIO_MIN) return false;
  return pointInRing(ringCenter(a), b) && pointInRing(ringCenter(b), a);
}

/**
 * 新一覧（next）に無い id の上書き（高さ修正・隠す）を、旧一覧（prev）の同じ id の足元と sameFootprint（面積比 0.6〜1/0.6・重心が互いの内側）の
 * 新しい建物の id へ移す（gml_id は年度更新で変わり得る。旧形式の id（plateau:緯度:経度:面積）も同じ経路で移行）。
 * 新一覧にある id の上書きと、prev に無い id（手動の隣家・想定の家など）の上書きはそのまま。移す先が既に上書きを持つ・別の旧 id の移し先になった建物には移さない。
 * 移せなかった上書きは残す（建物が戻ってきたときのため）。元の overrides は変えず、新しいオブジェクトを返す
 */
export function rekeyOverridesByFootprint(prev: Pick<Neighbor, 'id' | 'ring'>[], next: Pick<Neighbor, 'id' | 'ring'>[], overrides: Record<string, NeighborOverride>): Record<string, NeighborOverride> {
  const out: Record<string, NeighborOverride> = { ...overrides };
  const nextIds = new Set(next.map((n) => n.id));
  const orphans = Object.keys(overrides).filter((id) => !nextIds.has(id));
  if (!orphans.length) return out;
  const prevById = new Map(prev.map((n) => [n.id, n]));
  const candidates = next.filter((n) => !(n.id in overrides) && n.ring.length >= 3).map((n) => ({ n, bbox: bboxOf(n.ring) }));
  const taken = new Set<string>();
  for (const id of orphans) {
    const p = prevById.get(id);
    if (!p || p.ring.length < 3) continue;
    const pb = bboxOf(p.ring);
    const hit = candidates.find((c) => !taken.has(c.n.id) && bboxTouch(pb, c.bbox) && sameFootprint(p.ring, c.n.ring));
    if (!hit) continue;
    taken.add(hit.n.id);
    out[hit.n.id] = { ...overrides[id] };
    delete out[id];
  }
  return out;
}

/** anchor 基準 → ピン基準の平行移動量 = frameToLocal(pin, n.plateau.anchor)（PLATEAU の建物でなければ (0, 0)） */
export function plateauOffset(n: Neighbor, pin: LatLon): EN {
  return n.plateau ? frameToLocal(pin, n.plateau.anchor) : { e: 0, n: 0 };
}
