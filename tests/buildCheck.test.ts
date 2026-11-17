import { describe, expect, it } from 'vitest';
import { applyBuildFixes, buildCheck, LAW } from '../src/core/buildCheck';
import type { BuildingModel, Floor, Opening, Room, Stair, Wall } from '../src/core/types';

const wall = (id: string, ax: number, ay: number, bx: number, by: number, o: Partial<Wall> = {}): Wall => ({ id, a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 130, exterior: false, ...o }) as Wall;
const opening = (id: string, wallId: string, t0: number, t1: number, o: Partial<Opening> = {}): Opening => ({ id, wallId, kind: 'door', t0, t1, sill: 0, height: 2000, ...o }) as Opening;
const room = (id: string, name: string, x0: number, y0: number, x1: number, y1: number, type = 'bedroom'): Room =>
  ({ id, name, type, polygon: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], area: ((x1 - x0) * (y1 - y0)) / 1e6, labelPos: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } }) as Room;
const stair = (id: string, x: number, y: number, w: number, d: number, o: Partial<Stair> = {}): Stair => ({ id, minX: x, minY: y, maxX: x + w, maxY: y + d, kind: 'straight', entry: 's', goesUp: true, ...o }) as Stair;
const floor = (level: number, o: Partial<Floor> = {}): Floor => ({ level, elevation: 500 + (level - 1) * 2900, height: 2900, ceilingHeight: 2400, walls: [], openings: [], rooms: [], stairs: [], outline: [], ...o }) as Floor;
const model = (...floors: Floor[]): BuildingModel => ({ name: 't', floors, northAngleDeg: 0, report: {} }) as unknown as BuildingModel;
const kinds = (m: BuildingModel) => buildCheck(m).map((i) => i.kind);

describe('建築として成り立つかの検証（buildCheck）', () => {
  it('問題の無い間取りには何も出さない', () => {
    const f1 = floor(1, { walls: [wall('W1', 0, 0, 3640, 0), wall('W2', 0, 0, 0, 3640)], openings: [opening('O1', 'W1', 1000, 1780, { swingSide: 1 })], stairs: [stair('S1', 5000, 0, 910, 3185, { steps: 14 })] });
    const f2 = floor(2, { stairs: [stair('S2', 5000, 0, 910, 3185, { goesUp: false })] });
    expect(buildCheck(model(f1, f2))).toEqual([]);
  });

  it('どの問題にも、種類・場所・対象・根拠・基準・確からしさ・対応がそろっている', () => {
    const f1 = floor(1, { walls: [wall('W1', 0, 0, 3640, 0)], openings: [opening('O1', 'W1', 3000, 4200), opening('O2', 'W1', 500, 900)] });
    const is = buildCheck(model(f1));
    expect(is.length).toBeGreaterThan(0);
    for (const i of is) {
      expect(i.kind && i.title && i.reason && i.advice && i.basis.ref && i.target.id).toBeTruthy();
      expect(['critical', 'confirm', 'note']).toContain(i.severity);
      expect(['law', 'geometry', 'structure', 'practice', 'ergonomics']).toContain(i.basis.type);
      expect(i.confidence).toBeGreaterThan(0);
      expect(i.confidence).toBeLessThanOrEqual(1);
    }
  });

  describe('建具と壁の位置関係', () => {
    it('壁からはみ出した建具・取り付く壁の無い建具は重大', () => {
      const f1 = floor(1, { walls: [wall('W1', 0, 0, 3640, 0)], openings: [opening('O1', 'W1', 3000, 4200), opening('O2', 'W9', 0, 800)] });
      const is = buildCheck(model(f1));
      expect(is.find((i) => i.kind === 'opening-outside-wall')).toMatchObject({ severity: 'critical', values: { over: 560 } });
      expect(is.find((i) => i.kind === 'opening-no-wall')?.severity).toBe('critical');
    });
    it('床より下・階高を越える窓は重大。上下に分かれた窓は重なりにしない', () => {
      const f1 = floor(1, {
        walls: [wall('W1', 0, 0, 5000, 0, { exterior: true })],
        openings: [opening('A', 'W1', 500, 1500, { kind: 'window', sill: -200, height: 1000 }), opening('B', 'W1', 2000, 3000, { kind: 'window', sill: 2000, height: 1200 }), opening('C', 'W1', 3500, 4500, { kind: 'window', sill: 0, height: 900 }), opening('D', 'W1', 3500, 4500, { kind: 'window', sill: 1800, height: 500 })],
      });
      const k = kinds(model(f1));
      expect(k).toContain('opening-below-floor');
      expect(k).toContain('opening-above-story');
      expect(k).not.toContain('openings-overlap');
    });
    it('同じ壁の同じ高さで重なる建具は重大', () => {
      const f1 = floor(1, { walls: [wall('W1', 0, 0, 5000, 0)], openings: [opening('A', 'W1', 500, 1300), opening('B', 'W1', 1000, 1800)] });
      expect(buildCheck(model(f1)).find((i) => i.kind === 'openings-overlap')).toMatchObject({ severity: 'critical', values: { overlap: 300 } });
    });
    it('通れない幅の戸は重大、狭い戸は要確認。読めずに置いた出入口は重大にしない', () => {
      const f1 = floor(1, { walls: [wall('W1', 0, 0, 6000, 0)], openings: [opening('A', 'W1', 500, 900), opening('B', 'W1', 2000, 2550), opening('C', 'W1', 4000, 4400, { kind: 'open', confidence: 0.5 })] });
      const is = buildCheck(model(f1)).filter((i) => i.kind === 'door-narrow');
      expect(is.find((i) => i.target.id === 'A')).toMatchObject({ severity: 'critical', basis: { type: 'geometry' } });
      expect(is.find((i) => i.target.id === 'B')).toMatchObject({ severity: 'confirm', basis: { type: 'practice' } });
      expect(is.find((i) => i.target.id === 'C')?.severity).toBe('confirm');
    });
  });

  describe('開き戸の可動範囲', () => {
    // 壁 W1（y=0）の戸を +y 側へ開く。丁番は x=1000
    const door = (o: Partial<Opening> = {}) => opening('D', 'W1', 1000, 1780, { hingeAtStart: true, swingSide: 1, ...o });
    it('開く先を壁がふさいでいると、何度で当たるかを出す（反対へ開けば当たらないことも伝える）', () => {
      // 丁番から 400mm 先を、戸の振れる範囲を横切る壁
      const f1 = floor(1, { walls: [wall('W1', 0, 0, 4000, 0), wall('X', 1300, 300, 1300, 2000)], openings: [door()] });
      const i = buildCheck(model(f1)).find((x) => x.kind === 'door-hits-wall')!;
      expect(i).toBeTruthy();
      expect(i.values!.blockedAtDeg).toBeLessThan(90);
      expect(i.advice).toContain('反対の側');
    });
    it('幅 780 の戸が 600 しかない廊下へ開くと、向かいの壁に当たる', () => {
      const f1 = floor(1, { walls: [wall('W1', 0, 0, 4000, 0), wall('X', 0, 600, 4000, 600)], openings: [door()] });
      expect(buildCheck(model(f1)).find((x) => x.kind === 'door-hits-wall')?.values).toMatchObject({ blockedAtDeg: 45 });
    });
    it('横の壁に沿って 90° 開き切るふつうの納まり・戸の端が角の壁に少し掛かる読み取りは、当たりにしない', () => {
      const f1 = floor(1, { walls: [wall('W1', 0, 0, 4000, 0), wall('SIDE', 975, 0, 975, 3000), wall('FAR', 0, 910, 4000, 910)], openings: [door()] });
      expect(kinds(model(f1))).not.toContain('door-hits-wall');
    });
    it('外壁の戸（外へ開く）は見ない', () => {
      const f1 = floor(1, { walls: [wall('W1', 0, 0, 4000, 0, { exterior: true }), wall('X', 1300, 300, 1300, 2000)], openings: [door()] });
      expect(kinds(model(f1))).not.toContain('door-hits-wall');
    });
  });

  describe('階段', () => {
    it('蹴上 23cm 超は法令（令 23 条）の重大。段数が推定なら確からしさを下げる', () => {
      const up = floor(2, { stairs: [stair('S2', 0, 0, 910, 2730, { goesUp: false })] });
      const read = buildCheck(model(floor(1, { stairs: [stair('S1', 0, 0, 910, 2730, { steps: 11 })] }), up)).find((i) => i.kind === 'stair-riser')!;
      expect(read).toMatchObject({ severity: 'critical', basis: { type: 'law' } });
      expect(read.basis.ref).toContain('第23条');
      expect(read.values!.riser).toBeGreaterThan(LAW.stairRiserMax);
    });
    it('踏面 15cm 未満は重大、幅 75cm 未満は要確認（読み取った範囲の寸法なので）', () => {
      const up = floor(2, { stairs: [stair('S2', 0, 0, 700, 1200, { goesUp: false })] });
      const is = buildCheck(model(floor(1, { stairs: [stair('S1', 0, 0, 700, 1200)] }), up));
      expect(is.find((i) => i.kind === 'stair-tread')).toMatchObject({ severity: 'critical', basis: { type: 'law' } });
      expect(is.find((i) => i.kind === 'stair-width')).toMatchObject({ severity: 'confirm', basis: { type: 'law' } });
    });
    it('住宅の特例の中だが急な階段は、段数が図面から読めたときだけ「参考」（法令違反とは言わない）', () => {
      const up = () => floor(2, { stairs: [stair('S2', 0, 0, 910, 2730, { goesUp: false })] });
      const i = buildCheck(model(floor(1, { stairs: [stair('S1', 0, 0, 910, 2730, { steps: 13 })] }), up())).find((x) => x.kind === 'stair-riser-steep')!;
      expect(i).toMatchObject({ severity: 'note', basis: { type: 'ergonomics' } });
      expect(kinds(model(floor(1, { stairs: [stair('S1', 0, 0, 910, 2730)] }), up()))).not.toContain('stair-riser-steep');
    });
    it('昇った先の階が無い・上の階に階段が無い・範囲が合わない', () => {
      expect(kinds(model(floor(1, { stairs: [stair('S1', 0, 0, 910, 2730)] })))).toContain('stair-no-upper-floor');
      expect(kinds(model(floor(1, { stairs: [stair('S1', 0, 0, 910, 2730)] }), floor(2, { stairs: [stair('S2', 6000, 6000, 910, 2730, { goesUp: false })] })))).toContain('stair-not-connected');
      expect(kinds(model(floor(1, { stairs: [stair('S1', 0, 0, 910, 2730)] }), floor(2, { stairs: [stair('S2', 0, 0, 910, 1820, { goesUp: false })] })))).toContain('stair-range-mismatch');
    });
    it('3 階建ての中間の階は「昇る階段」1 つで持つので、向きが違っても接続ありと見る', () => {
      const m = model(floor(1, { stairs: [stair('S1', 0, 0, 910, 2730)] }), floor(2, { stairs: [stair('S2', 0, 0, 910, 2730)] }), floor(3, { stairs: [stair('S3', 0, 0, 910, 2730, { goesUp: false })] }));
      expect(kinds(m).filter((k) => k.startsWith('stair-'))).toEqual([]);
    });
    it('階段の真上に上の階の部屋の床があると、頭上の問題として出す（吹抜・階段なら出さない）', () => {
      const s1 = () => floor(1, { stairs: [stair('S1', 0, 0, 910, 2730)] });
      const covered = floor(2, { stairs: [stair('S2', 0, 2000, 910, 730, { goesUp: false })], rooms: [room('R', '洋室', -500, -500, 3000, 1900)] });
      const i = buildCheck(model(s1(), covered)).find((x) => x.kind === 'stair-headroom')!;
      expect(i.basis.type).toBe('practice');
      const open = floor(2, { stairs: [stair('S2', 0, 0, 910, 2730, { goesUp: false })], rooms: [room('R', '吹抜', -500, -500, 3000, 3000, 'void')] });
      expect(kinds(model(s1(), open))).not.toContain('stair-headroom');
    });
  });

  describe('階の高さ・床の接続', () => {
    it('階高と上の階の床が合わない・天井が階高に納まらないのは重大', () => {
      const k = kinds(model(floor(1, { ceilingHeight: 2850 }), floor(2, { elevation: 3700 })));
      expect(k).toContain('floor-stack');
      expect(k).toContain('ceiling-over-story');
    });
    it('天井高 2.1m 未満は法令（令 21 条）の要確認（平均で判定するので重大にしない）', () => {
      const i = buildCheck(model(floor(1, { ceilingHeight: 2000 }))).find((x) => x.kind === 'ceiling-low')!;
      expect(i).toMatchObject({ severity: 'confirm', basis: { type: 'law' } });
      expect(i.basis.ref).toContain('第21条');
    });
  });

  describe('壁の重なりと、形を変えない補正', () => {
    it('同じ線の上の二重の壁を見つけ、すっぽり入った建具なしの壁だけを消す', () => {
      const f1 = floor(1, { walls: [wall('A', 0, 0, 6000, 0), wall('B', 2000, 0, 3800, 0), wall('C', 0, 3000, 3000, 3000), wall('D', 2000, 3000, 5000, 3000)], openings: [] });
      const m = model(f1);
      const is = buildCheck(m).filter((i) => i.kind === 'walls-overlap');
      expect(is).toHaveLength(2);
      expect(is.filter((i) => i.fix)).toHaveLength(1);
      expect(applyBuildFixes(m)).toHaveLength(1);
      expect(m.floors[0].walls.map((w) => w.id)).toEqual(['A', 'C', 'D']);
      // 一部だけ重なる壁（どちらを残すか決められない）は、人に確認してもらう
      expect(buildCheck(m).filter((i) => i.kind === 'walls-overlap')).toHaveLength(1);
    });
    it('建具の付いた壁・端でつながるだけの壁・離れた平行の壁には触らない', () => {
      const f1 = floor(1, { walls: [wall('A', 0, 0, 6000, 0), wall('B', 2000, 0, 3800, 0), wall('E', 6000, 0, 9000, 0), wall('F', 0, 910, 6000, 910)], openings: [opening('O', 'B', 300, 1080, { kind: 'sliding' })] });
      const m = model(f1);
      expect(buildCheck(m).filter((i) => i.kind === 'walls-overlap')).toHaveLength(1);
      expect(applyBuildFixes(m)).toEqual([]);
      expect(m.floors[0].walls).toHaveLength(4);
    });
  });
});
