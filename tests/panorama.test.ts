// 360° ビュー: 立方体の 6 面 → 正距円筒の向きの対応と、360° 写真の印（GPano）
import { describe, expect, it } from 'vitest';
import { CUBE_FACES, addPanoXmp, cubeToEquirect, equirectDir, faceLookup, type V3 } from '../src/scene/panorama';

describe('正距円筒の向き', () => {
  it('画像の中央は正面（heading）、右へ 90° で右、上端は真上', () => {
    const h: V3 = [0, 0, 1];
    const c = equirectDir(0, 0, h);
    expect(c[2]).toBeCloseTo(1);
    const r = equirectDir(Math.PI / 2, 0, h);
    // +Z を向いて右は -X（three.js のカメラと同じ）
    expect(r[0]).toBeCloseTo(-1);
    expect(equirectDir(0, Math.PI / 2, h)[1]).toBeCloseTo(1);
  });
  it('各面の中心の向きは、その面の中央に写る', () => {
    CUBE_FACES.forEach((F, i) => {
      const l = faceLookup(F.f);
      expect(l.face).toBe(i);
      expect(l.px).toBeCloseTo(0.5);
      expect(l.py).toBeCloseTo(0.5);
    });
  });
  it('面ごとに塗り分けた立方体から作ると、正面・右・真下が正しい面の色になる', () => {
    const size = 8;
    const colors = [10, 50, 90, 130, 170, 210];
    const faces = colors.map((v) => {
      const a = new Uint8ClampedArray(size * size * 4);
      for (let i = 0; i < size * size; i++) a.set([v, v, v, 255], i * 4);
      return a;
    });
    const W = 64;
    const out = cubeToEquirect(faces, size, W, [0, 0, 1]);
    const at = (x: number, y: number) => out[(y * W + x) * 4];
    expect(at(W / 2, W / 4)).toBe(90); // 正面 = +Z（3 番目の面）
    expect(at((W * 3) / 4, W / 4)).toBe(50); // 右 = -X（2 番目の面）
    expect(at(W / 2, W / 2 - 1)).toBe(210); // 真下 = -Y（6 番目の面）
  });
});

describe('360° 写真の印（XMP の GPano）', () => {
  it('JPEG の先頭の直後に APP1 を入れ、正距円筒と大きさを書く', () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 4, 1, 2, 0xff, 0xd9]);
    const out = addPanoXmp(jpg, 4096, 2048);
    expect([out[0], out[1], out[2], out[3]]).toEqual([0xff, 0xd8, 0xff, 0xe1]);
    const text = new TextDecoder().decode(out);
    expect(text).toContain("GPano:ProjectionType='equirectangular'");
    expect(text).toContain("GPano:FullPanoWidthPixels='4096'");
    expect(out.slice(-2)).toEqual(new Uint8Array([0xff, 0xd9]));
    const len = (out[4] << 8) | out[5];
    expect(out[4 + len]).toBe(0xff); // 差し込んだ区画のすぐ後ろに元の JPEG が続く
  });
  it('JPEG でなければ止める', () => {
    expect(() => addPanoXmp(new Uint8Array([1, 2, 3]), 2, 1)).toThrow();
  });
});

describe('360° を撮る立ち位置', async () => {
  const { standPoint } = await import('../src/app/panoramaExport');
  const room = {
    id: 'r', name: 'LDK', type: 'ldk', area: 20,
    polygon: [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 4000 }, { x: 0, y: 4000 }],
    labelPos: { x: 2500, y: 2000 },
  } as unknown as import('../src/core/types').Room;
  it('部屋の真ん中に島（キッチン）があれば、島から離れて立つ（壁からも 45cm 以上）', () => {
    const island = { minX: 2.0, maxX: 3.0, minZ: 1.6, maxZ: 2.4, maxY: 0.9 };
    const p = standPoint(room, [island], 0);
    const inIsland = p.x >= 2000 - 450 && p.x <= 3000 + 450 && p.y >= 1600 - 450 && p.y <= 2400 + 450;
    expect(inIsland).toBe(false);
    expect(Math.min(p.x, 5000 - p.x, p.y, 4000 - p.y)).toBeGreaterThanOrEqual(450);
  });
  it('敷物のような低い物は避けない（真ん中に立つ）', () => {
    const rug = { minX: 1.5, maxX: 3.5, minZ: 1.2, maxZ: 2.8, maxY: 0.02 };
    const p = standPoint(room, [rug], 0);
    expect(Math.hypot(p.x - 2500, p.y - 2000)).toBeLessThan(400);
  });
});
