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
/**
 * 進行モーダル（資料の自動作成・日照の解析など）は中止せず、終わるまで待つ（最長 300 秒）。
 * 以前は 220ms 後に「中止」を押していたが、重い描画の間はクリックが届かず作成が続き、
 * 「ステップを往復」で 1 番目のボタンが 90 秒押せない原因になっていた。待てば本番の一気通貫の動作も点検できる
 */
const settleProgress = async (label) => {
  const prog = page.locator('.modal.progress');
  if (!(await prog.count().catch(() => 0))) return;
  const t0 = Date.now();
  const done = await prog.first().waitFor({ state: 'detached', timeout: 300000 }).then(() => true).catch(() => false);
  const sec = Math.round((Date.now() - t0) / 1000);
  log.push({ step: cur, kind: done ? 'progress' : 'check', msg: done ? `${label}: ${sec} 秒で完了` : `${label}: 300 秒たっても終わらない（中止して続ける）` });
};
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
      await settleProgress(label);
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
      await s.selectOption(other, { timeout: 6000 });
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
/**
 * 建物の外（庭）に取った 3m 角の四角の 4 点（図面座標 mm）。全部の階の外形の外で、方眼の画面に見えている所
 * （1 階の右だけを見ていたら、2・3 階が 1 階より大きい家（田中様邸）では点が画面の外に出て、屋根の道具の確認が空振りしていた）
 */
const yardSquare = () =>
  page.evaluate(() => {
    const m = window.__state.model;
    const pts = m.floors.flatMap((f) => (f.outline.flat().length ? f.outline.flat() : f.walls.flatMap((w) => [w.a, w.b])));
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const S = 1500;
    const sq = (x0, y0) => [
      { x: x0, y: y0 },
      { x: x0 + S, y: y0 },
      { x: x0 + S, y: y0 + S },
      { x: x0, y: y0 + S },
    ];
    const cands = [];
    for (const g of [600, 400]) cands.push(sq(maxX + g, cy - S / 2), sq(minX - g - S, cy - S / 2), sq(cx - S / 2, maxY + g), sq(cx - S / 2, minY - g - S), sq(maxX + g, maxY + g), sq(minX - g - S, maxY + g));
    const svg = document.querySelector('.pe-svg');
    if (!svg) return cands[0];
    const r = svg.getBoundingClientRect();
    const ctm = svg.getScreenCTM();
    // 方眼の上に重なるパネル・説明の帯に隠れる所は使わない
    const covers = [...document.querySelectorAll('.pe-panel, .pe-tip')].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect());
    const onScreen = (p) => {
      const pt = svg.createSVGPoint();
      pt.x = p.x;
      pt.y = p.y;
      const q = pt.matrixTransform(ctm);
      if (!(q.x > r.left + 10 && q.x < r.right - 10 && q.y > r.top + 10 && q.y < r.bottom - 10)) return false;
      return !covers.some((c) => q.x > c.left - 6 && q.x < c.right + 6 && q.y > c.top - 6 && q.y < c.bottom + 6);
    };
    return cands.find((c) => c.every(onScreen)) ?? cands[0];
  });
/**
 * 3D で見えている庭の 1.5m 角の四角（図面座標 mm）。画面を格子状に指して地面（芝・土間・道路）に当たる所を探し、
 * そこを角にして、4 つの角がどれも建物（外形の 600 mm 外まで）に掛からず、パネルに隠れず、指すと地面に当たる四角を返す。
 * 道路側の低い視点では建物の裏の庭が隠れていて、クリックが建物の床に当たり「小さすぎます」になっていた（第 36〜40 巡の点検で毎回出ていた 1 件）。
 * 建物のまわりに決め打ちの四角を置く方法は、カメラ・パネルの位置しだいで全部隠れることがあった（第 41 巡）
 */
const yardSquare3d = () =>
  page.evaluate(() => {
    const v = window.__viewer;
    const m = window.__state.model;
    if (!v || !m) return null;
    const pts = m.floors.flatMap((f) => (f.outline.flat().length ? f.outline.flat() : f.walls.flatMap((w) => [w.a, w.b])));
    const M = 600;
    const box = { minX: Math.min(...pts.map((p) => p.x)) - M, maxX: Math.max(...pts.map((p) => p.x)) + M, minY: Math.min(...pts.map((p) => p.y)) - M, maxY: Math.max(...pts.map((p) => p.y)) + M };
    const nearHouse = (p) => p.x > box.minX && p.x < box.maxX && p.y > box.minY && p.y < box.maxY;
    const r = v.renderer.domElement.getBoundingClientRect();
    const V3 = v.camera.position.constructor;
    // 画面の点 → 地面の点（パネル・帯に隠れている所、地面より上の物に当たる所は null）
    const groundAt = (sx, sy) => {
      if (!(sx > r.left + 12 && sx < r.right - 12 && sy > r.top + 12 && sy < r.bottom - 12)) return null;
      if (document.elementFromPoint(sx, sy) !== v.renderer.domElement) return null;
      const hit = v.pickHit({ x: ((sx - r.left) / r.width) * 2 - 1, y: -((sy - r.top) / r.height) * 2 + 1 });
      // 芝・土間・道路は外構（landscape）の面。木・フェンスなど地面より上の物に当たったら地面ではない
      if (!hit || !['ground', 'building', 'landscape'].includes(hit.group) || hit.point.y > 0.6) return null;
      return { x: hit.point.x * 1000, y: hit.point.z * 1000 };
    };
    const visible = (p) => {
      const q = new V3(p.x / 1000, 0.05, p.y / 1000).project(v.camera);
      if (q.z > 1 || q.z < -1) return false;
      const g = groundAt(r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height);
      return !!g && Math.hypot(g.x - p.x, g.y - p.y) < 300;
    };
    const S = 1500;
    for (let fy = 0.3; fy < 0.95; fy += 0.05)
      for (let fx = 0.35; fx < 0.92; fx += 0.05) {
        const g = groundAt(r.left + r.width * fx, r.top + r.height * fy);
        if (!g || nearHouse(g)) continue;
        for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
          const sq = [g, { x: g.x + dx * S, y: g.y }, { x: g.x + dx * S, y: g.y + dy * S }, { x: g.x, y: g.y + dy * S }].map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
          if (sq.some(nearHouse)) continue;
          if (sq.every(visible)) return sq;
        }
      }
    return null;
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
      await modes.nth(i).click({ timeout: 10000 });
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
        // 見えている庭を探す。今の視点で見えなければ鳥瞰に切り替えて探し直す
        let ysq = await yardSquare3d();
        if (!ysq) {
          const bird = page.locator('button', { hasText: /^鳥瞰$/ }).first();
          if (await bird.count()) {
            await bird.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(1500);
            ysq = await yardSquare3d();
          }
        }
        if (!ysq) log.push({ step: cur, kind: 'note', msg: '3D で見えている庭が見つからず、屋根を足す確認を省いた' });
        if (ysq && (await add.count())) {
          await add.click({ timeout: 8000 });
          await page.waitForTimeout(200);
          const a = await screenOf(ysq[0].x, ysq[0].y, 0.05);
          const b = await screenOf(ysq[2].x, ysq[2].y, 0.05);
          await page.mouse.click(a.x, a.y);
          await page.waitForTimeout(400);
          await page.mouse.click(b.x, b.y);
          await page.waitForTimeout(1500);
          const del = tool.locator('button', { hasText: 'この屋根を消す' });
          if (await del.count()) await del.click({ timeout: 8000 });
          else log.push({ step: cur, kind: 'check', msg: '床を 2 回クリックしても屋根が足されなかった' });
          await page.waitForTimeout(800);
        }
        const wall = tool.locator('button', { hasText: '壁を足す' }).first();
        if (await wall.count()) {
          await wall.click({ timeout: 8000 });
          await page.waitForTimeout(300);
          const stop = tool.locator('button', { hasText: /壁を足すのをやめる|やめる/ }).first();
          if (await stop.count()) await stop.click({ timeout: 8000 });
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
    await settleProgress('往復の前の進行モーダル');
    await closeModals();
    await page.locator('button.step').nth(i).click({ noWaitAfter: true, timeout: 90000 });
    await page.waitForTimeout(3000);
  }
};
try {
  await main();
} catch (e) {
  log.push({ step: cur, kind: 'crash', msg: String(e.message).split('\n')[0].slice(0, 200) });
}
writeFileSync(`${out}/log.json`, JSON.stringify(log, null, 1));
const bad = log.filter((l) => !['summary', 'after-click', 'after-tool', 'unclickable', 'progress'].includes(l.kind));
for (const l of log.filter((l) => l.kind === 'progress')) console.log(`[${l.step}] progress: ${l.msg}`);
const unclickable = log.filter((l) => l.kind === 'unclickable');
console.log('summary', log.filter((l) => l.kind === 'summary').map((l) => `${l.step}: ${l.msg}`).join(' | '));
console.log('issues', bad.length, '(pageerror / console.error / check / crash)');
for (const l of bad.slice(0, 80)) console.log(`[${l.step}] ${l.kind}: ${l.msg}`);
console.log('unclickable', unclickable.length, '(押せなかったボタン。ほかの要素に隠れている・途中で作り直された。エラーではないが多ければ見直す)');
for (const l of unclickable.slice(0, 40)) console.log(`  [${l.step}] ${l.msg.replace(/\s+/g, ' ').slice(0, 90)}`);
await browser.close();
