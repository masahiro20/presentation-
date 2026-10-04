/**
 * 平面図 PDF → 建物モデル
 */
import type { BuildingModel } from '../core/types';
import { extractPageVectors, type PageVectors, type PdfPageLike } from './pdfExtract';
import { detectScale, PT_TO_MM, STANDARD } from './scale';
import { assembleModel, pageToMm, moduleScaleFromWalls } from './assemble';
export { moduleScaleFromWalls };
import { thickStrokeMask } from './rasterWalls';
import { dxfToPages } from './dxf';

export interface PdfjsLike {
  getDocument(src: any): { promise: Promise<{ numPages: number; getPage(i: number): Promise<PdfPageLike>; canvasFactory?: any }> };
  OPS: Record<string, number>;
}

export interface ParseOptions {
  cMapUrl?: string;
  standardFontDataUrl?: string;
  /** JBIG2・JPEG2000 などの画像デコーダ（スキャン図面用） */
  wasmUrl?: string;
  /** CMap・フォントの取得方法（ブラウザで base64 版に切り替える用） */
  BinaryDataFactory?: unknown;
  /** 手動で縮尺を指定 (例: 100 → 1/100) */
  scaleDenominator?: number;
  name?: string;
  onProgress?: (msg: string, ratio: number) => void;
  /** 線のあるページでも、大きな画像の部分を画像として解析する（平面図が画像で貼られた資料用） */
  rasterImages?: boolean;
  /** 座標 1 単位あたりの mm（DXF のように実寸のデータでは 1） */
  mmPerPt?: number;
}

export async function loadPdfVectors(data: Uint8Array, pdfjs: PdfjsLike, opts: ParseOptions = {}): Promise<PageVectors[]> {
  const doc = await pdfjs.getDocument({
    data,
    cMapUrl: opts.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: opts.standardFontDataUrl,
    wasmUrl: opts.wasmUrl,
    ...(opts.BinaryDataFactory ? { BinaryDataFactory: opts.BinaryDataFactory, useWorkerFetch: false } : {}),
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  const pages: PageVectors[] = [];
  const n = Math.min(doc.numPages, 12);
  for (let i = 1; i <= n; i++) {
    opts.onProgress?.(`${i}/${n} ページを読み込み中`, (i - 1) / n * 0.5);
    const page = await doc.getPage(i);
    const pv = await extractPageVectors(page, pdfjs.OPS, i - 1);
    // 線がほとんど無く画像だけのページ（スキャン図面）は、画像にして太い線（壁）を取り出す
    const bigImages = (pv.images ?? []).filter((r) => (r.x1 - r.x0) * (r.y1 - r.y0) > pv.width * pv.height * 0.04);
    const imagePlan = opts.rasterImages && bigImages.length > 0;
    if ((pv.segments.length < 50 && (pv.imageCount ?? 0) > 0) || imagePlan) {
      try {
        opts.onProgress?.(`${i}/${n} ページ: スキャン画像を解析中`, (i - 0.5) / n * 0.5);
        pv.raster = await renderThickMask(page, doc.canvasFactory, pv.width, pv.height, imagePlan ? bigImages : undefined);
      } catch {
        // 描画できない環境では線のみで解析
      }
    }
    pages.push(pv);
  }
  return pages;
}

/** ページを約150dpi（最大 600万画素）で描画し、太い線だけの2値画像にする */
async function renderThickMask(page: PdfPageLike, factory: any, wPt: number, hPt: number, only?: { x0: number; y0: number; x1: number; y1: number }[]): Promise<PageVectors['raster']> {
  const scale = Math.min(150 / 72, Math.sqrt(6e6 / (wPt * hPt)));
  const vp = (page as any).getViewport({ scale });
  const w = Math.ceil(vp.width);
  const h = Math.ceil(vp.height);
  let canvas: any;
  let ctx: any;
  if (factory?.create) {
    const cc = factory.create(w, h);
    canvas = cc.canvas;
    ctx = cc.context;
  } else if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d');
  } else {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    ctx = canvas.getContext('2d');
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  await (page as any).render({ canvasContext: ctx, viewport: vp, canvas }).promise;
  const rgba = ctx.getImageData(0, 0, w, h).data as Uint8ClampedArray;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 0.3 + rgba[i * 4 + 1] * 0.59 + rgba[i * 4 + 2] * 0.11) | 0;
  // 紙で約0.7mm 未満の細い線（寸法線・家具・文字・手書き）を消す
  const k = Math.max(1, Math.round(2 * (scale / (150 / 72))));
  // 資料の中に貼られた平面図の画像だけを見る（表題・説明の帯や写真は除く）
  if (only?.length) {
    const keep = new Uint8Array(w * h);
    for (const r of only) {
      const x0 = Math.max(0, Math.floor(r.x0 * scale));
      const x1 = Math.min(w, Math.ceil(r.x1 * scale));
      const y0 = Math.max(0, Math.floor(r.y0 * scale));
      const y1 = Math.min(h, Math.ceil(r.y1 * scale));
      for (let y = y0; y < y1; y++) keep.fill(1, y * w + x0, y * w + x1);
    }
    for (let i = 0; i < gray.length; i++) if (!keep[i]) gray[i] = 255;
  }
  return { mask: thickStrokeMask(gray, w, h, k, undefined, k), w, h, scale };
}

export function modelFromVectors(pages: PageVectors[], opts: ParseOptions = {}): BuildingModel {
  const t0 = performance.now();
  const warnings: string[] = [];
  let sc = detectScale(pages);
  let scaleSource: BuildingModel['report']['scaleSource'] = sc.source;
  if (opts.scaleDenominator) {
    sc = { mmPerPt: opts.scaleDenominator * PT_TO_MM, denominator: opts.scaleDenominator, source: 'text', matches: 0 };
    scaleSource = 'manual';
  }
  if (opts.mmPerPt) {
    sc = { mmPerPt: opts.mmPerPt, denominator: null, source: 'text', matches: 0 };
    scaleSource = 'manual';
  }
  const segCount = pages.reduce((s, p) => s + p.segments.length, 0);
  const scanned = pages.some((p) => p.raster);
  if (segCount < 50 && !scanned) {
    warnings.push('ベクター線がほとんどありません。スキャン画像のPDFの可能性があります（CAD から出力した PDF を推奨）');
  }
  let mmPages = pages.map((p) => pageToMm(p, sc.mmPerPt));
  let res = assembleModel(mmPages, opts.name ?? '新築計画', warnings);
  if (scanned && res.floors.length) {
    warnings.push('スキャン画像の図面のため、画像から壁を読み取りました。室名は読み取れないため、下の一覧で部屋名と用途を指定してください');
    // 文字の読めないスキャン図面は、壁の芯が 910mm モジュールにそろう性質から縮尺を補正する
    if (sc.source === 'default' && !opts.scaleDenominator) {
      const walls = res.floors.flatMap((f) => f.walls);
      const m = moduleScaleFromWalls(walls);
      if (m.confidence > 0.25 && Math.abs(m.factor - 1) > 0.04) {
        const den = Math.round((sc.mmPerPt * m.factor) / PT_TO_MM);
        sc = { ...sc, mmPerPt: sc.mmPerPt * m.factor, denominator: STANDARD.includes(den) ? den : null };
        scaleSource = 'module';
        warnings.push(`壁の間隔（910mm モジュール）から縮尺を推定しました（約1/${Math.round(sc.mmPerPt / PT_TO_MM)}）`);
        mmPages = pages.map((p) => pageToMm(p, sc.mmPerPt));
        res = assembleModel(mmPages, opts.name ?? '新築計画', warnings);
      }
    }
  }

  // 帖数表記による縮尺の検証・補正
  const ratios: number[] = [];
  for (const f of res.floors)
    for (const r of f.rooms) if (r.labeledTatami && r.area > 0.5) ratios.push((r.labeledTatami * 1.62) / r.area);
  if (ratios.length >= 2) {
    ratios.sort((a, b) => a - b);
    const med = ratios[Math.floor(ratios.length / 2)];
    const within = ratios.filter((x) => Math.abs(x / med - 1) < 0.12).length;
    // 縮尺表記が無い／「S=1/100」のまま縮小印刷された（A3→A4 など）図面は、帖数の方が信頼できる
    const trustLabels = sc.source === 'default' || sc.source === 'text' || (sc.source === 'dimension' && sc.matches < 5);
    if (Math.abs(med - 1) > 0.2 && within >= ratios.length * 0.6 && trustLabels && !opts.scaleDenominator) {
      const k = Math.sqrt(med);
      const before = sc.source;
      let den: number | null = (sc.mmPerPt * k) / PT_TO_MM;
      // 標準の縮尺か、表記の縮尺を用紙サイズ違いで縮小／拡大印刷した値（√2 倍など）に合わせる
      const cands = [...STANDARD];
      if (sc.denominator) for (const f of [Math.SQRT2, Math.SQRT1_2, 2, 0.5]) cands.push(sc.denominator * f);
      const snap = cands.find((c) => Math.abs(c / den! - 1) < 0.025);
      den = snap ?? null;
      sc = { ...sc, mmPerPt: snap ? snap * PT_TO_MM : sc.mmPerPt * k, denominator: snap && Number.isInteger(snap) ? snap : null };
      scaleSource = 'area';
      const shown = Math.round(sc.mmPerPt / PT_TO_MM);
      warnings.push(
        before === 'default'
          ? `縮尺表記が見つからないため、帖数表記から縮尺を推定しました (約1/${shown})`
          : `図面の縮尺表記と帖数が合わないため、帖数から縮尺を補正しました（縮小印刷の可能性・約1/${shown}）`,
      );
      mmPages = pages.map((p) => pageToMm(p, sc.mmPerPt));
      res = assembleModel(mmPages, opts.name ?? '新築計画', warnings);
    } else if (Math.abs(med - 1) > 0.15) {
      warnings.push('図面の帖数と解析した面積に差があります。縮尺をご確認ください');
    }
  }
  // 画像の線の太さは実際の壁厚と違う（内壁は太線1本など）ので、3D 用に 90〜200mm に収める
  if (scanned) for (const f of res.floors) for (const w of f.walls) w.thickness = Math.min(200, Math.max(90, w.thickness));
  const allRooms = res.floors.flatMap((f) => f.rooms);
  if (!scanned && allRooms.length >= 4 && !allRooms.some((r) => !['室', '収納', '階段'].includes(r.name))) {
    warnings.push('室名の文字を読み取れませんでした（PDF にフォントが埋め込まれていない・文字が図形化されている可能性）。部屋名と用途を下の一覧で指定してください');
  }
  if (sc.source === 'default' && scaleSource === 'default' && !scanned) warnings.push('縮尺を特定できなかったため 1/100 として解析しました');

  const { thicknesses, ...model } = res;
  return {
    ...model,
    report: {
      pages: pages.length,
      scaleDenominator: sc.denominator,
      mmPerPt: sc.mmPerPt,
      scaleSource,
      wallThicknesses: scanned ? [...new Set(res.floors.flatMap((f) => f.walls.map((w) => Math.round(w.thickness))))].sort((a, b) => a - b) : thicknesses,
      warnings: [...new Set(warnings)],
      timingsMs: { analyze: Math.round(performance.now() - t0) },
    },
  };
}

export async function parseFloorPlanPdf(data: Uint8Array, pdfjs: PdfjsLike, opts: ParseOptions = {}): Promise<BuildingModel> {
  const t0 = performance.now();
  // pdf.js は読み込み時にデータをワーカーへ移すので、読み直し用に写しを取っておく
  const spare = data.slice();
  let pages = await loadPdfVectors(data, pdfjs, opts);
  const t1 = performance.now();
  opts.onProgress?.('壁・開口部・部屋を解析中', 0.6);
  let model = modelFromVectors(pages, opts);
  // 線から壁が見つからず、大きな画像が貼られている資料（プラン集・プレゼンボードなど）は、画像から壁を読み直す
  const noWalls = !model.floors.length || model.floors.every((f) => f.walls.length < 4);
  if (noWalls && !opts.rasterImages && pages.some((p) => (p.images ?? []).some((r) => (r.x1 - r.x0) * (r.y1 - r.y0) > p.width * p.height * 0.04))) {
    opts.onProgress?.('平面図の画像から壁を読み取っています', 0.65);
    pages = await loadPdfVectors(spare, pdfjs, { ...opts, rasterImages: true });
    const m2 = modelFromVectors(pages, opts);
    if (m2.floors.some((f) => f.walls.length >= 4)) {
      model = m2;
      model.report.warnings.unshift('平面図が画像で貼られた資料のため、画像から壁を読み取りました');
    }
  }
  model.report.timingsMs.load = Math.round(t1 - t0);
  opts.onProgress?.('完了', 1);
  return model;
}

/** DXF（CAD データ, 実寸 mm）→ 建物モデル */
export function parseDxf(text: string, opts: ParseOptions = {}): BuildingModel {
  const pages = dxfToPages(text);
  const model = modelFromVectors(pages, { ...opts, mmPerPt: 1 });
  model.report.scaleDenominator = null;
  model.report.warnings = model.report.warnings.filter((w) => !/縮尺/.test(w));
  return model;
}
