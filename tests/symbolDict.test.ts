import { describe, it, expect } from 'vitest';
import { lookupSymbol, learnSymbol, signatureOf, seedDict, countDict, exportDict, importDict, type SymbolSignature } from '../src/parser/symbolDict';
import { SYMBOL_DICT_SEED } from '../src/parser/symbolDictSeed';

describe('記号辞書', () => {
  it('同梱の初期辞書は御社の図面から作られていて、部屋の種類と大きさを持つ', () => {
    expect(SYMBOL_DICT_SEED.length).toBeGreaterThan(10);
    for (const e of SYMBOL_DICT_SEED) {
      expect(e.n).toBeGreaterThanOrEqual(2);
      expect(e.L).toBeGreaterThanOrEqual(e.S);
    }
    const seed = seedDict();
    expect(seed.every((e) => e.source === 'seed')).toBe(true);
  });

  it('修正で覚えた答えは初期辞書より優先され、初期辞書は fallback のときだけ効く', () => {
    const dict: SymbolSignature[] = [...seedDict()];
    const seedEntry = SYMBOL_DICT_SEED[0];
    const sig = signatureOf(seedEntry.room, seedEntry.L, seedEntry.S, seedEntry.innerClass === 0 ? 0 : 2);
    // 初期辞書だけのとき: user としては見つからず、fallback では見つかる
    expect(lookupSymbol(dict, sig, 'user')).toBeNull();
    expect(lookupSymbol(dict, sig, 'fallback')).toBe(seedEntry.kind);
    // 同じ形を別の答えで覚えると、user が優先される（回数が少なくても）
    const other = seedEntry.kind === 'desk' ? 'bed' : 'desk';
    learnSymbol(dict, sig, other);
    expect(lookupSymbol(dict, sig, 'user')).toBe(other);
    expect(lookupSymbol(dict, sig)).toBe(other);
    expect(lookupSymbol(dict, sig, 'fallback')).toBe(seedEntry.kind);
    const c = countDict(dict);
    expect(c.user).toBe(1);
    expect(c.seed).toBe(SYMBOL_DICT_SEED.length);
  });

  it('±50mm の違いは同じ形、それ以上は別の形', () => {
    const dict: SymbolSignature[] = [];
    learnSymbol(dict, signatureOf('ldk', 1800, 800, 0), 'dining');
    expect(lookupSymbol(dict, signatureOf('ldk', 1840, 790, 0))).toBe('dining');
    expect(lookupSymbol(dict, signatureOf('ldk', 2000, 800, 0))).toBeNull();
    expect(lookupSymbol(dict, signatureOf('bedroom', 1800, 800, 0))).toBeNull();
  });

  it('書き出し・取り込みで学習分だけが往復し、初期辞書は含まれない', () => {
    const dict: SymbolSignature[] = [...seedDict()];
    learnSymbol(dict, signatureOf('ldk', 1600, 600, 1), 'cupboard');
    learnSymbol(dict, signatureOf('bedroom', 1200, 600, 0), 'desk', 'bulk');
    const json = exportDict(dict);
    const parsed = JSON.parse(json) as { entries: SymbolSignature[] };
    expect(parsed.entries.length).toBe(2);
    const dict2: SymbolSignature[] = [...seedDict()];
    expect(importDict(dict2, json)).toBe(2);
    expect(lookupSymbol(dict2, signatureOf('ldk', 1600, 600, 1), 'user')).toBe('cupboard');
    expect(lookupSymbol(dict2, signatureOf('bedroom', 1200, 600, 0), 'fallback')).toBe('desk');
    expect(() => importDict(dict2, '{"nope":1}')).toThrow();
  });
});
