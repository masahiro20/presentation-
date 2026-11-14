import { describe, it, expect } from 'vitest';
import { cushionMesh } from '../src/scene/meshBuilder';

/** 辺（頂点の組）ごとの、三角形の数 */
function edgeUse(index: number[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < index.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const a = index[i + k];
      const b = index[i + ((k + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
  return m;
}
const bounds = (pos: number[]) => {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < pos.length; i += 3) {
    b.minX = Math.min(b.minX, pos[i]);
    b.maxX = Math.max(b.maxX, pos[i]);
    b.minY = Math.min(b.minY, pos[i + 1]);
    b.maxY = Math.max(b.maxY, pos[i + 1]);
    b.minZ = Math.min(b.minZ, pos[i + 2]);
    b.maxZ = Math.max(b.maxZ, pos[i + 2]);
  }
  return b;
};

describe('cushionMesh（ふくらみのあるクッションの形）', () => {
  it('閉じた形: どの辺も、ちょうど 2 枚の三角形が使う（面どうしで頂点を共有）', () => {
    const { index } = cushionMesh(0.9, 0.15, 0.75, { r: 0.045, crownTop: 0.022 });
    const uses = [...edgeUse(index).values()];
    expect(uses.every((n) => n === 2)).toBe(true);
  });

  it('ふくらみが無ければ、箱の寸法に収まる（角は丸い）', () => {
    const { pos } = cushionMesh(0.9, 0.15, 0.75, { r: 0.045 });
    const b = bounds(pos);
    expect(b.maxX).toBeCloseTo(0.45, 5);
    expect(b.maxY).toBeCloseTo(0.075, 5);
    expect(b.maxZ).toBeCloseTo(0.375, 5);
    // 角（3 面の交わる所）は丸みのぶん内側: 箱の角 (0.45, 0.075, 0.375) には頂点が無い
    let nearCorner = Infinity;
    for (let i = 0; i < pos.length; i += 3) nearCorner = Math.min(nearCorner, Math.hypot(pos[i] - 0.45, pos[i + 1] - 0.075, pos[i + 2] - 0.375));
    expect(nearCorner).toBeGreaterThan(0.02);
  });

  it('上の面は中央がふくらみ、縁では元の高さ', () => {
    const { pos } = cushionMesh(0.9, 0.15, 0.75, { r: 0.045, crownTop: 0.022 });
    const b = bounds(pos);
    expect(b.maxY).toBeCloseTo(0.075 + 0.022, 3);
    expect(b.minY).toBeCloseTo(-0.075, 5); // 下の面はふくらませていない
    // いちばん高い点は中央
    let top = { x: 9, z: 9, y: -9 };
    for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] > top.y) top = { x: pos[i], z: pos[i + 2], y: pos[i + 1] };
    expect(Math.abs(top.x)).toBeLessThan(0.01);
    expect(Math.abs(top.z)).toBeLessThan(0.01);
  });

  it('置きクッション（くびれ）: 辺の中ほどが内へ入り、四隅が張る', () => {
    const { pos } = cushionMesh(0.48, 0.05, 0.48, { r: 0.024, crownTop: 0.05, crownBottom: 0.045, pinch: 0.055, seg: 8 });
    // z ≒ 0（辺の中ほど）と z ≒ ±0.2（隅の近く）で、x の広がりを比べる
    let mid = 0;
    let corner = 0;
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.abs(pos[i + 2]) < 0.02) mid = Math.max(mid, pos[i]);
      if (Math.abs(Math.abs(pos[i + 2]) - 0.2) < 0.03) corner = Math.max(corner, pos[i]);
    }
    expect(mid).toBeLessThan(corner - 0.005);
    // 厚みは中央で 5cm + 両面のふくらみ
    const b = bounds(pos);
    expect(b.maxY - b.minY).toBeCloseTo(0.05 + 0.05 + 0.045, 2);
  });
});
