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
// 住所検索の候補（「▶ デモを開く（世田谷区奥沢…）」ボタンと区別するため都道府県から始まるものを選ぶ）
await page.getByRole('button', { name: /^東京都.*奥沢/ }).first().click({ timeout: 60000 });
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
// PLATEAU 経路の確認: 奥沢（世田谷区・2025 LOD2）は PLATEAU の建物が 1 棟以上あり、注記の先頭にデータセット（市区・年度・LOD）が出る
const nb = await page.evaluate(() => ({ plateau: window.study.neighbors.filter((n) => n.source === 'plateau').length, mesh: window.study.neighbors.filter((n) => n.source === 'plateau' && n.mesh).length, sources: window.study.neighborSources, notes: window.study.neighborNotes }));
console.log('[neighbors]', JSON.stringify(nb));
const mismatches = [];
if (!(nb.plateau > 0 && nb.mesh === nb.plateau && nb.sources[0] === 'plateau')) mismatches.push(`PLATEAU の建物が無い／mesh が揃っていない: ${JSON.stringify({ plateau: nb.plateau, mesh: nb.mesh, sources: nb.sources })}`);
if (!/^PLATEAU（国土交通省 3D都市モデル・東京都世田谷区・2025年度・LOD2/.test(nb.notes[0] ?? '')) mismatches.push(`注記の先頭が PLATEAU のデータセットでない: ${nb.notes[0]}`);

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
// 配置の確認ダイアログ（初回のみ）
const confirmBtn = page.getByRole('button', { name: /確認して進む/ });
await confirmBtn.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
if (await confirmBtn.count()) await confirmBtn.first().click();
await page.waitForFunction(() => location.hash === '#sim', null, { timeout: 30000 });
await page.waitForTimeout(3000);
await shot('sunstudy-5-sim');
const badge = await page.locator('.sun-badge').innerText().catch(() => '(no badge)');
console.log('[badge]', badge.replace(/\s+/g, ' '));
// 3D 画面の出典行に PLATEAU（国土交通省 3D都市モデル）が出る
const attribution = await page.locator('.attribution').innerText().catch(() => '');
console.log('[attribution]', attribution);
if (!/周辺建物: PLATEAU（国土交通省 3D都市モデル）/.test(attribution)) mismatches.push(`出典行に PLATEAU が無い: ${attribution}`);

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
await page.getByRole('button', { name: /建物の面の日照時間/ }).first().click();
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
const svgHtml = await page.locator('.modal-body svg').evaluate((el) => el.outerHTML);
console.log('[diagram svg bytes]', svgHtml.length);
// 日影図の脚注に周辺建物の出典（PLATEAU のデータセット）が印字される
if (!/PLATEAU/.test(svgHtml)) mismatches.push('日影図の脚注に PLATEAU の出典が無い');
await page.getByRole('button', { name: '閉じる' }).last().click();

for (const m of mismatches) console.log('[MISMATCH]', m);
console.log('page errors:', errors.length, ' mismatches:', mismatches.length);
await browser.close();
process.exit(errors.length + mismatches.length ? 1 : 0);
