/**
 * DXF（CAD データ）の読み込み
 *
 * ARCHITREND などから書き出した DXF を、PDF の線データと同じ形（ページの線・円弧・文字）に変換し、
 * 図面の読み取り処理にそのまま渡す。DXF は実寸（mm）なので縮尺の推定は不要。
 *
 * - 図面ごとのブロック（INSERT で配置されたもの）を1ページとして扱う
 * - 壁の線の色を自動で見つけ（平行な2本線が壁厚の間隔で並ぶ色）、その色の線を太線として渡す
 *   （印刷用の DXF は画層が分かれていないことが多く、線の太さも全部同じため）
 */
import type { Vec2 } from '../core/types';
import type { PageVectors, RawCurve, RawSegment, RawText } from './pdfExtract';
import { mergeTextFragments } from './textMerge';

type Group = [number, string];
interface Ent {
  type: string;
  g: Group[];
}

const num = (e: Ent, code: number, def = 0, nth = 0) => {
  let k = 0;
  for (const [c, v] of e.g)
    if (c === code) {
      if (k++ === nth) {
        const x = parseFloat(v);
        return Number.isFinite(x) ? x : def;
      }
    }
  return def;
};
const str = (e: Ent, code: number) => e.g.find(([c]) => c === code)?.[1] ?? '';

export function decodeDxf(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  // 古い DXF は Shift_JIS（$DWGCODEPAGE ANSI_932）
  if ((utf8.match(/�/g) ?? []).length > 3) {
    try {
      return new TextDecoder('shift_jis').decode(bytes);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

function groups(text: string): Group[] {
  const lines = text.split(/\r?\n/);
  const out: Group[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([parseInt(lines[i].trim(), 10), lines[i + 1].replace(/\s+$/, '')]);
  return out;
}

interface Parsed {
  blocks: Map<string, { base: Vec2; ents: Ent[] }>;
  entities: Ent[];
}

function parseSections(text: string): Parsed {
  const g = groups(text);
  const blocks = new Map<string, { base: Vec2; ents: Ent[] }>();
  const entities: Ent[] = [];
  let section = '';
  let cur: Ent | null = null;
  let block: { name: string; base: Vec2; ents: Ent[]; header: boolean } | null = null;
  for (let i = 0; i < g.length; i++) {
    const [c, v] = g[i];
    if (c === 0 && v === 'SECTION') {
      section = g[i + 1]?.[1] ?? '';
      i++;
      cur = null;
      continue;
    }
    if (c === 0 && v === 'ENDSEC') {
      section = '';
      cur = null;
      continue;
    }
    if (section === 'BLOCKS') {
      if (c === 0 && v === 'BLOCK') {
        block = { name: '', base: { x: 0, y: 0 }, ents: [], header: true };
        cur = null;
        continue;
      }
      if (c === 0 && v === 'ENDBLK') {
        if (block) blocks.set(block.name, { base: block.base, ents: block.ents });
        block = null;
        cur = null;
        continue;
      }
      if (!block) continue;
      if (block.header) {
        if (c === 2 && !block.name) block.name = v;
        if (c === 10) block.base.x = parseFloat(v);
        if (c === 20) block.base.y = parseFloat(v);
        if (c === 0) block.header = false;
        else continue;
      }
      if (c === 0) {
        cur = { type: v, g: [] };
        block.ents.push(cur);
      } else cur?.g.push([c, v]);
    } else if (section === 'ENTITIES') {
      if (c === 0) {
        cur = { type: v, g: [] };
        entities.push(cur);
      } else cur?.g.push([c, v]);
    }
  }
  return { blocks, entities };
}

interface Xf {
  ox: number;
  oy: number;
  sx: number;
  sy: number;
  rot: number;
}
const apply = (t: Xf, p: Vec2): Vec2 => {
  const x = p.x * t.sx;
  const y = p.y * t.sy;
  const c = Math.cos(t.rot);
  const s = Math.sin(t.rot);
  return { x: t.ox + x * c - y * s, y: t.oy + x * s + y * c };
};

interface Prim {
  kind: 'line' | 'arc' | 'text';
  color: number;
  a?: Vec2;
  b?: Vec2;
  c?: Vec2;
  r?: number;
  a0?: number;
  a1?: number;
  text?: string;
  h?: number;
  ang?: number;
  dashed?: boolean;
}

/** ブロックの中身を展開（入れ子の INSERT も） */
function flatten(ents: Ent[], xf: Xf, blocks: Parsed['blocks'], out: Prim[], depth = 0) {
  for (const e of ents) {
    const color = num(e, 62, 7);
    const lt = str(e, 6).toLowerCase();
    const dashed = /dot|dash|hidden|center|chain/.test(lt);
    switch (e.type) {
      case 'LINE':
        out.push({ kind: 'line', color, a: apply(xf, { x: num(e, 10), y: num(e, 20) }), b: apply(xf, { x: num(e, 11), y: num(e, 21) }), dashed });
        break;
      case 'ARC':
      case 'CIRCLE': {
        const c = apply(xf, { x: num(e, 10), y: num(e, 20) });
        const r = num(e, 40) * Math.abs(xf.sx);
        const a0 = e.type === 'CIRCLE' ? 0 : (num(e, 50) * Math.PI) / 180 + xf.rot;
        const a1 = e.type === 'CIRCLE' ? Math.PI * 2 : (num(e, 51) * Math.PI) / 180 + xf.rot;
        out.push({ kind: 'arc', color, c, r, a0, a1, dashed });
        break;
      }
      case 'LWPOLYLINE': {
        const pts: Vec2[] = [];
        for (let i = 0; i < e.g.length; i++) if (e.g[i][0] === 10) pts.push({ x: parseFloat(e.g[i][1]), y: parseFloat(e.g[i + 1]?.[0] === 20 ? e.g[i + 1][1] : '0') });
        const closed = (num(e, 70) & 1) === 1;
        for (let i = 0; i + 1 < pts.length + (closed ? 1 : 0); i++) out.push({ kind: 'line', color, a: apply(xf, pts[i]), b: apply(xf, pts[(i + 1) % pts.length]), dashed });
        break;
      }
      case 'TEXT':
      case 'MTEXT': {
        let t = str(e, 1);
        if (e.type === 'MTEXT') t = t.replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '');
        if (!t.trim()) break;
        const h = num(e, 40) * Math.abs(xf.sy);
        const ang = (num(e, 50) * Math.PI) / 180 + xf.rot;
        // 揃えの指定があれば位置合わせ点（11/21）を使う
        const hasAlign = (num(e, 72) || num(e, 73)) && e.g.some(([c]) => c === 11);
        const p = apply(xf, hasAlign ? { x: num(e, 11), y: num(e, 21) } : { x: num(e, 10), y: num(e, 20) });
        out.push({ kind: 'text', color, a: p, text: t, h, ang, b: hasAlign ? { x: num(e, 72), y: num(e, 73) } : undefined });
        break;
      }
      case 'INSERT': {
        if (depth > 6) break;
        const blk = blocks.get(str(e, 2));
        if (!blk) break;
        const ip = apply(xf, { x: num(e, 10), y: num(e, 20) });
        const sx = num(e, 41, 1) * xf.sx;
        const sy = num(e, 42, 1) * xf.sy;
        const rot = (num(e, 50) * Math.PI) / 180 + xf.rot;
        // ブロックの基点を引いてから配置
        const inner: Xf = { ox: ip.x - (blk.base.x * sx * Math.cos(rot) - blk.base.y * sy * Math.sin(rot)), oy: ip.y - (blk.base.x * sx * Math.sin(rot) + blk.base.y * sy * Math.cos(rot)), sx, sy, rot };
        flatten(blk.ents, inner, blocks, out, depth + 1);
        break;
      }
    }
  }
}

/** 平行な2本線が壁厚（75〜260mm）の間隔で並ぶ長さを色ごとに数え、壁の色を決める */
function wallColor(prims: Prim[]): number | null {
  const byColor = new Map<number, Prim[]>();
  for (const p of prims) if (p.kind === 'line') (byColor.get(p.color) ?? byColor.set(p.color, []).get(p.color)!).push(p);
  let best: { color: number; score: number } | null = null;
  for (const [color, ls] of byColor) {
    const axis = ls.filter((l) => {
      const dx = l.b!.x - l.a!.x;
      const dy = l.b!.y - l.a!.y;
      const L = Math.hypot(dx, dy);
      return L > 300 && (Math.abs(dx) < 1e-3 * L || Math.abs(dy) < 1e-3 * L);
    });
    let score = 0;
    const horiz = axis.filter((l) => Math.abs(l.b!.y - l.a!.y) < 1);
    const vert = axis.filter((l) => Math.abs(l.b!.x - l.a!.x) < 1);
    // 壁は同じ壁厚の2本線が続くので、間隔（10mm 刻み）ごとの重なりの長さを数え、最も多い間隔の長さで比べる
    // （家具や寸法線も平行線を作るが、間隔がばらばら）
    const bins = new Map<number, number>();
    const pairLen = (arr: Prim[], key: 'x' | 'y', along: 'x' | 'y') => {
      for (let i = 0; i < arr.length; i++)
        for (let j = i + 1; j < arr.length; j++) {
          const d = Math.abs(arr[i].a![key] - arr[j].a![key]);
          if (d < 75 || d > 260) continue;
          const lo = Math.max(Math.min(arr[i].a![along], arr[i].b![along]), Math.min(arr[j].a![along], arr[j].b![along]));
          const hi = Math.min(Math.max(arr[i].a![along], arr[i].b![along]), Math.max(arr[j].a![along], arr[j].b![along]));
          if (hi - lo > 200) {
            const k = Math.round(d / 10);
            bins.set(k, (bins.get(k) ?? 0) + hi - lo);
          }
        }
    };
    if (horiz.length < 2000 && vert.length < 2000) {
      pairLen(horiz, 'y', 'x');
      pairLen(vert, 'x', 'y');
      for (const [k, v] of bins) score = Math.max(score, v + (bins.get(k - 1) ?? 0) * 0.5 + (bins.get(k + 1) ?? 0) * 0.5);
    }
    if (!best || score > best.score) best = { color, score };
  }
  return best && best.score > 5000 ? best.color : null;
}

function arcToBeziers(c: Vec2, r: number, a0: number, a1: number): [Vec2, Vec2, Vec2, Vec2][] {
  let span = a1 - a0;
  while (span <= 0) span += Math.PI * 2;
  const n = Math.max(1, Math.ceil(span / (Math.PI / 2)));
  const out: [Vec2, Vec2, Vec2, Vec2][] = [];
  const d = span / n;
  const k = (4 / 3) * Math.tan(d / 4);
  for (let i = 0; i < n; i++) {
    const t0 = a0 + d * i;
    const t1 = t0 + d;
    const p0 = { x: c.x + r * Math.cos(t0), y: c.y + r * Math.sin(t0) };
    const p3 = { x: c.x + r * Math.cos(t1), y: c.y + r * Math.sin(t1) };
    const p1 = { x: p0.x - k * r * Math.sin(t0), y: p0.y + k * r * Math.cos(t0) };
    const p2 = { x: p3.x + k * r * Math.sin(t1), y: p3.y - k * r * Math.cos(t1) };
    out.push([p0, p1, p2, p3]);
  }
  return out;
}

/** 部材の多い図（平面図）ごとに1ページ。座標は mm、y は下向きに直す */
export function dxfToPages(text: string): PageVectors[] {
  const parsed = parseSections(text);
  const id: Xf = { ox: 0, oy: 0, sx: 1, sy: 1, rot: 0 };
  // ページの候補: モデル空間に置かれた INSERT（ブロックごとの図）と、それ以外の線
  const groupsOut: Prim[][] = [];
  const loose: Ent[] = [];
  for (const e of parsed.entities) {
    if (e.type === 'INSERT') {
      const prims: Prim[] = [];
      flatten([e], id, parsed.blocks, prims);
      if (prims.filter((p) => p.kind === 'line').length >= 100) {
        groupsOut.push(prims);
        continue;
      }
    }
    loose.push(e);
  }
  const loosePrims: Prim[] = [];
  flatten(loose, id, parsed.blocks, loosePrims);
  if (!groupsOut.length) groupsOut.push(loosePrims);
  else {
    // 図の外の文字（図面名・縮尺など）は、近い図に含める
    for (const p of loosePrims) {
      if (p.kind !== 'text') continue;
      let best = groupsOut[0];
      let bd = Infinity;
      for (const g of groupsOut) {
        const xs = g.filter((q) => q.a).map((q) => q.a!.x);
        const ys = g.filter((q) => q.a).map((q) => q.a!.y);
        const dx = Math.max(0, Math.min(...xs) - p.a!.x, p.a!.x - Math.max(...xs));
        const dy = Math.max(0, Math.min(...ys) - p.a!.y, p.a!.y - Math.max(...ys));
        const d = Math.hypot(dx, dy);
        if (d < bd) {
          bd = d;
          best = g;
        }
      }
      if (bd < 3000) best.push(p);
    }
  }
  const all = groupsOut.flat();
  const wc = wallColor(all);
  return groupsOut.map((prims, pageIndex) => {
    const pts = prims.flatMap((p) => (p.kind === 'line' ? [p.a!, p.b!] : p.kind === 'arc' ? [{ x: p.c!.x - p.r!, y: p.c!.y - p.r! }, { x: p.c!.x + p.r!, y: p.c!.y + p.r! }] : [p.a!]));
    const minX = Math.min(...pts.map((p) => p.x)) - 1000;
    const maxX = Math.max(...pts.map((p) => p.x)) + 1000;
    const minY = Math.min(...pts.map((p) => p.y)) - 1000;
    const maxY = Math.max(...pts.map((p) => p.y)) + 1000;
    const T = (p: Vec2): Vec2 => ({ x: p.x - minX, y: maxY - p.y });
    const segments: RawSegment[] = [];
    const curves: RawCurve[] = [];
    const texts: RawText[] = [];
    for (const p of prims) {
      // 壁の色の線は太線（壁）、それ以外は細線として渡す
      const width = wc != null && p.color === wc ? 0.5 : 0.13;
      if (p.kind === 'line') segments.push({ a: T(p.a!), b: T(p.b!), width, dashed: !!p.dashed, source: 'stroke', color: '#000000' });
      else if (p.kind === 'arc') {
        for (const [p0, p1, p2, p3] of arcToBeziers(p.c!, p.r!, p.a0!, p.a1!)) curves.push({ p0: T(p0), p1: T(p1), p2: T(p2), p3: T(p3), width, dashed: !!p.dashed });
      } else {
        const h = p.h || 200;
        const t = p.text!.trim();
        const wEst = [...t].reduce((s, ch) => s + (/[\x20-\x7e｡-ﾟ]/.test(ch) ? 0.6 : 1), 0) * h;
        // 基準点（左下、または揃えの指定）から文字列の中心へ
        const hj = p.b ? p.b.x : 0;
        const vj = p.b ? p.b.y : 0;
        const fx = hj === 1 || hj === 4 ? 0 : hj === 2 ? -0.5 : 0.5;
        const fy = vj === 2 ? 0 : vj === 3 ? -0.5 : 0.5;
        const ca = Math.cos(p.ang ?? 0);
        const sa = Math.sin(p.ang ?? 0);
        const cx = p.a!.x + ca * wEst * fx - sa * h * fy;
        const cy = p.a!.y + sa * wEst * fx + ca * h * fy;
        const c = T({ x: cx, y: cy });
        texts.push({ str: t, cx: c.x, cy: c.y, size: h, width: wEst, angle: -(p.ang ?? 0) });
      }
    }
    return { pageIndex, width: maxX - minX, height: maxY - minY, segments, curves, fills: [], texts: mergeTextFragments(texts) };
  });
}
