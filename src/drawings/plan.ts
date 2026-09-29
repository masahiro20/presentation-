/**
 * プレゼン用の清書平面図（SVG）
 * 部屋を色分けし、壁・建具・室名・帖数・寸法・方位を描く。
 */
import type { BuildingModel, Floor, RoomType } from '../core/types';
import { polygonCentroid } from '../core/geometry';

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

export interface PlanSvgOptions {
  showDims?: boolean;
  showFurnitureHint?: boolean;
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
  // 部屋
  for (const r of f.rooms) {
    const fill = opts.roomTint?.[r.id] ?? ROOM_COLORS[r.type] ?? '#f1efea';
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
  // 接道（1階のみ）: 道路側に帯と幅員を表示
  if (model.site?.roads.length && model.floors[0] === f && opts.showRoad !== false) {
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" font-family="'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif"><rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="#fff"/>${s}</svg>`;
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
