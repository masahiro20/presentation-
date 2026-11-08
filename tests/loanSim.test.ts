import { describe, expect, it } from 'vitest';
import { monthlyPayment } from '../src/estimate/funding';
import { loanPlan, loanTable } from '../src/estimate/loanSim';

describe('月々の支払い試算（loanSim）', () => {
  it('3,000 万円・35 年・1.0% の元利均等は月々 84,685 円、総返済 約 3,557 万円', () => {
    const r = loanPlan({ grand: 30000000, downMan: 0, ratePct: 1.0, years: 35, bonusMan: 0, incomeMan: 0 });
    expect(r.principal).toBe(30000000);
    expect(r.monthly).toBe(84685);
    expect(r.bonus).toBe(0);
    expect(r.total).toBe(84685 * 12 * 35);
    expect(r.interest).toBe(84685 * 12 * 35 - 30000000);
    expect(r.ratio).toBeNull();
  });

  it('頭金を引いた額が借入額になり、年収を入れると返済負担率（%）が出る', () => {
    const r = loanPlan({ grand: 38000000, downMan: 800, ratePct: 0.8, years: 35, bonusMan: 0, incomeMan: 600 });
    expect(r.principal).toBe(30000000);
    expect(r.monthly).toBe(Math.floor(monthlyPayment(30000000, 35, 0.8)));
    expect(r.ratio).toBe(+(((r.monthly * 12) / 6000000) * 100).toFixed(1));
  });

  it('ボーナス払いを入れると月々が減り、ボーナス月に加算が出る（元金の半分まで）', () => {
    const a = loanPlan({ grand: 30000000, downMan: 0, ratePct: 1.0, years: 35, bonusMan: 0, incomeMan: 0 });
    const b = loanPlan({ grand: 30000000, downMan: 0, ratePct: 1.0, years: 35, bonusMan: 10, incomeMan: 0 });
    expect(b.bonus).toBe(100000);
    expect(b.monthly).toBeLessThan(a.monthly);
    expect(b.bonusPrincipal).toBeGreaterThan(5000000);
    expect(b.bonusPrincipal).toBeLessThanOrEqual(15000000);
    expect(b.yearly).toBe(b.monthly * 12 + 200000);
  });

  it('金利・年数の比較表: 金利が高いほど・年数が短いほど月々が大きい', () => {
    const t = loanTable({ grand: 30000000, downMan: 0, ratePct: 1.0, years: 35, bonusMan: 0, incomeMan: 0 });
    expect(t.map((r) => r.rate)).toEqual([0.5, 1.0, 1.5, 2.0]);
    expect(t[1].cells.find((c) => c.years === 35)!.monthly).toBe(84685);
    expect(t[3].cells[1].monthly).toBeGreaterThan(t[0].cells[1].monthly);
    expect(t[1].cells[0].monthly).toBeGreaterThan(t[1].cells[2].monthly);
  });
});
