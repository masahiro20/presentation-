/**
 * 平面図の文字（室名・帖数・「上部吹抜」）の置き場所。
 *
 * 室名は図面に書かれていた位置（Room.labelPos）に置くのが基本。ただ、そこに家具の記号や別の文字があると
 * 「LDK (27.2帖)」がソファの上に載る・「上部吹抜」が室名のすぐ下に重なる、という読みにくい図面になる。
 * 部屋の中で、家具・ほかの文字と重ならない近くの位置を探して少しだけ動かす（重なりがはっきり減るときだけ動かす）。
 *
 * 見る人: お客様（提案の図面）と設計士（社内の確認）。どちらも、室名が一目で読めること。
 */
import { pointInPolygon } from '../core/geometry';
import type { Vec2 } from '../core/types';

/** 図面上の長方形（mm。y は下向き） */
export interface LabelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function overlapArea(a: LabelBox, b: LabelBox): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 基準点 at に置いたときの箱（rel = 基準点から見た箱の範囲） */
export function boxAt(at: Vec2, rel: LabelBox): LabelBox {
  return { x0: at.x + rel.x0, y0: at.y + rel.y0, x1: at.x + rel.x1, y1: at.y + rel.y1 };
}

/** 箱の四隅と中心が、輪郭の中にあるか */
export function boxInside(b: LabelBox, poly: Vec2[]): boolean {
  if (poly.length < 3) return false;
  const pts: Vec2[] = [
    { x: b.x0, y: b.y0 },
    { x: b.x1, y: b.y0 },
    { x: b.x1, y: b.y1 },
    { x: b.x0, y: b.y1 },
    { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 },
  ];
  return pts.every((p) => pointInPolygon(p, poly));
}

export interface PlaceLabelOpts {
  /** 置きたい位置（文字の基準点。図面に書かれていた位置） */
  at: Vec2;
  /** 基準点から見た文字の箱 */
  rel: LabelBox;
  /** 収める範囲（部屋の輪郭）。箱がこの中に収まる位置だけを候補にする */
  within: Vec2[];
  /** 避けたい物（家具の記号など）。重なった面積の分だけ減点 */
  obstacles: LabelBox[];
  /** すでに置いた文字。重なりは家具の 8 倍の減点（文字どうしは重ねない） */
  taken: LabelBox[];
  /** 探す範囲（基準点からの距離 mm。既定 2,400） */
  reach?: number;
  /** 部屋からはみ出した文字を戻すときに動かしてよい距離（mm。既定 1,300）。これより遠くにしか収まらないなら動かさない */
  reachOutside?: number;
  /** 探す刻み（mm。既定 130） */
  step?: number;
}

/**
 * 文字の基準点を決める。部屋に収まっていて重なりも無ければ動かさない。
 *  - 部屋からはみ出している（壁に掛かっている）: 部屋に収まる、いちばん近くて重なりの少ない位置へ。収まる位置が無い（小さな物入など）なら動かさない
 *  - 部屋には収まっているが家具・文字と重なる: 減点が 6 割未満になる位置があるときだけ動かす（少しの重なりのために室名を遠くへ飛ばさない）
 */
export function placeLabel(o: PlaceLabelOpts): Vec2 {
  const step = o.step ?? 130;
  const h = o.rel.y1 - o.rel.y0;
  const over = (b: LabelBox) => o.obstacles.reduce((s, x) => s + overlapArea(b, x), 0) + 8 * o.taken.reduce((s, x) => s + overlapArea(b, x), 0);
  const b0 = boxAt(o.at, o.rel);
  const base = over(b0);
  const inside0 = boxInside(b0, o.within);
  if (inside0 && base <= 0) return o.at;
  const reach = inside0 ? (o.reach ?? 2400) : (o.reachOutside ?? 1300);
  // 動かす距離の減点: 文字の高さ 1 つ分動かすと、文字の高さ × 高さ の 1 割強の面積が重なったのと同じ
  const distCost = h * 0.12;
  let best = o.at;
  // 元の位置で文字が部屋からはみ出している（壁に掛かる）ときは、収まる位置があればそこへ動かす
  let bestCost = inside0 ? base : Infinity;
  for (let dy = -reach; dy <= reach; dy += step) {
    for (let dx = -reach; dx <= reach; dx += step) {
      const d = Math.hypot(dx, dy);
      if (d < 1 || d > reach) continue;
      const cost0 = d * distCost;
      if (cost0 >= bestCost) continue;
      const at = { x: o.at.x + dx, y: o.at.y + dy };
      const b = boxAt(at, o.rel);
      if (!boxInside(b, o.within)) continue;
      const cost = over(b) + cost0;
      if (cost < bestCost) {
        bestCost = cost;
        best = at;
      }
    }
  }
  if (!inside0) return best;
  return bestCost < base * 0.6 ? best : o.at;
}
