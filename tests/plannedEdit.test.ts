// 日照ツール: 想定の家（未建築の隣家）を置く・直す画面（steps/plannedEdit.ts）の判定と操作
//  - クリックの判定（3 px）・置く向き（敷地の輪郭の主な辺／計画の建物の向き → 東西に近い軸を棟に）・名前の連番
//  - 回転・複製（棟の向きに 幅 + 2 m）・形（プリセット）・屋根・高さ・入力欄の値の解釈・計画の建物と同じ形の箱
//  - 重なりの判定と注意の文・ドラッグの移動量
//  - 操作はすべて 'neighbors' を 1 回だけ発火し、日照ステップの古い解析結果（日照時間マップ・日影図・測定点の結果・比較画像）が捨てられる
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLANNED_EAVE_OVERHANG, houseFromPreset, plannedFootprint, type PlannedHouse } from '../src/sun/plannedHouse';
import { on, plannedHouses, study, updatePlannedHouse } from '../src/sunstudy/state';
import {
  PLANNED_CLICK_PX,
  PLANNED_DUP_GAP,
  draggedCenter,
  duplicatePlanned,
  duplicatePlannedHouse,
  eastWestAxis,
  editPlannedField,
  heightPatch,
  isClickMove,
  movePlanned,
  nextPlannedLabel,
  nudgePlanned,
  overlapWarning,
  placePlanned,
  plannedFieldPatch,
  plannedHeightText,
  plannedPlacementRotation,
  plannedSizeText,
  presetOptionText,
  presetPatch,
  ringsOverlap,
  roofPatch,
  rotatePlanned,
  rotatedPatch,
  sameShapeHouse,
} from '../src/sunstudy/steps/plannedEdit';
// 日照ステップのモジュール（'neighbors' で古い解析結果を捨てる処理をモジュールの読み込み時に登録する）
import '../src/sunstudy/steps/simStep';
import { frameFromLocal } from '../src/sunstudy/types';
import type { EN } from '../src/sunstudy/types';
import { PLANNED_PRESETS } from '../src/sun/plannedHouse';

const FRAME = { lat: 35.6, lon: 139.6, address: 'テスト', groundElev: 10 };

/** 中心 (ce, cn)・幅 w・奥行 d の矩形を、辺の方位 rot（真北から時計回り）だけ回したもの */
function rotRect(ce: number, cn: number, w: number, d: number, rot: number): EN[] {
  return plannedFootprint({ ce, cn, width: w, depth: d, rotDeg: rot });
}

const gable = (over: Partial<PlannedHouse> = {}): PlannedHouse => ({ ...houseFromPreset('gable2', 0, -15, 90, { id: 'planned:t:1' }), ...over });

let events = 0;
let off: (() => void) | null = null;
beforeEach(() => {
  study.frame = { ...FRAME };
  study.sitePolygon = [];
  study.model = null;
  study.placement.headingDeg = 0;
  study.points = [];
  study.neighbors = [];
  study.neighborOverrides = {};
  study.plannedEnabled = true;
  study.results = { images: [] };
  events = 0;
  off = on('neighbors', () => events++);
});
afterEach(() => {
  off?.();
  off = null;
});

describe('クリックの判定・名前・向き', () => {
  it('押してから 3 px 以内で離せばクリック（回転・移動のドラッグでは置かない・選ばない）', () => {
    expect(PLANNED_CLICK_PX).toBe(3);
    expect(isClickMove({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(true);
    expect(isClickMove({ x: 10, y: 10 }, { x: 13, y: 10 })).toBe(true);
    expect(isClickMove({ x: 10, y: 10 }, { x: 12, y: 12 })).toBe(true);
    expect(isClickMove({ x: 10, y: 10 }, { x: 13, y: 11 })).toBe(false);
  });

  it('名前は「想定の家 N」の使われていない一番小さい番号', () => {
    expect(nextPlannedLabel([])).toBe('想定の家 1');
    expect(nextPlannedLabel(['想定の家 1', '想定の家 3', undefined, '南隣', ' 想定の家 2 '])).toBe('想定の家 4');
    expect(nextPlannedLabel(['想定の家 2', '想定の家'])).toBe('想定の家 1');
  });

  it('東西に近い軸を棟に（[0, 180)）', () => {
    expect(eastWestAxis(0)).toBe(90);
    expect(eastWestAxis(90)).toBe(90);
    expect(eastWestAxis(180)).toBe(90);
    expect(eastWestAxis(20)).toBe(110);
    expect(eastWestAxis(70)).toBe(70);
    expect(eastWestAxis(-30)).toBe(60);
    expect(eastWestAxis(45)).toBe(45);
    expect(eastWestAxis(135)).toBe(135);
  });

  it('置く向き: 敷地の輪郭の主な辺 → 計画の建物の向き → 真東西', () => {
    // 辺が 20° 回った敷地: 主な辺 20° と 110° のうち東西に近い 110°
    expect(plannedPlacementRotation(rotRect(0, 0, 15, 12, 20), 0)).toBeCloseTo(110, 6);
    // 敷地があれば計画の建物の向きより敷地
    expect(plannedPlacementRotation(rotRect(0, 0, 15, 12, 70), 10)).toBeCloseTo(70, 6);
    // 敷地が無ければ計画の建物の向き（図面の上が 30° → 棟は 120°）
    expect(plannedPlacementRotation(null, 30)).toBe(120);
    expect(plannedPlacementRotation([], 0)).toBe(90);
    // どちらも無ければ真東西
    expect(plannedPlacementRotation(null, null)).toBe(90);
    expect(plannedPlacementRotation(undefined, NaN)).toBe(90);
  });
});

describe('形を変える', () => {
  it('回転は時計回りが正・[0, 360)', () => {
    expect(rotatedPatch({ rotDeg: 270 }, 90)).toEqual({ rotDeg: 0 });
    expect(rotatedPatch({ rotDeg: 0 }, -90)).toEqual({ rotDeg: 270 });
    expect(rotatedPatch({ rotDeg: 359.999 }, 0)).toEqual({ rotDeg: 0 });
    expect(rotatedPatch({ rotDeg: 10 }, 725)).toEqual({ rotDeg: 15 });
  });

  it('複製は棟の向き（width の軸）に 幅 + 2 m ずらす（id なし・名前を付け直す・形はそのまま）', () => {
    const h = gable();
    const d = duplicatePlanned(h, '想定の家 2');
    expect(PLANNED_DUP_GAP).toBe(2);
    expect(d.id).toBeUndefined();
    expect(d.label).toBe('想定の家 2');
    // rotDeg 90: 棟は東西 → 東へ 9.1 + 2
    expect(d.ce).toBeCloseTo(h.ce + 11.1, 6);
    expect(d.cn).toBeCloseTo(h.cn, 6);
    expect([d.width, d.depth, d.eaveHeight, d.ridgeHeight, d.roof, d.rotDeg, d.preset]).toEqual([h.width, h.depth, h.eaveHeight, h.ridgeHeight, h.roof, h.rotDeg, h.preset]);
    // rotDeg 0: 棟は南北 → 北へ
    const n = duplicatePlanned(gable({ rotDeg: 0 }), 'x');
    expect(n.ce).toBeCloseTo(0, 6);
    expect(n.cn).toBeCloseTo(-15 + 11.1, 6);
    // 写しと元は重ならない
    expect(ringsOverlap(plannedFootprint(h), plannedFootprint({ ...h, ce: d.ce!, cn: d.cn! }))).toBe(false);
  });

  it('形（プリセット）は寸法・高さ・屋根だけを変える', () => {
    expect(presetPatch('hiraya')).toEqual({ preset: 'hiraya', width: 12, depth: 8, eaveHeight: 3, ridgeHeight: 5, roof: 'gable' });
    expect(presetPatch('flat3')).toEqual({ preset: 'flat3', width: 8, depth: 8, eaveHeight: 9.5, ridgeHeight: 9.5, roof: 'flat' });
  });

  it('屋根: 陸屋根へは最高高さ = 軒高、陸屋根から勾配屋根へは標準の勾配で上げる、勾配屋根どうしは高さそのまま', () => {
    const h = gable();
    expect(roofPatch(h, 'gable')).toEqual({});
    expect(roofPatch(h, 'flat')).toEqual({ roof: 'flat', ridgeHeight: 6 });
    expect(roofPatch(h, 'hip')).toEqual({ roof: 'hip' });
    const f = gable({ roof: 'flat', ridgeHeight: 6 });
    expect(roofPatch(f, 'gable')).toEqual({ roof: 'gable', ridgeHeight: Math.round((6 + 3.65 * 0.6) * 100) / 100 });
    expect(roofPatch(f, 'hip')).toEqual({ roof: 'hip', ridgeHeight: Math.round((6 + 3.65 * 0.55) * 100) / 100 });
    expect(roofPatch(f, 'shed')).toEqual({ roof: 'shed', ridgeHeight: Math.round((6 + (7.3 + PLANNED_EAVE_OVERHANG) * 0.26) * 100) / 100 });
  });

  it('高さ: 入力した値がそのまま残る（軒高 > 最高高さなら最高高さも、最高高さ < 軒高なら軒高も）。陸屋根は両方', () => {
    const h = gable();
    expect(heightPatch(h, 'eaveHeight', 5)).toEqual({ eaveHeight: 5 });
    expect(heightPatch(h, 'eaveHeight', 9)).toEqual({ eaveHeight: 9, ridgeHeight: 9 });
    expect(heightPatch(h, 'ridgeHeight', 10)).toEqual({ ridgeHeight: 10 });
    expect(heightPatch(h, 'ridgeHeight', 4)).toEqual({ eaveHeight: 4, ridgeHeight: 4 });
    expect(heightPatch(gable({ roof: 'flat', ridgeHeight: 6 }), 'ridgeHeight', 7)).toEqual({ eaveHeight: 7, ridgeHeight: 7 });
    expect(heightPatch(h, 'ridgeHeight', 0.5)).toEqual({ eaveHeight: 1, ridgeHeight: 1 });
    expect(heightPatch(h, 'ridgeHeight', 0)).toBeNull();
    expect(heightPatch(h, 'ridgeHeight', NaN)).toBeNull();
  });

  it('入力欄の値の解釈（受け付けない値は null）', () => {
    const h = gable();
    expect(plannedFieldPatch(h, 'label', '  南隣  ')).toEqual({ label: '南隣' });
    expect(plannedFieldPatch(h, 'label', '')).toEqual({ label: '' });
    expect(plannedFieldPatch(h, 'preset', 'apartment2')).toEqual(presetPatch('apartment2'));
    expect(plannedFieldPatch(h, 'preset', '')).toBeNull();
    expect(plannedFieldPatch(h, 'width', '12.5')).toEqual({ width: 12.5 });
    expect(plannedFieldPatch(h, 'depth', '0.4')).toEqual({ depth: 1 });
    expect(plannedFieldPatch(h, 'width', '-3')).toBeNull();
    expect(plannedFieldPatch(h, 'width', '')).toBeNull();
    expect(plannedFieldPatch(h, 'width', 'abc')).toBeNull();
    expect(plannedFieldPatch(h, 'rotDeg', '450')).toEqual({ rotDeg: 90 });
    expect(plannedFieldPatch(h, 'rotDeg', '-90')).toEqual({ rotDeg: 270 });
    expect(plannedFieldPatch(h, 'roof', 'shed')).toEqual({ roof: 'shed' });
    expect(plannedFieldPatch(h, 'roof', 'dome')).toBeNull();
    expect(plannedFieldPatch(h, 'eaveHeight', '7')).toEqual({ eaveHeight: 7 });
    expect(plannedFieldPatch(h, 'ridgeHeight', '5')).toEqual({ eaveHeight: 5, ridgeHeight: 5 });
  });

  it('計画の建物と同じ形: 幅×奥行×高さの陸屋根の箱、幅は図面の横（真北から headingDeg + 90°）', () => {
    const s = sameShapeHouse({ w: 10.3, d: 8.794, h: 8.2 }, 30, 1.234, -5.678, '想定の家 1');
    expect(s).toEqual({ ce: 1.23, cn: -5.68, width: 10.3, depth: 8.79, rotDeg: 120, eaveHeight: 8.2, ridgeHeight: 8.2, roof: 'flat', label: '想定の家 1' });
    expect(sameShapeHouse({ w: 0.2, d: 5, h: 0 }, 300, 0, 0, 'x')).toMatchObject({ width: 1, rotDeg: 30, eaveHeight: 1, ridgeHeight: 1 });
  });

  it('寸法・高さ・選択肢の文', () => {
    expect(plannedSizeText(gable())).toBe('9.1×7.3 m');
    expect(plannedHeightText(gable())).toBe('軒高 6 m／最高 8.5 m');
    expect(plannedHeightText(gable({ roof: 'flat', ridgeHeight: 6 }))).toBe('高さ 6 m');
    expect(PLANNED_PRESETS.map(presetOptionText)).toEqual([
      '平屋（切妻）　12×8 m・最高 5 m',
      '2 階建て（切妻）　9.1×7.3 m・最高 8.5 m',
      '2 階建て（片流れ）　9.1×7.3 m・最高 7.5 m',
      '2 階建て（寄棟）　9.1×7.3 m・最高 8 m',
      '3 階建て（陸屋根）　8×8 m・高さ 9.5 m',
      'アパート 2 階（陸屋根）　16×9 m・高さ 7 m',
      '箱（高さだけ）　8×8 m・高さ 7 m',
    ]);
  });
});

describe('重なり・ドラッグ', () => {
  const sq = (e0: number, n0: number, s: number): EN[] => [
    { e: e0, n: n0 },
    { e: e0 + s, n: n0 },
    { e: e0 + s, n: n0 + s },
    { e: e0, n: n0 + s },
  ];
  it('重なり: 頂点が内側・含む・辺が交わる（十字）は重なる、離れていれば重ならない', () => {
    expect(ringsOverlap(sq(0, 0, 10), sq(5, 5, 10))).toBe(true);
    expect(ringsOverlap(sq(0, 0, 10), sq(2, 2, 3))).toBe(true);
    expect(ringsOverlap(sq(2, 2, 3), sq(0, 0, 10))).toBe(true);
    const horiz = [
      { e: -10, n: -1 },
      { e: 10, n: -1 },
      { e: 10, n: 1 },
      { e: -10, n: 1 },
    ];
    const vert = horiz.map((p) => ({ e: p.n, n: p.e }));
    expect(ringsOverlap(horiz, vert)).toBe(true);
    expect(ringsOverlap(sq(0, 0, 10), sq(10.01, 0, 10))).toBe(false);
    expect(ringsOverlap(sq(0, 0, 10), [])).toBe(false);
  });

  it('注意の文: 計画の建物 → 敷地の輪郭の順、重ならなければ null', () => {
    const h = gable({ ce: 0, cn: 0 });
    expect(overlapWarning(h, sq(-2, -2, 4), null)).toMatch(/計画の建物と重なっています/);
    expect(overlapWarning(h, sq(30, 30, 4), sq(-20, -1, 40))).toMatch(/敷地の輪郭に重なっています/);
    expect(overlapWarning(h, sq(30, 30, 4), sq(-20, 10, 40))).toBeNull();
    expect(overlapWarning(h, null, null)).toBeNull();
  });

  it('ドラッグ: 掴んだ点の水平の動き（x = 東、z = 南）だけ中心を動かす（0.01 m に丸める）', () => {
    expect(draggedCenter({ ce: 1, cn: 2 }, { x: 10, z: 10 }, { x: 13.456, z: 6 })).toEqual({ ce: 4.46, cn: 6 });
  });
});

describe('操作は state を通す（\'neighbors\' を 1 回・古い解析結果を捨てる）', () => {
  /** 日照ステップの解析結果がある状態にする */
  const fakeResults = () => {
    study.results.heatmapUrl = 'data:heat';
    study.results.heatmapLabel = 'x';
    study.results.diagramSvg = '<svg/>';
    study.results.images = [{ label: 'a', url: 'data:a' }];
    study.points = [{ id: 'p1', label: '測定点1', pos: [0, 1, 0], normal: [0, 0, 1], results: [{ dateId: 'winter', dateLabel: '冬至', month: 12, day: 22, hours: 3, first: 9, last: 12, spans: [[9, 12]] }] }];
  };
  const resultsGone = () => !study.results.heatmapUrl && !study.results.diagramSvg && study.results.images.length === 0 && study.points.every((p) => !p.results);

  it('置く: 名前の連番・敷地の輪郭に揃えた向き・\'neighbors\' 1 回・結果を捨てる', () => {
    fakeResults();
    // 主な辺が 20° の敷地（ピンの南東）
    study.sitePolygon = rotRect(0, 0, 15, 12, 20).map((p) => frameFromLocal(FRAME, p.e, p.n));
    const a = placePlanned({ kind: 'preset', id: 'gable2' }, 3, -20);
    expect(a).not.toBeNull();
    expect(events).toBe(1);
    expect(resultsGone()).toBe(true);
    expect(a!.planned).toMatchObject({ ce: 3, cn: -20, preset: 'gable2', label: '想定の家 1', width: 9.1, roof: 'gable' });
    expect(a!.planned.rotDeg).toBeCloseTo(110, 1);
    const b = placePlanned({ kind: 'preset', id: 'flat3' }, 20, -20);
    expect(b!.planned).toMatchObject({ preset: 'flat3', label: '想定の家 2', roof: 'flat' });
    expect(events).toBe(2);
    // 敷地が無く計画の建物も無ければ真東西
    study.sitePolygon = [];
    expect(placePlanned({ kind: 'preset', id: 'hiraya' }, 0, 30)!.planned.rotDeg).toBe(90);
    expect(plannedHouses().map((n) => n.planned.label)).toEqual(['想定の家 1', '想定の家 2', '想定の家 3']);
  });

  it('計画の建物が無ければ「同じ形」は置かない（イベントなし）', () => {
    expect(placePlanned({ kind: 'same' }, 0, -20)).toBeNull();
    expect(events).toBe(0);
    expect(plannedHouses()).toHaveLength(0);
  });

  it('動かす・ずらす・回す・複製・入力欄: どれも 1 回だけ発火して結果を捨てる。変わらない・受け付けない値は発火しない', () => {
    const a = placePlanned({ kind: 'preset', id: 'gable2' }, 0, -15)!;
    const id = a.id;
    events = 0;

    fakeResults();
    expect(movePlanned(id, 5.004, -16)).toBe(true);
    expect(events).toBe(1);
    expect(resultsGone()).toBe(true);
    expect(plannedHouses()[0].planned).toMatchObject({ ce: 5, cn: -16 });
    expect(plannedHouses()[0].ring).toEqual(plannedFootprint(plannedHouses()[0].planned));
    expect(movePlanned(id, 5, -16)).toBe(false);
    expect(events).toBe(1);

    fakeResults();
    expect(nudgePlanned(id, 0, 0.1)).toBe(true);
    expect(plannedHouses()[0].planned.cn).toBeCloseTo(-15.9, 6);
    expect(events).toBe(2);
    expect(resultsGone()).toBe(true);

    fakeResults();
    expect(rotatePlanned(id, 90)).toBe(true);
    expect(plannedHouses()[0].planned.rotDeg).toBe(180);
    expect(rotatePlanned(id, -90)).toBe(true);
    expect(plannedHouses()[0].planned.rotDeg).toBe(90);
    expect(events).toBe(4);
    expect(resultsGone()).toBe(true);

    fakeResults();
    const d = duplicatePlannedHouse(id)!;
    expect(events).toBe(5);
    expect(resultsGone()).toBe(true);
    expect(d.planned.label).toBe('想定の家 2');
    expect(d.planned.ce).toBeCloseTo(5 + 9.1 + 2, 6);
    expect(d.id).not.toBe(id);

    fakeResults();
    expect(editPlannedField(id, 'width', '11')).toBe(true);
    expect(events).toBe(6);
    expect(resultsGone()).toBe(true);
    expect(editPlannedField(id, 'width', '-1')).toBe(false);
    expect(editPlannedField(id, 'width', '11')).toBe(false);
    expect(editPlannedField(id, 'roof', 'gable')).toBe(false);
    expect(editPlannedField('planned:none', 'width', '5')).toBe(false);
    expect(events).toBe(6);
    expect(editPlannedField(id, 'roof', 'flat')).toBe(true);
    expect(plannedHouses()[0].planned).toMatchObject({ roof: 'flat', eaveHeight: 6, ridgeHeight: 6 });
    expect(plannedHouses()[0].height).toBe(6);
    expect(editPlannedField(id, 'preset', 'gable2')).toBe(true);
    expect(plannedHouses()[0].planned).toMatchObject({ preset: 'gable2', roof: 'gable', width: 9.1, ridgeHeight: 8.5, ce: 5, rotDeg: 90, label: '想定の家 1' });
    expect(editPlannedField(id, 'label', '南隣')).toBe(true);
    expect(plannedHouses()[0].label).toBe('南隣');
    expect(events).toBe(9);
  });

  it('含めない間に動かしても state は変わり（一覧に残る）、含めると新しい位置で戻る', () => {
    const a = placePlanned({ kind: 'preset', id: 'gable2' }, 0, -15)!;
    study.plannedEnabled = false;
    events = 0;
    expect(movePlanned(a.id, 1, -15)).toBe(true);
    expect(events).toBe(1);
    expect(plannedHouses()[0].planned.ce).toBe(1);
    // ring・height を直接変えられても中心・高さが追従する（ピンの移動など）
    plannedHouses()[0].ring = plannedHouses()[0].ring.map((p) => ({ e: p.e + 2, n: p.n }));
    expect(updatePlannedHouse(a.id, { rotDeg: 0 })).toBe(true);
    expect(plannedHouses()[0].planned.ce).toBeCloseTo(3, 6);
  });
});
