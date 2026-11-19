/**
 * 「どの図面のどの数字も悪くならない」の確認。改善前と改善後の accuracy.ts の結果を図面ごと・数字ごとに比べ、
 * 1 つでも悪くなったら一覧を出して終了コード 1 で終わる（変更を採る前に毎回回す）。
 *   npx tsx scripts/audit/noRegression.ts <before.json> <after.json>
 * 改善前に読めていなかった図面（階 0）は、読めるようになっただけで改善とみなし、警告の数の増減は問わない。
 * 戸・窓の数は「多いほど良い」と言えないので比べない（正解のある図面は正解との一致で比べる）。
 */
import { readFileSync } from 'node:fs';
import type { HouseMetrics } from './accuracy';

type Dir = 'up' | 'down';
const METRICS: [string, (h: HouseMetrics) => number | null, Dir][] = [
  ['階', (h) => h.floors, 'up'],
  ['読み取りの点数', (h) => h.readingScore, 'up'],
  ['名前の付いた部屋', (h) => h.rooms.named, 'up'],
  ['帖数の一致', (h) => h.rooms.tatamiMatch, 'up'],
  ['面積の誤差（最大 %）', (h) => h.area.maxErrPct, 'down'],
  ['重大な警告', (h) => h.build.critical, 'down'],
  ['階段の重大な警告', (h) => h.stairs.critical, 'down'],
  ['上下階の階段の不一致', (h) => h.stairs.upDownMismatch, 'down'],
  ['窓の無い居室', (h) => h.openings.livingNoWindow, 'down'],
  ['壁の疑い', (h) => h.walls.suspect, 'down'],
  ['住まいの成立の指摘', (h) => h.living.issues, 'down'],
];

type Score = { recall?: number; precision?: number; iou?: number; kindMatch?: number };
function truthRows(h: HouseMetrics): [string, number][] {
  const out: [string, number][] = [];
  h.truth?.floors.forEach((f, i) => {
    for (const [k, v] of Object.entries(f as unknown as Record<string, Score | number>)) {
      if (!v || typeof v !== 'object') continue;
      for (const m of ['recall', 'precision', 'iou', 'kindMatch'] as const) {
        const x = (v as Score)[m];
        if (typeof x === 'number') out.push([`正解との一致 ${i + 1} 枚目 ${k}.${m}`, x]);
      }
    }
  });
  return out;
}

const [bPath, aPath] = process.argv.slice(2);
if (!bPath || !aPath) {
  console.error('usage: npx tsx scripts/audit/noRegression.ts <before.json> <after.json>');
  process.exit(2);
}
const B = new Map((JSON.parse(readFileSync(bPath, 'utf8')) as HouseMetrics[]).map((h) => [h.id, h]));
const A = JSON.parse(readFileSync(aPath, 'utf8')) as HouseMetrics[];
const worse: string[] = [];
const better: string[] = [];
for (const a of A) {
  const b = B.get(a.id);
  if (!b) continue;
  if (b.floors === 0 && a.floors > 0) {
    better.push(`${a.id}: 読めるようになった（階 0 → ${a.floors}）`);
    continue;
  }
  for (const [label, get, dir] of METRICS) {
    const x = get(b);
    const y = get(a);
    if (x == null || y == null || Math.abs(x - y) < 1e-9) continue;
    const good = dir === 'up' ? y > x : y < x;
    (good ? better : worse).push(`${a.id}: ${label} ${x} → ${y}`);
  }
  const tb = new Map(truthRows(b));
  for (const [k, y] of truthRows(a)) {
    const x = tb.get(k);
    if (x == null || Math.abs(x - y) < 0.005) continue;
    (y > x ? better : worse).push(`${a.id}: ${k} ${x.toFixed(2)} → ${y.toFixed(2)}`);
  }
}
console.log(`良くなった ${better.length}`);
for (const l of better) console.log('  + ' + l);
console.log(`悪くなった ${worse.length}`);
for (const l of worse) console.log('  - ' + l);
process.exit(worse.length ? 1 : 0);
