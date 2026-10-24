/** 見積の計算: 価格表 × 数量 → 行・工事ごとの小計・合計・税 */
import { AMOUNT_ROUND, CATEGORIES, type CategoryDef, type Grade, type LineDef } from './catalog';
import type { Areas } from './areas';

/** 設計士の選択・上書き（保存する） */
export interface EstimateChoice {
  grade: Grade;
  /** group ごとに選んだ行の id */
  groups: Record<string, string>;
  /** 数量の上書き（行 id → 数量） */
  qty: Record<string, number>;
  /** 外した行 */
  off: string[];
  /** 自由追加の行 */
  extras: { id: string; cat: string; desc: string; unit: string; price: number; cost: number; qty: number }[];
  /** 端数調整の単位（円）。税抜の小計をこの単位に切り捨てる（0 = 調整しない）。既定 10,000 */
  roundUnit?: number;
}

export interface LineResult {
  def?: LineDef;
  id: string;
  cat: string;
  spec: string;
  desc: string;
  unit: string;
  unitPrice: number;
  unitCost: number;
  qty: number;
  qtyAuto: number;
  qtyNote?: string;
  amount: number;
  cost: number;
  selected: boolean;
  group?: string;
  optional: boolean;
  extra?: boolean;
}

export interface CategoryResult {
  def: CategoryDef;
  lines: LineResult[];
  amount: number;
  cost: number;
}

export interface EstimateResult {
  categories: CategoryResult[];
  /** 端数調整前の小計（各工事の合計） */
  rawSubtotal: number;
  /** 端数調整（マイナス。小計を万円・千円単位に切り捨てる） */
  adjust: number;
  subtotal: number;
  cost: number;
  tax: number;
  total: number;
  /** 坪単価（延床） */
  perTsubo: number;
}

export const TAX_RATE = 0.1;

export function roundDown(v: number, digits: number): number {
  const k = Math.pow(10, -digits);
  return Math.floor(v / k) * k;
}

export function unitPriceOf(l: LineDef): number {
  if (l.fixedPrice != null) return l.fixedPrice;
  return roundDown(l.cost / (l.margin ?? 0.7), l.round ?? -1);
}

/** group の既定（グレードごと） */
export function defaultGroups(grade: Grade): Record<string, string> {
  const g: Record<string, string> = {};
  for (const c of CATEGORIES)
    for (const l of c.lines) {
      if (!l.group || g[l.group]) continue;
      if (l.on === 'both' || (Array.isArray(l.on) && l.on.includes(grade))) g[l.group] = l.id;
    }
  // 既定が無い group は先頭
  for (const c of CATEGORIES) for (const l of c.lines) if (l.group && !g[l.group]) g[l.group] = l.id;
  return g;
}

/** 新しい見積の選択。areas を渡すと、図面から読んだキッチンの形（アイランド・壁付け）を既定にする */
export function newChoice(grade: Grade, areas?: Pick<Areas, 'kitchenType'>): EstimateChoice {
  const groups = defaultGroups(grade);
  if (areas?.kitchenType === 'island') groups.kitchen = 'eq.kitchenHlIsland';
  else if (areas?.kitchenType === 'wall' || areas?.kitchenType === 'two' || areas?.kitchenType === 'l') groups.kitchen = 'eq.kitchenHlWall';
  return { grade, groups, qty: {}, off: [], extras: [], roundUnit: 10000 };
}

function isOn(l: LineDef, choice: EstimateChoice): boolean {
  if (choice.off.includes(l.id)) return false;
  if (l.group) return (choice.groups[l.group] ?? defaultGroups(choice.grade)[l.group]) === l.id;
  if (l.on === 'none') return false;
  if (l.on === 'both' || l.on == null) return true;
  return l.on.includes(choice.grade);
}

/** 選んだ行から決まる数量側の条件（給湯の種類など） */
function deriveAreas(a: Areas, choice: EstimateChoice): Areas {
  const water = choice.groups.water ?? '';
  return { ...a, waterHeater: /ecocute/.test(water) ? 'ecocute' : 'gas' };
}

export function computeEstimate(areasIn: Areas, choice: EstimateChoice): EstimateResult {
  const a = deriveAreas(areasIn, choice);
  const categories: CategoryResult[] = CATEGORIES.map((def) => {
    const lines: LineResult[] = def.lines.map((l) => {
      const selected = isOn(l, choice);
      const qtyAuto = l.qty ? Math.max(0, l.qty(a)) : 1;
      const qty = selected ? (choice.qty[l.id] ?? qtyAuto) : 0;
      const unitPrice = unitPriceOf(l);
      const amount = roundDown(unitPrice * qty, AMOUNT_ROUND[def.id] ?? -1);
      return { def: l, id: l.id, cat: def.id, spec: l.spec, desc: l.desc, unit: l.unit, unitPrice, unitCost: l.cost, qty, qtyAuto, qtyNote: l.qtyNote, amount, cost: l.cost * qty, selected, group: l.group, optional: !!l.optional };
    });
    for (const x of choice.extras.filter((e) => e.cat === def.id)) {
      lines.push({ id: x.id, cat: def.id, spec: '追加', desc: x.desc, unit: x.unit, unitPrice: x.price, unitCost: x.cost, qty: x.qty, qtyAuto: x.qty, amount: roundDown(x.price * x.qty, -1), cost: x.cost * x.qty, selected: x.qty > 0, optional: true, extra: true });
    }
    return { def, lines, amount: lines.reduce((s, l) => s + l.amount, 0), cost: lines.reduce((s, l) => s + l.cost, 0) };
  });
  const rawSubtotal = categories.reduce((s, c) => s + c.amount, 0);
  const unit = choice.roundUnit ?? 10000;
  const adjust = unit > 0 && rawSubtotal > 0 ? -(rawSubtotal % unit) : 0;
  const subtotal = rawSubtotal + adjust;
  const cost = categories.reduce((s, c) => s + c.cost, 0);
  const tax = Math.floor(subtotal * TAX_RATE);
  return { categories, rawSubtotal, adjust, subtotal, cost, tax, total: subtotal + tax, perTsubo: a.totalTsubo > 0 ? subtotal / a.totalTsubo : 0 };
}

export const yen = (v: number) => `${Math.round(v).toLocaleString('ja-JP')}`;
