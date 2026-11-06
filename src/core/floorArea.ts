/**
 * 階の床面積の数え方（図面の面積表・読み取りの点数・見積の拾いで共通）。
 * 吹抜・バルコニー・ポーチ・車庫は床面積に入れない。ただし「階段室の吹抜」（下の階の階段の真上にある小さな吹抜 ＝ 上の階で階段が着く所）は、
 * 図面の面積表でも床に数えられている（有元様邸の 3 階: 階段の上 8.28 ㎡ を吹抜と読んでいたが、面積表の 65.33 ㎡ はそれを含む）ので床に数える。
 */
import { pointInPolygon } from './geometry';
import { excludedFromFloorArea, type Floor, type Room } from './types';

/** 下の階の階段の真上にある小さな吹抜（12 ㎡ まで）で、その半分以上が階段に重なるもの */
export function isStairwellVoid(r: Room, below: Floor | undefined): boolean {
  if (r.type !== 'void' || !below || r.polygon.length < 3 || r.area <= 0 || r.area > 12) return false;
  const stairRooms = below.rooms.filter((s) => s.type === 'stairs' && s.polygon.length >= 3);
  const stairRects = below.stairs ?? [];
  if (!stairRooms.length && !stairRects.length) return false;
  const xs = r.polygon.map((p) => p.x);
  const ys = r.polygon.map((p) => p.y);
  const step = 100;
  let inVoid = 0;
  let inStair = 0;
  for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step)
    for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) {
      const p = { x, y };
      if (!pointInPolygon(p, r.polygon)) continue;
      inVoid++;
      if (stairRooms.some((s) => pointInPolygon(p, s.polygon)) || stairRects.some((s) => x >= s.minX && x <= s.maxX && y >= s.minY && y <= s.maxY)) inStair++;
    }
  return inVoid > 0 && inStair / inVoid >= 0.5;
}

/** 階の床面積（㎡）: 部屋の面積の合計から吹抜・バルコニー・ポーチ・車庫を除く（階段室の吹抜は床に数える） */
export function floorAreaOf(f: Floor, floors: Floor[]): number {
  const below = floors.find((x) => x.level === f.level - 1);
  return f.rooms.filter((r) => !excludedFromFloorArea(r.type) || isStairwellVoid(r, below)).reduce((s, r) => s + r.area, 0);
}
