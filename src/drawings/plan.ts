/**
 * プレゼン用の清書平面図（SVG）
 * 部屋を色分けし、壁・建具・室名・帖数・寸法・方位を描く。
 */
import type { BuildingModel, Floor, RoomType } from '../core/types';
import { polygonCentroid } from '../core/geometry';
import { planFurniture, type PlanItem } from '../scene/furniture';
import { buildBuilding } from '../scene/building';
import { buildLandscape, type LandscapePlan } from '../scene/landscape';
import { EXTERIOR_STYLES } from '../styles/presets';

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
}

export function floorPlanSvg(model: BuildingModel, f: Floor, opts: PlanSvgOptions = {}): string {
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
    const n = 10;
    const vertical = st.entry === 'n' || st.entry === 's';
    s += `<rect x="${st.minX}" y="${st.minY}" width="${st.maxX - st.minX}" height="${st.maxY - st.minY}" fill="#f7f5f0" stroke="#999" stroke-width="10"/>`;
    for (let i = 1; i < n; i++) {
      if (vertical) {
        const y = st.minY + ((st.maxY - st.minY) * i) / n;
        s += `<line x1="${st.minX}" y1="${y}" x2="${st.maxX}" y2="${y}" stroke="#aaa" stroke-width="8"/>`;
      } else {
        const x = st.minX + ((st.maxX - st.minX) * i) / n;
        s += `<line x1="${x}" y1="${st.minY}" x2="${x}" y2="${st.maxY}" stroke="#aaa" stroke-width="8"/>`;
      }
    }
    const cx = (st.minX + st.maxX) / 2;
    const cy = (st.minY + st.maxY) / 2;
    s += `<text x="${cx}" y="${cy + 60}" font-size="180" text-anchor="middle" fill="#888">${st.goesUp ? 'UP' : 'DN'}</text>`;
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
    // 建具
    for (const o of ops) {
      const a = { x: w.a.x + ux * o.t0, y: w.a.y + uy * o.t0 };
      const b = { x: w.a.x + ux * o.t1, y: w.a.y + uy * o.t1 };
      const len = o.t1 - o.t0;
      if (o.kind === 'window') {
        for (const k of [-0.5, 0, 0.5]) {
          const off = h * k;
          s += `<line x1="${a.x + nx * off}" y1="${a.y + ny * off}" x2="${b.x + nx * off}" y2="${b.y + ny * off}" stroke="#4a7fa6" stroke-width="${k === 0 ? 22 : 12}"/>`;
        }
      } else if (o.kind === 'door' || o.kind === 'entrance') {
        const hingeAtStart = o.hingeAtStart !== false;
        const hinge = hingeAtStart ? a : b;
        const strike = hingeAtStart ? b : a;
        const side = o.swingSide ?? 1;
        const tip = { x: hinge.x + nx * len * side, y: hinge.y + ny * len * side };
        s += `<line x1="${hinge.x}" y1="${hinge.y}" x2="${tip.x}" y2="${tip.y}" stroke="#555" stroke-width="16"/>`;
        const sweep = cross(strike.x - hinge.x, strike.y - hinge.y, tip.x - hinge.x, tip.y - hinge.y) > 0 ? 1 : 0;
        s += `<path d="M${tip.x} ${tip.y} A${len} ${len} 0 0 ${sweep} ${strike.x} ${strike.y}" fill="none" stroke="#888" stroke-width="10" stroke-dasharray="40 30"/>`;
      } else if (o.kind === 'sliding') {
        for (const [f0, f1, k] of [
          [0, 0.55, -0.25],
          [0.45, 1, 0.25],
        ] as const) {
          const off = h * k;
          s += `<line x1="${a.x + ux * len * f0 + nx * off}" y1="${a.y + uy * len * f0 + ny * off}" x2="${a.x + ux * len * f1 + nx * off}" y2="${a.y + uy * len * f1 + ny * off}" stroke="#555" stroke-width="24"/>`;
        }
      }
    }
  }
  // 植栽
  if (land) {
    land.shrubs.forEach((t, i) => (s += `<circle cx="${(t.x * 1000).toFixed(0)}" cy="${(t.z * 1000).toFixed(0)}" r="${(t.r * 1000).toFixed(0)}" fill="#c9d8b8" fill-opacity="0.85" stroke="#93a982" stroke-width="10"/>` + (i < 0 ? '' : '')));
    land.trees.forEach((t, i) => (s += treeSvg(t.x * 1000, t.z * 1000, t.r * 1000, i * 1.7 + 0.4)));
  }
  // 室名
  for (const r of f.rooms) {
    if (r.type === 'stairs') continue;
    const c = r.labelPos ?? polygonCentroid(r.polygon);
    const big = r.area > 4;
    const tatami = r.labeledTatami ?? r.area / 1.62;
    s += `<text x="${c.x}" y="${c.y - (big ? 40 : -60)}" font-size="${big ? 280 : 200}" text-anchor="middle" fill="#333" font-weight="600">${esc(r.name)}</text>`;
    if (big) s += `<text x="${c.x}" y="${c.y + 260}" font-size="190" text-anchor="middle" fill="#777">${tatami.toFixed(1)}帖</text>`;
  }
  // 寸法（全体）
  if (opts.showDims !== false) {
    const op = f.outline.flat();
    const ox0 = op.length ? Math.min(...op.map((p) => p.x)) : minX;
    const ox1 = op.length ? Math.max(...op.map((p) => p.x)) : maxX;
    const oy0 = op.length ? Math.min(...op.map((p) => p.y)) : minY;
    const oy1 = op.length ? Math.max(...op.map((p) => p.y)) : maxY;
    const y = minY - 900;
    const x = minX - 900;
    s += dimLine(ox0, y, ox1, y, `${Math.round(ox1 - ox0)}`, false);
    s += dimLine(x, oy0, x, oy1, `${Math.round(oy1 - oy0)}`, true);
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
  s += `<text x="${(minX + maxX) / 2}" y="${maxY + 1300}" font-size="360" text-anchor="middle" fill="#222" font-weight="bold">${esc(title)}</text>`;
  const area = f.rooms.reduce((a, r) => a + r.area, 0);
  s += `<text x="${(minX + maxX) / 2}" y="${maxY + 1700}" font-size="210" text-anchor="middle" fill="#777">床面積（参考）約 ${area.toFixed(1)}㎡（${(area / 3.30579).toFixed(1)}坪）</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" font-family="'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif">${PLAN_DEFS}<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="#fff"/>${s}</svg>`;
}

function cross(ax: number, ay: number, bx: number, by: number) {
  return ax * by - ay * bx;
}

function esc(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

function dimLine(x1: number, y1: number, x2: number, y2: number, label: string, vertical: boolean) {
  let s = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#666" stroke-width="12"/>`;
  for (const [x, y] of [
    [x1, y1],
    [x2, y2],
  ])
    s += `<line x1="${x - 70}" y1="${y + 70}" x2="${x + 70}" y2="${y - 70}" stroke="#666" stroke-width="18"/>`;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  if (vertical) s += `<text x="${cx - 110}" y="${cy}" font-size="190" fill="#555" text-anchor="middle" transform="rotate(-90 ${cx - 110} ${cy})">${label}</text>`;
  else s += `<text x="${cx}" y="${cy - 90}" font-size="190" fill="#555" text-anchor="middle">${label}</text>`;
  return s;
}

export function northArrow(x: number, y: number, angleDeg: number, r = 380) {
  return `<g transform="translate(${x} ${y}) rotate(${angleDeg})"><circle r="${r}" fill="none" stroke="#333" stroke-width="18"/><path d="M0 ${-r * 1.05} L${r * 0.32} ${r * 0.55} L0 ${r * 0.3} L${-r * 0.32} ${r * 0.55} Z" fill="#333"/><text y="${-r * 1.25}" font-size="${r * 0.7}" text-anchor="middle" fill="#333" font-weight="bold">N</text></g>`;
}
