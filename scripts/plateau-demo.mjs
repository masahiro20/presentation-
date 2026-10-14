// 同梱デモ public/demo/okusawa.json を PLATEAU 3D Tiles 版で作り直す（dev サーバー上の実アプリから書き出す）
//   世田谷区奥沢 35.601929,139.67363 を「座標で指定」→「この場所で周辺環境を読み込む」（PLATEAU 2025・世田谷区・LOD2 の実形状）
//   → サンプル住宅（3DS）→ serializeProject() の結果を書く。
//   既存の okusawa.json があれば名前・住所・敷地・配置（placement）・3D データ・手動の隣家・測定点・上書きを引き継ぎ、
//   周辺環境（env: 地形・航空写真・周辺建物・出典注記・env.plateau）だけを新しい取得結果で置き換える。
//   周辺建物の上書き（高さの修正・隠した建物）は gml_id が変わっても足元の形で新しい id に引き継ぐ（rekeyOverridesByFootprint）。
// 使い方: 別端末で `npx vite --port 5195 --strictPort` を起動してから
//   node scripts/plateau-demo.mjs [baseUrl] [出力先]   （既定: http://localhost:5195, public/demo/okusawa.json）
//   終了コード = pageerror の数 + 書き出した JSON の検査（PLATEAU 建物・meshQ・注記・サイズ）の不一致の数
import { chromium } from 'playwright-core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5195';
const outPath = process.argv[3] ?? 'public/demo/okusawa.json';
const SITE = { lat: 35.601929, lon: 139.67363, address: '東京都世田谷区奥沢三丁目' };
const NAME = 'デモ: 世田谷区奥沢 サンプル住宅';
const CUSTOMER = 'デモ';
/** 旧デモ（3.16 MB）に対して +1 MB 以内に収める */
const SIZE_LIMIT = 3158382 + 1024 * 1024;

const prev = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null;
if (prev) console.log(`既存のデモを読みました: ${outPath}（${(readFileSync(outPath).length / 1048576).toFixed(2)} MB・周辺建物 ${prev.env?.neighbors?.length ?? 0} 棟）`);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--ignore-certificate-errors'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => {
  console.log('[pageerror]', e.message);
  errors.push(e.message);
});
page.on('console', (m) => {
  if (m.type() === 'error' && !/404|CERT|ERR_/.test(m.text())) console.log('[console]', m.text());
});
const sec = (t0) => ((Date.now() - t0) / 1000).toFixed(1);

await page.goto(`${base}/sun.html`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });

// 座標で指定 → ピンを置く
await page.locator('input.coord-lat').fill(String(SITE.lat));
await page.locator('input.coord-lon').fill(String(SITE.lon));
await page.getByRole('button', { name: 'この座標にピンを置く' }).click();
await page.waitForFunction(() => !!window.study?.frame, null, { timeout: 30000 });
await page.waitForTimeout(1200);

// 周辺環境（地形・航空写真・PLATEAU の周辺建物・地平線）
let t0 = Date.now();
await page.getByRole('button', { name: /この場所で周辺環境を読み込む/ }).click();
await page.waitForFunction(() => window.study.env.loaded && !window.study.env.loading && !document.querySelector('.modal-back'), null, { timeout: 300000 });
console.log(`周辺環境: ${sec(t0)}s`);
await page.waitForTimeout(1000);
const nb = await page.evaluate(() => ({
  total: window.study.neighbors.length,
  plateau: window.study.neighbors.filter((n) => n.source === 'plateau').length,
  mesh: window.study.neighbors.filter((n) => n.source === 'plateau' && n.mesh).length,
  sources: window.study.neighborSources,
  notes: window.study.neighborNotes,
  datasets: window.study.env.plateau?.datasets?.map((d) => d.label) ?? [],
}));
console.log('[neighbors]', JSON.stringify(nb, null, 1));

// サンプル住宅（3DS）
if (!(await page.getByRole('button', { name: /サンプル/ }).count())) await page.getByRole('button', { name: /建物/ }).first().click();
t0 = Date.now();
await page.getByRole('button', { name: /サンプル/ }).first().click();
await page.waitForFunction(() => window.study?.model, null, { timeout: 120000 });
console.log(`サンプル住宅: ${sec(t0)}s`);
await page.waitForTimeout(1500);

// 名前・住所を整え、旧デモの上書き（高さの修正・隠した建物）を足元の形で新しい id に引き継いでから書き出す
const json = await page.evaluate(
  async ({ name, customer, address, prevNeighbors, prevOverrides }) => {
    const st = window.study;
    st.name = name;
    st.customer = customer;
    if (st.frame) st.frame.address = address;
    const pn = await import('/src/sunstudy/plateauNeighbors.ts');
    const prevAuto = (prevNeighbors ?? []).filter((n) => n && Array.isArray(n.ring)).map((n) => ({ id: n.id, ring: n.ring }));
    st.neighborOverrides = pn.rekeyOverridesByFootprint(prevAuto, st.neighbors, prevOverrides ?? {});
    const m = await import('/src/sunstudy/project.ts');
    return JSON.stringify(m.serializeProject());
  },
  { name: NAME, customer: CUSTOMER, address: SITE.address, prevNeighbors: prev?.env?.neighbors ?? [], prevOverrides: prev?.neighborOverrides ?? {} },
);
await browser.close();

const fresh = JSON.parse(json);
let out = fresh;
if (prev) {
  // 周辺環境（env・frame.groundElev・上書きの再キー）だけを新しい取得結果にし、残りは旧デモを引き継ぐ
  const sameModel = prev.model && fresh.model && prev.model.name === fresh.model.name && prev.model.format === fresh.model.format;
  out = {
    ...fresh,
    name: prev.name ?? fresh.name,
    customer: prev.customer ?? fresh.customer,
    company: prev.company ?? fresh.company,
    frame: { ...fresh.frame, address: prev.frame?.address ?? fresh.frame.address },
    sitePolygon: prev.sitePolygon ?? fresh.sitePolygon,
    placement: prev.placement ?? fresh.placement,
    model: sameModel ? prev.model : fresh.model,
    manualNeighbors: prev.manualNeighbors ?? fresh.manualNeighbors,
    plannedEnabled: prev.plannedEnabled ?? fresh.plannedEnabled,
    points: prev.points ?? fresh.points,
    neighborOverrides: fresh.neighborOverrides,
    env: fresh.env,
  };
  if (!sameModel) console.log(`[注意] 3D データが旧デモと違います（${prev.model?.name} → ${fresh.model?.name}）。新しいものを使います`);
}

// 検査: PLATEAU の建物が実形状（meshQ）と属性付きで入り、注記がデータセットの文、サイズが上限内
const text = JSON.stringify(out);
const env = out.env ?? {};
const neighbors = env.neighbors ?? [];
const plateau = neighbors.filter((n) => n.source === 'plateau');
const withMesh = plateau.filter((n) => n.meshQ && typeof n.meshQ.posB64 === 'string');
const withAttrs = plateau.filter((n) => n.plateau && typeof n.plateau.gmlId === 'string' && /^plateau:/.test(n.id));
const mismatches = [];
if (!env.grid) mismatches.push('地形（env.grid）が無い');
if (!env.aerial) mismatches.push('航空写真（env.aerial）が無い');
if (!(plateau.length > 200)) mismatches.push(`PLATEAU の建物が少ない: ${plateau.length}`);
if (withMesh.length !== plateau.length) mismatches.push(`meshQ の無い PLATEAU 建物がある: ${plateau.length - withMesh.length}`);
if (withAttrs.length !== plateau.length) mismatches.push(`plateau 属性／id plateau:gml_id の無い建物がある: ${plateau.length - withAttrs.length}`);
if (!(env.neighborSources?.[0] === 'plateau')) mismatches.push(`neighborSources の先頭が plateau でない: ${JSON.stringify(env.neighborSources)}`);
if (!/^PLATEAU（国土交通省 3D都市モデル・東京都世田谷区・2025年度・LOD2）の実測の高さ・形状を使用（\d+ 棟/.test(env.neighborNotes?.[0] ?? '')) mismatches.push(`注記の先頭がデータセットの文でない: ${env.neighborNotes?.[0]}`);
if (!(env.plateau?.datasets?.length >= 1 && env.plateau.datasets[0].muniCd === '13112')) mismatches.push(`env.plateau のデータセットが世田谷区（13112）でない: ${JSON.stringify(env.plateau)}`);
if (!out.model) mismatches.push('3D データ（model）が無い');
if (text.length > SIZE_LIMIT) mismatches.push(`サイズが上限を超えた: ${(text.length / 1048576).toFixed(2)} MB > ${(SIZE_LIMIT / 1048576).toFixed(2)} MB`);

writeFileSync(outPath, text);
console.log(`書き出し: ${outPath}  ${(text.length / 1048576).toFixed(2)} MB  周辺建物 ${neighbors.length} 棟（PLATEAU ${plateau.length}・meshQ ${withMesh.length}）  上書き ${Object.keys(out.neighborOverrides ?? {}).length} 件`);
for (const n of env.neighborNotes ?? []) console.log('  note:', n);
for (const m of mismatches) console.log('[MISMATCH]', m);
console.log('page errors:', errors.length, ' mismatches:', mismatches.length);
process.exit(errors.length + mismatches.length ? 1 : 0);
