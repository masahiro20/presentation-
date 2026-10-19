/**
 * 間取りプレゼンの MCP サーバー（stdio）。Claude Code・Codex などから、このリポジトリの読み取り・木造チェック・図面・DXF・概算見積を呼べる。
 *
 *   npm run mcp                      # 手で起動（JSON-RPC を 1 行 1 メッセージで stdin/stdout）
 *   claude mcp add madori -- npx tsx scripts/mcp-server.ts     # Claude Code に登録（リポジトリのフォルダで）
 *   codex mcp add madori -- npx tsx scripts/mcp-server.ts      # Codex CLI に登録
 *
 * リポジトリ直下の .mcp.json にも同じ設定があるので、Claude Code でこのフォルダを開くとそのまま使える。
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createMcpServer, createNodeContext } from '../src/mcp/node';

const ctx = createNodeContext(pdfjs as never, import.meta.url);
const server = createMcpServer(ctx);

const log = (...a: unknown[]) => process.stderr.write(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');

let buf = '';
let chain: Promise<void> = Promise.resolve();

function send(res: unknown) {
  process.stdout.write(JSON.stringify(res) + '\n');
}

function handleLine(line: string) {
  const s = line.trim();
  if (!s) return;
  let msg: unknown;
  try {
    msg = JSON.parse(s);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON として読めませんでした' } });
    return;
  }
  // メッセージは届いた順に処理する（model_id の順序が狂わないように）
  chain = chain
    .then(async () => {
      const res = await server.handleMany(msg);
      if (res) send(res);
    })
    .catch((e) => {
      log('mcp error:', (e as Error).message);
    });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    handleLine(line);
  }
});
process.stdin.on('end', () => {
  if (buf.trim()) handleLine(buf);
  void chain.then(() => process.exit(0));
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
log(`madori MCP server ready (stdio) — tools: ${server.tools.map((t) => t.name).join(', ')}`);
