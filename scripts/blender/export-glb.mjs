// 図面を読み込み、3D モデル（.glb）とカメラ（.json）を書き出す（all-shots と同じ読み込み方）
import { chromium } from 'playwright-core';
import { copyFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
const [pdf, outDir] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8765/#import');
await page.waitForTimeout(2500);
mkdirSync('/home/user/presentation-/dist/tmp', { recursive: true });
copyFileSync(pdf, '/home/user/presentation-/dist/tmp/export.pdf');
await page.evaluate(async () => {
  const buf = await (await fetch('/tmp/export.pdf?t=' + Date.now())).arrayBuffer();
  const input = document.querySelector('input[accept*="pdf"]');
  const dt = new DataTransfer();
  dt.items.add(new File([buf], 'export.pdf'));
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
});
const go = page.getByRole('button', { name: /3D パースを作成する/ });
await go.waitFor({ timeout: 180000 });
await go.click({ timeout: 180000 });
await page.waitForSelector('.shot-card', { timeout: 180000 });
await page.waitForTimeout(6000);
const files = [];
page.on('download', async (d) => {
  const tmp = `${outDir}/dl_${files.length}`;
  await d.saveAs(tmp);
  // 到着順は環境で入れ替わるので中身で判定（.glb は 'glTF' のマジックで始まる）
  const head = readFileSync(tmp).subarray(0, 4).toString('latin1');
  const f = `${outDir}/${head === 'glTF' ? 'scene.glb' : 'camera.json'}`;
  renameSync(tmp, f); files.push(f); console.log('saved', f);
});
const n = await page.evaluate(() => { const bs = [...document.querySelectorAll('button')].filter((b) => b.textContent.includes('D5・Twinmotion')); bs[0]?.click(); return bs.length; });
console.log('export buttons', n);
for (let i = 0; i < 180 && files.length < 2; i++) await page.waitForTimeout(1000);
await page.waitForTimeout(2000);
await b.close();
