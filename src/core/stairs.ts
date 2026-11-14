/**
 * 階段の段割り（平面）。3D・清書平面図・修正画面で同じ計算を使う。
 *
 * 階段は軸平行の矩形で、昇り口の辺（entry）から奥へ進む向きを s、昇る人から見て右向きを t とした
 * 局所座標で段を並べ、矩形の mm 座標に戻す。
 */
import type { Stair } from './types';

export interface StairPiece {
  /** tread = 直線の段、landing = 踊り場（四角）、winder = 角の回り段（三角・台形。形は poly） */
  kind: 'tread' | 'landing' | 'winder';
  /** 外形の範囲（回り段は poly を囲む四角） */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 段の番号（1 = 最初の段。踊り場も 1 段分として数える） */
  i: number;
  /** この段を昇る向き（平面の単位ベクトル） */
  dir: { x: number; y: number };
  /** 回り段の形（平面の多角形 mm）。最初の 2 点が、昇る人がこの段に上がる縁（蹴込みの位置） */
  poly?: { x: number; y: number }[];
  /**
   * 昇り口の広い段（ひな壇）: この段が床からの台であるときの、台の範囲（平面の矩形。StairLayout.plinths の同じ段の top）。
   * 段そのものの範囲（minX…）は最初の列の幅のまま（歩行線・踏面の計算用）
   */
  wide?: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface StairLayout {
  n: number;
  pieces: StairPiece[];
  /** 折り返し階段の中央の腰壁（平面の矩形） */
  wall?: { minX: number; minY: number; maxX: number; maxY: number };
  /** コの字階段の中央の吹抜（平面の矩形。上下階がつながり、手すりで囲う） */
  well?: { minX: number; minY: number; maxX: number; maxY: number };
  /** 昇り口の広い段（ひな壇）の台。入れ子に重なる（図面の描き方と同じ: どの台も、手前の縁から奥の壁まで） */
  plinths?: StairPlinth[];
}

/** ひな壇の台 1 枚: i 段目の高さの板。top = 板の範囲、base = 板の下の箱の範囲（空いている縁は段鼻の出 20mm ぶん引っ込む） */
export interface StairPlinth {
  i: number;
  top: { minX: number; minY: number; maxX: number; maxY: number };
  base: { minX: number; minY: number; maxX: number; maxY: number };
  /** 図面に引く縁（手前の縁・空いている脇の縁） */
  lines: { a: { x: number; y: number }; b: { x: number; y: number } }[];
}

export const STAIR_KIND_LABEL: Record<Stair['kind'], string> = { straight: '直階段', u: '折り返し階段（中央に腰壁）', uOpen: 'コの字階段（中央が吹抜）', l: 'かね折れ階段' };
/** コの字階段で中央に吹抜を取れる最小の幅（段の幅 910 × 2 ＋ 吹抜 300） */
const U_OPEN_MIN_WIDTH = 2100;

/**
 * コの字階段の「3 方回り」: 幅に余裕がある（奥の列を 400 以上取れる）コの字階段は、
 * 両脇の列（幅 fw）＋ 奥の辺に沿う列 ＋ 2 つの角（踊り場か回り段）で、3 方の壁沿いに回る。
 * 御社の図面のコの字階段はこの形（1.5 間 × 1 間に、左 4 段 → 角 → 奥 4 段 → 角 → 右 4 段）。
 * 以前は「両脇の 2 列＋奥いっぱいの踊り場 1 枚」で、段が脇の 2 列に詰まり、踏面が 150 台になっていた。
 * 戻り値: 列の幅 fw・脇の列の長さ len1・奥の列の長さ len2。3 方回りにできない幅なら null
 */
export function wrapFlights(s: Stair): { fw: number; len1: number; len2: number } | null {
  if (s.kind !== 'uOpen') return null;
  const { Ls, Lt } = stairFrame(s);
  // 図面から奥の列が読めた階段か、幅 2,500 以上（奥いっぱいの踊り場 1 枚にはならない広さ）。
  // それより狭い手描きのコの字は、今までどおり「両脇の 2 列＋奥の踊り場＋中央の細い吹抜」
  if (s.midRun == null && Lt < 2500) return null;
  // 列の幅: 図面の奥の列の長さが分かっていれば、残りを 2 つの角で分ける（5mm 単位）。無ければ 910
  const want = s.midRun != null && s.midRun > 0 ? Math.round((Lt - s.midRun) / 10) * 5 : (s.flightWidth ?? 910);
  const fw = Math.min(Math.max(700, Math.min(1000, want)), (Lt - 400) / 2);
  if (fw < 650 || Ls < 650) return null;
  // 奥行が列の幅ほどしか無い（脇の列を取れない）: 奥の列の両端の角で、直角に出入りする（脇の列の長さ 0）。
  // 御社の図面の「壁沿いの長い直階段の上下の角に回り段」がこの形
  const len1 = Ls - fw < 200 ? 0 : Ls - fw;
  return { fw, len1, len2: Lt - 2 * fw };
}
/**
 * 昇り口の広い段（ひな壇）の段数（0 = 無し）。最初の列の段数 k1 まで（脇の列のあるコの字階段だけ）。
 * 最初の列を全部ひな壇にしてもよい（御社の図面: 4 段とも幅いっぱい、5 段目から回り段）
 */
export const wideStepsOf = (s: Pick<Stair, 'wideSteps'>, k1: number): number => Math.max(0, Math.min(k1, Math.round(s.wideSteps ?? 0) || 0));
/** 角 1 つの段数（1 = 踊り場、2 = 斜めの線 1 本で 2 段、3 = 3 段回り） */
export const cornerStepsOf = (s: Pick<Stair, 'cornerSteps'>): 1 | 2 | 3 => (s.cornerSteps === 2 || s.cornerSteps === 3 ? s.cornerSteps : 1);
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
export function stairStepCount(riseMm: number, s?: Pick<Stair, 'steps' | 'look'> | null) {
  // こだわり指定（参考資料）の段数 → 図面に書かれた段数 → 階高からの推定
  const fixed = s?.look?.steps ?? s?.steps;
  if (fixed && fixed >= 6 && fixed <= 30) return fixed;
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
  const wrap = wrapFlights(s);
  if (wrap) return Math.max(wrap.len1 > 0 ? 5 : 3, 2 * Math.floor(wrap.len1 / MIN_TREAD) + Math.floor(wrap.len2 / MIN_TREAD) + 2 * cornerStepsOf(s));
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
  const fixed = s.look?.steps ?? s.steps;
  if (fixed && fixed >= 6 && fixed <= 30) return fixed;
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
  // コの字（3 方回り）で図面の段の間隔が読めていれば、3 つの列の段数（長さ ÷ 間隔）＋角の段数
  const wrap = wrapFlights(e);
  if (wrap && s.treadPitch != null && s.treadPitch >= 180 && s.treadPitch <= 300) {
    const k1 = wrap.len1 / s.treadPitch;
    const k2 = wrap.len2 / s.treadPitch;
    const n = 2 * Math.round(k1) + Math.round(k2) + 2 * cornerStepsOf(s);
    if (Math.abs(k1 - Math.round(k1)) <= 0.15 && Math.abs(k2 - Math.round(k2)) <= 0.15 && n >= nMin && n <= 24) return n;
  }
  return Math.max(nMin, Math.min(n0, maxStepsInRect(s)));
}

/** 踏面の奥行の目安 (mm): 直線の列の長さ ÷ その列の段数（木造チェック・説明用） */
export function stairTreadDepth(s0: Stair, n: number): number {
  const lay = stairLayout(s0, n);
  let best = Infinity;
  for (const p of lay.pieces) {
    if (p.kind !== 'tread') continue;
    best = Math.min(best, Math.abs(p.dir.x) > 0.5 ? p.maxX - p.minX : p.maxY - p.minY);
  }
  return Number.isFinite(best) ? best : 0;
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
  const neg = (v: { x: number; y: number }) => ({ x: -v.x || 0, y: -v.y || 0 });
  if (s.kind === 'straight') {
    const st = Ls / n;
    for (let i = 1; i <= n; i++) pieces.push({ kind: 'tread', ...rect(st * (i - 1), st * i, 0, Lt), i, dir: F.u });
    return { n, pieces };
  }
  const wrap = wrapFlights(s);
  if (wrap) {
    // コの字（3 方回り）: 脇の列 A → 角 A → 奥の列 → 角 B → 脇の列 B。昇る人から見て左に回る = 最初の列は右側
    const turn = s.turn ?? 'left';
    const { fw, len1, len2 } = wrap;
    const c = cornerStepsOf(s);
    const A: [number, number] = turn === 'left' ? [Lt - fw, Lt] : [0, fw];
    const B: [number, number] = turn === 'left' ? [0, fw] : [Lt - fw, Lt];
    /** 列の中央寄りの縁（吹抜の側）と、壁の側の縁 */
    const innerA = turn === 'left' ? Lt - fw : fw;
    const outerA = turn === 'left' ? Lt : 0;
    const innerB = turn === 'left' ? fw : Lt - fw;
    const outerB = turn === 'left' ? 0 : Lt;
    // 段の割り振り: 角の分を引いた残りを、列の長さに比例して 3 つの列へ
    const r = Math.max(len1 > 0 ? 3 : 1, n - 2 * c);
    let k2 = len1 > 0 ? Math.max(1, Math.round((r * len2) / (2 * len1 + len2))) : r;
    let k1 = len1 > 0 ? Math.max(1, Math.round((r - k2) / 2)) : 0;
    let k3 = r - k2 - k1;
    if (len1 > 0 && k3 < 1) {
      k3 = 1;
      if (k1 > 1) k1--;
      else if (k2 > 1) k2--;
    }
    const dirMid = turn === 'left' ? neg(F.r) : F.r;
    const poly = (pts: [number, number][], i: number, dir: { x: number; y: number }): StairPiece => {
      const ps = pts.map(([sv, tv]) => P(sv, tv));
      return { kind: 'winder', minX: Math.min(...ps.map((q) => q.x)), minY: Math.min(...ps.map((q) => q.y)), maxX: Math.max(...ps.map((q) => q.x)), maxY: Math.max(...ps.map((q) => q.y)), i, dir, poly: ps };
    };
    /**
     * 角の段: 軸（中央寄りの角）pivot から放射に割る。in0→in1 が上がってくる縁、out0→out1 が出ていく縁、far が壁の角。
     * 多角形の最初の 2 点は、その段に上がる縁
     */
    const corner = (pivot: [number, number], inEdge: [number, number], far: [number, number], outEdge: [number, number], i0: number, dIn: { x: number; y: number }, dOut: { x: number; y: number }) => {
      if (c === 1) {
        const a = P(Math.min(pivot[0], far[0]), Math.min(pivot[1], far[1]));
        const b = P(Math.max(pivot[0], far[0]), Math.max(pivot[1], far[1]));
        pieces.push({ kind: 'landing', minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y), i: i0, dir: dIn });
        return;
      }
      const lerp = (p: [number, number], q: [number, number], t: number): [number, number] => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      if (c === 2) {
        pieces.push(poly([pivot, inEdge, far], i0, dIn));
        pieces.push(poly([pivot, far, outEdge], i0 + 1, dOut));
        return;
      }
      // 3 段回り: 30°・60° の線（壁の辺の上で、角から tan30° = 0.577 の所）
      const q1 = lerp(inEdge, far, Math.tan(Math.PI / 6));
      const q2 = lerp(outEdge, far, Math.tan(Math.PI / 6));
      pieces.push(poly([pivot, inEdge, q1], i0, dIn));
      pieces.push(poly([pivot, q1, far, q2], i0 + 1, dIn));
      pieces.push(poly([pivot, q2, outEdge], i0 + 2, dOut));
    };
    let i = 0;
    const st1 = k1 ? len1 / k1 : 0;
    // 昇り口の広い段（ひな壇）: 最初の w 段は床からの台。図面と同じく、どの台も手前の縁から奥の壁まで（入れ子に重なる）。
    //  - full: どの台も階段室の幅いっぱい（いちばん上の台の上に、回り段・奥の列が載る）
    //  - corner: 1 段目は幅いっぱい、2 段目から上は最初の列の壁から「列の幅＋残りの段数 × 踏面」まで
    //            （手前と脇の 2 方向に下りる、角のひな壇）。最初の列を全部ひな壇にしたときは、奥の帯もいちばん上の台の高さ
    const w = wideStepsOf(s, k1);
    const pyramid = w > 0 && s.wideShape === 'corner';
    const NOSE = 20;
    const plinths: StairPlinth[] = [];
    const seg = (s0: number, t0: number, s1: number, t1: number) => ({ a: P(s0, t0), b: P(s1, t1) });
    for (let k = 1; k <= w; k++) {
      const ext = !pyramid || k === 1 ? Lt : Math.min(Lt, fw + (w - k) * st1);
      const free = ext < Lt - 1;
      // 最初の列の壁（outerA）から ext まで
      const t0 = turn === 'left' ? Lt - ext : 0;
      const t1 = turn === 'left' ? Lt : ext;
      const s0 = st1 * (k - 1);
      const tFree = turn === 'left' ? t0 : t1;
      const lines = [seg(s0, t0, s0, t1)];
      if (free) lines.push(seg(s0, tFree, pyramid && w === k1 ? len1 : Ls, tFree));
      plinths.push({
        i: k,
        top: rect(s0, Ls, t0, t1),
        base: rect(s0 + NOSE, Ls, free && turn === 'left' ? t0 + NOSE : t0, free && turn !== 'left' ? t1 - NOSE : t1),
        lines,
      });
    }
    if (pyramid && w === k1) plinths.push({ i: w, top: rect(len1, Ls, 0, Lt), base: rect(len1 + NOSE, Ls, 0, Lt), lines: [seg(len1, 0, len1, Lt)] });
    for (let j = 1; j <= k1; j++) pieces.push({ kind: 'tread', ...rect(st1 * (j - 1), st1 * j, A[0], A[1]), i: ++i, dir: F.u, ...(j <= w ? { wide: plinths[j - 1].top } : {}) });
    corner([len1, innerA], [len1, outerA], [Ls, outerA], [Ls, innerA], i + 1, F.u, dirMid);
    i += c;
    const st2 = len2 / k2;
    for (let j = 1; j <= k2; j++) {
      const t0 = innerA + (innerB - innerA) * ((j - 1) / k2);
      const t1 = innerA + (innerB - innerA) * (j / k2);
      pieces.push({ kind: 'tread', ...rect(len1, Ls, t0, t1), i: ++i, dir: dirMid });
    }
    void st2;
    corner([len1, innerB], [Ls, innerB], [Ls, outerB], [len1, outerB], i + 1, dirMid, neg(F.u));
    i += c;
    const st3 = k3 ? len1 / k3 : 0;
    for (let j = 1; j <= k3; j++) pieces.push({ kind: 'tread', ...rect(len1 - st3 * (j - 1), len1 - st3 * j, B[0], B[1]), i: ++i, dir: neg(F.u) });
    // 中央の吹抜（脇の列があるときだけ。脇の列が無ければ、列の手前はそのまま廊下・ホール）
    return len1 > 0 ? { n: i, pieces, well: rect(0, len1, Math.min(innerA, innerB), Math.max(innerA, innerB)), ...(plinths.length ? { plinths } : {}) } : { n: i, pieces };
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
  const ctr = (p: { minX: number; minY: number; maxX: number; maxY: number; poly?: { x: number; y: number }[] }) =>
    p.poly?.length ? { x: p.poly.reduce((a, q) => a + q.x, 0) / p.poly.length, y: p.poly.reduce((a, q) => a + q.y, 0) / p.poly.length } : { x: (p.minX + p.maxX) / 2, y: (p.minY + p.maxY) / 2 };
  const risers: StairDrawing['risers'] = [];
  const edges: StairDrawing['edges'] = [];
  pieces.forEach((p, k) => {
    const above = cutAt >= 0 && k > cutAt;
    const d = p.dir;
    if (p.poly && p.poly.length >= 3) {
      // 回り段: 上がる縁（最初の 2 点）が段鼻の線。残りの辺は外形（軸から出る放射の辺は、次の段の段鼻として描かれる）
      risers.push({ a: p.poly[0], b: p.poly[1], above });
      for (let q = 1; q + 1 < p.poly.length; q++) edges.push({ a: p.poly[q], b: p.poly[q + 1], above });
      return;
    }
    // 段鼻: 段の「昇った先」の辺（dir と直交）。踊り場は 4 辺とも外形
    const horiz = Math.abs(d.x) > 0.5;
    if (p.kind === 'tread') {
      // 昇り口の広い段（ひな壇）は、台の縁を別に引く（下の plinths）
      if (p.wide) return;
      const front = horiz ? (d.x > 0 ? p.maxX : p.minX) : d.y > 0 ? p.maxY : p.minY;
      risers.push(horiz ? { a: { x: front, y: p.minY }, b: { x: front, y: p.maxY }, above } : { a: { x: p.minX, y: front }, b: { x: p.maxX, y: front }, above });
      // 最初の段（ひな壇のすぐ先の段も）は、その段に上がる線も
      if (k === 0 || pieces[k - 1].wide) {
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
  // 昇り口の広い段（ひな壇）: 台の手前の縁と、空いている脇の縁（切断線より下なので実線）
  for (const pl of lay.plinths ?? []) for (const ln of pl.lines) risers.push({ a: ln.a, b: ln.b, above: false });
  // 歩行線
  let walkPath = '';
  const treads = pieces.map((p, k) => ({ p, k, c: ctr(p) }));
  const sameDir = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
  let prev: { x: number; y: number } | null = null;
  /** 回り段で始まる・終わる階段の、昇り口（角の升に入る縁の中央）と降り口（出る縁の中央） */
  let startPt: { x: number; y: number } | null = null;
  let endPt: { x: number; y: number } | null = null;
  const mid2 = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
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
    if (t.p.kind === 'winder' && t.p.poly) {
      // 回り段の角: 手前の列の中心線から先の列の中心線へ、角で 1/4 円に回る（段の重心を結ぶと角がふくらんで見える）。
      // 階段が回り段で始まる・終わるときは、角の升に入る縁・出る縁の中央から
      let e = k;
      while (e + 1 < treads.length && treads[e + 1].p.kind === 'winder') e++;
      const nxt = treads[e + 1];
      const lp = treads[e].p.poly ?? t.p.poly;
      const inPt: { x: number; y: number } = prev ?? mid2(t.p.poly[0], t.p.poly[1]);
      const outPt = nxt ? nxt.c : mid2(lp[0], lp[lp.length - 1]);
      const d1 = k > 0 ? treads[k - 1].p.dir : t.p.dir;
      const d2 = nxt ? nxt.p.dir : treads[e].p.dir;
      const det = d1.x * d2.y - d1.y * d2.x;
      if (Math.abs(det) > 0.5) {
        const rx = outPt.x - inPt.x;
        const ry = outPt.y - inPt.y;
        const a = (rx * d2.y - ry * d2.x) / det;
        const b = (d1.y * rx - d1.x * ry) / det;
        // ○ と矢じりの分だけ、まっすぐな所を残す
        const r = Math.min(a - (prev ? 0 : 80), -b - (nxt ? 0 : 170));
        if (r > 60) {
          const corner = { x: inPt.x + d1.x * a, y: inPt.y + d1.y * a };
          const p1 = { x: corner.x - d1.x * r, y: corner.y - d1.y * r };
          const p2 = { x: corner.x + d2.x * r, y: corner.y + d2.y * r };
          if (!prev) {
            walkPath = `M${inPt.x.toFixed(0)} ${inPt.y.toFixed(0)}`;
            startPt = inPt;
          }
          walkPath += ` L${p1.x.toFixed(0)} ${p1.y.toFixed(0)} A${r.toFixed(0)} ${r.toFixed(0)} 0 0 ${det > 0 ? 1 : 0} ${p2.x.toFixed(0)} ${p2.y.toFixed(0)}`;
          prev = p2;
          if (!nxt) endPt = outPt;
          k = e;
          continue;
        }
      }
    }
    walkPath += prev ? ` L${t.c.x.toFixed(0)} ${t.c.y.toFixed(0)}` : `M${t.c.x.toFixed(0)} ${t.c.y.toFixed(0)}`;
    prev = t.c;
  }
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  const c0 = startPt ?? ctr(first);
  const c1 = ctr(last);
  const dl = last.dir;
  // 矢じりは最後の段の先端（段鼻）まで伸ばす
  const lastFront = Math.abs(dl.x) > 0.5 ? Math.abs((dl.x > 0 ? last.maxX : last.minX) - c1.x) : Math.abs((dl.y > 0 ? last.maxY : last.minY) - c1.y);
  const tipLen = Math.max(120, lastFront - 20);
  const tip = endPt ? { x: endPt.x - dl.x * 20, y: endPt.y - dl.y * 20 } : { x: c1.x + dl.x * tipLen, y: c1.y + dl.y * tipLen };
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
  const lead = startPt ? 240 : 60;
  const label = { x: c0.x + perp.x * 230 + d0.x * lead, y: c0.y + perp.y * 230 + d0.y * lead, angle, text: `${st.goesUp ? 'UP' : 'DN'} ${n}` };
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
