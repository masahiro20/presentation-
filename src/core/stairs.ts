/**
 * 階段の段割り（平面）。3D・清書平面図・修正画面で同じ計算を使う。
 *
 * 階段は軸平行の矩形で、昇り口の辺（entry）から奥へ進む向きを s、昇る人から見て右向きを t とした
 * 局所座標で段を並べ、矩形の mm 座標に戻す。
 */
import type { Stair } from './types';

export interface StairPiece {
  kind: 'tread' | 'landing';
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 段の番号（1 = 最初の段。踊り場も 1 段分として数える） */
  i: number;
  /** この段を昇る向き（平面の単位ベクトル） */
  dir: { x: number; y: number };
}

export interface StairLayout {
  n: number;
  pieces: StairPiece[];
  /** 折り返し階段の中央の腰壁（平面の矩形） */
  wall?: { minX: number; minY: number; maxX: number; maxY: number };
}

export const STAIR_KIND_LABEL: Record<Stair['kind'], string> = { straight: '直階段', u: '折り返し階段', l: 'かね折れ階段' };
export const STAIR_ENTRY_LABEL: Record<Stair['entry'], string> = { n: '北（上）側', s: '南（下）側', e: '東（右）側', w: '西（左）側' };

/** 昇り口の辺から奥へ進む向き・右向き・原点（昇る人の左手側の角） */
export function stairFrame(s: Stair) {
  const W = s.maxX - s.minX;
  const H = s.maxY - s.minY;
  switch (s.entry) {
    case 'n':
      return { u: { x: 0, y: 1 }, r: { x: -1, y: 0 }, o: { x: s.maxX, y: s.minY }, Ls: H, Lt: W };
    case 's':
      return { u: { x: 0, y: -1 }, r: { x: 1, y: 0 }, o: { x: s.minX, y: s.maxY }, Ls: H, Lt: W };
    case 'w':
      return { u: { x: 1, y: 0 }, r: { x: 0, y: 1 }, o: { x: s.minX, y: s.minY }, Ls: W, Lt: H };
    default:
      return { u: { x: -1, y: 0 }, r: { x: 0, y: -1 }, o: { x: s.maxX, y: s.maxY }, Ls: W, Lt: H };
  }
}

/** 段数の目安（階高から。1 段 200mm 前後、最低 10 段） */
export function stairStepCount(riseMm: number) {
  return Math.max(10, Math.round(riseMm / 200));
}

export function stairLayout(s: Stair, n = 14): StairLayout {
  const F = stairFrame(s);
  const P = (sv: number, tv: number) => ({ x: F.o.x + F.u.x * sv + F.r.x * tv, y: F.o.y + F.u.y * sv + F.r.y * tv });
  const rect = (s0: number, s1: number, t0: number, t1: number) => {
    const a = P(s0, t0);
    const b = P(s1, t1);
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  };
  const pieces: StairPiece[] = [];
  const { Ls, Lt } = F;
  const neg = (v: { x: number; y: number }) => ({ x: -v.x, y: -v.y });
  if (s.kind === 'straight') {
    const st = Ls / n;
    for (let i = 1; i <= n; i++) pieces.push({ kind: 'tread', ...rect(st * (i - 1), st * i, 0, Lt), i, dir: F.u });
    return { n, pieces };
  }
  if (s.kind === 'u') {
    const turn = s.turn ?? 'left';
    // 昇る人から見て左に折り返す = 最初の列は右半分
    const first: [number, number] = turn === 'left' ? [Lt / 2, Lt] : [0, Lt / 2];
    const second: [number, number] = turn === 'left' ? [0, Lt / 2] : [Lt / 2, Lt];
    const land = Math.min(Ls * 0.4, Lt / 2);
    const run = Ls - land;
    const n1 = Math.floor(n / 2);
    const n2 = n - n1 - 1;
    const st1 = run / n1;
    const st2 = run / Math.max(1, n2);
    for (let i = 1; i <= n1; i++) pieces.push({ kind: 'tread', ...rect(st1 * (i - 1), st1 * i, first[0], first[1]), i, dir: F.u });
    pieces.push({ kind: 'landing', ...rect(run, Ls, 0, Lt), i: n1 + 1, dir: F.u });
    for (let j = 1; j <= n2; j++) pieces.push({ kind: 'tread', ...rect(run - st2 * (j - 1), run - st2 * j, second[0], second[1]), i: n1 + 1 + j, dir: neg(F.u) });
    return { n, pieces, wall: rect(0, run, Lt / 2 - 50, Lt / 2 + 50) };
  }
  // かね折れ: 最初の列は矩形の片側の帯、角で踊り場、奥の辺に沿って曲がる
  const turn = s.turn ?? 'right';
  const fw = Math.min(1000, Math.max(Ls, Lt) / 2, Math.min(Ls, Lt));
  const strip: [number, number] = turn === 'right' ? [0, fw] : [Lt - fw, Lt];
  const len1 = Math.max(0, Ls - fw);
  const len2 = Math.max(0, Lt - fw);
  const n1 = len2 <= 1 ? n - 1 : Math.max(1, Math.min(n - 2, Math.round(((n - 1) * len1) / Math.max(1, len1 + len2))));
  const n2 = n - 1 - n1;
  const st1 = len1 / Math.max(1, n1);
  for (let i = 1; i <= n1; i++) pieces.push({ kind: 'tread', ...rect(st1 * (i - 1), st1 * i, strip[0], strip[1]), i, dir: F.u });
  pieces.push({ kind: 'landing', ...rect(len1, Ls, strip[0], strip[1]), i: n1 + 1, dir: F.u });
  const st2 = len2 / Math.max(1, n2);
  const dir2 = turn === 'right' ? F.r : neg(F.r);
  for (let j = 1; j <= n2; j++) {
    const t0 = turn === 'right' ? fw + st2 * (j - 1) : Lt - fw - st2 * (j - 1);
    const t1 = turn === 'right' ? fw + st2 * j : Lt - fw - st2 * j;
    pieces.push({ kind: 'tread', ...rect(len1, Ls, t0, t1), i: n1 + 1 + j, dir: dir2 });
  }
  return { n, pieces };
}
