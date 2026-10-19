/**
 * 記号辞書: 図面の長方形の「形」（部屋の種類・大きさ・中の線の数）と、それが何だったか（修正画面で直した答え）を覚える。
 * 御社の図面はテンプレートが決まっているので、一度直した形は次の図面でも同じ答えになる。
 * ブラウザの localStorage とプロジェクトファイルに保存し、外部には出さない。
 */
import type { FurnitureKind, RoomType } from '../core/types';

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
}

const q50 = (v: number) => Math.round(v / 50) * 50;
const innerClassOf = (n: number) => (n <= 0 ? 0 : n <= 3 ? 1 : n <= 9 ? 2 : 3);

export function signatureOf(room: RoomType, w: number, h: number, inner: number): Omit<SymbolSignature, 'kind' | 'n'> {
  return { room, L: q50(Math.max(w, h)), S: q50(Math.min(w, h)), innerClass: innerClassOf(inner) };
}

/** 辞書に同じ形（±50mm）があればその種類 */
export function lookupSymbol(dict: SymbolSignature[], sig: Omit<SymbolSignature, 'kind' | 'n'>): FurnitureKind | null {
  let best: SymbolSignature | null = null;
  for (const e of dict) {
    if (e.room !== sig.room || e.innerClass !== sig.innerClass) continue;
    if (Math.abs(e.L - sig.L) > 50 || Math.abs(e.S - sig.S) > 50) continue;
    if (!best || e.n > best.n) best = e;
  }
  return best?.kind ?? null;
}

/** 答えを覚える（同じ形で別の答えが多数なら上書きされる） */
export function learnSymbol(dict: SymbolSignature[], sig: Omit<SymbolSignature, 'kind' | 'n'>, kind: FurnitureKind): SymbolSignature[] {
  const e = dict.find((x) => x.room === sig.room && x.innerClass === sig.innerClass && x.L === sig.L && x.S === sig.S && x.kind === kind);
  if (e) e.n++;
  else dict.push({ ...sig, kind, n: 1 });
  return dict;
}

const KEY = 'symbolDict';

export function loadSymbolDict(): SymbolSignature[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SymbolSignature[]) : [];
  } catch {
    return [];
  }
}

export function saveSymbolDict(dict: SymbolSignature[]) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(dict));
  } catch {
    /* 保存できない環境は無視 */
  }
}
