/**
 * 柱（Floor.posts）の決まりごと（three 非依存の純関数）。
 *
 * - 柱はその階の床から立つ。管柱・独立柱は上の階の床（最上階なら軒の高さ）まで、通し柱は 1 階から最上階の上まで。
 * - 2 階の張り出し（オーバーハング）: 上の階の外形の角が下の階の外形の外に出ている所。張り出しが半間（455）を超えると、
 *   足元（下の階）に柱を立てるのがふつう（1 間 = 910 を超える張り出しを梁だけで持たせるのは在来の木造では無理がある）。
 * - 壁の中に入る柱（壁の芯から壁厚の半分以内）は 3D では壁に隠れるので描かない。図面では□で描く。
 */
import { pointInPolygon } from './geometry';
import type { BuildingModel, Floor, Post, Vec2, Wall } from './types';

/** 張り出しの柱を勧める深さ（mm）。これ未満は梁の持ち出しで納まる */
export const OVERHANG_POST_MIN = 455;
/** 柱が無いと警告する深さ（mm） */
export const OVERHANG_POST_WARN = 910;
/** 張り出しの辺に立てる柱の間隔の上限（mm、1.5 間） */
export const OVERHANG_POST_SPACING = 2730;

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

/** 点から外形（複数の輪）の辺までの最短距離 */
function distToOutline(p: Vec2, loops: Vec2[][]): number {
  let d = Infinity;
  for (const l of loops) for (let i = 0; i < l.length; i++) d = Math.min(d, segDist(p, l[i], l[(i + 1) % l.length]));
  return d;
}

function insideOutline(p: Vec2, loops: Vec2[][]): boolean {
  return loops.some((l) => l.length >= 3 && pointInPolygon(p, l));
}

/** 上の階の輪が下の階の外形と重なるか（頂点のどちらかが相手の内側か、辺どうしが近い） */
function touches(loop: Vec2[], low: Vec2[][]): boolean {
  if (loop.some((p) => insideOutline(p, low) || distToOutline(p, low) <= 100)) return true;
  return low.some((l) => l.some((p) => pointInPolygon(p, loop)));
}

export interface OverhangPoint {
  p: Vec2;
  /** 下の階の外壁からの張り出しの深さ (mm) */
  depth: number;
  /** 角（外形の頂点）か、長い辺の途中か */
  corner: boolean;
}

/**
 * 上の階の外形のうち、下の階の外形の外に出ている点（張り出しの足元の候補）。
 * 角に加え、張り出した辺が 1.5 間を超えるときは途中にも等間隔に置く。
 * - 下の階の壁（車庫・ポーチの袖壁など外形の外の壁も）の上に載る点は壁の柱で受けるので除く
 * - 下の階とまったく重ならない上の階の輪は張り出しではなく読み違い（別棟・凡例など）として除く
 */
export function overhangPoints(lower: Floor, upper: Floor): OverhangPoint[] {
  const low = lower.outline.filter((l) => l.length >= 3);
  if (!low.length) return [];
  const out: OverhangPoint[] = [];
  const onWall = (p: Vec2) => lower.walls.some((w) => segDist(p, w.a, w.b) <= w.thickness / 2 + 150);
  const off = (p: Vec2) => !insideOutline(p, low) && distToOutline(p, low) > 100;
  const outside = (p: Vec2) => off(p) && !onWall(p);
  for (const loop of upper.outline) {
    const n = loop.length;
    if (n < 3 || !touches(loop, low)) continue;
    for (let i = 0; i < n; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % n];
      if (outside(a)) out.push({ p: { x: Math.round(a.x), y: Math.round(a.y) }, depth: distToOutline(a, low), corner: true });
      // 辺の両端が外に出ていて長ければ途中にも
      if (off(a) && off(b)) {
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        const k = Math.ceil(L / OVERHANG_POST_SPACING);
        for (let j = 1; j < k; j++) {
          const p = { x: Math.round(a.x + ((b.x - a.x) * j) / k), y: Math.round(a.y + ((b.y - a.y) * j) / k) };
          if (outside(p)) out.push({ p, depth: distToOutline(p, low), corner: false });
        }
      }
    }
  }
  return out;
}

/** その点の近く（300mm 以内）に柱があるか */
export function hasPostNear(posts: Post[] | undefined, p: Vec2, tol = 300): boolean {
  return !!posts?.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= tol);
}

/** 張り出しの足元に立てる柱の提案（下の階に置く独立柱）。既に柱がある所は除く */
export function suggestOverhangPosts(lower: Floor, upper: Floor, size = 105): Post[] {
  const out: Post[] = [];
  let k = 0;
  for (const o of overhangPoints(lower, upper)) {
    if (o.depth < OVERHANG_POST_MIN) continue;
    if (hasPostNear(lower.posts, o.p) || out.some((q) => Math.hypot(q.x - o.p.x, q.y - o.p.y) < 300)) continue;
    // 柱の芯を上の階の外形の角（外壁の芯）に置く
    out.push({ id: `F${lower.level}-P-oh${++k}-${o.p.x}-${o.p.y}`, x: o.p.x, y: o.p.y, size, kind: 'free', auto: true });
  }
  return out;
}

/** 柱が壁の中に入っているか（壁の芯から壁厚の半分以内。端の少し外まで含む） */
export function postInWall(p: Post, walls: Wall[]): boolean {
  return walls.some((w) => segDist(p, w.a, w.b) <= w.thickness / 2 + 5);
}

/** 柱の高さの範囲（GL からの mm）: 床から、管柱・独立柱は上の階の床（最上階は壁の上端）まで、通し柱は最上階の上まで */
export function postSpan(model: BuildingModel, f: Floor, p: Post): { y0: number; y1: number } {
  const floors = [...model.floors].sort((a, b) => a.level - b.level);
  const top = floors[floors.length - 1];
  const next = floors.find((x) => x.level === f.level + 1);
  const y0 = f.elevation;
  if (p.kind === 'toshi') return { y0, y1: top.elevation + top.height };
  return { y0, y1: next ? next.elevation : f.elevation + f.height };
}

/** 柱の向き確認用の短い説明（一覧・図面の注記） */
export function postLabel(p: Post): string {
  const k = p.kind === 'toshi' ? '通し柱' : p.kind === 'free' ? '独立柱' : '管柱';
  return `${k} ${p.round ? `φ${p.size}` : `${p.size}角`}`;
}

/**
 * 読み込み直後に置く張り出しの柱: 1 間（910）を超える張り出しの角は梁の持ち出しでは受けられないので、下の階に独立柱を立てる
 * （柱が無いと 3D で 2 階が宙に浮いて見える。ピロティ・ビルトイン車庫の上の 2 階など）。
 * 張り出しの点が多すぎる（11 か所以上）ときは階の位置合わせの読み違いの疑いが強いので置かない
 */
export function autoOverhangPosts(lower: Floor, upper: Floor, size = 120): Post[] {
  const pts = overhangPoints(lower, upper).filter((o) => o.depth >= OVERHANG_POST_MIN);
  if (!pts.length || pts.length > 10) return [];
  // ちょうど 1 間（910）の持ち出しは梁で納めるのがふつうなので、それを超える（+50 の読み取りの誤差を見込む）ときだけ
  return suggestOverhangPosts(lower, upper, size).filter((p) => pts.some((o) => o.depth > OVERHANG_POST_WARN + 50 && Math.hypot(o.p.x - p.x, o.p.y - p.y) < 1));
}
