/**
 * 日照ステップ（プレゼン側）の UI の判定ロジックのテスト。DOM 無しで動く純粋な部分だけ:
 *  - 2 点合わせ・敷地をクリックの共通のクリック判定（CLICK_PX）
 *  - 2 つの角の最小距離（MIN_PAIR_DIST_M、標準の日照ツールと同じ）と文言
 *  - 建物の角を拾う対象（見えているグループだけ）と external 判定
 *  - 配置の状態の文言（自動で合わせられなかったときは「未調整」）
 *  - 解析結果の無効化（撮影済みの季節比較画像も捨てる）
 *  - 資料の注記（3DS で解析しているときだけ）
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ALIGN_COLORS, MIN_PAIR_DIST_M, TWO_POINT_CANCEL_HINT, TWO_POINT_STEPS } from '../src/sun/align';
import { CLICK_PX, TOO_CLOSE_MSG, descendsFrom, isClick, pairTooClose, pickRoots, placementStateText, twoPointStepText } from '../src/app/steps/sunExternal';
import { IMAGES_CLEARED_MSG, clearedSunResults } from '../src/app/steps/sunStep';
import { SUN_EXTERNAL_CAPTION, sunCaption } from '../src/app/steps/presentStep';

describe('クリックとドラッグの判定（2 点合わせ・敷地をクリックで共通）', () => {
  it('CLICK_PX（3 px）以内の移動はクリック、それより大きければドラッグ', () => {
    expect(CLICK_PX).toBe(3);
    expect(isClick({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(true);
    expect(isClick({ x: 100, y: 100 }, { x: 102, y: 102 })).toBe(true); // √8 ≈ 2.83
    expect(isClick({ x: 100, y: 100 }, { x: 103, y: 100 })).toBe(true); // ちょうど 3
    expect(isClick({ x: 100, y: 100 }, { x: 103, y: 101 })).toBe(false); // √10 ≈ 3.16
    expect(isClick({ x: 100, y: 100 }, { x: 140, y: 100 })).toBe(false);
  });
});

describe('2 点合わせの最小距離（標準の日照ツールと同じ 0.5 m）', () => {
  it('MIN_PAIR_DIST_M より近い 2 点は近すぎる（吸着で同じ角の別の頂点に付いた 2 cm など）', () => {
    expect(MIN_PAIR_DIST_M).toBe(0.5);
    expect(pairTooClose({ e: 0, n: 0 }, { e: 0.02, n: 0 })).toBe(true);
    expect(pairTooClose({ e: 0, n: 0 }, { e: 0.3, n: 0.3 })).toBe(true); // 0.42 m
    expect(pairTooClose({ e: 0, n: 0 }, { e: 0.5, n: 0 })).toBe(false); // ちょうど 0.5 m は可
    expect(pairTooClose({ e: -4.55, n: -3.64 }, { e: 4.55, n: 3.64 })).toBe(false);
  });
  it('文言は共通の定数の値を含む', () => {
    expect(TOO_CLOSE_MSG).toBe('2 つの角が近すぎます（0.5 m 以上離れた角を選んでください）');
  });
});

describe('2 点合わせの手順の文言・色（両アプリ共通の定数）', () => {
  it('段階 0..3 の文言は共通の TWO_POINT_STEPS に中止の案内を添えたもの', () => {
    for (let i = 0; i < 4; i++) {
      expect(twoPointStepText(i)).toContain(TWO_POINT_STEPS[i]);
      expect(twoPointStepText(i)).toContain(TWO_POINT_CANCEL_HINT);
    }
    expect(twoPointStepText(0)).toContain('1 つ目の角');
    expect(twoPointStepText(2)).toContain('2 つ目の角');
    expect(twoPointStepText(1)).toContain('航空写真');
    // 範囲外でも落ちない
    expect(twoPointStepText(9)).toContain(TWO_POINT_STEPS[3]);
  });
  it('マーカーの色は建物が青・航空写真が橙', () => {
    expect(ALIGN_COLORS.model).toBe('#1f6fd0');
    expect(ALIGN_COLORS.target).toBe('#e5531f');
  });
});

describe('建物の角を拾う対象（見えているグループだけ）', () => {
  const groupWithMesh = (name: string, visible = true) => {
    const g = new THREE.Group();
    g.name = name;
    g.visible = visible;
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    return g;
  };
  it('置き換え中（PDF の建物・屋根が非表示）は external だけ', () => {
    const external = groupWithMesh('external');
    const building = groupWithMesh('building', false);
    const roof = groupWithMesh('roof', false);
    expect(pickRoots([external, building, roof])).toEqual([external]);
  });
  it('置き換えでない 3DS は PDF の建物・屋根と一緒に候補になる（手前に当たった方を拾う）', () => {
    const external = groupWithMesh('external');
    const building = groupWithMesh('building');
    const roof = groupWithMesh('roof');
    expect(pickRoots([external, building, roof])).toEqual([external, building, roof]);
  });
  it('3DS が無い（external が空）ときは PDF の建物・屋根だけ', () => {
    const external = new THREE.Group();
    const building = groupWithMesh('building');
    const roof = groupWithMesh('roof');
    expect(pickRoots([external, building, roof])).toEqual([building, roof]);
  });
  it('当たったメッシュが 3DS（ラッパーの子孫）かどうか', () => {
    const wrapper = new THREE.Group();
    const pivot = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    wrapper.add(pivot);
    pivot.add(mesh);
    const other = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    new THREE.Group().add(other);
    expect(descendsFrom(mesh, wrapper)).toBe(true);
    expect(descendsFrom(wrapper, wrapper)).toBe(true);
    expect(descendsFrom(other, wrapper)).toBe(false);
    expect(descendsFrom(null, wrapper)).toBe(false);
  });
});

describe('3DS の配置の状態の文言', () => {
  it('手で調整／自動で合わせた／自動で合わせられなかった（fit 無し）を区別する', () => {
    expect(placementStateText({ manual: true, fit: { mismatchM: 0 } })).toBe('手で調整した配置です');
    expect(placementStateText({ manual: false, fit: { mismatchM: 0 } })).toBe('間取りの外形に自動で合わせた配置です');
    expect(placementStateText({ manual: false, fit: { mismatchM: 0, unitSuspect: false } })).toBe('間取りの外形に自動で合わせた配置です');
    expect(placementStateText({})).toBe('未調整（自動で合わせられませんでした）');
    expect(placementStateText({ manual: false })).toBe('未調整（自動で合わせられませんでした）');
    expect(placementStateText({ manual: false, fit: null })).toBe('未調整（自動で合わせられませんでした）');
    // 周長の比で単位違いと判定し、向きだけ仮に合わせた配置は「合わせた」と言わない
    expect(placementStateText({ manual: false, fit: { mismatchM: 18000, unitSuspect: true } })).toBe('仮の配置（単位を確認してください）');
    // 仮の配置を手で動かせば「手で調整」
    expect(placementStateText({ manual: true, fit: { mismatchM: 18000, unitSuspect: true } })).toBe('手で調整した配置です');
  });
});

describe('解析結果の無効化（位置・向き・3DS・周辺建物が変わったとき）', () => {
  const season = { id: 'winter' as const, label: '冬至', dateLabel: '12月22日', rooms: [] };
  it('部屋の日当たり・日影図に加えて、撮影済みの季節比較画像も捨てる（数字と写真が別の建物にならないように）', () => {
    const r = clearedSunResults({ seasons: [season], highlights: [], diagramSvg: '<svg/>', images: [{ label: '冬至 10:00', url: 'data:,' }] });
    expect(r.sun.seasons).toEqual([]);
    expect(r.sun.highlights).toEqual([]);
    expect(r.sun.diagramSvg).toBeUndefined();
    expect(r.sun.images).toEqual([]);
    expect(r.hadImages).toBe(true);
    expect(IMAGES_CLEARED_MSG).toContain('季節');
  });
  it('画像が無ければ案内は出さない（hadImages false）', () => {
    const r = clearedSunResults({ seasons: [season], highlights: [], images: [] });
    expect(r.hadImages).toBe(false);
    expect(r.sun.images).toEqual([]);
  });
  it('元のオブジェクトは変えない', () => {
    const sun = { seasons: [season], highlights: [], images: [{ label: 'a', url: 'b' }] };
    clearedSunResults(sun);
    expect(sun.seasons).toHaveLength(1);
    expect(sun.images).toHaveLength(1);
  });
});

describe('資料の注記（日当たりを 3DS で解析しているとき）', () => {
  it('置き換え中だけ注記を出す', () => {
    expect(sunCaption({ replaces: true })).toBe(SUN_EXTERNAL_CAPTION);
    expect(SUN_EXTERNAL_CAPTION).toBe('日当たりは設計 3D データ（3DS）で解析');
    expect(sunCaption({ replaces: false })).toBeNull();
    expect(sunCaption(null)).toBeNull();
    expect(sunCaption(undefined)).toBeNull();
  });
});
