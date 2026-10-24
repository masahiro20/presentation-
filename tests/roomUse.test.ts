import { describe, it, expect } from 'vitest';
import { classifyRoomName, normalizeText } from '../src/parser/labels';
import { applyUseValue, useValueOf, useLabelOf, USE_GROUPS } from '../src/core/roomUse';
import { excludedFromFloorArea, isSeparateGarage, type BuildingModel, type Room } from '../src/core/types';
import { annexRows, ANNEX_UNIT } from '../src/estimate/funding';
import { furnitureDims, BUILTIN_VARIANTS, KITCHEN_TYPES } from '../src/scene/furniture';

describe('用途（ガレージ・外構）', () => {
  it('室名から外構の用途を読む', () => {
    expect(classifyRoomName('ウッドデッキ')).toBe('deck');
    expect(classifyRoomName('タイルテラス')).toBe('terrace');
    expect(classifyRoomName('ルーフテラス')).toBe('balcony');
    expect(classifyRoomName('カーポート')).toBe('carport');
    expect(classifyRoomName('駐車場')).toBe('parking');
    expect(classifyRoomName('外部物置')).toBe('shed');
    expect(classifyRoomName('物置')).toBe('storage');
    expect(classifyRoomName('ビルトインガレージ')).toBe('garage');
    expect(classifyRoomName('2Fﾎｰﾙ収納')).toBe('storage');
  });

  it('半角カナの室名も読む', () => {
    expect(normalizeText('ﾗﾝﾄﾞﾘｰ')).toBe('ランドリー');
    expect(classifyRoomName('ﾗﾝﾄﾞﾘｰ')).toBe('washroom');
    expect(classifyRoomName('ﾄｲﾚ')).toBe('toilet');
  });

  it('選択肢の値とガレージの建て方', () => {
    const r: { type: Room['type']; garageKind?: Room['garageKind'] } = { type: 'ldk' };
    applyUseValue(r, 'garage:attached');
    expect(r).toEqual({ type: 'garage', garageKind: 'attached' });
    expect(useValueOf(r)).toBe('garage:attached');
    expect(useLabelOf(r)).toMatch(/後付け/);
    expect(isSeparateGarage(r)).toBe(true);
    applyUseValue(r, 'deck');
    expect(r.garageKind).toBeUndefined();
    expect(useValueOf({ type: 'garage' })).toBe('garage:builtin');
    // すべての選択肢が一意
    const values = USE_GROUPS.flatMap((g) => g.options.map((o) => o.value));
    expect(new Set(values).size).toBe(values.length);
  });

  it('外構・ガレージは延床面積に入らない', () => {
    for (const t of ['garage', 'carport', 'parking', 'deck', 'terrace', 'shed', 'void', 'balcony', 'porch'] as const) expect(excludedFromFloorArea(t)).toBe(true);
    expect(excludedFromFloorArea('ldk')).toBe(false);
  });

  it('資金計画のガレージ・外構の概算', () => {
    const room = (type: Room['type'], area: number, garageKind?: Room['garageKind']): Room => ({ id: type, name: type, type, polygon: [], area, labelPos: { x: 0, y: 0 }, garageKind });
    const model = { name: 'x', northAngleDeg: 0, floors: [{ level: 1, rooms: [room('garage', 47, 'attached'), room('carport', 30), room('deck', 10), room('ldk', 40)] }] } as unknown as BuildingModel;
    const rows = annexRows(model);
    expect(rows.find((r) => r.id === 'annexGarage')?.amount).toBe(Math.round((47 * ANNEX_UNIT.garageSeparate) / 10000) * 10000);
    expect(rows.find((r) => r.id === 'annexCarport')?.amount).toBe(750000);
    expect(rows.find((r) => r.id === 'annexDeck')?.amount).toBe(350000);
    expect(annexRows(null)).toEqual([]);
  });
});

describe('造作家具・キッチンの型', () => {
  it('造作の形ごとの既定寸法', () => {
    for (const v of Object.keys(BUILTIN_VARIANTS) as (keyof typeof BUILTIN_VARIANTS)[]) {
      const d = furnitureDims({ id: 'a', kind: 'builtin', variant: v, x: 0, y: 0, rot: 0 });
      expect(d.w).toBe(BUILTIN_VARIANTS[v].w);
      expect(d.d).toBe(BUILTIN_VARIANTS[v].d);
    }
    expect(furnitureDims({ id: 'a', kind: 'builtin', variant: 'wallShelf', w: 3.2, x: 0, y: 0, rot: 0 }).w).toBe(3.2);
  });

  it('L 型キッチンは袖の分だけ奥行がある', () => {
    expect(KITCHEN_TYPES.map((k) => k[0])).toContain('l');
    expect(furnitureDims({ id: 'k', kind: 'kitchen', kitchenType: 'l', len: 3, x: 0, y: 0, rot: 0 }).d).toBeCloseTo(2.1);
    expect(furnitureDims({ id: 'k', kind: 'kitchen', kitchenType: 'wall', len: 3, x: 0, y: 0, rot: 0 }).d).toBeCloseTo(0.7);
  });
});
