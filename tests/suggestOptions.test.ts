import { describe, expect, it } from 'vitest';
import { suggestOptions } from '../src/estimate/suggest';
import { takeoff } from '../src/estimate/areas';
import { newChoice } from '../src/estimate/calc';
import type { BuildingModel, Floor, Room } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (id: string, name: string, type: Room['type'], poly: { x: number; y: number }[], extra: Partial<Room> = {}): Room =>
  ({ id, name, type, polygon: poly, area: Math.abs(poly.reduce((s, p, i) => s + p.x * poly[(i + 1) % poly.length].y - poly[(i + 1) % poly.length].x * p.y, 0)) / 2e6, ...extra }) as Room;
const floor = (level: number, outline: { x: number; y: number }[][], rooms: Room[], openings: Floor['openings'] = []): Floor =>
  ({ level, height: 2900, ceilingHeight: 2400, elevation: 500 + (level - 1) * 2900, outline, rooms, walls: [], openings, stairs: [] }) as unknown as Floor;

describe('この間取りで検討するオプションの提案', () => {
  const f1 = floor(
    1,
    [rect(0, 0, 10000, 8000)],
    [room('g', 'ガレージ', 'garage', rect(0, 0, 5500, 6000)), room('l', 'ＬＤＫ', 'ldk', rect(5500, 0, 10000, 8000), { ceilingHeight: 3500 }), room('w', 'ランドリー', 'washroom', rect(0, 6000, 5500, 8000))],
    [{ id: 's1', wallId: 'w1', kind: 'shutter', t0: 80, t1: 5420, sill: 0, height: 2300, confidence: 1 }],
  );
  const f2 = floor(2, [rect(0, 0, 10000, 8000)], [room('v', '吹抜', 'void', rect(5500, 0, 8000, 3000)), room('b', '寝室', 'bedroom', rect(0, 0, 5500, 8000)), room('t', 'トイレ', 'toilet', rect(8000, 0, 10000, 2000))]);
  const model = { floors: [f1, f2] } as unknown as BuildingModel;
  const areas = takeoff(model, { grade: 'P', eavesMm: 0, pitch: 0.5, roofType: 'flat' });

  it('ガレージ → 電動シャッター（2 台一体）と EV コンセント、吹抜 → 手摺、高天井、2 階トイレ → 手洗い、ランドリー → スロップシンク・幹太くん', () => {
    const s = suggestOptions(model, areas, newChoice('P'));
    const ids = s.map((x) => x.lineId ?? x.flag ?? x.label);
    expect(ids).toContain('sash.shutterElec2');
    expect(ids).toContain('evOutlet');
    expect(ids).toContain('ib.handrail');
    // 高天井は拾いで自動計上（LDK 36 ㎡ × (3,500 − 2,500) = 36 ㎥）し、提案には「計上済み」として出る
    expect(areas.highCeil).toBeCloseTo(36, 1);
    expect(s.find((x) => /^高天井/.test(x.label))?.applied).toBe(true);
    expect(ids).toContain('handwash');
    expect(ids).toContain('slopSink');
    expect(ids).toContain('kanta');
    expect(s.find((x) => x.lineId === 'sash.shutterElec2')?.qty).toBe(1);
    expect(s.every((x) => x.reason.length > 0)).toBe(true);
  });
  it('入れたものは applied になる', () => {
    const choice = newChoice('P');
    choice.qty['sash.shutterElec2'] = 1;
    const s = suggestOptions(model, { ...areas, evOutlet: true }, choice);
    expect(s.find((x) => x.lineId === 'sash.shutterElec2')?.applied).toBe(true);
    expect(s.find((x) => x.flag === 'evOutlet')?.applied).toBe(true);
  });
});
