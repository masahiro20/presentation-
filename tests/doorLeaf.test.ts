// 開き戸の記号: 折れ線から復元した弧が 83° で途切れ、戸の板が厚みのある長方形でも「戸」と読む（田中様の玄関ドア・勝手口）
import { describe, expect, it } from 'vitest';
import { detectDoorSymbols, findAngleGroups, type Arc, type Seg } from '../src/parser/walls';

const seg = (x0: number, y0: number, x1: number, y1: number, width = 0.36): Seg => ({ a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, width, dashed: false, source: 'stroke' });
/** 中心 c・半径 r・角度 a0→a1（度）の円弧を 1 本のベジェで */
const arc = (cx: number, cy: number, r: number, a0: number, a1: number, poly = true): Arc => {
  const t0 = (a0 * Math.PI) / 180;
  const t1 = (a1 * Math.PI) / 180;
  const k = (4 / 3) * Math.tan((t1 - t0) / 4) * r;
  const p0 = { x: cx + r * Math.cos(t0), y: cy + r * Math.sin(t0) };
  const p3 = { x: cx + r * Math.cos(t1), y: cy + r * Math.sin(t1) };
  return { p0, p1: { x: p0.x - k * Math.sin(t0), y: p0.y + k * Math.cos(t0) }, p2: { x: p3.x + k * Math.sin(t1), y: p3.y - k * Math.cos(t1) }, p3, poly };
};
// 家の壁（縦横の線）: 壁の向きの群を作るため
const walls: Seg[] = [seg(0, 0, 0, 6000, 0.5), seg(0, 0, 8000, 0, 0.5), seg(8000, 0, 8000, 6000, 0.5), seg(0, 6000, 8000, 6000, 0.5)];

describe('開き戸の記号（弧＋板）', () => {
  it('弧が 83° で途切れ、板が 30mm 厚の長方形（吊元から 34mm ずれた線）でも戸として読む', () => {
    // 吊元 (9,193)。閉じた位置は真下（西の外壁 x=0 に沿う）、開いた板は西へ（y=197 と y=227 の 2 本線）
    const a = arc(9, 193, 838, 90, 173); // 90°（真下）から 173° まで（西向き 180° の 7° 手前で途切れる）
    const leaf = [seg(4, 197, -830, 197), seg(4, 227, -830, 227)];
    const segs = [...walls, ...leaf];
    const doors = detectDoorSymbols([a], segs, findAngleGroups(segs));
    expect(doors).toHaveLength(1);
    expect(doors[0].kind).toBe('door');
    expect(doors[0].confidence).toBeGreaterThan(0.9);
    // 戸の幅は半径（838）: 壁に沿って 193 → 1031
    expect(Math.round(doors[0].t1 - doors[0].t0)).toBe(838);
  });

  it('板の無い折れ線の弧（家具・設備の曲線）は戸にしない', () => {
    const a = arc(3000, 3000, 838, 90, 173);
    expect(detectDoorSymbols([a], walls, findAngleGroups(walls))).toHaveLength(0);
  });

  it('板らしい線でも、長さが半径と合わなければ戸にしない', () => {
    const a = arc(9, 193, 838, 90, 173);
    const segs = [...walls, seg(4, 197, -400, 197)];
    expect(detectDoorSymbols([a], segs, findAngleGroups(segs))).toHaveLength(0);
  });
});
