// 御社の積算ブック（シート「面」の数量と「見積もり書」の工事種別ごとの金額）と、読み取ったモデルからの自動拾い（見積の takeoff／computeEstimate）を並べて差を出す。
//   npx tsx scripts/audit/sekisan-compare.ts <モデル.model.json または 図面.pdf> <積算.xlsx> [--roof=shed|gable|hip|flat] [--eaves=mm] [--pitch=寸] [--grade=P|S] [--json=出力.json]
// 屋根・軒の出・勾配を指定しないときは、画面の既定のテイスト（DEFAULT_DESIGN の外観）と同じ条件で拾う。
// 図面（お客様の PDF・積算）と出力はリポジトリに入れない（作業用フォルダに置く）。
import '../../api/_lib/pdfjs-polyfill.mjs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BuildingModel } from '../../src/core/types';
import { parseFloorPlanPdf } from '../../src/parser/index';
import type { TakeoffOptions } from '../../src/estimate/areas';
import type { Grade } from '../../src/estimate/catalog';
import { DEFAULT_DESIGN, exteriorById } from '../../src/styles/presets';
import { compareSekisan, formatCompare, readSekisan } from './sekisan';

async function loadModel(file: string): Promise<BuildingModel> {
  if (/\.json$/i.test(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const dir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist');
  const data = new Uint8Array(readFileSync(file));
  return parseFloorPlanPdf(data, pdfjs as never, { cMapUrl: path.join(dir, 'cmaps') + '/', standardFontDataUrl: path.join(dir, 'standard_fonts') + '/', wasmUrl: path.join(dir, 'wasm') + '/', name: path.basename(file) });
}

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [modelFile, xlsx] = args.filter((a) => !a.startsWith('--'));
if (!modelFile || !xlsx) {
  console.log('usage: npx tsx scripts/audit/sekisan-compare.ts <model.json|plan.pdf> <sekisan.xlsx> [--roof=shed] [--eaves=100] [--pitch=0.5] [--grade=P] [--json=out.json]');
  process.exit(1);
}
const ext = exteriorById(DEFAULT_DESIGN.exteriorId);
const opts: TakeoffOptions = {
  grade: (flags.grade as Grade) ?? 'P',
  eavesMm: flags.eaves != null ? +flags.eaves : ext.roof.eaves,
  pitch: flags.pitch != null ? +flags.pitch : ext.roof.pitch,
  roofType: (flags.roof as TakeoffOptions['roofType']) ?? ext.roof.type,
  solido: ext.accent ? ext.accentRule : 'none',
};
const model = await loadModel(modelFile);
const sk = readSekisan(xlsx);
const r = compareSekisan(model, sk, opts);
console.log(formatCompare(r));
if (flags.json) writeFileSync(flags.json, JSON.stringify(r, null, 1));
