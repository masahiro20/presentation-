/**
 * 日照ステップ（プレゼン側）の「表示だけ隠す／計算から除外」と理由・注記のテスト:
 *  - 隠す記録の読み込み（normalizeHideRecord・hideRecordOf）: mode・reason の無い古い記録は 計算から除外・その他
 *  - SunContext: 表示だけ隠した建物は影だけのメッシュ（castShadow・colorWrite/depthWrite なし・receiveShadow なし・
 *    userData.neighbor）で遮蔽物（buildOccluder）に残り、計算から除外した建物は残らない。薄い表示はどちらも遮蔽物に入らない
 *  - 隠し方・理由は取り直し（loadNeighbors）・外形での当て直しの後も残る。隠し方の切り替え
 *  - 注記（collectDisclosure・disclosureLines・excludedTableRows・appendSvgFootnote）
 *  - 日影図の描き方（規制値のプリセット・30 分ごと）の選択と文言
 */
import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { metersPerDegree, toLocal, type NeighborBuilding, type SiteLocation } from '../src/sun/geo';

const fake = vi.hoisted(() => ({ gsi: [] as { ll: { lat: number; lon: number }[]; height: number }[] }));
vi.mock('../src/sun/geo', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/sun/geo')>();
  const make = async (lat: number, lon: number): Promise<NeighborBuilding[]> => fake.gsi.map((f) => ({ ring: f.ll.map((p) => mod.toLocal(p.lat, p.lon, lat, lon)), height: f.height, source: 'gsi' as const }));
  return { ...mod, fetchGsiBuildings: vi.fn(make), fetchOsmBuildings: vi.fn(make) };
});

import {
  GHOST_OPACITY,
  GHOST_VIEW_COLOR,
  HIDE_MODE_NAME,
  HIDE_REASON_LABEL,
  LEGACY_HIDE_RECORD,
  SunContext,
  emptyEdits,
  hideReasonText,
  hideRecordOf,
  normalizeHideRecord,
  reapplyEdits,
  neighborKey,
  absoluteEN,
  type LatLon,
} from '../src/sun/context';
import { buildOccluder, isShaded, SHADOW_REGION_HOURS } from '../src/sun/analysis';
import { appendSvgFootnote, collectDisclosure, disclosureLines, excludedLine, excludedTableRows, reasonCountsText, viewOnlyLine, DIAGRAM_NEIGHBORS_NOTE, NO_NEIGHBORS_DISCLOSURE, type HiddenEntry } from '../src/app/sunDisclosure';
import { HALF_HOUR_LABEL, REGULATION_NONE_LABEL, clearedSunResults, diagramOptions, diagramSummaryText, hiddenGroupTitle, hiddenToastText, hideReasonOption, modeChangedToastText, restoredToastText } from '../src/app/steps/sunStep';
import { deckDisclosure, EXCLUDED_ROWS_PER_SLIDE } from '../src/app/steps/presentStep';
import type { Viewer } from '../src/scene/viewer';

const PIN: LatLon = { lat: 35.6045, lon: 139.6689 };
const { mLat, mLon } = metersPerDegree(PIN.lat);
const ll = (e: number, n: number) => ({ lat: PIN.lat + n / mLat, lon: PIN.lon + e / mLon });
const rectLL = (e0: number, n0: number, w: number, d: number) => [ll(e0, n0), ll(e0 + w, n0), ll(e0 + w, n0 + d), ll(e0, n0 + d)];
const SITE: SiteLocation = { lat: PIN.lat, lon: PIN.lon, address: '世田谷区奥沢', offsetE: 0, offsetN: 0 };

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
const neighborMeshes = (v: Viewer) => {
  let n = 0;
  v.groups.context.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.userData.neighbor) n++;
  });
  return n;
};
/** 太陽: 南の高度 30°（ワールドの北は -z、南は +z） */
const SUN_SOUTH_30 = new THREE.Vector3(0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)).normalize();

describe('隠す記録の読み込み（古い記録は 計算から除外・その他）', () => {
  it('mode・reason が無い／知らない値なら 計算から除外・その他。note は前後の空白を落とし、空なら付けない', () => {
    expect(normalizeHideRecord(undefined)).toEqual({ mode: 'exclude', reason: 'other' });
    expect(normalizeHideRecord(null)).toEqual({ mode: 'exclude', reason: 'other' });
    expect(normalizeHideRecord(true)).toEqual({ mode: 'exclude', reason: 'other' });
    expect(normalizeHideRecord({})).toEqual(LEGACY_HIDE_RECORD);
    expect(normalizeHideRecord({ mode: 'hidden', reason: 'gone' })).toEqual({ mode: 'exclude', reason: 'other' });
    expect(normalizeHideRecord({ mode: 'view', reason: 'demolish' })).toEqual({ mode: 'view', reason: 'demolish' });
    expect(normalizeHideRecord({ mode: 'exclude', reason: 'other', note: '  車庫の屋根 ' })).toEqual({ mode: 'exclude', reason: 'other', note: '車庫の屋根' });
    expect(normalizeHideRecord({ reason: 'dataError', note: '   ' })).toEqual({ mode: 'exclude', reason: 'dataError' });
    expect(normalizeHideRecord({ note: 'x'.repeat(300) }).note).toHaveLength(200);
  });
  it('隠したキーに隠し方の記録が無ければ（以前の「隠す」）計算から除外・その他。隠していなければ null', () => {
    const edits = emptyEdits();
    edits.hidden.add('gsi:1:2:30');
    expect(hideRecordOf(edits, 'gsi:1:2:30')).toEqual({ mode: 'exclude', reason: 'other' });
    expect(hideRecordOf(edits, 'gsi:9:9:30')).toBeNull();
    edits.hideInfo.set('gsi:1:2:30', { mode: 'view', reason: 'onSite' });
    expect(hideRecordOf(edits, 'gsi:1:2:30')).toEqual({ mode: 'view', reason: 'onSite' });
    // 記録だけ残っていても、隠していなければ null
    edits.hidden.delete('gsi:1:2:30');
    expect(hideRecordOf(edits, 'gsi:1:2:30')).toBeNull();
  });
  it('理由の表示（その他は自由記述を括弧で）・名前', () => {
    expect(hideReasonText({ reason: 'demolish' })).toBe('解体予定');
    expect(hideReasonText({ reason: 'other', note: '車庫の屋根' })).toBe('その他（車庫の屋根）');
    expect(HIDE_REASON_LABEL).toEqual({ demolish: '解体予定', onSite: '敷地内の既存建物', dataError: 'データの誤り', other: 'その他' });
    expect(HIDE_MODE_NAME).toEqual({ view: '表示だけ隠す（影・解析には残す）', exclude: '計算から除外' });
    expect(hideReasonOption('other')).toBe('その他（自由記述）');
    expect(hideReasonOption('onSite')).toBe('敷地内の既存建物');
  });
  it('外形で当て直す（キーがずれた）ときも隠し方・理由を付け替える。古い記録は付けない（計算から除外・その他のまま）', () => {
    const fetched = (lls: { lat: number; lon: number }[], o: LatLon): NeighborBuilding => ({ ring: lls.map((p) => toLocal(p.lat, p.lon, o.lat, o.lon)), height: 6.8, source: 'gsi' });
    const a = fetched(rectLL(-30, -25, 14, 11), PIN);
    const b = fetched(rectLL(12, -20, 9, 8), PIN);
    const edits = emptyEdits();
    for (const x of [a, b]) {
      const k = neighborKey(x, PIN);
      edits.hidden.add(k);
      edits.footprints.set(
        k,
        x.ring.map((p) => absoluteEN(p, PIN)),
      );
    }
    edits.hideInfo.set(neighborKey(a, PIN), { mode: 'view', reason: 'dataError', note: '形が違う' });
    // 0.3 m ずれた同じ建物（キーが変わる）
    const a2 = fetched(rectLL(-29.7, -24.8, 13.6, 11), PIN);
    const b2 = fetched(rectLL(12.2, -19.9, 9, 8), PIN);
    const list = [a2, b2];
    reapplyEdits(list, (x) => neighborKey(x, PIN), (x) => x.ring.map((p) => absoluteEN(p, PIN)), edits);
    expect(list.map((x) => !!x.hidden)).toEqual([true, true]);
    expect(hideRecordOf(edits, neighborKey(a2, PIN))).toEqual({ mode: 'view', reason: 'dataError', note: '形が違う' });
    expect(hideRecordOf(edits, neighborKey(b2, PIN))).toEqual({ mode: 'exclude', reason: 'other' });
    expect(edits.hideInfo.has(neighborKey(a, PIN))).toBe(false);
  });
});

describe('SunContext: 表示だけ隠す／計算から除外', () => {
  beforeEach(() => {
    fake.gsi = [
      { ll: rectLL(-5, -20, 10, 8), height: 12 }, // 南（計画建物の南 12〜20 m）
      { ll: rectLL(21, -20, 8, 8), height: 6.8 },
      { ll: rectLL(-15, 10, 10, 9), height: 12 },
      { ll: rectLL(-30, -25, 14, 11), height: 6.8 },
    ];
  });

  it('表示だけ隠した建物は影だけのメッシュで遮蔽物に残る。計算から除外した建物は残らない。薄い表示はどちらも遮蔽物に入らない', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    expect(await sc.loadNeighbors('gsi')).toBe(4);
    const keys = sc.state.neighbors.map((b) => sc.keyOf(b));
    const tri0 = buildOccluder(v).triangles;
    // 表示だけ隠す
    expect(sc.setHidden([keys[0]], true, { mode: 'view', reason: 'other', note: '視点を遮る' })).toBe(1);
    expect(neighborMeshes(v)).toBe(4);
    expect(buildOccluder(v).triangles).toBe(tri0);
    const shadow = (sc.neighborGroup.children as THREE.Mesh[]).find((m) => m.userData.neighborKey === keys[0])!;
    const smat = shadow.material as THREE.Material;
    expect(shadow.userData.shadowOnly).toBe(true);
    expect(shadow.userData.neighbor).toBe(true);
    expect(shadow.visible).toBe(true);
    expect(shadow.castShadow).toBe(true);
    expect(shadow.receiveShadow).toBe(false);
    expect(smat.colorWrite).toBe(false);
    expect(smat.depthWrite).toBe(false);
    expect(smat.visible).toBe(true);
    expect(shadow.userData.baseMaterial).toBeUndefined();
    expect(sc.hideRecord(keys[0])).toEqual({ mode: 'view', reason: 'other', note: '視点を遮る' });
    expect(sc.hiddenList('view').map((b) => sc.keyOf(b))).toEqual([keys[0]]);
    expect(sc.hiddenList('exclude')).toEqual([]);
    // 計算から除外
    expect(sc.setHidden([keys[1]], true, { mode: 'exclude', reason: 'demolish' })).toBe(1);
    expect(neighborMeshes(v)).toBe(3);
    const tri2 = buildOccluder(v).triangles;
    expect(tri2).toBeLessThan(tri0);
    // 薄い表示（モード中）は遮蔽物に入らない。表示だけ隠した建物は青み
    sc.setGhosts(true);
    expect(buildOccluder(v).triangles).toBe(tri2);
    const ghosts = sc.ghostGroup.children as THREE.Mesh[];
    expect(ghosts.map((g) => g.userData.hideMode).sort()).toEqual(['exclude', 'view']);
    for (const g of ghosts) {
      const mat = g.material as THREE.MeshStandardMaterial;
      expect(g.userData.neighbor).toBeUndefined();
      expect(g.castShadow).toBe(false);
      expect(g.userData.noShadow).toBe(true);
      expect(mat.opacity).toBe(GHOST_OPACITY);
      expect(mat.depthWrite).toBe(false);
      expect('#' + mat.color.getHexString()).toBe(g.userData.hideMode === 'view' ? GHOST_VIEW_COLOR : '#b9c0c8');
    }
    sc.setGhosts(false);
  });

  it('南の建物: 表示だけ隠しても計画建物の南面に影を落とし、計算から除外すると落とさない（部屋の日当たりと同じ遮蔽物）', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('gsi');
    const south = sc.keyOf(sc.state.neighbors[0]);
    // 計画建物の南面の前（ワールド z = +4.5、北は -z）、高さ 1 m
    const p = new THREE.Vector3(0, 1, 4.5);
    expect(isShaded(buildOccluder(v), p, SUN_SOUTH_30)).toBe(true);
    sc.setHidden([south], true, { mode: 'view', reason: 'other' });
    expect(isShaded(buildOccluder(v), p, SUN_SOUTH_30)).toBe(true);
    sc.setHideMode([south], 'exclude');
    expect(sc.hideRecord(south)?.mode).toBe('exclude');
    expect(isShaded(buildOccluder(v), p, SUN_SOUTH_30)).toBe(false);
    // 戻すと影に戻る
    sc.setHidden([south], false);
    expect(isShaded(buildOccluder(v), p, SUN_SOUTH_30)).toBe(true);
    expect(sc.hideRecord(south)).toBeNull();
    expect(sc.edits.hideInfo.has(south)).toBe(false);
  });

  it('隠し方の切り替え（理由はそのまま）。同じ隠し方なら変えない。setHidden で隠し方を変えても数える', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('gsi');
    const k = sc.keyOf(sc.state.neighbors[2]);
    sc.setHidden([k], true, { mode: 'exclude', reason: 'onSite' });
    expect(sc.setHideMode([k], 'exclude')).toBe(0);
    expect(sc.setHideMode([k], 'view')).toBe(1);
    expect(sc.hideRecord(k)).toEqual({ mode: 'view', reason: 'onSite' });
    expect(neighborMeshes(v)).toBe(4);
    expect(sc.setHidden([k], true, { mode: 'exclude', reason: 'dataError' })).toBe(1);
    expect(sc.hideRecord(k)).toEqual({ mode: 'exclude', reason: 'dataError' });
    expect(sc.setHidden([k], true, { mode: 'exclude', reason: 'demolish' })).toBe(0);
    expect(sc.hideRecord(k)?.reason).toBe('demolish');
    // 隠していない建物の隠し方は変えられない
    expect(sc.setHideMode([sc.keyOf(sc.state.neighbors[1])], 'view')).toBe(0);
  });

  it('隠し方・理由は取り直し（ピンを動かした後）も残る。すべて戻す・すべて消すで消える', async () => {
    const v = fakeViewer();
    const site = { ...SITE };
    const sc = new SunContext(v, site);
    await sc.loadNeighbors('gsi');
    const [k0, k1] = sc.state.neighbors.map((b) => sc.keyOf(b));
    sc.setHidden([k0], true, { mode: 'view', reason: 'other', note: 'カメラの前' });
    sc.setHidden([k1], true, { mode: 'exclude', reason: 'demolish' });
    sc.state.site = { ...site, offsetN: 2 };
    await sc.loadNeighbors('gsi');
    expect(sc.hideRecord(k0)).toEqual({ mode: 'view', reason: 'other', note: 'カメラの前' });
    expect(sc.hideRecord(k1)).toEqual({ mode: 'exclude', reason: 'demolish' });
    expect(neighborMeshes(v)).toBe(3);
    expect((sc.neighborGroup.children as THREE.Mesh[]).filter((m) => m.userData.shadowOnly).map((m) => m.userData.neighborKey)).toEqual([k0]);
    expect(sc.restoreAll()).toBe(2);
    expect(sc.edits.hideInfo.size).toBe(0);
    sc.setHidden([k0], true, { mode: 'view' });
    sc.clearNeighbors();
    expect(sc.edits.hideInfo.size).toBe(0);
  });

  it('古い記録（隠したキーだけ）を当て直すと 計算から除外（影だけのメッシュを作らない）', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('gsi');
    const k = sc.keyOf(sc.state.neighbors[3]);
    sc.edits.hidden.add(k);
    await sc.loadNeighbors('gsi');
    expect(sc.hideRecord(k)).toEqual({ mode: 'exclude', reason: 'other' });
    expect(sc.hiddenList('exclude').length).toBe(1);
    expect(neighborMeshes(v)).toBe(3);
    expect((sc.neighborGroup.children as THREE.Mesh[]).some((m) => m.userData.shadowOnly)).toBe(false);
  });

  it('pickNeighbor: 表示だけ隠した建物の影だけのメッシュは拾わない（薄い表示の間だけ、隠した建物として拾う）', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('gsi');
    const b = sc.state.neighbors[2];
    const k = sc.keyOf(b);
    const ndc = () => {
      const c = b.ring.reduce((s, p) => ({ e: s.e + p.e / b.ring.length, n: s.n + p.n / b.ring.length }), { e: 0, n: 0 });
      const p = sc.toWorld(c.e, c.n, sc.heightOf(b)).project(v.camera);
      return new THREE.Vector2(p.x, p.y);
    };
    expect(sc.pickNeighbor(ndc())).toEqual({ key: k, hidden: false });
    sc.setHidden([k], true, { mode: 'view' });
    expect(sc.pickNeighbor(ndc())).toBeNull();
    sc.setGhosts(true);
    expect(sc.pickNeighbor(ndc())).toEqual({ key: k, hidden: true });
    sc.setGhosts(false);
  });

  it('collectDisclosure: 影・解析に入れた数（表示だけ隠した建物を含む）・除外・表示だけ隠した建物（出典・高さ・理由・方向距離）', async () => {
    const v = fakeViewer();
    const sc = new SunContext(v, { ...SITE });
    await sc.loadNeighbors('gsi');
    const keys = sc.state.neighbors.map((b) => sc.keyOf(b));
    sc.setHeight(keys[1], 9.5);
    sc.setHidden([keys[0]], true, { mode: 'view', reason: 'other' });
    sc.setHidden([keys[1]], true, { mode: 'exclude', reason: 'demolish' });
    sc.setHidden([keys[3]], true, { mode: 'exclude', reason: 'other', note: '車庫の屋根' });
    const d = collectDisclosure(sc);
    expect(d.included).toBe(2);
    expect(d.viewOnly.map((e) => e.key)).toEqual([keys[0]]);
    expect(d.excluded.map((e) => e.key)).toEqual([keys[1], keys[3]]);
    expect(d.excluded[0]).toMatchObject({ source: 'gsi', height: 9.5, heightEdited: true, mode: 'exclude', reason: 'demolish', title: '国土地理院の建物' });
    expect(d.excluded[0].where).toMatch(/^南東 約 \d+ m$/);
    expect(d.excluded[1].note).toBe('車庫の屋根');
    expect(excludedLine(d)).toBe('計算から除外した周辺建物 2 棟（解体予定 1・その他 1）');
    expect(viewOnlyLine(d)).toBe('表示だけ隠した建物 1 棟（影・解析には含む）');
    const rows = excludedTableRows(d);
    expect(rows[0]).toEqual({ no: 1, source: '国土地理院', height: '9.5 m（手入力）', reason: '解体予定', where: d.excluded[0].where });
    expect(rows[1]).toMatchObject({ no: 2, height: '6.8 m（推定）', reason: 'その他（車庫の屋根）' });
    expect(collectDisclosure(null)).toEqual({ included: 0, excluded: [], viewOnly: [] });
  });
});

describe('注記の文言', () => {
  const entry = (reason: HiddenEntry['reason'], mode: HiddenEntry['mode'] = 'exclude'): HiddenEntry => ({ key: reason, title: '隣家', source: 'manual', height: 7, heightEdited: false, mode, reason, where: '南 約 9 m' });
  it('理由ごとの棟数は 解体予定・敷地内の既存建物・データの誤り・その他 の順', () => {
    expect(reasonCountsText([entry('other'), entry('demolish'), entry('dataError'), entry('demolish'), entry('onSite')])).toBe('解体予定 2・敷地内の既存建物 1・データの誤り 1・その他 1');
    expect(reasonCountsText([])).toBe('');
  });
  it('除外は無くても「なし」と書く。表示だけ隠した建物は無ければ書かない', () => {
    expect(excludedLine({ excluded: [] })).toBe('計算から除外した周辺建物 なし');
    expect(viewOnlyLine({ viewOnly: [] })).toBeNull();
  });
  it('日影図: 「周辺建物は日影図に含めていません」＋ 除外 ＋ 表示だけ隠した建物', () => {
    const d = { included: 5, excluded: [entry('demolish')], viewOnly: [entry('other', 'view'), entry('other', 'view')] };
    const lines = disclosureLines(d, 'diagram');
    expect(lines[0]).toBe(DIAGRAM_NEIGHBORS_NOTE);
    expect(lines[0]).toContain('周辺建物は日影図に含めていません');
    expect(lines.slice(1)).toEqual(['計算から除外した周辺建物 1 棟（解体予定 1）', '表示だけ隠した建物 2 棟（影・解析には含む）']);
    // 周辺建物が無くても日影図の注記は同じ形
    expect(disclosureLines(NO_NEIGHBORS_DISCLOSURE, 'diagram')).toEqual([DIAGRAM_NEIGHBORS_NOTE, '計算から除外した周辺建物 なし']);
  });
  it('部屋の日当たり・日照時間マップ・資料: 周辺建物 N 棟の影を含めたか ＋ 除外 ＋ 表示だけ隠した建物', () => {
    const d = { included: 5, excluded: [entry('demolish')], viewOnly: [entry('other', 'view')] };
    expect(disclosureLines(d, 'rooms')).toEqual(['※部屋の日当たりは周辺建物 5 棟の影を含めて計算しています', '計算から除外した周辺建物 1 棟（解体予定 1）', '表示だけ隠した建物 1 棟（影・解析には含む）']);
    expect(disclosureLines(d, 'heatmap')[0]).toBe('※日照時間マップは周辺建物 5 棟の影を含めて計算しています');
    expect(disclosureLines(d, 'deck')[0]).toBe('※日当たりの解析は周辺建物 5 棟の影を含めて計算しています');
    expect(disclosureLines({ included: 3, excluded: [], viewOnly: [] }, 'rooms')).toEqual(['※部屋の日当たりは周辺建物 3 棟の影を含めて計算しています', '計算から除外した周辺建物 なし']);
    expect(disclosureLines(NO_NEIGHBORS_DISCLOSURE, 'deck')).toEqual(['※日当たりの解析は周辺建物を読み込まずに計算しています（計画建物の影のみ）']);
    // すべて除外した（影に入れた建物 0 棟）ときも除外の行を書く
    expect(disclosureLines({ included: 0, excluded: [entry('dataError')], viewOnly: [] }, 'rooms')).toEqual(['※部屋の日当たりは周辺建物 0 棟の影を含めて計算しています', '計算から除外した周辺建物 1 棟（データの誤り 1）']);
  });
  it('資料: 解析した時点の写しを優先し、無ければ今の扱い、それも無ければ周辺建物なし', () => {
    const saved = { included: 1, excluded: [], viewOnly: [] };
    const now = { included: 2, excluded: [entry('demolish')], viewOnly: [] };
    expect(deckDisclosure(saved, now)).toBe(saved);
    expect(deckDisclosure(undefined, now)).toBe(now);
    expect(deckDisclosure(undefined, null)).toEqual(NO_NEIGHBORS_DISCLOSURE);
    expect(EXCLUDED_ROWS_PER_SLIDE).toBeGreaterThanOrEqual(8);
  });
  it('案内の文言（隠し方ごと）', () => {
    expect(hiddenToastText(2)).toBe('2 棟を隠しました（影・解析からも外しています。「隠した建物」から戻せます）');
    expect(hiddenToastText(2, 'exclude')).toBe(hiddenToastText(2));
    expect(hiddenToastText(1, 'view')).toBe('1 棟を表示だけ隠しました（影・解析には残しています。「隠した建物」から戻せます）');
    expect(modeChangedToastText(1, 'view')).toMatch(/表示だけ隠す/);
    expect(modeChangedToastText(1, 'exclude')).toMatch(/計算から除外/);
    expect(restoredToastText(1, true)).toMatch(/^1 棟を戻しました（3D に表示します/);
    expect(hiddenGroupTitle('exclude', 3)).toBe('計算から除外（3 棟）');
    expect(hiddenGroupTitle('view', 1)).toBe('表示だけ隠す（1 棟）');
  });
  it('解析結果を捨てるときは注記の写しも捨てる', () => {
    const r = clearedSunResults({ seasons: [], highlights: [], images: [], disclosure: { included: 1, excluded: [], viewOnly: [] } });
    expect(r.sun.disclosure).toBeUndefined();
  });
});

describe('日影図の SVG に注記を足す', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3400 -3650 6800 7500" font-family="x"><rect x="-3400" y="-3650" width="6800" height="7500" fill="#fff"/><path d="M0 0"/><text x="1" y="2" font-size="75" fill="#555">凡例</text></svg>`;
  it('viewBox の高さを伸ばし、白地の上に凡例と同じ大きさで書く（XML の特殊文字は逃がす）', () => {
    const out = appendSvgFootnote(svg, ['※周辺建物は日影図に含めていません', 'その他（A&B <c>）']);
    const vb = /viewBox="([^"]+)"/.exec(out)![1].split(' ').map(Number);
    expect(vb.slice(0, 3)).toEqual([-3400, -3650, 6800]);
    expect(vb[3]).toBeCloseTo(7500 + 75 * 1.6 * 2 + 75 * 0.9, 6);
    expect(out).toContain('font-size="75" fill="#333" font-weight="bold">※周辺建物は日影図に含めていません</text>');
    expect(out).toContain('その他（A&amp;B &lt;c&gt;）');
    expect(out.endsWith('</g></svg>')).toBe(true);
    expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox=')).toBe(true);
    // もう一度足すと前の注記を置き換える（2 重にならない・高さも 1 回分）
    const again = appendSvgFootnote(out, ['1 行']);
    expect(again.match(/data-disclosure="1"/g)?.length).toBe(1);
    expect(Number(/viewBox="([^"]+)"/.exec(again)![1].split(' ')[3])).toBeCloseTo(7500 + 75 * 1.6 + 75 * 0.9, 6);
    expect(again).not.toContain('周辺建物は日影図に含めていません');
  });
  it('行が無い・viewBox が読めないときはそのまま', () => {
    expect(appendSvgFootnote(svg, [])).toBe(svg);
    expect(appendSvgFootnote('<svg><g/></svg>', ['a'])).toBe('<svg><g/></svg>');
  });
});

describe('日影図の描き方（規制値・30 分ごと）', () => {
  it('なし: 参考の 2〜5 時間・真太陽時 8〜16 時・毎正時', () => {
    expect(REGULATION_NONE_LABEL).toBe('なし（参考の 2〜5 時間）');
    expect(diagramOptions('', false)).toEqual({ timeLineIntervalMin: 60, hours: [8, 16] });
  });
  it('一般（二）: 規制時間 4・2.5 時間・8〜16 時。30 分ごと', () => {
    const o = diagramOptions('general-2', true);
    expect(o.timeLineIntervalMin).toBe(30);
    expect(o.hours).toEqual([8, 16]);
    expect(o.regulation).toMatchObject({ limitNear: 4, limitFar: 2.5, label: '一般（二）' });
    expect(HALF_HOUR_LABEL).toBe('時刻日影線を 30 分ごと');
  });
  it('北海道のプリセットは真太陽時 9〜15 時', () => {
    for (const id of ['hokkaido-1', 'hokkaido-2', 'hokkaido-3']) expect(diagramOptions(id, false).hours).toEqual([...SHADOW_REGION_HOURS.hokkaido]);
    expect(diagramOptions('hokkaido-1', false).regulation).toMatchObject({ limitNear: 2, limitFar: 1.5 });
    // 知らない値は「なし」
    expect(diagramOptions('unknown', false).regulation).toBeUndefined();
  });
  it('集計の文言（規制の線は添え書き）', () => {
    expect(
      diagramSummaryText([
        { hour: 2.5, maxDist: 7.25, role: 'limitFar' },
        { hour: 3, maxDist: 5 },
        { hour: 4, maxDist: 3.04, role: 'limitNear' },
      ]),
    ).toBe('2.5時間日影（10m 超の規制）: 敷地境界から最大 約7.3m／3時間日影: 敷地境界から最大 約5.0m／4時間日影（5〜10m の規制）: 敷地境界から最大 約3.0m');
  });
});
