// オーバースライダー（ガレージのドア）のレールは壁ではない: 出入口から車庫の中へ伸びる細い二重線を「全長が窓の壁」から外す
import { describe, expect, it } from 'vitest';
import { cutGarageRails } from '../src/parser/assemble';

type W = Parameters<typeof cutGarageRails>[0][number];
/** 横の壁（y 一定）: u = (1,0), n = (0,1) → t = x, o = y */
const hWall = (x0: number, x1: number, y: number, openings: { t0: number; t1: number; kind: 'window' | 'open' | 'door' }[] = []): W =>
  ({ a: { x: x0, y }, b: { x: x1, y }, u: { x: 1, y: 0 }, n: { x: 0, y: 1 }, d: 160, t0: x0, t1: x1, o: y, g: 0, openings: openings.map((o) => ({ ...o, confidence: 0.7 })), joinedA: true, joinedB: false }) as unknown as W;
/** 縦の壁（x 一定）: u = (0,1), n = (-1,0) → t = y, o = -x */
const vWall = (x: number, y0: number, y1: number): W =>
  ({ a: { x, y: y0 }, b: { x, y: y1 }, u: { x: 0, y: 1 }, n: { x: -1, y: 0 }, d: 160, t0: y0, t1: y1, o: -x, g: 1, openings: [], joinedA: true, joinedB: true }) as unknown as W;

/** 車庫（x 10200..16566、y 6370..13421）。東が出入口（袖壁 2 本の間 5.4m） */
function garage(extra: W[]) {
  return [vWall(16566, 6290, 7360), vWall(16566, 12740, 13501), hWall(10200, 16646, 6370), hWall(10200, 16646, 13421), vWall(10200, 6370, 13421), ...extra];
}
const near = () => true;

describe('ガレージのレール', () => {
  it('出入口の端から車庫の中へ伸びる「全長が窓の壁」はレール。外へ出た袖壁の実体だけ残す（吉田大仁様邸 1st-2）', () => {
    const rail = hWall(13771, 17021, 12740, [{ t0: 13790, t1: 16570, kind: 'window' }]);
    const walls = garage([rail]);
    expect(cutGarageRails(walls, near)).toBe(1);
    // 元の壁は書き換えず、切った写しに入れ替わる
    expect(walls).not.toContain(rail);
    expect(rail.a.x).toBe(13771);
    const cut = walls[walls.length - 1];
    expect(cut.a.x).toBe(16570);
    expect(cut.b.x).toBe(17021);
    expect(cut.openings).toHaveLength(0);
  });

  it('レールだけで実体が無ければ、壁ごと消す', () => {
    const rail = hWall(13771, 16566, 9900, [{ t0: 13790, t1: 16560, kind: 'window' }]);
    const walls = garage([rail]);
    expect(cutGarageRails(walls, near)).toBe(1);
    expect(walls).not.toContain(rail);
  });

  it('窓の先に壁の実体が続く壁（窓のある本物の側壁）は切らない', () => {
    const side = hWall(11000, 16566, 9900, [{ t0: 14500, t1: 16400, kind: 'window' }]);
    const walls = garage([side]);
    expect(cutGarageRails(walls, near)).toBe(0);
    expect(side.openings).toHaveLength(1);
  });

  it('出入口の線をまたいで両側に伸びる窓・引戸の壁は、レールではない（池本様邸の間仕切り）', () => {
    // 出入口の線 x=16566 をまたぐ壁（15300..17100）。窓は 15400..17000 で線の外まで 434mm 出ている
    const cross = hWall(15300, 17100, 9900, [{ t0: 15400, t1: 17000, kind: 'window' }]);
    const walls = garage([cross]);
    expect(cutGarageRails(walls, near)).toBe(0);
    expect(walls).toContain(cross);
  });

  it('壁の一部にしか窓の無い壁（窓のほかに壁の実体が長い）はレールではない', () => {
    const wall = hWall(12000, 16646, 9900, [{ t0: 14900, t1: 16560, kind: 'window' }]);
    const walls = garage([wall]);
    expect(cutGarageRails(walls, near)).toBe(0);
  });

  it('車庫の室名・車の記号が近くに無い切れ目では何もしない', () => {
    const rail = hWall(13771, 17021, 12740, [{ t0: 13790, t1: 16570, kind: 'window' }]);
    const walls = garage([rail]);
    expect(cutGarageRails(walls, () => false)).toBe(0);
    expect(rail.a.x).toBe(13771);
  });
});
