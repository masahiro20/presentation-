// 日照ツール: 想定の家（未建築の隣家）の状態（追加・変更・削除・含める／含めない）、メッシュ（屋根付き・色・userData）、
// 遮蔽物（屋根・軒の出の三角形を含む）、隠し方との組み合わせ、開示の行、保存データの往復
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bakeWorldTriangles } from '../src/sun/analysis';
import { PLANNED_COLORS, PLANNED_EAVE_OVERHANG, PLANNED_GROUP_ROOF, PLANNED_ROOF_THICKNESS, houseFromPreset, plannedFootprint } from '../src/sun/plannedHouse';
import { buildStudyOccluder, clearStudyOccluderCache, disposeStudyOccluder, isShadedStudy } from '../src/sunstudy/analysis';
import { disclosureLines, neighborDisclosure, plannedLine } from '../src/sunstudy/disclosure';
import { buildNeighborGhosts, rebuildEnvironment } from '../src/sunstudy/environment';
import { buildNeighborMeshes } from '../src/sunstudy/neighbors';
import { applyProject, sanitizePlannedNeighbor, serializeProject } from '../src/sunstudy/project';
import { assumptionLine, buildReportHtml } from '../src/sunstudy/report';
import type { StudyScene } from '../src/sunstudy/scene';
import {
  addPlannedHouse,
  analysisNeighbors,
  clearPlannedHouses,
  effectiveNeighbors,
  excludedNeighbors,
  hiddenNeighbors,
  isPlannedNeighbor,
  on,
  plannedActive,
  plannedHouses,
  plannedToNeighbor,
  removePlannedHouse,
  setNeighborsHidden,
  setPlannedEnabled,
  study,
  updatePlannedHouse,
  viewOnlyNeighbors,
  visibleNeighbors,
} from '../src/sunstudy/state';
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
const meshesOf = (root: THREE.Object3D) => {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
};
const studyMeshFilter = (m: THREE.Mesh) => !m.userData.noShadow && !m.userData.overlay;

function fakeScene(): StudyScene {
  const g = () => new THREE.Group();
  const groups = { terrain: g(), neighbors: g(), building: g(), site: g(), sunpath: g(), overlay: g(), markers: g(), align: g(), select: g() };
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
  study.plannedEnabled = true;
  study.results = { images: [] };
  study.env = { loaded: true, loading: false, error: null, attribution: '' };
  study.neighbors = [nb('auto1', square(40, 0, 8)), nb('manual1', square(0, -40, 6), { source: 'manual', heightKind: 'manual', label: '隣家' })];
}

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
  clearStudyOccluderCache();
});

describe('状態: 追加・変更・削除・含める／含めない', () => {
  it('addPlannedHouse: 手動の隣家として足す（足元・最高高さ・「想定の家」）。発火は 1 回', () => {
    const n = addPlannedHouse(houseFromPreset('gable2', 0, -20, 90));
    expect(events).toBe(1);
    expect(n.source).toBe('manual');
    expect(n.heightKind).toBe('manual');
    expect(n.label).toBe('想定の家');
    expect(n.height).toBe(8.5);
    expect(n.ring).toEqual(plannedFootprint(n.planned));
    expect(n.id).toBe(n.planned.id);
    expect(n.id).toMatch(/^planned:/);
    expect(study.neighbors.at(-1)).toBe(n);
    expect(isPlannedNeighbor(n)).toBe(true);
    expect(isPlannedNeighbor(study.neighbors[0])).toBe(false);
    expect(plannedHouses()).toEqual([n]);
    // id の重なり → 新しい id
    const dup = addPlannedHouse({ ...n.planned, id: 'auto1', label: '南の区画' });
    expect(dup.id).not.toBe('auto1');
    expect(dup.label).toBe('南の区画');
    expect(events).toBe(2);
    expect(ids(visibleNeighbors())).toEqual(ids(study.neighbors));
  });

  it('updatePlannedHouse: 足元・高さ・名前を作り直す（同じオブジェクト）。変わらなければ発火しない', () => {
    const n = addPlannedHouse(houseFromPreset('gable2', 0, -20, 90));
    events = 0;
    expect(updatePlannedHouse(n.id, { roof: 'hip', ridgeHeight: 9, ce: 3, label: '想定（南）' })).toBe(true);
    expect(events).toBe(1);
    const same = study.neighbors.find((x) => x.id === n.id)!;
    expect(same).toBe(n);
    expect(n.planned).toMatchObject({ roof: 'hip', ridgeHeight: 9, ce: 3, cn: -20, label: '想定（南）' });
    expect(n.height).toBe(9);
    expect(n.label).toBe('想定（南）');
    expect(n.ring).toEqual(plannedFootprint(n.planned));
    expect(updatePlannedHouse(n.id, { roof: 'hip' })).toBe(false);
    expect(events).toBe(1);
    expect(updatePlannedHouse(n.id, { label: '' })).toBe(true);
    expect(n.label).toBe('想定の家');
    expect(n.planned.label).toBeUndefined();
    expect(updatePlannedHouse('manual1', { width: 3 })).toBe(false);
    expect(updatePlannedHouse('nope', { width: 3 })).toBe(false);
    // 隠した記録は残る
    setNeighborsHidden([n.id], true, { mode: 'view', reason: 'other' });
    updatePlannedHouse(n.id, { width: 12 });
    expect([n.hidden, n.hideMode]).toEqual([true, 'view']);
  });

  it('ring をずらされても（ピンの移動）中心が追従する。高さだけ直されたら軒も同じ比で', () => {
    const n = addPlannedHouse(houseFromPreset('shed2', 10, 10, 0));
    n.ring = n.ring.map((q) => ({ e: q.e - 2, n: q.n + 1 }));
    expect(plannedHouses()[0].planned).toMatchObject({ ce: 8, cn: 11 });
    n.height = 15;
    const p = plannedHouses()[0].planned;
    expect(p.ridgeHeight).toBeCloseTo(15, 9);
    expect(p.eaveHeight).toBeCloseTo(5.5 * (15 / 7.5), 9);
  });

  it('removePlannedHouse・clearPlannedHouses: 発火は 1 回、上書きの記録も消す。手動の隣家は消さない', () => {
    const a = addPlannedHouse(houseFromPreset('box', 0, -20, 0));
    const b = addPlannedHouse(houseFromPreset('box', 0, 20, 0));
    study.neighborOverrides[a.id] = { height: 3 };
    events = 0;
    expect(removePlannedHouse(a.id)).toBe(true);
    expect(events).toBe(1);
    expect(study.neighborOverrides[a.id]).toBeUndefined();
    expect(removePlannedHouse(a.id)).toBe(false);
    expect(removePlannedHouse('manual1')).toBe(false);
    expect(events).toBe(1);
    expect(clearPlannedHouses()).toBe(1);
    expect(events).toBe(2);
    expect(clearPlannedHouses()).toBe(0);
    expect(ids(study.neighbors)).toEqual(['auto1', 'manual1']);
    void b;
  });

  it('setPlannedEnabled(false): 描く・隠した・影と解析のどの一覧からも外れる（hidden には触らない）。true で戻る', () => {
    const a = addPlannedHouse(houseFromPreset('gable2', 0, -20, 90));
    const b = addPlannedHouse(houseFromPreset('gable2', 0, 20, 90));
    setNeighborsHidden([b.id], true, { mode: 'view', reason: 'other' });
    events = 0;
    expect(setPlannedEnabled(false)).toBe(true);
    expect(setPlannedEnabled(false)).toBe(false);
    expect(events).toBe(1);
    expect(ids(visibleNeighbors())).toEqual(['auto1', 'manual1']);
    expect(ids(analysisNeighbors())).toEqual(['auto1', 'manual1']);
    expect(hiddenNeighbors()).toEqual([]);
    expect(viewOnlyNeighbors()).toEqual([]);
    expect(excludedNeighbors()).toEqual([]);
    expect(b.hidden).toBe(true);
    expect(b.hideMode).toBe('view');
    expect(plannedActive(a)).toBe(false);
    expect(plannedActive(study.neighbors[0])).toBe(true);
    // effectiveNeighbors は絞らない
    expect(effectiveNeighbors()).toHaveLength(4);
    expect(setPlannedEnabled(true)).toBe(true);
    expect(events).toBe(2);
    expect(ids(analysisNeighbors())).toEqual(ids([study.neighbors[0], study.neighbors[1], a, b]));
    expect(ids(viewOnlyNeighbors())).toEqual([b.id]);
  });
});

describe('メッシュと遮蔽物', () => {
  it('buildNeighborMeshes: 屋根付きの形・壁 #cfdcec / 屋根 #6f8fb3（不透明）・userData は他の周辺建物と同じ + planned', () => {
    const p = addPlannedHouse(houseFromPreset('gable2', 0, -20, 90));
    const g = buildNeighborMeshes([p, study.neighbors[0]], { groundY: () => -0.3 });
    const [m, other] = g.children as THREE.Mesh[];
    expect(m.userData).toEqual({ neighbor: true, neighborId: p.id, heightKind: 'manual', matKey: 'neighbor', planned: true });
    expect(other.userData.planned).toBeUndefined();
    expect(m.castShadow).toBe(true);
    expect(m.receiveShadow).toBe(true);
    const mats = m.material as THREE.MeshStandardMaterial[];
    expect(mats).toHaveLength(2);
    expect('#' + mats[PLANNED_GROUP_ROOF].color.getHexString()).toBe(PLANNED_COLORS.roof);
    expect('#' + mats[1].color.getHexString()).toBe(PLANNED_COLORS.wall);
    for (const mat of mats) {
      expect(mat.transparent).toBe(false);
      expect(mat.opacity).toBe(1);
      expect(mat.map).toBeNull();
    }
    // 地盤（groundY は 0.3 m 下げた値を渡す約束）から最高高さ
    m.geometry.computeBoundingBox();
    expect(m.geometry.boundingBox!.max.y).toBeCloseTo(8.5, 5);
    expect(m.geometry.boundingBox!.min.y).toBeCloseTo(-0.3, 5);
    expect(m.geometry.groups[0].count).toBeGreaterThan(0);
  });

  it('rebuildEnvironment → 遮蔽物: 屋根・軒の出の三角形が入る（軒の出の真下は影、外は日なた）。含めない・計算から除外で外れ、表示だけ隠すと残る', () => {
    resetStudy();
    study.neighbors = [];
    // 東西に長い 2 階建て（南北 7.3 m）。軒の出は南北の端から 0.45 m
    const p = addPlannedHouse(houseFromPreset('gable2', 0, -20, 90));
    const scene = fakeScene();
    const up = new THREE.Vector3(0, 1, 0);
    const under = new THREE.Vector3(0, 1, 20 + 7.3 / 2 + PLANNED_EAVE_OVERHANG / 2); // 南の軒の出の真下（z = −n）
    const outside = new THREE.Vector3(0, 1, 20 + 7.3 / 2 + PLANNED_EAVE_OVERHANG + 0.1);
    const occ = () => {
      rebuildEnvironment(scene, null);
      return buildStudyOccluder(scene, { neighbors: true, building: false, terrain: false });
    };
    let o = occ();
    const tri = bakeWorldTriangles([{ root: buildNeighborMeshes([p], { groundY: () => -0.3 }), kind: 'neighbor' }], studyMeshFilter, { ignoreVisibility: true }).triangles;
    expect(o.triangles).toBe(tri);
    expect(isShadedStudy(o, under, up)).toBe(true);
    expect(isShadedStudy(o, outside, up)).toBe(false);
    // 南の太陽（ワールドの南は +z）: 家のすぐ北は家の影、離れた所（高度 45°）は日なた
    expect(isShadedStudy(o, new THREE.Vector3(0, 1, 12), new THREE.Vector3(0, 0.6, 1).normalize())).toBe(true);
    expect(isShadedStudy(o, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 1).normalize())).toBe(false);
    disposeStudyOccluder(o);
    // 表示だけ隠す: 影だけのメッシュ（同じ形）で残る
    setNeighborsHidden([p.id], true, { mode: 'view', reason: 'other' });
    o = occ();
    expect(o.triangles).toBe(tri);
    expect(meshesOf(scene.groups.neighbors).every((m) => m.userData.shadowOnly)).toBe(true);
    expect(isShadedStudy(o, under, up)).toBe(true);
    disposeStudyOccluder(o);
    // 含めない: 何も作らない
    setPlannedEnabled(false);
    o = occ();
    expect(o.triangles).toBe(0);
    expect(meshesOf(scene.groups.neighbors)).toEqual([]);
    disposeStudyOccluder(o);
    setPlannedEnabled(true);
    // 計算から除外
    setNeighborsHidden([p.id], true, { mode: 'exclude', reason: 'other' });
    o = occ();
    expect(o.triangles).toBe(0);
    disposeStudyOccluder(o);
  });

  it('半透明の表示（選んで隠すモード）も屋根付きの形', () => {
    const p = addPlannedHouse(houseFromPreset('hip2', 0, -20, 90));
    const ghosts = buildNeighborGhosts([{ ...p, hidden: true, hideMode: 'exclude' }]);
    const [g] = meshesOf(ghosts);
    expect(g.userData).toMatchObject({ neighborId: p.id, ghost: true, noShadow: true });
    g.geometry.computeBoundingBox();
    expect(g.geometry.boundingBox!.max.y).toBeCloseTo(8, 4);
    // 屋根の板の厚さの分の面（軒裏）もある
    expect(PLANNED_ROOF_THICKNESS).toBeGreaterThan(0);
  });
});

describe('開示・レポート', () => {
  it('想定の家の行: 含めている／いない。計算から除外した想定の家は除外の側で数える', () => {
    expect(plannedLine(neighborDisclosure(null))).toBeNull();
    const a = addPlannedHouse(houseFromPreset('gable2', 0, -20, 90));
    addPlannedHouse(houseFromPreset('gable2', 0, 20, 90));
    let d = neighborDisclosure(null);
    expect(d.planned).toEqual({ count: 2, enabled: true });
    expect(disclosureLines({ disclosure: d })).toContain('想定で置いた建物 2 棟（未建築・仮の形状。影・解析に含む）');
    expect(disclosureLines({ disclosure: d, neighborsInCalc: false })).toContain('想定で置いた建物 2 棟（未建築・仮の形状。影・解析に含む）');
    setNeighborsHidden([a.id], true, { mode: 'exclude', reason: 'demolish' });
    d = neighborDisclosure(null);
    expect(d.planned).toEqual({ count: 1, enabled: true });
    expect(d.excluded.map((n) => n.id)).toEqual([a.id]);
    setPlannedEnabled(false);
    d = neighborDisclosure(null);
    expect(d.planned).toEqual({ count: 1, enabled: false });
    expect(d.excluded).toEqual([]);
    expect(disclosureLines({ disclosure: d })).toContain('想定で置いた建物 1 棟（未建築・仮の形状。今は含めていません）');
    // 古い呼び出し側の値（planned 無し）は行を出さない
    expect(plannedLine({})).toBeNull();
  });

  it('レポート: 建設地の表と前提・各ページの注記に想定の家', () => {
    addPlannedHouse(houseFromPreset('gable2', 0, -20, 90));
    const html = buildReportHtml();
    expect(html).toContain('想定で置いた建物 1 棟（未建築・仮の形状。影・解析に含む）');
    expect(html).toContain('<dt>想定の家</dt>');
    expect(assumptionLine()).toContain('（うち想定の家 1）');
  });
});

describe('保存データ', () => {
  it('往復: 想定の家（形・名前・隠した記録）と plannedEnabled', async () => {
    const a = addPlannedHouse({ ...houseFromPreset('shed2', 3, -18, 75), label: '南の区画' });
    const b = addPlannedHouse(houseFromPreset('flat3', -5, 22, 10));
    setNeighborsHidden([b.id], true, { mode: 'view', reason: 'other', note: '視点' });
    setPlannedEnabled(false);
    const json = JSON.parse(JSON.stringify(serializeProject())) as ProjectJson;
    expect(json.plannedEnabled).toBe(false);
    expect(json.manualNeighbors.filter((n) => n.planned)).toHaveLength(2);
    const before = plannedHouses().map((n) => ({ id: n.id, planned: n.planned, ring: n.ring, label: n.label, hidden: n.hidden }));
    study.neighbors = [];
    study.plannedEnabled = true;
    await applyProject(json);
    expect(study.plannedEnabled).toBe(false);
    const after = plannedHouses().map((n) => ({ id: n.id, planned: n.planned, ring: n.ring, label: n.label, hidden: n.hidden }));
    expect(after).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(after[i].id).toBe(before[i].id);
      expect(after[i].planned).toEqual(before[i].planned);
      expect(after[i].label).toBe(before[i].label);
      expect(after[i].hidden).toBe(before[i].hidden);
      after[i].ring.forEach((q, k) => {
        expect(q.e).toBeCloseTo(before[i].ring[k].e, 9);
        expect(q.n).toBeCloseTo(before[i].ring[k].n, 9);
      });
    }
    expect(study.neighbors.find((n) => n.id === a.id)!.label).toBe('南の区画');
    expect(study.neighbors.find((n) => n.id === b.id)!.hideMode).toBe('view');
    // 古いデータ（plannedEnabled 無し）は含める
    delete (json as Partial<ProjectJson>).plannedEnabled;
    await applyProject(json);
    expect(study.plannedEnabled).toBe(true);
  });

  it('壊れた値: 数値・屋根の形を整え、中心が無ければ ring から。planned が壊れていれば外す。自動取得の建物の planned は外す', () => {
    const ring = square(10, 10, 6);
    const n = sanitizePlannedNeighbor({ id: 'p1', ring, height: 1, source: 'manual', heightKind: 'manual', planned: { roof: 'dome', width: 'x', ce: null, cn: NaN, eaveHeight: 5, ridgeHeight: 2 } as never });
    expect(n.planned).toMatchObject({ id: 'p1', roof: 'gable', width: 9.1, ce: 13, cn: 13, eaveHeight: 5, ridgeHeight: 5 });
    expect(n.height).toBe(5);
    expect(n.label).toBe('想定の家');
    expect(n.ring).toEqual(plannedFootprint(n.planned!));
    const bad = sanitizePlannedNeighbor({ id: 'p2', ring, height: 7, source: 'manual', heightKind: 'manual', planned: 'yes' as never });
    expect('planned' in bad).toBe(false);
    const auto = sanitizePlannedNeighbor({ id: 'g', ring, height: 7, source: 'gsi', heightKind: 'estimated', planned: houseFromPreset('box', 0, 0, 0) });
    expect('planned' in auto).toBe(false);
    const plain = { id: 'm', ring, height: 7, source: 'manual' as const, heightKind: 'manual' as const };
    expect(sanitizePlannedNeighbor(plain)).toBe(plain);
    // 名前は planned.label、無ければ本体の名前（「想定の家」以外）
    expect(sanitizePlannedNeighbor({ ...plain, label: '東の区画', planned: houseFromPreset('box', 0, 0, 0) }).planned!.label).toBe('東の区画');
    expect(plannedToNeighbor(houseFromPreset('box', 0, 0, 0), { ...plain, hidden: true, hideMode: 'view', hideReason: 'other', baseElev: 3 })).toMatchObject({ hidden: true, hideMode: 'view', hideReason: 'other', baseElev: 3 });
  });
});
