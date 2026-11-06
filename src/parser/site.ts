/**
 * 接道・敷地の読み取り
 * 「前面道路」「南側 公道 幅員6.0m」などの文字と、その手前にある敷地境界線から、
 * どの面が道路に面しているか・道路幅・敷地の広さを推定する。
 */
import type { BuildingModel, PlanSide, RoadInfo, SiteData, SiteEdge, Vec2 } from '../core/types';
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

export const SIDES: PlanSide[] = ['top', 'right', 'bottom', 'left'];
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

export function nearestSide(v: Vec2): PlanSide {
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
  let edges = labeledEdges(texts, segs, bbox);
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
    // 辺ごとの位置（斜めの辺は中点）。文字の付いた境界線は、文字の無い破線（図枠・表題の下線のこともある）より信用する
    const labeledSides = new Set<PlanSide>();
    for (const e of edges) {
      const m = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
      const side = nearestSide({ x: m.x - c.x, y: m.y - c.y });
      const v = side === 'left' || side === 'right' ? m.x : m.y;
      const cur = bounds[side];
      const further = side === 'left' || side === 'top' ? cur == null || v < cur : cur == null || v > cur;
      if (cur == null || further || !labeledSides.has(side)) bounds[side] = v;
      labeledSides.add(side);
    }
    if (polygon) {
      bounds.left = Math.min(...polygon.map((q) => q.x));
      bounds.right = Math.max(...polygon.map((q) => q.x));
      bounds.top = Math.min(...polygon.map((q) => q.y));
      bounds.bottom = Math.max(...polygon.map((q) => q.y));
    }
  }

  // 広すぎる敷地（図枠・寸法線を境界線と見誤ったとき）は図面の敷地線を使わず、標準の余白にする
  let warning: string | undefined;
  const bw = Math.max(1, bbox.maxX - bbox.minX);
  const bh = Math.max(1, bbox.maxY - bbox.minY);
  const sw = bounds.left != null && bounds.right != null ? bounds.right - bounds.left : 0;
  const sh = bounds.top != null && bounds.bottom != null ? bounds.bottom - bounds.top : 0;
  if (sw > bw * SITE_MAX_RATIO + SITE_MAX_EXTRA || sh > bh * SITE_MAX_RATIO + SITE_MAX_EXTRA) {
    warning = `敷地境界線が建物の ${(Math.max(sw / bw, sh / bh)).toFixed(1)} 倍（${(sw / 1000).toFixed(1)} × ${(sh / 1000).toFixed(1)} m）に読めたため、図面の敷地線は使わず標準の余白にしました（図面読込の「接道・敷地」で作り直せます）`;
    polygon = undefined;
    edges = [];
    for (const sd of SIDES) delete bounds[sd];
  }

  if (!roadList.length && !Object.keys(bounds).length && !areaM2 && !edges.length && !warning) return null;
  return {
    roads: roadList,
    edges: edges.length ? edges : undefined,
    polygon,
    bounds,
    areaM2,
    ...(warning ? { warning } : {}),
  };
}

/** 敷地は建物の外形（幅・奥行）の何倍まで信じるか。都市部の建蔽率 40〜60% なら 1.5〜2 倍、郊外でも 3 倍程度 */
const SITE_MAX_RATIO = 4;
const SITE_MAX_EXTRA = 8000;

/**
 * 境界線の文字に沿った線を探し、同じ直線上の線（1点鎖線の断片）をつないで1本の辺にする。
 * 文字の近くに線が何本もあるとき（図枠・寸法線が並ぶ）は、ほかの境界線の文字の線と端でつながる線を境界線と見る
 */
export function labeledEdges(texts: SiteText[], segs: Seg[], bbox?: BBox): SiteEdge[] {
  interface Cand {
    sg: Seg;
    d: number;
    L: number;
  }
  const labels: { t: SiteText; kind: SiteEdge['kind']; tol: number; cands: Cand[] }[] = [];
  for (const t of texts) {
    const s = normalizeText(t.str);
    const kind = /道路境界/.test(s) ? 'road' : /隣地境界|敷地境界/.test(s) ? 'neighbor' : null;
    if (!kind) continue;
    const ang = t.angle ?? 0;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const tol = Math.max(t.size * 3, 500);
    const cands: Cand[] = [];
    for (const sg of segs) {
      const L = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
      if (L < 150) continue;
      const ux = (sg.b.x - sg.a.x) / L;
      const uy = (sg.b.y - sg.a.y) / L;
      if (Math.abs(ux * dy - uy * dx) > 0.07) continue;
      const d = Math.abs((t.x - sg.a.x) * -uy + (t.y - sg.a.y) * ux);
      const tt = (t.x - sg.a.x) * ux + (t.y - sg.a.y) * uy;
      if (tt < -3000 || tt > L + 3000) continue;
      if (d < tol) cands.push({ sg, d, L });
    }
    if (cands.length) labels.push({ t, kind, tol, cands });
  }
  // 建物の大きさに比べて長すぎる線（図枠・寸法の基準線）は境界線らしくない
  const bmax = bbox ? Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) : 0;
  const tooLong = (L: number) => bmax > 0 && L > bmax * SITE_MAX_RATIO + SITE_MAX_EXTRA;
  const joinCap = bmax > 0 ? bmax * SITE_MAX_RATIO + SITE_MAX_EXTRA : 60000;
  const endsNear = (p: Seg, q: Seg) => [p.a, p.b].some((u) => [q.a, q.b].some((v) => Math.hypot(u.x - v.x, u.y - v.y) < 250));
  const out: SiteEdge[] = [];
  for (let i = 0; i < labels.length; i++) {
    const { kind, tol, cands } = labels[i];
    let best: Cand | null = null;
    let bestScore = Infinity;
    for (const c of cands) {
      // 近さ（0〜1）に、ほかの境界線の文字の線と端でつながる線・破線を優先、長すぎる線は後回し
      const connected = labels.some((o, j) => j !== i && o.cands.some((oc) => oc.sg !== c.sg && endsNear(c.sg, oc.sg)));
      const score = c.d / tol + (connected ? -1.2 : 0) + (c.sg.dashed ? -0.3 : 0) + (tooLong(c.L) ? 1.5 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) continue;
    const base = best.sg;
    // 同一直線上の線をつなぐ（1 点鎖線の断片）。境界線が破線なら、同じ線上の長い実線（寸法線・図枠の線）はつながない
    // （つなぐと敷地が図面の端まで伸びて、建物の 3 倍もの広さに読めていた）
    const L0 = best.L;
    const ux = (base.b.x - base.a.x) / L0;
    const uy = (base.b.y - base.a.y) / L0;
    const dashLike = (sg: Seg) => !!sg.dashed || Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y) < 1500;
    const bestDash = dashLike(base);
    const ivs: [number, number][] = [];
    for (const sg of segs) {
      const offA = (sg.a.x - base.a.x) * -uy + (sg.a.y - base.a.y) * ux;
      const offB = (sg.b.x - base.a.x) * -uy + (sg.b.y - base.a.y) * ux;
      if (Math.abs(offA) > 40 || Math.abs(offB) > 40) continue;
      if (bestDash && !dashLike(sg)) continue;
      const ta = (sg.a.x - base.a.x) * ux + (sg.a.y - base.a.y) * uy;
      const tb = (sg.b.x - base.a.x) * ux + (sg.b.y - base.a.y) * uy;
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
    // つないだ結果が建物に比べて長すぎれば（図枠まで伸びた）、文字のそばの線だけにする
    if (hi - lo > joinCap) {
      lo = 0;
      hi = L0;
    }
    const P = (tt: number) => ({ x: base.a.x + ux * tt, y: base.a.y + uy * tt });
    const e: SiteEdge = { a: P(lo), b: P(hi), kind };
    // 同じ直線上の辺（文字が 2 つある・欠けた境界線の断片）は 1 本にまとめる（両方を含む範囲に伸ばす）
    const dup = out.find((o) => {
      const ol = Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y);
      const ox = (o.b.x - o.a.x) / ol;
      const oy = (o.b.y - o.a.y) / ol;
      const off = Math.abs((e.a.x - o.a.x) * -oy + (e.a.y - o.a.y) * ox);
      return off < 60 && Math.abs(ox * uy - oy * ux) < 0.02;
    });
    if (dup) {
      if (dup.kind === 'neighbor' && kind === 'road') dup.kind = 'road';
      const ol = Math.hypot(dup.b.x - dup.a.x, dup.b.y - dup.a.y);
      const ox = (dup.b.x - dup.a.x) / ol;
      const oy = (dup.b.y - dup.a.y) / ol;
      const ts = [0, ol, ...[e.a, e.b].map((q) => (q.x - dup.a.x) * ox + (q.y - dup.a.y) * oy)];
      const t0 = Math.min(...ts);
      const t1 = Math.max(...ts);
      const a0 = { x: dup.a.x + ox * t0, y: dup.a.y + oy * t0 };
      const b0 = { x: dup.a.x + ox * t1, y: dup.a.y + oy * t1 };
      dup.a = a0;
      dup.b = b0;
      continue;
    }
    out.push(e);
  }
  return out.filter((e) => Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) >= 500);
}

/**
 * 境界の辺を建物中心まわりの角度順に並べ、隣り合う辺をつないで敷地の形を作る。
 * 端が近ければそこで、交わるなら交点で、どちらでもなく端が 4m 以内なら（文字の無い短い辺を補って）両方の端でつなぐ
 */
export function sitePolygon(edges: SiteEdge[], c: Vec2): Vec2[] | undefined {
  if (edges.length < 3) return undefined;
  const ang = (e: SiteEdge) => Math.atan2((e.a.y + e.b.y) / 2 - c.y, (e.a.x + e.b.x) / 2 - c.x);
  const es = edges.slice().sort((p, q) => ang(p) - ang(q));
  const pts: Vec2[] = [];
  const push = (p: Vec2) => {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 50) pts.push(p);
  };
  for (let i = 0; i < es.length; i++) {
    const A = es[i];
    const B = es[(i + 1) % es.length];
    // いちばん近い端どうし
    let pA = A.a;
    let pB = B.a;
    let dist = Infinity;
    for (const u of [A.a, A.b])
      for (const v of [B.a, B.b]) {
        const d = Math.hypot(u.x - v.x, u.y - v.y);
        if (d < dist) {
          dist = d;
          pA = u;
          pB = v;
        }
      }
    if (dist < 600) {
      push({ x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 });
      continue;
    }
    const d1 = { x: A.b.x - A.a.x, y: A.b.y - A.a.y };
    const d2 = { x: B.b.x - B.a.x, y: B.b.y - B.a.y };
    const den = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(den) >= 1e-3 * Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y)) {
      const t = ((B.a.x - A.a.x) * d2.y - (B.a.y - A.a.y) * d2.x) / den;
      const P = { x: A.a.x + d1.x * t, y: A.a.y + d1.y * t };
      // 交点は両方の辺の端点の近く（辺の欠けを補う程度まで）
      if (Math.hypot(P.x - pA.x, P.y - pA.y) <= 6000 && Math.hypot(P.x - pB.x, P.y - pB.y) <= 6000) {
        push(P);
        continue;
      }
    }
    if (dist < 4000) {
      push(pA);
      push(pB);
      continue;
    }
    return undefined;
  }
  if (pts.length >= 3 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= 50) pts.pop();
  return pts.length >= 3 && Math.abs(polygonArea(pts)) > 1e6 ? pts : undefined;
}

function polygonArea(p: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** 敷地の幅・奥行（図面座標 mm）。境界が分かっていなければ null */
export function siteSize(site: SiteData | undefined): { w: number; h: number; areaM2: number } | null {
  if (!site) return null;
  if (site.polygon && site.polygon.length >= 3) {
    const xs = site.polygon.map((p) => p.x);
    const ys = site.polygon.map((p) => p.y);
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), areaM2: Math.abs(polygonArea(site.polygon)) / 1e6 };
  }
  const b = site.bounds;
  if (b.left == null || b.right == null || b.top == null || b.bottom == null) return null;
  return { w: b.right - b.left, h: b.bottom - b.top, areaM2: ((b.right - b.left) * (b.bottom - b.top)) / 1e6 };
}

/** 玄関ドアの向く側（図面の辺）。接道の表記が無いときの道路側の推定に使う */
export function entranceSide(model: BuildingModel): PlanSide | null {
  for (const f of model.floors) {
    const op = f.openings.find((o) => o.kind === 'entrance');
    const w = op && f.walls.find((x) => x.id === op.wallId);
    if (!w) continue;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    let n = { x: -(w.b.y - w.a.y) / L, y: (w.b.x - w.a.x) / L };
    if (w.outsideSign) n = { x: n.x * w.outsideSign, y: n.y * w.outsideSign };
    else {
      const pts = f.outline.flat();
      if (pts.length) {
        const c = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
        const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
        if ((mid.x - c.x) * n.x + (mid.y - c.y) * n.y < 0) n = { x: -n.x, y: -n.y };
      }
    }
    return nearestSide(n);
  }
  return null;
}

/** 建物の外形（全階）の周りに、道路側は roadMm・ほかの辺は otherMm の余白で敷地を作り直す（図面の境界線が読めない・広すぎるとき）。接道が無ければ玄関の向きを道路側に */
export function siteAroundBuilding(model: BuildingModel, roadMm: number, otherMm: number): SiteData | null {
  const pts = model.floors.flatMap((f) => f.outline.flat());
  if (!pts.length) return null;
  const site = (model.site ??= { roads: [], bounds: {} });
  const roads: RoadInfo[] = site.roads.length ? site.roads : (() => { const es = entranceSide(model); return es ? [{ side: es, source: 'inferred' as const }] : []; })();
  const roadSides = new Set(roads.map((r) => r.side));
  const m = (s: PlanSide) => (roadSides.has(s) ? roadMm : otherMm);
  const minX = Math.min(...pts.map((p) => p.x)) - m('left');
  const maxX = Math.max(...pts.map((p) => p.x)) + m('right');
  const minY = Math.min(...pts.map((p) => p.y)) - m('top');
  const maxY = Math.max(...pts.map((p) => p.y)) + m('bottom');
  site.bounds = { left: minX, right: maxX, top: minY, bottom: maxY };
  site.polygon = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
  site.edges = siteEdgesFromPolygon(site.polygon, roads, undefined);
  delete site.warning;
  return site;
}

/** 図面の敷地線を使わない（標準の余白に戻す）。接道の向き・幅員は残す */
export function clearSiteLines(site: SiteData): void {
  site.bounds = {};
  delete site.polygon;
  delete site.edges;
  site.warning = '図面の敷地線を使わない設定です（標準の余白: 道路側 6m・ほか 1.6〜2.2m）';
}

/**
 * 敷地の形（多角形）から境界の辺を作る。元の辺があればいちばん近い平行な辺の種類（道路／隣地）を引き継ぎ、
 * 無ければ接道の向きに当たる辺を道路境界にする
 */
export function siteEdgesFromPolygon(polygon: Vec2[], roads: RoadInfo[], prev: SiteEdge[] | undefined): SiteEdge[] {
  const n = polygon.length;
  const c = { x: polygon.reduce((s, p) => s + p.x, 0) / n, y: polygon.reduce((s, p) => s + p.y, 0) / n };
  const roadSides = new Set(roads.map((r) => r.side));
  const out: SiteEdge[] = [];
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 50) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let kind: SiteEdge['kind'] | null = null;
    if (prev?.length) {
      const ux = (b.x - a.x) / L;
      const uy = (b.y - a.y) / L;
      let best = Infinity;
      for (const e of prev) {
        const el = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) || 1;
        const ex = (e.b.x - e.a.x) / el;
        const ey = (e.b.y - e.a.y) / el;
        if (Math.abs(ux * ey - uy * ex) > 0.3) continue;
        // 辺の線からの距離（平行な辺どうし）
        const off = Math.abs((mid.x - e.a.x) * -ey + (mid.y - e.a.y) * ex);
        if (off < best && off < 2500) {
          best = off;
          kind = e.kind;
        }
      }
    }
    if (!kind) kind = !prev?.length && roadSides.has(nearestSide({ x: mid.x - c.x, y: mid.y - c.y })) ? 'road' : 'neighbor';
    out.push({ a: { ...a }, b: { ...b }, kind });
  }
  return out;
}

/** 敷地の多角形を直したあと、境界の位置・辺を合わせる */
export function syncSiteFromPolygon(site: SiteData): void {
  const poly = site.polygon;
  if (!poly || poly.length < 3) return;
  site.bounds = { left: Math.min(...poly.map((q) => q.x)), right: Math.max(...poly.map((q) => q.x)), top: Math.min(...poly.map((q) => q.y)), bottom: Math.max(...poly.map((q) => q.y)) };
  site.edges = siteEdgesFromPolygon(poly, site.roads, site.edges);
  delete site.warning;
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
