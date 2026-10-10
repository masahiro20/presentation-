/**
 * PLATEAU の建物（src/sun/plateau/fetch.ts の PlateauBuilding）を日照ツールの Neighbor にするアダプタ: 変換・注記・進捗文・
 * クリック情報の行・影の到達判定に使う高さ・年度更新で変わる id への上書きの引き継ぎ。
 *
 * PlateauBuilding の ring/holes/mesh は建物の anchor 基準なので、ring/holes は frameToLocal(pin, anchor) で平行移動してピン基準にする。
 * mesh は anchor 基準のまま持ち回り、配置時（neighbors.ts の buildNeighborMeshes）に同じ量を足す（ピン移動で頂点を書き換えない）。
 * 仕様: scratchpad/plateau-spec.md §2.11・§8（W8 が実装）
 */
import type { PlateauFetchResult } from '../sun/plateau/fetch';
import type { EN, PlateauBuilding, PlateauProgress } from '../sun/plateau/types';
import type { LatLon, Neighbor, NeighborOverride } from './types';

/**
 * id `plateau:${gmlId}`、source 'plateau'、heightKind 'measured'、height = round1(zmax − zmin)、
 * ring/holes を frameToLocal(pin, anchor) で平行移動、label = usage ?? name
 */
export function plateauToNeighbor(b: PlateauBuilding, pin: LatLon): Neighbor {
  void b;
  void pin;
  throw new Error('未実装: plateauToNeighbor');
}

/** 利用者向けの注記（§4 のフォールバック表・§8 の固定文）。fill = 国土地理院で補った棟数 */
export function plateauNotes(r: Extract<PlateauFetchResult, { status: 'covered' }>, fill: number): string[] {
  void r;
  void fill;
  throw new Error('未実装: plateauNotes');
}

/** '周辺建物（PLATEAU・東京都世田谷区 LOD2）: 建物タイル 3/6（8.1 MB）' */
export function plateauProgressText(p: PlateauProgress): string {
  void p;
  throw new Error('未実装: plateauProgressText');
}

/** クリック情報の行（§8: 出典・年度・LOD・実測の最高高さ／モデルの高さ・所在・PLATEAU 地盤 T.P.／地形 T.P.・建物 ID） */
export function plateauInfoLines(n: Neighbor): string[] {
  void n;
  throw new Error('未実装: plateauInfoLines');
}

/** 影の到達判定に使う高さ: max(height, plateau?.measuredHeight ?? 0) */
export function reachHeight(n: Neighbor): number {
  void n;
  throw new Error('未実装: reachHeight');
}

/**
 * 新一覧に無い id の上書き（高さ修正・隠す）を、sameFootprint（面積比 0.6〜1/0.6・重心が互いの内側）の新 id へ移す
 * （gml_id は年度更新で変わり得る。旧 MVT 由来の id も同じ経路で移行）
 */
export function rekeyOverridesByFootprint(prev: Pick<Neighbor, 'id' | 'ring'>[], next: Pick<Neighbor, 'id' | 'ring'>[], overrides: Record<string, NeighborOverride>): Record<string, NeighborOverride> {
  void prev;
  void next;
  void overrides;
  throw new Error('未実装: rekeyOverridesByFootprint');
}

/** anchor 基準 → ピン基準の平行移動量 = frameToLocal(pin, n.plateau.anchor) */
export function plateauOffset(n: Neighbor, pin: LatLon): EN {
  void n;
  void pin;
  throw new Error('未実装: plateauOffset');
}
