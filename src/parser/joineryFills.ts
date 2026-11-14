/**
 * 造作（大工工事の棚・カウンター）の塗りを読む。
 *
 * ARCHITREND の初回プランは、造作を木の色（茶〜ベージュ）で塗った四角で描く:
 *   書斎・スタディコーナーの壁沿いの帯（奥行 450〜800）＝ 造作のカウンター（机）。椅子が向いていればその数だけ席、
 *   収納・シューズクローク・洗面脱衣室の壁沿いの帯（奥行 250〜650）＝ 可動棚。
 * 線だけでは「何かの四角」としか分からないが、色が意味を持っている（御社のご提案パースと図面の突き合わせ: 大崎様邸。
 * スタディコーナーの茶色の帯は、腰壁に沿った壁から壁までの造作カウンターだった。ツールは読めずに、既製の机と本棚を置いていた）。
 *
 * 階段を木の色で塗る図面もあるので、階段・吹抜の中の塗りは読まない。細い帯（幅 135 以下）は框・手すりの笠木（別に読む）。
 */
import type { FurnitureItem, FurnitureKind, Room, RoomType, Stair, Vec2 } from '../core/types';
import { distPointSegment, pointInPolygon } from '../core/geometry';

/** 木の色か（色相 15〜50°・彩度 0.14 以上・明るさ 0.4〜0.9。灰色・白・壁の色は外れる） */
export function isWoodFillColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return false;
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 0.04) return false;
  const s = d / (1 - Math.abs(2 * l - 1) || 1);
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return h >= 15 && h <= 50 && s >= 0.14 && l >= 0.4 && l <= 0.9;
}

export interface JoineryFill {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 塗りの多角形から、軸に平行な四角（外接の四角の 92% 以上を占めるもの）を取り出す */
export function joineryRectOf(poly: Vec2[]): JoineryFill | null {
  if (poly.length < 4) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let a2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a2 += p.x * q.y - q.x * p.y;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w <= 0 || h <= 0 || Math.abs(a2) / 2 < w * h * 0.92) return null;
  return { minX, minY, maxX, maxY };
}

/** 造作の棚になる部屋（物をしまう所・水まわり） */
const SHELF_ROOMS: RoomType[] = ['storage', 'closet', 'washroom', 'toilet', 'entrance'];
/** 造作を読まない部屋（階段・吹抜・屋外） */
const SKIP_ROOMS: RoomType[] = ['stairs', 'void', 'garage', 'porch', 'balcony', 'bath'];

export interface JoineryResult {
  items: FurnitureItem[];
  /** 造作の席として数えた椅子・植物（読み違い）の家具の id。呼び出し側で外す */
  consumed: string[];
  /** 造作に置き換わる、同じ場所の既製の家具（机・本棚・収納・テレビ台）の id */
  replaced: string[];
  trace: string[];
}

/**
 * 木の色の四角を、造作の家具（カウンター・可動棚）にする。
 * @param fills 木の色の塗りの四角（図面の座標 mm）
 * @param existing すでに読めている家具（椅子・植物は席の手がかり、机・本棚は置き換え）
 * @param seats 椅子らしい記号の中心（図面の四角の候補のうち、350〜700 角のもの）
 */
export function readJoineryFills(fills: JoineryFill[], rooms: Room[], stairs: Pick<Stair, 'minX' | 'minY' | 'maxX' | 'maxY'>[], existing: FurnitureItem[], seats: Vec2[], level: number): JoineryResult {
  const items: FurnitureItem[] = [];
  const consumed: string[] = [];
  const replaced: string[] = [];
  const trace: string[] = [];
  let seq = 0;
  const seen: JoineryFill[] = [];
  for (const f of fills) {
    const w = f.maxX - f.minX;
    const h = f.maxY - f.minY;
    const S = Math.min(w, h);
    const L = Math.max(w, h);
    if (S < 250 || S > 850 || L < 550 || L > 6500) continue;
    // 同じ四角の重ね塗り
    if (seen.some((o) => Math.abs(o.minX - f.minX) < 30 && Math.abs(o.maxX - f.maxX) < 30 && Math.abs(o.minY - f.minY) < 30 && Math.abs(o.maxY - f.maxY) < 30)) continue;
    seen.push(f);
    const c = { x: (f.minX + f.maxX) / 2, y: (f.minY + f.maxY) / 2 };
    // 階段の範囲（段・踊り場を木の色で塗る図面がある）
    if (stairs.some((st) => c.x > st.minX - 60 && c.x < st.maxX + 60 && c.y > st.minY - 60 && c.y < st.maxY + 60)) continue;
    const room = rooms.find((r) => pointInPolygon(c, r.polygon));
    if (!room || SKIP_ROOMS.includes(room.type)) continue;
    // 部屋の大半を占める塗りは、床の塗り（部屋の色分け）
    if (w * h > room.area * 1e6 * 0.6) continue;
    const longX = w >= h;
    // 壁（部屋の輪郭）に付いている長い辺の側が背。どちらも付いていなければ、部屋の中心から遠い側
    const edgeDist = (p: Vec2) => {
      let d = Infinity;
      for (let i = 0; i < room.polygon.length; i++) d = Math.min(d, distPointSegment(p, room.polygon[i], room.polygon[(i + 1) % room.polygon.length]));
      return d;
    };
    const sideA = longX ? { x: c.x, y: f.minY } : { x: f.minX, y: c.y };
    const sideB = longX ? { x: c.x, y: f.maxY } : { x: f.maxX, y: c.y };
    const dA = edgeDist(sideA);
    const dB = edgeDist(sideB);
    const rc = room.labelPos;
    const farA = Math.hypot(sideA.x - rc.x, sideA.y - rc.y);
    const farB = Math.hypot(sideB.x - rc.x, sideB.y - rc.y);
    const backIsA = Math.abs(dA - dB) > 60 ? dA < dB : farA >= farB;
    const back = backIsA ? sideA : sideB;
    const front = backIsA ? sideB : sideA;
    const inward = { x: Math.sign(front.x - back.x), y: Math.sign(front.y - back.y) };
    // along は inward を −90° 回した向き（家具の決まり: inward = along を +90° 回した向き）
    const along = { x: inward.y, y: -inward.x };
    const rot = Math.round(((Math.atan2(along.y, along.x) * 180) / Math.PI + 360) % 360);
    // 席: 前の辺から 1,100 以内・幅の範囲内にある椅子（読み違いの植物を含む）
    const inFront = (p: Vec2) => {
      const u = (p.x - c.x) * along.x + (p.y - c.y) * along.y;
      const v = (p.x - front.x) * inward.x + (p.y - front.y) * inward.y;
      return Math.abs(u) <= L / 2 + 100 && v >= -150 && v <= 1100;
    };
    const chairItems = existing.filter((it) => (it.kind === 'chair' || (it.kind === 'plant' && (it.w ?? 1) <= 1.1 && (it.h ?? 0) < 2)) && inFront({ x: it.x, y: it.y }));
    const seatPts = seats.filter((p) => inFront(p) && !chairItems.some((it) => Math.hypot(it.x - p.x, it.y - p.y) < 400));
    const nSeats = chairItems.length + seatPts.length;
    const shelfRoom = SHELF_ROOMS.includes(room.type);
    let variant: NonNullable<FurnitureItem['variant']>;
    let extra: Partial<FurnitureItem> = {};
    if (shelfRoom) variant = 'shelves';
    else if (nSeats >= 1 || S >= 450) {
      variant = 'counter';
      extra = { seats: Math.min(8, nSeats) };
    } else variant = 'lowShelf';
    const it: FurnitureItem = { id: `pj${level}_${++seq}`, kind: 'builtin', variant, x: Math.round(back.x), y: Math.round(back.y), rot, roomId: room.id, w: +(L / 1000).toFixed(2), d: +(S / 1000).toFixed(2), ...extra };
    items.push(it);
    if (variant === 'counter') consumed.push(...chairItems.map((x) => x.id));
    // 同じ場所に読めていた既製の家具（机・本棚・収納・テレビ台）は、造作に置き換える
    const REPL: FurnitureKind[] = ['desk', 'bookshelf', 'cabinet', 'tv', 'shoeCabinet', 'cupboard'];
    for (const o of existing) {
      if (!REPL.includes(o.kind) || o.roomId !== room.id) continue;
      if (o.x > f.minX - 150 && o.x < f.maxX + 150 && o.y > f.minY - 150 && o.y < f.maxY + 150) replaced.push(o.id);
    }
    trace.push(`${level}F ${room.name}: 木の色の四角 ${Math.round(S)}×${Math.round(L)} → ${variant}${extra.seats != null ? `（席 ${extra.seats}）` : ''}`);
  }
  return { items, consumed, replaced, trace };
}
