/**
 * PLATEAU のカタログ（src/sun/plateau/catalog.ts）のテスト。ネットワークは使わず fetchImpl をスタブする。
 *  - loadPlateauIndex: 索引の読み込み・Promise のメモ化（同じ fetchImpl なら 2 回目は通信しない）・失敗は取り直せる・形の検証・Node での既定 URL
 *  - muniCodesAround: 中心＋4 隅の 5 点を allSettled・重複除去・1 件でも成功すれば返す・全滅で throw・中止は signal.reason
 *  - muniCodesByRegion: region を持つ索引で box 交差の市区、無い索引では []
 *  - public/plateau-index.json（実物。W16 で region を追加）: 全市区に region があり 300 KB 以下、実地点の予備経路が引ける
 *  - pickDataset: LOD 降順・同 LOD はテクスチャ無し先・label・索引に無い市区は null
 *  - resolveTilesetUrl: -latest ラッパー → 実 URL（via 'latest'）、children 無し → missing、失敗 → 索引 URL（via 'index'）
 *  - 期限（第 2 回レビュー）: deadlineSignal の合成、fetchImpl が永遠に返らないときの timeoutMs（索引は Error・逆ジオコーダは失敗に数える・-latest は索引 URL に退避）
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PLATEAU_LATEST_URL,
  PLATEAU_TIMEOUTS,
  REVERSE_GEOCODER_URL,
  deadlineSignal,
  isTimeoutError,
  loadPlateauIndex,
  muniCodesAround,
  muniCodesByRegion,
  pickDataset,
  resolveTilesetUrl,
  type PlateauIndex,
} from '../src/sun/plateau/catalog';
import { degBoxAround } from '../src/sun/geodesy';

const fixtureText = (name: string): string => readFileSync(new URL(`./fixtures/plateau/${name}`, import.meta.url), 'utf8');
const fixtureJson = <T = unknown>(name: string): T => JSON.parse(fixtureText(name)) as T;

const INDEX_URL = 'https://example.test/plateau-index.json';
const miniIndex = (): PlateauIndex => fixtureJson<PlateauIndex>('index.mini.json');

/** URL の一部で応答を切り替えるスタブ。呼ばれた URL を記録する */
type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
function stubFetch(route: Route) {
  const calls: string[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const res = await route(url, init);
    if (!res) throw new TypeError(`fetch failed: ${url}`);
    return res;
  };
  return { f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const geocode = (muniCd: string | null) => json({ results: muniCd ? { muniCd, lv01Nm: '町' } : null });

describe('loadPlateauIndex', () => {
  it('索引を読み、同じ fetchImpl では Promise がメモ化されて 2 回目は通信しない', async () => {
    const { f, calls } = stubFetch((url) => (url === INDEX_URL ? json(miniIndex()) : undefined));
    const a = await loadPlateauIndex({ url: INDEX_URL, fetchImpl: f });
    const b = await loadPlateauIndex({ url: INDEX_URL, fetchImpl: f });
    expect(a).toBe(b);
    expect(calls).toEqual([INDEX_URL]);
    expect(Object.keys(a.areas).sort()).toEqual(['13112', '23102', '23113']);
    expect(a.urlPrefix).toBe('https://assets.cms.plateau.reearth.io/assets/');
    expect(a.generated).toBe('2026-10-10');
  });

  it('別の fetchImpl（別のスタブ）はメモを共有しない', async () => {
    const s1 = stubFetch(() => json(miniIndex()));
    const s2 = stubFetch(() => json({ ...miniIndex(), generated: '2027-01-01' }));
    const a = await loadPlateauIndex({ url: INDEX_URL, fetchImpl: s1.f });
    const b = await loadPlateauIndex({ url: INDEX_URL, fetchImpl: s2.f });
    expect(a.generated).toBe('2026-10-10');
    expect(b.generated).toBe('2027-01-01');
    expect(s1.calls.length + s2.calls.length).toBe(2);
  });

  it('HTTP 500 は日本語の Error で reject し、失敗はメモに残らず取り直せる', async () => {
    let fail = true;
    const { f, calls } = stubFetch(() => (fail ? json({}, 500) : json(miniIndex())));
    await expect(loadPlateauIndex({ url: INDEX_URL, fetchImpl: f })).rejects.toThrow(/PLATEAU の索引.*HTTP 500/);
    fail = false;
    const idx = await loadPlateauIndex({ url: INDEX_URL, fetchImpl: f });
    expect(idx.areas['13112'].city).toBe('世田谷区');
    expect(calls.length).toBe(2);
  });

  it('JSON でない応答・areas の無い JSON は「形が不正」で reject する', async () => {
    const html = stubFetch(() => new Response('<!doctype html><title>404</title>', { status: 200 }));
    await expect(loadPlateauIndex({ url: INDEX_URL, fetchImpl: html.f })).rejects.toThrow(/PLATEAU の索引を読めません/);
    const broken = stubFetch(() => json({ generated: 'x' }));
    await expect(loadPlateauIndex({ url: INDEX_URL, fetchImpl: broken.f })).rejects.toThrow(/形が不正/);
    const arr = stubFetch(() => json({ urlPrefix: 'https://x/', areas: [] }));
    await expect(loadPlateauIndex({ url: INDEX_URL, fetchImpl: arr.f })).rejects.toThrow(/形が不正/);
  });

  it('url を省くと document の無い Node では相対 "plateau-index.json" を fetchImpl に渡す（落ちない）', async () => {
    expect(typeof document).toBe('undefined');
    const { f, calls } = stubFetch(() => json(miniIndex()));
    const idx = await loadPlateauIndex({ fetchImpl: f });
    expect(calls).toEqual(['plateau-index.json']);
    expect(idx.areas['23113'].ward).toBe('守山区');
  });

  it('URL オブジェクトも受け付け、文字列化してメモのキーにする', async () => {
    const { f, calls } = stubFetch(() => json(miniIndex()));
    await loadPlateauIndex({ url: new URL(INDEX_URL), fetchImpl: f });
    await loadPlateauIndex({ url: INDEX_URL, fetchImpl: f });
    expect(calls).toEqual([INDEX_URL]);
  });

  it('中止済みの signal では通信せずに signal.reason を投げる', async () => {
    const { f, calls } = stubFetch(() => json(miniIndex()));
    const ac = new AbortController();
    const reason = new Error('やめた');
    ac.abort(reason);
    await expect(loadPlateauIndex({ url: 'https://example.test/other.json', fetchImpl: f, signal: ac.signal })).rejects.toBe(reason);
    expect(calls).toEqual([]);
  });

  it('fetchImpl が永遠に返らない → timeoutMs で「索引を取得できません（期限切れ…）」の Error。失敗はメモに残らず次は取れる', async () => {
    let hang = true;
    const signals: AbortSignal[] = [];
    const { f, calls } = stubFetch((_url, init) => {
      if (!hang) return json(miniIndex());
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    });
    const url = 'https://example.test/hang.json';
    const t0 = performance.now();
    await expect(loadPlateauIndex({ url, fetchImpl: f, timeoutMs: 60 })).rejects.toThrow(/索引を取得できません.*期限切れ/);
    expect(performance.now() - t0).toBeLessThan(2000);
    // 下層の fetch に渡した signal は TimeoutError で abort されている（本物の fetch なら接続が切れる）
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    expect((signals[0].reason as Error).name).toBe('TimeoutError');
    hang = false;
    expect(Object.keys((await loadPlateauIndex({ url, fetchImpl: f, timeoutMs: 60 })).areas)).toHaveLength(3);
    expect(calls).toEqual([url, url]);
  });
});

describe('muniCodesAround: 中心＋4 隅の逆ジオコーダ', () => {
  const lat = 35.1932;
  const lon = 136.9545;
  const latOf = (url: string) => Number(new URL(url).searchParams.get('lat'));
  const lonOf = (url: string) => Number(new URL(url).searchParams.get('lon'));

  it('5 回 fetch し（中心が先頭・4 隅は degBoxAround の角）、同じコードは重複除去して 1 件にする', async () => {
    const { f, calls } = stubFetch((url) => (url.includes('LonLatToAddress') ? geocode('23113') : undefined));
    const codes = await muniCodesAround(lat, lon, 330, { fetchImpl: f });
    expect(codes).toEqual(['23113']);
    expect(calls.length).toBe(5);
    expect(calls[0]).toBe(REVERSE_GEOCODER_URL(lat, lon));
    const box = degBoxAround(lat, lon, 330);
    const corners = calls.slice(1).map((u) => [latOf(u), lonOf(u)]);
    expect(corners).toEqual(
      expect.arrayContaining([
        [box.south, box.west],
        [box.south, box.east],
        [box.north, box.west],
        [box.north, box.east],
      ]),
    );
    expect(new Set(calls).size).toBe(5);
  });

  it('区境: 中心が守山区（23113）・東側の隅が東区（23102）なら両方を中心から順に返す', async () => {
    const { f } = stubFetch((url) => (lonOf(url) < lon ? geocode('23102') : geocode('23113')));
    const codes = await muniCodesAround(lat, lon, 330, { fetchImpl: f });
    expect(codes).toEqual(['23113', '23102']);
  });

  it('fixture の応答（geocoder_nagoya_border.json）をそのまま返しても 23113 になる', async () => {
    const { f } = stubFetch(() => new Response(fixtureText('geocoder_nagoya_border.json'), { status: 200 }));
    expect(await muniCodesAround(lat, lon, 300, { fetchImpl: f })).toEqual(['23113']);
    const ok = stubFetch(() => new Response(fixtureText('geocoder_okusawa.json'), { status: 200 }));
    expect(await muniCodesAround(35.6019, 139.6736, 300, { fetchImpl: ok.f })).toEqual(['13112']);
  });

  it('1 件でも成功すれば返す（4 点が HTTP 500・通信失敗・results null でも）', async () => {
    let n = 0;
    const { f } = stubFetch(() => {
      n++;
      if (n === 1) return json({}, 500);
      if (n === 2) return undefined; // TypeError: fetch failed
      if (n === 3) return geocode(null); // 海上
      if (n === 4) return new Response('not json', { status: 200 });
      return geocode('13112');
    });
    expect(await muniCodesAround(35.6, 139.7, 300, { fetchImpl: f })).toEqual(['13112']);
  });

  it('全滅（通信失敗）なら日本語の Error を投げる', async () => {
    const { f, calls } = stubFetch(() => undefined);
    await expect(muniCodesAround(lat, lon, 300, { fetchImpl: f })).rejects.toThrow(/逆ジオコーダ.*通信エラー/);
    expect(calls.length).toBe(5);
  });

  it('全点が results null（海上）でも Error（市区町村が見つかりません）', async () => {
    const { f } = stubFetch(() => geocode(null));
    await expect(muniCodesAround(30, 140, 300, { fetchImpl: f })).rejects.toThrow(/市区町村が見つかりません/);
  });

  it('muniCd が 5 桁の数字でない応答は無視する', async () => {
    const { f } = stubFetch(() => json({ results: { muniCd: 13112, lv01Nm: 'x' } }));
    await expect(muniCodesAround(35.6, 139.7, 300, { fetchImpl: f })).rejects.toThrow(/市区町村が見つかりません/);
  });

  it('途中で中止されたら結果を畳まずに signal.reason を投げる', async () => {
    const ac = new AbortController();
    const reason = new Error('中止');
    const { f } = stubFetch(() => {
      ac.abort(reason);
      return geocode('13112');
    });
    await expect(muniCodesAround(35.6, 139.7, 300, { fetchImpl: f, signal: ac.signal })).rejects.toBe(reason);
    const pre = stubFetch(() => geocode('13112'));
    await expect(muniCodesAround(35.6, 139.7, 300, { fetchImpl: pre.f, signal: ac.signal })).rejects.toBe(reason);
    expect(pre.calls).toEqual([]);
  });
});

describe('muniCodesAround: 期限（timeoutMs。既定 PLATEAU_TIMEOUTS.geocode = 8 s）', () => {
  const never = () => new Promise<Response>(() => undefined);

  it('5 点とも無応答 → 期限切れを通信失敗に数えて Error（「期限切れ」を含む）。呼び出し側の signal は中止されない', async () => {
    const { f, calls } = stubFetch(() => never());
    const ac = new AbortController();
    const t0 = performance.now();
    await expect(muniCodesAround(35.6, 139.7, 300, { fetchImpl: f, timeoutMs: 60, signal: ac.signal })).rejects.toThrow(/逆ジオコーダ.*期限切れ/);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(calls).toHaveLength(5);
    expect(ac.signal.aborted).toBe(false);
  });

  it('1 点だけ無応答なら、期限の後に残りの 4 点の結果で返る（中心が先頭）', async () => {
    let n = 0;
    const { f } = stubFetch((url) => (url.includes('lat=35.6&lon=139.7') ? geocode('13112') : ++n === 1 ? never() : geocode('13111')));
    expect(await muniCodesAround(35.6, 139.7, 300, { fetchImpl: f, timeoutMs: 60 })).toEqual(['13112', '13111']);
  });

  it('timeoutMs が Infinity なら期限なし（即応するスタブでは普通に返る）。既定値は PLATEAU_TIMEOUTS.geocode', async () => {
    const { f } = stubFetch(() => geocode('13112'));
    expect(await muniCodesAround(35.6, 139.7, 300, { fetchImpl: f, timeoutMs: Infinity })).toEqual(['13112']);
    expect(PLATEAU_TIMEOUTS.geocode).toBe(8000);
  });
});

describe('deadlineSignal: 呼び出し側の signal と期限の合成（AbortSignal.any / timeout に依らない）', () => {
  it('期限が来たら TimeoutError で abort する（isTimeoutError true）。親は中止されない', async () => {
    const parent = new AbortController();
    const dl = deadlineSignal(parent.signal, 30);
    expect(dl.signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(dl.signal.aborted).toBe(true);
    expect((dl.signal.reason as Error).name).toBe('TimeoutError');
    expect(isTimeoutError(dl.signal.reason)).toBe(true);
    expect(String((dl.signal.reason as Error).message)).toMatch(/期限切れ/);
    expect(parent.signal.aborted).toBe(false);
    dl.dispose();
  });

  it('親が中止されたら親の reason で abort する（期限より先）。中止済みの親なら即 abort', () => {
    const parent = new AbortController();
    const reason = new Error('やめた');
    const dl = deadlineSignal(parent.signal, 10000);
    parent.abort(reason);
    expect(dl.signal.aborted).toBe(true);
    expect(dl.signal.reason).toBe(reason);
    expect(isTimeoutError(dl.signal.reason)).toBe(false);
    dl.dispose();
    const pre = deadlineSignal(parent.signal, 10000);
    expect(pre.signal.aborted).toBe(true);
    expect(pre.signal.reason).toBe(reason);
    pre.dispose();
  });

  it('dispose でタイマーが止まり、期限を過ぎても abort しない。親なし・期限なし（undefined / Infinity / 0）でも動く', async () => {
    const dl = deadlineSignal(undefined, 20);
    dl.dispose();
    await new Promise((r) => setTimeout(r, 60));
    expect(dl.signal.aborted).toBe(false);
    for (const ms of [undefined, Infinity, 0, -1, NaN]) {
      const d = deadlineSignal(undefined, ms);
      expect(d.signal.aborted).toBe(false);
      d.dispose();
    }
  });
});

describe('muniCodesByRegion: 索引の region による予備経路', () => {
  it('region を持たない索引（現行の index.mini.json）では []', () => {
    expect(muniCodesByRegion(miniIndex(), { west: 139.6, south: 35.5, east: 139.7, north: 35.7 })).toEqual([]);
  });

  it('region を持つ索引では box と交差する市区だけを返す（辺で接するものも含む）', () => {
    const idx = miniIndex();
    idx.areas['13112'].region = [139.60, 35.58, 139.69, 35.66]; // 世田谷区
    idx.areas['23102'].region = [136.90, 35.17, 136.96, 35.20]; // 名古屋市東区
    idx.areas['23113'].region = [136.95, 35.17, 137.05, 35.25]; // 名古屋市守山区
    expect(muniCodesByRegion(idx, degBoxAround(35.6019, 139.6736, 330))).toEqual(['13112']);
    expect(muniCodesByRegion(idx, degBoxAround(35.1932, 136.9545, 330)).sort()).toEqual(['23102', '23113']);
    expect(muniCodesByRegion(idx, degBoxAround(35.1835, 136.9330, 330))).toEqual(['23102']);
    expect(muniCodesByRegion(idx, { west: 136.96, south: 35.21, east: 136.97, north: 35.22 })).toEqual(['23113']);
    expect(muniCodesByRegion(idx, degBoxAround(35.9251, 139.4858, 330))).toEqual([]); // 川越（索引に無い）
  });

  it('壊れた region（要素不足・NaN）は無視する', () => {
    const idx = miniIndex();
    idx.areas['13112'].region = [139.6, 35.5] as unknown as [number, number, number, number];
    idx.areas['23102'].region = [NaN, 35.17, 136.96, 35.2];
    expect(muniCodesByRegion(idx, { west: 100, south: 20, east: 150, north: 50 })).toEqual([]);
  });
});

describe('public/plateau-index.json（実物）の region（W16: scripts/plateau-index.mjs が -latest ラッパーから付ける）', () => {
  const realText = readFileSync(new URL('../public/plateau-index.json', import.meta.url), 'utf8');
  const real = JSON.parse(realText) as PlateauIndex;
  const areas = Object.entries(real.areas);

  it('448 市区・300 KB 以下・region は度の [west, south, east, north] で日本の範囲内', () => {
    expect(areas.length).toBeGreaterThanOrEqual(440);
    expect(realText.length).toBeLessThanOrEqual(300 * 1024);
    for (const [cd, a] of areas) {
      if (!a.region) continue;
      const [w, s, e, n] = a.region;
      expect(a.region, cd).toHaveLength(4);
      expect(w < e && s < n, `${cd} の region の向き`).toBe(true);
      expect(w >= 122 && e <= 154 && s >= 20 && n <= 46, `${cd} の region が日本の範囲外`).toBe(true);
    }
  });

  it('すべての市区が region を持つ（-latest ラッパーに無い浜松市の旧 7 区 22131〜22137 は索引の tileset.json の root.region から）', () => {
    const without = areas.filter(([, a]) => !a.region).map(([cd]) => cd);
    expect(without).toEqual([]);
    for (const cd of ['22131', '22132', '22133', '22134', '22135', '22136', '22137']) expect(real.areas[cd].region, cd).toBeDefined();
  });

  it('市区町村コードの改編: 浜松駅（34.7108, 137.7261。逆ジオコーダは新コード 22138 を返し索引に無い）の箱 → region で旧 中区 22131 が引ける', () => {
    expect(real.areas['22138']).toBeUndefined();
    const codes = muniCodesByRegion(real, degBoxAround(34.7108, 137.7261, 330));
    expect(codes).toContain('22131');
    expect(codes.every((cd) => /^2213[1-7]$/.test(cd))).toBe(true);
    const [w, s, e, n] = real.areas['22131'].region!;
    expect(w < 137.7261 && 137.7261 < e && s < 34.7108 && 34.7108 < n).toBe(true);
  });

  it('実地点の予備経路: 奥沢 → 世田谷区、区境 → 守山区と東区、川越・長野の山村 → 索引に無い市区は返さない', () => {
    // 区の bbox は隣の区と重なるので「含む」で見る（fetch.ts は pickDataset で各市区を試し、葉が箱に掛からない市区は datasets に入らない）
    expect(muniCodesByRegion(real, degBoxAround(35.6019, 139.6736, 330))).toContain('13112');
    const border = muniCodesByRegion(real, degBoxAround(35.1932, 136.9545, 330));
    expect(border).toContain('23113');
    expect(border).toContain('23102');
    expect(muniCodesByRegion(real, degBoxAround(35.1835, 136.933, 330))).toContain('23102');
    expect(muniCodesByRegion(real, degBoxAround(35.9251, 139.4858, 330))).not.toContain('11201');
    expect(muniCodesByRegion(real, degBoxAround(35.7898, 137.4633, 330))).not.toContain('20429');
    // 世田谷区の region は奥沢を含み、名古屋の 2 区は含まない
    const [w, s, e, n] = real.areas['13112'].region!;
    expect(w < 139.6736 && 139.6736 < e && s < 35.6019 && 35.6019 < n).toBe(true);
    expect(muniCodesByRegion(real, degBoxAround(35.6019, 139.6736, 330))).not.toContain('23113');
  });
});

describe('pickDataset: 市区のデータセット選択', () => {
  const idx = miniIndex();

  it("13112 は LOD2・テクスチャ無し・2025・label '東京都世田谷区・2025年度・LOD2'、tilesetUrl は urlPrefix + url", () => {
    const d = pickDataset(idx, '13112');
    expect(d).not.toBeNull();
    expect(d!.lod).toBe(2);
    expect(d!.tex).toBe(false);
    expect(d!.year).toBe(2025);
    expect(d!.label).toBe('東京都世田谷区・2025年度・LOD2');
    expect(d!.muniCd).toBe('13112');
    expect(d!.pref).toBe('東京都');
    expect(d!.city).toBe('世田谷区');
    expect(d!.ward).toBeNull();
    expect(d!.tilesetUrl).toBe(
      'https://assets.cms.plateau.reearth.io/assets/1a/57c9bb-cbed-47c0-be15-bbe662eabce4/13112_setagaya-ku_pref_2025_citygml_1_op_bldg_3dtiles_13112_setagaya-ku_lod2_no_texture/tileset.json',
    );
  });

  it("23113 は LOD1（テクスチャあり しか無い）・label '愛知県名古屋市守山区・2022年度・LOD1'", () => {
    const d = pickDataset(idx, '23113')!;
    expect(d.lod).toBe(1);
    expect(d.tex).toBe(true);
    expect(d.ward).toBe('守山区');
    expect(d.label).toBe('愛知県名古屋市守山区・2022年度・LOD1');
    expect(d.tilesetUrl).toMatch(/^https:\/\/assets\.cms\.plateau\.reearth\.io\/assets\/42\/.*23113_moriyama-ku_lod1\/tileset\.json$/);
  });

  it("23102 は LOD2 テクスチャ無し・label '愛知県名古屋市東区・2022年度・LOD2'", () => {
    const d = pickDataset(idx, '23102')!;
    expect(d.lod).toBe(2);
    expect(d.tex).toBe(false);
    expect(d.label).toBe('愛知県名古屋市東区・2022年度・LOD2');
  });

  it('索引に無い市区（11201 川越）・sets が空の市区は null', () => {
    expect(pickDataset(idx, '11201')).toBeNull();
    const empty: PlateauIndex = { ...idx, areas: { '99999': { pref: 'x', city: 'y', ward: null, year: 2020, sets: [] } } };
    expect(pickDataset(empty, '99999')).toBeNull();
  });

  it('sets の順が乱れていても LOD 降順・同 LOD はテクスチャ無し先で選ぶ（元の配列は変えない）', () => {
    const sets = [
      { lod: 1, tex: true, url: 'a/lod1/tileset.json', size: 1 },
      { lod: 2, tex: true, url: 'b/lod2/tileset.json', size: 2 },
      { lod: 2, tex: false, url: 'c/lod2nt/tileset.json', size: 3 },
      { lod: 3, tex: true, url: 'd/lod3/tileset.json', size: 4 },
    ];
    const i2: PlateauIndex = { ...idx, areas: { '00000': { pref: 'P', city: 'C', ward: 'W', year: 2024, sets } } };
    const d = pickDataset(i2, '00000')!;
    expect(d.lod).toBe(3);
    expect(d.tilesetUrl).toBe(idx.urlPrefix + 'd/lod3/tileset.json');
    expect(d.label).toBe('PCW・2024年度・LOD3');
    expect(sets.map((s) => s.url)).toEqual(['a/lod1/tileset.json', 'b/lod2/tileset.json', 'c/lod2nt/tileset.json', 'd/lod3/tileset.json']);
    sets.pop();
    expect(pickDataset(i2, '00000')!.tilesetUrl).toBe(idx.urlPrefix + 'c/lod2nt/tileset.json');
  });

  it('url が絶対 URL なら urlPrefix を前置しない', () => {
    const i3: PlateauIndex = { ...idx, areas: { '00001': { pref: 'P', city: 'C', ward: null, year: 2024, sets: [{ lod: 1, tex: false, url: 'https://other.test/t/tileset.json', size: null }] } } };
    expect(pickDataset(i3, '00001')!.tilesetUrl).toBe('https://other.test/t/tileset.json');
  });
});

describe('resolveTilesetUrl: -latest エイリアス → 索引 URL', () => {
  const idx = miniIndex();
  const ds = pickDataset(idx, '13112')!;
  const LATEST = PLATEAU_LATEST_URL('13112', 2, false);
  const REAL = 'https://assets.cms.plateau.reearth.io/assets/1a/57c9bb-cbed-47c0-be15-bbe662eabce4/13112_setagaya-ku_pref_2025_citygml_1_op_bldg_3dtiles_13112_setagaya-ku_lod2_no_texture/tileset.json';

  it('PLATEAU_LATEST_URL の形（muniCd-bldg-lodN-notexture|texture-latest）', () => {
    expect(LATEST).toBe('https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13112-bldg-lod2-notexture-latest/tileset.json');
    expect(PLATEAU_LATEST_URL('23113', 1, true)).toBe('https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/23113-bldg-lod1-texture-latest/tileset.json');
  });

  it('ラッパー fixture（latest_13112_lod2nt.json）から children[0].content.uri を返す（via latest・missing false）', async () => {
    const { f, calls } = stubFetch((url) => (url === LATEST ? new Response(fixtureText('latest_13112_lod2nt.json')) : undefined));
    const r = await resolveTilesetUrl(ds, { fetchImpl: f });
    expect(r).toEqual({ url: REAL, via: 'latest', missing: false });
    expect(calls).toEqual([LATEST]);
  });

  it('索引の URL が古くても -latest の URL が優先される', async () => {
    const stale = { ...ds, tilesetUrl: 'https://assets.cms.plateau.reearth.io/assets/old/old/tileset.json' };
    const { f } = stubFetch(() => new Response(fixtureText('latest_13112_lod2nt.json')));
    expect((await resolveTilesetUrl(stale, { fetchImpl: f })).url).toBe(REAL);
  });

  it('latest_missing.json（200 で children 無し）→ missing true、url は索引のもの', async () => {
    const { f } = stubFetch(() => new Response(fixtureText('latest_missing.json')));
    const r = await resolveTilesetUrl(ds, { fetchImpl: f });
    expect(r.missing).toBe(true);
    expect(r.via).toBe('latest');
    expect(r.url).toBe(ds.tilesetUrl);
    const emptyChildren = stubFetch(() => json({ root: { refine: 'ADD', children: [] } }));
    expect((await resolveTilesetUrl(ds, { fetchImpl: emptyChildren.f })).missing).toBe(true);
  });

  it('-latest が HTTP 500・通信失敗・JSON でない → 索引 URL に退避（via index・missing false）', async () => {
    const r500 = stubFetch(() => json({}, 500));
    expect(await resolveTilesetUrl(ds, { fetchImpl: r500.f })).toEqual({ url: ds.tilesetUrl, via: 'index', missing: false });
    const net = stubFetch(() => undefined);
    expect(await resolveTilesetUrl(ds, { fetchImpl: net.f })).toEqual({ url: ds.tilesetUrl, via: 'index', missing: false });
    const html = stubFetch(() => new Response('<html>', { status: 200 }));
    expect(await resolveTilesetUrl(ds, { fetchImpl: html.f })).toEqual({ url: ds.tilesetUrl, via: 'index', missing: false });
    const r404 = stubFetch(() => json({ message: 'not found' }, 404));
    expect((await resolveTilesetUrl(ds, { fetchImpl: r404.f })).via).toBe('index');
  });

  it('content.uri が相対なら -latest の URL 基準で絶対化、3D Tiles 0.0 の content.url も読む', async () => {
    const rel = stubFetch(() => json({ root: { children: [{ content: { uri: '../real/tileset.json' } }] } }));
    expect((await resolveTilesetUrl(ds, { fetchImpl: rel.f })).url).toBe('https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/real/tileset.json');
    const old = stubFetch(() => json({ root: { children: [{ content: { url: REAL } }] } }));
    expect(await resolveTilesetUrl(ds, { fetchImpl: old.f })).toEqual({ url: REAL, via: 'latest', missing: false });
    const noUri = stubFetch(() => json({ root: { children: [{ content: {} }] } }));
    expect(await resolveTilesetUrl(ds, { fetchImpl: noUri.f })).toEqual({ url: ds.tilesetUrl, via: 'index', missing: false });
  });

  it('守山区 LOD1 は texture 側の -latest を引く（ds.tex に従う）', async () => {
    const d = pickDataset(idx, '23113')!;
    const { f, calls } = stubFetch(() => json({ root: { children: [{ content: { uri: 'https://assets.cms.plateau.reearth.io/assets/new/23113/tileset.json' } }] } }));
    const r = await resolveTilesetUrl(d, { fetchImpl: f });
    expect(calls).toEqual([PLATEAU_LATEST_URL('23113', 1, true)]);
    expect(r.url).toBe('https://assets.cms.plateau.reearth.io/assets/new/23113/tileset.json');
  });

  it('中止は索引 URL に畳まず signal.reason を投げる', async () => {
    const ac = new AbortController();
    const reason = new Error('中止');
    const { f } = stubFetch(() => {
      ac.abort(reason);
      throw reason;
    });
    await expect(resolveTilesetUrl(ds, { fetchImpl: f, signal: ac.signal })).rejects.toBe(reason);
    const pre = stubFetch(() => json({}));
    await expect(resolveTilesetUrl(ds, { fetchImpl: pre.f, signal: ac.signal })).rejects.toBe(reason);
    expect(pre.calls).toEqual([]);
  });

  it('-latest が無応答 → timeoutMs（既定 PLATEAU_TIMEOUTS.latest = 8 s）で索引 URL に退避（via index・missing false）。呼び出し側の signal は中止されない', async () => {
    const signals: AbortSignal[] = [];
    const { f } = stubFetch((_url, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    });
    const ac = new AbortController();
    const t0 = performance.now();
    expect(await resolveTilesetUrl(ds, { fetchImpl: f, timeoutMs: 60, signal: ac.signal })).toEqual({ url: REAL, via: 'index', missing: false });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(ac.signal.aborted).toBe(false);
    expect(signals[0].aborted).toBe(true);
    expect((signals[0].reason as Error).name).toBe('TimeoutError');
    expect(PLATEAU_TIMEOUTS.latest).toBe(8000);
  });
});
