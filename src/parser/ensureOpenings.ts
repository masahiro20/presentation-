/**
 * 戸が読めなかった図面を「木造住宅の常識」で補う（読み取りの自己点検）。
 *
 * 吉田様邸（1101 時点プラン）の正解データで分かったこと:
 *  - 1 階の玄関に外へ出る戸が無い（玄関ドアは読めていなかった）
 *  - ビルトインガレージの道路側の辺が壁として読まれ、シャッターが無い
 *  - 玄関とガレージの間、ホールとトイレの間に戸が無い
 *  - 2 階の洋室 3 室・トイレに戸が 1 つも無い（唯一読めた「引戸」は階段の線の読み違い）
 *
 * ルール（docs/WOOD_HOUSE_RULES.md §9）:
 *  1. 個室・水まわり・収納・ガレージには出入口がある。戸が 1 つも無い部屋は、通路（ホール・玄関・階段・LDK）との壁に戸を置く。
 *     通路に接していなければ、寝室（WIC）・洗面（浴室）など常識的な相手の壁に。
 *  2. ビルトインガレージには車の出入口（シャッター）がある。無ければ、外に面した最も長い辺（壁）に置く。
 *  3. 1 階の玄関には外へ出る戸（玄関ドア）がある。無ければ、ポーチに接する辺 → 外に面した辺の順に置く。
 *  4. ビルトインガレージと玄関（ホール）の間には勝手口の戸がある。
 * 補った戸は confidence 0.5 で、注記に「戸が読めなかったので置きました」と残す（方眼で直せる）。
 */
import type { Opening, Room, RoomType, Vec2, Wall } from '../core/types';
import { pointInPolygon } from '../core/geometry';
import { autoShutterLayout, shutterSpans } from '../core/shutter';
import { ROOM_KNOWLEDGE, doorSwingFor, isCirculation } from './roomKnowledge';

/** 戸が必ず要る部屋の種類 */
const NEEDS_DOOR: RoomType[] = ['bedroom', 'kids', 'study', 'japanese', 'toilet', 'bath', 'washroom', 'closet', 'storage'];
/** 戸の幅（mm）: 収納は引戸、トイレは狭い戸 */
const DOOR_W: Partial<Record<RoomType, number>> = { toilet: 650, bath: 650, closet: 780, storage: 780 };
const MARGIN = 60;

interface Shared {
  wall: Wall;
  /** 壁の a 点からの距離（mm） */
  t0: number;
  t1: number;
  /** 壁の +n 側（n = (-uy, ux)）の部屋 */
  plus: Room | null;
  minus: Room | null;
}

function wallFrame(w: Wall) {
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
  const ux = (w.b.x - w.a.x) / L;
  const uy = (w.b.y - w.a.y) / L;
  return { L, ux, uy, nx: -uy, ny: ux };
}

/** 壁を、両側の部屋の組み合わせが同じ区間に分ける（200mm ごとに両側を調べる） */
function sharedSegments(walls: Wall[], rooms: Room[]): Shared[] {
  const out: Shared[] = [];
  const roomAt = (p: Vec2) => rooms.find((r) => pointInPolygon(p, r.polygon)) ?? null;
  for (const w of walls) {
    const { L, ux, uy, nx, ny } = wallFrame(w);
    if (L < 400) continue;
    const off = w.thickness / 2 + 200;
    let cur: Shared | null = null;
    for (let t = 100; t <= L - 100; t += 200) {
      const p = { x: w.a.x + ux * t, y: w.a.y + uy * t };
      const plus = roomAt({ x: p.x + nx * off, y: p.y + ny * off });
      const minus = roomAt({ x: p.x - nx * off, y: p.y - ny * off });
      if (cur && cur.plus === plus && cur.minus === minus) cur.t1 = Math.min(L, t + 100);
      else {
        cur = { wall: w, t0: Math.max(0, t - 100), t1: Math.min(L, t + 100), plus, minus };
        out.push(cur);
      }
    }
  }
  return out.filter((s) => s.t1 - s.t0 >= 400);
}

/** 区間のうち、既存の開口と重ならない空き（mm）を長い順に */
function freeSpans(s: Shared, openings: Opening[]): { t0: number; t1: number }[] {
  const ops = openings.filter((o) => o.wallId === s.wall.id && o.t1 > s.t0 && o.t0 < s.t1).sort((a, b) => a.t0 - b.t0);
  const spans: { t0: number; t1: number }[] = [];
  let cur = s.t0;
  for (const o of ops) {
    if (o.t0 - MARGIN > cur) spans.push({ t0: cur, t1: o.t0 - MARGIN });
    cur = Math.max(cur, o.t1 + MARGIN);
  }
  if (s.t1 > cur) spans.push({ t0: cur, t1: s.t1 });
  return spans.sort((a, b) => b.t1 - b.t0 - (a.t1 - a.t0));
}

function hasOpeningOn(s: Shared, openings: Opening[]): boolean {
  return openings.some((o) => o.wallId === s.wall.id && o.kind !== 'window' && o.t1 > s.t0 + 50 && o.t0 < s.t1 - 50);
}

function edgeFree(room: Room, other: Room, walls: Wall[], rooms: Room[]): boolean {
  // 壁の無い辺で other とつながっているか（部屋の辺の中点の両側が room と other で、そこに壁が無い）
  const poly = room.polygon;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 500) continue;
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const q1 = { x: m.x - uy * 250, y: m.y + ux * 250 };
    const q2 = { x: m.x + uy * 250, y: m.y - ux * 250 };
    const r1 = rooms.find((r) => pointInPolygon(q1, r.polygon));
    const r2 = rooms.find((r) => pointInPolygon(q2, r.polygon));
    if (!((r1 === room && r2 === other) || (r2 === room && r1 === other))) continue;
    const wallHere = walls.some((w) => {
      const f = wallFrame(w);
      if (Math.abs(f.ux * uy - f.uy * ux) > 0.1) return false;
      const t = (m.x - w.a.x) * f.ux + (m.y - w.a.y) * f.uy;
      if (t < -50 || t > f.L + 50) return false;
      return Math.abs(-(m.x - w.a.x) * f.uy + (m.y - w.a.y) * f.ux) < 150;
    });
    if (!wallHere) return true;
  }
  return false;
}

let seq = 0;
function placeDoor(f: { walls: Wall[]; openings: Opening[] }, s: Shared, span: { t0: number; t1: number }, kind: Opening['kind'], width: number, into: Room | null, level: number): Opening {
  const c = (span.t0 + span.t1) / 2;
  const t0 = Math.max(span.t0, c - width / 2);
  const t1 = Math.min(span.t1, t0 + width);
  // 開く側: into の部屋がある側
  const swingSide: 1 | -1 = into ? (s.plus === into ? 1 : -1) : 1;
  let k = 1;
  while (f.openings.some((o) => o.id === `${s.wall.id}-A${k}`)) k++;
  const op: Opening = { id: `${s.wall.id}-A${k}`, wallId: s.wall.id, kind, t0, t1, sill: 0, height: kind === 'entrance' ? 2300 : 2000, hingeAtStart: true, swingSide, confidence: 0.5 };
  void level;
  void seq;
  f.openings.push(op);
  return op;
}

/**
 * 戸・シャッター・玄関ドアの無い部屋に、常識の位置で補う。戻り値は注記（方眼で直してもらう文）
 */
export function ensureOpenings(walls: Wall[], openings: Opening[], rooms: Room[], level: number): string[] {
  const notes: string[] = [];
  const f = { walls, openings };
  const segs = sharedSegments(walls, rooms);
  const segsOf = (r: Room) => segs.filter((s) => s.plus === r || s.minus === r);
  const other = (s: Shared, r: Room) => (s.plus === r ? s.minus : s.plus);
  const area = (r: Room) => r.area;

  // 2. ビルトインガレージのシャッター
  for (const g of rooms) {
    if (g.type !== 'garage' || (g.garageKind && g.garageKind !== 'builtin')) continue;
    const mine = segsOf(g);
    if (mine.some((s) => openings.some((o) => o.wallId === s.wall.id && o.kind === 'shutter'))) continue;
    // 外に面した区間（反対側に部屋が無い）のうち最も長いもの
    const outer = mine.filter((s) => !other(s, g) && s.t1 - s.t0 >= 2500).sort((a, b) => b.t1 - b.t0 - (a.t1 - a.t0));
    const s = outer[0];
    if (!s) continue;
    const L = s.t1 - s.t0;
    const spans = shutterSpans(L, autoShutterLayout(L));
    spans.forEach((sp, j) => openings.push({ id: `${s.wall.id}-ASH${j + 1}`, wallId: s.wall.id, kind: 'shutter', t0: s.t0 + sp.t0, t1: s.t0 + sp.t1, sill: 0, height: 2300, hingeAtStart: true, swingSide: 1, confidence: 0.5 }));
    if (spans.length) notes.push(`${level}階 ${g.name}: 車の出入口が読めなかったので、外に面した ${Math.round(L).toLocaleString()}mm の辺にシャッターを置きました（違えば方眼の「シャッター」で直せます）`);
  }

  // 3. 玄関の外戸（1 階）
  if (level === 1) {
    for (const e of rooms) {
      if (e.type !== 'entrance') continue;
      const mine = segsOf(e);
      if (mine.some((s) => openings.some((o) => o.wallId === s.wall.id && o.kind === 'entrance' && o.t1 > s.t0 && o.t0 < s.t1))) continue;
      // 外・ポーチ・ビルトインガレージに面した区間に戸（開き戸・引戸）が読めていれば、それが玄関の戸。
      // 外・ポーチに面した開き戸は玄関ドアに（引戸の玄関はそのまま。ガレージから入る玄関はガレージとの戸が出入口）
      const existing = mine
        .map((s) => ({ s, o: other(s, e), door: openings.find((op) => op.wallId === s.wall.id && (op.kind === 'door' || op.kind === 'sliding') && op.t1 > s.t0 + 50 && op.t0 < s.t1 - 50) }))
        .find(({ o, door }) => !!door && (!o || o.type === 'porch' || o.type === 'carport' || (o.type === 'garage' && (!o.garageKind || o.garageKind === 'builtin'))));
      if (existing) {
        const { o, door } = existing;
        if (door!.kind === 'door' && (!o || o.type === 'porch' || o.type === 'carport')) {
          door!.kind = 'entrance';
          door!.height = Math.max(door!.height, 2200);
          delete door!.service;
        }
        continue;
      }
      // 外に面した区間に幅 700 以上の「窓」だけがある玄関: 玄関ドア（袖付き・親子）の記号を窓と読んだものなので玄関ドアにする（伊藤様邸）
      const outer = mine.map((s) => ({ s, o: other(s, e) })).filter(({ o }) => !o || o.type === 'porch' || o.type === 'carport');
      const misread = outer
        .flatMap(({ s }) => openings.filter((op) => op.wallId === s.wall.id && op.kind === 'window' && op.t1 - op.t0 >= 700 && op.t1 > s.t0 + 50 && op.t0 < s.t1 - 50))
        .sort((a, b) => b.t1 - b.t0 - (a.t1 - a.t0))[0];
      if (misread) {
        misread.kind = 'entrance';
        misread.sill = 0;
        misread.height = Math.max(2200, misread.height);
        delete misread.windowStyle;
        notes.push(`${level}階 ${e.name}: 外に面した窓（幅 ${Math.round(misread.t1 - misread.t0).toLocaleString()}）を玄関ドアとして扱いました（違えば方眼で直せます）`);
        continue;
      }
      // ポーチに接する区間 → 外に面した区間。窓のある区間は避け、長い順
      const cand = outer
        .filter(({ o }) => !o || o.type === 'porch')
        .map(({ s, o }) => ({ s, score: (o?.type === 'porch' ? 10000 : 0) + (freeSpans(s, openings)[0]?.t1 ?? 0) - (freeSpans(s, openings)[0]?.t0 ?? 0) }))
        .sort((a, b) => b.score - a.score);
      for (const { s } of cand) {
        const span = freeSpans(s, openings)[0];
        if (!span || span.t1 - span.t0 < 1000) continue;
        const op = placeDoor(f, s, span, 'entrance', 900, null, level);
        // 玄関ドアは外開き（室内側に開くと靴を履く所に扉が来る）: 外側の部屋が無い側へ
        op.swingSide = s.plus === e ? -1 : 1;
        notes.push(`${level}階 ${e.name}: 玄関ドアが読めなかったので、${other(s, e)?.type === 'porch' ? 'ポーチ側' : '外に面した'}壁に置きました（違えば方眼で位置を直せます）`);
        break;
      }
    }
  }

  // 5. 玄関とホールの境（上がり框）: 玄関の土間と家の床の境は框の線で、戸は無い。線が 2 本に読めると壁になり、玄関が閉じた箱になる
  //    （田中様邸・吉田様邸 1st: 玄関とホールの間に 130 の壁が 1 本読まれ、玄関からどこへも行けなかった）。
  //    玄関から通路（ホール・廊下・階段・LDK）へ戸も開口も無く、壁の無い辺でもつながっていなければ、いちばん良い共有区間に開口（戸無し）を置く
  for (const e of rooms) {
    if (e.type !== 'entrance') continue;
    const mine = segsOf(e);
    const inner = mine
      .map((s) => ({ s, o: other(s, e) }))
      .filter((x): x is { s: Shared; o: Room } => !!x.o && x.o.type !== 'porch' && x.o.type !== 'entrance' && (isCirculation(x.o.type) || x.o.type === 'ldk' || x.o.type === 'living' || x.o.type === 'dining'));
    if (!inner.length) continue;
    if (inner.some(({ s }) => hasOpeningOn(s, openings))) continue;
    if (inner.some(({ o }) => edgeFree(e, o, walls, rooms))) continue;
    // 壁を共有しない通路（框の先のホール: 土間との間に壁が無い）に、壁の無い辺でつながっていれば閉じていない
    if (rooms.some((o) => o !== e && o.type !== 'porch' && o.type !== 'entrance' && (isCirculation(o.type) || o.type === 'ldk' || o.type === 'living' || o.type === 'dining') && edgeFree(e, o, walls, rooms))) continue;
    const rank = (o: Room) => (o.type === 'hall' ? 3 : o.type === 'stairs' ? 2 : 1);
    const best = inner
      .map(({ s, o }) => ({ s, o, span: freeSpans(s, openings)[0] }))
      .filter((x): x is { s: Shared; o: Room; span: { t0: number; t1: number } } => !!x.span && x.span.t1 - x.span.t0 >= 800)
      .sort((a, b) => rank(b.o) - rank(a.o) || b.span.t1 - b.span.t0 - (a.span.t1 - a.span.t0))[0];
    if (!best) continue;
    placeDoor(f, best.s, best.span, 'open', Math.min(best.span.t1 - best.span.t0 - MARGIN * 2, 2730), null, level);
    notes.push(`${level}階 ${e.name}: ${best.o.name}との間が壁で閉じていたので、上がり框の位置に開口を置きました（違えば方眼で直せます）`);
  }

  // 1. 戸の無い部屋 / 4. ガレージと玄関の間
  for (const r of rooms) {
    const builtinGarage = r.type === 'garage' && (!r.garageKind || r.garageKind === 'builtin');
    if (!NEEDS_DOOR.includes(r.type) && !builtinGarage) continue;
    if (r.type === 'closet' && area(r) < 1.0) continue; // 小さな物入は折れ戸が読めなくても目立たない
    const mine = segsOf(r);
    if (!mine.length) continue;
    // 既に戸・引戸・開口がある、または壁なしで通路・隣室につながっている部屋はそのまま
    if (mine.some((s) => hasOpeningOn(s, openings))) {
      if (!builtinGarage) continue;
      // ガレージ: シャッター以外（玄関・ホールへの戸。外壁扱いの壁の開き戸は 'entrance' になっている）があるか
      if (mine.some((s) => openings.some((o) => o.wallId === s.wall.id && (o.kind === 'door' || o.kind === 'sliding' || o.kind === 'open' || o.kind === 'entrance') && o.t1 > s.t0 && o.t0 < s.t1))) continue;
    }
    const partners = mine.map((s) => ({ s, o: other(s, r) })).filter(({ o }) => !!o) as { s: Shared; o: Room }[];
    if (!builtinGarage && partners.some(({ o }) => edgeFree(r, o, walls, rooms) && (isCirculation(o.type) || ROOM_KNOWLEDGE[r.type].adjacent.includes(o.type)))) continue;
    // 壁を共有していない相手（間に壁が 1 本も無い）にも、壁の無い辺で開いていることがある: 寝室に開いた収納（前面が細い線の建具・
    // ロールスクリーン）は、寝室との間に壁が無い。そこから入れるので、反対側の壁に戸を補わない
    // （林様邸 1 階: 主寝室の「物入」の裏の壁に、LDK 側から入る戸を補っていた）
    if (!builtinGarage && !(globalThis as { __NO_OPEN_EDGE_ACCESS?: boolean }).__NO_OPEN_EDGE_ACCESS) {
      const isStore = r.type === 'closet' || r.type === 'storage';
      const openTo = rooms.filter((o) => o !== r && o.type !== 'void' && !partners.some((p) => p.o === o) && edgeFree(r, o, walls, rooms));
      if (openTo.some((o) => isCirculation(o.type) || ROOM_KNOWLEDGE[r.type].adjacent.includes(o.type) || (isStore && ['bedroom', 'kids', 'japanese', 'study', 'ldk', 'living', 'dining', 'kitchen', 'washroom', 'entrance'].includes(o.type)))) continue;
    }
    const want = builtinGarage ? ['entrance', 'hall', 'storage'] : null;
    const rank = (o: Room) => {
      if (want) return want.includes(o.type) ? 10 - want.indexOf(o.type) : -1;
      if (isCirculation(o.type)) return 10;
      if (r.type === 'closet' && (o.type === 'bedroom' || o.type === 'kids' || o.type === 'japanese' || o.type === 'washroom')) return 8;
      if (r.type === 'bath' && o.type === 'washroom') return 9;
      if (r.type === 'storage' && (o.type === 'entrance' || o.type === 'ldk' || o.type === 'kitchen')) return 8;
      if (ROOM_KNOWLEDGE[r.type].adjacent.includes(o.type)) return 5;
      if (o.type === 'bath' || o.type === 'toilet' || o.type === 'closet' || o.type === 'storage' || o.type === 'void' || o.type === 'stairs') return -1;
      return 1;
    };
    const width = DOOR_W[r.type] ?? 780;
    const best = partners
      .map(({ s, o }) => ({ s, o, rank: rank(o), span: freeSpans(s, openings).find((sp) => sp.t1 - sp.t0 >= width + MARGIN * 2) }))
      .filter((x) => x.rank >= 0 && x.span)
      .sort((a, b) => b.rank - a.rank || b.span!.t1 - b.span!.t0 - (a.span!.t1 - a.span!.t0))[0];
    if (!best) continue;
    // 収納は幅があれば引戸（折れ戸・引違い）
    const sliding = (r.type === 'closet' || r.type === 'storage') && best.span!.t1 - best.span!.t0 >= 1640 + MARGIN * 2;
    const kind: Opening['kind'] = sliding ? 'sliding' : 'door';
    const sw = doorSwingFor(r.type, best.o.type);
    const into = sw === 'a' ? r : sw === 'b' ? best.o : r;
    placeDoor(f, best.s, best.span!, kind, sliding ? 1640 : width, into, level);
    notes.push(`${level}階 ${r.name}: 戸が読めなかったので、${best.o.name}との壁に${sliding ? '引戸' : '戸'}を置きました（違えば方眼で位置・種類を直せます）`);
  }
  return notes;
}

/**
 * 常識で補ったシャッター（id に ASH）を、敷地の道路側に面した辺へ置き直す。
 * 読み取りの時点では接道が分からないので「最も長い外の辺」に置いており、道路が分かったらこちらで直す。
 */
export function relocateAutoShutters(walls: Wall[], openings: Opening[], rooms: Room[], roadSide: 'top' | 'bottom' | 'left' | 'right', level: number): boolean {
  const auto = openings.filter((o) => o.kind === 'shutter' && /-ASH\d+$/.test(o.id));
  if (!auto.length) return false;
  const segs = sharedSegments(walls, rooms);
  const want = roadSide === 'top' ? { x: 0, y: -1 } : roadSide === 'bottom' ? { x: 0, y: 1 } : roadSide === 'left' ? { x: -1, y: 0 } : { x: 1, y: 0 };
  let moved = false;
  for (const g of rooms) {
    if (g.type !== 'garage' || (g.garageKind && g.garageKind !== 'builtin')) continue;
    const mine = segs.filter((s) => (s.plus === g || s.minus === g) && !(s.plus === g ? s.minus : s.plus) && s.t1 - s.t0 >= 2500);
    const cur = auto.find((o) => mine.some((s) => s.wall.id === o.wallId));
    if (!cur) continue;
    // 外向き（ガレージの反対側）が道路の向きに合う区間
    const facing = mine
      .map((s) => {
        const { nx, ny } = wallFrame(s.wall);
        const out = s.plus === g ? { x: -nx, y: -ny } : { x: nx, y: ny };
        return { s, dot: out.x * want.x + out.y * want.y };
      })
      .filter((x) => x.dot > 0.7)
      .sort((a, b) => b.s.t1 - b.s.t0 - (a.s.t1 - a.s.t0))[0];
    if (!facing || facing.s.wall.id === cur.wallId) continue;
    for (let i = openings.length - 1; i >= 0; i--) if (openings[i].kind === 'shutter' && /-ASH\d+$/.test(openings[i].id) && mine.some((s) => s.wall.id === openings[i].wallId)) openings.splice(i, 1);
    const s = facing.s;
    const L = s.t1 - s.t0;
    shutterSpans(L, autoShutterLayout(L)).forEach((sp, j) => openings.push({ id: `${s.wall.id}-ASH${j + 1}`, wallId: s.wall.id, kind: 'shutter', t0: s.t0 + sp.t0, t1: s.t0 + sp.t1, sill: 0, height: 2300, hingeAtStart: true, swingSide: 1, confidence: 0.5 }));
    moved = true;
  }
  void level;
  return moved;
}
