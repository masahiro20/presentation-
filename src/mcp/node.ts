/**
 * Node 向けの入口（stdio サーバーと本番の /api/mcp が共通で使う）。
 * vite.mcp.config.ts でこのファイルを 1 つの ESM（api/_bundle/mcp-core.mjs）に束ねる:
 * Vercel の関数は TypeScript を束ねずに ESM として動かすので、拡張子の無い import が並ぶ src/ をそのまま読めないため。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createMcpServer, SERVER_INFO, INSTRUCTIONS } from './server';
import { createContext, TOOLS, summarizeModel, resolveModel, storeModel } from './tools';
import type { McpContext } from './tools';
import type { PdfjsLike } from '../parser';

export { createMcpServer, SERVER_INFO, INSTRUCTIONS, createContext, TOOLS, summarizeModel, resolveModel, storeModel };
export type { McpContext };

/** pdfjs-dist の場所（CMap・標準フォント）。Vercel では /var/task/node_modules、ローカルでは require.resolve */
export function findPdfjsDir(fromUrl?: string): string | null {
  const cands = [path.join(process.cwd(), 'node_modules', 'pdfjs-dist')];
  if (fromUrl) {
    try {
      const req = createRequire(fromUrl);
      cands.push(path.dirname(req.resolve('pdfjs-dist/package.json')));
    } catch {
      // 見つからなければ cwd 側に任せる
    }
  }
  for (const c of cands) if (existsSync(path.join(c, 'cmaps'))) return c;
  return null;
}

/** pdf.js と CMap の場所を組み込んだ Node 用のコンテキスト */
export function createNodeContext(pdfjs: PdfjsLike, fromUrl?: string): McpContext {
  const dir = findPdfjsDir(fromUrl);
  return createContext({
    pdfjs,
    pdfOptions: dir
      ? { cMapUrl: path.join(dir, 'cmaps') + '/', standardFontDataUrl: path.join(dir, 'standard_fonts') + '/', wasmUrl: path.join(dir, 'wasm') + '/' }
      : {},
  });
}
