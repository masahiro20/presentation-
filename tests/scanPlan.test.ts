// 手描き・着色のスキャン図面（寺川様邸のファーストプラン）から学んだ読み方:
//  1. 縦横の棟のほかに、斜めに振れた棟の壁も読む（縦横の壁を消した残りから、その向きに長く続く線で向きを探す）
//  2. 太い実線の壁の帯の中で、実線が途切れて細い線だけの区間は窓・戸（壁にしない）
//  3. どの壁にもつながらない短い「壁」（図面の枠・表の罫線・文字の塊）は捨てる
//  4. 室名が読めないので、部屋の塗りの色（木の色 = フローリング・緑 = 畳・灰 = 土間）と広さから用途を仮に置く
import { describe, expect, it } from 'vitest';
import { detectWallsRasterAuto, obliqueAnglesFromMask, splitPiecesBySolid, type BinaryImage } from '../src/parser/rasterWalls';
import { dropScanDebris } from '../src/parser/assemble';
import { guessScanRooms, paintClassOf, roomPaint, type ScanColor } from '../src/parser/scanColors';
import type { Vec2 } from '../src/core/types';

const RES = 20; // 1 画素 = 20mm
/** 太さ th 画素の線分を画像に描く（座標は画素） */
function stroke(data: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number, th: number): void {
  const L = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.ceil(L * 2);
  const r = th / 2;
  for (let i = 0; i <= n; i++) {
    const cx = x0 + ((x1 - x0) * i) / n;
    const cy = y0 + ((y1 - y0) * i) / n;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) if (x >= 0 && y >= 0 && x < w && y < h && Math.hypot(x - cx, y - cy) <= r) data[y * w + x] = 1;
  }
}
/** 中心 (cx, cy)・幅 bw・奥行 bh・角度 deg の四角い棟（壁の太さ th） */
function box(data: Uint8Array, w: number, h: number, cx: number, cy: number, bw: number, bh: number, deg: number, th: number): Vec2[] {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  const pt = (u: number, v: number) => ({ x: cx + u * c - v * s, y: cy + u * s + v * c });
  const P = [pt(-bw / 2, -bh / 2), pt(bw / 2, -bh / 2), pt(bw / 2, bh / 2), pt(-bw / 2, bh / 2)];
  for (let i = 0; i < 4; i++) stroke(data, w, h, P[i].x, P[i].y, P[(i + 1) % 4].x, P[(i + 1) % 4].y, th);
  return P;
}
/**
 * 縦横の棟（左）と 30° 振れた棟（右）、図面の枠の長い縦線、文字のような塊
 * @param frame 枠の線の太さ（画素）
 */
function twoWings(frame = 10): { img: BinaryImage; rot: Vec2[] } {
  const w = 900;
  const h = 600;
  const data = new Uint8Array(w * h);
  box(data, w, h, 200, 300, 260, 220, 0, 8);
  const rot = box(data, w, h, 600, 300, 300, 240, 30, 8);
  // 図面の枠（長い縦線）
  stroke(data, w, h, 20, 10, 20, 590, frame);
  // 文字・樹木のような塊
  for (let i = 0; i < 60; i++) stroke(data, w, h, 40 + ((i * 97) % 820), 20 + ((i * 53) % 560), 46 + ((i * 97) % 820), 24 + ((i * 53) % 560), 6);
  return { img: { data, w, h, res: RES, ox: 0, oy: 0 }, rot };
}

describe('スキャン図面の斜めに振れた棟', () => {
  it('縦横の壁を消した残りから、振れた棟の向き（30°）と直交する向き（120°）を見つける。枠の長い線や文字の塊には引っぱられない', () => {
    // 枠は壁より太い線（壁としては拾われずに残る線）でも、縦横に長く続く線として先に消える
    const { img } = twoWings(30);
    const ang = obliqueAnglesFromMask(img.data, img.w, img.h, [0, 90], img.res);
    expect(ang.length).toBe(2);
    const near = (a: number, b: number) => Math.min(Math.abs(a - b), 180 - Math.abs(a - b));
    expect(Math.min(near(ang[0], 30), near(ang[0], 120))).toBeLessThan(0.6);
    expect(Math.min(near(ang[1], 30), near(ang[1], 120))).toBeLessThan(0.6);
    expect(near(ang[0], ang[1])).toBeGreaterThan(85);
  });

  it('縦横の棟しか無い図面では、斜めの向きを作らない', () => {
    const w = 600;
    const h = 500;
    const data = new Uint8Array(w * h);
    box(data, w, h, 300, 250, 320, 240, 0, 8);
    stroke(data, w, h, 20, 10, 20, 490, 30);
    expect(obliqueAnglesFromMask(data, w, h, [0, 90], RES)).toEqual([]);
  });

  it('振れた棟の 4 辺が、角まで届く 1 本ずつの壁として読める（角の塊を「短い縦横の壁」として先に消さない）', () => {
    const { img, rot } = twoWings();
    const det = detectWallsRasterAuto(img, { closeRadius: 1, minThickness: img.res * 2.5, maxThickness: 400 })!;
    expect(det.groups.length).toBe(4);
    const ends: Vec2[] = [];
    for (const q of det.pieces) {
      if (q.g < 2) continue;
      const g = det.groups[q.g];
      for (const t of [q.t0, q.t1]) ends.push({ x: g.u.x * t + g.n.x * q.o, y: g.u.y * t + g.n.y * q.o });
    }
    // 斜めの壁は 4 本（辺ごとに 1 本）
    expect(det.pieces.filter((q) => q.g >= 2).length).toBe(4);
    // どの角にも、斜めの壁の端が 2 つ、角から 25cm 以内に来る
    for (const c of rot) {
      const n = ends.filter((e) => Math.hypot(e.x - c.x * RES, e.y - c.y * RES) < 250).length;
      expect(n).toBe(2);
    }
    // 斜めの壁の中に収まる短い縦横の壁片は残らない
    const inRot = det.pieces.filter((q) => q.g < 2 && q.t1 - q.t0 < 1500).filter((q) => {
      const g = det.groups[q.g];
      const m = { x: g.u.x * ((q.t0 + q.t1) / 2) + g.n.x * q.o, y: g.u.y * ((q.t0 + q.t1) / 2) + g.n.y * q.o };
      return rot.some((c) => Math.hypot(m.x - c.x * RES, m.y - c.y * RES) < 400);
    });
    expect(inRot.length).toBe(0);
  });
});

describe('太い実線の壁の中の、細い線だけの区間は窓', () => {
  /** 横の壁 1 本（x 100〜500 画素）。そのうち x 220〜340 は窓（帯にはあるが、実線としては無い） */
  function wallWithWindow(solidAll = false): BinaryImage {
    const w = 600;
    const h = 200;
    const data = new Uint8Array(w * h);
    const solid = new Uint8Array(w * h);
    stroke(data, w, h, 100, 100, 500, 100, 8);
    if (solidAll) solid.set(data);
    else {
      stroke(solid, w, h, 100, 100, 220, 100, 8);
      stroke(solid, w, h, 340, 100, 500, 100, 8);
    }
    // 実線の壁はほかにもたくさんある（実線で壁を描く図面）
    for (let k = 0; k < 4; k++) {
      stroke(data, w, h, 60, 20 + k * 12, 560, 20 + k * 12, 6);
      stroke(solid, w, h, 60, 20 + k * 12, 560, 20 + k * 12, 6);
    }
    return { data, solid, w, h, res: RES, ox: 0, oy: 0 };
  }
  const detect = (img: BinaryImage) => detectWallsRasterAuto(img, { closeRadius: 1, minThickness: img.res * 2.5, maxThickness: 400 })!;

  it('窓の区間で壁が 2 つに分かれ、その間が開口になる', () => {
    const det = detect(wallWithWindow());
    const g0 = det.groups.findIndex((g) => Math.abs(g.u.x) > 0.99);
    const onWall = det.pieces.filter((q) => q.g === g0 && Math.abs(q.o - 100 * RES) < 150).sort((a, b) => a.t0 - b.t0);
    expect(onWall.length).toBe(2);
    expect(onWall[0].t1).toBeGreaterThan(215 * RES - 120);
    expect(onWall[0].t1).toBeLessThan(225 * RES + 120);
    expect(onWall[1].t0).toBeGreaterThan(335 * RES - 120);
    expect(onWall[1].t0).toBeLessThan(345 * RES + 120);
    const op = det.openings.filter((o) => o.g === g0 && Math.abs(o.o - 100 * RES) < 150);
    expect(op.length).toBe(1);
    expect(op[0].t1 - op[0].t0).toBeGreaterThan(2000);
    expect(op[0].t1 - op[0].t0).toBeLessThan(2800);
  });

  it('実線が切れ目なく続く壁は、そのまま 1 本', () => {
    const det = detect(wallWithWindow(true));
    const g0 = det.groups.findIndex((g) => Math.abs(g.u.x) > 0.99);
    expect(det.pieces.filter((q) => q.g === g0 && Math.abs(q.o - 100 * RES) < 150).length).toBe(1);
    expect(det.openings.filter((o) => o.g === g0 && Math.abs(o.o - 100 * RES) < 150).length).toBe(0);
  });

  it('壁を細い 2 本線で描く図面（実線の画像に壁が残らない）では、帯のままにする', () => {
    const img = wallWithWindow();
    img.solid = new Uint8Array(img.w * img.h);
    const det = detect(img);
    const before = det.pieces.length;
    splitPiecesBySolid(det, img);
    expect(det.pieces.length).toBe(before);
    expect(det.pieces.some((q) => Math.abs(q.o - 100 * RES) < 150 && q.t1 - q.t0 > 7000)).toBe(true);
  });
});

describe('どの壁にもつながらない短い壁（枠・表の罫線・文字の塊）は捨てる', () => {
  const W = (x0: number, y0: number, x1: number, y1: number) => ({ a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, d: 150 });
  it('つながった塊の合計が 3m 未満のものだけ消える。部屋を囲む壁・長い独立壁は残る', () => {
    const room = [W(0, 0, 4000, 0), W(4000, 0, 4000, 3000), W(4000, 3000, 0, 3000), W(0, 3000, 0, 0)];
    const stub = W(2000, 0, 2000, 900); // 部屋の壁につながる短い袖壁
    const lone = W(9000, 0, 9000, 4200); // 車庫の側壁（独立した長い壁）
    const debris = [W(0, 8000, 1500, 8000), W(6000, 9000, 6800, 9000), W(6000, 9300, 6800, 9300)];
    const out = dropScanDebris([...room, stub, lone, ...debris]);
    expect(out.length).toBe(6);
    for (const d of debris) expect(out).not.toContain(d);
    expect(out).toContain(stub);
    expect(out).toContain(lone);
  });
});

describe('着色した図面の部屋の色から用途を読む', () => {
  it('色の種類: 寺川様邸で測った色（木の色・緑・灰・白）', () => {
    expect(paintClassOf(234, 223, 203)).toBe('wood'); // LDK の床
    expect(paintClassOf(233, 217, 189)).toBe('wood'); // 洋室・廊下
    expect(paintClassOf(200, 226, 106)).toBe('green'); // 和室
    expect(paintClassOf(188, 186, 186)).toBe('gray'); // 玄関の土間
    expect(paintClassOf(240, 240, 240)).toBe('white');
    expect(paintClassOf(30, 30, 30)).toBe('ink');
  });

  /** 100mm/画素の色の画像に、四角を塗る */
  function canvas(rects: { x0: number; y0: number; x1: number; y1: number; rgb: [number, number, number]; cover?: number }[]): ScanColor {
    const w = 200;
    const h = 150;
    const data = new Uint8Array(w * h * 3).fill(250);
    for (const r of rects)
      for (let y = r.y0 / 100; y < r.y1 / 100; y++)
        for (let x = r.x0 / 100; x < r.x1 / 100; x++) {
          // マーカーの塗りむら: cover の割合だけ塗る
          if (r.cover != null && (x * 7 + y * 13) % 10 >= r.cover * 10) continue;
          data.set(r.rgb, (y * w + x) * 3);
        }
    return { data, w, h, res: 100, ox: 0, oy: 0 };
  }
  const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  const WOOD: [number, number, number] = [233, 217, 189];
  const GREEN: [number, number, number] = [200, 226, 106];
  const GRAY: [number, number, number] = [188, 186, 186];

  it('部屋の中の色の割合（塗りむらがあっても、木の色が 3 割以上なら床の部屋）', () => {
    const img = canvas([{ x0: 0, y0: 0, x1: 6000, y1: 6000, rgb: WOOD, cover: 0.6 }]);
    const p = roomPaint(img, rect(0, 0, 6000, 6000));
    expect(p.wood).toBeGreaterThan(0.5);
    expect(p.wood).toBeLessThan(0.7);
    expect(p.white).toBeGreaterThan(0.3);
  });

  it('木の色のいちばん広い部屋 = LDK、木の色の 4.5〜12 帖 = 洋室、緑 = 和室、灰 = 玄関（2 つ目からは土間）。塗っていない部屋・廊下は決めない', () => {
    const polys = {
      ldk: rect(0, 0, 7000, 6000), // 42㎡ = 26 帖
      bed: rect(8000, 0, 11000, 3500), // 10.5㎡ = 6.5 帖
      corridor: rect(8000, 4000, 16000, 5000), // 8㎡ = 4.9 帖。細長い
      japanese: rect(12000, 0, 15000, 3500),
      genkan: rect(0, 7000, 3000, 10000), // 9㎡ = 5.6 帖
      sic: rect(4000, 7000, 5500, 9000), // 3㎡ = 1.9 帖
      wash: rect(8000, 6000, 11000, 9000), // 塗っていない
    };
    const img = canvas([
      { ...{ x0: 0, y0: 0, x1: 7000, y1: 6000 }, rgb: WOOD, cover: 0.6 },
      { ...{ x0: 8000, y0: 0, x1: 11000, y1: 3500 }, rgb: WOOD, cover: 0.8 },
      { ...{ x0: 8000, y0: 4000, x1: 16000, y1: 5000 }, rgb: WOOD, cover: 0.9 },
      { ...{ x0: 12000, y0: 0, x1: 15000, y1: 3500 }, rgb: GREEN },
      { ...{ x0: 0, y0: 7000, x1: 3000, y1: 10000 }, rgb: GRAY, cover: 0.8 },
      { ...{ x0: 4000, y0: 7000, x1: 5500, y1: 9000 }, rgb: GRAY, cover: 0.8 },
    ]);
    const rooms = Object.values(polys).map((polygon) => {
      const xs = polygon.map((p) => p.x);
      const ys = polygon.map((p) => p.y);
      return { polygon, area: ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / 1e6, paint: roomPaint(img, polygon) };
    });
    const g = guessScanRooms(rooms);
    expect(g.map((x) => x?.name ?? null)).toEqual(['LDK', '洋室', null, '和室', '玄関', '土間', null]);
    expect(g[0]?.type).toBe('ldk');
    expect(g[1]?.type).toBe('bedroom');
    expect(g[3]?.type).toBe('japanese');
    expect(g[4]?.type).toBe('entrance');
  });

  it('色の無いスキャン図面: いちばん広い部屋（13 帖以上）を LDK にするだけ。洋室は決めない', () => {
    const rooms = [
      { polygon: rect(0, 0, 7000, 6000), area: 42 },
      { polygon: rect(8000, 0, 11000, 3500), area: 10.5 },
      { polygon: rect(12000, 0, 15000, 3500), area: 10.5 },
    ];
    expect(guessScanRooms(rooms).map((x) => x?.name ?? null)).toEqual(['LDK', null, null]);
    // 13 帖に満たない部屋しか無ければ、何も決めない
    expect(guessScanRooms(rooms.slice(1)).every((x) => x == null)).toBe(true);
  });
});
