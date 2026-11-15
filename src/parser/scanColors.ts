/**
 * 着色した図面のスキャン: 部屋の塗りの色から、部屋の用途を読む。
 *
 * 手で色を付けたファーストプラン（マーカーで着色してスキャンした PDF）は、文字が画像なので室名が読めない。
 * 一方で、設計士は部屋の床を色で描き分けている（寺川様邸で確かめた色）:
 *   木の色（ベージュ〜茶） = フローリングの部屋（LDK・洋室・寝室・廊下）
 *   緑                     = 畳の部屋（和室）
 *   灰                     = 土間（玄関・ポーチ・車庫）
 *   塗っていない（白）     = 水まわり・収納
 * 色と広さから「仮の用途」を置き、3D に家具・窓の高さ（LDK の掃き出し）が出るようにする。
 * 仮に置いた部屋は inferred = true。違えば読み込み結果の一覧で直せる。
 */
import type { RoomType, Vec2 } from '../core/types';
import { pointInPolygon } from '../core/geometry';

/** ページを縮小した色の画像（RGB）。ox・oy は画像の左上のモデル座標 (mm)、res は 1 画素の大きさ (mm) */
export interface ScanColor {
  data: Uint8Array;
  w: number;
  h: number;
  res: number;
  ox: number;
  oy: number;
}

export type PaintClass = 'white' | 'ink' | 'gray' | 'green' | 'wood' | 'blue' | 'other';

/** 1 画素の色の種類 */
export function paintClassOf(r: number, g: number, b: number): PaintClass {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mn >= 225) return 'white';
  if (mx < 90) return 'ink';
  const sat = (mx - mn) / mx;
  if (sat < 0.1) return 'gray';
  let h: number;
  if (mx === r) h = ((g - b) / (mx - mn)) % 6;
  else if (mx === g) h = (b - r) / (mx - mn) + 2;
  else h = (r - g) / (mx - mn) + 4;
  h = (h * 60 + 360) % 360;
  if (h >= 65 && h <= 170 && sat >= 0.18) return 'green';
  if (h >= 15 && h <= 55 && sat >= 0.12) return 'wood';
  if (h >= 180 && h <= 260 && sat >= 0.15) return 'blue';
  return 'other';
}

export interface RoomPaint {
  /** 数えた画素（線・文字の黒は除く） */
  n: number;
  wood: number;
  green: number;
  gray: number;
  blue: number;
  white: number;
}

/** 部屋の区画の中の色の割合（0〜1。黒い線・文字は除く） */
export function roomPaint(img: ScanColor, polygon: Vec2[]): RoomPaint {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const x0 = Math.max(0, Math.floor((Math.min(...xs) - img.ox) / img.res));
  const x1 = Math.min(img.w - 1, Math.ceil((Math.max(...xs) - img.ox) / img.res));
  const y0 = Math.max(0, Math.floor((Math.min(...ys) - img.oy) / img.res));
  const y1 = Math.min(img.h - 1, Math.ceil((Math.max(...ys) - img.oy) / img.res));
  const c = { white: 0, ink: 0, gray: 0, green: 0, wood: 0, blue: 0, other: 0 };
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const p = { x: img.ox + (x + 0.5) * img.res, y: img.oy + (y + 0.5) * img.res };
      if (!pointInPolygon(p, polygon)) continue;
      const i = (y * img.w + x) * 3;
      c[paintClassOf(img.data[i], img.data[i + 1], img.data[i + 2])]++;
    }
  const n = c.white + c.gray + c.green + c.wood + c.blue + c.other;
  const f = (v: number) => (n ? v / n : 0);
  return { n, wood: f(c.wood), green: f(c.green), gray: f(c.gray), blue: f(c.blue), white: f(c.white) };
}

export interface ScanGuess {
  name: string;
  type: RoomType;
}

/**
 * 室名の読めない図面の部屋に、仮の用途を置く。
 * @param rooms 用途の決まっていない部屋（area は ㎡）。paint は色の割合（色の画像が無ければ省略）
 * @returns 部屋ごとの仮の用途（決められない部屋は null）
 *
 * 決まり:
 *  - 緑が半分以上                         → 和室
 *  - 灰が半分以上で 1.5 帖以上            → 玄関（いちばん広い 1 つだけ。残りは土間）
 *  - いちばん広い部屋（13 帖以上。色があるなら木の色の部屋から） → LDK
 *  - 木の色で 4.5〜12 帖、細長くない      → 洋室
 * 色の無い図面では LDK だけ（洋室は決めない）。
 */
export function guessScanRooms(rooms: { area: number; polygon: Vec2[]; paint?: RoomPaint }[]): (ScanGuess | null)[] {
  const out: (ScanGuess | null)[] = rooms.map(() => null);
  const tatami = (i: number) => rooms[i].area / 1.62;
  const colored = rooms.some((r) => r.paint && r.paint.n >= 20 && r.paint.wood + r.paint.green + r.paint.gray >= 0.3);
  const isWood = (i: number) => !!rooms[i].paint && rooms[i].paint!.wood >= 0.3 && rooms[i].paint!.wood > rooms[i].paint!.gray;
  rooms.forEach((r, i) => {
    if (r.paint && r.paint.n >= 12 && r.paint.green >= 0.5 && tatami(i) >= 2.5) out[i] = { name: '和室', type: 'japanese' };
  });
  const doma = rooms.map((r, i) => i).filter((i) => !out[i] && rooms[i].paint && rooms[i].paint!.n >= 12 && rooms[i].paint!.gray >= 0.5 && tatami(i) >= 1.5 && tatami(i) <= 12);
  doma.sort((a, b) => rooms[b].area - rooms[a].area);
  doma.forEach((i, k) => (out[i] = k === 0 ? { name: '玄関', type: 'entrance' } : { name: '土間', type: 'porch' }));
  const ldkCand = rooms.map((_, i) => i).filter((i) => !out[i] && tatami(i) >= 13 && (!colored || isWood(i)));
  ldkCand.sort((a, b) => rooms[b].area - rooms[a].area);
  if (ldkCand.length) out[ldkCand[0]] = { name: 'LDK', type: 'ldk' };
  if (colored)
    rooms.forEach((r, i) => {
      if (out[i] || !isWood(i)) return;
      const t = tatami(i);
      if (t < 4.5 || t > 12) return;
      // 細長い区画（廊下）は洋室にしない
      const xs = r.polygon.map((p) => p.x);
      const ys = r.polygon.map((p) => p.y);
      const bw = Math.max(...xs) - Math.min(...xs);
      const bh = Math.max(...ys) - Math.min(...ys);
      if (Math.min(bw, bh) < 1900 || (r.area * 1e6) / (bw * bh) < 0.45) return;
      out[i] = { name: '洋室', type: 'bedroom' };
    });
  return out;
}
