/**
 * 窓・戸の「種類・形・向き」の共通の語彙と操作。方眼の修正画面（planEditor）と 3D の「窓・戸」ツール（editTool3d）で同じものを使う。
 *
 * - 種類（kind）: 窓／開き戸／引戸／玄関ドア／開口／シャッター
 * - 窓の形（windowStyle）: 掃き出し／腰窓／小窓／高窓／縦スリット。腰高・高さはここで決める（仕様で「サッシ上端＝天井」なら 3D 側で上端をそろえる）
 * - 開き戸の吊元（hingeAtStart）と開く側（swingSide）、引戸の引き込む側（hingeAtStart = false で t0 側へ引き込む）と戸の面（swingSide）
 */
import type { Opening, WindowStyle } from './types';
import { sashWidthLabel, standardSashWidths } from './sash';

export const OPENING_LABEL: Record<Opening['kind'], string> = { window: '窓', door: '開き戸', sliding: '引戸', entrance: '玄関ドア', open: '開口（戸なし）', shutter: 'シャッター' };
export const OPENING_KINDS: Opening['kind'][] = ['window', 'door', 'sliding', 'entrance', 'open', 'shutter'];
/** 置くときの既定の幅 (mm) */
export const OPENING_DEFAULT: Record<Opening['kind'], number> = { window: 1690, door: 780, sliding: 1640, entrance: 900, open: 1640, shutter: 6000 };

/** 窓の形（腰高と高さ。天井付けの高窓は天井高から決める） */
export const WINDOW_SHAPES: Record<Exclude<WindowStyle, 'none'>, { label: string; short: string; sill: (ch: number) => number; height: (ch: number) => number; width?: number }> = {
  hakidashi: { label: '掃き出し（床から天井まで。引違い）', short: '掃出し', sill: () => 0, height: (ch) => ch },
  koshi: { label: '腰窓（腰 900・引違い）', short: '腰窓', sill: () => 900, height: (ch) => ch - 900 },
  small: { label: '小窓（浴室・トイレ。曇りガラス・縦すべり出し）', short: '小窓', sill: () => 1400, height: () => 600 },
  high: { label: '高窓（天井付け・横長 FIX）', short: '高窓', sill: (ch) => ch - 500, height: () => 500 },
  slit: { label: '縦スリット（細長・床から天井・FIX）', short: 'スリット', sill: () => 0, height: (ch) => ch, width: 300 },
};

/** 窓の形を当てる（腰高・高さ・幅を形に合わせる。中心は動かさない） */
export function applyWindowShape(op: Opening, style: Exclude<WindowStyle, 'none'>, ceilingHeight: number, wallLen?: number) {
  const sh = WINDOW_SHAPES[style];
  op.kind = 'window';
  op.windowStyle = style;
  // 形を選び直したら標準の高さ（立面図・3D データの高さの印は外す）
  delete op.heightFrom;
  op.sill = sh.sill(ceilingHeight);
  op.height = sh.height(ceilingHeight);
  if (sh.width && op.t1 - op.t0 > sh.width * 1.5) {
    const c = (op.t0 + op.t1) / 2;
    op.t0 = c - sh.width / 2;
    op.t1 = c + sh.width / 2;
  }
  if (wallLen != null) clampToWall(op, wallLen);
}

/** 表示用の名前（勝手口は開き戸の一種だが、名前は分ける） */
export function openingLabel(op: Opening): string {
  if (op.kind === 'window' && op.interior) return '室内窓';
  return op.kind === 'door' && op.service ? '勝手口' : OPENING_LABEL[op.kind];
}

/** 外壁の開き戸の役割を切り替える: 玄関ドア（3D で庇・ポーチが付く）⇄ 勝手口（庇・ポーチなし。ガレージの通用口もこれ） */
export function setExteriorDoorRole(op: Opening, role: 'entrance' | 'service', ceilingHeight: number) {
  if (role === 'entrance') {
    applyOpeningKind(op, 'entrance', ceilingHeight);
    return;
  }
  applyOpeningKind(op, 'door', ceilingHeight);
  op.service = true;
}

/**
 * 間仕切りの窓を「室内窓」（部屋と部屋の間の FIX のガラス）にする／外す。
 * 室内窓は 3D でカーテン・水切りを付けず、採光の窓にも数えない。腰高・高さは仕様でそろえ直さない
 */
export function setInteriorWindow(op: Opening, on: boolean) {
  if (op.kind !== 'window') return;
  if (on) {
    op.interior = true;
    delete op.heightFrom;
  } else delete op.interior;
}

/** 種類を変える（腰高・高さを種類の標準に。窓→窓以外は床まで、窓以外→窓は腰窓） */
export function applyOpeningKind(op: Opening, kind: Opening['kind'], ceilingHeight: number) {
  if (kind === op.kind) return;
  op.kind = kind;
  // 勝手口の印は開き戸のときだけ。種類を変えたら高さは標準（立面図・3D データの高さの印・室内窓の印は外す）
  delete op.service;
  delete op.heightFrom;
  delete op.interior;
  if (kind === 'window') {
    if (op.sill === 0 && op.height > 2000) applyWindowShape(op, 'hakidashi', ceilingHeight);
    else applyWindowShape(op, op.windowStyle && op.windowStyle !== 'none' ? op.windowStyle : 'koshi', ceilingHeight);
    return;
  }
  op.sill = 0;
  op.height = kind === 'shutter' ? Math.min(2300, ceilingHeight - 100) : kind === 'entrance' ? 2300 : 2000;
  op.windowStyle = undefined;
  if (op.hingeAtStart == null) op.hingeAtStart = true;
  if (op.swingSide == null) op.swingSide = 1;
}

/** 幅を変える（中心はそのまま。壁からはみ出さない） */
export function setOpeningWidth(op: Opening, widthMm: number, wallLen: number) {
  const c = (op.t0 + op.t1) / 2;
  const half = Math.max(150, Math.min(wallLen - 40, widthMm)) / 2;
  op.t0 = c - half;
  op.t1 = c + half;
  clampToWall(op, wallLen);
}

/** 片方の端をドラッグしたときの新しい範囲と、吸着した理由（「標準の幅 1,690（柱芯 1,820）」「端が方眼」。吸着なしは空） */
export interface OpeningEndDrag {
  t0: number;
  t1: number;
  hint: string;
}

/**
 * 窓・戸の片方の端をドラッグして幅を変える（CAD のつまみ。反対の端は止めたまま）。
 *  - 吸着: 標準の幅（柱芯の割 − 130 など。シャッター以外）と、動く端が方眼の線に来る位置のうち、指の位置にいちばん近いもの（snapTol 以内）
 *  - 隣の窓・戸と壁の端（20 mm）を越えない。幅は窓 150・戸 400・シャッター 1,500 mm 以上
 * @param t 指の位置（壁の始点からの距離 mm）
 * @param gridT 壁上の位置 → いちばん近い方眼の線の位置（方眼に吸着しないとき・斜めの壁は undefined）
 */
export function dragOpeningEnd(op: Pick<Opening, 't0' | 't1' | 'kind'>, end: 't0' | 't1', t: number, wallLen: number, others: Pick<Opening, 't0' | 't1'>[], snapTol: number, gridT?: (t: number) => number): OpeningEndDrag {
  const minW = op.kind === 'window' ? 150 : op.kind === 'shutter' ? 1500 : 400;
  const mid = (op.t0 + op.t1) / 2;
  const fixed = end === 't1' ? op.t0 : op.t1;
  const dir = end === 't1' ? 1 : -1;
  // 動かせる範囲（隣の窓・戸の手前・壁の端から 20 mm まで、幅は minW 以上）
  let lo: number;
  let hi: number;
  // 隣の窓・戸とは 20 mm あける（3D の「窓・戸」の道具と同じ）
  if (end === 't1') {
    lo = fixed + minW;
    hi = wallLen - 20;
    for (const o of others) if ((o.t0 + o.t1) / 2 > mid) hi = Math.min(hi, o.t0 - 20);
  } else {
    lo = 20;
    hi = fixed - minW;
    for (const o of others) if ((o.t0 + o.t1) / 2 < mid) lo = Math.max(lo, o.t1 + 20);
  }
  if (hi < lo) return { t0: op.t0, t1: op.t1, hint: '' };
  const std: { e: number; hint: string }[] = op.kind === 'shutter' ? [] : standardSashWidths().map((w) => ({ e: fixed + dir * w, hint: `標準の幅 ${sashWidthLabel(w)}` }));
  const grid = gridT ? [{ e: gridT(t), hint: '端が方眼' }] : [];
  const nearest = (cands: { e: number; hint: string }[]) => {
    let best: { e: number; hint: string; d: number } | null = null;
    for (const c of cands) {
      if (c.e < lo - 0.5 || c.e > hi + 0.5) continue;
      const d = Math.abs(c.e - t);
      if (d <= snapTol && (!best || d < best.d)) best = { ...c, d };
    }
    return best;
  };
  // 窓は標準の幅を優先（割に合わない幅はパネルで注意が出る）。戸は近い方
  const hit = op.kind === 'window' ? (nearest(std) ?? nearest(grid)) : nearest([...std, ...grid]);
  let e = hit ? hit.e : Math.round(t / 5) * 5;
  const hint = hit ? hit.hint : '';
  e = Math.max(lo, Math.min(hi, e));
  return end === 't1' ? { t0: fixed, t1: e, hint } : { t0: e, t1: fixed, hint };
}

export function clampToWall(op: Opening, wallLen: number) {
  const w = op.t1 - op.t0;
  if (op.t0 < 20) {
    op.t0 = 20;
    op.t1 = Math.min(wallLen - 20, 20 + w);
  }
  if (op.t1 > wallLen - 20) {
    op.t1 = wallLen - 20;
    op.t0 = Math.max(20, op.t1 - w);
  }
}

/** 吊元を反対側へ（引戸では引き込む側が変わる） */
export function flipHinge(op: Opening) {
  op.hingeAtStart = !(op.hingeAtStart !== false);
}
/** 開く側（壁のどちらの面へ開くか）を反対へ。引戸では戸の面が変わる */
export function flipSwing(op: Opening) {
  op.swingSide = (op.swingSide ?? 1) === 1 ? -1 : 1;
}

/** 引違いか（幅 1.2m 以上の掃き出し・腰窓）。FIX・すべり出しは false */
export function isSlidingWindow(op: Opening): boolean {
  // 室内窓は FIX のガラス
  if (op.interior) return false;
  const len = op.t1 - op.t0;
  const style = op.windowStyle ?? (len >= 1600 ? 'hakidashi' : len >= 1200 ? 'koshi' : 'small');
  return style === 'hakidashi' || style === 'koshi';
}

/** 一覧・パネル用の短い説明（「腰窓 引違い W1,690 腰900 H1,100」「開き戸 W780 右吊元」） */
export function openingSummary(op: Opening): string {
  const w = Math.round(op.t1 - op.t0).toLocaleString();
  if (op.kind === 'window') {
    // 室内窓（部屋と部屋の間のガラス）
    if (op.interior) return `室内窓（FIX）W${w}　腰 ${op.sill}　高さ ${op.height}`;
    const st = op.windowStyle && op.windowStyle !== 'none' ? WINDOW_SHAPES[op.windowStyle].short : isSlidingWindow(op) ? '引違い' : 'FIX';
    const how = isSlidingWindow(op) ? '引違い' : op.windowStyle === 'small' || op.windowStyle === 'slit' ? (op.windowStyle === 'slit' ? 'FIX' : '縦すべり出し') : 'FIX';
    return `${st}（${how}）W${w}　腰 ${op.sill}　高さ ${op.height}`;
  }
  if (op.kind === 'door' || op.kind === 'entrance') return `${openingLabel(op)} W${w}　${op.hingeAtStart !== false ? '始点側' : '終点側'}吊元・${op.kind === 'entrance' || op.service ? '外開き' : (op.swingSide ?? 1) === 1 ? '表側へ開く' : '裏側へ開く'}`;
  if (op.kind === 'sliding') return `${op.t1 - op.t0 >= 1200 ? '引違い戸' : '片引き戸'} W${w}${op.t1 - op.t0 < 1200 ? `　${op.hingeAtStart === false ? '始点側' : '終点側'}へ引き込む` : ''}`;
  return `${OPENING_LABEL[op.kind]} W${w}`;
}
