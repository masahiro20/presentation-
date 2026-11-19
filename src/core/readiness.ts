/**
 * 提案に使えるか（読み取りの点数とは別に、4 つを分けて判断する）
 *
 *  1. 認識の確からしさ … 読み取りの点数（帖数・面積表・上下階・戸と窓・壁・部屋名）
 *  2. 建築の整合性   … 建築の検証（buildCheck）の重大・要確認
 *  3. 未確定の情報   … 平面図に書かれていないので推定した値（高さ・屋根・窓の高さ・縮尺・方位・階段の段数）
 *  4. 確認の状況     … 担当者が「確認した」を押した項目
 *
 * 読み取り 95 点でも、階段の踏面 81mm のような重大警告があれば「そのまま提案に使えます」とは出さない。
 * ただし社内の道具なので、編集・出力は止めない（何が未確認かを見せて、担当者が用途に応じて判断する）。
 */
import type { BuildingModel } from './types';
import { buildCheck, type BuildIssue } from './buildCheck';
import { readingScore } from '../parser/readingScore';

export type Impact = 'high' | 'mid' | 'low';

export interface UnknownItem {
  /** 確認済みの記録に使うキー（model.confirmed のキー） */
  key: string;
  label: string;
  /** 今の値（短く） */
  value: string;
  /** 何から決めたか */
  basis: string;
  /** 確からしさ 0〜1 */
  confidence: number;
  /** 外観・見積への影響 */
  impact: Impact;
  /** 何に効くか（短く） */
  affects: string;
  /** どうすれば図面どおりになるか */
  howToFix: string;
}

export type Verdict = 'ready' | 'check' | 'fix';

export interface Readiness {
  recognition: { score: number; grade: 'good' | 'fair' | 'poor' };
  integrity: { critical: BuildIssue[]; confirm: BuildIssue[] };
  unknowns: UnknownItem[];
  /** 確認が済んでいない未確定の情報（影響の大きい順） */
  pending: UnknownItem[];
  confirmed: UnknownItem[];
  verdict: Verdict;
  verdictLabel: string;
}

const mm = (v: number) => `${Math.round(v).toLocaleString('ja-JP')}`;

/**
 * 御社の実例（ARCHITREND の立面図から高さが読めた案件）の高さ。平面図だけのときの推定の根拠に使う。
 * 過去の案件の寸法を新しい案件に黙って当てない: 画面で値と件数を見せて、担当者がボタンで選んだときだけ当てる。
 * 出どころ: 2026-11-19 に手元の図面 29 件を読み、立面図から高さが読めた 2 階建て 5 件（吉田様・金田様・田添様・岡﨑様・2026-11-08 の意匠図）。
 *   1 階床 GL+618〜663（中央値 618）、1 階 階高 2,950〜3,200（中央値 3,100）、2 階 2,700〜2,850（中央値 2,800）、
 *   1 階天井 2,450〜2,700（中央値 2,600）、2 階天井 2,400。屋根は 5 件中 4 件が片流れ 0.5 寸（1 件は 4 寸）。
 */
export const HL_HEIGHT_REFERENCE = { floor1: 618, story: [3100, 2800, 2800], ceiling1: 2600, cases: 5, roof: '5 件中 4 件が片流れ 0.5 寸' } as const;

/** 階高・床の高さ・1 階の天井を御社の実例の中央値に合わせる（立面図・3DS が無いときの推定を良くする。担当者がボタンで選ぶ） */
export function applyHlHeightReference(model: BuildingModel): void {
  const fl = model.floors.slice().sort((a, b) => a.level - b.level);
  if (!fl.length) return;
  fl[0].elevation = HL_HEIGHT_REFERENCE.floor1;
  fl.forEach((f, i) => {
    f.height = HL_HEIGHT_REFERENCE.story[Math.min(i, HL_HEIGHT_REFERENCE.story.length - 1)];
    if (i > 0) f.elevation = fl[i - 1].elevation + fl[i - 1].height;
  });
  fl[0].ceilingHeight = Math.max(fl[0].ceilingHeight, HL_HEIGHT_REFERENCE.ceiling1);
  model.report.heightBasis = 'hl-reference';
}

export function unknownsOf(model: BuildingModel): UnknownItem[] {
  const out: UnknownItem[] = [];
  const floors = model.floors.slice().sort((a, b) => a.level - b.level);
  const rep = model.report;
  if (rep.scaleSource === 'default' || rep.scaleDenominator == null)
    out.push({ key: 'scale', label: '縮尺', value: rep.scaleDenominator ? `1/${rep.scaleDenominator}` : '不明', basis: '図面から読めなかったので 1/100 として読みました', confidence: 0.4, impact: 'high', affects: '寸法・面積・見積のすべて', howToFix: '寸法線の入った図面を読み込むか、読み込みのやり直しで縮尺を指定する' });
  if (!model.heights && floors.length) {
    const hl = rep.heightBasis === 'hl-reference';
    out.push({
      key: 'heights',
      label: '階高・1 階の床の高さ',
      value: `1 階床 GL+${mm(floors[0].elevation)}・階高 ${floors.map((f) => mm(f.height)).join(' / ')}`,
      basis: hl
        ? `平面図に高さが無いので、御社の実例 ${HL_HEIGHT_REFERENCE.cases} 件の中央値に合わせた`
        : `平面図に高さが無いので一般的な標準値で推定（御社の実例 ${HL_HEIGHT_REFERENCE.cases} 件の中央値は 1 階床 GL+${HL_HEIGHT_REFERENCE.floor1}・階高 ${HL_HEIGHT_REFERENCE.story[0]} / ${HL_HEIGHT_REFERENCE.story[1]}）`,
      confidence: hl ? 0.75 : 0.55,
      impact: 'high',
      affects: '外観の高さ・窓の位置・階段の段数・外壁面積',
      howToFix: '立面図（同じ PDF でも別ファイルでも）か 3DS を足す、または方眼の「高さ」で入力して「確認した」を押す',
    });
  }
  const roofFromDrawing = (model.roofPatches ?? []).some((p) => p.source === 'elevation' || !p.source); // 立面図から読んだ塊か、3D の「屋根」の道具で直した塊
  if (!roofFromDrawing && floors.length)
    out.push({ key: 'roof', label: '屋根の形・勾配・軒の出', value: '外観テイストの既定（最上階）＋上の階に接する側が高い下屋', basis: `平面図に屋根が無いので推定（御社の実例は ${HL_HEIGHT_REFERENCE.roof}。どちら側が高いかは図面から決まらない）`, confidence: 0.45, impact: 'high', affects: '外観の第一印象・屋根と外壁の面積（見積）', howToFix: '立面図を足す、または 3D の「屋根」の道具で直して「確認した」を押す' });
  const windows = floors.flatMap((f) => f.openings.filter((o) => o.kind === 'window'));
  if (windows.length) {
    const read = windows.filter((o) => o.heightFrom === 'elevation' || o.heightFrom === '3d').length;
    if (read < windows.length * 0.5)
      out.push({ key: 'windowHeights', label: '窓の腰高・高さ', value: `${windows.length - read} / ${windows.length} か所が推定`, basis: '部屋の種類と窓の幅から推定（腰窓 900 など）', confidence: 0.55, impact: 'mid', affects: '外観・内観の窓の見え方', howToFix: '立面図を足す、または 3D の「窓・戸」の道具で直す' });
  }
  if (rep.northDetected === false)
    out.push({ key: 'north', label: '方位', value: '図面の上を北', basis: '方位記号が見つからなかった', confidence: 0.3, impact: 'mid', affects: '日照・影・外観の光の向き', howToFix: '日照のステップで方位を合わせる' });
  const upStairs = floors.flatMap((f) => f.stairs.filter((s) => s.goesUp));
  const noSteps = upStairs.filter((s) => !s.steps && !s.treadPitch);
  if (noSteps.length)
    out.push({ key: 'stairSteps', label: '階段の段数', value: `${noSteps.length} か所が階高からの推定`, basis: '図面に段数の注記・段の線の間隔が無い', confidence: 0.6, impact: 'low', affects: '階段の 3D の形', howToFix: '3D で階段をクリックして段数を指定する' });
  return out;
}

const RANK: Record<Impact, number> = { high: 0, mid: 1, low: 2 };

export function assessReadiness(model: BuildingModel, issues?: BuildIssue[]): Readiness {
  const rs = readingScore(model);
  const bc = issues ?? buildCheck(model);
  const critical = bc.filter((i) => i.severity === 'critical');
  const confirm = bc.filter((i) => i.severity === 'confirm');
  const unknowns = unknownsOf(model).sort((a, b) => RANK[a.impact] - RANK[b.impact]);
  const done = model.confirmed ?? {};
  const pending = unknowns.filter((u) => !done[u.key]);
  const confirmed = unknowns.filter((u) => done[u.key]);
  const highPending = pending.filter((u) => u.impact === 'high');
  let verdict: Verdict;
  let verdictLabel: string;
  if (rs.grade === 'poor') {
    verdict = 'fix';
    verdictLabel = '読み取りが不十分です。読み込みのやり直しか、方眼での修正が必要です';
  } else if (critical.length) {
    verdict = 'fix';
    verdictLabel = `重大な警告が ${critical.length} 件あります。直すか、内容を確認してから提案へ（点数は読み取りの出来で、建築として成り立つかは別です）`;
  } else if (rs.grade === 'fair') {
    verdict = 'check';
    verdictLabel = '「まず直す」を直してから提案へ';
  } else if (highPending.length || confirm.length) {
    verdict = 'check';
    const parts: string[] = [];
    if (highPending.length) parts.push(`外観に効く推定 ${highPending.length} 件（${highPending.map((u) => u.label).join('・')}）`);
    if (confirm.length) parts.push(`建築の要確認 ${confirm.length} 件`);
    verdictLabel = `読み取りは良好です。${parts.join('と')}を確認してから提案へ`;
  } else {
    verdict = 'ready';
    verdictLabel = pending.length ? '提案に使えます（小さな推定は残っています）' : '提案に使えます';
  }
  return { recognition: { score: rs.score, grade: rs.grade }, integrity: { critical, confirm }, unknowns, pending, confirmed, verdict, verdictLabel };
}

/** 資料・体験リンクを出す前に見せる「未確認の重要項目」（重大警告・影響の大きい未確認の推定） */
export function exportChecklist(model: BuildingModel): { title: string; detail: string }[] {
  const r = assessReadiness(model);
  const out: { title: string; detail: string }[] = [];
  for (const i of r.integrity.critical) out.push({ title: `【重大】${i.title}`, detail: i.advice });
  for (const u of r.pending.filter((x) => x.impact !== 'low')) out.push({ title: `【未確認の推定】${u.label}: ${u.value}`, detail: `${u.basis}。${u.affects}に効きます` });
  return out;
}
