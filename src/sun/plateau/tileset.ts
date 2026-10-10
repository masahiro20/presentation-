/**
 * tileset.json の解釈と葉の選択（純関数。fetch・DOM・three は使わない）。
 *
 * 規則: REPLACE では葉（children が空）だけ、ADD では交差する全 content。
 * 葉 L を読む条件 = region が box と交差 かつ (distanceM(L) < nearM または distanceM(L) − heightSpanM(L) × reachFactor < reachMargin)。
 * 近い順に並べ、maxTiles を超えた分は遠い方から捨てて truncated = true。
 * box/sphere・transform・implicitTiling・content が .json の枝は warnings に記録して捨てる（実測: PLATEAU は region・REPLACE・transform 無し）。
 *
 * 実測の根拠（spec §0）:
 *  - PLATEAU の bldg tileset は全ノードに content があり refine REPLACE、深さ 3〜5。内部ノードの content は簡略形状で底面が無い
 *    （全深さ）ので足元・接地に使えない。親にしか無い建物は無い（世田谷 15/15・名古屋 18/18 が葉に存在）→ 葉だけ読む。
 *  - 高さスパン規則（dist < 150 || dist − span × 6.9 < 60）で奥沢 ±300 m の葉 12 枚 → 6 枚（≈18 MB）。6.9 は冬至の影の伸び
 *    （src/sunstudy/neighbors.ts の SHADOW_REACH_FACTOR と同じ考え）。
 *  - 3D Tiles の仕様では子の boundingVolume は親に含まれるはずだが、PLATEAU の tileset は守っていない
 *    （東区 28/55・守山 92/169・世田谷 611/952 ノードが親の region を数百 m はみ出す。例: 東区 data12 は親 data11 の西 300 m 外）。
 *    親の region で枝を刈ると交差する葉を落とすので、木は全部歩いて content ごとに自分の region で判定する（1,000 ノードでも µs）。
 * 仕様: scratchpad/plateau-spec.md §2.4（W3 が実装）
 */
import { degBoxDistanceM, degBoxIntersects, regionToDegBox } from '../geodesy';
import type { GeoBox, TileRegion } from './types';

export interface TileNode {
  /** ラジアン・m（tileset.json の boundingVolume.region そのまま） */
  region: TileRegion;
  geometricError: number;
  /** 親から継承。root に無ければ REPLACE */
  refine: 'REPLACE' | 'ADD';
  /** tilesetUrl 基準で絶対化した content の URL（content が無ければ null） */
  contentUri: string | null;
  children: TileNode[];
  /** root = 0 */
  depth: number;
}

export interface ContentTile {
  url: string;
  region: TileRegion;
  depth: number;
  /** 中心点 → region 矩形の最短距離 [m]（内側なら 0） */
  distanceM: number;
  /** region の maxH − minH [m]（そのタイルで最も高い建物の目安） */
  heightSpanM: number;
  /** children が空（REPLACE で読む対象） */
  leaf: boolean;
}

export interface ParsedTileset {
  root: TileNode;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// parseTileset
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 4×4 の単位行列（列優先）か。単位行列の transform は無いのと同じなので捨てない */
function isIdentityTransform(t: unknown): boolean {
  if (!Array.isArray(t) || t.length !== 16) return false;
  for (let i = 0; i < 16; i++) {
    const want = i % 5 === 0 ? 1 : 0;
    if (!isFiniteNum(t[i]) || Math.abs(t[i] - want) > 1e-12) return false;
  }
  return true;
}

/** boundingVolume.region（[west, south, east, north, minH, maxH]）→ TileRegion。region 以外・壊れた値は null */
function readRegion(bv: unknown): TileRegion | null {
  if (!isObj(bv)) return null;
  const r = bv.region;
  if (!Array.isArray(r) || r.length < 6 || !r.slice(0, 6).every(isFiniteNum)) return null;
  const [west, south, east, north, minH, maxH] = r as number[];
  if (west > east || south > north) return null;
  return { west, south, east, north, minH: Math.min(minH, maxH), maxH: Math.max(minH, maxH) };
}

/** content の uri（3D Tiles 1.0）／url（0.0 の名残）を tilesetUrl 基準で絶対化する。tilesetUrl が絶対 URL でなければ文字列で結合 */
function resolveContentUri(uri: string, tilesetUrl: string): string {
  try {
    return new URL(uri, tilesetUrl).href;
  } catch {
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('/')) return uri;
    const dir = tilesetUrl.replace(/[^/]*$/, '');
    return dir + uri.replace(/^\.\//, '');
  }
}

function describeBoundingVolume(bv: unknown): string {
  if (!isObj(bv)) return 'boundingVolume 無し';
  if (Array.isArray(bv.region)) return 'region が不正';
  const kind = Object.keys(bv).find((k) => k === 'box' || k === 'sphere');
  return kind ?? `未知の boundingVolume（${Object.keys(bv).join(',') || '空'}）`;
}

/**
 * tileset.json を TileNode の木にする。捨てた枝（box/sphere・非単位 transform・implicitTiling・content が .json）は warnings に残す。
 * root 自体が使えない（region が無い・transform あり など）ときは、読む対象が無いので Error（日本語）を投げる。
 */
export function parseTileset(json: unknown, tilesetUrl: string): ParsedTileset {
  if (!isObj(json) || !isObj(json.root)) throw new Error('tileset.json ではありません: root がありません');
  const warnings: string[] = [];

  /** path は warnings 用の位置（root / root.children[2].children[0] …）。使えない枝は null */
  const walk = (t: unknown, parentRefine: 'REPLACE' | 'ADD' | null, depth: number, path: string): TileNode | null => {
    if (!isObj(t)) {
      warnings.push(`${path}: タイルがオブジェクトではありません`);
      return null;
    }
    const region = readRegion(t.boundingVolume);
    if (!region) {
      warnings.push(`${path}: boundingVolume が region ではないので捨てました（${describeBoundingVolume(t.boundingVolume)}）`);
      return null;
    }
    if (t.transform !== undefined && !isIdentityTransform(t.transform)) {
      warnings.push(`${path}: transform 付きのタイルは未対応なので捨てました`);
      return null;
    }
    if (t.implicitTiling !== undefined) {
      warnings.push(`${path}: implicitTiling は未対応なので捨てました`);
      return null;
    }

    let refine: 'REPLACE' | 'ADD';
    const rf = typeof t.refine === 'string' ? t.refine.toUpperCase() : null;
    if (rf === 'REPLACE' || rf === 'ADD') refine = rf;
    else if (rf !== null) {
      warnings.push(`${path}: refine '${String(t.refine)}' は未知なので ${parentRefine ?? 'REPLACE'} として扱いました`);
      refine = parentRefine ?? 'REPLACE';
    } else refine = parentRefine ?? 'REPLACE';

    let contentUri: string | null = null;
    if (t.content !== undefined) {
      const c = t.content;
      const uri = isObj(c) ? (typeof c.uri === 'string' ? c.uri : typeof c.url === 'string' ? c.url : null) : null;
      if (uri === null) {
        warnings.push(`${path}: content に uri がありません（content 無しとして扱いました）`);
      } else if (/\.json(?:[?#]|$)/i.test(uri)) {
        // 外部 tileset（content が .json）は追いかけない。その枝ごと捨てる
        warnings.push(`${path}: 外部 tileset（${uri}）は未対応なので捨てました`);
        return null;
      } else {
        contentUri = resolveContentUri(uri, tilesetUrl);
      }
    }

    const children: TileNode[] = [];
    if (t.children !== undefined) {
      if (!Array.isArray(t.children)) warnings.push(`${path}: children が配列ではありません（無視しました）`);
      else {
        t.children.forEach((c, i) => {
          const node = walk(c, refine, depth + 1, `${path}.children[${i}]`);
          if (node) children.push(node);
        });
      }
    }

    return { region, geometricError: isFiniteNum(t.geometricError) ? t.geometricError : 0, refine, contentUri, children, depth };
  };

  const root = walk(json.root, null, 0, 'root');
  if (!root) throw new Error(`tileset.json の root が使えません: ${warnings[warnings.length - 1] ?? '不明'}`);
  return { root, warnings };
}

// ---------------------------------------------------------------------------
// selectContentTiles
// ---------------------------------------------------------------------------

/**
 * 取得する content を選ぶ。
 *  - 木は全部歩き、content ごとに自分の region が box と交差するかを見る（親の region では刈らない: 上の注のとおり PLATEAU は子が親からはみ出す）
 *  - REPLACE のノードは children があれば自分の content を読まない（葉だけ）。ADD のノードは自分の content も読む
 *  - 距離規則: distanceM < nearM または distanceM − heightSpanM × reachFactor < reachMargin（遠くても高い建物の影は届く）
 *  - 近い順（同距離なら深い順 → URL 順）に並べ、maxTiles を超えた分は遠い方から捨てて truncated = true
 */
export function selectContentTiles(
  ts: ParsedTileset,
  box: GeoBox,
  opts: { lat: number; lon: number; nearM: number; reachFactor: number; reachMargin: number; maxTiles: number },
): { tiles: ContentTile[]; truncated: boolean } {
  const { lat, lon, nearM, reachFactor, reachMargin } = opts;
  const found: ContentTile[] = [];
  const seen = new Set<string>();

  const visit = (node: TileNode) => {
    const leaf = node.children.length === 0;
    const deg = regionToDegBox(node.region);
    if (node.contentUri && (leaf || node.refine === 'ADD') && degBoxIntersects(deg, box) && !seen.has(node.contentUri)) {
      const distanceM = degBoxDistanceM(lat, lon, deg);
      const heightSpanM = node.region.maxH - node.region.minH;
      if (distanceM < nearM || distanceM - heightSpanM * reachFactor < reachMargin) {
        seen.add(node.contentUri);
        found.push({ url: node.contentUri, region: node.region, depth: node.depth, distanceM, heightSpanM, leaf });
      }
    }
    for (const c of node.children) visit(c);
  };
  visit(ts.root);

  found.sort((a, b) => a.distanceM - b.distanceM || b.depth - a.depth || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const max = Math.max(0, Math.floor(opts.maxTiles));
  const truncated = found.length > max;
  return { tiles: truncated ? found.slice(0, max) : found, truncated };
}
