// 日照ツールの PLATEAU アダプタ（src/sunstudy/plateauNeighbors.ts）: Neighbor 変換・注記の固定文・進捗文・クリック情報・到達判定の高さ・
// 上書きの引き継ぎ（足元の照合）・平行移動量
import { describe, expect, it } from 'vitest';
import type { PlateauDatasetInfo, PlateauFetchResult } from '../src/sun/plateau';
import { plateauRegionAddedNote } from '../src/sun/context';
import { ringCenter } from '../src/sun/footprint';
import { plateauInfoLines, plateauNoteCounts, plateauNotes, plateauOffset, plateauProgressText, plateauToNeighbor, reachHeight, rekeyOverridesByFootprint } from '../src/sunstudy/plateauNeighbors';
import { frameFromLocal, frameToLocal } from '../src/sunstudy/types';
import type { Neighbor, NeighborOverride } from '../src/sunstudy/types';
import { plateauBox, plateauNeighborAt } from './helpers/plateauBox';

const PIN = { lat: 35.6, lon: 139.6 };
type Covered = Extract<PlateauFetchResult, { status: 'covered' }>;

const square = (e0: number, n0: number, size: number) => [
  { e: e0, n: n0 },
  { e: e0 + size, n: n0 },
  { e: e0 + size, n: n0 + size },
  { e: e0, n: n0 + size },
];

const DS_MORIYAMA: PlateauDatasetInfo = { muniCd: '23113', pref: '愛知県', city: '名古屋市', ward: '守山区', year: 2022, lod: 1, tex: true, tilesetUrl: 'https://x/23113/tileset.json', label: '愛知県名古屋市守山区・2022年度・LOD1' };
const DS_SETAGAYA: PlateauDatasetInfo = { muniCd: '13112', pref: '東京都', city: '世田谷区', ward: null, year: 2025, lod: 2, tex: false, tilesetUrl: 'https://x/13112/tileset.json', label: '東京都世田谷区・2025年度・LOD2' };

/** covered の結果を手作りする（buildings は棟数分の箱） */
function covered(n: number, datasets: PlateauDatasetInfo[], extra: Partial<Covered> = {}): Covered {
  const buildings = Array.from({ length: n }, (_, i) => plateauBox({ gmlId: `bldg_${i}`, anchor: PIN }));
  return { status: 'covered', buildings, datasets, tiles: [{ url: 'https://x/data0.b3dm', bytes: 1000, buildings: n, ms: 1 }], failedTiles: 0, truncated: false, lodCounts: { '1': n }, missingMuniCds: [], ...extra };
}

describe('plateauToNeighbor: anchor 基準 → ピン基準', () => {
  it('id は plateau:gml_id、source plateau・heightKind measured、height は round1(zmax − zmin)、ring/holes は平行移動、mesh は共有参照、label = usage', () => {
    const anchor = frameFromLocal(PIN, 20, -10);
    const b = plateauBox({ gmlId: 'bldg_abc', anchor, w: 10, d: 8, h: 6.66, zmin: 57.2, holes: [square(-2, -2, 2)], attrs: { usage: '住宅', name: '〇〇ビル' } });
    const ringBefore = JSON.stringify(b.ring);
    const n = plateauToNeighbor(b, PIN);
    expect(n.id).toBe('plateau:bldg_abc');
    expect(n.source).toBe('plateau');
    expect(n.heightKind).toBe('measured');
    expect(n.height).toBe(6.7);
    expect(n.label).toBe('住宅');
    const c = ringCenter(n.ring);
    expect(c.e).toBeCloseTo(20, 6);
    expect(c.n).toBeCloseTo(-10, 6);
    expect(n.holes).toHaveLength(1);
    expect(ringCenter(n.holes![0]).e).toBeCloseTo(20 - 1, 6);
    expect(ringCenter(n.holes![0]).n).toBeCloseTo(-10 - 1, 6);
    // mesh は anchor 基準のまま同じオブジェクト、属性は写し（anchor も）、元の ring は書き換えない
    expect(n.mesh).toBe(b.mesh);
    expect(n.plateau).toEqual(b.attrs);
    expect(n.plateau).not.toBe(b.attrs);
    expect(n.plateau!.anchor).not.toBe(b.attrs.anchor);
    expect(JSON.stringify(b.ring)).toBe(ringBefore);
  });
  it('label は usage が無ければ name、どちらも無ければ無し。穴が無ければ holes も無し。高さの下限 0.1', () => {
    const byName = plateauToNeighbor(plateauBox({ anchor: PIN, attrs: { name: '〇〇ビル' } }), PIN);
    expect(byName.label).toBe('〇〇ビル');
    const none = plateauToNeighbor(plateauBox({ anchor: PIN }), PIN);
    expect('label' in none).toBe(false);
    expect('holes' in none).toBe(false);
    expect(plateauToNeighbor({ ...plateauBox({ anchor: PIN }), height: 0.01 }, PIN).height).toBe(0.1);
  });
  it('ピンを 40 m 動かしても id は同じで、ring だけ逆向きにずれる（mesh は不変）', () => {
    const b = plateauBox({ gmlId: 'bldg_1', anchor: frameFromLocal(PIN, 30, 5) });
    const a = plateauToNeighbor(b, PIN);
    const pinB = frameFromLocal(PIN, 40, 0);
    const z = plateauToNeighbor(b, pinB);
    expect(z.id).toBe(a.id);
    expect(ringCenter(z.ring).e).toBeCloseTo(ringCenter(a.ring).e - 40, 3);
    expect(ringCenter(z.ring).n).toBeCloseTo(ringCenter(a.ring).n, 3);
    expect(z.mesh).toBe(a.mesh);
    const off = plateauOffset(z, pinB);
    expect(off.e).toBeCloseTo(-10, 3);
    expect(off.n).toBeCloseTo(5, 3);
    expect(plateauOffset({ id: 'g', ring: [], height: 1, source: 'gsi', heightKind: 'estimated' }, PIN)).toEqual({ e: 0, n: 0 });
    expect(frameToLocal(pinB, b.attrs.anchor)).toEqual(off);
  });
});

/** 一覧に残った建物（注記の棟数はこれで数える）: PLATEAU n 棟（lod2 棟は LOD2・屋根あり）＋ 国土地理院 gsi 棟 */
function kept(n: number, o: { lod2?: number; gsi?: number; mesh?: boolean } = {}): Neighbor[] {
  const list: Neighbor[] = Array.from({ length: n }, (_, i) => {
    const lod: 1 | 2 = i < (o.lod2 ?? 0) ? 2 : 1;
    const nb = plateauNeighborAt(PIN, 20 * i, 0, { gmlId: `k_${i}`, attrs: { lod, datasetLod: lod } });
    if (o.mesh === false) delete nb.mesh;
    return nb;
  });
  for (let i = 0; i < (o.gsi ?? 0); i++) list.push({ id: `gsi:${i}`, ring: square(-30 - 10 * i, 0, 6), height: 7, source: 'gsi', heightKind: 'estimated' });
  return list;
}

describe('plateauNotes: 注記の固定文', () => {
  it('LOD1 のデータセット: 「箱形。天端は点群の中央値」', () => {
    const notes = plateauNotes(covered(6, [DS_MORIYAMA]), kept(6));
    expect(notes).toEqual(['PLATEAU（国土交通省 3D都市モデル・愛知県名古屋市守山区・2022年度・LOD1）の実測の高さ・形状を使用（6 棟を取得。箱形。天端は点群の中央値）。']);
    expect(notes[0]).toMatch(/^PLATEAU（国土交通省 3D都市モデル・愛知県名古屋市守山区・2022年度・LOD1）の実測の高さ・形状を使用（\d+ 棟/);
  });
  it('LOD2 のデータセット: 屋根形状あり（lod ≥ 2）と箱形の内訳。国土地理院で補った棟数の行', () => {
    const notes = plateauNotes(covered(5, [DS_SETAGAYA], { lodCounts: { '1': 3, '2': 2 } }), kept(5, { lod2: 2, gsi: 3 }));
    expect(notes).toEqual([
      'PLATEAU（国土交通省 3D都市モデル・東京都世田谷区・2025年度・LOD2）の実測の高さ・形状を使用（5 棟を取得。屋根形状あり 2 棟・箱形 3 棟）。',
      '国土地理院の地図から 3 棟を補いました（高さは建物の種類から推定）。',
    ]);
  });
  it('距離ルールで落ちた棟は注記に数えない: 棟数・屋根形状あり／箱形・補った棟数はすべて一覧に残った建物で数える（取得全体の lodCounts ではない）', () => {
    // 取得は 1509 棟（うち LOD2 が 10 棟）だが、一覧に残ったのは PLATEAU 386 棟（屋根形状あり 2）＋ 国土地理院 6 棟
    const r = covered(1509, [DS_SETAGAYA], { lodCounts: { '1': 1499, '2': 10 } });
    const list = kept(386, { lod2: 2, gsi: 6 });
    expect(plateauNotes(r, list)).toEqual([
      'PLATEAU（国土交通省 3D都市モデル・東京都世田谷区・2025年度・LOD2）の実測の高さ・形状を使用（386 棟を取得。屋根形状あり 2 棟・箱形 384 棟）。',
      '国土地理院の地図から 6 棟を補いました（高さは建物の種類から推定）。',
    ]);
    // 内訳は disclosure.ts の plateauShapeCounts と同じ規則: lod ?? datasetLod が 2 以上で屋根形状。mesh の roofTriangles が 0 なら箱形、mesh が無ければ lod だけで判定
    expect(plateauNoteCounts(list)).toEqual({ plateau: 386, roof: 2, box: 384, gsi: 6, est: 0 });
    const flatRoof = kept(3, { lod2: 3 }).map((n) => ({ ...n, mesh: { tris: n.mesh!.tris, roofTriangles: 0 } }));
    expect(plateauNoteCounts(flatRoof)).toEqual({ plateau: 3, roof: 0, box: 3, gsi: 0, est: 0 });
    expect(plateauNoteCounts(kept(3, { lod2: 1, mesh: false }))).toEqual({ plateau: 3, roof: 1, box: 2, gsi: 0, est: 0 });
    // lod が無ければデータセットの LOD で判定（旧データ）
    const byDataset = kept(2).map((n) => ({ ...n, plateau: { ...n.plateau!, lod: null, datasetLod: 2 } }));
    expect(plateauNoteCounts(byDataset).roof).toBe(2);
    // 一覧に PLATEAU が 1 棟も残らなければ 0 棟（補完だけ）
    expect(plateauNotes(covered(6, [DS_MORIYAMA]), kept(0, { gsi: 2 }))[0]).toContain('使用（0 棟を取得。箱形');
  });
  it('一部のタイル失敗・上限で捨てた・隣の市区が未整備の行。区境の 2 データセットは名前を「／」でつなぐ', () => {
    const r = covered(4, [DS_MORIYAMA, DS_SETAGAYA], { failedTiles: 2, truncated: true, missingMuniCds: ['11201'], tiles: [{ url: 'a', bytes: 1, buildings: 2, ms: 1 }, { url: 'b', bytes: 1, buildings: 2, ms: 1 }], lodCounts: { '1': 4 } });
    const notes = plateauNotes(r, kept(4));
    expect(notes[0]).toBe('PLATEAU（国土交通省 3D都市モデル・愛知県名古屋市守山区・2022年度・LOD1／東京都世田谷区・2025年度・LOD2）の実測の高さ・形状を使用（4 棟を取得。屋根形状あり 0 棟・箱形 4 棟）。');
    expect(notes[1]).toBe('PLATEAU の建物タイル 4 枚のうち 2 枚を取得できなかったため、建物が欠けている可能性があります。');
    expect(notes[2]).toBe('遠方の建物の一部は取得していません（データ量の上限）。');
    expect(notes[3]).toMatch(/^隣接する市区（市区町村コード 11201）は PLATEAU が未整備のため/);
    expect(notes).toHaveLength(4);
  });
  it('市区町村コードの改編の救済（regionAdded）は末尾の行に。文はプレゼン側（plateauCoveredNotes）と同じ', () => {
    // 逆ジオコーダは 22138（索引に無い）、索引の region で守山区を足した例。missingMuniCds は空なので未整備の行は出ない
    const r = covered(3, [DS_MORIYAMA], { regionAdded: ['23113'] });
    const notes = plateauNotes(r, kept(3));
    expect(notes).toEqual([
      'PLATEAU（国土交通省 3D都市モデル・愛知県名古屋市守山区・2022年度・LOD1）の実測の高さ・形状を使用（3 棟を取得。箱形。天端は点群の中央値）。',
      '市区町村コードの改編のため、位置の重なる PLATEAU（愛知県名古屋市守山区・2022年度・LOD1）で補いました。',
    ]);
    expect(notes[1]).toBe(plateauRegionAddedNote([DS_MORIYAMA], ['23113']));
    // 足した市区の tileset が取れず datasets に無ければ市区町村コードで示す
    expect(plateauNotes(covered(3, [DS_SETAGAYA], { regionAdded: ['23113'] }), kept(3))[1]).toBe('市区町村コードの改編のため、位置の重なる PLATEAU（市区町村コード 23113）で補いました。');
    // regionAdded が無ければ行は増えない
    expect(plateauNotes(covered(3, [DS_MORIYAMA], { regionAdded: [] }), kept(3))).toHaveLength(1);
  });
});

describe('plateauProgressText', () => {
  const p = (stage: 'tiles' | 'merge' | 'geocode', message: string) => ({ stage, message, done: 3, total: 6, bytes: 8.1 * 1048576, totalBytes: null, ratio: 0.5 });
  it('「周辺建物（PLATEAU・データセット）: 文」。データセットが無ければ省く。統合の段の文はそのまま', () => {
    expect(plateauProgressText(p('tiles', '建物タイル 3/6（8.1 MB）'), '東京都世田谷区・2025年度・LOD2')).toBe('周辺建物（PLATEAU・東京都世田谷区・2025年度・LOD2）: 建物タイル 3/6（8.1 MB）');
    expect(plateauProgressText(p('geocode', '市区町村を調べています'))).toBe('周辺建物（PLATEAU）: 市区町村を調べています');
    expect(plateauProgressText(p('merge', '周辺建物を統合しています…'), 'x')).toBe('周辺建物を統合しています…');
  });
});

describe('plateauInfoLines: クリック情報の行', () => {
  it('出典・実測の最高高さ／モデルの高さ・所在・地盤 T.P.／地形 T.P.・建物 ID', () => {
    const n = plateauNeighborAt(PIN, 10, 0, { gmlId: 'bldg_7', h: 6.6, zmin: 57.2, attrs: { measuredHeight: 7.6, storeys: 2, usage: '住宅', address: '愛知県名古屋市守山区小幡', buildingId: '23113-bldg-1' } });
    n.baseElev = 56.9;
    expect(plateauInfoLines(n)).toEqual([
      '出典: PLATEAU 愛知県名古屋市守山区・2022年度・LOD1（箱形）',
      '実測の最高高さ 7.6 m・2 階・住宅／モデルの高さ 6.6 m',
      '所在: 愛知県名古屋市守山区小幡',
      'PLATEAU 地盤 T.P. 57.2 m／地形 T.P. 56.9 m',
      '建物 ID 23113-bldg-1（gml_id bldg_7）',
    ]);
  });
  it('属性が少ない建物・LOD2・警告。PLATEAU でなければ空', () => {
    const n = plateauNeighborAt(PIN, 10, 0, { gmlId: 'bldg_8', h: 9, zmin: 30, attrs: { lod: 2, datasetLod: 2, pref: '東京都', city: '世田谷区', ward: null, year: 2025, name: '〇〇マンション', warnings: ['noBottom'] } });
    const lines = plateauInfoLines(n);
    expect(lines[0]).toBe('出典: PLATEAU 東京都世田谷区・2025年度・LOD2（屋根形状）');
    expect(lines[1]).toBe('モデルの高さ 9.0 m');
    expect(lines).toContain('名称: 〇〇マンション');
    expect(lines).toContain('PLATEAU 地盤 T.P. 30.0 m');
    expect(lines).toContain('gml_id bldg_8');
    expect(lines.at(-1)).toMatch(/^注意: /);
    expect(plateauInfoLines({ id: 'g', ring: square(0, 0, 1), height: 7, source: 'gsi', heightKind: 'estimated' })).toEqual([]);
  });
});

describe('reachHeight: 影の到達判定の高さ', () => {
  it('max(height, measuredHeight)。PLATEAU でなければ height', () => {
    const n = plateauNeighborAt(PIN, 0, 0, { h: 6.6, attrs: { measuredHeight: 7.6 } });
    expect(reachHeight(n)).toBe(7.6);
    expect(reachHeight({ ...n, height: 12 })).toBe(12);
    expect(reachHeight({ id: 'g', ring: square(0, 0, 1), height: 7, source: 'gsi', heightKind: 'estimated' })).toBe(7);
    expect(reachHeight(plateauNeighborAt(PIN, 0, 0, { h: 5 }))).toBe(5);
  });
});

describe('rekeyOverridesByFootprint: 年度更新で変わった id への上書きの引き継ぎ', () => {
  const nb = (id: string, ring: { e: number; n: number }[]): Pick<Neighbor, 'id' | 'ring'> => ({ id, ring });
  const prev = [nb('plateau:old', square(10, 10, 8)), nb('plateau:old2', square(100, 100, 8)), nb('plateau:keep', square(-50, -50, 8)), nb('gsi:x', square(-30, 0, 6)), nb('plateau:busy', square(40, -40, 8))];
  const next = [nb('plateau:new', square(10.5, 10.2, 8)), nb('plateau:big', square(100, 100, 20)), nb('plateau:keep', square(-50, -50, 8)), nb('gsi:x', square(-30, 0, 6)), nb('plateau:busyNew', square(40, -40, 8)), nb('plateau:far', square(300, 300, 8))];
  const overrides: Record<string, NeighborOverride> = {
    'plateau:old': { height: 9, hidden: true, hideMode: 'view', hideReason: 'other' },
    'plateau:old2': { hidden: true, hideMode: 'exclude', hideReason: 'demolish' },
    'plateau:keep': { height: 3 },
    'gsi:x': { height: 4 },
    'manual:1': { height: 2 },
    'plateau:busy': { height: 11 },
    'plateau:busyNew': { height: 12 },
  };
  it('同じ足元（面積比 0.6〜1/0.6・重心が互いの内側）の新 id へ移す。面積が大きく違う建物・無関係な建物には移さない。元は変えない', () => {
    const before = JSON.stringify(overrides);
    const out = rekeyOverridesByFootprint(prev, next, overrides);
    expect(JSON.stringify(overrides)).toBe(before);
    // old → new（半 m ずれた同じ大きさ）
    expect(out['plateau:new']).toEqual({ height: 9, hidden: true, hideMode: 'view', hideReason: 'other' });
    expect(out['plateau:old']).toBeUndefined();
    // old2 の足元は big の 1/6 の面積: 移さず残す
    expect(out['plateau:old2']).toEqual(overrides['plateau:old2']);
    expect(out['plateau:big']).toBeUndefined();
    // 新一覧にある id・prev に無い id（手動）はそのまま
    expect(out['plateau:keep']).toEqual({ height: 3 });
    expect(out['gsi:x']).toEqual({ height: 4 });
    expect(out['manual:1']).toEqual({ height: 2 });
    // 移し先が既に上書きを持っていれば上書きしない（busy は残り、busyNew は元のまま）
    expect(out['plateau:busy']).toEqual({ height: 11 });
    expect(out['plateau:busyNew']).toEqual({ height: 12 });
    expect(out['plateau:far']).toBeUndefined();
  });
  it('移す対象が無ければ写しをそのまま返す。1 つの新しい建物に 2 つの旧 id は移さない', () => {
    const same = rekeyOverridesByFootprint(prev, prev, overrides);
    expect(same).toEqual(overrides);
    expect(same).not.toBe(overrides);
    const two = rekeyOverridesByFootprint([nb('a', square(0, 0, 8)), nb('b', square(0.3, 0.3, 8))], [nb('c', square(0.1, 0.1, 8))], { a: { height: 5 }, b: { height: 6 } });
    expect(two.c).toEqual({ height: 5 });
    expect(two.a).toBeUndefined();
    expect(two.b).toEqual({ height: 6 });
  });
});

describe('推定の屋根（roofEstimate）の注記・情報', () => {
  const est = { kind: 'hip' as const, eave: 5.8, ridge: 7.8, boxHeight: 6.8 };
  it('箱形の内数として est を数え、注記に「うち推定の屋根 N 棟」と説明の行が出る', () => {
    const list = kept(5);
    for (let i = 0; i < 3; i++) list[i] = { ...list[i], plateau: { ...list[i].plateau!, roofEstimate: est } };
    expect(plateauNoteCounts(list)).toMatchObject({ plateau: 5, box: 5, est: 3 });
    const notes = plateauNotes(covered(5, [DS_MORIYAMA]), list);
    expect(notes.some((t) => /うち推定の屋根 3 棟/.test(t) || t.startsWith('推定の屋根:'))).toBe(true);
    expect(notes.find((t) => t.startsWith('推定の屋根:'))).toMatch(/3 棟/);
  });
  it('推定の屋根が無ければ説明の行は出ない', () => {
    expect(plateauNotes(covered(5, [DS_MORIYAMA]), kept(5)).some((t) => t.startsWith('推定の屋根'))).toBe(false);
  });
});
