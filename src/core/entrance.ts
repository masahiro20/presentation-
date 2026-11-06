/**
 * 玄関ドアの見つけ方（読み取りチェック・点数・3D の共通の判定）。
 * 図面の玄関ドアは「玄関ドア」と読めるとは限らない: 引戸の玄関（引違いの戸として読める）、
 * ガレージから入る玄関（道路に面した戸が無く、ガレージとの間の戸が出入口）、ポーチに面した開き戸など。
 */
import type { BuildingModel, Floor, Opening, Room } from './types';
import { pointInPolygon } from './geometry';

export type EntranceVia = 'entrance' | 'outside' | 'porch' | 'garage';

export const ENTRANCE_VIA_LABEL: Record<EntranceVia, string> = {
  entrance: '玄関ドア',
  outside: '外に面した戸（玄関ドアとして扱います）',
  porch: 'ポーチに面した戸（玄関ドアとして扱います）',
  garage: 'ガレージから入る玄関（ガレージとの間の戸が出入口）',
};

/** 玄関の区画に面した戸（開き戸・引戸）の反対側が何か */
function otherSideOf(f: Floor, o: Opening, room: Room): { other: Room | null; faces: boolean } {
  const w = f.walls.find((x) => x.id === o.wallId);
  if (!w) return { other: null, faces: false };
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
  const ux = (w.b.x - w.a.x) / L;
  const uy = (w.b.y - w.a.y) / L;
  const c = { x: w.a.x + ux * ((o.t0 + o.t1) / 2), y: w.a.y + uy * ((o.t0 + o.t1) / 2) };
  const off = w.thickness / 2 + 250;
  const at = (sg: number) => {
    const p = { x: c.x - uy * sg * off, y: c.y + ux * sg * off };
    return f.rooms.find((r) => r.polygon.length >= 3 && pointInPolygon(p, r.polygon)) ?? null;
  };
  const p1 = at(1);
  const p2 = at(-1);
  if (p1 === room) return { other: p2, faces: true };
  if (p2 === room) return { other: p1, faces: true };
  return { other: null, faces: false };
}

/**
 * この階の玄関の戸。kind 'entrance' があればそれ。無ければ玄関（entrance 型の区画）の辺にある戸のうち、
 * 反対側が屋外・ポーチ・カーポート・ビルトインガレージのもの
 */
export function entranceDoorOf(f: Floor): { op: Opening; via: EntranceVia; room?: Room } | null {
  const ent = f.openings.find((o) => o.kind === 'entrance');
  if (ent) return { op: ent, via: 'entrance' };
  const rooms = f.rooms.filter((r) => r.type === 'entrance');
  let garage: { op: Opening; via: EntranceVia; room: Room } | null = null;
  for (const r of rooms) {
    for (const o of f.openings) {
      if (o.kind !== 'door' && o.kind !== 'sliding') continue;
      const { other, faces } = otherSideOf(f, o, r);
      if (!faces) continue;
      if (!other || other.type === 'carport' || other.type === 'parking') return { op: o, via: 'outside', room: r };
      if (other.type === 'porch') return { op: o, via: 'porch', room: r };
      if (other.type === 'garage' && (!other.garageKind || other.garageKind === 'builtin') && !garage) garage = { op: o, via: 'garage', room: r };
    }
  }
  return garage;
}

export function hasEntranceDoor(model: BuildingModel): boolean {
  return model.floors.some((f) => !!entranceDoorOf(f));
}
