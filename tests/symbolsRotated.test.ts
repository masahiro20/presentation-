import { describe, expect, it } from 'vitest';
import { detectSymbols, symbolsToItems, type PlanSymbol } from '../src/parser/symbols';
import { senseFurniture } from '../src/parser/furnitureSense';
import type { Seg } from '../src/parser/walls';
import type { FurnitureItem, Room, Vec2 } from '../src/core/types';

const seg = (a: Vec2, b: Vec2, width = 0.12): Seg => ({ a, b, width, dashed: false, source: 'stroke' });
const rot = (p: Vec2, c: Vec2, ang: number): Vec2 => ({ x: c.x + (p.x - c.x) * Math.cos(ang) - (p.y - c.y) * Math.sin(ang), y: c.y + (p.x - c.x) * Math.sin(ang) + (p.y - c.y) * Math.cos(ang) });
/** 折れ線を step ごとの短い線分に（丸みのある家具の記号のように線の数を増やす） */
function polyline(pts: Vec2[], step: number, closed = true): Seg[] {
  const out: Seg[] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const k = Math.max(1, Math.round(L / step));
    for (let j = 0; j < k; j++) out.push(seg({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k }, { x: a.x + ((b.x - a.x) * (j + 1)) / k, y: a.y + ((b.y - a.y) * (j + 1)) / k }));
  }
  return out;
}
const rectPts = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

describe('回して置かれた記号・L 字・×印・点線の丸', () => {
  it('45° に置いた食卓（長方形 1,800×900）をカウンターとして、角度付きで読む', () => {
    const c = { x: 5000, y: 5000 };
    const pts = rectPts(c.x - 900, c.y - 450, c.x + 900, c.y + 450).map((p) => rot(p, c, Math.PI / 4));
    const segs: Seg[] = [];
    for (let i = 0; i < 4; i++) segs.push(seg(pts[i], pts[(i + 1) % 4]));
    const syms = detectSymbols(segs);
    const t = syms.find((s) => s.kind === 'counter');
    expect(t).toBeTruthy();
    expect(Math.abs(Math.max(t!.w, t!.h) - 1800)).toBeLessThan(40);
    expect(Math.abs(Math.min(t!.w, t!.h) - 900)).toBeLessThan(40);
    expect(Math.abs(Math.abs(t!.rot ?? 0) - Math.PI / 4)).toBeLessThan(0.05);
    expect(Math.hypot(t!.x - c.x, t!.y - c.y)).toBeLessThan(30);
  });

  it('×印の正方形（0.7m）は xbox。対角線が中央で 2 本に割れていても、2×2 の小さな正方形で描かれていても読む', () => {
    // 1. 対角線 2 本
    const a: Seg[] = [];
    const p = rectPts(1000, 1000, 1700, 1700);
    for (let i = 0; i < 4; i++) a.push(seg(p[i], p[(i + 1) % 4]));
    a.push(seg(p[0], p[2]), seg(p[1], p[3]));
    expect(detectSymbols(a).filter((s) => s.kind === 'xbox').length).toBe(1);
    // 2. 45° に回した正方形（対角線は中央で割れて十字になる）
    const c = { x: 4000, y: 4000 };
    const q = rectPts(c.x - 350, c.y - 350, c.x + 350, c.y + 350).map((v) => rot(v, c, Math.PI / 4));
    const b: Seg[] = [];
    for (let i = 0; i < 4; i++) b.push(seg(q[i], q[(i + 1) % 4]));
    b.push(seg(q[0], c), seg(c, q[2]), seg(q[1], c), seg(c, q[3]));
    const xb = detectSymbols(b).filter((s) => s.kind === 'xbox');
    expect(xb.length).toBe(1);
    expect(Math.hypot(xb[0].x - c.x, xb[0].y - c.y)).toBeLessThan(30);
    // 3. 347 角の小さな正方形 2×2（各 1 本の対角線、隙間 50）
    const d: Seg[] = [];
    for (const [ox, oy] of [
      [0, 0],
      [397, 0],
      [0, 397],
      [397, 397],
    ]) {
      const r = rectPts(7000 + ox, 7000 + oy, 7347 + ox, 7347 + oy);
      for (let i = 0; i < 4; i++) d.push(seg(r[i], r[(i + 1) % 4]));
      d.push(ox === oy ? seg(r[0], r[2]) : seg(r[1], r[3]));
    }
    const xd = detectSymbols(d).filter((s) => s.kind === 'xbox');
    expect(xd.length).toBe(1);
    expect(Math.abs(xd[0].w - 744)).toBeLessThan(20);
  });

  it('L 字の外形（L 型ソファ）は空いている角を覚え、部屋側・カウチの向きに変える', () => {
    // 外形 2,700×1,700。背は上辺（y=0）、カウチは左端が下へ伸び、右下が空く
    const L: Vec2[] = [
      { x: 0, y: 0 },
      { x: 2700, y: 0 },
      { x: 2700, y: 900 },
      { x: 900, y: 900 },
      { x: 900, y: 1700 },
      { x: 0, y: 1700 },
    ];
    const segs = polyline(L, 50);
    const syms = detectSymbols(segs);
    const sofa = syms.find((s) => s.kind === 'sofa');
    expect(sofa).toBeTruthy();
    expect(sofa!.lEmpty).toEqual({ x: 1, y: 1 });
    const room: Room = { id: 'R1', name: 'ＬＤＫ', type: 'ldk', polygon: rectPts(-500, -500, 4000, 3000), area: 15.75, labelPos: { x: 2000, y: 2000 } };
    const { items } = symbolsToItems(syms, [room], [], [rectPts(-500, -500, 4000, 3000)], 1);
    const it = items.find((x) => x.kind === 'sofa');
    expect(it).toBeTruthy();
    expect(it!.shape).toBe('l');
    // 部屋側（下）から背を見て、カウチは左
    expect(it!.legSide).toBe('left');
    expect(it!.rot).toBe(0);
    // 基準点は背の辺の中央
    expect(Math.abs(it!.x - 1350)).toBeLessThan(5);
    expect(Math.abs(it!.y - 0)).toBeLessThan(5);
    expect(Math.abs((it!.w ?? 0) - 2.7)).toBeLessThan(0.05);
  });

  it('点線で描いた丸（植栽）を、隣り合っていても中心の印ごとに読む', () => {
    const segs: Seg[] = [];
    const tree = (c: Vec2, r: number) => {
      // 中心の印 3 点 ＋ 輪の点 40 個（各点は 10mm の線）
      for (const [dx, dy] of [
        [0, 0],
        [30, 10],
        [-20, 25],
      ])
        segs.push(seg({ x: c.x + dx, y: c.y + dy }, { x: c.x + dx + 8, y: c.y + dy }));
      for (let i = 0; i < 40; i++) {
        const a = (i / 40) * 2 * Math.PI;
        const p = { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
        segs.push(seg(p, { x: p.x + 7, y: p.y + 7 }));
      }
    };
    tree({ x: 2000, y: 2000 }, 600);
    tree({ x: 3150, y: 2000 }, 550); // 輪が触れ合う隣の木
    const plants = detectSymbols(segs).filter((s) => s.kind === 'plant');
    expect(plants.length).toBe(2);
    const big = plants.find((p) => Math.hypot(p.x - 2000, p.y - 2000) < 40);
    expect(big).toBeTruthy();
    expect(Math.abs(big!.w / 2 - 600)).toBeLessThan(40);
  });

  it('同じ所に二重に読んだベッド（外枠とマットレス）は 1 台にする', () => {
    const room: Room = { id: 'R1', name: '洋室', type: 'bedroom', polygon: rectPts(0, 0, 3640, 2730), area: 9.9, labelPos: { x: 1800, y: 1300 } };
    const items: FurnitureItem[] = [
      { id: 'a', kind: 'bed', x: 1000, y: 100, rot: 0, w: 1.28, roomId: 'R1' },
      { id: 'b', kind: 'bed', x: 1030, y: 100, rot: 0, w: 1.2, roomId: 'R1' },
      { id: 'c', kind: 'desk', x: 3000, y: 100, rot: 0, w: 1.2, roomId: 'R1' },
    ];
    const r = senseFurniture(items, [room]);
    expect(r.items.filter((it) => it.kind === 'bed').map((it) => it.id)).toEqual(['a']);
    expect(r.items.length).toBe(2);
  });

  it('椅子だけの食卓は、椅子の並びが斜めなら斜めの向きのまま', () => {
    // 45° に置いた食卓の周りの椅子 4 脚（記号は作らず、chair の PlanSymbol を直接渡す）
    const c = { x: 5000, y: 5000 };
    const chairs: PlanSymbol[] = [
      { x: -600, y: -350 },
      { x: 600, y: -350 },
      { x: -600, y: 350 },
      { x: 600, y: 350 },
    ].map((d) => {
      const p = rot({ x: c.x + d.x, y: c.y + d.y }, c, Math.PI / 4);
      return { kind: 'chair', x: p.x, y: p.y, w: 500, h: 520, n: 100, rot: Math.PI / 4 } as PlanSymbol;
    });
    const room: Room = { id: 'R1', name: 'ＬＤＫ', type: 'ldk', polygon: rectPts(0, 0, 10000, 10000), area: 100, labelPos: { x: 5000, y: 8000 } };
    const { items } = symbolsToItems(chairs, [room], [], [rectPts(0, 0, 10000, 10000)], 1);
    const dining = items.find((it) => it.kind === 'dining');
    expect(dining).toBeTruthy();
    expect(Math.abs(((dining!.rot % 180) + 180) % 180 - 45)).toBeLessThan(6);
  });
});
