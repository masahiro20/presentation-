// 吹抜の縁の手すり（2026-11-12）:
//  - 鉄骨手すりは、御社の施工事例の形 = 細い黒のフレーム（支柱は少なく、上の手すりと横桟 1 本）。縦桟を細かく並べない
//  - つながる辺（角・曲がった縁の短い線分）は 1 本の手すりにまとめ、支柱は両端・角・その間の等分にだけ立てる
//  - 家全体の設定で、鉄骨手すり・腰壁・ガラス手すりを選べる
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildBuilding, voidRects } from '../src/scene/building';
import { polygonArea } from '../src/core/geometry';
import { exteriorById } from '../src/styles/presets';
import { resolveSpec, VOID_GUARD_SPECS, type VoidGuardSpec } from '../src/styles/spec';
import type { BuildingModel, Floor, Room, Vec2, VoidGuard, Wall } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const O = [P(0, 0), P(8000, 0), P(8000, 6000), P(0, 6000)];
const wall = (id: string, a: Vec2, b: Vec2): Wall => ({ id, a, b, thickness: 150, exterior: true, outsideSign: 1 as const });
const walls = (lv: number): Wall[] => [wall(`n${lv}`, O[0], O[1]), wall(`e${lv}`, O[1], O[2]), wall(`s${lv}`, O[2], O[3]), wall(`w${lv}`, O[3], O[0])];
const room = (id: string, type: Room['type'], polygon: Vec2[], labelPos: Vec2, extra: Partial<Room> = {}): Room => ({ id, name: type, type, polygon, labelPos, area: 20, ...extra });

/**
 * 8m × 6m の 2 階建て。2 階の東側が吹抜で、ホールとの境に壁は無い（図面に手すりの線が無い縁）。
 * @param edge ホールと吹抜の境の折れ線（上の外壁 y=0 から下の外壁 y=6000 まで。北 → 南）
 */
const model = (edge: Vec2[], voidGuard?: VoidGuard): BuildingModel => {
  const hall = [O[0], ...edge, O[3]];
  const vd = [...edge.slice().reverse(), O[1], O[2]];
  // 吹抜の多角形: 境の折れ線（南 → 北）→ 北東 → 南東。向きはどちらでもよい
  const f1: Floor = { level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, outline: [O], rooms: [room('r1', 'ldk', O, P(4000, 3000))], stairs: [], openings: [], walls: walls(1) };
  const f2: Floor = {
    level: 2,
    elevation: 3400,
    height: 2900,
    ceilingHeight: 2400,
    outline: [O],
    rooms: [room('h2', 'hall', hall, P(1500, 3000)), room('v2', 'void', vd, P(6500, 3000), voidGuard ? { voidGuard } : {})],
    stairs: [],
    openings: [],
    walls: walls(2),
  };
  return { name: 't', floors: [f1, f2], northAngleDeg: 0, report: { pages: 1, scaleDenominator: 100, mmPerPt: 0.3528, scaleSource: 'text', wallThicknesses: [], warnings: [], timingsMs: {} } };
};
const style = exteriorById('hl-jolypat-grey');

/** 2 階の床から上 1.2m の範囲の、素材ごとの箱の数（箱 1 個 = 三角形 12 枚 = 頂点 36）と、頂点の位置 */
function boxes(m: BuildingModel, guard?: VoidGuardSpec): { n: Record<string, number>; pts: Record<string, THREE.Vector3[]> } {
  const { mb } = buildBuilding(m, { exterior: style, ...(guard ? { spec: resolveSpec('minimal-lines', { voidGuard: guard }) } : {}) });
  const g = mb.build(() => new THREE.MeshBasicMaterial());
  const n: Record<string, number> = {};
  const pts: Record<string, THREE.Vector3[]> = {};
  for (const mesh of g.children as THREE.Mesh[]) {
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      // 2 階の床から上 1.2m だけを数える（外壁には鉄・ガラスが無いので、吹抜の縁の手すりだけが残る）
      if (v.y < 3.39 || v.y > 4.61 || v.x < 0.3) continue;
      n[mesh.name] = (n[mesh.name] ?? 0) + 1 / 36;
      (pts[mesh.name] ??= []).push(v);
    }
  }
  for (const k of Object.keys(n)) n[k] = Math.round(n[k] * 100) / 100;
  return { n, pts };
}

/** まっすぐな縁（x = 4000。長さ 6m） */
const STRAIGHT = [P(4000, 0), P(4000, 6000)];
/** 途中が曲がった縁: 3m まっすぐ → 半径 1m の四分円（15° ごとの 6 本の短い線分。1 本 約 260mm）→ 東へ 3m は吹抜の南の縁 */
const ARC = [P(4000, 0), P(4000, 3000), ...[15, 30, 45, 60, 75, 90].map((d) => P(Math.round(5000 - 1000 * Math.cos((d * Math.PI) / 180)), Math.round(3000 + 1000 * Math.sin((d * Math.PI) / 180)))), P(8000, 4000)];

describe('鉄骨手すり = 細い黒のフレーム（支柱は少なく、上の手すりと横桟 1 本）', () => {
  it('まっすぐ 6m の縁: 支柱は 1.2m 以下の等分（6 本）、横材は上の手すりと横桟の 2 本だけ', () => {
    const b = boxes(model(STRAIGHT));
    // 両端の支柱は端から 30mm 内側。5.94m ÷ 1.2 → 5 等分 = 支柱 6 本
    expect(b.n['f.metal']).toBe(6 + 2);
    // 縦桟を並べていない: 鉄の頂点の高さは、床・上の手すり（H1100）・横桟（H550）の 3 つの高さだけ
    const ys = [...new Set(b.pts['f.metal'].map((v) => Math.round((v.y - 3.4) * 1000)))].sort((p, q) => p - q);
    expect(ys).toEqual([0, 550, 559, 1088, 1100]);
  });

  it('曲がった縁（短い線分が 6 本続く）でも、線分ごとに支柱を立てない', () => {
    const b = boxes(model(ARC));
    // 1 本につながった手すり: 長さ 約 7.5m（3m ＋ 四分円 1.57m ＋ 3m）→ 支柱は 7 等分で 8 本。横材は線分ごとに 2 本（8 線分 × 2）
    // （線分ごとに支柱を 2 本ずつ立てていた作りでは、四分円の 6 本の線分だけで支柱が 12 本並んでいた）
    const posts = b.n['f.metal'] - 8 * 2;
    expect(posts).toBe(8);
    // 四分円のあたり（x 3.9〜5.0・z 3.05〜4.1）の支柱は 2 本まで。支柱は床に立つ箱（床の高さの頂点が 1 本あたり 18）
    const feet = b.pts['f.metal'].filter((v) => Math.abs(v.y - 3.4) < 0.001 && v.x > 3.9 && v.x < 5.0 && v.z > 3.05 && v.z < 4.1);
    expect(feet.length / 18).toBeLessThanOrEqual(2);
  });

  it('縦格子（iron）を選ぶと、細い丸棒が 100mm ごとに並ぶ（小さなお子さまのいるご家庭向けの選択肢として残す）', () => {
    const b = boxes(model(STRAIGHT, 'iron'));
    // 支柱 6 本 ＋ 上の平鋼 1 本（箱）と、丸棒 58 本（箱ではないので端数になる）
    expect(b.n['f.metal']).toBeGreaterThan(20);
  });
});

describe('家全体の設定で、鉄骨手すり・腰壁・ガラス手すりを選べる', () => {
  it('選択肢は 鉄骨手すり・腰壁・ガラス手すり・腰壁＋ガラス・壁 の順（御社で多い順）', () => {
    expect(VOID_GUARD_SPECS.map((g) => g.value)).toEqual(['rail', 'half', 'glass', 'halfGlass', 'wall']);
    expect(VOID_GUARD_SPECS.map((g) => g.label)).toEqual(['鉄骨手すり', '腰壁', 'ガラス手すり', '腰壁＋ガラス', '壁']);
  });

  it('ガラス手すり: 細い支柱とガラス。鉄骨手すりではガラスは無い', () => {
    const glass = boxes(model(STRAIGHT), 'glass');
    expect(glass.n['ext.glass']).toBe(1);
    // 支柱は 1.5m 以下の等分（5 本）＋ 上の縁の平鋼 1 本
    expect(glass.n['f.metal']).toBe(5 + 1);
    expect(boxes(model(STRAIGHT), 'rail').n['ext.glass']).toBeUndefined();
  });

  it('腰壁: 壁の仕上げの箱だけで、鉄もガラスも無い', () => {
    const half = boxes(model(STRAIGHT), 'half');
    expect(half.n['f.metal']).toBeUndefined();
    expect(half.n['ext.glass']).toBeUndefined();
    expect(Object.keys(half.n).some((k) => k.startsWith('int.wall'))).toBe(true);
  });

  it('吹抜ごとの指定（3D で縁をクリック）は、家全体の設定より優先', () => {
    const b = boxes(model(STRAIGHT, 'glass'), 'half');
    expect(b.n['ext.glass']).toBe(1);
  });
});

describe('吹抜は、形どおりに床・天井を抜く（外接の四角で抜かない）', () => {
  const areaOf = (rs: { minX: number; maxX: number; minY: number; maxY: number }[]) => rs.reduce((a, r) => a + (r.maxX - r.minX) * (r.maxY - r.minY), 0);

  it('長方形の吹抜は 1 枚', () => {
    expect(voidRects([P(0, 0), P(3000, 0), P(3000, 2000), P(0, 2000)])).toEqual([{ minX: 0, maxX: 3000, minY: 0, maxY: 2000 }]);
  });

  it('L 字の吹抜: 欠けている角（吹抜の脇の廊下）は抜かない', () => {
    const L = [P(0, 0), P(3000, 0), P(3000, 2000), P(1000, 2000), P(1000, 4000), P(0, 4000)];
    const rs = voidRects(L);
    expect(areaOf(rs)).toBe(Math.abs(polygonArea(L)));
    // 欠けている角（x 1000〜3000・y 2000〜4000）に掛かる長方形は無い
    expect(rs.some((r) => r.maxX > 1000 && r.maxY > 2000 && r.minY >= 2000 && r.minX >= 1000)).toBe(false);
  });

  it('角の丸い吹抜: 帯に分けて近似する（面積の差は 1% 未満。外接の四角よりずっと小さい）', () => {
    // 3m × 3m の左上の角を、半径 1m の四分円（15° ごと）で丸めた形
    const arc = [0, 15, 30, 45, 60, 75, 90].map((d) => P(Math.round(1000 - 1000 * Math.cos((d * Math.PI) / 180)), Math.round(1000 - 1000 * Math.sin((d * Math.PI) / 180))));
    const poly = [...arc, P(3000, 0), P(3000, 3000), P(0, 3000)];
    const rs = voidRects(poly);
    const a = Math.abs(polygonArea(poly));
    expect(Math.abs(areaOf(rs) - a) / a).toBeLessThan(0.01);
    expect(areaOf(rs)).toBeLessThan(3000 * 3000 - 150000);
    // 丸い角より下（y 1000〜3000）は、両脇が鉛直なので 1 枚にまとまる（丸い角の最後の帯も同じ幅なら一緒になる）
    const low = rs.filter((r) => r.maxY === 3000);
    expect(low).toHaveLength(1);
    expect(low[0].minY).toBeLessThanOrEqual(1000);
    expect(low[0].minY).toBeGreaterThan(900);
  });
});
