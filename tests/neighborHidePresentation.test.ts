/**
 * 日照ステップ（プレゼン側）の「周辺建物を選んで隠す／戻す」のテスト:
 *  - 建物のキー（neighborKey）: 同じ建物は取り直し（ピンを動かした後も）で同じキー、違う建物は違うキー
 *  - 隠す記録の当て直し（reapplyEdits）: 取り直した一覧の同じ建物に当たる。キーがずれても外形で当たる。隣の建物には当たらない
 *  - 範囲選択（keysInRect）・外形の当たり判定（pickRingAt）
 *  - SunContext: 隠した建物は実体のメッシュを作らず（遮蔽物 buildOccluder に入らない）、薄い表示は影・解析に入らない。
 *    取り直し（loadNeighbors）の後も隠したまま、すべて戻す・周辺建物をすべて消すで記録が消える
 *  - 文言（隠した後の案内・一覧の見出し・選択の数）
 */
import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { metersPerDegree, siteLatLon, toLocal, type NeighborBuilding, type SiteLocation } from '../src/sun/geo';

// 周辺建物の取得はネットワークに出ないように差し替える（緯度・経度で決めた建物を、渡されたピンから測って返す）
const fake = vi.hoisted(() => ({ gsi: [] as { ll: { lat: number; lon: number }[]; height: number }[], osm: [] as { ll: { lat: number; lon: number }[]; height: number }[] }));
vi.mock('../src/sun/geo', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/sun/geo')>();
  const make = (src: 'gsi' | 'osm') => async (lat: number, lon: number): Promise<NeighborBuilding[]> =>
    fake[src].map((f) => ({ ring: f.ll.map((p) => mod.toLocal(p.lat, p.lon, lat, lon)), height: f.height, source: src }));
  return { ...mod, fetchGsiBuildings: vi.fn(make('gsi')), fetchOsmBuildings: vi.fn(make('osm')) };
});

import { GHOST_OPACITY, NEIGHBOR_SELECT_COLOR, SunContext, absoluteEN, emptyEdits, keysInRect, neighborKey, pickRingAt, reapplyEdits, ringArea, ringCentroid, sameFootprint, type LatLon } from '../src/sun/context';
import { buildOccluder } from '../src/sun/analysis';
import { ALIGN_COLORS } from '../src/sun/align';
import { hiddenListTitle, hiddenToastText, neighborTitle, neighborWhere, restoredToastText, selectionText } from '../src/app/steps/sunStep';
import type { Viewer } from '../src/scene/viewer';

const PIN: LatLon = { lat: 35.6045, lon: 139.6689 };
const { mLat, mLon } = metersPerDegree(PIN.lat);
/** PIN から東 e・北 n (m) の緯度・経度 */
const ll = (e: number, n: number) => ({ lat: PIN.lat + n / mLat, lon: PIN.lon + e / mLon });
/** 緯度・経度で決めた長方形の建物（東 e0〜e0+w、北 n0〜n0+d） */
const rectLL = (e0: number, n0: number, w: number, d: number) => [ll(e0, n0), ll(e0 + w, n0), ll(e0 + w, n0 + d), ll(e0, n0 + d)];
/** 緯度・経度の外形を、地点 origin から測った建物にする（取得したときの形） */
const fetched = (lls: { lat: number; lon: number }[], origin: LatLon, source: NeighborBuilding['source'] = 'gsi', height = 6.8): NeighborBuilding => ({
  ring: lls.map((p) => toLocal(p.lat, p.lon, origin.lat, origin.lon)),
  height,
  source,
});
/** ピンを東 de・北 dn (m) 動かした地点（建設地の微調整・敷地をクリック） */
const moved = (de: number, dn: number): LatLon => siteLatLon({ lat: PIN.lat, lon: PIN.lon, address: '', offsetE: de, offsetN: dn });

describe('neighborKey: 同じ建物か', () => {
  const A = rectLL(12.3, -20.6, 9.4, 7.7);
  it('同じ外形を同じ地点で 2 回取得 → 同じキー', () => {
    expect(neighborKey(fetched(A, PIN), PIN)).toBe(neighborKey(fetched(A, PIN), PIN));
  });
  it('ピンを動かしてから取り直しても（2 m・40 m・斜め）同じキー', () => {
    const k0 = neighborKey(fetched(A, PIN), PIN);
    for (const [de, dn] of [
      [0, 2],
      [2, 0],
      [-2, 0],
      [0, -2],
      [37.5, -18.2],
      [-3.3, 41.7],
    ]) {
      const o = moved(de, dn);
      expect(neighborKey(fetched(A, o), o)).toBe(k0);
    }
  });
  it('点の並び（始点・閉じた点の重なり）が違っても同じキー', () => {
    const b = fetched(A, PIN);
    const rotated = { ...b, ring: [...b.ring.slice(2), ...b.ring.slice(0, 2)] };
    const closed = { ...b, ring: [...b.ring, b.ring[0]] };
    expect(neighborKey(rotated, PIN)).toBe(neighborKey(b, PIN));
    expect(neighborKey(closed, PIN)).toBe(neighborKey(b, PIN));
  });
  it('違う建物は違うキー（隣の建物・大きさ違い・出典違い）', () => {
    const k = neighborKey(fetched(A, PIN), PIN);
    expect(neighborKey(fetched(rectLL(22.3, -20.6, 9.4, 7.7), PIN), PIN)).not.toBe(k); // 東隣
    expect(neighborKey(fetched(rectLL(12.3, -20.6, 9.4, 9.7), PIN), PIN)).not.toBe(k); // 奥行き違い
    expect(neighborKey(fetched(A, PIN, 'osm'), PIN)).not.toBe(k);
  });
  it('手動の隣家は番号で区別（同じ場所・大きさでも別の建物）', () => {
    const ring = [
      { e: -4, n: 5 },
      { e: 4, n: 5 },
      { e: 4, n: 13 },
      { e: -4, n: 13 },
    ];
    const a = neighborKey({ ring, source: 'manual', id: 'manual-1' });
    const b = neighborKey({ ring, source: 'manual', id: 'manual-2' });
    expect(a).toBe('manual:manual-1');
    expect(b).not.toBe(a);
    // 手動の隣家は地点によらない（建物に付いて動く）
    expect(neighborKey({ ring, source: 'manual', id: 'manual-1' }, moved(30, 30))).toBe(a);
  });
  it('重心は面積で重み付け（点が偏っていても形の中心）', () => {
    const ring = [
      { e: 0, n: 0 },
      { e: 5, n: 0 },
      { e: 10, n: 0 },
      { e: 10, n: 4 },
      { e: 0, n: 4 },
    ];
    expect(ringCentroid(ring).e).toBeCloseTo(5, 9);
    expect(ringCentroid(ring).n).toBeCloseTo(2, 9);
    expect(ringArea(ring)).toBeCloseTo(40, 9);
  });
});

/** SunContext.setHidden と同じ記録の付け方（キー + 地点によらない外形） */
const recordHide = (edits: ReturnType<typeof emptyEdits>, b: NeighborBuilding, origin: LatLon) => {
  const k = neighborKey(b, origin);
  edits.hidden.add(k);
  edits.footprints.set(
    k,
    b.ring.map((p) => absoluteEN(p, origin)),
  );
  return k;
};
const absFp = (origin: LatLon) => (b: NeighborBuilding) => (b.source === 'manual' ? null : b.ring.map((p) => absoluteEN(p, origin)));

describe('reapplyEdits: 取り直した一覧に隠す記録を当て直す', () => {
  const blocks = [rectLL(12, -20, 9, 8), rectLL(21, -20, 8, 8), rectLL(-15, 10, 10, 9), rectLL(-30, -25, 14, 11)];
  it('隠した建物は取り直し（ピンを動かした後）も隠したまま、戻した建物は戻ったまま', () => {
    const list1 = blocks.map((b) => fetched(b, PIN));
    const edits = emptyEdits();
    recordHide(edits, list1[0], PIN);
    recordHide(edits, list1[2], PIN);
    const o2 = moved(2, -2);
    const list2 = blocks.map((b) => fetched(b, o2));
    const n = reapplyEdits(list2, (b) => neighborKey(b, o2), absFp(o2), edits);
    expect(n).toBe(2);
    expect(list2.map((b) => !!b.hidden)).toEqual([true, false, true, false]);
    // 1 棟戻す → もう一度取り直しても戻ったまま
    edits.hidden.delete(neighborKey(list2[2], o2));
    const o3 = moved(-5, 7);
    const list3 = blocks.map((b) => fetched(b, o3));
    reapplyEdits(list3, (b) => neighborKey(b, o3), absFp(o3), edits);
    expect(list3.map((b) => !!b.hidden)).toEqual([true, false, false, false]);
  });
  it('キーがずれても（外形が 0.3 m 動いた・丸めの境目）外形で同じ建物に当て、記録のキーを付け替える', () => {
    const list1 = blocks.map((b) => fetched(b, PIN));
    const edits = emptyEdits();
    const k0 = recordHide(edits, list1[3], PIN);
    edits.heights.set(k0, 9.5);
    // 0.3 m ずれて、面積も少し違う（データの更新・別の出典で外形がわずかに違う）
    const shifted = blocks.map((b, i) => (i === 3 ? rectLL(-29.7, -24.8, 13.6, 11) : b));
    const list2 = shifted.map((b) => fetched(b, PIN));
    const k1 = neighborKey(list2[3], PIN);
    expect(k1).not.toBe(k0);
    reapplyEdits(list2, (b) => neighborKey(b, PIN), absFp(PIN), edits);
    expect(list2.map((b) => !!b.hidden)).toEqual([false, false, false, true]);
    expect(edits.hidden.has(k1)).toBe(true);
    expect(edits.hidden.has(k0)).toBe(false);
    expect(edits.heights.get(k1)).toBe(9.5);
  });
  it('国土地理院で隠した建物は、OSM で取り直しても（外形が少し違っても）隠したまま', () => {
    const edits = emptyEdits();
    recordHide(edits, fetched(blocks[0], PIN, 'gsi'), PIN);
    const osm = [fetched(rectLL(12.4, -19.7, 8.6, 7.5), PIN, 'osm'), fetched(blocks[1], PIN, 'osm')];
    reapplyEdits(osm, (b) => neighborKey(b, PIN), absFp(PIN), edits);
    expect(osm.map((b) => !!b.hidden)).toEqual([true, false]);
  });
  it('壁を接する隣の建物・大きさが大きく違う建物には当てない', () => {
    expect(sameFootprint(fetched(blocks[0], PIN).ring, fetched(blocks[1], PIN).ring)).toBe(false);
    expect(sameFootprint(fetched(blocks[0], PIN).ring, fetched(rectLL(12, -20, 18, 8), PIN).ring)).toBe(false);
    expect(sameFootprint(fetched(blocks[0], PIN).ring, fetched(rectLL(12.2, -19.9, 9, 8), PIN).ring)).toBe(true);
  });
  it('手動の隣家はキー（番号）だけで当てる', () => {
    const ring = [
      { e: -4, n: 5 },
      { e: 4, n: 5 },
      { e: 4, n: 13 },
      { e: -4, n: 13 },
    ];
    const m1: NeighborBuilding = { ring, height: 7, source: 'manual', id: 'manual-1' };
    const m2: NeighborBuilding = { ring, height: 7, source: 'manual', id: 'manual-2' };
    const edits = emptyEdits();
    edits.hidden.add(neighborKey(m1));
    reapplyEdits([m1, m2], (b) => neighborKey(b), () => null, edits);
    expect([m1.hidden, m2.hidden]).toEqual([true, false]);
  });
});

describe('範囲選択・外形の当たり判定', () => {
  const pts = [
    { key: 'a', x: 100, y: 100 },
    { key: 'b', x: 200, y: 150 },
    { key: 'c', x: 400, y: 400 },
    { key: 'b', x: 210, y: 160 },
    { key: 'd', x: NaN, y: NaN }, // カメラの後ろ
  ];
  it('長方形に中心が入る建物（どちら向きのドラッグでも同じ・重複なし・投影できない点は除く）', () => {
    expect(keysInRect(pts, { x: 90, y: 90 }, { x: 250, y: 200 }).sort()).toEqual(['a', 'b']);
    expect(keysInRect(pts, { x: 250, y: 200 }, { x: 90, y: 90 }).sort()).toEqual(['a', 'b']);
    expect(keysInRect(pts, { x: 250, y: 90 }, { x: 90, y: 200 }).sort()).toEqual(['a', 'b']);
    expect(keysInRect(pts, { x: 0, y: 0 }, { x: 1000, y: 1000 }).sort()).toEqual(['a', 'b', 'c']);
    expect(keysInRect(pts, { x: 500, y: 500 }, { x: 600, y: 600 })).toEqual([]);
  });
  it('点を含む外形のうち、いちばん小さいもの', () => {
    const sq = (e0: number, n0: number, s: number) => [
      { e: e0, n: n0 },
      { e: e0 + s, n: n0 },
      { e: e0 + s, n: n0 + s },
      { e: e0, n: n0 + s },
    ];
    const items = [
      { key: 'big', ring: sq(0, 0, 20) },
      { key: 'small', ring: sq(5, 5, 4) },
      { key: 'far', ring: sq(50, 50, 4) },
    ];
    expect(pickRingAt(items, { e: 6, n: 6 })).toBe('small');
    expect(pickRingAt(items, { e: 15, n: 15 })).toBe('big');
    expect(pickRingAt(items, { e: 30, n: 30 })).toBeNull();
  });
});

// ---------------------------------------------------------------- SunContext（偽の Viewer）

function fakeViewer(): Viewer {
  const g = () => new THREE.Group();
  const groups = { building: g(), roof: g(), furniture: g(), landscape: g(), lights: g(), external: g(), context: g(), overlay: g() };
  const scene = new THREE.Scene();
  for (const x of Object.values(groups)) scene.add(x);
  const camera = new THREE.PerspectiveCamera(45, 1.6, 0.1, 2000);
  camera.position.set(0, 150, 0.01);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return {
    state: {
      meta: { bbox: new THREE.Box3(new THREE.Vector3(-5, 0, -4), new THREE.Vector3(5, 7, 4)), outlines: [], rooms: [] },
      model: { northAngleDeg: 0 },
      site: { min: { x: -8, y: -7 }, max: { x: 8, y: 7 } },
    },
    groups,
    userData: {},
    camera,
    invalidate() {},
  } as unknown as Viewer;
}
const SITE: SiteLocation = { lat: PIN.lat, lon: PIN.lon, address: '世田谷区奥沢', offsetE: 0, offsetN: 0 };
const neighborMeshes = (v: Viewer) => {
  let n = 0;
  v.groups.context.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.userData.neighbor) n++;
  });
  return n;
};

describe('SunContext: 隠す・戻す・取り直し', () => {
  beforeEach(() => {
    fake.gsi = [
      { ll: rectLL(12, -20, 9, 8), height: 6.8 },
      { ll: rectLL(21, -20, 8, 8), height: 6.8 },
      { ll: rectLL(-15, 10, 10, 9), height: 12 },
      { ll: rectLL(-30, -25, 14, 11), height: 6.8 },
      { ll: rectLL(-2, -2, 4, 4), height: 6.8 }, // 敷地の中（建て替え前の既存建物）→ 取り込まない
    ];
    fake.osm = [{ ll: rectLL(12.3, -19.8, 8.7, 7.6), height: 9.4 }];
  });

  it('隠した建物は実体を作らず、遮蔽物（buildOccluder）にも入らない。薄い表示は影・解析に入らない', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    expect(await sc.loadNeighbors('gsi')).toBe(4);
    expect(neighborMeshes(v)).toBe(4);
    const tri0 = buildOccluder(v).triangles;
    const keys = sc.state.neighbors.map((b) => sc.keyOf(b));
    expect(new Set(keys).size).toBe(4);
    expect(sc.state.neighbors.every((b) => typeof b.id === 'string')).toBe(true);
    expect(sc.setHidden([keys[0], keys[2]], true)).toBe(2);
    expect(neighborMeshes(v)).toBe(2);
    expect(sc.hiddenList().length).toBe(2);
    const tri1 = buildOccluder(v).triangles;
    expect(tri1).toBeLessThan(tri0);
    // 「建物を選んで隠す」の間の薄い表示
    sc.setGhosts(true);
    expect(buildOccluder(v).triangles).toBe(tri1);
    const ghosts = sc.ghostGroup.children as THREE.Mesh[];
    expect(ghosts.length).toBe(2);
    for (const m of ghosts) {
      const mat = m.material as THREE.MeshStandardMaterial;
      expect(m.visible).toBe(true);
      expect(mat.opacity).toBe(GHOST_OPACITY);
      expect(mat.transparent).toBe(true);
      expect(mat.depthWrite).toBe(false);
      expect(m.castShadow).toBe(false);
      expect(m.userData.noShadow).toBe(true);
      expect(m.userData.neighbor).toBeUndefined();
      expect(keys).toContain(m.userData.neighborKey);
    }
    sc.setGhosts(false);
    expect(ghosts.every((m) => !m.visible)).toBe(true);
    // 実体のメッシュはキーを持つ（クリックで拾う）
    expect((sc.neighborGroup.children as THREE.Mesh[]).map((m) => m.userData.neighborKey).sort()).toEqual([keys[1], keys[3]].sort());
  });

  it('選んだ建物はオレンジ（2 点合わせの航空写真側と同じ色）', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('gsi');
    const k = sc.keyOf(sc.state.neighbors[1]);
    sc.setHighlight([k]);
    const m = (sc.neighborGroup.children as THREE.Mesh[]).find((x) => x.userData.neighborKey === k)!;
    const mats = m.material as THREE.MeshStandardMaterial[];
    expect(NEIGHBOR_SELECT_COLOR).toBe(ALIGN_COLORS.target);
    expect('#' + mats[0].color.getHexString()).toBe('#e5531f');
    sc.setHighlight([]);
    expect(m.material).toBe(m.userData.baseMaterial);
  });

  it('取り直し（ピンを動かした後・国土地理院 → OSM）でも同じ建物は隠したまま。すべて戻す・すべて消すで記録が消える', async () => {
    const v = fakeViewer();
    const site = { ...SITE };
    const sc = new SunContext(v, site);
    await sc.loadNeighbors('gsi');
    const k0 = sc.keyOf(sc.state.neighbors[0]);
    sc.setHidden([k0], true);
    sc.setHeight(sc.keyOf(sc.state.neighbors[3]), 15);
    // 建設地を北へ 2 m（微調整）→ 取り直し
    sc.state.site = { ...site, offsetN: 2 };
    expect(await sc.loadNeighbors('gsi')).toBe(4);
    expect(sc.hiddenList().length).toBe(1);
    expect(sc.keyOf(sc.hiddenList()[0])).toBe(k0);
    expect(neighborMeshes(v)).toBe(3);
    expect(sc.heightOf(sc.state.neighbors[3])).toBe(15);
    // 手動の隣家を足して隠す → 取り直しても隠したまま
    sc.addManualNeighbor(180, 12, 8, 8, 7);
    const km = sc.keyOf(sc.state.neighbors[sc.state.neighbors.length - 1]);
    expect(km.startsWith('manual:')).toBe(true);
    sc.setHidden([km], true);
    await sc.loadNeighbors('gsi');
    expect(sc.hiddenList().map((b) => sc.keyOf(b)).sort()).toEqual([k0, km].sort());
    // OSM で取り直し: 外形が少し違う同じ建物も隠したまま
    await sc.loadNeighbors('osm');
    expect(sc.state.neighbors.filter((b) => b.source === 'osm').map((b) => !!b.hidden)).toEqual([true]);
    // すべて戻す
    expect(sc.restoreAll()).toBe(2);
    expect(sc.hiddenKeys.size).toBe(0);
    await sc.loadNeighbors('gsi');
    expect(sc.hiddenList().length).toBe(0);
    // すべて消す: 記録も消える
    sc.setHidden([sc.keyOf(sc.state.neighbors[1])], true);
    sc.clearNeighbors();
    expect(sc.hiddenKeys.size).toBe(0);
    expect(sc.edits.heights.size).toBe(0);
    expect(sc.state.neighbors.length).toBe(0);
  });

  it('高さを直すと影の形（遮蔽物の高さ）も変わり、元に戻せる', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('gsi');
    const b = sc.state.neighbors[0];
    const k = sc.keyOf(b);
    const top = () => {
      const m = (sc.neighborGroup.children as THREE.Mesh[]).find((x) => x.userData.neighborKey === k)!;
      m.geometry.computeBoundingBox();
      return m.geometry.boundingBox!.max.y;
    };
    expect(top()).toBeCloseTo(6.8, 6);
    sc.setHeight(k, 18);
    expect(top()).toBeCloseTo(18, 6);
    expect(b.height).toBe(6.8);
    sc.setHeight(k, null);
    expect(top()).toBeCloseTo(6.8, 6);
  });

  it('pickNeighbor: 真上から見て建物の中心をクリック → その建物。隠した建物は薄く表示している間だけ拾う', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('gsi');
    const b = sc.state.neighbors[2];
    const k = sc.keyOf(b);
    const c = ringCentroid(b.ring);
    const ndc = () => {
      const p = sc.toWorld(c.e, c.n, sc.heightOf(b)).project(v.camera);
      return new THREE.Vector2(p.x, p.y);
    };
    expect(sc.pickNeighbor(ndc())).toEqual({ key: k, hidden: false });
    sc.setHidden([k], true);
    expect(sc.pickNeighbor(ndc())).toBeNull();
    sc.setGhosts(true);
    expect(sc.pickNeighbor(ndc())).toEqual({ key: k, hidden: true });
    // 範囲選択の対象: 薄く表示している間は隠した建物も
    expect(sc.selectableCentroids().map((x) => x.key)).toContain(k);
    sc.setGhosts(false);
    expect(sc.selectableCentroids().map((x) => x.key)).not.toContain(k);
  });
});

describe('文言', () => {
  it('隠した後の案内・戻した後・一覧の見出し・選択の数', () => {
    expect(hiddenToastText(3)).toBe('3 棟を隠しました（影・解析からも外しています。「隠した建物」から戻せます）');
    expect(restoredToastText(1)).toMatch(/^1 棟を戻しました/);
    expect(hiddenListTitle(2)).toBe('隠した建物（2 棟）');
    expect(selectionText(3, 0)).toBe('選択 3 棟');
    expect(selectionText(2, 1)).toBe('選択 3 棟（うち隠した建物 1 棟）');
  });
  it('建物の名前・方角と距離', () => {
    expect(neighborTitle({ source: 'gsi' })).toBe('国土地理院の建物');
    expect(neighborTitle({ source: 'osm', label: '奥沢小学校' })).toBe('奥沢小学校');
    expect(neighborTitle({ source: 'manual', label: '隣家' })).toBe('隣家');
    const sq = (e: number, n: number) => [
      { e: e - 2, n: n - 2 },
      { e: e + 2, n: n - 2 },
      { e: e + 2, n: n + 2 },
      { e: e - 2, n: n + 2 },
    ];
    expect(neighborWhere({ ring: sq(0, -12) })).toBe('南 約 12 m');
    expect(neighborWhere({ ring: sq(10, 10) })).toBe('北東 約 14 m');
  });
});
