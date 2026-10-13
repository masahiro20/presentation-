// PLATEAU 3D Tiles の E2E と計測（日照ツール /sun.html・実ネット）:
//   「座標で指定」→「この場所で周辺環境を読み込む」を 6 地点で実行し、window.study から
//   棟数・出典の内訳・mesh の有無・LOD 内訳・足元輪郭の種類・注記・データセットと、ネットワークから
//   建物タイル（.b3dm）の枚数・MB・所要秒、地形との整合（|PLATEAU の _zmin − 地形の baseElev| の中央値）を記録する。
//   奥沢ではサンプル 3DS → 日照シミュレーション → 日照時間マップ → 日影図まで完走させる。
// 使い方: 別端末で `npx vite --port 5199 --strictPort` を起動してから `node scripts/plateau-e2e.mjs [baseUrl] [地点名,...]`
//   地点名を省けば全地点。結果は test-output/plateau-e2e.json（地点ごとの計測と判定）と test-output/plateau-e2e-<地点>.png。
//   終了コード = pageerror の数 + 受け入れ条件の不一致の数（0 なら全部緑）。
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5199';
const only = process.argv[3] ? new Set(process.argv[3].split(',')) : null;
mkdirSync('test-output', { recursive: true });

/**
 * §9 の地点。expect は受け入れ条件（判定は judge() で）。
 *  - okusawa: 世田谷区（13112・2025 LOD2）。notes に世田谷区・2025年度・LOD2、plateau > 200、mesh === plateau、タイル ≤ 6 枚・< 25 MB、
 *             |zmin − baseElev| 中央値 < 0.5 m、60 s 以内、日照時間マップ・日影図まで完走
 *  - higashi: 名古屋市東区 筒井（23102・2022 LOD2）: 葉 2 枚・棟数 > 100（LOD2 の棟数は記録のみ）
 *  - moriyama: 名古屋市守山区 小幡（23113・LOD1 のみ）: notes に LOD1
 *  - border: 区境（逆ジオコーダは 23113、箱は 23102 にも掛かる）: datasets 2 件・notes に両方
 *  - kawagoe / nagano: 未整備（11201・20429）: notes に「未整備」、出典は国土地理院のみ
 */
const SITES = [
  { name: 'okusawa', label: '世田谷区奥沢', lat: 35.6019, lon: 139.6736, full: true },
  { name: 'higashi', label: '名古屋市東区 筒井', lat: 35.1835, lon: 136.933 },
  { name: 'moriyama', label: '名古屋市守山区 小幡', lat: 35.1952, lon: 136.9754 },
  { name: 'border', label: '区境（守山区／東区）', lat: 35.1932, lon: 136.9545 },
  { name: 'kawagoe', label: '川越（未整備）', lat: 35.9251, lon: 139.4858 },
  { name: 'nagano', label: '長野 山村（未整備）', lat: 35.7898, lon: 137.4633 },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--ignore-certificate-errors'],
});

const sec = (t0) => Math.round((Date.now() - t0) / 100) / 10;
const mb = (bytes) => Math.round((bytes / 1048576) * 100) / 100;
const median = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** 1 地点の計測。失敗しても他の地点を続けるため、例外は result.error に畳む */
async function runSite(site) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const result = { name: site.name, label: site.label, lat: site.lat, lon: site.lon, pageErrors: [], consoleErrors: [], net: { tiles: [], tilesets: [], latest: 0, geocoder: 0, index: 0 }, progress: [] };
  page.on('pageerror', (e) => {
    console.log(`[${site.name}] [pageerror]`, e.message);
    result.pageErrors.push(e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !/404|CERT|ERR_/.test(m.text())) {
      console.log(`[${site.name}] [console]`, m.text());
      result.consoleErrors.push(m.text());
    }
  });
  // ネットワークの計測: 建物タイル（.b3dm）は枚数・バイト・HTTP 状態、tileset.json・-latest・逆ジオコーダ・索引は回数
  const tileStart = new Map();
  page.on('request', (req) => {
    if (/\.b3dm(\?|$)/.test(req.url())) tileStart.set(req.url(), Date.now());
  });
  page.on('response', async (res) => {
    const url = res.url();
    try {
      if (/\.b3dm(\?|$)/.test(url)) {
        let bytes = Number(res.headers()['content-length'] ?? NaN);
        try {
          bytes = (await res.body()).byteLength;
        } catch {
          /* 本文を取れなければ Content-Length */
        }
        result.net.tiles.push({ url, status: res.status(), bytes: Number.isFinite(bytes) ? bytes : null, ms: Date.now() - (tileStart.get(url) ?? Date.now()) });
      } else if (/tileset\.json/.test(url) && !/-latest\//.test(url)) result.net.tilesets.push({ url, status: res.status() });
      else if (/-latest\/tileset\.json/.test(url)) result.net.latest++;
      else if (/LonLatToAddress/.test(url)) result.net.geocoder++;
      else if (/plateau-index\.json/.test(url)) result.net.index++;
    } catch {
      /* 計測の失敗は無視 */
    }
  });

  try {
    await page.goto(`${base}/sun.html`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });

    // 座標で指定 → ピンを置く
    await page.locator('input.coord-lat').fill(String(site.lat));
    await page.locator('input.coord-lon').fill(String(site.lon));
    await page.getByRole('button', { name: 'この座標にピンを置く' }).click();
    await page.waitForFunction(() => !!window.study?.frame, null, { timeout: 30000 });
    await page.waitForTimeout(1200);
    const frame = await page.evaluate(() => ({ lat: window.study.frame.lat, lon: window.study.frame.lon, address: window.study.frame.address }));
    result.frame = frame;

    // 周辺環境の読み込み。進捗モーダルの段階の文（「市区町村を調べています」「建物タイル 3/6（8.1 MB）」…）を集めておく
    const t0 = Date.now();
    await page.getByRole('button', { name: /この場所で周辺環境を読み込む/ }).click();
    const seen = new Set();
    const poll = setInterval(() => {
      page
        .evaluate(() => document.querySelector('.modal-back')?.innerText ?? '')
        .then((t) => {
          for (const line of t.split('\n').map((s) => s.trim()).filter(Boolean)) {
            if (!seen.has(line)) {
              seen.add(line);
              result.progress.push(line);
            }
          }
        })
        .catch(() => {});
    }, 150);
    try {
      await page.waitForFunction(() => window.study.env.loaded && !window.study.env.loading && !document.querySelector('.modal-back'), null, { timeout: 180000 });
    } finally {
      clearInterval(poll);
    }
    result.envSeconds = sec(t0);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `test-output/plateau-e2e-${site.name}.png` });

    // window.study から集計
    const s = await page.evaluate(() => {
      const st = window.study;
      const list = st.neighbors.filter((n) => n.source !== 'manual');
      const plateau = list.filter((n) => n.source === 'plateau');
      const bySource = {};
      for (const n of list) bySource[n.source] = (bySource[n.source] ?? 0) + 1;
      const lodCounts = {};
      const footprint = { bottom: 0, hull: 0 };
      const warnings = {};
      const zminDiff = [];
      let farCount = 0;
      let measuredAbove = 0;
      for (const n of plateau) {
        const a = n.plateau;
        if (a) {
          const lod = String(a.lod ?? a.datasetLod);
          lodCounts[lod] = (lodCounts[lod] ?? 0) + 1;
          footprint[a.footprint] = (footprint[a.footprint] ?? 0) + 1;
          for (const w of a.warnings ?? []) warnings[w] = (warnings[w] ?? 0) + 1;
          if (n.baseElev != null && Number.isFinite(n.baseElev)) zminDiff.push(Math.abs(a.zmin - n.baseElev));
          if (a.measuredHeight != null && a.measuredHeight > n.height) measuredAbove++;
        }
        if (n.far) farCount++;
      }
      const sorted = zminDiff.slice().sort((x, y) => x - y);
      const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
      return {
        total: list.length,
        bySource,
        plateau: plateau.length,
        withMesh: plateau.filter((n) => !!n.mesh).length,
        withAttrs: plateau.filter((n) => !!n.plateau).length,
        far: farCount,
        measuredAboveModel: measuredAbove,
        lodCounts,
        footprint,
        warnings,
        zminBaseElev: { n: sorted.length, median: sorted.length ? (sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null, p95: q(0.95), max: sorted.length ? sorted[sorted.length - 1] : null },
        sources: st.neighborSources,
        notes: st.neighborNotes,
        datasets: st.env.plateau?.datasets ?? [],
        indexGenerated: st.env.plateau?.indexGenerated ?? null,
        terrain: st.grid?.source ?? null,
        groundElev: st.frame?.groundElev ?? null,
        sideText: document.querySelector('.side')?.innerText.replace(/\s+/g, ' ').slice(0, 800) ?? '',
      };
    });
    Object.assign(result, s);
    const ok = result.net.tiles.filter((t) => t.status >= 200 && t.status < 300);
    result.tiles = { count: result.net.tiles.length, ok: ok.length, bytes: ok.reduce((a, t) => a + (t.bytes ?? 0), 0), mb: mb(ok.reduce((a, t) => a + (t.bytes ?? 0), 0)), maxMs: Math.max(0, ...ok.map((t) => t.ms)) };
    console.log(`[${site.name}] ${result.envSeconds}s  total ${s.total} (${JSON.stringify(s.bySource)})  mesh ${s.withMesh}  lod ${JSON.stringify(s.lodCounts)}  hull ${s.footprint.hull}  tiles ${result.tiles.count} / ${result.tiles.mb} MB  |zmin−baseElev| median ${s.zminBaseElev.median?.toFixed(2) ?? '-'} (n=${s.zminBaseElev.n})`);
    for (const t of s.notes) console.log(`[${site.name}]   note: ${t}`);

    // 奥沢: サンプル 3DS → 日照シミュレーション → 日照時間マップ → 日影図まで完走する
    if (site.full) {
      const steps = {};
      if (!(await page.getByRole('button', { name: /サンプル/ }).count())) await page.getByRole('button', { name: /建物/ }).first().click();
      let t1 = Date.now();
      await page.getByRole('button', { name: /サンプル/ }).first().click();
      await page.waitForFunction(() => window.study?.model, null, { timeout: 120000 });
      steps.sampleModel = sec(t1);
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: /日照シミュレーションへ/ }).first().click();
      const confirmBtn = page.getByRole('button', { name: /確認して進む/ });
      await confirmBtn.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      if (await confirmBtn.count()) await confirmBtn.first().click();
      await page.waitForFunction(() => location.hash === '#sim', null, { timeout: 30000 });
      await page.waitForTimeout(2500);
      // 3D 画面の出典行（「周辺建物: PLATEAU（国土交通省 3D都市モデル）…」）と、シーンの周辺建物の Mesh 数・三角形数（描画負荷の記録）
      steps.attribution = await page.locator('.attribution').innerText().catch(() => '');
      steps.scene = await page.evaluate(() => {
        const g = window.shell?.scene?.groups?.neighbors;
        if (!g) return null;
        let meshes = 0;
        let tris = 0;
        g.traverse((o) => {
          if (o.isMesh) {
            meshes++;
            const pos = o.geometry?.getAttribute?.('position');
            const idx = o.geometry?.index;
            tris += idx ? idx.count / 3 : pos ? pos.count / 3 : 0;
          }
        });
        return { meshes, triangles: Math.round(tris) };
      }).catch(() => null);
      await page.screenshot({ path: `test-output/plateau-e2e-${site.name}-sim.png` });
      const noModal = () => page.waitForFunction(() => !document.querySelector('.modal-back'), null, { timeout: 600000 });
      t1 = Date.now();
      await page.getByRole('button', { name: /地面の日照時間マップ/ }).first().click();
      await page.waitForTimeout(500);
      await noModal();
      steps.groundHeatmap = sec(t1);
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `test-output/plateau-e2e-${site.name}-heat.png` });
      t1 = Date.now();
      await page.getByRole('button', { name: /GL\+1\.5/ }).first().click();
      await page.waitForSelector('.modal-body svg', { timeout: 600000 });
      steps.shadowDiagram = sec(t1);
      await page.waitForTimeout(500);
      const svg = await page.locator('.modal-body svg').evaluate((el) => el.outerHTML);
      steps.diagramSvgBytes = svg.length;
      steps.diagramMentionsPlateau = /PLATEAU/.test(svg);
      await page.screenshot({ path: `test-output/plateau-e2e-${site.name}-diagram.png` });
      await page.getByRole('button', { name: '閉じる' }).last().click();
      result.full = steps;
      console.log(`[${site.name}] full: model ${steps.sampleModel}s / heatmap ${steps.groundHeatmap}s / diagram ${steps.shadowDiagram}s  scene ${JSON.stringify(steps.scene)}  diagram PLATEAU: ${steps.diagramMentionsPlateau}`);
    }
  } catch (e) {
    result.error = e.message;
    console.log(`[${site.name}] ERROR`, e.message);
    await page.screenshot({ path: `test-output/plateau-e2e-${site.name}-error.png` }).catch(() => {});
  }
  await page.close();
  return result;
}

/** 受け入れ条件（§9）の判定。戻り値は不一致の文 */
function judge(r) {
  const bad = [];
  const check = (cond, msg) => {
    if (!cond) bad.push(msg);
  };
  check(!r.error, `実行エラー: ${r.error}`);
  check(r.pageErrors.length === 0, `pageerror ${r.pageErrors.length} 件`);
  if (r.error) return bad;
  const notes = (r.notes ?? []).join(' ');
  switch (r.name) {
    case 'okusawa':
      check(/世田谷区・2025年度・LOD2/.test(notes), `notes に「世田谷区・2025年度・LOD2」が無い: ${notes}`);
      check(r.plateau > 200, `plateau ${r.plateau} ≤ 200`);
      check(r.withMesh === r.plateau, `mesh ${r.withMesh} ≠ plateau ${r.plateau}`);
      check(r.tiles.count <= 6, `建物タイル ${r.tiles.count} 枚 > 6`);
      check(r.tiles.mb < 25, `建物タイル ${r.tiles.mb} MB ≥ 25`);
      check(r.zminBaseElev.median != null && r.zminBaseElev.median < 0.5, `|zmin − baseElev| 中央値 ${r.zminBaseElev.median} ≥ 0.5 m`);
      check(r.envSeconds < 60, `所要 ${r.envSeconds} s ≥ 60`);
      check(!!r.full?.groundHeatmap && !!r.full?.shadowDiagram, '日照時間マップ・日影図まで完走していない');
      check(!!r.full?.diagramMentionsPlateau, '日影図の脚注に PLATEAU が無い');
      check(/周辺建物: PLATEAU/.test(r.full?.attribution ?? ''), `3D 画面の出典行に PLATEAU が無い: ${r.full?.attribution}`);
      break;
    case 'higashi':
      check(r.tiles.count === 2, `葉 ${r.tiles.count} 枚 ≠ 2`);
      check(r.plateau > 100, `plateau ${r.plateau} ≤ 100`);
      check(r.withMesh === r.plateau, `mesh ${r.withMesh} ≠ plateau ${r.plateau}`);
      break;
    case 'moriyama':
      check(/LOD1/.test(notes), `notes に LOD1 が無い: ${notes}`);
      check(r.plateau > 0, 'plateau 0 棟');
      break;
    case 'border':
      check(r.datasets.length === 2, `datasets ${r.datasets.length} 件 ≠ 2`);
      check(/守山区/.test(notes) && /東区/.test(notes), `notes に守山区・東区の両方が無い: ${notes}`);
      break;
    case 'kawagoe':
    case 'nagano':
      check(/未整備/.test(notes), `notes に「未整備」が無い: ${notes}`);
      check(r.sources.length === 1 && r.sources[0] === 'gsi', `出典が国土地理院のみでない: ${JSON.stringify(r.sources)}`);
      check((r.plateau ?? 0) === 0 && r.tiles.count === 0, `未整備なのに plateau ${r.plateau} 棟・タイル ${r.tiles.count} 枚`);
      break;
  }
  return bad;
}

const results = [];
for (const site of SITES) {
  if (only && !only.has(site.name)) continue;
  const r = await runSite(site);
  r.mismatches = judge(r);
  for (const m of r.mismatches) console.log(`[${site.name}] MISMATCH: ${m}`);
  results.push(r);
}
await browser.close();

const summary = {
  generated: new Date().toISOString(),
  base,
  sites: results.map((r) => ({
    name: r.name,
    label: r.label,
    ok: r.mismatches.length === 0 && r.pageErrors.length === 0,
    seconds: r.envSeconds ?? null,
    tiles: r.tiles ?? null,
    total: r.total ?? null,
    bySource: r.bySource ?? null,
    plateau: r.plateau ?? null,
    withMesh: r.withMesh ?? null,
    lodCounts: r.lodCounts ?? null,
    hull: r.footprint?.hull ?? null,
    zminBaseElevMedian: r.zminBaseElev?.median ?? null,
    datasets: (r.datasets ?? []).map((d) => d.label),
    mismatches: r.mismatches,
    pageErrors: r.pageErrors.length,
  })),
  details: results,
};
writeFileSync('test-output/plateau-e2e.json', JSON.stringify(summary, null, 1));
const fails = results.reduce((a, r) => a + r.mismatches.length + r.pageErrors.length, 0);
console.log(`\n${fails ? `FAILURES: ${fails}` : 'ALL OK'}  → test-output/plateau-e2e.json`);
process.exit(fails ? 1 : 0);
