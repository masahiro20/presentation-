import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tileToLonLat, toLocal } from '../src/sun/geo';
import {
  applyDistanceRule,
  buildNeighborMeshes,
  clipRingToRect,
  excludeOverlapping,
  fetchNeighbors,
  fillGapsWithGsi,
  makeManualNeighbor,
  parseGsiTile,
  parsePlateauTile,
  ringCenter,
} from '../src/sunstudy/neighbors';
import type { Neighbor } from '../src/sunstudy/types';

const PIN = { lat: 35.681236, lon: 139.767125 };
const TILE = { x: 58208, y: 25807, z: 16 };
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const plateauBytes = fixture('plateau_16_58208_25807.pbf');
const gsiBytes = fixture('gsi_16_58208_25807.pbf');

const square = (e0: number, n0: number, size: number) => [
  { e: e0, n: n0 },
  { e: e0 + size, n: n0 },
  { e: e0 + size, n: n0 + size },
  { e: e0, n: n0 + size },
];
const nb = (ring: { e: number; n: number }[], height = 7, extra: Partial<Neighbor> = {}): Neighbor => ({ id: `t:${ring[0].e}:${ring[0].n}`, ring, height, source: 'gsi', heightKind: 'estimated', ...extra });

describe('PLATEAU タイルの読み込み', () => {
  const list = parsePlateauTile(plateauBytes, TILE.x, TILE.y, TILE.z, PIN.lat, PIN.lon);
  it('屋根面のポリゴンが取れる（2 m 未満は捨てる）', () => {
    expect(list.length).toBeGreaterThan(0);
    for (const b of list) {
      expect(b.height).toBeGreaterThanOrEqual(2);
      expect(b.source).toBe('plateau');
      expect(b.heightKind).toBe('measured');
      expect(b.ring.length).toBeGreaterThanOrEqual(3);
    }
  });
  it('id は決定的（2 回読んでも同じ）で重複しない', () => {
    const again = parsePlateauTile(plateauBytes, TILE.x, TILE.y, TILE.z, PIN.lat, PIN.lon);
    expect(again.map((b) => b.id)).toEqual(list.map((b) => b.id));
    expect(new Set(list.map((b) => b.id)).size).toBe(list.length);
    for (const b of list) expect(b.id).toMatch(/^plateau:\d+\.\d{5}:\d+\.\d{5}:\d+$/);
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
});

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
  it('PLATEAU と重なる建物は補完から除かれる', () => {
    const plateau = parsePlateauTile(plateauBytes, TILE.x, TILE.y, TILE.z, PIN.lat, PIN.lon);
    const fill = fillGapsWithGsi(plateau, list);
    expect(fill.length).toBeLessThan(list.length);
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

describe('fetchNeighbors（fetch をモック）', () => {
  // 取得先に関係なく同じタイルの中身を返す（タイル座標が違うので別の場所の建物になる）
  const center = tileToLonLat(TILE.x + 0.5, TILE.y + 0.5, TILE.z);
  const mockFetch = (plateau: number | 'reject', gsi: number | 'reject') =>
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const kind = url.includes('plateau-lod2-mvt') ? plateau : url.includes('optimal_bvmap') ? gsi : 'reject';
      if (kind === 'reject') throw new TypeError('fetch failed');
      const bytes = url.includes('plateau-lod2-mvt') ? plateauBytes : gsiBytes;
      return new Response(kind === 200 ? bytes : null, { status: kind });
    });
  afterEach(() => vi.unstubAllGlobals());

  it('PLATEAU の対象地域: PLATEAU を使い、国土地理院は隙間だけ補う', async () => {
    const f = mockFetch(200, 200);
    vi.stubGlobal('fetch', f);
    const msgs: string[] = [];
    const r = await fetchNeighbors(center.lat, center.lon, 300, { onProgress: (m) => msgs.push(m) });
    expect(r.list.length).toBeGreaterThan(0);
    expect(r.sourcesUsed[0]).toBe('plateau');
    expect(r.notes[0]).toMatch(/^PLATEAU（国土交通省 3D都市モデル・東京23区・2020年度）の実測の高さを使用（\d+ 棟）。$/);
    expect(new Set(r.list.map((b) => b.id)).size).toBe(r.list.length);
    expect(r.list.some((b) => b.source === 'plateau')).toBe(true);
    expect(msgs.some((m) => m.includes('PLATEAU'))).toBe(true);
    // 150 m 以上の建物は far か高層だけ
    for (const b of r.list as (Neighbor & { far?: boolean })[]) {
      const c = ringCenter(b.ring);
      const d = Math.hypot(c.e, c.n);
      if (d >= 150) {
        expect(b.far).toBe(true);
        expect(d - b.height * 6.9).toBeLessThan(60);
      } else expect(b.far).toBeUndefined();
    }
    // 2 回目も同じ id
    const r2 = await fetchNeighbors(center.lat, center.lon, 300, {});
    expect(r2.list.map((b) => b.id)).toEqual(r.list.map((b) => b.id));
  });

  it('PLATEAU が 404（対象外）なら国土地理院の推定で、注記が付く', async () => {
    vi.stubGlobal('fetch', mockFetch(404, 200));
    const r = await fetchNeighbors(center.lat, center.lon, 300, {});
    expect(r.list.length).toBeGreaterThan(0);
    expect(r.sourcesUsed).toEqual(['gsi']);
    expect(r.list.every((b) => b.source === 'gsi' && b.heightKind === 'estimated')).toBe(true);
    expect(r.notes[0]).toMatch(/PLATEAU の対象外/);
  });

  it('sources で PLATEAU を外せる', async () => {
    const f = mockFetch(200, 200);
    vi.stubGlobal('fetch', f);
    const r = await fetchNeighbors(center.lat, center.lon, 300, { sources: ['gsi'] });
    expect(r.sourcesUsed).toEqual(['gsi']);
    expect(f.mock.calls.every((c) => !String(c[0]).includes('plateau-lod2-mvt'))).toBe(true);
  });

  it('すべて失敗なら日本語のエラーを投げる', async () => {
    vi.stubGlobal('fetch', mockFetch('reject', 'reject'));
    await expect(fetchNeighbors(center.lat, center.lon, 300, {})).rejects.toThrow('周辺建物を取得できませんでした（インターネット接続を確認してください）');
  });

  it('中止された signal は中止の理由を投げる', async () => {
    vi.stubGlobal('fetch', mockFetch(200, 200));
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    await expect(fetchNeighbors(center.lat, center.lon, 300, { signal: ac.signal })).rejects.toThrow('cancelled');
  });
});
