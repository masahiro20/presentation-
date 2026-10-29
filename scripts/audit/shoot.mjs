// お客様の図面の一括点検: 本番と同じ画面で図面を読み込み → モデル（JSON）と読み取りチェックを保存 →
// 撮影ページ（render.html）で外観を 8 方向＋鳥瞰で撮り、1 邸 1 枚の一覧（contact sheet）にまとめる。
//   node scripts/audit/shoot.mjs <PDF のフォルダ> <出力フォルダ> [ベース URL]
// ベース URL は dist を配っているサーバ（例: python3 -m http.server 8765 --directory dist）。
// 図面（お客様の PDF）と出力はリポジトリに入れない（作業用フォルダに置く）。
import { chromium } from 'playwright-core';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const [inDir, outDir, base = 'http://localhost:8765/'] = process.argv.slice(2);
if (!inDir || !outDir) throw new Error('usage: shoot.mjs <pdfDir> <outDir> [baseUrl]');
mkdirSync(outDir, { recursive: true });
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
// 入力が「〜.model.json」（前回の出力）なら読み込みを飛ばして撮影だけ（3D 側を直したときの見直し用）
const idOf = (f) => f.replace(/\.model\.json$/, '').replace(/\.\w+$/, '');
const files = readdirSync(inDir).filter((f) => /\.(pdf|dxf)$|\.model\.json$/i.test(f) && (!only || only.has(idOf(f)))).sort();
const VIEWS = [
  ...[0, 45, 90, 135, 180, 225, 270, 315].map((az) => ({ name: `az${az}`, az, el: 18 })),
  { name: 'aerial', az: 30, el: 58 },
];

import { globSync } from 'node:fs';
// 入っている Chromium を探す（環境ごとに版が違う）
const chromePath = globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome').sort().pop() ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: chromePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const summary = [];
for (const f of files) {
  const id = idOf(f);
  const t0 = Date.now();
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|CERT/.test(m.text()) && errors.push(`console: ${m.text().slice(0, 200)}`));
  try {
    let model;
    let toastText = '';
    if (f.endsWith('.model.json')) {
      model = JSON.parse(readFileSync(path.join(inDir, f), 'utf8'));
      await page.close();
    } else {
    await page.goto(base + '#import');
    await page.waitForTimeout(1500);
    await page.evaluate(
      ([b64, name]) => {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bin], name, { type: 'application/pdf' }));
        const inp = document.querySelector('input[accept*="pdf"]');
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change'));
      },
      [readFileSync(path.join(inDir, f)).toString('base64'), f],
    );
    await page.waitForFunction(() => /認識|失敗|できません/.test([...document.querySelectorAll('.toast')].map((t) => t.textContent).join('')), null, { timeout: 240000, polling: 300 });
    toastText = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
    model = await page.evaluate(() => (globalThis.__state?.model ? JSON.parse(JSON.stringify(globalThis.__state.model)) : null));
    await page.waitForTimeout(800);
    const panel = await page.evaluate(() => document.querySelector('.side, aside, .panel')?.innerText ?? '');
    await page.close();
    if (!model) {
      summary.push({ id, ok: false, toast: toastText, errors });
      console.log(JSON.stringify(summary[summary.length - 1]));
      continue;
    }
    writeFileSync(path.join(outDir, `${id}.model.json`), JSON.stringify(model));
    writeFileSync(path.join(outDir, `${id}.panel.txt`), panel);
    }

    const rp = await browser.newPage({ viewport: { width: 960, height: 600 } });
    rp.on('pageerror', (e) => errors.push(`render pageerror: ${e.message}`));
    await rp.route('**/__audit/model.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ model }) }));
    await rp.goto(base + 'render.html?src=' + encodeURIComponent(base + '__audit/model.json'));
    await rp.waitForFunction(() => window.__ready === true || window.__failed === true, null, { timeout: 180000 });
    if (await rp.evaluate(() => window.__failed === true)) errors.push('render.html が失敗しました');
    // 光線による外皮の点検（外壁の抜け・屋根の穴）
    const audit = await rp.evaluate(() => window.__auditScene?.() ?? null);
    writeFileSync(path.join(outDir, `${id}.audit.json`), JSON.stringify(audit, null, 1));
    const imgs = [];
    for (const v of VIEWS) {
      const url = await rp.evaluate(([az, el]) => window.__renderOrbit(az, el, 640, 400), [v.az, v.el]);
      const file = `${id}_${v.name}.png`;
      writeFileSync(path.join(outDir, file), Buffer.from(url.split(',')[1], 'base64'));
      imgs.push({ file, label: v.name, url });
    }
    // 一覧（3×3）
    const html = `<html><body style="margin:0;background:#222;font:14px sans-serif;color:#eee"><div style="padding:6px 10px">${id} — ${model.floors.length}階・${model.floors.map((fl) => `${fl.level}F 壁${fl.walls.length}/室${fl.rooms.length}`).join(' ')}</div><div style="display:grid;grid-template-columns:repeat(3,640px);gap:4px">${imgs.map((i) => `<div style="position:relative"><img src="${i.url}" width=640 height=400><span style="position:absolute;left:6px;top:4px;background:#0008;padding:1px 5px">${i.label}</span></div>`).join('')}</div></body></html>`;
    await rp.setViewportSize({ width: 1928, height: 1250 });
    await rp.setContent(html);
    await rp.screenshot({ path: path.join(outDir, `${id}_sheet.png`), fullPage: true });
    await rp.close();
    summary.push({ id, ok: true, toast: toastText, secs: Math.round((Date.now() - t0) / 1000), wallHoles: audit?.walls.length, wallHoleM: audit ? Math.round(audit.walls.reduce((s, x) => s + x.len, 0) * 10) / 10 : null, roofHoles: audit?.roofs.reduce((s, x) => s + x.n, 0), errors });
  } catch (e) {
    summary.push({ id, ok: false, error: e.message.slice(0, 300), errors });
    await page.close().catch(() => {});
  }
  console.log(JSON.stringify(summary[summary.length - 1]));
}
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
await browser.close();
