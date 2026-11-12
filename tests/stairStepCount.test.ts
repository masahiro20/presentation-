// 直階段の段数を、図面の段の線の間隔（踏面）から決める（第 42 巡 ⑯。田中様邸 2 階）
// ＋ 上下階の階段の範囲合わせを、変わらなくなるまで繰り返す（4 階建ての市岡様邸 1 階）
import { describe, expect, it } from 'vitest';
import { effectiveStepCount } from '../src/core/stairs';
import { reconcileStairs } from '../src/parser/assemble';
import type { Floor, Stair, Vec2 } from '../src/core/types';

const stair = (x0: number, y0: number, x1: number, y1: number, kind: Stair['kind'], entry: Stair['entry'], goesUp = true, extra: Partial<Stair> = {}): Stair => ({ id: 'S', minX: x0, minY: y0, maxX: x1, maxY: y1, kind, entry, goesUp, ...extra });

describe('直階段の段数は、図面の段の間隔から', () => {
  it('長さ 3,185・踏面 227.5 で描かれた直階段は 15 段（踏面 14 ＋ 上がり切りの 1 段）', () => {
    const s = stair(1820, 1365, 5005, 2275, 'straight', 'w', true, { treadPitch: 227.5 });
    expect(effectiveStepCount(2900, s)).toBe(15);
    // 間隔が読めていなければ、今までどおり「踏面 240 以上」で割る（13 段・蹴上 223）
    expect(effectiveStepCount(2900, { ...s, treadPitch: undefined })).toBe(13);
  });

  it('範囲が間隔の整数倍でない・その段数では蹴上が上限を超える階段は、階高から決める（市岡様邸: 直線 8 段＋上下の角に 2 段ずつ = 13 段）', () => {
    // 段の線のある範囲だけ（2,375 ÷ 237.6 = 10 → 11 段では蹴上 264）: 直線のほかに角の回り段がある
    const flight = stair(90, 5221, 848, 7596, 'straight', 's', true, { treadPitch: 237.6 });
    expect(effectiveStepCount(2900, flight)).toBe(13);
    // 踊り場まで含めて読んだ範囲（3,273 ÷ 237.6 = 13.8）: 段の線の無い所を含んでいるので、間隔からは決めない
    expect(effectiveStepCount(2900, stair(90, 4323, 848, 7596, 'straight', 's', true, { treadPitch: 237.6 }))).toBe(13);
  });

  it('図面の「14段」の注記があれば、そちらが先', () => {
    expect(effectiveStepCount(2900, stair(1820, 1365, 5005, 2275, 'straight', 'w', true, { treadPitch: 227.5, steps: 14 }))).toBe(14);
  });

  it('切断線までしか描かれていない短い階段（蹴上が上限を超える段数）・半端な長さは、今までどおり', () => {
    // 1,901 ÷ 237 = 8 → 9 段では蹴上 322。図面が途中までなので、間隔からは決めない
    const short = stair(90, 5695, 1043, 7596, 'straight', 's', true, { treadPitch: 237.1 });
    expect(effectiveStepCount(2900, short)).toBe(effectiveStepCount(2900, { ...short, treadPitch: undefined }));
    // 3,300 ÷ 227.5 = 14.5（どちらとも言えない）
    const odd = stair(0, 0, 3300, 910, 'straight', 'w', true, { treadPitch: 227.5 });
    expect(effectiveStepCount(2900, odd)).toBe(effectiveStepCount(2900, { ...odd, treadPitch: undefined }));
  });

  it('折り返し・かね折れは、間隔からは決めない（踊り場・回り段の数え方が図面ごとに違う）', () => {
    for (const kind of ['u', 'l'] as const) {
      const s = stair(0, 0, 1820, 1820, kind, 's', true, { treadPitch: 227.5 });
      expect(effectiveStepCount(2900, s)).toBe(effectiveStepCount(2900, { ...s, treadPitch: undefined }));
    }
  });
});

describe('上下階の階段の範囲合わせは、伝わり切るまで繰り返す', () => {
  const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  const floor = (level: number, stairs: Stair[]): Floor => ({ level, elevation: 500 + (level - 1) * 2900, height: 2900, ceilingHeight: 2400, walls: [], openings: [], rooms: [], stairs, outline: [rect(0, 0, 9100, 9100)] }) as unknown as Floor;
  /** 市岡様邸の形: 同じ位置に積み重なる直階段。下の階ほど、図は切断線までで短い。4 階（塔屋）の図だけ上がり切り（5,321）まで描かれる */
  const ichioka = () => [
    floor(1, [stair(191, 6845, 1143, 7696, 'straight', 's')]),
    floor(2, [stair(190, 5795, 948, 7696, 'straight', 's')]),
    floor(3, [stair(190, 5795, 948, 7696, 'straight', 's')]),
    floor(4, [stair(160, 5321, 980, 8583, 'straight', 'n', false)]),
  ];

  it('4 階の図で分かった上がり切りの位置が、1 回の呼び出しで 1 階まで伝わる', () => {
    const floors = ichioka();
    reconcileStairs(floors);
    expect(floors[2].stairs[0].minY).toBe(5321);
    expect(floors[1].stairs[0].minY).toBe(5321);
    expect(floors[0].stairs[0].minY).toBe(5321);
    // 昇り口の側（南）と左右は動かさない
    expect(floors[0].stairs[0].maxY).toBe(7696);
    expect(floors[0].stairs[0].maxX).toBe(1143);
  });

  it('切り替えを切ると、今までどおり 1 階分ずつ', () => {
    const g = globalThis as { __NO_RECONCILE_REPEAT?: boolean };
    g.__NO_RECONCILE_REPEAT = true;
    try {
      const floors = ichioka();
      reconcileStairs(floors);
      expect(floors[2].stairs[0].minY).toBe(5321);
      expect(floors[1].stairs[0].minY).toBe(5795);
      expect(floors[0].stairs[0].minY).toBe(5795);
    } finally {
      delete g.__NO_RECONCILE_REPEAT;
    }
  });
});
