/**
 * ガレージのシャッターの形（1 台／2 台中柱／2 台一体）。
 * 壁の長さから自動で決め、方眼・3D の道具から選び直せる。
 *  - 1 台: 幅 2.5〜3.4m（壁が短ければ壁いっぱい）
 *  - 2 台（中柱）: 中央に 400mm の柱を残して 2 枚（壁 6.4m を超えると既定）
 *  - 2 台（一体）: 壁いっぱいの 1 枚（4.2〜6.4m）
 */
import type { Floor, Opening, Wall } from './types';

export type ShutterLayout = 'single' | 'double' | 'wide';
export const SHUTTER_LAYOUTS: { id: ShutterLayout; label: string; hint: string }[] = [
  { id: 'single', label: '1 台', hint: '幅 3m ほどの 1 枚' },
  { id: 'wide', label: '2 台（一体）', hint: '壁いっぱいの 1 枚（6.4m まで）' },
  { id: 'double', label: '2 台（中柱）', hint: '中央に柱を残して 2 枚' },
];
const EDGE = 80;
const PILLAR = 400;

export function autoShutterLayout(wallLenMm: number): ShutterLayout {
  return wallLenMm < 4200 ? 'single' : wallLenMm <= 6400 ? 'wide' : 'double';
}

/** 今その壁にあるシャッターの形（無ければ null） */
export function shutterLayoutOf(f: Floor, wallId: string): ShutterLayout | null {
  const sh = f.openings.filter((o) => o.wallId === wallId && o.kind === 'shutter');
  if (!sh.length) return null;
  if (sh.length >= 2) return 'double';
  const w = f.walls.find((x) => x.id === wallId);
  const L = w ? Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) : 0;
  return sh[0].t1 - sh[0].t0 >= Math.min(L - EDGE * 2, 4200) - 1 ? 'wide' : 'single';
}

/** 壁の長さ L（mm）に、この形のシャッター開口（t0/t1）を作る */
export function shutterSpans(L: number, layout: ShutterLayout): { t0: number; t1: number }[] {
  const full = L - EDGE * 2;
  if (full < 1500) return [];
  if (layout === 'double' && full >= 2 * 2200 + PILLAR) {
    const each = (full - PILLAR) / 2;
    return [
      { t0: EDGE, t1: EDGE + each },
      { t0: EDGE + each + PILLAR, t1: L - EDGE },
    ];
  }
  if (layout === 'single') {
    const w = Math.min(full, 3400);
    const t0 = EDGE + (full - w) / 2;
    return [{ t0, t1: t0 + w }];
  }
  return [{ t0: EDGE, t1: Math.min(L - EDGE, EDGE + 6400) }];
}

/** その壁のシャッターを、この形に置き直す（他の建具はそのまま）。戻り値は置いた数 */
export function applyShutterLayout(f: Floor, wall: Wall, layout: ShutterLayout, idBase = wall.id): number {
  const L = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y);
  f.openings = f.openings.filter((o) => !(o.wallId === wall.id && o.kind === 'shutter'));
  const spans = shutterSpans(L, layout);
  const height = Math.min(2300, f.ceilingHeight - 100);
  spans.forEach((s, i) => f.openings.push({ id: `${idBase}-SH${i + 1}`, wallId: wall.id, kind: 'shutter', t0: s.t0, t1: s.t1, sill: 0, height, hingeAtStart: true, swingSide: 1, confidence: 1 }));
  return spans.length;
}
