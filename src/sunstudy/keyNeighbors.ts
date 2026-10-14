/**
 * 要確認の建物（敷地・計画建物に冬至の日影を落とす近隣の建物）の抽出と、高さの確からしさのラベル。DOM・state 非依存の純関数。
 *
 * 公開データの高さは建物ごとに精度が違う（実測の最高高さ・箱形の中央値・推定の屋根・種類からの推定）。全棟を現地で測るのは現実的でないので、
 * 「敷地に影を落とす建物」を影の時間の長い順に並べ、そこだけ現地で測って確定してもらう。確定した建物は confirmed を付けて開示に印字する。
 */
import { convexHull } from '../sun/align';
import { localDate, sunPosition, winterSolstice } from '../sun/solar';
import { ringsOverlap } from './neighbors';
import type { EN, Neighbor } from './types';

/** 冬至の何時から何時までを見るか（真太陽時に近い日本標準時の 8〜16 時。日影規制の測定時間帯と同じ） */
export const KEY_HOURS = { from: 8, to: 16, stepH: 0.5 } as const;
/** 太陽高度がこれ未満の時刻は影が無限に長くなるので数えない [度] */
const MIN_ELEVATION_DEG = 2;

/** 高さの確からしさ。confirmed = 現地で測って確定、measured = PLATEAU の実測の最高高さ（LOD2 の実形状）、est-roof = 推定の屋根、box = 箱形（点群の中央値）、estimated = 種類からの推定、manual = 手入力 */
export type HeightAccuracy = 'confirmed' | 'measured' | 'est-roof' | 'box' | 'estimated' | 'manual';

export const ACCURACY_LABEL: Readonly<Record<HeightAccuracy, string>> = {
  confirmed: '実測で確定',
  measured: '実測の最高高さ',
  'est-roof': '推定の屋根',
  box: '箱形（中央値）',
  estimated: '種類からの推定',
  manual: '手入力',
};

export function accuracyOf(n: Pick<Neighbor, 'confirmed' | 'heightKind' | 'source' | 'plateau' | 'mesh'>): HeightAccuracy {
  if (n.confirmed) return 'confirmed';
  if (n.heightKind === 'manual') return 'manual';
  if (n.heightKind === 'estimated') return 'estimated';
  const a = n.plateau;
  if (a?.roofEstimate) return 'est-roof';
  if (a && (a.lod ?? a.datasetLod) < 2) return 'box';
  return 'measured';
}

/** 冬至の 8〜16 時の太陽（方位は真北から時計回り・高度は度）。lat/lon が無ければ空 */
export function winterSamples(lat: number, lon: number, year: number): { azimuth: number; elevation: number }[] {
  const ws = winterSolstice(year);
  const out: { azimuth: number; elevation: number }[] = [];
  for (let t = KEY_HOURS.from; t <= KEY_HOURS.to + 1e-9; t += KEY_HOURS.stepH) {
    const s = sunPosition(localDate(ws.year, ws.month, ws.day, t), lat, lon);
    if (s.elevation >= MIN_ELEVATION_DEG) out.push({ azimuth: s.azimuth, elevation: s.elevation });
  }
  return out;
}

/** 屋上（高さ height）の影が落ちる範囲: 足元の輪郭と、影の長さ分ずらした輪郭の凸包（東・北の座標）。太陽の反対側にのびる */
export function shadowHull(ring: EN[], height: number, azimuthDeg: number, elevationDeg: number): EN[] {
  const len = height / Math.tan((elevationDeg * Math.PI) / 180);
  const az = (azimuthDeg * Math.PI) / 180;
  const de = -len * Math.sin(az);
  const dn = -len * Math.cos(az);
  return convexHull([...ring, ...ring.map((p) => ({ e: p.e + de, n: p.n + dn }))]);
}

export interface KeyNeighbor<T extends Neighbor = Neighbor> {
  n: T;
  /** 冬至の 8〜16 時のうち、この建物の影が target にかかる時間 [時間] */
  hours: number;
}

/**
 * 影を落とす建物を、影の時間の長い順に（同じ時間なら高い順）。target = 敷地・計画建物の輪郭（東・北）。
 * 影の範囲は建物の屋上までの凸包なので、凹んだ建物では実際より少し広めに数える（安全側の絞り込み）。想定の家・隠した建物は対象外
 */
export function rankShadowCasters<T extends Neighbor>(list: T[], target: EN[] | null, lat: number, lon: number, year: number): KeyNeighbor<T>[] {
  if (!target || target.length < 3) return [];
  const sun = winterSamples(lat, lon, year);
  if (!sun.length) return [];
  const out: KeyNeighbor<T>[] = [];
  for (const n of list) {
    if (n.planned || (n.hidden && n.hideMode !== 'view')) continue;
    if (n.ring.length < 3 || !(n.height > 0)) continue;
    let k = 0;
    for (const s of sun) if (ringsOverlap(shadowHull(n.ring, n.height, s.azimuth, s.elevation), target)) k++;
    if (k > 0) out.push({ n, hours: k * KEY_HOURS.stepH });
  }
  return out.sort((a, b) => b.hours - a.hours || b.n.height - a.n.height);
}
