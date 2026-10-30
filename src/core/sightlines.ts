/**
 * 隣家からの視線: 家の窓ごとに、向かいの隣家の壁（窓があるかもしれない面）までの距離と高さを見て、
 * 「外から覗かれやすい窓」を挙げる。日照で読み込んだ周辺建物（実測の外形・高さ）を使う。
 *
 * 見る人（お客様）: 「この窓は隣の家の 2 階から見えそう → 型ガラス・高い位置の窓にする」が、契約前に分かって安心。
 * 使う人（設計士）: 目隠しフェンス・植栽・型ガラスの提案の根拠になる。
 *
 * 計算は簡単な幾何: 窓の外向きの正面（±65°）にある隣家の壁の最短距離と、その壁の高さが窓の高さに届くか。
 * 隣家の窓の位置までは分からないので「壁がある = 窓があるかもしれない」として扱う。
 */
import { ROOM_TYPE_LABEL, type BuildingModel, type Room, type RoomType, type Vec2 } from './types';
import { pointInPolygon } from './geometry';

export interface NeighborWorld {
  /** 外形（ワールド xz・m） */
  ring: { x: number; z: number }[];
  /** 高さ m */
  height: number;
  label?: string;
}

export interface SightlineIssue {
  level: number;
  roomName: string;
  roomType: RoomType;
  /** 窓の種類 */
  kind: 'window' | 'sliding';
  /** 方角（北・北東…） */
  facing: string;
  /** 隣家の壁までの距離 m */
  dist: number;
  /** 隣家の高さ m と、見下ろされるか */
  neighborHeight: number;
  fromAbove: boolean;
  /** 強さ: high = 4m 以内、mid = 7m 以内、low = 10m 以内 */
  risk: 'high' | 'mid' | 'low';
  neighborLabel?: string;
  /** お客様に見せる対策のひとこと */
  advice: string;
  /** 窓の中心（ワールド xz）と図面 mm */
  world: { x: number; z: number };
  plan: Vec2;
}

const MM = 0.001;
const DIRS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];

function compass(nx: number, nz: number, northDeg: number): string {
  // ワールド: 北 = (sin a, -cos a)、東 = (cos a, sin a)
  const a = (northDeg * Math.PI) / 180;
  const n = nx * Math.sin(a) + nz * -Math.cos(a);
  const e = nx * Math.cos(a) + nz * Math.sin(a);
  const ang = ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
  return DIRS[Math.round(ang / 45) % 8];
}

function distToSeg(p: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }): { d: number; q: { x: number; z: number } } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const L2 = dx * dx + dz * dz || 1;
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L2));
  const q = { x: a.x + dx * u, z: a.z + dz * u };
  return { d: Math.hypot(p.x - q.x, p.z - q.z), q };
}

function adviceFor(t: RoomType, kind: 'window' | 'sliding', risk: SightlineIssue['risk'], fromAbove: boolean): string {
  if (t === 'bath' || t === 'washroom' || t === 'toilet') return '型ガラス（すりガラス）か、高い位置の小さな窓にすると気になりません';
  if (t === 'bedroom' || t === 'kids' || t === 'study') return fromAbove ? '高い位置の窓にするか、型ガラス・ブラインドで目線を外します' : '型ガラスか、窓の位置を少しずらして目線を外します';
  if (kind === 'sliding') return risk === 'high' ? '目隠しフェンスか植栽で目線を切ると、カーテンを開けて過ごせます' : '植栽や格子で目線をやわらげると、カーテンを開けて過ごせます';
  return risk === 'high' ? '型ガラスか高い位置の窓に。カーテン・ブラインドでも対応できます' : 'レースカーテン・ブラインドで十分なことが多い距離です';
}

/** 家の窓ごとに、正面の隣家の壁までの距離を測る。隣家が無い窓は返さない */
export function sightlineCheck(model: BuildingModel, neighbors: NeighborWorld[]): SightlineIssue[] {
  const out: SightlineIssue[] = [];
  if (!neighbors.length) return out;
  for (const f of model.floors) {
    for (const op of f.openings) {
      if (op.kind !== 'window' && op.kind !== 'sliding') continue;
      const w = f.walls.find((x) => x.id === op.wallId);
      if (!w || !w.exterior) continue;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      const t = (op.t0 + op.t1) / 2;
      const cx = w.a.x + ux * t;
      const cy = w.a.y + uy * t;
      // 外向き（外形の内外で確かめる）
      let sgn = w.outsideSign ?? 1;
      const probe = (sg: number) => f.outline.some((l) => pointInPolygon({ x: cx - uy * sg * (w.thickness / 2 + 300), y: cy + ux * sg * (w.thickness / 2 + 300) }, l));
      const pin = probe(1);
      const min = probe(-1);
      if (pin !== min) sgn = pin ? -1 : 1;
      const nx = -uy * sgn;
      const nz = ux * sgn;
      const c = { x: cx * MM, z: cy * MM };
      const winY = (f.elevation + op.sill + op.height / 2) * MM;
      // 窓の部屋（内側）
      const inside = { x: cx + uy * sgn * (w.thickness / 2 + 300), y: cy - ux * sgn * (w.thickness / 2 + 300) };
      const room: Room | undefined = f.rooms.find((r) => pointInPolygon(inside, r.polygon));
      // 隣家の壁のうち、正面（±65°）にある最も近いもの
      let best: { d: number; nb: NeighborWorld } | null = null;
      for (const nb of neighbors) {
        if (nb.height < winY - 0.8) continue; // 窓より低い建物（平屋のカーポートなど）からは覗けない
        for (let i = 0; i < nb.ring.length; i++) {
          const a = nb.ring[i];
          const b = nb.ring[(i + 1) % nb.ring.length];
          const { d, q } = distToSeg(c, a, b);
          if (d > 10 || d < 0.3) continue;
          const vx = (q.x - c.x) / d;
          const vz = (q.z - c.z) / d;
          if (vx * nx + vz * nz < 0.42) continue;
          if (!best || d < best.d) best = { d, nb };
        }
      }
      if (!best) continue;
      const risk: SightlineIssue['risk'] = best.d <= 4 ? 'high' : best.d <= 7 ? 'mid' : 'low';
      const fromAbove = best.nb.height > winY + 2.2;
      const rt = room?.type ?? 'other';
      out.push({
        level: f.level,
        roomName: room?.name || ROOM_TYPE_LABEL[rt],
        roomType: rt,
        kind: op.kind,
        facing: compass(nx, nz, model.northAngleDeg),
        dist: Math.round(best.d * 10) / 10,
        neighborHeight: Math.round(best.nb.height * 10) / 10,
        fromAbove,
        risk,
        neighborLabel: best.nb.label,
        advice: adviceFor(rt, op.kind, risk, fromAbove),
        world: c,
        plan: { x: cx, y: cy },
      });
    }
  }
  const order = { high: 0, mid: 1, low: 2 };
  return out.sort((a, b) => order[a.risk] - order[b.risk] || a.dist - b.dist);
}

/** 強さの色（図面の印・一覧で共通） */
export function sightColor(risk: SightlineIssue['risk']): string {
  return risk === 'high' ? '#b4473d' : risk === 'mid' ? '#c28a12' : '#8a8f99';
}

/** 平面図 SVG（座標 = 図面 mm）に、挙げた窓の番号付きの印を重ねる。番号は issues の並び（1 始まり） */
export function overlaySightlines(svg: string, level: number, issues: SightlineIssue[]): string {
  const g: string[] = [];
  issues.forEach((i, k) => {
    if (i.level !== level) return;
    const col = sightColor(i.risk);
    g.push(`<circle cx="${i.plan.x.toFixed(0)}" cy="${i.plan.y.toFixed(0)}" r="320" fill="${col}" stroke="#fff" stroke-width="60"/>`);
    g.push(`<text x="${i.plan.x.toFixed(0)}" y="${(i.plan.y + 130).toFixed(0)}" text-anchor="middle" font-size="380" font-weight="700" fill="#fff" font-family="sans-serif">${k + 1}</text>`);
  });
  if (!g.length) return svg;
  return svg.replace(/<\/svg>\s*$/, `<g class="sightlines">${g.join('')}</g></svg>`);
}
