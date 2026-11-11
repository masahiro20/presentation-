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
  /** 価格表に行が無く、自動でも計上していない（「追加・増減」で別途入れる） */
  separate?: boolean;
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
  // 高天井（H2500 からの差）は拾い（Areas.highCeil）で自動計上
  const high = floors.flatMap((f) => f.rooms.filter((r) => (r.ceilingHeight ?? f.ceilingHeight) > 2500 && r.type !== 'void'));
  if (a.highCeil > 0) out.push({ label: `高天井 ${a.highCeil.toFixed(1)}㎥`, reason: `天井高 2,500 を超える部屋（${[...new Set(high.map((r) => r.name))].slice(0, 4).join('・')}）の高天井変更費は自動で計上済み（H2500 からの差）`, applied: true });
  if (a.elevator) out.push({ label: '家庭用エレベーター', reason: '図面に EV の区画があるので設備工事に概算で計上済み（メーカー見積で確定）', applied: true });
  if (a.tatami1 > 0) out.push({ label: `畳 ${a.tatami1} 枚`, reason: '和室の畳は自動で計上済み', applied: true });
  if (a.wet2f !== 'none') flag('handwash', 'トイレ手洗いカウンター', `2 階に水まわり（${a.wet2f === 'ldk' ? '2 階リビング' : 'トイレ・洗面'}）。2 階トイレの手洗いを検討`);
  if (a.balconyArea > 0) flag('balconyTile', 'バルコニータイル', `バルコニー ${a.balconyArea.toFixed(1)}㎡（防水は自動計上。タイル仕上げは任意）`);
  if (a.toilets >= 2) out.push({ label: `トイレ ${a.toilets} か所`, reason: '便器・給排水は自動で計上済み', applied: true });
  if (floors.some((f) => f.rooms.some((r) => /ランドリー|洗濯|脱衣/.test(r.name)))) flag('slopSink', 'スロップシンク', 'ランドリー・脱衣室がある（つけ置き洗い）');
  if (floors.some((f) => f.rooms.some((r) => /ランドリー|洗濯|脱衣|ファミクロ|ファミリークローゼット/.test(r.name)))) flag('kanta', '幹太くん引き込み', 'ランドリーがある（ガス衣類乾燥機の引き込みだけ先行）');
  if (floors.some((f) => f.openings.filter((o) => o.kind === 'entrance').length)) flag('pocketKey', '玄関ポケットキー', '玄関ドアあり（電気錠は電源直結）');
  if (a.totalArea >= 130) out.push({ label: '浄化槽 7 人槽', reason: `延床 ${a.totalArea.toFixed(0)}㎡（130㎡ 以上は 7 人槽）。下水道が無い敷地なら必要`, applied: flagOn('septic') });
  else flag('septic', '浄化槽 5 人槽', '下水道が無い敷地なら必要');
  // 室内窓（部屋と部屋の間の FIX のガラス）: 建具の数にもサッシの概算にも入らないので、別途の計上を促す
  const interiorWins = floors.flatMap((f) => f.openings.filter((o) => o.kind === 'window' && o.interior));
  if (interiorWins.length) {
    const widths = interiorWins.map((o) => `W${Math.round(o.t1 - o.t0).toLocaleString()}`);
    out.push({ label: `室内窓 ${interiorWins.length} か所`, reason: `部屋と部屋の間のガラス（FIX。${widths.slice(0, 4).join('・')}${widths.length > 4 ? ' ほか' : ''}）。室内建具の数・サッシの概算には入っていません。「追加・増減」で別途計上してください`, applied: false, separate: true });
  }
  if (floors.length >= 3) out.push({ label: '3 階建て: 構造計算（許容応力度）', reason: '3 階建ては構造計算が必須', applied: flagOn('structCalc') });
  if (floors.length >= 3 && !flagOn('structCalc')) flag('structCalc', '許容応力度計算', '3 階建て');
  return out;
}
