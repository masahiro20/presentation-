/**
 * 階段の区画を分ける
 *
 * リビング階段・ホールから上がる階段は、昇り口に壁も戸も無いので、区画（壁で囲まれた範囲）としては LDK・ホール・パントリーと一続きになる。
 * そのまま 1 つの部屋にすると「ＬＤＫ・階段 26.6 帖（図面は 22.8 帖）」のように帖数が合わず、床の拾いにも階段の分が入る。
 * 階段の範囲（段の線から読んだ矩形）が分かったら、その中を「階段」という別の区画にする。
 *
 * 升目のラベル（区画の番号）だけを書き換える。壁は足さないので、区画どうしの境はぴったり合う（すき間も重なりも無い）。
 */
import type { Vec2 } from '../core/types';
import type { BBox } from '../core/geometry';
import type { Grid } from './raster';

export interface StairCarve {
  /** 階段の区画のラベル（新しい番号） */
  stairLabel: number;
  /** 元の区画から切り離された、名前のある（または広い）別の区画のラベル（新しい番号）。元のラベルは「主な残り」に残る */
  extraLabels: number[];
  /** 階段の区画に入れた、名前の無い小さな残り（昇り口の前の踏み込み・回り段）の升の数 */
  joinedCells: number;
}

export interface StairCarveOptions {
  /** 残りの区画の名前の位置（階段の範囲の外にあるもの）。これが入った残りは別の区画として残す */
  namedPoints: Vec2[];
  /** 残りのうち「主な区画」（元のラベルを引き継ぐ）を決める位置。無ければいちばん広い名前付きの残り */
  mainPoint?: Vec2 | null;
  /** 名前の無い残りを階段に含める広さの上限 (㎡)。既定 2.5 */
  joinMaxM2?: number;
  /** 残りがこれより狭ければ分けない (㎡)。既定 1.5 */
  minRestM2?: number;
}

/**
 * ラベル l の区画から、階段の範囲 box の中を新しい区画として切り出す。labels・sizes を書き換える。
 * 分けないとき（階段の範囲の半分以上がこの区画に無い・残りが狭い）は null
 */
export function carveStairRegion(grid: Grid, labels: Int32Array, sizes: number[], l: number, box: BBox, opts: StairCarveOptions): StairCarve | null {
  const { w, h, res } = grid;
  const cellM2 = (res * res) / 1e6;
  const [bx0, by0] = grid.cellOf({ x: box.minX + res / 2, y: box.minY + res / 2 });
  const [bx1, by1] = grid.cellOf({ x: box.maxX - res / 2, y: box.maxY - res / 2 });
  let x0 = Math.max(0, bx0);
  let y0 = Math.max(0, by0);
  let x1 = Math.min(w - 1, bx1);
  let y1 = Math.min(h - 1, by1);
  if (x1 < x0 || y1 < y0) return null;
  // 階段の範囲と壁の間に残る細い帯（240mm まで）は階段に含める。
  // 階段は手すり壁の細い線で囲まれて描かれ、本当の壁との間に 60〜100mm のすき間が残る。そのままだと、
  // 階段を囲む輪になった残り（ホール）の輪郭が階段ごと囲んでしまい、面積が二重になる（伊藤様邸 2 階）
  {
    const MAX = Math.round(240 / res);
    // 辺の外へ 1 列ずつ見る: 壁の列（8 割以上が壁）を覚えながら、この区画か壁だけの列の間は進む。ほかの区画・屋外が出たら止まる
    const reach = (line: (d: number) => number[] | null): number => {
      let last = 0;
      for (let d = 1; d <= MAX; d++) {
        const cells = line(d);
        if (!cells || !cells.length) break;
        let wall = 0;
        let own = 0;
        for (const i of cells) {
          if (grid.data[i] !== 0) wall++;
          else if (labels[i] === l) own++;
        }
        if (wall + own < cells.length * 0.95) break;
        if (wall >= cells.length * 0.8) last = d;
      }
      // いちばん外の壁の列の手前まで
      return Math.max(0, last - 1);
    };
    const row = (y: number, xa: number, xb: number) => {
      if (y < 0 || y >= h) return null;
      const out: number[] = [];
      for (let x = xa; x <= xb; x++) out.push(y * w + x);
      return out;
    };
    const col = (x: number, ya: number, yb: number) => {
      if (x < 0 || x >= w) return null;
      const out: number[] = [];
      for (let y = ya; y <= yb; y++) out.push(y * w + x);
      return out;
    };
    const top = reach((d) => row(y0 - d, x0, x1));
    const bottom = reach((d) => row(y1 + d, x0, x1));
    const left = reach((d) => col(x0 - d, y0, y1));
    const right = reach((d) => col(x1 + d, y0, y1));
    y0 -= top;
    y1 += bottom;
    x0 -= left;
    x1 += right;
  }
  const inBox: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (labels[y * w + x] === l) inBox.push(y * w + x);
  const boxCells = (x1 - x0 + 1) * (y1 - y0 + 1);
  // 階段の範囲の半分以上がこの区画にあること（別の区画・壁にまたがる範囲は読み違いの疑い）
  if (inBox.length < boxCells * 0.5) return null;
  const rest = (sizes[l] ?? 0) - inBox.length;
  if (rest * cellM2 < (opts.minRestM2 ?? 1.5)) return null;

  const stairLabel = sizes.length;
  for (const i of inBox) labels[i] = stairLabel;
  sizes.push(inBox.length);
  sizes[l] = rest;

  // 残りのつながり（階段を抜いたので、階段の向こう側が離れ小島になることがある）
  const comp = new Int32Array(w * h);
  const comps: { cells: number[]; named: boolean; main: boolean }[] = [];
  const queue: number[] = [];
  for (let s = 0; s < labels.length; s++) {
    if (labels[s] !== l || comp[s]) continue;
    const id = comps.length + 1;
    const cells: number[] = [];
    comp[s] = id;
    queue.length = 0;
    queue.push(s);
    while (queue.length) {
      const i = queue.pop()!;
      cells.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && labels[i - 1] === l && !comp[i - 1]) (comp[i - 1] = id), queue.push(i - 1);
      if (x < w - 1 && labels[i + 1] === l && !comp[i + 1]) (comp[i + 1] = id), queue.push(i + 1);
      if (y > 0 && labels[i - w] === l && !comp[i - w]) (comp[i - w] = id), queue.push(i - w);
      if (y < h - 1 && labels[i + w] === l && !comp[i + w]) (comp[i + w] = id), queue.push(i + w);
    }
    comps.push({ cells, named: false, main: false });
  }
  if (comps.length <= 1) return { stairLabel, extraLabels: [], joinedCells: 0 };

  // 位置 → 残りの番号（文字が壁の上にあるときは、8 升以内でいちばん近い升）
  const compAt = (p: Vec2): number => {
    const [cx, cy] = grid.cellOf(p);
    for (let r = 0; r <= 8; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const c = comp[y * w + x];
          if (c) return c;
        }
    return 0;
  };
  for (const p of opts.namedPoints) {
    const c = compAt(p);
    if (c) comps[c - 1].named = true;
  }
  const mainId = opts.mainPoint ? compAt(opts.mainPoint) : 0;
  let main = mainId ? comps[mainId - 1] : null;
  if (!main) main = comps.filter((c) => c.named).sort((a, b) => b.cells.length - a.cells.length)[0] ?? comps.slice().sort((a, b) => b.cells.length - a.cells.length)[0];
  main.main = true;

  const extraLabels: number[] = [];
  let joinedCells = 0;
  const joinMax = (opts.joinMaxM2 ?? 2.5) / cellM2;
  for (const c of comps) {
    if (c.main) continue;
    if (!c.named && c.cells.length < joinMax) {
      // 名前の無い小さな残り: 階段の一部（踏み込み・回り段・階段の上のホール）
      for (const i of c.cells) labels[i] = stairLabel;
      sizes[stairLabel] += c.cells.length;
      joinedCells += c.cells.length;
    } else {
      const nl = sizes.length;
      for (const i of c.cells) labels[i] = nl;
      sizes.push(c.cells.length);
      extraLabels.push(nl);
    }
    sizes[l] -= c.cells.length;
  }
  return { stairLabel, extraLabels, joinedCells };
}
