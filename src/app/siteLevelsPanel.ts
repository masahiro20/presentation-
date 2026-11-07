/**
 * 敷地の高低差の入力（図面読込の「接道・敷地」と日照の側パネルで共通）。
 * 設計 GL を 0 として、前面道路の路面と辺ごとの隣地の地盤を mm で持つ（＋ は敷地より高い、− は低い）
 */
import { h, clear, segmented, toast } from './dom';
import { APPROACH_LABEL, RETAINING_LABEL, type ApproachKind, type BuildingModel, type PlanSide, type RetainingKind, type SiteLevels } from '../core/types';
import { PLAN_SIDES, hasLevels, levelsSummary, planSideCompass, roadSideOf, stepCount } from '../core/siteLevels';

export interface SiteLevelsPanelOptions {
  /** 変えたとき（呼び出し側で emit('model') と 3D の作り直し） */
  onChange: () => void;
  /** 国土地理院の標高から推定する（建設地が決まっている画面で渡す）。成功したら true */
  estimate?: () => Promise<boolean>;
  /** 推定ボタンが無いときの案内 */
  estimateHint?: string;
}

const COMMON_MM = [0, -300, -500, -800, -1000, -1200, -1500, -2000, -3000, 300, 500, 800, 1000, 1500, 2000];
const cmLabel = (mm: number, lower: string, higher: string) => (mm === 0 ? '敷地と同じ高さ' : `${Math.round(Math.abs(mm) / 10)} cm ${mm < 0 ? lower : higher}`);

/** 高さの入力: よくある値のセレクト＋「その他」で mm 入力 */
function levelInput(valueMm: number, words: [string, string], onChange: (mm: number) => void): HTMLElement {
  const isCommon = COMMON_MM.includes(valueMm);
  const num = h('input', { type: 'number', step: 50, min: -5000, max: 5000, value: valueMm, style: 'width:84px', hidden: isCommon, onchange: (e: Event) => { const v = Math.round(+(e.target as HTMLInputElement).value / 10) * 10; if (Number.isFinite(v)) onChange(v); } }) as HTMLInputElement;
  const sel = h(
    'select',
    {
      style: 'max-width:170px',
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        if (v === 'custom') {
          num.hidden = false;
          num.focus();
          return;
        }
        onChange(+v);
      },
    },
    ...COMMON_MM.map((mm) => h('option', { value: String(mm), selected: isCommon && mm === valueMm }, cmLabel(mm, words[0], words[1]))),
    h('option', { value: 'custom', selected: !isCommon }, isCommon ? 'その他（mm で入力）' : `その他（${valueMm} mm）`),
  );
  return h('span', { style: 'display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap' }, sel, num, num.hidden ? null : h('span', { class: 'hint', style: 'margin:0' }, 'mm'));
}

export function siteLevelsPanel(model: BuildingModel, opts: SiteLevelsPanelOptions): HTMLElement {
  const box = h('div', { class: 'site-levels' });
  /** heights = 高さを手で直した（標高からの推定の出典は外す）。処理の選択だけなら出典は残す */
  const edit = (fn: (lv: SiteLevels) => void, heights = false) => {
    const lv = (model.siteLevels ??= {});
    fn(lv);
    if (heights) {
      lv.source = 'manual';
      delete lv.note;
    } else if (!lv.source) lv.source = 'manual';
    // 全部 0 で処理の選択も既定なら、設定なしに戻す
    const allZero = !hasLevels(lv) && !lv.retaining && !lv.approach && !lv.parkingAtRoad;
    if (allZero) delete model.siteLevels;
    opts.onChange();
    render();
  };
  const render = () => {
    clear(box);
    const lv = model.siteLevels ?? {};
    const north = model.northAngleDeg;
    const roadSide = roadSideOf(model);
    const road = lv.roadMm ?? 0;
    const st = stepCount(road);
    const parts: (HTMLElement | null)[] = [];
    parts.push(
      h('div', { class: 'field-label', style: 'margin-top:10px' }, '高低差（設計 GL を 0 として、まわりの地面が高ければ ＋、低ければ −）'),
      h(
        'div',
        { style: 'display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;font-size:13px' },
        h('span', null, `前面道路の路面${roadSide ? `（${planSideCompass(roadSide, north)}側）` : ''}`),
        levelInput(road, ['低い（敷地が高い）', '高い（敷地が低い）'], (mm) => edit((x) => { if (mm) x.roadMm = mm; else delete x.roadMm; }, true)),
        ...PLAN_SIDES.filter((s) => s !== roadSide).flatMap((s) => [
          h('span', null, `${planSideCompass(s, north)}の隣地`),
          levelInput(lv.neighborMm?.[s] ?? 0, ['低い', '高い'], (mm) =>
            edit((x) => {
              const nb = { ...(x.neighborMm ?? {}) } as Partial<Record<PlanSide, number>>;
              if (mm) nb[s] = mm;
              else delete nb[s];
              if (Object.keys(nb).length) x.neighborMm = nb;
              else delete x.neighborMm;
            }, true),
          ),
        ]),
      ),
    );
    if (hasLevels(lv)) {
      parts.push(
        h('div', { class: 'field-label', style: 'margin-top:8px' }, '段差の処理（擁壁）'),
        segmented(
          (Object.keys(RETAINING_LABEL) as RetainingKind[]).map((k) => ({ value: k, label: RETAINING_LABEL[k] })),
          lv.retaining ?? 'rc',
          (v) => edit((x) => { if (v === 'rc') delete x.retaining; else x.retaining = v; }),
        ),
      );
      if (Math.abs(road) >= 50)
        parts.push(
          h('div', { class: 'field-label', style: 'margin-top:8px' }, '玄関アプローチ'),
          segmented(
            (Object.keys(APPROACH_LABEL) as ApproachKind[]).map((k) => ({ value: k, label: k === 'steps' && st.n ? `${APPROACH_LABEL[k]}（${st.n} 段・蹴上 ${st.riserMm}）` : APPROACH_LABEL[k] })),
            lv.approach ?? 'steps',
            (v) => edit((x) => { if (v === 'steps') delete x.approach; else x.approach = v; }),
          ),
          road < 0
            ? h(
                'label',
                { class: 'check', title: '駐車スペースだけ道路の高さに下げ、3 方を擁壁で留めます（車は道路からそのまま入れる）。玄関へは階段で上がります' },
                h('input', { type: 'checkbox', checked: !!lv.parkingAtRoad, onchange: (e: Event) => edit((x) => { if ((e.target as HTMLInputElement).checked) x.parkingAtRoad = true; else delete x.parkingAtRoad; }) }),
                ' 駐車場を道路の高さに下げる',
              )
            : null,
        );
      const lines = levelsSummary(lv, north);
      parts.push(h('div', { class: 'hint', style: 'margin:6px 0 0;line-height:1.7' }, ...lines.flatMap((l, i) => (i ? [h('br'), l] : [l]))));
      if (lv.note) parts.push(h('div', { class: 'hint', style: 'margin:2px 0 0' }, lv.source === 'dem' ? `出典: ${lv.note}` : lv.note));
    }
    const btns: HTMLElement[] = [];
    if (opts.estimate)
      btns.push(
        h(
          'button',
          {
            class: 'btn sm',
            title: '国土地理院の標高タイル（1〜5 m メッシュ）から、建物の足元・前面道路・隣地の標高を拾って高低差を推定します（誤差 15〜25 cm 程度。現地の実測を優先してください）',
            onclick: async (e: Event) => {
              const btn = e.currentTarget as HTMLButtonElement;
              btn.disabled = true;
              const label = btn.textContent;
              btn.textContent = '標高を取得しています…';
              try {
                const ok = await opts.estimate!();
                if (ok) render();
              } catch (err) {
                toast(`標高から推定できませんでした: ${(err as Error).message}`, 'error', 6000);
              } finally {
                btn.disabled = false;
                btn.textContent = label;
              }
            },
          },
          '標高データから推定（国土地理院）',
        ),
      );
    if (hasLevels(lv) || model.siteLevels) btns.push(h('button', { class: 'btn sm ghost', onclick: () => { delete model.siteLevels; opts.onChange(); render(); toast('高低差なし（平ら）に戻しました', 'ok'); } }, '高低差なしに戻す'));
    if (btns.length) parts.push(h('div', { class: 'btn-row', style: 'margin-top:8px' }, ...btns));
    if (!opts.estimate && opts.estimateHint) parts.push(h('p', { class: 'hint', style: 'margin:4px 0 0' }, opts.estimateHint));
    parts.push(h('p', { class: 'hint', style: 'margin:4px 0 0' }, 'パースでは道路・縁石・隣家をこの高さに置き、境界に擁壁、玄関に階段（スロープ）が付きます。日照では周辺建物の足元をこの高さにします（高い隣地の家は影が長く伸びます）。敷地の中の傾斜は設計 GL でならした前提です。'));
    box.append(...parts.filter((x): x is HTMLElement => !!x));
  };
  render();
  return box;
}
