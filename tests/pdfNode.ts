import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseFloorPlanPdf } from '../src/parser';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));

export async function parseSample(file: string) {
  const data = new Uint8Array(readFileSync(path.resolve(here, '../samples', file)));
  return parseFloorPlanPdf(data, pdfjs as any, {
    cMapUrl: path.join(pdfjsDir, 'cmaps') + '/',
    standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + '/',
  });
}
