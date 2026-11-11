import { describe, expect, it } from 'vitest';
import { isOpenSkyBalcony } from '../src/core/balcony';
import { overlay } from '../src/estimate/areas';
import type { Floor, Room } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const room = (id: string, name: string, type: Room['type'], x0: number, y0: number, x1: number, y1: number): Room => ({ id, name, type, polygon: rect(x0, y0, x1, y1), area: ((x1 - x0) * (y1 - y0)) / 1e6, labelPos: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } });
const floor = (level: number, outline: { x: number; y: number }[], rooms: Room[]): Floor => ({ level, elevation: 500 + (level - 1) * 2900, height: 2900, ceilingHeight: 2400, walls: [], openings: [], rooms, outline: [outline], stairs: [] });

describe('空に開いたバルコニー（屋根を掛けない）', () => {
  // 3 階建て: 1・2 階は 3,640 × 9,100。3 階は北側 3,640 × 5,460 が部屋、南側 3,640 × 3,640 がバルコニー
  const f1 = floor(1, rect(0, 0, 3640, 9100), [room('a', 'ＬＤＫ', 'ldk', 0, 0, 3640, 9100)]);
  const f2bal = room('b2', 'バルコニー', 'balcony', 0, 7280, 3640, 9100);
  const f2 = floor(2, rect(0, 0, 3640, 9100), [room('b', '洋室', 'bedroom', 0, 0, 3640, 7280), f2bal]);
  const topSmall = room('c2', 'バルコニー', 'balcony', 0, 4550, 3640, 5460);
  const f3 = floor(3, rect(0, 0, 3640, 5460), [room('c', '洋室', 'bedroom', 0, 0, 3640, 4550), topSmall]);

  it('いちばん上の階でない 2 階以上のバルコニーは空に開く（上の階が載る所は屋根の升目で別に除く）', () => {
    expect(isOpenSkyBalcony([f1, f2, f3], 1, f2bal)).toBe(true);
  });

  it('いちばん上の階の小さなバルコニーは大屋根の下（今までどおり屋根を掛ける）', () => {
    expect(isOpenSkyBalcony([f1, f2, f3], 2, topSmall)).toBe(false);
  });

  it('いちばん上の階でも、屋内の半分より広い・名前がルーフバルコニー／屋上なら空に開く。インナーバルコニー・中庭は対象外', () => {
    const big = room('r', 'バルコニー', 'balcony', 0, 1820, 3640, 5460);
    const top = floor(4, rect(0, 0, 3640, 5460), [room('s', '階段', 'stairs', 0, 0, 1820, 1820), big]);
    expect(isOpenSkyBalcony([f1, f2, f3, top], 3, big)).toBe(true);
    expect(isOpenSkyBalcony([f1, f2, f3], 2, { ...topSmall, name: 'ルーフバルコニー' })).toBe(true);
    expect(isOpenSkyBalcony([f1, f2, f3], 2, { ...topSmall, name: '屋上' })).toBe(true);
    expect(isOpenSkyBalcony([f1, f2, f3], 1, { ...f2bal, name: 'インナーバルコニー' })).toBe(false);
    expect(isOpenSkyBalcony([f1, f2, f3], 0, room('k', '中庭', 'balcony', 0, 0, 1820, 1820))).toBe(false);
    // 1 階の「バルコニー」扱いの区画（物干しなど）は変えない
    expect(isOpenSkyBalcony([f1, f2, f3], 0, room('m', '物干', 'balcony', 0, 0, 1820, 1820))).toBe(false);
  });

  it('見積の屋根の平面から、空に開いたバルコニーのうち上の階が載らない所を除く', () => {
    const ov = overlay([f1, f2, f3]);
    // 建築面積（3,640 × 9,100）
    expect(Math.abs(ov.union - 33.12)).toBeLessThan(0.25);
    // 2 階のバルコニー（y 7,280〜9,100）は 3 階（y 0〜5,460）の外 → まるごと空に開く
    expect(Math.abs(ov.openSky - 6.62)).toBeLessThan(0.25);
    // 3 階がバルコニーの上まで載る家では 0
    const f3wide = floor(3, rect(0, 0, 3640, 9100), [room('c', '洋室', 'bedroom', 0, 0, 3640, 9100)]);
    expect(overlay([f1, f2, f3wide]).openSky).toBe(0);
  });
});
