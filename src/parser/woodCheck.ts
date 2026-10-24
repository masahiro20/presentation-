/**
 * 木造（在来軸組）の常識チェック。設計士が図面を見たときの違和感をルールにする:
 *  - 壁の端は柱で止まる → 格子点にない短い壁の断片は読み取りミスの疑い
 *  - 2 階の壁は 1 階の壁（または梁）の上に乗る → 直下率、外壁の持ち出し
 *  - 梁のスパンは 2 間（3,640）まで → 超える部屋は柱か大きな梁
 *  - 一面が窓ばかりの外壁は耐力壁が取れない
 *  - 出入口の無い部屋、上下階で位置の合わない階段、UB・便所の格子寸法
 *  - 通れない幅（廊下・ホール・階段は柱芯 910 が最小）、幅 550 未満の戸、同じ場所に重なった壁
 *  - 階段の勾配（蹴上 = 階高 ÷ 段数、踏面 = 階段の長さ ÷ 段数。上限 230／150、目安 200／240）
 *  - 開き戸の前に壁（開く側に戸の幅ぶんの空きが無い）、外壁の半間未満の出入り（柱・基礎・屋根が増える）
 * 構造計算（壁量計算・許容応力度）ではなく、読み取りの検算と設計の注意点を出す
 */
import { excludedFromFloorArea, type BuildingModel, type Floor, type Room, type Vec2, type Wall } from '../core/types';
import { distPointSegment, pointInPolygon } from '../core/geometry';
import { largestInnerRect } from '../core/rects';
import { stairFrame, stairStepCount } from '../core/stairs';
import { classifyRoomName } from './labels';
import { mustSeparate } from './roomKnowledge';

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

/** 点 o から向き d に伸ばした半直線が線分 ab に当たるまでの距離（当たらなければ null） */
function raySeg(o: Vec2, d: Vec2, a: Vec2, b: Vec2): number | null {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const den = d.x * ey - d.y * ex;
  if (Math.abs(den) < 1e-9) return null;
  const ox = a.x - o.x;
  const oy = a.y - o.y;
  const t = (ox * ey - oy * ex) / den;
  const u = (ox * d.y - oy * d.x) / den;
  return t >= 0 && u >= -1e-6 && u <= 1 + 1e-6 ? t : null;
}

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
      if (excludedFromFloorArea(r.type) || ['closet', 'storage', 'stairs'].includes(r.type)) continue;
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
      if (excludedFromFloorArea(r.type) || ['stairs', 'hall', 'other'].includes(r.type)) continue;
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
      if (excludedFromFloorArea(r.type) || ['closet', 'storage', 'toilet', 'bath'].includes(r.type)) continue;
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
  // (l) 階段の勾配: 蹴上 = 階高 ÷ 段数、踏面 = 図面の階段の長さから。住宅の上限は蹴上 230・踏面 150（建築基準法）、
  //     ゆとりの目安は蹴上 200 以下・踏面 240 以上。図面の矩形が短いと踏面が浅くなる（3D では昇り口側へ延ばして補っている）
  for (let fi = 0; fi + 1 < floors.length; fi++) {
    const f = floors[fi];
    for (const st of f.stairs.filter((x) => x.goesUp)) {
      const rise = f.height || 2900;
      const n = stairStepCount(rise, st);
      const riser = rise / n;
      const F = stairFrame(st);
      let tread: number;
      if (st.kind === 'straight') tread = F.Ls / Math.max(1, n - 1);
      else if (st.kind === 'u') {
        const land = Math.min(F.Ls * 0.4, F.Lt / 2);
        tread = (F.Ls - land) / Math.max(1, Math.floor(n / 2));
      } else {
        // かね折れ: 曲がりの踊り場（幅 Lt 角）を引いた直線部を段割り
        tread = (F.Ls + F.Lt - Math.min(F.Lt, F.Ls / 2) * 2) / Math.max(1, n - 2);
      }
      const rect = { minX: st.minX, minY: st.minY, maxX: st.maxX, maxY: st.maxY };
      const label = `蹴上 ${Math.round(riser)}・踏面 約 ${Math.round(tread)}（${n} 段）`;
      // 蹴上は段数で決まる（図面の「14段」など）ので確度が高い。踏面は図面の矩形の長さから出すが、
      // 下の数段がホールへ出る描き方や上階の抜きの描き方で短く読めることが多いので、注意（info）に留める
      if (riser > 230) {
        out.push({ id: `steep-${f.level}-${st.id}`, level: f.level, severity: 'warn', title: `${f.level}階 階段: 蹴上 ${Math.round(riser)} は急すぎます（${n} 段）`, detail: `階高 ${rise} を ${n} 段で上がると蹴上が ${Math.round(riser)} になります。住宅の上限は蹴上 230（踏面 150）で、ゆとりの目安は 200 以下です。段数を ${Math.ceil(rise / 230)} 段以上（できれば ${Math.ceil(rise / 200)} 段）にしてください。図面の段数の読み取りがずれている可能性もあります`, marks: [{ level: f.level, rects: [rect], label }] });
      } else if (tread < 200) {
        out.push({ id: `steep-${f.level}-${st.id}`, level: f.level, severity: 'info', title: `${f.level}階 階段: 図面の長さだと踏面が約 ${Math.round(tread)} です`, detail: `${n} 段（蹴上 ${Math.round(riser)}）を図面の階段の長さに割ると踏面が ${Math.round(tread)} になります。ゆとりの目安は踏面 240 以上（${Math.round(240 * (n - 1))} 程度の長さ）です。下の数段をホール側へ出す描き方なら問題ありません（3D では昇り口側へ延ばして勾配を補っています）`, marks: [{ level: f.level, rects: [rect], label }] });
      } else if (riser > 205) {
        out.push({ id: `steep-${f.level}-${st.id}`, level: f.level, severity: 'info', title: `${f.level}階 階段: 蹴上 ${Math.round(riser)} はやや急です（${n} 段）`, detail: `ゆとりの目安は蹴上 200 以下です。1 段増やすと ${Math.round(rise / (n + 1))} になります`, marks: [{ level: f.level, rects: [rect], label }] });
      }
    }
  }
  // (m) 開き戸の前の壁: 開く側に戸の幅ぶんの空きが無いと戸が開き切らない（455 の廊下へ開く戸・壁の前の戸）。
  //     開く向きが読めている戸だけ（読めない戸は広い側へ開くものとする）。物入へ開く戸は除く
  for (const f of floors) {
    const storages = f.rooms.filter((r) => r.type === 'closet' || r.type === 'storage');
    const hits: { seg: { a: Vec2; b: Vec2 }; clear: number; width: number }[] = [];
    for (const o of f.openings) {
      if (o.kind !== 'door' && o.kind !== 'entrance') continue;
      const w = f.walls.find((x) => x.id === o.wallId);
      if (!w) continue;
      const L = len(w) || 1;
      const dx = (w.b.x - w.a.x) / L;
      const dy = (w.b.y - w.a.y) / L;
      const width = o.t1 - o.t0;
      if (width < 500) continue;
      const tm = (o.t0 + o.t1) / 2;
      const c = { x: w.a.x + dx * tm, y: w.a.y + dy * tm };
      const clearance = (sign: 1 | -1) => {
        const d = { x: -dy * sign, y: dx * sign };
        // 物入の中へ開く（物入の奥行きぶんしか無い）のは普通
        const probe = { x: c.x + d.x * 200, y: c.y + d.y * 200 };
        if (storages.some((r) => pointInPolygon(probe, r.polygon))) return Infinity;
        let best = Infinity;
        for (const v of f.walls) {
          if (v.id === w.id) continue;
          const t = raySeg(c, d, v.a, v.b);
          if (t != null && t > 0) best = Math.min(best, t - v.thickness / 2);
        }
        return best;
      };
      const sides: (1 | -1)[] = o.swingSide ? [o.swingSide] : [1, -1];
      const clear = Math.max(...sides.map(clearance));
      if (clear < width - 30) hits.push({ seg: { a: { x: w.a.x + dx * o.t0, y: w.a.y + dy * o.t0 }, b: { x: w.a.x + dx * o.t1, y: w.a.y + dy * o.t1 } }, clear, width });
    }
    if (!hits.length) continue;
    const bad = hits.some((h) => h.clear < h.width * 0.75);
    out.push({
      id: `doorwall-${f.level}`,
      level: f.level,
      severity: bad ? 'warn' : 'info',
      title: `${f.level}階: 開いた先に壁がある戸が ${hits.length} か所`,
      detail: `${hits.map((h) => `幅 ${Math.round(h.width)} の戸の前が ${Math.round(Math.max(0, h.clear))}`).join('・')} mm です。開き戸は開く側に戸の幅ぶん（${hits.map((h) => Math.round(h.width)).join('・')}）の空きが要ります。壁に当たる戸は引戸にするか、開く向きを変えてください。戸の記号（円弧の向き）を読み違えている可能性もあります`,
      marks: [{ level: f.level, lines: hits.map((h) => h.seg), label: '戸の前に壁' }],
    });
  }

  // (p) 一続きに読めた部屋: 収納・トイレ・浴室・個室が他の部屋と 1 つの区画になっている（間の壁か戸が読めていない）
  for (const f of floors) {
    const bad = f.rooms.filter((r) => {
      if (!r.name.includes('・')) return false;
      const types = r.name
        .split('・')
        .map((n) => classifyRoomName(n))
        .filter((t): t is NonNullable<typeof t> => !!t);
      for (let i = 0; i < types.length; i++) for (let j = i + 1; j < types.length; j++) if (mustSeparate(types[i], types[j])) return true;
      return false;
    });
    if (!bad.length) continue;
    out.push({
      id: `merged-${f.level}`,
      level: f.level,
      severity: 'warn',
      title: `${f.level}階: 壁か戸で分かれているはずの部屋が一続きに読めています（${bad.length} か所）`,
      detail: `${bad.map((r) => r.name).join('、')}。収納・トイレ・浴室・個室は壁か戸で区切られているのが普通です。間の壁が細い線で描かれているか、戸の記号が読めていない可能性があります。修正画面で壁を足すか、部屋を分けてください`,
      marks: [{ level: f.level, rects: bad.map((r) => bboxOf(r.polygon)), label: '一続き' }],
    });
  }

  // (o) 外壁の細かい出入り: 外形の辺が半間（455）未満。出入りごとに柱が 2 本と基礎の角が増え、屋根の納まりが複雑になる。
  //     読み取りの揺れ（二重に読んだ壁・梁の線）で生まれることも多い
  for (const f of floors) {
    const short: { a: Vec2; b: Vec2; L: number }[] = [];
    for (const poly of f.outline) {
      const n = poly.length;
      if (n < 4) continue;
      const dir = (i: number) => {
        const a = poly[(i + n) % n];
        const b = poly[(i + 1 + n) % n];
        const L = len({ a, b }) || 1;
        return { x: (b.x - a.x) / L, y: (b.y - a.y) / L, L };
      };
      for (let i = 0; i < n; i++) {
        const d = dir(i);
        if (d.L < 30 || d.L >= 440) continue;
        // 両隣が折れている（同じ向きに続く線の分割ではない）
        const p = dir(i - 1);
        const q = dir(i + 1);
        const turnP = Math.abs(p.x * d.y - p.y * d.x);
        const turnQ = Math.abs(q.x * d.y - q.y * d.x);
        if (turnP < 0.3 || turnQ < 0.3) continue;
        short.push({ a: poly[i], b: poly[(i + 1) % n], L: d.L });
      }
    }
    if (!short.length) continue;
    const lens = short.map((x) => Math.round(x.L));
    const jagged = short.length > 8;
    const tiny = short.every((x) => x.L < 200);
    out.push({
      id: `jog-${f.level}`,
      level: f.level,
      // 200 未満ばかりなら壁の厚みの段差（外壁 160 と内壁 130 の差など）か読み取りの揺れ。多すぎれば外形がギザギザ（読み取りの問題）
      severity: jagged ? 'warn' : tiny ? 'info' : 'warn',
      title: jagged ? `${f.level}階: 外形がギザギザです（半間未満の段差が ${short.length} か所）` : tiny ? `${f.level}階: 外形に細かな段差が ${short.length} か所（読み取りの揺れの疑い）` : `${f.level}階: 外壁に半間未満の出入りが ${short.length} か所`,
      detail: jagged
        ? `${lens.slice(0, 12).join('・')}… mm の段差があります。壁を二重に読んだか、梁・庇の線を外壁と取り違えた可能性が高いので、修正画面で外形を確かめてください`
        : tiny
          ? `${lens.join('・')} mm の段差があります。外壁と内壁の厚みの差や、線を二重に読んだ揺れのことが多く、設計上の出入りではありません。気になるときは修正画面で壁を揃えてください`
          : `${lens.join('・')} mm の出入りがあります。木造では外壁の出入りごとに柱が 2 本と基礎の角が増え、屋根・樋の納まりも複雑になります。意図した出入りなら 455 か 910 に、読み取りの揺れ（二重の壁・梁の線）なら修正画面で外形を直してください`,
      marks: [{ level: f.level, lines: short.map((x) => ({ a: x.a, b: x.b })), label: jagged ? 'ギザギザ' : '細かい段差' }],
    });
  }
  out.push(...livabilityChecks(model));
  return out;
}

/**
 * 住まいの常識（使いやすさ・動線・広さ・採光）のチェック。
 * 読み取りの誤りではなく「設計として気になる点」を、お客様に説明できる言葉で出す（severity は info 中心）
 */
function livabilityChecks(model: BuildingModel): WoodIssue[] {
  const out: WoodIssue[] = [];
  const floors = model.floors;
  const tatami = (a: number) => (a / 1.62).toFixed(1);
  const rectOf = (r: Room) => bboxOf(r.polygon);
  const centerOf = (r: Room) => ({ x: (rectOf(r).minX + rectOf(r).maxX) / 2, y: (rectOf(r).minY + rectOf(r).maxY) / 2 });
  // 部屋に面する窓（開口の中心が部屋の境界から 250 以内）
  const windowsOf = (f: Floor, r: Room) =>
    f.openings.filter((o) => {
      if (o.kind !== 'window') return false;
      const w = f.walls.find((w) => w.id === o.wallId);
      if (!w) return false;
      const L = len(w) || 1;
      const t = (o.t0 + o.t1) / 2 / L;
      const c = { x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t };
      return r.polygon.some((p, i) => distPointSegment(c, p, r.polygon[(i + 1) % r.polygon.length]) < 250);
    });
  for (const f of floors) {
    for (const r of f.rooms) {
      const rect = rectOf(r);
      const w = rect.maxX - rect.minX;
      const h = rect.maxY - rect.minY;
      const short = Math.min(w, h);
      const marks: WoodMark[] = [{ level: f.level, rects: [rect], label: `${tatami(r.area)}帖` }];
      // 居室の採光: 窓の無い寝室・子供室・和室・書斎（建築基準法の居室は採光が要る。読み取り漏れのこともある）
      if (['bedroom', 'kids', 'japanese', 'study', 'living', 'ldk', 'dining'].includes(r.type) && r.area >= 4 && windowsOf(f, r).length === 0) {
        out.push({ id: `nowin-${f.level}-${r.id}`, level: f.level, severity: 'info', title: `${f.level}階 ${r.name}: 窓が読めていません`, detail: '居室には採光（床面積の 1/7 以上の窓）が要ります。図面に窓があるのに出ていないときは、修正画面で窓を足してください。無い場合は設計の見直しです', marks });
      }
      // 主寝室の広さ: 6 帖未満だとダブルベッド（W1400）＋通路が苦しい
      if (r.type === 'bedroom' && /主寝室|寝室|MBR|主/.test(r.name) && r.area < 9.5 && r.area > 0) {
        out.push({ id: `mbr-${f.level}-${r.id}`, level: f.level, severity: 'info', title: `${f.level}階 ${r.name}: ${tatami(r.area)}帖は主寝室としては少し狭めです`, detail: 'ダブルベッド（1,400×1,950）を置いて両側に通路（各 600）を取るには短辺 2,730（6 帖）以上が目安です。クローゼットを別に取れば 6 帖でも成り立ちます', marks });
      }
      // 子供室: 4.5 帖未満はベッド＋机が入らない
      if (r.type === 'kids' && r.area < 7.0 && r.area > 0) {
        out.push({ id: `kids-${f.level}-${r.id}`, level: f.level, severity: 'info', title: `${f.level}階 ${r.name}: ${tatami(r.area)}帖はベッドと机を置くと窮屈です`, detail: 'シングルベッド（1,000×2,000）と机（1,000×600）を置くには 4.5 帖（2,730×2,730）が目安。3.8 帖でも成り立ちますが、クローゼットは外に取ってください', marks });
      }
      // LDK の短辺: 3,640 未満だとソファとダイニングテーブルが並ばない
      if ((r.type === 'ldk' || r.type === 'living') && short > 0 && short < 3500) {
        out.push({ id: `ldk-${f.level}-${r.id}`, level: f.level, severity: 'info', title: `${f.level}階 ${r.name}: 短辺 ${m(short)} m はソファとテーブルを並べると窮屈です`, detail: 'ダイニングテーブル（通路込み 2,000）とソファ（通路込み 1,700）を横に並べるには短辺 3,640 以上が目安です。縦に並べる間取りなら問題ありません', marks });
      }
      // 洗面脱衣室: 1 坪未満だと洗濯機＋洗面台＋脱衣スペースが苦しい
      if (r.type === 'washroom' && r.area < 3.0 && r.area > 0) {
        out.push({ id: `wash-${f.level}-${r.id}`, level: f.level, severity: 'info', title: `${f.level}階 ${r.name}: ${tatami(r.area)}帖は洗濯機と洗面台を置くと狭めです`, detail: '洗面台（W750〜900）・洗濯機（W640）・脱衣のスペースで 1 坪（1,820×1,820）が目安です。ランドリーを兼ねるなら 1.5 坪以上をおすすめします', marks });
      }
      // 階段の幅: 柱芯 910 未満（内法 780 未満）は上り下りが窮屈で、家具の搬入にも困る
      if (r.type === 'stairs' && short > 0 && short < 860) {
        out.push({ id: `stairw-${f.level}-${r.id}`, level: f.level, severity: 'warn', title: `${f.level}階 階段: 幅 ${m(short)} m は狭すぎます`, detail: '階段の幅は柱芯 910（有効 750 以上）が最小です。手すりを付けると有効幅が 50 減ります。読み取りの壁のずれの可能性もあります', marks });
      }
    }
    // 家事動線: キッチンと洗面脱衣室が遠い（往復の多い組み合わせ）
    const kitchen = f.rooms.find((r) => r.type === 'kitchen' || r.type === 'ldk' || r.type === 'dining');
    const wash = f.rooms.find((r) => r.type === 'washroom');
    if (kitchen && wash) {
      const a = centerOf(kitchen);
      const b = centerOf(wash);
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 9000) {
        out.push({ id: `kw-${f.level}`, level: f.level, severity: 'info', title: `${f.level}階: キッチンと洗面脱衣室が離れています（約 ${m(d)} m）`, detail: '料理と洗濯を同時に進める家事動線では、キッチン〜洗面脱衣室が近い（回遊できる）と毎日の移動が短くなります。間取りの意図であれば問題ありません', marks: [{ level: f.level, lines: [{ a, b }], label: '家事動線' }] });
      }
    }
    // 収納率: 収納（物入・クローゼット・SIC・パントリー）の面積が床面積の 8% 未満
    const storage = f.rooms.filter((r) => r.type === 'closet' || r.type === 'storage').reduce((s, r) => s + r.area, 0);
    const floorArea = f.rooms.filter((r) => !excludedFromFloorArea(r.type)).reduce((s, r) => s + r.area, 0);
    if (floorArea > 30 && storage / floorArea < 0.08) {
      out.push({ id: `storage-${f.level}`, level: f.level, severity: 'info', title: `${f.level}階: 収納が床面積の ${Math.round((storage / floorArea) * 100)}% と少なめです`, detail: '戸建ての収納率は 10〜12% が目安（${Math.round(floorArea * 0.1)} ㎡ 程度）。WIC・SIC・パントリー・階段下などで補うのが御社の定番です。読み取りで収納が別の部屋に結合している可能性もあります' });
    }
  }
  // 2 階建てで寝室が 2 階にあり、2 階にトイレが無い
  if (floors.length >= 2) {
    const up = floors[floors.length - 1];
    const hasBed = up.rooms.some((r) => r.type === 'bedroom' || r.type === 'kids');
    const hasWc = up.rooms.some((r) => r.type === 'toilet');
    if (hasBed && !hasWc) {
      out.push({ id: `wc-up-${up.level}`, level: up.level, severity: 'info', title: `${up.level}階に寝室がありますがトイレがありません`, detail: '夜間や来客時のために、寝室のある階にトイレ（柱芯 910×1,365）を置くのが一般的です。1 階だけにする場合はお客様に確認を' });
    }
  }
  return out;
}
