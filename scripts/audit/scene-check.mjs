// 撮影せずに光線の点検だけを回す（3D を直した後の見直しを速くする）
//   node scripts/audit/scene-check.mjs <model.json のフォルダ> [ベース URL]
import { chromium } from 'playwright-core';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
const [dir, base = 'http://localhost:8765/'] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.model.json')).sort()) {
  const id = f.replace('.model.json', '');
  if (only && !only.has(id)) continue;
  const model = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  const p = await b.newPage({ viewport: { width: 320, height: 200 } });
  p.on('pageerror', (e) => console.log(id, '[pageerror]', e.message));
  await p.route('**/__audit/model.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ model }) }));
  await p.goto(base + 'render.html?src=' + encodeURIComponent(base + '__audit/model.json'));
  await p.waitForFunction(() => window.__ready === true || window.__failed === true, null, { timeout: 180000 });
  const t0 = Date.now(); const a = await p.evaluate(() => window.__auditScene()); const ms = Date.now() - t0;
  const wallM = Math.round(a.walls.reduce((s, x) => s + x.len, 0) * 10) / 10;
  const roofN = a.roofs.reduce((s, x) => s + x.n, 0);
  console.log(`${id}: 外壁の抜け ${a.walls.length} か所 ${wallM} m / ${a.wallSamples} 点、屋根の穴 ${roofN} / ${a.roofSamples} 点（${ms}ms）`);
  if (process.env.V) for (const x of a.walls) console.log('   壁', JSON.stringify(x));
  if (process.env.V) for (const x of a.roofs) console.log('   屋根', JSON.stringify(x));
  await p.close();
}
await b.close();
