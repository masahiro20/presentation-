/**
 * PDF の各ページに何の図面が入っているか（平面図・立面図・断面図・配置図・求積図・展開図・仕上表…）。
 *
 * 読み込み結果に「この PDF の中身」として出し、どのページを何に使ったか（何階の平面図・窓の高さ・高さの寸法）と、
 * 入っていない図面（立面図・3D データ）を足すと何が良くなるかの案内に使う。
 * 見分け方: 図面枠の「図面名」の欄の文字 → 無ければページの見出しの数（「南側 立面図」が 2 つ以上なら立面図）。
 */
import type { RawText } from './pdfExtract';

export type PageKind = 'plan' | 'elevation' | 'section' | 'interior' | 'site' | 'area' | 'finish' | 'fixture' | 'location' | 'index' | 'roof' | 'structure' | 'perspective' | 'other';

export const PAGE_KIND_LABEL: Record<PageKind, string> = {
  plan: '平面図',
  elevation: '立面図',
  section: '断面図・矩計図',
  interior: '展開図',
  site: '配置図',
  area: '求積図',
  finish: '仕上表',
  fixture: '建具表',
  location: '付近見取図',
  index: '図面リスト・表紙',
  roof: '屋根伏図',
  structure: '伏図',
  perspective: 'パース・写真',
  other: 'その他',
};

export interface PageInfo {
  /** 0 始まり */
  page: number;
  kind: PageKind;
  /** 図面名の欄・見出しから読んだ名前（無ければ種類の名前） */
  title: string;
  /** 読み取りに使ったこと（「1 階の平面図」「窓の高さ 9 か所」など）。使っていなければ空 */
  used?: string;
}

const norm = (s: string) =>
  s
    .replace(/[\s　]+/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\(\d+\)|（\d+）|[①-⑳]|\d+$/g, '');

/** 図面名の言葉 → 種類（先に当たったもの） */
const RULES: [RegExp, PageKind][] = [
  [/付近見取|案内図/, 'location'],
  [/求積/, 'area'],
  [/配置図/, 'site'],
  [/立面図/, 'elevation'],
  [/断面図|矩計図|かなばかり/, 'section'],
  [/展開図/, 'interior'],
  [/仕上表|仕上げ表|仕様書/, 'finish'],
  [/建具表|建具キープラン/, 'fixture'],
  [/屋根伏/, 'roof'],
  [/基礎伏|床伏|小屋伏|梁伏|伏図|プレカット/, 'structure'],
  [/パース|完成予想|イメージ/, 'perspective'],
  [/平面図|平面|PLAN|間取/i, 'plan'],
  [/図面リスト|図面目録|表紙|図面一覧/, 'index'],
];

function kindOf(s: string): PageKind | null {
  for (const [re, k] of RULES) if (re.test(s)) return k;
  return null;
}

/** 位置と大きさを持つ文字（ページの pt でも図面の mm でもよい。距離は文字の大きさを単位に測る） */
export interface PlacedText {
  str: string;
  x: number;
  y: number;
  size: number;
}

/** 図面枠の「図面名」の欄に書かれた名前（右か下の近い文字） */
export function titleBlockName(texts: PlacedText[]): string | null {
  const label = texts.find((t) => /^図面名(称)?$/.test(norm(t.str)));
  if (!label) return null;
  const u = Math.max(1e-6, label.size);
  let best: { s: string; d: number } | null = null;
  for (const t of texts) {
    if (t === label) continue;
    const s = norm(t.str);
    if (!s || s.length > 24 || !kindOf(s)) continue;
    const dx = (t.x - label.x) / u;
    const dy = (t.y - label.y) / u;
    // 右（同じ行〜少し下）か、すぐ下
    if (dx < -1 || dx > 35 || dy < -1.5 || dy > 6) continue;
    const d = Math.hypot(dx, dy * 2);
    if (!best || d < best.d) best = { s: t.str.replace(/[\s　]+/g, ''), d };
  }
  return best?.s ?? null;
}

/** 図面名の欄の名前の種類（平面図以外の図面か） */
export function titleBlockKind(texts: PlacedText[]): PageKind | null {
  const name = titleBlockName(texts);
  return name ? kindOf(norm(name)) : null;
}

/**
 * ページの種類を決める。
 * @param planFloors このページから読んだ階（平面図として使った階の番号）
 */
export function classifyPage(texts: RawText[], segCount: number, planFloors: number[]): { kind: PageKind; title: string } {
  if (planFloors.length) return { kind: 'plan', title: `${planFloors.join('・')}階 平面図` };
  const name = titleBlockName(texts.map((t) => ({ str: t.str, x: t.cx, y: t.cy, size: t.size })));
  // 見出しの数
  const counts = new Map<PageKind, number>();
  let elevDirs = 0;
  for (const t of texts) {
    const s = norm(t.str);
    if (s.length > 20) continue;
    if (/^(東|西|南|北)(側|面)?(立面図?)?$/.test(s)) elevDirs++;
    const k = kindOf(s);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // 図面リスト（1 ページに 4 種類以上の図面名が並び、線が少ない）
  if (counts.size >= 4 && segCount < 8000 && !name) return { kind: 'index', title: '図面リスト' };
  if (name) {
    const k = kindOf(norm(name))!;
    // 図面リストの表紙で図面名の欄に「図面リスト」以外が書かれている場合
    if (counts.size >= 5 && segCount < 8000) return { kind: 'index', title: '図面リスト' };
    return { kind: k, title: name };
  }
  if (elevDirs >= 2) return { kind: 'elevation', title: '立面図' };
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) return { kind: top[0], title: PAGE_KIND_LABEL[top[0]] };
  return { kind: 'other', title: segCount < 50 ? '文字・画像のページ' : 'その他' };
}

/** 入っていると精度が上がる図面のうち、PDF に無いもの */
export function missingHelpers(pages: PageInfo[]): PageKind[] {
  const have = new Set(pages.map((p) => p.kind));
  return (['elevation', 'section'] as PageKind[]).filter((k) => !have.has(k));
}
