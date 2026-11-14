/**
 * 階の構成の手直し（読み取りで余分な階ができたとき用）。
 * 吉田様邸 1st プラン: 立面図のページが 3〜7 階として読まれ「4 階・6 階」が残った。読み取りの直しとは別に、
 * 使う人がその場で階を消せる逃げ道を置く。
 */
import type { BuildingModel } from './types';

/** 階を消し、上の階の番号を詰める（床の高さも下の階から積み直す）。無い階なら false */
export function removeFloor(model: BuildingModel, level: number): boolean {
  const idx = model.floors.findIndex((f) => f.level === level);
  if (idx < 0) return false;
  model.floors.splice(idx, 1);
  const shift = (lv: number) => (lv > level ? lv - 1 : lv);
  for (const f of model.floors) f.level = shift(f.level);
  if (model.roofPatches) model.roofPatches = model.roofPatches.filter((p) => p.level !== level).map((p) => ({ ...p, level: shift(p.level) }));
  if (model.canopies) model.canopies = model.canopies.filter((c) => c.level !== level).map((c) => ({ ...c, level: shift(c.level) }));
  if (model.furniture) model.furniture = model.furniture.filter((f) => f.level !== level).map((f) => ({ ...f, level: shift(f.level) }));
  if (model.heights?.storyHeights && model.heights.storyHeights.length >= level) {
    model.heights = { ...model.heights, storyHeights: model.heights.storyHeights.filter((_, i) => i !== level - 1) };
  }
  if (model.report?.areaTable) {
    const at: Record<number, number> = {};
    for (const [k, v] of Object.entries(model.report.areaTable)) {
      const lv = Number(k);
      if (lv === level) continue;
      at[shift(lv)] = v;
    }
    model.report.areaTable = at;
  }
  // 床の高さを下の階から積み直す（消した階の分だけ上の階が下がる）
  const sorted = model.floors.slice().sort((a, b) => a.level - b.level);
  for (let i = 1; i < sorted.length; i++) sorted[i].elevation = sorted[i - 1].elevation + sorted[i - 1].height;
  return true;
}

/** 階の番号を 1 から詰め直す（3 階建てで 2 階が無いなど、番号が飛んでいるとき） */
export function renumberFloors(model: BuildingModel): boolean {
  const sorted = model.floors.slice().sort((a, b) => a.level - b.level);
  const map = new Map<number, number>();
  sorted.forEach((f, i) => map.set(f.level, i + 1));
  if ([...map.entries()].every(([a, b]) => a === b)) return false;
  const to = (lv: number) => map.get(lv) ?? lv;
  for (const f of model.floors) f.level = to(f.level);
  if (model.roofPatches) model.roofPatches = model.roofPatches.map((p) => ({ ...p, level: to(p.level) }));
  if (model.canopies) model.canopies = model.canopies.map((c) => ({ ...c, level: to(c.level) }));
  if (model.furniture) model.furniture = model.furniture.map((f) => ({ ...f, level: to(f.level) }));
  return true;
}
