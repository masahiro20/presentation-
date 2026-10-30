import { describe, it, expect } from 'vitest';
import { planSummary, diffPlans } from '../src/core/planDiff';
import { parseSample } from './pdfNode';

describe('プランの差分', () => {
  it('同じプランなら変更なし、部屋の増減と帖数の変化を拾う', async () => {
    const model = await parseSample('sample_house_A3.pdf');
    const a = planSummary(model, 'A.pdf', 32_000_000);
    const b = planSummary(model, 'B.pdf', 32_000_000);
    expect(diffPlans(a, b)).toEqual([]);
    // 2 階の部屋を 1 つ消し、1 階の最初の部屋を 1.5 帖広げ、金額を上げる
    const c = JSON.parse(JSON.stringify(b)) as typeof b;
    const removed = c.floors[1].rooms.pop()!;
    c.floors[0].rooms[0].tatami += 1.5;
    c.grand = 32_500_000;
    const ch = diffPlans(a, c);
    expect(ch.some((x) => x.kind === 'room-remove' && x.text.includes(removed.name))).toBe(true);
    expect(ch.some((x) => x.kind === 'room-size' && x.delta === 1.5)).toBe(true);
    expect(ch.find((x) => x.kind === 'cost')?.text).toContain('3,250 万円');
  });
});
