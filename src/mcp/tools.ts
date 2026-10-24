/**
 * MCP（Model Context Protocol）で外部の AI エージェント（Claude Code・Codex など）に公開するツール。
 *
 * ブラウザに依存しない処理だけを集める: 図面の読み取り・木造の常識チェック・平面図 SVG・DXF・概算見積・仕上げカタログ。
 * ローカル（stdio: scripts/mcp-server.ts）と本番（Streamable HTTP: api/mcp.ts）の両方から同じ定義を使う。
 *
 * 間取りの受け渡し:
 *  - parse_floor_plan が返す model_id を次のツールに渡す（同じプロセス／同じインスタンスの間だけ有効）
 *  - 本番の /api/mcp はインスタンスが入れ替わると model_id が消えるので、include_model: true で受け取った model を
 *    そのまま渡せるようにしてある（アプリで保存したプロジェクトファイル .json も渡せる）
 */
import type { BuildingModel, Floor, FurnitureItem } from '../core/types';
import { ROOM_TYPE_LABEL } from '../core/types';
import { parseFloorPlanPdf, parseDxf, type PdfjsLike, type ParseOptions, type ModuleMode } from '../parser';
import { woodCheck } from '../parser/woodCheck';
import { floorPlanSvg } from '../drawings/plan';
import { modelToDxf } from '../drawings/dxf';
import { takeoff, AREA_FIELDS } from '../estimate/areas';
import { computeEstimate, newChoice } from '../estimate/calc';
import type { Grade } from '../estimate/catalog';
import { FINISH_CATEGORIES } from '../coordinate/catalog';
import { DEFAULT_DESIGN, exteriorById } from '../styles/presets';

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: (string | number)[];
  items?: JsonSchema;
  default?: unknown;
  additionalProperties?: boolean;
}

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface McpContext {
  /** PDF を読むための pdf.js（Node では legacy ビルド）。無ければ PDF は読めず、DXF とプロジェクトファイルだけ */
  pdfjs?: PdfjsLike;
  /** CMap・標準フォントの場所 */
  pdfOptions?: Pick<ParseOptions, 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'>;
  /** 読み取った間取りの保管（model_id → モデル） */
  models: Map<string, BuildingModel>;
  /** URL から PDF を取る（無ければ pdf_url は使えない） */
  fetch?: typeof fetch;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  run(args: Record<string, unknown>, ctx: McpContext): Promise<ToolResult>;
}

const MAX_MODELS = 20;
let seq = 0;

export function createContext(init: Partial<McpContext> = {}): McpContext {
  return { models: new Map(), fetch: typeof fetch === 'function' ? fetch : undefined, ...init };
}

function text(value: unknown, structured?: Record<string, unknown>): ToolResult {
  const t = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) };
}

function fail(msg: string): ToolResult {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v)) return +v;
  return undefined;
}

function bool(v: unknown, dflt: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return /^(true|1|yes|on)$/i.test(v);
  return dflt;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

function isModel(v: unknown): v is BuildingModel {
  return !!v && typeof v === 'object' && Array.isArray((v as BuildingModel).floors) && typeof (v as BuildingModel).northAngleDeg === 'number';
}

/** model / model_id / プロジェクトファイルのどれかから間取りを取り出す */
export function resolveModel(args: Record<string, unknown>, ctx: McpContext): BuildingModel {
  // project は parse_floor_plan ではプロジェクトファイル（オブジェクト）、floor_plan_svg では工事名（文字列）なので、オブジェクトのときだけ間取りとして見る
  let m: unknown = args.model ?? (args.project && typeof args.project === 'object' ? args.project : undefined) ?? args.project_json;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch {
      throw new Error('model は JSON として読めませんでした');
    }
  }
  if (m && typeof m === 'object' && (m as { format?: string }).format?.startsWith('madori-project')) m = (m as { model: unknown }).model;
  if (isModel(m)) return m;
  const id = args.model_id;
  if (typeof id === 'string' && id) {
    const found = ctx.models.get(id);
    if (!found) throw new Error(`model_id "${id}" は見つかりません（サーバーが再起動したか、別のインスタンスです）。parse_floor_plan をやり直すか、include_model: true で受け取った model をそのまま渡してください`);
    return found;
  }
  throw new Error('model_id（parse_floor_plan の結果）か model（include_model で受け取った JSON／アプリで保存したプロジェクトファイル）を指定してください');
}

export function storeModel(ctx: McpContext, model: BuildingModel): string {
  const id = `m${Date.now().toString(36)}${(++seq).toString(36)}`;
  ctx.models.set(id, model);
  while (ctx.models.size > MAX_MODELS) {
    const oldest = ctx.models.keys().next().value;
    if (oldest === undefined) break;
    ctx.models.delete(oldest);
  }
  return id;
}

const LIVABLE_EXCLUDE = new Set(['void', 'balcony', 'porch', 'garage']);

function furnitureOf(model: BuildingModel, f: Floor): FurnitureItem[] {
  return model.furniture?.find((x) => x.level === f.level)?.items ?? f.planItems ?? [];
}

/** エージェントが一度に把握できる要約（寸法は mm、面積は ㎡） */
export function summarizeModel(model: BuildingModel, modelId?: string) {
  const floors = model.floors.map((f) => {
    const livable = f.rooms.filter((r) => !LIVABLE_EXCLUDE.has(r.type)).reduce((s, r) => s + r.area, 0);
    const openings: Record<string, number> = {};
    for (const o of f.openings) openings[o.kind] = (openings[o.kind] ?? 0) + 1;
    const xs = f.outline.flat().map((p) => p.x);
    const ys = f.outline.flat().map((p) => p.y);
    return {
      level: f.level,
      floor_area_m2: r2(livable),
      floor_area_tsubo: r1(livable / 3.30579),
      bbox_mm: xs.length ? { w: Math.round(Math.max(...xs) - Math.min(...xs)), d: Math.round(Math.max(...ys) - Math.min(...ys)) } : null,
      rooms: f.rooms.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        type_label: ROOM_TYPE_LABEL[r.type] ?? r.type,
        area_m2: r2(r.area),
        tatami: r1(r.area / 1.62),
        labeled_tatami: r.labeledTatami ?? null,
      })),
      walls: f.walls.length,
      exterior_walls: f.walls.filter((w) => w.exterior).length,
      openings,
      stairs: f.stairs.map((s) => ({ kind: s.kind, goes_up: s.goesUp, w_mm: Math.round(s.maxX - s.minX), d_mm: Math.round(s.maxY - s.minY) })),
      furniture: furnitureOf(model, f).map((it) => ({ kind: it.kind, ...(it.kitchenType ? { kitchen_type: it.kitchenType } : {}), room_id: it.roomId ?? null })),
    };
  });
  const issues = woodCheck(model);
  return {
    ...(modelId ? { model_id: modelId } : {}),
    name: model.name,
    floors,
    total_floor_area_m2: r2(floors.reduce((s, f) => s + f.floor_area_m2, 0)),
    module: model.module ? { size_mm: model.module.size, grid_mm: model.module.grid, fit: r2(model.module.fit), snapped: model.module.snapped, source: model.module.source } : null,
    north_angle_deg: model.northAngleDeg,
    north_detected: model.report.northDetected ?? null,
    scale: { denominator: model.report.scaleDenominator, source: model.report.scaleSource },
    wall_thicknesses_mm: model.report.wallThicknesses,
    site: model.site ? { roads: model.site.roads.map((r) => ({ side: r.side, width_mm: r.widthMm ?? null, source: r.source })), area_m2: model.site.areaM2 ?? null } : null,
    warnings: model.report.warnings,
    wood_check: issues.map((i) => ({ severity: i.severity, title: i.title })),
  };
}

function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const MODEL_ARGS: Record<string, JsonSchema> = {
  model_id: { type: 'string', description: 'parse_floor_plan が返した model_id' },
  model: { type: 'object', description: 'parse_floor_plan に include_model: true を付けて受け取った model、またはアプリで保存したプロジェクトファイル（.json）の中身。model_id の代わりに渡す' },
};

export const TOOLS: ToolDef[] = [
  {
    name: 'parse_floor_plan',
    title: '平面図を読み取る',
    description:
      '平面図（CAD から出力したベクター PDF、または DXF）を読み取り、階・部屋（用途・面積・帖数）・壁・開口・階段・家具・木造モジュール・方位・接道を返します。' +
      '結果の model_id を wood_check / floor_plan_svg / export_dxf / estimate に渡せます。' +
      '入力は pdf_base64・pdf_url・dxf_text・project（アプリで保存した .json）のどれか 1 つ。',
    inputSchema: {
      type: 'object',
      properties: {
        pdf_base64: { type: 'string', description: 'PDF の中身（base64。data: URL でも可）' },
        pdf_url: { type: 'string', description: 'PDF の URL（サーバーから取りに行く）' },
        dxf_text: { type: 'string', description: 'DXF の中身（テキスト、実寸 mm）' },
        project: { type: 'object', description: 'アプリで保存したプロジェクトファイル（madori-project-v1）の中身' },
        name: { type: 'string', description: '図面の名前（物件名など）' },
        scale_denominator: { type: 'number', description: '縮尺を手で指定（100 → 1/100）。省略時は図面から自動判定' },
        module: { type: 'string', enum: ['auto', 'shaku', 'meter', 'none'], description: '木造のモジュール: auto=図面から判定（既定）, shaku=尺 910, meter=メーター 1000, none=格子へ寄せない' },
        include_model: { type: 'boolean', description: 'true にすると結果に model（間取りの JSON 全体）も入れる。サーバーが入れ替わっても他のツールに渡せる', default: false },
      },
    },
    async run(args, ctx) {
      const name = typeof args.name === 'string' ? args.name : undefined;
      const module = typeof args.module === 'string' && ['auto', 'shaku', 'meter', 'none'].includes(args.module) ? (args.module as ModuleMode) : 'auto';
      const scaleDenominator = num(args.scale_denominator);
      let model: BuildingModel;
      if (args.project && typeof args.project === 'object') {
        model = resolveModel({ model: args.project }, ctx);
      } else if (typeof args.dxf_text === 'string' && args.dxf_text.trim()) {
        model = parseDxf(args.dxf_text, { name, module });
      } else if ((typeof args.pdf_base64 === 'string' && args.pdf_base64) || (typeof args.pdf_url === 'string' && args.pdf_url)) {
        if (!ctx.pdfjs) return fail('このサーバーは PDF を読めません（pdf.js が無い環境）。DXF か、アプリで保存したプロジェクトファイルを渡してください');
        let data: Uint8Array;
        if (typeof args.pdf_base64 === 'string' && args.pdf_base64) data = decodeBase64(args.pdf_base64);
        else {
          if (!ctx.fetch) return fail('この環境では URL から PDF を取れません。pdf_base64 で渡してください');
          const url = String(args.pdf_url);
          if (!/^https?:\/\//i.test(url)) return fail('pdf_url は http(s) の URL にしてください');
          const res = await ctx.fetch(url);
          if (!res.ok) return fail(`PDF を取得できませんでした: HTTP ${res.status}`);
          data = new Uint8Array(await res.arrayBuffer());
        }
        if (data.length < 8 || String.fromCharCode(...data.slice(0, 4)) !== '%PDF') return fail('PDF ではないデータです（先頭が %PDF ではありません）');
        model = await parseFloorPlanPdf(data, ctx.pdfjs, { ...ctx.pdfOptions, name: name ?? 'plan.pdf', scaleDenominator, module });
      } else {
        return fail('pdf_base64・pdf_url・dxf_text・project のどれかを指定してください');
      }
      const rooms = model.floors.reduce((s, f) => s + f.rooms.length, 0);
      if (!model.floors.length || rooms === 0) return fail('平面図を認識できませんでした。CAD から出力したベクター形式の PDF（スキャン画像ではないもの）をお試しください。warnings: ' + model.report.warnings.join(' / '));
      const id = storeModel(ctx, model);
      const summary = summarizeModel(model, id);
      const out = bool(args.include_model, false) ? { ...summary, model } : summary;
      return text(out, out as unknown as Record<string, unknown>);
    },
  },
  {
    name: 'wood_check',
    title: '木造の常識チェック',
    description:
      '在来軸組の設計士が図面を見たときの違和感をルールで出します: つながらない短い壁（読み取りミスの疑い）・格子に乗らない壁の端・2 階の直下率と外壁の受け・梁のスパン（2 間超）・開口だらけの外壁・出入口の無い部屋・上下階の階段位置・UB／便所の寸法。' +
      'severity: warn=要確認, info=設計上の注意, ok=問題なし。',
    inputSchema: { type: 'object', properties: { ...MODEL_ARGS } },
    async run(args, ctx) {
      const model = resolveModel(args, ctx);
      const issues = woodCheck(model).map((i) => ({ id: i.id, level: i.level ?? null, severity: i.severity, title: i.title, detail: i.detail, fixable: !!i.fix, fix_label: i.fix?.label ?? null }));
      const out = { warn: issues.filter((i) => i.severity === 'warn').length, info: issues.filter((i) => i.severity === 'info').length, issues };
      return text(out, out);
    },
  },
  {
    name: 'floor_plan_svg',
    title: '平面図（SVG）',
    description: '読み取った間取りの清書平面図を SVG で返します。sheet: true で A3 図枠（表題欄・面積表・建具表・1 間の格子）付き。',
    inputSchema: {
      type: 'object',
      properties: {
        ...MODEL_ARGS,
        level: { type: 'number', description: '階（1, 2, 3）。既定 1' },
        sheet: { type: 'boolean', description: '図枠に入れる（既定 false）' },
        project: { type: 'string', description: '図枠の工事名（例: 〇〇様邸 新築工事）' },
        designer: { type: 'string', description: '図枠の設計者・会社名' },
        show_furniture: { type: 'boolean', description: '家具を描く（既定 true）' },
        show_dims: { type: 'boolean', description: '寸法を描く（既定 true）' },
      },
    },
    async run(args, ctx) {
      const model = resolveModel(args, ctx);
      const level = num(args.level) ?? 1;
      const f = model.floors.find((x) => x.level === level);
      if (!f) return fail(`${level}階がありません（ある階: ${model.floors.map((x) => x.level).join(', ')}）`);
      const sheet = bool(args.sheet, false)
        ? {
            project: typeof args.project === 'string' && args.project ? args.project : `${model.name} 新築工事`,
            drawing: `${level}階 平面図`,
            date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
            designer: typeof args.designer === 'string' ? args.designer : '',
            no: `A-${level}`,
          }
        : undefined;
      const svg = floorPlanSvg(model, f, { sheet, showFurniture: bool(args.show_furniture, true), showDims: bool(args.show_dims, true), title: `${level}階平面図` });
      return { content: [{ type: 'text', text: svg }] };
    },
  },
  {
    name: 'export_dxf',
    title: 'DXF 書き出し',
    description: '読み取った間取り（壁芯・開口・部屋名・階段）を CAD へ戻すための DXF（実寸 mm、階ごとのレイヤー）を返します。',
    inputSchema: { type: 'object', properties: { ...MODEL_ARGS } },
    async run(args, ctx) {
      const model = resolveModel(args, ctx);
      return { content: [{ type: 'text', text: modelToDxf(model) }] };
    },
  },
  {
    name: 'estimate',
    title: '概算見積',
    description:
      '間取りから数量（延床・施工面積・外壁・屋根・基礎外周・建具数など）を拾い、社内の積算シート（P シリーズ／S シリーズ）の既定仕様で概算見積（工事別の金額・税込合計・坪単価）を出します。金額は円。',
    inputSchema: {
      type: 'object',
      properties: {
        ...MODEL_ARGS,
        grade: { type: 'string', enum: ['P', 'S'], description: 'シリーズ。既定 P' },
        roof_type: { type: 'string', enum: ['gable', 'hip', 'shed', 'flat'], description: '屋根の形（既定: 標準テイストの屋根）' },
        pitch: { type: 'number', description: '屋根勾配（寸。例 3 = 3寸）' },
        eaves_mm: { type: 'number', description: '軒の出 (mm)' },
      },
    },
    async run(args, ctx) {
      const model = resolveModel(args, ctx);
      const grade: Grade = args.grade === 'S' ? 'S' : 'P';
      const ext = exteriorById(DEFAULT_DESIGN.exteriorId);
      const roofType = typeof args.roof_type === 'string' && ['gable', 'hip', 'shed', 'flat'].includes(args.roof_type) ? (args.roof_type as 'gable' | 'hip' | 'shed' | 'flat') : ext.roof.type;
      const areas = takeoff(model, { grade, eavesMm: num(args.eaves_mm) ?? ext.roof.eaves, pitch: num(args.pitch) ?? ext.roof.pitch, roofType, solido: ext.accent ? ext.accentRule : 'none' });
      const est = computeEstimate(areas, newChoice(grade, areas));
      const quantities: Record<string, { label: string; value: number; unit: string }> = {};
      for (const fdef of AREA_FIELDS) quantities[fdef.key] = { label: fdef.label, value: r2(Number(areas[fdef.key]) || 0), unit: fdef.unit };
      const out = {
        grade,
        totals: {
          total_floor_area_m2: r2(areas.totalArea),
          total_floor_area_tsubo: r2(areas.totalTsubo),
          construction_area_m2: r2(areas.constArea),
          construction_area_tsubo: r2(areas.constTsubo),
        },
        quantities,
        categories: est.categories.map((c) => ({ id: c.def.id, no: c.def.no, name: c.def.name, amount: Math.round(c.amount), lines: c.lines.length })),
        subtotal: Math.round(est.subtotal),
        adjust: Math.round(est.adjust),
        tax: Math.round(est.tax),
        total: Math.round(est.total),
        per_tsubo: Math.round(est.perTsubo),
        note: '既定仕様の概算です。仕上げ・設備を選ぶと金額が変わります（アプリのコーディネート・見積画面）',
      };
      return text(out, out);
    },
  },
  {
    name: 'catalog',
    title: '仕上げ・設備カタログ',
    description: 'アプリで選べる仕上げ・設備（外壁・屋根・床・キッチン・浴室・建具など、メーカー・品番つき）を検索します。query はメーカー名・商品名・品番・色の部分一致。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '検索語（例: LINE KITCHEN, ジョリパット, ブラック）' },
        category: { type: 'string', description: 'カテゴリ id（例: extWall, kitchen）。categories だけ知りたいときは list_categories: true' },
        part: { type: 'string', enum: ['外部', '内部', '設備'], description: '部位で絞る' },
        list_categories: { type: 'boolean', description: 'true でカテゴリ一覧だけ返す' },
      },
    },
    async run(args) {
      if (bool(args.list_categories, false)) {
        const cats = FINISH_CATEGORIES.map((c) => ({ id: c.id, label: c.label, part: c.part, products: c.products.length }));
        return text({ categories: cats }, { categories: cats });
      }
      const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const items: Record<string, unknown>[] = [];
      for (const c of FINISH_CATEGORIES) {
        if (typeof args.category === 'string' && args.category && c.id !== args.category) continue;
        if (typeof args.part === 'string' && args.part && c.part !== args.part) continue;
        for (const p of c.products) {
          const hay = `${p.maker} ${p.name} ${p.code} ${p.color ?? ''} ${c.label}`.toLowerCase();
          if (q && !hay.includes(q)) continue;
          items.push({ category: c.id, category_label: c.label, part: c.part, id: p.id, maker: p.maker, name: p.name, code: p.code, color: p.color ?? null, note: p.note ?? null });
        }
      }
      const out = { count: items.length, items: items.slice(0, 200) };
      return text(out, out);
    },
  },
  {
    name: 'get_model',
    title: '間取り JSON を取り出す',
    description: 'model_id の間取り（BuildingModel の JSON 全体）を返します。別のサーバーに渡したり、保存したりする用。',
    inputSchema: { type: 'object', properties: { model_id: MODEL_ARGS.model_id }, required: ['model_id'] },
    async run(args, ctx) {
      const model = resolveModel({ model_id: args.model_id }, ctx);
      return { content: [{ type: 'text', text: JSON.stringify(model) }] };
    },
  },
  {
    name: 'list_models',
    title: '読み取り済みの間取り',
    description: 'このサーバーが覚えている model_id の一覧。',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const items = [...ctx.models.entries()].map(([id, m]) => ({ model_id: id, name: m.name, floors: m.floors.length }));
      return text({ models: items }, { models: items });
    },
  },
];

export function toolByName(name: string, tools: ToolDef[] = TOOLS): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}
