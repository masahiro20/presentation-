// 周辺建物の開示（PLATEAU の出典行・形状の内訳・高さのプリセット・レポートの出典）: src/sunstudy/disclosure.ts と report.ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlateauAttrs, PlateauDatasetInfo } from '../src/sun/plateau';
import {
  countBySource,
  disclosureLines,
  measuredHeightPreset,
  neighborDisclosure,
  plateauAttribution,
  plateauDisclosureText,
  plateauShapeCounts,
  plateauShapeOf,
  plateauShapeText,
  plateauSourceLabels,
  plateauSourceTag,
  sourcesLine,
} from '../src/sunstudy/disclosure';
import { buildReportHtml } from '../src/sunstudy/report';
import { study } from '../src/sunstudy/state';
import type { Neighbor } from '../src/sunstudy/types';

const square = (e0: number, n0: number, size: number) => [
  { e: e0, n: n0 },
  { e: e0 + size, n: n0 },
  { e: e0 + size, n: n0 + size },
  { e: e0, n: n0 + size },
];
const nb = (id: string, ring: { e: number; n: number }[], extra: Partial<Neighbor> = {}): Neighbor => ({ id, ring, height: 7, source: 'gsi', heightKind: 'estimated', ...extra });

const SETAGAYA: PlateauDatasetInfo = { muniCd: '13112', pref: '東京都', city: '世田谷区', ward: null, year: 2025, lod: 2, tex: false, tilesetUrl: 'https://example/13112/tileset.json', label: '東京都世田谷区・2025年度・LOD2' };
const MORIYAMA: PlateauDatasetInfo = { muniCd: '23113', pref: '愛知県', city: '名古屋市', ward: '守山区', year: 2022, lod: 1, tex: false, tilesetUrl: 'https://example/23113/tileset.json', label: '愛知県名古屋市守山区・2022年度・LOD1' };

const attrs = (over: Partial<PlateauAttrs> = {}): PlateauAttrs => ({
  gmlId: 'bldg_x',
  lod: 1,
  datasetLod: 2,
  year: 2025,
  muniCd: '13112',
  pref: '東京都',
  city: '世田谷区',
  ward: null,
  anchor: { lat: 35.6, lon: 139.6 },
  zmin: 30,
  zmax: 36.6,
  footprint: 'bottom',
  ...over,
});
/** 屋根 2 三角形 + 壁 1 三角形の小さな mesh（形は見ない） */
const mesh = (roofTriangles: number) => ({ tris: new Float32Array(27), roofTriangles });

function resetStudy() {
  study.frame = { lat: 35.6, lon: 139.6, address: 'テスト', groundElev: 10 };
  study.sitePolygon = [];
  study.model = null;
  study.points = [];
  study.grid = null;
  study.aerial = null;
  study.horizon = null;
  study.neighborOverrides = {};
  study.results = { images: [] };
  study.neighborNotes = [];
  study.neighborSources = [];
  study.env = { loaded: true, loading: false, error: null, attribution: '' };
  study.neighbors = [];
}

describe('plateauShapeOf / plateauShapeCounts: 屋根形状（LOD2 以上）と箱形（LOD1）', () => {
  it('lod ≥ 2 は屋根形状、1 は箱形。lod が無ければデータセットの LOD。屋根の三角形が無い mesh は箱形。PLATEAU でなければ null', () => {
    expect(plateauShapeOf({ plateau: attrs({ lod: 2 }), mesh: mesh(4) })).toBe('roof');
    expect(plateauShapeOf({ plateau: attrs({ lod: 1 }), mesh: mesh(2) })).toBe('box');
    expect(plateauShapeOf({ plateau: attrs({ lod: null, datasetLod: 2 }) })).toBe('roof');
    expect(plateauShapeOf({ plateau: attrs({ lod: null, datasetLod: 1 }) })).toBe('box');
    expect(plateauShapeOf({ plateau: attrs({ lod: 3 }), mesh: mesh(0) })).toBe('box');
    expect(plateauShapeOf({})).toBeNull();
  });

  it('内訳: PLATEAU の建物だけを数え、属性の無い旧形式の建物は other。文は「屋根形状あり N・箱形 M」', () => {
    const list: Neighbor[] = [
      nb('a', square(0, 0, 5), { source: 'plateau', heightKind: 'measured', plateau: attrs({ lod: 2 }), mesh: mesh(6) }),
      nb('b', square(10, 0, 5), { source: 'plateau', heightKind: 'measured', plateau: attrs({ lod: 1 }), mesh: mesh(2) }),
      nb('c', square(20, 0, 5), { source: 'plateau', heightKind: 'measured', plateau: attrs({ lod: 1 }) }),
      nb('d', square(30, 0, 5), { source: 'plateau', heightKind: 'measured' }),
      nb('e', square(40, 0, 5)),
    ];
    const c = plateauShapeCounts(list);
    expect(c).toEqual({ plateau: 4, roof: 1, box: 2, other: 1 });
    expect(plateauShapeText(c)).toBe('屋根形状あり 1・箱形 2');
    // 旧形式（属性なし）だけなら「実測 N」、PLATEAU が無ければ null
    expect(plateauShapeText(plateauShapeCounts([list[3]]))).toBe('実測 1');
    expect(plateauShapeText(plateauShapeCounts([list[4]]))).toBeNull();
  });
});

describe('出典の文（データセットから）', () => {
  it('タグ・3D 画面の出典行・出典一覧・共通の開示文', () => {
    expect(plateauSourceTag([SETAGAYA])).toBe('PLATEAU 2025・世田谷区・実測');
    expect(plateauSourceTag([MORIYAMA, SETAGAYA])).toBe('PLATEAU 2022／2025・守山区／世田谷区・実測');
    expect(plateauSourceTag([])).toBe('PLATEAU・実測の高さ');
    expect(plateauAttribution([SETAGAYA])).toBe('周辺建物: PLATEAU（国土交通省 3D都市モデル）東京都世田谷区・2025年度・LOD2');
    expect(plateauAttribution([])).toBe('周辺建物: PLATEAU（国土交通省 3D都市モデル）');
    expect(plateauSourceLabels([SETAGAYA, MORIYAMA])).toEqual(['PLATEAU（国土交通省 3D都市モデル・東京都世田谷区・2025年度・LOD2）', 'PLATEAU（国土交通省 3D都市モデル・愛知県名古屋市守山区・2022年度・LOD1）']);
    expect(plateauSourceLabels([])).toEqual(['PLATEAU（国土交通省 3D都市モデル・実測の高さ・形状）']);
    expect(plateauDisclosureText([SETAGAYA])).toBe('周辺建物の形状・高さ: 国土交通省 PLATEAU 3D都市モデル（世田谷区・2025年度・LOD2）。年度以降の新築・解体は反映されていない場合があります。');
    expect(plateauDisclosureText([MORIYAMA])).toBe(
      '周辺建物の形状・高さ: 国土交通省 PLATEAU 3D都市モデル（守山区・2022年度・LOD1）。LOD1 の建物は箱形で天端は点群の中央値（最高高さは建物クリックで確認・適用できます）。年度以降の新築・解体は反映されていない場合があります。',
    );
    expect(plateauDisclosureText([])).toMatch(/^周辺建物の形状・高さ: 国土交通省 PLATEAU 3D都市モデル。LOD1 の建物は箱形/);
  });

  it('sourcesLine: 「周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）401 棟・国土地理院（推定）6 棟」。想定の家は数えない', () => {
    const list: Neighbor[] = [
      ...Array.from({ length: 3 }, (_, i) => nb(`p${i}`, square(i * 10, 0, 5), { source: 'plateau', heightKind: 'measured', plateau: attrs() })),
      nb('g1', square(0, 20, 5)),
      nb('g2', square(10, 20, 5)),
      nb('m1', square(0, 40, 5), { source: 'manual', heightKind: 'manual' }),
      nb('pl', square(0, 60, 5), { source: 'manual', heightKind: 'manual', planned: { width: 5, depth: 5 } as unknown as Neighbor['planned'] }),
    ];
    const counts = countBySource(list);
    expect(counts).toEqual([
      { source: 'plateau', count: 3, estimated: false },
      { source: 'gsi', count: 2, estimated: true },
      { source: 'manual', count: 1, estimated: false },
    ]);
    expect(sourcesLine(counts, [SETAGAYA])).toBe('周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）3 棟・国土地理院（推定）2 棟・手入力 1 棟');
    expect(sourcesLine(counts, [])).toBe('周辺建物の出典: PLATEAU（国土交通省）3 棟・国土地理院（推定）2 棟・手入力 1 棟');
    expect(sourcesLine([], [SETAGAYA])).toBeNull();
  });

  it('measuredHeightPreset: 実測の最高高さが 0.5 m 以上違うときだけ', () => {
    expect(measuredHeightPreset({ height: 6.6, plateau: attrs({ measuredHeight: 7.6 }) })).toEqual({ label: '最高高さに合わせる (7.6 m)', value: 7.6 });
    expect(measuredHeightPreset({ height: 7.4, plateau: attrs({ measuredHeight: 7.6 }) })).toBeNull();
    expect(measuredHeightPreset({ height: 6.6, plateau: attrs() })).toBeNull();
    expect(measuredHeightPreset({ height: 6.6, plateau: attrs({ measuredHeight: Number.NaN }) })).toBeNull();
    expect(measuredHeightPreset({ height: 6.6 })).toBeNull();
  });
});

describe('disclosureLines / レポート: 出典の行', () => {
  beforeEach(resetStudy);

  it('自動取得をしたときだけ「周辺建物の出典」の行が最後に付く（手動の隣家だけなら従来の行のみ）', () => {
    study.neighbors = [nb('m1', square(0, 40, 5), { source: 'manual', heightKind: 'manual' })];
    expect(disclosureLines({ disclosure: neighborDisclosure(null) })).toEqual(['周辺建物の扱い: 計算から除外した周辺建物 なし']);
    study.neighbors = [
      nb('p1', square(0, 0, 5), { source: 'plateau', heightKind: 'measured', plateau: attrs() }),
      nb('p2', square(10, 0, 5), { source: 'plateau', heightKind: 'measured', plateau: attrs(), hidden: true, hideMode: 'exclude', hideReason: 'demolish' }),
      nb('g1', square(0, 20, 5)),
    ];
    study.neighborSources = ['plateau', 'gsi'];
    study.env.plateau = { datasets: [SETAGAYA], indexGenerated: '2026-10-10' };
    // 計算から除外した p2 は出典の棟数に入らない
    expect(disclosureLines({ disclosure: neighborDisclosure(null) })).toEqual([
      '周辺建物の扱い: 計算から除外した周辺建物 1 棟（解体予定 1）',
      '周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2）1 棟・国土地理院（推定）1 棟',
    ]);
    // 旧形式の保存データ（env.plateau が無い）でも崩れない
    delete study.env.plateau;
    expect(disclosureLines({ disclosure: neighborDisclosure(null) })[1]).toBe('周辺建物の出典: PLATEAU（国土交通省）1 棟・国土地理院（推定）1 棟');
  });

  it('レポート: 出典の ul に plateauDatasetLabel の行、前提・注意に共通の開示文、結果のページの注記に出典の行', () => {
    study.neighbors = [nb('p1', square(0, 0, 5), { source: 'plateau', heightKind: 'measured', plateau: attrs({ lod: 1 }) }), nb('g1', square(0, 20, 5))];
    study.neighborSources = ['plateau', 'gsi'];
    study.env.plateau = { datasets: [SETAGAYA, MORIYAMA], indexGenerated: '2026-10-10' };
    study.results.heatmapUrl = 'data:image/png;base64,AA==';
    const html = buildReportHtml();
    expect(html).toContain('<li>PLATEAU（国土交通省 3D都市モデル・東京都世田谷区・2025年度・LOD2）<span class="tag measured">実測の高さ</span></li>');
    expect(html).toContain('<li>PLATEAU（国土交通省 3D都市モデル・愛知県名古屋市守山区・2022年度・LOD1）<span class="tag measured">実測の高さ</span></li>');
    expect(html).toContain('<li>国土地理院 地図データ（建物の種類から高さを推定）<span class="tag estimated">高さは推定</span></li>');
    expect(html).toContain('周辺建物の形状・高さ: 国土交通省 PLATEAU 3D都市モデル（世田谷区・2025年度・LOD2／守山区・2022年度・LOD1）。LOD1 の建物は箱形');
    expect(html).toContain('周辺建物の出典: PLATEAU（世田谷区・2025年度・LOD2／守山区・2022年度・LOD1）1 棟・国土地理院（推定）1 棟');
    // PLATEAU を使っていなければ共通の開示文は無い
    study.neighborSources = ['gsi'];
    delete study.env.plateau;
    expect(buildReportHtml()).not.toContain('周辺建物の形状・高さ: 国土交通省 PLATEAU');
  });
});
