import { describe, it, expect } from 'vitest';
import { siteStudy, siteStudySvg, wantFromWishes, tsubo } from '../src/core/siteStudy';
import { parseWishes } from '../src/core/wishes';

describe('敷地から先に検討', () => {
  const base = { frontage: 12, depth: 15, bcr: 60, far: 200, road: 'S' as const, wantTsubo: 35, floors: 2 as const, cars: 2 };

  it('12 × 15 m・60／200 に 2 階建て 35 坪・駐車 2 台は入る', () => {
    const r = siteStudy(base);
    expect(r.siteM2).toBe(180);
    expect(r.maxFootprintM2).toBe(108);
    expect(r.maxFloorM2).toBe(360);
    expect(r.verdict).toBe('ok');
    expect(r.rows.find((x) => x.label === '建蔽率')?.status).toBe('ok');
    expect(r.rows.find((x) => x.label === '駐車')?.status).not.toBe('ng');
    // 建物は 910 モジュール
    expect(Math.round((r.bldgW / 0.91) * 100) / 100 % 1).toBe(0);
  });

  it('建蔽率 40 の平屋 35 坪は入らず、上限の坪数を案内する', () => {
    const r = siteStudy({ ...base, bcr: 40, far: 80, floors: 1 });
    expect(r.verdict).toBe('ng');
    expect(r.rows.find((x) => x.label === '建蔽率')?.status).toBe('ng');
    expect(r.verdictText).toContain('坪まで');
    expect(tsubo(r.possibleFloorM2)).toBeLessThan(35);
  });

  it('駐車 3 台は間口 6 m に並ばない', () => {
    const r = siteStudy({ ...base, frontage: 6, depth: 30, cars: 3 });
    expect(r.rows.find((x) => x.label === '駐車')?.status).toBe('ng');
  });

  it('坪単価を入れると概算の行が出る', () => {
    const r = siteStudy({ ...base, tsuboPriceMan: 100 });
    expect(r.costMan).toBe(3500);
    expect(r.rows.some((x) => x.label === '概算' && /3,500 万円/.test(x.text))).toBe(true);
    expect(siteStudy(base).costMan).toBeUndefined();
  });

  it('絵には敷地・道路・駐車・建物が入る', () => {
    const r = siteStudy(base);
    const svg = siteStudySvg(base, r);
    expect(svg).toContain('道路（南側）');
    expect((svg.match(/>車</g) ?? []).length).toBe(2);
    expect(svg).toContain('2 階建て 35 坪');
  });

  it('ご要望の文章から希望の延床の見当をつける', () => {
    const w = wantFromWishes(parseWishes('部屋数は、LDK、和室、寝室、子ども部屋 2 つ\nLDK 20 畳\n平屋希望\n駐車 2 台'));
    expect(w).not.toBeNull();
    expect(w!.tsubo).toBeGreaterThan(20);
    expect(w!.tsubo).toBeLessThan(45);
    expect(w!.floors).toBe(1);
    expect(w!.cars).toBe(2);
    expect(wantFromWishes(parseWishes('明るい家にしたい'))).toBeNull();
  });
});
