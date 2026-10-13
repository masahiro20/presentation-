// 日照ステップの自動テスト: 航空写真・周辺建物（PLATEAU 経路）・部屋解析・日影図
// 使い方: 別端末で `npm run dev` を起動してから `node scripts/sun-test.mjs [baseUrl]`。終了コード = pageerror + 不一致
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--ignore-certificate-errors'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const mismatches = [];
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); errors.push(e.message); });
page.on('console', (m) => { if (m.type() === 'error' && !/404|CERT|ERR_/.test(m.text())) console.log('[console]', m.text()); });
const base = process.argv[2] ?? 'http://localhost:5173';
await page.goto(`${base}/?sample=sample_house_A3.pdf#sun`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
const click = async (text) => { await page.getByRole('button', { name: text }).first().click(); };
// 「🏘 周辺建物（PLATEAU）」が先頭（既定の取得元）
const nbButtons = await page.locator('button', { hasText: /周辺建物（/ }).allInnerTexts();
console.log('[neighbor buttons]', nbButtons.join(' | '));
if (nbButtons[0] !== '🏘 周辺建物（PLATEAU）') mismatches.push(`周辺建物のボタンの先頭が PLATEAU でない: ${nbButtons.join(' | ')}`);
await page.locator('input[placeholder^="例: "]').fill('東京都世田谷区奥沢3丁目');
await click('検索');
await page.getByRole('button', { name: /奥沢三丁目/ }).first().click({ timeout: 30000 });
await page.waitForTimeout(3000);
await page.waitForFunction(() => !document.querySelector('.modal-back'), null, { timeout: 120000 });
// 建設地を選ぶと既定の取得元（PLATEAU）で周辺建物を読み込む。__sunDebug.neighbors（sunStep.ts）で取得元・内訳・データセットを確認
await page.waitForFunction(() => (window.__sunDebug?.sc?.state?.neighbors?.length ?? 0) > 0, null, { timeout: 120000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: 'test-output/sun-aerial.png' });
const nb = await page.evaluate(() => {
  const d = window.__sunDebug.neighbors;
  const last = d.lastLoad();
  return { lastSource: d.lastSource(), counts: d.counts(), lodCounts: d.lodCounts(), datasets: d.datasets().map((x) => x.label), status: last?.plateau?.status ?? null, used: last?.used ?? [], notes: last?.notes ?? [] };
});
console.log('[neighbors]', JSON.stringify(nb));
if (nb.lastSource !== 'plateau' || nb.status !== 'covered' || nb.used[0] !== 'plateau') mismatches.push(`PLATEAU 経路で取得していない: ${JSON.stringify({ lastSource: nb.lastSource, status: nb.status, used: nb.used })}`);
if (!((nb.counts.plateau ?? 0) > 0 && nb.counts.mesh === nb.counts.plateau)) mismatches.push(`PLATEAU の建物が無い／mesh が揃っていない: ${JSON.stringify(nb.counts)}`);
if (!nb.datasets.some((l) => /世田谷区・2025年度・LOD2/.test(l))) mismatches.push(`データセットに世田谷区・2025年度・LOD2 が無い: ${nb.datasets.join('／')}`);
// 周辺環境のセクションの出典行「周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）N 棟・…」
const srcLine = await page.locator('.sun-src-notes .src').innerText().catch(() => '');
console.log('[source line]', srcLine);
if (!/^周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）\d+ 棟/.test(srcLine)) mismatches.push(`出典行が PLATEAU のデータセットでない: ${srcLine}`);
const t0 = Date.now();
await click('部屋ごとの日当たりを解析');
await page.waitForFunction(() => !document.querySelector('.modal-back'), null, { timeout: 600000 });
console.log('room analysis sec', (Date.now() - t0) / 1000);
await page.locator('.side').evaluate((el) => el.scrollTo(0, el.scrollHeight));
await page.waitForTimeout(500);
await page.screenshot({ path: 'test-output/sun-rooms.png' });
// 部屋解析の開示に出典行が入る
const roomsText = await page.locator('.side').innerText();
if (!/周辺建物の出典: PLATEAU/.test(roomsText)) mismatches.push('部屋解析の開示に「周辺建物の出典: PLATEAU」が無い');
const t1 = Date.now();
await click('日影図（GL+1.5m）');
await page.waitForSelector('.modal-body svg', { timeout: 600000 });
console.log('diagram sec', (Date.now() - t1) / 1000);
await page.waitForTimeout(500);
await page.screenshot({ path: 'test-output/sun-diagram.png' });
// 日影図の脚注に「周辺建物の出典: PLATEAU（…）」
const svg = await page.locator('.modal-body svg').evaluate((el) => el.outerHTML);
const foot = svg.match(/周辺建物の出典: [^<]*/)?.[0] ?? '';
console.log('[diagram footnote]', foot);
if (!/周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）/.test(foot)) mismatches.push(`日影図の脚注に PLATEAU の出典が無い: ${foot}`);
for (const m of mismatches) console.log('[MISMATCH]', m);
console.log('page errors:', errors.length, ' mismatches:', mismatches.length);
await browser.close();
process.exit(errors.length + mismatches.length ? 1 : 0);
