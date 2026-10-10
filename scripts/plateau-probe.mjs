/**
 * PLATEAU 周辺建物の取得を実ネットで 1 回試す簡易プローブ（Node・ブラウザ不要）。
 *
 *   node scripts/plateau-probe.mjs [lat] [lon] [radiusM]      既定: 世田谷区奥沢 35.6019 139.6736 300
 *
 * fetchPlateauBuildings（src/sun/plateau/fetch.ts）を Vite の ssrLoadModule で読み込み（TypeScript をそのまま実行する。依存は増やさない）、
 * Draco は tests/helpers/nodeDraco.ts（three の draco_wasm_wrapper.js）を注入する。表示:
 *  - 状態・データセット（市区・年度・LOD）・葉の枚数・転送 MB・所要時間
 *  - 棟数・LOD 分布・足元の種類（bottom / hull）・warnings の内訳・_xmin.._ymax との照合誤差（compareWithRecord の最大）
 *  - |_zmin − DEM| の目安: 国土地理院 標高 API（getelevation.php。DEM5A/5B/10B）で先頭数棟の anchor の標高を引き、_zmin との差を表示
 *    （spec §0: 世田谷で中央値 +0.02 m・p95 ±0.4 m）。API は 1 点ずつなので 8 棟だけ照合する
 * 索引は public/plateau-index.json（ローカルのファイルを file: 相当で読む。ネットは PLATEAU・国土地理院のみ）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [latArg, lonArg, radiusArg] = process.argv.slice(2);
const lat = Number(latArg ?? 35.6019);
const lon = Number(lonArg ?? 139.6736);
const radiusM = Number(radiusArg ?? 300);
if (![lat, lon, radiusM].every(Number.isFinite)) {
  console.error('使い方: node scripts/plateau-probe.mjs [lat] [lon] [radiusM]');
  process.exit(2);
}

const INDEX_URL = 'https://plateau-probe.local/plateau-index.json';
const indexJson = readFileSync(path.join(root, 'public/plateau-index.json'), 'utf8');
/** 索引だけローカルから返し、他は本物の fetch */
const fetchImpl = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url === INDEX_URL) return Promise.resolve(new Response(indexJson, { headers: { 'content-type': 'application/json' } }));
  return fetch(input, init);
};

const DEM_URL = (la, lo) => `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lo}&lat=${la}&outtype=JSON`;
async function demElevation(la, lo) {
  const res = await fetch(DEM_URL(la, lo));
  if (!res.ok) return null;
  const j = await res.json();
  const v = Number(j.elevation);
  return { elev: Number.isFinite(v) ? v : null, source: j.hsrc ?? '' };
}

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
};
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { fetchPlateauBuildings } = await server.ssrLoadModule('/src/sun/plateau/fetch.ts');
  const { compareWithRecord, readBuildingRecords } = await server.ssrLoadModule('/src/sun/plateau/buildings.ts');
  const { parseB3dm } = await server.ssrLoadModule('/src/sun/plateau/b3dm.ts');
  const { fetchCached } = await server.ssrLoadModule('/src/sun/plateau/fetch.ts');
  const { nodeDracoDecoder } = await server.ssrLoadModule('/tests/helpers/nodeDraco.ts');
  const draco = await nodeDracoDecoder();

  console.log(`PLATEAU プローブ: lat ${lat} lon ${lon} 半径 ${radiusM} m`);
  const t0 = performance.now();
  let lastStage = '';
  const r = await fetchPlateauBuildings(lat, lon, radiusM, {
    fetchImpl,
    draco,
    indexUrl: INDEX_URL,
    onProgress: (p) => {
      if (p.stage !== lastStage) {
        lastStage = p.stage;
        console.log(`  [${p.stage}] ${p.message}`);
      }
    },
  });
  const ms = performance.now() - t0;
  console.log(`状態: ${r.status}  所要 ${(ms / 1000).toFixed(1)} s`);
  if (r.status !== 'covered') {
    console.log(JSON.stringify(r, null, 1));
    process.exitCode = 1;
  } else {
    const bytes = r.tiles.reduce((s, t) => s + t.bytes, 0);
    console.log(`データセット: ${r.datasets.map((d) => d.label).join(' / ')}`);
    console.log(`葉タイル ${r.tiles.length} 枚・${(bytes / 1048576).toFixed(1)} MB・失敗 ${r.failedTiles}・truncated ${r.truncated}・索引に無い市区 ${r.missingMuniCds.join(',') || '-'}`);
    for (const t of r.tiles) console.log(`  ${t.url.replace(/.*\//, '')}: ${(t.bytes / 1048576).toFixed(2)} MB・${t.buildings} 棟・${t.ms.toFixed(0)} ms`);
    console.log(`棟数 ${r.buildings.length}・LOD 分布 ${JSON.stringify(r.lodCounts)}`);
    const kinds = { bottom: 0, hull: 0 };
    const warns = {};
    let roofy = 0;
    let holes = 0;
    for (const b of r.buildings) {
      kinds[b.attrs.footprint]++;
      for (const w of b.attrs.warnings ?? []) warns[w] = (warns[w] ?? 0) + 1;
      if (b.mesh.roofTriangles > 0) roofy++;
      if (b.holes.length) holes++;
    }
    console.log(`足元 bottom ${kinds.bottom}・hull ${kinds.hull}・穴あり ${holes}・屋根三角形あり ${roofy}・warnings ${JSON.stringify(warns)}`);
    const heights = r.buildings.map((b) => b.height);
    const mh = r.buildings.filter((b) => b.attrs.measuredHeight != null).map((b) => b.attrs.measuredHeight - b.height);
    console.log(`高さ zmax−zmin 中央値 ${fmt(median(heights), 1)} m（p95 ${fmt(pct(heights, 0.95), 1)}）・measuredHeight − 形状高さ 中央値 ${fmt(median(mh))} m（p95 ${fmt(pct(mh, 0.95))}）`);

    // 照合誤差: 各タイルの batchTable と比べる（メモリ LRU から取るので通信なし）
    const errs = [];
    for (const t of r.tiles) {
      const b3dm = parseB3dm(await fetchCached(t.url, { fetchImpl }));
      const recs = readBuildingRecords(b3dm.batchTable);
      for (const b of r.buildings) {
        const rec = recs[b.batchId];
        if (!rec || rec.gmlId !== b.gmlId) continue;
        const d = compareWithRecord(b, rec);
        errs.push(d);
      }
    }
    console.log(
      `_xmin.._ymax 照合 extentErr 最大 ${fmt(Math.max(...errs.map((e) => e.extentErrM)), 4)} m・zmaxErr 中央値 ${fmt(median(errs.map((e) => e.zmaxErrM)), 3)} m（最大 ${fmt(Math.max(...errs.map((e) => e.zmaxErrM)), 3)}）（${errs.length} 棟）`,
    );

    // DEM との照合（先頭 8 棟。ピンに近い順）
    const sample = [...r.buildings]
      .sort((a, b) => Math.hypot(a.attrs.anchor.lat - lat, a.attrs.anchor.lon - lon) - Math.hypot(b.attrs.anchor.lat - lat, b.attrs.anchor.lon - lon))
      .slice(0, 8);
    const diffs = [];
    console.log('|_zmin − DEM|（国土地理院 標高 API。anchor の 1 点）:');
    for (const b of sample) {
      const dem = await demElevation(b.attrs.anchor.lat, b.attrs.anchor.lon);
      if (!dem || dem.elev == null) {
        console.log(`  ${b.gmlId}: DEM 取得不可`);
        continue;
      }
      const d = b.attrs.zmin - dem.elev;
      diffs.push(d);
      console.log(`  ${b.gmlId}: _zmin ${b.attrs.zmin.toFixed(2)} / DEM ${dem.elev.toFixed(2)}（${dem.source}）/ 差 ${d >= 0 ? '+' : ''}${d.toFixed(2)} m・高さ ${b.height.toFixed(1)} m・${b.attrs.footprint}${b.attrs.lod ? `・LOD${b.attrs.lod}` : ''}`);
    }
    if (diffs.length) console.log(`  → 中央値 ${fmt(median(diffs))} m・|差| 最大 ${fmt(Math.max(...diffs.map(Math.abs)))} m（${diffs.length} 棟）`);
  }
} finally {
  await server.close();
}
