/**
 * 間取りの読み取り精度の測定
 *
 * 「自動の読み取り結果」と「手で直した正解」（修正画面の『評価用に保存』）を比べて、
 * 部屋・壁・窓とドア・面積がどれだけ合っているかを数値にする。
 * 図面を読み直した結果（パーサーを改良した後）と正解を比べれば、改良の効果も測れる。
 */
import type { Vec2 } from '../core/types';
import { pointInPolygon } from '../core/geometry';

export interface TruthFloor {
  level: number;
  walls: { a: Vec2; b: Vec2; thickness: number; exterior: boolean }[];
  openings: { kind: string; width: number; center: Vec2 | null }[];
  rooms: { name: string; type: string; area: number; polygon: Vec2[] }[];
}

export interface FloorScore {
  level: number;
  /** 正解の部屋のうち、形がほぼ一致（重なり 70% 以上）した割合 */
  roomRecall: number;
  /** 自動で見つけた部屋のうち、正解の部屋に対応する割合（余分な部屋が無いか） */
  roomPrecision: number;
  /** 一致した部屋のうち、用途（LDK・寝室など）も合っている割合 */
  roomTypeAccuracy: number;
  /** 床面積の誤差（%） */
  areaErrorPct: number;
  /** 正解の壁の長さのうち、自動の壁が近く（15cm 以内）にある割合 */
  wallRecall: number;
  /** 自動の壁の長さのうち、正解の壁が近くにある割合（余分な壁が無いか） */
  wallPrecision: number;
  /** 正解の窓・ドアのうち、位置が合っている割合 */
  openingRecall: number;
  /** 位置が合った窓・ドアのうち、種類も合っている割合 */
  openingKindAccuracy: number;
  /** 直すのに必要な操作のおおよその数（壁の追加・削除、窓ドアの追加・削除・種類変更、部屋名の変更） */
  fixes: number;
  /** 総合点（0〜100） */
  score: number;
}

const dist2seg = (p: Vec2, a: Vec2, b: Vec2) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
};

/** 線分を 10cm ごとに区切り、もう一方の壁の近くにある長さの割合 */
function wallCoverage(src: TruthFloor['walls'], dst: TruthFloor['walls'], tol = 150): { covered: number; total: number } {
  let covered = 0;
  let total = 0;
  for (const w of src) {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const n = Math.max(1, Math.round(L / 100));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const p = { x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t };
      total += L / n;
      if (dst.some((v) => dist2seg(p, v.a, v.b) < tol + v.thickness / 2)) covered += L / n;
    }
  }
  return { covered, total };
}

/** 2つの多角形の重なり（格子でおおよそ） */
function overlap(a: Vec2[], b: Vec2[], step = 100): { inter: number; areaA: number; areaB: number } {
  const xs = [...a, ...b].map((p) => p.x);
  const ys = [...a, ...b].map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  let inter = 0;
  let areaA = 0;
  let areaB = 0;
  for (let x = x0 + step / 2; x < x1; x += step)
    for (let y = y0 + step / 2; y < y1; y += step) {
      const p = { x, y };
      const ia = pointInPolygon(p, a);
      const ib = pointInPolygon(p, b);
      if (ia) areaA++;
      if (ib) areaB++;
      if (ia && ib) inter++;
    }
  return { inter, areaA, areaB };
}

export function scoreFloor(auto: TruthFloor, truth: TruthFloor): FloorScore {
  // 部屋
  const matched = new Map<number, number>();
  for (let i = 0; i < truth.rooms.length; i++) {
    const t = truth.rooms[i];
    let best = -1;
    let bestIoU = 0;
    for (let j = 0; j < auto.rooms.length; j++) {
      const o = overlap(t.polygon, auto.rooms[j].polygon, 120);
      const iou = o.inter / Math.max(1, o.areaA + o.areaB - o.inter);
      if (iou > bestIoU) {
        bestIoU = iou;
        best = j;
      }
    }
    if (best >= 0 && bestIoU >= 0.7) matched.set(i, best);
  }
  const usedAuto = new Set(matched.values());
  const roomRecall = truth.rooms.length ? matched.size / truth.rooms.length : 1;
  const roomPrecision = auto.rooms.length ? usedAuto.size / auto.rooms.length : 1;
  let typeOk = 0;
  let nameDiff = 0;
  for (const [i, j] of matched) {
    if (truth.rooms[i].type === auto.rooms[j].type) typeOk++;
    if (truth.rooms[i].name !== auto.rooms[j].name) nameDiff++;
  }
  const roomTypeAccuracy = matched.size ? typeOk / matched.size : 1;
  const areaT = truth.rooms.reduce((s, r) => s + r.area, 0);
  const areaA = auto.rooms.reduce((s, r) => s + r.area, 0);
  const areaErrorPct = areaT ? (Math.abs(areaA - areaT) / areaT) * 100 : 0;
  // 壁
  const wr = wallCoverage(truth.walls, auto.walls);
  const wp = wallCoverage(auto.walls, truth.walls);
  const wallRecall = wr.total ? wr.covered / wr.total : 1;
  const wallPrecision = wp.total ? wp.covered / wp.total : 1;
  // 窓・ドア
  let opHit = 0;
  let opKind = 0;
  const usedOp = new Set<number>();
  for (const t of truth.openings) {
    if (!t.center) continue;
    let best = -1;
    let bd = 400;
    auto.openings.forEach((o, j) => {
      if (!o.center || usedOp.has(j)) return;
      const d = Math.hypot(o.center.x - t.center!.x, o.center.y - t.center!.y);
      if (d < bd) {
        bd = d;
        best = j;
      }
    });
    if (best >= 0) {
      usedOp.add(best);
      opHit++;
      if (auto.openings[best].kind === t.kind) opKind++;
    }
  }
  const nOp = truth.openings.filter((o) => o.center).length;
  const openingRecall = nOp ? opHit / nOp : 1;
  const openingKindAccuracy = opHit ? opKind / opHit : 1;
  // 直す操作の数（おおよそ）: 足りない壁・余分な壁は 2.7m（一般的な壁 1 本）を 1 回として数える
  const wallFixes = Math.round((wr.total - wr.covered) / 2700 + (wp.total - wp.covered) / 2700);
  const fixes = wallFixes + (nOp - opHit) + (auto.openings.length - opHit) + (opHit - opKind) + nameDiff + (truth.rooms.length - matched.size);
  const score = Math.round(
    100 * (0.3 * roomRecall + 0.1 * roomPrecision + 0.1 * roomTypeAccuracy + 0.2 * (wallRecall * 0.6 + wallPrecision * 0.4) + 0.2 * openingRecall * (0.5 + 0.5 * openingKindAccuracy) + 0.1 * Math.max(0, 1 - areaErrorPct / 10)),
  );
  return { level: truth.level, roomRecall, roomPrecision, roomTypeAccuracy, areaErrorPct, wallRecall, wallPrecision, openingRecall, openingKindAccuracy, fixes, score };
}
