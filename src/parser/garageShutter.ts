/**
 * ビルトインガレージの「壁の無い辺」= シャッターの開口。
 * 図面ではシャッターは壁として描かれないので、読み取った区画のその辺には壁が無い。壁だけから部屋を作り直すと
 * ガレージが閉じず消えてしまい、3D にもシャッターが出ない。ここで、その辺に外壁とシャッターの開口を足して、
 * 「壁＋開口」の普通の形にそろえる（読み取り直後と、方眼で描き直すときの両方で呼ぶ）。
 */
import type { Opening, Room, Vec2, Wall } from '../core/types';
import { distPointSegment, pointInPolygon } from '../core/geometry';

const MIN_EDGE = 1500;

/** 辺の中点の近く（150mm）に、その辺とほぼ平行な壁があるか */
function hasWallAlong(a: Vec2, b: Vec2, walls: Wall[]): boolean {
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / L;
  const uy = (b.y - a.y) / L;
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const q1 = { x: a.x + ux * L * 0.25, y: a.y + uy * L * 0.25 };
  const q2 = { x: a.x + ux * L * 0.75, y: a.y + uy * L * 0.75 };
  for (const w of walls) {
    const wl = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const wx = (w.b.x - w.a.x) / wl;
    const wy = (w.b.y - w.a.y) / wl;
    if (Math.abs(wx * uy - wy * ux) > 0.1) continue; // 平行でない
    const near = (p: Vec2) => distPointSegment(p, w.a, w.b) < 150;
    if (near(m) || (near(q1) && near(q2))) return true;
  }
  return false;
}

/**
 * ビルトインガレージの壁の無い辺に、外壁とシャッターの開口を足す（walls・openings を書き換える）。
 * 戻り値は足した数。離れ・後付けのガレージは 3D 側（buildAnnexRoof）が壁の無い辺にシャッターを描くので対象外
 */
export function ensureGarageShutters(walls: Wall[], openings: Opening[], rooms: Room[], level: number): number {
  let added = 0;
  const thick = walls.length ? [...walls].sort((p, q) => p.thickness - q.thickness)[Math.floor(walls.length / 2)].thickness : 120;
  for (const r of rooms) {
    if (r.type !== 'garage' || (r.garageKind && r.garageKind !== 'builtin')) continue;
    const poly = r.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < MIN_EDGE || hasWallAlong(a, b, walls)) continue;
      // 辺の外側（ガレージの反対側）に他の部屋があれば、それは内部の仕切り（壁が無い＝つながっている）なので足さない
      const ux = (b.x - a.x) / L;
      const uy = (b.y - a.y) / L;
      const leftN = { x: -uy, y: ux };
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const leftIn = pointInPolygon({ x: mid.x + leftN.x * 300, y: mid.y + leftN.y * 300 }, poly);
      const outSide = leftIn ? -1 : 1;
      const outPt = { x: mid.x + leftN.x * outSide * 400, y: mid.y + leftN.y * outSide * 400 };
      if (rooms.some((q) => q !== r && pointInPolygon(outPt, q.polygon))) continue;
      let k = 1;
      while (walls.some((w) => w.id === `F${level}-GS${k}`)) k++;
      const id = `F${level}-GS${k}`;
      walls.push({ id, a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, thickness: thick, exterior: true, outsideSign: outSide as 1 | -1, joinedA: true, joinedB: true });
      openings.push({ id: `${id}-SH`, wallId: id, kind: 'shutter', t0: 80, t1: L - 80, sill: 0, height: 2300, hingeAtStart: true, swingSide: 1, confidence: 0.8 });
      added++;
    }
  }
  return added;
}
