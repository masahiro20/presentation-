/**
 * 縮尺の推定
 *  1. 寸法線と寸法値の対応 (最も信頼できる。縮小印刷された PDF にも対応)
 *  2. 図面上の「S=1/100」「1:100」表記
 *  3. 既定値 1/100
 */
import type { PageVectors, RawSegment, RawText } from './pdfExtract';

export const PT_TO_MM = 25.4 / 72;
const STANDARD = [10, 20, 30, 50, 60, 100, 150, 200, 250, 300, 400, 500, 600];

export interface ScaleResult {
  mmPerPt: number;
  denominator: number | null;
  source: 'dimension' | 'text' | 'default';
  matches: number;
}

function toHalfWidth(s: string): string {
  return s.replace(/[０-９Ａ-Ｚａ-ｚ．，：／＝]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

export function parseScaleText(texts: RawText[]): number | null {
  const all = texts.map((t) => toHalfWidth(t.str)).join(' \n ');
  const re1 = /S\s*[=:]\s*1\s*[/:]\s*(\d{2,3})/gi;
  const re2 = /(?:縮尺|scale)\s*[=:]?\s*1\s*[/:]\s*(\d{2,3})/gi;
  const re3 = /(?:^|[^\d./])1\s*[/:]\s*(\d{2,3})(?![\d/])/g;
  for (const re of [re1, re2, re3]) {
    re.lastIndex = 0;
    const m = re.exec(all);
    if (m) {
      const n = parseInt(m[1], 10);
      if (STANDARD.includes(n)) return n;
    }
  }
  return null;
}

export function parseDimensionValue(str: string): number | null {
  const s = toHalfWidth(str).replace(/[,，\s]/g, '');
  if (!/^\d{3,5}(\.\d+)?$/.test(s)) return null;
  const v = parseFloat(s);
  if (v < 300 || v > 40000) return null;
  return v;
}

/**
 * 寸法値テキストと、その近傍にある平行な線分（寸法線）の長さの比から mm/pt を推定
 */
export function estimateFromDimensions(page: PageVectors): { mmPerPt: number; matches: number } | null {
  const ratios: number[] = [];
  const segs = page.segments.filter((s) => s.source === 'stroke' && !s.dashed);
  // 軸ごとの簡易インデックス（全探索でも実用上問題ない件数だが高速化）
  for (const t of page.texts) {
    const val = parseDimensionValue(t.str);
    if (val == null) continue;
    const ux = Math.cos(t.angle);
    const uy = Math.sin(t.angle);
    let best: RawSegment | null = null;
    let bestScore = Infinity;
    for (const s of segs) {
      const dx = s.b.x - s.a.x;
      const dy = s.b.y - s.a.y;
      const L = Math.hypot(dx, dy);
      if (L < t.width * 1.05) continue; // 寸法線は文字より長い
      const cosang = Math.abs((dx * ux + dy * uy) / L);
      if (cosang < 0.999) continue;
      // 文字中心から線分への垂直距離 & 投影位置
      const px = t.cx - s.a.x;
      const py = t.cy - s.a.y;
      const along = (px * dx + py * dy) / L;
      if (along < 0 || along > L) continue;
      const perpD = Math.abs(px * dy - py * dx) / L;
      if (perpD > t.size * 2.2) continue;
      // 文字中心が線分の中央付近にあるほど良い
      const centerOff = Math.abs(along - L / 2) / L;
      const score = perpD / t.size + centerOff * 2;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (best) {
      const L = Math.hypot(best.b.x - best.a.x, best.b.y - best.a.y);
      ratios.push(val / L);
    }
  }
  if (ratios.length < 2) return null;
  // 対数ヒストグラムで最頻値を探す
  ratios.sort((a, b) => a - b);
  let bestCount = 0;
  let bestCenter = 0;
  for (let i = 0; i < ratios.length; i++) {
    const c = ratios[i];
    const members = ratios.filter((r) => Math.abs(r / c - 1) < 0.02);
    if (members.length > bestCount) {
      bestCount = members.length;
      bestCenter = members.reduce((a, b) => a + b, 0) / members.length;
    }
  }
  if (bestCount < Math.max(2, ratios.length * 0.3)) return null;
  return { mmPerPt: bestCenter, matches: bestCount };
}

export function detectScale(pages: PageVectors[]): ScaleResult {
  // 寸法から
  const dimResults = pages.map(estimateFromDimensions).filter((x): x is { mmPerPt: number; matches: number } => !!x);
  const textDen = parseScaleText(pages.flatMap((p) => p.texts));
  if (dimResults.length) {
    const best = dimResults.sort((a, b) => b.matches - a.matches)[0];
    if (best.matches >= 3) {
      let den: number | null = best.mmPerPt / PT_TO_MM;
      const snapped = STANDARD.find((n) => Math.abs(n / den! - 1) < 0.015);
      den = snapped ?? null;
      return {
        mmPerPt: snapped ? snapped * PT_TO_MM : best.mmPerPt,
        denominator: den,
        source: 'dimension',
        matches: best.matches,
      };
    }
  }
  if (textDen) return { mmPerPt: textDen * PT_TO_MM, denominator: textDen, source: 'text', matches: 0 };
  return { mmPerPt: 100 * PT_TO_MM, denominator: 100, source: 'default', matches: 0 };
}
