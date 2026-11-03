/**
 * 箱形の周辺建物（国土地理院・OpenStreetMap。足元の輪郭と推定の高さしか無い）に、住宅らしい推定の屋根をかぶせる。
 * PLATEAU の LOD1 に寄棟をかぶせる roofEstimate.ts と同じ考え方で、three 非依存の純関数。
 *
 *  - 低層住宅らしい足元（最小外接長方形の短辺 3〜15 m・長辺 4〜30 m・面積の 9 割以上が長方形に入る・面積 ≤ 200 ㎡）→ 寄棟。
 *    OSM の building=apartments / 3 階以上 / 大きい足元 → 陸屋根（パラペット）。無壁舎（カーポート）・小さすぎる足元 → 屋根なし。
 *  - 高さの扱い: 推定の高さ（国土地理院 普通建物 7 m など）は「建物の平均的な高さ」とみなし、軒 = 高さ − 立ち上がりの 4 割、棟 = 高さ + 6 割。
 *    実測の高さ（OSM の height タグ）は棟（最高高さ）とみなし、軒 = 高さ − 立ち上がり。
 *  - 立ち上がり = 短辺の半分 × 4 寸勾配（0.4）。0.8〜2.4 m に収める。
 *  - OSM の roof:shape（hipped / gabled / flat / skillion…）があれば形はそれに従う。building:levels があれば階数・階高の目安に。
 */
import { ROOF_ESTIMATE, minAreaRect, normalizeSpec } from '../sun/plateau';
import type { RoofSpec } from '../sun/plateau';
import type { EN } from './types';

export interface BoxRoofHints {
  /** 高さが実測（棟）か推定（平均的な高さ）か */
  heightKind: 'measured' | 'estimated';
  /** OSM の building:levels */
  levels?: number;
  /** OSM の roof:shape */
  roofShape?: string;
  /** OSM の building=*（house / residential / apartments / commercial / industrial / garage / shed …） */
  buildingType?: string;
  /** 国土地理院の種類（無壁舎なら屋根を付けない） */
  label?: string;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function ringArea(ring: EN[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.e * b.n - b.e * a.n;
  }
  return Math.abs(s) / 2;
}

/** OSM の roof:shape → 屋根の形（分からなければ null） */
export function roofKindFromOsm(shape: string | undefined): RoofSpec['kind'] | null {
  if (!shape) return null;
  const s = shape.toLowerCase();
  if (/hip|half-hipped|pyramidal|mansard/.test(s)) return 'hip';
  if (/gable|gambrel/.test(s)) return 'gable';
  if (/skillion|lean_to|mono|shed/.test(s)) return 'shed';
  if (/flat/.test(s)) return 'flat';
  return null;
}

/** 箱形の建物の推定の屋根。付けない建物（無壁舎・小さすぎる・高層）は null */
export function estimateBoxRoof(ring: EN[], height: number, hints: BoxRoofHints): RoofSpec | null {
  if (ring.length < 3 || !(height > 1.5)) return null;
  if (hints.label && /無壁舎|カーポート/.test(hints.label)) return null;
  const type = (hints.buildingType ?? '').toLowerCase();
  if (/garage|shed|carport|roof|hut|greenhouse|service/.test(type)) return null;
  const R = ROOF_ESTIMATE;
  const area = ringArea(ring);
  const rect = minAreaRect(ring);
  const rectOk = !!rect && rect.short >= R.minShort && rect.short <= R.maxShort && rect.long >= R.minLong && rect.long <= R.maxLong && area / (rect.long * rect.short) >= R.minFill;
  const levels = hints.levels && hints.levels > 0 ? Math.round(hints.levels) : undefined;
  const osmKind = roofKindFromOsm(hints.roofShape);
  const apartment = /apartments|dormitory|hotel|office|commercial|retail|industrial|warehouse|school|hospital|public|civic/.test(type);
  const tall = height > R.maxRidge || (levels != null && levels > R.maxStoreys);
  const flatLike = osmKind === 'flat' || tall || (apartment && ((levels ?? 3) >= R.flatApartmentStoreys || area > R.flatApartmentArea));
  if (flatLike) {
    // 陸屋根: 推定の高さは屋上面、パラペット 0.6 m
    const eave = hints.heightKind === 'measured' ? Math.max(2.4, height - 0.6) : height;
    return normalizeSpec({ kind: 'flat', eave: r2(eave), ridge: r2(eave + 0.6), boxHeight: r2(height), parapet: 0.6, ...(levels ? { storeys: levels, floorH: r2(eave / levels) } : {}) });
  }
  if (!rectOk || !rect) return null;
  // 立ち上がり: 短辺の半分 × 4 寸。0.8〜2.4 m
  const run = rect.short / 2;
  const rise = Math.min(2.4, Math.max(0.8, run * 0.4));
  let eave: number;
  let ridge: number;
  if (hints.heightKind === 'measured') {
    ridge = height;
    eave = Math.max(R.minEave, height - rise);
  } else {
    eave = Math.max(R.minEave, height - rise * 0.4);
    ridge = eave + rise;
  }
  const kind: RoofSpec['kind'] = osmKind ?? (apartment ? 'gable' : 'hip');
  const spec: RoofSpec = { kind, eave: r2(eave), ridge: r2(ridge), boxHeight: r2(height) };
  if (kind === 'shed') spec.highSide = 'N';
  if (levels) {
    spec.storeys = levels;
    spec.floorH = r2(eave / levels);
  }
  return normalizeSpec(spec);
}
