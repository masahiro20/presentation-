/** ブラウザ用の pdf.js 読み込み */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { parseFloorPlanPdf, type ParseOptions } from './index';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function assetBase() {
  return new URL('./', window.location.href).toString();
}

/**
 * CMap・標準フォントの読み込み。通常はバイナリを取得し、取得できない公開先では
 * base64 テキスト版（/pdfjs/b64/…/*.txt）を使う。
 */
class FallbackBinaryDataFactory {
  constructor(private readonly opts: { cMapUrl?: string; standardFontDataUrl?: string }) {}
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const base = kind === 'cMapUrl' ? this.opts.cMapUrl : kind === 'standardFontDataUrl' ? this.opts.standardFontDataUrl : null;
    if (!base) throw new Error(`${kind} is not available`);
    try {
      const r = await fetch(base + filename);
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch {
      // 次の方法で取得
    }
    const dir = kind === 'cMapUrl' ? 'cmaps' : 'standard_fonts';
    const r = await fetch(`${assetBase()}pdfjs/b64/${dir}/${filename}.txt`);
    if (!r.ok) throw new Error(`Unable to load ${filename}`);
    const bin = atob((await r.text()).trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
}

export async function parsePdfInBrowser(data: Uint8Array, opts: Omit<ParseOptions, 'cMapUrl' | 'standardFontDataUrl' | 'BinaryDataFactory'> = {}) {
  const base = assetBase();
  return parseFloorPlanPdf(data, pdfjs as any, {
    ...opts,
    cMapUrl: `${base}pdfjs/cmaps/`,
    standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
    BinaryDataFactory: FallbackBinaryDataFactory,
  });
}

export { pdfjs };
