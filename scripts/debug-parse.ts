import { parseSample } from '../tests/pdfNode';
const file = process.argv[2] ?? 'sample_house_A3.pdf';
const m = await parseSample(file);
console.log(JSON.stringify(m.report, null, 1));
console.log('north', m.northAngleDeg);
for (const f of m.floors) {
  console.log(`== ${f.level}F walls=${f.walls.length} ext=${f.walls.filter(w=>w.exterior).length} openings=${f.openings.length} rooms=${f.rooms.length} stairs=${f.stairs.length}`);
  for (const r of f.rooms) console.log(`  ${r.name.padEnd(8)} ${r.type.padEnd(9)} ${r.area.toFixed(2)}m2 (${(r.area/1.62).toFixed(1)}帖, label ${r.labeledTatami ?? '-'}) pts=${r.polygon.length}`);
  const kinds: Record<string, number> = {};
  for (const o of f.openings) kinds[o.kind + (o.windowStyle ? ':' + o.windowStyle : '')] = (kinds[o.kind + (o.windowStyle ? ':' + o.windowStyle : '')] ?? 0) + 1;
  console.log('  openings', kinds);
  console.log('  outline', f.outline.map(o => o.map(p => `${Math.round(p.x)},${Math.round(p.y)}`).join(' ')));
  for (const s of f.stairs) console.log('  stair', JSON.stringify(s));
}
