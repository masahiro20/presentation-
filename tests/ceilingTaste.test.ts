// 御社のテイスト（2026-11-12 の学び直し）: 天井の全面板張りはしない。
//  - 内観のテイストの天井は、どれも平らな塗り・クロス（壁と同じ色か白）
//  - コーディネートの「天井」の先頭は「壁と同じ色」。板張りは LDK の天井だけに張る選択肢
//  - 雰囲気（ムード）も、板張りの天井を提案しない
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildBuilding } from '../src/scene/building';
import { DEFAULT_DESIGN, exteriorById, INTERIOR_STYLES, interiorById } from '../src/styles/presets';
import { resolveSpec } from '../src/styles/spec';
import { FINISH_CATEGORIES, selectedProduct, stylesFor } from '../src/coordinate/catalog';
import { MOODS } from '../src/coordinate/moods';
import { computeEstimate, newChoice } from '../src/estimate/calc';
import { estimateGroupsFor } from '../src/coordinate/catalog';
import type { BuildingModel, Floor, Opening, Room, Vec2, Wall } from '../src/core/types';

describe('内観のテイスト: 天井は平らな塗り・クロス', () => {
  it('どのテイストも、天井を板張り（羽目板）にしていない', () => {
    for (const s of INTERIOR_STYLES) {
      expect(s.ceiling.pattern, s.id).not.toBe('woodSiding');
      expect(s.ceilingMain, s.id).toBeUndefined();
      expect(s.name, s.id).not.toMatch(/木の天井|羽目板天井|板張りの天井/);
    }
  });

  it('既定のテイスト（グレーの塗り壁 × オーク）は、天井が壁と同じ色', () => {
    const s = interiorById(DEFAULT_DESIGN.interiorId);
    expect(s.id).toBe('hl-grey-oak');
    expect(s.ceiling.color).toBe(s.wall.color);
    expect(s.name).toBe('グレーの塗り壁 × オーク');
  });
});

describe('コーディネートの「天井」', () => {
  const cat = FINISH_CATEGORIES.find((c) => c.id === 'ceiling')!;

  it('選んでいなければ「壁と同じ色」（仕様書にもそう出る）', () => {
    expect(selectedProduct(cat, DEFAULT_DESIGN).id).toBe('ceil.cloth');
    expect(selectedProduct(cat, DEFAULT_DESIGN).name).toContain('壁と同じ色');
  });

  it('「壁と同じ色」は、選んだ内壁の色がそのまま天井になる', () => {
    const s = stylesFor({ ...DEFAULT_DESIGN, finishes: { wall: 'wall.cloth.greige', ceiling: 'ceil.cloth' } }).int;
    expect(s.ceiling.color).toBe(s.wall.color);
    expect(s.ceiling.color).toBe('#cfc8bd');
    // 白い天井にしたいときは「ホワイト」
    const w = stylesFor({ ...DEFAULT_DESIGN, finishes: { wall: 'wall.cloth.greige', ceiling: 'ceil.white' } }).int;
    expect(w.ceiling.color).toBe('#f1efeb');
    expect(w.wall.color).toBe('#cfc8bd');
  });

  it('板張りは LDK の天井だけ: ほかの部屋の天井は変わらない', () => {
    const base = stylesFor(DEFAULT_DESIGN).int;
    const s = stylesFor({ ...DEFAULT_DESIGN, finishes: { ceiling: 'ceil.sugi' } }).int;
    expect(s.ceilingMain?.pattern).toBe('woodSiding');
    expect(s.ceiling).toEqual(base.ceiling);
    expect(cat.products.find((p) => p.id === 'ceil.sugi')!.name).toContain('LDK の天井だけ');
    // 選び直すと、LDK の板張りも外れる
    expect(stylesFor({ ...DEFAULT_DESIGN, finishes: { ceiling: 'ceil.white' } }).int.ceilingMain).toBeUndefined();
  });

  it('3D: LDK の天井と、ほかの部屋の天井は別の素材の面になっている', () => {
    const P = (x: number, y: number): Vec2 => ({ x, y });
    const o = [P(0, 0), P(8000, 0), P(8000, 6000), P(0, 6000)];
    const wall = (id: string, a: Vec2, b: Vec2): Wall => ({ id, a, b, thickness: 150, exterior: true, outsideSign: 1 as const });
    const room = (id: string, type: Room['type'], polygon: Vec2[]): Room => ({ id, name: type, type, polygon, labelPos: P((polygon[0].x + polygon[2].x) / 2, 3000), area: 24 });
    const f: Floor = {
      level: 1,
      elevation: 500,
      height: 2900,
      ceilingHeight: 2400,
      outline: [o],
      rooms: [room('ldk', 'ldk', [P(0, 0), P(5000, 0), P(5000, 6000), P(0, 6000)]), room('hall', 'hall', [P(5000, 0), P(8000, 0), P(8000, 6000), P(5000, 6000)])],
      stairs: [],
      openings: [],
      walls: [wall('n', o[0], o[1]), wall('e', o[1], o[2]), wall('s', o[2], o[3]), wall('w', o[3], o[0])],
    };
    const m: BuildingModel = { name: 't', floors: [f], northAngleDeg: 0, report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} } };
    const g = buildBuilding(m, { exterior: exteriorById('hl-jolypat-grey') }).mb.build(() => new THREE.MeshBasicMaterial());
    const xRange = (key: string) => {
      const mesh = (g.children as THREE.Mesh[]).find((c) => c.name === key)!;
      const pos = mesh.geometry.getAttribute('position');
      const xs = Array.from({ length: pos.count }, (_, i) => pos.getX(i));
      return [Math.min(...xs), Math.max(...xs)];
    };
    expect(xRange('int.ceilingMain')).toEqual([0, 5]);
    expect(xRange('int.ceiling')).toEqual([5, 8]);
  });
});

describe('雰囲気（ムード）', () => {
  it('どの雰囲気も、板張りの天井を提案しない（天井は壁と同じ色）', () => {
    for (const m of MOODS) {
      expect(m.finishes.ceiling, m.id).not.toBe('ceil.sugi');
      expect(m.name, m.id).not.toMatch(/木の天井/);
      expect(m.catch, m.id).not.toMatch(/杉の天井|羽目板の天井|木の天井/);
    }
    expect(MOODS[0].name).toBe('グレーの塗り壁とオーク');
  });
});

describe('見積: 箱階段・片持ち階段（2026-11-12 のお話）', () => {
  const areas = { stairs: 1 } as unknown as Parameters<typeof computeEstimate>[0];
  const priceOf = (stair: string) => {
    const choice = newChoice('S');
    choice.groups = { ...choice.groups, ...estimateGroupsFor({ ...DEFAULT_DESIGN, finishes: { stair } }) };
    const lines = computeEstimate(areas, choice).categories.flatMap((c) => c.lines).filter((l) => l.group === 'stair' && l.selected);
    expect(lines).toHaveLength(1);
    return { id: lines[0].id, price: lines[0].unitPrice };
  };

  it('箱階段は、お客様への金額で 55〜60 万円', () => {
    const box = priceOf('stair.box');
    expect(box.id).toBe('ib.stairBox');
    expect(box.price).toBeGreaterThanOrEqual(550000);
    expect(box.price).toBeLessThanOrEqual(600000);
  });

  it('片持ち階段は、鉄骨階段と同じ金額', () => {
    expect(priceOf('stair.cantilever')).toEqual(priceOf('stair.steel'));
    expect(priceOf('stair.steel').id).toBe('ib.stairSt');
  });
});

describe('間接照明（天井際の光の線と、壁を照らす光）', () => {
  // 8m × 6m の LDK。北の壁（長さ 8m・窓なし）の途中に、幅 900 の戸がある
  const P = (x: number, y: number): Vec2 => ({ x, y });
  const o = [P(0, 0), P(8000, 0), P(8000, 6000), P(0, 6000)];
  const wall = (id: string, a: Vec2, b: Vec2): Wall => ({ id, a, b, thickness: 150, exterior: true, outsideSign: 1 as const });
  const door: Opening = { id: 'd1', wallId: 'n', kind: 'door', t0: 3000, t1: 3900, sill: 0, height: 2000 };
  const f: Floor = {
    level: 1,
    elevation: 500,
    height: 2900,
    ceilingHeight: 2400,
    outline: [o],
    rooms: [{ id: 'ldk', name: 'LDK', type: 'ldk', polygon: o, labelPos: P(4000, 3000), area: 48 }],
    stairs: [],
    openings: [door],
    walls: [wall('n', o[0], o[1]), wall('e', o[1], o[2]), wall('s', o[2], o[3]), wall('w', o[3], o[0])],
  };
  const m: BuildingModel = { name: 't', floors: [f], northAngleDeg: 0, report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} } };
  const meshes = (indirect: boolean) => {
    const g = buildBuilding(m, { exterior: exteriorById('hl-jolypat-grey'), spec: resolveSpec('minimal-lines', { indirectLighting: indirect }) }).mb.build(() => new THREE.MeshBasicMaterial());
    return new Map((g.children as THREE.Mesh[]).map((c) => [c.name, c]));
  };

  it('間接照明ありなら、光の線（f.cove）と、壁を照らす光の面（f.coveGlow）ができる', () => {
    const on = meshes(true);
    expect(on.has('f.cove')).toBe(true);
    expect(on.has('f.coveGlow')).toBe(true);
    const off = meshes(false);
    expect(off.has('f.cove')).toBe(false);
    expect(off.has('f.coveGlow')).toBe(false);
  });

  it('壁を照らす光は、戸の所には出さない（光だけが宙に浮いて見えるため）。天井際から 60cm で消える', () => {
    const glow = meshes(true).get('f.coveGlow')!;
    const pos = glow.geometry.getAttribute('position');
    const pts = Array.from({ length: pos.count }, (_, i) => ({ x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) }));
    // 戸の左右に 1 枚ずつ（三角形 2 枚 × 2 = 頂点 12）
    expect(pts).toHaveLength(12);
    expect(pts.some((p) => p.x > 2.95 && p.x < 3.95)).toBe(false);
    // 高さ: 天井（0.5 + 2.4 = 2.9m）の少し下から 60cm 下まで
    expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(2.88, 2);
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(2.28, 2);
    // 壁の面（壁の芯 z = 0 から 75mm 室内側）のすぐ手前
    for (const p of pts) expect(p.z).toBeCloseTo(0.079, 3);
    // 光源の側（天井際）が UV の v = 1
    const uv = glow.geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) expect(uv.getY(i)).toBeCloseTo(pts[i].y > 2.5 ? 1 : 0, 5);
  });
});
