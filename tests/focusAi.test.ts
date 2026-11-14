// こだわり指定: 参考画像を AI に読んでもらう依頼文と、答えの取り出し／AI 仕上げに参考画像を添える
import { describe, expect, it } from 'vitest';
import { buildFocusReadBody, buildFocusReadPrompt, parseFocusReadResponse, parseFocusReadText, readFocusImages } from '../src/app/focusAi';
import { buildGenerateBody } from '../src/app/aiFinish';

const IMG = 'data:image/jpeg;base64,AAAA';
const PNG = 'data:image/png;base64,BBBB';

describe('参考画像を読んでもらう依頼', () => {
  it('階段: つくり・手すり・段数の選択肢と、間取りは関係ないことを伝える', () => {
    const p = buildFocusReadPrompt({ part: 'stair', images: [IMG], note: '軽く見せたい' });
    expect(p).toContain('階段はこのように提案したい');
    expect(p).toContain('"woodSkeleton"');
    expect(p).toContain('"cantilever"');
    expect(p).toContain('"glass"');
    expect(p).toContain('間取り・家具は関係ありません');
    expect(p).toContain('設計担当のメモ');
    expect(p).toContain('軽く見せたい');
    expect(p).toContain('{"stair":');
  });

  it('階段以外: 仕様の選択肢は出さず、ひとことだけ', () => {
    const p = buildFocusReadPrompt({ part: 'kitchen', images: [IMG] });
    expect(p).toContain('キッチンはこのように提案したい');
    expect(p).not.toContain('woodSkeleton');
    expect(p).not.toContain('設計担当のメモ');
    expect(p).toContain('{"note":');
  });

  it('本文: 依頼文の後に画像を 3 枚まで', () => {
    const body = buildFocusReadBody({ part: 'stair', images: [IMG, PNG, IMG, IMG] }) as { contents: { parts: Record<string, unknown>[] }[]; generationConfig: { responseMimeType: string } };
    const parts = body.contents[0].parts;
    expect(parts).toHaveLength(4);
    expect(typeof parts[0].text).toBe('string');
    expect(parts[1]).toEqual({ inline_data: { mime_type: 'image/jpeg', data: 'AAAA' } });
    expect(parts[2]).toEqual({ inline_data: { mime_type: 'image/png', data: 'BBBB' } });
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });
});

describe('答えの取り出し', () => {
  it('JSON から、知っている値だけを取る（知らない値・範囲外の段数は落とす）', () => {
    const r = parseFocusReadText('```json\n{"stair":{"build":"steel","rail":"spiral","steps":40},"note":" 黒皮鉄の桁にオークの踏板 ","reason":"桁が 1 本見える"}\n```', 'stair', 'm');
    // つくり（build）は家に 1 つなので、手すり・段数（stair）とは別の項目で返す
    expect(r).toEqual({ build: 'steel', note: '黒皮鉄の桁にオークの踏板', reason: '桁が 1 本見える', model: 'm' });
    const r2 = parseFocusReadText('{"stair":{"build":"spiral","rail":"glass","steps":14},"note":"x"}', 'stair', 'm');
    expect(r2.build).toBeUndefined();
    expect(r2.stair).toEqual({ rail: 'glass', steps: 14 });
  });

  it('階段以外の部位では、階段の仕様を受け取らない', () => {
    const r = parseFocusReadText('{"stair":{"build":"box"},"note":"黒い天板"}', 'kitchen', 'm');
    expect(r.stair).toBeUndefined();
    expect(r.build).toBeUndefined();
    expect(r.note).toBe('黒い天板');
  });

  it('JSON でなければ、生の文章を返す（画面で「読めませんでした」と出す）', () => {
    const r = parseFocusReadText('すみません、分かりません', 'stair', 'm');
    expect(r.note).toBe('');
    expect(r.raw).toContain('分かりません');
  });

  it('応答の形から文章を取り出す。止められた・空のときは理由を投げる', () => {
    const ok = parseFocusReadResponse({ candidates: [{ content: { parts: [{ text: '{"stair":{"rail":"glass","steps":14},"note":"ガラスの手すり"}' }] } }] }, 'stair', 'm');
    expect(ok.stair).toEqual({ rail: 'glass', steps: 14 });
    expect(() => parseFocusReadResponse({ promptFeedback: { blockReason: 'SAFETY' } }, 'stair', 'm')).toThrow(/SAFETY/);
    expect(() => parseFocusReadResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'stair', 'm')).toThrow(/MAX_TOKENS/);
  });

  it('呼び出し: 鍵はヘッダーで渡し、画像が無ければ送らない', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"stair":{"build":"box"},"note":"箱階段"}' }] } }] }) } as Response;
    }) as unknown as typeof fetch;
    const r = await readFocusImages('KEY', 'gemini-2.5-flash', { part: 'stair', images: [IMG] }, { fetchFn });
    expect(r.build).toBe('box');
    expect(r.stair).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/models/gemini-2.5-flash:generateContent');
    expect(calls[0].url).not.toContain('KEY');
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('KEY');
    await expect(readFocusImages('KEY', 'm', { part: 'stair', images: [] }, { fetchFn })).rejects.toThrow(/参考画像がありません/);
    expect(calls).toHaveLength(1);
  });
});

describe('AI 仕上げに、こだわりの参考画像を添える', () => {
  it('下絵 → 素材ボード → お手本 → こだわりの参考画像の順で、役割を言葉で伝える', () => {
    const body = buildGenerateBody({ prompt: 'P', draft: IMG, board: PNG, refs: [IMG], focus: [{ url: PNG, name: '00_参考_階段_1.jpg', part: '階段' }] }) as { contents: { parts: Record<string, unknown>[] }[] };
    const parts = body.contents[0].parts;
    expect(parts).toHaveLength(5);
    const text = parts[0].text as string;
    expect(text).toContain('4 枚目: こだわりの参考画像「00_参考_階段_1.jpg」（階段の形・素材・納まりだけを手本にする');
    expect(text).toContain('位置・大きさ・数は下絵のまま');
    expect(parts[4]).toEqual({ inline_data: { mime_type: 'image/png', data: 'BBBB' } });
  });

  it('参考画像が無ければ、今までどおり', () => {
    const body = buildGenerateBody({ prompt: 'P', draft: IMG }) as { contents: { parts: Record<string, unknown>[] }[] };
    expect(body.contents[0].parts).toHaveLength(2);
    expect(body.contents[0].parts[0].text as string).not.toContain('こだわり');
  });
});

describe('お客様に渡すデータ（体験リンク）', () => {
  it('こだわりの参考資料（参考画像・社内のメモ）は入れない。ほかはそのまま', async () => {
    const { publicProject } = await import('../src/app/project');
    const p = { name: 'x', design: { finishes: { stair: 'stair.box' } }, focus: [{ id: 'a', part: 'stair', note: '社内メモ', images: [{ url: IMG }], at: '' }] } as unknown as Parameters<typeof publicProject>[0];
    const out = publicProject(p) as unknown as Record<string, unknown>;
    expect('focus' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('社内メモ');
    expect(out.name).toBe('x');
    expect((out.design as { finishes: Record<string, string> }).finishes.stair).toBe('stair.box');
    // 元のデータは変えない
    expect((p as unknown as { focus: unknown[] }).focus).toHaveLength(1);
  });
});

// 2026-11-12 のご要望: 階段の細部・吹抜の手すり・造作・照明の雰囲気も画像から読む
describe('階段の細部・吹抜・造作・照明を読んでもらう', () => {
  it('階段: 桁・踏板の色・鉄の色の選択肢も伝え、答えから取り出す', () => {
    const p = buildFocusReadPrompt({ part: 'stair', images: [IMG] });
    expect(p).toContain('stringer');
    expect(p).toContain('"center"');
    expect(p).toContain('"walnut"');
    expect(p).toContain('"white"');
    const r = parseFocusReadText('{"stair":{"build":"steel","stringer":"center","rail":"bar","tread":"walnut","frame":"white","steps":15},"note":"白い鉄骨に濃い踏板"}', 'stair', 'm');
    expect(r.build).toBe('steel');
    expect(r.stair).toEqual({ rail: 'bar', steps: 15, stringer: 'center', tread: 'walnut', frame: 'white' });
    // 既定と同じ値（床に合わせる・黒）は持たない。桁は、読み取ったものをそのまま持つ（既定がテイストで変わるため）
    expect(parseFocusReadText('{"stair":{"build":"steel","tread":"floor","frame":"black"},"note":"x"}', 'stair', 'm').stair).toBeUndefined();
    expect(parseFocusReadText('{"stair":{"build":"steel","stringer":"side","tread":"floor","frame":"black"},"note":"x"}', 'stair', 'm').stair).toEqual({ stringer: 'side' });
  });

  it('吹抜: 落下防止の種類を選んでもらう（知らない値は落とす。ほかの部位では受け取らない）', () => {
    const p = buildFocusReadPrompt({ part: 'void', images: [IMG] });
    expect(p).toContain('guard: "rail"');
    expect(p).toContain('"glass" = ガラスの手すり');
    expect(p).toContain('{"guard":"rail"');
    expect(parseFocusReadText('{"guard":"glass","note":"抜けを邪魔しない"}', 'void', 'm').guard).toBe('glass');
    expect(parseFocusReadText('{"guard":"net","note":"x"}', 'void', 'm').guard).toBeUndefined();
    expect(parseFocusReadText('{"guard":"glass","note":"x"}', 'stair', 'm').guard).toBeUndefined();
  });

  it('造作: 3D に置ける 8 つの形から、いちばん近い形を選んでもらう', () => {
    const p = buildFocusReadPrompt({ part: 'joinery', images: [IMG] });
    expect(p).toContain('joinery: "floatTv" = 浮かせたテレビボード＋飾り棚');
    expect(p).toContain('joinery: "wallShelf"');
    expect(p).toContain('{"joinery":"floatTv"');
    const r = parseFocusReadText('{"joinery":"wallShelf","note":"オークの本棚を壁一面に","reason":"天井までの棚"}', 'joinery', 'm');
    expect(r.joinery).toBe('wallShelf');
    expect(r.note).toBe('オークの本棚を壁一面に');
    expect(parseFocusReadText('{"joinery":"piano","note":"x"}', 'joinery', 'm').joinery).toBeUndefined();
  });

  it('照明: 間接照明・ペンダント・光の色・時間帯を読んでもらう', () => {
    const p = buildFocusReadPrompt({ part: 'lighting', images: [IMG] });
    expect(p).toContain('indirect');
    expect(p).toContain('"dome"');
    expect(p).toContain('2700');
    expect(p).toContain('"evening"');
    const r = parseFocusReadText('{"lighting":{"indirect":true,"pendant":"globes","kelvin":2700,"tod":"night","lux":300},"note":"暗めに落として間接光で"}', 'lighting', 'm');
    expect(r.lighting).toEqual({ indirect: true, pendant: 'globes', kelvin: 2700, tod: 'night' });
    expect(parseFocusReadText('{"lighting":{"indirect":true},"note":"x"}', 'living', 'm').lighting).toBeUndefined();
  });
});
