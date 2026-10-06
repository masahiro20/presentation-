/**
 * 室名テキストの解釈
 */
import type { RoomType } from '../core/types';

export function normalizeText(s: string): string {
  return s
    .replace(/[０-９Ａ-Ｚａ-ｚ．，：／＝（）]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .toUpperCase();
}

const RULES: [RegExp, RoomType][] = [
  [/吹抜|吹き抜け|VOID/, 'void'],
  [/中庭|坪庭|光庭|ライトコート|COURT|^庭[①-⑳0-9]*$/, 'balcony'],
  // 収納系は「〇〇クローゼット」「土間収納」など他の語を含むので先に判定
  [/土間収納|シューズ(クローク|クローゼット|イン|ボックス)?|^S\.?I\.?C|^S\.?C\.?L|^S\.?C$|^S\.?B$|玄関収納/, 'storage'],
  [/パントリー|PANTRY|^PAN$|^P\.?T$|食品庫/, 'storage'],
  [/ファミリークローゼット|ファミクロ|^F\.?C\.?L|^F\.?C$/, 'closet'],
  [/W\.?I\.?C|W\.?I\.?C\.?L|ウォークイン|ウォーク・イン|W\.?C\.?L|クローゼット|クロゼット|^CL\d*$|^C\.?L\d*$|^CLO$|押入|押し入れ|床の間|仏間|^物$|^収$/, 'closet'],
  [/^L\.?D\.?K|LDK|リビング.*ダイニング.*キッチン/, 'ldk'],
  [/^L\.?D$|^LD\b|^LD\d|リビングダイニング|リビング・ダイニング/, 'ldk'],
  [/^D\.?K$|^DK\d|ダイニングキッチン/, 'dining'],
  [/リビング|居間|LIVING|^L$|ファミリースペース|くつろぎ/, 'living'],
  [/ダイニング|食堂|DINING|^D$/, 'dining'],
  [/キッチン|台所|KITCHEN|^K$|^KIT$/, 'kitchen'],
  [/和室|座敷|客間|茶の間|畳コーナー|畳スペース|タタミ|小上がり|小上り|^畳$/, 'japanese'],
  [/子供|子ども|こども|キッズ|子室|KIDS|CHILD/, 'kids'],
  [/主寝室|寝室|ベッドルーム|MBR|BEDROOM|^BR\d*$|^B\.?R\d*$/, 'bedroom'],
  [/洋室|個室|^室\d*$|^居室|ゲストルーム|GUEST/, 'bedroom'],
  [/書斎|ワーク|スタディ|STUDY|^DEN$|趣味|ヌック|NOOK|テレワーク|WORK|ライブラリー|シアター/, 'study'],
  [/浴室|バスルーム|^バス$|風呂|^UB$|^U\.?B$|ユニットバス|BATH|^浴$/, 'bath'],
  [/洗面|脱衣|ランドリー|家事室|サニタリー|UTILITY|ユーティリティ|^UT$|^U\.?T$|洗濯|^洗$|LAUNDRY|ドレッサー|身支度/, 'washroom'],
  [/トイレ|便所|^W\.?C$|TOILET|^WC\d*$|^トイ$|化粧室/, 'toilet'],
  [/玄関|エントランス|土間|ENTRANCE|^ENT$/, 'entrance'],
  [/ホール|廊下|HALL|ろうか|通路/, 'hall'],
  [/階段|STAIRS?/, 'stairs'],
  [/納戸|物入|収納|^S$|^P\.?S$|物置|倉庫|STORAGE|^収$|ロフト|LOFT|小屋裏|グルニエ|^ST$/, 'storage'],
  [/バルコニー|ベランダ|テラス|ルーフバルコニー|デッキ|BALCONY|屋上|インナーバルコニー|ガーデン|ルーフ|^OPEN$|物干/, 'balcony'],
  [/ポーチ|PORCH/, 'porch'],
  [/ガレージ|車庫|ビルトイン|GARAGE|カーポート/, 'garage'],
];

export function classifyRoomName(raw: string): RoomType | null {
  const s = normalizeText(raw);
  if (!s) return null;
  for (const [re, t] of RULES) if (re.test(s)) return t;
  return null;
}

/** 「20.0帖」「6畳」「12.5J」「16.56㎡」 */
export function parseAreaLabel(raw: string): { tatami?: number; m2?: number } | null {
  const s = normalizeText(raw);
  let m = /(\d+(?:\.\d+)?)(?:帖|畳|J|じょう|ジョウ)/.exec(s);
  if (m) return { tatami: parseFloat(m[1]) };
  m = /(\d+(?:\.\d+)?)(?:㎡|M2|M²|平米)/.exec(s);
  if (m) return { m2: parseFloat(m[1]) };
  return null;
}

export function parseStairMark(raw: string): 'up' | 'down' | null {
  const s = normalizeText(raw);
  if (/^(UP|上り?|↑)$/.test(s)) return 'up';
  if (/^(DN|DOWN|下り?|↓)$/.test(s)) return 'down';
  return null;
}

/** 「1階平面図」「2F」「１Ｆ平面図」→ 階数 */
export function parseFloorTitle(raw: string): number | null {
  const s = normalizeText(raw);
  const kanji: Record<string, number> = { 一: 1, 二: 2, 三: 3, 地下: -1 };
  let m = /([1-4])(?:階|F|FL)(?:平面|PLAN|$)/.exec(s);
  if (m) return parseInt(m[1], 10);
  m = /(一|二|三)階/.exec(s);
  if (m) return kanji[m[1]];
  m = /^([1-4])F$/.exec(s);
  if (m) return parseInt(m[1], 10);
  if (/屋根伏|ROOF/.test(s)) return null;
  return null;
}

/** サッシ記号の高さ記号 → 内法高さ (mm)。幅は上 3 桁 ×10 */
const SASH_HEIGHT: Record<string, number> = {
  '03': 370,
  '05': 570,
  '07': 770,
  '09': 970,
  '11': 1170,
  '13': 1370,
  '15': 1570,
  '18': 1830,
  '20': 2030,
  '22': 2230,
  '24': 2430,
};

/** 「16511」「07405」などのサッシ記号 → 幅・高さ (mm) */
export function parseSashCode(raw: string): { width: number; height: number } | null {
  const s = normalizeText(raw).replace(/^[A-Z]{1,2}[-・]?/, '');
  const m = /^(\d{3})(\d{2})$/.exec(s);
  if (!m) return null;
  const width = parseInt(m[1], 10) * 10;
  const height = SASH_HEIGHT[m[2]];
  if (!height || width < 300 || width > 4500) return null;
  return { width, height };
}

/** 「FL+2000」「FL+900」→ 床からの高さ (mm) */
export function parseFlOffset(raw: string): number | null {
  const s = normalizeText(raw);
  const m = /^FL\+?(\d{3,4})$/.exec(s);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return v >= 100 && v <= 2600 ? v : null;
}

/** 「14段」「１４段」→ 段数 */
export function parseStepCount(raw: string): number | null {
  const s = normalizeText(raw);
  const m = /^(\d{1,2})段$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 8 && n <= 24 ? n : null;
}

/** 「開口」（建具の無い開口部）の注記 */
export function isOpenMark(raw: string): boolean {
  const s = normalizeText(raw);
  return /^開口(部)?$/.test(s) || /^(OPEN|W\/O)$/.test(s);
}

/** 「FIX」「引違」「片開」などの建具種別の注記 */
export function parseSashKind(raw: string): 'fix' | 'sliding' | 'swing' | null {
  const s = normalizeText(raw);
  if (/^FIX$|^はめ殺し$|^嵌め殺し$/.test(s)) return 'fix';
  if (/^引違い?$|^引き違い$|^引戸$|^引き戸$/.test(s)) return 'sliding';
  if (/^片開き?$|^両開き?$|^開き戸$/.test(s)) return 'swing';
  return null;
}
