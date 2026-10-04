import { describe, it, expect } from 'vitest';
import { scoreFloor, type TruthFloor } from '../src/eval/accuracy';

const box = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const wall = (ax: number, ay: number, bx: number, by: number) => ({ a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 120, exterior: true });

const truth: TruthFloor = {
  level: 1,
  walls: [wall(0, 0, 8000, 0), wall(8000, 0, 8000, 6000), wall(8000, 6000, 0, 6000), wall(0, 6000, 0, 0), wall(4000, 0, 4000, 6000)],
  openings: [{ kind: 'window', width: 1690, center: { x: 2000, y: 0 } }],
  rooms: [
    { name: 'LDK', type: 'ldk', area: 24, polygon: box(0, 0, 4000, 6000) },
    { name: '寝室', type: 'bedroom', area: 24, polygon: box(4000, 0, 8000, 6000) },
  ],
};

describe('読み取り精度の測定', () => {
  it('正解と同じなら満点', () => {
    const s = scoreFloor(truth, truth);
    expect(s.score).toBe(100);
    expect(s.fixes).toBe(0);
  });
  it('仕切りの壁が無く部屋がつながっていると減点', () => {
    const auto: TruthFloor = { ...truth, walls: truth.walls.slice(0, 4), rooms: [{ name: 'LDK', type: 'ldk', area: 48, polygon: box(0, 0, 8000, 6000) }], openings: [{ kind: 'sliding', width: 1690, center: { x: 2050, y: 0 } }] };
    const s = scoreFloor(auto, truth);
    expect(s.roomRecall).toBe(0);
    expect(s.wallRecall).toBeLessThan(0.9);
    expect(s.openingRecall).toBe(1);
    expect(s.openingKindAccuracy).toBe(0);
    expect(s.fixes).toBeGreaterThanOrEqual(4);
    expect(s.score).toBeLessThan(70);
  });
});
