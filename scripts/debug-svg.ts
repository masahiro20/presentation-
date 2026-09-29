import { writeFileSync, mkdirSync } from 'node:fs';
import { parseSample } from '../tests/pdfNode';
const file = process.argv[2] ?? 'sample_house_A3.pdf';
const out = process.argv[3] ?? 'test-output/debug.svg';
const m = await parseSample(file);
let svg = '';
let x0 = 0;
for (const f of m.floors) {
  let g = `<g transform="translate(${x0},0)">`;
  for (const r of f.rooms) {
    g += `<polygon points="${r.polygon.map(p => `${p.x},${p.y}`).join(' ')}" fill="hsl(${(r.id.length*47+r.name.length*83)%360},60%,85%)" stroke="#999" stroke-width="10"/>`;
    g += `<text x="${r.labelPos.x}" y="${r.labelPos.y}" font-size="220" text-anchor="middle">${r.name}</text>`;
  }
  for (const w of f.walls) {
    g += `<line x1="${w.a.x}" y1="${w.a.y}" x2="${w.b.x}" y2="${w.b.y}" stroke="${w.exterior ? '#222' : '#666'}" stroke-width="${w.thickness}" stroke-opacity="0.7"/>`;
  }
  const col: Record<string,string> = { window: '#08f', door: '#e60', sliding: '#0a0', entrance: '#c0c', open: '#f00' };
  for (const o of f.openings) {
    const w = f.walls.find(w => w.id === o.wallId)!;
    const L = Math.hypot(w.b.x-w.a.x, w.b.y-w.a.y);
    const ux=(w.b.x-w.a.x)/L, uy=(w.b.y-w.a.y)/L;
    g += `<line x1="${w.a.x+ux*o.t0}" y1="${w.a.y+uy*o.t0}" x2="${w.a.x+ux*o.t1}" y2="${w.a.y+uy*o.t1}" stroke="${col[o.kind]}" stroke-width="${w.thickness+40}"/>`;
  }
  for (const s of f.stairs) g += `<rect x="${s.minX}" y="${s.minY}" width="${s.maxX-s.minX}" height="${s.maxY-s.minY}" fill="none" stroke="#a0a" stroke-width="30" stroke-dasharray="80 40"/>`;
  g += `<text x="0" y="-400" font-size="400">${f.level}F</text></g>`;
  svg += g;
  x0 += 12000;
}
mkdirSync('test-output', { recursive: true });
writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1000 -1500 ${x0+1000} 11000" width="1600" height="${1600*11000/(x0+1000)}"><rect x="-1000" y="-1500" width="100%" height="100%" fill="white"/>${svg}</svg>`);
