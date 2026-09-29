// 使い方: node scripts/shot.mjs <url> <out.png> [width] [height] [waitMs]
import { chromium } from 'playwright-core';
const [,, url, out, w = '1280', h = '800', wait = '1500'] = process.argv;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--ignore-certificate-errors'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text()); });
let failed = false;
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failed = true; });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => (window).__ready === true || (window).__failed, null, { timeout: +(process.env.SHOT_TIMEOUT ?? 180000) }).catch(e => console.log('timeout waiting ready'));
await page.waitForTimeout(+wait);
await page.screenshot({ path: out });
await browser.close();
