/**
 * AI 設計士の確認: 読み込んだ図面（画像）と読み取り結果（要約）を、設計の知識を持った LLM（Gemini のテキスト・画像モデル）に見せ、
 *  - 読み取りの間違い（戸・窓の位置や種類、階段の向き、部屋名、壁）
 *  - 住宅として成り立っているか（動線・採光・プライバシー・家事動線・収納）
 *  - お客様に伝える要点（設計士の言葉）
 * を構造化して返してもらう。写真仕上げ（aiFinish）と同じキー（このブラウザだけに保存）で、ブラウザから直接呼ぶ。
 *
 * 「社内の設計ルール帳」: 設計士・コーディネーターの経験則や「ここは御社ではこうする」を文章で貯め、毎回 AI 設計士に渡す。
 * AI の指摘に納得できないときは「ルールに加える」で書き足す → 次回から守る（文句がそのまま学習になる）。
 */
import type { BuildingModel, Floor, Opening, Room } from '../core/types';
import { ROOM_TYPE_LABEL } from '../core/types';
import { pointInPolygon } from '../core/geometry';
import { GEMINI_BASE, describeHttpError, splitDataUrl } from './aiFinish';
import type { WoodIssue } from '../parser/woodCheck';

export const DEFAULT_REVIEW_MODEL = 'gemini-2.5-flash';
export const REVIEW_MODELS: { id: string; label: string; jpy: number }[] = [
  { id: 'gemini-2.5-flash', label: 'Flash（速い・約 1 円）', jpy: 1 },
  { id: 'gemini-2.5-pro', label: 'Pro（じっくり・約 10 円）', jpy: 10 },
];
const RULES_STORE = 'madori.designRules';
const MODEL_STORE = 'madori.geminiReviewModel';

export function getReviewModel(): string {
  try {
    return (localStorage.getItem(MODEL_STORE) ?? '').trim() || DEFAULT_REVIEW_MODEL;
  } catch {
    return DEFAULT_REVIEW_MODEL;
  }
}
export function setReviewModel(id: string) {
  try {
    localStorage.setItem(MODEL_STORE, id);
  } catch {
    /* 保存できない環境 */
  }
}
/** 社内の設計ルール帳（1 行 1 ルール） */
export function getDesignRules(): string {
  try {
    return localStorage.getItem(RULES_STORE) ?? '';
  } catch {
    return '';
  }
}
export function setDesignRules(text: string) {
  try {
    if (text.trim()) localStorage.setItem(RULES_STORE, text);
    else localStorage.removeItem(RULES_STORE);
  } catch {
    /* 保存できない環境 */
  }
}

const OPENING_LABEL: Record<Opening['kind'], string> = { window: '窓', door: '開き戸', sliding: '引戸', entrance: '玄関ドア', open: '開口', shutter: 'シャッター' };
const SIDE_LABEL = { n: '図面の上', s: '図面の下', e: '図面の右', w: '図面の左' } as const;

/** 戸・窓の両側の部屋名（外なら「外」） */
function sidesOf(f: Floor, o: Opening): [string, string] | null {
  const w = f.walls.find((x) => x.id === o.wallId);
  if (!w) return null;
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
  const ux = (w.b.x - w.a.x) / L;
  const uy = (w.b.y - w.a.y) / L;
  const t = (o.t0 + o.t1) / 2;
  const c = { x: w.a.x + ux * t, y: w.a.y + uy * t };
  const off = w.thickness / 2 + 250;
  const at = (p: { x: number; y: number }) => f.rooms.find((r) => pointInPolygon(p, r.polygon))?.name ?? '外';
  return [at({ x: c.x - uy * off, y: c.y + ux * off }), at({ x: c.x + uy * off, y: c.y - ux * off })];
}

/** 読み取り結果の要約（LLM に渡す文章。部屋ごとに戸・窓と隣、階段の向き、注記） */
export function buildDigest(model: BuildingModel, issues: WoodIssue[] = []): string {
  const lines: string[] = [];
  for (const f of model.floors.slice().sort((a, b) => a.level - b.level)) {
    lines.push(`【${f.level}階】`);
    for (const r of f.rooms) {
      if (r.type === 'void' && r.area < 1) continue;
      const ops: string[] = [];
      for (const o of f.openings) {
        const s = sidesOf(f, o);
        if (!s || (s[0] !== r.name && s[1] !== r.name)) continue;
        const other = s[0] === r.name ? s[1] : s[0];
        ops.push(`${OPENING_LABEL[o.kind]}${Math.round(o.t1 - o.t0)}→${other}`);
      }
      const label = ROOM_TYPE_LABEL[r.type] && ROOM_TYPE_LABEL[r.type] !== r.name ? `(${ROOM_TYPE_LABEL[r.type]})` : '';
      lines.push(`- ${r.name}${label} ${r.area.toFixed(1)}㎡${r.labeledTatami ? ` 図面${r.labeledTatami}帖` : ''}: ${ops.length ? ops.join(', ') : '戸・窓なし'}`);
    }
    for (const st of f.stairs) lines.push(`- 階段 ${st.kind === 'straight' ? '直' : '折り返し'} ${Math.round(st.maxX - st.minX)}×${Math.round(st.maxY - st.minY)} ${st.goesUp ? '昇り口' : '降り口'}=${SIDE_LABEL[st.entry]}`);
  }
  const warns = model.report.warnings.slice(0, 12);
  if (warns.length) lines.push('【読み取りの注記】', ...warns.map((w) => `- ${w.slice(0, 120)}`));
  const found = issues.filter((i) => i.severity !== 'ok').slice(0, 12);
  if (found.length) lines.push('【自動チェックの指摘】', ...found.map((i) => `- ${i.title}`));
  return lines.join('\n');
}

/** 住まいの成立の基本ルール（HOUSE_SENSE.md の要約。社内ルール帳はこの後に足す） */
export const BASE_RULES = [
  '図面は ARCHITREND ZERO の提案平面図。尺モジュール（半間 455、1 間 910）。外壁芯〜芯で寸法を見る',
  '玄関（土間）とホールの境は上がり框で戸は無い。玄関ドアは外開き',
  '個室・トイレ・浴室の戸はホール・廊下・脱衣室に開く。外に直接開く戸は玄関・勝手口・掃き出し窓（テラス戸）だけ',
  '浴室は洗面脱衣室を介して入る。トイレはホール・廊下・洗面から入り、LDK や寝室に直接開けない',
  '居室には外壁に窓（床面積の 1/7 以上）。同じ外壁面の窓は上端をそろえる（FL+2,000 か 2,200）',
  '階段の昇り口はホール・廊下・LDK に面し、降り口は上の階のホールに出る。13〜15 段で階高 2,900 前後',
  '寝室のある階にトイレ。キッチンと洗面脱衣室は近い（家事動線）。収納は床面積の 10〜12%',
  '戸の前と動線の上に家具を置かない。ベッドの両側に 600 の通路。ソファは TV か窓を向く',
];

export interface ReviewRequest {
  /** 図面の画像（data URL）。無ければ要約だけで判定 */
  image?: string;
  digest: string;
  /** 社内の設計ルール帳（1 行 1 ルール） */
  customRules?: string;
  pdfName?: string;
}

export interface ReviewFinding {
  kind: '読み取り' | '設計';
  severity: 'warn' | 'info';
  level?: number;
  room?: string;
  title: string;
  detail: string;
  fix?: string;
}
export interface ReviewResult {
  findings: ReviewFinding[];
  good: string[];
  summary: string;
  /** JSON として読めなかったときの生の文章 */
  raw?: string;
  usage?: { promptTokens: number; outputTokens: number };
  model: string;
}

/** LLM への依頼文（純粋な関数） */
export function buildReviewPrompt(req: ReviewRequest): string {
  const rules = [...BASE_RULES, ...(req.customRules ?? '').split('\n').map((s) => s.trim()).filter(Boolean)];
  return [
    'あなたは日本の木造住宅（在来軸組）のベテラン設計士です。工務店の社内ツールが提案図面の PDF を自動で読み取って 3D にしています。',
    '添付の図面の画像と、ツールの読み取り結果の要約を突き合わせて、次の 3 つを日本語で出してください。',
    '1. 読み取りの間違い: 図面と要約が食い違う所（戸・窓の位置や種類、階段の向き、部屋名と帖数、壁の有無、階の取り違え）。図面に書いてあることが正。',
    '2. 設計として気になる所: 人が住む家として成り立っているか（動線・採光・プライバシー・家事動線・収納・階段）。設計士が図面を見た瞬間に言う違和感だけ。細かい好みは言わない。',
    '3. 良い所と、お客様にこのプランを説明するときの要点（設計士の言葉で 2〜3 行）。',
    '',
    '社内の設計ルール（守るべき前提。これに反する指摘はしない）:',
    ...rules.map((r) => `- ${r}`),
    '',
    `図面: ${req.pdfName ?? '提案図面'}`,
    '読み取り結果の要約:',
    req.digest,
    '',
    '出力は次の JSON だけ（前後に文章やコードフェンスを付けない）。findings は多くても 10 件、重要な順。severity は読み取りミスや住めない所が warn、確認してほしい所が info。',
    '{"findings":[{"kind":"読み取り"|"設計","severity":"warn"|"info","level":1,"room":"部屋名","title":"短い見出し","detail":"根拠（図面のどこを見たか）","fix":"方眼での直し方か設計の直し方を 1 文"}],"good":["良い所"],"summary":"お客様への要点 2〜3 行"}',
  ].join('\n');
}

/** generateContent の本文（純粋な関数） */
export function buildReviewBody(req: ReviewRequest): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [{ text: buildReviewPrompt(req) }];
  if (req.image) {
    const { mimeType, data } = splitDataUrl(req.image);
    parts.push({ inline_data: { mime_type: mimeType, data } });
  }
  return { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } };
}

/** 応答の文章から JSON を取り出す（純粋な関数）。読めなければ raw に文章を入れて返す */
export function parseReviewText(text: string, model: string): ReviewResult {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  const body = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
  try {
    const js = JSON.parse(body) as Partial<ReviewResult> & { findings?: Partial<ReviewFinding>[] };
    const findings: ReviewFinding[] = (js.findings ?? [])
      .filter((f) => f && typeof f.title === 'string')
      .slice(0, 12)
      .map((f) => ({
        kind: f.kind === '読み取り' ? '読み取り' : '設計',
        severity: f.severity === 'warn' ? 'warn' : 'info',
        level: typeof f.level === 'number' ? f.level : undefined,
        room: typeof f.room === 'string' ? f.room : undefined,
        title: String(f.title).slice(0, 80),
        detail: typeof f.detail === 'string' ? f.detail.slice(0, 400) : '',
        fix: typeof f.fix === 'string' ? f.fix.slice(0, 200) : undefined,
      }));
    return { findings, good: Array.isArray(js.good) ? js.good.filter((g): g is string => typeof g === 'string').slice(0, 6) : [], summary: typeof js.summary === 'string' ? js.summary : '', model };
  } catch {
    return { findings: [], good: [], summary: '', raw: text.trim().slice(0, 2000), model };
  }
}

export function parseReviewResponse(js: unknown, model: string): ReviewResult {
  const r = js as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string }; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  if (r.promptFeedback?.blockReason) throw new Error(`安全性の判定で止められました（${r.promptFeedback.blockReason}）`);
  const text = (r.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('\n');
  if (!text.trim()) throw new Error(`文章が返りませんでした（${r.candidates?.[0]?.finishReason ?? '理由不明'}）`);
  const out = parseReviewText(text, model);
  const u = r.usageMetadata;
  if (u) out.usage = { promptTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0 };
  return out;
}

/** AI 設計士に見てもらう（1 回の呼び出し） */
export async function runDesignReview(key: string, model: string, req: ReviewRequest, opts: { signal?: AbortSignal; fetchFn?: typeof fetch } = {}): Promise<ReviewResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(buildReviewBody(req)),
    signal: opts.signal,
  });
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* 本文なし */
    }
    throw new Error(describeHttpError(res.status, body));
  }
  return parseReviewResponse(await res.json(), model);
}

/** 指摘をルール帳の 1 行にする（「違う」と言われた指摘を社内ルールに） */
export function ruleFromFinding(f: ReviewFinding): string {
  return `「${f.title}」${f.room ? `（${f.room}）` : ''}は御社では問題にしない: `;
}

export type { Room };
