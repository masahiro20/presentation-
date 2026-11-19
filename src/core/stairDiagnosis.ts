/**
 * 階段の重大警告（踏面・蹴上・幅）の原因を切り分けて、修正案を作る。
 *
 * 例: 「踏面 81mm」は、たいてい次のどれか:
 *   - 階段の読み取り範囲が短い（階段室の部屋はもっと長い）
 *   - 階段の形の読み違い（折り返し階段を直階段と読んだ → 段が 1 列に詰め込まれる）
 *   - 昇る向きの読み違い（縦横を取り違えた）
 *   - 階高が推定値（段数・蹴上が変わる）
 * 候補ごとに形を変えて建築の検証をやり直し、重大警告が消えるものだけを修正案にする。
 *
 * 修正方式:
 *   A 根拠が十分（候補が 1 つで、図面の手がかり＝階段室の部屋・上下階の同じ階段と合う） → 自動で直してよい
 *   B 候補が複数 → 担当者が選ぶ
 *   C 候補が無い／階高が推定で決められない → 図面・立面図で確認してもらう
 * 図面の根拠が足りないときは確定しない（A にしない）。
 */
import type { BuildingModel, Floor, Stair } from './types';
import { buildCheck } from './buildCheck';
import { effectiveStepCount, stairTreadDepth } from './stairs';
import { pointInPolygon } from './geometry';

export type FixClass = 'A' | 'B' | 'C';

export interface StairCandidate {
  id: string;
  /** 何を変えるか（担当者向けの短い説明） */
  label: string;
  /** なぜそう考えるか */
  evidence: string[];
  /** 根拠の強さ（図面の手がかりの数） */
  score: number;
  before: { kind: Stair['kind']; entry: Stair['entry']; w: number; d: number; tread: number; riser: number };
  after: { kind: Stair['kind']; entry: Stair['entry']; w: number; d: number; tread: number; riser: number };
  /** 変更後の階段（上の階の同じ階段にも同じ形を当てる） */
  stair: Stair;
}

export interface StairDiagnosis {
  level: number;
  stairId: string;
  problem: string;
  causes: string[];
  candidates: StairCandidate[];
  fixClass: FixClass;
  /** C のとき、何を確かめてもらうか */
  needs?: string;
}

const KIND_LABEL: Record<Stair['kind'], string> = { straight: '直階段', u: '折り返し階段', uOpen: 'コの字階段', l: 'かね折れ階段' };
const ROT: Record<Stair['entry'], Stair['entry']> = { n: 'e', e: 's', s: 'w', w: 'n' };

function stairIssues(model: BuildingModel, level: number, id: string) {
  return buildCheck(model).filter((i) => i.level === level && i.severity === 'critical' && i.kind.startsWith('stair-') && i.target?.id === id);
}

function dims(f: Floor, s: Stair) {
  const n = effectiveStepCount(f.height, s);
  return { kind: s.kind, entry: s.entry, w: Math.round(s.maxX - s.minX), d: Math.round(s.maxY - s.minY), tread: Math.round(stairTreadDepth(s, n)), riser: Math.round(f.height / n) };
}

/** 住宅の階段として成り立つ寸法か（踏面 180〜330・蹴上 230 以下、折り返し・かね折れは長い辺 2,730 まで、直階段は 4,100 まで、幅 700 以上） */
export function plausibleStair(d: { kind: Stair['kind']; w: number; d: number; tread: number; riser: number }): boolean {
  if (d.tread < 180 || d.tread > 330 || d.riser > 230) return false;
  const long = Math.max(d.w, d.d);
  const short = Math.min(d.w, d.d);
  if (short < 700) return false;
  return d.kind === 'straight' ? long <= 4100 : long <= 2780;
}

/** 階段の中心を含む「階段」の部屋（階段室） */
function stairRoomOf(f: Floor, s: Stair) {
  const c = { x: (s.minX + s.maxX) / 2, y: (s.minY + s.maxY) / 2 };
  return f.rooms.find((r) => (r.type === 'stairs' || /階段/.test(r.name)) && pointInPolygon(c, r.polygon)) ?? null;
}

/** 写しの上で階段（と上の階の同じ階段）を変える。検証は上下階をそろえた状態でする（範囲の食い違いの警告を出さないため） */
function withStair(model: BuildingModel, level: number, id: string, next: Stair): BuildingModel {
  const m: BuildingModel = JSON.parse(JSON.stringify(model));
  const f = m.floors.find((x) => x.level === level)!;
  const old = f.stairs.find((s) => s.id === id)!;
  f.stairs = f.stairs.map((s) => (s.id === id ? { ...next } : s));
  syncUpper(m, level, old, next);
  return m;
}

function syncUpper(model: BuildingModel, level: number, old: Stair, next: Stair) {
  const upper = model.floors.find((x) => x.level === level + 1);
  if (!upper) return;
  upper.stairs = upper.stairs.map((u) =>
    !u.goesUp && Math.abs(u.minX - old.minX) < 300 && Math.abs(u.minY - old.minY) < 300 ? { ...u, minX: next.minX, minY: next.minY, maxX: next.maxX, maxY: next.maxY, kind: next.kind, entry: next.entry } : u,
  );
}

export function diagnoseStair(model: BuildingModel, level: number, stairId: string): StairDiagnosis | null {
  const f = model.floors.find((x) => x.level === level);
  const s = f?.stairs.find((x) => x.id === stairId);
  if (!f || !s) return null;
  const issues = stairIssues(model, level, stairId);
  if (!issues.length) return null;
  const before = dims(f, s);
  const room = stairRoomOf(f, s);
  const upper = model.floors.find((x) => x.level === level + 1);
  const upperSame = upper?.stairs.find((u) => !u.goesUp && Math.abs(u.minX - s.minX) < 300 && Math.abs(u.minY - s.minY) < 300) ?? null;
  // 形・範囲・向きの組み合わせを試す
  const rects: { tag: string; r: Pick<Stair, 'minX' | 'minY' | 'maxX' | 'maxY'>; ev: string[] }[] = [{ tag: '', r: s, ev: [] }];
  if (room) {
    const xs = room.polygon.map((p) => p.x);
    const ys = room.polygon.map((p) => p.y);
    const rr = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    const grows = rr.maxX - rr.minX > s.maxX - s.minX + 150 || rr.maxY - rr.minY > s.maxY - s.minY + 150;
    if (grows) rects.push({ tag: '範囲を階段室に合わせる', r: rr, ev: [`図面の「${room.name}」の部屋は ${Math.round(rr.maxX - rr.minX)}×${Math.round(rr.maxY - rr.minY)} mm（読み取った階段は ${before.w}×${before.d} mm）`] });
  }
  // 木造の階段室は半間（455）単位。半端な寸法は、壁の無い側（ホール・廊下）へ 455 単位まで伸ばした形を試す
  const wallAt = (side: 'n' | 's' | 'e' | 'w') => {
    const horiz = side === 'n' || side === 's';
    const at = side === 'n' ? s.minY : side === 's' ? s.maxY : side === 'w' ? s.minX : s.maxX;
    const lo = horiz ? s.minX : s.minY;
    const hi = horiz ? s.maxX : s.maxY;
    let cover = 0;
    for (const w of f.walls) {
      const wh = Math.abs(w.a.y - w.b.y) < 1;
      if (wh !== horiz) continue;
      const o = horiz ? w.a.y : w.a.x;
      if (Math.abs(o - at) > w.thickness / 2 + 60) continue;
      const a = horiz ? Math.min(w.a.x, w.b.x) : Math.min(w.a.y, w.b.y);
      const b = horiz ? Math.max(w.a.x, w.b.x) : Math.max(w.a.y, w.b.y);
      cover += Math.max(0, Math.min(b, hi) - Math.max(a, lo));
    }
    return cover > (hi - lo) * 0.5;
  };
  for (const axis of ['x', 'y'] as const) {
    const len = axis === 'x' ? s.maxX - s.minX : s.maxY - s.minY;
    const rest = len % 455;
    if (rest < 60 || rest > 395) continue;
    for (const target of [Math.ceil(len / 455) * 455, Math.ceil(len / 910) * 910]) {
      const grow = target - len;
      if (grow <= 0 || grow > 910) continue;
      const lowSide = axis === 'x' ? 'w' : 'n';
      const highSide = axis === 'x' ? 'e' : 's';
      for (const side of [lowSide, highSide] as const) {
        if (wallAt(side)) continue;
        const r = { minX: s.minX, minY: s.minY, maxX: s.maxX, maxY: s.maxY };
        if (side === 'w') r.minX -= grow;
        else if (side === 'e') r.maxX += grow;
        else if (side === 'n') r.minY -= grow;
        else r.maxY += grow;
        // 格子に乗った家は、伸ばした範囲を壁芯の格子にそろえる（読み取りの範囲は壁の内側の面から始まることが多い）
        const md = model.module;
        if (md?.snapped) {
          const snap = (v: number, ph: number) => {
            const g = ph + Math.round((v - ph) / md.grid) * md.grid;
            return Math.abs(g - v) <= 150 ? g : v;
          };
          if (axis === 'y') {
            r.minY = snap(r.minY, md.phaseY);
            r.maxY = r.minY + target;
          } else {
            r.minX = snap(r.minX, md.phaseX);
            r.maxX = r.minX + target;
          }
          if (side === 'n' || side === 'w') {
            if (axis === 'y') {
              r.maxY = snap(s.maxY, md.phaseY);
              r.minY = r.maxY - target;
            } else {
              r.maxX = snap(s.maxX, md.phaseX);
              r.minX = r.maxX - target;
            }
          }
        }
        rects.push({ tag: `範囲を半間単位（${target.toLocaleString('ja-JP')}）まで壁の無い側へ伸ばす`, r, ev: [`木造の階段は半間（455）単位: 読み取った ${Math.round(len).toLocaleString('ja-JP')} mm は半端（${side === 'n' ? '上' : side === 's' ? '下' : side === 'w' ? '左' : '右'}側は壁が無く、段が続く余地があります）`] });
      }
    }
  }
  const kinds: Stair['kind'][] = ['straight', 'u', 'l'];
  const entries: Stair['entry'][] = [s.entry, ROT[s.entry]];
  const out: StairCandidate[] = [];
  const seen = new Set<string>();
  for (const R of rects)
    for (const kind of kinds)
      for (const entry of entries) {
        if (!R.tag && kind === s.kind && entry === s.entry) continue;
        const next: Stair = { ...s, ...R.r, kind, entry, treadPitch: kind === 'straight' ? s.treadPitch : undefined };
        const key = `${next.minX}|${next.minY}|${next.maxX}|${next.maxY}|${kind}|${entry}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const m2 = withStair(model, level, stairId, next);
        if (stairIssues(m2, level, stairId).length) continue;
        const f2 = m2.floors.find((x) => x.level === level)!;
        const after = dims(f2, next);
        // 住宅の階段の寸法の常識から外れる案は出さない（有本様邸: 階段室に合わせて 4,550×1,820・踏面 520 mm の「折り返し階段」になっていた）
        if (!plausibleStair(after)) continue;
        const evidence = [...R.ev];
        let score = R.ev.length;
        if (upperSame && upperSame.kind === kind) {
          evidence.push(`上の階の同じ位置の階段も${KIND_LABEL[kind]}と読めています`);
          score++;
        }
        if (kind !== s.kind && kind === 'u' && Math.abs(after.w - after.d) < 400) evidence.push('階段の範囲がほぼ正方形（折り返し階段の形）');
        if (entry !== s.entry) {
          // 向きを変える根拠は寸法だけ（図面の矢印と合うかは人が見る）。同じくらいの案なら、変える所の少ない案を先に
          evidence.push('昇る向きを 90° 変えると寸法が合います（図面の矢印と見比べてください）');
          score -= 0.5;
        }
        if (kind !== s.kind && !(upperSame && upperSame.kind === kind)) score -= 0.25;
        const parts: string[] = [];
        if (R.tag) parts.push(R.tag);
        if (kind !== s.kind) parts.push(`${KIND_LABEL[s.kind]} → ${KIND_LABEL[kind]}`);
        if (entry !== s.entry) parts.push('昇る向きを 90° 変える');
        out.push({ id: key, label: parts.join('、'), evidence, score, before, after, stair: next });
      }
  // 普通の寸法（踏面 230・蹴上 200 前後）に近く、根拠の多い順
  out.sort((a, b) => b.score - a.score || Math.abs(a.after.tread - 230) + Math.abs(a.after.riser - 200) - (Math.abs(b.after.tread - 230) + Math.abs(b.after.riser - 200)));
  const causes: string[] = [];
  if (out.some((c) => c.label.includes('階段室'))) causes.push('階段の読み取り範囲が短い（階段室の部屋より小さい）');
  if (out.some((c) => c.after.kind !== s.kind)) causes.push(`階段の形の読み違い（${KIND_LABEL[s.kind]}と読んだ）`);
  if (out.some((c) => c.after.entry !== s.entry)) causes.push('昇る向きの読み違い');
  if (!model.heights) causes.push(`階高 ${f.height} mm は推定値（立面図があれば段数・蹴上が変わります）`);
  let fixClass: FixClass;
  let needs: string | undefined;
  const best = out[0];
  if (!best) {
    fixClass = 'C';
    needs = '形・範囲・向きを変えても成り立つ案がありません。図面の階段（段の線・矢印・段数の注記）と、立面図の階高を確かめてください';
  } else if (best.score >= 2 && (out.length === 1 || best.score > out[1].score)) fixClass = 'A';
  else fixClass = 'B';
  return { level, stairId, problem: issues.map((i) => i.title).join('／'), causes, candidates: out.slice(0, 4), fixClass, needs };
}

/** 修正案を当てる（上の階の同じ階段にも同じ範囲・形を当てる）。元に戻す関数を返す */
export function applyStairCandidate(model: BuildingModel, level: number, stairId: string, c: StairCandidate): () => void {
  const snap = model.floors.map((f) => ({ level: f.level, stairs: JSON.parse(JSON.stringify(f.stairs)) as Stair[] }));
  const f = model.floors.find((x) => x.level === level)!;
  const old = f.stairs.find((s) => s.id === stairId)!;
  f.stairs = f.stairs.map((s) => (s.id === stairId ? { ...c.stair } : s));
  syncUpper(model, level, old, c.stair);
  return () => {
    for (const sn of snap) {
      const fl = model.floors.find((x) => x.level === sn.level);
      if (fl) fl.stairs = sn.stairs;
    }
  };
}
