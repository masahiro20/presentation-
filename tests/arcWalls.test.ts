// R 壁（円弧の壁）: 重なり合う短い壁の集まりを、円の上の端と端がつながる弦に並べ直す（core/arcWalls.ts）
import { describe, expect, it } from 'vitest';
import { findArcClusters, fitCircle, isArcChord, sameArc, smoothArcWalls, withSmoothArcWalls } from '../src/core/arcWalls';
import { buildBuilding } from '../src/scene/building';
import { EXTERIOR_STYLES } from '../src/styles/presets';
import type { BuildingModel, Floor, Opening, Wall } from '../src/core/types';

const wall = (id: string, ax: number, ay: number, bx: number, by: number, o: Partial<Wall> = {}): Wall => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 130, exterior: false, joinedA: true, joinedB: true, ...o });

/**
 * 図面の読み取りが出す形: 円（中心 cx, cy・半径 r）の a0〜a1（度）に沿って、長さ len の弦が step 度ずつずれて重なりながら並ぶ。
 * jitter は弦の端の円からのずれ（mm。読み取りのゆらぎ）
 */
function chords(cx: number, cy: number, r: number, a0: number, a1: number, step: number, len: number, o: Partial<Wall> = {}, jitter = 0): Wall[] {
  const out: Wall[] = [];
  const half = (len / 2 / r) * (180 / Math.PI);
  let k = 0;
  for (let a = a0 + half; a <= a1 - half + 1e-6; a += step, k++) {
    const j = jitter ? ((k * 37) % 7) / 7 - 0.5 : 0;
    const P = (deg: number) => ({ x: cx + (r + j * jitter * 2) * Math.cos((deg * Math.PI) / 180), y: cy + (r + j * jitter * 2) * Math.sin((deg * Math.PI) / 180) });
    const p = P(a - half);
    const q = P(a + half);
    out.push(wall(`W${o.id ?? ''}${k}`, p.x, p.y, q.x, q.y, { ...o, id: `W${o.id ?? ''}${k}` }));
  }
  return out;
}

describe('円の当てはめ', () => {
  it('円の上の点から、中心と半径が戻る', () => {
    const pts = [0, 20, 45, 70, 90].map((d) => ({ x: 5000 + 910 * Math.cos((d * Math.PI) / 180), y: 3000 + 910 * Math.sin((d * Math.PI) / 180) }));
    const c = fitCircle(pts)!;
    expect(c.cx).toBeCloseTo(5000, 3);
    expect(c.cy).toBeCloseTo(3000, 3);
    expect(c.r).toBeCloseTo(910, 3);
    // 一直線の点には当てはまらない
    expect(fitCircle([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }])).toBeNull();
  });
});

describe('R 壁を見つける', () => {
  it('向きを少しずつ変えながら重なって並ぶ短い壁は、1 つの円弧（半径 910 の 1/4 円）', () => {
    const ws = chords(5000, 3000, 910, 0, 90, 7, 350, {}, 6);
    const cl = findArcClusters(ws);
    expect(cl.length).toBe(1);
    // （弦の中点は矢高ぶん円の内側に入るので、当てはめた半径は 1〜2% 小さめに出る）
    expect(cl[0].r).toBeGreaterThan(885);
    expect(cl[0].r).toBeLessThan(925);
    expect(Math.round(((cl[0].a1 - cl[0].a0) * 180) / Math.PI)).toBeGreaterThanOrEqual(85);
    expect(cl[0].walls.length).toBe(ws.length);
  });

  it('まっすぐな壁・直交する壁・離れた短い壁・向きの変わる幅が小さい並びは、円弧にしない', () => {
    const straight = [wall('a', 0, 0, 3640, 0), wall('b', 3640, 0, 3640, 2730), wall('c', 0, 0, 0, 2730)];
    expect(findArcClusters(straight).length).toBe(0);
    // 壁の交点の柱型（長さ 106 の短い壁）が並んでいても円弧ではない
    const stubs = [0, 910, 1820, 2730].map((x, i) => wall(`s${i}`, x, -53, x, 53));
    expect(findArcClusters([...straight, ...stubs]).length).toBe(0);
    // 20° しか回らない並び（斜めの壁の読み取りのゆらぎ）
    expect(findArcClusters(chords(0, 0, 3000, 0, 20, 4, 300)).length).toBe(0);
  });

  it('円弧の端に付いた短い返し（円に沿わない壁）は外して、残りで当てはめる', () => {
    const ws = chords(5000, 3000, 910, 0, 90, 7, 350);
    // 端の弦に 25° の角度で触れる、円から外れていく短い壁
    const end = ws[ws.length - 1];
    const stray = wall('stray', end.b.x, end.b.y, end.b.x - 180, end.b.y + 130);
    const cl = findArcClusters([...ws, stray]);
    expect(cl.length).toBe(1);
    expect(cl[0].walls.some((w) => w.id === 'stray')).toBe(false);
    expect(Math.abs(cl[0].r - 910)).toBeLessThan(15);
  });

  it('窓・戸の付いた壁は弦にしない（その壁を除いた残りが 4 本に足りなければ、円弧にしない）', () => {
    const ws = chords(5000, 3000, 910, 0, 75, 14, 350);
    expect(ws.length).toBe(4);
    expect(findArcClusters(ws).length).toBe(1);
    const op = { wallId: ws[1].id } as Opening;
    expect(findArcClusters(ws, [op]).length).toBe(0);
  });
});

describe('弦に並べ直す', () => {
  const floorOf = (walls: Wall[]): Pick<Floor, 'walls' | 'openings'> => ({ walls, openings: [] });

  it('端と端がつながり、どの端も円の上。弦の角度は 5〜10°。前後のまっすぐな壁はそのまま', () => {
    const lead = wall('lead', 5910, 1000, 5910, 3000);
    const tail = wall('tail', 3000, 3910, 5000, 3910);
    const f = floorOf([lead, ...chords(5000, 3000, 910, 0, 90, 7, 350, {}, 6), tail]);
    expect(smoothArcWalls(f)).toBe(1);
    const arcs = f.walls.filter((w) => w.arc);
    expect(arcs.length).toBeGreaterThanOrEqual(9);
    expect(arcs.length).toBeLessThanOrEqual(18);
    for (let i = 0; i + 1 < arcs.length; i++) {
      expect(arcs[i].b.x).toBeCloseTo(arcs[i + 1].a.x, 6);
      expect(arcs[i].b.y).toBeCloseTo(arcs[i + 1].a.y, 6);
    }
    for (const w of arcs) {
      expect(isArcChord(w)).toBe(true);
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      expect(L).toBeGreaterThan(60);
      expect(L).toBeLessThan(200);
    }
    expect(sameArc(arcs[0], arcs[arcs.length - 1])).toBe(true);
    // 途中の継ぎ目はつながっている。両端は、まっすぐな壁につながっている
    expect(arcs.every((w) => w.joinedA && w.joinedB)).toBe(true);
    expect(f.walls.find((w) => w.id === 'lead')).toBe(lead);
    expect(f.walls.find((w) => w.id === 'tail')).toBe(tail);
    // もう一度呼んでも変わらない
    const snap = JSON.stringify(f.walls);
    expect(smoothArcWalls(f)).toBe(0);
    expect(JSON.stringify(f.walls)).toBe(snap);
  });

  it('どこにもつながらない円弧の端は、小口を閉じる（joined = false）', () => {
    const f = floorOf(chords(5000, 3000, 910, 0, 90, 7, 350));
    smoothArcWalls(f);
    const arcs = f.walls.filter((w) => w.arc);
    expect(arcs[0].joinedA).toBe(false);
    expect(arcs[arcs.length - 1].joinedB).toBe(false);
    expect(arcs.slice(1).every((w) => w.joinedA)).toBe(true);
  });

  it('腰壁の天端（1,100）・外壁の外側の向き・壁厚を引き継ぐ', () => {
    // 外壁: 外側は円の外（凸の側）
    const ext = chords(5000, 3000, 910, 0, 90, 7, 350, { exterior: true, thickness: 160 }).map((w) => {
      // a→b の左（+1）が円の外かどうかは弦の向きで決まる。ここでは外側が円の外になるように付ける
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      const nx = -(w.b.y - w.a.y) / L;
      const ny = (w.b.x - w.a.x) / L;
      const out = nx * ((w.a.x + w.b.x) / 2 - 5000) + ny * ((w.a.y + w.b.y) / 2 - 3000) > 0;
      return { ...w, outsideSign: (out ? 1 : -1) as 1 | -1 };
    });
    const f = floorOf(ext);
    smoothArcWalls(f);
    for (const w of f.walls) {
      expect(w.exterior).toBe(true);
      expect(w.thickness).toBe(160);
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      const nx = (-(w.b.y - w.a.y) / L) * w.outsideSign!;
      const ny = ((w.b.x - w.a.x) / L) * w.outsideSign!;
      // 外側の法線は、円の中心から離れる向き
      expect(nx * ((w.a.x + w.b.x) / 2 - 5000) + ny * ((w.a.y + w.b.y) / 2 - 3000)).toBeGreaterThan(0);
    }
    const guard = floorOf(chords(5000, 3000, 910, 0, 90, 7, 350, { topMm: 1100 }));
    smoothArcWalls(guard);
    expect(guard.walls.every((w) => w.topMm === 1100)).toBe(true);
  });

  it('書き換えない版: R 壁が無ければ同じ物を返し、あれば写しを並べ直す', () => {
    const plain = floorOf([wall('a', 0, 0, 3640, 0)]);
    expect(withSmoothArcWalls(plain)).toBe(plain);
    const src = floorOf(chords(5000, 3000, 910, 0, 90, 7, 350));
    const n0 = src.walls.length;
    const out = withSmoothArcWalls(src);
    expect(out).not.toBe(src);
    expect(src.walls.length).toBe(n0);
    expect(src.walls.every((w) => !w.arc)).toBe(true);
    expect(out.walls.every((w) => isArcChord(w))).toBe(true);
  });

  it('弦を動かして円から外れたら、ふつうの壁として扱う', () => {
    const f = floorOf(chords(5000, 3000, 910, 0, 90, 7, 350));
    smoothArcWalls(f);
    const w = { ...f.walls[2], b: { x: f.walls[2].b.x + 40, y: f.walls[2].b.y } };
    expect(isArcChord(w)).toBe(false);
    expect(sameArc(w, f.walls[3])).toBe(false);
  });
});

describe('3D: R 壁はなめらかな曲面', () => {
  const house = (walls: Wall[]): BuildingModel => {
    const outline = [{ x: 0, y: 0 }, { x: 7280, y: 0 }, { x: 7280, y: 5460 }, { x: 0, y: 5460 }];
    const ext = outline.map((p, i) => wall(`E${i}`, p.x, p.y, outline[(i + 1) % 4].x, outline[(i + 1) % 4].y, { exterior: true, thickness: 160, outsideSign: -1 }));
    const f: Floor = {
      level: 1,
      elevation: 500,
      height: 2900,
      ceilingHeight: 2400,
      walls: [...ext, ...walls],
      openings: [],
      rooms: [{ id: 'R1', name: 'ＬＤＫ', type: 'ldk', polygon: outline, area: 39.7, labelPos: { x: 3640, y: 2730 } }],
      stairs: [],
      outline: [outline],
    } as unknown as Floor;
    return { name: 't', floors: [f], northAngleDeg: 0 } as unknown as BuildingModel;
  };
  const normalsOf = (model: BuildingModel) => {
    const { mb } = buildBuilding(model, { exterior: EXTERIOR_STYLES[0] });
    const g = mb.build(() => ({}) as never);
    const out: { p: [number, number, number]; n: [number, number, number] }[] = [];
    g.traverse((o) => {
      const geo = (o as { geometry?: { getAttribute(n: string): { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } } }).geometry;
      if (!geo) return;
      const pos = geo.getAttribute('position');
      const nor = geo.getAttribute('normal');
      for (let i = 0; i < pos.count; i++) out.push({ p: [pos.getX(i), pos.getY(i), pos.getZ(i)], n: [nor.getX(i), nor.getY(i), nor.getZ(i)] });
    });
    return out;
  };

  it('弦の面の法線は、円の半径の向き（弦ごとの平らな面にならない）。継ぎ目の丸柱も立てない', () => {
    const model = house(chords(3640, 2730, 910, 0, 90, 7, 350));
    // 当てはめた円（3D はこの円の上に弦を並べ直して作る）
    const { cx, cy, r } = findArcClusters(model.floors[0].walls)[0];
    const vs = normalsOf(model);
    // 壁の外側の面（半径 910 + 65）の、壁の中ほどの高さの頂点
    const outer = vs.filter((v) => Math.abs(Math.hypot(v.p[0] - cx / 1000, v.p[2] - cy / 1000) - (r + 65) / 1000) < 0.002 && Math.abs(v.n[1]) < 0.01 && v.p[1] > 0.6);
    expect(outer.length).toBeGreaterThan(20);
    for (const v of outer) {
      const rx = v.p[0] - cx / 1000;
      const rz = v.p[2] - cy / 1000;
      const rl = Math.hypot(rx, rz);
      // 小口（円弧の端の面）を除けば、法線は半径の向きにそろう
      const dot = (v.n[0] * rx + v.n[2] * rz) / rl;
      if (Math.abs(dot) > 0.5) expect(dot).toBeGreaterThan(0.999);
    }
    // 前に保存した図面（弦に並べ直す前）でも、3D は同じ曲面になる
    expect(model.floors[0].walls.some((w) => w.arc)).toBe(false);
  });
});
