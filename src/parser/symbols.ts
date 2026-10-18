/**
 * 図面の「記号」を読む: 家具・設備・車・植栽
 *
 * CAD（ARCHITREND など）の平面図は、家具や設備を細い線のまとまり（部品）で描く。
 * 端点がつながる線をひとまとめにし、大きさ・線の数・形（丸み・直線）・置かれた部屋から種類を判定する。
 *   車 4.8×2.2m / 食卓椅子 0.5×0.55（曲線が多い） / ベッド 1.0〜1.7×2.0 / 便器 0.4×0.7 / 浴槽 1.4×0.7
 *   洗面ボウル 0.7×0.4（D 形） / キッチンのシンク 0.5×0.6 ＋ コンロの輪（0.29×0.06 の弧） / 植栽（ぎざぎざの丸）
 * 認識した家具は自動配置より優先して、図面どおりの位置・向きに置く。
 */
import type { FurnitureItem, FurnitureKind, Room, RoomType, Vec2, Wall } from '../core/types';
import { distPointSegment, pointInPolygon } from '../core/geometry';
import type { Seg } from './walls';

export type SymbolKind = 'car' | 'chair' | 'chairBack' | 'sofaModule' | 'sofa' | 'bed' | 'toilet' | 'bath' | 'sink' | 'counter' | 'plant';

export interface PlanSymbol {
  kind: SymbolKind;
  /** 中心 (mm) */
  x: number;
  y: number;
  /** 外形 (mm) */
  w: number;
  h: number;
  /** 線の数 */
  n: number;
  /** いちばん長い直線（洗面の平らな側・ベッドの頭側の判定に使う） */
  flat?: { a: Vec2; b: Vec2 };
  /** 判定の参考値（でこぼこ・短い線の割合・最長の直線 mm） */
  bump?: number;
  shortFrac?: number;
  longLen?: number;
}

interface Cluster {
  segs: Seg[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 端点のつながる細い線をまとめる */
export function clusterSegments(segs: Seg[], maxLen = 2500, minN = 12): Cluster[] {
  const use = segs.filter((s) => s.source !== 'fill' && !s.dashed && Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) < maxLen);
  const key = (q: Vec2) => `${Math.round(q.x / 4)},${Math.round(q.y / 4)}`;
  const parent = use.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const at = new Map<string, number>();
  use.forEach((s, i) => {
    for (const q of [s.a, s.b]) {
      const k = key(q);
      const j = at.get(k);
      if (j == null) at.set(k, i);
      else {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  });
  const groups = new Map<number, Seg[]>();
  use.forEach((s, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(s);
  });
  const out: Cluster[] = [];
  for (const g of groups.values()) {
    if (g.length < minN) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of g) {
      for (const q of [s.a, s.b]) {
        if (q.x < minX) minX = q.x;
        if (q.x > maxX) maxX = q.x;
        if (q.y < minY) minY = q.y;
        if (q.y > maxY) maxY = q.y;
      }
    }
    out.push({ segs: g, minX, minY, maxX, maxY });
  }
  return out;
}

const within = (v: number, lo: number, hi: number) => v >= lo && v <= hi;

/** 線のまとまりを記号として分類する（部屋の情報は使わず形だけで） */
export function detectSymbols(segs: Seg[]): PlanSymbol[] {
  const clusters = clusterSegments(segs, 3400, 4);
  const out: PlanSymbol[] = [];
  for (const c of clusters) {
    const w = c.maxX - c.minX;
    const h = c.maxY - c.minY;
    const L = Math.max(w, h);
    const S = Math.min(w, h);
    if (L < 40 || L > 6000) continue;
    const n = c.segs.length;
    if (n < 12) {
      // 線の少ないまとまり: キッチンのカウンター（2.0〜3.4m × 0.6〜1.05m の長方形）だけを見る
      if (n > 24 || !within(L, 1800, 3400) || !within(S, 550, 1050)) continue;
      let onBorder = 0;
      let total = 0;
      for (const s of c.segs) {
        const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
        total += len;
        const horiz = Math.abs(s.b.y - s.a.y) < 5;
        const vert = Math.abs(s.b.x - s.a.x) < 5;
        if (horiz && (Math.abs(s.a.y - c.minY) < 20 || Math.abs(s.a.y - c.maxY) < 20)) onBorder += len;
        else if (vert && (Math.abs(s.a.x - c.minX) < 20 || Math.abs(s.a.x - c.maxX) < 20)) onBorder += len;
      }
      if (total > 0 && onBorder / total >= 0.9 && onBorder >= (w + h) * 2 * 0.9) out.push({ kind: 'counter', x: (c.minX + c.maxX) / 2, y: (c.minY + c.maxY) / 2, w, h, n });
      continue;
    }
    const lens = c.segs.map((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y));
    const shortFrac = lens.filter((l) => l < 60).length / n;
    const longest = c.segs[lens.indexOf(Math.max(...lens))];
    const longLen = Math.max(...lens);
    const longCount = lens.filter((l) => l >= L * 0.72).length;
    const cx = (c.minX + c.maxX) / 2;
    const cy = (c.minY + c.maxY) / 2;
    // 輪郭の「でこぼこ」: 中心からの距離のばらつき（円・丸い角の四角は小さく、植栽のぎざぎざは大きい）
    const rs = c.segs.map((s) => Math.hypot(s.a.x - cx, s.a.y - cy));
    const rMean = rs.reduce((a, r) => a + r, 0) / rs.length;
    const bump = Math.sqrt(rs.reduce((a, r) => a + (r - rMean) ** 2, 0) / rs.length) / (rMean || 1);
    const base = { x: cx, y: cy, w, h, n, flat: { a: longest.a, b: longest.b } };
    let kind: SymbolKind | null = null;
    if (within(L, 4300, 5300) && within(S, 1600, 2350) && n >= 50) kind = 'car';
    else if (within(L, 270, 310) && within(S, 40, 70) && n >= 14 && shortFrac > 0.8) kind = 'chairBack';
    else if (within(L, 400, 720) && within(S, 330, 720) && n >= 55 && shortFrac > 0.55 && bump > 0.08) kind = 'chair';
    else if (within(L, 1900, 2150) && (within(S, 940, 1120) || within(S, 1350, 1800)) && n >= 16 && longLen >= L * 0.3) kind = 'bed';
    else if (within(L, 1300, 1750) && within(S, 640, 860) && n >= 16 && n <= 60 && longLen >= L * 0.5) kind = 'bath';
    else if (within(L, 580, 740) && within(S, 350, 430) && n >= 16 && longLen >= S * 0.8) kind = 'toilet';
    else if (within(L, 540, 740) && within(S, 440, 560) && n >= 12 && n <= 60 && shortFrac > 0.3) kind = 'sink';
    else if (within(L, 1800, 4600) && within(S, 720, 2300) && n >= 40 && n <= 200 && shortFrac > 0.6 && within(bump, 0.1, 0.3)) kind = 'sofa';
    else if (n >= 80 && within(L, 300, 2800) && S / L >= 0.7 && shortFrac > 0.7 && within(bump, 0.03, 0.5)) kind = 'plant';
    if (!kind) continue;
    void longCount;
    out.push({ kind, ...base, bump: +bump.toFixed(3), shortFrac: +shortFrac.toFixed(2), longLen: Math.round(longLen) } as PlanSymbol);
  }
  // 椅子: 背もたれの弧（0.29×0.06）がすぐそば／背まで含んだ密な記号／同じ大きさのものが少し離れて並ぶ（食卓の周り）。
  // 同じ大きさのものがぴったり隣り合う（隙間 12cm 以下）ならソファのモジュール
  const backs = out.filter((s) => s.kind === 'chairBack');
  const seats = out.filter((s) => s.kind === 'chair');
  for (const s of seats) {
    const back = backs.find((b) => Math.hypot(b.x - s.x, b.y - s.y) < 280);
    if (back) {
      s.flat = { a: { x: s.x, y: s.y }, b: { x: back.x, y: back.y } };
      continue;
    }
    if (s.n >= 200) continue;
    const size = Math.max(s.w, s.h);
    const same = seats.filter((o) => o !== s && Math.abs(Math.max(o.w, o.h) - size) < 40 && Math.abs(Math.min(o.w, o.h) - Math.min(s.w, s.h)) < 40);
    const adjacent = same.some((o) => Math.hypot(o.x - s.x, o.y - s.y) < size + 120);
    const grouped = same.some((o) => Math.hypot(o.x - s.x, o.y - s.y) < 1500);
    if (adjacent) s.kind = 'sofaModule';
    else if (!grouped) s.kind = s.n >= 130 ? 'plant' : 'chairBack';
  }
  // 「植物」に回したものは、ぎざぎざ（でこぼこ）が無ければ捨てる
  for (const s of out) if (s.kind === 'plant' && (s.bump ?? 0) < 0.03) s.kind = 'chairBack';
  // 車の外形の中にある部品（タイヤなど）は捨てる
  const cars = out.filter((s) => s.kind === 'car');
  return out.filter((s) => s.kind === 'car' || !cars.some((car) => Math.abs(s.x - car.x) < car.w / 2 && Math.abs(s.y - car.y) < car.h / 2));
}

export interface ExteriorSymbols {
  /** 車（中心・向きの角度）。rot: 図面の +x 方向から時計回り（度） */
  cars: { x: number; y: number; rot: number }[];
  /** 植栽（中心・半径 mm） */
  trees: { x: number; y: number; r: number }[];
}

const DEG = 180 / Math.PI;

/**
 * 記号 → 家具（図面どおりの位置と向き）と外構。
 * 家具の基準点は「壁側の辺の中央」（FurnitureItem の決まり）なので、記号の中心から奥行き分だけ戻して求める。
 */
export function symbolsToItems(symbols: PlanSymbol[], rooms: Room[], walls: Wall[], outline: Vec2[][], level: number, trace?: string[]): { items: FurnitureItem[]; exterior: ExteriorSymbols } {
  const items: FurnitureItem[] = [];
  const exterior: ExteriorSymbols = { cars: [], trees: [] };
  let seq = 0;
  const id = () => `ps${level}_${++seq}`;
  const roomAt = (p: Vec2) => rooms.find((r) => pointInPolygon(p, r.polygon));
  const inside = (p: Vec2) => outline.some((l) => pointInPolygon(p, l));
  const wallDist = (p: Vec2) => (walls.length ? Math.min(...walls.map((w) => distPointSegment(p, w.a, w.b))) : Infinity);
  const unit = (x: number, y: number) => {
    const l = Math.hypot(x, y) || 1;
    return { x: x / l, y: y / l };
  };
  /** 単位ベクトル n の向きで、中心から dist 離れた点が壁に近い方（n か -n）を選ぶ */
  const towardWall = (c: Vec2, n: Vec2, dist: number): Vec2 => {
    const p1 = { x: c.x + n.x * dist, y: c.y + n.y * dist };
    const p2 = { x: c.x - n.x * dist, y: c.y - n.y * dist };
    return wallDist(p1) <= wallDist(p2) ? n : { x: -n.x, y: -n.y };
  };
  /** 並び方向 along と部屋側 inward から rot（度）。along = (cos r, sin r), inward = (-sin r, cos r) */
  const rotOf = (along: Vec2, inward: Vec2) => {
    let r = Math.atan2(along.y, along.x) * DEG;
    // inward が along を +90° 回した向きになるように（違えば along を反転）
    const cross = along.x * inward.y - along.y * inward.x;
    if (cross < 0) r += 180;
    return Math.round(((r % 360) + 360) % 360);
  };
  /** その種類の家具があり得る部屋か（車庫の車の部品・玄関の靴箱などの誤認を避ける） */
  const ALLOWED: Partial<Record<FurnitureKind, RoomType[]>> = {
    toilet: ['toilet', 'washroom', 'other'],
    bath: ['bath', 'washroom', 'other'],
    washstand: ['washroom', 'toilet', 'bath', 'hall', 'other', 'entrance'],
    bed: ['bedroom', 'kids', 'japanese', 'study', 'other'],
    sofa: ['ldk', 'living', 'dining', 'japanese', 'bedroom', 'study', 'other'],
    dining: ['ldk', 'living', 'dining', 'kitchen', 'japanese', 'study', 'other'],
    kitchen: ['ldk', 'kitchen', 'dining', 'living', 'japanese', 'study', 'storage', 'other'],
  };
  const push = (kind: FurnitureKind, c: Vec2, along: Vec2, inward: Vec2, back: number, extra: Partial<FurnitureItem> = {}, roomPoint?: Vec2) => {
    const room = roomAt(roomPoint ?? c);
    if (!room) {
      trace?.push(`drop ${kind}@${Math.round(c.x)},${Math.round(c.y)}: no room`);
      return null;
    }
    const ok = ALLOWED[kind];
    if (ok && !ok.includes(room.type)) {
      trace?.push(`drop ${kind}@${Math.round(c.x)},${Math.round(c.y)}: room ${room.name}/${room.type}`);
      return null;
    }
    const origin = { x: c.x - inward.x * back, y: c.y - inward.y * back };
    const it: FurnitureItem = { id: id(), kind, x: Math.round(origin.x), y: Math.round(origin.y), rot: rotOf(along, inward), roomId: room.id, ...extra };
    items.push(it);
    return it;
  };
  const perp = (v: Vec2) => ({ x: -v.y, y: v.x });
  const axisLong = (s: PlanSymbol) => (s.w >= s.h ? { x: 1, y: 0 } : { x: 0, y: 1 });

  // 車・植栽（建物の外）。部屋の中にある「車の大きさの丸い形」は L 型ソファ
  for (const s of symbols) {
    if (s.kind === 'car') {
      const a = axisLong(s);
      const room = roomAt({ x: s.x, y: s.y });
      if (!inside({ x: s.x, y: s.y }) || room?.type === 'garage') {
        if (level === 1) exterior.cars.push({ x: Math.round(s.x), y: Math.round(s.y), rot: Math.round(Math.atan2(a.y, a.x) * DEG) });
      } else if (room && Math.max(s.w, s.h) <= 4600) s.kind = 'sofa';
    } else if (s.kind === 'plant') {
      const c = { x: s.x, y: s.y };
      const r = Math.round(Math.max(s.w, s.h) / 2);
      if (!inside(c)) {
        if (level === 1) exterior.trees.push({ x: Math.round(c.x), y: Math.round(c.y), r });
      } else {
        const room = roomAt(c);
        if (room && r <= 700) items.push({ id: id(), kind: 'plant', x: Math.round(c.x), y: Math.round(c.y), rot: 0, roomId: room.id, w: +Math.min(1.3, Math.max(0.5, r / 350)).toFixed(2) });
      }
    }
  }

  // 食卓: 椅子の集まり（互いに 1.4m 以内）→ 中心に食卓、並び方向は椅子の広がる方向
  const chairs = symbols.filter((s) => s.kind === 'chair');
  const usedChair = new Set<PlanSymbol>();
  for (const ch of chairs) {
    if (usedChair.has(ch)) continue;
    const group: PlanSymbol[] = [ch];
    usedChair.add(ch);
    for (let i = 0; i < group.length; i++) for (const o of chairs) if (!usedChair.has(o) && Math.hypot(o.x - group[i].x, o.y - group[i].y) < 1400) { usedChair.add(o); group.push(o); }
    if (group.length < 2) continue;
    const cx = group.reduce((a, g) => a + g.x, 0) / group.length;
    const cy = group.reduce((a, g) => a + g.y, 0) / group.length;
    // 椅子 2 脚だけなら、食卓として扱うのは LDK・ダイニングに限る（書斎の机の椅子などを食卓にしない）
    if (group.length < 3 && !['ldk', 'dining', 'kitchen', 'living'].includes(roomAt({ x: cx, y: cy })?.type ?? 'other')) continue;
    // 椅子に囲まれた長方形（テーブル）があれば、その中心と向き・長さを使う
    const table = symbols.find((s) => s.kind === 'counter' && Math.abs(s.x - cx) < 700 && Math.abs(s.y - cy) < 700 && Math.min(s.w, s.h) < 1100);
    if (table) {
      const a = axisLong(table);
      push('dining', { x: table.x, y: table.y }, a, perp(a), 0, { w: +Math.min(2.6, Math.max(1.4, Math.max(table.w, table.h) / 1000)).toFixed(2) });
      usedChair.add(table); // 使用済み（キッチンのカウンターとして使わない）
      continue;
    }
    // 主軸（広がりの大きい方向）
    let sxx = 0, syy = 0, sxy = 0;
    for (const g of group) { sxx += (g.x - cx) ** 2; syy += (g.y - cy) ** 2; sxy += (g.x - cx) * (g.y - cy); }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let along = unit(Math.cos(th), Math.sin(th));
    // 椅子が 2 列（テーブルの両側）なら、列の方向が並び方向: 列と直交する方向の広がりが小さい
    if (Math.abs(along.x) > Math.abs(along.y)) along = { x: 1, y: 0 }; else along = { x: 0, y: 1 };
    const perSide = Math.max(2, Math.ceil(group.length / 2));
    push('dining', { x: cx, y: cy }, along, perp(along), 0, { w: +Math.min(2.4, Math.max(1.5, perSide * 0.65 + 0.3)).toFixed(2) });
  }

  // ソファ: モジュールの並び
  const mods = symbols.filter((s) => s.kind === 'sofaModule');
  const usedMod = new Set<PlanSymbol>();
  for (const m of mods) {
    if (usedMod.has(m)) continue;
    const group: PlanSymbol[] = [m];
    usedMod.add(m);
    for (let i = 0; i < group.length; i++) for (const o of mods) if (!usedMod.has(o) && Math.hypot(o.x - group[i].x, o.y - group[i].y) < 760) { usedMod.add(o); group.push(o); }
    if (group.length < 2) continue;
    const xs = group.map((g) => g.x), ys = group.map((g) => g.y);
    const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
    const along = spanX >= spanY ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const c = { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 };
    const back = towardWall(c, perp(along), 450);
    const inward = { x: -back.x, y: -back.y };
    const w = Math.max(spanX, spanY) + 600;
    push('sofa', c, along, inward, 450, { w: +Math.min(3.6, Math.max(1.6, w / 1000)).toFixed(2) });
  }
  for (const s of symbols) {
    const c = { x: s.x, y: s.y };
    switch (s.kind) {
      case 'sofa': {
        if (roomAt(c)?.type === 'garage' || !inside(c)) {
          trace?.push(`skip sofa@${Math.round(c.x)},${Math.round(c.y)} ${Math.round(s.w)}x${Math.round(s.h)}: outside`);
          break;
        }
        const along = axisLong(s);
        const back = towardWall(c, perp(along), 450);
        push('sofa', c, along, { x: -back.x, y: -back.y }, 450, { w: +Math.min(3.6, Math.max(1.6, Math.max(s.w, s.h) / 1000)).toFixed(2) });
        break;
      }
      case 'bed': {
        const long = axisLong(s);
        const head = towardWall(c, long, 1000);
        const inward = { x: -head.x, y: -head.y };
        push('bed', c, perp(inward), inward, 1000, { w: +(Math.min(s.w, s.h) / 1000).toFixed(2) });
        break;
      }
      case 'toilet': {
        const long = axisLong(s);
        // D 形（タンク側が平らな辺）ならその向き、そうでなければ壁に近い側がタンク
        let tank = towardWall(c, long, 350);
        const f = s.flat;
        if (f && Math.hypot(f.b.x - f.a.x, f.b.y - f.a.y) >= Math.min(s.w, s.h) * 0.8) {
          const mid = { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 };
          const d = unit(mid.x - c.x, mid.y - c.y);
          if (Math.abs(d.x * long.x + d.y * long.y) > 0.7) tank = d;
        }
        const inward = { x: -tank.x, y: -tank.y };
        push('toilet', c, perp(inward), inward, 375);
        break;
      }
      case 'bath': {
        const along = axisLong(s);
        const wallSide = towardWall(c, perp(along), 400);
        push('bath', c, along, { x: -wallSide.x, y: -wallSide.y }, 400, { len: +(Math.max(s.w, s.h) / 1000).toFixed(2) });
        break;
      }
    }
  }

  // キッチン: シンクを手がかりに。シンクのすぐ後ろに壁があれば壁付け（前に平行なアイランドのカウンターがあれば対面型）、
  // 壁から離れたカウンターの上にあればアイランド型
  const counters = symbols.filter((s) => s.kind === 'counter' && !usedChair.has(s));
  const usedCounter = new Set<PlanSymbol>();
  const KITCHEN_NG: RoomType[] = ['toilet', 'bath', 'washroom', 'garage', 'balcony', 'porch', 'void', 'stairs', 'closet', 'entrance', 'hall'];
  for (const sink of symbols.filter((s) => s.kind === 'sink')) {
    const c = { x: sink.x, y: sink.y };
    const room = roomAt(c);
    if (!room || KITCHEN_NG.includes(room.type)) continue;
    // 同じキッチンの 2 つ目のシンク（ダブルシンクなど）
    if (items.some((it) => it.kind === 'kitchen' && Math.hypot(it.x - c.x, it.y - c.y) < 2600)) continue;
    const onCounter = counters.find((k) => !usedCounter.has(k) && Math.abs(sink.x - k.x) <= k.w / 2 + 80 && Math.abs(sink.y - k.y) <= k.h / 2 + 80);
    // 近い壁（シンク中心から 0.7m 以内なら壁付けのカウンター）。前にアイランドのある壁を優先し、無ければいちばん近い壁
    const nearWalls = walls
      .map((w) => ({ w, d: distPointSegment(c, w.a, w.b) }))
      .filter((o) => o.d <= 700)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    trace?.push(`sink@${Math.round(c.x)},${Math.round(c.y)} room=${room.name} walls=${nearWalls.map((o) => Math.round(o.d)).join('/')} onCounter=${onCounter ? `${Math.round(onCounter.w)}x${Math.round(onCounter.h)}` : 'no'}`);
    const plans = nearWalls.map((near) => {
      const w = near.w;
      let along = unit(w.b.x - w.a.x, w.b.y - w.a.y);
      if (Math.abs(along.x) > Math.abs(along.y)) along = { x: Math.sign(along.x), y: 0 }; else along = { x: 0, y: Math.sign(along.y) };
      const pn = perp(along);
      const side = (c.x - w.a.x) * pn.x + (c.y - w.a.y) * pn.y;
      let inward = side >= 0 ? pn : { x: -pn.x, y: -pn.y };
      // 壁の内側の面の上にシンクの足元を取る
      const t = (c.x - w.a.x) * along.x + (c.y - w.a.y) * along.y;
      const foot = { x: w.a.x + along.x * t + inward.x * (w.thickness / 2), y: w.a.y + along.y * t + inward.y * (w.thickness / 2) };
      // 前に平行なアイランド（奥行 0.75〜1.1m・長さ 1.6m 以上）があれば対面型
      const island = counters.find((k) => {
        if (usedCounter.has(k) || k === onCounter) return false;
        const depth = Math.min(k.w, k.h);
        const length = Math.max(k.w, k.h);
        if (depth < 750 || depth > 1150 || length < 1600) return false;
        const alongK = k.w >= k.h ? { x: 1, y: 0 } : { x: 0, y: 1 };
        if (Math.abs(alongK.x * along.x + alongK.y * along.y) < 0.9) return false;
        const dv = (k.x - foot.x) * inward.x + (k.y - foot.y) * inward.y;
        const du = (k.x - foot.x) * along.x + (k.y - foot.y) * along.y;
        return dv > 900 && dv < 2500 && Math.abs(du) < length / 2 + 400;
      });
      return { w, along, inward, foot, island };
    });
    const chosen = plans.find((p) => p.island) ?? plans[0];
    if (chosen) {
      let { along } = chosen;
      const { inward, foot, island } = chosen;
      // 並びの向き: コンロはシンクから見て壁沿いに空きの多い側
      const free = (sg: number) => wallDist({ x: foot.x + along.x * sg * 1300 + inward.x * 300, y: foot.y + along.y * sg * 1300 + inward.y * 300 });
      const stoveSign = free(1) >= free(-1) ? 1 : -1;
      const cross = along.x * inward.y - along.y * inward.x;
      // rot の決まりでは inward = along を +90° 回した向き。逆なら along を反転して、コンロ側の符号も合わせる
      let sg = stoveSign;
      if (cross < 0) {
        along = { x: -along.x, y: -along.y };
        sg = -sg;
      }
      const stoveSide: 'left' | 'right' = sg > 0 ? 'right' : 'left';
      if (island) {
        usedCounter.add(island);
        if (onCounter) usedCounter.add(onCounter);
        const length = Math.max(island.w, island.h);
        const len = +Math.min(3.4, Math.max(2.2, (length + 400) / 1000)).toFixed(2);
        const du = (island.x - foot.x) * along.x + (island.y - foot.y) * along.y;
        const dv = (island.x - foot.x) * inward.x + (island.y - foot.y) * inward.y;
        const origin = { x: foot.x + along.x * du, y: foot.y + along.y * du };
        push('kitchen', origin, along, inward, 0, { len, kitchenType: 'peninsula', stoveSide, fridge: 'none', d: +(dv / 1000).toFixed(2) }, c);
      } else {
        if (onCounter) usedCounter.add(onCounter);
        const length = onCounter ? Math.max(onCounter.w, onCounter.h) : 2150;
        const len = +Math.min(3.4, Math.max(2.2, (length + 400) / 1000)).toFixed(2);
        // シンクが図面の位置に来るように中心をずらす（シンクは中心から コンロと反対側に cw/2-0.6）
        const cw = Math.min(len - 0.3, 3.0);
        const du = onCounter ? (onCounter.x - foot.x) * along.x + (onCounter.y - foot.y) * along.y : sg * (cw / 2 - 0.6) * 1000;
        const origin = { x: foot.x + along.x * du, y: foot.y + along.y * du };
        const it = push('kitchen', origin, along, inward, 0, { len, kitchenType: 'wall', stoveSide, fridge: 'none' }, c);
        trace?.push(`kitchen wall → ${it ? 'ok' : 'rejected'} origin=${Math.round(origin.x)},${Math.round(origin.y)}`);
      }
      continue;
    }
    if (!onCounter) continue;
    // アイランド: カウンターの長手が並び方向。部屋側はラベルのある側
    usedCounter.add(onCounter);
    const ct = onCounter;
    let along = axisLong(ct);
    const pn = perp(along);
    const rc = room.labelPos;
    const side = (rc.x - ct.x) * pn.x + (rc.y - ct.y) * pn.y;
    const inward = side >= 0 ? pn : { x: -pn.x, y: -pn.y };
    const cross = along.x * inward.y - along.y * inward.x;
    if (cross < 0) along = { x: -along.x, y: -along.y };
    const su = (sink.x - ct.x) * along.x + (sink.y - ct.y) * along.y;
    const stoveSide: 'left' | 'right' = su > 0 ? 'left' : 'right';
    const len = +Math.min(3.4, Math.max(2.2, (Math.max(ct.w, ct.h) + 400) / 1000)).toFixed(2);
    let back = 1520;
    let found = false;
    for (let t = 1000; t <= 2600; t += 50) {
      if (wallDist({ x: ct.x - inward.x * t, y: ct.y - inward.y * t }) < 110) {
        back = t;
        found = true;
        break;
      }
    }
    push('kitchen', { x: ct.x, y: ct.y }, along, inward, back, { len, kitchenType: found ? 'peninsula' : 'island', stoveSide, fridge: 'none', d: +(back / 1000).toFixed(2) }, c);
  }
  return { items, exterior };
}
