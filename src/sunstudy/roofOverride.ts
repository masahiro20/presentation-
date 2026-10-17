/**
 * 利用者が直した屋根（NeighborOverride.roof）を PLATEAU の建物にかぶせる。state.ts の effectiveNeighbors から呼ぶ純関数（state は読まない）。
 * 足元の輪郭 ring（ピン基準）から anchor 基準の輪郭を作り、仕様どおりの mesh・高さ・属性にする。同じ入力は同じ結果（キャッシュ）。
 */
import { normalizeSpec, specMesh, specTop } from '../sun/plateau';
import type { PlateauAttrs } from '../sun/plateau';
import { frameToLocal } from './types';
import type { LatLon, Neighbor } from './types';

export type UserRoof = NonNullable<PlateauAttrs['roofEstimate']>;

const round2 = (v: number) => Math.round(v * 100) / 100;
const cache = new Map<string, Neighbor>();
const CACHE_MAX = 600;

export function applyUserRoof(n: Neighbor, spec: UserRoof, pin: LatLon | null): Neighbor {
  const a = n.plateau;
  if (!a || !n.mesh || !pin || n.ring.length < 3) return n;
  const key = `${n.id}|${JSON.stringify(spec)}|${n.ring.length}|${n.ring[0].e.toFixed(2)},${n.ring[0].n.toFixed(2)}|${pin.lat.toFixed(6)},${pin.lon.toFixed(6)}|${n.height}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const off = frameToLocal(pin, a.anchor);
  const ringA = n.ring.map((p) => ({ e: p.e - off.e, n: p.n - off.n }));
  const norm = normalizeSpec({ ...spec, user: true });
  const mesh = specMesh(ringA, norm);
  const out: Neighbor = mesh
    ? { ...n, mesh, height: round2(specTop(norm)), heightKind: 'manual', plateau: { ...a, zmax: a.zmin + specTop(norm), roofEstimate: norm } }
    : n;
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, out);
  return out;
}

/** 屋根の仕様の検査（保存データ・入力欄から）。壊れていれば null */
export function sanitizeUserRoof(raw: unknown): UserRoof | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kinds = ['hip', 'gable', 'shed', 'flat'];
  if (typeof r.kind !== 'string' || !kinds.includes(r.kind)) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const eave = num(r.eave);
  const ridge = num(r.ridge);
  if (eave == null || ridge == null || eave <= 0) return null;
  const out: UserRoof = { kind: r.kind as UserRoof['kind'], eave, ridge: Math.max(ridge, eave), boxHeight: num(r.boxHeight) ?? eave };
  if (r.ridgeDir === 'long' || r.ridgeDir === 'short') out.ridgeDir = r.ridgeDir;
  if (r.highSide === 'N' || r.highSide === 'E' || r.highSide === 'S' || r.highSide === 'W') out.highSide = r.highSide;
  const st = num(r.storeys);
  if (st != null && st > 0) out.storeys = st;
  const fh = num(r.floorH);
  if (fh != null && fh > 0) out.floorH = fh;
  const pp = num(r.parapet);
  if (pp != null && pp >= 0) out.parapet = pp;
  out.user = true;
  return normalizeSpec(out) as UserRoof;
}
