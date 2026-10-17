/**
 * 2D 位置合わせソルバ（src/sun/align.ts）のテスト。DOM・THREE は使わない。
 * 角度の正規化、変換の適用・逆・合成、2 点対応と最小二乗の解（倍率あり・なし）、凸包、最小外接矩形、
 * 辺の主方向、境界の点列化、外形どうしの ICP、矩形どうしの向き合わせ、頂点配列の高さ帯の外形
 */
import { describe, expect, it } from 'vitest';
import {
  applyFit,
  bearingDeg,
  centroid,
  closestPointOnPolygon,
  composeFit,
  convexHull,
  densify,
  distPointSegment,
  dominantAngleDeg,
  fitPolygonToPolygon,
  fitRectToRect,
  invertFit,
  minAreaRect,
  normDeg,
  normDeg180,
  pointInPolygon,
  polygonArea,
  polygonPerimeter,
  sliceOutline,
  solveRigid,
  solveTwoPoint,
  type EN,
  type RigidFit,
  densifyBudget,
  MAX_ICP_POINTS,
} from '../src/sun/align';

const fitOf = (rotDeg: number, te: number, tn: number, scale = 1): RigidFit => ({ rotDeg, te, tn, scale, scaleRatio: scale, rmsM: 0 });
const mapAll = (f: RigidFit, pts: EN[]) => pts.map((p) => applyFit(f, p));
const expectEN = (got: EN, want: EN, tol = 1e-9) => {
  expect(Math.abs(got.e - want.e)).toBeLessThan(tol);
  expect(Math.abs(got.n - want.n)).toBeLessThan(tol);
};
/** 回転 angleDeg（上軸の方位）、中心 c、幅 w（直交方向）・奥行き d（上軸方向）の矩形の 4 隅（反時計回り） */
function rectAt(c: EN, angleDeg: number, w: number, d: number): EN[] {
  const up = { e: Math.sin(angleDeg * (Math.PI / 180)), n: Math.cos(angleDeg * (Math.PI / 180)) };
  const right = { e: up.n, n: -up.e };
  const at = (a: number, b: number): EN => ({ e: c.e + right.e * a + up.e * b, n: c.n + right.n * a + up.n * b });
  // (−w/2, −d/2) → (w/2, −d/2) → (w/2, d/2) → (−w/2, d/2): right 軸が +e のとき反時計回り
  return [at(-w / 2, -d / 2), at(w / 2, -d / 2), at(w / 2, d / 2), at(-w / 2, d / 2)];
}
/** 再現可能な擬似乱数 (−1, 1) */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}
const IRREGULAR: EN[] = [
  { e: 0, n: 0 },
  { e: 9.1, n: 0 },
  { e: 8.2, n: 6.5 },
  { e: 1.3, n: 7.28 },
];

describe('normDeg / normDeg180 / bearingDeg: 角度の正規化と方位', () => {
  it('normDeg は [0, 360)', () => {
    expect(normDeg(-90)).toBe(270);
    expect(normDeg(360)).toBe(0);
    expect(normDeg(725)).toBeCloseTo(5, 9);
    expect(Object.is(normDeg(-0), 0)).toBe(true);
    expect(Object.is(normDeg(-1e-20), 0)).toBe(true);
  });
  it('normDeg180 は (−180, 180]', () => {
    expect(normDeg180(270)).toBe(-90);
    expect(normDeg180(180)).toBe(180);
    expect(normDeg180(-180)).toBe(180);
    expect(normDeg180(540)).toBe(180);
    expect(normDeg180(-170)).toBe(-170);
  });
  it('方位: 北 0、東 90、南 180、西 270。零ベクトルは 0', () => {
    expect(bearingDeg({ e: 0, n: 1 })).toBe(0);
    expect(bearingDeg({ e: 1, n: 0 })).toBe(90);
    expect(bearingDeg({ e: 0, n: -1 })).toBe(180);
    expect(bearingDeg({ e: -1, n: 0 })).toBe(270);
    expect(bearingDeg({ e: 1, n: 1 })).toBeCloseTo(45, 9);
    expect(bearingDeg({ e: 0, n: 0 })).toBe(0);
    expect(bearingDeg({ e: -0, n: -0 })).toBe(0);
  });
});

describe('applyFit / invertFit / composeFit', () => {
  it('rotDeg は時計回り: 図面の上 (0, 1) は方位 rotDeg に写る', () => {
    expectEN(applyFit(fitOf(90, 0, 0), { e: 0, n: 1 }), { e: 1, n: 0 });
    expectEN(applyFit(fitOf(180, 0, 0), { e: 0, n: 1 }), { e: 0, n: -1 });
    for (const r of [0, 17, 90, 123.4, 250, 359]) expect(bearingDeg(applyFit(fitOf(r, 0, 0), { e: 0, n: 1 }))).toBeCloseTo(r, 9);
  });
  it('PlacedModel と同じ連鎖: pivot ローカル (x, z) → (e, n) = (x, −z) に heading を時計回りに回してから offset', () => {
    // pivot.rotation.y = −heading(rad) で (x, z) を回し、position = (offsetE, ·, −offsetN) を足したものと一致する
    const heading = 37;
    const h = heading * (Math.PI / 180);
    const x = 3.1;
    const z = -2.4;
    const ry = -h; // THREE の Y 軸回転: x' = x cos + z sin, z' = −x sin + z cos
    const x2 = x * Math.cos(ry) + z * Math.sin(ry);
    const z2 = -x * Math.sin(ry) + z * Math.cos(ry);
    const want = { e: x2 + 12.3, n: -(z2 + -(-4.5)) };
    expectEN(applyFit(fitOf(heading, 12.3, -4.5), { e: x, n: -z }), want);
  });
  it('invertFit は逆変換（倍率付き）', () => {
    const f: RigidFit = { rotDeg: 33, te: 12.3, tn: -4.5, scale: 0.001, scaleRatio: 0.001, rmsM: 0.002 };
    const inv = invertFit(f);
    for (const p of IRREGULAR) expectEN(applyFit(inv, applyFit(f, p)), p, 1e-9);
    expect(inv.scale).toBeCloseTo(1000, 9);
    expect(inv.rotDeg).toBeCloseTo(-33, 9);
    expect(inv.rmsM).toBeCloseTo(2, 9);
    const id = composeFit(inv, f);
    expect(id.rotDeg).toBeCloseTo(0, 9);
    expect(id.scale).toBeCloseTo(1, 9);
    expect(Math.hypot(id.te, id.tn)).toBeLessThan(1e-9);
  });
  it('composeFit(outer, inner)(p) = outer(inner(p))', () => {
    const inner = fitOf(17, 1, 2, 2);
    const outer = fitOf(-50, -3, 4, 0.5);
    const c = composeFit(outer, inner);
    for (const p of IRREGULAR) expectEN(applyFit(c, p), applyFit(outer, applyFit(inner, p)));
    expect(c.rotDeg).toBeCloseTo(-33, 9);
    expect(c.scale).toBeCloseTo(1, 9);
  });
  it('倍率 0 の変換は逆変換できない', () => {
    expect(() => invertFit(fitOf(0, 0, 0, 0))).toThrow();
  });
});

describe('solveTwoPoint: 2 点対応', () => {
  const p: [EN, EN] = [
    { e: 1, n: 2 },
    { e: 5, n: 7 },
  ];
  it('既知の回転 33° と平行移動 (12.3, −4.5) を正確に復元する', () => {
    const truth = fitOf(33, 12.3, -4.5);
    const q = mapAll(truth, p) as [EN, EN];
    const f = solveTwoPoint(p, q);
    expect(f.rotDeg).toBeCloseTo(33, 9);
    expect(f.te).toBeCloseTo(12.3, 9);
    expect(f.tn).toBeCloseTo(-4.5, 9);
    expect(f.scale).toBe(1);
    expect(f.scaleRatio).toBeCloseTo(1, 9);
    expect(f.rmsM).toBeLessThan(1e-9);
  });
  it('負の回転も (−180, 180] で返す', () => {
    const q = mapAll(fitOf(-120, 0, 0), p) as [EN, EN];
    expect(solveTwoPoint(p, q).rotDeg).toBeCloseTo(-120, 9);
  });
  it('allowScale: mm の図面 → m（倍率 0.001）を復元する', () => {
    const pmm: [EN, EN] = [
      { e: 1000, n: 2000 },
      { e: 5000, n: 7000 },
    ];
    const truth = fitOf(33, 12.3, -4.5, 0.001);
    const q = mapAll(truth, pmm) as [EN, EN];
    const f = solveTwoPoint(pmm, q, { allowScale: true });
    expect(f.scale).toBeCloseTo(0.001, 12);
    expect(f.scaleRatio).toBeCloseTo(0.001, 12);
    expect(f.rotDeg).toBeCloseTo(33, 9);
    expect(f.te).toBeCloseTo(12.3, 9);
    expect(f.tn).toBeCloseTo(-4.5, 9);
    expect(f.rmsM).toBeLessThan(1e-9);
    // 倍率を許さないと scale = 1 のまま、計測値だけ scaleRatio に入り、残差は大きい
    const g = solveTwoPoint(pmm, q);
    expect(g.scale).toBe(1);
    expect(g.scaleRatio).toBeCloseTo(0.001, 12);
    expect(g.rmsM).toBeGreaterThan(1);
  });
  it('長さが合わないとき、残差は両端で対称（中点が一致）', () => {
    const q: [EN, EN] = [
      { e: 0, n: 0 },
      { e: 0, n: 10 },
    ];
    const pp: [EN, EN] = [
      { e: 0, n: 0 },
      { e: 0, n: 9 },
    ];
    const f = solveTwoPoint(pp, q);
    const r0 = applyFit(f, pp[0]);
    const r1 = applyFit(f, pp[1]);
    // 中点 4.5 → 5 に合わせるので両端とも 0.5 ずれる（+0.5 と −0.5）
    expect(r0.n).toBeCloseTo(0.5, 9);
    expect(r1.n).toBeCloseTo(9.5, 9);
    expect(f.rmsM).toBeCloseTo(0.5, 9);
  });
  it('一致した 2 点は例外', () => {
    expect(() => solveTwoPoint([{ e: 1, n: 1 }, { e: 1, n: 1 + 1e-7 }], p)).toThrow();
    expect(() => solveTwoPoint(p, [{ e: 3, n: 3 }, { e: 3, n: 3 }])).toThrow();
  });
});

describe('solveRigid: N 点の最小二乗（Procrustes / Umeyama）', () => {
  const pts: EN[] = [
    { e: 0, n: 0 },
    { e: 9.1, n: 0 },
    { e: 8.2, n: 6.5 },
    { e: 1.3, n: 7.28 },
    { e: 4, n: 3 },
    { e: -2, n: 5 },
  ];
  it('既知の回転 −72° と平行移動 (3.2, 8.9) を正確に復元する', () => {
    const q = mapAll(fitOf(-72, 3.2, 8.9), pts);
    const f = solveRigid(pts, q);
    expect(f.rotDeg).toBeCloseTo(-72, 9);
    expect(f.te).toBeCloseTo(3.2, 9);
    expect(f.tn).toBeCloseTo(8.9, 9);
    expect(f.scale).toBe(1);
    expect(f.scaleRatio).toBeCloseTo(1, 9);
    expect(f.rmsM).toBeLessThan(1e-9);
  });
  it('allowScale: 倍率 0.001（mm → m）も復元する', () => {
    const pmm = pts.map((p) => ({ e: p.e * 1000, n: p.n * 1000 }));
    const q = mapAll(fitOf(200, 12.3, -4.5, 0.001), pmm);
    const f = solveRigid(pmm, q, { allowScale: true });
    expect(f.rotDeg).toBeCloseTo(-160, 9);
    expect(f.scale).toBeCloseTo(0.001, 12);
    expect(f.te).toBeCloseTo(12.3, 9);
    expect(f.tn).toBeCloseTo(-4.5, 9);
    expect(f.rmsM).toBeLessThan(1e-9);
    const g = solveRigid(pmm, q);
    expect(g.scale).toBe(1);
    expect(g.scaleRatio).toBeCloseTo(0.001, 12);
  });
  it('2 点なら solveTwoPoint と同じ解になる', () => {
    const p2: [EN, EN] = [pts[0], pts[2]];
    const q2 = mapAll(fitOf(33, 12.3, -4.5), p2) as [EN, EN];
    const a = solveRigid(p2, q2);
    const b = solveTwoPoint(p2, q2);
    expect(a.rotDeg).toBeCloseTo(b.rotDeg, 9);
    expect(a.te).toBeCloseTo(b.te, 9);
    expect(a.tn).toBeCloseTo(b.tn, 9);
  });
  it('ノイズ（±1 cm）があっても回転 0.1° 以内・残差 2 cm 以内', () => {
    const rnd = lcg(7);
    const q = mapAll(fitOf(17, 12.3, -4.5), pts).map((p) => ({ e: p.e + 0.01 * rnd(), n: p.n + 0.01 * rnd() }));
    const f = solveRigid(pts, q);
    expect(Math.abs(f.rotDeg - 17)).toBeLessThan(0.1);
    expect(Math.abs(f.te - 12.3)).toBeLessThan(0.02);
    expect(Math.abs(f.tn - -4.5)).toBeLessThan(0.02);
    expect(f.rmsM).toBeLessThan(0.02);
    expect(f.rmsM).toBeGreaterThan(0);
  });
  it('対応点が 2 組未満、数が違う、元の点が全部一致、は例外', () => {
    expect(() => solveRigid([pts[0]], [pts[1]])).toThrow();
    expect(() => solveRigid(pts, pts.slice(1))).toThrow();
    expect(() => solveRigid([{ e: 1, n: 1 }, { e: 1, n: 1 }], [pts[0], pts[1]])).toThrow();
  });
});

describe('convexHull: Andrew の monotone chain', () => {
  it('ノイズ入りの矩形（内側の点・辺上の点）→ 4 隅だけ、反時計回り', () => {
    const corners: EN[] = [
      { e: 0, n: 0 },
      { e: 9.1, n: 0 },
      { e: 9.1, n: 7.28 },
      { e: 0, n: 7.28 },
    ];
    const rnd = lcg(3);
    const noise: EN[] = [];
    for (let i = 0; i < 200; i++) noise.push({ e: 0.05 + 9 * (rnd() + 1) * 0.5, n: 0.05 + 7.18 * (rnd() + 1) * 0.5 });
    // 辺上（一直線上）の点と重複点も混ぜる
    noise.push({ e: 4.55, n: 0 }, { e: 9.1, n: 3.64 }, { e: 0, n: 0 }, { e: 9.1, n: 7.28 });
    const hull = convexHull([...noise, ...corners].sort(() => 0.5 - Math.random()));
    expect(hull).toHaveLength(4);
    expect(polygonArea(hull)).toBeGreaterThan(0);
    expect(polygonArea(hull)).toBeCloseTo(9.1 * 7.28, 9);
    const key = (p: EN) => `${p.e.toFixed(6)},${p.n.toFixed(6)}`;
    expect(new Set(hull.map(key))).toEqual(new Set(corners.map(key)));
  });
  it('L 字 → 凹んだ頂点を除いた 5 点、反時計回り', () => {
    const L: EN[] = [
      { e: 0, n: 0 },
      { e: 6, n: 0 },
      { e: 6, n: 2 },
      { e: 2, n: 2 },
      { e: 2, n: 5 },
      { e: 0, n: 5 },
    ];
    const hull = convexHull(L);
    expect(hull).toHaveLength(5);
    expect(polygonArea(hull)).toBeGreaterThan(0);
    expect(hull.some((p) => p.e === 2 && p.n === 2)).toBe(false);
    expect(hull.some((p) => p.e === 6 && p.n === 2)).toBe(true);
    expect(hull.some((p) => p.e === 2 && p.n === 5)).toBe(true);
    // 時計回りに与えても反時計回りで返る
    expect(polygonArea(convexHull(L.slice().reverse()))).toBeGreaterThan(0);
  });
  it('一直線上・3 点未満は []', () => {
    expect(convexHull([{ e: 0, n: 0 }, { e: 1, n: 1 }, { e: 2, n: 2 }, { e: 3, n: 3 }])).toEqual([]);
    expect(convexHull([{ e: 0, n: 0 }, { e: 1, n: 1 }])).toEqual([]);
    expect(convexHull([{ e: 0, n: 0 }, { e: 0, n: 0 }, { e: 1, n: 1 }])).toEqual([]);
    expect(convexHull([])).toEqual([]);
  });
});

describe('多角形の補助: 面積・重心・周長・内外判定・最近点', () => {
  const sq: EN[] = [
    { e: 0, n: 0 },
    { e: 4, n: 0 },
    { e: 4, n: 2 },
    { e: 0, n: 2 },
  ];
  it('polygonArea は反時計回りで正、centroid は面積重心、polygonPerimeter は周長', () => {
    expect(polygonArea(sq)).toBeCloseTo(8, 12);
    expect(polygonArea(sq.slice().reverse())).toBeCloseTo(-8, 12);
    expectEN(centroid(sq), { e: 2, n: 1 });
    expect(polygonPerimeter(sq)).toBeCloseTo(12, 12);
    // L 字の面積重心は頂点の平均とは違う
    const L: EN[] = [{ e: 0, n: 0 }, { e: 6, n: 0 }, { e: 6, n: 2 }, { e: 2, n: 2 }, { e: 2, n: 5 }, { e: 0, n: 5 }];
    const c = centroid(L);
    // 6×2 の長方形 (3,1) 面積 12 と 2×3 の長方形 (1,3.5) 面積 6
    expectEN(c, { e: (3 * 12 + 1 * 6) / 18, n: (1 * 12 + 3.5 * 6) / 18 }, 1e-9);
    // 一直線上は頂点の平均
    expectEN(centroid([{ e: 0, n: 0 }, { e: 2, n: 0 }, { e: 4, n: 0 }]), { e: 2, n: 0 });
    expect(() => centroid([])).toThrow();
  });
  it('pointInPolygon', () => {
    expect(pointInPolygon({ e: 1, n: 1 }, sq)).toBe(true);
    expect(pointInPolygon({ e: 5, n: 1 }, sq)).toBe(false);
    expect(pointInPolygon({ e: 1, n: -1 }, sq)).toBe(false);
  });
  it('distPointSegment と closestPointOnPolygon', () => {
    expect(distPointSegment({ e: 2, n: 3 }, { e: 0, n: 0 }, { e: 4, n: 0 })).toBeCloseTo(3, 12);
    expect(distPointSegment({ e: 6, n: 0 }, { e: 0, n: 0 }, { e: 4, n: 0 })).toBeCloseTo(2, 12);
    expect(distPointSegment({ e: 1, n: 1 }, { e: 2, n: 2 }, { e: 2, n: 2 })).toBeCloseTo(Math.SQRT2, 12);
    const r = closestPointOnPolygon({ e: 5, n: 1 }, sq);
    expectEN(r.point, { e: 4, n: 1 });
    expect(r.dist).toBeCloseTo(1, 12);
    const inside = closestPointOnPolygon({ e: 1, n: 0.5 }, sq);
    expectEN(inside.point, { e: 1, n: 0 });
    expect(inside.dist).toBeCloseTo(0.5, 12);
    expect(() => closestPointOnPolygon({ e: 0, n: 0 }, [])).toThrow();
  });
});

describe('minAreaRect: 最小外接矩形', () => {
  it('20° 回した 9.1 × 7.28 の矩形 → w, d は 1 mm 以内、角度は 0.01° 以内、4 隅は反時計回り', () => {
    const c = { e: 12.3, n: -4.5 };
    const rnd = lcg(11);
    const rect = rectAt(c, 20, 7.28, 9.1);
    const inner: EN[] = [];
    for (let i = 0; i < 50; i++) inner.push({ e: c.e + 2 * rnd(), n: c.n + 2 * rnd() });
    const r = minAreaRect([...rect, ...inner]);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.w - 7.28)).toBeLessThan(1e-3);
    expect(Math.abs(r!.d - 9.1)).toBeLessThan(1e-3);
    expect(Math.abs(r!.angleDeg - 20)).toBeLessThan(0.01);
    expectEN(r!.center, c, 1e-6);
    expect(r!.corners).toHaveLength(4);
    expect(polygonArea(r!.corners)).toBeCloseTo(9.1 * 7.28, 6);
    const key = (p: EN) => `${p.e.toFixed(6)},${p.n.toFixed(6)}`;
    expect(new Set(r!.corners.map(key))).toEqual(new Set(rect.map(key)));
  });
  it('角度は [0, 90) に正規化し、d はその軸方向の長さ（110° に回すと w と d が入れ替わる）', () => {
    const r = minAreaRect(rectAt({ e: 0, n: 0 }, 110, 7.28, 9.1));
    expect(r).not.toBeNull();
    expect(Math.abs(r!.angleDeg - 20)).toBeLessThan(0.01);
    expect(Math.abs(r!.w - 9.1)).toBeLessThan(1e-3);
    expect(Math.abs(r!.d - 7.28)).toBeLessThan(1e-3);
    // 軸に沿った矩形は角度 0、d は北方向の長さ
    const a = minAreaRect(rectAt({ e: 0, n: 0 }, 0, 7.28, 9.1));
    expect(a!.angleDeg).toBeCloseTo(0, 6);
    expect(a!.d).toBeCloseTo(9.1, 9);
    expect(a!.w).toBeCloseTo(7.28, 9);
    for (const deg of [0, 20, 45, 89, 90, 135, 179.5, 200]) {
      const m = minAreaRect(rectAt({ e: 1, n: 2 }, deg, 5, 3));
      expect(m!.angleDeg).toBeGreaterThanOrEqual(0);
      expect(m!.angleDeg).toBeLessThan(90);
      expect(m!.w * m!.d).toBeCloseTo(15, 6);
    }
  });
  it('一直線上・3 点未満は null', () => {
    expect(minAreaRect([{ e: 0, n: 0 }, { e: 1, n: 1 }, { e: 2, n: 2 }])).toBeNull();
    expect(minAreaRect([{ e: 0, n: 0 }, { e: 1, n: 1 }])).toBeNull();
  });
});

describe('dominantAngleDeg: 辺の主方向（90° 周期）', () => {
  it('回した矩形の角度を [0, 90) で返す', () => {
    expect(dominantAngleDeg(rectAt({ e: 0, n: 0 }, 20, 7.28, 9.1))).toBeCloseTo(20, 6);
    expect(dominantAngleDeg(rectAt({ e: 0, n: 0 }, 70, 7.28, 9.1))).toBeCloseTo(70, 6);
    expect(dominantAngleDeg(rectAt({ e: 0, n: 0 }, 110, 7.28, 9.1))).toBeCloseTo(20, 6);
    expect(dominantAngleDeg(rectAt({ e: 0, n: 0 }, 290, 7.28, 9.1))).toBeCloseTo(20, 6);
    const axis = dominantAngleDeg(rectAt({ e: 0, n: 0 }, 0, 7.28, 9.1));
    expect(Math.min(axis, 90 - axis)).toBeLessThan(1e-6);
  });
  it('長い辺の向きが優先される（短い斜めの辺がある L 字でも主方向は壁の向き）', () => {
    const L = rectAt({ e: 0, n: 0 }, 35, 10, 8);
    L.splice(1, 0, { e: (L[0].e + L[1].e) / 2 + 0.1, n: (L[0].n + L[1].n) / 2 - 0.1 });
    expect(Math.abs(dominantAngleDeg(L) - 35)).toBeLessThan(0.5);
  });
  it('向きが定まらないときは 0', () => {
    expect(dominantAngleDeg([])).toBe(0);
    expect(dominantAngleDeg([{ e: 0, n: 0 }, { e: 0, n: 0 }])).toBe(0);
  });
});

describe('densify: 境界の点列化', () => {
  it('10 × 10 の正方形を 3 m 間隔 → 各辺 4 分割で 16 点、隣どうしは 3 m 以下、すべて境界上', () => {
    const sq: EN[] = [{ e: 0, n: 0 }, { e: 10, n: 0 }, { e: 10, n: 10 }, { e: 0, n: 10 }];
    const pts = densify(sq, 3);
    expect(pts).toHaveLength(16);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      expect(Math.hypot(a.e - b.e, a.n - b.n)).toBeLessThanOrEqual(3 + 1e-12);
      expect(closestPointOnPolygon(a, sq).dist).toBeLessThan(1e-12);
    }
    expectEN(pts[0], sq[0]);
    expectEN(pts[4], sq[1]);
  });
  it('間隔が辺より長ければ頂点だけ', () => {
    expect(densify([{ e: 0, n: 0 }, { e: 1, n: 0 }, { e: 1, n: 1 }], 100)).toHaveLength(3);
    expect(() => densify([{ e: 0, n: 0 }], 0)).toThrow();
    expect(() => densify([{ e: 0, n: 0 }], NaN)).toThrow();
  });
});

describe('fitPolygonToPolygon: 外形どうしの ICP', () => {
  const truth = fitOf(17, 12.3, -4.5);
  it('不等辺四角形の 17° 回転 + (12.3, −4.5) の移動を復元する（rms < 1 mm）', () => {
    const dst = mapAll(truth, IRREGULAR);
    const f = fitPolygonToPolygon(IRREGULAR, dst);
    expect(Math.abs(f.rotDeg - 17)).toBeLessThan(0.01);
    expect(Math.abs(f.te - 12.3)).toBeLessThan(1e-3);
    expect(Math.abs(f.tn - -4.5)).toBeLessThan(1e-3);
    expect(f.scale).toBe(1);
    expect(f.score).toBeLessThan(1e-3);
    expect(f.rmsM).toBe(f.score);
    for (const p of IRREGULAR) expectEN(applyFit(f, p), applyFit(truth, p), 1e-3);
  });
  it('dst の頂点の順序・向きが違っても（逆順、開始点ずれ）同じ解', () => {
    const dst = mapAll(truth, IRREGULAR);
    const rotated = [...dst.slice(2), ...dst.slice(0, 2)].reverse();
    const f = fitPolygonToPolygon(IRREGULAR, rotated);
    expect(Math.abs(f.rotDeg - 17)).toBeLessThan(0.01);
    expect(Math.abs(f.te - 12.3)).toBeLessThan(1e-3);
    expect(Math.abs(f.tn - -4.5)).toBeLessThan(1e-3);
  });
  it('allowScale: mm の外形 → m（倍率 0.001）も復元する', () => {
    const srcMm = IRREGULAR.map((p) => ({ e: p.e * 1000, n: p.n * 1000 }));
    const dst = mapAll(truth, IRREGULAR);
    const f = fitPolygonToPolygon(srcMm, dst, { allowScale: true });
    expect(Math.abs(f.scale - 0.001)).toBeLessThan(1e-7);
    expect(Math.abs(f.rotDeg - 17)).toBeLessThan(0.01);
    expect(Math.abs(f.te - 12.3)).toBeLessThan(1e-3);
    expect(Math.abs(f.tn - -4.5)).toBeLessThan(1e-3);
    expect(f.score).toBeLessThan(1e-3);
  });
  it('ノイズ（±2 cm）のある dst でも回転 0.5° 以内・移動 3 cm 以内', () => {
    const rnd = lcg(5);
    const dst = mapAll(truth, IRREGULAR).map((p) => ({ e: p.e + 0.02 * rnd(), n: p.n + 0.02 * rnd() }));
    const f = fitPolygonToPolygon(IRREGULAR, dst);
    expect(Math.abs(f.rotDeg - 17)).toBeLessThan(0.5);
    expect(Math.abs(f.te - 12.3)).toBeLessThan(0.03);
    expect(Math.abs(f.tn - -4.5)).toBeLessThan(0.03);
    expect(f.score).toBeLessThan(0.05);
  });
  it('矩形の 180° のあいまいさ: 既定では 0° に近い候補、initialRotDeg を与えればそれに近い候補', () => {
    const rect = rectAt({ e: 0, n: 0 }, 0, 7.28, 9.1);
    const dst = mapAll(fitOf(170, 12.3, -4.5), rect);
    const a = fitPolygonToPolygon(rect, dst);
    expect(Math.abs(a.rotDeg - -10)).toBeLessThan(0.01);
    expect(a.score).toBeLessThan(1e-3);
    const b = fitPolygonToPolygon(rect, dst, { initialRotDeg: [165] });
    expect(Math.abs(b.rotDeg - 170)).toBeLessThan(0.01);
    expect(b.score).toBeLessThan(1e-3);
    expectEN({ e: b.te, n: b.tn }, { e: 12.3, n: -4.5 }, 1e-3);
    // 90° の候補は w と d が合わないので選ばれない
    expect(Math.abs(normDeg180(a.rotDeg - b.rotDeg))).toBeCloseTo(180, 3);
  });
  it('正方形の 90° のあいまいさ: initialRotDeg に最も近い候補を返す', () => {
    const sq = rectAt({ e: 0, n: 0 }, 0, 8, 8);
    const dst = mapAll(fitOf(0, 3, 4), sq);
    expect(Math.abs(fitPolygonToPolygon(sq, dst).rotDeg)).toBeLessThan(0.01);
    expect(Math.abs(fitPolygonToPolygon(sq, dst, { initialRotDeg: [85] }).rotDeg - 90)).toBeLessThan(0.01);
    expect(Math.abs(fitPolygonToPolygon(sq, dst, { initialRotDeg: [-100] }).rotDeg - -90)).toBeLessThan(0.01);
    expect(Math.abs(normDeg(fitPolygonToPolygon(sq, dst, { initialRotDeg: [175] }).rotDeg) - 180)).toBeLessThan(0.01);
  });
  it('3 点未満・周長 0 の外形は例外', () => {
    expect(() => fitPolygonToPolygon(IRREGULAR.slice(0, 2), IRREGULAR)).toThrow(/3/);
    expect(() => fitPolygonToPolygon(IRREGULAR, [])).toThrow(/3/);
    expect(() => fitPolygonToPolygon([{ e: 1, n: 1 }, { e: 1, n: 1 }, { e: 1, n: 1 }], IRREGULAR)).toThrow();
  });
});

describe('fitRectToRect: 矩形どうしの向き合わせ', () => {
  const src = rectAt({ e: 0, n: 0 }, 0, 7.28, 9.1);
  it('w と d が入れ替わっていれば 90° の候補を選ぶ', () => {
    // dst は同じ寸法で w/d を入れ替えた（＝90° 回した）矩形
    const dst = rectAt({ e: 20, n: 5 }, 0, 9.1, 7.28);
    const f = fitRectToRect(src, dst);
    expect(f.swapped).toBe(true);
    expect(Math.abs(f.rotDeg)).toBeCloseTo(90, 6);
    expect(f.mismatchM).toBeLessThan(1e-6);
    expect(f.te).toBeCloseTo(20, 6);
    expect(f.tn).toBeCloseTo(5, 6);
    // 変換後の src の矩形は dst と重なる
    const moved = minAreaRect(mapAll(fitOf(f.rotDeg, f.te, f.tn), src))!;
    expect(moved.w).toBeCloseTo(9.1, 6);
    expect(moved.d).toBeCloseTo(7.28, 6);
    expectEN(moved.center, { e: 20, n: 5 }, 1e-6);
  });
  it('同じ向きなら 0°、swapped = false、平行移動 = 中心の差', () => {
    const dst = rectAt({ e: -3, n: 8 }, 0, 7.28, 9.1);
    const f = fitRectToRect(src, dst);
    expect(f.swapped).toBe(false);
    expect(Math.abs(f.rotDeg)).toBeLessThan(1e-6);
    expect(f.te).toBeCloseTo(-3, 6);
    expect(f.tn).toBeCloseTo(8, 6);
    expect(f.mismatchM).toBeLessThan(1e-6);
  });
  it('30° 回って寸法が少し違う dst: 回転 30°、mismatch = |Δw| + |Δd|、中心が一致', () => {
    const c = { e: 12.3, n: -4.5 };
    const dst = rectAt(c, 30, 7.4, 9.0);
    const f = fitRectToRect(src, dst);
    expect(f.swapped).toBe(false);
    expect(f.rotDeg).toBeCloseTo(30, 6);
    expect(f.mismatchM).toBeCloseTo(0.12 + 0.1, 6);
    expectEN(applyFit(fitOf(f.rotDeg, f.te, f.tn), { e: 0, n: 0 }), c, 1e-6);
  });
  it('src が 170° 回っているとき、同点（180° 違い）なら |rotDeg| の小さい方', () => {
    const s = rectAt({ e: 0, n: 0 }, 170, 7.28, 9.1);
    const d = rectAt({ e: 0, n: 0 }, 0, 7.28, 9.1);
    const f = fitRectToRect(s, d);
    // 170° の矩形は軸 80° (d = 7.28, w = 9.1) として表されるので Δ = −80: 候補 −80 / 10 / 100 / −170。
    // 正規化した軸に対しては w/d が入れ替わる 10 と −170 が一致（mismatch 0）→ |rotDeg| の小さい 10
    expect(f.rotDeg).toBeCloseTo(10, 6);
    expect(f.swapped).toBe(true);
    expect(f.mismatchM).toBeLessThan(1e-6);
    const moved = minAreaRect(mapAll(fitOf(f.rotDeg, f.te, f.tn), s))!;
    expect(moved.angleDeg).toBeCloseTo(0, 6);
    expect(moved.d).toBeCloseTo(9.1, 6);
  });
  it('矩形が作れない外形は例外', () => {
    expect(() => fitRectToRect([{ e: 0, n: 0 }, { e: 1, n: 1 }, { e: 2, n: 2 }], src)).toThrow();
  });
});

describe('sliceOutline: 頂点配列の高さ帯の外形', () => {
  // 8 × 6 の壁（y = 0 と 3）と、0.6 m はね出した屋根（y = 5）。x → e、z → −n
  const pos: number[] = [];
  const box = (hx: number, hz: number, y: number) => {
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pos.push(sx * hx, y, sz * hz);
  };
  box(4, 3, 0);
  box(4, 3, 3);
  box(4.6, 3.6, 5);
  it('壁の高さ帯だけなら 8 × 6 の 4 隅（屋根の頂点は含めない）', () => {
    const out = sliceOutline(pos, { yMin: -0.1, yMax: 3.5 });
    expect(out).toHaveLength(4);
    expect(polygonArea(out)).toBeCloseTo(48, 9);
    expect(Math.max(...out.map((p) => Math.abs(p.e)))).toBeCloseTo(4, 9);
    expect(Math.max(...out.map((p) => Math.abs(p.n)))).toBeCloseTo(3, 9);
  });
  it('屋根の高さ帯なら大きい外形、既定の toEN は n = −z', () => {
    const out = sliceOutline(new Float32Array(pos), { yMin: 4, yMax: 6 });
    expect(out).toHaveLength(4);
    expect(polygonArea(out)).toBeCloseTo(9.2 * 7.2, 4);
    const custom = sliceOutline(pos, { yMin: 4, yMax: 6, toEN: (x, _y, z) => ({ e: z, n: x }) });
    expect(Math.max(...custom.map((p) => Math.abs(p.e)))).toBeCloseTo(3.6, 4);
    // 既定: z = +3.6 の頂点は n = −3.6
    expect(out.some((p) => Math.abs(p.n + 3.6) < 1e-4 && Math.abs(p.e - 4.6) < 1e-4)).toBe(true);
  });
  it('該当する頂点が 3 つ未満、または一直線上なら []', () => {
    expect(sliceOutline(pos, { yMin: 1, yMax: 2 })).toEqual([]);
    expect(sliceOutline([0, 0, 0, 1, 0, 1], { yMin: -1, yMax: 1 })).toEqual([]);
    expect(sliceOutline([0, 0, 0, 1, 0, 1, 2, 0, 2], { yMin: -1, yMax: 1 })).toEqual([]);
  });
});

describe('densifyBudget / 単位違いの ICP', () => {
  const rect = (w: number, d: number) => [{ e: 0, n: 0 }, { e: w, n: 0 }, { e: w, n: d }, { e: 0, n: d }];
  it('点数が上限を超えない', () => {
    expect(densifyBudget(rect(9.1, 7.28), 0.001).length).toBeLessThanOrEqual(MAX_ICP_POINTS);
    expect(densifyBudget(rect(9100, 7280), 0.01).length).toBeLessThanOrEqual(MAX_ICP_POINTS);
    // 間隔が十分広ければ densify と同じ
    expect(densifyBudget(rect(9.1, 7.28), 1)).toEqual(densify(rect(9.1, 7.28), 1));
  });
  it('src が mm のまま（1000 倍）でも固まらずに終わり、倍率なしでも例外にならない', () => {
    const t0 = Date.now();
    const fit = fitPolygonToPolygon(rect(9100, 7280), rect(9.1, 7.28), { allowScale: false });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(Number.isFinite(fit.rmsM)).toBe(true);
    const fit2 = fitPolygonToPolygon(rect(9100, 7280), rect(9.1, 7.28), { allowScale: true });
    expect(fit2.scale).toBeCloseTo(0.001, 6);
    expect(fit2.rmsM).toBeLessThan(0.01);
  });
});
