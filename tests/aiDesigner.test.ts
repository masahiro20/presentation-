import { describe, expect, it } from 'vitest';
import { buildDigest, buildReviewPrompt, buildReviewBody, parseReviewText, parseReviewResponse, ruleFromFinding } from '../src/app/aiDesigner';
import type { BuildingModel, Floor, Opening, Room, Vec2, Wall } from '../src/core/types';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const room = (id: string, name: string, type: Room['type'], poly: Vec2[], labeledTatami?: number): Room => ({ id, name, type, polygon: poly, area: 10, labelPos: poly[0], labeledTatami });
const wall = (id: string, a: Vec2, b: Vec2): Wall => ({ id, a, b, thickness: 120, exterior: false });
const op = (id: string, wallId: string, kind: Opening['kind'], t0: number, t1: number): Opening => ({ id, wallId, kind, t0, t1, sill: 0, height: 2000 });
const floor: Floor = {
  level: 1,
  elevation: 500,
  height: 2900,
  ceilingHeight: 2400,
  walls: [wall('M', { x: 0, y: 1820 }, { x: 3640, y: 1820 }), wall('N', { x: 0, y: 0 }, { x: 3640, y: 0 })],
  openings: [op('d', 'M', 'door', 500, 1280), op('w', 'N', 'window', 600, 2290)],
  rooms: [room('a', '洋室', 'bedroom', rect(0, 0, 3640, 1820), 6), room('b', 'ホール', 'hall', rect(0, 1820, 3640, 3640))],
  stairs: [{ id: 'S', minX: 0, minY: 1820, maxX: 910, maxY: 3640, kind: 'straight', entry: 'e', goesUp: true }],
  outline: [rect(0, 0, 3640, 3640)],
};
const model = { name: 't', floors: [floor], northAngleDeg: 0, report: { pages: 1, scaleDenominator: 100, mmPerPt: 35.28, scaleSource: 'dimension', wallThicknesses: [120], warnings: ['1階 洋室: 戸が読めなかったので置きました'], timingsMs: {} } } as unknown as BuildingModel;

describe('AI 設計士の依頼と応答', () => {
  it('要約には部屋ごとの戸・窓と隣、階段の向き、注記が入る', () => {
    const d = buildDigest(model, [{ id: 'live-x', severity: 'warn', title: '1階 洋室: 玄関から行けません', detail: '' }]);
    expect(d).toContain('【1階】');
    expect(d).toMatch(/洋室\(寝室\) 10\.0㎡ 図面6帖: .*開き戸780→ホール.*窓1690→外/);
    expect(d).toContain('階段 直 910×1820 昇り口=図面の右');
    expect(d).toContain('【読み取りの注記】');
    expect(d).toContain('【自動チェックの指摘】');
  });

  it('依頼文には社内ルールと JSON の形が入り、画像は inline_data で付く', () => {
    const req = { digest: 'x', customRules: 'トイレの戸は引戸にする\n\n', image: 'data:image/jpeg;base64,AAAA' };
    const p = buildReviewPrompt(req);
    expect(p).toContain('- トイレの戸は引戸にする');
    expect(p).toContain('"findings"');
    const body = buildReviewBody(req) as { contents: { parts: Record<string, unknown>[] }[]; generationConfig: Record<string, unknown> };
    expect(body.contents[0].parts).toHaveLength(2);
    expect(body.contents[0].parts[1]).toEqual({ inline_data: { mime_type: 'image/jpeg', data: 'AAAA' } });
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('応答の JSON（コードフェンス付きでも）を指摘に直し、壊れていれば raw に残す', () => {
    const txt = '```json\n{"findings":[{"kind":"読み取り","severity":"warn","level":1,"room":"洋室","title":"戸の位置が違う","detail":"図面では北側","fix":"方眼で動かす"},{"title":"採光が少ない","severity":"info"}],"good":["回遊動線"],"summary":"要点"}\n```';
    const r = parseReviewText(txt, 'gemini-2.5-flash');
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0]).toMatchObject({ kind: '読み取り', severity: 'warn', room: '洋室', fix: '方眼で動かす' });
    expect(r.findings[1]).toMatchObject({ kind: '設計', severity: 'info' });
    expect(r.good).toEqual(['回遊動線']);
    expect(r.summary).toBe('要点');
    const bad = parseReviewText('うまく読めませんでした', 'm');
    expect(bad.findings).toHaveLength(0);
    expect(bad.raw).toBe('うまく読めませんでした');
  });

  it('generateContent の応答から文章と使用量を取り出す。安全性で止まればエラー', () => {
    const r = parseReviewResponse({ candidates: [{ content: { parts: [{ text: '{"findings":[],"good":[],"summary":"ok"}' }] } }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 80 } }, 'm');
    expect(r.summary).toBe('ok');
    expect(r.usage).toEqual({ promptTokens: 1200, outputTokens: 80 });
    expect(() => parseReviewResponse({ promptFeedback: { blockReason: 'SAFETY' } }, 'm')).toThrow(/安全性/);
    expect(ruleFromFinding({ kind: '設計', severity: 'info', title: 'トイレが LDK に開く', room: 'トイレ', detail: '' })).toContain('トイレが LDK に開く');
  });
});
