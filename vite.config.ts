import { defineConfig, type Plugin } from 'vite';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

/** pdf.js の CMap（日本語フォント用）と標準フォントを /pdfjs/ 以下で配信・同梱する */
function pdfjsAssets(): Plugin {
  const root = path.resolve('node_modules/pdfjs-dist');
  const dirs = ['cmaps', 'standard_fonts'];
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url && /^\/pdfjs\/(cmaps|standard_fonts)\/([^?]+)/.exec(req.url);
        if (!m) return next();
        const file = path.join(root, m[1], decodeURIComponent(m[2]));
        if (!existsSync(file)) return next();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const d of dirs) {
        const dir = path.join(root, d);
        for (const f of readdirSync(dir)) {
          const p = path.join(dir, f);
          if (!statSync(p).isFile()) continue;
          this.emitFile({ type: 'asset', fileName: `pdfjs/${d}/${f}`, source: readFileSync(p) });
        }
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [pdfjsAssets()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
  },
} as any);
