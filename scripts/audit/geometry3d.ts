/**
 * 間取り（JSON）→ 3D の形の照合を、図面ごとに回す。
 *   npx tsx scripts/audit/geometry3d.ts <図面.pdf> [...]
 */
import '../../api/_lib/pdfjs-polyfill.mjs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseFloorPlanPdf } from '../../src/parser/index';
import { buildBuilding } from '../../src/scene/building';
import { EXTERIOR_STYLES } from '../../src/styles/presets';
import { checkBuiltGeometry } from '../../src/scene/geometryCheck';
import { buildRoofs } from '../../src/scene/roof';
const dir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist');
const log = console.log;
console.log = () => {};
const sum: Record<string, number> = {};
for (const file of process.argv.slice(2)) {
  try {
    const m = await parseFloorPlanPdf(new Uint8Array(readFileSync(file)), pdfjs as never, { cMapUrl: path.join(dir, 'cmaps') + '/', standardFontDataUrl: path.join(dir, 'standard_fonts') + '/', wasmUrl: path.join(dir, 'wasm') + '/', name: path.basename(file) });
    if (!m.floors.length) {
      log(`${path.basename(file)}: 階なし（読み取り失敗）`);
      continue;
    }
    const t0 = performance.now();
    const built = buildBuilding(m, { exterior: EXTERIOR_STYLES[0] });
    const ms = Math.round(performance.now() - t0);
    const roof = buildRoofs(m, EXTERIOR_STYLES[0]);
    const issues = checkBuiltGeometry(m, built, [roof.mb]);
    for (const i of issues) sum[i.kind] = (sum[i.kind] ?? 0) + 1;
    log(`${path.basename(file)}: 3D ${ms} ms・照合の問題 ${issues.length}${issues.length ? '｜' + issues.map((i) => i.detail).join('／') : ''}`);
  } catch (e) {
    log(`${path.basename(file)}: 失敗 ${(e as Error).message}`);
  }
}
log('合計', JSON.stringify(sum));
