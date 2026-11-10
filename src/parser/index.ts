/**
 * 平面図 PDF → 建物モデル
 */
import { autoOverhangPosts } from '../core/posts';
import { repairEnvelope, mergeStackedWalls } from './envelope';
import { readElevationHeights, applyElevationHeights, type ElevationHeights } from './elevationText';
import { readElevationViews, applyElevationWindows, floorShiftsFromElevation, planScaleFromElevation, type ElevationView } from './elevationWindows';
import { translateFloor, stairIoU } from '../core/floorAlign';
import { classifyPage, type PageInfo } from './pageMap';
import { readExteriorFinishTable } from './finishTable';
import type { BuildingModel } from '../core/types';
import { extractPageVectors, type PageVectors, type PdfPageLike } from './pdfExtract';
import { detectScale, PT_TO_MM, STANDARD } from './scale';
import { assembleModel, pageToMm, moduleScaleFromWalls, dominantTilt, rotatePageMm, type PageMm } from './assemble';
import type { ModuleMode } from './module';
export { moduleScaleFromWalls };
export type { ModuleMode };
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
  /** 図面全体が傾いている PDF を水平に戻してから読む */
  straighten?: boolean;
  /** 座標 1 単位あたりの mm（DXF のように実寸のデータでは 1） */
  mmPerPt?: number;
  /** 木造のモジュール: auto = 図面から判定, shaku = 尺 910, meter = メーター 1000, none = 格子へ寄せない */
  module?: ModuleMode;
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
        pv.raster = await renderThickMask(page, doc.canvasFactory, pv.width, pv.height, imagePlan ? bigImages : undefined, bigImages);
      } catch {
        // 描画できない環境では線のみで解析
      }
    }
    pages.push(pv);
  }
  return pages;
}

/** ページを約150dpi（最大 600万画素）で描画し、太い線だけの2値画像にする */
async function renderThickMask(page: PdfPageLike, factory: any, wPt: number, hPt: number, only?: { x0: number; y0: number; x1: number; y1: number }[], images?: { x0: number; y0: number; x1: number; y1: number }[]): Promise<PageVectors['raster']> {
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
  // 貼られている画像が「図面」か「写真」かを見分ける（提案資料の航空写真・パース写真から壁を読んで、板が林立した家になっていた）。
  // 図面は白地に黒い線（白が多く、色のついた画素がほとんど無い）。写真は白が少なく色が多い
  if (!isDrawingLike(rgba, w, h, (images ?? []).map((r) => ({ x0: r.x0 * scale, y0: r.y0 * scale, x1: r.x1 * scale, y1: r.y1 * scale })))) return undefined;
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

/**
 * 描画したページ（または貼られた画像の範囲）が図面らしいか。
 * 図面は白地に細い線で、中間調（灰色）の画素がほとんど無い。写真（航空写真・パース・内観）は中間調が半分以上を占める。
 * 計測例: 航空写真の範囲 = 白 0.3・中間調 0.5〜0.6、線画の図面 = 白 0.99・中間調 0.00
 */
export function isDrawingLike(rgba: Uint8ClampedArray, w: number, h: number, rects: { x0: number; y0: number; x1: number; y1: number }[]): boolean {
  const areas = rects.length ? rects : [{ x0: 0, y0: 0, x1: w, y1: h }];
  let n = 0;
  let white = 0;
  let mid = 0;
  const step = 3;
  for (const r of areas) {
    const x0 = Math.max(0, Math.floor(r.x0));
    const x1 = Math.min(w, Math.ceil(r.x1));
    const y0 = Math.max(0, Math.floor(r.y0));
    const y1 = Math.min(h, Math.ceil(r.y1));
    for (let y = y0; y < y1; y += step)
      for (let x = x0; x < x1; x += step) {
        const i = (y * w + x) * 4;
        const R = rgba[i];
        const G = rgba[i + 1];
        const B = rgba[i + 2];
        n++;
        if (R > 225 && G > 225 && B > 225) white++;
        else {
          const l = 0.3 * R + 0.59 * G + 0.11 * B;
          if (l > 60 && l < 200) mid++;
        }
      }
  }
  if (!n) return true;
  return mid / n < 0.35 || white / n >= 0.6;
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
  // 図面全体が傾けて配置されている PDF を水平に戻す（opts.straighten 指定時のみ。図面ごとの傾きの判定は未対応）
  const straighten = (mm: PageMm[]) =>
    mm.map((p) => {
      if (p.rasterMask || !opts.straighten) return p;
      const tilt = dominantTilt(p);
      if (Math.abs(tilt) < 1.5) return p;
      warnings.push(`図面が ${Math.abs(tilt).toFixed(1)}° 傾いていたため、水平に戻して読み取りました`);
      return rotatePageMm(p, -tilt);
    });
  const floorShifted: { level: number; dx: number; dy: number }[] = [];
  let mmPages = straighten(pages.map((p) => pageToMm(p, sc.mmPerPt)));
  // 読み直すときは、前の読み取りのメモ（帖数の食い違いなど）を捨てる
  let wAsm = warnings.length;
  let res = assembleModel(mmPages, opts.name ?? '新築計画', warnings, { module: opts.module });
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
        mmPages = straighten(pages.map((p) => pageToMm(p, sc.mmPerPt)));
        // 前の読み取りのメモを捨てる（スキャンの断り書きと縮尺の推定の説明は残す）
        const keep = warnings.splice(-2);
        warnings.splice(wAsm);
        warnings.push(...keep);
        wAsm = warnings.length;
        res = assembleModel(mmPages, opts.name ?? '新築計画', warnings, { module: opts.module });
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
      const note = warnings.pop()!;
      warnings.splice(wAsm);
      warnings.push(note);
      wAsm = warnings.length;
      res = assembleModel(mmPages, opts.name ?? '新築計画', warnings, { module: opts.module });
    } else if (Math.abs(med - 1) > 0.15) {
      warnings.push('図面の帖数と解析した面積に差があります。縮尺をご確認ください');
    }
  }
  // 立面図の建物の幅で平面図の縮尺を確かめる（立面図の縮尺は「1階FL」「2階FL」の間隔と階高の数字から分かる）。
  // 3 面以上で同じ比だけ平面図が小さい／大きいときは、平面図の縮尺の判定違い（1/50 と 1/60 など）なので読み直す
  if (!scanned && !opts.scaleDenominator && !opts.mmPerPt && res.floors.length) {
    try {
      const elev0 = readElevationHeights(pages);
      const v0 = readElevationViews(pages, sc.mmPerPt, elev0);
      const chk = planScaleFromElevation(res.floors, v0, res.northAngleDeg);
      if (chk && Math.abs(chk.k - 1) > 0.08) {
        const den0 = sc.mmPerPt / PT_TO_MM;
        const raw = den0 * chk.k;
        const cands = [...STANDARD, 60, 75, 80];
        if (sc.denominator) for (const f of [Math.SQRT2, Math.SQRT1_2, 2, 0.5]) cands.push(sc.denominator * f);
        const snap = cands.find((c) => Math.abs(c / raw - 1) < 0.04);
        if (snap) {
          sc = { ...sc, mmPerPt: snap * PT_TO_MM, denominator: Number.isInteger(snap) ? snap : null };
          scaleSource = 'elevation';
          warnings.splice(wAsm);
          warnings.push(`立面図の建物の幅（${chk.n} 面）が平面図の ${chk.k.toFixed(2)} 倍だったため、平面図の縮尺を 約1/${Math.round(den0)} → 1/${Math.round(snap)} に直しました`);
          wAsm = warnings.length;
          mmPages = straighten(pages.map((p) => pageToMm(p, sc.mmPerPt)));
          res = assembleModel(mmPages, opts.name ?? '新築計画', warnings, { module: opts.module });
        }
      }
    } catch {
      // 立面図が読めなくても平面図の読み取りはそのまま
    }
  }
  // 画像の線の太さは実際の壁厚と違う（内壁は太線1本など）ので、3D 用に 90〜200mm に収める
  if (scanned) for (const f of res.floors) for (const w of f.walls) w.thickness = Math.min(200, Math.max(90, w.thickness));
  const allRooms = res.floors.flatMap((f) => f.rooms);
  if (!scanned && allRooms.length >= 4 && !allRooms.some((r) => !['室', '収納', '階段'].includes(r.name))) {
    warnings.push('室名の文字を読み取れませんでした（PDF にフォントが埋め込まれていない・文字が図形化されている可能性）。部屋名と用途を下の一覧で指定してください');
  }
  if (sc.source === 'default' && scaleSource === 'default' && !scanned) warnings.push('縮尺を特定できなかったため 1/100 として解析しました');

  // 立面図のページがあれば、そこに書かれた高さ（GL から 1 階床・階高・最高高さ・屋根勾配）を使う（無ければ標準値）
  const elev = readElevationHeights(pages);
  let heights: BuildingModel['heights'];
  if (elev) {
    const summary = applyElevationHeights(res.floors, elev);
    heights = { source: 'elevation', ...elev };
    warnings.push(`立面図の寸法から高さを読みました（${summary}）`);
  }
  // 立面図の 4 面（窓の並び）: 上下階の重ね位置を確かめる（1 枚の立面図の中では 1 階と 2 階の窓の位置関係が正しい）
  let views: ElevationView[] = [];
  try {
    views = res.floors.length ? readElevationViews(pages, sc.mmPerPt, elev) : [];
    if (views.length && res.floors.length >= 2 && !(globalThis as { __NO_ELEV_SHIFT?: boolean }).__NO_ELEV_SHIFT) {
      const grid = res.module ? res.module.size / 2 : undefined;
      const shifts = floorShiftsFromElevation(res.floors, views, res.northAngleDeg, grid);
      // 階ごとの直す量は 1 階に対するもの。根拠の無い上の階は、すぐ下の階と一緒に動かす（上の階は下の階に順に重ねてある）
      let carry = { x: 0, y: 0 };
      for (const f of [...res.floors].sort((a, b) => a.level - b.level)) {
        if (f.level === Math.min(...res.floors.map((x) => x.level))) continue;
        const sh = shifts.find((x) => x.level === f.level);
        const below = res.floors.find((x) => x.level === f.level - 1);
        let d = carry;
        if (sh && below) {
          d = { x: sh.dx, y: sh.dy };
          // 階段の重なりが悪くなる動かし方はしない（階段は上下階で同じ位置に通る）
          const before = bestStairOverlap(below, f);
          translateFloor(f, d);
          const after = bestStairOverlap(below, f);
          translateFloor(f, { x: -d.x, y: -d.y });
          if (before != null && after != null && after < before - 0.15) {
            warnings.push(`立面図の窓の位置からは ${f.level}階が ${describeShift(d.x, d.y)} ずれて見えますが、階段の重なりが悪くなるため動かしていません（方眼の「上下階」で確かめてください）`);
            d = carry;
          } else {
            warnings.push(`立面図の窓の位置と比べて、${f.level}階の重ね位置を ${describeShift(d.x, d.y)} 直しました（根拠: ${sh.evidence.join('・')}）`);
            floorShifted.push({ level: f.level, dx: d.x, dy: d.y });
          }
        }
        if (d.x || d.y) translateFloor(f, d);
        carry = d;
      }
    }
  } catch (e) {
    warnings.push(`立面図の窓を読めませんでした（${(e as Error).message}）`);
    views = [];
  }

  // 外皮の後処理: 一部だけ外に面する内壁を分け、外形に沿って壁の無い区間を外壁で補う（3D で家に穴が開かないように）
  for (const f of res.floors) {
    const stacked = mergeStackedWalls(f);
    if (stacked) warnings.push(`${f.level}階: 平面詳細図の仕上げの線を壁として重ねて読んだ所を ${stacked} 本まとめました（詳細図より提案用の平面図 1/100 の方が正確に立ち上がります）`);
    const r = repairEnvelope(f);
    if (r.added) warnings.push(`${f.level}階: 外形に沿って壁が読めなかった ${r.added} か所（計 ${(r.addedLen / 1000).toFixed(1)} m）に外壁を補いました${r.glazed ? `（うち LDK の ${r.glazed} か所は掃き出し窓）` : ''}。修正画面で確認してください`);
  }

  // 1 間を超える張り出しの足元に柱を立てる（修正画面の「柱」で変更・削除できる）
  for (const up of res.floors) {
    const lo = res.floors.find((x) => x.level === up.level - 1);
    if (!lo) continue;
    const add = autoOverhangPosts(lo, up);
    if (!add.length) continue;
    lo.posts = [...(lo.posts ?? []), ...add];
    warnings.push(`${up.level}階の 1 間を超える張り出しの足元に、${lo.level}階の柱を ${add.length} 本立てました（修正画面の「柱」で変更・削除できます）`);
  }

  // 立面図の窓の線から、窓ごとの腰高・高さ（平面図の同じ面の外壁の窓と横の位置で対応させる）
  let elevationWindows: BuildingModel['report']['elevationWindows'];
  try {
    if (views.length) {
      const r = applyElevationWindows(res.floors, views, res.northAngleDeg);
      warnings.push(...r.notes);
      elevationWindows = { views: views.length, facades: r.facades, matched: r.matched, changed: r.changed, added: r.added, total: r.total };
    }
  } catch (e) {
    warnings.push(`立面図の窓を読めませんでした（${(e as Error).message}）`);
  }
  const pageMap = buildPageMap(pages, res.floorPages, views, elevationWindows, !!elev);
  // 立面図のページの外部仕上表（屋根・外壁・サッシ・玄関ドアの材料と色）
  let finishTable: BuildingModel['report']['finishTable'];
  try {
    const rows = readExteriorFinishTable(pages);
    if (rows.length) {
      finishTable = rows.map(({ part, text, color }) => ({ part, text, ...(color ? { color } : {}) }));
      const pg = rows[0].pageIndex;
      const info = pageMap.find((p) => p.page === pg);
      if (info) info.used = [info.used, '外部仕上表'].filter(Boolean).join('・');
    }
  } catch {
    // 仕上表が読めなくても読み取りはそのまま
  }

  const { thicknesses, areaTable, floorPages: _fp, ...model } = res;
  return {
    ...model,
    ...(heights ? { heights } : {}),
    report: {
      pages: pages.length,
      scaleDenominator: sc.denominator,
      mmPerPt: sc.mmPerPt,
      scaleSource,
      wallThicknesses: scanned ? [...new Set(res.floors.flatMap((f) => f.walls.map((w) => Math.round(w.thickness))))].sort((a, b) => a - b) : thicknesses,
      warnings: [...new Set(warnings)],
      timingsMs: { analyze: Math.round(performance.now() - t0) },
      northDetected: res.northDetected,
      ...(Object.keys(areaTable).length ? { areaTable } : {}),
      ...(pageMap.length ? { pageMap } : {}),
      ...(elevationWindows ? { elevationWindows } : {}),
      ...(finishTable ? { finishTable } : {}),
      ...(floorShifted.length ? { floorShifts: floorShifted } : {}),
    },
  };
}

/** 上下階の階段の重なり（いちばん重なる組の IoU）。どちらかに階段が無ければ null */
function bestStairOverlap(lo: BuildingModel['floors'][number], up: BuildingModel['floors'][number]): number | null {
  if (!lo.stairs.length || !up.stairs.length) return null;
  let best = 0;
  for (const a of lo.stairs) for (const b of up.stairs) best = Math.max(best, stairIoU(a, b));
  return best;
}

/** 「東へ 910mm」「北へ 455mm・東へ 910mm」（図面の上 = 北として） */
function describeShift(dx: number, dy: number): string {
  return [dy ? `${dy < 0 ? '上（北）' : '下（南）'}へ ${Math.abs(dy)}mm` : '', dx ? `${dx > 0 ? '右（東）' : '左（西）'}へ ${Math.abs(dx)}mm` : ''].filter(Boolean).join('・');
}

/** 各ページの中身と、読み取りに使ったこと（何階の平面図・高さの寸法・窓の高さ） */
function buildPageMap(pages: PageVectors[], floorPages: Record<number, number>, views: ElevationView[], ew: BuildingModel['report']['elevationWindows'], heightsRead: boolean): PageInfo[] {
  return pages.map((p) => {
    const floors = Object.entries(floorPages)
      .filter(([, pg]) => pg === p.pageIndex)
      .map(([lv]) => Number(lv))
      .sort((a, b) => a - b);
    const { kind, title } = classifyPage(p.texts, p.segments.length, floors);
    let used: string | undefined;
    if (floors.length) used = `${floors.join('・')}階の間取り`;
    else if (kind === 'elevation') {
      const onPage = views.filter((v) => v.pageIndex === p.pageIndex);
      const parts = [heightsRead ? '床・階高・屋根勾配' : '', onPage.length && ew?.matched ? `窓の高さ ${ew.matched} か所` : ''].filter(Boolean);
      used = parts.length ? parts.join('・') : undefined;
    }
    return { page: p.pageIndex, kind, title, ...(used ? { used } : {}) };
  });
}

/**
 * 立面図だけの PDF（平面図と別ファイルで保存されているとき）から高さを読む。立面図のページが無ければ null。
 * 文字だけ読めばよいので、壁の検出はしない（速い）
 */
export async function readElevationPdf(data: Uint8Array, pdfjs: PdfjsLike, opts: ParseOptions = {}): Promise<ElevationHeights | null> {
  const pages = await loadPdfVectors(data, pdfjs, opts);
  return readElevationHeights(pages);
}

/** 別ファイルの立面図から読めるもの一式（高さの寸法・4 面の窓・外部仕上表） */
export interface ElevationSheet {
  heights: ElevationHeights | null;
  views: ElevationView[];
  finishTable: { part: string; text: string; color?: string }[];
}

/**
 * 立面図だけの PDF から、高さの寸法・4 面の窓・外部仕上表を読む（平面図と別に保存されているとき）。
 * @param mmHint 平面図の縮尺（立面図に「N階FL」が無いときに使う）
 */
export async function readElevationSheet(data: Uint8Array, pdfjs: PdfjsLike, opts: ParseOptions & { mmHint?: number } = {}): Promise<ElevationSheet> {
  const pages = await loadPdfVectors(data, pdfjs, opts);
  const heights = readElevationHeights(pages);
  const mm = opts.mmHint ?? detectScale(pages).mmPerPt;
  let views: ElevationView[] = [];
  try {
    views = readElevationViews(pages, mm, heights);
  } catch {
    views = [];
  }
  let finishTable: ElevationSheet['finishTable'] = [];
  try {
    finishTable = readExteriorFinishTable(pages).map(({ part, text, color }) => ({ part, text, ...(color ? { color } : {}) }));
  } catch {
    finishTable = [];
  }
  return { heights, views, finishTable };
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
