/**
 * 見積・資金計画: 読み込んだ間取りから数量を拾い、社内の積算（価格表）で見積を出し、資金計画書まで一気に作る。
 * 画面の左（ステージ）に御見積書・内訳書・資金計画書の清書、右（パネル）に数量・仕様の選択・資金計画の入力。
 */
import { h, clear, section, fold, field, segmented, toast, download } from '../dom';
import { state, emit } from '../state';
import type { Step, StepCtx } from '../app';
import { exteriorById } from '../../styles/presets';
import { takeoff, applyOverrides, AREA_FIELDS, AREA_OPTIONS, type Areas } from '../../estimate/areas';
import { CATEGORIES, type Grade } from '../../estimate/catalog';
import { computeEstimate, newChoice, defaultGroups, unitPriceOf, yen, type EstimateChoice, type EstimateResult } from '../../estimate/calc';
import { computeFunding, newFunding, STANDARD_SPEC, type FundingInput, type FundRow } from '../../estimate/funding';
import { estimateGroupsFor } from '../../coordinate/catalog';

export interface EstimateState {
  choice: EstimateChoice;
  areasOverride: Partial<Areas>;
  funding: FundingInput | null;
  /** 内訳書に 0 円の行も出す（編集用） */
  showAll?: boolean;
}

const GROUP_LABEL: Record<string, string> = {
  found: '基礎',
  precut: '構造材（プレカット）',
  carp: '大工手間',
  insulLabor: '断熱材 手間',
  roofing: '屋根下地（ルーフィング）',
  gutter: '軒樋',
  down1: '竪樋 1階',
  down2: '竪樋 2階',
  flash: '土台水切り',
  sash: 'サッシ',
  entDoor: '玄関ドア',
  extwall: '外壁',
  soffit: '軒天',
  floorIns: '床・基礎断熱',
  roofIns: '屋根断熱',
  wallIns: '壁断熱',
  floor: '床材',
  door: '建具',
  stair: '階段',
  vanity: '造作洗面',
  cloth: 'クロス',
  bath: 'ユニットバス',
  kitchen: 'キッチン',
  vent: '換気',
  ac: '空調',
  water: '給湯器',
  pv: '太陽光',
};

function ensure(): EstimateState {
  if (!state.estimate) state.estimate = { choice: newChoice('P'), areasOverride: {}, funding: null };
  return state.estimate;
}

/** コーディネートで選んだ商品を見積の行（group の選択）に反映する */
export function syncEstimateWithFinishes() {
  const es = ensure();
  Object.assign(es.choice.groups, estimateGroupsFor(state.design));
  emit('estimate');
}

/** コーディネート側で決まっている group（見積の画面ではそちらで変える） */
function finishDrivenGroups(): Set<string> {
  return new Set(Object.keys(estimateGroupsFor(state.design)));
}

function baseAreas(grade: Grade): Areas {
  const model = state.model!;
  const ext = exteriorById(state.design.exteriorId);
  return takeoff(model, {
    grade,
    eavesMm: state.design.eaves ?? ext.roof.eaves,
    pitch: state.design.roofPitch ?? ext.roof.pitch,
    roofType: state.design.roofOverride ?? ext.roof.type,
    solido: ext.accent ? ext.accentRule : 'none',
  });
}

interface Computed {
  base: Areas;
  areas: Areas;
  est: EstimateResult;
  funding: FundingInput;
}

function compute(es: EstimateState): Computed {
  Object.assign(es.choice.groups, estimateGroupsFor(state.design));
  const base = baseAreas(es.choice.grade);
  const areas = applyOverrides(base, es.areasOverride);
  const est = computeEstimate(areas, es.choice);
  if (!es.funding) {
    es.funding = newFunding({
      series: es.choice.grade,
      address: state.site.address,
      constArea: areas.constArea,
      floors: state.model!.floors.length,
      body: est.subtotal,
      fireZone: areas.fireZone,
      septic: areas.septic,
      waterHeater: /ecocute/.test(es.choice.groups.water ?? 'ecocute') ? 'エコキュート' : 'ガス給湯',
      pv: !/pvNone/.test(es.choice.groups.pv ?? ''),
      longLife: true,
      insul: es.choice.grade === 'P' ? 'セルロースファイバー' : '高性能グラスウール',
    });
  }
  es.funding.body = est.subtotal;
  es.funding.series = es.choice.grade;
  return { base, areas, est, funding: es.funding };
}

const fmt = (v: number) => (v === 0 ? '' : yen(v));
const num = (v: number, d = 2) => (Number.isInteger(v) ? String(v) : v.toFixed(d).replace(/\.?0+$/, ''));

/** 御見積書（表紙＋工事別の金額） */
function quoteSheet(c: Computed): HTMLElement {
  const { est, areas } = c;
  const date = new Date();
  const company = state.company || '株式会社ホームランディック';
  const rows = est.categories.map((cat) => h('tr', null, h('td', { class: 'no' }, `${cat.def.no}.`), h('td', null, `${cat.def.name}`), h('td', { class: 'amt' }, fmt(cat.amount))));
  return h(
    'div',
    { class: 'est-sheet quote' },
    h('div', { class: 'est-title' }, '御　見　積　書'),
    h(
      'div',
      { class: 'est-head' },
      h('div', { class: 'est-to' }, h('div', { class: 'name' }, `${state.customer || '〇〇様'} 邸　新築工事`), h('div', { class: 'sub' }, '下記の通り御見積り申し上げます。')),
      h('div', { class: 'est-from' }, h('div', null, `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`), h('div', { class: 'co' }, company), h('div', null, state.designer ? `担当　${state.designer}` : '')),
    ),
    h(
      'table',
      { class: 'est-summary-head' },
      h('tr', null, h('th', null, '工事名'), h('td', null, `${state.customer || '〇〇様'} 邸　新築工事（${est.categories.length ? areas.grade : ''}シリーズ）`)),
      h('tr', null, h('th', null, '施工場所'), h('td', null, state.site.address || '')),
      h('tr', null, h('th', null, '金額（税込）'), h('td', { class: 'big' }, `¥${yen(est.total)}`)),
      h('tr', null, h('th', null, '施工面積'), h('td', null, `${num(areas.constTsubo)} 坪（延床 ${num(areas.totalTsubo)} 坪）　坪単価 ¥${yen(Math.round(est.perTsubo))}`)),
    ),
    h(
      'table',
      { class: 'est-table summary' },
      h('thead', null, h('tr', null, h('th', { class: 'no' }, ''), h('th', null, '工事名'), h('th', { class: 'amt' }, '金額（円）'))),
      h('tbody', null, ...rows),
      h('tfoot', null, h('tr', { class: 'sum' }, h('td', null, ''), h('td', null, '小計'), h('td', { class: 'amt' }, yen(est.subtotal))), h('tr', null, h('td', null, ''), h('td', null, '消費税（10%）'), h('td', { class: 'amt' }, yen(est.tax))), h('tr', { class: 'total' }, h('td', null, ''), h('td', null, '合計（税込）'), h('td', { class: 'amt' }, yen(est.total)))),
    ),
    h('div', { class: 'est-note' }, '※ 本見積は概算です。仕様の決定・地盤調査・敷地条件により金額が変わります。有効期限は提出日より 1 ヵ月です。'),
  );
}

/** 内訳書（工事ごとの行） */
function detailSheets(c: Computed, es: EstimateState, rerender: () => void): HTMLElement[] {
  const { est } = c;
  const sheets: HTMLElement[] = [];
  let cur: HTMLElement | null = null;
  let rowsOnPage = 0;
  const newPage = () => {
    cur = h('div', { class: 'est-sheet detail' }, h('div', { class: 'est-title small' }, '内　訳　書'));
    sheets.push(cur);
    rowsOnPage = 0;
  };
  newPage();
  for (const cat of est.categories) {
    const lines = cat.lines.filter((l) => es.showAll || l.amount !== 0 || (l.selected && l.qty > 0));
    if (!lines.length && !es.showAll) continue;
    if (rowsOnPage + lines.length + 3 > 38) newPage();
    const tbody = h('tbody', null);
    for (const l of lines) {
      const qtyCell = es.showAll
        ? h('input', {
            type: 'number',
            class: 'qty-in',
            step: 'any',
            value: num(l.qty, 3),
            onchange: (e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (l.extra) {
                const x = es.choice.extras.find((x) => x.id === l.id);
                if (x) x.qty = v;
              } else if (Math.abs(v - l.qtyAuto) < 1e-9 && l.selected) delete es.choice.qty[l.id];
              else es.choice.qty[l.id] = v;
              if (v > 0 && !l.selected && l.def && !l.def.group) es.choice.off = es.choice.off.filter((id) => id !== l.id);
              rerender();
            },
          })
        : num(l.qty, 2);
      const sel = es.showAll && l.def && !l.def.group
        ? h('input', {
            type: 'checkbox',
            checked: l.selected,
            onchange: (e: Event) => {
              const on = (e.target as HTMLInputElement).checked;
              es.choice.off = on ? es.choice.off.filter((id) => id !== l.id) : [...es.choice.off, l.id];
              if (on && !(es.choice.qty[l.id] > 0) && l.qtyAuto === 0) es.choice.qty[l.id] = 1;
              rerender();
            },
          })
        : null;
      tbody.appendChild(
        h(
          'tr',
          { class: l.selected && l.qty > 0 ? '' : 'off' },
          h('td', { class: 'sel' }, sel),
          h('td', { class: 'spec' }, l.spec),
          h('td', { class: 'desc' }, l.desc, l.qtyNote && es.showAll ? h('span', { class: 'qn' }, `（${l.qtyNote}）`) : null),
          h('td', { class: 'qty' }, qtyCell),
          h('td', { class: 'unit' }, l.unit),
          h('td', { class: 'amt' }, yen(l.unitPrice)),
          h('td', { class: 'amt' }, fmt(l.amount)),
        ),
      );
    }
    if (es.showAll) {
      tbody.appendChild(
        h(
          'tr',
          { class: 'add' },
          h('td', { colspan: 7 }, h('button', { class: 'linkbtn', onclick: () => {
            const desc = prompt('追加する項目の内容（例: 造作テレビボード W2400）');
            if (!desc) return;
            const price = Number(prompt('売価（円・税抜）', '100000') ?? 0);
            es.choice.extras.push({ id: `x${Date.now().toString(36)}`, cat: cat.def.id, desc, unit: '式', price: price || 0, cost: Math.round((price || 0) * 0.7), qty: 1 });
            rerender();
          } }, '＋ この工事に行を追加')),
        ),
      );
    }
    cur!.appendChild(
      h(
        'table',
        { class: 'est-table detail' },
        h('thead', null, h('tr', { class: 'cat' }, h('th', { colspan: 6 }, `${cat.def.no}. ${cat.def.name}`), h('th', { class: 'amt' }, yen(cat.amount))), h('tr', null, h('th', { class: 'sel' }, ''), h('th', null, '仕様'), h('th', null, '内容'), h('th', { class: 'qty' }, '数量'), h('th', null, '単位'), h('th', { class: 'amt' }, '単価'), h('th', { class: 'amt' }, '金額'))),
        tbody,
        h('tfoot', null, h('tr', null, h('td', { colspan: 6 }, '小計'), h('td', { class: 'amt' }, yen(cat.amount)))),
      ),
    );
    rowsOnPage += lines.length + 3;
  }
  return sheets;
}

/** 資金計画書 */
function fundingSheet(c: Computed): HTMLElement {
  const f = c.funding;
  const t = computeFunding(f);
  const row = (r: FundRow) => h('tr', null, h('td', { class: 'lbl' }, r.label, r.note ? h('span', { class: 'note' }, r.note) : null), h('td', { class: 'amt' }, r.star && !r.amount ? '★' : fmt(r.amount)), h('td', { class: 'yen' }, '円'));
  const block = (title: string, rows: HTMLElement[], foot: HTMLElement[] = []) => h('table', { class: 'fp-block' }, h('thead', null, h('tr', null, h('th', { colspan: 3 }, title))), h('tbody', null, ...rows), foot.length ? h('tfoot', null, ...foot) : null);
  const tot = (label: string, v: number, cls = '') => h('tr', { class: `tot ${cls}` }, h('td', { class: 'lbl' }, label), h('td', { class: 'amt' }, yen(v)), h('td', { class: 'yen' }, '円'));
  const specCols = [0, 1, 2].map((col) => h('ul', { class: 'spec-col' }, ...STANDARD_SPEC.filter((s) => s.col === col).map((s) => h('li', { class: s.on.includes(f.series) ? 'on' : '' }, h('span', { class: 'dot' }, s.on.includes(f.series) ? '●' : ''), s.label))));
  return h(
    'div',
    { class: 'est-sheet funding' },
    h('div', { class: 'fp-head' }, h('div', { class: 'fp-title' }, `${state.customer || '〇〇様'} 邸　資金計画書`), h('div', { class: 'fp-series' }, `${f.series}シリーズ`), h('div', { class: 'fp-site' }, h('span', null, '建築場所'), f.address || '')),
    h(
      'div',
      { class: 'fp-grid' },
      h(
        'div',
        { class: 'fp-col' },
        block('①建物本体工事', [h('tr', null, h('td', { class: 'lbl' }, `仕様 ${f.series}シリーズ　施工面積 ${num(c.areas.constTsubo)} 坪 × 坪単価 ${yen(Math.round(t.body / Math.max(0.01, c.areas.constTsubo)))} 円`), h('td', { class: 'amt' }, yen(t.body)), h('td', { class: 'yen' }, '円'))]),
        block('②付帯工事費用', f.attached.filter((r) => r.label).map(row), [tot('小計②', t.sub2), tot('建物工事費用（税抜）①＋②', t.buildingExTax), tot('消費税', t.tax), tot('請負工事費（税込）', t.contract, 'strong')]),
        block('③追加変更工事 項目', f.changes.filter((r) => r.label).map(row), [tot('小計③', t.sub3), tot('消費税', t.changesTax), tot('追加変更工事費（税込）', t.changesInc), tot('建築請負工事費（税込）①＋②＋③', t.buildingContract, 'strong')]),
      ),
      h(
        'div',
        { class: 'fp-col' },
        block('④土地費用', f.land.map(row), [tot('小計④', t.sub4)]),
        block('⑤その他工事費', f.other.filter((r) => r.label).map(row), [tot('小計⑤', t.sub5)]),
        block('⑥ローン諸経費', f.loanFees.map(row), [tot('小計⑥', t.sub6)]),
        h('table', { class: 'fp-block grand' }, h('tbody', null, tot('総合計（税込）①＋②＋③＋④＋⑤＋⑥', t.grand, 'grand'))),
      ),
      h(
        'div',
        { class: 'fp-col notes' },
        h('div', { class: 'fp-flags' }, h('span', null, `準防火地域：${f.site.fireZone ? '該当' : '非該当'}`), h('span', null, `建物構造：${f.structure}`), h('span', null, `排水：${f.site.sewer}`), h('span', null, `階数：${f.site.floors}`), h('span', null, `給湯：${f.site.waterHeater}`), h('span', null, `長期優良：${f.site.longLife}`), h('span', null, `太陽光：${f.site.pv}`), h('span', null, `断熱材：${f.site.insul}`)),
        h('div', { class: 'fp-notes-title' }, '資金計画書の見方'),
        h(
          'ul',
          { class: 'fp-notes' },
          h('li', null, 'これは計画書になります。建築にかかる金額費用の目安としてお使いください。'),
          h('li', null, 'ウッドデッキ外構工事等は本体工事に含まれていません。⑤の項目に入ります。'),
          h('li', null, '地盤改良工事費は間取りが確定後、地盤調査をした後に金額が確定となります。かからない場合もあれば 100 万以上かかる場合もあります。'),
          h('li', null, '工事が進んでから深基礎・残土処理・盛土費等が別途かかる可能性があります。金額は事後報告になる場合もありますので何卒ご理解いただけたら幸いです。'),
          h('li', null, '①の建物本体価格以外の金額は全て概算となります。予算取りに関しては仕様決定後、見積もり・清算させていただきます。'),
          h('li', null, '追加変更工事とその他の諸経費はお客様のご要望や土地の条件等によって差が生じやすい項目です。予算どりが足りないと感じた場合担当者にご相談下さい。'),
          h('li', null, '市納金（上下水道宅内引き込み費用）は各市町村の指定業者によって異なります。上記費用は弊社手配の場合最終金にてご精算となります。'),
          h('li', null, '本見積金額は提出時より 1 カ月の有効期限となります。商品・諸費用については仕様の変更や市場の状況により価格の改定が予告なく行われることがございます。'),
        ),
        h('div', { class: 'fp-notes-title' }, '⑤その他工事費のご説明'),
        h('ul', { class: 'fp-notes' }, h('li', null, '現場管理費 … 仮囲い・仮設光熱費・仮設トイレ等'), h('li', null, '設計監理料 … 耐震・採光計算・確認申請費・設計図書作成・検査立会・製本代等')),
        h('div', { class: 'fp-notes-title' }, '⑥ローン諸経費のご説明'),
        h('ul', { class: 'fp-notes' }, h('li', null, '★住宅ローンの金利・融資条件・お借入れ可能額はお借り入れ先や審査によって変動します。あくまで目安としてご利用下さい。'), h('li', null, '★固定資産税・登記費用などは概算額です。購入される土地によって異なります。'), h('li', null, '★火災保険料は概算となります。保険会社・申込時期・融資申込金融機関により異なります。')),
      ),
    ),
    h(
      'div',
      { class: 'fp-bottom' },
      h('div', { class: 'fp-spec' }, h('div', { class: 'fp-notes-title' }, '標準仕様　※●は標準仕様です。'), h('div', { class: 'spec-cols' }, h('div', null, h('div', { class: 'spec-h' }, '構造関連'), specCols[0]), h('div', null, h('div', { class: 'spec-h' }, '性能・設備・アフター関連'), specCols[1]), h('div', null, h('div', { class: 'spec-h' }, 'デザイン関連'), specCols[2]))),
      h(
        'div',
        { class: 'fp-loans' },
        h('div', { class: 'fp-notes-title' }, '【予算計画】※借入の目安として活用ください。'),
        h(
          'table',
          { class: 'fp-loan' },
          h('thead', null, h('tr', null, h('th', null, ''), h('th', null, '借入金額'), h('th', null, '期間'), h('th', null, '金利'), h('th', null, '返済額（月々）'))),
          h('tbody', null, ...f.loans.map((l, i) => h('tr', null, h('td', { class: 'lbl' }, l.label), h('td', null, `${l.amountMan.toLocaleString('ja-JP')} 万円`), h('td', null, `${l.years} 年`), h('td', null, `${l.rate.toFixed(3)}%`), h('td', { class: 'amt' }, `¥${yen(t.loans[i].monthly)}`)))),
        ),
        h('div', { class: 'fp-sign' }, h('span', null, `見積作成日：${f.dateLabel} ${f.version}`), h('span', null, '担当　　印'), h('span', null, '上長　　印'), h('span', null, '代表　　印')),
      ),
    ),
  );
}

function csvOf(c: Computed): string {
  const lines = ['工事,仕様,内容,数量,単位,単価,金額,原価単価'];
  for (const cat of c.est.categories) for (const l of cat.lines) if (l.amount !== 0) lines.push([cat.def.name, l.spec, l.desc, l.qty, l.unit, l.unitPrice, l.amount, l.unitCost].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  lines.push(`"小計",,,,,,${c.est.subtotal}`, `"消費税",,,,,,${c.est.tax}`, `"合計",,,,,,${c.est.total}`);
  return '﻿' + lines.join('\n');
}

export const estimateStep: Step = {
  id: 'estimate',
  label: '見積・資金計画',
  short: '見積',
  needsModel: true,
  uses3d: false,
  mount(ctx: StepCtx) {
    const es = ensure();
    const view = h('div', { class: 'est-view' });
    ctx.stage.appendChild(view);
    let which: 'quote' | 'detail' | 'funding' = 'quote';
    const panel = h('div', null);
    const render = () => {
      const c = compute(es);
      clear(view);
      if (which === 'quote') view.appendChild(quoteSheet(c));
      else if (which === 'detail') for (const s of detailSheets(c, es, render)) view.appendChild(s);
      else view.appendChild(fundingSheet(c));
      renderPanel(c);
      emit('estimate');
    };
    const renderPanel = (c: Computed) => {
      clear(panel);
      const { areas, base, est, funding } = c;
      // 面積・数量
      const areaBody = h('div', { class: 'area-grid' });
      let lastGroup = '';
      for (const fdef of AREA_FIELDS) {
        if (fdef.group !== lastGroup) {
          lastGroup = fdef.group;
          areaBody.appendChild(h('div', { class: 'area-group' }, fdef.group));
        }
        const v = areas[fdef.key] as number;
        const auto = base[fdef.key] as number;
        const changed = es.areasOverride[fdef.key] != null && Math.abs(v - auto) > 1e-9;
        const input = h('input', {
          type: 'number',
          step: 'any',
          value: num(v, 2),
          class: changed ? 'changed' : '',
          onchange: (e: Event) => {
            const nv = Number((e.target as HTMLInputElement).value);
            if (Math.abs(nv - auto) < 1e-9) delete (es.areasOverride as Record<string, unknown>)[fdef.key];
            else (es.areasOverride as Record<string, unknown>)[fdef.key] = nv;
            render();
          },
        });
        areaBody.appendChild(h('label', { class: 'area-row', title: changed ? `図面からの値: ${num(auto)}` : '' }, h('span', { class: 'lbl' }, fdef.label), input, h('span', { class: 'unit' }, fdef.unit), changed ? h('button', { class: 'linkbtn', title: '図面からの値に戻す', onclick: () => { delete (es.areasOverride as Record<string, unknown>)[fdef.key]; render(); } }, '↺') : h('span', null)));
      }
      const optBody = h('div', { class: 'opt-grid' }, ...AREA_OPTIONS.map((o) => h('label', { class: 'opt' }, h('input', { type: 'checkbox', checked: !!areas[o.key], onchange: (e: Event) => { (es.areasOverride as Record<string, unknown>)[o.key] = (e.target as HTMLInputElement).checked; render(); } }), o.label)));
      // 仕様の選択（group）
      const groupBody = h('div', { class: 'group-list' });
      const seen = new Set<string>();
      for (const cat of CATEGORIES)
        for (const l of cat.lines) {
          if (!l.group || seen.has(l.group)) continue;
          seen.add(l.group);
          const options = CATEGORIES.flatMap((cc) => cc.lines).filter((x) => x.group === l.group);
          const cur = es.choice.groups[l.group] ?? defaultGroups(es.choice.grade)[l.group];
          const driven = finishDrivenGroups().has(l.group);
          const sel = h('select', { disabled: driven, onchange: (e: Event) => { es.choice.groups[l.group!] = (e.target as HTMLSelectElement).value; render(); } }, ...options.map((o) => h('option', { value: o.id, selected: o.id === cur }, `${o.desc}　¥${yen(unitPriceOf(o))}/${o.unit}`)));
          groupBody.appendChild(field(GROUP_LABEL[l.group] ?? l.group, sel, driven ? 'パースの「コーディネート」で選んだ商品' : undefined));
        }
      // 資金計画
      const fundBody = h('div', { class: 'fund-form' });
      const rowsEditor = (title: string, rows: FundRow[]) => {
        const box = h('div', { class: 'fund-rows' }, h('div', { class: 'area-group' }, title));
        for (const r of rows) {
          const lbl = h('input', { type: 'text', class: 'lbl', value: r.label, placeholder: '項目', onchange: (e: Event) => { r.label = (e.target as HTMLInputElement).value; render(); } });
          const amt = h('input', { type: 'number', step: 1000, value: r.amount || '', placeholder: r.star ? '★' : '0', onchange: (e: Event) => { r.amount = Number((e.target as HTMLInputElement).value) || 0; render(); } });
          box.appendChild(h('div', { class: 'fund-row' }, lbl, amt, h('span', { class: 'unit' }, '円')));
        }
        return box;
      };
      fundBody.append(
        field('建築場所', h('input', { type: 'text', value: funding.address, onchange: (e: Event) => { funding.address = (e.target as HTMLInputElement).value; render(); } })),
        h('div', { class: 'row2' }, field('見積作成日', h('input', { type: 'text', value: funding.dateLabel, onchange: (e: Event) => { funding.dateLabel = (e.target as HTMLInputElement).value; render(); } })), field('版', h('input', { type: 'text', value: funding.version, onchange: (e: Event) => { funding.version = (e.target as HTMLInputElement).value; render(); } }))),
        field('①本体工事（税抜）', h('input', { type: 'number', value: funding.bodyOverride ?? funding.body, onchange: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); funding.bodyOverride = Math.abs(v - funding.body) < 1 ? undefined : v; render(); } }), funding.bodyOverride != null ? `見積の小計 ¥${yen(funding.body)} を上書き中` : '見積の小計から自動'),
        rowsEditor('②付帯工事費用', funding.attached),
        rowsEditor('③追加変更工事', funding.changes),
        rowsEditor('④土地費用', funding.land),
        rowsEditor('⑤その他工事費', funding.other),
        rowsEditor('⑥ローン諸経費', funding.loanFees),
        h('div', { class: 'area-group' }, '借入の目安'),
        ...funding.loans.map((l) => h('div', { class: 'loan-row' }, h('span', { class: 'lbl' }, l.label), h('input', { type: 'number', value: l.amountMan || '', placeholder: '万円', onchange: (e: Event) => { l.amountMan = Number((e.target as HTMLInputElement).value) || 0; render(); } }), h('input', { type: 'number', value: l.years, onchange: (e: Event) => { l.years = Number((e.target as HTMLInputElement).value) || 35; render(); } }), h('input', { type: 'number', step: 0.001, value: l.rate, onchange: (e: Event) => { l.rate = Number((e.target as HTMLInputElement).value) || 0; render(); } }))),
        h('div', { class: 'row2' }, field('排水', h('select', { onchange: (e: Event) => { funding.site.sewer = (e.target as HTMLSelectElement).value; render(); } }, ...['下水', '浄化槽', '汲み取り'].map((v) => h('option', { value: v, selected: v === funding.site.sewer }, v)))), field('準防火地域', h('select', { onchange: (e: Event) => { funding.site.fireZone = (e.target as HTMLSelectElement).value === '1'; render(); } }, h('option', { value: '0', selected: !funding.site.fireZone }, '非該当'), h('option', { value: '1', selected: funding.site.fireZone }, '該当')))),
      );
      panel.append(
        h('h2', null, '見積・資金計画'),
        section('シリーズ', segmented([{ value: 'P', label: 'Pシリーズ' }, { value: 'S', label: 'Sシリーズ' }], es.choice.grade, (g) => { es.choice = newChoice(g); render(); })),
        section('表示', segmented([{ value: 'quote', label: '御見積書' }, { value: 'detail', label: '内訳書' }, { value: 'funding', label: '資金計画書' }], which, (w) => { which = w; render(); })),
        h('div', { class: 'est-total-card' }, h('div', { class: 'k' }, '見積合計（税込）'), h('div', { class: 'v' }, `¥${yen(est.total)}`), h('div', { class: 's' }, `税抜 ¥${yen(est.subtotal)}　坪単価 ¥${yen(Math.round(est.perTsubo))}　粗利 ${est.subtotal ? Math.round((1 - est.cost / est.subtotal) * 100) : 0}%`)),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: () => window.print() }, '印刷・PDF'), h('button', { class: 'btn', onclick: () => download('data:text/csv;charset=utf-8,' + encodeURIComponent(csvOf(c)), `${state.name}_見積.csv`) }, 'CSV'), h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!es.showAll, onchange: (e: Event) => { es.showAll = (e.target as HTMLInputElement).checked; if (es.showAll) which = 'detail'; render(); } }), '内訳を編集（全行表示）')),
        fold('面積・数量（図面から自動）', { open: false, meta: `延床 ${num(areas.totalTsubo)} 坪 ／ 施工 ${num(areas.constTsubo)} 坪` }, areaBody, h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => { es.areasOverride = {}; render(); } }, 'すべて図面の値に戻す'))),
        fold('仕様の選択', { open: true, meta: `${Object.keys(GROUP_LABEL).length} 項目` }, groupBody),
        fold('任意の項目', { open: false }, optBody),
        fold('資金計画書の入力', { open: which === 'funding', meta: `総合計 ¥${yen(computeFunding(funding).grand)}` }, fundBody),
      );
    };
    ctx.side.appendChild(panel);
    try {
      render();
    } catch (e) {
      console.error(e);
      toast('見積の計算に失敗しました', 'error');
    }
  },
};
