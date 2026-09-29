/** ブラウザ用の pdf.js 読み込み */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { parseFloorPlanPdf, type ParseOptions } from './index';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function assetBase() {
  return new URL('./', window.location.href).toString();
}

export async function parsePdfInBrowser(data: Uint8Array, opts: Omit<ParseOptions, 'cMapUrl' | 'standardFontDataUrl'> = {}) {
  const base = assetBase();
  return parseFloorPlanPdf(data, pdfjs as any, {
    ...opts,
    cMapUrl: `${base}pdfjs/cmaps/`,
    standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
  });
}

export { pdfjs };
