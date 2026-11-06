// 吹抜の範囲: ×印が無くても、「吹抜」の文字の上下左右の細い線（手すり）と壁で囲まれた長方形を吹抜にする（堀様邸の 2 階）
import { describe, expect, it } from 'vitest';
import { voidRectangles, type MmText } from '../src/parser/assemble';
import type { Seg } from '../src/parser/walls';
import type { Vec2 } from '../src/core/types';

const seg = (a: Vec2, b: Vec2, dashed = false): Seg => ({ a, b, width: 0.3, dashed, source: 'stroke' });
const text = (str: string, x: number, y: number): MmText => ({ str, x, y, size: 3, angle: 0 });

/** 洋室（左）・吹抜（中央 5,460 × 3,640）・ホール（下）。吹抜の上は外壁、左は洋室の壁、右と下は手すりの細い線 */
function plan(opts: { openBottom?: boolean; extraText?: MmText; level?: number } = {}) {
  const walls = [
    { a: { x: 0, y: 0 }, b: { x: 16000, y: 0 } }, // 上の外壁
    { a: { x: 2270, y: 0 }, b: { x: 2270, y: 6370 } }, // 洋室との壁
  ];
  const segs: Seg[] = [
    seg({ x: 7730, y: 0 }, { x: 7730, y: 3640 }), // 右の手すり
    ...(opts.openBottom ? [seg({ x: 2270, y: 3640 }, { x: 4000, y: 3640 })] : [seg({ x: 2270, y: 3640 }, { x: 7730, y: 3640 })]), // 下の手すり
    seg({ x: 0, y: 6370 }, { x: 16000, y: 6370 }), // 下の外壁の線
    seg({ x: 3000, y: 5000 }, { x: 3600, y: 5000 }), // ホールの家具の線
  ];
  const texts = [text('吹抜', 5000, 1800), text('ホール', 5000, 5000), text('洋室', 1100, 3000), ...(opts.extraText ? [opts.extraText] : [])];
  return { segs, texts, walls, level: opts.level ?? 2 };
}

describe('voidRectangles（×印の無い吹抜）', () => {
  it('手すりの線と壁で囲まれた長方形を吹抜の範囲にする', () => {
    const p = plan();
    const out = voidRectangles(p, p.level);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ minX: 2270, maxX: 7730, minY: 0, maxY: 3640 });
  });
  it('一辺が 8 割以上囲まれていなければ吹抜にしない', () => {
    const p = plan({ openBottom: true });
    expect(voidRectangles(p, p.level)).toHaveLength(0);
  });
  it('中にほかの室名があれば吹抜にしない', () => {
    const p = plan({ extraText: text('ホール', 6500, 3000) });
    expect(voidRectangles(p, p.level)).toHaveLength(0);
  });
  it('1 階の「上部吹抜」には使わない', () => {
    const p = plan({ level: 1 });
    expect(voidRectangles(p, p.level)).toHaveLength(0);
    p.texts[0] = text('上部吹抜', 5000, 1800);
    expect(voidRectangles(p, 2)).toHaveLength(0);
  });
});
