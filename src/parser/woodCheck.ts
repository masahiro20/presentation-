/**
 * 木造（在来軸組）の常識チェック。設計士が図面を見たときの違和感をルールにする:
 *  - 壁の端は柱で止まる → 格子点にない短い壁の断片は読み取りミスの疑い
 *  - 2 階の壁は 1 階の壁（または梁）の上に乗る → 直下率、外壁の持ち出し
 *  - 梁のスパンは 2 間（3,640）まで → 超える部屋は柱か大きな梁
 *  - 一面が窓ばかりの外壁は耐力壁が取れない
 *  - 出入口の無い部屋、上下階で位置の合わない階段、UB・便所の格子寸法
 *  - 通れない幅（廊下・ホール・階段は柱芯 910 が最小）、幅 600 未満の戸、同じ場所に重なった壁
 * 構造計算（壁量計算・許容応力度）ではなく、読み取りの検算と設計の注意点を出す
 */
import type { BuildingModel, Floor, Room, Vec2, Wall } from '../core/types';
import { distPointSegment, pointInPolygon } from '../core/geometry';
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

/**
 * 部屋の一番狭い幅（芯々 mm）: 向かい合う平行な辺の距離の最小。L 字の廊下でも細い所を拾う。
 * 戻り値はその幅と、位置を示す線（狭い辺）
 */
function narrowestWidth(poly: Vec2[]): { width: number; a: Vec2; b: Vec2 } | null {
  let best: { width: number; a: Vec2; b: Vec2 } | null = null;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 400) continue;
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const c = poly[j];
      const d = poly[(j + 1) % n];
      const M = Math.hypot(d.x - c.x, d.y - c.y);
      if (M < 400) continue;
      const vx = (d.x - c.x) / M;
      const vy = (d.y - c.y) / M;
      // 平行で向かい合う（向きが逆）辺
      if (ux * vx + uy * vy > -0.98) continue;
      // 辺 i の中点が辺 j の範囲に入り、2 辺の重なりが 600 以上（通路らしい長さ）
      const t = ((mx - c.x) * vx + (my - c.y) * vy) / M;
      if (t < 0 || t > 1) continue;
      const ta = (a.x - c.x) * vx + (a.y - c.y) * vy;
      const tb = (b.x - c.x) * vx + (b.y - c.y) * vy;
      const overlap = Math.min(M, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb));
      if (overlap < 600) continue;
      const dist = Math.abs((mx - c.x) * -vy + (my - c.y) * vx);
      // 300 未満は通路ではなく輪郭の段差（框・壁の出入り）
      if (dist < 300) continue;
      // 間に他の辺が無い（中点どうしを結ぶ線の中央が多角形の内側）
      const px = c.x + vx * M * t;
      const py = c.y + vy * M * t;
      const q = { x: (mx + px) / 2, y: (my + py) / 2 };
      if (!pointInPolygon(q, poly)) continue;
      if (!best || dist < best.width) best = { width: dist, a, b };
    }
  }
  return best;
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
  // (i) 通れない幅: 廊下・ホール・玄関・階段の一番狭い所と、部屋の幅（物入・収納は 455 でも成り立つので除く）
  for (const f of floors) {
    for (const r of f.rooms) {
      if (['void', 'balcony', 'porch', 'garage', 'closet', 'storage', 'toilet', 'bath'].includes(r.type)) continue;
      const nw = narrowestWidth(r.polygon);
      if (!nw) continue;
      const clear = nw.width - 130;
      const passage = r.type === 'hall' || r.type === 'entrance' || r.type === 'stairs';
      const mark: WoodMark = { level: f.level, lines: [{ a: nw.a, b: nw.b }], label: `幅 ${m(nw.width)} m（内法 約 ${m(Math.max(0, clear))} m）` };
      if (passage && nw.width < 700) {
        out.push({ id: `narrow-${f.level}-${r.id}`, level: f.level, severity: 'warn', title: `${f.level}階 ${r.name}: 幅 ${m(nw.width)} m では通れません`, detail: `柱芯 ${Math.round(nw.width)} だと内法は約 ${Math.round(Math.max(0, clear))} です。廊下は柱芯 910（内法 780）が最小で、車いすや家具の搬入を考えると 1,000 以上が目安です。壁の読み取りがずれているか、本当に狭い場合は間取りの見直しになります`, marks: [mark] });
      } else if (passage && nw.width < 880) {
        out.push({ id: `narrow-${f.level}-${r.id}`, level: f.level, severity: 'info', title: `${f.level}階 ${r.name}: 幅 ${m(nw.width)} m は少し狭い通路です`, detail: `内法が約 ${Math.round(clear)} で、910 モジュール（内法 780）より狭くなっています。格子（455）に乗らない幅なので、壁の読み取りのずれの可能性もあります。手すりを付けると更に 50 狭くなります`, marks: [mark] });
      } else if (!passage && nw.width < 600 && r.area >= 1.2) {
        out.push({ id: `narrow-${f.level}-${r.id}`, level: f.level, severity: 'warn', title: `${f.level}階 ${r.name}: 幅 ${m(nw.width)} m の部分は使えません`, detail: `柱芯 ${Math.round(nw.width)}（内法 約 ${Math.round(Math.max(0, clear))}）の細い部分があります。壁の読み取りがずれているか、余分な壁を読んでいる可能性があります。修正画面で確認してください`, marks: [mark] });
      }
    }
  }

  // (j) 戸の幅: 550 未満の戸は通れない（便所でも 650 以上）。記号の読み取りミスが多い
  for (const f of floors) {
    const storages = f.rooms.filter((r) => r.type === 'closet' || r.type === 'storage');
    const segOf = (o: { wallId: string; t0: number; t1: number }) => {
      const w = f.walls.find((x) => x.id === o.wallId);
      if (!w) return null;
      const L = len(w) || 1;
      const at = (t: number) => ({ x: w.a.x + ((w.b.x - w.a.x) * t) / L, y: w.a.y + ((w.b.y - w.a.y) * t) / L });
      return { a: at(o.t0), b: at(o.t1) };
    };
    // 物入・収納の戸（455 の片開き・折れ戸）は狭くても成り立つので除く
    const intoStorage = (seg: { a: Vec2; b: Vec2 }) => {
      const c = { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
      return storages.some((r) => r.polygon.some((p, i) => distPointSegment(c, p, r.polygon[(i + 1) % r.polygon.length]) <= 250));
    };
    const narrow = f.openings.filter((o) => {
      if (o.kind === 'window' || o.kind === 'open' || o.t1 - o.t0 >= 550) return false;
      const seg = segOf(o);
      return !!seg && !intoStorage(seg);
    });
    if (!narrow.length) continue;
    const lines = narrow.map(segOf).filter((x): x is { a: Vec2; b: Vec2 } => !!x);
    out.push({
      id: `door-${f.level}`,
      level: f.level,
      severity: 'warn',
      title: `${f.level}階: 幅 0.55 m 未満の戸が ${narrow.length} か所`,
      detail: `${narrow.map((o) => `${Math.round(o.t1 - o.t0)}`).join('・')} mm の戸があります。戸は便所でも 650 以上、居室は 750〜800 が標準です。戸の記号（円弧・引戸の線）を小さく読んだ可能性があります。修正画面で戸を置き直してください`,
      marks: [{ level: f.level, lines, label: '狭い戸' }],
    });
  }

  // (k) 二重の壁: 平行で近く（芯々 60〜230）、長さが重なる壁の組は、同じ壁を 2 回読んだ疑い
  for (const f of floors) {
    const dup: { keep: Wall; drop: Wall }[] = [];
    const seen = new Set<string>();
    for (const w of f.walls) {
      const L = len(w);
      if (L < 600) continue;
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      for (const v of f.walls) {
        if (v === w || seen.has(`${v.id}|${w.id}`)) continue;
        const M = len(v);
        if (M < 600) continue;
        const vx = (v.b.x - v.a.x) / M;
        const vy = (v.b.y - v.a.y) / M;
        if (Math.abs(ux * vx + uy * vy) < 0.995) continue;
        // 芯々の距離（v の中点から w の直線へ）
        const mx = (v.a.x + v.b.x) / 2 - w.a.x;
        const my = (v.a.y + v.b.y) / 2 - w.a.y;
        const gap = Math.abs(mx * -uy + my * ux);
        if (gap < 60 || gap > 230) continue;
        // 長さの重なり
        const t0 = Math.min((v.a.x - w.a.x) * ux + (v.a.y - w.a.y) * uy, (v.b.x - w.a.x) * ux + (v.b.y - w.a.y) * uy);
        const t1 = Math.max((v.a.x - w.a.x) * ux + (v.a.y - w.a.y) * uy, (v.b.x - w.a.x) * ux + (v.b.y - w.a.y) * uy);
        const ov = Math.min(L, t1) - Math.max(0, t0);
        if (ov < 600 || ov < Math.min(L, M) * 0.6) continue;
        // 両方が外壁（二重壁の納まり）は対象外。外壁と内壁なら内壁を、同じなら短い方を消す候補にする
        if (w.exterior && v.exterior) continue;
        seen.add(`${w.id}|${v.id}`);
        const drop = w.exterior ? v : v.exterior ? w : L >= M ? v : w;
        dup.push({ keep: drop === v ? w : v, drop });
      }
    }
    if (dup.length) {
      const ids = new Set(dup.map((d) => d.drop.id));
      out.push({
        id: `dup-${f.level}`,
        level: f.level,
        severity: 'warn',
        title: `${f.level}階: 重なった壁が ${dup.length} 組`,
        detail: '同じ場所に平行な壁が 2 本あります（芯々 60〜230）。壁の両面の線を別々の壁と読んだか、仕上げ線・巾木の線を壁と読んだ疑いがあります。3D では壁が厚く見えたり、隙間ができたりします',
        marks: [{ level: f.level, lines: dup.map((d) => ({ a: d.drop.a, b: d.drop.b })), label: '重なった壁' }],
        fix: {
          label: '片方を消す',
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
  return out;
}
