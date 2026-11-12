// 柱と柱の間の隙間を「窓」と読む条件（第 42 巡 ⑰。林様邸 2 階の階段室）
//  - 帯の中の線が、位置を変えながら重ならずに入れ替わりで並ぶだけ（階段の側桁の線 → 踊り場の縁の線）なら、窓の壁にしない
//  - 引違いの障子（位置の違う線が召し合わせで重なる）・枠の線（1 本が端から端まで通る）は、今までどおり窓
import { afterEach, describe, expect, it } from 'vitest';
import { detectWalls, type Seg } from '../src/parser/walls';
import type { Vec2 } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const T = 190;
const H = T / 2;
const O = 5000;
const fillSegs = (poly: Vec2[]): Seg[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length], width: 0, dashed: false, source: 'fill' as const, color: '#000000' }));
const stroke = (x0: number, y0: number, x1: number, y1: number, width = 0.36): Seg => ({ a: P(O + x0, O + y0), b: P(O + x1, O + y1), width, dashed: false, source: 'stroke' });
const wallPoly = (x0: number, y0: number, x1: number, y1: number): Vec2[] =>
  x0 === x1 ? rect(O + x0 - H, O + Math.min(y0, y1) - H, O + x0 + H, O + Math.max(y0, y1) + H) : rect(O + Math.min(x0, x1) - H, O + y0 - H, O + Math.max(x0, x1) + H, O + y0 + H);
const faces = (x0: number, y0: number, x1: number, y1: number, spans?: [number, number][]): Seg[] =>
  x0 === x1
    ? (spans ?? [[Math.min(y0, y1) - H, Math.max(y0, y1) + H]]).flatMap(([a, b]) => [stroke(x0 - H, a, x0 - H, b, 0.6), stroke(x0 + H, a, x0 + H, b, 0.6)])
    : (spans ?? [[Math.min(x0, x1) - H, Math.max(x0, x1) + H]]).flatMap(([a, b]) => [stroke(a, y0 - H, b, y0 - H, 0.6), stroke(a, y0 + H, b, y0 + H, 0.6)]);
const wall = (x0: number, y0: number, x1: number, y1: number, spans?: [number, number][]): Seg[] => [...fillSegs(wallPoly(x0, y0, x1, y1)), ...faces(x0, y0, x1, y1, spans)];
/** 壁の中の柱（壁厚の正方形。塗りと輪郭の太い線） */
const column = (cx: number, y0: number): Seg[] => {
  const r = rect(O + cx - H, O + y0, O + cx + H, O + y0 + T);
  return [...fillSegs(r), ...r.map((a, i) => ({ a, b: r[(i + 1) % 4], width: 0.6, dashed: false, source: 'stroke' as const }))];
};

const W = 3640;
const D = 6000;
/** 柱の高さ（y 2,700〜2,890。帯の中心は 2,795） */
const CY = 2700;
/**
 * 幅 3,640 × 奥行 6,000 の部屋。東西の外壁の中、同じ高さに柱が向かい合う（柱の面の間は 3,450）。
 * その間に、帯（柱の厚みの中）を通る線を置く
 */
function room(band: Seg[]): Seg[] {
  const spans: [number, number][] = [[-H, CY], [CY + T, D + H]];
  return [...wall(0, 0, W, 0), ...wall(0, D, W, D), ...wall(0, 0, 0, D, spans), ...wall(W, 0, W, D, spans), ...column(0, CY), ...column(W, CY), ...band];
}
const onAxis = (det: ReturnType<typeof detectWalls>) => det.openings.filter((o) => Math.abs(det.groups[o.g].u.x) > 0.9 && Math.abs(Math.abs(o.o) - (O + CY + H)) < 100);

const g = globalThis as { __NO_GAP_SASH_CHECK?: boolean };
afterEach(() => {
  delete g.__NO_GAP_SASH_CHECK;
});

/** 階段室の線: 中ほどは側桁の線（柱の面から 42mm）、両端は踊り場の縁の線（帯の中心）。重ならずに入れ替わる */
const stairEdges = (): Seg[] => [stroke(950, CY + 42, 2700, CY + 42), stroke(H, CY + H, 900, CY + H), stroke(2750, CY + H, W - H, CY + H)];

describe('柱と柱の間の帯を、位置の違う線が入れ替わりで通るだけの所', () => {
  it('窓の壁にしない（階段の曲がり角を壁が横切らない）', () => {
    const det = detectWalls(room(stairEdges()), [], {}, []);
    expect(onAxis(det)).toHaveLength(0);
  });

  it('この判定を切ると、柱と柱の間 3.4m が「窓」になる（直す前の読み違い）', () => {
    g.__NO_GAP_SASH_CHECK = true;
    const det = detectWalls(room(stairEdges()), [], {}, []);
    const ops = onAxis(det);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('window');
    expect(ops[0].t1 - ops[0].t0).toBeGreaterThan(3300);
  });
});

describe('今までどおり窓と読むもの', () => {
  it('引違いの障子: 位置の違う 2 本が、中央の召し合わせで重なる', () => {
    const det = detectWalls(room([stroke(H, CY + 75, 1900, CY + 75), stroke(1800, CY + 115, W - H, CY + 115)]), [], {}, []);
    const ops = onAxis(det);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('window');
  });

  it('枠・敷居の線: 1 本が端から端まで通り、もう 1 本は一部だけ', () => {
    const det = detectWalls(room([stroke(H, CY + 60, W - H, CY + 60), stroke(1200, CY + 120, 2300, CY + 120)]), [], {}, []);
    const ops = onAxis(det);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('window');
  });
});
