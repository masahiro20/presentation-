// 写真仕上げ（Gemini の画像生成 API）: 本文の組み立て・応答の読み取り・エラーの言葉・モデルの選別・枚数と費用・輪郭の照合
import { describe, expect, it } from 'vitest';
import { buildGenerateBody, costPerImage, describeHttpError, edgeMask, edgeRecall, monthKey, parseGenerateResponse, pickImageModels, scoreLabel, splitDataUrl, usageSummary } from '../src/app/aiFinish';

const PNG1 = 'data:image/png;base64,iVBORw0KGgo=';
const JPG1 = 'data:image/jpeg;base64,/9j/4AAQ';

describe('本文と応答', () => {
  it('添付の順（下絵 → 素材ボード → お手本）と、画像の設定', () => {
    const body = buildGenerateBody({ prompt: 'P', draft: JPG1, board: PNG1, refs: [PNG1, PNG1, PNG1, PNG1], aspectRatio: '16:9', imageSize: '2K' }) as { contents: { parts: Record<string, unknown>[] }[]; generationConfig: Record<string, unknown> };
    const parts = body.contents[0].parts;
    expect(parts).toHaveLength(1 + 1 + 1 + 3); // 文 + 下絵 + ボード + お手本 3 枚まで
    expect((parts[0] as { text: string }).text).toContain('P');
    expect((parts[0] as { text: string }).text).toContain('1 枚目: 下絵');
    expect((parts[0] as { text: string }).text).toContain('2 枚目: 素材ボード');
    expect((parts[1] as { inline_data: { mime_type: string } }).inline_data.mime_type).toBe('image/jpeg');
    expect(body.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '2K' } });
    const plain = buildGenerateBody({ prompt: 'P', draft: JPG1 }, false) as { generationConfig: Record<string, unknown> };
    expect(plain.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'] });
  });
  it('data URL を分ける', () => {
    expect(splitDataUrl(PNG1)).toEqual({ mimeType: 'image/png', data: 'iVBORw0KGgo=' });
    expect(() => splitDataUrl('https://example.com/a.png')).toThrow();
  });
  it('応答から画像と使用量を取り出す。無ければ理由', () => {
    const ok = parseGenerateResponse({ candidates: [{ content: { parts: [{ text: 'done' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 1290 } }, 'm');
    expect(ok.url).toBe('data:image/png;base64,AAAA');
    expect(ok.text).toBe('done');
    expect(ok.usage).toEqual({ promptTokens: 1500, outputTokens: 1290 });
    expect(() => parseGenerateResponse({ promptFeedback: { blockReason: 'SAFETY' } }, 'm')).toThrow(/安全性/);
    expect(() => parseGenerateResponse({ candidates: [{ content: { parts: [{ text: 'cannot' }] }, finishReason: 'STOP' }] }, 'm')).toThrow(/画像が返りませんでした/);
    expect(() => parseGenerateResponse({ candidates: [{ content: { parts: [] }, finishReason: 'IMAGE_SAFETY' }] }, 'm')).toThrow(/IMAGE_SAFETY/);
  });
  it('HTTP エラーの言葉', () => {
    expect(describeHttpError(400, JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }))).toContain('キーが正しくありません');
    expect(describeHttpError(429, JSON.stringify({ error: { message: 'Resource has been exhausted (e.g. check quota).' } }))).toContain('上限');
    expect(describeHttpError(404, 'not found')).toContain('モデルが見つかりません');
    expect(describeHttpError(503, '')).toContain('Google 側');
  });
  it('画像を出せるモデルだけを選び、Flash を先に', () => {
    const list = pickImageModels([
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3-pro-image-preview', displayName: 'Nano Banana Pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-image', displayName: 'Nano Banana', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] },
      { name: 'models/gemini-embedding-image', supportedGenerationMethods: ['generateContent'] },
    ]);
    expect(list.map((m) => m.name)).toEqual(['gemini-2.5-flash-image', 'gemini-3-pro-image-preview']);
  });
});

describe('枚数と費用の目安', () => {
  it('モデルごとの単価と今月の合計', () => {
    expect(costPerImage('gemini-2.5-flash-image').jpy).toBe(6);
    expect(costPerImage('gemini-3-pro-image-preview').jpy).toBe(20);
    const d = new Date(2026, 10, 7);
    const k = monthKey(d);
    expect(k).toBe('2026-11');
    const s = usageSummary({ [k]: { count: 12, byModel: { 'gemini-2.5-flash-image': 10, 'gemini-3-pro-image-preview': 2 }, outputTokens: 0 } }, d);
    expect(s.count).toBe(12);
    expect(s.jpy).toBe(100);
    expect(s.text).toContain('12 枚');
    expect(usageSummary({}, d).count).toBe(0);
  });
});

describe('下絵との照合（輪郭）', () => {
  /** 白地に黒い長方形の枠（輪郭がはっきりした「建物」） */
  const frame = (w: number, h: number, x0: number, y0: number, x1: number, y1: number, extra?: (x: number, y: number) => boolean) => {
    const a = new Uint8ClampedArray(w * h).fill(240);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const on = ((x === x0 || x === x1) && y >= y0 && y <= y1) || ((y === y0 || y === y1) && x >= x0 && x <= x1);
        if (on || extra?.(x, y)) a[y * w + x] = 20;
      }
    return a;
  };
  it('同じ形なら 1 に近く、形が変わると下がる', () => {
    const w = 64;
    const h = 48;
    const draft = edgeMask(frame(w, h, 10, 10, 50, 38), w, h);
    const same = edgeMask(frame(w, h, 10, 10, 50, 38), w, h);
    const shifted = edgeMask(frame(w, h, 20, 10, 60, 38), w, h);
    expect(edgeRecall(draft, same, w, h).score).toBeGreaterThan(0.95);
    const moved = edgeRecall(draft, shifted, w, h);
    expect(moved.score).toBeLessThan(0.75);
    expect(moved.missing.reduce((s, v) => s + v, 0)).toBeGreaterThan(0);
    expect(scoreLabel(0.9).level).toBe('ok');
    expect(scoreLabel(0.6).level).toBe('check');
    expect(scoreLabel(0.3).level).toBe('bad');
  });
  it('窓が 1 つ消えると、その分だけ下がる', () => {
    const w = 96;
    const h = 64;
    const win = (x: number, y: number) => (x === 30 || x === 40) && y >= 20 && y <= 30;
    const draft = edgeMask(frame(w, h, 10, 10, 85, 55, win), w, h);
    const noWin = edgeMask(frame(w, h, 10, 10, 85, 55), w, h);
    const r = edgeRecall(draft, noWin, w, h);
    expect(r.score).toBeLessThan(1);
    expect(r.score).toBeGreaterThan(0.6);
  });
});
