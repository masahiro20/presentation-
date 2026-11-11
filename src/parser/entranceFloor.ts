/**
 * 玄関の区画を、土間（タイル）と、上がり框の先の床（ホール）に分ける。
 *
 * 「ホール」の室名が無い図面や、玄関とホールの間に壁の無い図面では、壁で囲まれた範囲として土間と床がひと続きになり、
 * 区画がまるごと「玄関」になる（市岡様邸: 玄関 5.8 帖。3D では框の先の床まで土間のタイルになり、帖数も合わない）。
 * 框は細い線 1〜2 本で、L 字に回ることもある（堀様邸）ので、框の線そのものを探すのではなく床の描き方の違いを使う:
 *   - 土間はタイルの目地の線で細かく区切られている
 *   - 床（ホール）は線が引かれていない広い面
 * 区画の中を図面の線（実線）で区切り、いちばん広い「線の無い範囲」が、室名（玄関）の無い側にあって十分に広ければ、そこが床。
 * タイルの目地が描かれていない土間（線の無い範囲に「玄関」の文字がある）は分けない。
 */
import type { RoomType, Vec2 } from '../core/types';
import type { Grid } from './raster';

type GridLike = Pick<Grid, 'w' | 'h' | 'res' | 'cellOf'>;

/**
 * ラベル label の区画（玄関）のうち、框の先の床（ホール）にする升の番号を返す。分けないときは null。
 * @param strokes 図面の実線（図面座標 mm）
 * @param names 室名の位置と種類（玄関の文字が床の側にあれば分けない。ホールの文字が床の側にあれば確かな根拠）
 */
export function splitEntranceFloor(grid: GridLike, labels: Int32Array, label: number, strokes: { a: Vec2; b: Vec2 }[], names: { x: number; y: number; type: RoomType | null }[]): number[] | null {
  const { w, h, res } = grid;
  const N = w * h;
  // 区画の範囲
  let i0 = w;
  let j0 = h;
  let i1 = -1;
  let j1 = -1;
  let total = 0;
  for (let k = 0; k < N; k++) {
    if (labels[k] !== label) continue;
    total++;
    const i = k % w;
    const j = (k / w) | 0;
    if (i < i0) i0 = i;
    if (i > i1) i1 = i;
    if (j < j0) j0 = j;
    if (j > j1) j1 = j;
  }
  const m2 = (cells: number) => (cells * res * res) / 1e6;
  // 内法 2.4㎡（1.5 帖）に満たない玄関は土間だけ
  if (total === 0 || m2(total) < 2.4) return null;
  // 線の升
  const line = new Uint8Array(N);
  let lineCells = 0;
  for (const sg of strokes) {
    const L = Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y);
    if (L < 1) continue;
    const [ax, ay] = grid.cellOf(sg.a);
    const [bx, by] = grid.cellOf(sg.b);
    if (Math.max(ax, bx) < i0 || Math.min(ax, bx) > i1 || Math.max(ay, by) < j0 || Math.min(ay, by) > j1) continue;
    const steps = Math.max(1, Math.ceil(L / (res * 0.4)));
    for (let s = 0; s <= steps; s++) {
      const [x, y] = grid.cellOf({ x: sg.a.x + ((sg.b.x - sg.a.x) * s) / steps, y: sg.a.y + ((sg.b.y - sg.a.y) * s) / steps });
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const k = y * w + x;
      if (labels[k] === label && !line[k]) {
        line[k] = 1;
        lineCells++;
      }
    }
  }
  if (!lineCells) return null;
  // 線の無い範囲（4 近傍でつながる升）
  const comp = new Int32Array(N);
  const sizes: number[] = [0];
  const NB = [1, -1, w, -w];
  const ok = (k: number, from: number) => k >= 0 && k < N && !(from % w === 0 && k === from - 1) && !(from % w === w - 1 && k === from + 1);
  for (let k = 0; k < N; k++) {
    if (labels[k] !== label || line[k] || comp[k]) continue;
    const id = sizes.length;
    sizes.push(0);
    const stack = [k];
    comp[k] = id;
    while (stack.length) {
      const c = stack.pop()!;
      sizes[id]++;
      for (const d of NB) {
        const n = c + d;
        if (!ok(n, c) || labels[n] !== label || line[n] || comp[n]) continue;
        comp[n] = id;
        stack.push(n);
      }
    }
  }
  const order = sizes.map((s, id) => ({ id, s })).filter((o) => o.id > 0).sort((a, b) => b.s - a.s);
  if (order.length < 2) return null;
  const H = order[0].id;
  const compAt = (p: Vec2): number => {
    const [x, y] = grid.cellOf(p);
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    const k = y * w + x;
    if (labels[k] !== label) return 0;
    if (comp[k]) return comp[k];
    // 文字の位置が線の上なら、まわり 3 升のいちばん多い範囲
    const cnt = new Map<number, number>();
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const c = comp[yy * w + xx];
        if (c) cnt.set(c, (cnt.get(c) ?? 0) + 1);
      }
    return [...cnt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  };
  const inRegion = names.filter((n) => {
    const [x, y] = grid.cellOf(n);
    return x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === label;
  });
  // 玄関・ホール以外の室名が入った区画（壁の読めなかった大きな区画）は触らない
  if (inRegion.some((n) => n.type && n.type !== 'entrance' && n.type !== 'hall')) return null;
  // 「玄関」の文字が線の無い広い範囲にある = 目地の描かれていない土間
  if (inRegion.some((n) => n.type === 'entrance' && compAt(n) === H)) return null;
  const hallNamed = inRegion.some((n) => n.type === 'hall' && compAt(n) === H);
  // タイルの目地で区切られた小さな範囲（0.04〜1㎡）がいくつもあること
  const tiles = order.filter((o) => o.id !== H && m2(o.s) >= 0.04 && m2(o.s) <= 1.0).length;
  if (m2(sizes[H]) < 1.0 || sizes[H] < order[1].s * 2 || tiles < (hallNamed ? 3 : 5)) return null;

  // 床にする升: いちばん広い範囲と、それに囲まれた小さな範囲（戸の軌跡・家具・引出線で切れた隅）
  const hall = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (comp[k] === H) hall[k] = 1;
  // 小さな範囲ごとに、線を挟んで（3 升以内）床に接する長さと、ほかの範囲に接する長さを数える
  const touchH = new Map<number, number>();
  const touchO = new Map<number, number>();
  for (let k = 0; k < N; k++) {
    const c = comp[k];
    if (!c || c === H) continue;
    const seen = new Set<number>();
    for (const d of NB) {
      let n = k;
      for (let q = 1; q <= 4; q++) {
        const prev = n;
        n += d;
        if (!ok(n, prev) || labels[n] !== label) break;
        if (line[n]) continue;
        if (comp[n] !== c) seen.add(comp[n]);
        break;
      }
    }
    if (seen.has(H)) touchH.set(c, (touchH.get(c) ?? 0) + 1);
    if ([...seen].some((x) => x !== H)) touchO.set(c, (touchO.get(c) ?? 0) + 1);
  }
  const absorbed = new Set<number>();
  for (const o of order) {
    if (o.id === H || m2(o.s) > 1.0) continue;
    const th = touchH.get(o.id) ?? 0;
    const to = touchO.get(o.id) ?? 0;
    if (th > 0 && th >= (th + to) * 0.6) absorbed.add(o.id);
  }
  for (let k = 0; k < N; k++) if (absorbed.has(comp[k])) hall[k] = 1;
  // 線の升: 両側（3 升以内）が床だけなら床（床の中の線）。タイルや区画の外に面する線（框・壁際）は土間の側に残す
  for (let pass = 0; pass < 2; pass++) {
    const add: number[] = [];
    for (let k = 0; k < N; k++) {
      if (labels[k] !== label || !line[k] || hall[k]) continue;
      let hallSide = 0;
      let otherSide = 0;
      for (const d of NB) {
        let n = k;
        for (let q = 1; q <= 3; q++) {
          const prev = n;
          n += d;
          if (!ok(n, prev) || labels[n] !== label) break;
          if (line[n] && !hall[n]) continue;
          if (hall[n]) hallSide++;
          else otherSide++;
          break;
        }
      }
      if (hallSide >= 2 && otherSide === 0) add.push(k);
    }
    for (const k of add) hall[k] = 1;
  }
  // 輪郭を整える: 10cm までの切れ込み（家具・線の跡）を埋め、6cm までのひげを落とす。区画の外（壁）は床の続きとして扱う
  const inR = (k: number) => labels[k] === label;
  const step = (src: Uint8Array, grow: boolean): Uint8Array => {
    const dst = Uint8Array.from(src);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * w + i;
        if (!inR(k) || !!src[k] === grow) continue;
        // grow: 隣に床があれば床に。shrink: 隣に（区画の中の）床でない升があれば床でなくする
        // 8 近傍（四角い当て方: 角を斜めに削らない）
        let hit = false;
        for (let dj = -1; dj <= 1 && !hit; dj++)
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
            const n = jj * w + ii;
            if (grow ? src[n] === 1 : inR(n) && !src[n]) {
              hit = true;
              break;
            }
          }
        if (hit) dst[k] = grow ? 1 : 0;
      }
    return dst;
  };
  const morph = (src: Uint8Array, grow: boolean, n: number) => {
    let m = src;
    for (let q = 0; q < n; q++) m = step(m, grow);
    return m;
  };
  let smooth = morph(morph(hall, true, 5), false, 5);
  smooth = morph(morph(smooth, false, 3), true, 3);
  const out: number[] = [];
  for (let k = 0; k < N; k++) if (smooth[k] && inR(k)) out.push(k);
  if (m2(out.length) < 1.0) return null;
  // 残り（土間）が 1㎡ に満たないなら分けない
  if (m2(total - out.length) < 1.0) return null;
  return out;
}
