/**
 * tileset.json の解釈と葉の選択（src/sun/plateau/tileset.ts）のテスト。ネットワークは使わない。
 *  - 実 tileset（名古屋市東区 LOD2・守山区 LOD1）: 木の形、REPLACE では葉だけ、区境 35.1932,136.9545 ±300 m → data0/7/8/12
 *  - 手書き mini（奥沢の値を模す）: 高さスパン規則・refine の継承・ADD で全 content・box/transform/外部 .json の warnings
 *  - maxTiles 超過で遠い葉から捨て truncated、壊れた tileset の日本語 Error
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTileset, selectContentTiles, type ContentTile, type ParsedTileset, type TileNode } from '../src/sun/plateau/tileset';
import { degBoxAround } from '../src/sun/geodesy';
import { metersPerDegree } from '../src/sun/geo';
import type { GeoBox } from '../src/sun/plateau/types';

const fixtureJson = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/plateau/${name}`, import.meta.url), 'utf8'));

/** fetch.ts と同じ既定（spec §2.9） */
const DEFAULTS = { nearM: 150, reachFactor: 6.9, reachMargin: 60, maxTiles: 16 };
const TILESET_URL = 'https://assets.cms.plateau.reearth.io/assets/xx/yy/23102_higashi-ku_lod2_no_texture/tileset.json';

/** content URL の末尾（data0 など） */
const names = (tiles: ContentTile[]) => tiles.map((t) => /([^/]+)\.b3dm$/.exec(t.url)![1]);

/** 木を数える（ノード数・葉数・最大深さ） */
function countTree(root: TileNode) {
  let nodes = 0;
  let leaves = 0;
  let maxDepth = 0;
  const walk = (t: TileNode) => {
    nodes++;
    if (t.children.length === 0) leaves++;
    maxDepth = Math.max(maxDepth, t.depth);
    t.children.forEach(walk);
  };
  walk(root);
  return { nodes, leaves, maxDepth };
}

describe('parseTileset: 実 tileset（PLATEAU bldg 3D Tiles）', () => {
  const ts = parseTileset(fixtureJson('23102_lod2nt_tileset.json'), TILESET_URL);

  it('名古屋市東区 LOD2: 56 ノード・葉 40・深さ 3、REPLACE、warnings 0（spec §0 の実測）', () => {
    expect(ts.warnings).toEqual([]);
    expect(countTree(ts.root)).toEqual({ nodes: 56, leaves: 40, maxDepth: 3 });
    expect(ts.root.depth).toBe(0);
    expect(ts.root.refine).toBe('REPLACE');
    expect(ts.root.geometricError).toBeCloseTo(288.4, 1);
  });

  it('全ノードに content があり、tilesetUrl 基準の絶対 URL になっている', () => {
    const urls: string[] = [];
    const walk = (t: TileNode) => {
      expect(t.contentUri).not.toBeNull();
      urls.push(t.contentUri!);
      t.children.forEach(walk);
    };
    walk(ts.root);
    expect(ts.root.contentUri).toBe('https://assets.cms.plateau.reearth.io/assets/xx/yy/23102_higashi-ku_lod2_no_texture/data/data55.b3dm');
    expect(urls.every((u) => u.startsWith('https://assets.cms.plateau.reearth.io/assets/xx/yy/23102_higashi-ku_lod2_no_texture/data/'))).toBe(true);
    expect(new Set(urls).size).toBe(56);
  });

  it('region はラジアン・m のまま（root ≈ 東区の範囲、minH < maxH）、子の深さは親 + 1', () => {
    const r = ts.root.region;
    const DEG = 180 / Math.PI;
    expect(r.west * DEG).toBeCloseTo(136.9073, 3);
    expect(r.north * DEG).toBeCloseTo(35.1987, 3);
    expect(r.minH).toBeLessThan(r.maxH);
    expect(r.maxH - r.minH).toBeCloseTo(168.6, 0);
    for (const c of ts.root.children) {
      expect(c.depth).toBe(1);
      expect(c.refine).toBe('REPLACE');
    }
  });

  it('守山区 LOD1: 170 ノード・葉 119・深さ 4、warnings 0', () => {
    const m = parseTileset(fixtureJson('23113_lod1_tileset.json'), 'https://example.test/23113/tileset.json');
    expect(m.warnings).toEqual([]);
    expect(countTree(m.root)).toEqual({ nodes: 170, leaves: 119, maxDepth: 4 });
  });
});

describe('selectContentTiles: 実 tileset で区境 35.1932,136.9545 ±300 m', () => {
  const ts = parseTileset(fixtureJson('23102_lod2nt_tileset.json'), TILESET_URL);
  const lat = 35.1932;
  const lon = 136.9545;
  const box = degBoxAround(lat, lon, 300);

  it('葉 data0/7/8/12 だけ（内部ノード data1/11/17/55 は返さない）、近い順、truncated=false', () => {
    const { tiles, truncated } = selectContentTiles(ts, box, { lat, lon, ...DEFAULTS });
    expect(names(tiles)).toEqual(['data0', 'data8', 'data12', 'data7']);
    expect([...names(tiles)].sort()).toEqual(['data0', 'data12', 'data7', 'data8']);
    expect(truncated).toBe(false);
    for (const t of tiles) {
      expect(t.leaf).toBe(true);
      expect(t.depth).toBe(3);
      expect(t.heightSpanM).toBeGreaterThan(0);
    }
    // 距離（spec §0 の実測: data0 は内側で 0、data8 188 m、data12 342 m、data7 355 m）
    expect(tiles[0].distanceM).toBe(0);
    expect(tiles[1].distanceM).toBeCloseTo(188.3, 0);
    expect(tiles[2].distanceM).toBeCloseTo(341.8, 0);
    expect(tiles[3].distanceM).toBeCloseTo(355.4, 0);
  });

  it('data7（355 m・スパン 43 m）は高さスパン規則で残る: 355 − 43 × 6.9 < 60。reachFactor を 0 にすると 150 m 超の葉は全部落ちる', () => {
    const d7 = selectContentTiles(ts, box, { lat, lon, ...DEFAULTS }).tiles.find((t) => t.url.endsWith('data7.b3dm'))!;
    expect(d7.distanceM - d7.heightSpanM * 6.9).toBeLessThan(60);
    expect(d7.distanceM).toBeGreaterThan(150);
    const strict = selectContentTiles(ts, box, { lat, lon, ...DEFAULTS, reachFactor: 0 });
    expect(names(strict.tiles)).toEqual(['data0']);
  });

  it('maxTiles 2 → 近い data0/data8 だけ残り truncated=true。maxTiles 0 → 空で truncated=true', () => {
    const r2 = selectContentTiles(ts, box, { lat, lon, ...DEFAULTS, maxTiles: 2 });
    expect(names(r2.tiles)).toEqual(['data0', 'data8']);
    expect(r2.truncated).toBe(true);
    const r0 = selectContentTiles(ts, box, { lat, lon, ...DEFAULTS, maxTiles: 0 });
    expect(r0.tiles).toEqual([]);
    expect(r0.truncated).toBe(true);
  });

  it('±110 m（プレゼンの半径）では data0 だけ、箱が東区の外（東京）なら 0 枚', () => {
    const near = selectContentTiles(ts, degBoxAround(lat, lon, 110), { lat, lon, ...DEFAULTS });
    expect(names(near.tiles)).toEqual(['data0']);
    const tokyo = selectContentTiles(ts, degBoxAround(35.6019, 139.6736, 300), { lat: 35.6019, lon: 139.6736, ...DEFAULTS });
    expect(tokyo.tiles).toEqual([]);
    expect(tokyo.truncated).toBe(false);
  });

  it('東区 筒井 35.1835,136.9330 ±300 m は葉 2 枚（E2E 地点 2 の期待値）', () => {
    const p = { lat: 35.1835, lon: 136.933 };
    const r = selectContentTiles(ts, degBoxAround(p.lat, p.lon, 300), { ...p, ...DEFAULTS });
    expect(r.tiles.length).toBe(2);
    expect(r.tiles.every((t) => t.leaf)).toBe(true);
  });
});

describe('mini tileset（手書き・奥沢の値を模す）', () => {
  const OKUSAWA = { lat: 35.6019, lon: 139.6736 };
  const MINI_URL = 'https://example.test/mini/tileset.json';
  const box = degBoxAround(OKUSAWA.lat, OKUSAWA.lon, 300);
  const raw = fixtureJson('mini_tileset.json');
  const ts = parseTileset(raw, MINI_URL);

  it('box ボリューム・transform・外部 .json の 3 枝が warnings に出て捨てられる（残る木は root → a → a1/a2）', () => {
    expect(ts.warnings).toHaveLength(3);
    expect(ts.warnings[0]).toMatch(/root\.children\[1\].*region ではない.*box/);
    expect(ts.warnings[1]).toMatch(/root\.children\[2\].*transform/);
    expect(ts.warnings[2]).toMatch(/root\.children\[3\].*外部 tileset.*sub\/tileset\.json/);
    expect(countTree(ts.root)).toEqual({ nodes: 4, leaves: 2, maxDepth: 2 });
    expect(ts.root.children).toHaveLength(1);
    const a = ts.root.children[0];
    expect(a.contentUri).toBe('https://example.test/mini/data/a.b3dm');
    expect(a.children.map((c) => c.contentUri)).toEqual(['https://example.test/mini/data/a1.b3dm', 'https://example.test/mini/data/a2.b3dm']);
    // refine は親から継承（a・a1・a2 には書いていない）
    expect(a.refine).toBe('REPLACE');
    expect(a.children.every((c) => c.refine === 'REPLACE')).toBe(true);
  });

  it('高さスパン規則: 距離 311 m・スパン 19 m の葉 a1 は落ち、距離 160 m・スパン 25 m の葉 a2 は残る', () => {
    const { tiles, truncated } = selectContentTiles(ts, box, { ...OKUSAWA, ...DEFAULTS });
    expect(names(tiles)).toEqual(['a2']);
    expect(truncated).toBe(false);
    expect(tiles[0].distanceM).toBeCloseTo(160, 0);
    expect(tiles[0].heightSpanM).toBeCloseTo(25, 6);
    expect(tiles[0].leaf).toBe(true);
    expect(tiles[0].depth).toBe(2);
    // a1 は箱と交差するが（東 220〜500 m・北 220〜500 m）、311 − 19 × 6.9 = 180 ≥ 60 で落ちる
    const loose = selectContentTiles(ts, box, { ...OKUSAWA, ...DEFAULTS, reachMargin: 200 });
    expect(names(loose.tiles)).toEqual(['a2', 'a1']);
    expect(loose.tiles[1].distanceM).toBeCloseTo(Math.hypot(220, 220), 0);
    expect(loose.tiles[1].heightSpanM).toBeCloseTo(19, 6);
    // nearM を 400 にしても両方残る（距離だけで読む側）
    expect(names(selectContentTiles(ts, box, { ...OKUSAWA, ...DEFAULTS, nearM: 400 }).tiles)).toEqual(['a2', 'a1']);
  });

  it('捨てた枝の content（box の子 b1・transform の c・外部 d）は、箱の内側にあっても選ばれない', () => {
    const all = selectContentTiles(ts, box, { ...OKUSAWA, nearM: 1e9, reachFactor: 0, reachMargin: 0, maxTiles: 99 });
    const got = names(all.tiles);
    expect(got).not.toContain('b1');
    expect(got).not.toContain('box');
    expect(got).not.toContain('c');
    expect(got).toEqual(['a2', 'a1']);
  });

  it('ADD refine では交差する全 content（root・a・a2。a1 は規則で落ちる）、距離順で内側のものは深い方が先', () => {
    const addJson = structuredClone(raw) as { root: { refine: string } };
    addJson.root.refine = 'ADD';
    const add = parseTileset(addJson, MINI_URL);
    expect(add.root.refine).toBe('ADD');
    expect(add.root.children[0].refine).toBe('ADD');
    const { tiles, truncated } = selectContentTiles(add, box, { ...OKUSAWA, ...DEFAULTS });
    expect(names(tiles)).toEqual(['a', 'root', 'a2']);
    expect(truncated).toBe(false);
    expect(tiles[0].leaf).toBe(false);
    expect(tiles[0].distanceM).toBe(0);
    expect(tiles[2].leaf).toBe(true);
    // maxTiles 超過は遠い方（a2）から捨てる
    const cut = selectContentTiles(add, box, { ...OKUSAWA, ...DEFAULTS, maxTiles: 2 });
    expect(names(cut.tiles)).toEqual(['a', 'root']);
    expect(cut.truncated).toBe(true);
  });

  it('ADD と REPLACE が混在: root が ADD・a が REPLACE なら root の content と葉 a2 だけ', () => {
    const mixed = structuredClone(raw) as { root: { refine: string; children: { refine?: string }[] } };
    mixed.root.refine = 'ADD';
    mixed.root.children[0].refine = 'replace'; // 小文字でも読む
    const ts2 = parseTileset(mixed, MINI_URL);
    expect(ts2.root.children[0].refine).toBe('REPLACE');
    expect(names(selectContentTiles(ts2, box, { ...OKUSAWA, ...DEFAULTS }).tiles)).toEqual(['root', 'a2']);
  });

  it('箱が葉と交差しなければ 0 枚（REPLACE では root・a の content は読まない。箱は root の内側）', () => {
    const far: GeoBox = degBoxAround(OKUSAWA.lat + 0.02, OKUSAWA.lon, 300);
    const r = selectContentTiles(ts, far, { lat: OKUSAWA.lat + 0.02, lon: OKUSAWA.lon, ...DEFAULTS });
    expect(r.tiles).toEqual([]);
    // ADD なら箱と交差する root の content だけ
    const addJson = structuredClone(raw) as { root: { refine: string } };
    addJson.root.refine = 'ADD';
    expect(names(selectContentTiles(parseTileset(addJson, MINI_URL), far, { lat: OKUSAWA.lat + 0.02, lon: OKUSAWA.lon, ...DEFAULTS }).tiles)).toEqual(['root']);
  });

  it('親の region からはみ出した葉も拾う（PLATEAU の tileset は子が親に含まれない: 東区 data12 が実例）', () => {
    // a の region（±600 m）の外、東 700〜900 m に葉 a3 を足す。親で刈ると落ちるが、葉自身の region で判定するので拾える
    const RAD = Math.PI / 180;
    const { mLat, mLon } = metersPerDegree(OKUSAWA.lat);
    const j = structuredClone(raw) as { root: { children: { children: unknown[] }[] } };
    j.root.children[0].children.push({
      boundingVolume: { region: [(OKUSAWA.lon + 700 / mLon) * RAD, (OKUSAWA.lat - 50 / mLat) * RAD, (OKUSAWA.lon + 900 / mLon) * RAD, (OKUSAWA.lat + 50 / mLat) * RAD, 36, 50] },
      geometricError: 0,
      content: { uri: 'data/a3.b3dm' },
    });
    const ts3 = parseTileset(j, MINI_URL);
    const r = selectContentTiles(ts3, degBoxAround(OKUSAWA.lat, OKUSAWA.lon, 800), { ...OKUSAWA, nearM: 1e9, reachFactor: 0, reachMargin: 0, maxTiles: 16 });
    expect(names(r.tiles)).toEqual(['a2', 'a1', 'a3']);
    expect(r.tiles[2].distanceM).toBeCloseTo(700, 0);
  });
});

describe('parseTileset: 手作りの JSON（境界・互換・エラー）', () => {
  const RAD = Math.PI / 180;
  /** 度の矩形 → region 配列（ラジアン） */
  const reg = (west: number, south: number, east: number, north: number, minH = 0, maxH = 10) => ({ region: [west * RAD, south * RAD, east * RAD, north * RAD, minH, maxH] });

  it('root が無い・root が box → 日本語の Error', () => {
    expect(() => parseTileset({}, 'https://x/tileset.json')).toThrow(/tileset\.json ではありません/);
    expect(() => parseTileset(null, 'https://x/tileset.json')).toThrow(/tileset\.json ではありません/);
    expect(() => parseTileset({ root: { boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, geometricError: 1 } }, 'https://x/tileset.json')).toThrow(/root が使えません.*box/);
    expect(() => parseTileset({ root: { boundingVolume: reg(0, 0, 1, 1), transform: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } }, 'https://x/tileset.json')).toThrow(/root が使えません.*transform/);
  });

  it('refine 無しの root は REPLACE、geometricError 無しは 0、content 無しの葉は選ばれない、単位行列の transform は捨てない', () => {
    const ts = parseTileset(
      {
        root: {
          boundingVolume: reg(139, 35, 140, 36),
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          children: [
            { boundingVolume: reg(139.4, 35.4, 139.6, 35.6), content: { uri: 'a.b3dm' } },
            { boundingVolume: reg(139.6, 35.4, 139.8, 35.6) },
          ],
        },
      },
      'https://x/t/tileset.json',
    );
    expect(ts.warnings).toEqual([]);
    expect(ts.root.refine).toBe('REPLACE');
    expect(ts.root.geometricError).toBe(0);
    expect(ts.root.contentUri).toBeNull();
    const r = selectContentTiles(ts, { west: 139, south: 35, east: 140, north: 36 }, { lat: 35.5, lon: 139.5, nearM: 1e9, reachFactor: 0, reachMargin: 0, maxTiles: 16 });
    expect(r.tiles.map((t) => t.url)).toEqual(['https://x/t/a.b3dm']);
  });

  it('content.url（3D Tiles 0.0 の名残）・uri に ? が付く・tilesetUrl が相対パスでも URL を組める', () => {
    const ts = parseTileset(
      {
        root: {
          boundingVolume: reg(139, 35, 140, 36),
          refine: 'ADD',
          content: { url: 'data/root.b3dm?v=2' },
          children: [{ boundingVolume: reg(139, 35, 140, 36), content: { uri: './data/leaf.b3dm' } }],
        },
      },
      'tiles/23113/tileset.json',
    );
    expect(ts.root.contentUri).toBe('tiles/23113/data/root.b3dm?v=2');
    expect(ts.root.children[0].contentUri).toBe('tiles/23113/data/leaf.b3dm');
    // 絶対 URL の content はそのまま
    const abs = parseTileset({ root: { boundingVolume: reg(0, 0, 1, 1), content: { uri: 'https://cdn.test/x.b3dm' } } }, 'tileset.json');
    expect(abs.root.contentUri).toBe('https://cdn.test/x.b3dm');
  });

  it('implicitTiling・region の壊れた値・uri の無い content・未知の refine は warnings に出る', () => {
    const ts = parseTileset(
      {
        root: {
          boundingVolume: reg(139, 35, 140, 36),
          refine: 'MERGE',
          content: { boundingVolume: {} },
          children: [
            { boundingVolume: reg(139, 35, 140, 36), implicitTiling: { subdivisionScheme: 'QUADTREE' }, content: { uri: 'x.b3dm' } },
            { boundingVolume: { region: [0, 0, 1] }, content: { uri: 'y.b3dm' } },
            { boundingVolume: reg(139.5, 35.5, 139.6, 35.6), content: { uri: 'z.b3dm' } },
          ],
        },
      },
      'https://x/tileset.json',
    );
    expect(ts.root.refine).toBe('REPLACE');
    expect(ts.root.contentUri).toBeNull();
    expect(ts.root.children).toHaveLength(1);
    expect(ts.root.children[0].contentUri).toBe('https://x/z.b3dm');
    expect(ts.warnings.join('\n')).toMatch(/refine 'MERGE'/);
    expect(ts.warnings.join('\n')).toMatch(/uri がありません/);
    expect(ts.warnings.join('\n')).toMatch(/implicitTiling/);
    expect(ts.warnings.join('\n')).toMatch(/children\[1\].*region が不正/);
  });

  it('同じ content URL が 2 ノードにあっても 1 回だけ、距離が同じなら深い方が先', () => {
    const ts: ParsedTileset = parseTileset(
      {
        root: {
          boundingVolume: reg(139, 35, 140, 36),
          refine: 'ADD',
          content: { uri: 'dup.b3dm' },
          children: [
            { boundingVolume: reg(139, 35, 140, 36), content: { uri: 'dup.b3dm' } },
            { boundingVolume: reg(139, 35, 140, 36), content: { uri: 'deep.b3dm' } },
          ],
        },
      },
      'https://x/tileset.json',
    );
    const r = selectContentTiles(ts, { west: 139, south: 35, east: 140, north: 36 }, { lat: 35.5, lon: 139.5, ...DEFAULTS });
    expect(r.tiles.map((t) => t.url)).toEqual(['https://x/deep.b3dm', 'https://x/dup.b3dm']);
    expect(r.tiles.every((t) => t.distanceM === 0)).toBe(true);
  });

  it('距離は degBoxDistanceM と同じ換算（点の緯度の metersPerDegree）', () => {
    const lat = 35;
    const lon = 139;
    const { mLon } = metersPerDegree(lat);
    const dLon = 500 / mLon; // 東 500 m から始まる葉
    const ts = parseTileset({ root: { boundingVolume: reg(lon + dLon, lat - 0.01, lon + dLon * 2, lat + 0.01, 0, 100) } }, 'https://x/tileset.json');
    const r = selectContentTiles({ root: { ...ts.root, contentUri: 'https://x/e.b3dm' }, warnings: [] }, degBoxAround(lat, lon, 600), { lat, lon, nearM: 150, reachFactor: 6.9, reachMargin: 60, maxTiles: 16 });
    expect(r.tiles).toHaveLength(1);
    expect(r.tiles[0].distanceM).toBeCloseTo(500, 6);
    expect(r.tiles[0].heightSpanM).toBe(100);
  });
});
