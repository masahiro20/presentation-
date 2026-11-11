/**
 * 手すりが細い線だけで描かれたバルコニー
 *
 * バルコニー・ルーフバルコニーの手すり（笠木付きの腰壁・格子）は、提案図では塗りの無い細い二重線・三重線で描かれることがある。
 * 壁として検出できないので、バルコニーは「屋外」になり、床も手すりも立ち上がらない
 * （田中様邸 2 階: 斜めの手すりの三角のバルコニー、市岡様邸 4 階: ルーフバルコニー）。
 *
 * 「バルコニー」の室名が屋外にあるとき、その位置から細い線と壁で囲まれた範囲を探し、
 * 範囲の縁のうち壁でない所（細い線の所）を手すり壁として返す。壁として足せば、あとは普通の部屋と同じ流れで読める。
 *
 * 升目で調べる: 屋外の升を、図の外周から細い線を越えずにたどる。たどり着けない升 = 細い線と壁で囲まれた所。
 * 囲まれた所は屋根の線・寸法線でもできるので、室名の入った 1 つの囲みだけを使う（隣の囲みへは広げない）。
 */
import type { Vec2 } from '../core/types';
import type { BBox } from '../core/geometry';
import { polygonArea } from '../core/geometry';
import { Grid, OUTSIDE, WALL, dilateMask, traceMask } from './raster';

export interface BalconyRailInput {
  /** 図（壁のまとまり）の範囲 */
  bbox: BBox;
  /** 「バルコニー」の室名の位置 */
  labels: Vec2[];
  walls: { a: Vec2; b: Vec2; d: number }[];
  /** 壁の塗り・窓の白抜き（部屋の区切りとして塗るもの） */
  wallPolys: Vec2[][];
  /** 同じ直線上の壁と壁の間の切れ目（窓・出入口。内外の判定で塞ぐ線） */
  closers: { a: Vec2; b: Vec2; d: number }[];
  /** 細い実線（手すり・笠木の線の候補） */
  lines: { a: Vec2; b: Vec2 }[];
}

export interface BalconyRail {
  a: Vec2;
  b: Vec2;
  /** 手すり壁の厚み (mm) */
  d: number;
}

export interface BalconyFound {
  label: Vec2;
  /** 囲まれた範囲の広さ (㎡) */
  area: number;
  polygon: Vec2[];
  rails: BalconyRail[];
}

const CLOSER = 3;
/** バルコニーが図（壁のまとまり）の外へ出る分 */
const MARGIN = 2600;
const RES = 20;

export function findBalconyRails(input: BalconyRailInput): BalconyFound[] {
  const { bbox, labels, walls, wallPolys, closers } = input;
  if (!labels.length || !input.lines.length) return [];
  const g = Grid.around(bbox.minX, bbox.minY, bbox.maxX, bbox.maxY, RES, MARGIN);
  const { w, h } = g;
  const drawWalls = (grid: Grid) => {
    for (const wl of walls) grid.fillThickSegment(wl.a, wl.b, wl.d, WALL);
    for (const poly of wallPolys) grid.fillPolygon(poly, WALL);
  };
  for (const c of closers) g.fillThickSegment(c.a, c.b, Math.max(60, Math.min(c.d, 120)), CLOSER);
  // 壁の上に重なった塞ぎ線は壁のまま
  drawWalls(g);
  g.floodOutside();
  const at = (p: Vec2): number => {
    const [x, y] = g.cellOf(p);
    return x < 0 || y < 0 || x >= w || y >= h ? -1 : y * w + x;
  };
  const cand = labels.filter((p) => {
    const i = at(p);
    return i >= 0 && g.data[i] === OUTSIDE;
  });
  if (!cand.length) return [];

  // 細い線。破線・一点鎖線（敷地境界・斜線・上階の輪郭）は手すりではないので除く
  const lines = dropBrokenLines(input.lines.filter((sg) => Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y) >= 150));
  // 端を少し伸ばして、線どうし・線と壁の小さなすき間を塞ぐ
  const tg = new Grid(w, h, RES, g.ox, g.oy);
  for (const sg of lines) {
    const L = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
    const ex = ((sg.b.x - sg.a.x) / L) * 30;
    const ey = ((sg.b.y - sg.a.y) / L) * 30;
    tg.fillThickSegment({ x: sg.a.x - ex, y: sg.a.y - ey }, { x: sg.b.x + ex, y: sg.b.y + ey }, 50, WALL);
  }
  const line = new Uint8Array(w * h);
  for (let i = 0; i < line.length; i++) if (tg.data[i] === WALL && g.data[i] === OUTSIDE) line[i] = 1;

  /** 図の外周から、屋外の升を blocked を越えずにたどる */
  const queue = new Int32Array(w * h);
  const floodFromBorder = (blocked: (i: number) => boolean): Uint8Array => {
    const reach = new Uint8Array(w * h);
    let head = 0;
    let tail = 0;
    const push = (i: number) => {
      if (reach[i] || g.data[i] !== OUTSIDE || blocked(i)) return;
      reach[i] = 1;
      queue[tail++] = i;
    };
    for (let x = 0; x < w; x++) {
      push(x);
      push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      push(y * w);
      push(y * w + w - 1);
    }
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }
    return reach;
  };
  const reach = floodFromBorder((i) => line[i] === 1);
  const pocketCell = (i: number) => g.data[i] === OUTSIDE && !line[i] && !reach[i];
  // 囲み（細い線と壁で囲まれた屋外の升のまとまり）に番号を付ける
  const comp = new Int32Array(w * h);
  const compSize: number[] = [0];
  for (let s0 = 0; s0 < comp.length; s0++) {
    if (comp[s0] || !pocketCell(s0)) continue;
    const id = compSize.length;
    let head = 0;
    let tail = 0;
    let n = 0;
    comp[s0] = id;
    queue[tail++] = s0;
    while (head < tail) {
      const i = queue[head++];
      n++;
      const x = i % w;
      const y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || comp[j] || !pocketCell(j)) continue;
        comp[j] = id;
        queue[tail++] = j;
      }
    }
    compSize.push(n);
  }
  const cellM2 = (RES * RES) / 1e6;

  const out: BalconyFound[] = [];
  const usedId = new Set<number>();
  for (const p of cand) {
    let s = at(p);
    if (s < 0) continue;
    if (!comp[s]) {
      // 文字が線の上にあるときは、近く（120mm 以内）の升
      const [cx, cy] = g.cellOf(p);
      s = -1;
      for (let r = 1; r <= 6 && s < 0; r++)
        for (let dy = -r; dy <= r && s < 0; dy++)
          for (let dx = -r; dx <= r && s < 0; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = cx + dx;
            const y = cy + dy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            if (comp[y * w + x]) s = y * w + x;
          }
      if (s < 0) continue;
    }
    const id = comp[s];
    if (usedId.has(id)) continue;
    usedId.add(id);
    // バルコニーとしてあり得る広さ（線の升の分だけ小さく出る）
    const cells = compSize[id] * cellM2;
    if (cells < 0.9 || cells > 45) continue;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) if (comp[i] === id) mask[i] = 1;
    // 建物に付いていること: 囲みの縁のうち、壁（または塞ぎ線）に面した長さが 0.8m 以上
    if (attachedLength(mask, g) < 800) continue;
    // 線の向こうが開いているか: 図の外周からたどれる屋外、または別の広い囲み（下屋の屋根など。設備の箱のような小さな囲みは違う）
    const open = (i: number) => reach[i] === 1 || (comp[i] !== 0 && comp[i] !== id && compSize[comp[i]] * cellM2 >= 1);
    const rails = railsFromLines(mask, g, lines, walls, open);
    if (rails.reduce((sum, r) => sum + Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y), 0) < 800) continue;
    // 手すり壁を足せば閉じること（閉じなければ、囲みは短い線・曲線でできている。壁だけ足しても部屋にならないのでやめる）
    const tg2 = new Grid(w, h, RES, g.ox, g.oy);
    for (const r of rails) tg2.fillThickSegment(r.a, r.b, r.d, WALL);
    const reach2 = floodFromBorder((i) => tg2.data[i] === WALL);
    if (reach2[s]) continue;
    const loops = traceMask(dilateMask(mask, w, h, 1, (i) => line[i] === 1), g, 45);
    const poly = loops[0] ?? [];
    out.push({ label: p, area: poly.length ? Math.abs(polygonArea(poly)) / 1e6 : cells, polygon: poly, rails });
  }
  return out;
}

/**
 * 破線・一点鎖線を除く。CAD の出力では破線が「短い実線の列」になっていることがある（setDash ではない）。
 * 同じ直線上に、すき間（15〜400mm）をあけて 3 本以上並ぶ線は破線
 */
export function dropBrokenLines<T extends { a: Vec2; b: Vec2 }>(lines: T[]): T[] {
  interface Item {
    sg: T;
    t0: number;
    t1: number;
    o: number;
  }
  const groups = new Map<string, Item[]>();
  for (const sg of lines) {
    const L = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
    if (L < 1) continue;
    let ux = (sg.b.x - sg.a.x) / L;
    let uy = (sg.b.y - sg.a.y) / L;
    // 向きをそろえる（ほぼ水平・ほぼ垂直はきっちりそろえる）
    if (Math.abs(uy) < 0.004) {
      ux = 1;
      uy = 0;
    } else if (Math.abs(ux) < 0.004) {
      ux = 0;
      uy = 1;
    } else if (ux < 0) {
      ux = -ux;
      uy = -uy;
    }
    const ak = Math.round((Math.atan2(uy, ux) * 360) / Math.PI);
    const ta = sg.a.x * ux + sg.a.y * uy;
    const tb = sg.b.x * ux + sg.b.y * uy;
    const o = -sg.a.x * uy + sg.a.y * ux;
    const key = `${ak}:${Math.round(o / 20)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ sg, t0: Math.min(ta, tb), t1: Math.max(ta, tb), o });
  }
  const broken = new Set<T>();
  for (const items of groups.values()) {
    if (items.length < 3) continue;
    items.sort((p, q) => p.t0 - q.t0);
    // すき間でつながる列ごとに数える
    let chain: Item[] = [items[0]];
    let end = items[0].t1;
    const flush = () => {
      if (chain.length >= 3) for (const it of chain) broken.add(it.sg);
    };
    for (let k = 1; k < items.length; k++) {
      const it = items[k];
      const gap = it.t0 - end;
      if (gap >= 15 && gap <= 400) {
        chain.push(it);
      } else if (gap < 15) {
        // つながっている（同じ線の続き）: 列は切らずに伸ばす
        chain[chain.length - 1] = { ...chain[chain.length - 1], t1: Math.max(end, it.t1) };
        if (chain.length >= 2) broken.add(it.sg);
      } else {
        flush();
        chain = [it];
      }
      end = Math.max(end, it.t1);
    }
    flush();
  }
  return broken.size ? lines.filter((sg) => !broken.has(sg)) : lines;
}

/** 囲みの縁のうち、壁・塞ぎ線に面した長さ (mm)。縁の升から 100mm 以内に壁があるものを数える */
function attachedLength(mask: Uint8Array, g: Grid): number {
  const { w, h } = g;
  let n = 0;
  const R = 5;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      // 縁の升（4 近傍に囲みでない升がある）
      if (x > 0 && x < w - 1 && y > 0 && y < h - 1 && mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w]) continue;
      let hit = false;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        for (let d = 1; d <= R && !hit; d++) {
          const xx = x + dx * d;
          const yy = y + dy * d;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
          const v = g.data[yy * w + xx];
          if (v === WALL || v === CLOSER) hit = true;
          else if (mask[yy * w + xx]) break;
        }
        if (hit) break;
      }
      if (hit) n++;
    }
  return n * g.res;
}

/**
 * 囲みに面した細い線を手すり壁にする。
 * 線の片側だけが囲みのもの（両側とも囲みの線は、引き出し線・床の目地）。二重線・三重線の笠木は、いちばん内側の線から外の線までを厚みにする
 */
function railsFromLines(mask: Uint8Array, g: Grid, lines: { a: Vec2; b: Vec2 }[], walls: { a: Vec2; b: Vec2; d: number }[], open: (i: number) => boolean): BalconyRail[] {
  const { w, h } = g;
  const inMask = (x: number, y: number) => {
    const cx = Math.floor((x - g.ox) / g.res);
    const cy = Math.floor((y - g.oy) / g.res);
    return cx >= 0 && cy >= 0 && cx < w && cy < h && mask[cy * w + cx] === 1;
  };
  // 囲みの範囲
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      const x = i % w;
      const y = (i / w) | 0;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
  const box = { minX: g.ox + bx0 * g.res - 150, minY: g.oy + by0 * g.res - 150, maxX: g.ox + (bx1 + 1) * g.res + 150, maxY: g.oy + (by1 + 1) * g.res + 150 };
  const STEP = 40;
  interface Rail {
    a: Vec2;
    b: Vec2;
    u: Vec2;
    /** 外向き（囲みの反対側） */
    n: Vec2;
    d: number;
  }
  const raw: Rail[] = [];
  for (const sg of lines) {
    const L = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
    if (L < 300) continue;
    if (Math.max(sg.a.x, sg.b.x) < box.minX || Math.min(sg.a.x, sg.b.x) > box.maxX || Math.max(sg.a.y, sg.b.y) < box.minY || Math.min(sg.a.y, sg.b.y) > box.maxY) continue;
    const u = { x: (sg.b.x - sg.a.x) / L, y: (sg.b.y - sg.a.y) / L };
    const nn = { x: -u.y, y: u.x };
    const cnt = Math.max(1, Math.round(L / STEP));
    let plus = 0;
    let minus = 0;
    let both = 0;
    const side: number[] = [];
    for (let k = 0; k < cnt; k++) {
      const t = ((k + 0.5) / cnt) * L;
      const px = sg.a.x + u.x * t;
      const py = sg.a.y + u.y * t;
      let p = false;
      let m = false;
      for (const dd of [45, 65, 85]) {
        if (inMask(px + nn.x * dd, py + nn.y * dd)) p = true;
        if (inMask(px - nn.x * dd, py - nn.y * dd)) m = true;
      }
      if (p && m) {
        both++;
        side.push(0);
      } else if (p) {
        plus++;
        side.push(1);
      } else if (m) {
        minus++;
        side.push(-1);
      } else side.push(0);
    }
    const sgn = plus >= minus ? 1 : -1;
    const adj = Math.max(plus, minus);
    if ((adj * L) / cnt < 400) continue;
    // 両側とも囲み（囲みの中を通る線）や、反対側にも囲みが付く線は手すりではない
    if (both > adj * 0.5 || Math.min(plus, minus) > adj * 0.3) continue;
    // 線の向こう（320mm まで）が開いていること。壁に沿う線（壁の面・サッシの線）や、設備の箱・踏み台の線は向こうが開いていない
    let openN = 0;
    let outdoorN = 0;
    for (let k = 0; k < cnt; k++) {
      if (side[k] !== sgn) continue;
      const t = ((k + 0.5) / cnt) * L;
      const px = sg.a.x + u.x * t;
      const py = sg.a.y + u.y * t;
      let outdoor = true;
      for (let dd = 40; dd <= 320; dd += 20) {
        const cx = Math.floor((px - nn.x * sgn * dd - g.ox) / g.res);
        const cy = Math.floor((py - nn.y * sgn * dd - g.oy) / g.res);
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) {
          openN++;
          break;
        }
        const i = cy * w + cx;
        if (g.data[i] !== OUTSIDE) {
          outdoor = false;
          break;
        }
        if (open(i)) {
          openN++;
          break;
        }
      }
      if (outdoor) outdoorN++;
    }
    if (openN < adj * 0.6) {
      // 向こうが小さな囲み（室外機置場・設備の台）でも、線の両端が壁に届いていれば手すり（袖壁から袖壁へ渡る手すり）。
      // 向こうは屋外であること（壁・建物の中ではない）
      const nearWall = (q: Vec2) => {
        const cx = Math.floor((q.x - g.ox) / g.res);
        const cy = Math.floor((q.y - g.oy) / g.res);
        for (let dy = -6; dy <= 6; dy++)
          for (let dx = -6; dx <= 6; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            if (x >= 0 && y >= 0 && x < w && y < h && g.data[y * w + x] === WALL) return true;
          }
        return false;
      };
      if (outdoorN < adj * 0.8 || !nearWall(sg.a) || !nearWall(sg.b)) continue;
    }
    let k0 = side.indexOf(sgn);
    let k1 = side.lastIndexOf(sgn);
    // 端まで 1 コマ以内なら線の端まで
    if (k0 <= 1) k0 = 0;
    if (k1 >= cnt - 2) k1 = cnt - 1;
    const t0 = (k0 / cnt) * L;
    const t1 = ((k1 + 1) / cnt) * L;
    if (t1 - t0 < 400) continue;
    raw.push({ a: { x: sg.a.x + u.x * t0, y: sg.a.y + u.y * t0 }, b: { x: sg.a.x + u.x * t1, y: sg.a.y + u.y * t1 }, u, n: { x: -nn.x * sgn, y: -nn.y * sgn }, d: 0 });
  }
  // 同じ線の上の手すりをまとめる（線が途中で切れている・重ね描き）。
  // 平行ですぐ外・すぐ内（260mm まで）にある線は同じ手すりの笠木の線なので、いちばん内側の線だけを残す
  let merged: (Rail & { dead?: boolean })[] = [];
  for (const r of raw.sort((p, q) => Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y) - Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y))) {
    let absorbed = false;
    for (const m of merged) {
      if (m.dead) continue;
      if (Math.abs(m.u.x * r.u.y - m.u.y * r.u.x) > 0.03) continue;
      if (m.n.x * r.n.x + m.n.y * r.n.y < 0.9) continue;
      const L = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y);
      const ta = (r.a.x - m.a.x) * m.u.x + (r.a.y - m.a.y) * m.u.y;
      const tb = (r.b.x - m.a.x) * m.u.x + (r.b.y - m.a.y) * m.u.y;
      if (Math.min(ta, tb) > L + 150 || Math.max(ta, tb) < -150) continue;
      // r は m の外向きにどれだけ離れているか
      const o = ((r.a.x + r.b.x) / 2 - m.a.x) * m.n.x + ((r.a.y + r.b.y) / 2 - m.a.y) * m.n.y;
      if (Math.abs(o) > 260) continue;
      const lo = Math.min(0, ta, tb);
      const hi = Math.max(L, ta, tb);
      if (o < -20) {
        // r のほうが内側: m を r の線に乗せ替える
        const base = { x: m.a.x + m.n.x * o, y: m.a.y + m.n.y * o };
        m.a = { x: base.x + m.u.x * lo, y: base.y + m.u.y * lo };
        m.b = { x: base.x + m.u.x * hi, y: base.y + m.u.y * hi };
      } else {
        const a0 = m.a;
        m.a = { x: a0.x + m.u.x * lo, y: a0.y + m.u.y * lo };
        m.b = { x: a0.x + m.u.x * hi, y: a0.y + m.u.y * hi };
      }
      absorbed = true;
      break;
    }
    if (!absorbed) merged.push({ ...r });
  }
  merged = merged.filter((m) => !m.dead);
  // 手すりの厚み: 外側 260mm までにある平行な線のうち、いちばん外のものまで
  for (const r of merged) {
    const L = Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y);
    let far = 0;
    for (const sg of lines) {
      const sl = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
      if (sl < 300) continue;
      const su = { x: (sg.b.x - sg.a.x) / sl, y: (sg.b.y - sg.a.y) / sl };
      if (Math.abs(su.x * r.u.y - su.y * r.u.x) > 0.03) continue;
      const o = (((sg.a.x + sg.b.x) / 2 - r.a.x) * r.n.x + ((sg.a.y + sg.b.y) / 2 - r.a.y) * r.n.y);
      if (o < 15 || o > 260) continue;
      const ta = (sg.a.x - r.a.x) * r.u.x + (sg.a.y - r.a.y) * r.u.y;
      const tb = (sg.b.x - r.a.x) * r.u.x + (sg.b.y - r.a.y) * r.u.y;
      const ov = Math.min(L, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb));
      if (ov < L * 0.5) continue;
      far = Math.max(far, o);
    }
    const off = far / 2;
    r.d = Math.round(Math.max(60, Math.min(200, far || 80)));
    r.a = { x: r.a.x + r.n.x * off, y: r.a.y + r.n.y * off };
    r.b = { x: r.b.x + r.n.x * off, y: r.b.y + r.n.y * off };
  }
  // 端の始末: 近くの手すりとは角で交わらせ、壁には芯まで伸ばす（450mm まで）
  const cross = (p: Vec2, r: Vec2, q: Vec2, s: Vec2): Vec2 | null => {
    const den = r.x * s.y - r.y * s.x;
    if (Math.abs(den) < 1e-6) return null;
    const t = ((q.x - p.x) * s.y - (q.y - p.y) * s.x) / den;
    return { x: p.x + r.x * t, y: p.y + r.y * t };
  };
  const REACH = 450;
  const ends = merged.map((r) => ({ a: { ...r.a }, b: { ...r.b } }));
  merged.forEach((r, ri) => {
    for (const end of ['a', 'b'] as const) {
      const p = r[end];
      /** 交点の候補: out = 端から外へ伸ばす長さ（負なら縮める）、cornerAdd = 相手の端（角）で出会うときに足す長さ（相手の厚みの半分） */
      const cands: { x: Vec2; out: number; cornerAdd: number }[] = [];
      const consider = (q: Vec2, s: Vec2, len: number, slack: number, thick: number) => {
        const x = cross(r.a, r.u, q, s);
        if (!x) return;
        // 交点が相手の区間（端から slack まで）にあること
        const t = (x.x - q.x) * s.x + (x.y - q.y) * s.y;
        if (t < -slack || t > len + slack) return;
        const along = (x.x - p.x) * r.u.x + (x.y - p.y) * r.u.y;
        const out = end === 'a' ? -along : along;
        // 伸ばすのは 450mm まで、縮めるのは 150mm まで
        if (out > REACH || out < -150) return;
        // 相手の端で出会う（L 字の角）なら、相手の外面まで伸ばして角を塞ぐ（途中で突き当たる T 字なら芯まで）
        const tol = r.d / 2 + 40;
        const corner = t < tol || t > len - tol;
        cands.push({ x, out, cornerAdd: corner ? thick / 2 : 0 });
      };
      merged.forEach((o, oi) => {
        if (oi === ri || Math.abs(o.u.x * r.u.y - o.u.y * r.u.x) < 0.2) return;
        consider(o.a, o.u, Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y), REACH, o.d);
      });
      if (!cands.length)
        for (const wl of walls) {
          const wl2 = Math.hypot(wl.b.x - wl.a.x, wl.b.y - wl.a.y);
          if (wl2 < 1) continue;
          const su = { x: (wl.b.x - wl.a.x) / wl2, y: (wl.b.y - wl.a.y) / wl2 };
          if (Math.abs(su.x * r.u.y - su.y * r.u.x) < 0.2) continue;
          consider(wl.a, su, wl2, wl.d / 2 + 60, wl.d);
        }
      if (!cands.length) continue;
      // いちばん近い「伸ばす」交点。壁の角（2 枚の壁が出会う所）では交点が 2 つ並ぶので、220mm 先までなら遠いほうまで伸ばして角を塞ぐ。
      // 伸ばす交点が無ければ、いちばん少なく縮める交点
      const outs = cands.filter((c) => c.out >= -1).sort((a, b) => a.out - b.out);
      let pick: { x: Vec2; out: number; cornerAdd: number };
      if (outs.length) {
        pick = outs[0];
        for (const c of outs) if (c.out <= outs[0].out + 220) pick = c;
      } else pick = cands.sort((a, b) => b.out - a.out)[0];
      const sgn = end === 'a' ? -1 : 1;
      ends[ri][end] = { x: pick.x.x + r.u.x * sgn * pick.cornerAdd, y: pick.x.y + r.u.y * sgn * pick.cornerAdd };
    }
  });
  return merged
    .map((r, ri) => ({ a: ends[ri].a, b: ends[ri].b, d: r.d }))
    .filter((r) => Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y) >= 300);
}
