import { describe, it, expect } from 'vitest';
import { planSummary, diffPlans, costDiff } from '../src/core/planDiff';
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

  it('増減表: 工事ごとの差（今回 − 前回）、端数の揺れは省く、前回だけの工事は最後、工事の金額も要約に残る', () => {
    const prev = [
      { id: 'temp', name: '仮設工事', amount: 500_000 },
      { id: 'wood', name: '木工事', amount: 6_000_000 },
      { id: 'roof', name: '屋根工事', amount: 900_000 },
      { id: 'old', name: '解体工事', amount: 300_000 },
    ];
    const cur = [
      { id: 'temp', name: '仮設工事', amount: 500_400 },
      { id: 'wood', name: '木工事', amount: 6_450_000 },
      { id: 'roof', name: '屋根工事', amount: 820_000 },
    ];
    const d = costDiff(prev, cur);
    expect(d.rows.map((r) => r.id)).toEqual(['wood', 'roof', 'old']);
    expect(d.rows[0].delta).toBe(450_000);
    expect(d.rows[1].delta).toBe(-80_000);
    expect(d.rows[2]).toMatchObject({ prev: 300_000, cur: 0, delta: -300_000 });
    expect(d.curTotal - d.prevTotal).toBe(500_400 + 6_450_000 + 820_000 - 7_700_000);
  });
});

