// 日照: 新築の家に重なる周辺建物は一覧ごと消さず「敷地内の既存建物」として隠す（戻せる・表示だけにできる）
import { describe, expect, it } from 'vitest';
import { AUTO_HIDE_NOTE, autoHideOverlapping, emptyEdits, hideReasonText, isAutoHidden, reapplyEdits } from '../src/sun/context';
import type { NeighborBuilding } from '../src/sun/geo';

const sq = (e0: number, n0: number, s: number) => [
  { e: e0, n: n0 },
  { e: e0 + s, n: n0 },
  { e: e0 + s, n: n0 + s },
  { e: e0, n: n0 + s },
];
const nb = (id: string, ring: { e: number; n: number }[], extra: Partial<NeighborBuilding> = {}): NeighborBuilding => ({ id, ring, height: 7, source: 'gsi', ...extra }) as NeighborBuilding;
const keyOf = (b: NeighborBuilding) => b.id!;
const fpOf = (b: NeighborBuilding) => b.ring;

describe('新築の家に重なる建物の自動除外', () => {
  it('重なる建物だけを隠し、理由は「敷地内の既存建物（自動）」。手動の隣家は触らない', () => {
    const north = nb('north', sq(-4, 6, 8));
    const east = nb('east', sq(10, 0, 8));
    const manual = nb('manual-1', sq(-4, 6, 8), { source: 'manual' });
    const edits = emptyEdits();
    const n = autoHideOverlapping([north, east, manual], (b) => b.id === 'north' || b.id === 'manual-1', edits, keyOf, fpOf);
    expect(n).toBe(1);
    expect(north.hidden).toBe(true);
    expect(east.hidden).toBeFalsy();
    expect(manual.hidden).toBeFalsy();
    expect(edits.hideInfo.get('north')).toEqual({ mode: 'exclude', reason: 'onSite', note: AUTO_HIDE_NOTE });
    expect(hideReasonText(edits.hideInfo.get('north')!)).toBe('敷地内の既存建物（新築の家に重なるため自動）');
    expect(isAutoHidden(edits, 'north')).toBe(true);
    // 隠す記録には外形も残る（取り直しで同じ建物に当て直すため）
    expect(edits.footprints.get('north')).toEqual(north.ring);
  });

  it('利用者が戻した建物（keepVisible）は取り直しても隠し直さない', () => {
    const edits = emptyEdits();
    const north = nb('north', sq(-4, 6, 8));
    autoHideOverlapping([north], () => true, edits, keyOf, fpOf);
    // 「戻す」に相当: 記録を消して keepVisible に入れる
    edits.hidden.delete('north');
    edits.hideInfo.delete('north');
    edits.keepVisible.add('north');
    const again = nb('north', sq(-4, 6, 8));
    reapplyEdits([again], keyOf, fpOf, edits);
    const n = autoHideOverlapping([again], () => true, edits, keyOf, fpOf);
    expect(n).toBe(0);
    expect(again.hidden).toBeFalsy();
  });

  it('利用者が「表示だけ隠す」にした記録は上書きしない', () => {
    const edits = emptyEdits();
    edits.hidden.add('north');
    edits.hideInfo.set('north', { mode: 'view', reason: 'other', note: '隣家' });
    const north = nb('north', sq(-4, 6, 8));
    reapplyEdits([north], keyOf, fpOf, edits);
    const n = autoHideOverlapping([north], () => true, edits, keyOf, fpOf);
    expect(n).toBe(0);
    expect(north.hidden).toBe(true);
    expect(edits.hideInfo.get('north')!.mode).toBe('view');
    expect(isAutoHidden(edits, 'north')).toBe(false);
  });
});
