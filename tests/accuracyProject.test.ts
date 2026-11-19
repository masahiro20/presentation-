// 精度プロジェクト: 点数と重大警告を分けた「提案に使えるか」・階段の原因の切り分けと修正案（A/B/C）・自動修正の取り消し
import { describe, expect, it } from 'vitest';
import { parseSample } from './pdfNode';
import { buildCheck } from '../src/core/buildCheck';
import { assessReadiness, exportChecklist, applyHlHeightReference } from '../src/core/readiness';
import { diagnoseStair } from '../src/core/stairDiagnosis';
import { undoAutoFix } from '../src/core/autoFix';

describe('サンプル住宅の折り返し階段（以前は 読み取り 95 点なのに 踏面 81mm の重大警告）', () => {
  it('左右の列に歩行線がある階段を折り返し階段と読み、範囲を半間単位の階段室に自動で直す（A）', async () => {
    const m = await parseSample('sample_house_A3.pdf');
    const s = m.floors[0].stairs[0];
    expect(s.kind).toBe('u');
    expect(Math.round(s.maxX - s.minX)).toBe(1820);
    expect(Math.round(s.maxY - s.minY)).toBe(1820);
    expect(buildCheck(m).filter((i) => i.severity === 'critical')).toHaveLength(0);
    const fx = m.report.autoFixes ?? [];
    expect(fx).toHaveLength(1);
    expect(fx[0].evidence.join('')).toContain('半間');
  });

  it('自動修正は取り消せ、取り消すと重大警告と修正案（候補）が戻る', async () => {
    const m = await parseSample('sample_house_A3.pdf');
    const id = m.report.autoFixes![0].id;
    expect(undoAutoFix(m, id)).toBe(true);
    const crit = buildCheck(m).filter((i) => i.severity === 'critical' && i.kind === 'stair-tread');
    expect(crit.length).toBe(1);
    const d = diagnoseStair(m, 1, m.floors[0].stairs[0].id)!;
    expect(d.candidates.length).toBeGreaterThan(0);
    expect(d.candidates[0].after.tread).toBeGreaterThanOrEqual(150);
    expect(d.candidates[0].after.d).toBe(1820);
    expect(d.causes.join('')).toContain('階高');
  });
});

describe('提案に使えるか（読み取りの点数とは別）', () => {
  it('重大な警告があれば、点数が高くても「提案に使えます」と出さない', async () => {
    const m = await parseSample('sample_house_A3.pdf');
    undoAutoFix(m, m.report.autoFixes![0].id);
    const r = assessReadiness(m);
    expect(r.recognition.score).toBeGreaterThanOrEqual(80);
    expect(r.verdict).toBe('fix');
    expect(r.verdictLabel).not.toContain('提案に使えます');
    expect(exportChecklist(m).some((x) => x.title.startsWith('【重大】'))).toBe(true);
  });

  it('高さ・屋根の推定は「未確定の情報」に出て、確認すると一覧から外れる', async () => {
    const m = await parseSample('sample_house_A3.pdf');
    const r = assessReadiness(m);
    expect(r.pending.map((u) => u.key)).toEqual(expect.arrayContaining(['heights', 'roof']));
    expect(r.verdict).toBe('check');
    m.confirmed = { heights: '2026-11-19T00:00:00Z', roof: '2026-11-19T00:00:00Z' };
    const r2 = assessReadiness(m);
    expect(r2.pending.find((u) => u.key === 'heights')).toBeUndefined();
    expect(r2.confirmed.map((u) => u.key)).toEqual(expect.arrayContaining(['heights', 'roof']));
    expect(exportChecklist(m).some((x) => x.title.includes('階高'))).toBe(false);
  });
});

describe('高さの推定の根拠（御社の実例の中央値）', () => {
  it('担当者がボタンで選んだときだけ、1 階床・階高・1 階天井を実例の中央値にし、根拠と確からしさが変わる', async () => {
    const m = await parseSample('sample_house_A3.pdf');
    const before = assessReadiness(m).unknowns.find((u) => u.key === 'heights')!;
    expect(before.basis).toContain('中央値は');
    applyHlHeightReference(m);
    expect(m.floors[0].elevation).toBe(618);
    expect(m.floors[0].height).toBe(3100);
    expect(m.floors[1].elevation).toBe(618 + 3100);
    expect(m.floors[1].height).toBe(2800);
    expect(m.floors[0].ceilingHeight).toBeGreaterThanOrEqual(2600);
    const after = assessReadiness(m).unknowns.find((u) => u.key === 'heights')!;
    expect(after.confidence).toBeGreaterThan(before.confidence);
    expect(after.basis).toContain('合わせた');
  });
});
