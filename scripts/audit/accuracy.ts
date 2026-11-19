/**
 * 読み取り精度の測定（部門ごと。総合点にしない）
 *
 *   npx tsx scripts/audit/accuracy.ts <manifest.json> <out.json>
 *
 * manifest.json（お客様の図面の場所なので作業用の場所に置く。リポジトリに入れない）:
 *   { "groups": { "dev": ["/path/a.pdf", ...], "holdout": [...] },
 *     "truth":  { "/path/a.pdf": "/path/a_truth.json" } }   … 正解データ（任意）
 *
 * 正解データが無い図面でも、図面そのものに書いてある値（帖数・面積表・室名）と、建築の成立条件で測れる所を測る。
 *   - 部屋: 室名の付いた部屋の割合、帖数の表記との一致率
 *   - 面積: 面積表の各階の床面積との誤差
 *   - 建具: 窓・戸の数、常識で補った戸（読み落としの目安）、窓の無い居室
 *   - 階段: 上下階の対応、建築の重大警告（踏面・蹴上・つながり）
 *   - 高さ・屋根: 図面から読めたか、推定か
 *   - 建築: 重大・要確認の数
 * 正解データ（サンプル住宅の正解・修正画面の「評価用に保存」）があれば、部屋・壁・建具の一致率も出す。
 * 正解データは「設計担当者が確認したもの」と「途中まで直したもの」を区別して扱う（partial）。
 */
import '../../api/_lib/pdfjs-polyfill.mjs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseFloorPlanPdf } from '../../src/parser/index';
import { buildCheck } from '../../src/core/buildCheck';
import { woodCheck } from '../../src/parser/woodCheck';
import { livingCheck } from '../../src/parser/livingCheck';
import { readingScore } from '../../src/parser/readingScore';
import { floorAreaOf } from '../../src/core/floorArea';
import { isSpecialRoomName } from '../../src/parser/labels';
import { wallCenter, scoreFloor, type TruthFloor } from './accuracyTruth';
import type { BuildingModel, Floor } from '../../src/core/types';

const [manifestFile, outFile] = process.argv.slice(2);
if (!manifestFile || !outFile) {
  console.log('usage: npx tsx scripts/audit/accuracy.ts <manifest.json> <out.json>');
  process.exit(1);
}
const manifest: { groups: Record<string, string[]>; truth?: Record<string, string> } = JSON.parse(readFileSync(manifestFile, 'utf8'));
const dir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist');
const r1 = (v: number) => Math.round(v * 10) / 10;
const WALL_SUSPECT = /^(stub|dup|merged|jog|narrow|ub|wc|door|offgrid)-\d/;
const LIVING = ['ldk', 'living', 'dining', 'kitchen', 'bedroom', 'japanese', 'study', 'kids'];

export interface HouseMetrics {
  id: string;
  group: string;
  parseMs: number;
  floors: number;
  scaleSource: string;
  readingScore: number;
  rooms: { count: number; named: number; tatamiLabeled: number; tatamiMatch: number };
  area: { floors: { level: number; table: number; got: number; errPct: number }[]; maxErrPct: number | null };
  openings: { windows: number; doors: number; entrance: number; estimated: number; livingNoWindow: number };
  stairs: { count: number; upDownMismatch: number; critical: number };
  walls: { suspect: number };
  heights: { source: string };
  build: { critical: number; confirm: number; kinds: Record<string, number> };
  living: { issues: number };
  truth?: { partial: boolean; floors: ReturnType<typeof scoreFloor>[] };
}

function tatamiStats(m: BuildingModel) {
  let labeled = 0;
  let match = 0;
  for (const f of m.floors)
    for (const r of f.rooms) {
      if (r.labeledTatami == null || r.type === 'void') continue;
      labeled++;
      const got = r.area / 1.62;
      if (Math.abs(got - r.labeledTatami) <= Math.max(0.35, r.labeledTatami * 0.06)) match++;
    }
  return { labeled, match };
}

function metricsOf(id: string, group: string, m: BuildingModel, ms: number): HouseMetrics {
  const rooms = m.floors.flatMap((f) => f.rooms.filter((r) => r.type !== 'void'));
  const named = rooms.filter((r) => !(r.type === 'other' && !isSpecialRoomName(r.name)) && !/^室$|^部屋$/.test(r.name.trim())).length;
  const t = tatamiStats(m);
  const table = m.report.areaTable ?? {};
  const af = m.floors
    .filter((f) => (table as Record<number, number>)[f.level] > 5)
    .map((f) => {
      const want = (table as Record<number, number>)[f.level];
      const got = floorAreaOf(f, m.floors);
      return { level: f.level, table: want, got: r1(got), errPct: r1((Math.abs(got - want) / want) * 100) };
    });
  const ops = m.floors.flatMap((f) => f.openings.map((o) => ({ f, o })));
  const exterior = (f: Floor, wallId: string) => !!f.walls.find((w) => w.id === wallId)?.exterior;
  const livingNoWindow = m.floors.reduce((s, f) => {
    const winWalls = new Set(f.openings.filter((o) => o.kind === 'window' || o.kind === 'sliding').map((o) => o.wallId));
    return s + f.rooms.filter((r) => LIVING.includes(r.type) && r.area > 4.5).filter((r) => !f.walls.some((w) => winWalls.has(w.id) && w.exterior && nearPoly(w, r.polygon))).length;
  }, 0);
  const bc = buildCheck(m);
  const kinds: Record<string, number> = {};
  for (const i of bc) if (i.severity !== 'note') kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
  const stairCritical = bc.filter((i) => i.severity === 'critical' && i.kind.startsWith('stair')).length;
  let mismatch = 0;
  for (const f of m.floors) {
    const up = f.stairs.filter((s) => s.goesUp).length;
    const upper = m.floors.find((x) => x.level === f.level + 1);
    if (!upper) continue;
    const down = upper.stairs.filter((s) => !s.goesUp).length;
    if (up !== down) mismatch++;
  }
  return {
    id,
    group,
    parseMs: Math.round(ms),
    floors: m.floors.length,
    scaleSource: m.report.scaleSource ?? '',
    readingScore: readingScore(m).score,
    rooms: { count: rooms.length, named, tatamiLabeled: t.labeled, tatamiMatch: t.match },
    area: { floors: af, maxErrPct: af.length ? Math.max(...af.map((x) => x.errPct)) : null },
    openings: {
      windows: ops.filter(({ o }) => o.kind === 'window').length,
      doors: ops.filter(({ f, o }) => (o.kind === 'door' || o.kind === 'sliding') && !exterior(f, o.wallId)).length,
      entrance: ops.filter(({ o }) => o.kind === 'entrance').length,
      estimated: ops.filter(({ o }) => (o.confidence ?? 1) <= 0.5).length,
      livingNoWindow,
    },
    stairs: { count: m.floors.reduce((s, f) => s + f.stairs.filter((x) => x.goesUp).length, 0), upDownMismatch: mismatch, critical: stairCritical },
    walls: { suspect: woodCheck(m).filter((i) => WALL_SUSPECT.test(i.id)).length },
    heights: { source: m.heights?.source ?? '推定' },
    build: { critical: bc.filter((i) => i.severity === 'critical').length, confirm: bc.filter((i) => i.severity === 'confirm').length, kinds },
    living: { issues: livingCheck(m).length },
  };
}

function nearPoly(w: { a: { x: number; y: number }; b: { x: number; y: number }; thickness: number }, poly: { x: number; y: number }[]): boolean {
  const c = wallCenter(w);
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / L2));
    best = Math.min(best, Math.hypot(c.x - a.x - dx * t, c.y - a.y - dy * t));
  }
  return best <= w.thickness / 2 + 120;
}

const out: HouseMetrics[] = [];
for (const [group, files] of Object.entries(manifest.groups)) {
  for (const file of files) {
    const id = path.basename(file, '.pdf');
    try {
      const t0 = performance.now();
      const m = await parseFloorPlanPdf(new Uint8Array(readFileSync(file)), pdfjs as never, { cMapUrl: path.join(dir, 'cmaps') + '/', standardFontDataUrl: path.join(dir, 'standard_fonts') + '/', wasmUrl: path.join(dir, 'wasm') + '/', name: path.basename(file) });
      const row = metricsOf(id, group, m, performance.now() - t0);
      const tf = manifest.truth?.[file];
      if (tf) {
        const truth = JSON.parse(readFileSync(tf, 'utf8')) as { partial?: boolean; floors: TruthFloor[] };
        row.truth = {
          partial: !!truth.partial,
          floors: truth.floors.map((tfl) => {
            const f = m.floors.find((x) => x.level === tfl.level);
            const auto: TruthFloor = f
              ? {
                  level: f.level,
                  walls: f.walls.map((w) => ({ a: w.a, b: w.b, thickness: w.thickness, exterior: w.exterior })),
                  openings: f.openings.map((o) => {
                    const w = f.walls.find((x) => x.id === o.wallId);
                    if (!w) return { kind: o.kind, width: o.t1 - o.t0, center: null };
                    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
                    const tm = (o.t0 + o.t1) / 2;
                    return { kind: o.kind, width: o.t1 - o.t0, center: { x: w.a.x + ((w.b.x - w.a.x) / L) * tm, y: w.a.y + ((w.b.y - w.a.y) / L) * tm } };
                  }),
                  rooms: f.rooms.filter((r) => r.type !== 'void').map((r) => ({ name: r.name, type: r.type, area: r.area, polygon: r.polygon })),
                  stairs: f.stairs.map((s) => ({ kind: s.kind, goesUp: s.goesUp, minX: s.minX, minY: s.minY, maxX: s.maxX, maxY: s.maxY })),
                }
              : { level: tfl.level, walls: [], openings: [], rooms: [], stairs: [] };
            return scoreFloor(auto, tfl);
          }),
        };
      }
      out.push(row);
      console.log(`${group} ${id}: ${row.floors} 階・部屋 ${row.rooms.count}（名前 ${row.rooms.named}）・帖数 ${row.rooms.tatamiMatch}/${row.rooms.tatamiLabeled}・面積誤差 ${row.area.maxErrPct ?? '—'}%・窓 ${row.openings.windows} 戸 ${row.openings.doors}（補完 ${row.openings.estimated}）・重大 ${row.build.critical}${row.truth ? ' ・正解あり' : ''}`);
    } catch (e) {
      console.log(`${group} ${id}: 読み込み失敗 ${(e as Error).message}`);
    }
  }
}
writeFileSync(outFile, JSON.stringify(out, null, 1));
