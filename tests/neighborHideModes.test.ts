// 周辺建物の隠し方（計算から除外／表示だけ隠す）・理由・開示（日影図の脚注・レポートの表）・日影図の規制値の選択
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bakeWorldTriangles } from '../src/sun/analysis';
import { SHADOW_REGULATION_PRESETS, shadowRegulationPreset } from '../src/sun/shadowRegulation';
import { buildStudyOccluder, clearStudyOccluderCache, disposeStudyOccluder, shadowDiagramStudy } from '../src/sunstudy/analysis';
import { diagramHours, presetForRegion } from '../src/sunstudy/diagramOptions';
import { appendSvgFootnote, disclosureLines, excludedLine, hideReasonText, neighborDisclosure, neighborWhere, viewOnlyLine, wrapFootnote } from '../src/sunstudy/disclosure';
import {
  analysisNeighborsForScene,
  buildNeighborGhosts,
  buildNeighborShadowCasters,
  hiddenNeighborsForScene,
  neighborsForScene,
  rebuildEnvironment,
  shadowOnlyMaterial,
  siteExcludedCount,
  viewOnlyNeighborsForScene,
} from '../src/sunstudy/environment';
import { buildNeighborMeshes } from '../src/sunstudy/neighbors';
import { applyProject, sanitizeNeighborHide, sanitizeNeighborOverrides, serializeProject } from '../src/sunstudy/project';
import { buildReportHtml } from '../src/sunstudy/report';
import type { StudyScene } from '../src/sunstudy/scene';
import {
  analysisNeighbors,
  effectiveNeighbors,
  excludedNeighbors,
  getHideDefaults,
  hiddenNeighbors,
  normalizeHideInfo,
  on,
  restoreAllNeighbors,
  setHideDefaults,
  setNeighborsHidden,
  setNeighborsHideInfo,
  study,
  viewOnlyNeighbors,
  visibleNeighbors,
} from '../src/sunstudy/state';
import { frameFromLocal } from '../src/sunstudy/types';
import type { Neighbor, ProjectJson } from '../src/sunstudy/types';

const FRAME = { lat: 35.6, lon: 139.6, address: 'テスト', groundElev: 10 };

const square = (e0: number, n0: number, size: number) => [
  { e: e0, n: n0 },
  { e: e0 + size, n: n0 },
  { e: e0 + size, n: n0 + size },
  { e: e0, n: n0 + size },
];
const nb = (id: string, ring: { e: number; n: number }[], extra: Partial<Neighbor> = {}): Neighbor => ({ id, ring, height: 7, source: 'gsi', heightKind: 'estimated', ...extra });
const ids = (list: Neighbor[]) => list.map((n) => n.id).sort();

const studyMeshFilter = (m: THREE.Mesh) => !m.userData.noShadow && !m.userData.overlay;
const meshesOf = (root: THREE.Object3D) => {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
};

function fakeScene(): StudyScene {
  const groups = {
    terrain: new THREE.Group(),
    neighbors: new THREE.Group(),
    building: new THREE.Group(),
    site: new THREE.Group(),
    sunpath: new THREE.Group(),
    overlay: new THREE.Group(),
    markers: new THREE.Group(),
    align: new THREE.Group(),
    select: new THREE.Group(),
  };
  return { groups, invalidate: () => {} } as unknown as StudyScene;
}

function resetStudy() {
  study.frame = { ...FRAME };
  study.sitePolygon = [];
  study.model = null;
  study.points = [];
  study.grid = null;
  study.aerial = null;
  study.horizon = null;
  study.neighborOverrides = {};
  study.results = { images: [] };
  study.env = { loaded: true, loading: false, error: null, attribution: '' };
  study.neighbors = [
    nb('auto1', square(20, 0, 8)),
    nb('auto2', square(-30, 0, 8), { source: 'plateau', heightKind: 'measured', height: 12 }),
    nb('auto3', square(0, 30, 8)),
    nb('auto4', square(0, -40, 8)),
    nb('manual1', square(0, -25, 6), { source: 'manual', heightKind: 'manual', label: '隣家（南）' }),
  ];
  setHideDefaults({ mode: 'exclude', reason: 'other', note: '' });
}

describe('隠し方と理由（state）', () => {
  let events = 0;
  let off: (() => void) | null = null;
  beforeEach(() => {
    resetStudy();
    events = 0;
    off = on('neighbors', () => events++);
  });
  afterEach(() => {
    off?.();
    off = null;
  });

  it('表示だけ隠す: 描く一覧から外れ、影・解析の一覧には残る。計算から除外はどちらからも外れる', () => {
    expect(setNeighborsHidden(['auto1', 'manual1'], true, { mode: 'view', reason: 'other', note: '視点の手前' })).toBe(2);
    expect(setNeighborsHidden(['auto2'], true, { mode: 'exclude', reason: 'demolish' })).toBe(1);
    expect(events).toBe(2);
    expect(study.neighborOverrides.auto1).toEqual({ hidden: true, hideMode: 'view', hideReason: 'other', hideNote: '視点の手前' });
    expect(study.neighborOverrides.auto2).toEqual({ hidden: true, hideMode: 'exclude', hideReason: 'demolish' });
    // 手動の隣家は本体に書く（上書きは使わない）
    const m = study.neighbors.find((n) => n.id === 'manual1')!;
    expect({ hidden: m.hidden, hideMode: m.hideMode, hideReason: m.hideReason, hideNote: m.hideNote }).toEqual({ hidden: true, hideMode: 'view', hideReason: 'other', hideNote: '視点の手前' });
    expect(study.neighborOverrides.manual1).toBeUndefined();
    expect(ids(visibleNeighbors())).toEqual(['auto3', 'auto4']);
    expect(ids(hiddenNeighbors())).toEqual(['auto1', 'auto2', 'manual1']);
    expect(ids(viewOnlyNeighbors())).toEqual(['auto1', 'manual1']);
    expect(ids(excludedNeighbors())).toEqual(['auto2']);
    expect(ids(analysisNeighbors())).toEqual(['auto1', 'auto3', 'auto4', 'manual1']);
    // 3D に描く・影だけ・影と解析・半透明の一覧
    expect(ids(neighborsForScene(null))).toEqual(['auto3', 'auto4']);
    expect(ids(viewOnlyNeighborsForScene(null))).toEqual(['auto1', 'manual1']);
    expect(ids(analysisNeighborsForScene(null))).toEqual(['auto1', 'auto3', 'auto4', 'manual1']);
    expect(ids(hiddenNeighborsForScene(null))).toEqual(['auto1', 'auto2', 'manual1']);
  });

  it('同じ隠し方・理由で隠し直しても変わらない（発火しない）、別の隠し方なら書き換える。setNeighborsHideInfo は隠した建物だけ', () => {
    setNeighborsHidden(['auto1'], true, { mode: 'exclude', reason: 'dataError' });
    expect(events).toBe(1);
    expect(setNeighborsHidden(['auto1'], true, { mode: 'exclude', reason: 'dataError' })).toBe(0);
    expect(events).toBe(1);
    expect(setNeighborsHidden(['auto1'], true, { mode: 'view', reason: 'dataError' })).toBe(1);
    expect(events).toBe(2);
    expect(study.neighborOverrides.auto1.hideMode).toBe('view');
    // 隠していない auto3 は対象外
    expect(setNeighborsHideInfo(['auto1', 'auto3'], { mode: 'exclude', reason: 'onsite' })).toBe(1);
    expect(events).toBe(3);
    expect(study.neighborOverrides.auto1).toEqual({ hidden: true, hideMode: 'exclude', hideReason: 'onsite' });
    expect(study.neighborOverrides.auto3).toBeUndefined();
    // 理由を「その他」にして補足を付け、補足だけを変える
    expect(setNeighborsHideInfo(['auto1'], { reason: 'other', note: '  倉庫  ' })).toBe(1);
    expect(study.neighborOverrides.auto1.hideNote).toBe('倉庫');
    expect(setNeighborsHideInfo(['auto1'], { note: '倉庫' })).toBe(0);
  });

  it('戻すと隠し方・理由も消え、高さの上書きは残る。restoreAllNeighbors(mode) はその隠し方だけ', () => {
    study.neighborOverrides.auto2 = { height: 15 };
    setNeighborsHidden(['auto1', 'auto2'], true, { mode: 'view', reason: 'other' });
    setNeighborsHidden(['auto3', 'manual1'], true, { mode: 'exclude', reason: 'demolish' });
    expect(restoreAllNeighbors('view')).toBe(2);
    expect(study.neighborOverrides.auto2).toEqual({ height: 15 });
    expect(study.neighborOverrides.auto1).toBeUndefined();
    expect(ids(hiddenNeighbors())).toEqual(['auto3', 'manual1']);
    expect(restoreAllNeighbors()).toBe(2);
    const m = study.neighbors.find((n) => n.id === 'manual1')!;
    expect(m.hidden ?? m.hideMode ?? m.hideReason).toBeUndefined();
    expect(hiddenNeighbors()).toEqual([]);
    // 隠していない建物の effectiveNeighbors には隠し方・理由が無い
    expect(effectiveNeighbors().every((n) => n.hideMode === undefined && n.hideReason === undefined)).toBe(true);
  });

  it('隠し方・理由の既定（直近に選んだもの）と、知らない値・長すぎる補足の正規化', () => {
    expect(getHideDefaults()).toEqual({ mode: 'exclude', reason: 'other' });
    setHideDefaults({ mode: 'view', reason: 'demolish' });
    expect(getHideDefaults()).toEqual({ mode: 'view', reason: 'demolish' });
    expect(normalizeHideInfo({ mode: 'bogus', reason: 42 })).toEqual({ mode: 'exclude', reason: 'other' });
    expect(normalizeHideInfo({ mode: 'view', reason: 'onsite', note: '   ' })).toEqual({ mode: 'view', reason: 'onsite' });
    expect(normalizeHideInfo({ mode: 'view', reason: 'other', note: 'あ'.repeat(500) }).note).toHaveLength(200);
    // 古いデータ（hidden だけ）は計算から除外・その他
    study.neighbors[0].hidden = true;
    const e = effectiveNeighbors().find((n) => n.id === 'auto1')!;
    expect([e.hideMode, e.hideReason]).toEqual(['exclude', 'other']);
    expect(ids(excludedNeighbors())).toEqual(['auto1']);
  });

  it('敷地に重なる建物は表示だけ隠しても自動で外れ、自動除外の数に入る', () => {
    // auto1（東 20〜28 m）を覆う敷地
    study.sitePolygon = square(18, -2, 12).map((p) => frameFromLocal(FRAME, p.e, p.n));
    setNeighborsHidden(['auto1'], true, { mode: 'view', reason: 'other' });
    expect(siteExcludedCount(null)).toBe(1);
    expect(viewOnlyNeighborsForScene(null)).toEqual([]);
    // 計算から除外すると自動除外の数からは外れる（自分で外した数に入る）
    setNeighborsHidden(['auto1'], true, { mode: 'exclude', reason: 'onsite' });
    expect(siteExcludedCount(null)).toBe(0);
  });
});

describe('表示だけ隠した建物の影だけのメッシュ', () => {
  beforeEach(resetStudy);

  it('castShadow・受けない・色も深度も書かない・クリックで選べない・noShadow / overlay なしで解析に焼き込まれる', () => {
    const list = [nb('v1', square(0, 0, 6)), nb('v2', square(12, 0, 6), { height: 10 })];
    const casters = buildNeighborShadowCasters(list, { groundY: () => 0 });
    const meshes = meshesOf(casters);
    expect(meshes.map((m) => m.userData.neighborId).sort()).toEqual(['v1', 'v2']);
    for (const m of meshes) {
      const mat = m.material as THREE.MeshBasicMaterial;
      expect(m.castShadow).toBe(true);
      expect(m.receiveShadow).toBe(false);
      expect(m.visible).toBe(true);
      expect(mat.visible).toBe(true);
      expect(mat.colorWrite).toBe(false);
      expect(mat.depthWrite).toBe(false);
      expect(m.userData.shadowOnly).toBe(true);
      expect(m.userData.neighbor).toBe(true);
      expect(m.userData.noShadow).toBeUndefined();
      expect(m.userData.overlay).toBeUndefined();
    }
    // クリックの当たり判定は無い
    const rc = new THREE.Raycaster(new THREE.Vector3(3, 50, -3), new THREE.Vector3(0, -1, 0));
    expect(rc.intersectObject(casters, true)).toEqual([]);
    // 解析（表示を無視して焼き込む）の三角形は普通の周辺建物と同じ
    const normal = buildNeighborMeshes(list, { groundY: () => 0 });
    const tri = (root: THREE.Object3D) => bakeWorldTriangles([{ root, kind: 'neighbor' }], studyMeshFilter, { ignoreVisibility: true }).triangles;
    expect(tri(casters)).toBe(tri(normal));
    expect(tri(casters)).toBeGreaterThan(0);
    expect(shadowOnlyMaterial().colorWrite).toBe(false);
  });

  it('半透明の表示: 表示だけ隠した建物は viewOnly と別のマテリアル（どちらも解析に入らない）', () => {
    const exclMat = new THREE.MeshBasicMaterial();
    const viewMat = new THREE.MeshBasicMaterial();
    const ghosts = buildNeighborGhosts([nb('e1', square(0, 0, 6), { hidden: true, hideMode: 'exclude' }), nb('v1', square(10, 0, 6), { hidden: true, hideMode: 'view' })], { material: exclMat, viewMaterial: viewMat });
    const byId = new Map(meshesOf(ghosts).map((m) => [m.userData.neighborId as string, m]));
    expect(byId.get('e1')!.material).toBe(exclMat);
    expect(byId.get('v1')!.material).toBe(viewMat);
    expect(byId.get('v1')!.userData.viewOnly).toBe(true);
    expect(byId.get('e1')!.userData.viewOnly).toBeUndefined();
    expect(bakeWorldTriangles([{ root: ghosts, kind: 'neighbor' }], studyMeshFilter, { ignoreVisibility: true }).triangles).toBe(0);
  });

  it('rebuildEnvironment: 表示だけ隠した建物は影だけのメッシュで遮蔽物に入り、計算から除外した建物は入らない', () => {
    const scene = fakeScene();
    const triOf = (list: Neighbor[]) => bakeWorldTriangles([{ root: buildNeighborMeshes(list, { groundY: () => 0 }), kind: 'neighbor' }]).triangles;
    rebuildEnvironment(scene, null);
    const occAll = buildStudyOccluder(scene, { neighbors: true, building: false, terrain: false });
    const all = occAll.triangles;
    disposeStudyOccluder(occAll);
    expect(all).toBe(triOf(study.neighbors));
    setNeighborsHidden(['auto1'], true, { mode: 'view', reason: 'other' });
    setNeighborsHidden(['auto2'], true, { mode: 'exclude', reason: 'demolish' });
    rebuildEnvironment(scene, null);
    // 描く建物の id（影だけのメッシュは除く）と影だけのメッシュの id
    const drawn = meshesOf(scene.groups.neighbors).filter((m) => !m.userData.shadowOnly).map((m) => m.userData.neighborId as string);
    const shadowOnly = meshesOf(scene.groups.neighbors).filter((m) => m.userData.shadowOnly).map((m) => m.userData.neighborId as string);
    expect(drawn.sort()).toEqual(['auto3', 'auto4', 'manual1']);
    expect(shadowOnly).toEqual(['auto1']);
    const occ = buildStudyOccluder(scene, { neighbors: true, building: false, terrain: false });
    expect(occ.triangles).toBe(all - triOf([study.neighbors[1]]));
    disposeStudyOccluder(occ);
    clearStudyOccluderCache();
  });
});

describe('保存データの隠し方・理由', () => {
  beforeEach(resetStudy);

  it('往復で隠し方・理由・補足が戻る（自動取得の建物と手動の隣家）', async () => {
    setNeighborsHidden(['auto1'], true, { mode: 'view', reason: 'other', note: 'カメラの手前' });
    setNeighborsHidden(['auto2', 'manual1'], true, { mode: 'exclude', reason: 'demolish' });
    const json = JSON.parse(JSON.stringify(serializeProject())) as ProjectJson;
    expect(json.neighborOverrides.auto1).toEqual({ hidden: true, hideMode: 'view', hideReason: 'other', hideNote: 'カメラの手前' });
    expect(json.manualNeighbors[0]).toMatchObject({ hidden: true, hideMode: 'exclude', hideReason: 'demolish' });
    restoreAllNeighbors();
    study.neighbors = [];
    study.neighborOverrides = {};
    await applyProject(json);
    expect(ids(viewOnlyNeighbors())).toEqual(['auto1']);
    expect(ids(excludedNeighbors())).toEqual(['auto2', 'manual1']);
    expect(viewOnlyNeighbors()[0].hideNote).toBe('カメラの手前');
    expect(excludedNeighbors().every((n) => n.hideReason === 'demolish')).toBe(true);
  });

  it('隠し方・理由の無い古いデータは「計算から除外」「その他」として読む（上書き・手動の隣家）。壊れた値は捨てる', async () => {
    const json = JSON.parse(JSON.stringify(serializeProject())) as ProjectJson;
    // この機能より前の形（hidden だけ）と、壊れた値
    (json as unknown as { neighborOverrides: unknown }).neighborOverrides = {
      auto1: { hidden: true },
      auto2: { height: 15, hidden: true, hideMode: 'weird', hideReason: 'nope', hideNote: 3 },
      auto3: { height: 'x', hidden: 'yes' },
      auto4: { height: 9 },
    };
    json.manualNeighbors = [{ ...json.manualNeighbors[0], hidden: true }];
    study.neighbors = [];
    await applyProject(json);
    expect(study.neighborOverrides.auto1).toEqual({ hidden: true, hideMode: 'exclude', hideReason: 'other' });
    expect(study.neighborOverrides.auto2).toEqual({ height: 15, hidden: true, hideMode: 'exclude', hideReason: 'other' });
    expect(study.neighborOverrides.auto3).toBeUndefined();
    expect(study.neighborOverrides.auto4).toEqual({ height: 9 });
    const m = study.neighbors.find((n) => n.id === 'manual1')!;
    expect([m.hidden, m.hideMode, m.hideReason]).toEqual([true, 'exclude', 'other']);
    expect(ids(excludedNeighbors())).toEqual(['auto1', 'auto2', 'manual1']);
    expect(viewOnlyNeighbors()).toEqual([]);
  });

  it('sanitize の単体: 隠していない建物の隠し方は捨てる', () => {
    expect(sanitizeNeighborOverrides({ a: { hidden: false, hideMode: 'view', hideReason: 'onsite' } })).toEqual({ a: { hidden: false } });
    expect(sanitizeNeighborOverrides(null)).toEqual({});
    expect(sanitizeNeighborOverrides([1, 2])).toEqual({});
    const n = sanitizeNeighborHide(nb('x', square(0, 0, 1), { hideMode: 'view', hideReason: 'other' }));
    expect(n.hideMode ?? n.hideReason ?? n.hidden).toBeUndefined();
  });
});

describe('開示（日影図の脚注・レポート）', () => {
  beforeEach(resetStudy);

  it('理由ごとの数・表示だけ隠した数・自動除外の数', () => {
    expect(excludedLine(neighborDisclosure(null))).toBe('計算から除外した周辺建物 なし');
    expect(viewOnlyLine(neighborDisclosure(null))).toBeNull();
    expect(disclosureLines({ disclosure: neighborDisclosure(null) })).toEqual(['周辺建物の扱い: 計算から除外した周辺建物 なし']);
    setNeighborsHidden(['auto1', 'auto2'], true, { mode: 'exclude', reason: 'demolish' });
    setNeighborsHidden(['manual1'], true, { mode: 'exclude', reason: 'other', note: '撤去済み' });
    setNeighborsHidden(['auto3'], true, { mode: 'view', reason: 'other' });
    // auto4（南 40〜48 m）を覆う敷地 → 自動除外 1
    study.sitePolygon = square(-2, -42, 12).map((p) => frameFromLocal(FRAME, p.e, p.n));
    const d = neighborDisclosure(null);
    expect(d.byReason).toEqual([
      { reason: 'demolish', label: '解体予定', count: 2 },
      { reason: 'other', label: 'その他', count: 1 },
    ]);
    expect(d.autoOnSite).toBe(1);
    expect(disclosureLines({ disclosure: d })).toEqual([
      '周辺建物の扱い: 計算から除外した周辺建物 3 棟（解体予定 2・その他 1）',
      '表示だけ隠した建物 1 棟（影・解析には含む）',
      '敷地・計画建物に重なる自動取得の建物 1 棟は自動で除外',
    ]);
    expect(disclosureLines({ disclosure: d, neighborsInCalc: false })[0]).toMatch(/^周辺建物の扱い（この図は自建物のみで計算。以下は 3D・日照解析での扱い）: 計算から除外した周辺建物 3 棟/);
    expect(hideReasonText(excludedNeighbors().find((n) => n.id === 'manual1')!)).toBe('その他（撤去済み）');
  });

  it('方向・距離: 建物の足跡からの最短距離と、建物の中心から見た方向', () => {
    const w = neighborWhere(nb('x', square(10, -4, 4)), square(-5, -5, 10), { e: 0, n: 0 });
    expect(w.dist).toBeCloseTo(5, 9);
    expect(w.text).toBe('約 5 m・東側');
    // 建物が無ければピンから
    expect(neighborWhere(nb('y', square(-2, 20, 4)), null, { e: 0, n: 0 }).text).toBe('約 20 m・北側');
  });

  it('appendSvgFootnote: viewBox を伸ばし、白い帯と脚注を足す（元の図はそのまま）。長い行は折り返す', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3400 -4000 6800 8000"><rect x="-3400" y="-4000" width="6800" height="8000" fill="#fff"/><path d="M0 0L1 1"/></svg>';
    const long = '周辺建物の扱い: ' + 'あいうえお・'.repeat(30);
    const out = appendSvgFootnote(svg, ['計算から除外した周辺建物 2 棟（解体予定 2）', long]);
    const vb = /viewBox="([^"]+)"/.exec(out)![1].split(' ').map(Number);
    expect(vb.slice(0, 3)).toEqual([-3400, -4000, 6800]);
    expect(vb[3]).toBeGreaterThan(8000);
    expect(out).toContain('<path d="M0 0L1 1"/>');
    expect(out).toContain('data-role="disclosure"');
    expect(out).toContain('計算から除外した周辺建物 2 棟（解体予定 2）');
    expect((out.match(/data-line="1"/g) ?? []).length).toBeGreaterThan(1);
    expect(out.endsWith('</svg>')).toBe(true);
    // 脚注の文字は図の内側（幅の中）に収まる長さで折り返す
    for (const t of wrapFootnote(long, 80)) expect([...t].length).toBeLessThanOrEqual(80);
    // viewBox が無い SVG・空の脚注はそのまま
    expect(appendSvgFootnote('<svg></svg>', ['x'])).toBe('<svg></svg>');
    expect(appendSvgFootnote(svg, [])).toBe(svg);
    // XML として壊さない
    expect(appendSvgFootnote(svg, ['<&>'])).toContain('&lt;&amp;&gt;');
  });

  it('レポート: 周辺建物の扱いの表（出典・高さ・理由・方向距離）と、結果のページの注記', () => {
    setNeighborsHidden(['auto2'], true, { mode: 'exclude', reason: 'dataError' });
    setNeighborsHidden(['auto1'], true, { mode: 'view', reason: 'other', note: '視点の手前' });
    study.results.diagramSvg = '<svg viewBox="0 0 10 10"></svg>';
    study.results.diagramInfo = { plane: 'GL+4m', regulation: '一般（二） 5〜10m 4時間／10m 超 2.5時間', halfHour: true, includeNeighbors: true };
    study.results.diagramSummary = [{ hour: 4, maxDist: 6.2, role: 'limitNear' }];
    const html = buildReportHtml();
    const page = /<section class="page" data-role="neighbor-hide">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
    expect(page).toContain('<th>出典</th><th>高さ</th><th>理由</th><th>方向・距離（建物から）</th>');
    expect(page).toMatch(/<table class="nbhide" data-mode="exclude">[\s\S]*PLATEAU[\s\S]*12\.0 m[\s\S]*データの誤り[\s\S]*約 \d+ m・西側/);
    expect(page).toMatch(/<table class="nbhide" data-mode="view">[\s\S]*国土地理院[\s\S]*その他（視点の手前）[\s\S]*東側/);
    // 日影図のページ: 条件・規制の線の役割・注記
    const diag = /<section class="page"><h2>日影図[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(diag).toContain('一般（二） 5〜10m 4時間／10m 超 2.5時間');
    expect(diag).toContain('4時間日影（5〜10m の規制）');
    expect(diag).toContain('30 分ごと');
    expect(diag).toContain('計算から除外した周辺建物 1 棟（データの誤り 1）');
    expect(diag).toContain('表示だけ隠した建物 1 棟（影・解析には含む）');
    // 隠した建物が無ければ表のページは無く、建設地のページに「なし」
    restoreAllNeighbors();
    const html2 = buildReportHtml();
    expect(html2).not.toContain('data-role="neighbor-hide"');
    expect(html2).toContain('<dt>計算から除外</dt><dd>なし</dd>');
    expect(html2).toContain('計算から除外した周辺建物 なし');
  });
});

describe('日影図の規制値の選択', () => {
  it('北海道のプリセットは真太陽時 9〜15 時、なしなら「北海道」のチェックに従う', () => {
    expect(diagramHours(shadowRegulationPreset('hokkaido-2'), false)).toEqual([9, 15]);
    expect(diagramHours(shadowRegulationPreset('general-2'), true)).toEqual([8, 16]);
    expect(diagramHours(null, true)).toEqual([9, 15]);
    expect(diagramHours(null, false)).toEqual([8, 16]);
    expect(presetForRegion('general-3', true)).toBe('hokkaido-3');
    expect(presetForRegion('hokkaido-1', false)).toBe('general-1');
    expect(presetForRegion('general-2', false)).toBe('general-2');
    expect(presetForRegion('', true)).toBe('');
    expect(SHADOW_REGULATION_PRESETS).toHaveLength(6);
  });

  it('shadowDiagramStudy: 規制値（一般（二））・30 分の時刻日影線・脚注', async () => {
    const scene = fakeScene();
    const b = new THREE.Mesh(new THREE.BoxGeometry(10, 12, 10));
    b.position.y = 6;
    scene.groups.building.add(b);
    const reg = shadowRegulationPreset('general-2')!;
    const footnote = ['周辺建物の扱い: 計算から除外した周辺建物 2 棟（解体予定 1・データの誤り 1）', '表示だけ隠した建物 1 棟（影・解析には含む）'];
    const r = await shadowDiagramStudy(scene, { lat: 35.68, lon: 139.69, year: 2026, planeHeight: 4, includeNeighbors: false, center: new THREE.Vector3(0, 0, 0), sitePolygon: null, regulation: reg, hours: reg.hours, timeLineIntervalMin: 30, footnote });
    expect(r.svg).toMatch(/<path data-level="4" data-role="limitNear"/);
    expect(r.svg).toMatch(/<path data-level="2\.5" data-role="limitFar"/);
    expect(r.svg).toContain('5〜10m の規制 4 時間');
    expect(r.svg).toContain('10m 超の規制 2.5 時間');
    expect(r.svg).toContain('data-time="8:30"');
    expect(r.svg).toMatch(/data-time="8:30"[^>]*stroke-dasharray/);
    expect(r.svg).toContain('data-role="disclosure"');
    expect(r.svg).toContain(footnote[0]);
    expect(r.svg).toContain(footnote[1]);
    clearStudyOccluderCache();
  });
});
