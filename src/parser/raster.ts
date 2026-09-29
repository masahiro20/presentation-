/**
 * 部屋領域抽出用のラスタグリッド
 */
import type { Vec2 } from '../core/types';
import { removeCollinear, simplifyClosed, polygonArea } from '../core/geometry';

export const FREE = 0;
export const WALL = 1;
export const OUTSIDE = 2;

export class Grid {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    readonly res: number,
    readonly ox: number,
    readonly oy: number,
  ) {
    this.data = new Uint8Array(w * h);
  }

  static around(minX: number, minY: number, maxX: number, maxY: number, res: number, margin: number) {
    const ox = minX - margin;
    const oy = minY - margin;
    const w = Math.ceil((maxX - minX + margin * 2) / res);
    const h = Math.ceil((maxY - minY + margin * 2) / res);
    return new Grid(w, h, res, ox, oy);
  }

  cellOf(p: Vec2): [number, number] {
    return [Math.floor((p.x - this.ox) / this.res), Math.floor((p.y - this.oy) / this.res)];
  }

  centerOf(x: number, y: number): Vec2 {
    return { x: this.ox + (x + 0.5) * this.res, y: this.oy + (y + 0.5) * this.res };
  }

  get(x: number, y: number) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return OUTSIDE;
    return this.data[y * this.w + x];
  }

  /** 凸多角形/任意多角形をスキャンラインで塗る（セル中心判定） */
  fillPolygon(poly: Vec2[], val: number) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of poly) {
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const y0 = Math.max(0, Math.floor((minY - this.oy) / this.res - 0.5));
    const y1 = Math.min(this.h - 1, Math.ceil((maxY - this.oy) / this.res));
    const xs: number[] = [];
    for (let y = y0; y <= y1; y++) {
      const cy = this.oy + (y + 0.5) * this.res;
      xs.length = 0;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i];
        const b = poly[j];
        if (a.y > cy !== b.y > cy) xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil((xs[k] - this.ox) / this.res - 0.5));
        const xb = Math.min(this.w - 1, Math.floor((xs[k + 1] - this.ox) / this.res - 0.5));
        for (let x = xa; x <= xb; x++) this.data[y * this.w + x] = val;
      }
    }
  }

  /** 太さ d の線分を塗る（少し太らせて隙間を防ぐ） */
  fillThickSegment(a: Vec2, b: Vec2, d: number, val: number) {
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    const hw = Math.max(d / 2, this.res * 0.75);
    const nx = -uy * hw;
    const ny = ux * hw;
    const ex = ux * this.res * 0.5;
    const ey = uy * this.res * 0.5;
    this.fillPolygon(
      [
        { x: a.x - ex + nx, y: a.y - ey + ny },
        { x: b.x + ex + nx, y: b.y + ey + ny },
        { x: b.x + ex - nx, y: b.y + ey - ny },
        { x: a.x - ex - nx, y: a.y - ey - ny },
      ],
      val,
    );
  }

  /** 外周から FREE セルを塗りつぶして OUTSIDE にする */
  floodOutside() {
    const { w, h, data } = this;
    const q = new Int32Array(w * h);
    let head = 0;
    let tail = 0;
    const push = (x: number, y: number) => {
      const i = y * w + x;
      if (data[i] === FREE) {
        data[i] = OUTSIDE;
        q[tail++] = i;
      }
    };
    for (let x = 0; x < w; x++) {
      push(x, 0);
      push(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      push(0, y);
      push(w - 1, y);
    }
    while (head < tail) {
      const i = q[head++];
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0) push(x - 1, y);
      if (x < w - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y < h - 1) push(x, y + 1);
    }
  }

  /** FREE セルの連結成分ラベル (0 = なし) */
  labelComponents(): { labels: Int32Array; sizes: number[] } {
    const { w, h, data } = this;
    const labels = new Int32Array(w * h);
    const sizes: number[] = [0];
    const q = new Int32Array(w * h);
    let next = 1;
    for (let s = 0; s < w * h; s++) {
      if (data[s] !== FREE || labels[s]) continue;
      let head = 0;
      let tail = 0;
      labels[s] = next;
      q[tail++] = s;
      let size = 0;
      while (head < tail) {
        const i = q[head++];
        size++;
        const x = i % w;
        const y = (i / w) | 0;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
        for (const j of nb) {
          if (j >= 0 && data[j] === FREE && !labels[j]) {
            labels[j] = next;
            q[tail++] = j;
          }
        }
      }
      sizes.push(size);
      next++;
    }
    return { labels, sizes };
  }
}

/** マスクを k セル膨張（allowed に含まれるセルのみ） */
export function dilateMask(mask: Uint8Array, w: number, h: number, k: number, allowed?: (i: number) => boolean): Uint8Array {
  let cur = mask;
  for (let it = 0; it < k; it++) {
    const nxt = cur.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) continue;
        if (allowed && !allowed(i)) continue;
        if (
          (x > 0 && cur[i - 1]) ||
          (x < w - 1 && cur[i + 1]) ||
          (y > 0 && cur[i - w]) ||
          (y < h - 1 && cur[i + w]) ||
          (x > 0 && y > 0 && cur[i - w - 1]) ||
          (x < w - 1 && y > 0 && cur[i - w + 1]) ||
          (x > 0 && y < h - 1 && cur[i + w - 1]) ||
          (x < w - 1 && y < h - 1 && cur[i + w + 1])
        )
          nxt[i] = 1;
      }
    }
    cur = nxt;
  }
  return cur;
}

export function erodeMask(mask: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const inv = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
  const d = dilateMask(inv, w, h, k);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = d[i] ? 0 : 1;
  return out;
}

/**
 * マスクの境界をたどって多角形（mm座標）を返す。外周ループのみ、面積の大きい順。
 */
export function traceMask(mask: Uint8Array, grid: Grid, simplifyTol?: number): Vec2[][] {
  const { w, h } = grid;
  // 有向辺: 領域を左手に見る向き（y 下向き座標系なので時計回り表示になる）
  const next = new Map<number, number[]>();
  const key = (x: number, y: number) => y * (w + 1) + x;
  const addEdge = (x0: number, y0: number, x1: number, y1: number) => {
    const k0 = key(x0, y0);
    if (!next.has(k0)) next.set(k0, []);
    next.get(k0)!.push(key(x1, y1));
  };
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) addEdge(x + 1, y, x, y); // 上辺: 右→左
      if (!at(x, y + 1)) addEdge(x, y + 1, x + 1, y + 1); // 下辺: 左→右
      if (!at(x - 1, y)) addEdge(x, y, x, y + 1); // 左辺: 上→下
      if (!at(x + 1, y)) addEdge(x + 1, y + 1, x + 1, y); // 右辺: 下→上
    }
  }
  const loops: Vec2[][] = [];
  const unkey = (k: number): [number, number] => [k % (w + 1), Math.floor(k / (w + 1))];
  while (next.size) {
    const startK = next.keys().next().value as number;
    const loop: number[] = [startK];
    let cur = startK;
    let prevDir: [number, number] | null = null;
    for (let guard = 0; guard < 4 * w * h + 10; guard++) {
      const outs = next.get(cur);
      if (!outs || !outs.length) break;
      let idx = 0;
      if (outs.length > 1 && prevDir) {
        // 挟まれた頂点では右折を優先（領域を分離して辿る）
        const [cx, cy] = unkey(cur);
        let best = -Infinity;
        outs.forEach((o, oi) => {
          const [nx, ny] = unkey(o);
          const dx = nx - cx;
          const dy = ny - cy;
          const crossv = prevDir![0] * dy - prevDir![1] * dx;
          if (crossv > best) {
            best = crossv;
            idx = oi;
          }
        });
      }
      const nk = outs.splice(idx, 1)[0];
      if (!outs.length) next.delete(cur);
      const [cx, cy] = unkey(cur);
      const [nx, ny] = unkey(nk);
      prevDir = [nx - cx, ny - cy];
      cur = nk;
      if (cur === startK) break;
      loop.push(cur);
    }
    if (loop.length >= 4) {
      const pts = loop.map((k) => {
        const [x, y] = unkey(k);
        return { x: grid.ox + x * grid.res, y: grid.oy + y * grid.res };
      });
      loops.push(pts);
    }
  }
  const tol = simplifyTol ?? grid.res * 1.2;
  return loops
    .map((l) => simplifyClosed(removeCollinear(l, 0.01), tol))
    .filter((l) => l.length >= 3 && Math.abs(polygonArea(l)) > grid.res * grid.res * 4)
    .sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
}
