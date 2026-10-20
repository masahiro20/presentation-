/**
 * 記号辞書: 図面の長方形の「形」（部屋の種類・大きさ・中の線の数）と、それが何だったか（修正画面で直した答え）を覚える。
 * 御社の図面はテンプレートが決まっているので、一度直した形は次の図面でも同じ答えになる。
 * ブラウザの localStorage とプロジェクトファイルに保存し、外部には出さない。
 */
import type { FurnitureKind, RoomType } from '../core/types';
import { SYMBOL_DICT_SEED } from './symbolDictSeed';

/**
 * 出どころ:
 *  - user: 修正画面で直した答え。規則より優先する
 *  - bulk: 「過去の図面から一括学習」で集めた答え。規則で決まらなかった候補にだけ使う
 *  - seed: 同梱の初期辞書（御社の過去プランから）。bulk と同じ扱い
 */
export type SymbolSource = 'user' | 'bulk' | 'seed';

export interface SymbolSignature {
  room: RoomType;
  /** 長手・短手 (mm, 50 刻み) */
  L: number;
  S: number;
  /** 中の線の数の段階（0, 1〜3, 4〜9, 10〜） */
  innerClass: number;
  kind: FurnitureKind;
  /** 覚えた回数 */
  n: number;
  source?: SymbolSource;
}

const q50 = (v: number) => Math.round(v / 50) * 50;
const innerClassOf = (n: number) => (n <= 0 ? 0 : n <= 3 ? 1 : n <= 9 ? 2 : 3);

export function signatureOf(room: RoomType, w: number, h: number, inner: number): Omit<SymbolSignature, 'kind' | 'n'> {
  return { room, L: q50(Math.max(w, h)), S: q50(Math.min(w, h)), innerClass: innerClassOf(inner) };
}

type Sig = Omit<SymbolSignature, 'kind' | 'n' | 'source'>;

const sourceOf = (e: SymbolSignature): SymbolSource => e.source ?? 'user';

/**
 * 辞書に同じ形（±50mm）があればその種類。
 * which = 'user' なら修正で覚えた答えだけ、'fallback' なら一括学習・初期辞書だけ、省略時は user を優先して全部
 */
export function lookupSymbol(dict: SymbolSignature[], sig: Sig, which: 'user' | 'fallback' | 'any' = 'any'): FurnitureKind | null {
  let best: SymbolSignature | null = null;
  const rank = (e: SymbolSignature) => (sourceOf(e) === 'user' ? 1 : 0);
  for (const e of dict) {
    const src = sourceOf(e);
    if (which === 'user' && src !== 'user') continue;
    if (which === 'fallback' && src === 'user') continue;
    if (e.room !== sig.room || e.innerClass !== sig.innerClass) continue;
    if (Math.abs(e.L - sig.L) > 50 || Math.abs(e.S - sig.S) > 50) continue;
    if (!best || rank(e) > rank(best) || (rank(e) === rank(best) && e.n > best.n)) best = e;
  }
  return best?.kind ?? null;
}

/** 答えを覚える（同じ形で別の答えが多数なら上書きされる） */
export function learnSymbol(dict: SymbolSignature[], sig: Sig, kind: FurnitureKind, source: SymbolSource = 'user'): SymbolSignature[] {
  const e = dict.find((x) => sourceOf(x) === source && x.room === sig.room && x.innerClass === sig.innerClass && x.L === sig.L && x.S === sig.S && x.kind === kind);
  if (e) e.n++;
  else dict.push({ ...sig, kind, n: 1, source });
  return dict;
}

const KEY = 'symbolDict';

/** 同梱の初期辞書（seed） */
export function seedDict(): SymbolSignature[] {
  return SYMBOL_DICT_SEED.map((e) => ({ ...e, source: 'seed' as const }));
}

/** 保存してある分（修正から・一括学習）だけ */
export function loadStoredDict(): SymbolSignature[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as SymbolSignature[]) : [];
    return Array.isArray(arr) ? arr.filter((e) => e && typeof e === 'object' && e.room && e.kind).map((e) => ({ ...e, source: e.source === 'bulk' ? 'bulk' : 'user' })) : [];
  } catch {
    return [];
  }
}

/** 読み取りに使う辞書 = 初期辞書 + 保存してある分 */
export function loadSymbolDict(): SymbolSignature[] {
  return [...seedDict(), ...loadStoredDict()];
}

/** 保存する（初期辞書は保存しない） */
export function saveSymbolDict(dict: SymbolSignature[]) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(dict.filter((e) => sourceOf(e) !== 'seed')));
  } catch {
    /* 保存できない環境は無視 */
  }
}

/** 出どころごとの件数 */
export function countDict(dict: SymbolSignature[]): Record<SymbolSource, number> {
  const c: Record<SymbolSource, number> = { user: 0, bulk: 0, seed: 0 };
  for (const e of dict) c[sourceOf(e)]++;
  return c;
}

/** JSON（書き出し用: 初期辞書は含めない） */
export function exportDict(dict: SymbolSignature[]): string {
  return JSON.stringify({ format: 'madori-symbol-dict-v1', entries: dict.filter((e) => sourceOf(e) !== 'seed') }, null, 1);
}

/** JSON を取り込んで足す（同じ形・同じ答えは回数を足す）。戻り値は足した件数 */
export function importDict(dict: SymbolSignature[], json: string): number {
  const obj = JSON.parse(json) as { format?: string; entries?: SymbolSignature[] } | SymbolSignature[];
  const entries = Array.isArray(obj) ? obj : obj.entries;
  if (!Array.isArray(entries)) throw new Error('辞書の JSON ではありません');
  let n = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object' || !e.room || !e.kind || typeof e.L !== 'number' || typeof e.S !== 'number') continue;
    const src: SymbolSource = e.source === 'bulk' ? 'bulk' : 'user';
    const found = dict.find((x) => sourceOf(x) === src && x.room === e.room && x.innerClass === e.innerClass && x.L === e.L && x.S === e.S && x.kind === e.kind);
    if (found) found.n += Math.max(1, e.n | 0);
    else dict.push({ room: e.room, L: e.L, S: e.S, innerClass: e.innerClass | 0, kind: e.kind, n: Math.max(1, e.n | 0), source: src });
    n++;
  }
  return n;
}
