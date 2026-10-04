import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyDistanceRule,
  buildNeighborMeshes,
  clipRingToRect,
  excludeOverlapping,
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
    for (const b of list) expect(b.id).toMatch(/^plateau:\d+\.\d{5}:\d+\.\d{5}$/);
  });
  it('リングは閉じる重複点を持たず、短すぎる辺が無い', () => {
    for (const b of list) {
      const a = b.ring[0];
      const z = b.ring[b.ring.length - 1];
      expect(Math.hypot(a.e - z.e, a.n - z.n)).toBeGreaterThanOrEqual(0.05);
      for (let i = 1; i < b.ring.length; i++) expect(Math.hypot(b.ring[i].e - b.ring[i - 1].e, b.ring[i].n - b.ring[i - 1].n)).toBeGreaterThanOrEqual(0.05);
    }
  });
  it('ピンのあるタイルなので建物はピンから 1 km 以内にある', () => {
    for (const b of list) {
      const c = ringCenter(b.ring);
      expect(Math.hypot(c.e, c.n)).toBeLessThan(1000);
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
