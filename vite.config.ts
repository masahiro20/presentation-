import { defineConfig, type Plugin } from 'vite';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * バイナリを配信できない公開先（プレビュー等）向けに、日本語の CMap と標準フォントを
 * base64 テキスト（/pdfjs/b64/<dir>/<file>.txt）としても同梱する
 */
const B64_CMAP = /^(Uni(JIS|Japan)|90|83pv|Add|Adobe-Japan1|EUC|Ext|H\.|V\.|Hankaku|Hiragana|Katakana|NWP|RKSJ|Roman|WP-Symbol)/;
const needsB64 = (dir: string, f: string) => (dir === 'cmaps' ? B64_CMAP.test(f) : dir === 'wasm' ? /\.wasm$/.test(f) : /\.(pfb|ttf)$/.test(f));

/** pdf.js の CMap（日本語フォント用）と標準フォントを /pdfjs/ 以下で配信・同梱する */
function pdfjsAssets(): Plugin {
  const root = path.resolve('node_modules/pdfjs-dist');
  // wasm: スキャン図面の JBIG2・JPEG2000 画像のデコーダ
  const dirs = ['cmaps', 'standard_fonts', 'wasm'];
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const b = req.url && /^\/pdfjs\/b64\/(cmaps|standard_fonts|wasm)\/([^?]+)\.txt/.exec(req.url);
        if (b) {
          const file = path.join(root, b[1], decodeURIComponent(b[2]));
          if (!existsSync(file)) return next();
          res.setHeader('Content-Type', 'text/plain');
          res.end(readFileSync(file).toString('base64'));
          return;
        }
        const m = req.url && /^\/pdfjs\/(cmaps|standard_fonts|wasm)\/([^?]+)/.exec(req.url);
        if (!m) return next();
        const file = path.join(root, m[1], decodeURIComponent(m[2]));
        if (!existsSync(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
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
          if (needsB64(d, f)) this.emitFile({ type: 'asset', fileName: `pdfjs/b64/${d}/${f}.txt`, source: readFileSync(p).toString('base64') });
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
