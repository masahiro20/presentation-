// node scripts/eval.mjs <url> "<js expression>"
import { chromium } from 'playwright-core';
const [,, url, expr] = process.argv;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--ignore-certificate-errors'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => (window).__ready === true || (window).__failed, null, { timeout: 180000 });
console.log(JSON.stringify(await page.evaluate(expr), null, 1));
await browser.close();
