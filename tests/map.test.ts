import { describe, expect, it } from 'vitest';
import { metersPerPixel, polygonAreaM2, polygonCentroid, lonLatToWorldPx, worldPxToLonLat, niceScaleBar, formatArea, clampCenter, clampZoom, tileUrl } from '../src/sunstudy/map';
import { frameFromLocal } from '../src/sunstudy/types';

const ORIGIN = { lat: 35.68, lon: 139.76 };

describe('地図の幾何（Web メルカトル）', () => {
  it('赤道・z0 の m/px はおよそ 156543', () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(156543.03, 1);
  });
  it('東京 z18 の m/px はおよそ 0.485（±2%）', () => {
    const v = metersPerPixel(35.68, 18);
    expect(Math.abs(v - 0.485) / 0.485).toBeLessThan(0.02);
  });
  it('ズームが 1 上がると m/px は半分', () => {
    expect(metersPerPixel(35, 10) / metersPerPixel(35, 11)).toBeCloseTo(2, 10);
  });
  it('緯度経度 → 世界画素 → 緯度経度 が一致する（小数ズームでも）', () => {
    for (const z of [5, 12.37, 16, 18]) {
      const px = lonLatToWorldPx(ORIGIN.lon, ORIGIN.lat, z);
      const back = worldPxToLonLat(px.x, px.y, z);
      expect(back.lat).toBeCloseTo(ORIGIN.lat, 9);
      expect(back.lon).toBeCloseTo(ORIGIN.lon, 9);
    }
    // 世界画素の大きさは 256 * 2^z
    expect(lonLatToWorldPx(180, 0, 3).x).toBeCloseTo(256 * 8, 9);
    expect(lonLatToWorldPx(0, 0, 3).y).toBeCloseTo(128 * 8, 9);
  });
  it('クランプ: ズーム 5..22、緯度 ±85、経度は折り返す', () => {
    expect(clampZoom(2)).toBe(5);
    expect(clampZoom(30)).toBe(22);
    expect(clampZoom(NaN)).toBe(5);
    expect(clampCenter({ lat: 90, lon: 190 }).lat).toBeCloseTo(85.0511, 3);
    expect(clampCenter({ lat: 0, lon: 190 }).lon).toBeCloseTo(-170, 9);
  });
  it('タイル URL（国土地理院）', () => {
    expect(tileUrl('std', 16, 58211, 25806)).toBe('https://cyberjapandata.gsi.go.jp/xyz/std/16/58211/25806.png');
    expect(tileUrl('pale', 5, 1, 2)).toBe('https://cyberjapandata.gsi.go.jp/xyz/pale/5/1/2.png');
    expect(tileUrl('photo', 18, 1, 2)).toBe('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/18/1/2.jpg');
  });
});

describe('多角形の面積（局所平面）', () => {
  const rect = (w: number, d: number) => [frameFromLocal(ORIGIN, 0, 0), frameFromLocal(ORIGIN, w, 0), frameFromLocal(ORIGIN, w, d), frameFromLocal(ORIGIN, 0, d)];

  it('20m × 10m の長方形は 200㎡（±0.5%）', () => {
    const a = polygonAreaM2(rect(20, 10));
    expect(Math.abs(a - 200) / 200).toBeLessThan(0.005);
  });
  it('頂点の順序（時計回り・反時計回り）に依らない', () => {
    const p = rect(20, 10);
    expect(polygonAreaM2([...p].reverse())).toBeCloseTo(polygonAreaM2(p), 6);
  });
  it('2 点以下は 0', () => {
    expect(polygonAreaM2([])).toBe(0);
    expect(polygonAreaM2(rect(20, 10).slice(0, 2))).toBe(0);
  });
  it('重心は長方形の中央', () => {
    const c = polygonCentroid(rect(20, 10))!;
    const expected = frameFromLocal(ORIGIN, 10, 5);
    expect(c.lat).toBeCloseTo(expected.lat, 8);
    expect(c.lon).toBeCloseTo(expected.lon, 8);
    expect(polygonCentroid([])).toBeNull();
  });
  it('面積の表示は ㎡ と 坪', () => {
    expect(formatArea(200)).toBe('200.0㎡（60.5坪）');
  });
});

describe('スケールバー', () => {
  it('きれいな長さを選び、指定の幅に収まる', () => {
    const mpp = metersPerPixel(35.68, 16); // 約 1.9 m/px
    const sb = niceScaleBar(mpp, 120);
    expect([10, 20, 50, 100, 200, 500]).toContain(sb.meters);
    expect(sb.px).toBeLessThanOrEqual(120);
    expect(sb.px).toBeGreaterThan(40);
    expect(sb.label).toBe(`${sb.meters}m`);
    const far = niceScaleBar(metersPerPixel(35.68, 5), 120);
    expect(far.label).toMatch(/km$/);
  });
});
