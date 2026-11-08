/**
 * 月々の支払い試算（スタッフ用。アイデア台帳 S3）。資金計画の総合計から、頭金・金利・年数・ボーナス払い・年収で
 * 月々の返済額・総返済額・利息・返済負担率を出す。元利均等。画面に依らない純粋な計算
 */
import { monthlyPayment } from './funding';

export interface LoanSimInput {
  /** 総合計（円）。借入額 = 総合計 − 頭金 */
  grand: number;
  /** 頭金（万円） */
  downMan: number;
  /** 金利（%/年） */
  ratePct: number;
  years: number;
  /** ボーナス払い（万円／回。年 2 回）。0 で無し */
  bonusMan: number;
  /** 年収（万円）。0 なら負担率は出さない */
  incomeMan: number;
}

export interface LoanSimResult {
  /** 借入額（円） */
  principal: number;
  /** ボーナス返済に充てる元金（円） */
  bonusPrincipal: number;
  /** 月々（円） */
  monthly: number;
  /** ボーナス月の加算（円／回） */
  bonus: number;
  /** 年間返済額（円） */
  yearly: number;
  /** 総返済額・利息（円） */
  total: number;
  interest: number;
  /** 返済負担率（%）。年収が無ければ null */
  ratio: number | null;
}

export function loanPlan(i: LoanSimInput): LoanSimResult {
  const principal = Math.max(0, Math.round(i.grand - i.downMan * 10000));
  const years = Math.max(1, Math.round(i.years));
  // ボーナス払い: 年 2 回 × 年数ぶんの元利均等（半年複利の近似として月払いと同じ式を 2 回／年で）
  const bonusPerTime = Math.max(0, i.bonusMan) * 10000;
  let bonusPrincipal = 0;
  if (bonusPerTime > 0) {
    const r = i.ratePct / 100 / 2;
    const n = years * 2;
    bonusPrincipal = r === 0 ? bonusPerTime * n : (bonusPerTime * (1 - Math.pow(1 + r, -n))) / r;
    bonusPrincipal = Math.min(principal * 0.5, Math.round(bonusPrincipal));
  }
  const monthlyPrincipal = principal - bonusPrincipal;
  // 銀行の試算と同じく円未満は切り捨て（3,000 万・35 年・1.0% → 84,685 円）
  const monthly = Math.floor(monthlyPayment(monthlyPrincipal, years, i.ratePct));
  const bonus = bonusPrincipal > 0 ? Math.round(bonusPerTime) : 0;
  const yearly = monthly * 12 + bonus * 2;
  const total = yearly * years;
  return { principal, bonusPrincipal, monthly, bonus, yearly, total, interest: Math.max(0, total - principal), ratio: i.incomeMan > 0 ? +((yearly / (i.incomeMan * 10000)) * 100).toFixed(1) : null };
}

/** 金利・年数を振った比較表（スタッフが「35 年で 1% 上がると月 +1.4 万」を即答するため） */
export function loanTable(i: LoanSimInput, rates = [0.5, 1.0, 1.5, 2.0], yearsList = [30, 35, 40]): { rate: number; cells: { years: number; monthly: number }[] }[] {
  return rates.map((rate) => ({ rate, cells: yearsList.map((years) => ({ years, monthly: loanPlan({ ...i, ratePct: rate, years }).monthly })) }));
}
