// PLATEAU データカタログ（国土交通省 PLATEAU VIEW の plateau-datasets, 約 9 MB）から、建築物モデル（bldg, 3D Tiles）の
// 市区町村コード → データセット（LOD・テクスチャ・年・tileset.json の URL）の小さな索引を作って public/plateau-index.json に書く。
//   node scripts/plateau-index.mjs            … カタログを取得して作る
//   node scripts/plateau-index.mjs --from catalog.json … 取得済みのカタログ JSON から作る
//   node scripts/plateau-index.mjs --no-region        … region の取得（448 回の -latest 取得）を省く
// 索引の形（src/sun/plateau/catalog.ts が読む）:
//   { generated, source, urlPrefix, areas: { [muniCd]: { pref, city, ward, year, sets: [{ lod, tex, url, size }], region? } } }
//   url は urlPrefix を除いた残り。sets は LOD の大きい順・同じ LOD ではテクスチャ無しを先に（日照計算にはテクスチャ無しで十分・小さい）。
//   muniCd は国土地理院の逆ジオコーダ（LonLatToAddress）が返す 5 桁の市区町村コードと同じ（政令市は区のコード、東京 23 区は区のコード）。
//   region は sets[0] の -latest ラッパー（api.plateauview.mlit.go.jp/datacatalog/3dtiles/{muniCd}-bldg-lod{n}-{notexture|texture}-latest/tileset.json）
//   の root.boundingVolume.region（ラジアン）を度に直した [west, south, east, north]（小数 5 桁 ≈ 1 m）。逆ジオコーダ（国土地理院）が
//   不通のとき、および逆ジオコーダのコードが索引に 1 件も無いとき（市区町村コードの改編。浜松市 2024: 逆ジオコーダ 22138 ↔ 索引 22131〜22137）に
//   catalog.ts の muniCodesByRegion が市区を引く予備経路に使う。
//   -latest ラッパーに children が無い市区（データセットが -latest から外れた。浜松市の旧 7 区）は、索引の tileset.json（取れるなら）の
//   root.boundingVolume.region を同じ形で region にする（こちらは配信ルートがハッシュ付きで不変）。どちらも取れない市区は region 無しのまま続ける。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CATALOG_URL = 'https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets';
const URL_PREFIX = 'https://assets.cms.plateau.reearth.io/assets/';
const LATEST_URL = (muniCd, lod, tex) => `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/${muniCd}-bldg-lod${lod}-${tex ? 'texture' : 'notexture'}-latest/tileset.json`;
/** -latest ラッパーの同時取得数 */
const REGION_CONCURRENCY = 8;
/** 1 回の取得の上限時間 [ms]（API は no-cache で 0.5 KB。詰まったら 1 回だけやり直す） */
const REGION_TIMEOUT_MS = 15000;
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

/** root.boundingVolume.region（ラジアン [west, south, east, north, minH, maxH]）を度の [west, south, east, north] に。壊れていれば null */
function regionOfRoot(root) {
  const r = root?.boundingVolume?.region;
  if (!Array.isArray(r) || r.length < 4 || r.slice(0, 4).some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
  const deg = (rad) => Math.round((rad * 180) / Math.PI * 1e5) / 1e5;
  const box = [deg(r[0]), deg(r[1]), deg(r[2]), deg(r[3])];
  // 日本の範囲外・西東／南北が逆のものは壊れているとみなす
  if (box[0] >= box[2] || box[1] >= box[3] || box[0] < 122 || box[2] > 154 || box[1] < 20 || box[3] > 46) return null;
  return box;
}

/**
 * -latest ラッパーの region。children 無し（データセットが -latest から外れた）のラッパーは root.region が日本全体なので
 * region として使わない（{ region: null, noChildren: true }）
 */
function regionOfWrapper(json) {
  const root = json?.root;
  if (!root || !Array.isArray(root.children) || root.children.length === 0) return { region: null, noChildren: true };
  return { region: regionOfRoot(root), noChildren: false };
}

/** 索引の tileset.json（本体）の root.region。children の有無は問わない（本体の root.region はその市区の範囲） */
function regionOfTileset(json) {
  return regionOfRoot(json?.root);
}

/** JSON を取る。失敗（非 2xx・JSON でない・タイムアウト）は 1 回やり直し、それでも駄目なら throw */
async function fetchJsonRetry(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REGION_TIMEOUT_MS), cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * 1 市区の region を取る: -latest ラッパー → children 無しなら索引の tileset.json（本体）の root.region。
 * 返り値 { region, via: 'latest' | 'tileset' | null, error }。どちらも取れなければ region null（error に理由）
 */
async function fetchRegion(muniCd, area) {
  const set = area.sets[0];
  let viaLatest;
  try {
    viaLatest = regionOfWrapper(await fetchJsonRetry(LATEST_URL(muniCd, set.lod, set.tex)));
  } catch (e) {
    return { region: null, via: null, error: `-latest: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (viaLatest.region) return { region: viaLatest.region, via: 'latest', error: null };
  if (!viaLatest.noChildren) return { region: null, via: null, error: '-latest: root.region が不正' };
  // -latest に無いデータセット（浜松市の旧 7 区など）: 索引の tileset.json が今も取れるならその root.region
  try {
    const region = regionOfTileset(await fetchJsonRetry(URL_PREFIX + set.url));
    return region ? { region, via: 'tileset', error: null } : { region: null, via: null, error: 'tileset.json: root.region が不正' };
  } catch (e) {
    return { region: null, via: null, error: `-latest children 無し・tileset.json: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 全市区の region を並列 REGION_CONCURRENCY で取り area.region に入れる（失敗は region 無しで続行・進捗を表示） */
async function addRegions(areasByCode) {
  const codes = Object.keys(areasByCode);
  let next = 0;
  let done = 0;
  let ok = 0;
  let viaTileset = 0;
  const failed = [];
  const tick = () => {
    done++;
    if (done % 25 === 0 || done === codes.length) process.stderr.write(`\r  region ${done}/${codes.length}（取得 ${ok}・うち tileset.json から ${viaTileset}・失敗 ${failed.length}）`);
  };
  await Promise.all(
    Array.from({ length: Math.min(REGION_CONCURRENCY, codes.length) }, async () => {
      while (next < codes.length) {
        const cd = codes[next++];
        const { region, via, error } = await fetchRegion(cd, areasByCode[cd]);
        if (region) {
          areasByCode[cd].region = region;
          ok++;
          if (via === 'tileset') {
            viaTileset++;
            console.log(`  ${cd}（${areasByCode[cd].pref}${areasByCode[cd].city}${areasByCode[cd].ward ?? ''}）: -latest に無いので tileset.json の root.region を使用 [${region.join(', ')}]`);
          }
        } else failed.push(`${cd}: ${error}`);
        tick();
      }
    }),
  );
  process.stderr.write('\n');
  for (const f of failed) console.warn(`  region 取得失敗（region 無しで続行）: ${f}`);
  return ok;
}

let regionCount = 0;
if (!process.argv.includes('--no-region')) {
  console.log(`-latest ラッパーから ${Object.keys(sorted).length} 市区の region を取得します（並列 ${REGION_CONCURRENCY}）`);
  regionCount = await addRegions(sorted);
}
const index = { generated: new Date().toISOString().slice(0, 10), source: CATALOG_URL, urlPrefix: URL_PREFIX, areas: sorted };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(index));
const n = Object.keys(sorted).length;
const lod2 = Object.values(sorted).filter((a) => a.sets.some((s) => s.lod >= 2)).length;
console.log(`plateau-index.json: ${n} 市区（LOD2 以上あり ${lod2}・region あり ${regionCount}）・${bldg.length} データセット（除外 ${skipped}）・${(JSON.stringify(index).length / 1024).toFixed(0)} KB`);
