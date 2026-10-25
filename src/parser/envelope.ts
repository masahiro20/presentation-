/**
 * 外皮（外壁のつながり）の後処理。読み取った壁と外形（outline）を突き合わせ、3D で家に穴が開く読み落としを直す。
 *
 * 1. 一部だけ外周に面する内壁を分ける: 長い内壁の一部が外形の辺に重なっている（例: 玄関ポーチの奥で外に面するトイレの壁）と、
 *    壁全体が「内壁」として作られ、外から見ると室内の仕上げが見える。外に面する区間を外壁として切り出す。
 * 2. 外形の辺に壁が無い区間を外壁で補う: 中庭に面した LDK のガラス面・土間収納の外側などで壁の線が読めないと、
 *    外から室内が素通しになる。半間（455）以上の抜けには外壁を足す。LDK・リビングの長い抜けは中庭・庭に面した
 *    掃き出しのガラス面のことが多いので、掃き出し窓を入れる。車庫・カーポート・ポーチの面は開いたままにする（車の出入口）。
 */
import { pointInPolygon } from '../core/geometry';
import type { Floor, Opening, Room, Vec2, Wall } from '../core/types';

const OPEN_SIDE = new Set(['garage', 'carport', 'parking', 'porch', 'deck', 'terrace', 'balcony']);
const GLAZED = new Set(['ldk', 'living', 'dining']);

function insideOutline(p: Vec2, loops: Vec2[][]): boolean {
  return loops.filter((l) => l.length >= 3 && pointInPolygon(p, l)).length % 2 === 1;
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

function roomAt(rooms: Room[], p: Vec2): Room | undefined {
  return rooms.find((r) => pointInPolygon(p, r.polygon));
}

export interface EnvelopeReport {
  split: number;
  added: number;
  addedLen: number;
  glazed: number;
}

export function repairEnvelope(f: Floor): EnvelopeReport {
  const rep: EnvelopeReport = { split: 0, added: 0, addedLen: 0, glazed: 0 };
  const loops = f.outline.filter((l) => l.length >= 3);
  if (!loops.length) return rep;
  const extT = (() => {
    const ts = f.walls.filter((w) => w.exterior).map((w) => w.thickness).sort((a, b) => a - b);
    return ts.length ? ts[Math.floor(ts.length / 2)] : 160;
  })();
  let seq = f.walls.length + 1;
  const newId = () => {
    let id = `F${f.level}-W${seq++}`;
    while (f.walls.some((w) => w.id === id)) id = `F${f.level}-W${seq++}`;
    return id;
  };
  const outsideSide = (w: { a: Vec2; b: Vec2; thickness: number }, t: number): 1 | -1 | 0 => {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    const nx = -uy;
    const ny = ux;
    const p = { x: w.a.x + ux * t, y: w.a.y + uy * t };
    const off = w.thickness / 2 + 120;
    const plusOut = !insideOutline({ x: p.x + nx * off, y: p.y + ny * off }, loops);
    const minusOut = !insideOutline({ x: p.x - nx * off, y: p.y - ny * off }, loops);
    if (plusOut === minusOut) return 0;
    return plusOut ? 1 : -1;
  };

  // 1. 一部だけ外に面する内壁を分ける
  const walls: Wall[] = [];
  for (const w of f.walls) {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (w.exterior || L < 900) {
      walls.push(w);
      continue;
    }
    const step = 100;
    const states: (1 | -1 | 0)[] = [];
    for (let t = step / 2; t < L; t += step) states.push(outsideSide(w, t));
    // 連続区間にまとめる（半間未満の外向き区間は無視）
    const runs: { t0: number; t1: number; s: 1 | -1 | 0 }[] = [];
    states.forEach((s, i) => {
      const t0 = i * step;
      const last = runs[runs.length - 1];
      if (last && last.s === s) last.t1 = Math.min(L, t0 + step);
      else runs.push({ t0, t1: Math.min(L, t0 + step), s });
    });
    for (const r of runs) if (r.s !== 0 && r.t1 - r.t0 < 455) r.s = 0;
    const merged: typeof runs = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && last.s === r.s) last.t1 = r.t1;
      else merged.push({ ...r });
    }
    if (!merged.some((r) => r.s !== 0)) {
      walls.push(w);
      continue;
    }
    // 開口をまたいで切らない: 区間の境目が開口の中にあるときは開口の端へずらす
    const ops = f.openings.filter((o) => o.wallId === w.id);
    for (let i = 1; i < merged.length; i++) {
      let t = merged[i].t0;
      for (const o of ops) if (t > o.t0 && t < o.t1) t = t - o.t0 < o.t1 - t ? o.t0 : o.t1;
      merged[i - 1].t1 = t;
      merged[i].t0 = t;
    }
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    const at = (t: number) => ({ x: Math.round(w.a.x + ux * t), y: Math.round(w.a.y + uy * t) });
    merged
      .filter((r) => r.t1 - r.t0 > 1)
      .forEach((r, i, arr) => {
        const id = i === 0 ? w.id : newId();
        const piece: Wall = {
          ...w,
          id,
          a: at(r.t0),
          b: at(r.t1),
          exterior: r.s !== 0,
          outsideSign: r.s !== 0 ? r.s : undefined,
          joinedA: i === 0 ? w.joinedA : true,
          joinedB: i === arr.length - 1 ? w.joinedB : true,
        };
        if (r.s !== 0) piece.thickness = Math.max(w.thickness, extT);
        walls.push(piece);
        for (const o of ops)
          if (o.t0 >= r.t0 - 1 && o.t1 <= r.t1 + 1) {
            o.wallId = id;
            o.t0 -= r.t0;
            o.t1 -= r.t0;
          }
      });
    rep.split++;
  }
  f.walls = walls;

  // 2. 外形の辺に沿って壁の無い区間を外壁で補う
  const covered = (p: Vec2, ux: number, uy: number) =>
    f.walls.some((w) => {
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
      const par = Math.abs(((w.b.x - w.a.x) / L) * ux + ((w.b.y - w.a.y) / L) * uy);
      return par > 0.97 && segDist(p, w.a, w.b) <= w.thickness / 2 + 90;
    });
  const added: { w: Wall; ops: Opening[] }[] = [];
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 455) continue;
      const ux = (b.x - a.x) / L;
      const uy = (b.y - a.y) / L;
      const step = 50;
      let run: [number, number] | null = null;
      const runs: [number, number][] = [];
      for (let t = 0; t <= L; t += step) {
        const p = { x: a.x + ux * t, y: a.y + uy * t };
        const hole = !covered(p, ux, uy);
        if (hole) {
          if (!run) run = [t, t];
          run[1] = t;
        } else if (run) {
          runs.push(run);
          run = null;
        }
      }
      if (run) runs.push(run);
      for (const [r0, r1] of runs) {
        // 角の近くは隣の辺の壁が受ける（壁厚の半分ほど）。端まで抜けている区間は辺の端までつなぐ
        const t0 = r0 <= step ? 0 : r0 - step;
        const t1 = r1 >= L - step ? L : r1 + step;
        if (t1 - t0 < 455) continue;
        const mid = (t0 + t1) / 2;
        const pm = { x: a.x + ux * mid, y: a.y + uy * mid };
        // 内側の部屋（外形の内向きに 450mm）
        let nx = -uy;
        let ny = ux;
        if (!insideOutline({ x: pm.x + nx * 300, y: pm.y + ny * 300 }, loops)) [nx, ny] = [-nx, -ny];
        const room = roomAt(f.rooms, { x: pm.x + nx * 450, y: pm.y + ny * 450 });
        if (room && OPEN_SIDE.has(room.type)) continue;
        const w: Wall = {
          id: newId(),
          a: { x: Math.round(a.x + ux * t0), y: Math.round(a.y + uy * t0) },
          b: { x: Math.round(a.x + ux * t1), y: Math.round(a.y + uy * t1) },
          thickness: extT,
          exterior: true,
          joinedA: true,
          joinedB: true,
        };
        // 外側の法線の向き（a→b の左 = +1）
        w.outsideSign = -uy * -nx + ux * -ny > 0 ? 1 : -1;
        const ops: Opening[] = [];
        const len = t1 - t0;
        if (room && GLAZED.has(room.type) && len >= 1365) {
          const m = Math.min(455, Math.max(150, len * 0.08));
          ops.push({ id: `${w.id}-O1`, wallId: w.id, kind: 'window', t0: m, t1: len - m, sill: 0, height: 2200, windowStyle: 'hakidashi', confidence: 0.4 });
          rep.glazed++;
        }
        added.push({ w, ops });
        rep.added++;
        rep.addedLen += len;
      }
    }
  }
  for (const { w, ops } of added) {
    f.walls.push(w);
    f.openings.push(...ops);
  }
  return rep;
}
