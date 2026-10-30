/**
 * 敷地から先に検討（プランが無い段階）のダイアログ。
 * 読込画面の「はじめる」の下のリンク 1 つで開き、敷地の数字を入れると右に絵と判定が出る。
 * 「この条件を控える」で保存ファイルに残し、図面を読んだら「敷地の検討との照合」で比べる。
 */
import { h, clear, modal, segmented, toast } from './dom';
import { state } from './state';
import { siteStudy, siteStudySvg, wantFromWishes, ZONE_PRESETS, tsubo, floorsLabel, type SiteStudyInput, type SiteStudyResult, type RoadSide } from '../core/siteStudy';
import { parseWishes } from '../core/wishes';
import { openPrintable, esc } from './docs';
import { polygonArea } from '../core/geometry';
import { planSummary } from '../core/planDiff';
import type { BuildingModel } from '../core/types';

const LS_PRICE = 'madori.tsuboPriceMan';
const STATUS_ICON = { ok: '✓', check: '⚠', ng: '✖', info: '・' } as const;
const STATUS_CLS = { ok: 'ok', check: 'info', ng: 'ng', info: 'na' } as const;

function defaults(): SiteStudyInput {
  let price: number | undefined;
  try {
    const v = localStorage.getItem(LS_PRICE);
    if (v) price = +v;
  } catch {
    /* 使えない環境 */
  }
  return state.siteStudy ? { ...state.siteStudy } : { frontage: 12, depth: 15, bcr: 60, far: 200, road: 'S', wantTsubo: 35, floors: 2, cars: 2, tsuboPriceMan: price, setback: 0.5 };
}

export function rowsEl(rows: SiteStudyResult['rows']): HTMLElement {
  const box = h('div', { class: 'check-rows study' });
  for (const r of rows) box.appendChild(h('div', { class: `check-row long ${STATUS_CLS[r.status]}` }, h('span', { class: 'ic' }, STATUS_ICON[r.status]), h('span', { class: 'lb' }, r.label), h('span', { class: 'dt' }, r.text)));
  return box;
}

/** ダイアログを開く。onSave は「この条件を控える」のあと（読込画面の照合を描き直すなど） */
export function openSiteStudy(onSave?: () => void) {
  const inp = defaults();
  const svgBox = h('div', { class: 'study-svg' });
  const verdict = h('div', { class: 'study-verdict' });
  const rows = h('div');
  let last: SiteStudyResult | null = null;
  const num = (key: keyof SiteStudyInput, step = 0.1, min = 0) =>
    h('input', {
      type: 'number',
      step,
      min,
      value: (inp[key] as number | undefined) ?? '',
      oninput: (e: Event) => {
        const v = (e.target as HTMLInputElement).value;
        (inp as unknown as Record<string, unknown>)[key] = v === '' ? undefined : +v;
        run();
      },
    });
  const fld = (label: string, el: Node, hint?: string) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), el, hint ? h('span', { class: 'hint' }, hint) : null);
  const bcrIn = num('bcr', 10, 10) as HTMLInputElement;
  const farIn = num('far', 10, 10) as HTMLInputElement;
  const zone = h(
    'select',
    {
      onchange: (e: Event) => {
        const z = ZONE_PRESETS.find((p) => p.id === (e.target as HTMLSelectElement).value);
        if (!z) return;
        inp.bcr = z.bcr;
        inp.far = z.far;
        inp.zone = z.label;
        bcrIn.value = String(z.bcr);
        farIn.value = String(z.far);
        run();
      },
    },
    h('option', { value: '' }, '用途地域から入れる…'),
    ...ZONE_PRESETS.map((p) => h('option', { value: p.id }, p.label)),
  );
  const wantIn = num('wantTsubo', 0.5, 5) as HTMLInputElement;
  const carsIn = num('cars', 1, 0) as HTMLInputElement;
  const floorsSeg = segmented(
    [
      { value: '1', label: '平屋' },
      { value: '2', label: '2 階建て' },
      { value: '3', label: '3 階建て' },
    ],
    String(inp.floors),
    (v) => {
      inp.floors = +v as 1 | 2 | 3;
      run();
    },
  );
  const fromWishes = state.wishes?.trim()
    ? h(
        'button',
        {
          class: 'btn xs ghost',
          onclick: () => {
            const w = wantFromWishes(parseWishes(state.wishes ?? ''));
            if (!w) return toast('ご要望の文章から部屋が読めませんでした', 'info');
            inp.wantTsubo = w.tsubo;
            wantIn.value = String(w.tsubo);
            if (w.cars != null) {
              inp.cars = w.cars;
              carsIn.value = String(w.cars);
            }
            toast(`ご要望から: 約 ${w.tsubo} 坪（${w.breakdown}）`, 'ok', 7000);
            run();
          },
        },
        'ご要望の文章から',
      )
    : null;
  const run = () => {
    if (!(inp.frontage > 0 && inp.depth > 0 && inp.bcr > 0 && inp.far > 0 && inp.wantTsubo > 0)) {
      verdict.textContent = '間口・奥行・建蔽率・容積率・希望の坪数を入れてください';
      verdict.className = 'study-verdict';
      clear(svgBox);
      clear(rows);
      last = null;
      return;
    }
    last = siteStudy(inp);
    verdict.textContent = last.verdictText;
    verdict.className = `study-verdict ${last.verdict}`;
    svgBox.innerHTML = siteStudySvg(inp, last, 300);
    clear(rows);
    rows.appendChild(rowsEl(last.rows));
  };
  const left = h(
    'div',
    { class: 'study-form' },
    h('div', { class: 'grid2' }, fld('間口（道路側）m', num('frontage')), fld('奥行 m', num('depth'))),
    h('div', { class: 'grid2' }, fld('敷地面積 ㎡（登記。空なら間口×奥行）', num('areaM2', 0.01)), fld('道路の向き', h('select', { onchange: (e: Event) => { inp.road = (e.target as HTMLSelectElement).value as RoadSide; run(); } }, ...(['S', 'E', 'W', 'N'] as RoadSide[]).map((d) => h('option', { value: d, selected: inp.road === d }, { S: '南側道路', E: '東側道路', W: '西側道路', N: '北側道路' }[d]))))),
    fld('用途地域（目安の建蔽率／容積率）', zone, '自治体の指定で変わります。確定は役所で'),
    h('div', { class: 'grid2' }, fld('建蔽率 %', bcrIn), fld('容積率 %', farIn)),
    h('div', { class: 'grid2' }, fld('希望の延床（坪）', h('div', { class: 'row-inline' }, wantIn, fromWishes)), fld('駐車 台', carsIn)),
    fld('階数', floorsSeg),
    h('div', { class: 'grid2' }, fld('坪単価（万円・税込の目安）', num('tsuboPriceMan', 1, 0), 'このブラウザに覚えます'), fld('隣地境界からの離れ m', num('setback', 0.1, 0))),
  );
  const printBtn = h('button', { class: 'btn xs ghost', onclick: () => { if (last) openPrintable(`敷地の検討 ${state.name || ''}`, studyPrintable(inp, last)); } }, 'お客様用に 1 枚で開く');
  const right = h('div', { class: 'study-out' }, verdict, svgBox, rows, h('div', { class: 'btn-row', style: 'margin-top:8px' }, printBtn), h('p', { class: 'hint' }, '斜線制限・防火地域・地区計画・セットバックは見ていません。土地の購入前は役所と設計士の確認を。'));
  run();
  const body = h('div', { class: 'study-dialog' }, left, right);
  modal(
    '敷地から先に検討（図面を描く前に）',
    body,
    [
      {
        label: 'この条件を控える',
        primary: true,
        onClick: () => {
          state.siteStudy = { ...inp };
          try {
            if (inp.tsuboPriceMan) localStorage.setItem(LS_PRICE, String(inp.tsuboPriceMan));
          } catch {
            /* 使えない環境 */
          }
          toast('控えました。図面を読み込むと「敷地の検討との照合」に出ます（保存ファイルにも残ります）', 'ok', 6000);
          onSave?.();
        },
      },
      { label: '閉じる' },
    ],
    true,
  );
}

/** お客様に渡す 1 枚（印刷用） */
function studyPrintable(i: SiteStudyInput, r: SiteStudyResult): string {
  const d = new Date();
  const rows = r.rows.map((x) => `<tr><td class="m ${x.status === 'info' ? 'na' : x.status}">${STATUS_ICON[x.status]}</td><th>${esc(x.label)}</th><td>${esc(x.text)}</td></tr>`).join('');
  const who = state.customer ? (/様$/.test(state.customer.trim()) ? state.customer.trim() : `${state.customer.trim()} 様`) : '';
  return `<h1>敷地の検討 ${esc(who)}</h1>
<p class="sub">${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日　${esc(state.company || '')}　図面を描く前の、敷地と希望の広さの見当です</p>
<div class="cols"><div>
<h2>条件</h2>
<table><tr><th>敷地</th><td>間口 ${i.frontage} m × 奥行 ${i.depth} m（${Math.round(r.siteM2 * 10) / 10} ㎡・${Math.round(tsubo(r.siteM2) * 10) / 10} 坪）</td></tr>
<tr><th>道路</th><td>${{ N: '北', E: '東', S: '南', W: '西' }[i.road]}側</td></tr>
<tr><th>建蔽率／容積率</th><td>${i.bcr}% ／ ${i.far}%${i.zone ? `（${esc(i.zone)}）` : ''}</td></tr>
<tr><th>ご希望</th><td>${floorsLabel(i.floors)}・延床 ${i.wantTsubo} 坪・駐車 ${i.cars} 台</td></tr></table>
<h2>結論</h2><p class="${r.verdict}"><b>${esc(r.verdictText)}</b></p>
<table>${rows}</table>
</div><div style="text-align:center">${siteStudySvg(i, r, 300)}</div></div>
<p class="small">建蔽率・容積率は入力値で計算しています。斜線制限・防火地域・地区計画・セットバック・前面道路の幅員は含みません。土地の購入前に、役所と設計士が確認します。</p>`;
}

/** 図面を読んだあと: 控えた条件と、読み取った間取りを比べる */
export function siteStudyCheck(model: BuildingModel): { rows: SiteStudyResult['rows']; verdict: 'ok' | 'check' | 'ng' } | null {
  const s = state.siteStudy;
  if (!s) return null;
  const r = siteStudy(s);
  const sum = planSummary(model, '');
  const f1 = model.floors.find((f) => f.level === 1) ?? model.floors[0];
  const footprint = f1 ? f1.outline.reduce((a, poly) => a + Math.abs(polygonArea(poly)), 0) * 1e-6 : 0;
  const rows: SiteStudyResult['rows'] = [];
  const r1 = (v: number) => Math.round(v * 10) / 10;
  rows.push({
    status: sum.totalArea <= r.maxFloorM2 + 0.01 ? 'ok' : 'ng',
    label: '容積率',
    text: `延床 ${r1(sum.totalArea)} ㎡（${r1(tsubo(sum.totalArea))} 坪）。上限 ${r1(r.maxFloorM2)} ㎡（${s.far}%）`,
  });
  if (footprint > 0)
    rows.push({
      status: footprint <= r.maxFootprintM2 + 0.01 ? 'ok' : 'ng',
      label: '建蔽率',
      text: `建築面積 約 ${r1(footprint)} ㎡（1 階の外形）。上限 ${r1(r.maxFootprintM2)} ㎡（${s.bcr}%）`,
    });
  const dT = tsubo(sum.totalArea) - s.wantTsubo;
  rows.push({
    status: Math.abs(dT) <= 2 ? 'ok' : 'check',
    label: 'ご希望',
    text: `ご希望 ${s.wantTsubo} 坪に対し ${r1(tsubo(sum.totalArea))} 坪（${dT >= 0 ? '＋' : '－'}${r1(Math.abs(dT))} 坪）。階数 ${model.floors.filter((f) => f.level >= 1).length}（ご希望 ${s.floors}）`,
  });
  if (s.tsuboPriceMan) rows.push({ status: 'info', label: '概算', text: `${r1(tsubo(sum.totalArea))} 坪 × ${s.tsuboPriceMan} 万円 ≒ 建物 ${Math.round(tsubo(sum.totalArea) * s.tsuboPriceMan).toLocaleString('ja-JP')} 万円（控えた坪単価で）。見積の画面で仕様を選ぶと正式な概算になります` });
  const verdict = rows.some((x) => x.status === 'ng') ? 'ng' : rows.some((x) => x.status === 'check') ? 'check' : 'ok';
  return { rows, verdict };
}
