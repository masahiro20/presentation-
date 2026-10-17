/**
 * 日照ステップ（プレゼン側）の「想定の家（未建築の隣家）」の操作の純粋な部分:
 *  - 計画の建物と平行に置く向き（真北の角度・建物の長手。SunContext の東・北と同じ取り方）
 *  - 図面の辺の方位の名前・道路から見た呼び名（裏・右隣・左隣・道路の向かい）・既定で選ぶ辺
 *  - 敷地（長方形）の隣の区画（同じ大きさ・道路の側は道路の幅だけ離す・区画の道路側の辺）と、houseInLot で置いた家が区画の中・敷地の外
 *  - 一覧・選択肢の文言、プリセット・屋根の形の変更、回転、複製、数字の欄
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SunContext } from '../src/sun/context';
import { houseFromPreset, houseInLot, plannedAxes, plannedFootprint, clampHouse, PLANNED_PRESETS } from '../src/sun/plannedHouse';
import { pointInPolygon } from '../src/sun/align';
import type { Viewer } from '../src/scene/viewer';
import {
  DEFAULT_ROAD_WIDTH,
  PLAN_SIDES,
  PLANNED_BLOCK_TITLE,
  PLANNED_INCLUDE_LABEL,
  PLANNED_MODE_ARMED,
  PLANNED_MODE_LABEL,
  PLANNED_SIDES_BUTTON,
  ROOF_RISE,
  defaultLotSides,
  duplicatePlanned,
  lotRoads,
  lotSideLabel,
  lotSideRelation,
  parseFieldNumber,
  planSideCompass,
  plannedListTitle,
  plannedPresetOption,
  plannedRotForPlan,
  plannedSummary,
  presetPatch,
  roofPatch,
  rotatedDeg,
  sideLotLabel,
  sideOfDir,
  siteSideLots,
  worldBearingDeg,
  type LotRoads,
} from '../src/app/steps/sunStep';

/** SunContext の toWorld / fromWorld だけを使う最小の viewer（建物の中心 = 原点） */
function fakeViewer(northAngleDeg = 0, bbox = new THREE.Box3(new THREE.Vector3(-5, 0, -4), new THREE.Vector3(5, 7, 4))): Viewer {
  const g = () => new THREE.Group();
  const groups = { building: g(), roof: g(), furniture: g(), landscape: g(), lights: g(), external: g(), context: g(), overlay: g() };
  return {
    state: { meta: { bbox, outlines: [], rooms: [] }, model: { northAngleDeg }, site: { min: { x: -8, y: -7 }, max: { x: 8, y: 7 } } },
    groups,
    userData: {},
    camera: new THREE.PerspectiveCamera(),
    invalidate() {},
  } as unknown as Viewer;
}
const SITE = { lat: 35.6045, lon: 139.6689, address: '世田谷区奥沢', offsetE: 0, offsetN: 0 };

describe('向き: ワールドの向きの方位・図面の辺の方位・計画の建物と平行に置く向き', () => {
  it('worldBearingDeg は SunContext.fromWorld と同じ北の取り方（真北の角度を変えても）', () => {
    for (const a of [0, 25, -40, 90, 137.5]) {
      const sc = new SunContext(fakeViewer(a), { ...SITE });
      for (const [dx, dz] of [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
        [0.6, -0.8],
      ]) {
        const p = sc.fromWorld(new THREE.Vector3(dx, 0, dz));
        const want = ((Math.atan2(p.e, p.n) * 180) / Math.PI + 360) % 360;
        const got = worldBearingDeg(dx, dz, a);
        expect(Math.abs(((got - want + 540) % 360) - 180)).toBeLessThan(1e-6);
        expect(got).toBeGreaterThanOrEqual(0);
        expect(got).toBeLessThan(360);
      }
    }
    expect(worldBearingDeg(0, -1, 0)).toBe(0);
    expect(worldBearingDeg(1, 0, 0)).toBe(90);
    expect(worldBearingDeg(0, 1, 0)).toBe(180);
    expect(worldBearingDeg(-1, 0, 0)).toBe(270);
    expect(worldBearingDeg(0, -1, 30)).toBeCloseTo(330, 9);
  });

  it('planSideCompass: 図面の上は真北の角度 0 なら北、90 なら西、45 なら北西', () => {
    expect(PLAN_SIDES.map((s) => planSideCompass(s, 0))).toEqual(['北', '東', '南', '西']);
    expect(PLAN_SIDES.map((s) => planSideCompass(s, 90))).toEqual(['西', '北', '東', '南']);
    expect(planSideCompass('top', 45)).toBe('北西');
    expect(planSideCompass('top', -45)).toBe('北東');
  });

  it('plannedRotForPlan: 棟（width の軸）が建物の長手（PDF の外形の箱の長い辺）と平行。[0, 180)', () => {
    expect(plannedRotForPlan(10, 8, 0)).toBe(90);
    expect(plannedRotForPlan(8, 10, 0)).toBe(0);
    expect(plannedRotForPlan(10, 8, 30)).toBeCloseTo(60, 9);
    expect(plannedRotForPlan(8, 10, 30)).toBeCloseTo(150, 9);
    expect(plannedRotForPlan(10, 8, -20)).toBeCloseTo(110, 9);
    expect(plannedRotForPlan(8, 10, 100)).toBeCloseTo(80, 9);
    expect(plannedRotForPlan(10, 10, 0)).toBe(90); // 正方形は図面の横
    for (const a of [0, 12.5, 45, 90, 179, -30, 200]) {
      for (const [sx, sz] of [
        [12, 7],
        [7, 12],
      ]) {
        const rot = plannedRotForPlan(sx, sz, a);
        expect(rot).toBeGreaterThanOrEqual(0);
        expect(rot).toBeLessThan(180);
        // 置いた家の棟の向きをワールドに直すと、建物の長手の軸（x か z）に沿う
        const sc = new SunContext(fakeViewer(a), { ...SITE });
        const { u } = plannedAxes(rot);
        const w = sc.toWorld(u.e, u.n).sub(sc.toWorld(0, 0));
        if (sx > sz) expect(Math.abs(Math.abs(w.x) - 1)).toBeLessThan(1e-9);
        else expect(Math.abs(Math.abs(w.z) - 1)).toBeLessThan(1e-9);
        // 実際に置いた家の足元の長い辺も同じ向き
        const h = houseFromPreset('gable2', 0, -14, rot);
        const fp = plannedFootprint(h).map((p) => sc.toWorld(p.e, p.n));
        const long = fp[1].clone().sub(fp[0]);
        expect(long.length()).toBeCloseTo(9.1, 9);
        if (sx > sz) expect(Math.abs(long.z)).toBeLessThan(1e-9);
        else expect(Math.abs(long.x)).toBeLessThan(1e-9);
      }
    }
  });
});

describe('接道と辺の呼び名', () => {
  it('sideOfDir: 外構の道路の向き（roadDir）→ 図面の辺', () => {
    expect(sideOfDir({ x: 1, z: 0 })).toBe('right');
    expect(sideOfDir({ x: -1, z: 0 })).toBe('left');
    expect(sideOfDir({ x: 0, z: -1 })).toBe('top');
    expect(sideOfDir({ x: 0, z: 1 })).toBe('bottom');
  });

  it('lotRoads: 図面の接道（幅員 3〜20 m、無ければ 6 m）+ 外構で道路を敷いた側（主な接道）', () => {
    expect(lotRoads([{ side: 'bottom', widthMm: 4000 }], { x: 0, z: 1 })).toEqual({ primary: 'bottom', widths: { bottom: 4 } });
    expect(lotRoads([], { x: 1, z: 0 })).toEqual({ primary: 'right', widths: { right: DEFAULT_ROAD_WIDTH } });
    expect(lotRoads(undefined, { x: 0, z: -1 })).toEqual({ primary: 'top', widths: { top: 6 } });
    expect(lotRoads([{ side: 'left', widthMm: 50000 }], { x: -1, z: 0 }).widths.left).toBe(20);
    expect(lotRoads([{ side: 'left', widthMm: 1000 }], { x: -1, z: 0 }).widths.left).toBe(3);
    // 角地: 両方の道路
    expect(lotRoads([{ side: 'bottom', widthMm: 6000 }, { side: 'right' }], { x: 0, z: 1 })).toEqual({ primary: 'bottom', widths: { bottom: 6, right: 6 } });
    // 外構の道路の側が図面の接道に無いとき（玄関の向き）も道路にする（幅員は図面の最初の道路）
    expect(lotRoads([{ side: 'left', widthMm: 4500 }], { x: 0, z: 1 })).toEqual({ primary: 'bottom', widths: { left: 4.5, bottom: 4.5 } });
  });

  it('lotSideRelation: 道路に立って建物を向いたときの 裏・右隣・左隣（道路の辺は 道路）', () => {
    const rel = (primary: LotRoads['primary']) => PLAN_SIDES.map((s) => lotSideRelation(s, { primary, widths: { [primary]: 6 } }));
    // 南（図面の下）の道路: 北が裏、東（右）が右隣
    expect(rel('bottom')).toEqual(['裏', '右隣', '道路', '左隣']);
    // 東の道路: 西を向くので右手は北
    expect(rel('right')).toEqual(['右隣', '道路', '左隣', '裏']);
    expect(rel('top')).toEqual(['道路', '左隣', '裏', '右隣']);
    expect(rel('left')).toEqual(['左隣', '裏', '右隣', '道路']);
    // 角地: 2 つ目の道路も 道路
    expect(lotSideRelation('right', { primary: 'bottom', widths: { bottom: 6, right: 4 } })).toBe('道路');
  });

  it('lotSideLabel・defaultLotSides: 選択肢の名前（方位 + 呼び名）と既定（道路ではない辺）', () => {
    const roads: LotRoads = { primary: 'bottom', widths: { bottom: 6 } };
    expect(PLAN_SIDES.map((s) => lotSideLabel(s, roads, 0))).toEqual(['北側（裏）', '東側（右隣）', '南側（道路の向かい）', '西側（左隣）']);
    expect(lotSideLabel('top', roads, 90)).toBe('西側（裏）');
    expect(defaultLotSides(roads)).toEqual(['top', 'right', 'left']);
    expect(defaultLotSides({ primary: 'bottom', widths: { bottom: 6, right: 4 } })).toEqual(['top', 'left']);
  });
});

describe('siteSideLots: 敷地の隣の区画', () => {
  const site = { min: { x: -8, y: -7 }, max: { x: 8, y: 7 } };
  const roads: LotRoads = { primary: 'bottom', widths: { bottom: 6 } };

  it('同じ大きさの区画を辺の外に並べる（道路の側は道路の幅だけ離す）。区画の道路側の辺', () => {
    const lots = siteSideLots(site, ['left', 'bottom', 'top', 'right', 'top'], roads);
    // 並びは図面の辺の順（上・右・下・左）、同じ辺は 1 つ
    expect(lots.map((l) => l.side)).toEqual(['top', 'right', 'bottom', 'left']);
    const by = Object.fromEntries(lots.map((l) => [l.side, l]));
    expect(by.top.corners).toEqual([
      { x: -8, z: -21 },
      { x: 8, z: -21 },
      { x: 8, z: -7 },
      { x: -8, z: -7 },
    ]);
    expect(by.right.corners[0]).toEqual({ x: 8, z: -7 });
    expect(by.right.corners[2]).toEqual({ x: 24, z: 7 });
    expect(by.left.corners[0]).toEqual({ x: -24, z: -7 });
    // 南の道路（幅 6 m）の向かい: 敷地の奥行 14 + 6 だけ南
    expect(by.bottom.corners[0]).toEqual({ x: -8, z: 13 });
    expect(by.bottom.corners[2]).toEqual({ x: 8, z: 27 });
    expect(lots.map((l) => l.acrossRoad)).toEqual([false, false, true, false]);
    // 道路側の辺: 裏は背中合わせ（遠い側 = 上 0）、左右の隣は敷地と同じ道路（下 2）、向かいは敷地を向く辺（上 0）
    expect(lots.map((l) => l.frontEdge)).toEqual([0, 2, 0, 2]);
  });

  it('東の道路・角地', () => {
    const east = siteSideLots(site, PLAN_SIDES, { primary: 'right', widths: { right: 4 } });
    expect(east.map((l) => l.frontEdge)).toEqual([1, 3, 1, 3]);
    // 東の道路（幅 4 m）の向かい: 敷地の幅 16 + 4 だけ東（左上の角 x = −8 + 20）
    expect(east.find((l) => l.side === 'right')!.corners[0]).toEqual({ x: 12, z: -7 });
    const corner = siteSideLots(site, PLAN_SIDES, { primary: 'bottom', widths: { bottom: 6, right: 4 } });
    expect(corner.filter((l) => l.acrossRoad).map((l) => l.side)).toEqual(['right', 'bottom']);
    expect(corner.find((l) => l.side === 'right')!.frontEdge).toBe(3);
  });

  it('壊れた敷地・辺の指定なしは空', () => {
    expect(siteSideLots({ min: { x: 0, y: 0 }, max: { x: 0, y: 5 } }, PLAN_SIDES, roads)).toEqual([]);
    expect(siteSideLots(site, [], roads)).toEqual([]);
  });

  it('houseInLot で置いた家は区画の中・敷地の外・区画と平行・道路側は 2 m 以上離れる（真北の角度を変えても）', () => {
    for (const a of [0, 23, -65]) {
      const sc = new SunContext(fakeViewer(a), { ...SITE });
      const en = (c: { x: number; z: number }) => sc.fromWorld(new THREE.Vector3(c.x, 0, c.z));
      const siteEN = [
        { x: site.min.x, z: site.min.y },
        { x: site.max.x, z: site.min.y },
        { x: site.max.x, z: site.max.y },
        { x: site.min.x, z: site.max.y },
      ].map(en);
      const lots = siteSideLots(site, PLAN_SIDES, roads);
      expect(lots).toHaveLength(4);
      for (const L of lots) {
        const lot = L.corners.map(en);
        const h = houseInLot(lot, { preset: 'gable2', frontEdgeIndex: L.frontEdge, label: sideLotLabel(L, a) });
        expect(h).not.toBeNull();
        const fp = plannedFootprint(h!);
        for (const p of fp) {
          expect(pointInPolygon(p, lot)).toBe(true);
          expect(pointInPolygon(p, siteEN)).toBe(false);
        }
        // 区画の辺と平行（ワールドで軸に沿う）
        const w = sc.toWorld(fp[1].e, fp[1].n).sub(sc.toWorld(fp[0].e, fp[0].n));
        expect(Math.min(Math.abs(w.x), Math.abs(w.z))).toBeLessThan(1e-6);
        // 道路側の辺から 2 m 以上（ワールドの座標で）
        const ws = fp.map((p) => sc.toWorld(p.e, p.n));
        const c = L.corners;
        const dist = [Math.min(...ws.map((q) => q.z - c[0].z)), Math.min(...ws.map((q) => c[1].x - q.x)), Math.min(...ws.map((q) => c[2].z - q.z)), Math.min(...ws.map((q) => q.x - c[0].x))];
        expect(dist[L.frontEdge]).toBeGreaterThanOrEqual(2 - 1e-6);
        for (const d of dist) expect(d).toBeGreaterThanOrEqual(1 - 1e-6);
        expect(h!.label).toBe(sideLotLabel(L, a));
      }
    }
  });

  it('sideLotLabel: 隣（道路の向かいは 向かい）', () => {
    expect(sideLotLabel({ side: 'top', acrossRoad: false }, 0)).toBe('北隣の想定の家');
    expect(sideLotLabel({ side: 'bottom', acrossRoad: true }, 0)).toBe('南向かいの想定の家');
    expect(sideLotLabel({ side: 'left', acrossRoad: false }, 90)).toBe('南隣の想定の家');
  });
});

describe('一覧・編集の文言と値', () => {
  it('文言', () => {
    expect(PLANNED_BLOCK_TITLE).toBe('想定の家（未建築の隣家）');
    expect(PLANNED_MODE_LABEL).toBe('＋ 想定の家を置く');
    expect(PLANNED_MODE_ARMED).toContain('Esc');
    expect(PLANNED_INCLUDE_LABEL).toBe('想定の建物を含める（影・解析）');
    expect(PLANNED_SIDES_BUTTON).toBe('敷地の隣に想定の家');
    expect(plannedListTitle(3)).toBe('置いた想定の家（3 棟）');
    expect(plannedPresetOption('gable2')).toBe('2 階建て（切妻） 9.1×7.3 m・高さ 8.5 m');
    expect(PLANNED_PRESETS.map((p) => plannedPresetOption(p.id))).toHaveLength(7);
  });

  it('plannedSummary: 屋根・大きさ・高さ（陸屋根は高さだけ）', () => {
    expect(plannedSummary(houseFromPreset('gable2', 0, 0, 0))).toBe('切妻・9.1×7.3 m・軒 6.0 m・最高 8.5 m');
    expect(plannedSummary(houseFromPreset('flat3', 0, 0, 0))).toBe('陸屋根・8.0×8.0 m・高さ 9.5 m');
    expect(plannedSummary(houseFromPreset('shed2', 0, 0, 0))).toBe('片流れ・9.1×7.3 m・軒 5.5 m・最高 7.5 m');
  });

  it('presetPatch: 形だけ替え、位置・向き・名前はそのまま', () => {
    const cur = houseFromPreset('gable2', 3, -12, 77, { label: '北隣' });
    const next = clampHouse({ ...cur, ...presetPatch('hiraya') });
    expect(next).toMatchObject({ ce: 3, cn: -12, rotDeg: 77, label: '北隣', width: 12, depth: 8, eaveHeight: 3, ridgeHeight: 5, roof: 'gable', preset: 'hiraya' });
  });

  it('roofPatch: 陸屋根（棟 = 軒）を勾配屋根にすると棟を軒 + ROOF_RISE に上げる', () => {
    const flat = houseFromPreset('box', 0, 0, 0); // 7 m の箱
    expect(roofPatch(flat, 'gable')).toEqual({ roof: 'gable', ridgeHeight: 7 + ROOF_RISE.gable });
    expect(roofPatch(flat, 'hip')).toEqual({ roof: 'hip', ridgeHeight: 9 });
    expect(roofPatch(flat, 'shed')).toEqual({ roof: 'shed', ridgeHeight: 9 });
    expect(roofPatch(flat, 'flat')).toEqual({ roof: 'flat' });
    expect(roofPatch(houseFromPreset('gable2', 0, 0, 0), 'hip')).toEqual({ roof: 'hip' });
    // 陸屋根にすると clampHouse が棟 = 軒にする
    expect(clampHouse({ ...houseFromPreset('gable2', 0, 0, 0), ...roofPatch(houseFromPreset('gable2', 0, 0, 0), 'flat') })).toMatchObject({ roof: 'flat', eaveHeight: 6, ridgeHeight: 6 });
  });

  it('rotatedDeg: R = +90・Shift+R = −90、[0, 360)', () => {
    expect(rotatedDeg(350, 90)).toBe(80);
    expect(rotatedDeg(0, -90)).toBe(270);
    expect(rotatedDeg(270, 90)).toBe(0);
    expect(rotatedDeg(45, 360)).toBe(45);
  });

  it('duplicatePlanned: 棟の向きに 幅 + 1 m 並べた同じ家（id は付けない）', () => {
    const h = houseFromPreset('gable2', 2, -10, 90, { label: '3 号地', id: 'x1' });
    const d = duplicatePlanned(h);
    expect(d.id).toBeUndefined();
    expect(d.ce).toBeCloseTo(2 + 10.1, 9);
    expect(d.cn).toBeCloseTo(-10, 9);
    expect(d).toMatchObject({ width: 9.1, depth: 7.3, rotDeg: 90, roof: 'gable', label: '3 号地', preset: 'gable2' });
    const n = duplicatePlanned(houseFromPreset('box', 0, 0, 0), 2);
    expect(n.ce).toBeCloseTo(0, 9);
    expect(n.cn).toBeCloseTo(10, 9);
    // 並べた家は元の家と重ならない
    const a = plannedFootprint(h);
    const b = plannedFootprint(clampHouse(d));
    expect(Math.min(...b.map((p) => p.e))).toBeGreaterThan(Math.max(...a.map((p) => p.e)));
  });

  it('parseFieldNumber: 全角の数字・空白も読む。読めなければ null', () => {
    expect(parseFieldNumber('１２．５')).toBe(12.5);
    expect(parseFieldNumber(' 7 ')).toBe(7);
    expect(parseFieldNumber('')).toBeNull();
    expect(parseFieldNumber('abc')).toBeNull();
    expect(parseFieldNumber('-3')).toBe(-3);
  });
});
