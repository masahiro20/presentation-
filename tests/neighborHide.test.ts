// 周辺建物を選んで隠す／戻す: 範囲選択・輪郭の当たり判定（凹形を含む）・選択の操作・隠した建物の状態とプロジェクトの往復
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bakeWorldTriangles } from '../src/sun/analysis';
import { buildNeighborGhosts, ghostMaterial, hiddenNeighborsForScene, neighborsForScene, siteExcludedCount } from '../src/sunstudy/environment';
import {
  addSelection,
  footprintCentroid,
  hitRingAt,
  idsInRect,
  normRect,
  pointInPolygon,
  polygonAreaAbs,
  rectIsTiny,
  splitSelection,
  toggleSelection,
} from '../src/sunstudy/neighborSelect';
import { buildNeighborMeshes, neighborId } from '../src/sunstudy/neighbors';
import { applyProject, serializeProject } from '../src/sunstudy/project';
import { effectiveNeighbors, hiddenNeighbors, on, restoreAllNeighbors, setNeighborsHidden, study, visibleNeighbors } from '../src/sunstudy/state';
import { frameFromLocal } from '../src/sunstudy/types';
import type { Neighbor } from '../src/sunstudy/types';

const FRAME = { lat: 35.6, lon: 139.6, address: 'テスト', groundElev: 10 };

const square = (e0: number, n0: number, size: number) => [
  { e: e0, n: n0 },
  { e: e0 + size, n: n0 },
  { e: e0 + size, n: n0 + size },
  { e: e0, n: n0 + size },
];
const nb = (id: string, ring: { e: number; n: number }[], extra: Partial<Neighbor> = {}): Neighbor => ({ id, ring, height: 7, source: 'gsi', heightKind: 'estimated', ...extra });

/** L 字（凹形）: 10×10 の正方形から北東の 5×5 を欠いたもの（画面座標でも同じ形として使う） */
const L_SHAPE = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 5 },
  { x: 5, y: 5 },
  { x: 5, y: 10 },
  { x: 0, y: 10 },
];

describe('範囲選択（画面の矩形に代表点が入る建物）', () => {
  const items = [
    { id: 'a', x: 10, y: 10, inFront: true },
    { id: 'b', x: 50, y: 40, inFront: true },
    { id: 'c', x: 100, y: 100, inFront: true },
    { id: 'behind', x: 20, y: 20, inFront: false },
    { id: 'nan', x: NaN, y: 20, inFront: true },
  ];
  it('どの向きにドラッグしても同じ矩形になる', () => {
    expect(normRect({ x: 60, y: 50 }, { x: 0, y: 0 })).toEqual({ x0: 0, y0: 0, x1: 60, y1: 50 });
    expect(normRect({ x: 0, y: 50 }, { x: 60, y: 0 })).toEqual({ x0: 0, y0: 0, x1: 60, y1: 50 });
  });
  it('矩形の中（境界を含む）の代表点だけを選び、カメラの後ろ・NaN は選ばない', () => {
    expect(idsInRect(items, normRect({ x: 0, y: 0 }, { x: 60, y: 50 }))).toEqual(['a', 'b']);
    // 境界ちょうど
    expect(idsInRect(items, { x0: 50, y0: 40, x1: 100, y1: 100 })).toEqual(['b', 'c']);
    // 何も無い所
    expect(idsInRect(items, { x0: 200, y0: 200, x1: 300, y1: 300 })).toEqual([]);
    // 後ろの点は投影が画面内でも選ばない
    expect(idsInRect(items, { x0: 15, y0: 15, x1: 25, y1: 25 })).toEqual([]);
  });
  it('3 px 未満のドラッグはクリック扱い', () => {
    expect(rectIsTiny({ x0: 0, y0: 0, x1: 2, y1: 2.9 })).toBe(true);
    expect(rectIsTiny({ x0: 0, y0: 0, x1: 2, y1: 3 })).toBe(false);
    expect(rectIsTiny({ x0: 0, y0: 0, x1: 40, y1: 1 })).toBe(false);
  });
});

describe('輪郭の当たり判定（地図・画面の多角形）', () => {
  it('凸形・凹形（L 字）の内外', () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];
    expect(pointInPolygon({ x: 2, y: 2 }, sq)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 2 }, sq)).toBe(false);
    // L 字: 欠けた角（7.5, 7.5）は外、腕の中は内
    expect(pointInPolygon({ x: 7.5, y: 7.5 }, L_SHAPE)).toBe(false);
    expect(pointInPolygon({ x: 7.5, y: 2.5 }, L_SHAPE)).toBe(true);
    expect(pointInPolygon({ x: 2.5, y: 7.5 }, L_SHAPE)).toBe(true);
    expect(polygonAreaAbs(L_SHAPE)).toBeCloseTo(75, 9);
  });
  it('hitRingAt: 内側なら id、重なっていれば小さい方、凹みの中は外（許容の距離より離れていれば null）', () => {
    const big = { id: 'big', ring: [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }] };
    const L = { id: 'L', ring: L_SHAPE };
    expect(hitRingAt({ x: 2.5, y: 7.5 }, [L])).toBe('L');
    // 大きな輪郭の中に L 字がある: L 字の中なら L、L 字の凹みの中なら big
    expect(hitRingAt({ x: 2.5, y: 2.5 }, [big, L])).toBe('L');
    expect(hitRingAt({ x: 8, y: 8 }, [big, L])).toBe('big');
    // 凹みの奥（どの辺からも 2.5 px 以上）: L 字だけなら外れ
    expect(hitRingAt({ x: 8, y: 8 }, [L], 2)).toBeNull();
    // 辺の近く（許容 4 px 以内）なら外側でも当たる
    expect(hitRingAt({ x: 12, y: 2 }, [L], 4)).toBe('L');
    expect(hitRingAt({ x: 15, y: 2 }, [L], 4)).toBeNull();
    // 点が足りない輪郭は無視
    expect(hitRingAt({ x: 0, y: 0 }, [{ id: 'x', ring: [{ x: 0, y: 0 }] }], 0)).toBeNull();
  });
  it('足跡の重心は面積の重み付き（L 字）、面積 0 なら頂点の平均', () => {
    const c = footprintCentroid(square(10, 20, 4));
    expect(c.e).toBeCloseTo(12, 9);
    expect(c.n).toBeCloseTo(22, 9);
    // L 字（10×10 から 5×5 を欠く）の重心: (75 個の単位正方形の平均) = (4.1667, 4.1667)
    const l = footprintCentroid(L_SHAPE.map((p) => ({ e: p.x, n: p.y })));
    expect(l.e).toBeCloseTo(25 / 6, 6);
    expect(l.n).toBeCloseTo(25 / 6, 6);
    expect(footprintCentroid([{ e: 0, n: 0 }, { e: 2, n: 0 }, { e: 4, n: 0 }])).toEqual({ e: 2, n: 0 });
  });
});

describe('選択の操作', () => {
  it('クリックは切り替え、範囲は追加、隠す／戻すの対象に分ける', () => {
    let sel = toggleSelection(new Set(), ['a']);
    expect([...sel]).toEqual(['a']);
    sel = toggleSelection(sel, ['a', 'b']);
    expect([...sel]).toEqual(['b']);
    sel = addSelection(sel, ['b', 'c', 'g1']);
    expect([...sel].sort()).toEqual(['b', 'c', 'g1']);
    const s = splitSelection(new Set([...sel, 'gone']), new Set(['b', 'c']), new Set(['g1']));
    expect(s.toHide.sort()).toEqual(['b', 'c']);
    expect(s.toRestore).toEqual(['g1']);
  });
  it('建物の id（隠した記録の鍵）はピンを動かして取り直しても同じ建物なら同じ（中心の緯度経度と面積）', () => {
    const pinA = { lat: 35.601929, lon: 139.67363 };
    const ring = square(12.3, -7.8, 9);
    // ピンを東へ 40 m・北へ 25 m 動かした所から見た同じ建物
    const pinB = frameFromLocal(pinA, 40, 25);
    const ringB = ring.map((p) => ({ e: p.e - 40, n: p.n - 25 }));
    expect(neighborId('plateau', ringB, pinB.lat, pinB.lon)).toBe(neighborId('plateau', ring, pinA.lat, pinA.lon));
    // 別の建物（大きさが違う）は別の id
    expect(neighborId('plateau', square(12.3, -7.8, 6), pinA.lat, pinA.lon)).not.toBe(neighborId('plateau', ring, pinA.lat, pinA.lon));
  });
});

// ---------------------------------------------------------------------------

describe('隠した建物の状態（state）', () => {
  let events = 0;
  let off: (() => void) | null = null;
  beforeEach(() => {
    study.frame = { ...FRAME };
    study.sitePolygon = [];
    study.model = null;
    study.points = [];
    study.neighborOverrides = {};
    study.neighbors = [nb('auto1', square(20, 0, 8)), nb('auto2', square(-30, 0, 8), { source: 'plateau', heightKind: 'measured', height: 12 }), nb('auto3', square(0, 30, 8)), nb('manual1', square(0, -25, 6), { source: 'manual', heightKind: 'manual', label: '隣家（南）' })];
    events = 0;
    off = on('neighbors', () => events++);
  });
  afterEach(() => {
    off?.();
    off = null;
  });

  it('setNeighborsHidden: 自動取得は上書きに、手動は本体に書き、まとめて 1 回だけ発火する', () => {
    expect(hiddenNeighbors()).toEqual([]);
    const k = setNeighborsHidden(['auto1', 'manual1', 'nope'], true);
    expect(k).toBe(2);
    expect(events).toBe(1);
    // 隠し方・理由を省くと「計算から除外」「その他」で書く
    expect(study.neighborOverrides.auto1).toEqual({ hidden: true, hideMode: 'exclude', hideReason: 'other' });
    // 手動の隣家は消さずに隠す（戻せる）
    const m = study.neighbors.find((n) => n.id === 'manual1')!;
    expect(m.hidden).toBe(true);
    expect(study.neighborOverrides.manual1).toBeUndefined();
    expect(hiddenNeighbors().map((n) => n.id).sort()).toEqual(['auto1', 'manual1']);
    expect(visibleNeighbors().map((n) => n.id).sort()).toEqual(['auto2', 'auto3']);
    // 3D・影・解析に使う一覧からも外れる
    expect(neighborsForScene(null).map((n) => n.id).sort()).toEqual(['auto2', 'auto3']);
    // 変化が無ければ発火しない
    expect(setNeighborsHidden(['auto1'], true)).toBe(0);
    expect(events).toBe(1);
  });

  it('戻すと上書きの hidden を外し、高さの上書きは残す。restoreAllNeighbors は 1 回だけ発火', () => {
    study.neighborOverrides.auto2 = { height: 15 };
    setNeighborsHidden(['auto1', 'auto2', 'auto3', 'manual1'], true);
    expect(events).toBe(1);
    expect(study.neighborOverrides.auto2).toEqual({ height: 15, hidden: true, hideMode: 'exclude', hideReason: 'other' });
    // 隠した建物も高さの上書きを反映して見せる
    expect(hiddenNeighbors().find((n) => n.id === 'auto2')?.height).toBe(15);
    expect(setNeighborsHidden(['auto3'], false)).toBe(1);
    expect(events).toBe(2);
    expect(study.neighborOverrides.auto3).toBeUndefined();
    expect(restoreAllNeighbors()).toBe(3);
    expect(events).toBe(3);
    expect(hiddenNeighbors()).toEqual([]);
    expect(study.neighborOverrides).toEqual({ auto2: { height: 15 } });
    expect(study.neighbors.find((n) => n.id === 'manual1')!.hidden).toBeUndefined();
    expect(visibleNeighbors()).toHaveLength(4);
    // 何も隠していなければ発火しない
    expect(restoreAllNeighbors()).toBe(0);
    expect(events).toBe(3);
  });

  it('元データで隠れている建物を戻すときは hidden: false で上書きする', () => {
    study.neighbors[0].hidden = true;
    expect(hiddenNeighbors().map((n) => n.id)).toEqual(['auto1']);
    expect(setNeighborsHidden(['auto1'], false)).toBe(1);
    expect(study.neighborOverrides.auto1).toEqual({ hidden: false });
    expect(effectiveNeighbors().find((n) => n.id === 'auto1')!.hidden).toBe(false);
  });

  it('敷地に重なる自動取得の建物は隠さなくても自動で外れ、隠した一覧の 3D 表示にも出ない', () => {
    // auto1（東 20〜28 m）を覆う敷地
    study.sitePolygon = square(18, -2, 12).map((p) => frameFromLocal(FRAME, p.e, p.n));
    expect(siteExcludedCount(null)).toBe(1);
    expect(neighborsForScene(null).map((n) => n.id).sort()).toEqual(['auto2', 'auto3', 'manual1']);
    setNeighborsHidden(['auto1', 'auto3'], true);
    expect(hiddenNeighborsForScene(null).map((n) => n.id)).toEqual(['auto3']);
    expect(siteExcludedCount(null)).toBe(0);
  });

  it('プロジェクト JSON の往復で、隠した自動取得の建物と隠した手動の隣家が戻る', async () => {
    study.env = { loaded: true, loading: false, error: null, attribution: '' };
    study.grid = null;
    study.aerial = null;
    study.horizon = null;
    setNeighborsHidden(['auto2', 'manual1'], true);
    const json = JSON.parse(JSON.stringify(serializeProject()));
    expect(json.neighborOverrides.auto2).toEqual({ hidden: true, hideMode: 'exclude', hideReason: 'other' });
    expect(json.manualNeighbors[0].hidden).toBe(true);
    expect(json.env.neighbors.map((n: Neighbor) => n.id).sort()).toEqual(['auto1', 'auto2', 'auto3']);
    // 別の状態にしてから開く
    restoreAllNeighbors();
    study.neighbors = [];
    study.neighborOverrides = {};
    await applyProject(json);
    expect(hiddenNeighbors().map((n) => n.id).sort()).toEqual(['auto2', 'manual1']);
    expect(visibleNeighbors().map((n) => n.id).sort()).toEqual(['auto1', 'auto3']);
    // 開いた後も戻せる
    expect(restoreAllNeighbors()).toBe(2);
    expect(visibleNeighbors()).toHaveLength(4);
  });
});

describe('隠した建物の半透明の表示は解析に入らない', () => {
  it('buildNeighborGhosts: 25 %・深度を書かない・影なし・noShadow / overlay で、焼き込む三角形は 0', () => {
    study.frame = { ...FRAME };
    study.grid = null;
    const list = [nb('g1', square(0, 0, 6)), nb('g2', square(10, 0, 6), { hidden: true })];
    const ghosts = buildNeighborGhosts(list);
    const meshes: THREE.Mesh[] = [];
    ghosts.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    // hidden: true の建物も半透明で作る
    expect(meshes.map((m) => m.userData.neighborId).sort()).toEqual(['g1', 'g2']);
    for (const m of meshes) {
      const mat = m.material as THREE.MeshBasicMaterial;
      expect(mat.transparent).toBe(true);
      expect(mat.opacity).toBeCloseTo(0.25, 9);
      expect(mat.depthWrite).toBe(false);
      expect(m.castShadow).toBe(false);
      expect(m.receiveShadow).toBe(false);
      expect(m.userData.noShadow).toBe(true);
      expect(m.userData.overlay).toBe(true);
      expect(m.userData.neighbor).toBeUndefined();
    }
    // 表示を無視して焼き込んでも（解析と同じ ignoreVisibility）三角形は入らない
    expect(bakeWorldTriangles([{ root: ghosts, kind: 'neighbor' }], (m) => !m.userData.noShadow && !m.userData.overlay, { ignoreVisibility: true }).triangles).toBe(0);
    expect(bakeWorldTriangles([{ root: ghosts, kind: 'neighbor' }]).triangles).toBe(0);
    // 比較: 普通の周辺建物は入る
    const normal = buildNeighborMeshes([list[0]], { groundY: () => 0 });
    expect(bakeWorldTriangles([{ root: normal, kind: 'neighbor' }]).triangles).toBeGreaterThan(0);
  });
  it('共有のマテリアルを渡すと sharedMaterial が付く（clearGroup で解放しない）', () => {
    const mat = ghostMaterial('#e5531f', 0.42);
    const ghosts = buildNeighborGhosts([nb('g1', square(0, 0, 6))], { material: mat });
    const m = ghosts.children[0] as THREE.Mesh;
    expect(m.material).toBe(mat);
    expect(m.userData.sharedMaterial).toBe(true);
    expect(m.userData.noShadow).toBe(true);
  });
});
