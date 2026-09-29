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
  [/^L\.?D\.?K|LDK|リビング.*ダイニング.*キッチン/, 'ldk'],
  [/^L\.?D$|^LD\b|リビングダイニング|リビング・ダイニング/, 'ldk'],
  [/^D\.?K$|ダイニングキッチン/, 'dining'],
  [/リビング|居間|LIVING|^L$/, 'living'],
  [/ダイニング|食堂|DINING|^D$/, 'dining'],
  [/キッチン|台所|KITCHEN|^K$/, 'kitchen'],
  [/W\.?I\.?C|ウォークイン|ウォーク・イン|W\.?C\.?L|クローゼット|^CL$|^C\.?L$|押入|押し入れ|床の間|仏間/, 'closet'],
  [/和室|座敷|客間|茶の間|畳コーナー|タタミ/, 'japanese'],
  [/子供|子ども|こども|キッズ|子室|KIDS|CHILD/, 'kids'],
  [/主寝室|寝室|ベッドルーム|MBR|BEDROOM|^BR\d*$/, 'bedroom'],
  [/洋室|個室|^室\d*$/, 'bedroom'],
  [/書斎|ワーク|スタディ|STUDY|DEN|趣味室|ヌック/, 'study'],
  [/浴室|バスルーム|^バス$|風呂|^UB$|ユニットバス|BATH/, 'bath'],
  [/洗面|脱衣|ランドリー|家事室|サニタリー|UTILITY|ユーティリティ/, 'washroom'],
  [/トイレ|便所|^W\.?C$|TOILET|^WC\d*$/, 'toilet'],
  [/玄関|エントランス|土間|ENTRANCE/, 'entrance'],
  [/ホール|廊下|HALL|ろうか/, 'hall'],
  [/階段|STAIRS?/, 'stairs'],
  [/納戸|物入|収納|^S\.?C$|^S\.?I\.?C$|シューズ|パントリー|^P\.?S$|物置|倉庫|STORAGE|^収$/, 'storage'],
  [/バルコニー|ベランダ|テラス|ルーフバルコニー|デッキ|BALCONY/, 'balcony'],
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
