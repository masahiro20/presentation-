import { describe, it, expect } from 'vitest';
import { dailyRoutes, overlayRoutes, roomGraph } from '../src/core/circulation';
import { parseSample } from './pdfNode';

describe('暮らしの動線', () => {
  it('サンプルの間取りで朝・帰宅の動線が取れ、長さと歩数が出る', async () => {
    const model = await parseSample('sample_house_A3.pdf');
    const g = roomGraph(model);
    expect(g.nodes.size).toBeGreaterThan(5);
    const routes = dailyRoutes(model);
    const ids = routes.map((r) => r.id);
    expect(ids).toContain('morning');
    expect(ids).toContain('home');
    for (const r of routes) {
      expect(r.meters).toBeGreaterThan(0);
      expect(r.steps).toBeGreaterThan(0);
      expect(r.legs.length).toBeGreaterThan(0);
      expect(r.via.length).toBeGreaterThanOrEqual(2);
    }
    const svg = overlayRoutes('<svg viewBox="0 0 10 10"></svg>', 1, routes);
    expect(svg).toContain('class="routes"');
  });
});
