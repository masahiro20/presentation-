/**
 * 階段の中を通る壁の整理
 *
 * 図面の階段には、段の線に重なって細い線が描かれる: 折り返し階段の中壁（手すり壁）、階段下の収納の壁の見えがかり、
 * 切断線の先の点線など。これらを壁として読むと、3D で段の上に壁が立ち、踊り場がふさがる。
 *
 *  - 折り返し（コの字）階段の中壁が、奥の踊り場まで通って読まれている → 踊り場の分だけ切る
 *    （舟橋様邸 2 階・大崎様邸 2 階: 図面の中壁は中央の短い壁だけ）
 *  - 直階段・折り返し階段の段を横切る壁 → 階段の範囲の中の分を切る（田中様邸 1 階）
 *
 * 階段下のトイレ・収納のような「別の部屋を囲む壁」は切らない: 切るのは、両側とも階段（か、階段の吹抜・名前の無い断片）の壁だけ。
 */
import type { Floor, Opening, Room, Stair, Vec2, Wall } from '../core/types';
import { pointInPolygon } from '../core/geometry';

/** 階段の空間とみなす部屋（この種類どうしを仕切る壁は切ってよい） */
const STAIR_SPACE = new Set<Room['type']>(['stairs', 'void']);

const roomAt = (rooms: Room[], p: Vec2): Room | undefined => rooms.find((r) => pointInPolygon(p, r.polygon));

/** 壁 w の区間 [t0, t1]（a からの距離）を切り取る。残りは 1〜2 本の壁になり、切った区間の開口は消える。戻り値: 切ったか */
export function cutWallSegment(f: Floor, w: Wall, t0: number, t1: number): boolean {
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  if (L < 1) return false;
  const c0 = Math.max(0, Math.min(t0, t1));
  const c1 = Math.min(L, Math.max(t0, t1));
  if (c1 - c0 < 100) return false;
  const ux = (w.b.x - w.a.x) / L;
  const uy = (w.b.y - w.a.y) / L;
  const at = (t: number): Vec2 => ({ x: Math.round((w.a.x + ux * t) * 10) / 10, y: Math.round((w.a.y + uy * t) * 10) / 10 });
  const ops = f.openings.filter((o) => o.wallId === w.id);
  const keepA = c0 >= 80;
  const keepB = L - c1 >= 80;
  const dropOps = new Set<Opening>(ops.filter((o) => o.t1 > c0 + 1 && o.t0 < c1 - 1));
  const idx = f.walls.indexOf(w);
  if (idx < 0) return false;
  const out: Wall[] = [];
  if (keepA) out.push({ ...w, b: at(c0), joinedB: false });
  if (keepB) {
    let id = w.id;
    if (keepA) {
      let seq = f.walls.length + 1;
      id = `F${f.level}-W${seq}`;
      while (f.walls.some((q) => q.id === id)) id = `F${f.level}-W${++seq}`;
    }
    out.push({ ...w, id, a: at(c1), joinedA: false });
    for (const o of ops) {
      if (dropOps.has(o) || o.t0 < c1 - 1) continue;
      o.wallId = id;
      o.t0 -= c1;
      o.t1 -= c1;
    }
  }
  if (!keepA && !keepB) for (const o of ops) dropOps.add(o);
  f.walls.splice(idx, 1, ...out);
  if (dropOps.size) f.openings = f.openings.filter((o) => !dropOps.has(o));
  return true;
}

export interface StairWallReport {
  /** 踊り場まで通っていた中壁を切った数 */
  landings: number;
  /** 段を横切る壁を切った数 */
  crossings: number;
}

/**
 * 階段の中を通る壁を整理する（f.walls・f.openings を書き換える）。
 * 内壁で、軸に平行なものだけ。開き戸（円弧の記号がある）の付いた壁は根拠が強いので触らない
 */
export function clearStairWalls(f: Floor): StairWallReport {
  const rep: StairWallReport = { landings: 0, crossings: 0 };
  const INSET = 130;
  for (const st of f.stairs) {
    if (st.kind !== 'u' && st.kind !== 'straight') continue;
    const runY = st.entry === 'n' || st.entry === 's';
    const runLen = runY ? st.maxY - st.minY : st.maxX - st.minX;
    const cross = runY ? st.maxX - st.minX : st.maxY - st.minY;
    if (runLen < 1200 || cross < 700) continue;
    const crossC = runY ? (st.minX + st.maxX) / 2 : (st.minY + st.maxY) / 2;
    // 奥（昇り口の反対側）
    const farAtMin = st.entry === 's' || st.entry === 'e';
    const landing = Math.min(cross / 2, runLen * 0.4);
    // 壁を 1 本ずつ見る（切ると配列が変わるので、先に対象を集める）
    const jobs: { w: Wall; t0: number; t1: number; landing: boolean }[] = [];
    for (const w of f.walls) {
      if (w.exterior) continue;
      const vert = Math.abs(w.a.x - w.b.x) < 30;
      const horz = Math.abs(w.a.y - w.b.y) < 30;
      if (vert === horz) continue;
      // 壁の位置（直交方向）と範囲（軸方向）
      const pos = vert ? (w.a.x + w.b.x) / 2 : (w.a.y + w.b.y) / 2;
      const s0 = vert ? Math.min(w.a.y, w.b.y) : Math.min(w.a.x, w.b.x);
      const s1 = vert ? Math.max(w.a.y, w.b.y) : Math.max(w.a.x, w.b.x);
      const boxPos0 = vert ? st.minX : st.minY;
      const boxPos1 = vert ? st.maxX : st.maxY;
      const boxS0 = vert ? st.minY : st.minX;
      const boxS1 = vert ? st.maxY : st.maxX;
      if (pos <= boxPos0 + INSET || pos >= boxPos1 - INSET) continue;
      const parallel = vert === runY;
      let c0: number;
      let c1: number;
      let isLanding = false;
      if (st.kind === 'u' && parallel && Math.abs(pos - crossC) <= 300) {
        // 中壁: 踊り場の分だけ切る
        const z0 = farAtMin ? boxS0 + 60 : boxS1 - landing;
        const z1 = farAtMin ? boxS0 + landing : boxS1 - 60;
        c0 = Math.max(s0, z0);
        c1 = Math.min(s1, z1);
        isLanding = true;
      } else {
        // 段を横切る壁・段を縦に割る壁: 階段の範囲の中の分を切る
        c0 = Math.max(s0, boxS0 + 60);
        c1 = Math.min(s1, boxS1 - 60);
      }
      if (c1 - c0 < 250) continue;
      // 開き戸の付いた壁は触らない
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      const tOf = (s: number) => {
        const aS = vert ? w.a.y : w.a.x;
        const bS = vert ? w.b.y : w.b.x;
        return ((s - aS) / (bS - aS || 1)) * L;
      };
      const t0 = Math.min(tOf(c0), tOf(c1));
      const t1 = Math.max(tOf(c0), tOf(c1));
      if (f.openings.some((o) => o.wallId === w.id && (o.kind === 'door' || o.kind === 'entrance') && o.t1 > t0 && o.t0 < t1)) continue;
      // 両側とも階段の空間（階段・吹抜・名前の無い所）であること。別の部屋（階段下のトイレ・収納）を囲む壁は残す
      const mid = (c0 + c1) / 2;
      const off = w.thickness / 2 + 180;
      const pA = vert ? { x: pos - off, y: mid } : { x: mid, y: pos - off };
      const pB = vert ? { x: pos + off, y: mid } : { x: mid, y: pos + off };
      const ra = roomAt(f.rooms, pA);
      const rb = roomAt(f.rooms, pB);
      // 室名に「階段」「吹抜」が入る区画（「ホール・階段」のように廊下と一続きに読めた階段、種類の付かない吹抜）も階段の空間
      const ok = (r: Room | undefined) => !r || STAIR_SPACE.has(r.type) || /階段|吹抜|吹き抜け/.test(r.name) || (r.inferred && r.area < 2.5);
      if (!ok(ra) || !ok(rb)) continue;
      jobs.push({ w, t0, t1, landing: isLanding });
    }
    for (const j of jobs) {
      if (!f.walls.includes(j.w)) continue;
      if (cutWallSegment(f, j.w, j.t0, j.t1)) {
        if (j.landing) rep.landings++;
        else rep.crossings++;
      }
    }
  }
  return rep;
}

export type { Stair };
