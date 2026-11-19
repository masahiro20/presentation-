/**
 * 読み取りの直後に、根拠が十分な誤認識だけを自動で直す（修正方式 A）。
 * B（候補が複数）・C（情報が足りない）は直さず、読み込み結果の画面で候補を見せて担当者に選んでもらう。
 * 直した内容は report.autoFixes に修正前の形と一緒に残すので、保存したあとでも取り消せる。
 */
import type { AutoFix, BuildingModel } from './types';
import { buildCheck } from './buildCheck';
import { diagnoseStair, applyStairCandidate } from './stairDiagnosis';
import { compareReadings } from '../parser/readingGate';

const KIND: Record<string, string> = { straight: '直階段', u: '折り返し階段', uOpen: 'コの字階段', l: 'かね折れ階段' };

export function autoFixModel(model: BuildingModel): AutoFix[] {
  const done: AutoFix[] = [];
  const targets = buildCheck(model).filter((i) => i.severity === 'critical' && i.kind.startsWith('stair-') && i.target?.type === 'stair');
  const seen = new Set<string>();
  for (const it of targets) {
    const key = `${it.level}|${it.target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const d = diagnoseStair(model, it.level, it.target.id);
    if (!d || d.fixClass !== 'A') continue;
    const c = d.candidates[0];
    const undo = model.floors.map((f) => ({ level: f.level, stairs: JSON.parse(JSON.stringify(f.stairs)) }));
    const before = { ...model, floors: model.floors.map((f) => ({ ...f, stairs: JSON.parse(JSON.stringify(f.stairs)) })) };
    const revert = applyStairCandidate(model, it.level, it.target.id, c);
    // 直したことで、ほかの数字（住まいの成立の指摘・読み取りの点数など）が 1 つでも悪くなるなら自動では直さない（画面の修正案に残す）
    if (compareReadings(before, model).worse) {
      revert();
      continue;
    }
    done.push({
      id: `af-${key}`,
      kind: 'stair',
      level: it.level,
      targetId: it.target.id,
      label: `${it.level}階の階段: ${c.label}`,
      evidence: c.evidence,
      before: `${KIND[c.before.kind]} ${c.before.w}×${c.before.d} mm・踏面 ${c.before.tread} mm`,
      after: `${KIND[c.after.kind]} ${c.after.w}×${c.after.d} mm・踏面 ${c.after.tread} mm・蹴上 ${c.after.riser} mm`,
      undo,
    });
  }
  if (done.length) model.report.autoFixes = [...(model.report.autoFixes ?? []), ...done];
  return done;
}

/** 自動で直した内容を取り消す（階段を修正前に戻す） */
export function undoAutoFix(model: BuildingModel, id: string): boolean {
  const fx = model.report.autoFixes?.find((f) => f.id === id && !f.undone);
  if (!fx) return false;
  for (const sn of fx.undo) {
    const f = model.floors.find((x) => x.level === sn.level);
    if (f) f.stairs = JSON.parse(JSON.stringify(sn.stairs));
  }
  fx.undone = true;
  return true;
}
