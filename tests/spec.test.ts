import { describe, expect, it } from 'vitest';
import { effectiveOpening, specById } from '../src/styles/spec';

describe('標準仕様（ホームランディック）', () => {
  const hl = specById('homelandick');
  const std = specById('standard');
  it('室内ドアは天井までのフルハイト', () => {
    expect(effectiveOpening({ kind: 'door', sill: 0, height: 2000 }, 2400, hl)).toEqual({ sill: 0, height: 2400 });
    expect(effectiveOpening({ kind: 'sliding', sill: 0, height: 2000 }, 2500, hl)).toEqual({ sill: 0, height: 2500 });
  });
  it('窓の上端は天井高にそろう', () => {
    const koshi = effectiveOpening({ kind: 'window', sill: 900, height: 1100, windowStyle: 'koshi' }, 2400, hl);
    expect(koshi.sill + koshi.height).toBe(2400);
    const haki = effectiveOpening({ kind: 'window', sill: 0, height: 2200, windowStyle: 'hakidashi' }, 2400, hl);
    expect(haki).toEqual({ sill: 0, height: 2400 });
    const small = effectiveOpening({ kind: 'window', sill: 1400, height: 600, windowStyle: 'small' }, 2400, hl);
    expect(small).toEqual({ sill: 1800, height: 600 });
  });
  it('一般仕様では元の高さのまま', () => {
    expect(effectiveOpening({ kind: 'door', sill: 0, height: 2000 }, 2400, std)).toEqual({ sill: 0, height: 2000 });
    expect(effectiveOpening({ kind: 'window', sill: 900, height: 1100, windowStyle: 'koshi' }, 2400, std)).toEqual({ sill: 900, height: 1100 });
  });
});
