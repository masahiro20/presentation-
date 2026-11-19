// 「どの数字も悪くならないときだけ採る」: 2 通りの読み取りの比べ方と、階段の修正案の寸法の常識
import { describe, expect, it } from 'vitest';
import { parseSample } from './pdfNode';
import { compareReadings } from '../src/parser/readingGate';
import { plausibleStair } from '../src/core/stairDiagnosis';
import type { BuildingModel } from '../src/core/types';

const clone = (m: BuildingModel): BuildingModel => JSON.parse(JSON.stringify(m));

describe('読み取りの比べ方（readingGate）', () => {
  it('同じ読み取りどうしは採らない（良くなった所が無い）', async () => {
    const m = await parseSample('sample_house_A3.pdf');
    const v = compareReadings(m, clone(m));
    expect(v.adopt).toBe(false);
    expect(v.worse).toBe(false);
  });

  it('部屋の名前が消える（1 つでも悪くなる）読み取りは採らない', async () => {
    const m = await parseSample('sample_house_A3.pdf');
    const c = clone(m);
    c.floors[0].rooms[0].name = '室';
    c.floors[0].rooms[0].type = 'other';
    const v = compareReadings(m, c);
    expect(v.worse).toBe(true);
    expect(v.adopt).toBe(false);
    expect(v.reasons.join('')).toContain('悪化');
  });

  it('階が 1 つも読めなかった読み取りより、読めた読み取りを採る（警告の数は比べない）', async () => {
    const m = await parseSample('sample_house_A3.pdf');
    const empty = clone(m);
    empty.floors = [];
    expect(compareReadings(empty, m).adopt).toBe(true);
    expect(compareReadings(m, empty).adopt).toBe(false);
  });
});

describe('階段の修正案の寸法の常識（plausibleStair）', () => {
  it('住宅の折り返し階段 1,820×1,820・踏面 228 は成り立つ', () => {
    expect(plausibleStair({ kind: 'u', w: 1820, d: 1820, tread: 228, riser: 200 })).toBe(true);
  });
  it('長さ 4,550 の折り返し階段・踏面 520 は成り立たない（有本様邸で出ていた案）', () => {
    expect(plausibleStair({ kind: 'u', w: 4550, d: 1820, tread: 520, riser: 207 })).toBe(false);
  });
  it('直階段は長さ 4,100 まで・幅 700 以上・蹴上 230 以下', () => {
    expect(plausibleStair({ kind: 'straight', w: 3640, d: 910, tread: 240, riser: 200 })).toBe(true);
    expect(plausibleStair({ kind: 'straight', w: 4550, d: 910, tread: 240, riser: 200 })).toBe(false);
    expect(plausibleStair({ kind: 'straight', w: 3640, d: 600, tread: 240, riser: 200 })).toBe(false);
    expect(plausibleStair({ kind: 'straight', w: 3640, d: 910, tread: 240, riser: 240 })).toBe(false);
  });
});
