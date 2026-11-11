/**
 * 屋根の塊の分け方（three 非依存）。
 *
 * 屋根は「階の外形のうち、上の階が載らない範囲のつながった所（塊）」ごとに掛ける。
 * 3D の屋根（scene/roof.ts）と、立面図の屋根の線から塊ごとの掛け方を読む処理（parser/elevationRoof.ts）が
 * 同じ分け方を使えるよう、格子と塊の計算だけをここに置く。
 */
import { OUTDOOR_TYPES, type Floor, type RoofPatch, type Vec2 } from './types';
import { insideLoops } from './geometry';
import { isOpenSkyBalcony } from './balcony';
import type { Rect } from './rects';

/**
 * 屋根を架ける範囲の輪郭。外形が読めていない階（壁に隙間があって外形が追えなかった・画像の図面）は、
 * 屋根が丸ごと出ない（「屋根が表示されない」）ので、屋内の部屋の区画を代わりに使う
 */
export function roofLoops(f: Floor): Vec2[][] {
  const loops = f.outline.filter((l) => l.length >= 3);
  if (loops.length) return loops;
  return f.rooms.filter((r) => r.polygon.length >= 3 && !OUTDOOR_TYPES.includes(r.type)).map((r) => r.polygon);
}

/** 手で描いた屋根の範囲（足した屋根・屋根なし）: 多角形（loop）か四角形（rect）。無ければ自動の塊の手直し */
export function patchLoop(p: RoofPatch): Vec2[] | undefined {
  if (p.loop && p.loop.length >= 3) return p.loop;
  if (p.rect) {
    const r = p.rect;
    return [
      { x: r.minX, y: r.minY },
      { x: r.maxX, y: r.minY },
      { x: r.maxX, y: r.maxY },
      { x: r.minX, y: r.maxY },
    ];
  }
  return undefined;
}
/** この階の手で描いた範囲（足した屋根・屋根なし）。自動の屋根からはこの範囲を除く */
export const manualLoopsOf = (patches: RoofPatch[] | undefined, level: number): Vec2[][] => (patches ?? []).filter((p) => p.level === level).map(patchLoop).filter((l): l is Vec2[] => !!l);

/** 屋根の格子（座標を圧縮した升目）と、この範囲・上の範囲のマスク */
export interface RoofGrid {
  polys: Vec2[][];
  xs: number[];
  zs: number[];
  nx: number;
  nz: number;
  mask: Uint8Array;
  maskUpper: Uint8Array;
}

/**
 * 屋根の格子: 輪郭の頂点で座標を圧縮し、この範囲（上の範囲が載らず、除く範囲にも入らない所）と上の範囲をマスクにする。
 * 格子の目が範囲に入るかは、中心 1 点ではなく 3 × 3 の点で見る（斜めの外壁の目は中心がちょうど辺の上に乗り、
 * 入らない扱いになって屋根に穴が開いていた: 吉田大仁様邸の隅切りの LDK）。3 点以上入れば屋根を掛け、斜めの辺で切り落とす
 */
export function gridOfLoops(polys: Vec2[][], higher: Vec2[][][], exclude: Vec2[][] = [], open: Vec2[][] = []): RoofGrid {
  const all = [...polys, ...higher.flat(), ...exclude, ...open].flat();
  const uniq = (vals: number[]) => {
    const s = vals.slice().sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of s) if (!out.length || v - out[out.length - 1] > 20) out.push(v);
    return out;
  };
  const xs = uniq(all.map((p) => p.x));
  const zs = uniq(all.map((p) => p.y));
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  const mask = new Uint8Array(Math.max(0, nx * nz));
  const maskUpper = new Uint8Array(Math.max(0, nx * nz));
  const inside = (loops: Vec2[][], i: number, j: number) => {
    let n = 0;
    for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) if (insideLoops({ x: xs[i] + (xs[i + 1] - xs[i]) * fx, y: zs[j] + (zs[j + 1] - zs[j]) * fy }, loops)) n++;
    return n;
  };
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const nIn = inside(polys, i, j);
      // 空に開いたバルコニー（ルーフバルコニー・上の階を欠いて作ったバルコニー）には屋根を掛けない。
      // 斜めの辺のバルコニーは升目の半分しか占めないので、外形に入る点の 6 割以上がバルコニーなら、その升目はバルコニー
      const nOpen = open.length && nIn >= 3 ? inside(open, i, j) : 0;
      const inThis = nIn >= 3 && !(exclude.length && inside(exclude, i, j) >= 5) && !(nOpen >= 3 && nOpen >= nIn * 0.6);
      const inUpper = higher.some((h) => inside(h, i, j) >= 5);
      mask[j * nx + i] = inThis && !inUpper ? 1 : 0;
      maskUpper[j * nx + i] = inUpper ? 1 : 0;
    }
  return { polys, xs, zs, nx, nz, mask, maskUpper };
}

/** 階 k の屋根の格子: この階の外形（上の階が載らない所。手で描いた範囲は除く）と上の階の範囲 */
export function floorGrid(floors: Floor[], k: number, exclude: Vec2[][] = []): RoofGrid & { f: Floor } {
  const f = floors[k];
  const higher = floors.slice(k + 1).map((h) => roofLoops(h));
  const open = f.rooms.filter((r) => isOpenSkyBalcony(floors, k, r)).map((r) => r.polygon);
  return { f, ...gridOfLoops(roofLoops(f), higher, exclude, open) };
}

/** 格子の座標 v が入る区間の番号（無ければ -1） */
export function cellIndex(axis: number[], v: number): number {
  for (let i = 0; i + 1 < axis.length; i++) if (v >= axis[i] && v < axis[i + 1]) return i;
  return -1;
}

/** この塊に当たる手直し（at がその塊の格子の中にある物） */
export function patchFor(patches: RoofPatch[] | undefined, level: number, comp: { cells: Set<number> }, xs: number[], zs: number[], nx: number): RoofPatch | undefined {
  if (!patches) return undefined;
  for (const p of patches) {
    if (p.level !== level || patchLoop(p)) continue; // 手で描いた範囲（足した屋根・屋根なし）は塊の手直しではない
    const i = cellIndex(xs, p.at.x);
    const j = cellIndex(zs, p.at.y);
    if (i >= 0 && j >= 0 && comp.cells.has(j * nx + i)) return p;
  }
  return undefined;
}

/** 屋根の塊 1 つ: 格子の升目・重ならない四角形・外接する四角形 */
export interface RoofComp {
  cells: Set<number>;
  rects: Rect[];
  bbox: Rect;
}

/** マスク（格子）のつながった範囲（4 近傍）。rects は重ならない四角形（行ごとの連続区間を、同じ区間が続く行でまとめたもの） */
export function maskComponents(xs: number[], zs: number[], mask: Uint8Array): RoofComp[] {
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  const seen = new Uint8Array(nx * nz);
  const out: RoofComp[] = [];
  for (let start = 0; start < nx * nz; start++) {
    if (!mask[start] || seen[start]) continue;
    const cells = new Set<number>();
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      cells.add(c);
      const i = c % nx;
      const j = (c - i) / nx;
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const k = jj * nx + ii;
        if (mask[k] && !seen[k]) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    // 行ごとの連続区間 → 同じ区間が続く行をまとめる
    const runs: { j0: number; j1: number; i0: number; i1: number }[] = [];
    for (let j = 0; j < nz; j++) {
      let i = 0;
      while (i < nx) {
        if (!cells.has(j * nx + i)) {
          i++;
          continue;
        }
        let k = i;
        while (k + 1 < nx && cells.has(j * nx + k + 1)) k++;
        const prev = runs.find((r) => r.j1 === j - 1 && r.i0 === i && r.i1 === k);
        if (prev) prev.j1 = j;
        else runs.push({ j0: j, j1: j, i0: i, i1: k });
        i = k + 1;
      }
    }
    const rects = runs.map((r) => ({ minX: xs[r.i0], maxX: xs[r.i1 + 1], minY: zs[r.j0], maxY: zs[r.j1 + 1] }));
    const bbox = { minX: Math.min(...rects.map((r) => r.minX)), maxX: Math.max(...rects.map((r) => r.maxX)), minY: Math.min(...rects.map((r) => r.minY)), maxY: Math.max(...rects.map((r) => r.maxY)) };
    out.push({ cells, rects, bbox });
  }
  return out;
}

/** 塊の目印の点: いちばん大きい四角形の中心（手直しの at に使う。3D の「屋根」の道具と同じ決め方） */
export function compCenter(comp: { rects: Rect[] }): Vec2 {
  const big = comp.rects.slice().sort((a, b) => (b.maxX - b.minX) * (b.maxY - b.minY) - (a.maxX - a.minX) * (a.maxY - a.minY))[0];
  return { x: (big.minX + big.maxX) / 2, y: (big.minY + big.maxY) / 2 };
}
