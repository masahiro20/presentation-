/**
 * 帖数との照合（読み取りの自己点検）
 *
 * 図面の室名には「ＬＤＫ（24.7帖）」のように帖数が書いてある。読み取った区画の面積がそれと大きく違えば、
 * 区画の分かれ方（壁として読んだ線・読めなかった壁）か室名の付け方（小さな物入の名前が大きな区画に付く）が違っている。
 *
 * 池本様邸: ＬＤＫ 24.7 帖が、キッチン側とリビング側を分ける開口付きの壁で 2 区画に読まれ、
 * キッチン側（11.8 帖）に隣の小さな pantry①（2.6 帖）の名前が付いて、ＬＤＫは 15.3 帖になっていた。
 *
 * ルール:
 *  1. 帖数より 28% 以上小さい部屋は、戸・開口でつながる（または壁の無い）隣の区画のうち、
 *     室名が無いか、自分の帖数よりずっと大きく読まれている区画を足すと帖数に合うなら、同じ部屋（同じ名前・種類）にする。
 *     区画（壁）はそのまま残す（壁に開口がある間仕切りなので、3D では開口付きの壁が立つ）。
 *  2. 合わなければ注記にして、方眼で確かめてもらう。
 */
import type { Opening, Room, RoomType, Vec2, Wall } from '../core/types';
import { OUTDOOR_TYPES } from '../core/types';

const TATAMI_M2 = 1.62;
/** 部屋として一続きになり得ない種類 */
const NEVER_JOIN: RoomType[] = ['toilet', 'bath', 'washroom', 'stairs', 'void', 'garage', 'entrance', ...OUTDOOR_TYPES];

export interface TatamiReconcile {
  /** 名前を付け替えた区画（「pantry① → ＬＤＫ」） */
  renamed: { roomId: string; from: string; to: string }[];
  warnings: string[];
}

/** 軸平行の 2 多角形が共有する辺（重なりの長さ mm）。壁芯の多角形なので、同じ線上（60mm 以内）で重なる部分 */
export function sharedEdges(a: Vec2[], b: Vec2[], tol = 60): { p: Vec2; q: Vec2; len: number }[] {
  const out: { p: Vec2; q: Vec2; len: number }[] = [];
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i];
    const a1 = a[(i + 1) % a.length];
    const vertA = Math.abs(a0.x - a1.x) < tol;
    const horzA = Math.abs(a0.y - a1.y) < tol;
    if (!vertA && !horzA) continue;
    for (let j = 0; j < b.length; j++) {
      const b0 = b[j];
      const b1 = b[(j + 1) % b.length];
      if (vertA && Math.abs(b0.x - b1.x) < tol && Math.abs(a0.x - b0.x) < tol) {
        const lo = Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y));
        const hi = Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y));
        if (hi - lo > 300) out.push({ p: { x: a0.x, y: lo }, q: { x: a0.x, y: hi }, len: hi - lo });
      } else if (horzA && Math.abs(b0.y - b1.y) < tol && Math.abs(a0.y - b0.y) < tol) {
        const lo = Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x));
        const hi = Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x));
        if (hi - lo > 300) out.push({ p: { x: lo, y: a0.y }, q: { x: hi, y: a0.y }, len: hi - lo });
      }
    }
  }
  return out;
}

/** 共有する辺の上にある壁と、その壁の開口（戸・引戸・開口）。壁が無ければ「壁なしでつながる」 */
export function connectionAcross(edge: { p: Vec2; q: Vec2 }, walls: Wall[], openings: Opening[]): { wall: boolean; openingLen: number } {
  const vert = Math.abs(edge.p.x - edge.q.x) < 60;
  const lo = vert ? Math.min(edge.p.y, edge.q.y) : Math.min(edge.p.x, edge.q.x);
  const hi = vert ? Math.max(edge.p.y, edge.q.y) : Math.max(edge.p.x, edge.q.x);
  let wallLen = 0;
  let openingLen = 0;
  for (const w of walls) {
    const wVert = Math.abs(w.a.x - w.b.x) < 60;
    if (wVert !== vert) continue;
    const off = vert ? Math.abs(w.a.x - edge.p.x) : Math.abs(w.a.y - edge.p.y);
    if (off > 150) continue;
    const w0 = vert ? Math.min(w.a.y, w.b.y) : Math.min(w.a.x, w.b.x);
    const w1 = vert ? Math.max(w.a.y, w.b.y) : Math.max(w.a.x, w.b.x);
    const ov = Math.min(hi, w1) - Math.max(lo, w0);
    if (ov <= 0) continue;
    wallLen += ov;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    for (const o of openings) {
      if (o.wallId !== w.id || o.kind === 'window' || o.kind === 'shutter') continue;
      // 開口の範囲（壁の始点からの距離）→ 座標
      const s0 = (vert ? w.a.y : w.a.x) + ((vert ? w.b.y - w.a.y : w.b.x - w.a.x) * o.t0) / L;
      const s1 = (vert ? w.a.y : w.a.x) + ((vert ? w.b.y - w.a.y : w.b.x - w.a.x) * o.t1) / L;
      const oo = Math.min(hi, Math.max(s0, s1)) - Math.max(lo, Math.min(s0, s1));
      if (oo > 0) openingLen += oo;
    }
  }
  return { wall: wallLen > (hi - lo) * 0.5, openingLen };
}

/**
 * 帖数と読み取り面積を照合して、分かれてしまった部屋の名前を付け直す。
 * rooms を書き換える（name・type・labeledTatami）。壁・区画は変えない
 */
export function reconcileTatami(rooms: Room[], walls: Wall[], openings: Opening[], level: number): TatamiReconcile {
  const out: TatamiReconcile = { renamed: [], warnings: [] };
  const tatamiOf = (r: Room) => r.area / TATAMI_M2;
  for (const r of rooms) {
    const labeled = r.labeledTatami;
    if (!labeled || labeled < 3 || NEVER_JOIN.includes(r.type)) continue;
    const parsed = tatamiOf(r);
    const short = labeled - parsed;
    if (short < Math.max(2, labeled * 0.28)) continue;
    // 候補: 戸・開口（または壁なし）でつながる隣の区画で、室名が無い／帖数の無い／帖数よりずっと大きく読まれている
    const cands: { room: Room; add: number; conn: { wall: boolean; openingLen: number } }[] = [];
    for (const o of rooms) {
      if (o === r || NEVER_JOIN.includes(o.type)) continue;
      const edges = sharedEdges(r.polygon, o.polygon);
      if (!edges.length) continue;
      const conn = edges.map((e) => connectionAcross(e, walls, openings)).reduce((s, c) => ({ wall: s.wall || c.wall, openingLen: s.openingLen + c.openingLen }), { wall: false, openingLen: 0 });
      if (conn.wall && conn.openingLen < 700) continue; // 壁で仕切られ、人が通る開口が無い
      const oParsed = tatamiOf(o);
      const own = o.labeledTatami;
      const unlabeled = !own || o.inferred || o.name === '室';
      const overread = !!own && oParsed > own * 2 + 1.5;
      if (!unlabeled && !overread) continue;
      // 足す面積: 自分の帖数（小さな物入など）は引いておく
      const add = oParsed - (overread && own ? own : 0);
      cands.push({ room: o, add, conn });
    }
    if (!cands.length) {
      out.warnings.push(`${level}階 ${r.name}: 図面は ${labeled} 帖ですが、読み取った区画は ${parsed.toFixed(1)} 帖です。壁として読んだ線が多いか、区画の分かれ方を方眼で確認してください`);
      continue;
    }
    // いちばん帖数に近づく候補（1 つ、または 2 つの組）
    const tol = Math.max(1.5, labeled * 0.15);
    let best: { set: typeof cands; err: number } | null = null;
    const consider = (set: typeof cands) => {
      const sum = parsed + set.reduce((s, c) => s + c.add, 0);
      const err = Math.abs(sum - labeled);
      if (err <= tol && (!best || err < best.err)) best = { set, err };
    };
    for (const c of cands) consider([c]);
    for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) consider([cands[i], cands[j]]);
    if (!best) {
      out.warnings.push(`${level}階 ${r.name}: 図面は ${labeled} 帖ですが、読み取った区画は ${parsed.toFixed(1)} 帖です。隣の区画（${cands.map((c) => c.room.name).join('・')}）と一続きかもしれません。方眼で確認してください`);
      continue;
    }
    for (const c of (best as { set: typeof cands }).set) {
      const o = c.room;
      const from = o.name;
      const suffix = o.labeledTatami && !o.inferred && o.name !== '室' ? `（${o.name}側）` : '';
      o.name = `${r.name}${suffix}`;
      o.type = r.type;
      o.inferred = false;
      delete o.labeledTatami;
      out.renamed.push({ roomId: o.id, from, to: o.name });
      out.warnings.push(`${level}階: ${from} と読んだ区画（${c.add.toFixed(1)} 帖）は ${r.name}（図面 ${labeled} 帖）の一部として扱いました${suffix ? `。${from} の小さな区画は読み取れていません` : ''}`);
    }
  }
  return out;
}

/**
 * 天井高の注記（「天井高2.6m」「CH=2400」「天井高 3,500」）: その文字が入っている部屋だけの天井高にする。
 * 「天井高低い」「天井低い」（数値なし）は低い物入（1,400）。階の既定（2,400）と同じ値は書かない
 */
export function applyCeilingNotes(rooms: Room[], texts: { str: string; x: number; y: number }[], defaultCh = 2400): { roomId: string; ch: number }[] {
  const out: { roomId: string; ch: number }[] = [];
  const inRoom = (p: Vec2) => rooms.find((r) => r.polygon.length >= 3 && pointInPoly(p, r.polygon));
  for (const t of texts) {
    // 全角の英数字（２．６ｍ・ＣＨ＝）を半角に
    const s = t.str.replace(/[，,]/g, '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    let ch: number | null = null;
    let m = /(?:天井高|天井|CH)\s*[=＝:：]?\s*(\d(?:\.\d+)?)\s*m\b/i.exec(s);
    if (m) ch = Math.round(parseFloat(m[1]) * 1000);
    else if ((m = /(?:天井高|CH)\s*[=＝:：]?\s*(\d{4})\b/i.exec(s))) ch = parseInt(m[1], 10);
    else if (/天井(?:高)?\s*(?:が)?低い/.test(s) && !/物入|収納/.test(s)) ch = null; // 部屋の注記としては使わない（範囲が分からない）
    if (ch == null || ch < 1200 || ch > 6000 || ch === defaultCh) continue;
    const r = inRoom({ x: t.x, y: t.y });
    if (!r || r.type === 'void' || OUTDOOR_TYPES.includes(r.type)) continue;
    r.ceilingHeight = ch;
    out.push({ roomId: r.id, ch });
  }
  return out;
}

function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * 帖数の照合で 1 つの部屋になった LDK の区画に役割を付ける:
 * 図面にキッチンの記号がある区画が「キッチン側」（type ldk。キッチン・食卓を置く）、無い区画が「リビング側」（type living。ソファ・テレビ）。
 * これが無いと、両方が ldk として読まれ、リビング側にもキッチンが置かれていた
 */
export function assignLdkRoles(rooms: Room[], renamed: { roomId: string; from: string; to: string }[], items: { kind: string; roomId?: string }[], texts: { str: string; x: number; y: number }[] = []): string[] {
  const out: string[] = [];
  const kitchenIn = new Set(items.filter((it) => it.kind === 'kitchen' && it.roomId).map((it) => it.roomId!));
  // 記号が読めていなくても、キッチンの幅の注記（W2000・W2550）・キッチン・IH・シンクの文字が入っていればキッチン側
  for (const t of texts) {
    const s = t.str.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    if (!/^W\s?\d{3,4}\b|キッチン|ｷｯﾁﾝ|\bIH\b|シンク|冷蔵庫|食洗/i.test(s)) continue;
    const r = rooms.find((x) => x.type === 'ldk' && pointInPoly({ x: t.x, y: t.y }, x.polygon));
    if (r) kitchenIn.add(r.id);
  }
  for (const rn of renamed) {
    const part = rooms.find((r) => r.id === rn.roomId);
    if (!part || part.type !== 'ldk') continue;
    const base = rn.to.replace(/（.*$/, '');
    const main = rooms.find((r) => r !== part && r.type === 'ldk' && r.name === base);
    if (!main) continue;
    const kp = kitchenIn.has(part.id);
    const km = kitchenIn.has(main.id);
    if (kp === km) continue; // 両方（または両方無し）なら決めない
    const kitchen = kp ? part : main;
    const living = kp ? main : part;
    kitchen.name = `${base}（キッチン側）`;
    kitchen.type = 'ldk';
    living.name = `${base}（リビング側）`;
    living.type = 'living';
    out.push(`${base}: キッチン側（${(kitchen.area / TATAMI_M2).toFixed(1)} 帖）とリビング側（${(living.area / TATAMI_M2).toFixed(1)} 帖）に分けました`);
  }
  return out;
}
