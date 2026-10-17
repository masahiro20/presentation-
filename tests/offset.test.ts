/**
 * 5m/10m ライン（src/sun/offset.ts）: 多角形から水平距離 d の線 {p : dist(p, 多角形) = d}。
 * 凸の角は半径 d の円弧（≤ 3° 刻み）、凹の角・狭い切り込みは交点でつなぐ。
 */
import { describe, expect, it } from 'vitest';
import { distanceToPolygon, isSimplePolygon, offsetPolygon, offsetRegion, pointInRegion, rectPolygon, signedArea, type Pt2 } from '../src/sun/offset';

const SHAPES: Record<string, Pt2[]> = {
  正方形: rectPolygon(0, 0, 20, 20),
  L字: [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 8 },
    { x: 8, y: 8 },
    { x: 8, y: 20 },
    { x: 0, y: 20 },
  ],
  // 旗竿地: 幅 3m・長さ 15m の竿（通路）の先に 18m × 15m の旗（宅地）
  旗竿地: [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 3, y: 15 },
    { x: 12, y: 15 },
    { x: 12, y: 30 },
    { x: -6, y: 30 },
    { x: -6, y: 15 },
    { x: 0, y: 15 },
  ],
  三角形: [
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 5, y: 12 },
  ],
  // 幅 4m（< 2d）・深さ 12m の切り込み
  切り込み: [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 12, y: 20 },
    { x: 12, y: 8 },
    { x: 8, y: 8 },
    { x: 8, y: 20 },
    { x: 0, y: 20 },
  ],
  // 口の幅 4m のコの字（中庭の奥は 5m ラインの外 → 穴になる）
  コの字: [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 18 },
    { x: 34, y: 18 },
    { x: 34, y: 6 },
    { x: 6, y: 6 },
    { x: 6, y: 34 },
    { x: 34, y: 34 },
    { x: 34, y: 22 },
    { x: 40, y: 22 },
    { x: 40, y: 40 },
    { x: 0, y: 40 },
  ],
};

/** 外周・穴のすべての頂点が距離 d ± 1cm、密な標本で d − 1cm 以内は内側・d + 1cm 以上は外側 */
function check(poly: Pt2[], d: number) {
  const loops = offsetRegion(poly, d);
  expect(loops.length).toBeGreaterThan(0);
  for (const l of loops) {
    expect(l.length).toBeGreaterThanOrEqual(3);
    expect(isSimplePolygon(l)).toBe(true);
    for (const v of l) expect(Math.abs(distanceToPolygon(v, poly) - d)).toBeLessThan(0.01);
  }
  expect(signedArea(loops[0])).toBeGreaterThan(0);
  for (const h of loops.slice(1)) expect(signedArea(h)).toBeLessThan(0);
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const step = 0.37;
  let inner = 0;
  let outer = 0;
  for (let x = Math.min(...xs) - d - 2; x <= Math.max(...xs) + d + 2; x += step)
    for (let y = Math.min(...ys) - d - 2; y <= Math.max(...ys) + d + 2; y += step) {
      const q = { x, y };
      const dq = distanceToPolygon(q, poly);
      if (dq <= d - 0.01) {
        inner++;
        expect(pointInRegion(q, loops), `(${x.toFixed(2)}, ${y.toFixed(2)}) 距離 ${dq.toFixed(3)} は内側`).toBe(true);
      } else if (dq >= d + 0.01) {
        outer++;
        expect(pointInRegion(q, loops), `(${x.toFixed(2)}, ${y.toFixed(2)}) 距離 ${dq.toFixed(3)} は外側`).toBe(false);
      }
    }
  expect(inner).toBeGreaterThan(100);
  expect(outer).toBeGreaterThan(100);
  return loops;
}

describe('5m/10m ライン（水平距離 d の線）', () => {
  for (const [name, poly] of Object.entries(SHAPES))
    for (const d of [5, 10]) {
      it(`${name}・d=${d}m: 頂点は距離 d ± 1cm、d − 1cm 以内は内側・d + 1cm 以上は外側`, () => {
        check(poly, d);
        // 時計回りの入力でも同じ線（向きは入力に合わせる）
        const cw = poly.slice().reverse();
        const out = offsetPolygon(cw, d);
        expect(signedArea(out)).toBeLessThan(0);
        for (const v of out) expect(Math.abs(distanceToPolygon(v, poly) - d)).toBeLessThan(0.01);
      });
    }

  it('凸の角は半径 d の円弧（頂点は角から距離 d、刻み ≤ 3°、法線の範囲 90° をすべて覆う）', () => {
    const d = 5;
    const out = offsetPolygon(rectPolygon(0, 0, 10, 6), d);
    for (const corner of rectPolygon(0, 0, 10, 6)) {
      const arc = out.filter((v) => Math.abs(Math.hypot(v.x - corner.x, v.y - corner.y) - d) < 1e-6);
      // 角の外向きの二等分線からの角度（−45°〜45° の範囲に並ぶ）
      const bx = Math.sign(corner.x - 5);
      const by = Math.sign(corner.y - 3);
      const angs = arc.map((v) => (Math.atan2(bx * (v.y - corner.y) - by * (v.x - corner.x), bx * (v.x - corner.x) + by * (v.y - corner.y)) * 180) / Math.PI).sort((x, y) => x - y);
      expect(angs[0]).toBeCloseTo(-45, 6);
      expect(angs[angs.length - 1]).toBeCloseTo(45, 6);
      for (let i = 1; i < angs.length; i++) expect(angs[i] - angs[i - 1]).toBeLessThanOrEqual(3 + 1e-9);
      expect(arc.length).toBeGreaterThanOrEqual(31);
    }
    // 辺は d 平行移動した線: 範囲は各辺を 5m 広げた矩形と同じ
    const xs = out.map((p) => p.x);
    const ys = out.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(-5, 9);
    expect(Math.max(...xs)).toBeCloseTo(15, 9);
    expect(Math.min(...ys)).toBeCloseTo(-5, 9);
    expect(Math.max(...ys)).toBeCloseTo(11, 9);
    // 角を斜めに切る（留め継ぎの）点 (−5, −5) は線の外（角から 5√2 m）
    expect(pointInRegion({ x: -4.5, y: -4.5 }, [out])).toBe(false);
  });

  it('三角形の鋭角: 円弧は 180° − 内角 の範囲、留め継ぎより内側（危険側にならない）', () => {
    const tri = SHAPES['三角形'];
    const out = offsetPolygon(tri, 5);
    const corner = tri[1]; // (30, 0) の鋭角
    const arc = out.filter((v) => Math.abs(Math.hypot(v.x - corner.x, v.y - corner.y) - 5) < 1e-6);
    expect(arc.length).toBeGreaterThan(40);
    // 留め継ぎなら角から遠く（> 20m）まで尖るが、円弧なら角から 5m 以内
    const far = Math.max(...out.map((v) => Math.hypot(v.x - corner.x, v.y - corner.y)));
    expect(far).toBeLessThan(40);
    for (const v of out) expect(Math.abs(distanceToPolygon(v, tri) - 5)).toBeLessThan(1e-6);
  });

  it('L字の凹の角: 2 辺のオフセットの交点（角から 5√2 m）で直角に曲がる', () => {
    const out = offsetPolygon(SHAPES['L字'], 5);
    const notch = out.find((v) => Math.abs(v.x - 13) < 1e-6 && Math.abs(v.y - 13) < 1e-6);
    expect(notch).toBeDefined();
  });

  it('幅 4m の切り込み（< 2d）: 両側の円弧がぶつかる点でつながり、切り込みの奥は線の内側', () => {
    const out = offsetPolygon(SHAPES['切り込み'], 5);
    // 切り込みの口の上: 両側の角 (8,20)・(12,20) から 5m の円の交点 (10, 20 + √21)
    const meet = out.filter((v) => Math.abs(v.x - 10) < 0.3);
    expect(meet.length).toBeGreaterThan(0);
    const top = Math.min(...meet.map((v) => Math.abs(v.y - (20 + Math.sqrt(21)))));
    expect(top).toBeLessThan(0.01);
    expect(pointInRegion({ x: 10, y: 12 }, [out])).toBe(true);
    // 線は 1 本の外周だけ（切り込みの中に別の輪郭はできない）
    expect(offsetRegion(SHAPES['切り込み'], 5)).toHaveLength(1);
  });

  it('コの字（口 4m）: 口はふさがり、中庭の奥は穴（5m ラインの外）', () => {
    const loops = offsetRegion(SHAPES['コの字'], 5);
    expect(loops).toHaveLength(2);
    expect(pointInRegion({ x: 20, y: 20 }, loops)).toBe(false); // 中庭の中央は壁から 14m
    expect(pointInRegion({ x: 37, y: 20 }, loops)).toBe(true); // 口
    // 10m でも中庭の中央（壁から 14m）は穴、15m なら埋まる
    expect(offsetRegion(SHAPES['コの字'], 10)).toHaveLength(2);
    expect(offsetRegion(SHAPES['コの字'], 15)).toHaveLength(1);
  });

  it('自己交差する多角形・点・線分でも壊れない（距離 d の線）', () => {
    const bow = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    const loops = offsetRegion(bow, 5);
    expect(loops.length).toBeGreaterThan(0);
    for (const v of loops[0]) expect(Math.abs(distanceToPolygon(v, bow) - 5)).toBeLessThan(0.01);
    const seg = offsetPolygon(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      5,
    );
    for (const v of seg) expect(Math.abs(distanceToPolygon(v, [{ x: 0, y: 0 }, { x: 10, y: 0 }]) - 5)).toBeLessThan(1e-6);
    const circle = offsetPolygon([{ x: 3, y: 4 }], 2);
    expect(circle.length).toBe(120);
    for (const v of circle) expect(Math.hypot(v.x - 3, v.y - 4)).toBeCloseTo(2, 9);
  });
});

describe('測量図のような、ほぼ一直線に並ぶ頂点（独立検証で見つかった欠陥の回帰テスト）', () => {
  /** 輪郭上の点の、多角形からの距離の最大の超過（外へのずれ）と、頂点の距離の誤差 */
  const errors = (poly: Pt2[], d: number) => {
    let outward = 0;
    let vertex = 0;
    for (const loop of offsetRegion(poly, d))
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        vertex = Math.max(vertex, Math.abs(distanceToPolygon(a, poly) - d));
        for (const t of [0.25, 0.5, 0.75]) outward = Math.max(outward, distanceToPolygon({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, poly) - d);
      }
    return { outward, vertex };
  };
  it('ほぼ一直線の凹み（0.001 m の折れ）でも、10m ラインが外へ 1 cm 以上ずれない', () => {
    const poly: Pt2[] = [
      { x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: -20 }, { x: 9, y: -20 }, { x: 9, y: 0 },
      { x: 18, y: 0 }, { x: 18, y: 15 }, { x: 9, y: 14.999 }, { x: 0, y: 15 },
    ];
    const e = errors(poly, 10);
    expect(e.outward).toBeLessThan(0.01);
    expect(e.vertex).toBeLessThan(0.001);
  });
  it('辺の途中に数 mm〜数 cm ずれた点が並ぶ矩形（測量の点列）でも、5m/10m ラインが外へ 1 cm 以上ずれない', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const amp of [1e-5, 1e-3, 0.02]) {
      for (let k = 0; k < 10; k++) {
        const base: Pt2[] = [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 25, y: 17.5 }, { x: 0, y: 17.5 }];
        const pts: Pt2[] = [];
        for (let i = 0; i < 4; i++) {
          const a = base[i];
          const b = base[(i + 1) % 4];
          pts.push(a);
          const L = Math.hypot(b.x - a.x, b.y - a.y);
          for (const t of [0.3 + 0.2 * rnd(), 0.6 + 0.2 * rnd()]) {
            const j = (rnd() * 2 - 1) * amp;
            pts.push({ x: a.x + (b.x - a.x) * t - ((b.y - a.y) / L) * j, y: a.y + (b.y - a.y) * t + ((b.x - a.x) / L) * j });
          }
        }
        for (const d of [5, 10]) expect(errors(pts, d).outward).toBeLessThan(0.01);
      }
    }
  });
  it('切り込みの両側にある同じ直線上の 2 辺を、交差と誤判定しない', () => {
    for (let k = 0; k < 360; k += 7) {
      const th = (k * Math.PI) / 180;
      const base: Pt2[] = [{ x: 0, y: 0 }, { x: 7.3, y: 0 }, { x: 7.3, y: -6.1 }, { x: 10.9, y: -6.1 }, { x: 10.9, y: 0 }, { x: 31.7, y: 0 }, { x: 31.7, y: 22.3 }, { x: 0, y: 22.3 }];
      const poly = base.map((p) => ({ x: p.x * Math.cos(th) - p.y * Math.sin(th), y: p.x * Math.sin(th) + p.y * Math.cos(th) }));
      expect(isSimplePolygon(poly)).toBe(true);
    }
  });
});
