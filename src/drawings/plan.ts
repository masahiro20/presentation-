/**
 * プレゼン用の清書平面図（SVG）
 * 部屋を色分けし、壁・建具・室名・帖数・寸法・方位を描く。
 */
import type { BuildingModel, Floor, RoomType } from '../core/types';
import { stairLayout, stairStepCount } from '../core/stairs';
import { polygonCentroid } from '../core/geometry';
import { planFurniture, type PlanItem } from '../scene/furniture';
import { buildBuilding } from '../scene/building';
import { buildLandscape, type LandscapePlan } from '../scene/landscape';
import { EXTERIOR_STYLES } from '../styles/presets';
import { wrapSheet, svgTable, type SheetInfo } from './sheet';

/** 外構（3D と同じ配置: 駐車場・アプローチ・植栽） */
const landscapeCache = new WeakMap<BuildingModel, LandscapePlan | null>();
function landscapeOf(model: BuildingModel): LandscapePlan | null {
  if (landscapeCache.has(model)) return landscapeCache.get(model)!;
  let lp: LandscapePlan | null = null;
  try {
    const ext = EXTERIOR_STYLES[0];
    const { meta } = buildBuilding(model, { exterior: ext });
    lp = buildLandscape(meta, ext, model.site).plan;
  } catch {
    lp = null;
  }
  landscapeCache.set(model, lp);
  return lp;
}

/** 樹木: ゆらぎのある輪郭の樹冠 */
function treeSvg(x: number, y: number, r: number, seed: number): string {
  const n = 28;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + 0.07 * Math.sin(a * 7 + seed) + 0.04 * Math.sin(a * 13 + seed * 2.3);
    pts.push(`${(x + Math.cos(a) * r * k).toFixed(0)},${(y + Math.sin(a) * r * k).toFixed(0)}`);
  }
  return (
    `<polygon points="${pts.join(' ')}" fill="#d3dfc4" fill-opacity="0.82" stroke="#8ea47c" stroke-width="12"/>` +
    `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(r * 0.55).toFixed(0)}" fill="none" stroke="#a9bb98" stroke-width="7" stroke-dasharray="50 40"/>` +
    `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="45" fill="#8ea47c"/>`
  );
}

/** 車（平面図の記号） */
function carSvg(x: number, y: number, dx: number, dy: number): string {
  const L = 4600;
  const W = 1760;
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  return (
    `<g transform="translate(${x.toFixed(0)} ${y.toFixed(0)}) rotate(${ang.toFixed(1)})">` +
    `<rect x="${-L / 2}" y="${-W / 2}" width="${L}" height="${W}" rx="420" fill="#fff" stroke="#9a958e" stroke-width="12"/>` +
    `<rect x="${-L * 0.18}" y="${-W / 2 + 160}" width="${L * 0.42}" height="${W - 320}" rx="200" fill="none" stroke="#b5b0a8" stroke-width="10"/>` +
    `<line x1="${L * 0.24}" y1="${-W / 2 + 180}" x2="${L * 0.24}" y2="${W / 2 - 180}" stroke="#b5b0a8" stroke-width="10"/>` +
    `</g>`
  );
}

/** 家具の外形（モデルごとに1回だけ計算） */
const furnitureCache = new WeakMap<BuildingModel, Map<number, PlanItem[]>>();
function furnitureOf(model: BuildingModel, level: number): PlanItem[] {
  let m = furnitureCache.get(model);
  if (!m) {
    try {
      m = planFurniture(model);
    } catch {
      m = new Map();
    }
    furnitureCache.set(model, m);
  }
  return m.get(level) ?? [];
}

/** 家具を平面図の線で描く（高さの低いものから順に重ねる） */
function furnitureSvg(items: PlanItem[]): string {
  let s = '';
  const sorted = items.slice().sort((a, b) => a.top - b.top);
  for (const it of sorted) {
    const rug = it.key === 'f.rug';
    const fill = rug ? 'none' : it.key === 'f.bedding' || it.key.startsWith('f.fabric') ? '#fdfcfa' : it.key === 'f.counter' || it.key === 'f.cabinet' ? '#f4f1ec' : '#faf8f4';
    const stroke = rug ? '#bdb5aa' : '#76716a';
    const dash = rug ? ' stroke-dasharray="60 40"' : '';
    if (it.shape === 'circle') {
      s += `<circle cx="${(it.cx * 1000).toFixed(0)}" cy="${(it.cz * 1000).toFixed(0)}" r="${(it.r * 1000).toFixed(0)}" fill="${fill}" stroke="${stroke}" stroke-width="9"${dash}/>`;
      continue;
    }
    const ax = it.ax;
    const az = it.az;
    const bx = -az;
    const bz = ax;
    const hw = (it.w * 1000) / 2;
    const hd = (it.d * 1000) / 2;
    const cx = it.cx * 1000;
    const cz = it.cz * 1000;
    const p = (sa: number, sb: number) => `${(cx + ax * hw * sa + bx * hd * sb).toFixed(0)},${(cz + az * hw * sa + bz * hd * sb).toFixed(0)}`;
    s += `<polygon points="${p(-1, -1)} ${p(1, -1)} ${p(1, 1)} ${p(-1, 1)}" fill="${fill}" stroke="${stroke}" stroke-width="9" stroke-linejoin="round"${dash}/>`;
  }
  return s;
}

const ROOM_COLORS: Partial<Record<RoomType, string>> = {
  ldk: '#f6e7cf',
  living: '#f6e7cf',
  dining: '#f6e7cf',
  kitchen: '#f3e1c4',
  japanese: '#e3e8c8',
  bedroom: '#e3ecf5',
  kids: '#f3e3ea',
  study: '#ece6f3',
  bath: '#dcecf1',
  washroom: '#dcecf1',
  toilet: '#dcecf1',
  entrance: '#e9e6e0',
  hall: '#f1efea',
  stairs: '#efece6',
  closet: '#ece8df',
  storage: '#ece8df',
  balcony: '#e4e4e4',
  porch: '#e4e4e4',
  garage: '#e4e4e4',
  void: '#ffffff',
  other: '#f1efea',
};

/** 床の仕上げ（素材の表現）: 用途ごと */
type FloorFinish = 'wood' | 'tatami' | 'tile' | 'stone' | 'deck' | 'concrete' | 'none';
const FINISH: Partial<Record<RoomType, FloorFinish>> = {
  ldk: 'wood', living: 'wood', dining: 'wood', kitchen: 'wood', bedroom: 'wood', kids: 'wood', study: 'wood', hall: 'wood',
  closet: 'wood', storage: 'wood', other: 'wood', stairs: 'wood',
  japanese: 'tatami',
  bath: 'tile', washroom: 'tile', toilet: 'tile',
  entrance: 'stone', porch: 'stone',
  balcony: 'deck',
  garage: 'concrete',
  void: 'none',
};
const FINISH_FILL: Record<FloorFinish, string> = {
  wood: '#f1e8da',
  tatami: '#e6e7cb',
  tile: '#eceeef',
  stone: '#e3e0da',
  deck: '#e6ddcf',
  concrete: '#e8e7e4',
  none: '#ffffff',
};
/** 目地・板目のパターン（mm 単位。複数の図を1ページに並べても同じ定義なので ID は共通） */
const PLAN_DEFS =
  '<defs>' +
  '<pattern id="mp-wood-h" patternUnits="userSpaceOnUse" width="1820" height="150"><rect width="1820" height="150" fill="#f1e8da"/><line x1="0" y1="0" x2="1820" y2="0" stroke="#e1d3bf" stroke-width="7"/><line x1="0" y1="0" x2="0" y2="150" stroke="#e6dac8" stroke-width="5"/></pattern>' +
  '<pattern id="mp-wood-v" patternUnits="userSpaceOnUse" width="150" height="1820"><rect width="150" height="1820" fill="#f1e8da"/><line x1="0" y1="0" x2="0" y2="1820" stroke="#e1d3bf" stroke-width="7"/><line x1="0" y1="0" x2="150" y2="0" stroke="#e6dac8" stroke-width="5"/></pattern>' +
  '<pattern id="mp-tile" patternUnits="userSpaceOnUse" width="300" height="300"><rect width="300" height="300" fill="#eceeef"/><path d="M0 0H300M0 0V300" stroke="#dcdfe1" stroke-width="6" fill="none"/></pattern>' +
  '<pattern id="mp-stone" patternUnits="userSpaceOnUse" width="600" height="600"><rect width="600" height="600" fill="#e3e0da"/><path d="M0 0H600M0 0V600" stroke="#d2cec6" stroke-width="7" fill="none"/></pattern>' +
  '<pattern id="mp-deck" patternUnits="userSpaceOnUse" width="1000" height="120"><rect width="1000" height="120" fill="#e6ddcf"/><line x1="0" y1="0" x2="1000" y2="0" stroke="#d3c6b2" stroke-width="10"/></pattern>' +
  '</defs>';

export interface PlanSvgOptions {
  showDims?: boolean;
  showFurnitureHint?: boolean;
  /** 外構（駐車場・植栽）を描く（1階のみ。既定: 描く） */
  showLandscape?: boolean;
  /** 用途別の色分け（既定: 素材の表現） */
  colorCoded?: boolean;
  /** 家具（3D と同じ自動配置）を描く（既定: 描く） */
  showFurniture?: boolean;
  highlightRoomId?: string;
  /** 日照時間などのオーバーレイ（部屋ID → 色） */
  roomTint?: Record<string, string>;
  title?: string;
  /** 接道の表示（既定: 表示） */
  showRoad?: boolean;
  /** 図枠（A3・表題欄・面積表・建具表）に入れる。省略時は図枠なし */
  sheet?: SheetInfo;
  /** 建具記号（W1・D1…）を描く（既定: 図枠ありのとき） */
  tags?: boolean;
  /** 断面図の切断線（ワールド m: 法線 (nx, nz)、d = 面上の点·n）。矢印は見る向き（−n） */
  sectionLines?: { nx: number; nz: number; d: number; label: string }[];
}

export interface OpeningScheduleEntry {
  id: string;
  tag: string;
  kindJa: string;
  w: number;
  h: number;
  sill: number;
  /** 記号を置く位置（図面 mm。外壁は外側、内壁は +法線側） */
  x: number;
  y: number;
}

const OPENING_KIND_JA: Record<string, string> = { window: '窓', door: '片開き戸', sliding: '引戸', entrance: '玄関戸', open: '開口' };

/** 建具表: 窓は W1…、戸は D1…、開口は O1… の順に番号を付ける */
export function openingSchedule(f: Floor): OpeningScheduleEntry[] {
  const out: OpeningScheduleEntry[] = [];
  const counters: Record<string, number> = { W: 0, D: 0, O: 0 };
  const walls = f.walls.slice().sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  for (const w of walls) {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (L < 1) continue;
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    const nx = -uy;
    const ny = ux;
    const sgn = w.exterior ? (w.outsideSign ?? 1) : 1;
    const ops = f.openings.filter((o) => o.wallId === w.id).sort((a, b) => a.t0 - b.t0);
    for (const o of ops) {
      const pre = o.kind === 'window' ? 'W' : o.kind === 'open' ? 'O' : 'D';
      counters[pre]++;
      const tm = (o.t0 + o.t1) / 2;
      const off = w.thickness / 2 + 420;
      out.push({
        id: o.id,
        tag: `${pre}${counters[pre]}`,
        kindJa: o.windowStyle === 'hakidashi' ? '掃出し窓' : o.windowStyle === 'koshi' ? '腰窓' : o.windowStyle === 'high' ? '高窓' : o.windowStyle === 'small' ? '小窓' : OPENING_KIND_JA[o.kind] ?? o.kind,
        w: Math.round(o.t1 - o.t0),
        h: Math.round(o.height),
        sill: Math.round(o.sill),
        x: w.a.x + ux * tm + nx * off * sgn,
        y: w.a.y + uy * tm + ny * off * sgn,
      });
    }
  }
  return out;
}

/** 階の床面積（㎡）: 吹抜・バルコニー・ポーチ・車庫を除く */
export function floorArea(f: Floor): number {
  return f.rooms.filter((r) => r.type !== 'void' && r.type !== 'balcony' && r.type !== 'porch' && r.type !== 'garage').reduce((a, r) => a + r.area, 0);
}

/** 外形の面積（㎡。穴は引く） */
function outlineArea(f: Floor): number {
  const area = (loop: { x: number; y: number }[]) => {
    let a = 0;
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i];
      const q = loop[(i + 1) % loop.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  };
  const vals = f.outline.map(area);
  const outer = Math.max(...vals.map((v) => Math.abs(v)), 0);
  // 最大のループを外周、他は穴とみなす
  let total = outer;
  for (const v of vals) if (Math.abs(v) !== outer) total -= Math.abs(v);
  return total / 1e6;
}

/** 面積表（階別床面積・延床・建築面積・敷地面積・建蔽率・容積率） */
export function areaTableSvg(model: BuildingModel, x: number, y: number) {
  const rows: string[][] = [];
  let total = 0;
  for (const f of model.floors) {
    const a = floorArea(f);
    total += a;
    rows.push([`${f.level}階 床面積`, `${a.toFixed(2)} ㎡`, `${(a / 3.30579).toFixed(2)} 坪`]);
  }
  rows.push(['延床面積', `${total.toFixed(2)} ㎡`, `${(total / 3.30579).toFixed(2)} 坪`]);
  const bld = Math.max(...model.floors.map(outlineArea), 0);
  rows.push(['建築面積', `${bld.toFixed(2)} ㎡`, `${(bld / 3.30579).toFixed(2)} 坪`]);
  const site = model.site?.areaM2;
  if (site) {
    rows.push(['敷地面積', `${site.toFixed(2)} ㎡`, `${(site / 3.30579).toFixed(2)} 坪`]);
    rows.push(['建蔽率', `${((bld / site) * 100).toFixed(1)} %`, '']);
    rows.push(['容積率', `${((total / site) * 100).toFixed(1)} %`, '']);
  }
  return svgTable(x, y, '面積表', [{ label: '項目', w: 2600 }, { label: '㎡', w: 2200, align: 'right' }, { label: '坪', w: 2000, align: 'right' }], rows);
}

/** 建具表（この階） */
export function openingTableSvg(f: Floor, x: number, y: number, maxRows = 22) {
  const sch = openingSchedule(f);
  const rows = sch.slice(0, maxRows).map((e) => [e.tag, e.kindJa, `${e.w}`, `${e.h}`, e.sill ? `${e.sill}` : '-']);
  if (sch.length > maxRows) rows.push([`ほか ${sch.length - maxRows}`, '', '', '', '']);
  return svgTable(x, y, `建具表（${f.level}階）`, [{ label: '記号', w: 1100, align: 'center' }, { label: '種別', w: 2300 }, { label: 'W', w: 1100, align: 'right' }, { label: 'H', w: 1100, align: 'right' }, { label: '腰高', w: 1200, align: 'right' }], rows, { fontSize: 150, rowH: 260 });
}

export interface PlanParts {
  inner: string;
  vb: { x: number; y: number; w: number; h: number };
  defs: string;
}

export function floorPlanSvg(model: BuildingModel, f: Floor, opts: PlanSvgOptions = {}): string {
  const parts = floorPlanParts(model, f, opts);
  if (opts.sheet) {
    const at = areaTableSvg(model, 0, 0);
    const ot = openingTableSvg(f, 0, at.h + 700);
    const right = { svg: at.svg + ot.svg, w: Math.max(at.w, ot.w), h: at.h + 700 + ot.h };
    return wrapSheet(parts.inner, parts.vb, opts.sheet, { right, defs: parts.defs });
  }
  const vb = parts.vb;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" font-family="'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif">${parts.defs}<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="#fff"/>${parts.inner}</svg>`;
}

/** 平面図の中身（図枠に流し込む用）。図枠に入れる時は外構・道路を描かない（図面としての密度を優先） */
export function floorPlanParts(model: BuildingModel, f: Floor, opts: PlanSvgOptions = {}): PlanParts {
  if (opts.sheet) opts = { showLandscape: false, showRoad: false, ...opts };
  const pts = f.outline.flat().concat(f.walls.flatMap((w) => [w.a, w.b]));
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const pad = 1800;
  const vb = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 + 900 };
  let s = '';
  const land = f.level === 1 && opts.showLandscape !== false ? landscapeOf(model) : null;
  // 外構の舗装（駐車場・アプローチ）と車
  if (land) {
    for (const pv of land.paving) {
      const pts = pv.pts.map((q) => `${(q.x * 1000).toFixed(0)},${(q.z * 1000).toFixed(0)}`).join(' ');
      s += pv.key === 'l.approach' ? `<polygon points="${pts}" fill="url(#mp-stone)" stroke="#c9c4bc" stroke-width="10"/>` : `<polygon points="${pts}" fill="#ebe9e5" stroke="#cfcbc4" stroke-width="10"/>`;
    }
    for (const c of land.cars) s += carSvg(c.x * 1000, c.z * 1000, c.dirX, c.dirZ);
  }
  // 部屋
  for (const r of f.rooms) {
    const fin = FINISH[r.type] ?? 'wood';
    const xs0 = r.polygon.map((p) => p.x);
    const ys0 = r.polygon.map((p) => p.y);
    const wide = Math.max(...xs0) - Math.min(...xs0) >= Math.max(...ys0) - Math.min(...ys0);
    const pat = fin === 'wood' ? `url(#mp-wood-${wide ? 'h' : 'v'})` : fin === 'tile' ? 'url(#mp-tile)' : fin === 'stone' ? 'url(#mp-stone)' : fin === 'deck' ? 'url(#mp-deck)' : FINISH_FILL[fin];
    const fill = opts.roomTint?.[r.id] ?? (opts.colorCoded ? ROOM_COLORS[r.type] ?? '#f1efea' : pat);
    const stroke = opts.highlightRoomId === r.id ? '#d9822b' : 'none';
    s += `<polygon points="${r.polygon.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="${stroke === 'none' ? 0 : 60}"/>`;
    if (r.type === 'japanese') {
      // 畳割り（簡易）
      const xs = r.polygon.map((p) => p.x);
      const ys = r.polygon.map((p) => p.y);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      for (let x = x0 + 910; x < x1 - 100; x += 910) s += `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" stroke="#b9bf96" stroke-width="12"/>`;
      for (let y = y0 + 1820; y < y1 - 100; y += 1820) s += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="#b9bf96" stroke-width="12"/>`;
    }
  }
  // 家具
  if (opts.showFurniture !== false) s += furnitureSvg(furnitureOf(model, f.level));
  // 階段
  for (const st of f.stairs) {
    const lay = stairLayout(st, stairStepCount(f.height || 2900, st));
    s += `<rect x="${st.minX}" y="${st.minY}" width="${st.maxX - st.minX}" height="${st.maxY - st.minY}" fill="#f7f5f0" stroke="#999" stroke-width="10"/>`;
    for (const p of lay.pieces) s += `<rect x="${p.minX.toFixed(0)}" y="${p.minY.toFixed(0)}" width="${(p.maxX - p.minX).toFixed(0)}" height="${(p.maxY - p.minY).toFixed(0)}" fill="none" stroke="#aaa" stroke-width="8"/>`;
    // 昇る向きの矢印（段の中心をつなぐ）
    const cs = lay.pieces.map((p) => `${((p.minX + p.maxX) / 2).toFixed(0)},${((p.minY + p.maxY) / 2).toFixed(0)}`);
    if (cs.length > 1) s += `<polyline points="${cs.join(' ')}" fill="none" stroke="#888" stroke-width="12"/>`;
    const last = lay.pieces[lay.pieces.length - 1];
    if (last) {
      const cx = (last.minX + last.maxX) / 2;
      const cy = (last.minY + last.maxY) / 2;
      const d = last.dir;
      const tip = { x: cx + d.x * 160, y: cy + d.y * 160 };
      s += `<polygon points="${tip.x.toFixed(0)},${tip.y.toFixed(0)} ${(cx - d.y * 90).toFixed(0)},${(cy + d.x * 90).toFixed(0)} ${(cx + d.y * 90).toFixed(0)},${(cy - d.x * 90).toFixed(0)}" fill="#888"/>`;
    }
    const first = lay.pieces[0];
    if (first) s += `<text x="${((first.minX + first.maxX) / 2).toFixed(0)}" y="${((first.minY + first.maxY) / 2 + 60).toFixed(0)}" font-size="160" text-anchor="middle" fill="#777">${st.goesUp ? 'UP' : 'DN'}</text>`;
  }
  // 壁（開口部を抜いて描く）
  for (const w of f.walls) {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (L < 1) continue;
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    const nx = -uy;
    const ny = ux;
    const ops = f.openings.filter((o) => o.wallId === w.id).sort((a, b) => a.t0 - b.t0);
    const solid: [number, number][] = [];
    let cur = 0;
    for (const o of ops) {
      if (o.t0 > cur) solid.push([cur, o.t0]);
      cur = Math.max(cur, o.t1);
    }
    if (cur < L) solid.push([cur, L]);
    const h = w.thickness / 2;
    for (const [t0, t1] of solid) {
      const p = (t: number, sgn: number) => `${(w.a.x + ux * t + nx * h * sgn).toFixed(0)},${(w.a.y + uy * t + ny * h * sgn).toFixed(0)}`;
      s += `<polygon points="${p(t0, 1)} ${p(t1, 1)} ${p(t1, -1)} ${p(t0, -1)}" fill="#2b2b2b"/>`;
    }
    // 建具（設計図の表記: 窓 = 枠の2線＋ガラス、開き戸 = 扉と軌跡、引戸 = 2枚の戸を少しずらして）
    for (const o of ops) {
      const a = { x: w.a.x + ux * o.t0, y: w.a.y + uy * o.t0 };
      const b = { x: w.a.x + ux * o.t1, y: w.a.y + uy * o.t1 };
      const len = o.t1 - o.t0;
      const P = (t: number, off: number) => ({ x: a.x + ux * t + nx * off, y: a.y + uy * t + ny * off });
      const leaf = (t0: number, t1: number, off: number, th: number) => {
        const q = [P(t0, off - th / 2), P(t1, off - th / 2), P(t1, off + th / 2), P(t0, off + th / 2)];
        return `<polygon points="${q.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ')}" fill="#fff" stroke="#333" stroke-width="9"/>`;
      };
      if (o.kind === 'window') {
        // 枠（壁の内外面）とガラス
        for (const k of [-1, 1]) {
          const p0 = P(0, h * k);
          const p1 = P(len, h * k);
          s += `<line x1="${p0.x}" y1="${p0.y}" x2="${p1.x}" y2="${p1.y}" stroke="#333" stroke-width="9"/>`;
        }
        const g0 = P(0, 0);
        const g1 = P(len, 0);
        s += `<line x1="${g0.x}" y1="${g0.y}" x2="${g1.x}" y2="${g1.y}" stroke="#5f8fb0" stroke-width="16"/>`;
        for (const t of [0, len]) {
          const e0 = P(t, -h);
          const e1 = P(t, h);
          s += `<line x1="${e0.x}" y1="${e0.y}" x2="${e1.x}" y2="${e1.y}" stroke="#333" stroke-width="9"/>`;
        }
      } else if (o.kind === 'door' || o.kind === 'entrance') {
        const hingeAtStart = o.hingeAtStart !== false;
        const hinge = hingeAtStart ? a : b;
        const strike = hingeAtStart ? b : a;
        const side = o.swingSide ?? 1;
        const tip = { x: hinge.x + nx * len * side, y: hinge.y + ny * len * side };
        s += `<line x1="${hinge.x}" y1="${hinge.y}" x2="${tip.x}" y2="${tip.y}" stroke="#333" stroke-width="${o.kind === 'entrance' ? 40 : 30}" stroke-linecap="butt"/>`;
        const sweep = cross(strike.x - hinge.x, strike.y - hinge.y, tip.x - hinge.x, tip.y - hinge.y) > 0 ? 1 : 0;
        s += `<path d="M${tip.x} ${tip.y} A${len} ${len} 0 0 ${sweep} ${strike.x} ${strike.y}" fill="none" stroke="#777" stroke-width="7"/>`;
      } else if (o.kind === 'sliding') {
        // 引違い（幅 1.2m 以上）は2枚、狭いものは片引きの1枚
        const th = 32;
        const off = Math.min(h * 0.55, 30);
        if (len >= 1200) {
          s += leaf(0, len * 0.53, -off, th);
          s += leaf(len * 0.47, len, off, th);
        } else {
          s += leaf(0, len, off, th);
        }
      }
    }
  }
  // 植栽
  if (land) {
    land.shrubs.forEach((t, i) => (s += `<circle cx="${(t.x * 1000).toFixed(0)}" cy="${(t.z * 1000).toFixed(0)}" r="${(t.r * 1000).toFixed(0)}" fill="#c9d8b8" fill-opacity="0.85" stroke="#93a982" stroke-width="10"/>` + (i < 0 ? '' : '')));
    land.trees.forEach((t, i) => (s += treeSvg(t.x * 1000, t.z * 1000, t.r * 1000, i * 1.7 + 0.4)));
  }
  // 室名（全角英数字は半角に。部屋に収まる大きさで、家具に重なっても読めるよう白い縁取り）
  for (const r of f.rooms) {
    if (r.type === 'stairs') continue;
    const name = r.name.normalize('NFKC');
    const c = r.labelPos ?? polygonCentroid(r.polygon);
    const xs = r.polygon.map((p) => p.x);
    const ys = r.polygon.map((p) => p.y);
    const rw = Math.max(...xs) - Math.min(...xs);
    const rh = Math.max(...ys) - Math.min(...ys);
    const big = r.area > 4;
    const fs = Math.max(120, Math.min(big ? 230 : 180, (rw * 0.86) / textEm(name), rh * 0.3));
    const tatami = r.labeledTatami ?? r.area / 1.62;
    const halo = `stroke="#fff" stroke-width="${Math.round(fs * 0.22)}" stroke-linejoin="round" paint-order="stroke"`;
    s += `<text x="${c.x}" y="${c.y - (big ? 30 : -fs * 0.35)}" font-size="${fs.toFixed(0)}" text-anchor="middle" fill="#2a2a2a" font-weight="500" letter-spacing="${(fs * 0.06).toFixed(0)}" ${halo}>${esc(name)}</text>`;
    if (big) s += `<text x="${c.x}" y="${c.y + fs * 0.95}" font-size="${(fs * 0.68).toFixed(0)}" text-anchor="middle" fill="#7a7a7a" ${halo}>${tatami.toFixed(1)}帖</text>`;
  }
  // 寸法（外壁の通り芯ごとの寸法と全体寸法。道路・敷地境界と重なりにくい側に）
  let dimsBelow = false;
  if (opts.showDims !== false) {
    const op = f.outline.flat();
    const src = op.length ? op : pts;
    const ox0 = Math.min(...src.map((p) => p.x));
    const ox1 = Math.max(...src.map((p) => p.x));
    const oy0 = Math.min(...src.map((p) => p.y));
    const oy1 = Math.max(...src.map((p) => p.y));
    const edges = model.floors[0] === f ? model.site?.edges ?? [] : [];
    // 側ごとの空き（建物の外形から敷地境界・道路までの距離）
    const clearance = (side: 'top' | 'bottom' | 'left' | 'right') => {
      let best = Infinity;
      for (const e of edges)
        for (let i = 0; i <= 20; i++) {
          const x = e.a.x + ((e.b.x - e.a.x) * i) / 20;
          const y = e.a.y + ((e.b.y - e.a.y) * i) / 20;
          if (side === 'top' && x > ox0 && x < ox1 && y < oy0) best = Math.min(best, oy0 - y);
          if (side === 'bottom' && x > ox0 && x < ox1 && y > oy1) best = Math.min(best, y - oy1);
          if (side === 'left' && y > oy0 && y < oy1 && x < ox0) best = Math.min(best, ox0 - x);
          if (side === 'right' && y > oy0 && y < oy1 && x > ox1) best = Math.min(best, x - ox1);
        }
      return best;
    };
    const hSide = clearance('top') >= Math.min(1600, clearance('bottom')) ? 'top' : 'bottom';
    dimsBelow = hSide === 'bottom';
    const vSide = clearance('left') >= Math.min(1600, clearance('right')) ? 'left' : 'right';
    const uniq = (v: number[]) => {
      const out: number[] = [];
      for (const x of [...v].sort((p, q) => p - q)) if (!out.length || x - out[out.length - 1] > 150) out.push(x);
      return out;
    };
    const xsC = uniq(src.map((p) => p.x));
    const ysC = uniq(src.map((p) => p.y));
    const hy = (k: number) => (hSide === 'top' ? oy0 - 600 - k * 500 : oy1 + 600 + k * 500);
    const vx = (k: number) => (vSide === 'left' ? ox0 - 600 - k * 500 : ox1 + 600 + k * 500);
    if (xsC.length > 2) for (let i = 0; i + 1 < xsC.length; i++) s += dimLine(xsC[i], hy(0), xsC[i + 1], hy(0), `${Math.round(xsC[i + 1] - xsC[i])}`, false, hSide === 'bottom');
    s += dimLine(ox0, hy(xsC.length > 2 ? 1 : 0), ox1, hy(xsC.length > 2 ? 1 : 0), `${Math.round(ox1 - ox0)}`, false, hSide === 'bottom');
    if (ysC.length > 2) for (let i = 0; i + 1 < ysC.length; i++) s += dimLine(vx(0), ysC[i], vx(0), ysC[i + 1], `${Math.round(ysC[i + 1] - ysC[i])}`, true, vSide === 'right');
    s += dimLine(vx(ysC.length > 2 ? 1 : 0), oy0, vx(ysC.length > 2 ? 1 : 0), oy1, `${Math.round(oy1 - oy0)}`, true, vSide === 'right');
    // 引出線（外形の角から寸法線まで）
    for (const x of xsC) s += `<line x1="${x}" y1="${hSide === 'top' ? oy0 - 150 : oy1 + 150}" x2="${x}" y2="${hy(1) + (hSide === 'top' ? -100 : 100)}" stroke="#999" stroke-width="6"/>`;
    for (const y of ysC) s += `<line x1="${vSide === 'left' ? ox0 - 150 : ox1 + 150}" y1="${y}" x2="${vx(1) + (vSide === 'left' ? -100 : 100)}" y2="${y}" stroke="#999" stroke-width="6"/>`;
  }
  // 敷地境界線（図面の「道路境界線」「隣地境界線」）: 1階のみ
  const siteEdges = model.floors[0] === f && opts.showRoad !== false ? model.site?.edges : undefined;
  if (siteEdges?.length) {
    const c = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    const w0 = model.site!.roads[0]?.widthMm;
    const ext = { minX: vb.x, minY: vb.y, maxX: vb.x + vb.w, maxY: vb.y + vb.h };
    for (const e of siteEdges) {
      const L = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
      if (L < 1) continue;
      const u = { x: (e.b.x - e.a.x) / L, y: (e.b.y - e.a.y) / L };
      let n = { x: -u.y, y: u.x };
      const m = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
      if (n.x * (m.x - c.x) + n.y * (m.y - c.y) < 0) n = { x: -n.x, y: -n.y };
      if (e.kind === 'road') {
        const D = 900;
        const q = [e.a, e.b, { x: e.b.x + n.x * D, y: e.b.y + n.y * D }, { x: e.a.x + n.x * D, y: e.a.y + n.y * D }];
        s += `<polygon points="${q.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ')}" fill="#e4e2de"/>`;
        let deg = (Math.atan2(u.y, u.x) * 180) / Math.PI;
        if (deg > 90) deg -= 180;
        if (deg < -90) deg += 180;
        const tp = { x: m.x + n.x * D * 0.5, y: m.y + n.y * D * 0.5 };
        if (L > 2500) s += `<text x="${tp.x.toFixed(0)}" y="${tp.y.toFixed(0)}" font-size="230" text-anchor="middle" dy="80" fill="#555" transform="rotate(${deg.toFixed(1)} ${tp.x.toFixed(0)} ${tp.y.toFixed(0)})">${esc(`道路${w0 ? `（幅員${(w0 / 1000).toFixed(1)}m）` : ''}`)}</text>`;
        for (const p of q) {
          ext.minX = Math.min(ext.minX, p.x - 300);
          ext.minY = Math.min(ext.minY, p.y - 300);
          ext.maxX = Math.max(ext.maxX, p.x + 300);
          ext.maxY = Math.max(ext.maxY, p.y + 300);
        }
      }
      s += `<line x1="${e.a.x.toFixed(0)}" y1="${e.a.y.toFixed(0)}" x2="${e.b.x.toFixed(0)}" y2="${e.b.y.toFixed(0)}" stroke="${e.kind === 'road' ? '#555' : '#888'}" stroke-width="${e.kind === 'road' ? 24 : 14}" stroke-dasharray="200 60 30 60"/>`;
      for (const p of [e.a, e.b]) {
        ext.minX = Math.min(ext.minX, p.x - 300);
        ext.minY = Math.min(ext.minY, p.y - 300);
        ext.maxX = Math.max(ext.maxX, p.x + 300);
        ext.maxY = Math.max(ext.maxY, p.y + 300);
      }
    }
    vb.x = ext.minX;
    vb.y = ext.minY;
    vb.w = ext.maxX - ext.minX;
    vb.h = ext.maxY - ext.minY + 1900;
  }
  // 接道（1階のみ）: 道路側に帯と幅員を表示
  if (!siteEdges?.length && model.site?.roads.length && model.floors[0] === f && opts.showRoad !== false) {
    for (const r of model.site.roads) {
      const bnd = model.site.bounds[r.side];
      const label = `道路${r.widthMm ? `（幅員${(r.widthMm / 1000).toFixed(1)}m）` : ''}`;
      const depth = 700;
      const horiz = r.side === 'top' || r.side === 'bottom';
      const edge = r.side === 'top' ? minY : r.side === 'bottom' ? maxY : r.side === 'left' ? minX : maxX;
      const sign = r.side === 'top' || r.side === 'left' ? -1 : 1;
      // 寸法線・方位記号・図面名と重ならない位置。敷地境界が分かればその位置（6m まで）
      const gap = Math.min(6000, Math.max(r.side === 'bottom' ? 2100 : 1500, bnd != null ? (bnd - edge) * sign : 0));
      const p0 = edge + sign * gap;
      const p1 = p0 + sign * depth;
      const [a0, a1] = horiz ? [minX - 600, maxX + 600] : [minY - 600, maxY + 600];
      if (horiz) {
        s += `<rect x="${a0}" y="${Math.min(p0, p1)}" width="${a1 - a0}" height="${depth}" fill="#e4e2de"/>`;
        s += `<line x1="${a0}" y1="${p0}" x2="${a1}" y2="${p0}" stroke="#777" stroke-width="14" stroke-dasharray="200 60 30 60"/>`;
        s += `<text x="${(a0 + a1) / 2}" y="${(p0 + p1) / 2 + 80}" font-size="230" text-anchor="middle" fill="#555">${esc(label)}</text>`;
      } else {
        s += `<rect x="${Math.min(p0, p1)}" y="${a0}" width="${depth}" height="${a1 - a0}" fill="#e4e2de"/>`;
        s += `<line x1="${p0}" y1="${a0}" x2="${p0}" y2="${a1}" stroke="#777" stroke-width="14" stroke-dasharray="200 60 30 60"/>`;
        const cx = (p0 + p1) / 2;
        const cy = (a0 + a1) / 2;
        s += `<text x="${cx}" y="${cy}" font-size="230" text-anchor="middle" fill="#555" transform="rotate(${sign > 0 ? 90 : -90} ${cx} ${cy})" dy="80">${esc(label)}</text>`;
      }
      // 表示範囲を広げる
      const far = Math.max(p0, p1) + 300;
      const near = Math.min(p0, p1) - 300;
      if (r.side === 'right') vb.w = Math.max(vb.w, far - vb.x);
      if (r.side === 'bottom') vb.h = Math.max(vb.h, far - vb.y);
      if (r.side === 'left' && near < vb.x) {
        vb.w += vb.x - near;
        vb.x = near;
      }
      if (r.side === 'top' && near < vb.y) {
        vb.h += vb.y - near;
        vb.y = near;
      }
    }
  }
  // 方位
  s += northArrow(maxX + 900, minY - 600, model.northAngleDeg);
  const title = opts.title ?? `${f.level}階平面図`;
  // 図面名・床面積・スケール（図面の下。寸法線の下側に置かれた場合はその下）
  const ty = maxY + (dimsBelow ? 2200 : 1500);
  const tx = (minX + maxX) / 2;
  s += `<text x="${tx}" y="${ty}" font-size="300" text-anchor="middle" fill="#222" font-weight="600" letter-spacing="40">${esc(title)}</text>`;
  const area = f.rooms.reduce((a, r) => a + r.area, 0);
  s += `<text x="${tx}" y="${ty + 380}" font-size="170" text-anchor="middle" fill="#777">床面積（参考）約 ${area.toFixed(1)}㎡（${(area / 3.30579).toFixed(1)}坪）</text>`;
  s += scaleBar(tx - 2500, ty + 620);
  vb.h = Math.max(vb.h, ty + 1100 - vb.y);
  // 建具記号（建具表と対応）
  if (opts.tags ?? !!opts.sheet) {
    for (const e of openingSchedule(f)) {
      s += `<circle cx="${e.x.toFixed(0)}" cy="${e.y.toFixed(0)}" r="200" fill="#fff" stroke="#333" stroke-width="10"/>`;
      s += `<text x="${e.x.toFixed(0)}" y="${(e.y + 55).toFixed(0)}" font-size="150" text-anchor="middle" fill="#222">${esc(e.tag)}</text>`;
    }
  }
  // 断面図の切断線（A-A など）
  if (opts.sectionLines?.length) {
    const bx0 = minX - 700;
    const bx1 = maxX + 700;
    const by0 = minY - 700;
    const by1 = maxY + 700;
    for (const sl of opts.sectionLines) {
      const n = { x: sl.nx, y: sl.nz };
      const d = sl.d * 1000;
      const t = { x: -n.y, y: n.x };
      const p0 = { x: n.x * d, y: n.y * d };
      // 矩形との交点（パラメータ範囲）
      let tMin = -Infinity;
      let tMax = Infinity;
      for (const [c0, c1, pc, tc] of [
        [bx0, bx1, p0.x, t.x],
        [by0, by1, p0.y, t.y],
      ] as const) {
        if (Math.abs(tc) < 1e-9) continue;
        const a = (c0 - pc) / tc;
        const b = (c1 - pc) / tc;
        tMin = Math.max(tMin, Math.min(a, b));
        tMax = Math.min(tMax, Math.max(a, b));
      }
      if (!(tMax > tMin)) continue;
      const A = { x: p0.x + t.x * tMin, y: p0.y + t.y * tMin };
      const B = { x: p0.x + t.x * tMax, y: p0.y + t.y * tMax };
      s += `<line x1="${A.x.toFixed(0)}" y1="${A.y.toFixed(0)}" x2="${B.x.toFixed(0)}" y2="${B.y.toFixed(0)}" stroke="#111" stroke-width="22" stroke-dasharray="500 200 80 200"/>`;
      // 両端に見る向き（−n）の矢印と記号
      for (const E of [A, B]) {
        const ex = E.x - n.x * 450;
        const ey = E.y - n.y * 450;
        s += `<line x1="${E.x.toFixed(0)}" y1="${E.y.toFixed(0)}" x2="${ex.toFixed(0)}" y2="${ey.toFixed(0)}" stroke="#111" stroke-width="30"/>`;
        const hx = ex - n.x * 180;
        const hy = ey - n.y * 180;
        s += `<polygon points="${(ex - n.x * 60 + t.x * 130).toFixed(0)},${(ey - n.y * 60 + t.y * 130).toFixed(0)} ${(ex - n.x * 60 - t.x * 130).toFixed(0)},${(ey - n.y * 60 - t.y * 130).toFixed(0)} ${hx.toFixed(0)},${hy.toFixed(0)}" fill="#111"/>`;
        s += `<text x="${(E.x + t.x * 0 + n.x * 330).toFixed(0)}" y="${(E.y + n.y * 330 + 90).toFixed(0)}" font-size="260" font-weight="700" text-anchor="middle" fill="#111">${esc(sl.label)}</text>`;
      }
    }
  }
  return { inner: s, vb, defs: PLAN_DEFS };
}

function cross(ax: number, ay: number, bx: number, by: number) {
  return ax * by - ay * bx;
}

function esc(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

/** 文字幅の目安（全角 = 1、半角 = 0.6） */
function textEm(t: string): number {
  let w = 0;
  for (const ch of t) w += /[\x20-\x7e｡-ﾟ]/.test(ch) ? 0.6 : 1;
  return Math.max(1, w);
}

function dimLine(x1: number, y1: number, x2: number, y2: number, label: string, vertical: boolean, flip = false) {
  let s = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#555" stroke-width="8"/>`;
  for (const [x, y] of [
    [x1, y1],
    [x2, y2],
  ])
    s += `<line x1="${x - 55}" y1="${y + 55}" x2="${x + 55}" y2="${y - 55}" stroke="#333" stroke-width="14"/>`;
  const L = Math.hypot(x2 - x1, y2 - y1);
  const fs = Math.min(150, Math.max(80, L / 4.2));
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const d = flip ? -70 : 70;
  if (vertical) s += `<text x="${cx - d}" y="${cy}" font-size="${fs.toFixed(0)}" fill="#444" text-anchor="middle" transform="rotate(-90 ${cx - d} ${cy})" dy="${flip ? fs * 0.75 : 0}">${label}</text>`;
  else s += `<text x="${cx}" y="${cy - d}" font-size="${fs.toFixed(0)}" fill="#444" text-anchor="middle" dy="${flip ? fs * 0.75 : 0}">${label}</text>`;
  return s;
}

/** スケールバー（0〜5m） */
function scaleBar(x: number, y: number): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += `<rect x="${x + i * 1000}" y="${y}" width="1000" height="90" fill="${i % 2 ? '#fff' : '#333'}" stroke="#333" stroke-width="10"/>`;
  for (const m of [0, 1, 2, 5]) s += `<text x="${x + m * 1000}" y="${y + 260}" font-size="130" text-anchor="middle" fill="#555">${m}${m === 5 ? 'm' : ''}</text>`;
  return s;
}

export function northArrow(x: number, y: number, angleDeg: number, r = 380) {
  return `<g transform="translate(${x} ${y}) rotate(${angleDeg})"><circle r="${r}" fill="none" stroke="#333" stroke-width="18"/><path d="M0 ${-r * 1.05} L${r * 0.32} ${r * 0.55} L0 ${r * 0.3} L${-r * 0.32} ${r * 0.55} Z" fill="#333"/><text y="${-r * 1.25}" font-size="${r * 0.7}" text-anchor="middle" fill="#333" font-weight="bold">N</text></g>`;
}
