/**
 * 図面のメモが書かれている場所に、造作を置く位置を決める。
 *
 * 設計士は、造作の近くにメモを書く（「机 W2500〜D500 ほど」「アートなど飾る飾り棚」）。
 * そのメモを取り込むとき、置き場所を 3D でクリックし直さなくても、メモの場所の壁ぎわに置けるようにする。
 *
 *  - メモが部屋の中に書かれているときだけ（部屋の外＝余白に書かれたメモは、どの壁の話か決められない）
 *  - その部屋を囲む壁のうち、造作の幅が入り、窓・戸に掛からない所で、メモにいちばん近い所
 *  - 置いたあとは、ふつうの家具と同じ（ドラッグで動かし、幅・高さを変えられる）
 */
import { distPointSegment, lineIntersect, pointInPolygon } from './geometry';
import type { BuiltinVariant, Floor, FurnitureItem, FurnitureKind, Room, Vec2 } from './types';

export interface MemoPlacement {
  /** 造作の基準点（壁ぎわの中心。mm）と向き（度。家具の rot と同じ決まり） */
  x: number;
  y: number;
  rot: number;
  roomId: string;
  wallId: string;
  /** 置けた幅（m）。壁が短いときは、頼まれた幅より狭くなる */
  w: number;
}

/** メモの文から寸法を読む（「W2500」「D500」「幅 1800」「奥行 450」→ m）。読めなければ省く */
export function sizeFromMemo(text: string): { w?: number; d?: number } {
  const t = text.normalize('NFKC');
  const num = (re: RegExp, lo: number, hi: number): number | undefined => {
    const m = re.exec(t);
    if (!m) return undefined;
    const v = Number(m[1].replace(/,/g, ''));
    return v >= lo && v <= hi ? v / 1000 : undefined;
  };
  const w = num(/(?:W|幅|巾|間口)\s*[=:]?\s*(\d{1,2},?\d{3}|\d{3,4})/i, 400, 6000);
  const d = num(/(?:D|奥行き?)\s*[=:]?\s*(\d{3,4})/i, 150, 1200);
  return { ...(w ? { w } : {}), ...(d ? { d } : {}) };
}

/** 壁のうち、窓・戸に掛からない区間（mm。端から pad だけ内側） */
function freeSpans(L: number, openings: { t0: number; t1: number }[], pad: number): [number, number][] {
  const cuts = openings
    .map((o) => [Math.min(o.t0, o.t1) - pad, Math.max(o.t0, o.t1) + pad] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let s = pad;
  for (const [a, b] of cuts) {
    if (a > s) out.push([s, Math.min(a, L - pad)]);
    s = Math.max(s, b);
  }
  if (L - pad > s) out.push([s, L - pad]);
  return out.filter(([a, b]) => b - a > 1);
}

/**
 * メモの位置（mm）に近い、造作を置ける壁ぎわを探す。
 * @param widthM 造作の幅（m）
 * @param maxD この距離（mm）より遠い壁には置かない
 */
export function placeForMemo(f: Floor, at: Vec2, widthM: number, maxD = 2600): MemoPlacement | null {
  const room = f.rooms.find((r) => r.type !== 'void' && r.type !== 'stairs' && pointInPolygon(at, r.polygon));
  if (!room) return null;
  const want = Math.max(400, widthM * 1000);
  let best: (MemoPlacement & { score: number }) | null = null;
  for (const w of f.walls) {
    // 腰壁・袖壁の上（低い壁）には置かない
    if (w.topMm != null && w.topMm < 1800) continue;
    if (distPointSegment(at, w.a, w.b) > maxD) continue;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (L < 500) continue;
    const u = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
    const tq = Math.max(0, Math.min(L, (at.x - w.a.x) * u.x + (at.y - w.a.y) * u.y));
    const q = { x: w.a.x + u.x * tq, y: w.a.y + u.y * tq };
    let n = { x: -u.y, y: u.x };
    if ((at.x - q.x) * n.x + (at.y - q.y) * n.y < 0) n = { x: -n.x, y: -n.y };
    // 窓・戸に掛からない区間のうち、幅が入る所で、メモにいちばん近い所
    const spans = freeSpans(L, f.openings.filter((o) => o.wallId === w.id), 60);
    for (const [a, b] of spans) {
      const fit = Math.min(want, b - a);
      // 幅が半分も入らない所には置かない（別の物になってしまう）
      if (fit < Math.max(400, want * 0.6)) continue;
      const t = Math.max(a + fit / 2, Math.min(b - fit / 2, tq));
      const c = { x: w.a.x + u.x * t, y: w.a.y + u.y * t };
      // その壁ぎわが、メモの部屋の側に面していること（壁の向こうの部屋に置かない）
      const probe = { x: c.x + n.x * (w.thickness / 2 + 250), y: c.y + n.y * (w.thickness / 2 + 250) };
      if (!pointInPolygon(probe, room.polygon)) continue;
      // 幅を縮めた分は少し不利に（同じくらいの近さなら、頼まれた幅が入る壁を選ぶ）
      const score = Math.hypot(c.x - at.x, c.y - at.y) + (want - fit) * 0.5;
      if (best && score >= best.score) continue;
      const off = w.thickness / 2 + 5;
      // Frame の向き: along = (cos r, sin r)、inward = (-sin r, cos r)。inward を壁から部屋側へ
      const along = { x: n.y, y: -n.x };
      best = { x: Math.round(c.x + n.x * off), y: Math.round(c.y + n.y * off), rot: Math.round((Math.atan2(along.y, along.x) * 180) / Math.PI), roomId: room.id, wallId: w.id, w: +(fit / 1000).toFixed(2), score };
    }
  }
  if (!best) return null;
  const { score: _score, ...rest } = best;
  void _score;
  return rest;
}

/** 造作の形ごとに、「同じ役目」とみなす、図面から読めている家具 */
const FAMILY: Record<BuiltinVariant, { kinds: FurnitureKind[]; variants: BuiltinVariant[] }> = {
  counter: { kinds: ['desk'], variants: ['counter', 'shelfDesk'] },
  shelfDesk: { kinds: ['desk'], variants: ['counter', 'shelfDesk'] },
  floatTv: { kinds: ['tv'], variants: ['floatTv'] },
  wallShelf: { kinds: ['bookshelf', 'cabinet'], variants: ['wallShelf', 'tallStorage', 'lowShelf', 'openShelf'] },
  tallStorage: { kinds: ['bookshelf', 'cabinet'], variants: ['wallShelf', 'tallStorage', 'lowShelf', 'openShelf'] },
  lowShelf: { kinds: ['bookshelf', 'cabinet'], variants: ['wallShelf', 'tallStorage', 'lowShelf', 'openShelf'] },
  openShelf: { kinds: ['bookshelf', 'cabinet'], variants: ['wallShelf', 'tallStorage', 'lowShelf', 'openShelf'] },
  bench: { kinds: [], variants: ['bench'] },
};

/**
 * メモのそばに、同じ役目の家具がすでに読めているか（「机 W2500〜D500 ほど」のそばの机、「TV 周り作りこむ」のそばのテレビ台）。
 * あれば、そのメモはその家具の説明なので、新しく置かずに、その家具を造作に置き換える（位置・向きはそのまま、寸法はメモから）。
 * @param dimsOf 家具の外形（m。幅 w・奥行 d）。scene/furniture.ts の furnitureDims
 */
export function relatedItem(items: FurnitureItem[], at: Vec2, roomId: string | undefined, variant: BuiltinVariant, dimsOf: (it: FurnitureItem) => { w: number; d: number }, maxD = 1700): FurnitureItem | null {
  const fam = FAMILY[variant];
  let best: { it: FurnitureItem; d: number } | null = null;
  for (const it of items) {
    if (roomId && it.roomId && it.roomId !== roomId) continue;
    const same = it.kind === 'builtin' ? fam.variants.includes(it.variant ?? 'wallShelf') : fam.kinds.includes(it.kind);
    if (!same) continue;
    const { w, d } = dimsOf(it);
    const r = (it.rot * Math.PI) / 180;
    const dx = at.x - it.x;
    const dy = at.y - it.y;
    const u = dx * Math.cos(r) + dy * Math.sin(r);
    const v = -dx * Math.sin(r) + dy * Math.cos(r);
    // 家具の外形（壁ぎわの中心が基準。幅 w・奥行 d）からの距離
    const dist = Math.hypot(Math.max(Math.abs(u) - (w * 1000) / 2, 0), Math.max(-v, v - d * 1000, 0));
    if (dist <= maxD && (!best || dist < best.d)) best = { it, d: dist };
  }
  return best?.it ?? null;
}

/**
 * 壁ぎわの家具を幅 widthM に広げるとき、部屋からはみ出さない位置と幅（基準点を壁に沿ってずらし、入らなければ縮める）
 * @returns 新しい基準点（mm）と幅（m）
 */
export function fitAlongWall(room: Pick<Room, 'polygon'>, it: { x: number; y: number; rot: number }, widthM: number): { x: number; y: number; w: number } {
  const r = (it.rot * Math.PI) / 180;
  const along = { x: Math.cos(r), y: Math.sin(r) };
  const inward = { x: -Math.sin(r), y: Math.cos(r) };
  const want = widthM * 1000;
  // 壁から 150 mm 部屋に入った線の上で、基準点から左右にどこまで部屋の中か（50 mm 刻み）
  const reach = (sign: 1 | -1) => {
    let ok = 0;
    for (let t = 50; t <= want; t += 50) {
      if (!pointInPolygon({ x: it.x + along.x * sign * t + inward.x * 150, y: it.y + along.y * sign * t + inward.y * 150 }, room.polygon)) break;
      ok = t;
    }
    return ok;
  };
  const plus = reach(1);
  const minus = reach(-1);
  const pad = 30;
  if (plus + minus < 400) return { x: it.x, y: it.y, w: widthM };
  const w = Math.min(want, plus + minus - pad * 2);
  // 片側が足りなければ、足りない分だけ反対へずらす
  let shift = 0;
  if (plus - pad < w / 2) shift = plus - pad - w / 2;
  else if (minus - pad < w / 2) shift = w / 2 - (minus - pad);
  return { x: Math.round(it.x + along.x * shift), y: Math.round(it.y + along.y * shift), w: +(w / 1000).toFixed(2) };
}

/**
 * 壁ぎわの家具が見える立ち位置（mm）。部屋の中の候補（200 mm 刻み）から、家具がいちばんよく見える所を選ぶ:
 *  - 家具の中央と両端が、壁・背の高い家具にさえぎられずに見える（中央は必ず）
 *  - 幅が画角に収まる距離に近く、正面に近い（入らなければ斜めから）
 * （L 字の部屋で、袖壁の向こうから見て壁しか写らない・本棚の裏に立つ、ということがあった）
 * @param at 家具の基準点（壁ぎわの中心）と向き
 * @returns 立つ位置と、家具までの距離（m）
 */
export function viewpointFor(
  f: Pick<Floor, 'walls'>,
  room: Pick<Room, 'polygon'> | null | undefined,
  at: { x: number; y: number; rot: number },
  widthM: number,
  /** 視線をさえぎる背の高い家具の外形（本棚・壁面収納・冷蔵庫など。mm の多角形）。その中・すぐそばにも立たない */
  blockers: Vec2[][] = [],
): { x: number; y: number; back: number } {
  const r = (at.rot * Math.PI) / 180;
  const along = { x: Math.cos(r), y: Math.sin(r) };
  const inward = { x: -Math.sin(r), y: Math.cos(r) };
  // 幅が画角に収まる距離（最低 1.8 m・最大 4 m）
  const want = Math.min(4000, Math.max(1800, widthM * 850 + 900));
  const half = Math.max(0, (widthM * 1000) / 2 - 150);
  // 見る先: 家具の手前 300 mm の、中央と両端
  const targets = [0, -half, half].map((u) => ({ x: at.x + along.x * u + inward.x * 300, y: at.y + along.y * u + inward.y * 300 }));
  const walls = f.walls.filter((w) => w.topMm == null || w.topMm >= 1200);
  const edges: [Vec2, Vec2][] = [...walls.map((w) => [w.a, w.b] as [Vec2, Vec2]), ...blockers.flatMap((poly) => poly.map((q, i) => [q, poly[(i + 1) % poly.length]] as [Vec2, Vec2]))];
  const blocked = (a: Vec2, b: Vec2) =>
    edges.some(([p0, p1]) => {
      const hit = lineIntersect(a, { x: b.x - a.x, y: b.y - a.y }, p0, { x: p1.x - p0.x, y: p1.y - p0.y });
      return !!hit && hit.t > 0.02 && hit.t < 0.98 && hit.u >= 0 && hit.u <= 1;
    });
  const inFurniture = (p: Vec2) => blockers.some((poly) => pointInPolygon(p, poly) || poly.some((q, i) => distPointSegment(p, q, poly[(i + 1) % poly.length]) < 350));
  const nearEdge = (p: Vec2) => !!room && room.polygon.some((q, i) => distPointSegment(p, q, room.polygon[(i + 1) % room.polygon.length]) < 250);
  let best: { p: Vec2; score: number; dist: number } | null = null;
  const consider = (p: Vec2) => {
    if (room && (!pointInPolygon(p, room.polygon) || nearEdge(p))) return;
    if (inFurniture(p)) return;
    const dx = p.x - at.x;
    const dy = p.y - at.y;
    const front = dx * inward.x + dy * inward.y;
    // 家具の真横・後ろには立たない
    if (front < 700) return;
    const dist = Math.hypot(dx, dy);
    if (dist > 6000) return;
    const seen = targets.map((t) => !blocked(p, t));
    if (!seen[0]) return;
    const n = seen.filter(Boolean).length;
    const swing = Math.acos(Math.min(1, front / dist)) / (Math.PI / 2);
    const score = n * 10 - Math.abs(dist - want) / 500 - swing * 4;
    if (!best || score > best.score + 1e-9) best = { p, score, dist };
  };
  // 正面の線の上（今までどおりの立ち位置）を先に見る: 同じ点数なら正面
  for (let k = want; k >= 900; k -= 100) consider({ x: at.x + inward.x * k, y: at.y + inward.y * k });
  if (room) {
    const xs = room.polygon.map((q) => q.x);
    const ys = room.polygon.map((q) => q.y);
    for (let x = Math.min(...xs) + 100; x < Math.max(...xs); x += 200) for (let y = Math.min(...ys) + 100; y < Math.max(...ys); y += 200) consider({ x, y });
  }
  const b = best as { p: Vec2; score: number; dist: number } | null;
  if (b) return { x: Math.round(b.p.x), y: Math.round(b.p.y), back: +(b.dist / 1000).toFixed(2) };
  return { x: Math.round(at.x + inward.x * 1000), y: Math.round(at.y + inward.y * 1000), back: 1 };
}
