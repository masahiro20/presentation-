import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createMcpServer, type JsonRpcResponse } from '../src/mcp/server';
import { createContext, TOOLS, type ToolResult } from '../src/mcp/tools';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));

const ctx = createContext({
  pdfjs: pdfjs as never,
  pdfOptions: { cMapUrl: path.join(pdfjsDir, 'cmaps') + '/', standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + '/' },
});
const server = createMcpServer(ctx);

let nextId = 1;
async function call(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
  const res = await server.handle({ jsonrpc: '2.0', id: nextId++, method, params });
  if (!res) throw new Error('no response');
  return res;
}
async function tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await call('tools/call', { name, arguments: args });
  expect(res.error).toBeUndefined();
  return res.result as ToolResult;
}
const textOf = (r: ToolResult) => r.content.map((c) => c.text).join('');
const jsonOf = (r: ToolResult) => JSON.parse(textOf(r));

describe('MCP サーバー（JSON-RPC）', () => {
  it('initialize はプロトコル版・能力・説明を返す', async () => {
    const res = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const r = res.result as { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string }; instructions: string };
    expect(r.protocolVersion).toBe('2025-06-18');
    expect(r.capabilities.tools).toBeTruthy();
    expect(r.serverInfo.name).toBe('madori-presentation');
    expect(r.instructions).toContain('parse_floor_plan');
  });

  it('知らないプロトコル版は最新で返す', async () => {
    const res = await call('initialize', { protocolVersion: '1999-01-01' });
    expect((res.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
  });

  it('通知には応答しない', async () => {
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('tools/list は全ツールを JSON Schema 付きで返す', async () => {
    const res = await call('tools/list');
    const tools = (res.result as { tools: { name: string; inputSchema: { type: string } }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
  });

  it('無いメソッド・無いツールはエラー', async () => {
    const a = await call('nope/nothing');
    expect(a.error?.code).toBe(-32601);
    const b = await call('tools/call', { name: 'nope', arguments: {} });
    expect(b.error?.code).toBe(-32602);
  });

  it('ツールの実行エラーは isError の結果で返す（JSON-RPC エラーにしない）', async () => {
    const r = await tool('wood_check', { model_id: 'missing' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('model_id');
  });

  it('バッチと壊れた入力', async () => {
    const out = (await server.handleMany([
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'b', method: 'prompts/list' },
    ])) as JsonRpcResponse[];
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
    const bad = (await server.handle('garbage')) as JsonRpcResponse;
    expect(bad.error?.code).toBe(-32600);
  });

  it('prompts/get は手順入りのメッセージを返す', async () => {
    const res = await call('prompts/get', { name: 'plan_review', arguments: { source: 'plan.pdf', focus: '構造' } });
    const r = res.result as { messages: { content: { text: string } }[] };
    expect(r.messages[0].content.text).toContain('wood_check');
    expect(r.messages[0].content.text).toContain('構造');
  });
});

describe('MCP ツール（サンプル平面図）', () => {
  let modelId = '';
  let model: unknown;

  beforeAll(async () => {
    const pdf = readFileSync(path.resolve(here, '../samples/sample_house_A3.pdf'));
    const r = await tool('parse_floor_plan', { pdf_base64: pdf.toString('base64'), name: 'sample', include_model: true });
    expect(r.isError).toBeFalsy();
    const j = jsonOf(r);
    modelId = j.model_id;
    model = j.model;
    expect(j.floors.length).toBeGreaterThanOrEqual(2);
    expect(j.floors[0].rooms.length).toBeGreaterThan(3);
    expect(j.total_floor_area_m2).toBeGreaterThan(50);
    expect(Array.isArray(j.wood_check)).toBe(true);
  }, 120000);

  it('入力が無いときは説明つきで失敗する', async () => {
    const r = await tool('parse_floor_plan', {});
    expect(r.isError).toBe(true);
    const bad = await tool('parse_floor_plan', { pdf_base64: Buffer.from('hello').toString('base64') });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('%PDF');
  });

  it('wood_check は model_id でも model（JSON）でも動く', async () => {
    const a = jsonOf(await tool('wood_check', { model_id: modelId }));
    expect(Array.isArray(a.issues)).toBe(true);
    const b = jsonOf(await tool('wood_check', { model }));
    expect(b.issues.length).toBe(a.issues.length);
    // プロジェクトファイルの形でも受ける
    const c = jsonOf(await tool('wood_check', { model: { format: 'madori-project-v1', model } }));
    expect(c.issues.length).toBe(a.issues.length);
  });

  it('floor_plan_svg は SVG を返し、無い階は失敗する', async () => {
    const r = await tool('floor_plan_svg', { model_id: modelId, level: 1, sheet: true, project: 'テスト様邸 新築工事' });
    expect(r.isError).toBeFalsy();
    const svg = textOf(r);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('テスト様邸');
    const miss = await tool('floor_plan_svg', { model_id: modelId, level: 9 });
    expect(miss.isError).toBe(true);
  });

  it('export_dxf は DXF を返す', async () => {
    const dxf = textOf(await tool('export_dxf', { model_id: modelId }));
    expect(dxf).toContain('SECTION');
    expect(dxf).toContain('ENTITIES');
  });

  it('estimate は数量と金額を返す', async () => {
    const e = jsonOf(await tool('estimate', { model_id: modelId, grade: 'S' }));
    expect(e.grade).toBe('S');
    expect(e.totals.total_floor_area_m2).toBeGreaterThan(50);
    expect(e.quantities.extWall.value).toBeGreaterThan(50);
    expect(e.total).toBeGreaterThan(10_000_000);
    expect(e.categories.length).toBeGreaterThan(5);
  });

  it('catalog は検索・カテゴリ一覧ができる', async () => {
    const cats = jsonOf(await tool('catalog', { list_categories: true }));
    expect(cats.categories.some((c: { id: string }) => c.id === 'extWall')).toBe(true);
    const k = jsonOf(await tool('catalog', { query: 'LINE' }));
    expect(k.count).toBeGreaterThan(0);
    expect(k.items.every((p: { name: string; maker: string; code: string }) => /line/i.test(`${p.maker} ${p.name} ${p.code}`))).toBe(true);
    const none = jsonOf(await tool('catalog', { query: 'zzzz-no-such-product' }));
    expect(none.count).toBe(0);
  });

  it('get_model / list_models', async () => {
    const m = jsonOf(await tool('get_model', { model_id: modelId }));
    expect(m.floors.length).toBeGreaterThanOrEqual(2);
    const l = jsonOf(await tool('list_models', {}));
    expect(l.models.some((x: { model_id: string }) => x.model_id === modelId)).toBe(true);
  });
});
