/**
 * 立面図の屋根の線から、屋根の塊ごとの掛け方（片流れの高い側・切妻の棟の向き・寄棟・勾配）を読む。
 *
 * 平面図には屋根の形が無いので、3D の屋根はこれまで外観テイストの掛け方（最上階）と
 * 「上の階に接する側が高い片流れ」（下屋）の推定だった。立面図では、屋根を横から見た面に屋根の端が斜めの線で描かれる:
 *   - 片流れ: 流れの向きに平行な 2 面（例: 東・西）に、屋根の端から端まで 1 本の斜めの線。上がる向きが高い側。残りの 2 面では水平
 *   - 切妻: 妻側の 2 面に、両端から上がって真ん中で出会う 2 本（山形）。棟は見ている向きに通る
 *   - 寄棟: どの面でも、両端から上がって水平な棟でつながる台形（正方形に近ければ山形）
 * 屋根の塊（階の外形のうち上の階が載らない範囲。3D の屋根と同じ分け方: core/roofGrid）ごとに、
 * 塊の左右の端に合う線を探して掛け方を決める。端が合わない線（塊の一部だけに掛かる屋根・振れた棟の屋根）や、
 * 面どうしで食い違う塊は決めずに、今までの推定のままにする。
 */
import type { Floor, RoofHigh, RoofKind, RoofPatch, Vec2 } from '../core/types';
import type { Rect } from '../core/rects';
import { cellIndex, compCenter, floorGrid, manualLoopsOf, maskComponents, patchFor, type RoofComp } from '../core/roofGrid';
import { AXES, axisForFacing, chooseAxes, facadeExtent, FACING_JA, type ElevationView, type Facing, type RoofLine } from './elevationWindows';

export interface RoofHint {
  level: number;
  isTop: boolean;
  /** 塊の中の点（手直しの目印） */
  at: Vec2;
  bbox: Rect;
  kind: RoofKind;
  /** 片流れの高い側（図面の上 n・下 s・右 e・左 w） */
  high?: RoofHigh;
  /** 切妻の棟の向き（x = 図面の横に棟、z = 縦に棟） */
  ridge?: 'x' | 'z';
  /** 勾配（寸。0.5 刻み） */
  pitch: number;
  /** 根拠になった面 */
  facings: Facing[];
}

interface Mass {
  level: number;
  isTop: boolean;
  comp: RoofComp;
  /** 壁の天端の高さ（GL から mm）。屋根の線の低い側の端はこの近くにある */
  wallTop: number;
  at: Vec2;
}

type Line = RoofLine & { s0: number; s1: number; k: number };

interface Evidence {
  m: Mass;
  facing: Facing;
  /** 面の左右が図面の x に沿う（上・下の面）か y に沿う（左・右の面）か */
  along: 'x' | 'y';
  kind: 'shed' | 'gable' | 'trap';
  high?: RoofHigh;
  /** 勾配（立ち上がり / 水平） */
  k: number;
}

/**
 * 塊の端から屋根の線の端までのずれの許容: 内側へ 450mm（読み取りのずれ）、外側へ 1.5m（軒・けらばの出）。
 * 幅の狭い塊（塔屋・小さな下屋）は幅に合わせて狭める（幅の 1/4・幅の 1/2。外側は 600mm を下回らない）
 */
const tolIn = (span: number) => Math.min(450, span * 0.25);
const tolOut = (span: number) => Math.min(1500, Math.max(600, span * 0.5));

/** 屋根の塊（3D の屋根と同じ分け方）。3㎡ に満たない細い残りは見ない */
function massesOf(floors: Floor[]): Mass[] {
  const out: Mass[] = [];
  floors.forEach((f, k) => {
    const g = floorGrid(floors, k);
    if (g.nx <= 0 || g.nz <= 0) return;
    const isTop = k === floors.length - 1;
    const wallTop = isTop ? f.elevation + (f.height > 0 ? f.height : 2750) : floors[k + 1].elevation;
    for (const comp of maskComponents(g.xs, g.zs, g.mask)) {
      const area = comp.rects.reduce((s, r) => s + (r.maxX - r.minX) * (r.maxY - r.minY), 0);
      if (area < 3e6) continue;
      out.push({ level: f.level, isTop, comp, wallTop, at: compCenter(comp) });
    }
  });
  return out;
}

/** 面の右手の向き r に沿って上がる・下がるときの、高い側の辺 */
function highSide(r: Vec2, up: boolean): RoofHigh {
  const d = up ? r : { x: -r.x, y: -r.y };
  return Math.abs(d.x) >= Math.abs(d.y) ? (d.x > 0 ? 'e' : 'w') : d.y < 0 ? 'n' : 's';
}

/**
 * 立面図の屋根の線から、屋根の塊ごとの掛け方を読む。
 * 向きを窓の並びで確かめられた面が 1 つも無いとき（立面図と平面図が合っていない）は何も返さない。
 * @param heightsKnown 階の高さを立面図の寸法から読めているか。読めていなければ（標準値の推定）、屋根の線の高さの照合を緩める
 */
export function roofHintsFromElevation(floorsIn: Floor[], views: ElevationView[], northDeg: number, heightsKnown = true): RoofHint[] {
  if ((globalThis as { __NO_ELEV_ROOF?: boolean }).__NO_ELEV_ROOF) return [];
  const floors = [...floorsIn].sort((a, b) => a.level - b.level);
  if (!floors.length || !views.some((v) => v.roofLines?.length)) return [];
  const { axes, rotated } = chooseAxes(floors, views, northDeg);
  if (!axes.size) return [];
  // 面の当て方: 窓で当てた面はその位置。窓の組が無い面は見出しの向きで、外形の幅が平面図と合うときだけ（端をそろえて当てる）
  const placed: { v: ElevationView; axis: number; off: number }[] = [];
  const used = new Set<number>();
  for (const [v, fit] of axes) {
    used.add(fit.axis);
    if (v.roofLines?.length) placed.push({ v, axis: fit.axis, off: fit.off });
  }
  for (const v of views) {
    if (axes.has(v) || !v.roofLines?.length) continue;
    const axis = axisForFacing(v.facing, northDeg + rotated);
    if (used.has(axis)) continue;
    const [lo, hi] = facadeExtent(floors, AXES[axis].r);
    if (Math.abs(v.width / Math.max(1, hi - lo) - 1) > 0.06) continue;
    used.add(axis);
    placed.push({ v, axis, off: 0 });
  }
  const masses = massesOf(floors);
  if (!masses.length || !placed.length) return [];
  /** 確かめ用の記録（globalThis.__ELEV_ROOF_LOG に配列を置くと、面の当て方・塊・当たった線が入る） */
  const trace = (globalThis as { __ELEV_ROOF_LOG?: string[] }).__ELEV_ROOF_LOG;
  if (trace) for (const m of masses) trace.push(`塊 ${m.level}F${m.isTop ? '(最上)' : ''} x ${Math.round(m.comp.bbox.minX)}..${Math.round(m.comp.bbox.maxX)} y ${Math.round(m.comp.bbox.minY)}..${Math.round(m.comp.bbox.maxY)} 壁の天端 ${Math.round(m.wallTop)}`);

  const evs: Evidence[] = [];
  for (const p of placed) {
    const { r } = AXES[p.axis];
    const base = facadeExtent(floors, r)[0] + p.off;
    const along: 'x' | 'y' = Math.abs(r.x) > 0.5 ? 'x' : 'y';
    const lines: Line[] = p.v.roofLines!.map((l) => ({ ...l, s0: base + l.u0, s1: base + l.u1, k: (l.z1 - l.z0) / Math.max(1, l.u1 - l.u0) }));
    trace?.push(`${FACING_JA[p.v.facing]}面: 軸 ${p.axis} ずれ ${p.off} 左端 ${Math.round(base)} 線 ${lines.map((l) => `[${Math.round(l.s0)}..${Math.round(l.s1)} z ${l.z0}→${l.z1}]`).join(' ')}`);
    const found: { m: Mass; kind: Evidence['kind']; lines: Line[]; high?: RoofHigh; k: number }[] = [];
    for (const m of masses) {
      let s0 = Infinity;
      let s1 = -Infinity;
      for (const rc of m.comp.rects)
        for (const c of [
          { x: rc.minX, y: rc.minY },
          { x: rc.maxX, y: rc.maxY },
        ]) {
          const s = c.x * r.x + c.y * r.y;
          s0 = Math.min(s0, s);
          s1 = Math.max(s1, s);
        }
      if (s1 - s0 < 800) continue;
      const IN = tolIn(s1 - s0);
      const OUT = tolOut(s1 - s0);
      // 屋根の線の低い側の端は、壁の天端の近く（軒の出のぶん下がる・屋根の厚みのぶん上がる）。
      // 階の高さが標準値の推定のときは 1.4m まで（階高の半分より小さく、上下の階の屋根と取り違えない）
      const zOk = (z: number) => (heightsKnown ? z >= m.wallTop - 700 && z <= m.wallTop + 1000 : Math.abs(z - m.wallTop) <= 1400);
      const nearLo = (s: number) => s >= s0 - OUT && s <= s0 + IN;
      const nearHi = (s: number) => s >= s1 - IN && s <= s1 + OUT;
      // 片流れ: 1 本の線が塊の端から端まで
      for (const l of lines) if (zOk(Math.min(l.z0, l.z1)) && nearLo(l.s0) && nearHi(l.s1)) found.push({ m, kind: 'shed', lines: [l], high: highSide(r, l.k > 0), k: Math.abs(l.k) });
      // 切妻・寄棟: 左の端から上がる線と、右の端へ下がる線。上の端の高さがそろい、勾配がほぼ同じ
      for (const a of lines) {
        if (a.k <= 0 || !nearLo(a.s0) || !zOk(a.z0)) continue;
        for (const b of lines) {
          if (b.k >= 0 || !nearHi(b.s1) || !zOk(b.z1)) continue;
          if (b.s0 < a.s1 - 300 || Math.abs(a.z1 - b.z0) > 250) continue;
          const ka = Math.abs(a.k);
          const kb = Math.abs(b.k);
          if (Math.abs(ka - kb) > Math.max(0.03, 0.25 * Math.max(ka, kb))) continue;
          found.push({ m, kind: b.s0 - a.s1 <= 400 ? 'gable' : 'trap', lines: [a, b], k: (ka + kb) / 2 });
        }
      }
    }
    // 1 本の線が 2 つ以上の塊に当たる（手前と奥に同じ幅の塊がある）ときは、どちらの屋根か分からないので使わない
    const owners = new Map<Line, Set<Mass>>();
    for (const f of found)
      for (const l of f.lines) {
        if (!owners.has(l)) owners.set(l, new Set());
        owners.get(l)!.add(f.m);
      }
    for (const f of found) {
      const shared = f.lines.some((l) => owners.get(l)!.size > 1);
      trace?.push(`  ${FACING_JA[p.v.facing]}面 → ${f.m.level}F の塊（x ${Math.round(f.m.comp.bbox.minX)}..）: ${f.kind}${f.high ? ` 高い側 ${f.high}` : ''} 勾配 ${(f.k * 10).toFixed(2)} 寸${shared ? '（ほかの塊にも当たるので使わない）' : ''}`);
      if (shared) continue;
      evs.push({ m: f.m, facing: p.v.facing, along, kind: f.kind, high: f.high, k: f.k });
    }
  }

  const out: RoofHint[] = [];
  for (const m of masses) {
    const es = evs.filter((e) => e.m === m);
    if (!es.length) continue;
    const ks = es.map((e) => e.k).sort((a, b) => a - b);
    const pitch = Math.min(10, Math.max(0.5, Math.round(ks[Math.floor(ks.length / 2)] * 20) / 2));
    const base = { level: m.level, isTop: m.isTop, at: m.at, bbox: m.comp.bbox, pitch, facings: [...new Set(es.map((e) => e.facing))] };
    const kinds = new Set(es.map((e) => e.kind));
    if (kinds.has('shed')) {
      // 片流れ: 見えた面がみな同じ側を高いと言っていること（山形・台形の面が混じる塊は決めない）
      const highs = new Set(es.map((e) => e.high));
      if (kinds.size === 1 && highs.size === 1) out.push({ ...base, kind: 'shed', high: es[0].high });
      continue;
    }
    // 台形の面がある・直交する 2 方向とも山形（方形）なら寄棟。山形が 1 方向だけなら切妻（棟は見ている向きに通る）
    const alongs = new Set(es.map((e) => e.along));
    if (kinds.has('trap') || alongs.size === 2) out.push({ ...base, kind: 'hip' });
    else out.push({ ...base, kind: 'gable', ridge: es[0].along === 'x' ? 'z' : 'x' });
  }
  return out;
}

/**
 * 読めた掛け方を、屋根の塊ごとの手直し（model.roofPatches。source = 'elevation'）として入れる。
 * 前に立面図から入れた分は入れ直し、手で直した塊（同じ塊に手直しがある）と手で描いた屋根はそのまま残す。入れた数を返す
 */
export function applyRoofHints(model: { floors: Floor[]; roofPatches?: RoofPatch[] }, hints: RoofHint[]): number {
  const floors = [...model.floors].sort((a, b) => a.level - b.level);
  const keep = (model.roofPatches ?? []).filter((p) => p.source !== 'elevation');
  const added: RoofPatch[] = [];
  for (const h of hints) {
    const k = floors.findIndex((f) => f.level === h.level);
    if (k < 0) continue;
    const g = floorGrid(floors, k, manualLoopsOf(keep, h.level));
    const i = cellIndex(g.xs, h.at.x);
    const j = cellIndex(g.zs, h.at.y);
    const comp = i >= 0 && j >= 0 ? maskComponents(g.xs, g.zs, g.mask).find((c) => c.cells.has(j * g.nx + i)) : undefined;
    if (!comp || patchFor(keep, h.level, comp, g.xs, g.zs, g.nx)) continue;
    added.push({ id: `E${h.level}-${added.length + 1}`, level: h.level, at: { ...h.at }, kind: h.kind, ...(h.high ? { high: h.high } : {}), ...(h.ridge ? { ridge: h.ridge } : {}), pitch: h.pitch, source: 'elevation' });
  }
  const next = [...keep, ...added];
  if (next.length) model.roofPatches = next;
  else delete model.roofPatches;
  return added.length;
}

const KIND_JA: Record<RoofKind, string> = { gable: '切妻', hip: '寄棟', shed: '片流れ', flat: '陸屋根' };

/** 図面の辺（上下左右）の方位（真北が図面の上から時計回りに northDeg） */
function compassOf(side: RoofHigh, northDeg: number): string {
  const a = (northDeg * Math.PI) / 180;
  const nv = { x: Math.sin(a), y: -Math.cos(a) };
  const ev = { x: -nv.y, y: nv.x };
  const sv = { n: { x: 0, y: -1 }, s: { x: 0, y: 1 }, e: { x: 1, y: 0 }, w: { x: -1, y: 0 } }[side];
  const dn = sv.x * nv.x + sv.y * nv.y;
  const de = sv.x * ev.x + sv.y * ev.y;
  return Math.abs(dn) >= Math.abs(de) ? (dn > 0 ? '北' : '南') : de > 0 ? '東' : '西';
}

/** 人に見せる要約: 「2階の屋根 片流れ（北が高い・0.5 寸）／1階の下屋（3.6 × 5.5 m）片流れ（西が高い・0.5 寸）」 */
export function describeRoofHints(hints: RoofHint[], northDeg: number): string {
  return hints
    .map((h) => {
      const size = `${((h.bbox.maxX - h.bbox.minX) / 1000).toFixed(1)} × ${((h.bbox.maxY - h.bbox.minY) / 1000).toFixed(1)} m`;
      const name = h.isTop ? `${h.level}階の屋根` : `${h.level}階の下屋（${size}）`;
      const detail = [h.kind === 'shed' && h.high ? `${compassOf(h.high, northDeg)}が高い` : '', h.kind === 'gable' && h.ridge ? `棟は図面の${h.ridge === 'x' ? '左右' : '上下'}` : '', `${h.pitch} 寸`].filter(Boolean).join('・');
      return `${name} ${KIND_JA[h.kind]}（${detail}・${h.facings.map((f) => FACING_JA[f]).join('')}面）`;
    })
    .join('／');
}
