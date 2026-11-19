/**
 * 2 通りの読み取りを比べて、新しい方を採ってよいかを決める（「どの数字も悪くならないときだけ採る」）。
 * 正解データが無くても測れる、読み取りのつじつまの数字だけで比べる:
 *   階の数・名前の付いた部屋の数・帖数の表記と面積の一致の数（多いほど良い）
 *   建築の重大な警告の数（少ないほど良い）
 *   戸の数（住宅の常識の範囲 = 名前の付いた屋内の部屋 1 つに 0.5〜1.6 か所 から外れる分が増えない）
 *   読み取りの点数（高いほど良い）、住まいの成立の指摘・木造の壁の疑い（少ないほど良い）
 * すべて同じか良く、どれか 1 つが良くなったときだけ adopt。精度の測定（scripts/audit/noRegression.ts）と同じ物差し。
 */
import type { BuildingModel } from '../core/types';
import { buildCheck } from '../core/buildCheck';
import { isSpecialRoomName } from './labels';
import { livingCheck } from './livingCheck';
import { woodCheck } from './woodCheck';
import { readingScore } from './readingScore';

const WALL_SUSPECT = /^(stub|dup|merged|jog|narrow|ub|wc|door|offgrid)-\d/;
const safe = (f: () => number) => {
  try {
    return f();
  } catch {
    return 0;
  }
};

export interface ReadingStats {
  floors: number;
  named: number;
  tatamiMatch: number;
  critical: number;
  doorExcess: number;
  score: number;
  living: number;
  woodSuspect: number;
}

const OUTDOOR = new Set(['void', 'balcony', 'porch', 'terrace']);

export function readingStats(m: BuildingModel): ReadingStats {
  const floors = m.floors.filter((f) => f.walls.length >= 4).length;
  let named = 0;
  let indoorNamed = 0;
  let tatamiMatch = 0;
  let doors = 0;
  for (const f of m.floors) {
    for (const r of f.rooms) {
      if (r.type === 'void') continue;
      const isNamed = !(r.type === 'other' && !isSpecialRoomName(r.name)) && !/^室$|^部屋$/.test(r.name.trim());
      if (isNamed) {
        named++;
        if (!OUTDOOR.has(r.type)) indoorNamed++;
      }
      if (r.labeledTatami != null && Math.abs(r.area / 1.62 - r.labeledTatami) <= Math.max(0.35, r.labeledTatami * 0.06)) tatamiMatch++;
    }
    doors += f.openings.filter((o) => o.kind === 'door' || o.kind === 'sliding').length;
  }
  const critical = safe(() => buildCheck(m).filter((i) => i.severity === 'critical').length);
  const score = safe(() => readingScore(m).score);
  const living = safe(() => livingCheck(m).length);
  const woodSuspect = safe(() => woodCheck(m).filter((i) => WALL_SUSPECT.test(i.id)).length);
  const lo = Math.floor(indoorNamed * 0.5);
  const hi = Math.ceil(indoorNamed * 1.6);
  const doorExcess = doors < lo ? lo - doors : doors > hi ? doors - hi : 0;
  return { floors, named, tatamiMatch, critical, doorExcess, score, living, woodSuspect };
}

export function compareReadings(base: BuildingModel, cand: BuildingModel): { adopt: boolean; worse: boolean; reasons: string[]; base: ReadingStats; cand: ReadingStats } {
  const a = readingStats(base);
  const b = readingStats(cand);
  // 今までの読み方では階が 1 つも読めなかった図面は、読めるようになっただけで改善（点検する中身が出てくるので警告の数は比べない）
  if (a.floors === 0 && b.floors > 0) return { adopt: true, worse: false, reasons: [`階 0→${b.floors}（読めるようになった）`], base: a, cand: b };
  const rows: [string, number, number, 'more' | 'less'][] = [
    ['階', a.floors, b.floors, 'more'],
    ['名前の付いた部屋', a.named, b.named, 'more'],
    ['帖数の一致', a.tatamiMatch, b.tatamiMatch, 'more'],
    ['重大な警告', a.critical, b.critical, 'less'],
    ['戸の数の常識外れ', a.doorExcess, b.doorExcess, 'less'],
    ['読み取りの点数', a.score, b.score, 'more'],
    ['住まいの成立の指摘', a.living, b.living, 'less'],
    ['壁の疑い', a.woodSuspect, b.woodSuspect, 'less'],
  ];
  let worse = false;
  let better = false;
  const reasons: string[] = [];
  for (const [label, x, y, dir] of rows) {
    if (x === y) continue;
    const good = dir === 'more' ? y > x : y < x;
    if (good) better = true;
    else worse = true;
    reasons.push(`${label} ${x}→${y}${good ? '' : '（悪化）'}`);
  }
  return { adopt: better && !worse, worse, reasons, base: a, cand: b };
}
