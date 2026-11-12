// 3D の階段のつくり（コーディネートの「階段」の品目 → BuildOptions.stairBuild）と手すり・段数（こだわり指定 = Stair.look）:
// 鉄骨／木のスケルトン／箱階段／片持ち × アイアン／ガラス／腰壁／木／なし
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildBuilding } from '../src/scene/building';
import { exteriorById } from '../src/styles/presets';
import { FINISH_CATEGORIES, STAIR_PRODUCT_OF_BUILD, stairBuildOf } from '../src/coordinate/catalog';
import { DEFAULT_DESIGN } from '../src/styles/presets';
import type { BuildingModel, Floor, Stair, StairBuild, StairLook, Vec2, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const wall = (id: string, a: Vec2, b: Vec2): Wall => ({ id, a, b, thickness: 150, exterior: true, outsideSign: 1 as const });
/** 8m × 6m の 2 階建て。西の外壁沿いに直階段（910 × 3,185。南から昇る）。東側は LDK に開いている */
const model = (look?: StairLook): BuildingModel => {
  const o = rect(0, 0, 8000, 6000);
  const walls = (lv: number): Wall[] => [wall(`n${lv}`, o[0], o[1]), wall(`e${lv}`, o[1], o[2]), wall(`s${lv}`, o[2], o[3]), wall(`w${lv}`, o[3], o[0])];
  const stair = (id: string, goesUp: boolean): Stair => ({ id, minX: 100, minY: 1000, maxX: 1010, maxY: 4185, kind: 'straight', entry: 's', goesUp, ...(look && goesUp ? { look } : {}) });
  const floor = (level: number): Floor => ({
    level,
    elevation: 500 + (level - 1) * 2900,
    height: 2900,
    ceilingHeight: 2400,
    outline: [o],
    rooms: [{ id: `r${level}`, name: level === 1 ? 'LDK' : 'ホール', type: level === 1 ? 'ldk' : 'hall', polygon: o, labelPos: { x: 4000, y: 3000 }, area: 48 }],
    stairs: [stair(`F${level}-S1`, level === 1)],
    openings: [],
    walls: walls(level),
  });
  return { name: 't', floors: [floor(1), floor(2)], northAngleDeg: 0, report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} } };
};
const style = exteriorById('hl-jolypat-grey');

/** 階段のまわり（x 0〜1.5m・z 0.9〜4.3m・1 階の床〜2 階の床の上 1.2m）にある頂点を、素材ごとに数える。あわせて段の踏板の最低の高さ */
function census(look?: StairLook, build?: StairBuild): { n: Record<string, number>; minTreadY: number } {
  const { mb } = buildBuilding(model(look), { exterior: style, ...(build ? { stairBuild: build } : {}) });
  const g = mb.build(() => new THREE.MeshBasicMaterial());
  const n: Record<string, number> = {};
  let minTreadY = Infinity;
  for (const mesh of g.children as THREE.Mesh[]) {
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (x < 0.09 || x > 1.5 || z < 0.9 || z > 4.3 || y < 0.52 || y > 4.6) continue;
      n[mesh.name] = (n[mesh.name] ?? 0) + 1;
      if (mesh.name === 'int.stairs') minTreadY = Math.min(minTreadY, y);
    }
  }
  return { n, minTreadY };
}
const of = (c: { n: Record<string, number> }, key: string) => c.n[key] ?? 0;

describe('階段のつくり（BuildOptions.stairBuild）', () => {
  const base = census();

  it('指定なし = 鉄骨: 踏板・中央の桁・アイアンの手すり。ガラスは無い', () => {
    expect(of(base, 'int.stairs')).toBeGreaterThan(0);
    expect(of(base, 'f.metal')).toBeGreaterThan(0);
    expect(of(base, 'ext.glass')).toBe(0);
    expect(census({ rail: 'bar' }, 'steel').n).toEqual(base.n);
  });

  it('木のスケルトン: 両側に黒い塗りつぶしの側板（品目「木製スケルトン階段」どおり）。鉄の桁は無い', () => {
    const c = census({ rail: 'none' }, 'woodSkeleton');
    expect(of(c, 'f.paintBlack')).toBeGreaterThan(0);
    expect(of(base, 'f.paintBlack')).toBe(0);
    expect(of(c, 'int.stairs')).toBe(of(base, 'int.stairs'));
    expect(of(c, 'f.metal')).toBe(0);
  });

  it('箱階段: 蹴込み板と段の両脇（壁の仕上げ）が付き、鉄の桁・受け材は無い', () => {
    const c = census({ rail: 'none' }, 'box');
    expect(of(c, 'int.wall')).toBeGreaterThan(of(base, 'int.wall'));
    expect(of(c, 'f.metal')).toBe(0);
    expect(of(c, 'ext.frame')).toBeLessThan(of(base, 'ext.frame') || 1);
  });

  it('片持ち: 踏板だけ（厚み 60）。桁・側板・受け材が無い', () => {
    const c = census({ rail: 'none' }, 'cantilever');
    expect(of(c, 'f.metal')).toBe(0);
    expect(of(c, 'int.stairs')).toBe(of(base, 'int.stairs'));
    // 厚い踏板のぶん、いちばん下の段の下端が 20mm 低い
    expect(base.minTreadY - c.minTreadY).toBeCloseTo(0.02, 3);
  });
});

describe('階段の手すり（Stair.look.rail）', () => {
  const none = census({ rail: 'none' });

  it('なし: 鉄は中央の桁だけ', () => {
    expect(of(none, 'f.metal')).toBeGreaterThan(0);
    expect(of(none, 'f.metal')).toBeLessThan(of(census(), 'f.metal'));
  });

  it('ガラス: 開いている側（LDK の側）にガラスのパネル', () => {
    const c = census({ rail: 'glass' });
    expect(of(c, 'ext.glass')).toBeGreaterThan(0);
  });

  it('腰壁: 壁の仕上げの板と、木の笠木', () => {
    const c = census({ rail: 'wall' });
    expect(of(c, 'int.wall')).toBeGreaterThan(of(none, 'int.wall'));
    expect(of(c, 'f.wood')).toBeGreaterThan(0);
    expect(of(c, 'f.metal')).toBe(of(none, 'f.metal'));
  });

  it('木: 木の支柱と手すり（鉄は桁だけ）', () => {
    const c = census({ rail: 'wood' });
    expect(of(c, 'f.wood')).toBeGreaterThan(0);
    expect(of(c, 'f.metal')).toBe(of(none, 'f.metal'));
  });
});

describe('指定の段数（Stair.look.steps）', () => {
  it('段数を増やすと、踏板の数が増える', () => {
    const a = census({ rail: 'none' }, 'cantilever');
    const b = census({ rail: 'none', steps: 16 }, 'cantilever');
    expect(of(b, 'int.stairs')).toBeGreaterThan(of(a, 'int.stairs'));
  });
});

describe('階段のつくり = コーディネートの「階段」の品目', () => {
  const cat = FINISH_CATEGORIES.find((c) => c.id === 'stair')!;

  it('4 通りのつくりすべてに品目がある（3D・説明文・仕様書が同じ品目を見る）', () => {
    for (const b of Object.keys(STAIR_PRODUCT_OF_BUILD) as StairBuild[]) {
      const id = STAIR_PRODUCT_OF_BUILD[b];
      expect(cat.products.some((p) => p.id === id), id).toBe(true);
      expect(stairBuildOf({ ...DEFAULT_DESIGN, finishes: { stair: id } })).toBe(b);
    }
  });

  it('選んでいなければ鉄骨（御社の標準）', () => {
    expect(stairBuildOf({ ...DEFAULT_DESIGN, finishes: {} })).toBe('steel');
    expect(stairBuildOf({ ...DEFAULT_DESIGN, finishes: { stair: 'stair.wood' } })).toBe('woodSkeleton');
  });
});
