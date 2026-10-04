/**
 * pdf.js のオペレーターリストからベクター線分・曲線・塗り・文字を抽出する。
 * 座標はページ座標 (pt, 左上原点, y 下向き)。
 */
import type { Vec2 } from '../core/types';
import { mergeTextFragments } from './textMerge';

export interface RawSegment {
  a: Vec2;
  b: Vec2;
  /** 線幅 (pt)。塗りの輪郭の場合は 0 */
  width: number;
  dashed: boolean;
  source: 'stroke' | 'fill';
  color: string;
}

export interface RawCurve {
  /** 3次ベジェの制御点 */
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
  width: number;
  dashed: boolean;
}

export interface RawFill {
  polygon: Vec2[];
  color: string;
}

export interface RawText {
  str: string;
  /** 文字列の中心 */
  cx: number;
  cy: number;
  /** 文字高さ (pt) */
  size: number;
  /** 幅 (pt) */
  width: number;
  /** 文字方向 (rad, 0 = 右向き) */
  angle: number;
}

export interface PageVectors {
  pageIndex: number;
  width: number;
  height: number;
  segments: RawSegment[];
  curves: RawCurve[];
  fills: RawFill[];
  texts: RawText[];
  /** 画像の描画回数（スキャン図面の判定用） */
  imageCount?: number;
  /** 画像の置かれた範囲（ページの pt 座標、y は下向き） */
  images?: { x0: number; y0: number; x1: number; y1: number }[];
  /** スキャン図面: ページを画像にして作った「太い線（壁）」の2値画像。1画素 = 1/scale pt */
  raster?: { mask: Uint8Array; w: number; h: number; scale: number };
}

type Mat = [number, number, number, number, number, number];

function mul(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function apply(m: Mat, x: number, y: number): Vec2 {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** pdf.js のページ（型依存を避けるため最小限のインターフェース） */
export interface PdfPageLike {
  getViewport(opts: { scale: number }): { width: number; height: number; transform: number[] };
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: any[] }>;
  getTextContent(): Promise<{ items: any[] }>;
}

export async function extractPageVectors(
  page: PdfPageLike,
  OPS: Record<string, number>,
  pageIndex = 0,
): Promise<PageVectors> {
  const viewport = page.getViewport({ scale: 1 });
  const base = viewport.transform.slice(0, 6) as Mat;
  const opList = await page.getOperatorList();
  const segments: RawSegment[] = [];
  const curves: RawCurve[] = [];
  const fills: RawFill[] = [];

  interface GState {
    ctm: Mat;
    lineWidth: number;
    dashed: boolean;
    stroke: string;
    fill: string;
    /** 現在のクリップ（単純な多角形のときだけ保持） */
    clip: Vec2[] | null;
  }
  let gs: GState = { ctm: base, lineWidth: 1, dashed: false, stroke: '#000000', fill: '#000000', clip: null };
  let pendingClip = false;
  let imageCount = 0;
  const images: { x0: number; y0: number; x1: number; y1: number }[] = [];
  /** クリップされた塗り（グラデーションを同心円などで描き部屋の形で切り抜いたもの）は、
   *  クリップの形を塗りとして1回だけ出力する */
  const clipEmitted = new Set<Vec2[]>();
  /** 塗りがクリップ全体を覆う（グラデーション・模様） */
  const coversClip = (bb: { minX: number; minY: number; maxX: number; maxY: number }) => {
    const cb = bboxPts(gs.clip!);
    return bb.minX <= cb.minX + 0.5 && bb.minY <= cb.minY + 0.5 && bb.maxX >= cb.maxX - 0.5 && bb.maxY >= cb.maxY - 0.5;
  };
  const emitClipFill = (color: string) => {
    const c = gs.clip;
    if (!c || clipEmitted.has(c)) return;
    clipEmitted.add(c);
    fills.push({ polygon: c, color });
  };
  const stack: GState[] = [];

  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push({ ...gs });
        break;
      case OPS.restore:
        if (stack.length) gs = stack.pop()!;
        break;
      case OPS.transform:
        gs.ctm = mul(gs.ctm, args as Mat);
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push({ ...gs });
        const m = args?.[0];
        if (m && m.length === 6) gs.ctm = mul(gs.ctm, Array.from(m) as Mat);
        break;
      }
      case OPS.paintFormXObjectEnd:
        if (stack.length) gs = stack.pop()!;
        break;
      case OPS.setLineWidth:
        gs.lineWidth = args[0];
        break;
      case OPS.setDash: {
        const arr = args[0] as number[];
        gs.dashed = Array.isArray(arr) ? arr.length > 0 && arr.some((x) => x > 0) : false;
        break;
      }
      case OPS.setStrokeRGBColor:
        gs.stroke = typeof args[0] === 'string' ? args[0] : '#000000';
        break;
      case OPS.setFillRGBColor:
        gs.fill = typeof args[0] === 'string' ? args[0] : '#000000';
        break;
      case OPS.clip:
      case OPS.eoClip:
        pendingClip = true;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintImageXObjectRepeat:
        imageCount++;
        {
          // 画像の置かれた範囲（単位正方形を現在の変換で写した外接矩形, ページの pt 座標）
          const m = gs.ctm;
          const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
          const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
          images.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
        }
        break;
      case OPS.shadingFill:
        emitClipFill('#shading');
        break;
      case OPS.constructPath: {
        const paintOp = args[0] as number;
        const data = args[1]?.[0] as Float32Array | number[] | null;
        if (!data) break;
        const isStroke =
          paintOp === OPS.stroke ||
          paintOp === OPS.closeStroke ||
          paintOp === OPS.fillStroke ||
          paintOp === OPS.eoFillStroke ||
          paintOp === OPS.closeFillStroke ||
          paintOp === OPS.closeEOFillStroke;
        const isFill =
          paintOp === OPS.fill ||
          paintOp === OPS.eoFill ||
          paintOp === OPS.fillStroke ||
          paintOp === OPS.eoFillStroke ||
          paintOp === OPS.closeFillStroke ||
          paintOp === OPS.closeEOFillStroke;
        const m = gs.ctm;
        if (!isStroke && !isFill) {
          // クリップ: 1つの閉じた直線多角形のときだけ覚える
          if (pendingClip) {
            pendingClip = false;
            const pts: Vec2[] = [];
            let ok = true;
            let moves = 0;
            for (let k = 0; k < data.length && ok; ) {
              const op = data[k++];
              if (op === 0 || op === 1) {
                if (op === 0 && ++moves > 1) ok = false;
                pts.push(apply(m, data[k], data[k + 1]));
                k += 2;
              } else if (op === 4) {
                /* close */
              } else ok = false;
            }
            gs.clip = ok && pts.length >= 3 && pts.length <= 16 ? pts : null;
          }
          break;
        }
        pendingClip = false;
        const scaleW = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        const width = gs.lineWidth * scaleW;
        let k = 0;
        let cur: Vec2 | null = null;
        let start: Vec2 | null = null;
        let poly: Vec2[] = [];
        const flushPoly = () => {
          if (isFill && poly.length >= 3) {
            if (!(gs.clip && coversClip(bboxPts(poly)))) fills.push({ polygon: poly, color: gs.fill });
            else emitClipFill(gs.fill);
          }
          poly = [];
        };
        const pushSeg = (a: Vec2, b: Vec2) => {
          if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) return;
          if (isStroke) segments.push({ a, b, width, dashed: gs.dashed, source: 'stroke', color: gs.stroke });
          if (isFill) segments.push({ a, b, width: 0, dashed: false, source: 'fill', color: gs.fill });
        };
        while (k < data.length) {
          const op = data[k++];
          if (op === 0) {
            // moveTo
            flushPoly();
            cur = apply(m, data[k], data[k + 1]);
            start = cur;
            poly.push(cur);
            k += 2;
          } else if (op === 1) {
            const p = apply(m, data[k], data[k + 1]);
            k += 2;
            if (cur) pushSeg(cur, p);
            cur = p;
            poly.push(p);
          } else if (op === 2) {
            const p1 = apply(m, data[k], data[k + 1]);
            const p2 = apply(m, data[k + 2], data[k + 3]);
            const p3 = apply(m, data[k + 4], data[k + 5]);
            k += 6;
            if (cur) {
              curves.push({ p0: cur, p1, p2, p3, width, dashed: gs.dashed });
              // 塗りポリゴン用に平坦化
              for (let s = 1; s <= 8; s++) poly.push(bezier(cur, p1, p2, p3, s / 8));
            }
            cur = p3;
          } else if (op === 3) {
            const p1 = apply(m, data[k], data[k + 1]);
            const p2 = apply(m, data[k + 2], data[k + 3]);
            k += 4;
            if (cur) {
              // 2次→3次
              const c1 = { x: cur.x + (2 / 3) * (p1.x - cur.x), y: cur.y + (2 / 3) * (p1.y - cur.y) };
              const c2 = { x: p2.x + (2 / 3) * (p1.x - p2.x), y: p2.y + (2 / 3) * (p1.y - p2.y) };
              curves.push({ p0: cur, p1: c1, p2: c2, p3: p2, width, dashed: gs.dashed });
              poly.push(p2);
            }
            cur = p2;
          } else if (op === 4) {
            if (cur && start) pushSeg(cur, start);
            cur = start;
          } else {
            break;
          }
        }
        flushPoly();
        break;
      }
      default:
        break;
    }
  }

  // テキスト
  const texts: RawText[] = [];
  const tc = await page.getTextContent();
  for (const it of tc.items) {
    if (!it || typeof it.str !== 'string') continue;
    const str = it.str.trim();
    if (!str) continue;
    const tm = it.transform as number[];
    const m = mul(base, tm as Mat);
    const size = Math.hypot(m[2], m[3]);
    const angle = Math.atan2(m[1], m[0]);
    const w = (it.width as number) * (Math.hypot(base[0], base[1]) || 1);
    // ベースライン左端 → 中心
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    // y 下向き座標なので「上」は (uy, -ux) 方向
    const bx = m[4];
    const by = m[5];
    const cx = bx + ux * (w / 2) + uy * (size * 0.35);
    const cy = by + uy * (w / 2) - ux * (size * 0.35);
    texts.push({ str, cx, cy, size, width: w, angle });
  }

  return { pageIndex, width: viewport.width, height: viewport.height, segments, curves, fills, texts: mergeTextFragments(texts), imageCount, images };
}

function bboxPts(pts: Vec2[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function bezier(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}
