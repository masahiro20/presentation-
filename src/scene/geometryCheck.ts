/**
 * 間取りデータ（JSON）と 3D の形の照合。読み取りが正しくても、3D に変える途中で形が変わることがあるので、
 * 読み取りの点検とは別に、できた 3D の三角形を間取りと突き合わせる（ブラウザでなくても動く）。
 *   - 階の高さ: 下の階の天端が上の階の床に届いているか（すき間・食い込み）
 *   - 外壁: 外壁の線に沿って、開口以外の所に壁の面があるか（抜け）
 *   - 窓・戸: 間取りの窓・戸が 3D の障子・扉として作られているか（数の照合）
 *   - 階段: 階段の範囲に段の形があるか
 *   - 屋根: 最上階の上に屋根の面があるか
 * 単位: 間取りは mm、3D は m（X = x、Z = y、Y が上）。
 */
import type { BuildingModel } from '../core/types';
import type { BuildingMeta } from './building';
import type { MeshBuilder } from './meshBuilder';

export interface GeometryIssue {
  kind: 'level-gap' | 'wall-hole' | 'window-missing' | 'door-missing' | 'stair-missing' | 'roof-missing';
  level: number;
  detail: string;
}

type Tri = [number, number, number, number, number, number, number, number, number];

function trianglesOf(mb: MeshBuilder, skip: (key: string) => boolean): Tri[] {
  const out: Tri[] = [];
  const buckets = (mb as unknown as { buckets: Map<string, { pos: number[] }> }).buckets;
  for (const [key, b] of buckets) {
    if (skip(key)) continue;
    const p = b.pos;
    for (let i = 0; i + 8 < p.length; i += 9) out.push([p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5], p[i + 6], p[i + 7], p[i + 8]]);
  }
  return out;
}

/** 点から三角形までの距離が tol 以内か（外接箱で先にふるう） */
function nearTri(px: number, py: number, pz: number, t: Tri, tol: number): boolean {
  const minX = Math.min(t[0], t[3], t[6]) - tol;
  const maxX = Math.max(t[0], t[3], t[6]) + tol;
  if (px < minX || px > maxX) return false;
  const minY = Math.min(t[1], t[4], t[7]) - tol;
  const maxY = Math.max(t[1], t[4], t[7]) + tol;
  if (py < minY || py > maxY) return false;
  const minZ = Math.min(t[2], t[5], t[8]) - tol;
  const maxZ = Math.max(t[2], t[5], t[8]) + tol;
  return pz >= minZ && pz <= maxZ;
}

/** extra: 屋根など、建物とは別に作る部品（scene/roof の buildRoofs の mb） */
export function checkBuiltGeometry(model: BuildingModel, built: { mb: MeshBuilder; meta: BuildingMeta }, extra: MeshBuilder[] = []): GeometryIssue[] {
  const out: GeometryIssue[] = [];
  const MM = 0.001;
  const floors = model.floors.slice().sort((a, b) => a.level - b.level);
  // 1. 階の高さ
  floors.forEach((f, i) => {
    const up = floors[i + 1];
    if (!up) return;
    const gap = up.elevation - (f.elevation + f.height);
    if (Math.abs(gap) > 10) out.push({ kind: 'level-gap', level: f.level, detail: `${f.level} 階の床 ${f.elevation}＋階高 ${f.height} と ${up.level} 階の床 ${up.elevation} が ${Math.round(gap)} mm 合いません` });
    const top = built.meta.wallTop[i];
    if (top != null && top < up.elevation * MM - 0.02) out.push({ kind: 'level-gap', level: f.level, detail: `${f.level} 階の外壁の天端（${Math.round(top * 1000)}）が ${up.level} 階の床（${up.elevation}）に届いていません` });
  });
  const skip = (k: string) => /glass|furn|plant|tree|car|ground|grass|site|road|town/i.test(k);
  const tris = [built.mb, ...extra].flatMap((m) => trianglesOf(m, skip));
  // 2. 外壁の抜け（開口の区間を除いて 0.5m ごと、床から 1.2m の高さで、外壁の線から 0.15m 以内に面があるか）
  for (const f of floors) {
    for (const w of f.walls) {
      if (!w.exterior) continue;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (L < 300) continue;
      const ops = f.openings.filter((o) => o.wallId === w.id).map((o) => [o.t0 - 50, o.t1 + 50]);
      let miss = 0;
      let n = 0;
      for (let t = 250; t < L - 250; t += 500) {
        if (ops.some(([a, b]) => t >= a && t <= b)) continue;
        n++;
        const x = (w.a.x + ((w.b.x - w.a.x) * t) / L) * MM;
        const z = (w.a.y + ((w.b.y - w.a.y) * t) / L) * MM;
        const y = (f.elevation + 1200) * MM;
        if (!tris.some((tr) => nearTri(x, y, z, tr, 0.15))) miss++;
      }
      if (miss >= 2) out.push({ kind: 'wall-hole', level: f.level, detail: `${f.level} 階の外壁（長さ ${Math.round(L)} mm）に面の無い所が ${miss}/${n} か所` });
    }
  }
  // 3. 窓・戸
  const sashIds = new Set(built.meta.sashes.map((s) => s.openingId));
  const doorIds = new Set(built.meta.doors.map((d) => d.id));
  for (const f of floors) {
    const windows = f.openings.filter((o) => o.kind === 'window');
    const noSash = windows.filter((o) => !sashIds.has(o.id));
    // 障子を作らない窓（はめ殺しの高窓など）もあるので、半分以上が欠けたときだけ
    if (windows.length && noSash.length > windows.length * 0.5) out.push({ kind: 'window-missing', level: f.level, detail: `${f.level} 階の窓 ${windows.length} か所のうち ${noSash.length} か所に 3D の障子がありません` });
    const doors = f.openings.filter((o) => o.kind === 'door' || o.kind === 'sliding' || o.kind === 'entrance');
    const noDoor = doors.filter((o) => !doorIds.has(o.id));
    if (noDoor.length > Math.max(1, doors.length * 0.3)) out.push({ kind: 'door-missing', level: f.level, detail: `${f.level} 階の戸 ${doors.length} か所のうち ${noDoor.length} か所に 3D の扉がありません` });
  }
  // 4. 階段
  for (const f of floors)
    for (const s of f.stairs) {
      if (!s.goesUp) continue;
      const cx = ((s.minX + s.maxX) / 2) * MM;
      const cz = ((s.minY + s.maxY) / 2) * MM;
      const y0 = f.elevation * MM;
      const y1 = (f.elevation + f.height) * MM;
      const hw = Math.max(0.2, ((s.maxX - s.minX) / 2) * MM - 0.05);
      const hd = Math.max(0.2, ((s.maxY - s.minY) / 2) * MM - 0.05);
      const inside = tris.filter((t) => {
        const mx = (t[0] + t[3] + t[6]) / 3;
        const my = (t[1] + t[4] + t[7]) / 3;
        const mz = (t[2] + t[5] + t[8]) / 3;
        return Math.abs(mx - cx) < hw && Math.abs(mz - cz) < hd && my > y0 + 0.15 && my < y1 - 0.05;
      }).length;
      if (inside < 20) out.push({ kind: 'stair-missing', level: f.level, detail: `${f.level} 階の階段の範囲に段の形がほとんどありません（三角形 ${inside}）` });
    }
  // 5. 屋根（最上階の外形の中心の真上）
  // 最上階の外形にはルーフバルコニー（空に開いた床）が入ることがあるので、屋内のいちばん大きな部屋の真上を見る
  const top = floors[floors.length - 1];
  const indoor = top?.rooms.filter((r) => !['balcony', 'void', 'porch', 'terrace'].includes(r.type)).sort((a, b) => b.area - a.area)[0];
  if (top && indoor) {
    const cx = indoor.labelPos.x * MM;
    const cz = indoor.labelPos.y * MM;
    const wallTop = built.meta.wallTop[floors.length - 1] ?? 0;
    const roofHit = tris.some((t) => {
      const my = (t[1] + t[4] + t[7]) / 3;
      if (my < wallTop - 1.2) return false; // 陸屋根・塔屋は天端（パラペット込み）より低い位置に屋根の面がある
      const minX = Math.min(t[0], t[3], t[6]);
      const maxX = Math.max(t[0], t[3], t[6]);
      const minZ = Math.min(t[2], t[5], t[8]);
      const maxZ = Math.max(t[2], t[5], t[8]);
      return cx >= minX - 0.3 && cx <= maxX + 0.3 && cz >= minZ - 0.3 && cz <= maxZ + 0.3;
    });
    if (!roofHit) out.push({ kind: 'roof-missing', level: top.level, detail: `${top.level} 階の上に屋根の面が見つかりません` });
  }
  return out;
}
