import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const [,, input, output, width = '1600'] = process.argv;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: +width, height: 800 } });
await page.setContent(`<body style="margin:0">${readFileSync(input, 'utf8')}</body>`);
await page.locator('svg').first().screenshot({ path: output });
await browser.close();
