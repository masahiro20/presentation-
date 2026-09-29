import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--ignore-certificate-errors'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404') && !m.text().includes('CERT')) console.log('[console]', m.text()); });
await page.goto('http://localhost:5173/?sample=sample_house_A3.pdf#present');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
const t0 = Date.now();
await page.getByRole('button', { name: /足りない素材を自動作成/ }).click();
await page.waitForTimeout(1000);
await page.waitForFunction(() => !document.querySelector('.modal-back'), null, { timeout: 1500000 });
console.log('auto generate sec', (Date.now() - t0) / 1000);
await page.waitForTimeout(1500);
const n = await page.locator('.deck .slide').count();
console.log('slides', n);
await page.screenshot({ path: 'test-output/present-1.png' });
for (const i of [1, 2, 5, 9, 12, 14]) {
  const s = page.locator('.deck .slide').nth(i);
  if ((await s.count()) === 0) continue;
  await s.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await s.screenshot({ path: `test-output/slide-${i}.png` });
}
await browser.close();
