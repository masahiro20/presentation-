/**
 * 実測の無い建物（国土地理院の建物）の高さの推定。初期値はここ 1 か所にまとめる（地域を広げるとき・ルールを見直すときはここを直す）。
 *
 * 根拠（2026-11-18）: 名古屋市 6 区（名東・天白・緑・守山・北・瑞穂の区役所から 250 m）の 2,607 棟で、
 * PLATEAU の実測の高さと突き合わせた（scripts は docs/specs/context-accuracy/spec.md）。
 *  - 普通建物: 足元 40 ㎡以上は実測の中央値 6.8 m（今までの値どおり）。
 *    30 ㎡未満は中央値 3.1〜4.0 m（物置・車庫・離れ = 平屋）、30〜40 ㎡は 5.8 m 前後。今までは一律 6.8 m で、小さな建物を 2 階建ての高さにしていた。
 *  - 堅ろう建物: 150 ㎡未満は中央値 10.0 m、150 ㎡以上は 12.5〜13.9 m。ばらつきが大きい（3〜10 階が混ざる）ので、影に効く建物は現地で確かめる。
 * 見直しの効果（同じ 2,607 棟）: 絶対誤差の中央値 1.68 m → 1.12 m（普通建物だけなら 1.43 m → 0.88 m）。
 */
export const HEIGHT_ESTIMATE = {
  /** 普通建物（木造の住宅が中心） */
  ordinary: { tinyMaxArea: 30, tiny: 3.5, smallMaxArea: 40, small: 5.5, base: 6.8 },
  /** 堅ろう建物（鉄筋コンクリートなど。マンション・店舗・学校） */
  solid: { smallMaxArea: 150, small: 10, base: 12.5 },
  /** 高層建物 */
  highrise: 30,
} as const;

/** 国土地理院の建物の種別（1 = 普通・2 = 堅ろう・3 = 高層）と足元の面積 [㎡] から、推定の高さ [m] */
export function estimateGsiHeight(kind: 1 | 2 | 3, areaM2: number): number {
  const E = HEIGHT_ESTIMATE;
  if (kind === 3) return E.highrise;
  if (kind === 2) return areaM2 < E.solid.smallMaxArea ? E.solid.small : E.solid.base;
  if (areaM2 < E.ordinary.tinyMaxArea) return E.ordinary.tiny;
  if (areaM2 < E.ordinary.smallMaxArea) return E.ordinary.small;
  return E.ordinary.base;
}

/** 足元の輪郭（東・北 m）の面積 [㎡] */
export function ringArea(ring: { e: number; n: number }[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.e * q.n - q.e * p.n;
  }
  return Math.abs(a) / 2;
}

/** 画面の注記に出す、推定の決め方の一文 */
export const HEIGHT_ESTIMATE_NOTE = `普通建物 約7m（30㎡未満の小さな建物は ${HEIGHT_ESTIMATE.ordinary.tiny}m）・堅ろう建物 ${HEIGHT_ESTIMATE.solid.small}〜${HEIGHT_ESTIMATE.solid.base}m・高層 ${HEIGHT_ESTIMATE.highrise}m`;
