/**
 * 資金計画書（●【資金計画書】修正完了 20250904 の項目と計算）。
 * ① 建物本体工事（見積の税抜小計） ② 付帯工事 ③ 追加変更工事 ④ 土地費用 ⑤ その他工事費 ⑥ ローン諸経費
 * 建物工事費用（税抜）= ①＋②、消費税 10%、請負工事費（税込）、追加変更工事費（税込）= ③×1.1、
 * 建築請負工事費（税込）= ①＋②＋③、総合計 = ①＋②＋③＋④＋⑤＋⑥
 */
import type { Grade } from './catalog';
import type { BuildingModel } from '../core/types';

export interface FundRow {
  id: string;
  label: string;
  amount: number;
  /** 注記（旗竿地の場合 など） */
  note?: string;
  /** ★ = お客様・金融機関により決まる */
  star?: boolean;
}

export interface FundingInput {
  series: Grade;
  address: string;
  structure: string;
  /** ① 本体工事（税抜）。見積から自動。手で上書きもできる */
  body: number;
  bodyOverride?: number;
  attached: FundRow[]; // ②
  changes: FundRow[]; // ③
  land: FundRow[]; // ④
  other: FundRow[]; // ⑤
  loanFees: FundRow[]; // ⑥
  loans: { label: string; amountMan: number; years: number; rate: number }[];
  /** 仕様の表示（準防火・排水・給湯・太陽光・階数・長期優良・断熱） */
  site: { fireZone: boolean; sewer: string; waterHeater: string; pv: string; floors: string; longLife: string; insul: string };
  /** 標準仕様の ● */
  spec: Record<string, boolean>;
  dateLabel: string;
  version: string;
  /** 備考: 初回提案・契約時・変更後 など */
  stage?: string;
}

export interface FundingTotals {
  body: number;
  sub2: number;
  sub3: number;
  sub4: number;
  sub5: number;
  sub6: number;
  buildingExTax: number;
  tax: number;
  contract: number;
  changesTax: number;
  changesInc: number;
  buildingContract: number;
  grand: number;
  loans: { label: string; monthly: number }[];
}

/**
 * ガレージ・外構の概算（⑤その他工事費に載せる行）。単価は御社の資金計画書の実績から:
 * 酒井様 3rd プラン「GAWガレージ製作 シャッター込み H3000」約 47㎡ → 7,000,000 円（≒ 150,000 円/㎡）。
 * カーポート・デッキ・テラス・土間コンは外構の一般的な単価、ビルトインガレージは電動シャッター 1 ヵ所。
 */
export const ANNEX_UNIT = {
  garageSeparate: 150000,
  builtinShutter: 600000,
  carport: 25000,
  parking: 12000,
  deck: 35000,
  terrace: 30000,
  shed: 300000,
} as const;

export function annexRows(model: BuildingModel | null | undefined): FundRow[] {
  const f1 = model?.floors.find((f) => f.level === 1);
  if (!f1) return [];
  const rooms1 = f1.rooms;
  const sumArea = (pred: (r: (typeof rooms1)[number]) => boolean) => rooms1.filter(pred).reduce((s, r) => s + r.area, 0);
  const round = (v: number) => Math.round(v / 10000) * 10000;
  const rows: FundRow[] = [];
  const sep = sumArea((r) => r.type === 'garage' && (r.garageKind === 'attached' || r.garageKind === 'detached'));
  if (sep > 0) {
    const detached = f1.rooms.some((r) => r.type === 'garage' && r.garageKind === 'detached');
    rows.push({ id: 'annexGarage', label: `${detached ? '離れのガレージ' : 'ガレージ（後付け・GAW）'}製作 シャッター込み`, amount: round(sep * ANNEX_UNIT.garageSeparate), note: `※概算 約${sep.toFixed(1)}㎡` });
  }
  const builtin = f1.rooms.filter((r) => r.type === 'garage' && (r.garageKind ?? 'builtin') === 'builtin').length;
  if (builtin) rows.push({ id: 'annexShutter', label: 'ビルトインガレージ 電動シャッター', amount: builtin * ANNEX_UNIT.builtinShutter, note: '※概算' });
  const line = (id: string, label: string, type: 'carport' | 'parking' | 'deck' | 'terrace', unit: number) => {
    const a = sumArea((r) => r.type === type);
    if (a > 0) rows.push({ id, label, amount: round(a * unit), note: `※概算 約${a.toFixed(1)}㎡` });
  };
  line('annexCarport', 'カーポート', 'carport', ANNEX_UNIT.carport);
  line('annexParking', '駐車場 土間コンクリート', 'parking', ANNEX_UNIT.parking);
  line('annexDeck', 'ウッドデッキ', 'deck', ANNEX_UNIT.deck);
  line('annexTerrace', 'テラス（タイル）', 'terrace', ANNEX_UNIT.terrace);
  const sheds = f1.rooms.filter((r) => r.type === 'shed').length;
  if (sheds) rows.push({ id: 'annexShed', label: '物置・サイクルポート', amount: sheds * ANNEX_UNIT.shed, note: '※概算' });
  return rows;
}

export function newFunding(opts: { series: Grade; address: string; constArea: number; floors: number; body: number; fireZone: boolean; septic: boolean; waterHeater: string; pv: boolean; longLife: boolean; insul: string; annex?: FundRow[] }): FundingInput {
  const d = new Date();
  return {
    series: opts.series,
    address: opts.address,
    structure: opts.series === 'P' ? 'SE構法' : '木造金物工法',
    body: opts.body,
    attached: [
      { id: 'fire', label: '準防火地域（施工床面積×33,000円）', amount: opts.fireZone ? Math.round(opts.constArea * 33000) : 0, note: '22条地域の場合不要' },
      { id: 'septic', label: '浄化槽（延べ床130㎡以下）※五人槽', amount: 0 },
      { id: 'longlife', label: '長期優良住宅申請費', amount: 0 },
      { id: 'narrow', label: '狭小地割増費', amount: 0, note: '旗竿地の場合' },
      { id: 'three', label: '3階建施工', amount: 0 },
      { id: 'a6', label: '', amount: 0 },
    ],
    changes: [
      { id: 'reserve', label: '予備費', amount: 500000 },
      { id: 'security', label: 'セキュリティ工事のご提案', amount: 0 },
      { id: 'c3', label: '', amount: 0 },
      { id: 'c4', label: '', amount: 0 },
    ],
    land: [
      { id: 'landPrice', label: '土地代金', amount: 0 },
      { id: 'brokerage', label: '土地仲介手数料', amount: 0 },
      { id: 'propertyTax', label: '固定資産税清算金', amount: 0 },
    ],
    other: [
      { id: 'ground', label: '地盤改良工事費', amount: 1000000 },
      { id: 'exterior', label: '外構工事・土地造成費', amount: 2000000 },
      { id: 'cityFee', label: '市納金（水道引き込み工事含む）', amount: 213000 },
      { id: 'waterIn', label: '水道引き込み費用', amount: 340000 },
      { id: 'pole', label: '中継ポール', amount: 0, note: '旗竿地の場合' },
      { id: 'demolish', label: '解体費 ※予算組', amount: 0 },
      // 間取りから分かったガレージ・外構（後付けガレージ・カーポート・デッキ…）の概算
      ...(opts.annex ?? []),
      { id: 'o7', label: '', amount: 0 },
    ],
    loanFees: [
      { id: 'loanFee', label: '住宅ローン諸費用(保証料、手数料等)', amount: 0, star: true },
      { id: 'bridgeLand', label: 'つなぎローン諸費用(土地)', amount: 0, star: true },
      { id: 'bridgeFound', label: 'つなぎローン諸費用(基礎着工)', amount: 0, star: true },
      { id: 'bridgeFrame', label: 'つなぎローン諸費用(上棟)', amount: 0, star: true },
      { id: 'stampLoan', label: '金銭消費貸借契約 印紙代', amount: 20000 },
      { id: 'stampContract', label: '建物請負工事契約 印紙代', amount: 10000 },
      { id: 'stampLand', label: '土地売買契約 印紙代', amount: 0 },
      { id: 'permit', label: '確認申請印紙代＋手数料', amount: 230000 },
      { id: 'regLand', label: '土地登記費用（仮）', amount: 0 },
      { id: 'regBuilding', label: '建物登記費用（仮）', amount: 400000 },
      { id: 'fire', label: '火災保険料（5年）', amount: 250000 },
    ],
    loans: [
      { label: '変動金利：銀行ローンの場合', amountMan: 0, years: 35, rate: 1.2 },
      { label: '固定金利：フラット35の場合（1年目～5年目）', amountMan: 0, years: 35, rate: 0.8 },
      { label: '固定金利：フラット35の場合（6年目以降）', amountMan: 0, years: 35, rate: 1.2 },
    ],
    site: { fireZone: opts.fireZone, sewer: opts.septic ? '浄化槽' : '下水', waterHeater: opts.waterHeater, pv: opts.pv ? '希望する' : '希望しない', floors: `${opts.floors}階`, longLife: opts.longLife ? '希望する' : '希望しない', insul: opts.insul },
    spec: {},
    dateLabel: `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`,
    version: 'Ver.0',
    stage: '初回提案',
  };
}

export function monthlyPayment(principal: number, years: number, ratePct: number): number {
  if (principal <= 0 || years <= 0) return 0;
  const r = ratePct / 100 / 12;
  const n = years * 12;
  if (r === 0) return principal / n;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

const sum = (rows: FundRow[]) => rows.reduce((s, r) => s + (r.amount || 0), 0);

export function computeFunding(f: FundingInput): FundingTotals {
  const body = f.bodyOverride ?? f.body;
  const sub2 = sum(f.attached);
  const sub3 = sum(f.changes);
  const sub4 = sum(f.land);
  const sub5 = sum(f.other);
  const sub6 = sum(f.loanFees);
  const buildingExTax = body + sub2;
  const tax = Math.floor(buildingExTax * 0.1);
  const contract = buildingExTax + tax;
  const changesTax = Math.floor(sub3 * 0.1);
  const changesInc = sub3 + changesTax;
  const buildingContract = contract + changesInc;
  const grand = buildingContract + sub4 + sub5 + sub6;
  return { body, sub2, sub3, sub4, sub5, sub6, buildingExTax, tax, contract, changesTax, changesInc, buildingContract, grand, loans: f.loans.map((l) => ({ label: l.label, monthly: monthlyPayment(l.amountMan * 10000, l.years, l.rate) })) };
}

/** 標準仕様の表（資金計画書の下段）。col: 構造関連／性能・設備・アフター／デザイン */
export const STANDARD_SPEC: { col: 0 | 1 | 2; label: string; on: Grade[] }[] = [
  { col: 0, label: '木造金物工法', on: ['S'] },
  { col: 0, label: 'SE構法', on: ['P'] },
  { col: 0, label: '地盤調査', on: ['P', 'S'] },
  { col: 0, label: '耐震等級3', on: ['P', 'S'] },
  { col: 0, label: '許容応力度計算による構造計算', on: ['P', 'S'] },
  { col: 0, label: '制振ダンパー（evoltz）', on: [] },
  { col: 0, label: 'ベタ基礎ダブル配筋', on: ['P'] },
  { col: 0, label: 'ベタ基礎シングル配筋', on: ['S'] },
  { col: 1, label: '高性能グラスウール', on: ['S'] },
  { col: 1, label: 'セルロースファイバー', on: ['P'] },
  { col: 1, label: 'HEAT20 G2グレード級', on: ['S'] },
  { col: 1, label: 'HEAT20 G2.5グレード級', on: ['P'] },
  { col: 1, label: '平均C値0.6㎡/㎡（気密測定付き）', on: ['P', 'S'] },
  { col: 1, label: '空調：床下エアコン', on: ['P', 'S'] },
  { col: 1, label: '空調：LDK1台＋アメニティビルドインエアコン', on: [] },
  { col: 1, label: 'ダクト式第三種換気（ルフロ）', on: ['P'] },
  { col: 1, label: '壁付け第三種換気', on: ['S'] },
  { col: 1, label: '給湯器：エコキュート', on: ['P', 'S'] },
  { col: 1, label: '10年建物瑕疵保証', on: ['P', 'S'] },
  { col: 1, label: '20年地盤保証', on: ['P', 'S'] },
  { col: 1, label: '第三者検査機関による検査', on: ['P', 'S'] },
  { col: 1, label: '長期優良認定住宅対応', on: ['P', 'S'] },
  { col: 1, label: 'ZEH基準対応', on: ['P', 'S'] },
  { col: 1, label: '太陽光発電システム 4.3kwまで', on: ['P', 'S'] },
  { col: 2, label: '造作洗面台', on: ['P', 'S'] },
  { col: 2, label: '全窓網戸付き', on: ['P', 'S'] },
  { col: 2, label: '無垢パイン床材・オーク突板床材', on: ['P', 'S'] },
  { col: 2, label: '全室照明付き（上限あり）', on: ['P', 'S'] },
  { col: 2, label: '造作キッチン', on: [] },
  { col: 2, label: '神谷コーポレーションハイドア', on: ['P', 'S'] },
  { col: 2, label: '鉄骨階段', on: ['P', 'S'] },
  { col: 2, label: 'ガルバリウム鋼板（正面一面アポロルーフ横貼り）or 塗り壁（ジョリパット or Sto）', on: ['P', 'S'] },
];
