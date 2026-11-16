// 建築概要の値が長いとき（長い住所）は、折り返さずに 1 行へ収める（文字を小さく・字間を詰める）
import { describe, expect, it } from 'vitest';
import { ovFit } from '../src/app/steps/presentStep';

describe('建築概要の長い値', () => {
  it('短い値はそのまま', () => {
    expect(ovFit('2階建て')).toBeNull();
    expect(ovFit('岐阜県可児市坂戸1234-5')).toBeNull();
  });
  it('長い住所は文字を小さくして 1 行に収める（8 割より小さくはしない）', () => {
    const f = ovFit('岐阜県可児市坂戸字北山之内1234番地5の一部')!;
    const size = Number(/font-size:([\d.]+)cqw/.exec(f.style)![1]);
    expect(size).toBeLessThan(1.25);
    expect(size).toBeGreaterThanOrEqual(1.0);
    expect(f.style).toContain('white-space:nowrap');
  });
  it('少しだけ長い値は、括弧の内側の空きを詰めるだけ（文字の大きさは変えない）', () => {
    const f = ovFit('岐阜県可児市桜ケ丘六丁目1番地2')!;
    expect(f.text).toBe('［ 岐阜県可児市桜ケ丘六丁目1番地2 ］');
    expect(f.style).not.toContain('font-size');
    expect(f.style).toContain('white-space:nowrap');
  });
  it('それでも入らない長さだけ折り返す', () => {
    expect(ovFit('岐阜県可児市坂戸字北山之内1234番地5の一部および1235番地6の一部（仮換地）')!.style).toContain('white-space:normal');
  });
});
