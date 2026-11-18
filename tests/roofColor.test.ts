import { describe, expect, it } from 'vitest';
import { sampleRoofColor, tidyRoofColor } from '../src/sun/roofColor';

/** 100×100 画素 = 東西・南北 100 m の写真。色は関数で塗る */
function photo(paint: (e: number, n: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(100 * 100 * 4);
  for (let y = 0; y < 100; y++)
    for (let x = 0; x < 100; x++) {
      const [r, g, b] = paint(x + 0.5, 100 - (y + 0.5));
      data.set([r, g, b, 255], (y * 100 + x) * 4);
    }
  return { data, width: 100, height: 100 };
}
const bounds = { west: 0, east: 100, south: 0, north: 100 };
const box = (e: number, n: number, w: number, d: number) => [{ e, n }, { e: e + w, n }, { e: e + w, n: n + d }, { e, n: n + d }];
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

describe('航空写真から屋根の色を拾う', () => {
  it('青い屋根は青く、茶の屋根は茶に（色みを残す）', () => {
    const px = photo((e) => (e < 50 ? [60, 110, 170] : [140, 90, 60]));
    const blue = rgb(sampleRoofColor(px, bounds, box(10, 10, 12, 10))!);
    const brown = rgb(sampleRoofColor(px, bounds, box(70, 40, 12, 10))!);
    expect(blue[2]).toBeGreaterThan(blue[0] + 20);
    expect(brown[0]).toBeGreaterThan(brown[2] + 20);
  });
  it('縁に入り込んだ隣の地面の色（写真のずれ）は拾わない', () => {
    // 屋根は濃いグレー、建物の東 2 m ぶんに明るい道路の色が乗っている
    const px = photo((e) => (e > 30 ? [230, 230, 225] : [70, 72, 76]));
    const c = rgb(sampleRoofColor(px, bounds, box(20, 20, 12, 10))!);
    expect(Math.max(...c)).toBeLessThan(110);
  });
  it('写真の影（真っ黒）・白飛びは、屋根として不自然にならない明るさに寄せる', () => {
    const dark = rgb(tidyRoofColor(4, 4, 6));
    const white = rgb(tidyRoofColor(252, 252, 250));
    expect(Math.min(...dark)).toBeGreaterThanOrEqual(34);
    expect(Math.max(...white)).toBeLessThanOrEqual(170);
  });
  it('写真の外の建物・点が取れないほど小さい建物は null（決まった色に任せる）', () => {
    const px = photo(() => [100, 100, 100]);
    expect(sampleRoofColor(px, bounds, box(150, 150, 10, 10))).toBeNull();
    expect(sampleRoofColor(px, bounds, [{ e: 1, n: 1 }, { e: 2, n: 1 }])).toBeNull();
  });
  it('似た色は同じ値に丸まる（素材を使い回せる）', () => {
    expect(tidyRoofColor(100, 101, 103)).toBe(tidyRoofColor(102, 100, 101));
  });
});
