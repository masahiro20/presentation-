/**
 * 接道・敷地の読み取り
 * 「前面道路」「南側 公道 幅員6.0m」などの文字と、その手前にある敷地境界線から、
 * どの面が道路に面しているか・道路幅・敷地の広さを推定する。
 */
import type { PlanSide, RoadInfo, SiteData, SiteEdge, Vec2 } from '../core/types';
import type { BBox } from '../core/geometry';
import type { Seg } from './walls';
import { normalizeText } from './labels';

export interface SiteText {
  str: string;
  x: number;
  y: number;
  size: number;
  angle?: number;
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

  // 「道路境界線」「隣地境界線」の文字が付いた線（斜めの敷地にも対応）
  const edges = labeledEdges(texts, segs);
  let polygon: Vec2[] | undefined;
  let roadList = [...roads.values()].map(({ textDist: _d, ...r }) => r);
  if (edges.length) {
    const c = { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 };
    const roadEdges = edges.filter((e) => e.kind === 'road');
    if (roadEdges.length) {
      // 境界線の文字がある場合は、それを接道の根拠にする（向きは建物中心から見た線の方向）
      const bySide = new Map<PlanSide, RoadInfo>();
      for (const e of roadEdges) {
        const m = { x: (e.a.x + e.b.x) / 2 - c.x, y: (e.a.y + e.b.y) / 2 - c.y };
        const side = nearestSide(m);
        const len = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
        const prev = bySide.get(side) as (RoadInfo & { len?: number }) | undefined;
        if (!prev || len > (prev.len ?? 0)) bySide.set(side, { side, label: '道路境界線', source: 'text', widthMm: roads.get(side)?.widthMm, len } as RoadInfo);
      }
      // 幅員の文字（道路側）を引き継ぐ
      const widths = roadList.filter((r) => r.widthMm);
      for (const r of bySide.values()) if (!r.widthMm && widths.length === 1) r.widthMm = widths[0].widthMm;
      roadList = [...bySide.values()].map(({ len: _l, ...r }: RoadInfo & { len?: number }) => r);
    }
    polygon = sitePolygon(edges, c);
    // 辺ごとの位置（斜めの辺は中点）
    for (const e of edges) {
      const m = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
      const side = nearestSide({ x: m.x - c.x, y: m.y - c.y });
      const v = side === 'left' || side === 'right' ? m.x : m.y;
      const cur = bounds[side];
      const further = side === 'left' || side === 'top' ? cur == null || v < cur : cur == null || v > cur;
      if (cur == null || further) bounds[side] = v;
    }
    if (polygon) {
      bounds.left = Math.min(...polygon.map((q) => q.x));
      bounds.right = Math.max(...polygon.map((q) => q.x));
      bounds.top = Math.min(...polygon.map((q) => q.y));
      bounds.bottom = Math.max(...polygon.map((q) => q.y));
    }
  }

  if (!roadList.length && !Object.keys(bounds).length && !areaM2 && !edges.length) return null;
  return {
    roads: roadList,
    edges: edges.length ? edges : undefined,
    polygon,
    bounds,
    areaM2,
  };
}

/** 境界線の文字に沿った線を探し、同じ直線上の線（1点鎖線の断片）をつないで1本の辺にする */
export function labeledEdges(texts: SiteText[], segs: Seg[]): SiteEdge[] {
  const out: SiteEdge[] = [];
  for (const t of texts) {
    const s = normalizeText(t.str);
    const kind = /道路境界/.test(s) ? 'road' : /隣地境界|敷地境界/.test(s) ? 'neighbor' : null;
    if (!kind) continue;
    const ang = t.angle ?? 0;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    let best: Seg | null = null;
    let bestD = Math.max(t.size * 3, 500);
    for (const sg of segs) {
      const L = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
      if (L < 300) continue;
      const ux = (sg.b.x - sg.a.x) / L;
      const uy = (sg.b.y - sg.a.y) / L;
      if (Math.abs(ux * dy - uy * dx) > 0.07) continue;
      const d = Math.abs((t.x - sg.a.x) * -uy + (t.y - sg.a.y) * ux);
      const tt = (t.x - sg.a.x) * ux + (t.y - sg.a.y) * uy;
      if (tt < -3000 || tt > L + 3000) continue;
      if (d < bestD) {
        bestD = d;
        best = sg;
      }
    }
    if (!best) continue;
    // 同一直線上の線をつなぐ
    const L0 = Math.hypot(best.b.x - best.a.x, best.b.y - best.a.y);
    const ux = (best.b.x - best.a.x) / L0;
    const uy = (best.b.y - best.a.y) / L0;
    const ivs: [number, number][] = [];
    for (const sg of segs) {
      const offA = (sg.a.x - best.a.x) * -uy + (sg.a.y - best.a.y) * ux;
      const offB = (sg.b.x - best.a.x) * -uy + (sg.b.y - best.a.y) * ux;
      if (Math.abs(offA) > 40 || Math.abs(offB) > 40) continue;
      const ta = (sg.a.x - best.a.x) * ux + (sg.a.y - best.a.y) * uy;
      const tb = (sg.b.x - best.a.x) * ux + (sg.b.y - best.a.y) * uy;
      ivs.push([Math.min(ta, tb), Math.max(ta, tb)]);
    }
    ivs.sort((p, q) => p[0] - q[0]);
    let lo = 0;
    let hi = L0;
    let grew = true;
    while (grew) {
      grew = false;
      for (const [a, b] of ivs) {
        if (b > hi && a <= hi + 1500) {
          hi = b;
          grew = true;
        }
        if (a < lo && b >= lo - 1500) {
          lo = a;
          grew = true;
        }
      }
    }
    const P = (tt: number) => ({ x: best!.a.x + ux * tt, y: best!.a.y + uy * tt });
    const e: SiteEdge = { a: P(lo), b: P(hi), kind };
    // 同じ辺の重複（文字が2つある等）は除く
    const dup = out.find((o) => {
      const ol = Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y);
      const ox = (o.b.x - o.a.x) / ol;
      const oy = (o.b.y - o.a.y) / ol;
      const off = Math.abs((e.a.x - o.a.x) * -oy + (e.a.y - o.a.y) * ox);
      return off < 60 && Math.abs(ox * uy - oy * ux) < 0.02;
    });
    if (dup) {
      if (dup.kind === 'neighbor' && kind === 'road') dup.kind = 'road';
      continue;
    }
    out.push(e);
  }
  return out;
}

/** 境界の辺を建物中心まわりの角度順に並べ、隣り合う辺の交点で敷地の形を作る */
function sitePolygon(edges: SiteEdge[], c: Vec2): Vec2[] | undefined {
  if (edges.length < 3) return undefined;
  const ang = (e: SiteEdge) => Math.atan2((e.a.y + e.b.y) / 2 - c.y, (e.a.x + e.b.x) / 2 - c.x);
  const es = edges.slice().sort((p, q) => ang(p) - ang(q));
  const pts: Vec2[] = [];
  for (let i = 0; i < es.length; i++) {
    const A = es[i];
    const B = es[(i + 1) % es.length];
    const d1 = { x: A.b.x - A.a.x, y: A.b.y - A.a.y };
    const d2 = { x: B.b.x - B.a.x, y: B.b.y - B.a.y };
    const den = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(den) < 1e-6 * Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y)) return undefined;
    const t = ((B.a.x - A.a.x) * d2.y - (B.a.y - A.a.y) * d2.x) / den;
    const P = { x: A.a.x + d1.x * t, y: A.a.y + d1.y * t };
    // 交点は両方の辺の端点の近く（辺の欠けを補う程度まで）
    const near = (e: SiteEdge) => Math.min(Math.hypot(P.x - e.a.x, P.y - e.a.y), Math.hypot(P.x - e.b.x, P.y - e.b.y));
    if (near(A) > 6000 || near(B) > 6000) return undefined;
    pts.push(P);
  }
  return pts;
}

/** 敷地データを平行移動 */
export function translateSite(site: SiteData, dx: number, dy: number) {
  const tr = (q: Vec2) => ({ x: q.x + dx, y: q.y + dy });
  if (site.edges) site.edges = site.edges.map((e) => ({ ...e, a: tr(e.a), b: tr(e.b) }));
  if (site.polygon) site.polygon = site.polygon.map(tr);
  const b = site.bounds;
  if (b.left != null) b.left += dx;
  if (b.right != null) b.right += dx;
  if (b.top != null) b.top += dy;
  if (b.bottom != null) b.bottom += dy;
}
