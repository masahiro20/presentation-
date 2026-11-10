/**
 * 玄関ドアは 1 つ。
 *
 * 1 階の外壁の開き戸は、図面では玄関ドアのほかに「勝手口」「ガレージの通用口」「門扉（塀の戸）」がある。
 * ぜんぶ玄関ドアにすると、3D で庇とポーチが 2〜3 か所に付き、見積の玄関ドアも増える（酒井様: 3 か所、有元様: 2 か所）。
 * いちばん玄関らしい 1 つだけを玄関ドアに残し、残りは
 *   - 家の中へ入る戸 → 勝手口（kind 'door' ＋ service。庇・ポーチなし）
 *   - 両側とも屋外の戸（塀・袖壁の門扉）→ 開口（戸の無い通り口）
 * にする。
 */
import { OUTDOOR_TYPES, type Opening, type Room, type RoomType, type Vec2, type Wall } from '../core/types';
import { pointInPolygon } from '../core/geometry';

export interface EntranceFloorLike {
  walls: Wall[];
  openings: Opening[];
  rooms: Room[];
  outline: Vec2[][];
}

/** 戸の内側になりうる区画（ガレージは屋外の扱いの型だが、通用口の内側になる） */
const isIndoor = (r: Room | null): r is Room => !!r && r.type !== 'void' && (r.type === 'garage' || r.type === 'shed' || !OUTDOOR_TYPES.includes(r.type));

/** 戸の両側（壁の法線の ＋ 側・− 側）の部屋と、外形の内か */
export function doorSides(f: EntranceFloorLike, w: Wall, o: Opening): { plus: Room | null; minus: Room | null; plusIn: boolean; minusIn: boolean } {
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
  const ux = (w.b.x - w.a.x) / L;
  const uy = (w.b.y - w.a.y) / L;
  const c = { x: w.a.x + ux * ((o.t0 + o.t1) / 2), y: w.a.y + uy * ((o.t0 + o.t1) / 2) };
  const off = w.thickness / 2 + 250;
  const at = (sg: number) => {
    const p = { x: c.x - uy * sg * off, y: c.y + ux * sg * off };
    return { room: f.rooms.find((r) => r.polygon.length >= 3 && pointInPolygon(p, r.polygon)) ?? null, inside: f.outline.some((l) => pointInPolygon(p, l)) };
  };
  const p = at(1);
  const m = at(-1);
  return { plus: p.room, minus: m.room, plusIn: p.inside, minusIn: m.inside };
}

/** 玄関らしさ: 戸の内側の部屋の種類から（玄関 > ホール > LDK > 名前の無い室内 > 個室・水まわり・収納 > ガレージ > 両側とも屋外） */
const ROOM_SCORE: Partial<Record<RoomType, number>> = { entrance: 100, hall: 60, ldk: 40, living: 40, dining: 40, other: 30, stairs: 30, garage: 5 };

export type ExteriorDoorRole = 'entrance' | 'service' | 'gate';

export function exteriorDoorRole(f: EntranceFloorLike, w: Wall, o: Opening): { role: ExteriorDoorRole; score: number } {
  const s = doorSides(f, w, o);
  const indoor = [s.plus, s.minus].filter(isIndoor);
  // 両側とも屋外（部屋が無く外形の外・ポーチ・テラス）→ 塀・袖壁の門扉
  if (!indoor.length && !(s.plusIn && !s.plus) && !(s.minusIn && !s.minus)) return { role: 'gate', score: 0 };
  let score = indoor.length ? Math.max(...indoor.map((r) => ROOM_SCORE[r.type] ?? 10)) : 30;
  const width = o.t1 - o.t0;
  if (width >= 750 && width <= 1400) score += 10;
  else if (width < 700) score -= 10;
  // 外側がポーチなら玄関らしい
  if ([s.plus, s.minus].some((r) => r?.type === 'porch')) score += 15;
  score += (o.confidence ?? 0.5) * 5;
  return { role: score >= 30 ? 'entrance' : 'service', score };
}

/** この階の玄関ドア（kind 'entrance'）を 1 つに絞る。戻り値: 勝手口・開口に変えた数 */
export function chooseEntrance(f: EntranceFloorLike): { service: number; gate: number } {
  const cands = f.openings
    .filter((o) => o.kind === 'entrance')
    .map((o) => {
      const w = f.walls.find((x) => x.id === o.wallId);
      return w ? { o, w, ...exteriorDoorRole(f, w, o) } : null;
    })
    .filter((c): c is NonNullable<typeof c> => !!c);
  const out = { service: 0, gate: 0 };
  if (!cands.length) return out;
  const best = cands.filter((c) => c.role === 'entrance').sort((a, b) => b.score - a.score)[0] ?? null;
  for (const c of cands) {
    if (c === best) continue;
    if (c.role === 'gate') {
      c.o.kind = 'open';
      c.o.height = 2000;
      out.gate++;
      continue;
    }
    c.o.kind = 'door';
    c.o.height = 2000;
    c.o.service = true;
    // 勝手口は外開き（3D も外開きで作るので、図面・方眼の表記もそろえる）
    if (c.w.outsideSign) c.o.swingSide = c.w.outsideSign;
    out.service++;
  }
  return out;
}
