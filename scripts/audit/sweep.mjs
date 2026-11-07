// 動作エラーの自動チェック（バグ総点検）: 図面を 1 件読み込み、
//  1. 各ステップの側パネルのボタン・折りたたみ・セレクトを順に触る
//  2. 図面読込の方眼の道具（選択〜屋根）をひとつずつ使う（クリック・描く・Esc・Delete。屋根は点を打って足し、選び、消す）
//  3. 3D の「窓・戸」の道具の各モード（窓・戸／天井高／シャッター／屋根）でパネルを触り、3D をクリックする
// を行い、ページのエラー（pageerror・console.error）と、押せなかったボタンを拾う。
// node scripts/audit/sweep.mjs <pdf> <outDir> [base]   （dist を http.server 8765 で配っておく）
import { chromium } from 'playwright-core';
import { copyFileSync, mkdirSync, writeFileSync, globSync } from 'node:fs';
const [pdf, out, base = 'http://localhost:8765/'] = process.argv.slice(2);
if (!pdf || !out) {
  console.error('usage: node scripts/audit/sweep.mjs <pdf> <outDir> [base]');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const chromePath = globSync('/opt/pw-browsers/chromium-*/chrome-linux*/chrome').sort().pop();
const browser = await chromium.launch({ executablePath: chromePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const log = [];
let cur = 'start';
page.on('pageerror', (e) => log.push({ step: cur, kind: 'pageerror', msg: e.message.slice(0, 300) }));
page.on('console', (m) => {
  if (m.type() === 'error' && !/404|favicon|ERR_|net::|CERT/.test(m.text())) log.push({ step: cur, kind: 'console', msg: m.text().slice(0, 300) });
});
page.on('dialog', (d) => d.dismiss().catch(() => {}));
// 新しいタブ（印刷用）は閉じる
ctx.on('page', (p) => p.waitForLoadState('domcontentloaded').then(() => p.close()).catch(() => {}));
await page.goto(base + '#import');
await page.waitForTimeout(2500);
mkdirSync('/home/user/presentation-/dist/tmp', { recursive: true });
copyFileSync(pdf, '/home/user/presentation-/dist/tmp/sweep.pdf');
await page.evaluate(async () => {
  const buf = await (await fetch('/tmp/sweep.pdf?t=' + Date.now())).arrayBuffer();
  const input = document.querySelector('input[accept*="pdf"]');
  const dt = new DataTransfer();
  dt.items.add(new File([buf], 'sweep.pdf'));
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
});
await page.getByRole('button', { name: /3D パースを作成する/ }).waitFor({ timeout: 180000 });
await page.waitForTimeout(1500);
// 触らないボタン（破壊的・時間がかかる・外部）
const SKIP = /3D パース|提案一式|別の PDF|再解析|保存|評価用|読み込む|取得|検索|動画|体験リンク|お客様に渡す|仕上げ（外部）|ZIP|PDF|印刷|ダウンロード|書き出|削除|やめる|消す|リセット|開く|3DS|点群|Google|API|ファイル|写真|ログ|送る|コピー|照合をやめる|比較をやめる|戻す/;
const closeModals = async () => {
  const modal = page.locator('.modal-back').last();
  if (await modal.count()) {
    const close = modal.locator('button', { hasText: /^(閉じる|やめる|中止|×)$/ }).last();
    if (await close.count()) await close.click({ timeout: 2000 }).catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelectorAll('.modal-back').forEach((m) => m.remove()));
  }
};
/** 範囲の中のボタンを順に押し、セレクトを切り替えて戻す */
const sweepIn = async (name, scope, { maxButtons = 120, skip = SKIP } = {}) => {
  cur = name;
  await page.evaluate(() => { for (const d of document.querySelectorAll('aside details, .side details, .pe-panel details, .furn-tool details')) d.open = true; });
  await page.waitForTimeout(200);
  const btns = scope.locator('button');
  const n = await btns.count();
  let clicked = 0;
  for (let i = 0; i < Math.min(n, maxButtons); i++) {
    const b = btns.nth(i);
    let label = '';
    try {
      if (!(await b.isVisible()) || !(await b.isEnabled())) continue;
      label = (await b.innerText()).trim().slice(0, 30);
      if (!label || skip.test(label) || skip.test((await b.getAttribute('title')) ?? '')) continue;
      const before = log.length;
      await b.click({ timeout: 5000, noWaitAfter: true });
      clicked++;
      await page.waitForTimeout(220);
      await closeModals();
      if (log.length > before) log.push({ step: name, kind: 'after-click', msg: label });
    } catch (e) {
      // 押せなかった（ほかの要素に隠れている・途中で作り直された）: エラーとは分けて数える
      log.push({ step: name, kind: /Timeout/.test(String(e.message)) ? 'unclickable' : 'click-failed', msg: `${label}: ${String(e.message).split('\n')[0].slice(0, 120)}` });
    }
  }
  const sels = scope.locator('select');
  const sn = await sels.count();
  for (let i = 0; i < Math.min(sn, 40); i++) {
    const s = sels.nth(i);
    try {
      if (!(await s.isVisible())) continue;
      const opts = await s.locator('option').evaluateAll((os) => os.map((o) => o.value));
      const v0 = await s.inputValue();
      const other = opts.find((v) => v !== v0);
      if (other == null) continue;
      await s.selectOption(other, { timeout: 2000 });
      await page.waitForTimeout(250);
      if (await s.isVisible().catch(() => false)) await s.selectOption(v0, { timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(150);
    } catch (e) {
      log.push({ step: name, kind: 'select-failed', msg: String(e.message).split('\n')[0].slice(0, 120) });
    }
  }
  log.push({ step: name, kind: 'summary', msg: `buttons ${n}, clicked ${clicked}, selects ${sn}` });
  await page.evaluate(() => document.querySelectorAll('.modal-back').forEach((m) => m.remove()));
};
const shot = (file) => page.screenshot({ path: `${out}/${file}`, timeout: 60000 }).catch((e) => log.push({ step: cur, kind: 'screenshot-failed', msg: String(e.message).split('\n')[0].slice(0, 120) }));
const sweepSide = async (name) => {
  await sweepIn(name, page.locator('aside, .side').first());
  await shot(`${name}.png`);
};

/** 方眼の修正画面: 図面座標 mm → 画面座標 */
const svgPoint = (x, y) =>
  page.evaluate(([x, y]) => {
    const svg = document.querySelector('.pe-svg');
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    const q = pt.matrixTransform(svg.getScreenCTM());
    return { x: q.x, y: q.y };
  }, [x, y]);
/** 1 階の外形の外（右の庭）に取った四角の 4 点（図面座標 mm） */
const yardSquare = () =>
  page.evaluate(() => {
    const m = window.__state.model;
    const f = m.floors[0];
    const pts = f.outline.flat().length ? f.outline.flat() : f.walls.flatMap((w) => [w.a, w.b]);
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const cy = (minY + maxY) / 2;
    return [
      { x: maxX + 1000, y: cy - 1500 },
      { x: maxX + 4000, y: cy - 1500 },
      { x: maxX + 4000, y: cy + 1500 },
      { x: maxX + 1000, y: cy + 1500 },
    ];
  });
/** 建物の中の点（1 階のいちばん大きい部屋の文字の位置） */
const insidePoint = () =>
  page.evaluate(() => {
    const f = window.__state.model.floors[0];
    const r = f.rooms.slice().sort((a, b) => b.area - a.area)[0];
    return r ? { x: r.labelPos.x, y: r.labelPos.y } : { x: 0, y: 0 };
  });

/** 2. 方眼の道具を順に使う */
const sweepPlanEditor = async () => {
  cur = '方眼';
  // 側パネルの総当たりで「図面で見る」に切り替わっていることがあるので、方眼に戻す
  const editMode = page.locator('.imp-mode button', { hasText: '方眼で直す' });
  if (await editMode.count()) await editMode.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(400);
  if (!(await page.locator('.pe-svg').isVisible().catch(() => false))) {
    log.push({ step: cur, kind: 'check', msg: '方眼の修正画面が出ていない' });
    return;
  }
  const tools = page.locator('.pe-tools button');
  const n = await tools.count();
  const svg = page.locator('.pe-svg');
  const inside = await insidePoint();
  const sq = await yardSquare();
  for (let i = 0; i < n; i++) {
    const label = (await tools.nth(i).innerText()).trim();
    cur = `方眼:${label}`;
    const before = log.length;
    try {
      await tools.nth(i).click({ timeout: 3000 });
      await page.waitForTimeout(250);
      const a = await svgPoint(inside.x, inside.y);
      const b = await svgPoint(sq[0].x, sq[0].y);
      // 中を動いてクリック、庭をクリック、少しドラッグ、Esc
      await page.mouse.move(a.x, a.y);
      await page.mouse.move(a.x + 20, a.y + 10);
      await page.mouse.click(a.x, a.y);
      await page.waitForTimeout(200);
      await page.mouse.move(b.x, b.y);
      await page.mouse.down();
      await page.mouse.move(b.x + 40, b.y + 30, { steps: 4 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      if (label === '屋根') {
        // 点を打って四角の屋根を足す → 選ぶ → パネルを触る → Delete で消す → 屋根なしの範囲も描いて消す
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        for (const p of sq) {
          const c = await svgPoint(p.x, p.y);
          await page.mouse.move(c.x, c.y);
          await page.mouse.click(c.x, c.y);
          await page.waitForTimeout(120);
        }
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        const added = await page.evaluate(() => (window.__state.model.roofPatches ?? []).filter((p) => p.loop).length);
        if (!added) log.push({ step: cur, kind: 'check', msg: '点を打った屋根が足されなかった' });
        const mid = await svgPoint((sq[0].x + sq[2].x) / 2, (sq[0].y + sq[2].y) / 2);
        await page.mouse.click(mid.x, mid.y);
        await page.waitForTimeout(300);
        const selected = await page.locator('.pe-panel').innerText().catch(() => '');
        if (!/足した屋根/.test(selected)) log.push({ step: cur, kind: 'check', msg: `足した屋根を選べなかった: ${selected.replace(/\s+/g, ' ').slice(0, 80)}` });
        await sweepIn(`${cur}:パネル`, page.locator('.pe-panel'), { skip: /消す|やめる|戻す|描く|足す/ });
        // 角をドラッグ
        const hnd = page.locator('.pe-roof-handle').first();
        if (await hnd.count()) {
          const bb = await hnd.boundingBox();
          if (bb) {
            await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
            await page.mouse.down();
            await page.mouse.move(bb.x + bb.width / 2 + 30, bb.y + bb.height / 2 + 25, { steps: 5 });
            await page.mouse.up();
            await page.waitForTimeout(300);
          }
        } else log.push({ step: cur, kind: 'check', msg: '角のつまみが出ていない' });
        await shot('方眼_屋根.png');
        // 屋根なしの範囲にして戻す
        const omitBtn = page.locator('.pe-panel button', { hasText: '屋根なしの範囲にする' });
        if (await omitBtn.count()) {
          await omitBtn.click({ timeout: 2000 });
          await page.waitForTimeout(300);
          const back = page.locator('.pe-panel button', { hasText: 'この範囲に屋根を掛ける' });
          if (await back.count()) await back.click({ timeout: 2000 });
          await page.waitForTimeout(300);
        }
        await page.keyboard.press('Delete');
        await page.waitForTimeout(300);
        const left = await page.evaluate(() => (window.__state.model.roofPatches ?? []).filter((p) => p.loop).length);
        if (left) log.push({ step: cur, kind: 'check', msg: `Delete で消えなかった（残り ${left}）` });
        // Ctrl+Z で戻し、もう一度 Ctrl+Z で足す前へ
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(250);
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(250);
        // 自動の塊（この階の屋根）をクリックして掛け方を切妻に → おまかせに戻す
        const massPt = await page.evaluate(() => {
          const lv = document.querySelector('.pe-tabs .dark')?.textContent?.replace(/[^0-9]/g, '') ?? '1';
          const g = document.querySelector(`.pe-roof[data-level="${lv}"]`) ?? document.querySelector('.pe-roof');
          return g ? { x: +g.dataset.cx, y: +g.dataset.cy } : null;
        });
        const inA = await svgPoint(massPt?.x ?? inside.x, massPt?.y ?? inside.y);
        await page.mouse.click(inA.x, inA.y);
        await page.waitForTimeout(300);
        const gable = page.locator('.pe-panel .segmented button', { hasText: /^切妻$/ }).first();
        if (await gable.count()) {
          await gable.click({ timeout: 2000 });
          await page.waitForTimeout(400);
          const auto = page.locator('.pe-panel .segmented button', { hasText: /^おまかせ$/ }).first();
          if (await auto.count()) await auto.click({ timeout: 2000 });
          await page.waitForTimeout(300);
        } else log.push({ step: cur, kind: 'check', msg: '建物の中をクリックしても屋根の塊を選べなかった' });
      } else {
        await sweepIn(`${cur}:パネル`, page.locator('.pe-panel'), { skip: /消す|やめる|戻す|削除/ });
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      await page.keyboard.press('Delete');
      await page.waitForTimeout(150);
      await page.keyboard.press('Escape');
    } catch (e) {
      log.push({ step: cur, kind: 'tool-failed', msg: String(e.message).split('\n')[0].slice(0, 160) });
    }
    if (log.length > before) log.push({ step: cur, kind: 'after-tool', msg: label });
    await closeModals();
  }
  // 選択の道具に戻す
  await tools.first().click({ timeout: 3000 }).catch(() => {});
  await shot('方眼.png');
};

/** 3. 3D の「窓・戸」の道具（各モード） */
const sweep3dTool = async () => {
  cur = '3D道具';
  const nav = page.locator('.nav-btn', { hasText: '窓・戸' });
  if (!(await nav.count())) {
    log.push({ step: cur, kind: 'check', msg: '窓・戸の道具のボタンが無い' });
    return;
  }
  // 3D の最初の描画が重い間はクリックが通らないことがあるので、構図が出て落ち着くまで待つ
  await page.waitForFunction(() => !!window.__viewer && document.querySelectorAll('.shot-card').length > 0, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  try {
    await nav.click({ timeout: 20000 });
  } catch (e) {
    log.push({ step: cur, kind: 'check', msg: `窓・戸の道具を開けなかった: ${String(e.message).split('\n')[0].slice(0, 100)}` });
    return;
  }
  await page.waitForTimeout(500);
  const tool = page.locator('.furn-tool.edit3d');
  // モードのボタン列（見出しのすぐ下: 窓・戸／天井高／シャッター／屋根）
  const modes = tool.locator('.furn-head + div > button');
  const mn = await modes.count();
  if (!mn) log.push({ step: cur, kind: 'check', msg: '窓・戸の道具のモードのボタンが見つからない' });
  /** 3D 上の点（図面座標 mm, 高さ m）→ 画面座標 */
  const screenOf = (x, y, h) =>
    page.evaluate(([x, y, h]) => {
      const v = window.__viewer;
      const r = v.renderer.domElement.getBoundingClientRect();
      const V3 = v.camera.position.constructor;
      const q = new V3(x / 1000, h, y / 1000).project(v.camera);
      return { x: r.left + ((q.x + 1) / 2) * r.width, y: r.top + ((1 - q.y) / 2) * r.height };
    }, [x, y, h]);
  const inside = await insidePoint();
  const sq = await yardSquare();
  for (let i = 0; i < mn; i++) {
    const label = (await modes.nth(i).innerText()).trim();
    cur = `3D道具:${label}`;
    const before = log.length;
    try {
      await modes.nth(i).click({ timeout: 3000 });
      await page.waitForTimeout(300);
      // 3D をクリック（建物の中の床・庭・屋根の高さ）
      for (const [pt, hgt] of [[inside, 0.6], [sq[0], 0.1], [inside, 3.2]]) {
        const c = await screenOf(pt.x, pt.y, hgt);
        await page.mouse.click(c.x, c.y);
        await page.waitForTimeout(400);
      }
      await sweepIn(`${cur}:パネル`, tool, { skip: /消す|やめる|戻す|削除|足す|閉じる/ });
      if (label === '屋根') {
        // 屋根を足す（床を 2 回クリック）→ 消す。壁を足す → やめる
        const add = tool.locator('button', { hasText: '屋根を足す' }).first();
        if (await add.count()) {
          await add.click({ timeout: 2000 });
          await page.waitForTimeout(200);
          const a = await screenOf(sq[0].x, sq[0].y, 0.05);
          const b = await screenOf(sq[2].x, sq[2].y, 0.05);
          await page.mouse.click(a.x, a.y);
          await page.waitForTimeout(400);
          await page.mouse.click(b.x, b.y);
          await page.waitForTimeout(1500);
          const del = tool.locator('button', { hasText: 'この屋根を消す' });
          if (await del.count()) await del.click({ timeout: 2000 });
          else log.push({ step: cur, kind: 'check', msg: '床を 2 回クリックしても屋根が足されなかった' });
          await page.waitForTimeout(800);
        }
        const wall = tool.locator('button', { hasText: '壁を足す' }).first();
        if (await wall.count()) {
          await wall.click({ timeout: 2000 });
          await page.waitForTimeout(300);
          const stop = tool.locator('button', { hasText: /壁を足すのをやめる|やめる/ }).first();
          if (await stop.count()) await stop.click({ timeout: 2000 });
          await page.waitForTimeout(300);
        }
      }
      await shot(`3D道具_${label}.png`);
    } catch (e) {
      log.push({ step: cur, kind: 'tool-failed', msg: String(e.message).split('\n')[0].slice(0, 160) });
    }
    if (log.length > before) log.push({ step: cur, kind: 'after-tool', msg: label });
    await closeModals();
  }
  await nav.click({ timeout: 5000 }).catch(() => {});
};

const main = async () => {
  await sweepSide('import');
  await sweepPlanEditor();
  await page.getByRole('button', { name: /3D パースを作成する/ }).click({ noWaitAfter: true, timeout: 30000 });
  await page.waitForSelector('.shot-card', { timeout: 180000, state: 'attached' });
  await page.waitForTimeout(2500);
  await sweep3dTool();
  const steps = await page.locator('button.step').allInnerTexts();
  for (let i = 1; i < steps.length; i++) {
    await page.locator('button.step').nth(i).click({ noWaitAfter: true, timeout: 30000 });
    await page.waitForTimeout(i === 3 ? 9000 : 6000);
    await sweepSide(steps[i].replace(/\s+/g, '').replace(/^\d/, ''));
  }
  // ステップを往復して壊れないか
  for (const i of [0, 1, 0, 4, 1, 6, 2]) {
    cur = `nav-${i}`;
    await page.locator('button.step').nth(i).click({ noWaitAfter: true, timeout: 30000 });
    await page.waitForTimeout(3000);
  }
};
try {
  await main();
} catch (e) {
  log.push({ step: cur, kind: 'crash', msg: String(e.message).split('\n')[0].slice(0, 200) });
}
writeFileSync(`${out}/log.json`, JSON.stringify(log, null, 1));
const bad = log.filter((l) => !['summary', 'after-click', 'after-tool', 'unclickable'].includes(l.kind));
const unclickable = log.filter((l) => l.kind === 'unclickable');
console.log('summary', log.filter((l) => l.kind === 'summary').map((l) => `${l.step}: ${l.msg}`).join(' | '));
console.log('issues', bad.length, '(pageerror / console.error / check / crash)');
for (const l of bad.slice(0, 80)) console.log(`[${l.step}] ${l.kind}: ${l.msg}`);
console.log('unclickable', unclickable.length, '(押せなかったボタン。ほかの要素に隠れている・途中で作り直された。エラーではないが多ければ見直す)');
for (const l of unclickable.slice(0, 40)) console.log(`  [${l.step}] ${l.msg.replace(/\s+/g, ' ').slice(0, 90)}`);
await browser.close();
