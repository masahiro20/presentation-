import { defineConfig } from 'vite';

/**
 * MCP サーバーの中身（src/mcp + 読み取り・図面・見積）を Node 用の 1 つの ESM に束ねる。
 * 出力: api/_bundle/mcp-core.mjs（api/mcp.ts が読む。_ で始まるので Vercel は関数として扱わない）
 *   npm run build:mcp
 * three・pdfjs-dist などのパッケージは束ねず、import のまま残す（Vercel が node_modules から同梱する）
 */
export default defineConfig({
  // public/ の中身（テクスチャ・モデル）は関数には要らない
  publicDir: false,
  build: {
    ssr: 'src/mcp/node.ts',
    outDir: 'api/_bundle',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: 'node22',
    rollupOptions: { output: { entryFileNames: 'mcp-core.mjs', format: 'es' } },
  },
  ssr: { target: 'node' },
  logLevel: 'warn',
});
