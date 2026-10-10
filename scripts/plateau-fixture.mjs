// PLATEAU 3D Tiles（国土交通省 3D都市モデル）のテスト用データを実ネットから取得して tests/fixtures/plateau/ に保存する。
//   node scripts/plateau-fixture.mjs
//     … 仕様 §9 の一式（b3dm 3 枚・tileset 2 本・-latest ラッパー 2 種・索引の抜粋・逆ジオコーダ応答 2 件）をまとめて取得する
//   node scripts/plateau-fixture.mjs <muniCd> <lod1|lod2|lod2nt|LOD 番号> <content uri> [out]
//     … 1 枚だけ。索引（public/plateau-index.json）→ tileset.json → content の順にたどり、tileset.json と content を保存する
//        例: node scripts/plateau-fixture.mjs 23113 lod1 data/data0.b3dm
//           → tests/fixtures/plateau/23113_lod1_tileset.json と 23113_lod1_data0.b3dm
// 取得したファイルの出典 URL と利用規約は tests/fixtures/plateau/README.md に書く（取得後に表示する行を貼る）。
// fixtures は合計 400 KB 以内に収める（テストの速さと git の重さのため）。
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(root, 'tests/fixtures/plateau');
const INDEX_PATH = resolve(root, 'public/plateau-index.json');
const LATEST_URL = (muniCd, lod, tex) => `https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/${muniCd}-bldg-lod${lod}-${tex ? 'texture' : 'notexture'}-latest/tileset.json`;
const GEOCODER_URL = (lat, lon) => `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lon}`;

/** 仕様 §9 の一式（引数なしのとき） */
const DEFAULT_SET = {
  tiles: [
    { muniCd: '23113', lod: 'lod1', uri: 'data/data0.b3dm', note: '守山区 LOD1 の葉（6 棟・底面あり）… 正例' },
    { muniCd: '23102', lod: 'lod2nt', uri: 'data/data1.b3dm', note: '東区 LOD2 深さ 2 の内部ノード（18 棟・底面なし）… noBottom の負例' },
    { muniCd: '23102', lod: 'lod2nt', uri: 'data/data55.b3dm', note: '東区 LOD2 の root（20 棟・簡略形状）… baseMismatch の負例' },
  ],
  latest: [
    { file: 'latest_13112_lod2nt.json', muniCd: '13112', lod: 2, tex: false, note: '世田谷区 LOD2 テクスチャ無し（children[0].content.uri に実 URL）' },
    { file: 'latest_missing.json', muniCd: '11201', lod: 2, tex: false, note: '川越市（PLATEAU 未整備）… children 無しの応答' },
  ],
  indexMini: { file: 'index.mini.json', muniCds: ['13112', '23102', '23113'] },
  geocoder: [
    { file: 'geocoder_okusawa.json', lat: 35.6019, lon: 139.6736, note: '世田谷区奥沢 → 13112' },
    { file: 'geocoder_nagoya_border.json', lat: 35.1932, lon: 136.9545, note: '名古屋の区境（守山区 23113。東区ではない）' },
  ],
};

const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

function save(file, data, url) {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = resolve(OUT_DIR, file);
  writeFileSync(path, data);
  const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  console.log(`| \`${file}\` | ${(bytes / 1024).toFixed(1)} KB | ${url} |`);
  return path;
}

/** 索引から LOD 指定（'lod1' / 'lod2' / 'lod2nt' / 数値）に合うデータセットを選ぶ */
function pickSet(muniCd, lodSpec) {
  const area = index.areas[muniCd];
  if (!area) throw new Error(`索引に ${muniCd} がありません`);
  const m = /^lod(\d)(nt)?$/.exec(String(lodSpec));
  const lod = m ? Number(m[1]) : Number(lodSpec);
  const tex = m ? (m[2] ? false : m[1] === '2' ? true : null) : null;
  if (!Number.isFinite(lod)) throw new Error(`LOD の指定が不明です: ${lodSpec}`);
  // 'lod1' はテクスチャの有無を問わない（守山区は texture 版しか無い）。'lod2' はテクスチャ有り、'lod2nt' は無し
  const set = area.sets.find((s) => s.lod === lod && (tex == null || s.tex === tex)) ?? (tex === true ? area.sets.find((s) => s.lod === lod) : undefined);
  if (!set) throw new Error(`${muniCd} に LOD ${lodSpec} のデータセットがありません（${area.sets.map((s) => `lod${s.lod}${s.tex ? '' : 'nt'}`).join(', ')}）`);
  return { area, set, tag: `lod${lod}${set.tex ? '' : 'nt'}`, tilesetUrl: index.urlPrefix + set.url };
}

/** tileset.json の中で content uri を探し、深さと葉かどうかを返す（README の説明用） */
function findContent(ts, uri) {
  const walk = (node, depth) => {
    const u = node.content?.uri ?? node.content?.url;
    if (u === uri) return { depth, leaf: !(node.children && node.children.length), children: node.children?.length ?? 0 };
    for (const c of node.children ?? []) {
      const r = walk(c, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(ts.root, 0);
}

/** b3dm のヘッダから BATCH_LENGTH を読む（取得したものの検算） */
function b3dmBatchLength(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = buf.toString('latin1', 0, 4);
  if (magic !== 'b3dm') throw new Error(`b3dm ではありません（magic ${magic}）`);
  const ftJson = dv.getUint32(12, true);
  return JSON.parse(buf.toString('utf8', 28, 28 + ftJson)).BATCH_LENGTH;
}

async function fetchTile(muniCd, lodSpec, uri, out) {
  const { set, tag, tilesetUrl } = pickSet(muniCd, lodSpec);
  const base = tilesetUrl.slice(0, tilesetUrl.lastIndexOf('/') + 1);
  const tsText = await (await fetchOk(tilesetUrl)).text();
  const ts = JSON.parse(tsText);
  const where = findContent(ts, uri);
  if (!where) console.warn(`  注意: ${uri} は tileset.json に見当たりません`);
  save(`${muniCd}_${tag}_tileset.json`, tsText, tilesetUrl);
  const contentUrl = base + uri;
  const buf = Buffer.from(await (await fetchOk(contentUrl)).arrayBuffer());
  const n = b3dmBatchLength(buf);
  const file = out ?? `${muniCd}_${tag}_${basename(uri)}`;
  save(file, buf, contentUrl);
  console.log(`    … ${n} 棟、tileset 内の深さ ${where?.depth ?? '?'}（${where ? (where.leaf ? '葉' : `内部・子 ${where.children}`) : '不明'}）、LOD${set.lod}${set.tex ? '' : ' テクスチャ無し'}`);
}

async function fetchLatest({ file, muniCd, lod, tex, note }) {
  const url = LATEST_URL(muniCd, lod, tex);
  const text = await (await fetchOk(url)).text();
  const json = JSON.parse(text);
  const real = json.root?.children?.[0]?.content?.uri ?? null;
  save(file, text, url);
  console.log(`    … ${note}: ${real ? `実 URL ${real}` : 'children 無し'}`);
}

function writeIndexMini({ file, muniCds }) {
  const areas = Object.fromEntries(muniCds.map((c) => [c, index.areas[c]]));
  for (const [c, a] of Object.entries(areas)) if (!a) throw new Error(`索引に ${c} がありません`);
  const mini = { generated: index.generated, source: index.source, urlPrefix: index.urlPrefix, areas };
  save(file, JSON.stringify(mini, null, 1), `${INDEX_PATH.slice(root.length + 1)}（${muniCds.join('・')} だけ抜粋）`);
}

async function fetchGeocoder({ file, lat, lon, note }) {
  const url = GEOCODER_URL(lat, lon);
  const text = await (await fetchOk(url)).text();
  save(file, text, url);
  console.log(`    … ${note}: ${text.trim()}`);
}

function reportTotal() {
  let total = 0;
  for (const f of readdirSync(OUT_DIR)) total += statSync(resolve(OUT_DIR, f)).size;
  console.log(`\n${OUT_DIR.slice(root.length + 1)}: 合計 ${(total / 1024).toFixed(0)} KB${total > 400 * 1024 ? '（400 KB を超えています）' : ''}`);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('| ファイル | サイズ | 取得元 URL |\n| --- | --- | --- |');
  for (const t of DEFAULT_SET.tiles) await fetchTile(t.muniCd, t.lod, t.uri);
  for (const l of DEFAULT_SET.latest) await fetchLatest(l);
  writeIndexMini(DEFAULT_SET.indexMini);
  for (const g of DEFAULT_SET.geocoder) await fetchGeocoder(g);
  reportTotal();
} else if (args.length >= 3) {
  console.log('| ファイル | サイズ | 取得元 URL |\n| --- | --- | --- |');
  await fetchTile(args[0], args[1], args[2], args[3]);
  reportTotal();
} else {
  console.error('使い方: node scripts/plateau-fixture.mjs [<muniCd> <lod1|lod2|lod2nt|LOD 番号> <content uri> [out]]');
  process.exit(2);
}
