import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--ignore-certificate-errors'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/?sample=sample_house_A3.pdf#video');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
const info = await page.evaluate(async () => {
  const { walkthroughProgram } = await import('/src/video/paths.ts');
  const v = window.app.viewer;
  const st = v.state;
  window.__walk = walkthroughProgram(st.model, st.meta, st.site, v.shots());
  return { d: window.__walk.duration, caps: window.__walk.captions };
});
console.log(JSON.stringify(info));
const ts = [1, 8, 14, 20, 30, 45, 60, 75];
for (const t of ts) {
  await page.evaluate((t) => {
    const s = window.__walk.sample(t);
    window.app.viewer.applyView({ pos: s.pos, target: s.target, fov: s.fov });
    window.app.viewer.renderFrame();
  }, t);
  await page.waitForTimeout(400);
  await page.locator('#viewer3d canvas').screenshot({ path: `test-output/walk-${t}.png` });
}
await browser.close();
