// 想定の家（未建築の隣家）: プリセット・値の整え・足元・ジオメトリ（高さ・閉じた殻・外向き・グループ）・区画への配置・隣の区画
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { distPointSegment, pointInPolygon, polygonArea, type EN } from '../src/sun/align';
import {
  PLANNED_COLORS,
  PLANNED_EAVE_OVERHANG,
  PLANNED_GROUP_ROOF,
  PLANNED_GROUP_WALL,
  PLANNED_PRESETS,
  PLANNED_PRESET_IDS,
  PLANNED_ROOF_THICKNESS,
  buildPlannedHouseGeometry,
  clampHouse,
  houseFromPreset,
  houseInLot,
  mirrorLotAcrossEdge,
  plannedFootprint,
  plannedLocalToEN,
  plannedPreset,
  syncPlannedHouse,
  translateLotAcrossEdge,
  type PlannedHouse,
  type RoofType,
} from '../src/sun/plannedHouse';

/** 日照ツールと同じ EN → ワールド（x = 東, y = 上, z = 南） */
const enToWorld = (e: number, n: number, y: number) => new THREE.Vector3(e, y, -n);

const house = (roof: RoofType, extra: Partial<PlannedHouse> = {}): PlannedHouse =>
  clampHouse({ id: 'h1', ce: 3, cn: -2, width: 10, depth: 7, rotDeg: 0, eaveHeight: 6, ridgeHeight: 8.5, roof, ...extra });

const positions = (g: THREE.BufferGeometry) => g.getAttribute('position') as THREE.BufferAttribute;

function yRange(g: THREE.BufferGeometry): [number, number] {
  const p = positions(g);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < p.count; i++) {
    lo = Math.min(lo, p.getY(i));
    hi = Math.max(hi, p.getY(i));
  }
  return [lo, hi];
}

/** 向き付きの辺 a→b と b→a が同じ数だけある（閉じた・向きの揃った殻の和） */
function unbalancedEdges(g: THREE.BufferGeometry): number {
  const p = positions(g);
  const key = (i: number) => `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
  const count = new Map<string, number>();
  for (let t = 0; t < p.count; t += 3) {
    const k = [key(t), key(t + 1), key(t + 2)];
    for (let j = 0; j < 3; j++) {
      const a = k[j];
      const b = k[(j + 1) % 3];
      count.set(`${a}|${b}`, (count.get(`${a}|${b}`) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [e, c] of count) {
    const [a, b] = e.split('|');
    if ((count.get(`${b}|${a}`) ?? 0) !== c) bad++;
  }
  return bad;
}

/** 符号付きの体積（外向きの巻きなら正） */
function signedVolume(g: THREE.BufferGeometry): number {
  const p = positions(g);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let v = 0;
  for (let t = 0; t < p.count; t += 3) {
    a.fromBufferAttribute(p, t);
    b.fromBufferAttribute(p, t + 1);
    c.fromBufferAttribute(p, t + 2);
    v += a.dot(b.clone().cross(c)) / 6;
  }
  return v;
}

/** 屋根の上面の高さ（局所 u, v の真上から下へ光線を飛ばす） */
function topAt(g: THREE.BufferGeometry, h: PlannedHouse, u: number, v: number): number | null {
  const p = plannedLocalToEN(h, u, v);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const rc = new THREE.Raycaster(new THREE.Vector3(p.e, 500, -p.n), new THREE.Vector3(0, -1, 0));
  const hit = rc.intersectObject(mesh)[0];
  return hit ? hit.point.y : null;
}

describe('プリセット・値の整え', () => {
  it('プリセットの寸法・名前', () => {
    expect(PLANNED_PRESETS.map((p) => [p.id, p.label, p.width, p.depth, p.eaveHeight, p.ridgeHeight, p.roof])).toEqual([
      ['hiraya', '平屋（切妻）', 12, 8, 3, 5, 'gable'],
      ['gable2', '2 階建て（切妻）', 9.1, 7.3, 6, 8.5, 'gable'],
      ['shed2', '2 階建て（片流れ）', 9.1, 7.3, 5.5, 7.5, 'shed'],
      ['hip2', '2 階建て（寄棟）', 9.1, 7.3, 6, 8, 'hip'],
      ['flat3', '3 階建て（陸屋根）', 8, 8, 9.5, 9.5, 'flat'],
      ['apartment2', 'アパート 2 階（陸屋根）', 16, 9, 7, 7, 'flat'],
      ['box', '箱（高さだけ）', 8, 8, 7, 7, 'flat'],
    ]);
    expect(PLANNED_PRESET_IDS).toHaveLength(7);
    expect(plannedPreset('nope' as never).id).toBe('gable2');
    expect(PLANNED_COLORS).toEqual({ wall: '#cfdcec', roof: '#6f8fb3' });
  });

  it('clampHouse: 下限・棟 ≥ 軒・陸屋根は棟 = 軒・方位・知らない値', () => {
    const h = clampHouse({ id: 'x', ce: 1, cn: 2, width: 0.2, depth: -5, rotDeg: -90, eaveHeight: 7, ridgeHeight: 5, roof: 'gable' });
    expect(h.width).toBe(1);
    expect(h.depth).toBe(1);
    expect(h.rotDeg).toBe(270);
    expect(h.ridgeHeight).toBe(7);
    const f = clampHouse({ roof: 'flat', eaveHeight: 6, ridgeHeight: 9 });
    expect(f.ridgeHeight).toBe(6);
    expect(f.id).toMatch(/^planned:/);
    const bad = clampHouse({ roof: 'dome', width: NaN, rotDeg: Infinity, preset: 'shed2', label: '  ' } as never);
    expect(bad.roof).toBe('shed');
    expect(bad.width).toBe(9.1);
    expect(bad.rotDeg).toBe(0);
    expect(bad.preset).toBe('shed2');
    expect(bad.label).toBeUndefined();
    expect(clampHouse({ label: ` ${'あ'.repeat(60)} ` }).label).toHaveLength(40);
    expect(clampHouse(null).roof).toBe('gable');
    expect(clampHouse({ rotDeg: 725 }).rotDeg).toBeCloseTo(5, 9);
  });

  it('houseFromPreset と足元（反時計回り、width の軸が方位 rotDeg）', () => {
    const h = houseFromPreset('hiraya', 10, 20, 90, { label: '南の想定' });
    expect(h).toMatchObject({ ce: 10, cn: 20, width: 12, depth: 8, rotDeg: 90, eaveHeight: 3, ridgeHeight: 5, roof: 'gable', preset: 'hiraya', label: '南の想定' });
    const fp = plannedFootprint(h);
    expect(fp).toHaveLength(4);
    expect(polygonArea(fp)).toBeCloseTo(96, 9);
    // rotDeg 90 → width は東西（e が 12 m）、+depth は北
    const es = fp.map((p) => p.e);
    const ns = fp.map((p) => p.n);
    expect(Math.max(...es) - Math.min(...es)).toBeCloseTo(12, 9);
    expect(Math.max(...ns) - Math.min(...ns)).toBeCloseTo(8, 9);
    expect(plannedLocalToEN(h, 0, 4).n).toBeCloseTo(24, 9);
  });

  it('syncPlannedHouse: 中心はリングの平均、高さだけ直したら軒も同じ比で', () => {
    const h = houseFromPreset('gable2', 0, 0, 30, { id: 's' });
    const ring = plannedFootprint(h).map((p) => ({ e: p.e + 5, n: p.n - 2 }));
    const s = syncPlannedHouse(h, ring, 17);
    expect(s.ce).toBeCloseTo(5, 9);
    expect(s.cn).toBeCloseTo(-2, 9);
    expect(s.ridgeHeight).toBeCloseTo(17, 9);
    expect(s.eaveHeight).toBeCloseTo(12, 9);
    expect(syncPlannedHouse(h, plannedFootprint(h), h.ridgeHeight)).toBe(h);
  });
});

describe('ジオメトリ', () => {
  const cases: [RoofType, Partial<PlannedHouse>][] = [
    ['gable', {}],
    ['gable', { rotDeg: 37, width: 7, depth: 11 }],
    ['hip', {}],
    ['hip', { width: 6, depth: 9, rotDeg: 120 }],
    ['hip', { width: 8, depth: 8 }],
    ['shed', { eaveHeight: 5.5, ridgeHeight: 7.5, rotDeg: 200 }],
    ['flat', { eaveHeight: 9.5 }],
    ['gable', { eaveHeight: 6, ridgeHeight: 6 }],
  ];
  for (const [roof, extra] of cases)
    for (const eaves of [true, false])
      it(`${roof} ${JSON.stringify(extra)} 軒の出 ${eaves}: 最高点 = baseY + 棟、閉じた殻・外向き・体積・グループ`, () => {
        const h = house(roof, extra);
        const baseY = 12.3;
        const sink = 0.3;
        const g = buildPlannedHouseGeometry(h, { toWorld: enToWorld, baseY, eaves, sink });
        expect(g.index).toBeNull();
        const [lo, hi] = yRange(g);
        expect(hi).toBeCloseTo(baseY + h.ridgeHeight, 4);
        expect(lo).toBeCloseTo(baseY - sink, 4);
        expect(unbalancedEdges(g)).toBe(0);
        // 体積（外向きなら正）: 本体（足元 × 屋根の上面 − 厚さ）+ 屋根の板（軒の出を含む平面積 × 厚さ）
        const W = h.width;
        const D = h.depth;
        const E = h.eaveHeight;
        const H = h.ridgeHeight - E;
        const flat = roof === 'flat';
        const o = flat || !eaves ? 0 : PLANNED_EAVE_OVERHANG;
        const t = flat ? 0 : PLANNED_ROOF_THICKNESS;
        const roofVol = flat || H === 0 ? 0 : roof === 'gable' ? (W * D * H) / 2 : roof === 'hip' ? (D * H * (3 * W - D)) / 6 : W * D * (H / (D + o)) * (D / 2);
        const expected = W * D * (sink + E - t) + roofVol + (W + 2 * o) * (D + 2 * o) * t;
        if (roof === 'hip' && W < D) {
          // 方形（棟の長さ 0）で縦横が違う: 4 面の勾配が違うので体積は角錐 W·D·H/3
          expect(signedVolume(g)).toBeCloseTo(W * D * (sink + E - t) + (W * D * H) / 3 + (W + 2 * o) * (D + 2 * o) * t, 3);
        } else expect(signedVolume(g)).toBeCloseTo(expected, 3);
        // 法線は単位長さ
        const nor = g.getAttribute('normal');
        for (let i = 0; i < nor.count; i += 7) expect(Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i))).toBeCloseTo(1, 5);
        // グループ: 0 = 屋根, 1 = 壁
        expect(g.groups).toHaveLength(2);
        expect(g.groups[0]).toMatchObject({ start: 0, materialIndex: PLANNED_GROUP_ROOF });
        expect(g.groups[1].materialIndex).toBe(PLANNED_GROUP_WALL);
        expect(g.groups[0].count + g.groups[1].count).toBe(positions(g).count);
        expect(g.groups[0].count).toBeGreaterThan(0);
        expect(g.groups[1].count).toBeGreaterThan(0);
        // 平面の広がり: 軒の出の分だけ足元より大きい（陸屋根は足元のまま）
        const fp = plannedFootprint(h);
        const p = positions(g);
        let maxOut = 0;
        for (let i = 0; i < p.count; i++) {
          const q = { e: p.getX(i), n: -p.getZ(i) };
          if (pointInPolygon(q, fp)) continue;
          maxOut = Math.max(maxOut, Math.min(...fp.map((a, k) => distPointSegment(q, a, fp[(k + 1) % 4]))));
        }
        // 軒の出の板の四隅は足元の角から o·√2
        expect(maxOut).toBeCloseTo(o * Math.SQRT2, 6);
      });

  it('軒の線: 壁の線での屋根の上面 = baseY + 軒の高さ、棟の上 = baseY + 棟、軒先は軒より下', () => {
    const baseY = 2;
    const h = house('gable');
    const g = buildPlannedHouseGeometry(h, { toWorld: enToWorld, baseY });
    expect(topAt(g, h, 1.3, -h.depth / 2 + 1e-4)).toBeCloseTo(baseY + h.eaveHeight, 3);
    expect(topAt(g, h, -2, h.depth / 2 - 1e-4)).toBeCloseTo(baseY + h.eaveHeight, 3);
    expect(topAt(g, h, 0.5, 0)).toBeCloseTo(baseY + h.ridgeHeight, 3);
    const slope = (h.ridgeHeight - h.eaveHeight) / (h.depth / 2);
    expect(topAt(g, h, 0, -h.depth / 2 - PLANNED_EAVE_OVERHANG + 1e-4)).toBeCloseTo(baseY + h.eaveHeight - slope * PLANNED_EAVE_OVERHANG, 3);
    // 妻側の軒の出（けらば）も屋根
    expect(topAt(g, h, h.width / 2 + 0.3, 0)).toBeCloseTo(baseY + h.ridgeHeight, 3);
    expect(topAt(g, h, h.width / 2 + PLANNED_EAVE_OVERHANG + 0.05, 0)).toBeNull();
  });

  it('寄棟: 棟の長さ = 幅 − 奥行き、端は棟より低い', () => {
    const h = house('hip', { width: 12, depth: 8, eaveHeight: 6, ridgeHeight: 8 });
    const g = buildPlannedHouseGeometry(h, { toWorld: enToWorld, baseY: 0 });
    expect(topAt(g, h, 1.9, 0)).toBeCloseTo(8, 3);
    expect(topAt(g, h, -1.9, 0)).toBeCloseTo(8, 3);
    // 棟の端（u = 2）から 1 m: 端の面は 4 m で 2 m 上がる
    expect(topAt(g, h, 3, 0)).toBeCloseTo(7.5, 3);
    expect(topAt(g, h, h.width / 2 - 1e-4, 0)).toBeCloseTo(6, 3);
    expect(topAt(g, h, 0, -h.depth / 2 + 1e-4)).toBeCloseTo(6, 3);
  });

  it('片流れ: +depth 側が高い（軒の出の端 = 棟）、−depth 側の壁の線 = 軒', () => {
    const h = house('shed', { eaveHeight: 5.5, ridgeHeight: 7.5 });
    const g = buildPlannedHouseGeometry(h, { toWorld: enToWorld, baseY: 0 });
    expect(topAt(g, h, 0, -h.depth / 2 + 1e-4)).toBeCloseTo(5.5, 3);
    expect(topAt(g, h, 0, h.depth / 2 + PLANNED_EAVE_OVERHANG - 1e-4)).toBeCloseTo(7.5, 3);
    const g2 = buildPlannedHouseGeometry(h, { toWorld: enToWorld, baseY: 0, eaves: false });
    expect(topAt(g2, h, 0, h.depth / 2 - 1e-4)).toBeCloseTo(7.5, 3);
    expect(yRange(g2)[1]).toBeCloseTo(7.5, 6);
  });

  it('陸屋根は箱（軒の出なし）。鏡映の toWorld でも外向き', () => {
    const h = house('flat', { eaveHeight: 9.5 });
    const g = buildPlannedHouseGeometry(h, { toWorld: enToWorld, baseY: 0 });
    expect(signedVolume(g)).toBeCloseTo(h.width * h.depth * 9.5, 4);
    const mirrored = buildPlannedHouseGeometry(house('gable'), { toWorld: (e, n, y) => new THREE.Vector3(e, y, n), baseY: 0 });
    expect(signedVolume(mirrored)).toBeGreaterThan(0);
    expect(unbalancedEdges(mirrored)).toBe(0);
  });

  it('回転した toWorld（プレゼン側の北の向き）でも高さ・外向きは同じ', () => {
    const a = (25 * Math.PI) / 180;
    const east = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const north = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
    const toWorld = (e: number, n: number, y: number) => new THREE.Vector3(4, y, -3).addScaledVector(east, e).addScaledVector(north, n);
    const h = house('hip');
    const g = buildPlannedHouseGeometry(h, { toWorld, baseY: 0 });
    const ref = buildPlannedHouseGeometry(h, { toWorld: enToWorld, baseY: 0 });
    expect(signedVolume(g)).toBeCloseTo(signedVolume(ref), 4);
    expect(yRange(g)[1]).toBeCloseTo(h.ridgeHeight, 5);
  });
});

// ---------------------------------------------------------------------------
// 区画
// ---------------------------------------------------------------------------

const rect = (e0: number, n0: number, w: number, d: number): EN[] => [
  { e: e0, n: n0 },
  { e: e0 + w, n: n0 },
  { e: e0 + w, n: n0 + d },
  { e: e0, n: n0 + d },
];
const rotateAll = (pts: EN[], deg: number, c: EN = { e: 0, n: 0 }): EN[] => {
  const r = (deg * Math.PI) / 180;
  return pts.map((p) => ({ e: c.e + (p.e - c.e) * Math.cos(r) - (p.n - c.n) * Math.sin(r), n: c.n + (p.e - c.e) * Math.sin(r) + (p.n - c.n) * Math.cos(r) }));
};

/** 足元の境界（各辺 40 点）がすべて区画の内側で、各辺からその離れ以上。区画の頂点は足元の外 */
function checkInLot(h: PlannedHouse, lot: EN[], setback: (i: number) => number) {
  const fp = plannedFootprint(h);
  for (const c of fp) expect(pointInPolygon(c, lot)).toBe(true);
  for (let k = 0; k < 4; k++)
    for (let j = 0; j <= 40; j++) {
      const a = fp[k];
      const b = fp[(k + 1) % 4];
      const p = { e: a.e + ((b.e - a.e) * j) / 40, n: a.n + ((b.n - a.n) * j) / 40 };
      expect(pointInPolygon(p, lot)).toBe(true);
      for (let i = 0; i < lot.length; i++) expect(distPointSegment(p, lot[i], lot[(i + 1) % lot.length])).toBeGreaterThanOrEqual(setback(i) - 1e-6);
    }
  for (const v of lot) expect(pointInPolygon(v, fp)).toBe(false);
}

describe('houseInLot（区画の中に置く）', () => {
  it('長方形の区画（間口 10 × 奥行き 15、南が道路）: 2 階建てを縦向きに満寸で、北側に寄せる', () => {
    const lot = rect(0, 0, 10, 15);
    const h = houseInLot(lot, { frontEdgeIndex: 0 })!;
    expect(h).not.toBeNull();
    expect(h.width).toBeCloseTo(9.1, 6);
    expect(h.depth).toBeCloseTo(7.3, 6);
    expect(h.preset).toBe('gable2');
    // 間口 10 − 2 = 8 m に 9.1 m は入らないので棟は南北
    expect(Math.abs(((h.rotDeg + 90) % 180) - 90)).toBeLessThan(0.5);
    checkInLot(h, lot, (i) => (i === 0 ? 2 : 1));
    // 北の離れ 1 m まで寄せる（北端 = 14）
    expect(h.cn + h.width / 2).toBeGreaterThan(13.85);
    expect(h.label).toBeUndefined();
    const c = houseInLot(lot, { frontEdgeIndex: 0, prefer: 'center' })!;
    expect(Math.abs(c.cn - 7.5)).toBeLessThan(1.5);
  });

  it('建ぺい率で縮める（8 × 12 の区画、50 % = 48 m²）・寸法は建ぺい率以内', () => {
    const lot = rect(-4, 5, 8, 12);
    const h = houseInLot(lot, { coverage: 0.5 })!;
    expect(h.width * h.depth).toBeLessThanOrEqual(48 + 1e-6);
    expect(h.width * h.depth).toBeGreaterThan(40);
    checkInLot(h, lot, () => 1);
    const h60 = houseInLot(lot, { coverage: 0.6, preset: 'hiraya', sideSetback: 0.5 })!;
    expect(h60.width * h60.depth).toBeLessThanOrEqual(57.6 + 1e-6);
    expect(h60.roof).toBe('gable');
    expect(h60.ridgeHeight).toBe(5);
    checkInLot(h60, lot, () => 0.5);
  });

  it('回転した区画: 区画の向きに合わせる', () => {
    const lot = rotateAll(rect(20, 30, 11, 16), 30, { e: 25, n: 38 });
    const h = houseInLot(lot, { frontEdgeIndex: 0, preset: 'hip2' })!;
    // 数学の向きで 30° 回した区画の辺の方位は 60°（mod 90）
    const m = ((h.rotDeg % 90) + 90) % 90;
    expect(Math.min(Math.abs(m - 60), 90 - Math.abs(m - 60))).toBeLessThan(0.5);
    expect(h.width).toBeCloseTo(9.1, 6);
    expect(h.roof).toBe('hip');
    checkInLot(h, lot, (i) => (i === 0 ? 2 : 1));
  });

  it('L 字の区画: 入隅の角が家に食い込まない', () => {
    const lot: EN[] = [
      { e: 0, n: 0 },
      { e: 20, n: 0 },
      { e: 20, n: 8 },
      { e: 8, n: 8 },
      { e: 8, n: 20 },
      { e: 0, n: 20 },
    ];
    const h = houseInLot(lot, { frontEdgeIndex: 0 })!;
    expect(h).not.toBeNull();
    checkInLot(h, lot, (i) => (i === 0 ? 2 : 1));
    // 狭い L 字（腕の幅 7 m）でも外に出ない（縮める）
    const thin: EN[] = [
      { e: 0, n: 0 },
      { e: 18, n: 0 },
      { e: 18, n: 7 },
      { e: 7, n: 7 },
      { e: 7, n: 18 },
      { e: 0, n: 18 },
    ];
    const t = houseInLot(thin, { frontEdgeIndex: 0, preset: 'apartment2' })!;
    expect(t).not.toBeNull();
    checkInLot(t, thin, (i) => (i === 0 ? 2 : 1));
    expect(t.depth).toBeLessThanOrEqual(7 - 2 - 1 + 1e-6);
  });

  it('旗竿地: 竿（幅 3 m）には置かず、奥の旗の部分に置く', () => {
    const lot: EN[] = [
      { e: 0, n: 0 },
      { e: 3, n: 0 },
      { e: 3, n: 15 },
      { e: 14, n: 15 },
      { e: 14, n: 28 },
      { e: -4, n: 28 },
      { e: -4, n: 15 },
      { e: 0, n: 15 },
    ];
    const h = houseInLot(lot, { frontEdgeIndex: 0 })!;
    expect(h).not.toBeNull();
    checkInLot(h, lot, (i) => (i === 0 ? 2 : 1));
    for (const c of plannedFootprint(h)) expect(c.n).toBeGreaterThan(16 - 1e-6);
    expect(h.width).toBeCloseTo(9.1, 6);
  });

  it('時計回りの区画・閉じる点の重複も同じ。小さすぎる区画・壊れた区画は null', () => {
    const lot = rect(0, 0, 12, 14);
    const cw = [...lot].reverse();
    const a = houseInLot(lot)!;
    const b = houseInLot([...cw, cw[0]])!;
    expect(b.width * b.depth).toBeCloseTo(a.width * a.depth, 3);
    checkInLot(b, lot, () => 1);
    expect(houseInLot(rect(0, 0, 4, 4))).toBeNull();
    expect(houseInLot([{ e: 0, n: 0 }, { e: 1, n: 1 }])).toBeNull();
    expect(houseInLot([{ e: 0, n: 0 }, { e: 5, n: 0 }, { e: 10, n: 0 }])).toBeNull();
    expect(houseInLot([{ e: 0, n: 0 }, { e: NaN, n: 0 }, { e: 10, n: 10 }])).toBeNull();
  });
});

describe('隣の区画（鏡映・平行移動）', () => {
  /** b が辺 (a0, a1) の直線の a と反対側にある（重ならない）: a の各点の符号と b の各点の符号が逆（0 は可） */
  const sides = (poly: EN[], a0: EN, a1: EN) => poly.map((p) => (a1.e - a0.e) * (p.n - a0.n) - (a1.n - a0.n) * (p.e - a0.e));
  const hasPoint = (poly: EN[], q: EN) => poly.some((p) => Math.hypot(p.e - q.e, p.n - q.n) < 1e-9);
  const lots: [string, EN[]][] = [
    ['長方形', rect(0, 0, 10, 15)],
    ['回転した長方形', rotateAll(rect(5, -3, 9, 16), 23)],
    ['不整形の凸の区画', [{ e: 0, n: 0 }, { e: 11, n: 1 }, { e: 12, n: 14 }, { e: -1, n: 16 }]],
  ];
  for (const [name, site] of lots)
    for (let i = 0; i < site.length; i++)
      it(`${name}・辺 ${i}: 鏡映は辺を共有、平行移動は辺の直線に接する。どちらも重ならない`, () => {
        const a0 = site[i];
        const a1 = site[(i + 1) % site.length];
        const sSite = sides(site, a0, a1);
        const inner = Math.sign(sSite.reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0));
        const m = mirrorLotAcrossEdge(site, i);
        expect(m).toHaveLength(site.length);
        expect(hasPoint(m, a0) && hasPoint(m, a1)).toBe(true);
        expect(Math.sign(polygonArea(m))).toBe(Math.sign(polygonArea(site)));
        expect(Math.abs(polygonArea(m))).toBeCloseTo(Math.abs(polygonArea(site)), 6);
        for (const s of sides(m, a0, a1)) expect(s * inner).toBeLessThanOrEqual(1e-6);
        // 共有する辺は (2n − 2 − i) % n で、向きは逆
        const n = site.length;
        const k = (2 * n - 2 - i) % n;
        expect(Math.hypot(m[k].e - a1.e, m[k].n - a1.n)).toBeLessThan(1e-9);
        expect(Math.hypot(m[(k + 1) % n].e - a0.e, m[(k + 1) % n].n - a0.n)).toBeLessThan(1e-9);
        const t = translateLotAcrossEdge(site, i);
        expect(polygonArea(t)).toBeCloseTo(polygonArea(site), 6);
        const sT = sides(t, a0, a1);
        for (const s of sT) expect(s * inner).toBeLessThanOrEqual(1e-6);
        // 辺の直線に接する（最も近い点の距離 0）
        expect(Math.min(...sT.map((s) => Math.abs(s)))).toBeLessThan(1e-6);
        // 想定の家を隣の区画に置ける
        const h = houseInLot(t, { preset: 'box' });
        expect(h).not.toBeNull();
        checkInLot(h!, t, () => 1);
      });

  it('長方形の平行移動は向かいの辺がぴったり重なる（分譲地の並び）', () => {
    const site = rect(0, 0, 10, 15);
    expect(translateLotAcrossEdge(site, 1)).toEqual(rect(10, 0, 10, 15));
    expect(translateLotAcrossEdge(site, 2)).toEqual(rect(0, 15, 10, 15));
    expect(translateLotAcrossEdge(site, 3)).toEqual(rect(-10, 0, 10, 15));
    expect(translateLotAcrossEdge(site, 0)).toEqual(rect(0, -15, 10, 15));
  });
});
