/**
 * fetchPlateauBuildings（src/sun/plateau/fetch.ts）の全経路を fetchImpl のスタブでテストする（ネットワークは使わない）。
 * URL の部分一致で応答を切り替える: LonLatToAddress → muniCd、plateau-index.json → index.mini、-latest → ラッパー、
 * tileset.json → fixture（23113 / 23102）、.b3dm → 23113 data0 の fixture。
 *  - covered（lodCounts・datasets・tiles）、2 回目は fetch 0 回（メモリ LRU ＋ 索引のメモ）
 *  - 索引に無い → none/outside、-latest children 無し → none、-latest 失敗 → 索引 URL に退避、tileset 500 → error/tileset
 *  - 1 枚 500 → covered かつ failedTiles 1、maxTiles で truncated、AbortSignal は reason を throw、進捗の段階順
 *  - 区境 2 コード → datasets 2 件、gml_id が重複する 2 葉でも buildings は 1 棟ずつ
 *  - fetchCached: Cache API 無し（Node）でもメモリ LRU で動き、失敗は残さない
 *  - 第 1 弾レビューの指摘: 葉の選択は半径そのもの（region 距離 > radiusM の葉は fetch しない）、200 でも中身を検証（.b3dm の magic・.json）、
 *    共有 Promise の中止は待っている全員が中止したときだけ、clearPlateauCaches は進行中の put を待つ、maxBytes は Content-Length の累計で
 *    concurrency に依らない・totalBytes が埋まる、デコーダの用意はタイル取得と並列、読めないタイルはキャッシュから捨てる（直れば covered）
 * Draco は tests/helpers/nodeDraco.ts を opts.draco に注入する（既定の DRACOLoader は Node では preload できない）。
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { metersPerDegree } from '../src/sun/geo';
import { degBoxAround } from '../src/sun/geodesy';
import { PLATEAU_LATEST_URL, type PlateauIndex } from '../src/sun/plateau/catalog';
import { clearPlateauCaches, fetchCached, fetchPlateauBuildings, plateauDatasetLabel, type PlateauFetchResult } from '../src/sun/plateau/fetch';
import { parseTileset, selectContentTiles } from '../src/sun/plateau/tileset';
import type { DracoDecoderLike, PlateauProgress, PlateauStage } from '../src/sun/plateau/types';
import { nodeDracoDecoder } from './helpers/nodeDraco';

const fixtureText = (name: string): string => readFileSync(new URL(`./fixtures/plateau/${name}`, import.meta.url), 'utf8');
const fixtureBuf = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`./fixtures/plateau/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const INDEX_URL = 'https://example.test/plateau-index.json';
const miniIndex = (): PlateauIndex => JSON.parse(fixtureText('index.mini.json')) as PlateauIndex;
const tilesetUrlOf = (index: PlateauIndex, muniCd: string, lod: number, tex: boolean) => index.urlPrefix + index.areas[muniCd].sets.find((s) => s.lod === lod && s.tex === tex)!.url;

/** 守山区 data0 の葉だけが選ばれ、6 棟の矩形がすべて半径内に入るピン（region の中心と棟の間。sel3 で探索） */
const PIN = { lat: 35.2565, lon: 137.0545, radius: 250 };
/** 23113 tileset の data0 の region（ラジアン・m。手作り tileset 用） */
const DATA0_REGION = [2.3919985615429846, 0.6153138020480537, 2.392141552343307, 0.6153888805425165, 219.1227240619086, 249.95485120608805];
const DATA0_BYTES = fixtureBuf('23113_lod1_data0.b3dm').byteLength;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bin = (buf: ArrayBuffer, status = 200) => new Response(buf, { status, headers: { 'content-type': 'application/octet-stream' } });
const geocode = (muniCd: string | null) => json({ results: muniCd ? { muniCd, lv01Nm: '町' } : null });

/** -latest ラッパー（children[0].content.uri に実 tileset.json の URL） */
const latestWrapper = (uri: string) => ({ asset: { version: '1.0' }, geometricError: 50000, root: { boundingVolume: { region: [2.39, 0.61, 2.4, 0.62, -50, 500] }, geometricError: 50000, refine: 'ADD', children: [{ boundingVolume: { region: [2.39, 0.61, 2.4, 0.62, -50, 500] }, geometricError: 500, content: { uri } }] } });

/** root（REPLACE）の下に同じ region の葉を並べた手作り tileset */
const leafTileset = (uris: string[], region = DATA0_REGION) => ({
  asset: { version: '1.0' },
  geometricError: 100,
  root: { boundingVolume: { region }, geometricError: 100, refine: 'REPLACE', children: uris.map((uri) => ({ boundingVolume: { region }, geometricError: 0, content: { uri } })) },
});

type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined | null;

/**
 * 既定のルーティング（守山区 23113 が covered になる一式）に、先に試す override を重ねる。
 * override が undefined を返したら既定へ、null を返したら「通信失敗」（TypeError）
 */
function stubFetch(override?: Route) {
  const calls: string[] = [];
  const index = miniIndex();
  const base: Route = (url) => {
    if (url.includes('LonLatToAddress')) return geocode('23113');
    if (url === INDEX_URL) return json(index);
    const latest = /3dtiles\/(\d{5})-bldg-lod(\d)-(notexture|texture)-latest\//.exec(url);
    if (latest) return json(latestWrapper(tilesetUrlOf(index, latest[1], Number(latest[2]), latest[3] === 'texture')));
    if (url.endsWith('tileset.json')) {
      if (url.includes('23113')) return new Response(fixtureText('23113_lod1_tileset.json'), { headers: { 'content-type': 'application/json' } });
      if (url.includes('23102')) return new Response(fixtureText('23102_lod2nt_tileset.json'), { headers: { 'content-type': 'application/json' } });
      return undefined;
    }
    if (url.endsWith('.b3dm')) return bin(fixtureBuf('23113_lod1_data0.b3dm'));
    return undefined;
  };
  const f: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    let res = override ? await override(url, init) : undefined;
    if (res === null) throw new TypeError(`fetch failed: ${url}`);
    if (res === undefined) res = await base(url, init);
    if (!res) throw new TypeError(`fetch failed (no route): ${url}`);
    return res;
  };
  return { f, calls, index };
}

let draco: DracoDecoderLike;
/** タイル単位の失敗は console.warn に出る（URL 付き）。テストでは抑制して回数を数える */
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
beforeAll(async () => {
  draco = await nodeDracoDecoder();
});
beforeEach(async () => {
  await clearPlateauCaches();
  warn.mockClear();
});
afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const run = (f: typeof fetch, extra: Parameters<typeof fetchPlateauBuildings>[3] = {}, pin = PIN) => fetchPlateauBuildings(pin.lat, pin.lon, pin.radius, { fetchImpl: f, draco, indexUrl: INDEX_URL, ...extra });

const covered = (r: PlateauFetchResult) => {
  expect(r.status).toBe('covered');
  return r as Extract<PlateauFetchResult, { status: 'covered' }>;
};

describe('fetchPlateauBuildings: covered（守山区 23113・data0 の葉 1 枚・6 棟）', () => {
  it('status covered・buildings 6・lodCounts {1: 6}・tiles 1・datasets 1・failedTiles 0・truncated false', async () => {
    const { f, calls, index } = stubFetch();
    const stages: PlateauStage[] = [];
    const r = covered(await run(f, { onProgress: (p) => stages.push(p.stage) }));
    expect(r.buildings).toHaveLength(6);
    expect(r.lodCounts).toEqual({ '1': 6 });
    expect(r.failedTiles).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.missingMuniCds).toEqual([]);
    expect(r.tiles).toHaveLength(1);
    expect(r.tiles[0].url).toMatch(/23113_moriyama-ku_lod1\/data\/data0\.b3dm$/);
    expect(r.tiles[0].bytes).toBe(DATA0_BYTES);
    expect(r.tiles[0].buildings).toBe(6);
    expect(r.tiles[0].ms).toBeGreaterThanOrEqual(0);
    expect(r.datasets).toHaveLength(1);
    expect(r.datasets[0]).toMatchObject({ muniCd: '23113', pref: '愛知県', city: '名古屋市', ward: '守山区', year: 2022, lod: 1, tex: true, label: '愛知県名古屋市守山区・2022年度・LOD1' });
    expect(r.datasets[0].tilesetUrl).toBe(tilesetUrlOf(index, '23113', 1, true));
    for (const b of r.buildings) {
      expect(b.gmlId).toMatch(/^bldg_/);
      expect(b.attrs.muniCd).toBe('23113');
      expect(b.attrs.datasetLod).toBe(1);
      expect(b.attrs.footprint).toBe('bottom');
      expect(b.ring.length).toBeGreaterThanOrEqual(3);
      expect(b.mesh.tris.length).toBeGreaterThan(0);
      expect(b.height).toBeGreaterThan(0);
    }
    // 呼んだ URL: 逆ジオコーダ 5 点・索引 1・-latest 1・tileset 1・b3dm 1
    expect(calls.filter((u) => u.includes('LonLatToAddress'))).toHaveLength(5);
    expect(calls.filter((u) => u === INDEX_URL)).toHaveLength(1);
    expect(calls.filter((u) => u.includes('-latest'))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('tileset.json') && !u.includes('-latest'))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('.b3dm'))).toHaveLength(1);
    // 進捗の段階は geocode → index → tileset → tiles → decode → merge の順（連続する同じ段階は 1 つに）
    const order = stages.filter((s, i) => i === 0 || stages[i - 1] !== s);
    expect(order).toEqual(['geocode', 'index', 'tileset', 'tiles', 'decode', 'merge']);
  });

  it('2 回目は fetch が 0 回（索引のメモ・tileset と b3dm のメモリ LRU・分割キャッシュ）で同じ結果。逆ジオコーダは毎回', async () => {
    const { f, calls } = stubFetch();
    const r1 = covered(await run(f));
    const n1 = calls.length;
    const r2 = covered(await run(f));
    const newCalls = calls.slice(n1);
    // 逆ジオコーダと -latest（no-store）は取り直す。索引・tileset・b3dm は 0 回
    expect(newCalls.filter((u) => u === INDEX_URL)).toHaveLength(0);
    expect(newCalls.filter((u) => u.endsWith('tileset.json') && !u.includes('-latest'))).toHaveLength(0);
    expect(newCalls.filter((u) => u.endsWith('.b3dm'))).toHaveLength(0);
    expect(r2.buildings.map((b) => b.gmlId).sort()).toEqual(r1.buildings.map((b) => b.gmlId).sort());
    // 分割結果は同じオブジェクト（再復号していない）
    expect(r2.buildings.find((b) => b.gmlId === r1.buildings[0].gmlId)).toBe(r1.buildings[0]);
  });

  it('ピンを動かして半径を狭めると keep で棟が減り、広げると（data0 を再取得・再復号せずに）増える。半径外だけなら none/noTiles', async () => {
    const { f, calls } = stubFetch();
    // 棟の重心 35.2558,137.0529 から東へ 55 m、半径 50 → 近い棟だけ（この位置では隣の葉 data1〜3 も選ばれるが、中身は同じ fixture なので重複除去される）
    const near = covered(await run(f, {}, { lat: 35.2558, lon: 137.0535, radius: 50 }));
    expect(near.buildings.length).toBeGreaterThan(0);
    expect(near.buildings.length).toBeLessThan(6);
    const n1 = calls.length;
    const all = covered(await run(f, {}, { lat: 35.2558, lon: 137.0529, radius: 250 }));
    expect(all.buildings).toHaveLength(6);
    expect(calls.slice(n1).filter((u) => u.endsWith('data0.b3dm'))).toHaveLength(0);
    // 残りの棟は前回の復号結果に足される（同じ DecodedTile から分割）: 前回あった棟は同じオブジェクト
    for (const b of near.buildings) expect(all.buildings.find((x) => x.gmlId === b.gmlId)).toBe(b);
    // 葉は選ばれるが棟がすべて半径外（region の北東の端）
    const none = await run(f, {}, { lat: 35.259, lon: 137.0595, radius: 40 });
    expect(none).toEqual({ status: 'none', reason: 'noTiles', muniCds: ['23113'] });
  });
});

describe('fetchPlateauBuildings: 対象外・エラー', () => {
  it('索引に無い muniCd（川越 11201）→ none/outside', async () => {
    const { f } = stubFetch((url) => (url.includes('LonLatToAddress') ? geocode('11201') : undefined));
    expect(await run(f)).toEqual({ status: 'none', reason: 'outside', muniCds: ['11201'] });
  });

  it('-latest が children 無し（データセットが消えた）→ none/outside（tileset は取らない）', async () => {
    const { f, calls } = stubFetch((url) => (url.includes('-latest') ? new Response(fixtureText('latest_missing.json'), { headers: { 'content-type': 'application/json' } }) : undefined));
    expect(await run(f)).toEqual({ status: 'none', reason: 'outside', muniCds: ['23113'] });
    expect(calls.filter((u) => u.endsWith('tileset.json') && !u.includes('-latest'))).toHaveLength(0);
  });

  it('-latest が 500 → 索引の URL に退避して covered', async () => {
    const { f, calls, index } = stubFetch((url) => (url.includes('-latest') ? json({ error: 'down' }, 500) : undefined));
    const r = covered(await run(f));
    expect(r.buildings).toHaveLength(6);
    expect(r.datasets[0].tilesetUrl).toBe(tilesetUrlOf(index, '23113', 1, true));
    expect(calls).toContain(tilesetUrlOf(index, '23113', 1, true));
  });

  it('tileset.json が 500 → error/tileset', async () => {
    const { f } = stubFetch((url) => (url.endsWith('tileset.json') && !url.includes('-latest') ? json({}, 500) : undefined));
    const r = await run(f);
    expect(r.status).toBe('error');
    expect(r).toMatchObject({ stage: 'tileset' });
    expect((r as { message: string }).message).toMatch(/HTTP 500/);
  });

  it('tileset.json が JSON でない／root が無い → error/tileset', async () => {
    const bad = stubFetch((url) => (url.endsWith('tileset.json') && !url.includes('-latest') ? new Response('<html>', { headers: { 'content-type': 'text/html' } }) : undefined));
    expect(await run(bad.f)).toMatchObject({ status: 'error', stage: 'tileset' });
    const noRoot = stubFetch((url) => (url.endsWith('tileset.json') && !url.includes('-latest') ? json({ asset: {} }) : undefined));
    expect(await run(noRoot.f)).toMatchObject({ status: 'error', stage: 'tileset' });
  });

  it('逆ジオコーダ全滅 + 索引に region 無し → error/geocode。索引にも繋がらなければ error/geocode（通信）', async () => {
    const a = stubFetch((url) => (url.includes('LonLatToAddress') ? null : undefined));
    expect(await run(a.f)).toMatchObject({ status: 'error', stage: 'geocode' });
    const b = stubFetch((url) => (url.includes('LonLatToAddress') || url === INDEX_URL ? null : undefined));
    const rb = await run(b.f);
    expect(rb).toMatchObject({ status: 'error', stage: 'geocode' });
    expect((rb as { message: string }).message).toMatch(/索引/);
  });

  it('逆ジオコーダ全滅でも索引に region があれば muniCodesByRegion で続けて covered', async () => {
    const index = miniIndex();
    // 守山区の region（度）: data0 の葉を含む範囲
    index.areas['23113'].region = [137.0, 35.2, 137.1, 35.3];
    const { f } = stubFetch((url) => (url.includes('LonLatToAddress') ? geocode(null) : url === INDEX_URL ? json(index) : undefined));
    const r = covered(await run(f));
    expect(r.buildings).toHaveLength(6);
    expect(r.datasets[0].muniCd).toBe('23113');
  });

  it('逆ジオコーダ全滅 + 実物の索引（public/plateau-index.json）の region → 守山区だけが引けて covered（東区の region はピンを含まない）', async () => {
    const real = JSON.parse(readFileSync(new URL('../public/plateau-index.json', import.meta.url), 'utf8')) as PlateauIndex;
    const index = miniIndex();
    for (const cd of ['13112', '23102', '23113']) index.areas[cd].region = real.areas[cd].region;
    expect(index.areas['23113'].region).toBeDefined();
    const { f, calls } = stubFetch((url) => (url.includes('LonLatToAddress') ? null : url === INDEX_URL ? json(index) : undefined));
    const r = covered(await run(f));
    expect(r.buildings).toHaveLength(6);
    expect(r.datasets.map((d) => d.muniCd)).toEqual(['23113']);
    // 東区・世田谷区の -latest は呼ばれない（region がピンの箱と交差しない）
    expect(calls.filter((u) => u.includes('-latest'))).toEqual([PLATEAU_LATEST_URL('23113', 1, true)]);
  });

  it('索引が 500 → error/index', async () => {
    const { f } = stubFetch((url) => (url === INDEX_URL ? json({}, 500) : undefined));
    expect(await run(f)).toMatchObject({ status: 'error', stage: 'index' });
  });

  it('Draco デコーダが用意できない → error/decode（タイルは取れている）', async () => {
    const { f } = stubFetch();
    const broken: DracoDecoderLike = { preload: () => Promise.reject(new Error('wasm NG')), decodeDracoFile: () => undefined };
    const r = await run(f, { draco: broken });
    expect(r).toMatchObject({ status: 'error', stage: 'decode' });
    expect((r as { message: string }).message).toMatch(/wasm NG/);
  });

  it('b3dm が壊れている（全タイル）→ error/tiles。直れば（キャッシュを空にしなくても）covered。1 枚だけ壊れていれば covered + failedTiles 1（console.warn 1 回）', async () => {
    const { index } = stubFetch();
    const tsUrl = tilesetUrlOf(index, '23113', 1, true);
    const base = tsUrl.replace(/tileset\.json$/, '');
    // magic が違う（200 で返る HTML など）: fetchCached の検証で失敗し、メモリ LRU に残らない
    const allBad = stubFetch((url) => (url.endsWith('.b3dm') ? bin(new ArrayBuffer(64)) : undefined));
    const e = await run(allBad.f);
    expect(e).toMatchObject({ status: 'error', stage: 'tiles' });
    expect((e as { message: string }).message).toMatch(/取得できません/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/data0\.b3dm/);
    // サーバが直った: clearPlateauCaches せずに取り直して covered（b3dm を 1 回取る）
    const fixed = stubFetch();
    const r0 = covered(await run(fixed.f));
    expect(r0.buildings).toHaveLength(6);
    expect(fixed.calls.filter((u) => u.endsWith('.b3dm'))).toHaveLength(1);

    await clearPlateauCaches();
    warn.mockClear();
    // ヘッダは正しいが中身が足りない（復号段で parseB3dm が失敗）: failedTiles に数え、キャッシュから捨てる
    const header = new Uint8Array(28);
    header.set([98, 51, 100, 109, 1, 0, 0, 0, 232, 3, 0, 0]); // 'b3dm' version 1 byteLength 1000
    const oneBad = stubFetch((url) => {
      if (url === tsUrl) return json(leafTileset(['data/data0.b3dm', 'data/data1.b3dm']));
      if (url === base + 'data/data1.b3dm') return bin(header.buffer);
      return undefined;
    });
    const r = covered(await run(oneBad.f));
    expect(r.failedTiles).toBe(1);
    expect(r.buildings).toHaveLength(6);
    expect(r.tiles).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/読めません.*data1\.b3dm/);
    // 読めなかった data1 は捨てられているので、直れば取り直して読める（data0 は残っている）
    const n = oneBad.calls.length;
    const fixed2 = stubFetch((url) => (url === tsUrl ? json(leafTileset(['data/data0.b3dm', 'data/data1.b3dm'])) : undefined));
    const r2 = covered(await run(fixed2.f));
    expect(r2.failedTiles).toBe(0);
    expect(r2.tiles).toHaveLength(2);
    expect(oneBad.calls.length).toBe(n);
    expect(fixed2.calls.filter((u) => u.endsWith('.b3dm'))).toEqual([base + 'data/data1.b3dm']);
  });

  it('Draco デコーダの用意はタイル取得と並列に始まる（preload が最初の .b3dm 取得より前）', async () => {
    const events: string[] = [];
    const wrapped: DracoDecoderLike = {
      preload: () => {
        events.push('preload');
        return draco.preload();
      },
      decodeDracoFile: (...a) => draco.decodeDracoFile(...a),
    };
    const { f } = stubFetch((url) => {
      if (url.endsWith('.b3dm')) events.push('b3dm');
      return undefined;
    });
    const r = covered(await run(f, { draco: wrapped }));
    expect(r.buildings).toHaveLength(6);
    expect(events.indexOf('preload')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('preload')).toBeLessThan(events.indexOf('b3dm'));
  });
});

describe('fetchPlateauBuildings: 葉の選択は半径そのもの（region 距離 > radiusM の葉は fetch しない）', () => {
  const RAD = Math.PI / 180;
  /** ピンから東 e0..e1 m・北 n0..n1 m の region（ラジアン・m） */
  const regionAt = (e0: number, e1: number, n0: number, n1: number, minH: number, maxH: number) => {
    const { mLat, mLon } = metersPerDegree(PIN.lat);
    return [(PIN.lon + e0 / mLon) * RAD, (PIN.lat + n0 / mLat) * RAD, (PIN.lon + e1 / mLon) * RAD, (PIN.lat + n1 / mLat) * RAD, minH, maxH];
  };
  /** data0 ＋ 半径 250 のすぐ外（東 260〜400 m・高さスパン 200 m）＋ 箱の角（東北 240〜300 m・距離 339 m・スパン 100 m）の 3 葉 */
  const tileset3 = () => ({
    asset: { version: '1.0' },
    geometricError: 100,
    root: {
      boundingVolume: { region: regionAt(-1000, 1000, -1000, 1000, 0, 500) },
      geometricError: 100,
      refine: 'REPLACE',
      children: [
        { boundingVolume: { region: DATA0_REGION }, geometricError: 0, content: { uri: 'data/data0.b3dm' } },
        { boundingVolume: { region: regionAt(260, 400, -50, 50, 200, 400) }, geometricError: 0, content: { uri: 'data/far.b3dm' } },
        { boundingVolume: { region: regionAt(240, 300, 240, 300, 200, 300) }, geometricError: 0, content: { uri: 'data/corner.b3dm' } },
      ],
    },
  });

  it('半径 + marginM（280 m）の箱なら高さスパン規則で選ばれる葉が、半径 250 m では選ばれず fetch されない（covered・tiles 1）', async () => {
    const { index } = stubFetch();
    const tsUrl = tilesetUrlOf(index, '23113', 1, true);
    const ts = parseTileset(tileset3(), tsUrl);
    const o = { lat: PIN.lat, lon: PIN.lon, nearM: 150, reachFactor: 6.9, reachMargin: 60, maxTiles: 16 };
    // 余白付きの箱（旧実装）だと far も corner も選ばれる
    const wide = selectContentTiles(ts, degBoxAround(PIN.lat, PIN.lon, PIN.radius + 30), o).tiles.map((t) => t.url.replace(/.*\//, ''));
    expect(wide).toEqual(['data0.b3dm', 'far.b3dm', 'corner.b3dm']);
    // 半径そのものの箱: far は交差しない。corner は箱の角で交差するが region までの距離 339 m > 250 m
    const tight = selectContentTiles(ts, degBoxAround(PIN.lat, PIN.lon, PIN.radius), o).tiles;
    expect(tight.map((t) => t.url.replace(/.*\//, ''))).toEqual(['data0.b3dm', 'corner.b3dm']);
    expect(tight[1].distanceM).toBeGreaterThan(PIN.radius);

    const { f, calls } = stubFetch((url) => (url === tsUrl ? json(tileset3()) : undefined));
    const r = covered(await run(f));
    expect(r.tiles).toHaveLength(1);
    expect(r.buildings).toHaveLength(6);
    expect(r.truncated).toBe(false);
    const b3dm = calls.filter((u) => u.endsWith('.b3dm'));
    expect(b3dm).toHaveLength(1);
    expect(b3dm[0]).toMatch(/data0\.b3dm$/);
  });
});

describe('fetchPlateauBuildings: maxBytes は Content-Length の累計（concurrency に依らない）・totalBytes', () => {
  /** 6 葉（同じ region・中身は data0）。Content-Length 付きで返す */
  const sixLeaves = () => {
    const { index } = stubFetch();
    const tsUrl = tilesetUrlOf(index, '23113', 1, true);
    const uris = Array.from({ length: 6 }, (_, i) => `data/data${i}.b3dm`);
    return stubFetch((url) => {
      if (url === tsUrl) return json(leafTileset(uris));
      if (url.endsWith('.b3dm')) return new Response(fixtureBuf('23113_lod1_data0.b3dm'), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(DATA0_BYTES) } });
      return undefined;
    });
  };

  it('maxBytes = 2.5 枚分 → concurrency 1 でも 4 でも 2 枚・truncated・failedTiles 0。totalBytes は捨てた葉を除いた Content-Length の合計', async () => {
    const maxBytes = Math.floor(DATA0_BYTES * 2.5);
    for (const concurrency of [1, 4]) {
      await clearPlateauCaches();
      const { f } = sixLeaves();
      const ps: PlateauProgress[] = [];
      const r = covered(await run(f, { maxBytes, concurrency, onProgress: (p) => ps.push(p) }));
      expect(r.tiles, `concurrency ${concurrency}`).toHaveLength(2);
      expect(r.tiles.map((t) => t.url.replace(/.*\//, ''))).toEqual(['data0.b3dm', 'data1.b3dm']);
      expect(r.truncated).toBe(true);
      expect(r.failedTiles).toBe(0);
      expect(r.buildings).toHaveLength(6);
      const tiles = ps.filter((p) => p.stage === 'tiles');
      // 最初は 6 枚とも不明（見積り）なので正、最後は取った 2 枚の Content-Length の合計
      expect(tiles[0].totalBytes).toBeGreaterThan(0);
      const last = tiles[tiles.length - 1];
      expect(last.totalBytes).toBe(DATA0_BYTES * 2);
      expect(last.bytes).toBe(DATA0_BYTES * 2);
      expect(last).toMatchObject({ done: 2, total: 2 });
      for (let i = 1; i < ps.length; i++) expect(ps[i].ratio).toBeGreaterThanOrEqual(ps[i - 1].ratio);
    }
  });

  it('予算が十分なら 6 枚とも取り、totalBytes = 6 枚の Content-Length', async () => {
    const { f } = sixLeaves();
    const ps: PlateauProgress[] = [];
    const r = covered(await run(f, { onProgress: (p) => ps.push(p) }));
    expect(r.tiles).toHaveLength(6);
    expect(r.truncated).toBe(false);
    const tiles = ps.filter((p) => p.stage === 'tiles');
    expect(tiles[tiles.length - 1].totalBytes).toBe(DATA0_BYTES * 6);
  });
});

describe('fetchPlateauBuildings: 複数の葉・上限・中止', () => {
  /** 守山区の tileset を「data0 と dataX の 2 葉」に差し替えるルート */
  const twoLeaves = (second: Route, uris = ['data/data0.b3dm', 'data/data7.b3dm']) => {
    const { index } = stubFetch();
    const tsUrl = tilesetUrlOf(index, '23113', 1, true);
    const base = tsUrl.replace(/tileset\.json$/, '');
    return stubFetch((url, init) => {
      if (url === tsUrl) return json(leafTileset(uris));
      if (url === base + uris[1]) return second(url, init);
      return undefined;
    });
  };

  it('1 枚が 500 → covered かつ failedTiles 1・buildings 6・tiles 1', async () => {
    const { f } = twoLeaves(() => bin(new ArrayBuffer(0), 500));
    const r = covered(await run(f));
    expect(r.failedTiles).toBe(1);
    expect(r.buildings).toHaveLength(6);
    expect(r.tiles).toHaveLength(1);
    expect(r.truncated).toBe(false);
  });

  it('1 枚が通信失敗（TypeError）でも同じ。全部 404 なら error/tiles', async () => {
    const { f } = twoLeaves(() => null);
    const r = covered(await run(f));
    expect(r.failedTiles).toBe(1);
    expect(r.buildings).toHaveLength(6);
    // data0 はメモリ LRU に残っているので空にしてから「全部 404」を試す
    await clearPlateauCaches();
    const all = stubFetch((url) => (url.endsWith('.b3dm') ? bin(new ArrayBuffer(0), 404) : undefined));
    const e = await run(all.f);
    expect(e).toMatchObject({ status: 'error', stage: 'tiles' });
    expect((e as { message: string }).message).toMatch(/1 枚も/);
  });

  it('gml_id が重複する 2 葉（同じ data0 の中身）→ buildings は 1 棟ずつ（6）、tiles 2', async () => {
    const { f } = twoLeaves(() => bin(fixtureBuf('23113_lod1_data0.b3dm')));
    const r = covered(await run(f));
    expect(r.tiles).toHaveLength(2);
    expect(r.tiles.map((t) => t.buildings)).toEqual([6, 6]);
    expect(r.buildings).toHaveLength(6);
    expect(new Set(r.buildings.map((b) => b.gmlId)).size).toBe(6);
    expect(r.lodCounts).toEqual({ '1': 6 });
  });

  it('maxTiles 1 → 近い葉だけ読んで truncated true。maxBytes が 1 枚分に満たなければ 1 枚取ったところで truncated', async () => {
    const a = twoLeaves(() => bin(fixtureBuf('23113_lod1_data0.b3dm')));
    const r = covered(await run(a.f, { maxTiles: 1 }));
    expect(r.truncated).toBe(true);
    expect(r.tiles).toHaveLength(1);
    expect(r.buildings).toHaveLength(6);
    const b = twoLeaves(() => bin(fixtureBuf('23113_lod1_data0.b3dm')));
    const r2 = covered(await run(b.f, { maxBytes: 1000, concurrency: 1 }));
    expect(r2.truncated).toBe(true);
    expect(r2.tiles).toHaveLength(1);
    expect(r2.failedTiles).toBe(0);
  });

  it('区境を模した 2 コード（中心 23113・隅 23102）→ datasets 2 件（中心の市区が先頭）、buildings は重複除去で 6', async () => {
    const { index } = stubFetch();
    const ts23102 = tilesetUrlOf(index, '23102', 2, false);
    const { f } = stubFetch((url) => {
      const m = /lat=([\d.]+)&lon=([\d.]+)/.exec(url);
      if (m) return geocode(Number(m[1]) === PIN.lat && Number(m[2]) === PIN.lon ? '23113' : '23102');
      // 東区の tileset を「data0 と同じ region の葉 1 枚」に差し替え、その b3dm は data0 の中身
      if (url === ts23102) return json(leafTileset(['data/data0.b3dm']));
      return undefined;
    });
    const r = covered(await run(f));
    expect(r.datasets.map((d) => d.muniCd)).toEqual(['23113', '23102']);
    expect(r.datasets[1].label).toBe('愛知県名古屋市東区・2022年度・LOD2');
    expect(r.tiles).toHaveLength(2);
    expect(r.buildings).toHaveLength(6);
    expect(r.missingMuniCds).toEqual([]);
    // 片方が未整備なら missingMuniCds に入り datasets は 1 件
    const half = stubFetch((url) => {
      const m = /lat=([\d.]+)&lon=([\d.]+)/.exec(url);
      if (m) return geocode(Number(m[1]) === PIN.lat && Number(m[2]) === PIN.lon ? '23113' : '11201');
      return undefined;
    });
    const r2 = covered(await run(half.f));
    expect(r2.datasets.map((d) => d.muniCd)).toEqual(['23113']);
    expect(r2.missingMuniCds).toEqual(['11201']);
  });

  it('AbortSignal: 先に中止 → reason を throw。b3dm の取得中に中止 → reason を throw（status に畳まない）', async () => {
    const reason = new Error('やめた');
    const pre = new AbortController();
    pre.abort(reason);
    const { f } = stubFetch();
    await expect(run(f, { signal: pre.signal })).rejects.toBe(reason);

    const ac = new AbortController();
    const mid = stubFetch((url) => {
      if (url.endsWith('.b3dm')) {
        ac.abort(reason);
        return bin(fixtureBuf('23113_lod1_data0.b3dm'));
      }
      return undefined;
    });
    await expect(run(mid.f, { signal: ac.signal })).rejects.toBe(reason);
    // 中止した取得はキャッシュに残らない: 次は取り直して covered
    const again = stubFetch();
    const r = covered(await run(again.f));
    expect(r.buildings).toHaveLength(6);
  });

  it('進捗: tiles の bytes が累計し、decode の message に棟数、最後の ratio は 1', async () => {
    const { f } = twoLeaves(() => bin(fixtureBuf('23113_lod1_data0.b3dm')));
    const ps: PlateauProgress[] = [];
    covered(await run(f, { onProgress: (p) => ps.push(p) }));
    const tiles = ps.filter((p) => p.stage === 'tiles');
    expect(tiles[0]).toMatchObject({ done: 0, total: 2, bytes: 0 });
    expect(tiles[tiles.length - 1]).toMatchObject({ done: 2, total: 2, bytes: DATA0_BYTES * 2 });
    expect(tiles[tiles.length - 1].message).toMatch(/建物タイル 2\/2/);
    const decode = ps.filter((p) => p.stage === 'decode');
    expect(decode).toHaveLength(2);
    expect(decode[1].message).toMatch(/12 棟/);
    expect(ps[ps.length - 1].stage).toBe('merge');
    expect(ps[ps.length - 1].ratio).toBe(1);
    for (let i = 1; i < ps.length; i++) expect(ps[i].ratio).toBeGreaterThanOrEqual(ps[i - 1].ratio);
  });
});

describe('fetchCached / clearPlateauCaches / plateauDatasetLabel', () => {
  it('同じ URL は 1 回しか取らず同じ ArrayBuffer を返す。非 2xx は Error で、失敗は残らない', async () => {
    let fail = true;
    const calls: string[] = [];
    const f: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      return fail ? new Response('x', { status: 503 }) : bin(new Uint8Array([1, 2, 3]).buffer);
    };
    await expect(fetchCached('https://example.test/a.bin', { fetchImpl: f })).rejects.toThrow(/HTTP 503/);
    fail = false;
    const a = await fetchCached('https://example.test/a.bin', { fetchImpl: f });
    const b = await fetchCached('https://example.test/a.bin', { fetchImpl: f });
    expect(a).toBe(b);
    expect(new Uint8Array(a)).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toHaveLength(2);
    // Node には Cache API が無い（typeof caches のガード）
    expect(typeof caches).toBe('undefined');
    await clearPlateauCaches();
    await fetchCached('https://example.test/a.bin', { fetchImpl: f });
    expect(calls).toHaveLength(3);
  });

  it('中止済みの signal なら reason を throw', async () => {
    const ac = new AbortController();
    const reason = new Error('stop');
    ac.abort(reason);
    await expect(fetchCached('https://example.test/b.bin', { fetchImpl: async () => bin(new ArrayBuffer(1)), signal: ac.signal })).rejects.toBe(reason);
  });

  it('200 でも中身を検証する: .b3dm は magic、.json は JSON.parse。不正ならキャッシュせず Error（直れば取り直す）。他の拡張子は検証しない', async () => {
    let good = false;
    const calls: string[] = [];
    const f: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (/\.b3dm(\?|$)/.test(url)) return good ? bin(fixtureBuf('23113_lod1_data0.b3dm')) : new Response('<html>captive portal</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      if (url.endsWith('.json')) return new Response(good ? '{"root":{}}' : '<html>', { status: 200 });
      return new Response('<html>', { status: 200 });
    };
    await expect(fetchCached('https://example.test/t/data0.b3dm?v=1', { fetchImpl: f })).rejects.toThrow(/中身が不正.*b3dm ではありません/);
    await expect(fetchCached('https://example.test/t/tileset.json', { fetchImpl: f })).rejects.toThrow(/中身が不正.*JSON ではありません/);
    // 検証しない拡張子は HTML でもそのまま返す
    const other = await fetchCached('https://example.test/t/page.bin', { fetchImpl: f });
    expect(new TextDecoder().decode(new Uint8Array(other))).toBe('<html>');
    good = true;
    const b3dm = await fetchCached('https://example.test/t/data0.b3dm?v=1', { fetchImpl: f });
    expect(b3dm.byteLength).toBe(DATA0_BYTES);
    const ts = await fetchCached('https://example.test/t/tileset.json', { fetchImpl: f });
    expect(new TextDecoder().decode(new Uint8Array(ts))).toBe('{"root":{}}');
    expect(calls).toHaveLength(5);
  });

  it('共有 Promise の中止: 先に始めた呼び出しが中止しても、同じ URL を待つ別の呼び出しは失敗しない。全員が中止したら下層の fetch を中止する', async () => {
    const url = 'https://example.test/shared/data0.b3dm';
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const signals: AbortSignal[] = [];
    const f: typeof fetch = async (_input, init) => {
      signals.push(init!.signal!);
      await gate;
      return bin(fixtureBuf('23113_lod1_data0.b3dm'));
    };
    const a = new AbortController();
    const b = new AbortController();
    const reasonA = new Error('A やめた');
    const pA = fetchCached(url, { fetchImpl: f, signal: a.signal });
    const pB = fetchCached(url, { fetchImpl: f, signal: b.signal });
    const pC = fetchCached(url, { fetchImpl: f }); // signal 無し
    expect(signals).toHaveLength(0);
    await sleep(0);
    expect(signals).toHaveLength(1);
    a.abort(reasonA);
    await expect(pA).rejects.toBe(reasonA);
    expect(signals[0].aborted).toBe(false);
    release();
    const bufB = await pB;
    expect(bufB.byteLength).toBe(DATA0_BYTES);
    expect(await pC).toBe(bufB);
    expect(signals).toHaveLength(1);

    // 待っている全員が中止 → 下層の fetch も中止され、次の呼び出しは取り直す
    const url2 = 'https://example.test/shared/data1.b3dm';
    const signals2: AbortSignal[] = [];
    const f2: typeof fetch = async (_input, init) => {
      signals2.push(init!.signal!);
      await new Promise<void>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
      return bin(new ArrayBuffer(0));
    };
    const c = new AbortController();
    const d = new AbortController();
    const pC2 = fetchCached(url2, { fetchImpl: f2, signal: c.signal });
    const pD2 = fetchCached(url2, { fetchImpl: f2, signal: d.signal });
    await sleep(0);
    c.abort(new Error('C'));
    expect(signals2[0].aborted).toBe(false);
    d.abort(new Error('D'));
    expect(signals2[0].aborted).toBe(true);
    await expect(pC2).rejects.toThrow('C');
    await expect(pD2).rejects.toThrow('D');
    const f3: typeof fetch = async () => bin(fixtureBuf('23113_lod1_data0.b3dm'));
    expect((await fetchCached(url2, { fetchImpl: f3 })).byteLength).toBe(DATA0_BYTES);
  });

  /** Node には Cache API が無いので偽物を globalThis に置く（afterEach で外す）。put は遅らせられる */
  function fakeCaches(putDelayMs: number) {
    const store = new Map<string, Response>();
    const cache = {
      match: async (url: string) => {
        const r = store.get(url);
        return r ? r.clone() : undefined;
      },
      put: async (url: string, res: Response) => {
        await sleep(putDelayMs);
        store.set(url, res);
      },
      delete: async (url: string) => store.delete(url),
    };
    (globalThis as { caches?: unknown }).caches = {
      open: async () => cache,
      delete: async () => {
        store.clear();
        return true;
      },
    };
    return store;
  }

  it('Cache API: 取得後に put（独自ヘッダ付き）。clearPlateauCaches は進行中の put を待ってから消す（遅い put で項目が復活しない）', async () => {
    const store = fakeCaches(30);
    const url = 'https://example.test/cache/data0.b3dm';
    const f: typeof fetch = async () => bin(fixtureBuf('23113_lod1_data0.b3dm'));
    await fetchCached(url, { fetchImpl: f });
    await sleep(50);
    expect(store.has(url)).toBe(true);
    expect(Number(store.get(url)!.headers.get('x-plateau-cached-at'))).toBeGreaterThan(Date.now() - 5000);
    await clearPlateauCaches();
    expect(store.size).toBe(0);
    // put の最中に clear
    await fetchCached(url, { fetchImpl: f });
    await clearPlateauCaches();
    await sleep(60);
    expect(store.size).toBe(0);
  });

  it('Cache API のヒットでは fetch しない。期限切れ・中身が不正な項目は捨てて取り直す', async () => {
    const store = fakeCaches(0);
    const calls: string[] = [];
    const f: typeof fetch = async (input) => {
      calls.push(String(input));
      return bin(fixtureBuf('23113_lod1_data0.b3dm'));
    };
    const headers = (at: number) => ({ 'content-type': 'application/octet-stream', 'x-plateau-cached-at': String(at) });
    store.set('https://example.test/hit/data0.b3dm', new Response(fixtureBuf('23113_lod1_data0.b3dm'), { headers: headers(Date.now()) }));
    store.set('https://example.test/stale/data0.b3dm', new Response(fixtureBuf('23113_lod1_data0.b3dm'), { headers: headers(Date.now() - 31 * 24 * 3600 * 1000) }));
    store.set('https://example.test/bad/data0.b3dm', new Response('<html>', { headers: headers(Date.now()) }));
    expect((await fetchCached('https://example.test/hit/data0.b3dm', { fetchImpl: f })).byteLength).toBe(DATA0_BYTES);
    expect(calls).toEqual([]);
    expect((await fetchCached('https://example.test/stale/data0.b3dm', { fetchImpl: f })).byteLength).toBe(DATA0_BYTES);
    expect((await fetchCached('https://example.test/bad/data0.b3dm', { fetchImpl: f })).byteLength).toBe(DATA0_BYTES);
    expect(calls).toEqual(['https://example.test/stale/data0.b3dm', 'https://example.test/bad/data0.b3dm']);
    await sleep(10);
    // 取り直したものは書き直されている
    expect(store.get('https://example.test/bad/data0.b3dm')!.headers.get('content-type')).toBe('application/octet-stream');
    expect(Number(store.get('https://example.test/stale/data0.b3dm')!.headers.get('x-plateau-cached-at'))).toBeGreaterThan(Date.now() - 5000);
  });

  it('onHeaders: Content-Length（無ければ null、キャッシュからは実バイト数）を受け取る', async () => {
    const lens: (number | null)[] = [];
    const f: typeof fetch = async (input) => (String(input).includes('nolen') ? bin(new Uint8Array([1, 2, 3]).buffer) : new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-length': '4' } }));
    await fetchCached('https://example.test/h/a.bin', { fetchImpl: f, onHeaders: (n) => lens.push(n) });
    await fetchCached('https://example.test/h/nolen.bin', { fetchImpl: f, onHeaders: (n) => lens.push(n) });
    await fetchCached('https://example.test/h/a.bin', { fetchImpl: f, onHeaders: (n) => lens.push(n) });
    expect(lens).toEqual([4, null, 4]);
  });

  it('plateauDatasetLabel: PLATEAU（国土交通省 3D都市モデル・{label}）', () => {
    expect(plateauDatasetLabel({ muniCd: '13112', pref: '東京都', city: '世田谷区', ward: null, year: 2025, lod: 2, tex: false, tilesetUrl: 'x', label: '東京都世田谷区・2025年度・LOD2' })).toBe(
      'PLATEAU（国土交通省 3D都市モデル・東京都世田谷区・2025年度・LOD2）',
    );
  });
});
