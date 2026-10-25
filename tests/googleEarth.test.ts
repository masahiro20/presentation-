import { describe, it, expect } from 'vitest';
import { checkGoogle3dKey, googleErrorText } from '../src/sun/googleEarth';

describe('Google 実写 3D のキー確認', () => {
  it('キーが空なら取りに行かない', async () => {
    let called = false;
    const r = await checkGoogle3dKey('  ', (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch);
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('Google の応答を直し方の分かる言葉に', async () => {
    const res = (status: number, message: string) => (async () => new Response(JSON.stringify({ error: { message } }), { status })) as typeof fetch;
    const off = await checkGoogle3dKey('k', res(403, 'Map Tiles API has not been used in project 1 before or it is disabled.'));
    expect(off.ok === false && off.message).toMatch(/「Map Tiles API」を有効/);
    const bad = await checkGoogle3dKey('k', res(400, 'API key not valid. Please pass a valid API key.'));
    expect(bad.ok === false && bad.message).toMatch(/正しくありません/);
    expect(googleErrorText(403, 'Requests from referer https://x.vercel.app/ are blocked. RefererNotAllowed')).toMatch(/ウェブサイトの制限/);
    expect(googleErrorText(403, 'This API requires billing to be enabled')).toMatch(/請求先/);
    expect(googleErrorText(429, '')).toMatch(/上限/);
    const ok = await checkGoogle3dKey('k', (async () => new Response('{}', { status: 200 })) as typeof fetch);
    expect(ok.ok).toBe(true);
  });
});
