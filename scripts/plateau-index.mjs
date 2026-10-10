// PLATEAU データカタログ（国土交通省 PLATEAU VIEW の plateau-datasets, 約 9 MB）から、建築物モデル（bldg, 3D Tiles）の
// 市区町村コード → データセット（LOD・テクスチャ・年・tileset.json の URL）の小さな索引を作って public/plateau-index.json に書く。
//   node scripts/plateau-index.mjs            … カタログを取得して作る
//   node scripts/plateau-index.mjs --from catalog.json … 取得済みのカタログ JSON から作る
// 索引の形（src/sun/plateau3d.ts が読む）:
//   { generated, source, urlPrefix, areas: { [muniCd]: { pref, city, ward, year, sets: [{ lod, tex, url, size }] } } }
//   url は urlPrefix を除いた残り。sets は LOD の大きい順・同じ LOD ではテクスチャ無しを先に（日照計算にはテクスチャ無しで十分・小さい）。
//   muniCd は国土地理院の逆ジオコーダ（LonLatToAddress）が返す 5 桁の市区町村コードと同じ（政令市は区のコード、東京 23 区は区のコード）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CATALOG_URL = 'https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets';
const URL_PREFIX = 'https://assets.cms.plateau.reearth.io/assets/';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public/plateau-index.json');

const fromIdx = process.argv.indexOf('--from');
let catalog;
if (fromIdx > 0) {
  catalog = JSON.parse(readFileSync(resolve(process.argv[fromIdx + 1]), 'utf8'));
} else {
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  catalog = await res.json();
}
const bldg = catalog.datasets.filter((d) => d.type_en === 'bldg' && d.format === '3D Tiles' && typeof d.url === 'string');
const areas = {};
let skipped = 0;
for (const d of bldg) {
  const code = d.ward_code ?? d.city_code;
  if (!/^\d{5}$/.test(code ?? '') || !d.url.startsWith(URL_PREFIX)) {
    skipped++;
    continue;
  }
  const lod = Number(d.lod);
  if (!Number.isFinite(lod)) {
    skipped++;
    continue;
  }
  const a = (areas[code] ??= { pref: d.pref, city: d.city, ward: d.ward ?? null, year: d.year, sets: [] });
  // 同じ市区に別の年があれば新しい方だけ残す（2026-10 時点では無い）
  if (d.year > a.year) {
    a.year = d.year;
    a.sets = [];
  } else if (d.year < a.year) continue;
  a.sets.push({ lod, tex: !!d.texture, url: d.url.slice(URL_PREFIX.length), size: d.file_size ?? null });
}
for (const a of Object.values(areas)) a.sets.sort((x, y) => y.lod - x.lod || Number(x.tex) - Number(y.tex));
const sorted = Object.fromEntries(Object.keys(areas).sort().map((k) => [k, areas[k]]));
const index = { generated: new Date().toISOString().slice(0, 10), source: CATALOG_URL, urlPrefix: URL_PREFIX, areas: sorted };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(index));
const n = Object.keys(sorted).length;
const lod2 = Object.values(sorted).filter((a) => a.sets.some((s) => s.lod >= 2)).length;
console.log(`plateau-index.json: ${n} 市区（LOD2 以上あり ${lod2}）・${bldg.length} データセット（除外 ${skipped}）・${(JSON.stringify(index).length / 1024).toFixed(0)} KB`);
