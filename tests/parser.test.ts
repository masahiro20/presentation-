import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSample } from './pdfNode';

const truth = JSON.parse(readFileSync(new URL('../samples/sample_house_truth.json', import.meta.url), 'utf8'));

for (const file of ['sample_house_A3.pdf', 'sample_house_pages.pdf']) {
  describe(file, async () => {
    const model = await parseSample(file);

    it('縮尺 1/100 を寸法から検出する', () => {
      expect(model.report.scaleDenominator).toBe(100);
      expect(model.report.scaleSource).toBe('dimension');
    });

    it('2階分の図面を検出する', () => {
      expect(model.floors.map((f) => f.level)).toEqual([1, 2]);
    });

    it('外形寸法が 9100 x 7280 / 9100 x 5460', () => {
      for (const f of model.floors) {
        const pts = f.outline.flat();
        const w = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
        const h = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
        const [tw, th] = truth.floors[f.level].footprint_mm;
        expect(Math.abs(w - tw)).toBeLessThan(80);
        expect(Math.abs(h - th)).toBeLessThan(80);
      }
    });

    it('上下階の位置が揃っている（北面・西面の外壁が一致）', () => {
      const [f1, f2] = model.floors;
      const min = (f: typeof f1, k: 'x' | 'y') => Math.min(...f.outline.flat().map((p) => p[k]));
      expect(Math.abs(min(f1, 'x') - min(f2, 'x'))).toBeLessThan(40);
      expect(Math.abs(min(f1, 'y') - min(f2, 'y'))).toBeLessThan(40);
    });

    it('主要な部屋を名前と面積で認識する', () => {
      for (const f of model.floors) {
        const tRooms = truth.floors[f.level].rooms as { name: string; area_m2: number }[];
        for (const tr of tRooms) {
          if (tr.name === '階段' || tr.name === 'ホール') continue;
          const r = f.rooms.find((r) => r.name.split('・').includes(tr.name));
          expect(r, `${f.level}F ${tr.name}`).toBeTruthy();
          if (!['玄関'].includes(tr.name)) expect(Math.abs(r!.area - tr.area_m2) / tr.area_m2, `${f.level}F ${tr.name} area`).toBeLessThan(0.12);
        }
      }
    });

    it('開口部を検出する（窓・ドア・玄関）', () => {
      const f1 = model.floors[0];
      expect(f1.openings.filter((o) => o.kind === 'entrance').length).toBe(1);
      expect(f1.openings.filter((o) => o.kind === 'window').length).toBeGreaterThanOrEqual(8);
      expect(f1.openings.filter((o) => o.kind === 'door').length).toBeGreaterThanOrEqual(5);
      expect(f1.openings.filter((o) => o.kind === 'sliding').length).toBeGreaterThanOrEqual(2);
      const ldkHakidashi = f1.openings.filter((o) => o.windowStyle === 'hakidashi');
      expect(ldkHakidashi.length).toBeGreaterThanOrEqual(2);
      const f2 = model.floors[1];
      expect(f2.openings.filter((o) => o.kind === 'door').length).toBeGreaterThanOrEqual(7);
    });

    it('階段を検出する', () => {
      expect(model.floors[0].stairs.length).toBe(1);
      expect(model.floors[0].stairs[0].goesUp).toBe(true);
    });

    it('方位記号を読み取る', () => {
      expect(model.northAngleDeg).toBe(file.includes('pages') ? -20 : 0);
    });
  });
}
