/**
 * 同梱サンプルの読み込み（importModel.loadSampleModel）の配信フォールバックのテスト。
 * バイナリを配信しない公開先では `url + '.txt'`（base64 の写し）から読む。そのフォールバックが
 * オフライン・SPA の書き換え（HTML が返る）・壊れた base64・別のファイルのときに、ブラウザの英語の例外
 * （atob の DOMException・'Failed to fetch'）ではなく日本語の説明で失敗することを確かめる。fetch は差し替える。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSampleModel } from '../src/sunstudy/importModel';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE = readFileSync(path.join(ROOT, 'public', 'samples', 'sample_house.3ds'));
const PATH = 'samples/sample_house.3ds';

type Answer = Response | Error;
/** URL の末尾（.3ds / .3ds.txt）ごとの応答を返す fetch */
function fakeFetch(answers: { bin: Answer; txt: Answer }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const a = url.endsWith('.txt') ? answers.txt : answers.bin;
    if (a instanceof Error) throw a;
    return a;
  });
}
const html = () => new Response('<!doctype html><html><body>app</body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const text = (body: string, ct = 'text/plain') => new Response(body, { status: 200, headers: { 'content-type': ct } });
const notFound = () => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
/** 失敗を Error として受け取る（成功したらテスト失敗） */
const failure = async (): Promise<Error> => {
  try {
    await loadSampleModel(PATH);
  } catch (e) {
    return e as Error;
  }
  throw new Error('成功してしまった');
};

describe('loadSampleModel: base64 の写しへのフォールバック', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('バイナリの代わりに HTML が返っても、.txt（base64）から読める', async () => {
    const f = fakeFetch({ bin: html(), txt: text(SAMPLE.toString('base64')) });
    vi.stubGlobal('fetch', f);
    const m = await loadSampleModel(PATH);
    expect(m.name).toBe('sample_house.3ds');
    expect(m.format).toBe('3ds');
    expect(m.triangles).toBeGreaterThan(10);
    expect(f).toHaveBeenCalledTimes(2);
    expect(String(f.mock.calls[1][0])).toMatch(/sample_house\.3ds\.txt$/);
  });

  it('オフライン（両方 Failed to fetch）: 英語の TypeError ではなく日本語の説明（原因を含む）', async () => {
    vi.stubGlobal('fetch', fakeFetch({ bin: new TypeError('Failed to fetch'), txt: new TypeError('Failed to fetch') }));
    await expect(loadSampleModel(PATH)).rejects.toThrow(/^サンプルを取得できませんでした（ネットワークまたは配信設定: Failed to fetch）: samples\/sample_house\.3ds$/);
  });

  it('.txt が 404 / HTML（SPA の書き換え）: atob の DOMException を漏らさない', async () => {
    vi.stubGlobal('fetch', fakeFetch({ bin: notFound(), txt: notFound() }));
    await expect(loadSampleModel(PATH)).rejects.toThrow(/サンプルを取得できませんでした（ネットワークまたは配信設定: HTTP 404）/);
    vi.stubGlobal('fetch', fakeFetch({ bin: html(), txt: html() }));
    const err = await failure();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/サンプルを取得できませんでした（ネットワークまたは配信設定: HTML が返されました）/);
    expect(err.message).not.toMatch(/atob|DOMException|Invalid character/i);
  });

  it('.txt の中身が base64 でない／3DS でない: それぞれ日本語で区別して失敗する', async () => {
    vi.stubGlobal('fetch', fakeFetch({ bin: html(), txt: text('%%% not base64 %%%') }));
    const bad = await failure();
    expect(bad.message).toMatch(/サンプルを取得できませんでした（配信されたデータが壊れています）/);
    expect(bad.message).not.toMatch(/atob|DOMException|Invalid character/i);
    vi.stubGlobal('fetch', fakeFetch({ bin: html(), txt: text(Buffer.from('hello world, not a 3ds').toString('base64')) }));
    await expect(loadSampleModel(PATH)).rejects.toThrow(/サンプルを取得できませんでした（配信されたデータが 3ds ファイルではありません）/);
  });
});
