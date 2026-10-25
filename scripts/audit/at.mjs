// モデルの 1 点のまわり（壁・開口・部屋・外形の辺）を一覧する: node scripts/audit/at.mjs <model.json> <階> <x> <y> [半径]
import { readFileSync } from 'node:fs';
const [file, lv, xs, ys, rs = '900'] = process.argv.slice(2);
const m = JSON.parse(readFileSync(file, 'utf8'));
const f = m.floors.find((x) => x.level === +lv);
const P = { x: +xs, y: +ys };
const R = +rs;
const sd = (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)); return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y); };
const r = (v) => Math.round(v);
for (const w of f.walls) if (sd(P, w.a, w.b) < R) {
  console.log('wall', w.id, w.exterior ? 'EXT' : 'int', `(${r(w.a.x)},${r(w.a.y)})-(${r(w.b.x)},${r(w.b.y)}) t=${r(w.thickness)}`, w.kind ?? '', w.height ?? '');
  for (const o of f.openings.filter((o) => o.wallId === w.id)) console.log('   open', o.kind, o.subKind ?? '', `t ${r(o.t0 ?? o.offset ?? 0)}..${r(o.t1 ?? 0)} w=${r(o.width ?? 0)} sill=${o.sill ?? ''} h=${o.height ?? ''}`);
}
for (const l of f.outline) for (let i = 0; i < l.length; i++) { const a = l[i], b = l[(i + 1) % l.length]; if (sd(P, a, b) < R) console.log('outline', `(${r(a.x)},${r(a.y)})-(${r(b.x)},${r(b.y)})`); }
for (const rm of f.rooms) { const xs = rm.polygon.map((p) => p.x), ys = rm.polygon.map((p) => p.y); if (P.x > Math.min(...xs) - R && P.x < Math.max(...xs) + R && P.y > Math.min(...ys) - R && P.y < Math.max(...ys) + R) console.log('room', rm.name, rm.type, `[${r(Math.min(...xs))},${r(Math.min(...ys))}]-[${r(Math.max(...xs))},${r(Math.max(...ys))}]`); }
