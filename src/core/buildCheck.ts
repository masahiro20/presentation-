/**
 * 建築として成り立つかの検証: 読み取った間取り（BuildingModel）が、現実の住宅として成立する形・寸法・接続になっているかを、
 * 数値で確かめる。図面の線の再現だけでは、戸が壁にめり込む・階段が上の階につながらない・窓が天井の上にある、といった
 * 「建物として不自然な 3D」ができることがある。ここでは形を直さず、見つけて、根拠と確からしさを付けて返す。
 *
 * 既存の検証との分担:
 *   - 木造の常識チェック（parser/woodCheck）: 柱・梁のスパン・直下率など構造と寸法の違和感
 *   - 住まいの成立チェック（parser/livingCheck）: 玄関から行けない部屋・戸の向き先・採光
 *   - この検証（buildCheck）: 建具と壁の位置関係・戸の可動範囲・階段の寸法と上下階の接続と頭上・階高の整合・壁の重なり
 *
 * 根拠は 5 種類に分けて持つ（混同しない）:
 *   law       = 法令の必須条件（条文を明記。e-Gov の現行条文で確認したものだけ）
 *   geometry  = 形・座標・接続の破綻（法令ではなく、物として成り立たない）
 *   structure = 構造上の成立条件（図面だけでは確定できないので、安全性の判定はしない。注意の喚起だけ）
 *   practice  = 一般的な住宅設計の寸法・慣習（違反ではない）
 *   ergonomics = 使いやすさ（違反ではない）
 *
 * 深刻さは 3 段階:
 *   critical = 重大（形の破綻・物理的な干渉・法令の数値を外れている）
 *   confirm  = 要確認（読み取りの不確かさがあり、図面と見比べてほしい）
 *   note     = 参考（一般的な設計・使いやすさから見た改善の余地）
 */
import type { BuildingModel, Floor, Opening, Stair, Vec2, Wall } from './types';
import { pointInPolygon } from './geometry';
import { effectiveStair, effectiveStepCount, lFlightWidth, stairFrame, stairTreadDepth, wrapFlights } from './stairs';

export type BuildSeverity = 'critical' | 'confirm' | 'note';
export type BuildBasisType = 'law' | 'geometry' | 'structure' | 'practice' | 'ergonomics';

export interface BuildIssue {
  /** 同じ問題に同じ id（階・対象・種類から決まる） */
  id: string;
  /** 問題の種類 */
  kind: string;
  severity: BuildSeverity;
  /** 階（1 = 1 階） */
  level: number;
  /** 対象の物 */
  target: { type: 'opening' | 'stair' | 'wall' | 'room' | 'floor'; id: string; label: string };
  /** 場所（図面の座標 mm）。3D・方眼で示すときに使う */
  at: Vec2 | null;
  /** 何が起きているか（1 行） */
  title: string;
  /** そう判断した根拠（測った値つき） */
  reason: string;
  /** 参照した基準 */
  basis: { type: BuildBasisType; ref: string };
  /** 確からしさ 0〜1（読み取りの不確かさ・寸法の測り方の違いを含む） */
  confidence: number;
  /** すすめる対応 */
  advice: string;
  /** 測った値（mm・度・段など） */
  values?: Record<string, number>;
  /** 形を変えずに直せるもの（原因が 1 つに決まるときだけ）。applyBuildFix で実行する */
  fix?: { type: 'remove-duplicate-wall'; wallId: string; label: string };
}

/** 法令の数値（e-Gov の現行条文で確認: 2026-11-17） */
export const LAW = {
  /** 建築基準法施行令 第 23 条 1 項ただし書: 住宅の階段（共同住宅の共用を除く）の蹴上は 23cm 以下、踏面は 15cm 以上 */
  stairRiserMax: 230,
  stairTreadMin: 150,
  /** 同 表（四）: 階段及びその踊場の幅 75cm 以上 */
  stairWidthMin: 750,
  /** 同 表（四）の蹴上・踏面（住宅の特例を使わない一般の階段）。住宅では必須ではないので「参考」に使う */
  stairRiserGeneral: 220,
  stairTreadGeneral: 210,
  /** 建築基準法施行令 第 21 条: 居室の天井の高さは 2.1m 以上（一室で高さが異なるときは平均） */
  ceilingMin: 2100,
  /** 同 第 24 条: 高さが 4m をこえる階段は 4m 以内ごとに踊場 */
  landingEvery: 4000,
} as const;

const REF = {
  stair23: '建築基準法施行令 第23条（階段の幅・蹴上げ・踏面）',
  ceiling21: '建築基準法施行令 第21条（居室の天井の高さ）',
  landing24: '建築基準法施行令 第24条（踊場の位置）',
  geometry: '形・座標の整合（法令ではなく、物として成り立つか）',
  practiceDoor: '一般的な住宅の室内戸（有効幅 700mm 前後）。法令の数値ではない',
  practiceSwing: '開き戸は 90° 開いて通るのが一般的。法令の数値ではない',
  practiceHeadroom: '階段の上は吹抜けているのが通常（頭上 2m 前後を確保）。住宅の階段の頭上高さに法令の数値は無い',
  practiceStory: '木造住宅の階高は 2.6〜3.2m 程度が一般的。法令の数値ではない',
} as const;

const len = (w: { a: Vec2; b: Vec2 }) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
const mm = (v: number) => `${Math.round(v).toLocaleString('en-US')} mm`;
const round = (v: number, d = 0) => +v.toFixed(d);

function wallFrame(w: Wall) {
  const L = len(w) || 1;
  const u = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
  return { L, u, n: { x: -u.y, y: u.x } };
}

function pointOnWall(w: Wall, t: number): Vec2 {
  const { u } = wallFrame(w);
  return { x: w.a.x + u.x * t, y: w.a.y + u.y * t };
}

/** 点が壁の体（芯から厚みの半分。margin だけ内側）の中にあるか。端は芯の端まで（丸めない） */
function insideWallBody(p: Vec2, x: Wall, margin: number): boolean {
  const { L, u, n } = wallFrame(x);
  const dx = p.x - x.a.x;
  const dy = p.y - x.a.y;
  const t = dx * u.x + dy * u.y;
  if (t < 0 || t > L) return false;
  return Math.abs(dx * n.x + dy * n.y) < x.thickness / 2 - margin;
}

/**
 * 開き戸を deg まで開いたとき、板が当たる壁。
 * 90° で板と平行に並ぶ壁は「壁に沿って開き切る」ふつうの納まりなので当たりにしない。
 */
function swingBlocker(f: Floor, w: Wall, hinge: Vec2, along: number, side: number, width: number, deg: number): Wall | null {
  const { u, n } = wallFrame(w);
  const a = (deg * Math.PI) / 180;
  const pivot = { x: hinge.x + n.x * side * (w.thickness / 2), y: hinge.y + n.y * side * (w.thickness / 2) };
  const dir = { x: u.x * along * Math.cos(a) + n.x * side * Math.sin(a), y: u.y * along * Math.cos(a) + n.y * side * Math.sin(a) };
  for (const x of f.walls) {
    if (x.id === w.id || x.arc) continue;
    const fx = wallFrame(x);
    if (deg >= 90 && Math.abs(fx.u.x * dir.x + fx.u.y * dir.y) > 0.95) continue;
    // 丁番のすぐそば（120mm）は枠・壁の角なので見ない。板に沿って 40mm ごとに確かめる
    for (let d = 120; d <= width - 20; d += 40) if (insideWallBody({ x: pivot.x + dir.x * d, y: pivot.y + dir.y * d }, x, 15)) return x;
  }
  return null;
}

const KIND_LABEL: Record<Opening['kind'], string> = { window: '窓', door: '開き戸', sliding: '引戸', entrance: '玄関ドア', open: '開口', shutter: 'シャッター' };

/** 部屋名つきの建具の呼び名（場所が分かるように） */
function openingLabel(f: Floor, w: Wall | undefined, o: Opening): string {
  if (!w) return KIND_LABEL[o.kind];
  const { n } = wallFrame(w);
  const c = pointOnWall(w, (o.t0 + o.t1) / 2);
  const names = [1, -1]
    .map((s) => f.rooms.find((r) => pointInPolygon({ x: c.x + n.x * s * (w.thickness / 2 + 250), y: c.y + n.y * s * (w.thickness / 2 + 250) }, r.polygon))?.name)
    .filter((x): x is string => !!x);
  return `${[...new Set(names)].join('・') || '（室名なし）'}の${KIND_LABEL[o.kind]}`;
}

// ---------------------------------------------------------------- 1. 建具と壁の位置関係
function checkOpenings(f: Floor, out: BuildIssue[]) {
  const walls = new Map(f.walls.map((w) => [w.id, w]));
  const byWall = new Map<string, Opening[]>();
  for (const o of f.openings) {
    const w = walls.get(o.wallId);
    const label = openingLabel(f, w, o);
    const base = { level: f.level, target: { type: 'opening' as const, id: o.id, label } };
    if (!w) {
      out.push({ ...base, id: `bc-${o.id}-nowall`, kind: 'opening-no-wall', severity: 'critical', at: null, title: `${f.level}階 ${label}: 取り付く壁がありません`, reason: `建具の壁（${o.wallId}）がこの階にありません。`, basis: { type: 'geometry', ref: REF.geometry }, confidence: 0.95, advice: '壁を消したときに建具が残ったものです。建具を消すか、壁を描き直してください。' });
      continue;
    }
    (byWall.get(w.id) ?? byWall.set(w.id, []).get(w.id)!).push(o);
    const { L } = wallFrame(w);
    const at = pointOnWall(w, (o.t0 + o.t1) / 2);
    const width = o.t1 - o.t0;
    const over = Math.max(-o.t0, o.t1 - L);
    if (over > 15)
      out.push({ ...base, id: `bc-${o.id}-outside`, kind: 'opening-outside-wall', severity: 'critical', at, title: `${f.level}階 ${label}: 壁の端から ${mm(over)} はみ出しています`, reason: `壁の長さ ${mm(L)} に対して、建具が ${mm(o.t0)}〜${mm(o.t1)} の位置にあります。`, basis: { type: 'geometry', ref: REF.geometry }, confidence: 0.9, advice: '建具の位置か幅、または壁の長さの読み取りを図面と見比べてください。', values: { over: round(over), wallLength: round(L) } });
    if (o.sill < -5)
      out.push({ ...base, id: `bc-${o.id}-below`, kind: 'opening-below-floor', severity: 'critical', at, title: `${f.level}階 ${label}: 下端が床より ${mm(-o.sill)} 下にあります`, reason: `腰高が ${mm(o.sill)}（床より下）です。`, basis: { type: 'geometry', ref: REF.geometry }, confidence: 0.9, advice: '腰高を 0 以上に直してください。' });
    const top = o.sill + o.height;
    if (top > f.height + 5)
      out.push({ ...base, id: `bc-${o.id}-above`, kind: 'opening-above-story', severity: 'critical', at, title: `${f.level}階 ${label}: 上端が上の階の床（階高 ${mm(f.height)}）を ${mm(top - f.height)} 越えています`, reason: `腰高 ${mm(o.sill)} ＋ 高さ ${mm(o.height)} ＝ ${mm(top)} で、この階の階高を越えます。`, basis: { type: 'geometry', ref: REF.geometry }, confidence: 0.9, advice: o.heightFrom ? '立面図から読んだ高さです。階高の読み取り（立面図の FL）と見比べてください。' : '窓の高さは推定値です。立面図を読み込むと図面どおりになります。', values: { top: round(top), storyHeight: round(f.height) } });
    else if (o.kind !== 'window' && o.kind !== 'shutter' && top > f.ceilingHeight + 60)
      out.push({ ...base, id: `bc-${o.id}-ceiling`, kind: 'door-above-ceiling', severity: 'confirm', at, title: `${f.level}階 ${label}: 上端が天井（${mm(f.ceilingHeight)}）より ${mm(top - f.ceilingHeight)} 高い`, reason: `戸・開口の上端 ${mm(top)} が天井高を越えています。`, basis: { type: 'geometry', ref: REF.geometry }, confidence: 0.7, advice: '戸の高さか、天井高の設定を確かめてください。', values: { top: round(top), ceiling: round(f.ceilingHeight) } });
    // 人が通る建具の幅
    if ((o.kind === 'door' || o.kind === 'sliding' || o.kind === 'entrance' || o.kind === 'open') && width < 600) {
      const tiny = width < 450;
      // 図面から読めず、常識で置いた出入口（確からしさ 0.5 以下）は、幅も当て推量
      const guessed = (o.confidence ?? 1) <= 0.5;
      out.push({ ...base, id: `bc-${o.id}-narrow`, kind: 'door-narrow', severity: tiny && !guessed ? 'critical' : 'confirm', at, title: `${f.level}階 ${label}: 幅 ${mm(width)} では${tiny ? '人が通れません' : '通りにくい'}`, reason: `開口の幅が ${mm(width)} です（枠・戸の厚みを引くと、通れる幅はさらに狭くなります）。${guessed ? '図面から読めなかったので、空いている壁に置いた出入口です。' : ''}`, basis: { type: tiny ? 'geometry' : 'practice', ref: tiny ? REF.geometry : REF.practiceDoor }, confidence: guessed ? 0.5 : tiny ? 0.8 : 0.6, advice: guessed ? '図面の出入口の位置と幅に合わせて、方眼で置き直してください。' : '図面の建具の幅と見比べてください。戸袋・枠の線を戸として読んでいることがあります。', values: { width: round(width) } });
    }
  }
  // 同じ壁の上で重なる建具
  for (const [wid, list] of byWall) {
    const w = walls.get(wid)!;
    const sorted = [...list].sort((a, b) => a.t0 - b.t0);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const ov = Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0);
      // 上下に分かれた窓（高窓と腰窓など）は重なりではない
      const vertical = a.sill + a.height <= b.sill + 5 || b.sill + b.height <= a.sill + 5;
      if (ov > 60 && !vertical)
        out.push({ id: `bc-${a.id}-${b.id}-overlap`, kind: 'openings-overlap', severity: 'critical', level: f.level, target: { type: 'opening', id: b.id, label: openingLabel(f, w, b) }, at: pointOnWall(w, (Math.max(a.t0, b.t0) + Math.min(a.t1, b.t1)) / 2), title: `${f.level}階 ${openingLabel(f, w, a)} と ${KIND_LABEL[b.kind]} が、同じ壁の上で ${mm(ov)} 重なっています`, reason: `同じ壁の ${mm(a.t0)}〜${mm(a.t1)} と ${mm(b.t0)}〜${mm(b.t1)} に建具があります。`, basis: { type: 'geometry', ref: REF.geometry }, confidence: 0.85, advice: '同じ建具を 2 回読んでいるか、位置がずれています。片方を消すか位置を直してください。', values: { overlap: round(ov) } });
    }
  }
}

// ---------------------------------------------------------------- 2. 開き戸の可動範囲（壁にめり込む・当たる）
function checkDoorSwing(f: Floor, out: BuildIssue[]) {
  const walls = new Map(f.walls.map((w) => [w.id, w]));
  for (const o of f.openings) {
    if (o.kind !== 'door') continue;
    const w = walls.get(o.wallId);
    if (!w || w.exterior) continue; // 外壁の戸（勝手口・テラス）は外へ開くので、室内の壁とは当たらない
    const { u, n } = wallFrame(w);
    const width = o.t1 - o.t0;
    if (width < 450 || width > 1400) continue;
    const hingeStart = o.hingeAtStart !== false;
    const hinge = pointOnWall(w, hingeStart ? o.t0 : o.t1);
    const along = hingeStart ? 1 : -1;
    const side = o.swingSide ?? 1;
    let blockedAt: number | null = null;
    let blocker: Wall | null = null;
    for (let deg = 15; deg <= 90 && !blocker; deg += 15) {
      blocker = swingBlocker(f, w, hinge, along, side, width, deg);
      if (blocker) blockedAt = deg;
    }
    if (blockedAt == null || !blocker) continue;
    const label = openingLabel(f, w, o);
    // 逆の側へ開けば当たらないか（＝開く側の読み違いの可能性）
    let otherFree = true;
    for (let deg = 15; deg <= 90 && otherFree; deg += 15) if (swingBlocker(f, w, hinge, along, -side, width, deg)) otherFree = false;
    const severe = blockedAt <= 45;
    out.push({
      id: `bc-${o.id}-swing`,
      kind: 'door-hits-wall',
      severity: severe ? 'critical' : 'confirm',
      level: f.level,
      target: { type: 'opening', id: o.id, label },
      at: pointOnWall(w, (o.t0 + o.t1) / 2),
      title: `${f.level}階 ${label}: 開くと ${blockedAt}° で壁に当たります`,
      reason: `幅 ${mm(width)} の戸を、${hingeStart ? '始点' : '終点'}側の丁番で開くと、${blockedAt}° の所で別の壁（厚み ${mm(blocker.thickness)}）に重なります。`,
      basis: { type: severe ? 'geometry' : 'practice', ref: severe ? REF.geometry : REF.practiceSwing },
      // 開く側・丁番の読み違い、壁の読み過ぎのどれかは、この検証だけでは決められない
      confidence: otherFree ? 0.7 : 0.55,
      advice: otherFree ? '反対の側へ開けば当たりません。開く側（図面の円弧の向き）を確かめてください。' : 'どちらへ開いても当たります。戸の位置・丁番の側か、当たっている壁（読み過ぎの壁）を図面と見比べてください。',
      values: { blockedAtDeg: blockedAt, width: round(width) },
    });
  }
}

// ---------------------------------------------------------------- 3. 階段（寸法・上下階の接続・頭上）
function flightWidthOf(s0: Stair): number {
  const s = effectiveStair(s0);
  const { Ls, Lt } = stairFrame(s);
  if (s.kind === 'straight') return Lt;
  const wrap = wrapFlights(s);
  if (wrap) return wrap.fw;
  if (s.kind === 'u') return Lt / 2;
  if (s.kind === 'uOpen') return Math.min(1000, Math.max(910, (Lt - 300) / 2));
  return lFlightWidth(s, Ls, Lt);
}

function rectIoU(a: Stair, b: Stair): number {
  const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const iy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  const inter = ix * iy;
  const ua = (a.maxX - a.minX) * (a.maxY - a.minY) + (b.maxX - b.minX) * (b.maxY - b.minY) - inter;
  return ua > 0 ? inter / ua : 0;
}

function checkStairs(model: BuildingModel, f: Floor, out: BuildIssue[]) {
  const upper = model.floors.find((x) => x.level === f.level + 1);
  for (const s of f.stairs) {
    if (!s.goesUp) continue;
    const at = { x: (s.minX + s.maxX) / 2, y: (s.minY + s.maxY) / 2 };
    const base = { level: f.level, target: { type: 'stair' as const, id: s.id, label: `${f.level}階から昇る階段` }, at };
    const rise = f.height;
    const n = effectiveStepCount(rise, s);
    const riser = rise / n;
    const tread = stairTreadDepth(s, n);
    const width = flightWidthOf(s);
    const stepsFrom = s.steps ? '図面の段数' : '階高からの推定の段数';
    if (riser > LAW.stairRiserMax + 0.5)
      out.push({ ...base, id: `bc-${s.id}-riser`, kind: 'stair-riser', severity: 'critical', title: `${f.level}階 階段: 蹴上 ${round(riser)} mm（上限 230 mm を超えています）`, reason: `階高 ${mm(rise)} ÷ ${n} 段（${stepsFrom}）＝ 蹴上 ${round(riser, 1)} mm。`, basis: { type: 'law', ref: REF.stair23 }, confidence: s.steps && model.heights ? 0.85 : 0.5, advice: model.heights ? '段数か階段の長さを確かめてください。' : '階高が標準値（推定）です。立面図を読み込むと、図面の階高で計算し直します。', values: { riser: round(riser, 1), steps: n, rise: round(rise) } });
    else if (riser > LAW.stairRiserGeneral + 0.5 && s.steps)
      out.push({ ...base, id: `bc-${s.id}-riser-steep`, kind: 'stair-riser-steep', severity: 'note', title: `${f.level}階 階段: 蹴上 ${round(riser)} mm（急な階段）`, reason: `階高 ${mm(rise)} ÷ ${n} 段＝ 蹴上 ${round(riser, 1)} mm。住宅の上限 230 mm の中ですが、一般の階段の基準 220 mm より急です。`, basis: { type: 'ergonomics', ref: `${REF.stair23} 表（四）の値を、昇りやすさの目安として参照（住宅では必須ではない）` }, confidence: 0.5, advice: '昇りやすさを優先するなら、段数を 1 段増やせるか検討してください。', values: { riser: round(riser, 1), steps: n } });
    if (tread > 0 && tread < LAW.stairTreadMin - 0.5)
      out.push({ ...base, id: `bc-${s.id}-tread`, kind: 'stair-tread', severity: 'critical', title: `${f.level}階 階段: 踏面 ${round(tread)} mm（下限 150 mm を下回っています）`, reason: `階段の範囲に ${n} 段を割ると、踏面は ${round(tread)} mm です。`, basis: { type: 'law', ref: REF.stair23 }, confidence: 0.55, advice: '階段の範囲（長さ）の読み取りが短い可能性があります。図面の階段と見比べてください。', values: { tread: round(tread), steps: n } });
    else if (tread > 0 && tread < LAW.stairTreadGeneral - 0.5)
      out.push({ ...base, id: `bc-${s.id}-tread-short`, kind: 'stair-tread-short', severity: 'note', title: `${f.level}階 階段: 踏面 ${round(tread)} mm（足を載せる奥行が浅い）`, reason: `踏面 ${round(tread)} mm。住宅の下限 150 mm の中ですが、一般の階段の基準 210 mm より浅い寸法です。`, basis: { type: 'ergonomics', ref: `${REF.stair23} 表（四）の値を、昇りやすさの目安として参照（住宅では必須ではない）` }, confidence: 0.5, advice: '階段の長さに余裕があれば、踏面を広げられます。', values: { tread: round(tread) } });
    if (width < LAW.stairWidthMin - 0.5) {
      // 読み取った範囲は壁芯のことが多く、有効幅は壁の厚みぶん狭い。逆に、範囲の読み取りが狭すぎることもある
      const tiny = width < 600;
      out.push({ ...base, id: `bc-${s.id}-width`, kind: 'stair-width', severity: tiny ? 'critical' : 'confirm', title: `${f.level}階 階段: 幅 ${round(width)} mm（75 cm 以上が必要）`, reason: `階段 1 列の幅が ${round(width)} mm です（読み取った範囲の寸法。手すりは 10cm まで無いものとして測ります）。`, basis: { type: 'law', ref: REF.stair23 }, confidence: tiny ? 0.6 : 0.45, advice: '階段の範囲（幅）の読み取りを図面と見比べてください。折り返し・かね折れの種類の取り違えでも狭くなります。', values: { width: round(width) } });
    }
    if (rise > LAW.landingEvery && effectiveStair(s).kind === 'straight')
      out.push({ ...base, id: `bc-${s.id}-landing`, kind: 'stair-landing', severity: 'confirm', title: `${f.level}階 階段: 高さ ${mm(rise)} の直階段に踊場がありません`, reason: `高さが 4 m をこえる階段は、4 m 以内ごとに踊場が要ります。`, basis: { type: 'law', ref: REF.landing24 }, confidence: 0.5, advice: '階高の読み取りを確かめてください。', values: { rise: round(rise) } });
    // 上の階との接続
    if (!upper) {
      out.push({ ...base, id: `bc-${s.id}-noupper`, kind: 'stair-no-upper-floor', severity: 'critical', title: `${f.level}階 階段: 昇った先の階がありません`, reason: `${f.level + 1} 階が読み込まれていません。`, basis: { type: 'geometry', ref: REF.geometry }, confidence: 0.7, advice: '上の階の図面が読めていないか、階段の「昇り／降り」の読み違いです。' });
      continue;
    }
    if (Math.abs(f.elevation + f.height - upper.elevation) > 20)
      out.push({ ...base, id: `bc-${s.id}-gap`, kind: 'stair-floor-gap', severity: 'critical', title: `${f.level}階 階段: 昇り切った高さが、上の階の床と ${mm(Math.abs(f.elevation + f.height - upper.elevation))} ずれています`, reason: `この階の床 ${mm(f.elevation)} ＋ 階高 ${mm(f.height)} ≠ 上の階の床 ${mm(upper.elevation)}。`, basis: { type: 'geometry', ref: REF.geometry }, confidence: 0.9, advice: '階高か、上の階の床の高さを直してください。' });
    // 中間の階（3 階建ての 2 階）は、下から来た階段と上へ行く階段を 1 つの「昇る階段」で持つことがあるので、向きは問わない
    const mate = [...upper.stairs].sort((a, b) => rectIoU(s, b) - rectIoU(s, a))[0];
    const iou = mate ? rectIoU(s, mate) : 0;
    if (!mate || iou < 0.15)
      out.push({ ...base, id: `bc-${s.id}-nomate`, kind: 'stair-not-connected', severity: 'confirm', title: `${f.level}階 階段: 上の階の同じ位置に、階段がありません`, reason: mate ? `上の階の階段との重なりが ${Math.round(iou * 100)}% しかありません。` : `${upper.level} 階に階段が読めていません。`, basis: { type: 'geometry', ref: REF.geometry }, confidence: 0.6, advice: '上の階の階段の読み落としか、上下階の重ね位置のずれです。方眼の「上下階」で確かめてください。', values: { overlap: round(iou, 2) } });
    else if (!mate.goesUp && iou < 0.75)
      out.push({ ...base, id: `bc-${s.id}-range`, kind: 'stair-range-mismatch', severity: 'confirm', title: `${f.level}階 階段: 上の階の「降りる階段」と範囲が合いません（重なり ${Math.round(iou * 100)}%）`, reason: `${f.level}階は ${mm(s.maxX - s.minX)} × ${mm(s.maxY - s.minY)}、${upper.level}階は ${mm(mate.maxX - mate.minX)} × ${mm(mate.maxY - mate.minY)} と読めています。同じ階段なら同じ範囲になります。`, basis: { type: 'geometry', ref: REF.geometry }, confidence: 0.55, advice: 'どちらかの階で、階段の範囲（踊り場・昇り始めの段）の読み取りが違います。図面と見比べてください。', values: { overlap: round(iou, 2) } });
    // 頭上: 階段の真上（上の階）に床（部屋）があると、昇る途中で頭が当たる
    let total = 0;
    let covered = 0;
    let coverName = '';
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 6; j++) {
        const p = { x: s.minX + ((i + 0.5) / 6) * (s.maxX - s.minX), y: s.minY + ((j + 0.5) / 6) * (s.maxY - s.minY) };
        total++;
        if (upper.stairs.some((u) => p.x >= u.minX - 50 && p.x <= u.maxX + 50 && p.y >= u.minY - 50 && p.y <= u.maxY + 50)) continue;
        const r = upper.rooms.find((x) => x.type !== 'void' && x.type !== 'stairs' && pointInPolygon(p, x.polygon));
        if (r) {
          covered++;
          coverName = r.name || coverName;
        }
      }
    const frac = total ? covered / total : 0;
    if (frac > 0.5)
      out.push({ ...base, id: `bc-${s.id}-headroom`, kind: 'stair-headroom', severity: frac > 0.8 ? 'critical' : 'confirm', title: `${f.level}階 階段: 真上の ${Math.round(frac * 100)}% に上の階の床${coverName ? `（${coverName}）` : ''}があります`, reason: `階段の範囲の上に、吹抜・階段ではない部屋の床が重なっています。昇る途中で頭が当たります。`, basis: { type: 'practice', ref: REF.practiceHeadroom }, confidence: 0.55, advice: '上の階の階段の範囲の読み落とし、または上下階の重ね位置のずれです。', values: { coveredRatio: round(frac, 2) } });
  }
}

// ---------------------------------------------------------------- 4. 階の高さ・床の接続
function checkFloors(model: BuildingModel, out: BuildIssue[]) {
  const floors = [...model.floors].sort((a, b) => a.level - b.level);
  floors.forEach((f, i) => {
    const base = { level: f.level, target: { type: 'floor' as const, id: `F${f.level}`, label: `${f.level}階` }, at: null };
    const next = floors[i + 1];
    if (next && Math.abs(f.elevation + f.height - next.elevation) > 20)
      out.push({ ...base, id: `bc-F${f.level}-stack`, kind: 'floor-stack', severity: 'critical', title: `${f.level}階: 階高と、上の階の床の高さが合いません`, reason: `床 ${mm(f.elevation)} ＋ 階高 ${mm(f.height)} ＝ ${mm(f.elevation + f.height)} に対して、${next.level}階の床は ${mm(next.elevation)}（差 ${mm(Math.abs(f.elevation + f.height - next.elevation))}）。`, basis: { type: 'geometry', ref: REF.geometry }, confidence: 0.95, advice: '階高か上の階の床の高さを直してください（すき間・めり込みができます）。' });
    if (f.ceilingHeight > f.height - 120)
      out.push({ ...base, id: `bc-F${f.level}-ceil-over`, kind: 'ceiling-over-story', severity: 'critical', title: `${f.level}階: 天井高 ${mm(f.ceilingHeight)} が、階高 ${mm(f.height)} に納まりません`, reason: `天井の上に、床組み・梁の入る高さ（少なくとも 120 mm）がありません。`, basis: { type: 'geometry', ref: REF.geometry }, confidence: 0.85, advice: '天井高か階高を確かめてください。' });
    if (f.ceilingHeight < LAW.ceilingMin - 0.5)
      out.push({ ...base, id: `bc-F${f.level}-ceil-low`, kind: 'ceiling-low', severity: 'confirm', title: `${f.level}階: 天井高 ${mm(f.ceilingHeight)}（居室は平均 2.1 m 以上が必要）`, reason: `この階の天井高が 2,100 mm 未満です。居室でない部屋・一部が低いだけなら問題ありません（平均の高さで判定します）。`, basis: { type: 'law', ref: REF.ceiling21 }, confidence: 0.5, advice: '天井高の設定を確かめてください。' });
    if (f.height < 2300 || f.height > 3600)
      out.push({ ...base, id: `bc-F${f.level}-story`, kind: 'story-height-unusual', severity: 'note', title: `${f.level}階: 階高 ${mm(f.height)} は、木造住宅として珍しい値です`, reason: `階高 ${mm(f.height)}。`, basis: { type: 'practice', ref: REF.practiceStory }, confidence: 0.4, advice: model.heights ? '立面図の FL の読み取りを確かめてください。' : '階高は標準値（推定）です。' });
  });
}

// ---------------------------------------------------------------- 4b. 立面図との照合
/** 立面図と照らし合わせて分かる読み違いの疑い（形は変えずに知らせる） */
function checkElevationAgreement(model: BuildingModel, out: BuildIssue[]) {
  // 立面図に見当たらない窓（立面図との並びが確かに合っている面・階で、相手の無い平面図の窓）
  const unmatched = model.report?.elevationWindows?.unmatched ?? 0;
  if (unmatched > 0)
    out.push({
      id: 'bc-elev-win',
      kind: 'elevation-window-missing',
      severity: 'confirm',
      level: Math.min(...model.floors.map((f) => f.level)),
      target: { type: 'floor', id: 'all', label: '窓' },
      at: null,
      title: `立面図に見当たらない窓が ${unmatched} か所あります`,
      reason: '立面図と窓の並びが合っている面で、平面図にだけある窓です。平面図の線（壁の中の線・庇・手すり）を窓と読んだ疑いがあります。',
      basis: { type: 'geometry', ref: REF.geometry },
      confidence: 0.6,
      advice: '読み込み結果の注意書きに場所が出ています。方眼で確かめ、無い窓なら消してください（自動では消していません）。',
      values: { windows: unmatched },
    });
  // 立面図と平面図の建物の幅の照合（report.elevationSizes）は、読み取りの良い図面でも塀・下屋・車庫の扱いで食い違うことがあり、
  // まだ誤って知らせる。正解データで精度を確かめてから入れる（2026-11-22）
}

// ---------------------------------------------------------------- 5. 壁の重なり
function checkWallOverlap(f: Floor, out: BuildIssue[]) {
  const seen = new Set<string>();
  for (let i = 0; i < f.walls.length; i++) {
    const a = f.walls[i];
    if (a.arc) continue;
    const fa = wallFrame(a);
    if (fa.L < 300) continue;
    for (let j = i + 1; j < f.walls.length; j++) {
      const b = f.walls[j];
      if (b.arc) continue;
      const fb = wallFrame(b);
      if (fb.L < 300) continue;
      // 平行（1° 以内）
      if (Math.abs(fa.u.x * fb.u.y - fa.u.y * fb.u.x) > 0.018) continue;
      // 同じ芯の線上（芯のずれが、厚みの半分より小さい = 壁の体が重なる）
      const off = Math.abs((b.a.x - a.a.x) * fa.n.x + (b.a.y - a.a.y) * fa.n.y);
      const lim = Math.min(a.thickness, b.thickness) / 2;
      if (off > lim) continue;
      const tb0 = (b.a.x - a.a.x) * fa.u.x + (b.a.y - a.a.y) * fa.u.y;
      const tb1 = (b.b.x - a.a.x) * fa.u.x + (b.b.y - a.a.y) * fa.u.y;
      const lo = Math.max(0, Math.min(tb0, tb1));
      const hi = Math.min(fa.L, Math.max(tb0, tb1));
      const ov = hi - lo;
      // 端で少し重なるのは、つなぎ目（柱の位置）なので問題にしない
      if (ov < Math.max(300, a.thickness * 2)) continue;
      const key = `${a.id}|${b.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // 片方がもう片方の体にすっぽり入り、建具も高さの指定も無いなら、消しても形は変わらない
      const tb = [Math.min(tb0, tb1), Math.max(tb0, tb1)];
      const hasOpening = (w: Wall) => f.openings.some((o) => o.wallId === w.id);
      const plain = (w: Wall) => w.topMm == null && !hasOpening(w);
      const bInA = tb[0] >= -1 && tb[1] <= fa.L + 1 && b.thickness <= a.thickness && plain(b);
      const aInB = tb[0] <= 1 && tb[1] >= fa.L - 1 && a.thickness <= b.thickness && plain(a);
      const gone = bInA ? b : aInB ? a : null;
      out.push({ ...(gone ? { fix: { type: 'remove-duplicate-wall' as const, wallId: gone.id, label: '重なった壁を消す' } } : {}), id: `bc-${a.id}-${b.id}-wall`, kind: 'walls-overlap', severity: 'confirm', level: f.level, target: { type: 'wall', id: b.id, label: '壁' }, at: pointOnWall(a, (lo + hi) / 2), title: `${f.level}階: 壁が ${mm(ov)} にわたって二重になっています`, reason: `同じ線の上に 2 枚の壁（${a.id}・${b.id}。芯のずれ ${round(off)} mm）が重なっています。`, basis: { type: 'geometry', ref: REF.geometry }, confidence: 0.75, advice: gone ? '同じ壁を 2 回読んでいます。片方はもう片方にすっぽり入っていて建具も無いので、消しても形は変わりません。' : '同じ壁を 2 回読んでいます。建具・高さの指定が付いているので、方眼で片方を消してください。', values: { overlap: round(ov), offset: round(off) } });
    }
  }
}

/** 建築として成り立つかの検証。形は変えない（見つけて返すだけ） */
export function buildCheck(model: BuildingModel): BuildIssue[] {
  const out: BuildIssue[] = [];
  for (const f of model.floors) {
    checkOpenings(f, out);
    checkDoorSwing(f, out);
    checkStairs(model, f, out);
    checkWallOverlap(f, out);
  }
  checkFloors(model, out);
  checkElevationAgreement(model, out);
  const order: Record<BuildSeverity, number> = { critical: 0, confirm: 1, note: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || a.level - b.level || b.confidence - a.confidence);
}

export function summarizeBuildIssues(issues: BuildIssue[]): { critical: number; confirm: number; note: number; byKind: Record<string, number> } {
  const byKind: Record<string, number> = {};
  for (const i of issues) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
  return { critical: issues.filter((i) => i.severity === 'critical').length, confirm: issues.filter((i) => i.severity === 'confirm').length, note: issues.filter((i) => i.severity === 'note').length, byKind };
}

/**
 * 形を変えずに直せる問題を直す（いまは「もう 1 枚の壁にすっぽり入った、建具の無い二重の壁」を消すだけ）。
 * 直した問題の id を返す。寸法・開口・階段には触らない。
 */
export function applyBuildFixes(model: BuildingModel, issues: BuildIssue[] = buildCheck(model)): string[] {
  const done: string[] = [];
  for (const i of issues) {
    if (i.fix?.type !== 'remove-duplicate-wall') continue;
    const f = model.floors.find((x) => x.level === i.level);
    const id = i.fix.wallId;
    if (!f || !f.walls.some((w) => w.id === id) || f.openings.some((o) => o.wallId === id)) continue;
    f.walls = f.walls.filter((w) => w.id !== id);
    done.push(i.id);
  }
  return done;
}
