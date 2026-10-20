/** /api/mcp の起動失敗を調べる一時的な診断: それぞれの import を try/catch で試し、失敗の内容を返す（確認後に消す） */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export default async function handler(_req: unknown, res: { status(c: number): { json(b: unknown): void } }) {
  const out: Record<string, unknown> = { node: process.version, cwd: process.cwd() };
  try {
    out.cwdList = readdirSync(process.cwd()).slice(0, 40);
    out.apiDir = existsSync(path.join(process.cwd(), 'api')) ? readdirSync(path.join(process.cwd(), 'api')) : null;
    out.bundle = existsSync(path.join(process.cwd(), 'api', '_bundle')) ? readdirSync(path.join(process.cwd(), 'api', '_bundle')) : null;
    out.pdfjsDir = existsSync(path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'cmaps'));
  } catch (e) {
    out.fsError = (e as Error).message;
  }
  for (const [key, spec] of [
    ['three', 'three'],
    ['rounded', 'three/examples/jsm/geometries/RoundedBoxGeometry.js'],
    ['pdfjs', 'pdfjs-dist/legacy/build/pdf.mjs'],
    ['bundle', './_bundle/mcp-core.mjs'],
  ] as const) {
    try {
      const m = await import(/* @vite-ignore */ spec);
      out[key] = `ok (${Object.keys(m).length} exports)`;
    } catch (e) {
      out[key] = `FAIL ${(e as Error).stack?.split('\n').slice(0, 4).join(' | ')}`;
    }
  }
  res.status(200).json(out);
}
