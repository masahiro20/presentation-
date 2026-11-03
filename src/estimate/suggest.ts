/**
 * この間取りで検討するオプションの提案: 読み取った間取り（ガレージ・吹抜・和室・2 階の水まわり・バルコニー…）から、
 * 価格表の任意の行（optional）や「任意のもの」のスイッチのうち関係しそうなものを理由つきで挙げる。
 * 入れる／入れないは設計士が決める（ここでは金額に入れない）。単価が目安の行はその旨を desc に書いてある。
 */
import type { BuildingModel } from '../core/types';
import { isSeparateGarage } from '../core/types';
import type { Areas } from './areas';
import type { EstimateChoice } from './calc';

export interface OptionSuggestion {
  /** 価格表の行 id（数量を入れる）か、Areas のスイッチ（flag） */
  lineId?: string;
  flag?: keyof Areas;
  qty?: number;
  label: string;
  reason: string;
  /** すでに入っている（数量 > 0 かスイッチ ON） */
  applied: boolean;
}

export function suggestOptions(model: BuildingModel, a: Areas, choice: EstimateChoice): OptionSuggestion[] {
  const out: OptionSuggestion[] = [];
  const qtyOf = (id: string) => choice.qty[id] ?? 0;
  const flagOn = (k: keyof Areas) => a[k] === true;
  const line = (lineId: string, qty: number, label: string, reason: string) => out.push({ lineId, qty, label, reason, applied: qtyOf(lineId) > 0 });
  const flag = (k: keyof Areas, label: string, reason: string) => out.push({ flag: k, label, reason, applied: flagOn(k) });

  const floors = model.floors;
  const garages = floors.flatMap((f) => f.rooms.filter((r) => r.type === 'garage' && !isSeparateGarage(r)));
  const shutters = floors.flatMap((f) => f.openings.filter((o) => o.kind === 'shutter'));
  if (garages.length) {
    const wide = shutters.filter((o) => o.t1 - o.t0 >= 4200).length;
    const single = shutters.length - wide;
    if (wide) line('sash.shutterElec2', wide, `電動シャッター（2 台一体） ${wide} 台`, 'ビルトインガレージの 2 台一体の口（幅 4.2m 以上）');
    if (single) line('sash.shutterElec1', single, `電動シャッター（1 台） ${single} 台`, 'ビルトインガレージの口');
    if (!shutters.length) line('sash.shutterElec1', 1, '電動シャッター 1 台', 'ビルトインガレージがあるのにシャッターが読めていません（方眼で置くと数が合います）');
    flag('evOutlet', 'EV コンセント', 'ガレージに充電用の 200V コンセント');
  }
  const voids = a.voidArea;
  if (voids > 0) out.push({ label: `吹抜 ${voids.toFixed(1)}㎡`, reason: '吹抜の足場（内部足場）は施工面積から自動で計上済み。手摺（St 手摺）を検討', applied: true });
  if (voids > 0) line('ib.handrail', Math.max(2, Math.round(Math.sqrt(voids) * 2)), `St 手摺 ${Math.max(2, Math.round(Math.sqrt(voids) * 2))} m`, '吹抜・階段まわりの鉄骨手摺');
  const high = floors.flatMap((f) => f.rooms.filter((r) => r.ceilingHeight && r.ceilingHeight > f.ceilingHeight));
  if (high.length) {
    const m3 = high.reduce((s, r) => s + (r.area * ((r.ceilingHeight ?? 0) - 2500)) / 1000, 0);
    if (m3 > 0) line('ib.highCeil', Math.round(m3 * 10) / 10, `高天井 ${high.map((r) => r.name).join('・')}`, `天井高 ${high.map((r) => r.ceilingHeight).join('・')} の部屋（H2500 からの差 ${m3.toFixed(1)}㎥）`);
  }
  if (a.tatami1 > 0) out.push({ label: `畳 ${a.tatami1} 枚`, reason: '和室の畳は自動で計上済み', applied: true });
  if (a.wet2f !== 'none') flag('handwash', 'トイレ手洗いカウンター', `2 階に水まわり（${a.wet2f === 'ldk' ? '2 階リビング' : 'トイレ・洗面'}）。2 階トイレの手洗いを検討`);
  if (a.balconyArea > 0) flag('balconyTile', 'バルコニータイル', `バルコニー ${a.balconyArea.toFixed(1)}㎡（防水は自動計上。タイル仕上げは任意）`);
  if (a.toilets >= 2) out.push({ label: `トイレ ${a.toilets} か所`, reason: '便器・給排水は自動で計上済み', applied: true });
  if (floors.some((f) => f.rooms.some((r) => /ランドリー|洗濯|脱衣/.test(r.name)))) flag('slopSink', 'スロップシンク', 'ランドリー・脱衣室がある（つけ置き洗い）');
  if (floors.some((f) => f.rooms.some((r) => /ランドリー|洗濯|脱衣|ファミクロ|ファミリークローゼット/.test(r.name)))) flag('kanta', '幹太くん引き込み', 'ランドリーがある（ガス衣類乾燥機の引き込みだけ先行）');
  if (floors.some((f) => f.openings.filter((o) => o.kind === 'entrance').length)) flag('pocketKey', '玄関ポケットキー', '玄関ドアあり（電気錠は電源直結）');
  if (a.totalArea >= 130) out.push({ label: '浄化槽 7 人槽', reason: `延床 ${a.totalArea.toFixed(0)}㎡（130㎡ 以上は 7 人槽）。下水道が無い敷地なら必要`, applied: flagOn('septic') });
  else flag('septic', '浄化槽 5 人槽', '下水道が無い敷地なら必要');
  if (floors.length >= 3) out.push({ label: '3 階建て: 構造計算（許容応力度）', reason: '3 階建ては構造計算が必須', applied: flagOn('structCalc') });
  if (floors.length >= 3 && !flagOn('structCalc')) flag('structCalc', '許容応力度計算', '3 階建て');
  return out;
}
