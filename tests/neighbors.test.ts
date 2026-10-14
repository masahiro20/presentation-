import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tileToLonLat, toLocal } from '../src/sun/geo';
import { clearPlateauCaches, setDracoDecoderFactory } from '../src/sun/plateau';
import type { DracoDecoderLike, PlateauIndex } from '../src/sun/plateau';
import {
  applyDistanceRule,
  buildNeighborMeshes,
  clipRingToRect,
  excludeOverlapping,
  fetchNeighbors,
  fillGapsWithGsi,
  makeManualNeighbor,
  parseGsiTile,
  ringCenter,
} from '../src/sunstudy/neighbors';
import { loadEnvironment } from '../src/sunstudy/environment';
import { reachHeight } from '../src/sunstudy/plateauNeighbors';
import { study } from '../src/sunstudy/state';
import { frameFromLocal } from '../src/sunstudy/types';
import type { Neighbor } from '../src/sunstudy/types';
import { nodeDracoDecoder } from './helpers/nodeDraco';
import { plateauNeighborAt } from './helpers/plateauBox';

const PIN = { lat: 35.681236, lon: 139.767125 };
const TILE = { x: 58208, y: 25807, z: 16 };
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const gsiBytes = fixture('gsi_16_58208_25807.pbf');

const square = (e0: number, n0: number, size: number) => [
  { e: e0, n: n0 },
  { e: e0 + size, n: n0 },
  { e: e0 + size, n: n0 + size },
  { e: e0, n: n0 + size },
];
const nb = (ring: { e: number; n: number }[], height = 7, extra: Partial<Neighbor> = {}): Neighbor => ({ id: `t:${ring[0].e}:${ring[0].n}`, ring, height, source: 'gsi', heightKind: 'estimated', ...extra });

describe('国土地理院タイルの読み込み', () => {
  const list = parseGsiTile(gsiBytes, TILE.x, TILE.y, TILE.z, PIN.lat, PIN.lon);
  it('建物種類から高さを推定する', () => {
    expect(list.length).toBeGreaterThan(0);
    const allowed = [7, 12, 30, 2.8, 4];
    for (const b of list) {
      expect(allowed).toContain(b.height);
      expect(b.source).toBe('gsi');
      expect(b.heightKind).toBe('estimated');
      expect(b.id.startsWith('gsi:')).toBe(true);
    }
    expect(list.some((b) => b.height === 2.8 && b.label === 'カーポート等（無壁舎）')).toBe(true);
  });
  it('id は決定的（2 回読んでも同じ）で重複しない', () => {
    const again = parseGsiTile(gsiBytes, TILE.x, TILE.y, TILE.z, PIN.lat, PIN.lon);
    expect(again.map((b) => b.id)).toEqual(list.map((b) => b.id));
    expect(new Set(list.map((b) => b.id)).size).toBe(list.length);
    for (const b of list) expect(b.id).toMatch(/^gsi:\d+\.\d{5}:\d+\.\d{5}:\d+$/);
  });
  it('リングは閉じる重複点を持たず、短すぎる辺が無い', () => {
    for (const b of list) {
      const a = b.ring[0];
      const z = b.ring[b.ring.length - 1];
      expect(Math.hypot(a.e - z.e, a.n - z.n)).toBeGreaterThanOrEqual(0.05);
      for (let i = 1; i < b.ring.length; i++) expect(Math.hypot(b.ring[i].e - b.ring[i - 1].e, b.ring[i].n - b.ring[i - 1].n)).toBeGreaterThanOrEqual(0.05);
    }
  });
  it('のりしろを切り取るので、すべての頂点がタイルの範囲内にある', () => {
    const nw = tileToLonLat(TILE.x, TILE.y, TILE.z);
    const se = tileToLonLat(TILE.x + 1, TILE.y + 1, TILE.z);
    const a = toLocal(nw.lat, nw.lon, PIN.lat, PIN.lon);
    const b = toLocal(se.lat, se.lon, PIN.lat, PIN.lon);
    // タイル 1 枚は約 500 m 角
    expect(b.e - a.e).toBeGreaterThan(400);
    expect(a.n - b.n).toBeGreaterThan(400);
    for (const nb of list)
      for (const p of nb.ring) {
        expect(p.e).toBeGreaterThanOrEqual(a.e - 0.01);
        expect(p.e).toBeLessThanOrEqual(b.e + 0.01);
        expect(p.n).toBeLessThanOrEqual(a.n + 0.01);
        expect(p.n).toBeGreaterThanOrEqual(b.n - 0.01);
      }
  });
  it('PLATEAU と重なる建物は補完から除かれる', () => {
    // 国土地理院の建物の一部を「PLATEAU の実足元」に見立てる（同じ足元なので完全に重なる）
    const plateau: Neighbor[] = list.slice(0, 20).map((b, i) => ({ ...b, id: `plateau:bldg_${i}`, source: 'plateau', heightKind: 'measured', height: 9 }));
    const fill = fillGapsWithGsi(plateau, list);
    expect(fill.length).toBeLessThan(list.length);
    expect(fill.length).toBeLessThanOrEqual(list.length - plateau.length);
    // 完全に重なる同じ形は捨てられ、離れた建物は残る
    const far = nb(square(5000, 5000, 10));
    expect(fillGapsWithGsi(plateau, [far])).toHaveLength(1);
    expect(fillGapsWithGsi([{ ...plateau[0], ring: plateau[0].ring }], [nb(plateau[0].ring)])).toHaveLength(0);
  });
});

describe('タイル範囲での切り取り', () => {
  it('のりしろにはみ出た部分を落とし、向きを保つ', () => {
    const ring: [number, number][] = [
      [-80, 100],
      [200, 100],
      [200, 300],
      [-80, 300],
    ];
    const c = clipRingToRect(ring, 0, 4096);
    expect(c.every(([x]) => x >= 0)).toBe(true);
    let a = 0;
    for (let i = 0; i < c.length; i++) a += c[i][0] * c[(i + 1) % c.length][1] - c[(i + 1) % c.length][0] * c[i][1];
    // 切り取り後は 0..200 × 100..300 の矩形（面積 ×2 = 80000）で、元と同じ向き（正）
    expect(a).toBeCloseTo(80000, 5);
    expect(a).toBeGreaterThan(0);
  });
  it('完全に外なら空になる', () => {
    expect(clipRingToRect([[-80, -80], [-10, -80], [-10, -10], [-80, -10]], 0, 4096)).toHaveLength(0);
  });
});

describe('重なる建物の除外', () => {
  const site = square(0, 0, 10);
  it('中心が多角形の中にある建物は除かれ、離れた建物は残る', () => {
    const inside = nb(square(2, 2, 4));
    const far = nb(square(50, 50, 8));
    const crossing = nb(square(8, 8, 6)); // 角だけ重なる
    const out = excludeOverlapping([inside, far, crossing], [site]);
    expect(out.map((b) => b.id)).toEqual([far.id]);
  });
  it('多角形が無ければそのまま', () => {
    const a = nb(square(2, 2, 4));
    expect(excludeOverlapping([a], [])).toEqual([a]);
  });
  it('辺だけが交わる（頂点を含まない）十字形も重なりとみなす', () => {
    const thin = nb([
      { e: 4, n: -5 },
      { e: 6, n: -5 },
      { e: 6, n: 15 },
      { e: 4, n: 15 },
    ]);
    expect(excludeOverlapping([thin], [site])).toHaveLength(0);
  });
});

describe('手動の隣家', () => {
  it('南 10 m なら中心は n ≈ -10', () => {
    const m = makeManualNeighbor(180, 10, 8, 8, 7);
    const c = ringCenter(m.ring);
    expect(c.n).toBeCloseTo(-10, 6);
    expect(c.e).toBeCloseTo(0, 6);
    expect(m.source).toBe('manual');
    expect(m.heightKind).toBe('manual');
    expect(m.label).toBe('隣家');
    expect(m.height).toBe(7);
    expect(m.id.startsWith('manual:')).toBe(true);
    expect(makeManualNeighbor(90, 5, 4, 4, 3).id).not.toBe(m.id);
  });
  it('東 10 m なら中心は e ≈ 10', () => {
    const c = ringCenter(makeManualNeighbor(90, 10, 8, 6, 7).ring);
    expect(c.e).toBeCloseTo(10, 6);
    expect(c.n).toBeCloseTo(0, 6);
  });
});

describe('遠い建物の残し方', () => {
  it('150 m 以内は残し、遠くは高い建物だけ far 付きで残す', () => {
    const near = nb(square(100, 0, 10), 3);
    const farLow = nb(square(300, 0, 10), 10);
    const farTall = nb(square(300, 0, 10), 60, { id: 'tall' });
    const out = applyDistanceRule([near, farLow, farTall]);
    expect(out.map((b) => b.id)).toEqual([near.id, 'tall']);
    expect(out[0].far).toBeUndefined();
    expect(out[1].far).toBe(true);
  });
  it('heightOf: PLATEAU は max(形状の高さ, 実測の最高高さ) で判定する（reachHeight）', () => {
    // 300 m 先・形状の高さ 10 m（届かない）だが実測の最高高さ 60 m → far 付きで残す
    const pin = { lat: 35.6, lon: 139.6 };
    const lowShape = plateauNeighborAt(pin, 300, 0, { gmlId: 'bldg_tall', h: 10, attrs: { measuredHeight: 60 } });
    expect(applyDistanceRule([lowShape]).map((b) => b.id)).toEqual([]);
    const out = applyDistanceRule([lowShape], 150, reachHeight);
    expect(out.map((b) => b.id)).toEqual(['plateau:bldg_tall']);
    expect(out[0].far).toBe(true);
    // 実測の最高高さが無い・低い建物は従来どおり
    expect(applyDistanceRule([plateauNeighborAt(pin, 300, 0, { h: 10 })], 150, reachHeight)).toEqual([]);
  });
});

describe('押し出しメッシュ', () => {
  it('e 0..10, n 0..10 の正方形 → x 0..10, z -10..0, y 0..7.3', () => {
    const g = buildNeighborMeshes([nb(square(0, 0, 10), 7, { heightKind: 'measured', source: 'plateau' })], { groundY: () => 0 });
    expect(g.children).toHaveLength(1);
    const mesh = g.children[0] as THREE.Mesh;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    expect(bb.min.x).toBeCloseTo(0, 5);
    expect(bb.max.x).toBeCloseTo(10, 5);
    expect(bb.min.z).toBeCloseTo(-10, 5);
    expect(bb.max.z).toBeCloseTo(0, 5);
    expect(bb.min.y).toBeCloseTo(0, 5);
    expect(bb.max.y).toBeCloseTo(7.3, 5);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    expect(mesh.userData.neighbor).toBe(true);
    expect(mesh.userData.neighborId).toBe(`t:0:0`);
    expect(mesh.userData.matKey).toBe('neighbor');
    expect(Array.isArray(mesh.material)).toBe(true);
    expect((mesh.material as THREE.Material[]).length).toBe(2);
    expect(mesh.name).toBe('周辺建物');
  });
  it('足元は地形の最低点、推定の高さは高低差を足す', () => {
    const groundY = (e: number) => (e > 5 ? 2 : 1);
    const measured = buildNeighborMeshes([nb(square(0, 0, 10), 7, { heightKind: 'measured' })], { groundY }).children[0] as THREE.Mesh;
    measured.geometry.computeBoundingBox();
    expect(measured.geometry.boundingBox!.min.y).toBeCloseTo(1, 5);
    expect(measured.geometry.boundingBox!.max.y).toBeCloseTo(8.3, 5);
    const est = buildNeighborMeshes([nb(square(0, 0, 10), 7, { heightKind: 'estimated' })], { groundY }).children[0] as THREE.Mesh;
    est.geometry.computeBoundingBox();
    expect(est.geometry.boundingBox!.min.y).toBeCloseTo(1, 5);
    expect(est.geometry.boundingBox!.max.y).toBeCloseTo(9.3, 5);
  });
  it('非表示の建物は作らず、ラベルが名前になる', () => {
    const g = buildNeighborMeshes([nb(square(0, 0, 10), 7, { hidden: true }), nb(square(20, 0, 10), 7, { label: 'カーポート等（無壁舎）' })], { groundY: () => 0 });
    expect(g.children).toHaveLength(1);
    expect(g.children[0].name).toBe('カーポート等（無壁舎）');
  });
  it('穴のある建物も作れる（上面の面積が減る）', () => {
    const solid = buildNeighborMeshes([nb(square(0, 0, 10), 5)], { groundY: () => 0 }).children[0] as THREE.Mesh;
    const holed = buildNeighborMeshes([{ ...nb(square(0, 0, 10), 5), holes: [square(3, 3, 4)] } as Neighbor], { groundY: () => 0 }).children[0] as THREE.Mesh;
    expect(holed.geometry.getAttribute('position').count).toBeGreaterThan(solid.geometry.getAttribute('position').count);
  });
});

describe('fetchNeighbors（fetch をモック: PLATEAU 3D Tiles ＋ 国土地理院）', () => {
  /** 守山区 23113 の data0 の葉だけが選ばれ、6 棟の矩形がすべて半径内に入るピン（tests/plateauFetch.test.ts と同じ） */
  const PIN_MORIYAMA = { lat: 35.2565, lon: 137.0545 };
  const RADIUS = 250;
  const pfix = (name: string) => readFileSync(new URL(`./fixtures/plateau/${name}`, import.meta.url));
  const pfixBuf = (name: string): ArrayBuffer => {
    const b = pfix(name);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  const index = JSON.parse(pfix('index.mini.json').toString('utf8')) as PlateauIndex;
  const latestMissing = JSON.parse(pfix('latest_missing.json').toString('utf8')) as unknown;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  /** -latest ラッパー（children[0].content.uri に実 tileset.json の URL） */
  const latestWrapper = (uri: string) => ({
    asset: { version: '1.0' },
    geometricError: 50000,
    root: { boundingVolume: { region: [2.39, 0.61, 2.4, 0.62, -50, 500] }, geometricError: 50000, refine: 'ADD', children: [{ boundingVolume: { region: [2.39, 0.61, 2.4, 0.62, -50, 500] }, geometricError: 500, content: { uri } }] },
  });
  type Route = (url: string) => Response | null | undefined;
  /**
   * URL の部分一致で応答を切り替える: LonLatToAddress → 市区町村コード（既定 23113 = 守山区）、plateau-index.json → index.mini、
   * -latest → ラッパー（索引に無い組合せは children 無し）、tileset.json → 23113 の fixture、.b3dm → data0 の fixture、
   * optimal_bvmap → 国土地理院の fixture（gsi に 404/500/'reject'）。override が null を返せば通信失敗（TypeError）、Response を返せばそれ
   */
  const mockFetch = (o: { muniCd?: string | null; gsi?: number | 'reject'; override?: Route } = {}) =>
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const r = o.override?.(url);
      if (r === null) throw new TypeError(`fetch failed: ${url}`);
      if (r) return r;
      if (url.includes('LonLatToAddress')) return json({ results: o.muniCd === null ? null : { muniCd: o.muniCd ?? '23113', lv01Nm: '町' } });
      if (url.includes('plateau-index.json')) return json(index);
      const latest = /3dtiles\/(\d{5})-bldg-lod(\d)-(notexture|texture)-latest\//.exec(url);
      if (latest) {
        const set = index.areas[latest[1]]?.sets.find((s) => s.lod === Number(latest[2]) && s.tex === (latest[3] === 'texture'));
        return json(set ? latestWrapper(index.urlPrefix + set.url) : latestMissing);
      }
      if (url.endsWith('tileset.json')) return new Response(pfix('23113_lod1_tileset.json'), { headers: { 'content-type': 'application/json' } });
      if (url.endsWith('.b3dm')) return new Response(pfixBuf('23113_lod1_data0.b3dm'), { headers: { 'content-type': 'application/octet-stream' } });
      if (url.includes('optimal_bvmap')) {
        if (o.gsi === 'reject') throw new TypeError('fetch failed');
        const status = o.gsi ?? 200;
        return new Response(status === 200 ? gsiBytes : null, { status });
      }
      throw new TypeError(`fetch failed (no route): ${url}`);
    });
  const isPlateauUrl = (u: string) => u.includes('plateau-index.json') || u.includes('-latest') || u.includes('LonLatToAddress') || u.endsWith('.b3dm');

  let draco: DracoDecoderLike;
  beforeAll(async () => {
    draco = await nodeDracoDecoder();
  });
  beforeEach(async () => {
    await clearPlateauCaches();
  });
  afterEach(() => vi.unstubAllGlobals());
  const run = (opts: Parameters<typeof fetchNeighbors>[3] = {}, pin = PIN_MORIYAMA) => fetchNeighbors(pin.lat, pin.lon, RADIUS, { ...opts, plateau: { draco, ...opts.plateau } });

  it('PLATEAU の整備地域: PLATEAU（実測の高さ・形状）を使い、国土地理院は隙間だけ補う。id は plateau:gml_id、注記は固定文', async () => {
    const f = mockFetch();
    vi.stubGlobal('fetch', f);
    const msgs: string[] = [];
    const r = await run({ onProgress: (m) => msgs.push(m) });
    expect(r.sourcesUsed[0]).toBe('plateau');
    expect(r.notes[0]).toMatch(/^PLATEAU（国土交通省 3D都市モデル・愛知県名古屋市守山区・2022年度・LOD1）の実測の高さ・形状を使用（\d+ 棟/);
    expect(r.notes[0]).toContain('箱形。天端は点群の中央値');
    // data0 の 6 棟はピンの西 125〜240 m: 150 m 以内の 2 棟 + 影が届きうる遠い 2 棟（うち 1 棟は形状 5.3 m・実測 17.3 m で reachHeight により残る）
    const plateau = r.list.filter((b) => b.source === 'plateau') as (Neighbor & { far?: boolean })[];
    expect(plateau).toHaveLength(4);
    const byMeasured = plateau.find((b) => b.id === 'plateau:bldg_739f8d5e-2001-4ae3-9abe-8d5d1600dcf6')!;
    expect(byMeasured.far).toBe(true);
    expect(byMeasured.height).toBe(5.3);
    expect(byMeasured.plateau!.measuredHeight).toBeCloseTo(17.3, 6);
    expect(plateau.some((b) => b.id === 'plateau:bldg_f6b9f4fb-9b61-43e7-beb1-88a917669590')).toBe(false);
    for (const b of plateau) {
      expect(b.id).toMatch(/^plateau:bldg_/);
      expect(b.heightKind).toBe('measured');
      expect(b.height).toBeGreaterThan(0);
      expect(b.ring.length).toBeGreaterThanOrEqual(3);
      expect(b.mesh!.tris.length).toBeGreaterThan(0);
      expect(b.mesh!.tris.length % 9).toBe(0);
      expect(b.plateau).toMatchObject({ muniCd: '23113', datasetLod: 1, year: 2022, footprint: 'bottom' });
      expect(b.plateau!.gmlId).toBe(b.id.slice('plateau:'.length));
      // ピン基準の ring は半径の中
      const c = ringCenter(b.ring);
      expect(Math.hypot(c.e, c.n)).toBeLessThan(RADIUS + 50);
    }
    // 国土地理院の補完（PLATEAU の実足元と重なるものは捨てられている）
    expect(r.list.some((b) => b.source === 'gsi')).toBe(true);
    expect(r.sourcesUsed).toEqual(['plateau', 'gsi']);
    expect(r.notes[1]).toMatch(/^国土地理院の地図から \d+ 棟を補いました（高さは建物の種類から推定）。$/);
    expect(r.notes).toHaveLength(2);
    expect(new Set(r.list.map((b) => b.id)).size).toBe(r.list.length);
    // 出典（study.env.plateau 用）
    expect(r.plateau?.datasets).toHaveLength(1);
    expect(r.plateau?.datasets[0]).toMatchObject({ muniCd: '23113', lod: 1, label: '愛知県名古屋市守山区・2022年度・LOD1' });
    expect(r.plateau?.indexGenerated).toBe('2026-10-10');
    expect(r.plateau?.lodCounts).toEqual({ '1': 6 });
    // 進捗の文（PlateauProgress は plateauProgressText で文に）
    expect(msgs.some((m) => m.startsWith('周辺建物（PLATEAU'))).toBe(true);
    expect(msgs.some((m) => /建物タイル \d+\/\d+（[\d.]+ MB）/.test(m))).toBe(true);
    expect(msgs.some((m) => m.includes('守山区'))).toBe(true);
    // 150 m 以上の建物は far か高層だけ
    for (const b of r.list as (Neighbor & { far?: boolean })[]) {
      const c = ringCenter(b.ring);
      const d = Math.hypot(c.e, c.n);
      if (d >= 150) {
        expect(b.far).toBe(true);
        expect(d - reachHeight(b) * 6.9).toBeLessThan(60);
      } else expect(b.far).toBeUndefined();
    }
    // 呼んだ URL: 索引 1 回・-latest 1 回・b3dm 1 枚
    const calls = f.mock.calls.map((c) => String(c[0]));
    expect(calls.filter((u) => u.includes('-latest'))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('.b3dm'))).toHaveLength(1);
  });

  it('ピンを 40 m 動かして取り直しても PLATEAU の建物は同じ id（ring だけずれ、mesh は同じ参照）', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const r1 = await run();
    // 建物のある西へ 40 m（遠い建物が 150 m 以内に入り 5 棟になる）
    const pinB = frameFromLocal(PIN_MORIYAMA, -40, 0);
    const r2 = await run({}, pinB);
    const p1 = new Map(r1.list.filter((b) => b.source === 'plateau').map((b) => [b.id, b]));
    const p2 = r2.list.filter((b) => b.source === 'plateau');
    expect(p2.length).toBeGreaterThanOrEqual(4);
    expect(p2.filter((b) => p1.has(b.id)).length).toBe(p1.size);
    for (const b of p2) {
      const a = p1.get(b.id);
      if (!a) continue;
      expect(ringCenter(b.ring).e - ringCenter(a.ring).e).toBeCloseTo(40, 0);
      expect(ringCenter(b.ring).n - ringCenter(a.ring).n).toBeCloseTo(0, 0);
      // 分割キャッシュから同じ建物（anchor 基準の mesh は作り直さない）
      expect(b.mesh).toBe(a.mesh);
    }
    // 2 回目は同じピンなら同じ id の並び
    const r3 = await run();
    expect(r3.list.filter((b) => b.source === 'plateau').map((b) => b.id)).toEqual([...p1.keys()]);
  });

  it('索引に無い市区（未整備）なら国土地理院の推定で、注記に「未整備」。建物タイルは取らない', async () => {
    const f = mockFetch({ muniCd: '11201' });
    vi.stubGlobal('fetch', f);
    const r = await run();
    expect(r.list.length).toBeGreaterThan(0);
    expect(r.sourcesUsed).toEqual(['gsi']);
    expect(r.list.every((b) => b.source === 'gsi' && b.heightKind === 'estimated')).toBe(true);
    expect(r.notes[0]).toMatch(/PLATEAU.*未整備/);
    expect(r.plateau).toBeUndefined();
    expect(f.mock.calls.some((c) => String(c[0]).endsWith('.b3dm'))).toBe(false);
  });

  it('tileset.json が 500（通信エラー）なら国土地理院の推定で、注記に「通信エラー」', async () => {
    vi.stubGlobal('fetch', mockFetch({ override: (u) => (u.endsWith('tileset.json') && !u.includes('-latest') ? new Response(null, { status: 500 }) : undefined) }));
    const r = await run();
    expect(r.sourcesUsed).toEqual(['gsi']);
    expect(r.notes[0]).toMatch(/PLATEAU のデータを取得できなかったため（通信エラー）/);
    expect(r.plateau).toBeUndefined();
  });

  it('sources で PLATEAU を外せる（索引・-latest・逆ジオコーダ・タイルを呼ばない）', async () => {
    const f = mockFetch();
    vi.stubGlobal('fetch', f);
    const r = await run({ sources: ['gsi'] });
    expect(r.sourcesUsed).toEqual(['gsi']);
    expect(r.notes[0]).not.toMatch(/PLATEAU/);
    expect(f.mock.calls.every((c) => !isPlateauUrl(String(c[0])))).toBe(true);
  });

  it('すべて失敗なら日本語のエラーを投げる', async () => {
    vi.stubGlobal('fetch', mockFetch({ gsi: 'reject', override: (u) => (u.includes('optimal_bvmap') ? undefined : null) }));
    await expect(run()).rejects.toThrow('周辺建物を取得できませんでした（インターネット接続を確認してください）');
  });

  it('中止された signal は中止の理由を投げる', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    await expect(run({ signal: ac.signal })).rejects.toThrow('cancelled');
  });
  it('loadEnvironment: 取り直しの後、旧 id の上書きが同じ足元の新 id に付け直され、study.env.plateau に出典が入る', async () => {
    vi.stubGlobal('fetch', mockFetch());
    // loadEnvironment は opts.plateau を渡さないので、モジュール既定のデコーダを Node 用に差し替える
    setDracoDecoderFactory(() => draco);
    try {
      const first = await run();
      const target = first.list.find((b) => b.source === 'plateau')!;
      // 前回の一覧（旧 MVT 由来の id）に同じ足元の建物があり、高さの上書きと隠した記録が付いている
      study.frame = { lat: PIN_MORIYAMA.lat, lon: PIN_MORIYAMA.lon, address: '守山区', groundElev: null };
      study.sitePolygon = [];
      study.grid = null;
      study.aerial = null;
      study.horizon = null;
      study.neighbors = [
        { id: 'plateau:35.25650:137.05450:80', ring: target.ring.map((q) => ({ ...q })), height: 7, source: 'plateau', heightKind: 'measured' },
        { id: 'manual:1', ring: [{ e: 0, n: -20 }, { e: 6, n: -20 }, { e: 6, n: -14 }, { e: 0, n: -14 }], height: 5, source: 'manual', heightKind: 'manual' },
      ];
      study.neighborOverrides = { 'plateau:35.25650:137.05450:80': { height: 20, hidden: true, hideMode: 'view', hideReason: 'other' }, 'manual:1': { height: 3 } };
      study.env = { loaded: true, loading: false, error: null, attribution: '' };
      // 地形・航空写真・地平線は Node では取れない（平地・写真なしで続く）
      const report = await loadEnvironment();
      expect(report.neighbors).toMatch(/^\d+$/);
      expect(report.terrain).toBe('flat');
      expect(study.neighborOverrides[target.id]).toEqual({ height: 20, hidden: true, hideMode: 'view', hideReason: 'other' });
      expect(study.neighborOverrides['plateau:35.25650:137.05450:80']).toBeUndefined();
      expect(study.neighborOverrides['manual:1']).toEqual({ height: 3 });
      expect(study.neighbors.filter((n) => n.source === 'manual').map((n) => n.id)).toEqual(['manual:1']);
      expect(study.neighbors.some((n) => n.id === target.id && n.mesh)).toBe(true);
      expect(study.env.plateau?.datasets[0].muniCd).toBe('23113');
      expect(study.env.plateau?.indexGenerated).toBe('2026-10-10');
      expect(study.neighborSources[0]).toBe('plateau');
      expect(study.neighborNotes[0]).toMatch(/^PLATEAU（国土交通省 3D都市モデル・愛知県名古屋市守山区/);
      // PLATEAU が取れなかった取り直しでは出典を消す
      vi.stubGlobal('fetch', mockFetch({ muniCd: '11201' }));
      await loadEnvironment();
      expect(study.env.plateau).toBeUndefined();
      expect(study.neighborSources).toEqual(['gsi']);
    } finally {
      setDracoDecoderFactory(null);
    }
  });
});
