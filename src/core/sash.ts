/**
 * 窓（サッシ）の標準の幅。木造は柱芯 910（半間 455）の割に窓を入れるので、サッシの枠外寸法は
 * 「柱芯の割 − 柱（105）と取り合い（計 130）」の値になる: 780（柱芯 910）・1,235（1,365）・1,690（1,820）・2,600（2,730）…
 * 半間（455）には 405、ほかに 640・730・1,370・1,640・2,550・3,510 などのメーカー標準寸法がある。
 * 読み取った幅がこのどれにも近くない窓は、記号を読み違えたか（枠の線を取り損ねた）、特注の窓。
 */

/** 柱芯の割から外れる標準寸法（メーカーの呼称 06・07・13・16・25・34 など） */
const EXTRA = [405, 640, 730, 1370, 1640, 2550, 3510];
/** 柱芯の割（半間 455 の整数倍、1 間以上）からの引き（柱 105 ＋ 取り合い 25） */
const BAY_DEDUCT = 130;
/** これ以下の幅はスリット・小窓（何でもあり） */
export const SASH_MIN_CHECK = 450;

/** 標準の幅の一覧（昇順）。maxBays = 半間の数（既定 12 = 5.46 m まで） */
export function standardSashWidths(maxBays = 12): number[] {
  const set = new Set<number>(EXTRA);
  for (let n = 2; n <= maxBays; n++) set.add(n * 455 - BAY_DEDUCT);
  return [...set].sort((a, b) => a - b);
}

/** いちばん近い標準の幅 */
export function nearestSashWidth(w: number): number {
  const list = standardSashWidths();
  let best = list[0];
  for (const x of list) if (Math.abs(x - w) < Math.abs(best - w)) best = x;
  return best;
}

/** 標準の幅か（tol 以内）。スリット・小窓（450 以下）は常に可 */
export function isStandardSashWidth(w: number, tol = 70): boolean {
  if (w <= SASH_MIN_CHECK) return true;
  return Math.abs(nearestSashWidth(w) - w) <= tol;
}

/** 標準の幅の説明（「1,235（柱芯 1,365）」「405（半間）」） */
export function sashWidthLabel(w: number): string {
  const bay = w + BAY_DEDUCT;
  const n = Math.round(bay / 455);
  const onBay = Math.abs(n * 455 - bay) <= 1 && n >= 2;
  return `${w.toLocaleString()}${onBay ? `（柱芯 ${(n * 455).toLocaleString()}）` : w === 405 ? '（半間）' : ''}`;
}

/** 3D・方眼のパネルに出す幅の候補（よく使う 6 つ） */
export const SASH_QUICK_WIDTHS = [405, 780, 1235, 1690, 2600, 3510];
