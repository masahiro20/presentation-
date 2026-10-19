/**
 * MCP サーバーの中身（JSON-RPC 2.0）。輸送路（stdio / HTTP）に依存しない。
 *
 * 対応するメソッド: initialize, notifications/*, ping, tools/list, tools/call, prompts/list, prompts/get,
 * resources/list, resources/templates/list, logging/setLevel
 * 仕様: https://modelcontextprotocol.io/specification/2025-06-18
 */
import { TOOLS, toolByName, type McpContext, type ToolDef, type ToolResult } from './tools';

export const SERVER_INFO = { name: 'madori-presentation', title: '間取りプレゼン', version: '0.1.0' };
export const LATEST_PROTOCOL = '2025-06-18';
const KNOWN_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export const INSTRUCTIONS =
  '住宅の平面図（PDF／DXF）を読み取って、部屋・壁・開口・階段・家具を持つ間取りモデルにするサーバーです。' +
  'まず parse_floor_plan で model_id を得て、wood_check（木造の常識チェック）・floor_plan_svg（清書平面図）・export_dxf（CAD へ戻す）・estimate（概算見積）に渡してください。' +
  '寸法は mm、面積は ㎡（帖 = ㎡ ÷ 1.62）。木造は 910 の尺モジュール（半間 455 の格子）が基本です。' +
  '本番サーバー（/api/mcp）はインスタンスが入れ替わると model_id を忘れるので、長い作業では include_model: true で model を受け取り、次のツールに渡してください。';

const PROMPTS = [
  {
    name: 'plan_review',
    title: '間取りレビュー',
    description: '平面図を読み取り、木造の常識チェックと部屋構成を踏まえて、設計士向けのレビュー（日本語）を書く',
    arguments: [
      { name: 'source', description: 'PDF のパス／URL、または model_id', required: true },
      { name: 'focus', description: '重点（例: 構造, 動線, 収納, 採光）', required: false },
    ],
  },
];

function promptMessages(name: string, args: Record<string, string>): { description: string; messages: { role: 'user'; content: { type: 'text'; text: string } }[] } {
  if (name !== 'plan_review') throw rpcError(-32602, `prompt "${name}" はありません`);
  const src = args.source ?? '';
  const focus = args.focus ? `特に「${args.focus}」を重点的に見てください。` : '';
  return {
    description: PROMPTS[0].description,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `次の平面図をレビューしてください: ${src}\n` +
            '手順: (1) まだ model_id でなければ parse_floor_plan で読み取る（PDF は base64 で渡す） (2) wood_check を実行する (3) 部屋構成（各階の部屋・面積・帖数）、動線（玄関→LDK→水回り→階段）、' +
            '木造としての注意点（直下率・梁のスパン・耐力壁・階段の位置）、読み取りミスの疑いがある所、を分けて日本語で簡潔にまとめる。' +
            `寸法は mm、面積は ㎡ と帖で書く。${focus}`,
        },
      },
    ],
  };
}

export function rpcError(code: number, message: string, data?: unknown): JsonRpcError & { __rpc: true } {
  return { code, message, data, __rpc: true } as JsonRpcError & { __rpc: true };
}

function isRpcError(e: unknown): e is JsonRpcError & { __rpc: true } {
  return !!e && typeof e === 'object' && (e as { __rpc?: boolean }).__rpc === true;
}

export interface McpServer {
  /** 1 つのメッセージを処理する。通知（id の無いもの）には応答しない（null） */
  handle(msg: unknown): Promise<JsonRpcResponse | null>;
  /** 単体でもバッチ（配列）でも受ける */
  handleMany(input: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null>;
  tools: ToolDef[];
}

export function createMcpServer(ctx: McpContext, opts: { tools?: ToolDef[] } = {}): McpServer {
  const tools = opts.tools ?? TOOLS;

  async function dispatch(req: JsonRpcRequest): Promise<unknown> {
    const p = req.params ?? {};
    switch (req.method) {
      case 'initialize': {
        const asked = typeof p.protocolVersion === 'string' ? p.protocolVersion : LATEST_PROTOCOL;
        return {
          protocolVersion: KNOWN_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { subscribe: false, listChanged: false }, logging: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
      }
      case 'ping':
        return {};
      case 'logging/setLevel':
        return {};
      case 'tools/list':
        return { tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })) };
      case 'tools/call': {
        const name = typeof p.name === 'string' ? p.name : '';
        const tool = toolByName(name, tools);
        if (!tool) throw rpcError(-32602, `ツール "${name}" はありません。tools/list で確認してください`);
        const args = p.arguments && typeof p.arguments === 'object' ? (p.arguments as Record<string, unknown>) : {};
        try {
          const res: ToolResult = await tool.run(args, ctx);
          return res;
        } catch (e) {
          // ツールの実行時エラーは JSON-RPC のエラーではなく、結果として返す（仕様）
          return { content: [{ type: 'text', text: (e as Error).message || String(e) }], isError: true } satisfies ToolResult;
        }
      }
      case 'prompts/list':
        return { prompts: PROMPTS };
      case 'prompts/get': {
        const name = typeof p.name === 'string' ? p.name : '';
        const args = p.arguments && typeof p.arguments === 'object' ? (p.arguments as Record<string, string>) : {};
        return promptMessages(name, args);
      }
      case 'resources/list':
        return { resources: [] };
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      case 'resources/read':
        throw rpcError(-32002, 'リソースはありません');
      case 'completion/complete':
        return { completion: { values: [], hasMore: false } };
      default:
        throw rpcError(-32601, `メソッド "${req.method}" には対応していません`);
    }
  }

  async function handle(msg: unknown): Promise<JsonRpcResponse | null> {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'JSON-RPC 2.0 のリクエストではありません' } };
    }
    const req = msg as Partial<JsonRpcRequest> & { result?: unknown; error?: unknown };
    const hasId = req.id !== undefined && req.id !== null;
    // クライアントからの応答（サーバー発リクエストは出さないので無視）
    if (typeof req.method !== 'string') {
      if (hasId && (req.result !== undefined || req.error !== undefined)) return null;
      return { jsonrpc: '2.0', id: (req.id as number | string | null) ?? null, error: { code: -32600, message: 'method がありません' } };
    }
    if (req.jsonrpc !== '2.0') {
      return hasId ? { jsonrpc: '2.0', id: req.id as number | string, error: { code: -32600, message: 'jsonrpc は "2.0" にしてください' } } : null;
    }
    // 通知には応答しない
    if (!hasId || req.method.startsWith('notifications/')) {
      if (!hasId) return null;
    }
    try {
      const result = await dispatch(req as JsonRpcRequest);
      return hasId ? { jsonrpc: '2.0', id: req.id as number | string, result } : null;
    } catch (e) {
      if (!hasId) return null;
      if (isRpcError(e)) return { jsonrpc: '2.0', id: req.id as number | string, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } };
      return { jsonrpc: '2.0', id: req.id as number | string, error: { code: -32603, message: (e as Error).message || String(e) } };
    }
  }

  async function handleMany(input: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(input)) {
      if (!input.length) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: '空のバッチです' } };
      const out: JsonRpcResponse[] = [];
      for (const m of input) {
        const r = await handle(m);
        if (r) out.push(r);
      }
      return out.length ? out : null;
    }
    return handle(input);
  }

  return { handle, handleMany, tools };
}
