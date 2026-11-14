// 図面の描き方を読む（窓の記号・造作の塗り・壁掛けテレビ・先の列が伸びる折り返し階段・斜めの壁を突き抜けた壁の端）
//  御社のご提案（大崎様邸の平面図 ↔ 内観の静止画）を突き合わせて分かった「こう描いてあれば、こう作る」の決まり
import { describe, expect, it } from 'vitest';
import { readSashMark, type MarkSeg } from '../src/parser/windowMarks';
import { isWoodFillColor, joineryRectOf, readJoineryFills } from '../src/parser/joineryFills';
import { findThinRects, readWallTvs, type TvSeg } from '../src/parser/wallTv';
import { trimEndsThroughDiagonals, windowsBySashMarks } from '../src/parser/assemble';
import { stairFootprint, stairLayout } from '../src/core/stairs';
import { isSlidingWindow } from '../src/core/openings';
import type { Floor, FurnitureItem, Opening, Room, Stair, Vec2, Wall } from '../src/core/types';

const seg = (ax: number, ay: number, bx: number, by: number, o: Partial<MarkSeg> = {}): MarkSeg => ({ a: { x: ax, y: ay }, b: { x: bx, y: by }, ...o });
const room = (id: string, type: Room['type'], x0: number, y0: number, x1: number, y1: number, name = id): Room =>
  ({ id, name, type, polygon: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], area: ((x1 - x0) * (y1 - y0)) / 1e6, labelPos: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } }) as Room;
const wall = (id: string, ax: number, ay: number, bx: number, by: number, o: Partial<Wall> = {}): Wall => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 160, exterior: false, ...o }) as Wall;

describe('窓の記号（すべり出し・FIX・引違い）', () => {
  // 壁は y = 0 の横の線（厚み 160）。開口は x = 1000〜2690。法線は +y
  const a = { x: 0, y: 0 };
  const u = { x: 1, y: 0 };
  const n = { x: 0, y: 1 };
  const read = (segs: MarkSeg[]) => readSashMark(segs, a, u, n, 1000, 2690, 160);

  it('両端から外へ伸びる 2 本の斜めの線が 1 点で交わる三角 = すべり出し', () => {
    const r = read([seg(1000, 80, 1845, 600), seg(2690, 80, 1845, 600), seg(1000, 0, 2690, 0)]);
    expect(r?.mark).toBe('awning');
    expect(r?.side).toBe(1);
    // 反対側（−y）に出る三角
    expect(read([seg(1000, -80, 1845, -600), seg(2690, -80, 1845, -600)])?.side).toBe(-1);
  });

  it('三角が片方だけ・頂点が合わない線は、すべり出しにしない', () => {
    expect(read([seg(1000, 80, 1845, 600)])).toBeNull();
    expect(read([seg(1000, 80, 1500, 600), seg(2690, 80, 2200, 600)])).toBeNull();
  });

  it('ガラスの線が端から端まで通る = FIX、中ほどで切れて位置の違う線が重なる = 引違い', () => {
    expect(read([seg(1000, 0, 2690, 0)])?.mark).toBe('fix');
    expect(read([seg(1000, -20, 1900, -20), seg(1790, 20, 2690, 20)])?.mark).toBe('slide');
    // 破線・塗りの輪郭は記号の線に数えない
    expect(read([seg(1000, 0, 2690, 0, { dashed: true })])).toBeNull();
    expect(read([seg(1000, 0, 2690, 0, { source: 'fill' })])).toBeNull();
  });

  it('FIX・すべり出しの窓は引違いにしない', () => {
    const op = (sash?: Opening['sash']): Opening => ({ id: 'o', wallId: 'w', kind: 'window', t0: 0, t1: 1690, sill: 0, height: 2000, windowStyle: 'hakidashi', ...(sash ? { sash } : {}) }) as Opening;
    expect(isSlidingWindow(op('fix'))).toBe(false);
    expect(isSlidingWindow(op('awning'))).toBe(false);
  });
});

describe('窓の高さを、家全体の記号から決め直す', () => {
  // LDK（0〜6000 × 0〜4000）と、床を 400 上げた畳コーナー（6000〜8000）。南の外壁（y = 4000）に窓を並べる
  const mk = (ops: Partial<Opening>[]): Floor => {
    const south = wall('S', 0, 4000, 8000, 4000, { exterior: true, outsideSign: 1 });
    const inner = wall('I', 6000, 0, 6000, 4000);
    const openings = ops.map((o, i) => ({ id: `o${i}`, wallId: 'S', kind: 'window', sill: 0, height: 2200, windowStyle: 'hakidashi', ...o }) as Opening);
    const tatami = { ...room('tatami', 'japanese', 6000, 0, 8000, 4000), floorOffset: 400 } as Room;
    return { level: 1, elevation: 0, height: 2900, ceilingHeight: 2400, walls: [south, inner], openings, rooms: [room('ldk', 'ldk', 0, 0, 6000, 4000), tatami], stairs: [], outline: [] } as unknown as Floor;
  };

  it('すべり出しが 2 つ以上ある家: すべり出しは高窓（幅 1.4m 以上）・腰窓、小上がりの大きな窓は畳の高さから', () => {
    const f = mk([
      { t0: 200, t1: 1890, sash: 'awning' },
      { t0: 2200, t1: 3000, sash: 'awning' },
      { t0: 6300, t1: 7900, sash: 'fix' },
    ]);
    windowsBySashMarks([f]);
    expect(f.openings[0]).toMatchObject({ windowStyle: 'high', sill: 1300, height: 700 });
    expect(f.openings[1]).toMatchObject({ windowStyle: 'koshi', sill: 900, height: 1100 });
    expect(f.openings[2]).toMatchObject({ windowStyle: 'hakidashi', sill: 400, height: 1800 });
  });

  it('すべり出しが 1 つだけの家・立面図で高さが分かった窓は変えない', () => {
    const one = mk([{ t0: 200, t1: 1890, sash: 'awning' }]);
    windowsBySashMarks([one]);
    expect(one.openings[0]).toMatchObject({ windowStyle: 'hakidashi', sill: 0, height: 2200 });
    const elev = mk([
      { t0: 200, t1: 1890, sash: 'awning', heightFrom: 'elevation' } as Partial<Opening>,
      { t0: 2200, t1: 3000, sash: 'awning' },
      { t0: 3300, t1: 4100, sash: 'awning' },
    ]);
    windowsBySashMarks([elev]);
    expect(elev.openings[0]).toMatchObject({ windowStyle: 'hakidashi', sill: 0, height: 2200 });
    expect(elev.openings[1].windowStyle).toBe('koshi');
  });

  it('小上がりに面した大きな室内窓は、畳の高さから 2,100 まで', () => {
    const f = mk([]);
    f.openings.push({ id: 'iw', wallId: 'I', kind: 'window', interior: true, t0: 1000, t1: 2800, sill: 900, height: 900 } as Opening);
    windowsBySashMarks([f]);
    expect(f.openings[0]).toMatchObject({ sill: 400, height: 1700 });
  });
});

describe('造作の塗り（木の色の四角 → 造作カウンター・可動棚）', () => {
  it('木の色: 茶〜ベージュは木、灰色・白・壁の色は木ではない', () => {
    expect(isWoodFillColor('#c5a885')).toBe(true);
    expect(isWoodFillColor('#eedbbb')).toBe(true);
    expect(isWoodFillColor('#808080')).toBe(false);
    expect(isWoodFillColor('#c0c0c0')).toBe(false);
    expect(isWoodFillColor('#ffffff')).toBe(false);
    expect(isWoodFillColor('#88aacc')).toBe(false);
  });

  it('四角だけを取り出す（L 字・三角は外す）', () => {
    expect(joineryRectOf([{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 600 }, { x: 0, y: 600 }])).toEqual({ minX: 0, minY: 0, maxX: 2000, maxY: 600 });
    expect(joineryRectOf([{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 600 }, { x: 600, y: 600 }, { x: 600, y: 2000 }, { x: 0, y: 2000 }])).toBeNull();
    expect(joineryRectOf([{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 0, y: 600 }])).toBeNull();
  });

  it('書斎の壁沿いの帯は造作カウンター（前の椅子が席）。同じ場所の既製の机は置き換える', () => {
    const rooms = [room('study', 'study', 0, 0, 2200, 2700)];
    const chair: FurnitureItem = { id: 'c1', kind: 'chair', x: 1100, y: 1200, rot: 0, roomId: 'study' };
    const desk: FurnitureItem = { id: 'd1', kind: 'desk', x: 1100, y: 300, rot: 0, roomId: 'study' };
    const r = readJoineryFills([{ minX: 0, minY: 0, maxX: 2200, maxY: 700 }], rooms, [], [chair, desk], [], 1);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: 'builtin', variant: 'counter', seats: 1, w: 2.2, d: 0.7, roomId: 'study' });
    // 背は壁の側（y = 0）
    expect(r.items[0].y).toBe(0);
    expect(r.consumed).toEqual(['c1']);
    expect(r.replaced).toEqual(['d1']);
  });

  it('収納・洗面の帯は可動棚。階段の中の塗り・部屋いっぱいの塗り・細い帯は読まない', () => {
    const rooms = [room('st', 'storage', 0, 0, 1800, 1800), room('ldk', 'ldk', 2000, 0, 8000, 6000)];
    const stairs = [{ minX: 3000, minY: 1000, maxX: 4820, maxY: 2820 }];
    const r = readJoineryFills(
      [
        { minX: 0, minY: 0, maxX: 400, maxY: 1260 }, // 収納の棚
        { minX: 3100, minY: 1100, maxX: 3900, maxY: 1700 }, // 階段の踊り場の塗り
        { minX: 0, minY: 0, maxX: 1800, maxY: 1800 }, // 部屋いっぱい（床の色分け）
        { minX: 5000, minY: 3000, maxX: 5100, maxY: 5000 }, // 幅 100 の帯（框・笠木）
      ],
      rooms,
      stairs,
      [],
      [],
      2,
    );
    expect(r.items.map((i) => [i.id, i.variant, i.roomId])).toEqual([['pj2_1', 'shelves', 'st']]);
  });
});

describe('壁掛けテレビ（壁に平行な細長い四角）', () => {
  /** 中心 c・長手の向き（度）・長さ L・厚み S の四角の 4 辺 */
  const rectSegs = (cx: number, cy: number, deg: number, L: number, S: number): TvSeg[] => {
    const r = (deg * Math.PI) / 180;
    const ux = Math.cos(r);
    const uy = Math.sin(r);
    const p = (du: number, dv: number): Vec2 => ({ x: cx + ux * du - uy * dv, y: cy + uy * du + ux * dv });
    const c = [p(-L / 2, -S / 2), p(L / 2, -S / 2), p(L / 2, S / 2), p(-L / 2, S / 2)];
    return c.map((q, i) => ({ a: q, b: c[(i + 1) % 4] }));
  };

  it('縦・横・斜めの細長い四角を拾う。厚い四角（台・壁）は拾わない', () => {
    expect(findThinRects(rectSegs(1000, 1000, 0, 1500, 60))).toHaveLength(1);
    const d = findThinRects(rectSegs(1000, 1000, 68, 1580, 58));
    expect(d).toHaveLength(1);
    expect(d[0].L).toBeCloseTo(1580, 0);
    expect(d[0].S).toBeCloseTo(58, 0);
    expect(findThinRects(rectSegs(1000, 1000, 0, 1500, 106))).toHaveLength(0);
    expect(findThinRects(rectSegs(1000, 1000, 0, 800, 40))).toHaveLength(0);
  });

  it('角の丸い四角（短辺が細かい線の連なり）も拾う', () => {
    const segs: TvSeg[] = [
      { a: { x: 10, y: 0 }, b: { x: 1570, y: 0 } },
      { a: { x: 10, y: 58 }, b: { x: 1570, y: 58 } },
      // 左の丸い角
      { a: { x: 10, y: 0 }, b: { x: 3, y: 8 } },
      { a: { x: 3, y: 8 }, b: { x: 0, y: 29 } },
      { a: { x: 0, y: 29 }, b: { x: 3, y: 50 } },
      { a: { x: 3, y: 50 }, b: { x: 10, y: 58 } },
      // 右の丸い角
      { a: { x: 1570, y: 0 }, b: { x: 1577, y: 8 } },
      { a: { x: 1577, y: 8 }, b: { x: 1580, y: 29 } },
      { a: { x: 1580, y: 29 }, b: { x: 1577, y: 50 } },
      { a: { x: 1577, y: 50 }, b: { x: 1570, y: 58 } },
    ];
    expect(findThinRects(segs)).toHaveLength(1);
  });

  it('居間の斜めの壁の脇の四角 → 壁掛けテレビ（背は壁の面・向きは壁から部屋へ）', () => {
    // 斜めの壁（厚み 160）: (4000, 0) → (3000, 2500)。部屋は壁の西側
    const w = wall('W1', 4000, 0, 3000, 2500, { exterior: true });
    const L = Math.hypot(1000, 2500);
    const nx = -2500 / L;
    const ny = -1000 / L;
    // 壁の芯から 170 西へ離した四角（壁の面から 60）
    const cx = 3500 + nx * 170;
    const cy = 1250 + ny * 170;
    const deg = (Math.atan2(2500, -1000) * 180) / Math.PI;
    const ldk = { ...room('ldk', 'ldk', -2000, 0, 4000, 2500), polygon: [{ x: -2000, y: 0 }, { x: 4000, y: 0 }, { x: 3000, y: 2500 }, { x: -2000, y: 2500 }] } as Room;
    // ソファはテレビの正面（西へ 3.5m）
    const sofa: FurnitureItem = { id: 's', kind: 'sofa', x: cx + nx * 3500, y: cy + ny * 3500, rot: 270, roomId: 'ldk' };
    const r = readWallTvs(rectSegs(cx, cy, deg, 1580, 58), [w], [], [ldk], [sofa], 1);
    expect(r.items).toHaveLength(1);
    // ソファ・ベッドが正面に無ければ読まない（手すり・見切りの線かもしれない）
    expect(readWallTvs(rectSegs(cx, cy, deg, 1580, 58), [w], [], [ldk], [], 1).items).toHaveLength(0);
    expect(readWallTvs(rectSegs(cx, cy, deg, 1580, 58), [w], [], [ldk], [{ ...sofa, x: cx - nx * 3500, y: cy - ny * 3500 }], 1).items).toHaveLength(0);
    const tv = r.items[0];
    expect(tv).toMatchObject({ id: 'ptv1_1', kind: 'tv', mount: 'wall', roomId: 'ldk', w: 1.58 });
    // 背は壁の面の上（芯から 80）
    const off = (tv.x - 4000) * (2500 / L) + (tv.y - 0) * (1000 / L);
    expect(Math.abs(Math.abs(off) - 80)).toBeLessThan(3);
    // inward（along を +90° 回した向き）は、壁から部屋（西）へ
    const ar = (tv.rot * Math.PI) / 180;
    const inward = { x: -Math.sin(ar), y: Math.cos(ar) };
    expect(inward.x * nx + inward.y * ny).toBeGreaterThan(0.99);
  });

  it('窓・戸のそばの四角（カーテンボックス・開けた引戸）、階段のそば（笠木・手すり）、収納の中、テレビ台のある部屋は読まない', () => {
    const w = wall('W1', 0, 0, 4000, 0);
    const ldk = room('ldk', 'ldk', 0, 0, 4000, 4000);
    const segs = rectSegs(2000, 170, 0, 1500, 60);
    const sofa: FurnitureItem = { id: 's', kind: 'sofa', x: 2000, y: 3200, rot: 180, roomId: 'ldk' };
    expect(readWallTvs(segs, [w], [], [ldk], [sofa], 1).items).toHaveLength(1);
    const win: Opening = { id: 'o', wallId: 'W1', kind: 'window', t0: 1200, t1: 2800, sill: 0, height: 2000 } as Opening;
    expect(readWallTvs(segs, [w], [win], [ldk], [sofa], 1).items).toHaveLength(0);
    expect(readWallTvs(segs, [w], [], [{ ...room('cl', 'closet', 0, 0, 4000, 4000) }], [{ ...sofa, roomId: 'cl' }], 1).items).toHaveLength(0);
    const board: FurnitureItem = { id: 't', kind: 'tv', x: 2000, y: 3900, rot: 180, roomId: 'ldk' };
    expect(readWallTvs(segs, [w], [], [ldk], [sofa, board], 1).items).toHaveLength(0);
    // 階段のすぐ脇（吹抜の腰壁の笠木）
    expect(readWallTvs(segs, [w], [], [ldk], [sofa], 1, [{ minX: 1000, minY: 400, maxX: 2820, maxY: 2220 }]).items).toHaveLength(0);
    // 壁の面にぴったり付いた四角（見切り・アウトセットの引戸）
    expect(readWallTvs(rectSegs(2000, 80 + 30 + 10, 0, 1500, 60), [w], [], [ldk], [sofa], 1).items).toHaveLength(0);
    // 寝室は、ベッドの正面
    const bed: FurnitureItem = { id: 'b', kind: 'bed', x: 2000, y: 2800, rot: 180, roomId: 'bed' };
    expect(readWallTvs(segs, [w], [], [room('bed', 'bedroom', 0, 0, 4000, 4000)], [bed], 1).items).toHaveLength(1);
  });
});

describe('先の列が伸びる折り返し階段（1 階は 1 間角、2 階の図は昇り口の側へ長い）', () => {
  const st = (o: Partial<Stair> = {}): Stair => ({ id: 's', minX: 0, minY: 0, maxX: 1820, maxY: 1820, kind: 'u', entry: 's', turn: 'right', goesUp: true, ...o }) as Stair;

  it('伸びた分だけ先の列の段が増え、最初の列は短くなる。中央の腰壁は無し（内側は開く）', () => {
    const n = 13;
    const base = stairLayout(st(), n);
    const over = stairLayout(st({ overrun: 910 }), n);
    const firstRun = (lay: ReturnType<typeof stairLayout>) => {
      const ps = lay.pieces;
      let k = 0;
      while (k < ps.length && ps[k].kind === 'tread' && ps[k].dir.x === ps[0].dir.x && ps[k].dir.y === ps[0].dir.y) k++;
      return k;
    };
    expect(firstRun(over)).toBeLessThan(firstRun(base));
    expect(firstRun(over)).toBeGreaterThanOrEqual(2);
    expect(over.innerOpen).toBe(true);
    expect(over.wall).toBeFalsy();
    expect(base.innerOpen).toBeFalsy();
    // 段の数は同じ（最後の段 = 上の階の床は数えない）
    expect(Math.max(...over.pieces.map((p) => p.i))).toBe(Math.max(...base.pieces.map((p) => p.i)));
  });

  it('上の階の床の穴は、伸びた分だけ昇り口の側へ広がる（階段室の範囲は変えない）', () => {
    const bb = (rs: { minX: number; minY: number; maxX: number; maxY: number }[]) => ({ minX: Math.min(...rs.map((r) => r.minX)), minY: Math.min(...rs.map((r) => r.minY)), maxX: Math.max(...rs.map((r) => r.maxX)), maxY: Math.max(...rs.map((r) => r.maxY)) });
    const a = bb(stairFootprint(st()));
    const b = bb(stairFootprint(st({ overrun: 910 })));
    const grow = b.maxX - b.minX + (b.maxY - b.minY) - (a.maxX - a.minX + (a.maxY - a.minY));
    expect(grow).toBeCloseTo(910, -1);
  });
});

describe('斜めの壁を突き抜けた壁の端', () => {
  const floor = (walls: Wall[], openings: Opening[] = []): Floor => ({ level: 1, elevation: 0, height: 2900, ceilingHeight: 2400, walls, openings, rooms: [], stairs: [], outline: [] }) as unknown as Floor;

  it('斜めの壁の向こうへ 40〜450mm はみ出した端は、斜めの壁の芯まで戻す', () => {
    // 斜めの壁: (2000, 0) → (1000, 2500)。横の壁は y = 1250 を東から来て、斜めの壁（x = 1500）を 182 突き抜ける
    const f = floor([wall('D', 2000, 0, 1000, 2500), wall('H', 1318, 1250, 3500, 1250)]);
    expect(trimEndsThroughDiagonals(f)).toBe(1);
    const h = f.walls.find((w) => w.id === 'H')!;
    expect(h.a.x).toBeCloseTo(1500, 0);
    expect(h.a.y).toBe(1250);
    expect(h.b.x).toBe(3500);
    expect(h.joinedA).toBe(true);
  });

  it('はみ出した先に別の壁がつながる壁・大きく横切る壁・建具のある区間は触らない', () => {
    const cont = floor([wall('D', 2000, 0, 1000, 2500), wall('H', 1318, 1250, 3500, 1250), wall('V', 1318, 1250, 1318, 2400)]);
    expect(trimEndsThroughDiagonals(cont)).toBe(0);
    const cross = floor([wall('D', 2000, 0, 1000, 2500), wall('H', 300, 1250, 3500, 1250)]);
    expect(trimEndsThroughDiagonals(cross)).toBe(0);
    const door: Opening = { id: 'o', wallId: 'H', kind: 'door', t0: 50, t1: 150, sill: 0, height: 2000 } as Opening;
    const withDoor = floor([wall('D', 2000, 0, 1000, 2500), wall('H', 1318, 1250, 3500, 1250)], [door]);
    expect(trimEndsThroughDiagonals(withDoor)).toBe(0);
  });

  it('端を戻した壁の建具は、位置がずれない（始点が動いた分を引く）', () => {
    const win: Opening = { id: 'o', wallId: 'H', kind: 'window', t0: 800, t1: 1600, sill: 900, height: 1100 } as Opening;
    const f = floor([wall('D', 2000, 0, 1000, 2500), wall('H', 1318, 1250, 3500, 1250)], [win]);
    expect(trimEndsThroughDiagonals(f)).toBe(1);
    expect(f.openings[0].t0).toBeCloseTo(800 - 182, 0);
    expect(f.openings[0].t1).toBeCloseTo(1600 - 182, 0);
  });
});
