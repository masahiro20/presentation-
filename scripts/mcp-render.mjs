/**
 * MCP ツール render_views（ローカルの stdio サーバーだけ）: 読み取った間取りを 3D に立ち上げ、外観・内観のカットを PNG で返す。
 *
 * 仕組み: dist/（npm run build の出力）を一時的な HTTP サーバーで配信し、裏で Chrome（playwright-core）を起動して
 * render.html に間取り JSON を渡し、カットごとに撮影する。写真の仕上げ（グレーディング）はアプリと同じ。
 *
 * 必要なもの: Google Chrome（または Edge）。別の実行ファイルを使うときは環境変数 MADORI_CHROME にパス。
 * GPU の無いサーバーでは MADORI_SOFTWARE_GL=1（ソフトウェア描画。遅いが動く）。
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DIST = path.join(ROOT, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.hdr': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

/** dist と間取り JSON を配る一時サーバー（127.0.0.1 の空きポート） */
function serveDist(payloads) {
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const p = decodeURIComponent(url.pathname);
      if (p.startsWith('/__mcp/')) {
        const body = payloads.get(p.slice('/__mcp/'.length));
        if (!body) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
        return;
      }
      const file = path.join(DIST, p === '/' ? 'index.html' : p);
      if (!file.startsWith(DIST) || !existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

async function launchBrowser() {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error('playwright-core がありません。リポジトリで npm install を実行してください');
  }
  const args = ['--ignore-gpu-blocklist', ...(process.env.MADORI_SOFTWARE_GL ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])];
  const tries = [];
  if (process.env.MADORI_CHROME) tries.push({ executablePath: process.env.MADORI_CHROME });
  tries.push({ channel: 'chrome' }, { channel: 'msedge' }, {});
  const errors = [];
  for (const t of tries) {
    try {
      return await chromium.launch({ headless: true, args, ...t });
    } catch (e) {
      errors.push(`${JSON.stringify(t)}: ${(e && e.message ? e.message : String(e)).split('\n')[0]}`);
    }
  }
  throw new Error('Chrome を起動できませんでした。Google Chrome か Microsoft Edge を入れるか、環境変数 MADORI_CHROME に Chrome の実行ファイルを指定してください。\n' + errors.join('\n'));
}

const KINDS = ['exterior', 'interior', 'aerial', 'cutaway', 'section'];

export function createRenderTool(api) {
  const { resolveModel } = api;
  return {
    name: 'render_views',
    title: '3D パース（画像）',
    description:
      '読み取った間取りを 3D に立ち上げ、外観・内観などのカットを画像（仕上げ後は JPEG、grade: false なら PNG）で返します（ローカルのサーバーだけ。裏で Chrome を起動し、1 カット数秒〜数十秒）。' +
      'shots は "exterior"・"interior"・"aerial"・"cutaway"・"section" の種類名か、list_shots: true で得たカット id の配列。既定は外観 1 枚と内観 2 枚。' +
      'out_dir を渡すと画像をそのフォルダにも保存してパスを返します。design で外観・内観のテイスト（アプリのプリセット id）と時間帯を変えられます。',
    inputSchema: {
      type: 'object',
      properties: {
        model_id: { type: 'string', description: 'parse_floor_plan が返した model_id' },
        model: { type: 'object', description: '間取りの JSON（model_id の代わり）' },
        shots: { type: 'array', items: { type: 'string' }, description: 'カットの種類名か id。省略時は exterior 1 枚 + interior 2 枚' },
        list_shots: { type: 'boolean', description: 'true なら撮らずにカット一覧（id・題名）だけ返す' },
        max: { type: 'number', description: '撮る枚数の上限（既定 4、最大 12）' },
        width: { type: 'number', description: '幅 px（既定 1280）' },
        height: { type: 'number', description: '高さ px（既定 720）' },
        grade: { type: 'boolean', description: '写真の仕上げ（グレーディング）を掛ける（既定 true）' },
        design: {
          type: 'object',
          description: 'テイスト: { exteriorId, interiorId, timeOfDay: day|morning|evening|night }（アプリのプリセット id）',
          properties: { exteriorId: { type: 'string' }, interiorId: { type: 'string' }, timeOfDay: { type: 'string', enum: ['day', 'morning', 'evening', 'night'] } },
        },
        out_dir: { type: 'string', description: 'PNG を保存するフォルダ（省略時は画像だけ返す）' },
      },
    },
    async run(args, ctx) {
      const model = resolveModel(args, ctx);
      if (!existsSync(path.join(DIST, 'render.html'))) {
        return { content: [{ type: 'text', text: `dist/render.html がありません。リポジトリで npm run build を実行してください（${DIST}）` }], isError: true };
      }
      const W = Math.max(320, Math.min(3840, Math.round(Number(args.width) || 1280)));
      const H = Math.max(240, Math.min(2160, Math.round(Number(args.height) || 720)));
      const grade = args.grade === undefined ? true : !!args.grade;
      const maxN = Math.max(1, Math.min(12, Math.round(Number(args.max) || 4)));
      const payloads = new Map();
      const key = `${Date.now().toString(36)}.json`;
      payloads.set(key, JSON.stringify({ model, design: args.design && typeof args.design === 'object' ? args.design : undefined }));
      const { srv, port } = await serveDist(payloads);
      let browser;
      try {
        browser = await launchBrowser();
        const page = await browser.newPage({ viewport: { width: W, height: H } });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${port}/render.html?src=/__mcp/${key}`);
        await page.waitForFunction(() => window.__ready === true || window.__failed === true, null, { timeout: 180000 });
        if (await page.evaluate(() => window.__failed === true)) {
          return { content: [{ type: 'text', text: '3D の読み込みに失敗しました: ' + errors.join(' / ') }], isError: true };
        }
        const shots = await page.evaluate((a) => window.__shots(a), W / H);
        if (args.list_shots) {
          return { content: [{ type: 'text', text: JSON.stringify({ shots }, null, 1) }] };
        }
        const want = Array.isArray(args.shots) && args.shots.length ? args.shots.map(String) : ['exterior', 'interior', 'interior'];
        const picked = [];
        const usedIds = new Set();
        for (const w of want) {
          const byId = shots.find((s) => s.id === w && !usedIds.has(s.id));
          const byKind = KINDS.includes(w) ? shots.find((s) => s.kind === w && !usedIds.has(s.id)) : null;
          const s = byId ?? byKind;
          if (s) {
            picked.push(s);
            usedIds.add(s.id);
          }
          if (picked.length >= maxN) break;
        }
        if (!picked.length) return { content: [{ type: 'text', text: `該当するカットがありません。ある種類: ${[...new Set(shots.map((s) => s.kind))].join(', ')}（list_shots: true で id を確認できます）` }], isError: true };
        const content = [];
        const files = [];
        if (args.out_dir) mkdirSync(String(args.out_dir), { recursive: true });
        for (const s of picked) {
          const url = String(await page.evaluate(([id, w, h, g]) => window.__renderShot(id, w, h, g), [s.id, W, H, grade]));
          // 仕上げ後は JPEG、素のままは PNG の data URL が返る
          const mt = /^data:(image\/[\w+.-]+);base64,/.exec(url);
          const mime = mt ? mt[1] : 'image/png';
          const b64 = url.slice(url.indexOf(',') + 1);
          let file = null;
          if (args.out_dir) {
            file = path.join(String(args.out_dir), `${s.id.replace(/[^\w.-]+/g, '_')}.${mime === 'image/jpeg' ? 'jpg' : 'png'}`);
            writeFileSync(file, Buffer.from(b64, 'base64'));
            files.push(file);
          }
          content.push({ type: 'text', text: `${s.title}（${s.kind}, id=${s.id}）${s.caption ? ' — ' + s.caption : ''}${file ? '\n' + file : ''}` });
          content.push({ type: 'image', data: b64, mimeType: mime });
        }
        content.unshift({ type: 'text', text: JSON.stringify({ rendered: picked.map((s) => s.id), width: W, height: H, grade, files }, null, 1) });
        return { content };
      } finally {
        if (browser) await browser.close().catch(() => {});
        srv.close();
      }
    },
  };
}
