// 窓・戸の端のつまみ（方眼で幅を変える）: core/openings の dragOpeningEnd
import { describe, expect, it } from 'vitest';
import { dragOpeningEnd } from '../src/core/openings';

describe('窓・戸の端のつまみ', () => {
  it('反対の端は止めたまま、近い標準の幅（柱芯の割）に止まる', () => {
    const op = { t0: 1000, t1: 2235, kind: 'window' as const };
    // 右の端を 2,700 付近へ → 幅 1,690（柱芯 1,820）の 2,690 に止まる
    const r = dragOpeningEnd(op, 't1', 2705, 6000, [], 100);
    expect(r.t0).toBe(1000);
    expect(r.t1).toBe(2690);
    expect(r.hint).toContain('1,690');
    // 左の端: 右端 2,235 を止めたまま、幅 780 → t0 = 1,455
    const l = dragOpeningEnd(op, 't0', 1440, 6000, [], 100);
    expect(l.t1).toBe(2235);
    expect(l.t0).toBe(1455);
  });

  it('吸着の範囲の外・Alt（snapTol < 0）では指の位置（5 mm 単位）', () => {
    const op = { t0: 1000, t1: 2235, kind: 'window' as const };
    const r = dragOpeningEnd(op, 't1', 2903, 6000, [], -1);
    expect(r.t1).toBe(2905);
    expect(r.hint).toBe('');
  });

  it('戸は方眼の線（gridT）の方が近ければ方眼に止まる。窓は届く範囲に標準の幅があればそちらを優先', () => {
    const op = { t0: 1000, t1: 1780, kind: 'door' as const };
    const gridT = (t: number) => Math.round(t / 455) * 455;
    const r = dragOpeningEnd(op, 't1', 2280, 6000, [], 100, gridT);
    expect(r.t1).toBe(2275);
    expect(r.hint).toBe('端が方眼');
    // 窓: 方眼 2,275（差 5）より標準の幅 1,235 の 2,235（差 45）
    const w = dragOpeningEnd({ ...op, kind: 'window' }, 't1', 2280, 6000, [], 100, gridT);
    expect(w.t1).toBe(2235);
    expect(w.hint).toContain('1,235');
    // 標準の幅が届かなければ方眼（3,185 は方眼の線。いちばん近い標準の幅 2,145 → 3,145 は 40 離れていて、吸着の範囲 30 の外）
    const g = dragOpeningEnd({ ...op, kind: 'window' }, 't1', 3185, 6000, [], 30, gridT);
    expect(g.t1).toBe(3185);
    expect(g.hint).toBe('端が方眼');
  });

  it('隣の窓・戸と壁の端を越えない、幅の下限を守る', () => {
    const op = { t0: 1000, t1: 2000, kind: 'window' as const };
    const next = { t0: 2600, t1: 3400 };
    expect(dragOpeningEnd(op, 't1', 3200, 6000, [next], -1).t1).toBe(2580);
    expect(dragOpeningEnd(op, 't1', 9000, 4000, [], -1).t1).toBe(3980);
    expect(dragOpeningEnd(op, 't0', -500, 6000, [{ t0: 200, t1: 700 }], -1).t0).toBe(720);
    // 幅は窓 150 mm まで
    expect(dragOpeningEnd(op, 't1', 1010, 6000, [], -1).t1).toBe(1150);
    // シャッターは標準サッシ幅に吸着しない・1,500 mm 以上
    const sh = { t0: 500, t1: 5500, kind: 'shutter' as const };
    const s = dragOpeningEnd(sh, 't1', 2195, 8000, [], 100);
    expect(s.hint).toBe('');
    expect(s.t1).toBe(2195);
    expect(dragOpeningEnd(sh, 't1', 900, 8000, [], -1).t1).toBe(2000);
  });
});
