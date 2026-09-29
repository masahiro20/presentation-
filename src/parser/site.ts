/**
 * 接道・敷地の読み取り
 * 「前面道路」「南側 公道 幅員6.0m」などの文字と、その手前にある敷地境界線から、
 * どの面が道路に面しているか・道路幅・敷地の広さを推定する。
 */
import type { PlanSide, RoadInfo, SiteData, Vec2 } from '../core/types';
import type { BBox } from '../core/geometry';
import type { Seg } from './walls';
import { normalizeText } from './labels';

export interface SiteText {
  str: string;
  x: number;
  y: number;
  size: number;
}

const ROAD_RE = /(道路|公道|私道|市道|町道|区道|村道|県道|府道|都道|国道|認定道|位置指定道|前面道)/;
const NOT_ROAD_RE = /斜線|後退距離|道路高さ|ドウロシャセン/;

const SIDES: PlanSide[] = ['top', 'right', 'bottom', 'left'];
const SIDE_VEC: Record<PlanSide, Vec2> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

/** 方位（北・南東など）→ 図面の辺 */
export function compassToSide(word: string, northAngleDeg: number): PlanSide | null {
  const a = (northAngleDeg * Math.PI) / 180;
  const n = { x: Math.sin(a), y: -Math.cos(a) };
  const e = { x: Math.cos(a), y: Math.sin(a) };
  let v = { x: 0, y: 0 };
  for (const ch of word) {
    if (ch === '北') v = { x: v.x + n.x, y: v.y + n.y };
    if (ch === '南') v = { x: v.x - n.x, y: v.y - n.y };
    if (ch === '東') v = { x: v.x + e.x, y: v.y + e.y };
    if (ch === '西') v = { x: v.x - e.x, y: v.y - e.y };
  }
  if (Math.hypot(v.x, v.y) < 0.1) return null;
  return nearestSide(v);
}

function nearestSide(v: Vec2): PlanSide {
  let best: PlanSide = 'bottom';
  let bd = -Infinity;
  for (const s of SIDES) {
    const d = v.x * SIDE_VEC[s].x + v.y * SIDE_VEC[s].y;
    if (d > bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

/** 「幅員4.0m」「W=6000」「6m道路」→ mm */
export function parseRoadWidth(raw: string): number | null {
  const s = normalizeText(raw).replace(/ｍ/g, 'M');
  const m = /(?:幅員|巾員|W=|巾)[:：]?(\d+(?:\.\d+)?)(M|MM)?/.exec(s) ?? /(\d+(?:\.\d+)?)(M)(?:道路|公道|私道|市道|町道|区道|県道|国道)/.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  const mm = m[2] === 'MM' || v >= 500 ? v : v * 1000;
  return mm >= 1800 && mm <= 60000 ? mm : null;
}

export function parseSiteArea(raw: string): number | null {
  const s = normalizeText(raw).replace(/,/g, '');
  const m = /敷地面積[:：]?(\d+(?:\.\d+)?)(?:㎡|M2|M²|平米)/.exec(s);
  return m ? parseFloat(m[1]) : null;
}

/** 辺に平行な長い線（破線は区間をつないで評価） */
function parallelLines(segs: Seg[], side: PlanSide, bbox: BBox) {
  const horizontal = side === 'top' || side === 'bottom';
  const span0 = horizontal ? bbox.minX : bbox.minY;
  const span1 = horizontal ? bbox.maxX : bbox.maxY;
  const buckets = new Map<number, { pos: number; ivs: [number, number][]; dashed: number; total: number }>();
  for (const s of segs) {
    const dx = s.b.x - s.a.x;
    const dy = s.b.y - s.a.y;
    const len = Math.hypot(dx, dy);
    if (len < 30) continue;
    if (horizontal ? Math.abs(dy) > len * 0.02 : Math.abs(dx) > len * 0.02) continue;
    const pos = horizontal ? (s.a.y + s.b.y) / 2 : (s.a.x + s.b.x) / 2;
    const t0 = horizontal ? Math.min(s.a.x, s.b.x) : Math.min(s.a.y, s.b.y);
    const t1 = horizontal ? Math.max(s.a.x, s.b.x) : Math.max(s.a.y, s.b.y);
    const key = Math.round(pos / 40);
    const b = buckets.get(key) ?? { pos, ivs: [], dashed: 0, total: 0 };
    b.ivs.push([t0, t1]);
    b.total += len;
    if (s.dashed || len < 1500) b.dashed += len;
    buckets.set(key, b);
  }
  const out: { pos: number; cover: number; dashed: boolean }[] = [];
  for (const b of buckets.values()) {
    // 1点鎖線などの隙間 (〜1.2m) はつなぐ
    const ivs = b.ivs.sort((p, q) => p[0] - q[0]);
    const merged: [number, number][] = [];
    for (const iv of ivs) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1] + 1200) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    let cover = 0;
    for (const [a, c] of merged) cover += Math.max(0, Math.min(c, span1) - Math.max(a, span0));
    out.push({ pos: b.pos, cover: cover / Math.max(1, span1 - span0), dashed: b.dashed > b.total * 0.5 });
  }
  return out.filter((l) => l.cover >= 0.6);
}

/** 建物外形の外側で、辺の方向に何 mm 離れているか（その辺の外側でなければ負） */
function outsideDist(side: PlanSide, bbox: BBox, pos: number) {
  switch (side) {
    case 'top':
      return bbox.minY - pos;
    case 'bottom':
      return pos - bbox.maxY;
    case 'left':
      return bbox.minX - pos;
    case 'right':
      return pos - bbox.maxX;
  }
}

export function detectSite(texts: SiteText[], segs: Seg[], bbox: BBox, northAngleDeg: number): SiteData | null {
  const roads = new Map<PlanSide, RoadInfo & { textDist: number }>();
  let areaM2: number | undefined;
  for (const t of texts) {
    const s = normalizeText(t.str);
    const area = parseSiteArea(t.str);
    if (area) areaM2 = area;
    if (!ROAD_RE.test(s) || NOT_ROAD_RE.test(s)) continue;
    // 幅員は同じ文字列か、近くの文字から
    let width = parseRoadWidth(t.str);
    if (width == null) {
      for (const q of texts) {
        if (q === t || Math.hypot(q.x - t.x, q.y - t.y) > Math.max(3000, t.size * 12)) continue;
        const w = parseRoadWidth(q.str);
        if (w) {
          width = w;
          break;
        }
      }
    }
    // 方位の語（「南側道路」「接道：北東」）
    const cm = /(北東|北西|南東|南西|北|南|東|西)(?:側)?(?:前面)?(?:公道|私道|市道|町道|区道|県道|国道|道路|接道|前面道)/.exec(s) ?? /接道[:：]?(北東|北西|南東|南西|北|南|東|西)/.exec(s);
    let side: PlanSide | null = cm ? compassToSide(cm[1], northAngleDeg) : null;
    let source: RoadInfo['source'] = 'compass';
    let dist = Infinity;
    // 文字の位置（建物の外側のどちらにあるか）
    const ox = t.x < bbox.minX ? bbox.minX - t.x : t.x > bbox.maxX ? t.x - bbox.maxX : 0;
    const oy = t.y < bbox.minY ? bbox.minY - t.y : t.y > bbox.maxY ? t.y - bbox.maxY : 0;
    const near = Math.max(ox, oy) > 0 && Math.max(ox, oy) < 30000;
    if (!side && near) {
      side = ox > oy ? (t.x < bbox.minX ? 'left' : 'right') : t.y < bbox.minY ? 'top' : 'bottom';
      source = 'text';
      dist = Math.max(ox, oy);
    } else if (side && near) {
      source = 'text';
      dist = Math.max(ox, oy);
    }
    if (!side) continue;
    const prev = roads.get(side);
    if (!prev || (width && !prev.widthMm) || dist < prev.textDist) {
      roads.set(side, { side, widthMm: width ?? prev?.widthMm, label: t.str, source, textDist: dist });
    }
  }

  // 敷地境界線: 道路側は「建物と道路の文字の間」で文字に最も近い長い線
  const bounds: SiteData['bounds'] = {};
  for (const [side, r] of roads) {
    if (!Number.isFinite(r.textDist)) continue;
    const lines = parallelLines(segs, side, bbox)
      .map((l) => ({ ...l, d: outsideDist(side, bbox, l.pos) }))
      .filter((l) => l.d > 150 && l.d < r.textDist - 200);
    if (!lines.length) continue;
    lines.sort((p, q) => q.d - p.d);
    bounds[side] = lines[0].pos;
    // 道路の向こう側の線から幅員を推定
    if (!r.widthMm) {
      const far = parallelLines(segs, side, bbox)
        .map((l) => ({ ...l, d: outsideDist(side, bbox, l.pos) }))
        .filter((l) => l.d > r.textDist + 200)
        .sort((p, q) => p.d - q.d)[0];
      if (far) {
        const w = far.d - lines[0].d;
        if (w >= 1800 && w <= 30000) r.widthMm = Math.round(w / 100) * 100;
      }
    }
  }
  // 隣地側: 建物の外側 12m 以内の、破線（1点鎖線）の長い線のうち最も外側
  for (const side of SIDES) {
    if (bounds[side] != null) continue;
    const lines = parallelLines(segs, side, bbox)
      .map((l) => ({ ...l, d: outsideDist(side, bbox, l.pos) }))
      .filter((l) => l.dashed && l.d > 300 && l.d < 12000)
      .sort((p, q) => q.d - p.d);
    if (lines.length) bounds[side] = lines[0].pos;
  }

  if (!roads.size && !Object.keys(bounds).length && !areaM2) return null;
  return {
    roads: [...roads.values()].map(({ textDist: _d, ...r }) => r),
    bounds,
    areaM2,
  };
}

/** 敷地データを平行移動 */
export function translateSite(site: SiteData, dx: number, dy: number) {
  const b = site.bounds;
  if (b.left != null) b.left += dx;
  if (b.right != null) b.right += dx;
  if (b.top != null) b.top += dy;
  if (b.bottom != null) b.bottom += dy;
}
