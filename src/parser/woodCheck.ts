/**
 * 木造（在来軸組）の常識チェック。設計士が図面を見たときの違和感をルールにする:
 *  - 壁の端は柱で止まる → 格子点にない短い壁の断片は読み取りミスの疑い
 *  - 2 階の壁は 1 階の壁（または梁）の上に乗る → 直下率、外壁の持ち出し
 *  - 梁のスパンは 2 間（3,640）まで → 超える部屋は柱か大きな梁
 *  - 一面が窓ばかりの外壁は耐力壁が取れない
 *  - 出入口の無い部屋、上下階で位置の合わない階段、UB・便所の格子寸法
 * 構造計算（壁量計算・許容応力度）ではなく、読み取りの検算と設計の注意点を出す
 */
import type { BuildingModel, Floor, Room, Vec2, Wall } from '../core/types';
import { distPointSegment } from '../core/geometry';
import { largestInnerRect } from '../core/rects';

/** 平面図に赤で示す位置（階ごと）。線は壁の区間、矩形は部屋・階段・内側の空間 */
export interface WoodMark {
  level: number;
  lines?: { a: Vec2; b: Vec2 }[];
  rects?: { minX: number; minY: number; maxX: number; maxY: number }[];
  label?: string;
}

export interface WoodIssue {
  id: string;
  level?: number;
  severity: 'warn' | 'info' | 'ok';
  title: string;
  detail: string;
  /** 明らかな読み取りミスを直す */
  fix?: { label: string; apply: (m: BuildingModel) => void };
  /** 平面図に示す位置 */
  marks?: WoodMark[];
}

const len = (w: { a: Vec2; b: Vec2 }) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
const m = (mm: number) => (mm / 1000).toFixed(2);

/** 壁の線分のうち、下階の壁の上に乗っている長さ（200mm ごとに判定） */
function supportedLength(w: Wall, below: Wall[]): number {
  const L = len(w);
  const n = Math.max(1, Math.round(L / 200));
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const p = { x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t };
    if (below.some((b) => distPointSegment(p, b.a, b.b) <= 90)) ok++;
  }
  return (ok / n) * L;
}

/** 下階の壁に乗っていない区間（200mm 刻みの判定をつなげた線分）。短い区間（< 300）は省く */
function unsupportedSegments(w: Wall, below: Wall[]): { a: Vec2; b: Vec2 }[] {
  const L = len(w);
  const n = Math.max(1, Math.round(L / 200));
  const at = (t: number) => ({ x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t });
  const out: { a: Vec2; b: Vec2 }[] = [];
  let start: number | null = null;
  for (let i = 0; i <= n; i++) {
    const free = i < n && !below.some((b) => distPointSegment(at((i + 0.5) / n), b.a, b.b) <= 90);
    if (free && start == null) start = i / n;
    if (!free && start != null) {
      if ((i / n - start) * L >= 300) out.push({ a: at(start), b: at(i / n) });
      start = null;
    }
  }
  return out;
}

function bboxOf(poly: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** 部屋の輪郭の辺ごとに、壁で塞がれている割合と、その辺にある出入口 */
function roomAccess(r: Room, f: Floor): { hasDoor: boolean; hasOpenEdge: boolean } {
  const poly = r.polygon;
  let hasDoor = false;
  let hasOpenEdge = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 300) continue;
    // この辺に沿う壁
    const along = f.walls.filter((w) => distPointSegment(w.a, a, b) <= 160 && distPointSegment(w.b, a, b) <= 160);
    const covered = along.reduce((s, w) => s + len(w), 0);
    if (covered < L * 0.5) {
      hasOpenEdge = true;
      continue;
    }
    for (const w of along) {
      const wl = len(w);
      for (const o of f.openings) {
        if (o.wallId !== w.id || o.kind === 'window') continue;
        const t = (o.t0 + o.t1) / 2 / (wl || 1);
        const c = { x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t };
        if (distPointSegment(c, a, b) <= 200) hasDoor = true;
      }
    }
  }
  return { hasDoor, hasOpenEdge };
}

export function woodCheck(model: BuildingModel): WoodIssue[] {
  const out: WoodIssue[] = [];
  const floors = model.floors;
  const grid = model.module?.grid ?? 455;
  const phaseX = model.module?.phaseX ?? 0;
  const phaseY = model.module?.phaseY ?? 0;
  const onGrid = (v: number, phase: number) => Math.abs(phase + Math.round((v - phase) / grid) * grid - v) <= 100;

  // (a) 短い壁の断片: 他の壁につながらず、長さが半間に満たない
  for (const f of floors) {
    const stubs = f.walls.filter((w) => len(w) < 455 && !w.joinedA && !w.joinedB && !f.openings.some((o) => o.wallId === w.id));
    if (stubs.length) {
      const ids = new Set(stubs.map((w) => w.id));
      out.push({
        id: `stub-${f.level}`,
        level: f.level,
        severity: 'warn',
        title: `${f.level}階: どこにもつながらない短い壁が ${stubs.length} 本`,
        detail: '木造の壁は柱から柱へ通るので、半間に満たない独立した壁は図面の線（家具・寸法補助線）を壁と読んだ疑いがあります',
        marks: [{ level: f.level, lines: stubs.map((w) => ({ a: w.a, b: w.b })), label: '壁の断片' }],
        fix: {
          label: '消す',
          apply: (mm) => {
            const fl = mm.floors.find((x) => x.level === f.level);
            if (!fl) return;
            fl.walls = fl.walls.filter((w) => !ids.has(w.id));
            fl.openings = fl.openings.filter((o) => !ids.has(o.wallId));
          },
        },
      });
    }
  }

  // (b) 壁の端が格子に乗らない（モジュールに寄せた図面で、自由な端）
  if (model.module?.snapped) {
    for (const f of floors) {
      const off = f.walls.filter((w) => {
        const horiz = Math.abs(w.a.y - w.b.y) < 1;
        const vert = Math.abs(w.a.x - w.b.x) < 1;
        if (!horiz && !vert) return false;
        const free = [!w.joinedA ? w.a : null, !w.joinedB ? w.b : null].filter((p): p is Vec2 => !!p);
        return free.some((p) => (horiz ? !onGrid(p.x, phaseX) : !onGrid(p.y, phaseY)));
      });
      if (off.length >= 2) {
        const ends = off.flatMap((w) => [!w.joinedA ? w.a : null, !w.joinedB ? w.b : null].filter((p): p is Vec2 => !!p));
        out.push({
          id: `offgrid-${f.level}`,
          level: f.level,
          severity: 'info',
          title: `${f.level}階: 端が格子（半間）に乗らない壁が ${off.length} 本`,
          detail: '壁の端には柱が立つので、ふつう半間の格子点で止まります。腰壁・造作の可能性もありますが、読み取りの端のずれなら修正画面で直せます',
          marks: [{ level: f.level, rects: ends.map((p) => ({ minX: p.x - 160, minY: p.y - 160, maxX: p.x + 160, maxY: p.y + 160 })), label: '格子外の端' }],
        });
      }
    }
  }

  // (c) 直下率: 上階の壁が下階の壁の上に乗っている割合。外壁の持ち出しは別に出す
  for (let i = 1; i < floors.length; i++) {
    const up = floors[i];
    const lo = floors[i - 1];
    let total = 0;
    let sup = 0;
    let extTotal = 0;
    let extSup = 0;
    const hanging: { w: Wall; free: number }[] = [];
    const freeAll: { a: Vec2; b: Vec2 }[] = [];
    const freeExt: { a: Vec2; b: Vec2 }[] = [];
    for (const w of up.walls) {
      const L = len(w);
      if (L < 300) continue;
      const s = supportedLength(w, lo.walls);
      total += L;
      sup += s;
      const segs = unsupportedSegments(w, lo.walls);
      freeAll.push(...segs);
      if (w.exterior) {
        extTotal += L;
        extSup += s;
        if (L - s >= 910) {
          hanging.push({ w, free: L - s });
          freeExt.push(...segs);
        }
      }
    }
    if (total > 0) {
      const ratio = sup / total;
      out.push({
        id: `shita-${up.level}`,
        level: up.level,
        severity: ratio < 0.5 ? 'warn' : ratio < 0.6 ? 'info' : 'ok',
        title: `${up.level}階の壁の直下率 ${Math.round(ratio * 100)}%`,
        detail: ratio >= 0.6 ? `${up.level}階の壁の ${Math.round(ratio * 100)}% が ${lo.level}階の壁の上に乗っています（目安 60% 以上）` : `${up.level}階の壁のうち ${lo.level}階の壁に乗っているのは ${Math.round(ratio * 100)}% です。乗っていない壁の下には梁が必要になり、梁せいが大きくなります（目安 60% 以上）`,
        marks: freeAll.length ? [{ level: up.level, lines: freeAll, label: `${lo.level}階に壁なし（梁で受ける）` }] : undefined,
      });
    }
    if (hanging.length) {
      const hl = hanging.reduce((s, h) => s + h.free, 0);
      const sideName = (w: Wall) => {
        const L = len(w);
        const ux = (w.b.x - w.a.x) / L;
        const uy = (w.b.y - w.a.y) / L;
        const nx = Math.round(-uy * (w.outsideSign ?? 1));
        const ny = Math.round(ux * (w.outsideSign ?? 1));
        return ny < 0 ? '上' : ny > 0 ? '下' : nx < 0 ? '左' : '右';
      };
      const sides = [...new Set(hanging.map((h) => sideName(h.w)))].map((n) => `図面の${n}側`).join('・');
      const share = extTotal > 0 ? hl / extTotal : 0;
      out.push({
        id: `overhang-${up.level}`,
        level: up.level,
        severity: share > 0.4 ? 'warn' : 'info',
        title: `${up.level}階の外壁 ${m(hl)} m（${sides}）の下に ${lo.level}階の壁がありません`,
        detail:
          share > 0.4
            ? `${up.level}階の外壁の ${Math.round(share * 100)}% が ${lo.level}階の壁に乗っていません。大きな LDK の上に 2 階を載せる場合は、その位置に梁（集成材の大梁）か柱が必要です。${lo.level}階の壁の読み落としの可能性もあるので、修正画面で確認してください`
            : `その区間は ${lo.level}階に受ける壁が無いので、梁で受けるか張り出し（オーバーハング、910 まで）になります`,
        marks: [
          { level: up.level, lines: freeExt, label: `${lo.level}階に壁なし` },
          { level: lo.level, lines: freeExt, label: `${up.level}階の外壁がここに乗る（壁か梁が必要）` },
        ],
      });
    }
    void extSup;
  }

  // (d) 梁のスパン: 部屋の内側の矩形の短辺が 2 間（3,640）を超える
  for (const f of floors) {
    for (const r of f.rooms) {
      if (['void', 'balcony', 'porch', 'garage', 'closet', 'storage', 'stairs'].includes(r.type)) continue;
      const inner = largestInnerRect(r.polygon, 5);
      if (!inner) continue;
      const short = Math.min(inner.maxX - inner.minX, inner.maxY - inner.minY) + (model.module ? 130 : 0);
      const marks: WoodMark[] = [{ level: f.level, rects: [{ minX: inner.minX, minY: inner.minY, maxX: inner.maxX, maxY: inner.maxY }], label: `スパン ${m(short)} m` }];
      if (short > 5000) out.push({ id: `span-${f.level}-${r.id}`, level: f.level, severity: 'warn', title: `${f.level}階 ${r.name}: 柱の無い空間が ${m(short)} m`, detail: '短辺が 2.75 間（5,005）を超えています。在来の梁では厳しい大きさなので、途中に柱を立てるか、集成材の大梁・鉄骨梁の検討になります', marks });
      else if (short > 3700) out.push({ id: `span-${f.level}-${r.id}`, level: f.level, severity: 'info', title: `${f.level}階 ${r.name}: 梁のスパン ${m(short)} m（2 間超）`, detail: '2 間（3,640）を超えるので、せいの大きな梁（集成材 300〜360）か途中の柱が必要です。吹抜・大きな LDK ではよくある納まりです', marks });
    }
  }

  // (e) 窓ばかりの外壁面: 向きごとに外壁の長さと開口の長さ
  for (const f of floors) {
    const dirs: Record<string, { total: number; open: number; walls: Wall[] }> = {};
    const name: Record<string, string> = { '0,-1': '図面の上', '0,1': '図面の下', '-1,0': '図面の左', '1,0': '図面の右' };
    for (const w of f.walls) {
      if (!w.exterior || !w.outsideSign) continue;
      const L = len(w);
      if (L < 300) continue;
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      // 外側の法線 = perp(u) × outsideSign
      const nx = Math.round(-uy * w.outsideSign);
      const ny = Math.round(ux * w.outsideSign);
      const key = `${nx},${ny}`;
      const d = (dirs[key] ??= { total: 0, open: 0, walls: [] });
      d.total += L;
      d.walls.push(w);
      for (const o of f.openings) if (o.wallId === w.id) d.open += o.t1 - o.t0;
    }
    for (const [key, d] of Object.entries(dirs)) {
      if (d.total < 3000) continue;
      const ratio = d.open / d.total;
      if (ratio > 0.65) out.push({ id: `shear-${f.level}-${key}`, level: f.level, severity: 'warn', title: `${f.level}階 ${name[key] ?? key}側の外壁は開口が ${Math.round(ratio * 100)}%`, detail: '一面の大半が窓・戸だと、その方向の耐力壁が取りにくくなります。窓の間に 910 の壁を残すか、反対側の壁で補う設計になります', marks: [{ level: f.level, lines: d.walls.map((w) => ({ a: w.a, b: w.b })), label: `開口 ${Math.round(ratio * 100)}%（耐力壁が取りにくい）` }] });
    }
  }

  // (f) 出入口の無い部屋
  for (const f of floors) {
    for (const r of f.rooms) {
      if (['void', 'balcony', 'porch', 'garage', 'stairs', 'hall', 'other'].includes(r.type)) continue;
      if (r.area < 1.2) continue;
      const { hasDoor, hasOpenEdge } = roomAccess(r, f);
      if (!hasDoor && !hasOpenEdge) out.push({ id: `nodoor-${f.level}-${r.id}`, level: f.level, severity: 'warn', title: `${f.level}階 ${r.name}: 出入口が読めていません`, detail: '壁に囲まれていて戸が見つかりません。引戸・開き戸の記号が読めなかったか、壁を読みすぎています。修正画面で戸を置くか壁を消してください', marks: [{ level: f.level, rects: [bboxOf(r.polygon)], label: '出入口なし' }] });
    }
  }

  // (g) 階段の上下階の位置
  for (let i = 0; i + 1 < floors.length; i++) {
    const lo = floors[i];
    const up = floors[i + 1];
    for (const s of lo.stairs.filter((x) => x.goesUp)) {
      const best = up.stairs.reduce((b, t) => {
        const ix = Math.max(0, Math.min(s.maxX, t.maxX) - Math.max(s.minX, t.minX));
        const iy = Math.max(0, Math.min(s.maxY, t.maxY) - Math.max(s.minY, t.minY));
        const a = (ix * iy) / Math.min((s.maxX - s.minX) * (s.maxY - s.minY), (t.maxX - t.minX) * (t.maxY - t.minY));
        return Math.max(b, a);
      }, 0);
      const sRect = { minX: s.minX, minY: s.minY, maxX: s.maxX, maxY: s.maxY };
      if (up.stairs.length && best < 0.3)
        out.push({
          id: `stair-${lo.level}`,
          level: lo.level,
          severity: 'warn',
          title: `${lo.level}階と ${up.level}階の階段の位置が合っていません`,
          detail: `重なりが ${Math.round(best * 100)}% です。どちらかの階段の読み取り位置がずれているか、別の階段です。修正画面の階段ツールで合わせてください`,
          marks: [
            { level: lo.level, rects: [sRect], label: `${lo.level}階の階段` },
            { level: up.level, rects: up.stairs.map((t) => ({ minX: t.minX, minY: t.minY, maxX: t.maxX, maxY: t.maxY })), label: `${up.level}階の階段（${lo.level}階とずれ）` },
          ],
        });
      else if (!up.stairs.length) out.push({ id: `stair-${lo.level}`, level: lo.level, severity: 'info', title: `${up.level}階に階段の降り口が読めていません`, detail: `${lo.level}階の階段の上に ${up.level}階の階段（DN）がありません。吹抜・ホールとして読まれた可能性があります`, marks: [{ level: lo.level, rects: [sRect], label: '階段' }, { level: up.level, rects: [sRect], label: `${lo.level}階の階段の真上（降り口が無い）` }] });
    }
  }

  // (h) UB・便所の格子寸法
  for (const f of floors) {
    for (const r of f.rooms) {
      const xs = r.polygon.map((p) => p.x);
      const ys = r.polygon.map((p) => p.y);
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      const short = Math.min(w, h);
      const marks: WoodMark[] = [{ level: f.level, rects: [{ minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }], label: `短辺 ${m(short)} m` }];
      if (r.type === 'bath' && short < 1700 && short > 0) out.push({ id: `ub-${f.level}-${r.id}`, level: f.level, severity: 'warn', title: `${f.level}階 ${r.name}: 短辺 ${m(short)} m では UB 1616 が入りません`, detail: 'ユニットバス 1616 は柱芯 1,820×1,820（内法 1,600）が必要です。1 坪より小さい区画は読み取りの壁のずれか、1216・1317 などの小さいサイズになります', marks });
      if (r.type === 'toilet' && short < 800 && short > 0) out.push({ id: `wc-${f.level}-${r.id}`, level: f.level, severity: 'warn', title: `${f.level}階 ${r.name}: 幅 ${m(short)} m は便所として狭すぎます`, detail: '便所は柱芯 910（内法 780 前後）が最小です。壁の読み取りがずれている可能性があります', marks });
    }
  }
  return out;
}
