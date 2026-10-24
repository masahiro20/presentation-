/**
 * 写真仕上げ（AI）: 現在の構図の高品質描画（または保存済みの写真品質パース）と輪郭の線画を、
 * Google の画像生成モデル（Gemini）に渡し、壁・窓・家具の位置を変えないよう指示して写真に仕上げる。
 *
 * - 個人・社内利用向け: Google AI Studio の API キーをブラウザに保存して直接呼ぶ（クレジットの購入は不要。無料枠の回数制限は AI Studio の表示に従う）。
 * - 2026 年の API は Interactions（/v1beta/interactions、gemini-nano-banana-2.1 など）が主。古いモデル（gemini-2.5-flash-image）は generateContent。
 *   どちらでも動くよう、モデル名に合わせて先に試し、だめなら他方へ切り替える。
 * - 仕上がりは必ず下絵と見比べる（AI は窓や家具の位置を変えることがある）。
 */
import { h, modal, progressModal, toast } from './dom';
import { state, uid, emit, type GalleryItem } from './state';
import type { StepCtx } from './app';
import type { Shot } from '../scene/shots';
import { renderStudio } from '../scene/studio';
import { renderPass } from '../scene/passes';
import { cutPrompt } from './cuts';

const KEY = 'geminiKey';
const MODEL_KEY = 'geminiModel';
export const DEFAULT_MODEL = 'gemini-nano-banana-2.1';
/** 画像の編集（入力画像あり）に対応したモデルの候補。AI Studio の表示に合わせて選ぶ */
export const MODEL_CANDIDATES = ['gemini-nano-banana-2.1', 'gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'];

export function getAiKey(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}
export function setAiKey(v: string) {
  try {
    localStorage.setItem(KEY, v.trim());
  } catch {
    // 保存できない環境では入力中だけ使う
  }
}
export function getAiModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}
export function setAiModel(v: string) {
  try {
    localStorage.setItem(MODEL_KEY, v.trim() || DEFAULT_MODEL);
  } catch {
    // 保存できない環境
  }
}

/** dataURL を縮小して JPEG/PNG の base64 にする（送信量を抑える） */
async function shrink(url: string, maxW: number, mime: 'image/jpeg' | 'image/png'): Promise<string> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const k = Math.min(1, maxW / img.width);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL(mime, 0.92).split(',')[1];
}

function friendly(status: number, body: string): string {
  if (status === 400 && /API key/i.test(body)) return 'API キーが正しくありません。AI Studio で発行したキーを貼り直してください';
  if (status === 401) return 'API キーが受け付けられませんでした。AI Studio で発行したキーを貼り直してください';
  if (status === 403) return 'このキーでは使えません（権限・地域の制限）。キーを発行し直すか、モデル名を確認してください';
  if (status === 404) return 'モデル名が見つかりません。「モデル名」を AI Studio に表示されている画像生成モデル（例: gemini-nano-banana-2.1）に変更してください';
  if (status === 429) return '無料枠の回数または速度の上限に達しました。しばらく待ってからもう一度お試しください';
  return `AI からエラーが返りました (${status}) ${body.slice(0, 160)}`;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(friendly(status, body));
  }
}

const GEOMETRY_RULE =
  '添付は 2 枚です。1 枚目は仕上げの下絵（3D で描いた画像）、2 枚目はその輪郭の線画です。' +
  '最重要: 壁・窓・ドア・家具・階段・キッチンの位置・数・大きさ・カメラの構図を 1 枚目と完全に一致させ、増減・移動・変形をしないこと。' +
  '変えてよいのは、素材の質感・光と影・反射・空と植栽のリアルさ・小物の質感だけです。人物・文字・ロゴ・透かしは加えないでください。出力は画像 1 枚のみ。';

/** 御社（ホームランディック）の建築写真の文法。仕上がりの雰囲気をそろえる */
const HL_LOOK =
  '仕上がりの雰囲気: 建築写真家が撮った竣工写真。自然光が主で、照明は電球色（2700K）が控えめに灯る。' +
  'コントラストは中程度、白飛び・黒つぶれなし、彩度は低めで落ち着いたグレージュ基調。縦の線は垂直（レンズシフト）。' +
  'レンジフードは薄い黒い箱、ペンダントは PH 5 風の白い笠か黒いドーム、ダイニングは Y チェアと木のテーブル、低いグレーの布ソファ。' +
  '床の木目・塗り壁の微細な凹凸・金属のつや消しを写真の解像感で描く。';

type Inline = { mime: 'image/jpeg' | 'image/png'; data: string };

/** Interactions API（2026 年の主経路） */
async function callInteractions(model: string, key: string, prompt: string, images: Inline[], signal: AbortSignal): Promise<string> {
  const body = {
    model,
    input: [{ type: 'text', text: prompt }, ...images.map((im) => ({ type: 'image', data: im.data, mime_type: im.mime }))],
    response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '16:9' },
  };
  let res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal });
  if (res.status === 400) {
    // response_format を受け付けない版の API: 指定なしで再試行
    const txt = await res.text();
    if (/response_format/i.test(txt)) {
      const { response_format: _rf, ...rest } = body;
      void _rf;
      res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(rest), signal });
    } else throw new ApiError(400, txt);
  }
  const txt = await res.text();
  if (!res.ok) throw new ApiError(res.status, txt);
  type Block = { type?: string; data?: string; mime_type?: string; mimeType?: string; text?: string };
  const js = JSON.parse(txt) as { status?: string; steps?: { type?: string; content?: Block[] }[]; outputs?: Block[]; output_image?: { data?: string; mime_type?: string }; errors?: { message?: string }[] };
  const pick = (b: Block | undefined) => (b?.type === 'image' && b.data ? `data:${b.mime_type ?? b.mimeType ?? 'image/png'};base64,${b.data}` : null);
  if (js.output_image?.data) return `data:${js.output_image.mime_type ?? 'image/png'};base64,${js.output_image.data}`;
  for (const st of js.steps ?? []) for (const b of st.content ?? []) {
    const u = pick(b);
    if (u) return u;
  }
  for (const b of js.outputs ?? []) {
    const u = pick(b);
    if (u) return u;
  }
  const why = js.errors?.[0]?.message ?? js.status ?? '画像が返りませんでした';
  throw new Error(`AI が画像を返しませんでした（${why}）。構図を変えるか、もう一度お試しください`);
}

/** generateContent（gemini-2.5-flash-image など古いモデル） */
async function callGenerateContent(model: string, key: string, prompt: string, images: Inline[], signal: AbortSignal): Promise<string> {
  const parts = [{ text: prompt }, ...images.map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } }))];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
    signal,
  });
  const txt = await res.text();
  if (!res.ok) throw new ApiError(res.status, txt);
  const js = JSON.parse(txt) as { candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string }; inline_data?: { mime_type: string; data: string }; text?: string }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
  for (const p of js.candidates?.[0]?.content?.parts ?? []) {
    const d = p.inlineData ?? (p.inline_data ? { mimeType: p.inline_data.mime_type, data: p.inline_data.data } : null);
    if (d?.data) return `data:${d.mimeType};base64,${d.data}`;
  }
  const why = js.promptFeedback?.blockReason ?? js.candidates?.[0]?.finishReason ?? '画像が返りませんでした';
  throw new Error(`AI が画像を返しませんでした（${why}）。構図を変えるか、もう一度お試しください`);
}

/** 1 枚を AI で仕上げる。戻り値は仕上がり画像の dataURL */
export async function finishWithAi(base: string, lines: string, prompt: string, signal: AbortSignal): Promise<string> {
  const key = getAiKey();
  if (!key) throw new Error('API キーが未設定です');
  const model = getAiModel();
  const images: Inline[] = [
    { mime: 'image/jpeg', data: await shrink(base, 1536, 'image/jpeg') },
    { mime: 'image/png', data: await shrink(lines, 1536, 'image/png') },
  ];
  const text = `${prompt}\n\n${HL_LOOK}\n\n${GEOMETRY_RULE}`;
  // モデル名から主経路を決め、だめなら他方へ
  const legacy = /^gemini-2\./.test(model) || /gemini-2\.0/.test(model);
  const order = legacy ? [callGenerateContent, callInteractions] : [callInteractions, callGenerateContent];
  let lastErr: unknown = null;
  for (const fn of order) {
    try {
      return await fn(model, key, text, images, signal);
    } catch (e) {
      lastErr = e;
      if ((e as Error).name === 'AbortError') throw e;
      // 認証・回数制限はもう一方でも同じなので止める
      if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 429)) throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 下絵: 保存済みの写真品質パース（同じ構図）があればそれ、無ければ高品質描画 */
async function baseImageFor(ctx: StepCtx, shot: Shot): Promise<string> {
  const saved = state.gallery.find((g) => g.shotId === shot.id && g.quality === 'photoreal' && !/写真仕上げ/.test(g.title));
  if (saved) return saved.url;
  const v = ctx.app.viewer;
  const interior = shot.kind === 'interior';
  return renderStudio(v, { width: 1536, height: 864, interior, exposure: interior ? 1.9 : 1.0 });
}

/** 1 構図を AI で仕上げてギャラリーに保存。戻り値は { base, out } */
export async function finishShot(ctx: StepCtx, shot: Shot, pm: { set: (f: number, msg: string) => void; signal: AbortSignal }, slot = { index: 0, total: 1 }): Promise<{ base: string; out: string }> {
  const v = ctx.app.viewer;
  const at = (f: number, msg: string) => pm.set((slot.index + f) / slot.total, `${shot.title}：${msg}`);
  at(0.05, '下絵を描いています');
  v.applyShot(shot);
  await new Promise((r) => setTimeout(r, 60));
  const base = await baseImageFor(ctx, shot);
  at(0.3, '線画を作っています');
  const lines = renderPass(v, 'lines', 1536, 864);
  at(0.45, 'AI に送っています（20〜60 秒ほど）');
  const p = cutPrompt(shot, 0);
  const out = await finishWithAi(base, lines, p.ja, pm.signal);
  const kind: GalleryItem['kind'] = shot.kind === 'section' || shot.kind === 'cutaway' ? 'other' : shot.kind;
  const item: GalleryItem = { id: uid('img'), title: `${shot.title}（写真仕上げ）`, caption: shot.caption, url: out, kind, quality: 'photoreal', shotId: `${shot.id}-ai` };
  const idx = state.gallery.findIndex((g) => g.shotId === item.shotId);
  if (idx >= 0) state.gallery.splice(idx, 1, item);
  else state.gallery.push(item);
  emit('gallery');
  return { base, out };
}

/** 現在の構図を AI で仕上げて、元画像と並べて見せる */
export async function runAiFinish(ctx: StepCtx, shot: Shot) {
  if (!getAiKey()) {
    toast('先に Google AI Studio の API キーを入力してください', 'error');
    return;
  }
  const pm = progressModal('AI で写真に仕上げています（形は下絵のまま固定します）');
  try {
    const { base, out } = await finishShot(ctx, shot, pm);
    const wrap = h(
      'div',
      { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px' },
      h('div', null, h('div', { class: 'hint' }, '下絵（このツールの 3D）'), h('img', { src: base, style: 'width:100%;border-radius:2px' })),
      h('div', null, h('div', { class: 'hint' }, '写真仕上げ（ギャラリーに保存しました）'), h('img', { src: out, style: 'width:100%;border-radius:2px' })),
    );
    modal('写真仕上げ', wrap, [{ label: '閉じる' }], true);
    toast('写真仕上げをギャラリーに保存しました。窓・壁・家具の位置が下絵と同じか、必ず見比べてください', 'ok', 7000);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'error', 9000);
  } finally {
    pm.close();
  }
}

/** 複数の構図をまとめて仕上げる（無料枠の回数に注意。1 枚ずつ順に） */
export async function runAiFinishBatch(ctx: StepCtx, shots: Shot[]) {
  if (!getAiKey()) {
    toast('先に Google AI Studio の API キーを入力してください', 'error');
    return;
  }
  if (!shots.length) return;
  const pm = progressModal(`AI で ${shots.length} 枚を写真に仕上げています`);
  let done = 0;
  const failed: string[] = [];
  try {
    for (let i = 0; i < shots.length; i++) {
      if (pm.signal.aborted) break;
      try {
        await finishShot(ctx, shots[i], pm, { index: i, total: shots.length });
        done++;
      } catch (e) {
        if ((e as Error).name === 'AbortError') break;
        failed.push(`${shots[i].title}: ${(e as Error).message}`);
        // 回数制限はそれ以上続けても無駄
        if (/上限/.test((e as Error).message)) break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    pm.close();
  }
  if (failed.length) toast(`${done} 枚を保存しました。失敗: ${failed.join(' / ').slice(0, 200)}`, failed.length === shots.length ? 'error' : 'info', 9000);
  else toast(`${done} 枚の写真仕上げをギャラリーに保存しました`, 'ok', 6000);
}

/** 設定 UI（API キー・モデル名） */
export function aiSettingsUi(): HTMLElement[] {
  const keyInput = h('input', { type: 'password', value: getAiKey(), placeholder: 'AI Studio の API キー（AIza…）', style: 'width:100%', autocomplete: 'off', onchange: (e: Event) => setAiKey((e.target as HTMLInputElement).value) });
  const modelInput = h('input', { type: 'text', value: getAiModel(), list: 'ai-model-candidates', style: 'width:100%', onchange: (e: Event) => setAiModel((e.target as HTMLInputElement).value) });
  const list = h('datalist', { id: 'ai-model-candidates' }, ...MODEL_CANDIDATES.map((m) => h('option', { value: m })));
  return [
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Google AI Studio の API キー'), keyInput),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'モデル名（画像の編集に対応したもの）'), modelInput, list),
    h('p', { class: 'hint' }, 'キーはこのパソコンのブラウザにだけ保存され、AI への送信以外には使われません。無料枠で使えるモデルと回数は AI Studio の「Rate limits」で確認できます（クレジットの購入は不要）。'),
  ];
}
