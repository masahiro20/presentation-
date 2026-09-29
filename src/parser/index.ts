/**
 * 平面図 PDF → 建物モデル
 */
import type { BuildingModel } from '../core/types';
import { extractPageVectors, type PageVectors, type PdfPageLike } from './pdfExtract';
import { detectScale, PT_TO_MM } from './scale';
import { assembleModel, pageToMm } from './assemble';

export interface PdfjsLike {
  getDocument(src: any): { promise: Promise<{ numPages: number; getPage(i: number): Promise<PdfPageLike> }> };
  OPS: Record<string, number>;
}

export interface ParseOptions {
  cMapUrl?: string;
  standardFontDataUrl?: string;
  /** 手動で縮尺を指定 (例: 100 → 1/100) */
  scaleDenominator?: number;
  name?: string;
  onProgress?: (msg: string, ratio: number) => void;
}

export async function loadPdfVectors(data: Uint8Array, pdfjs: PdfjsLike, opts: ParseOptions = {}): Promise<PageVectors[]> {
  const doc = await pdfjs.getDocument({
    data,
    cMapUrl: opts.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: opts.standardFontDataUrl,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  const pages: PageVectors[] = [];
  const n = Math.min(doc.numPages, 12);
  for (let i = 1; i <= n; i++) {
    opts.onProgress?.(`${i}/${n} ページを読み込み中`, (i - 1) / n * 0.5);
    const page = await doc.getPage(i);
    pages.push(await extractPageVectors(page, pdfjs.OPS, i - 1));
  }
  return pages;
}

export function modelFromVectors(pages: PageVectors[], opts: ParseOptions = {}): BuildingModel {
  const t0 = performance.now();
  const warnings: string[] = [];
  let sc = detectScale(pages);
  let scaleSource: BuildingModel['report']['scaleSource'] = sc.source;
  if (opts.scaleDenominator) {
    sc = { mmPerPt: opts.scaleDenominator * PT_TO_MM, denominator: opts.scaleDenominator, source: 'text', matches: 0 };
    scaleSource = 'manual';
  }
  const segCount = pages.reduce((s, p) => s + p.segments.length, 0);
  if (segCount < 50) {
    warnings.push('ベクター線がほとんどありません。スキャン画像のPDFの可能性があります（CAD から出力した PDF を推奨）');
  }
  let mmPages = pages.map((p) => pageToMm(p, sc.mmPerPt));
  let res = assembleModel(mmPages, opts.name ?? '新築計画', warnings);

  // 帖数表記による縮尺の検証・補正
  const ratios: number[] = [];
  for (const f of res.floors)
    for (const r of f.rooms) if (r.labeledTatami && r.area > 0.5) ratios.push((r.labeledTatami * 1.62) / r.area);
  if (ratios.length >= 2) {
    ratios.sort((a, b) => a - b);
    const med = ratios[Math.floor(ratios.length / 2)];
    const within = ratios.filter((x) => Math.abs(x / med - 1) < 0.12).length;
    if (Math.abs(med - 1) > 0.25 && within >= ratios.length * 0.6 && sc.source === 'default' && !opts.scaleDenominator) {
      const k = Math.sqrt(med);
      sc = { ...sc, mmPerPt: sc.mmPerPt * k, denominator: null };
      scaleSource = 'area';
      warnings.push(`縮尺表記が見つからないため、帖数表記から縮尺を推定しました (約1/${Math.round(sc.mmPerPt / PT_TO_MM)})`);
      mmPages = pages.map((p) => pageToMm(p, sc.mmPerPt));
      res = assembleModel(mmPages, opts.name ?? '新築計画', warnings);
    } else if (Math.abs(med - 1) > 0.15) {
      warnings.push('図面の帖数と解析した面積に差があります。縮尺をご確認ください');
    }
  }
  if (sc.source === 'default' && scaleSource === 'default') warnings.push('縮尺を特定できなかったため 1/100 として解析しました');

  const { thicknesses, ...model } = res;
  return {
    ...model,
    report: {
      pages: pages.length,
      scaleDenominator: sc.denominator,
      mmPerPt: sc.mmPerPt,
      scaleSource,
      wallThicknesses: thicknesses,
      warnings,
      timingsMs: { analyze: Math.round(performance.now() - t0) },
    },
  };
}

export async function parseFloorPlanPdf(data: Uint8Array, pdfjs: PdfjsLike, opts: ParseOptions = {}): Promise<BuildingModel> {
  const t0 = performance.now();
  const pages = await loadPdfVectors(data, pdfjs, opts);
  const t1 = performance.now();
  opts.onProgress?.('壁・開口部・部屋を解析中', 0.6);
  const model = modelFromVectors(pages, opts);
  model.report.timingsMs.load = Math.round(t1 - t0);
  opts.onProgress?.('完了', 1);
  return model;
}
