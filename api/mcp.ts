/**
 * 本番（Vercel）の MCP エンドポイント（Streamable HTTP）。
 *
 *   claude mcp add --transport http madori https://<このアプリの URL>/api/mcp
 *   codex mcp add madori --url https://<このアプリの URL>/api/mcp
 *
 * POST に JSON-RPC 2.0（単体／バッチ）を受けて JSON で返す。SSE のストリームは使わない（長いやり取りをしないため）。
 * リクエスト本文は Vercel の上限（4.5 MB）に収まる必要があるので、大きな PDF は pdf_url で渡す。
 * サーバーのインスタンスは入れ替わるので、model_id は同じインスタンスの間だけ有効（include_model: true で model を受け取れば続きができる）。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createMcpServer, SERVER_INFO } from '../src/mcp/server';
import { createContext } from '../src/mcp/tools';

const require = createRequire(import.meta.url);
const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));

const ctx = createContext({
  pdfjs: pdfjs as never,
  pdfOptions: {
    cMapUrl: path.join(pdfjsDir, 'cmaps') + '/',
    standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + '/',
  },
});
const server = createMcpServer(ctx);

interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface Res {
  status(code: number): Res;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  send(body?: string): void;
  end(): void;
}

export default async function handler(req: Req, res: Res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
  res.setHeader('Cache-Control', 'no-store');
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (method === 'DELETE') {
    // セッション終了。保持しているものは無いので常に成功
    res.status(200).end();
    return;
  }
  if (method === 'GET') {
    const accept = String(req.headers.accept ?? '');
    if (accept.includes('text/event-stream')) {
      // サーバーから自発的に送るものは無いので、SSE ストリームは開かない（仕様で許されている応答）
      res.status(405).json({ error: 'このサーバーは SSE ストリームを開きません。POST で JSON-RPC を送ってください' });
      return;
    }
    res.status(200).json({
      server: SERVER_INFO,
      transport: 'streamable-http',
      usage: 'POST にアプリケーション/JSON の JSON-RPC 2.0 を送る。Claude Code: claude mcp add --transport http madori <この URL>　Codex: codex mcp add madori --url <この URL>',
      tools: server.tools.map((t) => ({ name: t.name, title: t.title })),
    });
    return;
  }
  if (method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  let body: unknown = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON として読めませんでした' } });
      return;
    }
  }
  if (body === undefined || body === null) {
    res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '本文がありません' } });
    return;
  }
  try {
    const out = await server.handleMany(body);
    if (!out) {
      // 通知だけ（応答なし）
      res.status(202).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(out));
  } catch (e) {
    res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: (e as Error).message } });
  }
}
