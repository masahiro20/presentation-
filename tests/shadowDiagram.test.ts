/**
 * 日影図の範囲・冬至日・規制時間・時刻日影線の間隔（src/sun/analysis.ts・src/sun/solar.ts・src/sunstudy/analysis.ts）。
 * ワールド: X=東, -Z=北, Y=上
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  buildOccluderFrom,
  disposeOccluder,
  shadowDiagram,
  shadowDiagramCell,
  shadowDiagramCore,
  shadowDiagramExtent,
  shadowDiagramGrid,
  rectPolygon,
  SHADOW_DIAGRAM_CELL_BUDGET,
  SHADOW_DIAGRAM_MAX_HALF,
  SHADOW_REGULATION_PRESETS,
  SHADOW_REGION_HOURS,
  shadowRegulationPreset,
  type Occluder,
  type ShadowDiagramParams,
} from '../src/sun/analysis';
import { keyDates, localDate, seasonMoment, sunDirectionWorld, sunPosition, trueSolarToLocal, winterSolstice } from '../src/sun/solar';
import { clearStudyOccluderCache, shadowDiagramStudy, studyDates } from '../src/sunstudy/analysis';
import type { StudyScene } from '../src/sunstudy/scene';
import type { Viewer } from '../src/scene/viewer';

const TOKYO = { lat: 35.68, lon: 139.69 };

/** 底面 y=0、水平 w × d、高さ h の箱（中心 (cx, cz)） */
function tower(w: number, d: number, h: number, cx = 0, cz = 0): { occ: Occluder; root: THREE.Group } {
  const root = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
  m.position.set(cx, h / 2, cz);
  root.add(m);
  return { occ: buildOccluderFrom([{ root, kind: 'building' }]), root };
}

/** SVG の data-time / data-level の path の座標（m） */
function pathPoints(svg: string, attr: string): { x: number; z: number }[] {
  const m = svg.match(new RegExp(`<path ${attr}[^>]* d="([^"]+)"`));
  if (!m) return [];
  const nums = m[1].match(/-?\d+(\.\d+)?/g)!.map(Number);
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push({ x: nums[i] / 100, z: nums[i + 1] / 100 });
  return out;
}

/** 真太陽時 s の太陽（高度・水平の向き） */
function sunAt(year: number, s: number) {
  const w = winterSolstice(year);
  const lh = trueSolarToLocal(year, w.month, w.day, s, TOKYO.lon);
  const sp = sunPosition(localDate(year, w.month, w.day, lh), TOKYO.lat, TOKYO.lon);
  const dir = sunDirectionWorld(sp.azimuth, sp.elevation, 0);
  const hl = Math.hypot(dir.x, dir.z);
  return { elev: sp.elevation, ux: -dir.x / hl, uz: -dir.z / hl };
}

describe('冬至日・春分・夏至・秋分（年ごとの日付）', () => {
  it('2024〜2030 年: keyDates と studyDates が同じ日付', () => {
    for (let y = 2024; y <= 2030; y++) expect(keyDates(y)).toEqual(studyDates(y));
  });
  it('2024 年の冬至は 12/21、2025〜2027 年は 12/22、2028・2029 年は 12/21、2030 年は 12/22（国立天文台の暦要項と同じ）', () => {
    const w = (y: number) => [winterSolstice(y).month, winterSolstice(y).day];
    expect(w(2024)).toEqual([12, 21]);
    expect(w(2025)).toEqual([12, 22]);
    expect(w(2026)).toEqual([12, 22]);
    expect(w(2027)).toEqual([12, 22]);
    expect(w(2028)).toEqual([12, 21]);
    expect(w(2029)).toEqual([12, 21]);
    expect(w(2030)).toEqual([12, 22]);
    expect(keyDates(2024)[0]).toEqual({ id: 'winter', label: '冬至', year: 2024, month: 12, day: 21 });
  });
  it('日付の境目に近い年も正しい: 2025 年の冬至（12/22 0:03 JST）、2023 年の夏至（6/21 23:58 JST）', () => {
    // 2025-12-22 00:03 JST = 2025-12-21 15:03 UTC
    expect(Math.abs(seasonMoment(2025, 'winter') - Date.UTC(2025, 11, 21, 15, 3)) / 60000).toBeLessThan(3);
    const summer2023 = keyDates(2023).find((d) => d.id === 'summer')!;
    expect([summer2023.month, summer2023.day]).toEqual([6, 21]);
    const spring2027 = keyDates(2027).find((d) => d.id === 'spring')!;
    expect([spring2027.month, spring2027.day]).toEqual([3, 21]);
  });
});

describe('日影図の範囲（影の届く範囲から決める）', () => {
  it('30m の塔（東京）: 8:00 の影の先端まで入る範囲、格子数は上限以内', () => {
    const bbox = { minX: -5, minZ: -5, maxX: 5, maxZ: 5 };
    const ext = shadowDiagramExtent({ ...TOKYO, year: 2026, planeHeight: 1.5, buildingTop: 30, bbox });
    const s8 = sunAt(2026, 8);
    const L = (30 - 1.5) / Math.tan((s8.elev * Math.PI) / 180);
    expect(ext.shadowLength).toBeCloseTo(L, 6);
    expect(ext.clipped).toBe(false);
    expect(ext.half).toBeLessThanOrEqual(SHADOW_DIAGRAM_MAX_HALF);
    // 8:00 の影（箱を L ずらした箱と元の箱をつなぐ形）の頂点がすべて範囲内
    for (const [x, z] of [
      [bbox.minX, bbox.minZ],
      [bbox.maxX, bbox.minZ],
      [bbox.minX, bbox.maxZ],
      [bbox.maxX, bbox.maxZ],
    ]) {
      const tx = x + s8.ux * L;
      const tz = z + s8.uz * L;
      expect(Math.abs(tx - ext.center.x)).toBeLessThan(ext.halfX);
      expect(Math.abs(tz - ext.center.z)).toBeLessThan(ext.halfZ);
    }
    // 影は北へ伸びるので、範囲は建物の中心より北に寄った長方形（南は最小の 34m）
    expect(ext.center.z).toBeLessThan(0);
    expect(ext.center.z + ext.halfZ).toBeCloseTo(34, 6);
    expect(ext.halfX).toBeGreaterThan(ext.halfZ);
    const g = shadowDiagramGrid(ext);
    expect(g.nx * g.nz).toBeLessThanOrEqual(SHADOW_DIAGRAM_CELL_BUDGET);
    // 400m の上限まで広げても格子数は上限以内（格子を粗くする）
    const big = shadowDiagramCell(400, 400);
    expect(Math.ceil(800 / big) ** 2).toBeLessThanOrEqual(SHADOW_DIAGRAM_CELL_BUDGET);
    expect(big).toBeGreaterThan(0.3);
    expect(shadowDiagramCell(34)).toBe(0.3);
  });

  it('上限 400m を超える影（低い太陽・高い建物）は clipped', () => {
    const ext = shadowDiagramExtent({ ...TOKYO, year: 2026, planeHeight: 1.5, buildingTop: 120, bbox: { minX: -5, minZ: -5, maxX: 5, maxZ: 5 } });
    expect(ext.half).toBe(400);
    expect(ext.clipped).toBe(true);
  });

  it('30m の塔の日影図: 時刻日影線は範囲内に収まり、8:00 の影の長さは H·cot(h) と 1% 以内', async () => {
    const { occ } = tower(10, 10, 30);
    const r = await shadowDiagramCore({
      occ,
      ...TOKYO,
      northAngleDeg: 0,
      year: 2026,
      planeHeight: 1.5,
      center: { x: 0, z: 0 },
      autoExtent: { buildingTop: 30, bbox: { minX: -5, minZ: -5, maxX: 5, maxZ: 5 } },
      cell: 1,
      insideBuilding: (x, z) => Math.abs(x) < 5 && Math.abs(z) < 5,
      outlines: [{ points: rectPolygon(-5, -5, 5, 5), fill: true }],
    });
    expect(r.clipped).toBe(false);
    expect(r.extent.half).toBeGreaterThan(100);
    expect(r.svg).toContain('8時');
    const pts = pathPoints(r.svg, 'data-time="8:00"');
    expect(pts.length).toBeGreaterThan(10);
    const { x0, z0, halfX, halfZ } = r.extent;
    for (const q of pts) {
      expect(q.x).toBeGreaterThan(x0);
      expect(q.x).toBeLessThan(x0 + 2 * halfX);
      expect(q.z).toBeGreaterThan(z0);
      expect(q.z).toBeLessThan(z0 + 2 * halfZ);
    }
    // 影の向きへの最大の張り出し − 箱の角の分 = 影の長さ
    const s8 = sunAt(2026, 8);
    const reach = Math.max(...pts.map((q) => q.x * s8.ux + q.z * s8.uz)) - 5 * (Math.abs(s8.ux) + Math.abs(s8.uz));
    const expected = (30 - 1.5) / Math.tan((s8.elev * Math.PI) / 180);
    expect(Math.abs(reach - expected) / expected).toBeLessThan(0.01);
    disposeOccluder(occ);
  });

  it('2 階建て（高さ 8m）・測定面 1.5m: 以前の固定 34m では 8:00 の影が切れたが、自動の範囲では切れない', async () => {
    const { occ } = tower(10, 8, 8);
    const base: ShadowDiagramParams = {
      occ,
      ...TOKYO,
      northAngleDeg: 0,
      year: 2026,
      planeHeight: 1.5,
      center: { x: 0, z: 0 },
      cell: 0.5,
      insideBuilding: (x, z) => Math.abs(x) < 5 && Math.abs(z) < 4,
      outlines: [{ points: rectPolygon(-5, -4, 5, 4), fill: true }],
    };
    const fixed = await shadowDiagramCore({ ...base, half: 34 });
    expect(fixed.clipped).toBe(true);
    expect(fixed.svg).toContain('図の範囲の外');
    const auto = await shadowDiagramCore({ ...base, half: 34, autoExtent: { buildingTop: 8, bbox: { minX: -5, minZ: -4, maxX: 5, maxZ: 4 } } });
    expect(auto.clipped).toBe(false);
    expect(auto.extent.half).toBeGreaterThan(34);
    expect(auto.svg).not.toContain('図の範囲の外');
    disposeOccluder(occ);
  });
});

describe('日影規制の規制時間（別表第 4 (に)欄）', () => {
  it('プリセット: 一般 3/2・4/2.5・5/3、北海道 2/1.5・3/2・4/2.5（北海道は真太陽時 9〜15 時）', () => {
    const v = SHADOW_REGULATION_PRESETS.map((p) => [p.id, p.limitNear, p.limitFar, p.hours.join('-')]);
    expect(v).toEqual([
      ['general-1', 3, 2, '8-16'],
      ['general-2', 4, 2.5, '8-16'],
      ['general-3', 5, 3, '8-16'],
      ['hokkaido-1', 2, 1.5, '9-15'],
      ['hokkaido-2', 3, 2, '9-15'],
      ['hokkaido-3', 4, 2.5, '9-15'],
    ]);
    expect(SHADOW_REGION_HOURS.hokkaido).toEqual([9, 15]);
    expect(shadowRegulationPreset('general-2')!.label).toBe('一般（二）');
    expect(shadowRegulationPreset('general-2')!.title).toBe('一般（二） 5〜10m 4時間／10m 超 2.5時間');
    expect(shadowRegulationPreset('hokkaido-1')!.label).toBe('北海道（一）');
  });

  it('規制の 2 本は太く「5〜10m の規制 X 時間」「10m 超の規制 Y 時間」、他は細い。適否は判定しない', async () => {
    const { occ } = tower(10, 10, 10);
    const r = await shadowDiagramCore({
      occ,
      ...TOKYO,
      northAngleDeg: 0,
      year: 2026,
      planeHeight: 1.5,
      center: { x: 0, z: 0 },
      half: 25,
      cell: 0.5,
      regulation: shadowRegulationPreset('general-2'),
      insideBuilding: (x, z) => Math.abs(x) < 5 && Math.abs(z) < 5,
      outlines: [{ points: rectPolygon(-5, -5, 5, 5), fill: true }],
      site: { polygon: rectPolygon(-8, -8, 8, 8) },
    });
    // 既定の [2,3,4,5] に 2.5 を足す
    expect(r.summary.map((s) => s.hour)).toEqual([2, 2.5, 3, 4, 5]);
    expect(r.summary.find((s) => s.hour === 4)!.role).toBe('limitNear');
    expect(r.summary.find((s) => s.hour === 2.5)!.role).toBe('limitFar');
    expect(r.summary.find((s) => s.hour === 3)!.role).toBeUndefined();
    expect(r.svg).toContain('5〜10m の規制 4 時間');
    expect(r.svg).toContain('10m 超の規制 2.5 時間');
    expect(r.svg).toContain('一般（二）');
    expect(r.svg).toContain('判定していません');
    expect(r.svg).not.toMatch(/適合|不適合|OK|NG/);
    const width = (level: string) => Number(r.svg.match(new RegExp(`<path data-level="${level}"[^>]*stroke-width="([\\d.]+)"`))![1]);
    expect(width('4')).toBeGreaterThan(width('3') * 2);
    expect(width('2.5')).toBeGreaterThan(width('2') * 2);
    expect(r.svg).toContain('data-role="limitNear"');
    // 規制の線は levels に無くても描く（北海道（一）の 1.5 時間）
    const h = await shadowDiagramCore({
      occ,
      ...TOKYO,
      northAngleDeg: 0,
      year: 2026,
      planeHeight: 1.5,
      center: { x: 0, z: 0 },
      half: 25,
      cell: 0.5,
      hours: SHADOW_REGION_HOURS.hokkaido,
      levels: [3],
      regulation: shadowRegulationPreset('hokkaido-1'),
      insideBuilding: (x, z) => Math.abs(x) < 5 && Math.abs(z) < 5,
      outlines: [{ points: rectPolygon(-5, -5, 5, 5), fill: true }],
    });
    expect(h.summary.map((s) => s.hour)).toEqual([1.5, 2, 3]);
    expect(h.svg).toContain('10m 超の規制 1.5 時間');
    expect(h.svg).toContain('真太陽時 9:00〜15:00');
    disposeOccluder(occ);
  });
});

describe('時刻日影線の間隔', () => {
  const run = async (iv?: 30 | 60) => {
    const { occ } = tower(10, 10, 10);
    const r = await shadowDiagramCore({
      occ,
      ...TOKYO,
      northAngleDeg: 0,
      year: 2026,
      planeHeight: 1.5,
      center: { x: 0, z: 0 },
      autoExtent: { buildingTop: 10, bbox: { minX: -5, minZ: -5, maxX: 5, maxZ: 5 } },
      cell: 0.5,
      timeLineIntervalMin: iv,
      insideBuilding: (x, z) => Math.abs(x) < 5 && Math.abs(z) < 5,
      outlines: [{ points: rectPolygon(-5, -5, 5, 5), fill: true }],
    });
    disposeOccluder(occ);
    return r;
  };
  const times = (svg: string) => [...svg.matchAll(/data-time="([\d:]+)"/g)].map((m) => m[1]);
  const labels = (svg: string) => [...svg.matchAll(/>(\d+)時</g)].map((m) => Number(m[1]));

  it('既定は毎正時（8:00〜16:00 の 9 本、ラベル 9 つ）', async () => {
    const r = await run();
    expect(times(r.svg)).toEqual(['8:00', '9:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
    expect(labels(r.svg)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(r.svg).toContain('時刻日影線（毎正時）');
  });

  it('30 分ごと: 8:00, 8:30 … 16:00 の 17 本、ラベルは正時だけ', async () => {
    const r = await run(30);
    const t = times(r.svg);
    expect(t).toHaveLength(17);
    expect(t[0]).toBe('8:00');
    expect(t[1]).toBe('8:30');
    expect(t[16]).toBe('16:00');
    expect(labels(r.svg)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(r.svg).toContain('30 分ごと');
    // 8:30 の線は 8:00 と 9:00 の間（影の先端の向き）
    const tip = (attr: string) => {
      const pts = pathPoints(r.svg, `data-time="${attr}"`);
      return Math.max(...pts.map((q) => Math.hypot(q.x, q.z)));
    };
    expect(tip('8:30')).toBeLessThan(tip('8:00'));
    expect(tip('8:30')).toBeGreaterThan(tip('9:00'));
  });
});

describe('日影図の冬至日（年ごとの日付）', () => {
  it('2024 年は 12 月 21 日で計算し、題名にも出る', async () => {
    const { occ } = tower(10, 10, 10);
    const r = await shadowDiagramCore({
      occ,
      ...TOKYO,
      northAngleDeg: 0,
      year: 2024,
      planeHeight: 1.5,
      center: { x: 0, z: 0 },
      half: 20,
      cell: 1,
      insideBuilding: (x, z) => Math.abs(x) < 5 && Math.abs(z) < 5,
      outlines: [],
    });
    expect(r.date).toEqual({ year: 2024, month: 12, day: 21 });
    expect(r.svg).toContain('冬至日 12月21日');
    disposeOccluder(occ);
  });
});

/** 既存アプリ（Viewer）の偽物: PDF の建物（groups.building）と敷地 */
function fakeViewer(opts: { external?: boolean } = {}): Viewer {
  const groups = {
    building: new THREE.Group(),
    roof: new THREE.Group(),
    context: new THREE.Group(),
    landscape: new THREE.Group(),
    external: new THREE.Group(),
    furniture: new THREE.Group(),
  };
  // 2 階建て: 10m × 8m・高さ 6m の壁 + 屋根で 8.5m
  const walls = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 8));
  walls.position.set(5, 3, 4);
  groups.building.add(walls);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(11, 2.5, 9));
  roof.position.set(5, 7.25, 4);
  groups.roof.add(roof);
  if (opts.external) {
    // 3DS: 西へ 30m ずらした 12m の箱
    const ext = new THREE.Mesh(new THREE.BoxGeometry(6, 12, 6));
    ext.position.set(-30, 6, 4);
    groups.external.add(ext);
  }
  const bbox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 6, 8));
  const outline = [new THREE.Vector2(0, 0), new THREE.Vector2(10, 0), new THREE.Vector2(10, 8), new THREE.Vector2(0, 8)];
  return {
    groups,
    userData: opts.external ? { externalReplaces: true, externalMounted: true } : {},
    state: {
      meta: { bbox, outlines: [{ level: 1, y: 0, polys: [outline] }] },
      site: { min: { x: -3, y: -3 }, max: { x: 13, y: 11 } },
    },
  } as unknown as Viewer;
}

describe('既存アプリの shadowDiagram', () => {
  it('PDF の建物（屋根を含む 8.5m）: 範囲は建物の箱の中心から影の届く所まで（34m 固定ではない）、5m/10m ラインは円弧', async () => {
    const v = fakeViewer();
    const r = await shadowDiagram(v, { ...TOKYO, northAngleDeg: 0, year: 2026 }, 1.5);
    expect(r.clipped).toBe(false);
    expect(r.extent.half).toBeGreaterThan(34);
    // 建物の箱の中心 (5, 4) ± 34m は必ず入る
    const contains = (cx: number, cz: number, h: number) => {
      const e = r.extent;
      expect(e.x0).toBeLessThanOrEqual(cx - h + 1e-9);
      expect(e.z0).toBeLessThanOrEqual(cz - h + 1e-9);
      expect(e.x0 + 2 * e.halfX).toBeGreaterThanOrEqual(cx + h - 1e-9);
      expect(e.z0 + 2 * e.halfZ).toBeGreaterThanOrEqual(cz + h - 1e-9);
    };
    contains(5, 4, 34);
    expect(r.svg).toContain('data-offset="5"');
    expect(r.svg).toContain('5mライン');
    expect(r.date).toEqual({ year: 2026, month: 12, day: 22 });
  });

  it('上書き（3DS で置き換え中）: 中心・高さ・輪郭・内外判定・描き方を渡せる', async () => {
    const v = fakeViewer({ external: true });
    const pts = [
      { x: -33, y: 1 },
      { x: -27, y: 1 },
      { x: -27, y: 7 },
      { x: -33, y: 7 },
    ];
    const r = await shadowDiagram(v, { ...TOKYO, northAngleDeg: 0, year: 2026 }, 4, undefined, {
      outlines: [pts.map((q) => new THREE.Vector2(q.x, q.y))],
      insideBuilding: (x, z) => x > -33 && x < -27 && z > 1 && z < 7,
      center: new THREE.Vector2(-30, 4),
      buildingTop: 12,
      timeLineIntervalMin: 30,
      regulation: shadowRegulationPreset('general-1'),
    });
    // 上書きの中心 (-30, 4) ± 34m が入り、PDF の建物 (0〜10) は範囲の基準にしない
    const e = r.extent;
    expect(e.x0).toBeLessThanOrEqual(-64 + 1e-9);
    expect(e.x0 + 2 * e.halfX).toBeGreaterThanOrEqual(4 - 1e-9);
    expect(e.x0 + 2 * e.halfX).toBeLessThan(60);
    expect(e.z0 + 2 * e.halfZ).toBeGreaterThanOrEqual(38 - 1e-9);
    expect(r.clipped).toBe(false);
    expect(r.svg).toContain('data-time="8:30"');
    expect(r.svg).toContain('5〜10m の規制 3 時間');
    expect(r.svg).toContain('GL+4m');
  });
});

describe('日影図の建物は窓ガラスも影を落とす（中身の詰まった塊として扱う）', () => {
  it('buildOccluderFrom の opaqueGlass: ガラス（PDF の matKey・3D データの userData.glass）も焼き込み、他の noShadow は除く', () => {
    const root = new THREE.Group();
    const pdfGlass = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    pdfGlass.userData.matKey = 'ext.glass';
    const extGlass = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    extGlass.userData.glass = true;
    extGlass.userData.noShadow = true;
    const marker = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    marker.userData.noShadow = true;
    root.add(pdfGlass, extGlass, marker);
    expect(buildOccluderFrom([root]).triangles).toBe(0);
    expect(buildOccluderFrom([root], undefined, { opaqueGlass: true }).triangles).toBe(24);
  });

  it('既存アプリの shadowDiagram: ガラスだけの箱でも影を落とす（部屋の日当たり用の遮蔽物ではガラスは光を通す）', async () => {
    const v = fakeViewer();
    v.groups.building.clear();
    v.groups.roof.clear();
    const glass = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 8));
    glass.position.set(5, 3, 4);
    glass.userData.matKey = 'ext.glass';
    v.groups.building.add(glass);
    const r = await shadowDiagram(v, { ...TOKYO, northAngleDeg: 0, year: 2026 }, 1.5);
    expect(r.svg).toContain('data-time="8:00"');
    expect(r.summary[0].maxDist).toBeGreaterThan(0);
  });
});

describe('広い範囲・周辺建物が多いときの格子', () => {
  it('レイキャスト数の目安が上限を超えると格子を粗くする（影が落ち得ない場所は数えない）', async () => {
    const { occ } = tower(10, 10, 30);
    const base: ShadowDiagramParams = {
      occ,
      ...TOKYO,
      northAngleDeg: 0,
      year: 2026,
      planeHeight: 1.5,
      center: { x: 0, z: 0 },
      autoExtent: { buildingTop: 30, bbox: { minX: -5, minZ: -5, maxX: 5, maxZ: 5 } },
      insideBuilding: (x, z) => Math.abs(x) < 5 && Math.abs(z) < 5,
      outlines: [],
    };
    const coarse = await shadowDiagramCore({ ...base, rayBudget: 200_000 });
    expect(coarse.extent.cell).toBeGreaterThan(0.3);
    expect(coarse.clipped).toBe(false);
    // 粗くしても時刻日影線の位置は辺の上の二分探索で求めるので、8:00 の影の長さは 1% 以内
    const s8 = sunAt(2026, 8);
    const pts = pathPoints(coarse.svg, 'data-time="8:00"');
    const reach = Math.max(...pts.map((q) => q.x * s8.ux + q.z * s8.uz)) - 5 * (Math.abs(s8.ux) + Math.abs(s8.uz));
    const expected = (30 - 1.5) / Math.tan((s8.elev * Math.PI) / 180);
    expect(Math.abs(reach - expected) / expected).toBeLessThan(0.01);
    disposeOccluder(occ);
  });
});

describe('日照ツールの shadowDiagramStudy（範囲の自動）', () => {
  it('half 省略: 建物の影が届く長方形、建物の内外・輪郭は建物の箱の範囲の細かい格子で求める', async () => {
    const groups = {
      terrain: new THREE.Group(),
      neighbors: new THREE.Group(),
      building: new THREE.Group(),
      site: new THREE.Group(),
      sunpath: new THREE.Group(),
      overlay: new THREE.Group(),
      markers: new THREE.Group(),
    };
    const b = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
    b.position.y = 5;
    groups.building.add(b);
    // 遠くの周辺建物（含めても範囲は建物の影で決まり、clipped にはならない）
    const nb = new THREE.Mesh(new THREE.BoxGeometry(6, 8, 6));
    nb.position.set(-150, 4, -60);
    groups.neighbors.add(nb);
    const scene = { groups } as unknown as StudyScene;
    const r = await shadowDiagramStudy(scene, { ...TOKYO, year: 2026, planeHeight: 1.5, includeNeighbors: true, center: new THREE.Vector3(0, 0, 0), sitePolygon: null });
    expect(r.clipped).toBe(false);
    expect(r.extent.halfX).toBeGreaterThan(34);
    // 南は最小の 34m、北へ影の届く所まで
    expect(r.extent.z0 + 2 * r.extent.halfZ).toBeCloseTo(34, 6);
    expect(r.svg).toContain('data-time="8:00"');
    // 建物の輪郭（塗り）が描かれ、等時間日影線は建物の内側に出ない
    expect(r.svg).toMatch(/<polygon points="[^"]+" fill="#555"/);
    expect(r.summary[0].maxDist).toBeGreaterThan(5);
    clearStudyOccluderCache();
  });
});
