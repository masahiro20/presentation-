/**
 * プランの差分: 前回読み込んだプランと今のプランの違いを、打合せで話せる言葉にする。
 *
 * 使う人（設計士・営業）: 打合せの冒頭で「前回からの変更」をすぐ出す。議事録にもそのまま入る。
 * 見る人（お客様）: 「何が変わったか」が 1 枚で分かる（部屋の増減・広さ・窓・金額）。
 *
 * 間取りモデルそのものは大きいので、保存するのは要約（階ごとの部屋と帖数・開口の数・階段・延床・概算）だけ。
 */
import { ROOM_TYPE_LABEL, excludedFromFloorArea, type BuildingModel, type RoomType } from './types';

export interface PlanSummaryRoom {
  name: string;
  type: RoomType;
  /** 帖（図面の表記があればそれ） */
  tatami: number;
}

export interface PlanSummaryFloor {
  level: number;
  /** 床面積 ㎡（吹抜・外構を除く） */
  area: number;
  rooms: PlanSummaryRoom[];
  windows: number;
  doors: number;
  stairs: number;
}

export interface PlanSummary {
  /** 図面のファイル名など */
  name: string;
  at: string;
  floors: PlanSummaryFloor[];
  /** 延床 ㎡ */
  totalArea: number;
  /** 概算の総額（税込・円）。無ければ undefined */
  grand?: number;
}

export interface PlanChange {
  kind: 'floor' | 'room-add' | 'room-remove' | 'room-size' | 'windows' | 'doors' | 'stairs' | 'area' | 'cost';
  level?: number;
  /** お客様にも見せる 1 行 */
  text: string;
  /** 数値の変化（正 = 増） */
  delta?: number;
}

const tatamiOf = (r: { labeledTatami?: number; area: number }) => r.labeledTatami ?? r.area / 1.62;

export function planSummary(model: BuildingModel, name: string, grand?: number): PlanSummary {
  const floors: PlanSummaryFloor[] = model.floors.map((f) => ({
    level: f.level,
    area: f.rooms.filter((r) => !excludedFromFloorArea(r.type)).reduce((s, r) => s + r.area, 0),
    rooms: f.rooms
      .filter((r) => r.area > 1.5 && r.type !== 'void')
      .map((r) => ({ name: r.name || ROOM_TYPE_LABEL[r.type], type: r.type, tatami: Math.round(tatamiOf(r) * 10) / 10 })),
    windows: f.openings.filter((o) => o.kind === 'window').length,
    doors: f.openings.filter((o) => o.kind === 'door' || o.kind === 'sliding' || o.kind === 'entrance').length,
    stairs: f.stairs.length,
  }));
  return { name, at: new Date().toISOString(), floors, totalArea: floors.reduce((s, f) => s + f.area, 0), grand };
}

const norm = (s: string) => s.normalize('NFKC').replace(/\s/g, '').replace(/[①-⑳]/g, '');

/** 部屋の対応付け: 同じ名前 → 同じ用途で帖数が近いもの、の順 */
function matchRooms(a: PlanSummaryRoom[], b: PlanSummaryRoom[]): { pairs: [PlanSummaryRoom, PlanSummaryRoom][]; onlyA: PlanSummaryRoom[]; onlyB: PlanSummaryRoom[] } {
  const usedB = new Set<PlanSummaryRoom>();
  const pairs: [PlanSummaryRoom, PlanSummaryRoom][] = [];
  const onlyA: PlanSummaryRoom[] = [];
  for (const ra of a) {
    let best: PlanSummaryRoom | null = null;
    for (const rb of b) if (!usedB.has(rb) && norm(rb.name) === norm(ra.name)) {
      if (!best || Math.abs(rb.tatami - ra.tatami) < Math.abs(best.tatami - ra.tatami)) best = rb;
    }
    if (!best) {
      for (const rb of b) if (!usedB.has(rb) && rb.type === ra.type && ra.type !== 'other' && Math.abs(rb.tatami - ra.tatami) <= Math.max(1, ra.tatami * 0.35)) {
        if (!best || Math.abs(rb.tatami - ra.tatami) < Math.abs(best.tatami - ra.tatami)) best = rb;
      }
    }
    if (best) {
      usedB.add(best);
      pairs.push([ra, best]);
    } else onlyA.push(ra);
  }
  return { pairs, onlyA, onlyB: b.filter((rb) => !usedB.has(rb)) };
}

const fmtT = (v: number) => `${v.toFixed(1)} 帖`;

/** 前回（prev）→ 今回（cur）の変更。空なら「変更なし」 */
export function diffPlans(prev: PlanSummary, cur: PlanSummary): PlanChange[] {
  const out: PlanChange[] = [];
  const levels = new Set([...prev.floors.map((f) => f.level), ...cur.floors.map((f) => f.level)]);
  for (const lv of [...levels].sort((x, y) => x - y)) {
    const a = prev.floors.find((f) => f.level === lv);
    const b = cur.floors.find((f) => f.level === lv);
    if (!a && b) {
      out.push({ kind: 'floor', level: lv, text: `${lv}階が増えました（${b.rooms.length} 室）` });
      continue;
    }
    if (a && !b) {
      out.push({ kind: 'floor', level: lv, text: `${lv}階が無くなりました` });
      continue;
    }
    if (!a || !b) continue;
    const m = matchRooms(a.rooms, b.rooms);
    for (const r of m.onlyB) out.push({ kind: 'room-add', level: lv, text: `${lv}階に ${r.name}（${fmtT(r.tatami)}）が増えました`, delta: r.tatami });
    for (const r of m.onlyA) out.push({ kind: 'room-remove', level: lv, text: `${lv}階の ${r.name}（${fmtT(r.tatami)}）が無くなりました`, delta: -r.tatami });
    for (const [ra, rb] of m.pairs) {
      const d = rb.tatami - ra.tatami;
      if (Math.abs(d) >= 0.5) out.push({ kind: 'room-size', level: lv, text: `${lv}階 ${rb.name}: ${fmtT(ra.tatami)} → ${fmtT(rb.tatami)}（${d > 0 ? '＋' : '－'}${Math.abs(d).toFixed(1)} 帖）`, delta: d });
      else if (norm(ra.name) !== norm(rb.name)) out.push({ kind: 'room-size', level: lv, text: `${lv}階 ${ra.name} → ${rb.name}（名前が変わりました）` });
    }
    if (a.windows !== b.windows) out.push({ kind: 'windows', level: lv, text: `${lv}階の窓: ${a.windows} → ${b.windows} か所`, delta: b.windows - a.windows });
    if (a.doors !== b.doors) out.push({ kind: 'doors', level: lv, text: `${lv}階の戸: ${a.doors} → ${b.doors} か所`, delta: b.doors - a.doors });
    if (a.stairs !== b.stairs) out.push({ kind: 'stairs', level: lv, text: `${lv}階の階段: ${a.stairs} → ${b.stairs} か所`, delta: b.stairs - a.stairs });
  }
  const dA = cur.totalArea - prev.totalArea;
  if (Math.abs(dA) >= 0.8) out.push({ kind: 'area', text: `延床面積: ${prev.totalArea.toFixed(1)} ㎡ → ${cur.totalArea.toFixed(1)} ㎡（${dA > 0 ? '＋' : '－'}${Math.abs(dA).toFixed(1)} ㎡・${(Math.abs(dA) / 3.30579).toFixed(1)} 坪）`, delta: dA });
  if (prev.grand != null && cur.grand != null && Math.abs(cur.grand - prev.grand) >= 10000) {
    const d = cur.grand - prev.grand;
    out.push({ kind: 'cost', text: `概算（税込）: ${yenMan(prev.grand)} → ${yenMan(cur.grand)}（${d > 0 ? '＋' : '－'}${yenMan(Math.abs(d))}）`, delta: d });
  }
  return out;
}

/** 円 → 「3,210 万円」 */
export const yenMan = (v: number) => `${Math.round(v / 10000).toLocaleString('ja-JP')} 万円`;
