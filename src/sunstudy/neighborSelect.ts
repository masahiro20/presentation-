/**
 * 周辺建物を選んで隠す／戻すための純粋な計算（DOM・three 不要）
 *
 *  - 画面上の範囲選択: 建物の代表点（足跡の重心を投影した点）が矩形に入るか（idsInRect）
 *  - 地図・画面の多角形の当たり判定: 点が投影した輪郭の内側か（凹形も可。重なっていれば小さい方）、外なら辺の近く（hitRingAt）
 *  - 選択の切り替え・追加と、隠す／戻すの対象への振り分け
 * 建物の id（neighbors.ts の neighborId）は建物の中心の緯度経度と面積から作るので、ピンを動かして取り直しても同じ建物は同じ id になり、
 * 隠した記録（neighborOverrides）はそのまま効く
 */

export interface P2 {
  x: number;
  y: number;
}

export interface EN2 {
  e: number;
  n: number;
}

/** 画面の矩形（左上 x0,y0 ≦ 右下 x1,y1） */
export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 2 点（ドラッグの始点・終点、どの向きでも）→ 正規化した矩形 */
export function normRect(a: P2, b: P2): ScreenRect {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

/** 矩形の幅・高さがどちらも minPx 未満（ほぼクリック） */
export function rectIsTiny(r: ScreenRect, minPx = 3): boolean {
  return r.x1 - r.x0 < minPx && r.y1 - r.y0 < minPx;
}

/**
 * 範囲選択: 代表点（画面 px）が矩形の中（境界を含む）にある項目の id。
 * inFront = false（カメラの後ろ・描画範囲の外で投影が意味を持たない）の項目は選ばない
 */
export function idsInRect(items: { id: string; x: number; y: number; inFront: boolean }[], r: ScreenRect): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (!it.inFront || !Number.isFinite(it.x) || !Number.isFinite(it.y)) continue;
    if (it.x >= r.x0 && it.x <= r.x1 && it.y >= r.y0 && it.y <= r.y1) out.push(it.id);
  }
  return out;
}

/** 点が多角形の内側か（偶奇則。凹形・自己交差も偶奇で判定。辺の上はどちらにもなり得る） */
export function pointInPolygon(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** 多角形の面積（絶対値） */
export function polygonAreaAbs(poly: P2[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  return Math.abs(s) / 2;
}

/** 点と線分の距離 */
export function segmentDistance(p: P2, a: P2, b: P2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/**
 * 当たり判定: 点 p を内側に含む輪郭の id（重なっていれば面積の小さい方 = 内側の建物）。
 * どれにも入っていなければ、辺までの距離が tol 以下で最も近い輪郭（小さな建物・細い建物を押しやすく）。無ければ null
 */
export function hitRingAt(p: P2, rings: { id: string; ring: P2[] }[], tol = 4): string | null {
  let best: string | null = null;
  let bestArea = Infinity;
  for (const r of rings) {
    if (r.ring.length < 3 || !pointInPolygon(p, r.ring)) continue;
    const a = polygonAreaAbs(r.ring);
    if (a < bestArea) {
      bestArea = a;
      best = r.id;
    }
  }
  if (best != null) return best;
  let bestD = tol;
  for (const r of rings) {
    const n = r.ring.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const d = segmentDistance(p, r.ring[i], r.ring[(i + 1) % n]);
      if (d <= bestD) {
        bestD = d;
        best = r.id;
      }
    }
  }
  return best;
}

/** 足跡（東・北 m）の重心（面積の重み付き）。面積 0 や点が少ないときは頂点の平均 */
export function footprintCentroid(ring: EN2[]): EN2 {
  const n = ring.length;
  if (!n) return { e: 0, n: 0 };
  let a = 0;
  let ce = 0;
  let cn = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const p = ring[j];
    const q = ring[i];
    const k = p.e * q.n - q.e * p.n;
    a += k;
    ce += (p.e + q.e) * k;
    cn += (p.n + q.n) * k;
  }
  if (n >= 3 && Math.abs(a) > 1e-9) return { e: ce / (3 * a), n: cn / (3 * a) };
  let se = 0;
  let sn = 0;
  for (const p of ring) {
    se += p.e;
    sn += p.n;
  }
  return { e: se / n, n: sn / n };
}

/** 選択の切り替え: ids のうち選択済みのものは外し、未選択のものは加える（新しい Set を返す） */
export function toggleSelection(sel: ReadonlySet<string>, ids: string[]): Set<string> {
  const out = new Set(sel);
  for (const id of ids) {
    if (out.has(id)) out.delete(id);
    else out.add(id);
  }
  return out;
}

/** 選択の追加（範囲選択は足していく） */
export function addSelection(sel: ReadonlySet<string>, ids: string[]): Set<string> {
  const out = new Set(sel);
  for (const id of ids) out.add(id);
  return out;
}

/** 選択を「表示中（隠す対象）」と「隠した建物（戻す対象）」に分ける。どちらにも無い id（取り直しで消えた建物など）は捨てる */
export function splitSelection(sel: ReadonlySet<string>, visibleIds: ReadonlySet<string>, hiddenIds: ReadonlySet<string>): { toHide: string[]; toRestore: string[] } {
  const toHide: string[] = [];
  const toRestore: string[] = [];
  for (const id of sel) {
    if (hiddenIds.has(id)) toRestore.push(id);
    else if (visibleIds.has(id)) toHide.push(id);
  }
  return { toHide, toRestore };
}
