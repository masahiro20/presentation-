/**
 * AI 仕上げ: 現在の構図を「白模型（または仕上げ済み）＋線画」の条件画像にして、
 * Google の画像生成モデル（Gemini）に渡し、形を保ったまま写真に仕上げる。
 * 個人利用向け: Google AI Studio の無料 API キーをブラウザに保存して直接呼ぶ（課金不要。無料枠の回数制限あり）。
 */
import { h, modal, progressModal, toast } from './dom';
import { state, uid, emit } from './state';
import type { StepCtx } from './app';
import type { Shot } from '../scene/shots';
import { renderStudio } from '../scene/studio';
import { renderPass } from '../scene/passes';
import { cutPrompt } from './cuts';

const KEY = 'geminiKey';
const MODEL_KEY = 'geminiModel';
export const DEFAULT_MODEL = 'gemini-2.5-flash-image';

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
  if (status === 403) return 'このキーでは使えません（権限・地域の制限）。キーを発行し直すか、モデル名を確認してください';
  if (status === 404) return 'モデル名が見つかりません。「モデル名」を、AI Studio に表示されている画像生成モデルに変更してください';
  if (status === 429) return '無料枠の回数または速度の上限に達しました。しばらく待ってからもう一度お試しください';
  return `AI からエラーが返りました (${status}) ${body.slice(0, 160)}`;
}

/** 1 枚を AI で仕上げる。戻り値は仕上がり画像の dataURL */
export async function finishWithAi(base: string, lines: string, prompt: string, signal: AbortSignal): Promise<string> {
  const key = getAiKey();
  if (!key) throw new Error('API キーが未設定です');
  const parts = [
    {
      text:
        `${prompt}\n\n` +
        '添付は 2 枚です。1 枚目は仕上げの下絵（白模型または仕上げ済みの 3D 画像）、2 枚目はその輪郭の線画です。' +
        '最重要: 壁・窓・ドア・家具・階段の位置・数・大きさ・カメラの構図を 1 枚目と完全に一致させ、増減・移動・変形をしないこと。' +
        '変えてよいのは、素材の質感・光・影・空・植栽のリアルさだけです。人物・文字・ロゴは加えないでください。出力は画像 1 枚のみ。',
    },
    { inline_data: { mime_type: 'image/jpeg', data: await shrink(base, 1280, 'image/jpeg') } },
    { inline_data: { mime_type: 'image/png', data: await shrink(lines, 1280, 'image/png') } },
  ];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(getAiModel())}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
    signal,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(friendly(res.status, txt));
  const js = JSON.parse(txt) as { candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string }; inline_data?: { mime_type: string; data: string }; text?: string }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
  for (const p of js.candidates?.[0]?.content?.parts ?? []) {
    const d = p.inlineData ?? (p.inline_data ? { mimeType: p.inline_data.mime_type, data: p.inline_data.data } : null);
    if (d?.data) return `data:${d.mimeType};base64,${d.data}`;
  }
  const why = js.promptFeedback?.blockReason ?? js.candidates?.[0]?.finishReason ?? '画像が返りませんでした';
  throw new Error(`AI が画像を返しませんでした（${why}）。構図を変えるか、もう一度お試しください`);
}

/** 現在の構図を AI で仕上げて、ギャラリーに保存し、元画像と並べて見せる */
export async function runAiFinish(ctx: StepCtx, shot: Shot) {
  if (!getAiKey()) {
    toast('先に Google AI Studio の API キーを入力してください', 'error');
    return;
  }
  const v = ctx.app.viewer;
  const pm = progressModal('AI で写真に仕上げています（形は下絵のまま固定します）');
  try {
    pm.set(0.1, '下絵を描いています');
    v.applyShot(shot);
    await new Promise((r) => setTimeout(r, 60));
    const interior = shot.kind === 'interior';
    const base = await renderStudio(v, { width: 1280, height: 720, interior, exposure: interior ? 1.9 : 1.0 });
    pm.set(0.3, '線画を作っています');
    const lines = renderPass(v, 'lines', 1280, 720);
    pm.set(0.45, 'AI に送っています（20〜60 秒ほど）');
    const p = cutPrompt(shot, 0);
    const out = await finishWithAi(base, lines, p.ja, pm.signal);
    state.gallery.push({ id: uid('img'), title: `${shot.title}（AI 仕上げ）`, caption: shot.caption, url: out, kind: shot.kind === 'section' || shot.kind === 'cutaway' ? 'other' : shot.kind, quality: 'photoreal', shotId: `${shot.id}-ai` });
    emit('gallery');
    const wrap = h(
      'div',
      { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px' },
      h('div', null, h('div', { class: 'hint' }, '下絵（このツールの 3D）'), h('img', { src: base, style: 'width:100%;border-radius:2px' })),
      h('div', null, h('div', { class: 'hint' }, 'AI 仕上げ（ギャラリーに保存しました）'), h('img', { src: out, style: 'width:100%;border-radius:2px' })),
    );
    modal('AI 仕上げ', wrap, [{ label: '閉じる' }], true);
    toast('AI 仕上げをギャラリーに保存しました。窓・壁・家具の位置が下絵と同じか、必ず見比べてください', 'ok', 7000);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'error', 9000);
  } finally {
    pm.close();
  }
}

/** 設定 UI（API キー・モデル名） */
export function aiSettingsUi(): HTMLElement[] {
  const keyInput = h('input', { type: 'password', value: getAiKey(), placeholder: 'AI Studio の API キー（AIza…）', style: 'width:100%', onchange: (e: Event) => setAiKey((e.target as HTMLInputElement).value) });
  const modelInput = h('input', { type: 'text', value: getAiModel(), style: 'width:100%', onchange: (e: Event) => setAiModel((e.target as HTMLInputElement).value) });
  return [
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Google AI Studio の API キー'), keyInput),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'モデル名（画像生成に対応したもの）'), modelInput),
    h('p', { class: 'hint' }, 'キーはこのパソコンのブラウザにだけ保存され、AI への送信以外には使われません。無料枠の範囲で使えます（課金は発生しません）。'),
  ];
}
