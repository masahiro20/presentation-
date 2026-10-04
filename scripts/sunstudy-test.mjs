// 日照シミュレーション（3D データ読み込み版）の自動テスト:
//   場所の検索 → 周辺環境の読み込み → サンプル 3DS の読み込み → 日照画面 → 日照時間マップ・日影図
// 使い方: 別端末で `npm run dev` を起動してから `node scripts/sunstudy-test.mjs [baseUrl]`
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5173';
mkdirSync('test-output', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--ignore-certificate-errors'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); errors.push(e.message); });
page.on('console', (m) => { if (m.type() === 'error' && !/404|CERT|ERR_/.test(m.text())) console.log('[console]', m.text()); });
const noModal = () => page.waitForFunction(() => !document.querySelector('.modal-back'), null, { timeout: 600000 });
const shot = (name) => page.screenshot({ path: `test-output/${name}.png` });
const t = (label, t0) => console.log(`${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

await page.goto(`${base}/sun.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
await shot('sunstudy-1-place');

// 住所検索
await page.locator('.side input[type=text]').first().fill('東京都世田谷区奥沢3丁目');
await page.getByRole('button', { name: '検索' }).first().click();
await page.getByRole('button', { name: /奥沢/ }).first().click({ timeout: 60000 });
await page.waitForTimeout(2500);
await shot('sunstudy-2-pin');

// 周辺環境の読み込み
let t0 = Date.now();
await page.getByRole('button', { name: /周辺環境を読み込む/ }).first().click();
await page.waitForTimeout(500);
await noModal();
t('environment', t0);
await page.waitForTimeout(1500);
await shot('sunstudy-3-env');
const envText = await page.locator('.side').innerText();
console.log('[env]', envText.replace(/\s+/g, ' ').slice(0, 600));

// 建物: サンプル 3DS
if (!(await page.getByRole('button', { name: /サンプル/ }).count())) await page.getByRole('button', { name: /建物/ }).first().click();
t0 = Date.now();
await page.getByRole('button', { name: /サンプル/ }).first().click();
await page.waitForFunction(() => window.study?.model, null, { timeout: 120000 });
t('sample model', t0);
await page.waitForTimeout(2500);
await shot('sunstudy-4-model');
const dims = await page.locator('.dims').innerText().catch(() => '(no dims)');
console.log('[dims]', dims.replace(/\s+/g, ' '));

// 日照シミュレーション
await page.getByRole('button', { name: /日照シミュレーションへ/ }).first().click();
await page.waitForTimeout(800);
// 配置の確認ダイアログ（初回のみ）
const confirmBtn = page.getByRole('button', { name: /確認して進む/ });
if (await confirmBtn.count()) await confirmBtn.first().click();
await page.waitForTimeout(3000);
await shot('sunstudy-5-sim');
const badge = await page.locator('.sun-badge').innerText().catch(() => '(no badge)');
console.log('[badge]', badge.replace(/\s+/g, ' '));

// 日照時間マップ
t0 = Date.now();
await page.getByRole('button', { name: /地面の日照時間マップ/ }).first().click();
await page.waitForTimeout(500);
await noModal();
t('ground heatmap', t0);
await page.waitForTimeout(1500);
await shot('sunstudy-6-heatmap');

// 建物の面の日照時間
t0 = Date.now();
await page.getByRole('button', { name: /面の日照時間/ }).first().click();
await page.waitForTimeout(500);
await noModal();
t('facade', t0);
await page.waitForTimeout(1500);
await shot('sunstudy-7-facade');

// 日影図
t0 = Date.now();
await page.getByRole('button', { name: /GL\+1\.5/ }).first().click();
await page.waitForSelector('.modal-body svg', { timeout: 600000 });
t('shadow diagram', t0);
await page.waitForTimeout(500);
await shot('sunstudy-8-diagram');
const svgLen = await page.locator('.modal-body svg').evaluate((el) => el.outerHTML.length);
console.log('[diagram svg bytes]', svgLen);
await page.getByRole('button', { name: '閉じる' }).last().click();

console.log('page errors:', errors.length);
await browser.close();
process.exit(errors.length ? 1 : 0);
