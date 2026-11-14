/**
 * 階段（踏面の平行線の繰り返し）の検出
 */
import type { Vec2 } from '../core/types';
import type { Seg } from './walls';

export interface StairCandidate {
  /** 軸平行な矩形 */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  treadCount: number;
  /** 踏面線の向き（踏面線が水平 → 'h'） */
  treadOrient: 'h' | 'v';
  flights: number;
  /** いちばん長い段の線の長さ（＝段の幅） */
  treadLen?: number;
  /** 段の向きが混ざっている（かね折れ・回り階段。昇り口の辺を段の向きから決められない） */
  mixed?: boolean;
  /** 歩行線の位置（'columns' = 左右の列にそれぞれ = 折り返し、'center' = 中央だけ = 幅の広い直階段） */
  walk?: 'center' | 'columns';
  /** 段の線の間隔（mm。等間隔の並びの平均 = 図面の踏面） */
  pitch?: number;
  /** まとめた列（段の線の等間隔の並び）ごとの範囲・向き・本数 */
  runs?: StairRunBox[];
}

/** 段の線の並び 1 つ（列）: 範囲（線の両端〜最初と最後の線）・線の向き・本数 */
export interface StairRunBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  orient: 'h' | 'v';
  n: number;
  /**
   * 列の線にいちばん多い両端の位置（線の長さの向き。h の列なら x、v の列なら y の [小, 大]）= 段の線の本来の幅。
   * ひな壇の台の縁など、段の線より長い線が同じ間隔で混ざると、範囲（minX…）は長い線まで膨らむ（吉田様邸 1st PLAN）。
   * 範囲が列の幅として長すぎるときにだけ、こちらで見る
   */
  core?: [number, number];
}

interface Tread {
  o: number;
  t0: number;
  t1: number;
  orient: 'h' | 'v';
  /** 2 本をまとめた線（3 本目はつながない） */
  joined?: boolean;
}

export function detectStairs(segs: Seg[], within: { minX: number; minY: number; maxX: number; maxY: number }): StairCandidate[] {
  const treads: Tread[] = [];
  for (const s of segs) {
    if (s.dashed) continue;
    const dx = s.b.x - s.a.x;
    const dy = s.b.y - s.a.y;
    const L = Math.hypot(dx, dy);
    if (L < 450 || L > 1600) continue;
    const mx = (s.a.x + s.b.x) / 2;
    const my = (s.a.y + s.b.y) / 2;
    if (mx < within.minX || mx > within.maxX || my < within.minY || my > within.maxY) continue;
    if (Math.abs(dy) < L * 0.01) treads.push({ o: my, t0: Math.min(s.a.x, s.b.x), t1: Math.max(s.a.x, s.b.x), orient: 'h' });
    else if (Math.abs(dx) < L * 0.01) treads.push({ o: mx, t0: Math.min(s.a.y, s.b.y), t1: Math.max(s.a.y, s.b.y), orient: 'v' });
  }
  // 同じ直線上で端が接する段の線は 1 本にする。幅の広い直階段は、段の線が中央の矢印の線で 2 つに分かれて描かれ、
  // そのままだと「2 列の段」＝折り返し階段に見える（池本様邸: 幅 1.8m・5 段の直階段）。
  // 折り返し階段の 2 列は中壁の厚み（60mm 以上）だけ離れているので、つながらない
  {
    treads.sort((a, b) => (a.orient === b.orient ? a.o - b.o || a.t0 - b.t0 : a.orient < b.orient ? -1 : 1));
    // 重なって 2 重に描かれた段の線（線と塗りの輪郭）は 1 本に（同じ並びが 2 つできて、折り返しの「対の列」に見えていた: 有元様邸）
    // 同じ位置で一方が他方に含まれる線（段の線と、内側の手すり間の線: 舟橋様邸 804 と 565）も、長いほうだけ残す
    const drop = new Set<Tread>();
    for (let i = 0; i < treads.length; i++) {
      const a = treads[i];
      if (drop.has(a)) continue;
      for (let j = i + 1; j < treads.length; j++) {
        const t = treads[j];
        if (t.orient !== a.orient || t.o - a.o >= 3) break;
        if (drop.has(t)) continue;
        if (a.t0 <= t.t0 + 20 && a.t1 >= t.t1 - 20) drop.add(t);
        else if (t.t0 <= a.t0 + 20 && t.t1 >= a.t1 - 20) {
          drop.add(a);
          break;
        }
      }
    }
    if (drop.size) {
      const kept = treads.filter((t) => !drop.has(t));
      treads.length = 0;
      treads.push(...kept);
    }
    const merged: Tread[] = [];
    for (const t of treads) {
      const last = merged[merged.length - 1];
      // まとめるのは、ほぼ同じ長さ（短いほうが長いほうの 6 割以上）の 2 本がぴったり接するときだけ（中央の歩行線・中壁で分かれた段）。
      // 詳細図は段の線が細かく分かれて描かれ、何でもまとめると段の並びが崩れた（田添様邸 1 階の階段が消えた）。
      // まとめた長さが 2m を超えるものもまとめない（手すりの線 1 本で接する 2 本の階段: 有元様邸 2 階の 13 段と 14 段）
      const la = last ? last.t1 - last.t0 : 0;
      const lb = t.t1 - t.t0;
      if (last && !last.joined && last.orient === t.orient && Math.abs(last.o - t.o) < 2 && Math.abs(t.t0 - last.t1) < 40 && Math.min(la, lb) >= Math.max(la, lb) * 0.6 && Math.max(last.t1, t.t1) - last.t0 <= 2000) {
        last.t1 = Math.max(last.t1, t.t1);
        last.joined = true;
      } else merged.push({ ...t });
    }
    treads.length = 0;
    treads.push(...merged);
  }
  // 同じ区間を持つ線の等間隔の並びを探す
  const runs: { orient: 'h' | 'v'; items: Tread[] }[] = [];
  // 3 本だけの並び: それだけでは階段にしないが、隣に同じ間隔の列があれば折り返しのもう 1 列
  // （上の段は切断線で途切れ、下の列は 3 本しか描かれないことがある: 舟橋様邸 1 階）
  const weak: { orient: 'h' | 'v'; items: Tread[] }[] = [];
  for (const orient of ['h', 'v'] as const) {
    const ts = treads.filter((t) => t.orient === orient).sort((a, b) => a.o - b.o);
    const used = new Set<Tread>();
    for (const t of ts) {
      if (used.has(t)) continue;
      const chain = [t];
      let last = t;
      for (const c of ts) {
        if (c.o <= last.o + 1) continue;
        const sp = c.o - last.o;
        if (sp > 330) break;
        if (sp < 150) continue;
        const ov = Math.min(c.t1, last.t1) - Math.max(c.t0, last.t0);
        if (ov < Math.min(c.t1 - c.t0, last.t1 - last.t0) * 0.8) continue;
        // 等間隔性
        if (chain.length >= 2) {
          const prevSp = chain[chain.length - 1].o - chain[chain.length - 2].o;
          if (Math.abs(sp - prevSp) > 25) continue;
        }
        chain.push(c);
        last = c;
      }
      if (chain.length >= 4) {
        chain.forEach((c) => used.add(c));
        runs.push({ orient, items: chain });
      } else if (chain.length === 3) weak.push({ orient, items: chain });
    }
  }
  // 近接する並びを1つの階段にまとめる
  const boxOf = (r: { orient: 'h' | 'v'; items: Tread[] }) => {
    const os = r.items.map((i) => i.o);
    const t0 = Math.min(...r.items.map((i) => i.t0));
    const t1 = Math.max(...r.items.map((i) => i.t1));
    const pitch = (Math.max(...os) - Math.min(...os)) / Math.max(1, r.items.length - 1);
    const treadLen = t1 - t0;
    // 列の線にいちばん多い両端の位置（30mm 以内を同じ位置と見る。同数なら内側）= 列の幅。
    // 長い線（ひな壇の台の縁）や短い線（切断線で切れた段・手すりの間の線）が混ざっても、段の線の本来の幅が残る
    const modeOf = (vals: number[], inner: 'max' | 'min') => {
      let best = vals[0];
      let bestN = 0;
      for (const v of vals) {
        const n = vals.filter((x) => Math.abs(x - v) <= 30).length;
        if (n > bestN || (n === bestN && (inner === 'max' ? v > best : v < best))) {
          best = v;
          bestN = n;
        }
      }
      return best;
    };
    const c0 = modeOf(r.items.map((i) => i.t0), 'max');
    const c1 = modeOf(r.items.map((i) => i.t1), 'min');
    const core: [number, number] = c1 - c0 >= 400 ? [c0, c1] : [t0, t1];
    return r.orient === 'h'
      ? { minX: t0, maxX: t1, minY: Math.min(...os), maxY: Math.max(...os), n: r.items.length, orient: r.orient, pitch, treadLen, core }
      : { minX: Math.min(...os), maxX: Math.max(...os), minY: t0, maxY: t1, n: r.items.length, orient: r.orient, pitch, treadLen, core };
  };
  // 玄関・土間のタイル目地は階段ではない（舟橋様邸: 玄関の 300 角タイルが段として読まれ、階段の範囲が玄関に広がった）
  const boxes = runs.map(boxOf).filter((b) => !isTileGrid(b, segs));
  // 3 本の並びのうち、4 本以上の列の横に並ぶもの（同じ向き・同じ間隔・列の範囲が半分以上重なる・すき間 350 未満）
  for (const w of weak.map(boxOf)) {
    if (isTileGrid(w, segs)) continue;
    const beside = boxes.some((b) => {
      if (b.orient !== w.orient || b.n < 4 || Math.abs(b.pitch - w.pitch) > 25) return false;
      const h = w.orient === 'h';
      const ov = h ? Math.min(b.maxY, w.maxY) - Math.max(b.minY, w.minY) : Math.min(b.maxX, w.maxX) - Math.max(b.minX, w.minX);
      const wl = h ? w.maxY - w.minY : w.maxX - w.minX;
      const gap = h ? Math.max(0, w.minX - b.maxX, b.minX - w.maxX) : Math.max(0, w.minY - b.maxY, b.minY - w.maxY);
      return ov >= wl * 0.5 && gap < 350;
    });
    if (beside) boxes.push(w);
  }
  const dbgBoxes = (globalThis as { __stairBoxes?: unknown[] }).__stairBoxes;
  if (dbgBoxes) for (const b of boxes) dbgBoxes.push({ ...b, kind: weak.some((w) => boxOf(w).minX === b.minX && boxOf(w).minY === b.minY && boxOf(w).n === b.n) ? 'weak' : 'run' });
  const out: StairCandidate[] = [];
  const used = new Set<number>();
  // 対の列: 同じ向き・段の並ぶ範囲がほぼ同じ（両端の差は段 1 つ分 250 まで）・段の間隔が同じ・すき間 350 未満で、お互いに一番の相手。
  // 折り返し階段の往復の 2 列。手すり 1 本を挟んで並ぶ 2 つの折り返し階段（有元様邸 2 階）は列のすき間がどれも同じなので、
  // 並びの範囲（段の数）が同じものどうしを先に組む
  const runStart = (a: (typeof boxes)[number]) => (a.orient === 'h' ? a.minY : a.minX);
  const runEnd = (a: (typeof boxes)[number]) => (a.orient === 'h' ? a.maxY : a.maxX);
  const twinScore = (a: (typeof boxes)[number], c: (typeof boxes)[number]) => {
    if (a === c || a.orient !== c.orient || Math.abs(a.pitch - c.pitch) > 25) return Infinity;
    const gapX = Math.max(0, c.minX - a.maxX, a.minX - c.maxX);
    const gapY = Math.max(0, c.minY - a.maxY, a.minY - c.maxY);
    if (gapX >= 350 || gapY >= 350) return Infinity;
    const d0 = Math.abs(runStart(a) - runStart(c));
    const d1 = Math.abs(runEnd(a) - runEnd(c));
    return d0 <= 250 && d1 <= 250 ? d0 + d1 : Infinity;
  };
  const best = boxes.map((a) => {
    let bi = -1;
    let bs = Infinity;
    boxes.forEach((c, j) => {
      const sc = twinScore(a, c);
      if (sc < bs) {
        bs = sc;
        bi = j;
      }
    });
    return bi;
  });
  const pairOf = best.map((j, i) => (j >= 0 && best[j] === i ? j : -1));
  boxes.forEach((b, i) => {
    if (used.has(i)) return;
    const merged = { ...b, flights: 1, mixed: false };
    const members = [b];
    used.add(i);
    const absorb = (c: (typeof boxes)[number], j: number) => {
      merged.minX = Math.min(merged.minX, c.minX);
      merged.minY = Math.min(merged.minY, c.minY);
      merged.maxX = Math.max(merged.maxX, c.maxX);
      merged.maxY = Math.max(merged.maxY, c.maxY);
      merged.n += c.n;
      merged.flights++;
      merged.treadLen = Math.max(merged.treadLen, c.treadLen);
      if (c.orient !== merged.orient) merged.mixed = true;
      members.push(c);
      used.add(j);
    };
    // 対の列があれば最初に組む
    if (pairOf[i] >= 0 && !used.has(pairOf[i])) absorb(boxes[pairOf[i]], pairOf[i]);
    const paired = members.length === 2;
    boxes.forEach((c, j) => {
      if (used.has(j)) return;
      const gapX = Math.max(0, c.minX - merged.maxX, merged.minX - c.maxX);
      const gapY = Math.max(0, c.minY - merged.maxY, merged.minY - c.maxY);
      if (gapX >= 350 || gapY >= 350) return;
      // 1 つの階段は踏面がそろう: 段の間隔が 40mm 以上違う並びは別のもの（有元様邸 2 階: 286 間隔の線が 2 つの階段をつないでいた）
      if (Math.abs(c.pitch - b.pitch) > 40) return;
      // 対の列（往復の 2 列）がそろった階段に、同じ向きのもう 1 つの対は入れない（隣の別の折り返し階段）
      if (paired && pairOf[j] >= 0 && c.orient === b.orient) return;
      absorb(c, j);
    });
    const walk = merged.mixed ? undefined : walkLineKind(merged, segs);
    out.push({
      minX: merged.minX,
      minY: merged.minY,
      maxX: merged.maxX,
      maxY: merged.maxY,
      treadCount: merged.n,
      treadOrient: merged.orient,
      flights: merged.flights,
      treadLen: merged.treadLen,
      ...(merged.mixed ? { mixed: true } : {}),
      ...(walk ? { walk } : {}),
      ...(b.pitch >= 150 && b.pitch <= 330 ? { pitch: b.pitch } : {}),
      runs: members.map((m) => ({ minX: m.minX, minY: m.minY, maxX: m.maxX, maxY: m.maxY, orient: m.orient, n: m.n, core: m.core })),
    });
  });
  return out;
}

/** コの字階段（3 方回り）の形: 奥の辺・列の幅・脇の列が見えている端・角の段数 */
export interface WrapShape {
  /** 奥の列が沿っている辺（昇り口はその反対の辺） */
  back: Side;
  /** 列の幅（角の升の大きさ。mm） */
  fw: number;
  /** 奥の列の長さ（段の線の並びの範囲。mm） */
  mid: number;
  /** この階の図で脇の列（段の線）が見えている端: lo = 座標の小さい側、hi = 大きい側。脇の列が無い・見えないなら null */
  sideEnd: 'lo' | 'hi' | null;
  /** 脇の列を取れない奥行（奥の列の両端の角で直角に出入りする形） */
  flat: boolean;
  /** 角 1 つの段数（角の升の中の斜めの線から）: 斜めの線なし = 1（踊り場）、1 方向 = 2、2 方向 = 3 */
  cornerSteps: 1 | 2 | 3;
  /**
   * 昇り口の広い段（ひな壇）の読み取り。最初の列がどちらの端かで分けて持つ（lo = 座標の小さい側の壁から始まる線、hi = 大きい側）。
   *  n = 段数（0 = 無し）: 脇の列の帯を、壁から列の幅より長く横切る線の数 ＋ 1。
   *      図面では、段ごとの台が「奥の壁から手前の縁まで」の入れ子の四角で描かれ、手前の縁が段の間隔で並ぶ
   *  shape: full = どの線も階段室の幅いっぱい／corner = 奥へ行くほど 1 段ぶんずつ短くなる（角から 2 方向に下りる）
   */
  wide: Record<'lo' | 'hi', { n: number; shape: 'full' | 'corner' }>;
  /**
   * 吹抜の側が腰壁か: 奥の列の吹抜側の縁の先（60〜240）に、列に沿う線が 2 本、60〜140 離れて通っている（壁の厚みの二重線）。
   * 細い手すり（アイアン・ガラス）は 1 本か、30 以内の二重線で描かれる
   */
  guardWall: boolean;
}

/**
 * 候補の列と、壁まで広げた範囲 r から「コの字階段（3 方回り）」を見分ける。
 *  - 奥の辺に沿う列（P）: 段の線が奥の辺に直交し、線の長さ（列の幅）600〜1,100。
 *    列の両端と範囲の端との間に、角の升（550〜1,250）が 1 つずつ残る。
 *    （かね折れは片方の端まで列が続く。折り返しは列が奥の辺に沿わない）
 *  - 奥行に余裕がある（脇の列を取れる）ときは、角の升の手前に、P と直交する向きの列（脇の列）が 1 つ以上あること
 * 御社の図面: 1.5 間 × 1 間の階段室を、左 4 段 → 角（斜めの線 = 回り段）→ 奥 4 段 → 角 → 右 4 段と回る。
 * 1 階の図は切断線より下（最初の脇の列と奥の列）だけ、2 階の図は奥の列と最後の脇の列だけが描かれる
 */
export function wrapShape(runs: StairRunBox[], r: { minX: number; minY: number; maxX: number; maxY: number }, segs: Seg[]): WrapShape | null {
  let bestShape: WrapShape | null = null;
  let bestN = 0;
  for (const P of runs) {
    if (P.n < 4) continue;
    const alongX = P.orient === 'v'; // 段の線が縦 = 列は横（x の向き）に進む
    // 列の幅: 範囲が列の幅として長すぎる（1,100 超）ときは、段の線の本来の幅（core）で見る
    // （ひな壇の台の縁が混ざった列は、範囲が長い線まで膨らんでいる）
    const bLo = alongX ? P.minY : P.minX;
    const bHi = alongX ? P.maxY : P.maxX;
    const useCore = bHi - bLo > 1100 && !!P.core;
    const pLo = useCore ? P.core![0] : bLo;
    const pHi = useCore ? P.core![1] : bHi;
    const treadLen = pHi - pLo;
    if (treadLen < 600 || treadLen > 1100) continue;
    const lo = alongX ? P.minX - r.minX : P.minY - r.minY;
    const hi = alongX ? r.maxX - P.maxX : r.maxY - P.maxY;
    if (lo < 550 || lo > 1250 || hi < 550 || hi > 1250) continue;
    const dNear = pLo - (alongX ? r.minY : r.minX);
    const dFar = (alongX ? r.maxY : r.maxX) - pHi;
    const depth = alongX ? r.maxY - r.minY : r.maxX - r.minX;
    const fw = Math.round(Math.min(1000, Math.max(700, (lo + hi) / 2)));
    const flat = depth - fw < 400;
    for (const nearSide of [true, false]) {
      if ((nearSide ? dNear : dFar) > 220) continue;
      const back: Side = alongX ? (nearSide ? 'n' : 's') : nearSide ? 'w' : 'e';
      let sideEnd: 'lo' | 'hi' | null = null;
      let noSideRun = false;
      if (!flat) {
        // 脇の列: P と直交する向きの列で、角の升の手前（奥の帯の外）・端の列の中。列の幅は、どの線にも共通する範囲
        let seenLo = false;
        let seenHi = false;
        for (const S of runs) {
          if (S === P || S.orient === P.orient || S.n < 3) continue;
          const sNear = alongX ? S.minY - r.minY : S.minX - r.minX;
          const sFar = alongX ? r.maxY - S.maxY : r.maxX - S.maxX;
          if ((nearSide ? sNear : sFar) < fw - 220) continue;
          // 端の列の中にあるか。範囲で外れたら、段の線の本来の幅（core）でもう一度（台の縁が混ざって膨らんだ列）
          const within = (a0: number, a1: number): 'lo' | 'hi' | null => (a1 - (alongX ? r.minX : r.minY) <= fw + 220 ? 'lo' : (alongX ? r.maxX : r.maxY) - a0 <= fw + 220 ? 'hi' : null);
          const end = within(alongX ? S.minX : S.minY, alongX ? S.maxX : S.maxY) ?? (S.core ? within(S.core[0], S.core[1]) : null);
          if (end === 'lo') seenLo = true;
          else if (end === 'hi') seenHi = true;
        }
        // 脇の列が列として読めない（2 段だけなど）ときは、角の升の斜めの線（回り段）があれば コの字（下で確かめる）
        if (!seenLo && !seenHi) sideEnd = null;
        // 両方の脇の列が見えている図（切断線の上の列も描いてある）は、どちらが最初の列かを図形からは決めない（文字の位置で決める）
        else sideEnd = seenLo && seenHi ? null : seenLo ? 'lo' : 'hi';
        noSideRun = !seenLo && !seenHi;
      }
      // 角の升の中の斜めの線（回り段）
      const sq = (end: 'lo' | 'hi') => {
        const a0 = end === 'lo' ? (alongX ? r.minX : r.minY) : (alongX ? r.maxX : r.maxY) - fw;
        const b0 = nearSide ? (alongX ? r.minY : r.minX) : (alongX ? r.maxY : r.maxX) - Math.min(fw, depth);
        return alongX ? { minX: a0, maxX: a0 + fw, minY: b0, maxY: b0 + Math.min(fw, depth) } : { minX: b0, maxX: b0 + Math.min(fw, depth), minY: a0, maxY: a0 + fw };
      };
      const diagDirs = (q: { minX: number; minY: number; maxX: number; maxY: number }) => {
        const angs: number[] = [];
        for (const sg of segs) {
          if (sg.dashed) continue;
          const dx = sg.b.x - sg.a.x;
          const dy = sg.b.y - sg.a.y;
          const L = Math.hypot(dx, dy);
          if (L < 300) continue;
          const mx = (sg.a.x + sg.b.x) / 2;
          const my = (sg.a.y + sg.b.y) / 2;
          if (mx < q.minX - 60 || mx > q.maxX + 60 || my < q.minY - 60 || my > q.maxY + 60) continue;
          // 軸からの角度（0〜90°）
          const ang = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
          if (ang < 18 || ang > 72) continue;
          if (!angs.some((x) => Math.abs(x - ang) < 10)) angs.push(ang);
        }
        return angs.length;
      };
      const nd = Math.max(diagDirs(sq('lo')), diagDirs(sq('hi')));
      // 脇の列も、角の升の回り段の線も無い形は、コの字と決めない
      if (noSideRun && nd === 0) continue;
      // 昇り口の広い段（ひな壇）: 奥の帯の手前（脇の列の帯）を横切る線で、脇の列のある側の壁から始まり、列の幅より長いもの。
      // 昇り口の縁（範囲の端）の線は数えない（部屋の境の線と区別できない）。線の位置が、昇り口の縁から段の間隔（150〜330）で並ぶときだけ。
      //  - どの線も階段室の幅いっぱい → full（入れ子の四角がどれも幅いっぱい）
      //  - 奥へ行くほど 1 段ぶん（150〜330）ずつ短くなる → corner（角から 2 方向に下りるひな壇。いちばん奥の線は列の幅 = ふつうの段の線と同じ長さ）
      const wideOf = (end: 'lo' | 'hi'): { n: number; shape: 'full' | 'corner' } => {
        const none = { n: 0, shape: 'full' as const };
        if (flat) return none;
        const width = alongX ? r.maxX - r.minX : r.maxY - r.minY;
        // 最初の列の側の壁の位置（列に沿う向きの座標）
        const wallAt = end === 'lo' ? (alongX ? r.minX : r.minY) : alongX ? r.maxX : r.maxY;
        const byPos: { pos: number; len: number }[] = [];
        for (const sg of segs) {
          if (sg.dashed) continue;
          const along = alongX ? Math.abs(sg.b.x - sg.a.x) : Math.abs(sg.b.y - sg.a.y);
          const across = alongX ? Math.abs(sg.b.y - sg.a.y) : Math.abs(sg.b.x - sg.a.x);
          if (across > 3 || along < fw - 60 || along > width + 250) continue;
          const e0 = alongX ? Math.min(sg.a.x, sg.b.x) : Math.min(sg.a.y, sg.b.y);
          const e1 = alongX ? Math.max(sg.a.x, sg.b.x) : Math.max(sg.a.y, sg.b.y);
          if (Math.abs((end === 'lo' ? e0 : e1) - wallAt) > 120) continue;
          const c = alongX ? (sg.a.y + sg.b.y) / 2 : (sg.a.x + sg.b.x) / 2;
          const fromBack = nearSide ? c - (alongX ? r.minY : r.minX) : (alongX ? r.maxY : r.maxX) - c;
          if (fromBack < fw + 100 || fromBack > depth - 80) continue;
          const hit = byPos.find((q) => Math.abs(q.pos - fromBack) < 40);
          if (hit) hit.len = Math.max(hit.len, along);
          else byPos.push({ pos: fromBack, len: along });
        }
        // 昇り口の縁（depth）から奥へ、段の間隔で並ぶ所まで
        byPos.sort((a, b) => b.pos - a.pos);
        let prev = depth;
        const rows: { pos: number; len: number }[] = [];
        for (const q of byPos) {
          if (prev - q.pos < 150 || prev - q.pos > 330) break;
          rows.push(q);
          prev = q.pos;
        }
        // いちばん手前の線が、列の幅より長いこと（ふつうの段の線は列の幅）
        if (!rows.length || rows[0].len < fw + 150) return none;
        if (rows.every((q) => q.len >= width * 0.85)) return { n: rows.length + 1, shape: 'full' };
        // corner: 幅いっぱいでない線が、奥へ 1 段ぶんずつ短くなり、最後は列の幅
        const stag: number[] = [];
        for (const q of rows) {
          if (q.len >= width * 0.85 && !stag.length) continue; // 手前の幅いっぱいの線（1 段目と同じ大きさの台）は飛ばす
          if (stag.length && (stag[stag.length - 1] - q.len < 150 || stag[stag.length - 1] - q.len > 330)) break;
          stag.push(q.len);
        }
        if (stag.length >= 2 && Math.abs(stag[stag.length - 1] - fw) <= 160) return { n: stag.length + 1, shape: 'corner' };
        // 幅いっぱいの線だけを数える
        let full = 0;
        for (const q of rows) {
          if (q.len < width * 0.85) break;
          full++;
        }
        return full ? { n: full + 1, shape: 'full' } : none;
      };
      // 吹抜を囲む腰壁: 奥の列の、段の線の吹抜側の端（edge）の先に、列に沿う長い線（列の長さの 7 割以上）の位置を集める
      const guardWall = ((): boolean => {
        if (flat) return false;
        const edge = nearSide ? pHi : pLo;
        const sign = nearSide ? 1 : -1;
        const runLen = alongX ? P.maxX - P.minX : P.maxY - P.minY;
        const r0 = alongX ? P.minX : P.minY;
        const r1 = alongX ? P.maxX : P.maxY;
        const offs: number[] = [];
        for (const sg of segs) {
          if (sg.dashed) continue;
          const along = alongX ? Math.abs(sg.b.x - sg.a.x) : Math.abs(sg.b.y - sg.a.y);
          const across = alongX ? Math.abs(sg.b.y - sg.a.y) : Math.abs(sg.b.x - sg.a.x);
          if (across > 3 || along < runLen * 0.7) continue;
          const e0 = alongX ? Math.min(sg.a.x, sg.b.x) : Math.min(sg.a.y, sg.b.y);
          const e1 = alongX ? Math.max(sg.a.x, sg.b.x) : Math.max(sg.a.y, sg.b.y);
          if (Math.min(e1, r1) - Math.max(e0, r0) < runLen * 0.7) continue;
          const c = alongX ? (sg.a.y + sg.b.y) / 2 : (sg.a.x + sg.b.x) / 2;
          const off = (c - edge) * sign;
          if (off < -10 || off > 260) continue;
          if (!offs.some((o) => Math.abs(o - off) < 8)) offs.push(off);
        }
        offs.sort((a, b) => a - b);
        for (let i = 0; i < offs.length; i++) for (let j = i + 1; j < offs.length; j++) if (offs[j] - offs[i] >= 60 && offs[j] - offs[i] <= 140 && offs[j] >= 60) return true;
        return false;
      })();
      const shape: WrapShape = { back, fw, mid: alongX ? P.maxX - P.minX : P.maxY - P.minY, sideEnd, flat, cornerSteps: nd >= 2 ? 3 : nd === 1 ? 2 : 1, wide: { lo: wideOf('lo'), hi: wideOf('hi') }, guardWall };
      if (P.n > bestN) {
        bestN = P.n;
        bestShape = shape;
      }
    }
  }
  return bestShape;
}

/**
 * 1 列だけの候補（奥の列）の両端の先に「回り段の升」があるかを見る（コの字の 3 方回りで、脇の列が 2 段ほどしか無い形）。
 * r = 列の範囲、alongX = 列が横（x の向き）に進む、dLo / dHi = 列の両端から壁までの距離（升の大きさ。呼ぶ側が壁を探す）。
 *  - diag: どちらかの升（列の端〜壁 × 列の幅）に、斜めの線（長さ 500 以上・25〜65°）がある = 回り段
 *  - side / sideLen: 升の先へ続く脇の列（升の列の中の、列と同じ向きに並ぶ段の線。段の間隔 150〜330）のある側と、
 *    列の縁から昇り口の縁までの長さ。脇の列に沿う線（側桁・歩行線）が最後の段の線より先へ伸びていれば、そこまで
 * 御社の図面（林様邸）: 2 間 × 0.75 間に、左 2 段 → 回り段 → 奥 8 段 → 回り段 → 右 2 段。脇の列は線が 2〜3 本で列にならず、
 * 奥の列だけが直階段と読まれていた
 */
export function cornerSquares(
  r: { minX: number; minY: number; maxX: number; maxY: number },
  alongX: boolean,
  dLo: number,
  dHi: number,
  segs: Seg[],
): { diag: boolean; side: 'n' | 's' | 'e' | 'w' | null; sideLen: number } {
  // 列に沿う向き（a）と幅の向き（c）の座標で見る
  const a0 = alongX ? r.minX : r.minY;
  const a1 = alongX ? r.maxX : r.maxY;
  const c0 = alongX ? r.minY : r.minX;
  const c1 = alongX ? r.maxY : r.maxX;
  const A = (p: Vec2) => (alongX ? p.x : p.y);
  const C = (p: Vec2) => (alongX ? p.y : p.x);
  const cols: [number, number][] = [
    [a0 - dLo, a0],
    [a1, a1 + dHi],
  ];
  let diag = false;
  // 升の先の段の線: 幅の向きの位置ごと（手前 = c0 より小さい側 / c1 より大きい側）
  const below: number[] = [];
  const above: number[] = [];
  const alongLines: { lo: number; hi: number }[] = [];
  for (const sg of segs) {
    if (sg.dashed) continue;
    const dx = sg.b.x - sg.a.x;
    const dy = sg.b.y - sg.a.y;
    const L = Math.hypot(dx, dy);
    if (L < 150) continue;
    const ma = (A(sg.a) + A(sg.b)) / 2;
    const col = cols.find(([lo, hi]) => ma > lo - 60 && ma < hi + 60);
    if (!col) continue;
    const da = Math.abs(A(sg.b) - A(sg.a));
    const dc = Math.abs(C(sg.b) - C(sg.a));
    const ang = (Math.atan2(Math.min(da, dc), Math.max(da, dc)) * 180) / Math.PI;
    const mc = (C(sg.a) + C(sg.b)) / 2;
    if (ang >= 25 && L >= 500) {
      // 斜めの線: 升（列の幅の中）にある
      if (mc > c0 - 100 && mc < c1 + 100 && Math.min(A(sg.a), A(sg.b)) > col[0] - 100 && Math.max(A(sg.a), A(sg.b)) < col[1] + 100) diag = true;
      continue;
    }
    if (ang > 2) continue;
    if (dc < 3 && da >= 400 && da <= 1100 && Math.min(A(sg.a), A(sg.b)) > col[0] - 80 && Math.max(A(sg.a), A(sg.b)) < col[1] + 80) {
      // 列と同じ向きの線（脇の列の段の線）
      if (mc > c1 + 60) above.push(mc);
      else if (mc < c0 - 60) below.push(mc);
    } else if (da < 3 && dc >= 150) alongLines.push({ lo: Math.min(C(sg.a), C(sg.b)), hi: Math.max(C(sg.a), C(sg.b)) });
  }
  /** 列の縁（edge）から外へ、段の間隔で並ぶ線の最後の位置までの長さ（最初の線は縁から 450 以内） */
  const chain = (vals: number[], edge: number, sign: 1 | -1): number => {
    const ds = [...new Set(vals.map((v) => Math.round((v - edge) * sign)))].filter((d) => d > 0).sort((p, q) => p - q);
    let last = 0;
    let n = 0;
    for (const d of ds) {
      if (d - last < 40) continue;
      if (n === 0 ? d > 450 : d - last < 150 || d - last > 330) break;
      last = d;
      n++;
    }
    if (!n) return 0;
    // 脇の列に沿う線（側桁・歩行線）が、最後の段の線より先へ 80〜330 伸びていれば、そこまで
    let end = last;
    for (const ln of alongLines) {
      const from = sign > 0 ? ln.lo - edge : edge - ln.hi;
      const to = sign > 0 ? ln.hi - edge : edge - ln.lo;
      if (from <= last + 20 && to >= last + 80 && to <= last + 330) end = Math.max(end, to);
    }
    return end;
  };
  const lenAbove = chain(above, c1, 1);
  const lenBelow = chain(below, c0, -1);
  if (!lenAbove && !lenBelow) return { diag, side: null, sideLen: 0 };
  const up = lenAbove >= lenBelow;
  return { diag, side: alongX ? (up ? 's' : 'n') : up ? 'e' : 'w', sideLen: up ? lenAbove : lenBelow };
}

/**
 * 等間隔の線の並びが「格子（タイル目地）」か: 並びに直交する線が、段の幅を 150〜480mm のほぼ同じ間隔で 3 つ以上に割っている。
 * 階段の中を通る直交の線は、矢印の軸（中央に 1 本）と手すり（端から 100mm 以内）なので、等間隔には割らない。
 */
export function isTileGrid(b: { minX: number; minY: number; maxX: number; maxY: number; orient: 'h' | 'v'; pitch?: number }, segs: Seg[]): boolean {
  const h = b.orient === 'h';
  // 並びの方向（段が積み重なる向き）の範囲と、段の幅の範囲
  const run0 = h ? b.minY : b.minX;
  const run1 = h ? b.maxY : b.maxX;
  const span0 = h ? b.minX : b.minY;
  const span1 = h ? b.maxX : b.maxY;
  const runLen = run1 - run0;
  if (runLen < 300 || span1 - span0 < 450) return false;
  // 直交する線は文字（「玄関」など）の所で途切れるので、同じ位置の線の長さを足して並びの半分以上を通るものを数える
  const cover = new Map<number, [number, number][]>();
  for (const s of segs) {
    if (s.dashed || s.source === 'fill') continue;
    const dx = s.b.x - s.a.x;
    const dy = s.b.y - s.a.y;
    const L = Math.hypot(dx, dy);
    if (L < 150) continue;
    // 並びの方向に走る線（段が水平なら縦の線）
    if (h ? Math.abs(dx) > L * 0.01 : Math.abs(dy) > L * 0.01) continue;
    const pos = h ? (s.a.x + s.b.x) / 2 : (s.a.y + s.b.y) / 2;
    if (pos <= span0 + 60 || pos >= span1 - 60) continue;
    const a0 = Math.max(run0, h ? Math.min(s.a.y, s.b.y) : Math.min(s.a.x, s.b.x));
    const a1 = Math.min(run1, h ? Math.max(s.a.y, s.b.y) : Math.max(s.a.x, s.b.x));
    if (a1 - a0 < 100) continue;
    const key = Math.round(pos / 20);
    const list = cover.get(key) ?? cover.get(key - 1) ?? cover.get(key + 1) ?? [];
    list.push([a0, a1]);
    if (!cover.has(key) && !cover.has(key - 1) && !cover.has(key + 1)) cover.set(key, list);
  }
  const inner: number[] = [];
  for (const [key, list] of [...cover.entries()].sort((p, q) => p[0] - q[0])) {
    // 重なりを除いた長さ
    list.sort((p, q) => p[0] - q[0]);
    let len = 0;
    let end = -Infinity;
    for (const [a0, a1] of list) {
      if (a1 <= end) continue;
      len += a1 - Math.max(a0, end);
      end = a1;
    }
    if (len >= runLen * 0.5) inner.push(key * 20);
  }
  if (inner.length < 2) return false;
  const cuts = [span0, ...inner, span1];
  const gaps = cuts.slice(1).map((c, i) => c - cuts[i]);
  const lo = Math.min(...gaps);
  const hi = Math.max(...gaps);
  if (!(lo >= 150 && hi <= 480 && hi / lo <= 1.4)) return false;
  // タイルの升目はほぼ正方形（直交の線の間隔 ≒ 段の線の間隔）。階段の歩行線（各列の中央）は段の間隔の 2 倍ほど離れている
  // （サンプル図面の折り返し階段: 段 217 間隔、歩行線と中央線は 425 間隔で、格子と間違えて階段が消えていた）
  if (b.pitch && b.pitch > 0) {
    const mid = gaps.slice().sort((p, q) => p - q)[Math.floor(gaps.length / 2)];
    if (mid / b.pitch < 0.7 || mid / b.pitch > 1.45) return false;
  }
  return true;
}

/**
 * 階段の中を段の並ぶ向きに通る長い線（歩行線・中央の線）の位置から、列の数を見る。
 *  - 'columns': 幅の 1/4 と 3/4 の所に線がある（折り返し階段の左右の列に、それぞれ歩行線）
 *  - 'center': 幅の中央にだけ線がある（幅の広い直階段の歩行線）
 */
export function walkLineKind(b: { minX: number; minY: number; maxX: number; maxY: number; orient: 'h' | 'v' }, segs: Seg[]): 'center' | 'columns' | undefined {
  const h = b.orient === 'h';
  const run0 = h ? b.minY : b.minX;
  const run1 = h ? b.maxY : b.maxX;
  const span0 = h ? b.minX : b.minY;
  const span1 = h ? b.maxX : b.maxY;
  const runLen = run1 - run0;
  const span = span1 - span0;
  if (runLen < 300 || span < 450) return undefined;
  const pos: number[] = [];
  for (const s of segs) {
    if (s.dashed) continue;
    const dx = s.b.x - s.a.x;
    const dy = s.b.y - s.a.y;
    const L = Math.hypot(dx, dy);
    if (L < runLen * 0.5) continue;
    if (h ? Math.abs(dx) > L * 0.02 : Math.abs(dy) > L * 0.02) continue;
    const p = h ? (s.a.x + s.b.x) / 2 : (s.a.y + s.b.y) / 2;
    if (p <= span0 + 60 || p >= span1 - 60) continue;
    const a0 = Math.max(run0, h ? Math.min(s.a.y, s.b.y) : Math.min(s.a.x, s.b.x));
    const a1 = Math.min(run1, h ? Math.max(s.a.y, s.b.y) : Math.max(s.a.x, s.b.x));
    if (a1 - a0 < runLen * 0.5) continue;
    pos.push((p - span0) / span);
  }
  const near = (f: number) => pos.some((q) => Math.abs(q - f) <= 0.12);
  if (near(0.25) && near(0.75)) return 'columns';
  if (near(0.5)) return 'center';
  return undefined;
}

type Side = 'n' | 's' | 'e' | 'w';

/** 階段の矩形に対して、点 p にいちばん近い辺 */
export function stairSideOf(r: { minX: number; minY: number; maxX: number; maxY: number }, p: Vec2): Side {
  const d: [Side, number][] = [
    ['n', p.y - r.minY],
    ['s', r.maxY - p.y],
    ['w', p.x - r.minX],
    ['e', r.maxX - p.x],
  ];
  return d.sort((a, b) => a[1] - b[1])[0][0];
}

/** 階段の矩形から点までの距離（中なら 0） */
export function stairMarkDist(r: { minX: number; minY: number; maxX: number; maxY: number }, t: Vec2): number {
  return Math.hypot(Math.max(0, r.minX - t.x, t.x - r.maxX), Math.max(0, r.minY - t.y, t.y - r.maxY));
}

/** 階段の矩形から点までの、縦・横それぞれの離れの大きいほう（角の斜め先にある文字を、遠すぎると数えないため） */
export function stairMarkReach(r: { minX: number; minY: number; maxX: number; maxY: number }, t: Vec2): number {
  return Math.max(0, r.minX - t.x, t.x - r.maxX, r.minY - t.y, t.y - r.maxY);
}

/** UP・DN の文字を階段のものとみなす距離 (mm)。文字は矢印の始点の横に置かれ、昇り口の 1 段手前（ホール側）に来る（林様邸: 549mm） */
export const STAIR_MARK_RANGE = 900;

/**
 * 昇り口を図面の矢印（UP／DN の矢印線）から読む。御社の図面（ARCHITREND）は昇り口に UP（上階は DN）の文字を置き、
 * 階段の中を矢印の線が昇る向きに走り、矢じり（短い 2 本の線）が先端につく。
 * 矢印の始点には小さな丸が付き、その横に UP／DN の文字が置かれる（丸は細かすぎて線として残らないので文字を使う）。
 *  1. UP／DN の文字が階段のそばにあれば、文字にいちばん近い辺
 *  2. 文字が無ければ、階段の中の長い線（矢印の軸）の端の矢じりを探し、軸をたどった反対の端
 *     （ジグザグの切断線も短い斜め線なので、文字が無いときだけ使う）
 * 読めなければ null（壁の少ない辺にフォールバック）
 */
export function stairEntryFromArrow(r: { minX: number; minY: number; maxX: number; maxY: number }, segs: Seg[], marks: Vec2[]): Side | null {
  const pad = 160;
  const inside = (p: Vec2) => p.x >= r.minX - pad && p.x <= r.maxX + pad && p.y >= r.minY - pad && p.y <= r.maxY + pad;
  const W = r.maxX - r.minX;
  const H = r.maxY - r.minY;
  const sideOf = (p: Vec2): Side => {
    const d: [Side, number][] = [
      ['n', p.y - r.minY],
      ['s', r.maxY - p.y],
      ['w', p.x - r.minX],
      ['e', r.maxX - p.x],
    ];
    return d.sort((a, b) => a[1] - b[1])[0][0];
  };
  const L = (q: { a: Vec2; b: Vec2 }) => Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y);
  const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) <= 45;
  const inner = segs.filter((q) => !q.dashed && inside(q.a) && inside(q.b));
  // 軸: 階段の短辺の 6 割以上の長さの線（踏面線は短く多数、軸は少数）
  // 軸: 階段の短辺の 35% 以上（折り返しの最後の軸は短い）。踏面線も入るが、端に矢じりが無ければ使われない
  const axes = inner.filter((q) => L(q) >= Math.max(450, Math.min(W, H) * 0.35));
  // 矢じり: 長さ 60〜420、軸の端に接し、軸と 15〜75° をなす線
  const heads = inner.filter((q) => L(q) >= 60 && L(q) <= 420);
  const headAt = (ax: Seg, end: Vec2): number => {
    const dx = (ax.b.x - ax.a.x) / (L(ax) || 1);
    const dy = (ax.b.y - ax.a.y) / (L(ax) || 1);
    let n = 0;
    for (const h of heads) {
      if (h === ax) continue;
      const touch = near(h.a, end) ? h.b : near(h.b, end) ? h.a : null;
      if (!touch) continue;
      const hl = Math.hypot(touch.x - end.x, touch.y - end.y) || 1;
      const c = Math.abs(((touch.x - end.x) * dx + (touch.y - end.y) * dy) / hl);
      if (c >= 0.25 && c <= 0.97) n++;
    }
    return n;
  };
  // 文字（UP／DN）の位置
  const m = marks
    .map((t) => ({ t, d: Math.hypot(Math.max(0, r.minX - t.x, t.x - r.maxX), Math.max(0, r.minY - t.y, t.y - r.maxY)) }))
    .filter((q) => q.d <= STAIR_MARK_RANGE)
    .sort((a, b) => a.d - b.d)[0];
  if (m) return sideOf(m.t);
  let best: { tail: Vec2; n: number } | null = null;
  for (const ax of axes) {
    for (const [end, other] of [
      [ax.a, ax.b],
      [ax.b, ax.a],
    ] as [Vec2, Vec2][]) {
      const n = headAt(ax, end);
      if (!n) continue;
      // 折り返し・かね折れ: 軸がつながっていれば、その先の端まで戻る（昇り口は最初の軸の端）
      let tail = other;
      const used = new Set<Seg>([ax]);
      for (let hop = 0; hop < 4; hop++) {
        const next = axes.find((q) => !used.has(q) && (near(q.a, tail) || near(q.b, tail)));
        if (!next) break;
        used.add(next);
        tail = near(next.a, tail) ? next.b : next.a;
      }
      if (!best || n > best.n) best = { tail, n };
    }
  }
  return best ? sideOf(best.tail) : null;
}

export function rectPoly(r: { minX: number; minY: number; maxX: number; maxY: number }): Vec2[] {
  return [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ];
}
