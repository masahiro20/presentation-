// 敷地境界線の読み取り（図枠・寸法線と間違えない、同一直線の辺をまとめる、多角形を端でつなぐ、広すぎる敷地は使わない）と、敷地の作り直し・手直し
import { describe, expect, it } from 'vitest';
import { clearSiteLines, detectSite, entranceSide, labeledEdges, siteAroundBuilding, siteEdgesFromPolygon, sitePolygon, siteSize, syncSiteFromPolygon, type SiteText } from '../src/parser/site';
import type { Seg } from '../src/parser/walls';
import type { BuildingModel, SiteData, SiteEdge, Vec2 } from '../src/core/types';

const seg = (ax: number, ay: number, bx: number, by: number, dashed = false): Seg => ({ a: { x: ax, y: ay }, b: { x: bx, y: by }, width: 0.5, dashed, source: 'stroke' });
const text = (str: string, x: number, y: number, angle = 0): SiteText => ({ str, x, y, size: 280, angle });
const V = -Math.PI / 2;
/** 10m × 7.5m の敷地（境界線 4 本）の中に 8m × 5.5m の建物 */
const bbox = { minX: 1000, minY: 1500, maxX: 9000, maxY: 7000 };
const boundary = [seg(0, 500, 10000, 500), seg(10000, 500, 10000, 8000), seg(10000, 8000, 0, 8000), seg(0, 8000, 0, 500)];
const labels = [text('隣地境界線', 5000, 300), text('隣地境界線', 10300, 4000, V), text('道路境界線', 5000, 8300), text('隣地境界線', -300, 4000, V)];

describe('labeledEdges', () => {
  it('文字の近くに図枠の長い線があっても、ほかの境界線と端でつながる線を境界線にする', () => {
    // 図枠の線（60m）が境界線（y=500）より文字に近い（y=100）
    const frame = seg(-20000, 100, 40000, 100);
    const edges = labeledEdges(labels, [frame, ...boundary], bbox);
    expect(edges).toHaveLength(4);
    const top = edges.find((e) => Math.abs(e.a.y - 500) < 1 && Math.abs(e.b.y - 500) < 1);
    expect(top).toBeDefined();
    expect(edges.some((e) => Math.abs(e.a.y - 100) < 1)).toBe(false);
    expect(edges.find((e) => e.kind === 'road')?.a.y).toBeCloseTo(8000, 0);
  });
  it('同じ直線上の辺（文字が 2 つ・途中が欠けた境界線）は 1 本にまとめる', () => {
    const segs = [seg(0, 500, 3000, 500), seg(6000, 500, 10000, 500), ...boundary.slice(1)];
    const edges = labeledEdges([text('隣地境界線', 1500, 300), text('隣地境界線', 8000, 300), ...labels.slice(1)], segs, bbox);
    const tops = edges.filter((e) => Math.abs(e.a.y - 500) < 1 && Math.abs(e.b.y - 500) < 1);
    expect(tops).toHaveLength(1);
    expect(Math.min(tops[0].a.x, tops[0].b.x)).toBeCloseTo(0, 0);
    expect(Math.max(tops[0].a.x, tops[0].b.x)).toBeCloseTo(10000, 0);
  });
  it('つないだ結果が建物に比べて長すぎれば、文字のそばの線だけにする', () => {
    // 境界線の延長上に図枠の線が 1.2m おきに並ぶ
    const pieces: Seg[] = [];
    for (let x = 10000; x < 80000; x += 2000) pieces.push(seg(x + 500, 500, x + 1500, 500));
    const edges = labeledEdges(labels, [...boundary, ...pieces], bbox);
    const top = edges.find((e) => Math.abs(e.a.y - 500) < 1)!;
    expect(Math.max(top.a.x, top.b.x)).toBeLessThan(12000);
  });
});

describe('sitePolygon', () => {
  const E = (ax: number, ay: number, bx: number, by: number, kind: SiteEdge['kind'] = 'neighbor'): SiteEdge => ({ a: { x: ax, y: ay }, b: { x: bx, y: by }, kind });
  it('端が近い辺はそこでつなぎ、交わる辺は交点、平行で端が 4m 以内なら文字の無い短い辺を補う', () => {
    // (0,0)-(10000,0)-(10000,8000)-(2000,8000)-(2000,10000)-(-2000,10000)-(-2000,0) の敷地。(2000,8000)-(2000,10000) の 2m の辺には文字が無い
    const edges = [E(-2000, 0, 10000, 0), E(10000, 0, 10000, 8000), E(10000, 8000, 2000, 8000), E(2000, 10000, -2000, 10000), E(-2000, 10000, -2000, 0)];
    const poly = sitePolygon(edges, { x: 4000, y: 4000 })!;
    expect(poly).toBeDefined();
    expect(poly).toHaveLength(6);
    const has = (x: number, y: number) => poly.some((p) => Math.hypot(p.x - x, p.y - y) < 1);
    for (const [x, y] of [[10000, 0], [10000, 8000], [2000, 8000], [2000, 10000], [-2000, 10000], [-2000, 0]] as const) expect(has(x, y)).toBe(true);
  });
  it('欠けた角は交点で補う', () => {
    const edges = [E(0, 0, 10000, 0), E(10000, 0, 10000, 8000), E(10000, 8000, 2000, 8000), E(0, 5000, 0, 0)];
    const poly = sitePolygon(edges, { x: 5000, y: 4000 })!;
    expect(poly).toHaveLength(4);
    expect(poly.some((p) => Math.hypot(p.x - 0, p.y - 8000) < 1)).toBe(true);
  });
  it('つながらなければ作らない', () => {
    expect(sitePolygon([E(0, 0, 10000, 0), E(10000, 0, 10000, 8000), E(30000, 8000, 20000, 8000)], { x: 5000, y: 4000 })).toBeUndefined();
  });
});

describe('detectSite', () => {
  it('境界線 4 本から敷地の形と大きさ', () => {
    const site = detectSite(labels, boundary, bbox, 0)!;
    expect(site.polygon).toHaveLength(4);
    expect(site.bounds).toEqual({ left: 0, right: 10000, top: 500, bottom: 8000 });
    expect(site.roads.map((r) => r.side)).toEqual(['bottom']);
    expect(site.warning).toBeUndefined();
    expect(siteSize(site)).toEqual({ w: 10000, h: 7500, areaM2: 75 });
  });
  it('建物の 4 倍を超える広さに読めたら、図面の敷地線は使わず理由を残す', () => {
    const big = [seg(-30000, -30000, 40000, -30000), seg(40000, -30000, 40000, 40000), seg(40000, 40000, -30000, 40000), seg(-30000, 40000, -30000, -30000)];
    const bl = [text('隣地境界線', 5000, -30300), text('隣地境界線', 40300, 5000, V), text('道路境界線', 5000, 40300), text('隣地境界線', -30300, 5000, V)];
    const site = detectSite(bl, big, bbox, 0)!;
    expect(site.warning).toMatch(/倍/);
    expect(site.polygon).toBeUndefined();
    expect(site.edges).toBeUndefined();
    expect(Object.keys(site.bounds)).toHaveLength(0);
    // 接道の向きは残る
    expect(site.roads.map((r) => r.side)).toEqual(['bottom']);
  });
});

describe('敷地の作り直し・手直し', () => {
  const model = (): BuildingModel => ({
    name: 't',
    floors: [{ level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, walls: [], openings: [], rooms: [], stairs: [], outline: [[{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 8000 }, { x: 0, y: 8000 }]] }],
    northAngleDeg: 0,
    site: { roads: [{ side: 'bottom', source: 'manual' }], bounds: {} },
    report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} },
  });
  it('建物の周りに作り直す: 道路側は広く、ほかは狭く。道路側の辺が道路境界になる', () => {
    const m = model();
    const site = siteAroundBuilding(m, 6000, 1500)!;
    expect(site.bounds).toEqual({ left: -1500, right: 11500, top: -1500, bottom: 14000 });
    expect(site.polygon).toHaveLength(4);
    expect(site.edges!.map((e) => e.kind)).toEqual(['neighbor', 'neighbor', 'road', 'neighbor']);
    expect(siteSize(site)!.areaM2).toBeCloseTo(13 * 15.5, 3);
  });
  it('角を動かすと境界の位置と辺が付いてくる（辺の種類は元の辺から引き継ぐ）', () => {
    const m = model();
    const site = siteAroundBuilding(m, 6000, 1500)!;
    // 右下の角を右へ 2m・下へ 1m
    site.polygon![2] = { x: 13500, y: 15000 };
    syncSiteFromPolygon(site);
    expect(site.bounds.right).toBe(13500);
    expect(site.bounds.bottom).toBe(15000);
    expect(site.edges!.map((e) => e.kind)).toEqual(['neighbor', 'neighbor', 'road', 'neighbor']);
    expect(site.edges![2].a).toEqual({ x: 13500, y: 15000 });
  });
  it('元の辺が無ければ接道の向きの辺を道路境界に', () => {
    const poly: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }].map((p) => ({ x: p.x * 1000, y: p.y * 1000 }));
    expect(siteEdgesFromPolygon(poly, [{ side: 'left', source: 'manual' }], undefined).map((e) => e.kind)).toEqual(['neighbor', 'neighbor', 'neighbor', 'road']);
  });
  it('図面の敷地線を使わない: 境界・形・辺を消し、接道は残す', () => {
    const site: SiteData = { roads: [{ side: 'top', source: 'text', widthMm: 4000 }], bounds: { top: -5000, left: -1000 }, polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], edges: [], warning: 'x' };
    clearSiteLines(site);
    expect(site.bounds).toEqual({});
    expect(site.polygon).toBeUndefined();
    expect(site.edges).toBeUndefined();
    expect(site.warning).toMatch(/使わない/);
    expect(site.roads[0].widthMm).toBe(4000);
    expect(siteSize(site)).toBeNull();
  });
  it('接道の表記が無ければ、玄関の向きを道路側にして作り直す', () => {
    const m = model();
    m.site = { roads: [], bounds: {} };
    // 上（北）の外壁に玄関
    m.floors[0].walls = [{ id: 'n', a: { x: 0, y: 0 }, b: { x: 10000, y: 0 }, thickness: 150, exterior: true, outsideSign: -1 }];
    m.floors[0].openings = [{ id: 'e', wallId: 'n', kind: 'entrance', t0: 4000, t1: 5000, sill: 0, height: 2300, hingeAtStart: true, swingSide: 1, confidence: 1 }];
    expect(entranceSide(m)).toBe('top');
    const site = siteAroundBuilding(m, 6000, 1500)!;
    expect(site.bounds.top).toBe(-6000);
    expect(site.bounds.bottom).toBe(9500);
    expect(site.edges!.map((e) => e.kind)).toEqual(['road', 'neighbor', 'neighbor', 'neighbor']);
    // 接道そのものは増やさない（3D は玄関の向きを道路側として扱う）
    expect(site.roads).toHaveLength(0);
  });
});
