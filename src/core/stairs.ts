/**
 * 階段の段割り（平面）。3D・清書平面図・修正画面で同じ計算を使う。
 *
 * 階段は軸平行の矩形で、昇り口の辺（entry）から奥へ進む向きを s、昇る人から見て右向きを t とした
 * 局所座標で段を並べ、矩形の mm 座標に戻す。
 */
import type { Stair } from './types';

export interface StairPiece {
  kind: 'tread' | 'landing';
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 段の番号（1 = 最初の段。踊り場も 1 段分として数える） */
  i: number;
  /** この段を昇る向き（平面の単位ベクトル） */
  dir: { x: number; y: number };
}

export interface StairLayout {
  n: number;
  pieces: StairPiece[];
  /** 折り返し階段の中央の腰壁（平面の矩形） */
  wall?: { minX: number; minY: number; maxX: number; maxY: number };
  /** コの字階段の中央の吹抜（平面の矩形。上下階がつながり、手すりで囲う） */
  well?: { minX: number; minY: number; maxX: number; maxY: number };
}

export const STAIR_KIND_LABEL: Record<Stair['kind'], string> = { straight: '直階段', u: '折り返し階段（中央に腰壁）', uOpen: 'コの字階段（中央が吹抜）', l: 'かね折れ階段' };
/** コの字階段で中央に吹抜を取れる最小の幅（段の幅 910 × 2 ＋ 吹抜 300） */
const U_OPEN_MIN_WIDTH = 2100;
export const STAIR_ENTRY_LABEL: Record<Stair['entry'], string> = { n: '北（上）側', s: '南（下）側', e: '東（右）側', w: '西（左）側' };

/**
 * かね折れ階段の 1 列の幅（mm）。図面で列の幅が読めていれば（Stair.flightWidth）その幅、無ければ 1,000 まで。
 * 半間（910）の列の階段を 1,000 で作ると、段の端が隣の壁から 3cm ほどはみ出して見える
 */
export function lFlightWidth(s: Stair, Ls: number, Lt: number): number {
  const base = Math.min(1000, Math.max(Ls, Lt) / 2, Math.min(Ls, Lt));
  return s.flightWidth != null ? Math.max(600, Math.min(s.flightWidth, Math.min(Ls, Lt))) : base;
}

/** 昇り口の辺から奥へ進む向き・右向き・原点（昇る人の左手側の角） */
export function stairFrame(s: Stair) {
  const W = s.maxX - s.minX;
  const H = s.maxY - s.minY;
  switch (s.entry) {
    case 'n':
      return { u: { x: 0, y: 1 }, r: { x: -1, y: 0 }, o: { x: s.maxX, y: s.minY }, Ls: H, Lt: W };
    case 's':
      return { u: { x: 0, y: -1 }, r: { x: 1, y: 0 }, o: { x: s.minX, y: s.maxY }, Ls: H, Lt: W };
    case 'w':
      return { u: { x: 1, y: 0 }, r: { x: 0, y: 1 }, o: { x: s.minX, y: s.minY }, Ls: W, Lt: H };
    default:
      return { u: { x: -1, y: 0 }, r: { x: 0, y: -1 }, o: { x: s.maxX, y: s.maxY }, Ls: W, Lt: H };
  }
}

/**
 * 図面の読み取りで「折り返し・かね折れ」となっていても、幅（昇る向きと直交する寸法）が 1.4m に満たない矩形では
 * 2 列に段を並べられない（1 列 45cm の段になり、人が通れない）。そういう階段は直階段として段を割る
 */
export function effectiveStair(s: Stair): Stair {
  if (s.kind === 'straight') return s;
  const { Lt } = stairFrame(s);
  if (Lt < 1400) return { ...s, kind: 'straight' };
  // コの字（中央が吹抜）は、2 列の段（各 910）と吹抜（300 以上）を取れる幅が要る。狭ければ折り返し（中央は腰壁）
  if (s.kind === 'uOpen' && Lt < U_OPEN_MIN_WIDTH) return { ...s, kind: 'u' };
  return s;
}

/** 段数の目安（階高から。1 段 200mm 前後、最低 10 段） */
/** 段数: 図面に書かれた段数があればそれを、無ければ階高 ÷ 200mm 前後で推定 */
export function stairStepCount(riseMm: number, s?: Pick<Stair, 'steps'> | null) {
  if (s?.steps && s.steps >= 6 && s.steps <= 30) return s.steps;
  return Math.max(10, Math.round(riseMm / 200));
}

/** 踏面の最小寸法 (mm)。段数はこれを下回らない範囲で決める（鉄骨のストリップ階段の標準的な勾配） */
export const MIN_TREAD = 240;
/** 蹴上の上限 (mm)。住宅の法規の上限 230 */
export const MAX_RISER = 230;

/** 矩形（kind・entry を考慮）に踏面 MIN_TREAD で納まる最大の段数 */
export function maxStepsInRect(s0: Stair): number {
  const s = effectiveStair(s0);
  const { Ls, Lt } = stairFrame(s);
  if (s.kind === 'straight') return Math.max(2, Math.floor(Ls / MIN_TREAD));
  if (s.kind === 'u' || s.kind === 'uOpen') {
    const fw = s.kind === 'uOpen' ? Math.min(1000, Math.max(910, (Lt - 300) / 2)) : Lt / 2;
    const land = Math.min(Ls * 0.4, s.kind === 'uOpen' ? fw : Lt / 2);
    const k = Math.floor((Ls - land) / MIN_TREAD);
    return Math.max(3, 2 * k + 1);
  }
  const fw = lFlightWidth(s, Ls, Lt);
  const len1 = Math.max(0, Ls - fw);
  const len2 = Math.max(0, Lt - fw);
  return Math.max(3, Math.floor(len1 / MIN_TREAD) + Math.floor(len2 / MIN_TREAD) + 1);
}

/**
 * 実際に使う段数: 図面の段数があればそれ。無ければ階高 ÷ 200 前後を目安に、矩形に踏面 240 で納まる段数まで減らす
 * （蹴上は 230 を超えない範囲）。矩形は延ばさない（以前は昇り口側へ延ばしていて、方眼で奥行を変えても表記が変わらなかった）
 */
export function effectiveStepCount(riseMm: number, s: Stair): number {
  if (s.steps && s.steps >= 6 && s.steps <= 30) return s.steps;
  const n0 = stairStepCount(riseMm);
  const nMin = Math.max(6, Math.ceil(riseMm / MAX_RISER));
  // 直階段で、図面の段の線の間隔（踏面）が読めていれば、図面どおりの段数: 長さ ÷ 間隔 が踏面の数、上がり切りの 1 段を足す。
  // 以前は「踏面 240 以上」で割っていたので、踏面 227.5（910 ÷ 4）で端から端まで描かれた 15 段の階段が 13 段（蹴上 223）になり、
  // 木造チェックに「やや急」と出ていた（田中様邸 2 階）。
  // 使うのは、範囲が間隔のちょうど整数倍で、その段数で蹴上が上限に納まるときだけ:
  //  - 半端が出る範囲は、段の線の無い所（踊り場・角の回り段）を含んでいる
  //  - 段数が足りない範囲は、直線の段のほかに角の回り段がある（市岡様邸: 直線 8 段＋上下の角に 2 段ずつ = 13 段）
  // どちらも今までどおり階高から決める
  const e = effectiveStair(s);
  if (e.kind === 'straight' && s.treadPitch != null && s.treadPitch >= 180 && s.treadPitch <= 300) {
    const k = stairFrame(e).Ls / s.treadPitch;
    const n = Math.round(k) + 1;
    if (Math.abs(k - Math.round(k)) <= 0.12 && n >= nMin && n <= 22) return n;
  }
  return Math.max(nMin, Math.min(n0, maxStepsInRect(s)));
}

/** 互換のため残す（矩形を延ばさなくなったので、そのまま返す） */
export function stairRunExtended(s0: Stair, _n: number): Stair {
  void _n;
  return effectiveStair(s0);
}

export function stairLayout(s0: Stair, n = 14): StairLayout {
  const s = effectiveStair(s0);
  const F = stairFrame(s);
  const P = (sv: number, tv: number) => ({ x: F.o.x + F.u.x * sv + F.r.x * tv, y: F.o.y + F.u.y * sv + F.r.y * tv });
  const rect = (s0: number, s1: number, t0: number, t1: number) => {
    const a = P(s0, t0);
    const b = P(s1, t1);
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  };
  const pieces: StairPiece[] = [];
  const { Ls, Lt } = F;
  const neg = (v: { x: number; y: number }) => ({ x: -v.x, y: -v.y });
  if (s.kind === 'straight') {
    const st = Ls / n;
    for (let i = 1; i <= n; i++) pieces.push({ kind: 'tread', ...rect(st * (i - 1), st * i, 0, Lt), i, dir: F.u });
    return { n, pieces };
  }
  if (s.kind === 'u' || s.kind === 'uOpen') {
    const turn = s.turn ?? 'left';
    // コの字: 段の幅は 910（残りが中央の吹抜）。折り返し: 幅を 2 等分（中央に腰壁）
    const fw = s.kind === 'uOpen' ? Math.min(1000, Math.max(910, (Lt - 300) / 2)) : Lt / 2;
    // 昇る人から見て左に折り返す = 最初の列は右側
    const first: [number, number] = turn === 'left' ? [Lt - fw, Lt] : [0, fw];
    const second: [number, number] = turn === 'left' ? [0, fw] : [Lt - fw, Lt];
    const land = Math.min(Ls * 0.4, s.kind === 'uOpen' ? fw : Lt / 2);
    const run = Ls - land;
    const n1 = Math.floor(n / 2);
    const n2 = n - n1 - 1;
    const st1 = run / n1;
    const st2 = run / Math.max(1, n2);
    for (let i = 1; i <= n1; i++) pieces.push({ kind: 'tread', ...rect(st1 * (i - 1), st1 * i, first[0], first[1]), i, dir: F.u });
    pieces.push({ kind: 'landing', ...rect(run, Ls, 0, Lt), i: n1 + 1, dir: F.u });
    for (let j = 1; j <= n2; j++) pieces.push({ kind: 'tread', ...rect(run - st2 * (j - 1), run - st2 * j, second[0], second[1]), i: n1 + 1 + j, dir: neg(F.u) });
    if (s.kind === 'uOpen') return { n, pieces, well: rect(0, run, fw, Lt - fw) };
    return { n, pieces, wall: rect(0, run, Lt / 2 - 50, Lt / 2 + 50) };
  }
  // かね折れ: 最初の列は矩形の片側の帯、角で踊り場、奥の辺に沿って曲がる
  const turn = s.turn ?? 'right';
  const fw = lFlightWidth(s, Ls, Lt);
  const strip: [number, number] = turn === 'right' ? [0, fw] : [Lt - fw, Lt];
  const len1 = Math.max(0, Ls - fw);
  const len2 = Math.max(0, Lt - fw);
  const n1 = len2 <= 1 ? n - 1 : Math.max(1, Math.min(n - 2, Math.round(((n - 1) * len1) / Math.max(1, len1 + len2))));
  const n2 = n - 1 - n1;
  const st1 = len1 / Math.max(1, n1);
  for (let i = 1; i <= n1; i++) pieces.push({ kind: 'tread', ...rect(st1 * (i - 1), st1 * i, strip[0], strip[1]), i, dir: F.u });
  pieces.push({ kind: 'landing', ...rect(len1, Ls, strip[0], strip[1]), i: n1 + 1, dir: F.u });
  const st2 = len2 / Math.max(1, n2);
  const dir2 = turn === 'right' ? F.r : neg(F.r);
  for (let j = 1; j <= n2; j++) {
    const t0 = turn === 'right' ? fw + st2 * (j - 1) : Lt - fw - st2 * (j - 1);
    const t1 = turn === 'right' ? fw + st2 * j : Lt - fw - st2 * j;
    pieces.push({ kind: 'tread', ...rect(len1, Ls, t0, t1), i: n1 + 1 + j, dir: dir2 });
  }
  return { n, pieces };
}

/**
 * 階段が実際に占める範囲（上の階の床にあける穴）。直階段・折り返しは矩形そのもの。
 * かね折れは L 字なので、最初の列の帯と、奥の辺に沿う帯の 2 つ（矩形の残りの角は上の階の床が残る）
 */
export function stairFootprint(s0: Stair): { minX: number; minY: number; maxX: number; maxY: number }[] {
  const s = effectiveStair(s0);
  if (s.kind !== 'l') return [{ minX: s.minX, minY: s.minY, maxX: s.maxX, maxY: s.maxY }];
  const F = stairFrame(s);
  const { Ls, Lt } = F;
  const P = (sv: number, tv: number) => ({ x: F.o.x + F.u.x * sv + F.r.x * tv, y: F.o.y + F.u.y * sv + F.r.y * tv });
  const rect = (a0: number, a1: number, t0: number, t1: number) => {
    const a = P(a0, t0);
    const b = P(a1, t1);
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  };
  const fw = lFlightWidth(s, Ls, Lt);
  const strip: [number, number] = (s.turn ?? 'right') === 'right' ? [0, fw] : [Lt - fw, Lt];
  return [rect(0, Ls, strip[0], strip[1]), rect(Math.max(0, Ls - fw), Ls, 0, Lt)];
}

// ---------------------------------------------------------------------------
// 平面図の階段の表記（ARCHITREND などの CAD の描き方に寄せる）
// ---------------------------------------------------------------------------

export interface StairDrawing {
  /** 段鼻（蹴上）の線: 段ごとに段の幅いっぱい。above = 切断線より上（破線で描く） */
  risers: { a: { x: number; y: number }; b: { x: number; y: number }; above: boolean }[];
  /** 外形（側桁・踊り場の縁）。破線区間は切断線より上 */
  edges: { a: { x: number; y: number }; b: { x: number; y: number }; above: boolean }[];
  /** 歩行線（SVG の path d。昇り口から昇る向きへ） */
  walkPath: string;
  /** 昇り口の○ */
  start: { x: number; y: number };
  /** 矢じり（3 点）と、UP/DN の文字の位置・角度 */
  arrow: { x: number; y: number }[];
  label: { x: number; y: number; angle: number; text: string };
  /** 切断線（ジグザグの折れ線。上階へ昇る階段だけ） */
  cut?: { x: number; y: number }[];
  /** 中央の腰壁（折り返し）／吹抜（コの字） */
  wall?: { minX: number; minY: number; maxX: number; maxY: number };
  well?: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * 階段の表記を作る。
 *  - 段鼻は段の幅の線、側桁は外形の線。歩行線は段の中央（踏板の幅の中心）を通り、踊り場では丸く回る
 *  - 上階へ昇る階段は、床から 1,400 ほどの段で切断線（ジグザグ）を入れ、その上の段は破線
 *  - 昇り口に○、終わりに矢じり。UP／DN と段数
 */
export function stairDrawing(st: Stair, riseMm: number, opts: { cut?: boolean } = {}): StairDrawing {
  const n = effectiveStepCount(riseMm, st);
  const lay = stairLayout(st, n);
  const pieces = lay.pieces;
  const riser = riseMm / Math.max(1, n);
  const cutAt = opts.cut !== false && st.goesUp ? Math.min(pieces.length - 1, Math.max(2, Math.ceil(1400 / riser))) : -1;
  const ctr = (p: { minX: number; minY: number; maxX: number; maxY: number }) => ({ x: (p.minX + p.maxX) / 2, y: (p.minY + p.maxY) / 2 });
  const risers: StairDrawing['risers'] = [];
  const edges: StairDrawing['edges'] = [];
  pieces.forEach((p, k) => {
    const above = cutAt >= 0 && k > cutAt;
    const d = p.dir;
    // 段鼻: 段の「昇った先」の辺（dir と直交）。踊り場は 4 辺とも外形
    const horiz = Math.abs(d.x) > 0.5;
    if (p.kind === 'tread') {
      const front = horiz ? (d.x > 0 ? p.maxX : p.minX) : d.y > 0 ? p.maxY : p.minY;
      risers.push(horiz ? { a: { x: front, y: p.minY }, b: { x: front, y: p.maxY }, above } : { a: { x: p.minX, y: front }, b: { x: p.maxX, y: front }, above });
      // 最初の段は昇り口の線も
      if (k === 0) {
        const back = horiz ? (d.x > 0 ? p.minX : p.maxX) : d.y > 0 ? p.minY : p.maxY;
        risers.push(horiz ? { a: { x: back, y: p.minY }, b: { x: back, y: p.maxY }, above } : { a: { x: p.minX, y: back }, b: { x: p.maxX, y: back }, above });
      }
      // 側桁（段の両脇）
      if (horiz) {
        edges.push({ a: { x: p.minX, y: p.minY }, b: { x: p.maxX, y: p.minY }, above }, { a: { x: p.minX, y: p.maxY }, b: { x: p.maxX, y: p.maxY }, above });
      } else {
        edges.push({ a: { x: p.minX, y: p.minY }, b: { x: p.minX, y: p.maxY }, above }, { a: { x: p.maxX, y: p.minY }, b: { x: p.maxX, y: p.maxY }, above });
      }
    } else {
      edges.push(
        { a: { x: p.minX, y: p.minY }, b: { x: p.maxX, y: p.minY }, above },
        { a: { x: p.maxX, y: p.minY }, b: { x: p.maxX, y: p.maxY }, above },
        { a: { x: p.maxX, y: p.maxY }, b: { x: p.minX, y: p.maxY }, above },
        { a: { x: p.minX, y: p.maxY }, b: { x: p.minX, y: p.minY }, above },
      );
    }
  });
  // 歩行線
  let walkPath = '';
  const treads = pieces.map((p, k) => ({ p, k, c: ctr(p) }));
  const sameDir = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
  let prev: { x: number; y: number } | null = null;
  for (let k = 0; k < treads.length; k++) {
    const t = treads[k];
    if (t.p.kind === 'landing') {
      const nxt = treads[k + 1];
      if (!nxt || !prev) continue;
      const d1 = t.p.dir;
      const ext = Math.abs(d1.x) > 0.5 ? t.p.maxX - t.p.minX : t.p.maxY - t.p.minY;
      if (sameDir({ x: -d1.x, y: -d1.y }, nxt.p.dir)) {
        // 折り返し: 踊り場の奥へ少し進んでから半円で回る
        const adv = Math.max(0, ext * 0.5 - Math.hypot(nxt.c.x - prev.x, nxt.c.y - prev.y) / 2);
        const p1 = { x: prev.x + d1.x * adv, y: prev.y + d1.y * adv };
        const p2 = { x: nxt.c.x + d1.x * adv, y: nxt.c.y + d1.y * adv };
        const r = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2;
        const sweep = d1.x * (p2.y - p1.y) - d1.y * (p2.x - p1.x) > 0 ? 1 : 0;
        walkPath += ` L${p1.x.toFixed(0)} ${p1.y.toFixed(0)} A${r.toFixed(0)} ${r.toFixed(0)} 0 0 ${sweep} ${p2.x.toFixed(0)} ${p2.y.toFixed(0)} L${nxt.c.x.toFixed(0)} ${nxt.c.y.toFixed(0)}`;
      } else {
        // かね折れ: 踊り場の中心を制御点に 1/4 円のように曲がる
        walkPath += ` Q${t.c.x.toFixed(0)} ${t.c.y.toFixed(0)} ${nxt.c.x.toFixed(0)} ${nxt.c.y.toFixed(0)}`;
      }
      prev = nxt.c;
      k++;
      continue;
    }
    walkPath += prev ? ` L${t.c.x.toFixed(0)} ${t.c.y.toFixed(0)}` : `M${t.c.x.toFixed(0)} ${t.c.y.toFixed(0)}`;
    prev = t.c;
  }
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  const c0 = ctr(first);
  const c1 = ctr(last);
  const dl = last.dir;
  // 矢じりは最後の段の先端（段鼻）まで伸ばす
  const lastFront = Math.abs(dl.x) > 0.5 ? Math.abs((dl.x > 0 ? last.maxX : last.minX) - c1.x) : Math.abs((dl.y > 0 ? last.maxY : last.minY) - c1.y);
  const tipLen = Math.max(120, lastFront - 20);
  const tip = { x: c1.x + dl.x * tipLen, y: c1.y + dl.y * tipLen };
  const aw = 70;
  const al = 180;
  const arrow = [tip, { x: tip.x - dl.x * al - dl.y * aw, y: tip.y - dl.y * al + dl.x * aw }, { x: tip.x - dl.x * al + dl.y * aw, y: tip.y - dl.y * al - dl.x * aw }];
  walkPath += ` L${(tip.x - dl.x * al * 0.6).toFixed(0)} ${(tip.y - dl.y * al * 0.6).toFixed(0)}`;
  const d0 = first.dir;
  let angle = (Math.atan2(d0.y, d0.x) * 180) / Math.PI;
  // 文字は左→右か下→上に読める向きに
  if (angle > 90) angle -= 180;
  else if (angle <= -90) angle += 180;
  if (angle === 90) angle = -90;
  // UP／DN と段数は昇り口の○の脇（段の幅の中で、歩行線の右側）に、段の向きに沿って
  const perp = { x: -d0.y, y: d0.x };
  const label = { x: c0.x + perp.x * 230 + d0.x * 60, y: c0.y + perp.y * 230 + d0.y * 60, angle, text: `${st.goesUp ? 'UP' : 'DN'} ${n}` };
  let cut: StairDrawing['cut'];
  if (cutAt >= 0 && pieces[cutAt]) {
    const p = pieces[cutAt];
    const d = p.dir;
    const px = { x: -d.y, y: d.x };
    const c = ctr(p);
    const halfW = Math.abs(px.x) > 0.5 ? (p.maxX - p.minX) / 2 : (p.maxY - p.minY) / 2;
    const halfD = Math.abs(d.x) > 0.5 ? (p.maxX - p.minX) / 2 : (p.maxY - p.minY) / 2;
    const A = { x: c.x - px.x * halfW * 1.08 - d.x * halfD * 0.9, y: c.y - px.y * halfW * 1.08 - d.y * halfD * 0.9 };
    const B = { x: c.x + px.x * halfW * 1.08 + d.x * halfD * 0.9, y: c.y + px.y * halfW * 1.08 + d.y * halfD * 0.9 };
    const m = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    const v = { x: B.x - A.x, y: B.y - A.y };
    const L = Math.hypot(v.x, v.y) || 1;
    const u = { x: v.x / L, y: v.y / L };
    const nn = { x: -u.y, y: u.x };
    const z = Math.min(90, halfW * 0.25);
    cut = [A, { x: m.x - u.x * z, y: m.y - u.y * z }, { x: m.x - u.x * z * 0.4 + nn.x * z, y: m.y - u.y * z * 0.4 + nn.y * z }, { x: m.x + u.x * z * 0.4 - nn.x * z, y: m.y + u.y * z * 0.4 - nn.y * z }, { x: m.x + u.x * z, y: m.y + u.y * z }, B];
  }
  return { risers, edges, walkPath, start: c0, arrow, label, cut, wall: lay.wall, well: lay.well };
}
