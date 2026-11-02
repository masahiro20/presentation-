import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { decodeMvt } from '../src/sun/mvt';
import { roadSpec, gsiRoadWidth, gsiRoadsFromLayer, parseOsmStreets, buildStreets, type OsmEl } from '../src/sun/streets';

const LAT = 35.17035;
const LON = 136.88165;
const at = (e: number, n: number) => ({ lat: LAT + n / 111320, lon: LON + e / (111320 * Math.cos((LAT * Math.PI) / 180)) });

describe('街路（道路・緑地・樹木）', () => {
  it('OSM の道路の種類 → 幅。width・lanes タグが優先', () => {
    expect(roadSpec({ highway: 'residential' })).toEqual({ width: 5, kind: 'street' });
    expect(roadSpec({ highway: 'primary' })?.kind).toBe('major');
    expect(roadSpec({ highway: 'service' })?.kind).toBe('lane');
    expect(roadSpec({ highway: 'footway' })?.kind).toBe('path');
    expect(roadSpec({ highway: 'residential', width: '7.5' })).toEqual({ width: 7.5, kind: 'street' });
    expect(roadSpec({ highway: 'tertiary', lanes: '4' })?.width).toBe(13);
    expect(roadSpec({ highway: 'railway' })).toBeNull();
  });

  it('国土地理院の道路中心線の幅: vt_width は cm、無ければ幅員区分', () => {
    expect(gsiRoadWidth({ vt_width: 642 })).toBe(6.42);
    expect(gsiRoadWidth({ vt_rnkwidth: '5.5m-13m未満' })).toBe(8);
    expect(gsiRoadWidth({ vt_rnkwidth: '3m未満' })).toBe(2.5);
    expect(gsiRoadWidth({})).toBe(5);
  });

  it('Overpass の要素 → 道路・緑地・樹木（並木は 6m おき、閉じた面だけ緑地）', () => {
    const els: OsmEl[] = [
      { type: 'way' as const, tags: { highway: 'residential' }, geometry: [at(-30, 10), at(30, 10)] },
      { type: 'way' as const, tags: { natural: 'tree_row' }, geometry: [at(0, 20), at(30, 20)] },
      { type: 'node' as const, tags: { natural: 'tree', height: '9' }, lat: at(5, -5).lat, lon: at(5, -5).lon },
      { type: 'way' as const, tags: { leisure: 'park' }, geometry: [at(-50, -30), at(-20, -30), at(-20, -60), at(-50, -60), at(-50, -30)] },
      { type: 'way' as const, tags: { landuse: 'forest' }, geometry: [at(40, 40), at(60, 40), at(60, 60), at(40, 60), at(40, 40)] },
      { type: 'way' as const, tags: { leisure: 'park' }, geometry: [at(0, 0), at(10, 0), at(10, 10)] }, // 閉じていない
      { type: 'way' as const, tags: { highway: 'residential', tunnel: 'yes' }, geometry: [at(-30, 30), at(30, 30)] },
    ];
    const d = parseOsmStreets(els, LAT, LON, 140);
    expect(d.roads).toHaveLength(1);
    expect(d.roads[0].width).toBe(5);
    expect(d.trees.filter((t) => Math.abs(t.n - 20) < 0.5)).toHaveLength(6); // 0,6,…,30
    const single = d.trees.find((t) => Math.abs(t.height - 9) < 0.01)!;
    expect(single.e).toBeCloseTo(5, 0);
    expect(single.n).toBeCloseTo(-5, 0);
    expect(d.greens).toHaveLength(2);
    expect(d.greens.map((g) => g.wooded)).toEqual([false, true]);
  });

  it('メッシュ: 道路 5m 以上は白線、9m 以上は縁石と歩道、林は木を散らす。敷地の中には植えない', () => {
    const d = parseOsmStreets(
      [
        { type: 'way' as const, tags: { highway: 'primary' }, geometry: [at(-60, 10), at(60, 10)] },
        { type: 'way' as const, tags: { highway: 'service' }, geometry: [at(0, 10), at(0, 60)] },
        { type: 'node' as const, tags: { natural: 'tree' }, lat: at(0, 0).lat, lon: at(0, 0).lon }, // 敷地の中
        { type: 'node' as const, tags: { natural: 'tree' }, lat: at(30, -20).lat, lon: at(30, -20).lon },
        { type: 'way' as const, tags: { landuse: 'forest' }, geometry: [at(40, 40), at(70, 40), at(70, 70), at(40, 70), at(40, 40)] },
      ] as OsmEl[],
      LAT,
      LON,
      140,
    );
    const built = buildStreets(d, { toWorld: (e, n, y = 0) => new THREE.Vector3(e, y, -n), exclude: (p) => Math.abs(p.x) < 8 && Math.abs(p.z) < 8 });
    expect(built.counts.roads).toBe(2);
    expect(built.counts.greens).toBe(1);
    expect(built.counts.trees).toBeGreaterThan(5); // 単木 1 ＋ 林
    const g = built.mb.build(() => new THREE.MeshBasicMaterial());
    const keys = g.children.map((m) => m.name);
    expect(keys).toEqual(expect.arrayContaining(['l.road', 'l.roadLine', 'l.curb', 'l.block', 'l.far', 'l.trunk']));
    const leaves = built.leaves.build(() => new THREE.MeshBasicMaterial());
    expect(leaves.children.map((m) => m.name)).toEqual(['l.leafSpray']);
    // 敷地の中の木は植えない: 幹の頂点に |x|<8 かつ |z|<8 は無い
    const trunk = g.children.find((m) => m.name === 'l.trunk') as THREE.Mesh;
    const pos = trunk.geometry.getAttribute('position');
    let inside = 0;
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i)) < 7 && Math.abs(pos.getZ(i)) < 7) inside++;
    expect(inside).toBe(0);
  });

  const tile = '/tmp/claude-0/-home-user-presentation-/9143085c-23b2-58f5-8c36-8c5e9e06565a/scratchpad/gsi/tile.pbf';
  it.skipIf(!existsSync(tile))('国土地理院のタイル（名古屋市中村区）から道路が取れる', () => {
    const layers = decodeMvt(new Uint8Array(readFileSync(tile)));
    const roads = gsiRoadsFromLayer(layers['RdCL'], 57686, 25920, 16, LAT, LON, 140);
    expect(roads.length).toBeGreaterThan(10);
    expect(roads.every((r) => r.width >= 2 && r.width <= 45)).toBe(true);
    expect(roads.some((r) => r.kind === 'major')).toBe(true);
    // 建設地から 140m 以内の点を持つものだけ
    expect(roads.every((r) => r.pts.some((p) => Math.hypot(p.e, p.n) <= 182))).toBe(true);
  });
});
