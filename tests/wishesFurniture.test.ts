import { describe, it, expect } from 'vitest';
import { parseWishes, checkWishes } from '../src/core/wishes';
import { parseSample } from './pdfNode';

describe('ご要望: 今の家具の持ち込み', () => {
  it('寸法付きの家具と、名前だけの家具（標準の大きさ）を読む', () => {
    const ws = parseWishes('今のソファ 220×95 を持ち込む\nダブルベッドを使う\nアップライトピアノあり\n冷蔵庫 70x75');
    const fs = ws.filter((w) => w.kind === 'furniture');
    expect(fs.map((w) => w.furniture)).toEqual(['ソファ', 'ダブルベッド', 'アップライトピアノ', '冷蔵庫']);
    expect(fs[0].fw).toBe(2200);
    expect(fs[0].fd).toBe(950);
    expect(fs[1].fw).toBe(1400);
    expect(fs[3].fw).toBe(700);
    expect(fs[3].fd).toBe(750);
    // 1 行に 2 つ: 寸法は直前の家具（ソファ）のもの。ピアノは標準の大きさ
    const two = parseWishes('今のソファ 220×95 とアップライトピアノを持ち込む').filter((w) => w.kind === 'furniture');
    expect(two.map((w) => [w.furniture, w.fw])).toEqual([['ソファ', 2200], ['アップライトピアノ', 1500]]);
  });

  it('サンプルの間取りで、ソファは LDK に入り、巨大な家具は入らない', async () => {
    const model = await parseSample('sample_house_A3.pdf');
    const rs = checkWishes(model, parseWishes('ソファ 220×95 を持ち込む\n今のダイニングテーブル 9000×4000 を持ち込む'), {});
    expect(rs).toHaveLength(2);
    expect(rs[0].status).not.toBe('ng');
    expect(rs[0].evidence).toMatch(/LDK|リビング/);
    expect(rs[1].status).toBe('ng');
  });
});
