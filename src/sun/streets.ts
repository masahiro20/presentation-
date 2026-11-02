/**
 * OpenStreetMap の街路・緑地・樹木（周辺環境を「建物の箱」だけでなく「街」として立ち上げる）
 *
 * 参考にした D5 Render の「街の取り込み」も OSM の道路・建物・緑を読み込んで街を作る。建物は PLATEAU（実測）が
 * 既にあるので、ここでは建物以外を足す:
 *  - 道路: 種類（幅）ごとの路面。5m 以上は両端に白線、9m 以上は縁石と歩道
 *  - 緑地: 公園・芝・農地などの面（芝の実写）。林は中に木を散らす
 *  - 樹木: natural=tree の 1 本ずつと、並木（tree_row）。街路樹は幹＋葉のカード
 * 取得は Overpass API（公開・無料）。取れなければ無しのまま（建物と航空写真だけ）
 */
import * as THREE from 'three';
import { lonLatToTile, metersPerDegree, tileToLonLat, toLocal } from './geo';
import { decodeMvt, type MvtLayer } from './mvt';
import type { EN } from './align';
import { MeshBuilder } from '../scene/meshBuilder';

export type RoadKind = 'major' | 'street' | 'lane' | 'path';

export interface StreetRoad {
  pts: EN[];
  width: number;
  kind: RoadKind;
  name?: string;
}

export interface StreetGreen {
  ring: EN[];
  /** 林・森（中に木を散らす） */
  wooded: boolean;
}

export interface StreetTree {
  e: number;
  n: number;
  height: number;
}

export interface StreetData {
  roads: StreetRoad[];
  greens: StreetGreen[];
  trees: StreetTree[];
}

/** 道路の種類 → 幅 (m) と扱い。width・lanes タグがあればそちら */
export function roadSpec(tags: Record<string, string>): { width: number; kind: RoadKind } | null {
  const hw = tags['highway'] ?? '';
  const base: Record<string, [number, RoadKind]> = {
    motorway: [14, 'major'],
    trunk: [12, 'major'],
    primary: [11, 'major'],
    secondary: [9, 'major'],
    tertiary: [7, 'street'],
    unclassified: [5, 'street'],
    residential: [5, 'street'],
    living_street: [4, 'lane'],
    service: [3.5, 'lane'],
    pedestrian: [3, 'path'],
    footway: [1.8, 'path'],
    path: [1.5, 'path'],
    cycleway: [2, 'path'],
  };
  const b = base[hw];
  if (!b) return null;
  let width = b[0];
  const w = parseFloat(tags['width'] ?? '');
  const lanes = parseInt(tags['lanes'] ?? '', 10);
  if (isFinite(w) && w > 1 && w < 40) width = w;
  else if (isFinite(lanes) && lanes > 0 && b[1] !== 'path') width = Math.max(width, lanes * 3 + 1);
  const kind: RoadKind = b[1] === 'path' ? 'path' : width >= 9 ? 'major' : width >= 5 ? 'street' : 'lane';
  return { width, kind };
}

const GREEN_LANDUSE = /^(grass|village_green|recreation_ground|meadow|orchard|farmland|cemetery|greenfield|allotments)$/;
const WOOD_LANDUSE = /^(forest|wood)$/;
const GREEN_LEISURE = /^(park|garden|pitch|playground|golf_course|nature_reserve)$/;
const GREEN_NATURAL = /^(grassland|heath|scrub)$/;
const WOOD_NATURAL = /^(wood)$/;

export interface OsmEl {
  type: 'node' | 'way' | 'relation';
  lat?: number;
  lon?: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

/** Overpass の結果 → 東・北 (m) の街路データ（テスト用に分離） */
export function parseOsmStreets(elements: OsmEl[], lat: number, lon: number, radius: number): StreetData {
  const roads: StreetRoad[] = [];
  const greens: StreetGreen[] = [];
  const trees: StreetTree[] = [];
  const local = (g: { lat: number; lon: number }) => toLocal(g.lat, g.lon, lat, lon);
  const treeH = (tags: Record<string, string>, i: number) => {
    const h = parseFloat(tags['height'] ?? '');
    if (isFinite(h) && h > 1.5 && h < 40) return h;
    // 街路樹は 5〜9m（種類が分からないので位置で散らす）
    return 5.5 + ((i * 7919) % 100) / 100 * 3.5;
  };
  elements.forEach((el, i) => {
    const tags = el.tags ?? {};
    if (el.type === 'node' && tags['natural'] === 'tree' && el.lat != null && el.lon != null) {
      const p = local({ lat: el.lat, lon: el.lon });
      if (Math.hypot(p.e, p.n) <= radius) trees.push({ e: p.e, n: p.n, height: treeH(tags, i) });
      return;
    }
    if (!el.geometry || el.geometry.length < 2) return;
    const pts = el.geometry.map(local);
    if (tags['highway']) {
      const spec = roadSpec(tags);
      if (!spec) return;
      if (tags['area'] === 'yes' || tags['tunnel'] === 'yes') return;
      roads.push({ pts, width: spec.width, kind: spec.kind, name: tags['name'] });
      return;
    }
    if (tags['natural'] === 'tree_row') {
      // 並木: 6m おき
      const h = treeH(tags, i);
      let carry = 0;
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k];
        const b = pts[k + 1];
        const L = Math.hypot(b.e - a.e, b.n - a.n);
        for (let t = carry; t < L; t += 6) {
          const u = t / L;
          trees.push({ e: a.e + (b.e - a.e) * u, n: a.n + (b.n - a.n) * u, height: h });
        }
        carry = ((carry - L) % 6 + 6) % 6;
      }
      return;
    }
    const closed = pts.length >= 4 && Math.hypot(pts[0].e - pts[pts.length - 1].e, pts[0].n - pts[pts.length - 1].n) < 0.5;
    if (!closed) return;
    const ring = pts.slice(0, -1);
    const lu = tags['landuse'] ?? '';
    const le = tags['leisure'] ?? '';
    const na = tags['natural'] ?? '';
    const wooded = WOOD_LANDUSE.test(lu) || WOOD_NATURAL.test(na);
    if (wooded || GREEN_LANDUSE.test(lu) || GREEN_LEISURE.test(le) || GREEN_NATURAL.test(na)) greens.push({ ring, wooded });
  });
  return { roads, greens, trees };
}

/** Overpass API から街路・緑地・樹木を取得（建物は別で取る） */
export async function fetchOsmStreets(lat: number, lon: number, radius = 140, opts: { signal?: AbortSignal } = {}): Promise<StreetData> {
  const r = Math.round(radius);
  const q =
    `[out:json][timeout:25];(` +
    `way["highway"](around:${r},${lat},${lon});` +
    `way["landuse"](around:${r},${lat},${lon});` +
    `way["leisure"](around:${r},${lat},${lon});` +
    `way["natural"](around:${r},${lat},${lon});` +
    `node["natural"="tree"](around:${r},${lat},${lon});` +
    `);out geom tags;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`OpenStreetMap の取得に失敗しました (${res.status})`);
  const js = (await res.json()) as { elements: OsmEl[] };
  return parseOsmStreets(js.elements ?? [], lat, lon, radius);
}

/** 国土地理院 最適化ベクトルタイル 道路中心線（RdCL）の属性 → 幅 (m)。vt_width は cm、無ければ幅員区分の代表値 */
export function gsiRoadWidth(props: Record<string, string | number | boolean>): number {
  const w = Number(props['vt_width']);
  if (isFinite(w) && w >= 100 && w <= 4500) return w / 100;
  const rank = String(props['vt_rnkwidth'] ?? '');
  if (/19\.5m以上/.test(rank)) return 22;
  if (/13m-19\.5m/.test(rank)) return 16;
  if (/5\.5m-13m/.test(rank)) return 8;
  if (/3m-5\.5m/.test(rank)) return 4.5;
  if (/3m未満/.test(rank)) return 2.5;
  return 5;
}

/** 国土地理院の道路中心線から道路を取る（日本全国・幅員あり。Overpass が届かない環境でもこちらは届く） */
export async function fetchGsiRoads(lat: number, lon: number, radius = 140, opts: { signal?: AbortSignal } = {}): Promise<StreetRoad[]> {
  const z = 16;
  const { mLat, mLon } = metersPerDegree(lat);
  const t0 = lonLatToTile(lon - radius / mLon, lat + radius / mLat, z);
  const t1 = lonLatToTile(lon + radius / mLon, lat - radius / mLat, z);
  const out: StreetRoad[] = [];
  let tiles = 0;
  let failed = 0;
  for (let ty = Math.floor(t0.y); ty <= Math.floor(t1.y); ty++)
    for (let tx = Math.floor(t0.x); tx <= Math.floor(t1.x); tx++) {
      tiles++;
      let layers: Record<string, MvtLayer>;
      try {
        const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${tx}/${ty}.pbf`, { signal: opts.signal });
        if (!res.ok) {
          if (res.status !== 404) failed++;
          continue;
        }
        layers = decodeMvt(new Uint8Array(await res.arrayBuffer()));
      } catch (e) {
        if (opts.signal?.aborted) throw (opts.signal.reason as Error | undefined) ?? e;
        failed++;
        continue;
      }
      out.push(...gsiRoadsFromLayer(layers['RdCL'], tx, ty, z, lat, lon, radius));
    }
  if (tiles && failed === tiles) throw new Error('国土地理院のサーバーに接続できませんでした');
  return out;
}

/** タイル 1 枚の RdCL → 道路（テスト用に分離）。トンネル・高架の区別は無いので地表の道として描く */
export function gsiRoadsFromLayer(layer: MvtLayer | undefined, tx: number, ty: number, z: number, lat: number, lon: number, radius: number): StreetRoad[] {
  const out: StreetRoad[] = [];
  if (!layer) return out;
  for (const f of layer.features) {
    if (f.type !== 2) continue;
    const width = gsiRoadWidth(f.props);
    const cat = String(f.props['vt_rdctg'] ?? '');
    const kind: RoadKind = width >= 9 ? 'major' : width >= 4 || /国道|都道府県道/.test(cat) ? 'street' : 'lane';
    for (const part of f.rings) {
      if (part.length < 2) continue;
      const pts = part.map(([px, py]) => {
        const ll = tileToLonLat(tx + px / layer.extent, ty + py / layer.extent, z);
        return toLocal(ll.lat, ll.lon, lat, lon);
      });
      if (!pts.some((p) => Math.hypot(p.e, p.n) <= radius * 1.3)) continue;
      out.push({ pts, width, kind });
    }
  }
  return out;
}

export interface BuildStreetsOptions {
  /** 東・北 (m) → ワールド */
  toWorld: (e: number, n: number, y?: number) => THREE.Vector3;
  /** 敷地や建物の中（木を植えない・緑地を描かない場所） */
  exclude?: (p: THREE.Vector3) => boolean;
  /** 道路を描く半径 (m)。これより外の区間は捨てる */
  radius?: number;
  /** 乱数の種（木の向き・大きさ） */
  seed?: number;
}

export interface StreetsBuild {
  mb: MeshBuilder;
  /** 葉のカード（別マテリアル・影あり。板の裏表） */
  leaves: MeshBuilder;
  counts: { roads: number; greens: number; trees: number };
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 街路樹: 幹（錐台）＋ 樹冠（葉のカードを交差させて球状に）。影を落とす */
export function addStreetTree(mb: MeshBuilder, leaves: MeshBuilder, p: THREE.Vector3, h: number, rnd: () => number) {
  const trunkH = h * 0.42;
  const r0 = Math.max(0.08, h * 0.022);
  mb.tube('l.trunk', p.clone(), p.clone().setY(p.y + trunkH), r0, r0 * 0.7, 7);
  const crownR = h * 0.27;
  const cy = p.y + trunkH + crownR * 0.8;
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd() * 0.8;
    const d = crownR * (0.25 + rnd() * 0.45);
    const c = new THREE.Vector3(p.x + Math.cos(a) * d, cy + (rnd() - 0.5) * crownR * 0.9, p.z + Math.sin(a) * d);
    leaves.card('l.leafSpray', c, crownR * (1.2 + rnd() * 0.6), new THREE.Euler((rnd() - 0.5) * 1.4, rnd() * Math.PI * 2, (rnd() - 0.5) * 1.4));
  }
}

/** 面（東・北）→ ワールドの多角形を床として描く（反時計回りに正規化） */
function flatPolygon(mb: MeshBuilder, key: string, ring: EN[], y: number, toWorld: BuildStreetsOptions['toWorld']) {
  if (ring.length < 3) return;
  const pts = ring.map((p) => toWorld(p.e, p.n, y));
  mb.polygon(key, pts, new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1));
}

/** 折れ線の帯（路面・白線・歩道）。角は円板で埋める */
function ribbon(mb: MeshBuilder, key: string, pts: THREE.Vector3[], width: number, y: number, offset = 0) {
  const hw = width / 2;
  const up = new THREE.Vector3(0, 1, 0);
  const segs: { a: THREE.Vector3; b: THREE.Vector3; nrm: THREE.Vector3 }[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i].clone().setY(y);
    const b = pts[i + 1].clone().setY(y);
    const d = b.clone().sub(a);
    const L = d.length();
    if (L < 0.05) continue;
    d.divideScalar(L);
    const nrm = new THREE.Vector3().crossVectors(up, d).normalize();
    segs.push({ a: a.addScaledVector(nrm, offset), b: b.addScaledVector(nrm, offset), nrm });
  }
  for (const s of segs) {
    const p0 = s.a.clone().addScaledVector(s.nrm, hw);
    const p1 = s.b.clone().addScaledVector(s.nrm, hw);
    const p2 = s.b.clone().addScaledVector(s.nrm, -hw);
    const p3 = s.a.clone().addScaledVector(s.nrm, -hw);
    mb.quad(key, p0, p3, p2, p1, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1));
  }
  // 角の円板（帯のつなぎ目の隙間を埋める）。細い帯は不要
  if (hw > 0.3) {
    for (let i = 1; i < segs.length; i++) {
      const c = segs[i].a;
      const n = 10;
      const disc: THREE.Vector3[] = [];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        disc.push(new THREE.Vector3(c.x + Math.cos(a) * hw, y, c.z + Math.sin(a) * hw));
      }
      mb.polygon(key, disc, up, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1));
    }
  }
}

/** 街路データ → メッシュ（マテリアルキーは scene/materials の 'l.*'） */
export function buildStreets(data: StreetData, opts: BuildStreetsOptions): StreetsBuild {
  const mb = new MeshBuilder();
  const leaves = new MeshBuilder();
  const rnd = rng(opts.seed ?? 11);
  const R = opts.radius ?? 140;
  const exclude = opts.exclude ?? (() => false);
  const counts = { roads: 0, greens: 0, trees: 0 };
  // 緑地（道路より下）
  for (const g of data.greens) {
    const c = g.ring.reduce((s, p) => ({ e: s.e + p.e / g.ring.length, n: s.n + p.n / g.ring.length }), { e: 0, n: 0 });
    if (Math.hypot(c.e, c.n) > R * 1.5) continue;
    if (exclude(opts.toWorld(c.e, c.n))) continue;
    flatPolygon(mb, 'l.far', g.ring, 0.012, opts.toWorld);
    counts.greens++;
    if (g.wooded) {
      // 林: 7m 格子に揺らして木を散らす（多すぎないように上限）
      const es = g.ring.map((p) => p.e);
      const ns = g.ring.map((p) => p.n);
      const [e0, e1, n0, n1] = [Math.min(...es), Math.max(...es), Math.min(...ns), Math.max(...ns)];
      let placed = 0;
      for (let e = e0 + 3; e < e1 && placed < 60; e += 7)
        for (let n = n0 + 3; n < n1 && placed < 60; n += 7) {
          const pe = e + (rnd() - 0.5) * 4;
          const pn = n + (rnd() - 0.5) * 4;
          if (Math.hypot(pe, pn) > R) continue;
          if (!pointInRing({ e: pe, n: pn }, g.ring)) continue;
          const w = opts.toWorld(pe, pn);
          if (exclude(w)) continue;
          addStreetTree(mb, leaves, w, 7 + rnd() * 4, rnd);
          placed++;
          counts.trees++;
        }
    }
  }
  // 道路
  for (const r of data.roads) {
    const pts = r.pts.filter((p) => Math.hypot(p.e, p.n) <= R * 1.3).map((p) => opts.toWorld(p.e, p.n));
    if (pts.length < 2) continue;
    const key = r.kind === 'path' ? 'l.block' : 'l.road';
    ribbon(mb, key, pts, r.width, r.kind === 'path' ? 0.022 : 0.02);
    counts.roads++;
    if (r.kind === 'major' || r.kind === 'street') {
      // 両端の白線（外側 0.25m 内）
      ribbon(mb, 'l.roadLine', pts, 0.12, 0.026, r.width / 2 - 0.3);
      ribbon(mb, 'l.roadLine', pts, 0.12, 0.026, -(r.width / 2 - 0.3));
    }
    if (r.kind === 'major') {
      // 縁石（少し高い）と歩道
      for (const sgn of [1, -1]) {
        ribbon(mb, 'l.curb', pts, 0.25, 0.12, sgn * (r.width / 2 + 0.12));
        ribbon(mb, 'l.block', pts, 2.0, 0.1, sgn * (r.width / 2 + 1.2));
      }
    }
  }
  // 樹木
  for (const t of data.trees) {
    const w = opts.toWorld(t.e, t.n);
    if (exclude(w)) continue;
    addStreetTree(mb, leaves, w, t.height, rnd);
    counts.trees++;
  }
  return { mb, leaves, counts };
}

function pointInRing(p: EN, ring: EN[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.n > p.n !== b.n > p.n && p.e < ((b.e - a.e) * (p.n - a.n)) / (b.n - a.n) + a.e) inside = !inside;
  }
  return inside;
}
