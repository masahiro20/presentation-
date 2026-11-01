import { describe, it, expect } from 'vitest';
import { autoShutterLayout, shutterSpans, applyShutterLayout, shutterLayoutOf } from '../src/core/shutter';
import type { Floor, Wall } from '../src/core/types';

const wall = (id: string, len: number): Wall => ({ id, a: { x: 0, y: 0 }, b: { x: len, y: 0 }, thickness: 120, exterior: true });
const floor = (w: Wall): Floor => ({ level: 1, elevation: 500, height: 2900, ceilingHeight: 2400, walls: [w], openings: [], rooms: [], stairs: [], outline: [] });

describe('ガレージのシャッターの形', () => {
  it('壁の長さで 1 台／2 台一体／2 台中柱を決める', () => {
    expect(autoShutterLayout(3000)).toBe('single');
    expect(autoShutterLayout(5500)).toBe('wide');
    expect(autoShutterLayout(7000)).toBe('double');
  });

  it('1 台は 3.4m まで・中央寄せ、2 台一体は壁いっぱい、2 台中柱は中央に 400 の柱を残す', () => {
    const s1 = shutterSpans(5000, 'single');
    expect(s1).toHaveLength(1);
    expect(s1[0].t1 - s1[0].t0).toBe(3400);
    expect(s1[0].t0).toBeCloseTo((5000 - 3400) / 2, 0);
    const sw = shutterSpans(5000, 'wide');
    expect(sw[0]).toEqual({ t0: 80, t1: 4920 });
    const sd = shutterSpans(7000, 'double');
    expect(sd).toHaveLength(2);
    expect(sd[1].t0 - sd[0].t1).toBe(400);
    expect(sd[0].t0).toBe(80);
    expect(sd[1].t1).toBe(6920);
    // 短い壁は 1 台にしかならない
    expect(shutterSpans(3000, 'double')).toHaveLength(1);
    expect(shutterSpans(1200, 'single')).toHaveLength(0);
  });

  it('壁に置き直すと、以前のシャッターだけ入れ替わり、形が読み取れる', () => {
    const w = wall('W1', 7000);
    const f = floor(w);
    f.openings.push({ id: 'd', wallId: 'W1', kind: 'door', t0: 100, t1: 900, sill: 0, height: 2000 });
    expect(applyShutterLayout(f, w, 'double')).toBe(2);
    expect(f.openings.filter((o) => o.kind === 'shutter')).toHaveLength(2);
    expect(f.openings.some((o) => o.kind === 'door')).toBe(true);
    expect(shutterLayoutOf(f, 'W1')).toBe('double');
    applyShutterLayout(f, w, 'single');
    expect(f.openings.filter((o) => o.kind === 'shutter')).toHaveLength(1);
    expect(shutterLayoutOf(f, 'W1')).toBe('single');
    applyShutterLayout(f, w, 'wide');
    expect(shutterLayoutOf(f, 'W1')).toBe('wide');
  });
});
