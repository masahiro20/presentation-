/**
 * 写真仕上げをツールの中で: Google AI Studio の API キーで Gemini の画像生成モデルを呼び、下絵を写真に仕上げる。
 *
 * - キーはこのパソコンのブラウザにだけ保存（localStorage）。呼び出しはブラウザから直接（サーバーを通さないので費用は Google の分だけ。
 *   無料枠のあるモデルなら 0 円）。
 * - 1 回の呼び出し = 下絵 1 枚＋素材ボード＋お手本（最大 3 枚）＋説明文 → 画像 1 枚。
 * - 仕上がりと下絵の輪郭を照合し（窓・屋根・壁の線がどれだけ残っているか）、点数と「ずれた所」の画像を返す。
 * - 枚数と費用の目安を月ごとに数える（M6）。
 *
 * API: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent（ヘッダー x-goog-api-key）
 * 応答: candidates[0].content.parts[].inlineData（base64 の画像）
 */

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const KEY_STORE = 'madori.geminiKey';
const MODEL_STORE = 'madori.geminiImageModel';
const USAGE_STORE = 'madori.aiFinishUsage';

/** 既定のモデル（無料枠のある軽い方）。一覧から選び直せる */
export const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';

/** 画像 1 枚あたりの費用の目安（円）。Google の料金（2025 年末）を 1 ドル 150 円で。無料枠の中なら 0 円 */
export const COST_PER_IMAGE_JPY: { match: RegExp; jpy: number; label: string }[] = [
  { match: /pro.*image|image.*pro/i, jpy: 20, label: 'Pro（高品質）' },
  { match: /flash.*image|image.*flash|nano/i, jpy: 6, label: 'Flash（速い）' },
  { match: /./, jpy: 10, label: 'その他' },
];

export function costPerImage(model: string): { jpy: number; label: string } {
  const hit = COST_PER_IMAGE_JPY.find((c) => c.match.test(model)) ?? COST_PER_IMAGE_JPY[COST_PER_IMAGE_JPY.length - 1];
  return { jpy: hit.jpy, label: hit.label };
}

// ---- キーとモデル（このブラウザだけ） ----
let memoKey = '';
let memoModel = '';
const listeners = new Set<() => void>();

export function getGeminiKey(): string {
  try {
    return (localStorage.getItem(KEY_STORE) ?? memoKey).trim();
  } catch {
    return memoKey;
  }
}
export function setGeminiKey(key: string) {
  memoKey = key.trim();
  try {
    if (memoKey) localStorage.setItem(KEY_STORE, memoKey);
    else localStorage.removeItem(KEY_STORE);
  } catch {
    /* 保存できない環境では開いている間だけ */
  }
  for (const f of listeners) f();
}
export function getImageModel(): string {
  try {
    return (localStorage.getItem(MODEL_STORE) ?? memoModel).trim() || DEFAULT_IMAGE_MODEL;
  } catch {
    return memoModel || DEFAULT_IMAGE_MODEL;
  }
}
export function setImageModel(model: string) {
  memoModel = model.trim();
  try {
    if (memoModel) localStorage.setItem(MODEL_STORE, memoModel);
    else localStorage.removeItem(MODEL_STORE);
  } catch {
    /* 保存できない環境では開いている間だけ */
  }
  for (const f of listeners) f();
}
export function onAiFinishChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

// ---- モデルの一覧（画像を出せるもの） ----
export interface ImageModelInfo {
  /** API に渡す名前（models/ を除いたもの） */
  name: string;
  displayName: string;
  description?: string;
}

/** モデル一覧の応答から、画像を出せる generateContent のモデルを選ぶ（純粋な関数） */
export function pickImageModels(list: { name?: string; displayName?: string; description?: string; supportedGenerationMethods?: string[] }[]): ImageModelInfo[] {
  const out: ImageModelInfo[] = [];
  for (const m of list) {
    const name = (m.name ?? '').replace(/^models\//, '');
    if (!name) continue;
    const methods = m.supportedGenerationMethods ?? [];
    if (!methods.includes('generateContent')) continue;
    // 画像生成: 名前に image を含む Gemini（imagen は predict で別の API なので除く）
    if (!/image/i.test(name) || /^imagen/i.test(name) || /embedding/i.test(name)) continue;
    out.push({ name, displayName: m.displayName ?? name, description: m.description });
  }
  // Flash（軽い・無料枠のある方）を先に
  return out.sort((a, b) => (/flash/i.test(b.name) ? 1 : 0) - (/flash/i.test(a.name) ? 1 : 0) || a.name.localeCompare(b.name));
}

export async function listImageModels(key: string, fetchFn: typeof fetch = fetch): Promise<ImageModelInfo[]> {
  const res = await fetchFn(`${GEMINI_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw new Error(await errorMessage(res));
  const js = (await res.json()) as { models?: Parameters<typeof pickImageModels>[0] };
  return pickImageModels(js.models ?? []);
}

/** キーが使えるか（モデル一覧が取れるか） */
export async function checkGeminiKey(key: string, fetchFn: typeof fetch = fetch): Promise<{ ok: true; models: ImageModelInfo[] } | { ok: false; message: string }> {
  if (!key) return { ok: false, message: 'キーが入っていません' };
  try {
    const models = await listImageModels(key, fetchFn);
    if (!models.length) return { ok: false, message: 'キーは使えますが、画像を出せるモデルが見つかりません（Google AI Studio のキーか確かめてください）' };
    return { ok: true, models };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// ---- 呼び出し ----
export interface FinishRequest {
  /** 説明文（日本語＋英語） */
  prompt: string;
  /** 下絵（data URL。JPEG か PNG） */
  draft: string;
  /** 素材ボード（data URL） */
  board?: string;
  /** お手本の写真（data URL。最大 3 枚） */
  refs?: string[];
  /** 縦横比（下絵と同じに） */
  aspectRatio?: '16:9' | '4:3' | '3:2' | '1:1' | '9:16';
  /** 大きさ（Pro だけ '2K'・'4K' が効く） */
  imageSize?: '1K' | '2K' | '4K';
}

/** data URL → { mimeType, data(base64) } */
export function splitDataUrl(url: string): { mimeType: string; data: string } {
  const m = url.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s) ?? url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!m) throw new Error('画像の形式が読めません（data URL ではありません）');
  return { mimeType: m[1], data: m[2] };
}

/** generateContent の本文（純粋な関数）。添付の順: 下絵 → 素材ボード → お手本 */
export function buildGenerateBody(req: FinishRequest, withImageConfig = true): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];
  const order: string[] = ['1 枚目: 下絵（この構図・間取り・窓と戸の位置と数・屋根の形のまま仕上げる元の画像）'];
  if (req.board) order.push(`${order.length + 1} 枚目: 素材ボード（この色・質感に合わせる）`);
  (req.refs ?? []).slice(0, 3).forEach((_, i) => order.push(`${order.length + 1} 枚目: お手本の写真 ${i + 1}（写りの雰囲気だけ参考にする。建物や間取りは真似しない）`));
  parts.push({ text: `${req.prompt}\n\n添付画像の順番:\n${order.map((o) => `- ${o}`).join('\n')}\n出力は仕上げた画像 1 枚だけ。文字は書かないでください。` });
  const img = (url: string) => {
    const { mimeType, data } = splitDataUrl(url);
    return { inline_data: { mime_type: mimeType, data } };
  };
  parts.push(img(req.draft));
  if (req.board) parts.push(img(req.board));
  for (const r of (req.refs ?? []).slice(0, 3)) parts.push(img(r));
  const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] };
  if (withImageConfig && (req.aspectRatio || req.imageSize)) {
    const ic: Record<string, unknown> = {};
    if (req.aspectRatio) ic.aspectRatio = req.aspectRatio;
    if (req.imageSize) ic.imageSize = req.imageSize;
    generationConfig.imageConfig = ic;
  }
  return { contents: [{ role: 'user', parts }], generationConfig };
}

export interface FinishResult {
  /** 仕上がり（data URL） */
  url: string;
  /** モデルが添えた文章（あれば） */
  text?: string;
  usage?: { promptTokens: number; outputTokens: number };
  model: string;
}

/** 応答から画像を取り出す（純粋な関数）。画像が無ければ理由を Error に */
export function parseGenerateResponse(js: unknown, model: string): FinishResult {
  const r = js as { candidates?: { content?: { parts?: { text?: string; inlineData?: { mimeType: string; data: string }; inline_data?: { mime_type: string; data: string } }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string }; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  if (r.promptFeedback?.blockReason) throw new Error(`安全性の判定で止められました（${r.promptFeedback.blockReason}）。説明文の表現を変えるか、別の構図で試してください`);
  const cand = r.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  let url = '';
  const texts: string[] = [];
  for (const p of parts) {
    const inl = p.inlineData ?? (p.inline_data ? { mimeType: p.inline_data.mime_type, data: p.inline_data.data } : undefined);
    if (inl?.data && !url) url = `data:${inl.mimeType || 'image/png'};base64,${inl.data}`;
    else if (p.text) texts.push(p.text);
  }
  if (!url) {
    const reason = cand?.finishReason;
    if (reason && reason !== 'STOP') throw new Error(`画像が返りませんでした（${reason}${texts.length ? `: ${texts.join(' ').slice(0, 120)}` : ''}）`);
    throw new Error(`画像が返りませんでした${texts.length ? `（${texts.join(' ').slice(0, 160)}）` : '（このモデルは画像を出せないかもしれません。モデルを選び直してください）'}`);
  }
  const u = r.usageMetadata;
  return { url, text: texts.join('\n') || undefined, usage: u ? { promptTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0 } : undefined, model };
}

/** HTTP エラーを日本語に（キー・有効化・無料枠・混雑） */
export function describeHttpError(status: number, body: string): string {
  let msg = body;
  try {
    const js = JSON.parse(body) as { error?: { message?: string; status?: string } };
    msg = js.error?.message ?? body;
  } catch {
    /* 本文がそのまま */
  }
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) return 'キーが正しくありません（Google AI Studio の「Get API key」で作ったキーを貼り付けてください）';
  if (status === 403) return `このキーでは使えません（${msg.slice(0, 140)}）。AI Studio のキーか、プロジェクトで Generative Language API が有効か確かめてください`;
  if (status === 429) return `上限に当たりました（${/quota|free|billing/i.test(msg) ? '無料枠か日・分あたりの回数の上限' : '混雑'}）。少し待つか、モデルを変えるか、AI Studio で有料枠を有効にしてください（${msg.slice(0, 120)}）`;
  if (status === 404) return `モデルが見つかりません（${msg.slice(0, 120)}）。モデルを一覧から選び直してください`;
  if (status >= 500) return `Google 側のエラーです（${status}）。少し待ってもう一度試してください`;
  return `${status}: ${msg.slice(0, 200)}`;
}

async function errorMessage(res: Response): Promise<string> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* 本文なし */
  }
  return describeHttpError(res.status, body);
}

/** 下絵を写真に仕上げる（1 枚）。imageConfig を受け付けないモデルには無しで試し直す */
export async function generateFinish(key: string, model: string, req: FinishRequest, opts: { signal?: AbortSignal; fetchFn?: typeof fetch } = {}): Promise<FinishResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const call = async (withImageConfig: boolean) =>
    fetchFn(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(buildGenerateBody(req, withImageConfig)),
      signal: opts.signal,
    });
  let res = await call(true);
  if (res.status === 400) {
    const body = await res.text();
    if (/imageConfig|image_config|aspectRatio|aspect_ratio|imageSize|image_size|Unknown name/i.test(body)) res = await call(false);
    else throw new Error(describeHttpError(400, body));
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  const js = await res.json();
  const out = parseGenerateResponse(js, model);
  recordUsage(model, out.usage?.outputTokens ?? 0);
  return out;
}

// ---- 枚数と費用の目安（M6） ----
export interface UsageMonth {
  count: number;
  byModel: Record<string, number>;
  outputTokens: number;
}
export const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

export function readUsage(): Record<string, UsageMonth> {
  try {
    return JSON.parse(localStorage.getItem(USAGE_STORE) || '{}') as Record<string, UsageMonth>;
  } catch {
    return {};
  }
}
export function recordUsage(model: string, outputTokens: number, d = new Date()) {
  const all = readUsage();
  const k = monthKey(d);
  const m = (all[k] ??= { count: 0, byModel: {}, outputTokens: 0 });
  m.count++;
  m.byModel[model] = (m.byModel[model] ?? 0) + 1;
  m.outputTokens += outputTokens;
  try {
    localStorage.setItem(USAGE_STORE, JSON.stringify(all));
  } catch {
    /* 保存できない環境では数えない */
  }
}
/** 今月の枚数と費用の目安（純粋な関数） */
export function usageSummary(all: Record<string, UsageMonth>, d = new Date()): { count: number; jpy: number; text: string } {
  const m = all[monthKey(d)];
  if (!m?.count) return { count: 0, jpy: 0, text: '今月はまだ仕上げていません' };
  const jpy = Object.entries(m.byModel).reduce((s, [model, n]) => s + costPerImage(model).jpy * n, 0);
  return { count: m.count, jpy, text: `今月 ${m.count} 枚（有料枠なら目安 ¥${jpy.toLocaleString()}。無料枠の中なら 0 円）` };
}

// ---- 下絵との照合（輪郭） ----
/**
 * グレースケールの輝度（0〜255、幅 w × 高さ h）から、強い輪郭の点を 1、それ以外を 0 にする（Sobel）。
 * しきい値は画像ごとの勾配の分布から決める（上位 8% を輪郭とする）
 */
export function edgeMask(lum: Uint8ClampedArray | Uint8Array | number[], w: number, h: number, topRatio = 0.08): Uint8Array {
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1] + lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1];
      const gy = -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1] + lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1];
      g[i] = Math.hypot(gx, gy);
    }
  const sorted = Array.from(g).filter((v) => v > 0).sort((a, b) => b - a);
  const th = sorted.length ? Math.max(40, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * topRatio))]) : 40;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < g.length; i++) if (g[i] >= th) out[i] = 1;
  return out;
}

/**
 * 下絵の輪郭が仕上がりにどれだけ残っているか（0〜1）と、残っていない点のマスク。
 * 下絵の輪郭の点ごとに、仕上がりの輪郭が tol 画素以内にあれば「残っている」
 */
export function edgeRecall(draft: Uint8Array, result: Uint8Array, w: number, h: number, tol = 2): { score: number; missing: Uint8Array } {
  const missing = new Uint8Array(w * h);
  let total = 0;
  let kept = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!draft[i]) continue;
      total++;
      let hit = false;
      for (let dy = -tol; dy <= tol && !hit; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -tol; dx <= tol; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (result[yy * w + xx]) {
            hit = true;
            break;
          }
        }
      }
      if (hit) kept++;
      else missing[i] = 1;
    }
  return { score: total ? kept / total : 1, missing };
}

/** 点数の言葉 */
export function scoreLabel(score: number): { text: string; level: 'ok' | 'check' | 'bad' } {
  if (score >= 0.72) return { text: '形はほぼそのまま', level: 'ok' };
  if (score >= 0.55) return { text: '少し違う所があります（確認）', level: 'check' };
  return { text: '形が変わっている可能性（窓・屋根・壁を確かめてください）', level: 'bad' };
}

/** 画像を縮めて輝度の配列に（ブラウザ専用） */
async function luminance(url: string, w: number, h: number): Promise<Uint8ClampedArray> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) out[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  return out;
}

/** 下絵と仕上がりの照合: 点数と、ずれた所（下絵の線が消えた所）を赤で重ねた画像 */
export async function compareWithDraft(draftUrl: string, resultUrl: string, width = 384): Promise<{ score: number; label: ReturnType<typeof scoreLabel>; overlayUrl: string }> {
  const img = new Image();
  img.src = resultUrl;
  await img.decode();
  const w = width;
  const h = Math.max(8, Math.round((width * img.naturalHeight) / img.naturalWidth));
  const [a, b] = await Promise.all([luminance(draftUrl, w, h), luminance(resultUrl, w, h)]);
  const ea = edgeMask(a, w, h);
  const eb = edgeMask(b, w, h);
  const { score, missing } = edgeRecall(ea, eb, w, h);
  // 重ね画像: 仕上がりを薄くして、消えた線を赤に
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) {
    if (missing[i]) {
      id.data[i * 4] = 230;
      id.data[i * 4 + 1] = 40;
      id.data[i * 4 + 2] = 40;
      id.data[i * 4 + 3] = 255;
    } else {
      id.data[i * 4] = Math.round(id.data[i * 4] * 0.55 + 115);
      id.data[i * 4 + 1] = Math.round(id.data[i * 4 + 1] * 0.55 + 115);
      id.data[i * 4 + 2] = Math.round(id.data[i * 4 + 2] * 0.55 + 115);
    }
  }
  ctx.putImageData(id, 0, 0);
  return { score, label: scoreLabel(score), overlayUrl: c.toDataURL('image/png') };
}

/** 下絵（PNG の data URL など）を JPEG に縮めて送る大きさに（長辺 maxSide） */
export async function toJpegDataUrl(url: string, maxSide = 1600, quality = 0.9): Promise<string> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}
