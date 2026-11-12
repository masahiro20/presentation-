// 畳の部屋を囲む「壁の色ではない細い帯」（小上がりの框）を、天井までの壁にしない（第 42 巡 ⑭。大崎様邸 1 階の畳コーナー）
import { describe, expect, it } from 'vitest';
import { buildFloor, detectPlans, splitStairRooms, type MmText, type PageMm } from '../src/parser/assemble';
import type { Seg } from '../src/parser/walls';
import type { Floor, Vec2 } from '../src/core/types';

const P = (x: number, y: number): Vec2 => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const WALL = '#808080';
const WOOD = '#c5a885';
const fillSegs = (poly: Vec2[], color: string): Seg[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length], width: 0, dashed: false, source: 'fill' as const, color }));
const strokeLoop = (poly: Vec2[]): Seg[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length], width: 0.2, dashed: false, source: 'stroke' as const }));
const stroke = (x0: number, y0: number, x1: number, y1: number): Seg => ({ a: P(x0, y0), b: P(x1, y1), width: 0.2, dashed: false, source: 'stroke' });
const text = (str: string, x: number, y: number, size = 300): MmText => ({ str, x, y, size, angle: 0 });
const T = 106;
const O = 5000;
const wallPoly = (x0: number, y0: number, x1: number, y1: number): Vec2[] =>
  x0 === x1 ? rect(O + x0 - T / 2, O + Math.min(y0, y1) - T / 2, O + x0 + T / 2, O + Math.max(y0, y1) + T / 2) : rect(O + Math.min(x0, x1) - T / 2, O + y0 - T / 2, O + Math.max(x0, x1) + T / 2, O + y0 + T / 2);

/**
 * 1 階（0〜7,280 × 0〜5,460）。右下に畳コーナー（5,460〜7,280 × 2,730〜5,460）。
 * LDK との間（x = 5,460）は木の色の幅 106mm の帯（框）。上（y = 2,730）は壁で、戸は無い。左上に洋室（壁で囲む）
 * @param bandColor 帯の色（壁と同じ色なら、ふつうの壁）
 */
function page(bandColor = WOOD, corner = '畳コーナー'): PageMm {
  const walls = [
    wallPoly(0, 0, 7280, 0), wallPoly(0, 5460, 7280, 5460), wallPoly(0, 0, 0, 5460), wallPoly(7280, 0, 7280, 5460),
    wallPoly(5460, 2730, 7280, 2730), // 畳コーナーの上（壁。戸は無い）
    wallPoly(0, 1820, 1820, 1820), wallPoly(1820, 0, 1820, 1820), // 洋室
  ];
  const band = wallPoly(5460, 2730, 5460, 5460);
  const segs: Seg[] = [...walls.flatMap((w) => fillSegs(w, WALL)), ...fillSegs(band, bandColor), ...strokeLoop(band)];
  segs.push(stroke(0, 0, 500, 0), stroke(29000, 20500, 29700, 20500), stroke(29700, 20000, 29700, 21000));
  const texts = [
    text(corner, O + 6370, O + 4000),
    text('（3.0帖）', O + 6370, O + 4400, 250),
    text('ＬＤＫ', O + 3200, O + 3600),
    text('（18.0帖）', O + 3200, O + 4000, 250),
    text('洋室', O + 910, O + 900),
    text('1 階', O + 3000, O + 6500, 398),
    text('平 面 図', O + 4450, O + 6500, 398),
  ];
  return { pageIndex: 0, segs, arcs: [], texts, fills: [], masks: [], colorFills: [...walls.map((poly) => ({ poly, color: WALL })), { poly: band, color: bandColor }] };
}

const read = (pg: PageMm, warnings: string[] = []): Floor => {
  const plans = detectPlans([pg], []);
  expect(plans.length).toBe(1);
  const f = buildFloor(plans[0], 1, 0, warnings);
  splitStairRooms(f);
  return f;
};
/** x = 5,460 の線の上（y 3,000〜5,200）に乗っている壁の長さ */
const bandWallLen = (f: Floor): number => {
  let len = 0;
  for (const w of f.walls) {
    if (Math.abs(w.a.x - (O + 5460)) > 80 || Math.abs(w.b.x - (O + 5460)) > 80) continue;
    const y0 = Math.max(Math.min(w.a.y, w.b.y), O + 3000);
    const y1 = Math.min(Math.max(w.a.y, w.b.y), O + 5200);
    if (y1 > y0) len += y1 - y0;
  }
  return len;
};

describe('畳の部屋を囲む木の色の帯（小上がりの框）', () => {
  it('戸の無い畳の部屋が、LDK と木の色の帯で仕切られていれば、小上がり（床 +400）にして帯の上の壁を外す', () => {
    const warnings: string[] = [];
    const f = read(page(), warnings);
    const tatami = f.rooms.find((r) => r.type === 'japanese')!;
    expect(tatami).toBeTruthy();
    expect(tatami.floorOffset).toBe(400);
    // 部屋は LDK と分かれたまま（帖数も変わらない）
    expect(f.rooms.some((r) => r.type === 'ldk')).toBe(true);
    expect(tatami.area).toBeGreaterThan(4.3);
    expect(tatami.area).toBeLessThan(5.3);
    // 帯の上に壁は残らない
    expect(bandWallLen(f)).toBeLessThan(200);
    expect(warnings.some((w) => /小上がり/.test(w))).toBe(true);
  });

  it('帯が壁と同じ色なら、ふつうの壁のまま（小上がりにしない）', () => {
    const f = read(page(WALL));
    const tatami = f.rooms.find((r) => r.type === 'japanese')!;
    expect(tatami.floorOffset).toBeUndefined();
    expect(bandWallLen(f)).toBeGreaterThan(2000);
  });

  it('切り替えを切ると、今までどおり帯の縁の線が壁になる', () => {
    const g = globalThis as { __NO_KOAGARI?: boolean };
    g.__NO_KOAGARI = true;
    try {
      const f = read(page());
      const tatami = f.rooms.find((r) => r.type === 'japanese')!;
      expect(tatami.floorOffset).toBeUndefined();
      expect(bandWallLen(f)).toBeGreaterThan(2000);
    } finally {
      delete g.__NO_KOAGARI;
    }
  });
});

/** x = 5,460 の線の上（y 3,000〜5,200）に乗っている壁のうち、天端の指定があるものの長さと、その天端 */
const lowOnBand = (f: Floor): { len: number; tops: number[] } => {
  let len = 0;
  const tops: number[] = [];
  for (const w of f.walls) {
    if (w.topMm == null) continue;
    if (Math.abs(w.a.x - (O + 5460)) > 80 || Math.abs(w.b.x - (O + 5460)) > 80) continue;
    const y0 = Math.max(Math.min(w.a.y, w.b.y), O + 3000);
    const y1 = Math.min(Math.max(w.a.y, w.b.y), O + 5200);
    if (y1 > y0) {
      len += y1 - y0;
      tops.push(w.topMm);
    }
  }
  return { len, tops };
};

describe('壁と違う色の帯の上に読めた壁は、腰壁・手すり壁（天端 1,100）', () => {
  it('書斎コーナーと LDK の間が薄い灰の帯なら、その壁は腰壁になり、部屋は分かれたまま', () => {
    const warnings: string[] = [];
    const f = read(page('#c0c0c0', 'スタディコーナー'), warnings);
    const study = f.rooms.find((r) => /スタディ/.test(r.name))!;
    expect(study).toBeTruthy();
    expect(study.floorOffset).toBeUndefined();
    expect(f.rooms.some((r) => r.type === 'ldk')).toBe(true);
    // 帯の上の壁は残り、天端 1,100 の指定が付く
    expect(bandWallLen(f)).toBeGreaterThan(2000);
    const low = lowOnBand(f);
    expect(low.len).toBeGreaterThan(2000);
    expect(low.tops.every((t) => t === 1100)).toBe(true);
    // 外壁・ほかの間仕切りには付かない
    expect(f.walls.filter((w) => w.topMm != null).every((w) => !w.exterior && Math.abs(w.a.x - (O + 5460)) < 80 && Math.abs(w.b.x - (O + 5460)) < 80)).toBe(true);
    expect(warnings.some((w) => /腰壁・手すり壁/.test(w))).toBe(true);
  });

  it('帯が壁と同じ色なら、天井までの壁のまま', () => {
    const f = read(page(WALL, 'スタディコーナー'));
    expect(f.walls.some((w) => w.topMm != null)).toBe(false);
    expect(bandWallLen(f)).toBeGreaterThan(2000);
  });

  it('切り替えを切ると、今までどおり天井までの壁', () => {
    const g = globalThis as { __NO_LOW_BAND_WALL?: boolean };
    g.__NO_LOW_BAND_WALL = true;
    try {
      const f = read(page('#c0c0c0', 'スタディコーナー'));
      expect(f.walls.some((w) => w.topMm != null)).toBe(false);
    } finally {
      delete g.__NO_LOW_BAND_WALL;
    }
  });

  it('畳の部屋の框（小上がり）は壁を外す方が先で、腰壁にはしない', () => {
    const f = read(page());
    expect(bandWallLen(f)).toBeLessThan(200);
    expect(lowOnBand(f).len).toBe(0);
  });
});
