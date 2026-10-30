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
  constructor(private readonly opts: { cMapUrl?: string; standardFontDataUrl?: string; wasmUrl?: string }) {}
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const base = kind === 'cMapUrl' ? this.opts.cMapUrl : kind === 'standardFontDataUrl' ? this.opts.standardFontDataUrl : kind === 'wasmUrl' ? this.opts.wasmUrl : null;
    if (!base) throw new Error(`${kind} is not available`);
    try {
      const r = await fetch(base + filename);
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch {
      // 次の方法で取得
    }
    const dir = kind === 'cMapUrl' ? 'cmaps' : kind === 'wasmUrl' ? 'wasm' : 'standard_fonts';
    const r = await fetch(`${assetBase()}pdfjs/b64/${dir}/${filename}.txt`);
    if (!r.ok) throw new Error(`Unable to load ${filename}`);
    const bin = atob((await r.text()).trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
}

export async function parsePdfInBrowser(data: Uint8Array, opts: Omit<ParseOptions, 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl' | 'BinaryDataFactory'> = {}) {
  const base = assetBase();
  return parseFloorPlanPdf(data, pdfjs as any, {
    ...opts,
    cMapUrl: `${base}pdfjs/cmaps/`,
    standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
    wasmUrl: `${base}pdfjs/wasm/`,
    BinaryDataFactory: FallbackBinaryDataFactory,
  });
}

/**
 * PDF の文字をそのまま取り出す（ヒアリングシート・要望書のメモ用）。
 * 行は y 座標でまとめ、同じ行の文字は x 順に並べる。文字の無いスキャン PDF は空文字になる
 */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  const base = assetBase();
  const doc = await pdfjs.getDocument({ data, cMapUrl: `${base}pdfjs/cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}pdfjs/standard_fonts/`, useSystemFonts: false } as Parameters<typeof pdfjs.getDocument>[0]).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const items = (tc.items as { str?: string; transform?: number[] }[]).filter((it) => it.str && it.transform).map((it) => ({ s: it.str!, x: it.transform![4], y: it.transform![5] }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: string[] = [];
    let cur: typeof items = [];
    let y: number | null = null;
    for (const it of items) {
      if (y != null && Math.abs(it.y - y) > 3) {
        lines.push(cur.sort((a, b) => a.x - b.x).map((c) => c.s).join(''));
        cur = [];
      }
      cur.push(it);
      y = it.y;
    }
    if (cur.length) lines.push(cur.sort((a, b) => a.x - b.x).map((c) => c.s).join(''));
    pages.push(lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'));
  }
  await doc.destroy();
  return pages.filter(Boolean).join('\n\n');
}

export { pdfjs };
