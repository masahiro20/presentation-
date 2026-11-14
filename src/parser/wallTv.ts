/**
 * 壁掛けテレビの記号を読む（平面図）。
 *
 * ARCHITREND の初回プランは、壁掛けのテレビを「壁に平行な、細長い四角」（厚み 20〜80・長さ 1.0〜2.2m。角は丸いこともある）で、
 * 壁の面から少し離して描く。斜めの壁に掛けるときは、四角も斜め（御社のご提案: 大崎様邸。LDK の斜めの外壁に壁掛けのテレビ。
 * ツールは縦・横の四角しか家具の候補にしないので読めず、ソファの向かいに何も無い壁が残っていた）。
 *
 * 台（テレビボード）のある描き方は奥行 300〜550 の四角で、context.ts が読む。ここは台の無い、板 1 枚の描き方だけ。
 */
import type { FurnitureItem, Opening, Room, RoomType, Stair, Vec2, Wall } from '../core/types';
import { pointInPolygon } from '../core/geometry';

export interface TvSeg {
  a: Vec2;
  b: Vec2;
  dashed?: boolean;
  source?: string;
}

/** 細長い四角（どの向きでも）: 中心・長手の向き（単位）・長さ・厚み */
export interface ThinRect {
  c: Vec2;
  u: Vec2;
  L: number;
  S: number;
}

/**
 * 線分の集まりから、細長い四角（長辺 2 本が平行で、厚み minS〜maxS、長さ minL〜maxL。両端が短い線で閉じている）を拾う。
 * 縦・横・斜めを問わない。角の丸い四角（短辺が細かい線の連なり）も拾う
 */
export function findThinRects(segs: TvSeg[], minL = 1000, maxL = 2200, minS = 20, maxS = 80): ThinRect[] {
  const longs: { a: Vec2; b: Vec2; u: Vec2; L: number }[] = [];
  const shorts: { a: Vec2; b: Vec2 }[] = [];
  for (const g of segs) {
    if (g.dashed || g.source === 'fill') continue;
    const L = Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y);
    if (L >= minL - 60 && L <= maxL) longs.push({ a: g.a, b: g.b, u: { x: (g.b.x - g.a.x) / L, y: (g.b.y - g.a.y) / L }, L });
    else if (L <= maxS + 4) shorts.push({ a: g.a, b: g.b });
  }
  const out: ThinRect[] = [];
  for (let i = 0; i < longs.length; i++) {
    const A = longs[i];
    for (let j = i + 1; j < longs.length; j++) {
      const B = longs[j];
      if (Math.abs(A.L - B.L) > 45) continue;
      const cross = A.u.x * B.u.y - A.u.y * B.u.x;
      if (Math.abs(cross) > 0.02) continue;
      // B の両端の、A の線からの離れ（厚み）と、A に沿った位置
      const same = A.u.x * B.u.x + A.u.y * B.u.y > 0;
      const b0 = same ? B.a : B.b;
      const b1 = same ? B.b : B.a;
      const off = (p: Vec2) => (p.x - A.a.x) * -A.u.y + (p.y - A.a.y) * A.u.x;
      const pos = (p: Vec2) => (p.x - A.a.x) * A.u.x + (p.y - A.a.y) * A.u.y;
      const S = Math.abs(off(b0));
      if (S < minS || S > maxS || Math.abs(off(b0) - off(b1)) > 4) continue;
      if (Math.abs(pos(b0)) > 45 || Math.abs(pos(b1) - A.L) > 45) continue;
      // 両端が閉じている: 端の真ん中のそば（厚みの 0.75 倍 + 12 以内）に、両端とも収まる短い線がある（1 本の短辺、または丸い角の細かい線）
      const closed = (p: Vec2, q: Vec2) => {
        const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        const rad = S * 0.75 + 12;
        return shorts.some((sg) => Math.hypot(sg.a.x - m.x, sg.a.y - m.y) <= rad && Math.hypot(sg.b.x - m.x, sg.b.y - m.y) <= rad);
      };
      if (!closed(A.a, b0) || !closed(A.b, b1)) continue;
      const c = { x: (A.a.x + A.b.x + b0.x + b1.x) / 4, y: (A.a.y + A.b.y + b0.y + b1.y) / 4 };
      const L = Math.max(A.L, B.L, Math.abs(pos(b1) - pos(b0)));
      if (L < minL) continue;
      if (out.some((r) => Math.hypot(r.c.x - c.x, r.c.y - c.y) < 30)) continue;
      out.push({ c, u: A.u, L, S });
    }
  }
  return out;
}

/** 壁掛けテレビを置く部屋（居間・寝室・個室） */
const TV_ROOMS: RoomType[] = ['ldk', 'living', 'dining', 'bedroom', 'kids', 'japanese', 'study'];

export interface WallTvResult {
  items: FurnitureItem[];
  trace: string[];
}

/**
 * 細長い四角のうち、壁に平行で、壁の面から 40〜320mm の所にあり、居間・寝室の中で、ソファ・ベッドの正面にあるもの → 壁掛けテレビ。
 * 窓・戸の前にある四角（カーテンボックス・窓台）、階段のそばの四角（吹抜の腰壁の笠木・手すりの線）は除く
 * （有元様邸 3 階: 階段の吹抜の腰壁の笠木が、壁から 70mm の細長い四角で描かれている。テレビではない）
 * @param existing すでに読めている家具（同じ部屋にテレビ台があれば足さない。ソファ・ベッドは「見る人」の手がかり）
 * @param stairs その階の階段の範囲
 */
export function readWallTvs(segs: TvSeg[], walls: Wall[], openings: Opening[], rooms: Room[], existing: FurnitureItem[], level: number, stairs: Pick<Stair, 'minX' | 'minY' | 'maxX' | 'maxY'>[] = []): WallTvResult {
  const items: FurnitureItem[] = [];
  const trace: string[] = [];
  const rects = findThinRects(segs);
  let seq = 0;
  for (const r of rects) {
    const room = rooms.find((rm) => pointInPolygon(r.c, rm.polygon));
    if (!room || !TV_ROOMS.includes(room.type)) continue;
    if (existing.some((it) => it.kind === 'tv' && it.roomId === room.id) || items.some((it) => it.roomId === room.id)) continue;
    // 階段のそば（範囲から 450mm 以内）の細長い四角は、手すり・腰壁の笠木
    if (stairs.some((st) => r.c.x > st.minX - 450 && r.c.x < st.maxX + 450 && r.c.y > st.minY - 450 && r.c.y < st.maxY + 450)) continue;
    // 平行な壁のうち、いちばん近いもの
    let best: { w: Wall; n: Vec2; gap: number; t: number; L: number } | null = null;
    for (const w of walls) {
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (L < 600) continue;
      const wu = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
      if (Math.abs(wu.x * r.u.y - wu.y * r.u.x) > 0.05) continue;
      const t = (r.c.x - w.a.x) * wu.x + (r.c.y - w.a.y) * wu.y;
      // 四角の全長が、壁の区間の中
      if (t - r.L / 2 < -60 || t + r.L / 2 > L + 60) continue;
      const off = (r.c.x - w.a.x) * -wu.y + (r.c.y - w.a.y) * wu.x;
      const gap = Math.abs(off) - w.thickness / 2 - r.S / 2;
      // 壁の面にぴったり付いた細い四角は、壁の脇を走る引戸（アウトセット）・見切りの線
      if (gap < 40 || gap > 320) continue;
      const sgn = off > 0 ? 1 : -1;
      if (!best || gap < best.gap) best = { w, n: { x: -wu.y * sgn, y: wu.x * sgn }, gap, t, L };
    }
    if (!best) continue;
    // その区間・すぐ隣（150mm 以内）に窓・戸があれば、建具まわりの線（カーテンボックス・窓台・開けた引戸）
    if (openings.some((o) => o.wallId === best!.w.id && o.t0 < best!.t + r.L / 2 + 150 && o.t1 > best!.t - r.L / 2 - 150)) continue;
    // 四角の部屋側がすぐ壁（幅 500 未満のすき間）なら、棚板・見切りの線
    const probe = { x: r.c.x + best.n.x * (r.S / 2 + 500), y: r.c.y + best.n.y * (r.S / 2 + 500) };
    if (!pointInPolygon(probe, room.polygon)) continue;
    // 見る人: 同じ部屋のソファ・ベッドが、四角の正面（前へ 1.2〜6.5m・横へ 2.2m 以内）にあること
    const bn = best.n;
    const watched = existing.some((it) => {
      if ((it.kind !== 'sofa' && it.kind !== 'bed') || it.roomId !== room.id) return false;
      const dx = it.x - r.c.x;
      const dy = it.y - r.c.y;
      const fwd = dx * bn.x + dy * bn.y;
      const lat = Math.abs(dx * -bn.y + dy * bn.x);
      return fwd >= 1200 && fwd <= 6500 && lat <= 2200;
    });
    if (!watched) continue;
    // 壁の面の上の点（テレビの背）と、家具の向き（inward = 壁から部屋へ。along は inward を −90° 回した向き）
    const face = best.gap + r.S / 2;
    const back = { x: r.c.x - best.n.x * face, y: r.c.y - best.n.y * face };
    const along = { x: best.n.y, y: -best.n.x };
    const rot = Math.round(((Math.atan2(along.y, along.x) * 180) / Math.PI + 360) % 360);
    items.push({ id: `ptv${level}_${++seq}`, kind: 'tv', mount: 'wall', x: Math.round(back.x), y: Math.round(back.y), rot, roomId: room.id, w: +(r.L / 1000).toFixed(2) });
    trace.push(`${level}F ${room.name}: 壁に平行な細長い四角 ${Math.round(r.S)}×${Math.round(r.L)}（中心 ${Math.round(r.c.x)},${Math.round(r.c.y)}・壁から ${Math.round(best.gap)}）→ 壁掛けテレビ`);
  }
  return { items, trace };
}
