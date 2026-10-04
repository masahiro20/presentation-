/**
 * 日照解析コア（src/sun/analysis.ts）と 3D データ読み込み版（src/sunstudy/analysis.ts）の Node テスト。
 * ワールド: X=東, -Z=北, Y=上。遮蔽物は 10m の立方体（底面 y=0, 中心 (0,5,0)）
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  buildOccluderFrom,
  isShaded,
  isShadedFrom,
  raycastFirstKind,
  sunSamplesForDay,
  sunHoursGrid,
  shadowDiagramCore,
  offsetPolygon,
  rectPolygon,
  disposeOccluder,
  type Occluder,
} from '../src/sun/analysis';
import { sunDirectionWorld, trueSolarToLocal } from '../src/sun/solar';
import {
  studyDates,
  buildStudyOccluder,
  disposeStudyOccluder,
  isShadedStudy,
  groundSampler,
  clearStudyOccluderCache,
  measurePointHours,
  facadeSunHours,
  shadowDiagramStudy,
} from '../src/sunstudy/analysis';
import type { StudyScene } from '../src/sunstudy/scene';

const TOKYO = { lat: 35.6895, lon: 139.6917 };
const WINTER = { year: 2026, month: 12, day: 22, ...TOKYO, northAngleDeg: 0 };

function boxOccluder(size = 10): { occ: Occluder; root: THREE.Group } {
  const root = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
  m.position.y = size / 2;
  root.add(m);
  // 影を落とさないもの（ガラス）は焼き込まれない
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  glass.position.set(0, 20, 0);
  glass.userData.noShadow = true;
  root.add(glass);
  const occ = buildOccluderFrom([{ root, kind: 'building' }]);
  return { occ, root };
}

describe('遮蔽判定（BVH）', () => {
  const { occ } = boxOccluder();

  it('10m の箱: 南に低い太陽のとき、北側の点は日影、南側の点は日向', () => {
    expect(occ.triangles).toBe(12);
    // 南（方位 180°）・高度 20° の太陽。dir は +Z（南）へ上向き
    const dir = sunDirectionWorld(180, 20, 0);
    expect(dir.z).toBeGreaterThan(0.9);
    expect(dir.y).toBeGreaterThan(0.3);
    const north = new THREE.Vector3(0, 0.5, -8);
    const south = new THREE.Vector3(0, 0.5, 8);
    expect(isShaded(occ, north, dir)).toBe(true);
    expect(isShaded(occ, south, dir)).toBe(false);
    // 始点をずらさない版
    expect(isShadedFrom(occ, north, dir)).toBe(true);
    expect(isShadedFrom(occ, south, dir)).toBe(false);
  });

  it('raycastFirstKind: 真下レイキャストで種別と当たった点が取れる', () => {
    const hit = raycastFirstKind(occ, new THREE.Vector3(1, 50, -1), new THREE.Vector3(0, -1, 0), 100);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('building');
    expect(hit!.distance).toBeCloseTo(40, 5);
    expect(hit!.point.y).toBeCloseTo(10, 5);
    // 箱の外では当たらない
    expect(raycastFirstKind(occ, new THREE.Vector3(20, 50, 0), new THREE.Vector3(0, -1, 0), 100)).toBeNull();
  });

  it('extra の遮蔽物も判定する', () => {
    const other = boxOccluder(4);
    other.root.position.x = 30;
    const occ2 = buildOccluderFrom([{ root: other.root, kind: 'neighbor' }]);
    const combined: Occluder = { ...occ, extra: [occ2] };
    const down = new THREE.Vector3(0, -1, 0);
    expect(raycastFirstKind(combined, new THREE.Vector3(30, 50, 0), down, 100)?.kind).toBe('neighbor');
    expect(raycastFirstKind(combined, new THREE.Vector3(0, 50, 0), down, 100)?.kind).toBe('building');
    expect(isShadedFrom(combined, new THREE.Vector3(30, 0.5, -5), sunDirectionWorld(180, 20, 0))).toBe(true);
    disposeOccluder(occ2);
  });
});

describe('太陽方向の時刻表', () => {
  it('東京・冬至: 南中付近の方位は 180°、すべて高度 > 0、dir は上向き', () => {
    const samples = sunSamplesForDay(WINTER, { stepMin: 10, centered: false });
    expect(samples.length).toBeGreaterThan(40);
    for (const s of samples) {
      expect(s.elev).toBeGreaterThan(0);
      expect(s.dir.y).toBeGreaterThan(0);
      expect(s.dir.length()).toBeCloseTo(1, 6);
    }
    const noon = trueSolarToLocal(2026, 12, 22, 12, TOKYO.lon);
    const near = samples.reduce((a, s) => (Math.abs(s.h - noon) < Math.abs(a.h - noon) ? s : a));
    expect(Math.abs(near.az - 180)).toBeLessThan(3);
    // 南中の太陽は +Z（南）側
    expect(near.dir.z).toBeGreaterThan(0.5);
    expect(Math.abs(near.dir.x)).toBeLessThan(0.1);
    // 冬至の最大高度 ≈ 90 - 35.69 - 23.44 ≈ 30.9°
    expect(near.elev).toBeGreaterThan(29);
    expect(near.elev).toBeLessThan(32);
    // 午前の太陽は東（+X）
    expect(samples[0].dir.x).toBeGreaterThan(0);
  });

  it('centered: 刻みの中央の時刻になる', () => {
    const s = sunSamplesForDay(WINTER, { from: 9, to: 11, stepMin: 30, centered: true });
    expect(s.map((x) => x.h)).toEqual([9.25, 9.75, 10.25, 10.75]);
  });
});

describe('格子の日照時間', () => {
  it('箱の北側は南側より日照時間が短い', async () => {
    const { occ } = boxOccluder();
    const samples = sunSamplesForDay(WINTER, { stepMin: 30, centered: true });
    const g = await sunHoursGrid(occ, samples, { x0: -15, z0: -15, cell: 1, nx: 30, nz: 30 }, () => 0.1, { stepHours: 0.5 });
    const mean = (pred: (x: number, z: number) => boolean) => {
      let sum = 0;
      let n = 0;
      for (let j = 0; j < g.nz; j++)
        for (let i = 0; i < g.nx; i++) {
          const x = g.x0 + (i + 0.5) * g.cell;
          const z = g.z0 + (j + 0.5) * g.cell;
          if (!pred(x, z)) continue;
          sum += g.values[j * g.nx + i];
          n++;
        }
      return sum / n;
    };
    // 箱のすぐ北（1〜4m）は冬至の太陽（最大高度 ≈31°、影の長さ ≥ 16m）では一日中日影
    const north = mean((x, z) => z < -6 && z > -9 && Math.abs(x) < 2);
    const south = mean((x, z) => z > 6 && z < 9 && Math.abs(x) < 2);
    const far = mean((x, z) => z > 13);
    expect(north).toBeLessThan(south);
    // 日の出直後（方位 ≈118°）だけ箱の東側をかすめて日が当たるので 0 ではない
    expect(north).toBeLessThan(1.5);
    expect(south).toBeGreaterThan(6);
    // 箱から離れた南側は 1 日の長さに近い（冬至 ≈ 9.7h）
    expect(far).toBeGreaterThan(9);
    expect(far).toBeLessThan(10.5);
    disposeOccluder(occ);
  });
});

describe('日影図', () => {
  const { occ } = boxOccluder();
  const common = {
    occ,
    ...TOKYO,
    northAngleDeg: 0,
    year: 2026,
    planeHeight: 1.5,
    center: { x: 0, z: 0 },
    half: 20,
    cell: 0.5,
    insideBuilding: (x: number, z: number) => Math.abs(x) < 5 && Math.abs(z) < 5,
    outlines: [{ points: rectPolygon(-5, -5, 5, 5), fill: true }],
  };

  it('敷地あり: 題名・等時間線・5m ライン・4 つの集計', async () => {
    const r = await shadowDiagramCore({ ...common, site: { polygon: rectPolygon(-8, -8, 8, 8) }, note: '※周辺建物は含みません' });
    expect(r.svg).toContain('日影図');
    expect(r.svg).toContain('JST');
    expect(r.svg).toContain('2時間');
    expect(r.svg).toContain('5mライン');
    expect(r.svg).toContain('10mライン');
    expect(r.svg).toContain('参考図');
    expect(r.svg).toContain('※周辺建物は含みません');
    expect(r.svg).not.toContain('省略');
    expect(r.summary).toHaveLength(4);
    expect(r.summary.map((s) => s.hour)).toEqual([2, 3, 4, 5]);
    // 10m の箱は冬至に北へ 10m 以上の影を落とす: 2 時間線は敷地境界の外に出る
    expect(r.summary[0].maxDist).toBeGreaterThan(0);
    for (let i = 1; i < r.summary.length; i++) expect(r.summary[i].maxDist).toBeLessThanOrEqual(r.summary[i - 1].maxDist + 1e-9);
    expect(r.extent).toEqual({ x0: -20, z0: -20, half: 20, cell: 0.5 });
  });

  it('敷地なし: 5m/10m ラインを省いて注記する。時間帯の指定が題名に出る', async () => {
    const r = await shadowDiagramCore({ ...common, hours: [9, 15] });
    expect(r.svg).toContain('省略');
    expect(r.svg).not.toContain('5mライン');
    expect(r.svg).toContain('真太陽時 9:00〜15:00');
    expect(r.summary).toHaveLength(4);
    // 建物の輪郭からの距離になる
    expect(r.summary[0].maxDist).toBeGreaterThan(0);
  });
});

describe('多角形のオフセット', () => {
  it('矩形を 5m 外側へ → 各辺を 5m 広げた矩形', () => {
    const out = offsetPolygon(rectPolygon(0, 0, 10, 6), 5);
    expect(out).toHaveLength(4);
    const exp = rectPolygon(-5, -5, 15, 11);
    for (let i = 0; i < 4; i++) {
      expect(out[i].x).toBeCloseTo(exp[i].x, 9);
      expect(out[i].y).toBeCloseTo(exp[i].y, 9);
    }
    // 逆回り（時計回り）でも外側へ
    const cw = offsetPolygon(rectPolygon(0, 0, 10, 6).reverse(), 5);
    const xs = cw.map((p) => p.x);
    const ys = cw.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(-5, 9);
    expect(Math.max(...xs)).toBeCloseTo(15, 9);
    expect(Math.min(...ys)).toBeCloseTo(-5, 9);
    expect(Math.max(...ys)).toBeCloseTo(11, 9);
  });
});

describe('解析用の日付（二十四節気）', () => {
  const find = (year: number, id: string) => studyDates(year).find((d) => d.id === id)!;
  it('2027 年の春分は 3/21（JST）', () => {
    const d = find(2027, 'spring');
    expect(d.label).toBe('春分');
    expect([d.month, d.day]).toEqual([3, 21]);
  });
  it('2028 年の秋分は 9/22、冬至は 12/21', () => {
    expect([find(2028, 'autumn').month, find(2028, 'autumn').day]).toEqual([9, 22]);
    expect([find(2028, 'winter').month, find(2028, 'winter').day]).toEqual([12, 21]);
  });
  it('2026 年の夏至は 6/21、春分 3/20、秋分 9/23、冬至 12/22', () => {
    expect([find(2026, 'summer').month, find(2026, 'summer').day]).toEqual([6, 21]);
    expect([find(2026, 'spring').month, find(2026, 'spring').day]).toEqual([3, 20]);
    expect([find(2026, 'autumn').month, find(2026, 'autumn').day]).toEqual([9, 23]);
    expect([find(2026, 'winter').month, find(2026, 'winter').day]).toEqual([12, 22]);
    const ids = studyDates(2026).map((d) => d.id);
    expect(ids).toEqual(['winter', 'spring', 'summer', 'autumn']);
  });
});

// ---------------------------------------------------------------------------
// 3D データ読み込み版（scene は groups だけの偽物。DOM を使う関数は対象外）
// ---------------------------------------------------------------------------

function fakeScene(): StudyScene {
  const groups = {
    terrain: new THREE.Group(),
    neighbors: new THREE.Group(),
    building: new THREE.Group(),
    site: new THREE.Group(),
    sunpath: new THREE.Group(),
    overlay: new THREE.Group(),
    markers: new THREE.Group(),
  };
  // 地形: 200m の平面（y=0）
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200, 4, 4));
  ground.rotateX(-Math.PI / 2);
  ground.userData.terrain = true;
  groups.terrain.add(ground);
  // 建物: 10m の箱（底面 y=0）
  const b = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
  b.position.y = 5;
  groups.building.add(b);
  // ガラス（noShadow）と解析結果の表示（overlay）は無視される
  const glass = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  glass.position.set(0, 30, 0);
  glass.userData.noShadow = true;
  groups.building.add(glass);
  const ov = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  ov.position.set(0, 40, 0);
  ov.userData.overlay = true;
  groups.building.add(ov);
  // 周辺建物: 東 30m に 4m の箱
  const nb = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
  nb.position.set(30, 2, 0);
  nb.userData.neighbor = true;
  groups.neighbors.add(nb);
  return { groups } as unknown as StudyScene;
}

describe('sunstudy: 遮蔽物と地面の高さ', () => {
  it('種別 terrain / neighbor / building、地形はキャッシュされる', () => {
    clearStudyOccluderCache();
    const scene = fakeScene();
    const occ = buildStudyOccluder(scene, { terrain: true, neighbors: true, building: true });
    expect(occ.triangles).toBe(24); // 箱 12 + 周辺建物 12（ガラス・overlay は除く）
    expect(occ.extra).toHaveLength(1);
    expect(occ.extra![0].kindOf(0)).toBe('terrain');
    const down = new THREE.Vector3(0, -1, 0);
    expect(raycastFirstKind(occ, new THREE.Vector3(0, 50, 0), down, 100)?.kind).toBe('building');
    expect(raycastFirstKind(occ, new THREE.Vector3(30, 50, 0), down, 100)?.kind).toBe('neighbor');
    const t = raycastFirstKind(occ, new THREE.Vector3(60, 50, 60), down, 100);
    expect(t?.kind).toBe('terrain');
    expect(t!.point.y).toBeCloseTo(0, 6);
    // ガラスの位置（y=30）には何も無い
    expect(raycastFirstKind(occ, new THREE.Vector3(0, 50, 0), down, 100)!.point.y).toBeCloseTo(10, 6);
    // 2 回目は同じ地形 BVH
    const occ2 = buildStudyOccluder(scene, { terrain: true, neighbors: false, building: true });
    expect(occ2.extra![0]).toBe(occ.extra![0]);
    expect(occ2.triangles).toBe(12);
    // 地形だけ → キャッシュそのものを返す（cached）
    const occ3 = buildStudyOccluder(scene, { terrain: true, neighbors: false, building: false });
    expect(occ3.cached).toBe(true);
    expect(occ3.bvh).toBe(occ.extra![0].bvh);
    // isShadedStudy は extra（地形）も見る: 地面より下から上向きのレイは地形に当たる
    expect(isShadedStudy(occ2, new THREE.Vector3(60, -1, 60), new THREE.Vector3(0, 1, 0))).toBe(true);
    expect(isShadedStudy(occ2, new THREE.Vector3(60, 0.15, 60), new THREE.Vector3(0, 1, 0))).toBe(false);
    disposeStudyOccluder(occ);
    disposeStudyOccluder(occ2);
    disposeStudyOccluder(occ3);
    // 地形のキャッシュは生きている
    expect(raycastFirstKind(occ.extra![0], new THREE.Vector3(60, 50, 60), down, 100)?.kind).toBe('terrain');
    clearStudyOccluderCache();
  });

  it('groundSampler: 地形に当たればその高さ、無ければ fallback', () => {
    const scene = fakeScene();
    const g = groundSampler(scene, () => -99);
    expect(g(10, 10)).toBeCloseTo(0, 6);
    expect(g(500, 500)).toBe(-99); // 地形の外
    scene.groups.terrain.clear();
    const g2 = groundSampler(scene, () => 7);
    expect(g2(0, 0)).toBe(7);
    clearStudyOccluderCache();
  });
});

describe('sunstudy: 測定点・面・日影図（偽のシーン）', () => {
  const scene = fakeScene();
  const dates = studyDates(2026);
  const winter = dates.filter((d) => d.id === 'winter');

  it('測定点: 箱の南の地面は長く、北の地面は短く、北の壁は 0', async () => {
    const south = await measurePointHours(scene, { id: 's', label: '南', pos: [0, 0, 8], normal: [0, 1, 0] }, winter, TOKYO, { stepMin: 10 });
    const north = await measurePointHours(scene, { id: 'n', label: '北', pos: [0, 0, -7], normal: [0, 1, 0] }, winter, TOKYO, { stepMin: 10 });
    const nWall = await measurePointHours(scene, { id: 'w', label: '北壁', pos: [0, 5, -5], normal: [0, 0, -1] }, winter, TOKYO, { stepMin: 10 });
    const sWall = await measurePointHours(scene, { id: 'w2', label: '南壁', pos: [0, 5, 5], normal: [0, 0, 1] }, winter, TOKYO, { stepMin: 10 });
    expect(south).toHaveLength(1);
    expect(south[0].dateId).toBe('winter');
    expect(south[0].month).toBe(12);
    expect(south[0].hours).toBeGreaterThan(8);
    expect(south[0].spans.length).toBeGreaterThan(0);
    expect(south[0].first).toBeLessThan(8);
    expect(south[0].last).toBeGreaterThan(15);
    expect(north[0].hours).toBeLessThan(1.5);
    expect(nWall[0].hours).toBe(0);
    expect(nWall[0].first).toBeNull();
    expect(nWall[0].spans).toEqual([]);
    expect(sWall[0].hours).toBeGreaterThan(8.5);
    // spans の合計 = hours、区間は日の出〜日の入の中
    const sum = sWall[0].spans.reduce((a, [x, y]) => a + (y - x), 0);
    expect(sum).toBeCloseTo(sWall[0].hours, 9);
  });

  it('面の日照時間: 頂点色付きの非インデックス geometry、南面・屋根は長く北面は 0', async () => {
    const mesh = await facadeSunHours(scene, { year: 2026, month: 12, day: 22, ...TOKYO }, { stepMin: 20 });
    const geo = mesh.geometry as THREE.BufferGeometry;
    expect(geo.index).toBeNull();
    expect(geo.getAttribute('position').count).toBe(36);
    expect(geo.getAttribute('color').count).toBe(36);
    expect(mesh.userData.facade).toBe(true);
    expect(mesh.userData.overlay).toBe(true);
    expect(mesh.userData.coarse).toBe(false);
    expect(mesh.userData.maxHours).toBeGreaterThan(9);
    expect(mesh.userData.maxHours).toBeLessThan(10.5);
    const hours = mesh.userData.faceHours as Float32Array;
    expect(hours).toHaveLength(12);
    // 面の法線で分類
    const pos = geo.getAttribute('position');
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let f = 0; f < 12; f++) {
      a.fromBufferAttribute(pos, f * 3);
      b.fromBufferAttribute(pos, f * 3 + 1);
      c.fromBufferAttribute(pos, f * 3 + 2);
      new THREE.Triangle(a, b, c).getNormal(n);
      if (n.y > 0.9) expect(hours[f]).toBeGreaterThan(8.5); // 屋根
      if (n.z > 0.9) expect(hours[f]).toBeGreaterThan(8.5); // 南面
      if (n.z < -0.9) expect(hours[f]).toBe(0); // 北面
      if (n.y < -0.9) expect(hours[f]).toBe(0); // 底面（地形に接する）
    }
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.vertexColors).toBe(true);
    expect(mat.side).toBe(THREE.DoubleSide);
    expect(mesh.castShadow).toBe(false);
  });

  it('日影図: 建物内外は真下レイキャスト、敷地なしの注記、周辺建物の注記', async () => {
    const base = { ...TOKYO, year: 2026, planeHeight: 1.5, includeNeighbors: false, center: new THREE.Vector3(0, 0, 0), half: 20, sitePolygon: null };
    const r = await shadowDiagramStudy(scene, base);
    expect(r.svg).toContain('日影図');
    expect(r.svg).toContain('省略');
    expect(r.svg).toContain('※周辺建物は含みません');
    expect(r.svg).toContain('建物の位置・方位は航空写真上での手動配置によるものです');
    expect(r.extent.half).toBe(20);
    expect(r.extent.cell).toBe(0.3);
    expect(r.summary).toHaveLength(4);
    expect(r.summary[0].maxDist).toBeGreaterThan(5); // 2 時間線は建物の輪郭から北へ 5m 以上
    const r2 = await shadowDiagramStudy(scene, { ...base, includeNeighbors: true, sitePolygon: [new THREE.Vector2(-8, -8), new THREE.Vector2(8, -8), new THREE.Vector2(8, 8), new THREE.Vector2(-8, 8)] });
    expect(r2.svg).toContain('※周辺建物を含みます');
    expect(r2.svg).toContain('5mライン');
    expect(r2.svg).not.toContain('省略');
    clearStudyOccluderCache();
  });
});
