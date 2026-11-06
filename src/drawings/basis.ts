/**
 * 見積の「数量の根拠」シート（A3 横・図枠つき）: 拾った数量を図面の上に色で塗って示す。
 *  1. 床面積・施工面積 … 各階の平面図に、床面積に入る所／入れない所（吹抜・バルコニー・ガレージ）／施工面積に足す所（ポーチ・2 階の下の屋外）を色分け
 *  2. 外壁面積 … 方位ごとの立面に、基礎の立ち上がり・各階の外壁・パラペット・妻壁の帯を色分けし、帯ごとの長さ × 高さ = ㎡
 *  3. 屋根・軒天・断熱 … 屋根の平面（各階の外形の重ね合わせ）と軒の出の帯、張り出しの床下、ガレージの上
 *  4. 床仕上げ・建具 … 部屋をフローリング・フロアタイル・畳・土間で色分け、室内の建具の位置
 * 数字は見積の拾い（estimate/areas.ts の takeoff）と同じ関数で出す。数字を見比べなくても、色と図で「なぜこの数量か」が分かることが目的
 */
import type { BuildingModel, Vec2 } from '../core/types';
import { polygonArea, polygonCentroid } from '../core/geometry';
import type { Areas, TakeoffOptions } from '../estimate/areas';
import { areaBasis, wallBasis, roofBasis, interiorBasis, exposedRegion, EXCLUDE_LABEL, WALL_DIRS, WALL_DIR_JA, WALL_KIND_LABEL, INTERIOR_CAT_LABEL, rightVec, type WallKind, type InteriorCat, type WallPiece, type WallRow } from '../estimate/basis';
import { floorPlanParts } from './plan';
import { composeSheet, svgTable, boxedTitle, esc, type SheetInfo, type Panel } from './sheet';

export type BasisSheetId = 'area' | 'wall' | 'roof' | 'interior';
export interface BasisSheet {
  id: BasisSheetId;
  title: string;
  svg: string;
}

export interface BasisOptions {
  /** 設計士が上書きした数量（表に「→ 上書き」と出す） */
  overrides?: Partial<Areas>;
  /** 内部のシートに添える注意（この間取りで検討するオプションなど） */
  notes?: string[];
}

/** 色（紙に刷っても見分けられる、彩度を抑えた 6 色＋ハッチ） */
const C = {
  floor: '#4f86c6', // 床面積に入る
  void: '#e8a93a', // 吹抜
  balcony: '#4fa872', // バルコニー
  court: '#9a9a9a', // 中庭（入れない）
  garage: '#7d8aa0', // ガレージ
  porch: '#e07b4a', // ポーチ
  pilotis: '#8f63c9', // 2 階の下の屋外
  found: '#8d959e',
  wall1: '#4f86c6',
  wall2: '#4fa872',
  wall3: '#2fa3b5',
  parapet: '#e07b4a',
  gable: '#8f63c9',
  roof: '#4f86c6',
  eaves: '#e8a93a',
  flooring: '#d9b483',
  tile: '#8fb6dd',
  tatami: '#9cbf7a',
  doma: '#b7ada0',
  door: '#c0392b',
};
const WALL_COLOR: Record<WallKind, string> = { found: C.found, wall: C.wall1, parapet: C.parapet, gable: C.gable, garage: '#d9534f' };
const wallColor = (p: WallPiece) => (p.kind === 'wall' ? (p.level === 1 ? C.wall1 : p.level === 2 ? C.wall2 : C.wall3) : WALL_COLOR[p.kind]);

const FONT = `'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif`;
const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);
const pts = (poly: Vec2[]) => poly.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ');
let seq = 0;
const uid = (p: string) => `${p}${(seq = (seq + 1) % 1000000)}`;

/** 斜めのハッチ（塗りつぶしの代わり。色付きの薄い地に斜線） */
function hatchDef(id: string, color: string, period = 320): string {
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${period}" height="${period}" patternTransform="rotate(45)"><rect width="${period}" height="${period}" fill="${color}" fill-opacity="0.16"/><line x1="0" y1="0" x2="0" y2="${period}" stroke="${color}" stroke-width="${Math.round(period * 0.22)}" stroke-opacity="0.75"/></pattern>`;
}

/** 白い縁取りの文字（図面の線の上でも読める） */
function label(x: number, y: number, lines: string[], fs = 230, color = '#1d1d1d', anchor: 'middle' | 'start' | 'end' = 'middle', weight = 600): string {
  let s = '';
  const lh = fs * 1.25;
  const y0 = y - ((lines.length - 1) * lh) / 2;
  lines.forEach((t, i) => {
    const size = i === 0 ? fs : fs * 0.78;
    s += `<text x="${x.toFixed(0)}" y="${(y0 + i * lh + size * 0.35).toFixed(0)}" font-size="${size.toFixed(0)}" font-weight="${i === 0 ? weight : 400}" text-anchor="${anchor}" fill="${color}" stroke="#fff" stroke-width="${(size * 0.28).toFixed(0)}" stroke-linejoin="round" paint-order="stroke">${esc(t)}</text>`;
  });
  return s;
}

/** 凡例（色の四角＋説明） */
function legend(x: number, y: number, items: { color: string; hatch?: boolean; text: string }[], fs = 230): { svg: string; h: number } {
  let s = '';
  const rh = fs * 1.7;
  items.forEach((it, i) => {
    const yy = y + i * rh;
    const id = it.hatch ? uid('lg') : '';
    if (it.hatch) s += `<defs>${hatchDef(id, it.color)}</defs>`;
    s += `<rect x="${x}" y="${yy.toFixed(0)}" width="${fs * 1.6}" height="${fs * 1.1}" fill="${it.hatch ? `url(#${id})` : it.color}" fill-opacity="${it.hatch ? 1 : 0.55}" stroke="${it.color}" stroke-width="12"/>`;
    s += `<text x="${x + fs * 2}" y="${(yy + fs * 0.9).toFixed(0)}" font-size="${fs}" fill="#222">${esc(it.text)}</text>`;
  });
  return { svg: s, h: items.length * rh };
}

/** 上書きした数量の注記 */
function ovNote(ov: Partial<Areas> | undefined, key: keyof Areas, auto: number, unit = '㎡'): string {
  const v = ov?.[key];
  if (typeof v !== 'number' || Math.abs(v - auto) < 1e-9) return '';
  return `→ 上書き ${v} ${unit}`;
}

/** 向きを揃えた外形（複数の外形を 1 つの path にして nonzero で塗ると、重なりが二重にならない） */
function unionPath(loops: Vec2[][]): string {
  return loops
    .filter((l) => l.length >= 3)
    .map((l) => {
      const L = polygonArea(l) < 0 ? l.slice().reverse() : l;
      return `M${L.map((p) => `${p.x.toFixed(0)} ${p.y.toFixed(0)}`).join('L')}Z`;
    })
    .join('');
}

// ---------------------------------------------------------------------------------------------
// 1. 床面積・施工面積
// ---------------------------------------------------------------------------------------------

function areaSheet(model: BuildingModel, opts: TakeoffOptions, info: SheetInfo, bo: BasisOptions): BasisSheet {
  const ab = areaBasis(model, opts);
  const a = ab.areas;
  const panels: Panel[] = [];
  let defs = '';
  for (let i = 0; i < ab.floors.length; i++) {
    const fb = ab.floors[i];
    const f = fb.floor;
    const parts = floorPlanParts(model, f, { sheet: info, showFurniture: false, showLandscape: false, showRoad: false, title: `${f.level}階 床面積の拾い` });
    defs += parts.defs;
    let s = parts.inner;
    // 床面積に入る所: 外形を塗り、引く区画（吹抜・バルコニー・ガレージ）はマスクで抜く
    const mid = uid('bs-fa');
    s += `<defs><mask id="${mid}"><rect x="${parts.vb.x}" y="${parts.vb.y}" width="${parts.vb.w}" height="${parts.vb.h}" fill="#000"/><path d="${unionPath(f.outline)}" fill="#fff" fill-rule="evenodd"/>${fb.excluded.map((e) => `<polygon points="${pts(e.room.polygon)}" fill="#000"/>`).join('')}</mask></defs>`;
    s += `<rect x="${parts.vb.x}" y="${parts.vb.y}" width="${parts.vb.w}" height="${parts.vb.h}" fill="${C.floor}" fill-opacity="0.26" mask="url(#${mid})"/>`;
    // 引く区画
    for (const e of fb.excluded) {
      const col = e.kind === 'void' ? C.void : e.kind === 'balcony' ? C.balcony : e.kind === 'court' ? C.court : C.garage;
      s += `<polygon points="${pts(e.room.polygon)}" fill="${col}" fill-opacity="0.5" stroke="${col}" stroke-width="30"/>`;
      const c = polygonCentroid(e.room.polygon);
      const note = e.kind === 'void' ? (f.level >= 2 ? '床面積に入れず 施工面積に' : '床面積に入れない') : e.kind === 'balcony' ? (f.level >= 2 ? '床面積に入れず 施工面積に' : '床面積に入れない') : e.kind === 'court' ? '床面積にも施工面積にも入れない' : '床面積に入れず 施工面積に';
      s += label(c.x, c.y + 260, [`${EXCLUDE_LABEL[e.kind]} ${f2(e.area)} ㎡`, note], 210);
    }
    // ポーチ（施工面積に）
    for (const r of fb.porch) {
      s += `<polygon points="${pts(r.polygon)}" fill="${C.porch}" fill-opacity="0.5" stroke="${C.porch}" stroke-width="30"/>`;
      const c = polygonCentroid(r.polygon);
      s += label(c.x, c.y, [`ポーチ ${f2(r.area)} ㎡`, '施工面積に'], 190);
    }
    // 2 階以上のバルコニー（外形の外にある分も施工面積に）
    for (const r of fb.countedBalcony) {
      if (fb.excluded.some((e) => e.room === r)) continue;
      s += `<polygon points="${pts(r.polygon)}" fill="${C.balcony}" fill-opacity="0.5" stroke="${C.balcony}" stroke-width="30"/>`;
      const c = polygonCentroid(r.polygon);
      s += label(c.x, c.y, [`バルコニー ${f2(r.area)} ㎡`, '施工面積に'], 190);
    }
    // 下の階から見た「上の階の下の屋外」（ピロティ・張り出し）: 上の階の外形をハッチし、この階の外形で抜く
    const upper = ab.floors[i + 1];
    if (upper && upper.overhang > 0.05) {
      const hid = uid('bs-ph');
      const mk = uid('bs-pm');
      s += `<defs>${hatchDef(hid, C.pilotis)}<mask id="${mk}"><rect x="${parts.vb.x}" y="${parts.vb.y}" width="${parts.vb.w}" height="${parts.vb.h}" fill="#000"/><path d="${unionPath(upper.floor.outline)}" fill="#fff" fill-rule="evenodd"/><path d="${unionPath(f.outline)}" fill="#000" fill-rule="evenodd"/></mask></defs>`;
      s += `<rect x="${parts.vb.x}" y="${parts.vb.y}" width="${parts.vb.w}" height="${parts.vb.h}" fill="url(#${hid})" mask="url(#${mk})"/>`;
      s += `<path d="${unionPath(upper.floor.outline)}" fill="none" stroke="${C.pilotis}" stroke-width="22" stroke-dasharray="260 140"/>`;
      // 注記はハッチのすぐ下（右寄り）に。細い帯なので上に載せない
      const ex = exposedRegion(upper.floor, f);
      const fb0 = bbox(f.outline.flat());
      const lx = ex ? Math.min(Math.max(ex.cx, fb0.minX + 2500), fb0.maxX - 2500) : (fb0.minX + fb0.maxX) / 2;
      const ly = ex ? Math.max(ex.maxY, fb0.maxY) + 420 : fb0.maxY + 420;
      s += label(lx, ly, [`${upper.level}階の下の屋外（張り出し・ピロティ） ${f2(upper.overhang)} ㎡`, f.level === 1 ? '施工面積に（紫の点線は上の階の外形）' : '外気に接する床（断熱・軒天に）'], 200, C.pilotis, 'middle');
    }
    // 見出し（階の床面積の式）
    const terms = [`外形 ${f2(fb.outline)}`, ...fb.excluded.map((e) => `− ${EXCLUDE_LABEL[e.kind]} ${f2(e.area)}`)];
    s += label(parts.vb.x + parts.vb.w / 2, parts.vb.y + 560, [`${f.level}階 床面積 ${f2(fb.floorArea)} ㎡`, `＝ ${terms.join(' ')}`], 340, '#1d1d1d');
    panels.push({ inner: s, vb: parts.vb });
  }
  // 右の表: 床面積 → 延床 → 施工面積の足し算、建築面積
  const rows: string[][] = [];
  for (const fb of ab.floors) rows.push([`${fb.level}階 床面積`, `${f2(fb.floorArea)} ㎡`, [`外形 ${f2(fb.outline)}`, ...fb.excluded.map((e) => `− ${EXCLUDE_LABEL[e.kind]} ${f2(e.area)}`)].join(' '), ovNote(bo.overrides, fb.level === 1 ? 'floor1' : fb.level === 2 ? 'floor2' : 'floor3', fb.floorArea)]);
  rows.push(['延床面積', `${f2(a.totalArea)} ㎡`, `${f2(a.totalTsubo)} 坪`, '']);
  const porchRooms = ab.floors.reduce((s, fb) => s + fb.porch.reduce((t, r) => t + r.area, 0), 0);
  rows.push(['＋ ポーチ', `${f2(porchRooms)} ㎡`, porchRooms > 0 ? 'ポーチの区画' : 'ポーチの区画なし', '']);
  rows.push(['＋ 2階の下の屋外', `${f2(ab.pilotis)} ㎡`, 'ピロティ・張り出しの下', '']);
  rows.push(['＋ ビルトインガレージ', `${f2(a.garageArea)} ㎡`, a.garageArea > 0 ? '床面積に入れず施工面積に' : 'なし', '']);
  rows.push(['　＝ 施工面積（追加分）', `${f2(a.extraArea)} ㎡`, '', ovNote(bo.overrides, 'extraArea', a.extraArea)]);
  rows.push(['＋ バルコニー', `${f2(a.balconyArea)} ㎡`, '2 階以上・中庭を除く', ovNote(bo.overrides, 'balconyArea', a.balconyArea)]);
  rows.push(['＋ 吹抜', `${f2(a.voidArea)} ㎡`, '2 階以上', ovNote(bo.overrides, 'voidArea', a.voidArea)]);
  rows.push(['施工面積', `${f2(a.constArea)} ㎡`, `${f2(a.constTsubo)} 坪`, '']);
  rows.push(['建築面積', `${f2(a.buildArea)} ㎡`, '各階の外形を真上から重ねた面積', ovNote(bo.overrides, 'buildArea', a.buildArea)]);
  const tbl = svgTable(0, 0, '床面積・施工面積（見積の拾い）', [{ label: '項目', w: 3900 }, { label: '数量', w: 2300, align: 'right' }, { label: '根拠', w: 5200 }, { label: '上書き', w: 2300 }], rows, { fontSize: 230, rowH: 420 });
  const lg = legend(0, tbl.h + 600, [
    { color: C.floor, text: '床面積に入る所（外形の内側）' },
    { color: C.void, text: '吹抜（床面積に入れず、2 階以上は施工面積に）' },
    { color: C.balcony, text: 'バルコニー（施工面積・防水に）' },
    { color: C.court, text: '中庭・テラス（どちらにも入れない）' },
    { color: C.garage, text: 'ビルトインガレージ（施工面積に・土間はポーチ扱い）' },
    { color: C.porch, text: 'ポーチ（施工面積に）' },
    { color: C.pilotis, hatch: true, text: '上の階の下の屋外（施工面積に）' },
  ]);
  const right = { svg: tbl.svg + lg.svg, w: tbl.w, h: tbl.h + 600 + lg.h };
  const title = '数量の根拠（床面積・施工面積）';
  return { id: 'area', title, svg: composeSheet(panels, { ...info, drawing: title }, { right, defs, gap: 2400 }) };
}

function bbox(p: Vec2[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const q of p) {
    if (q.x < minX) minX = q.x;
    if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.y > maxY) maxY = q.y;
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------------------------------------
// 2. 外壁面積
// ---------------------------------------------------------------------------------------------

/** 帯の行の名前: 「1階 外壁」「基礎の立ち上がり」「パラペット」「下屋パラペット（1階の縁）」「妻壁」 */
function rowName(r: WallRow, floors: number): string {
  if (r.kind === 'wall') return `${r.level}階 外壁`;
  if (r.kind === 'parapet') return r.level < floors ? `下屋パラペット（${r.level}階の縁）` : 'パラペット';
  return WALL_KIND_LABEL[r.kind].replace(/（.*$/, '');
}

function wallSheet(model: BuildingModel, opts: TakeoffOptions, info: SheetInfo, bo: BasisOptions): BasisSheet {
  const wb = wallBasis(model, opts);
  const panels: Panel[] = [];
  const floors = model.floors.slice().sort((a, b) => a.level - b.level);
  const siteFlat = floors.flatMap((f) => f.outline.flat());
  for (const dir of WALL_DIRS) {
    const ps = wb.pieces.filter((p) => p.dir === dir).sort((a, b) => a.near - b.near || (a.kind === 'garage' ? 1 : 0) - (b.kind === 'garage' ? 1 : 0));
    const right = rightVec(dir, wb.axes);
    const us = siteFlat.map((p) => p.x * right.x + p.y * right.y);
    const u0 = Math.min(...us, ...ps.map((p) => p.u0));
    const u1 = Math.max(...us, ...ps.map((p) => p.u1));
    const top = Math.max(wb.maxY, 3000);
    const yOf = (h: number) => -h; // GL = 0、上が負
    let s = '';
    // 帯の高さの点線（基礎・各階）
    const levels = [0, 500, ...wb.bands.map((b) => b.y1)];
    for (const lv of levels) s += `<line x1="${(u0 - 900).toFixed(0)}" y1="${yOf(lv)}" x2="${(u1 + 900).toFixed(0)}" y2="${yOf(lv)}" stroke="#777" stroke-width="8" stroke-dasharray="140 90"/>`;
    s += `<line x1="${(u0 - 1200).toFixed(0)}" y1="0" x2="${(u1 + 1200).toFixed(0)}" y2="0" stroke="#111" stroke-width="22" stroke-dasharray="500 110 50 110"/>`;
    s += label(u0 - 1000, -80, ['GL'], 190, '#111', 'start', 400);
    // 帯（遠い物から。手前の物に隠れる壁も拾っているので、少し透かして重ねる）
    for (const p of ps) {
      const col = wallColor(p);
      const w = p.u1 - p.u0;
      if (p.kind === 'garage') {
        const hid = uid('bs-gw');
        s += `<defs>${hatchDef(hid, col, 260)}</defs>`;
        s += `<rect x="${p.u0.toFixed(0)}" y="${yOf(p.y1).toFixed(0)}" width="${w.toFixed(0)}" height="${(p.y1 - p.y0).toFixed(0)}" fill="url(#${hid})" stroke="${col}" stroke-width="18" stroke-dasharray="120 80"/>`;
        continue;
      }
      if (p.kind === 'gable') {
        s += `<polygon points="${p.u0.toFixed(0)},${yOf(p.y0).toFixed(0)} ${p.u1.toFixed(0)},${yOf(p.y0).toFixed(0)} ${((p.u0 + p.u1) / 2).toFixed(0)},${yOf(p.y1).toFixed(0)}" fill="${col}" fill-opacity="0.55" stroke="#fff" stroke-width="14"/>`;
        s += label((p.u0 + p.u1) / 2, yOf(p.y0) - (p.y1 - p.y0) * 0.3, [`${f1(p.area)}`], 220, '#1d1d1d');
        continue;
      }
      s += `<rect x="${p.u0.toFixed(0)}" y="${yOf(p.y1).toFixed(0)}" width="${w.toFixed(0)}" height="${(p.y1 - p.y0).toFixed(0)}" fill="${col}" fill-opacity="0.62" stroke="#fff" stroke-width="14"/>`;
      // 帯の中に ㎡（幅があるときだけ。基礎の帯は細いので数字を小さく）
      const hh = p.y1 - p.y0;
      if (w >= 1500 && hh >= 380) s += label((p.u0 + p.u1) / 2, yOf((p.y0 + p.y1) / 2), [`${f1(p.area)}`], Math.min(230, hh * 0.55), '#1d1d1d');
      else if (w >= 900 && hh >= 380) s += label((p.u0 + p.u1) / 2, yOf((p.y0 + p.y1) / 2), [`${f1(p.area)}`], Math.min(160, hh * 0.5), '#1d1d1d');
    }
    // 左に帯の高さ
    const bandLabels: { y: number; t: string }[] = [{ y: 250, t: `基礎 ${f1(0.5)}` }];
    for (const b of wb.bands) bandLabels.push({ y: (b.y0 + b.y1) / 2, t: `${b.level}階 ${((b.y1 - b.y0) / 1000).toFixed(2).replace(/0$/, '')}` });
    const parapet = ps.find((p) => p.kind === 'parapet');
    if (parapet) bandLabels.push({ y: (parapet.y0 + parapet.y1) / 2, t: `パラペット ${f1((parapet.y1 - parapet.y0) / 1000)}` });
    for (const bl of bandLabels) s += label(u0 - 1000, yOf(bl.y), [bl.t], 170, '#333', 'start', 400);
    // 方位の小計と図面名
    const d = wb.byDir[dir];
    s += label((u0 + u1) / 2, yOf(top) - 700, [`${WALL_DIR_JA[dir]}面 ${f1(d.total)} ㎡`, d.rows.map((r) => `${rowName(r, wb.bands.length)} ${f1(r.len)}×${f1(r.height)}`).join('　')], 300);
    s += boxedTitle((u0 + u1) / 2, 1000, `${WALL_DIR_JA[dir]}面 外壁の拾い S:1/{{SCALE}}`, 280);
    panels.push({ inner: s, vb: { x: u0 - 2400, y: yOf(top) - 1400, w: u1 - u0 + 2400 + 1600, h: top + 1400 + 1000 + 700 } });
  }
  // 右の表: 方位ごとの帯 → 合計 → ガレージを引いた壁の断熱
  const rows: string[][] = [];
  for (const dir of WALL_DIRS) {
    const d = wb.byDir[dir];
    for (const r of d.rows) rows.push([`${WALL_DIR_JA[dir]}面 ${rowName(r, wb.bands.length)}`, `${f1(r.len)} m × ${f1(r.height)} m`, `${f1(r.area)} ㎡`]);
    rows.push([`${WALL_DIR_JA[dir]}面 計`, '', `${f1(d.total)} ㎡`]);
  }
  rows.push(['外壁面積 合計', '開口は引かない（社内の拾い方）', `${f1(wb.extWall)} ㎡`]);
  if (wb.garageWall > 0) {
    rows.push(['− ガレージの外壁', '断熱を入れない', `${f1(wb.garageWall)} ㎡`]);
    rows.push(['壁の断熱面積', '', `${f1(wb.insulWall)} ㎡`]);
  }
  const ov = ovNote(bo.overrides, 'extWall', wb.extWall);
  if (ov) rows.push(['上書き', ov, '']);
  const tbl = svgTable(0, 0, '外壁面積（見積の拾い）', [{ label: '帯', w: 3700 }, { label: '長さ × 高さ', w: 3600 }, { label: '面積', w: 2200, align: 'right' }], rows, { fontSize: 220, rowH: 400 });
  const items: { color: string; hatch?: boolean; text: string }[] = [
    { color: C.found, text: '基礎の立ち上がり 0.5 m（1 階の外周に足す）' },
    { color: C.wall1, text: '1階の外壁（外周 × 階高）' },
  ];
  if (wb.bands.length >= 2) items.push({ color: C.wall2, text: '2階の外壁（外周 × 階高）' });
  if (wb.bands.length >= 3) items.push({ color: C.wall3, text: '3階の外壁' });
  if (wb.pieces.some((p) => p.kind === 'parapet')) items.push({ color: C.parapet, text: 'パラペット 0.9 m（最上階の外周＋下屋の縁）' });
  if (wb.pieces.some((p) => p.kind === 'gable')) items.push({ color: C.gable, text: '妻壁の三角（短辺 × 勾配の高さ ÷ 2 を 2 面）' });
  if (wb.garageWall > 0) items.push({ color: '#d9534f', hatch: true, text: 'ガレージの外壁（壁の断熱から引く）' });
  const lg = legend(0, tbl.h + 600, items);
  const note = `<text x="0" y="${(tbl.h + 600 + lg.h + 500).toFixed(0)}" font-size="200" fill="#444">手前の壁に隠れる壁（引っ込んだ面）も外周として拾うので、帯は少し透かして重ねています。</text>`;
  const right = { svg: tbl.svg + lg.svg + note, w: tbl.w, h: tbl.h + 600 + lg.h + 700 };
  const title = '数量の根拠（外壁面積）';
  return { id: 'wall', title, svg: composeSheet(panels, { ...info, drawing: title }, { right, gap: 2000 }) };
}

// ---------------------------------------------------------------------------------------------
// 3. 屋根・軒天・断熱
// ---------------------------------------------------------------------------------------------

function roofSheet(model: BuildingModel, opts: TakeoffOptions, info: SheetInfo, bo: BasisOptions): BasisSheet {
  const rb = roofBasis(model, opts);
  const all = rb.loops.flatMap((l) => l.loop);
  const bb = bbox(all);
  const eave = rb.eavesM * 1000;
  const pad = 2600 + eave;
  const vb = { x: bb.minX - pad, y: bb.minY - pad - 900, w: bb.maxX - bb.minX + pad * 2, h: bb.maxY - bb.minY + pad * 2 + 900 + 1400 };
  let s = '';
  // 屋根の平面（重ね合わせ）
  s += `<path d="${unionPath(rb.loops.map((l) => l.loop))}" fill="${C.roof}" fill-opacity="0.3" stroke="none"/>`;
  // 軒の出の帯: 辺の外側に 軒の出 × 辺の長さ の長方形（角は数えない＝拾いの式のまま）
  if (eave > 0)
    for (const r of rb.eaveRuns) {
      const o = r.outward;
      const q = [r.a, r.b, { x: r.b.x + o.x * eave, y: r.b.y + o.y * eave }, { x: r.a.x + o.x * eave, y: r.a.y + o.y * eave }];
      s += `<polygon points="${pts(q)}" fill="${C.eaves}" fill-opacity="0.5" stroke="${C.eaves}" stroke-width="10"/>`;
    }
  // 各階の外形（下の階は点線）
  for (const l of rb.loops) s += `<polygon points="${pts(l.loop)}" fill="none" stroke="${l.level === rb.topLevel ? '#1d1d1d' : '#555'}" stroke-width="${l.level === rb.topLevel ? 26 : 16}"${l.level === rb.topLevel ? '' : ' stroke-dasharray="260 140"'}/>`;
  // 張り出しの床下（上の階が下の階の外にある所）: ハッチ
  const floors = model.floors.slice().sort((a, b) => a.level - b.level);
  for (let i = 1; i < floors.length; i++) {
    const hid = uid('bs-oh');
    const mk = uid('bs-om');
    s += `<defs>${hatchDef(hid, C.pilotis)}<mask id="${mk}"><rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="#000"/><path d="${unionPath(floors[i].outline)}" fill="#fff" fill-rule="evenodd"/><path d="${unionPath(floors[i - 1].outline)}" fill="#000" fill-rule="evenodd"/></mask></defs>`;
    s += `<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="url(#${hid})" mask="url(#${mk})"/>`;
  }
  // ガレージの上が屋根（上の階が載っていない所）: 赤のハッチ
  for (const g of rb.garage) {
    if (g.uncovered <= 0.05) continue;
    const fi = floors.findIndex((f) => f.level === g.level);
    const uppers = floors.slice(fi + 1);
    const hid = uid('bs-gh');
    const mk = uid('bs-gm');
    s += `<defs>${hatchDef(hid, '#d9534f')}<mask id="${mk}"><rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="#000"/><polygon points="${pts(g.room.polygon)}" fill="#fff"/>${uppers.map((u) => `<path d="${unionPath(u.outline)}" fill="#000" fill-rule="evenodd"/>`).join('')}</mask></defs>`;
    s += `<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="url(#${hid})" mask="url(#${mk})"/>`;
    const c = polygonCentroid(g.room.polygon);
    s += label(c.x, c.y, [`ガレージの上の屋根 ${f2(g.uncovered)} ㎡`, '天井の断熱から引く'], 200, '#8b1e1e');
  }
  // 見出し
  const cx = (bb.minX + bb.maxX) / 2;
  s += label(cx, bb.minY - pad - 300, [`屋根面積 ${f1(rb.roofArea)} ㎡ ＝（平面 ${f2(rb.union)} ＋ 軒の出 ${f2(rb.eaveArea)}）× 勾配 ${rb.slope.toFixed(3)}`, `${rb.roofName}　軒の出 ${(rb.eavesM * 1000).toFixed(0)} mm × 軒先の総延長 ${f1(rb.eaveLen)} m`], 320);
  const cen = { x: cx, y: (bb.minY + bb.maxY) / 2 };
  s += label(cen.x, cen.y, [`屋根の平面 ${f2(rb.union)} ㎡`, '各階の外形を真上から重ねた面積（吹抜の上にも屋根はある）'], 300, '#1b3f6b');
  s += boxedTitle(cx, bb.maxY + pad - 300, `屋根伏せ（拾い） S:1/{{SCALE}}`, 300);
  // 右の表
  const a = rb.areas;
  const rows: string[][] = [
    ['屋根の平面', `${f2(rb.union)} ㎡`, '各階の外形の重ね合わせ'],
    ['＋ 軒の出', `${f2(rb.eaveArea)} ㎡`, `${f1(rb.eaveLen)} m × ${rb.eavesM.toFixed(2)} m`],
    ['× 勾配の倍率', rb.slope.toFixed(3), rb.roofName],
    ['屋根面積', `${f1(rb.roofArea)} ㎡`, ovNote(bo.overrides, 'roofArea', rb.roofArea)],
    ['軒先（鼻隠し）', `${f1(a.eaveLen)} m`, opts.roofType === 'gable' ? '長手 2 辺＋軒の出' : opts.roofType === 'shed' ? '短辺 1 辺（水下）＋下屋の塊の短辺' : '外周'],
    ['棟長さ', `${f1(a.ridgeLen)} m`, opts.roofType === 'shed' ? '片流れは社内の既定 10 m' : opts.roofType === 'flat' ? 'なし' : '長手'],
    ['軒天面積', `${f1(rb.soffitArea)} ㎡`, `軒の出 ${f2(rb.eaveArea)} ＋ 張り出しの裏 ${f2(rb.overhang)}${rb.garageCeil + rb.porchCeil > 0 ? ` ＋ ガレージ・ポーチの天井 ${f2(rb.garageCeil + rb.porchCeil)}` : ''}`],
    ['断熱（天井＆外部床）', `${f1(rb.insulArea)} ㎡`, `平面 ${f2(rb.union)} − ガレージ・ポーチの上 ${f2(rb.garageCeil + rb.porchCeil)} ＋ 外気に接する床 ${f2(rb.overhang)}`],
  ];
  const tbl = svgTable(0, 0, '屋根・軒天・断熱（見積の拾い）', [{ label: '項目', w: 3400 }, { label: '数量', w: 2300, align: 'right' }, { label: '根拠', w: 6200 }], rows, { fontSize: 230, rowH: 420 });
  const lg = legend(0, tbl.h + 600, [
    { color: C.roof, text: '屋根の平面（各階の外形の重ね合わせ）' },
    { color: C.eaves, text: '軒の出（最上階の外周＋下屋の縁 × 出）' },
    { color: C.pilotis, hatch: true, text: '張り出しの床下（軒天・外気に接する床の断熱に）' },
    { color: '#d9534f', hatch: true, text: 'ガレージの上の屋根（天井の断熱から引く）' },
  ]);
  const right = { svg: tbl.svg + lg.svg, w: tbl.w, h: tbl.h + 600 + lg.h };
  const title = '数量の根拠（屋根・軒天・断熱）';
  return { id: 'roof', title, svg: composeSheet([{ inner: s, vb }], { ...info, drawing: title }, { right, gap: 2000 }) };
}

// ---------------------------------------------------------------------------------------------
// 4. 床仕上げ・建具
// ---------------------------------------------------------------------------------------------

const CAT_COLOR: Record<InteriorCat, string> = { flooring: C.flooring, tile: C.tile, tatami: C.tatami, doma: C.doma, garage: C.garage, porch: C.porch, none: '' };

function interiorSheet(model: BuildingModel, opts: TakeoffOptions, info: SheetInfo, bo: BasisOptions): BasisSheet {
  const ib = interiorBasis(model, opts);
  const panels: Panel[] = [];
  let defs = '';
  for (const fb of ib.floors) {
    const tint: Record<string, string> = {};
    for (const r of fb.rooms) if (CAT_COLOR[r.cat]) tint[r.room.id] = CAT_COLOR[r.cat];
    const parts = floorPlanParts(model, fb.floor, { sheet: info, showFurniture: false, showLandscape: false, showRoad: false, roomTint: tint, title: `${fb.level}階 床仕上げ・建具の拾い` });
    defs += parts.defs;
    let s = parts.inner;
    // 部屋ごとの面積と区分
    for (const r of fb.rooms) {
      if (!CAT_COLOR[r.cat] || r.room.polygon.length < 3 || r.area < 0.8) continue;
      const c = polygonCentroid(r.room.polygon);
      s += label(c.x, c.y + 330, [`${f2(r.area)} ㎡`], 170, '#333', 'middle', 400);
    }
    // 室内の建具（数える物）
    fb.doors.forEach((d, i) => {
      s += `<circle cx="${d.x.toFixed(0)}" cy="${d.y.toFixed(0)}" r="150" fill="${C.door}" fill-opacity="0.85" stroke="#fff" stroke-width="18"/>`;
      s += `<text x="${d.x.toFixed(0)}" y="${(d.y + 60).toFixed(0)}" font-size="160" font-weight="600" text-anchor="middle" fill="#fff">${i + 1}</text>`;
    });
    // トイレ
    for (const t of fb.toilets) {
      const c = polygonCentroid(t.polygon);
      s += label(c.x, c.y - 330, ['WC ●'], 170, '#1b3f6b', 'middle', 600);
    }
    s += label(parts.vb.x + parts.vb.w / 2, parts.vb.y + 560, [`${fb.level}階 床仕上げ・建具の拾い`, `室内の建具 ${fb.doors.length} 箇所（赤丸）　トイレ ${fb.toilets.length} ヵ所`], 340);
    panels.push({ inner: s, vb: parts.vb });
  }
  const a = ib.areas;
  const rows: string[][] = [
    ['フローリング', `${f2(ib.byCat.flooring)} ㎡`, '居室・LDK・ホール・書斎（床を変えた部屋はそれに従う）', ovNote(bo.overrides, 'flooringArea', a.flooringArea)],
    ['フロアタイル', `${f2(ib.byCat.tile)} ㎡`, '洗面脱衣・トイレ・収納（土間の収納を除く）', ovNote(bo.overrides, 'floorTileArea', a.floorTileArea)],
    ['畳', `${ib.tatamiCount} 枚`, `畳の部屋 ${f2(ib.byCat.tatami)} ㎡ ÷ 1.62`, ovNote(bo.overrides, 'tatami1', a.tatami1, '枚')],
    ['内部ポーチ（玄関土間）', `${f2(ib.byCat.doma)} ㎡`, '玄関＋土間の収納', ovNote(bo.overrides, 'porchIn', a.porchIn)],
    ['外部ポーチ（土間コン）', `${f2(a.porchOut)} ㎡`, ib.byCat.porch + ib.byCat.garage > 0 ? `ポーチ ${f2(ib.byCat.porch)} ＋ ガレージ土間 ${f2(ib.byCat.garage)}` : 'ポーチの区画が無いので標準 1,365×1,820', ovNote(bo.overrides, 'porchOut', a.porchOut)],
    ['建具（室内）', `${ib.doors} 箇所`, '片開き戸・引戸（玄関ドア・勝手口は除く）', ovNote(bo.overrides, 'doors', a.doors, '箇所')],
    ['トイレ', `${ib.toilets} ヵ所`, '便所の区画＋「洗面・トイレ」の区画', ovNote(bo.overrides, 'toilets', a.toilets, 'ヵ所')],
    ['階段', `${ib.stairs} ヵ所`, '階数 − 1', ovNote(bo.overrides, 'stairs', a.stairs, 'ヵ所')],
    ['キッチンの形', ib.kitchenType === 'island' ? 'アイランド' : ib.kitchenType === 'peninsula' ? 'ペニンシュラ' : ib.kitchenType === 'wall' ? '壁付け' : ib.kitchenType === 'two' ? 'Ⅱ型' : ib.kitchenType === 'l' ? 'L 型' : '—', '図面の記号・3D の家具から（見積のキッチンの既定）', ''],
  ];
  const tbl = svgTable(0, 0, '床仕上げ・建具など（見積の拾い）', [{ label: '項目', w: 3300 }, { label: '数量', w: 2000, align: 'right' }, { label: '根拠', w: 5400 }, { label: '上書き', w: 2200 }], rows, { fontSize: 220, rowH: 400 });
  const lg = legend(0, tbl.h + 600, (['flooring', 'tile', 'tatami', 'doma', 'porch', 'garage'] as InteriorCat[]).filter((k) => ib.byCat[k] > 0 || k === 'flooring').map((k) => ({ color: CAT_COLOR[k], text: INTERIOR_CAT_LABEL[k] })).concat([{ color: C.door, text: '室内の建具（数える物）' }]));
  let notes = '';
  if (bo.notes?.length) {
    notes += `<text x="0" y="${(tbl.h + 600 + lg.h + 600).toFixed(0)}" font-size="240" font-weight="600" fill="#222">標準外・検討する項目（間取りから）</text>`;
    bo.notes.slice(0, 10).forEach((n, i) => (notes += `<text x="0" y="${(tbl.h + 600 + lg.h + 600 + 380 * (i + 1)).toFixed(0)}" font-size="210" fill="#333">・${esc(n)}</text>`));
  }
  const right = { svg: tbl.svg + lg.svg + notes, w: tbl.w, h: tbl.h + 600 + lg.h + (bo.notes?.length ? 600 + 380 * Math.min(10, bo.notes.length) + 200 : 0) };
  const title = '数量の根拠（床仕上げ・建具）';
  return { id: 'interior', title, svg: composeSheet(panels, { ...info, drawing: title }, { right, defs, gap: 2400 }) };
}

/** 数量の根拠シート一式（床面積・外壁・屋根・内部） */
export function basisSheets(model: BuildingModel, opts: TakeoffOptions, info: SheetInfo, bo: BasisOptions = {}): BasisSheet[] {
  const out: BasisSheet[] = [];
  const builders: ((m: BuildingModel, o: TakeoffOptions, i: SheetInfo, b: BasisOptions) => BasisSheet)[] = [areaSheet, wallSheet, roofSheet, interiorSheet];
  let no = 1;
  for (const b of builders) {
    try {
      out.push(b(model, opts, { ...info, no: `Q-${no++}` }, bo));
    } catch (e) {
      console.error(e);
    }
  }
  return out;
}

/** 面積・数量の項目 → どの根拠シートを見ればよいか（画面の「根拠を見る」のリンク先） */
export function basisSheetFor(key: keyof Areas): BasisSheetId | null {
  if (['floor1', 'floor2', 'floor3', 'porchOut', 'extraArea', 'garageArea', 'balconyArea', 'voidArea', 'loftArea', 'buildArea', 'porchIn'].includes(key)) return 'area';
  if (['extWall', 'foundPerim', 'corners', 'insulWall', 'solidoArea', 'solidoCorners'].includes(key)) return 'wall';
  if (['roofArea', 'soffitArea', 'eaveLen', 'ridgeLen', 'insulArea', 'downspouts1', 'downspouts2'].includes(key)) return 'roof';
  if (['doors', 'flooringArea', 'floorTileArea', 'toilets', 'stairs', 'tatami1', 'tatamiHalf'].includes(key)) return 'interior';
  return null;
}
