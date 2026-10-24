// ウォークスルーのカメラ経路を JSON に書き出す（Blender で動画にするため）: export-walk.mjs <pdf> <out.json> [fps]
import { chromium } from 'playwright-core';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
const [pdf, out, fpsS = '12'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8765/#import');
await page.waitForTimeout(2500);
mkdirSync('/home/user/presentation-/dist/tmp', { recursive: true });
copyFileSync(pdf, '/home/user/presentation-/dist/tmp/walk.pdf');
await page.evaluate(async () => {
  const buf = await (await fetch('/tmp/walk.pdf?t=' + Date.now())).arrayBuffer();
  const input = document.querySelector('input[accept*="pdf"]');
  const dt = new DataTransfer(); dt.items.add(new File([buf], 'walk.pdf')); input.files = dt.files; input.dispatchEvent(new Event('change'));
});
const go = page.getByRole('button', { name: /3D パースを作成する/ });
await go.waitFor({ timeout: 600000 }); await go.click({ timeout: 180000 });
await page.waitForSelector('.shot-card', { timeout: 180000 });
await page.waitForTimeout(4000);
const navs = await page.evaluate(() => { const bs = [...document.querySelectorAll('button, a')].filter((b) => /動画/.test(b.textContent) && b.textContent.length < 20); bs[0]?.click(); return bs.map((b) => b.textContent.trim()); }); console.log('nav:', navs.join(' | '));
await page.waitForTimeout(4000);
// 動画の種類（KIND=シネマ など。既定はウォークスルー）
if (process.env.KIND) { await page.evaluate((k) => { const bs = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === k); bs[0]?.click(); }, process.env.KIND); await page.waitForTimeout(500); }
// プレビュー開始でプログラムが作られる
console.log('video buttons:', (await page.locator('button').allInnerTexts()).filter((t) => t.trim()).join(' | ').slice(0, 600)); await page.evaluate(() => { const bs = [...document.querySelectorAll('button')].filter((b) => /プレビュー|再生|試し/.test(b.textContent)); bs[0]?.click(); });
await page.waitForTimeout(1500);
const data = await page.evaluate((fps) => {
  const p = globalThis.__walkProgram;
  if (!p) return null;
  const frames = [];
  for (let t = 0; t <= p.duration; t += 1 / fps) {
    const s = p.sample(t);
    frames.push({ t: +t.toFixed(3), pos: s.pos.toArray().map((v) => +v.toFixed(3)), target: s.target.toArray().map((v) => +v.toFixed(3)), fov: +s.fov.toFixed(2), fade: +s.fade.toFixed(2), architectural: !!s.architectural, sunDir: s.sunDir ? s.sunDir.toArray().map((v) => +v.toFixed(3)) : undefined, cut: s.cut, doors: s.doors ? [...s.doors.entries()].filter(([, v]) => v > 0.01).map(([k, v]) => [k, +v.toFixed(2)]) : [] });
  }
  return { duration: p.duration, fps, captions: p.captions, frames };
}, +fpsS);
if (!data) console.log('no program'); else { writeFileSync(out, JSON.stringify(data)); console.log('frames', data.frames.length, 'duration', data.duration.toFixed(1)); }
await b.close();
