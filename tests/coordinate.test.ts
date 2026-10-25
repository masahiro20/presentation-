import { describe, it, expect } from 'vitest';
import { harmonyCheck, lightness } from '../src/coordinate/harmony';
import { reconcileDecided, newCoord, setCandidates, decide, progress, blockedBy, applyCustomerPicks, picksUrlFor, needsReview, ROUNDS } from '../src/coordinate/decisions';
import { FINISH_CATEGORIES } from '../src/coordinate/catalog';
import { DEFAULT_DESIGN } from '../src/styles/presets';
import { MOODS, applyMood } from '../src/coordinate/moods';

describe('harmony', () => {
  it('lightness is perceptual', () => {
    expect(lightness('#ffffff')).toBeCloseTo(1, 2);
    expect(lightness('#000000')).toBeCloseTo(0, 2);
    expect(lightness('#777777')).toBeGreaterThan(0.45);
  });
  it('flags floor/door wood clash and dark wall + white sash', () => {
    const d = { ...DEFAULT_DESIGN, finishes: { floor: 'floor.iemon.mocha', door: 'door.panasonic.veritis', extWall: 'ext.jp.dark', sash: 'sash.tw.white' } };
    const a = harmonyCheck(d);
    expect(a.find((x) => x.title.includes('床と建具で木の色'))?.level).toBe('warn');
    expect(a.find((x) => x.title.includes('濃い外壁に白いサッシ'))?.level).toBe('warn');
    expect(a[0].level).toBe('warn');
  });
  it('every mood passes without a warning', () => {
    for (const m of MOODS) {
      const warns = harmonyCheck(applyMood(DEFAULT_DESIGN, m)).filter((x) => x.level === 'warn');
      expect(warns.map((w) => `${m.name}: ${w.title}`)).toEqual([]);
    }
  });
});

describe('decisions', () => {
  it('rounds cover every category exactly once', () => {
    const ids = ROUNDS.flatMap((r) => r.cats).sort();
    expect(ids).toEqual(FINISH_CATEGORIES.map((c) => c.id).sort());
  });
  it('candidates → decide → progress', () => {
    let c = newCoord();
    c = setCandidates(c, 'floor', ['floor.channel.oak', 'floor.iemon.smoke', 'floor.ioc.oak', 'floor.tile.black']);
    expect(c.items.floor.candidates).toHaveLength(3);
    expect(c.items.floor.status).toBe('proposed');
    expect(blockedBy(c, 'door')).toEqual(['floor', 'wall']);
    c = decide(c, 'floor');
    expect(c.items.floor.status).toBe('decided');
    expect(progress(c).decided).toBe(1);
    expect(needsReview(decide(c, 'door'), 'floor')).toEqual(['door']);
  });
  it('customer picks change finishes but not decided items', () => {
    let c = decide(newCoord(), 'extWall');
    const d = { ...DEFAULT_DESIGN, finishes: { extWall: 'ext.jp.mid' } };
    const r = applyCustomerPicks(c, d, { at: '2026-10-25', picks: { extWall: { id: 'ext.jp.white' }, floor: { id: 'floor.iemon.smoke', comment: '柔らかい色が好き' }, bogus: { id: 'x' } } });
    expect(r.conflicts).toEqual(['extWall']);
    expect(r.finishes.extWall).toBe('ext.jp.mid');
    expect(r.finishes.floor).toBe('floor.iemon.smoke');
    expect(r.coord.items.floor.status).toBe('picked');
    expect(r.coord.items.floor.customerComment).toBe('柔らかい色が好き');
    c = r.coord;
    expect(c.items.extWall.customerPick).toBe('ext.jp.white');
  });
  it('picks url sits next to project.json', () => {
    expect(picksUrlFor('https://x.vercel.app/view.html?p=' + encodeURIComponent('https://abc.public.blob.vercel-storage.com/share/abc123def456/project.json'))).toBe('https://abc.public.blob.vercel-storage.com/share/abc123def456/picks.json');
    expect(picksUrlFor('nope')).toBeNull();
  });
  it('switching taste un-decides changed items only', () => {
    let c = decide(decide(newCoord(), 'floor'), 'bath');
    const before = { ...DEFAULT_DESIGN, finishes: { floor: 'floor.channel.oak' } };
    const after = { ...DEFAULT_DESIGN, finishes: { floor: 'floor.iemon.mocha' } };
    const r = reconcileDecided(c, before, after);
    expect(r.undone).toEqual(['床材']);
    expect(r.coord.items.floor.status).toBe('open');
    expect(r.coord.items.bath.status).toBe('decided');
  });
});
